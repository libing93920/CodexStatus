import { useEffect, useRef, useState, type CSSProperties } from 'react'
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
  type LocaleCode,
  type PanelView,
  type PercentageMode,
  type RateLimitWindowSnapshot,
  type RendererWindowRole,
  type UsageSnapshot,
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
    auto: '自动',
    manual: '手动',
    enabled: '开启',
    disabled: '关闭',
    remaining: '未使用',
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
    iqThresholdHint: '低于此分数的模型不进入推荐'
  },
  'en-US': {
    noData: 'No data',
    refresh: 'Refresh',
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
    iqThresholdHint: 'Models below this score are excluded from picks'
  }
} as const

function App(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<UsageSnapshot>(() => createEmptySnapshot())
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
  const [capsulePointerActive, setCapsulePointerActive] = useState(false)
  const [manualRefreshActive, setManualRefreshActive] = useState(false)
  const [ready, setReady] = useState(false)
  // 详情面板里长窗口(周重置)倒计时需要秒级刷新;只在面板可见且有长窗口时 tick
  const [nowTick, setNowTick] = useState(() => Date.now())
  const capsulePointerRef = useRef<CapsulePointerState | null>(null)
  const manualRefreshTimerRef = useRef<number | undefined>(undefined)

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
    })

    const disposeCommand = window.codexStatus.onCommand((payload) => {
      if (payload.type !== 'show-panel-view') {
        return
      }

      setPanelView(payload.panelView)
    })

    return () => {
      active = false
      if (manualRefreshTimerRef.current !== undefined) {
        window.clearTimeout(manualRefreshTimerRef.current)
      }
      disposeSnapshot()
      disposePreferences()
      disposeCommand()
    }
  }, [])

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
  const sourceLabel =
    snapshot.rateLimitSource === 'official'
      ? copy.officialSource
      : snapshot.rateLimitSource === 'local'
        ? copy.localSource
        : copy.emptySource
  const sourceValue = snapshot.rateLimitSource === 'none' ? copy.noData : snapshot.sourceHost
  // 官方不可用(退回本地)时,来源处直接以红色"不可用"badge 提示,不再单独渲染横幅
  const officialDown = snapshot.rateLimitSource === 'local' && Boolean(snapshot.officialIssue)
  const sourceBadgeText = officialDown ? copy.officialUnavailable : sourceLabel
  const sourceBadgeClassName = officialDown
    ? 'panel__meta-badge panel__meta-badge--danger'
    : 'panel__meta-badge'
  const eyebrowText = officialDown ? copy.officialUnavailable : sourceLabel
  const eyebrowClassName = officialDown ? 'panel__eyebrow panel__eyebrow--danger' : 'panel__eyebrow'
  const rateLimitWindows = snapshot.rateLimits
  // 短窗口(<1天)用于胶囊/大卡片展示;长窗口(≥1天,如 7d)只在明细行显示重置倒计时,不显示百分比
  const cardWindows = rateLimitWindows.filter(
    (windowState) => windowState.windowMinutes === undefined || windowState.windowMinutes < 1440
  )
  const longWindows = rateLimitWindows.filter(
    (windowState) => windowState.windowMinutes !== undefined && windowState.windowMinutes >= 1440
  )
  const cardWindowCount = cardWindows.length
  // 胶囊固定分区布局:百分比+进度条取第一个短窗口;周重置倒计时取第一个长窗口
  const displayedRateLimit = cardWindows[0] ?? rateLimitWindows[0]
  const capsuleDisplayPercent =
    settings.percentageMode === 'used'
      ? displayedRateLimit?.usedPercent
      : displayedRateLimit?.remainingPercent
  const capsulePercentText =
    capsuleDisplayPercent === undefined ? '--' : `${Math.round(capsuleDisplayPercent)}%`
  const capsuleProgressStyle = createMetricProgressStyle(
    capsuleDisplayPercent,
    settings.percentageMode
  )
  const capsuleWeeklyResetsAt = longWindows[0]?.resetsAt
  const capsuleWeeklyText = formatCountdownCapsule(capsuleWeeklyResetsAt, nowTick)
  const capsuleCreditText = snapshot.resetCredit?.expiresAt
    ? formatCountdownShort(snapshot.resetCredit.expiresAt, settings.locale)
    : ''
  const capsulePickText = snapshot.bestModelPick
    ? formatModelPick(snapshot.bestModelPick.shortLabel)
    : ''
  const capsulePickColor = resolveModelColor(snapshot.bestModelPick?.label)
  const capsulePickTitle = snapshot.bestModelPick
    ? `${snapshot.bestModelPick.label} · IQ ${snapshot.bestModelPick.score.toFixed(1)} · $${snapshot.bestModelPick.averageCostUsd.toFixed(2)}/题 · ${snapshot.bestModelPick.averageTaskMinutes}分/题`
    : ''
  const capsuleViewMode = windowPreferences.viewMode
  const capsuleClassName = [
    'capsule',
    `capsule--${capsuleViewMode}`,
    snapshot.isRefreshing ? 'is-refreshing' : '',
    manualRefreshActive ? 'is-manual-refreshing' : '',
    canRefresh ? '' : 'is-static',
    capsulePointerActive ? 'is-dragging' : ''
  ]
    .filter(Boolean)
    .join(' ')

  const detailRows: Array<React.ComponentProps<typeof DetailRow>> = [
    ...longWindows.map((windowState) => ({
      icon: <HourglassIcon />,
      label: settings.locale === 'zh-CN' ? '周重置' : 'Weekly reset',
      value: formatCountdownSingleUnit(windowState.resetsAt, settings.locale, nowTick),
      hint: formatAbsoluteDate(windowState.resetsAt, settings.locale)
    })),
    ...(snapshot.resetCredit?.expiresAt
      ? [
          {
            icon: <TicketIcon />,
            label: copy.resetCredit,
            value: formatCountdownShort(snapshot.resetCredit.expiresAt, settings.locale),
            hint: formatAbsoluteDate(snapshot.resetCredit.expiresAt, settings.locale)
          }
        ]
      : []),
    ...(snapshot.bestModelPick
      ? [
          {
            icon: <SparkleIcon />,
            label: settings.locale === 'zh-CN' ? '雷达推荐模型' : 'Top model',
            value: formatModelPick(snapshot.bestModelPick.shortLabel),
            valueColor: resolveModelColor(snapshot.bestModelPick.label),
            hint:
              settings.locale === 'zh-CN'
                ? `IQ ${snapshot.bestModelPick.score.toFixed(1)} · $${snapshot.bestModelPick.averageCostUsd.toFixed(2)}/题 · ${snapshot.bestModelPick.averageTaskMinutes}分/题`
                : `IQ ${snapshot.bestModelPick.score.toFixed(1)} · $${snapshot.bestModelPick.averageCostUsd.toFixed(2)}/task · ${snapshot.bestModelPick.averageTaskMinutes}m/task`
          }
        ]
      : [])
  ]

  // 周重置倒计时显示到秒级:详情面板有长窗口时每秒 tick 一次驱动重渲染
  const hasLongWindow = longWindows.length > 0
  // 周重置倒计时显示到秒级:详情面板有长窗口时每秒 tick;胶囊常驻有长窗口时也 tick 驱动倒计时
  useEffect(() => {
    const isPanelWithLongWindow = windowRole === 'panel' && panelView === 'details' && hasLongWindow
    const isCapsuleWithLongWindow = windowRole === 'capsule' && hasLongWindow
    if (!isPanelWithLongWindow && !isCapsuleWithLongWindow) {
      return
    }

    const timer = window.setInterval(() => {
      setNowTick(Date.now())
    }, 1000)
    return () => {
      window.clearInterval(timer)
    }
  }, [windowRole, panelView, hasLongWindow])

  function openDetails(): void {
    setPanelView('details')
  }

  function openSettings(): void {
    setPanelView('settings')
  }

  function closePanel(): void {
    setPanelView('details')
    void window.codexStatus.closePanel()
  }

  async function handleRefresh(): Promise<void> {
    if (!canRefresh) {
      return
    }

    showManualRefreshFeedback()

    try {
      const nextSnapshot = await window.codexStatus.refreshStatus()
      setSnapshot(nextSnapshot)
    } catch (error) {
      recordSnapshotIssue(error)
    }
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

    if (shouldRefreshOnClick && canRefresh) {
      void handleRefresh()
    }
  }

  function handleCapsuleKeyDown(event: React.KeyboardEvent<HTMLElement>): void {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return
    }

    if (!canRefresh) {
      return
    }

    event.preventDefault()
    void handleRefresh()
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
            aria-label={canRefresh ? copy.refresh : sourceValue}
            className={capsuleClassName}
            style={capsuleProgressStyle}
            onKeyDown={handleCapsuleKeyDown}
            onPointerCancel={handleCapsulePointerCancel}
            onPointerDown={handleCapsulePointerDown}
            onPointerMove={handleCapsulePointerMove}
            onPointerUp={handleCapsulePointerUp}
            role={canRefresh ? 'button' : undefined}
            tabIndex={canRefresh ? 0 : -1}
          >
            {capsuleViewMode === 'orb' ? (
              <div className="capsule__layout capsule__layout--v" aria-hidden="true">
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
                <div className="capsule__weekly">
                  <HourglassIcon />
                  <span>{capsuleWeeklyText}</span>
                </div>
                <div className="capsule__metric-box">
                  <div className="capsule__percent">{capsulePercentText}</div>
                  <span className="capsule__progress" aria-hidden="true">
                    <span />
                  </span>
                </div>
              </div>
            ) : (
              <div className="capsule__layout capsule__layout--h" aria-hidden="true">
                <div className="capsule__col capsule__col--weekly">
                  <span className="capsule__weekly">
                    <HourglassIcon />
                    {capsuleWeeklyText}
                  </span>
                </div>
                <div className="capsule__col capsule__col--metric">
                  <div className="capsule__metric-box">
                    <div className="capsule__percent">{capsulePercentText}</div>
                    <span className="capsule__progress" aria-hidden="true">
                      <span />
                    </span>
                  </div>
                </div>
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
        <div aria-hidden="true" className="panel__grabber">
          <span />
        </div>
        {panelView === 'details' ? (
          <div className="panel__body panel__body--details">
            <div className="panel__content">
              <div className="panel__header panel__header--details">
                <div>
                  <p className={eyebrowClassName}>{eyebrowText}</p>
                  <h2 className="panel__title">{copy.details}</h2>
                </div>
              </div>

              {cardWindows.length > 0 ? (
                <div className={`quota-grid${cardWindowCount === 1 ? ' quota-grid--single' : ''}`}>
                  {cardWindows.map((windowState) => (
                    <QuotaCard
                      key={windowState.id}
                      locale={settings.locale}
                      modeLabel={settings.percentageMode === 'used' ? copy.used : copy.remaining}
                      percentageMode={settings.percentageMode}
                      resetExpiryLabel={copy.resetExpiry}
                      windowState={windowState}
                    />
                  ))}
                </div>
              ) : null}

              <div className="panel__rows">
                {detailRows.map((row) => (
                  <DetailRow
                    key={row.label}
                    badge={row.badge}
                    hint={row.hint}
                    icon={row.icon}
                    label={row.label}
                    value={row.value}
                    valueColor={row.valueColor}
                  />
                ))}
              </div>

              <div className="panel__meta">
                <span className="panel__meta-row">
                  <ServerIcon />
                  <span className="panel__meta-value-group">
                    <span className="panel__meta-main">{sourceValue}</span>
                    <span className={sourceBadgeClassName}>{sourceBadgeText}</span>
                  </span>
                </span>
                <span className="panel__meta-row">
                  <HistoryIcon />
                  <span className="panel__meta-value-group">
                    <span className="panel__meta-main">
                      {formatAbsoluteDate(snapshot.generatedAt, settings.locale)}
                    </span>
                    <span className="panel__meta-hint">
                      {copy.lastRefreshHint} ·{' '}
                      {formatRelativeDate(snapshot.generatedAt, settings.locale)}
                    </span>
                  </span>
                </span>
              </div>
            </div>

            <div className="panel__footer">
              <button className="ghost-button" onClick={openSettings} type="button">
                <SettingsIcon />
                <span>{copy.settings}</span>
              </button>
              <button className="ghost-button" onClick={closePanel} type="button">
                <CloseIcon />
                <span>{copy.close}</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="panel__body panel__body--settings">
            <div className="panel__content">
              <div className="panel__header">
                <div>
                  <p className="panel__eyebrow">CODEX</p>
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
              </div>
            </div>

            <div className="panel__footer">
              <button className="ghost-button" onClick={openDetails} type="button">
                <ChevronLeftIcon />
                <span>{copy.back}</span>
              </button>
              <button
                className="ghost-button ghost-button--accent"
                onClick={closePanel}
                type="button"
              >
                <span>{copy.done}</span>
                <ChevronRightIcon />
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

function QuotaCard({
  locale,
  modeLabel,
  percentageMode,
  windowState,
  resetExpiryLabel
}: {
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
    <div className="quota-card" style={progressStyle}>
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

function DetailRow({
  badge,
  icon,
  label,
  value,
  hint,
  valueColor
}: {
  badge?: string
  icon: React.JSX.Element
  label: string
  value: string
  hint?: string
  valueColor?: string
}): React.JSX.Element {
  return (
    <div className="detail-row">
      <div className="detail-row__label-group">
        <span className="detail-row__icon">{icon}</span>
        <span className="detail-row__label">{label}</span>
      </div>
      <div className="detail-row__value-group">
        <span className="detail-row__value" style={valueColor ? { color: valueColor } : undefined}>
          {value}
        </span>
        {badge ? <span className="detail-row__badge">{badge}</span> : null}
        {hint ? <span className="detail-row__hint">{hint}</span> : null}
      </div>
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

// 额度色:按 goodScore(remaining=显示值,used=100-显示值)从红(0%)到绿(100%)线性插值
// 100% 剩余→纯绿,0% 剩余→纯红,中间渐变;无数据返回灰色
function resolveMetricColor(
  displayPercent: number | undefined,
  percentageMode: PercentageMode
): string {
  if (displayPercent === undefined || !Number.isFinite(displayPercent)) {
    return 'rgba(158, 168, 179, 0.74)'
  }
  const goodScore = percentageMode === 'remaining' ? displayPercent : 100 - displayPercent
  const t = Math.min(100, Math.max(0, goodScore)) / 100
  // 红 (239,87,82) -> 绿 (80,214,124)
  const r = Math.round(239 + (80 - 239) * t)
  const g = Math.round(87 + (214 - 87) * t)
  const b = Math.round(82 + (124 - 82) * t)
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

// 周重置倒计时:只取最高非零单位(d/h/m/s),秒级实时刷新
// 有天显天,0天显时,0时显分,0分显秒,始终只显示一个单位
function formatCountdownSingleUnit(
  value: string | undefined,
  locale: LocaleCode,
  nowMs: number
): string {
  if (!value) {
    return '--'
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return '--'
  }

  const diffMs = date.getTime() - nowMs
  if (diffMs <= 0) {
    return locale === 'zh-CN' ? '0秒' : '0s'
  }

  const totalSeconds = Math.floor(diffMs / 1000)
  const days = Math.floor(totalSeconds / 86400)
  if (days >= 1) {
    return locale === 'zh-CN' ? `${days}天` : `${days}d`
  }
  const hours = Math.floor(totalSeconds / 3600)
  if (hours >= 1) {
    return locale === 'zh-CN' ? `${hours}时` : `${hours}h`
  }
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes >= 1) {
    return locale === 'zh-CN' ? `${minutes}分` : `${minutes}m`
  }
  return locale === 'zh-CN' ? `${totalSeconds}秒` : `${totalSeconds}s`
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

function ServerIcon(): React.JSX.Element {
  return (
    <svg fill="none" viewBox="0 0 24 24">
      <rect height="5" rx="1.5" stroke="currentColor" strokeWidth="1.75" width="16" x="4" y="5" />
      <rect height="5" rx="1.5" stroke="currentColor" strokeWidth="1.75" width="16" x="4" y="14" />
      <path
        d="M8 7.5h.01M8 16.5h.01M12 7.5h6M12 16.5h6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.75"
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

function HistoryIcon(): React.JSX.Element {
  return (
    <svg fill="none" viewBox="0 0 24 24">
      <path
        d="M4.5 12A7.5 7.5 0 1 0 7 6.42M4.5 4.5v4h4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.75"
      />
      <path
        d="M12 8.25V12l2.75 1.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.75"
      />
    </svg>
  )
}

function SettingsIcon(): React.JSX.Element {
  return (
    <svg fill="none" viewBox="0 0 24 24">
      <path
        d="M10 4h10M4 12h16M14 20h6M14 4a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM9 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM14 20a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.75"
      />
    </svg>
  )
}

function ChevronLeftIcon(): React.JSX.Element {
  return (
    <svg fill="none" viewBox="0 0 24 24">
      <path
        d="m14 6-6 6 6 6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.75"
      />
    </svg>
  )
}

function ChevronRightIcon(): React.JSX.Element {
  return (
    <svg fill="none" viewBox="0 0 24 24">
      <path
        d="m9 5 7 7-7 7"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.85"
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
