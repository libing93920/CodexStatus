import { BrowserWindow, screen, type Rectangle } from 'electron'

export const ISLAND_WINDOW_SIZE = { width: 424, height: 360 } as const

export interface IslandWindowOptions {
  preloadPath: string
  loadRenderer: (window: BrowserWindow) => void
}

export function createIslandWindow(options: IslandWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    ...resolveIslandBounds(),
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
    webPreferences: { preload: options.preloadPath, sandbox: false }
  })
  window.setAlwaysOnTop(true, 'screen-saver')
  window.setIgnoreMouseEvents(true, { forward: true })
  options.loadRenderer(window)
  return window
}

export function positionIslandWindow(window: BrowserWindow): void {
  window.setBounds(resolveIslandBounds())
}

function resolveIslandBounds(): Rectangle {
  const display = screen.getPrimaryDisplay()
  return {
    x: display.bounds.x + Math.round((display.bounds.width - ISLAND_WINDOW_SIZE.width) / 2),
    y: display.bounds.y,
    ...ISLAND_WINDOW_SIZE
  }
}
