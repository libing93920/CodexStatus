import { lstat, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { TextDecoder } from 'node:util'
import type { CleanerIssue, CleanerSource } from '../../../shared/session-cleaner.ts'
import { checkAbort, errorText, time, trimText, truncate } from './catalog-io.ts'
import type { CatalogResult, CatalogSession } from './catalog-types.ts'

const TITLE_MAX_CHARS = 160
const UTF8 = new TextDecoder('utf-8', { fatal: true })

type JsonRecord = Record<string, unknown>

/** Mirrors cc-switch v4.0.21 Gemini discovery: only tmp/<project>/chats is scanned. */
export async function scanGeminiCatalog(
  source: CleanerSource,
  signal?: AbortSignal
): Promise<CatalogResult> {
  const result: CatalogResult = { sessions: [], issues: [] }
  if (!(await isDirectory(source.path, result.issues, signal))) return result
  const projects = await readDirectory(source.path, result.issues, signal)

  for (const projectName of projects) {
    checkAbort(signal)
    const projectPath = path.join(source.path, projectName)
    if (!(await isDirectory(projectPath, result.issues, signal))) continue
    const chatsPath = path.join(projectPath, 'chats')
    if (!(await isDirectory(chatsPath, result.issues, signal))) continue

    const project = await readProjectRoot(projectPath, result.issues, signal)
    const chatFiles = await readDirectory(chatsPath, result.issues, signal)
    for (const fileName of chatFiles) {
      checkAbort(signal)
      const filePath = path.join(chatsPath, fileName)
      if (!(await isGeminiSessionFile(filePath))) continue
      const session = await readGeminiSession(filePath, result.issues, signal)
      if (session) result.sessions.push(project === undefined ? session : { ...session, project })
    }
  }

  return result
}

async function readDirectory(
  directory: string,
  issues: CleanerIssue[],
  signal?: AbortSignal
): Promise<string[]> {
  try {
    checkAbort(signal)
    return await readdir(directory)
  } catch (error) {
    checkAbort(signal)
    if (!isMissingPath(error)) issues.push({ path: directory, message: errorText(error) })
    return []
  }
}

async function isDirectory(
  directory: string,
  issues: CleanerIssue[],
  signal?: AbortSignal
): Promise<boolean> {
  try {
    checkAbort(signal)
    const info = await lstat(directory)
    if (info.isSymbolicLink()) {
      issues.push({ path: directory, message: '链接或 junction 保持只读，未跟随' })
      return false
    }
    return info.isDirectory()
  } catch (error) {
    checkAbort(signal)
    if (!isMissingPath(error)) issues.push({ path: directory, message: errorText(error) })
    return false
  }
}

async function readProjectRoot(
  projectPath: string,
  issues: CleanerIssue[],
  signal?: AbortSignal
): Promise<string | undefined> {
  const projectFile = path.join(projectPath, '.project_root')
  if (!(await isRegularFile(projectFile, issues, signal))) return undefined
  try {
    const value = await readFile(projectFile, { signal })
    return UTF8.decode(value)
  } catch {
    checkAbort(signal)
    return undefined
  }
}

async function isGeminiSessionFile(filePath: string): Promise<boolean> {
  const extension = path.extname(filePath)
  if (extension === '.jsonl') return true
  if (extension !== '.json') return false
  const legacySibling = path.join(
    path.dirname(filePath),
    `${path.basename(filePath, extension)}.jsonl`
  )
  try {
    await lstat(legacySibling)
    return false
  } catch {
    return true
  }
}

async function isRegularFile(
  filePath: string,
  issues: CleanerIssue[],
  signal?: AbortSignal
): Promise<boolean> {
  try {
    checkAbort(signal)
    const info = await lstat(filePath)
    if (info.isSymbolicLink()) {
      issues.push({ path: filePath, message: '链接或 junction 保持只读，未跟随' })
      return false
    }
    return info.isFile()
  } catch (error) {
    checkAbort(signal)
    if (!isMissingPath(error)) issues.push({ path: filePath, message: errorText(error) })
    return false
  }
}

async function readGeminiSession(
  filePath: string,
  issues: CleanerIssue[],
  signal?: AbortSignal
): Promise<CatalogSession | undefined> {
  if (!(await isRegularFile(filePath, issues, signal))) return undefined
  let document: JsonRecord | undefined
  try {
    const bytes = await readFile(filePath, { signal })
    document = parseSessionDocument(UTF8.decode(bytes))
  } catch (error) {
    checkAbort(signal)
    issues.push({ path: filePath, message: errorText(error) })
    return undefined
  }
  if (!document || typeof document.sessionId !== 'string') return undefined

  const createdAt = time(document.startTime)
  const modifiedAt = time(document.lastUpdated) ?? createdAt
  const title = titleFromMessages(document.messages)
  return {
    sessionId: document.sessionId,
    path: filePath,
    ...(title === undefined ? {} : { title, summary: title }),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(modifiedAt === undefined ? {} : { modifiedAt })
  }
}

function parseSessionDocument(text: string): JsonRecord | undefined {
  const whole = parseObject(text)
  if (whole) {
    if (!Object.hasOwn(whole, 'messages')) whole.messages = []
    return whole
  }

  const metadata: JsonRecord = Object.create(null) as JsonRecord
  const log = new GeminiMessageLog()
  let seenRecord = false
  for (const line of text.split(/\r?\n/)) {
    const record = parseObject(line)
    if (!record) continue
    seenRecord = true
    if (typeof record.$rewindTo === 'string') {
      log.rewindTo(record.$rewindTo)
    } else if (typeof record.id === 'string') {
      log.upsert(record)
    } else {
      const { $set, ...withoutSet } = record
      if (isRecord($set)) {
        const { messages, ...setMetadata } = $set
        if (Array.isArray(messages)) log.reset(messages)
        Object.assign(metadata, setMetadata)
      } else if (typeof withoutSet.sessionId === 'string') {
        const { messages, ...recordMetadata } = withoutSet
        if (Array.isArray(messages)) log.upsertAll(messages)
        Object.assign(metadata, recordMetadata)
      }
    }
  }
  if (!seenRecord) return undefined
  metadata.messages = log.messages
  return metadata
}

class GeminiMessageLog {
  readonly messages: unknown[] = []
  private readonly index = new Map<string, number>()

  upsert(value: unknown): void {
    if (!isRecord(value) || typeof value.id !== 'string') return
    const existing = this.index.get(value.id)
    if (existing === undefined) {
      this.index.set(value.id, this.messages.length)
      this.messages.push(value)
    } else {
      this.messages[existing] = value
    }
  }

  upsertAll(values: unknown[]): void {
    for (const value of values) this.upsert(value)
  }

  rewindTo(id: string): void {
    const length = this.index.get(id) ?? 0
    this.messages.length = length
    for (const [messageId, index] of this.index) {
      if (index >= length) this.index.delete(messageId)
    }
  }

  reset(values: unknown[]): void {
    this.messages.length = 0
    this.index.clear()
    this.upsertAll(values)
  }
}

function titleFromMessages(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  for (const message of value) {
    if (!isRecord(message) || message.type !== 'user') continue
    const text = geminiContentText(message.content)
    if (!isIgnoredUserText(text)) return truncate(text, TITLE_MAX_CHARS)
  }
  return undefined
}

function geminiContentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map((item) => (isRecord(item) && typeof item.text === 'string' ? item.text : undefined))
    .filter((text): text is string => text !== undefined)
    .join('\n')
}

function isIgnoredUserText(text: string): boolean {
  const trimmed = trimText(text)
  return (
    !trimmed ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('?') ||
    trimmed.startsWith('<session_context>') ||
    trimmed.startsWith('<hook_context>')
  )
}

function parseObject(text: string): JsonRecord | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isMissingPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}
