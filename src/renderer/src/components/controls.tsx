import { useEffect, useLayoutEffect, useRef, type CSSProperties } from 'react'
import type React from 'react'
import type { AgentId, LocaleCode, PanelView, ThemeId } from '../../../shared/capsule'
import { formatCompactTokensDisplay, formatUsd, resolveMetricColor } from '../formatters'
import { TEAM_ROW_STAGGER_MAX_INDEX, TEAM_ROW_STAGGER_MS } from '../ui-constants'
import { HeartIcon, TicketIcon } from './icons'

export function DetailRow({
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
            <span
              className="detail-row__value"
              style={valueColor ? { color: valueColor } : undefined}
            >
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

export function SettingField({
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

// 团队排行榜一行:排名/昵称(前带版本点)/剩余百分比横条+数字/重置卡数量;self 行高亮
export function TeamRow({
  isSelf,
  rank,
  nickname,
  remainingPercent,
  shortWindow,
  longWindow,
  resetCreditCount,
  appVersion,
  isLatestVersion,
  theme
}: {
  isSelf: boolean
  rank: number
  nickname: string
  remainingPercent?: number
  shortWindow?: { label: string; remainingPercent?: number }
  longWindow?: { label: string; remainingPercent?: number }
  resetCreditCount?: number
  appVersion?: string
  isLatestVersion?: boolean
  theme: ThemeId
}): React.JSX.Element {
  const percent =
    remainingPercent === undefined || !Number.isFinite(remainingPercent)
      ? undefined
      : Math.min(100, Math.max(0, remainingPercent))
  const accent = resolveMetricColor(percent, 'remaining', theme)
  const rankClass =
    rank === 1 ? ' is-top-1' : rank === 2 ? ' is-top-2' : rank === 3 ? ' is-top-3' : ''
  const hasBoth = shortWindow !== undefined && longWindow !== undefined
  return (
    <div
      className={`team-row${isSelf ? ' is-self' : ''}${rankClass}${hasBoth ? ' team-row--dual' : ''}`}
      style={
        {
          '--metric-accent': accent,
          '--team-row-delay': `${Math.min(rank - 1, TEAM_ROW_STAGGER_MAX_INDEX) * TEAM_ROW_STAGGER_MS}ms`
        } as CSSProperties
      }
    >
      <span className="team-row__rank">{rank}</span>
      <span className="team-row__name">
        <span className="team-row__name-text">
          {appVersion !== undefined ? (
            <span
              className={`team-row__dot${isLatestVersion ? ' is-latest' : ' is-outdated'}`}
              title={appVersion}
            />
          ) : null}
          {nickname}
        </span>
      </span>
      {hasBoth ? (
        <div className="team-row__windows">
          <WindowLine
            label={shortWindow.label}
            percent={shortWindow.remainingPercent}
            theme={theme}
          />
          <WindowLine
            label={longWindow.label}
            percent={longWindow.remainingPercent}
            theme={theme}
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

// 团队榜三工具分段颜色:进度条不标文字,颜色区分工具,悬停浮层提示明细
const AGENT_SEGMENT_COLORS: Record<AgentId, string> = {
  codex: 'var(--metric-accent, rgba(151, 163, 176, 0.74))',
  claude: '#ecc05a',
  opencode: '#b585ff'
}
const AGENT_SEGMENT_LABELS: Record<AgentId, string> = {
  codex: 'Codex',
  claude: 'Claude',
  opencode: 'OpenCode'
}

// Token/花费排行榜共用一行:按窗口最大值归一化横条;self 行高亮
export function TeamUsageRow({
  isSelf,
  rank,
  nickname,
  valueMode = 'tokens',
  tokens,
  cost,
  tokensByAgent,
  maxValue,
  locale,
  appVersion,
  isLatestVersion,
  likeCount,
  selfLiked,
  onLike
}: {
  isSelf: boolean
  rank: number
  nickname: string
  valueMode?: 'tokens' | 'cost'
  tokens?: number
  cost?: number
  tokensByAgent?: Partial<Record<AgentId, number>>
  /** 当前排行榜窗口的最大值;花费榜同样按实际最大金额归一化 */
  maxValue: number
  locale: LocaleCode
  appVersion?: string
  isLatestVersion?: boolean
  likeCount?: number
  selfLiked?: boolean
  onLike?: () => void
}): React.JSX.Element {
  const isCost = valueMode === 'cost'
  const value = isCost ? cost : tokens
  const safeValue = value !== undefined && Number.isFinite(value) ? value : undefined
  const percent =
    safeValue !== undefined && maxValue > 0
      ? Math.min(100, Math.max(0, (safeValue / maxValue) * 100))
      : 0
  const rankClass =
    rank === 1 ? ' is-top-1' : rank === 2 ? ' is-top-2' : rank === 3 ? ' is-top-3' : ''
  const segments =
    !isCost && tokensByAgent
      ? (['codex', 'claude', 'opencode'] as const)
          .map((id) => ({ id, tokens: tokensByAgent[id] ?? 0 }))
          .filter((segment) => segment.tokens > 0)
      : undefined
  const showLike = !isCost && onLike !== undefined
  return (
    <div
      className={`team-row team-row--${isCost ? 'cost' : 'token'}${isSelf ? ' is-self' : ''}${rankClass}${
        showLike ? ' is-like' : ''
      }`}
      style={
        {
          '--team-row-delay': `${Math.min(rank - 1, TEAM_ROW_STAGGER_MAX_INDEX) * TEAM_ROW_STAGGER_MS}ms`
        } as CSSProperties
      }
    >
      <span className="team-row__rank">{rank}</span>
      <span className="team-row__name">
        <span className="team-row__name-text">
          {appVersion !== undefined ? (
            <span
              className={`team-row__dot${isLatestVersion ? ' is-latest' : ' is-outdated'}`}
              title={appVersion}
            />
          ) : null}
          {nickname}
        </span>
        {showLike ? (
          <button
            aria-label="点赞"
            className={`team-row__like${selfLiked ? ' is-liked' : ''}`}
            onClick={() => onLike?.()}
            type="button"
          >
            <span className="team-row__like-count">{likeCount ?? 0}</span>
            <HeartIcon />
          </button>
        ) : null}
      </span>
      <span className="team-row__bar">
        {segments && segments.length > 0 ? (
          <span className="team-row__bar-segments">
            {segments.map((segment) => (
              <span
                className="team-row__bar-segment"
                key={segment.id}
                style={{
                  width: `${
                    maxValue > 0 ? Math.min(100, Math.max(0, (segment.tokens / maxValue) * 100)) : 0
                  }%`,
                  background: AGENT_SEGMENT_COLORS[segment.id]
                }}
              />
            ))}
          </span>
        ) : (
          <span className="team-row__bar-fill" style={{ width: `${percent}%` }} />
        )}
      </span>
      <span className="team-row__value">
        {safeValue === undefined
          ? '--'
          : isCost
            ? formatUsd(safeValue)
            : formatCompactTokensDisplay(safeValue, locale)}
      </span>
      {segments && segments.length > 0 ? (
        <span className="team-row__tooltip" role="tooltip">
          {(['codex', 'claude', 'opencode'] as const).map((id) => (
            <span className="team-row__tooltip-row" key={id}>
              <span
                className="team-row__tooltip-dot"
                style={{ background: AGENT_SEGMENT_COLORS[id] }}
              />
              <span className="team-row__tooltip-label">{AGENT_SEGMENT_LABELS[id]}</span>
              <span className="team-row__tooltip-value">
                {formatCompactTokensDisplay(tokensByAgent?.[id] ?? 0, locale)}
              </span>
            </span>
          ))}
        </span>
      ) : null}
    </div>
  )
}

export function WindowLine({
  label,
  percent,
  theme
}: {
  label: string
  percent?: number
  theme: ThemeId
}): React.JSX.Element {
  const safePercent =
    percent === undefined || !Number.isFinite(percent)
      ? undefined
      : Math.min(100, Math.max(0, percent))
  const accent = resolveMetricColor(safePercent, 'remaining', theme)
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

export function PanelTabs({
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

export function SegmentedControl({
  value,
  options,
  onChange,
  disabled,
  scrollable
}: {
  value: string
  options: Array<{ label: string; value: string }>
  onChange: (value: string) => void
  disabled?: boolean
  scrollable?: boolean
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const isDraggingRef = useRef(false)
  const hasDraggedRef = useRef(false)
  const startXRef = useRef(0)
  const scrollStartRef = useRef(0)

  // 横滑模式:选中项自动滚动居中,便于 12 项内快速定位
  useLayoutEffect(() => {
    if (!scrollable) return
    const container = scrollRef.current
    const active = container?.querySelector<HTMLButtonElement>('.is-active')
    active?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  }, [value, scrollable])

  // 纵向滚轮转为横向滚动(原生监听 + passive:false 才能 preventDefault)
  useEffect(() => {
    if (!scrollable) return
    const container = scrollRef.current
    if (!container) return
    const onWheelNative = (event: WheelEvent): void => {
      if (container.scrollWidth <= container.clientWidth) return
      if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        event.preventDefault()
        container.scrollLeft += event.deltaY
      }
    }
    container.addEventListener('wheel', onWheelNative, { passive: false })
    return () => {
      container.removeEventListener('wheel', onWheelNative)
    }
  }, [scrollable])

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!scrollable || disabled) return
    const container = scrollRef.current
    if (!container || container.scrollWidth <= container.clientWidth) return
    // 轻点阈值提高到 6px,避免手抖误判为拖动导致点击被吞
    isDraggingRef.current = true
    hasDraggedRef.current = false
    startXRef.current = event.clientX
    scrollStartRef.current = container.scrollLeft
    // 不用 setPointerCapture,避免按钮 click 事件被吞;冒泡已足够
    container.style.cursor = 'grabbing'
    container.style.userSelect = 'none'
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!scrollable || !isDraggingRef.current) return
    const container = scrollRef.current
    if (!container) return
    const deltaX = event.clientX - startXRef.current
    if (Math.abs(deltaX) > 6) {
      hasDraggedRef.current = true
    }
    // 只有超过阈值才滚动,避免轻点微抖动导致位移
    if (hasDraggedRef.current) {
      container.scrollLeft = scrollStartRef.current - deltaX
    }
  }

  const handlePointerUp = (): void => {
    if (!scrollable) return
    const container = scrollRef.current
    isDraggingRef.current = false
    if (container) {
      container.style.cursor = ''
      container.style.userSelect = ''
    }
    // 拖动结束后短暂保留标记,拦截紧接着的 click 事件
    if (hasDraggedRef.current) {
      window.setTimeout(() => {
        hasDraggedRef.current = false
      }, 80)
    }
  }

  const handleOptionClick =
    (optionValue: string) =>
    (event: React.MouseEvent<HTMLButtonElement>): void => {
      if (hasDraggedRef.current) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      onChange(optionValue)
    }

  return (
    <div
      ref={scrollRef}
      className={`segmented ${disabled ? 'is-disabled' : ''} ${scrollable ? 'segmented--scrollable' : ''}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      {options.map((option) => (
        <button
          className={option.value === value ? 'is-active' : ''}
          disabled={disabled}
          key={option.value}
          onClick={handleOptionClick(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function ToggleSwitch({
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
