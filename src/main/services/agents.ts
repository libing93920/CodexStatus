// Agent 工具 provider 抽象:统一"本地扫描 → 事件级 token 用量"的接口。
// v1 只做本地扫描出用量/花费,不涉及 billing/官方额度/重置卡/雷达。
// 注:codex 的扫描逻辑仍在 usage.ts 内(其解析与累计差值/重放去重深度耦合),此处注册表只放 claude/opencode。
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentId } from '../../shared/capsule'
import { collectJsonlFiles, getNonNegativeNumber, getRecord, getString, parseJsonObject } from './quota'

/** 单次用量增量的五分量 token 计数 */
export interface TokenUsage {
  input: number
  cachedInput: number
  output: number
  reasoning: number
  total: number
}

/** 一条可归桶的事件级用量;costUsd 存在时跳过按价目估算(OpenCode 直接给成本) */
export interface UsageEvent {
  ts: number
  model?: string
  tokens: TokenUsage
  costUsd?: number
}

export interface AgentProvider {
  id: AgentId
  label: string
  /** 扫描近 30 天用量为事件级明细;内部各自实现,抛错由调用方兜底为空数组 */
  scanRecentEvents(): Promise<UsageEvent[]>
}

export const AGENT_PROVIDERS: Partial<Record<AgentId, AgentProvider>> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    scanRecentEvents: scanClaudeEvents
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    scanRecentEvents: scanOpenCodeEvents
  }
}

// —— Claude Code 解析器 ——
const CLAUDE_SCAN_WINDOW_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

// Claude 的 message.usage 每消息独立、非累计,各 API 请求只计一次 → 直接求和,无需重放去重。
async function scanClaudeEvents(): Promise<UsageEvent[]> {
  const projectsDir = resolveClaudeProjectsDir()
  if (!(await pathExists(projectsDir))) {
    return []
  }
  const files = await collectJsonlFiles(projectsDir, Number.MAX_SAFE_INTEGER)
  const cutoff = Date.now() - CLAUDE_SCAN_WINDOW_DAYS * DAY_MS
  const events: UsageEvent[] = []
  for (const file of files) {
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
      const event = parseClaudeAssistantEvent(rawLine)
      if (event) {
        events.push(event)
      }
    }
  }
  return events
}

// 解析一条 assistant 消息:取 message.usage 五分量 + 顶层 timestamp(ISO) + message.model。
// cache_creation 与 cache_read 一并并入 cachedInput(v1 不细分两者计费差异)。
function parseClaudeAssistantEvent(rawLine: string): UsageEvent | undefined {
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
    ts,
    model: getString(message?.model),
    tokens: { input, cachedInput, output: outputTokens, reasoning: 0, total: input + outputTokens }
  }
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

// OpenCode 存 SQLite(session 表每会话聚合 tokens_* + cost),非 JSONL。
// cost 为 0 时(自定义 provider 未计价/免费模型)不直接给 costUsd,回落按价目估算。
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
        'SELECT time_updated, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, cost, model FROM session WHERE time_updated >= ?'
      )
      .all(cutoff)
    const events: UsageEvent[] = []
    for (const row of rows) {
      const event = mapOpenCodeRow(row)
      if (event) {
        events.push(event)
      }
    }
    return events
  } finally {
    db.close()
  }
}

function mapOpenCodeRow(row: Record<string, unknown>): UsageEvent | undefined {
  const tokensInput = toNumber(row.tokens_input)
  const tokensOutput = toNumber(row.tokens_output)
  const tokensReasoning = toNumber(row.tokens_reasoning)
  const cachedInput = toNumber(row.tokens_cache_read) + toNumber(row.tokens_cache_write)
  const input = tokensInput + cachedInput
  // OpenCode 的 tokens_output 不含 reasoning(实测 reasoning 可 > output),相加才是总输出
  const output = tokensOutput + tokensReasoning
  if (input === 0 && output === 0) {
    return undefined
  }
  const event: UsageEvent = {
    ts: toNumber(row.time_updated),
    model: extractOpenCodeModelId(row.model),
    tokens: { input, cachedInput, output, reasoning: tokensReasoning, total: input + output }
  }
  const cost = toNumber(row.cost)
  if (cost > 0) {
    event.costUsd = cost
  }
  return event
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

// OpenCode 的 model 列是 JSON 字符串(如 {"id":"...","providerID":"..."}),取 id 供价目查询
function extractOpenCodeModelId(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) {
    return undefined
  }
  if (!raw.startsWith('{')) {
    return raw
  }
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    return typeof obj.id === 'string' ? obj.id : undefined
  } catch {
    return raw
  }
}

// OpenCode 数据目录:遵循 XDG,默认 ~/.local/share/opencode/opencode.db
function resolveOpenCodeDbPath(): string {
  const dataHome = process.env.XDG_DATA_HOME?.trim()
  const base = dataHome
    ? path.resolve(dataHome === '~' ? os.homedir() : dataHome)
    : path.join(os.homedir(), '.local', 'share')
  return path.join(base, 'opencode', 'opencode.db')
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}
