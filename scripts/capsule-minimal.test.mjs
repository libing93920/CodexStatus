import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clampProgressPercent,
  resolveMetricColor,
  resolveMinimalMetricColor
} from '../src/renderer/src/minimal-quota.ts'

test('极简额度环限制剩余百分比边界', () => {
  assert.equal(clampProgressPercent(undefined), undefined)
  assert.equal(clampProgressPercent(Number.NaN), undefined)
  assert.equal(clampProgressPercent(-1), 0)
  assert.equal(clampProgressPercent(101), 100)
  assert.equal(clampProgressPercent(72.4), 72.4)
})

test('额度状态色按浅色和深色背景分四档', () => {
  assert.deepEqual(
    [
      resolveMetricColor(100, 'remaining', 'midnight'),
      resolveMetricColor(50.01, 'remaining', 'midnight'),
      resolveMetricColor(50, 'remaining', 'midnight'),
      resolveMetricColor(25, 'remaining', 'midnight'),
      resolveMetricColor(24.99, 'remaining', 'midnight'),
      resolveMetricColor(10, 'remaining', 'midnight'),
      resolveMetricColor(9.99, 'remaining', 'midnight')
    ],
    ['#4ADE80', '#4ADE80', '#FACC15', '#FACC15', '#FB923C', '#FB923C', '#F87171']
  )
  assert.deepEqual(
    [
      resolveMetricColor(100, 'remaining', 'poster'),
      resolveMetricColor(50.01, 'remaining', 'poster'),
      resolveMetricColor(50, 'remaining', 'poster'),
      resolveMetricColor(25, 'remaining', 'poster'),
      resolveMetricColor(24.99, 'remaining', 'poster'),
      resolveMetricColor(10, 'remaining', 'poster'),
      resolveMetricColor(9.99, 'remaining', 'poster')
    ],
    ['#15803D', '#15803D', '#A16207', '#A16207', '#C2410C', '#C2410C', '#B91C1C']
  )
})

test('使用率模式按等价剩余额度取色', () => {
  assert.deepEqual(
    [
      resolveMetricColor(0, 'used', 'midnight'),
      resolveMetricColor(50, 'used', 'midnight'),
      resolveMetricColor(90, 'used', 'midnight'),
      resolveMetricColor(91, 'used', 'midnight')
    ],
    ['#4ADE80', '#FACC15', '#FB923C', '#F87171']
  )
})

test('浅色主题极简额度色复用统一分段色', () => {
  assert.equal(resolveMinimalMetricColor(0, 'poster'), '#B91C1C')
  assert.equal(resolveMinimalMetricColor(100, 'poster'), '#15803D')
  assert.equal(resolveMinimalMetricColor(undefined, 'swiss'), '#1f2937')
})

test('深色主题极简额度色使用深色调色板', () => {
  assert.equal(resolveMinimalMetricColor(0, 'titan'), '#F87171')
  assert.equal(resolveMinimalMetricColor(100, 'titan'), '#4ADE80')
})
