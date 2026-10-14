import type { ActivityInterval } from '../../../shared/activity'
import type { WorkWindow } from '../../../shared/work-time'
import type { ActivityCopy } from './copy'
import {
  activityDisplayIntervals,
  formatActivityDuration,
  formatActivityTime,
  type ActivityDisplayInterval,
  type ActivityDisplayKind
} from './model'

const KINDS: ActivityDisplayKind[] = ['active', 'inactive']
interface TimelineProps {
  timeline: ActivityInterval[]
  windows: WorkWindow[]
  copy: ActivityCopy
}

function intervalText(interval: ActivityDisplayInterval, copy: ActivityCopy): string {
  return `${copy[interval.kind]} · ${formatActivityTime(interval.start)} - ${formatActivityTime(interval.end)} · ${formatActivityDuration(interval.end - interval.start, copy)}`
}

function WindowBand({
  window,
  maxDuration,
  timeline,
  copy
}: {
  window: WorkWindow
  maxDuration: number
  timeline: ActivityDisplayInterval[]
  copy: ActivityCopy
}): React.JSX.Element {
  const duration = window.end - window.start
  const intervals = timeline
    .map((interval) => ({
      ...interval,
      start: Math.max(window.start, interval.start),
      end: Math.min(window.end, interval.end)
    }))
    .filter((interval) => interval.end > interval.start)
  return (
    <div
      className="activity-timeline__plot"
      style={{ width: `${(duration / maxDuration) * 100}%` }}
    >
      <div
        className="quota-card__progress activity-timeline__band"
        aria-label={`${formatActivityTime(window.start)} - ${formatActivityTime(window.end)}`}
      >
        {intervals.map((interval) => (
          <i
            key={`${interval.start}-${interval.end}`}
            tabIndex={0}
            className={`activity-segment activity-pattern--${interval.kind}`}
            style={{
              left: `${((interval.start - window.start) / duration) * 100}%`,
              width: `${((interval.end - interval.start) / duration) * 100}%`
            }}
            title={intervalText(interval, copy)}
            aria-label={intervalText(interval, copy)}
          />
        ))}
      </div>
      <div className="quota-card__reset activity-timeline__axis" aria-hidden="true">
        <span>{formatActivityTime(window.start).slice(0, 5)}</span>
        <span className="activity-timeline__end">{formatActivityTime(window.end).slice(0, 5)}</span>
      </div>
    </div>
  )
}

export function ActivityTimeline({ timeline, windows, copy }: TimelineProps): React.JSX.Element {
  const maxDuration = Math.max(...windows.map((window) => window.end - window.start))
  const displayIntervals = activityDisplayIntervals(timeline)
  return (
    <section className="activity-timeline" aria-label={copy.timeline}>
      {windows.map((window, index) => (
        <div className="activity-timeline__row" key={window.start}>
          <span className="detail-row__hint activity-timeline__label">
            {index === 0 ? copy.morning : copy.afternoon}
          </span>
          <WindowBand
            window={window}
            maxDuration={maxDuration}
            timeline={displayIntervals}
            copy={copy}
          />
        </div>
      ))}
    </section>
  )
}

export function ActivityLegend({ copy }: { copy: ActivityCopy }): React.JSX.Element {
  return (
    <div className="activity-legend">
      {KINDS.map((kind) => (
        <span key={kind}>
          <i aria-hidden="true" className={`activity-pattern--${kind}`} />
          {copy[kind]}
        </span>
      ))}
    </div>
  )
}
