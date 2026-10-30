import { lstat } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import type { CleanerSourceKind } from '../../../shared/session-cleaner.ts'
import { normalizeManagedPath } from './managed-space-files.ts'
import { readOpenCodeSessionMetadata } from './managed-space-sqlite-metadata.ts'

const SESSION_V1 = 'session'
const SESSION_V2 = 'session_v2'
const MESSAGE_V1 = 'message'
const PART_V1 = 'part'
const MESSAGE_V2 = 'session_message'
const BLOB = 'blob'
const BLOB_REFERENCE = 'blob_ref'
const HERMES_SESSIONS = 'sessions'
const HERMES_MESSAGES = 'messages'
const MCODE_SESSIONS = 'local_runtime_sessions'
const MCODE_MIGRATIONS = 'local_runtime_message_row_migrations'
const MCODE_ROWS = 'local_runtime_message_rows'
const MCODE_MESSAGES = 'local_runtime_messages'
const BLOB_REFERENCE_COLUMNS = ['session_id', 'message_id', 'hash', 'seq']
const BLOB_COLUMNS = ['hash', 'mime', 'bytes', 'width', 'height', 'data', 'time_created']

export interface SqliteDatabaseReference {
  sourceId: string
  path: string
}

export interface SqliteSessionReference {
  key: string
  sourceId: string
  providerId: CleanerSourceKind
  databasePath: string
  sessionId: string
}

export interface SqliteSessionMeasurement {
  logicalBytes?: number
  sharedBytes?: number
  messageCount?: number
  modelIds?: string[]
  parentSessionId?: string
  complete: boolean
}

export interface SqliteMeasureResult {
  sessions: Map<string, SqliteSessionMeasurement>
  databaseFreeBytes: Map<string, number>
}

export async function measureSqliteDatabases(options: {
  databases: SqliteDatabaseReference[]
  sessions: SqliteSessionReference[]
  signal?: AbortSignal
  reportIssue: (sourceId: string, filePath: string, message: string) => void
}): Promise<SqliteMeasureResult> {
  const result: SqliteMeasureResult = {
    sessions: new Map(),
    databaseFreeBytes: new Map()
  }
  const referencesByDatabase = groupSessionsByDatabase(options.sessions)
  for (const databaseFile of uniqueDatabaseFiles(options.databases)) {
    if (options.signal?.aborted) break
    const key = databaseKey(databaseFile.sourceId, databaseFile.path)
    const references = referencesByDatabase.get(key) ?? []
    const inspected = await inspectDatabase({
      ...databaseFile,
      references,
      signal: options.signal,
      reportIssue: options.reportIssue
    })
    if (inspected.freeBytes !== undefined) {
      result.databaseFreeBytes.set(
        databaseFile.sourceId,
        (result.databaseFreeBytes.get(databaseFile.sourceId) ?? 0) + inspected.freeBytes
      )
    }
    for (const [sessionKey, measurement] of inspected.sessions)
      result.sessions.set(sessionKey, measurement)
  }
  for (const session of options.sessions) {
    if (!result.sessions.has(session.key)) result.sessions.set(session.key, { complete: false })
  }
  return result
}

async function inspectDatabase(options: {
  sourceId: string
  path: string
  references: SqliteSessionReference[]
  signal?: AbortSignal
  reportIssue: (sourceId: string, filePath: string, message: string) => void
}): Promise<{ sessions: Map<string, SqliteSessionMeasurement>; freeBytes?: number }> {
  const info = await lstat(options.path).catch(() => undefined)
  if (!info?.isFile() || info.isSymbolicLink()) {
    options.reportIssue(options.sourceId, options.path, 'SQLite 文件缺失或不是普通文件')
    return failedSessions(options.references)
  }
  let database: DatabaseSync | undefined
  try {
    const { DatabaseSync: SqliteDatabase } = await import('node:sqlite')
    database = new SqliteDatabase(options.path, { readOnly: true })
    const tables = readTableNames(database)
    const freeBytes = readDatabaseFreeBytes(database)
    const hasV2 = tables.has(SESSION_V2) && tables.has(MESSAGE_V2)
    const hasV1 = tables.has(SESSION_V1) && tables.has(MESSAGE_V1) && tables.has(PART_V1)

    const sessions = new Map<string, SqliteSessionMeasurement>()
    for (const reference of options.references) {
      if (options.signal?.aborted) break
      const measurement = await measureSession({
        database,
        tables,
        reference,
        hasV1,
        hasV2
      })
      sessions.set(reference.key, measurement)
      if (!measurement.complete)
        options.reportIssue(
          options.sourceId,
          options.path,
          'SQLite 会话载荷归属不完整，逻辑字节数未知'
        )
    }
    return { sessions, freeBytes }
  } catch {
    options.reportIssue(options.sourceId, options.path, 'SQLite 只读载荷统计失败')
    return failedSessions(options.references)
  } finally {
    database?.close()
  }
}

async function measureSession(options: {
  database: DatabaseSync
  tables: Set<string>
  reference: SqliteSessionReference
  hasV1: boolean
  hasV2: boolean
}): Promise<SqliteSessionMeasurement> {
  if (options.reference.providerId === 'hermes')
    return measureHermesSession(options.database, options.tables, options.reference.sessionId)
  if (options.reference.providerId === 'mcode')
    return measureMCodeSession(options.database, options.tables, options.reference.sessionId)
  if (options.reference.providerId !== 'opencode') return { complete: false }
  const { database, tables, reference, hasV1, hasV2 } = options
  const hasV2Session = hasV2 && sessionRowExists(database, SESSION_V2, reference.sessionId)
  const hasV1Session = hasV1 && sessionRowExists(database, SESSION_V1, reference.sessionId)
  const schema = hasV2Session ? 'v2' : hasV1Session ? 'v1' : undefined
  if (!schema) return { complete: false }
  const payloadTables = schema === 'v2' ? [MESSAGE_V2] : [MESSAGE_V1, PART_V1]
  let logicalBytes = 0
  for (const table of payloadTables) {
    if (!tables.has(table)) return { complete: false }
    const bytes = await payloadBytes(database, table, reference.sessionId)
    if (bytes === undefined) return { complete: false }
    logicalBytes += bytes
  }
  const blobs = measureSessionBlobs(database, tables, reference.sessionId)
  if (!blobs.complete) return { complete: false }
  logicalBytes += blobs.exclusiveBytes
  if (!Number.isSafeInteger(logicalBytes)) return { complete: false }
  const messageCount =
    schema === 'v2'
      ? countV2Messages(database, reference.sessionId)
      : countV1Messages(database, reference.sessionId)
  const metadata = readOpenCodeSessionMetadata(database, schema, reference.sessionId)
  return {
    logicalBytes,
    sharedBytes: blobs.sharedBytes,
    ...(messageCount === undefined ? {} : { messageCount }),
    ...metadata,
    complete: true
  }
}

function measureHermesSession(
  database: DatabaseSync,
  tables: Set<string>,
  sessionId: string
): SqliteSessionMeasurement {
  if (!tables.has(HERMES_SESSIONS) || !tables.has(HERMES_MESSAGES)) return { complete: false }
  const sessionColumns = tableColumns(database, HERMES_SESSIONS)
  const messageColumns = tableColumns(database, HERMES_MESSAGES)
  if (
    !sessionColumns.has('id') ||
    !['id', 'session_id', 'role', 'content'].every((column) => messageColumns.has(column)) ||
    !sessionRowExists(database, HERMES_SESSIONS, sessionId)
  )
    return { complete: false }
  const payloadColumns = [
    'content',
    'tool_call_id',
    'tool_calls',
    'tool_name',
    'display_metadata',
    'reasoning'
  ].filter((column) => messageColumns.has(column))
  const payload = payloadColumns
    .map((column) => `COALESCE(length(CAST(${quoteIdentifier(column)} AS BLOB)),0)`)
    .join(' + ')
  const row = database
    .prepare(
      `SELECT COALESCE(SUM(${payload}),0) AS bytes, COUNT(*) AS count ` +
        `FROM ${quoteIdentifier(HERMES_MESSAGES)} WHERE session_id=?`
    )
    .get(sessionId) as { bytes?: unknown; count?: unknown } | undefined
  return measuredPayload(row)
}

function measureMCodeSession(
  database: DatabaseSync,
  tables: Set<string>,
  sessionId: string
): SqliteSessionMeasurement {
  if (
    ![MCODE_SESSIONS, MCODE_MIGRATIONS, MCODE_ROWS, MCODE_MESSAGES].every((table) =>
      tables.has(table)
    )
  )
    return { complete: false }
  const sessionColumns = tableColumns(database, MCODE_SESSIONS)
  const migrationColumns = tableColumns(database, MCODE_MIGRATIONS)
  const rowColumns = tableColumns(database, MCODE_ROWS)
  const legacyColumns = tableColumns(database, MCODE_MESSAGES)
  if (
    !sessionColumns.has('session_id') ||
    !migrationColumns.has('session_id') ||
    !['session_id', 'role', 'data_json'].every((column) => rowColumns.has(column)) ||
    !['session_id', 'display_messages_json'].every((column) => legacyColumns.has(column)) ||
    !sessionRowExists(database, MCODE_SESSIONS, sessionId)
  )
    return { complete: false }
  return sessionRowExists(database, MCODE_MIGRATIONS, sessionId)
    ? measureMCodeRows(database, sessionId)
    : measureMCodeLegacyMessages(database, sessionId)
}

function measureMCodeRows(database: DatabaseSync, sessionId: string): SqliteSessionMeasurement {
  const row = database
    .prepare(
      `SELECT COALESCE(SUM(length(CAST(data_json AS BLOB))),0) AS bytes, COUNT(*) AS count ` +
        `FROM ${quoteIdentifier(MCODE_ROWS)} WHERE session_id=? AND role IN ('user','assistant')`
    )
    .get(sessionId) as { bytes?: unknown; count?: unknown } | undefined
  return measuredPayload(row)
}

function measureMCodeLegacyMessages(
  database: DatabaseSync,
  sessionId: string
): SqliteSessionMeasurement {
  const row = database
    .prepare(
      `SELECT COALESCE(SUM(length(CAST(message.value AS BLOB))),0) AS bytes, COUNT(*) AS count ` +
        `FROM ${quoteIdentifier(MCODE_MESSAGES)} AS legacy, ` +
        `json_each(legacy.display_messages_json) AS message ` +
        `WHERE legacy.session_id=? AND json_extract(message.value,'$.role') IN ('user','assistant')`
    )
    .get(sessionId) as { bytes?: unknown; count?: unknown } | undefined
  return measuredPayload(row)
}

function measuredPayload(
  row: { bytes?: unknown; count?: unknown } | undefined
): SqliteSessionMeasurement {
  const logicalBytes = toSafeInteger(row?.bytes)
  const messageCount = toSafeInteger(row?.count)
  if (logicalBytes === undefined || messageCount === undefined) return { complete: false }
  return { logicalBytes, messageCount, sharedBytes: 0, complete: true }
}
interface BlobSizeMeasurement {
  exclusiveBytes: number
  sharedBytes: number
  complete: boolean
}

function measureSessionBlobs(
  database: DatabaseSync,
  tables: Set<string>,
  sessionId: string
): BlobSizeMeasurement {
  const hasBlobTable = tables.has(BLOB)
  const hasReferenceTable = tables.has(BLOB_REFERENCE)
  if (!hasBlobTable && !hasReferenceTable)
    return { exclusiveBytes: 0, sharedBytes: 0, complete: true }
  if (!hasBlobTable || !hasReferenceTable)
    return { exclusiveBytes: 0, sharedBytes: 0, complete: false }
  const referenceColumns = tableColumns(database, BLOB_REFERENCE)
  const blobColumns = tableColumns(database, BLOB)
  if (
    !BLOB_REFERENCE_COLUMNS.every((column) => referenceColumns.has(column)) ||
    !BLOB_COLUMNS.every((column) => blobColumns.has(column))
  )
    return { exclusiveBytes: 0, sharedBytes: 0, complete: false }
  return sumSessionBlobs(database, sessionId)
}

function sumSessionBlobs(database: DatabaseSync, sessionId: string): BlobSizeMeasurement {
  const dataBytes =
    `CASE typeof(blobs.data) WHEN 'text' THEN length(CAST(blobs.data AS BLOB)) ` +
    `WHEN 'blob' THEN length(blobs.data) ELSE NULL END`
  const rows = database
    .prepare(
      `SELECT refs.hash AS hash, COUNT(DISTINCT all_refs.session_id) AS owners, ` +
        `blobs.bytes AS bytes, ${dataBytes} AS data_bytes ` +
        `FROM (SELECT DISTINCT hash FROM ${quoteIdentifier(BLOB_REFERENCE)} WHERE session_id=?) refs ` +
        `LEFT JOIN ${quoteIdentifier(BLOB)} blobs ON blobs.hash=refs.hash ` +
        `LEFT JOIN ${quoteIdentifier(BLOB_REFERENCE)} all_refs ON all_refs.hash=refs.hash ` +
        'GROUP BY refs.hash'
    )
    .all(sessionId) as Array<{
    hash?: unknown
    owners?: unknown
    bytes?: unknown
    data_bytes?: unknown
  }>
  let exclusiveBytes = 0
  let sharedBytes = 0
  for (const row of rows) {
    const bytes = toSafeInteger(row.bytes)
    const measuredBytes = toSafeInteger(row.data_bytes)
    const ownerCount = toSafeInteger(row.owners)
    if (
      typeof row.hash !== 'string' ||
      !row.hash ||
      bytes === undefined ||
      measuredBytes !== bytes ||
      ownerCount === undefined ||
      ownerCount < 1
    )
      return { exclusiveBytes: 0, sharedBytes: 0, complete: false }
    if (ownerCount > 1) sharedBytes += bytes
    else exclusiveBytes += bytes
    if (!Number.isSafeInteger(sharedBytes) || !Number.isSafeInteger(exclusiveBytes))
      return { exclusiveBytes: 0, sharedBytes: 0, complete: false }
  }
  return { exclusiveBytes, sharedBytes, complete: true }
}
function groupSessionsByDatabase(
  sessions: SqliteSessionReference[]
): Map<string, SqliteSessionReference[]> {
  const result = new Map<string, SqliteSessionReference[]>()
  for (const session of sessions) {
    const key = databaseKey(session.sourceId, session.databasePath)
    const group = result.get(key) ?? []
    group.push(session)
    result.set(key, group)
  }
  return result
}
function uniqueDatabaseFiles(databases: SqliteDatabaseReference[]): SqliteDatabaseReference[] {
  const unique = new Map<string, SqliteDatabaseReference>()
  for (const database of databases)
    unique.set(databaseKey(database.sourceId, database.path), database)
  return [...unique.values()]
}

function databaseKey(sourceId: string, filePath: string): string {
  return `${sourceId}\0${normalizeManagedPath(filePath)}`
}

function readTableNames(database: DatabaseSync): Set<string> {
  const rows = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as Array<{ name?: unknown }>
  return new Set(rows.flatMap((row) => (typeof row.name === 'string' ? [row.name] : [])))
}

function sessionRowExists(database: DatabaseSync, table: string, sessionId: string): boolean {
  const idColumn =
    table === MCODE_SESSIONS || table === MCODE_MIGRATIONS
      ? 'session_id'
      : [SESSION_V1, SESSION_V2, HERMES_SESSIONS].includes(table)
        ? 'id'
        : undefined
  if (!idColumn || !tableColumns(database, table).has(idColumn)) return false
  const row = database
    .prepare(
      `SELECT 1 AS present FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(idColumn)}=? LIMIT 1`
    )
    .get(sessionId)
  return row !== undefined
}
async function payloadBytes(
  database: DatabaseSync,
  table: string,
  sessionId: string
): Promise<number | undefined> {
  if (![MESSAGE_V1, PART_V1, MESSAGE_V2].includes(table)) return undefined
  const columns = tableColumns(database, table)
  if (!columns.has('session_id') || !columns.has('data')) return undefined
  const data = quoteIdentifier('data')
  const expression =
    `CASE typeof(${data}) WHEN 'text' THEN length(CAST(${data} AS BLOB)) ` +
    `WHEN 'blob' THEN length(${data}) ELSE 0 END`
  const row = database
    .prepare(
      `SELECT COALESCE(SUM(${expression}),0) AS bytes ` +
        `FROM ${quoteIdentifier(table)} WHERE session_id=?`
    )
    .get(sessionId) as { bytes?: unknown } | undefined
  return toSafeInteger(row?.bytes)
}

function countV1Messages(database: DatabaseSync, sessionId: string): number | undefined {
  return countRows(database, MESSAGE_V1, sessionId)
}

function countV2Messages(database: DatabaseSync, sessionId: string): number | undefined {
  if (!tableColumns(database, MESSAGE_V2).has('type')) return undefined
  const row = database
    .prepare(
      `SELECT COUNT(*) AS count FROM ${quoteIdentifier(MESSAGE_V2)} ` +
        "WHERE session_id=? AND type IN ('user','assistant','system')"
    )
    .get(sessionId) as { count?: unknown } | undefined
  return toSafeInteger(row?.count)
}

function countRows(database: DatabaseSync, table: string, sessionId: string): number | undefined {
  if (
    ![MESSAGE_V1, PART_V1, MESSAGE_V2].includes(table) ||
    !tableColumns(database, table).has('session_id')
  )
    return undefined
  const row = database
    .prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)} WHERE session_id=?`)
    .get(sessionId) as { count?: unknown } | undefined
  return toSafeInteger(row?.count)
}

function tableColumns(database: DatabaseSync, table: string): Set<string> {
  if (
    ![
      SESSION_V1,
      SESSION_V2,
      MESSAGE_V1,
      PART_V1,
      MESSAGE_V2,
      BLOB,
      BLOB_REFERENCE,
      HERMES_SESSIONS,
      HERMES_MESSAGES,
      MCODE_SESSIONS,
      MCODE_MIGRATIONS,
      MCODE_ROWS,
      MCODE_MESSAGES
    ].includes(table)
  )
    throw new Error('SQLite 表名不在白名单')
  const rows = database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{
    name?: unknown
  }>
  return new Set(rows.flatMap((row) => (typeof row.name === 'string' ? [row.name] : [])))
}

function readDatabaseFreeBytes(database: DatabaseSync): number | undefined {
  const pageSize = pragmaInteger(database, 'page_size')
  const freePages = pragmaInteger(database, 'freelist_count')
  if (pageSize === undefined || freePages === undefined) return undefined
  const bytes = pageSize * freePages
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined
}

function pragmaInteger(database: DatabaseSync, pragma: string): number | undefined {
  if (pragma !== 'page_size' && pragma !== 'freelist_count') return undefined
  const row = database.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined
  const value = row && Object.values(row)[0]
  return toSafeInteger(value)
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}

function toSafeInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value === 'bigint' && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER))
    return Number(value)
  return undefined
}

function failedSessions(references: SqliteSessionReference[]): {
  sessions: Map<string, SqliteSessionMeasurement>
  freeBytes?: number
} {
  return {
    sessions: new Map(references.map((reference) => [reference.key, { complete: false }]))
  }
}
