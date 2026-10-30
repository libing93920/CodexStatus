import { lstat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import type { CleanerItem, CleanerSource } from '../../../shared/session-cleaner.ts'
import type { ScannedFile } from './scan-files.ts'
import {
  formatError,
  getString,
  makeItemId,
  metadataOnlyItem,
  timestamp,
  type ScanItemContext
} from './scan-items.ts'

const DAY_MS = 86_400_000
const MAX_OPEN_CODE_SESSIONS = 10_000

type OpenCodeRow = Record<string, unknown>

function addIssue(context: ScanItemContext, issuePath: string, message: string): void {
  context.issues.push({ path: issuePath, message })
}

export async function scanOpenCodeDatabase(
  source: CleanerSource,
  filePath: string,
  scanned: ScannedFile,
  context: ScanItemContext
): Promise<void> {
  let databaseItemAdded = false
  try {
    const before = await lstat(filePath)
    if (!isSameScannedFile(before, scanned.stat)) {
      addIssue(context, filePath, 'OpenCode 数据库扫描期间发生变化')
      if (before.isFile())
        context.items.push(
          metadataOnlyItem({ source, filePath, info: before, category: 'sessions', context })
        )
      return
    }

    const rows = await readOpenCodeSessions(filePath)
    const current = await lstat(filePath)
    if (!isSameScannedFile(current, scanned.stat)) {
      addIssue(context, filePath, 'OpenCode 数据库扫描期间发生变化')
      if (current.isFile())
        context.items.push(
          metadataOnlyItem({ source, filePath, info: current, category: 'sessions', context })
        )
      return
    }

    context.items.push(
      databaseFileItem({ source, filePath, scanned, context, title: 'OpenCode 会话数据库' })
    )
    databaseItemAdded = true
    for (const row of rows.slice(0, MAX_OPEN_CODE_SESSIONS)) {
      const sessionId = getString(row.id)
      if (!sessionId) {
        addIssue(context, filePath, 'OpenCode 会话记录缺少 id')
        continue
      }
      const modifiedAt = timestamp(row.time_updated, scanned.stat.mtimeMs)
      const id = makeItemId(filePath, sessionId)
      const isProtected = context.protectedIds.has(id) || context.protectedIds.has(sessionId)
      const recent = (Date.now() - modifiedAt) / DAY_MS < context.settings.keepRecentDays
      context.items.push({
        id,
        sourceId: source.id,
        title: getString(row.title) ?? sessionId,
        path: filePath,
        ...(getString(row.directory) ? { project: getString(row.directory) } : {}),
        sessionId,
        bytes: 0,
        modifiedAt,
        category: 'sessions',
        status: isProtected ? 'protected' : recent ? 'recent' : 'read-only',
        reason: isProtected ? '已标记保护' : 'OpenCode SQLite 只读；不估算单条会话磁盘占用',
        files: [filePath],
        fingerprint: scanned.fingerprint
      })
    }
    if (rows.length > MAX_OPEN_CODE_SESSIONS)
      addIssue(context, filePath, `OpenCode 会话数量超过上限（${MAX_OPEN_CODE_SESSIONS}）`)
  } catch (error) {
    addIssue(context, filePath, `OpenCode 数据库只读解析失败：${formatError(error)}`)
    if (!databaseItemAdded) await addDatabaseEntityIfCurrent(source, filePath, scanned, context)
  }
}

async function addDatabaseEntityIfCurrent(
  source: CleanerSource,
  filePath: string,
  scanned: ScannedFile,
  context: ScanItemContext
): Promise<void> {
  try {
    const current = await lstat(filePath)
    if (isSameScannedFile(current, scanned.stat)) {
      context.items.push(
        databaseFileItem({
          source,
          filePath,
          scanned,
          context,
          title: 'OpenCode 数据库（只读文件）'
        })
      )
    } else if (current.isFile()) {
      addIssue(context, filePath, 'OpenCode 数据库扫描期间发生变化')
      context.items.push(
        metadataOnlyItem({ source, filePath, info: current, category: 'sessions', context })
      )
    }
  } catch (error) {
    addIssue(context, filePath, `OpenCode 数据库大小无法核验：${formatError(error)}`)
  }
}

function isSameScannedFile(current: Stats, scanned: Stats): boolean {
  return (
    current.isFile() &&
    current.size === scanned.size &&
    current.mtimeMs === scanned.mtimeMs &&
    current.ino === scanned.ino &&
    current.dev === scanned.dev
  )
}

async function readOpenCodeSessions(filePath: string): Promise<OpenCodeRow[]> {
  const { DatabaseSync } = await import('node:sqlite')
  const database = new DatabaseSync(filePath, { readOnly: true })
  try {
    const table = database
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session'")
      .get()
    if (!table) throw new Error('缺少已验证的 session 表结构')
    const columns = new Set(
      (database.prepare('PRAGMA table_info(session)').all() as Array<{ name?: unknown }>)
        .map((column) => column.name)
        .filter((name): name is string => typeof name === 'string')
    )
    if (!['id', 'title', 'directory'].every((column) => columns.has(column)))
      throw new Error('session 表缺少 id/title/directory 元数据列')
    const updated = columns.has('time_updated') ? 'time_updated' : 'NULL AS time_updated'
    return database
      .prepare(`SELECT id, title, directory, ${updated} FROM session LIMIT ?`)
      .all(MAX_OPEN_CODE_SESSIONS + 1) as OpenCodeRow[]
  } finally {
    database.close()
  }
}

function databaseFileItem(options: {
  source: CleanerSource
  filePath: string
  scanned: ScannedFile
  context: ScanItemContext
  title: string
}): CleanerItem {
  const { source, filePath, scanned, context, title } = options
  const id = makeItemId(filePath)
  const isProtected = context.protectedIds.has(id)
  const recent = Date.now() - scanned.stat.mtimeMs < context.settings.keepRecentDays * DAY_MS
  return {
    id,
    sourceId: source.id,
    title,
    path: filePath,
    bytes: scanned.stat.size,
    modifiedAt: scanned.stat.mtimeMs,
    category: 'sessions',
    status: isProtected ? 'protected' : recent ? 'recent' : 'read-only',
    reason: isProtected ? '已标记保护' : '数据库只读；未将数据库文件作为清理候选',
    files: [filePath],
    fingerprint: scanned.fingerprint
  }
}
