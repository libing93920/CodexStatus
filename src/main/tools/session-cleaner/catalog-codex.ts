import { lstat, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parse } from 'smol-toml'
import type { CleanerIssue, CleanerSource } from '../../../shared/session-cleaner.ts'
import type { CatalogResult, CatalogSession } from './catalog-types.ts'
import {
  basename,
  checkAbort,
  collectFiles,
  errorText,
  extractText,
  headTail,
  nonempty,
  object,
  parseLine,
  string,
  time,
  trimText,
  truncate
} from './catalog-io.ts'

const UUID_PATTERN = /[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/i
const STATE_DATABASE = 'state_5.sqlite'
const BUSY_TIMEOUT_MS = 2000
const IDE_CONTEXT = '# Context from my IDE setup:'
const REQUEST_MARKER = 'my request for codex'

export async function scanCodexCatalog(
  source: CleanerSource,
  signal?: AbortSignal
): Promise<CatalogResult> {
  const result: CatalogResult = { sessions: [], issues: [] }
  const files = await collectFiles({
    root: source.path,
    issues: result.issues,
    signal,
    accept: (file) => file.endsWith('.jsonl') || file.endsWith('.jsonl.zst')
  })
  const plain = new Set(files.filter((file) => !file.endsWith('.zst')))
  const titles = await loadCodexTitles(configDirectory(source.path), result.issues)
  for (const file of files) {
    checkAbort(signal)
    if (file.endsWith('.zst') && plain.has(file.slice(0, -4))) continue
    try {
      const session = await parseCodexSession(file, signal)
      if (!session) continue
      const title = titles.get(session.sessionId)
      if (title !== undefined) session.title = truncate(title)
      result.sessions.push(session)
    } catch (error) {
      checkAbort(signal)
      result.issues.push({ path: file, message: errorText(error) })
    }
  }
  return result
}

function configDirectory(root: string): string {
  let directory = path.resolve(root)
  while (path.dirname(directory) !== directory) {
    if (['sessions', 'archived_sessions'].includes(path.basename(directory)))
      return path.dirname(directory)
    directory = path.dirname(directory)
  }
  return path.dirname(root)
}

async function parseCodexSession(
  file: string,
  signal?: AbortSignal
): Promise<CatalogSession | undefined> {
  const { head, tail } = await headTail(file, signal)
  const session: Partial<CatalogSession> = { path: file }
  let firstUser: string | undefined
  for (const line of head) {
    const record = parseLine(line)
    session.createdAt ??= time(record.timestamp)
    const payload = object(record.payload)
    if (record.type === 'session_meta') {
      if ('subagent' in object(payload.source)) return undefined
      session.sessionId ??= string(payload.id)
      session.project ??= string(payload.cwd)
      session.createdAt ??= time(payload.timestamp)
    }
    if (
      !firstUser &&
      record.type === 'response_item' &&
      payload.type === 'message' &&
      payload.role === 'user'
    )
      firstUser = userTitle(extractText(payload.content))
    if (
      session.sessionId !== undefined &&
      session.project !== undefined &&
      session.createdAt !== undefined &&
      firstUser !== undefined
    )
      break
  }
  for (const line of tail.reverse()) {
    const record = parseLine(line)
    session.modifiedAt ??= time(record.timestamp)
    const payload = object(record.payload)
    if (
      session.summary === undefined &&
      record.type === 'response_item' &&
      payload.type === 'message'
    ) {
      const text = extractText(payload.content)
      if (text.trim()) session.summary = truncate(text, 160)
    }
    if (session.modifiedAt !== undefined && session.summary !== undefined) break
  }
  if (file.endsWith('.zst')) session.modifiedAt ??= (await lstat(file)).mtimeMs
  session.sessionId ??= path.basename(file).match(UUID_PATTERN)?.[0]
  if (session.sessionId === undefined) return undefined
  session.title = firstUser === undefined ? basename(session.project) : truncate(firstUser)
  return session as CatalogSession
}

function userTitle(text: string): string | undefined {
  const trimmed = trimText(text)
  if (!trimmed || trimmed.startsWith('# AGENTS.md') || trimmed.startsWith('<environment_context>'))
    return undefined
  if (!trimmed.startsWith(IDE_CONTEXT)) return trimmed
  const lines = trimmed.replace(/\r\n/g, '\n').split('\n')
  let prompt: string | undefined
  for (const [index, line] of lines.entries()) {
    const inline = headingPayload(line)
    if (inline !== undefined)
      prompt = nonempty(inline) ?? nonempty(lines.slice(index + 1).join('\n'))
  }
  return prompt
}

function headingPayload(line: string): string | undefined {
  const trimmed = trimText(line)
  if (!trimmed.startsWith('#')) return undefined
  const heading = trimText(trimmed.replace(/^#+/, ''))
  const lowered = heading.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
  if (!lowered.startsWith(REQUEST_MARKER)) return undefined
  const suffix = trimText(heading.slice(REQUEST_MARKER.length))
  if (!suffix) return ''
  if (!':：-—'.includes(suffix[0])) return undefined
  return trimText(suffix.replace(/^[\p{White_Space}:：—-]+/u, ''))
}

export async function loadCodexTitles(
  directory: string,
  issues: CleanerIssue[]
): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  const indexPath = path.join(directory, 'session_index.jsonl')
  try {
    for (const line of (await readFile(indexPath, 'utf8')).split('\n')) {
      const entry = parseLine(line)
      const id = nonempty(entry.id)
      const title = nonempty(entry.thread_name)
      if (id && title) titles.set(id, title)
    }
  } catch (error) {
    reportReadError(indexPath, error, issues)
  }
  const databasePaths = await codexDatabasePaths(directory, issues)
  for (const databasePath of databasePaths) readDatabaseTitles(databasePath, titles, issues)
  return titles
}

async function codexDatabasePaths(directory: string, issues: CleanerIssue[]): Promise<string[]> {
  let configured: string | undefined
  const configPath = path.join(directory, 'config.toml')
  try {
    configured = nonempty(parse(await readFile(configPath, 'utf8')).sqlite_home)
  } catch (error) {
    reportReadError(configPath, error, issues)
  }
  configured ??= nonempty(process.env.CODEX_SQLITE_HOME)
  const paths = [path.join(directory, STATE_DATABASE)]
  if (configured) {
    const expanded = configured.replace(/^~(?=$|[\\/])/, os.homedir())
    paths.push(path.resolve(expanded, STATE_DATABASE))
  }
  return [...new Set(paths)]
}

function readDatabaseTitles(
  databasePath: string,
  titles: Map<string, string>,
  issues: CleanerIssue[]
): void {
  if (/^\\\\wsl(?:\$|\.localhost)[\\/]/i.test(databasePath)) return
  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(databasePath, { readOnly: true })
    database.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`)
    const rows = database
      .prepare(
        "SELECT id, title FROM threads WHERE title <> '' AND (first_user_message IS NULL OR TRIM(title) <> TRIM(first_user_message))"
      )
      .all()
    for (const row of rows) {
      const id = nonempty(row.id)
      const title = nonempty(row.title)
      if (id && title) titles.set(id, title)
    }
  } catch (error) {
    // 不存在的状态库是正常情况；其他错误必须可见，避免名称无声消失。
    if (!String(error).includes('unable to open database file'))
      issues.push({ path: databasePath, message: `Codex 标题读取失败：${errorText(error)}` })
  } finally {
    database?.close()
  }
}

function reportReadError(file: string, error: unknown, issues: CleanerIssue[]): void {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
    issues.push({ path: file, message: errorText(error) })
}
