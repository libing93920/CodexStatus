import { promises as fs } from 'node:fs'
import {
  collectJsonlFiles,
  getNonNegativeNumber,
  getRecord,
  getString,
  parseJsonObject,
  parseTimestamp,
  resolveSessionPaths
} from './quota.ts'
import type { JsonlFileEntry } from './quota.ts'
import type { AgentId, ModelUsage, TokenUsageDay, TokenUsageOverview, UsageWindow } from '../../shared/capsule'
import { AGENT_PROVIDERS, listClaudeFiles, parseClaudeFile, type UsageEvent } from './agents.ts'
import { normalizeModel } from './pricing.ts'

// 30 天扫描窗口;mtime 早于该窗口的文件里不可能有窗口内事件,可直接剪枝
const SCAN_WINDOW_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000
const CACHE_TTL_MS = 60_000
// 增量缓存兜底:距上次全量重扫超过该时长强制全量对账,消除 mtime 不可靠导致的累计偏差
const FULL_RESCAN_INTERVAL_MS = 24 * 60 * 60 * 1000

// 各模型每百万 token 价格(USD),取官方标准(short context)价目:
// https://developers.openai.com/api/docs/pricing
// 说明:① 官方无独立 reasoning 单价,思考输出按 output 价计,故公式不含 reasoning 项;
//   ② 无缓存价的模型(pro 系)按"缓存无折扣=按 input 全价"处理;
//   ③ 表中未登记模型(如 codex-auto-review、第三方 GLM/DeepSeek 等)落到 DEFAULT_RATE。
const MODEL_RATES: Record<string, ModelRate> = {
  'gpt-5.6-sol': { input: 5.0, cachedInput: 0.5, output: 30.0 },
  'gpt-5.6-terra': { input: 2.0, cachedInput: 0.2, output: 12.0 },
  'gpt-5.6-luna': { input: 0.2, cachedInput: 0.02, output: 1.2 },
  'gpt-5.5': { input: 5.0, cachedInput: 0.5, output: 30.0 },
  'gpt-5.5-pro': { input: 30.0, cachedInput: 30.0, output: 180.0 },
  'gpt-5.4': { input: 2.5, cachedInput: 0.25, output: 15.0 },
  'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, cachedInput: 0.02, output: 1.25 },
  'gpt-5.4-pro': { input: 30.0, cachedInput: 30.0, output: 180.0 },
  'gpt-5.3-codex': { input: 1.75, cachedInput: 0.175, output: 14.0 },
  'gpt-5.2': { input: 1.75, cachedInput: 0.175, output: 14.0 },
  'gpt-5.2-pro': { input: 21.0, cachedInput: 21.0, output: 168.0 },
  'gpt-5.1': { input: 1.25, cachedInput: 0.125, output: 10.0 },
  'gpt-5': { input: 1.25, cachedInput: 0.125, output: 10.0 },
  'gpt-5-mini': { input: 0.25, cachedInput: 0.025, output: 2.0 },
  'gpt-5-nano': { input: 0.05, cachedInput: 0.005, output: 0.4 },
  'gpt-5-pro': { input: 15.0, cachedInput: 15.0, output: 120.0 },
  'gpt-4.1': { input: 2.0, cachedInput: 0.5, output: 8.0 },
  'gpt-4.1-mini': { input: 0.4, cachedInput: 0.1, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, cachedInput: 0.025, output: 0.4 },
  'gpt-4o': { input: 2.5, cachedInput: 1.25, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, cachedInput: 0.075, output: 0.6 },
  o3: { input: 2.0, cachedInput: 0.5, output: 8.0 },
  'o4-mini': { input: 1.1, cachedInput: 0.275, output: 4.4 },
  'o3-mini': { input: 1.1, cachedInput: 0.55, output: 4.4 },
  o1: { input: 15.0, cachedInput: 7.5, output: 60.0 }
}
// 兜底价(未登记模型):取 gpt-5.1 档位,中性偏低;第三方模型实际常更便宜,为估算上限
const DEFAULT_RATE: ModelRate = { input: 1.25, cachedInput: 0.125, output: 10 }

// 外部注入的价格查询(主进程启动时挂 models.dev 拉取结果);未注入/查不到时回落硬编码表
let rateLookup: ((model: string | undefined) => ModelRate | undefined) | undefined

export function setRateLookup(
  lookup: ((model: string | undefined) => ModelRate | undefined) | undefined
): void {
  rateLookup = lookup
}

export interface ModelRate {
  input: number
  cachedInput: number
  output: number
}

/** 单次增量(相邻 token_count 事件 total 之差) */
interface TokenDelta {
  input: number
  cachedInput: number
  output: number
  reasoning: number
  total: number
}

/** token_count 的五分量计数(用于跨文件重放签名匹配) */
interface TokenCounter {
  input: number
  cachedInput: number
  output: number
  reasoning: number
  total: number
}

/** 单个 token_count 事件的签名(total+last 各五分量) */
interface TokenSignature {
  total?: TokenCounter
  last?: TokenCounter
}

/** 解析后的单个 token_count 事件 */
interface ParsedEvent {
  ts: number
  sig: TokenSignature
  delta: TokenDelta
  model: string | undefined
}

/** 解析后的单个 session 文件 */
interface ParsedFile {
  parent: string | undefined
  deferred: boolean
  rootTs: number | undefined
  events: ParsedEvent[]
}

/** 单个本地自然日的累计 */
type Accum = TokenDelta & { cost: number }

type DayMap = Map<string, Accum>

/** 单个文件的上次解析产物:codex 存 ParsedFile(父子去重要用),claude 存独立事件 */
type FileState =
  | { kind: 'codex'; mtimeMs: number; parsed: ParsedFile }
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
let lastAgentTotals:
  | Partial<Record<UsageWindow, Partial<Record<AgentId, number>>>>
  | undefined

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
      const forceFull = cached !== undefined && now - cached.fullScannedAtMs >= FULL_RESCAN_INTERVAL_MS
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
  return { days: aggregateDays(events), events, files }
}

// Codex 两遍扫描:
// 第一遍解析每个 session 文件(session_meta 父子关系 + turn_context 模型 + token_count 差值),
// 第二遍带 parent 的子会话与父会话做 token 签名匹配,跳过重放前缀,只累计各自的新工作。
// 背景:Codex 子代理线程会重放父会话的累计上下文,直接求和会把同一份 token 重复计入(实测最高 9.5 倍)。
// 增量:按 mtime diff 只重扫变化/新增文件,未变化文件复用上次 ParsedFile;去重仍在完整集合上重跑。
async function incrementalScanCodex(
  prevFiles: Map<string, FileState> | undefined
): Promise<IncrementalScanResult> {
  const entries = await collectRecentFiles(Date.now())
  const files = new Map<string, FileState>()
  const parsed: Array<{ threadId: string | undefined; file: ParsedFile }> = []
  for (const entry of entries) {
    const prev = prevFiles?.get(entry.filePath)
    if (prev?.kind === 'codex' && prev.mtimeMs === entry.mtimeMs) {
      files.set(entry.filePath, prev)
      parsed.push({ threadId: threadIdFromFilename(entry.filePath), file: prev.parsed })
      continue
    }
    const threadId = threadIdFromFilename(entry.filePath)
    const file = await parseSessionFile(entry.filePath, threadId)
    if (!file || file.events.length === 0) {
      continue
    }
    files.set(entry.filePath, { kind: 'codex', mtimeMs: entry.mtimeMs, parsed: file })
    parsed.push({ threadId, file })
  }
  const events = dedupParsedFiles(parsed)
  return { days: aggregateDays(events), events, files }
}

// 跨文件父子重放去重:先按 threadId 选出事件最多的父文件,再对子文件前缀匹配跳过重放
function dedupParsedFiles(parsed: Array<{ threadId: string | undefined; file: ParsedFile }>): UsageEvent[] {
  const byThread = new Map<string, ParsedFile>()
  for (const { threadId, file } of parsed) {
    if (!threadId) {
      continue
    }
    const existing = byThread.get(threadId)
    if (!existing || existing.events.length < file.events.length) {
      byThread.set(threadId, file)
    }
  }

  const events: UsageEvent[] = []
  for (const { threadId, file } of parsed) {
    let skipPrefix = 0
    if (threadId && file.parent && !file.deferred && file.rootTs !== undefined) {
      const parent = byThread.get(file.parent)
      if (parent) {
        skipPrefix = matchingReplayPrefix(file.events, parent.events, file.rootTs)
      }
    }
    for (let index = skipPrefix; index < file.events.length; index++) {
      const event = file.events[index]
      events.push({ ts: event.ts, model: event.model, tokens: event.delta })
    }
  }
  return events
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

// 收集近 30 天窗口内的 JSONL 文件(按路径排序,保证遍历顺序确定)
async function collectRecentFiles(now: number): Promise<JsonlFileEntry[]> {
  const cutoff = now - SCAN_WINDOW_DAYS * DAY_MS
  const entries: JsonlFileEntry[] = []
  for (const root of resolveSessionPaths()) {
    if (!(await pathExists(root))) {
      continue
    }
    entries.push(...(await collectJsonlFiles(root, Number.MAX_SAFE_INTEGER)))
  }
  return entries
    .filter((entry) => entry.mtimeMs >= cutoff)
    .sort((left, right) => left.filePath.localeCompare(right.filePath))
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

// 解析单个 session 文件:session_meta 记父子关系,turn_context 记模型,token_count 记差值
async function parseSessionFile(
  filePath: string,
  threadId: string | undefined
): Promise<ParsedFile | undefined> {
  let content: string
  try {
    content = await fs.readFile(filePath, 'utf8')
  } catch {
    return undefined
  }

  let parent: string | undefined
  let deferred = false
  let rootTs: number | undefined
  let model: string | undefined
  let prev: TokenDelta | undefined
  const events: ParsedEvent[] = []

  for (const rawLine of content.split(/\r?\n/)) {
    if (rawLine.trim().length === 0) {
      continue
    }
    const parsed = parseJsonObject(rawLine)
    if (!parsed) {
      continue
    }
    const payload = getRecord(parsed.payload)
    if (!payload) {
      continue
    }

    const topType = getString(parsed.type)
    if (topType === 'session_meta') {
      // 文件可能重放父会话的 meta,只认本文件自己的(id 匹配文件名 uuid)
      const metaId = getString(payload.id)
      if (threadId && metaId && metaId !== threadId) {
        continue
      }
      const forked = getString(payload.forked_from_id)
      const sourceMeta = getRecord(getRecord(payload.source)?.subagent)
      const threadSpawn = sourceMeta ? getRecord(sourceMeta.thread_spawn) : undefined
      const spawned = getString(threadSpawn?.parent_thread_id)
      if (forked && spawned && forked !== spawned) {
        deferred = true
      } else {
        parent = forked ?? spawned
      }
      const metaTs = parseTimestamp(payload)
      if (metaTs) {
        rootTs = metaTs.getTime()
      }
      continue
    }
    if (topType === 'turn_context') {
      const modelName = getString(payload.model)
      if (modelName) {
        model = modelName
      }
      continue
    }
    if (topType !== 'event_msg' || getString(payload.type) !== 'token_count') {
      continue
    }

    const info = getRecord(payload.info)
    const totalUsage = info ? getRecord(info.total_token_usage) : undefined
    const lastUsage = info ? getRecord(info.last_token_usage) : undefined
    const timestamp = parseTimestamp(parsed)
    if (!totalUsage || !timestamp) {
      continue
    }

    // total_token_usage 是文件内累计值,取相邻事件差值才是该时段的真实增量
    const current: TokenDelta = {
      input: getNonNegativeNumber(totalUsage.input_tokens) ?? 0,
      cachedInput: getNonNegativeNumber(totalUsage.cached_input_tokens) ?? 0,
      output: getNonNegativeNumber(totalUsage.output_tokens) ?? 0,
      reasoning: getNonNegativeNumber(totalUsage.reasoning_output_tokens) ?? 0,
      total: getNonNegativeNumber(totalUsage.total_tokens) ?? 0
    }
    const delta = prev ? subtractClamp(current, prev) : current
    prev = current

    events.push({
      ts: timestamp.getTime(),
      sig: buildSignature(totalUsage, lastUsage),
      delta,
      model
    })
  }

  return { parent, deferred, rootTs, events }
}

function buildSignature(
  totalUsage: Record<string, unknown>,
  lastUsage: Record<string, unknown> | undefined
): TokenSignature {
  return {
    total: pickCounters(totalUsage),
    last: lastUsage ? pickCounters(lastUsage) : undefined
  }
}

function pickCounters(usage: Record<string, unknown>): TokenCounter | undefined {
  const input = getNonNegativeNumber(usage.input_tokens)
  const cachedInput = getNonNegativeNumber(usage.cached_input_tokens)
  const output = getNonNegativeNumber(usage.output_tokens)
  const reasoning = getNonNegativeNumber(usage.reasoning_output_tokens)
  const total = getNonNegativeNumber(usage.total_tokens)
  if (
    input === undefined &&
    cachedInput === undefined &&
    output === undefined &&
    reasoning === undefined &&
    total === undefined
  ) {
    return undefined
  }
  return {
    input: input ?? 0,
    cachedInput: cachedInput ?? 0,
    output: output ?? 0,
    reasoning: reasoning ?? 0,
    total: total ?? 0
  }
}

function sigEq(a: TokenSignature, b: TokenSignature): boolean {
  return countersEq(a.total, b.total) && countersEq(a.last, b.last)
}

function countersEq(a: TokenCounter | undefined, b: TokenCounter | undefined): boolean {
  if (Boolean(a) !== Boolean(b)) {
    return false
  }
  if (!a || !b) {
    return true
  }
  return (
    a.input === b.input &&
    a.cachedInput === b.cachedInput &&
    a.output === b.output &&
    a.reasoning === b.reasoning &&
    a.total === b.total
  )
}

// 子会话前缀事件若与父会话时间线(≤子会话起点)按序匹配,即视为重放,返回重放的事件数
function matchingReplayPrefix(
  child: ParsedEvent[],
  parent: ParsedEvent[],
  childRootTs: number
): number {
  const parentSigs: TokenSignature[] = []
  for (const event of parent) {
    if (event.ts <= childRootTs) {
      parentSigs.push(event.sig)
    }
  }
  let parentOffset = 0
  let matched = 0
  for (const event of child) {
    let found = -1
    for (let i = parentOffset; i < parentSigs.length; i++) {
      if (sigEq(parentSigs[i], event.sig)) {
        found = i
        break
      }
    }
    if (found < 0) {
      break
    }
    parentOffset = found + 1
    matched++
  }
  return matched
}

function subtractClamp(current: TokenDelta, prev: TokenDelta): TokenDelta {
  return {
    input: Math.max(0, current.input - prev.input),
    cachedInput: Math.max(0, current.cachedInput - prev.cachedInput),
    output: Math.max(0, current.output - prev.output),
    reasoning: Math.max(0, current.reasoning - prev.reasoning),
    total: Math.max(0, current.total - prev.total)
  }
}

function computeCost(delta: TokenDelta, model: string | undefined): number {
  const rate =
    rateLookup?.(model) ??
    (model !== undefined ? MODEL_RATES[model] : undefined) ??
    DEFAULT_RATE
  // input 含 cachedInput,常规输入部分需减去;output 已含 reasoning,无独立思考单价
  const regularInput = Math.max(0, delta.input - delta.cachedInput)
  const cost =
    (regularInput * rate.input +
      delta.cachedInput * rate.cachedInput +
      delta.output * rate.output) /
    1e6
  return Math.round(cost * 10000) / 10000
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
