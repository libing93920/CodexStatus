import { useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  DEFAULT_SETTINGS,
  DEFAULT_WINDOW_PREFERENCES,
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
    fallbackTitle: '当前使用回退数据',
    fallbackBody: '官方额度接口暂不可用，当前展示最近一次本地会话中的额度状态。',
    unavailableTitle: '暂无可用额度数据',
    unavailableBody: '官方接口和本地 sessions 都没有提供可用窗口。',
    scannedFiles: '已扫描',
    filesUnit: '个 jsonl',
    path: 'sessions 路径',
    today: '今天',
    yesterday: '昨天'
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
    fallbackTitle: 'Using fallback data',
    fallbackBody: 'Live quota lookup is unavailable. Showing the latest usable local status.',
    unavailableTitle: 'Quota data unavailable',
    unavailableBody: 'Neither the official endpoint nor local sessions returned a usable window.',
    scannedFiles: 'Scanned',
    filesUnit: 'jsonl files',
    path: 'Sessions path',
    today: 'Today',
    yesterday: 'Yesterday'
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
  const [capsulePointerActive, setCapsulePointerActive] = useState(false)
  const [manualRefreshActive, setManualRefreshActive] = useState(false)
  const [ready, setReady] = useState(false)
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
  const fallbackBanner =
    snapshot.rateLimitSource === 'local' && snapshot.officialIssue
      ? {
          title: copy.fallbackTitle,
          body: copy.fallbackBody
        }
      : snapshot.rateLimitSource === 'none' && snapshot.issues.length > 0
        ? {
            title: copy.unavailableTitle,
            body: copy.unavailableBody
          }
        : undefined
  const rateLimitWindows = snapshot.rateLimits
  const rateLimitCount = rateLimitWindows.length
  const displayedRateLimit = rateLimitWindows[0]
  const capsuleDisplayPercent =
    settings.percentageMode === 'used'
      ? displayedRateLimit?.usedPercent
      : displayedRateLimit?.remainingPercent
  const capsuleTone = resolveMetricTone(capsuleDisplayPercent, settings.percentageMode)
  const capsuleViewMode = windowPreferences.viewMode
  const capsuleClassName = [
    'capsule',
    `capsule--${capsuleViewMode}`,
    `capsule--${capsuleTone}`,
    snapshot.isRefreshing ? 'is-refreshing' : '',
    manualRefreshActive ? 'is-manual-refreshing' : '',
    canRefresh ? '' : 'is-static',
    capsulePointerActive ? 'is-dragging' : ''
  ]
    .filter(Boolean)
    .join(' ')

  const detailRows: Array<React.ComponentProps<typeof DetailRow>> = [
    {
      icon: <ServerIcon />,
      label: copy.source,
      value: sourceValue,
      badge: snapshot.rateLimitSource === 'none' ? undefined : sourceLabel
    },
    ...rateLimitWindows.map((windowState) => ({
      icon:
        windowState.windowMinutes !== undefined && windowState.windowMinutes < 1440 ? (
          <ClockIcon />
        ) : (
          <CalendarIcon />
        ),
      label: `${windowState.label} ${copy.reset}`,
      value: formatAbsoluteDate(windowState.resetsAt, settings.locale)
    })),
    {
      icon: <HistoryIcon />,
      label: copy.lastRefresh,
      value: formatAbsoluteDate(snapshot.generatedAt, settings.locale),
      hint: formatRelativeDate(snapshot.generatedAt, settings.locale)
    }
  ]

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
            onKeyDown={handleCapsuleKeyDown}
            onPointerCancel={handleCapsulePointerCancel}
            onPointerDown={handleCapsulePointerDown}
            onPointerMove={handleCapsulePointerMove}
            onPointerUp={handleCapsulePointerUp}
            role={canRefresh ? 'button' : undefined}
            tabIndex={canRefresh ? 0 : -1}
          >
            {capsuleViewMode === 'orb' ? (
              <div
                className={`capsule__edge-metrics${rateLimitCount === 1 ? ' capsule__edge-metrics--single' : ''}`}
                style={
                  rateLimitCount > 2
                    ? { gridTemplateRows: `repeat(${rateLimitCount}, minmax(0, 1fr))` }
                    : undefined
                }
                aria-hidden="true"
              >
                {rateLimitWindows.map((windowState) => (
                  <EdgeMetricSegment
                    key={windowState.id}
                    locale={settings.locale}
                    percentageMode={settings.percentageMode}
                    windowState={windowState}
                  />
                ))}
              </div>
            ) : (
              <div className="capsule__summary" aria-hidden="true">
                <div
                  className={`capsule__metrics${rateLimitCount === 1 ? ' capsule__metrics--single' : ''}`}
                  style={
                    rateLimitCount > 2
                      ? { gridTemplateColumns: `repeat(${rateLimitCount}, minmax(0, 1fr))` }
                      : undefined
                  }
                >
                  {rateLimitWindows.map((windowState) => (
                    <MetricSegment
                      key={windowState.id}
                      locale={settings.locale}
                      percentageMode={settings.percentageMode}
                      windowState={windowState}
                    />
                  ))}
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
                  <p className="panel__eyebrow">{sourceLabel}</p>
                  <h2 className="panel__title">{copy.details}</h2>
                </div>
              </div>

              <div className={`quota-grid${rateLimitCount === 1 ? ' quota-grid--single' : ''}`}>
                {rateLimitWindows.map((windowState) => (
                  <QuotaCard
                    key={windowState.id}
                    locale={settings.locale}
                    modeLabel={settings.percentageMode === 'used' ? copy.used : copy.remaining}
                    percentageMode={settings.percentageMode}
                    windowState={windowState}
                  />
                ))}
              </div>

              <div className="panel__rows">
                {detailRows.map((row) => (
                  <DetailRow
                    key={row.label}
                    badge={row.badge}
                    hint={row.hint}
                    icon={row.icon}
                    label={row.label}
                    value={row.value}
                  />
                ))}
              </div>

              {fallbackBanner ? (
                <div className="fallback-card">
                  <div className="fallback-card__icon">
                    <AlertIcon />
                  </div>
                  <div className="fallback-card__content">
                    <p className="fallback-card__title">{fallbackBanner.title}</p>
                    <p className="fallback-card__body">{fallbackBanner.body}</p>
                  </div>
                </div>
              ) : null}

              <div className="panel__meta">
                <span className="panel__meta-row">
                  <FileIcon />
                  <span>
                    {copy.scannedFiles} {snapshot.filesScanned} {copy.filesUnit}
                  </span>
                </span>
                {snapshot.sessionsPath ? (
                  <span className="panel__meta-row panel__meta-row--path">
                    <FolderIcon />
                    <span>
                      {copy.path}: {snapshot.sessionsPath}
                    </span>
                  </span>
                ) : null}
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

function MetricSegment({
  locale,
  percentageMode,
  windowState
}: {
  locale: LocaleCode
  percentageMode: PercentageMode
  windowState: RateLimitWindowSnapshot
}): React.JSX.Element {
  const displayPercent =
    percentageMode === 'used' ? windowState?.usedPercent : windowState?.remainingPercent
  const tone = resolveMetricTone(displayPercent, percentageMode)
  const resetText = formatCapsuleResetTime(windowState?.resetsAt, locale)
  const progressStyle = createMetricProgressStyle(displayPercent)

  return (
    <div className={`metric-segment metric-segment--${tone}`} style={progressStyle}>
      <span className="metric-segment__label">
        <span className="metric-segment__name">{windowState.label}</span>
        <span className="metric-segment__reset">{resetText}</span>
      </span>
      <div className="metric-segment__value">
        <span>{displayPercent === undefined ? '--' : `${Math.round(displayPercent)}%`}</span>
      </div>
      <span className="metric-segment__progress" aria-hidden="true">
        <span />
      </span>
    </div>
  )
}

function EdgeMetricSegment({
  locale,
  percentageMode,
  windowState
}: {
  locale: LocaleCode
  percentageMode: PercentageMode
  windowState: RateLimitWindowSnapshot
}): React.JSX.Element {
  const displayPercent =
    percentageMode === 'used' ? windowState?.usedPercent : windowState?.remainingPercent
  const tone = resolveMetricTone(displayPercent, percentageMode)
  const resetText = formatCapsuleResetTime(windowState?.resetsAt, locale)
  const progressStyle = createMetricProgressStyle(displayPercent)

  return (
    <div className={`edge-metric edge-metric--${tone}`} style={progressStyle}>
      <span className="edge-metric__label">{windowState.label}</span>
      <span className="edge-metric__reset">{resetText}</span>
      <span className="edge-metric__value">
        {displayPercent === undefined ? '--' : `${Math.round(displayPercent)}%`}
      </span>
      <span className="edge-metric__progress" aria-hidden="true">
        <span />
      </span>
    </div>
  )
}

function QuotaCard({
  locale,
  modeLabel,
  percentageMode,
  windowState
}: {
  locale: LocaleCode
  modeLabel: string
  percentageMode: PercentageMode
  windowState: RateLimitWindowSnapshot
}): React.JSX.Element {
  const displayPercent =
    percentageMode === 'used' ? windowState?.usedPercent : windowState?.remainingPercent
  const tone = resolveMetricTone(displayPercent, percentageMode)
  const progressStyle = createMetricProgressStyle(displayPercent)

  return (
    <div className={`quota-card quota-card--${tone}`} style={progressStyle}>
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
  hint
}: {
  badge?: string
  icon: React.JSX.Element
  label: string
  value: string
  hint?: string
}): React.JSX.Element {
  return (
    <div className="detail-row">
      <div className="detail-row__label-group">
        <span className="detail-row__icon">{icon}</span>
        <span className="detail-row__label">{label}</span>
      </div>
      <div className="detail-row__value-group">
        <span className="detail-row__value">{value}</span>
        {badge ? <span className="detail-row__badge">{badge}</span> : null}
        {hint ? <span className="detail-row__hint">{hint}</span> : null}
      </div>
    </div>
  )
}

function SettingField({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="setting-field">
      <span className="setting-field__label">{label}</span>
      {children}
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

function createMetricProgressStyle(displayPercent: number | undefined): CSSProperties {
  const progress =
    displayPercent === undefined || !Number.isFinite(displayPercent)
      ? 0
      : Math.min(100, Math.max(0, displayPercent))

  return { '--metric-progress': `${progress}%` } as CSSProperties
}

function resolveMetricTone(
  displayPercent: number | undefined,
  percentageMode: PercentageMode
): 'positive' | 'warning' | 'danger' | 'muted' {
  if (displayPercent === undefined) {
    return 'muted'
  }

  const goodScore = percentageMode === 'remaining' ? displayPercent : 100 - displayPercent
  if (goodScore >= 65) {
    return 'positive'
  }
  if (goodScore >= 35) {
    return 'warning'
  }
  return 'danger'
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

function ClockIcon(): React.JSX.Element {
  return (
    <svg fill="none" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="8.25" stroke="currentColor" strokeWidth="1.75" />
      <path
        d="M12 7.5v5l3 2"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.75"
      />
    </svg>
  )
}

function CalendarIcon(): React.JSX.Element {
  return (
    <svg fill="none" viewBox="0 0 24 24">
      <rect height="14" rx="2" stroke="currentColor" strokeWidth="1.75" width="16" x="4" y="6" />
      <path
        d="M8 3.75v4.5M16 3.75v4.5M4 10.5h16"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.75"
      />
    </svg>
  )
}

function FileIcon(): React.JSX.Element {
  return (
    <svg fill="none" viewBox="0 0 24 24">
      <path
        d="M7 3.75h6.2L17 7.55V20.25H7z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.75"
      />
      <path
        d="M13 3.75V8h4M9.25 12.25h5.5M9.25 15.75h5.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.75"
      />
    </svg>
  )
}

function FolderIcon(): React.JSX.Element {
  return (
    <svg fill="none" viewBox="0 0 24 24">
      <path
        d="M3.75 8.25a2 2 0 0 1 2-2h4.05l2 2h6.45a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H5.75a2 2 0 0 1-2-2z"
        stroke="currentColor"
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

function AlertIcon(): React.JSX.Element {
  return (
    <svg fill="none" viewBox="0 0 24 24">
      <path
        d="M11.13 4.64 4.37 17.5A1 1 0 0 0 5.25 19h13.5a1 1 0 0 0 .88-1.5L12.87 4.64a1 1 0 0 0-1.74 0Z"
        fill="currentColor"
        opacity="0.12"
      />
      <path
        d="M12 9v4.5M12 16.75h.01M11.13 4.64 4.37 17.5A1 1 0 0 0 5.25 19h13.5a1 1 0 0 0 .88-1.5L12.87 4.64a1 1 0 0 0-1.74 0Z"
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

export default App
