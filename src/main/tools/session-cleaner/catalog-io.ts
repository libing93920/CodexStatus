import { createReadStream } from 'node:fs'
import { lstat, open, readdir, readFile } from 'node:fs/promises'
import type { Readable } from 'node:stream'
import { createZstdDecompress } from 'node:zlib'
import path from 'node:path'
import type { CleanerIssue } from '../../../shared/session-cleaner.ts'

export const TITLE_CHARS = 80
const EDGE_BYTES = 16_384
const READ_CHUNK_BYTES = 64 * 1024
const SECOND_TO_MS = 1000
const MILLISECOND_THRESHOLD = 1_000_000_000_000
const HEAD_LINES = 10
const TAIL_LINES = 30
const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function nonempty(value: unknown): string | undefined {
  const text = string(value)
  return text === undefined ? undefined : trimText(text) || undefined
}

/** Rust str::trim 使用 Unicode White_Space，和 JS trim 对 BOM/NEL 的范围不同。 */
export function trimText(text: string): string {
  return text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '')
}

export function parseLine(line: string): Record<string, unknown> {
  try {
    return object(JSON.parse(line))
  } catch {
    return {}
  }
}

export function truncate(text: string, maximum = TITLE_CHARS): string {
  const trimmed = trimText(text)
  const characters = Array.from(trimmed)
  return characters.length > maximum ? `${characters.slice(0, maximum).join('')}...` : trimmed
}

export function basename(value: string | undefined): string | undefined {
  return value === undefined
    ? undefined
    : trimText(value)
        .replace(/[\\/]+$/, '')
        .split(/[\\/]/)
        .at(-1) || undefined
}

export function time(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const integer = Math.trunc(value)
    return integer > MILLISECOND_THRESHOLD ? integer : integer * SECOND_TO_MS
  }
  return typeof value === 'string' ? rfc3339Time(value) : undefined
}

function rfc3339Time(value: string): number | undefined {
  const match = value.match(RFC3339)
  if (!match) return undefined
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match
  const [year, month, day, hour, minute, second] = [
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText
  ].map(Number)
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = month === 2 ? (leapYear ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31
  const zoneParts = zone.slice(1).split(':').map(Number)
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days ||
    hour > 23 ||
    minute > 59 ||
    second > 60 ||
    (zone.length > 1 && (zoneParts[0] > 23 || zoneParts[1] > 59))
  )
    return undefined
  const normal = second === 60 ? `${value.slice(0, 17)}59${value.slice(19)}` : value
  const parsed = Date.parse(normal)
  return Number.isFinite(parsed) ? parsed + (second === 60 ? SECOND_TO_MS : 0) : undefined
}

export function extractText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return string(object(value).text) ?? ''
  return value
    .map(extractItemText)
    .filter((text) => trimText(text))
    .join('\n')
}

function extractItemText(value: unknown): string {
  const item = object(value)
  if (item.type === 'tool_use' || item.type === 'toolCall')
    return `[Tool: ${string(item.name) ?? 'unknown'}]`
  if (item.type === 'tool_result') return extractText(item.content)
  return (
    string(item.text) ??
    string(item.input_text) ??
    string(item.output_text) ??
    extractText(item.content)
  )
}

export async function readJson(filePath: string): Promise<Record<string, unknown>> {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  return object(JSON.parse(decoder.decode(await readFile(filePath))))
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function checkAbort(signal?: AbortSignal): void {
  signal?.throwIfAborted()
}

/** 无效 UTF-8 必须失败；替换成 U+FFFD 会把损坏记录误判为可回收的有效 JSON。 */
export async function* readUtf8Lines(
  filePath: string,
  signal?: AbortSignal
): AsyncGenerator<string, void> {
  const input = createReadStream(filePath, { signal, highWaterMark: READ_CHUNK_BYTES })
  const compressed = filePath.endsWith('.jsonl.zst') ? createZstdDecompress() : undefined
  if (compressed) {
    input.on('error', (error) => compressed.destroy(error))
    input.pipe(compressed)
  }
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  try {
    for await (const line of byteLines(compressed ?? input)) {
      checkAbort(signal)
      yield decoder.decode(line)
    }
  } finally {
    input.destroy()
    compressed?.destroy()
  }
}

async function* byteLines(input: Readable): AsyncGenerator<Buffer, void> {
  let pending: Buffer[] = []
  for await (const chunk of input) {
    const buffer = chunk as Buffer
    let start = 0
    while (start < buffer.length) {
      const newline = buffer.indexOf(10, start)
      if (newline < 0) {
        pending.push(buffer.subarray(start))
        break
      }
      const segment = buffer.subarray(start, newline)
      const line = pending.length ? Buffer.concat([...pending, segment]) : segment
      pending = []
      yield line.at(-1) === 13 ? line.subarray(0, -1) : line
      start = newline + 1
    }
  }
  if (pending.length) yield Buffer.concat(pending)
}

export async function collectFiles(options: {
  root: string
  accept: (filePath: string) => boolean
  issues: CleanerIssue[]
  signal?: AbortSignal
}): Promise<string[]> {
  const files: string[] = []
  const pending = [options.root]
  while (pending.length) {
    checkAbort(options.signal)
    const target = pending.pop()!
    try {
      const info = await lstat(target)
      if (info.isSymbolicLink()) {
        options.issues.push({ path: target, message: '链接或 junction 保持只读，未跟随' })
      } else if (info.isDirectory()) {
        const entries = await readdir(target)
        for (const name of entries.reverse()) pending.push(path.join(target, name))
      } else if (info.isFile() && options.accept(target)) files.push(target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        options.issues.push({ path: target, message: errorText(error) })
    }
  }
  return files
}

export async function firstLines(
  filePath: string,
  count: number,
  signal?: AbortSignal
): Promise<string[]> {
  const result: string[] = []
  try {
    for await (const line of readUtf8Lines(filePath, signal)) {
      result.push(line)
      if (result.length === count) break
    }
  } catch (error) {
    checkAbort(signal)
    const code = (error as NodeJS.ErrnoException).code
    if (!result.length && code !== 'ERR_ENCODING_INVALID_ENCODED_DATA') throw error
  }
  return result
}

export async function tailText(filePath: string, bytes: number): Promise<string> {
  const { buffer, start } = await readTailBuffer(filePath, bytes)
  const content = buffer.toString('utf8')
  if (!start) return content
  const newline = content.indexOf('\n')
  return newline < 0 ? '' : content.slice(newline + 1)
}

async function readTailBuffer(
  filePath: string,
  bytes: number
): Promise<{ buffer: Buffer; start: number }> {
  const handle = await open(filePath, 'r')
  try {
    const size = (await handle.stat()).size
    const start = Math.max(0, size - bytes)
    const buffer = Buffer.alloc(size - start)
    const read = await handle.read(buffer, 0, buffer.length, start)
    return { buffer: buffer.subarray(0, read.bytesRead), start }
  } finally {
    await handle.close()
  }
}

export async function headTail(
  filePath: string,
  signal?: AbortSignal
): Promise<{ head: string[]; tail: string[] }> {
  const head = await firstLines(filePath, HEAD_LINES, signal)
  if (filePath.endsWith('.jsonl.zst')) return { head, tail: [] }
  const { buffer, start } = await readTailBuffer(filePath, EDGE_BYTES)
  const tail = decodeBufferLines(buffer)
  return { head, tail: (start ? tail.slice(1) : tail).slice(-TAIL_LINES) }
}

function decodeBufferLines(buffer: Buffer): string[] {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  const lines: string[] = []
  let start = 0
  while (start < buffer.length) {
    const newline = buffer.indexOf(10, start)
    const end = newline < 0 ? buffer.length : newline
    const crlf = newline >= 0 && buffer[end - 1] === 13
    try {
      lines.push(decoder.decode(buffer.subarray(start, crlf ? end - 1 : end)))
    } catch {
      break
    }
    start = end + 1
  }
  return lines
}
