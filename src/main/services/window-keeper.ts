import type {
  RateLimitWindowSnapshot,
  UsageSnapshot,
  WindowKeeperPersistedState,
  WindowKeeperStatus
} from '../../shared/capsule'
import {
  createCodexCliRunner,
  type CodexCliRequest,
  type CodexCliRunner
} from './window-keeper-runner.ts'

export const WINDOW_KEEPER_TRIGGER_BUFFER_MS = 10_000
export const WINDOW_KEEPER_MAX_RETRY_DURATION_MS = 10 * 60 * 1000
export const WINDOW_KEEPER_VERIFY_DELAY_MS = 60_000
export const RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 240_000, 480_000] as const

const FIVE_HOUR_WINDOW_MINUTES = 5 * 60
const WEEKLY_WINDOW_MIN_MINUTES = 1440
const CLI_TIMEOUT_MS = 60_000
const CODEX_CLI_REQUEST: CodexCliRequest = {
  model: 'gpt-5.6-luna',
  reasoningEffort: 'low',
  prompt: '6'
}

export interface WindowKeeperOptions {
  enabled: boolean
  persisted?: WindowKeeperPersistedState
  runner?: CodexCliRunner
  onRefresh: () => Promise<UsageSnapshot | void>
  onStatusChange?: (status: WindowKeeperStatus) => void
  onPersistenceChange?: (state: WindowKeeperPersistedState) => void
  onExhausted?: (error: string) => void
  now?: () => number
  setTimeout?: (callback: () => void, delayMs: number) => unknown
  clearTimeout?: (timer: unknown) => void
}

export type WindowKeeperPlan =
  | {
      kind: 'wait-data'
    }
  | {
      kind: 'waiting-weekly-reset'
      windowId: string
      resetAt: string
      triggerAtMs: number
      delayMs: number
    }
  | {
      kind: 'wait-start' | 'observe'
      windowId: string
      cycleKey: string
      triggerAtMs: number
      delayMs: number
    }
  | {
      kind: 'wait-reset'
      windowId: string
      resetAt: string
      triggerAtMs: number
      delayMs: number
    }
  | {
      kind: 'skip'
      reason: 'not-eligible'
      windowId?: string
      resetAt?: string
    }

interface TimerApi {
  now: () => number
  setTimeout: (callback: () => void, delayMs: number) => unknown
  clearTimeout: (timer: unknown) => void
}

interface ActiveEvent {
  key: string
  windowId: string
  resetAt?: string
  triggerAtMs: number
  deadlineAtMs: number
  retryIndex: number
  lastError?: string
  timer?: unknown
  timerEndsEvent: boolean
  controller?: AbortController
  running: boolean
  verifying: boolean
  triggeredAt?: string
  verificationResetAt?: string
  observing?: boolean
  requesting?: boolean
}

export function getFiveHourWindow(snapshot: UsageSnapshot): RateLimitWindowSnapshot | undefined {
  return snapshot.rateLimits.find(
    (windowState) => windowState.windowMinutes === FIVE_HOUR_WINDOW_MINUTES
  )
}

function getExhaustedWeeklyWindow(snapshot: UsageSnapshot): RateLimitWindowSnapshot | undefined {
  return snapshot.rateLimits.find((windowState) => {
    if ((windowState.windowMinutes ?? 0) < WEEKLY_WINDOW_MIN_MINUTES) {
      return false
    }
    const remainingExhausted =
      windowState.remainingPercent !== undefined &&
      Number.isFinite(windowState.remainingPercent) &&
      windowState.remainingPercent <= 0
    const usedExhausted =
      windowState.usedPercent !== undefined &&
      Number.isFinite(windowState.usedPercent) &&
      windowState.usedPercent >= 100
    return remainingExhausted || usedExhausted
  })
}

export function calculateWindowKeeperPlan(
  snapshot: UsageSnapshot,
  nowMs: number,
  persisted: WindowKeeperPersistedState | undefined
): WindowKeeperPlan {
  if (!snapshot.generatedAt) {
    return { kind: 'wait-data' }
  }

  const windowState = getFiveHourWindow(snapshot)
  if (snapshot.authMode !== 'chatgpt' || !windowState) {
    return {
      kind: 'skip',
      reason: 'not-eligible',
      windowId: windowState?.id,
      resetAt: windowState?.resetsAt
    }
  }

  const weeklyWindow =
    snapshot.rateLimitSource === 'official' ? getExhaustedWeeklyWindow(snapshot) : undefined
  if (weeklyWindow) {
    const weeklyResetAtMs = weeklyWindow.resetsAt ? Date.parse(weeklyWindow.resetsAt) : NaN
    if (!weeklyWindow.resetsAt || !Number.isFinite(weeklyResetAtMs)) {
      return { kind: 'wait-data' }
    }
    const triggerAtMs =
      weeklyResetAtMs > nowMs
        ? weeklyResetAtMs + WINDOW_KEEPER_TRIGGER_BUFFER_MS
        : nowMs + WINDOW_KEEPER_TRIGGER_BUFFER_MS
    return {
      kind: 'waiting-weekly-reset',
      windowId: weeklyWindow.id,
      resetAt: weeklyWindow.resetsAt,
      triggerAtMs,
      delayMs: Math.max(0, triggerAtMs - nowMs)
    }
  }

  const resetAt = windowState.resetsAt
  const resetAtMs = parseTimestamp(resetAt)
  if (snapshot.rateLimitSource !== 'official' || !resetAt || resetAtMs === undefined) {
    return { kind: 'wait-data' }
  }
  if (resetAtMs <= nowMs) {
    return {
      kind: 'wait-start',
      windowId: windowState.id,
      // 同一窗口在等待到期前后必须共用事件键，失败后不能被轮询重新开启。
      cycleKey: createEventKey(windowState.id, resetAt),
      triggerAtMs: nowMs + WINDOW_KEEPER_TRIGGER_BUFFER_MS,
      delayMs: WINDOW_KEEPER_TRIGGER_BUFFER_MS
    }
  }
  if (!isSamePersistedEvent(windowState.id, resetAt, persisted)) {
    return {
      kind: 'observe',
      windowId: windowState.id,
      cycleKey: `${windowState.id}:observe:${persisted?.resetAt ?? 'initial'}`,
      triggerAtMs: nowMs + WINDOW_KEEPER_VERIFY_DELAY_MS,
      delayMs: WINDOW_KEEPER_VERIFY_DELAY_MS
    }
  }
  const triggerAtMs = resetAtMs + WINDOW_KEEPER_TRIGGER_BUFFER_MS
  return {
    kind: 'wait-reset',
    windowId: windowState.id,
    resetAt,
    triggerAtMs,
    delayMs: triggerAtMs - nowMs
  }
}

export class WindowKeeper {
  private readonly runner: CodexCliRunner
  private readonly onRefresh: () => Promise<UsageSnapshot | void>
  private readonly onStatusChange?: (status: WindowKeeperStatus) => void
  private readonly onPersistenceChange?: (state: WindowKeeperPersistedState) => void
  private readonly onExhausted?: (error: string) => void
  private readonly timer: TimerApi
  private observedWindow: WindowKeeperPersistedState | undefined
  private persisted: WindowKeeperPersistedState
  private enabled: boolean
  private stopped = false
  private snapshot: UsageSnapshot | undefined
  private activeEvent: ActiveEvent | undefined
  private weeklyTimer: { key: string; handle: unknown } | undefined
  private finishedEventKey: string | undefined
  private status: WindowKeeperStatus

  constructor(options: WindowKeeperOptions) {
    this.runner = options.runner ?? createCodexCliRunner()
    this.onRefresh = options.onRefresh
    this.onStatusChange = options.onStatusChange
    this.onPersistenceChange = options.onPersistenceChange
    this.onExhausted = options.onExhausted
    this.persisted = { ...options.persisted }
    this.enabled = options.enabled
    this.timer = {
      now: options.now ?? Date.now,
      setTimeout: options.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs)),
      clearTimeout: options.clearTimeout ?? ((timer) => clearTimeout(timer as NodeJS.Timeout))
    }
    this.status = {
      state: this.enabled ? 'waiting-data' : 'disabled',
      lastTriggeredAt: this.persisted.verified === true ? this.persisted.lastTriggeredAt : undefined
    }
    this.emitStatus()
  }

  getStatus(): WindowKeeperStatus {
    return { ...this.status }
  }

  setEnabled(enabled: boolean): void {
    if (this.stopped) {
      return
    }
    if (this.enabled === enabled) {
      return
    }
    this.enabled = enabled
    this.cancelActiveEvent()
    this.cancelWeeklyTimer()
    this.finishedEventKey = undefined
    if (!enabled) {
      this.setStatus({
        state: 'disabled',
        nextActionAt: undefined,
        recentError: undefined
      })
      return
    }
    this.reconcile()
  }

  updateSnapshot(snapshot: UsageSnapshot): void {
    if (this.stopped) {
      return
    }
    this.snapshot = snapshot
    if (this.enabled && this.activeEvent?.verifying !== true) {
      this.reconcile()
    }
  }

  stop(): void {
    this.stopped = true
    this.cancelActiveEvent()
    this.cancelWeeklyTimer()
  }

  private reconcile(): void {
    if (!this.snapshot) {
      this.cancelActiveEvent()
      this.cancelWeeklyTimer()
      this.setStatus({
        state: 'waiting-data',
        nextActionAt: undefined,
        recentError: undefined
      })
      return
    }

    const plan = calculateWindowKeeperPlan(
      this.snapshot,
      this.timer.now(),
      this.observedWindow ?? this.persisted
    )
    if (plan.kind === 'wait-data') {
      this.cancelActiveEvent()
      this.cancelWeeklyTimer()
      this.setStatus({
        state: 'waiting-data',
        nextActionAt: undefined,
        recentError: undefined
      })
      return
    }
    if (plan.kind === 'waiting-weekly-reset') {
      this.cancelActiveEvent()
      const weeklyKey = createEventKey(plan.windowId, plan.resetAt)
      if (this.weeklyTimer !== undefined && this.weeklyTimer.key !== weeklyKey) {
        this.cancelWeeklyTimer()
      }
      if (this.weeklyTimer === undefined) {
        const handle = this.timer.setTimeout(() => {
          this.weeklyTimer = undefined
          this.setStatus({
            state: 'waiting-data',
            nextActionAt: undefined,
            recentError: undefined
          })
          void this.onRefresh().catch((error) => {
            if (!this.stopped && this.enabled) {
              this.setStatus({
                state: 'waiting-data',
                recentError: normalizeError(error)
              })
            }
          })
        }, plan.delayMs)
        this.weeklyTimer = {
          key: weeklyKey,
          handle
        }
      }
      this.setStatus({
        state: 'waiting-weekly-reset',
        nextActionAt: new Date(plan.triggerAtMs).toISOString(),
        recentError: undefined
      })
      return
    }

    this.cancelWeeklyTimer()
    if (plan.kind === 'skip') {
      this.cancelActiveEvent()
      this.finishedEventKey = undefined
      this.setStatus({
        state: 'waiting-reset',
        nextActionAt: undefined,
        recentError: undefined
      })
      return
    }

    // 普通同步不能重建进行中的请求或重试，否则会延长本轮截止时间。
    if (this.activeEvent && (this.activeEvent.requesting || this.activeEvent.retryIndex > 0)) {
      return
    }

    const eventKey =
      plan.kind !== 'wait-reset' ? plan.cycleKey : createEventKey(plan.windowId, plan.resetAt)
    if (this.finishedEventKey === eventKey) {
      if (this.status.state === 'error') {
        return
      }
      this.setStatus({
        state: 'waiting-reset',
        nextActionAt: undefined,
        recentError: undefined
      })
      return
    }
    if (this.activeEvent?.key === eventKey) {
      return
    }

    this.cancelActiveEvent()
    this.finishedEventKey = undefined
    this.startEvent(plan, eventKey)
  }

  private startEvent(
    plan: Extract<WindowKeeperPlan, { kind: 'wait-start' | 'observe' | 'wait-reset' }>,
    key: string
  ): void {
    const event: ActiveEvent = {
      key,
      windowId: plan.windowId,
      resetAt: plan.kind === 'wait-reset' ? plan.resetAt : undefined,
      triggerAtMs: plan.triggerAtMs,
      deadlineAtMs: plan.triggerAtMs + WINDOW_KEEPER_MAX_RETRY_DURATION_MS,
      retryIndex: 0,
      timerEndsEvent: false,
      running: false,
      verifying: plan.kind === 'observe',
      observing: plan.kind === 'observe',
      verificationResetAt:
        plan.kind === 'observe' && this.snapshot
          ? getFiveHourWindow(this.snapshot)?.resetsAt
          : undefined
    }
    this.activeEvent = event
    this.scheduleTimer(event, plan.delayMs, false)
    this.setStatus({
      state: plan.kind === 'observe' ? 'verifying' : 'waiting-reset',
      nextActionAt: new Date(plan.triggerAtMs).toISOString(),
      recentError: undefined
    })
  }

  private scheduleTimer(event: ActiveEvent, delayMs: number, endsEvent: boolean): void {
    event.timerEndsEvent = endsEvent
    event.timer = this.timer.setTimeout(
      () => {
        event.timer = undefined
        if (this.activeEvent !== event) {
          return
        }
        if (event.timerEndsEvent) {
          this.finishError(event)
          return
        }
        void (event.observing ? this.observeWindow(event) : this.triggerEvent(event))
      },
      Math.max(0, delayMs)
    )
  }

  private async observeWindow(event: ActiveEvent): Promise<void> {
    if (this.timer.now() >= event.deadlineAtMs) {
      this.finishError(event)
      return
    }
    event.verifying = true
    const snapshot = await this.refreshForEvent(event)
    if (!snapshot || this.activeEvent !== event) return
    const windowState = this.resolveVerificationWindow(event, snapshot)
    if (!windowState) return
    const resetAtMs = parseTimestamp(windowState.resetsAt)
    if (resetAtMs === undefined) {
      this.failVerification(event, 'Official 5h window has no valid reset_at')
      return
    }
    if (resetAtMs > this.timer.now() && windowState.resetsAt === event.verificationResetAt) {
      // 观察确认不代表本工具发送过请求，不改写上次 CLI 成功记录。
      this.observedWindow = {
        windowId: windowState.id,
        resetAt: windowState.resetsAt,
        verified: true
      }
      this.cancelActiveEvent()
      this.reconcile()
      return
    }
    event.observing = false
    event.verifying = false
    event.requesting = true
    this.scheduleTimer(event, WINDOW_KEEPER_TRIGGER_BUFFER_MS, false)
    this.setStatus({
      state: 'waiting-reset',
      nextActionAt: new Date(this.timer.now() + WINDOW_KEEPER_TRIGGER_BUFFER_MS).toISOString()
    })
  }

  private async triggerEvent(event: ActiveEvent): Promise<void> {
    if (this.activeEvent !== event || !this.enabled || this.stopped || event.running) {
      return
    }
    if (this.timer.now() >= event.deadlineAtMs) {
      this.finishError(event)
      return
    }

    event.requesting = true
    event.running = true
    const controller = new AbortController()
    event.controller = controller
    this.setStatus({
      state: 'triggering',
      nextActionAt: undefined,
      recentError: undefined
    })

    try {
      await this.runWithTimeout(controller)
    } catch (error) {
      const timedOut = error instanceof CodexCliTimeoutError
      if (
        this.activeEvent !== event ||
        !this.enabled ||
        this.stopped ||
        (controller.signal.aborted && !timedOut)
      ) {
        return
      }
      event.lastError = normalizeError(error)
      await this.refreshBeforeRetry(event)
      return
    } finally {
      event.running = false
      if (event.controller === controller) {
        event.controller = undefined
      }
    }

    if (this.activeEvent !== event || !this.enabled || this.stopped) {
      return
    }
    await this.beginVerification(event)
  }

  private async beginVerification(event: ActiveEvent): Promise<void> {
    event.verifying = true
    event.triggeredAt = new Date(this.timer.now()).toISOString()
    event.lastError = undefined
    this.setStatus({
      state: 'verifying',
      nextActionAt: undefined,
      recentError: undefined
    })

    const snapshot = await this.refreshForEvent(event)
    if (!snapshot || this.activeEvent !== event) {
      return
    }
    const windowState = this.resolveVerificationWindow(event, snapshot)
    if (!windowState) {
      return
    }
    if (!windowState.resetsAt) {
      this.failVerification(event, 'Official 5h window has no reset_at')
      return
    }

    event.verificationResetAt = windowState.resetsAt
    this.scheduleVerification(event)
  }

  private scheduleVerification(event: ActiveEvent): void {
    const remainingMs = event.deadlineAtMs - this.timer.now()
    if (remainingMs <= 0) {
      this.finishError(event)
      return
    }
    if (remainingMs < WINDOW_KEEPER_VERIFY_DELAY_MS) {
      event.lastError ??= 'Not enough time to verify the official 5h window'
      this.scheduleTimer(event, remainingMs, true)
      this.setStatus({
        state: 'verifying',
        nextActionAt: new Date(event.deadlineAtMs).toISOString(),
        recentError: undefined
      })
      return
    }
    const delayMs = WINDOW_KEEPER_VERIFY_DELAY_MS
    event.timer = this.timer.setTimeout(() => {
      event.timer = undefined
      void this.completeVerification(event)
    }, delayMs)
    this.setStatus({
      state: 'verifying',
      nextActionAt: new Date(this.timer.now() + delayMs).toISOString(),
      recentError: undefined
    })
  }

  private async completeVerification(event: ActiveEvent): Promise<void> {
    if (this.activeEvent !== event || !event.verifying) {
      return
    }
    const snapshot = await this.refreshForEvent(event)
    if (!snapshot || this.activeEvent !== event) {
      return
    }
    const windowState = this.resolveVerificationWindow(event, snapshot)
    if (!windowState) {
      return
    }
    if (!windowState.resetsAt) {
      this.failVerification(event, 'Official 5h window has no reset_at')
      return
    }
    const resetAtMs = parseTimestamp(windowState.resetsAt)
    if (resetAtMs === undefined) {
      this.failVerification(event, 'Official 5h window has no valid reset_at')
      return
    }
    if (resetAtMs <= this.timer.now()) {
      this.failVerification(event, 'Official 5h window was not started')
      return
    }
    if (windowState.resetsAt === event.verificationResetAt) {
      this.finishSuccess(event, windowState)
      return
    }
    // 首次查询可能早于官方记账完成；以新值继续观察，避免重复发送 CLI。
    event.verificationResetAt = windowState.resetsAt
    event.lastError = 'Official 5h window reset_at did not stabilize'
    this.scheduleVerification(event)
  }

  private async refreshForEvent(event: ActiveEvent): Promise<UsageSnapshot | undefined> {
    try {
      const refreshed = await this.onRefresh()
      if (refreshed) {
        this.snapshot = refreshed
      }
      return this.snapshot
    } catch (error) {
      if (this.activeEvent === event) {
        this.failVerification(event, `Quota refresh failed: ${normalizeError(error)}`)
      }
      return undefined
    }
  }

  private resolveVerificationWindow(
    event: ActiveEvent,
    snapshot: UsageSnapshot
  ): RateLimitWindowSnapshot | undefined {
    const plan = calculateWindowKeeperPlan(snapshot, this.timer.now(), this.persisted)
    if (plan.kind === 'waiting-weekly-reset' || plan.kind === 'skip') {
      event.verifying = false
      this.reconcile()
      return undefined
    }
    if (snapshot.rateLimitSource !== 'official') {
      this.failVerification(event, 'Official quota data unavailable')
      return undefined
    }
    const windowState = getFiveHourWindow(snapshot)
    if (!windowState) {
      this.failVerification(event, 'Official 5h window unavailable')
      return undefined
    }
    return windowState
  }

  private failVerification(event: ActiveEvent, error: string): void {
    if (this.activeEvent !== event) {
      return
    }
    event.verifying = false
    event.lastError = error
    this.scheduleRetry(event)
  }

  private async refreshBeforeRetry(event: ActiveEvent): Promise<void> {
    try {
      const refreshed = await this.onRefresh()
      if (refreshed) {
        this.snapshot = refreshed
      }
    } catch {
      // 保留 CLI 原始错误，由现有重试策略处理。
    }
    if (this.activeEvent !== event || !this.enabled || this.stopped) {
      return
    }
    this.reconcile()
    if (this.activeEvent === event) {
      this.scheduleRetry(event)
    }
  }

  private runWithTimeout(controller: AbortController): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false
      let timedOut = false
      const timeout = this.timer.setTimeout(() => {
        timedOut = true
        controller.abort()
        settle(new CodexCliTimeoutError(), true)
      }, CLI_TIMEOUT_MS)
      const onAbort = (): void => {
        if (!timedOut) {
          settle(new Error('Codex CLI cancelled'), false)
        }
      }
      const settle = (error: Error | undefined, failed: boolean): void => {
        if (settled) {
          return
        }
        settled = true
        this.timer.clearTimeout(timeout)
        controller.signal.removeEventListener('abort', onAbort)
        if (failed) {
          reject(error)
        } else {
          resolve()
        }
      }

      controller.signal.addEventListener('abort', onAbort, { once: true })
      let runnerPromise: Promise<void>
      try {
        runnerPromise = this.runner.run(CODEX_CLI_REQUEST, controller.signal)
      } catch (error) {
        settle(new Error(normalizeError(error)), true)
        return
      }
      void runnerPromise.then(
        () => settle(undefined, false),
        (error) => settle(new Error(normalizeError(error)), true)
      )
    })
  }

  private scheduleRetry(event: ActiveEvent): void {
    const nowMs = this.timer.now()
    const remainingMs = event.deadlineAtMs - nowMs
    const retryDelayMs = RETRY_DELAYS_MS[event.retryIndex]
    event.retryIndex += 1
    if (remainingMs <= 0) {
      this.finishError(event)
      return
    }

    if (retryDelayMs === undefined || retryDelayMs >= remainingMs) {
      this.scheduleTimer(event, remainingMs, true)
      this.setStatus({
        state: 'retrying',
        nextActionAt: new Date(event.deadlineAtMs).toISOString(),
        recentError: event.lastError
      })
      return
    }

    this.scheduleTimer(event, retryDelayMs, false)
    this.setStatus({
      state: 'retrying',
      nextActionAt: new Date(nowMs + retryDelayMs).toISOString(),
      recentError: event.lastError
    })
  }

  private finishSuccess(event: ActiveEvent, windowState: RateLimitWindowSnapshot): void {
    const triggeredAt = event.triggeredAt ?? new Date(this.timer.now()).toISOString()
    const nextPersisted: WindowKeeperPersistedState = {
      windowId: event.windowId,
      resetAt: windowState.resetsAt,
      lastTriggeredAt: triggeredAt,
      verified: true
    }
    this.observedWindow = undefined
    this.persisted = nextPersisted
    this.onPersistenceChange?.({ ...this.persisted })
    this.cancelActiveEvent()
    this.finishedEventKey = event.key
    this.setStatus({
      state: 'waiting-data',
      nextActionAt: undefined,
      lastTriggeredAt: triggeredAt,
      recentError: undefined
    })
    this.reconcile()
  }

  private finishError(event: ActiveEvent): void {
    if (this.activeEvent !== event) {
      return
    }
    const error = event.lastError ?? 'Codex CLI failed'
    this.cancelActiveEvent()
    this.finishedEventKey = event.key
    this.setStatus({
      state: 'error',
      nextActionAt: undefined,
      recentError: error
    })
    this.onExhausted?.(error)
  }

  private cancelActiveEvent(): void {
    const event = this.activeEvent
    if (!event) {
      return
    }
    if (event.timer !== undefined) {
      this.timer.clearTimeout(event.timer)
    }
    event.controller?.abort()
    this.activeEvent = undefined
  }

  private cancelWeeklyTimer(): void {
    if (this.weeklyTimer !== undefined) {
      if (this.weeklyTimer.handle !== undefined) {
        this.timer.clearTimeout(this.weeklyTimer.handle)
      }
      this.weeklyTimer = undefined
    }
  }

  private setStatus(patch: Partial<WindowKeeperStatus> & Pick<WindowKeeperStatus, 'state'>): void {
    this.status = {
      ...this.status,
      ...patch,
      lastTriggeredAt: this.persisted.verified === true ? this.persisted.lastTriggeredAt : undefined
    }
    this.emitStatus()
  }

  private emitStatus(): void {
    this.onStatusChange?.(this.getStatus())
  }
}

function createEventKey(windowId: string, resetAt: string): string {
  return `${windowId}:${resetAt}`
}

function isSamePersistedEvent(
  windowId: string,
  resetAt: string,
  persisted: WindowKeeperPersistedState | undefined
): boolean {
  return (
    persisted?.verified === true && persisted.windowId === windowId && persisted.resetAt === resetAt
  )
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) {
    return undefined
  }
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : undefined
}

function normalizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const trimmed = message.trim()
  return trimmed.length > 0 ? trimmed.slice(0, 240) : 'Codex CLI failed'
}

class CodexCliTimeoutError extends Error {
  constructor() {
    super('Codex CLI timed out')
    this.name = 'CodexCliTimeoutError'
  }
}
