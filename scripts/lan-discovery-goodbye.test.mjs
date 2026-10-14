/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { Browser } from 'bonjour-service'
import { WebSocket } from 'ws'
import { LanDiscovery, LAN_DISCOVERY_REFRESH_MS } from '../src/main/services/lan-discovery.ts'
import { LanService, hashGroup, LAN_RETRY_DELAY_MS } from '../src/main/services/lan.ts'

const SELF = '10000000-0000-4000-8000-000000000001'
const PEER = '10000000-0000-4000-8000-000000000002'
const GROUP = 'goodbye-test'
const GROUP_HASH = hashGroup(GROUP)
const PHYSICAL = '10.80.10.75'
const VIRTUAL = '169.254.88.69'
const PEER_ADDRESS = '10.80.30.21'
const LOCAL_PORT = 54000
const PEER_PORT = 53000
const MDNS_PORT = 5353
const SERVICE_NAME = '_codex-status._tcp.local'
const PEER_FQDN = `${PEER}.${SERVICE_NAME}`
const PEER_HOST = 'goodbye-peer.local'
const SERVICE_TTL_SECONDS = 120
const GOODBYE_TTL = 0
const REFERER = { address: PEER_ADDRESS, port: MDNS_PORT }

class BrowserOnlyBonjour {
  constructor(binding) {
    this.binding = binding
    this.server = { mdns: new EventEmitter() }
    this.server.mdns.query = () => undefined
    this.browsers = []
    this.destroyCount = 0
  }
  publish() {
    return {}
  }
  find(options) {
    const browser = new Browser(this.server.mdns, options)
    this.browsers.push(browser)
    return browser
  }
  unpublishAll(callback) {
    callback()
  }
  destroy() {
    this.destroyCount++
  }
  get browser() {
    return this.browsers.at(-1)
  }
}

function record(type, name, data, ttl = SERVICE_TTL_SECONDS) {
  return { type, name, data, ttl }
}

function announcement() {
  const txt = { peerId: PEER, nick: '对端', groupHash: GROUP_HASH }
  return {
    answers: [record('PTR', SERVICE_NAME, PEER_FQDN)],
    additionals: [
      record('SRV', PEER_FQDN, { target: PEER_HOST, port: PEER_PORT }),
      record(
        'TXT',
        PEER_FQDN,
        Object.entries(txt).map(([key, value]) => Buffer.from(`${key}=${value}`))
      ),
      record('A', PEER_HOST, PEER_ADDRESS)
    ]
  }
}

function goodbye(overrides = {}) {
  return {
    answers: [{ ...record('PTR', SERVICE_NAME, PEER_FQDN, GOODBYE_TTL), ...overrides }],
    additionals: []
  }
}

function respond(client, packet) {
  client.server.mdns.emit('response', packet, REFERER)
}

function setup(t, callbacks = {}) {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  let addresses = [PHYSICAL, VIRTUAL]
  const clients = []
  const up = []
  const down = []
  const discovery = new LanDiscovery(
    {
      peerId: SELF,
      nickname: '本机',
      groupHash: GROUP_HASH,
      port: LOCAL_PORT,
      onUp: (service) => {
        up.push(service)
        callbacks.onUp?.(service)
      },
      onDown: (service) => {
        down.push(service.name)
        callbacks.onDown?.(service)
      }
    },
    {
      networkInterfaces: () => ({
        fixture: addresses.map((address) => ({ address, family: 'IPv4', internal: false }))
      }),
      createBonjour: (binding) => {
        const client = new BrowserOnlyBonjour(binding)
        clients.push(client)
        return client
      }
    }
  )
  t.after(() => discovery.stop())
  discovery.start()
  return {
    discovery,
    clients,
    up,
    down,
    setAddresses: (value) => {
      addresses = value
    }
  }
}

function pendingService(t) {
  const service = new LanService()
  const sockets = []
  service.options = {
    peerId: SELF,
    nickname: '本机',
    group: GROUP,
    getSnapshot: () => ({}),
    onPeersChange: () => undefined,
    onMessage: () => undefined,
    onReaction: () => undefined
  }
  service.groupHash = GROUP_HASH
  service.createPeerSocket = (url) => {
    const socket = new EventEmitter()
    socket.url = url
    socket.readyState = WebSocket.CONNECTING
    socket.terminate = () => {
      if (socket.readyState === WebSocket.CLOSED) return
      socket.readyState = WebSocket.CLOSED
      socket.emit('close')
    }
    sockets.push(socket)
    return socket
  }
  t.after(() => service.stop())
  return { service, sockets }
}

test('真实Browser刷新为空后goodbye仍撤销已知来源，重复包不重复下线', (t) => {
  const { discovery, clients, up, down } = setup(t)
  respond(clients[0], announcement())
  assert.equal(clients[0].browser.services.length, 1)
  assert.equal(up.length, 1)
  t.mock.timers.tick(LAN_DISCOVERY_REFRESH_MS)
  assert.equal(clients[0].browser.services.length, 0)
  respond(clients[0], goodbye())
  respond(clients[0], goodbye())
  assert.deepEqual(down, [PEER])
  assert.equal(discovery.sources.has(PEER), false)
  assert.equal(discovery.reported.has(PEER), false)
})

test('刷新后goodbye只撤销接收接口来源，最后一个来源离线才通知', (t) => {
  const { discovery, clients, down } = setup(t)
  for (const client of clients) respond(client, announcement())
  t.mock.timers.tick(LAN_DISCOVERY_REFRESH_MS)
  respond(clients[0], goodbye())
  assert.deepEqual(down, [])
  assert.equal(discovery.sources.get(PEER).size, 1)
  respond(clients[1], goodbye())
  assert.deepEqual(down, [PEER])
  assert.equal(discovery.sources.has(PEER), false)
})

test('未知fqdn、非本服务、非PTR和非零TTL不撤销已知来源', (t) => {
  const { discovery, clients, down } = setup(t)
  respond(clients[0], announcement())
  t.mock.timers.tick(LAN_DISCOVERY_REFRESH_MS)
  for (const override of [
    { data: `unknown.${SERVICE_NAME}` },
    { name: '_other._tcp.local' },
    { type: 'A', data: PEER_ADDRESS },
    { ttl: SERVICE_TTL_SECONDS }
  ])
    respond(clients[0], goodbye(override))
  assert.deepEqual(down, [])
  assert.equal(discovery.sources.has(PEER), true)
})

test('additionals中的goodbye按DNS名字大小写不敏感匹配', (t) => {
  const { clients, down } = setup(t)
  respond(clients[0], announcement())
  t.mock.timers.tick(LAN_DISCOVERY_REFRESH_MS)
  const packet = goodbye({ name: SERVICE_NAME.toUpperCase(), data: PEER_FQDN.toUpperCase() })
  respond(clients[0], { answers: [], additionals: packet.answers })
  assert.deepEqual(down, [PEER])
})

test('响应监听不随browser刷新累积，旧接口回调无效，停止时移除全部监听', (t) => {
  const { discovery, clients, down, setAddresses } = setup(t)
  const oldClient = clients[1]
  respond(oldClient, announcement())
  const listenerCount = oldClient.server.mdns.listenerCount('response')
  t.mock.timers.tick(LAN_DISCOVERY_REFRESH_MS * 3)
  assert.equal(oldClient.server.mdns.listenerCount('response'), listenerCount)
  const oldCallbacks = oldClient.server.mdns.listeners('response')
  setAddresses([PHYSICAL])
  t.mock.timers.tick(LAN_DISCOVERY_REFRESH_MS)
  assert.equal(oldClient.server.mdns.listenerCount('response'), 0)
  setAddresses([PHYSICAL, VIRTUAL])
  t.mock.timers.tick(LAN_DISCOVERY_REFRESH_MS)
  respond(clients[2], announcement())
  const previousDownCount = down.length
  for (const callback of oldCallbacks) callback(goodbye(), REFERER)
  assert.equal(down.length, previousDownCount)
  assert.equal(discovery.sources.has(PEER), true)
  discovery.stop()
  for (const client of clients) {
    assert.equal(client.server.mdns.listenerCount('response'), 0)
    assert.equal(client.destroyCount, 1)
  }
})

test('刷新窗口的goodbye清除LanService候选与重试，不再尝试已退出成员', (t) => {
  const { service, sockets } = pendingService(t)
  const { clients } = setup(t, {
    onUp: (advertisement) => service.handleServiceUp(advertisement),
    onDown: (advertisement) => service.handleServiceDown(advertisement)
  })
  respond(clients[0], announcement())
  assert.equal(service.discovered.has(PEER), true)
  t.mock.timers.tick(LAN_DISCOVERY_REFRESH_MS)
  assert.equal(service.reconnectTimers.size, 1)
  assert.equal(clients[0].browser.services.length, 0)
  respond(clients[0], goodbye())
  assert.equal(service.discovered.has(PEER), false)
  assert.equal(service.reconnectTimers.size, 0)
  const attemptedSockets = sockets.length
  t.mock.timers.tick(LAN_RETRY_DELAY_MS * 3)
  assert.equal(sockets.length, attemptedSockets)
})
