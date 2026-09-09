import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isFullscreenWindow,
  parseFullscreenState
} from '../src/main/services/windows-fullscreen.ts'

const monitor = { x: 0, y: 0, width: 1920, height: 1080 }

test('覆盖显示器边界判定全屏，普通最大化不算', () => {
  assert.equal(isFullscreenWindow({ ...monitor }, monitor), true)
  assert.equal(isFullscreenWindow({ x: 0, y: 0, width: 1920, height: 1040 }, monitor), false)
  assert.equal(isFullscreenWindow({ x: -1, y: -1, width: 1922, height: 1082 }, monitor), true)
})

test('监测输出只接受完整布尔值和显示器边界', () => {
  assert.deepEqual(
    parseFullscreenState(
      '{"fullscreen":true,"monitor":{"x":-1920,"y":0,"width":1920,"height":1080}}'
    ),
    { fullscreen: true, monitor: { x: -1920, y: 0, width: 1920, height: 1080 } }
  )
  assert.equal(parseFullscreenState('{"fullscreen":"yes"}'), undefined)
})
