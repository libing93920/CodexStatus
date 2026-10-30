import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createZstdDecompress } from 'node:zlib'
import type { ManagedSession } from '../../../shared/session-manager.ts'
import {
  createOpenCodeSessionRetentionKey,
  parseClaudeFile,
  readOpenCodeSessionUsage
} from '../../services/agents.ts'
import { parseSessionFile, type ParsedFile } from '../../services/codex-session-parser.ts'
import { retainUsageSource } from '../../services/usage-retention.ts'

const CODEX_TEMP_PREFIX = 'codex-status-retention-'
const CODEX_COMPRESSED_SUFFIX = '.jsonl.zst'
const CODEX_PLAIN_SUFFIX = '.jsonl'
const OPENCODE_SOURCE_PREFIX = 'sqlite:'

export async function retainManagedUsage(options: {
  session: ManagedSession
  directory: string
}): Promise<void> {
  const { session, directory } = options
  switch (session.providerId) {
    case 'claude':
      return retainClaudeUsage(session, directory)
    case 'codex':
      return retainCodexUsage(session, directory)
    case 'opencode':
      // 宿主只从 SQLite 重建 OpenCode 用量，旧 JSON 会话未纳入现有统计。
      if (!session.sourcePath.startsWith(OPENCODE_SOURCE_PREFIX)) return
      return retainOpenCodeUsage(session, directory)
    case 'pi':
    case 'omp':
    case 'gemini':
    case 'openclaw':
    case 'hermes':
    case 'grokbuild':
      // 这些来源不在宿主用量注册表中，没有需要搬迁的历史统计。
      return
    default:
      throw new Error(`不支持留存 ${session.providerId} 会话用量`)
  }
}

async function retainClaudeUsage(session: ManagedSession, directory: string): Promise<void> {
  const events = await parseClaudeFile(session.sourcePath, { throwOnReadError: true })
  if (events.some((event) => !event.messageId))
    throw new Error('Claude 用量事件缺少 message.id，不能安全留存')
  const normalizedPath = path.resolve(session.sourcePath).replace(/\\/g, '/')
  const pathIdentity = process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath
  const key = createHash('sha256').update(pathIdentity).digest('hex')
  await retainUsageSource(directory, {
    key: `claude:${key}`,
    agent: 'claude',
    path: session.sourcePath,
    events
  })
}

async function retainCodexUsage(session: ManagedSession, directory: string): Promise<void> {
  const parsed = await parseCodexSession(session)
  await retainUsageSource(directory, {
    key: `codex:${session.sessionId}`,
    agent: 'codex',
    path: session.sourcePath,
    threadId: session.sessionId,
    parsed
  })
}

async function parseCodexSession(session: ManagedSession): Promise<ParsedFile> {
  if (!session.sourcePath.endsWith(CODEX_COMPRESSED_SUFFIX)) {
    if (!session.sourcePath.endsWith(CODEX_PLAIN_SUFFIX))
      throw new Error('Codex 来源不是已验证的 JSONL 或 JSONL.ZST 文件')
    const parsed = await parseSessionFile(session.sourcePath, session.sessionId)
    if (!parsed) throw new Error('Codex 会话文件无法读取')
    return parsed
  }

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), CODEX_TEMP_PREFIX))
  const temporaryFile = path.join(temporaryDirectory, 'session.jsonl')
  try {
    await pipeline(
      createReadStream(session.sourcePath),
      createZstdDecompress(),
      createWriteStream(temporaryFile, { mode: 0o600 })
    )
    const parsed = await parseSessionFile(temporaryFile, session.sessionId)
    if (!parsed) throw new Error('压缩 Codex 会话无法解析')
    return parsed
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

async function retainOpenCodeUsage(session: ManagedSession, directory: string): Promise<void> {
  const dbPath = parseOpenCodeDatabasePath(session)
  const events = await readOpenCodeSessionUsage(dbPath, session.sessionId)
  if (events.some((event) => !event.messageId))
    throw new Error('OpenCode 用量事件缺少消息 id，不能安全留存')
  await retainUsageSource(directory, {
    key: createOpenCodeSessionRetentionKey(dbPath, session.sessionId),
    agent: 'opencode',
    path: dbPath,
    sessionId: session.sessionId,
    events
  })
}

function parseOpenCodeDatabasePath(session: ManagedSession): string {
  const suffix = `:${session.sessionId}`
  if (
    !session.sourcePath.startsWith(OPENCODE_SOURCE_PREFIX) ||
    !session.sourcePath.endsWith(suffix)
  )
    throw new Error('OpenCode sourcePath 不符合已验证的 sqlite:<dbpath>:<sessionId> 格式')
  const dbPath = session.sourcePath.slice(OPENCODE_SOURCE_PREFIX.length, -suffix.length)
  if (!dbPath.trim()) throw new Error('OpenCode sourcePath 缺少数据库路径')
  return path.resolve(dbPath)
}
