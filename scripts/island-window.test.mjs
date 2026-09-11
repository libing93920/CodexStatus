/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { app, BrowserWindow, ipcMain, screen } from 'electron'

app.setPath('userData', join(tmpdir(), `codex-status-island-test-${process.pid}`))
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('no-sandbox')
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
  islandInteractive: 'codex-status:island-interactive',
  islandOpenTask: 'codex-status:island-open-task',
  islandDismissTask: 'codex-status:island-dismiss-task'
}
const EXIT_TIMEOUT_MS = 1_500
const testLogPath = process.env.ISLAND_TEST_LOG

function testLog(stage) {
  if (!testLogPath) return
  appendFileSync(testLogPath, `${new Date().toISOString()} ${stage}\n`)
}

let openedThread
let ready
let resolveHidden
let hiddenRevision
let interactions = []
let readyCount = 0
const readyPromise = new Promise((resolveReady) => (ready = resolveReady))

async function verifyIslandWindow() {
  testLog('verify:start')
  await app.whenReady()
  testLog('verify:app-ready')
  registerHandlers()
  testLog('verify:handlers')
  const window = new BrowserWindow({
    show: false,
    width: 464,
    height: 416,
    frame: false,
    transparent: true,
    webPreferences: {
      preload: resolve('out/preload/index.js'),
      sandbox: false,
      backgroundThrottling: false
    }
  })
  try {
    const windowBounds = window.getBounds()
    assert.equal(windowBounds.width, 464)
    assert.ok(Math.abs(windowBounds.height - 416) <= (forcedScale ? 1 : 0))
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

    if (process.env.ISLAND_TEST_REDUCED_MOTION === '1') {
      const reducedMotion = await window.webContents.executeJavaScript(
        "window.matchMedia('(prefers-reduced-motion: reduce)').matches"
      )
      assert.equal(reducedMotion, true)
      window.webContents.send(CHANNELS.islandPresentation, { revision: 1, visible: true })
      await delay(100)
      assert.equal((await inspect(window)).mode, 'compact')
      const hidden = waitForHidden()
      const startedAt = Date.now()
      window.webContents.send(CHANNELS.islandPresentation, { revision: 2, visible: false })
      await hidden
      assert.equal(hiddenRevision, 2)
      assert.ok(Date.now() - startedAt < 250)
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

    window.webContents.send(CHANNELS.islandPresentation, { revision: 1, visible: true })
    await retry(async () => assert.equal((await inspect(window)).mode, 'compact'))
    await delay(700)
    assert.deepEqual(targetLayout(await inspect(window)), {
      mode: 'compact',
      width: '248px',
      height: '48px',
      expandedHeight: '200px',
      taskRows: 1,
      scrollable: false
    })
    assert.equal(Math.round((await inspect(window)).center), 232)
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
    await dispatchPointerMove(window, 232, 24)
    await retry(() => assert.equal(interactions.at(-1), true))
    await dispatchPointerMove(window, 10, 300)
    await retry(() => assert.equal(interactions.at(-1), false))
    await verifyStableCompactUpdates(window)

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
    assert.equal(alert.transition, '0.62s, 0.62s, 0.62s, 0.62s, 0.16s')
    assert.equal(alert.fontFamily.includes('SF Pro Text'), true)
    assert.equal(alert.islandBackground, 'rgb(0, 0, 0)')
    assert.equal(alert.bodyBackground, 'rgba(0, 0, 0, 0)')
    assert.equal(alert.brandFill, 'rgb(245, 245, 247)')
    assert.equal(alert.brandWidth, '23px')
    assert.notEqual(alert.satelliteIconFill, 'none')
    assert.equal(alert.statusColor, 'rgb(255, 159, 10)')
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
      width: Math.round(464 * captureScale),
      height: Math.round(416 * captureScale)
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

    await verifyExit(window)
    testLog('verify:exit')
    await verifyStaleAndRevive(window)
    testLog('verify:revive')
    await verifyInteractions(window)
    testLog('verify:interactions')
    await verifyAlertRules(window)
    testLog('verify:alerts')
    await verifyRecreate(window)
    testLog('verify:recreate')
  } finally {
    window.destroy()
  }
}

async function verifyExit(window) {
  const hidden = waitForHidden()
  window.webContents.send(CHANNELS.islandPresentation, { revision: 2, visible: false })
  window.webContents.send(CHANNELS.islandUpdated, snapshot('running', 0))
  await delay(50)
  assert.equal((await inspect(window)).taskRows, 4)
  await hidden
  assert.equal(hiddenRevision, 2)
}

async function verifyStaleAndRevive(window) {
  window.webContents.send(CHANNELS.islandUpdated, snapshot('running', 1))
  window.webContents.send(CHANNELS.islandPresentation, { revision: 3, visible: true })
  await delay(700)
  assert.equal((await inspect(window)).mode, 'compact')

  const hidden = waitForHidden()
  window.webContents.send(CHANNELS.islandPresentation, { revision: 4, visible: false })
  await delay(100)
  window.webContents.send(CHANNELS.islandPresentation, { revision: 5, visible: true })
  await delay(EXIT_TIMEOUT_MS)
  assert.equal((await inspect(window)).mode, 'compact')
  assert.notEqual(hiddenRevision, 4)
  clearHiddenWaiter(hidden)
}

async function verifyAlertRules(window) {
  testLog('alerts:start')
  window.webContents.send(CHANNELS.islandPresentation, { revision: 6, visible: true })
  await delay(700)
  testLog('alerts:shown')
  window.webContents.send(CHANNELS.islandUpdated, snapshot('completed', 1, '-auto'))
  await delay(900)
  testLog('alerts:completed-auto')
  assert.equal((await inspect(window)).mode, 'alert')
  await delay(5_200)
  testLog('alerts:auto-collapsed')
  assert.equal((await inspect(window)).mode, 'compact')

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

  window.webContents.send(CHANNELS.islandUpdated, snapshot('failed'))
  await delay(900)
  testLog('alerts:failed-shown')
  assert.equal((await inspect(window)).mode, 'alert')
  await window.webContents.executeJavaScript(
    "document.querySelector('.alert-footer button:last-of-type').click()"
  )
  assert.equal(openedThread, 'thread-1')
  await delay(700)
  testLog('alerts:failed-viewed')
  assert.equal((await inspect(window)).mode, 'alert')
  await window.webContents.executeJavaScript(
    "document.querySelector('.alert-footer button:first-of-type').click()"
  )
  await delay(700)
  testLog('alerts:failed-dismissed')
  assert.equal((await inspect(window)).mode, 'compact')

  window.webContents.send(CHANNELS.islandPresentation, { revision: 7, visible: true })
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
  window.webContents.send(CHANNELS.islandPresentation, { revision: 8, visible: false })
  await delay(500)
  testLog('alerts:end')
}

async function verifyRecreate(window) {
  const previousReadyCount = readyCount
  const loaded = new Promise((resolveLoad) =>
    window.webContents.once('did-finish-load', resolveLoad)
  )
  window.webContents.reload()
  await loaded
  await retry(() => assert.ok(readyCount > previousReadyCount))
  await delay(700)
  assert.equal((await inspect(window)).mode, 'compact')
}

async function verifyStableCompactUpdates(window) {
  await window.webContents.executeJavaScript(`(() => {
    window.__islandSamples = []
    window.__islandSampling = true
    const sample = () => {
      const island = document.querySelector('.island')
      window.__islandSamples.push({
        mode: island.dataset.mode,
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
  assert.equal(Math.round(compactReply.center), 203)
  assert.equal(Math.round(compactReply.satelliteLeft), 323)
  assert.equal(Math.round(compactReply.satelliteRight), 371)
  await dispatchPointerMove(window, 347, 24)
  await retry(() => assert.equal(interactions.at(-1), true))
  await dispatchPointerMove(window, 10, 24)
  await retry(() => assert.equal(interactions.at(-1), false))
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

verifyIslandWindow().then(
  () => app.quit(),
  (error) => {
    console.error(error)
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

function registerHandlers() {
  let presentationRevision = 0
  ipcMain.handle(CHANNELS.bootstrap, () => ({
    settings: { island: { enabled: true } },
    island: snapshot('running')
  }))
  ipcMain.handle(CHANNELS.islandReady, (event) => {
    readyCount++
    const target = BrowserWindow.fromWebContents(event.sender)
    setImmediate(() =>
      target?.webContents.send(CHANNELS.islandPresentation, {
        revision: ++presentationRevision,
        visible: true
      })
    )
    ready()
  })
  ipcMain.handle(CHANNELS.islandHidden, (_event, revision) => {
    hiddenRevision = revision
    resolveHidden?.(revision)
  })
  ipcMain.handle(CHANNELS.islandInteractive, (event, value) => {
    if (event.sender.id !== BrowserWindow.getAllWindows()[0]?.webContents.id) return
    interactions.push(value)
  })
  ipcMain.handle(CHANNELS.islandOpenTask, (_event, threadId) => {
    openedThread = threadId
    return true
  })
  ipcMain.handle(CHANNELS.islandDismissTask, () => true)
}

function snapshot(status, count = 1, suffix = '') {
  const request =
    status === 'waiting-approval'
      ? [
          {
            id: 'request-approval',
            kind: 'approval',
            summary: '请求执行本地验证命令',
            createdAt: 2
          }
        ]
      : status === 'waiting-input'
        ? [{ id: 'request-input', kind: 'input', summary: '请选择发布渠道', createdAt: 2 }]
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

async function inspect(window) {
  return window.webContents.executeJavaScript(`(() => {
    const island = document.querySelector('.island')
    const bounds = island.getBoundingClientRect()
    const style = getComputedStyle(island)
    const tasks = document.querySelector('.task-list')
    const satellite = document.querySelector('.satellite')
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
      mode: island.dataset.mode,
      width: bounds.width,
      height: bounds.height,
      center: bounds.left + bounds.width / 2,
      transform: style.transform,
      taskRows: document.querySelectorAll('.task').length,
      compactLabel: document.querySelector('.compact-leading')?.textContent.trim() ?? '',
      compactTrailing: document.querySelector('.compact-trailing')?.textContent.trim() ?? '',
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
      islandBackground: style.backgroundColor,
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
}

async function inspectPixels(window) {
  const image = await window.webContents.capturePage()
  const size = image.getSize()
  const bitmap = image.toBitmap()
  const alphaAt = (x, y) => bitmap[(y * size.width + x) * 4 + 3]
  return {
    size,
    centerAlpha: alphaAt(Math.round(size.width / 2), 100),
    cornerAlpha: alphaAt(4, 4)
  }
}

async function dispatchPointerMove(window, x, y) {
  await window.webContents.executeJavaScript(
    `document.dispatchEvent(new PointerEvent('pointermove', { clientX: ${x}, clientY: ${y}, bubbles: true }))`
  )
}

async function retry(check) {
  let lastError
  for (let attempt = 0; attempt < 20; attempt++) {
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
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
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
