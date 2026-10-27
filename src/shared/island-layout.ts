import type { IslandDisplayMode } from './island'

export interface IslandRect {
  x: number
  y: number
  width: number
  height: number
}

export interface IslandDisplay {
  id: number
  bounds: IslandRect
  workArea: IslandRect
}

/** 由主进程换算为 Electron DIP 后的系统任务栏区域。 */
export interface IslandTaskbarPlacement {
  bounds: IslandRect
  notificationArea?: IslandRect
  dark?: boolean
}

export type IslandMode = 'hidden' | 'compact' | 'alert' | 'expanded'
export type IslandDirection = 'up' | 'down'

export interface IslandLayout {
  displayId: number
  displayMode: IslandDisplayMode
  taskbarTheme?: 'dark' | 'light'
  bounds: IslandRect
  compact: IslandRect
  alert: IslandRect
  expanded: IslandRect
  satellite: IslandRect
  bridge: IslandRect
  direction: IslandDirection
}

export interface IslandLayoutUpdate {
  layout: IslandLayout
  pointer: { x: number; y: number }
}

export interface IslandPointerUpdate {
  presentationRevision: number
  x: number
  y: number
}

export const ISLAND_COMPACT_WIDTH = 248
export const ISLAND_COMPACT_HEIGHT = 48
export const ISLAND_EXPANDED_HEIGHT = 362
export const ISLAND_SINGLE_TASK_HEIGHT = 200
export const ISLAND_TWO_TASK_HEIGHT = 281
export const TASKBAR_BUTTON_WIDTH = 132
export const TASKBAR_BUTTON_HEIGHT = 36
const TASKBAR_CARD_WIDTH = 360
const TASKBAR_ALERT_WIDTH = 340
const TASKBAR_ALERT_HEIGHT = 184
const EXPANDED_WIDTH = 412
const ALERT_WIDTH = 396
const ALERT_HEIGHT = 198
const HIDDEN_WIDTH = 104
const HIDDEN_HEIGHT = 28
const SATELLITE_COMPACT_WIDTH = 220
const SATELLITE_CENTER_OFFSET = 29
const SATELLITE_SIZE = 48
const SATELLITE_GAP = 10
const CONTENT_GAP = 8
const WINDOW_PADDING = 26

export function resolveIslandLayout(options: {
  display: IslandDisplay
  displays: readonly IslandDisplay[]
  displayMode?: IslandDisplayMode
  taskbar?: IslandTaskbarPlacement
  taskbarOffsetX?: number
}): IslandLayout {
  const { display, taskbar } = options
  const displayMode = options.displayMode ?? 'island'
  const taskbarMode = displayMode === 'taskbar'
  if (taskbarMode && !taskbar) throw new Error('Taskbar geometry is required')
  const compact =
    taskbarMode && taskbar
      ? resolveTaskbarButtonRect(taskbar, options.taskbarOffsetX)
      : resolveCompactRect(display.bounds)
  const direction = taskbarMode ? 'up' : 'down'
  const expanded = resolveCardRect({
    compact,
    area: display.workArea,
    direction,
    width: taskbarMode ? TASKBAR_CARD_WIDTH : EXPANDED_WIDTH,
    height: ISLAND_EXPANDED_HEIGHT
  })
  const alert = resolveCardRect({
    compact,
    area: display.workArea,
    direction,
    width: taskbarMode ? TASKBAR_ALERT_WIDTH : ALERT_WIDTH,
    height: taskbarMode ? TASKBAR_ALERT_HEIGHT : ALERT_HEIGHT
  })
  const satelliteCompact = taskbarMode ? compact : resolveSatelliteCompactRect(compact)
  const satellite = resolveSatelliteRect(satelliteCompact, display.bounds)
  const bridge = {
    x: Math.min(satelliteCompact.x + satelliteCompact.width, satellite.x + satellite.width),
    y: satelliteCompact.y,
    width: SATELLITE_GAP,
    height: compact.height
  }
  const bounds = resolveWindowRect(compact, options.displays)
  return {
    displayId: display.id,
    displayMode,
    ...(taskbarMode && typeof taskbar?.dark === 'boolean'
      ? { taskbarTheme: taskbar.dark ? ('dark' as const) : ('light' as const) }
      : {}),
    bounds,
    compact: toLocalRect(compact, bounds),
    alert: toLocalRect(alert, bounds),
    expanded: toLocalRect(expanded, bounds),
    satellite: toLocalRect(satellite, bounds),
    bridge: toLocalRect(bridge, bounds),
    direction
  }
}

export function resolveIslandModeRect(options: {
  layout: IslandLayout
  mode: IslandMode
  expandedHeight: number
  hasSatellite: boolean
}): IslandRect {
  const { layout, mode, expandedHeight } = options
  if (mode === 'hidden') {
    const width = Math.min(HIDDEN_WIDTH, layout.compact.width)
    return {
      ...layout.compact,
      x: layout.compact.x + (layout.compact.width - width) / 2,
      width,
      height: Math.min(HIDDEN_HEIGHT, layout.compact.height)
    }
  }
  if (mode === 'compact') {
    return options.hasSatellite && layout.displayMode === 'island'
      ? resolveSatelliteCompactRect(layout.compact)
      : layout.compact
  }
  if (mode === 'alert') return layout.alert
  const height = Math.min(expandedHeight, layout.expanded.height)
  return {
    ...layout.expanded,
    y: layout.expanded.y + (layout.direction === 'up' ? layout.expanded.height - height : 0),
    height
  }
}

export function islandHitRects(options: {
  layout: IslandLayout
  mode: IslandMode
  expandedHeight: number
  hasSatellite: boolean
}): IslandRect[] {
  if (options.mode === 'hidden') return []
  const rect = resolveIslandModeRect(options)
  if (options.mode === 'compact') {
    return options.hasSatellite && options.layout.displayMode === 'island'
      ? [rect, options.layout.bridge, options.layout.satellite]
      : [rect]
  }
  const compact = resolveIslandModeRect({ ...options, mode: 'compact' })
  // 任务栏上的收起位置与内移卡片之间保留悬停通道，指针才能移入展开内容。
  const top = Math.min(compact.y, rect.y + rect.height)
  const bottom = Math.max(compact.y + compact.height, rect.y)
  return [rect, compact, { x: compact.x, y: top, width: compact.width, height: bottom - top }]
}

function resolveCompactRect(area: IslandRect): IslandRect {
  const width = Math.min(
    ISLAND_COMPACT_WIDTH,
    Math.max(1, area.width - 2 * (SATELLITE_SIZE + SATELLITE_GAP))
  )
  const height = Math.min(ISLAND_COMPACT_HEIGHT, area.height)
  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y,
    width,
    height
  }
}

function resolveTaskbarButtonRect(taskbar: IslandTaskbarPlacement, offsetX?: number): IslandRect {
  const area = taskbar.bounds
  const width = Math.min(TASKBAR_BUTTON_WIDTH, area.width)
  const height = Math.min(TASKBAR_BUTTON_HEIGHT, area.height)
  if (offsetX === undefined && !taskbar.notificationArea && area.width > width) {
    throw new Error('Notification area is required for initial taskbar placement')
  }
  const notificationLeft = taskbar.notificationArea?.x ?? area.x
  const initialOffset = notificationLeft - area.x - width - CONTENT_GAP
  return {
    x: Math.round(area.x + clamp(offsetX ?? initialOffset, 0, area.width - width)),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height
  }
}

function resolveCardRect(options: {
  compact: IslandRect
  area: IslandRect
  direction: IslandDirection
  width: number
  height: number
}): IslandRect {
  const { compact, area, direction } = options
  const width = Math.min(options.width, Math.max(1, area.width - CONTENT_GAP * 2))
  const available =
    direction === 'down'
      ? area.y + area.height - CONTENT_GAP - compact.y
      : Math.min(area.y + area.height - CONTENT_GAP, compact.y + compact.height) -
        area.y -
        CONTENT_GAP
  const height = Math.min(options.height, Math.max(1, available))
  return {
    x: clamp(
      compact.x + (compact.width - width) / 2,
      area.x + CONTENT_GAP,
      area.x + area.width - CONTENT_GAP - width
    ),
    y:
      direction === 'down'
        ? compact.y
        : clamp(
            compact.y + compact.height - height,
            area.y + CONTENT_GAP,
            area.y + area.height - CONTENT_GAP - height
          ),
    width,
    height
  }
}

function resolveSatelliteCompactRect(compact: IslandRect): IslandRect {
  const width = Math.min(SATELLITE_COMPACT_WIDTH, compact.width)
  return {
    ...compact,
    x: compact.x + (compact.width - width) / 2 - SATELLITE_CENTER_OFFSET,
    width
  }
}

function resolveSatelliteRect(compact: IslandRect, area: IslandRect): IslandRect {
  const right = compact.x + compact.width + SATELLITE_GAP
  return {
    x:
      right + SATELLITE_SIZE <= area.x + area.width
        ? right
        : compact.x - SATELLITE_GAP - SATELLITE_SIZE,
    y: compact.y,
    width: SATELLITE_SIZE,
    height: compact.height
  }
}

function resolveWindowRect(compact: IslandRect, displays: readonly IslandDisplay[]): IslandRect {
  const insets = displays.map(({ bounds, workArea }) => ({
    left: Math.max(0, workArea.x - bounds.x),
    top: Math.max(0, workArea.y - bounds.y),
    right: Math.max(0, bounds.x + bounds.width - workArea.x - workArea.width),
    bottom: Math.max(0, bounds.y + bounds.height - workArea.y - workArea.height)
  }))
  const compactSizes = displays.map((display) => resolveCompactRect(display.bounds))
  const cardWidth = Math.max(EXPANDED_WIDTH, ALERT_WIDTH)
  const cardHeight = Math.max(ISLAND_EXPANDED_HEIGHT, ALERT_HEIGHT)
  const left =
    WINDOW_PADDING +
    Math.max(
      cardWidth -
        Math.min(...compactSizes.map((rect) => rect.width)) +
        CONTENT_GAP +
        Math.max(...insets.map((inset) => inset.right)),
      SATELLITE_SIZE + SATELLITE_GAP
    )
  const top =
    WINDOW_PADDING +
    cardHeight -
    Math.min(...compactSizes.map((rect) => rect.height)) +
    CONTENT_GAP +
    Math.max(...insets.map((inset) => inset.bottom))
  const right =
    WINDOW_PADDING +
    Math.max(
      cardWidth + CONTENT_GAP + Math.max(...insets.map((inset) => inset.left)),
      ISLAND_COMPACT_WIDTH + SATELLITE_SIZE + SATELLITE_GAP
    )
  const bottom =
    WINDOW_PADDING + cardHeight + CONTENT_GAP + Math.max(...insets.map((inset) => inset.top))
  // 固定内容锚点和透明画布，拖动时只平移 HWND，避免新窗口原点配上旧 DOM 坐标。
  return {
    x: compact.x - left,
    y: compact.y - top,
    width: left + right,
    height: top + bottom
  }
}

function toLocalRect(rect: IslandRect, bounds: IslandRect): IslandRect {
  return { ...rect, x: rect.x - bounds.x, y: rect.y - bounds.y }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
