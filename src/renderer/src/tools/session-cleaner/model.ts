import type {
  CleanerItem,
  CleanerRecord,
  CleanerSettings,
  CleanerSource,
  CleanerSourceKind,
  CleanerItemStatus
} from '../../../../shared/session-cleaner'

export type PageId =
  | 'overview'
  | 'items'
  | 'sources'
  | 'review'
  | 'records'
  | 'policy'
  | 'analytics'
export type ItemCategoryFilter = 'all' | CleanerItem['category']
export type ItemStatusFilter = 'all' | CleanerItemStatus
export type CleanerSettingsDraft = Record<keyof CleanerSettings, string>
export type ChartTone = 'green' | 'blue' | 'amber' | 'violet'

export interface ItemFilters {
  query: string
  category: ItemCategoryFilter
  status: ItemStatusFilter
  deletion: 'all' | 'allowed' | 'blocked'
  sourceId: string
  agentKinds: CleanerSourceKind[]
  sourceIds: string[]
  project: string
  createdAfter: string
  createdBefore: string
  minimumIdleDays: number | null
  maximumIdleDays: number | null
  modelIds: string[]
  minimumMessageCount: number | null
  maximumMessageCount: number | null
  relationship: 'all' | 'parent' | 'child' | 'both' | 'unavailable'
  sizeBasis: 'session' | 'attributed' | 'file' | 'logical'
  minimumAgeDays: number
  minimumBytes: number
  maximumBytes: number | null
  sort: 'recommended' | 'size-desc' | 'oldest' | 'newest'
}

export const DEFAULT_ITEM_FILTERS: ItemFilters = {
  query: '',
  category: 'sessions',
  status: 'all',
  deletion: 'all',
  sourceId: 'all',
  agentKinds: [],
  sourceIds: [],
  project: '',
  createdAfter: '',
  createdBefore: '',
  minimumIdleDays: null,
  maximumIdleDays: null,
  modelIds: [],
  minimumMessageCount: null,
  maximumMessageCount: null,
  relationship: 'all',
  sizeBasis: 'session',
  minimumAgeDays: 0,
  minimumBytes: 0,
  maximumBytes: null,
  sort: 'newest'
}

export const ITEM_AGE_FILTERS = [
  { label: '全部时间', days: 0 },
  { label: '超过 30 天', days: 30 },
  { label: '超过 90 天', days: 90 }
]
export const ITEM_SIZE_FILTERS = [
  { label: '所有大小', bytes: 0 },
  { label: '100 MB 以上', bytes: 100 * 1024 ** 2 },
  { label: '1 G 以上', bytes: 1024 ** 3 }
]
export interface CleanerRecordBatch {
  batchId: string
  records: CleanerRecord[]
  latestAt: number
  totalBytes: number
}

const BYTES_PER_UNIT = 1024
const BYTES_PER_MEGABYTE = BYTES_PER_UNIT ** 2
const BYTE_UNITS = [
  { size: BYTES_PER_UNIT ** 4, label: 'T' },
  { size: BYTES_PER_UNIT ** 3, label: 'G' },
  { size: BYTES_PER_MEGABYTE, label: 'MB' },
  { size: BYTES_PER_UNIT, label: 'KB' }
] as const
const MIN_POLICY_DAYS = 1
const MAX_POLICY_DAYS = 3650
const MAX_ALERT_GIB = 100_000

const CATEGORY_LABELS: Record<CleanerItem['category'], string> = {
  sessions: '会话',
  resources: '资源',
  logs: '日志',
  unknown: '未知类型'
}

const STATUS_LABELS: Record<CleanerItemStatus, string> = {
  candidate: '已识别',
  protected: '已保护',
  recent: '近期活动',
  'read-only': '能力受限',
  active: '正在使用'
}

const STATUS_REASONS: Record<CleanerItemStatus, string> = {
  candidate: '扫描已识别；是否可删除由独立能力与预览决定。',
  protected: '此项已受保护。',
  recent: '建议近期保留；此建议不覆盖来源明确提供的删除能力。',
  'read-only': '当前来源未提供此操作能力。',
  active: '宿主正在使用此会话。'
}

const SOURCE_KIND_LABELS: Record<CleanerSourceKind, string> = {
  codex: 'Codex',
  claude: 'Claude',
  opencode: 'OpenCode',
  pi: 'Pi',
  gemini: 'Gemini',
  openclaw: 'OpenClaw',
  hermes: 'Hermes',
  grokbuild: 'Grok Build',
  omp: 'Oh My Pi',
  mcode: 'MCode',
  kimi: 'Kimi Code',
  agy: 'Antigravity',
  cline: 'Cline',
  aider: 'Aider',
  unknown: '未识别来源'
}

const RECORD_STATUS_LABELS: Record<CleanerRecord['status'], string> = {
  recycled: '已移入回收站',
  deleted: '已永久删除',
  exported: '已导出',
  compacted: '数据库已整理',
  failed: '操作失败',
  skipped: '已跳过',
  pending: '结果待人工核对'
}

export function getCandidateIds(items: CleanerItem[], selectedIds?: string[]): string[] {
  const selected = selectedIds ? new Set(selectedIds) : null
  return items
    .filter((item) => item.status === 'candidate' && (!selected || selected.has(item.id)))
    .map((item) => item.id)
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知'
  if (bytes < BYTES_PER_UNIT) return `${Math.round(bytes)} B`
  const unit = BYTE_UNITS.find(({ size }) => bytes >= size)
  if (!unit) return `${Math.round(bytes)} B`
  const value = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(
    bytes / unit.size
  )
  return `${value} ${unit.label}`
}

// 共享数据库容量不能按其中的每条会话重复计入。
export function formatItemSize(item: Pick<CleanerItem, 'bytes' | 'path'>): string {
  if (item.bytes === 0 && /\.(db|sqlite|sqlite3)$/i.test(item.path)) return '共享数据库'
  return formatBytes(item.bytes)
}

export function formatDateTime(timestamp?: number): string {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return '暂无记录'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(timestamp)
}

export function categoryLabel(category: CleanerItem['category']): string {
  return CATEGORY_LABELS[category]
}

export function statusLabel(status: CleanerItemStatus): string {
  return STATUS_LABELS[status]
}

export function statusReason(item: CleanerItem): string {
  return item.reason || STATUS_REASONS[item.status]
}

export function sourceKindLabel(kind: CleanerSourceKind): string {
  return SOURCE_KIND_LABELS[kind]
}

export function recordStatusLabel(status: CleanerRecord['status']): string {
  return RECORD_STATUS_LABELS[status]
}

export function groupRecordsByBatch(records: CleanerRecord[]): CleanerRecordBatch[] {
  const batches = new Map<string, CleanerRecordBatch>()
  for (const record of records) {
    const batch = batches.get(record.batchId) ?? {
      batchId: record.batchId,
      records: [],
      latestAt: record.at,
      totalBytes: 0
    }
    batch.records.push(record)
    batch.latestAt = Math.max(batch.latestAt, record.at)
    batch.totalBytes += record.bytes
    batches.set(record.batchId, batch)
  }
  return [...batches.values()].sort((left, right) => right.latestAt - left.latestAt)
}

export function settingsToDraft(settings: CleanerSettings): CleanerSettingsDraft {
  return {
    keepRecentDays: String(settings.keepRecentDays),
    olderSessionDays: String(settings.olderSessionDays),
    logAgeDays: String(settings.logAgeDays),
    alertGiB: String(settings.alertGiB)
  }
}

export function settingsDraftError(draft: CleanerSettingsDraft): string | null {
  const keepRecentDays = Number(draft.keepRecentDays)
  const olderSessionDays = Number(draft.olderSessionDays)
  const logAgeDays = Number(draft.logAgeDays)
  const alertGiB = Number(draft.alertGiB)
  const days = [keepRecentDays, olderSessionDays, logAgeDays]
  if (Object.values(draft).some((value) => value.trim() === '')) return '所有策略字段都必须填写。'
  if (
    !days.every(
      (value) => Number.isInteger(value) && value >= MIN_POLICY_DAYS && value <= MAX_POLICY_DAYS
    )
  )
    return `天数必须是 ${MIN_POLICY_DAYS}–${MAX_POLICY_DAYS} 的整数。`
  if (!Number.isInteger(alertGiB) || alertGiB < MIN_POLICY_DAYS || alertGiB > MAX_ALERT_GIB)
    return `空间提醒必须是 ${MIN_POLICY_DAYS}–${MAX_ALERT_GIB} G 的整数。`
  if (olderSessionDays < keepRecentDays || logAgeDays < keepRecentDays)
    return '会话和日志期限不能短于近期保留天数。'
  return null
}

export function parseSettingsDraft(draft: CleanerSettingsDraft): CleanerSettings | null {
  if (settingsDraftError(draft)) return null
  return {
    keepRecentDays: Number(draft.keepRecentDays),
    olderSessionDays: Number(draft.olderSessionDays),
    logAgeDays: Number(draft.logAgeDays),
    alertGiB: Number(draft.alertGiB)
  }
}

export function settingsEqual(left: CleanerSettings, right: CleanerSettings): boolean {
  return (
    left.keepRecentDays === right.keepRecentDays &&
    left.olderSessionDays === right.olderSessionDays &&
    left.logAgeDays === right.logAgeDays &&
    left.alertGiB === right.alertGiB
  )
}

export function sourcesEqual(left: CleanerSource[], right: CleanerSource[]): boolean {
  const signature = (sources: CleanerSource[]): string =>
    JSON.stringify(
      [...sources]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((source) => [
          source.id,
          source.kind,
          source.name,
          source.path,
          source.origin,
          source.capability,
          source.note,
          source.layout,
          source.unavailable,
          source.databasePath,
          source.configPath
        ])
    )
  return signature(left) === signature(right)
}
