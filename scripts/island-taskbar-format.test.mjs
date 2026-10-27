import assert from 'node:assert/strict'
import test from 'node:test'

import {
  formatTaskbarCount,
  formatTaskbarDuration
} from '../src/renderer/src/island/taskbar-formatters.ts'

const taskbarCountCases = [
  [0, '0'],
  [1, '1'],
  [99, '99'],
  [100, '99+'],
  [12345, '99+']
]

const taskbarDurationCases = [
  [0, '00:00'],
  [59, '00:59'],
  [60, '01:00'],
  [3599, '59:59'],
  [3600, '1h00m'],
  [35999, '9h59m'],
  [86399, '23h59m'],
  [86400, '1d0h'],
  [7407419, '85d17h'],
  [undefined, '--:--']
]

test('任务栏计数仅在超过 99 时压缩显示且不修改输入', () => {
  for (const [count, expected] of taskbarCountCases) {
    const originalCount = count
    assert.equal(formatTaskbarCount(count), expected)
    assert.equal(count, originalCount)
  }
})

test('任务栏耗时按长度格式化且不修改输入', () => {
  for (const [seconds, expected] of taskbarDurationCases) {
    const originalSeconds = seconds
    assert.equal(formatTaskbarDuration(seconds), expected)
    assert.equal(seconds, originalSeconds)
  }
})
