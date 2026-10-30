/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { app, BrowserWindow, ipcMain } from 'electron'
import { dirname, basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import {
  METRIC_SCRIPT,
  printVisualMeasurements,
  validateVisualReport
} from './fixtures/session-cleaner-visual-metrics.mjs'
import {
  copySessionCleanerVisualState,
  createSessionCleanerVisualPlan,
  SESSION_CLEANER_VISUAL_STATE
} from './fixtures/session-cleaner-visual-fixtures.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REFERENCE_URL = 'http://127.0.0.1:4173/AgentSpace-prototype.html'
const REFERENCE_FILE = 'F:\\Tools\\AgentSpace\\AgentSpace-prototype.html'
const BUILT_RENDERER = join(ROOT, 'out', 'renderer', 'session-cleaner.html')
const TEST_PRELOAD = join(ROOT, 'scripts', 'fixtures', 'session-cleaner-visual-preload.cjs')
const OUTPUT_DIRECTORY = join(ROOT, '.planning', 'session-cleaner', 'visual-comparison')
const WAIT_TIMEOUT_MS = 20_000
const POLL_INTERVAL_MS = 100
const VIEWPORTS = [
  { width: 1080, height: 720 },
  { width: 1280, height: 800 }
]
const PAGES = [
  { key: 'overview', prototypePage: 'workbench', headingId: 'overview-heading', label: '存储总览' },
  { key: 'items', prototypePage: 'sessions', headingId: 'items-heading', label: '会话与资源' },
  { key: 'sources', prototypePage: 'sources', headingId: 'sources-heading', label: '来源管理' },
  { key: 'review', prototypePage: 'review', headingId: 'review-heading', label: '清理中心' },
  { key: 'records', prototypePage: 'recycle', headingId: 'records-heading', label: '回收记录' },
  { key: 'policy', prototypePage: 'settings', headingId: 'policy-heading', label: '策略设置' }
]
const SELECTED_TITLES = ['旧版界面探索', '落地页视觉提案']
const CURRENT_API_METHODS = [
  'cancelScan',
  'details',
  'discover',
  'getState',
  'importSource',
  'isWindowMaximized',
  'minimizeWindow',
  'onProgress',
  'onWindowMaximized',
  'openRecycleBin',
  'protect',
  'recycle',
  'removeSource',
  'review',
  'reveal',
  'saveSettings',
  'scan',
  'closeWindow',
  'toggleMaximizeWindow'
]
const IPC_CHANNELS = [
  'session-cleaner-visual:state',
  'session-cleaner-visual:review',
  'session-cleaner-visual:details'
]

let activeWindow
let scratch
let scratchParent

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function assertOwnedScratch() {
  const target = resolve(scratch)
  assert.equal(
    dirname(target),
    scratchParent,
    'Refusing to remove outside the visual-test scratch root'
  )
  assert.ok(basename(target).startsWith('session-cleaner-visual-'))
  return target
}

async function verifyReferenceSource() {
  const [response, localBytes] = await Promise.all([
    fetch(REFERENCE_URL, { cache: 'no-store', redirect: 'error' }),
    readFile(REFERENCE_FILE)
  ])
  assert.equal(response.status, 200, `Reference URL failed: ${REFERENCE_URL}`)
  const servedBytes = Buffer.from(await response.arrayBuffer())
  const localHash = digest(localBytes)
  const servedHash = digest(servedBytes)
  assert.equal(
    servedHash,
    localHash,
    'Local reference URL does not serve the authoritative prototype file'
  )
  return { url: REFERENCE_URL, file: REFERENCE_FILE, sha256: localHash }
}

function registerFixtureApi() {
  ipcMain.handle('session-cleaner-visual:state', () => copySessionCleanerVisualState())
  ipcMain.handle('session-cleaner-visual:review', (_event, ids) =>
    createSessionCleanerVisualPlan(Array.isArray(ids) ? ids : [])
  )
  ipcMain.handle('session-cleaner-visual:details', (_event, id) => {
    const item = SESSION_CLEANER_VISUAL_STATE.items.find((entry) => entry.id === id)
    if (!item) throw new Error('Unknown visual fixture item')
    return `${item.title}\n${item.path}\n${item.reason}`
  })
}

async function executeInPage(window, script) {
  let timer
  try {
    return await Promise.race([
      window.webContents.executeJavaScript(script),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Renderer evaluation timed out')),
          WAIT_TIMEOUT_MS
        )
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function settle(window) {
  await executeInPage(
    window,
    `(async () => {
    await document.fonts.ready
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    for (const animation of document.getAnimations()) {
      if (animation.effect?.getTiming().iterations !== Infinity) animation.finish()
    }
    document.querySelector('[aria-label="关闭操作提示"]')?.click()
    getComputedStyle(document.body).opacity
  })()`
  )
}

async function waitFor(window, label, check) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      if (await check()) return
    } catch {
      /* Page navigation and React state updates can briefly detach the document. */
    }
    await delay(POLL_INTERVAL_MS)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function openWindow(side, viewport) {
  const isCurrent = side === 'current'
  const window = new BrowserWindow({
    title: `Session Cleaner visual fixture · ${side}`,
    width: viewport.width,
    height: viewport.height,
    useContentSize: true,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      ...(isCurrent ? { preload: TEST_PRELOAD } : {}),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  activeWindow = window
  window.webContents.setZoomFactor(1)
  if (isCurrent) await window.loadFile(BUILT_RENDERER)
  else await window.loadURL(REFERENCE_URL)
  window.setContentSize(viewport.width, viewport.height)
  assert.deepEqual(window.getContentSize(), [viewport.width, viewport.height])
  await waitFor(window, `${side} shell`, () =>
    executeInPage(
      window,
      `Boolean(document.querySelector('.sidebar') && document.querySelector('.topbar'))`
    )
  )
  if (isCurrent) {
    await waitFor(window, 'fixture API and initial heading', () =>
      executeInPage(
        window,
        `Boolean(window.sessionCleaner && document.getElementById('overview-heading'))`
      )
    )
    await verifyReadOnlyApi(window)
  } else {
    await waitFor(window, 'prototype overview', () =>
      executeInPage(window, `Boolean(document.querySelector('#page-workbench:not([hidden]) h1'))`)
    )
  }
  await settle(window)
  return window
}

async function verifyReadOnlyApi(window) {
  const stateBefore = await executeInPage(window, 'window.sessionCleaner.getState()')
  assert.equal(stateBefore.items.length, 8)
  assert.equal(stateBefore.sources.length, 7)
  const methods = await executeInPage(window, 'Object.keys(window.sessionCleaner).sort()')
  assert.deepEqual(methods, [...CURRENT_API_METHODS].sort())
  const recycle = await executeInPage(
    window,
    `window.sessionCleaner.recycle('visual-only-plan')
    .then(() => ({ ok: true }), (error) => ({ ok: false, message: error.message }))`
  )
  assert.equal(recycle.ok, false)
  assert.match(recycle.message, /disables recycling/)
  const stateAfter = await executeInPage(window, 'window.sessionCleaner.getState()')
  assert.deepEqual(stateAfter, stateBefore, 'Blocked recycle must leave fixture data unchanged')
}

async function clickPage(window, side, page) {
  const script =
    side === 'reference'
      ? `(() => { const button = document.querySelector('.nav-item[data-page="${page.prototypePage}"]'); button?.click(); return Boolean(button) })()`
      : `(() => { const button = Array.from(document.querySelectorAll('nav[aria-label="会话清理页面"] .nav-item')).find((node) => node.textContent.includes(${JSON.stringify(page.label)})); button?.click(); return Boolean(button) })()`
  assert.equal(
    await executeInPage(window, script),
    true,
    `Missing ${side} navigation item: ${page.label}`
  )
  const readyScript =
    side === 'reference'
      ? `Boolean(document.querySelector('#page-${page.prototypePage}:not([hidden]) h1'))`
      : `Boolean(document.getElementById(${JSON.stringify(page.headingId)}))`
  await waitFor(window, `${side} page ${page.label}`, () => executeInPage(window, readyScript))
  await settle(window)
  if (side === 'current' && page.key === 'items') {
    const selected = await executeInPage(
      window,
      '(() => { const button = document.querySelector(".library-category-tabs [data-category=all]"); button?.click(); return Boolean(button) })()'
    )
    assert.equal(selected, true, 'Current comparison needs the all-content category')
    await waitFor(window, 'current all-content category', () =>
      executeInPage(
        window,
        'document.querySelector(".library-category-tabs [data-category=all]")?.getAttribute("aria-pressed") === "true"'
      )
    )
    await settle(window)
  }
  const heading = await executeInPage(
    window,
    `(() => {
    const node = ${side === 'reference' ? `document.querySelector('#page-${page.prototypePage}:not([hidden]) h1')` : `document.getElementById(${JSON.stringify(page.headingId)})`}
    return node ? { id: node.id, text: node.textContent.trim() } : null
  })()`
  )
  assert.ok(heading, `${side} page is missing its h1: ${page.label}`)
  assert.equal(heading.text, page.label, `${side} h1 text must match the prototype page name`)
  if (side === 'current')
    assert.equal(heading.id, page.headingId, `Keep current heading id for ${page.label}`)
}

async function verifyPageData(window, side, page) {
  if (page.key === 'items') {
    const tableSelector = side === 'reference' ? '#resource-rows' : '.item-table tbody'
    const result = await executeInPage(
      window,
      `(() => {
      const table = document.querySelector(${JSON.stringify(tableSelector)})
      const rows = Array.from(table?.querySelectorAll('tr') ?? [])
      return {
        total: rows.length,
        candidates: rows.filter((row) => row.classList.contains('candidate-row')).length,
        retained: rows.filter((row) => row.classList.contains('retained-row')).length,
        titles: rows.map((row) => row.querySelector('.row-title')?.textContent.trim() ?? '')
      }
    })()`
    )
    assert.equal(result.total, 8, `${side} should render all eight visual fixture items`)
    assert.equal(result.candidates, 4, `${side} should render four candidate rows`)
    assert.equal(result.retained, 4, `${side} should render four retained rows`)
    assert.deepEqual(
      [...result.titles].sort(),
      SESSION_CLEANER_VISUAL_STATE.items.map((item) => item.title).sort()
    )
    if (side === 'current') {
      await executeInPage(window, "document.querySelector('.item-table .row-title')?.click()")
      await waitFor(window, 'fixture detail pane', () =>
        executeInPage(window, "Boolean(document.querySelector('.detail-title'))")
      )
      await settle(window)
      const labels = await executeInPage(
        window,
        `Array.from(document.querySelectorAll('.item-table tbody tr.candidate-row')).map((row) => ({
        title: row.querySelector('.row-title')?.textContent.trim(),
        label: row.querySelector('input[type="checkbox"]')?.getAttribute('aria-label')
      }))`
      )
      assert.ok(
        labels.every(({ title, label }) => label === `选择候选项：${title}`),
        'Preserve candidate checkbox accessible names'
      )
    }
  }
  if (page.key === 'sources') {
    const selector =
      side === 'reference' ? '#source-cards .source-card h3' : '.source-cards .source-card h3'
    const names = await executeInPage(
      window,
      `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map((node) => node.textContent.trim())`
    )
    assert.equal(names.length, 7, `${side} should render all seven visual fixture sources`)
    assert.deepEqual(
      [...names].sort(),
      SESSION_CLEANER_VISUAL_STATE.sources.map((source) => source.name).sort()
    )
  }
  if (page.key === 'overview' && side === 'reference') {
    const counts = await executeInPage(
      window,
      `({ items: Number(document.getElementById('resource-total-count').textContent), sources: Number(document.getElementById('metric-source-count').textContent) })`
    )
    assert.deepEqual(counts, { items: 8, sources: 7 })
  }
}

async function selectReviewCandidates(window, side) {
  for (const title of SELECTED_TITLES) {
    const selector =
      side === 'reference'
        ? `#resource-rows input[data-resource="${title === SELECTED_TITLES[0] ? 'r1' : 'r2'}"]`
        : `.item-table tbody tr.candidate-row input[aria-label=${JSON.stringify(`选择候选项：${title}`)}]`
    const clicked = await executeInPage(
      window,
      `(() => {
      const checkbox = document.querySelector(${JSON.stringify(selector)})
      if (!checkbox || checkbox.disabled) return false
      checkbox.click()
      return true
    })()`
    )
    assert.equal(clicked, true, `${side} could not select visual fixture item: ${title}`)
    await settle(window)
  }
  const countSelector =
    side === 'reference'
      ? '#selected-count'
      : '.item-table tbody tr.candidate-row input[type="checkbox"]:checked'
  const selectedCount = await executeInPage(
    window,
    side === 'reference'
      ? `Number(document.querySelector(${JSON.stringify(countSelector)}).textContent)`
      : `document.querySelectorAll(${JSON.stringify(countSelector)}).length`
  )
  assert.equal(selectedCount, 2, `${side} review fixture must contain two selected items`)
}

async function openReview(window, side, page) {
  const itemsPage = PAGES.find((entry) => entry.key === 'items')
  await clickPage(window, side, itemsPage)
  await selectReviewCandidates(window, side)
  await clickPage(window, side, page)
  const action =
    side === 'reference'
      ? `document.querySelector('#review-content [data-action="generate-preview"]')`
      : `Array.from(document.querySelectorAll('button')).find((button) => button.textContent.includes('生成清理预览'))`
  const clicked = await executeInPage(
    window,
    `(() => { const button = ${action}; if (!button || button.disabled) return false; button.click(); return true })()`
  )
  assert.equal(clicked, true, `${side} could not generate its read-only review preview`)
  const ready =
    side === 'reference'
      ? `Boolean(document.querySelector('#cleanup-preview-title')?.textContent.includes('清理预览'))`
      : `Boolean(document.getElementById('audit-items-heading')?.textContent.includes('2 项'))`
  await waitFor(window, `${side} two-item review preview`, () => executeInPage(window, ready))
  await settle(window)
}

async function measure(window) {
  return executeInPage(window, METRIC_SCRIPT)
}

async function saveScreenshot(window, viewport, side, page) {
  const image = await window.webContents.capturePage(undefined, {
    stayHidden: true,
    stayAwake: true
  })
  const imageSize = image.getSize()
  assert.ok(
    imageSize.width >= viewport.width && imageSize.height >= viewport.height,
    `capturePage too small: ${JSON.stringify(imageSize)}`
  )
  const output =
    imageSize.width === viewport.width && imageSize.height === viewport.height
      ? image
      : image.resize({ width: viewport.width, height: viewport.height, quality: 'best' })
  const bytes = output.toPNG()
  assert.ok(bytes.length > 1_000, `${side}-${page.key} screenshot is empty`)
  const directory = join(OUTPUT_DIRECTORY, `${viewport.width}x${viewport.height}`)
  await mkdir(directory, { recursive: true })
  const file = join(directory, `${side}-${page.key}.png`)
  await writeFile(file, bytes)
  return { file, width: viewport.width, height: viewport.height, bytes: bytes.length }
}

async function renderSide(side, viewport, screenshots, measurements) {
  const window = await openWindow(side, viewport)
  try {
    for (const page of PAGES) {
      console.log(`CAPTURE ${viewport.width}x${viewport.height} ${side} ${page.key}`)
      if (page.key === 'review') await openReview(window, side, page)
      else await clickPage(window, side, page)
      await verifyPageData(window, side, page)
      const dom = await measure(window)
      const screenshot = await saveScreenshot(window, viewport, side, page)
      screenshots.push({ side, viewport, page: page.key, ...screenshot })
      measurements.push({ side, viewport, page: page.key, dom })
    }
  } finally {
    if (!window.isDestroyed()) window.destroy()
    activeWindow = undefined
  }
}

function buildReport(screenshots, measurements, authority) {
  const pairs = []
  for (const viewport of VIEWPORTS) {
    for (const page of PAGES) {
      const reference = measurements.find(
        (entry) =>
          entry.side === 'reference' &&
          entry.page === page.key &&
          entry.viewport.width === viewport.width
      )
      const current = measurements.find(
        (entry) =>
          entry.side === 'current' &&
          entry.page === page.key &&
          entry.viewport.width === viewport.width
      )
      pairs.push({ viewport, page: page.key, reference: reference?.dom, current: current?.dom })
    }
  }
  return {
    authority,
    fixture: { itemCount: 8, sourceCount: 7, recycleBlocked: true },
    screenshots,
    comparisons: pairs
  }
}

async function run() {
  assert.ok(process.env.PI_SCRATCH_DIR, 'Run through scripts/run-with-test-scratch.mjs')
  assert.ok(
    existsSync(BUILT_RENDERER),
    `Built renderer missing; wait for the main build: ${BUILT_RENDERER}`
  )
  assert.ok(existsSync(TEST_PRELOAD), `Visual test preload missing: ${TEST_PRELOAD}`)
  assert.equal(SESSION_CLEANER_VISUAL_STATE.items.length, 8)
  assert.equal(SESSION_CLEANER_VISUAL_STATE.sources.length, 7)
  scratchParent = resolve(process.env.PI_SCRATCH_DIR)
  const profile = join(scratchParent, 'visual-user-data')
  mkdirSync(profile, { recursive: true })
  app.setPath('userData', profile)
  const authority = await verifyReferenceSource()
  scratch = await mkdtemp(join(scratchParent, 'session-cleaner-visual-'))
  app.on('window-all-closed', () => {})
  registerFixtureApi()
  await app.whenReady()
  await mkdir(OUTPUT_DIRECTORY, { recursive: true })
  const screenshots = []
  const measurements = []
  for (const viewport of VIEWPORTS) {
    await renderSide('reference', viewport, screenshots, measurements)
    await renderSide('current', viewport, screenshots, measurements)
  }
  const report = buildReport(screenshots, measurements, authority)
  const reportPath = join(OUTPUT_DIRECTORY, 'measurements.json')
  await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8')
  printVisualMeasurements(report)
  const failures = validateVisualReport(report, PAGES)
  console.log(`EVIDENCE: ${screenshots.length} Electron screenshots; measurements=${reportPath}`)
  if (failures.length)
    throw new Error(`Visual fidelity mismatches (${failures.length}):\n${failures.join('\n')}`)
  console.log('PASS: prototype and built renderer measurements match the requested visual targets')
}

async function cleanup() {
  if (activeWindow && !activeWindow.isDestroyed()) activeWindow.destroy()
  for (const channel of IPC_CHANNELS) ipcMain.removeHandler(channel)
  // Electron 退出后由外层测试 runner 清理，避免删除仍被 Chromium 占用的 userData。
  if (scratch) assertOwnedScratch()
}

const watchdog = setTimeout(() => {
  console.error('FAIL: visual test timeout')
  app.exit(124)
}, 180_000)
void run().then(
  async () => {
    clearTimeout(watchdog)
    await cleanup()
    app.exit(0)
  },
  async (error) => {
    clearTimeout(watchdog)
    try {
      await cleanup()
    } catch (cleanupError) {
      console.error(
        `CLEANUP: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
      )
    }
    const message = error instanceof Error ? error.message : String(error)
    console.error(`FAIL: ${message.slice(0, 4000)}`)
    app.exit(1)
  }
)
