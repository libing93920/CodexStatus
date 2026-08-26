// Agent 工具 provider 抽象:统一"本地扫描 → 事件级 token 用量"的接口。
// v1 只做本地扫描出用量/花费,不涉及 billing/官方额度/重置卡/雷达。
// 注:codex 与 claude 的扫描逻辑已迁到 usage.ts 做增量(incrementalScanCodex/incrementalScanClaude),
// 此处注册表是 opencode(SQLite 无文件粒度增量)与 pi(JSONL 全量扫描)。
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentId } from '../../shared/capsule'
import {
  collectJsonlFiles,
  getNonNegativeNumber,
  getRecord,
  getString,
  parseJsonObject
} from './quota.ts'
import type { JsonlFileEntry } from './quota.ts'

/** 单次用量增量的五分量 token 计数 */
export interface TokenUsage {
  input: number
  cachedInput: number
  output: number
  reasoning: number
  total: number
  /** 其中缓存写入(creation)的 token 数;计费时与 cache_read 分开按不同单价。展示层不拆,cachedInput 仍是两者之和 */
  cacheCreation?: number
}

/** 一条可归桶的事件级用量;costUsd 存在时跳过按价目估算(OpenCode 直接给成本) */
export interface UsageEvent {
  ts: number
  model?: string
  tokens: TokenUsage
  costUsd?: number
  /** 来源消息 id(claude 专用),用于跨文件全局去重:同一请求可能被续会话/会话副本重复写入 */
  messageId?: string
}

export interface AgentProvider {
  id: AgentId
  label: string
  /** 扫描近 30 天用量为事件级明细;内部各自实现,抛错由调用方兜底为空数组 */
  scanRecentEvents(): Promise<UsageEvent[]>
}

export const AGENT_PROVIDERS: Partial<Record<AgentId, AgentProvider>> = {
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    scanRecentEvents: scanOpenCodeEvents
  },
  pi: {
    id: 'pi',
    label: 'Pi',
    scanRecentEvents: scanPiEvents
  }
}

// —— Claude Code 解析器 ——
const CLAUDE_SCAN_WINDOW_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

// 枚举近 30 天窗口内的 Claude 会话文件(path+mtimeMs);目录不存在返回空。
// 供 usage.ts 增量 diff 复用。
export function listClaudeFiles(): Promise<JsonlFileEntry[]> {
  return listClaudeFilesAt(Date.now())
}

async function listClaudeFilesAt(now: number): Promise<JsonlFileEntry[]> {
  const projectsDir = resolveClaudeProjectsDir()
  if (!(await pathExists(projectsDir))) {
    return []
  }
  const files = await collectJsonlFiles(projectsDir, Number.MAX_SAFE_INTEGER)
  const cutoff = now - CLAUDE_SCAN_WINDOW_DAYS * DAY_MS
  return files.filter((file) => file.mtimeMs >= cutoff)
}

// 解析单个 Claude 会话文件为事件级明细;同一 message.id 在文件里会重复出现
// (Anthropic 先写 message_start 快照再写最终块,部分会话还会被重放多份),按 id 只取代表行,
// 避免同一请求被重复计入(实测未去重时总量虚高 ~2.3x)。
export async function parseClaudeFile(filePath: string): Promise<UsageEvent[]> {
  let content: string
  try {
    content = await fs.readFile(filePath, 'utf8')
  } catch {
    return []
  }
  const best = new Map<string, ClaudeParsedLine>()
  const events: UsageEvent[] = []
  for (const rawLine of content.split(/\r?\n/)) {
    if (rawLine.trim().length === 0) {
      continue
    }
    const line = parseClaudeLine(rawLine)
    if (!line) {
      continue
    }
    if (!line.messageId) {
      events.push(line.event)
      continue
    }
    const prev = best.get(line.messageId)
    if (!prev || isBetterRepresentative(prev, line)) {
      best.set(line.messageId, line)
    }
  }
  return [...best.values()].map((line) => line.event).concat(events)
}

interface ClaudeParsedLine {
  event: UsageEvent
  messageId?: string
  hasStopReason: boolean
}

// cc-switch 同款代表行规则:有 stop_reason 的是最终块,优先;同状态取 output 更大者
function isBetterRepresentative(prev: ClaudeParsedLine, next: ClaudeParsedLine): boolean {
  if (prev.hasStopReason !== next.hasStopReason) {
    return next.hasStopReason
  }
  return next.event.tokens.output > prev.event.tokens.output
}

// 解析一条 assistant 消息行:取 message.usage + 顶层 timestamp(ISO) + message.model;
// 返回 messageId 供同文件去重;事件内 cache_creation 单独带出供计费(展示层仍并入 cachedInput)。
function parseClaudeLine(rawLine: string): ClaudeParsedLine | undefined {
  const parsed = parseJsonObject(rawLine)
  if (!parsed || getString(parsed.type) !== 'assistant') {
    return undefined
  }
  const message = getRecord(parsed.message)
  const usage = message ? getRecord(message.usage) : undefined
  if (!usage) {
    return undefined
  }
  const tsRaw = getString(parsed.timestamp)
  if (!tsRaw) {
    return undefined
  }
  const ts = Date.parse(tsRaw)
  if (Number.isNaN(ts)) {
    return undefined
  }
  const outputTokens = getNonNegativeNumber(usage.output_tokens) ?? 0
  const cacheCreation = getNonNegativeNumber(usage.cache_creation_input_tokens) ?? 0
  const cacheRead = getNonNegativeNumber(usage.cache_read_input_tokens) ?? 0
  const cachedInput = cacheCreation + cacheRead
  // input 含缓存:Claude 的 input_tokens 不含缓存,缓存单列,故相加才是总输入
  const input = (getNonNegativeNumber(usage.input_tokens) ?? 0) + cachedInput
  if (input === 0 && outputTokens === 0) {
    return undefined
  }
  return {
    event: {
      ts,
      model: getString(message?.model),
      tokens: {
        input,
        cachedInput,
        output: outputTokens,
        reasoning: 0,
        total: input + outputTokens,
        cacheCreation
      },
      messageId: getString(message?.id)
    },
    messageId: getString(message?.id),
    hasStopReason: getString(message?.stop_reason) !== undefined
  }
}

// 单行解析(不含去重),供单测使用
export function parseClaudeAssistantEvent(rawLine: string): UsageEvent | undefined {
  return parseClaudeLine(rawLine)?.event
}

// Claude 配置目录:~/.claude(可被 CLAUDE_CONFIG_DIR 覆盖),projects 子目录存各会话 JSONL
function resolveClaudeProjectsDir(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim()
  const base = configured
    ? path.resolve(configured === '~' ? os.homedir() : configured)
    : path.join(os.homedir(), '.claude')
  return path.join(base, 'projects')
}

// —— OpenCode 读取器 ——
const OPENCODE_SCAN_WINDOW_DAYS = 30

// OpenCode 存 SQLite(非 JSONL)。对齐 cc-switch 读 message 表逐条 assistant 消息(而非 session 表整会话),
// 窗口按消息 time_created 过滤——session 表按 time_updated 会把整会话历史拖入窗口,长会话机器上虚高 ~10x。
// 只取已完成(time.completed 存在)的消息,进行中只有半截 token;cost 为 0 时(自定义 provider 未计价/免费模型)
// 不直接给 costUsd,回落按价目估算。
async function scanOpenCodeEvents(): Promise<UsageEvent[]> {
  const dbPath = resolveOpenCodeDbPath()
  if (!(await pathExists(dbPath))) {
    return []
  }
  let db: DatabaseSync
  try {
    // 懒加载 node:sqlite:旧 Electron 无此内置模块时仅 OpenCode 不可用,不拖垮整 app
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch {
    return []
  }
  try {
    const cutoff = Date.now() - OPENCODE_SCAN_WINDOW_DAYS * DAY_MS
    const rows = db
      .prepare(
        `SELECT data FROM message
         WHERE json_extract(data, '$.role') = 'assistant'
           AND json_extract(data, '$.tokens') IS NOT NULL
           AND json_extract(data, '$.time.completed') IS NOT NULL
           AND time_created >= ?`
      )
      .all(cutoff)
    const events: UsageEvent[] = []
    for (const row of rows) {
      const event = parseOpenCodeMessage(getString(row.data))
      if (event) {
        events.push(event)
      }
    }
    return events
  } finally {
    db.close()
  }
}

// 解析 opencode message.data JSON 为事件;字段语义与 cc-switch 一致:
// tokens.input 是"非缓存输入"(input 与 cache.read/write 是并列字段),cache 两桶分开带出供计费,
// tokens.output 不含 reasoning,相加才是总输出。
export function parseOpenCodeMessage(dataRaw: string | undefined): UsageEvent | undefined {
  const data = dataRaw ? parseJsonObject(dataRaw) : undefined
  const tokens = data ? getRecord(data.tokens) : undefined
  const time = data ? getRecord(data.time) : undefined
  if (!data || !tokens || !time || getNonNegativeNumber(time.completed) === undefined) {
    return undefined
  }
  const freshInput = getNonNegativeNumber(tokens.input) ?? 0
  const outputTokens = getNonNegativeNumber(tokens.output) ?? 0
  const reasoning = getNonNegativeNumber(tokens.reasoning) ?? 0
  const cache = getRecord(tokens.cache)
  const cacheRead = cache ? (getNonNegativeNumber(cache.read) ?? 0) : 0
  const cacheWrite = cache ? (getNonNegativeNumber(cache.write) ?? 0) : 0
  const cachedInput = cacheRead + cacheWrite
  const input = freshInput + cachedInput
  const output = outputTokens + reasoning
  const ts = getNonNegativeNumber(time.created) ?? 0
  if ((input === 0 && output === 0) || ts === 0) {
    return undefined
  }
  const event: UsageEvent = {
    ts,
    model: getString(data.modelID),
    tokens: {
      input,
      cachedInput,
      output,
      reasoning,
      total: input + output,
      cacheCreation: cacheWrite
    }
  }
  const cost = getNonNegativeNumber(data.cost) ?? 0
  if (cost > 0) {
    event.costUsd = cost
  }
  return event
}

// OpenCode 数据目录:遵循 XDG,默认 ~/.local/share/opencode/opencode.db
function resolveOpenCodeDbPath(): string {
  const dataHome = process.env.XDG_DATA_HOME?.trim()
  const base = dataHome
    ? path.resolve(dataHome === '~' ? os.homedir() : dataHome)
    : path.join(os.homedir(), '.local', 'share')
  return path.join(base, 'opencode', 'opencode.db')
}

// —— Pi 读取器 ——
const PI_SCAN_WINDOW_DAYS = 30

// Pi(badlogic/pi-mono)会话为 JSONL:~/.pi/agent/sessions/--<编码后cwd>--/<时间戳>_<uuidv7>.jsonl。
// 首行 SessionHeader(type:"session"),后续条目带 type 字段;token 记在 assistant 消息的
// message.usage 上(每消息独立计数,非累计),compaction/branch_summary 条目也可带 usage
// (官方文档口径计入会话总量)。tool result 的 usage 不属主 LLM 计费,跳过。
// 会话是分支树:废弃分支的 token 同样真实计费消耗,按"实际消耗"口径全部计入。
async function scanPiEvents(): Promise<UsageEvent[]> {
  const sessionsDir = resolvePiSessionsDir()
  if (!(await pathExists(sessionsDir))) {
    return []
  }
  const cutoff = Date.now() - PI_SCAN_WINDOW_DAYS * DAY_MS
  const files = await collectJsonlFiles(sessionsDir, Number.MAX_SAFE_INTEGER)
  const events: UsageEvent[] = []
  for (const file of files) {
    // 先按 mtime 粗筛(claude 同款),再逐行按事件时间精筛(opencode 同款)
    if (file.mtimeMs < cutoff) {
      continue
    }
    let content: string
    try {
      content = await fs.readFile(file.filePath, 'utf8')
    } catch {
      continue
    }
    for (const rawLine of content.split(/\r?\n/)) {
      if (rawLine.trim().length === 0) {
        continue
      }
      const event = parsePiEntryLine(rawLine)
      if (event && event.ts >= cutoff) {
        events.push(event)
      }
    }
  }
  return events
}

// 解析 pi 会话 JSONL 单行为事件;供单测使用。
// token 字段语义自适应:pi-ai 对 Anthropic 类 provider 归一化为并列字段(input 不含缓存,
// cacheRead/cacheWrite 单列),对 OpenAI 类 input 可能已含缓存。用 totalTokens 校验两种口径
// 取更贴近者,避免缓存双计/漏计;无 totalTokens 时按并列口径兜底。
export function parsePiEntryLine(rawLine: string): UsageEvent | undefined {
  const parsed = parseJsonObject(rawLine)
  if (!parsed) {
    return undefined
  }
  const entryType = getString(parsed.type)
  let usageRecord: Record<string, unknown> | undefined
  let model: string | undefined
  let ts = Number.NaN
  if (entryType === 'message') {
    const message = getRecord(parsed.message)
    if (!message || getString(message.role) !== 'assistant') {
      return undefined
    }
    usageRecord = getRecord(message.usage)
    if (!usageRecord) {
      return undefined
    }
    model = getString(message.model)
    const messageTs = getNonNegativeNumber(message.timestamp)
    if (messageTs !== undefined && messageTs > 0) {
      ts = messageTs
    }
  } else if (entryType === 'compaction' || entryType === 'branch_summary') {
    usageRecord = getRecord(parsed.usage)
  }
  if (!usageRecord) {
    return undefined
  }
  if (Number.isNaN(ts)) {
    const parsedTs = Date.parse(getString(parsed.timestamp) ?? '')
    if (!Number.isNaN(parsedTs)) {
      ts = parsedTs
    }
  }
  const rawInput = getNonNegativeNumber(usageRecord.input) ?? 0
  const outputTokens = getNonNegativeNumber(usageRecord.output) ?? 0
  const cacheRead = getNonNegativeNumber(usageRecord.cacheRead) ?? 0
  const cacheWrite = getNonNegativeNumber(usageRecord.cacheWrite) ?? 0
  const reasoning = getNonNegativeNumber(usageRecord.reasoning) ?? 0
  const reportedTotal = getNonNegativeNumber(usageRecord.totalTokens) ?? 0
  const sumParallel = rawInput + outputTokens + cacheRead + cacheWrite
  const sumInclusive = rawInput + outputTokens
  const parallel =
    reportedTotal > 0
      ? Math.abs(reportedTotal - sumParallel) <= Math.abs(reportedTotal - sumInclusive)
      : true
  // CodexStatus 统一口径:tokens.input 含缓存,total = 含缓存输入 + 输出(reasoning 是 output 子集不另加)
  const cachedInput = parallel ? cacheRead + cacheWrite : 0
  const input = rawInput + cachedInput
  const total = reportedTotal > 0 ? reportedTotal : parallel ? sumParallel : sumInclusive
  if ((input === 0 && outputTokens === 0) || !Number.isFinite(ts) || ts <= 0) {
    return undefined
  }
  const event: UsageEvent = {
    ts,
    model,
    tokens: {
      input,
      cachedInput,
      output: outputTokens,
      reasoning,
      total,
      cacheCreation: parallel ? cacheWrite : undefined
    }
  }
  const cost = getRecord(usageRecord.cost)
  const costTotal = cost ? (getNonNegativeNumber(cost.total) ?? 0) : 0
  if (costTotal > 0) {
    event.costUsd = costTotal
  }
  return event
}

// Pi 数据目录:~/.pi/agent/sessions,与官方一致支持 PI_CODING_AGENT_SESSION_DIR /
// PI_CODING_AGENT_DIR 环境变量覆盖
function resolvePiSessionsDir(): string {
  const sessionDirOverride = process.env.PI_CODING_AGENT_SESSION_DIR?.trim()
  if (sessionDirOverride) {
    return path.resolve(sessionDirOverride === '~' ? os.homedir() : sessionDirOverride)
  }
  const agentDirOverride = process.env.PI_CODING_AGENT_DIR?.trim()
  const agentDir = agentDirOverride
    ? path.resolve(agentDirOverride === '~' ? os.homedir() : agentDirOverride)
    : path.join(os.homedir(), '.pi', 'agent')
  return path.join(agentDir, 'sessions')
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}
