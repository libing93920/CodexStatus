/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app, powerMonitor } from 'electron'

const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), 'activity-power-'))
app.setPath('userData', directory)

async function verify() {
  await app.whenReady()
  assert.equal(process.platform, 'win32', 'This smoke check requires Windows')
  const idleSeconds = powerMonitor.getSystemIdleTime()
  const state = powerMonitor.getSystemIdleState(1)
  assert.ok(Number.isFinite(idleSeconds) && idleSeconds >= 0)
  assert.ok(['active', 'idle', 'locked', 'unknown'].includes(state))
  console.log(
    JSON.stringify({
      check: 'Windows powerMonitor API smoke',
      idleSeconds,
      state,
      persistedActivity: false
    })
  )
}
verify().then(
  async () => {
    await rm(directory, { recursive: true, force: true })
    app.quit()
  },
  (error) => {
    console.error(error)
    app.exit(1)
  }
)
