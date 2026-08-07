import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import {
  DEFAULT_IQ_THRESHOLD,
  DEFAULT_SETTINGS,
  DEFAULT_WINDOW_PREFERENCES,
  MAX_IQ_THRESHOLD,
  MIN_IQ_THRESHOLD,
  REFRESH_INTERVAL_OPTIONS,
  MAX_REFRESH_INTERVAL_SECONDS,
  MIN_REFRESH_INTERVAL_SECONDS,
  createEmptySnapshot,
  type AppSettings,
  type AuthMode,
  type LocaleCode,
  type PanelView,
  type PercentageMode,
  type RateLimitWindowSnapshot,
  type RendererWindowRole,
  type SpendUsage,
  type TokenUsageDay,
  type TokenUsageOverview,
  type UsageSnapshot,
  type UsageWindow,
  type WindowPreferences
} from '../../shared/capsule'

const DEFAULT_CUSTOM_REFRESH_INTERVAL_SECONDS = 40
const CAPSULE_CLICK_DRAG_DISTANCE = 5
const MANUAL_REFRESH_FEEDBACK_MS = 680

interface CapsulePointerState {
  pointerId: number
  originScreenX: number
  originScreenY: number
  offsetX: number
  offsetY: number
  hasDragged: boolean
}

const COPY = {
  'zh-CN': {
    noData: '无数据',
    refresh: '刷新',
    refreshing: '刷新中',
    source: '来源',
    lastRefresh: '最近刷新',
    settings: '设置',
    details: '详情',
    close: '收起',
    done: '完成',
    back: '返回详情',
    reset: '重置',
    refreshMode: '刷新模式',
    refreshInterval: '刷新间隔',
    customInterval: '自定义秒数',
    custom: '自定义',
    percentageMode: '百分比口径',
    language: '语种',
    launchAtLogin: '开机自启动',
    groupRefresh: '刷新',
    groupDisplay: '显示',
    groupGeneral: '通用',
    groupRecommend: '推荐策略',
    groupRegion: '语言与区域',
    auto: '自动',
    manual: '手动',
    enabled: '开启',
    disabled: '关闭',
    remaining: '剩余',
    used: '已使用',
    officialSource: '官方接口',
    localSource: '本地 JSONL',
    emptySource: '无数据',
    officialUnavailable: '官方接口不可用',
    lastRefreshHint: '最近刷新',
    resetExpiry: '到期时间',
    resetCredit: '重置卡',
    today: '今天',
    yesterday: '昨天',
    iqThreshold: '推荐模型 IQ 阈值',
    iqThresholdHint: '低于此分数的模型不进入推荐',
    team: '团队',
    teamBoard: '额度排行榜',
    teamBoardHint: '同组成员按剩余额度降序排名',
    teamModeQuota: '额度',
    teamModeTokens: 'Token消耗',
    teamTokenBoard: 'Token 消耗排行榜',
    teamEmpty: '暂无在线同事,加入团队后会显示同组成员',
    teamSummaryOnline: '在线',
    teamSummaryOnlineUnit: '人',
    teamSummaryAvg: '平均剩余',
    teamSummaryCredits: '重置卡共',
    teamSummaryCreditsUnit: '张',
    teamNickname: '团队昵称',
    teamNicknameHint: '仅作展示,不涉及凭据',
    teamGroup: '团队口令',
    teamGroupHint: '同口令的成员才互见',
    teamAnonymous: '未命名成员',
    author: '作者',
    version: '版本',
    groupAbout: '关于',
    currentVersion: '当前版本',
    checkUpdate: '检查更新',
    checking: '检查中…',
    upToDate: '已是最新版本',
    newVersionAvailable: '发现新版本',
    downloading: '下载中',
    downloaded: '下载完成',
    installNow: '安装并重启',
    updateError: '更新失败',
    retryUpdate: '重试',
    downloadNow: '立即下载',
    usage: '用量统计',
    usageTotal: '总 Token',
    usageInput: '输入',
    usageOutput: '输出',
    usageCost: '花费',
    usageCached: '缓存',
    usageReasoning: '思考',
    usageCacheHit: '缓存命中',
    usageToday: '今日消耗',
    usageEmpty: '暂无用量数据',
    apiModeSource: 'API Key · 按量计费',
    apiBadge: 'API Key',
    spendReal: '真实账单',
    usage1d: '1天',
    usage7d: '7天',
    usage30d: '30天',
    rangeStart: '开始',
    rangeEnd: '结束',
    rangeApply: '应用',
    usageEstimated: '本地估算'
  },
  'en-US': {
    noData: 'No data',
    refresh: 'Refresh',
    refreshing: 'Refreshing',
    source: 'Source',
    lastRefresh: 'Last refresh',
    settings: 'Settings',
    details: 'Details',
    close: 'Close',
    done: 'Done',
    back: 'Back to details',
    reset: 'reset',
    refreshMode: 'Refresh mode',
    refreshInterval: 'Refresh interval',
    customInterval: 'Custom seconds',
    custom: 'Custom',
    percentageMode: 'Metric mode',
    language: 'Language',
    launchAtLogin: 'Open at login',
    groupRefresh: 'Refresh',
    groupDisplay: 'Display',
    groupGeneral: 'General',
    groupRecommend: 'Recommendation',
    groupRegion: 'Language & region',
    auto: 'Auto',
    manual: 'Manual',
    enabled: 'Enabled',
    disabled: 'Disabled',
    remaining: 'Remaining',
    used: 'Used',
    officialSource: 'Official API',
    localSource: 'Local JSONL',
    emptySource: 'No data',
    officialUnavailable: 'Official API unavailable',
    lastRefreshHint: 'Last refresh',
    resetExpiry: 'Expires at',
    resetCredit: 'Reset card',
    today: 'Today',
    yesterday: 'Yesterday',
    iqThreshold: 'Model IQ threshold',
    iqThresholdHint: 'Models below this score are excluded from picks',
    team: 'Team',
    teamBoard: 'Quota leaderboard',
    teamBoardHint: 'Sorted by remaining quota, descending',
    teamModeQuota: 'Quota',
    teamModeTokens: 'Tokens',
    teamTokenBoard: 'Token usage',
    teamEmpty: 'No peers online. Join a team to see members.',
    teamSummaryOnline: 'Online',
    teamSummaryOnlineUnit: '',
    teamSummaryAvg: 'Avg remaining',
    teamSummaryCredits: 'Reset cards',
    teamSummaryCreditsUnit: '',
    teamNickname: 'Team nickname',
    teamNicknameHint: 'Display only, no credentials shared',
    teamGroup: 'Team passphrase',
    teamGroupHint: 'Only peers with the same passphrase can see each other',
    teamAnonymous: 'Unnamed member',
    author: 'Author',
    version: 'Version',
    groupAbout: 'About',
    currentVersion: 'Current version',
    checkUpdate: 'Check for updates',
    checking: 'Checking…',
    upToDate: 'Up to date',
    newVersionAvailable: 'New version available',
    downloading: 'Downloading',
    downloaded: 'Downloaded',
    installNow: 'Install & restart',
    updateError: 'Update failed',
    retryUpdate: 'Retry',
    downloadNow: 'Download',
    usage: 'Usage stats',
    usageTotal: 'Tokens',
    usageInput: 'Input',
    usageOutput: 'Output',
    usageCost: 'Cost',
    usageCached: 'Cached',
    usageReasoning: 'Reasoning',
    usageCacheHit: 'Cache hit',
    usageToday: 'Today used',
    usageEmpty: 'No usage data yet',
    apiModeSource: 'API Key · usage-based',
    apiBadge: 'API Key',
    spendReal: 'Real billing',
    usage1d: '1d',
    usage7d: '7d',
    usage30d: '30d',
    rangeStart: 'Start',
    rangeEnd: 'End',
    rangeApply: 'Apply',
    usageEstimated: 'Estimated'
  }
} as const

function App(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<UsageSnapshot>(() => createEmptySnapshot())
  // API Key 模式胶囊:今日 token 用量(取 1d 窗口,算缓存命中率与今日用量)
  const [capsuleToday, setCapsuleToday] = useState<TokenUsageOverview | undefined>(undefined)
  const [settings, setSettings] = useState<AppSettings>({ ...DEFAULT_SETTINGS })
  const [windowPreferences, setWindowPreferences] = useState<WindowPreferences>({
    ...DEFAULT_WINDOW_PREFERENCES
  })
  const [windowRole, setWindowRole] = useState<RendererWindowRole>('capsule')
  const [panelView, setPanelView] = useState<PanelView>('details')
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
  const [capsulePointerActive, setCapsulePointerActive] = useState(false)
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
  // 详情面板里长窗口(周重置)倒计时需要秒级刷新;只在面板可见且有长窗口时 tick
  const [nowTick, setNowTick] = useState(() => Date.now())
  const capsulePointerRef = useRef<CapsulePointerState | null>(null)
  const capsuleRef = useRef<HTMLElement | null>(null)
  const manualRefreshTimerRef = useRef<number | undefined>(undefined)
  const justRefreshedTimerRef = useRef<number | undefined>(undefined)
  // "已是最新"提示停留几秒后自动回 idle
  const upToDateTimerRef = useRef<number | undefined>(undefined)

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
        setWindowPreferences(payload.window)
        setWindowRole(payload.role)
        setPanelView(payload.panelView)
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

    const disposeCommand = window.codexStatus.onCommand((payload) => {
      if (payload.type !== 'show-panel-view') {
        return
      }

      setPanelView(payload.panelView)
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

    return () => {
      active = false
      if (manualRefreshTimerRef.current !== undefined) {
        window.clearTimeout(manualRefreshTimerRef.current)
      }
      if (justRefreshedTimerRef.current !== undefined) {
        window.clearTimeout(justRefreshedTimerRef.current)
      }
      if (upToDateTimerRef.current !== undefined) {
        window.clearTimeout(upToDateTimerRef.current)
      }
      disposeSnapshot()
      disposePreferences()
      disposeCommand()
      disposeUpdateProgress()
    }
  }, [])

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
  const sourceValue = isApiMode
    ? copy.apiModeSource
    : snapshot.rateLimitSource === 'none'
      ? copy.noData
      : snapshot.sourceHost
  const rateLimitWindows = [...snapshot.rateLimits].sort((a, b) => {
    // 短窗口(5h)排在前,长窗口(7d)排在后,确保胶囊取到5h优先
    const am = a.windowMinutes ?? 0
    const bm = b.windowMinutes ?? 0
    return am - bm
  }).map((w) => ({
    ...w,
    label: w.label === '7d' && settings.locale === 'zh-CN' ? '1周' : w.label === '5h' && settings.locale === 'zh-CN' ? '5小时' : w.label
  }))
  // 所有窗口都用 QuotaCard 展示(5h+7d);胶囊百分比+进度条优先取短窗口,无短窗口则取长窗口兜底
  const cardWindows = rateLimitWindows
  const cardWindowCount = cardWindows.length
  // 胶囊:百分比+进度条取首窗口(5h优先,无则7d);左侧倒计时也取同一个窗口的resetsAt
  const displayedRateLimit = rateLimitWindows[0]
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
    isApiMode ? 'remaining' : settings.percentageMode
  )
  const capsuleResetAt = displayedRateLimit?.resetsAt
  const capsuleResetText = formatCountdownCapsule(capsuleResetAt, nowTick)
  // API Key 模式左槽:今日 token;OAuth 模式为窗口重置倒计时
  const capsuleWeeklyText = isApiMode
    ? apiTodayTotal === undefined
      ? '--'
      : formatCompactTokens(apiTodayTotal, settings.locale)
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
  const capsulePickText = snapshot.bestModelPick
    ? formatModelPick(snapshot.bestModelPick.shortLabel)
    : ''
  const capsulePickColor = resolveModelColor(snapshot.bestModelPick?.label)
  const capsulePickTitle = snapshot.bestModelPick
    ? `${snapshot.bestModelPick.label} · IQ ${snapshot.bestModelPick.score.toFixed(1)} · $${snapshot.bestModelPick.averageCostUsd.toFixed(2)}/题`
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
    if (!isApiMode || windowRole !== 'capsule') {
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
  }, [isApiMode, windowRole, apiTokenText, apiHitText, capsulePickText, capsuleViewMode])
  // 团队额度排行榜:按剩余额度降序(undefined 视为 0,排末尾);API Key 登录无订阅额度(恒 0),不参与额度排行
  const teamPeers = [...(snapshot.teamPeers ?? [])]
    .filter((peer) => peer.authMode !== 'api')
    .sort((a, b) => {
      const ar = a.remainingPercent ?? -1
      const br = b.remainingPercent ?? -1
      return br - ar
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
  const capsuleClassName = [
    'capsule',
    `capsule--${capsuleViewMode}`,
    updateState === 'available' || updateState === 'downloading' || updateState === 'downloaded'
      ? 'has-update'
      : '',
    snapshot.isRefreshing ? 'is-refreshing' : '',
    manualRefreshActive ? 'is-manual-refreshing' : '',
    canRefresh ? '' : 'is-static',
    capsulePointerActive ? 'is-dragging' : ''
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
        ? (settings.locale === 'zh-CN'
          ? `IQ ${snapshot.bestModelPick.score.toFixed(1)} · $${snapshot.bestModelPick.averageCostUsd.toFixed(2)}/题`
          : `IQ ${snapshot.bestModelPick.score.toFixed(1)} · $${snapshot.bestModelPick.averageCostUsd.toFixed(2)}/task`)
        : undefined
    },
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
  useEffect(() => {
    const isPanelWithResetWindow = windowRole === 'panel' && panelView === 'details' && hasResetWindow
    const isCapsuleWithResetWindow = windowRole === 'capsule' && hasResetWindow
    if (!isPanelWithResetWindow && !isCapsuleWithResetWindow) {
      return
    }

    const timer = window.setInterval(() => {
      setNowTick(Date.now())
    }, 1000)
    return () => {
      window.clearInterval(timer)
    }
  }, [windowRole, panelView, hasResetWindow])

  // panel 窗口显示时机:等 React commit + 浏览器 paint 完成后再通知主进程 show。
  // 用 rAF 推迟到下一帧,确保 DOM 已真正绘制——避免窗口 show 时画面仍空导致闪一下。
  useEffect(() => {
    if (!ready || windowRole !== 'panel') {
      return
    }
    const raf = window.requestAnimationFrame(() => {
      void window.codexStatus.notifyPanelReady()
    })
    return () => {
      window.cancelAnimationFrame(raf)
    }
  }, [ready, windowRole])

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

    // 点击胶囊(无拖拽)直接打开详情面板,不再触发刷新;刷新入口移至右键菜单和面板内按钮
    if (shouldRefreshOnClick) {
      void window.codexStatus.showPanel('details')
    }
  }

  function handleCapsuleKeyDown(event: React.KeyboardEvent<HTMLElement>): void {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return
    }

    event.preventDefault()
    void window.codexStatus.showPanel('details')
  }

  function recordSnapshotIssue(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    setSnapshot((previous) => ({
      ...previous,
      isRefreshing: false,
      issues: Array.from(new Set([message, ...previous.issues])).slice(0, 6)
    }))
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
      <div className="app-shell app-shell--capsule">
        <main className="widget">
          <section
            ref={capsuleRef}
            aria-label={copy.details}
            className={capsuleClassName}
            style={capsuleProgressStyle}
            onKeyDown={handleCapsuleKeyDown}
            onPointerCancel={handleCapsulePointerCancel}
            onPointerDown={handleCapsulePointerDown}
            onPointerMove={handleCapsulePointerMove}
            onPointerUp={handleCapsulePointerUp}
            role="button"
            tabIndex={0}
          >
            {capsuleViewMode === 'orb' ? (
              <div
                className={`capsule__layout capsule__layout--v${isApiMode ? ' capsule__layout--v-api' : ''}`}
                aria-hidden="true"
              >
                {capsulePickText ? (
                  <div
                    className="capsule__pick"
                    style={{ color: capsulePickColor }}
                    title={capsulePickTitle}
                  >
                    <span>{capsulePickText}</span>
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
                    <ApiCapsuleStat label={copy.usageToday} value={apiTokenText} fontPx={apiTokenFont} />
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
                    <ApiCapsuleStat label={copy.usageToday} value={apiTokenText} fontPx={apiTokenFont} />
                    <ApiCapsuleStat
                      label={copy.usageCacheHit}
                      value={apiHitText}
                      fontPx={apiHitFont}
                      withProgress
                    />
                    <div className="capsule__col capsule__col--right">
                      {capsulePickText ? (
                        <div
                          className="capsule__pick"
                          style={{ color: capsulePickColor }}
                          title={capsulePickTitle}
                        >
                          <span>{capsulePickText}</span>
                        </div>
                      ) : null}
                    </div>
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
                      {capsulePickText ? (
                        <div
                          className="capsule__pick"
                          style={{ color: capsulePickColor }}
                          title={capsulePickTitle}
                        >
                          <span>{capsulePickText}</span>
                        </div>
                      ) : null}
                    </div>
                  </>
                )}
              </div>
            )}
          </section>
        </main>
      </div>
    )
  }

  return (
    <div className="app-shell app-shell--panel">
      <section className={`panel panel--${panelView}`}>
        {panelView === 'details' ? (
          <div className="panel__body panel__body--details">
            <div className="panel__content">
              <PanelTabs
                current={panelView}
                labels={{ details: copy.details, team: copy.team, settings: copy.settings }}
                onChange={(view) => setPanelView(view)}
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
                      isAccent={index === 0}
                      locale={settings.locale}
                      modeLabel={settings.percentageMode === 'used' ? copy.used : copy.remaining}
                      percentageMode={settings.percentageMode}
                      resetExpiryLabel={copy.resetExpiry}
                      windowState={windowState}
                    />
                  ))}
                </div>
              ) : null}

              <UsageCard
                authMode={snapshot.authMode}
                locale={settings.locale}
              />

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
            </div>

            <div className="panel__footer">
              <span className="panel__footer-meta">
                {sourceValue} · {copy.lastRefreshHint} · {formatRelativeDate(snapshot.generatedAt, settings.locale)}
              </span>
              <button className="ghost-button" onClick={closePanel} type="button">
                <CloseIcon />
                <span>{copy.close}</span>
              </button>
            </div>
          </div>
        ) : panelView === 'team' ? (
          <div className="panel__body panel__body--team">
            <div className="panel__content">
              <PanelTabs
                current={panelView}
                labels={{ details: copy.details, team: copy.team, settings: copy.settings }}
                onChange={(view) => setPanelView(view)}
              />
              <div className="team-mode-switch">
                <SegmentedControl
                  onChange={(value) => setTeamBoardMode(value as 'quota' | 'tokens')}
                  options={[
                    { label: copy.teamModeQuota, value: 'quota' },
                    { label: copy.teamModeTokens, value: 'tokens' }
                  ]}
                  value={teamBoardMode}
                />
              </div>
              <div className="panel__header panel__header--team">
                <div>
                  <h2 className="panel__title">
                    {teamBoardMode === 'quota' ? copy.teamBoard : copy.teamTokenBoard}
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

              {teamBoardMode === 'tokens' ? (
                <>
                  <div className="team-window-switch">
                    <SegmentedControl
                      onChange={(value) => setTeamTokenWindow(value as UsageWindow)}
                      options={[
                        { label: copy.usage1d, value: '1d' },
                        { label: copy.usage7d, value: '7d' },
                        { label: copy.usage30d, value: '30d' }
                      ]}
                      value={teamTokenWindow}
                    />
                  </div>
                  {teamTokenPeers.length > 0 ? (
                    <div className="team-board">
                      {teamTokenPeers.map((peer, index) => (
                        <TokenRow
                          isSelf={peer.isSelf}
                          key={peer.id}
                          locale={settings.locale}
                          maxTokens={teamTokenMax}
                          nickname={peer.nickname || copy.teamAnonymous}
                          rank={index + 1}
                          tokens={peer.tokenUsage?.[teamTokenWindow]}
                        />
                      ))}
                    </div>
                  ) : (
                    <p className="team-empty">{copy.teamEmpty}</p>
                  )}
                </>
              ) : teamPeers.length > 0 ? (
                <div className="team-board">
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
                    />
                  ))}
                </div>
              ) : (
                <p className="team-empty">{copy.teamEmpty}</p>
              )}
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
          <div className="panel__body panel__body--settings">
            <div className="panel__content">
              <PanelTabs
                current={panelView}
                labels={{ details: copy.details, team: copy.team, settings: copy.settings }}
                onChange={(view) => setPanelView(view)}
              />
              <div className="panel__header">
                <div>
                  <h2 className="panel__title">{copy.settings}</h2>
                </div>
              </div>

              <div className="settings-list">
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
                          className={`inline-input ${canEditCustomRefresh ? 'is-active' : 'is-disabled'}`}
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

                <div className="settings-section">
                  <p className="settings-section__title">{copy.groupRecommend}</p>
                  <SettingField label={copy.iqThreshold} hint={copy.iqThresholdHint}>
                    <label className="inline-input is-active">
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

                <div className="settings-section">
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
                    <label className="inline-input is-active">
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
                    <label className="inline-input is-active">
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
                  <div className="setting-row about-row">
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
                      <button
                        className="ghost-button about-row__btn"
                        disabled
                        type="button"
                      >
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
                    <p className="about-row__hint">{copy.downloaded}</p>
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

function QuotaCard({
  isAccent,
  locale,
  modeLabel,
  percentageMode,
  windowState,
  resetExpiryLabel
}: {
  isAccent?: boolean
  locale: LocaleCode
  modeLabel: string
  percentageMode: PercentageMode
  windowState: RateLimitWindowSnapshot
  resetExpiryLabel: string
}): React.JSX.Element {
  const displayPercent =
    percentageMode === 'used' ? windowState?.usedPercent : windowState?.remainingPercent
  const progressStyle = createMetricProgressStyle(displayPercent, percentageMode)
  const resetTimeText = formatCapsuleResetTime(windowState?.resetsAt, locale)

  return (
    <div className={`quota-card${isAccent ? ' is-accent' : ''}`} style={progressStyle}>
      <div className="quota-card__head">
        <span className="quota-card__label">{windowState.label}</span>
        <span className="quota-card__mode">{modeLabel}</span>
      </div>
      <div className="quota-card__value">
        {displayPercent === undefined ? '--' : `${Math.round(displayPercent)}%`}
      </div>
      <span className="quota-card__progress" aria-hidden="true">
        <span />
      </span>
      <p className="quota-card__reset">
        {formatQuotaResetHint(windowState?.resetsInSeconds, locale)}
      </p>
      {windowState.resetsAt ? (
        <p className="quota-card__expiry">
          {resetExpiryLabel}: {resetTimeText}
        </p>
      ) : null}
    </div>
  )
}

function formatQuotaResetHint(seconds: number | undefined, locale: LocaleCode): string {
  const duration = formatRelativeDuration(seconds, locale, locale === 'zh-CN')
  if (!duration) {
    return '--'
  }

  return locale === 'zh-CN' ? `${duration}重置` : `resets in ${duration}`
}

// 用量统计卡片:1/7/30 天 token 与花费,分段切换 + 每日柱状图
// API Key 模式胶囊统计单元:小标签 + 自适应字号数值 + 可选进度条
function ApiCapsuleStat({
  label,
  value,
  fontPx,
  withProgress
}: {
  label: string
  value: string
  fontPx: number
  withProgress?: boolean
}): React.JSX.Element {
  return (
    <div className={`capsule__stat${withProgress ? ' capsule__stat--metric' : ''}`}>
      <span className="capsule__stat-label">{label}</span>
      <span className="capsule__stat-value" style={{ fontSize: `${fontPx}px` }}>
        {value}
      </span>
      {withProgress ? (
        <span className="capsule__progress" aria-hidden="true">
          <span />
        </span>
      ) : null}
    </div>
  )
}

// 自定义用量区间的上限(天),与主进程扫描窗口一致;超出部分取不到数据
const MAX_RANGE_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

const EMPTY_USAGE_OVERVIEW: TokenUsageOverview = {
  available: false,
  generatedAt: '',
  days: [],
  totals: { input: 0, cachedInput: 0, output: 0, reasoning: 0, total: 0, cost: 0 }
}

function UsageCard({
  locale,
  authMode
}: {
  locale: LocaleCode
  authMode: AuthMode
}): React.JSX.Element {
  const copy = COPY[locale]
  // 三个窗口一次性预取,切换按钮即时显示,避免每次切换重新拉取导致的闪烁
  const [usageByWindow, setUsageByWindow] = useState<
    Partial<Record<UsageWindow, TokenUsageOverview>>
  >({})
  // API Key 模式真实账单花费(窗口维度)
  const [spendByWindow, setSpendByWindow] = useState<Partial<Record<UsageWindow, SpendUsage>>>({})
  const [hoveredIndex, setHoveredIndex] = useState<number | undefined>(undefined)

  // 区间选择:customRange 为空=1/7/30 天预设,有值=自定义起止时间(毫秒)
  const [presetWindow, setPresetWindow] = useState<UsageWindow>('7d')
  const [customRange, setCustomRange] = useState<{ startMs: number; endMs: number } | undefined>(
    undefined
  )
  const [rangeOpen, setRangeOpen] = useState(false)
  const [rangeUsage, setRangeUsage] = useState<TokenUsageOverview | undefined>(undefined)
  const [rangeLoading, setRangeLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    for (const w of ['1d', '7d', '30d'] as UsageWindow[]) {
      window.codexStatus
        .getTokenUsage(w)
        .then((result) => {
          if (!cancelled) {
            setUsageByWindow((prev) => ({ ...prev, [w]: result }))
          }
        })
        .catch(() => {
          if (!cancelled) {
            setUsageByWindow((prev) => ({ ...prev, [w]: EMPTY_USAGE_OVERVIEW }))
          }
        })
    }
    return () => {
      cancelled = true
    }
  }, [])

  // API Key 模式:预取真实账单花费,账单不可用时 UI 回落 token 估算
  useEffect(() => {
    if (authMode !== 'api') {
      return
    }
    let cancelled = false
    for (const w of ['1d', '7d', '30d'] as UsageWindow[]) {
      window.codexStatus
        .getSpendUsage(w)
        .then((result) => {
          if (!cancelled) {
            setSpendByWindow((prev) => ({ ...prev, [w]: result }))
          }
        })
        .catch(() => {
          // 忽略:账单失败保持空,回落估算
        })
    }
    return () => {
      cancelled = true
    }
  }, [authMode])

  const isCustom = customRange !== undefined
  const customStartMs = customRange?.startMs
  const customEndMs = customRange?.endMs

  const loadCustomRange = (startMs: number, endMs: number): void => {
    setRangeLoading(true)
    window.codexStatus
      .getTokenUsageRange(startMs, endMs)
      .then((result) => {
        setRangeUsage(result)
      })
      .catch(() => {
        setRangeUsage(EMPTY_USAGE_OVERVIEW)
      })
      .finally(() => {
        setRangeLoading(false)
      })
  }

  const usage = usageByWindow[presetWindow]
  const isLoading = usage === undefined
  const days = usage?.days ?? []
  const totals = usage?.totals
  const hasData = usage?.available === true && totals !== undefined
  const chartMax = Math.max(1, days.reduce((max, day) => Math.max(max, day.input + day.output), 0))
  // API Key 模式:真实账单可用时用账单金额替代 token 估算
  const spend = spendByWindow[presetWindow]
  const spendMap =
    spend?.available === true ? new Map(spend.days.map((d) => [d.date, d.cost])) : undefined
  const costIsReal = spendMap !== undefined
  const costValue = costIsReal ? formatUsd(spend?.total ?? 0) : formatUsd(totals?.cost ?? 0)

  // 自定义区间视图数据
  const rangeTotals = rangeUsage?.totals
  const rangeDay = rangeUsage?.days[0]
  const rangeHasData =
    rangeUsage?.available === true && rangeTotals !== undefined && rangeDay !== undefined

  const triggerLabel = isCustom
    ? formatRangeLabel(customStartMs ?? 0, customEndMs ?? 0)
    : presetWindow === '1d'
      ? copy.usage1d
      : presetWindow === '7d'
        ? copy.usage7d
        : copy.usage30d

  return (
    <section className="usage-card">
      <div className="usage-card__head">
        <span className="usage-card__title">{copy.usage}</span>
        <div className="usage-card__seg">
          <button
            className="usage-range-trigger"
            type="button"
            onClick={() => setRangeOpen((open) => !open)}
          >
            <span className="usage-range-trigger__label">{triggerLabel}</span>
            <span className="usage-range-trigger__caret" aria-hidden="true">
              ▾
            </span>
          </button>
        </div>
      </div>

      {rangeOpen ? (
        <RangePanel
          copy={copy}
          presetWindow={presetWindow}
          startMs={customStartMs}
          endMs={customEndMs}
          onPreset={(window) => {
            setPresetWindow(window)
            setCustomRange(undefined)
            setRangeOpen(false)
          }}
          onCustom={(startMs, endMs) => {
            setCustomRange({ startMs, endMs })
            setRangeOpen(false)
            loadCustomRange(startMs, endMs)
          }}
        />
      ) : null}

      {isCustom ? (
        rangeLoading ? (
          <p className="usage-card__empty">{copy.refreshing}</p>
        ) : !rangeHasData ? (
          <p className="usage-card__empty">{copy.usageEmpty}</p>
        ) : (
          <>
            <div className="usage-summary">
              <UsageSummaryItem
                label={copy.usageTotal}
                value={formatCompactTokens(rangeTotals.total, locale)}
              />
              <UsageSummaryItem
                label={copy.usageInput}
                value={formatCompactTokens(rangeTotals.input, locale)}
                tone="input"
              />
              <UsageSummaryItem
                label={copy.usageOutput}
                value={formatCompactTokens(rangeTotals.output, locale)}
                tone="output"
              />
              <UsageSummaryItem
                label={copy.usageCacheHit}
                value={formatCacheHit(rangeTotals.input, rangeTotals.cachedInput)}
                tone="cached"
              />
              <UsageSummaryItem label={copy.usageCost} value={formatUsd(rangeTotals.cost)} tone="cost" />
            </div>
            <UsageBar day={rangeDay} locale={locale} />
            {/* 自定义区间无真实账单口径,始终标注估算 */}
            <p className="usage-card__spend-hint">{copy.usageEstimated}</p>
          </>
        )
      ) : isLoading ? (
        <p className="usage-card__empty">{copy.refreshing}</p>
      ) : !hasData ? (
        <p className="usage-card__empty">{copy.usageEmpty}</p>
      ) : (
        <>
          <div className="usage-summary">
            <UsageSummaryItem label={copy.usageTotal} value={formatCompactTokens(totals.total, locale)} />
            <UsageSummaryItem
              label={copy.usageInput}
              value={formatCompactTokens(totals.input, locale)}
              tone="input"
            />
            <UsageSummaryItem
              label={copy.usageOutput}
              value={formatCompactTokens(totals.output, locale)}
              tone="output"
            />
            <UsageSummaryItem
              label={copy.usageCacheHit}
              value={formatCacheHit(totals.input, totals.cachedInput)}
              tone="cached"
            />
            <UsageSummaryItem label={copy.usageCost} value={costValue} tone="cost" />
          </div>
          {days.length <= 1 && days[0] ? (
            <UsageBar day={days[0]} locale={locale} />
          ) : (
            <div className="usage-chart" onMouseLeave={() => setHoveredIndex(undefined)}>
              {hoveredIndex !== undefined && days[hoveredIndex] ? (
                <UsageTooltip
                  day={days[hoveredIndex]}
                  index={hoveredIndex}
                  count={days.length}
                  locale={locale}
                  spendMap={spendMap}
                />
              ) : null}
              {days.map((day, index) => {
                const value = day.input + day.output
                const percent = value > 0 ? Math.max(6, (value / chartMax) * 100) : 2
                const total = Math.max(1, value)
                const newInput = Math.max(0, day.input - day.cachedInput)
                // 三段占比合计 100%,从下到上:缓存输入 / 新输入 / 输出
                const cachedPct = (day.cachedInput / total) * 100
                const inputPct = (newInput / total) * 100
                const outputPct = (day.output / total) * 100
                return (
                  <div
                    className="usage-chart__col"
                    key={day.date}
                    onMouseEnter={() => setHoveredIndex(index)}
                  >
                    <span className="usage-chart__bar-wrap">
                      <span className="usage-chart__bar usage-chart__bar--stack" style={{ height: `${percent}%` }}>
                        <span className="usage-chart__bar-seg is-cached" style={{ height: `${cachedPct}%` }} />
                        <span className="usage-chart__bar-seg is-input" style={{ height: `${inputPct}%` }} />
                        <span className="usage-chart__bar-seg is-output" style={{ height: `${outputPct}%` }} />
                      </span>
                    </span>
                    <span
                      className={`usage-chart__date${shouldShowDateLabel(days.length, index) ? '' : ' is-hidden'}`}
                    >
                      {formatDayLabel(day.date)}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
          {costIsReal ? <p className="usage-card__spend-hint">{copy.spendReal}</p> : null}
        </>
      )}
    </section>
  )
}

// 自定义区间选择面板:预设窗口 + 起止「日期+时分」输入,点「应用」生效
function RangePanel({
  copy,
  presetWindow,
  startMs,
  endMs,
  onPreset,
  onCustom
}: {
  copy: (typeof COPY)[LocaleCode]
  presetWindow: UsageWindow
  startMs: number | undefined
  endMs: number | undefined
  onPreset: (window: UsageWindow) => void
  onCustom: (startMs: number, endMs: number) => void
}): React.JSX.Element {
  // mount 时取一次当前时间,作为区间回填与日期输入范围的基准(render 期间不调用不纯的 Date.now)
  const [now] = useState(() => Date.now())
  const fallbackEnd = endMs ?? now
  // 默认回填 7 个自然日(今天 00:00 往前 6 天 → 当前时刻),与预设「7天」口径一致;
  // 若按滚动 7×24h(now-7 天)回填,会因多含前一日尾巴时段而与预设数字明显不同
  const todayStartMs = (() => {
    const day = new Date(now)
    return new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime()
  })()
  const fallbackStart = startMs ?? todayStartMs - 6 * DAY_MS
  const [startDate, setStartDate] = useState(() => toDateInput(fallbackStart))
  const [startTime, setStartTime] = useState(() => toTimeInput(fallbackStart))
  const [endDate, setEndDate] = useState(() => toDateInput(fallbackEnd))
  const [endTime, setEndTime] = useState(() => toTimeInput(fallbackEnd))

  const minDate = toDateInput(now - (MAX_RANGE_DAYS - 1) * DAY_MS)
  const maxDate = toDateInput(now)

  const toMs = (date: string, time: string): number | undefined => {
    if (!date || !time) {
      return undefined
    }
    const ms = new Date(`${date}T${time}`).getTime()
    return Number.isFinite(ms) ? ms : undefined
  }
  const startMsValue = toMs(startDate, startTime)
  const endMsValue = toMs(endDate, endTime)
  const valid = startMsValue !== undefined && endMsValue !== undefined && endMsValue > startMsValue

  return (
    <div className="usage-range-panel">
      <div className="usage-range-presets">
        {(['1d', '7d', '30d'] as UsageWindow[]).map((window) => (
          <button
            className={`usage-range-presets__btn${
              window === presetWindow && startMs === undefined ? ' is-active' : ''
            }`}
            key={window}
            type="button"
            onClick={() => onPreset(window)}
          >
            {window === '1d' ? copy.usage1d : window === '7d' ? copy.usage7d : copy.usage30d}
          </button>
        ))}
      </div>
      <div className="usage-range-fields">
        <div className="usage-range-field">
          <span className="usage-range-field__label">{copy.rangeStart}</span>
          <input
            type="date"
            value={startDate}
            min={minDate}
            max={maxDate}
            onChange={(event) => setStartDate(event.target.value)}
          />
          <input
            type="time"
            value={startTime}
            onChange={(event) => setStartTime(event.target.value)}
          />
        </div>
        <div className="usage-range-field">
          <span className="usage-range-field__label">{copy.rangeEnd}</span>
          <input
            type="date"
            value={endDate}
            min={minDate}
            max={maxDate}
            onChange={(event) => setEndDate(event.target.value)}
          />
          <input
            type="time"
            value={endTime}
            onChange={(event) => setEndTime(event.target.value)}
          />
        </div>
      </div>
      <button
        className="usage-range-apply"
        disabled={!valid}
        type="button"
        onClick={() => {
          if (startMsValue !== undefined && endMsValue !== undefined) {
            onCustom(startMsValue, endMsValue)
          }
        }}
      >
        {copy.rangeApply}
      </button>
    </div>
  )
}

// 触发器文本:同日内折叠为「MM-DD HH:mm – HH:mm」,跨天显示完整起止
function formatRangeLabel(startMs: number, endMs: number): string {
  const start = new Date(startMs)
  const end = new Date(endMs)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const date = (dt: Date): string => `${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`
  const time = (dt: Date): string => `${pad(dt.getHours())}:${pad(dt.getMinutes())}`
  return start.toDateString() === end.toDateString()
    ? `${date(start)} ${time(start)} – ${time(end)}`
    : `${date(start)} ${time(start)} – ${date(end)} ${time(end)}`
}

function toDateInput(ms: number): string {
  const dt = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`
}

function toTimeInput(ms: number): string {
  const dt = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(dt.getHours())}:${pad(dt.getMinutes())}`
}

// 柱状图 hover 浮层:单日完整明细
function UsageTooltip({
  day,
  index,
  count,
  locale,
  spendMap
}: {
  day: TokenUsageDay
  index: number
  count: number
  locale: LocaleCode
  spendMap?: Map<string, number>
}): React.JSX.Element {
  const copy = COPY[locale]
  // 浮层居中于当前柱,靠边时向内收避免溢出卡片
  const left = Math.max(15, Math.min(85, ((index + 0.5) / count) * 100))
  const realCost = spendMap?.get(day.date)
  const costText = realCost !== undefined ? formatUsd(realCost) : formatUsd(day.cost)
  return (
    <div className="usage-tooltip" style={{ left: `${left}%` }}>
      <div className="usage-tooltip__date">{day.date}</div>
      <div className="usage-tooltip__row">
        <span>{copy.usageTotal}</span>
        <span>{formatCompactTokens(day.input + day.output, locale)}</span>
      </div>
      <div className="usage-tooltip__row">
        <span>{copy.usageInput}</span>
        <span>{formatCompactTokens(day.input, locale)}</span>
      </div>
      <div className="usage-tooltip__row">
        <span>{copy.usageCached}</span>
        <span>{formatCompactTokens(day.cachedInput, locale)}</span>
      </div>
      <div className="usage-tooltip__row">
        <span>{copy.usageCacheHit}</span>
        <span>{formatCacheHit(day.input, day.cachedInput)}</span>
      </div>
      <div className="usage-tooltip__row">
        <span>{copy.usageOutput}</span>
        <span>{formatCompactTokens(day.output, locale)}</span>
      </div>
      <div className="usage-tooltip__row">
        <span>{copy.usageReasoning}</span>
        <span>{formatCompactTokens(day.reasoning, locale)}</span>
      </div>
      <div className="usage-tooltip__row usage-tooltip__cost">
        <span>{copy.usageCost}</span>
        <span>{costText}</span>
      </div>
    </div>
  )
}

// 1天视图:横向堆叠进度条(输入/缓存/输出分段着色),避免单柱图过于空旷
function UsageBar({ day, locale }: { day: TokenUsageDay; locale: LocaleCode }): React.JSX.Element {
  const copy = COPY[locale]
  const totalTokens = Math.max(1, day.input + day.output)
  const newInput = Math.max(0, day.input - day.cachedInput)
  const segments = [
    { key: 'input', label: copy.usageInput, value: newInput, cls: 'is-input' },
    { key: 'cached', label: copy.usageCached, value: day.cachedInput, cls: 'is-cached' },
    { key: 'output', label: copy.usageOutput, value: day.output, cls: 'is-output' }
  ].filter((s) => s.value > 0)
  return (
    <div className="usage-bar">
      <div className="usage-bar__track">
        {segments.map((s) => (
          <span
            className={`usage-bar__seg ${s.cls}`}
            key={s.key}
            style={{ width: `${(s.value / totalTokens) * 100}%` }}
            title={`${s.label} ${formatCompactTokens(s.value, locale)}`}
          />
        ))}
      </div>
      <div className="usage-bar__legend">
        {segments.map((s) => (
          <span className="usage-bar__legend-item" key={s.key}>
            <i className={`usage-bar__dot ${s.cls}`} />
            {s.label} {formatCompactTokens(s.value, locale)}
          </span>
        ))}
      </div>
    </div>
  )
}

function UsageSummaryItem({
  label,
  value,
  tone
}: {
  label: string
  value: string
  tone?: 'input' | 'output' | 'cached' | 'cost'
}): React.JSX.Element {
  return (
    <div className="usage-summary__item">
      <span className={`usage-summary__value${tone ? `--${tone}` : ''}`}>{value}</span>
      <span className="usage-summary__label">{label}</span>
    </div>
  )
}

// 窗口天数多时只标首/末与每 5 天,避免拥挤
function shouldShowDateLabel(count: number, index: number): boolean {
  if (count <= 7) {
    return true
  }
  return index % 5 === 0 || index === count - 1
}

function formatDayLabel(date: string): string {
  return date.slice(5)
}

// 紧凑数字:zh-CN 用 1.2万 / 3.4亿,其余用 1.2K / 3.4M / 1.1B
function formatCompactTokens(value: number, locale: LocaleCode): string {
  if (locale === 'zh-CN') {
    if (value >= 1e8) return `${trimTrailingZero((value / 1e8).toFixed(1))}亿`
    if (value >= 1e4) return `${trimTrailingZero((value / 1e4).toFixed(1))}万`
    return String(Math.round(value))
  }
  if (value >= 1e9) return `${trimTrailingZero((value / 1e9).toFixed(1))}B`
  if (value >= 1e6) return `${trimTrailingZero((value / 1e6).toFixed(1))}M`
  if (value >= 1e3) return `${trimTrailingZero((value / 1e3).toFixed(1))}K`
  return String(Math.round(value))
}

function trimTrailingZero(value: string): string {
  return value.endsWith('.0') ? value.slice(0, -2) : value
}

// 胶囊自适应字号:按文本宽度估算(CJK≈1em,数字/字母≈0.55em,符号≈0.3em),
// 长文本自动缩小,保证不超出给定最大宽度
function fitFontSize(text: string, basePx: number, maxWidth: number): number {
  let units = 0
  for (const ch of text) {
    if (/[一-鿿]/.test(ch)) units += 1
    else if (ch === '.' || ch === ',' || ch === '：' || ch === '·') units += 0.3
    else units += 0.55
  }
  if (units <= 0) {
    return basePx
  }
  const fitted = (maxWidth / units) * 0.95
  return Math.max(10, Math.min(basePx, Math.floor(fitted * 10) / 10))
}

// 缓存命中率 = cached_input / input(input 含缓存)
function formatCacheHit(input: number, cached: number): string {
  if (input <= 0) {
    return '--'
  }
  const rate = (cached / input) * 100
  return `${rate >= 99.95 ? rate.toFixed(0) : rate.toFixed(1)}%`
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) {
    return '--'
  }
  if (value <= 0) {
    return '$0'
  }
  if (value >= 100) {
    return `$${Math.round(value)}`
  }
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`
}

function DetailRow({
  badge,
  icon,
  iconTone,
  label,
  labelHref,
  value,
  hint,
  valueColor
}: {
  badge?: string
  icon: React.JSX.Element
  iconTone?: string
  label: string
  labelHref?: string
  value?: string
  hint?: string
  valueColor?: string
}): React.JSX.Element {
  return (
    <div className="detail-row">
      <div className="detail-row__label-group">
        <span
          className="detail-row__icon"
          style={iconTone ? ({ '--icon-tone': iconTone } as CSSProperties) : undefined}
        >
          {icon}
        </span>
        {labelHref ? (
          <a
            className="detail-row__link"
            href={labelHref}
            onClick={(event) => {
              event.preventDefault()
              void window.codexStatus.openExternal(labelHref)
            }}
            title={labelHref}
          >
            {label}
          </a>
        ) : (
          <span className="detail-row__label">{label}</span>
        )}
      </div>
      {value || badge || hint ? (
        <div className="detail-row__value-group">
          {value ? (
            <span className="detail-row__value" style={valueColor ? { color: valueColor } : undefined}>
              {value}
            </span>
          ) : null}
          {badge ? <span className="detail-row__badge">{badge}</span> : null}
          {hint ? <span className="detail-row__hint">{hint}</span> : null}
        </div>
      ) : null}
    </div>
  )
}

function SettingField({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="setting-field">
      <span className="setting-field__label">{label}</span>
      {children}
      {hint ? <span className="setting-field__hint">{hint}</span> : null}
    </div>
  )
}

// 团队排行榜一行:排名/昵称/剩余百分比横条+数字/重置卡数量;self 行高亮
function TeamRow({
  isSelf,
  rank,
  nickname,
  remainingPercent,
  shortWindow,
  longWindow,
  resetCreditCount
}: {
  isSelf: boolean
  rank: number
  nickname: string
  remainingPercent?: number
  shortWindow?: { label: string; remainingPercent?: number }
  longWindow?: { label: string; remainingPercent?: number }
  resetCreditCount?: number
}): React.JSX.Element {
  const percent =
    remainingPercent === undefined || !Number.isFinite(remainingPercent)
      ? undefined
      : Math.min(100, Math.max(0, remainingPercent))
  const accent = resolveMetricColor(percent, 'remaining')
  const rankClass = rank === 1 ? ' is-top-1' : rank === 2 ? ' is-top-2' : rank === 3 ? ' is-top-3' : ''
  const hasBoth = shortWindow !== undefined && longWindow !== undefined
  return (
    <div
      className={`team-row${isSelf ? ' is-self' : ''}${rankClass}${hasBoth ? ' team-row--dual' : ''}`}
      style={{ '--metric-accent': accent } as CSSProperties}
    >
      <span className="team-row__rank">{rank}</span>
      <span className="team-row__name">{nickname}</span>
      {hasBoth ? (
        <div className="team-row__windows">
          <WindowLine
            label={shortWindow.label}
            percent={shortWindow.remainingPercent}
          />
          <WindowLine
            label={longWindow.label}
            percent={longWindow.remainingPercent}
          />
        </div>
      ) : (
        <span className="team-row__bar">
          <span
            className="team-row__bar-fill"
            style={{ width: percent === undefined ? 0 : `${percent}%` }}
          />
        </span>
      )}
      <span className="team-row__value">
        {percent === undefined ? '--' : `${Math.round(percent)}%`}
      </span>
      <span className="team-row__credit">
        <TicketIcon />
        <span>{resetCreditCount ?? 0}</span>
      </span>
    </div>
  )
}

// Token 消耗排行榜一行:排名/昵称/按窗口最大值归一化的横条/紧凑 token 值;self 行高亮
function TokenRow({
  isSelf,
  rank,
  nickname,
  tokens,
  maxTokens,
  locale
}: {
  isSelf: boolean
  rank: number
  nickname: string
  tokens?: number
  maxTokens: number
  locale: LocaleCode
}): React.JSX.Element {
  const percent = tokens !== undefined ? Math.min(100, Math.max(0, (tokens / maxTokens) * 100)) : 0
  const rankClass =
    rank === 1 ? ' is-top-1' : rank === 2 ? ' is-top-2' : rank === 3 ? ' is-top-3' : ''
  return (
    <div className={`team-row team-row--token${isSelf ? ' is-self' : ''}${rankClass}`}>
      <span className="team-row__rank">{rank}</span>
      <span className="team-row__name">{nickname}</span>
      <span className="team-row__bar">
        <span className="team-row__bar-fill" style={{ width: `${percent}%` }} />
      </span>
      <span className="team-row__value">
        {tokens === undefined ? '--' : formatCompactTokens(tokens, locale)}
      </span>
    </div>
  )
}

function WindowLine({
  label,
  percent
}: {
  label: string
  percent?: number
}): React.JSX.Element {
  const safePercent =
    percent === undefined || !Number.isFinite(percent)
      ? undefined
      : Math.min(100, Math.max(0, percent))
  const accent = resolveMetricColor(safePercent, 'remaining')
  return (
    <span className="team-row__window" style={{ '--metric-accent': accent } as CSSProperties}>
      <span className="team-row__window-label">{label}</span>
      <span className="team-row__window-bar">
        <span
          className="team-row__window-bar-fill"
          style={{ width: safePercent === undefined ? 0 : `${safePercent}%` }}
        />
      </span>
      <span className="team-row__window-value">
        {safePercent === undefined ? '--' : `${Math.round(safePercent)}%`}
      </span>
    </span>
  )
}

function PanelTabs({
  current,
  labels,
  onChange
}: {
  current: PanelView
  labels: { details: string; team: string; settings: string }
  onChange: (view: PanelView) => void
}): React.JSX.Element {
  const tabs: Array<{ key: PanelView; label: string }> = [
    { key: 'details', label: labels.details },
    { key: 'team', label: labels.team },
    { key: 'settings', label: labels.settings }
  ]
  return (
    <div className="panel__tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          aria-selected={tab.key === current}
          className={`panel__tab${tab.key === current ? ' is-active' : ''}`}
          key={tab.key}
          onClick={() => onChange(tab.key)}
          role="tab"
          type="button"
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}

function SegmentedControl({
  value,
  options,
  onChange,
  disabled
}: {
  value: string
  options: Array<{ label: string; value: string }>
  onChange: (value: string) => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <div className={`segmented ${disabled ? 'is-disabled' : ''}`}>
      {options.map((option) => (
        <button
          className={option.value === value ? 'is-active' : ''}
          disabled={disabled}
          key={option.value}
          onClick={() => onChange(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

function ToggleSwitch({
  checked,
  onChange,
  onLabel,
  offLabel
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  onLabel: string
  offLabel: string
}): React.JSX.Element {
  return (
    <button
      aria-checked={checked}
      aria-label={checked ? onLabel : offLabel}
      className={`toggle-switch ${checked ? 'is-checked' : ''}`}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    >
      <span className="toggle-switch__track" aria-hidden="true">
        <span className="toggle-switch__thumb" />
      </span>
    </button>
  )
}

// 额度色:按 goodScore(remaining=显示值,used=100-显示值)从柔粉红(0%)到系统绿(100%)线性插值
// 100% 剩余→系统绿 #56d36c,0% 剩余→柔粉红 #f87171,中间渐变;无数据返回灰色
// 危险端用柔粉红替代高饱和橙红,与深青蓝冷调背景协调,不堆霓虹
function resolveMetricColor(
  displayPercent: number | undefined,
  percentageMode: PercentageMode
): string {
  if (displayPercent === undefined || !Number.isFinite(displayPercent)) {
    return 'rgba(158, 168, 179, 0.74)'
  }
  const goodScore = percentageMode === 'remaining' ? displayPercent : 100 - displayPercent
  const t = Math.min(100, Math.max(0, goodScore)) / 100
  // 柔粉红 (248,113,113) -> 系统绿 (86,211,108)
  const r = Math.round(248 + (86 - 248) * t)
  const g = Math.round(113 + (211 - 113) * t)
  const b = Math.round(113 + (108 - 113) * t)
  return `rgb(${r}, ${g}, ${b})`
}

// 推荐模型品牌色:按模型名关键词上色
// Sol=#eab308, Terra=#3b82f6, Luna=#c7d2e0, GPT-5.5=#00e5ff, 兜底灰蓝
function resolveModelColor(label: string | undefined): string {
  if (!label) {
    return 'rgba(197, 210, 224, 0.85)'
  }
  if (label.includes('Sol')) return '#eab308'
  if (label.includes('Terra')) return '#3b82f6'
  if (label.includes('Luna')) return '#c7d2e0'
  if (label.includes('GPT-5.5')) return '#00e5ff'
  return 'rgba(197, 210, 224, 0.85)'
}

function createMetricProgressStyle(
  displayPercent: number | undefined,
  percentageMode: PercentageMode
): CSSProperties {
  const progress =
    displayPercent === undefined || !Number.isFinite(displayPercent)
      ? 0
      : Math.min(100, Math.max(0, displayPercent))

  return {
    '--metric-progress': `${progress}%`,
    '--metric-accent': resolveMetricColor(displayPercent, percentageMode)
  } as CSSProperties
}

function formatAbsoluteDate(value: string | undefined, locale: LocaleCode): string {
  if (!value) {
    return '--'
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return '--'
  }

  const now = new Date()
  const sameYear = date.getFullYear() === now.getFullYear()
  const sameDay = isSameDay(date, now)

  if (locale === 'zh-CN') {
    const time = new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit'
    }).format(date)

    if (sameDay) {
      return `${COPY['zh-CN'].today} ${time}`
    }

    return sameYear
      ? `${date.getMonth() + 1}月${date.getDate()}日 ${time}`
      : `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${time}`
  }

  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit'
  }).format(date)

  if (sameDay) {
    return `${COPY['en-US'].today}, ${time}`
  }

  return sameYear
    ? `${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(date)}, ${time}`
    : `${new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric' }).format(date)}, ${time}`
}

function formatRelativeDuration(
  value: number | undefined,
  locale: LocaleCode,
  withSuffix = false
): string | undefined {
  if (value === undefined) {
    return undefined
  }

  const totalSeconds = Math.max(0, Math.floor(value))
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)

  if (locale === 'zh-CN') {
    const parts: string[] = []
    if (days > 0) {
      parts.push(`${days}天`)
    }
    if (hours > 0) {
      parts.push(`${hours}小时`)
    }
    if (minutes > 0 || parts.length === 0) {
      parts.push(`${minutes}分`)
    }
    return `${parts.slice(0, 2).join('')}${withSuffix ? '后' : ''}`
  }

  const parts: string[] = []
  if (days > 0) {
    parts.push(`${days}d`)
  }
  if (hours > 0) {
    parts.push(`${hours}h`)
  }
  if (minutes > 0 || parts.length === 0) {
    parts.push(`${minutes}m`)
  }
  return parts.slice(0, 2).join(' ')
}

function formatRelativeDate(value: string | undefined, locale: LocaleCode): string | undefined {
  if (!value) {
    return undefined
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return undefined
  }

  const diffSeconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000))
  if (diffSeconds < 60) {
    return locale === 'zh-CN' ? '刚刚' : 'just now'
  }

  const diffMinutes = Math.floor(diffSeconds / 60)
  if (diffMinutes < 60) {
    return locale === 'zh-CN' ? `${diffMinutes}分钟前` : `${diffMinutes}m ago`
  }

  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) {
    return locale === 'zh-CN' ? `${diffHours}小时前` : `${diffHours}h ago`
  }

  const diffDays = Math.floor(diffHours / 24)
  return locale === 'zh-CN' ? `${diffDays}天前` : `${diffDays}d ago`
}

function formatCapsuleResetTime(value: string | undefined, locale: LocaleCode): string {
  if (!value) {
    return '--'
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return '--'
  }

  const now = new Date()
  const time = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)

  if (isSameDay(date, now)) {
    return time
  }

  const monthDay = new Intl.DateTimeFormat(locale, {
    month: 'numeric',
    day: 'numeric'
  }).format(date)
  return `${monthDay} ${time}`
}

function formatCountdownShort(value: string, locale: LocaleCode): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return '--'
  }
  const diffMs = date.getTime() - Date.now()
  if (diffMs <= 0) {
    return '0m'
  }
  const totalMinutes = Math.max(1, Math.ceil(diffMs / 60000))
  const days = Math.floor(totalMinutes / 1440)
  if (days >= 1) {
    return locale === 'zh-CN' ? `${days}天` : `${days}d`
  }
  const hours = Math.floor(totalMinutes / 60)
  if (hours >= 1) {
    return locale === 'zh-CN' ? `${hours}时` : `${hours}h`
  }
  return locale === 'zh-CN' ? `${totalMinutes}分` : `${totalMinutes}m`
}

// 胶囊周重置倒计时:单单位大写 D/H/M/S,秒级(有天显天,0天显时,0时显分,0分显秒)
// 与重置卡(formatCountdownShort,中文)区分;胶囊里统一用英文单位更紧凑
function formatCountdownCapsule(value: string | undefined, nowMs: number): string {
  if (!value) {
    return '--'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return '--'
  }
  const diffMs = date.getTime() - nowMs
  if (diffMs <= 0) {
    return '0S'
  }
  const totalSeconds = Math.floor(diffMs / 1000)
  const days = Math.floor(totalSeconds / 86400)
  if (days >= 1) {
    return `${days}D`
  }
  const hours = Math.floor(totalSeconds / 3600)
  if (hours >= 1) {
    return `${hours}H`
  }
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes >= 1) {
    return `${minutes}M`
  }
  return `${totalSeconds}S`
}

function formatModelPick(shortLabel: string): string {
  // shortLabel 形如 "Terra xhigh" -> "Terra Xh", "Sol medium" -> "Sol M", "Luna max" -> "Luna U"
  const parts = shortLabel.split(/\s+/)
  if (parts.length < 2) return shortLabel
  const name = parts[0]
  const effort = parts.slice(1).join(' ').toLowerCase()
  const effortAbbr: Record<string, string> = {
    ultra: 'U',
    max: 'Mx',
    xhigh: 'Xh',
    high: 'H',
    medium: 'M',
    low: 'L'
  }
  const abbr = effortAbbr[effort] ?? effort.charAt(0).toUpperCase()
  return `${name} ${abbr}`
}

function normalizeCustomRefreshInterval(value: number): number {
  return Math.min(
    MAX_REFRESH_INTERVAL_SECONDS,
    Math.max(MIN_REFRESH_INTERVAL_SECONDS, Math.round(value))
  )
}

function isFixedRefreshInterval(value: number): boolean {
  return REFRESH_INTERVAL_OPTIONS.some((option) => option === value)
}

function isSameDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  )
}

function CloseIcon(): React.JSX.Element {
  return (
    <svg fill="none" viewBox="0 0 24 24">
      <path
        d="m7 7 10 10M17 7 7 17"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.85"
      />
    </svg>
  )
}

function HourglassIcon(): React.JSX.Element {
  return (
    <svg fill="none" viewBox="0 0 24 24">
      <path
        d="M7 3.75h10M7 20.25h10M7.5 3.75v3.2c0 1.5.9 2.8 2.3 3.3l3.9 1.4c1.4.5 2.3 1.8 2.3 3.3v3.2M16.5 3.75v3.2c0 1.5-.9 2.8-2.3 3.3l-3.9 1.4c-1.4.5-2.3 1.8-2.3 3.3v3.2"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.75"
      />
    </svg>
  )
}

function RefreshIcon(): React.JSX.Element {
  return (
    <svg fill="none" viewBox="0 0 24 24">
      <path
        d="M20 11a8 8 0 1 0-1.5 5M20 5v6h-6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.75"
      />
    </svg>
  )
}

// 额度特赦重置:环形单向箭头(区别于 RefreshIcon 双向箭头),表达"周期/恢复"语义
function ResetIcon(): React.JSX.Element {
  return (
    <svg fill="none" viewBox="0 0 24 24">
      <path
        d="M5.6 7A8 8 0 1 1 4 12.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.75"
      />
      <path
        d="M5 4v4h4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.75"
      />
    </svg>
  )
}

function TicketIcon(): React.JSX.Element {
  return (
    <svg fill="none" viewBox="0 0 24 24">
      <path
        d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1.5a1.5 1.5 0 0 0 0 3V16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3.5a1.5 1.5 0 0 0 0-3z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
      <path
        d="M9 8v8"
        stroke="currentColor"
        strokeDasharray="1.5 2"
        strokeLinecap="round"
        strokeWidth="1.4"
      />
    </svg>
  )
}

function SparkleIcon(): React.JSX.Element {
  return (
    <svg fill="none" viewBox="0 0 24 24">
      <path
        d="M12 3l1.8 4.8L18.6 9.6l-4.8 1.8L12 16.2l-1.8-4.8L5.4 9.6l4.8-1.8z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
      <path
        d="M19 15l.7 1.8L21.5 17.5l-1.8.7L19 20l-.7-1.8L16.5 17.5l1.8-.7z"
        fill="currentColor"
      />
    </svg>
  )
}

export default App
