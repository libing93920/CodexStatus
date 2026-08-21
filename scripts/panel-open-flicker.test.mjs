import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const [mainSource, appSource, cssSource] = (
  await Promise.all([
    readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/src/assets/main.css', import.meta.url), 'utf8')
  ])
).map((source) => source.replaceAll('\r\n', '\n'))

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

test('tab 动效只由用户切换到不同页面触发', () => {
  const handlerStart = appSource.indexOf('function handlePanelViewChange(')
  const handlerEnd = appSource.indexOf('\n  function ', handlerStart + 1)
  const handler = appSource.slice(handlerStart, handlerEnd)

  assert.notEqual(handlerStart, -1, 'missing handlePanelViewChange')
  assert.match(handler, /if \(view === panelView\)/)
  assert.match(handler, /setTabMotionView\(view\)/)

  const commandStart = appSource.indexOf('const disposeCommand = window.codexStatus.onCommand')
  const commandEnd = appSource.indexOf('const disposeUpdateProgress', commandStart)
  const commandHandler = appSource.slice(commandStart, commandEnd)
  const clearMotion = commandHandler.indexOf('setTabMotionView(null)')
  const changeView = commandHandler.indexOf('setPanelView(payload.panelView)')

  assert.notEqual(clearMotion, -1, 'external command must clear tab motion')
  assert.ok(clearMotion < changeView)
})

test('tab 卡片和内部信息使用两层错峰的 Quick Snap', () => {
  const selectorStart = cssSource.indexOf('.panel__body.is-tab-switching\n  :is(')
  const selectorEnd = cssSource.indexOf('{', selectorStart)
  const contentSelectors = cssSource.slice(selectorStart, selectorEnd)

  assert.notEqual(selectorStart, -1, 'missing tab content motion selector')
  assert.match(contentSelectors, /\.quota-card/)
  assert.match(contentSelectors, /\.usage-card/)
  assert.match(contentSelectors, /\.detail-row/)
  assert.match(contentSelectors, /\.settings-section/)
  assert.match(contentSelectors, /> \*/)
  assert.doesNotMatch(contentSelectors, /\.quota-grid/)
  assert.doesNotMatch(contentSelectors, /\.panel__rows/)
  assert.match(cssSource, /@keyframes panel-tab-content-snap/)
  assert.match(
    cssSource,
    /animation:\s*panel-tab-content-snap 380ms cubic-bezier\(0\.34, 1\.56, 0\.64, 1\) backwards/
  )
  assert.match(
    cssSource,
    /animation-delay:\s*calc\(var\(--panel-tab-card-delay, 0ms\) \+ var\(--panel-tab-content-delay, 0ms\)\)/
  )
  assert.match(cssSource, /\.quota-card:nth-child\(1\)[^{]*{[^}]*--panel-tab-card-delay:\s*40ms/s)
  assert.match(cssSource, /\.usage-card[^{]*{[^}]*--panel-tab-card-delay:\s*120ms/s)
  assert.match(
    cssSource,
    /\.detail-row:nth-child\(n \+ 3\)[^{]*{[^}]*--panel-tab-card-delay:\s*240ms/s
  )
  assert.match(cssSource, /--panel-tab-content-delay:\s*40ms/)
  assert.match(cssSource, /--panel-tab-content-delay:\s*80ms/)
  assert.match(cssSource, /--panel-tab-content-delay:\s*120ms/)
  assert.match(cssSource, /transform:\s*translateY\(10px\) scale\(0\.98\)/)
  assert.match(appSource, /const PANEL_TAB_MOTION_CLEAR_MS = 800/)
})

test('tab 栏和页面标题不参与窗口拖拽，避免重叠时拦截点击', () => {
  assert.match(cssSource, /\.panel__tabs\s*{[^}]*-webkit-app-region:\s*no-drag/s)
  assert.match(cssSource, /\.panel__header\s*{[^}]*-webkit-app-region:\s*no-drag/s)
})

test('排行榜模式和时间窗口切换会逐行上浮并消散模糊', () => {
  assert.match(appSource, /function handleTeamBoardModeChange\(/)
  assert.match(appSource, /function handleTeamTokenWindowChange\(/)
  assert.match(appSource, /is-team-switching/)
  assert.match(cssSource, /@keyframes team-row-rise-in/)
  assert.match(
    cssSource,
    /\.panel__body--team\.is-team-switching \.team-row\s*{[^}]*animation:\s*team-row-rise-in 576ms cubic-bezier\(0\.16, 1, 0\.3, 1\) backwards/s
  )
  assert.match(cssSource, /filter:\s*blur\(10px\)/)
  assert.match(cssSource, /transform:\s*translateY\(40px\) scale\(0\.94\)/)
  assert.doesNotMatch(cssSource, /@keyframes team-row-flip-in/)
  assert.doesNotMatch(cssSource, /rotateX\(-72deg\)/)
  assert.match(appSource, /'--team-row-delay'/)
  assert.match(appSource, /const TEAM_ROW_STAGGER_MS = 72/)
  assert.match(appSource, /const TEAM_BOARD_MOTION_CLEAR_MS = 1360/)
  assert.match(cssSource, /animation-delay:\s*var\(--team-row-delay, 0ms\)/)
})

test('排行榜冠军在上浮结束后扫光', () => {
  assert.match(cssSource, /@keyframes team-champion-shine/)
  assert.match(cssSource, /\.panel__body--team\.is-team-switching \.team-row\.is-top-1::after\s*{/s)
  assert.match(cssSource, /animation:\s*team-champion-shine 640ms ease-out both/)
  assert.match(cssSource, /animation-delay:\s*672ms/)
})

test('排行榜上浮动画终态和静态态一致，避免文字在结束时抖动', () => {
  assert.match(cssSource, /\.team-row\s*{[^}]*filter:\s*blur\(0\)/s)
  assert.match(cssSource, /\.team-row\s*{[^}]*transform:\s*translateY\(0\) scale\(1\)/s)
  assert.match(
    cssSource,
    /@keyframes team-row-rise-in[\s\S]*to\s*{[^}]*filter:\s*blur\(0\)[^}]*transform:\s*translateY\(0\) scale\(1\)/
  )
})

test('排行榜动画期间禁止内容区产生横向滚动条', () => {
  assert.match(cssSource, /\.panel__content\s*{[^}]*overflow-x:\s*hidden/s)
})

test('减少动态效果时禁用 tab 动画', () => {
  const reducedMotionStart = cssSource.indexOf('@media (prefers-reduced-motion: reduce)')
  const reducedMotion = cssSource.slice(reducedMotionStart)

  assert.notEqual(reducedMotionStart, -1)
  assert.match(reducedMotion, /\.panel__body\.is-tab-switching \*/)
  assert.match(reducedMotion, /animation:\s*none/)
})

test('用量统计时间 tab 切换复用 Quick Snap 动效', () => {
  assert.match(appSource, /is-window-switching/)
  assert.match(appSource, /startWindowMotion\(\)/)
  assert.match(
    cssSource,
    /\.usage-card\.is-window-switching\s*:is\([^)]*\)\s*{[^}]*animation:\s*panel-tab-content-snap 380ms cubic-bezier\(0\.34, 1\.56, 0\.64, 1\) backwards/s
  )
  assert.match(cssSource, /\.usage-card\.is-window-switching\s*:is\(\.usage-summary, \.usage-range-panel\)/)
  assert.match(
    cssSource,
    /\.usage-card\.is-window-switching :is\(\.usage-summary, \.usage-range-panel\)\s*{[^}]*animation-delay:\s*0ms/s
  )
  assert.match(
    cssSource,
    /\.usage-card\.is-window-switching :is\(\.usage-chart, \.usage-bar\)\s*{[^}]*animation-delay:\s*40ms/s
  )
  assert.match(
    cssSource,
    /\.usage-card\.is-window-switching :is\(\.model-board, \.usage-card__spend-hint\)\s*{[^}]*animation-delay:\s*80ms/s
  )
  assert.match(cssSource, /@keyframes usage-bar-rise/)
  assert.match(
    cssSource,
    /\.usage-card\.is-window-switching \.usage-chart__bar--stack\s*{[^}]*animation:\s*usage-bar-rise 380ms cubic-bezier\(0\.22, 0\.9, 0\.3, 1\) backwards/s
  )
  assert.match(
    cssSource,
    /\.usage-card\.is-window-switching \.usage-chart__bar--stack\s*{[^}]*animation-delay:\s*420ms/s
  )
})

test('减少动态效果时禁用用量统计窗口切换动画', () => {
  const reducedMotionStart = cssSource.indexOf('@media (prefers-reduced-motion: reduce)')
  const reducedMotion = cssSource.slice(reducedMotionStart)

  assert.notEqual(reducedMotionStart, -1)
  assert.match(reducedMotion, /\.usage-card\.is-window-switching \*/)
})

test('横向和竖向胶囊共用不改变布局的双层描边', () => {
  const capsuleStart = cssSource.indexOf('.capsule {')
  const capsuleEnd = cssSource.indexOf('\n}', capsuleStart)
  const capsuleRule = cssSource.slice(capsuleStart, capsuleEnd)

  assert.notEqual(capsuleStart, -1)
  assert.match(capsuleRule, /border:\s*0/)
  assert.match(
    capsuleRule,
    /box-shadow:\s*inset 0 0 0 0\.5px rgba\(109, 180, 255, 0\.34\),\s*inset 0 0 0 1px rgba\(255, 255, 255, 0\.035\)/s
  )
})
