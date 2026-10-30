import { lstat } from 'node:fs/promises'
import path from 'node:path'
import type { CleanerSource } from '../../../shared/session-cleaner.ts'
import type { CatalogResult } from './catalog-types.ts'
import { checkAbort, errorText, string } from './catalog-io.ts'

const DATABASE_RELATIVE_PATH = ['v2', 'sqlite', 'runtime-state.sqlite']
const DATABASE_QUERY = `
  SELECT session_id, title, workspace_dir, created_at_ms, updated_at_ms
  FROM local_runtime_sessions
  WHERE visibility <> 'hidden' AND archived = 0
    AND parent_session_id IS NULL
    AND session_kind NOT IN ('peek', 'channel', 'cron')
  ORDER BY updated_at_ms DESC
`

export async function scanMCodeCatalog(
  source: CleanerSource,
  signal?: AbortSignal
): Promise<CatalogResult> {
  const result: CatalogResult = { sessions: [], issues: [] }
  const databasePath = path.join(source.path, ...DATABASE_RELATIVE_PATH)
  try {
    const rootInfo = await lstat(source.path)
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      result.issues.push({ path: source.path, message: 'MCode 来源不是普通目录；未跟随链接' })
      return result
    }
    const databaseInfo = await lstat(databasePath)
    if (!databaseInfo.isFile() || databaseInfo.isSymbolicLink()) {
      result.issues.push({ path: databasePath, message: 'MCode 数据库不是普通文件；保持只读' })
      return result
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      result.issues.push({ path: databasePath, message: errorText(error) })
    return result
  }
  checkAbort(signal)

  let database: { prepare(sql: string): { all(...values: unknown[]): unknown[] }; close(): void }
  try {
    const { DatabaseSync } = await import('node:sqlite')
    database = new DatabaseSync(databasePath, { readOnly: true }) as typeof database
  } catch (error) {
    result.issues.push({ path: databasePath, message: errorText(error) })
    return result
  }
  try {
    for (const value of database.prepare(DATABASE_QUERY).all()) {
      checkAbort(signal)
      const row = object(value)
      const sessionId = string(row.session_id)
      if (sessionId === undefined) continue
      const project = typeof row.workspace_dir === 'string' ? row.workspace_dir : undefined
      result.sessions.push({
        sessionId,
        path: databasePath,
        ...(typeof row.title === 'string' ? { title: row.title } : {}),
        ...(project !== undefined ? { project } : {}),
        createdAt: milliseconds(row.created_at_ms),
        modifiedAt: milliseconds(row.updated_at_ms)
      })
    }
  } catch (error) {
    checkAbort(signal)
    result.issues.push({ path: databasePath, message: errorText(error) })
  } finally {
    database.close()
  }
  return result
}

function milliseconds(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.trunc(parsed)
  }
  return undefined
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
