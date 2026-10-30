import { lstat } from 'node:fs/promises'
import type { BigIntStats, Stats } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type {
  CleanerItem,
  CleanerIssue,
  CleanerSettings,
  CleanerSource,
  CleanerSourceKind
} from '../../../shared/session-cleaner.ts'
import { MAX_CANDIDATE_BYTES, type ScannedFile } from './scan-files.ts'

const DAY_MS = 86_400_000

export interface ScanItemContext {
  settings: CleanerSettings
  protectedIds: Set<string>
  items: CleanerItem[]
  issues: CleanerIssue[]
}

function addIssue(context: ScanItemContext, issuePath: string, message: string): void {
  context.issues.push({ path: issuePath, message })
}

export function metadataOnlyItem(options: {
  source: CleanerSource
  filePath: string
  info: Stats | BigIntStats
  category: CleanerItem['category']
  context: ScanItemContext
}): CleanerItem {
  const { source, filePath, info, category, context } = options
  const id = makeItemId(filePath)
  const isProtected = context.protectedIds.has(id)
  const reason =
    source.kind === 'unknown'
      ? '未知目录仅基于文件元数据只读清单；凭据与配置文件已排除'
      : category === 'resources'
        ? '会话关联资源仅基于文件元数据只读清单'
        : '文件超过扫描上限，仅保留只读占用信息'
  return {
    id,
    sourceId: source.id,
    title: path.basename(filePath),
    path: filePath,
    bytes: Number(info.size),
    modifiedAt: Number(info.mtimeMs),
    category,
    status: isProtected ? 'protected' : 'read-only',
    reason: isProtected ? '已标记保护' : reason,
    files: [filePath],
    fingerprint: `readonly-stat:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`
  }
}

export function metadataForFile(
  kind: CleanerSourceKind,
  filePath: string,
  scanned: ScannedFile,
  context: ScanItemContext
): { sessionId?: string; title?: string; project?: string } {
  const metadata = {
    sessionId: scanned.sessionId,
    title: scanned.title,
    project: scanned.project
  }
  if (kind === 'gemini' && scanned.jsonSample) {
    try {
      const record: unknown = JSON.parse(scanned.jsonSample)
      if (isRecord(record)) {
        metadata.sessionId ??= getString(record.sessionId) ?? getString(record.id)
        metadata.title ??=
          getString(record.title) ?? getString(record.sessionName) ?? getString(record.name)
        metadata.project ??= getString(record.cwd) ?? getString(record.projectPath)
      }
    } catch {
      addIssue(context, filePath, 'Gemini 会话元数据 JSON 损坏或超出样本范围')
    }
  }
  if (kind === 'gemini' && !metadata.sessionId) {
    metadata.sessionId = path
      .basename(filePath)
      .replace(/^session-/i, '')
      .replace(/\.json$/i, '')
  }
  if (kind === 'claude' && !metadata.sessionId)
    metadata.sessionId = path.basename(filePath).replace(/\.jsonl$/i, '')
  if (kind === 'cline' && path.basename(filePath).toLowerCase() === 'api_conversation_history.json')
    metadata.sessionId ??= path.basename(path.dirname(filePath))
  return metadata
}

export async function createFileItem(options: {
  source: CleanerSource
  filePath: string
  scanned: ScannedFile
  metadata: { sessionId?: string; title?: string; project?: string }
  category: CleanerItem['category']
  context: ScanItemContext
}): Promise<CleanerItem> {
  const { source, filePath, scanned, metadata, category, context } = options
  const sessionId = metadata.sessionId
  const id = makeItemId(filePath)
  let status: CleanerItem['status'] = 'read-only'
  let reason = readOnlyReason(source.kind, category)
  const isProtected =
    context.protectedIds.has(id) || Boolean(sessionId && context.protectedIds.has(sessionId))
  const ageDays = Math.max(0, (Date.now() - scanned.stat.mtimeMs) / DAY_MS)

  if (isProtected) {
    status = 'protected'
    reason = '已标记保护'
  } else if (category === 'logs') {
    if (ageDays < context.settings.logAgeDays) {
      status = 'recent'
      reason = `日志在最近 ${context.settings.logAgeDays} 天保留范围内`
    }
  } else if (source.kind === 'opencode' || source.kind === 'cline') {
    if (ageDays < context.settings.keepRecentDays) {
      status = 'recent'
      reason = `数据库会话在最近 ${context.settings.keepRecentDays} 天有更新；数据库只读`
    }
  } else if (source.kind === 'claude' || source.kind === 'pi') {
    const candidate = await candidateReason(filePath, scanned, sessionId, ageDays, context)
    if (candidate.candidate) {
      status = 'candidate'
      reason = `完整的独立旧会话，已超过 ${context.settings.olderSessionDays} 天`
    } else if (candidate.recent) {
      status = 'recent'
      reason = `会话在最近 ${context.settings.keepRecentDays} 天保留范围内`
    } else if (candidate.reason) {
      reason = candidate.reason
    }
  }

  return {
    id,
    sourceId: source.id,
    title: metadata.title ?? titleFromFile(filePath),
    path: filePath,
    ...(metadata.project ? { project: metadata.project } : {}),
    ...(sessionId ? { sessionId } : {}),
    bytes: scanned.stat.size,
    modifiedAt: scanned.stat.mtimeMs,
    category,
    status,
    reason,
    files: [filePath],
    fingerprint: scanned.fingerprint
  }
}

async function candidateReason(
  filePath: string,
  scanned: ScannedFile,
  sessionId: string | undefined,
  ageDays: number,
  context: ScanItemContext
): Promise<{ candidate: boolean; recent: boolean; reason?: string }> {
  if (ageDays < context.settings.keepRecentDays) return { candidate: false, recent: true }
  if (!scanned.formatValid || !scanned.sawRecord || !sessionId)
    return { candidate: false, recent: false, reason: '完整会话格式或身份验证未通过' }
  if (scanned.stat.nlink !== 1)
    return { candidate: false, recent: false, reason: '硬链接文件保持只读' }
  if (scanned.stat.size > MAX_CANDIDATE_BYTES)
    return {
      candidate: false,
      recent: false,
      reason: `会话超过单文件候选上限（${MAX_CANDIDATE_BYTES} 字节）`
    }

  const sibling = filePath.replace(/\.jsonl$/i, '')
  try {
    const info = await lstat(sibling)
    if (info.isDirectory() || info.isSymbolicLink())
      return { candidate: false, recent: false, reason: '存在关联目录或链接，保持只读' }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      addIssue(context, sibling, formatError(error))
      return { candidate: false, recent: false, reason: '无法核验关联资源边界，保持只读' }
    }
  }
  if (ageDays < context.settings.olderSessionDays)
    return {
      candidate: false,
      recent: false,
      reason: `尚未达到 ${context.settings.olderSessionDays} 天候选期限`
    }
  return { candidate: true, recent: false }
}

export function fileCategory(kind: CleanerSourceKind, filePath: string): CleanerItem['category'] {
  if (kind === 'unknown') return 'unknown'
  if (kind === 'aider') return 'resources'
  const segments = filePath.toLowerCase().split(/[\\/]/)
  return path.extname(filePath).toLowerCase() === '.log' &&
    segments.some((segment) => segment === 'log' || segment === 'logs')
    ? 'logs'
    : 'sessions'
}

export function isSupportedFile(kind: CleanerSourceKind, filePath: string): boolean {
  const name = path.basename(filePath).toLowerCase()
  const extension = path.extname(name)
  const inLogs = filePath
    .toLowerCase()
    .split(/[\\/]/)
    .some((part) => part === 'log' || part === 'logs')
  if (kind === 'codex') return /^rollout-.*\.jsonl$/i.test(name)
  if (kind === 'claude' || kind === 'pi') return extension === '.jsonl'
  if (kind === 'gemini') return /^session-.*\.json$/i.test(name)
  if (kind === 'opencode') return isDatabaseFile(filePath) || (inLogs && extension === '.log')
  if (kind === 'cline')
    return (
      name === 'sessions.db' ||
      name === 'api_conversation_history.json' ||
      name === 'ui_messages.json' ||
      (inLogs && extension === '.log')
    )
  if (kind === 'aider') return name === '.aider.chat.history.md' || name === 'aider.chat.history.md'
  return (
    extension === '.jsonl' ||
    /^session-.*\.json$/i.test(name) ||
    name === 'opencode.db' ||
    name === 'sessions.db' ||
    name === 'api_conversation_history.json' ||
    name === '.aider.chat.history.md' ||
    (inLogs && extension === '.log')
  )
}

export function isDatabaseFile(filePath: string): boolean {
  const name = path.basename(filePath).toLowerCase()
  return name === 'opencode.db' || ['.db', '.sqlite', '.sqlite3'].includes(path.extname(name))
}

function readOnlyReason(kind: CleanerSourceKind, category: CleanerItem['category']): string {
  if (kind === 'codex') return 'Codex 状态数据库一致性尚未实现，全部只读'
  if (kind === 'opencode' || kind === 'cline') return '数据库或任务数据只读，未验证单条会话回收边界'
  if (kind === 'unknown') return '未知来源仅只读列出支持的文件'
  if (kind === 'aider') return 'Aider 历史是聚合文件，无法安全拆分单次会话'
  if (category === 'logs') return '日志仅只读扫描'
  return '来源格式或资源边界未验证，保持只读'
}

export function makeItemId(filePath: string, sessionId?: string): string {
  const key = sessionId ? `${filePath}\0${sessionId}` : filePath
  return createHash('sha256').update(normalizePath(key)).digest('hex').slice(0, 32)
}

function titleFromFile(filePath: string): string {
  const title = path.basename(filePath).replace(/\.(jsonl?|db|sqlite3?)$/i, '')
  return title || path.basename(filePath)
}

export function timestamp(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 240) : undefined
}

export function normalizePath(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
