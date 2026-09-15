import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clampProgressPercent,
  resolveMinimalMetricColor
} from '../src/renderer/src/minimal-quota.ts'

test('极简额度环限制剩余百分比边界', () => {
  assert.equal(clampProgressPercent(undefined), undefined)
  assert.equal(clampProgressPercent(Number.NaN), undefined)
  assert.equal(clampProgressPercent(-1), 0)
  assert.equal(clampProgressPercent(101), 100)
  assert.equal(clampProgressPercent(72.4), 72.4)
})

test('浅色主题使用可读的极简额度色', () => {
  assert.equal(resolveMinimalMetricColor(0, 'poster'), 'rgb(104, 21, 29)')
  assert.equal(resolveMinimalMetricColor(100, 'poster'), 'rgb(8, 59, 32)')
  assert.equal(resolveMinimalMetricColor(undefined, 'swiss'), '#1f2937')
})

test('钛金主题提高亮面上的额度色对比度', () => {
  assert.equal(resolveMinimalMetricColor(0, 'titan'), 'rgb(255, 190, 190)')
  assert.equal(resolveMinimalMetricColor(100, 'titan'), 'rgb(143, 230, 157)')
})
