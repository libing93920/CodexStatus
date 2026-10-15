import type { ActivityBoard, ActivityMember } from '../../../shared/activity'
import type { ActivityCopy } from './copy'
import { formatActivityDuration, unconfirmedActivityMs } from './model'

export function ActivityWarnings({
  member,
  board,
  copy
}: {
  member: ActivityMember
  board: ActivityBoard
  copy: ActivityCopy
}): React.JSX.Element | null {
  const unknownMs = unconfirmedActivityMs(member.day, board.calendar.windows, board.generatedAt)
  if (unknownMs <= 0) return null
  return (
    <p className="activity-warning activity-coverage-warning">
      {copy.unconfirmedTime(formatActivityDuration(unknownMs, copy))}
    </p>
  )
}
