import { lstat, readdir, realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { Dirent } from 'node:fs'
import type { CleanerSource } from '../../../shared/session-cleaner.ts'
import type { CatalogResult, CatalogSession } from './catalog-types.ts'
import {
  checkAbort,
  errorText,
  parseLine,
  readUtf8Lines,
  string,
  time,
  truncate
} from './catalog-io.ts'

const SUMMARY_DATABASE = 'conversation_summaries.db'
const TRANSCRIPT_RELATIVE_PATH = ['.system_generated', 'logs', 'transcript_full.jsonl']
const SUMMARY_QUERY = `
  SELECT conversation_id, title, workspace_uris, preview, last_modified_time
  FROM conversation_summaries
`

interface AgySummary {
  session: CatalogSession
}

export async function scanAgyCatalog(
  source: CleanerSource,
  signal?: AbortSignal
): Promise<CatalogResult> {
  const result: CatalogResult = { sessions: [], issues: [] }
  const databasePath = path.join(path.dirname(source.path), SUMMARY_DATABASE)
  const summaries = await readSummaries(databasePath, result, signal)
  let entries: Dirent[] = []
  try {
    entries = await readdir(source.path, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      result.issues.push({ path: source.path, message: errorText(error) })
  }

  const canonicalRoot = await canonical(source.path)
  for (const entry of entries) {
    checkAbort(signal)
    if (!entry.isDirectory() || !validSessionId(entry.name)) continue
    const transcriptPath = path.join(source.path, entry.name, ...TRANSCRIPT_RELATIVE_PATH)
    const canonicalTranscript = await containedTranscript(transcriptPath, canonicalRoot, result)
    if (!canonicalTranscript) continue
    const stored = summaries.get(entry.name)
    const catalog =
      stored?.session ?? (await readTranscriptSession(entry.name, transcriptPath, result, signal))
    if (!catalog) continue
    summaries.delete(entry.name)
    result.sessions.push({ ...catalog, path: transcriptPath })
  }

  for (const [sessionId, summary] of [...summaries.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    checkAbort(signal)
    result.sessions.push({ ...summary.session, sessionId, path: databasePath })
  }
  return result
}

async function readSummaries(
  databasePath: string,
  result: CatalogResult,
  signal?: AbortSignal
): Promise<Map<string, AgySummary>> {
  const summaries = new Map<string, AgySummary>()
  checkAbort(signal)
  try {
    const info = await lstat(databasePath)
    if (!info.isFile() || info.isSymbolicLink()) return summaries
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return summaries
    result.issues.push({ path: databasePath, message: errorText(error) })
    return summaries
  }

  let database: { prepare(sql: string): { all(): unknown[] }; close(): void }
  try {
    const { DatabaseSync } = await import('node:sqlite')
    database = new DatabaseSync(databasePath, { readOnly: true }) as typeof database
  } catch (error) {
    result.issues.push({ path: databasePath, message: errorText(error) })
    return summaries
  }
  try {
    for (const value of database.prepare(SUMMARY_QUERY).all()) {
      checkAbort(signal)
      const row = object(value)
      const id = string(row.conversation_id)
      const title = string(row.title)
      const uris = string(row.workspace_uris)
      const preview = string(row.preview)
      const modified = string(row.last_modified_time)
      if (
        id === undefined ||
        title === undefined ||
        uris === undefined ||
        preview === undefined ||
        modified === undefined
      )
        continue
      if (!validSessionId(id)) continue
      summaries.set(id, {
        session: {
          sessionId: id,
          path: databasePath,
          ...(title.length ? { title } : {}),
          ...(preview.length ? { summary: truncate(preview, 160) } : {}),
          ...(firstWorkspace(uris) ? { project: firstWorkspace(uris) } : {}),
          modifiedAt: parseAgyDate(modified)
        }
      })
    }
  } catch (error) {
    checkAbort(signal)
    result.issues.push({ path: databasePath, message: errorText(error) })
    summaries.clear()
  } finally {
    database.close()
  }
  return summaries
}

async function readTranscriptSession(
  sessionId: string,
  transcriptPath: string,
  result: CatalogResult,
  signal?: AbortSignal
): Promise<CatalogSession | undefined> {
  const records = new Map<number, Record<string, unknown>>()
  const lines = readUtf8Lines(transcriptPath, signal)
  try {
    for await (const line of lines) {
      checkAbort(signal)
      const record = parseLine(line)
      const index = record.step_index
      if (typeof index === 'number' && Number.isSafeInteger(index) && index >= 0)
        records.set(index, record)
    }
  } catch (error) {
    checkAbort(signal)
    result.issues.push({ path: transcriptPath, message: errorText(error) })
    return undefined
  } finally {
    await lines.return(undefined)
  }
  const ordered = [...records.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, record]) => record)
  const firstInput = ordered.find(
    (record) => record.type === 'USER_INPUT' && typeof record.content === 'string'
  )
  const prompt = firstInput ? userRequest(firstInput.content as string) : undefined
  const timestamps = ordered
    .map(agyTimestamp)
    .filter((value): value is number => value !== undefined)
  return {
    sessionId,
    path: transcriptPath,
    ...(prompt ? { title: truncate(prompt) } : {}),
    ...(prompt ? { summary: truncate(prompt, 160) } : {}),
    createdAt: timestamps[0],
    modifiedAt: timestamps.length ? Math.max(...timestamps) : undefined
  }
}

async function containedTranscript(
  transcriptPath: string,
  canonicalRoot: string | undefined,
  result: CatalogResult
): Promise<string | undefined> {
  if (!canonicalRoot) return undefined
  try {
    const info = await lstat(transcriptPath)
    if (!info.isFile() || info.isSymbolicLink()) return undefined
    const target = await realpath(transcriptPath)
    const relative = path.relative(canonicalRoot, target)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      return undefined
    return target
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      result.issues.push({ path: transcriptPath, message: errorText(error) })
    return undefined
  }
}

async function canonical(filePath: string): Promise<string | undefined> {
  try {
    return await realpath(filePath)
  } catch {
    return undefined
  }
}

function userRequest(content: string): string {
  const start = content.indexOf('<USER_REQUEST>')
  const end = start < 0 ? -1 : content.indexOf('</USER_REQUEST>', start + '<USER_REQUEST>'.length)
  const prompt =
    start >= 0 && end >= 0
      ? content.slice(start + '<USER_REQUEST>'.length, end).trim()
      : content.trim()
  return prompt || content.trim()
}

function agyTimestamp(record: Record<string, unknown>): number | undefined {
  for (const key of ['created_at', 'timestamp', 'updated_at']) {
    if (Object.prototype.hasOwnProperty.call(record, key)) return time(record[key])
  }
  return undefined
}

function firstWorkspace(raw: string): string | undefined {
  try {
    const values: unknown = JSON.parse(raw)
    if (!Array.isArray(values) || typeof values[0] !== 'string') return undefined
    const url = new URL(values[0])
    return url.protocol === 'file:' ? fileURLToPath(url) : undefined
  } catch {
    return undefined
  }
}

function parseAgyDate(value: string): number | undefined {
  const parsed = time(value)
  if (parsed !== undefined) return parsed
  const match = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(?:\.(\d+))?$/.exec(value)
  if (!match) return undefined
  const fraction = (match[3] ?? '').padEnd(3, '0').slice(0, 3)
  const utc = `${match[1]}T${match[2]}${fraction ? `.${fraction}` : ''}Z`
  const timestamp = Date.parse(utc)
  return Number.isFinite(timestamp) ? timestamp : undefined
}

function validSessionId(value: string): boolean {
  return /^[A-Za-z0-9-]+$/.test(value)
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
