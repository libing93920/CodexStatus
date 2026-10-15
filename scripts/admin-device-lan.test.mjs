/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import test from 'node:test'
import { LanService, hashGroup } from '../src/main/services/lan.ts'

const GROUP = 'admin-device-test'
const ADMIN = '10000000-0000-4000-8000-000000000001'
const MEMBER = '10000000-0000-4000-8000-000000000002'

async function waitFor(predicate) {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('本机权限握手未在期限内完成')
}

function localService(t, identity, state) {
  const service = new LanService(() => state.allowed)
  service.startDiscovery = () => undefined
  service.start({
    ...identity,
    nickname: '权限测试',
    activityEnabled: true,
    getSnapshot: () => ({}),
    onPeersChange: () => undefined,
    onActivityMessage: (_peerId, message) => state.messages.push(message),
    onMessage: () => undefined,
    onReaction: () => undefined
  })
  t.after(() => service.stop())
  return service
}

async function connect(local, remote) {
  await waitFor(() => remote.httpServer?.address())
  local.handleServiceUp({
    name: remote.options.peerId,
    txt: { peerId: remote.options.peerId, nick: '权限测试', groupHash: hashGroup(GROUP) },
    addresses: ['127.0.0.1'],
    port: remote.httpServer.address().port
  })
  await waitFor(() => local.getPeers().length === 1 && remote.getPeers().length === 1)
}

test('GM仍须设备授权才能声明管理员及收发管理员活动，失效后保留成员分享', async (t) => {
  const state = { allowed: false, messages: [] }
  const memberState = { allowed: true, messages: [] }
  const candidate = localService(t, { peerId: ADMIN, group: GROUP + 'GM' }, state)
  const member = localService(t, { peerId: MEMBER, group: GROUP }, memberState)
  await connect(candidate, member)
  assert.deepEqual(member.getActivityAdminIds(), [])
  const request = { type: 'activity-request', revisions: {} }
  assert.equal(candidate.sendActivity(MEMBER, request), false)

  state.allowed = true
  const socket = candidate.connections.get(MEMBER)
  candidate.sendHello(socket)
  await waitFor(() => member.getActivityAdminIds().includes(ADMIN))
  assert.equal(candidate.sendActivity(MEMBER, request), true)
  await waitFor(() => memberState.messages.length === 1)

  const live = {
    type: 'activity-live',
    live: { observedAt: Date.now(), state: 'active', enabled: true }
  }
  assert.equal(member.sendActivity(ADMIN, live), true)
  await waitFor(() => state.messages.length === 1)
  state.allowed = false
  assert.equal(candidate.sendActivity(MEMBER, request), false)
  candidate.receiveActivity(MEMBER, live, socket)
  assert.equal(state.messages.length, 1)
  candidate.sendHello(socket)
  await waitFor(() => member.getActivityAdminIds().length === 0)
  assert.equal(member.sendActivity(ADMIN, live), false)

  member.options.group = GROUP + 'GM'
  member.sendHello(member.connections.get(ADMIN))
  await waitFor(() => candidate.getActivityAdminIds().includes(MEMBER))
  assert.equal(candidate.sendActivity(MEMBER, live), true)
  await waitFor(() => memberState.messages.length === 2)
})
