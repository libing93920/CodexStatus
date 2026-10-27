/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { app, BrowserWindow, ipcMain, screen } from 'electron'
import ts from 'typescript'
import {
  assertTaskbarFeedback,
  verifyEntryClickContinuity,
  verifyIslandMorph,
  verifyTaskbarContinuity,
  verifyTaskbarAlertExit,
  waitForIslandAnimations
} from './island-animation-checks.mjs'

const layoutSource = readFileSync(
  new URL('../src/shared/island-layout.ts', import.meta.url),
  'utf8'
)
const layoutModuleSource = ts.transpileModule(layoutSource, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
}).outputText
const viewportSource = readFileSync(
  new URL('../src/shared/island-viewport.ts', import.meta.url),
  'utf8'
)
const viewportModuleSource = ts
  .transpileModule(viewportSource, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
  })
  .outputText.replace(/^import\s+\{[^}]+\}\s+from\s+['"]\.\/island-layout\.ts['"];?\s*/m, '')
const layoutApiSource = `${layoutModuleSource}\n${viewportModuleSource}`
const layoutApi = await import(
  `data:text/javascript;base64,${Buffer.from(layoutApiSource).toString('base64')}`
)
const {
  ISLAND_COMPACT_WIDTH,
  ISLAND_EXPANDED_HEIGHT,
  ISLAND_SINGLE_TASK_HEIGHT,
  TASKBAR_BUTTON_HEIGHT,
  TASKBAR_BUTTON_WIDTH,
  DEFAULT_ISLAND_VIEWPORT,
  fitIslandViewport,
  normalizeIslandViewportRequest,
  resolveIslandDrawingLayout,
  resolveIslandLayout,
  resolveIslandModeRect
} = layoutApi

app.setPath('userData', join(tmpdir(), `codex-status-island-test-${process.pid}`))
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('no-sandbox')
app.on('window-all-closed', () => {})
const forcedScale = Number(process.env.ISLAND_TEST_SCALE)
if (Number.isFinite(forcedScale) && forcedScale > 0) {
  app.commandLine.appendSwitch('force-device-scale-factor', String(forcedScale))
}
if (process.env.ISLAND_TEST_REDUCED_MOTION === '1') {
  app.commandLine.appendSwitch('force-prefers-reduced-motion')
}

const CHANNELS = {
  bootstrap: 'codex-status:bootstrap',
  preferencesUpdated: 'codex-status:preferences-updated',
  islandUpdated: 'codex-status:island-updated',
  islandReady: 'codex-status:island-ready',
  islandPresentation: 'codex-status:island-presentation',
  islandHidden: 'codex-status:island-hidden',
  islandLayout: 'codex-status:island-layout',
  islandPointer: 'codex-status:island-pointer',
  islandViewport: 'codex-status:island-viewport',
  islandMove: 'codex-status:island-move',
  islandNudge: 'codex-status:island-nudge',
  islandDragFinished: 'codex-status:island-drag-finished',
  islandInteractive: 'codex-status:island-interactive',
  islandDiagnostic: 'codex-status:island-diagnostic',
  islandOpenTask: 'codex-status:island-open-task',
  islandDismissTask: 'codex-status:island-dismiss-task'
}
const EXIT_TIMEOUT_MS = 1_500
const POINTER_MOVE_COUNT = 500
const KEYBOARD_NUDGE_STEP = 5
const DRAG_THRESHOLD_DELTA = 8
const LONG_PRESS_GRACE_MS = 600
const CARD_EDGE_GAP = 8
const TASKBAR_HEIGHT = 48
const TASKBAR_NOTIFICATION_AREA_WIDTH = 256
const TASKBAR_NOTIFICATION_GAP = 8
const STATIONARY_POINTER_ID = 74
const VIEWPORT_SETTLE_ATTEMPTS = 80
const ANIMATION_TIMEOUT_MS = 5_000
const ANIMATION_RECT_TOLERANCE = 1
const TASKBAR_SELECTOR = '.taskbar-anchor'
const TASKBAR_POINTER_ID = 1
const TASKBAR_FEEDBACK_SETTLE_MS = 250
const TRANSPARENT_COLOR = 'rgba(0, 0, 0, 0)'
const nativePointerTracker = loadNativePointerTracker()

function loadNativePointerTracker() {
  const path = new URL('../src/main/windows/island-window.ts', import.meta.url)
  const source = readFileSync(path, 'utf8')
  const file = ts.createSourceFile('island-window.ts', source, ts.ScriptTarget.Latest, true)
  const names = ['startIslandPointerTracking', 'stopIslandPointerTracking']
  const runtime = file.statements
    .filter(
      (node) =>
        ts.isVariableStatement(node) ||
        (ts.isFunctionDeclaration(node) && names.includes(node.name?.text))
    )
    .map((node) => node.getText(file).replace(/^export\s+/, ''))
    .join('\n')
  const code = ts.transpileModule(runtime, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  return new Function(
    'screen',
    code + '\nreturn {startIslandPointerTracking, stopIslandPointerTracking}'
  )(screen)
}
const testLogPath = process.env.ISLAND_TEST_LOG
const screenshotDirectory = process.env.ISLAND_TEST_SCREENSHOT_DIR

function testLog(stage) {
  if (!testLogPath) return
  appendFileSync(testLogPath, `${new Date().toISOString()} ${stage}\n`)
}

let openedThread
let taskOpenRequestCount = 0
let taskOpenConfirmed = true
let ready
let resolveHidden
let hiddenRevision
let interactions = []
let readyCount = 0
let presentationRevision = 0
let currentPresentation = { revision: 0, visible: false }
let islandDiagnosticsEnabled = true
const diagnosticBatches = []
let rendererFailure
let fixtureDisplay
let fixtureTaskbar
let fixtureTaskbarOffsetX
let fixtureLayout
let fixtureViewport = { ...DEFAULT_ISLAND_VIEWPORT }
let fixturePreviousViewports = []
let fixtureViewportRevision = 0
let fixtureSettings = { island: { enabled: true, displayMode: 'island' } }
let fixtureWindow
let fixturePointerScreen
let fixtureViewportBlocker
const fixtureWindowRegions = new WeakMap()
const islandMoveRequests = []
const islandNudgeRequests = []
let islandDragFinishedCount = 0
const readyPromise = new Promise((resolveReady) => (ready = resolveReady))

function intersectRects(left, right) {
  const x = Math.max(left.x, right.x)
  const y = Math.max(left.y, right.y)
  const farX = Math.min(left.x + left.width, right.x + right.width)
  const farY = Math.min(left.y + left.height, right.y + right.height)
  return { x, y, width: farX - x, height: farY - y }
}

async function verifyIslandWindow() {
  testLog('verify:start')
  await app.whenReady()
  testLog('verify:app-ready')
  const primary = screen.getPrimaryDisplay()
  const displayBounds = { ...primary.bounds }
  const reportedWorkArea = { ...primary.workArea }
  // 150% 强制缩放探针已观测到 Electron 的 bounds 缩小而 workArea 未同步；交集只用于受控 renderer fixture。
  const workArea = forcedScale ? intersectRects(displayBounds, reportedWorkArea) : reportedWorkArea
  fixtureDisplay = {
    id: primary.id,
    bounds: displayBounds,
    workArea
  }
  const taskbarY = displayBounds.y + displayBounds.height - TASKBAR_HEIGHT
  const notificationAreaWidth = Math.min(TASKBAR_NOTIFICATION_AREA_WIDTH, displayBounds.width)
  fixtureTaskbar = {
    bounds: {
      x: displayBounds.x,
      y: taskbarY,
      width: displayBounds.width,
      height: TASKBAR_HEIGHT
    },
    notificationArea: {
      x: displayBounds.x + displayBounds.width - notificationAreaWidth,
      y: taskbarY,
      width: notificationAreaWidth,
      height: TASKBAR_HEIGHT
    },
    dark: true
  }
  fixtureTaskbarOffsetX = undefined
  fixtureViewport = { ...DEFAULT_ISLAND_VIEWPORT }
  fixturePreviousViewports = []
  fixtureViewportRevision = 0
  fixtureSettings = { island: { enabled: true, displayMode: 'island' } }
  fixtureLayout = resolveFixtureViewportLayout()
  islandMoveRequests.length = 0
  islandNudgeRequests.length = 0
  islandDragFinishedCount = 0
  registerHandlers()
  testLog('verify:handlers')
  const window = new BrowserWindow({
    ...fixtureLayout.bounds,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    thickFrame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    autoHideMenuBar: true,
    focusable: true,
    webPreferences: {
      preload: resolve('out/preload/index.js'),
      sandbox: false,
      backgroundThrottling: false
    }
  })
  setFixtureLayout(window)
  window.setAlwaysOnTop(true, 'screen-saver')
  window.setIgnoreMouseEvents(true)
  fixtureWindow = window
  const rendererListeners = attachRendererFailureListeners(window)
  try {
    const windowBounds = window.getBounds()
    const nativeTolerance = forcedScale ? 1 : 0
    assert.ok(Math.abs(windowBounds.width - fixtureLayout.bounds.width) <= nativeTolerance)
    assert.ok(Math.abs(windowBounds.height - fixtureLayout.bounds.height) <= nativeTolerance)
    if (forcedScale) {
      assert.equal(screen.getPrimaryDisplay().scaleFactor, forcedScale)
      console.log(
        JSON.stringify({ forcedScale, windowBounds, display: screen.getPrimaryDisplay().bounds })
      )
    }
    await window.loadFile(resolve('out/renderer/index.html'), { query: { window: 'island' } })
    testLog('verify:loaded')
    await Promise.race([readyPromise, timeout(3_000)])
    testLog('verify:ready')
    const contentSize = await window.webContents.executeJavaScript(
      '({ width: innerWidth, height: innerHeight })'
    )
    assert.deepEqual(contentSize, {
      width: fixtureLayout.bounds.width,
      height: fixtureLayout.bounds.height
    })

    if (process.env.ISLAND_TEST_TASKBAR_ONLY === '1') {
      await verifyTaskbarMode(window)
      return
    }

    if (process.env.ISLAND_TEST_REDUCED_MOTION === '1') {
      const reducedMotion = await window.webContents.executeJavaScript(
        "window.matchMedia('(prefers-reduced-motion: reduce)').matches"
      )
      assert.equal(reducedMotion, true)
      sendPresentation(window, true)
      await retry(async () => assert.equal((await inspect(window)).mode, 'compact'))
      await verifyInteractionRegression(window, true)
      const hidden = waitForHidden()
      const startedAt = Date.now()
      const revision = sendPresentation(window, false)
      await hidden
      assert.equal(hiddenRevision, revision)
      assert.ok(Date.now() - startedAt < 250)
      islandDiagnosticsEnabled = false
      await verifyRecreate(window, false)
      await verifyInteractionRegression(window, false)
      await verifyMorphAnimations(window)
      await verifyViewportHideInterruptions(window)
      await verifyViewportModeInterruptions(window)
      await verifyTaskbarMode(window)
      const finalHidden = waitForHidden()
      const finalRevision = sendPresentation(window, false)
      await finalHidden
      assert.equal(hiddenRevision, finalRevision)
      return
    }

    assert.deepEqual(targetLayout(await inspect(window)), {
      mode: 'hidden',
      width: '104px',
      height: '28px',
      expandedHeight: '200px',
      taskRows: 1,
      scrollable: false
    })

    await verifyEntryClickContinuity({
      window,
      present: () => sendPresentation(window, true),
      click: () => dispatchNativeClickAt(window, '.compact'),
      label: 'island'
    })
    await sendEscape(window)
    await waitForIslandAnimations(window, 'compact')
    assert.deepEqual(targetLayout(await inspect(window)), {
      mode: 'compact',
      width: '248px',
      height: '48px',
      expandedHeight: '200px',
      taskRows: 1,
      scrollable: false
    })
    const initialCompact = await inspect(window)
    assert.equal(initialCompact.displayMode, 'island')
    assert.equal(initialCompact.islandBackground, 'rgb(0, 0, 0)')
    assert.equal(initialCompact.islandRect.width, ISLAND_COMPACT_WIDTH)
    assertRectMatches(initialCompact.compactRect, fixtureLayout.compact)
    await saveEdgeScreenshot(window, 'compact')
    const runningCompact = await inspect(window)
    assert.deepEqual(runningCompact.waveformAnimationNames, ['wave', 'wave', 'wave', 'wave'])
    assert.deepEqual(runningCompact.waveformAnimationDurations, ['1.1s', '1.1s', '1.1s', '1.1s'])
    assert.deepEqual(runningCompact.waveformAnimationStates, [
      'running',
      'running',
      'running',
      'running'
    ])
    assert.equal(runningCompact.waveformActiveAnimationCount, 4)
    assert.deepEqual(runningCompact.waveformStatuses, ['running'])
    await dispatchPointerMoveAt(window, '.compact')
    await retry(() => assert.equal(interactions.at(-1), true))
    await dispatchPointerMoveOutside(window)
    await retry(() => assert.equal(interactions.at(-1), false))
    await verifyStableCompactUpdates(window)
    await verifyPointerMoveDiagnostics(window)
    await verifyInteractionRegression(window, true)

    await verifyMorphAnimations(window)
    await verifyViewportHideInterruptions(window)
    await verifyViewportModeInterruptions(window)
    testLog('verify:morph-animations')

    window.webContents.send(CHANNELS.islandUpdated, snapshot('waiting-approval'))
    await delay(700)
    const alert = await inspect(window)
    assert.deepEqual(targetLayout(alert), {
      mode: 'alert',
      width: '396px',
      height: '198px',
      expandedHeight: '200px',
      taskRows: 1,
      scrollable: false
    })
    assert.equal(alert.transition, '0.62s, 0.62s, 0.62s, 0.62s, 0.62s, 0.62s, 0.16s')
    assert.equal(alert.fontFamily.includes('SF Pro Text'), true)
    assert.equal(alert.islandBackground, 'rgb(0, 0, 0)')
    assert.equal(alert.bodyBackground, 'rgba(0, 0, 0, 0)')
    assert.equal(alert.brandFill, 'rgb(245, 245, 247)')
    assert.equal(alert.brandWidth, '23px')
    assert.notEqual(alert.satelliteIconFill, 'none')
    assert.equal(alert.statusColor, 'rgb(255, 159, 10)')
    await dispatchPointerEnterAt(window, '.alert')
    window.webContents.send(CHANNELS.islandUpdated, snapshot('running'))
    await retry(async () => {
      const status = await window.webContents.executeJavaScript(
        "document.querySelector('.alert .activity-header > span:last-child').textContent"
      )
      assert.equal(status, '执行中')
      assert.equal((await inspect(window)).mode, 'alert')
    })
    const removed = snapshot('waiting-input')
    removed.tasks[0].requests[0].id = 'removed-input'
    window.webContents.send(CHANNELS.islandUpdated, removed)
    await retry(async () => assert.equal((await inspect(window)).mode, 'alert'))
    window.webContents.send(CHANNELS.islandUpdated, snapshot('running', 0))
    await retry(async () => assert.equal((await inspect(window)).mode, 'compact'))
    const resumed = snapshot('waiting-approval')
    resumed.tasks[0].requests[0].id = 'resumed-approval'
    window.webContents.send(CHANNELS.islandUpdated, resumed)
    await retry(async () => assert.equal((await inspect(window)).mode, 'alert'))
    await dispatchPointerLeave(window)
    await window.webContents.executeJavaScript(`(() => {
      const style = document.createElement('style')
      style.id = 'geometry-probe'
      style.textContent = '.island, .satellite { transition: none !important; }'
      document.head.append(style)
    })()`)
    await window.webContents.executeJavaScript(
      "document.querySelectorAll('.alert-footer button')[0].click()"
    )
    assert.equal(openedThread, 'thread-1')
    await window.webContents.executeJavaScript("document.querySelector('.compact').click()")
    await delay(700)
    const expanded = await inspect(window)
    assert.deepEqual(targetLayout(expanded), {
      mode: 'expanded',
      width: '412px',
      height: '200px',
      expandedHeight: '200px',
      taskRows: 1,
      scrollable: false
    })
    assert.equal(Math.round(expanded.width), 412)
    assert.equal(Math.round(expanded.height), 200)
    const pixels = await inspectPixels(window)
    const captureScale = forcedScale || 1
    assert.deepEqual(pixels.size, {
      width: Math.round(fixtureLayout.bounds.width * captureScale),
      height: Math.round(fixtureLayout.bounds.height * captureScale)
    })
    assert.ok(pixels.centerAlpha > 0)
    assert.equal(pixels.cornerAlpha, 0)

    window.webContents.send(CHANNELS.islandUpdated, snapshot('running', 2))
    await delay(700)
    assert.equal((await inspect(window)).expandedHeight, '281px')
    window.webContents.send(CHANNELS.islandUpdated, snapshot('running', 4))
    await delay(700)
    const runningExpanded = await inspect(window)
    assert.deepEqual(targetLayout(runningExpanded), {
      mode: 'expanded',
      width: '412px',
      height: '362px',
      expandedHeight: '362px',
      taskRows: 4,
      scrollable: true
    })
    assert.equal(runningExpanded.hasTaskHoverRule, false)
    assert.equal(runningExpanded.hasTaskFocusRule, true)
    assert.deepEqual(runningExpanded.taskWaveforms, [
      {
        status: 'running',
        animationNames: ['wave', 'wave', 'wave', 'wave'],
        animationStates: ['running', 'running', 'running', 'running'],
        activeAnimationCount: 4
      },
      {
        status: 'running',
        animationNames: ['wave', 'wave', 'wave', 'wave'],
        animationStates: ['running', 'running', 'running', 'running'],
        activeAnimationCount: 4
      },
      {
        status: 'running',
        animationNames: ['wave', 'wave', 'wave', 'wave'],
        animationStates: ['running', 'running', 'running', 'running'],
        activeAnimationCount: 4
      },
      {
        status: 'running',
        animationNames: ['wave', 'wave', 'wave', 'wave'],
        animationStates: ['running', 'running', 'running', 'running'],
        activeAnimationCount: 4
      }
    ])

    await saveEdgeScreenshot(window, 'expanded')
    await verifyExit(window)
    testLog('verify:exit')
    await verifyStaleAndRevive(window)
    testLog('verify:revive')
    await verifyInteractions(window)
    testLog('verify:interactions')
    await verifyAlertRules(window)
    testLog('verify:alerts')
    await verifyTaskbarMode(window)
    testLog('verify:taskbar-mode')
    for (let cycle = 0; cycle < 3; cycle++) {
      await verifyRecreate(window)
      testLog(`verify:recreate:${cycle + 1}`)
    }
    verifyDiagnosticProtocol()
    await verifyDiagnosticsDisabled(window)
  } finally {
    detachRendererFailureListeners(window, rendererListeners)
    window.destroy()
    fixtureWindow = undefined
  }
}

async function verifyExit(window) {
  const before = diagnosticEvents().length
  const hidden = waitForHidden()
  const revision = sendPresentation(window, false)
  window.webContents.send(CHANNELS.islandUpdated, snapshot('running', 0))
  await delay(50)
  assert.equal((await inspect(window)).taskRows, 4)
  await hidden
  assert.equal(hiddenRevision, revision)
  await retry(() => {
    const exit = diagnosticEvents()
      .slice(before)
      .find((event) => event.event === 'effect' && event.fields?.reason === 'expanded-exit')
    assert.ok(exit)
    assert.equal(exit.fields.to, 'hidden')
    assert.equal(exit.fields.revision, revision)
    assert.ok(exit.fields.expandedAge >= 0)
  })
}

async function verifyViewportHideInterruptions(window) {
  for (const phase of ['prepare', 'settle']) {
    testLog(`viewport-hide:${phase}:start`)
    window.webContents.send(CHANNELS.islandUpdated, snapshot('running'))
    sendPresentation(window, true)
    await waitForMode(window, 'compact')
    const blocker = holdNextViewportRequest(phase)
    try {
      await dispatchClickAt(window, '.compact')
      await Promise.race([blocker.received, timeout(3_000)])
      assert.equal((await inspect(window)).viewportRebasing, true)
      const hidden = waitForHidden()
      const revision = sendPresentation(window, false)
      await retry(async () => assert.equal((await inspect(window)).mode, 'hidden'))
      const exiting = await inspect(window)
      assert.equal(exiting.viewportRebasing, false, `hide while waiting for ${phase}`)
      if (process.env.ISLAND_TEST_REDUCED_MOTION !== '1') {
        assert.notEqual(exiting.transition, '0s', `${phase}: exit transition disabled`)
      }
      await hidden
      assert.equal(hiddenRevision, revision)
      testLog(`viewport-hide:${phase}:hidden`)
    } finally {
      blocker.release()
    }
  }
  sendPresentation(window, true)
  await waitForMode(window, 'compact')
}

async function verifyViewportModeInterruptions(window) {
  for (const phase of ['prepare', 'settle']) {
    testLog(`viewport-mode:${phase}:start`)
    window.webContents.send(CHANNELS.islandUpdated, snapshot('running'))
    await waitForMode(window, 'compact')
    await dispatchClickAt(window, '.compact')
    await waitForMode(window, 'expanded')
    const blocker = holdNextViewportRequest(phase)
    try {
      await sendEscape(window)
      await Promise.race([blocker.received, timeout(3_000)])
      assert.equal((await inspect(window)).viewportRebasing, true)
      await setFixtureDisplayMode(window, 'taskbar')
      blocker.release()
      await waitForMode(window, 'compact')
      assert.equal((await inspect(window)).displayMode, 'taskbar')
      testLog(`viewport-mode:${phase}:switched`)
    } finally {
      blocker.release()
    }
    await setFixtureDisplayMode(window, 'island')
    await waitForMode(window, 'compact')
  }
}

function holdNextViewportRequest(phase) {
  let received
  let release
  const observed = new Promise((resolveReceived) => (received = resolveReceived))
  const released = new Promise((resolveRelease) => (release = resolveRelease))
  fixtureViewportBlocker = { phase, received, released }
  return { received: observed, release }
}

async function verifyInteractionRegression(window, diagnosticsEnabled) {
  await waitForMode(window, 'compact')
  await delay(100)
  const diagnosticStart = diagnosticEvents().length
  const lifecycleEffectsBefore = islandLifecycleEffectCount()

  await dispatchPointerEnterAt(window, '.compact')
  await retry(() => assert.equal(interactions.at(-1), true))
  await installGeometryProbe(window)
  await resetGeometryProbe(window)
  await dispatchPointerLeave(window)
  const leaveGeometryReads = await readGeometryProbe(window)
  await removeGeometryProbe(window)
  if (diagnosticsEnabled) assert.ok(leaveGeometryReads > 0)
  else assert.equal(leaveGeometryReads, 0)
  await retry(() => assert.equal(interactions.at(-1), false))

  const duplicateStart = interactions.length
  await dispatchPointerEnterAt(window, '.compact')
  await dispatchPointerEnterAt(window, '.compact')
  await dispatchPointerMoveAt(window, '.compact')
  await retry(() => assert.equal(interactions.at(-1), true))
  await delay(50)
  assert.deepEqual(interactions.slice(duplicateStart), [true])

  const expandedStart = interactions.length
  await dispatchClickAt(window, '.compact')
  await waitForMode(window, 'expanded')
  await delay(100)
  assert.equal(interactions.slice(expandedStart).includes(false), false)

  for (const count of [2, 4]) {
    window.webContents.send(CHANNELS.islandUpdated, snapshot('running', count))
    await retry(async () => {
      const current = await inspect(window)
      assert.equal(current.mode, 'expanded')
      assert.equal(current.taskRows, count)
      assert.equal(current.viewportRebasing, false)
    }, VIEWPORT_SETTLE_ATTEMPTS)
    assert.equal(interactions.slice(expandedStart).includes(false), false)
  }

  const waitingInput = snapshot('waiting-input')
  waitingInput.viewedEventIds = ['request-input']
  window.webContents.send(CHANNELS.islandUpdated, waitingInput)
  await retry(async () => {
    const current = await inspect(window)
    assert.equal(current.mode, 'expanded')
    assert.equal(current.stageMultiple, 'true')
    assert.equal(current.viewportRebasing, false)
  }, VIEWPORT_SETTLE_ATTEMPTS)
  assert.equal(interactions.slice(expandedStart).includes(false), false)
  assert.equal(islandLifecycleEffectCount(), lifecycleEffectsBefore)

  await dispatchPointerLeave(window)
  await waitForMode(window, 'compact')
  await retry(() => assert.equal(interactions.at(-1), false))

  await dispatchClickAt(window, '.compact')
  await waitForMode(window, 'expanded')
  await window.webContents.executeJavaScript(
    "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))"
  )
  await waitForMode(window, 'compact')

  await dispatchPointerLeave(window)
  await retry(() => assert.equal(interactions.at(-1), false))
  const staleInteractionStart = interactions.length
  await installAnimationFrameProbe(window)
  await dispatchPointerMoveAt(window, '.compact')
  const hidden = waitForHidden()
  const revision = sendPresentation(window, false)
  await hidden
  assert.equal(hiddenRevision, revision)
  const frameProbe = await removeAnimationFrameProbe(window)
  assert.equal(frameProbe.pending, 0)
  assert.ok(frameProbe.cancelled > 0)
  assert.equal(interactions.slice(staleInteractionStart).includes(true), false)

  // 再次显示会从原生窗口查询新坐标；把实际指针移到窗外以区分旧排队事件。
  const hiddenBounds = window.getContentBounds()
  fixturePointerScreen = { x: hiddenBounds.x, y: hiddenBounds.y + hiddenBounds.height + 10 }
  sendPresentation(window, true)
  await waitForMode(window, 'compact')
  assert.equal(interactions.slice(staleInteractionStart).includes(true), false)

  window.webContents.send(CHANNELS.islandUpdated, snapshot('running'))
  await retry(async () => {
    const current = await inspect(window)
    assert.equal(current.mode, 'compact')
    assert.equal(current.stageMultiple, 'false')
    assert.equal(current.viewportRebasing, false)
  }, VIEWPORT_SETTLE_ATTEMPTS)
  await delay(100)

  const regressionEvents = diagnosticEvents().slice(diagnosticStart)
  if (!diagnosticsEnabled) {
    assert.equal(regressionEvents.length, 0)
    return
  }
  assert.ok(
    regressionEvents.some(
      (event) =>
        event.event === 'interactive' &&
        typeof event.fields?.interactive === 'boolean' &&
        typeof event.fields?.previousInteractive === 'boolean' &&
        typeof event.fields?.pendingHitTest === 'boolean' &&
        typeof event.fields?.pointValid === 'boolean'
    )
  )
  const expanded = regressionEvents.filter(
    (event) => event.event === 'mode-commit' && event.fields?.to === 'expanded'
  )
  assert.equal(expanded.length, 2)
  assert.ok(expanded[1].fields.expansion > expanded[0].fields.expansion)
  for (const commit of expanded) {
    assert.ok(commit.fields.expandedAge >= 0)
    const exit = regressionEvents.find(
      (event) =>
        event.fields?.reason === 'expanded-exit' &&
        event.fields.expansion === commit.fields.expansion
    )
    assert.ok(exit)
    assert.equal(exit.fields.to, 'compact')
    assert.ok(exit.fields.expandedAge >= commit.fields.expandedAge)
  }
  assert.ok(
    regressionEvents.some(
      (event) =>
        event.event === 'pointer' &&
        event.fields?.reason === 'pointer-leave' &&
        typeof event.fields?.hitInside === 'boolean' &&
        typeof event.fields?.domInside === 'boolean' &&
        typeof event.fields?.relatedInside === 'boolean'
    )
  )
}

async function verifyStaleAndRevive(window) {
  window.webContents.send(CHANNELS.islandUpdated, snapshot('running', 1))
  sendPresentation(window, true)
  await delay(700)
  assert.equal((await inspect(window)).mode, 'compact')

  const hidden = waitForHidden()
  const staleRevision = sendPresentation(window, false)
  await delay(100)
  sendPresentation(window, true)
  await delay(EXIT_TIMEOUT_MS)
  assert.equal((await inspect(window)).mode, 'compact')
  assert.notEqual(hiddenRevision, staleRevision)
  clearHiddenWaiter(hidden)
}

async function verifyAlertRules(window) {
  testLog('alerts:start')
  sendPresentation(window, true)
  await delay(700)
  testLog('alerts:shown')
  window.webContents.send(CHANNELS.islandUpdated, snapshot('completed', 1, '-auto'))
  await delay(900)
  testLog('alerts:completed-auto')
  assert.equal((await inspect(window)).mode, 'alert')
  await window.webContents.executeJavaScript(
    "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))"
  )
  await delay(700)
  assert.equal((await inspect(window)).mode, 'compact')
  await window.webContents.executeJavaScript("document.querySelector('.compact').click()")
  await delay(700)
  assert.equal((await inspect(window)).mode, 'expanded')
  await delay(3_200)
  testLog('alerts:auto-collapsed')
  assert.equal((await inspect(window)).mode, 'compact')
  const legacyReminderFire = lastDiagnosticEvent(
    (event) =>
      event.event === 'reminder' &&
      event.fields?.reason === 'fire' &&
      event.fields?.modeRef === 'expanded'
  )
  assert.ok(legacyReminderFire)
  const legacyFireIndex = diagnosticEvents().lastIndexOf(legacyReminderFire)
  const legacyRequest = diagnosticEvents().find(
    (event, index) =>
      index > legacyFireIndex &&
      event.event === 'mode-request' &&
      event.fields?.to === 'compact' &&
      event.fields?.reason === 'reminder-fired'
  )
  assert.ok(legacyRequest)
  const legacyRequestIndex = diagnosticEvents().indexOf(legacyRequest)
  assert.ok(
    diagnosticEvents().some(
      (event, index) =>
        index > legacyRequestIndex &&
        event.event === 'mode-commit' &&
        event.fields?.from === 'expanded' &&
        event.fields?.to === 'compact'
    )
  )

  window.webContents.send(CHANNELS.islandUpdated, snapshot('completed', 1, '-view'))
  await delay(900)
  testLog('alerts:completed-view')
  assert.equal((await inspect(window)).mode, 'alert')
  await window.webContents.executeJavaScript(
    "document.querySelector('.alert-footer button:last-of-type').click()"
  )
  await delay(700)
  testLog('alerts:completed-hidden')
  assert.equal((await inspect(window)).mode, 'compact')

  await verifyFailedTaskViewing(window)

  sendPresentation(window, true)
  await delay(700)
  testLog('alerts:re-shown')
  window.webContents.send(CHANNELS.islandUpdated, snapshot('running'))
  await delay(700)
  testLog('alerts:running')
  assert.equal((await inspect(window)).mode, 'compact')
  window.webContents.send(CHANNELS.islandUpdated, snapshot('stopped'))
  await delay(700)
  testLog('alerts:stopped')
  assert.equal((await inspect(window)).mode, 'compact')

  window.webContents.send(CHANNELS.islandUpdated, snapshot('running'))
  await delay(700)
  testLog('alerts:running-final')
  sendPresentation(window, false)
  await delay(500)
  testLog('alerts:end')
}

async function verifyFailedTaskViewing(window) {
  for (const view of ['alert', 'expanded']) {
    window.webContents.send(CHANNELS.islandUpdated, snapshot('failed', 1, `-view-${view}`))
    await retry(async () => assert.equal((await inspect(window)).mode, 'alert'))
    if (view === 'expanded') {
      await window.webContents.executeJavaScript(
        "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))"
      )
      await retry(async () => assert.equal((await inspect(window)).mode, 'compact'))
      await window.webContents.executeJavaScript("document.querySelector('.compact').click()")
      await retry(async () => assert.equal((await inspect(window)).mode, 'expanded'))
    }
    const selector = view === 'alert' ? '.alert-footer button:last-of-type' : '.task-list .task'
    taskOpenConfirmed = false
    await window.webContents.executeJavaScript(`document.querySelector('${selector}').click()`)
    await delay(700)
    assert.equal((await inspect(window)).mode, view)
    taskOpenConfirmed = true
    await window.webContents.executeJavaScript(`document.querySelector('${selector}').click()`)
    await retry(async () => assert.equal((await inspect(window)).mode, 'compact'))
    assert.equal(openedThread, 'thread-1')
    testLog(`alerts:failed-${view}-viewed`)
  }

  window.webContents.send(CHANNELS.islandUpdated, snapshot('failed', 1, '-dismiss'))
  await retry(async () => assert.equal((await inspect(window)).mode, 'alert'))
  await window.webContents.executeJavaScript(
    "document.querySelector('.alert-footer button:first-of-type').click()"
  )
  await retry(async () => assert.equal((await inspect(window)).mode, 'compact'))
  testLog('alerts:failed-dismissed')
}

async function verifyRecreate(window, expectDiagnostics = true) {
  const previousReadyCount = readyCount
  const previousDiagnosticCount = diagnosticEvents().length
  const loaded = new Promise((resolveLoad) =>
    window.webContents.once('did-finish-load', resolveLoad)
  )
  window.webContents.reload()
  await loaded
  await retry(() => assert.ok(readyCount > previousReadyCount))
  sendPresentation(window, true)
  await retry(async () => assert.equal((await inspect(window)).mode, 'compact'))
  if (expectDiagnostics) {
    await retry(() => assert.ok(diagnosticEvents().length > previousDiagnosticCount))
  }
}

function attachRendererFailureListeners(window) {
  rendererFailure = undefined
  const onGone = (_event, details) => {
    if (details.reason === 'clean-exit') return
    rememberRendererFailure(
      new Error(`Island renderer exited: ${details.reason ?? 'unknown'} ${details.exitCode ?? ''}`)
    )
  }
  const onConsoleMessage = ({ level, message, lineNumber, sourceId }) => {
    if (level !== 'error') return
    rememberRendererFailure(
      new Error(`Island renderer console error: ${message} (${sourceId}:${lineNumber})`)
    )
  }
  const onFailLoad = (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return
    rememberRendererFailure(
      new Error(`Island renderer load failed: ${errorCode} ${errorDescription} ${validatedURL}`)
    )
  }
  window.webContents.on('render-process-gone', onGone)
  window.webContents.on('console-message', onConsoleMessage)
  window.webContents.on('did-fail-load', onFailLoad)
  return { onGone, onConsoleMessage, onFailLoad }
}

function detachRendererFailureListeners(window, listeners) {
  window.webContents.removeListener('render-process-gone', listeners.onGone)
  window.webContents.removeListener('console-message', listeners.onConsoleMessage)
  window.webContents.removeListener('did-fail-load', listeners.onFailLoad)
}

function rememberRendererFailure(error) {
  rendererFailure ??= error
}

function assertRendererHealthy() {
  if (rendererFailure) throw rendererFailure
}

function islandLifecycleEffectCount() {
  return diagnosticEvents().filter(
    (event) =>
      event.event === 'effect' &&
      ['setup', 'cleanup', 'visibility-cleanup'].includes(event.fields?.reason)
  ).length
}

async function installGeometryProbe(window) {
  await window.webContents.executeJavaScript(`(() => {
    if (window.__islandGeometryProbe) return
    const original = Element.prototype.getBoundingClientRect
    const state = { count: 0, original }
    Element.prototype.getBoundingClientRect = function (...args) {
      state.count++
      return original.apply(this, args)
    }
    window.__islandGeometryProbe = state
  })()`)
}

async function resetGeometryProbe(window) {
  await window.webContents.executeJavaScript(
    'if (window.__islandGeometryProbe) window.__islandGeometryProbe.count = 0'
  )
}

async function readGeometryProbe(window) {
  return window.webContents.executeJavaScript(
    'window.__islandGeometryProbe ? window.__islandGeometryProbe.count : 0'
  )
}

async function removeGeometryProbe(window) {
  await window.webContents.executeJavaScript(`(() => {
    const state = window.__islandGeometryProbe
    if (!state) return 0
    Element.prototype.getBoundingClientRect = state.original
    delete window.__islandGeometryProbe
    return state.count
  })()`)
}

async function installAnimationFrameProbe(window) {
  await window.webContents.executeJavaScript(`(() => {
    if (window.__islandAnimationFrameProbe) return
    const state = {
      next: 1,
      pending: new Set(),
      cancelled: 0,
      nativeRequest: window.requestAnimationFrame,
      nativeCancel: window.cancelAnimationFrame
    }
    window.requestAnimationFrame = () => {
      const id = state.next++
      state.pending.add(id)
      return id
    }
    window.cancelAnimationFrame = (id) => {
      if (state.pending.delete(id)) state.cancelled++
    }
    window.__islandAnimationFrameProbe = state
  })()`)
}

async function removeAnimationFrameProbe(window) {
  return window.webContents.executeJavaScript(`(() => {
    const state = window.__islandAnimationFrameProbe
    if (!state) return { pending: 0, cancelled: 0 }
    window.requestAnimationFrame = state.nativeRequest
    window.cancelAnimationFrame = state.nativeCancel
    const result = { pending: state.pending.size, cancelled: state.cancelled }
    delete window.__islandAnimationFrameProbe
    return result
  })()`)
}

async function verifyPointerMoveDiagnostics(window) {
  await dispatchPointerMoveAt(window, '.compact')
  await retry(() => assert.equal(interactions.at(-1), true))
  await delay(100)
  const pointerPoint = await elementCenter(window, '.compact')
  const before = diagnosticEvents()
  const beforeBatchCount = diagnosticBatches.length
  const beforeInteractionCount = interactions.length
  await installGeometryProbe(window)
  await resetGeometryProbe(window)
  const startedAt = Date.now()
  await dispatchPointerMovesAcrossFrames(
    window,
    pointerPoint.x,
    pointerPoint.y,
    POINTER_MOVE_COUNT,
    20
  )
  const dispatchMs = Date.now() - startedAt
  await delay(100)
  const after = diagnosticEvents()
  const geometryReads = await readGeometryProbe(window)
  await removeGeometryProbe(window)
  assert.equal(after.length, before.length)
  assert.equal(diagnosticBatches.length, beforeBatchCount)
  assert.equal(interactions.length, beforeInteractionCount)
  assert.equal(geometryReads, 0)
  console.log(
    JSON.stringify({
      islandDiagnostics: 'on',
      pointerMoveCount: POINTER_MOVE_COUNT,
      diagnosticBatches: diagnosticBatches.length - beforeBatchCount,
      diagnosticEvents: after.length - before.length,
      interactiveIpc: interactions.length - beforeInteractionCount,
      geometryReads,
      diagnosticBatchesTotal: diagnosticBatches.length,
      diagnosticEventsTotal: after.length,
      dispatchMs
    })
  )
}

function verifyDiagnosticProtocol() {
  assert.ok(diagnosticBatches.length > 0)
  const instances = new Map()
  for (const batch of diagnosticBatches) {
    assert.ok(Array.isArray(batch?.events))
    assert.equal(typeof batch?.dropped, 'number')
    for (const event of batch.events) {
      assert.equal(typeof event.instance, 'string')
      assert.ok(event.instance.length > 0)
      assert.equal(Number.isInteger(event.seq), true)
      assert.equal(typeof event.at, 'number')
      assert.equal(typeof event.mono, 'number')
      assert.equal(typeof event.event, 'string')
      assert.equal(typeof event.fields, 'object')
      const sequence = instances.get(event.instance) ?? []
      sequence.push(event.seq)
      instances.set(event.instance, sequence)
    }
  }
  assert.ok(instances.size >= 2)
  for (const sequence of instances.values()) {
    assert.equal(sequence[0], 1)
    assert.equal(
      sequence.every((value, index) => index === 0 || value > sequence[index - 1]),
      true
    )
  }
  const events = diagnosticEvents()
  const expandedCommit = events.find(
    (event) => event.event === 'mode-commit' && event.fields?.to === 'expanded'
  )
  assert.ok(expandedCommit)
  assert.equal(typeof expandedCommit.fields.expansion, 'number')
  assert.ok(events.some((event) => typeof event.fields?.expandedAge === 'number'))
  assert.ok(
    events.some(
      (event) =>
        event.event === 'interactive' &&
        typeof event.fields?.interactive === 'boolean' &&
        typeof event.fields?.previousInteractive === 'boolean' &&
        typeof event.fields?.pendingHitTest === 'boolean' &&
        typeof event.fields?.pointValid === 'boolean'
    )
  )
}

async function verifyDiagnosticsDisabled(window) {
  await delay(100)
  const previousBatchCount = diagnosticBatches.length
  const previousEventCount = diagnosticEvents().length
  islandDiagnosticsEnabled = false
  await verifyRecreate(window, false)
  await verifyInteractionRegression(window, false)
  const beforeInteractionCount = interactions.length
  await dispatchPointerMoveAt(window, '.compact')
  await retry(() => assert.equal(interactions.at(-1), true))
  const stableInteractionCount = interactions.length
  const pointerPoint = await elementCenter(window, '.compact')
  await installGeometryProbe(window)
  await resetGeometryProbe(window)
  const startedAt = Date.now()
  await dispatchPointerMovesAcrossFrames(
    window,
    pointerPoint.x,
    pointerPoint.y,
    POINTER_MOVE_COUNT,
    20
  )
  const dispatchMs = Date.now() - startedAt
  await delay(100)
  const geometryReads = await readGeometryProbe(window)
  await removeGeometryProbe(window)
  assert.equal(diagnosticBatches.length, previousBatchCount)
  assert.equal(diagnosticEvents().length, previousEventCount)
  assert.equal(interactions.length, stableInteractionCount)
  assert.equal(interactions.length - beforeInteractionCount, 1)
  assert.equal(geometryReads, 0)
  console.log(
    JSON.stringify({
      islandDiagnostics: 'off',
      pointerMoveCount: POINTER_MOVE_COUNT,
      diagnosticBatches: diagnosticBatches.length - previousBatchCount,
      diagnosticEvents: diagnosticEvents().length - previousEventCount,
      interactiveIpc: interactions.length - stableInteractionCount,
      geometryReads,
      diagnosticBatchesTotal: diagnosticBatches.length,
      diagnosticEventsTotal: previousEventCount,
      dispatchMs
    })
  )
}

async function verifyStableCompactUpdates(window) {
  await window.webContents.executeJavaScript(`(() => {
    window.__islandSamples = []
    window.__islandSampling = true
    const sample = () => {
      const island = document.querySelector('.island')
      window.__islandSamples.push({
        mode: document.querySelector('.island-window').dataset.mode,
        opacity: Number(getComputedStyle(island).opacity),
        activeAnimations: island.getAnimations().filter((item) => item.playState === 'running').length
      })
      if (window.__islandSampling) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })()`)
  for (const count of [4, 8, 4]) {
    window.webContents.send(CHANNELS.islandUpdated, snapshot('running', count))
    await delay(180)
    const current = await inspect(window)
    assert.equal(current.mode, 'compact')
    assert.equal(current.taskRows, count)
    assert.equal(current.compactLabel, `${count} 执行中`)
    assert.match(current.compactTrailing, /^\d{2}:\d{2}$/)
  }
  const samples = await window.webContents.executeJavaScript(`(() => {
    window.__islandSampling = false
    return window.__islandSamples
  })()`)
  assert.ok(samples.length > 0)
  assert.equal(
    samples.every((sample) => sample.mode === 'compact'),
    true
  )
  assert.equal(
    samples.every((sample) => sample.opacity === 1),
    true
  )
  assert.equal(
    samples.every((sample) => sample.activeAnimations === 0),
    true
  )
}

async function verifyInteractions(window) {
  window.webContents.send(CHANNELS.islandUpdated, snapshot('waiting-input'))
  await delay(700)
  const reply = await inspect(window)
  assert.equal(reply.statusColor, 'rgb(100, 210, 255)')
  assert.equal(reply.satelliteStatus, 'waiting-input')
  assert.equal(reply.mode, 'alert')
  await window.webContents.executeJavaScript(
    "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))"
  )
  await delay(700)
  const compactReply = await inspect(window)
  assert.equal(compactReply.mode, 'compact')
  assert.equal(compactReply.stageMultiple, 'true')
  const compactReplyRect = resolveIslandModeRect({
    layout: fixtureLayout,
    mode: 'compact',
    expandedHeight: ISLAND_SINGLE_TASK_HEIGHT,
    hasSatellite: true
  })
  assertRectMatches(compactReply.islandRect, compactReplyRect)
  assertRectMatches(compactReply.compactRect, compactReplyRect)
  assertRectMatches(compactReply.hitBridgeRects[0], fixtureLayout.bridge)
  assertRectMatches(compactReply.hitBridgeRects[1], fixtureLayout.satellite)
  await dispatchPointerMoveAt(window, '.satellite')
  await retry(() => assert.equal(interactions.at(-1), true))
  await dispatchPointerMoveOutside(window)
  await retry(() => assert.equal(interactions.at(-1), false))
  await window.webContents.executeJavaScript("document.querySelector('.compact').click()")
  await delay(700)
  assert.equal((await inspect(window)).mode, 'expanded')
  await retry(() => {
    const events = diagnosticEvents()
    const requestIndex = events.findIndex(
      (event) =>
        event.event === 'mode-request' &&
        event.fields?.to === 'expanded' &&
        event.fields?.reason === 'compact-click'
    )
    assert.ok(requestIndex >= 0)
    assert.ok(
      events.some(
        (event, index) =>
          index > requestIndex &&
          event.event === 'mode-commit' &&
          event.fields?.from === 'compact' &&
          event.fields?.to === 'expanded'
      )
    )
  })
  await dispatchPointerLeave(window)
  await retry(async () => assert.equal((await inspect(window)).mode, 'compact'))
  await retry(() =>
    assert.ok(
      diagnosticEvents().some(
        (event) => event.event === 'pointer' && event.fields?.reason === 'pointer-leave'
      )
    )
  )
  await window.webContents.executeJavaScript("document.querySelector('.compact').click()")
  await delay(700)
  assert.equal((await inspect(window)).mode, 'expanded')
  await window.webContents.executeJavaScript(
    "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))"
  )
  await delay(700)
  assert.equal((await inspect(window)).mode, 'compact')
  await window.webContents.executeJavaScript("document.querySelector('.compact').click()")
  await delay(700)
  await window.webContents.executeJavaScript("document.querySelector('.collapse').click()")
  await delay(700)
  assert.equal((await inspect(window)).mode, 'compact')
}

async function verifyMorphAnimations(window) {
  window.webContents.send(CHANNELS.islandUpdated, snapshot('running', 4))
  await retry(async () => assert.equal((await inspect(window)).taskRows, 4))
  await waitForIslandAnimations(window, 'compact')
  const baseLayout = resolveFixtureLayout()
  const animationViewport = {
    mode: 'expanded',
    expandedHeight: ISLAND_EXPANDED_HEIGHT,
    hasSatellite: false
  }
  const compactLayout = fitIslandViewport(baseLayout, {
    ...animationViewport,
    mode: 'compact'
  })
  const expandedLayout = fitIslandViewport(baseLayout, animationViewport)
  await verifyIslandMorph({
    window,
    rects: {
      compact: screenRectForLayout(compactLayout, compactLayout.compact),
      shortExpanded: screenRectForLayout(
        baseLayout,
        resolveIslandModeRect({
          layout: baseLayout,
          mode: 'expanded',
          expandedHeight: ISLAND_SINGLE_TASK_HEIGHT
        })
      ),
      expanded: screenRectForLayout(
        expandedLayout,
        resolveIslandModeRect({
          layout: expandedLayout,
          mode: 'expanded',
          expandedHeight: ISLAND_EXPANDED_HEIGHT
        })
      )
    },
    label: fixtureSettings.island.displayMode,
    expand: () => dispatchNativeClickAt(window, '.compact'),
    collapse: () => sendEscape(window),
    resize: (count) => window.webContents.send(CHANNELS.islandUpdated, snapshot('running', count))
  })
}

async function verifyTaskbarMode(window) {
  window.webContents.send(CHANNELS.islandUpdated, snapshot('running'))
  sendPresentation(window, true)
  await retry(async () => assert.notEqual((await inspect(window)).mode, 'hidden'))
  await sendEscape(window)
  await waitForMode(window, 'compact')
  const islandStyle = await inspect(window)
  assert.equal(islandStyle.displayMode, 'island')
  assert.equal(islandStyle.islandBackground, 'rgb(0, 0, 0)')

  await window.webContents.executeJavaScript(`(() => {
    document.getElementById('geometry-probe')?.remove()
    document.getElementById('edge-transition-probe')?.remove()
  })()`)
  await setFixtureDisplayMode(window, 'taskbar')
  window.webContents.send(CHANNELS.islandUpdated, snapshot('running'))
  await waitForIslandAnimations(window, 'compact')
  assertTaskbarTextAppearance(await inspect(window))
  await verifyTaskbarAnimations(window)
  await installEdgeTransitionProbe(window)
  window.webContents.send(CHANNELS.islandUpdated, snapshot('running'))
  await retry(async () => {
    const current = await inspect(window)
    assert.equal(current.displayMode, 'taskbar')
    assert.equal(current.mode, 'compact')
    assert.equal(current.viewportRebasing, false)
    assert.equal(current.preview, false)
    assert.equal(current.taskRows, 1)
  })

  await verifyTaskbarButtonPlacements(window)
  await verifyTaskbarDragAndNudges(window)
  await verifyTaskbarTheme(window)
  await verifyTaskbarPopups(window)
  await verifyTaskbarRunningTask(window)
  await verifyTaskbarNativePointerLeave(window)
  await verifyTaskbarSystemCursorSampling(window)
  await verifyTaskbarCompactContent(window)
  await verifyNarrowTaskbarContent(window)
  await verifyTaskbarHoverLeavesDuringViewportRebase(window)

  await setFixtureDisplayMode(window, 'island')
  window.webContents.send(CHANNELS.islandUpdated, snapshot('running'))
  await retry(async () => {
    const current = await inspect(window)
    assert.equal(current.displayMode, 'island')
    assert.equal(current.mode, 'compact')
  })
  assertIslandStyleRestored(islandStyle, await inspect(window))
}

async function verifyTaskbarAnimations(window) {
  assert.equal(
    await window.webContents.executeJavaScript(
      "getComputedStyle(document.querySelector('.taskbar-anchor')).pointerEvents"
    ),
    'auto',
    'taskbar anchor must receive trusted pointer input'
  )
  const reducedMotion = await window.webContents.executeJavaScript(
    "matchMedia('(prefers-reduced-motion: reduce)').matches"
  )
  if (!reducedMotion) {
    const hidden = waitForHidden()
    sendPresentation(window, false)
    await hidden
    await verifyEntryClickContinuity({
      window,
      present: () => sendPresentation(window, true),
      click: () => dispatchNativeClickAt(window, '.compact'),
      label: 'taskbar'
    })
    await sendEscape(window)
    await waitForIslandAnimations(window, 'compact')
  }
  await dispatchNativeMoveAt(window, '.compact')
  await waitForIslandAnimations(window, 'compact')
  const layout = resolveFixtureLayout()
  const rectForHeight = (expandedHeight) =>
    screenRectForLayout(layout, resolveIslandModeRect({ layout, mode: 'expanded', expandedHeight }))
  await verifyTaskbarContinuity({
    window,
    open: () => dispatchNativeClickAt(window, '.compact'),
    close: () => sendEscape(window),
    resize: (count) => window.webContents.send(CHANNELS.islandUpdated, snapshot('running', count)),
    rects: {
      expanded: rectForHeight(ISLAND_EXPANDED_HEIGHT),
      shortExpanded: rectForHeight(ISLAND_SINGLE_TASK_HEIGHT)
    }
  })
  await verifyTaskbarAlertExits(window)
  await verifyPendingTaskbarToggle(window)
  await verifyDisplayModeEntry(window)
}
async function verifyTaskbarAlertExits(window) {
  for (const reason of ['removed', 'dismissed']) {
    const phase = reason === 'removed' ? 'waiting-approval' : 'completed'
    window.webContents.send(CHANNELS.islandUpdated, snapshot(phase, 1, `-exit-${reason}`))
    await waitForIslandAnimations(window, 'alert')
    const previousOpenCount = taskOpenRequestCount
    await verifyTaskbarAlertExit({
      window,
      label: reason,
      trigger: async () => {
        if (reason === 'removed') {
          window.webContents.send(CHANNELS.islandUpdated, snapshot('running', 0))
          await retry(async () => assert.equal((await inspect(window)).taskRows, 0))
          assert.equal(
            await window.webContents.executeJavaScript("document.querySelector('.alert').inert"),
            true
          )
          await dispatchNativeClickAt(window, '.alert-footer button:last-of-type')
        } else {
          await dispatchNativeClickAt(window, '.alert-footer button:first-of-type')
        }
        await waitForPopupExitFrame(window)
        await saveEdgeScreenshot(window, `taskbar-alert-${reason}-exit`)
      }
    })
    assert.equal(taskOpenRequestCount, previousOpenCount, 'stale alert controls opened a task')
  }
  window.webContents.send(CHANNELS.islandUpdated, snapshot('running'))
  await waitForIslandAnimations(window, 'compact')
}

function waitForPopupExitFrame(window) {
  return window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const started = performance.now()
    const sample = () => {
      const root = document.querySelector('.island-window')
      const opacity = Number(getComputedStyle(document.querySelector('.island')).opacity)
      if (root.dataset.mode === 'compact' && opacity < 1) resolve()
      else if (performance.now() - started > ${ANIMATION_TIMEOUT_MS}) reject(new Error('Popup exit did not start'))
      else requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })`)
}

async function verifyDisplayModeEntry(window) {
  await dispatchNativeClickAt(window, '.compact')
  await waitForIslandAnimations(window, 'expanded')
  await window.webContents.executeJavaScript(`(() => {
    const oldSection = document.querySelector('.island')
    window.__displayModeEntry = { active: true, samples: [] }
    const sample = () => {
      const root = document.querySelector('.island-window'), island = document.querySelector('.island')
      const opacity = Number(getComputedStyle(island).opacity)
      if (root.dataset.displayMode === 'island' && root.dataset.mode === 'compact' && opacity > 0) {
        window.__displayModeEntry.samples.push({sameNode: island === oldSection, width: island.getBoundingClientRect().width, opacity})
      }
      if (window.__displayModeEntry.active) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })()`)
  await setFixtureDisplayMode(window, 'island')
  await waitForIslandAnimations(window, 'compact')
  const first = await window.webContents.executeJavaScript(`(() => {
    window.__displayModeEntry.active = false
    return window.__displayModeEntry.samples[0]
  })()`)
  assert.ok(first, 'mode switch has no visible compact frame')
  assert.equal(first.sameNode, false, 'new display mode inherited old popup node')
  assert.ok(first.width <= ISLAND_COMPACT_WIDTH + ANIMATION_RECT_TOLERANCE, JSON.stringify(first))
  console.log(JSON.stringify({ displayModeEntry: first }))
  await setFixtureDisplayMode(window, 'taskbar')
  await waitForIslandAnimations(window, 'compact')
}
async function verifyPendingTaskbarToggle(window) {
  await waitForIslandAnimations(window, 'compact')
  const blocker = holdNextViewportRequest('prepare')
  try {
    await dispatchNativeClickAt(window, '.compact')
    await Promise.race([blocker.received, timeout(3_000)])
    assert.equal((await inspect(window)).mode, 'compact')
    await dispatchNativeClickAt(window, '.compact')
    await waitForMode(window, 'compact')
    blocker.release()
    await waitForIslandAnimations(window, 'compact')
    const current = await inspect(window)
    assert.equal(current.mode, 'compact')
    assert.equal(current.popupVisible, false)
    assert.equal(current.islandOpacity, 0)
    assertRendererHealthy()
    console.log(JSON.stringify({ taskbarPendingToggle: 'compact-after-second-click' }))
  } finally {
    blocker.release()
  }
}
async function verifyTaskbarButtonPlacements(window) {
  await retry(async () => {
    const current = await inspect(window)
    assertTaskbarCompact(current, fixtureLayout)
    assert.equal(current.viewportRebasing, false)
  })
  const defaultLayout = fixtureLayout
  const defaultButton = await inspect(window)
  assert.equal(
    defaultLayout.bounds.x +
      defaultButton.compactRect.x +
      TASKBAR_BUTTON_WIDTH +
      TASKBAR_NOTIFICATION_GAP,
    fixtureTaskbar.notificationArea.x
  )

  const maxOffset = getFixtureTaskbarMaxOffset()
  const middleOffset = Math.round(maxOffset / 2)
  const placements = [
    { name: 'left', offset: 0 },
    { name: 'middle', offset: middleOffset },
    { name: 'right', offset: maxOffset }
  ]
  const expectedY =
    fixtureTaskbar.bounds.y + (fixtureTaskbar.bounds.height - TASKBAR_BUTTON_HEIGHT) / 2
  for (const placement of placements) {
    const layout = setFixtureTaskbarOffset(window, placement.offset)
    await retry(async () => {
      const current = await inspect(window)
      assert.equal(current.viewportRebasing, false)
      assertTaskbarCompact(current, layout)
    })
    const current = await inspect(window)
    assert.equal(
      layout.bounds.x + current.compactRect.x,
      fixtureTaskbar.bounds.x + placement.offset,
      placement.name
    )
    assert.equal(layout.bounds.y + current.compactRect.y, expectedY, placement.name)
  }
}

async function verifyTaskbarDragAndNudges(window) {
  setFixtureTaskbarOffset(window, Math.round(getFixtureTaskbarMaxOffset() / 2))
  const before = await inspect(window)
  const startingOffset = getFixtureTaskbarOffsetX()
  const startingY = fixtureLayout.bounds.y + before.compactRect.y
  const requestStart = islandMoveRequests.length
  const finishStart = islandDragFinishedCount
  const pointer = await dispatchDragStartAndMove(window, '.compact')
  await retry(() => assert.ok(islandMoveRequests.length > requestStart))
  await delay(LONG_PRESS_GRACE_MS)
  assert.equal((await inspect(window)).mode, 'compact')
  await dispatchPointerUp(window, '.compact', pointer)
  await retry(() => assert.ok(islandDragFinishedCount > finishStart))

  const moved = await inspect(window)
  const movedOffset = getFixtureTaskbarOffsetX()
  assert.ok(
    movedOffset > startingOffset && movedOffset <= getFixtureTaskbarMaxOffset(),
    `taskbar drag offset ${startingOffset} -> ${movedOffset}`
  )
  assert.equal(fixtureLayout.bounds.y + moved.compactRect.y, startingY)
  assertTaskbarCompact(moved, fixtureLayout)
  await dispatchClickAt(window, '.compact')
  await delay(50)
  assert.equal((await inspect(window)).mode, 'compact')
  await verifyTaskbarNudge(window, 'ArrowLeft', -KEYBOARD_NUDGE_STEP)
  await verifyTaskbarNudge(window, 'ArrowRight', KEYBOARD_NUDGE_STEP)

  const verticalStart = islandNudgeRequests.length
  const verticalOffset = getFixtureTaskbarOffsetX()
  const verticalY = fixtureLayout.bounds.y + (await inspect(window)).compactRect.y
  await dispatchIslandArrowKey(window, 'ArrowUp')
  await dispatchIslandArrowKey(window, 'ArrowDown')
  await delay(50)
  assert.equal(islandNudgeRequests.length, verticalStart)
  assert.equal(getFixtureTaskbarOffsetX(), verticalOffset)
  const afterVerticalKeys = await inspect(window)
  assert.equal(fixtureLayout.bounds.y + afterVerticalKeys.compactRect.y, verticalY)
}

async function verifyTaskbarNudge(window, key, delta) {
  const startingOffset = getFixtureTaskbarOffsetX()
  const startingY = fixtureLayout.bounds.y + (await inspect(window)).compactRect.y
  const requestStart = islandNudgeRequests.length
  const finishStart = islandDragFinishedCount
  await dispatchIslandArrowKey(window, key)
  await retry(() => assert.equal(islandNudgeRequests.length, requestStart + 1))
  await retry(() => assert.ok(islandDragFinishedCount > finishStart))
  assert.equal(getFixtureTaskbarOffsetX(), clampFixtureTaskbarOffset(startingOffset + delta))
  const current = await inspect(window)
  assert.equal(fixtureLayout.bounds.y + current.compactRect.y, startingY)
}

async function verifyTaskbarTheme(window) {
  for (const theme of [
    { dark: false, name: 'light', color: 'rgb(38, 40, 43)' },
    { dark: true, name: 'dark', color: 'rgb(241, 242, 243)' }
  ]) {
    setFixtureTaskbarTheme(window, theme.dark)
    await retry(async () => assert.equal((await inspect(window)).taskbarTheme, theme.name))
    const current = await inspect(window)
    assert.equal(current.taskbarColorScheme, theme.name)
    assert.equal(current.islandColor, theme.color)
    assertTaskbarTextAppearance(current)
    await verifyTaskbarFeedback(window)
    await verifyTaskbarIndicatorColors(window, theme.name)
    await saveEdgeScreenshot(window, `taskbar-${theme.name}-compact`)
  }
}

async function verifyTaskbarIndicatorColors(window, theme) {
  const colors =
    theme === 'dark'
      ? [
          'rgb(48, 209, 88)',
          'rgb(255, 159, 10)',
          'rgb(100, 210, 255)',
          'rgb(255, 69, 58)',
          'rgb(191, 90, 242)',
          'rgb(174, 174, 178)'
        ]
      : [
          'rgb(22, 136, 62)',
          'rgb(179, 107, 0)',
          'rgb(0, 124, 168)',
          'rgb(207, 48, 40)',
          'rgb(140, 57, 198)',
          'rgb(115, 115, 120)'
        ]
  const statuses = [
    'running',
    'waiting-approval',
    'waiting-input',
    'failed',
    'completed',
    'stopped'
  ]
  for (const [index, status] of statuses.entries()) {
    const value = snapshot(status, 1, `-indicator-${theme}`)
    value.viewedEventIds = value.tasks.map((task) => task.requests[0]?.id ?? task.latestEventId)
    window.webContents.send(CHANNELS.islandUpdated, value)
    await retry(async () => {
      const current = await inspect(window)
      assert.equal(current.taskbarIndicator.color, colors[index])
      assert.equal(current.taskbarIndicator.height, '3px')
      assert.equal(current.taskbarFeedback.borderColor, TRANSPARENT_COLOR)
      assert.equal(current.compactTextStyle.trailing.color, current.compactTextStyle.leading.color)
    })
  }
  window.webContents.send(CHANNELS.islandUpdated, snapshot('running'))
  await retry(async () => assert.equal((await inspect(window)).compactLabel, '1 执行中'))
}

async function verifyTaskbarFeedback(window) {
  window.webContents.send(CHANNELS.islandUpdated, snapshot('running'))
  await retry(async () => {
    const current = await inspect(window)
    assert.equal(current.preview, false)
    assert.equal(current.taskRows, 1)
  })
  await waitForIslandAnimations(window, 'compact')
  await dispatchNativeMoveOutside(window)
  await waitForTaskbarFeedback(window, 'default')
  await verifyTaskbarHoverAndPress(window)
  await verifyTaskbarSelection(window)
  await retry(async () => {
    const current = await inspect(window)
    assert.equal(current.preview, false)
    assert.equal(current.taskRows, 1)
  })
  await verifyTaskbarKeyboardFocus(window)
  await verifyTaskbarPointerEventOrder(window)
  await verifyTaskbarPressedReset(window)
  console.log(JSON.stringify({ taskbarFeedback: (await inspect(window)).taskbarTheme }))
}

async function verifyTaskbarHoverAndPress(window) {
  const theme = (await inspect(window)).taskbarTheme
  const point = await dispatchNativeMoveAt(window, TASKBAR_SELECTOR)
  await waitForTaskbarFeedback(window, 'hover')
  await saveEdgeScreenshot(window, `taskbar-${theme}-feedback-hover`)
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
  await waitForTaskbarFeedback(window, 'pressed')
  await saveEdgeScreenshot(window, `taskbar-${theme}-feedback-pressed`)
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
  await waitForTaskbarFeedback(window, 'hover')
  await waitForIslandAnimations(window, 'expanded')
  await sendEscape(window)
  await waitForIslandAnimations(window, 'compact')
  await dispatchNativeMoveOutside(window)
  await waitForTaskbarFeedback(window, 'default')

  await dispatchNativeMoveAt(window, TASKBAR_SELECTOR)
  await waitForTaskbarFeedback(window, 'hover')
  assert.equal((await inspect(window)).taskbarFeedback.nativeHovered, true)
  // 受控复现浏览器仍保留 :hover 的情况，不据此推断桌面故障根因。
  await dispatchPointerMoveOutside(window)
  await waitForTaskbarFeedback(window, 'default')
  assert.equal((await inspect(window)).taskbarFeedback.nativeHovered, true)
  await saveEdgeScreenshot(window, `taskbar-${theme}-feedback-forwarded-outside`)
  await dispatchNativeMoveOutside(window)
}

async function verifyTaskbarSelection(window) {
  const theme = (await inspect(window)).taskbarTheme
  window.webContents.send(CHANNELS.islandUpdated, snapshot('running'))
  await retry(async () => assert.equal((await inspect(window)).preview, false))
  await dispatchNativeClickAt(window, TASKBAR_SELECTOR)
  await waitForIslandAnimations(window, 'expanded')
  await dispatchNativeMoveAt(window, '.task')
  await waitForTaskbarFeedback(window, 'selected')
  await window.webContents.executeJavaScript("document.querySelector('.task').focus()")
  await waitForTaskbarFeedback(window, 'selected')
  await saveEdgeScreenshot(window, `taskbar-${theme}-feedback-selected`)
  await dispatchNativeMoveAt(window, TASKBAR_SELECTOR)
  await waitForTaskbarFeedback(window, 'hover')
  await dispatchNativeMoveAt(window, '.task')
  await waitForTaskbarFeedback(window, 'selected')
  await window.webContents.executeJavaScript("document.querySelector('.taskbar-anchor').focus()")
  await sendEscape(window)
  await waitForIslandAnimations(window, 'compact')
  await waitForTaskbarFeedback(window, 'default')
  const feedback = (await inspect(window)).taskbarFeedback
  assert.equal(feedback.focused, true, 'collapse replaced or blurred the focused anchor')
  assert.equal(feedback.focusVisible, false, 'mouse focus acquired a keyboard outline')
}

async function verifyTaskbarKeyboardFocus(window) {
  await window.webContents.executeJavaScript("document.querySelector('.taskbar-anchor').blur()")
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
  await retry(async () => {
    const feedback = (await inspect(window)).taskbarFeedback
    assert.equal(feedback.focused, true)
    assert.equal(feedback.focusVisible, true)
    assert.notEqual(feedback.outlineStyle, 'none')
    assert.ok(parseFloat(feedback.outlineWidth) > 0)
    assert.notEqual(feedback.outlineColor, TRANSPARENT_COLOR)
  })
  await waitForTaskbarFeedback(window, 'default')
  await window.webContents.executeJavaScript("document.querySelector('.taskbar-anchor').blur()")
}

async function verifyTaskbarPressedReset(window) {
  let point = await dispatchNativeMoveAt(window, TASKBAR_SELECTOR)
  await waitForTaskbarFeedback(window, 'hover')
  await waitForIslandAnimations(window, 'compact')
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
  await waitForTaskbarFeedback(window, 'pressed')
  await window.webContents
    .executeJavaScript(`document.querySelector('.taskbar-anchor').dispatchEvent(
    new PointerEvent('pointercancel', { bubbles: true, pointerId: ${TASKBAR_POINTER_ID}, pointerType: 'mouse' })
  )`)
  await waitForTaskbarFeedback(window, 'default')
  let outsidePoint = await dispatchNativeMoveOutside(window)
  window.webContents.sendInputEvent({
    type: 'mouseUp',
    button: 'left',
    clickCount: 1,
    ...outsidePoint
  })
  await waitForMode(window, 'compact')

  point = await dispatchNativeMoveAt(window, TASKBAR_SELECTOR)
  await waitForTaskbarFeedback(window, 'hover')
  await waitForIslandAnimations(window, 'compact')
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
  await waitForTaskbarFeedback(window, 'pressed')
  await window.webContents.executeJavaScript("window.dispatchEvent(new Event('blur'))")
  await waitForTaskbarFeedback(window, 'default')
  outsidePoint = await dispatchNativeMoveOutside(window)
  window.webContents.sendInputEvent({
    type: 'mouseUp',
    button: 'left',
    clickCount: 1,
    ...outsidePoint
  })
  await waitForMode(window, 'compact')

  point = await dispatchNativeMoveAt(window, TASKBAR_SELECTOR)
  await waitForTaskbarFeedback(window, 'hover')
  await waitForIslandAnimations(window, 'compact')
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
  await waitForTaskbarFeedback(window, 'pressed')
  const hidden = waitForHidden()
  sendPresentation(window, false)
  await hidden
  await retry(async () =>
    assert.equal((await inspect(window)).taskbarFeedback.pressedAttribute, 'false')
  )
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
  sendPresentation(window, true)
  await waitForIslandAnimations(window, 'compact')
  await dispatchNativeMoveOutside(window)
  await waitForTaskbarFeedback(window, 'default')
}

async function verifyTaskbarPointerEventOrder(window) {
  const current = await inspect(window)
  assert.equal(current.preview, false)
  assert.equal(current.taskRows, 1)
  for (const scenario of [
    { type: 'pointerup', moveButtons: 1, buttons: 0, state: 'hover' },
    { type: 'pointercancel', moveButtons: 1, buttons: 0, state: 'default' },
    { type: 'blur', moveButtons: 1, buttons: 0, state: 'default' },
    { type: 'pointerdown', moveButtons: 0, buttons: 1, state: 'pressed' }
  ]) {
    console.log(JSON.stringify({ taskbarPointerOrder: scenario.type }))
    // 合成序列不移动 Chromium 指针；先移入，确保下一次移出改变坐标。
    await dispatchNativeMoveAt(window, TASKBAR_SELECTOR)
    await waitForTaskbarFeedback(window, 'hover')
    await dispatchNativeMoveOutside(window)
    await waitForTaskbarFeedback(window, 'default')
    const actual = await dispatchTaskbarPointerEventOrder(window, scenario)
    assert.equal(
      actual.pressed,
      String(scenario.state === 'pressed'),
      `${scenario.type}: stale move overwrote pressed`
    )
    assert.equal(
      actual.hovered,
      String(scenario.state !== 'default'),
      `${scenario.type}: stale move overwrote hover`
    )
    await waitForTaskbarFeedback(window, scenario.state)
  }
  await window.webContents
    .executeJavaScript(`document.querySelector('.taskbar-anchor').dispatchEvent(
    new PointerEvent('pointercancel', { bubbles: true, pointerId: ${TASKBAR_POINTER_ID}, pointerType: 'mouse' })
  )`)
  await dispatchNativeMoveOutside(window)
  await waitForTaskbarFeedback(window, 'default')
}

function dispatchTaskbarPointerEventOrder(window, scenario) {
  // 受控验证同帧事件顺序：旧 move 的 rAF 不得覆盖后到的即时输入。
  return window.webContents.executeJavaScript(`new Promise(resolve => {
    const scenario = ${JSON.stringify(scenario)}
    const button = document.querySelector('.taskbar-anchor')
    const rect = button.getBoundingClientRect()
    const pointer = {
      bubbles: true, cancelable: true, pointerId: ${TASKBAR_POINTER_ID},
      pointerType: 'mouse', isPrimary: true, button: 0,
      clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2
    }
    document.dispatchEvent(new PointerEvent('pointermove', { ...pointer, buttons: scenario.moveButtons }))
    if (scenario.type === 'blur') window.dispatchEvent(new Event('blur'))
    else button.dispatchEvent(new PointerEvent(scenario.type, { ...pointer, buttons: scenario.buttons }))
    requestAnimationFrame(() => requestAnimationFrame(() => resolve({
      hovered: button.dataset.hovered, pressed: button.dataset.pressed
    })))
  })`)
}

async function waitForTaskbarFeedback(window, state) {
  await retry(async () => {
    const feedback = (await inspect(window)).taskbarFeedback
    assert.ok(['true', 'false'].includes(feedback.hoveredAttribute), 'hover state is not explicit')
    assert.ok(
      ['true', 'false'].includes(feedback.pressedAttribute),
      'pressed state is not explicit'
    )
    assert.equal(feedback.pressed, state === 'pressed', `unexpected pressed state: ${state}`)
    assert.equal(
      feedback.hovered,
      state === 'hover' || state === 'pressed',
      `unexpected hover state: ${state}`
    )
    if (state === 'selected' || state === 'default') {
      assert.equal(feedback.selected, state === 'selected')
    }
    assert.equal(feedback.borderColor, TRANSPARENT_COLOR)
    assertTaskbarFeedback(feedback)
  })
}

async function verifyTaskbarPopups(window) {
  await verifyTaskbarAlert(window)
  await verifyTaskbarExpanded(window)
}

async function verifyTaskbarAlert(window) {
  window.webContents.send(CHANNELS.islandUpdated, snapshot('waiting-approval', 1, '-taskbar'))
  await waitForMode(window, 'alert')
  await delay(700)
  const alert = await inspect(window)
  const layout = fixtureLayout
  const rect = resolveIslandModeRect({
    layout,
    mode: 'alert',
    expandedHeight: ISLAND_SINGLE_TASK_HEIGHT
  })
  assertTaskbarOverlayAnchor(alert, layout)
  assertRenderedLayout(alert, layout, 'alert', rect)
  assertRectWithinWorkArea(rect, layout)
  assertRenderedHitRects(alert, layout, 'alert', false)
  assert.equal(alert.islandBorderRadius, '8px')
  await saveEdgeScreenshot(window, 'taskbar-alert')

  await sendEscape(window)
  await waitForMode(window, 'compact')
}

async function verifyTaskbarExpanded(window) {
  window.webContents.send(CHANNELS.islandUpdated, snapshot('running'))
  await retry(async () => assert.equal((await inspect(window)).preview, false))
  await dispatchPointerStartAndFinish(window, '.compact')
  await dispatchClickAt(window, '.compact')
  await waitForMode(window, 'expanded')
  await delay(700)
  const expanded = await inspect(window)
  const layout = fixtureLayout
  const rect = resolveIslandModeRect({
    layout,
    mode: 'expanded',
    expandedHeight: ISLAND_SINGLE_TASK_HEIGHT
  })
  assertTaskbarOverlayAnchor(expanded, layout)
  assertRenderedLayout(expanded, layout, 'expanded', rect)
  assertRectWithinWorkArea(rect, layout)
  assertRenderedHitRects(expanded, layout, 'expanded', false)
  assert.equal(expanded.islandBorderRadius, '8px')
  assert.equal(expanded.satellitePresent, false)
  await saveEdgeScreenshot(window, 'taskbar-expanded')

  await sendEscape(window)
  await waitForMode(window, 'compact')
}

function assertTaskbarTextAppearance(current) {
  assert.equal(current.compactRect.width, 132)
  assert.equal(current.compactRect.height, 36)
  assert.equal(current.compactTextStyle.leading.fontSize, '12px')
  assert.equal(
    current.compactTextStyle.trailing.fontSize,
    current.compactTextStyle.leading.fontSize
  )
  assert.equal(current.compactTextStyle.trailing.color, current.compactTextStyle.leading.color)
  assert.equal(current.compactTextStyle.trailing.fontWeight, '400')
  assert.equal(current.taskbarFeedback.borderColor, TRANSPARENT_COLOR)
  assert.equal(current.taskbarFeedback.baseBackground.trim(), TRANSPARENT_COLOR)
  assert.equal(current.taskbarIndicator.width, `${current.compactRect.width - 14}px`)
  assert.equal(current.taskbarIndicator.height, '3px')
  assert.equal(current.taskbarIndicator.bottom, '3px')
  assert.equal(current.taskbarIndicator.left, '6px')
  assert.equal(current.taskbarIndicator.transform, 'none')
}

async function verifyTaskbarRunningTask(window) {
  window.webContents.send(CHANNELS.islandUpdated, snapshot('running'))
  sendPresentation(window, true)
  await waitForMode(window, 'compact')
  await waitForIslandAnimations(window, 'compact')
  const running = await inspect(window)
  assert.equal(running.compactLabel, '1 执行中')
  assert.equal(running.taskRows, 1)
  assert.equal(running.preview, false)
  assert.equal(running.satellitePresent, false)
  assertTaskbarCompact(running, fixtureLayout)
  assert.equal(running.hitBridgeRects.length, 0)

  await dispatchPointerMoveAt(window, '.compact')
  await retry(() => assert.equal(interactions.at(-1), true))
  await dispatchPointerMoveOutside(window)
  await retry(() => assert.equal(interactions.at(-1), false))
}

async function verifyTaskbarNativePointerLeave(window) {
  window.webContents.send(CHANNELS.islandUpdated, snapshot('running'))
  sendPresentation(window, true)
  await waitForIslandAnimations(window, 'compact')
  await dispatchNativeMoveOutside(window)
  await dispatchNativeMoveAt(window, TASKBAR_SELECTOR)
  await waitForTaskbarFeedback(window, 'hover')
  const point = await pointerPointForElement(window, TASKBAR_SELECTOR, false)
  const bounds = window.getContentBounds()
  fixturePointerScreen = { x: bounds.x + point.x, y: bounds.y + point.y }
  const update = { x: point.x, y: point.y, presentationRevision: currentPresentation.revision }
  window.webContents.send(CHANNELS.islandPointer, {
    ...update,
    presentationRevision: currentPresentation.revision - 1
  })
  await delay(TASKBAR_FEEDBACK_SETTLE_MS)
  assert.equal((await inspect(window)).taskbarFeedback.hovered, true, 'stale cursor update applied')
  window.webContents.send(CHANNELS.islandPointer, update)
  await delay(TASKBAR_FEEDBACK_SETTLE_MS)
  const feedback = (await inspect(window)).taskbarFeedback
  console.log(
    JSON.stringify({
      taskbarNativePointerLeave: {
        hovered: feedback.hovered,
        nativeHovered: feedback.nativeHovered,
        background: feedback.anchorBackground,
        expectedBackground: feedback.baseBackground
      }
    })
  )
  assert.equal(feedback.nativeHovered, true, 'fixture unexpectedly delivered a browser leave')
  assert.equal(feedback.hovered, false, 'native cursor outside did not clear hover without leave')
  assert.equal(feedback.anchorBackground, feedback.baseBackground)
  await retry(() => assert.equal(interactions.at(-1), false))
  await dispatchNativeMoveOutside(window)
}

async function verifyTaskbarSystemCursorSampling(window) {
  const offset = getFixtureTaskbarOffsetX()
  const cursor = screen.getCursorScreenPoint()
  const midpoint = fixtureTaskbar.bounds.x + fixtureTaskbar.bounds.width / 2
  setFixtureTaskbarOffset(window, cursor.x < midpoint ? getFixtureTaskbarMaxOffset() : 0)
  await waitForIslandAnimations(window, 'compact')
  await dispatchNativeMoveOutside(window)
  await dispatchNativeMoveAt(window, TASKBAR_SELECTOR)
  await waitForTaskbarFeedback(window, 'hover')
  try {
    nativePointerTracker.startIslandPointerTracking(window, currentPresentation.revision)
    await waitForTaskbarFeedback(window, 'default')
    const feedback = (await inspect(window)).taskbarFeedback
    assert.equal(feedback.nativeHovered, true, 'system sampler received a browser leave')
    assert.equal(feedback.anchorBackground, TRANSPARENT_COLOR)
    console.log(
      JSON.stringify({
        taskbarSystemCursorSampling: {
          hovered: feedback.hovered,
          nativeHovered: feedback.nativeHovered,
          background: feedback.anchorBackground
        }
      })
    )
  } finally {
    nativePointerTracker.stopIslandPointerTracking(window)
    setFixtureTaskbarOffset(window, offset)
    await waitForIslandAnimations(window, 'compact')
  }
}

async function verifyTaskbarCompactContent(window) {
  for (const item of [
    { count: 1, seconds: 424, label: '1 已完成', duration: '07:04' },
    { count: 1, seconds: undefined, label: '1 已完成', duration: '--:--' },
    { count: 100, seconds: 7407419, label: '99+ 已完成', duration: '85d17h' }
  ]) {
    const value = taskbarContentSnapshot(item)
    window.webContents.send(CHANNELS.islandUpdated, value)
    await retry(async () => {
      const current = await inspect(window)
      assert.equal(current.compactLabel, item.label)
      assert.equal(current.compactTrailing, item.duration)
      assert.equal(current.taskRows, item.count)
      assertTaskbarTextAppearance(current)
      assertTaskbarContentBounds(current.compactContent)
    })
  }
  await dispatchNativeClickAt(window, TASKBAR_SELECTOR)
  await waitForMode(window, 'expanded')
  const details = await inspect(window)
  assert.equal(details.taskbarDetails.titleWhiteSpace, 'normal')
  assert.equal(details.taskbarDetails.projectWhiteSpace, 'normal')
  assert.equal(details.taskbarDetails.listOverflowY, 'auto')
  assert.ok(details.taskbarDetails.listScrollHeight > details.taskbarDetails.listClientHeight)
  assert.ok(details.taskbarDetails.titleScrollWidth <= details.taskbarDetails.titleClientWidth + 1)
  assert.ok(
    details.taskbarDetails.projectScrollWidth <= details.taskbarDetails.projectClientWidth + 1
  )
  assert.equal(details.taskbarDetails.duration, '123456:59')
  await sendEscape(window)
  await setFixtureDisplayMode(window, 'island')
  await retry(async () => {
    const current = await inspect(window)
    assert.equal(current.compactLabel, '100 已完成')
    assert.equal(current.compactTrailing, '123456:59')
  })
  await setFixtureDisplayMode(window, 'taskbar')
  await waitForIslandAnimations(window, 'compact')
  await saveEdgeScreenshot(window, 'taskbar-tight-large-count')
}

function taskbarContentSnapshot({ count, seconds }) {
  const value = snapshot('completed', count, '-taskbar-content')
  const updatedAt = Date.now()
  for (const task of value.tasks) {
    task.updatedAt = updatedAt
    task.startedAt = seconds === undefined ? undefined : updatedAt - seconds * 1000
    task.title = '检查任务栏图文排版与完整信息访问 LongTitleABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    task.project =
      'F:\\WorkSpace\\LongProjectPathWithoutSpaces_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\\src\\renderer\\island\\TaskbarLayout.tsx'
  }
  value.counts.running = 0
  value.counts.completed = count
  // 此处只测排版；标记完成事件已读，避免新完成提醒抢占待展开的列表。
  value.viewedEventIds = value.tasks.map((task) => task.latestEventId)
  value.viewedEventIds = value.tasks.map((task) => task.latestEventId)
  return value
}

function assertTaskbarContentBounds(content) {
  const tolerance = ANIMATION_RECT_TOLERANCE
  assert.ok(content.icon.x >= content.button.x - tolerance)
  assert.ok(content.icon.x + content.icon.width <= content.label.x + tolerance)
  assert.ok(content.label.x + content.label.width <= content.time.x + tolerance)
  assert.ok(
    content.time.x + content.time.width <= content.button.x + content.button.width + tolerance
  )
  for (const rect of [content.icon, content.label, content.time]) {
    assert.ok(rect.y >= content.button.y - tolerance)
    assert.ok(rect.y + rect.height <= content.button.y + content.button.height + tolerance)
  }
}

async function verifyNarrowTaskbarContent(window) {
  const original = fixtureTaskbar
  try {
    fixtureTaskbar = { bounds: { ...original.bounds, width: 104, height: 28 }, dark: true }
    setFixtureLayout(window)
    await retry(async () => {
      const current = await inspect(window)
      assert.equal(current.compactRect.width, 104)
      assert.equal(current.compactRect.height, 28)
      assert.equal(current.compactTrailingDisplay, 'none')
      assert.equal(current.compactLabel, '99+ 已完成')
      assert.ok(current.compactContent.icon.width > 0)
    })
    await saveEdgeScreenshot(window, 'taskbar-tight-narrow')
  } finally {
    fixtureTaskbar = original
    setFixtureLayout(window)
  }
  await waitForIslandAnimations(window, 'compact')
}

async function verifyTaskbarHoverLeavesDuringViewportRebase(window) {
  window.webContents.send(CHANNELS.islandUpdated, snapshot('running'))
  await waitForIslandAnimations(window, 'compact')
  // 此用例只控制 DOM leave，浏览器光标留在外部，避免重排生成新的移入。
  await dispatchNativeMoveOutside(window)
  await dispatchPointerEnterAt(window, '.compact')
  await dispatchPointerMoveAt(window, '.compact')
  await waitForTaskbarFeedback(window, 'hover')

  const blocker = holdNextViewportRequest('prepare')
  try {
    window.webContents.send(CHANNELS.islandUpdated, snapshot('running', 2))
    await Promise.race([blocker.received, timeout(3_000)])
    const rebasing = await inspect(window)
    assert.equal(rebasing.mode, 'compact')
    assert.equal(rebasing.viewportRebasing, true)
    assert.equal(rebasing.taskRows, 2)

    await dispatchPointerOutAt(window, '.compact', true)
    await waitForTaskbarFeedback(window, 'hover')

    const outsidePoint = await pointerPointForElement(window, '.compact', false)
    assert.equal(
      outsidePoint.outside,
      true,
      `leave point is inside compact: ${JSON.stringify(outsidePoint)}`
    )
    await dispatchPointerOutAt(window, '.compact', false, outsidePoint)
    await delay(TASKBAR_FEEDBACK_SETTLE_MS)
    const afterButtonLeave = (await inspect(window)).taskbarFeedback

    await dispatchPointerMoveAt(window, '.compact')
    await waitForTaskbarFeedback(window, 'hover')
    await dispatchDocumentLeaveAt(window, '.compact')
    await delay(TASKBAR_FEEDBACK_SETTLE_MS)
    const afterDocumentLeave = (await inspect(window)).taskbarFeedback

    console.log(
      JSON.stringify({
        taskbarLeaveDuringViewportRebase: {
          rebasing: rebasing.viewportRebasing,
          outsidePoint,
          afterButtonLeave: {
            hovered: afterButtonLeave.hovered,
            background: afterButtonLeave.anchorBackground,
            expectedBackground: afterButtonLeave.baseBackground
          },
          afterDocumentLeave: {
            hovered: afterDocumentLeave.hovered,
            background: afterDocumentLeave.anchorBackground,
            expectedBackground: afterDocumentLeave.baseBackground
          }
        }
      })
    )
    assert.equal(afterButtonLeave.hovered, false, 'button pointerleave did not restore idle')
    assert.equal(
      afterButtonLeave.anchorBackground,
      afterButtonLeave.baseBackground,
      'button pointerleave did not restore idle background'
    )
    assert.equal(afterDocumentLeave.hovered, false, 'document mouseleave did not restore idle')
    assert.equal(
      afterDocumentLeave.anchorBackground,
      afterDocumentLeave.baseBackground,
      'document mouseleave did not restore idle background'
    )
  } finally {
    blocker.release()
  }
  await waitForMode(window, 'compact')
}

function assertTaskbarCompact(actual, layout) {
  assert.equal(actual.displayMode, 'taskbar')
  assert.equal(actual.mode, 'compact')
  assert.equal(actual.compactRect.width, TASKBAR_BUTTON_WIDTH)
  assert.equal(actual.compactRect.height, TASKBAR_BUTTON_HEIGHT)
  assert.equal(actual.taskbarAnchorBorderRadius, '4px')
  assert.equal(actual.satellitePresent, false)
  assertRectMatches(actual.compactRect, layout.compact)
  assertRenderedHitRects(actual, layout, 'compact', false)
}

function assertTaskbarOverlayAnchor(actual, layout) {
  assert.equal(actual.displayMode, 'taskbar')
  assert.equal(actual.taskbarAnchorRect.width, TASKBAR_BUTTON_WIDTH)
  assert.equal(actual.taskbarAnchorRect.height, TASKBAR_BUTTON_HEIGHT)
  assert.equal(actual.taskbarAnchorBorderRadius, '4px')
  assert.equal(actual.satellitePresent, false)
  assert.notDeepEqual(actual.taskbarAnchorRect, actual.islandRect)
  assertRectMatches(actual.taskbarAnchorRect, layout.compact)
}

function assertIslandStyleRestored(expected, actual) {
  assert.equal(actual.displayMode, 'island')
  for (const property of [
    'islandBackground',
    'islandBorderRadius',
    'islandBoxShadow',
    'islandColor'
  ]) {
    assert.equal(actual[property], expected[property], property)
  }
}
function assertRenderedLayout(actual, layout, mode, expectedRect) {
  assert.equal(actual.direction, layout.direction)
  assert.equal(actual.viewportWidth, layout.bounds.width)
  assert.equal(actual.viewportHeight, layout.bounds.height)
  assertRectMatches(actual.islandRect, expectedRect)
  if (mode === 'compact') assertRectMatches(actual.compactRect, layout.compact)
  assertRectWithinWindow(actual.islandRect, fixtureWindow)
  assertRectWithinWindow(actual.compactRect, fixtureWindow)
}

function assertRenderedHitRects(actual, layout, mode, hasSatellite) {
  const expected = layoutApi
    .islandHitRects({
      layout,
      mode,
      expandedHeight: ISLAND_SINGLE_TASK_HEIGHT,
      hasSatellite
    })
    .slice(1)
  assert.equal(actual.hitBridgeRects.length, expected.length)
  expected.forEach((rect, index) => {
    assertRectMatches(actual.hitBridgeRects[index], rect)
    assertRectWithinWindow(actual.hitBridgeRects[index], fixtureWindow)
  })
}

function assertRectWithinWorkArea(rect, layout) {
  const area = fixtureDisplay.workArea
  const globalX = layout.bounds.x + rect.x
  const globalY = layout.bounds.y + rect.y
  assert.ok(globalX >= area.x + CARD_EDGE_GAP - 1, JSON.stringify(rect))
  assert.ok(globalY >= area.y + CARD_EDGE_GAP - 1, JSON.stringify(rect))
  assert.ok(globalX + rect.width <= area.x + area.width - CARD_EDGE_GAP + 1, JSON.stringify(rect))
  assert.ok(globalY + rect.height <= area.y + area.height - CARD_EDGE_GAP + 1, JSON.stringify(rect))
}

async function installEdgeTransitionProbe(window) {
  await window.webContents.executeJavaScript(`(() => {
    if (document.getElementById('edge-transition-probe')) return
    const style = document.createElement('style')
    style.id = 'edge-transition-probe'
    style.textContent = '.island, .satellite { transition: none !important; }'
    document.head.append(style)
  })()`)
}

async function sendEscape(window) {
  await window.webContents.executeJavaScript(
    "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))"
  )
}

async function dispatchIslandArrowKey(window, key) {
  await window.webContents.executeJavaScript(`(() => {
    document.querySelector('.compact').dispatchEvent(new KeyboardEvent('keydown', {
      key: ${JSON.stringify(key)},
      bubbles: true,
      cancelable: true
    }))
  })()`)
}

verifyIslandWindow().then(
  () => {
    console.log(
      `Island renderer checks passed (scale=${forcedScale || 'default'}, reducedMotion=${process.env.ISLAND_TEST_REDUCED_MOTION === '1'})`
    )
    app.quit()
  },
  (error) => {
    console.error(error)
    console.error(JSON.stringify({ failureEvents: diagnosticEvents().slice(-24) }))
    app.exit(1)
  }
)

function clearHiddenWaiter(promise) {
  promise.catch(() => undefined)
}

function waitForHidden() {
  return new Promise((resolveHiddenPromise) => {
    resolveHidden = resolveHiddenPromise
  })
}

function sendPresentation(window, visible) {
  const presentation = { revision: ++presentationRevision, visible }
  currentPresentation = presentation
  if (visible) {
    if (!window.isVisible()) window.showInactive()
    window.webContents.setBackgroundThrottling(false)
  }
  window.webContents.send(CHANNELS.islandPresentation, presentation)
  return presentation.revision
}

function registerHandlers() {
  ipcMain.handle(CHANNELS.bootstrap, () => ({
    settings: fixtureSettings,
    island: snapshot('running'),
    islandLayout: fixtureLayout,
    islandDiagnostics: islandDiagnosticsEnabled
  }))
  ipcMain.handle(CHANNELS.islandReady, (event) => {
    if (event.sender.id !== fixtureWindow?.webContents.id) return
    readyCount++
    fixtureViewport = { ...DEFAULT_ISLAND_VIEWPORT }
    fixturePreviousViewports = []
    fixtureViewportRevision = 0
    const target = BrowserWindow.fromWebContents(event.sender)
    if (target) setFixtureLayout(target)
    ready()
  })
  ipcMain.handle(CHANNELS.islandHidden, (event, revision) => {
    if (revision !== currentPresentation.revision || currentPresentation.visible) return
    hiddenRevision = revision
    resolveHidden?.(revision)
    const target = BrowserWindow.fromWebContents(event.sender)
    target?.webContents.setBackgroundThrottling(true)
    target?.hide()
  })
  ipcMain.handle(CHANNELS.islandInteractive, (event, value, presentationRevision) => {
    if (
      event.sender.id !== BrowserWindow.getAllWindows()[0]?.webContents.id ||
      presentationRevision !== currentPresentation.revision
    )
      return
    interactions.push(value)
  })
  ipcMain.on(CHANNELS.islandDiagnostic, (event, batch) => {
    if (event.sender.id !== BrowserWindow.getAllWindows()[0]?.webContents.id) return
    diagnosticBatches.push(batch)
  })
  ipcMain.handle(CHANNELS.islandOpenTask, (_event, threadId) => {
    taskOpenRequestCount++
    openedThread = threadId
    return taskOpenConfirmed
  })
  ipcMain.handle(CHANNELS.islandDismissTask, () => true)
  ipcMain.handle(CHANNELS.islandViewport, async (event, request) => {
    if (fixtureViewportBlocker?.phase === request?.phase) {
      const blocker = fixtureViewportBlocker
      fixtureViewportBlocker = undefined
      blocker.received()
      await blocker.released
    }
    const target = BrowserWindow.fromWebContents(event.sender)
    if (
      !target ||
      target.webContents.id !== fixtureWindow?.webContents.id ||
      !currentPresentation.visible
    )
      return undefined
    if (!updateFixtureViewport(request)) {
      testLog(
        `viewport-reject:${JSON.stringify({ request, fixtureViewportRevision, fixtureViewport, currentPresentation, displayMode: fixtureSettings.island.displayMode })}`
      )
      return undefined
    }
    return positionFixtureWindow(target)
  })
  ipcMain.handle(CHANNELS.islandMove, (event, offset) => {
    islandMoveRequests.push(offset)
    const target = BrowserWindow.fromWebContents(event.sender)
    if (
      !target ||
      !currentPresentation.visible ||
      fixtureViewport.mode !== 'compact' ||
      fixtureSettings.island.displayMode !== 'taskbar'
    )
      return
    if (!offset || ![offset.x, offset.y].every(Number.isFinite)) return
    if (
      offset.x < 0 ||
      offset.y < 0 ||
      offset.x > fixtureLayout.compact.width ||
      offset.y > fixtureLayout.compact.height
    )
      return
    const pointer = fixturePointerScreen ?? screen.getCursorScreenPoint()
    fixtureTaskbarOffsetX = clampFixtureTaskbarOffset(
      pointer.x - offset.x - fixtureTaskbar.bounds.x
    )
    setFixtureLayout(target)
  })
  ipcMain.handle(CHANNELS.islandNudge, (event, direction) => {
    islandNudgeRequests.push(direction)
    const target = BrowserWindow.fromWebContents(event.sender)
    if (
      !target ||
      !currentPresentation.visible ||
      fixtureViewport.mode !== 'compact' ||
      fixtureSettings.island.displayMode !== 'taskbar' ||
      !direction ||
      !Number.isInteger(direction.x) ||
      Math.abs(direction.x) !== 1 ||
      direction.y !== 0
    )
      return
    fixtureTaskbarOffsetX = clampFixtureTaskbarOffset(
      getFixtureTaskbarOffsetX() + direction.x * KEYBOARD_NUDGE_STEP
    )
    setFixtureLayout(target)
  })
  ipcMain.handle(CHANNELS.islandDragFinished, () => {
    if (fixtureSettings.island.displayMode !== 'taskbar' || fixtureViewport.mode !== 'compact')
      return
    islandDragFinishedCount++
  })
}

function snapshot(status, count = 1, suffix = '') {
  const request =
    status === 'waiting-approval'
      ? [
          {
            id: `request-approval${suffix}`,
            kind: 'approval',
            summary: '请求执行本地验证命令',
            createdAt: 2
          }
        ]
      : status === 'waiting-input'
        ? [{ id: `request-input${suffix}`, kind: 'input', summary: '请选择发布渠道', createdAt: 2 }]
        : []
  return {
    tasks: Array.from({ length: count }, (_, index) => ({
      hostId: 'local',
      threadId: `thread-${index + 1}`,
      turnId: `turn-${index + 1}`,
      title: `测试任务 ${index + 1}`,
      project: 'codex-status-line',
      phase: ['completed', 'failed', 'stopped'].includes(status) ? status : 'running',
      startedAt: Date.now() - 8_000,
      updatedAt: 2,
      requests: request,
      latestEventId: `event-${status}-${index + 1}${suffix}`
    })),
    counts: {
      'waiting-approval': status === 'waiting-approval' ? count : 0,
      'waiting-input': status === 'waiting-input' ? count : 0,
      running: request.length ? 0 : count,
      completed: 0,
      failed: 0,
      stopped: 0
    },
    connection: { hooks: true, ipc: true, precise: true },
    viewedEventIds: []
  }
}

function resolveFixtureLayout() {
  const options = {
    display: fixtureDisplay,
    displays: [fixtureDisplay],
    displayMode: fixtureSettings.island.displayMode
  }
  return fixtureSettings.island.displayMode === 'taskbar'
    ? resolveIslandLayout({
        ...options,
        taskbar: fixtureTaskbar,
        taskbarOffsetX: fixtureTaskbarOffsetX
      })
    : resolveIslandLayout(options)
}

function resolveFixtureViewportLayout() {
  const layout = resolveFixtureLayout()
  return process.platform === 'win32'
    ? resolveIslandDrawingLayout(layout)
    : fitIslandViewport(layout, fixtureViewport, fixturePreviousViewports)
}

function updateFixtureViewport(value) {
  const request = normalizeIslandViewportRequest(value)
  if (
    !request ||
    !currentPresentation.visible ||
    request.displayMode !== fixtureSettings.island.displayMode ||
    request.presentationRevision !== currentPresentation.revision
  )
    return undefined
  if (request.revision < fixtureViewportRevision) return undefined
  if (request.phase === 'settle' && request.revision !== fixtureViewportRevision) return undefined
  if (
    request.phase === 'settle' &&
    (request.mode !== fixtureViewport.mode ||
      request.expandedHeight !== fixtureViewport.expandedHeight ||
      request.hasSatellite !== fixtureViewport.hasSatellite)
  )
    return undefined

  fixturePreviousViewports =
    request.phase === 'prepare' ? [...fixturePreviousViewports, fixtureViewport] : []
  fixtureViewportRevision = request.revision
  fixtureViewport = {
    mode: request.mode,
    expandedHeight: request.expandedHeight,
    hasSatellite: request.hasSatellite
  }
  return true
}

function setFixtureLayout(window) {
  return positionFixtureWindow(window).layout
}

function positionFixtureWindow(window) {
  fixtureLayout = resolveFixtureViewportLayout()
  if (!sameFixtureRect(window.getBounds(), fixtureLayout.bounds)) {
    window.setBounds(fixtureLayout.bounds)
  }
  if (process.platform === 'win32') applyFixtureWindowRegion(window, fixtureLayout)
  const update = {
    layout: fixtureLayout,
    pointer: fixturePointerForWindow(window)
  }
  window.webContents.send(CHANNELS.islandLayout, update)
  return update
}

function applyFixtureWindowRegion(window, layout) {
  const viewport = fitIslandViewport(layout, fixtureViewport, fixturePreviousViewports)
  const region = {
    x: viewport.bounds.x - layout.bounds.x,
    y: viewport.bounds.y - layout.bounds.y,
    width: viewport.bounds.width,
    height: viewport.bounds.height
  }
  if (sameFixtureRect(fixtureWindowRegions.get(window), region)) return
  // 与生产保持同一固定画布，只裁剪原生区域，避免改动 HWND 绘图坐标。
  window.setShape([region])
  fixtureWindowRegions.set(window, region)
}

function sameFixtureRect(left, right) {
  return (
    left !== undefined &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  )
}

function fixturePointerForWindow(window) {
  const pointer = fixturePointerScreen ?? screen.getCursorScreenPoint()
  const contentBounds = window.getContentBounds()
  return { x: pointer.x - contentBounds.x, y: pointer.y - contentBounds.y }
}

function setFixtureDisplayMode(window, displayMode) {
  fixtureSettings = {
    ...fixtureSettings,
    island: { ...fixtureSettings.island, displayMode }
  }
  window.webContents.send(CHANNELS.preferencesUpdated, { settings: fixtureSettings })
  fixtureViewport = { ...DEFAULT_ISLAND_VIEWPORT }
  fixturePreviousViewports = []
  const layout = setFixtureLayout(window)
  // 设置模式会强制开启新显示周期，使旧模式事务的迟到响应失效。
  sendPresentation(window, currentPresentation.visible)
  return layout
}

function setFixtureTaskbarTheme(window, dark) {
  fixtureTaskbar = { ...fixtureTaskbar, dark }
  return setFixtureLayout(window)
}

function setFixtureTaskbarOffset(window, offsetX) {
  fixtureTaskbarOffsetX = clampFixtureTaskbarOffset(offsetX)
  return setFixtureLayout(window)
}

function getFixtureTaskbarOffsetX() {
  return (
    fixtureTaskbarOffsetX ??
    fixtureLayout.bounds.x + fixtureLayout.compact.x - fixtureTaskbar.bounds.x
  )
}

function getFixtureTaskbarMaxOffset() {
  return Math.max(0, fixtureTaskbar.bounds.width - TASKBAR_BUTTON_WIDTH)
}

function clampFixtureTaskbarOffset(offsetX) {
  return Math.min(Math.max(0, offsetX), getFixtureTaskbarMaxOffset())
}

function assertRectMatches(actual, expected) {
  for (const key of ['x', 'y', 'width', 'height']) {
    assert.ok(
      Math.abs(actual[key] - expected[key]) < 1,
      `${key}: ${actual[key]} != ${expected[key]}`
    )
  }
}

function screenRectForLayout(layout, rect) {
  return {
    x: layout.bounds.x + rect.x,
    y: layout.bounds.y + rect.y,
    width: rect.width,
    height: rect.height
  }
}

function assertRectWithinWindow(rect, window) {
  const bounds = window.getBounds()
  assert.ok(rect.x >= -1 && rect.y >= -1, JSON.stringify(rect))
  assert.ok(rect.x + rect.width <= bounds.width + 1, JSON.stringify(rect))
  assert.ok(rect.y + rect.height <= bounds.height + 1, JSON.stringify(rect))
}

async function saveEdgeScreenshot(window, name) {
  if (!screenshotDirectory || process.env.ISLAND_TEST_REDUCED_MOTION === '1') return
  mkdirSync(screenshotDirectory, { recursive: true })
  const image = await window.webContents.capturePage()
  writeFileSync(join(screenshotDirectory, `island-${name}.png`), image.toPNG())
}

async function inspect(window) {
  assertRendererHealthy()
  const result = await window.webContents.executeJavaScript(`(() => {
    const islandWindow = document.querySelector('.island-window')
    const island = document.querySelector('.island')
    const bounds = island.getBoundingClientRect()
    const style = getComputedStyle(island)
    const taskbarAnchor = document.querySelector('.taskbar-anchor')
    const taskbarAnchorStyle = taskbarAnchor ? getComputedStyle(taskbarAnchor) : undefined
    const taskbarIndicatorStyle = taskbarAnchor ? getComputedStyle(taskbarAnchor, '::after') : undefined
    const rectOf = (element) => {
      if (!element) return undefined
      const rect = element.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    }
    const stage = document.querySelector('.island-stage')
    const compact = document.querySelector('.compact')
    const compactLeading = document.querySelector('.compact .compact-leading')
    const compactTrailing = document.querySelector('.compact .compact-trailing')
    const textStyleOf = (element) => {
      const computed = getComputedStyle(element)
      return { fontSize: computed.fontSize, fontWeight: computed.fontWeight, color: computed.color }
    }
    const tasks = document.querySelector('.task-list')
    const firstTask = document.querySelector('.task')
    const satellite = document.querySelector('.satellite')
    const hitBridgeRects = Array.from(document.querySelectorAll('.island-hit-bridge')).map(rectOf)
    const expandedControlRects = Array.from(
      document.querySelectorAll('.expanded .collapse, .expanded .task')
    ).map(rectOf)
    const satelliteIcon = document.querySelector('.satellite .status-icon')
    const statusIcon = document.querySelector('.status-glyph .status-icon')
    const brand = document.querySelector('.brand-icon')
    const waveformBars = Array.from(document.querySelectorAll('.compact .waveform i'))
    const waveformStatuses = Array.from(document.querySelectorAll('.compact .waveform')).map(
      (waveform) => waveform.dataset.status
    )
    const taskWaveforms = Array.from(document.querySelectorAll('.task')).map((task) => {
      const bars = Array.from(task.querySelectorAll('.waveform i'))
      return {
        status: task.dataset.status,
        animationNames: bars.map((bar) => getComputedStyle(bar).animationName),
        animationStates: bars.map((bar) => getComputedStyle(bar).animationPlayState),
        activeAnimationCount: bars.reduce(
          (total, bar) =>
            total + bar.getAnimations().filter((item) => item.playState === 'running').length,
          0
        )
      }
    })
    const rules = Array.from(document.styleSheets).flatMap((sheet) => Array.from(sheet.cssRules))
    return {
      mode: document.querySelector('.island-window').dataset.mode,
      displayMode: islandWindow?.dataset.displayMode,
      taskbarTheme: islandWindow?.dataset.taskbarTheme,
      viewportRebasing: islandWindow?.dataset.viewportRebasing === 'true',
      taskbarColorScheme: islandWindow ? getComputedStyle(islandWindow).colorScheme : '',
      width: bounds.width,
      height: bounds.height,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      center: bounds.left + bounds.width / 2,
      islandRect: rectOf(island),
      compactRect: rectOf(compact),
      taskbarAnchorRect: rectOf(taskbarAnchor),
      taskbarAnchorBorderRadius: taskbarAnchorStyle?.borderRadius,
      taskbarIndicator: taskbarIndicatorStyle && {
        width: taskbarIndicatorStyle.width, height: taskbarIndicatorStyle.height,
        bottom: taskbarIndicatorStyle.bottom, left: taskbarIndicatorStyle.left,
        transform: taskbarIndicatorStyle.transform, color: taskbarIndicatorStyle.backgroundColor
      },
      taskbarFeedback: taskbarAnchor && {
        hoveredAttribute: taskbarAnchor.dataset.hovered,
        pressedAttribute: taskbarAnchor.dataset.pressed,
        hovered: taskbarAnchor.dataset.hovered === 'true',
        pressed: taskbarAnchor.dataset.pressed === 'true',
        selected: taskbarAnchor.getAttribute('aria-expanded') === 'true',
        nativeHovered: taskbarAnchor.matches(':hover'),
        focused: document.activeElement === taskbarAnchor,
        focusVisible: taskbarAnchor.matches(':focus-visible'),
        anchorBackground: taskbarAnchorStyle.backgroundColor,
        baseBackground: taskbarAnchorStyle.getPropertyValue('--taskbar-button'),
        hoverBackground: taskbarAnchorStyle.getPropertyValue('--taskbar-button-hover'),
        selectedBackground: taskbarAnchorStyle.getPropertyValue('--taskbar-button-selected'),
        pressedBackground: taskbarAnchorStyle.getPropertyValue('--taskbar-button-pressed'),
        borderColor: taskbarAnchorStyle.borderTopColor,
        outlineStyle: taskbarAnchorStyle.outlineStyle,
        outlineWidth: taskbarAnchorStyle.outlineWidth,
        outlineColor: taskbarAnchorStyle.outlineColor
      },
      satelliteRect: rectOf(satellite),
      satellitePresent: Boolean(satellite),
      hitBridgeRects,
      expandedControlRects,
      direction: stage?.dataset.direction,
      dragging: stage?.dataset.dragging === 'true',
      transform: style.transform,
      taskRows: document.querySelectorAll('.task').length,
      compactLabel: compactLeading?.textContent.trim() ?? '',
      compactTrailing: compactTrailing?.textContent.trim() ?? '',
      compactTextStyle: { leading: textStyleOf(compactLeading), trailing: textStyleOf(compactTrailing) },
      compactTrailingDisplay: getComputedStyle(compactTrailing).display,
      compactContent: {
        button: rectOf(compact),
        icon: rectOf(compactLeading.querySelector('.brand-icon')),
        label: rectOf(compactLeading.querySelector('.compact-label')),
        time: rectOf(compactTrailing)
      },
      taskbarDetails: firstTask && {
        titleWhiteSpace: getComputedStyle(document.querySelector('.task-title')).whiteSpace,
        projectWhiteSpace: getComputedStyle(document.querySelector('.task-meta')).whiteSpace,
        listOverflowY: getComputedStyle(tasks).overflowY,
        listScrollHeight: tasks.scrollHeight,
        listClientHeight: tasks.clientHeight,
        titleScrollWidth: document.querySelector('.task-title').scrollWidth,
        titleClientWidth: document.querySelector('.task-title').clientWidth,
        projectScrollWidth: document.querySelector('.task-meta').scrollWidth,
        projectClientWidth: document.querySelector('.task-meta').clientWidth,
        duration: document.querySelector('.task-aside time').textContent
      },
      preview: compactLeading?.textContent.trim() === '待命',
      hasTaskHoverRule: rules.some((rule) => rule.selectorText === '.task:hover'),
      hasTaskFocusRule: rules.some((rule) => rule.selectorText === '.task:focus-visible'),
      cssWidth: style.getPropertyValue('--width').trim(),
      cssHeight: style.getPropertyValue('--height').trim(),
      expandedHeight: island.style.getPropertyValue('--expanded-height'),
      scrollable: tasks?.dataset.scrollable === 'true',
      transition: style.transitionDuration,
      fontFamily: style.fontFamily,
      satelliteStatus: satellite?.dataset.status,
      stageMultiple: document.querySelector('.island-stage')?.dataset.multiple,
      satelliteLeft: satellite?.getBoundingClientRect().left,
      satelliteRight: satellite?.getBoundingClientRect().right,
      satelliteIconFill: satelliteIcon ? getComputedStyle(satelliteIcon).fill : '',
      statusColor: statusIcon ? getComputedStyle(statusIcon).color : '',
      islandOpacity: Number(style.opacity),
      cardMode: island.dataset.mode,
      popupVisible: island.dataset.popupVisible === 'true',
      islandBackground: style.backgroundColor,
      islandBorderRadius: style.borderRadius,
      islandBoxShadow: style.boxShadow,
      islandColor: style.color,
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      brandFill: brand ? getComputedStyle(brand).fill : '',
      brandWidth: brand ? getComputedStyle(brand).width : '',
      waveformAnimationNames: waveformBars.map(
        (bar) => getComputedStyle(bar).animationName
      ),
      waveformStatuses,
      waveformAnimationDurations: waveformBars.map(
        (bar) => getComputedStyle(bar).animationDuration
      ),
      waveformAnimationStates: waveformBars.map(
        (bar) => getComputedStyle(bar).animationPlayState
      ),
      waveformActiveAnimationCount: waveformBars.reduce(
        (total, bar) => total + bar.getAnimations().filter((item) => item.playState === 'running').length,
        0
      ),
      taskWaveforms
    }
  })()`)
  assertRendererHealthy()
  return result
}

async function inspectPixels(window) {
  assertRendererHealthy()
  const point = await elementCenter(window, '.island')
  const image = await window.webContents.capturePage()
  const size = image.getSize()
  const bitmap = image.toBitmap()
  const alphaAt = (x, y) => bitmap[(y * size.width + x) * 4 + 3]
  return {
    size,
    centerAlpha: alphaAt(
      Math.round((point.x * size.width) / fixtureLayout.bounds.width),
      Math.round((point.y * size.height) / fixtureLayout.bounds.height)
    ),
    cornerAlpha: alphaAt(4, 4)
  }
}

async function dispatchPointerMove(window, x, y) {
  assertRendererHealthy()
  const contentBounds = window.getContentBounds()
  fixturePointerScreen = { x: contentBounds.x + x, y: contentBounds.y + y }
  await window.webContents.executeJavaScript(
    `document.dispatchEvent(new PointerEvent('pointermove', { clientX: ${x}, clientY: ${y}, bubbles: true }))`
  )
  assertRendererHealthy()
}

async function dispatchNativeMoveAt(window, selector) {
  return dispatchNativeMove(window, await elementCenter(window, selector))
}

async function dispatchNativeMoveOutside(window) {
  return dispatchNativeMove(window, await outsidePointerPoint(window))
}

async function dispatchNativeMove(window, point) {
  const x = Math.round(point.x)
  const y = Math.round(point.y)
  const bounds = window.getContentBounds()
  // sendInputEvent 不移动系统光标；夹具 pointer 不代替桌面输入验收。
  fixturePointerScreen = { x: bounds.x + x, y: bounds.y + y }
  // 夹具只使用注入坐标，不能再混入桌面真实光标的位置。
  window.setIgnoreMouseEvents(true)
  window.focus()
  await retry(() => assert.equal(window.isFocused(), true))
  await window.webContents.executeJavaScript(`(() => {
    window.__fixturePointerScreen = ${JSON.stringify(fixturePointerScreen)}
    if (window.__trustedPointerCapture) return
    window.__trustedPointerCapture = true
    document.addEventListener('pointermove', event => {
      if (event.isTrusted) window.__trustedPointerClient = { x: event.clientX, y: event.clientY }
    }, true)
  })()`)
  window.webContents.sendInputEvent({ type: 'mouseMove', x, y })
  return { x, y }
}

async function dispatchNativeClickAt(window, selector) {
  const point = await dispatchNativeMoveAt(window, selector)
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
}
async function elementCenter(window, selector) {
  return window.webContents.executeJavaScript(`(() => {
    const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`)
}

async function dispatchPointerMoveAt(window, selector) {
  const point = await elementCenter(window, selector)
  await dispatchPointerMove(window, point.x, point.y)
}

async function dispatchDragStartAndMove(window, selector) {
  const contentBounds = window.getContentBounds()
  const pointer = await window.webContents.executeJavaScript(`(() => {
    if (!window.__islandPointerCaptureShim) {
      Object.defineProperties(Element.prototype, {
        setPointerCapture: { configurable: true, value() {} },
        hasPointerCapture: { configurable: true, value() { return true } },
        releasePointerCapture: { configurable: true, value() {} }
      })
      window.__islandPointerCaptureShim = true
    }
    const target = document.querySelector(${JSON.stringify(selector)})
    const rect = target.getBoundingClientRect()
    const pointerId = 73
    const clientX = rect.left + rect.width / 2
    const clientY = rect.top + rect.height / 2
    const offset = { x: clientX - rect.left, y: clientY - rect.top }
    const eventInit = {
      bubbles: true,
      cancelable: true,
      pointerId,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: 1,
      clientX,
      clientY,
      screenX: ${contentBounds.x} + clientX,
      screenY: ${contentBounds.y} + clientY
    }
    target.dispatchEvent(new PointerEvent('pointerdown', eventInit))
    target.dispatchEvent(new PointerEvent('pointermove', {
      ...eventInit,
      clientX: clientX + ${DRAG_THRESHOLD_DELTA},
      clientY: clientY + ${DRAG_THRESHOLD_DELTA},
      screenX: ${contentBounds.x} + clientX + ${DRAG_THRESHOLD_DELTA},
      screenY: ${contentBounds.y} + clientY + ${DRAG_THRESHOLD_DELTA}
    }))
    return { pointerId, clientX, clientY, offset }
  })()`)
  fixturePointerScreen = {
    x: contentBounds.x + pointer.clientX + DRAG_THRESHOLD_DELTA,
    y: contentBounds.y + pointer.clientY + DRAG_THRESHOLD_DELTA
  }
  return pointer
}

async function dispatchPointerStartAndFinish(window, selector) {
  const contentBounds = window.getContentBounds()
  const pointer = await window.webContents.executeJavaScript(`(() => {
    if (!window.__islandPointerCaptureShim) {
      Object.defineProperties(Element.prototype, {
        setPointerCapture: { configurable: true, value() {} },
        hasPointerCapture: { configurable: true, value() { return true } },
        releasePointerCapture: { configurable: true, value() {} }
      })
      window.__islandPointerCaptureShim = true
    }
    const target = document.querySelector(${JSON.stringify(selector)})
    const rect = target.getBoundingClientRect()
    const pointerId = ${STATIONARY_POINTER_ID}
    const clientX = rect.left + rect.width / 2
    const clientY = rect.top + rect.height / 2
    target.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerId,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: 1,
      clientX,
      clientY,
      screenX: ${contentBounds.x} + clientX,
      screenY: ${contentBounds.y} + clientY
    }))
    return { pointerId, clientX, clientY }
  })()`)
  fixturePointerScreen = {
    x: contentBounds.x + pointer.clientX,
    y: contentBounds.y + pointer.clientY
  }
  await dispatchPointerUp(window, selector, pointer)
}

async function dispatchPointerUp(window, selector, pointer) {
  const contentBounds = window.getContentBounds()
  const screenPoint = fixturePointerScreen ?? {
    x: contentBounds.x + pointer.clientX,
    y: contentBounds.y + pointer.clientY
  }
  const clientPoint = {
    x: screenPoint.x - contentBounds.x,
    y: screenPoint.y - contentBounds.y
  }
  await window.webContents.executeJavaScript(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)})
    target.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true,
      cancelable: true,
      pointerId: ${pointer.pointerId},
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: 0,
      clientX: ${clientPoint.x},
      clientY: ${clientPoint.y},
      screenX: ${screenPoint.x},
      screenY: ${screenPoint.y}
    }))
  })()`)
}

async function dispatchPointerMoveOutside(window) {
  const point = await outsidePointerPoint(window)
  await dispatchPointerMove(window, point.x, point.y)
}

async function outsidePointerPoint(window) {
  return window.webContents.executeJavaScript(`(() => {
    const occupied = Array.from(document.querySelectorAll('.island, .taskbar-anchor, .satellite, .island-hit-bridge'))
      .map((element) => element.getBoundingClientRect())
    const candidates = [
      { x: 1, y: 1 },
      { x: innerWidth - 2, y: 1 },
      { x: 1, y: innerHeight - 2 },
      { x: innerWidth - 2, y: innerHeight - 2 }
    ]
    return candidates.find((point) => !occupied.some((rect) =>
      point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
    )) ?? { x: -1, y: -1 }
  })()`)
}

async function dispatchPointerMovesAcrossFrames(window, x, y, count, frameCount) {
  assertRendererHealthy()
  const contentBounds = window.getContentBounds()
  fixturePointerScreen = { x: contentBounds.x + x, y: contentBounds.y + y }
  await window.webContents.executeJavaScript(`(async () => {
    const perFrame = Math.ceil(${count} / ${frameCount})
    for (let frame = 0; frame < ${frameCount}; frame++) {
      const remaining = ${count} - frame * perFrame
      for (let index = 0; index < Math.min(perFrame, remaining); index++) {
        document.dispatchEvent(new PointerEvent('pointermove', {
          clientX: ${x},
          clientY: ${y},
          bubbles: true
        }))
      }
      await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame))
    }
  })()`)
  assertRendererHealthy()
}

async function dispatchClickAt(window, selector, x, y) {
  if (x === undefined || y === undefined) {
    const point = await elementCenter(window, selector)
    x = point.x
    y = point.y
  }
  const contentBounds = window.getContentBounds()
  fixturePointerScreen = { x: contentBounds.x + x, y: contentBounds.y + y }
  await window.webContents.executeJavaScript(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)})
    target.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
      detail: 1,
      clientX: ${x},
      clientY: ${y}
    }))
  })()`)
}

async function dispatchPointerEnterAt(window, selector) {
  const point = await elementCenter(window, selector)
  await dispatchPointerEnter(window, point.x, point.y)
}

async function dispatchPointerEnter(window, x, y) {
  const contentBounds = window.getContentBounds()
  fixturePointerScreen = { x: contentBounds.x + x, y: contentBounds.y + y }
  await window.webContents.executeJavaScript(`(() => {
    const stage = document.querySelector('.island-stage')
    stage.dispatchEvent(new PointerEvent('pointerover', {
      bubbles: true,
      clientX: ${x},
      clientY: ${y},
      relatedTarget: null
    }))
  })()`)
}

async function pointerPointForElement(window, selector, inside) {
  const point = inside ? await elementCenter(window, selector) : await outsidePointerPoint(window)
  return { ...point, outside: !inside }
}

async function dispatchPointerOutAt(window, selector, inside, existingPoint) {
  const point = existingPoint ?? (await pointerPointForElement(window, selector, inside))
  const contentBounds = window.getContentBounds()
  fixturePointerScreen = { x: contentBounds.x + point.x, y: contentBounds.y + point.y }
  await window.webContents.executeJavaScript(`(() => {
    document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new PointerEvent('pointerout', {
      bubbles: true,
      cancelable: true,
      pointerId: ${TASKBAR_POINTER_ID},
      pointerType: 'mouse',
      isPrimary: true,
      buttons: 0,
      clientX: ${point.x},
      clientY: ${point.y},
      screenX: ${fixturePointerScreen.x},
      screenY: ${fixturePointerScreen.y},
      relatedTarget: null
    }))
  })()`)
  return point
}

async function dispatchDocumentLeaveAt(window, selector) {
  const point = await pointerPointForElement(window, selector, false)
  const contentBounds = window.getContentBounds()
  fixturePointerScreen = { x: contentBounds.x + point.x, y: contentBounds.y + point.y }
  await window.webContents.executeJavaScript(`document.dispatchEvent(new MouseEvent('mouseleave', {
    clientX: ${point.x},
    clientY: ${point.y},
    screenX: ${fixturePointerScreen.x},
    screenY: ${fixturePointerScreen.y},
    relatedTarget: null
  }))`)
}

async function dispatchPointerLeave(window) {
  const contentBounds = window.getContentBounds()
  fixturePointerScreen = { x: contentBounds.x + 10, y: contentBounds.y + 300 }
  await window.webContents.executeJavaScript(`(() => {
    const stage = document.querySelector('.island-stage')
    stage.dispatchEvent(
      new PointerEvent('pointerout', {
        bubbles: true,
        clientX: 10,
        clientY: 300,
        relatedTarget: null
      })
    )
  })()`)
}

function diagnosticEvents() {
  return diagnosticBatches.flatMap((batch) => (Array.isArray(batch?.events) ? batch.events : []))
}

function lastDiagnosticEvent(predicate) {
  const events = diagnosticEvents()
  for (let index = events.length - 1; index >= 0; index--) {
    if (predicate(events[index])) return events[index]
  }
  return undefined
}

async function waitForMode(window, mode) {
  await retry(async () => {
    const current = await inspect(window)
    assert.equal(current.mode, mode)
    assert.equal(current.viewportRebasing, false)
    const stable = await window.webContents.executeJavaScript(`new Promise((resolveStable) => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        resolveStable({
          mode: document.querySelector('.island-window').dataset.mode,
          rebasing: document.querySelector('.island-window').dataset.viewportRebasing === 'true'
        })
      }))
    })`)
    assert.equal(stable.mode, mode)
    assert.equal(stable.rebasing, false)
  }, VIEWPORT_SETTLE_ATTEMPTS)
}

async function retry(check, attempts = 20) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await check()
    } catch (error) {
      lastError = error
      await delay(25)
    }
  }
  throw lastError
}

function delay(ms) {
  return new Promise((resolveDelay, rejectDelay) =>
    setTimeout(() => {
      try {
        assertRendererHealthy()
        resolveDelay()
      } catch (error) {
        rejectDelay(error)
      }
    }, ms)
  )
}

function targetLayout(value) {
  return {
    mode: value.mode,
    width: value.cssWidth,
    height: value.cssHeight,
    expandedHeight: value.expandedHeight,
    taskRows: value.taskRows,
    scrollable: value.scrollable
  }
}

function timeout(ms) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Island renderer ready timeout')), ms)
  )
}
