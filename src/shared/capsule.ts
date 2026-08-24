export type PercentageMode = 'remaining' | 'used'
export type RefreshMode = 'auto' | 'manual'
export type LocaleCode = 'zh-CN' | 'en-US'
export type RateLimitSource = 'official' | 'local' | 'none'
export type AuthMode = 'chatgpt' | 'api' | 'none'
export type AgentId = 'codex' | 'claude' | 'opencode'
export type PanelView = 'details' | 'settings' | 'team'
export type RendererWindowRole = 'capsule' | 'panel'
export type CapsuleViewMode = 'capsule' | 'orb'
export type DockEdge = 'left' | 'right'
export type RendererCommandType = 'show-panel-view'
export type PanelFocusTarget = 'announcement' | 'messages'

/** 外观主题:6 套,midnight=默认深色青蓝(现状),其余对应 design-previews */
export type ThemeId = 'midnight' | 'aurora' | 'cyber' | 'titan' | 'poster' | 'arcade'
export const THEME_IDS: readonly ThemeId[] = [
  'midnight',
  'aurora',
  'cyber',
  'titan',
  'poster',
  'arcade'
] as const

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
  /** Codex 登录方式:chatgpt=订阅 OAuth,api=API Key,none=未识别 */
  authMode: AuthMode
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
  /** 登录方式:api=API Key(无订阅额度,额度榜不展示) */
  authMode?: AuthMode
  /** 剩余额度百分比(短窗口优先,排行主依据) */
  remainingPercent?: number
  /** 短窗口(5h):标签 + 剩余百分比 */
  shortWindow?: { label: string; remainingPercent?: number }
  /** 长窗口(7d):标签 + 剩余百分比 */
  longWindow?: { label: string; remainingPercent?: number }
  /** 可用重置卡数量 */
  resetCreditCount?: number
  /** 各窗口 token 消耗总数(1d/7d/30d);无数据的窗口不包含对应键 */
  tokenUsage?: Partial<Record<UsageWindow, number>>
  /** 各窗口各工具 token 消耗(团队榜分段用);缺省工具按 0 */
  tokenUsageByAgent?: Partial<Record<UsageWindow, Partial<Record<AgentId, number>>>>
  /** 应用版本:排行榜以组内最高版本为基准标绿/黄点 */
  appVersion?: string
  /** 该 peer 最后更新时间(留作后续显示,本期 UI 不展示) */
  updatedAt?: string
}

/** 局域网广播消息:同组单向事件,发一次是一次;无历史、仅实时 */
export interface BroadcastMessage {
  type: 'message'
  /** randomUUID,去重/未来升级聊天的锚点 */
  id: string
  senderPeerId: string
  senderNickname: string
  /** 发送时刻(ms epoch) */
  sentAt: number
  text: string
}

/** 当前运行期最新公告:沿用广播消息字段,text 已移除 #gg 标识 */
export type AnnouncementMessage = BroadcastMessage

/** 公告只存主进程内存;unread=false 表示已读,卡片仍保留到用户点击“已知” */
export interface AnnouncementState {
  message: AnnouncementMessage
  unread: boolean
}

/** 排行榜成员点赞事件:同组广播;接收端按目标成员聚合,同一发送者对同一成员以最后一次动作生效 */
export interface ReactionMessage {
  type: 'reaction'
  /** randomUUID */
  id: string
  senderPeerId: string
  targetPeerId: string
  /** add=点赞, remove=取消(toggle) */
  action: 'add' | 'remove'
  /** 事件时刻(ms epoch);超过 24h 自动过期,不参与计数 */
  sentAt: number
}

/** 发送点赞的结果:唯一失败场景是未加入团队 */
export type ReactionSendResult =
  | { ok: true; reaction: ReactionMessage }
  | { ok: false; reason: 'not-in-team' }

/** 发送广播的结果:ok=已广播;失败按原因区分,渲染层据此提示不同文案 */
export type BroadcastSendResult =
  | { ok: true; message: BroadcastMessage }
  | { ok: false; reason: 'not-in-team' | 'too-long' | 'rate-limited' }

export type UsageWindow = '1d' | '7d' | '30d'

/** 单日 token 用量与估算花费 */
export interface TokenUsageDay {
  /** 本地自然日 YYYY-MM-DD */
  date: string
  /** 总输入 token(含缓存) */
  input: number
  /** 其中缓存输入 token */
  cachedInput: number
  /** 总输出 token(含思考) */
  output: number
  /** 其中思考输出 token */
  reasoning: number
  /** 估算花费(USD) */
  cost: number
}

/** 单模型用量与花费(模型用量榜一行) */
export interface ModelUsage {
  /** 归一化模型名(去 provider 前缀/日期后缀),未识别为 unknown */
  model: string
  input: number
  cachedInput: number
  output: number
  reasoning: number
  total: number
  /** 估算/真实花费(USD) */
  cost: number
}

/** 1/7/30 天 token 用量统计总览 */
export interface TokenUsageOverview {
  available: boolean
  generatedAt: string
  /** 升序日期序列,长度=窗口天数,缺失日零填充 */
  days: TokenUsageDay[]
  totals: {
    input: number
    cachedInput: number
    output: number
    reasoning: number
    total: number
    cost: number
  }
  /** 按模型聚合的用量榜,按 total 降序 */
  models: ModelUsage[]
}

/** 单日真实账单花费(USD) */
export interface SpendDay {
  date: string
  cost: number
}

/** 1/7/30 天真实账单花费总览(仅 API Key 模式) */
export interface SpendUsage {
  available: boolean
  generatedAt: string
  /** 升序日期序列,长度=窗口天数 */
  days: SpendDay[]
  total: number
}

export const DEFAULT_IQ_THRESHOLD = 90
export const MIN_IQ_THRESHOLD = 60
export const MAX_IQ_THRESHOLD = 115

export interface AppSettings {
  refreshMode: RefreshMode
  refreshIntervalSeconds: number
  percentageMode: PercentageMode
  locale: LocaleCode
  /** 当前监控的 Agent 工具(Codex/Claude/OpenCode),决定扫描数据源 */
  agentId: AgentId
  launchAtLogin: boolean
  iqThreshold: number
  /** 团队昵称(空时 UI 显示"我");仅作展示,不涉及凭据 */
  teamNickname?: string
  /** 团队组口令(同口令的 peer 才互见);空表示未加入团队 */
  teamGroup?: string
  /** 外观主题;midnight=默认深色青蓝 */
  theme: ThemeId
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
  /** 打开设置页后定位到检查更新区域(胶囊版本角标跳转用) */
  focusUpdate?: boolean
  /** 胶囊提醒点击后在目标 panel 内定位到具体区域 */
  focusTarget?: PanelFocusTarget
  /** 当前运行期最新公告;进程退出后自然清空 */
  announcement: AnnouncementState | null
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
  /** 打开设置页后定位到检查更新区域(胶囊版本角标跳转用) */
  focusUpdate?: boolean
  focusTarget?: PanelFocusTarget
}

export interface ShowPanelOptions {
  focusUpdate?: boolean
  focusTarget?: PanelFocusTarget
  /** 提醒跳转必须显示并聚焦 panel,不能沿用普通点击的显隐切换 */
  forceOpen?: boolean
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
  /** 胶囊有数据后通知主进程显示窗口(无数据不显示,避免先大后小闪烁) */
  notifyCapsuleReady: () => Promise<void>
  /** 胶囊窗口点击打开 panel 指定视图(主进程复用 openPanelWindow);focusUpdate 定位到检查更新区 */
  showPanel: (view: PanelView, options?: ShowPanelOptions) => Promise<void>
  /** 手动检查 GitHub Releases 是否有新版本 */
  checkForUpdate: () => Promise<UpdateCheckResult>
  /** 获取 1/7/30 天 token 用量与估算花费(按需拉取,不走快照广播) */
  getTokenUsage: (window: UsageWindow) => Promise<TokenUsageOverview>
  /** 获取自定义起止时间(毫秒)区间内的 token 用量与估算花费(本地扫描,边界精确到毫秒) */
  getTokenUsageRange: (startMs: number, endMs: number) => Promise<TokenUsageOverview>
  /** 获取 1/7/30 天真实账单花费(仅 API Key 模式;不可用返回 available:false) */
  getSpendUsage: (window: UsageWindow) => Promise<SpendUsage>
  /** 胶囊窗口按内容自适应尺寸(渲染层量内容后调用;主进程 setSize) */
  setCapsuleSize: (size: { width: number; height: number }) => Promise<void>
  /** 下载已检测到的新版本安装包 */
  downloadUpdate: () => Promise<void>
  /** 退出并运行安装程序,覆盖升级 */
  installUpdate: () => Promise<void>
  onSnapshotUpdated: (listener: (snapshot: UsageSnapshot) => void) => () => void
  onPreferencesUpdated: (listener: (payload: PreferencesPayload) => void) => () => void
  onCommand: (listener: (payload: RendererCommandPayload) => void) => () => void
  /** 订阅更新进度/状态变化(checking/downloading/downloaded/error) */
  onUpdateProgress: (listener: (payload: UpdateProgress) => void) => () => void
  /** 发送一条局域网广播消息(同组可见);失败时返回原因供渲染层区分提示 */
  sendBroadcast: (text: string) => Promise<BroadcastSendResult>
  /** 订阅收到同组广播消息(含自己发出的回显,由 senderPeerId 区分) */
  onBroadcastMessage: (listener: (message: BroadcastMessage) => void) => () => void
  /** 公告卡片进入前台可视区后按 id 标记已读 */
  markAnnouncementRead: (id: string) => Promise<void>
  /** 用户主动确认“已知”;仅清除 id 匹配的当前公告 */
  acknowledgeAnnouncement: (id: string) => Promise<void>
  onAnnouncementUpdated: (listener: (state: AnnouncementState | null) => void) => () => void
  /** 给某成员点赞/取消(toggle):action 由渲染层按当前已赞状态决定;主进程回显给自己,所有端各自聚合 */
  sendReaction: (targetPeerId: string, action: 'add' | 'remove') => Promise<ReactionSendResult>
  /** 订阅收到同组点赞事件(含自己回显,由 senderPeerId 区分) */
  onReaction: (listener: (reaction: ReactionMessage) => void) => () => void
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
  agentId: 'codex',
  launchAtLogin: false,
  iqThreshold: DEFAULT_IQ_THRESHOLD,
  theme: 'midnight'
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
    authMode: 'none',
    rateLimits: [],
    rateLimitSource: 'none',
    sourceHost: 'No data',
    issues: [],
    filesScanned: 0
  }
}

/** 非 Codex 工具的最小快照:无额度窗口/重置卡/雷达,固定 api 模式;用量/花费由 provider 扫描单独供给 */
export function createApiModeSnapshot(): UsageSnapshot {
  return {
    available: false,
    isRefreshing: false,
    canRefresh: true,
    authMode: 'api',
    generatedAt: new Date().toISOString(),
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
    agentId: isAgentId(input?.agentId) ? input.agentId : DEFAULT_SETTINGS.agentId,
    launchAtLogin:
      typeof input?.launchAtLogin === 'boolean'
        ? input.launchAtLogin
        : DEFAULT_SETTINGS.launchAtLogin,
    iqThreshold: normalizeIqThreshold(input?.iqThreshold),
    teamNickname: normalizeOptionalString(input?.teamNickname),
    teamGroup: normalizeOptionalString(input?.teamGroup),
    theme: isThemeId(input?.theme) ? input.theme : DEFAULT_SETTINGS.theme
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

function isAgentId(value: unknown): value is AgentId {
  return value === 'codex' || value === 'claude' || value === 'opencode'
}

function isThemeId(value: unknown): value is ThemeId {
  return (
    value === 'midnight' ||
    value === 'aurora' ||
    value === 'cyber' ||
    value === 'titan' ||
    value === 'poster' ||
    value === 'arcade'
  )
}
