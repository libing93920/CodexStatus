import type { IslandSnapshot, IslandTask } from '../../shared/island.ts'
import { getDisplayStatus, IslandState } from '../../shared/island.ts'
import { mapCodexHookEvent, type CodexHookPayload } from './codex-hook-events.ts'
import { CodexHookIngress } from './codex-hook-ingress.ts'
import { CodexIpcClient } from './codex-ipc-client.ts'
import { listCodexThreadIds } from './codex-thread-catalog.ts'

export interface CodexActivityOptions {
  executable?: string
  cwd: string
  descriptorPath: string
  onSnapshot: (snapshot: IslandSnapshot) => void
  viewedEventIds?: readonly string[]
  onViewedEventsChange?: (eventIds: string[]) => void
}

export class CodexActivityService {
  private readonly options: CodexActivityOptions
  private readonly state: IslandState
  private readonly ingress: CodexHookIngress
  private ipcTaskKeys = new Set<string>()
  private readonly hookTaskKeys = new Set<string>()
  private readonly hookTurnIds = new Map<string, string>()
  private readonly finishedHookTurnIds = new Set<string>()
  private readonly finishedThreadIds = new Set<string>()
  private ipc?: CodexIpcClient
  private stopped = false

  constructor(options: CodexActivityOptions) {
    this.options = options
    this.state = new IslandState(options.viewedEventIds)
    this.ingress = new CodexHookIngress({
      descriptorPath: options.descriptorPath,
      onEvent: (payload) => this.handleHookPayload(payload)
    })
  }

  async start(): Promise<void> {
    this.stopped = false
    await this.ingress.start()
    this.state.setConnection({ hooks: true })
    this.emit()
    let threadIds: string[] = []
    try {
      if (this.options.executable) {
        threadIds = await listCodexThreadIds(this.options.executable, this.options.cwd)
      }
    } catch {
      this.state.setConnection({ ipc: false })
      this.emit()
    }
    if (this.stopped) return
    this.ipc = new CodexIpcClient({
      threadIds,
      onTasks: (tasks) => this.updateIpcTasks(tasks),
      onVisibleThread: (threadId) => {
        this.state.setVisibleThread(threadId)
        this.emit()
      },
      onConnection: (connected) => {
        this.state.setConnection({ ipc: connected })
        this.emit()
      }
    })
    this.ipc.start()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.ipc?.stop()
    this.ipc = undefined
    this.ipcTaskKeys.clear()
    this.hookTaskKeys.clear()
    this.hookTurnIds.clear()
    this.finishedHookTurnIds.clear()
    this.finishedThreadIds.clear()
    await this.ingress.stop()
    this.state.setConnection({ hooks: false, ipc: false })
    this.emit()
  }

  getSnapshot(): IslandSnapshot {
    return this.state.getSnapshot()
  }

  markViewed(eventId: string): void {
    this.state.markViewed(eventId)
    this.options.onViewedEventsChange?.(this.state.getViewedEventIds())
    const task = this.state
      .getSnapshot()
      .tasks.find((candidate) => candidate.latestEventId === eventId)
    if (task?.phase === 'completed') this.state.removeTask(task.hostId, task.threadId)
    this.emit()
  }

  dismissTask(threadId: string): boolean {
    const task = this.state.getSnapshot().tasks.find((candidate) => candidate.threadId === threadId)
    if (!task || (task.phase !== 'failed' && task.phase !== 'completed')) return false
    this.state.markViewed(task.latestEventId)
    this.state.removeTask(task.hostId, task.threadId)
    this.options.onViewedEventsChange?.(this.state.getViewedEventIds())
    this.emit()
    return true
  }

  private handleHookPayload(payload: CodexHookPayload, receivedAt = Date.now()): void {
    this.state.noteHookEvent(receivedAt)
    this.ipc?.followThread(payload.session_id)
    const normalizedPayload = this.resolveHookTurn(payload, receivedAt)
    if (!normalizedPayload) return this.emit()
    const event = mapCodexHookEvent(normalizedPayload, receivedAt)
    if (!event) return this.emit()
    const key = createTaskKey(event.hostId, event.threadId)
    if (!this.state.apply(event)) return this.emit()
    this.hookTurnIds.set(payload.session_id, event.turnId)
    this.hookTaskKeys.add(key)
    this.ipcTaskKeys.delete(key)
    if (event.kind === 'turn-started') this.finishedThreadIds.delete(event.threadId)
    if (event.kind === 'turn-finished') {
      this.finishedHookTurnIds.add(createTaskKey(payload.session_id, event.turnId))
      this.finishedThreadIds.add(event.threadId)
    }
    this.emit()
    if (event.kind === 'turn-finished') this.scheduleFinishedTask(event.hostId, event.threadId)
  }

  private resolveHookTurn(
    payload: CodexHookPayload,
    receivedAt: number
  ): CodexHookPayload | undefined {
    const currentTurnId = this.hookTurnIds.get(payload.session_id)
    if (payload.hook_event_name === 'UserPromptSubmit') {
      const turnId = payload.turn_id ?? `hook:${payload.session_id}:${receivedAt}`
      if (this.finishedHookTurnIds.has(createTaskKey(payload.session_id, turnId))) return undefined
      return { ...payload, turn_id: turnId }
    }
    if (payload.turn_id) {
      if (this.finishedHookTurnIds.has(createTaskKey(payload.session_id, payload.turn_id))) {
        return undefined
      }
      if (currentTurnId && payload.turn_id !== currentTurnId) return undefined
      return payload
    }
    return currentTurnId ? { ...payload, turn_id: currentTurnId } : payload
  }

  private updateIpcTasks(tasks: IslandTask[]): void {
    this.supplementHookTasks(tasks)
    const ipcTasks = tasks.filter(
      (task) => !this.hookTaskKeys.has(createTaskKey(task.hostId, task.threadId))
    )
    for (const task of ipcTasks) {
      if (task.phase !== 'running') this.finishedThreadIds.add(task.threadId)
      else if (task.turnId !== `thread:${task.threadId}` || task.requests.length > 0) {
        this.finishedThreadIds.delete(task.threadId)
      }
    }
    const nextActiveKeys = new Set(
      ipcTasks
        .filter(
          (task) =>
            (task.phase === 'running' || task.requests.length > 0) &&
            !this.finishedThreadIds.has(task.threadId)
        )
        .map((task) => createTaskKey(task.hostId, task.threadId))
    )
    for (const key of this.ipcTaskKeys) {
      if (nextActiveKeys.has(key)) continue
      const [hostId, threadId] = key.split('\u0000')
      const current = this.state
        .getSnapshot()
        .tasks.find((task) => task.hostId === hostId && task.threadId === threadId)
      if (!current || current.phase === 'running') this.state.removeTask(hostId, threadId)
    }
    this.ipcTaskKeys = nextActiveKeys
    for (const task of ipcTasks) {
      if (task.phase === 'running' && this.finishedThreadIds.has(task.threadId)) continue
      if (task.phase !== 'running' && this.state.isViewed(task.latestEventId)) continue
      this.state.upsertAuthoritative(task)
      if (task.phase !== 'running') this.scheduleFinishedTask(task.hostId, task.threadId)
    }
    this.emit()
  }

  private supplementHookTasks(tasks: IslandTask[]): void {
    const ipcTasks = new Map(
      tasks.map((task) => [createTaskKey(task.hostId, task.threadId), task] as const)
    )
    for (const current of this.state.getSnapshot().tasks) {
      const key = createTaskKey(current.hostId, current.threadId)
      if (!this.hookTaskKeys.has(key)) continue
      const ipcTask = ipcTasks.get(key)
      const requests = [
        ...current.requests.filter((request) => request.kind === 'approval'),
        ...(ipcTask?.requests.filter((request) => request.kind === 'input') ?? [])
      ]
      if (!ipcTask) {
        this.state.upsertAuthoritative({ ...current, requests })
        continue
      }
      const failed = current.phase === 'running' && ipcTask.phase === 'failed'
      this.state.upsertAuthoritative({
        ...current,
        title: ipcTask.title,
        project: ipcTask.project,
        phase: failed ? 'failed' : current.phase,
        updatedAt: failed ? ipcTask.updatedAt : current.updatedAt,
        requests,
        latestEventId: failed ? ipcTask.latestEventId : current.latestEventId
      })
      if (failed) this.finishedThreadIds.add(current.threadId)
    }
  }

  private emit(): void {
    this.options.onSnapshot(this.state.getSnapshot())
  }

  private scheduleFinishedTask(hostId: string, threadId: string): void {
    const task = this.state
      .getSnapshot()
      .tasks.find((candidate) => candidate.hostId === hostId && candidate.threadId === threadId)
    if (!task || task.requests.length > 0 || getDisplayStatus(task) === 'failed') return
    if (task.phase === 'stopped') {
      this.state.removeTask(hostId, threadId)
      this.emit()
    }
  }
}

function createTaskKey(hostId: string, threadId: string): string {
  return `${hostId}\u0000${threadId}`
}
