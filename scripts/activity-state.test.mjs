import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), 'activity-state-'))
const bundlePath = join(directory, 'state.cjs')
await build({
  entryPoints: [fileURLToPath(new URL('../src/main/services/state.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundlePath,
  plugins: [
    {
      name: 'isolated-electron-user-data',
      setup(build) {
        build.onResolve({ filter: /^electron$/ }, () => ({
          path: 'electron',
          namespace: 'fixture'
        }))
        build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
          contents: 'export const app = { getPath: () => globalThis.__activityStateDirectory }'
        }))
      }
    }
  ]
})
const require = createRequire(import.meta.url)
const state = require(bundlePath)
const PEER = '10000000-0000-4000-8000-000000000001'

test('设备peerId稳定，旧活动关闭值重载后保持开启，坏值不能冒充已保存设备', async (t) => {
  globalThis.__activityStateDirectory = directory
  t.after(async () => {
    delete globalThis.__activityStateDirectory
    await rm(directory, { recursive: true, force: true })
  })
  const defaults = await state.loadPersistedState()
  assert.equal(defaults.settings.activityEnabled, true)
  assert.equal(defaults.settings.activityIdleThresholdMinutes, 5)
  await state.savePersistedState({ ...defaults, peerId: PEER })
  assert.equal((await state.loadPersistedState()).peerId, PEER)
  assert.equal((await state.loadPersistedState()).settings.activityEnabled, true)
  await writeFile(
    join(directory, 'codex-status-state.json'),
    JSON.stringify({ peerId: PEER, settings: { activityEnabled: false } })
  )
  const legacyDisabled = await state.loadPersistedState()
  assert.equal(legacyDisabled.settings.activityEnabled, true)
  await state.savePersistedState(legacyDisabled)
  assert.equal((await state.loadPersistedState()).settings.activityEnabled, true)
  globalThis.__activityStateDirectory = join(directory, 'codex-status-state.json')
  await assert.rejects(
    state.savePersistedState({
      ...defaults,
      peerId: PEER,
      settings: { ...defaults.settings, activityEnabled: true }
    })
  )
  globalThis.__activityStateDirectory = directory
  assert.equal((await state.loadPersistedState()).peerId, PEER)
  await Promise.all(
    [6, 17].map((minutes) =>
      state.savePersistedState({
        ...defaults,
        peerId: PEER,
        settings: { ...defaults.settings, activityIdleThresholdMinutes: minutes }
      })
    )
  )
  const fixedThreshold = await state.loadPersistedState()
  assert.equal(fixedThreshold.settings.activityIdleThresholdMinutes, 5)
  await state.savePersistedState(fixedThreshold)
  assert.equal((await state.loadPersistedState()).settings.activityIdleThresholdMinutes, 5)
  for (const peerId of ['../other-member', 23, null]) {
    await writeFile(
      join(directory, 'codex-status-state.json'),
      JSON.stringify({
        peerId,
        settings: { activityEnabled: 'true', activityIdleThresholdMinutes: 0 }
      })
    )
    const loaded = await state.loadPersistedState()
    assert.equal(loaded.peerId, undefined)
    assert.equal(loaded.settings.activityEnabled, true)
    assert.equal(loaded.settings.activityIdleThresholdMinutes, 5)
  }
})

test('任务栏横向偏移只保留有限数值并忽略旧灵动岛位置', async (t) => {
  const stateDirectory = await mkdtemp(
    join(process.env.PI_SCRATCH_DIR || tmpdir(), 'taskbar-offset-')
  )
  globalThis.__activityStateDirectory = stateDirectory
  t.after(async () => {
    delete globalThis.__activityStateDirectory
    await rm(stateDirectory, { recursive: true, force: true })
  })

  const stateFile = join(stateDirectory, 'codex-status-state.json')
  const defaults = await state.loadPersistedState()
  await state.savePersistedState({ ...defaults, taskbarOffsetX: -128.5 })
  assert.equal((await state.loadPersistedState()).taskbarOffsetX, -128.5)

  await state.savePersistedState({ ...defaults, taskbarOffsetX: Infinity })
  assert.equal((await state.loadPersistedState()).taskbarOffsetX, undefined)

  await writeFile(stateFile, '{"taskbarOffsetX":1e400,"islandPosition":{"x":640,"y":30}}')
  const legacy = await state.loadPersistedState()
  assert.equal(legacy.taskbarOffsetX, undefined)
  assert.equal('islandPosition' in legacy, false)
  await state.savePersistedState(legacy)
  const saved = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.equal('taskbarOffsetX' in saved, false)
  assert.equal('islandPosition' in saved, false)
})
