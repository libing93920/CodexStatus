import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type React from 'react'
import type {
  AuthMode,
  LocaleCode,
  ModelUsage,
  PercentageMode,
  RateLimitWindowSnapshot,
  SpendUsage,
  TokenUsageDay,
  TokenUsageOverview,
  UsageWindow,
  WindowKeeperState,
  WindowKeeperStatus
} from '../../../shared/capsule'
import { COPY } from '../copy'
import {
  createMetricProgressStyle,
  formatAbsoluteDate,
  formatCacheHit,
  formatCapsuleResetTime,
  formatCompactTokens,
  formatDayLabel,
  formatRelativeDuration,
  formatUsd,
  shouldShowDateLabel
} from '../formatters'
import { PANEL_TAB_MOTION_CLEAR_MS } from '../ui-constants'
import { SegmentedControl } from './controls'
import { ChevronDownIcon, WindowKeeperIcon } from './icons'

export function QuotaCard({
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

export function WindowKeeperStatusCard({
  copy,
  isEligible,
  locale,
  status
}: {
  copy: (typeof COPY)[LocaleCode]
  isEligible: boolean
  locale: LocaleCode
  status?: WindowKeeperStatus
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const resolvedStatus: WindowKeeperStatus = status ?? { state: 'waiting-data' }
  const stateLabel = resolveWindowKeeperStateLabel(resolvedStatus.state, isEligible, copy)
  const nextActionText = resolvedStatus.nextActionAt
    ? formatAbsoluteDate(resolvedStatus.nextActionAt, locale)
    : undefined

  return (
    <div className="window-keeper-expandable">
      <button
        aria-controls="window-keeper-details"
        aria-expanded={expanded}
        className={`detail-row window-keeper-row${expanded ? ' is-expanded' : ''}`}
        onClick={() => setExpanded((value) => !value)}
        type="button"
      >
        <span className="detail-row__label-group">
          <span
            className="detail-row__icon"
            style={{ '--icon-tone': 'var(--panel-accent)' } as CSSProperties}
          >
            <WindowKeeperIcon />
          </span>
          <span className="detail-row__label">{copy.windowKeeper}</span>
        </span>
        <span className="detail-row__value-group">
          <span
            className={`detail-row__value window-keeper-row__state window-keeper-row__state--${resolvedStatus.state}`}
          >
            {stateLabel}
          </span>
          {nextActionText ? <span className="detail-row__hint">{nextActionText}</span> : null}
          <span className="window-keeper-row__chevron" aria-hidden="true">
            <ChevronDownIcon />
          </span>
        </span>
      </button>
      <div
        aria-label={copy.windowKeeper}
        className="window-keeper-details"
        hidden={!expanded}
        id="window-keeper-details"
        role="region"
      >
        <dl className="window-keeper-details__rows">
          <div className="window-keeper-details__row">
            <dt>{copy.windowKeeperState}</dt>
            <dd>{stateLabel}</dd>
          </div>
          <div className="window-keeper-details__row">
            <dt>{copy.windowKeeperNextAction}</dt>
            <dd>{formatAbsoluteDate(resolvedStatus.nextActionAt, locale)}</dd>
          </div>
          <div className="window-keeper-details__row">
            <dt>{copy.windowKeeperLastTriggered}</dt>
            <dd>{formatAbsoluteDate(resolvedStatus.lastTriggeredAt, locale)}</dd>
          </div>
          <div className="window-keeper-details__row window-keeper-details__row--error">
            <dt>{copy.windowKeeperRecentError}</dt>
            <dd>{resolvedStatus.recentError ?? '--'}</dd>
          </div>
        </dl>
      </div>
    </div>
  )
}

function resolveWindowKeeperStateLabel(
  state: WindowKeeperState,
  isEligible: boolean,
  copy: (typeof COPY)[LocaleCode]
): string {
  switch (state) {
    case 'disabled':
      return copy.windowKeeperDisabled
    case 'waiting-data':
      return copy.windowKeeperWaitingData
    case 'waiting-weekly-reset':
      return copy.windowKeeperWaitingWeeklyReset
    case 'waiting-reset':
      return isEligible ? copy.windowKeeperWaitingReset : copy.windowKeeperWaitingWindow
    case 'triggering':
      return copy.windowKeeperTriggering
    case 'verifying':
      return copy.windowKeeperVerifying
    case 'retrying':
      return copy.windowKeeperRetrying
    case 'error':
      return copy.windowKeeperError
  }
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
export function ApiCapsuleStat({
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
  totals: { input: 0, cachedInput: 0, output: 0, reasoning: 0, total: 0, cost: 0 },
  models: []
}

// 模型用量榜:按 total 降序取 Top 5,其余合并为"其他";每行横条占比 + token + 花费
export function ModelLeaderboard({
  models,
  locale
}: {
  models: ModelUsage[]
  locale: LocaleCode
}): React.JSX.Element {
  const copy = COPY[locale]
  const [hoveredModel, setHoveredModel] = useState<string | null>(null)
  const [hoveredMetaModel, setHoveredMetaModel] = useState<string | null>(null)
  const grandTotal = models.reduce((sum, model) => sum + model.total, 0)
  const rows: Array<{ model: string; total: number; cost: number }> = models
    .slice(0, 5)
    .map((model) => ({ model: model.model, total: model.total, cost: model.cost }))
  const rest = models.slice(5)
  if (rest.length > 0) {
    rows.push({
      model: copy.modelOther,
      total: rest.reduce((sum, model) => sum + model.total, 0),
      cost: rest.reduce((sum, model) => sum + model.cost, 0)
    })
  }
  return (
    <div className="model-board">
      <div className="model-board__title">{copy.modelUsage}</div>
      {rows.map((row) => {
        const share = grandTotal > 0 ? Math.round((row.total / grandTotal) * 100) : 0
        const metaText = `${share}% · ${formatCompactTokens(row.total, locale)} · ${formatUsd(row.cost)}`
        const nameTruncated = hoveredModel === row.model
        const metaTruncated = hoveredMetaModel === row.model
        return (
          <div className="model-board__row" key={row.model}>
            <span
              className="model-board__name"
              onMouseEnter={(event) => {
                const el = event.currentTarget
                setHoveredModel(el.scrollWidth > el.clientWidth ? row.model : null)
              }}
              onMouseLeave={() => setHoveredModel(null)}
            >
              {row.model}
            </span>
            <span className="model-board__track" aria-hidden="true">
              <span className="model-board__fill" style={{ width: `${share}%` }} />
            </span>
            <span
              className="model-board__meta"
              onMouseEnter={(event) => {
                const el = event.currentTarget
                setHoveredMetaModel(el.scrollWidth > el.clientWidth ? row.model : null)
              }}
              onMouseLeave={() => setHoveredMetaModel(null)}
            >
              {metaText}
            </span>
            {nameTruncated ? <span className="model-board__tooltip">{row.model}</span> : null}
            {metaTruncated ? (
              <span className="model-board__tooltip model-board__tooltip--right">{metaText}</span>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

export function UsageCard({
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
  // 时间 tab 切换动效:复用页面 tab 切换的 Quick Snap,内容块错峰上浮
  const [windowMotionActive, setWindowMotionActive] = useState(false)
  const windowMotionTimerRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    return () => {
      if (windowMotionTimerRef.current !== undefined) {
        window.clearTimeout(windowMotionTimerRef.current)
      }
    }
  }, [])

  const startWindowMotion = (): void => {
    if (windowMotionTimerRef.current !== undefined) {
      window.clearTimeout(windowMotionTimerRef.current)
    }
    setWindowMotionActive(true)
    windowMotionTimerRef.current = window.setTimeout(() => {
      setWindowMotionActive(false)
      windowMotionTimerRef.current = undefined
    }, PANEL_TAB_MOTION_CLEAR_MS)
  }

  // 区间选择:customRange 为空=1/7/30 天预设,有值=自定义起止时间(毫秒)
  const [presetWindow, setPresetWindow] = useState<UsageWindow>('1d')
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
  const chartMax = Math.max(
    1,
    days.reduce((max, day) => Math.max(max, day.input + day.output), 0)
  )
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

  const models = isCustom ? rangeUsage?.models : usage?.models

  return (
    <section className={`usage-card${windowMotionActive ? ' is-window-switching' : ''}`}>
      <div className="usage-card__head">
        <span className="usage-card__title">{copy.usage}</span>
      </div>

      <SegmentedControl
        value={rangeOpen || isCustom ? 'custom' : presetWindow}
        options={[
          { label: copy.usage1d, value: '1d' },
          { label: copy.usage7d, value: '7d' },
          { label: copy.usage30d, value: '30d' },
          { label: copy.rangeCustom, value: 'custom' }
        ]}
        onChange={(value) => {
          if (value === 'custom') {
            if (!rangeOpen) {
              startWindowMotion()
            }
            setRangeOpen(true)
          } else {
            const usageWindow = value as UsageWindow
            // 同一预设且无自定义态时重复点击不重放动效
            if (usageWindow !== presetWindow || isCustom || rangeOpen) {
              startWindowMotion()
            }
            setPresetWindow(usageWindow)
            setCustomRange(undefined)
            setRangeOpen(false)
          }
        }}
      />

      {rangeOpen ? (
        <RangePanel
          copy={copy}
          startMs={customStartMs}
          endMs={customEndMs}
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
              <UsageSummaryItem
                label={copy.usageCost}
                value={formatUsd(rangeTotals.cost)}
                tone="cost"
              />
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
            <UsageSummaryItem
              label={copy.usageTotal}
              value={formatCompactTokens(totals.total, locale)}
            />
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
                      <span
                        className="usage-chart__bar usage-chart__bar--stack"
                        style={{ height: `${percent}%` }}
                      >
                        <span
                          className="usage-chart__bar-seg is-cached"
                          style={{ height: `${cachedPct}%` }}
                        />
                        <span
                          className="usage-chart__bar-seg is-input"
                          style={{ height: `${inputPct}%` }}
                        />
                        <span
                          className="usage-chart__bar-seg is-output"
                          style={{ height: `${outputPct}%` }}
                        />
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
      {models && models.length > 0 ? <ModelLeaderboard models={models} locale={locale} /> : null}
    </section>
  )
}

// 自定义区间选择面板:预设窗口 + 起止「日期+时分」输入,点「应用」生效
export function RangePanel({
  copy,
  startMs,
  endMs,
  onCustom
}: {
  copy: (typeof COPY)[LocaleCode]
  startMs: number | undefined
  endMs: number | undefined
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
          <input type="time" value={endTime} onChange={(event) => setEndTime(event.target.value)} />
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
export function UsageTooltip({
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
export function UsageBar({
  day,
  locale
}: {
  day: TokenUsageDay
  locale: LocaleCode
}): React.JSX.Element {
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

export function UsageSummaryItem({
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
