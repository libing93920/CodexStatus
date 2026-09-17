import { randomUUID } from 'node:crypto'
import net, { type Socket } from 'node:net'
import type { IslandRequest, IslandTask, IslandTaskPhase } from '../../shared/island.ts'
import { formatDiagError, logDiag, recordPerf } from './diag-log.ts'

const PIPE_PATH = '\\\\.\\pipe\\codex-ipc'
const INITIAL_CLIENT_ID = 'initializing-client'
const MAX_FRAME_BYTES = 64 * 1024 * 1024
const INITIALIZE_TIMEOUT_MS = 5_000

interface ConversationVersion {
  revision: number
  state: Record<string, unknown>
}

type PathSegment = string | number

interface StatePatch {
  op: 'add' | 'replace' | 'remove'
  path: PathSegment[]
  value?: unknown
}

export interface CodexIpcClientOptions {
  threadIds: readonly string[]
  onTasks: (tasks: IslandTask[]) => void
  onVisibleThread: (threadId: string | undefined) => void
  onConnection: (connected: boolean) => void
  retryDelayMs?: number
}

export class CodexIpcClient {
  private readonly options: CodexIpcClientOptions
  private readonly threadIds: Set<string>
  private readonly conversations = new Map<string, ConversationVersion>()
  private readonly activeConversationKeys = new Set<string>()
  private readonly terminalTasks = new Map<string, IslandTask>()
  // 每会话投影缓存:key → {revision, task};emitTasks 每条 state change 都对
  // 全部会话重投影,但每条 patch 只改一个会话 —— 其余直接复用缓存
  private readonly projectedTaskCache = new Map<
    string,
    { revision: number; task: IslandTask | undefined }
  >()
  private socket?: Socket
  private clientId = INITIAL_CLIENT_ID
  private buffer = Buffer.alloc(0)
  private stopped = false
  private retryTimer?: NodeJS.Timeout
  private initializeTimer?: NodeJS.Timeout

  constructor(options: CodexIpcClientOptions) {
    this.options = options
    this.threadIds = new Set(options.threadIds)
  }

  start(): void {
    if (this.socket || this.stopped) return
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    logDiag(`ipc start pipe=${PIPE_PATH}`)
    const socket = net.createConnection(PIPE_PATH)
    this.socket = socket
    socket.once('connect', () => {
      logDiag('ipc socket connected')
      this.initialize(socket)
    })
    socket.on('data', (chunk: Buffer) => {
      if (this.socket !== socket) return
      this.consume(chunk)
    })
    socket.once('error', (error) => {
      if (this.socket !== socket) return
      logDiag(`ipc socket error ${formatDiagError(error)}`)
      this.disconnect()
    })
    socket.once('close', () => {
      if (this.socket !== socket) return
      logDiag('ipc socket closed')
      this.disconnect()
    })
  }

  stop(): void {
    this.stopped = true
    logDiag('ipc stop')
    this.setFollowing(false)
    this.socket?.destroy()
    this.socket = undefined
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.clearInitializeTimer()
    this.conversations.clear()
    this.projectedTaskCache.clear()
    this.options.onConnection(false)
  }

  followThread(threadId: string): void {
    if (this.threadIds.has(threadId)) return
    this.threadIds.add(threadId)
    this.sendFollowing(threadId, true)
  }

  private initialize(socket: Socket): void {
    logDiag('ipc initialize sent')
    this.initializeTimer = setTimeout(() => {
      if (this.socket === socket && this.clientId === INITIAL_CLIENT_ID) {
        logDiag(`ipc initialize timeout timeoutMs=${INITIALIZE_TIMEOUT_MS}`)
        this.disconnect(socket)
      }
    }, INITIALIZE_TIMEOUT_MS)
    this.initializeTimer.unref?.()
    this.send(
      {
        type: 'request',
        requestId: randomUUID(),
        sourceClientId: INITIAL_CLIENT_ID,
        version: 0,
        method: 'initialize',
        params: { clientType: 'codex-status-readonly' },
        timeoutMs: 5_000
      },
      socket
    )
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0)
      if (length === 0 || length > MAX_FRAME_BYTES) {
        logDiag(`ipc protocol error reason=invalid-frame-length length=${length}`)
        return this.disconnect()
      }
      if (this.buffer.length < length + 4) return
      const payload = this.buffer.subarray(4, length + 4).toString('utf8')
      this.buffer = this.buffer.subarray(length + 4)
      try {
        this.handleMessage(JSON.parse(payload))
      } catch (error) {
        logDiag(`ipc protocol error reason=message ${formatDiagError(error)}`)
        return this.disconnect()
      }
    }
  }

  private handleMessage(value: unknown): void {
    const message = getRecord(value)
    if (message?.type === 'response' && getRecord(message.result)?.clientId) {
      this.clientId = String(getRecord(message.result)?.clientId)
      this.clearInitializeTimer()
      logDiag('ipc initialize success')
      this.options.onConnection(true)
      this.setFollowing(true)
      return
    }
    if (message?.type !== 'broadcast') return
    const params = getRecord(message.params)
    if (message.method === 'thread-stream-following-changed') {
      this.handleFollowing(params, message.sourceClientId)
    } else if (message.method === 'thread-stream-state-changed') {
      this.handleStateChange(params)
    }
  }

  private handleFollowing(
    params: Record<string, unknown> | undefined,
    sourceClientId: unknown
  ): void {
    if (sourceClientId === this.clientId) return
    const threadId = getString(params?.conversationId)
    const following = params?.following === true
    if (threadId && following) this.followThread(threadId)
    if (threadId) this.options.onVisibleThread(following ? threadId : undefined)
  }

  private handleStateChange(params: Record<string, unknown> | undefined): void {
    const startedAt = performance.now()
    const threadId = getString(params?.conversationId)
    const hostId = getString(params?.hostId) ?? 'local'
    const change = getRecord(params?.change)
    if (!threadId || !change) throw new Error('Invalid state change')
    const key = conversationKey(hostId, threadId)
    const previous = this.conversations.get(key)
    const previousState = previous?.state
    const wasActive = this.activeConversationKeys.has(key)
    if (change.type === 'snapshot') this.applySnapshot(hostId, threadId, change)
    else if (change.type === 'patches') this.applyIncrement(hostId, threadId, change)
    else throw new Error('Unsupported state change')
    const current = this.conversations.get(key)
    const terminalTask =
      previousState && current
        ? projectTerminalTransition(hostId, threadId, previousState, current.state)
        : undefined
    const task = terminalTask ?? (current ? this.projectTask(key, current) : undefined)
    if (isActiveTask(task)) {
      this.activeConversationKeys.add(key)
    } else {
      this.activeConversationKeys.delete(key)
      if (terminalTask) this.terminalTasks.set(key, terminalTask)
      else if (wasActive && task) this.terminalTasks.set(key, task)
    }
    this.emitTasks()
    this.terminalTasks.clear()
    recordPerf('ipc:stateChange', performance.now() - startedAt)
  }

  private applySnapshot(hostId: string, threadId: string, change: Record<string, unknown>): void {
    const revision = getNumber(change.revision)
    const state = getRecord(change.conversationState)
    if (revision === undefined || !state) throw new Error('Invalid snapshot')
    this.conversations.set(conversationKey(hostId, threadId), { revision, state })
    this.projectedTaskCache.delete(conversationKey(hostId, threadId))
  }

  private applyIncrement(hostId: string, threadId: string, change: Record<string, unknown>): void {
    const key = conversationKey(hostId, threadId)
    const current = this.conversations.get(key)
    const baseRevision = getNumber(change.baseRevision)
    const revision = getNumber(change.revision)
    if (!current || current.revision !== baseRevision || revision === undefined) {
      throw new Error('Revision mismatch')
    }
    const patches = parsePatches(change.patches)
    current.state = applyStatePatches(current.state, patches)
    current.revision = revision
  }

  private emitTasks(): void {
    const tasks: IslandTask[] = []
    const keys = new Set([...this.activeConversationKeys, ...this.terminalTasks.keys()])
    for (const key of keys) {
      const conversation = this.conversations.get(key)
      if (!conversation) continue
      const task = this.terminalTasks.get(key) ?? this.projectTask(key, conversation)
      if (task) tasks.push(task)
    }
    this.options.onTasks(tasks)
  }

  private projectTask(key: string, conversation: ConversationVersion): IslandTask | undefined {
    const cached = this.projectedTaskCache.get(key)
    if (cached?.revision === conversation.revision) return cached.task
    const [hostId, threadId] = key.split('\u0000')
    const task = projectConversationState(hostId, threadId, conversation.state)
    this.projectedTaskCache.set(key, { revision: conversation.revision, task })
    return task
  }

  private setFollowing(following: boolean): void {
    if (this.clientId === INITIAL_CLIENT_ID || !this.socket?.writable) return
    for (const threadId of this.threadIds) this.sendFollowing(threadId, following)
  }

  private sendFollowing(threadId: string, following: boolean): void {
    if (this.clientId === INITIAL_CLIENT_ID || !this.socket?.writable) return
    this.send({
      type: 'broadcast',
      method: 'thread-stream-following-changed',
      sourceClientId: this.clientId,
      version: 1,
      params: { conversationId: threadId, hostId: 'local', following }
    })
  }

  private send(message: unknown, socket = this.socket): void {
    if (!socket?.writable) return
    const payload = Buffer.from(JSON.stringify(message), 'utf8')
    const frame = Buffer.allocUnsafe(payload.length + 4)
    frame.writeUInt32LE(payload.length, 0)
    payload.copy(frame, 4)
    socket.write(frame)
  }

  private disconnect(socket?: Socket): void {
    if (socket && this.socket !== socket) return
    this.clearInitializeTimer()
    this.socket?.destroy()
    this.socket = undefined
    this.conversations.clear()
    this.activeConversationKeys.clear()
    this.terminalTasks.clear()
    this.projectedTaskCache.clear()
    this.options.onConnection(false)
    if (!this.stopped && !this.retryTimer) {
      this.clientId = INITIAL_CLIENT_ID
      this.buffer = Buffer.alloc(0)
      const delayMs = this.options.retryDelayMs ?? 3_000
      logDiag(`ipc retry scheduled delayMs=${delayMs}`)
      this.retryTimer = setTimeout(() => this.start(), delayMs)
    }
  }

  private clearInitializeTimer(): void {
    if (this.initializeTimer) clearTimeout(this.initializeTimer)
    this.initializeTimer = undefined
  }
}

export function projectTerminalTransition(
  hostId: string,
  threadId: string,
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
  observedAt = Date.now()
): IslandTask | undefined {
  const previousTurn = getLatestTurn(previous.turnHistory, false)
  const currentTurn = getLatestTurn(current.turnHistory, false)
  const status = getString(currentTurn?.status)
  const turnId = getString(currentTurn?.turnId)
  if (!turnId || !isTerminalStatus(status)) return undefined
  if (getString(previousTurn?.turnId) === turnId && getString(previousTurn?.status) === status) {
    return undefined
  }
  const updatedAt = getTurnEndAt(currentTurn) ?? getNumber(current.updatedAt) ?? observedAt
  const runtime = getRecord(current.threadRuntimeStatus)
  const requests = projectRequests(
    current.requests,
    getStringArray(runtime?.activeFlags),
    turnId,
    observedAt
  )
  return {
    hostId,
    threadId,
    turnId,
    title: getString(current.title) ?? 'Codex 任务',
    project: getProjectName(getString(current.cwd)),
    phase: status === 'failed' ? 'failed' : status === 'interrupted' ? 'stopped' : 'completed',
    startedAt: getNumber(currentTurn?.turnStartedAtMs),
    updatedAt,
    requests,
    latestEventId: `ipc:${threadId}:${turnId}:${status}`
  }
}

function isActiveTask(task: IslandTask | undefined): boolean {
  return Boolean(task && (task.phase === 'running' || task.requests.length > 0))
}

export function applyStatePatches(
  source: Record<string, unknown>,
  patches: readonly StatePatch[]
): Record<string, unknown> {
  const result = { ...source }
  for (const patch of patches) {
    // 只复制将被写入的祖先；旧快照仍用于判断终态，失败时也不能污染它。
    let parent: unknown = result
    for (const segment of patch.path.slice(0, -1)) {
      const child = getPatchChild(parent, segment)
      const record = getRecord(child)
      const copy = Array.isArray(child) ? [...child] : record ? { ...record } : undefined
      if (!copy) throw new Error('Invalid patch path')
      if (Array.isArray(parent)) parent[parseArrayIndex(segment, parent.length)] = copy
      else (parent as Record<string, unknown>)[String(segment)] = copy
      parent = copy
    }
    applyStatePatch(result, patch)
  }
  return result
}

function applyStatePatch(target: Record<string, unknown>, patch: StatePatch): void {
  if (patch.path.length === 0) throw new Error('Root patch unsupported')
  let parent: unknown = target
  for (const segment of patch.path.slice(0, -1)) parent = getPatchChild(parent, segment)
  const key = patch.path.at(-1) as PathSegment
  if (Array.isArray(parent)) applyArrayPatch(parent, key, patch)
  else if (getRecord(parent)) applyObjectPatch(parent as Record<string, unknown>, key, patch)
  else throw new Error('Invalid patch path')
}

function getPatchChild(parent: unknown, segment: PathSegment): unknown {
  if (Array.isArray(parent)) {
    const index = parseArrayIndex(segment, parent.length)
    return parent[index]
  }
  const record = getRecord(parent)
  const key = String(segment)
  if (!record || !(key in record)) throw new Error('Invalid patch path')
  return record[key]
}

function applyArrayPatch(parent: unknown[], key: PathSegment, patch: StatePatch): void {
  let index: number
  if (key === '-') {
    if (patch.op !== 'add') throw new Error('Invalid array index')
    index = parent.length
  } else {
    index = parseArrayIndex(key, parent.length, patch.op === 'add')
  }
  if (patch.op === 'add') parent.splice(index, 0, patch.value)
  else if (patch.op === 'replace') parent[index] = patch.value
  else if (patch.op === 'remove') parent.splice(index, 1)
}

function applyObjectPatch(
  parent: Record<string, unknown>,
  key: PathSegment,
  patch: StatePatch
): void {
  const name = String(key)
  if (patch.op === 'remove') delete parent[name]
  else parent[name] = patch.value
}

export function projectConversationState(
  hostId: string,
  threadId: string,
  state: Record<string, unknown>,
  observedAt = Date.now()
): IslandTask | undefined {
  const runtime = getRecord(state.threadRuntimeStatus)
  const activeFlags = getStringArray(runtime?.activeFlags)
  const latestTurn = getLatestTurn(state.turnHistory, false)
  const currentTurn = latestTurn?.status === 'inProgress' ? latestTurn : undefined
  const updatedAt = getNumber(state.updatedAt)
  const pendingTurn = hasUnloadedActiveTurn(runtime?.type, updatedAt, latestTurn)
  const turnId = getString(currentTurn?.turnId) ?? `thread:${threadId}`
  const requests = projectRequests(state.requests, activeFlags, turnId, observedAt)
  const phase =
    resolvePhase(currentTurn?.status) ??
    (pendingTurn || requests.length > 0 ? 'running' : undefined) ??
    (runtime?.type === 'active' ? undefined : resolvePhase(latestTurn?.status))
  if (!phase) return undefined
  const turnEndedAt = phase === 'running' ? undefined : getTurnEndAt(latestTurn)
  return {
    hostId,
    threadId,
    turnId,
    title: getString(state.title) ?? 'Codex 任务',
    project: getProjectName(getString(state.cwd)),
    phase,
    startedAt:
      getNumber(currentTurn?.turnStartedAtMs) ??
      (pendingTurn || requests.length > 0 ? updatedAt : undefined),
    updatedAt: turnEndedAt ?? updatedAt ?? observedAt,
    requests,
    latestEventId: `ipc:${threadId}:${getNumber(state.updatedAt) ?? observedAt}`
  }
}

function projectRequests(
  value: unknown,
  flags: string[],
  turnId: string,
  observedAt: number
): IslandRequest[] {
  const requests = Array.isArray(value) ? value : []
  const projected = requests.flatMap((request, index) => {
    const record = getRecord(request)
    if (!record) return []
    const id = getString(record.requestId) ?? getString(record.id) ?? `${turnId}:${index}`
    const kind = inferRequestKind(record, flags)
    return [
      { id, kind, summary: kind === 'input' ? '需要回复' : '需要审批', createdAt: observedAt }
    ]
  })
  if (projected.length > 0) return projected
  if (flags.includes('waitingOnApproval')) return [syntheticRequest(turnId, 'approval', observedAt)]
  if (flags.includes('waitingOnUserInput')) return [syntheticRequest(turnId, 'input', observedAt)]
  return []
}

function inferRequestKind(record: Record<string, unknown>, flags: string[]): 'approval' | 'input' {
  const marker = `${getString(record.method) ?? ''} ${getString(record.type) ?? ''}`.toLowerCase()
  if (marker.includes('input') || marker.includes('elicitation') || 'questions' in record)
    return 'input'
  return flags.includes('waitingOnUserInput') ? 'input' : 'approval'
}

function syntheticRequest(
  turnId: string,
  kind: 'approval' | 'input',
  createdAt: number
): IslandRequest {
  return {
    id: `${turnId}:${kind}`,
    kind,
    summary: kind === 'input' ? '需要回复' : '需要审批',
    createdAt
  }
}

const latestTurnCache = new WeakMap<object, Record<string, unknown> | undefined>()

function getLatestTurn(value: unknown, activeOnly: boolean): Record<string, unknown> | undefined {
  const history = getRecord(getRecord(value)?.history)
  const entities = getRecord(history?.entitiesByKey)
  if (!entities) return undefined
  if (!activeOnly && latestTurnCache.has(entities)) return latestTurnCache.get(entities)
  let latest: Record<string, unknown> | undefined
  let startedAt = -Infinity
  for (const value of Object.values(entities)) {
    const turn = getRecord(value)
    const time = getNumber(turn?.turnStartedAtMs)
    if (!turn || time === undefined || !getString(turn.turnId)) continue
    if (!resolvePhase(turn.status) || (activeOnly && turn.status !== 'inProgress')) continue
    if (time > startedAt) {
      latest = turn
      startedAt = time
    }
  }
  if (!activeOnly) latestTurnCache.set(entities, latest)
  return latest
}

function resolvePhase(turnStatus: unknown): IslandTaskPhase | undefined {
  if (turnStatus === 'inProgress') return 'running'
  if (turnStatus === 'failed') return 'failed'
  if (turnStatus === 'interrupted') return 'stopped'
  if (turnStatus === 'completed') return 'completed'
  return undefined
}

function getTurnEndAt(turn: Record<string, unknown> | undefined): number | undefined {
  const startedAt = getNumber(turn?.turnStartedAtMs)
  const durationMs = getNumber(turn?.durationMs)
  return startedAt === undefined || durationMs === undefined ? undefined : startedAt + durationMs
}

function hasUnloadedActiveTurn(
  runtimeType: unknown,
  updatedAt: number | undefined,
  latestTurn: Record<string, unknown> | undefined
): boolean {
  if (runtimeType !== 'active' || updatedAt === undefined) return false
  if (!latestTurn) return true
  const startedAt = getNumber(latestTurn.turnStartedAtMs)
  const durationMs = getNumber(latestTurn.durationMs)
  if (startedAt === undefined || durationMs === undefined) return false
  return updatedAt > startedAt + durationMs
}

function isTerminalStatus(value: string | undefined): boolean {
  return value === 'completed' || value === 'failed' || value === 'interrupted'
}

function parsePatches(value: unknown): StatePatch[] {
  if (!Array.isArray(value)) throw new Error('Invalid patches')
  return value.map((item) => {
    const patch = getRecord(item)
    if (!patch || !['add', 'replace', 'remove'].includes(String(patch.op)))
      throw new Error('Invalid patch')
    if (!Array.isArray(patch.path) || !patch.path.every(isPathSegment)) {
      throw new Error('Invalid patch path')
    }
    return { op: patch.op as StatePatch['op'], path: patch.path, value: patch.value }
  })
}

function isPathSegment(value: unknown): value is PathSegment {
  return typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value))
}

function parseArrayIndex(value: PathSegment, length: number, allowEnd = false): number {
  const index = Number(value)
  const max = allowEnd ? length : length - 1
  if (!Number.isInteger(index) || index < 0 || index > max)
    throw new Error('Invalid array index')
  return index
}

function conversationKey(hostId: string, threadId: string): string {
  return `${hostId}\u0000${threadId}`
}

function getProjectName(cwd: string | undefined): string {
  return (
    cwd
      ?.replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? ''
  )
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function getNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}
