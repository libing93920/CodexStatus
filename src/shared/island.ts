export type IslandTaskPhase = 'running' | 'completed' | 'failed' | 'stopped'
export type IslandRequestKind = 'approval' | 'input'
export type IslandDisplayStatus = 'waiting-approval' | 'waiting-input' | IslandTaskPhase

export interface IslandPreferences {
  enabled: boolean
}

export interface IslandRequest {
  id: string
  kind: IslandRequestKind
  summary?: string
  createdAt: number
}

export interface IslandTask {
  hostId: string
  threadId: string
  turnId: string
  title: string
  project: string
  phase: IslandTaskPhase
  startedAt?: number
  updatedAt: number
  requests: IslandRequest[]
  latestEventId: string
}

export interface IslandConnectionState {
  hooks: boolean
  ipc: boolean
  precise: boolean
  lastHookEventAt?: number
}

export type IslandVisibility = 'disabled' | 'waiting' | 'fullscreen' | 'visible'

export interface IslandSnapshot {
  tasks: IslandTask[]
  counts: Record<IslandDisplayStatus, number>
  connection: IslandConnectionState
  visibility: IslandVisibility
  visibleThreadId?: string
  viewedEventIds: string[]
}

export interface IslandPresentation {
  revision: number
  visible: boolean
}

export interface IslandWindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export const DEFAULT_ISLAND_PREFERENCES: IslandPreferences = {
  enabled: false
}

export const ISLAND_ALERT_DURATION_MS = 5_000

export function resolveIslandWindowBounds(
  display: IslandWindowBounds,
  size: Pick<IslandWindowBounds, 'width' | 'height'>
): IslandWindowBounds {
  return {
    x: display.x + Math.round((display.width - size.width) / 2),
    y: display.y,
    width: size.width,
    height: size.height
  }
}

export function createEmptyIslandSnapshot(): IslandSnapshot {
  return {
    tasks: [],
    counts: { ...EMPTY_COUNTS },
    connection: { hooks: false, ipc: false, precise: false },
    visibility: 'disabled',
    viewedEventIds: []
  }
}

export function normalizeIslandPreferences(
  value: Partial<IslandPreferences> | undefined
): IslandPreferences {
  return { enabled: value?.enabled === true }
}

interface IslandEventBase {
  eventId: string
  hostId: string
  threadId: string
  turnId: string
  occurredAt: number
  title?: string
  project?: string
}

export type IslandActivityEvent =
  | (IslandEventBase & { kind: 'turn-started' | 'activity' })
  | (IslandEventBase & { kind: 'turn-finished'; outcome: Exclude<IslandTaskPhase, 'running'> })
  | (IslandEventBase & {
      kind: 'request-opened'
      request: IslandRequest
    })
  | (IslandEventBase & { kind: 'request-resolved'; requestId: string })

export interface IslandAlertContext {
  fullscreen: boolean
  visibleThreadId?: string
}

const STATUS_PRIORITY: Record<IslandDisplayStatus, number> = {
  'waiting-approval': 0,
  'waiting-input': 1,
  failed: 2,
  running: 3,
  completed: 4,
  stopped: 5
}

const EMPTY_COUNTS: Record<IslandDisplayStatus, number> = {
  'waiting-approval': 0,
  'waiting-input': 0,
  running: 0,
  completed: 0,
  failed: 0,
  stopped: 0
}

export class IslandState {
  private readonly tasks = new Map<string, IslandTask>()
  private readonly seenEvents = new Set<string>()
  private readonly viewedEvents = new Set<string>()
  private connection: IslandConnectionState = { hooks: false, ipc: false, precise: false }
  private visibleThreadId?: string

  constructor(viewedEventIds: readonly string[] = []) {
    for (const eventId of viewedEventIds.slice(-256)) this.viewedEvents.add(eventId)
  }

  apply(event: IslandActivityEvent): boolean {
    if (this.seenEvents.has(event.eventId)) return false
    addBounded(this.seenEvents, event.eventId, 4_096)
    const key = taskKey(event.hostId, event.threadId)
    const current = this.tasks.get(key)
    if (current && event.occurredAt < current.updatedAt) return false
    if (event.kind === 'request-resolved' && !current) return false
    if (
      current &&
      current.turnId === event.turnId &&
      isTerminalPhase(current.phase) &&
      event.kind !== 'request-resolved'
    ) {
      return false
    }
    const task = prepareTask(current, event)

    if (event.kind === 'request-opened') {
      task.requests = upsertRequest(task.requests, event.request)
    } else if (event.kind === 'request-resolved') {
      task.requests = task.requests.filter((request) => request.id !== event.requestId)
    } else if (event.kind === 'turn-finished') {
      task.phase = event.outcome
    } else {
      task.phase = 'running'
    }

    task.updatedAt = event.occurredAt
    task.latestEventId = event.eventId
    this.tasks.set(key, task)
    return true
  }

  replaceAuthoritative(tasks: readonly IslandTask[]): void {
    this.tasks.clear()
    for (const task of tasks) this.tasks.set(taskKey(task.hostId, task.threadId), cloneTask(task))
  }

  upsertAuthoritative(task: IslandTask): void {
    const key = taskKey(task.hostId, task.threadId)
    const current = this.tasks.get(key)
    const keepObservedStart =
      task.phase === 'running' &&
      task.turnId === `thread:${task.threadId}` &&
      current?.phase === 'running' &&
      current.startedAt !== undefined
    const keepTerminal =
      task.phase === 'running' &&
      task.turnId === `thread:${task.threadId}` &&
      current !== undefined &&
      isTerminalPhase(current.phase)
    this.tasks.set(
      key,
      cloneTask(
        keepTerminal
          ? current
          : keepObservedStart
            ? { ...task, turnId: current.turnId, startedAt: current.startedAt }
            : task
      )
    )
  }

  removeTask(hostId: string, threadId: string): void {
    this.tasks.delete(taskKey(hostId, threadId))
  }

  setConnection(patch: Partial<IslandConnectionState>): void {
    this.connection = { ...this.connection, ...patch }
    this.connection.precise = this.connection.ipc
  }

  noteHookEvent(receivedAt: number): void {
    this.connection = { ...this.connection, lastHookEventAt: receivedAt }
  }

  setVisibleThread(threadId: string | undefined): void {
    this.visibleThreadId = threadId
  }

  markViewed(eventId: string): void {
    addBounded(this.viewedEvents, eventId, 256)
  }

  isViewed(eventId: string): boolean {
    return this.viewedEvents.has(eventId)
  }

  getViewedEventIds(): string[] {
    return [...this.viewedEvents]
  }

  getSnapshot(): IslandSnapshot {
    const tasks = [...this.tasks.values()].map(cloneTask).sort(compareTasks)
    const counts = { ...EMPTY_COUNTS }
    for (const task of tasks) counts[getDisplayStatus(task)] += 1
    return {
      tasks,
      counts,
      connection: { ...this.connection },
      visibility: 'waiting',
      visibleThreadId: this.visibleThreadId,
      viewedEventIds: this.getViewedEventIds()
    }
  }
}

function isTerminalPhase(phase: IslandTaskPhase): boolean {
  return phase === 'completed' || phase === 'failed' || phase === 'stopped'
}

export function getDisplayStatus(task: IslandTask): IslandDisplayStatus {
  if (task.requests.some((request) => request.kind === 'approval')) return 'waiting-approval'
  if (task.requests.some((request) => request.kind === 'input')) return 'waiting-input'
  return task.phase
}

export function shouldPresentAlert(
  task: IslandTask,
  viewed: boolean,
  context: IslandAlertContext
): boolean {
  if (viewed || context.visibleThreadId === task.threadId) return false
  const status = getDisplayStatus(task)
  if (!context.fullscreen) return status !== 'running' && status !== 'stopped'
  return status === 'waiting-approval' || status === 'waiting-input' || status === 'failed'
}

export interface ReminderClock {
  now: () => number
  setTimeout: (callback: () => void, delayMs: number) => unknown
  clearTimeout: (timer: unknown) => void
}

export class PausableReminder {
  private remainingMs: number
  private deadline = 0
  private timer?: unknown
  private readonly onElapsed: () => void
  private readonly clock: ReminderClock

  constructor(
    durationMs: number,
    onElapsed: () => void,
    clock: ReminderClock = defaultReminderClock
  ) {
    this.remainingMs = durationMs
    this.onElapsed = onElapsed
    this.clock = clock
  }

  start(): void {
    if (this.timer !== undefined || this.remainingMs <= 0) return
    this.deadline = this.clock.now() + this.remainingMs
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined
      this.remainingMs = 0
      this.onElapsed()
    }, this.remainingMs)
  }

  pause(): void {
    if (this.timer === undefined) return
    this.clock.clearTimeout(this.timer)
    this.timer = undefined
    this.remainingMs = Math.max(0, this.deadline - this.clock.now())
  }

  stop(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer)
    this.timer = undefined
  }
}

const defaultReminderClock: ReminderClock = {
  now: Date.now,
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout)
}

function prepareTask(current: IslandTask | undefined, event: IslandActivityEvent): IslandTask {
  if (!current || current.turnId !== event.turnId) {
    return {
      hostId: event.hostId,
      threadId: event.threadId,
      turnId: event.turnId,
      title: event.title ?? 'Codex 任务',
      project: event.project ?? '',
      phase: 'running',
      startedAt: event.occurredAt,
      updatedAt: event.occurredAt,
      requests: [],
      latestEventId: event.eventId
    }
  }
  return {
    ...current,
    title: event.title ?? current.title,
    project: event.project ?? current.project,
    requests: current.requests.map((request) => ({ ...request }))
  }
}

function upsertRequest(requests: IslandRequest[], incoming: IslandRequest): IslandRequest[] {
  return [...requests.filter((request) => request.id !== incoming.id), { ...incoming }]
}

function compareTasks(left: IslandTask, right: IslandTask): number {
  const priority =
    STATUS_PRIORITY[getDisplayStatus(left)] - STATUS_PRIORITY[getDisplayStatus(right)]
  return priority || right.updatedAt - left.updatedAt
}

function cloneTask(task: IslandTask): IslandTask {
  return { ...task, requests: task.requests.map((request) => ({ ...request })) }
}

function taskKey(hostId: string, threadId: string): string {
  return `${hostId}\u0000${threadId}`
}

function addBounded(values: Set<string>, value: string, limit: number): void {
  values.delete(value)
  values.add(value)
  while (values.size > limit) values.delete(values.values().next().value as string)
}
