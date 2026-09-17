import type { IslandSnapshot, IslandTask, IslandTaskSource } from '../../shared/island.ts'
import { getDisplayStatus, IslandState } from '../../shared/island.ts'
import {
  mapCodexHookEvent,
  readCodexTranscriptSource,
  type CodexHookPayload
} from './codex-hook-events.ts'
import { CodexHookIngress } from './codex-hook-ingress.ts'
import { CodexIpcClient } from './codex-ipc-client.ts'
import { listCodexThreadCatalog } from './codex-thread-catalog.ts'
import { formatDiagError, logDiag, recordPerf } from './diag-log.ts'

// 只在服务层合并执行态更新，避免服务和窗口广播两层等待叠加。
const EMIT_DEBOUNCE_MS = 100
const HOOK_SOURCE_RETRY_MS = 1_000

export interface CodexActivityOptions {
  executable?: string
  cwd: string
  descriptorPath: string
  onSnapshot: (snapshot: IslandSnapshot) => void
  viewedEventIds?: readonly string[]
  onViewedEventsChange?: (eventIds: string[]) => void
  /** emit 合并窗口(毫秒);0 = 同步发出(测试用),默认 100 */
  emitDebounceMs?: number
}

export class CodexActivityService {
  private readonly options: CodexActivityOptions
  private readonly state: IslandState
  private readonly ingress: CodexHookIngress
  private ipcTaskKeys = new Set<string>()
  private readonly hookTaskKeys = new Set<string>()
  private readonly hookTurnIds = new Map<string, string>()
  private readonly threadSources = new Map<string, IslandTaskSource>()
  private readonly hookSourceCache = new Map<string, IslandTaskSource>()
  private readonly hookSourceRetryAt = new Map<string, number>()
  private readonly finishedHookTurnIds = new Set<string>()
  private readonly finishedThreadIds = new Set<string>()
  private ipc?: CodexIpcClient
  private stopped = false

  constructor(options: CodexActivityOptions) {
    this.options = options
    this.emitDebounceMs = options.emitDebounceMs ?? EMIT_DEBOUNCE_MS
    this.state = new IslandState(options.viewedEventIds)
    this.ingress = new CodexHookIngress({
      descriptorPath: options.descriptorPath,
      onEvent: (payload) => this.handleHookPayload(payload)
    })
  }

  async start(): Promise<void> {
    this.stopped = false
    logDiag('island activity start')
    await this.ingress.start()
    this.state.setConnection({ hooks: true })
    this.emitNow()
    const threadIds: string[] = []
    this.threadSources.clear()
    this.hookSourceCache.clear()
    this.hookSourceRetryAt.clear()
    try {
      if (this.options.executable) {
        const catalog = await listCodexThreadCatalog(this.options.executable, this.options.cwd)
        for (const entry of catalog) {
          this.threadSources.set(createTaskKey('local', entry.id), entry.source)
          if (entry.source !== 'cli') threadIds.push(entry.id)
        }
        logDiag(`ipc catalog success threads=${catalog.length}`)
      } else {
        logDiag('ipc catalog skipped reason=executable-unresolved')
      }
    } catch (error) {
      logDiag(`ipc catalog failed ${formatDiagError(error)}`)
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
        logDiag(`island ipc connection=${connected ? 'connected' : 'disconnected'}`)
        this.state.setConnection({ ipc: connected })
        if (!this.stopped) this.emitNow()
      }
    })
    this.ipc.start()
  }

  async stop(): Promise<void> {
    this.stopped = true
    logDiag('island activity stop')
    if (this.emitTimer) clearTimeout(this.emitTimer)
    this.emitTimer = undefined
    this.ipc?.stop()
    this.ipc = undefined
    this.ipcTaskKeys.clear()
    this.threadSources.clear()
    this.hookSourceCache.clear()
    this.hookSourceRetryAt.clear()
    this.hookTaskKeys.clear()
    this.hookTurnIds.clear()
    this.finishedHookTurnIds.clear()
    this.finishedThreadIds.clear()
    await this.ingress.stop()
    this.state.setConnection({ hooks: false, ipc: false })
    this.emitNow()
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

  private handleHookPayload(
    payload: CodexHookPayload,
    receivedAt = Date.now(),
    isRetry = false
  ): void {
    recordPerf('island:hookEvent')
    const source = this.resolveHookSource(payload)
    if (payload.transcript_path && source === undefined && !isRetry) {
      this.scheduleHookSourceRetry(payload, receivedAt)
      return
    }
    if (source === 'subagent') return
    this.state.noteHookEvent(receivedAt)
    if (source !== 'cli') this.ipc?.followThread(payload.session_id)
    const normalizedPayload = this.resolveHookTurn(
      source ? { ...payload, source } : payload,
      receivedAt
    )
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
      // 终态立即广播:完成/停止是用户关心的提醒点,不走 debounce
      this.emitNow()
      this.scheduleFinishedTask(event.hostId, event.threadId)
      return
    }
    this.emit()
  }

  private scheduleHookSourceRetry(payload: CodexHookPayload, receivedAt: number): void {
    this.scheduleHookRetry(() => {
      if (this.stopped) return
      this.hookSourceRetryAt.delete(createTaskKey('local', payload.session_id))
      this.handleHookPayload(payload, receivedAt, true)
    })
  }

  private scheduleHookRetry(callback: () => void): void {
    const timer = setTimeout(callback, HOOK_SOURCE_RETRY_MS)
    timer.unref?.()
  }

  private resolveHookSource(payload: CodexHookPayload): IslandTaskSource | undefined {
    const key = createTaskKey('local', payload.session_id)
    if (this.hookSourceCache.has(key)) return this.hookSourceCache.get(key)
    const catalogSource = this.threadSources.get(key)
    if (catalogSource === 'cli' || catalogSource === 'vscode') return catalogSource
    if (!payload.transcript_path) return catalogSource
    const now = Date.now()
    const retryAt = this.hookSourceRetryAt.get(key)
    if (retryAt !== undefined && now < retryAt) return catalogSource
    const source = readCodexTranscriptSource(payload.transcript_path)
    if (source !== undefined) {
      this.hookSourceRetryAt.delete(key)
      this.hookSourceCache.set(key, source)
      this.threadSources.set(key, source)
      return source
    }
    // 文件尚未创建或首行仍在写入时允许后续恢复，但限制高频 Hook 的同步读盘次数。
    this.hookSourceRetryAt.set(key, now + HOOK_SOURCE_RETRY_MS)
    return catalogSource
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
    recordPerf('island:ipcUpdate')
    const sourcedTasks = tasks
      .filter((task) => {
        const source = this.threadSources.get(createTaskKey(task.hostId, task.threadId))
        return source !== 'cli' && task.source !== 'cli'
      })
      .map((task) => {
        const source = this.threadSources.get(createTaskKey(task.hostId, task.threadId))
        return source ? { ...task, source } : task
      })
    this.supplementHookTasks(sourcedTasks)
    const ipcTasks = sourcedTasks.filter(
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

  // emit 合并:streaming 期 IPC patch 高频到达,逐条全量快照+排序+派发是主进程热点;
  // 100ms 窗口合并 + 状态变化检测(空闲心跳不重发)。终态事件立即 flush 保证及时性
  private readonly emitDebounceMs: number
  private emitTimer: NodeJS.Timeout | undefined
  private lastEmittedSignature: string | undefined
  private lastCriticalSignature = '[]'

  private emit(): void {
    if (this.stopped) return
    const critical = criticalSignature(this.state.getSnapshot())
    if (critical !== this.lastCriticalSignature) {
      this.emitNow()
      return
    }
    if (this.emitTimer) return
    if (this.emitDebounceMs <= 0) {
      this.flushEmit()
      return
    }
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined
      this.flushEmit()
    }, this.emitDebounceMs)
  }

  /** 关键事件(终态/审批/连接变化)立即发出,跳过 debounce */
  private emitNow(): void {
    if (this.emitTimer) {
      clearTimeout(this.emitTimer)
      this.emitTimer = undefined
    }
    this.flushEmit()
  }

  private flushEmit(): void {
    const snapshot = this.state.getSnapshot()
    this.lastCriticalSignature = criticalSignature(snapshot)
    const signature = JSON.stringify(snapshot)
    if (signature === this.lastEmittedSignature) return
    this.lastEmittedSignature = signature
    this.options.onSnapshot(snapshot)
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

function criticalSignature(snapshot: IslandSnapshot): string {
  return JSON.stringify(
    snapshot.tasks
      .filter((task) => getDisplayStatus(task) !== 'running')
      .map((task) =>
        JSON.stringify([
          task.hostId,
          task.threadId,
          task.turnId,
          task.phase,
          task.requests.map((request) => [request.id, request.kind])
        ])
      )
      .sort()
  )
}
