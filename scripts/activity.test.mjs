/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import test from 'node:test'
import seed from '../resources/holidays/2026.json' with { type: 'json' }
import { parseTeamIdentity, isPeerId } from '../src/shared/team-role.ts'
import {
  seasonalWorkWindows,
  parseHolidayCalendar,
  calendarWorkWindows,
  workDateKey,
  currentWeekDates,
  MINUTE_MS,
  DAY_MS
} from '../src/shared/work-time.ts'
import {
  normalizeIdleThreshold,
  summarizeActivity,
  validateActivityDay,
  validateActivityMessage
} from '../src/shared/activity.ts'
import { ActivityRecorder } from '../src/shared/activity-recorder.ts'
import {
  activityDisplayIntervals,
  formatCompactActivityDuration,
  inactiveActivityMs,
  unconfirmedActivityMs,
  sortActivityMembersByInactiveTime
} from '../src/renderer/src/activity/model.ts'

const PEER = '10000000-0000-4000-8000-000000000001'
const DATE = '2026-10-13'
const START = Date.parse(`${DATE}T09:00:00+08:00`)
const NOW = Date.parse(`${DATE}T18:00:00+08:00`)

test('成员条时长小时分钟秒不补零，边界进位和不足一秒向下取整', () => {
  const cases = [
    [-1, '0h:0m:0s'],
    [999, '0h:0m:0s'],
    [1000, '0h:0m:1s'],
    [MINUTE_MS, '0h:1m:0s'],
    [11 * MINUTE_MS + 8000, '0h:11m:8s'],
    [60 * MINUTE_MS - 1, '0h:59m:59s'],
    [62 * MINUTE_MS + 3000, '1h:2m:3s'],
    [DAY_MS, '24h:0m:0s']
  ]
  for (const [ms, expected] of cases) assert.equal(formatCompactActivityDuration(ms), expected)
})

test('成员按工作时段未活动总时长降序，未知与活动不计入，同分保持顺序且不修改原数据', () => {
  const windows = seasonalWorkWindows(DATE)
  const interval = (start, minutes, kind) => ({ start, end: start + minutes * MINUTE_MS, kind })
  const member = (id, intervals) => ({
    id,
    summary: summarizeActivity({ ...day(), intervals }, windows, 5, NOW)
  })
  const mixed = [
    interval(START, 6, 'idle'),
    interval(START + 6 * MINUTE_MS, 5, 'locked'),
    interval(windows[1].start, 4, 'suspended')
  ]
  const members = [
    member('unknown', [interval(START, 180, 'unknown')]),
    member('lower', [interval(START, 50, 'unknown'), interval(START + 50 * MINUTE_MS, 10, 'idle')]),
    { id: 'missing' },
    member('mixed', mixed),
    member('tie', [interval(START, 15, 'locked')]),
    member('short-idle', [interval(START, 4, 'idle')]),
    member('lunch', [interval(Date.parse(`${DATE}T12:00:00+08:00`), 60, 'idle')]),
    member('active', [interval(START, 180, 'active')])
  ]
  const original = structuredClone(members)
  assert.deepEqual(members.map(inactiveActivityMs), [
    0,
    10 * MINUTE_MS,
    0,
    15 * MINUTE_MS,
    15 * MINUTE_MS,
    0,
    0,
    0
  ])
  assert.deepEqual(
    sortActivityMembersByInactiveTime(members).map(({ id }) => id),
    ['mixed', 'tie', 'lower', 'unknown', 'missing', 'short-idle', 'lunch', 'active']
  )
  assert.deepEqual(members, original)
  assert.deepEqual(sortActivityMembersByInactiveTime([]), [])
})

test('活动显示只分活动和未活动，合并连续未活动但保留未知缺口，不修改原记录', () => {
  const intervals = [
    { start: 0, end: 10, kind: 'active' },
    { start: 10, end: 20, kind: 'idle' },
    { start: 20, end: 25, kind: 'locked' },
    { start: 25, end: 30, kind: 'suspended' },
    { start: 30, end: 35, kind: 'unknown' },
    { start: 35, end: 40, kind: 'idle' },
    { start: 40, end: 45, kind: 'active' }
  ]
  const original = structuredClone(intervals)
  assert.deepEqual(activityDisplayIntervals(intervals), [
    { start: 0, end: 10, kind: 'active' },
    { start: 10, end: 30, kind: 'inactive' },
    { start: 35, end: 40, kind: 'inactive' },
    { start: 40, end: 45, kind: 'active' }
  ])
  assert.deepEqual(intervals, original)
})

test('本周观察日按北京时间周一到周日生成，覆盖日界线、跨周、跨年和闰年', () => {
  const cases = [
    ['2026-10-13T14:30:00+08:00', '2026-10-12', '2026-10-18'],
    ['2026-10-18T15:59:59Z', '2026-10-12', '2026-10-18'],
    ['2026-10-18T16:00:00Z', '2026-10-19', '2026-10-25'],
    ['2026-01-01T12:00:00+08:00', '2025-12-29', '2026-01-04'],
    ['2024-02-29T12:00:00+08:00', '2024-02-26', '2024-03-03']
  ]
  for (const [now, monday, sunday] of cases) {
    const dates = currentWeekDates(Date.parse(now))
    assert.equal(dates.length, 7)
    assert.equal(dates[0], monday)
    assert.equal(dates[6], sunday)
    for (let index = 1; index < dates.length; index++)
      assert.equal(Date.parse(dates[index]) - Date.parse(dates[index - 1]), DAY_MS)
  }
})

function day(date = DATE, start = START) {
  return {
    version: 1,
    team: '123456abcdef',
    peerId: PEER,
    nickname: '测试成员',
    date,
    revision: 1,
    calendarVersion: 'test-calendar',
    observedAt: start,
    intervals: [],
    incomplete: false
  }
}
function sample(recorder, now, idleSeconds, windows, kind = 'idle', monotonic = now) {
  return recorder.observe({ now, monotonic, idleSeconds, kind }, windows)
}
function idleUntil(recorder, start, minutes, windows, initialIdle = 0) {
  sample(recorder, start, initialIdle, windows)
  for (let seconds = 5; seconds <= minutes * 60; seconds += 5)
    sample(recorder, start + seconds * 1000, initialIdle + seconds, windows)
}

test('未活动提示只累计已观测未知区间与工作窗交集，并按看板时间截断', () => {
  const windows = seasonalWorkWindows(DATE)
  const interval = (start, end, kind) => ({ start, end, kind })
  const report = (intervals, observedAt = NOW, incomplete = true) => ({
    ...day(),
    observedAt,
    incomplete,
    intervals
  })

  assert.equal(
    unconfirmedActivityMs(
      report([interval(START, START + 2_000, 'unknown')]),
      windows,
      START + 2_000
    ),
    2_000
  )

  const acrossLunch = interval(
    Date.parse(`${DATE}T11:30:00+08:00`),
    Date.parse(`${DATE}T14:00:00+08:00`),
    'unknown'
  )
  assert.equal(unconfirmedActivityMs(report([acrossLunch]), windows, NOW), 60 * MINUTE_MS)

  const future = interval(START, START + 10_000, 'unknown')
  assert.equal(unconfirmedActivityMs(report([future]), windows, START + 2_000), 2_000)
  assert.equal(
    unconfirmedActivityMs(
      report([interval(START + 5_000, START + 10_000, 'unknown')]),
      windows,
      START + 2_000
    ),
    0
  )

  const incompleteWithoutUnknown = report([], NOW)
  assert.equal(incompleteWithoutUnknown.incomplete, true)
  assert.equal(unconfirmedActivityMs(incompleteWithoutUnknown, windows, NOW), 0)
  assert.ok(summarizeActivity(incompleteWithoutUnknown, windows, 5, NOW).unknownMs > 0)
  assert.equal(unconfirmedActivityMs(undefined, windows, NOW), 0)
  assert.equal(unconfirmedActivityMs(report([future]), [], NOW), 0)
})

test('GM只识别大写末尾，成员与管理员基础口令相同', () => {
  assert.deepEqual(parseTeamIdentity(' 9527GM '), { group: '9527', role: 'admin', valid: true })
  assert.equal(parseTeamIdentity('9527').group, parseTeamIdentity('9527GM').group)
  assert.equal(parseTeamIdentity('9527gm').role, 'member')
  assert.equal(parseTeamIdentity('9527GMx').role, 'member')
  assert.equal(parseTeamIdentity('GM').valid, false)
  assert.equal(parseTeamIdentity('').valid, true)
  assert.equal(isPeerId(PEER), true)
  assert.equal(isPeerId('../another'), false)
})

test('季节切换和北京时间日界线准确，总工作时间465分钟', () => {
  for (const date of ['2026-04-30', '2026-05-01', '2026-09-30', '2026-10-01']) {
    const windows = seasonalWorkWindows(date)
    const summer = date.slice(5) >= '05-01' && date.slice(5) < '10-01'
    assert.equal(
      new Date(windows[1].start + 8 * 60 * MINUTE_MS).toISOString().slice(11, 16),
      summer ? '13:45' : '13:30'
    )
    assert.equal(
      new Date(windows[1].end + 8 * 60 * MINUTE_MS).toISOString().slice(11, 16),
      summer ? '18:00' : '17:45'
    )
    assert.equal(
      windows.reduce((total, item) => total + item.end - item.start, 0),
      465 * MINUTE_MS
    )
  }
  assert.equal(workDateKey(Date.parse('2026-10-12T16:00:00Z')), DATE)
  assert.deepEqual(seasonalWorkWindows('2026-02-30'), [])
})

test('官方放假覆盖平日，补班覆盖周末，无日历不得猜测', () => {
  const calendar = parseHolidayCalendar(seed, 2026)
  assert.ok(calendar)
  assert.deepEqual(calendarWorkWindows('2026-10-01', [calendar]), [])
  assert.equal(calendarWorkWindows('2026-10-10', [calendar]).length, 2)
  assert.deepEqual(calendarWorkWindows('2026-10-11', [calendar]), [])
  assert.equal(calendarWorkWindows(DATE, [calendar]).length, 2)
  assert.deepEqual(calendarWorkWindows('2027-01-04', [calendar]), [])
  assert.equal(parseHolidayCalendar({ year: 2027, papers: [], days: [] }, 2027), undefined)
  assert.equal(
    parseHolidayCalendar({ ...seed, days: [...seed.days, seed.days[0]] }, 2026),
    undefined
  )
  const next = {
    year: 2027,
    papers: ['https://www.gov.cn/example'],
    days: [
      { date: '2026-12-31', isOffDay: true },
      { date: '2027-01-01', isOffDay: true }
    ]
  }
  assert.deepEqual(
    calendarWorkWindows('2026-12-31', [calendar, parseHolidayCalendar(next, 2027)]),
    []
  )
})

test('达到阈值计整段，改阈值可重算历史，不累计多次idle值', () => {
  const recorder = new ActivityRecorder(day())
  const windows = seasonalWorkWindows(DATE)
  idleUntil(recorder, START, 12, windows)
  const result = summarizeActivity(recorder.finish(START + 12 * MINUTE_MS), windows, 5, NOW)
  assert.equal(result.idleMs, 12 * MINUTE_MS)
  assert.equal(result.idleCount, 1)
  assert.equal(summarizeActivity(recorder.snapshot(), windows, 15, NOW).idleMs, 0)
  assert.equal(normalizeIdleThreshold(1), 1)
  assert.equal(normalizeIdleThreshold(60), 60)
  for (const value of [0, 61, -1, 1.5, NaN, '5']) assert.equal(normalizeIdleThreshold(value), 5)
})

test('中途启动不倒推旧输入，无输入起点是有效观测开始', () => {
  const recorder = new ActivityRecorder(day())
  idleUntil(recorder, START, 6, seasonalWorkWindows(DATE), 1800)
  assert.equal(recorder.live().idleSince, START)
  assert.equal(recorder.snapshot().firstInputAt, undefined)
  assert.equal(
    summarizeActivity(recorder.snapshot(), seasonalWorkWindows(DATE), 5, NOW).idleMs,
    6 * MINUTE_MS
  )
})

test('输入发生在采样边界也不得合并前后空闲段', () => {
  const recorder = new ActivityRecorder(day())
  const windows = seasonalWorkWindows(DATE)
  idleUntil(recorder, START, 6, windows)
  const inputAt = START + 6 * MINUTE_MS + 5_000
  sample(recorder, inputAt, 0, windows)
  for (let seconds = 5; seconds <= 65; seconds += 5)
    sample(recorder, inputAt + seconds * 1000, seconds, windows)
  const result = summarizeActivity(recorder.snapshot(), windows, 1, NOW)
  assert.equal(result.idleCount, 2)
  assert.equal(recorder.snapshot().lastInputAt, inputAt)
})

test('夏季午休跨段只计下午10分钟，下班截断冬季5分钟', () => {
  const date = '2026-07-06'
  const start = Date.parse(`${date}T11:58:00+08:00`)
  const windows = seasonalWorkWindows(date)
  const recorder = new ActivityRecorder(day(date, start))
  idleUntil(recorder, start, 2, windows)
  const afternoon = Date.parse(`${date}T13:45:00+08:00`)
  idleUntil(recorder, afternoon, 10, windows, 10000)
  assert.equal(
    summarizeActivity(recorder.snapshot(), windows, 5, afternoon + 10 * MINUTE_MS).idleMs,
    10 * MINUTE_MS
  )
  const winter = new ActivityRecorder(day(DATE, Date.parse(`${DATE}T17:40:00+08:00`)))
  idleUntil(winter, Date.parse(`${DATE}T17:40:00+08:00`), 6, seasonalWorkWindows(DATE))
  assert.equal(
    summarizeActivity(winter.snapshot(), seasonalWorkWindows(DATE), 5, NOW).idleMs,
    5 * MINUTE_MS
  )
})

test('采样缺口记未知，成对休眠事件可记录休眠，锁屏不计普通空闲', () => {
  const windows = seasonalWorkWindows(DATE)
  const recorder = new ActivityRecorder(day())
  sample(recorder, START, 0, windows)
  sample(recorder, START + MINUTE_MS, 60, windows)
  assert.equal(recorder.snapshot().intervals[0].kind, 'unknown')
  sample(recorder, START + MINUTE_MS + 5_000, 65, windows, 'suspended')
  sample(recorder, START + 11 * MINUTE_MS + 5_000, 0, windows)
  assert.equal(summarizeActivity(recorder.snapshot(), windows, 5, NOW).suspendedMs, 10 * MINUTE_MS)
  sample(recorder, START + 11 * MINUTE_MS + 10_000, 5, windows, 'locked')
  sample(recorder, START + 12 * MINUTE_MS + 10_000, 0, windows)
  assert.equal(summarizeActivity(recorder.snapshot(), windows, 5, NOW).lockedMs, MINUTE_MS)
})

test('拒绝非法身份、重叠区间、未来日报及异常实时数据', () => {
  const valid = {
    ...day(),
    observedAt: START + MINUTE_MS,
    intervals: [{ start: START, end: START + MINUTE_MS, kind: 'idle' }]
  }
  assert.equal(validateActivityDay(valid, NOW), true)
  assert.equal(validateActivityDay({ ...valid, peerId: '../unsafe' }, NOW), false)
  assert.equal(
    validateActivityDay({ ...valid, intervals: [...valid.intervals, valid.intervals[0]] }, NOW),
    false
  )
  assert.equal(validateActivityDay({ ...valid, date: '2026-10-14' }, NOW), false)
  assert.equal(
    validateActivityMessage(
      {
        type: 'activity-live',
        live: { observedAt: NOW, enabled: true, state: 'idle', idleSince: -1e100 }
      },
      NOW
    ),
    false
  )
  assert.equal(
    validateActivityMessage({ type: 'activity-request', revisions: { '2026-10-14': 0 } }, NOW),
    false
  )
  assert.equal(validateActivityDay({ ...valid, date: workDateKey(NOW - 30 * DAY_MS) }, NOW), false)
})
