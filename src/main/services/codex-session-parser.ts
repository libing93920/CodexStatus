import { promises as fs } from 'node:fs'
import {
  getNonNegativeNumber,
  getRecord,
  getString,
  parseJsonObject,
  parseTimestamp
} from './quota.ts'
import type { UsageEvent } from './agents.ts'

/** 单次增量(相邻 token_count 事件 total 之差);cacheCreation 仅 claude/opencode 提供,codex 恒为 0 */
export interface TokenDelta {
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

// 校验 UUID 格式(对齐 cc-switch Uuid::parse_str,L834):非法 UUID 的 parent → deferred
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function isValidUuid(value: string): boolean {
  return UUID_RE.test(value)
}

// 解析单个 session 文件:session_meta 记父子关系,turn_context 记模型,token_count 记差值
// 流式逐行读取(对齐 cc-switch BufReader::lines L784-783),避免大文件 readFile 触发
// V8 字符串长度上限(~512MB)导致 RangeError → 文件被丢弃 → 子会话误判孤儿。
export async function parseSessionFile(
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
          (snapshotSource !== undefined &&
            sigEq(signature, lastSignatureBySource.get(snapshotSource))))
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
