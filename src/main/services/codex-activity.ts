import type {
  IslandActivityEvent,
  IslandSnapshot,
  IslandTask,
  IslandTaskPhase,
  IslandTaskSource
} from '../../shared/island.ts'
import { getDisplayStatus, IslandState } from '../../shared/island.ts'
import { isAdmittedIslandTaskSource, type IslandTaskIdentity } from './codex-task-identity.ts'
import {
  mapCodexHookEvent,
  readCodexTranscriptIdentity,
  type CodexHookPayload,
  type CodexTranscriptIdentity
} from './codex-hook-events.ts'
import { CodexHookIngress } from './codex-hook-ingress.ts'
import { CodexIpcClient } from './codex-ipc-client.ts'
import { listCodexThreadCatalog } from './codex-thread-catalog.ts'
import { formatDiagError, logDiag, recordPerf } from './diag-log.ts'

// 只在服务层合并执行态更新，避免服务和窗口广播两层等待叠加。
const EMIT_DEBOUNCE_MS = 100
const HOOK_SOURCE_RETRY_MS = 1_000
const DESKTOP_REQUEST_HOOK_EVENTS = new Set(['PreToolUse', 'PermissionRequest'])
const LIFECYCLE_HOOK_EVENTS = new Set(['UserPromptSubmit', 'Stop', 'Interrupt'])

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

interface ResolvedHookIdentity extends IslandTaskIdentity {
  threadId: string
}

export class CodexActivityService {
  private readonly options: CodexActivityOptions
  private readonly state: IslandState
  private readonly ingress: CodexHookIngress
  private ipcTaskKeys = new Set<string>()
  private readonly hookTaskKeys = new Set<string>()
  private readonly hookTurnIds = new Map<string, string>()
  private readonly hookIpcTurnIds = new Map<string, string>()
  private readonly threadSources = new Map<string, IslandTaskSource>()
  private readonly hookSourceCache = new Map<string, IslandTaskIdentity>()
  private readonly hookTranscriptCache = new Map<string, CodexTranscriptIdentity>()
  private readonly hookSourceRetryAt = new Map<string, number>()
  private readonly finishedHookTurnIds = new Set<string>()
  private readonly retiredIpcCandidates = new Set<string>()
  private readonly finishedThreadIds = new Set<string>()
  // 记录已完成撤销的线程：身份确认且清理跑完后，后续同源拒绝无需再付出全量快照与清理成本。
  private readonly revokedThreadKeys = new Set<string>()
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
    this.hookIpcTurnIds.clear()
    this.revokedThreadKeys.clear()
    this.hookSourceCache.clear()
    this.hookTranscriptCache.clear()
    this.hookSourceRetryAt.clear()
    try {
      if (this.options.executable) {
        const catalog = await listCodexThreadCatalog(this.options.executable, this.options.cwd)
        threadIds.push(...this.registerCatalog(catalog))
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
        const source = threadId && this.threadSources.get(createTaskKey('local', threadId))
        if (source === 'vscode') {
          this.revokedThreadKeys.delete(createTaskKey('local', threadId!))
          this.ipc?.followThread(threadId!)
        }
        this.state.setVisibleThread(source === 'vscode' ? threadId : undefined)
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
    this.revokedThreadKeys.clear()
    this.hookSourceCache.clear()
    this.hookTranscriptCache.clear()
    this.hookSourceRetryAt.clear()
    this.hookTaskKeys.clear()
    this.hookTurnIds.clear()
    this.hookIpcTurnIds.clear()
    this.finishedHookTurnIds.clear()
    this.retiredIpcCandidates.clear()
    this.finishedThreadIds.clear()
    await this.ingress.stop()
    this.state.setConnection({ hooks: false, ipc: false })
    this.emitNow()
  }

  getSnapshot(): IslandSnapshot {
    return this.state.getSnapshot()
  }

  private registerCatalog(catalog: { id: string; source: IslandTaskSource }[]): string[] {
    const threadIds: string[] = []
    for (const entry of catalog) {
      const key = createTaskKey('local', entry.id)
      const cached = this.hookSourceCache.get(key)
      // 启动目录可能晚于 Hook 返回，不覆盖已读到的明确内部身份。
      const source =
        entry.source === 'internal' || entry.source === 'subagent'
          ? entry.source
          : cached && !cached.legacyDesktopCandidate
            ? cached.source
            : entry.source
      this.threadSources.set(key, source)
      if (isAdmittedIslandTaskSource(source)) this.revokedThreadKeys.delete(key)
      if (source === 'vscode') threadIds.push(entry.id)
      else if (source !== 'cli') this.rejectThread('local', entry.id, source)
    }
    return threadIds
  }

  markViewed(eventId: string): void {
    this.state.markViewed(eventId)
    this.options.onViewedEventsChange?.(this.state.getViewedEventIds())
    const task = this.state
      .getSnapshot()
      .tasks.find((candidate) => candidate.latestEventId === eventId)
    if (task?.phase === 'completed' || task?.phase === 'failed') {
      this.state.removeTask(task.hostId, task.threadId)
    }
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
    if (this.stopped) return
    recordPerf('island:hookEvent')
    const identity = this.resolveHookIdentity(payload)
    if (payload.transcript_path && identity === undefined) {
      if (!isRetry) this.scheduleHookSourceRetry(payload, receivedAt)
      return
    }
    if (!identity || !identity.admitted) {
      this.rejectThread(
        'local',
        identity?.threadId ?? payload.session_id,
        identity?.source ?? 'unknown'
      )
      return
    }
    const taskPayload = { ...payload, session_id: identity.threadId }
    const source = identity.source
    this.state.noteHookEvent(receivedAt)
    // 重新准入意味着撤销不再完成：订阅会重建，必须清掉旧标记，否则后续拒绝会短路。
    this.revokedThreadKeys.delete(createTaskKey('local', taskPayload.session_id))
    if (source === 'vscode') this.ipc?.followThread(taskPayload.session_id)
    // 自动审批也会触发工具 Hook，Desktop 的待处理请求统一由 IPC 状态流确认。
    if (source === 'vscode' && DESKTOP_REQUEST_HOOK_EVENTS.has(payload.hook_event_name)) {
      return this.emit()
    }
    const normalizedPayload = this.resolveHookTurn({ ...taskPayload, source }, receivedAt)
    if (!normalizedPayload) return this.emit()
    const event = mapCodexHookEvent(normalizedPayload, receivedAt)
    if (!event) return this.emit()
    this.applyHookEvent(taskPayload, event)
  }

  private applyHookEvent(payload: CodexHookPayload, event: IslandActivityEvent): void {
    const key = createTaskKey(event.hostId, event.threadId)
    const current = LIFECYCLE_HOOK_EVENTS.has(payload.hook_event_name)
      ? this.state
          .getSnapshot()
          .tasks.find((task) => task.hostId === event.hostId && task.threadId === event.threadId)
      : undefined
    if (!this.state.apply(event)) {
      this.logHookDecision(payload, 'state-rejected', current)
      return this.emit()
    }
    if (event.kind === 'turn-started') this.retirePreviousHookTurn(event, current)
    this.hookTurnIds.set(payload.session_id, event.turnId)
    this.hookTaskKeys.add(key)
    this.ipcTaskKeys.delete(key)
    if (event.kind === 'turn-started') {
      this.finishedThreadIds.delete(event.threadId)
      this.logHookDecision(
        payload,
        current?.turnId === event.turnId ? 'same-turn-input' : 'turn-input',
        current,
        'running'
      )
      if (event.source === 'vscode') this.reconcileHookTask(event.hostId, event.threadId)
    }
    if (event.kind === 'turn-finished') {
      this.logHookDecision(payload, 'terminal-applied', current, event.outcome)
      this.finishHookTurn(event.hostId, event.threadId, event.turnId)
      return
    }
    this.emit()
  }

  private retirePreviousHookTurn(event: IslandActivityEvent, current?: IslandTask): void {
    // 追加输入不代表切换回合；无真实 ID 时也不能退休已观测的候选 IPC 回合。
    if (!isConcreteTurnId(event.threadId, event.turnId)) return
    this.retiredIpcCandidates.delete(createTaskKey(event.threadId, event.turnId))
    const previousHookTurnId = this.hookTurnIds.get(event.threadId)
    if (previousHookTurnId && previousHookTurnId !== event.turnId) {
      this.finishedHookTurnIds.add(createTaskKey(event.threadId, previousHookTurnId))
    }
    if (current?.turnId === event.turnId) return
    const key = createTaskKey(event.hostId, event.threadId)
    // IPC-only 当前身份仍可能属于晚到 Hook，不能当成已结束的 Hook 回合。
    const previousIpcTurnId =
      this.hookIpcTurnIds.get(key) ??
      (current && isConcreteTurnId(event.threadId, current.turnId) ? current.turnId : undefined)
    if (previousIpcTurnId && previousIpcTurnId !== event.turnId) {
      if (previousIpcTurnId !== previousHookTurnId) {
        this.retiredIpcCandidates.add(createTaskKey(event.threadId, previousIpcTurnId))
      }
      this.hookIpcTurnIds.delete(key)
    }
  }

  private finishHookTurn(hostId: string, threadId: string, turnId: string): void {
    this.finishedHookTurnIds.add(createTaskKey(threadId, turnId))
    const key = createTaskKey(hostId, threadId)
    const ipcTurnId = this.hookIpcTurnIds.get(key)
    // 候选只能隔离旧 IPC 快照，不能据此拒绝之后带真实 ID 的 Hook。
    if (ipcTurnId && ipcTurnId !== turnId) {
      this.retiredIpcCandidates.add(createTaskKey(threadId, ipcTurnId))
    }
    this.hookIpcTurnIds.delete(key)
    this.finishedThreadIds.add(threadId)
    this.emitNow()
    this.scheduleFinishedTask(hostId, threadId)
  }

  private logHookDecision(
    payload: CodexHookPayload,
    decision: string,
    current?: IslandTask,
    phase?: IslandTaskPhase
  ): void {
    if (!LIFECYCLE_HOOK_EVENTS.has(payload.hook_event_name)) return
    logDiag(
      `island hook lifecycle ${JSON.stringify({
        event: payload.hook_event_name,
        threadId: payload.session_id,
        hookTurnId: payload.turn_id,
        currentTurnId: current?.turnId ?? this.hookTurnIds.get(payload.session_id),
        ipcTurnId: this.hookIpcTurnIds.get(createTaskKey('local', payload.session_id)),
        decision,
        from: current?.phase,
        to: phase
      })}`
    )
  }

  private scheduleHookSourceRetry(payload: CodexHookPayload, receivedAt: number): void {
    this.scheduleHookRetry(() => {
      if (this.stopped) return
      if (payload.transcript_path) this.hookSourceRetryAt.delete(payload.transcript_path)
      this.handleHookPayload(payload, receivedAt, true)
    })
  }

  private scheduleHookRetry(callback: () => void): void {
    const timer = setTimeout(callback, HOOK_SOURCE_RETRY_MS)
    timer.unref?.()
  }

  private resolveHookIdentity(payload: CodexHookPayload): ResolvedHookIdentity | undefined {
    const transcript = payload.transcript_path
      ? this.resolveTranscriptIdentity(payload.transcript_path)
      : undefined
    if (payload.transcript_path && !transcript) return undefined
    // 子代理沿用父 session_id；先确认 transcript 自身 id，不能借用或撤销父身份。
    const threadId = transcript?.threadId ?? payload.session_id
    const key = createTaskKey('local', threadId)
    const catalogSource = this.threadSources.get(key)
    const known =
      catalogSource === undefined
        ? undefined
        : {
            source: catalogSource,
            admitted: isAdmittedIslandTaskSource(catalogSource),
            legacyDesktopCandidate: false
          }
    if (catalogSource === 'internal' || catalogSource === 'subagent') {
      return known && { ...known, threadId }
    }
    const identity = transcript ?? this.hookSourceCache.get(key)
    if (!identity) return known && { ...known, threadId }
    if (transcript) this.hookSourceCache.set(key, transcript)
    const resolved =
      identity.legacyDesktopCandidate && catalogSource === 'vscode' ? known : identity
    if (!resolved) return undefined
    this.threadSources.set(key, resolved.source)
    if (isAdmittedIslandTaskSource(resolved.source)) this.revokedThreadKeys.delete(key)
    return { ...resolved, threadId }
  }

  private resolveTranscriptIdentity(transcriptPath: string): CodexTranscriptIdentity | undefined {
    const cached = this.hookTranscriptCache.get(transcriptPath)
    if (cached) return cached
    const now = Date.now()
    const retryAt = this.hookSourceRetryAt.get(transcriptPath)
    if (retryAt !== undefined && now < retryAt) return undefined
    const identity = readCodexTranscriptIdentity(transcriptPath)
    if (identity !== undefined) {
      this.hookSourceRetryAt.delete(transcriptPath)
      this.hookTranscriptCache.set(transcriptPath, identity)
      return identity
    }
    // 未读到事件实际归属时只延迟重试，不能回退到共享 session_id 的已知父身份。
    this.hookSourceRetryAt.set(transcriptPath, now + HOOK_SOURCE_RETRY_MS)
    return undefined
  }

  private rejectThread(hostId: string, threadId: string, source: IslandTaskSource): void {
    const key = createTaskKey(hostId, threadId)
    // 已确认拒绝、撤销已完成、且快照无残留任务时才短路；只查身份会漏掉“先写 internal 再撤销已有任务”的首次清理。
    if (
      this.threadSources.get(key) === source &&
      this.revokedThreadKeys.has(key) &&
      !this.state.hasTask(hostId, threadId)
    ) {
      return
    }
    const hadTask = this.state.hasTask(hostId, threadId)
    if (this.threadSources.get(key) !== source || hadTask) {
      logDiag(`island admission rejected thread=${JSON.stringify(threadId)} source=${source}`)
    }
    this.threadSources.set(key, source)
    this.revokedThreadKeys.add(key)
    this.state.removeTask(hostId, threadId)
    this.hookTaskKeys.delete(key)
    this.ipcTaskKeys.delete(key)
    this.hookTurnIds.delete(threadId)
    this.hookIpcTurnIds.delete(key)
    this.finishedThreadIds.delete(threadId)
    for (const turnKey of this.finishedHookTurnIds) {
      if (turnKey.startsWith(`${threadId}\u0000`)) this.finishedHookTurnIds.delete(turnKey)
    }
    for (const turnKey of this.retiredIpcCandidates) {
      if (turnKey.startsWith(`${threadId}\u0000`)) this.retiredIpcCandidates.delete(turnKey)
    }
    if (hostId === 'local') this.ipc?.unfollowThread(threadId)
    if (hadTask) this.emitNow()
  }

  private resolveHookTurn(
    payload: CodexHookPayload,
    receivedAt: number
  ): CodexHookPayload | undefined {
    const currentTurnId = this.hookTurnIds.get(payload.session_id)
    if (payload.hook_event_name === 'UserPromptSubmit') {
      const turnId = payload.turn_id ?? `hook:${payload.session_id}:${receivedAt}`
      if (this.finishedHookTurnIds.has(createTaskKey(payload.session_id, turnId))) {
        this.logHookDecision(payload, 'retired-turn')
        return undefined
      }
      return { ...payload, turn_id: turnId }
    }
    const turnId = payload.turn_id ?? currentTurnId
    if (turnId && this.finishedHookTurnIds.has(createTaskKey(payload.session_id, turnId))) {
      this.logHookDecision(payload, 'retired-turn')
      return undefined
    }
    if (payload.turn_id && currentTurnId && payload.turn_id !== currentTurnId) {
      this.logHookDecision(payload, 'different-turn')
      return undefined
    }
    return turnId ? { ...payload, turn_id: turnId } : payload
  }

  private updateIpcTasks(tasks: IslandTask[]): void {
    if (this.stopped) return
    recordPerf('island:ipcUpdate')
    const sourcedTasks: IslandTask[] = []
    for (const task of tasks) {
      const source = this.threadSources.get(createTaskKey(task.hostId, task.threadId))
      if (source === 'cli') continue
      if (source !== 'vscode') {
        this.rejectThread(task.hostId, task.threadId, source ?? 'unknown')
        continue
      }
      sourcedTasks.push({ ...task, source })
    }
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
      if (
        !this.hookTaskKeys.has(key) ||
        current.source !== 'vscode' ||
        current.phase !== 'running'
      ) {
        continue
      }
      // 活跃列表不携带初始/重连终态，只重核身份明确匹配的缓存终态。
      let ipcTask = ipcTasks.get(key)
      if (!ipcTask || !isConcreteTurnId(current.threadId, ipcTask.turnId)) {
        ipcTask =
          this.ipc?.getTerminalTask(current.hostId, current.threadId, current.turnId) ?? ipcTask
      }
      if (ipcTask) this.supplementHookTask(current, ipcTask)
    }
  }

  private reconcileHookTask(hostId: string, threadId: string): void {
    const current = this.state
      .getSnapshot()
      .tasks.find((task) => task.hostId === hostId && task.threadId === threadId)
    if (current?.source === 'vscode' && current.phase === 'running') {
      const terminal = this.ipc?.getTerminalTask(hostId, threadId, current.turnId)
      if (terminal) this.supplementHookTask(current, terminal)
    }
  }

  private supplementHookTask(current: IslandTask, ipcTask: IslandTask): void {
    const terminal = ipcTask.phase !== 'running'
    const turnKey = createTaskKey(current.threadId, ipcTask.turnId)
    const retired = this.finishedHookTurnIds.has(turnKey) || this.retiredIpcCandidates.has(turnKey)
    const matches = terminal
      ? current.turnId === ipcTask.turnId && isConcreteTurnId(current.threadId, current.turnId)
      : isCurrentHookTurn(current, ipcTask)
    if (terminal) {
      logDiag(
        `island ipc terminal ${JSON.stringify({
          threadId: current.threadId,
          hookTurnId: current.turnId,
          ipcTurnId: ipcTask.turnId,
          decision: retired ? 'retired-turn' : matches ? 'terminal-applied' : 'unconfirmed-turn',
          from: current.phase,
          to: ipcTask.phase
        })}`
      )
    }
    if (retired || !matches) return
    if (terminal && this.state.isViewed(ipcTask.latestEventId)) {
      this.state.removeTask(current.hostId, current.threadId)
      this.finishHookTurn(current.hostId, current.threadId, current.turnId)
      return
    }
    const key = createTaskKey(current.hostId, current.threadId)
    if (isConcreteTurnId(ipcTask.threadId, ipcTask.turnId)) {
      this.hookIpcTurnIds.set(key, ipcTask.turnId)
    }
    this.state.upsertAuthoritative({
      ...current,
      title: ipcTask.title,
      project: ipcTask.project,
      phase: terminal ? ipcTask.phase : current.phase,
      updatedAt: terminal ? ipcTask.updatedAt : current.updatedAt,
      requests: terminal ? [] : ipcTask.requests,
      latestEventId: terminal ? ipcTask.latestEventId : current.latestEventId
    })
    if (terminal) this.finishHookTurn(current.hostId, current.threadId, current.turnId)
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

function isConcreteTurnId(threadId: string, turnId: string): boolean {
  return (
    turnId !== `thread:${threadId}` &&
    turnId !== `session:${threadId}` &&
    !turnId.startsWith(`hook:${threadId}:`)
  )
}

function isCurrentHookTurn(current: IslandTask, ipcTask: IslandTask): boolean {
  // 工具 Hook 可能晚于 IPC 到达；缺少共享 ID 时依靠已观测回合的结束记录排除旧状态。
  return (
    current.turnId === ipcTask.turnId ||
    current.turnId === `hook:${current.threadId}:${current.startedAt}` ||
    ipcTask.turnId === `thread:${current.threadId}`
  )
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
