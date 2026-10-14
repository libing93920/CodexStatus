import { isPeerId } from './team-role.ts'
import {
  DAY_MS,
  MINUTE_MS,
  intersectWorkWindows,
  isRetainedWorkDate,
  workDayStart,
  type WorkWindow
} from './work-time.ts'

export const ACTIVITY_PROTOCOL_VERSION = 1
export const ACTIVITY_SAMPLE_MS = 5_000
export const ACTIVITY_CHECKPOINT_MS = 30_000
export const ACTIVITY_LIVE_MS = 10_000
export const ACTIVITY_SYNC_MS = 60_000
export const ACTIVITY_STALE_MS = 35_000
export const ACTIVITY_MAX_MESSAGE_BYTES = 2 * 1024 * 1024
export const ACTIVITY_MAX_INTERVALS = 20_000
export const DEFAULT_IDLE_THRESHOLD_MINUTES = 5
export const MIN_IDLE_THRESHOLD_MINUTES = 1
export const MAX_IDLE_THRESHOLD_MINUTES = 60
export const ACTIVITY_CHANNELS = {
  board: 'codex-status:activity-board',
  calendarRefresh: 'codex-status:activity-calendar-refresh',
  panelVisibility: 'codex-status:panel-visibility',
  panelVisibilityChanged: 'codex-status:panel-visibility-changed'
} as const

export type ActivityKind = 'active' | 'idle' | 'locked' | 'suspended' | 'unknown'
export interface ActivityInterval extends WorkWindow {
  kind: ActivityKind
}

export interface ActivityDay {
  version: number
  team: string
  peerId: string
  nickname: string
  date: string
  revision: number
  calendarVersion: string
  observedAt: number
  firstInputAt?: number
  lastInputAt?: number
  intervals: ActivityInterval[]
  incomplete: boolean
}

export interface ActivityLive {
  observedAt: number
  state: ActivityKind | 'outside-work' | 'calendar-unavailable' | 'disabled'
  idleSince?: number
  lastInputAt?: number
  enabled: boolean
}

export type ActivityMessage =
  | { type: 'activity-request'; revisions: Record<string, number> }
  | { type: 'activity-day'; day: ActivityDay }
  | { type: 'activity-live'; live: ActivityLive }
  | { type: 'activity-ack'; date: string; revision: number }

export interface ActivitySummary {
  idleMs: number
  idleCount: number
  longestIdleMs: number
  lockedMs: number
  suspendedMs: number
  unknownMs: number
  observedMs: number
  timeline: ActivityInterval[]
}

export interface WorkCalendarStatus {
  year: number
  available: boolean
  isWorkday?: boolean
  windows: WorkWindow[]
  version: string
  papers: string[]
  lastCheckedAt?: number
  updating: boolean
  error?: string
}

export interface ActivityMember {
  id: string
  nickname: string
  isSelf: boolean
  online: boolean
  supported: boolean
  enabled?: boolean
  day?: ActivityDay
  live?: ActivityLive
  summary?: ActivitySummary
  receivedAt?: number
  calendarMismatch?: boolean
}

export interface ActivityBoard {
  date: string
  generatedAt: number
  thresholdMinutes: number
  calendar: WorkCalendarStatus
  members: ActivityMember[]
  issues: string[]
}

export function normalizeIdleThreshold(value: unknown): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_IDLE_THRESHOLD_MINUTES &&
    value <= MAX_IDLE_THRESHOLD_MINUTES
    ? value
    : DEFAULT_IDLE_THRESHOLD_MINUTES
}

export function appendActivityInterval(
  intervals: ActivityInterval[],
  interval: ActivityInterval,
  merge = true
): void {
  if (interval.end <= interval.start) return
  const previous = intervals.at(-1)
  if (merge && previous?.kind === interval.kind && previous.end === interval.start) {
    previous.end = interval.end
    return
  }
  intervals.push({ ...interval })
}

export function summarizeActivity(
  day: ActivityDay,
  windows: WorkWindow[],
  thresholdMinutes: number,
  now: number
): ActivitySummary {
  const result: ActivitySummary = {
    idleMs: 0,
    idleCount: 0,
    longestIdleMs: 0,
    lockedMs: 0,
    suspendedMs: 0,
    unknownMs: 0,
    observedMs: 0,
    timeline: []
  }
  const cutoff = now
  const threshold = normalizeIdleThreshold(thresholdMinutes) * MINUTE_MS
  for (const window of windows) {
    const end = Math.min(window.end, cutoff)
    if (end <= window.start) continue
    let cursor = window.start
    for (const interval of day.intervals) {
      const start = Math.max(interval.start, window.start)
      const stop = Math.min(interval.end, end)
      if (stop <= start) continue
      if (start > cursor)
        appendActivityInterval(result.timeline, { start: cursor, end: start, kind: 'unknown' })
      const kind = interval.kind === 'idle' && stop - start < threshold ? 'active' : interval.kind
      appendActivityInterval(result.timeline, { start, end: stop, kind }, kind !== 'idle')
      cursor = stop
    }
    if (cursor < end)
      appendActivityInterval(result.timeline, { start: cursor, end, kind: 'unknown' })
  }
  accumulateSummary(result)
  return result
}

function accumulateSummary(result: ActivitySummary): void {
  for (const interval of result.timeline) {
    const duration = interval.end - interval.start
    if (interval.kind !== 'unknown') result.observedMs += duration
    if (interval.kind === 'idle') {
      result.idleMs += duration
      result.idleCount++
      result.longestIdleMs = Math.max(result.longestIdleMs, duration)
    } else if (interval.kind === 'locked') result.lockedMs += duration
    else if (interval.kind === 'suspended') result.suspendedMs += duration
    else if (interval.kind === 'unknown') result.unknownMs += duration
  }
}

export function validateActivityDay(value: unknown, now = Date.now()): value is ActivityDay {
  if (!value || typeof value !== 'object') return false
  const day = value as ActivityDay
  if (
    day.version !== ACTIVITY_PROTOCOL_VERSION ||
    !/^[a-f0-9]{12}$/.test(day.team) ||
    !isPeerId(day.peerId)
  )
    return false
  if (!isRetainedWorkDate(day.date, now) || !Number.isSafeInteger(day.revision) || day.revision < 1)
    return false
  if (
    typeof day.nickname !== 'string' ||
    day.nickname.length > 100 ||
    typeof day.calendarVersion !== 'string' ||
    day.calendarVersion.length > 100
  )
    return false
  const start = workDayStart(day.date)
  if (
    !Number.isFinite(day.observedAt) ||
    day.observedAt < start ||
    day.observedAt > Math.min(start + DAY_MS, now + ACTIVITY_SAMPLE_MS)
  )
    return false
  if (
    typeof day.incomplete !== 'boolean' ||
    !Array.isArray(day.intervals) ||
    day.intervals.length > ACTIVITY_MAX_INTERVALS
  )
    return false
  for (const inputAt of [day.firstInputAt, day.lastInputAt]) {
    if (
      inputAt !== undefined &&
      (!Number.isFinite(inputAt) || inputAt < start || inputAt > day.observedAt)
    )
      return false
  }
  let cursor = start
  for (const interval of day.intervals) {
    if (
      !validActivityInterval(interval) ||
      interval.start < cursor ||
      interval.end > day.observedAt ||
      interval.end > start + DAY_MS
    )
      return false
    cursor = interval.end
  }
  return true
}

function validActivityInterval(value: unknown): value is ActivityInterval {
  if (!value || typeof value !== 'object') return false
  const interval = value as ActivityInterval
  return (
    Number.isFinite(interval.start) &&
    Number.isFinite(interval.end) &&
    interval.end > interval.start &&
    ['active', 'idle', 'locked', 'suspended', 'unknown'].includes(interval.kind)
  )
}

export function clipActivityIntervals(
  intervals: ActivityInterval[],
  windows: WorkWindow[]
): ActivityInterval[] {
  return intervals.flatMap((interval) =>
    intersectWorkWindows(interval.start, interval.end, windows).map((range) => ({
      ...range,
      kind: interval.kind
    }))
  )
}

export function validateActivityMessage(
  value: unknown,
  now = Date.now()
): value is ActivityMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as ActivityMessage
  if (message.type === 'activity-day') return validateActivityDay(message.day, now)
  if (message.type === 'activity-ack')
    return (
      isRetainedWorkDate(message.date, now) &&
      Number.isSafeInteger(message.revision) &&
      message.revision >= 1
    )
  if (message.type === 'activity-request') {
    if (
      !message.revisions ||
      typeof message.revisions !== 'object' ||
      Array.isArray(message.revisions)
    )
      return false
    const entries = Object.entries(message.revisions)
    return (
      entries.length <= 30 &&
      entries.every(
        ([date, revision]) =>
          isRetainedWorkDate(date, now) && Number.isSafeInteger(revision) && revision >= 0
      )
    )
  }
  if (message.type !== 'activity-live' || !message.live || typeof message.live !== 'object')
    return false
  const live = message.live
  if (
    !Number.isFinite(live.observedAt) ||
    live.observedAt > now + ACTIVITY_SAMPLE_MS ||
    live.observedAt < now - DAY_MS ||
    typeof live.enabled !== 'boolean'
  )
    return false
  if (
    ![
      'active',
      'idle',
      'locked',
      'suspended',
      'unknown',
      'outside-work',
      'calendar-unavailable',
      'disabled'
    ].includes(live.state)
  )
    return false
  return [live.idleSince, live.lastInputAt].every(
    (time) =>
      time === undefined ||
      (Number.isFinite(time) && time >= now - DAY_MS && time <= live.observedAt)
  )
}

export function canExchangeActivity(
  type: ActivityMessage['type'],
  localAdmin: boolean,
  remoteAdmin: boolean,
  direction: 'send' | 'receive'
): boolean {
  const adminMessage = type === 'activity-request' || type === 'activity-ack'
  return direction === 'send'
    ? adminMessage
      ? localAdmin
      : remoteAdmin
    : adminMessage
      ? remoteAdmin
      : localAdmin
}
