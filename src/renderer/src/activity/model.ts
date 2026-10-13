import { MINUTE_MS, WORK_TIMEZONE, type WorkWindow } from '../../../shared/work-time.ts'
import type { ActivityInterval, ActivityMember } from '../../../shared/activity'
import type { ActivityCopy } from './copy'

const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60
const MILLISECONDS_PER_SECOND = 1000

export type ActivityDisplayKind = 'active' | 'inactive'
export interface ActivityDisplayInterval extends WorkWindow {
  kind: ActivityDisplayKind
}

export function inactiveActivityMs(member: ActivityMember): number {
  return member.summary
    ? member.summary.idleMs + member.summary.lockedMs + member.summary.suspendedMs
    : 0
}

export function sortActivityMembersByInactiveTime(members: ActivityMember[]): ActivityMember[] {
  return members
    .map((member) => ({
      member,
      inactiveMs: inactiveActivityMs(member)
    }))
    .sort((left, right) => right.inactiveMs - left.inactiveMs)
    .map(({ member }) => member)
}

export function activityDisplayIntervals(timeline: ActivityInterval[]): ActivityDisplayInterval[] {
  const result: ActivityDisplayInterval[] = []
  for (const interval of timeline) {
    if (interval.kind === 'unknown') continue
    const kind = interval.kind === 'active' ? 'active' : 'inactive'
    const previous = result.at(-1)
    if (previous?.kind === kind && previous.end === interval.start) previous.end = interval.end
    else result.push({ start: interval.start, end: interval.end, kind })
  }
  return result
}

export function formatActivityTime(time?: number): string {
  return time === undefined
    ? '--'
    : new Intl.DateTimeFormat('en-GB', {
        timeZone: WORK_TIMEZONE,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      }).format(time)
}

export function formatActivityDuration(ms: number, copy: ActivityCopy): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000)
  const minutes = Math.floor(seconds / (MINUTE_MS / 1000))
  return minutes > 0
    ? `${minutes} ${copy.minutes} ${seconds % 60} ${copy.seconds}`
    : `${seconds} ${copy.seconds}`
}

export function formatCompactActivityDuration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / MILLISECONDS_PER_SECOND)
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE)
  const hours = Math.floor(minutes / MINUTES_PER_HOUR)
  return `${hours}h:${minutes % MINUTES_PER_HOUR}m:${seconds % SECONDS_PER_MINUTE}s`
}
