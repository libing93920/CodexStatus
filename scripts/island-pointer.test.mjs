/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

import { TASKBAR_BUTTON_HEIGHT, TASKBAR_BUTTON_WIDTH } from '../src/shared/island-layout.ts'

const EXPECTED_POINTER_INTERVAL_MS = 50
const source = await readFile(
  new URL('../src/main/windows/island-window.ts', import.meta.url),
  'utf8'
)
const moduleFile = ts.createSourceFile('island-window.ts', source, ts.ScriptTarget.Latest, true)
const moduleRuntime = moduleFile.statements
  .filter((node) => ts.isVariableStatement(node) || ts.isFunctionDeclaration(node))
  .map((node) => node.getText(moduleFile).replace(/^export\s+/, ''))
  .join('\n')
const moduleCode = ts.transpileModule(
  `${moduleRuntime}\n;({ createIslandWindow, showIslandWindow, startIslandPointerTracking, stopIslandPointerTracking, ISLAND_POINTER_CHANNEL, ISLAND_POINTER_INTERVAL_MS })`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
).outputText

const mainSource = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const mainFile = ts.createSourceFile('index.ts', mainSource, ts.ScriptTarget.Latest, true)
const registerIpcHandlers = mainFile.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'registerIpcHandlers'
)
assert.ok(registerIpcHandlers)
const interactiveRegistration = registerIpcHandlers.body.statements.find(
  (node) =>
    ts.isExpressionStatement(node) &&
    ts.isCallExpression(node.expression) &&
    node.expression.arguments[0]?.getText(mainFile) === 'CHANNELS.islandInteractive'
)
assert.ok(interactiveRegistration)
const interactiveHandler = interactiveRegistration.expression.arguments[1]
assert.ok(ts.isArrowFunction(interactiveHandler))
const interactiveHandlerCode = ts.transpileModule(`(${interactiveHandler.getText(mainFile)})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText

class FakeWindow extends EventEmitter {
  constructor(options) {
    super()
    this.options = options
    this.visible = options.show
    this.destroyed = false
    this.contentBounds = { x: 1000, y: 700, width: 68, height: 40 }
    this.sent = []
    this.webContents = new EventEmitter()
    this.webContents.send = (channel, payload) => {
      this.sent.push({ channel, payload: JSON.parse(JSON.stringify(payload)) })
    }
  }

  setAlwaysOnTop() {
    return undefined
  }
  setIgnoreMouseEvents() {
    return undefined
  }
  isVisible() {
    return this.visible
  }
  isDestroyed() {
    return this.destroyed
  }
  getContentBounds() {
    return this.contentBounds
  }
  showInactive() {
    this.visible = true
  }
  moveTop() {
    return undefined
  }
}

function createScheduler() {
  const timers = []
  const setInterval = (callback, interval) => {
    const timer = {
      callback,
      interval,
      cleared: false,
      unrefCalled: false,
      unref() {
        this.unrefCalled = true
      }
    }
    timers.push(timer)
    return timer
  }
  const clearInterval = (timer) => {
    timer.cleared = true
  }
  return { timers, setInterval, clearInterval }
}

function createPointerTrackerHarness(platform = 'win32') {
  const scheduler = createScheduler()
  const cursor = { x: 1130, y: 740 }
  const context = vm.createContext({
    BrowserWindow: FakeWindow,
    TASKBAR_BUTTON_HEIGHT,
    TASKBAR_BUTTON_WIDTH,
    process: { platform },
    screen: { getCursorScreenPoint: () => ({ ...cursor }) },
    islandDiagnostics: { record: () => undefined },
    setInterval: scheduler.setInterval,
    clearInterval: scheduler.clearInterval
  })
  const api = vm.runInNewContext(moduleCode, context)
  return { ...api, cursor, scheduler }
}

function createTaskbarWindow(api) {
  return api.createIslandWindow({
    preloadPath: 'fixture-preload',
    loadRenderer: () => undefined,
    placement: { displayMode: 'taskbar' }
  })
}

function createInteractiveWindow(id, nativeCalls) {
  return {
    webContents: { id },
    setIgnoreMouseEvents(ignore, options) {
      nativeCalls.push({
        window: this,
        ignore,
        options: JSON.parse(JSON.stringify(options))
      })
    }
  }
}

function createInteractiveHandlerHarness(options = {}) {
  const nativeCalls = []
  const trackingCalls = []
  const diagnosticCalls = []
  const tracking = { activeWindow: undefined }
  const window = createInteractiveWindow(options.windowId ?? 10, nativeCalls)
  const context = vm.createContext({
    islandWindow: window,
    islandPresentationVisible: options.visible ?? true,
    islandPresentationRevision: options.revision ?? 23,
    isQuitting: options.isQuitting ?? false,
    persistedState: { settings: { island: { displayMode: options.displayMode ?? 'taskbar' } } },
    islandInteractiveDiagnostic: () => ({}),
    islandDiagnostics: { record: (...args) => diagnosticCalls.push(args) },
    startIslandPointerTracking: (target, revision) => {
      trackingCalls.push({ action: 'start', window: target, revision })
      tracking.activeWindow = target
    },
    stopIslandPointerTracking: (target) => {
      trackingCalls.push({ action: 'stop', window: target })
      if (tracking.activeWindow === target) tracking.activeWindow = undefined
    }
  })
  const handler = vm.runInNewContext(interactiveHandlerCode, context)
  return { context, diagnosticCalls, handler, nativeCalls, tracking, trackingCalls, window }
}

test('任务栏指针采样按内容区换算坐标，每50ms继续转发静止位置', () => {
  const harness = createPointerTrackerHarness()
  const window = createTaskbarWindow(harness)
  window.visible = true
  harness.startIslandPointerTracking(window, 23)

  assert.equal(harness.ISLAND_POINTER_INTERVAL_MS, EXPECTED_POINTER_INTERVAL_MS)
  assert.equal(harness.scheduler.timers.length, 1)
  const timer = harness.scheduler.timers[0]
  assert.equal(timer.interval, EXPECTED_POINTER_INTERVAL_MS)
  assert.equal(timer.unrefCalled, true)

  timer.callback()
  timer.callback()
  assert.deepEqual(window.sent, [
    {
      channel: harness.ISLAND_POINTER_CHANNEL,
      payload: { presentationRevision: 23, x: 130, y: 40 }
    },
    {
      channel: harness.ISLAND_POINTER_CHANNEL,
      payload: { presentationRevision: 23, x: 130, y: 40 }
    }
  ])
})

test('重新启动替换旧定时器，旧回调不再发送', () => {
  const harness = createPointerTrackerHarness()
  const window = createTaskbarWindow(harness)
  window.visible = true
  harness.startIslandPointerTracking(window, 31)
  const oldTimer = harness.scheduler.timers[0]

  harness.startIslandPointerTracking(window, 32)
  const currentTimer = harness.scheduler.timers[1]
  assert.equal(oldTimer.cleared, true)
  oldTimer.callback()
  assert.deepEqual(window.sent, [])

  currentTimer.callback()
  assert.deepEqual(window.sent, [
    {
      channel: harness.ISLAND_POINTER_CHANNEL,
      payload: { presentationRevision: 32, x: 130, y: 40 }
    }
  ])
})

test('stop、hide、closed、render-process-gone 和新 show 都停止采样', () => {
  const stopCases = [
    ['hide request', (api, window) => api.stopIslandPointerTracking(window)],
    ['hide', (_api, window) => window.emit('hide')],
    ['closed', (_api, window) => window.emit('closed')],
    ['render-process-gone', (_api, window) => window.webContents.emit('render-process-gone')],
    ['new show', (api, window) => api.showIslandWindow(window)]
  ]

  for (const [name, stop] of stopCases) {
    const harness = createPointerTrackerHarness()
    const window = createTaskbarWindow(harness)
    window.visible = true
    harness.startIslandPointerTracking(window, 41)
    const timer = harness.scheduler.timers[0]

    stop(harness, window)
    assert.equal(timer.cleared, true, name)
    timer.callback()
    assert.deepEqual(window.sent, [], name)
  }
})

test('窗口隐藏或销毁后停止，非Windows及未显示窗口不启动', () => {
  for (const state of ['hidden', 'destroyed']) {
    const harness = createPointerTrackerHarness()
    const window = createTaskbarWindow(harness)
    window.visible = true
    harness.startIslandPointerTracking(window, 51)
    const timer = harness.scheduler.timers[0]
    if (state === 'hidden') window.visible = false
    else window.destroyed = true

    timer.callback()
    assert.equal(timer.cleared, true, state)
    assert.deepEqual(window.sent, [], state)
  }

  const hiddenHarness = createPointerTrackerHarness()
  const hiddenWindow = createTaskbarWindow(hiddenHarness)
  hiddenHarness.startIslandPointerTracking(hiddenWindow, 52)
  assert.equal(hiddenHarness.scheduler.timers.length, 0)

  const destroyedHarness = createPointerTrackerHarness()
  const destroyedWindow = createTaskbarWindow(destroyedHarness)
  destroyedWindow.visible = true
  destroyedWindow.destroyed = true
  destroyedHarness.startIslandPointerTracking(destroyedWindow, 53)
  assert.equal(destroyedHarness.scheduler.timers.length, 0)

  const nonWindowsHarness = createPointerTrackerHarness('linux')
  const nonWindowsWindow = createTaskbarWindow(nonWindowsHarness)
  nonWindowsWindow.visible = true
  nonWindowsHarness.startIslandPointerTracking(nonWindowsWindow, 54)
  assert.equal(nonWindowsHarness.scheduler.timers.length, 0)
})

test('interactive IPC 拒绝错误 sender、非法布尔值、旧 revision 和 quitting', async () => {
  const invalidCalls = [
    { name: 'sender', senderId: 99, interactive: true, revision: 23 },
    { name: 'boolean', interactive: 'true', revision: 23 },
    { name: 'revision', interactive: true, revision: 22 },
    { name: 'quitting', interactive: true, revision: 23, isQuitting: true }
  ]

  for (const item of invalidCalls) {
    const harness = createInteractiveHandlerHarness({ isQuitting: item.isQuitting })
    const senderId = item.senderId ?? harness.window.webContents.id
    await harness.handler({ sender: { id: senderId } }, item.interactive, item.revision, {
      request: 1
    })
    assert.deepEqual(harness.nativeCalls, [], item.name)
    assert.deepEqual(harness.trackingCalls, [], item.name)
    assert.deepEqual(harness.diagnosticCalls, [], item.name)
  }
})

test('当前 revision 的 taskbar true 启动采样，false 与 island true 停止采样', async () => {
  const cases = [
    { displayMode: 'taskbar', interactive: true, action: 'start' },
    { displayMode: 'taskbar', interactive: false, action: 'stop' },
    { displayMode: 'island', interactive: true, action: 'stop' }
  ]

  for (const item of cases) {
    const harness = createInteractiveHandlerHarness({ displayMode: item.displayMode })
    const revision = harness.context.islandPresentationRevision
    await harness.handler(
      { sender: { id: harness.window.webContents.id } },
      item.interactive,
      revision,
      { request: 1 }
    )

    assert.equal(harness.nativeCalls.length, 1)
    assert.equal(harness.nativeCalls[0].window, harness.window)
    assert.equal(harness.nativeCalls[0].ignore, !item.interactive)
    assert.deepEqual(harness.nativeCalls[0].options, { forward: true })
    assert.equal(harness.trackingCalls.length, 1)
    assert.equal(harness.trackingCalls[0].action, item.action)
    assert.equal(harness.trackingCalls[0].window, harness.window)
    if (item.action === 'start') assert.equal(harness.trackingCalls[0].revision, revision)
    assert.equal(harness.diagnosticCalls.length, 2)
  }
})

test('隐藏 presentation 不修改原生鼠标状态或采样状态', async () => {
  for (const interactive of [true, false]) {
    const harness = createInteractiveHandlerHarness({ visible: false })
    await harness.handler(
      { sender: { id: harness.window.webContents.id } },
      interactive,
      harness.context.islandPresentationRevision,
      undefined
    )
    assert.deepEqual(harness.nativeCalls, [])
    assert.deepEqual(harness.trackingCalls, [])
    assert.equal(harness.diagnosticCalls.length, 1)
  }
})

test('旧 presentation 的 true 和 false 都不能影响新窗口采样', async () => {
  const harness = createInteractiveHandlerHarness()
  const oldWindow = harness.window
  const newWindow = createInteractiveWindow(11, harness.nativeCalls)
  harness.context.islandWindow = newWindow
  harness.context.islandPresentationRevision = 24
  await harness.handler({ sender: { id: 11 } }, true, 24, undefined)
  assert.equal(harness.tracking.activeWindow, newWindow)
  harness.nativeCalls.length = 0
  harness.trackingCalls.length = 0
  harness.diagnosticCalls.length = 0

  for (const interactive of [true, false]) {
    await harness.handler({ sender: { id: oldWindow.webContents.id } }, interactive, 23, undefined)
    await harness.handler({ sender: { id: newWindow.webContents.id } }, interactive, 23, undefined)
  }

  assert.deepEqual(harness.nativeCalls, [])
  assert.deepEqual(harness.trackingCalls, [])
  assert.deepEqual(harness.diagnosticCalls, [])
  assert.equal(harness.tracking.activeWindow, newWindow)
})
