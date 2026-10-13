/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import test from 'node:test'
import seed from '../resources/holidays/2026.json' with { type: 'json' }
import { ActivityMonitor } from '../src/main/services/activity-monitor.ts'
import { ActivityStore } from '../src/main/services/activity-store.ts'
import { WorkCalendarService } from '../src/main/services/work-calendar.ts'
import { MINUTE_MS, seasonalWorkWindows } from '../src/shared/work-time.ts'

const DATE = '2026-10-13'
const TEAM = '123456abcdef'
const OTHER_TEAM = 'abcdef123456'
const PEER = '10000000-0000-4000-8000-000000000001'
const START = Date.parse(`${DATE}T09:00:00+08:00`)

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
