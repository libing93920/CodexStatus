import { createHash, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { isIPv4, type AddressInfo } from 'node:net'
import { WebSocketServer, WebSocket } from 'ws'
import Bonjour from 'bonjour-service'
import { formatDiagError, logDiag } from './diag-log.ts'
import { ActivityConnectionAuth, type ActivityAuthHello } from './lan-activity-auth.ts'
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

const SERVICE_TYPE = 'codex-status'
const SERVICE_PROTOCOL = 'tcp' as const
const GROUP_HASH_LENGTH = 12
// hello 重发等待:连接 open 后发 hello,若此时间内未收到对方 hello 则补发一次
const HELLO_RETRY_DELAY_MS = 3000
// 广播消息约束:超长拒绝、过频丢弃(局域网无鉴权,防刷屏底线)
const BROADCAST_MAX_TEXT_LENGTH = 200
const BROADCAST_MIN_INTERVAL_MS = 2000
const PEER_RECONNECT_DELAY_MS = 100

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
  private httpServer: Server | undefined
  private wss: WebSocketServer | undefined
  private bonjour: Bonjour | undefined
  private publishedService: ReturnType<Bonjour['publish']> | undefined
  private browser: ReturnType<Bonjour['find']> | undefined
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
  private readonly helloTimers = new Map<string, NodeJS.Timeout>()
  private options: StartOptions | undefined
  private groupHash: string | undefined
  private stopped = false
  /** 上次广播时间戳,用于间隔限频 */
  private lastBroadcastAt = 0
  private lifecycleGeneration = 0
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>()

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
    for (const timer of this.helloTimers.values()) {
      clearTimeout(timer)
    }
    this.helloTimers.clear()
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer)
    }
    this.reconnectTimers.clear()
    for (const socket of this.connections.values()) {
      socket.close()
      // 进程退出/切换团队时不能等待 WebSocket 对端完成 close 握手。
      socket.terminate()
    }
    for (const socket of this.wss?.clients ?? []) socket.terminate()
    this.connections.clear()
    const peersChanged = this.peers.size > 0
    this.peers.clear()
    this.activityCapabilities.clear()
    this.discovered.clear()

    this.browser?.stop()
    this.browser = undefined
    if (this.publishedService && this.bonjour) {
      this.bonjour.unpublishAll()
    }
    this.publishedService = undefined
    this.bonjour = undefined

    this.wss?.close()
    this.wss = undefined
    this.httpServer?.close()
    this.httpServer = undefined
    const onPeersChange = this.options?.onPeersChange
    this.options = undefined
    this.groupHash = undefined

    if (peersChanged && onPeersChange) {
      onPeersChange([])
    }
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
    const localAdmin = parseTeamIdentity(this.options.group).role === 'admin'
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

  private applyActivityCapabilities(message: HelloMessage, verified: boolean): void {
    this.activityCapabilities.set(message.peerId, {
      role: message.role === 'admin' ? 'admin' : 'member',
      version:
        verified && message.activityVersion === ACTIVITY_PROTOCOL_VERSION
          ? ACTIVITY_PROTOCOL_VERSION
          : 0,
      enabled: message.activityEnabled === true
    })
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
    const localAdmin = parseTeamIdentity(this.options.group).role === 'admin'
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
    const port = (address as AddressInfo).port

    this.bonjour = new Bonjour()
    // probe:false 跳过同名探测:peerId 是 randomUUID 全局唯一,
    // 探测到的"同名"几乎总是本机旧服务未注销完的残留(TTL 未过),会导致发布失败
    this.publishedService = this.bonjour.publish({
      name: this.options.peerId,
      type: SERVICE_TYPE,
      protocol: SERVICE_PROTOCOL,
      port,
      probe: false,
      txt: {
        peerId: this.options.peerId,
        nick: this.options.nickname,
        groupHash: this.groupHash
      }
    })

    this.browser = this.bonjour.find({ type: SERVICE_TYPE, protocol: SERVICE_PROTOCOL })
    this.browser.on('up', (service) => this.handleServiceUp(service))
    this.browser.on('down', (service) => this.handleServiceDown(service))
  }

  private handleServiceUp(service: {
    name?: string
    txt?: Record<string, string>
    addresses?: string[]
    port: number
  }): void {
    if (!this.options || !this.groupHash) return
    const peerId = service.txt?.peerId
    const nickname = service.txt?.nick
    const groupHash = service.txt?.groupHash
    if (!peerId || !nickname || !groupHash) return
    if (peerId === this.options.peerId) return
    if (groupHash !== this.groupHash) return

    const hosts = sortServiceHosts(service.addresses)
    if (hosts.length === 0) return

    // 已记录或已连接则跳过
    if (this.discovered.has(peerId) || this.connections.has(peerId)) return

    this.discovered.set(peerId, { peerId, nickname, groupHash, hosts, port: service.port })
    this.connectToPeer(peerId)
  }

  private handleServiceDown(service: { name?: string }): void {
    const peerId = service.name
    if (!peerId) return
    this.clearReconnectTimer(peerId)
    this.discovered.delete(peerId)
    const socket = this.connections.get(peerId)
    if (socket) {
      socket.close()
      this.connections.delete(peerId)
    }
    if (this.peers.delete(peerId)) {
      this.emitPeersChange()
    }
  }

  // 逐个候选地址尝试连接;某地址握手失败试下一个,全失败才清 discovered 允许下次 mDNS up 重试
  private connectToPeer(peerId: string, fromIndex = 0): void {
    if (!this.discovered.has(peerId) || this.connections.has(peerId)) return
    const info = this.discovered.get(peerId)!
    if (fromIndex >= info.hosts.length) {
      // 所有地址都试过仍失败:清掉 discovered,下次 mDNS up 可重新尝试
      this.discovered.delete(peerId)
      return
    }
    const host = info.hosts[fromIndex]
    const url = `ws://${formatWsHost(host)}:${info.port}`
    const socket = new WebSocket(url)
    this.connections.set(peerId, socket)
    // close/error 可能先后触发同一 socket,用 closed 标记去重,避免重复试下一个地址
    let closed = false
    const handleClose = (): void => {
      if (closed) return
      closed = true
      this.handleOutgoingClose(peerId, socket, fromIndex)
    }

    socket.on('open', () => this.onOutgoingOpen(peerId, socket))
    socket.on('message', (raw) => this.handleMessage(socket, peerId, raw.toString()))
    socket.on('close', handleClose)
    socket.on('error', handleClose)
  }

  // 出站连接 open:发 hello 并启动重发定时器
  private onOutgoingOpen(peerId: string, socket: WebSocket): void {
    this.sendHello(socket)
    this.scheduleHelloRetry(peerId, socket)
  }
  // 出站连接关闭:若记录已被其他连接替换(说明该 peer 另有活连接),只清定时器,不算掉线
  private handleOutgoingClose(peerId: string, socket: WebSocket, fromIndex: number): void {
    const isCurrent = this.connections.get(peerId) === socket
    if (isCurrent) {
      this.connections.delete(peerId)
    }
    this.clearHelloTimer(peerId)
    if (!isCurrent) {
      return
    }
    if (this.peers.has(peerId)) {
      // 已建立过双向连接,按正常掉线处理并使用已发现地址排队重连。
      if (this.peers.delete(peerId)) {
        this.emitPeersChange()
      }
      this.scheduleReconnect(peerId)
      return
    }
    // 从未收到对方 hello:说明这条地址没通,试下一个
    this.connectToPeer(peerId, fromIndex + 1)
  }

  private handleIncoming(socket: WebSocket): void {
    let boundPeerId: string | undefined
    socket.on('message', (raw) => {
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
    socket.on('close', () => {
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
      role: parseTeamIdentity(this.options.group).role,
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
      this.applyPeerSnapshot(peerId, undefined, message.snapshot)
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
    this.applyActivityCapabilities(message, this.activityAuth.isVerified(socket, peerId))
    this.applyPeerSnapshot(message.peerId, message.nickname, message.snapshot)
    if (!alreadyBound) this.sendHello(socket, true)
  }

  private applyPeerSnapshot(
    peerId: string,
    nickname: string | undefined,
    snapshot?: PeerSnapshot
  ): void {
    const existing = this.peers.get(peerId)
    // 昵称缺省时留空串,前端按 locale 显示本地化占位名;绝不用 'peer' 之类的字面量兜底,
    // 那会冒充真名出现在排行榜里,无法与成员实际设置的昵称区分
    const resolvedNickname = snapshot?.nickname ?? nickname ?? existing?.nickname ?? ''
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
    // 收到对方数据说明双向已通,取消 hello 重发
    this.clearHelloTimer(peerId)
    this.emitPeersChange()
  }

  private handleSocketClose(peerId: string): void {
    this.clearHelloTimer(peerId)
    const removed = this.connections.delete(peerId)
    if (removed && this.peers.delete(peerId)) {
      this.emitPeersChange()
      this.scheduleReconnect(peerId)
    }
  }

  private scheduleReconnect(peerId: string): void {
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
    }, PEER_RECONNECT_DELAY_MS)
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

  // 连接 open 后启动:若 HELLO_RETRY_DELAY_MS 内未收到对方任何数据,补发一次 hello
  private scheduleHelloRetry(peerId: string, socket: WebSocket): void {
    this.clearHelloTimer(peerId)
    const timer = setTimeout(() => {
      this.helloTimers.delete(peerId)
      if (socket.readyState === WebSocket.OPEN) {
        this.sendHello(socket)
      }
    }, HELLO_RETRY_DELAY_MS)
    this.helloTimers.set(peerId, timer)
  }

  private clearHelloTimer(peerId: string): void {
    const timer = this.helloTimers.get(peerId)
    if (timer) {
      clearTimeout(timer)
      this.helloTimers.delete(peerId)
    }
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

// 候选地址排序:IPv4 优先(IPv6 链路本地地址 fe80:: 要 zone id 且 URL 要方括号,坑多)
function sortServiceHosts(addresses?: string[]): string[] {
  if (!addresses || addresses.length === 0) return []
  const v4 = addresses.filter((addr) => isIPv4(addr))
  const v6 = addresses.filter((addr) => !isIPv4(addr))
  return [...v4, ...v6]
}

// IPv6 地址在 URL 里必须用方括号包裹,否则 ws 库解析抛 Invalid URL
function formatWsHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

function parseMessage(raw: string): PeerMessage | undefined {
  if (Buffer.byteLength(raw) > ACTIVITY_MAX_MESSAGE_BYTES) return undefined
  try {
    return JSON.parse(raw) as PeerMessage
  } catch {
    return undefined
  }
}
