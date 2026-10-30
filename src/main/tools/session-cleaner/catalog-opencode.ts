import { lstat } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CleanerIssue, CleanerSource } from '../../../shared/session-cleaner.ts'
import type { CatalogResult, CatalogSession } from './catalog-types.ts'
import {
  basename,
  checkAbort,
  collectFiles,
  errorText,
  readJson,
  object,
  string,
  time,
  truncate
} from './catalog-io.ts'

export async function scanOpenCodeCatalog(
  source: CleanerSource,
  signal?: AbortSignal
): Promise<CatalogResult> {
  const result: CatalogResult = { sessions: [], issues: [] }
  const info = await lstat(source.path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  if (info?.isSymbolicLink()) throw new Error('OpenCode 来源链接或 junction 未跟随')
  const base = info?.isFile() ? path.dirname(source.path) : source.path
  const database =
    source.databasePath ?? (info?.isFile() ? source.path : path.join(base, 'opencode.db'))
  const sqlite = await readSqliteSessions(database, result.issues)
  const sqliteIds = new Set(sqlite.map((session) => session.sessionId))
  result.sessions.push(...sqlite)
  const storage = path.join(base, 'storage')
  const files = await collectFiles({
    root: path.join(storage, 'session'),
    signal,
    issues: result.issues,
    accept: (file) => file.endsWith('.json')
  })
  for (const file of files) {
    checkAbort(signal)
    try {
      const value = await readJson(file)
      const id = string(value.id)
      if (id === undefined || sqliteIds.has(id)) continue
      const directory = string(value.directory)
      const clock = object(value.time)
      const title = string(value.title) || undefined
      result.sessions.push({
        sessionId: id,
        path: file,
        title: title ?? basename(directory),
        project: directory,
        summary: title ?? (await firstUserSummary(storage, id, signal)),
        createdAt: time(clock.created),
        modifiedAt: time(clock.updated) ?? time(clock.created)
      })
    } catch (error) {
      result.issues.push({ path: file, message: errorText(error) })
    }
  }
  return result
}

async function firstUserSummary(
  storage: string,
  id: string,
  signal?: AbortSignal
): Promise<string | undefined> {
  const messageRoot = boundedChild(path.join(storage, 'message'), id)
  if (!messageRoot) return undefined
  const files = await collectFiles({
    root: messageRoot,
    accept: (file) => file.endsWith('.json'),
    issues: [],
    signal
  })
  const messages: Array<{ id: string; timestamp: number }> = []
  for (const file of files) {
    const record = await readJson(file).catch(() => undefined)
    if (record?.role === 'user' && typeof record.id === 'string')
      messages.push({ id: record.id, timestamp: time(object(record.time).created) ?? 0 })
  }
  const first = messages.sort((a, b) => a.timestamp - b.timestamp)[0]
  const partRoot = first && boundedChild(path.join(storage, 'part'), first.id)
  if (!partRoot) return undefined
  const parts = await collectFiles({
    root: partRoot,
    accept: (file) => file.endsWith('.json'),
    issues: [],
    signal
  })
  const texts: string[] = []
  for (const file of parts) {
    const part = await readJson(file).catch(() => undefined)
    if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim())
      texts.push(part.text)
    if (part?.type === 'tool')
      texts.push(`[Tool: ${string(part.name) ?? string(part.tool) ?? 'unknown'}]`)
  }
  const text = texts.join('\n')
  return text.trim() ? truncate(text, 160) : undefined
}

function boundedChild(root: string, id: string): string | undefined {
  const child = path.resolve(root, id)
  const relative = path.relative(root, child)
  return relative &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
    ? child
    : undefined
}

async function readSqliteSessions(file: string, issues: CleanerIssue[]): Promise<CatalogSession[]> {
  try {
    if (!(await lstat(file)).isFile()) return []
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      issues.push({ path: file, message: errorText(error) })
    return []
  }
  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(file, { readOnly: true })
    const has = (table: string): boolean =>
      Boolean(
        database!.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
      )
    if (!has('session_v2') || !has('session_message')) return queryV1(database, file)
    const rows = database
      .prepare(
        `SELECT s.id, COALESCE(s.title, '') AS title, s.directory, s.time_created,
       MAX(s.time_updated, COALESCE(MAX(m.time_updated), s.time_updated)) AS time_updated
       FROM session_v2 s LEFT JOIN session_message m ON m.session_id=s.id
       GROUP BY s.id ORDER BY time_updated DESC`
      )
      .all()
    if (has('session') && has('kv')) {
      const marker = database
        .prepare(
          "SELECT max(coalesce(time_created,0),coalesce(time_updated,0)) AS stamp FROM kv WHERE key='migration.v1-v2'"
        )
        .get()?.stamp
      if (typeof marker === 'number' && marker > 0)
        rows.push(
          ...database
            .prepare(
              `SELECT id, COALESCE(title, '') AS title, directory, time_created, time_updated FROM session
         WHERE NOT EXISTS (SELECT 1 FROM session_v2 WHERE session_v2.id=session.id) AND time_updated>?
         ORDER BY time_updated DESC`
            )
            .all(marker)
        )
    }
    return rows
      .map((row) => rowSession(row, file))
      .sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0))
  } catch (error) {
    issues.push({ path: file, message: `OpenCode 会话查询失败：${errorText(error)}` })
    return []
  } finally {
    database?.close()
  }
}

function queryV1(database: DatabaseSync, file: string): CatalogSession[] {
  return database
    .prepare(
      "SELECT id, COALESCE(title,'') AS title, directory, time_created, time_updated FROM session ORDER BY time_updated DESC"
    )
    .all()
    .map((row) => rowSession(row, file))
}

function rowSession(row: Record<string, unknown>, file: string): CatalogSession {
  const directory = string(row.directory) ?? ''
  const title = string(row.title) ?? ''
  return {
    sessionId: string(row.id)!,
    path: file,
    title: title.trim() ? title : basename(directory),
    summary: title.trim() ? title : basename(directory),
    project: directory || undefined,
    createdAt: Number(row.time_created),
    modifiedAt: Number(row.time_updated)
  }
}
