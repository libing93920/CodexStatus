import { type EventEmitter } from 'node:events'
import { isIPv4 } from 'node:net'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import Bonjour from 'bonjour-service'
import { formatDiagError, logDiag } from './diag-log.ts'

export const LAN_DISCOVERY_REFRESH_MS = 10_000
const SERVICE_TYPE = 'codex-status'
const SERVICE_PROTOCOL = 'tcp' as const
const SERVICE_QUERY_NAME = `_${SERVICE_TYPE}._${SERVICE_PROTOCOL}.local`
const GOODBYE_TTL = 0
const RECEIVE_ADDRESS = '0.0.0.0'
const IPV4_MULTICAST_FIRST_OCTET = 224
const MAX_PORT = 65_535

export interface LanAdvertisement {
  name?: string
  fqdn?: string
  txt?: Record<string, string>
  addresses?: string[]
  port: number
  referer?: { address: string }
}

interface LanInterface {
  name: string
  address: string
}

interface DiscoveryOptions {
  peerId: string
  nickname: string
  groupHash: string
  port: number
  onUp: (service: LanAdvertisement) => void
  onDown: (service: { name?: string }) => void
}

type InterfaceBinding = NonNullable<ConstructorParameters<typeof Bonjour>[0]> & {
  interface: string
  bind: string
  reuseAddr: boolean
}

interface DiscoveryDependencies {
  networkInterfaces: typeof networkInterfaces
  createBonjour: (binding: InterfaceBinding, onError: (error: unknown) => void) => Bonjour
}

interface MdnsRecord {
  type?: string
  name?: string
  data?: unknown
  ttl?: number
}

interface MdnsResponse {
  answers?: MdnsRecord[]
  additionals?: MdnsRecord[]
}

interface InterfaceDiscovery {
  bonjour: Bonjour
  mdns: EventEmitter
  onResponse: (packet: MdnsResponse) => void
  browser?: ReturnType<Bonjour['find']>
}

function getBonjourMdns(bonjour: Bonjour): EventEmitter {
  return (bonjour as unknown as { server: { mdns: EventEmitter } }).server.mdns
}

function createBonjour(binding: InterfaceBinding, onError: (error: unknown) => void): Bonjour {
  const bonjour = new Bonjour(binding, onError)
  // 当前依赖只为发送回调提供错误入口，底层 socket 错误仍需接管，避免单接口失败结束进程。
  const mdns = getBonjourMdns(bonjour)
  mdns.on('error', onError)
  const warnings = new Set<string>()
  mdns.on('warning', (error: unknown) => {
    const message = formatDiagError(error)
    if (warnings.has(message)) return
    warnings.add(message)
    logDiag(`lan discovery warning interface=${binding.interface} ${message}`)
  })
  return bonjour
}

/** 不依赖虚拟网卡标志；每个可用 IPv4 出口都独立发送，避免默认路由抢占。 */
export function getLanInterfaces(
  networks: Record<string, NetworkInterfaceInfo[] | undefined> = networkInterfaces()
): LanInterface[] {
  const interfaces = new Map<string, LanInterface>()
  for (const [name, entries] of Object.entries(networks)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || !isIPv4(entry.address)) continue
      const firstOctet = Number(entry.address.split('.')[0])
      if (firstOctet === 0 || firstOctet === 127 || firstOctet >= IPV4_MULTICAST_FIRST_OCTET)
        continue
      interfaces.set(entry.address, { name, address: entry.address })
    }
  }
  return [...interfaces.values()]
}

export class LanDiscovery {
  private readonly options: DiscoveryOptions
  private readonly dependencies: DiscoveryDependencies
  private readonly instances = new Map<string, InterfaceDiscovery>()
  private readonly sources = new Map<string, Map<string, LanAdvertisement>>()
  private readonly reported = new Map<string, string>()
  private readonly errors = new Map<string, string>()
  private timer: NodeJS.Timeout | undefined
  private stopped = true

  constructor(options: DiscoveryOptions, dependencies: Partial<DiscoveryDependencies> = {}) {
    this.options = options
    this.dependencies = { networkInterfaces, createBonjour, ...dependencies }
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.refresh()
    this.timer = setInterval(() => this.refresh(), LAN_DISCOVERY_REFRESH_MS)
    this.timer.unref()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.sources.clear()
    this.reported.clear()
    for (const address of this.instances.keys()) this.removeInterface(address)
    this.errors.clear()
  }

  private refresh(): void {
    if (this.stopped) return
    const interfaces = getLanInterfaces(this.dependencies.networkInterfaces())
    const addresses = new Set(interfaces.map((entry) => entry.address))
    for (const address of this.instances.keys()) {
      if (!addresses.has(address)) this.removeInterface(address)
    }
    for (const entry of interfaces) {
      const instance = this.instances.get(entry.address)
      if (instance) this.refreshBrowser(entry.address, instance)
      else this.addInterface(entry)
    }
  }

  private addInterface(entry: LanInterface): void {
    try {
      const bonjour = this.dependencies.createBonjour(
        { interface: entry.address, bind: RECEIVE_ADDRESS, reuseAddr: true },
        (error) => {
          if (this.instances.get(entry.address)?.bonjour === bonjour)
            this.handleInterfaceError(entry.address, error)
        }
      )
      const mdns = getBonjourMdns(bonjour)
      const instance: InterfaceDiscovery = {
        bonjour,
        mdns,
        onResponse: (packet) => {
          if (this.stopped || this.instances.get(entry.address) !== instance) return
          this.handleGoodbyes(entry.address, packet)
        }
      }
      this.instances.set(entry.address, instance)
      // goodbye 用保留的来源识别，不能依赖每轮重建的 browser 缓存。
      mdns.on('response', instance.onResponse)
      // peerId 全局唯一；默认同名探测会把本机旧公告误判为冲突。
      bonjour.publish({
        name: this.options.peerId,
        type: SERVICE_TYPE,
        protocol: SERVICE_PROTOCOL,
        port: this.options.port,
        probe: false,
        txt: {
          peerId: this.options.peerId,
          nick: this.options.nickname,
          groupHash: this.options.groupHash
        }
      })
      this.refreshBrowser(entry.address, instance)
      logDiag(`lan discovery interface added address=${entry.address}`)
    } catch (error) {
      this.handleInterfaceError(entry.address, error)
    }
  }

  private refreshBrowser(address: string, instance: InterfaceDiscovery): void {
    instance.browser?.stop()
    // 换 browser 清除依赖的同名缓存，确保仅 IP 变化或首次失败后仍可重新发现。
    const browser = instance.bonjour.find({ type: SERVICE_TYPE, protocol: SERVICE_PROTOCOL })
    instance.browser = browser
    const isCurrent = (): boolean =>
      !this.stopped && this.instances.get(address) === instance && instance.browser === browser
    const accept = (service: LanAdvertisement): void => {
      if (isCurrent()) this.acceptService(address, service)
    }
    browser.on('up', accept)
    browser.on('srv-update', accept)
    browser.on('txt-update', accept)
    browser.on('down', (service) => {
      if (isCurrent()) this.removeSource(service.txt?.peerId ?? service.name, address)
    })
  }

  private handleGoodbyes(address: string, packet: MdnsResponse): void {
    const goodbyes = new Set<string>()
    for (const record of [...(packet.answers ?? []), ...(packet.additionals ?? [])]) {
      if (
        record.type === 'PTR' &&
        record.ttl === GOODBYE_TTL &&
        record.name?.toLowerCase() === SERVICE_QUERY_NAME &&
        typeof record.data === 'string'
      ) {
        goodbyes.add(record.data.toLowerCase())
      }
    }
    if (goodbyes.size === 0) return
    for (const [peerId, sources] of this.sources) {
      const fqdn = sources.get(address)?.fqdn
      if (fqdn && goodbyes.has(fqdn.toLowerCase())) this.removeSource(peerId, address)
    }
  }

  private acceptService(address: string, service: LanAdvertisement): void {
    const peerId = service.txt?.peerId
    if (!peerId || peerId === this.options.peerId) return
    if (
      !service.txt?.nick ||
      service.txt.groupHash !== this.options.groupHash ||
      !Number.isInteger(service.port) ||
      service.port <= 0 ||
      service.port > MAX_PORT ||
      !service.addresses?.length
    ) {
      this.removeSource(peerId, address)
      return
    }
    this.errors.delete(address)
    const sources = this.sources.get(peerId) ?? new Map<string, LanAdvertisement>()
    sources.delete(address)
    sources.set(address, service)
    this.sources.set(peerId, sources)
    this.reportPeer(peerId)
  }

  private reportPeer(peerId: string): void {
    const sources = [...(this.sources.get(peerId)?.values() ?? [])]
    const latest = sources.at(-1)
    if (!latest) return
    const addresses = [
      ...new Set(
        sources
          .filter((source) => source.port === latest.port)
          .flatMap((source) => source.addresses ?? [])
      )
    ].sort()
    const service = { ...latest, name: peerId, addresses }
    const fingerprint = JSON.stringify({
      addresses,
      port: service.port,
      nickname: service.txt?.nick,
      source: service.referer?.address
    })
    if (this.reported.get(peerId) === fingerprint) return
    this.reported.set(peerId, fingerprint)
    this.options.onUp(service)
  }

  private removeSource(peerId: string | undefined, address: string): void {
    if (!peerId) return
    const sources = this.sources.get(peerId)
    if (!sources?.delete(address)) return
    if (sources.size > 0) {
      this.reportPeer(peerId)
      return
    }
    this.sources.delete(peerId)
    this.reported.delete(peerId)
    if (!this.stopped) this.options.onDown({ name: peerId })
  }

  private removeInterface(address: string): void {
    const instance = this.instances.get(address)
    if (!instance) return
    this.instances.delete(address)
    instance.mdns.removeListener('response', instance.onResponse)
    instance.browser?.stop()
    for (const peerId of this.sources.keys()) this.removeSource(peerId, address)
    let destroyed = false
    const destroy = (): void => {
      if (destroyed) return
      destroyed = true
      try {
        instance.bonjour.destroy()
      } catch (error) {
        this.reportError(address, error)
      }
    }
    try {
      instance.bonjour.unpublishAll(destroy)
    } catch (error) {
      this.reportError(address, error)
      destroy()
    }
    logDiag(`lan discovery interface removed address=${address}`)
  }

  private handleInterfaceError(address: string, error: unknown): void {
    if (this.stopped) return
    this.reportError(address, error)
    this.removeInterface(address)
  }

  private reportError(address: string, error: unknown): void {
    const message = formatDiagError(error)
    if (this.errors.get(address) === message) return
    this.errors.set(address, message)
    logDiag(`lan discovery failed interface=${address} ${message}`)
  }
}
