import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import {
  DEFAULT_IQ_THRESHOLD,
  DEFAULT_SETTINGS,
  DEFAULT_WINDOW_PREFERENCES,
  CAPSULE_MINIMAL_TRIGGER_MS,
  CAPSULE_MINIMAL_WINDOW_SIZE,
  MAX_IQ_THRESHOLD,
  MIN_IQ_THRESHOLD,
  REFRESH_INTERVAL_OPTIONS,
  MAX_REFRESH_INTERVAL_SECONDS,
  MIN_REFRESH_INTERVAL_SECONDS,
  createEmptySnapshot,
  type AnnouncementState,
  type AppSettings,
  type BroadcastMessage,
  type LocaleCode,
  type PanelFocusTarget,
  type PanelView,
  type PercentageMode,
  type ReactionMessage,
  type RendererWindowRole,
  type ThemeId,
  type TokenUsageOverview,
  type UsageSnapshot,
  type UsageWindow,
  type WindowPreferences
} from '../../shared/capsule'
import { formatAnnouncementTime, resolveCapsuleAlert } from '../../shared/announcement'
import { createEmptyIslandSnapshot, type IslandSnapshot } from '../../shared/island'
import { IslandSettingsCard } from './island/IslandSettingsCard'
import { COPY, HEART_EFFECT_KINDS, THEME_OPTIONS, type HeartEffectKind } from './copy'
import {
  CloseIcon,
  HourglassIcon,
  RefreshIcon,
  ResetIcon,
  SparkleIcon,
  TicketIcon
} from './components/icons'
import { HeartEffect } from './components/HeartEffect'
import { MinimalCapsule } from './MinimalCapsule'
import { PANEL_TAB_MOTION_CLEAR_MS } from './ui-constants'
import { ApiCapsuleStat, QuotaCard, UsageCard, WindowKeeperStatusCard } from './components/usage'
import {
  DetailRow,
  PanelTabs,
  SegmentedControl,
  SettingField,
  TeamRow,
  TokenRow,
  ToggleSwitch
} from './components/controls'
import {
  compareSemver,
  createMetricProgressStyle,
  fitFontSize,
  formatAbsoluteDate,
  formatCapsuleTokens,
  formatCountdownCapsule,
  formatCountdownShort,
  formatModelPick,
  formatRelativeDate,
  isFixedRefreshInterval,
  localDayKey,
  normalizeCustomRefreshInterval,
  resolveModelColor
} from './formatters'
import { clampProgressPercent, resolveMinimalMetricColor } from './minimal-quota'

const DEFAULT_CUSTOM_REFRESH_INTERVAL_SECONDS = 40
const CAPSULE_CLICK_DRAG_DISTANCE = 5
const MANUAL_REFRESH_FEEDBACK_MS = 680
const TEAM_BOARD_MOTION_CLEAR_MS = 1360
// 广播消息:胶囊进入消息态后无操作 N 毫秒自动回额度;panel 会话内消息流上限
const BROADCAST_REVERT_MS = 15000
const BROADCAST_FEED_LIMIT = 3
// 跑马灯时长随文本长度线性,夹在 6s~20s 之间
const CAPSULE_MARQUEE_MIN_MS = 6000
const CAPSULE_MARQUEE_MAX_MS = 20000
const CAPSULE_MARQUEE_PER_CHAR_MS = 80
// 点赞特效:播放时长(覆盖胶囊后淡出恢复),连赞会重新播放并刷新计时
const HEART_EFFECT_DURATION_MS = 2400
const CAPSULE_MINIMAL_COLLAPSE_MS = 200
const CAPSULE_MINIMAL_LEAVE_MS = 120
const CAPSULE_MINIMAL_REVEAL_MS = 240
type CapsuleMinimalStage = 'full' | 'collapsing' | 'minimal' | 'expanding'
// 点赞过期按本地自然日(与 token 榜 1d 窗口同为自然日),跨天即清零,避免滚动24h与榜单错位

interface CapsulePointerState {
  pointerId: number
  originScreenX: number
  originScreenY: number
  offsetX: number
  offsetY: number
  hasDragged: boolean
}

function App(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<UsageSnapshot>(() => createEmptySnapshot())
  // API Key 模式胶囊:今日 token 用量(取 1d 窗口,算缓存命中率与今日用量)
  const [capsuleToday, setCapsuleToday] = useState<TokenUsageOverview | undefined>(undefined)
  const [settings, setSettings] = useState<AppSettings>({ ...DEFAULT_SETTINGS })
  const [islandSnapshot, setIslandSnapshot] = useState<IslandSnapshot>(createEmptyIslandSnapshot)
  const [windowPreferences, setWindowPreferences] = useState<WindowPreferences>({
    ...DEFAULT_WINDOW_PREFERENCES
  })
  const [windowRole, setWindowRole] = useState<RendererWindowRole>('capsule')
  const [panelView, setPanelView] = useState<PanelView>('details')
  const [panelRevealRequest, setPanelRevealRequest] = useState(0)
  const [tabMotionView, setTabMotionView] = useState<PanelView | null>(null)
  const [customRefreshInput, setCustomRefreshInput] = useState(
    String(DEFAULT_SETTINGS.refreshIntervalSeconds)
  )
  const [iqThresholdInput, setIqThresholdInput] = useState(
    String(DEFAULT_SETTINGS.iqThreshold ?? DEFAULT_IQ_THRESHOLD)
  )
  const [teamNicknameInput, setTeamNicknameInput] = useState(DEFAULT_SETTINGS.teamNickname ?? '')
  const [teamGroupInput, setTeamGroupInput] = useState(DEFAULT_SETTINGS.teamGroup ?? '')
  // 团队页排行榜模式:quota=额度, tokens=Token 消耗;消耗模式再选 1d/7d/30d 窗口
  const [teamBoardMode, setTeamBoardMode] = useState<'quota' | 'tokens'>('quota')
  const [teamTokenWindow, setTeamTokenWindow] = useState<UsageWindow>('1d')
  const [teamBoardMotionActive, setTeamBoardMotionActive] = useState(false)
  const [capsulePointerActive, setCapsulePointerActive] = useState(false)
  const [minimalStage, setMinimalStage] = useState<CapsuleMinimalStage>('full')
  const [pointerInsideCapsule, setPointerInsideCapsule] = useState(false)
  const [minimalReveal, setMinimalReveal] = useState(false)
  const [minimalBallSize, setMinimalBallSize] = useState<number>(CAPSULE_MINIMAL_WINDOW_SIZE.width)
  const [manualRefreshActive, setManualRefreshActive] = useState(false)
  const [appVersion, setAppVersion] = useState('')
  // 在线更新状态机:idle/checking/upToDate/available/downloading/downloaded/error
  // upToDate:检查完无更新(或 dev 环境),提示几秒后回 idle
  const [updateState, setUpdateState] = useState<
    'idle' | 'checking' | 'upToDate' | 'available' | 'downloading' | 'downloaded' | 'error'
  >('idle')
  const [updateVersion, setUpdateVersion] = useState('')
  const [updateProgress, setUpdateProgress] = useState(0)
  const [updateError, setUpdateError] = useState('')
  // 刷新完成后短暂触发百分比"弹跳"反馈,让用户感知新数据到达
  const [justRefreshed, setJustRefreshed] = useState(false)
  const [ready, setReady] = useState(false)
  // 胶囊版本角标跳转:打开设置页后需定位到检查更新区(一次性,滚动后清除)
  const [focusUpdatePending, setFocusUpdatePending] = useState(false)
  const [focusTargetPending, setFocusTargetPending] = useState<PanelFocusTarget | null>(null)
  const aboutRowRef = useRef<HTMLDivElement | null>(null)
  // 详情面板里长窗口(周重置)倒计时需要秒级刷新;只在面板可见且有长窗口时 tick
  const [nowTick, setNowTick] = useState(() => Date.now())
  const capsulePointerRef = useRef<CapsulePointerState | null>(null)
  const minimalStageRef = useRef<CapsuleMinimalStage>('full')
  const minimalStageTimerRef = useRef<number | undefined>(undefined)
  const minimalRevealTimerRef = useRef<number | undefined>(undefined)
  const capsuleRef = useRef<HTMLElement | null>(null)
  const manualRefreshTimerRef = useRef<number | undefined>(undefined)
  const justRefreshedTimerRef = useRef<number | undefined>(undefined)
  const tabMotionTimerRef = useRef<number | undefined>(undefined)
  const teamBoardMotionTimerRef = useRef<number | undefined>(undefined)
  // "已是最新"提示停留几秒后自动回 idle
  const upToDateTimerRef = useRef<number | undefined>(undefined)
  // 局域网广播消息:panel 会话内消息流 + 胶囊当前展示消息(到达即切,无操作自动回)
  const [broadcastMessages, setBroadcastMessages] = useState<BroadcastMessage[]>([])
  const [capsuleMessage, setCapsuleMessage] = useState<BroadcastMessage | null>(null)
  const capsuleMessageTimerRef = useRef<number | undefined>(undefined)
  // 消息文本是否溢出胶囊:放得下就静态显示全文,溢出才启用跑马灯(方案C)
  const [capsuleMessageOverflow, setCapsuleMessageOverflow] = useState(false)
  const capsuleMessageTextRef = useRef<HTMLSpanElement | null>(null)
  // self peerId 在 bootstrap 后才知道,订阅回调里用 ref 读取避免闭包过期
  const selfPeerIdRef = useRef<string | undefined>(undefined)
  // 广播发送:输入、发送中、失败提示(区分未加入团队/发送过快)
  const [broadcastInput, setBroadcastInput] = useState('')
  const [broadcastSending, setBroadcastSending] = useState(false)
  const [broadcastSendError, setBroadcastSendError] = useState('')
  // 排行榜点赞事件:会话内收集,按目标成员聚合;超 24h 自动过期
  const [reactions, setReactions] = useState<ReactionMessage[]>([])
  // 点赞特效:收到赞后随机播放一种,id 变化强制重播,结束后置空恢复胶囊原样
  const [heartEffect, setHeartEffect] = useState<{ kind: HeartEffectKind; id: number } | null>(null)
  const heartEffectIdRef = useRef(0)
  const heartEffectTimerRef = useRef<number | undefined>(undefined)
  const lastHeartEffectKindRef = useRef<HeartEffectKind | undefined>(undefined)
  // 消息流容器:新消息到达时滚到底,保证最新可见
  const broadcastFeedRef = useRef<HTMLDivElement | null>(null)
  const announcementRef = useRef<HTMLElement | null>(null)
  // 三个视图共用同一个 .panel__content 滚动节点(React 按位置复用,不卸载),切换 tab 需手动重置滚动
  const panelContentRef = useRef<HTMLDivElement | null>(null)
  const announcementVisibleRef = useRef(false)
  const [announcement, setAnnouncement] = useState<AnnouncementState | null>(null)

  // 每次切换 tab 滚动回顶部
  useLayoutEffect(() => {
    panelContentRef.current?.scrollTo(0, 0)
  }, [panelView])

  useEffect(() => {
    let active = true

    void window.codexStatus
      .bootstrap()
      .then((payload) => {
        if (!active) {
          return
        }

        setSnapshot(payload.snapshot)
        setSettings(payload.settings)
        setIslandSnapshot(payload.island)
        setWindowPreferences(payload.window)
        setWindowRole(payload.role)
        setPanelView(payload.panelView)
        setAnnouncement(payload.announcement)
        if (payload.focusUpdate) {
          setFocusUpdatePending(true)
        }
        if (payload.focusTarget) {
          setFocusTargetPending(payload.focusTarget)
        }
        setCustomRefreshInput(String(payload.settings.refreshIntervalSeconds))
        setIqThresholdInput(String(payload.settings.iqThreshold))
        setTeamNicknameInput(payload.settings.teamNickname ?? '')
        setTeamGroupInput(payload.settings.teamGroup ?? '')
        setAppVersion(payload.version)
        setReady(true)
      })
      .catch((error) => {
        if (!active) {
          return
        }

        setSnapshot({
          ...createEmptySnapshot(),
          issues: [error instanceof Error ? error.message : String(error)]
        })
        setReady(true)
      })

    const disposeSnapshot = window.codexStatus.onSnapshotUpdated((nextSnapshot) => {
      setSnapshot(nextSnapshot)
    })

    const disposePreferences = window.codexStatus.onPreferencesUpdated((payload) => {
      setSettings(payload.settings)
      setWindowPreferences(payload.window)
      setCustomRefreshInput(String(payload.settings.refreshIntervalSeconds))
      setIqThresholdInput(String(payload.settings.iqThreshold))
      setTeamNicknameInput(payload.settings.teamNickname ?? '')
      setTeamGroupInput(payload.settings.teamGroup ?? '')
    })

    const disposeIsland = window.codexStatus.onIslandUpdated(setIslandSnapshot)

    const disposeCommand = window.codexStatus.onCommand((payload) => {
      if (payload.type !== 'show-panel-view') {
        return
      }

      if (payload.panelView !== 'team') {
        announcementVisibleRef.current = false
        if (teamBoardMotionTimerRef.current !== undefined) {
          window.clearTimeout(teamBoardMotionTimerRef.current)
          teamBoardMotionTimerRef.current = undefined
        }
        setTeamBoardMotionActive(false)
      }
      if (tabMotionTimerRef.current !== undefined) {
        window.clearTimeout(tabMotionTimerRef.current)
        tabMotionTimerRef.current = undefined
      }
      setTabMotionView(null)
      setPanelView(payload.panelView)
      if (payload.focusUpdate) {
        setFocusUpdatePending(true)
      }
      if (payload.focusTarget) {
        setFocusTargetPending(payload.focusTarget)
      }
      setPanelRevealRequest((value) => value + 1)
    })

    // 订阅更新进度:主进程转发 autoUpdater 事件,据此驱动 UI 状态机
    const disposeUpdateProgress = window.codexStatus.onUpdateProgress((payload) => {
      switch (payload.stage) {
        case 'checking':
          setUpdateState('checking')
          break
        case 'available':
          setUpdateState('available')
          setUpdateVersion(payload.version ?? '')
          break
        case 'not-available':
          // 无更新:进 upToDate 态停留几秒回 idle,给用户明确反馈而非静默
          setUpdateError('')
          setUpdateState('upToDate')
          if (upToDateTimerRef.current !== undefined) {
            window.clearTimeout(upToDateTimerRef.current)
          }
          upToDateTimerRef.current = window.setTimeout(() => {
            setUpdateState('idle')
            upToDateTimerRef.current = undefined
          }, 3000)
          break
        case 'downloading':
          setUpdateState('downloading')
          setUpdateProgress(Math.round(payload.percent ?? 0))
          break
        case 'downloaded':
          setUpdateState('downloaded')
          break
        case 'error':
          setUpdateState('error')
          setUpdateError(payload.message ?? 'error')
          break
      }
    })

    // 订阅局域网广播消息:进会话流;非自己发的再驱动胶囊消息态(到达即切,重置回退定时器)
    const disposeBroadcast = window.codexStatus.onBroadcastMessage((message) => {
      setBroadcastMessages((previous) => [...previous, message].slice(-BROADCAST_FEED_LIMIT))
      if (message.senderPeerId === selfPeerIdRef.current) {
        return
      }
      setCapsuleMessage(message)
      if (capsuleMessageTimerRef.current !== undefined) {
        window.clearTimeout(capsuleMessageTimerRef.current)
      }
      if (minimalStageTimerRef.current !== undefined) {
        window.clearTimeout(minimalStageTimerRef.current)
      }
      if (minimalRevealTimerRef.current !== undefined) {
        window.clearTimeout(minimalRevealTimerRef.current)
      }
      capsuleMessageTimerRef.current = window.setTimeout(() => {
        setCapsuleMessage(null)
        capsuleMessageTimerRef.current = undefined
      }, BROADCAST_REVERT_MS)
    })

    const disposeAnnouncement = window.codexStatus.onAnnouncementUpdated((state) => {
      setAnnouncement(state)
    })

    // 订阅点赞事件:追加并裁剪非今日事件,聚合在渲染时按目标成员计算
    const disposeReaction = window.codexStatus.onReaction((reaction) => {
      setReactions((previous) => {
        const todayKey = localDayKey(Date.now())
        const pruned = previous.filter((r) => localDayKey(r.sentAt) === todayKey)
        return [...pruned, reaction]
      })
      // 别人给我点赞:胶囊整体播放爱心特效数秒,提供被赞的情绪价值
      if (reaction.action === 'add' && reaction.targetPeerId === selfPeerIdRef.current) {
        if (minimalStageRef.current === 'full') spawnHeartEffect()
      }
    })

    return () => {
      active = false
      if (manualRefreshTimerRef.current !== undefined) {
        window.clearTimeout(manualRefreshTimerRef.current)
      }
      if (justRefreshedTimerRef.current !== undefined) {
        window.clearTimeout(justRefreshedTimerRef.current)
      }
      if (tabMotionTimerRef.current !== undefined) {
        window.clearTimeout(tabMotionTimerRef.current)
      }
      if (teamBoardMotionTimerRef.current !== undefined) {
        window.clearTimeout(teamBoardMotionTimerRef.current)
      }
      if (upToDateTimerRef.current !== undefined) {
        window.clearTimeout(upToDateTimerRef.current)
      }
      if (heartEffectTimerRef.current !== undefined) {
        window.clearTimeout(heartEffectTimerRef.current)
      }
      if (capsuleMessageTimerRef.current !== undefined) {
        window.clearTimeout(capsuleMessageTimerRef.current)
      }
      disposeSnapshot()
      disposePreferences()
      disposeIsland()
      disposeCommand()
      disposeUpdateProgress()
      disposeBroadcast()
      disposeAnnouncement()
      disposeReaction()
    }
  }, [])

  useEffect(() => {
    minimalStageRef.current = minimalStage
  }, [minimalStage])

  useLayoutEffect(() => {
    if (windowRole !== 'capsule' || !capsuleRef.current) return
    const raw = window
      .getComputedStyle(capsuleRef.current)
      .getPropertyValue('--capsule-minimal-size')
    const size = Number.parseFloat(raw)
    if (Number.isFinite(size) && size >= 24 && size <= 64) {
      setMinimalBallSize(Math.round(size))
    }
  }, [windowRole, settings.theme])

  // API Key 模式胶囊:随快照刷新(每 30s)拉取今日 token,驱动缓存命中率进度条与今日用量
  useEffect(() => {
    if (windowRole !== 'capsule' || snapshot.authMode !== 'api') {
      return
    }
    let cancelled = false
    window.codexStatus
      .getTokenUsage('1d')
      .then((result) => {
        if (!cancelled) {
          setCapsuleToday(result)
        }
      })
      .catch(() => {
        // 拉取失败:胶囊回退显示 '--'
      })
    return () => {
      cancelled = true
    }
  }, [windowRole, snapshot.authMode, snapshot.generatedAt])

  const copy = COPY[settings.locale]
  const canRefresh = snapshot.canRefresh !== false
  const fixedRefreshValues = REFRESH_INTERVAL_OPTIONS.map((option) => String(option))
  const isCustomRefreshInterval = !fixedRefreshValues.includes(
    String(settings.refreshIntervalSeconds)
  )
  const intervalControlValue = isCustomRefreshInterval
    ? 'custom'
    : String(settings.refreshIntervalSeconds)
  const canEditCustomRefresh = settings.refreshMode === 'auto' && isCustomRefreshInterval
  const isApiMode = snapshot.authMode === 'api'
  const isCodex = settings.agentId === 'codex'
  const hasFiveHourWindow = snapshot.rateLimits.some(
    (windowState) => windowState.windowMinutes === 300
  )
  const isWindowKeeperAvailable = isCodex && snapshot.authMode === 'chatgpt' && hasFiveHourWindow
  const sourceValue = isApiMode
    ? copy.apiModeSource
    : snapshot.rateLimitSource === 'none'
      ? copy.noData
      : snapshot.sourceHost
  const rateLimitWindows = [...snapshot.rateLimits]
    .sort((a, b) => {
      // 短窗口(5h)排在前,长窗口(7d)排在后,确保胶囊取到5h优先
      const am = a.windowMinutes ?? 0
      const bm = b.windowMinutes ?? 0
      return am - bm
    })
    .map((w) => ({
      ...w,
      label:
        w.label === '7d' && settings.locale === 'zh-CN'
          ? '1周'
          : w.label === '5h' && settings.locale === 'zh-CN'
            ? '5小时'
            : w.label
    }))
  // 所有窗口都用 QuotaCard 展示(5h+7d);胶囊百分比+进度条优先取短窗口,无短窗口则取长窗口兜底
  const cardWindows = rateLimitWindows
  const cardWindowCount = cardWindows.length
  // 胶囊:主指标取"剩余最少的窗口"(瓶颈),两窗口任一耗尽即代表不能用;无有效数据回退短窗口
  // 下游百分比/进度条/告急色/倒计时都走这个引用,单点改动即全量跟随
  const windowsWithRemaining = rateLimitWindows.filter((w) => Number.isFinite(w.remainingPercent))
  const displayedRateLimit =
    windowsWithRemaining.length > 0
      ? windowsWithRemaining.reduce((best, w) =>
          (w.remainingPercent ?? Infinity) < (best.remainingPercent ?? Infinity) ? w : best
        )
      : rateLimitWindows[0]
  // 窗口标签:标识主指标所属额度窗口;>=1440 分钟按长窗口口径显示"1周"/"7d",否则"5h"
  const capsuleWindowBadge =
    !isApiMode && displayedRateLimit
      ? (displayedRateLimit.windowMinutes ?? 0) >= 1440
        ? settings.locale === 'zh-CN'
          ? '1周'
          : '7d'
        : '5h'
      : ''
  // API Key 模式:无订阅额度窗口,主指标改为今日缓存命中率,左槽改为今日 token
  const apiTodayTotal = capsuleToday?.available === true ? capsuleToday.totals.total : undefined
  const apiTodayInput = capsuleToday?.available === true ? capsuleToday.totals.input : 0
  const apiTodayCached = capsuleToday?.available === true ? capsuleToday.totals.cachedInput : 0
  const apiCacheHit = apiTodayInput > 0 ? (apiTodayCached / apiTodayInput) * 100 : undefined
  const capsuleDisplayPercent = isApiMode
    ? apiCacheHit
    : settings.percentageMode === 'used'
      ? displayedRateLimit?.usedPercent
      : displayedRateLimit?.remainingPercent
  const capsulePercentText =
    capsuleDisplayPercent === undefined ? '--' : `${Math.round(capsuleDisplayPercent)}%`
  const capsuleProgressStyle = createMetricProgressStyle(
    capsuleDisplayPercent,
    isApiMode ? 'remaining' : settings.percentageMode,
    settings.theme
  )
  const capsuleResetAt = displayedRateLimit?.resetsAt
  const capsuleResetText = formatCountdownCapsule(capsuleResetAt, nowTick)
  // API Key 模式左槽:今日 token;OAuth 模式为窗口重置倒计时
  const capsuleWeeklyText = isApiMode
    ? apiTodayTotal === undefined
      ? '--'
      : formatCapsuleTokens(apiTodayTotal, settings.locale)
    : capsuleResetText
  // API Key 模式胶囊数值与自适应字号(长文本自动缩小,不出框)
  // 竖版仅 50px 宽,字号与最大宽度都比横版收紧
  const apiTokenText = isApiMode ? capsuleWeeklyText : ''
  const apiHitText = isApiMode ? capsulePercentText : ''
  const apiIsOrb = windowPreferences.viewMode === 'orb'
  const apiTokenFont = fitFontSize(apiTokenText, apiIsOrb ? 12 : 14, apiIsOrb ? 40 : 80)
  const apiHitFont = fitFontSize(apiHitText, apiIsOrb ? 12 : 14, apiIsOrb ? 44 : 64)
  const capsuleCreditText = snapshot.resetCredit?.expiresAt
    ? formatCountdownShort(snapshot.resetCredit.expiresAt, settings.locale)
    : ''
  const capsuleViewMode = windowPreferences.viewMode
  // 告急:remaining 模式剩余<20%,used 模式已用>80%,触发进度条呼吸提醒
  const goodScore =
    capsuleDisplayPercent === undefined
      ? undefined
      : settings.percentageMode === 'remaining'
        ? capsuleDisplayPercent
        : 100 - capsuleDisplayPercent
  const isCritical = !isApiMode && goodScore !== undefined && goodScore < 20
  // 胶囊中部指标盒(百分比+进度条):OAuth 显示额度,API 模式显示缓存命中率
  const capsuleMetricBox = (
    <div className="capsule__metric-box">
      <div
        className={`capsule__percent${justRefreshed ? ' is-just-refreshed' : ''}${isCritical ? ' is-critical' : ''}`}
      >
        {capsulePercentText}
      </div>
      <span className="capsule__progress" aria-hidden="true">
        <span />
      </span>
    </div>
  )
  // 胶囊左槽:OAuth 为窗口重置倒计时(沙漏),API 模式为今日 token(由 ApiCapsuleStat 渲染)
  const capsuleWeeklyOrb = (
    <div className="capsule__weekly">
      <HourglassIcon />
      <span>{capsuleWeeklyText}</span>
    </div>
  )

  // API Key 模式胶囊:按内容实际尺寸自适应窗口大小(信息多则大,少则小)。
  // 临时把胶囊设为 max-content 量出自然尺寸,再让主进程 setSize 贴合。
  useLayoutEffect(() => {
    if (!isApiMode || windowRole !== 'capsule' || minimalStage !== 'full') {
      return
    }
    const section = capsuleRef.current
    if (!section) {
      return
    }
    const prevWidth = section.style.width
    const prevHeight = section.style.height
    section.style.width = 'max-content'
    section.style.height = 'max-content'
    const width = section.offsetWidth
    const height = section.offsetHeight
    section.style.width = prevWidth
    section.style.height = prevHeight
    if (width > 0 && height > 0) {
      void window.codexStatus.setCapsuleSize({ width, height })
    }
  }, [isApiMode, windowRole, apiTokenText, apiHitText, capsuleViewMode, minimalStage])
  // 团队额度排行榜:主键 7d(长窗口)剩余降序,7d 相同则次键 5h(短窗口)剩余降序;缺窗口视为最低排末尾。API Key 无订阅额度(恒 0),不参与额度排行
  const teamPeers = [...(snapshot.teamPeers ?? [])]
    .filter((peer) => peer.authMode !== 'api')
    .sort((a, b) => {
      const aLong = a.longWindow?.remainingPercent ?? -1
      const bLong = b.longWindow?.remainingPercent ?? -1
      if (bLong !== aLong) return bLong - aLong
      const aShort = a.shortWindow?.remainingPercent ?? -1
      const bShort = b.shortWindow?.remainingPercent ?? -1
      return bShort - aShort
    })
  // Token 消耗排行榜:按选中窗口 token 总量降序(undefined 排末尾);横条按窗口内最大值归一化
  const teamTokenPeers = [...(snapshot.teamPeers ?? [])].sort((a, b) => {
    const at = a.tokenUsage?.[teamTokenWindow] ?? -1
    const bt = b.tokenUsage?.[teamTokenWindow] ?? -1
    return bt - at
  })
  const teamTokenMax = Math.max(
    1,
    ...teamTokenPeers.map((peer) => peer.tokenUsage?.[teamTokenWindow] ?? 0)
  )
  // 非 Codex 无订阅额度,团队页只留 Token 消耗榜(不显示额度/Token 切换 tab,切换工具即生效)
  const effectiveTeamBoardMode: 'quota' | 'tokens' = isCodex ? teamBoardMode : 'tokens'
  // 本机 peer 标识:供回声过滤(自己发的消息只进 panel 流,不驱动胶囊切换)
  const selfPeerId = snapshot.teamPeers?.find((peer) => peer.isSelf)?.id
  useEffect(() => {
    selfPeerIdRef.current = selfPeerId
  }, [selfPeerId])
  // 组内最高版本(含 self):排行榜"最新"基准,低于它的成员标黄点
  const maxAppVersion = (snapshot.teamPeers ?? []).reduce<string | undefined>(
    (max, peer) =>
      peer.appVersion !== undefined &&
      (max === undefined || compareSemver(peer.appVersion, max) > 0)
        ? peer.appVersion
        : max,
    undefined
  )
  // 点赞聚合:同一发送者对同一成员以最后一次动作生效,非今日事件不计(与 token 榜 1d 同为自然日)
  function aggregateReactions(targetPeerId: string): { count: number; selfLiked: boolean } {
    const todayKey = localDayKey(Date.now())
    const likedBy = new Map<string, boolean>()
    for (const r of reactions) {
      if (r.targetPeerId !== targetPeerId || localDayKey(r.sentAt) !== todayKey) continue
      likedBy.set(r.senderPeerId, r.action === 'add')
    }
    let count = 0
    for (const liked of likedBy.values()) {
      if (liked) count++
    }
    return { count, selfLiked: likedBy.get(selfPeerIdRef.current ?? '') === true }
  }
  // 版本角标跳转:进设置页后滚动到检查更新区(about-row),完成后清除一次性标志
  useEffect(() => {
    if (panelView === 'settings' && focusUpdatePending) {
      aboutRowRef.current?.scrollIntoView({ block: 'nearest' })
      // 这是一次性定位标志,滚动完成后必须清除;否则后续设置页打开会重复定位。
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFocusUpdatePending(false)
    }
  }, [panelView, focusUpdatePending])

  // panel 重新打开时重置更新态为 idle,打破 downloaded 死端
  // 场景:1.1.5 下载完不装、1.1.6 发布后重开 panel → 重置 → 重新检查能跳到 1.1.6
  // panel 内切 tab 不碰 panelRevealRequest,不会触发;红点进来(focusUpdatePending)不打断;
  // 下载中(downloading)不打断。依赖数组只放 reveal 计数,避免 updateState 变化误触发
  useEffect(() => {
    if (!focusUpdatePending && updateState !== 'downloading') {
      // 面板重新打开时重置更新态,保留现有生命周期时序。
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setUpdateState('idle')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelRevealRequest])

  useEffect(() => {
    if (panelView !== 'team' || !focusTargetPending) {
      return
    }

    const target =
      focusTargetPending === 'announcement' ? announcementRef.current : broadcastFeedRef.current
    if (!target) {
      return
    }
    target.scrollIntoView({ block: 'nearest' })
    if (focusTargetPending === 'announcement') {
      announcementRef.current?.focus({ preventScroll: true })
    }
    setFocusTargetPending(null)
  }, [panelView, focusTargetPending, announcement?.message.id])

  // 只有当前公告卡片进入前台可视区才自动已读；按 id 上报，旧卡片不能误清新公告。
  useEffect(() => {
    if (windowRole !== 'panel' || panelView !== 'team' || !announcement) {
      return
    }

    const element = announcementRef.current
    if (!element) {
      return
    }

    const announcementId = announcement.message.id
    const markIfVisible = (): void => {
      if (
        announcementVisibleRef.current &&
        document.visibilityState === 'visible' &&
        document.hasFocus()
      ) {
        void window.codexStatus.markAnnouncementRead(announcementId)
      }
    }
    const observer = new IntersectionObserver(([entry]) => {
      announcementVisibleRef.current = entry.isIntersecting
      markIfVisible()
    })
    observer.observe(element)
    window.addEventListener('focus', markIfVisible)
    document.addEventListener('visibilitychange', markIfVisible)
    return () => {
      announcementVisibleRef.current = false
      observer.disconnect()
      window.removeEventListener('focus', markIfVisible)
      document.removeEventListener('visibilitychange', markIfVisible)
    }
  }, [windowRole, panelView, announcement?.message.id])

  // 新消息入流后把 feed 滚到底,最新可见
  useEffect(() => {
    const feed = broadcastFeedRef.current
    if (feed) {
      feed.scrollTop = feed.scrollHeight
    }
  }, [broadcastMessages.length])
  // 胶囊消息态跑马灯:文本越长滚动越慢,夹在 6s~20s
  const capsuleMarqueeDuration = capsuleMessage
    ? Math.max(
        CAPSULE_MARQUEE_MIN_MS,
        Math.min(CAPSULE_MARQUEE_MAX_MS, capsuleMessage.text.length * CAPSULE_MARQUEE_PER_CHAR_MS)
      )
    : CAPSULE_MARQUEE_MIN_MS
  const capsuleMessageLabel = capsuleMessage
    ? capsuleMessage.senderNickname || copy.teamAnonymous
    : ''
  // 测量单份文本是否超过胶囊可视区:横版比宽度,竖版比高度;超了才滚动
  useLayoutEffect(() => {
    const text = capsuleMessageTextRef.current
    const container = text?.closest<HTMLDivElement>('.capsule__message')
    if (!capsuleMessage || !text || !container) {
      setCapsuleMessageOverflow(false)
      return
    }
    const overflows =
      capsuleViewMode === 'orb'
        ? text.offsetHeight > container.clientHeight
        : text.offsetWidth > container.clientWidth
    setCapsuleMessageOverflow(overflows)
  }, [capsuleMessage, capsuleMessageLabel, capsuleViewMode])
  const hasUpdate =
    updateState === 'available' || updateState === 'downloading' || updateState === 'downloaded'
  // P2P 版本落后:组内广播的最高版本高于本地即提示;与 GitHub 红点角标不叠加
  const selfOutdated =
    appVersion !== '' && maxAppVersion !== undefined && compareSemver(appVersion, maxAppVersion) < 0
  const showOutdatedBadge = selfOutdated && !hasUpdate
  const capsuleAlert = resolveCapsuleAlert(
    hasUpdate,
    announcement?.unread === true,
    showOutdatedBadge,
    capsuleMessage !== null
  )
  const showMinimalBall = minimalStage === 'minimal' || minimalStage === 'expanding'
  const canEnterMinimal =
    settings.capsuleMinimalMode &&
    windowRole === 'capsule' &&
    snapshot.generatedAt !== undefined &&
    capsuleMessage === null &&
    minimalStage === 'full' &&
    !pointerInsideCapsule
  const minimalRemainingPercent = isApiMode
    ? undefined
    : clampProgressPercent(displayedRateLimit?.remainingPercent)
  const minimalValueText = isApiMode
    ? apiTokenText
    : minimalRemainingPercent === undefined
      ? '--'
      : `${Math.round(minimalRemainingPercent)}%`
  const minimalValueColor = isApiMode
    ? undefined
    : resolveMinimalMetricColor(minimalRemainingPercent, settings.theme)
  const minimalValueFont = fitFontSize(
    minimalValueText,
    Math.max(10, Math.round(minimalBallSize * 0.36)),
    Math.max(16, minimalBallSize - 8)
  )
  const adjustedMinimalValueFont =
    settings.theme === 'memphis' && !isApiMode ? Math.min(minimalValueFont, 12) : minimalValueFont
  const capsuleAriaLabel =
    showMinimalBall && !isApiMode && capsuleAlert === 'default'
      ? `${copy.remaining} ${minimalValueText}${capsuleWindowBadge ? `, ${capsuleWindowBadge}` : ''}`
      : capsuleAlert === 'red' || capsuleAlert === 'yellow'
        ? copy.checkUpdate
        : capsuleAlert === 'blue'
          ? copy.announcementUnread
          : capsuleAlert === 'message'
            ? copy.capsuleMessageAria
            : copy.details
  const capsuleClassName = [
    'capsule',
    `capsule--${capsuleViewMode}`,
    capsuleAlert === 'red' ? 'has-update' : '',
    capsuleAlert === 'blue' ? 'has-announcement' : '',
    capsuleAlert === 'yellow' ? 'is-outdated' : '',
    snapshot.isRefreshing ? 'is-refreshing' : '',
    manualRefreshActive ? 'is-manual-refreshing' : '',
    canRefresh ? '' : 'is-static',
    capsulePointerActive ? 'is-dragging' : '',
    showMinimalBall ? 'capsule--minimal' : '',
    minimalStage === 'expanding' ? 'is-minimal-leaving' : '',
    minimalStage === 'collapsing' ? 'is-collapsing' : '',
    minimalReveal ? 'is-revealing' : ''
  ]
    .filter(Boolean)
    .join(' ')

  const detailRows: Array<React.ComponentProps<typeof DetailRow>> = [
    // 重置卡是订阅(OAuth)专有,API Key 模式不展示
    ...(!isApiMode && snapshot.resetCredit?.expiresAt
      ? [
          {
            icon: <TicketIcon />,
            iconTone: 'var(--panel-icon-pink)',
            label: copy.resetCredit,
            value: formatCountdownShort(snapshot.resetCredit.expiresAt, settings.locale),
            hint: formatAbsoluteDate(snapshot.resetCredit.expiresAt, settings.locale)
          }
        ]
      : []),
    // 雷达是 Codex 专有功能(推荐模型),非 Codex 工具不展示
    ...(isCodex
      ? [
          {
            icon: <SparkleIcon />,
            iconTone: 'var(--panel-icon-violet)',
            label: settings.locale === 'zh-CN' ? '雷达推荐模型' : 'Top model',
            labelHref: 'https://codex-reset-radar.pages.dev/',
            value: snapshot.bestModelPick
              ? formatModelPick(snapshot.bestModelPick.shortLabel)
              : undefined,
            valueColor: snapshot.bestModelPick
              ? resolveModelColor(snapshot.bestModelPick.label)
              : undefined,
            hint: snapshot.bestModelPick
              ? settings.locale === 'zh-CN'
                ? `IQ ${snapshot.bestModelPick.score.toFixed(1)} · $${snapshot.bestModelPick.averageCostUsd.toFixed(2)}/题`
                : `IQ ${snapshot.bestModelPick.score.toFixed(1)} · $${snapshot.bestModelPick.averageCostUsd.toFixed(2)}/task`
              : undefined
          }
        ]
      : []),
    // 额度特赦重置:静态外链入口,跳转 codex-resets.com 查看官方重置记录(订阅专有,API Key 模式隐藏)
    ...(isApiMode
      ? []
      : [
          {
            icon: <ResetIcon />,
            iconTone: 'var(--panel-icon-green)',
            label: settings.locale === 'zh-CN' ? '额度重置监测' : 'Usage reset monitor',
            labelHref: 'https://codex-resets.com/'
          }
        ])
  ]

  // 有窗口带重置倒计时时每秒 tick 刷新显示
  const hasResetWindow = rateLimitWindows.some((w) => w.resetsAt !== undefined)
  const hasAnnouncementTime =
    windowRole === 'panel' && panelView === 'team' && announcement !== null
  useEffect(() => {
    const isPanelWithResetWindow =
      windowRole === 'panel' && panelView === 'details' && hasResetWindow
    const isCapsuleWithResetWindow = windowRole === 'capsule' && hasResetWindow
    if (!isPanelWithResetWindow && !isCapsuleWithResetWindow && !hasAnnouncementTime) {
      return
    }

    const timer = window.setInterval(() => {
      setNowTick(Date.now())
    }, 1000)
    return () => {
      window.clearInterval(timer)
    }
  }, [windowRole, panelView, hasResetWindow, hasAnnouncementTime])

  // panel 窗口显示时机:隐藏窗口需等新页面完成一帧绘制，避免 show 时先暴露旧帧。
  useLayoutEffect(() => {
    if (!ready || windowRole !== 'panel') {
      return
    }

    let revealFrame = 0
    const commitFrame = window.requestAnimationFrame(() => {
      revealFrame = window.requestAnimationFrame(() => {
        void window.codexStatus.notifyPanelReady()
      })
    })

    return () => {
      window.cancelAnimationFrame(commitFrame)
      if (revealFrame !== 0) {
        window.cancelAnimationFrame(revealFrame)
      }
    }
  }, [ready, windowRole, panelRevealRequest])

  // 胶囊显示时机:有数据(generatedAt 存在)后通知主进程显示窗口。
  // 无数据不通知 → 启动空快照阶段胶囊保持隐藏,避免先大后小闪烁。
  // 双 rAF 等内容完成一帧绘制再 show,对齐 panel 的防旧帧先露做法。
  useLayoutEffect(() => {
    if (!ready || windowRole !== 'capsule') {
      return
    }
    if (snapshot.generatedAt === undefined) {
      return
    }

    let revealFrame = 0
    const commitFrame = window.requestAnimationFrame(() => {
      revealFrame = window.requestAnimationFrame(() => {
        void window.codexStatus.notifyCapsuleReady()
      })
    })

    return () => {
      window.cancelAnimationFrame(commitFrame)
      if (revealFrame !== 0) {
        window.cancelAnimationFrame(revealFrame)
      }
    }
  }, [ready, windowRole, snapshot.generatedAt])

  useEffect(() => {
    if (!canEnterMinimal) return
    const timer = window.setTimeout(() => {
      setMinimalStage('collapsing')
      minimalStageTimerRef.current = window.setTimeout(() => {
        minimalStageTimerRef.current = undefined
        void enterCapsuleMinimal()
      }, CAPSULE_MINIMAL_COLLAPSE_MS)
    }, CAPSULE_MINIMAL_TRIGGER_MS)
    return () => window.clearTimeout(timer)
  }, [canEnterMinimal])

  useEffect(() => {
    if (capsuleMessage === null) return
    if (minimalStageRef.current === 'collapsing') cancelCapsuleCollapse()
    else if (minimalStageRef.current !== 'full') startCapsuleExpand()
  }, [capsuleMessage?.id])

  useEffect(() => {
    if (settings.capsuleMinimalMode) return
    if (minimalStageRef.current === 'collapsing') cancelCapsuleCollapse()
    else if (minimalStageRef.current !== 'full') startCapsuleExpand()
  }, [settings.capsuleMinimalMode])

  async function enterCapsuleMinimal(): Promise<void> {
    try {
      await window.codexStatus.setCapsuleMinimal({
        enabled: true,
        size: { width: minimalBallSize, height: minimalBallSize }
      })
      setMinimalStage('minimal')
    } catch {
      setMinimalStage('full')
    }
  }

  function cancelCapsuleCollapse(): void {
    if (minimalStageTimerRef.current !== undefined) {
      window.clearTimeout(minimalStageTimerRef.current)
      minimalStageTimerRef.current = undefined
    }
    setMinimalStage('full')
  }

  function startCapsuleExpand(): void {
    if (minimalStageRef.current === 'full') return
    if (minimalStageTimerRef.current !== undefined) {
      window.clearTimeout(minimalStageTimerRef.current)
    }
    setMinimalStage('expanding')
    minimalStageTimerRef.current = window.setTimeout(() => {
      minimalStageTimerRef.current = undefined
      void exitCapsuleMinimal()
    }, CAPSULE_MINIMAL_LEAVE_MS)
  }

  async function exitCapsuleMinimal(): Promise<void> {
    try {
      await window.codexStatus.setCapsuleMinimal({ enabled: false })
    } catch {
      // IPC 失败时仍恢复渲染态,避免胶囊卡在过渡状态
    }
    setMinimalStage('full')
    setMinimalReveal(true)
    if (minimalRevealTimerRef.current !== undefined) {
      window.clearTimeout(minimalRevealTimerRef.current)
    }
    minimalRevealTimerRef.current = window.setTimeout(() => {
      minimalRevealTimerRef.current = undefined
      setMinimalReveal(false)
    }, CAPSULE_MINIMAL_REVEAL_MS)
  }

  function closePanel(): void {
    setPanelView('details')
    void window.codexStatus.closePanel()
  }

  // 手动检查更新:无更新(含 dev 环境)进 upToDate 态停留几秒,给用户明确反馈
  async function handleCheckUpdate(): Promise<void> {
    setUpdateState('checking')
    setUpdateError('')
    if (upToDateTimerRef.current !== undefined) {
      window.clearTimeout(upToDateTimerRef.current)
    }
    try {
      const result = await window.codexStatus.checkForUpdate()
      if (result.available) {
        setUpdateState('available')
        setUpdateVersion(result.version ?? '')
      } else {
        setUpdateState('upToDate')
        upToDateTimerRef.current = window.setTimeout(() => {
          setUpdateState('idle')
          upToDateTimerRef.current = undefined
        }, 3000)
      }
    } catch (error) {
      setUpdateState('error')
      setUpdateError(error instanceof Error ? error.message : String(error))
    }
  }

  async function handleDownloadUpdate(): Promise<void> {
    setUpdateState('downloading')
    setUpdateProgress(0)
    try {
      await window.codexStatus.downloadUpdate()
    } catch (error) {
      setUpdateState('error')
      setUpdateError(error instanceof Error ? error.message : String(error))
    }
  }

  function handleInstallUpdate(): void {
    void window.codexStatus.installUpdate()
  }

  async function handleRefresh(): Promise<void> {
    if (!canRefresh) {
      return
    }

    showManualRefreshFeedback()

    try {
      const nextSnapshot = await window.codexStatus.refreshStatus()
      setSnapshot(nextSnapshot)
      triggerJustRefreshed()
    } catch (error) {
      recordSnapshotIssue(error)
    }
  }

  // 刷新成功后触发百分比弹跳反馈(680ms),与手动刷新扫光错开一点
  function triggerJustRefreshed(): void {
    if (justRefreshedTimerRef.current !== undefined) {
      window.clearTimeout(justRefreshedTimerRef.current)
    }
    setJustRefreshed(true)
    justRefreshedTimerRef.current = window.setTimeout(() => {
      setJustRefreshed(false)
      justRefreshedTimerRef.current = undefined
    }, MANUAL_REFRESH_FEEDBACK_MS)
  }

  function showManualRefreshFeedback(): void {
    setManualRefreshActive(true)
    if (manualRefreshTimerRef.current !== undefined) {
      window.clearTimeout(manualRefreshTimerRef.current)
    }

    manualRefreshTimerRef.current = window.setTimeout(() => {
      setManualRefreshActive(false)
      manualRefreshTimerRef.current = undefined
    }, MANUAL_REFRESH_FEEDBACK_MS)
  }

  function handleCapsulePointerDown(event: React.PointerEvent<HTMLElement>): void {
    if (event.button !== 0) {
      return
    }

    if (minimalStageRef.current !== 'full') {
      if (minimalStageRef.current === 'collapsing') cancelCapsuleCollapse()
      else startCapsuleExpand()
      return
    }

    const bounds = event.currentTarget.getBoundingClientRect()
    capsulePointerRef.current = {
      pointerId: event.pointerId,
      originScreenX: event.screenX,
      originScreenY: event.screenY,
      offsetX: event.clientX - bounds.left,
      offsetY: event.clientY - bounds.top,
      hasDragged: false
    }
    setCapsulePointerActive(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function handleCapsulePointerMove(event: React.PointerEvent<HTMLElement>): void {
    const pointerState = capsulePointerRef.current
    if (!pointerState || pointerState.pointerId !== event.pointerId) {
      return
    }

    const distance = Math.hypot(
      event.screenX - pointerState.originScreenX,
      event.screenY - pointerState.originScreenY
    )
    if (distance < CAPSULE_CLICK_DRAG_DISTANCE && !pointerState.hasDragged) {
      return
    }

    pointerState.hasDragged = true
    event.preventDefault()

    void window.codexStatus
      .moveCapsuleWindow({
        screenX: event.screenX,
        screenY: event.screenY,
        offsetX: pointerState.offsetX,
        offsetY: pointerState.offsetY
      })
      .then((nextWindowPreferences) => {
        setWindowPreferences(nextWindowPreferences)
      })
      .catch(recordSnapshotIssue)
  }

  function handleCapsulePointerUp(event: React.PointerEvent<HTMLElement>): void {
    void finishCapsulePointer(event, true)
  }

  function handleCapsulePointerCancel(event: React.PointerEvent<HTMLElement>): void {
    void finishCapsulePointer(event, false)
  }

  function handleCapsulePointerEnter(): void {
    setPointerInsideCapsule(true)
    if (minimalStageRef.current === 'collapsing') cancelCapsuleCollapse()
    else if (minimalStageRef.current !== 'full') startCapsuleExpand()
  }

  function handleCapsulePointerLeave(): void {
    setPointerInsideCapsule(false)
  }

  // 排除上一次形态,避免随机连续重复让特效库显得单调
  function spawnHeartEffect(): void {
    const availableKinds = HEART_EFFECT_KINDS.filter(
      (kind) => kind !== lastHeartEffectKindRef.current
    )
    const kind = availableKinds[Math.floor(Math.random() * availableKinds.length)]
    lastHeartEffectKindRef.current = kind
    const id = ++heartEffectIdRef.current
    setHeartEffect({ kind, id })
    if (heartEffectTimerRef.current !== undefined) {
      window.clearTimeout(heartEffectTimerRef.current)
    }
    heartEffectTimerRef.current = window.setTimeout(() => {
      heartEffectTimerRef.current = undefined
      setHeartEffect(null)
    }, HEART_EFFECT_DURATION_MS)
  }

  async function finishCapsulePointer(
    event: React.PointerEvent<HTMLElement>,
    shouldRefreshOnClick: boolean
  ): Promise<void> {
    const pointerState = capsulePointerRef.current
    if (!pointerState || pointerState.pointerId !== event.pointerId) {
      return
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    capsulePointerRef.current = null
    setCapsulePointerActive(false)

    if (pointerState.hasDragged) {
      try {
        const nextWindowPreferences = await window.codexStatus.finishCapsuleWindowDrag()
        setWindowPreferences(nextWindowPreferences)
      } catch (error) {
        recordSnapshotIssue(error)
      }
      return
    }

    if (shouldRefreshOnClick) {
      openCapsuleTarget()
    }
  }

  function clearCapsuleMessage(): void {
    setCapsuleMessage(null)
    if (capsuleMessageTimerRef.current !== undefined) {
      window.clearTimeout(capsuleMessageTimerRef.current)
      capsuleMessageTimerRef.current = undefined
    }
  }

  // 单一优先级同时决定角标颜色与跳转目标，避免视觉提示和点击行为分叉。
  function openCapsuleTarget(): void {
    if (capsuleAlert === 'red' || capsuleAlert === 'yellow') {
      void window.codexStatus.showPanel('settings', { focusUpdate: true, forceOpen: true })
      return
    }
    if (capsuleAlert === 'blue') {
      void window.codexStatus.showPanel('team', {
        focusTarget: 'announcement',
        forceOpen: true
      })
      return
    }
    if (capsuleAlert === 'message') {
      clearCapsuleMessage()
      void window.codexStatus.showPanel('team', { focusTarget: 'messages', forceOpen: true })
      return
    }
    void window.codexStatus.showPanel('details')
  }

  function handleCapsuleKeyDown(event: React.KeyboardEvent<HTMLElement>): void {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return
    }

    event.preventDefault()
    if (minimalStageRef.current !== 'full') {
      if (minimalStageRef.current === 'collapsing') cancelCapsuleCollapse()
      else startCapsuleExpand()
      return
    }
    openCapsuleTarget()
  }

  function handlePanelViewChange(view: PanelView): void {
    if (view === panelView) {
      return
    }
    if (view !== 'team') {
      announcementVisibleRef.current = false
      if (teamBoardMotionTimerRef.current !== undefined) {
        window.clearTimeout(teamBoardMotionTimerRef.current)
        teamBoardMotionTimerRef.current = undefined
      }
      setTeamBoardMotionActive(false)
    } else {
      startTeamBoardMotion()
    }
    if (tabMotionTimerRef.current !== undefined) {
      window.clearTimeout(tabMotionTimerRef.current)
    }
    setTabMotionView(view)
    setPanelView(view)
    tabMotionTimerRef.current = window.setTimeout(() => {
      setTabMotionView(null)
      tabMotionTimerRef.current = undefined
    }, PANEL_TAB_MOTION_CLEAR_MS)
  }

  function startTeamBoardMotion(): void {
    if (teamBoardMotionTimerRef.current !== undefined) {
      window.clearTimeout(teamBoardMotionTimerRef.current)
    }
    setTeamBoardMotionActive(true)
    teamBoardMotionTimerRef.current = window.setTimeout(() => {
      setTeamBoardMotionActive(false)
      teamBoardMotionTimerRef.current = undefined
    }, TEAM_BOARD_MOTION_CLEAR_MS)
  }

  function handleTeamBoardModeChange(value: string): void {
    const mode = value as 'quota' | 'tokens'
    if (mode === teamBoardMode) {
      return
    }
    startTeamBoardMotion()
    setTeamBoardMode(mode)
  }

  function handleTeamTokenWindowChange(value: string): void {
    const usageWindow = value as UsageWindow
    if (usageWindow === teamTokenWindow) {
      return
    }
    startTeamBoardMotion()
    setTeamTokenWindow(usageWindow)
  }

  function recordSnapshotIssue(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    setSnapshot((previous) => ({
      ...previous,
      isRefreshing: false,
      issues: Array.from(new Set([message, ...previous.issues])).slice(0, 6)
    }))
  }

  // 发送广播:成功清输入(自己消息经主进程回显进 feed);失败按原因提示,保留输入
  async function handleBroadcastSend(): Promise<void> {
    const text = broadcastInput.trim()
    if (!text || broadcastSending) {
      return
    }
    setBroadcastSending(true)
    setBroadcastSendError('')
    try {
      const result = await window.codexStatus.sendBroadcast(text)
      if (result.ok) {
        setBroadcastInput('')
      } else {
        setBroadcastSendError(
          result.reason === 'not-in-team'
            ? copy.broadcastNotInTeam
            : result.reason === 'too-long'
              ? copy.broadcastInvalid
              : copy.broadcastRateLimited
        )
      }
    } catch {
      // IPC 异常:静默保留输入,不误导用户
    } finally {
      setBroadcastSending(false)
    }
  }

  // 点赞 toggle:按当前聚合状态决定 add/remove;失败静默(未入组时榜单不显示入口,正常不会触发)
  async function handleReactionToggle(targetPeerId: string): Promise<void> {
    const selfLiked = aggregateReactions(targetPeerId).selfLiked
    await window.codexStatus.sendReaction(targetPeerId, selfLiked ? 'remove' : 'add')
  }

  // 消息时间戳:当天只显示 HH:mm,跨天带日期(会话内实时,消息不会太旧)
  function formatMessageTime(sentAt: number): string {
    const date = new Date(sentAt)
    const today = new Date()
    const sameDay = date.toDateString() === today.toDateString()
    const time = date.toLocaleTimeString(settings.locale, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    })
    return sameDay ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`
  }

  async function handleSettingsPatch(patch: Partial<AppSettings>): Promise<void> {
    const previousSettings = settings
    setSettings({
      ...settings,
      ...patch
    })

    try {
      const payload = await window.codexStatus.updateSettings(patch)
      setSettings(payload.settings)
    } catch {
      setSettings(previousSettings)
    }
  }

  function commitCustomRefreshInterval(): void {
    if (!canEditCustomRefresh) {
      setCustomRefreshInput(String(settings.refreshIntervalSeconds))
      return
    }

    const parsed = Number.parseInt(customRefreshInput, 10)
    if (!Number.isFinite(parsed)) {
      setCustomRefreshInput(String(settings.refreshIntervalSeconds))
      return
    }

    const normalized = normalizeCustomRefreshInterval(parsed)
    setCustomRefreshInput(String(normalized))
    if (normalized !== settings.refreshIntervalSeconds) {
      void handleSettingsPatch({ refreshIntervalSeconds: normalized })
    }
  }

  function commitIqThreshold(): void {
    const parsed = Number.parseInt(iqThresholdInput, 10)
    if (!Number.isFinite(parsed)) {
      setIqThresholdInput(String(settings.iqThreshold))
      return
    }

    const normalized = Math.min(MAX_IQ_THRESHOLD, Math.max(MIN_IQ_THRESHOLD, Math.round(parsed)))
    setIqThresholdInput(String(normalized))
    if (normalized !== settings.iqThreshold) {
      void handleSettingsPatch({ iqThreshold: normalized })
    }
  }

  // 团队昵称:trim 后提交;空串保存为 undefined(主进程 normalizeSettings 兜底)
  function commitTeamNickname(): void {
    const trimmed = teamNicknameInput.trim()
    setTeamNicknameInput(trimmed)
    const normalized = trimmed.length > 0 ? trimmed : undefined
    if (normalized !== settings.teamNickname) {
      void handleSettingsPatch({ teamNickname: normalized })
    }
  }

  function commitTeamGroup(): void {
    const trimmed = teamGroupInput.trim()
    setTeamGroupInput(trimmed)
    const normalized = trimmed.length > 0 ? trimmed : undefined
    if (normalized !== settings.teamGroup) {
      void handleSettingsPatch({ teamGroup: normalized })
    }
  }

  function selectRefreshInterval(value: string): void {
    if (value === 'custom') {
      const parsed = Number.parseInt(customRefreshInput, 10)
      const candidate = Number.isFinite(parsed)
        ? normalizeCustomRefreshInterval(parsed)
        : DEFAULT_CUSTOM_REFRESH_INTERVAL_SECONDS
      const nextValue = isFixedRefreshInterval(candidate)
        ? DEFAULT_CUSTOM_REFRESH_INTERVAL_SECONDS
        : candidate

      setCustomRefreshInput(String(nextValue))
      void handleSettingsPatch({ refreshIntervalSeconds: nextValue })
      return
    }

    const nextValue = Number(value)
    setCustomRefreshInput(String(nextValue))
    void handleSettingsPatch({
      refreshIntervalSeconds: nextValue
    })
  }

  if (!ready) {
    return <div className="app-shell" />
  }

  if (windowRole === 'capsule') {
    return (
      <div className="app-shell app-shell--capsule" data-theme={settings.theme}>
        <main className="widget">
          <section
            ref={capsuleRef}
            aria-label={capsuleAriaLabel}
            className={capsuleClassName}
            style={capsuleProgressStyle}
            onKeyDown={handleCapsuleKeyDown}
            onPointerCancel={handleCapsulePointerCancel}
            onPointerDown={handleCapsulePointerDown}
            onPointerEnter={handleCapsulePointerEnter}
            onPointerLeave={handleCapsulePointerLeave}
            onPointerMove={handleCapsulePointerMove}
            onPointerUp={handleCapsulePointerUp}
            role="button"
            tabIndex={0}
          >
            <span className="capsule__deco" aria-hidden="true" />
            {showMinimalBall ? (
              <MinimalCapsule
                theme={settings.theme}
                valueText={minimalValueText}
                valueColor={minimalValueColor}
                valueFontSize={adjustedMinimalValueFont}
                progress={minimalRemainingPercent}
                isApiMode={isApiMode}
              />
            ) : (
              <>
                {heartEffect ? <HeartEffect key={heartEffect.id} kind={heartEffect.kind} /> : null}
                {capsuleMessage ? (
                  <div
                    key={capsuleMessage.id}
                    className={`capsule__message capsule__message--${capsuleViewMode}${
                      capsuleMessageOverflow ? ' is-marquee' : ''
                    }`}
                  >
                    <div
                      className={`capsule__message-track${capsuleMessageOverflow ? ' is-marquee' : ''}`}
                      style={
                        {
                          '--capsule-marquee-duration': `${capsuleMarqueeDuration}ms`
                        } as CSSProperties
                      }
                    >
                      <span className="capsule__message-copy">
                        <span ref={capsuleMessageTextRef} className="capsule__message-text">
                          {capsuleMessageLabel}: {capsuleMessage.text}
                        </span>
                      </span>
                      {capsuleMessageOverflow ? (
                        <span aria-hidden="true" className="capsule__message-copy">
                          <span className="capsule__message-text">
                            {capsuleMessageLabel}: {capsuleMessage.text}
                          </span>
                        </span>
                      ) : null}
                    </div>
                  </div>
                ) : capsuleViewMode === 'orb' ? (
                  <div
                    className={`capsule__layout capsule__layout--v${isApiMode ? ' capsule__layout--v-api' : ''}`}
                    aria-hidden="true"
                  >
                    {capsuleWindowBadge ? (
                      <div className="capsule__pick">
                        <span>{capsuleWindowBadge}</span>
                      </div>
                    ) : null}
                    {isApiMode ? (
                      <>
                        {/* API 模式竖版:缓存命中率(含进度) → 今日 token */}
                        <ApiCapsuleStat
                          label={copy.usageCacheHit}
                          value={apiHitText}
                          fontPx={apiHitFont}
                          withProgress
                        />
                        <ApiCapsuleStat
                          label={copy.usageToday}
                          value={apiTokenText}
                          fontPx={apiTokenFont}
                        />
                      </>
                    ) : (
                      <>
                        {capsuleCreditText ? (
                          <div className="capsule__credit">
                            <TicketIcon />
                            <span>{capsuleCreditText}</span>
                          </div>
                        ) : null}
                        {capsuleWeeklyOrb}
                        {capsuleMetricBox}
                      </>
                    )}
                  </div>
                ) : (
                  <div
                    className={`capsule__layout capsule__layout--h${isApiMode ? ' capsule__layout--h-api' : ''}`}
                    aria-hidden="true"
                  >
                    {isApiMode ? (
                      <>
                        {/* API 模式横版:今日 token → 缓存命中率(含进度) → 推荐模型 */}
                        <ApiCapsuleStat
                          label={copy.usageToday}
                          value={apiTokenText}
                          fontPx={apiTokenFont}
                        />
                        <ApiCapsuleStat
                          label={copy.usageCacheHit}
                          value={apiHitText}
                          fontPx={apiHitFont}
                          withProgress
                        />
                      </>
                    ) : (
                      <>
                        <div className="capsule__col capsule__col--weekly">
                          <span className="capsule__weekly">
                            <HourglassIcon />
                            {capsuleResetText}
                          </span>
                        </div>
                        <div className="capsule__col capsule__col--metric">{capsuleMetricBox}</div>
                        <div className="capsule__col capsule__col--right">
                          {capsuleCreditText ? (
                            <div className="capsule__credit">
                              <TicketIcon />
                              <span>{capsuleCreditText}</span>
                            </div>
                          ) : null}
                          {capsuleWindowBadge ? (
                            <div className="capsule__pick">
                              <span>{capsuleWindowBadge}</span>
                            </div>
                          ) : null}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </>
            )}
          </section>
        </main>
      </div>
    )
  }

  const panelTabMotionClass = tabMotionView === panelView ? ' is-tab-switching' : ''
  const teamBoardMotionClass = teamBoardMotionActive ? ' is-team-switching' : ''

  return (
    <div className="app-shell app-shell--panel" data-theme={settings.theme}>
      <section className={`panel panel--${panelView}`}>
        <span className="panel__deco" aria-hidden="true" />
        {panelView === 'details' ? (
          <div className={`panel__body panel__body--details${panelTabMotionClass}`}>
            <div className="panel__content" ref={panelContentRef}>
              <PanelTabs
                current={panelView}
                labels={{ details: copy.details, team: copy.team, settings: copy.settings }}
                onChange={handlePanelViewChange}
              />
              <div className="panel__header panel__header--details">
                <div className="panel__header-title-group">
                  <h2 className="panel__title">{copy.details}</h2>
                  {isApiMode ? <span className="details-badge">{copy.apiBadge}</span> : null}
                </div>
              </div>

              {!isApiMode && cardWindows.length > 0 ? (
                <div className={`quota-grid${cardWindowCount === 1 ? ' quota-grid--single' : ''}`}>
                  {cardWindows.map((windowState, index) => (
                    <QuotaCard
                      key={windowState.id}
                      isAccent={index === 0 && (windowState.windowMinutes ?? Infinity) < 1440}
                      locale={settings.locale}
                      modeLabel={settings.percentageMode === 'used' ? copy.used : copy.remaining}
                      percentageMode={settings.percentageMode}
                      resetExpiryLabel={copy.resetExpiry}
                      theme={settings.theme}
                      windowState={windowState}
                    />
                  ))}
                </div>
              ) : null}

              <UsageCard authMode={snapshot.authMode} locale={settings.locale} />

              <div className="panel__rows">
                {detailRows.map((row) => (
                  <DetailRow
                    key={row.label}
                    badge={row.badge}
                    hint={row.hint}
                    icon={row.icon}
                    iconTone={row.iconTone}
                    label={row.label}
                    labelHref={row.labelHref}
                    value={row.value}
                    valueColor={row.valueColor}
                  />
                ))}
              </div>
              {isWindowKeeperAvailable ? (
                <WindowKeeperStatusCard
                  copy={copy}
                  isEligible={
                    snapshot.authMode === 'chatgpt' &&
                    rateLimitWindows.some((windowState) => windowState.windowMinutes === 300)
                  }
                  locale={settings.locale}
                  status={snapshot.windowKeeper}
                />
              ) : null}
            </div>

            <div className="panel__footer">
              <span className="panel__footer-meta">
                {sourceValue} · {copy.lastRefreshHint} ·{' '}
                {formatRelativeDate(snapshot.generatedAt, settings.locale)}
              </span>
              <button className="ghost-button" onClick={closePanel} type="button">
                <CloseIcon />
                <span>{copy.close}</span>
              </button>
            </div>
          </div>
        ) : panelView === 'team' ? (
          <div
            className={`panel__body panel__body--team${panelTabMotionClass}${teamBoardMotionClass}`}
          >
            <div className="panel__content" ref={panelContentRef}>
              <PanelTabs
                current={panelView}
                labels={{ details: copy.details, team: copy.team, settings: copy.settings }}
                onChange={handlePanelViewChange}
              />
              {announcement ? (
                <section
                  aria-label={announcement.unread ? copy.announcementUnread : copy.announcement}
                  aria-live="polite"
                  className={`team-announcement${announcement.unread ? ' is-unread' : ''}`}
                  ref={announcementRef}
                  tabIndex={-1}
                >
                  <div className="team-announcement__topline">
                    <span className="team-announcement__label">{copy.announcement}</span>
                    <span className="team-announcement__meta">
                      {announcement.message.senderNickname || copy.teamAnonymous} ·{' '}
                      {formatAnnouncementTime(
                        announcement.message.sentAt,
                        nowTick,
                        settings.locale
                      )}
                    </span>
                  </div>
                  <p className="team-announcement__text">{announcement.message.text}</p>
                  <button
                    className="team-announcement__acknowledge"
                    onClick={() =>
                      void window.codexStatus.acknowledgeAnnouncement(announcement.message.id)
                    }
                    type="button"
                  >
                    {copy.announcementAcknowledge}
                  </button>
                </section>
              ) : null}
              {isCodex ? (
                <div className="team-mode-switch">
                  <SegmentedControl
                    onChange={handleTeamBoardModeChange}
                    options={[
                      { label: copy.teamModeQuota, value: 'quota' },
                      { label: copy.teamModeTokens, value: 'tokens' }
                    ]}
                    value={teamBoardMode}
                  />
                </div>
              ) : null}
              <div className="panel__header panel__header--team">
                <div>
                  <h2 className="panel__title">
                    {effectiveTeamBoardMode === 'quota' ? copy.teamBoard : copy.teamTokenBoard}
                  </h2>
                </div>
                <button
                  className={`ghost-button ghost-button--accent team__refresh${
                    manualRefreshActive ? ' is-refreshing' : ''
                  }`}
                  disabled={manualRefreshActive || !canRefresh}
                  onClick={() => void handleRefresh()}
                  type="button"
                  aria-label={copy.refresh}
                >
                  <RefreshIcon />
                  <span>{manualRefreshActive ? copy.refreshing : copy.refresh}</span>
                </button>
              </div>

              {effectiveTeamBoardMode === 'tokens' ? (
                <>
                  <div className="team-window-switch">
                    <SegmentedControl
                      onChange={handleTeamTokenWindowChange}
                      options={[
                        { label: copy.usage1d, value: '1d' },
                        { label: copy.usage7d, value: '7d' },
                        { label: copy.usage30d, value: '30d' }
                      ]}
                      value={teamTokenWindow}
                    />
                  </div>
                  {teamTokenPeers.length > 0 ? (
                    <div className="team-board" key={`tokens-${teamTokenWindow}`}>
                      {teamTokenPeers.map((peer, index) => {
                        const showLikes = teamTokenWindow === '1d'
                        const like = showLikes ? aggregateReactions(peer.id) : undefined
                        return (
                          <TokenRow
                            appVersion={peer.appVersion}
                            isLatestVersion={
                              peer.appVersion !== undefined && maxAppVersion !== undefined
                                ? compareSemver(peer.appVersion, maxAppVersion) === 0
                                : undefined
                            }
                            isSelf={peer.isSelf}
                            key={peer.id}
                            likeCount={like?.count}
                            locale={settings.locale}
                            maxTokens={teamTokenMax}
                            nickname={peer.nickname || copy.teamAnonymous}
                            onLike={
                              showLikes ? () => void handleReactionToggle(peer.id) : undefined
                            }
                            rank={index + 1}
                            selfLiked={like?.selfLiked}
                            tokens={peer.tokenUsage?.[teamTokenWindow]}
                            tokensByAgent={peer.tokenUsageByAgent?.[teamTokenWindow]}
                          />
                        )
                      })}
                    </div>
                  ) : (
                    <p className="team-empty" key={`tokens-empty-${teamTokenWindow}`}>
                      {copy.teamEmpty}
                    </p>
                  )}
                </>
              ) : teamPeers.length > 0 ? (
                <div className="team-board" key="quota">
                  {teamPeers.map((peer, index) => (
                    <TeamRow
                      key={peer.id}
                      isSelf={peer.isSelf}
                      rank={index + 1}
                      nickname={peer.nickname || copy.teamAnonymous}
                      remainingPercent={peer.remainingPercent}
                      shortWindow={peer.shortWindow}
                      longWindow={peer.longWindow}
                      resetCreditCount={peer.resetCreditCount}
                      appVersion={peer.appVersion}
                      theme={settings.theme}
                      isLatestVersion={
                        peer.appVersion !== undefined && maxAppVersion !== undefined
                          ? compareSemver(peer.appVersion, maxAppVersion) === 0
                          : undefined
                      }
                    />
                  ))}
                </div>
              ) : (
                <p className="team-empty" key="quota-empty">
                  {copy.teamEmpty}
                </p>
              )}

              {/* 广播消息流:会话内仅实时,最新在底;发送经主进程校验与回显 */}
              <div className="team-broadcast">
                <div className="team-broadcast__feed" ref={broadcastFeedRef}>
                  {broadcastMessages.length > 0 ? (
                    broadcastMessages.map((message) => (
                      <div className="team-broadcast__item" key={message.id}>
                        <span className="team-broadcast__name">
                          {message.senderNickname || copy.teamAnonymous}
                        </span>
                        <span className="team-broadcast__time">
                          {formatMessageTime(message.sentAt)}
                        </span>
                        <span className="team-broadcast__text">{message.text}</span>
                      </div>
                    ))
                  ) : (
                    <p className="team-broadcast__empty">{copy.broadcastEmpty}</p>
                  )}
                </div>
                <div className="team-broadcast__composer">
                  <input
                    className="team-broadcast__input"
                    disabled={broadcastSending}
                    maxLength={200}
                    onChange={(event) => {
                      setBroadcastInput(event.target.value)
                      if (broadcastSendError) {
                        setBroadcastSendError('')
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        void handleBroadcastSend()
                      }
                    }}
                    placeholder={copy.broadcastPlaceholder}
                    type="text"
                    value={broadcastInput}
                  />
                  <button
                    className="ghost-button ghost-button--accent team-broadcast__send"
                    disabled={broadcastSending || broadcastInput.trim().length === 0}
                    onClick={() => void handleBroadcastSend()}
                    type="button"
                  >
                    {copy.broadcastSend}
                  </button>
                </div>
                {broadcastSendError ? (
                  <p className="team-broadcast__error">{broadcastSendError}</p>
                ) : null}
              </div>
            </div>

            <div className="panel__footer">
              <span className="panel__footer-meta">
                {copy.lastRefreshHint} · {formatRelativeDate(snapshot.generatedAt, settings.locale)}
              </span>
              <button className="ghost-button" onClick={closePanel} type="button">
                <CloseIcon />
                <span>{copy.close}</span>
              </button>
            </div>
          </div>
        ) : (
          <div className={`panel__body panel__body--settings${panelTabMotionClass}`}>
            <div className="panel__content" ref={panelContentRef}>
              <PanelTabs
                current={panelView}
                labels={{ details: copy.details, team: copy.team, settings: copy.settings }}
                onChange={handlePanelViewChange}
              />
              <div className="panel__header">
                <div>
                  <h2 className="panel__title">{copy.settings}</h2>
                </div>
              </div>

              <div className="settings-list">
                <div className="settings-section">
                  <p className="settings-section__title">{copy.groupAppearance}</p>
                  <SettingField label={copy.theme} hint={copy.themeHint}>
                    <SegmentedControl
                      scrollable
                      onChange={(value) => {
                        void handleSettingsPatch({ theme: value as ThemeId })
                      }}
                      options={THEME_OPTIONS.map((option) => ({
                        label: option.label,
                        value: option.value
                      }))}
                      value={settings.theme}
                    />
                  </SettingField>
                </div>

                <div className="settings-section">
                  <p className="settings-section__title">{copy.groupAgent}</p>
                  <SettingField label={copy.agentId} hint={copy.agentIdHint}>
                    <SegmentedControl
                      onChange={(value) => {
                        void handleSettingsPatch({
                          agentId: value as AppSettings['agentId']
                        })
                      }}
                      options={[
                        { label: 'Codex', value: 'codex' },
                        { label: 'Claude Code', value: 'claude' },
                        { label: 'OpenCode', value: 'opencode' }
                      ]}
                      value={settings.agentId}
                    />
                  </SettingField>
                  <div className="setting-stack tool-settings-list">
                    {isWindowKeeperAvailable ? (
                      <div className="setting-row tool-setting-row">
                        <div className="tool-setting-copy">
                          <span className="setting-field__label">{copy.autoKeep5hWindow}</span>
                          <small className="setting-field__hint">
                            {settings.locale === 'zh-CN'
                              ? '在当前 5h 窗口到期后自动启动下一窗口'
                              : 'Start the next 5h window after the current window expires'}
                          </small>
                        </div>
                        <ToggleSwitch
                          checked={settings.autoKeep5hWindow}
                          offLabel={copy.disabled}
                          onChange={(checked) => {
                            void handleSettingsPatch({ autoKeep5hWindow: checked })
                          }}
                          onLabel={copy.enabled}
                        />
                      </div>
                    ) : null}
                    <IslandSettingsCard
                      locale={settings.locale}
                      onChange={(island) => void handleSettingsPatch({ island })}
                      preferences={settings.island}
                      snapshot={islandSnapshot}
                    />
                  </div>
                </div>

                <div className="settings-section">
                  <p className="settings-section__title">{copy.groupRefresh}</p>
                  <SettingField label={copy.refreshMode}>
                    <SegmentedControl
                      onChange={(value) => {
                        void handleSettingsPatch({
                          refreshMode: value as AppSettings['refreshMode']
                        })
                      }}
                      options={[
                        { label: copy.auto, value: 'auto' },
                        { label: copy.manual, value: 'manual' }
                      ]}
                      value={settings.refreshMode}
                    />
                  </SettingField>

                  <SettingField label={copy.refreshInterval}>
                    <div className="setting-stack">
                      <SegmentedControl
                        disabled={settings.refreshMode === 'manual'}
                        onChange={selectRefreshInterval}
                        options={[
                          ...REFRESH_INTERVAL_OPTIONS.map((option) => ({
                            label: `${option}s`,
                            value: String(option)
                          })),
                          { label: copy.custom, value: 'custom' }
                        ]}
                        value={intervalControlValue}
                      />
                      {intervalControlValue === 'custom' ? (
                        <label
                          className={`inline-input ${canEditCustomRefresh ? '' : 'is-disabled'}`}
                        >
                          <span>{copy.customInterval}</span>
                          <input
                            disabled={!canEditCustomRefresh}
                            max={MAX_REFRESH_INTERVAL_SECONDS}
                            min={MIN_REFRESH_INTERVAL_SECONDS}
                            onBlur={commitCustomRefreshInterval}
                            onChange={(event) => {
                              setCustomRefreshInput(event.target.value)
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.currentTarget.blur()
                              }
                            }}
                            step={1}
                            type="number"
                            value={customRefreshInput}
                          />
                          <em>s</em>
                        </label>
                      ) : null}
                    </div>
                  </SettingField>
                </div>

                {isCodex ? (
                  <div className="settings-section">
                    <p className="settings-section__title">{copy.groupDisplay}</p>
                    <SettingField label={copy.percentageMode}>
                      <SegmentedControl
                        onChange={(value) => {
                          void handleSettingsPatch({
                            percentageMode: value as PercentageMode
                          })
                        }}
                        options={[
                          { label: copy.remaining, value: 'remaining' },
                          { label: copy.used, value: 'used' }
                        ]}
                        value={settings.percentageMode}
                      />
                    </SettingField>
                  </div>
                ) : null}

                {isCodex ? (
                  <div className="settings-section">
                    <p className="settings-section__title">{copy.groupRecommend}</p>
                    <SettingField label={copy.iqThreshold} hint={copy.iqThresholdHint}>
                      <label className="inline-input">
                        <span>{copy.iqThreshold}</span>
                        <input
                          max={MAX_IQ_THRESHOLD}
                          min={MIN_IQ_THRESHOLD}
                          onBlur={commitIqThreshold}
                          onChange={(event) => {
                            setIqThresholdInput(event.target.value)
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.currentTarget.blur()
                            }
                          }}
                          step={1}
                          type="number"
                          value={iqThresholdInput}
                        />
                        <em>IQ</em>
                      </label>
                    </SettingField>
                  </div>
                ) : null}

                <div className="settings-section settings-section--general">
                  <p className="settings-section__title">{copy.groupGeneral}</p>
                  <div className="setting-row">
                    <span>{copy.launchAtLogin}</span>
                    <ToggleSwitch
                      checked={settings.launchAtLogin}
                      offLabel={copy.disabled}
                      onChange={(checked) => {
                        void handleSettingsPatch({ launchAtLogin: checked })
                      }}
                      onLabel={copy.enabled}
                    />
                  </div>
                  <div className="setting-row">
                    <span>{copy.minimalMode}</span>
                    <ToggleSwitch
                      checked={settings.capsuleMinimalMode}
                      offLabel={copy.disabled}
                      onChange={(checked) => {
                        void handleSettingsPatch({ capsuleMinimalMode: checked })
                      }}
                      onLabel={copy.enabled}
                    />
                  </div>
                </div>

                <div className="settings-section">
                  <p className="settings-section__title">{copy.groupRegion}</p>
                  <SettingField label={copy.language}>
                    <SegmentedControl
                      onChange={(value) => {
                        void handleSettingsPatch({
                          locale: value as LocaleCode
                        })
                      }}
                      options={[
                        { label: '简中', value: 'zh-CN' },
                        { label: 'English', value: 'en-US' }
                      ]}
                      value={settings.locale}
                    />
                  </SettingField>
                </div>

                <div className="settings-section">
                  <p className="settings-section__title">{copy.team}</p>
                  <SettingField label={copy.teamNickname} hint={copy.teamNicknameHint}>
                    <label className="inline-input">
                      <span>{copy.teamNickname}</span>
                      <input
                        onBlur={commitTeamNickname}
                        onChange={(event) => {
                          setTeamNicknameInput(event.target.value)
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.currentTarget.blur()
                          }
                        }}
                        placeholder="我"
                        type="text"
                        value={teamNicknameInput}
                      />
                    </label>
                  </SettingField>
                  <SettingField label={copy.teamGroup} hint={copy.teamGroupHint}>
                    <label className="inline-input">
                      <span>{copy.teamGroup}</span>
                      <input
                        onBlur={commitTeamGroup}
                        onChange={(event) => {
                          setTeamGroupInput(event.target.value)
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.currentTarget.blur()
                          }
                        }}
                        type="text"
                        value={teamGroupInput}
                      />
                    </label>
                  </SettingField>
                </div>

                <div className="settings-section">
                  <p className="settings-section__title">{copy.groupAbout}</p>
                  <div ref={aboutRowRef} className="setting-row about-row">
                    <div className="about-row__info">
                      <span className="about-row__label">{copy.currentVersion}</span>
                      <span className="about-row__version">v{appVersion || '--'}</span>
                    </div>
                    {updateState === 'idle' && (
                      <button
                        className="ghost-button about-row__btn"
                        onClick={handleCheckUpdate}
                        type="button"
                      >
                        {copy.checkUpdate}
                      </button>
                    )}
                    {updateState === 'checking' && (
                      <button className="ghost-button about-row__btn" disabled type="button">
                        {copy.checking}
                      </button>
                    )}
                    {updateState === 'upToDate' && (
                      <span className="about-row__badge">{copy.upToDate}</span>
                    )}
                    {updateState === 'available' && (
                      <button
                        className="ghost-button about-row__btn"
                        onClick={handleDownloadUpdate}
                        type="button"
                      >
                        {copy.downloadNow} v{updateVersion}
                      </button>
                    )}
                    {updateState === 'downloaded' && (
                      <button
                        className="ghost-button about-row__btn"
                        onClick={handleInstallUpdate}
                        type="button"
                      >
                        {copy.installNow}
                      </button>
                    )}
                    {updateState === 'error' && (
                      <button
                        className="ghost-button about-row__btn"
                        onClick={handleCheckUpdate}
                        type="button"
                      >
                        {copy.retryUpdate}
                      </button>
                    )}
                  </div>
                  {updateState === 'available' && (
                    <p className="about-row__hint">
                      {copy.newVersionAvailable} v{updateVersion}
                    </p>
                  )}
                  {updateState === 'downloading' && (
                    <div className="update-progress">
                      <div className="update-progress__bar">
                        <span
                          className="update-progress__fill"
                          style={{ width: `${updateProgress}%` }}
                        />
                      </div>
                      <span className="update-progress__text">
                        {copy.downloading} {updateProgress}%
                      </span>
                    </div>
                  )}
                  {updateState === 'downloaded' && (
                    <p className="about-row__hint">
                      {copy.downloaded} v{updateVersion}
                    </p>
                  )}
                  {updateState === 'error' && (
                    <p className="about-row__hint about-row__hint--error">
                      {copy.updateError}: {updateError}
                    </p>
                  )}
                </div>
              </div>
            </div>

            <div className="panel__footer">
              <span className="panel__footer-meta">
                {copy.author} · libing{appVersion ? `  ·  ${copy.version} ${appVersion}` : ''}
              </span>
              <button className="ghost-button" onClick={closePanel} type="button">
                <CloseIcon />
                <span>{copy.close}</span>
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

export default App
