import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import seed from '../../../resources/holidays/2026.json' with { type: 'json' }
import {
  DAY_MS,
  MINUTE_MS,
  calendarWorkWindows,
  isCalendarWorkday,
  parseHolidayCalendar,
  workDateKey,
  type HolidayCalendar
} from '../../shared/work-time.ts'
import type { WorkCalendarStatus } from '../../shared/activity.ts'
import { writeAtomicJson } from './activity-store.ts'

export const HOLIDAY_SOURCE = 'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master'
const CALENDAR_TIMEOUT_MS = 10_000
const CALENDAR_MAX_BYTES = 256 * 1024
const CALENDAR_RETRY_DELAY_MS = 5 * MINUTE_MS
const CACHE_VERSION = 1

export async function fetchHolidayYear(
  year: number,
  fetcher: typeof fetch = fetch
): Promise<HolidayCalendar | undefined> {
  const response = await fetcher(`${HOLIDAY_SOURCE}/${year}.json`, {
    signal: AbortSignal.timeout(CALENDAR_TIMEOUT_MS)
  })
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`日历请求失败（HTTP ${response.status}）`)
  const reader = response.body?.getReader()
  if (!reader) throw new Error('日历响应为空')
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > CALENDAR_MAX_BYTES) throw new Error('日历响应超出大小限制')
      chunks.push(chunk.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return parseHolidayCalendar(JSON.parse(Buffer.concat(chunks).toString('utf8')), year)
}

export class WorkCalendarService {
  private readonly filePath: string
  private readonly fetcher: typeof fetch
  private readonly now: () => number
  private readonly calendars = new Map<number, HolidayCalendar>()
  private checkedAt: number | undefined
  private checkedYear: number | undefined
  private retryAt: number | undefined
  private retryYear: number | undefined
  private pending: Promise<void> | undefined
  private error: string | undefined

  constructor(directory: string, fetcher: typeof fetch = fetch, now = Date.now) {
    this.filePath = path.join(directory, 'calendar.json')
    this.fetcher = fetcher
    this.now = now
    const bundled = parseHolidayCalendar(seed, seed.year)
    if (bundled) this.calendars.set(bundled.year, bundled)
  }

  async initialize(): Promise<void> {
    try {
      const stat = await fs.stat(this.filePath)
      if (stat.size > CALENDAR_MAX_BYTES) throw new Error('日历缓存超出大小限制')
      const saved = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as {
        version?: number
        calendars?: unknown[]
        checkedAt?: number
        checkedYear?: number
        retryAt?: number
        retryYear?: number
      }
      if (
        saved.version !== CACHE_VERSION ||
        !Array.isArray(saved.calendars) ||
        saved.calendars.length > 5
      )
        throw new Error('日历缓存格式无效')
      const parsed = saved.calendars.map((value) =>
        parseHolidayCalendar(value, Number((value as HolidayCalendar)?.year))
      )
      if (parsed.some((value) => !value)) throw new Error('日历缓存内容无效')
      for (const calendar of parsed) if (calendar) this.calendars.set(calendar.year, calendar)
      if (Number.isFinite(saved.checkedAt)) this.checkedAt = saved.checkedAt
      if (Number.isInteger(saved.checkedYear)) this.checkedYear = saved.checkedYear
      if (Number.isFinite(saved.retryAt) && Number.isInteger(saved.retryYear)) {
        this.retryAt = saved.retryAt
        this.retryYear = saved.retryYear
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        this.error = `日历缓存读取失败：${error instanceof Error ? error.message : String(error)}`
    }
  }

  getStatus(date: string): WorkCalendarStatus {
    const values = [...this.calendars.values()]
    const year = Number(date.slice(0, 4))
    const available = this.calendars.has(year)
    const relevant = values
      .filter((item) => Math.abs(item.year - year) <= 1)
      .sort((left, right) => left.year - right.year)
    const version = createHash('sha256').update(JSON.stringify(relevant)).digest('hex').slice(0, 16)
    return {
      year,
      available,
      isWorkday: isCalendarWorkday(date, values),
      windows: calendarWorkWindows(date, values),
      version,
      papers: [...new Set(relevant.flatMap((item) => item.papers))],
      lastCheckedAt: this.checkedAt,
      updating: this.pending !== undefined,
      error: this.error
    }
  }

  refresh(force = false): Promise<void> {
    if (this.pending) return this.pending
    const now = this.now()
    const year = Number(workDateKey(now).slice(0, 4))
    const retryRemaining = this.retryYear === year ? (this.retryAt ?? 0) - now : 0
    const retryPending = retryRemaining > 0 && retryRemaining <= CALENDAR_RETRY_DELAY_MS
    const retryDue = this.retryYear === year && !retryPending
    const yearChanged =
      (this.checkedYear !== undefined && this.checkedYear !== year) ||
      (this.retryYear !== undefined && this.retryYear !== year)
    if (!force && retryPending) return Promise.resolve()
    if (
      !force &&
      !retryDue &&
      !yearChanged &&
      this.checkedYear === year &&
      this.checkedAt !== undefined &&
      this.checkedAt <= now &&
      now - this.checkedAt < DAY_MS
    )
      return Promise.resolve()
    this.pending = this.updateYears(year).finally(() => {
      this.pending = undefined
    })
    return this.pending
  }

  async flush(): Promise<void> {
    await this.pending
  }

  private async updateYears(year: number): Promise<void> {
    const failures: string[] = []
    for (const target of [year, year + 1, year - 1]) {
      try {
        const calendar = await fetchHolidayYear(target, this.fetcher)
        if (calendar) this.calendars.set(target, calendar)
        else if (target === year) failures.push(`${year}年节假日数据尚未就绪`)
      } catch (error) {
        failures.push(`${target}年：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const checkedAt = this.now()
    if (failures.length) {
      this.retryAt = checkedAt + CALENDAR_RETRY_DELAY_MS
      this.retryYear = year
    } else {
      this.checkedAt = checkedAt
      this.checkedYear = year
      this.retryAt = undefined
      this.retryYear = undefined
    }
    for (const key of this.calendars.keys())
      if (Math.abs(key - year) > 1) this.calendars.delete(key)
    this.error = failures.length ? failures.join('；') : undefined
    try {
      await writeAtomicJson(this.filePath, {
        version: CACHE_VERSION,
        calendars: [...this.calendars.values()],
        checkedAt: this.checkedAt,
        checkedYear: this.checkedYear,
        retryAt: this.retryAt,
        retryYear: this.retryYear
      })
    } catch (error) {
      this.error = `日历缓存保存失败：${error instanceof Error ? error.message : String(error)}`
    }
  }
}
