export type PercentageMode = 'remaining' | 'used'
export type RefreshMode = 'auto' | 'manual'
export type LocaleCode = 'zh-CN' | 'en-US'
export type RateLimitSource = 'official' | 'local' | 'none'
export type PanelView = 'details' | 'settings'
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
}

export interface AppSettings {
  refreshMode: RefreshMode
  refreshIntervalSeconds: number
  percentageMode: PercentageMode
  locale: LocaleCode
  launchAtLogin: boolean
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
}

export interface BootstrapPayload {
  settings: AppSettings
  window: WindowPreferences
  panel: PanelPreferences
  snapshot: UsageSnapshot
  role: RendererWindowRole
  panelView: PanelView
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
  onSnapshotUpdated: (listener: (snapshot: UsageSnapshot) => void) => () => void
  onPreferencesUpdated: (listener: (payload: PreferencesPayload) => void) => () => void
  onCommand: (listener: (payload: RendererCommandPayload) => void) => () => void
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
  width: 60,
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
  launchAtLogin: false
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
        : DEFAULT_SETTINGS.launchAtLogin
  }
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
