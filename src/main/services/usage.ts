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
import type { TokenUsageDay, TokenUsageOverview, UsageWindow } from '../../shared/capsule'

// 30 天扫描窗口;mtime 早于该窗口的文件里不可能有窗口内事件,可直接剪枝
const SCAN_WINDOW_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000
const CACHE_TTL_MS = 60_000

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

interface CacheEntry {
  fingerprint: string
  fetchedAtMs: number
  days: DayMap
}

let cache: CacheEntry | undefined
// 防止并发调用(如预取 3 个窗口)重复扫描:首次扫描进行中时复用同一 Promise
let inflightDays: Promise<DayMap> | undefined

/**
 * 获取 1/7/30 天 token 用量与估算花费。
 * 数据现算现得:扫描近 30 天 sessions JSONL,按"相邻事件 total 差值"归因到本地自然日。
 */
export async function getTokenUsage(window: UsageWindow): Promise<TokenUsageOverview> {
  const days = await loadDays()
  const series = buildSeries(days, window)
  const totals = computeTotals(series)
  return {
    available: totals.total > 0,
    generatedAt: new Date().toISOString(),
    days: series,
    totals
  }
}

// 带指纹+TTL 的缓存:指纹不变(文件集合+mtime 没变)且未过期时直接复用已解析的日桶,
// 避免每 30s 快照刷新后 UI 拉取时重复读+解析全部文件
async function loadDays(): Promise<DayMap> {
  const now = Date.now()
  if (cache && now - cache.fetchedAtMs < CACHE_TTL_MS) {
    return cache.days
  }
  if (!inflightDays) {
    const { fingerprint } = await collectRecentFiles(now)
    if (cache && cache.fingerprint === fingerprint) {
      cache.fetchedAtMs = now
      return cache.days
    }
    inflightDays = scanRecentDays().then((days) => {
      cache = { fingerprint, fetchedAtMs: now, days }
      inflightDays = undefined
      return days
    })
  }
  return inflightDays
}

// —— 用量聚合:两遍扫描 ——
// 第一遍:解析每个 session 文件(session_meta 父子关系 + turn_context 模型 + token_count 差值)。
// 第二遍:带 parent 的子会话与父会话做 token 签名匹配,跳过重放前缀,只累计各自的新工作。
// 背景:Codex 子代理线程会重放父会话的累计上下文,直接求和会把同一份 token 重复计入(实测最高 9.5 倍)。
async function scanRecentDays(): Promise<DayMap> {
  const { entries } = await collectRecentFiles(Date.now())

  const byThread = new Map<string, ParsedFile>()
  const parsed: Array<{ threadId: string | undefined; file: ParsedFile }> = []
  for (const entry of entries) {
    const threadId = threadIdFromFilename(entry.filePath)
    const file = await parseSessionFile(entry.filePath, threadId)
    if (!file || file.events.length === 0) {
      continue
    }
    parsed.push({ threadId, file })
    if (threadId) {
      const existing = byThread.get(threadId)
      if (!existing || existing.events.length < file.events.length) {
        byThread.set(threadId, file)
      }
    }
  }

  const days: DayMap = new Map()
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
      const dateKey = toLocalDayKey(new Date(event.ts))
      let acc = days.get(dateKey)
      if (!acc) {
        acc = { input: 0, cachedInput: 0, output: 0, reasoning: 0, total: 0, cost: 0 }
        days.set(dateKey, acc)
      }
      acc.input += event.delta.input
      acc.cachedInput += event.delta.cachedInput
      acc.output += event.delta.output
      acc.reasoning += event.delta.reasoning
      acc.total += event.delta.total
      acc.cost += computeCost(event.delta, event.model)
    }
  }
  return days
}

// 收集近 30 天窗口内的 JSONL 文件,并算出指纹(路径:mtime,按路径排序保证确定)
async function collectRecentFiles(
  now: number
): Promise<{ entries: JsonlFileEntry[]; fingerprint: string }> {
  const cutoff = now - SCAN_WINDOW_DAYS * DAY_MS
  const entries: JsonlFileEntry[] = []
  for (const root of resolveSessionPaths()) {
    if (!(await pathExists(root))) {
      continue
    }
    entries.push(...(await collectJsonlFiles(root, Number.MAX_SAFE_INTEGER)))
  }
  const recent = entries.filter((entry) => entry.mtimeMs >= cutoff)
  recent.sort((left, right) => left.filePath.localeCompare(right.filePath))
  const fingerprint =
    `${recent.map((entry) => `${entry.filePath}:${entry.mtimeMs}`).join('|')}|` +
    toLocalDayKey(new Date(now))
  return { entries: recent, fingerprint }
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
