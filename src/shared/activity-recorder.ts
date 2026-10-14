import {
  ACTIVITY_SAMPLE_MS,
  MIN_IDLE_THRESHOLD_MINUTES,
  appendActivityInterval,
  type ActivityDay,
  type ActivityKind,
  type ActivityLive
} from './activity.ts'
import { MINUTE_MS, type WorkWindow } from './work-time.ts'

const MAX_SAMPLE_GAP_MS = ACTIVITY_SAMPLE_MS * 3
const CLOCK_TOLERANCE_MS = 2_000

export interface ActivitySample {
  now: number
  monotonic: number
  idleSeconds: number
  kind: Exclude<ActivityKind, 'active'>
}

/** 只计算已观测的工作区间，不从系统idle值倒推应用启动前的记录。 */
export class ActivityRecorder {
  private readonly day: ActivityDay
  private previous: ActivitySample | undefined
  private window: WorkWindow | undefined
  private idleSince: number | undefined

  constructor(day: ActivityDay) {
    this.day = structuredClone(day)
  }

  get date(): string {
    return this.day.date
  }

  observe(sample: ActivitySample, windows: WorkWindow[]): ActivityDay {
    const window = windows.find((item) => sample.now >= item.start && sample.now < item.end)
    if (!window) return this.finish(sample.now)
    if (this.window?.start !== window.start) this.finish(this.window?.end ?? sample.now)
    this.window = window
    if (this.previous) this.recordSampleRange(sample)
    if (!Number.isFinite(sample.idleSeconds) || sample.idleSeconds < 0)
      sample = { ...sample, kind: 'unknown' }
    if (sample.kind !== 'idle') this.finalizeIdle()
    if (sample.kind === 'idle' && this.idleSince === undefined) this.idleSince = sample.now
    if (!this.previous && sample.kind === 'idle' && sample.idleSeconds === 0)
      this.recordInput(sample.now)
    this.previous = { ...sample }
    this.day.observedAt = Math.max(this.day.observedAt, sample.now)
    this.day.revision++
    return this.snapshot()
  }

  finish(now: number): ActivityDay {
    if (this.previous && this.window) {
      this.day.revision++
      const end = Math.min(now, this.window.end)
      if (end > this.previous.now) {
        const elapsed = end - this.previous.now
        const knownAbsence = this.previous.kind === 'locked' || this.previous.kind === 'suspended'
        const kind = elapsed <= MAX_SAMPLE_GAP_MS || knownAbsence ? this.previous.kind : 'unknown'
        this.append(this.previous.now, end, kind)
        this.day.observedAt = Math.max(this.day.observedAt, end)
      }
    }
    this.finalizeIdle()
    this.previous = undefined
    this.window = undefined
    return this.snapshot()
  }

  snapshot(): ActivityDay {
    return structuredClone(this.day)
  }

  setMetadata(nickname: string, calendarVersion: string): void {
    if (this.day.nickname === nickname && this.day.calendarVersion === calendarVersion) return
    this.day.nickname = nickname
    this.day.calendarVersion = calendarVersion
    this.day.revision++
  }

  live(): ActivityLive {
    return {
      observedAt: this.day.observedAt,
      enabled: true,
      state: this.previous?.kind ?? 'outside-work',
      idleSince: this.previous?.kind === 'idle' ? this.idleSince : undefined,
      lastInputAt: this.day.lastInputAt
    }
  }

  private recordSampleRange(sample: ActivitySample): void {
    const previous = this.previous!
    const elapsed = sample.now - previous.now
    // 恢复和解锁可能发生在同一毫秒；只更新状态，不能把零长度转换当作观测缺口。
    if (elapsed === 0) return
    if (elapsed < 0) {
      this.day.incomplete = true
      this.finalizeIdle()
      return
    }
    const knownAbsence = previous.kind === 'locked' || previous.kind === 'suspended'
    const clockGap =
      Math.abs(elapsed - (sample.monotonic - previous.monotonic)) > CLOCK_TOLERANCE_MS
    if (
      (!knownAbsence && elapsed > MAX_SAMPLE_GAP_MS) ||
      (clockGap && previous.kind !== 'suspended')
    ) {
      this.finalizeIdle()
      this.append(previous.now, sample.now, 'unknown')
      return
    }
    if (previous.kind !== 'idle') {
      this.append(previous.now, sample.now, previous.kind)
      return
    }
    if (
      sample.kind === 'unknown' ||
      !Number.isFinite(sample.idleSeconds) ||
      sample.idleSeconds < 0
    ) {
      this.finalizeIdle()
      this.append(previous.now, sample.now, 'unknown')
      return
    }
    const inputAt = sample.now - sample.idleSeconds * 1_000
    if (sample.kind === 'idle' && inputAt > previous.now && inputAt <= sample.now) {
      this.append(previous.now, inputAt, 'idle')
      this.finalizeIdle()
      this.recordInput(inputAt)
      this.idleSince = inputAt
      this.append(inputAt, sample.now, 'idle', false)
      return
    }
    this.append(previous.now, sample.now, 'idle')
  }

  private recordInput(now: number): void {
    this.day.firstInputAt ??= now
    this.day.lastInputAt = now
  }

  private append(start: number, end: number, kind: ActivityKind, merge = true): void {
    const clippedStart = Math.max(
      start,
      this.window?.start ?? start,
      this.day.intervals.at(-1)?.end ?? start
    )
    const clippedEnd = Math.min(end, this.window?.end ?? end)
    if (clippedEnd <= clippedStart) return
    const sameIdle = kind !== 'idle' || this.day.intervals.at(-1)?.start === this.idleSince
    appendActivityInterval(
      this.day.intervals,
      { start: clippedStart, end: clippedEnd, kind },
      merge && sameIdle
    )
    if (kind === 'unknown') this.day.incomplete = true
  }

  private finalizeIdle(): void {
    const last = this.day.intervals.at(-1)
    // 1分钟是最小可设阈值；更短且已结束的候选区间可合并，不影响任何合法阈值重算。
    if (last?.kind === 'idle' && last.end - last.start < MIN_IDLE_THRESHOLD_MINUTES * MINUTE_MS) {
      last.kind = 'active'
      const previous = this.day.intervals.at(-2)
      if (previous?.kind === 'active' && previous.end === last.start) {
        previous.end = last.end
        this.day.intervals.pop()
      }
    }
    this.idleSince = undefined
  }
}
