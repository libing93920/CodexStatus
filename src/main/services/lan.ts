import { createHash, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { isIPv4, isIPv6, type AddressInfo } from 'node:net'
import { isDeepStrictEqual } from 'node:util'
import { WebSocketServer, WebSocket } from 'ws'
import { LanDiscovery, type LanAdvertisement } from './lan-discovery.ts'
import { formatDiagError, logDiag } from './diag-log.ts'
import { ActivityConnectionAuth, type ActivityAuthHello } from './lan-activity-auth.ts'
import { validatePeerSnapshot } from './lan-peer-snapshot.ts'
import { isAdminDevice, isTeamAdmin } from './admin-device.ts'
import type {
  AgentId,
  AuthMode,
  BroadcastMessage,
  BroadcastSendResult,
  ReactionMessage,
  ReactionSendResult,
  TeamPeer,
  UsageWindow
} from '../../shared/capsule.ts'
import { parseTeamIdentity, isPeerId, type TeamRole } from '../../shared/team-role.ts'
import {
  ACTIVITY_PROTOCOL_VERSION,
  ACTIVITY_MAX_MESSAGE_BYTES,
  canExchangeActivity,
  validateActivityMessage,
  type ActivityMessage
} from '../../shared/activity.ts'

const GROUP_HASH_LENGTH = 12
// hello 重发等待:连接 open 后发 hello,若此时间内未收到对方 hello 则补发一次
const HELLO_RETRY_DELAY_MS = 3000
// 广播消息约束:超长拒绝、过频丢弃(局域网无鉴权,防刷屏底线)
const BROADCAST_MAX_TEXT_LENGTH = 200
const BROADCAST_MIN_INTERVAL_MS = 2000
const PEER_RECONNECT_DELAY_MS = 100
export const LAN_CONNECTION_TIMEOUT_MS = 5_000
export const LAN_HELLO_TIMEOUT_MS = 10_000
export const LAN_RETRY_DELAY_MS = 10_000
const MAX_PORT = 65_535
const INCOMING_TARGET = 'incoming'

/** peer 间互发的派生展示数据:绝不包含 Codex 凭据 */
export interface PeerSnapshot {
  /** 昵称:每次快照随带,避免只随 hello 传导致竞态显示兜底 'peer' */
  nickname?: string
  /** 登录方式:api=API Key(无订阅额度,额度榜不展示) */
  authMode?: AuthMode
  remainingPercent?: number
  weeklyResetsAt?: string
  resetCreditCount?: number
  /** 短窗口(5h)展示用:label + 剩余% */
  shortWindow?: { label: string; remainingPercent?: number }
  /** 长窗口(7d/1周)展示用:label + 剩余% */
  longWindow?: { label: string; remainingPercent?: number }
  /** 各窗口 token 消耗总数(1d/7d/30d) */
  tokenUsage?: Partial<Record<UsageWindow, number>>
  /** 各窗口估算花费总额(USD,1d/7d/30d) */
  costUsage?: Partial<Record<UsageWindow, number>>
  /** 各窗口各工具 token 消耗(团队榜分段用) */
  tokenUsageByAgent?: Partial<Record<UsageWindow, Partial<Record<AgentId, number>>>>
  /** 应用版本:接收端以组内最高版本为基准判定是否最新 */
  appVersion?: string
}

interface PeerEntry {
  id: string
  nickname: string
  authMode?: AuthMode
  remainingPercent?: number
  weeklyResetsAt?: string
  resetCreditCount?: number
  shortWindow?: { label: string; remainingPercent?: number }
  longWindow?: { label: string; remainingPercent?: number }
  tokenUsage?: Partial<Record<UsageWindow, number>>
  costUsage?: Partial<Record<UsageWindow, number>>
  tokenUsageByAgent?: Partial<Record<UsageWindow, Partial<Record<AgentId, number>>>>
  appVersion?: string
  updatedAt?: string
}

interface StartOptions {
  peerId: string
  nickname: string
  group: string
  activityEnabled?: boolean
  onActivityMessage?: (peerId: string, message: ActivityMessage) => void
  /** 获取本机最新派生数据,用于广播给已连 peer */
  getSnapshot: () => PeerSnapshot
  /** peer 列表变化时回调,主进程据此刷新团队页 */
  onPeersChange: (peers: TeamPeer[]) => void
  /** 收到同组广播消息时回调,主进程据此推给渲染层 */
  onMessage: (message: BroadcastMessage) => void
  /** 收到同组点赞事件时回调,主进程据此推给渲染层 */
  onReaction: (reaction: ReactionMessage) => void
}

interface HelloMessage extends ActivityAuthHello {
  type: 'hello'
  peerId: string
  nickname: string
  groupHash: string
  snapshot?: PeerSnapshot
  role?: TeamRole
  activityVersion?: number
  activityEnabled?: boolean
}

interface SnapshotMessage {
  type: 'snapshot'
  snapshot?: PeerSnapshot
}

type PeerMessage =
  | HelloMessage
  | SnapshotMessage
  | BroadcastMessage
  | ReactionMessage
  | ActivityMessage

// mDNS 发现的远程服务信息
interface DiscoveredService {
  peerId: string
  nickname: string
  groupHash: string
  // 候选地址列表(IPv4 优先),逐一尝试连接
  hosts: string[]
  port: number
}

/**
 * 局域网团队通信:mDNS 发布+发现同组 peer,WebSocket 互发派生展示数据。
 * 组口令经 SHA-256 哈希比对(只传哈希不传明文);不同口令的 peer 连上即断开。
 */
export class LanService {
  private readonly adminDeviceAllowed: () => boolean
  private httpServer: Server | undefined
  private wss: WebSocketServer | undefined
  private discovery: LanDiscovery | undefined
  private readonly sockets = new Set<WebSocket>()
  private readonly connectionTimers = new Map<WebSocket, NodeJS.Timeout>()
  private readonly connectionFailures = new Map<string, Set<string>>()
  private readonly connections = new Map<string, WebSocket>()
  private readonly activityAuth = new ActivityConnectionAuth()
  private readonly boundSockets = new WeakMap<WebSocket, string>()
  private readonly peers = new Map<string, PeerEntry>()
  private readonly discovered = new Map<string, DiscoveredService>()
  private readonly activityCapabilities = new Map<
    string,
    { role: TeamRole; version: number; enabled: boolean }
  >()
  // hello 重发定时器:连接 open 后若未及时收到对方 hello 则补发
  private readonly helloTimers = new Map<WebSocket, NodeJS.Timeout>()
  private options: StartOptions | undefined
  private groupHash: string | undefined
  private stopped = false
  /** 上次广播时间戳,用于间隔限频 */
  private lastBroadcastAt = 0
  private lifecycleGeneration = 0
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>()

  constructor(adminDeviceAllowed = isAdminDevice) {
    this.adminDeviceAllowed = adminDeviceAllowed
  }

  start(options: StartOptions): void {
    if (this.options) {
      this.stop()
    }
    const generation = ++this.lifecycleGeneration
    this.stopped = false
    this.options = options
    this.groupHash = hashGroup(options.group)
    this.peers.clear()
    this.discovered.clear()

    this.startServer().then(
      () => {
        if (generation !== this.lifecycleGeneration || this.stopped || !this.options) return
        this.startDiscovery()
      },
      (error) => {
        if (generation !== this.lifecycleGeneration || this.stopped) return
        logDiag(`lan server start failed ${formatDiagError(error)}`)
      }
    )
  }

  stop(): void {
    this.lifecycleGeneration++
    this.stopped = true
    this.discovery?.stop()
    this.discovery = undefined
    for (const timers of [this.helloTimers, this.connectionTimers, this.reconnectTimers]) {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    }
    // 包括尚未认证和被另一连接替换的 socket，退出时不能等待对端 close 握手。
    const sockets = new Set([
      ...this.sockets,
      ...this.connections.values(),
      ...(this.wss?.clients ?? [])
    ])
    for (const socket of sockets) socket.terminate()
    this.sockets.clear()
    this.connections.clear()
    this.connectionFailures.clear()
    const peersChanged = this.peers.size > 0
    this.peers.clear()
    this.activityCapabilities.clear()
    this.discovered.clear()
    this.wss?.close()
    this.wss = undefined
    this.httpServer?.close()
    this.httpServer = undefined
    const onPeersChange = this.options?.onPeersChange
    this.options = undefined
    this.groupHash = undefined
    if (peersChanged) onPeersChange?.([])
  }

  /** 本机 snapshot 变化后,推送给所有已连 peer */
  broadcastSnapshot(): void {
    if (!this.options) return
    const snapshot = this.options.getSnapshot()
    const payload = JSON.stringify({
      type: 'snapshot',
      snapshot
    } satisfies SnapshotMessage)
    for (const [peerId, socket] of this.connections) {
      if (socket.readyState === WebSocket.OPEN && this.boundSockets.get(socket) === peerId) {
        socket.send(payload)
      }
    }
  }

  /** 校验后向所有已连 peer 广播一条消息;未启动/超长/过频分别返回失败原因 */
  broadcastMessage(text: string): BroadcastSendResult {
    if (!this.options) {
      return { ok: false, reason: 'not-in-team' }
    }
    const trimmed = text.trim()
    if (trimmed.length === 0 || trimmed.length > BROADCAST_MAX_TEXT_LENGTH) {
      return { ok: false, reason: 'too-long' }
    }
    const now = Date.now()
    if (now - this.lastBroadcastAt < BROADCAST_MIN_INTERVAL_MS) {
      return { ok: false, reason: 'rate-limited' }
    }
    this.lastBroadcastAt = now
    const message: BroadcastMessage = {
      type: 'message',
      id: randomUUID(),
      senderPeerId: this.options.peerId,
      senderNickname: this.options.nickname,
      sentAt: now,
      text: trimmed
    }
    const payload = JSON.stringify(message)
    for (const [peerId, socket] of this.connections) {
      if (socket.readyState === WebSocket.OPEN && this.boundSockets.get(socket) === peerId) {
        socket.send(payload)
      }
    }
    return { ok: true, message }
  }

  /** 校验后向所有已连 peer 广播一条点赞事件;未启动返回失败原因(点赞无长度/限频约束) */
  broadcastReaction(targetPeerId: string, action: 'add' | 'remove'): ReactionSendResult {
    if (!this.options) {
      return { ok: false, reason: 'not-in-team' }
    }
    const reaction: ReactionMessage = {
      type: 'reaction',
      id: randomUUID(),
      senderPeerId: this.options.peerId,
      targetPeerId,
      action,
      sentAt: Date.now()
    }
    const payload = JSON.stringify(reaction)
    for (const [peerId, socket] of this.connections) {
      if (socket.readyState === WebSocket.OPEN && this.boundSockets.get(socket) === peerId) {
        socket.send(payload)
      }
    }
    return { ok: true, reaction }
  }

  getActivityAdminIds(): string[] {
    return [...this.activityCapabilities.entries()]
      .filter(
        ([id, capability]) =>
          this.peers.has(id) &&
          this.activityAuth.isVerified(this.connections.get(id), id) &&
          capability.role === 'admin' &&
          capability.version === ACTIVITY_PROTOCOL_VERSION
      )
      .map(([id]) => id)
  }

  sendActivity(peerId: string, message: ActivityMessage): boolean {
    const capability = this.activityCapabilities.get(peerId)
    const socket = this.connections.get(peerId)
    if (
      !this.options ||
      !this.peers.has(peerId) ||
      capability?.version !== ACTIVITY_PROTOCOL_VERSION ||
      socket?.readyState !== WebSocket.OPEN ||
      !this.activityAuth.isVerified(socket, peerId)
    )
      return false
    const localAdmin = isTeamAdmin(this.options.group, this.adminDeviceAllowed())
    if (
      !canExchangeActivity(message.type, localAdmin, capability.role === 'admin', 'send') ||
      !validateActivityMessage(message)
    )
      return false
    const payload = JSON.stringify(message)
    if (Buffer.byteLength(payload) > ACTIVITY_MAX_MESSAGE_BYTES) return false
    socket.send(payload)
    return true
  }

  private applyActivityCapabilities(message: HelloMessage, verified: boolean): boolean {
    const previous = this.activityCapabilities.get(message.peerId)
    const role: TeamRole = message.role === 'admin' ? 'admin' : 'member'
    const version =
      verified && message.activityVersion === ACTIVITY_PROTOCOL_VERSION
        ? ACTIVITY_PROTOCOL_VERSION
        : 0
    const enabled = message.activityEnabled === true
    this.activityCapabilities.set(message.peerId, { role, version, enabled })
    return previous?.role !== role || previous.version !== version || previous.enabled !== enabled
  }

  private receiveActivity(peerId: string, message: ActivityMessage, socket: WebSocket): void {
    const capability = this.activityCapabilities.get(peerId)
    if (
      !this.options ||
      !this.peers.has(peerId) ||
      capability?.version !== ACTIVITY_PROTOCOL_VERSION ||
      !this.activityAuth.isVerified(socket, peerId)
    )
      return
    const localAdmin = isTeamAdmin(this.options.group, this.adminDeviceAllowed())
    if (!canExchangeActivity(message.type, localAdmin, capability.role === 'admin', 'receive'))
      return
    if (message.type === 'activity-day' && message.day.peerId !== peerId) return
    this.options.onActivityMessage?.(peerId, message)
  }

  /** 当前 peer 列表(不含 self),供主进程合并 self 生成 teamPeers */
  getPeers(): TeamPeer[] {
    return Array.from(this.peers.values()).map((entry) => ({
      id: entry.id,
      nickname: entry.nickname,
      isSelf: false,
      authMode: entry.authMode,
      remainingPercent: entry.remainingPercent,
      shortWindow: entry.shortWindow,
      longWindow: entry.longWindow,
      resetCreditCount: entry.resetCreditCount,
      tokenUsage: entry.tokenUsage,
      costUsage: entry.costUsage,
      tokenUsageByAgent: entry.tokenUsageByAgent,
      appVersion: entry.appVersion,
      activitySupported:
        this.activityCapabilities.get(entry.id)?.version === ACTIVITY_PROTOCOL_VERSION,
      activityEnabled: this.activityCapabilities.get(entry.id)?.enabled,
      updatedAt: entry.updatedAt
    }))
  }

  private async startServer(): Promise<void> {
    const server = createServer()
    this.httpServer = server

    const wss = new WebSocketServer({ server })
    this.wss = wss
    wss.on('connection', (socket) => this.handleIncoming(socket))

    await new Promise<void>((resolve) => {
      server.listen(0, '0.0.0.0', () => resolve())
    })
  }

  private startDiscovery(): void {
    if (!this.options || !this.groupHash || !this.httpServer) return
    const address = this.httpServer.address()
    if (!address || typeof address === 'string') return
    this.discovery = new LanDiscovery({
      peerId: this.options.peerId,
      nickname: this.options.nickname,
      groupHash: this.groupHash,
      port: (address as AddressInfo).port,
      onUp: (service) => this.handleServiceUp(service),
      onDown: (service) => this.handleServiceDown(service)
    })
    this.discovery.start()
  }

  private handleServiceUp(service: LanAdvertisement): void {
    if (this.stopped || !this.options || !this.groupHash) return
    const peerId = service.txt?.peerId
    const nickname = service.txt?.nick
    const groupHash = service.txt?.groupHash
    if (!peerId || !nickname || groupHash !== this.groupHash || peerId === this.options.peerId)
      return
    if (!Number.isInteger(service.port) || service.port <= 0 || service.port > MAX_PORT) return
    const hosts = sortServiceHosts(service.addresses, service.referer?.address)
    if (hosts.length === 0) return
    const existing = this.discovered.get(peerId)
    const sameAddress =
      existing?.port === service.port &&
      existing.hosts.length === hosts.length &&
      existing.hosts.every((host, index) => host === hosts[index])
    if (sameAddress) existing.nickname = nickname
    else this.discovered.set(peerId, { peerId, nickname, groupHash, hosts, port: service.port })
    if (!this.reconnectTimers.has(peerId)) this.connectToPeer(peerId)
  }

  private handleServiceDown(service: { name?: string }): void {
    const peerId = service.name
    if (!peerId) return
    this.clearReconnectTimer(peerId)
    this.connectionFailures.delete(peerId)
    this.discovered.delete(peerId)
    const socket = this.connections.get(peerId)
    this.connections.delete(peerId)
    if (socket) socket.terminate()
    if (this.peers.delete(peerId)) {
      this.emitPeersChange()
    }
  }

  // 当前一轮按候选顺序尝试；全部失败保留发现信息，定时重试而不是等待缓存再次发 up。
  private connectToPeer(peerId: string, fromIndex = 0): void {
    const info = this.discovered.get(peerId)
    if (this.stopped || !this.options || !info || this.connections.has(peerId)) return
    if (fromIndex >= info.hosts.length) {
      this.scheduleReconnect(peerId, LAN_RETRY_DELAY_MS)
      return
    }
    const target = `ws://${formatWsHost(info.hosts[fromIndex])}:${info.port}`
    let socket: WebSocket
    try {
      socket = this.createPeerSocket(target)
    } catch (error) {
      this.reportConnectionFailure(peerId, target, 'connect', error)
      this.connectToPeer(peerId, fromIndex + 1)
      return
    }
    const generation = this.lifecycleGeneration
    this.sockets.add(socket)
    this.connections.set(peerId, socket)
    let closed = false
    const handleClose = (): void => {
      if (closed) return
      closed = true
      this.clearSocketTimers(socket)
      this.sockets.delete(socket)
      if (generation !== this.lifecycleGeneration || this.stopped) return
      this.handleOutgoingClose(peerId, socket, { info, index: fromIndex })
    }
    socket.on('open', () => {
      if (
        generation !== this.lifecycleGeneration ||
        this.stopped ||
        this.connections.get(peerId) !== socket
      ) {
        socket.terminate()
        return
      }
      this.onOutgoingOpen(peerId, socket)
    })
    socket.on('message', (raw) => {
      if (generation === this.lifecycleGeneration)
        this.handleMessage(socket, peerId, raw.toString())
    })
    socket.on('close', handleClose)
    socket.on('error', (error) => {
      if (!closed && generation === this.lifecycleGeneration && !this.stopped)
        this.reportConnectionFailure(peerId, target, 'transport', error)
      handleClose()
      socket.terminate()
    })
    this.waitForSocket(socket, {
      timeoutMs: LAN_CONNECTION_TIMEOUT_MS,
      phase: 'connect',
      target,
      peerId
    })
  }

  private createPeerSocket(url: string): WebSocket {
    return new WebSocket(url, { handshakeTimeout: LAN_CONNECTION_TIMEOUT_MS })
  }

  private onOutgoingOpen(peerId: string, socket: WebSocket): void {
    this.waitForSocket(socket, {
      timeoutMs: LAN_HELLO_TIMEOUT_MS,
      phase: 'hello',
      target: socket.url,
      peerId
    })
    this.sendHello(socket)
    if (!this.boundSockets.has(socket)) this.scheduleHelloRetry(socket)
  }

  private handleOutgoingClose(
    peerId: string,
    socket: WebSocket,
    attempt: { info: DiscoveredService; index: number }
  ): void {
    if (this.connections.get(peerId) !== socket) return
    this.connections.delete(peerId)
    if (this.peers.delete(peerId)) {
      this.emitPeersChange()
      this.scheduleReconnect(peerId)
      return
    }
    const nextIndex = this.discovered.get(peerId) === attempt.info ? attempt.index + 1 : 0
    this.connectToPeer(peerId, nextIndex)
  }

  private handleIncoming(socket: WebSocket): void {
    const generation = this.lifecycleGeneration
    this.sockets.add(socket)
    this.waitForSocket(socket, {
      timeoutMs: LAN_HELLO_TIMEOUT_MS,
      phase: 'hello',
      target: INCOMING_TARGET
    })
    let boundPeerId: string | undefined
    socket.on('message', (raw) => {
      if (generation !== this.lifecycleGeneration || this.stopped) return
      const message = parseMessage(raw.toString())
      if (!message) return
      if (
        message.type === 'hello' &&
        (!isPeerId(message.peerId) || (boundPeerId !== undefined && message.peerId !== boundPeerId))
      ) {
        socket.close()
        return
      }
      if (message.type === 'hello') boundPeerId = message.peerId
      if (boundPeerId) this.handleMessage(socket, boundPeerId, raw.toString())
    })
    socket.on('error', (error) => {
      if (generation === this.lifecycleGeneration && !this.stopped)
        this.reportConnectionFailure(INCOMING_TARGET, INCOMING_TARGET, 'transport', error)
    })
    socket.on('close', () => {
      this.clearSocketTimers(socket)
      this.sockets.delete(socket)
      if (generation !== this.lifecycleGeneration || this.stopped) return
      if (boundPeerId && this.connections.get(boundPeerId) === socket)
        this.handleSocketClose(boundPeerId)
    })
  }

  private sendHello(socket: WebSocket, includeSnapshot = false): void {
    if (!this.options || !this.groupHash) return
    const hello: HelloMessage = {
      type: 'hello',
      peerId: this.options.peerId,
      nickname: this.options.nickname,
      groupHash: this.groupHash,
      role: isTeamAdmin(this.options.group, this.adminDeviceAllowed()) ? 'admin' : 'member',
      activityVersion: ACTIVITY_PROTOCOL_VERSION,
      activityEnabled: this.options.activityEnabled === true,
      ...(includeSnapshot ? { snapshot: this.options.getSnapshot() } : {})
    }
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify(this.activityAuth.decorateHello(socket, this.options.group, hello))
      )
    }
  }

  private handleMessage(socket: WebSocket, peerId: string, raw: string): void {
    if (this.stopped || !this.options || socket.readyState !== WebSocket.OPEN) return
    const message = parseMessage(raw)
    if (!message) return
    if (message.type === 'hello') {
      this.handlePeerHello(socket, peerId, message)
      return
    }
    if (this.boundSockets.get(socket) !== peerId) return
    this.connections.set(peerId, socket)
    if (message.type === 'snapshot') {
      this.applyPeerSnapshot(peerId, undefined, message.snapshot, false)
    } else if (message.type === 'message') {
      this.options?.onMessage(message)
    } else if (message.type === 'reaction') {
      this.options?.onReaction(message)
    } else if (validateActivityMessage(message)) {
      this.receiveActivity(peerId, message, socket)
    }
  }

  private handlePeerHello(socket: WebSocket, peerId: string, message: HelloMessage): void {
    const options = this.options
    const wasVerified = this.activityAuth.isVerified(this.connections.get(peerId), peerId)
    if (
      !options ||
      !this.groupHash ||
      message.groupHash !== this.groupHash ||
      message.peerId !== peerId ||
      !isPeerId(message.peerId)
    ) {
      socket.close()
      return
    }
    const requiresActivityAuth =
      message.activityVersion !== undefined ||
      message.activityNonce !== undefined ||
      message.activityProof !== undefined
    if (
      !requiresActivityAuth &&
      this.activityAuth.isVerified(this.connections.get(peerId), peerId)
    ) {
      socket.close()
      return
    }
    if (requiresActivityAuth) {
      const result = this.activityAuth.receiveHello(socket, options.group, options.peerId, message)
      if (result === 'invalid') {
        socket.close()
        return
      }
      if (this.activityAuth.needsReply(socket)) this.sendHello(socket)
      if (result === 'pending') return
    }
    const alreadyBound = this.boundSockets.get(socket) === peerId
    this.boundSockets.set(socket, peerId)
    this.connections.set(peerId, socket)
    this.clearSocketTimers(socket)
    this.clearReconnectTimer(peerId)
    this.connectionFailures.delete(peerId)
    const verified = this.activityAuth.isVerified(socket, peerId)
    const capabilityChanged = this.applyActivityCapabilities(message, verified)
    this.applyPeerSnapshot(
      message.peerId,
      message.nickname,
      message.snapshot,
      !alreadyBound || capabilityChanged || wasVerified !== verified
    )
    if (!alreadyBound) this.sendHello(socket, true)
    if (!alreadyBound)
      logDiag(`lan peer connected target=${socket.url || INCOMING_TARGET} peers=${this.peers.size}`)
  }

  private applyPeerSnapshot(
    peerId: string,
    nickname: string | undefined,
    snapshot: PeerSnapshot | undefined,
    forceNotify: boolean
  ): void {
    const existing = this.peers.get(peerId)
    // 昵称缺省时留空串,前端按 locale 显示本地化占位名;绝不用 'peer' 之类的字面量兜底,
    // 那会冒充真名出现在排行榜里,无法与成员实际设置的昵称区分
    const resolvedNickname =
      snapshot?.nickname ?? nickname ?? (snapshot ? '' : (existing?.nickname ?? ''))
    const entry: PeerEntry = {
      id: peerId,
      nickname: resolvedNickname,
      // 快照是"当前完整状态"的载体:字段缺失(序列化去掉 undefined)即表示对方当前无该数据,
      // 必须覆盖旧值,否则已消失的 5h/额度等会因 ?? 兜底永久残留;只有快照本身为空(hello 未带)才保留旧值
      authMode: snapshot ? snapshot.authMode : existing?.authMode,
      remainingPercent: snapshot ? snapshot.remainingPercent : existing?.remainingPercent,
      weeklyResetsAt: snapshot ? snapshot.weeklyResetsAt : existing?.weeklyResetsAt,
      resetCreditCount: snapshot ? snapshot.resetCreditCount : existing?.resetCreditCount,
      shortWindow: snapshot ? snapshot.shortWindow : existing?.shortWindow,
      longWindow: snapshot ? snapshot.longWindow : existing?.longWindow,
      tokenUsage: snapshot ? snapshot.tokenUsage : existing?.tokenUsage,
      costUsage: snapshot ? snapshot.costUsage : existing?.costUsage,
      tokenUsageByAgent: snapshot ? snapshot.tokenUsageByAgent : existing?.tokenUsageByAgent,
      appVersion: snapshot ? snapshot.appVersion : existing?.appVersion,
      updatedAt: new Date().toISOString()
    }
    this.peers.set(peerId, entry)
    // 接收时间持续更新；相同业务数据不重复推表，连接与权限变化仍立即通知。
    if (
      forceNotify ||
      !isDeepStrictEqual({ ...existing, updatedAt: undefined }, { ...entry, updatedAt: undefined })
    )
      this.emitPeersChange()
  }

  private handleSocketClose(peerId: string): void {
    const removed = this.connections.delete(peerId)
    if (removed && this.peers.delete(peerId)) {
      this.emitPeersChange()
      this.scheduleReconnect(peerId)
    }
  }

  private scheduleReconnect(peerId: string, delayMs = PEER_RECONNECT_DELAY_MS): void {
    if (
      this.stopped ||
      !this.options ||
      !this.groupHash ||
      !this.discovered.has(peerId) ||
      this.connections.has(peerId) ||
      this.reconnectTimers.has(peerId)
    )
      return
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(peerId)
      if (
        this.stopped ||
        !this.options ||
        !this.groupHash ||
        !this.discovered.has(peerId) ||
        this.connections.has(peerId)
      )
        return
      this.connectToPeer(peerId)
    }, delayMs)
    timer.unref()
    this.reconnectTimers.set(peerId, timer)
  }

  private clearReconnectTimer(peerId: string): void {
    const timer = this.reconnectTimers.get(peerId)
    if (timer) {
      clearTimeout(timer)
      this.reconnectTimers.delete(peerId)
    }
  }

  private scheduleHelloRetry(socket: WebSocket): void {
    const timer = setTimeout(() => {
      this.helloTimers.delete(socket)
      if (!this.stopped && socket.readyState === WebSocket.OPEN && !this.boundSockets.has(socket))
        this.sendHello(socket)
    }, HELLO_RETRY_DELAY_MS)
    timer.unref()
    this.helloTimers.set(socket, timer)
  }

  private waitForSocket(
    socket: WebSocket,
    options: { timeoutMs: number; phase: string; target: string; peerId?: string }
  ): void {
    this.clearSocketTimers(socket)
    const timer = setTimeout(() => {
      this.connectionTimers.delete(socket)
      if (this.stopped || this.boundSockets.has(socket)) return
      this.reportConnectionFailure(options.peerId ?? options.target, options.target, options.phase)
      socket.terminate()
    }, options.timeoutMs)
    timer.unref()
    this.connectionTimers.set(socket, timer)
  }

  private clearSocketTimers(socket: WebSocket): void {
    for (const timers of [this.helloTimers, this.connectionTimers]) {
      const timer = timers.get(socket)
      if (timer) clearTimeout(timer)
      timers.delete(socket)
    }
  }

  private reportConnectionFailure(
    peerId: string,
    target: string,
    phase: string,
    error?: unknown
  ): void {
    const message = error === undefined ? 'timeout' : formatDiagError(error)
    const key = `${phase}:${target}:${message}`
    const failures = this.connectionFailures.get(peerId) ?? new Set<string>()
    if (failures.has(key)) return
    failures.add(key)
    this.connectionFailures.set(peerId, failures)
    logDiag(`lan ${phase} failed target=${target} ${message}`)
  }

  private emitPeersChange(): void {
    if (this.stopped || !this.options) return
    for (const id of this.activityCapabilities.keys())
      if (!this.peers.has(id)) this.activityCapabilities.delete(id)
    this.options.onPeersChange(this.getPeers())
  }
}

export function hashGroup(group: string): string {
  return createHash('sha256')
    .update(parseTeamIdentity(group).group)
    .digest('hex')
    .slice(0, GROUP_HASH_LENGTH)
}

// 响应来源必须在公告中才优先使用，避免公告里的虚拟地址挡在物理地址之前。
function sortServiceHosts(addresses?: string[], source?: string): string[] {
  const hosts = [...new Set(addresses ?? [])]
  const v4 = hosts.filter((address) => isIPv4(address))
  const v6 = hosts.filter((address) => isIPv6(address))
  if (source && v4.includes(source)) return [source, ...v4.filter((host) => host !== source), ...v6]
  return [...v4, ...v6]
}

// IPv6 地址在 URL 里必须用方括号包裹,否则 ws 库解析抛 Invalid URL
function formatWsHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

function parseMessage(raw: string): PeerMessage | undefined {
  if (Buffer.byteLength(raw) > ACTIVITY_MAX_MESSAGE_BYTES) return undefined
  try {
    const message = JSON.parse(raw) as PeerMessage
    if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined
    if (
      (message.type === 'hello' || message.type === 'snapshot') &&
      message.snapshot !== undefined &&
      !validatePeerSnapshot(message.snapshot)
    )
      return undefined
    if (message.type === 'hello' && typeof message.nickname !== 'string') return undefined
    return message
  } catch {
    return undefined
  }
}
