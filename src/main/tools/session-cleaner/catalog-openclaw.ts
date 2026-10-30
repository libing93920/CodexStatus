import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { Dirent } from 'node:fs'
import type { CleanerSource } from '../../../shared/session-cleaner.ts'
import type { CatalogResult, CatalogSession } from './catalog-types.ts'
import {
  basename,
  checkAbort,
  errorText,
  extractText,
  headTail,
  readJson,
  string,
  time,
  truncate
} from './catalog-io.ts'

export async function scanOpenClawCatalog(
  source: CleanerSource,
  signal?: AbortSignal
): Promise<CatalogResult> {
  const result: CatalogResult = { sessions: [], issues: [] }
  const agents = await readDirectory(source.path, result, signal)
  for (const agent of agents) {
    checkAbort(signal)
    if (!agent.isDirectory()) continue
    const sessionsDir = path.join(source.path, agent.name, 'sessions')
    const entries = await readDirectory(sessionsDir, result, signal)
    const names = await readDisplayNames(sessionsDir, result, signal)
    for (const entry of entries) {
      checkAbort(signal)
      if (!entry.isFile() || path.extname(entry.name) !== '.jsonl') continue
      const filePath = path.join(sessionsDir, entry.name)
      try {
        result.sessions.push(await readOpenClawSession(filePath, names, signal))
      } catch (error) {
        checkAbort(signal)
        result.issues.push({ path: filePath, message: errorText(error) })
      }
    }
  }
  return result
}

async function readDirectory(
  directory: string,
  result: CatalogResult,
  signal?: AbortSignal
): Promise<Dirent[]> {
  checkAbort(signal)
  try {
    const info = await lstat(directory)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      result.issues.push({ path: directory, message: 'OpenClaw 来源不是普通目录；未跟随链接' })
      return []
    }
    return await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      result.issues.push({ path: directory, message: errorText(error) })
    return []
  }
}

async function readDisplayNames(
  sessionsDir: string,
  result: CatalogResult,
  signal?: AbortSignal
): Promise<Map<string, string>> {
  checkAbort(signal)
  const indexPath = path.join(sessionsDir, 'sessions.json')
  try {
    const info = await lstat(indexPath)
    if (info.isSymbolicLink() || !info.isFile()) return new Map()
    const index = await readJson(indexPath)
    const names = new Map<string, string>()
    for (const value of Object.values(index)) {
      const entry = object(value)
      const id = string(entry.sessionId)
      const name = entry.displayName
      if (id !== undefined && typeof name === 'string' && name.length) names.set(id, name)
    }
    return names
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      result.issues.push({ path: indexPath, message: errorText(error) })
    return new Map()
  }
}

async function readOpenClawSession(
  filePath: string,
  displayNames: Map<string, string>,
  signal?: AbortSignal
): Promise<CatalogSession> {
  const { head, tail } = await headTail(filePath, signal)
  let sessionId: string | undefined
  let cwd: string | undefined
  let createdAt: number | undefined
  let summary: string | undefined
  let firstUser: string | undefined
  for (const line of head) {
    checkAbort(signal)
    const record = parseRecord(line)
    if (createdAt === undefined) createdAt = time(record.timestamp)
    if (record.type === 'session') {
      sessionId ??= string(record.id)
      cwd ??= string(record.cwd)
      createdAt ??= time(record.timestamp)
    }
    if (record.type === 'message') {
      const message = object(record.message)
      const text = stripMessageId(extractText(message.content))
      if (text.trim()) {
        summary ??= text.trim()
        if (!firstUser && message.role === 'user') firstUser = text.trim()
      }
    }
    if (sessionId && cwd && createdAt && summary && firstUser) break
  }
  let modifiedAt: number | undefined
  for (const line of [...tail].reverse()) {
    checkAbort(signal)
    modifiedAt = time(parseRecord(line).timestamp)
    if (modifiedAt !== undefined) break
  }
  const id = sessionId ?? path.basename(filePath, path.extname(filePath))
  const title = displayNames.get(id) ?? firstUser ?? (cwd ? basename(cwd) : undefined)
  return {
    sessionId: id,
    path: filePath,
    ...(title !== undefined ? { title: truncate(title) } : {}),
    ...(summary ? { summary: truncate(summary, 160) } : {}),
    ...(cwd ? { project: cwd } : {}),
    createdAt,
    modifiedAt: modifiedAt ?? createdAt
  }
}

function stripMessageId(text: string): string {
  const index = text.lastIndexOf('\n[message_id:')
  return index >= 0 ? text.slice(0, index).trimEnd() : text
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function parseRecord(line: string): Record<string, unknown> {
  try {
    return object(JSON.parse(line))
  } catch {
    return {}
  }
}
