/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import seed from '../resources/holidays/2026.json' with { type: 'json' }
import { TeamActivityService } from '../src/main/services/team-activity.ts'
import { MINUTE_MS } from '../src/shared/work-time.ts'
import { ACTIVITY_SYNC_MS } from '../src/shared/activity.ts'

const DATE = '2026-10-13'
const HISTORY_DATE = '2026-10-12'
const TEAM = '123456abcdef'
const WRONG_TEAM = 'abcdef123456'
const MEMBER = '10000000-0000-4000-8000-000000000001'
const ADMIN = '10000000-0000-4000-8000-000000000002'
const OTHER = '10000000-0000-4000-8000-000000000003'
const NOW = Date.parse(`${DATE}T14:00:00+08:00`)

async function directory() {
  assert.ok(process.env.PI_SCRATCH_DIR, '测试临时文件必须在会话scratch目录')
  const root = await mkdtemp(path.join(process.env.PI_SCRATCH_DIR, 'team-activity-'))
  return root
}

function peer(id, nickname, enabled = true, supported = true) {
  return {
    id,
    nickname,
    isSelf: false,
    online: true,
    activityEnabled: enabled,
    activitySupported: supported
  }
}

function transport(initialPeers = []) {
  let peers = [...initialPeers]
  let adminIds = []
  const sent = []
  return {
    sent,
    getPeers: () => peers,
    getActivityAdminIds: () => adminIds,
    sendActivity: (peerId, message) => {
      sent.push({ peerId, message })
      return true
    },
    setPeers(next) {
      peers = [...next]
    },
    setAdminIds(next) {
      adminIds = [...next]
    }
  }
}

async function setup(t, serviceTransport, initialNow = NOW) {
  const root = await directory()
  let now = initialNow
  const service = new TeamActivityService({
    directory: root,
    transport: serviceTransport,
    readInput: () => ({ idleSeconds: 0, kind: 'idle' }),
    now: () => now,
    monotonic: () => now - initialNow,
    fetcher: async (url) =>
      url.endsWith('/2026.json')
        ? new Response(JSON.stringify(seed))
        : new Response('', { status: 404 })
  })
  await service.initialize()
  t.after(async () => {
    await service.stop()
    await rm(root, { recursive: true, force: true })
  })
  return {
    service,
    setNow(value) {
      now = value
    },
    now: () => now
  }
}

function activityDay({
  date = HISTORY_DATE,
  team = TEAM,
  peerId = MEMBER,
  revision = 2,
  minutes = 10,
  startTime = '14:00'
} = {}) {
  const start = Date.parse(`${date}T${startTime}:00+08:00`)
  return {
    version: 1,
    team,
    peerId,
    nickname: '成员',
    date,
    revision,
    calendarVersion: 'test-calendar',
    observedAt: start + minutes * MINUTE_MS,
    intervals: [{ start, end: start + minutes * MINUTE_MS, kind: 'idle' }],
    incomplete: false
  }
}

function configureAdmin(service) {
  service.configure({
    team: TEAM,
    peerId: ADMIN,
    nickname: '管理员',
    enabled: false,
    admin: true,
    thresholdMinutes: 5
  })
}

test('成员只来自观察日的日报，在线无日报不显示，离线已收日报保留', async (t) => {
  const serviceTransport = transport([peer(MEMBER, '新昵称'), peer(OTHER, '无数据成员')])
  const { service } = await setup(t, serviceTransport)
  configureAdmin(service)
  assert.deepEqual(service.getBoard(DATE).members, [])
  await service.receive(MEMBER, { type: 'activity-day', day: activityDay() })
  assert.deepEqual(service.getBoard(DATE).members, [])
  assert.equal(service.getBoard(HISTORY_DATE).members[0].nickname, '新昵称')
  await service.receive(MEMBER, {
    type: 'activity-day',
    day: activityDay({ date: DATE, startTime: '13:40' })
  })
  const online = service.getBoard(DATE).members
  assert.equal(online.length, 1)
  assert.equal(online[0].id, MEMBER)
  assert.equal(online[0].online, true)
  serviceTransport.setPeers([])
  service.onPeersChanged()
  const offline = service.getBoard(DATE).members
  assert.equal(offline.length, 1)
  assert.equal(offline[0].online, false)
  assert.equal(offline[0].day.date, DATE)
})

test('同ID新版日报更新一行，同名不同ID保留，本机仅有当日日报才显示', async (t) => {
  const serviceTransport = transport([peer(MEMBER, '同名成员'), peer(OTHER, '同名成员')])
  const { service } = await setup(t, serviceTransport)
  configureAdmin(service)
  for (const peerId of [MEMBER, OTHER]) {
    await service.receive(peerId, {
      type: 'activity-day',
      day: activityDay({ date: DATE, peerId, startTime: '13:40' })
    })
  }
  await service.receive(MEMBER, {
    type: 'activity-day',
    day: activityDay({ date: DATE, revision: 3, startTime: '13:40' })
  })
  let members = service.getBoard(DATE).members
  assert.equal(members.length, 2)
  assert.equal(members.filter((member) => member.nickname === '同名成员').length, 2)
  assert.equal(members.find((member) => member.id === MEMBER).day.revision, 3)
  serviceTransport.setPeers([peer(MEMBER, '改名成员'), peer(OTHER, '同名成员')])
  members = service.getBoard(DATE).members
  assert.equal(members.length, 2)
  assert.equal(members.find((member) => member.id === MEMBER).nickname, '改名成员')
  service.store.stage(activityDay({ date: DATE, peerId: ADMIN, startTime: '13:40' }))
  const self = service.getBoard(DATE).members.find((member) => member.isSelf)
  assert.equal(self.id, ADMIN)
  assert.equal(self.nickname, '管理员')
  assert.equal(self.online, true)
})

test('没有活跃区间的有效日报仍显示，锁定和未知数据保持原有含义', async (t) => {
  const serviceTransport = transport([peer(MEMBER, '成员')])
  const { service } = await setup(t, serviceTransport)
  configureAdmin(service)
  const empty = { ...activityDay({ date: DATE, startTime: '13:40' }), intervals: [] }
  await service.receive(MEMBER, { type: 'activity-day', day: empty })
  let member = service.getBoard(DATE).members[0]
  assert.equal(member.id, MEMBER)
  assert.equal(member.summary.idleMs, 0)
  assert.ok(member.summary.unknownMs > 0)
  const locked = activityDay({ date: DATE, revision: 3, startTime: '13:40' })
  locked.intervals[0].kind = 'locked'
  await service.receive(MEMBER, { type: 'activity-day', day: locked })
  member = service.getBoard(DATE).members[0]
  assert.equal(member.summary.lockedMs, 10 * MINUTE_MS)
})

test('同步版本表仅读取元信息，已同步日报不再复制完整内容', async (t) => {
  const serviceTransport = transport([peer(MEMBER, '成员')])
  const fixture = await setup(t, serviceTransport)
  configureAdmin(fixture.service)
  await fixture.service.receive(MEMBER, {
    type: 'activity-day',
    day: activityDay({ date: DATE, revision: 3, startTime: '13:40' })
  })
  const reads = t.mock.method(fixture.service.store, 'get')
  serviceTransport.sent.length = 0
  fixture.setNow(NOW + ACTIVITY_SYNC_MS)
  fixture.service.onPeersChanged()
  assert.equal(reads.mock.callCount(), 0)
  assert.equal(serviceTransport.sent[0].message.revisions[DATE], 3)

  const memberTransport = transport([peer(ADMIN, '管理员')])
  memberTransport.setAdminIds([ADMIN])
  const memberFixture = await setup(t, memberTransport)
  memberFixture.service.configure({
    team: TEAM,
    peerId: MEMBER,
    nickname: '成员',
    enabled: true,
    admin: false,
    thresholdMinutes: 5
  })
  const revision = memberFixture.service.store.getRevision(TEAM, MEMBER, DATE)
  const memberReads = t.mock.method(memberFixture.service.store, 'get')
  memberTransport.sent.length = 0
  await memberFixture.service.receive(ADMIN, {
    type: 'activity-request',
    revisions: { [DATE]: revision }
  })
  assert.equal(memberReads.mock.callCount(), 0)
  assert.equal(memberTransport.sent.length, 0)
  await memberFixture.service.receive(ADMIN, { type: 'activity-request', revisions: { [DATE]: 0 } })
  assert.equal(memberReads.mock.callCount(), 1)
  assert.equal(memberTransport.sent[0].message.type, 'activity-day')
})

test('只向同团队 admin 响应日报请求，错误 peer、撤销角色和 opt-out 不可继续读取', async (t) => {
  const adminPeer = peer(ADMIN, '管理员')
  const memberTransport = transport([adminPeer])
  memberTransport.setAdminIds([ADMIN])
  const memberFixture = await setup(t, memberTransport)
  memberFixture.service.configure({
    team: TEAM,
    peerId: MEMBER,
    nickname: '成员',
    enabled: true,
    admin: false,
    thresholdMinutes: 5
  })
  memberTransport.sent.length = 0

  await memberFixture.service.receive(ADMIN, { type: 'activity-request', revisions: { [DATE]: 0 } })
  assert.equal(
    memberTransport.sent.filter(({ message }) => message.type === 'activity-day').length,
    1
  )
  assert.equal(memberTransport.sent[0].peerId, ADMIN)

  memberTransport.sent.length = 0
  memberTransport.setAdminIds([])
  await memberFixture.service.receive(ADMIN, { type: 'activity-request', revisions: { [DATE]: 0 } })
  await memberFixture.service.receive(OTHER, { type: 'activity-request', revisions: { [DATE]: 0 } })
  assert.equal(memberTransport.sent.length, 0)

  memberFixture.service.configure({
    team: TEAM,
    peerId: MEMBER,
    nickname: '成员',
    enabled: true,
    admin: false,
    thresholdMinutes: 5
  })
  assert.throws(() => memberFixture.service.getBoard(DATE), /管理员/)
})

test('管理员拒绝错 team、错 peer 和不支持 peer，合法历史日报不补出无数据的当日成员', async (t) => {
  const memberPeer = peer(MEMBER, '成员')
  const adminTransport = transport([memberPeer])
  const fixture = await setup(t, adminTransport)
  fixture.service.configure({
    team: TEAM,
    peerId: ADMIN,
    nickname: '管理员',
    enabled: false,
    admin: true,
    thresholdMinutes: 5
  })
  adminTransport.sent.length = 0

  await fixture.service.receive(MEMBER, {
    type: 'activity-day',
    day: activityDay({ team: WRONG_TEAM })
  })
  await fixture.service.receive(MEMBER, {
    type: 'activity-day',
    day: activityDay({ peerId: OTHER })
  })
  assert.equal(adminTransport.sent.length, 0)

  memberPeer.activitySupported = false
  await fixture.service.receive(MEMBER, { type: 'activity-day', day: activityDay() })
  assert.equal(adminTransport.sent.length, 0)
  memberPeer.activitySupported = true

  const historical = activityDay()
  await fixture.service.receive(MEMBER, { type: 'activity-day', day: historical })
  assert.deepEqual(adminTransport.sent, [
    { peerId: MEMBER, message: { type: 'activity-ack', date: HISTORY_DATE, revision: 2 } }
  ])

  const historyBoard = fixture.service.getBoard(HISTORY_DATE)
  const currentBoard = fixture.service.getBoard(DATE)
  const historyMember = historyBoard.members.find((item) => item.id === MEMBER)
  const currentMember = currentBoard.members.find((item) => item.id === MEMBER)
  assert.equal(historyMember.day.team, historical.team)
  assert.equal(historyMember.day.peerId, historical.peerId)
  assert.equal(historyMember.day.date, historical.date)
  assert.equal(historyMember.day.revision, historical.revision)
  assert.deepEqual(historyMember.day.intervals, historical.intervals)
  assert.equal(currentMember, undefined)
  assert.deepEqual(currentBoard.members, [])
})

test('日报旧版本不覆盖缓存，阈值改变只重算摘要，实时数据保留可判 stale 的时间戳', async (t) => {
  const memberPeer = peer(MEMBER, '成员')
  const adminTransport = transport([memberPeer])
  const fixture = await setup(t, adminTransport)
  fixture.service.configure({
    team: TEAM,
    peerId: ADMIN,
    nickname: '管理员',
    enabled: false,
    admin: true,
    thresholdMinutes: 5
  })

  const current = activityDay({ date: DATE, revision: 3, startTime: '13:50' })
  await fixture.service.receive(MEMBER, { type: 'activity-day', day: current })
  adminTransport.sent.length = 0
  await fixture.service.receive(MEMBER, {
    type: 'activity-day',
    day: activityDay({ date: DATE, revision: 2, startTime: '13:50' })
  })
  assert.equal(adminTransport.sent.length, 1)
  assert.equal(adminTransport.sent[0].message.type, 'activity-ack')
  assert.equal(
    fixture.service.getBoard(DATE).members.find((item) => item.id === MEMBER).day.revision,
    3
  )

  let board = fixture.service.getBoard(DATE)
  let member = board.members.find((item) => item.id === MEMBER)
  assert.equal(member.summary.idleMs, 10 * MINUTE_MS)

  fixture.service.configure({
    team: TEAM,
    peerId: ADMIN,
    nickname: '管理员',
    enabled: false,
    admin: true,
    thresholdMinutes: 15
  })
  board = fixture.service.getBoard(DATE)
  member = board.members.find((item) => item.id === MEMBER)
  assert.equal(member.summary.idleMs, 0)

  const receivedAt = fixture.now()
  await fixture.service.receive(MEMBER, {
    type: 'activity-live',
    live: {
      observedAt: receivedAt - 40_000,
      state: 'idle',
      enabled: true,
      idleSince: receivedAt - 5 * MINUTE_MS
    }
  })
  fixture.setNow(receivedAt + 40_000)
  board = fixture.service.getBoard(DATE)
  member = board.members.find((item) => item.id === MEMBER)
  assert.equal(member.live.observedAt, receivedAt - 40_000)
  assert.equal(member.receivedAt, receivedAt)
  const historicalMember = fixture.service
    .getBoard(HISTORY_DATE)
    .members.find((item) => item.id === MEMBER)
  assert.equal(historicalMember, undefined)
})

test('日报保存等待期间撤销管理员、换组或成员关闭分享，不发送过期确认', async (t) => {
  for (const change of ['role', 'team', 'peer-disabled']) {
    const serviceTransport = transport([peer(MEMBER, '成员')])
    const fixture = await setup(t, serviceTransport)
    const settings = {
      team: TEAM,
      peerId: ADMIN,
      nickname: '管理员',
      enabled: false,
      admin: true,
      thresholdMinutes: 5
    }
    fixture.service.configure(settings)
    serviceTransport.sent.length = 0
    const gate = Promise.withResolvers()
    const started = Promise.withResolvers()
    const save = fixture.service.store.save.bind(fixture.service.store)
    fixture.service.store.save = async (day) => {
      started.resolve()
      await gate.promise
      return save(day)
    }
    const receiving = fixture.service.receive(MEMBER, { type: 'activity-day', day: activityDay() })
    await started.promise
    if (change === 'peer-disabled') serviceTransport.setPeers([peer(MEMBER, '成员', false)])
    else
      fixture.service.configure({
        ...settings,
        ...(change === 'team' ? { team: WRONG_TEAM } : { admin: false })
      })
    gate.resolve()
    await receiving
    assert.equal(
      serviceTransport.sent.some(({ message }) => message.type === 'activity-ack'),
      false
    )
  }
})

test('日历刷新等待期间撤销GM，不返回结果或再次触发采集', async (t) => {
  const fixture = await setup(t, transport())
  const settings = {
    team: TEAM,
    peerId: ADMIN,
    nickname: '管理员',
    enabled: false,
    admin: true,
    thresholdMinutes: 5
  }
  fixture.service.configure(settings)
  const gate = Promise.withResolvers()
  fixture.service.calendar.refresh = () => gate.promise
  let ticks = 0
  fixture.service.monitor.tick = () => {
    ticks++
  }
  const refreshing = fixture.service.refreshCalendar()
  fixture.service.configure({ ...settings, admin: false })
  const before = ticks
  gate.resolve()
  await assert.rejects(refreshing, /团队角色已变化/)
  assert.equal(ticks, before)
})

test('停止服务等待已开始的日历缓存写入，不留下后台目录写入', async (t) => {
  const fixture = await setup(t, transport())
  const gate = Promise.withResolvers()
  const started = Promise.withResolvers()
  const fetcher = fixture.service.calendar.fetcher
  fixture.service.calendar.fetcher = async (url) => {
    started.resolve()
    await gate.promise
    return fetcher(url)
  }
  fixture.service.configure({
    team: TEAM,
    peerId: ADMIN,
    nickname: '管理员',
    enabled: false,
    admin: true,
    thresholdMinutes: 5
  })
  await started.promise
  let stopped = false
  const stopping = fixture.service.stop().then(() => {
    stopped = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stopped, false)
  gate.resolve()
  await stopping
  assert.equal(fixture.service.calendar.getStatus(DATE).updating, false)
})
