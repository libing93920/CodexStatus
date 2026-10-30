import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { Dirent } from 'node:fs'
import type { CleanerSource } from '../../../shared/session-cleaner.ts'
import type { CatalogResult, CatalogSession } from './catalog-types.ts'
import {
  checkAbort,
  errorText,
  extractText,
  firstLines,
  nonempty,
  parseLine,
  string,
  tailText,
  time,
  truncate
} from './catalog-io.ts'
import { hermesWslTarget, readHermesWslScan, type HermesSqliteScan } from './catalog-hermes-wsl.ts'

const SQLITE_SESSION_LIMIT = 500
const SESSION_DIRECTORY = 'sessions'
const SQLITE_FILE = 'state.db'
const TAIL_BYTES = 16_384

export async function scanHermesCatalog(
  source: CleanerSource,
  signal?: AbortSignal
): Promise<CatalogResult> {
  const result: CatalogResult = { sessions: [], issues: [] }
  const databasePath = path.join(source.path, SQLITE_FILE)
  const wslPath = hermesWslTarget(databasePath)
  if (!wslPath) {
    try {
      const rootInfo = await lstat(source.path)
      if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
        result.issues.push({ path: source.path, message: 'Hermes 来源不是普通目录；未跟随链接' })
        return result
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        result.issues.push({ path: source.path, message: errorText(error) })
      return result
    }
  }

  let databaseSessions: CatalogSession[] = []
  try {
    const scan = wslPath
      ? await readHermesWslScan(databasePath, signal)
      : await readNativeSqliteScan(databasePath, signal)
    databaseSessions = projectSqliteSessions(scan, databasePath)
  } catch (error) {
    checkAbort(signal)
    result.issues.push({ path: databasePath, message: errorText(error) })
  }
  const jsonlSessions = await scanHermesJsonl(
    path.join(source.path, SESSION_DIRECTORY),
    result,
    signal
  )
  const databaseIds = new Set(databaseSessions.map((session) => session.sessionId))
  result.sessions.push(...databaseSessions)
  result.sessions.push(...jsonlSessions.filter((session) => !databaseIds.has(session.sessionId)))
  return result
}

async function readNativeSqliteScan(
  databasePath: string,
  signal?: AbortSignal
): Promise<HermesSqliteScan> {
  checkAbort(signal)
  try {
    const info = await lstat(databasePath)
    if (!info.isFile() || info.isSymbolicLink()) return emptySqliteScan()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptySqliteScan()
    throw error
  }
  checkAbort(signal)
  const { DatabaseSync } = await import('node:sqlite')
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const table = database
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'")
      .get()
    if (!table) return emptySqliteScan()
    const sessions = database
      .prepare(`SELECT * FROM sessions ORDER BY rowid DESC LIMIT ${SQLITE_SESSION_LIMIT}`)
      .all()
    const columns = new Set(
      (database.prepare('PRAGMA table_info(messages)').all() as Array<{ name?: unknown }>)
        .map((row) => row.name)
        .filter((name): name is string => typeof name === 'string')
    )
    return {
      sessions: sessions.map(object),
      first: readEdgeMessages(database, columns, 'MIN', "role = 'user'"),
      last: readEdgeMessages(
        database,
        columns,
        'MAX',
        "role IN ('user', 'assistant') AND content IS NOT NULL AND content != ''"
      )
    }
  } finally {
    database.close()
  }
}

function readEdgeMessages(
  database: { prepare(sql: string): { all(...values: unknown[]): unknown[] } },
  columns: Set<string>,
  pick: 'MIN' | 'MAX',
  condition: string
): Record<string, unknown>[] {
  if (columns.size === 0) return []
  const visible = !columns.has('active')
    ? ''
    : columns.has('compacted')
      ? ' AND (active=1 OR compacted=1)'
      : ' AND active=1'
  const sql = `
    SELECT m.session_id,m.content FROM messages m
    JOIN (SELECT session_id,${pick}(id) edge_id FROM messages
      WHERE ${condition}${visible}
        AND session_id IN (SELECT id FROM sessions ORDER BY rowid DESC LIMIT ${SQLITE_SESSION_LIMIT})
      GROUP BY session_id) f ON m.id=f.edge_id
  `
  return database.prepare(sql).all().map(object)
}

function projectSqliteSessions(scan: HermesSqliteScan, databasePath: string): CatalogSession[] {
  const first = edgeMessageMap(scan.first)
  const last = edgeMessageMap(scan.last)
  return scan.sessions.slice(0, SQLITE_SESSION_LIMIT).flatMap((row) => {
    const id = string(row.id)
    if (id === undefined) return []
    const firstText = first.get(id)
    const lastText = last.get(id)
    const rawTitle = string(row.title)
    const title = rawTitle && rawTitle.length ? rawTitle : firstText
    const createdAt = firstPresent(row, ['started_at', 'created_at'])
    const modifiedAt = sessionEndTime(row)
    const projectValue = firstPresent(row, ['cwd', 'directory'])
    const project =
      typeof projectValue === 'string' && projectValue.length ? projectValue : undefined
    const summary = lastText ?? firstText
    return [
      {
        sessionId: id,
        path: databasePath,
        ...(title !== undefined ? { title: truncate(title) } : {}),
        ...(summary !== undefined ? { summary: truncate(summary, 160) } : {}),
        ...(project !== undefined ? { project } : {}),
        createdAt: time(createdAt),
        modifiedAt: time(modifiedAt) ?? time(createdAt)
      }
    ]
  })
}

async function scanHermesJsonl(
  sessionsDirectory: string,
  result: CatalogResult,
  signal?: AbortSignal
): Promise<CatalogSession[]> {
  let entries: Dirent[]
  try {
    const info = await lstat(sessionsDirectory)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      result.issues.push({
        path: sessionsDirectory,
        message: 'Hermes 会话目录不是普通目录；未跟随链接'
      })
      return []
    }
    entries = await readdir(sessionsDirectory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      result.issues.push({ path: sessionsDirectory, message: errorText(error) })
    return []
  }
  const sessions: CatalogSession[] = []
  for (const entry of entries) {
    checkAbort(signal)
    if (!entry.isFile() || !['.jsonl', '.json'].includes(path.extname(entry.name))) continue
    const filePath = path.join(sessionsDirectory, entry.name)
    try {
      sessions.push(await readHermesJsonlSession(filePath, signal))
    } catch (error) {
      checkAbort(signal)
      result.issues.push({ path: filePath, message: errorText(error) })
    }
  }
  return sessions
}

async function readHermesJsonlSession(
  filePath: string,
  signal?: AbortSignal
): Promise<CatalogSession> {
  const head = await firstLines(filePath, 30, signal)
  const tail = (await tailText(filePath, TAIL_BYTES)).split(/\r?\n/)
  if (tail.at(-1) === '') tail.pop()
  const tailLines = tail.slice(-10)
  let firstUser: string | undefined
  let firstTimestamp: number | undefined
  let lastTimestamp: number | undefined
  let title: string | undefined
  let sessionId: string | undefined
  let project: string | undefined
  for (const line of head) {
    checkAbort(signal)
    if (!line.trim()) continue
    const record = parseLine(line)
    const timestamp = time(valueAt(record, ['timestamp', 'ts']))
    if (firstTimestamp === undefined) firstTimestamp = timestamp
    if (timestamp !== undefined) lastTimestamp = timestamp
    const recordType = string(record.type)
    if (recordType === 'session' || recordType === 'init') {
      sessionId ??= string(valueAt(record, ['id', 'sessionId']))
      title ??= nonempty(record.title)
      project ??= nonempty(valueAt(record, ['cwd', 'directory']))
    }
    if (firstUser === undefined) {
      const message = jsonlMessage(record)
      if (message?.role === 'user') firstUser = truncate(message.text)
    }
  }
  let tailTimestamp: number | undefined
  let lastMessage: string | undefined
  for (const line of [...tailLines].reverse()) {
    checkAbort(signal)
    if (!line.trim()) continue
    const record = parseLine(line)
    tailTimestamp ??= time(valueAt(record, ['timestamp', 'ts']))
    if (lastMessage === undefined) {
      const message = jsonlMessage(record)
      if (message && (message.role === 'user' || message.role === 'assistant'))
        lastMessage = truncate(message.text, 160)
    }
    if (tailTimestamp !== undefined && lastMessage !== undefined) break
  }
  const id = sessionId ?? path.basename(filePath, path.extname(filePath))
  return {
    sessionId: id,
    path: filePath,
    ...((title ?? firstUser) ? { title: title ?? firstUser } : {}),
    ...((lastMessage ?? firstUser) ? { summary: lastMessage ?? firstUser } : {}),
    ...(project ? { project } : {}),
    createdAt: firstTimestamp,
    modifiedAt: tailTimestamp ?? lastTimestamp ?? firstTimestamp
  }
}

function jsonlMessage(record: Record<string, unknown>): { role: string; text: string } | undefined {
  const nested = object(record.message)
  const rawRole = Object.prototype.hasOwnProperty.call(record, 'role') ? record.role : nested.role
  const role = string(rawRole)
  const content = Object.prototype.hasOwnProperty.call(record, 'content')
    ? record.content
    : nested.content
  if (!role || content === undefined) return undefined
  const text = extractText(content)
  return text.trim() ? { role, text } : undefined
}

function edgeMessageMap(rows: Record<string, unknown>[]): Map<string, string> {
  const result = new Map<string, string>()
  for (const row of rows) {
    const sessionId = string(row.session_id)
    const raw = string(row.content)
    if (!sessionId || raw === undefined) continue
    const text = decodeContent(raw)
    if (text.trim()) result.set(sessionId, text)
  }
  return result
}

function decodeContent(raw: string): string {
  if (!raw.startsWith('\0json:')) return raw
  try {
    return extractText(JSON.parse(raw.slice('\0json:'.length)))
  } catch {
    return raw
  }
}

function firstPresent(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) return record[key]
  }
  return undefined
}

function sessionEndTime(record: Record<string, unknown>): unknown {
  if (
    Object.prototype.hasOwnProperty.call(record, 'last_activity_at') &&
    record.last_activity_at !== null
  )
    return record.last_activity_at
  return firstPresent(record, ['ended_at', 'updated_at'])
}

function valueAt(record: Record<string, unknown>, keys: string[]): unknown {
  return firstPresent(record, keys)
}

function emptySqliteScan(): HermesSqliteScan {
  return { sessions: [], first: [], last: [] }
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
