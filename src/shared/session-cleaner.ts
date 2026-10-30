import type {
  AgentStorageSummary,
  ManagedSession,
  SessionDetails,
  SessionBlockContent,
  SessionMutationPreview,
  SessionResource
} from './session-manager.ts'

export const CLEANER_CHANNELS = {
  open: 'session-cleaner:open',
  state: 'session-cleaner:state',
  discover: 'session-cleaner:discover',
  importSource: 'session-cleaner:import-source',
  removeSource: 'session-cleaner:remove-source',
  scan: 'session-cleaner:scan',
  cancel: 'session-cleaner:cancel',
  protect: 'session-cleaner:protect',
  settings: 'session-cleaner:settings',
  review: 'session-cleaner:review',
  recycle: 'session-cleaner:recycle',
  details: 'session-cleaner:details',
  transcript: 'session-cleaner:transcript',
  blockContent: 'session-cleaner:block-content',
  exportSessions: 'session-cleaner:export',
  resume: 'session-cleaner:resume',
  compact: 'session-cleaner:compact',
  cancelOperation: 'session-cleaner:cancel-operation',
  reveal: 'session-cleaner:reveal',
  recycleBin: 'session-cleaner:recycle-bin',
  progress: 'session-cleaner:progress',
  scanRequested: 'session-cleaner:scan-requested',
  windowMinimize: 'session-cleaner:window-minimize',
  windowToggleMaximize: 'session-cleaner:window-toggle-maximize',
  windowClose: 'session-cleaner:window-close',
  windowIsMaximized: 'session-cleaner:window-is-maximized',
  windowMaximized: 'session-cleaner:window-maximized'
} as const

export type CleanerSourceKind =
  | 'codex'
  | 'claude'
  | 'opencode'
  | 'pi'
  | 'gemini'
  | 'openclaw'
  | 'hermes'
  | 'grokbuild'
  | 'omp'
  | 'mcode'
  | 'kimi'
  | 'agy'
  | 'cline'
  | 'aider'
  | 'unknown'

export interface CleanerSource {
  id: string
  kind: CleanerSourceKind
  name: string
  path: string
  origin: 'discovered' | 'manual'
  capability: 'sessions' | 'files'
  note: string
  /** 相对会话目录缺少启动项目上下文时，禁止猜测默认位置。 */
  unavailable?: boolean
  layout?: 'flat' | 'projects'
  databasePath?: string
  configPath?: string
}

export interface CleanerSettings {
  keepRecentDays: number
  olderSessionDays: number
  logAgeDays: number
  alertGiB: number
}

export const DEFAULT_CLEANER_SETTINGS: CleanerSettings = {
  keepRecentDays: 14,
  olderSessionDays: 90,
  logAgeDays: 30,
  alertGiB: 10
}

export type CleanerItemStatus = 'candidate' | 'protected' | 'recent' | 'read-only' | 'active'

export interface CleanerItem {
  id: string
  sourceId: string
  title: string
  path: string
  project?: string
  sessionId?: string
  summary?: string
  createdAt?: number
  bytes: number
  modifiedAt: number
  category: 'sessions' | 'resources' | 'logs' | 'unknown'
  status: CleanerItemStatus
  reason: string
  files: string[]
  /** 扫描时的文件身份，仅供执行前核验；渲染层不能修改审核清单。 */
  fingerprint: string
  managed?: ManagedSession
  recommendation?: 'old' | 'recent' | 'normal'
}

export interface CleanerIssue {
  path: string
  message: string
}

export interface CleanerProgress {
  visited: number
  bytes: number
  phase?: 'scan' | 'delete' | 'export' | 'compact'
  completed?: number
  total?: number
}

export interface CleanerScanResult {
  items: CleanerItem[]
  issues: CleanerIssue[]
  cancelled: boolean
  scannedAt: number
  resources?: SessionResource[]
  storage?: AgentStorageSummary[]
}

export interface CleanerRecord {
  id: string
  batchId: string
  sourceId: string
  title: string
  path: string
  bytes: number
  at: number
  status: 'recycled' | 'deleted' | 'exported' | 'compacted' | 'failed' | 'skipped' | 'pending'
  reason?: string
  logicalBytes?: number
  fileBytesAfter?: number
}

export interface CleanerState {
  sources: CleanerSource[]
  items: CleanerItem[]
  issues: CleanerIssue[]
  settings: CleanerSettings
  records: CleanerRecord[]
  scannedAt?: number
  scanning: boolean
  recycling: boolean
  disks: Array<{ path: string; available: number; total: number }>
  resources?: SessionResource[]
  storage?: AgentStorageSummary[]
  deletionMode?: 'permanent'
}

export interface CleanerPlan {
  id: string
  createdAt: number
  items: CleanerItem[]
  totalBytes: number
  excluded: Array<{ id: string; reason: string }>
  previews?: SessionMutationPreview[]
  logicalBytes?: number
  warnings?: string[]
  deletionMode?: 'permanent'
}

export interface SessionCleanerApi {
  getState: () => Promise<CleanerState>
  discover: () => Promise<CleanerState>
  importSource: () => Promise<CleanerState>
  removeSource: (id: string) => Promise<CleanerState>
  scan: () => Promise<CleanerState>
  cancelScan: () => Promise<void>
  protect: (ids: string[], protectedValue: boolean) => Promise<CleanerState>
  saveSettings: (settings: CleanerSettings) => Promise<CleanerState>
  review: (ids: string[]) => Promise<CleanerPlan>
  recycle: (planId: string) => Promise<CleanerState>
  details: (id: string) => Promise<string>
  transcript: (id: string) => Promise<SessionDetails>
  blockContent: (id: string, reference: unknown, offset?: number) => Promise<SessionBlockContent>
  exportSessions: (ids: string[]) => Promise<{ count: number; cancelled: boolean }>
  resumeSession: (id: string) => Promise<void>
  compactDatabase: (sourceId: string) => Promise<CleanerState>
  cancelOperation: () => Promise<void>
  reveal: (id: string) => Promise<void>
  openRecycleBin: () => Promise<void>
  minimizeWindow: () => void
  toggleMaximizeWindow: () => void
  closeWindow: () => void
  isWindowMaximized: () => Promise<boolean>
  onWindowMaximized: (listener: (maximized: boolean) => void) => () => void
  onScanRequested: (listener: () => void) => () => void
  onProgress: (listener: (progress: CleanerProgress) => void) => () => void
}
