import { constants } from 'node:fs'
import { open, lstat, type FileHandle } from 'node:fs/promises'
import type { BigIntStats, Stats } from 'node:fs'
import { createHash } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import path from 'node:path'
import type { CleanerSourceKind } from '../../../shared/session-cleaner.ts'

export const MAX_SCAN_FILE_BYTES = 256 * 1024 * 1024
export const MAX_CANDIDATE_BYTES = 64 * 1024 * 1024
export const MAX_JSON_LINE_LENGTH = 2 * 1024 * 1024
const MAX_METADATA_BYTES = 64 * 1024
const MAX_METADATA_LINES = 64
const READ_CHUNK_BYTES = 64 * 1024

export interface ScannedFile {
  stat: Stats
  fingerprint: string
  formatValid: boolean
  formatIssue?: string
  sawRecord: boolean
  sessionId?: string
  title?: string
  project?: string
  jsonSample?: string
}

interface JsonlState {
  formatValid: boolean
  formatIssue?: string
  sawRecord: boolean
  sessionMetaSeen: boolean
  sessionId?: string
  title?: string
  project?: string
  sampleBytes: number
  sampleLines: number
}

export async function fingerprintFile(filePath: string): Promise<string> {
  const { handle, identity: before } = await openRegularFile(filePath)
  try {
    const digest = await hashHandle(handle, undefined)
    const after = await handle.stat({ bigint: true })
    assertUnchanged(before, after)
    return formatFingerprint(after, digest)
  } finally {
    await handle.close()
  }
}

export async function scanFile(options: {
  filePath: string
  kind: CleanerSourceKind
  signal?: AbortSignal
  onBytes: (bytes: number) => void
}): Promise<ScannedFile> {
  const { filePath, kind, signal, onBytes } = options
  const { handle, stat: before, identity } = await openRegularFile(filePath)
  try {
    if (before.size > MAX_SCAN_FILE_BYTES)
      throw new Error(`文件超过扫描上限（${MAX_SCAN_FILE_BYTES} 字节）`)

    const hash = createHash('sha256')
    const jsonl =
      kind === 'codex' || kind === 'claude' || kind === 'pi' ? createJsonlState() : undefined
    const decoder = jsonl ? new StringDecoder('utf8') : undefined
    const utf8 = jsonl ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }) : undefined
    const wantsJsonSample =
      kind === 'gemini' &&
      path.extname(filePath).toLowerCase() === '.json' &&
      before.size <= MAX_METADATA_BYTES
    const sample: Buffer[] = []
    let sampleBytes = 0
    let lineBuffer = ''
    let discardingLongLine = false
    let bytesRead = 0

    const readBuffer = Buffer.allocUnsafe(READ_CHUNK_BYTES)
    while (true) {
      if (signal?.aborted) throw createAbortError()
      const { bytesRead: chunkBytes } = await handle.read(readBuffer, 0, readBuffer.length, null)
      if (chunkBytes === 0) break
      const chunk = readBuffer.subarray(0, chunkBytes)
      try {
        utf8?.decode(chunk, { stream: true })
      } catch {
        if (jsonl) invalidate(jsonl, '会话包含无效 UTF-8 字节')
      }
      bytesRead += chunk.length
      hash.update(chunk)
      onBytes(chunk.length)
      if (wantsJsonSample && sampleBytes < MAX_METADATA_BYTES) {
        const part = chunk.subarray(0, MAX_METADATA_BYTES - sampleBytes)
        sample.push(Buffer.from(part))
        sampleBytes += part.length
      }
      if (!jsonl || !decoder) continue

      const text = decoder.write(chunk)
      let offset = 0
      while (offset < text.length) {
        const newline = text.indexOf('\n', offset)
        const end = newline < 0 ? text.length : newline
        const segment = text.slice(offset, end)
        if (!discardingLongLine) {
          if (lineBuffer.length + segment.length > MAX_JSON_LINE_LENGTH) {
            invalidate(jsonl, 'JSONL 单行超过扫描上限')
            lineBuffer = ''
            discardingLongLine = true
          } else {
            lineBuffer += segment
          }
        }
        if (newline < 0) break
        if (!discardingLongLine) consumeJsonlLine(lineBuffer, kind, jsonl)
        lineBuffer = ''
        discardingLongLine = false
        offset = newline + 1
      }
    }

    if (signal?.aborted) throw createAbortError()
    if (decoder && jsonl) {
      try {
        utf8?.decode()
      } catch {
        invalidate(jsonl, '会话包含无效 UTF-8 字节')
      }
      const tail = decoder.end()
      if (tail) lineBuffer += tail
      if (!discardingLongLine && lineBuffer.length > MAX_JSON_LINE_LENGTH)
        invalidate(jsonl, 'JSONL 单行超过扫描上限')
      else if (!discardingLongLine) consumeJsonlLine(lineBuffer, kind, jsonl)
    }
    if (bytesRead !== before.size) throw new Error('文件扫描期间长度发生变化')

    const after = await handle.stat()
    const exactAfter = await handle.stat({ bigint: true })
    assertUnchanged(identity, exactAfter)
    return {
      stat: after,
      fingerprint: formatFingerprint(exactAfter, hash.digest('hex')),
      formatValid: jsonl?.formatValid ?? true,
      formatIssue: jsonl?.formatIssue,
      sawRecord: jsonl?.sawRecord ?? false,
      sessionId: jsonl?.sessionId,
      title: jsonl?.title,
      project: jsonl?.project,
      jsonSample: wantsJsonSample ? Buffer.concat(sample).toString('utf8') : undefined
    }
  } finally {
    await handle.close()
  }
}

function createJsonlState(): JsonlState {
  return {
    formatValid: true,
    sawRecord: false,
    sessionMetaSeen: false,
    sampleBytes: 0,
    sampleLines: 0
  }
}

function consumeJsonlLine(rawLine: string, kind: CleanerSourceKind, state: JsonlState): void {
  const line = rawLine.replace(/\r$/, '').replace(/^\uFEFF/, '')
  if (!line.trim()) return
  const inSample =
    state.sampleLines < MAX_METADATA_LINES &&
    state.sampleBytes + Buffer.byteLength(line, 'utf8') <= MAX_METADATA_BYTES
  state.sampleLines++
  state.sampleBytes += Buffer.byteLength(line, 'utf8')

  let record: Record<string, unknown>
  try {
    const value: unknown = JSON.parse(line)
    if (!isRecord(value) || typeof value.type !== 'string') throw new Error()
    record = value
  } catch {
    invalidate(state, '会话记录损坏或截断')
    return
  }

  if (kind === 'pi' && !state.sawRecord) {
    if (record.type !== 'session' || !getString(record.id) || record.version !== 3)
      invalidate(state, 'Pi 会话头版本或身份未验证')
    else state.sessionId = getString(record.id)
    if (inSample) {
      state.title = getString(record.name) ?? getString(record.title)
      state.project = getString(record.cwd)
    }
  }
  if (kind === 'pi' && state.sawRecord && record.type === 'session')
    invalidate(state, 'Pi 文件包含多个会话头，保持只读')

  if (kind === 'claude') {
    const sessionId = getString(record.sessionId)
    if (sessionId) {
      if (state.sessionId && state.sessionId !== sessionId)
        invalidate(state, 'Claude 文件包含不一致的会话身份')
      else state.sessionId = sessionId
    }
    if (inSample) {
      state.project ??= getString(record.cwd)
      state.title ??= getString(record.title)
      if (record.type === 'custom-title') state.title = getString(record.customTitle) ?? state.title
    }
  }

  if (kind === 'codex' && record.type === 'session_meta' && !state.sessionMetaSeen) {
    state.sessionMetaSeen = true
    const payload = isRecord(record.payload) ? record.payload : undefined
    state.sessionId = getString(payload?.id)
    if (inSample) {
      state.project = getString(payload?.cwd)
      state.title = getString(payload?.title)
    }
  }
  state.sawRecord = true
}

function invalidate(state: JsonlState, message: string): void {
  state.formatValid = false
  state.formatIssue ??= message
}

async function hashHandle(
  handle: FileHandle,
  onBytes: ((bytes: number) => void) | undefined
): Promise<string> {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES)
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
    if (bytesRead === 0) break
    hash.update(buffer.subarray(0, bytesRead))
    onBytes?.(bytesRead)
  }
  return hash.digest('hex')
}

async function openRegularFile(filePath: string): Promise<{
  handle: FileHandle
  stat: Stats
  identity: BigIntStats
}> {
  const before = await lstat(filePath, { bigint: true })
  if (!before.isFile()) throw new Error('只支持普通文件；链接或特殊文件保持只读')
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  const handle = await open(filePath, constants.O_RDONLY | noFollow)
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || !sameIdentity(before, opened)) throw new Error('文件在打开时发生变化')
    return { handle, stat: await handle.stat(), identity: opened }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

function assertUnchanged(before: BigIntStats, after: BigIntStats): void {
  if (
    !sameIdentity(before, after) ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  )
    throw new Error('文件扫描期间身份或时间戳发生变化')
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function formatFingerprint(stat: BigIntStats, digest: string): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${digest}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 240) : undefined
}

function createAbortError(): Error {
  const error = new Error('扫描已取消')
  error.name = 'AbortError'
  return error
}
