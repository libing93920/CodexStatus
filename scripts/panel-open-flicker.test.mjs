import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const [mainSource, appSource, cssSource] = await Promise.all([
  readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/renderer/src/assets/main.css', import.meta.url), 'utf8')
])

test('隐藏 Panel 等待 renderer ready 后再显示', () => {
  const start = mainSource.indexOf('function openPanelWindow(')
  assert.notEqual(start, -1, 'missing function openPanelWindow')
  const nextFunction = mainSource.indexOf('\nfunction ', start + 1)
  const openPanelWindow = mainSource.slice(
    start,
    nextFunction === -1 ? mainSource.length : nextFunction
  )

  assert.doesNotMatch(openPanelWindow, /panelWindow\.show\(\)/)
  assert.match(openPanelWindow, /panelWindow\.webContents\.send\(CHANNELS\.command/)
})

test('每次页面命令都触发新的 ready 提交', () => {
  assert.match(appSource, /setPanelRevealRequest\(\(value\) => value \+ 1\)/)
  assert.match(appSource, /\[ready, windowRole, panelRevealRequest\]/)
})

test('隐藏 Panel 更新前开启绘制，显示后恢复后台节流', () => {
  const openStart = mainSource.indexOf('function openPanelWindow(')
  const openEnd = mainSource.indexOf('\nfunction ', openStart + 1)
  const openPanelWindow = mainSource.slice(openStart, openEnd)
  const enablePainting = openPanelWindow.indexOf('setBackgroundThrottling(false)')
  const sendCommand = openPanelWindow.indexOf('webContents.send(CHANNELS.command')

  assert.notEqual(enablePainting, -1)
  assert.ok(enablePainting < sendCommand)

  const readyStart = mainSource.indexOf('ipcMain.handle(CHANNELS.panelReady')
  const readyEnd = mainSource.indexOf('ipcMain.handle(CHANNELS.showPanel', readyStart)
  const panelReadyHandler = mainSource.slice(readyStart, readyEnd)
  assert.match(panelReadyHandler, /setBackgroundThrottling\(true\)/)
})

test('隐藏 Panel 透明显示预热后再发送页面命令', () => {
  const openStart = mainSource.indexOf('function openPanelWindow(')
  const openEnd = mainSource.indexOf('\nfunction ', openStart + 1)
  const openPanelWindow = mainSource.slice(openStart, openEnd)
  const makeTransparent = openPanelWindow.indexOf('setOpacity(0)')
  const startPainting = openPanelWindow.indexOf('showInactive()')
  const sendCommand = openPanelWindow.indexOf('webContents.send(CHANNELS.command')

  assert.notEqual(makeTransparent, -1)
  assert.ok(makeTransparent < startPainting)
  assert.ok(startPainting < sendCommand)
})

test('Panel ready 只完成当前 reveal 并恢复不透明', () => {
  const readyStart = mainSource.indexOf('ipcMain.handle(CHANNELS.panelReady')
  const readyEnd = mainSource.indexOf('ipcMain.handle(CHANNELS.showPanel', readyStart)
  const panelReadyHandler = mainSource.slice(readyStart, readyEnd)

  assert.match(panelReadyHandler, /panelRevealPending/)
  assert.match(panelReadyHandler, /setOpacity\(1\)/)
  assert.ok(panelReadyHandler.indexOf('setOpacity(1)') < panelReadyHandler.indexOf('focus()'))
})

test('关闭预热中的 Panel 会取消迟到的 ready', () => {
  const showStart = mainSource.indexOf('ipcMain.handle(CHANNELS.showPanel')
  const showEnd = mainSource.indexOf('ipcMain.handle(CHANNELS.checkUpdate', showStart)
  const showPanelHandler = mainSource.slice(showStart, showEnd)

  assert.match(showPanelHandler, /panelRevealPending = false/)
  assert.match(showPanelHandler, /setOpacity\(1\)/)
})

test('隐藏 Panel 完成一帧绘制后再发送 ready', () => {
  const start = appSource.indexOf('// panel 窗口显示时机:')
  assert.notEqual(start, -1, 'missing panel ready effect')
  const closePanel = appSource.indexOf('\n  function closePanel', start)
  const panelReadyEffect = appSource.slice(start, closePanel)

  assert.equal(panelReadyEffect.match(/requestAnimationFrame/g)?.length, 2)
  assert.match(panelReadyEffect, /void window\.codexStatus\.notifyPanelReady\(\)/)
})

test('Panel 内容不再执行 rise-in 动画', () => {
  assert.doesNotMatch(cssSource, /animation:\s*rise-in/)
  assert.match(cssSource, /animation:\s*panel-in/)
})
