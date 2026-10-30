// Agent 工具 provider 抽象:统一"本地扫描 → 事件级 token 用量"的接口。
// v1 只做本地扫描出用量/花费,不涉及 billing/官方额度/重置卡/雷达。
// 注:codex 与 claude 的扫描逻辑已迁到 usage.ts 做增量(incrementalScanCodex/incrementalScanClaude),
// 此处注册表只剩 opencode(SQLite 无文件粒度增量,走全量查询)。
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
  /** 来源消息身份;OpenCode 同时带规范化数据库路径,用于跨副本去重 */
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
export async function parseClaudeFile(
  filePath: string,
  options?: { throwOnReadError: boolean }
): Promise<UsageEvent[]> {
  let content: string
  try {
    content = await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if (options?.throwOnReadError) throw error
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
export const OPENCODE_SCAN_WINDOW_MS = OPENCODE_SCAN_WINDOW_DAYS * DAY_MS
const OPENCODE_V1_SESSION_TABLE = 'session'
const OPENCODE_V1_MESSAGE_TABLE = 'message'
const OPENCODE_V2_SESSION_TABLE = 'session_v2'
const OPENCODE_V2_MESSAGE_TABLE = 'session_message'
const OPENCODE_MIGRATION_TABLE = 'kv'
const OPENCODE_MIGRATION_KEY = 'migration.v1-v2'

type OpenCodeSchema = 'v1' | 'v2'
type OpenCodeMessageRow = Record<string, unknown>

// SQLite 按已完成的 assistant 消息统计。V2 优先；混合库只补入迁移标记后未迁入 V2 的 V1 会话。
// 日常统计维持消息创建时间 30 天窗口，单会话留存读取完整历史。
export async function scanOpenCodeEvents(
  cutoffMs = Date.now() - OPENCODE_SCAN_WINDOW_MS
): Promise<UsageEvent[]> {
  const dbPath = resolveOpenCodeDbPath()
  if (!(await pathExists(dbPath))) return []
  let database: DatabaseSync
  try {
    // 懒加载 node:sqlite:旧 Electron 无此内置模块时仅 OpenCode 不可用,不拖垮整 app
    const { DatabaseSync } = await import('node:sqlite')
    database = new DatabaseSync(dbPath, { readOnly: true })
  } catch {
    return []
  }
  try {
    return readOpenCodeDatabaseEvents(database, dbPath, cutoffMs)
  } finally {
    database.close()
  }
}

export async function readOpenCodeDatabaseUsage(
  dbPath: string,
  cutoffMs: number
): Promise<UsageEvent[]> {
  const database = await openOpenCodeDatabase(dbPath)
  try {
    return readOpenCodeDatabaseEvents(database, dbPath, cutoffMs)
  } finally {
    database.close()
  }
}

export async function readOpenCodeSessionUsage(
  dbPath: string,
  sessionId: string
): Promise<UsageEvent[]> {
  if (!sessionId.trim()) throw new Error('OpenCode 会话缺少 sessionId')
  const database = await openOpenCodeDatabase(dbPath)
  try {
    const schema = detectOpenCodeSchema(database)
    if (schema === 'v1') {
      if (!hasOpenCodeSession(database, OPENCODE_V1_SESSION_TABLE, sessionId))
        throw new Error('OpenCode SQLite 中不存在指定的 V1 会话')
      return parseOpenCodeRows(queryOpenCodeRows(database, schema, { sessionId }), dbPath, true)
    }
    if (hasOpenCodeSession(database, OPENCODE_V2_SESSION_TABLE, sessionId))
      return parseOpenCodeRows(queryOpenCodeRows(database, schema, { sessionId }), dbPath, true)
    const migrationStamp = getOpenCodeMigrationStamp(database)
    if (migrationStamp === undefined || !hasMigratedV1Session(database, sessionId, migrationStamp))
      throw new Error('OpenCode SQLite 中不存在指定的 V2 或迁移后 V1 会话')
    return parseOpenCodeRows(
      queryOpenCodeRows(database, 'v1', { sessionId, migrationStamp }),
      dbPath,
      true
    )
  } finally {
    database.close()
  }
}

export function normalizeOpenCodeDatabasePath(dbPath: string): string {
  const normalized = path.resolve(dbPath).replace(/\\/g, '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function createOpenCodeMessageIdentity(dbPath: string, messageId: string): string {
  return `opencode:${normalizeOpenCodeDatabasePath(dbPath)}:${messageId}`
}

export function createOpenCodeSessionRetentionKey(dbPath: string, sessionId: string): string {
  return `opencode:${normalizeOpenCodeDatabasePath(dbPath)}:${sessionId}`
}

async function openOpenCodeDatabase(dbPath: string): Promise<DatabaseSync> {
  let info: Awaited<ReturnType<typeof fs.stat>>
  try {
    info = await fs.stat(dbPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error('OpenCode 会话数据库不存在')
    throw error
  }
  if (!info.isFile()) throw new Error('OpenCode 会话数据库不是普通文件')
  const { DatabaseSync } = await import('node:sqlite')
  return new DatabaseSync(dbPath, { readOnly: true })
}

function readOpenCodeDatabaseEvents(
  database: DatabaseSync,
  dbPath: string,
  cutoffMs: number
): UsageEvent[] {
  if (!Number.isFinite(cutoffMs)) throw new Error('OpenCode 用量窗口无效')
  const schema = detectOpenCodeSchema(database)
  const events = parseOpenCodeRows(queryOpenCodeRows(database, schema, { cutoffMs }), dbPath, false)
  if (schema !== 'v2') return events
  const migrationStamp = getOpenCodeMigrationStamp(database)
  if (migrationStamp === undefined) return events
  events.push(
    ...parseOpenCodeRows(
      queryOpenCodeRows(database, 'v1', { cutoffMs, migrationStamp }),
      dbPath,
      false
    )
  )
  return events.sort((left, right) => left.ts - right.ts)
}

function detectOpenCodeSchema(database: DatabaseSync): OpenCodeSchema {
  const hasV2 =
    hasOpenCodeTable(database, OPENCODE_V2_SESSION_TABLE) &&
    hasOpenCodeTable(database, OPENCODE_V2_MESSAGE_TABLE)
  if (hasV2) {
    requireOpenCodeColumns(database, OPENCODE_V2_SESSION_TABLE, ['id'])
    requireOpenCodeColumns(database, OPENCODE_V2_MESSAGE_TABLE, [
      'id',
      'session_id',
      'type',
      'data',
      'time_created'
    ])
    return 'v2'
  }
  if (
    hasOpenCodeTable(database, OPENCODE_V1_SESSION_TABLE) &&
    hasOpenCodeTable(database, OPENCODE_V1_MESSAGE_TABLE)
  ) {
    requireOpenCodeColumns(database, OPENCODE_V1_SESSION_TABLE, ['id'])
    requireOpenCodeColumns(database, OPENCODE_V1_MESSAGE_TABLE, [
      'id',
      'session_id',
      'data',
      'time_created'
    ])
    return 'v1'
  }
  throw new Error('OpenCode SQLite 缺少已验证的 V1 或 V2 会话表结构')
}

function hasOpenCodeTable(database: DatabaseSync, table: string): boolean {
  return Boolean(
    database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
  )
}

function requireOpenCodeColumns(database: DatabaseSync, table: string, required: string[]): void {
  const columns = new Set(
    database
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((column) => getString((column as Record<string, unknown>).name))
  )
  if (required.some((column) => !columns.has(column)))
    throw new Error(`OpenCode SQLite ${table} 表缺少已验证列`)
}

function getOpenCodeMigrationStamp(database: DatabaseSync): number | undefined {
  const legacyTables = [
    OPENCODE_V1_SESSION_TABLE,
    OPENCODE_V1_MESSAGE_TABLE,
    OPENCODE_MIGRATION_TABLE
  ]
  if (!legacyTables.every((table) => hasOpenCodeTable(database, table))) return undefined
  requireOpenCodeColumns(database, OPENCODE_V1_SESSION_TABLE, ['id', 'time_updated'])
  requireOpenCodeColumns(database, OPENCODE_V1_MESSAGE_TABLE, [
    'id',
    'session_id',
    'data',
    'time_created'
  ])
  requireOpenCodeColumns(database, OPENCODE_MIGRATION_TABLE, [
    'key',
    'time_created',
    'time_updated'
  ])
  const row = database
    .prepare(
      `SELECT max(coalesce(time_created,0),coalesce(time_updated,0)) AS stamp
       FROM ${OPENCODE_MIGRATION_TABLE} WHERE key=?`
    )
    .get(OPENCODE_MIGRATION_KEY) as Record<string, unknown> | undefined
  const stamp = getNonNegativeNumber(row?.stamp)
  return stamp && stamp > 0 ? stamp : undefined
}

function hasOpenCodeSession(database: DatabaseSync, table: string, sessionId: string): boolean {
  return Boolean(database.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(sessionId))
}

function hasMigratedV1Session(
  database: DatabaseSync,
  sessionId: string,
  migrationStamp: number
): boolean {
  return Boolean(
    database
      .prepare(
        `SELECT 1 FROM ${OPENCODE_V1_SESSION_TABLE} s
         WHERE s.id=? AND s.time_updated>? AND NOT EXISTS (
           SELECT 1 FROM ${OPENCODE_V2_SESSION_TABLE} v2 WHERE v2.id=s.id
         )`
      )
      .get(sessionId, migrationStamp)
  )
}

function queryOpenCodeRows(
  database: DatabaseSync,
  schema: OpenCodeSchema,
  options: { sessionId?: string; cutoffMs?: number; migrationStamp?: number }
): OpenCodeMessageRow[] {
  const isV2 = schema === 'v2'
  const sessionTable = isV2 ? OPENCODE_V2_SESSION_TABLE : OPENCODE_V1_SESSION_TABLE
  const messageTable = isV2 ? OPENCODE_V2_MESSAGE_TABLE : OPENCODE_V1_MESSAGE_TABLE
  const filters: string[] = []
  if (isV2) filters.push("m.type IN ('assistant','compaction')")
  // 留存读取仍核对全部 V1 行，不能因统计过滤而漏掉损坏记录。
  else if (options.sessionId === undefined)
    filters.push(`CASE WHEN json_valid(m.data) THEN
           json_extract(m.data, '$.role') = 'assistant'
           AND json_extract(m.data, '$.tokens') IS NOT NULL
           AND json_extract(m.data, '$.time.completed') IS NOT NULL
         ELSE 1 END`)
  const parameters: Array<string | number> = []
  if (options.sessionId !== undefined) {
    filters.push('m.session_id=?')
    parameters.push(options.sessionId)
  }
  if (options.cutoffMs !== undefined) {
    filters.push('m.time_created>=?')
    parameters.push(options.cutoffMs)
  }
  if (options.migrationStamp !== undefined) {
    filters.push('s.time_updated>?')
    filters.push(`NOT EXISTS (SELECT 1 FROM ${OPENCODE_V2_SESSION_TABLE} v2 WHERE v2.id=s.id)`)
    parameters.push(options.migrationStamp)
  }
  const typeColumn = isV2 ? 'm.type' : 'NULL AS type'
  const order = options.sessionId === undefined ? '' : 'ORDER BY m.time_created, m.id'
  return database
    .prepare(
      `SELECT m.id, m.data, ${typeColumn}
       FROM ${messageTable} m JOIN ${sessionTable} s ON s.id=m.session_id
       WHERE ${filters.join(' AND ')}
       ${order}`
    )
    .all(...parameters) as OpenCodeMessageRow[]
}

function parseOpenCodeRows(
  rows: OpenCodeMessageRow[],
  dbPath: string,
  strict: boolean
): UsageEvent[] {
  const events: UsageEvent[] = []
  const messageIdentityPrefix = `opencode:${normalizeOpenCodeDatabasePath(dbPath)}:`
  for (const row of rows) {
    const rawData = getString(row.data)
    const data = rawData ? parseJsonObject(rawData) : undefined
    if (!data) {
      if (strict) throw new Error('OpenCode message.data 不是有效 JSON')
      continue
    }
    const type = getString(row.type)
    assertOpenCodeTimestamp(data, type, strict)
    const event = parseOpenCodeData(data, type)
    if (!event) continue
    const messageId = getString(row.id)
    if (!messageId) throw new Error('OpenCode 用量消息缺少 id，不能安全去重')
    events.push({ ...event, messageId: messageIdentityPrefix + messageId })
  }
  return events
}

function assertOpenCodeTimestamp(
  data: Record<string, unknown>,
  type: string | undefined,
  strict: boolean
): void {
  if (!strict || !hasCompletedOpenCodeUsage(data, type) || !hasPositiveOpenCodeTokens(data)) return
  const time = getRecord(data.time)
  if ((getNonNegativeNumber(time?.created) ?? 0) <= 0)
    throw new Error('OpenCode 已完成用量消息缺少有效创建时间')
}

function hasCompletedOpenCodeUsage(
  data: Record<string, unknown>,
  type: string | undefined
): boolean {
  if (!getRecord(data.tokens)) return false
  if (type === 'compaction') {
    return ['completed', 'failed'].includes(getString(data.status) ?? '')
  }
  if (type === 'assistant' || (type === undefined && getString(data.role) === 'assistant')) {
    return getNonNegativeNumber(getRecord(data.time)?.completed) !== undefined
  }
  return false
}

function hasPositiveOpenCodeTokens(data: Record<string, unknown>): boolean {
  const tokens = getRecord(data.tokens)
  const cache = getRecord(tokens?.cache)
  return [tokens?.input, tokens?.output, tokens?.reasoning, cache?.read, cache?.write].some(
    (value) => (getNonNegativeNumber(value) ?? 0) > 0
  )
}

function parseOpenCodeData(
  data: Record<string, unknown> | undefined,
  messageType?: string
): UsageEvent | undefined {
  const tokens = data ? getRecord(data.tokens) : undefined
  const time = data ? getRecord(data.time) : undefined
  const isV2Type = messageType === 'assistant' || messageType === 'compaction'
  const isAssistant = isV2Type || getString(data?.role) === 'assistant'
  const isCompleted =
    messageType === 'compaction'
      ? ['completed', 'failed'].includes(getString(data?.status) ?? '')
      : getNonNegativeNumber(time?.completed) !== undefined
  if (!data || !tokens || !time || !isAssistant || !isCompleted) return undefined
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
  if ((input === 0 && output === 0) || ts === 0) return undefined
  const event: UsageEvent = {
    ts,
    model: getString(data.modelID) ?? getString(getRecord(data.model)?.id) ?? getString(data.model),
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
  if (cost > 0) event.costUsd = cost
  return event
}

// 解析 opencode message.data JSON 为事件;fields 与 cc-switch 一致:
// tokens.input 为非缓存输入,cache.read/write 分桶;tokens.output 不含 reasoning。
export function parseOpenCodeMessage(
  dataRaw: string | undefined,
  messageType?: string
): UsageEvent | undefined {
  return parseOpenCodeData(dataRaw ? parseJsonObject(dataRaw) : undefined, messageType)
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
