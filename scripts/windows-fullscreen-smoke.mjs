import assert from 'node:assert/strict'
import { WindowsFullscreenMonitor } from '../src/main/services/windows-fullscreen.ts'

if (process.platform !== 'win32') process.exit(0)

const state = await new Promise((resolve, reject) => {
  let timeout
  let lastError = ''
  const monitor = new WindowsFullscreenMonitor(
    (nextState) => {
      clearTimeout(timeout)
      monitor.stop()
      resolve(nextState)
    },
    (message) => {
      lastError = message
    }
  )
  timeout = setTimeout(() => {
    monitor.stop()
    setTimeout(() => reject(new Error(lastError || 'Windows fullscreen monitor timed out')), 250)
  }, 5_000)
  monitor.start()
})

assert.equal(typeof state.fullscreen, 'boolean')
assert.ok(state.monitor.width > 0)
assert.ok(state.monitor.height > 0)
