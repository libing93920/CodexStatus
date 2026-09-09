/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'

app.setPath('userData', join(tmpdir(), `codex-status-island-test-${process.pid}`))
app.disableHardwareAcceleration()

const CHANNELS = {
  bootstrap: 'codex-status:bootstrap',
  preferencesUpdated: 'codex-status:preferences-updated',
  islandUpdated: 'codex-status:island-updated',
  islandReady: 'codex-status:island-ready',
  islandInteractive: 'codex-status:island-interactive',
  islandOpenTask: 'codex-status:island-open-task'
}

let openedThread
let ready
const readyPromise = new Promise((resolveReady) => (ready = resolveReady))

async function verifyIslandWindow() {
  await app.whenReady()
  registerHandlers()
  const window = new BrowserWindow({
    show: false,
    width: 424,
    height: 360,
    frame: false,
    transparent: true,
    webPreferences: {
      preload: resolve('out/preload/index.js'),
      sandbox: false,
      backgroundThrottling: false
    }
  })
  try {
    await window.loadFile(resolve('out/renderer/index.html'), { query: { window: 'island' } })
    await Promise.race([readyPromise, timeout(3_000)])
    assert.deepEqual(targetLayout(await inspect(window)), {
      mode: 'compact',
      width: '258px',
      height: '40px',
      expandedHeight: '170px',
      taskRows: 1,
      scrollable: false
    })
    window.webContents.send(CHANNELS.islandUpdated, snapshot('waiting-approval'))
    await delay(700)
    const alert = await inspect(window)
    assert.deepEqual(targetLayout(alert), {
      mode: 'alert',
      width: '376px',
      height: '158px',
      expandedHeight: '170px',
      taskRows: 1,
      scrollable: false
    })
    assert.equal(alert.transition, '0.6s, 0.6s, 0.5s')
    await window.webContents.executeJavaScript(
      "document.querySelector('.island-alert footer button').click()"
    )
    assert.equal(openedThread, 'thread-1')
    await window.webContents.executeJavaScript(
      "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))"
    )
    await window.webContents.executeJavaScript("document.querySelector('.island-compact').click()")
    await delay(700)
    assert.deepEqual(targetLayout(await inspect(window)), {
      mode: 'expanded',
      width: '396px',
      height: '170px',
      expandedHeight: '170px',
      taskRows: 1,
      scrollable: false
    })
    window.webContents.send(CHANNELS.islandUpdated, snapshot('running', 2))
    await delay(700)
    assert.equal((await inspect(window)).expandedHeight, '240px')
    window.webContents.send(CHANNELS.islandUpdated, snapshot('running', 4))
    await delay(700)
    assert.deepEqual(targetLayout(await inspect(window)), {
      mode: 'expanded',
      width: '396px',
      height: '310px',
      expandedHeight: '310px',
      taskRows: 4,
      scrollable: true
    })
  } finally {
    window.destroy()
  }
}

verifyIslandWindow().then(
  () => app.quit(),
  (error) => {
    console.error(error)
    app.exit(1)
  }
)

function registerHandlers() {
  ipcMain.handle(CHANNELS.bootstrap, () => ({
    settings: {
      island: { enabled: true }
    },
    island: snapshot('running')
  }))
  ipcMain.handle(CHANNELS.islandReady, () => ready())
  ipcMain.handle(CHANNELS.islandInteractive, () => undefined)
  ipcMain.handle(CHANNELS.islandOpenTask, (_event, threadId) => {
    openedThread = threadId
    return true
  })
}

function snapshot(status, count = 1) {
  const request =
    status === 'waiting-approval'
      ? [{ id: 'request-1', kind: 'approval', summary: '请求执行本地验证命令', createdAt: 2 }]
      : []
  return {
    tasks: Array.from({ length: count }, (_, index) => ({
      hostId: 'local',
      threadId: `thread-${index + 1}`,
      turnId: `turn-${index + 1}`,
      title: `测试任务 ${index + 1}`,
      project: 'codex-status-line',
      phase: 'running',
      startedAt: Date.now() - 8_000,
      updatedAt: 2,
      requests: request,
      latestEventId: `event-${status}-${index + 1}`
    })),
    counts: {
      'waiting-approval': request.length,
      'waiting-input': 0,
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
    const island = document.querySelector('.dynamic-island')
    const bounds = island.getBoundingClientRect()
    const style = getComputedStyle(island)
    const tasks = document.querySelector('.island-tasks')
    return { mode: island.dataset.mode, width: bounds.width, height: bounds.height, taskRows: document.querySelectorAll('.island-task').length, cssWidth: style.getPropertyValue('--width').trim(), cssHeight: style.getPropertyValue('--height').trim(), expandedHeight: island.style.getPropertyValue('--expanded-height'), scrollable: tasks.dataset.scrollable === 'true', transition: style.transitionDuration }
  })()`)
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
