import { createHash, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { isIPv4, type AddressInfo } from 'node:net'
import { WebSocketServer, WebSocket } from 'ws'
import Bonjour from 'bonjour-service'
import type {
  AuthMode,
  BroadcastMessage,
  BroadcastSendResult,
  ReactionMessage,
  ReactionSendResult,
  TeamPeer,
  UsageWindow
} from '../../shared/capsule'

const SERVICE_TYPE = 'codex-status'
const SERVICE_PROTOCOL = 'tcp' as const
const GROUP_HASH_LENGTH = 12
// hello 重发等待:连接 open 后发 hello,若此时间内未收到对方 hello 则补发一次
const HELLO_RETRY_DELAY_MS = 3000
// 广播消息约束:超长拒绝、过频丢弃(局域网无鉴权,防刷屏底线)
const BROADCAST_MAX_TEXT_LENGTH = 200
const BROADCAST_MIN_INTERVAL_MS = 2000

/** peer 间互发的派生展示数据:绝不包含 Codex 凭据 */
export interface PeerSnapshot {
  /** 昵称:每次快照随带,避免只随 hello 传导致竞态显示兜底 'peer' */
  nickname?: string
  /** 登录方式:api=API Key(无订阅额度,额度榜不展示) */
  authMode?: AuthMode
  remainingPercent?: number
  weeklyResetsAt?: string
  bestModelLabel?: string
  resetCreditCount?: number
  /** 短窗口(5h)展示用:label + 剩余% */
  shortWindow?: { label: string; remainingPercent?: number }
  /** 长窗口(7d/1周)展示用:label + 剩余% */
  longWindow?: { label: string; remainingPercent?: number }
  /** 各窗口 token 消耗总数(1d/7d/30d) */
  tokenUsage?: Partial<Record<UsageWindow, number>>
  /** 应用版本:接收端以组内最高版本为基准判定是否最新 */
  appVersion?: string
}

interface PeerEntry {
  id: string
  nickname: string
  authMode?: AuthMode
  remainingPercent?: number
  weeklyResetsAt?: string
  bestModelLabel?: string
  resetCreditCount?: number
  shortWindow?: { label: string; remainingPercent?: number }
  longWindow?: { label: string; remainingPercent?: number }
  tokenUsage?: Partial<Record<UsageWindow, number>>
  appVersion?: string
  updatedAt?: string
}

interface StartOptions {
  peerId: string
  nickname: string
  group: string
  /** 获取本机最新派生数据,用于广播给已连 peer */
  getSnapshot: () => PeerSnapshot
  /** peer 列表变化时回调,主进程据此刷新团队页 */
  onPeersChange: (peers: TeamPeer[]) => void
  /** 收到同组广播消息时回调,主进程据此推给渲染层 */
  onMessage: (message: BroadcastMessage) => void
  /** 收到同组点赞事件时回调,主进程据此推给渲染层 */
  onReaction: (reaction: ReactionMessage) => void
}

interface HelloMessage {
  type: 'hello'
  peerId: string
  nickname: string
  groupHash: string
  snapshot?: PeerSnapshot
}

interface SnapshotMessage {
  type: 'snapshot'
  snapshot?: PeerSnapshot
}

type PeerMessage = HelloMessage | SnapshotMessage | BroadcastMessage | ReactionMessage

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
  private readonly peers = new Map<string, PeerEntry>()
  private readonly discovered = new Map<string, DiscoveredService>()
  // hello 重发定时器:连接 open 后若未及时收到对方 hello 则补发
  private readonly helloTimers = new Map<string, NodeJS.Timeout>()
  private options: StartOptions | undefined
  private groupHash: string | undefined
  private stopped = false
  /** 上次广播时间戳,用于间隔限频 */
  private lastBroadcastAt = 0

  start(options: StartOptions): void {
    if (this.options) {
      this.stop()
    }
    this.stopped = false
    this.options = options
    this.groupHash = hashGroup(options.group)
    this.peers.clear()
    this.discovered.clear()

    this.startServer().then(
      () => this.startDiscovery(),
      (error) => console.warn('[codex-status] lan server start failed:', message(error))
    )
  }

  stop(): void {
    this.stopped = true
    for (const timer of this.helloTimers.values()) {
      clearTimeout(timer)
    }
    this.helloTimers.clear()
    for (const socket of this.connections.values()) {
      socket.close()
    }
    this.connections.clear()
    const peersChanged = this.peers.size > 0
    this.peers.clear()
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
    for (const socket of this.connections.values()) {
      if (socket.readyState === WebSocket.OPEN) {
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
    for (const socket of this.connections.values()) {
      if (socket.readyState === WebSocket.OPEN) {
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
    for (const socket of this.connections.values()) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(payload)
      }
    }
    return { ok: true, reaction }
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
      appVersion: entry.appVersion,
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

  // 出站连接关闭:若从未收到对方 hello(双向未建立),试下一个地址或清理
  private handleOutgoingClose(peerId: string, socket: WebSocket, fromIndex: number): void {
    // 仅当 connections 仍指向当前 socket 才清理,避免误清新发起的连接
    if (this.connections.get(peerId) === socket) {
      this.connections.delete(peerId)
    }
    this.clearHelloTimer(peerId)
    if (this.peers.has(peerId)) {
      // 已建立过双向连接,按正常掉线处理
      if (this.peers.delete(peerId)) {
        this.emitPeersChange()
      }
      return
    }
    // 从未收到对方 hello:说明这条地址没通,试下一个
    this.connectToPeer(peerId, fromIndex + 1)
  }

  private handleIncoming(socket: WebSocket): void {
    socket.on('message', (raw) => {
      const message = parseMessage(raw.toString())
      if (!message || message.type !== 'hello') return
      // 入站连接:校验 groupHash,登记 peerId,绑定 socket
      if (!this.groupHash || message.groupHash !== this.groupHash) {
        socket.close()
        return
      }
      this.connections.set(message.peerId, socket)
      this.applyPeerSnapshot(message.peerId, message.nickname, message.snapshot)
      this.sendHello(socket)
      // 被动方也补发保险:防止我方 hello 丢失导致对端单向
      this.scheduleHelloRetry(message.peerId, socket)
      socket.on('close', () => this.handleSocketClose(message.peerId))
    })
  }

  private sendHello(socket: WebSocket): void {
    if (!this.options || !this.groupHash) return
    const hello: HelloMessage = {
      type: 'hello',
      peerId: this.options.peerId,
      nickname: this.options.nickname,
      groupHash: this.groupHash,
      snapshot: this.options.getSnapshot()
    }
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(hello))
    }
  }

  private handleMessage(socket: WebSocket, peerId: string, raw: string): void {
    const message = parseMessage(raw)
    if (!message) return
    if (message.type === 'hello') {
      if (!this.groupHash || message.groupHash !== this.groupHash) {
        socket.close()
        return
      }
      this.applyPeerSnapshot(message.peerId, message.nickname, message.snapshot)
    } else if (message.type === 'snapshot') {
      this.applyPeerSnapshot(peerId, undefined, message.snapshot)
    } else if (message.type === 'message') {
      this.options?.onMessage(message)
    } else if (message.type === 'reaction') {
      this.options?.onReaction(message)
    }
  }

  private applyPeerSnapshot(
    peerId: string,
    nickname: string | undefined,
    snapshot?: PeerSnapshot
  ): void {
    const existing = this.peers.get(peerId)
    // 昵称缺省时留空串,前端按 locale 显示本地化占位名;绝不用 'peer' 之类的字面量兜底,
    // 那会冒充真名出现在排行榜里,无法与成员实际设置的昵称区分
    const resolvedNickname =
      snapshot?.nickname ?? nickname ?? existing?.nickname ?? ''
    const entry: PeerEntry = {
      id: peerId,
      nickname: resolvedNickname,
      authMode: snapshot?.authMode ?? existing?.authMode,
      remainingPercent: snapshot?.remainingPercent ?? existing?.remainingPercent,
      weeklyResetsAt: snapshot?.weeklyResetsAt ?? existing?.weeklyResetsAt,
      bestModelLabel: snapshot?.bestModelLabel ?? existing?.bestModelLabel,
      resetCreditCount: snapshot?.resetCreditCount ?? existing?.resetCreditCount,
      shortWindow: snapshot?.shortWindow ?? existing?.shortWindow,
      longWindow: snapshot?.longWindow ?? existing?.longWindow,
      tokenUsage: snapshot?.tokenUsage ?? existing?.tokenUsage,
      appVersion: snapshot?.appVersion ?? existing?.appVersion,
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
    this.options.onPeersChange(this.getPeers())
  }
}

function hashGroup(group: string): string {
  return createHash('sha256').update(group).digest('hex').slice(0, GROUP_HASH_LENGTH)
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
  try {
    return JSON.parse(raw) as PeerMessage
  } catch {
    return undefined
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
