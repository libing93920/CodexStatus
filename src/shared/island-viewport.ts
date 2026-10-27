import type { IslandDisplayMode } from './island.ts'
import {
  resolveIslandModeRect,
  ISLAND_EXPANDED_HEIGHT,
  ISLAND_SINGLE_TASK_HEIGHT
} from './island-layout.ts'
import type { IslandLayout, IslandMode, IslandRect } from './island-layout.ts'

export interface IslandViewport {
  mode: Exclude<IslandMode, 'hidden'>
  expandedHeight: number
  hasSatellite: boolean
}

export interface IslandViewportRequest extends IslandViewport {
  displayMode: IslandDisplayMode
  revision: number
  presentationRevision: number
  phase: 'prepare' | 'settle'
}

export const DEFAULT_ISLAND_VIEWPORT: IslandViewport = {
  mode: 'compact',
  expandedHeight: ISLAND_SINGLE_TASK_HEIGHT,
  hasSatellite: false
}
const SHADOW_PADDING = 26
const RECT_KEYS = ['compact', 'alert', 'expanded', 'satellite', 'bridge'] as const

export function normalizeIslandViewportRequest(value: unknown): IslandViewportRequest | undefined {
  if (!value || typeof value !== 'object') return undefined
  const request = value as IslandViewportRequest
  if (!['island', 'taskbar'].includes(request.displayMode)) return undefined
  if (!['compact', 'alert', 'expanded'].includes(request.mode)) return undefined
  if (request.phase !== 'prepare' && request.phase !== 'settle') return undefined
  if (!Number.isSafeInteger(request.revision) || request.revision < 1) return undefined
  if (!Number.isSafeInteger(request.presentationRevision) || request.presentationRevision < 1)
    return undefined
  if (
    !Number.isFinite(request.expandedHeight) ||
    request.expandedHeight < 1 ||
    request.expandedHeight > ISLAND_EXPANDED_HEIGHT ||
    typeof request.hasSatellite !== 'boolean'
  ) {
    return undefined
  }
  return {
    displayMode: request.displayMode,
    mode: request.mode,
    expandedHeight: request.expandedHeight,
    hasSatellite: request.displayMode === 'island' && request.hasSatellite,
    revision: request.revision,
    presentationRevision: request.presentationRevision,
    phase: request.phase
  }
}

/** 固定全部状态的绘图范围，切换原生 region 时不改变 Chromium 画布。 */
export function resolveIslandDrawingLayout(layout: IslandLayout): IslandLayout {
  const expanded: IslandViewport = {
    mode: 'expanded',
    expandedHeight: ISLAND_EXPANDED_HEIGHT,
    hasSatellite: true
  }
  return fitIslandViewport(layout, expanded, [
    { ...expanded, mode: 'alert' },
    { ...expanded, mode: 'compact' },
    { ...expanded, mode: 'compact', hasSatellite: false }
  ])
}

/** 仅分配当前内容所需的 HWND；过渡期间同时包住旧状态和目标状态。 */
export function fitIslandViewport(
  layout: IslandLayout,
  viewport: IslandViewport,
  previous: readonly IslandViewport[] = []
): IslandLayout {
  const rects = viewportRects(layout, viewport)
  for (const state of previous) rects.push(...viewportRects(layout, state))
  const padding =
    layout.displayMode === 'taskbar' &&
    viewport.mode === 'compact' &&
    previous.every((state) => state.mode === 'compact')
      ? 0
      : SHADOW_PADDING
  const left = Math.floor(Math.min(...rects.map((rect) => rect.x)) - padding)
  const top = Math.floor(Math.min(...rects.map((rect) => rect.y)) - padding)
  const right = Math.ceil(Math.max(...rects.map((rect) => rect.x + rect.width)) + padding)
  const bottom = Math.ceil(Math.max(...rects.map((rect) => rect.y + rect.height)) + padding)
  const next = {
    ...layout,
    bounds: {
      x: layout.bounds.x + left,
      y: layout.bounds.y + top,
      width: right - left,
      height: bottom - top
    }
  }
  for (const key of RECT_KEYS)
    next[key] = { ...layout[key], x: layout[key].x - left, y: layout[key].y - top }
  return next
}

function viewportRects(layout: IslandLayout, viewport: IslandViewport): IslandRect[] {
  const rect = resolveIslandModeRect({
    layout,
    mode: viewport.mode,
    expandedHeight: viewport.expandedHeight,
    hasSatellite: viewport.hasSatellite
  })
  if (viewport.mode !== 'compact') {
    return [rect, resolveIslandModeRect({ layout, ...viewport, mode: 'compact' })]
  }
  return viewport.hasSatellite && layout.displayMode === 'island'
    ? [rect, layout.satellite]
    : [rect]
}
