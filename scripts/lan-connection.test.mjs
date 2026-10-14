/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { WebSocket } from 'ws'
import {
  LanService,
  hashGroup,
  LAN_CONNECTION_TIMEOUT_MS,
  LAN_HELLO_TIMEOUT_MS,
  LAN_RETRY_DELAY_MS
} from '../src/main/services/lan.ts'
import { ActivityConnectionAuth } from '../src/main/services/lan-activity-auth.ts'

const SELF = '10000000-0000-4000-8000-000000000001'
const PEER = '10000000-0000-4000-8000-000000000002'
const GROUP = 'connection-test'
const GROUP_HASH = hashGroup(GROUP)
const BAD_ADDRESS = '169.254.99.2'
const GOOD_ADDRESS = '10.80.30.21'

class FakeSocket extends EventEmitter {
  constructor(url) {
    super()
    this.url = url
    this.readyState = WebSocket.CONNECTING
    this.sent = []
    this.terminateCount = 0
  }
  open() {
    this.readyState = WebSocket.OPEN
    this.emit('open')
  }
  send(raw) {
    this.sent.push(JSON.parse(raw))
  }
  message(value) {
    this.emit('message', Buffer.from(JSON.stringify(value)))
  }
  close() {
    this.terminate()
  }
  terminate() {
    if (this.readyState === WebSocket.CLOSED) return
    this.terminateCount++
    this.readyState = WebSocket.CLOSED
    this.emit('close')
  }
  fail() {
    this.emit('error', new Error('offline connection failure'))
    this.terminate()
  }
}

function advertisement(overrides = {}) {
  return {
    name: PEER,
    txt: { peerId: PEER, nick: '对端', groupHash: GROUP_HASH },
    addresses: [BAD_ADDRESS, GOOD_ADDRESS],
    port: 53000,
    ...overrides
  }
}

function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
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
    const socket = new FakeSocket(url)
    sockets.push(socket)
    return socket
  }
  t.after(() => service.stop())
  return { service, sockets }
}

function legacyHello() {
  return { type: 'hello', peerId: PEER, nickname: '对端', groupHash: GROUP_HASH, snapshot: {} }
}

test('公告响应源在候选中时优先使用，不采纳名单外的来源', (t) => {
  const { service, sockets } = setup(t)
  service.handleServiceUp(advertisement({ referer: { address: GOOD_ADDRESS } }))
  assert.equal(sockets[0].url, `ws://${GOOD_ADDRESS}:53000`)
  service.handleServiceUp(advertisement({ referer: { address: '10.80.99.99' } }))
  assert.deepEqual(service.discovered.get(PEER).hosts, [BAD_ADDRESS, GOOD_ADDRESS])
  assert.equal(sockets.length, 1)
})

test('首地址悬挂最多5秒，超时终止并尝试下一地址', (t) => {
  const { service, sockets } = setup(t)
  service.handleServiceUp(advertisement())
  t.mock.timers.tick(LAN_CONNECTION_TIMEOUT_MS - 1)
  assert.equal(sockets.length, 1)
  t.mock.timers.tick(1)
  assert.equal(sockets[0].terminateCount, 1)
  assert.equal(sockets[1].url, `ws://${GOOD_ADDRESS}:53000`)
})

test('WebSocket打开但没有有效hello，10秒后关闭，不登记成员', (t) => {
  const { service, sockets } = setup(t)
  service.handleServiceUp(advertisement({ addresses: [GOOD_ADDRESS] }))
  const socket = sockets[0]
  socket.open()
  const remoteAuth = new ActivityConnectionAuth()
  socket.message(
    remoteAuth.decorateHello({}, GROUP, {
      ...legacyHello(),
      activityVersion: 1,
      role: 'member',
      activityEnabled: true
    })
  )
  assert.equal(service.getPeers().length, 0)
  t.mock.timers.tick(LAN_HELLO_TIMEOUT_MS - 1)
  assert.equal(socket.terminateCount, 0)
  t.mock.timers.tick(1)
  assert.equal(socket.terminateCount, 1)
  assert.equal(service.getPeers().length, 0)
})

test('入站连接也有握手上限，正常旧版握手会清理等待', (t) => {
  const { service } = setup(t)
  const silent = new FakeSocket('incoming-silent')
  silent.readyState = WebSocket.OPEN
  service.handleIncoming(silent)
  t.mock.timers.tick(LAN_HELLO_TIMEOUT_MS)
  assert.equal(silent.terminateCount, 1)
  const valid = new FakeSocket('incoming-valid')
  valid.readyState = WebSocket.OPEN
  service.handleIncoming(valid)
  valid.message(legacyHello())
  assert.equal(service.getPeers().length, 1)
  t.mock.timers.tick(LAN_HELLO_TIMEOUT_MS * 2)
  assert.equal(valid.terminateCount, 0)
})

test('全部地址失败保留候选，10秒主动重试，重复up不绕过重试间隔', (t) => {
  const { service, sockets } = setup(t)
  service.handleServiceUp(advertisement())
  sockets[0].fail()
  sockets[1].fail()
  assert.equal(service.discovered.has(PEER), true)
  assert.equal(service.reconnectTimers.size, 1)
  service.handleServiceUp(advertisement())
  assert.equal(sockets.length, 2)
  t.mock.timers.tick(LAN_RETRY_DELAY_MS - 1)
  assert.equal(sockets.length, 2)
  t.mock.timers.tick(1)
  assert.equal(sockets[2].url, `ws://${BAD_ADDRESS}:53000`)
})

test('候选IP/端口变化不沿用旧索引，健康连接不被周期公告关闭', (t) => {
  const { service, sockets } = setup(t)
  service.handleServiceUp(advertisement())
  service.handleServiceUp(advertisement({ addresses: ['10.80.40.21'], port: 53001 }))
  sockets[0].fail()
  assert.equal(sockets[1].url, 'ws://10.80.40.21:53001')
  sockets[1].open()
  sockets[1].message(legacyHello())
  service.handleServiceUp(advertisement({ addresses: ['10.80.50.21'], port: 53002 }))
  assert.equal(sockets.length, 2)
  assert.equal(sockets[1].terminateCount, 0)
  assert.equal(service.getPeers().length, 1)
  sockets[1].terminate()
  t.mock.timers.tick(100)
  assert.equal(sockets[2].url, 'ws://10.80.50.21:53002')
})

test('旧socket迟到close不清除新连接的等待计时器', (t) => {
  const { service, sockets } = setup(t)
  service.handleServiceUp(advertisement({ addresses: [GOOD_ADDRESS] }))
  const oldSocket = sockets[0]
  service.connections.delete(PEER)
  service.connectToPeer(PEER)
  assert.equal(sockets.length, 2)
  oldSocket.fail()
  assert.equal(service.connections.get(PEER), sockets[1])
  t.mock.timers.tick(LAN_CONNECTION_TIMEOUT_MS)
  assert.equal(sockets[1].terminateCount, 1)
  assert.equal(service.reconnectTimers.size, 1)
})

test('停止后所有socket和计时器释放，旧事件不会再次建连', (t) => {
  const { service, sockets } = setup(t)
  service.handleServiceUp(advertisement({ addresses: [GOOD_ADDRESS] }))
  sockets[0].open()
  const incoming = new FakeSocket('incoming')
  incoming.readyState = WebSocket.OPEN
  service.handleIncoming(incoming)
  service.stop()
  assert.equal(sockets[0].terminateCount, 1)
  assert.equal(incoming.terminateCount, 1)
  assert.equal(service.connectionTimers.size, 0)
  assert.equal(service.helloTimers.size, 0)
  assert.equal(service.reconnectTimers.size, 0)
  t.mock.timers.tick(LAN_RETRY_DELAY_MS * 3)
  sockets[0].emit('open')
  sockets[0].message(legacyHello())
  assert.equal(sockets.length, 1)
  assert.equal(service.getPeers().length, 0)
})

test('地址导致WebSocket构造抛错时继续下一候选，不让发现回调结束进程', (t) => {
  const { service, sockets } = setup(t)
  const createSocket = service.createPeerSocket
  service.createPeerSocket = (url) => {
    if (url.includes('%')) throw new SyntaxError('Invalid URL')
    return createSocket(url)
  }
  assert.doesNotThrow(() =>
    service.handleServiceUp(
      advertisement({
        addresses: ['fe80::1%10', '2001:db8::2']
      })
    )
  )
  assert.equal(sockets[0].url, 'ws://[2001:db8::2]:53000')
})
