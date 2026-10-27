import { BrowserWindow, screen, type Display, type Rectangle } from 'electron'
import {
  resolveIslandLayout,
  type IslandLayout,
  type IslandTaskbarPlacement,
  TASKBAR_BUTTON_WIDTH,
  TASKBAR_BUTTON_HEIGHT
} from '../../shared/island-layout'
import type { IslandDisplayMode } from '../../shared/island'
import {
  fitIslandViewport,
  resolveIslandDrawingLayout,
  type IslandViewport
} from '../../shared/island-viewport'
import { islandDiagnostics } from '../services/island-diagnostics'

const ISLAND_LAYOUT_CHANNEL = 'codex-status:island-layout'
const ISLAND_POINTER_CHANNEL = 'codex-status:island-pointer'
const ISLAND_POINTER_INTERVAL_MS = 50
const ISLAND_TOPMOST_LEVEL = 'screen-saver'
const islandWindowRegions = new WeakMap<BrowserWindow, Rectangle>()
const islandPointerTimers = new WeakMap<BrowserWindow, ReturnType<typeof setInterval>>()

export interface IslandWindowOptions {
  preloadPath: string
  loadRenderer: (window: BrowserWindow) => void
  placement: IslandWindowPlacement
}

export interface IslandWindowPlacement {
  displayMode: IslandDisplayMode
  taskbar?: IslandTaskbarPlacement
  taskbarOffsetX?: number
  viewport: IslandViewport
  previousViewports?: readonly IslandViewport[]
}

export function createIslandWindow(options: IslandWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    ...initialBounds(options.placement),
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
      preload: options.preloadPath,
      sandbox: false,
      backgroundThrottling: false
    }
  })
  window.setAlwaysOnTop(true, ISLAND_TOPMOST_LEVEL)
  window.setIgnoreMouseEvents(true)
  window.on('hide', () => stopIslandPointerTracking(window))
  window.on('closed', () => stopIslandPointerTracking(window))
  window.webContents.on('render-process-gone', () => stopIslandPointerTracking(window))
  islandDiagnostics.record('native', { reason: 'create-window', ignore: true, forward: false })
  options.loadRenderer(window)
  return window
}

export function showIslandWindow(window: BrowserWindow): void {
  stopIslandPointerTracking(window)
  if (!window.isVisible()) window.showInactive()
  window.setAlwaysOnTop(true, ISLAND_TOPMOST_LEVEL)
  // 退出全屏后任务栏也会恢复置顶；仅保留置顶标志不足以恢复窗口间的顺序。
  window.moveTop()
}

// 任务栏可能不投递 DOM leave；仅在交互期间读取系统坐标，移出后由既有交互链停采样。
export function startIslandPointerTracking(
  window: BrowserWindow,
  presentationRevision: number
): void {
  stopIslandPointerTracking(window)
  if (process.platform !== 'win32' || window.isDestroyed() || !window.isVisible()) return
  const timer = setInterval(() => {
    if (islandPointerTimers.get(window) !== timer) return
    if (window.isDestroyed() || !window.isVisible()) {
      stopIslandPointerTracking(window)
      return
    }
    const cursor = screen.getCursorScreenPoint()
    const origin = window.getContentBounds()
    window.webContents.send(ISLAND_POINTER_CHANNEL, {
      presentationRevision,
      x: cursor.x - origin.x,
      y: cursor.y - origin.y
    })
  }, ISLAND_POINTER_INTERVAL_MS)
  timer.unref()
  islandPointerTimers.set(window, timer)
}

export function stopIslandPointerTracking(window: BrowserWindow): void {
  const timer = islandPointerTimers.get(window)
  if (!timer) return
  clearInterval(timer)
  islandPointerTimers.delete(window)
}

export function positionIslandWindow(
  window: BrowserWindow,
  placement: IslandWindowPlacement
): IslandLayout {
  const layout = resolveWindowDrawingLayout(placement)
  if (!sameRect(window.getBounds(), layout.bounds)) window.setBounds(layout.bounds)
  if (process.platform === 'win32') applyIslandWindowRegion(window, layout, placement)
  const origin = window.getContentBounds()
  const cursor = screen.getCursorScreenPoint()
  window.webContents.send(ISLAND_LAYOUT_CHANNEL, {
    layout,
    pointer: { x: cursor.x - origin.x, y: cursor.y - origin.y }
  })
  return layout
}

function resolveWindowDrawingLayout(placement: IslandWindowPlacement): IslandLayout {
  const layout = resolveIslandLayout({
    display: getIslandDisplay(),
    displays: screen.getAllDisplays(),
    ...placement
  })
  return process.platform === 'win32'
    ? resolveIslandDrawingLayout(layout)
    : fitIslandViewport(layout, placement.viewport, placement.previousViewports)
}

function applyIslandWindowRegion(
  window: BrowserWindow,
  layout: IslandLayout,
  placement: IslandWindowPlacement
): void {
  const viewport = fitIslandViewport(layout, placement.viewport, placement.previousViewports)
  const region = {
    x: viewport.bounds.x - layout.bounds.x,
    y: viewport.bounds.y - layout.bounds.y,
    width: viewport.bounds.width,
    height: viewport.bounds.height
  }
  if (sameRect(islandWindowRegions.get(window), region)) return
  // 同一绘图坐标系内裁剪原生区域，避免搬动 HWND 时短暂呈现旧坐标的画面。
  window.setShape([region])
  islandWindowRegions.set(window, region)
}

function sameRect(left: Rectangle | undefined, right: Rectangle): boolean {
  return (
    left !== undefined &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  )
}

export function getIslandDisplay(): Display {
  return screen.getPrimaryDisplay()
}

function initialBounds(placement: IslandWindowPlacement):
  | Rectangle
  | {
      width: number
      height: number
    } {
  // 原生探针需要 HWND 才能启动；任务栏几何就绪前仅创建隐藏窗口。
  if (placement.displayMode === 'taskbar' && !placement.taskbar) {
    return { width: TASKBAR_BUTTON_WIDTH, height: TASKBAR_BUTTON_HEIGHT }
  }
  return resolveWindowDrawingLayout(placement).bounds
}
