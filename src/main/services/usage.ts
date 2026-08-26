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
import { computeCost, normalizeModel } from './rate.ts'

// 展示窗口最大天数;buildSeries 按此取日期序列,事件层过滤由日期序列完成(对齐 cc-switch 查询层过滤)
const CACHE_TTL_MS = 60_000
// 增量缓存兜底:距上次全量重扫超过该时长强制全量对账,消除 mtime 不可靠导致的累计偏差
const FULL_RESCAN_INTERVAL_MS = 24 * 60 * 60 * 1000

/** 单次增量(相邻 token_count 事件 total 之差);cacheCreation 仅 claude/opencode 提供,codex 恒为 0 */
interface TokenDelta {
  input: number
  cachedInput: number
  output: number
  reasoning: number
  total: number
  cacheCreation?: number
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
export interface ParsedFile {
  parent: string | undefined
  deferred: boolean
  rootTs: number | undefined
  events: ParsedEvent[]
  /** 父时间线完整性校验(对齐 cc-switch ParentTokenTimeline):
   * hasTokenWithoutTimestamp: 任何 token_count 缺有效 timestamp → 父时间线不可用
   * maxTimestamp: 所有 token_count 事件的最大 ts;< 子 rootTs → 父尚未写到 fork 时刻
   * 两者触发时子会话 skipAll,对齐 cc-switch signatures_before 的 Err 路径 */
  hasTokenWithoutTimestamp: boolean
  maxTimestamp: number | undefined
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
// 增量:按 mtime diff 只重扫变化/新增文件,未变化文件复用上次 ParsedFile;去重仍在完整集合上重跑。
async function incrementalScanCodex(
  prevFiles: Map<string, FileState> | undefined
): Promise<IncrementalScanResult> {
  const entries = await collectRecentFiles()
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

// 跨文件父子重放去重(对齐 cc-switch session_usage_codex.rs sync_single_codex_file L1204-1293):
// - deferred(meta 异常:forked≠spawned/非法UUID/自指/metaID≠文件名):mark_deferred 跳过整个文件
// - 有 parent 但 root meta 缺有效 timestamp:mark_deferred 跳过(L1215-1223)
// - 有 parent 且父文件在扫描集且有可解析签名:前缀匹配跳过重放,保留断点后真实增量
// - 有 parent 但父文件不在扫描集,或父在但无法解析签名(空文件/无 token_count):
//   mark_deferred 挂起,跳过整个文件(子会话 total 继承父累计值,无法拆分,计入必重复)
// - 无 parent(主会话/guardian):全量计入
export function dedupParsedFiles(
  parsed: Array<{ threadId: string | undefined; file: ParsedFile }>
): UsageEvent[] {
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
    let skipAll = false
    // cc-switch sync_single_codex_file(L1204-1271):parent 解析的四种结果分别处理
    // Deferred(meta 异常)→ mark_deferred 跳过;None(无 parent)→ 全量计入;
    // Parent(id)但有 parent 无 rootTs → mark_deferred 跳过(L1215-1223);有 rootTs → 前缀去重
    if (file.deferred) {
      // cc-switch:ParentResolution::Deferred → mark_deferred,整个文件不计入(L1206-1213)
      skipAll = true
    } else if (threadId && file.parent && file.rootTs !== undefined) {
      const parent = byThread.get(file.parent)
      if (parent) {
        // cc-switch 父时间线完整性校验(signatures_before L155-169):
        // 父任何 token_count 缺 timestamp → 父时间线不可用 → 子 deferred 跳过
        // 父最大 timestamp < 子 rootTs → 父尚未写到 fork 时刻 → 子 deferred 跳过
        if (parent.hasTokenWithoutTimestamp || (parent.maxTimestamp ?? 0) < file.rootTs) {
          skipAll = true
        } else {
          // 父时间线完整:前缀去重
          skipPrefix = matchingReplayPrefix(file.events, parent.events, file.rootTs)
        }
      } else {
        // 父不在扫描集,或父在但无签名(空文件):挂起跳过,对齐 cc-switch mark_deferred
        skipAll = true
      }
    } else if (threadId && file.parent && file.rootTs === undefined) {
      // cc-switch:有 parent 但 root meta 缺有效 timestamp → mark_deferred 跳过(L1215-1223)
      skipAll = true
    }
    if (skipAll) {
      continue
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

// 校验 UUID 格式(对齐 cc-switch Uuid::parse_str,L834):非法 UUID 的 parent → deferred
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function isValidUuid(value: string): boolean {
  return UUID_RE.test(value)
}

// 解析单个 session 文件:session_meta 记父子关系,turn_context 记模型,token_count 记差值
// 流式逐行读取(对齐 cc-switch BufReader::lines L784-783),避免大文件 readFile 触发
// V8 字符串长度上限(~512MB)导致 RangeError → 文件被丢弃 → 子会话误判孤儿。
async function parseSessionFile(
  filePath: string,
  threadId: string | undefined
): Promise<ParsedFile | undefined> {
  let handle: fs.FileHandle
  try {
    handle = await fs.open(filePath, 'r')
  } catch {
    return undefined
  }

  let parent: string | undefined
  let deferred = false
  let rootTs: number | undefined
  let model: string | undefined
  // total 累计高水位线:跨事件只增不减,用于 last 缺失时差值兜底(对齐 cc-switch total_high_water)
  let highWater: TokenDelta | undefined
  const events: ParsedEvent[] = []
  // 成对重复快照判重状态:codex 会为同一 token_count 连写两份(rate-limit 刷新重发),total/last 不变
  const lastSignatureBySource = new Map<string, TokenSignature>()
  let previousTokenSignature: TokenSignature | undefined
  // 父时间线完整性(对齐 cc-switch ParentTokenTimeline)
  let hasTokenWithoutTimestamp = false
  let maxTimestamp: number | undefined
  // cc-switch:只在第一个本文件 session_meta 做 parent/deferred 判定,重放的父 meta 跳过(L813)
  let rootMetaSeen = false

  let leftover = ''
  for await (const chunk of handle.createReadStream({ encoding: 'utf8' })) {
    leftover += chunk
    const lines = leftover.split(/\r?\n/)
    // 最后一段可能是不完整行,留给下一个 chunk 拼接
    leftover = lines.pop() ?? ''
    for (const rawLine of lines) {
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
        // cc-switch:只在首个 session_meta 判定(L813 if !root_meta_seen)
        if (rootMetaSeen) {
          continue
        }
        rootMetaSeen = true
        const metaId = getString(payload.id)
        // cc-switch:文件名 threadId 与 root meta id 不一致 → deferred(L825-830)
        if (threadId && metaId && metaId !== threadId) {
          deferred = true
        } else {
          const forked = getString(payload.forked_from_id)
          const sourceMeta = getRecord(getRecord(payload.source)?.subagent)
          const threadSpawn = sourceMeta ? getRecord(sourceMeta.thread_spawn) : undefined
          const spawned = getString(threadSpawn?.parent_thread_id)
          // cc-switch explicit_parent_from_meta(L408-414):
          // 两者都有且不等 → Deferred;否则取存在的那个作 parent
          if (forked && spawned && forked !== spawned) {
            deferred = true
          } else {
            const resolved = forked ?? spawned
            if (resolved) {
              // cc-switch:parent 非法 UUID → Deferred(L833-841)
              if (!isValidUuid(resolved)) {
                deferred = true
              }
              // cc-switch:parent 与自身 threadId 相同 → Deferred(L843-848)
              else if (threadId && resolved === threadId) {
                deferred = true
              } else {
                parent = resolved
              }
            }
          }
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
      // cc-switch:total 和 last 任一存在即继续(L891-893);不能要求 total 必须存在,
      // 否则"只有 last 没 total"的事件被跳过,父文件可能解析成 0 events → 子会话误判孤儿。
      if (!totalUsage && !lastUsage) {
        continue
      }
      const hasTotalSnapshot = totalUsage !== undefined
      const timestamp = parseTimestamp(parsed)
      // cc-switch:token_count 缺有效 timestamp → 标记父时间线不可用(L1025-1027),
      // 该文件作父时子会话 skipAll(L155-159)
      if (!timestamp) {
        hasTokenWithoutTimestamp = true
        continue
      }
      // 跟踪最大 timestamp;作父时若 < 子 rootTs → 子 skipAll(cc-switch L161-168)
      const tsMs = timestamp.getTime()
      if (maxTimestamp === undefined || tsMs > maxTimestamp) {
        maxTimestamp = tsMs
      }

      const signature = buildSignature(totalUsage, lastUsage)
      // cc-switch:判重只在有 total 快照时做(L894-897);只有 last 的事件不判重
      // (last 每次请求都变,不会是重复快照)。
      const snapshotSource = getString(getRecord(payload.rate_limits)?.limit_id)
      const duplicate =
        hasTotalSnapshot &&
        (sigEq(signature, previousTokenSignature) ||
          (snapshotSource !== undefined && sigEq(signature, lastSignatureBySource.get(snapshotSource))))
      if (hasTotalSnapshot && snapshotSource !== undefined) {
        lastSignatureBySource.set(snapshotSource, signature)
      }
      if (hasTotalSnapshot) {
        previousTokenSignature = signature
      }

      // cc-switch delta(L903-922):last 优先 → total 高水位差兜底 → 都没有 continue(已挡)
      const current = totalUsage ? toDelta(totalUsage) : toDelta(lastUsage!)
      const delta = duplicate ? ZERO_DELTA : buildCodexDelta(current, lastUsage, highWater)
      // 高水位只在 total 存在时更新(cc-switch L923-929);只有 last 时不推进
      if (totalUsage) {
        if (!highWater || current.total > highWater.total) {
          highWater = current
        }
      }

      events.push({
        ts: tsMs,
        sig: signature,
        delta,
        model
      })
    }
  }
  await handle.close()

  return { parent, deferred, rootTs, events, hasTokenWithoutTimestamp, maxTimestamp }
}

const ZERO_DELTA: TokenDelta = { input: 0, cachedInput: 0, output: 0, reasoning: 0, total: 0 }

// 单个 token_count 事件 → 本次增量:有 last_token_usage 时直接用其精确单次用量,
// 否则用累计差兜底:current - highWater(高水位线,跨事件只增不减)。
// 高水位而非相邻 prev:total_token_usage 是会话级累计,跨模型/rate-limit lane 切换可能回退,
// 用高水位保证差值非负且不把回退后重新累计的值重复计入(对齐 cc-switch total_high_water)。
export function buildCodexDelta(
  current: TokenDelta,
  lastUsage: Record<string, unknown> | undefined,
  highWater: TokenDelta | undefined
): TokenDelta {
  if (lastUsage) {
    return toDelta(lastUsage)
  }
  return highWater ? subtractClamp(current, highWater) : current
}

// codex token_count 的 total/last 五分量转 TokenDelta;cachedInput 钳制不超过 input(cc-switch 同款)
function toDelta(usage: Record<string, unknown>): TokenDelta {
  const input = getNonNegativeNumber(usage.input_tokens) ?? 0
  const cachedInput = Math.min(getNonNegativeNumber(usage.cached_input_tokens) ?? 0, input)
  return {
    input,
    cachedInput,
    output: getNonNegativeNumber(usage.output_tokens) ?? 0,
    reasoning: getNonNegativeNumber(usage.reasoning_output_tokens) ?? 0,
    total: getNonNegativeNumber(usage.total_tokens) ?? 0
  }
}

// cc-switch parse_token_signature(L447-451):total 或 last 任一存在即构建签名
function buildSignature(
  totalUsage: Record<string, unknown> | undefined,
  lastUsage: Record<string, unknown> | undefined
): TokenSignature {
  return {
    total: totalUsage ? pickCounters(totalUsage) : undefined,
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

function sigEq(a: TokenSignature | undefined, b: TokenSignature | undefined): boolean {
  if (Boolean(a) !== Boolean(b)) {
    return false
  }
  if (!a || !b) {
    return true
  }
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
