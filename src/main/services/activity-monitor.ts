import {
  ACTIVITY_CHECKPOINT_MS,
  ACTIVITY_PROTOCOL_VERSION,
  ACTIVITY_SAMPLE_MS,
  type ActivityDay,
  type ActivityLive
} from '../../shared/activity.ts'
import { ActivityRecorder, type ActivitySample } from '../../shared/activity-recorder.ts'
import {
  DAY_MS,
  intersectWorkWindows,
  recentWorkDates,
  workDateKey,
  workDayStart
} from '../../shared/work-time.ts'
import { ActivityStore } from './activity-store.ts'
import { WorkCalendarService } from './work-calendar.ts'

export interface ActivityMonitorConfig {
  team: string
  peerId: string
  nickname: string
  enabled: boolean
}

interface MonitorOptions {
  store: ActivityStore
  calendar: WorkCalendarService
  readInput: () => Pick<ActivitySample, 'idleSeconds' | 'kind'>
  now?: () => number
  monotonic?: () => number
}

export class ActivityMonitor {
  private readonly options: MonitorOptions
  private config: ActivityMonitorConfig | undefined
  private recorder: ActivityRecorder | undefined
  private timer: NodeJS.Timeout | undefined
  private override: 'locked' | 'suspended' | undefined
  private suspendedAt: number | undefined
  private lastSavedAt = 0
  private liveState: ActivityLive = { state: 'disabled', enabled: false, observedAt: 0 }

  constructor(options: MonitorOptions) {
    this.options = options
  }

  configure(config: ActivityMonitorConfig): void {
    if (
      this.config?.team === config.team &&
      this.config.peerId === config.peerId &&
      this.config.enabled === config.enabled &&
      this.config.nickname === config.nickname
    )
      return
    this.finishRecorder(this.now())
    this.clearTimer()
    this.override = undefined
    this.config = { ...config }
    this.recorder = undefined
    this.suspendedAt = undefined
    this.lastSavedAt = 0
    this.tick()
  }

  getLive(): ActivityLive {
    return { ...this.liveState }
  }

  tick(now = this.now()): void {
    this.clearTimer()
    const config = this.config
    if (!config?.enabled || !config.team) {
      this.liveState = { state: 'disabled', enabled: false, observedAt: now }
      return
    }
    const date = workDateKey(now)
    const status = this.options.calendar.getStatus(date)
    const window = status.windows.find((item) => now >= item.start && now < item.end)
    if (!window || !status.available) {
      this.finishRecorder(now)
      const stored = this.options.store.get(config.team, config.peerId, date)?.day
      if (stored && stored.observedAt > now) {
        this.recorder = new ActivityRecorder(stored)
        this.finishRecorder(now)
      }
      this.liveState = {
        state: status.available ? 'outside-work' : 'calendar-unavailable',
        enabled: true,
        observedAt: now
      }
      this.schedule(
        status.windows.find((item) => item.start > now)?.start ?? workDayStart(date) + DAY_MS
      )
      return
    }
    try {
      this.observeWork(now, date, status.version)
    } catch (error) {
      this.report(error)
      this.liveState = { state: 'unknown', enabled: true, observedAt: now }
    }
    if (this.override !== 'suspended') this.schedule(Math.min(now + ACTIVITY_SAMPLE_MS, window.end))
  }

  async systemEvent(event: 'lock' | 'unlock' | 'suspend' | 'resume'): Promise<void> {
    if (!this.config?.enabled || !this.config.team) return
    const now = this.now()
    if (event === 'suspend') {
      this.override = 'suspended'
      this.suspendedAt = now
      this.tick(now)
      await this.persistCurrent(now)
      return
    }
    let sleepWrite: Promise<void> | undefined
    if (event === 'resume') {
      this.finishRecorder(now)
      if (this.suspendedAt !== undefined)
        sleepWrite = this.recordConfirmedSleep(this.suspendedAt, now)
      this.suspendedAt = undefined
      this.override = undefined
      this.recorder = undefined
    } else {
      // 先清除/设置系统覆盖，再采样一次，避免解锁时同一时间戳重复采样导致假缺口。
      this.override = event === 'lock' ? 'locked' : undefined
    }
    // 状态与补记先同步更新；存储已有写入队列，慢磁盘不能延后解锁边界。
    this.tick(now)
    await Promise.all([sleepWrite, this.persistCurrent(now)])
  }

  async stop(): Promise<void> {
    const now = this.now()
    this.clearTimer()
    this.finishRecorder(now)
    this.config = undefined
    this.override = undefined
    this.suspendedAt = undefined
    this.liveState = { state: 'disabled', enabled: false, observedAt: now }
    await this.options.store.flush()
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private observeWork(now: number, date: string, calendarVersion: string): void {
    const config = this.config!
    if (this.recorder?.date !== date) {
      this.finishRecorder(now)
      const stored = this.options.store.get(config.team, config.peerId, date)?.day
      this.recorder = new ActivityRecorder(stored ?? this.createDay(date, now, calendarVersion))
    }
    const status = this.options.calendar.getStatus(date)
    let input: Pick<ActivitySample, 'idleSeconds' | 'kind' | 'inputIssue'>
    try {
      input = this.override ? { kind: this.override, idleSeconds: 0 } : this.options.readInput()
    } catch {
      input = { kind: 'unknown', idleSeconds: 0, inputIssue: 'input-read-failed' }
    }
    this.recorder.setNickname(config.nickname.slice(0, 100))
    const observed = this.recorder.observe(
      { ...input, now, monotonic: (this.options.monotonic ?? (() => performance.now()))() },
      status.windows
    )
    this.options.store.stage(observed, this.validationTime(observed))
    this.liveState = this.recorder.live()
    if (now < this.lastSavedAt || now - this.lastSavedAt >= ACTIVITY_CHECKPOINT_MS) {
      this.lastSavedAt = now
      void this.options.store
        .save(observed, this.validationTime(observed))
        .catch((error: unknown) => this.report(error))
    }
  }

  private createDay(date: string, now: number, calendarVersion: string): ActivityDay {
    const config = this.config!
    return {
      version: ACTIVITY_PROTOCOL_VERSION,
      team: config.team,
      peerId: config.peerId,
      nickname: config.nickname.slice(0, 100),
      date,
      revision: 1,
      calendarVersion,
      observedAt: now,
      intervals: [],
      incomplete: false
    }
  }

  private finishRecorder(now: number): void {
    if (!this.recorder) return
    const day = this.recorder.finish(now)
    this.recorder = undefined
    try {
      this.options.store.stage(day, this.validationTime(day))
      void this.options.store
        .save(day, this.validationTime(day))
        .catch((error: unknown) => this.report(error))
    } catch (error) {
      this.report(error)
    }
  }

  private async persistCurrent(now = this.now()): Promise<void> {
    if (!this.config) return
    const day = this.options.store.get(this.config.team, this.config.peerId, workDateKey(now))?.day
    if (day)
      await this.options.store
        .save(day, this.validationTime(day))
        .catch((error: unknown) => this.report(error))
  }

  private async recordConfirmedSleep(start: number, end: number): Promise<void> {
    if (!this.config || end <= start) return
    const config = this.config
    const writes: Promise<unknown>[] = []
    for (const date of recentWorkDates(end).reverse()) {
      const status = this.options.calendar.getStatus(date)
      const ranges = intersectWorkWindows(start, end, status.windows)
      if (!ranges.length) continue
      const day =
        this.options.store.get(config.team, config.peerId, date)?.day ??
        this.createDay(date, ranges[0].start, status.version)
      let changed = false
      for (const range of ranges) {
        const clippedStart = Math.max(range.start, day.intervals.at(-1)?.end ?? range.start)
        if (range.end <= clippedStart) continue
        day.intervals.push({ start: clippedStart, end: range.end, kind: 'suspended' })
        day.observedAt = Math.max(day.observedAt, range.end)
        changed = true
      }
      if (!changed) continue
      day.revision++
      this.options.store.stage(day, this.validationTime(day))
      writes.push(
        this.options.store
          .save(day, this.validationTime(day))
          .catch((error: unknown) => this.report(error))
      )
    }
    await Promise.all(writes)
  }

  private validationTime(day: ActivityDay): number {
    // 跨日回拨仍须保存其他日期的观测；远端数据继续按当前时间校验。
    return Math.max(this.now(), day.observedAt)
  }

  private schedule(at: number): void {
    // 非工作时段最多每分钟检查时段/日历，不读取输入，也不生成活动记录。
    const delay = Math.max(1, Math.min(at - this.now(), ACTIVITY_CHECKPOINT_MS * 2))
    this.timer = setTimeout(() => this.tick(), delay)
    this.timer.unref()
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  private report(error: unknown): void {
    this.options.store.issues.add(
      `活动采集不完整：${error instanceof Error ? error.message : String(error)}`
    )
  }
}
