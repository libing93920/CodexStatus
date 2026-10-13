export const WORK_TIMEZONE = 'Asia/Shanghai'
export const MINUTE_MS = 60_000
export const DAY_MS = 24 * 60 * MINUTE_MS
export const WORK_TIMEZONE_OFFSET_MS = 8 * 60 * MINUTE_MS
export const ACTIVITY_RETENTION_DAYS = 30
const DAYS_IN_WEEK = 7

export interface WorkWindow {
  start: number
  end: number
}

export interface HolidayCalendar {
  year: number
  papers: string[]
  days: { date: string; isOffDay: boolean }[]
}

export function workDateKey(now: number): string {
  return new Date(now + WORK_TIMEZONE_OFFSET_MS).toISOString().slice(0, 10)
}

export function isWorkDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const time = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
}

export function workDayStart(date: string): number {
  return Date.parse(`${date}T00:00:00+08:00`)
}

export function recentWorkDates(now: number): string[] {
  return Array.from({ length: ACTIVITY_RETENTION_DAYS }, (_, index) =>
    workDateKey(now - index * DAY_MS)
  )
}

export function currentWeekDates(now: number): string[] {
  const weekday = new Date(now + WORK_TIMEZONE_OFFSET_MS).getUTCDay()
  const daysSinceMonday = (weekday + DAYS_IN_WEEK - 1) % DAYS_IN_WEEK
  const monday = workDayStart(workDateKey(now)) - daysSinceMonday * DAY_MS
  return Array.from({ length: DAYS_IN_WEEK }, (_, index) => workDateKey(monday + index * DAY_MS))
}

export function isRetainedWorkDate(date: unknown, now = Date.now()): date is string {
  return (
    isWorkDate(date) &&
    date <= workDateKey(now) &&
    date >= workDateKey(now - (ACTIVITY_RETENTION_DAYS - 1) * DAY_MS)
  )
}

export function seasonalWorkWindows(date: string): WorkWindow[] {
  if (!isWorkDate(date)) return []
  const summer = date.slice(5) >= '05-01' && date.slice(5) < '10-01'
  const start = workDayStart(date)
  return [
    { start: start + (8 * 60 + 30) * MINUTE_MS, end: start + 12 * 60 * MINUTE_MS },
    {
      start: start + (13 * 60 + (summer ? 45 : 30)) * MINUTE_MS,
      end: start + (summer ? 18 * 60 : 17 * 60 + 45) * MINUTE_MS
    }
  ]
}

export function isCalendarWorkday(date: string, calendars: HolidayCalendar[]): boolean | undefined {
  const year = Number(date.slice(0, 4))
  if (!isWorkDate(date) || !calendars.some((item) => item.year === year)) return undefined
  // 下一年通知可能包含本年12月的安排；只让有效的新年度条目覆盖对应日期。
  const ordered = [...calendars].sort((left, right) => right.year - left.year)
  for (const calendar of ordered) {
    const day = calendar.days.find((item) => item.date === date)
    if (day) return !day.isOffDay
  }
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay()
  return weekday !== 0 && weekday !== 6
}

export function calendarWorkWindows(date: string, calendars: HolidayCalendar[]): WorkWindow[] {
  return isCalendarWorkday(date, calendars) === true ? seasonalWorkWindows(date) : []
}

export function parseHolidayCalendar(
  value: unknown,
  expectedYear: number
): HolidayCalendar | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (record.year !== expectedYear || !Array.isArray(record.papers) || record.papers.length === 0)
    return undefined
  if (!Array.isArray(record.days) || record.days.length === 0 || record.days.length > 400)
    return undefined
  const papers = record.papers.filter(
    (paper): paper is string =>
      typeof paper === 'string' && /^https?:\/\/[^/]*gov\.cn\//.test(paper)
  )
  if (papers.length !== record.papers.length) return undefined
  const dates = new Set<string>()
  const days: HolidayCalendar['days'] = []
  for (const item of record.days) {
    if (!item || typeof item !== 'object') return undefined
    const day = item as Record<string, unknown>
    if (!isWorkDate(day.date) || typeof day.isOffDay !== 'boolean' || dates.has(day.date))
      return undefined
    const year = Number(day.date.slice(0, 4))
    if (year !== expectedYear && !(year === expectedYear - 1 && day.date.slice(5, 7) === '12'))
      return undefined
    dates.add(day.date)
    days.push({ date: day.date, isOffDay: day.isOffDay })
  }
  if (!days.some((day) => day.date.startsWith(`${expectedYear}-`))) return undefined
  return { year: expectedYear, papers, days }
}

export function intersectWorkWindows(
  start: number,
  end: number,
  windows: WorkWindow[]
): WorkWindow[] {
  return windows
    .map((window) => ({ start: Math.max(start, window.start), end: Math.min(end, window.end) }))
    .filter((window) => window.end > window.start)
}
