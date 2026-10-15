/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import test from 'node:test'
import seed from '../resources/holidays/2026.json' with { type: 'json' }
import { ActivityMonitor } from '../src/main/services/activity-monitor.ts'
import { ActivityStore } from '../src/main/services/activity-store.ts'
import { WorkCalendarService } from '../src/main/services/work-calendar.ts'
import { ActivityRecorder } from '../src/shared/activity-recorder.ts'
import {
  ACTIVITY_CHECKPOINT_MS,
  ACTIVITY_SAMPLE_MS,
  summarizeActivity,
  validateActivityMessage
} from '../src/shared/activity.ts'
import { DAY_MS, MINUTE_MS, seasonalWorkWindows } from '../src/shared/work-time.ts'

const DATE = '2026-10-13'
const TEAM = '123456abcdef'
const OTHER_TEAM = 'abcdef123456'
const PEER = '10000000-0000-4000-8000-000000000001'
const START = Date.parse(`${DATE}T09:00:00+08:00`)
const CLOCK_ROLLBACK_MS = 6_000
const FUTURE_DATE = '2026-10-14'
const FUTURE_START = Date.parse(`${FUTURE_DATE}T09:00:00+08:00`)

async function directory(t) {
  assert.ok(process.env.PI_SCRATCH_DIR, '测试临时文件必须在会话scratch目录')
  const root = await import('node:fs/promises').then(({ mkdtemp, rm }) => {
    t.after(() => rm(root, { recursive: true, force: true }))
    return mkdtemp(`${process.env.PI_SCRATCH_DIR}\\activity-monitor-`)
  })
  return root
}

async function setup(t, initialNow = START) {
  const root = await directory(t)
  let now = initialNow
  let monotonic = 0
  let reads = 0
  let input = { idleSeconds: 0, kind: 'idle' }
  const store = new ActivityStore(`${root}\\days`, () => now)
  const calendar = new WorkCalendarService(
    root,
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
      reads++
      return input
    },
    now: () => now,
    monotonic: () => monotonic
  })
  t.after(() => monitor.stop())
  return {
    monitor,
    store,
    calendar,
    setTime(value, elapsed = value - initialNow) {
      now = value
      monotonic = elapsed
    },
    setInput(value) {
      input = value
    },
    get reads() {
      return reads
    },
    now: () => now
  }
}

function config(team = TEAM, enabled = true) {
  return { team, peerId: PEER, nickname: '测试成员', enabled }
}

async function recordActiveHistory(fixture) {
  fixture.monitor.configure(config())
  const end = START + 40 * MINUTE_MS
  for (let now = START + ACTIVITY_SAMPLE_MS; now <= end; now += ACTIVITY_SAMPLE_MS) {
    fixture.setTime(now, now - START)
    fixture.monitor.tick(now)
  }
  await fixture.store.flush()
  return fixture.store.get(TEAM, PEER, DATE).day
}

async function recordAfternoonFuture(fixture) {
  const afternoon = seasonalWorkWindows(DATE)[1].start
  const firstSample = afternoon + ACTIVITY_SAMPLE_MS
  await fixture.monitor.stop()
  fixture.setTime(firstSample)
  fixture.monitor.configure(config())
  fixture.setTime(firstSample + ACTIVITY_SAMPLE_MS)
  fixture.monitor.tick()
  fixture.setTime(afternoon + 30 * MINUTE_MS)
  fixture.monitor.tick()
  await fixture.store.flush()
  const day = fixture.store.get(TEAM, PEER, DATE).day
  await fixture.monitor.stop()
  return day
}

function makeFutureReport(day) {
  return {
    ...day,
    date: FUTURE_DATE,
    revision: 1,
    observedAt: FUTURE_START,
    firstInputAt: undefined,
    lastInputAt: undefined,
    intervals: [],
    incomplete: false,
    diagnostics: undefined
  }
}

function startLockedMonitor(t, fixture, store) {
  let monotonic = 0
  const monitor = new ActivityMonitor({
    store,
    calendar: fixture.calendar,
    readInput: () => ({ idleSeconds: 0, kind: 'locked' }),
    now: fixture.now,
    monotonic: () => monotonic
  })
  t.after(() => monitor.stop())
  monitor.configure(config())
  const liveMessagesValid = [
    validateActivityMessage({ type: 'activity-live', live: monitor.getLive() }, fixture.now())
  ]
  return {
    monitor,
    liveMessagesValid,
    sample(now) {
      monotonic += ACTIVITY_SAMPLE_MS
      fixture.setTime(now, monotonic)
      monitor.tick(now)
      liveMessagesValid.push(
        validateActivityMessage({ type: 'activity-live', live: monitor.getLive() }, now)
      )
    }
  }
}

async function verifyReloadedRollback({
  fixture,
  store,
  restarted,
  savedRevision,
  savedFutureReport,
  expectedIntervals
}) {
  await restarted.monitor.stop()
  await store.flush()
  const reloaded = new ActivityStore(fixture.store.directory, fixture.now)
  await reloaded.initialize()
  const reloadedDay = reloaded.get(TEAM, PEER, DATE).day
  assert.deepEqual(reloadedDay.intervals, expectedIntervals)
  assert.equal(
    summarizeActivity(reloadedDay, seasonalWorkWindows(DATE), 5, fixture.now()).lockedMs,
    5 * MINUTE_MS
  )
  assert.ok(reloadedDay.revision > savedRevision)
  assert.deepEqual(reloaded.get(TEAM, PEER, FUTURE_DATE).day, savedFutureReport)
}

async function prepareStoppedClockRollback(t, sourceNow) {
  const fixture = await setup(t)
  const activeDay = await recordActiveHistory(fixture)
  assert.deepEqual(activeDay.intervals, [
    { start: START, end: START + 40 * MINUTE_MS, kind: 'active' }
  ])
  await fixture.monitor.stop()

  const futureReport = makeFutureReport(activeDay)
  fixture.store.stage(futureReport, FUTURE_START)
  await fixture.store.save(futureReport, FUTURE_START)
  await fixture.store.flush()
  const savedFutureReport = fixture.store.get(TEAM, PEER, FUTURE_DATE).day
  fixture.setTime(sourceNow, sourceNow - START)
  const rollbackAt = START + 30 * MINUTE_MS
  fixture.setTime(rollbackAt, 0)

  const store = new ActivityStore(fixture.store.directory, fixture.now)
  await store.initialize()
  assert.deepEqual(store.get(TEAM, PEER, DATE).day.intervals, activeDay.intervals)
  assert.deepEqual(store.get(TEAM, PEER, FUTURE_DATE).day, savedFutureReport)
  return {
    fixture,
    store,
    rollbackAt,
    savedRevision: store.get(TEAM, PEER, DATE).day.revision,
    savedFutureReport
  }
}

async function sampleStoppedRollback(t, { fixture, store, rollbackAt }) {
  const restarted = startLockedMonitor(t, fixture, store)
  const resumedAt = rollbackAt + 5 * MINUTE_MS
  for (let now = rollbackAt + ACTIVITY_SAMPLE_MS; now <= resumedAt; now += ACTIVITY_SAMPLE_MS)
    restarted.sample(now)
  await store.flush()

  const resumed = store.get(TEAM, PEER, DATE).day
  const summary = summarizeActivity(resumed, seasonalWorkWindows(DATE), 5, fixture.now())
  assert.deepEqual(resumed.intervals, [
    { start: START, end: rollbackAt, kind: 'active' },
    { start: rollbackAt, end: resumedAt, kind: 'locked' }
  ])
  assert.equal(summary.lockedMs, 5 * MINUTE_MS)
  assert.ok(resumed.diagnostics.some(({ code }) => code === 'clock-change'))
  assert.ok(restarted.liveMessagesValid.every(Boolean))
  return { restarted, resumed }
}

async function verifyStoppedClockRollback(t, sourceNow) {
  const prepared = await prepareStoppedClockRollback(t, sourceNow)
  const { restarted, resumed } = await sampleStoppedRollback(t, prepared)
  assert.ok(resumed.revision > prepared.savedRevision)
  await verifyReloadedRollback({
    fixture: prepared.fixture,
    store: prepared.store,
    restarted,
    savedRevision: prepared.savedRevision,
    savedFutureReport: prepared.savedFutureReport,
    expectedIntervals: resumed.intervals
  })
}

test('监控默认关闭且首次启动不按系统 idle 值回填', async (t) => {
  const fixture = await setup(t)
  fixture.setInput({ idleSeconds: 1800, kind: 'idle' })
  fixture.monitor.configure(config(TEAM, false))
  assert.equal(fixture.reads, 0)
  assert.equal(fixture.monitor.getLive().state, 'disabled')
  assert.equal(fixture.store.get(TEAM, PEER, DATE), undefined)

  fixture.monitor.configure(config())
  const first = fixture.store.get(TEAM, PEER, DATE).day
  assert.equal(first.observedAt, START)
  assert.deepEqual(first.intervals, [])
  assert.equal(first.firstInputAt, undefined)

  fixture.setTime(START + 5_000, 5_000)
  fixture.setInput({ idleSeconds: 1805, kind: 'idle' })
  fixture.monitor.tick()
  const observed = fixture.store.get(TEAM, PEER, DATE).day
  assert.deepEqual(observed.intervals, [{ start: START, end: START + 5_000, kind: 'idle' }])
  assert.equal(observed.firstInputAt, undefined)
})

test('同日采样按 recorder 日期元信息判断，不额外深拷贝日报', async (t) => {
  const fixture = await setup(t)
  fixture.monitor.configure(config())
  const originalSnapshot = ActivityRecorder.prototype.snapshot
  let snapshotCalls = 0
  ActivityRecorder.prototype.snapshot = function () {
    snapshotCalls++
    return originalSnapshot.call(this)
  }

  try {
    fixture.setTime(START + 5_000, 5_000)
    fixture.monitor.tick()
    assert.equal(snapshotCalls, 1)
  } finally {
    ActivityRecorder.prototype.snapshot = originalSnapshot
  }
})

test('按约 5 秒观察，超过采样缺口的区间标记 unknown', async (t) => {
  const fixture = await setup(t)
  fixture.monitor.configure(config())
  fixture.setTime(START + 5_000, 5_000)
  fixture.setInput({ idleSeconds: 5, kind: 'idle' })
  fixture.monitor.tick()
  fixture.setTime(START + 25_000, 25_000)
  fixture.setInput({ idleSeconds: 25, kind: 'idle' })
  fixture.monitor.tick()

  const day = fixture.store.get(TEAM, PEER, DATE).day
  assert.equal(fixture.reads, 3)
  assert.ok(day.intervals.some((interval) => interval.kind === 'unknown'))
  assert.equal(day.incomplete, true)
})

test('时钟回拨进入午休时也持久化时钟变化，不丢失已有日报', async (t) => {
  const afternoon = seasonalWorkWindows(DATE)[1].start
  const fixture = await setup(t, afternoon + 1_000)
  fixture.monitor.configure(config())
  fixture.setTime(afternoon - 1_000, 1_000)
  fixture.monitor.tick()
  await fixture.store.flush()
  const day = fixture.store.get(TEAM, PEER, DATE).day
  assert.equal(day.incomplete, true)
  assert.deepEqual(day.intervals, [])
  assert.equal(day.diagnostics[0].code, 'clock-change')
  assert.equal(day.diagnostics[0].at, afternoon - 1_000)
  assert.equal(day.diagnostics[0].start, undefined)
  assert.equal(day.diagnostics[0].end, undefined)
  assert.equal(fixture.monitor.getLive().state, 'outside-work')
})

test('回拨超过未来容差后仍保存本机已确认观测及诊断，重启不丢失', async (t) => {
  const afternoon = seasonalWorkWindows(DATE)[1].start
  const fixture = await setup(t, afternoon + 1_000)
  fixture.monitor.configure(config())
  fixture.setTime(afternoon - 5_000, 1_000)
  fixture.monitor.tick()
  await fixture.store.flush()
  const day = fixture.store.get(TEAM, PEER, DATE).day
  assert.equal(day.incomplete, true)
  assert.equal(day.diagnostics[0].code, 'clock-change')
  const restored = new ActivityStore(fixture.store.directory, fixture.now)
  await restored.initialize()
  assert.deepEqual(restored.get(TEAM, PEER, DATE).day.diagnostics, day.diagnostics)
})

for (const [scope, rollbackMs] of [
  ['同日', CLOCK_ROLLBACK_MS],
  ['跨日', DAY_MS + CLOCK_ROLLBACK_MS]
]) {
  test(`${scope}回拨后立即重启并继续采集，不覆盖已保存区间及诊断`, async (t) => {
    const fixture = await setup(t)
    fixture.monitor.configure(config())
    fixture.setTime(START + ACTIVITY_CHECKPOINT_MS)
    fixture.monitor.tick()
    await fixture.store.flush()
    const observedAt = START + ACTIVITY_CHECKPOINT_MS + ACTIVITY_SAMPLE_MS * 2
    fixture.setTime(observedAt)
    fixture.monitor.tick()
    fixture.setTime(observedAt - rollbackMs, observedAt - START)
    fixture.monitor.tick()
    await fixture.monitor.stop()
    const saved = fixture.store.get(TEAM, PEER, DATE).day
    assert.ok(saved.intervals.length > 0)
    assert.ok(saved.diagnostics.some(({ code }) => code === 'clock-change'))

    const restored = new ActivityStore(fixture.store.directory, fixture.now)
    await restored.initialize()
    assert.deepEqual(restored.get(TEAM, PEER, DATE).day, saved)
    assert.equal(restored.issues.size, 0)
    const restarted = new ActivityMonitor({
      store: restored,
      calendar: fixture.calendar,
      readInput: () => ({ idleSeconds: 0, kind: 'idle' }),
      now: fixture.now
    })
    t.after(() => restarted.stop())
    restarted.configure(config())
    await restarted.stop()
    assert.deepEqual(restored.get(TEAM, PEER, DATE).day.intervals, saved.intervals)
    fixture.setTime(observedAt + ACTIVITY_SAMPLE_MS)
    restarted.configure(config())
    await restarted.stop()
    const afterSampling = new ActivityStore(fixture.store.directory, fixture.now)
    await afterSampling.initialize()
    const continued = afterSampling.get(TEAM, PEER, DATE).day
    assert.ok(continued.revision > saved.revision)
    assert.deepEqual(continued.intervals.slice(0, saved.intervals.length), saved.intervals)
    assert.deepEqual(continued.diagnostics, saved.diagnostics)
  })
}

for (const [scope, sourceNow] of [
  ['同日', START + 40 * MINUTE_MS],
  ['跨日', FUTURE_START]
]) {
  test(`停机期间${scope}回拨后恢复日报并继续锁屏采样`, async (t) => {
    await verifyStoppedClockRollback(t, sourceNow)
  })
}

for (const [scope, rollbackAt] of [
  ['早晨', seasonalWorkWindows(DATE)[0].start - 30 * MINUTE_MS],
  ['午休', seasonalWorkWindows(DATE)[0].end + 30 * MINUTE_MS]
]) {
  test(`停机回拨到${scope}后重启会裁剪同日日报且不采集输入`, async (t) => {
    const fixture = await setup(t)
    const morning = await recordActiveHistory(fixture)
    const source = await recordAfternoonFuture(fixture)
    assert.ok(source.observedAt > rollbackAt)
    assert.ok(source.lastInputAt > rollbackAt)
    assert.ok(source.diagnostics.some(({ at }) => at > rollbackAt))

    fixture.setTime(rollbackAt, 0)
    const store = new ActivityStore(fixture.store.directory, fixture.now)
    await store.initialize()
    let reads = 0
    const restarted = new ActivityMonitor({
      store,
      calendar: fixture.calendar,
      readInput: () => {
        reads++
        return { idleSeconds: 0, kind: 'idle' }
      },
      now: fixture.now,
      monotonic: () => 0
    })
    t.after(() => restarted.stop())
    restarted.configure(config())
    await store.flush()

    const day = store.get(TEAM, PEER, DATE).day
    assert.deepEqual(day.intervals, rollbackAt > START ? morning.intervals : [])
    assert.equal(day.observedAt, rollbackAt)
    assert.equal(day.firstInputAt, rollbackAt > START ? START : undefined)
    assert.equal(day.lastInputAt, undefined)
    assert.deepEqual(day.diagnostics, [
      { code: 'clock-change', at: rollbackAt, start: undefined, end: undefined }
    ])
    assert.ok(day.revision > source.revision)
    assert.equal(reads, 0)
    assert.equal(restarted.getLive().state, 'outside-work')
  })
}

test('运行中回拨到更早时间会立即checkpoint裁剪后的日报', async (t) => {
  const fixture = await setup(t)
  const source = await recordActiveHistory(fixture)
  await fixture.store.save(source, fixture.now())
  await fixture.store.flush()
  const beforeRollback = new ActivityStore(fixture.store.directory, fixture.now)
  await beforeRollback.initialize()
  assert.equal(beforeRollback.get(TEAM, PEER, DATE).day.observedAt, START + 40 * MINUTE_MS)

  const rollbackAt = START + 30 * MINUTE_MS
  fixture.setInput({ idleSeconds: 0, kind: 'locked' })
  fixture.setTime(rollbackAt, 0)
  fixture.monitor.tick(rollbackAt)
  await fixture.store.flush()

  const reloaded = new ActivityStore(fixture.store.directory, fixture.now)
  await reloaded.initialize()
  const day = reloaded.get(TEAM, PEER, DATE).day
  assert.equal(day.observedAt, rollbackAt)
  assert.deepEqual(day.intervals, [{ start: START, end: rollbackAt, kind: 'active' }])
  assert.ok(day.diagnostics.some(({ code }) => code === 'clock-change'))
  assert.ok(day.revision > source.revision)
})

test('锁屏解锁不制造零时长缺口，休眠恢复只记已确认工作时段', async (t) => {
  const fixture = await setup(t)
  fixture.monitor.configure(config())
  fixture.setTime(START + 5_000, 5_000)
  fixture.setInput({ idleSeconds: 5, kind: 'idle' })
  fixture.monitor.tick()

  fixture.setTime(START + 10_000, 10_000)
  await fixture.monitor.systemEvent('lock')
  fixture.setTime(START + MINUTE_MS + 10_000, MINUTE_MS + 10_000)
  await fixture.monitor.systemEvent('unlock')
  let day = fixture.store.get(TEAM, PEER, DATE).day
  assert.equal(day.incomplete, false)
  assert.equal(
    day.intervals
      .filter((interval) => interval.kind === 'locked')
      .reduce((sum, interval) => sum + interval.end - interval.start, 0),
    MINUTE_MS
  )
  assert.equal(fixture.monitor.getLive().state, 'idle')

  fixture.setTime(START + 2 * MINUTE_MS, 2 * MINUTE_MS)
  await fixture.monitor.systemEvent('suspend')
  fixture.setTime(START + 12 * MINUTE_MS, 12 * MINUTE_MS)
  await fixture.monitor.systemEvent('resume')
  day = fixture.store.get(TEAM, PEER, DATE).day
  assert.equal(
    day.intervals
      .filter((interval) => interval.kind === 'suspended')
      .reduce((sum, interval) => sum + interval.end - interval.start, 0),
    10 * MINUTE_MS
  )
})

test('停止、切换团队和 opt-out 都结束当前 recorder，不继续读取输入', async (t) => {
  const fixture = await setup(t)
  fixture.monitor.configure(config())
  fixture.setTime(START + 5_000, 5_000)
  fixture.monitor.tick()
  fixture.monitor.configure(config(OTHER_TEAM))
  await fixture.store.flush()
  assert.ok(fixture.store.get(TEAM, PEER, DATE))
  assert.ok(fixture.store.get(OTHER_TEAM, PEER, DATE))

  const readsBeforeOptOut = fixture.reads
  fixture.monitor.configure(config(OTHER_TEAM, false))
  assert.equal(fixture.monitor.getLive().enabled, false)
  fixture.setTime(START + 10_000, 10_000)
  fixture.monitor.tick()
  assert.equal(fixture.reads, readsBeforeOptOut)

  fixture.monitor.configure(config())
  await fixture.monitor.stop()
  assert.equal(fixture.monitor.getLive().state, 'disabled')
  assert.equal(fixture.monitor.getLive().enabled, false)
})

assert.equal(seasonalWorkWindows(DATE).length, 2)

for (const [startEvent, endEvent, kind] of [
  ['lock', 'unlock', 'locked'],
  ['suspend', 'resume', 'suspended']
]) {
  test(`${startEvent}写盘阻塞时${endEvent}立即生效，不虚增未活动时长`, async (t) => {
    const fixture = await setup(t)
    fixture.monitor.configure(config())
    await fixture.store.flush()
    const gate = Promise.withResolvers()
    const started = Promise.withResolvers()
    t.after(() => gate.resolve())
    const save = fixture.store.save.bind(fixture.store)
    let blocked = false
    fixture.store.save = async (day) => {
      if (!blocked) {
        blocked = true
        started.resolve()
        await gate.promise
      }
      return save(day)
    }
    fixture.setTime(START + 5000)
    const lock = fixture.monitor.systemEvent(startEvent)
    await started.promise
    fixture.setTime(START + 10000)
    const unlock = fixture.monitor.systemEvent(endEvent)
    assert.equal(fixture.monitor.getLive().state, 'idle')
    for (const elapsed of [15000, 20000, 25000]) {
      fixture.setTime(START + elapsed)
      fixture.monitor.tick()
    }
    const day = fixture.store.get(TEAM, PEER, DATE).day
    assert.equal(
      day.intervals
        .filter((interval) => interval.kind === kind)
        .reduce((sum, interval) => sum + interval.end - interval.start, 0),
      5000
    )
    assert.equal(day.incomplete, false)
    gate.resolve()
    await Promise.all([lock, unlock])
    await fixture.store.flush()
    assert.deepEqual(fixture.store.get(TEAM, PEER, DATE).day, day)
  })
}

test('跨日休眠补记先更新内存，慢写盘期间继续采样且保留4小时已确认休眠', async (t) => {
  const fixture = await setup(t)
  fixture.monitor.configure(config())
  await fixture.monitor.systemEvent('suspend')
  await fixture.store.flush()
  const gate = Promise.withResolvers()
  const started = Promise.withResolvers()
  t.after(() => gate.resolve())
  const save = fixture.store.save.bind(fixture.store)
  fixture.store.save = async (day) => {
    if (
      day.date === DATE &&
      day.intervals.some((interval) => interval.start >= seasonalWorkWindows(DATE)[1].start)
    ) {
      started.resolve()
      await gate.promise
    }
    return save(day)
  }
  const resumedAt = Date.parse('2026-10-14T14:00:00+08:00')
  fixture.setTime(resumedAt)
  const resume = fixture.monitor.systemEvent('resume')
  await started.promise
  const readsBeforeUnlock = fixture.reads
  const unlock = fixture.monitor.systemEvent('unlock')
  assert.equal(fixture.monitor.getLive().state, 'idle')
  fixture.setTime(resumedAt + 5000)
  fixture.monitor.tick()
  assert.equal(fixture.reads, readsBeforeUnlock + 2)
  const day = fixture.store.get(TEAM, PEER, '2026-10-14').day
  assert.equal(
    day.intervals
      .filter((interval) => interval.kind === 'suspended')
      .reduce((sum, interval) => sum + interval.end - interval.start, 0),
    240 * MINUTE_MS
  )
  assert.equal(day.incomplete, false)
  assert.equal(fixture.monitor.getLive().state, 'idle')
  gate.resolve()
  await Promise.all([resume, unlock])
  await fixture.store.flush()
  assert.deepEqual(fixture.store.get(TEAM, PEER, '2026-10-14').day, day)
})

test('跨日补记落盘期间换组、关闭或停止，旧写入完成不能恢复旧配置状态', async (t) => {
  for (const change of ['team', 'opt-out', 'stop']) {
    const fixture = await setup(t)
    fixture.monitor.configure(config())
    await fixture.monitor.systemEvent('suspend')
    await fixture.store.flush()
    const gate = Promise.withResolvers()
    const started = Promise.withResolvers()
    t.after(() => gate.resolve())
    const save = fixture.store.save.bind(fixture.store)
    fixture.store.save = async (day) => {
      if (day.date === DATE && day.intervals.some((interval) => interval.kind === 'suspended')) {
        started.resolve()
        await gate.promise
      }
      return save(day)
    }
    const resumedAt = Date.parse('2026-10-14T14:00:00+08:00')
    fixture.setTime(resumedAt)
    const resume = fixture.monitor.systemEvent('resume')
    await started.promise
    const confirmed = fixture.store.get(TEAM, PEER, '2026-10-14').day
    assert.ok(confirmed.intervals.some((interval) => interval.kind === 'suspended'))
    let stopping
    if (change === 'stop') stopping = fixture.monitor.stop()
    else fixture.monitor.configure(change === 'team' ? config(OTHER_TEAM) : config(TEAM, false))
    const oldDay = fixture.store.get(TEAM, PEER, '2026-10-14').day
    const configuredLive = fixture.monitor.getLive()
    gate.resolve()
    await Promise.all([resume, stopping])
    await fixture.store.flush()
    assert.deepEqual(fixture.store.get(TEAM, PEER, '2026-10-14').day, oldDay)
    assert.deepEqual(fixture.monitor.getLive(), configuredLive)
    if (change === 'team')
      assert.deepEqual(fixture.store.get(OTHER_TEAM, PEER, '2026-10-14').day.intervals, [])
    if (change !== 'team') assert.equal(fixture.monitor.getLive().state, 'disabled')
  }
})
