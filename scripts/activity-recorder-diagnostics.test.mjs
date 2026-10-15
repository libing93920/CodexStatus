/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import test from 'node:test'
import { ActivityRecorder } from '../src/shared/activity-recorder.ts'
import {
  ACTIVITY_MAX_DIAGNOSTICS,
  validateActivityDay,
  validateActivityMessage
} from '../src/shared/activity.ts'
import { DAY_MS, MINUTE_MS, seasonalWorkWindows } from '../src/shared/work-time.ts'

const DATE = '2026-10-13'
const START = Date.parse(`${DATE}T09:00:00+08:00`)
const NOW = Date.parse(`${DATE}T18:00:00+08:00`)
const WINDOWS = seasonalWorkWindows(DATE)
const SAMPLE_MS = 5_000
const GAP_MS = 16_000

function recorder() {
  return new ActivityRecorder({
    version: 1,
    team: '123456abcdef',
    peerId: '10000000-0000-4000-8000-000000000001',
    nickname: '测试成员',
    date: DATE,
    revision: 1,
    calendarVersion: 'test-calendar',
    observedAt: START,
    intervals: [],
    incomplete: false
  })
}

function observe(target, elapsed, input = {}) {
  return target.observe(
    { now: START + elapsed, monotonic: elapsed, idleSeconds: 0, kind: 'idle', ...input },
    WINDOWS
  )
}

test('采样缺口保存准确范围和原因，后续正常采样及重启不清除', () => {
  const target = recorder()
  observe(target, 0)
  const gap = observe(target, GAP_MS)
  assert.deepEqual(gap.diagnostics, [
    { code: 'sample-gap', at: START + GAP_MS, start: START, end: START + GAP_MS }
  ])
  assert.equal(gap.incomplete, true)
  const normal = observe(target, GAP_MS + SAMPLE_MS)
  const restarted = new ActivityRecorder(normal)
  observe(restarted, GAP_MS + 2 * SAMPLE_MS)
  const resumed = observe(restarted, GAP_MS + 3 * SAMPLE_MS)
  assert.deepEqual(resumed.diagnostics, gap.diagnostics)
  assert.equal(validateActivityDay(resumed, NOW), true)
})

test('时钟偏差和倒退分别留下区间诊断和时间点诊断，不造负时长', () => {
  const target = recorder()
  observe(target, 0)
  const changed = observe(target, SAMPLE_MS, { monotonic: 0 })
  assert.equal(changed.diagnostics[0].code, 'clock-change')
  assert.equal(changed.diagnostics[0].start, START)
  const backward = observe(target, SAMPLE_MS - 1_000, { monotonic: 2 * SAMPLE_MS })
  assert.deepEqual(backward.diagnostics.at(-1), {
    code: 'clock-change',
    at: START + SAMPLE_MS - 1_000
  })
  assert.equal(
    backward.intervals.every(({ start, end }) => end > start),
    true
  )
  assert.equal(validateActivityDay(backward, NOW), true)
})

test('回拨进入午休、早晨或前一天时保留时钟诊断，不补出未来工作区间', () => {
  const afternoon = Date.parse(`${DATE}T14:00:00+08:00`)
  for (const time of ['12:30:00', '10:00:00']) {
    const target = recorder()
    observe(target, afternoon - START)
    const result = observe(target, Date.parse(`${DATE}T${time}+08:00`) - START)
    assert.equal(result.incomplete, true)
    assert.equal(result.diagnostics[0].code, 'clock-change')
    assert.deepEqual(result.intervals, [])
    assert.equal(validateActivityDay(result, NOW), true)
  }
  const previousDay = recorder()
  observe(previousDay, afternoon - START)
  const ended = previousDay.finish(START - DAY_MS)
  assert.equal(ended.diagnostics[0].code, 'clock-change')
  assert.equal(validateActivityDay(ended, NOW), true)
})

test('重启首次采样识别日内回拨，保留前缀并裁剪未来区间、输入及诊断', () => {
  const rollbackAt = START + MINUTE_MS
  const observedAt = rollbackAt + MINUTE_MS
  const unknownStart = START + SAMPLE_MS
  for (const firstInputAt of [START, observedAt]) {
    const target = new ActivityRecorder({
      ...recorder().snapshot(),
      observedAt,
      firstInputAt,
      lastInputAt: observedAt,
      intervals: [
        { start: START, end: unknownStart, kind: 'active' },
        { start: unknownStart, end: observedAt, kind: 'unknown' }
      ],
      incomplete: true,
      diagnostics: [
        { code: 'input-read-failed', at: unknownStart },
        { code: 'sample-gap', at: observedAt, start: unknownStart, end: observedAt },
        { code: 'clock-change', at: observedAt }
      ]
    })
    const resumed = observe(target, rollbackAt - START, { kind: 'locked' })
    assert.equal(resumed.observedAt, rollbackAt)
    assert.equal(resumed.firstInputAt, firstInputAt === START ? START : undefined)
    assert.equal(resumed.lastInputAt, undefined)
    assert.deepEqual(resumed.intervals, [
      { start: START, end: unknownStart, kind: 'active' },
      { start: unknownStart, end: rollbackAt, kind: 'unknown' }
    ])
    assert.deepEqual(resumed.diagnostics, [
      { code: 'input-read-failed', at: unknownStart },
      { code: 'sample-gap', at: rollbackAt, start: unknownStart, end: rollbackAt },
      { code: 'clock-change', at: rollbackAt }
    ])
    assert.equal(validateActivityDay(resumed, rollbackAt), true)
    assert.equal(
      validateActivityMessage({ type: 'activity-live', live: target.live() }, rollbackAt),
      true
    )
  }
})

test('未知状态及非法idle值记录输入不可用，读取失败保留独立原因', () => {
  for (const input of [
    { kind: 'unknown' },
    { idleSeconds: Number.NaN },
    { idleSeconds: -1 },
    { kind: 'unknown', inputIssue: 'input-read-failed' }
  ]) {
    const target = recorder()
    observe(target, 0)
    const result = observe(target, SAMPLE_MS, input)
    assert.equal(result.diagnostics[0].code, input.inputIssue ?? 'input-unavailable')
    assert.equal(result.intervals[0].kind, 'unknown')
    assert.equal(validateActivityDay(result, NOW), true)
  }
})

test('相邻相同原因合并，但连续未知区间中的不同原因仍各自保留', () => {
  const target = recorder()
  observe(target, 0)
  observe(target, SAMPLE_MS, { kind: 'unknown', inputIssue: 'input-read-failed' })
  observe(target, 2 * SAMPLE_MS, { kind: 'unknown' })
  observe(target, 3 * SAMPLE_MS)
  const result = target.snapshot()
  assert.equal(result.intervals.length, 1)
  assert.deepEqual(
    result.diagnostics.map(({ code, start, end }) => ({ code, start, end })),
    [
      { code: 'input-read-failed', start: START, end: START + 2 * SAMPLE_MS },
      { code: 'input-unavailable', start: START + 2 * SAMPLE_MS, end: START + 3 * SAMPLE_MS }
    ]
  )
})

test('结束采样也保存缺口原因，已确认锁屏和休眠不产生假诊断', () => {
  const target = recorder()
  observe(target, 0)
  const ended = target.finish(START + GAP_MS)
  assert.equal(ended.diagnostics[0].code, 'sample-gap')
  for (const kind of ['locked', 'suspended']) {
    const known = recorder()
    observe(known, 0, { kind })
    const result = known.finish(START + GAP_MS)
    assert.equal(result.incomplete, false)
    assert.equal(result.diagnostics?.length ?? 0, 0)
    assert.equal(result.intervals[0].kind, kind)
  }
  const unknown = recorder()
  observe(unknown, 0, { kind: 'unknown', inputIssue: 'input-read-failed' })
  assert.equal(unknown.finish(START + SAMPLE_MS).diagnostics[0].code, 'input-read-failed')
})

test('诊断条目达到上限后仍保留未知区间和不完整标记，不生成超限日报', () => {
  const target = recorder()
  for (let index = 0; index <= ACTIVITY_MAX_DIAGNOSTICS + 1; index++) {
    observe(target, index * SAMPLE_MS, {
      kind: 'unknown',
      inputIssue: index % 2 ? 'input-read-failed' : 'input-unavailable'
    })
  }
  const result = target.snapshot()
  assert.equal(result.diagnostics.length, ACTIVITY_MAX_DIAGNOSTICS)
  assert.equal(result.incomplete, true)
  assert.equal(result.intervals.at(-1).end, START + (ACTIVITY_MAX_DIAGNOSTICS + 1) * SAMPLE_MS)
  assert.equal(validateActivityDay(result, NOW), true)
})
