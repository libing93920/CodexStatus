import assert from 'node:assert/strict'
import test from 'node:test'
import {
  areOfficialDispatchResetAtsStable,
  parseOfficialDispatchResetAts,
  parseOfficialRateLimits,
  shouldRecheckOfficialRateLimits
} from '../src/main/services/quota.ts'

function rateLimits(primary, secondary) {
  return [
    { id: 'primary', label: '5h', usedPercent: primary },
    { id: 'secondary', label: '7d', usedPercent: secondary }
  ]
}

test('仅在所有官方窗口同时下降时复查', () => {
  const local = rateLimits(61, 10)

  assert.equal(shouldRecheckOfficialRateLimits(rateLimits(4, 1), local), true)
  assert.equal(shouldRecheckOfficialRateLimits(rateLimits(0, 0), local), true)
  assert.equal(shouldRecheckOfficialRateLimits(rateLimits(62, 10), local), false)
  assert.equal(shouldRecheckOfficialRateLimits(rateLimits(0, 10), local), false)
  assert.equal(
    shouldRecheckOfficialRateLimits(
      [{ id: 'daily', label: '1d', usedPercent: 5 }],
      [{ id: 'daily', label: '1d', usedPercent: 10 }]
    ),
    true
  )
})

test('按官方返回的全部窗口解析计时状态', () => {
  assert.deepEqual(
    parseOfficialDispatchResetAts({
      rate_limit: {
        primary_window: { reset_at: 123 },
        secondary_window: { reset_at: 456 }
      }
    }),
    { primary: 123, secondary: 456 }
  )
  assert.deepEqual(
    parseOfficialDispatchResetAts({ rate_limit: { primary_window: { reset_at: 123 } } }),
    { primary: 123 }
  )
  assert.equal(parseOfficialDispatchResetAts({ rate_limit: {} }), null)
  assert.equal(parseOfficialDispatchResetAts({}), undefined)

  assert.equal(
    areOfficialDispatchResetAtsStable(
      { primary: 123, secondary: 456 },
      { primary: 125, secondary: 458 },
      3
    ),
    true
  )
  assert.equal(
    areOfficialDispatchResetAtsStable(
      { primary: 123, secondary: 456 },
      { primary: 125, secondary: 464 },
      3
    ),
    false
  )

  const rateLimits = parseOfficialRateLimits(
    {
      rate_limit: {
        secondary_window: { used_percent: 20 },
        daily_window: { limit_window_seconds: 86400, used_percent: 30 }
      }
    },
    new Date('2026-07-13T00:00:00Z')
  )
  assert.deepEqual(
    rateLimits?.map(({ id, label, usedPercent }) => ({ id, label, usedPercent })),
    [
      { id: 'secondary', label: 'secondary', usedPercent: 20 },
      { id: 'daily', label: '1d', usedPercent: 30 }
    ]
  )
  assert.equal(parseOfficialRateLimits({ rate_limit: {} }, new Date()), undefined)
})
