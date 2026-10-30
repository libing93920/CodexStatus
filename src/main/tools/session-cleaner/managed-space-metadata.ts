import { readFile } from 'node:fs/promises'
import { TextDecoder } from 'node:util'
import path from 'node:path'
import type { CleanerSourceKind } from '../../../shared/session-cleaner.ts'

import { readUtf8Lines } from './catalog-io.ts'
import { addManagedPathOwner, normalizeManagedPath } from './managed-space-files.ts'
import type {
  ManagedSpaceFile,
  ManagedSpaceIssueReporter,
  ManagedSpaceSessionState,
  ManagedSpaceSourceState
} from './managed-space.ts'

const MAX_JSON_METADATA_BYTES = 1024 * 1024
const UTF8 = new TextDecoder('utf-8', { fatal: true })
const SESSION_ID_FIELDS = ['sessionID', 'sessionId', 'session_id']
const MODEL_FIELDS = ['model', 'modelID', 'modelId', 'model_id']
const PARENT_SESSION_FIELDS = ['parentSessionId', 'parent_session_id']

type JsonObject = Record<string, unknown>
type OpenCodeFileKind = 'session' | 'message' | 'part' | 'diff' | 'other'

interface OpenCodeLocation {
  kind: OpenCodeFileKind
  sessionId?: string
  messageId?: string
}

interface FileMetadata {
  sessionId?: string
  recordId?: string
  parentSessionId?: string
  messageCount?: number
  modelIds: string[]
}

export async function collectManagedMetadata(options: {
  sources: ManagedSpaceSourceState[]
  sessions: ManagedSpaceSessionState[]
  owners: Map<string, Set<ManagedSpaceSessionState>>
  signal?: AbortSignal
  reportIssue: ManagedSpaceIssueReporter
}): Promise<void> {
  await collectOpenCodeMetadata(options)
  if (options.signal?.aborted) return
  await collectTranscriptMetadata(options)
  if (options.signal?.aborted) return
  for (const session of options.sessions) {
    if (session.session.providerId !== 'opencode' || session.sqliteMessageCount !== undefined)
      continue
    if (session.messageFileIds.size) session.messageCount = session.messageFileIds.size
  }
}

async function collectOpenCodeMetadata(options: {
  sources: ManagedSpaceSourceState[]
  sessions: ManagedSpaceSessionState[]
  owners: Map<string, Set<ManagedSpaceSessionState>>
  signal?: AbortSignal
  reportIssue: ManagedSpaceIssueReporter
}): Promise<void> {
  for (const source of options.sources) {
    if (source.source.kind !== 'opencode') continue
    const sessions = options.sessions.filter(
      (session) => session.sourceState?.source.id === source.source.id
    )
    const sessionsById = indexSessionsById(sessions)
    const messageOwners = new Map<string, Set<ManagedSpaceSessionState>>()
    for (const session of sessions) {
      for (const messageId of session.messageFileIds) addOwners(messageOwners, messageId, session)
    }
    const locatedFiles = source.files
      .map((file) => ({ file, location: openCodeLocation(file.path) }))
      .filter((entry) => entry.location !== undefined) as Array<{
      file: ManagedSpaceFile
      location: OpenCodeLocation
    }>
    for (const entry of locatedFiles.filter(
      (item) => item.location.kind === 'session' || item.location.kind === 'message'
    )) {
      if (options.signal?.aborted) return
      await associateSessionOrMessage(entry.file, entry.location, {
        source,
        sessionsById,
        messageOwners,
        owners: options.owners,
        signal: options.signal,
        reportIssue: options.reportIssue
      })
    }
    for (const entry of locatedFiles.filter(
      (item) =>
        item.location.kind === 'part' ||
        item.location.kind === 'diff' ||
        item.location.kind === 'other'
    )) {
      if (options.signal?.aborted) return
      await associatePartOrDiff(entry.file, entry.location, {
        source,
        sessionsById,
        messageOwners,
        owners: options.owners,
        signal: options.signal,
        reportIssue: options.reportIssue
      })
    }
  }
}

async function associateSessionOrMessage(
  file: ManagedSpaceFile,
  location: OpenCodeLocation,
  options: {
    source: ManagedSpaceSourceState
    sessionsById: Map<string, ManagedSpaceSessionState[]>
    messageOwners: Map<string, Set<ManagedSpaceSessionState>>
    owners: Map<string, Set<ManagedSpaceSessionState>>
    signal?: AbortSignal
    reportIssue: ManagedSpaceIssueReporter
  }
): Promise<void> {
  const metadata = await readFileMetadata(file, options.signal, options.reportIssue)
  const sessionId =
    location.kind === 'session'
      ? (metadata?.recordId ?? location.sessionId)
      : (metadata?.sessionId ?? location.sessionId)
  const sessions = sessionId ? (options.sessionsById.get(sessionId) ?? []) : []
  if (!sessions.length) {
    options.reportIssue(options.source, file.path, 'OpenCode JSON 记录无法关联到已扫描会话')
    return
  }
  const kind = 'transcript'
  file.kindHint = kind
  for (const session of sessions) {
    addManagedPathOwner(options.owners, file.path, session)
    mergeMetadata(session, metadata)
    if (location.kind === 'message' && location.messageId) {
      session.messageFileIds.add(location.messageId)
      addOwners(options.messageOwners, location.messageId, session)
    }
  }
}

async function associatePartOrDiff(
  file: ManagedSpaceFile,
  location: OpenCodeLocation,
  options: {
    source: ManagedSpaceSourceState
    sessionsById: Map<string, ManagedSpaceSessionState[]>
    messageOwners: Map<string, Set<ManagedSpaceSessionState>>
    owners: Map<string, Set<ManagedSpaceSessionState>>
    signal?: AbortSignal
    reportIssue: ManagedSpaceIssueReporter
  }
): Promise<void> {
  let sessions =
    location.kind === 'part' && location.messageId
      ? [...(options.messageOwners.get(location.messageId) ?? [])]
      : []
  if (!sessions.length && location.sessionId)
    sessions = options.sessionsById.get(location.sessionId) ?? []
  if (location.kind === 'other') {
    options.reportIssue(options.source, file.path, 'OpenCode storage 文件类型尚未确认')
    return
  }
  if (!sessions.length) {
    options.reportIssue(options.source, file.path, 'OpenCode 资源归属无法确证')
    return
  }
  file.kindHint = location.kind === 'diff' ? 'attachment' : 'transcript'
  for (const session of sessions) {
    addManagedPathOwner(options.owners, file.path, session)
  }
}

async function readFileMetadata(
  file: ManagedSpaceFile,
  signal: AbortSignal | undefined,
  reportIssue: ManagedSpaceIssueReporter
): Promise<FileMetadata | undefined> {
  if (file.info.size > MAX_JSON_METADATA_BYTES) {
    reportIssue(undefined, file.path, 'JSON 元数据超过读取上限，保留文件大小统计', false)
    return undefined
  }
  try {
    const bytes = await readFile(file.path, { signal })
    return fileMetadata(JSON.parse(UTF8.decode(bytes)))
  } catch {
    if (signal?.aborted) return undefined
    reportIssue(undefined, file.path, 'JSON 元数据无法解析，保留文件大小统计', false)
    return undefined
  }
}

function fileMetadata(value: unknown): FileMetadata | undefined {
  const root = asObject(value)
  if (!root) return undefined
  const nested = [root, asObject(root.info), asObject(root.message), asObject(root.data)].filter(
    (item): item is JsonObject => item !== undefined
  )
  return {
    ...(firstString(nested, ['id']) ? { recordId: firstString(nested, ['id']) } : {}),
    ...(firstString(nested, SESSION_ID_FIELDS)
      ? { sessionId: firstString(nested, SESSION_ID_FIELDS) }
      : {}),
    ...(firstString(nested, PARENT_SESSION_FIELDS)
      ? { parentSessionId: firstString(nested, PARENT_SESSION_FIELDS) }
      : {}),
    ...(Array.isArray(root.messages) ? { messageCount: root.messages.length } : {}),
    modelIds: collectModelIds(nested)
  }
}

async function collectTranscriptMetadata(options: {
  sources: ManagedSpaceSourceState[]
  sessions: ManagedSpaceSessionState[]
  owners: Map<string, Set<ManagedSpaceSessionState>>
  signal?: AbortSignal
  reportIssue: ManagedSpaceIssueReporter
}): Promise<void> {
  for (const session of options.sessions) {
    if (options.signal?.aborted) return
    if (!session.filePath || session.session.providerId === 'opencode') continue
    const file = session.sourceState?.filesByPath.get(normalizeManagedPath(session.filePath))
    if (!file) continue
    const extension = path.extname(file.path).toLowerCase()
    if (extension === '.jsonl' || file.path.toLowerCase().endsWith('.jsonl.zst')) {
      const metadata = await readTranscriptMetadata(
        file,
        session,
        options.signal,
        options.reportIssue
      )
      mergeMetadata(session, metadata)
      continue
    }
    if (extension === '.json' && session.session.providerId === 'gemini') {
      const metadata = await readFileMetadata(file, options.signal, options.reportIssue)
      mergeMetadata(session, metadata)
      if (metadata?.messageCount !== undefined) session.messageCount = metadata.messageCount
    }
  }
}

async function readTranscriptMetadata(
  file: ManagedSpaceFile,
  session: ManagedSpaceSessionState,
  signal: AbortSignal | undefined,
  reportIssue: ManagedSpaceIssueReporter
): Promise<FileMetadata | undefined> {
  const messageIds = new Set<string>()
  let anonymousMessages = 0
  let foundMessages = false
  let parentSessionId: string | undefined
  const modelIds = new Set<string>()
  let lineCount = 0
  try {
    for await (const line of readUtf8Lines(file.path, signal)) {
      if (!line.trim()) continue
      lineCount++
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        reportIssue(session.sourceState, file.path, '会话记录行无法解析，仅保留文件大小统计', false)
        continue
      }
      const record = asObject(parsed)
      if (!record) continue
      const nested = metadataObjects(record)
      for (const model of collectModelIds(nested)) modelIds.add(model)
      parentSessionId ??= firstString(nested, PARENT_SESSION_FIELDS)
      if (!isMessageRecord(session.session.providerId, record)) continue
      foundMessages = true
      const messageId = firstString(nested, ['uuid', 'message_id', 'messageId', 'item_id', 'id'])
      if (messageId) messageIds.add(messageId)
      else anonymousMessages++
    }
  } catch {
    if (signal?.aborted) return undefined
    reportIssue(session.sourceState, file.path, '会话元数据读取失败，仅保留文件大小统计', false)
    return undefined
  }
  const messageCount =
    foundMessages || lineCount === 0 ? messageIds.size + anonymousMessages : undefined
  return {
    ...(messageCount === undefined ? {} : { messageCount }),
    ...(parentSessionId ? { parentSessionId } : {}),
    modelIds: [...modelIds]
  }
}

function isMessageRecord(providerId: CleanerSourceKind, record: JsonObject): boolean {
  const payload = asObject(record.payload)
  const message = asObject(record.message)
  const role = firstString([record, message ?? {}], ['role'])
  if (providerId === 'codex') return record.type === 'response_item' && payload?.type === 'message'
  if (providerId === 'claude')
    return (
      record.type === 'user' ||
      record.type === 'assistant' ||
      role === 'user' ||
      role === 'assistant'
    )
  if (providerId === 'pi' || providerId === 'omp') return record.type === 'message'
  if (providerId === 'gemini') return role === 'user' || role === 'model'
  return role === 'user' || role === 'assistant'
}

function metadataObjects(record: JsonObject): JsonObject[] {
  const payload = asObject(record.payload)
  const message = asObject(record.message)
  const nestedMessage = payload ? asObject(payload.message) : undefined
  return [record, payload, message, nestedMessage].filter(
    (item): item is JsonObject => item !== undefined
  )
}

function mergeMetadata(
  session: ManagedSpaceSessionState,
  metadata: FileMetadata | undefined
): void {
  if (!metadata) return
  for (const modelId of metadata.modelIds) session.modelIds.add(modelId)
  if (metadata.messageCount !== undefined) session.messageCount = metadata.messageCount
  session.parentSessionId ??= metadata.parentSessionId
}

function indexSessionsById(
  sessions: ManagedSpaceSessionState[]
): Map<string, ManagedSpaceSessionState[]> {
  const result = new Map<string, ManagedSpaceSessionState[]>()
  for (const session of sessions) {
    const values = result.get(session.session.sessionId) ?? []
    values.push(session)
    result.set(session.session.sessionId, values)
  }
  return result
}

function addOwners(
  owners: Map<string, Set<ManagedSpaceSessionState>>,
  messageId: string,
  session: ManagedSpaceSessionState
): void {
  const values = owners.get(messageId) ?? new Set<ManagedSpaceSessionState>()
  values.add(session)
  owners.set(messageId, values)
}

function openCodeLocation(filePath: string): OpenCodeLocation | undefined {
  const parts = path
    .resolve(filePath)
    .split(/[\\/]+/)
    .filter(Boolean)
  let storageIndex = -1
  for (let index = 0; index < parts.length; index++)
    if (parts[index].toLowerCase() === 'storage') storageIndex = index
  if (storageIndex < 0) return undefined
  const type = parts[storageIndex + 1]?.toLowerCase()
  const tail = parts.slice(storageIndex + 2)
  const filename = tail.at(-1)
  const stem = filename ? path.parse(filename).name : undefined
  if (type === 'session') return { kind: 'session', sessionId: stem }
  if (type === 'message' && tail.length >= 2)
    return { kind: 'message', sessionId: tail[0], messageId: stem }
  if (type === 'part' && tail.length >= 2) return { kind: 'part', messageId: tail[0] }
  if (type === 'session_diff' && tail.length)
    return { kind: 'diff', sessionId: tail.length > 1 ? tail[0] : stem }
  return { kind: 'other' }
}

function firstString(objects: JsonObject[], fields: string[]): string | undefined {
  for (const object of objects) {
    for (const field of fields) {
      const value = object[field]
      if (typeof value === 'string' && value.trim() && value.length <= 256) return value.trim()
    }
  }
  return undefined
}

function collectModelIds(objects: JsonObject[]): string[] {
  const values = new Set<string>()
  for (const object of objects) {
    for (const field of MODEL_FIELDS) {
      const value = object[field]
      if (typeof value === 'string' && value.trim() && value.length <= 256) values.add(value.trim())
    }
  }
  return [...values]
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined
}
