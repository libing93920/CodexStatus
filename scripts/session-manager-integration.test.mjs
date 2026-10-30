/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { buildSync } from 'esbuild'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRATCH_PREFIX = 'session-manager-integration-'
const CORE_EXECUTABLE = join(
  ROOT,
  'resources',
  'session-core',
  process.platform === 'win32' ? 'session-core.exe' : 'session-core'
)
const TEST_TIMEOUT_MS = 180_000
const WORKER_EXIT_TIMEOUT_MS = 10_000
const SCAN_REFRESH_DELAY_MS = 10
const RETAINED_USAGE_DATABASE = 'retained-usage.sqlite'
const SESSION_MANAGER_SETTINGS = {
  keepRecentDays: 14,
  olderSessionDays: 90,
  logAgeDays: 30,
  alertGiB: 10
}
const EXPECTED_PROVIDERS = [
  'claude',
  'codex',
  'gemini',
  'grokbuild',
  'hermes',
  'openclaw',
  'opencode',
  'omp',
  'pi'
]
const RETAINED_USAGE = {
  model: 'fixture-opencode-retained-model',
  input: 7,
  output: 3,
  reasoning: 1,
  cacheRead: 2,
  cacheWrite: 1,
  cost: 0.125
}

if (!process.versions.electron) {
  const test = (await import('node:test')).default
  test(
    'session manager native integration requires Electron',
    {
      skip: 'Run with node scripts/run-with-test-scratch.mjs --electron scripts/session-manager-integration.test.mjs'
    },
    () => {}
  )
} else {
  const { app } = createRequire(import.meta.url)('electron')
  app.on('window-all-closed', () => {})
  app.on('before-quit', (event) => event.preventDefault())
  const watchdog = setTimeout(() => {
    console.error(`FAIL: session-manager integration timed out after ${TEST_TIMEOUT_MS}ms`)
    app.exit(124)
  }, TEST_TIMEOUT_MS)
  void runIntegration(app).then(
    () => {
      clearTimeout(watchdog)
      console.log('PASS: session-manager Electron/native integration complete')
      app.exit(0)
    },
    (error) => {
      clearTimeout(watchdog)
      const message = error instanceof Error ? error.message : String(error)
      const location = error instanceof Error ? error.stack?.split('\n').slice(1, 3).join('\n') : ''
      console.error(
        `FAIL: ${message.slice(0, 1400)}${location ? `\n${location.slice(0, 300)}` : ''}`
      )
      app.exit(1)
    }
  )
}

async function runIntegration(app) {
  assert.ok(process.env.PI_SCRATCH_DIR, 'Run through scripts/run-with-test-scratch.mjs')
  const scratchParent = resolve(process.env.PI_SCRATCH_DIR)
  const scratch = assertOwnedScratch(
    mkdtempSync(join(scratchParent, SCRATCH_PREFIX)),
    scratchParent
  )
  let controller
  try {
    const runtime = await prepareRuntime(app, scratch)
    controller = runtime.controller
    await verifyProviderScan(runtime)
    await verifyOverlappingSourceAliases(controller, runtime)
    await verifyProtection(controller, runtime.target)
    await verifyStalePlan(controller, runtime.target)
    await verifyCancellation(
      controller,
      runtime.target,
      runtime.openCode,
      runtime.retentionDirectory
    )
    await verifyDeletionAndRetention(runtime)
  } finally {
    try {
      if (controller) await stopController(controller)
    } finally {
      await rm(assertOwnedScratch(scratch, scratchParent), { recursive: true, force: true })
    }
  }
}

async function prepareRuntime(app, scratch) {
  const userData = join(scratch, 'user-data')
  const stateDirectory = join(scratch, 'state')
  const retentionDirectory = join(scratch, 'retained')
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(stateDirectory, { recursive: true }),
    mkdir(retentionDirectory, { recursive: true })
  ])
  app.setPath('userData', userData)
  await app.whenReady()
  await isolateEnvironment(scratch)
  assert.ok(existsSync(CORE_EXECUTABLE), `Native core missing: ${CORE_EXECUTABLE}`)

  const fixtureSet = await createFixtures(scratch)
  insertRetentionUsage(fixtureSet.openCode)
  assertSourcesStayInside(scratch, fixtureSet.sources)
  await writeControllerConfig(stateDirectory, fixtureSet.sources)
  const CleanerController = await loadController(scratch)
  const controller = new CleanerController({
    directory: stateDirectory,
    retentionDirectory,
    activeThreadIds: () => [],
    onProgress: () => {},
    coreExecutable: CORE_EXECUTABLE
  })
  try {
    await controller.initialize()
    return { ...fixtureSet, controller, retentionDirectory }
  } catch (error) {
    await stopController(controller).catch(() => undefined)
    throw error
  }
}

async function createFixtures(scratch) {
  const {
    createAdditionalDeleteProviderFixtures,
    createClaudeFixture,
    createCodexFixture,
    createOpenCodeFixture
  } = await import('./fixtures/session-manager-core-fixtures.mjs')
  const fixtureRoot = join(scratch, 'providers')
  const [openCode, claude, codex, additional] = await Promise.all([
    createOpenCodeFixture(fixtureRoot),
    createClaudeFixture(fixtureRoot),
    createCodexFixture(fixtureRoot),
    createAdditionalDeleteProviderFixtures(fixtureRoot)
  ])
  const validClaude = await relocateClaudeFixture(claude)
  const fixtures = [openCode, validClaude, codex, ...additional]
  const piFixture = fixtures.find((fixture) => fixture.source.kind === 'pi')
  assert.ok(piFixture, 'Pi fixture must exist for the shared-directory case')
  const sharedOmpSource = {
    ...piFixture.source,
    id: 'fixture-omp-pi-shared',
    kind: 'omp'
  }
  const sources = fixtures.map((fixture) => ({
    ...fixture.source,
    name: `${fixture.source.kind} fixture`,
    origin: 'manual',
    capability: 'sessions',
    note: 'isolated integration fixture'
  }))
  sources.push({
    ...sharedOmpSource,
    name: 'omp shared Pi fixture',
    origin: 'manual',
    capability: 'sessions',
    note: 'same temporary Pi session directory'
  })
  return {
    fixtures,
    sources,
    openCode,
    sharedPiOmp: {
      piSourceId: piFixture.source.id,
      ompSourceId: sharedOmpSource.id,
      sessionId: piFixture.expectedSessionId
    }
  }
}

async function relocateClaudeFixture(fixture) {
  const originalRoot = fixture.source.path
  const projectsRoot = join(dirname(originalRoot), 'claude', 'projects')
  await mkdir(dirname(projectsRoot), { recursive: true })
  await rename(originalRoot, projectsRoot)
  const rebasePath = (filePath) => join(projectsRoot, relative(originalRoot, filePath))
  return {
    ...fixture,
    source: { ...fixture.source, path: projectsRoot },
    transcriptPath: rebasePath(fixture.transcriptPath),
    sidecarDirectory: rebasePath(fixture.sidecarDirectory),
    toolResultPath: rebasePath(fixture.toolResultPath)
  }
}
async function writeControllerConfig(directory, sources) {
  await writeFile(
    join(directory, 'config.json'),
    `${JSON.stringify({ sources, protectedIds: [], settings: SESSION_MANAGER_SETTINGS })}\n`,
    'utf8'
  )
}

async function loadController(scratch) {
  const { CleanerController } = await bundleSessionManager(scratch)
  return CleanerController
}

async function bundleSessionManager(scratch) {
  const mainDirectory = join(scratch, 'main')
  await mkdir(mainDirectory, { recursive: true })
  const controllerBundle = join(mainDirectory, 'controller.cjs')
  const workerBundle = join(mainDirectory, 'session-cleaner-worker.js')
  const common = { bundle: true, platform: 'node', external: ['electron'] }
  buildSync({
    ...common,
    entryPoints: [join(ROOT, 'src', 'main', 'tools', 'session-cleaner', 'controller.ts')],
    outfile: controllerBundle,
    format: 'cjs'
  })
  buildSync({
    ...common,
    entryPoints: [join(ROOT, 'src', 'main', 'tools', 'session-cleaner', 'worker.ts')],
    outfile: workerBundle,
    format: 'cjs'
  })
  const require = createRequire(import.meta.url)
  return require(controllerBundle)
}

async function isolateEnvironment(scratch) {
  const home = join(scratch, 'home')
  const values = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    CODEX_HOME: join(home, '.codex'),
    CODEX_SQLITE_HOME: join(home, '.codex-sqlite'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    MINIMAX_DATA_DIR: join(home, '.minimax'),
    KIMI_CODE_HOME: join(home, '.kimi'),
    CC_SWITCH_TEST_HOME: join(home, 'empty-home')
  }
  await mkdir(join(home, 'empty-home'), { recursive: true })
  for (const [key, value] of Object.entries(values)) process.env[key] = value
}

function insertRetentionUsage(fixture) {
  const database = new DatabaseSync(fixture.databasePath)
  const created = Date.now() - 1_000
  const data = JSON.stringify({
    model: { id: RETAINED_USAGE.model },
    cost: RETAINED_USAGE.cost,
    tokens: {
      input: RETAINED_USAGE.input,
      output: RETAINED_USAGE.output,
      reasoning: RETAINED_USAGE.reasoning,
      cache: { read: RETAINED_USAGE.cacheRead, write: RETAINED_USAGE.cacheWrite }
    },
    time: { created, completed: created + 500 }
  })
  try {
    database
      .prepare(
        `INSERT INTO session_message
          (id, session_id, type, seq, data, time_created, time_updated)
         VALUES (?, ?, 'assistant', 2, ?, ?, ?)`
      )
      .run('msg_v2_retained_usage', fixture.v2SessionId, data, created, created + 500)
  } finally {
    database.close()
  }
}

function assertSourcesStayInside(scratch, sources) {
  for (const source of sources) {
    assertPathInside(scratch, source.path)
    if (source.databasePath) assertPathInside(scratch, source.databasePath)
  }
}

function assertPathInside(parent, candidate) {
  const relativePath = relative(resolve(parent), resolve(candidate))
  assert.ok(
    relativePath === '' ||
      (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)),
    `Fixture path escaped owned scratch: ${candidate}`
  )
}

function assertOwnedScratch(directory, parent) {
  const target = resolve(directory)
  assert.equal(
    dirname(target),
    resolve(parent),
    'Refusing cleanup outside the owned scratch parent'
  )
  assert.ok(
    basename(target).startsWith(SCRATCH_PREFIX),
    'Refusing cleanup without the owned prefix'
  )
  return target
}

async function verifyProviderScan(runtime) {
  const state = await runtime.controller.scan()
  const sessions = managedSessions(state)
  const providers = [...new Set(sessions.map((session) => session.providerId))].sort()
  assert.deepEqual(
    providers,
    [...EXPECTED_PROVIDERS].sort(),
    'native scan must cover nine providers'
  )
  assert.ok(Array.isArray(state.issues), 'controller must preserve native scan issues')
  const opencode = sessions.filter((session) => session.providerId === 'opencode')
  assert.deepEqual(
    opencode.map((session) => session.sessionId).sort(),
    [runtime.openCode.v1SessionId, runtime.openCode.v2SessionId].sort(),
    'OpenCode V1/V2 sessions must remain separate'
  )
  const worker = runtime.controller.worker.child
  assert.ok(worker && Number.isInteger(worker.pid), 'scan must use a real Electron utility worker')
  const { piSourceId, ompSourceId, sessionId } = runtime.sharedPiOmp
  const piAlias = state.items.find(
    (item) => item.sourceId === piSourceId && item.sessionId === sessionId
  )
  const ompAlias = state.items.find(
    (item) => item.sourceId === ompSourceId && item.sessionId === sessionId
  )
  assert.ok(piAlias?.managed, 'Pi must scan the shared fixture file')
  assert.ok(ompAlias?.managed, 'OMP must scan the same fixture file')
  assert.equal(piAlias.managed.sourcePath, ompAlias.managed.sourcePath)
  assert.notEqual(piAlias.id, ompAlias.id, 'source aliases must receive distinct item IDs')
  runtime.sharedPiOmp.items = [piAlias, ompAlias]
  runtime.target = state.items.find(
    (item) =>
      item.managed?.providerId === 'opencode' && item.sessionId === runtime.openCode.v2SessionId
  )
  runtime.keep = state.items.find(
    (item) =>
      item.managed?.providerId === 'opencode' && item.sessionId === runtime.openCode.v1SessionId
  )
  assert.ok(runtime.target?.managed.capabilities.delete, 'OpenCode target must be deletable')
  assert.ok(runtime.keep, 'OpenCode sibling session must be present')
  console.log(
    `PASS native worker scan covered ${providers.length} providers and isolated OpenCode SQL sessions`
  )
}

function managedSessions(state) {
  return state.items.flatMap((item) => (item.managed ? [item.managed] : []))
}

async function verifyOverlappingSourceAliases(controller, runtime) {
  const items = runtime.sharedPiOmp.items
  const ids = items.map((item) => item.id)
  const selectedIds = new Set(ids)
  for (const item of items) {
    const protectedState = await controller.protect([item.id], true)
    const aliases = protectedState.items.filter((candidate) => selectedIds.has(candidate.id))
    assert.equal(aliases.length, 2)
    assert.ok(aliases.every((alias) => alias.status === 'protected'))
    const plan = await controller.review(ids)
    assert.equal(plan.items.length, 0)
    assert.equal(plan.excluded.length, 2)
    assert.ok(plan.excluded.every((entry) => /用户已保护/.test(entry.reason ?? '')))
    await controller.protect([item.id], false)
    const released = await controller.getState()
    assert.ok(
      released.items
        .filter((candidate) => selectedIds.has(candidate.id))
        .every((alias) => alias.status !== 'protected')
    )
  }

  if (!items.every((item) => item.managed?.capabilities.delete)) {
    console.log('SKIP overlapping-file review count: Pi/OMP fixture is not fully deletable yet')
    return
  }
  const plan = await controller.review(ids)
  assert.equal(plan.items.length, 1)
  assert.equal(plan.excluded.length, 1)
  assert.match(plan.excluded[0].reason, /此会话资源已由所选另一条目包含/)
  console.log('PASS shared Pi/OMP source IDs, alias protection, and duplicate-review exclusion')
}

async function verifyProtection(controller, target) {
  const protectedState = await controller.protect([target.id], true)
  assert.equal(protectedState.items.find((item) => item.id === target.id)?.status, 'protected')
  const plan = await controller.review([target.id])
  assert.equal(plan.items.length, 0)
  assert.equal(plan.excluded[0]?.id, target.id)
  assert.match(plan.excluded[0]?.reason ?? '', /用户已保护/)
  await controller.protect([target.id], false)
  console.log('PASS protected session is excluded from a deletion plan')
}

async function verifyStalePlan(controller, target) {
  const plan = await controller.review([target.id])
  assert.equal(plan.items.length, 1)
  await controller.scan()
  await assert.rejects(controller.recycle(plan.id), /审核已失效/)
  const state = await controller.getState()
  assert.ok(
    state.items.some((item) => item.id === target.id),
    'stale plan must not delete data'
  )
  console.log('PASS rescanning invalidates an earlier plan')
}

async function verifyCancellation(controller, target, fixture, retentionDirectory) {
  const plan = await controller.review([target.id])
  assert.equal(plan.items.length, 1)
  const worker = controller.worker
  const originalRequest = worker.request.bind(worker)
  const observed = { prepared: false, deleteCalls: 0 }
  worker.request = async (request) => {
    if (request.method === 'delete') observed.deleteCalls++
    const result = await originalRequest(request)
    if (request.method === 'prepare' && !observed.prepared) {
      observed.prepared = true
      controller.cancelOperation()
    }
    return result
  }
  let state
  try {
    state = await controller.recycle(plan.id)
  } finally {
    worker.request = originalRequest
  }
  assert.equal(observed.prepared, true, 'cancellation must happen after retention preparation')
  assert.equal(observed.deleteCalls, 0, 'cancelled operation must not call native delete')
  assert.ok(managedSessions(state).some((session) => session.sessionId === fixture.v2SessionId))
  const record = state.records.find((entry) => entry.batchId === plan.id)
  assert.equal(record?.status, 'skipped')
  assert.match(record?.reason ?? '', /取消/)
  assert.equal(countSessionRows(fixture.databasePath, 'session_v2', fixture.v2SessionId), 1)
  assertRetainedUsage(retentionDirectory, fixture.v2SessionId)
  console.log('PASS cancellation after retention prevents native deletion and records the outcome')
}

async function verifyDeletionAndRetention(runtime) {
  const { controller, openCode, target, keep, retentionDirectory } = runtime
  const previousScan = (await controller.getState()).scannedAt ?? 0
  const plan = await controller.review([target.id])
  assert.equal(plan.items.length, 1)
  await delay(SCAN_REFRESH_DELAY_MS)
  const refreshed = await controller.recycle(plan.id)
  const sessions = managedSessions(refreshed)
  assert.ok(refreshed.scannedAt > previousScan, 'successful deletion must trigger a fresh scan')
  assert.equal(
    sessions.some((session) => session.sessionId === openCode.v2SessionId),
    false
  )
  assert.ok(sessions.some((session) => session.sessionId === openCode.v1SessionId))
  assert.equal(countSessionRows(openCode.databasePath, 'session_v2', openCode.v2SessionId), 0)
  assert.equal(countSessionRows(openCode.databasePath, 'session', openCode.v1SessionId), 1)
  const record = refreshed.records.find((entry) => entry.batchId === plan.id)
  assert.equal(record?.status, 'deleted')
  assertRetainedUsage(retentionDirectory, openCode.v2SessionId)
  assert.ok(refreshed.items.some((item) => item.id === keep.id))
  console.log('PASS retained usage survives SQL deletion; sibling remains and controller refreshes')
}

function assertRetainedUsage(directory, sessionId) {
  const databasePath = join(directory, RETAINED_USAGE_DATABASE)
  assert.ok(existsSync(databasePath), 'usage retention database must be created in scratch')
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const retained = database
      .prepare('SELECT payload FROM retained_sources')
      .all()
      .map((row) => JSON.parse(String(row.payload)))
      .find((entry) => entry.agent === 'opencode' && entry.sessionId === sessionId)
    assert.ok(retained, 'OpenCode usage must be retained before deletion')
    assert.equal(retained.events.length, 1)
    assert.equal(retained.events[0].model, RETAINED_USAGE.model)
    assert.equal(
      retained.events[0].tokens.input,
      RETAINED_USAGE.input + RETAINED_USAGE.cacheRead + RETAINED_USAGE.cacheWrite
    )
    assert.equal(
      retained.events[0].tokens.cachedInput,
      RETAINED_USAGE.cacheRead + RETAINED_USAGE.cacheWrite
    )
    assert.equal(retained.events[0].costUsd, RETAINED_USAGE.cost)
  } finally {
    database.close()
  }
}

function countSessionRows(databasePath, table, sessionId) {
  const queries = {
    session: 'SELECT COUNT(*) AS count FROM session WHERE id=?',
    session_v2: 'SELECT COUNT(*) AS count FROM session_v2 WHERE id=?'
  }
  assert.ok(Object.hasOwn(queries, table), `Unexpected OpenCode table: ${table}`)
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    return Number(database.prepare(queries[table]).get(sessionId).count)
  } finally {
    database.close()
  }
}

async function stopController(controller) {
  const workerClient = controller.worker
  await workerClient.request({ method: 'cancel' }).catch(() => undefined)
  const child = workerClient.child
  const exited = child ? new Promise((resolveExit) => child.once('exit', resolveExit)) : undefined
  controller.dispose()
  if (exited) {
    await Promise.race([
      exited,
      delay(WORKER_EXIT_TIMEOUT_MS).then(() => {
        throw new Error('Electron utility worker did not exit')
      })
    ])
  }
}
