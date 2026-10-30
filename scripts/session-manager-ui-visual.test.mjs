/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, ipcMain } from 'electron'
import { createSessionManagerFixtureState } from './fixtures/session-manager-ui-fixtures.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUILT_RENDERER = join(ROOT, 'out', 'renderer', 'session-cleaner.html')
const VIEWPORTS = [
  { width: 1080, height: 720 },
  { width: 1280, height: 800 }
]
const OUTPUT_DIRECTORY = resolve(
  process.env.SESSION_MANAGER_UI_VISUAL_DIR ?? join(tmpdir(), 'session-manager-ui-visual-output')
)
const FILTER_DIALOG_SELECTOR = 'dialog[aria-label="筛选会话"]'
const DETAIL_DIALOG_SELECTOR = 'dialog[aria-label="会话详情"]'
const FILTER_GROUP_BY_FIELD = {
  'Agent 多选': 'Agent、目录与项目',
  数据目录多选: 'Agent、目录与项目',
  模型多选: '模型与消息'
}
const WAIT_TIMEOUT_MS = 20_000
const PREFIX = 'session-manager-ui-visual:'
const CHANNELS = [
  'state',
  'calls',
  'details',
  'transcript',
  'block-content',
  'review',
  'export',
  'recycle',
  'cancel',
  'compact',
  'resume'
].map((name) => PREFIX + name)
const PRELOAD_SOURCE = `
'use strict'
const { contextBridge, ipcRenderer } = require('electron')
const invoke = (method) => (...args) => ipcRenderer.invoke('session-manager-ui-visual:' + method, ...args)
const disabled = (action) => () => Promise.reject(new Error('Visual fixture disables ' + action))
const api = Object.freeze({
  getState: invoke('state'),
  discover: invoke('state'),
  importSource: disabled('source import'),
  removeSource: disabled('source removal'),
  scan: invoke('state'),
  cancelScan: async () => undefined,
  protect: disabled('protection changes'),
  saveSettings: disabled('settings changes'),
  review: invoke('review'),
  recycle: invoke('recycle'),
  details: invoke('details'),
  transcript: invoke('transcript'),
  blockContent: invoke('block-content'),
  exportSessions: invoke('export'),
  resumeSession: invoke('resume'),
  compactDatabase: invoke('compact'),
  cancelOperation: invoke('cancel'),
  reveal: disabled('file reveal'),
  openRecycleBin: disabled('recycle-bin access'),
  minimizeWindow: () => undefined,
  toggleMaximizeWindow: () => undefined,
  closeWindow: () => undefined,
  isWindowMaximized: async () => false,
  onWindowMaximized: () => () => undefined,
  onScanRequested: (listener) => {
    const wrapped = () => listener()
    ipcRenderer.on('session-manager-ui-visual:scan-requested', wrapped)
    return () => ipcRenderer.removeListener('session-manager-ui-visual:scan-requested', wrapped)
  },
  onProgress: (listener) => {
    const wrapped = (_event, progress) => listener(progress)
    ipcRenderer.on('session-manager-ui-visual:progress', wrapped)
    return () => ipcRenderer.removeListener('session-manager-ui-visual:progress', wrapped)
  },
  getVisualCalls: invoke('calls')
})
contextBridge.exposeInMainWorld('sessionCleaner', api)
`

let fixtureState = createSessionManagerFixtureState(50)
let exportMode = 'complete'
let deleteMode = 'complete'
let activePlan = null
let pendingExportResolve
let pendingDeleteResolve
let activeWindow
let scratch
let scratchParent
const calls = []

function assertOwnedScratch() {
  const target = resolve(scratch)
  if (
    dirname(target) !== scratchParent ||
    !basename(target).startsWith('session-manager-ui-visual-')
  ) {
    throw new Error('Refusing to use a test directory outside the owned scratch root')
  }
  return target
}

function createTranscript() {
  const messages = Array.from({ length: 31 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `临时夹具消息 ${index + 1}`
  }))
  messages[1].traceId = 'visual-trace-2'
  messages[30] = {
    role: 'assistant',
    content: '',
    blocks: [
      {
        type: 'tool_call',
        title: 'fixture-tool',
        detail: '只用于检查工具块展开。',
        inputPreview: '{"command":"fixture"}'
      },
      {
        type: 'tool_result',
        status: 'success',
        preview: '临时工具输出预览',
        totalLen: 2500,
        truncated: true,
        full: { kind: 'fixture', id: 'tool-output' }
      }
    ]
  }
  return { messages, resources: structuredClone(fixtureState.resources ?? []) }
}

function createVisualPlan(ids) {
  const selected = new Set(ids)
  const items = fixtureState.items.filter(
    (item) =>
      selected.has(item.id) &&
      item.category === 'sessions' &&
      item.managed?.capabilities.delete &&
      !['active', 'protected'].includes(item.status)
  )
  const plan = {
    id: 'visual-delete-plan',
    createdAt: Date.now(),
    items: structuredClone(items),
    totalBytes: items.reduce((total, item) => total + item.managed.storage.fileBytes, 0),
    logicalBytes: items.reduce(
      (total, item) => total + (item.managed.storage.logicalBytes ?? 0),
      0
    ),
    excluded: [],
    deletionMode: 'permanent',
    warnings: ['临时夹具：操作不会读取或修改真实会话。'],
    previews: items.map((item) => ({
      session: {
        providerId: item.managed.providerId,
        sourceId: item.sourceId,
        sessionId: item.managed.sessionId,
        sourcePath: item.managed.sourcePath
      },
      revision: item.managed.revision,
      files: item.files,
      fileBytes: item.managed.storage.fileBytes,
      logicalBytes: item.managed.storage.logicalBytes,
      warnings: ['临时夹具警告：确认前再次核验。']
    }))
  }
  activePlan = plan
  calls.push({ type: 'review', ids: [...ids] })
  return plan
}

function makeRecord(item, batchId, status) {
  return {
    id: `visual-${status}-${item.id}`,
    batchId,
    sourceId: item.sourceId,
    title: item.title,
    path: item.path,
    bytes: item.managed.storage.fileBytes,
    at: Date.now(),
    status,
    reason: status === 'skipped' ? '临时夹具模拟取消后的未处理项。' : undefined
  }
}

function createPartialDeletionState() {
  assert.ok(activePlan?.items.length >= 2, 'Partial-delete fixture needs two planned items')
  const [deletedItem, skippedItem] = activePlan.items
  const data = structuredClone(fixtureState)
  data.items = data.items.filter((item) => item.id !== deletedItem.id)
  data.records = [
    makeRecord(deletedItem, activePlan.id, 'deleted'),
    makeRecord(skippedItem, activePlan.id, 'skipped'),
    ...data.records
  ]
  return data
}

function registerFixtureApi() {
  ipcMain.handle(PREFIX + 'state', () => structuredClone(fixtureState))
  ipcMain.handle(PREFIX + 'calls', () => structuredClone(calls))
  ipcMain.handle(PREFIX + 'details', (_event, id) => {
    const item = fixtureState.items.find((entry) => entry.id === id)
    if (!item) throw new Error('Unknown visual fixture item')
    return `${item.title}\n${item.path}\n${item.reason}`
  })
  ipcMain.handle(PREFIX + 'transcript', (_event, id) => {
    calls.push({ type: 'transcript', id })
    return createTranscript()
  })
  ipcMain.handle(PREFIX + 'block-content', () => ({
    text: '临时夹具工具全文。',
    totalLen: 12,
    truncated: false
  }))
  ipcMain.handle(PREFIX + 'review', (_event, ids) =>
    createVisualPlan(Array.isArray(ids) ? ids : [])
  )
  ipcMain.handle(PREFIX + 'export', (_event, ids) => {
    calls.push({ type: 'export', ids: [...ids] })
    if (exportMode === 'pending') {
      return new Promise((resolve) => {
        pendingExportResolve = resolve
      })
    }
    if (exportMode === 'cancelled') return { count: 0, cancelled: true }
    return { count: ids.length, cancelled: false }
  })
  ipcMain.handle(PREFIX + 'recycle', (_event, planId) => {
    calls.push({ type: 'recycle', planId })
    if (deleteMode === 'pending-partial') {
      return new Promise((resolve) => {
        pendingDeleteResolve = resolve
      })
    }
    return structuredClone(fixtureState)
  })
  ipcMain.handle(PREFIX + 'cancel', () => {
    calls.push({
      type: 'cancel',
      pendingDelete: Boolean(pendingDeleteResolve),
      pendingExport: Boolean(pendingExportResolve)
    })
    if (pendingExportResolve) {
      const finish = pendingExportResolve
      pendingExportResolve = undefined
      finish({ count: 0, cancelled: true })
    }
    if (pendingDeleteResolve) {
      const finish = pendingDeleteResolve
      pendingDeleteResolve = undefined
      finish(createPartialDeletionState())
    }
  })
  ipcMain.handle(PREFIX + 'compact', (_event, sourceId) => {
    calls.push({ type: 'compact', sourceId })
    return structuredClone(fixtureState)
  })
  ipcMain.handle(PREFIX + 'resume', (_event, id) => {
    calls.push({ type: 'resume', id })
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

async function waitFor(window, label, check) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      if (await check()) return
    } catch {
      /* React navigation and state updates briefly detach nodes. */
    }
    await delay(100)
  }
  throw new Error(`Timed out waiting for ${label}`)
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
      getComputedStyle(document.body).opacity
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })()`
  )
}

async function openWindow(viewport) {
  const window = new BrowserWindow({
    title: 'Session Manager UI visual fixture',
    width: viewport.width,
    height: viewport.height,
    useContentSize: true,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(scratch, 'session-manager-ui-preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  activeWindow = window
  window.webContents.setZoomFactor(1)
  await window.loadFile(BUILT_RENDERER)
  window.setContentSize(viewport.width, viewport.height)
  assert.deepEqual(window.getContentSize(), [viewport.width, viewport.height])
  await waitFor(window, 'fixture data and overview', () =>
    executeInPage(
      window,
      `Boolean(window.sessionCleaner && document.querySelector('.calm-overview-stats'))`
    )
  )
  await settle(window)
  return window
}

async function clickText(window, selector, text) {
  const clicked = await executeInPage(
    window,
    `(() => {
      const node = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
        .find((candidate) => candidate.textContent.trim().includes(${JSON.stringify(text)}))
      if (!node || node.disabled) return false
      node.click()
      return true
    })()`
  )
  assert.equal(clicked, true, `Missing enabled control: ${text}`)
}

async function openPage(window, label, headingId) {
  const clicked = await executeInPage(
    window,
    `(() => {
      const node = Array.from(document.querySelectorAll('nav[aria-label="会话清理页面"] .nav-item'))
        .find((candidate) => candidate.textContent.includes(${JSON.stringify(label)}))
      if (!node) return false
      node.click()
      return true
    })()`
  )
  assert.equal(clicked, true, `Missing navigation item: ${label}`)
  await waitFor(window, `${label} page`, () =>
    executeInPage(window, `Boolean(document.getElementById(${JSON.stringify(headingId)}))`)
  )
  await settle(window)
}

async function setSelect(window, label, value) {
  const found = await executeInPage(
    window,
    `(() => {
      const select = document.querySelector('select[aria-label=' + ${JSON.stringify(JSON.stringify(label))} + ']')
      if (!select) return false
      select.value = ${JSON.stringify(value)}
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`
  )
  assert.equal(found, true, `Missing select: ${label}`)
}

async function openFilterDialog(window) {
  const selector = JSON.stringify(FILTER_DIALOG_SELECTOR)
  const alreadyOpen = await executeInPage(
    window,
    `Boolean(document.querySelector(${selector})?.open)`
  )
  if (alreadyOpen) return
  await clickText(window, '.calm-filter-trigger', '筛选')
  await waitFor(window, 'native filter dialog opened', () =>
    executeInPage(
      window,
      `(() => {
        const dialog = document.querySelector(${selector})
        return Boolean(dialog?.open && dialog.matches(':modal'))
      })()`
    )
  )
}

async function openFilterGroup(window, title) {
  const opened = await executeInPage(
    window,
    `(() => {
      const dialog = document.querySelector(${JSON.stringify(FILTER_DIALOG_SELECTOR)})
      const summary = Array.from(dialog?.querySelectorAll('.calm-filter-groups summary') ?? [])
        .find((candidate) => candidate.textContent.trim() === ${JSON.stringify(title)})
      const group = summary?.closest('details')
      if (!summary || !group) return false
      if (!group.open) summary.click()
      return group.open
    })()`
  )
  assert.equal(opened, true, `Could not expand filter group: ${title}`)
}

async function closeFilterDialog(window) {
  const closed = await executeInPage(
    window,
    `(() => {
      const button = document.querySelector(${JSON.stringify(FILTER_DIALOG_SELECTOR)} + ' button[aria-label="关闭筛选会话"]')
      if (!button) return false
      button.click()
      return true
    })()`
  )
  assert.equal(closed, true, 'Filter dialog should expose its named close button')
  await waitFor(window, 'filter dialog closed', () =>
    executeInPage(
      window,
      `!document.querySelector(${JSON.stringify(FILTER_DIALOG_SELECTOR)})?.open`
    )
  )
}

async function setMultiSelect(window, label, values, expectedMatches) {
  const groupTitle = FILTER_GROUP_BY_FIELD[label]
  assert.ok(groupTitle, `Missing filter group for ${label}`)
  await openFilterDialog(window)
  await openFilterGroup(window, groupTitle)
  const changed = await executeInPage(
    window,
    `(() => {
      const dialog = document.querySelector(${JSON.stringify(FILTER_DIALOG_SELECTOR)})
      const fieldset = dialog?.querySelector('fieldset[aria-label=' + ${JSON.stringify(JSON.stringify(label))} + ']')
      const inputs = Array.from(fieldset?.querySelectorAll('input[type="checkbox"]') ?? [])
      if (!inputs.length) return false
      for (const input of inputs) {
        const checked = ${JSON.stringify(values)}.includes(input.value)
        if (input.checked !== checked) input.click()
      }
      return true
    })()`
  )
  assert.equal(changed, true, `Missing multi-select filter: ${label}`)
  await closeFilterDialog(window)
  await waitFor(window, `${label} filter`, () =>
    executeInPage(
      window,
      `document.querySelector('.manager-library-heading .muted')?.textContent.includes(${JSON.stringify(expectedMatches)})`
    )
  )
}

async function verifyFilterToolbar(window) {
  const toolbar = await executeInPage(
    window,
    `(() => {
      const element = document.querySelector('.calm-toolbar')
      return {
        search: element?.querySelector('#item-query')?.type ?? null,
        selects: Array.from(element?.querySelectorAll('select') ?? []).map((select) => select.getAttribute('aria-label')),
        buttons: Array.from(element?.querySelectorAll('button') ?? []).map((button) => button.textContent.trim()),
        controlCount: element?.querySelectorAll('input, select, button').length ?? 0,
        filterDialogOpen: Boolean(document.querySelector('dialog[aria-label="筛选会话"]')?.open)
      }
    })()`
  )
  assert.equal(toolbar.search, 'search')
  assert.deepEqual(toolbar.selects, ['Agent', '排序'])
  assert.deepEqual(toolbar.buttons, ['筛选'])
  assert.equal(toolbar.controlCount, 4)
  assert.equal(toolbar.filterDialogOpen, false)
}

async function verifyFilterDialog(window, viewport, measurements) {
  await openFilterDialog(window)
  const groups = await executeInPage(
    window,
    `(() => {
      const dialog = document.querySelector(${JSON.stringify(FILTER_DIALOG_SELECTOR)})
      return {
        tagName: dialog?.tagName,
        modal: Boolean(dialog?.matches(':modal')),
        title: dialog?.querySelector('h2')?.textContent.trim(),
        groups: Array.from(dialog?.querySelectorAll('.calm-filter-groups > details') ?? []).map((group) => ({
          title: group.querySelector('summary')?.textContent.trim(),
          open: group.open
        }))
      }
    })()`
  )
  assert.equal(groups.tagName, 'DIALOG')
  assert.equal(groups.modal, true)
  assert.equal(groups.title, '筛选会话')
  assert.ok(groups.groups.some((group) => group.title === '时间' && group.open))
  assert.ok(groups.groups.some((group) => group.title === '会话大小' && !group.open))
  assert.ok(groups.groups.some((group) => group.title === 'Agent、目录与项目' && !group.open))
  assert.ok(groups.groups.some((group) => group.title === '模型与消息' && !group.open))
  const resultCount = await executeInPage(
    window,
    `document.querySelector(${JSON.stringify(FILTER_DIALOG_SELECTOR)} + ' footer button.button.primary')?.textContent.trim()`
  )
  assert.equal(resultCount, '查看 56 条结果')

  await openFilterGroup(window, 'Agent、目录与项目')
  const agentFields = await executeInPage(
    window,
    `(() => {
      const dialog = document.querySelector(${JSON.stringify(FILTER_DIALOG_SELECTOR)})
      return ['Agent 多选', '数据目录多选'].every((label) =>
        Boolean(dialog?.querySelector('fieldset[aria-label=' + JSON.stringify(label) + ']'))
      )
    })()`
  )
  assert.equal(agentFields, true)

  await openFilterGroup(window, '模型与消息')
  const modelField = await executeInPage(
    window,
    `Boolean(document.querySelector(${JSON.stringify(FILTER_DIALOG_SELECTOR)} + ' fieldset[aria-label="模型多选"]'))`
  )
  assert.equal(modelField, true)
  await saveScreenshot(window, viewport, 'filters-open', measurements)
  await closeFilterDialog(window)
}
async function readSelectionCount(window) {
  return executeInPage(
    window,
    `Number(document.querySelector('.manager-selection-bar .selection-summary strong')?.textContent ?? 0)`
  )
}

async function saveScreenshot(window, viewport, page, measurements) {
  await settle(window)
  await delay(80)
  const image = await window.webContents.capturePage(undefined, {
    stayHidden: true,
    stayAwake: true
  })
  const size = image.getSize()
  assert.ok(size.width >= viewport.width && size.height >= viewport.height)
  const output =
    size.width === viewport.width && size.height === viewport.height
      ? image
      : image.resize({ width: viewport.width, height: viewport.height, quality: 'best' })
  const bytes = output.toPNG()
  assert.ok(bytes.length > 1_000, `${page} screenshot is empty`)
  const file = join(OUTPUT_DIRECTORY, `${viewport.width}x${viewport.height}-${page}.png`)
  await writeFile(file, bytes)
  const dom = await executeInPage(
    window,
    `(() => {
      const rect = (selector) => {
        const element = document.querySelector(selector)
        if (!element) return null
        const box = element.getBoundingClientRect()
        return { x: box.x, y: box.y, width: box.width, height: box.height }
      }
      const table = document.querySelector('.manager-table')
      return {
        viewport: { width: innerWidth, height: innerHeight },
        sidebar: rect('.sidebar'),
        topbar: rect('.topbar'),
        heading: rect('.page h1'),
        filters: rect('.calm-toolbar'),
        filterDialog: rect(${JSON.stringify(FILTER_DIALOG_SELECTOR)}),
        detailDialog: rect(${JSON.stringify(DETAIL_DIALOG_SELECTOR)}),
        detail: rect(${JSON.stringify(`${DETAIL_DIALOG_SELECTOR} .manager-detail-panel`)}),
        pageOpacity: getComputedStyle(document.querySelector('.page')).opacity,
        activeNav: document.querySelector('.nav-item[aria-current="page"]')?.textContent.trim(),
        hoveredNav: document.querySelector('.nav-item:hover')?.textContent.trim(),
        openDialogs: Array.from(document.querySelectorAll('dialog[open]')).map((dialog) => dialog.className),
        documentWidth: document.documentElement.scrollWidth,
        table: table ? { width: table.getBoundingClientRect().width, scrollWidth: table.scrollWidth } : null
      }
    })()`
  )
  measurements.push({ viewport, page, file, bytes: bytes.length, dom })
  console.log(`CAPTURE ${viewport.width}x${viewport.height} ${page}: ${file}`)
  return file
}

async function clickPageButton(window, page, text) {
  await clickText(window, `.manager-pagination button`, text)
  await waitFor(window, `${text} page`, () =>
    executeInPage(
      window,
      `document.querySelector('.manager-pagination')?.textContent.includes(${JSON.stringify(page)})`
    )
  )
}

async function verifySorting(window) {
  const options = await executeInPage(
    window,
    `Array.from(document.querySelector('select[aria-label="排序"]')?.options ?? []).map((option) => ({
      value: option.value,
      label: option.textContent.trim()
    }))`
  )
  assert.deepEqual(options, [
    { value: 'newest', label: '最近使用' },
    { value: 'oldest', label: '最久未用' },
    { value: 'size-desc', label: '占用最大' }
  ])
  await setSelect(window, '排序', 'oldest')
  await waitFor(window, 'oldest sort state', () =>
    executeInPage(
      window,
      `document.querySelector('.item-table th.date-cell')?.getAttribute('aria-sort') === 'ascending'`
    )
  )
  await setSelect(window, '排序', 'newest')
  await waitFor(window, 'newest sort state', () =>
    executeInPage(
      window,
      `document.querySelector('.item-table th.date-cell')?.getAttribute('aria-sort') === 'descending'`
    )
  )
}

async function verifyCrossPageSelection(window) {
  await clickPageButton(window, '第 2 / 2 页', '下一页')
  const selectedId = await executeInPage(
    window,
    `document.querySelector('.manager-table tbody tr')?.dataset.itemId ?? ''`
  )
  assert.ok(selectedId, 'The second page should contain a session fixture')
  const selected = await executeInPage(
    window,
    `(() => {
      const input = document.querySelector('tr[data-item-id=' + ${JSON.stringify(JSON.stringify(selectedId))} + '] input[type="checkbox"]')
      if (!input || input.disabled) return false
      input.click()
      return true
    })()`
  )
  assert.equal(selected, true)
  await waitFor(window, 'one fixed selection', async () => (await readSelectionCount(window)) === 1)
  const selectionBarVisible = await executeInPage(
    window,
    `Boolean(document.querySelector('.manager-selection-bar'))`
  )
  assert.equal(selectionBarVisible, true)
  await setMultiSelect(window, 'Agent 多选', ['claude'], '1 条匹配')
  assert.equal(await readSelectionCount(window), 1, 'Filtering must preserve the fixed ID')
  await setMultiSelect(window, 'Agent 多选', [], '56 条匹配')
  await clickPageButton(window, '第 2 / 2 页', '下一页')
  const stillSelected = await executeInPage(
    window,
    `Boolean(document.querySelector('tr[data-item-id=' + ${JSON.stringify(JSON.stringify(selectedId))} + '] input[type="checkbox"]')?.checked)`
  )
  assert.equal(stillSelected, true, 'Returning to page two must retain the same selected ID')
  await clickText(window, '.manager-selection-bar button', '清空')
  await waitFor(window, 'selection cleared', async () => (await readSelectionCount(window)) === 0)
  await clickPageButton(window, '第 1 / 2 页', '上一页')
}

async function closeSessionDetails(window) {
  const closed = await executeInPage(
    window,
    `(() => {
      const button = document.querySelector(${JSON.stringify(DETAIL_DIALOG_SELECTOR)} + ' button[aria-label="关闭会话详情"]')
      if (!button) return false
      button.click()
      return true
    })()`
  )
  assert.equal(closed, true, 'Session details should have a close control')
  await waitFor(window, 'session details dialog closed', () =>
    executeInPage(
      window,
      `!document.querySelector(${JSON.stringify(DETAIL_DIALOG_SELECTOR)})?.open`
    )
  )
}

async function openDetailsFromRow(window, selector, actionName) {
  const opened = await executeInPage(
    window,
    `(() => {
      const row = document.querySelector('tr[data-item-id="codex-parent"]')
      const button = row?.querySelector(${JSON.stringify(selector)})
      if (!button || button.disabled) return false
      button.click()
      return true
    })()`
  )
  assert.equal(opened, true, `${actionName} should open session details`)
  await waitFor(window, 'native session details dialog opened', () =>
    executeInPage(
      window,
      `(() => {
        const dialog = document.querySelector(${JSON.stringify(DETAIL_DIALOG_SELECTOR)})
        return Boolean(dialog?.open && dialog.matches(':modal'))
      })()`
    )
  )
}

async function verifyTranscriptDetails(window, viewport, measurements) {
  await waitFor(window, '30 visible transcript messages', () =>
    executeInPage(
      window,
      `document.querySelector(${JSON.stringify(DETAIL_DIALOG_SELECTOR)})?.querySelectorAll('.manager-transcript .manager-message').length === 30`
    )
  )
  const summary = await executeInPage(
    window,
    `(() => {
      const dialog = document.querySelector(${JSON.stringify(DETAIL_DIALOG_SELECTOR)})
      const transcript = dialog?.querySelector('.manager-transcript')
      const messageInfo = transcript?.querySelector('.calm-transcript-meta')
      const metadataEntry = messageInfo?.querySelector('.manager-message-extra')
      const body = transcript?.querySelector('.manager-message[data-role="assistant"] > .session-excerpt')
      const bodyStyle = body ? getComputedStyle(body) : null
      return {
        heading: transcript?.querySelector('.manager-section-heading h3')?.textContent.trim() ?? null,
        messageCount: transcript?.querySelectorAll('.manager-message').length ?? 0,
        firstRoles: Array.from(transcript?.querySelectorAll('.manager-message header strong') ?? [])
          .slice(0, 2)
          .map((element) => element.textContent.trim()),
        showAll: Array.from(transcript?.querySelectorAll('button') ?? []).some((button) => button.textContent.includes('显示全部 31 条消息')),
        toolBlocks: transcript?.querySelectorAll('.manager-session-block').length ?? 0,
        messageInfo: {
          title: messageInfo?.querySelector(':scope > summary')?.textContent.trim() ?? null,
          open: messageInfo?.open ?? null,
          entryCount: messageInfo?.querySelectorAll('.manager-message-extra').length ?? 0,
          entryTitle: metadataEntry?.querySelector('summary')?.textContent.trim() ?? null
        },
        bodyStyle: bodyStyle ? {
          fontSize: bodyStyle.fontSize,
          maxHeight: bodyStyle.maxHeight,
          overflowY: bodyStyle.overflowY,
          borderTopWidth: bodyStyle.borderTopWidth,
          backgroundTransparent: bodyStyle.backgroundColor === 'rgba(0, 0, 0, 0)'
        } : null
      }
    })()`
  )
  assert.equal(summary.heading, '会话内容')
  assert.equal(summary.messageCount, 30)
  assert.deepEqual(summary.firstRoles, ['助手', '你'])
  assert.equal(summary.showAll, true)
  assert.equal(summary.toolBlocks, 2)
  assert.deepEqual(summary.messageInfo, {
    title: '消息信息',
    open: false,
    entryCount: 1,
    entryTitle: '消息元数据'
  })
  assert.deepEqual(summary.bodyStyle, {
    fontSize: '13px',
    maxHeight: 'none',
    overflowY: 'visible',
    borderTopWidth: '0px',
    backgroundTransparent: true
  })
  await executeInPage(
    window,
    `document.querySelector(${JSON.stringify(DETAIL_DIALOG_SELECTOR)} + ' .manager-detail-panel')?.scrollIntoView({ block: 'start' })`
  )
  await settle(window)
  await saveScreenshot(window, viewport, 'details-start', measurements)
  await clickText(
    window,
    `${DETAIL_DIALOG_SELECTOR} .manager-transcript button`,
    '显示全部 31 条消息'
  )
  await waitFor(window, 'all transcript messages', () =>
    executeInPage(
      window,
      `document.querySelector(${JSON.stringify(DETAIL_DIALOG_SELECTOR)})?.querySelectorAll('.manager-transcript .manager-message').length === 31`
    )
  )
  const expanded = await executeInPage(
    window,
    `(() => {
      const block = document.querySelector(${JSON.stringify(DETAIL_DIALOG_SELECTOR)} + ' .manager-session-block')
      block?.querySelector('summary')?.click()
      document.querySelector(${JSON.stringify(DETAIL_DIALOG_SELECTOR)})?.querySelectorAll('.manager-transcript .manager-message')[30]?.scrollIntoView({ block: 'center' })
      return Boolean(block?.open)
    })()`
  )
  assert.equal(expanded, true, 'Tool blocks should expand as native disclosure elements')
  await settle(window)
  await saveScreenshot(window, viewport, 'details-tool-block', measurements)
}

async function verifyDetailActions(window) {
  const exportCount = calls.filter((entry) => entry.type === 'export').length
  await clickText(window, `${DETAIL_DIALOG_SELECTOR} .manager-detail-actions button`, '导出会话')
  await waitFor(
    window,
    'detail export request',
    () => calls.filter((entry) => entry.type === 'export').length === exportCount + 1
  )
  assert.deepEqual(calls.filter((entry) => entry.type === 'export').at(-1).ids, ['codex-parent'])
  await waitFor(window, 'detail actions idle after export', () =>
    executeInPage(
      window,
      `Array.from(document.querySelector(${JSON.stringify(DETAIL_DIALOG_SELECTOR)})?.querySelectorAll('.manager-detail-actions button') ?? []).every((button) => !button.disabled)`
    )
  )

  const resumeCount = calls.filter((entry) => entry.type === 'resume').length
  await clickText(window, `${DETAIL_DIALOG_SELECTOR} .manager-detail-actions button`, '继续会话')
  await waitFor(
    window,
    'detail resume request',
    () => calls.filter((entry) => entry.type === 'resume').length === resumeCount + 1
  )
  assert.equal(calls.filter((entry) => entry.type === 'resume').at(-1).id, 'codex-parent')
}

async function verifyMoreOpensSessionDetails(window) {
  await closeSessionDetails(window)
  await openDetailsFromRow(window, 'button[aria-haspopup="dialog"]', 'Row more action')
  await closeSessionDetails(window)
}

async function verifyDetails(window, viewport, measurements) {
  await openDetailsFromRow(window, 'button.row-title', 'Session title')
  await verifyTranscriptDetails(window, viewport, measurements)
  await verifyDetailActions(window)
  await verifyMoreOpensSessionDetails(window)
  await verifyDetailCacheLifecycle(window)
}

async function verifyDetailCacheLifecycle(window) {
  const countReads = () => calls.filter((entry) => entry.type === 'transcript').length
  const before = countReads()
  const waitReady = (expected) =>
    waitFor(
      window,
      'fresh transcript ready',
      async () =>
        countReads() === expected &&
        (await executeInPage(
          window,
          `(() => {
        const dialog = document.querySelector(${JSON.stringify(DETAIL_DIALOG_SELECTOR)})
        return Boolean(dialog?.querySelector('.manager-message')) &&
          Array.from(dialog?.querySelectorAll('.manager-detail-actions button') ?? []).every(button => !button.disabled)
      })()`
        ))
    )
  await openDetailsFromRow(window, 'button.row-title', 'Reopened session title')
  await waitReady(before + 1)
  await closeSessionDetails(window)
  await openDetailsFromRow(window, 'button.row-title', 'Session title after cache release')
  await waitReady(before + 2)
  const item = fixtureState.items.find((entry) => entry.id === 'codex-parent')
  const previousRevision = item.managed.revision
  try {
    item.managed.revision += '-refreshed'
    window.webContents.send(PREFIX + 'scan-requested')
    await waitReady(before + 3)
  } finally {
    item.managed.revision = previousRevision
  }
  await closeSessionDetails(window)
}

async function verifyExportCancellation(window) {
  const selected = await executeInPage(
    window,
    `(() => {
      const input = document.querySelector('tr[data-item-id="codex-parent"] input[type="checkbox"]')
      if (!input || input.disabled) return false
      input.click()
      return true
    })()`
  )
  assert.equal(selected, true)
  exportMode = 'pending'
  await clickText(window, '.manager-selection-bar button', '导出 1 项')
  await waitFor(window, 'export cancellation control', () =>
    executeInPage(
      window,
      `Array.from(document.querySelectorAll('.topbar button')).some((button) => button.textContent.includes('取消当前操作'))`
    )
  )
  await clickText(window, '.topbar button', '取消当前操作')
  await waitFor(window, 'cancelled export record', () =>
    executeInPage(
      window,
      `Array.from(document.querySelectorAll('.toast')).some((toast) => toast.textContent.includes('0/1 项'))`
    )
  )
  const recycleCount = await executeInPage(
    window,
    `window.sessionCleaner.getVisualCalls().then((entries) => entries.filter((entry) => entry.type === 'recycle').length)`
  )
  assert.equal(recycleCount, 0, 'Cancelling export must not start deletion')
  exportMode = 'complete'
  await clickText(window, '.manager-selection-bar button', '清空')
  await waitFor(
    window,
    'selection cleared after export',
    async () => (await readSelectionCount(window)) === 0
  )
}

async function prepareDeletionPreview(window) {
  await openPage(window, '会话管理', 'items-heading')
  const detailsOpen = await executeInPage(
    window,
    `Boolean(document.querySelector(${JSON.stringify(DETAIL_DIALOG_SELECTOR)})?.open)`
  )
  if (detailsOpen) await closeSessionDetails(window)
  await clickText(window, '.calm-deletion-tabs button', '全部会话')
  await setMultiSelect(window, 'Agent 多选', [], '56 条匹配')
  await setSelect(window, '排序', 'newest')
  for (const id of ['codex-parent', 'codex-child']) {
    const selected = await executeInPage(
      window,
      `(() => {
        const input = document.querySelector('tr[data-item-id=' + ${JSON.stringify(JSON.stringify(id))} + '] input[type="checkbox"]')
        if (!input || input.disabled) return false
        input.click()
        return true
      })()`
    )
    assert.equal(selected, true, `Could not select ${id} for the temporary preview`)
  }
  await clickText(window, '.manager-selection-bar button', '预览删除 2 项')
  await waitFor(window, 'two-item deletion preview', () =>
    executeInPage(window, `Boolean(document.querySelector('.manager-preview-summary button'))`)
  )
}

async function openDeleteDialog(window) {
  await clickText(window, '.manager-preview-summary button', '确认永久删除')
  await waitFor(window, 'permanent-delete confirmation dialog', () =>
    executeInPage(window, `Boolean(document.querySelector('dialog.manager-confirm-dialog')?.open)`)
  )
}

async function verifyDeleteCancellation(window) {
  const closeCount = calls.filter((entry) => entry.type === 'recycle').length
  await openDeleteDialog(window)
  await clickText(window, 'dialog.manager-confirm-dialog button', '返回检查')
  await waitFor(window, 'confirmation dialog closed', () =>
    executeInPage(window, `!document.querySelector('dialog.manager-confirm-dialog')?.open`)
  )
  assert.equal(calls.filter((entry) => entry.type === 'recycle').length, closeCount)

  await openDeleteDialog(window)
  const checked = await executeInPage(
    window,
    `(() => {
      const input = document.querySelector('.manager-export-before-delete input')
      if (!input || input.disabled) return false
      input.click()
      return input.checked
    })()`
  )
  assert.equal(checked, true, 'The fixture plan supports export before deletion')
  exportMode = 'cancelled'
  await clickText(window, 'dialog.manager-confirm-dialog button', '导出并永久删除')
  await waitFor(window, 'export cancellation prevents deletion', () =>
    executeInPage(
      window,
      `Array.from(document.querySelectorAll('.toast')).some((toast) => toast.textContent.includes('没有执行删除'))`
    )
  )
  assert.equal(calls.filter((entry) => entry.type === 'recycle').length, closeCount)
  exportMode = 'complete'
}

async function verifyPartialDeleteCancellation(window) {
  const previousRecycleCount = calls.filter((entry) => entry.type === 'recycle').length
  await openDeleteDialog(window)
  const checkboxChecked = await executeInPage(
    window,
    `Boolean(document.querySelector('.manager-export-before-delete input')?.checked)`
  )
  assert.equal(checkboxChecked, false, 'Each confirmation starts with export unchecked')
  deleteMode = 'pending-partial'
  await clickText(window, 'dialog.manager-confirm-dialog button', '永久删除')
  await waitFor(window, 'delete cancellation control', () =>
    executeInPage(
      window,
      `Array.from(document.querySelectorAll('.topbar button')).some((button) => button.textContent.includes('取消当前操作'))`
    )
  )
  await clickText(window, '.topbar button', '取消当前操作')
  await waitFor(window, 'partial delete notice', () =>
    executeInPage(
      window,
      `Array.from(document.querySelectorAll('.toast')).some((toast) => toast.textContent.includes('1/2 项'))`
    )
  )
  const notice = await executeInPage(
    window,
    `Array.from(document.querySelectorAll('.toast')).map((toast) => toast.textContent).join(' ')`
  )
  assert.doesNotMatch(notice, /永久删除已完成：2 项/)
  const recycleCount = calls.filter((entry) => entry.type === 'recycle').length
  assert.equal(recycleCount, previousRecycleCount + 1)
  await clickText(window, 'button', '返回会话管理')
  await waitFor(window, 'partial selection preserved', async () => {
    return (await readSelectionCount(window)) === 1
  })
}

async function verifyDeleteFlow(window) {
  await verifyExportCancellation(window)
  await prepareDeletionPreview(window)
  await verifyDeleteCancellation(window)
  await verifyPartialDeleteCancellation(window)
  deleteMode = 'complete'
}

async function verifyOverview(window) {
  const summary = await executeInPage(
    window,
    `(() => {
      const stats = document.querySelector('.calm-overview-stats')
      return {
        labels: Array.from(stats?.children ?? []).map((item) => item.querySelector('span')?.textContent.trim() ?? ''),
        count: stats?.children.length ?? 0,
        donut: Boolean(document.querySelector('.calm-donut[role="img"]')),
        legend: Array.from(document.querySelectorAll('.calm-agent-legend-row')).map((row) => row.querySelector('strong')?.textContent.trim() ?? ''),
        donutLabel: document.querySelector('.calm-donut')?.getAttribute('aria-label') ?? ''
      }
    })()`
  )
  assert.equal(summary.count, 3)
  assert.deepEqual(summary.labels, ['已发现 Agent', '本地会话', '可以删除'])
  assert.equal(summary.donut, true)
  assert.equal(summary.legend.length, 2)
  assert.match(summary.donutLabel, /已统计会话空间/)
}

async function verifySessionList(window) {
  const list = await executeInPage(
    window,
    `(() => {
      const table = document.querySelector('.manager-table')
      const row = table?.querySelector('tbody tr')
      const size = row?.querySelector('.calm-session-size')
      return {
        sessions: table?.querySelectorAll('tbody tr').length ?? 0,
        headers: Array.from(table?.querySelectorAll('thead th') ?? []).map((cell) => cell.textContent.trim()),
        headersVisible: Array.from(table?.querySelectorAll('thead th') ?? []).slice(1).every((cell) => {
          const bounds = cell.getBoundingClientRect()
          return bounds.width > 0 && getComputedStyle(cell).display !== 'none'
        }),
        hiddenHeaders: Array.from(table?.querySelectorAll('thead th') ?? []).slice(1).filter((cell) => {
          const bounds = cell.getBoundingClientRect()
          return bounds.width === 0 || getComputedStyle(cell).display === 'none'
        }).map((cell) => cell.textContent.trim()),
        viewportWidth: innerWidth,
        cells: row?.querySelectorAll('td').length ?? 0,
        firstItemId: row?.dataset.itemId ?? '',
        stackedSize: Boolean(size && /去重计入|文件大小|逻辑大小/.test(size.textContent)),
        pagination: document.querySelector('.manager-pagination')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
        matchSummary: document.querySelector('.manager-library-heading .muted')?.textContent.replace(/\\s+/g, ' ').trim() ?? ''
      }
    })()`
  )
  assert.equal(list.sessions, 40)
  assert.deepEqual(list.headers, ['', '会话', '大小', '最近使用', '删除状态', '更多操作'])
  assert.equal(
    list.headersVisible,
    true,
    `Hidden headers at ${list.viewportWidth}px: ${list.hiddenHeaders.join(', ')}`
  )
  assert.equal(list.cells, 6)
  assert.ok(list.firstItemId)
  assert.equal(list.stackedSize, false)
  assert.match(list.pagination, /第 1 \/ 2 页/)
  assert.match(list.matchSummary, /56 条匹配/)
}

async function verifyDeletionTabs(window) {
  const tabs = await executeInPage(
    window,
    `Array.from(document.querySelectorAll('.calm-deletion-tabs button')).map((button) => ({
      label: button.textContent.replace(/\\d+/g, '').trim(),
      count: Number(button.querySelector('span')?.textContent ?? 0),
      pressed: button.getAttribute('aria-pressed') === 'true'
    }))`
  )
  assert.deepEqual(
    tabs.map((tab) => tab.label),
    ['全部会话', '可以删除', '暂不可删']
  )
  assert.equal(tabs[0].pressed, true)
  assert.equal(tabs[1].count + tabs[2].count, tabs[0].count)

  for (const [index, label] of [
    [1, '可以删除'],
    [2, '暂不可删']
  ]) {
    await clickText(window, '.calm-deletion-tabs button', label)
    await waitFor(window, `${label} deletion tab`, () =>
      executeInPage(
        window,
        `Array.from(document.querySelectorAll('.calm-deletion-tabs button')).some((button) => button.textContent.includes(${JSON.stringify(label)}) && button.getAttribute('aria-pressed') === 'true')`
      )
    )
    await waitFor(window, `${label} match count`, () =>
      executeInPage(
        window,
        `document.querySelector('.manager-library-heading .muted')?.textContent.includes(${JSON.stringify(`${tabs[index].count} 条匹配`)})`
      )
    )
    const statuses = await executeInPage(
      window,
      `Array.from(document.querySelectorAll('.manager-table tbody .status-cell')).map((cell) => cell.textContent.trim())`
    )
    assert.ok(statuses.length > 0)
    assert.ok(
      statuses.every((status) =>
        label === '可以删除' ? status === '可以删除' : status !== '可以删除'
      )
    )
  }

  await clickText(window, '.calm-deletion-tabs button', '全部会话')
  await waitFor(window, 'all sessions restored', () =>
    executeInPage(
      window,
      `document.querySelector('.manager-library-heading .muted')?.textContent.includes('56 条匹配')`
    )
  )
}

async function verifyAnalytics(window, viewport, measurements) {
  const metrics = await executeInPage(
    window,
    `(() => {
      const pageText = document.querySelector('.page')?.innerText ?? ''
      return {
      groups: document.querySelectorAll('article.calm-storage-agent').length,
      summary: document.querySelector('.calm-analysis-intro')?.textContent.replace(/\\s+/g, ' ').trim(),
      widths: Array.from(document.querySelectorAll('article.calm-storage-agent .calm-storage-track > span')).map((bar) => Number.parseFloat(bar.style.width)),
      collapsed: Array.from(document.querySelectorAll('article.calm-storage-agent details.calm-storage-details')).every((details) => !details.open),
      compactButtons: Array.from(document.querySelectorAll('article.calm-storage-agent .manager-database-row button')).map((button) => button.textContent.trim()),
      hasOpenCodeHint: /OpenCode|整理数据库|数据库整理/.test(pageText),
      openCodeHintText: pageText.split('\\n').filter((line) => /OpenCode|整理数据库|数据库整理/.test(line)).join(' | '),
      hasOldCards: Boolean(document.querySelector('.storage-agent-card'))
      }
    })()`
  )
  assert.equal(metrics.groups, 2)
  assert.match(metrics.summary, /1\.8 KB/)
  assert.ok(metrics.widths[0] >= metrics.widths[1], 'Agent rows should rank by occupied bytes')
  assert.equal(metrics.collapsed, true)
  assert.deepEqual(metrics.compactButtons, [])
  assert.equal(
    metrics.hasOpenCodeHint,
    false,
    `Unexpected OpenCode hint: ${metrics.openCodeHintText}`
  )
  assert.equal(metrics.hasOldCards, false)
  await saveScreenshot(window, viewport, 'analytics', measurements)

  const opened = await executeInPage(
    window,
    `(() => {
      const details = document.querySelector('article.calm-storage-agent details.calm-storage-details')
      details?.querySelector('summary')?.click()
      return Boolean(details?.open)
    })()`
  )
  assert.equal(opened, true)
  const breakdown = await executeInPage(
    window,
    `Array.from(document.querySelectorAll('article.calm-storage-agent details.calm-storage-details[open] .calm-storage-breakdown span')).map((span) => span.textContent.trim())`
  )
  assert.deepEqual(breakdown, ['数据库', '写入日志', '其他文件', '其中共享'])
  await saveScreenshot(window, viewport, 'analytics-breakdown', measurements)
}

async function runViewport(viewport, measurements, interactionResults) {
  const window = await openWindow(viewport)
  try {
    await verifyOverview(window)
    await saveScreenshot(window, viewport, 'overview', measurements)
    await openPage(window, '空间分析', 'analytics-heading')
    await verifyAnalytics(window, viewport, measurements)
    await openPage(window, '会话管理', 'items-heading')
    await verifyFilterToolbar(window)
    await verifySessionList(window)
    await saveScreenshot(window, viewport, 'items', measurements)
    await verifySorting(window)
    await verifyDeletionTabs(window)
    await verifyFilterDialog(window, viewport, measurements)
    await verifyCrossPageSelection(window)
    await verifyDetails(window, viewport, measurements)
    await openPage(window, '操作记录', 'records-heading')
    assert.equal(
      await executeInPage(window, `document.querySelectorAll('.manager-record-summary').length`),
      1
    )
    await openPage(window, '会话管理', 'items-heading')
    if (viewport.width === 1280) {
      await verifyDeleteFlow(window)
      interactionResults.deleteFlow =
        'close, export cancellation, and partial-delete cancellation used fixture APIs only'
    }
  } finally {
    if (!window.isDestroyed()) window.destroy()
    activeWindow = undefined
  }
}

async function verifySupportedCompaction(measurements) {
  const originalState = fixtureState
  fixtureState = createSessionManagerFixtureState(50)
  fixtureState.sources[0].kind = 'opencode'
  fixtureState.sources[0].name = 'OpenCode'
  const viewport = { width: 1280, height: 800 }
  const window = await openWindow(viewport)
  try {
    await openPage(window, '空间分析', 'analytics-heading')
    const actions = await executeInPage(
      window,
      `Array.from(document.querySelectorAll('article.calm-storage-agent')).map((article) => ({
        name: article.querySelector('h3')?.textContent.trim(),
        detailsOpen: article.querySelector('details.calm-storage-details')?.open ?? false,
        buttons: Array.from(article.querySelectorAll('.manager-database-row button')).map((button) => button.textContent.trim()),
        buttonsInDetails: Array.from(article.querySelectorAll('.manager-database-row button')).every((button) =>
          Boolean(article.querySelector('details.calm-storage-details')?.contains(button))
        )
      }))`
    )
    const actionOwners = actions.filter((article) => article.buttons.length)
    assert.equal(actionOwners.length, 1)
    assert.equal(actionOwners[0].name, 'OpenCode')
    assert.equal(actionOwners[0].detailsOpen, false)
    assert.deepEqual(actionOwners[0].buttons, ['整理数据库'])
    assert.equal(actionOwners[0].buttonsInDetails, true)
    assert.ok(
      actions
        .filter((article) => article.name !== 'OpenCode')
        .every((article) => article.buttons.length === 0)
    )

    const expanded = await executeInPage(
      window,
      `(() => {
        const owner = Array.from(document.querySelectorAll('article.calm-storage-agent'))
          .find((article) => article.querySelector('h3')?.textContent.trim() === 'OpenCode')
        const details = owner?.querySelector('details.calm-storage-details')
        details?.querySelector('summary')?.click()
        const button = details?.querySelector('.manager-database-row button')
        return {
          open: Boolean(details?.open),
          buttonVisible: Boolean(button?.getClientRects().length)
        }
      })()`
    )
    assert.deepEqual(expanded, { open: true, buttonVisible: true })
    await saveScreenshot(window, viewport, 'analytics-opencode', measurements)
    const compactCount = calls.filter((entry) => entry.type === 'compact').length
    await clickText(window, 'article.calm-storage-agent .manager-database-row button', '整理数据库')
    await waitFor(
      window,
      'compaction request',
      () => calls.filter((entry) => entry.type === 'compact').length === compactCount + 1
    )
    await waitFor(window, 'compaction completion notice', () =>
      executeInPage(
        window,
        `Array.from(document.querySelectorAll('.toast')).some((toast) => toast.textContent.includes('数据库整理已完成'))`
      )
    )
    const compactCall = calls.filter((entry) => entry.type === 'compact').at(-1)
    assert.equal(compactCall.sourceId, 'codex-main')
  } finally {
    if (!window.isDestroyed()) window.destroy()
    activeWindow = undefined
    fixtureState = originalState
  }
}

async function run() {
  assert.ok(process.env.PI_SCRATCH_DIR, 'Run through scripts/run-with-test-scratch.mjs')
  assert.ok(existsSync(BUILT_RENDERER), `Built renderer missing: ${BUILT_RENDERER}`)
  scratchParent = resolve(process.env.PI_SCRATCH_DIR)
  const profile = join(scratchParent, 'session-manager-user-data')
  mkdirSync(profile, { recursive: true })
  app.setPath('userData', profile)
  scratch = await mkdtemp(join(scratchParent, 'session-manager-ui-visual-'))
  assertOwnedScratch()
  await writeFile(join(scratch, 'session-manager-ui-preload.cjs'), PRELOAD_SOURCE, 'utf8')
  await mkdir(OUTPUT_DIRECTORY, { recursive: true })
  app.on('window-all-closed', () => {})
  registerFixtureApi()
  await app.whenReady()
  const measurements = []
  const interactionResults = {}
  for (const viewport of VIEWPORTS) await runViewport(viewport, measurements, interactionResults)
  await verifySupportedCompaction(measurements)
  const reportPath = join(OUTPUT_DIRECTORY, 'measurements.json')
  await writeFile(
    reportPath,
    JSON.stringify(
      { fixture: 'session-manager-ui-fixtures', measurements, interactionResults },
      null,
      2
    ),
    'utf8'
  )
  console.log(`EVIDENCE: ${measurements.length} Electron screenshots; measurements=${reportPath}`)
  console.log(
    'PASS: temporary-fixture session-manager UI interactions completed at both viewport sizes'
  )
}

async function cleanup() {
  if (activeWindow && !activeWindow.isDestroyed()) activeWindow.destroy()
  for (const channel of CHANNELS) ipcMain.removeHandler(channel)
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
    const diagnostic = error instanceof Error ? (error.stack ?? error.message) : String(error)
    console.error(`FAIL: ${diagnostic.slice(0, 4000)}`)
    app.exit(1)
  }
)
