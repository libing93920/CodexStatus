/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, mkdtempSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { app } from 'electron'
import { buildSync } from 'esbuild'
import {
  createOwnerPage,
  createSessionCleanerFixtures,
  restoreMissingFixtures
} from './fixtures/session-cleaner-integration-fixtures.mjs'
import {
  callCleanerApi,
  scanOwnedFixtures,
  verifyNavigationAndFilters,
  verifyProtectionInvalidation,
  verifySettingsInvalidation,
  verifyToolSecurity
} from './fixtures/session-cleaner-integration-ui.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WAIT_TIMEOUT_MS = 20_000
const POLL_INTERVAL_MS = 100
const TEST_TIMEOUT_MS = 180_000
const EXPECTED_RECYCLE_CANDIDATES = 4
const CAPTURE_VIEWPORT = { width: 1080, height: 720 }
const SCREENSHOT_DIRECTORY = join(ROOT, '.planning', 'session-cleaner', 'screenshots')
const CHROMIUM_DIPS_FILES = new Set(['DIPS', 'DIPS-wal', 'DIPS-shm', 'DIPS-journal'])
const SCREENSHOT_PAGES = [
  { label: '存储总览', heading: 'overview-heading', file: 'overview.png' },
  { label: '会话管理', heading: 'items-heading', file: 'sessions.png' },
  { label: '来源管理', heading: 'sources-heading', file: 'sources.png' }
]
const TOOL_TITLE = '会话清理 · CodexStatus'
const CHANNELS = {
  state: 'session-cleaner:state',
  recycle: 'session-cleaner:recycle',
  windowIsMaximized: 'session-cleaner:window-is-maximized'
}
const require = createRequire(import.meta.url)
const electron = require('electron')
const NativeBrowserWindow = electron.BrowserWindow
assert.ok(process.env.PI_SCRATCH_DIR, '请通过 run-with-test-scratch.mjs 执行')
const scratchParent = resolve(process.env.PI_SCRATCH_DIR)
const scratch = mkdtempSync(join(scratchParent, 'session-cleaner-integration-'))
const ccSwitchTestHome = join(scratch, 'empty-home')
process.env.CC_SWITCH_TEST_HOME = ccSwitchTestHome
await mkdir(ccSwitchTestHome, { recursive: true })
const userData = join(scratch, 'user-data')
app.setPath('userData', userData)
delete process.env.ELECTRON_RENDERER_URL
app.on('window-all-closed', () => {})

let ownerWindow
let fixtures
let capture
let restoreInstrumentation
const blockers = []

function block(message) {
  blockers.push(message)
  console.log(`BLOCKED: ${message}`)
}

function ensureOwnedScratch() {
  const target = resolve(scratch)
  assert.equal(dirname(target), scratchParent, '拒绝清理测试 scratch 之外的目录')
  assert.ok(basename(target).startsWith('session-cleaner-integration-'))
  return target
}

async function prepareRuntime() {
  const renderer = join(ROOT, 'out', 'renderer')
  const preload = join(ROOT, 'out', 'preload')
  assert.ok(
    existsSync(join(renderer, 'session-cleaner.html')),
    '缺少构建产物；先运行 npm run build'
  )
  assert.ok(
    existsSync(join(preload, 'session-cleaner.js')),
    '缺少独立 preload；先运行 npm run build'
  )
  const main = join(scratch, 'main')
  await mkdir(main, { recursive: true })
  buildSync({
    entryPoints: [join(ROOT, 'src/main/tools/session-cleaner/index.ts')],
    outfile: join(main, 'cleaner.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron']
  })
  buildSync({
    entryPoints: [join(ROOT, 'src/main/tools/session-cleaner/worker.ts')],
    outfile: join(main, 'session-cleaner-worker.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron']
  })
  await cp(renderer, join(scratch, 'renderer'), { recursive: true })
  await cp(preload, join(scratch, 'preload'), { recursive: true })
  console.log('PASS isolated bundles and built renderer/preload copied to scratch')
}

function instrumentElectron(workerPath) {
  const state = {
    toolWindow: undefined,
    options: undefined,
    worker: undefined,
    workerExit: undefined,
    workerSpawn: undefined,
    scanRequests: 0
  }
  const cleanerPath = resolve(join(scratch, 'main', 'cleaner.cjs'))
  const observedWindow = new Proxy(electron.BrowserWindow, {
    construct(target, args, newTarget) {
      const created = Reflect.construct(target, args, newTarget)
      if (args[0]?.title === TOOL_TITLE) {
        state.toolWindow = created
        state.options = args[0]
      }
      return created
    }
  })
  const observedUtilityProcess = new Proxy(electron.utilityProcess, {
    get(target, property) {
      if (property !== 'fork') return Reflect.get(target, property, target)
      const originalFork = Reflect.get(target, property, target)
      return function (modulePath, args, options) {
        const child = Reflect.apply(originalFork, target, [modulePath, args, options])
        if (resolve(modulePath) !== resolve(workerPath)) return child
        state.worker = child
        state.workerExit = new Promise((done) => child.once('exit', done))
        state.workerSpawn = new Promise((done) =>
          child.pid !== undefined ? done(child.pid) : child.once('spawn', () => done(child.pid))
        )
        return new Proxy(child, {
          get(worker, property) {
            if (property === 'postMessage') {
              return (message) => {
                if (message?.method !== 'scan') {
                  worker.postMessage(message)
                  return
                }
                state.scanRequests += 1
                const gate = state.scanGate
                state.scanGate = undefined
                if (gate) void gate.then(() => worker.postMessage(message))
                else worker.postMessage(message)
              }
            }
            const value = Reflect.get(worker, property, worker)
            return typeof value === 'function' ? value.bind(worker) : value
          }
        })
      }
    }
  })
  const observedApp = new Proxy(electron.app, {
    get(target, property) {
      if (property === 'getAppPath') return () => ROOT
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
  const observedElectron = new Proxy(electron, {
    get(target, property) {
      if (property === 'BrowserWindow') return observedWindow
      if (property === 'utilityProcess') return observedUtilityProcess
      if (property === 'app') return observedApp
      return Reflect.get(target, property, target)
    }
  })
  const Module = require('node:module')
  const originalLoad = Module._load
  Module._load = function (request, parent, isMain) {
    const loaded = Reflect.apply(originalLoad, this, [request, parent, isMain])
    return request === 'electron' && parent?.filename && resolve(parent.filename) === cleanerPath
      ? observedElectron
      : loaded
  }
  return {
    state,
    restore: () => {
      Module._load = originalLoad
    }
  }
}

async function createOwner(preload, page) {
  ownerWindow = new NativeBrowserWindow({
    width: 480,
    height: 320,
    show: false,
    title: 'session-cleaner-test-owner',
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  await ownerWindow.loadFile(page)
}

function toolWindows() {
  return NativeBrowserWindow.getAllWindows().filter((window) => window.getTitle() === TOOL_TITLE)
}

async function ownerInvoke(channel, args = []) {
  return ownerWindow.webContents.executeJavaScript(
    `window.sessionCleanerOwner.invoke(${JSON.stringify(channel)}, ...${JSON.stringify(args)})`
  )
}

async function waitForAutomaticScan(state, expectedRequests, previousScannedAt = 0) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    const result = await callCleanerApi(state.toolWindow, 'getState')
    if (
      result.ok &&
      state.scanRequests === expectedRequests &&
      !result.value.scanning &&
      (result.value.scannedAt ?? 0) > previousScannedAt
    )
      return result.value.scannedAt
    await delay(POLL_INTERVAL_MS)
  }
  throw new Error(`等待超时：第 ${expectedRequests} 次打开后自动扫描`)
}

async function verifyOwnerAndAuthorization(state) {
  await ownerWindow.webContents.executeJavaScript('window.sessionCleanerOwner.open()')
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while ((!state.toolWindow || state.toolWindow.isDestroyed()) && Date.now() < deadline)
    await delay(POLL_INTERVAL_MS)
  assert.ok(state.toolWindow && !state.toolWindow.isDestroyed(), 'owner 未能打开工具窗口')
  const firstId = state.toolWindow.webContents.id
  assert.equal(toolWindows().length, 1)
  const firstScannedAt = await waitForAutomaticScan(state, 1)
  await ownerWindow.webContents.executeJavaScript('window.sessionCleanerOwner.open()')
  assert.equal(toolWindows().length, 1, '重复打开不得创建第二个窗口')
  assert.equal(toolWindows()[0].webContents.id, firstId, '重复打开应复用原窗口')
  await waitForAutomaticScan(state, 2, firstScannedAt)
  for (const [channel, args] of [
    [CHANNELS.state, []],
    [CHANNELS.recycle, ['not-a-plan']],
    [CHANNELS.windowIsMaximized, []]
  ]) {
    const result = await ownerInvoke(channel, args)
    assert.equal(result.ok, false, `${channel} 必须拒绝非工具窗口`)
    assert.match(result.message, /此请求不属于会话清理窗口/)
  }
  console.log(
    'PASS first open and existing-window reactivation each scan once; non-tool IPC rejected'
  )
}

async function verifyWindowMinimizeAndRestore(window, state) {
  const before = await callCleanerApi(window, 'getState')
  assert.equal(before.ok, true, before.message)
  const previousScannedAt = before.value.scannedAt
  const previousRequests = state.scanRequests
  await window.webContents.executeJavaScript('window.sessionCleaner.minimizeWindow()')
  const minimizedDeadline = Date.now() + WAIT_TIMEOUT_MS
  while (!window.isMinimized() && Date.now() < minimizedDeadline) await delay(POLL_INTERVAL_MS)
  assert.equal(window.isMinimized(), true, '最小化按钮应隐藏清理窗口')
  await ownerWindow.webContents.executeJavaScript('window.sessionCleanerOwner.open()')
  assert.equal(window.isMinimized(), false, '重新打开清理器应还原窗口')
  assert.equal(window.isVisible(), true, '重新打开清理器应显示窗口')
  await waitForAutomaticScan(state, previousRequests + 1, previousScannedAt)
  console.log('PASS custom minimize button and owner reopen/restore with one automatic scan')
}

async function verifyIpcSerialization(window) {
  const results = await window.webContents.executeJavaScript(`Promise.all([
    window.sessionCleaner.scan().then(value => ({ ok: true, value }), error => ({ ok: false, message: error?.message || String(error) })),
    window.sessionCleaner.scan().then(value => ({ ok: true, value }), error => ({ ok: false, message: error?.message || String(error) }))
  ])`)
  const accepted = results.filter((result) => result.ok)
  const rejected = results.filter((result) => !result.ok)
  assert.equal(accepted.length, 1, JSON.stringify(results))
  assert.equal(rejected.length, 1, JSON.stringify(results))
  assert.match(rejected[0].message, /工具任务执行中/)
  assert.ok(accepted[0].value.scannedAt, '串行执行的扫描应完成')
  console.log('PASS concurrent renderer IPC: one scan ran; overlapping scan was rejected')
}

function normalizeItemPath(path) {
  return resolve(path).replace(/^\\\\\?\\/, '')
}

async function verifyReview(window, fixtures) {
  const state = await callCleanerApi(window, 'getState')
  assert.equal(state.ok, true, state.message)
  const candidates = state.value.items.filter((item) => item.status === 'candidate')
  assert.equal(
    candidates.length,
    EXPECTED_RECYCLE_CANDIDATES,
    '最终扫描应得到 Claude、Pi 与两个 Codex 旧会话候选'
  )
  const allowed = new Set(
    fixtures.files
      .filter((file) => ['claude', 'pi', 'codex'].includes(file.kind))
      .map((file) => normalizeItemPath(file.path))
  )
  const result = await callCleanerApi(window, 'review', [candidates.map((item) => item.id)])
  assert.equal(result.ok, true, result.message)
  const plan = result.value
  assert.equal(plan.deletionMode, 'permanent', '当前审核必须明确声明永久删除模式')
  fixtures.deletionMode = plan.deletionMode
  for (const item of plan.items) {
    assert.ok(allowed.has(normalizeItemPath(item.path)), `审核方案越界：${item.path}`)
    assert.equal(item.status, 'candidate')
  }
  const byId = new Map(candidates.map((item) => [item.id, item]))
  const guarded = plan.excluded.filter((entry) => /请先关闭 .*，再审核回收/.test(entry.reason))
  const unexpected = plan.excluded.filter((entry) => !guarded.includes(entry))
  assert.equal(unexpected.length, 0, JSON.stringify(unexpected))
  for (const entry of plan.excluded) assert.ok(byId.has(entry.id))
  for (const entry of guarded) block(`真实进程检测阻止审核 ${byId.get(entry.id).path}`)
  return { plan, allowed }
}

async function verifyUsageRetention(fixtures) {
  const databasePath = join(userData, 'usage-history', 'retained-usage.sqlite')
  const { DatabaseSync } = await import('node:sqlite')
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const rows = database
      .prepare('SELECT payload FROM retained_sources WHERE agent = ?')
      .all('claude')
    assert.equal(rows.length, 1, 'Claude fixture 应产生一条用量留存记录')
    const retained = JSON.parse(String(rows[0].payload))
    assert.equal(retained.path, fixtures.claudeFile)
    const event = retained.events.find((entry) => entry.messageId === fixtures.claudeMessageId)
    assert.ok(event, '留存事件必须含真实 message.id')
    assert.equal(event.tokens.output, fixtures.claudeOutputTokens)
  } finally {
    database.close()
  }
}

async function recycleReviewedFixtures(window, fixtures, review) {
  const { plan, allowed } = review
  if (!plan.items.length) return []
  const operationPath = join(userData, 'tools', 'session-cleaner', 'operations.jsonl')
  const before = await callCleanerApi(window, 'getState')
  assert.equal(before.ok, true, before.message)
  assert.equal(before.value.records.length, 0, '临时 userData 不得带入旧回收记录')
  assert.equal(existsSync(operationPath), false, '临时回收日志应从空状态开始')
  const result = await callCleanerApi(window, 'recycle', [plan.id])
  assert.equal(result.ok, true, result.message)
  const records = result.value.records
  assert.ok(Array.isArray(records), JSON.stringify(result.value))
  const logText = existsSync(operationPath) ? await readFile(operationPath, 'utf8') : ''
  const log = logText
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const diagnostic = JSON.stringify({
    plan: plan.items.map(({ id, path }) => ({ id, path })),
    records: records.map(({ id, batchId, path, status, reason }) => ({
      id,
      batchId,
      path,
      status,
      reason
    })),
    log: log.map(({ id, batchId, path, status, reason }) => ({ id, batchId, path, status, reason }))
  })
  console.log(`DELETE RESULTS: ${diagnostic}`)
  assert.equal(records.length, plan.items.length, diagnostic)
  for (const record of records) {
    assert.ok(allowed.has(normalizeItemPath(record.path)), `删除记录越界：${record.path}`)
    if (record.status === 'failed' && /Agent 已启动，跳过此会话/.test(record.reason || '')) {
      block(`真实进程检测阻止删除 ${record.path}`)
      continue
    }
    assert.equal(record.status, 'deleted', `${record.path}: ${record.reason || record.status}`)
  }
  const logById = new Map()
  for (const entry of log) {
    const history = logById.get(entry.id) ?? []
    history.push(entry)
    logById.set(entry.id, history)
  }
  assert.equal(log.length, records.length * 2, diagnostic)
  for (const record of records) {
    const history = logById.get(record.id)
    assert.equal(history?.length, 2, diagnostic)
    assert.equal(history[0].status, 'pending', diagnostic)
    assert.deepEqual(history[1], JSON.parse(JSON.stringify(record)), diagnostic)
  }
  const claudeDeleted = records.some(
    (record) =>
      record.status === 'deleted' &&
      normalizeItemPath(record.path) === normalizeItemPath(fixtures.claudeFile)
  )
  if (claudeDeleted) await verifyUsageRetention(fixtures)
  else block('Claude fixture 未通过进程保护检查；用量留存未执行')
  const paths = records.filter((record) => record.status === 'deleted').map((record) => record.path)
  console.log(`PASS real review/permanent-delete records: ${paths.length} owned fixture(s)`)
  return paths
}

async function verifyRecycle(window, fixtures) {
  const review = await verifyReview(window, fixtures)
  return recycleReviewedFixtures(window, fixtures, review)
}

async function selectScreenshotPage(window, page) {
  const clicked = await window.webContents.executeJavaScript(`(() => {
    const buttons = Array.from(document.querySelectorAll('nav[aria-label="会话清理页面"] button'))
    const button = buttons.find((entry) => entry.textContent.includes(${JSON.stringify(page.label)}))
    if (!button) return false
    button.click()
    return true
  })()`)
  assert.equal(clicked, true, `截图时找不到导航项：${page.label}`)
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    const ready = await window.webContents.executeJavaScript(
      `Boolean(document.getElementById(${JSON.stringify(page.heading)}))`
    )
    if (ready) {
      await withTimeout(
        window.webContents.executeJavaScript(
          'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
        ),
        `截图帧 ${page.label}`
      )
      const animationSettled = await window.webContents.executeJavaScript(
        "document.querySelector('.page')?.getAnimations().every((animation) => animation.playState === 'finished') === true"
      )
      if (animationSettled) return
    }
    await delay(POLL_INTERVAL_MS)
  }
  throw new Error(`等待截图页面超时：${page.label}`)
}

async function captureAcceptanceScreenshots(window) {
  window.webContents.setBackgroundThrottling(false)
  window.setContentSize(CAPTURE_VIEWPORT.width, CAPTURE_VIEWPORT.height)
  assert.deepEqual(window.getContentSize(), [CAPTURE_VIEWPORT.width, CAPTURE_VIEWPORT.height])
  assert.equal(window.isVisible(), true, 'capturePage 前工具窗口必须实际显示')
  await mkdir(SCREENSHOT_DIRECTORY, { recursive: true })
  const evidence = []
  for (const page of SCREENSHOT_PAGES) {
    await selectScreenshotPage(window, page)
    console.log(`CHECK screenshot page selected: ${page.label}`)
    const captured = await withTimeout(
      window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }),
      `capturePage ${page.label}`
    )
    const capturedSize = captured.getSize()
    assert.ok(
      capturedSize.width >= CAPTURE_VIEWPORT.width &&
        capturedSize.height >= CAPTURE_VIEWPORT.height,
      `capturePage 尺寸不足：${JSON.stringify(capturedSize)}`
    )
    const image =
      capturedSize.width === CAPTURE_VIEWPORT.width &&
      capturedSize.height === CAPTURE_VIEWPORT.height
        ? captured
        : captured.resize({ ...CAPTURE_VIEWPORT, quality: 'best' })
    const bytes = image.toPNG()
    assert.ok(bytes.length > 1000, `${page.file} 截图内容为空`)
    const file = join(SCREENSHOT_DIRECTORY, page.file)
    await writeFile(file, bytes)
    evidence.push(
      `${file} (${CAPTURE_VIEWPORT.width}x${CAPTURE_VIEWPORT.height}, ${bytes.length} bytes)`
    )
  }
  console.log(`PASS real Electron capturePage screenshots: ${evidence.join('; ')}`)
}

async function closeToolAndVerifyWorker(state) {
  if (state?.toolWindow && !state.toolWindow.isDestroyed()) {
    const closed = new Promise((done) => state.toolWindow.once('closed', done))
    state.toolWindow.destroy()
    await withTimeout(closed, '工具窗口关闭')
  }
  if (state?.worker) {
    const exitCode = await withTimeout(state.workerExit, 'session-cleaner worker exit')
    assert.equal(state.worker.pid, undefined, '窗口关闭后 worker PID 必须消失')
    assert.ok(ownerWindow && !ownerWindow.isDestroyed(), 'worker 退出时 owner 必须仍存活')
    console.log(`PASS tool close stopped worker (exit=${exitCode}) while owner remained alive`)
  }
}

function withTimeout(promise, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`等待超时：${label}`)), WAIT_TIMEOUT_MS)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function runWindowsIntegration() {
  await prepareRuntime()
  fixtures = await createSessionCleanerFixtures(scratch, userData)
  const ownerFiles = await createOwnerPage(scratch)
  await app.whenReady()
  assert.equal(resolve(app.getPath('userData')), resolve(userData))
  const workerPath = join(scratch, 'main', 'session-cleaner-worker.js')
  const instrumented = instrumentElectron(workerPath)
  capture = instrumented.state
  restoreInstrumentation = instrumented.restore
  const cleaner = require(join(scratch, 'main', 'cleaner.cjs'))
  await createOwner(ownerFiles.preload, ownerFiles.page)
  cleaner.registerSessionCleaner({
    canOpen: (senderId) => senderId === ownerWindow.webContents.id,
    activeThreadIds: () => [],
    retentionDirectory: join(userData, 'usage-history')
  })
  await verifyOwnerAndAuthorization(capture)
  await verifyToolSecurity(capture.toolWindow, capture, scratch, fixtures)
  await verifyWindowMinimizeAndRestore(capture.toolWindow, capture)
  await scanOwnedFixtures(capture.toolWindow, capture, fixtures)
  await verifyIpcSerialization(capture.toolWindow)
  await verifyNavigationAndFilters(capture.toolWindow, fixtures)
  await verifyProtectionInvalidation(capture.toolWindow, fixtures)
  await verifySettingsInvalidation(capture.toolWindow)
  const finalScan = await callCleanerApi(capture.toolWindow, 'scan')
  assert.equal(finalScan.ok, true, finalScan.message)
  console.log('PASS final scan before screenshot reload')
  await capture.toolWindow.webContents.reload()
  await waitForRenderer(capture.toolWindow)
  console.log('PASS screenshot renderer reload')
  await captureAcceptanceScreenshots(capture.toolWindow)
  const deleted = await verifyRecycle(capture.toolWindow, fixtures)
  const closed = new Promise((done) => capture.toolWindow.once('closed', done))
  await capture.toolWindow.webContents
    .executeJavaScript(`document.querySelector('.window-control-close')?.click()`)
    .catch(() => undefined)
  await withTimeout(closed, '自绘关闭按钮')
  console.log(
    `EVIDENCE: userData=${userData}; fixtureRoot=${fixtures.root}; deleted=${deleted.length}`
  )
}

async function cleanup() {
  let failure
  try {
    await closeToolAndVerifyWorker(capture)
  } catch (error) {
    failure = error
  }
  try {
    await restoreMissingFixtures(fixtures)
  } catch (error) {
    failure ??= error
  }
  if (ownerWindow && !ownerWindow.isDestroyed()) ownerWindow.destroy()
  restoreInstrumentation?.()
  try {
    await rm(ensureOwnedScratch(), { recursive: true, force: true })
  } catch (error) {
    const errorPath = typeof error?.path === 'string' ? resolve(error.path) : ''
    const isChromiumDipsLock =
      error?.code === 'EBUSY' &&
      dirname(errorPath) === resolve(userData) &&
      CHROMIUM_DIPS_FILES.has(basename(errorPath))
    if (isChromiumDipsLock) {
      console.log('DEFERRED: Electron holds an isolated Chromium DIPS database until process exit')
    } else {
      failure ??= error
    }
  }
  return failure
}

async function run() {
  let failure
  try {
    if (process.platform === 'win32') await runWindowsIntegration()
    else block('真实进程检测和系统原生回收/还原验收仅支持 Windows')
  } catch (error) {
    failure = error
  }
  const cleanupFailure = await cleanup()
  if (failure) throw failure
  if (cleanupFailure) throw cleanupFailure
  return { blocked: process.platform !== 'win32' || blockers.length > 0 }
}

async function waitForRenderer(window) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      if (
        await window.webContents.executeJavaScript(
          "typeof window.sessionCleaner === 'object' && Boolean(document.getElementById('overview-heading'))"
        )
      )
        return
    } catch {
      /* 页面重载期间 renderer 尚未就绪。 */
    }
    await delay(POLL_INTERVAL_MS)
  }
  throw new Error('等待超时：最终扫描 renderer')
}

const watchdog = setTimeout(() => {
  console.error(`FAIL: integration timeout after ${TEST_TIMEOUT_MS}ms`)
  app.exit(124)
}, TEST_TIMEOUT_MS)
void run().then(
  (result) => {
    clearTimeout(watchdog)
    if (result.blocked) {
      console.log('INCOMPLETE: guarded environmental boundary remains unverified')
      app.exit(2)
    } else {
      console.log('PASS: session-cleaner real Electron integration complete')
      app.exit(0)
    }
  },
  (error) => {
    clearTimeout(watchdog)
    const message = error instanceof Error ? error.message : String(error)
    const location = error instanceof Error ? error.stack?.split('\n').slice(1, 3).join('\n') : ''
    console.error(`FAIL: ${message.slice(0, 1400)}${location ? `\n${location.slice(0, 300)}` : ''}`)
    app.exit(1)
  }
)
