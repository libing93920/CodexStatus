import { createReadStream } from 'node:fs'
import { lstat, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type {
  CleanerItem,
  CleanerSettings,
  CleanerSource
} from '../../../shared/session-cleaner.ts'
import { parseClaudeFile } from '../../services/agents.ts'
import { retainUsageSource } from '../../services/usage-retention.ts'
import { fingerprintFile } from './scanner.ts'
import { readUtf8Lines } from './catalog-io.ts'

const DAY_MS = 86_400_000
const MAX_RECYCLABLE_BYTES = 64 * 1024 * 1024
const MAX_JSON_LINE_LENGTH = 2 * 1024 * 1024

export function isWithinRoot(root: string, filePath: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(filePath))
  return (
    relative !== '' &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  )
}

export async function assertOwnedFile(source: CleanerSource, filePath: string): Promise<void> {
  if (!isWithinRoot(source.path, filePath)) throw new Error('文件不在来源目录内')
  const canonicalRoot = await realpath(source.path)
  const canonicalFile = await realpath(filePath)
  if (!isWithinRoot(canonicalRoot, canonicalFile)) throw new Error('文件实际位置越过来源目录')
  const segments = path.relative(source.path, filePath).split(path.sep)
  let current = source.path
  for (const segment of ['', ...segments]) {
    current = path.join(current, segment)
    if ((await lstat(current)).isSymbolicLink()) throw new Error('链接或 junction 不允许回收')
  }
  const info = await lstat(filePath)
  if (!info.isFile() || info.nlink !== 1) throw new Error('仅支持独立普通文件，硬链接保持只读')
}

export async function validateRecycleItem(options: {
  source: CleanerSource
  item: CleanerItem
  settings: CleanerSettings
}): Promise<void> {
  const { source, item, settings } = options
  if (
    process.platform === 'win32' &&
    (!/^[a-z]:\\/i.test(source.path) || !/^[a-z]:\\/i.test(item.path))
  )
    throw new Error('首版回收仅支持本地盘符路径，网络共享与设备路径保持只读')
  if (!item.sessionId) throw new Error('缺少可核验的会话身份')
  if (item.status !== 'candidate' || item.files.length !== 1 || item.files[0] !== item.path)
    throw new Error('仅能处理已验证的单文件会话')
  if (source.kind !== 'claude' && source.kind !== 'pi')
    throw new Error('此来源尚未验证可恢复的独立回收方式')
  await assertOwnedFile(source, item.path)
  const info = await stat(item.path)
  if (info.size > MAX_RECYCLABLE_BYTES) throw new Error('大于 64 MB 的会话保持只读')
  if (Date.now() - info.mtimeMs < settings.keepRecentDays * DAY_MS)
    throw new Error('文件仍在近期保留范围内')
  if ((await fingerprintFile(item.path)) !== item.fingerprint)
    throw new Error('文件已变化，请重新扫描')
  const sibling = item.path.replace(/\.jsonl$/i, '')
  try {
    const related = await lstat(sibling)
    if (related.isDirectory() || related.isSymbolicLink())
      throw new Error('存在关联资源目录或链接，暂不支持回收')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await validateJsonSession(item, source.kind)
}

async function validateJsonSession(item: CleanerItem, kind: CleanerSource['kind']): Promise<void> {
  const lines = readUtf8Lines(item.path)
  let seen = false
  let identitySeen = false
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      if (line.length > MAX_JSON_LINE_LENGTH) throw new Error('记录过大，无法验证完整格式')
      const record = JSON.parse(line) as Record<string, unknown>
      if (
        kind === 'pi' &&
        !seen &&
        (record.type !== 'session' || record.id !== item.sessionId || record.version !== 3)
      )
        throw new Error('Pi 会话身份不匹配')
      if (kind === 'pi' && seen && record.type === 'session')
        throw new Error('Pi 文件包含多个会话头，保持只读')
      if (kind === 'pi' && record.type === 'session' && record.id === item.sessionId)
        identitySeen = true
      if (kind === 'claude' && record.sessionId && record.sessionId !== item.sessionId)
        throw new Error('Claude 会话包含其他会话记录')
      if (kind === 'claude' && record.sessionId === item.sessionId) identitySeen = true
      if (typeof record.type !== 'string') throw new Error('会话记录格式不完整')
      seen = true
    }
    if (!seen) throw new Error('空文件没有可核验的会话身份')
    if (!identitySeen) throw new Error('文件内容未能证明会话身份')
  } finally {
    await lines.return(undefined)
  }
}

export async function retainItemUsage(options: {
  source: CleanerSource
  item: CleanerItem
  directory: string
}): Promise<void> {
  const { source, item, directory } = options
  if (source.kind !== 'claude') return
  const events = await parseClaudeFile(item.path, { throwOnReadError: true })
  if (events.some((event) => !event.messageId))
    throw new Error('用量事件缺少去重身份，不能安全回收')
  if ((await fingerprintFile(item.path)) !== item.fingerprint) throw new Error('留存时文件发生变化')
  const key = createHash('sha256').update(path.resolve(item.path).toLowerCase()).digest('hex')
  await retainUsageSource(directory, {
    key: `claude:${key}`,
    agent: 'claude',
    path: item.path,
    events
  })
}

export async function readItemDetails(source: CleanerSource, item: CleanerItem): Promise<string> {
  if (path.resolve(source.path) === path.resolve(item.path)) {
    const info = await lstat(item.path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('不是可读取的普通文件')
  } else {
    await assertOwnedFile(source, item.path)
  }
  if (/\.(db|sqlite|sqlite3)$/i.test(item.path))
    return '共享数据库仅展示文件占用与路径，不预览原始二进制内容。'
  if (!/\.(jsonl?|txt|md|log|ya?ml)$/i.test(item.path))
    return '此文件仅展示占用和路径，不预览二进制或未识别格式的内容。'
  // 详情仅在用户主动打开时读取有限文本，避免列表携带整份聊天正文。
  const stream = createReadStream(item.path, { encoding: 'utf8', start: 0, end: 16 * 1024 - 1 })
  let text = ''
  for await (const chunk of stream) text += chunk
  return text
}
