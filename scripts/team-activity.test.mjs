/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import seed from '../resources/holidays/2026.json' with { type: 'json' }
import { TeamActivityService } from '../src/main/services/team-activity.ts'
import { MINUTE_MS } from '../src/shared/work-time.ts'

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

test('管理员拒绝错 team、错 peer 和不支持 peer，合法日报保留历史并补齐缺日', async (t) => {
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
  assert.equal(currentMember.day, undefined)
  assert.equal(currentMember.online, true)
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
  assert.equal(historicalMember.live.observedAt, member.live.observedAt)
  assert.equal(historicalMember.day, undefined)
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
