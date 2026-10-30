import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { CleanerSource } from '../../../shared/session-cleaner.ts'
import type { CatalogResult, CatalogSession } from './catalog-types.ts'
import {
  basename,
  checkAbort,
  collectFiles,
  errorText,
  extractText,
  nonempty,
  object,
  readUtf8Lines,
  string,
  time,
  truncate
} from './catalog-io.ts'

const MAX_SESSION_BYTES = 128 * 1024 * 1024
const MAX_TREE_ENTRIES = 500_000
const MAX_ID_BYTES = 256

interface PiSummary {
  explicitName?: string
  explicitNameSeen?: boolean
  firstUser?: string
  lastMessage?: string
  lastActive?: number
}

export async function scanPiCatalog(
  source: CleanerSource,
  signal?: AbortSignal,
  dialect: 'pi' | 'omp' = 'pi'
): Promise<CatalogResult> {
  const result: CatalogResult = { sessions: [], issues: [] }
  if (source.unavailable) {
    result.issues.push({ path: source.path, message: source.note })
    return result
  }
  const depth = source.layout === 'flat' ? 1 : 2
  const files = await collectFiles({
    root: source.path,
    issues: result.issues,
    signal,
    accept: (file) =>
      file.endsWith('.jsonl') && path.relative(source.path, file).split(path.sep).length === depth
  })
  for (const file of files) {
    checkAbort(signal)
    try {
      if ((await lstat(file)).size > MAX_SESSION_BYTES) continue
      result.sessions.push(await readPiSession(file, signal, dialect))
    } catch (error) {
      checkAbort(signal)
      result.issues.push({ path: file, message: errorText(error) })
    }
  }
  return result
}

async function readPiSession(
  file: string,
  signal: AbortSignal | undefined,
  dialect: 'pi' | 'omp'
): Promise<CatalogSession> {
  const lines = readUtf8Lines(file, signal)
  let header: Record<string, unknown> | undefined
  let entryCount = 0
  const summary: PiSummary = {}
  try {
    for await (const line of lines) {
      checkAbort(signal)
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        continue
      }
      const record = object(value)
      if (!header) {
        if (dialect === 'omp' && record.type === 'title') {
          summary.explicitName = nonempty(record.title)
          summary.explicitNameSeen = true
          continue
        }
        validateHeader(record)
        if (dialect === 'omp' && !summary.explicitNameSeen)
          summary.explicitName = nonempty(record.title)
        header = record
        continue
      }
      if (++entryCount > MAX_TREE_ENTRIES)
        throw new Error(`Pi 会话超过 ${MAX_TREE_ENTRIES} 条记录限制`)
      updateSummary(summary, record)
    }
  } finally {
    await lines.return(undefined)
  }
  if (!header) throw new Error('Pi 会话缺少有效会话头')
  const project = string(header.cwd) ?? ''
  return {
    sessionId: string(header.id)!,
    path: await realpath(file),
    title:
      summary.explicitName ?? (summary.firstUser ? truncate(summary.firstUser) : basename(project)),
    summary: summary.lastMessage ? truncate(summary.lastMessage, 160) : undefined,
    project: project.trim() ? project : undefined,
    createdAt: time(header.timestamp),
    modifiedAt: summary.lastActive ?? time(header.timestamp)
  }
}

function validateHeader(record: Record<string, unknown>): void {
  const id = string(record.id)
  if (
    record.type !== 'session' ||
    !id ||
    Buffer.byteLength(id) > MAX_ID_BYTES ||
    !/^[a-z\d](?:[a-z\d_.-]*[a-z\d])?$/i.test(id)
  )
    throw new Error('Pi 会话头身份无效')
  if (record.version === 0) throw new Error('Pi 会话版本 0 不受支持')
}

function updateSummary(summary: PiSummary, record: Record<string, unknown>): void {
  if (record.type === 'session_info') {
    summary.explicitName = nonempty(record.name)
    summary.explicitNameSeen = true
    return
  }
  if (record.type !== 'message') return
  const message = object(record.message)
  if (message.role !== 'user' && message.role !== 'assistant') return
  const content = extractText(message.content)
  if (!content.trim()) return
  const timestamp = time(message.timestamp) ?? time(record.timestamp)
  if (timestamp !== undefined)
    summary.lastActive = Math.max(summary.lastActive ?? timestamp, timestamp)
  if (message.role === 'user') summary.firstUser ??= content
  summary.lastMessage = content
}
