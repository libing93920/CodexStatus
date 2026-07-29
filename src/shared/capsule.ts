export type PercentageMode = 'remaining' | 'used'
export type RefreshMode = 'auto' | 'manual'
export type LocaleCode = 'zh-CN' | 'en-US'
export type RateLimitSource = 'official' | 'local' | 'none'
export type PanelView = 'details' | 'settings' | 'team'
export type RendererWindowRole = 'capsule' | 'panel'
export type CapsuleViewMode = 'capsule' | 'orb'
export type DockEdge = 'left' | 'right'
export type RendererCommandType = 'show-panel-view'

export interface RateLimitWindowSnapshot {
  id: string
  label: string
  windowMinutes?: number
  usedPercent?: number
  remainingPercent?: number
  resetsAt?: string
  resetsInSeconds?: number
  observedAt?: string
}

export interface UsageSnapshot {
  available: boolean
  isRefreshing: boolean
  canRefresh: boolean
  generatedAt?: string
  rateLimits: RateLimitWindowSnapshot[]
  rateLimitSource: RateLimitSource
  sourceHost: string
  issues: string[]
  officialIssue?: string
  filesScanned: number
  sessionsPath?: string
  /** 最近一张即将到期的重置卡;没有则不返回 */
  resetCredit?: {
    /** 最近一张重置卡的到期时间(ISO);null 表示永不过期 */
    expiresAt?: string
    /** 可用重置卡总数 */
    availableCount: number
  }
  /** Codex 雷达:IQ>=90 里性价比最高的模型 */
  bestModelPick?: {
    /** 短标签,例如 "Terra xhigh" */
    shortLabel: string
    /** 完整标签 */
    label: string
    /** IQ 分数 */
    score: number
    /** 每题平均美元成本 */
    averageCostUsd: number
    /** 每题平均耗时分钟 */
    averageTaskMinutes: number
    /** 状态色 */
    status: 'green' | 'yellow' | 'red'
  }
  /** 团队看板:同组成员的额度剩余状态;本期为主进程返回的 mock 数据,后续接 LAN service */
  teamPeers?: TeamPeer[]
}

/** 团队成员一行:排行榜展示 5h/7d 双窗口剩余额度% + 重置卡数量,按短窗口剩余降序排名 */
export interface TeamPeer {
  /** peer 标识 */
  id: string
  /** 昵称 */
  nickname: string
  /** 是否本机 */
  isSelf: boolean
  /** 剩余额度百分比(短窗口优先,排行主依据) */
  remainingPercent?: number
  /** 短窗口(5h):标签 + 剩余百分比 */
  shortWindow?: { label: string; remainingPercent?: number }
  /** 长窗口(7d):标签 + 剩余百分比 */
  longWindow?: { label: string; remainingPercent?: number }
  /** 可用重置卡数量 */
  resetCreditCount?: number
  /** 该 peer 最后更新时间(留作后续显示,本期 UI 不展示) */
  updatedAt?: string
}

export const DEFAULT_IQ_THRESHOLD = 90
export const MIN_IQ_THRESHOLD = 60
export const MAX_IQ_THRESHOLD = 115

export interface AppSettings {
  refreshMode: RefreshMode
  refreshIntervalSeconds: number
  percentageMode: PercentageMode
  locale: LocaleCode
  launchAtLogin: boolean
  iqThreshold: number
  /** 团队昵称(空时 UI 显示"我");仅作展示,不涉及凭据 */
  teamNickname?: string
  /** 团队组口令(同口令的 peer 才互见);空表示未加入团队 */
  teamGroup?: string
}

export interface WindowPreferences {
  x?: number
  y?: number
  viewMode: CapsuleViewMode
  dockEdge?: DockEdge
}

export interface PanelPreferences {
  x?: number
  y?: number
}

export interface PersistedState {
  settings: AppSettings
  window: WindowPreferences
  panel: PanelPreferences
  /** 本机 LAN 标识,跨重启稳定;首次启动生成 UUID */
  peerId?: string
}

export interface BootstrapPayload {
  settings: AppSettings
  window: WindowPreferences
  panel: PanelPreferences
  snapshot: UsageSnapshot
  role: RendererWindowRole
  panelView: PanelView
  /** 应用版本号,设置页展示用 */
  version: string
}

export interface PreferencesPayload {
  settings: AppSettings
  window: WindowPreferences
  panel: PanelPreferences
}

export interface CapsuleDragMovePayload {
  screenX: number
  screenY: number
  offsetX: number
  offsetY: number
}

export interface RendererCommandPayload {
  type: RendererCommandType
  panelView: PanelView
}

export interface CodexStatusApi {
  bootstrap: () => Promise<BootstrapPayload>
  refreshStatus: () => Promise<UsageSnapshot>
  updateSettings: (patch: Partial<AppSettings>) => Promise<PreferencesPayload>
  closePanel: () => Promise<void>
  moveCapsuleWindow: (payload: CapsuleDragMovePayload) => Promise<WindowPreferences>
  finishCapsuleWindowDrag: () => Promise<WindowPreferences>
  /** 在系统默认浏览器打开外链(Electron shell.openExternal),用于面板内链接跳转 */
  openExternal: (url: string) => Promise<void>
  /** 渲染层 bootstrap 完成后通知主进程显示 panel 窗口(避免空窗先闪) */
  notifyPanelReady: () => Promise<void>
  /** 胶囊窗口点击打开 panel 指定视图(主进程复用 openPanelWindow) */
  showPanel: (view: PanelView) => Promise<void>
  /** 手动检查 GitHub Releases 是否有新版本 */
  checkForUpdate: () => Promise<UpdateCheckResult>
  /** 下载已检测到的新版本安装包 */
  downloadUpdate: () => Promise<void>
  /** 退出并运行安装程序,覆盖升级 */
  installUpdate: () => Promise<void>
  onSnapshotUpdated: (listener: (snapshot: UsageSnapshot) => void) => () => void
  onPreferencesUpdated: (listener: (payload: PreferencesPayload) => void) => () => void
  onCommand: (listener: (payload: RendererCommandPayload) => void) => () => void
  /** 订阅更新进度/状态变化(checking/downloading/downloaded/error) */
  onUpdateProgress: (listener: (payload: UpdateProgress) => void) => () => void
}

/** 检查更新的结果;available=false 表示已是最新或不可用(如 dev 环境) */
export interface UpdateCheckResult {
  available: boolean
  version?: string
  releaseNotes?: string
}

/** 更新进度事件;stage 标识当前阶段,percent 仅 downloading 阶段有值 */
export interface UpdateProgress {
  stage: 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  percent?: number
  version?: string
  message?: string
}

export const REFRESH_INTERVAL_OPTIONS = [15, 30, 60, 120] as const
export const DEFAULT_REFRESH_INTERVAL_SECONDS = 30
export const MIN_REFRESH_INTERVAL_SECONDS = 5
export const MAX_REFRESH_INTERVAL_SECONDS = 600
export const CAPSULE_WINDOW_SIZE = {
  width: 250,
  height: 50
} as const

export const ORB_WINDOW_SIZE = {
  width: 50,
  height: 165
} as const

export const CAPSULE_EDGE_GAP = 0
export const CAPSULE_DOCK_EDGE_GAP = 0
export const CAPSULE_DOCK_THRESHOLD = 18
export const CAPSULE_UNDOCK_THRESHOLD = 42

export const PANEL_WINDOW_SIZE = {
  width: 480,
  height: 600
} as const

export const DEFAULT_SETTINGS: AppSettings = {
  refreshMode: 'auto',
  refreshIntervalSeconds: DEFAULT_REFRESH_INTERVAL_SECONDS,
  percentageMode: 'remaining',
  locale: 'zh-CN',
  launchAtLogin: false,
  iqThreshold: DEFAULT_IQ_THRESHOLD
}

export const DEFAULT_WINDOW_PREFERENCES: WindowPreferences = {
  viewMode: 'capsule'
}

export const DEFAULT_PANEL_PREFERENCES: PanelPreferences = {}

export function createEmptySnapshot(): UsageSnapshot {
  return {
    available: false,
    isRefreshing: false,
    canRefresh: true,
    rateLimits: [],
    rateLimitSource: 'none',
    sourceHost: 'No data',
    issues: [],
    filesScanned: 0
  }
}

export function normalizeSettings(input: Partial<AppSettings> | undefined): AppSettings {
  return {
    refreshMode: isRefreshMode(input?.refreshMode)
      ? input.refreshMode
      : DEFAULT_SETTINGS.refreshMode,
    refreshIntervalSeconds: normalizeRefreshInterval(input?.refreshIntervalSeconds),
    percentageMode: isPercentageMode(input?.percentageMode)
      ? input.percentageMode
      : DEFAULT_SETTINGS.percentageMode,
    locale: isLocaleCode(input?.locale) ? input.locale : DEFAULT_SETTINGS.locale,
    launchAtLogin:
      typeof input?.launchAtLogin === 'boolean'
        ? input.launchAtLogin
        : DEFAULT_SETTINGS.launchAtLogin,
    iqThreshold: normalizeIqThreshold(input?.iqThreshold),
    teamNickname: normalizeOptionalString(input?.teamNickname),
    teamGroup: normalizeOptionalString(input?.teamGroup)
  }
}

// 空串/undefined → undefined;非空 trim 后返回
function normalizeOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export function normalizeWindowPreferences(
  input: Partial<WindowPreferences> | undefined
): WindowPreferences {
  const viewMode = isCapsuleViewMode(input?.viewMode)
    ? input.viewMode
    : DEFAULT_WINDOW_PREFERENCES.viewMode
  const dockEdge = viewMode === 'orb' && isDockEdge(input?.dockEdge) ? input.dockEdge : undefined

  return {
    x: typeof input?.x === 'number' && Number.isFinite(input.x) ? Math.round(input.x) : undefined,
    y: typeof input?.y === 'number' && Number.isFinite(input.y) ? Math.round(input.y) : undefined,
    viewMode,
    dockEdge
  }
}

export function normalizePanelPreferences(
  input: Partial<PanelPreferences> | undefined
): PanelPreferences {
  return {
    x: typeof input?.x === 'number' && Number.isFinite(input.x) ? Math.round(input.x) : undefined,
    y: typeof input?.y === 'number' && Number.isFinite(input.y) ? Math.round(input.y) : undefined
  }
}

function normalizeRefreshInterval(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_REFRESH_INTERVAL_SECONDS
  }

  const normalized = Math.round(value as number)
  return Math.min(MAX_REFRESH_INTERVAL_SECONDS, Math.max(MIN_REFRESH_INTERVAL_SECONDS, normalized))
}

function normalizeIqThreshold(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_IQ_THRESHOLD
  }
  const n = Math.round(value as number)
  return Math.min(MAX_IQ_THRESHOLD, Math.max(MIN_IQ_THRESHOLD, n))
}

function isRefreshMode(value: unknown): value is RefreshMode {
  return value === 'auto' || value === 'manual'
}

function isPercentageMode(value: unknown): value is PercentageMode {
  return value === 'remaining' || value === 'used'
}

function isLocaleCode(value: unknown): value is LocaleCode {
  return value === 'zh-CN' || value === 'en-US'
}

function isCapsuleViewMode(value: unknown): value is CapsuleViewMode {
  return value === 'capsule' || value === 'orb'
}

function isDockEdge(value: unknown): value is DockEdge {
  return value === 'left' || value === 'right'
}
