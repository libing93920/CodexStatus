/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { build } from 'esbuild'
import ts from 'typescript'
import {
  resolveIslandLayout,
  resolveIslandModeRect,
  ISLAND_EXPANDED_HEIGHT,
  ISLAND_COMPACT_WIDTH,
  TASKBAR_BUTTON_WIDTH,
  TASKBAR_BUTTON_HEIGHT
} from '../src/shared/island-layout.ts'
import { DEFAULT_ISLAND_VIEWPORT, fitIslandViewport } from '../src/shared/island-viewport.ts'
import { CapsuleWindowDiagnostics } from '../src/main/services/capsule-window-diagnostics.ts'

const sharedBundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/shared/capsule.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false
})
const sharedModuleUrl =
  'data:text/javascript;base64,' + Buffer.from(sharedBundle.outputFiles[0].text).toString('base64')
const { DEFAULT_SETTINGS, DEFAULT_WINDOW_PREFERENCES } = await import(sharedModuleUrl)
const displays = [
  {
    id: 10,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 }
  },
  {
    id: 20,
    bounds: { x: -1920, y: -120, width: 1920, height: 1080 },
    workArea: { x: -1880, y: -120, width: 1880, height: 1040 }
  }
]
const taskbarPlacement = {
  bounds: { x: 0, y: 1040, width: 1920, height: 40 },
  notificationArea: { x: 1800, y: 1040, width: 120, height: 40 },
  dark: true
}

const mainSource = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const mainFile = ts.createSourceFile('index.ts', mainSource, ts.ScriptTarget.Latest, true)
const moduleSource = await readFile(
  new URL('../src/main/windows/island-window.ts', import.meta.url),
  'utf8'
)
const moduleFile = ts.createSourceFile(
  'island-window.ts',
  moduleSource,
  ts.ScriptTarget.Latest,
  true
)
const layoutSource = await readFile(
  new URL('../src/shared/island-layout.ts', import.meta.url),
  'utf8'
)
const layoutCode = ts.transpileModule(layoutSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText
const viewportSource = await readFile(
  new URL('../src/shared/island-viewport.ts', import.meta.url),
  'utf8'
)
const viewportFile = ts.createSourceFile(
  'island-viewport.ts',
  viewportSource,
  ts.ScriptTarget.Latest,
  true
)
const viewportRuntime = viewportFile.statements
  .filter((node) => ts.isVariableStatement(node) || ts.isFunctionDeclaration(node))
  .map((node) => node.getText(viewportFile).replace(/^export\s+/, ''))
  .join('\n')
const viewportCode = ts.transpileModule(viewportRuntime, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText

function findFunction(file, name) {
  return file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name)
}

function extractMainHandlers() {
  const registration = findFunction(mainFile, 'registerIpcHandlers')
  const wanted = new Set([
    'CHANNELS.islandMove',
    'CHANNELS.islandDragFinished',
    'CHANNELS.islandViewport',
    'CHANNELS.islandNudge'
  ])
  const handlers = registration.body.statements.filter(
    (node) =>
      ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression) &&
      wanted.has(node.expression.arguments[0]?.getText(mainFile))
  )
  assert.equal(handlers.length, 4)
  const nudgeStepDeclaration = mainFile.statements.find(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (declaration) => declaration.name.getText(mainFile) === 'ISLAND_NUDGE_STEP'
      )
  )
  assert.ok(nudgeStepDeclaration)
  const nudgeStepValue = Number(
    nudgeStepDeclaration.declarationList.declarations[0].initializer.text
  )
  const channelDeclaration = mainFile.statements.find(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (declaration) => declaration.name.getText(mainFile) === 'CHANNELS'
      )
  )
  const layoutChannelDeclaration = moduleFile.statements.find(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (declaration) => declaration.name.getText(moduleFile) === 'ISLAND_LAYOUT_CHANNEL'
      )
  )
  assert.ok(layoutChannelDeclaration)
  const windowRuntime = moduleFile.statements
    .filter((node) => ts.isVariableStatement(node) || ts.isFunctionDeclaration(node))
    .map((node) => node.getText(moduleFile).replace(/^export\s+/, ''))
  const layoutChannelValue =
    layoutChannelDeclaration.declarationList.declarations[0].initializer.text
  const statements = [
    layoutCode,
    'const { ISLAND_EXPANDED_HEIGHT, ISLAND_SINGLE_TASK_HEIGHT, TASKBAR_BUTTON_WIDTH, TASKBAR_BUTTON_HEIGHT } = exports',
    viewportCode,
    nudgeStepDeclaration.getText(mainFile),
    ...windowRuntime,
    channelDeclaration.getText(mainFile),
    findFunction(mainFile, 'refreshIslandPosition').getText(mainFile),
    findFunction(mainFile, 'getIslandPlacement').getText(mainFile),
    findFunction(mainFile, 'canMoveTaskbarIsland').getText(mainFile),
    findFunction(mainFile, 'createIslandRendererSnapshot').getText(mainFile),
    findFunction(mainFile, 'broadcastIslandSnapshot').getText(mainFile),
    findFunction(mainFile, 'handleIslandTaskbarGeometry').getText(mainFile),
    findFunction(mainFile, 'handleIslandWindowClosed').getText(mainFile),
    findFunction(mainFile, 'shouldShowIsland').getText(mainFile),
    findFunction(mainFile, 'syncIslandWindowVisibility').getText(mainFile),
    findFunction(mainFile, 'setIslandPresentation').getText(mainFile),
    findFunction(mainFile, 'isSelectedDisplayFullscreen').getText(mainFile),
    ...handlers.map((node) => node.getText(mainFile))
  ]
  const code = ts.transpileModule(statements.join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  return { code, layoutChannelValue, nudgeStepValue }
}

const { code: placementHandlers, layoutChannelValue, nudgeStepValue } = extractMainHandlers()

function makeFixture() {
  const callbacks = new Map()
  const counts = { persist: 0, visibility: 0, broadcasts: 0, windowsCreated: 0 }
  const windowActions = []
  const queuedMicrotasks = []
  const cursor = { x: 280, y: 200 }
  const screen = {
    getAllDisplays: () => displays,
    getPrimaryDisplay: () => displays[0],
    getCursorScreenPoint: () => cursor,
    screenToDipRect: (_window, rect) => ({ ...rect })
  }
  const islandWindow = createFakeIslandWindow(42, windowActions)
  const context = {
    module: { exports: {} },
    exports: {},
    ISLAND_COMPACT_WIDTH,
    process: { platform: 'win32' },
    screen,
    ipcMain: {
      handle(channel, callback) {
        callbacks.set(channel, callback)
      }
    },
    islandWindow,
    panelWindow: createFakeIslandWindow(100, windowActions),
    lastIslandBroadcastPayload: undefined,
    recordPerf(event) {
      if (event === 'island:broadcastSent') counts.broadcasts++
    },
    islandLayout: resolveIslandLayout({
      display: displays[0],
      displays,
      displayMode: 'taskbar',
      taskbar: taskbarPlacement,
      taskbarOffsetX: 280
    }),
    islandTaskbarPlacement: taskbarPlacement,
    islandViewport: { ...DEFAULT_ISLAND_VIEWPORT },
    islandPreviousViewports: [],
    islandViewportRevision: 0,
    persistedState: {
      settings: { island: { enabled: true, displayMode: 'taskbar' } },
      window: { ...DEFAULT_WINDOW_PREFERENCES, x: 24, y: 36 },
      taskbarOffsetX: 280
    },
    currentIslandSnapshot: { tasks: [] },
    islandPresentationVisible: true,
    islandRendererReady: true,
    isQuitting: false,
    queueMicrotask: (callback) => queuedMicrotasks.push(callback),
    fullscreenState: { fullscreen: false, monitor: displays[0].bounds },
    fullscreenAlertUntil: 0,
    islandFullscreenSuppressed: false,
    islandPresentationRevision: 1,
    islandWindowDiagnostics: {
      refresh() {
        // 夹具只验证窗口协议，不启动原生任务栏采样。
      }
    },
    islandDiagnostics: {
      record(...fields) {
        windowActions.push(['diagnostic', ...fields])
      }
    },
    logDiag(...fields) {
      windowActions.push(['log', ...fields])
    },
    get queuePersistStateCalls() {
      return counts.persist
    },
    queuePersistState: () => {
      counts.persist++
    },
    get visibilitySyncs() {
      return counts.visibility
    },
    syncIslandWindowVisibility: () => {
      counts.visibility++
    },
    get broadcasts() {
      return counts.broadcasts
    }
  }
  context.ensureIslandWindow = () => {
    if (context.islandWindow && !context.islandWindow.isDestroyed()) return context.islandWindow
    counts.windowsCreated++
    context.islandRendererReady = false
    context.islandPresentationVisible = false
    context.islandWindow = createFakeIslandWindow(42 + counts.windowsCreated, windowActions)
    context.refreshIslandPosition()
    return context.islandWindow
  }
  vm.runInNewContext(placementHandlers, context)
  context.refreshIslandPosition()
  return {
    context,
    callbacks,
    islandWindow,
    cursor,
    windowActions,
    queuedMicrotasks,
    get windowsCreated() {
      return counts.windowsCreated
    },
    flushMicrotasks: () => {
      while (queuedMicrotasks.length) queuedMicrotasks.shift()()
    },
    setNativeVisible: (value) => islandWindow.setNativeVisible(value)
  }
}

function createFakeIslandWindow(id, windowActions) {
  let nativeVisible = false
  let destroyed = false
  const window = new EventEmitter()
  return Object.assign(window, {
    webContents: {
      id,
      sends: [],
      destroyedSendAttempts: 0,
      send(channel, value) {
        if (destroyed) {
          this.destroyedSendAttempts++
          throw new Error('Object has been destroyed')
        }
        this.sends.push({ channel, value })
      },
      setBackgroundThrottling(value) {
        windowActions.push(['backgroundThrottling', value])
      }
    },
    bounds: { x: 0, y: 0, width: TASKBAR_BUTTON_WIDTH, height: TASKBAR_BUTTON_HEIGHT },
    shape: [],
    setShape(rects) {
      this.shape = rects.map((rect) => ({ ...rect }))
      windowActions.push(['setShape', this.shape])
    },
    setBounds(bounds) {
      this.bounds = { ...bounds }
      windowActions.push(['setBounds'])
    },
    getContentBounds() {
      return { ...this.bounds }
    },
    getBounds() {
      return { ...this.bounds }
    },
    getNativeWindowHandle: () => Buffer.alloc(8),
    isFocused: () => false,
    isMinimized: () => false,
    isAlwaysOnTop: () => true,
    isVisible: () => nativeVisible,
    setNativeVisible(value) {
      nativeVisible = value
    },
    showInactive() {
      nativeVisible = true
      windowActions.push(['showInactive'])
    },
    setAlwaysOnTop(...args) {
      windowActions.push(['setAlwaysOnTop', ...args])
    },
    moveTop() {
      windowActions.push(['moveTop'])
    },
    focus() {
      windowActions.push(['focus'])
    },
    setIgnoreMouseEvents(...args) {
      windowActions.push(['ignoreMouseEvents', ...args])
    },
    isDestroyed: () => destroyed,
    destroy() {
      destroyed = true
      nativeVisible = false
      window.emit('closed')
    }
  })
}

function sender(id = 42) {
  return { sender: { id } }
}

function makeViewportRequest(context, overrides = {}) {
  return {
    displayMode: context.persistedState.settings.island.displayMode,
    ...context.islandViewport,
    revision: context.islandViewportRevision + 1,
    presentationRevision: context.islandPresentationRevision,
    phase: 'prepare',
    ...overrides
  }
}

function compactScreenPoint(layout) {
  return {
    x: layout.bounds.x + layout.compact.x,
    y: layout.bounds.y + layout.compact.y
  }
}

test('拖动IPC只接受可见的任务栏按钮偏移，并拒绝非法输入与旧模式', () => {
  const { context, callbacks, cursor } = makeFixture()
  const move = callbacks.get('codex-status:island-move')
  const originalOffset = context.persistedState.taskbarOffsetX

  for (const payload of [
    undefined,
    null,
    {},
    { x: Number.NaN, y: 1 },
    { x: Number.POSITIVE_INFINITY, y: 1 },
    { x: -1, y: 1 },
    { x: 0, y: -1 },
    { x: TASKBAR_BUTTON_WIDTH + 1, y: 0 },
    { x: 0, y: TASKBAR_BUTTON_HEIGHT + 1 }
  ]) {
    move(sender(), payload)
    assert.equal(context.persistedState.taskbarOffsetX, originalOffset)
  }
  move(sender(12), { x: 10, y: 10 })

  context.persistedState.settings.island.enabled = false
  move(sender(), { x: 10, y: 10 })
  context.persistedState.settings.island.enabled = true

  context.persistedState.settings.island.displayMode = 'island'
  move(sender(), { x: 10, y: 10 })
  context.persistedState.settings.island.displayMode = 'taskbar'

  context.islandLayout.displayMode = 'island'
  move(sender(), { x: 10, y: 10 })
  context.islandLayout.displayMode = 'taskbar'

  context.islandPresentationVisible = false
  move(sender(), { x: 10, y: 10 })
  context.islandPresentationVisible = true

  context.islandTaskbarPlacement = undefined
  move(sender(), { x: 10, y: 10 })

  assert.deepEqual(cursor, { x: 280, y: 200 })
  assert.equal(context.persistedState.taskbarOffsetX, originalOffset)
  assert.equal(context.queuePersistStateCalls, 0)
})

test('拖动只改任务栏横偏移，松手时才落盘且指针纵坐标不移动按钮', () => {
  const { context, callbacks, cursor, islandWindow, windowActions, setNativeVisible } =
    makeFixture()
  const move = callbacks.get('codex-status:island-move')
  const finish = callbacks.get('codex-status:island-drag-finished')
  cursor.x = 1000
  cursor.y = -800
  move(sender(), { x: 28, y: TASKBAR_BUTTON_HEIGHT })

  assert.equal(context.persistedState.taskbarOffsetX, 972)
  assert.equal(context.islandLayout.compact.width, TASKBAR_BUTTON_WIDTH)
  assert.equal(context.islandLayout.compact.height, TASKBAR_BUTTON_HEIGHT)
  assert.equal(
    islandWindow.bounds.x + context.islandLayout.compact.x,
    taskbarPlacement.bounds.x + 972
  )
  assert.equal(
    islandWindow.bounds.y + context.islandLayout.compact.y,
    taskbarPlacement.bounds.y + (taskbarPlacement.bounds.height - TASKBAR_BUTTON_HEIGHT) / 2
  )
  assert.equal(context.queuePersistStateCalls, 0)

  const maxOffset = taskbarPlacement.bounds.width - TASKBAR_BUTTON_WIDTH
  cursor.x = -500
  move(sender(), { x: 0, y: 0 })
  assert.equal(context.persistedState.taskbarOffsetX, 0)
  cursor.x = 5000
  move(sender(), { x: 0, y: 0 })
  assert.equal(context.persistedState.taskbarOffsetX, maxOffset)
  assert.equal(
    islandWindow.bounds.y + context.islandLayout.compact.y,
    taskbarPlacement.bounds.y + (taskbarPlacement.bounds.height - TASKBAR_BUTTON_HEIGHT) / 2
  )
  assert.equal(context.queuePersistStateCalls, 0)

  const layoutUpdate = islandWindow.webContents.sends.at(-1)
  assert.equal(layoutUpdate.channel, layoutChannelValue)
  assert.deepEqual(
    { ...layoutUpdate.value.pointer },
    {
      x: cursor.x - islandWindow.bounds.x,
      y: cursor.y - islandWindow.bounds.y
    }
  )
  assert.notDeepEqual({ ...layoutUpdate.value.pointer }, { x: 28, y: TASKBAR_BUTTON_HEIGHT })
  finish(sender(99))
  assert.equal(context.queuePersistStateCalls, 0)

  context.persistedState.settings.island.displayMode = 'island'
  finish(sender())
  context.persistedState.settings.island.displayMode = 'taskbar'
  context.islandPresentationVisible = false
  finish(sender())
  assert.equal(context.queuePersistStateCalls, 0)

  context.islandPresentationVisible = true
  islandWindow.webContents.sends.length = 0
  setNativeVisible(true)
  finish(sender())
  assert.equal(context.queuePersistStateCalls, 1)
  assert.equal(context.broadcasts, 1)
  assert.equal(
    windowActions.some(([action]) => action === 'showInactive'),
    false
  )
  assert.deepEqual(context.persistedState.window, { ...DEFAULT_WINDOW_PREFERENCES, x: 24, y: 36 })
})

test('方向键IPC只允许任务栏按钮左右移动5 DIP，保存沿用拖动提交', () => {
  const { context, callbacks, setNativeVisible } = makeFixture()
  setNativeVisible(true)
  const nudge = callbacks.get('codex-status:island-nudge')
  const finish = callbacks.get('codex-status:island-drag-finished')
  const origin = context.persistedState.taskbarOffsetX
  const invalidDirections = [
    undefined,
    null,
    {},
    { x: '1', y: 0 },
    { x: 0.5, y: 0 },
    { x: 0, y: 0 },
    { x: 1, y: 1 },
    { x: -1, y: 2 },
    { x: 0, y: 1 }
  ]

  for (const direction of invalidDirections) nudge(sender(), direction)
  nudge(sender(99), { x: 1, y: 0 })

  context.persistedState.settings.island.enabled = false
  nudge(sender(), { x: 1, y: 0 })
  context.persistedState.settings.island.enabled = true

  context.persistedState.settings.island.displayMode = 'island'
  nudge(sender(), { x: 1, y: 0 })
  context.persistedState.settings.island.displayMode = 'taskbar'

  context.islandPresentationVisible = false
  nudge(sender(), { x: 1, y: 0 })
  assert.equal(context.persistedState.taskbarOffsetX, origin)

  context.islandPresentationVisible = true
  nudge(sender(), { x: 1, y: 0 })
  assert.equal(context.persistedState.taskbarOffsetX, origin + nudgeStepValue)
  nudge(sender(), { x: -1, y: 0 })
  assert.equal(context.persistedState.taskbarOffsetX, origin)
  assert.equal(context.queuePersistStateCalls, 0)

  finish(sender())
  assert.equal(context.queuePersistStateCalls, 1)
})

test('方向键在任务栏左右边界停住且不改变按钮纵向位置', () => {
  const { context, callbacks } = makeFixture()
  const nudge = callbacks.get('codex-status:island-nudge')
  const maxOffset = taskbarPlacement.bounds.width - TASKBAR_BUTTON_WIDTH
  const buttonY =
    taskbarPlacement.bounds.y + (taskbarPlacement.bounds.height - TASKBAR_BUTTON_HEIGHT) / 2

  context.persistedState.taskbarOffsetX = 0
  context.refreshIslandPosition(false)
  nudge(sender(), { x: -1, y: 0 })
  assert.equal(context.persistedState.taskbarOffsetX, 0)
  nudge(sender(), { x: 1, y: 0 })
  assert.equal(context.persistedState.taskbarOffsetX, nudgeStepValue)
  assert.equal(context.islandLayout.bounds.y + context.islandLayout.compact.y, buttonY)

  context.persistedState.taskbarOffsetX = maxOffset
  context.refreshIslandPosition()
  nudge(sender(), { x: 1, y: 0 })
  assert.equal(context.persistedState.taskbarOffsetX, maxOffset)
  assert.equal(context.islandLayout.bounds.y + context.islandLayout.compact.y, buttonY)
})

test('岛模式固定主屏顶部居中，全屏只匹配主屏', () => {
  const { context } = makeFixture()
  context.screen.getPrimaryDisplay = () => displays[1]
  context.persistedState.settings.island.displayMode = 'island'
  context.refreshIslandPosition()
  const layout = context.islandLayout
  const primary = displays[1]

  assert.equal(context.getIslandDisplay().id, primary.id)
  assert.equal(layout.displayId, primary.id)
  assert.equal(layout.displayMode, 'island')
  assert.equal(layout.compact.width, ISLAND_COMPACT_WIDTH)
  assert.equal(
    layout.bounds.x + layout.compact.x,
    primary.bounds.x + (primary.bounds.width - layout.compact.width) / 2
  )
  assert.equal(layout.bounds.y + layout.compact.y, primary.bounds.y)

  context.fullscreenState = { fullscreen: true, monitor: displays[0].bounds }
  assert.equal(context.isSelectedDisplayFullscreen(), false)
  context.fullscreenState.monitor = primary.bounds
  assert.equal(context.isSelectedDisplayFullscreen(), true)
})

test('两种模式空任务均等待，有任务才显示，并保留几何缺失与全屏优先级', () => {
  const { context } = makeFixture()
  for (const displayMode of ['taskbar', 'island']) {
    context.persistedState.settings.island.displayMode = displayMode
    assert.equal(context.createIslandRendererSnapshot().visibility, 'waiting')
    assert.equal(context.shouldShowIsland(), false)
    context.currentIslandSnapshot.tasks = [{ id: 'active-task' }]
    assert.equal(context.createIslandRendererSnapshot().visibility, 'visible')
    assert.equal(context.shouldShowIsland(), true)
    context.currentIslandSnapshot.tasks = []
  }

  context.persistedState.settings.island.displayMode = 'taskbar'
  context.islandTaskbarPlacement = undefined
  assert.equal(context.createIslandRendererSnapshot().visibility, 'taskbar-unavailable')
  assert.equal(context.shouldShowIsland(), false)

  context.islandTaskbarPlacement = taskbarPlacement
  context.fullscreenState = { fullscreen: true, monitor: displays[0].bounds }
  assert.equal(context.createIslandRendererSnapshot().visibility, 'waiting')
  assert.equal(context.shouldShowIsland(), false)

  context.currentIslandSnapshot.tasks = [{ id: 'active-task' }]
  assert.equal(context.createIslandRendererSnapshot().visibility, 'fullscreen')
  assert.equal(context.shouldShowIsland(), false)

  context.persistedState.settings.island.enabled = false
  assert.equal(context.createIslandRendererSnapshot().visibility, 'disabled')
  assert.equal(context.shouldShowIsland(), false)
})

test('任务栏空任务仍建立隐藏 HWND 采样，几何就绪后等待任务再显示', () => {
  const fixture = makeFixture()
  const { context, windowActions } = fixture
  context.islandWindow = null
  context.islandRendererReady = false
  context.islandPresentationVisible = false
  context.islandTaskbarPlacement = undefined
  windowActions.length = 0

  context.syncIslandWindowVisibility('empty-taskbar')
  const samplingWindow = context.islandWindow
  assert.ok(samplingWindow)
  assert.equal(fixture.windowsCreated, 1)
  assert.equal(samplingWindow.isVisible(), false)
  assert.equal(context.islandPresentationVisible, false)
  assert.equal(context.createIslandRendererSnapshot().visibility, 'taskbar-unavailable')

  context.islandRendererReady = true
  context.handleIslandTaskbarGeometry({ ...taskbarPlacement, visible: true, autoHide: false })
  assert.equal(context.islandWindow, samplingWindow)
  assert.equal(samplingWindow.isVisible(), false)
  assert.equal(context.createIslandRendererSnapshot().visibility, 'waiting')
  assert.equal(
    windowActions.some(([action]) => action === 'showInactive'),
    false
  )

  context.currentIslandSnapshot.tasks = [{ id: 'active-task' }]
  context.syncIslandWindowVisibility('task-started')
  assert.equal(context.islandWindow, samplingWindow)
  assert.equal(samplingWindow.isVisible(), true)
  assert.equal(context.islandPresentationVisible, true)

  context.currentIslandSnapshot.tasks = []
  context.syncIslandWindowVisibility('tasks-cleared')
  assert.equal(context.islandWindow, samplingWindow)
  assert.equal(context.islandPresentationVisible, false)
  assert.equal(samplingWindow.webContents.sends.at(-1).value.visible, false)
  assert.equal(fixture.windowsCreated, 1)
})

test('viewport IPC拒绝坏值、旧presentation、错误sender和隐藏状态', () => {
  const { context, callbacks, islandWindow, windowActions } = makeFixture()
  const setViewport = callbacks.get('codex-status:island-viewport')
  context.islandPresentationRevision = 5
  const request = makeViewportRequest(context, { mode: 'expanded' })
  const originalViewport = { ...context.islandViewport }
  const originalBounds = { ...islandWindow.bounds }
  windowActions.length = 0

  for (const invalid of [
    undefined,
    null,
    { ...request, mode: 'hidden' },
    { ...request, phase: 'done' },
    { ...request, revision: 0 },
    { ...request, presentationRevision: 4 },
    { ...request, displayMode: 'island' },
    { ...request, expandedHeight: Number.NaN },
    { ...request, expandedHeight: ISLAND_EXPANDED_HEIGHT + 1 },
    { ...request, hasSatellite: 'false' }
  ]) {
    assert.equal(setViewport(sender(), invalid), undefined)
  }
  assert.equal(setViewport(sender(99), request), undefined)

  context.persistedState.settings.island.enabled = false
  assert.equal(setViewport(sender(), request), undefined)
  context.persistedState.settings.island.enabled = true
  context.islandPresentationVisible = false
  assert.equal(setViewport(sender(), request), undefined)

  assert.deepEqual({ ...context.islandViewport }, originalViewport)
  assert.equal(context.islandViewportRevision, 0)
  assert.equal(context.islandPreviousViewports.length, 0)
  assert.deepEqual(islandWindow.bounds, originalBounds)
  assert.deepEqual(windowActions, [])
})

for (const displayMode of ['island', 'taskbar']) {
  test(`${displayMode} compact展开收起保持原生画布不动，只改变有效shape`, () => {
    const { context, callbacks, islandWindow, windowActions } = makeFixture()
    context.persistedState.settings.island.displayMode = displayMode
    context.refreshIslandPosition(false)
    context.islandPresentationRevision = 7
    const setViewport = callbacks.get('codex-status:island-viewport')
    const anchor = compactScreenPoint(context.islandLayout)
    const nativeBounds = { ...islandWindow.bounds }
    const compactShape = effectiveShapeScreenRect(islandWindow)
    assert.equal(compactShape.width, displayMode === 'island' ? 300 : TASKBAR_BUTTON_WIDTH)
    assert.equal(compactShape.height, displayMode === 'island' ? 100 : TASKBAR_BUTTON_HEIGHT)
    assertViewportShape(context, islandWindow)
    assertShapeExcludesOutside(islandWindow)
    windowActions.length = 0

    const expand = makeViewportRequest(context, { mode: 'expanded' })
    const preparedExpand = setViewport(sender(), expand)
    assert.ok(preparedExpand)
    const expandedShape = effectiveShapeScreenRect(islandWindow)
    assert.ok(expandedShape.width > compactShape.width)
    assert.ok(expandedShape.height > compactShape.height)
    assert.deepEqual(compactScreenPoint(preparedExpand.layout), anchor)
    assert.deepEqual(
      [...context.islandPreviousViewports].map((state) => ({ ...state })),
      [{ ...DEFAULT_ISLAND_VIEWPORT }]
    )
    assertViewportShape(context, islandWindow)

    const settledExpand = setViewport(sender(), { ...expand, phase: 'settle' })
    assert.ok(settledExpand)
    assert.equal(context.islandPreviousViewports.length, 0)
    assert.deepEqual(effectiveShapeScreenRect(islandWindow), expandedShape)
    assertViewportShape(context, islandWindow)

    const collapse = makeViewportRequest(context, { mode: 'compact' })
    const preparedCollapse = setViewport(sender(), collapse)
    assert.ok(preparedCollapse)
    assert.deepEqual(effectiveShapeScreenRect(islandWindow), expandedShape)
    assert.deepEqual(compactScreenPoint(preparedCollapse.layout), anchor)
    assertViewportShape(context, islandWindow)

    assert.equal(setViewport(sender(), { ...expand, phase: 'settle' }), undefined)
    assert.equal(
      setViewport(sender(), { ...collapse, phase: 'settle', mode: 'expanded' }),
      undefined
    )
    assert.deepEqual(effectiveShapeScreenRect(islandWindow), expandedShape)
    assert.equal(context.islandViewportRevision, collapse.revision)

    const settledCollapse = setViewport(sender(), { ...collapse, phase: 'settle' })
    assert.ok(settledCollapse)
    assert.deepEqual(effectiveShapeScreenRect(islandWindow), compactShape)
    assert.deepEqual(compactScreenPoint(settledCollapse.layout), anchor)
    assert.deepEqual({ ...context.islandViewport }, { ...DEFAULT_ISLAND_VIEWPORT })
    assert.equal(context.islandPreviousViewports.length, 0)
    assert.deepEqual(islandWindow.bounds, nativeBounds)
    assert.equal(windowActions.filter(([action]) => action === 'setBounds').length, 0)
    assert.equal(windowActions.filter(([action]) => action === 'setShape').length, 2)
    assertViewportShape(context, islandWindow)
    assertShapeExcludesOutside(islandWindow)
  })
}

test('重复定位与相同prepare不重复调用setShape', () => {
  const { context, callbacks, islandWindow, windowActions } = makeFixture()
  const nativeBounds = { ...islandWindow.bounds }
  const compactShape = effectiveShapeScreenRect(islandWindow)
  const setViewport = callbacks.get('codex-status:island-viewport')
  windowActions.length = 0
  context.refreshIslandPosition(false)
  context.refreshIslandPosition(false)
  const prepare = makeViewportRequest(context)
  assert.ok(setViewport(sender(), prepare))
  assert.ok(setViewport(sender(), prepare))
  assert.ok(setViewport(sender(), { ...prepare, phase: 'settle' }))
  assert.deepEqual(effectiveShapeScreenRect(islandWindow), compactShape)
  assert.deepEqual(islandWindow.bounds, nativeBounds)
  assert.equal(windowActions.filter(([action]) => action === 'setBounds').length, 0)
  assert.equal(windowActions.filter(([action]) => action === 'setShape').length, 0)
})

test('负坐标主屏切换岛和任务栏模式保持按钮锚点与有效shape一致', () => {
  const { context, callbacks, islandWindow } = makeFixture()
  const primary = displays[1]
  const taskbar = {
    bounds: {
      x: primary.bounds.x,
      y: primary.bounds.y + primary.bounds.height - 40,
      width: primary.bounds.width,
      height: 40
    },
    notificationArea: {
      x: primary.bounds.x + 1800,
      y: primary.bounds.y + primary.bounds.height - 40,
      width: 120,
      height: 40
    }
  }
  context.screen.getPrimaryDisplay = () => primary
  context.islandTaskbarPlacement = taskbar
  const setViewport = callbacks.get('codex-status:island-viewport')
  for (const displayMode of ['taskbar', 'island', 'taskbar']) {
    context.persistedState.settings.island.displayMode = displayMode
    context.islandViewport = { ...DEFAULT_ISLAND_VIEWPORT }
    context.islandPreviousViewports = []
    context.refreshIslandPosition(false)
    const anchor = compactScreenPoint(context.islandLayout)
    assert.deepEqual(anchor, {
      x: primary.bounds.x + (displayMode === 'taskbar' ? 280 : (1920 - ISLAND_COMPACT_WIDTH) / 2),
      y: displayMode === 'taskbar' ? taskbar.bounds.y + 2 : primary.bounds.y
    })
    const nativeBounds = { ...islandWindow.bounds }
    for (const mode of ['expanded', 'compact']) {
      const request = makeViewportRequest(context, { mode })
      assert.ok(setViewport(sender(), request))
      assert.ok(setViewport(sender(), { ...request, phase: 'settle' }))
      assert.deepEqual(compactScreenPoint(context.islandLayout), anchor)
      assert.deepEqual(islandWindow.bounds, nativeBounds)
      assertViewportShape(context, islandWindow)
    }
    assertShapeExcludesOutside(islandWindow)
  }
})

for (const displayMode of ['island', 'taskbar']) {
  for (const modes of [
    ['expanded', 'compact', 'alert'],
    ['compact', 'expanded', 'alert']
  ]) {
    test(`${displayMode} 连续 prepare ${modes.join('→')} 拒绝旧 settle 并保留全部旧内容`, () => {
      const { context, callbacks, islandWindow } = makeFixture()
      const setViewport = callbacks.get('codex-status:island-viewport')
      context.persistedState.settings.island.displayMode = displayMode
      context.islandViewport = {
        mode: modes[0],
        expandedHeight: ISLAND_EXPANDED_HEIGHT,
        hasSatellite: false
      }
      context.refreshIslandPosition(false)
      const contents = [modeScreenRect(context.islandLayout, context.islandViewport)]
      let previousRequest
      let currentRequest
      for (const mode of modes.slice(1)) {
        currentRequest = makeViewportRequest(context, { mode })
        const prepared = setViewport(sender(), currentRequest)
        assert.ok(prepared)
        contents.push(modeScreenRect(prepared.layout, currentRequest))
        for (const content of contents)
          assertInside(effectiveShapeScreenRect(islandWindow), content)
        assertViewportShape(context, islandWindow)
        if (previousRequest) {
          const preparedBounds = { ...islandWindow.bounds }
          assert.equal(setViewport(sender(), { ...previousRequest, phase: 'settle' }), undefined)
          assert.deepEqual(islandWindow.bounds, preparedBounds)
        }
        previousRequest = currentRequest
      }
      const preparedBounds = { ...islandWindow.bounds }
      const preparedShape = effectiveShapeScreenRect(islandWindow)
      const settled = setViewport(sender(), { ...currentRequest, phase: 'settle' })
      assert.ok(settled)
      assert.equal(context.islandPreviousViewports.length, 0)
      assert.deepEqual(islandWindow.bounds, preparedBounds)
      assertInside(effectiveShapeScreenRect(islandWindow), contents.at(-1))
      assert.ok(effectiveShapeScreenRect(islandWindow).height < preparedShape.height)
      assertViewportShape(context, islandWindow)
      assert.deepEqual(modeScreenRect(settled.layout, currentRequest), contents.at(-1))
      const expandedContent = contents[modes.indexOf('expanded')]
      assert.equal(containsRect(effectiveShapeScreenRect(islandWindow), expandedContent), false)
      assertShapeExcludesOutside(islandWindow)
    })
  }
}

function effectiveShapeScreenRect(window) {
  assert.equal(window.shape.length, 1, 'Windows 有效窗口区域必须由 setShape 限定')
  const rect = window.shape[0]
  return { ...rect, x: window.bounds.x + rect.x, y: window.bounds.y + rect.y }
}

function assertViewportShape(context, window) {
  const drawing = resolveIslandLayout({
    display: context.screen.getPrimaryDisplay(),
    displays: context.screen.getAllDisplays(),
    displayMode: context.persistedState.settings.island.displayMode,
    taskbar: context.islandTaskbarPlacement,
    taskbarOffsetX: context.persistedState.taskbarOffsetX
  })
  const expected = fitIslandViewport(
    drawing,
    context.islandViewport,
    context.islandPreviousViewports
  )
  assert.deepEqual(effectiveShapeScreenRect(window), { ...expected.bounds })
  assertInside(window.bounds, effectiveShapeScreenRect(window))
}

function assertShapeExcludesOutside(window) {
  const rect = effectiveShapeScreenRect(window)
  const outside = [
    { x: rect.x - 1, y: rect.y + rect.height / 2 },
    { x: rect.x + rect.width, y: rect.y + rect.height / 2 },
    { x: rect.x + rect.width / 2, y: rect.y - 1 },
    { x: rect.x + rect.width / 2, y: rect.y + rect.height }
  ].filter((point) => pointInside(window.bounds, point))
  assert.ok(outside.length > 0, '稳定画布必须保留有效区域以外的绘图空间')
  for (const point of outside) assert.equal(pointInside(rect, point), false)
}

function pointInside(rect, point) {
  return (
    point.x >= rect.x &&
    point.x < rect.x + rect.width &&
    point.y >= rect.y &&
    point.y < rect.y + rect.height
  )
}

function modeScreenRect(layout, state) {
  const rect = resolveIslandModeRect({ layout, ...state })
  return { ...rect, x: layout.bounds.x + rect.x, y: layout.bounds.y + rect.y }
}

function containsRect(bounds, rect) {
  return (
    rect.x >= bounds.x &&
    rect.y >= bounds.y &&
    rect.x + rect.width <= bounds.x + bounds.width &&
    rect.y + rect.height <= bounds.y + bounds.height
  )
}

function assertInside(bounds, rect) {
  assert.ok(rect.x >= bounds.x, JSON.stringify({ bounds, rect }))
  assert.ok(rect.y >= bounds.y, JSON.stringify({ bounds, rect }))
  assert.ok(rect.x + rect.width <= bounds.x + bounds.width, JSON.stringify({ bounds, rect }))
  assert.ok(rect.y + rect.height <= bounds.y + bounds.height, JSON.stringify({ bounds, rect }))
}

test('全屏退出后恢复置顶且不抢焦点，已显示窗口不重复置顶', () => {
  const { context, islandWindow, windowActions, setNativeVisible } = makeFixture()
  context.currentIslandSnapshot.tasks = [{ id: 'active-task' }]
  context.islandPresentationVisible = false
  windowActions.length = 0

  context.syncIslandWindowVisibility('fullscreen-reset')
  assert.equal(windowActions.filter(([action]) => action === 'showInactive').length, 1)
  assert.equal(windowActions.filter(([action]) => action === 'setAlwaysOnTop').length, 1)
  assert.equal(windowActions.filter(([action]) => action === 'moveTop').length, 1)
  assert.equal(
    windowActions.some(([action]) => action === 'focus'),
    false
  )
  assert.equal(context.islandPresentationVisible, true)

  context.islandPresentationVisible = false
  setNativeVisible(true)
  windowActions.length = 0
  context.syncIslandWindowVisibility('animation-cancelled')
  assert.equal(
    windowActions.some(([action]) => action === 'showInactive'),
    false
  )
  assert.equal(windowActions.filter(([action]) => action === 'setAlwaysOnTop').length, 1)
  assert.equal(windowActions.filter(([action]) => action === 'moveTop').length, 1)
  assert.equal(
    windowActions.some(([action]) => action === 'focus'),
    false
  )

  context.islandPresentationVisible = true
  windowActions.length = 0
  context.syncIslandWindowVisibility('already-visible')
  assert.deepEqual(windowActions, [])
  assert.ok(islandWindow.isVisible())
})

test('真正全屏时隐藏灵动岛，不调整位置或置顶顺序', () => {
  const { context, islandWindow, windowActions } = makeFixture()
  context.currentIslandSnapshot.tasks = [{ id: 'active-task' }]
  context.fullscreenState = { fullscreen: true, monitor: displays[0].bounds }
  const taskbarOffsetX = context.persistedState.taskbarOffsetX
  const bounds = { ...islandWindow.bounds }
  context.islandPresentationVisible = true
  windowActions.length = 0
  islandWindow.webContents.sends.length = 0

  context.syncIslandWindowVisibility('fullscreen')

  assert.equal(context.createIslandRendererSnapshot().visibility, 'fullscreen')
  assert.equal(context.islandPresentationVisible, false)
  assert.equal(context.persistedState.taskbarOffsetX, taskbarOffsetX)
  assert.deepEqual(islandWindow.bounds, bounds)
  assert.equal(
    windowActions.some(([action]) =>
      ['setBounds', 'showInactive', 'setAlwaysOnTop', 'moveTop', 'focus'].includes(action)
    ),
    false
  )
  assert.equal(islandWindow.webContents.sends.at(-1).value.visible, false)
})

test('异常关闭后重建岛窗口，但等待 renderer ready 后才显示', () => {
  const fixture = makeFixture()
  const { context, windowActions } = fixture
  context.currentIslandSnapshot.tasks = [{ id: 'active-task' }]
  const oldWindow = context.islandWindow

  context.handleIslandWindowClosed(oldWindow)
  assert.equal(context.islandWindow, null)
  assert.equal(context.islandRendererReady, false)
  assert.equal(context.islandPresentationVisible, false)
  assert.equal(fixture.queuedMicrotasks.length, 1)
  assert.equal(fixture.windowsCreated, 0)

  fixture.flushMicrotasks()
  const replacement = context.islandWindow
  assert.ok(replacement)
  assert.notEqual(replacement, oldWindow)
  assert.equal(fixture.windowsCreated, 1)
  assert.equal(context.islandRendererReady, false)
  assert.equal(context.islandPresentationVisible, false)
  assert.equal(replacement.isVisible(), false)
  assert.equal(windowActions.filter(([action]) => action === 'showInactive').length, 0)

  context.islandRendererReady = true
  context.syncIslandWindowVisibility('renderer-ready')
  assert.equal(context.islandWindow, replacement)
  assert.equal(context.islandPresentationVisible, true)
  assert.equal(replacement.isVisible(), true)
  assert.equal(windowActions.filter(([action]) => action === 'showInactive').length, 1)
})

for (const scenario of [
  { name: 'stop 清空已有几何后关闭', geometryReady: true, fullscreen: false },
  { name: '首次几何返回前关闭', geometryReady: false, fullscreen: false },
  { name: '全屏期间 stop 后关闭', geometryReady: true, fullscreen: true }
]) {
  test(
    `任务栏 ${scenario.name} 仍重建隐藏采样窗口`,
    { skip: process.platform !== 'win32' },
    (t) => {
      const fixture = makeFixture()
      const { context, islandWindow, windowActions } = fixture
      context.fullscreenState.fullscreen = scenario.fullscreen
      if (!scenario.geometryReady) context.islandTaskbarPlacement = undefined
      observeCloseWithDiagnostics(fixture, t)
      windowActions.length = 0

      islandWindow.destroy()
      assert.equal(context.islandTaskbarPlacement, undefined)
      assert.equal(context.islandWindow, null)
      assert.equal(fixture.windowsCreated, 0)
      assert.equal(islandWindow.webContents.destroyedSendAttempts, 0)
      if (scenario.geometryReady) {
        assert.equal(
          context.panelWindow.webContents.sends.at(-1).value.visibility,
          'taskbar-unavailable'
        )
      }

      fixture.flushMicrotasks()
      const replacement = context.islandWindow
      assert.ok(replacement)
      assert.notEqual(replacement, islandWindow)
      assert.equal(fixture.windowsCreated, 1)
      assert.equal(replacement.isVisible(), false)
      context.islandRendererReady = true
      context.syncIslandWindowVisibility('renderer-ready-before-geometry')
      assert.equal(replacement.isVisible(), false)
      assert.equal(windowActions.filter(([action]) => action === 'showInactive').length, 0)

      context.handleIslandTaskbarGeometry({ ...taskbarPlacement, visible: true, autoHide: false })
      assert.equal(replacement.isVisible(), false)
      assert.equal(context.createIslandRendererSnapshot().visibility, 'waiting')
      if (scenario.fullscreen) {
        context.fullscreenState.fullscreen = false
        context.syncIslandWindowVisibility('fullscreen-exit')
        assert.equal(replacement.isVisible(), false)
      }
    }
  )
}

function observeCloseWithDiagnostics(fixture, t) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill() {
      this.killed = true
    }
  })
  const { context, islandWindow } = fixture
  const diagnostics = new CapsuleWindowDiagnostics(islandWindow, {
    role: 'island',
    canRecover: () => false,
    onTaskbarGeometry: context.handleIslandTaskbarGeometry,
    shouldObserveTaskbar: () => true,
    launch: () => child,
    write: async () => undefined
  })
  context.islandWindowDiagnostics = diagnostics
  islandWindow.on('closed', () => context.handleIslandWindowClosed(islandWindow))
  t.after(() => diagnostics.stop())
}

test('已销毁 island HWND 不发送 snapshot，但 panel 仍收到最新可见性', () => {
  const { context, islandWindow } = makeFixture()
  islandWindow.destroy()
  context.islandTaskbarPlacement = undefined
  assert.doesNotThrow(() => context.broadcastIslandSnapshot())
  assert.equal(islandWindow.webContents.destroyedSendAttempts, 0)
  assert.equal(context.panelWindow.webContents.sends.at(-1).value.visibility, 'taskbar-unavailable')
})

test('disabled、quitting 和岛模式全屏抑制期间不重建，退出全屏后再建', () => {
  const disabled = makeFixture()
  disabled.context.persistedState.settings.island.enabled = false
  disabled.context.handleIslandWindowClosed(disabled.context.islandWindow)
  disabled.flushMicrotasks()
  assert.equal(disabled.context.islandWindow, null)
  assert.equal(disabled.windowsCreated, 0)

  const quitting = makeFixture()
  quitting.context.isQuitting = true
  quitting.context.handleIslandWindowClosed(quitting.context.islandWindow)
  quitting.flushMicrotasks()
  quitting.context.syncIslandWindowVisibility('quit')
  assert.equal(quitting.context.islandWindow, null)
  assert.equal(quitting.windowsCreated, 0)

  const fullscreen = makeFixture()
  fullscreen.context.persistedState.settings.island.displayMode = 'island'
  fullscreen.context.currentIslandSnapshot.tasks = [{ id: 'active-task' }]
  fullscreen.context.fullscreenState = { fullscreen: true, monitor: displays[0].bounds }
  fullscreen.context.handleIslandWindowClosed(fullscreen.context.islandWindow)
  fullscreen.flushMicrotasks()
  assert.equal(fullscreen.context.islandWindow, null)
  assert.equal(fullscreen.windowsCreated, 0)

  fullscreen.context.fullscreenState = { fullscreen: false, monitor: displays[0].bounds }
  fullscreen.context.syncIslandWindowVisibility('fullscreen-exit')
  const replacement = fullscreen.context.islandWindow
  assert.ok(replacement)
  assert.equal(fullscreen.windowsCreated, 1)
  assert.equal(fullscreen.context.islandRendererReady, false)
  assert.equal(replacement.isVisible(), false)

  fullscreen.context.islandRendererReady = true
  fullscreen.context.syncIslandWindowVisibility('renderer-ready')
  assert.equal(replacement.isVisible(), true)
  assert.equal(fullscreen.context.islandPresentationVisible, true)
})

test('迟到的旧窗口 closed 不清理已经重建的 current window', () => {
  const fixture = makeFixture()
  const { context } = fixture
  context.currentIslandSnapshot.tasks = [{ id: 'active-task' }]
  const oldWindow = context.islandWindow

  context.handleIslandWindowClosed(oldWindow)
  fixture.flushMicrotasks()
  const replacement = context.islandWindow
  assert.ok(replacement)

  context.islandRendererReady = true
  context.syncIslandWindowVisibility('renderer-ready')
  assert.equal(replacement.isVisible(), true)
  assert.equal(context.islandPresentationVisible, true)

  context.handleIslandWindowClosed(oldWindow)
  fixture.flushMicrotasks()
  assert.equal(context.islandWindow, replacement)
  assert.equal(context.islandRendererReady, true)
  assert.equal(context.islandPresentationVisible, true)
  assert.equal(fixture.windowsCreated, 1)
})

test('state.json跨重启保留任务栏模式和横偏移，坏偏移会归一化为空', async () => {
  const stateEntry = fileURLToPath(new URL('../src/main/services/state.ts', import.meta.url))
  const stateBundle = await build({
    entryPoints: [stateEntry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    external: ['electron']
  })
  const directory = join(process.env.PI_SCRATCH_DIR, 'island-placement-state')
  const stateModule = { exports: {} }
  const realRequire = createRequire(import.meta.url)
  const electron = { app: { getPath: () => directory } }
  vm.runInNewContext(stateBundle.outputFiles[0].text, {
    module: stateModule,
    exports: stateModule.exports,
    require: (specifier) => (specifier === 'electron' ? electron : realRequire(specifier)),
    process,
    Buffer,
    structuredClone,
    setTimeout,
    clearTimeout
  })

  const state = stateModule.exports
  const taskbarOffsetX = 728
  await state.savePersistedState({
    settings: { ...DEFAULT_SETTINGS, island: { enabled: true, displayMode: 'taskbar' } },
    window: { ...DEFAULT_WINDOW_PREFERENCES, x: 24, y: 36 },
    panel: {},
    taskbarOffsetX
  })
  const afterRestart = await state.loadPersistedState()
  assert.equal(afterRestart.settings.island.enabled, true)
  assert.equal(afterRestart.settings.island.displayMode, 'taskbar')
  assert.equal(afterRestart.taskbarOffsetX, taskbarOffsetX)
  assert.equal(afterRestart.islandPosition, undefined)

  const file = join(directory, 'codex-status-state.json')
  const corrupt = JSON.parse(await readFile(file, 'utf8'))
  corrupt.taskbarOffsetX = 'invalid'
  await writeFile(file, JSON.stringify(corrupt), 'utf8')
  assert.equal((await state.loadPersistedState()).taskbarOffsetX, undefined)
})
