import assert from 'node:assert/strict'
import test from 'node:test'

/* eslint-disable @typescript-eslint/explicit-function-return-type */

import {
  ISLAND_DIAG_FLUSH_DELAY_MS,
  ISLAND_DIAG_MAX_QUEUE,
  createIslandDiagBuffer,
  validateIslandDiagBatch
} from '../src/shared/island-diagnostics.ts'

class FakeClock {
  constructor() {
    this.time = 1_700_000_000_000
    this.monoTime = 100
    this.reads = 0
  }

  now = () => {
    this.reads++
    return this.time
  }

  mono = () => {
    this.reads++
    return this.monoTime
  }
}

class FakeScheduler {
  constructor() {
    this.jobs = []
    this.scheduled = []
    this.cleared = 0
  }

  setTimeout = (callback, delayMs) => {
    const job = { callback, delayMs, cleared: false }
    this.jobs.push(job)
    this.scheduled.push(delayMs)
    return job
  }

  clearTimeout = (job) => {
    if (job && !job.cleared) {
      job.cleared = true
      this.cleared++
    }
  }

  run() {
    const jobs = this.jobs.splice(0)
    for (const job of jobs) {
      if (!job.cleared) {
        job.cleared = true
        job.callback()
      }
    }
  }
}

function testOptions(clock, scheduler) {
  return { clock, scheduler }
}

function validEvent(overrides = {}) {
  return {
    instance: '00000000-0000-4000-8000-000000000000',
    seq: 1,
    at: 1_700_000_000_000,
    mono: 100,
    event: 'ready',
    fields: { reason: 'bootstrap', mode: 'hidden' },
    ...overrides
  }
}

test('默认关闭时 record 不读时钟、不排队、不发送', () => {
  const clock = new FakeClock()
  const scheduler = new FakeScheduler()
  const sent = []
  const buffer = createIslandDiagBuffer((batch) => sent.push(batch), testOptions(clock, scheduler))

  assert.equal(buffer.enabled, false)
  assert.equal(buffer.instance, undefined)
  assert.equal(buffer.record('ready'), undefined)
  buffer.flush()
  assert.equal(clock.reads, 0)
  assert.equal(scheduler.scheduled.length, 0)
  assert.deepEqual(sent, [])
})

test('事件延迟 50ms 批量发送且队列与 IPC 有界', () => {
  const clock = new FakeClock()
  const scheduler = new FakeScheduler()
  const sent = []
  const buffer = createIslandDiagBuffer((batch) => sent.push(batch), testOptions(clock, scheduler))
  buffer.setEnabled(true)

  for (let index = 0; index < 100_000; index++) buffer.record('pointer', { reason: 'move' })
  assert.equal(scheduler.scheduled.length, 1)
  assert.equal(scheduler.scheduled[0], ISLAND_DIAG_FLUSH_DELAY_MS)
  scheduler.run()

  assert.equal(sent.length, 1)
  assert.equal(sent[0].events.length, ISLAND_DIAG_MAX_QUEUE)
  assert.equal(sent[0].dropped, 100_000 - ISLAND_DIAG_MAX_QUEUE)
  assert.ok(sent[0].events.every((event) => event.event === 'pointer'))
  assert.equal(buffer.instance?.length, 36)
  assert.equal(scheduler.scheduled.length, 1)
})

test('限速丢弃在无事件时也以 dropped-only 批次报告', () => {
  const clock = new FakeClock()
  const scheduler = new FakeScheduler()
  const sent = []
  const buffer = createIslandDiagBuffer((batch) => sent.push(batch), testOptions(clock, scheduler))
  buffer.setEnabled(true)

  let accepted = 0
  while (accepted < 200) {
    const seq = buffer.record('ready')
    if (seq !== undefined) accepted++
    if (accepted % ISLAND_DIAG_MAX_QUEUE === 0) buffer.flush()
  }
  buffer.flush()
  assert.equal(buffer.record('ready'), undefined)
  scheduler.run()

  assert.equal(sent.at(-1).events.length, 0)
  assert.equal(sent.at(-1).dropped, 1)
})

test('dispose 清理待发资源但允许 StrictMode 重挂载后重新开启', () => {
  const clock = new FakeClock()
  const scheduler = new FakeScheduler()
  const sent = []
  const buffer = createIslandDiagBuffer((batch) => sent.push(batch), testOptions(clock, scheduler))
  buffer.setEnabled(true)
  buffer.record('ready')
  buffer.dispose()
  scheduler.run()
  assert.deepEqual(sent, [])
  assert.equal(buffer.enabled, false)

  buffer.setEnabled(true)
  assert.equal(buffer.record('ready'), 2)
  buffer.flush()
  assert.equal(sent.length, 1)
})

test('validateIslandDiagBatch 拒绝未知字段、正文、超限和坏值', () => {
  const valid = { events: [validEvent()], dropped: 0 }
  assert.equal(validateIslandDiagBatch(valid), true)
  assert.equal(validateIslandDiagBatch({ events: [], dropped: 0 }), false)
  assert.equal(validateIslandDiagBatch({ ...valid, extra: 'body' }), false)
  assert.equal(
    validateIslandDiagBatch({
      events: [{ ...validEvent(), fields: { body: 'secret' } }],
      dropped: 0
    }),
    false
  )
  assert.equal(
    validateIslandDiagBatch({
      events: [{ ...validEvent(), fields: { reason: 'has space' } }],
      dropped: 0
    }),
    false
  )
  assert.equal(
    validateIslandDiagBatch({ events: [{ ...validEvent(), seq: Number.NaN }], dropped: 0 }),
    false
  )
  assert.equal(
    validateIslandDiagBatch({
      events: [{ ...validEvent(), instance: 'not an instance' }],
      dropped: 0
    }),
    false
  )
  assert.equal(
    validateIslandDiagBatch({
      events: [validEvent(), ...Array(ISLAND_DIAG_MAX_QUEUE).fill(validEvent())],
      dropped: 0
    }),
    false
  )
})

test('validateIslandDiagBatch 接受交互与展开字段并拒绝错误类型和非有限数', () => {
  const fields = {
    reason: 'interactive-applied',
    mode: 'expanded',
    previousInteractive: false,
    hitInside: true,
    domInside: true,
    relatedInside: false,
    pendingHitTest: false,
    pointValid: true,
    expansion: 2,
    expandedAge: 125.5
  }
  const valid = { events: [validEvent({ fields })], dropped: 0 }
  assert.equal(validateIslandDiagBatch(valid), true)

  for (const field of [
    'previousInteractive',
    'hitInside',
    'domInside',
    'relatedInside',
    'pendingHitTest',
    'pointValid'
  ]) {
    assert.equal(
      validateIslandDiagBatch({
        events: [validEvent({ fields: { ...fields, [field]: 1 } })],
        dropped: 0
      }),
      false,
      `${field} 必须是布尔值`
    )
  }

  for (const field of ['expansion', 'expandedAge']) {
    assert.equal(
      validateIslandDiagBatch({
        events: [validEvent({ fields: { ...fields, [field]: '125.5' } })],
        dropped: 0
      }),
      false,
      `${field} 必须是数值`
    )
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.equal(
        validateIslandDiagBatch({
          events: [validEvent({ fields: { ...fields, [field]: value } })],
          dropped: 0
        }),
        false,
        `${field} 不得为非有限数`
      )
    }
  }

  assert.equal(
    validateIslandDiagBatch({
      events: [validEvent({ fields: { ...fields, unknownDiagnosticField: true } })],
      dropped: 0
    }),
    false
  )
})
