import type { CleanerSourceKind } from './session-cleaner.ts'

export interface SessionCapabilities {
  read: boolean
  delete: boolean
  export: boolean
  resume: boolean
  deleteReason?: string
}

/** 数据库载荷与文件字节不可相加为预计释放空间。 */
export interface SessionStorage {
  kind: 'file' | 'sqlite' | 'directory'
  fileBytes: number
  logicalBytes?: number
  sharedBytes: number
  complete: boolean
}

export interface SessionResource {
  id: string
  sourceId: string
  sourceIds?: string[]
  path: string
  kind: 'transcript' | 'attachment' | 'database' | 'wal' | 'log' | 'other'
  bytes: number
  sessionIds: string[]
  shared: boolean
}

export interface SessionReference {
  providerId: CleanerSourceKind
  sourceId: string
  sessionId: string
  sourcePath: string
}

export interface ManagedSession extends SessionReference {
  storagePath?: string
  title?: string
  summary?: string
  projectDir?: string
  createdAt?: number
  lastActiveAt?: number
  parentSessionId?: string
  modelIds: string[]
  messageCount?: number
  resumeCommand?: string
  capabilities: SessionCapabilities
  storage: SessionStorage
  resourceIds: string[]
  revision: string
}

export interface AgentStorageSummary {
  sourceId: string
  fileBytes: number
  databaseBytes: number
  walBytes: number
  sharedBytes: number
  otherBytes: number
  databaseFreeBytes?: number
  complete: boolean
}

/** 正文以结构化 JSON 传递；渲染时不执行其中的 HTML 或命令。 */
export interface SessionMessage {
  role: string
  content: string
  [key: string]: unknown
}

export interface SessionDetails {
  messages: SessionMessage[]
  resources: SessionResource[]
}

export interface SessionBlockContent {
  text: string
  totalLen: number
  truncated: boolean
  nextOffset?: number
}

export interface SessionMutationPreview {
  session: SessionReference
  revision: string
  files: string[]
  logicalBytes?: number
  fileBytes: number
  warnings: string[]
}

export interface SessionMutationResult {
  session: SessionReference
  deleted: boolean
  fileBytesBefore: number
  fileBytesAfter: number
  reason?: string
}
