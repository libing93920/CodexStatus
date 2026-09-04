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
export const RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 240_000, 480_000] as const

const FIVE_HOUR_WINDOW_MINUTES = 5 * 60
const FIVE_HOUR_WINDOW_MS = 5 * 60 * 60 * 1000
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
  onRefresh: () => Promise<void>
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
      kind: 'wait-start'
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
      reason: 'already-started' | 'already-triggered' | 'not-eligible'
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
}

export function getFiveHourWindow(snapshot: UsageSnapshot): RateLimitWindowSnapshot | undefined {
  return snapshot.rateLimits.find(
    (windowState) => windowState.windowMinutes === FIVE_HOUR_WINDOW_MINUTES
  )
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

  if (windowState.usedPercent === undefined || !Number.isFinite(windowState.usedPercent)) {
    return { kind: 'wait-data' }
  }

  if (windowState.usedPercent <= 0) {
    return calculateUnanchoredPlan(windowState.id, nowMs, persisted)
  }

  const resetAt = windowState.resetsAt
  const resetAtMs = resetAt ? Date.parse(resetAt) : NaN
  if (!resetAt || !Number.isFinite(resetAtMs)) {
    return { kind: 'wait-data' }
  }

  if (isSamePersistedEvent(windowState.id, resetAt, persisted)) {
    return {
      kind: 'skip',
      reason: 'already-triggered',
      windowId: windowState.id,
      resetAt
    }
  }

  const triggerAtMs =
    resetAtMs > nowMs
      ? resetAtMs + WINDOW_KEEPER_TRIGGER_BUFFER_MS
      : nowMs + WINDOW_KEEPER_TRIGGER_BUFFER_MS

  if (resetAtMs <= nowMs) {
    return {
      kind: 'skip',
      reason: 'already-started',
      windowId: windowState.id,
      resetAt
    }
  }

  return {
    kind: 'wait-reset',
    windowId: windowState.id,
    resetAt,
    triggerAtMs,
    delayMs: Math.max(0, triggerAtMs - nowMs)
  }
}

function calculateUnanchoredPlan(
  windowId: string,
  nowMs: number,
  persisted: WindowKeeperPersistedState | undefined
): Extract<WindowKeeperPlan, { kind: 'wait-start' }> {
  const lastTriggeredAtMs =
    persisted?.windowId === windowId ? parseTimestamp(persisted.lastTriggeredAt) : undefined
  const nextWindowAtMs =
    lastTriggeredAtMs === undefined ? nowMs : lastTriggeredAtMs + FIVE_HOUR_WINDOW_MS
  const triggerAtMs = Math.max(nowMs, nextWindowAtMs) + WINDOW_KEEPER_TRIGGER_BUFFER_MS
  const cycleKey = `${windowId}:unanchored:${lastTriggeredAtMs ?? 'initial'}`

  return {
    kind: 'wait-start',
    windowId,
    cycleKey,
    triggerAtMs,
    delayMs: Math.max(0, triggerAtMs - nowMs)
  }
}

export class WindowKeeper {
  private readonly runner: CodexCliRunner
  private readonly onRefresh: () => Promise<void>
  private readonly onStatusChange?: (status: WindowKeeperStatus) => void
  private readonly onPersistenceChange?: (state: WindowKeeperPersistedState) => void
  private readonly onExhausted?: (error: string) => void
  private readonly timer: TimerApi
  private persisted: WindowKeeperPersistedState
  private enabled: boolean
  private stopped = false
  private snapshot: UsageSnapshot | undefined
  private activeEvent: ActiveEvent | undefined
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
      lastTriggeredAt: this.persisted.lastTriggeredAt
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
    if (this.enabled) {
      this.reconcile()
    }
  }

  stop(): void {
    this.stopped = true
    this.cancelActiveEvent()
  }

  private reconcile(): void {
    if (!this.snapshot) {
      this.cancelActiveEvent()
      this.setStatus({
        state: 'waiting-data',
        nextActionAt: undefined,
        recentError: undefined
      })
      return
    }

    const plan = calculateWindowKeeperPlan(this.snapshot, this.timer.now(), this.persisted)
    if (plan.kind === 'wait-data') {
      this.cancelActiveEvent()
      this.setStatus({
        state: 'waiting-data',
        nextActionAt: undefined,
        recentError: undefined
      })
      return
    }
    if (plan.kind === 'skip') {
      this.cancelActiveEvent()
      this.finishedEventKey =
        plan.reason === 'not-eligible' || !plan.windowId || !plan.resetAt
          ? undefined
          : createEventKey(plan.windowId, plan.resetAt)
      this.setStatus({
        state: 'waiting-reset',
        nextActionAt: undefined,
        recentError: undefined
      })
      return
    }

    const eventKey =
      plan.kind === 'wait-start' ? plan.cycleKey : createEventKey(plan.windowId, plan.resetAt)
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
    plan: Extract<WindowKeeperPlan, { kind: 'wait-start' | 'wait-reset' }>,
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
      running: false
    }
    this.activeEvent = event
    this.scheduleTimer(event, plan.delayMs, false)
    this.setStatus({
      state: 'waiting-reset',
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
        void this.triggerEvent(event)
      },
      Math.max(0, delayMs)
    )
  }

  private async triggerEvent(event: ActiveEvent): Promise<void> {
    if (this.activeEvent !== event || !this.enabled || this.stopped || event.running) {
      return
    }
    if (this.timer.now() >= event.deadlineAtMs) {
      this.finishError(event)
      return
    }

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
      this.scheduleRetry(event)
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
    this.finishSuccess(event)
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

  private finishSuccess(event: ActiveEvent): void {
    const triggeredAt = new Date(this.timer.now()).toISOString()
    const nextPersisted: WindowKeeperPersistedState = {
      windowId: event.windowId,
      lastTriggeredAt: triggeredAt
    }
    if (event.resetAt) {
      nextPersisted.resetAt = event.resetAt
    }
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
    void this.onRefresh().catch((error) => {
      if (!this.stopped && this.enabled) {
        this.setStatus({
          state: 'waiting-data',
          recentError: normalizeError(error)
        })
      }
    })
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

  private setStatus(patch: Partial<WindowKeeperStatus> & Pick<WindowKeeperStatus, 'state'>): void {
    this.status = {
      ...this.status,
      ...patch,
      lastTriggeredAt: this.persisted.lastTriggeredAt
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
  return persisted?.windowId === windowId && persisted.resetAt === resetAt
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
