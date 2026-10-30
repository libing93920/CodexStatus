import type { CleanerIssue } from '../../../shared/session-cleaner.ts'

/** 对齐 cc-switch v4.0.21 SessionMeta；占用与回收校验由清理器单独处理。 */
export interface CatalogSession {
  sessionId: string
  path: string
  title?: string
  summary?: string
  project?: string
  createdAt?: number
  modifiedAt?: number
}

export interface CatalogResult {
  sessions: CatalogSession[]
  issues: CleanerIssue[]
}
