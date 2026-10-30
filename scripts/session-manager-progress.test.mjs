/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import test from 'node:test'

import { createScanProgressReporter } from '../src/main/tools/session-cleaner/scan-progress.ts'

function progress(visited) {
  return { visited, bytes: visited }
}

test('首次进度立即发送，后续最多每 100ms 发送一次', () => {
  let now = 0
  const sent = []
  const reporter = createScanProgressReporter(
    (value) => sent.push(value),
    () => now
  )

  reporter.report(progress(0))
  for (now = 1; now < 100; now++) reporter.report(progress(now))
  assert.deepEqual(sent, [progress(0)])

  reporter.report(progress(100))
  assert.deepEqual(sent, [progress(0), progress(100)])

  now = 199
  reporter.report(progress(199))
  now = 200
  reporter.report(progress(200))
  assert.deepEqual(sent, [progress(0), progress(100), progress(200)])
  reporter.finish()
})

test('完成或取消时 flush 最后进度，关闭后的回调不串入重复扫描', () => {
  let now = 0
  const sent = []
  const firstScan = createScanProgressReporter(
    (value) => sent.push({ scan: 'first', progress: value }),
    () => now
  )

  firstScan.report(progress(1))
  now = 20
  firstScan.report(progress(2))
  firstScan.finish()
  firstScan.report(progress(3))
  firstScan.finish()

  const secondScan = createScanProgressReporter(
    (value) => sent.push({ scan: 'second', progress: value }),
    () => now
  )
  secondScan.report(progress(0))
  now = 40
  secondScan.report(progress(1))
  secondScan.finish()
  secondScan.report(progress(2))

  assert.deepEqual(sent, [
    { scan: 'first', progress: progress(1) },
    { scan: 'first', progress: progress(2) },
    { scan: 'second', progress: progress(0) },
    { scan: 'second', progress: progress(1) }
  ])
})
