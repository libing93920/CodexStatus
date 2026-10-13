import { useId, useState } from 'react'
import type { ActivityBoard, ActivityMember } from '../../../shared/activity'
import type { AppSettings } from '../../../shared/capsule'
import { currentWeekDates, workDateKey } from '../../../shared/work-time'
import { ActivityLegend, ActivityTimeline } from './ActivityTimeline'
import { activityCopy, type ActivityCopy } from './copy'
import {
  formatActivityDuration,
  formatCompactActivityDuration,
  inactiveActivityMs,
  sortActivityMembersByInactiveTime
} from './model'
import { useActivityBoard } from './useActivityBoard'
import { ChevronDownIcon } from '../components/icons'

export function ActivityPanel({ settings }: { settings: AppSettings }): React.JSX.Element {
  const copy = activityCopy(settings.locale)
  const [selectedDate, setSelectedDate] = useState<string>()
  const { board, date, error, loading, reload, now } = useActivityBoard(selectedDate)
  return (
    <section className="activity" aria-label={copy.title} aria-busy={loading}>
      <ActivityWeek date={date} now={now} copy={copy} onSelect={setSelectedDate} />
      {loading ? (
        <p className="settings-section activity-empty" role="status">
          {copy.loading}
        </p>
      ) : null}
      {error ? (
        <div className="settings-section activity-load-error" role="alert">
          <p>{copy.loadFailed}</p>
          {board ? <p>{copy.staleData}</p> : null}
          <button type="button" className="ghost-button activity-button" onClick={reload}>
            {copy.retry}
          </button>
        </div>
      ) : null}
      {board ? <ActivityMembers key={date} board={board} copy={copy} /> : null}
      {board?.issues.length ? (
        <ul className="settings-section activity-warning" role="alert">
          {board.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

function ActivityWeek({
  date,
  now,
  copy,
  onSelect
}: {
  date: string
  now: number
  copy: ActivityCopy
  onSelect: (date: string) => void
}): React.JSX.Element {
  const today = workDateKey(now)
  return (
    <section className="settings-section activity-week" aria-label={copy.date}>
      <h2 className="settings-section__title">{copy.date}</h2>
      <div className="segmented activity-week__days" role="group" aria-label={copy.date}>
        {currentWeekDates(now).map((item, index) => (
          <button
            key={item}
            type="button"
            aria-pressed={item === date}
            aria-current={item === today ? 'date' : undefined}
            disabled={item > today}
            onClick={() => onSelect(item)}
            className={`activity-week__day${item === date ? ' is-active' : ''}`}
          >
            {copy.weekdays[index]}
          </button>
        ))}
      </div>
    </section>
  )
}

function ActivityMembers({
  board,
  copy
}: {
  board: ActivityBoard
  copy: ActivityCopy
}): React.JSX.Element {
  if (!board.calendar.available) {
    return (
      <p className="settings-section activity-warning" role="alert">
        {copy.noCalendar}
      </p>
    )
  }
  if (!board.calendar.windows.length) {
    return <p className="settings-section activity-empty">{copy.restday}</p>
  }
  return (
    <section className="settings-section activity-members" aria-label={copy.members}>
      <div className="activity-members__heading">
        <h2 className="settings-section__title">{copy.members}</h2>
        <ActivityLegend copy={copy} />
      </div>
      {!board.members.length ? <p className="activity-empty">{copy.empty}</p> : null}
      {sortActivityMembersByInactiveTime(board.members).map((member) => (
        <ActivityMemberCard key={member.id} member={member} board={board} copy={copy} />
      ))}
    </section>
  )
}

function ActivityMemberCard({
  member,
  board,
  copy
}: {
  member: ActivityMember
  board: ActivityBoard
  copy: ActivityCopy
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const detailId = useId()
  const inactiveDuration = member.summary
    ? formatCompactActivityDuration(inactiveActivityMs(member))
    : '--'
  const inactiveLabel = `${copy.inactive} ${member.summary ? formatActivityDuration(inactiveActivityMs(member), copy) : copy.noDay}`
  return (
    <article className="window-keeper-expandable activity-member">
      <button
        type="button"
        className={`detail-row window-keeper-row activity-member__toggle${expanded ? ' is-expanded' : ''}`}
        aria-expanded={expanded}
        aria-controls={detailId}
        onClick={() => setExpanded((value) => !value)}
      >
        <span
          className="detail-row__label activity-member__name"
          title={member.nickname || copy.anonymous}
        >
          {member.nickname || copy.anonymous}
        </span>
        <span className="detail-row__value-group">
          <span
            className="detail-row__hint activity-member__inactive"
            title={inactiveLabel}
            aria-label={inactiveLabel}
          >
            {inactiveDuration}
          </span>
          <span className="window-keeper-row__chevron" aria-hidden="true">
            <ChevronDownIcon />
          </span>
        </span>
      </button>
      <div
        id={detailId}
        className="window-keeper-details activity-detail"
        hidden={!expanded}
        role="region"
        aria-label={member.nickname || copy.anonymous}
      >
        {expanded ? <ActivityMemberDetail member={member} board={board} copy={copy} /> : null}
      </div>
    </article>
  )
}

function ActivityMemberDetail({
  member,
  board,
  copy
}: {
  member: ActivityMember
  board: ActivityBoard
  copy: ActivityCopy
}): React.JSX.Element {
  return (
    <>
      {member.day ? (
        <ActivityTimeline
          windows={board.calendar.windows}
          timeline={member.summary?.timeline ?? []}
          copy={copy}
        />
      ) : (
        <p className="activity-empty">{copy.noDay}</p>
      )}
      {member.calendarMismatch ? <p className="activity-warning">{copy.mismatch}</p> : null}
      {member.day?.incomplete ? <p className="activity-warning">{copy.incomplete}</p> : null}
    </>
  )
}
