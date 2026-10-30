/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { join } from 'node:path'
import { CLAUDE_AGE_DAYS, DAY_MS, PI_AGE_DAYS } from './session-cleaner-integration-fixtures.mjs'

const WAIT_TIMEOUT_MS = 20_000
const POLL_INTERVAL_MS = 100
const VIEWPORT_WIDTH = 1080
const VIEWPORT_HEIGHT = 720
const FIXTURE_COUNT = 4
const CATEGORY_FILTER = 'select[aria-label="内容类型"]'
const STATUS_FILTER = 'select[aria-label="能力状态"]'
const CHANGED_OLDER_SESSION_DAYS = 15

async function inPage(window, script) {
  return window.webContents.executeJavaScript(script)
}

export async function callCleanerApi(window, method, args = []) {
  return inPage(
    window,
    `(async () => {
    try {
      return { ok: true, value: await window.sessionCleaner[${JSON.stringify(method)}](...${JSON.stringify(args)}) }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })()`
  )
}

async function waitFor(label, check) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      if (await check()) return
    } catch {
      /* renderer 切换期间可能暂时无法执行页面脚本。 */
    }
    await delay(POLL_INTERVAL_MS)
  }
  throw new Error(`等待超时：${label}`)
}

async function settle(window) {
  await inPage(window, 'document.body.getBoundingClientRect().height')
  await delay(40)
}

async function assertNoOverflow(window, label) {
  await waitFor(`${label}视口尺寸`, async () => {
    const [width, height] = window.getContentSize()
    return (
      width === VIEWPORT_WIDTH &&
      height === VIEWPORT_HEIGHT &&
      (await inPage(
        window,
        `innerWidth === ${VIEWPORT_WIDTH} && innerHeight === ${VIEWPORT_HEIGHT}`
      ))
    )
  })
  await settle(window)
  const size = await inPage(
    window,
    `(() => ({
    width: innerWidth, height: innerHeight,
    rootWidth: document.documentElement.scrollWidth,
    rootClient: document.documentElement.clientWidth,
    bodyWidth: document.body.scrollWidth
  }))()`
  )
  assert.equal(size.width, VIEWPORT_WIDTH, `${label}: viewport width`)
  assert.equal(size.height, VIEWPORT_HEIGHT, `${label}: viewport height`)
  assert.ok(
    size.rootWidth <= size.rootClient,
    `${label}: document horizontal overflow ${JSON.stringify(size)}`
  )
  assert.ok(
    size.bodyWidth <= size.rootClient,
    `${label}: body horizontal overflow ${JSON.stringify(size)}`
  )
}

async function clickButton(window, text) {
  const clicked = await inPage(
    window,
    `(() => {
    const button = Array.from(document.querySelectorAll('button')).find((entry) => entry.textContent.trim() === ${JSON.stringify(text)})
    if (!button || button.disabled) return false
    button.click()
    return true
  })()`
  )
  assert.equal(clicked, true, `找不到可用按钮：${text}`)
  await settle(window)
}

async function clickPage(window, label, headingId) {
  const clicked = await inPage(
    window,
    `(() => {
    const buttons = Array.from(document.querySelectorAll('nav[aria-label="会话清理页面"] button'))
    const button = buttons.find((entry) => entry.textContent.includes(${JSON.stringify(label)}))
    if (!button) return false
    button.click()
    return true
  })()`
  )
  assert.equal(clicked, true, `找不到导航项：${label}`)
  await waitFor(`${label}页面`, () =>
    inPage(window, `Boolean(document.getElementById(${JSON.stringify(headingId)}))`)
  )
  await assertNoOverflow(window, label)
}

async function selectSource(window, sourceId) {
  const selector = `.source-list button[data-source-id="${sourceId}"]`
  const clicked = await inPage(
    window,
    `(() => {
    const button = document.querySelector(${JSON.stringify(selector)})
    if (!button || button.disabled) return false
    button.click()
    return true
  })()`
  )
  assert.equal(clicked, true, `找不到来源筛选：${sourceId}`)
  await settle(window)
}

async function selectVisibleCandidates(window) {
  const clicked = await inPage(
    window,
    `(() => {
    const input = document.querySelector('thead input[aria-label="选择本页会话"]')
    if (!input || input.disabled) return false
    input.click()
    return true
  })()`
  )
  assert.equal(clicked, true, '当前可见候选应可选择')
  await settle(window)
}

async function setValue(window, selector, value, tag) {
  const advanced = selector === CATEGORY_FILTER || selector === STATUS_FILTER
  if (
    advanced &&
    !(await inPage(window, `Boolean(document.querySelector(${JSON.stringify(selector)}))`))
  ) {
    await inPage(window, `document.querySelector('.calm-filter-trigger').click()`)
    await waitFor('筛选抽屉', () =>
      inPage(window, `Boolean(document.querySelector(${JSON.stringify(selector)}))`)
    )
  }
  if (advanced) {
    await inPage(
      window,
      `(() => {
      const details = document.querySelector(${JSON.stringify(selector)}).closest('details')
      if (details && !details.open) details.querySelector('summary').click()
    })()`
    )
  }
  const event = tag === 'select' ? 'change' : 'input'
  const changed = await inPage(
    window,
    `(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    if (!element) return false
    const prototype = ${tag === 'select' ? 'HTMLSelectElement' : 'HTMLInputElement'}.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, ${JSON.stringify(value)})
    element.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true }))
    return true
  })()`
  )
  assert.equal(changed, true, `找不到控件：${selector}`)
  await settle(window)
  if (advanced) {
    await inPage(window, `document.querySelector('button[aria-label="关闭筛选会话"]').click()`)
    await settle(window)
  }
}

export async function verifyToolSecurity(window, capture, scratch, fixtures) {
  const preferences = capture.options?.webPreferences
  assert.ok(preferences, '未捕获清理器 BrowserWindow 选项')
  assert.equal(capture.options?.frame, false, '会话清理窗口必须使用无边框标题栏')
  assert.match(
    capture.options?.icon ?? '',
    /icon-session-cleaner\.png$/,
    '应使用 AgentSpace 窗口图标'
  )
  assert.ok(
    existsSync(capture.options.icon),
    '窗口图标资源必须存在于打包资源目录：' + capture.options.icon
  )
  assert.equal(preferences.sandbox, true)
  assert.equal(preferences.contextIsolation, true)
  assert.equal(preferences.nodeIntegration, false)
  assert.equal(preferences.preload, join(scratch, 'preload', 'session-cleaner.js'))
  window.setContentSize(1080, 720)
  assert.deepEqual(window.getContentSize(), [1080, 720])
  const surface = await inPage(
    window,
    `(() => ({
    cleaner: typeof window.sessionCleaner, electron: typeof window.electron,
    codexStatus: typeof window.codexStatus, require: typeof window.require,
    process: typeof window.process, methods: Object.keys(window.sessionCleaner || {}).sort()
  }))()`
  )
  assert.equal(surface.cleaner, 'object')
  assert.equal(surface.electron, 'undefined')
  assert.equal(surface.codexStatus, 'undefined')
  assert.equal(surface.require, 'undefined')
  assert.equal(surface.process, 'undefined')
  assert.ok(surface.methods.includes('getState') && surface.methods.includes('scan'))
  for (const method of [
    'minimizeWindow',
    'toggleMaximizeWindow',
    'closeWindow',
    'isWindowMaximized',
    'onWindowMaximized'
  ])
    assert.ok(surface.methods.includes(method), `缺少窗口控制 API：${method}`)
  const controls = await inPage(
    window,
    `Array.from(document.querySelectorAll('.window-controls button'), button => button.getAttribute('aria-label'))`
  )
  assert.deepEqual(controls, ['最小化', '最大化', '关闭'])
  const chromeStyles = await inPage(
    window,
    `(() => ({
      drag: getComputedStyle(document.querySelector('.topbar')).getPropertyValue('-webkit-app-region'),
      noDrag: getComputedStyle(document.querySelector('.window-control')).getPropertyValue('-webkit-app-region'),
      scrollbarWidth: getComputedStyle(document.querySelector('main'), '::-webkit-scrollbar').width
    }))()`
  )
  assert.equal(chromeStyles.drag, 'drag')
  assert.equal(chromeStyles.noDrag, 'no-drag')
  assert.equal(chromeStyles.scrollbarWidth, '7px')
  const initialMaximized = await callCleanerApi(window, 'isWindowMaximized')
  assert.equal(initialMaximized.ok, true, initialMaximized.message)
  assert.equal(typeof initialMaximized.value, 'boolean')
  await inPage(window, `document.querySelector('.window-control[aria-label="最大化"]').click()`)
  await waitFor(
    '窗口最大化状态更新',
    async () =>
      await inPage(window, `document.querySelector('.window-control[aria-label="还原"]') !== null`)
  )
  const maximized = await callCleanerApi(window, 'isWindowMaximized')
  assert.equal(maximized.ok, true, maximized.message)
  assert.equal(maximized.value, true)
  await inPage(window, `document.querySelector('.window-control[aria-label="还原"]').click()`)
  await waitFor(
    '窗口还原状态更新',
    async () =>
      await inPage(
        window,
        `document.querySelector('.window-control[aria-label="最大化"]') !== null`
      )
  )
  const restored = await callCleanerApi(window, 'isWindowMaximized')
  assert.equal(restored.ok, true, restored.message)
  assert.equal(restored.value, false)
  await waitFor('窗口内容尺寸还原', () => {
    const [width, height] = window.getContentSize()
    return width === VIEWPORT_WIDTH && height === VIEWPORT_HEIGHT
  })
  await waitFor('窗口还原渲染尺寸', () =>
    inPage(window, `innerWidth === ${VIEWPORT_WIDTH} && innerHeight === ${VIEWPORT_HEIGHT}`)
  )
  const initial = await callCleanerApi(window, 'getState')
  assert.equal(initial.ok, true, initial.message)
  assert.deepEqual(
    initial.value.sources.map((source) => source.path).sort(),
    fixtures.sources.map((source) => source.path).sort()
  )
  assert.equal(initial.value.sources.length, fixtures.sources.length, '扫描范围只能包含临时来源')
  console.log('PASS tool sandbox/contextIsolation/preload boundary and isolated getState')
}

export async function scanOwnedFixtures(window, capture, fixtures) {
  const previousRequests = capture.scanRequests
  if (window.isMaximized()) window.unmaximize()
  await delay(300)
  window.setContentSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT)
  await waitFor('验收视口尺寸', () => {
    const [width, height] = window.getContentSize()
    return width === VIEWPORT_WIDTH && height === VIEWPORT_HEIGHT
  })
  await clickPage(window, '会话管理', 'items-heading')
  await clickButton(window, '重新扫描')
  await waitFor('renderer receives session scan results', async () => {
    const count = await inPage(
      window,
      'document.querySelector(".calm-deletion-tabs button span")?.textContent'
    )
    const result = await callCleanerApi(window, 'getState')
    return (
      capture.scanRequests === previousRequests + 1 &&
      result.ok &&
      !result.value.scanning &&
      Number(count) > 0
    )
  })
  const result = await callCleanerApi(window, 'getState')
  assert.equal(result.ok, true, result.message)
  const state = result.value
  assert.ok(state.scannedAt)
  assert.equal(state.issues.length, 0, JSON.stringify(state.issues.slice(0, 3)))
  assert.deepEqual(
    state.items.map((item) => item.path.replace(/^\\\\\?\\/, '')).sort(),
    fixtures.files.map((file) => file.path).sort()
  )
  const sessionCount = state.items.filter((item) => item.category === 'sessions').length
  await clickPage(window, '存储总览', 'overview-heading')
  let releaseScan
  capture.scanGate = new Promise((resolve) => {
    releaseScan = resolve
  })
  await clickButton(window, '扫描会话')
  try {
    await waitFor('扫描中刷新图标', () =>
      inPage(
        window,
        `(() => {
        const icon = document.querySelector('.heading-actions .scan-active')
        const style = icon ? getComputedStyle(icon) : null
        return Boolean(
          icon?.querySelector('path')?.getAttribute('d').startsWith('M21 12') &&
          style.animationName === 'cleaner-scan' && style.animationDuration === '1.2s'
        )
      })()`
      )
    )
  } finally {
    releaseScan()
  }
  await waitFor('扫描结束后恢复扫描图标', async () => {
    const state = await callCleanerApi(window, 'getState')
    return (
      state.ok &&
      !state.value.scanning &&
      (await inPage(
        window,
        `(() => {
        const icon = document.querySelector('.heading-actions svg')
        return Boolean(
          icon && !icon.classList.contains('scan-active') &&
          icon.querySelector('path')?.getAttribute('d').startsWith('M3 8V3h5')
        )
      })()`
      ))
    )
  })
  console.log('PASS scanning uses rotating refresh icon; idle restores scan icon')
  const overviewCount = await inPage(
    window,
    "document.querySelectorAll('.calm-overview-stats strong')[1]?.textContent.replace(/\\s/g, '') ?? ''"
  )
  assert.equal(overviewCount, sessionCount + '个会话')
  const claude = state.items.find((item) => item.path === fixtures.claudeFile)
  const pi = state.items.find((item) => item.sessionId === fixtures.piSessionId)
  const unknown = state.items.find((item) => item.category === 'unknown')
  assert.equal(claude?.sessionId, fixtures.claudeSessionId)
  assert.equal(claude?.status, 'candidate')
  assert.equal(pi?.status, 'candidate')
  assert.equal(unknown?.status, 'read-only')
  assert.ok(claude.modifiedAt < Date.now() - (CLAUDE_AGE_DAYS - 10) * DAY_MS)
  assert.ok(pi.modifiedAt < Date.now() - (PI_AGE_DAYS - 1) * DAY_MS)
  const details = await callCleanerApi(window, 'transcript', [claude.id])
  assert.equal(details.ok, true, details.message)
  const messageText = details.value.messages.map((message) => message.content).join('\n')
  assert.ok(messageText.includes(fixtures.claudeTitle))
  assert.ok(messageText.includes('temporary integration reply'))
  assert.ok(capture.worker && capture.workerSpawn)
  await capture.workerSpawn
  assert.equal(typeof capture.worker.pid, 'number')
  console.log(
    'PASS real worker scan/details: Claude, Pi v3, Codex regular/archived, and read-only unknown fixtures'
  )
  return state
}

async function verifyRendererLoaded(window) {
  await window.webContents.reload()
  await waitFor('清理器 renderer 加载', () =>
    inPage(
      window,
      "typeof window.sessionCleaner === 'object' && Boolean(document.getElementById('overview-heading'))"
    )
  )
  await assertNoOverflow(window, '总览')
}

async function verifySourcePage(window, fixtures) {
  await clickPage(window, '来源管理', 'sources-heading')
  const text = await inPage(window, 'document.body.innerText')
  for (const source of fixtures.sources) {
    assert.ok(text.includes(source.name), `来源页缺少 ${source.name}`)
    assert.ok(text.includes(source.path), `来源页未显示临时目录 ${source.path}`)
  }
  assert.ok(text.includes('Codex · 普通会话'))
  assert.ok(text.includes('Codex · 已归档会话'))
}

async function assertCodexRows(window, fixtures) {
  const titles = await inPage(
    window,
    'Array.from(document.querySelectorAll("tbody .item-title-button"), node => node.textContent.trim())'
  )
  assert.deepEqual(
    titles.sort(),
    [...fixtures.codexTitles].sort(),
    'Codex 应同时显示普通和归档会话'
  )
  const agent = await inPage(
    window,
    `(() => {
    const select = document.querySelector('select[aria-label="Agent"]')
    return { value: select.value, label: select.selectedOptions[0].textContent.trim() }
  })()`
  )
  assert.deepEqual(agent, { value: 'agent:codex', label: 'Codex' })
}

async function verifyGroupedSources(window, fixtures) {
  await clickPage(window, '存储总览', 'overview-heading')
  const state = await callCleanerApi(window, 'getState')
  assert.equal(state.ok, true, state.message)
  const sourceIds = new Set(
    fixtures.sources.filter((source) => source.kind === 'codex').map((source) => source.id)
  )
  const codexBytes = state.value.items
    .filter((item) => sourceIds.has(item.sourceId))
    .reduce((sum, item) => sum + item.bytes, 0)
  const groups = await inPage(
    window,
    `(() => ({
    sidebar: Array.from(document.querySelectorAll('.source-list [data-source-id="agent:codex"] .source-size'), node => node.textContent.trim()),
    legend: Array.from(document.querySelectorAll('.calm-agent-legend-row')).filter(row => row.querySelector('strong')?.textContent.trim() === 'Codex').map(row => row.querySelector('b').textContent.trim())
  }))()`
  )
  assert.deepEqual(groups, { sidebar: [codexBytes + ' B'], legend: [codexBytes + ' B'] })
  await selectSource(window, 'agent:codex')
  await assertCodexRows(window, fixtures)
  await setValue(window, 'select[aria-label="Agent"]', 'agent:pi', 'select')
  assert.equal(await inPage(window, 'document.querySelectorAll("tbody tr").length'), 1)
  await setValue(window, 'select[aria-label="Agent"]', 'agent:codex', 'select')
  await assertCodexRows(window, fixtures)
  await clickPage(window, '存储总览', 'overview-heading')
  await inPage(
    window,
    `Array.from(document.querySelectorAll('.calm-agent-legend-row')).find(row => row.querySelector('strong')?.textContent.trim() === 'Codex').click()`
  )
  await settle(window)
  await assertCodexRows(window, fixtures)
  await selectSource(window, 'all')
  console.log(
    'PASS one Codex group in sidebar/legend/Agent filter; both directories included and bytes summed'
  )
}

async function verifyItemFilters(window, fixtures) {
  await clickPage(window, '会话管理', 'items-heading')
  await selectSource(window, 'all')
  const state = await callCleanerApi(window, 'getState')
  assert.equal(state.ok, true, state.message)
  const sessionCount = state.value.items.filter((item) => item.category === 'sessions').length
  const resourceCount = state.value.items.filter((item) => item.category === 'resources').length
  const firstDeletionTab = await inPage(
    window,
    `(() => {
    const tab = document.querySelector('.calm-deletion-tabs button')
    return { text: tab.textContent.trim(), pressed: tab.getAttribute('aria-pressed') }
  })()`
  )
  assert.deepEqual(firstDeletionTab, {
    text: `全部会话${sessionCount}`,
    pressed: 'true'
  })
  const sessionRows = await inPage(window, 'document.querySelectorAll("tbody tr").length')
  assert.equal(sessionRows, sessionCount, '默认列表应只显示会话')
  await setValue(window, CATEGORY_FILTER, 'all', 'select')
  const allRows = await inPage(window, 'document.querySelectorAll("tbody tr").length')
  assert.equal(allRows, state.value.items.length, '全部内容应包含会话与资源条目')
  await setValue(window, CATEGORY_FILTER, 'resources', 'select')
  const resourceRows = await inPage(window, 'document.querySelectorAll("tbody tr").length')
  assert.equal(resourceRows, resourceCount, '资源分类应只显示资源条目')
  await setValue(window, CATEGORY_FILTER, 'sessions', 'select')
  const restoredSessionRows = await inPage(window, 'document.querySelectorAll("tbody tr").length')
  assert.equal(restoredSessionRows, sessionCount)
  const matchingCount = await inPage(
    window,
    "document.querySelector('.calm-list-heading .muted')?.textContent.trim() ?? ''"
  )
  assert.equal(matchingCount, sessionCount + ' 条匹配')
  await selectSource(window, 'agent:claude')
  await setValue(window, STATUS_FILTER, 'candidate', 'select')
  const titles = await inPage(
    window,
    'Array.from(document.querySelectorAll("tbody tr .item-title-button")).map((node) => node.textContent.trim())'
  )
  const filterEvidence = await inPage(
    window,
    '(() => ({ filters: Array.from(document.querySelectorAll("select")).map((select) => ({ label: select.getAttribute("aria-label"), value: select.value })), titles: Array.from(document.querySelectorAll("tbody tr .item-title-button")).map((node) => node.textContent.trim()), body: document.querySelector(".sessions-workspace")?.innerText || document.body.innerText.slice(-500) }))()'
  )
  assert.equal(titles.length, 1, JSON.stringify(filterEvidence))
  assert.equal(titles[0], fixtures.claudeTitle, '会话标题应来自内容而非时间/文件名')
  const titleTooltip = await inPage(
    window,
    "document.querySelector('tbody tr .item-title-button')?.title"
  )
  assert.equal(titleTooltip, titles[0])
  await setValue(window, '#item-query', 'no-such-session', 'input')
  const rows = await inPage(window, 'document.querySelectorAll("tbody tr").length')
  assert.equal(rows, 0, '搜索词应过滤掉不匹配条目')
  await assertNoOverflow(window, '筛选结果')
  await selectSource(window, 'agent:claude')
  const restored = await inPage(
    window,
    "({ query: document.getElementById('item-query').value, rows: document.querySelectorAll('tbody tr').length })"
  )
  assert.deepEqual(restored, { query: '', rows: 1 }, '切换侧栏来源应清除旧搜索并显示会话')
  await setValue(window, STATUS_FILTER, 'all', 'select')
  await selectSource(window, 'all')
}

async function verifyHelpTip(window) {
  const size = await inPage(
    window,
    `(() => {
    const button = document.querySelector('.policy-panel .help-button')
    const rect = button.getBoundingClientRect()
    button.click()
    return { width: rect.width, height: rect.height }
  })()`
  )
  assert.deepEqual(size, { width: 18, height: 18 })
  await waitFor('问号提示打开', () =>
    inPage(
      window,
      `(() => {
      const button = document.querySelector('.policy-panel .help-button')
      const tooltip = document.querySelector('[role="tooltip"]')
      return Boolean(
        tooltip?.textContent && tooltip.id === button.getAttribute('aria-describedby') &&
        tooltip.textContent === button.getAttribute('aria-label')
      )
    })()`
    )
  )
  await inPage(
    window,
    `document.querySelector('.policy-panel .help-button').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    )`
  )
  await waitFor('问号提示关闭', () =>
    inPage(window, 'document.querySelector(\'[role="tooltip"]\') === null')
  )
  console.log('PASS compact help button opens an accessible tooltip and Escape dismisses it')
}

export async function verifyNavigationAndFilters(window, fixtures) {
  await verifyRendererLoaded(window)
  for (const [label, heading] of [
    ['会话管理', 'items-heading'],
    ['来源管理', 'sources-heading'],
    ['清理中心', 'review-heading'],
    ['操作记录', 'records-heading'],
    ['策略设置', 'policy-heading'],
    ['存储总览', 'overview-heading']
  ]) {
    await clickPage(window, label, heading)
    if (label === '策略设置') await verifyHelpTip(window)
  }
  await verifySourcePage(window, fixtures)
  await verifyGroupedSources(window, fixtures)
  await verifyItemFilters(window, fixtures)
  console.log(
    'PASS source display, navigation, candidate/source/search filters, 1080x720 overflow checks'
  )
}

async function createUiReview(window) {
  await clickPage(window, '会话管理', 'items-heading')
  await selectSource(window, 'all')
  for (const [selector, value, tag] of [
    ['#item-query', '', 'input'],
    [CATEGORY_FILTER, 'all', 'select'],
    [STATUS_FILTER, 'all', 'select']
  ])
    await setValue(window, selector, value, tag)
  await selectVisibleCandidates(window)
  await clickPage(window, '清理中心', 'review-heading')
  const clicked = await inPage(
    window,
    `(() => {
    const button = Array.from(document.querySelectorAll('button')).find((entry) => entry.textContent.trim().startsWith('生成永久删除预览'))
    if (!button || button.disabled) return false
    button.click()
    return true
  })()`
  )
  assert.equal(clicked, true, '找不到可用的永久删除预览按钮')
  await waitFor('审核方案渲染', () =>
    inPage(
      window,
      "Boolean(document.querySelector('.manager-preview-list') || document.querySelector('.feedback-error'))"
    )
  )
  const preview = await inPage(
    window,
    `(() => ({
    count: document.querySelectorAll('.manager-preview-list .manager-preview-row').length,
    body: document.querySelector('.page-review')?.innerText,
    feedback: document.querySelector('.feedback-stack')?.innerText
  }))()`
  )
  assert.equal(preview.count, FIXTURE_COUNT, JSON.stringify(preview))
  await assertNoOverflow(window, '审核方案')
}

export async function verifyProtectionInvalidation(window, fixtures) {
  await createUiReview(window)
  await clickPage(window, '会话管理', 'items-heading')
  await clickButton(window, '保护')
  await waitFor('保护更新', async () => {
    const state = await callCleanerApi(window, 'getState')
    return (
      state.ok &&
      state.value.items.filter((item) => item.status === 'protected').length === FIXTURE_COUNT
    )
  })
  await clickPage(window, '清理中心', 'review-heading')
  await waitFor('保护后审核失效提示', () =>
    inPage(window, "document.body.innerText.includes('预览已失效')")
  )
  const state = await callCleanerApi(window, 'getState')
  assert.equal(state.ok, true, state.message)
  const protectedItems = state.value.items.filter((item) => item.status === 'protected')
  assert.equal(protectedItems.length, FIXTURE_COUNT)
  assert.ok(
    protectedItems.every((item) =>
      fixtures.files.some(
        (file) => file.path.replace(/^\\\\\?\\/, '') === item.path.replace(/^\\\\\?\\/, '')
      )
    )
  )
  const unprotected = await callCleanerApi(window, 'protect', [
    protectedItems.map((item) => item.id),
    false
  ])
  assert.equal(unprotected.ok, true, unprotected.message)
  const scan = await callCleanerApi(window, 'scan')
  assert.equal(scan.ok, true, scan.message)
  await verifyRendererLoaded(window)
  console.log('PASS protect invalidates the rendered review and unprotected fixtures rescan')
}

export async function verifySettingsInvalidation(window) {
  await createUiReview(window)
  await clickPage(window, '策略设置', 'policy-heading')
  await setValue(window, '#policy-olderSessionDays', String(CHANGED_OLDER_SESSION_DAYS), 'input')
  await clickButton(window, '保存策略')
  await waitFor('策略保存', async () => {
    const state = await callCleanerApi(window, 'getState')
    return (
      state.ok &&
      state.value.settings.olderSessionDays === CHANGED_OLDER_SESSION_DAYS &&
      !state.value.scannedAt
    )
  })
  await clickPage(window, '清理中心', 'review-heading')
  await waitFor('策略后审核失效提示', () =>
    inPage(window, "document.body.innerText.includes('预览已失效')")
  )
  const state = await callCleanerApi(window, 'getState')
  assert.equal(state.ok, true, state.message)
  const invalid = await callCleanerApi(window, 'saveSettings', [
    { ...state.value.settings, keepRecentDays: 0 }
  ])
  assert.equal(invalid.ok, false)
  assert.match(invalid.message, /策略字段 keepRecentDays 超出允许范围/)
  console.log('PASS settings change invalidates review; invalid settings rejected')
}
