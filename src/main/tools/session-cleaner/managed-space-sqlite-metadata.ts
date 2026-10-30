import type { DatabaseSync } from 'node:sqlite'

type OpenCodeSchema = 'v1' | 'v2'

interface OpenCodeSessionMetadata {
  modelIds: string[]
  parentSessionId?: string
}

const SESSION_TABLES: Record<OpenCodeSchema, string> = {
  v1: 'session',
  v2: 'session_v2'
}
const MESSAGE_TABLES: Record<OpenCodeSchema, string> = {
  v1: 'message',
  v2: 'session_message'
}
const SESSION_ID_COLUMN = 'session_id'
const PARENT_ID_COLUMN = 'parent_id'
const MODEL_ID_EXPRESSION =
  'CASE WHEN json_valid(data) THEN CASE ' +
  "WHEN json_type(data, '$.modelID') = 'text' THEN json_extract(data, '$.modelID') " +
  "WHEN json_type(data, '$.model.id') = 'text' THEN json_extract(data, '$.model.id') " +
  "WHEN json_type(data, '$.model') = 'text' THEN json_extract(data, '$.model') " +
  'END END'

export function readOpenCodeSessionMetadata(
  database: DatabaseSync,
  schema: OpenCodeSchema,
  sessionId: string
): OpenCodeSessionMetadata {
  const parentSessionId = readParentSessionId(database, SESSION_TABLES[schema], sessionId)
  return {
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    modelIds: readOpenCodeModelIds(database, MESSAGE_TABLES[schema], sessionId)
  }
}

function readParentSessionId(
  database: DatabaseSync,
  sessionTable: string,
  sessionId: string
): string | undefined {
  const columns = tableColumns(database, sessionTable)
  if (!columns.has('id') || !columns.has(PARENT_ID_COLUMN)) return undefined
  const row = database
    .prepare('SELECT parent_id FROM ' + sessionTable + ' WHERE id=?')
    .get(sessionId) as { parent_id?: unknown } | undefined
  return getString(row?.parent_id)
}

function readOpenCodeModelIds(
  database: DatabaseSync,
  messageTable: string,
  sessionId: string
): string[] {
  const columns = tableColumns(database, messageTable)
  if (!columns.has(SESSION_ID_COLUMN) || !columns.has('data')) return []
  const rows = database
    .prepare(
      'SELECT DISTINCT ' +
        MODEL_ID_EXPRESSION +
        ' AS model_id FROM ' +
        messageTable +
        ' WHERE session_id=?'
    )
    .all(sessionId) as Array<{ model_id?: unknown }>
  const modelIds = new Set<string>()
  for (const row of rows) {
    const modelId = getString(row.model_id)
    if (modelId) modelIds.add(modelId)
  }
  return [...modelIds].sort()
}

function tableColumns(database: DatabaseSync, table: string): Set<string> {
  const rows = database.prepare('PRAGMA table_info(' + table + ')').all() as Array<{
    name?: unknown
  }>
  return new Set(rows.flatMap((row) => (typeof row.name === 'string' ? [row.name] : [])))
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
