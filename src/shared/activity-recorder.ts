import {
  ACTIVITY_SAMPLE_MS,
  ACTIVITY_MAX_DIAGNOSTICS,
  MIN_IDLE_THRESHOLD_MINUTES,
  appendActivityInterval,
  type ActivityDay,
  type ActivityDiagnostic,
  type ActivityDiagnosticCode,
  type ActivityKind,
  type ActivityLive
} from './activity.ts'
import { MINUTE_MS, workDateKey, type WorkWindow } from './work-time.ts'

const MAX_SAMPLE_GAP_MS = ACTIVITY_SAMPLE_MS * 3
const CLOCK_TOLERANCE_MS = 2_000

export interface ActivitySample {
  now: number
  monotonic: number
  idleSeconds: number
  kind: Exclude<ActivityKind, 'active'>
  inputIssue?: 'input-read-failed' | 'input-unavailable'
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
    this.resetAfterClockRollback(sample.now)
    const window = windows.find((item) => sample.now >= item.start && sample.now < item.end)
    if (!window) return this.finish(sample.now)
    if (this.window?.start !== window.start) this.finish(this.window?.end ?? sample.now)
    this.window = window
    if (!Number.isFinite(sample.idleSeconds) || sample.idleSeconds < 0)
      sample = { ...sample, kind: 'unknown', inputIssue: 'input-unavailable' }
    if (this.previous) this.recordSampleRange(sample)
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
    this.resetAfterClockRollback(now)
    if (this.previous && this.window) {
      this.day.revision++
      const end = Math.min(now, this.window.end)
      if (end > this.previous.now) {
        const elapsed = end - this.previous.now
        const knownAbsence = this.previous.kind === 'locked' || this.previous.kind === 'suspended'
        const kind = elapsed <= MAX_SAMPLE_GAP_MS || knownAbsence ? this.previous.kind : 'unknown'
        if (kind === 'unknown') {
          const code =
            this.previous.kind === 'unknown'
              ? (this.previous.inputIssue ?? 'input-unavailable')
              : 'sample-gap'
          this.recordUnknown(this.previous.now, end, code)
        } else this.append(this.previous.now, end, kind)
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

  setNickname(nickname: string): void {
    if (this.day.nickname === nickname) return
    // 日历版本保留首批记录的采集口径，不能用当前日历重新标记历史。
    this.day.nickname = nickname
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
    const knownAbsence = previous.kind === 'locked' || previous.kind === 'suspended'
    const clockGap =
      Math.abs(elapsed - (sample.monotonic - previous.monotonic)) > CLOCK_TOLERANCE_MS
    if (
      (!knownAbsence && elapsed > MAX_SAMPLE_GAP_MS) ||
      (clockGap && previous.kind !== 'suspended')
    ) {
      this.finalizeIdle()
      this.recordUnknown(previous.now, sample.now, clockGap ? 'clock-change' : 'sample-gap')
      return
    }
    if (previous.kind !== 'idle') {
      if (previous.kind === 'unknown')
        this.recordUnknown(previous.now, sample.now, previous.inputIssue ?? 'input-unavailable')
      else this.append(previous.now, sample.now, previous.kind)
      return
    }
    if (
      sample.kind === 'unknown' ||
      !Number.isFinite(sample.idleSeconds) ||
      sample.idleSeconds < 0
    ) {
      this.finalizeIdle()
      this.recordUnknown(previous.now, sample.now, sample.inputIssue ?? 'input-unavailable')
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

  private append(
    start: number,
    end: number,
    kind: ActivityKind,
    merge = true
  ): WorkWindow | undefined {
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
    if (kind !== 'unknown') return
    this.day.incomplete = true
    return { start: clippedStart, end: clippedEnd }
  }

  private recordUnknown(start: number, end: number, code: ActivityDiagnosticCode): void {
    const range = this.append(start, end, 'unknown')
    if (range) this.recordDiagnostic({ code, at: range.end, ...range })
  }

  private recordDiagnostic(diagnostic: ActivityDiagnostic): void {
    this.day.incomplete = true
    const diagnostics = (this.day.diagnostics ??= [])
    const previous = diagnostics.at(-1)
    if (
      previous?.code === diagnostic.code &&
      previous.start !== undefined &&
      diagnostic.start !== undefined &&
      previous.end === diagnostic.start
    ) {
      previous.end = diagnostic.end
      previous.at = diagnostic.at
    } else if (diagnostics.length < ACTIVITY_MAX_DIAGNOSTICS) diagnostics.push(diagnostic)
  }

  private resetAfterClockRollback(now: number): void {
    if (now >= (this.previous?.now ?? this.day.observedAt)) return
    const sameDate = workDateKey(now) === this.day.date
    if (!sameDate && !this.previous) return
    if (sameDate) this.rewindDay(now)
    // 跨日回拨锚定最后有效观测点，不向旧日报写入其他日期的时间。
    const at = sameDate ? now : this.day.observedAt
    this.recordDiagnostic({ code: 'clock-change', at })
    this.finalizeIdle()
    this.previous = undefined
    this.window = undefined
    this.day.revision++
  }

  private rewindDay(now: number): void {
    // 重复的墙钟时间不能沿用旧状态，否则会挡住回拨后的新采样。
    this.day.intervals = this.day.intervals
      .filter((interval) => interval.start < now)
      .map((interval) => ({ ...interval, end: Math.min(interval.end, now) }))
    this.day.diagnostics = this.day.diagnostics?.flatMap((diagnostic) => {
      if (diagnostic.start === undefined) return diagnostic.at <= now ? [diagnostic] : []
      if (diagnostic.start >= now) return []
      return [
        { ...diagnostic, at: Math.min(diagnostic.at, now), end: Math.min(diagnostic.end!, now) }
      ]
    })
    if (this.day.firstInputAt !== undefined && this.day.firstInputAt > now)
      this.day.firstInputAt = undefined
    if (this.day.lastInputAt !== undefined && this.day.lastInputAt > now)
      this.day.lastInputAt = undefined
    this.day.observedAt = now
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
