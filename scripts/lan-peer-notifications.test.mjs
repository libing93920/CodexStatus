/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import test from 'node:test'
import { WebSocket } from 'ws'
import { LanService, hashGroup } from '../src/main/services/lan.ts'
import { ActivityConnectionAuth } from '../src/main/services/lan-activity-auth.ts'
import { setDiagDirectory } from '../src/main/services/diag-log.ts'

const SCRATCH_DIRECTORY = process.env.PI_SCRATCH_DIR
assert.ok(SCRATCH_DIRECTORY, '请通过 scripts/run-with-test-scratch.mjs 运行测试')
setDiagDirectory(join(SCRATCH_DIRECTORY, 'lan-peer-notifications'))

const SELF = '10000000-0000-4000-8000-000000000001'
const PEER = '10000000-0000-4000-8000-000000000002'
const GROUP = 'peer-notification-test'
const GROUP_HASH = hashGroup(GROUP)
const DEEP_SNAPSHOT_DEPTH = 1_200

function setup(t) {
  const service = new LanService(() => true)
  const notifications = []
  service.options = {
    peerId: SELF,
    nickname: '本机',
    group: `${GROUP}GM`,
    activityEnabled: true,
    getSnapshot: () => ({}),
    onPeersChange: (peers) => notifications.push(peers),
    onMessage: () => undefined,
    onReaction: () => undefined
  }
  service.groupHash = GROUP_HASH
  const socket = {
    readyState: WebSocket.OPEN,
    sent: [],
    send(raw) {
      this.sent.push(JSON.parse(raw))
    },
    close() {
      this.readyState = WebSocket.CLOSED
    },
    terminate() {
      this.close()
    }
  }
  t.after(() => service.stop())
  return { service, socket, notifications }
}

function snapshot() {
  return {
    nickname: '成员',
    authMode: 'chatgpt',
    remainingPercent: 50,
    weeklyResetsAt: '2026-10-19T00:00:00Z',
    resetCreditCount: 1,
    shortWindow: { label: '5h', remainingPercent: 50 },
    longWindow: { label: '7d', remainingPercent: 80 },
    tokenUsage: { '1d': 2, '7d': 3 },
    costUsage: { '1d': 1, '7d': 2 },
    tokenUsageByAgent: { '1d': { codex: 2, claude: 1 } },
    appVersion: '1.3.26'
  }
}

function hello(overrides = {}) {
  return {
    type: 'hello',
    peerId: PEER,
    nickname: '成员',
    groupHash: GROUP_HASH,
    snapshot: snapshot(),
    ...overrides
  }
}

function send(fixture, message) {
  fixture.service.handleMessage(fixture.socket, PEER, JSON.stringify(message))
}

function deepSnapshotMessage() {
  const nested = '{"x":'.repeat(DEEP_SNAPSHOT_DEPTH) + '0' + '}'.repeat(DEEP_SNAPSHOT_DEPTH)
  return '{"type":"snapshot","snapshot":{"nickname":"成员","tokenUsage":{"1d":' + nested + '}}}'
}

function authenticate(fixture) {
  const remote = new ActivityConnectionAuth()
  const remoteSocket = {}
  const header = { role: 'member', activityVersion: 1, activityEnabled: true }
  send(fixture, remote.decorateHello(remoteSocket, GROUP, hello(header)))
  assert.equal(
    remote.receiveHello(remoteSocket, GROUP, PEER, fixture.socket.sent.at(-1)),
    'verified'
  )
  send(fixture, remote.decorateHello(remoteSocket, GROUP, hello(header)))
  return (update) =>
    send(fixture, remote.decorateHello(remoteSocket, GROUP, hello({ ...header, ...update })))
}

test('相同快照仅更新接收时间，嵌套对象属性顺序不同不重复通知', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-14T08:00:00Z') })
  const fixture = setup(t)
  send(fixture, hello())
  assert.equal(fixture.notifications.length, 1)
  const receivedAt = fixture.service.getPeers()[0].updatedAt
  t.mock.timers.tick(1_000)
  const reordered = snapshot()
  reordered.shortWindow = { remainingPercent: 50, label: '5h' }
  reordered.tokenUsage = { '7d': 3, '1d': 2 }
  reordered.tokenUsageByAgent = { '1d': { claude: 1, codex: 2 } }
  send(fixture, { type: 'snapshot', snapshot: reordered })
  send(fixture, hello())
  assert.equal(fixture.notifications.length, 1)
  assert.notEqual(fixture.service.getPeers()[0].updatedAt, receivedAt)
})

test('成员业务字段变化和完整快照删除字段都会通知，旧数据不残留', (t) => {
  const fixture = setup(t)
  send(fixture, hello())
  const updates = [
    { nickname: '改名' },
    { authMode: 'api' },
    { remainingPercent: 40 },
    { weeklyResetsAt: '2026-10-20T00:00:00Z' },
    { resetCreditCount: 2 },
    { shortWindow: { label: '5h', remainingPercent: 40 } },
    { longWindow: { label: '7d', remainingPercent: 70 } },
    { tokenUsage: { '1d': 8, '7d': 9 } },
    { costUsage: { '1d': 8 } },
    { tokenUsageByAgent: { '1d': { codex: 3, claude: 1 } } },
    { appVersion: '1.3.27' }
  ]
  for (const update of updates) {
    const count = fixture.notifications.length
    send(fixture, { type: 'snapshot', snapshot: { ...snapshot(), ...update } })
    assert.equal(fixture.notifications.length, count + 1)
  }
  const count = fixture.notifications.length
  send(fixture, { type: 'snapshot', snapshot: { nickname: '成员' } })
  assert.equal(fixture.notifications.length, count + 1)
  const peer = fixture.service.getPeers()[0]
  assert.equal(peer.shortWindow, undefined)
  assert.equal(peer.tokenUsage, undefined)
  assert.equal(peer.appVersion, undefined)
})

test('业务内容相同时已认证活动能力和角色变化仍立即通知并更新权限', (t) => {
  const fixture = setup(t)
  const changeHello = authenticate(fixture)
  const initialCount = fixture.notifications.length
  changeHello({})
  assert.equal(fixture.notifications.length, initialCount)
  assert.equal(fixture.service.getPeers()[0].activitySupported, true)
  changeHello({ activityEnabled: false })
  assert.equal(fixture.notifications.length, initialCount + 1)
  assert.equal(fixture.service.getPeers()[0].activityEnabled, false)
  changeHello({ role: 'admin' })
  assert.equal(fixture.notifications.length, initialCount + 2)
  assert.deepEqual(fixture.service.getActivityAdminIds(), [PEER])
  changeHello({ role: 'member' })
  assert.equal(fixture.notifications.length, initialCount + 3)
  assert.deepEqual(fixture.service.getActivityAdminIds(), [])
})

test('缺少昵称的完整快照会清空旧昵称，未携带快照的握手保留现有数据', (t) => {
  const fixture = setup(t)
  send(fixture, hello())
  send(fixture, hello({ snapshot: undefined }))
  assert.equal(fixture.notifications.length, 1)
  assert.equal(fixture.service.getPeers()[0].nickname, '成员')
  assert.equal(fixture.service.getPeers()[0].remainingPercent, 50)

  send(fixture, { type: 'snapshot', snapshot: {} })
  assert.equal(fixture.notifications.length, 2)
  assert.equal(fixture.service.getPeers()[0].nickname, '')
  send(fixture, { type: 'snapshot', snapshot: {} })
  assert.equal(fixture.notifications.length, 2)
})

test('成员离线及重连不能被相同快照去重吞掉', (t) => {
  const fixture = setup(t)
  send(fixture, hello())
  fixture.service.handleSocketClose(PEER)
  assert.equal(fixture.notifications.length, 2)
  assert.deepEqual(fixture.notifications[1], [])
  send(fixture, hello())
  assert.equal(fixture.notifications.length, 3)
  assert.equal(fixture.service.getPeers()[0].id, PEER)
})

test('生产入站回调拒绝深层异常快照，不抛错、不覆盖缓存，后续正常快照仍生效', (t) => {
  const fixture = setup(t)
  fixture.socket = Object.assign(new EventEmitter(), fixture.socket)
  fixture.service.handleIncoming(fixture.socket)
  fixture.socket.emit('message', Buffer.from(JSON.stringify(hello())))
  const before = fixture.service.getPeers()
  const raw = Buffer.from(deepSnapshotMessage())
  assert.doesNotThrow(() => {
    fixture.socket.emit('message', raw)
    fixture.socket.emit('message', raw)
  })
  assert.deepEqual(fixture.service.getPeers(), before)
  assert.equal(fixture.notifications.length, 1)
  fixture.socket.emit(
    'message',
    Buffer.from(
      JSON.stringify({ type: 'snapshot', snapshot: { ...snapshot(), remainingPercent: 40 } })
    )
  )
  assert.equal(fixture.service.getPeers()[0].remainingPercent, 40)
  assert.equal(fixture.notifications.length, 2)
})

test('快照容器和已知字段必须符合固定结构，非法字段不会覆盖现有数据', (t) => {
  const fixture = setup(t)
  send(fixture, hello())
  const before = fixture.service.getPeers()
  const invalid = [
    null,
    [],
    1,
    'invalid',
    { nickname: {} },
    { authMode: 'invalid' },
    { remainingPercent: Number.POSITIVE_INFINITY },
    { weeklyResetsAt: {} },
    { resetCreditCount: '1' },
    { appVersion: {} },
    { shortWindow: { label: {} } },
    { shortWindow: { label: '5h', remainingPercent: '50' } },
    { longWindow: { label: '7d', unexpected: {} } },
    { tokenUsage: { '1d': {} } },
    { tokenUsage: { '1h': 1 } },
    { costUsage: [] },
    { tokenUsageByAgent: { '1d': { codex: {} } } },
    { tokenUsageByAgent: { '1d': { unexpected: 1 } } },
    { tokenUsageByAgent: { '31d': { codex: 1 } } },
    { unexpected: {} }
  ]
  for (const value of invalid) {
    send(fixture, { type: 'snapshot', snapshot: value })
    assert.deepEqual(fixture.service.getPeers(), before)
    assert.equal(fixture.notifications.length, 1)
  }
})

test('携带非法快照或非字符串昵称的Hello不登记身份和发送握手', (t) => {
  for (const value of [hello({ snapshot: [] }), hello({ nickname: {} })]) {
    const fixture = setup(t)
    send(fixture, value)
    assert.deepEqual(fixture.service.getPeers(), [])
    assert.deepEqual(fixture.socket.sent, [])
  }
})

test('已认证Hello中的非法快照不能改变活动能力，后续有效角色变更正常生效', (t) => {
  const fixture = setup(t)
  const changeHello = authenticate(fixture)
  const before = fixture.service.getPeers()
  const count = fixture.notifications.length
  changeHello({ role: 'admin', snapshot: { tokenUsage: { '1d': {} } } })
  assert.deepEqual(fixture.service.getPeers(), before)
  assert.deepEqual(fixture.service.getActivityAdminIds(), [])
  assert.equal(fixture.notifications.length, count)
  changeHello({ role: 'admin' })
  assert.deepEqual(fixture.service.getActivityAdminIds(), [PEER])
  assert.equal(fixture.notifications.length, count + 1)
})

test('合法零值、空昵称和部分用量映射不会被结构验证过滤', (t) => {
  const fixture = setup(t)
  const value = {
    nickname: '',
    authMode: 'none',
    remainingPercent: 0,
    weeklyResetsAt: '',
    resetCreditCount: 0,
    shortWindow: { label: '5h' },
    longWindow: { label: '7d', remainingPercent: 0 },
    tokenUsage: { '1d': 0, '7d': 0, '30d': 0 },
    costUsage: { '1d': 0 },
    tokenUsageByAgent: { '1d': { codex: 0, claude: 0, opencode: 0 }, '7d': {} },
    appVersion: ''
  }
  send(fixture, hello({ snapshot: value }))
  const received = fixture.service.getPeers()[0]
  assert.equal(received.nickname, '')
  assert.equal(received.authMode, 'none')
  assert.equal(received.remainingPercent, 0)
  assert.equal(received.resetCreditCount, 0)
  assert.deepEqual(received.shortWindow, { label: '5h' })
  assert.deepEqual(received.longWindow, { label: '7d', remainingPercent: 0 })
  assert.deepEqual(received.tokenUsage, value.tokenUsage)
  assert.deepEqual(received.costUsage, value.costUsage)
  assert.deepEqual(received.tokenUsageByAgent, value.tokenUsageByAgent)
})
