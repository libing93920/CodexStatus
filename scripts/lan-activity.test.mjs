/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import test from 'node:test'
import { LanService, hashGroup } from '../src/main/services/lan.ts'
import { ActivityConnectionAuth } from '../src/main/services/lan-activity-auth.ts'
import { WebSocket } from 'ws'

const DATE = '2026-10-13'
const ADMIN = '10000000-0000-4000-8000-000000000001'
const MEMBER = '10000000-0000-4000-8000-000000000002'
const GROUP = 'desktop-team'
const TEAM_HASH = hashGroup(GROUP)

function authHello(peerId, role = 'member') {
  return { peerId, role, activityVersion: 1, activityEnabled: true }
}

test('活动认证绑定随机挑战、身份和能力，拒绝公开hash密钥、篡改与跨连接重放', () => {
  const memberAuth = new ActivityConnectionAuth()
  const adminAuth = new ActivityConnectionAuth()
  const memberSocket = {},
    adminSocket = {}
  const memberHello = memberAuth.decorateHello(memberSocket, GROUP, authHello(MEMBER))
  assert.equal(adminAuth.receiveHello(adminSocket, `${GROUP}GM`, ADMIN, memberHello), 'pending')
  const adminProof = adminAuth.decorateHello(adminSocket, `${GROUP}GM`, authHello(ADMIN, 'admin'))
  assert.equal(memberAuth.receiveHello(memberSocket, GROUP, MEMBER, adminProof), 'verified')
  const memberProof = memberAuth.decorateHello(memberSocket, GROUP, authHello(MEMBER))
  assert.equal(adminAuth.receiveHello(adminSocket, `${GROUP}GM`, ADMIN, memberProof), 'verified')
  assert.equal(memberAuth.isVerified(memberSocket, ADMIN), true)
  assert.equal(memberAuth.isVerified({}, ADMIN), false)
  assert.equal(memberAuth.receiveHello({}, GROUP, MEMBER, adminProof), 'invalid')
  assert.equal(
    memberAuth.receiveHello(memberSocket, GROUP, MEMBER, { ...adminProof, role: 'member' }),
    'invalid'
  )
  assert.equal(memberAuth.isVerified(memberSocket, ADMIN), false)
  assert.equal(
    memberAuth.receiveHello(memberSocket, GROUP, MEMBER, {
      ...adminProof,
      activityProof: [adminProof.activityProof]
    }),
    'invalid'
  )
  assert.equal(memberAuth.receiveHello(memberSocket, TEAM_HASH, MEMBER, adminProof), 'invalid')
})

test('未验证出站socket收不到三类广播，完成绑定后恢复发送', () => {
  const service = new LanService()
  const socket = {
    readyState: WebSocket.OPEN,
    sent: [],
    send(payload) {
      this.sent.push(JSON.parse(payload))
    },
    close: () => undefined,
    terminate: () => undefined
  }
  service.options = {
    peerId: MEMBER,
    nickname: '成员',
    group: GROUP,
    getSnapshot: () => ({ nickname: '成员' }),
    onPeersChange: () => undefined,
    onActivityMessage: () => undefined,
    onMessage: () => undefined,
    onReaction: () => undefined
  }
  service.connections.set(ADMIN, socket)

  service.broadcastSnapshot()
  service.lastBroadcastAt = 0
  assert.equal(service.broadcastMessage('测试广播').ok, true)
  assert.equal(service.broadcastReaction(MEMBER, 'add').ok, true)
  assert.deepEqual(socket.sent, [])

  service.boundSockets.set(socket, ADMIN)
  service.broadcastSnapshot()
  service.lastBroadcastAt = 0
  assert.equal(service.broadcastMessage('测试广播').ok, true)
  assert.equal(service.broadcastReaction(MEMBER, 'add').ok, true)
  assert.deepEqual(
    socket.sent.map((message) => message.type),
    ['snapshot', 'message', 'reaction']
  )
  service.stop()
})

test('只有公开groupHash的伪管理员不能登记peer、请求活动或覆盖已认证连接', async (t) => {
  const messages = []
  const broadcasts = []
  const reactions = []
  const target = localService(t, {
    peerId: MEMBER,
    nickname: '成员',
    group: GROUP,
    activityEnabled: true,
    getSnapshot: () => ({}),
    onPeersChange: () => undefined,
    onActivityMessage: (peerId, message) => messages.push({ peerId, message }),
    onMessage: (message) => broadcasts.push(message),
    onReaction: (reaction) => reactions.push(reaction)
  })
  const port = await localPort(target)
  const admin = localService(t, {
    peerId: ADMIN,
    nickname: '管理员',
    group: `${GROUP}GM`,
    activityEnabled: true,
    getSnapshot: () => ({}),
    onPeersChange: () => undefined,
    onActivityMessage: () => undefined,
    onMessage: () => undefined,
    onReaction: () => undefined
  })
  serviceUp(target, ADMIN, '管理员', TEAM_HASH, await localPort(admin))
  await waitFor(() => target.getActivityAdminIds().includes(ADMIN), '合法管理员未完成认证')
  const verifiedSocket = target.connections.get(ADMIN)
  for (const attack of ['missing-proof', 'public-hash-key', 'legacy-spoof']) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`)
    const closed = new Promise((resolve) => socket.once('close', resolve))
    socket.on('error', () => undefined)
    t.after(() => socket.terminate())
    await new Promise((resolve) => socket.once('open', resolve))
    socket.send(
      JSON.stringify({
        type: 'hello',
        peerId: ADMIN,
        nickname: '伪管理员',
        groupHash: TEAM_HASH,
        ...authHello(ADMIN, 'admin'),
        activityNonce: '0'.repeat(64)
      })
    )
    const serverHello = await new Promise((resolve) =>
      socket.once('message', (raw) => resolve(JSON.parse(raw.toString())))
    )
    assert.equal(serverHello.snapshot, undefined)
    socket.send(JSON.stringify({ type: 'snapshot', snapshot: { nickname: '未认证快照' } }))
    socket.send(JSON.stringify({ type: 'message', text: '未认证广播' }))
    socket.send(JSON.stringify({ type: 'reaction', targetPeerId: MEMBER, action: 'add' }))
    socket.send(JSON.stringify({ type: 'activity-request', revisions: { [DATE]: 0 } }))
    const hello = {
      type: 'hello',
      nickname: '伪管理员',
      groupHash: TEAM_HASH,
      ...authHello(ADMIN, 'admin')
    }
    if (attack === 'legacy-spoof') {
      delete hello.activityVersion
      delete hello.activityEnabled
      delete hello.role
    }
    if (attack === 'public-hash-key') {
      const attackerAuth = new ActivityConnectionAuth()
      attackerAuth.receiveHello(socket, TEAM_HASH, ADMIN, serverHello)
      Object.assign(hello, attackerAuth.decorateHello(socket, TEAM_HASH, hello))
    }
    socket.send(JSON.stringify(hello))
    socket.send(JSON.stringify({ type: 'activity-request', revisions: { [DATE]: 0 } }))
    await closed
    assert.deepEqual(target.getActivityAdminIds(), [ADMIN])
    assert.equal(target.getPeers().length, 1)
    assert.equal(target.connections.get(ADMIN), verifiedSocket)
    assert.deepEqual(messages, [])
    assert.deepEqual(broadcasts, [])
    assert.deepEqual(reactions, [])
  }
  assert.deepEqual(messages, [])
})

test('旧版groupHash握手验证后仍交换排行快照', async (t) => {
  const local = localService(t, {
    peerId: MEMBER,
    nickname: '新版成员',
    group: GROUP,
    getSnapshot: () => ({ nickname: '新版成员', tokenUsage: { '1d': 321 } }),
    onPeersChange: () => undefined,
    onActivityMessage: () => undefined,
    onMessage: () => undefined,
    onReaction: () => undefined
  })
  const socket = new WebSocket(`ws://127.0.0.1:${await localPort(local)}`)
  const messages = []
  socket.on('error', () => undefined)
  socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())))
  t.after(() => socket.terminate())
  await new Promise((resolve) => socket.once('open', resolve))
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(messages, [])

  socket.send(
    JSON.stringify({
      type: 'hello',
      peerId: ADMIN,
      nickname: '旧版管理员',
      groupHash: TEAM_HASH,
      snapshot: { nickname: '旧版管理员', tokenUsage: { '1d': 7 } }
    })
  )
  await waitFor(
    () => messages.some((message) => message.type === 'hello' && message.snapshot),
    'groupHash 验证后未发送排行快照'
  )
  assert.equal(local.getPeers()[0]?.tokenUsage?.['1d'], 7)
  assert.equal(
    messages.find((message) => message.type === 'hello')?.snapshot?.tokenUsage?.['1d'],
    321
  )
})

async function waitFor(predicate, message) {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(message)
}

function localService(t, options) {
  const service = new LanService()
  // 只测试本机 WebSocket 握手，阻止测试触碰 mDNS/Bonjour 和真实局域网状态。
  service.startDiscovery = () => undefined
  service.start(options)
  t.after(() => service.stop())
  return service
}

async function localPort(service) {
  let port
  await waitFor(() => {
    const server = service.httpServer
    const address = server?.address?.()
    port = address && typeof address !== 'string' ? address.port : undefined
    return typeof port === 'number' && port > 0
  }, '本机 WebSocket 服务未监听')
  return port
}

function serviceUp(receiver, peerId, nickname, groupHash, port) {
  receiver.handleServiceUp({
    name: peerId,
    txt: { peerId, nick: nickname, groupHash },
    addresses: ['127.0.0.1'],
    port
  })
}

test('本机 WebSocket 仅按同组 admin 定向交换活动消息，不启动 Bonjour', async (t) => {
  const adminMessages = []
  const memberMessages = []
  let adminPeerChanges = 0
  let memberPeerChanges = 0
  const admin = localService(t, {
    peerId: ADMIN,
    nickname: '管理员',
    group: `${GROUP}GM`,
    activityEnabled: true,
    getSnapshot: () => ({ nickname: '管理员', tokenUsage: { '1d': 222 } }),
    onPeersChange: () => adminPeerChanges++,
    onActivityMessage: (peerId, message) => adminMessages.push({ peerId, message }),
    onMessage: () => undefined,
    onReaction: () => undefined
  })
  const member = localService(t, {
    peerId: MEMBER,
    nickname: '成员',
    group: GROUP,
    activityEnabled: true,
    getSnapshot: () => ({ nickname: '成员', tokenUsage: { '1d': 111 } }),
    onPeersChange: () => memberPeerChanges++,
    onActivityMessage: (peerId, message) => memberMessages.push({ peerId, message }),
    onMessage: () => undefined,
    onReaction: () => undefined
  })
  const adminPort = await localPort(admin)
  const memberPort = await localPort(member)
  assert.equal(admin.bonjour, undefined)
  assert.equal(member.bonjour, undefined)

  serviceUp(admin, MEMBER, '成员', hashGroup('other-team'), memberPort)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(admin.getPeers().length, 0)
  assert.equal(admin.discovered.has(MEMBER), false)
  assert.equal(admin.reconnectTimers.size, 0)

  serviceUp(admin, MEMBER, '成员', TEAM_HASH, memberPort)
  serviceUp(member, ADMIN, '管理员', TEAM_HASH, adminPort)
  await waitFor(
    () =>
      admin.getPeers()[0]?.tokenUsage?.['1d'] === 111 &&
      member.getPeers()[0]?.tokenUsage?.['1d'] === 222,
    '认证完成后未交换双向排行快照'
  )
  await new Promise((resolve) => setTimeout(resolve, 40))
  const settledAdminChanges = adminPeerChanges
  const settledMemberChanges = memberPeerChanges
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(adminPeerChanges, settledAdminChanges, 'admin hello 在握手后循环发送')
  assert.equal(memberPeerChanges, settledMemberChanges, 'member hello 在握手后循环发送')

  assert.deepEqual(member.getActivityAdminIds(), [ADMIN])
  assert.deepEqual(admin.getActivityAdminIds(), [])

  const observedAt = Date.now()
  const live = { observedAt, state: 'idle', enabled: true, idleSince: observedAt - 60_000 }
  assert.equal(member.sendActivity(ADMIN, { type: 'activity-live', live }), true)
  await waitFor(
    () =>
      adminMessages.some(
        ({ peerId, message }) => peerId === MEMBER && message.type === 'activity-live'
      ),
    'admin 未收到成员实时活动'
  )

  assert.equal(admin.sendActivity(MEMBER, { type: 'activity-live', live }), false)
  assert.equal(
    admin.sendActivity(MEMBER, { type: 'activity-request', revisions: { [DATE]: 0 } }),
    true
  )
  await waitFor(
    () =>
      memberMessages.some(
        ({ peerId, message }) => peerId === ADMIN && message.type === 'activity-request'
      ),
    '成员未收到管理员日报请求'
  )

  const day = {
    version: 1,
    team: TEAM_HASH,
    peerId: MEMBER,
    nickname: '成员',
    date: DATE,
    revision: 1,
    calendarVersion: 'test-calendar',
    observedAt,
    intervals: [],
    incomplete: false
  }
  assert.equal(member.sendActivity(ADMIN, { type: 'activity-day', day }), true)
  assert.equal(admin.sendActivity(MEMBER, { type: 'activity-day', day }), false)
  await waitFor(
    () =>
      adminMessages.some(
        ({ peerId, message }) => peerId === MEMBER && message.type === 'activity-day'
      ),
    'admin 未收到成员日报'
  )

  const disconnectedSocket = member.connections.get(ADMIN)
  assert.ok(disconnectedSocket)
  assert.equal(member.discovered.has(ADMIN), true)
  disconnectedSocket.terminate()

  await waitFor(() => member.getPeers().length === 0, 'socket 断开后 peer 未清理')
  await waitFor(
    () => member.getPeers().length === 1 && member.connections.get(ADMIN) !== disconnectedSocket,
    '已发现 peer 未通过 loopback 地址重连'
  )

  const reconnectObservedAt = Date.now()
  assert.equal(
    member.sendActivity(ADMIN, {
      type: 'activity-live',
      live: { observedAt: reconnectObservedAt, state: 'active', enabled: true }
    }),
    true
  )
  await waitFor(
    () =>
      adminMessages.some(
        ({ peerId, message }) =>
          peerId === MEMBER &&
          message.type === 'activity-live' &&
          message.live.observedAt === reconnectObservedAt
      ),
    '重连后活动实时消息未恢复'
  )
  const stopSocket = member.connections.get(ADMIN)
  assert.ok(stopSocket)
  stopSocket.terminate()
  await waitFor(() => member.reconnectTimers.size > 0, '断连后未排队重连定时器')
  member.stop()
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(member.reconnectTimers.size, 0)
  assert.equal(member.connections.size, 0)
  assert.equal(member.httpServer, undefined)
})
