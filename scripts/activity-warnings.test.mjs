/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import seed from '../resources/holidays/2026.json' with { type: 'json' }
import { ActivityMonitor } from '../src/main/services/activity-monitor.ts'
import { ActivityStore } from '../src/main/services/activity-store.ts'
import { TeamActivityService } from '../src/main/services/team-activity.ts'
import { WorkCalendarService } from '../src/main/services/work-calendar.ts'
import { ACTIVITY_MAX_DIAGNOSTICS, validateActivityDay } from '../src/shared/activity.ts'
import { parseHolidayCalendar } from '../src/shared/work-time.ts'

const DATE = '2026-10-13'
const TEAM = '123456abcdef'
const MEMBER = '10000000-0000-4000-8000-000000000001'
const ADMIN = '10000000-0000-4000-8000-000000000002'
const NOW = Date.parse(`${DATE}T14:00:00+08:00`)
const OLD_CALENDAR_VERSION = '0123456789abcdef'

function parsedCalendar(year, days, paper = 'current') {
  const calendar = parseHolidayCalendar(
    {
      year,
      papers: [`https://www.gov.cn/${year}/${paper}`],
      days: [...days, { date: `${year}-01-01`, isOffDay: true }]
    },
    year
  )
  assert.ok(calendar)
  return calendar
}

function calendarService() {
  const calendar = new WorkCalendarService('unused-calendar-directory')
  calendar.calendars.clear()
  return calendar
}

function activityDay({ revision = 1, calendarVersion = OLD_CALENDAR_VERSION } = {}) {
  const observedAt = NOW - 1_000
  return {
    version: 1,
    team: TEAM,
    peerId: MEMBER,
    nickname: '成员',
    date: DATE,
    revision,
    calendarVersion,
    observedAt,
    intervals: [],
    incomplete: true,
    diagnostics: [{ code: 'clock-change', at: observedAt }]
  }
}

function assertPointDiagnostic(diagnostics, expectedAt) {
  assert.equal(diagnostics.length, 1)
  assert.equal(diagnostics[0].code, 'clock-change')
  assert.equal(diagnostics[0].at, expectedAt)
  assert.equal(diagnostics[0].start, undefined)
  assert.equal(diagnostics[0].end, undefined)
}

function peer(id, nickname) {
  return {
    id,
    nickname,
    isSelf: false,
    online: true,
    activityEnabled: true,
    activitySupported: true
  }
}

function transport({ peers = [], adminIds = [] } = {}) {
  return {
    sent: [],
    getPeers: () => peers,
    getActivityAdminIds: () => adminIds,
    sendActivity(peerId, message) {
      this.sent.push({ peerId, message })
      return true
    }
  }
}

function serviceOptions(directory, serviceTransport, now = () => NOW) {
  return {
    directory,
    transport: serviceTransport,
    readInput: () => ({ idleSeconds: 0, kind: 'idle' }),
    now,
    monotonic: () => 0,
    fetcher: async (url) =>
      url.endsWith('/2026.json')
        ? new Response(JSON.stringify(seed))
        : new Response('', { status: 404 })
  }
}

async function scratchDirectory(prefix) {
  assert.ok(process.env.PI_SCRATCH_DIR, '测试临时文件必须在会话scratch目录')
  return mkdtemp(path.join(process.env.PI_SCRATCH_DIR, prefix))
}

test('日历版本不受资料链接、无关年份和缓存顺序影响', () => {
  const source = parseHolidayCalendar(seed, 2026)
  assert.ok(source)
  const baseline = calendarService()
  baseline.calendars.set(2026, source)
  const expected = baseline.getStatus(DATE)

  const equivalent = calendarService()
  equivalent.calendars.set(
    2027,
    parsedCalendar(2027, [{ date: '2026-12-31', isOffDay: false }], 'next-year')
  )
  equivalent.calendars.set(2026, {
    ...source,
    papers: ['https://www.gov.cn/2026/revised-paper'],
    days: [...source.days].reverse()
  })
  equivalent.calendars.set(2025, parsedCalendar(2025, [], 'previous-year'))

  const actual = equivalent.getStatus(DATE)
  assert.match(actual.version, /^workday-v1:[a-f0-9]{16}$/)
  assert.equal(actual.isWorkday, expected.isWorkday)
  assert.deepEqual(actual.windows, expected.windows)
  assert.equal(actual.version, expected.version)
})

test('版本跟随单日规则变化，并应用下一年公布的跨年规则', () => {
  const singleDay = calendarService()
  const source = parseHolidayCalendar(seed, 2026)
  assert.ok(source)
  singleDay.calendars.set(2026, source)
  const before = singleDay.getStatus(DATE)
  const changedDays = source.days.filter((day) => day.date !== DATE)
  changedDays.push({ date: DATE, isOffDay: before.isWorkday })
  singleDay.calendars.set(
    2026,
    parsedCalendar(
      2026,
      changedDays.filter((day) => day.date !== '2026-01-01')
    )
  )
  const after = singleDay.getStatus(DATE)
  assert.equal(after.isWorkday, !before.isWorkday)
  assert.notEqual(after.version, before.version)

  const yearEnd = '2026-12-31'
  const crossYear = calendarService()
  crossYear.calendars.set(2026, parsedCalendar(2026, [{ date: yearEnd, isOffDay: true }]))
  crossYear.calendars.set(
    2027,
    parsedCalendar(2027, [{ date: yearEnd, isOffDay: false }], 'new-year')
  )
  const overridden = crossYear.getStatus(yearEnd)
  assert.equal(overridden.isWorkday, true)
  const overriddenVersion = overridden.version
  crossYear.calendars.set(
    2027,
    parsedCalendar(2027, [{ date: yearEnd, isOffDay: true }], 'new-year')
  )
  const updated = crossYear.getStatus(yearEnd)
  assert.equal(updated.isWorkday, false)
  assert.deepEqual(updated.windows, [])
  assert.notEqual(updated.version, overriddenVersion)
})

test('活动日报诊断只接受固定原因和同日有效时刻、区间', () => {
  const valid = activityDay()
  assert.equal(validateActivityDay(valid, NOW), true)
  const observedAt = valid.observedAt
  const rangeStart = observedAt - 5_000
  const invalidDiagnostics = [
    [{ code: 'unknown-reason', at: observedAt }],
    [{ code: 'clock-change', at: observedAt + 1 }],
    [{ code: 'sample-gap', at: observedAt, start: rangeStart }],
    [{ code: 'sample-gap', at: observedAt, start: observedAt, end: observedAt }],
    [{ code: 'sample-gap', at: observedAt, start: rangeStart, end: observedAt + 1 }],
    [
      {
        code: 'sample-gap',
        at: observedAt,
        start: rangeStart - 24 * 60 * 60 * 1_000,
        end: rangeStart
      }
    ],
    Array.from({ length: ACTIVITY_MAX_DIAGNOSTICS + 1 }, () => ({
      code: 'input-unavailable',
      at: observedAt
    }))
  ]
  for (const diagnostics of invalidDiagnostics)
    assert.equal(validateActivityDay({ ...valid, diagnostics }, NOW), false)
})

test('readInput抛错经Monitor写入日报诊断', async (t) => {
  const directory = await scratchDirectory('activity-warning-monitor-')
  let now = NOW
  let monotonic = 0
  const store = new ActivityStore(path.join(directory, 'days'), () => now)
  const calendar = new WorkCalendarService(
    directory,
    async (url) =>
      url.endsWith('/2026.json')
        ? new Response(JSON.stringify(seed))
        : new Response('', { status: 404 }),
    () => now
  )
  await store.initialize()
  await calendar.initialize()
  const monitor = new ActivityMonitor({
    store,
    calendar,
    readInput: () => {
      throw new Error('input probe failed')
    },
    now: () => now,
    monotonic: () => monotonic
  })
  t.after(async () => {
    await monitor.stop()
    await store.flush()
    await rm(directory, { recursive: true, force: true })
  })

  monitor.configure({ team: TEAM, peerId: MEMBER, nickname: '成员', enabled: true })
  now += 5_000
  monotonic += 5_000
  monitor.tick()
  await store.flush()

  const day = store.get(TEAM, MEMBER, DATE).day
  assert.equal(day.incomplete, true)
  assert.ok(day.diagnostics.some((item) => item.code === 'input-read-failed'))
  assert.ok(day.intervals.some((item) => item.kind === 'unknown'))
})

test('日报诊断和旧日历版本经落盘、同日重启、Service收发与看板保留', async (t) => {
  const memberDirectory = await scratchDirectory('activity-warning-member-')
  const adminDirectory = await scratchDirectory('activity-warning-admin-')
  const services = []
  t.after(async () => {
    for (const service of services) await service.stop()
    await rm(memberDirectory, { recursive: true, force: true })
    await rm(adminDirectory, { recursive: true, force: true })
  })

  const initialStore = new ActivityStore(path.join(memberDirectory, 'days'), () => NOW)
  await initialStore.initialize()
  const original = activityDay()
  assertPointDiagnostic(original.diagnostics, original.observedAt)
  initialStore.stage(original)
  await initialStore.save(original)
  await initialStore.flush()
  assertPointDiagnostic(initialStore.get(TEAM, MEMBER, DATE).day.diagnostics, original.observedAt)

  const memberTransport = transport({ peers: [peer(ADMIN, '管理员')], adminIds: [ADMIN] })
  const firstMemberService = new TeamActivityService(
    serviceOptions(memberDirectory, memberTransport)
  )
  services.push(firstMemberService)
  await firstMemberService.initialize()
  firstMemberService.configure({
    team: TEAM,
    peerId: MEMBER,
    nickname: '成员',
    enabled: true,
    admin: false,
    thresholdMinutes: 5
  })
  await firstMemberService.store.flush()
  await firstMemberService.stop()

  const restartedMemberService = new TeamActivityService(
    serviceOptions(memberDirectory, memberTransport)
  )
  services.push(restartedMemberService)
  await restartedMemberService.initialize()
  assertPointDiagnostic(
    restartedMemberService.store.get(TEAM, MEMBER, DATE).day.diagnostics,
    original.observedAt
  )
  restartedMemberService.configure({
    team: TEAM,
    peerId: MEMBER,
    nickname: '成员',
    enabled: true,
    admin: false,
    thresholdMinutes: 5
  })
  await restartedMemberService.store.flush()
  assert.equal(
    restartedMemberService.store.get(TEAM, MEMBER, DATE).day.calendarVersion,
    OLD_CALENDAR_VERSION
  )
  assertPointDiagnostic(
    restartedMemberService.store.get(TEAM, MEMBER, DATE).day.diagnostics,
    original.observedAt
  )
  await restartedMemberService.receive(ADMIN, {
    type: 'activity-request',
    revisions: { [DATE]: 0 }
  })
  const sentDay = memberTransport.sent
    .map(({ message }) => message)
    .findLast((message) => message.type === 'activity-day')
  assert.ok(sentDay)
  assert.equal(sentDay.day.calendarVersion, OLD_CALENDAR_VERSION)
  assertPointDiagnostic(sentDay.day.diagnostics, original.observedAt)

  const adminTransport = transport({ peers: [peer(MEMBER, '成员')] })
  const adminService = new TeamActivityService(serviceOptions(adminDirectory, adminTransport))
  services.push(adminService)
  await adminService.initialize()
  adminService.configure({
    team: TEAM,
    peerId: ADMIN,
    nickname: '管理员',
    enabled: false,
    admin: true,
    thresholdMinutes: 5
  })
  await adminService.receive(MEMBER, sentDay)
  let member = adminService.getBoard(DATE).members.find((item) => item.id === MEMBER)
  assert.equal(member.calendarComparison, 'unverifiable')
  assertPointDiagnostic(member.day.diagnostics, original.observedAt)

  const currentVersion = adminService.calendar.getStatus(DATE).version
  const matching = {
    ...sentDay.day,
    revision: sentDay.day.revision + 1,
    calendarVersion: currentVersion
  }
  await adminService.receive(MEMBER, { type: 'activity-day', day: matching })
  member = adminService.getBoard(DATE).members.find((item) => item.id === MEMBER)
  assert.equal(member.calendarComparison, 'matching')
  assertPointDiagnostic(member.day.diagnostics, original.observedAt)

  const different = {
    ...matching,
    revision: matching.revision + 1,
    calendarVersion: 'workday-v1:0000000000000000'
  }
  await adminService.receive(MEMBER, { type: 'activity-day', day: different })
  member = adminService.getBoard(DATE).members.find((item) => item.id === MEMBER)
  assert.equal(member.calendarComparison, 'different')
  assertPointDiagnostic(member.day.diagnostics, original.observedAt)

  const legacy = {
    ...different,
    revision: different.revision + 1,
    calendarVersion: 'abcdef0123456789'
  }
  await adminService.receive(MEMBER, { type: 'activity-day', day: legacy })
  member = adminService.getBoard(DATE).members.find((item) => item.id === MEMBER)
  assert.equal(member.calendarComparison, 'unverifiable')
  assertPointDiagnostic(member.day.diagnostics, original.observedAt)
})
