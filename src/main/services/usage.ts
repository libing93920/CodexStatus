import { promises as fs } from 'node:fs'
import { collectJsonlFiles, resolveSessionPaths } from './quota.ts'
import type { JsonlFileEntry } from './quota.ts'
import type {
  AgentId,
  ModelUsage,
  TokenUsageDay,
  TokenUsageOverview,
  UsageWindow
} from '../../shared/capsule'
import { AGENT_PROVIDERS, listClaudeFiles, parseClaudeFile, type UsageEvent } from './agents.ts'
import { computeCost, normalizeModel } from './rate.ts'
import {
  dedupParsedFiles,
  parseSessionFileIncremental,
  type ParsedFile,
  type SessionParserState,
  type TokenDelta
} from './codex-session-parser.ts'

export { buildCodexDelta, dedupParsedFiles } from './codex-session-parser.ts'
export type { ParsedFile } from './codex-session-parser.ts'

// 展示窗口最大天数;buildSeries 按此取日期序列,事件层过滤由日期序列完成(对齐 cc-switch 查询层过滤)
const CACHE_TTL_MS = 60_000
// 增量缓存兜底:距上次全量重扫超过该时长强制全量对账,消除 mtime 不可靠导致的累计偏差
const FULL_RESCAN_INTERVAL_MS = 24 * 60 * 60 * 1000

/** 单个本地自然日的累计 */
type Accum = TokenDelta & { cost: number }

type DayMap = Map<string, Accum>

/** 单个文件的上次解析产物:codex 存 ParsedFile(父子去重要用),claude 存独立事件 */
type FileState =
  | {
      kind: 'codex'
      mtimeMs: number
      size: number
      parser: SessionParserState
    }
  | { kind: 'claude'; mtimeMs: number; events: UsageEvent[] }

interface CacheEntry {
  agentId: AgentId
  fetchedAtMs: number
  days: DayMap
  events: UsageEvent[]
  /** 文件级增量状态:path → 该文件上次解析产物 */
  files: Map<string, FileState>
  /** 最近一次全量重扫时间戳;距上次超过 FULL_RESCAN_INTERVAL_MS 强制全量对账 */
  fullScannedAtMs: number
}

/** 一次扫描的产物:按天聚合 + 事件级明细 */
interface ScannedData {
  days: DayMap
  events: UsageEvent[]
}

/** 一次扫描的完整产物:在 ScannedData 基础上附带文件级增量状态 */
interface IncrementalScanResult extends ScannedData {
  files: Map<string, FileState>
}

// 每 agent 一份缓存:团队榜要扫三个工具求和,互不覆盖
const cacheByAgent = new Map<AgentId, CacheEntry>()
// 并发去重:同一 agent 的并发扫描复用同一 Promise,避免 3 窗口并行拉取时重复扫描
const inflightByAgent = new Map<AgentId, Promise<ScannedData>>()
// 最近一次算出的每窗口每工具 token 总数,供 LAN 广播(peer 排行榜分段)同步读取
let lastAgentTotals: Partial<Record<UsageWindow, Partial<Record<AgentId, number>>>> | undefined

/**
 * 获取 1/7/30 天 token 用量与估算花费。
 * 数据现算现得:扫描近 30 天 sessions JSONL,按"相邻事件 total 差值"归因到本地自然日。
 */
export async function getTokenUsage(
  agentId: AgentId,
  window: UsageWindow
): Promise<TokenUsageOverview> {
  const { days, events } = await loadScanned(agentId)
  const series = buildSeries(days, window)
  const totals = computeTotals(series)
  return {
    available: totals.total > 0,
    generatedAt: new Date().toISOString(),
    days: series,
    totals,
    models: aggregateModels(events, windowStartMs(window), Date.now())
  }
}

/**
 * 自定义起止时间(毫秒)区间内的 token 用量与估算花费。
 * 在去重后的事件级明细上按 [startMs, endMs) 切片累加,边界精确到毫秒;
 * 区间超出扫描窗口(30 天)的部分自然取不到数据。
 */
export async function getTokenUsageRange(
  agentId: AgentId,
  startMs: number,
  endMs: number
): Promise<TokenUsageOverview> {
  const { events } = await loadScanned(agentId)
  const acc: Accum = { input: 0, cachedInput: 0, output: 0, reasoning: 0, total: 0, cost: 0 }
  for (const event of events) {
    if (event.ts >= startMs && event.ts < endMs) {
      acc.input += event.tokens.input
      acc.cachedInput += event.tokens.cachedInput
      acc.output += event.tokens.output
      acc.reasoning += event.tokens.reasoning
      acc.total += event.tokens.input + event.tokens.output
      acc.cost += event.costUsd ?? computeCost(event.tokens, event.model)
    }
  }
  acc.cost = Math.round(acc.cost * 10000) / 10000
  const day: TokenUsageDay = {
    date: toLocalDayKey(new Date(startMs)),
    input: acc.input,
    cachedInput: acc.cachedInput,
    output: acc.output,
    reasoning: acc.reasoning,
    cost: acc.cost
  }
  return {
    available: acc.total > 0,
    generatedAt: new Date().toISOString(),
    days: [day],
    totals: {
      input: acc.input,
      cachedInput: acc.cachedInput,
      output: acc.output,
      reasoning: acc.reasoning,
      total: acc.total,
      cost: acc.cost
    },
    models: aggregateModels(events, startMs, endMs)
  }
}

/** 同步返回每窗口每工具 token 总数(团队榜分段用);从未算过则 undefined */
export function getCachedAgentTokenTotals():
  | Partial<Record<UsageWindow, Partial<Record<AgentId, number>>>>
  | undefined {
  return lastAgentTotals
}

/** 同步返回每窗口 token 总数(三工具和);从未算过则 undefined */
export function getCachedTokenTotals(): Partial<Record<UsageWindow, number>> | undefined {
  if (!lastAgentTotals) {
    return undefined
  }
  const totals: Partial<Record<UsageWindow, number>> = {}
  for (const [window, agents] of Object.entries(lastAgentTotals)) {
    totals[window as UsageWindow] =
      (agents.codex ?? 0) + (agents.claude ?? 0) + (agents.opencode ?? 0)
  }
  return totals
}

/** 切换 agentId 时清缓存:避免旧工具的日桶/事件/每窗口总数串味 */
export function invalidateUsageCache(): void {
  cacheByAgent.clear()
  lastAgentTotals = undefined
}

const ALL_AGENTS: readonly AgentId[] = ['codex', 'claude', 'opencode']
const ALL_WINDOWS: readonly UsageWindow[] = ['1d', '7d', '30d']

/** 预热三个工具的每窗口 token 总数并缓存,供团队榜总量排名与分段展示 */
export async function warmAllAgentTokenTotals(): Promise<
  Partial<Record<UsageWindow, Partial<Record<AgentId, number>>>>
> {
  const totals: Partial<Record<UsageWindow, Partial<Record<AgentId, number>>>> = {}
  for (const agentId of ALL_AGENTS) {
    const days = await loadDays(agentId)
    for (const window of ALL_WINDOWS) {
      const total = computeTotals(buildSeries(days, window)).total
      const byAgent = totals[window] ?? {}
      byAgent[agentId] = total
      totals[window] = byAgent
    }
  }
  lastAgentTotals = totals
  return totals
}

// 带指纹+TTL 的缓存:指纹不变(文件集合+mtime 没变)且未过期时直接复用已解析的日桶,
// 避免每 30s 快照刷新后 UI 拉取时重复读+解析全部文件;切换 agentId 会因指纹前缀不同而自动失效
async function loadScanned(agentId: AgentId): Promise<ScannedData> {
  const now = Date.now()
  const cached = cacheByAgent.get(agentId)
  if (cached && now - cached.fetchedAtMs < CACHE_TTL_MS) {
    return cached
  }
  const existing = inflightByAgent.get(agentId)
  if (existing) {
    return existing
  }
  const promise = (async () => {
    try {
      // 距上次全量重扫超时则强制全量,否则用上次文件状态做增量 diff
      const forceFull =
        cached !== undefined && now - cached.fullScannedAtMs >= FULL_RESCAN_INTERVAL_MS
      const prevFiles = forceFull ? undefined : cached?.files
      const scanned = await scanIncrementally(agentId, prevFiles)
      cacheByAgent.set(agentId, {
        agentId,
        fetchedAtMs: now,
        fullScannedAtMs: forceFull ? now : (cached?.fullScannedAtMs ?? now),
        days: scanned.days,
        events: scanned.events,
        files: scanned.files
      })
      return { days: scanned.days, events: scanned.events }
    } finally {
      inflightByAgent.delete(agentId)
    }
  })()
  inflightByAgent.set(agentId, promise)
  return promise
}

async function loadDays(agentId: AgentId): Promise<DayMap> {
  const data = await loadScanned(agentId)
  return data.days
}

// —— 用量扫描:按 agentId 分派 ——
// Codex 走增量文件扫描(见 incrementalScanCodex);Claude/OpenCode 走 provider 注册表。
// 统一产出 UsageEvent[] 后,由 aggregateDays 归桶 + 计费。
async function scanIncrementally(
  agentId: AgentId,
  prevFiles: Map<string, FileState> | undefined
): Promise<IncrementalScanResult> {
  if (agentId === 'codex') {
    return incrementalScanCodex(prevFiles)
  }
  if (agentId === 'claude') {
    return incrementalScanClaude(prevFiles)
  }
  // opencode:SQLite 无文件粒度增量,每次全量查询
  const provider = AGENT_PROVIDERS[agentId]
  const events = provider ? await provider.scanRecentEvents() : []
  return { days: aggregateDays(events), events, files: new Map() }
}

// Claude 增量扫描:按 mtime diff 只重扫变化/新增文件,未变化文件复用上次事件(无跨文件去重)
async function incrementalScanClaude(
  prevFiles: Map<string, FileState> | undefined
): Promise<IncrementalScanResult> {
  const entries = await listClaudeFiles()
  const files = new Map<string, FileState>()
  const events: UsageEvent[] = []
  for (const entry of entries) {
    const prev = prevFiles?.get(entry.filePath)
    if (prev?.kind === 'claude' && prev.mtimeMs === entry.mtimeMs) {
      files.set(entry.filePath, prev)
      events.push(...prev.events)
      continue
    }
    const fileEvents = await parseClaudeFile(entry.filePath)
    files.set(entry.filePath, { kind: 'claude', mtimeMs: entry.mtimeMs, events: fileEvents })
    events.push(...fileEvents)
  }
  // Claude 会跨文件重复同一 message.id(续会话/会话副本),按 id 全局只留 usage 更大的代表
  const deduped = dedupClaudeEvents(events)
  return { days: aggregateDays(deduped), events: deduped, files }
}

// Claude 全局去重:同一 message.id 保留 usage(输出)更大的代表,无 id 事件直接保留
export function dedupClaudeEvents(events: UsageEvent[]): UsageEvent[] {
  const best = new Map<string, UsageEvent>()
  const out: UsageEvent[] = []
  for (const event of events) {
    if (event.messageId !== undefined) {
      const prev = best.get(event.messageId)
      if (prev && prev.tokens.output >= event.tokens.output) {
        continue
      }
      best.set(event.messageId, event)
      continue
    }
    out.push(event)
  }
  return [...best.values()].concat(out)
}

// Codex 两遍扫描:
// 第一遍解析每个 session 文件(session_meta 父子关系 + turn_context 模型 + token_count 差值),
// 第二遍带 parent 的子会话与父会话做 token 签名匹配,跳过重放前缀,只累计各自的新工作。
// 背景:Codex 子代理线程会重放父会话的累计上下文,直接求和会把同一份 token 重复计入(实测最高 9.5 倍)。
// 增量:未变化文件复用解析状态,变化文件只从上次字节偏移读取追加内容;
// 截断/替换由 parser 回退全量解析;去重仍在完整集合上重跑。
async function incrementalScanCodex(
  prevFiles: Map<string, FileState> | undefined
): Promise<IncrementalScanResult> {
  const entries = await collectRecentFiles()
  const files = new Map<string, FileState>()
  const parsed: Array<{ threadId: string | undefined; file: ParsedFile }> = []
  for (const entry of entries) {
    const prev = prevFiles?.get(entry.filePath)
    const unchanged =
      prev?.kind === 'codex' &&
      prev.mtimeMs === entry.mtimeMs &&
      (entry.size === undefined || prev.size === entry.size)
    if (unchanged) {
      files.set(entry.filePath, prev)
      parsed.push({ threadId: threadIdFromFilename(entry.filePath), file: prev.parser.parsed })
      continue
    }
    const threadId = threadIdFromFilename(entry.filePath)
    const result = await parseSessionFileIncremental(
      entry.filePath,
      threadId,
      prev?.kind === 'codex' ? prev.parser : undefined
    )
    if (!result) {
      continue
    }
    files.set(entry.filePath, {
      kind: 'codex',
      mtimeMs: entry.mtimeMs,
      size: result.state.byteOffset,
      parser: result.state
    })
    parsed.push({ threadId, file: result.state.parsed })
  }
  const events = dedupParsedFiles(parsed)
  return { days: aggregateDays(events), events, files }
}

// 事件级明细 → 本地自然日桶;成本优先取 provider 直接给出的 costUsd(OpenCode),否则按价目估算
function aggregateDays(events: UsageEvent[]): DayMap {
  const days: DayMap = new Map()
  for (const event of events) {
    const dateKey = toLocalDayKey(new Date(event.ts))
    let acc = days.get(dateKey)
    if (!acc) {
      acc = { input: 0, cachedInput: 0, output: 0, reasoning: 0, total: 0, cost: 0 }
      days.set(dateKey, acc)
    }
    acc.input += event.tokens.input
    acc.cachedInput += event.tokens.cachedInput
    acc.output += event.tokens.output
    acc.reasoning += event.tokens.reasoning
    acc.total += event.tokens.total
    acc.cost += event.costUsd ?? computeCost(event.tokens, event.model)
  }
  return days
}

// 事件级明细 → 按模型聚合(归一化模型名分组),按 total 降序;供模型用量榜使用
function aggregateModels(events: UsageEvent[], startMs: number, endMs: number): ModelUsage[] {
  const byModel = new Map<string, Accum>()
  for (const event of events) {
    if (event.ts < startMs || event.ts >= endMs) {
      continue
    }
    const model = event.model ? normalizeModel(event.model) : 'unknown'
    let acc = byModel.get(model)
    if (!acc) {
      acc = { input: 0, cachedInput: 0, output: 0, reasoning: 0, total: 0, cost: 0 }
      byModel.set(model, acc)
    }
    acc.input += event.tokens.input
    acc.cachedInput += event.tokens.cachedInput
    acc.output += event.tokens.output
    acc.reasoning += event.tokens.reasoning
    acc.total += event.tokens.total
    acc.cost += event.costUsd ?? computeCost(event.tokens, event.model)
  }
  return [...byModel.entries()]
    .map(([model, acc]) => ({
      model,
      input: acc.input,
      cachedInput: acc.cachedInput,
      output: acc.output,
      reasoning: acc.reasoning,
      total: acc.total,
      cost: Math.round(acc.cost * 10000) / 10000
    }))
    .sort((left, right) => right.total - left.total)
}

// 窗口最早自然日的本地 00:00 时间戳(与 buildSeries 的日期范围对齐)
function windowStartMs(window: UsageWindow): number {
  const today = toLocalDayKey(new Date())
  const earliest = addDays(today, -(WINDOW_DAYS[window] - 1))
  const [year, month, day] = earliest.split('-').map(Number)
  return new Date(year, month - 1, day).getTime()
}

// 收集所有 Codex JSONL 文件(按路径排序,保证遍历顺序确定)
// 对齐 cc-switch collect_codex_session_files:不按 mtime 剪枝,扫全量建 rollout_index,
// 否则父文件 mtime>30天会漏扫,子会话误判孤儿跳过(实测少算 7 倍)。
// 事件计入的 30 天窗口由 buildSeries 按日期序列过滤,与 cc-switch 查询层过滤语义一致。
async function collectRecentFiles(): Promise<JsonlFileEntry[]> {
  const entries: JsonlFileEntry[] = []
  for (const root of resolveSessionPaths()) {
    if (!(await pathExists(root))) {
      continue
    }
    entries.push(...(await collectJsonlFiles(root, Number.MAX_SAFE_INTEGER)))
  }
  return entries.sort((left, right) => left.filePath.localeCompare(right.filePath))
}

// 从 rollout 文件名提取尾部 UUID(线程 id):rollout-<时间>-<uuid>.jsonl
function threadIdFromFilename(filePath: string): string | undefined {
  const name = filePath.split(/[/\\]/).pop()
  if (!name) {
    return undefined
  }
  const match = name.match(
    /rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
  )
  return match ? match[1] : undefined
}

// 窗口内日期序列,升序、零填充(补全缺失日)
function buildSeries(days: DayMap, window: UsageWindow): TokenUsageDay[] {
  const length = WINDOW_DAYS[window]
  const today = toLocalDayKey(new Date())
  const series: TokenUsageDay[] = []
  for (let offset = length - 1; offset >= 0; offset--) {
    const dateKey = addDays(today, -offset)
    const acc = days.get(dateKey)
    series.push(
      acc
        ? {
            date: dateKey,
            input: acc.input,
            cachedInput: acc.cachedInput,
            output: acc.output,
            reasoning: acc.reasoning,
            cost: acc.cost
          }
        : { date: dateKey, input: 0, cachedInput: 0, output: 0, reasoning: 0, cost: 0 }
    )
  }
  return series
}

function computeTotals(days: TokenUsageDay[]): TokenUsageOverview['totals'] {
  const totals: TokenUsageOverview['totals'] = {
    input: 0,
    cachedInput: 0,
    output: 0,
    reasoning: 0,
    total: 0,
    cost: 0
  }
  for (const day of days) {
    totals.input += day.input
    totals.cachedInput += day.cachedInput
    totals.output += day.output
    totals.reasoning += day.reasoning
    totals.total += day.input + day.output
    totals.cost += day.cost
  }
  totals.cost = Math.round(totals.cost * 10000) / 10000
  return totals
}

const WINDOW_DAYS: Record<UsageWindow, number> = { '1d': 1, '7d': 7, '30d': 30 }

function toLocalDayKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function addDays(dateKey: string, offset: number): string {
  const [year, month, day] = dateKey.split('-').map(Number)
  return toLocalDayKey(new Date(year, month - 1, day + offset))
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}
