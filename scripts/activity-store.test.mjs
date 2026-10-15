/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import path from 'node:path'
import seed from '../resources/holidays/2026.json' with { type: 'json' }
import { ActivityStore } from '../src/main/services/activity-store.ts'
import { WorkCalendarService, fetchHolidayYear } from '../src/main/services/work-calendar.ts'
import { DAY_MS, MINUTE_MS } from '../src/shared/work-time.ts'

const DATE = '2026-10-13'
const HISTORY_DATE = '2026-10-12'
const NOW = Date.parse(`${DATE}T18:00:00+08:00`)
const RETRY_DELAY_MS = 5 * MINUTE_MS
const PEER = '10000000-0000-4000-8000-000000000001'
const TEAM = '123456abcdef'
const START = Date.parse(`${DATE}T09:00:00+08:00`)
const CLOCK_ROLLBACK_MS = 6_000

async function directory(t) {
  assert.ok(process.env.PI_SCRATCH_DIR, '测试临时文件必须在会话scratch目录')
  const root = await mkdtemp(path.join(process.env.PI_SCRATCH_DIR, 'activity-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
function day(revision = 1) {
  return {
    version: 1,
    team: TEAM,
    peerId: PEER,
    nickname: '测试成员',
    date: DATE,
    revision,
    calendarVersion: 'test-calendar',
    observedAt: START + MINUTE_MS,
    intervals: [{ start: START, end: START + MINUTE_MS, kind: 'idle' }],
    incomplete: false
  }
}
function fakeFetch(body = seed) {
  return async (url) =>
    url.endsWith('/2026.json')
      ? new Response(JSON.stringify(body))
      : new Response('', { status: 404 })
}

test('日报串行持久化、重启恢复、重复幂等，旧版本不能覆盖', async (t) => {
  const root = await directory(t)
  const store = new ActivityStore(root, () => NOW)
  await store.initialize()
  assert.equal(await store.save(day(2)), 'saved')
  assert.equal(await store.save(day(2)), 'unchanged')
  assert.equal(await store.save(day(1)), 'stale')
  await assert.rejects(store.save({ ...day(2), nickname: '版本冲突' }), /内容冲突/)
  assert.equal(store.get(TEAM, PEER, DATE).day.revision, 2)
  const reloaded = new ActivityStore(root, () => NOW)
  await reloaded.initialize()
  assert.equal(reloaded.get(TEAM, PEER, DATE).day.revision, 2)
  const files = await readdir(root)
  assert.equal(
    files.some((name) => name.endsWith('.tmp')),
    false
  )
})

test('默认写入拒绝超前观测，回拨后能恢复已确认日报', async (t) => {
  const root = await directory(t)
  const validDay = day()
  const confirmedAt = validDay.observedAt
  const writer = new ActivityStore(root, () => confirmedAt)
  await writer.initialize()
  assert.equal(await writer.save(validDay), 'saved')

  const now = confirmedAt - CLOCK_ROLLBACK_MS
  const strictStore = new ActivityStore(path.join(root, 'strict'), () => now)
  await strictStore.initialize()
  assert.throws(() => strictStore.stage({ ...validDay, revision: 2 }), /无效/)
  await assert.rejects(strictStore.save({ ...validDay, revision: 2 }), /无效/)

  const restored = new ActivityStore(root, () => now)
  await restored.initialize()
  assert.equal(restored.get(TEAM, PEER, DATE).day.revision, validDay.revision)
  assert.deepEqual(restored.get(TEAM, PEER, DATE).day.intervals, validDay.intervals)
  assert.equal(restored.issues.size, 0)
})

test('回拨后恢复仍拒绝损坏结构、区间、文件名身份及同步时间', async (t) => {
  const root = await directory(t)
  const validDay = day()
  const now = validDay.observedAt - CLOCK_ROLLBACK_MS
  const invalidFiles = [
    { name: 'structure', day: { ...validDay, version: 99 }, filePeer: PEER, receivedAt: NOW },
    {
      name: 'interval',
      day: {
        ...validDay,
        intervals: [{ ...validDay.intervals[0], end: validDay.observedAt + 1 }]
      },
      filePeer: PEER,
      receivedAt: NOW
    },
    {
      name: 'filename-identity',
      day: validDay,
      filePeer: '10000000-0000-4000-8000-000000000002',
      receivedAt: NOW
    },
    { name: 'received-at', day: validDay, filePeer: PEER, receivedAt: -1 }
  ]
  for (const invalid of invalidFiles) {
    const folder = path.join(root, invalid.name)
    await mkdir(folder, { recursive: true })
    const fileName = `${DATE}_${TEAM}_${invalid.filePeer}.json`
    await writeFile(
      path.join(folder, fileName),
      JSON.stringify({ day: invalid.day, receivedAt: invalid.receivedAt })
    )
    const damaged = new ActivityStore(folder, () => now)
    await damaged.initialize()
    assert.equal(damaged.get(TEAM, PEER, DATE), undefined, invalid.name)
    assert.equal(damaged.issues.size, 1, invalid.name)
  }
})

test('检查点不能覆盖内存新观测，持久化异常不确认成功', async (t) => {
  const root = await directory(t)
  const store = new ActivityStore(root, () => NOW)
  await store.initialize()
  store.stage(day(3))
  assert.equal(await store.save(day(2)), 'stale')
  assert.equal(await store.save(day(3)), 'saved')
  const invalidRoot = path.join(root, 'not-a-directory')
  await writeFile(invalidRoot, 'blocked')
  const broken = new ActivityStore(invalidRoot, () => NOW)
  await assert.rejects(broken.save(day()))
  await broken.flush()
  assert.ok(broken.issues.size > 0)
})

test('只清理确定的过期日报，坏文件报告不完整，跨团队隔离', async (t) => {
  const root = await directory(t)
  let now = NOW
  const store = new ActivityStore(root, () => now)
  await store.initialize()
  await store.save(day())
  assert.equal(store.list('abcdef123456', DATE).length, 0)
  const foreign = 'unrelated.json'
  await writeFile(path.join(root, foreign), 'keep')
  now += 30 * DAY_MS
  await store.prune()
  assert.equal(store.list(TEAM, DATE).length, 0)
  assert.deepEqual(await readdir(root), [foreign])
  assert.equal(await readFile(path.join(root, foreign), 'utf8'), 'keep')
  const brokenName = `${DATE}_${TEAM}_${PEER}.json`
  await writeFile(path.join(root, brokenName), '{broken')
  const reloaded = new ActivityStore(root, () => NOW)
  await reloaded.initialize()
  assert.ok(reloaded.issues.size > 0)
  assert.equal(reloaded.list(TEAM, DATE).length, 0)
})

test('单日查询只复制匹配日报，版本读取不复制，返回结果不能修改缓存', async (t) => {
  const store = new ActivityStore(await directory(t), () => NOW)
  store.stage(day(3))
  store.stage({
    ...day(),
    date: HISTORY_DATE,
    observedAt: START + MINUTE_MS - DAY_MS,
    intervals: [{ start: START - DAY_MS, end: START + MINUTE_MS - DAY_MS, kind: 'locked' }]
  })
  store.stage({ ...day(), team: 'abcdef123456' })
  const clone = globalThis.structuredClone
  const copies = t.mock.method(globalThis, 'structuredClone', (value) => clone(value))
  assert.equal(store.getRevision(TEAM, PEER, DATE), 3)
  assert.equal(store.getRevision(TEAM, PEER, HISTORY_DATE), 1)
  assert.equal(store.getRevision(TEAM, PEER, '2026-10-11'), 0)
  assert.equal(copies.mock.callCount(), 0)
  const selected = store.list(TEAM, DATE)
  assert.equal(selected.length, 1)
  assert.equal(copies.mock.callCount(), 1)
  selected[0].day.nickname = '外部修改'
  selected[0].day.intervals[0].kind = 'suspended'
  const saved = store.get(TEAM, PEER, DATE).day
  assert.equal(saved.nickname, '测试成员')
  assert.equal(saved.intervals[0].kind, 'idle')
  assert.deepEqual(store.list(TEAM, '2026-10-14'), [])
})

test('内置当年日历可离线用，缺失新年度不猜测，更新缓存重启可恢复', async (t) => {
  const root = await directory(t)
  const calendar = new WorkCalendarService(root, fakeFetch(), () => NOW)
  await calendar.initialize()
  assert.equal(calendar.getStatus('2026-10-10').isWorkday, true)
  assert.equal(calendar.getStatus('2026-10-01').isWorkday, false)
  assert.equal(calendar.getStatus('2027-01-04').available, false)
  await calendar.refresh()
  const offline = new WorkCalendarService(
    root,
    async () => {
      throw new Error('网络断开')
    },
    () => NOW
  )
  await offline.initialize()
  await offline.refresh(true)
  assert.equal(offline.getStatus(DATE).available, true)
  assert.match(offline.getStatus(DATE).error, /网络断开/)
  const cached = JSON.parse(await readFile(path.join(root, 'calendar.json'), 'utf8'))
  assert.equal(cached.calendars.find((item) => item.year === 2026).days.length, 39)
})

test('空占位日历不覆盖有效缓存；合并并发刷新；失败后5分钟重试', async (t) => {
  const root = await directory(t)
  let calls = 0
  let now = NOW
  const fetcher = async (url) => {
    calls++
    return fakeFetch({ year: 2026, papers: [], days: [] })(url)
  }
  const calendar = new WorkCalendarService(root, fetcher, () => now)
  await calendar.initialize()
  const first = calendar.refresh(true)
  assert.equal(calendar.refresh(true), first)
  await first
  assert.equal(calendar.getStatus(DATE).available, true)
  assert.match(calendar.getStatus(DATE).error, /尚未就绪/)
  await calendar.refresh()
  assert.equal(calls, 3)
  now += RETRY_DELAY_MS - 1
  await calendar.refresh()
  assert.equal(calls, 3)
  now += 1
  await calendar.refresh()
  assert.equal(calls, 6)
})

test('离线失败后5分钟重试，成功刷新后24小时节流', async (t) => {
  const root = await directory(t)
  let now = NOW
  let offline = true
  let calls = 0
  const fetcher = async (url) => {
    calls++
    if (offline) throw new Error('网络断开')
    return fakeFetch()(url)
  }
  const calendar = new WorkCalendarService(root, fetcher, () => now)
  await calendar.initialize()
  await calendar.refresh()
  assert.equal(calls, 3)
  assert.match(calendar.getStatus(DATE).error, /网络断开/)
  assert.equal(calendar.getStatus(DATE).available, true)

  offline = false
  now += 5 * MINUTE_MS - 1
  await calendar.refresh()
  assert.equal(calls, 3)
  now += 1
  await calendar.refresh()
  assert.equal(calls, 6)
  assert.equal(calendar.getStatus(DATE).error, undefined)

  now += DAY_MS - 1
  await calendar.refresh()
  assert.equal(calls, 6)
  now += 1
  await calendar.refresh()
  assert.equal(calls, 9)
})

test('缓存中的未来成功时间或超出5分钟的重试时间不阻止刷新', async (t) => {
  const checkedRoot = await directory(t)
  await writeFile(
    path.join(checkedRoot, 'calendar.json'),
    JSON.stringify({
      version: 1,
      calendars: [seed],
      checkedAt: NOW + DAY_MS,
      checkedYear: 2026
    })
  )
  let calls = 0
  const checkedCalendar = new WorkCalendarService(
    checkedRoot,
    async (url) => {
      calls++
      return fakeFetch()(url)
    },
    () => NOW
  )
  await checkedCalendar.initialize()
  await checkedCalendar.refresh()
  assert.equal(calls, 3)

  const retryRoot = await directory(t)
  await writeFile(
    path.join(retryRoot, 'calendar.json'),
    JSON.stringify({
      version: 1,
      calendars: [seed],
      retryAt: NOW + RETRY_DELAY_MS + MINUTE_MS,
      retryYear: 2026
    })
  )
  calls = 0
  const retryCalendar = new WorkCalendarService(
    retryRoot,
    async (url) => {
      calls++
      return fakeFetch()(url)
    },
    () => NOW
  )
  await retryCalendar.initialize()
  await retryCalendar.refresh()
  assert.equal(calls, 3)
})

test('跨年不等24小时，合法新年度及年末补充可以启用', async (t) => {
  const root = await directory(t)
  let now = Date.parse('2026-12-31T23:00:00+08:00')
  const next = {
    year: 2027,
    papers: ['https://www.gov.cn/test-fixture'],
    days: [
      { date: '2026-12-31', isOffDay: true },
      { date: '2027-01-01', isOffDay: true }
    ]
  }
  const calls = []
  const fetcher = async (url) => {
    calls.push(url)
    return url.endsWith('/2027.json') ? new Response(JSON.stringify(next)) : fakeFetch()(url)
  }
  const calendar = new WorkCalendarService(root, fetcher, () => now)
  await calendar.initialize()
  await calendar.refresh()
  assert.equal(calendar.getStatus('2026-12-31').isWorkday, false)
  now += 2 * 60 * MINUTE_MS
  await calendar.refresh()
  assert.equal(calls.length, 6)
  assert.equal(calendar.getStatus('2027-01-04').available, true)
  assert.equal(calendar.getStatus('2027-01-01').isWorkday, false)
})

test('拒绝过大响应和坏JSON，不执行远端内容', async () => {
  await assert.rejects(
    fetchHolidayYear(2026, async () => new Response(' '.repeat(256 * 1024 + 1))),
    /大小限制/
  )
  await assert.rejects(fetchHolidayYear(2026, async () => new Response('{not-json')))
  assert.equal(await fetchHolidayYear(2027, async () => new Response('{}')), undefined)
})
