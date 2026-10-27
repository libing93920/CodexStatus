/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ISLAND_COMPACT_HEIGHT,
  ISLAND_COMPACT_WIDTH,
  ISLAND_EXPANDED_HEIGHT,
  ISLAND_SINGLE_TASK_HEIGHT,
  ISLAND_TWO_TASK_HEIGHT,
  TASKBAR_BUTTON_HEIGHT,
  TASKBAR_BUTTON_WIDTH,
  resolveIslandLayout,
  resolveIslandModeRect
} from '../src/shared/island-layout.ts'
import {
  fitIslandViewport,
  normalizeIslandViewportRequest,
  resolveIslandDrawingLayout
} from '../src/shared/island-viewport.ts'

const SHADOW_PADDING = 26
const SATELLITE_COMPACT_WIDTH = 220
const SATELLITE_GAP = 10
const SATELLITE_SIZE = 48
const DISPLAY = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 }
}
const DISPLAYS = [DISPLAY]
const TASKBAR = {
  bounds: { x: 0, y: 1040, width: 1920, height: 40 },
  notificationArea: { x: 1650, y: 1040, width: 270, height: 40 },
  dark: true
}
const SCREEN_RECT_KEYS = ['compact', 'alert', 'expanded', 'satellite', 'bridge']
const DRAWING_LAYOUTS = [
  resolveIslandLayout({ display: DISPLAY, displays: DISPLAYS }),
  ...[0, TASKBAR.bounds.width].map((taskbarOffsetX) =>
    resolveIslandLayout({
      display: DISPLAY,
      displays: DISPLAYS,
      displayMode: 'taskbar',
      taskbar: TASKBAR,
      taskbarOffsetX
    })
  )
]
const DRAWING_STATES = [
  viewport('compact'),
  viewport('compact', ISLAND_SINGLE_TASK_HEIGHT, true),
  viewport('alert'),
  viewport('alert', ISLAND_SINGLE_TASK_HEIGHT, true),
  ...[ISLAND_SINGLE_TASK_HEIGHT, ISLAND_TWO_TASK_HEIGHT, ISLAND_EXPANDED_HEIGHT].flatMap(
    (height) => [viewport('expanded', height), viewport('expanded', height, true)]
  )
]

test('紧凑岛只留阴影边距，任务栏按钮画布紧贴 132x36 内容', () => {
  const island = resolveIslandLayout({ display: DISPLAY, displays: DISPLAYS })
  const compact = viewport('compact')
  const fittedIsland = fitIslandViewport(resolveIslandDrawingLayout(island), compact)
  assert.deepEqual(fittedIsland.bounds, fitIslandViewport(island, compact).bounds)
  const islandButton = screenRect(island, island.compact)

  assert.deepEqual(
    { width: fittedIsland.bounds.width, height: fittedIsland.bounds.height },
    {
      width: ISLAND_COMPACT_WIDTH + SHADOW_PADDING * 2,
      height: ISLAND_COMPACT_HEIGHT + SHADOW_PADDING * 2
    }
  )
  assert.deepEqual(screenRect(fittedIsland, fittedIsland.compact), islandButton)
  assert.equal(fittedIsland.bounds.x + SHADOW_PADDING, islandButton.x)
  assert.equal(fittedIsland.bounds.y + SHADOW_PADDING, islandButton.y)

  const taskbar = resolveIslandLayout({
    display: DISPLAY,
    displays: DISPLAYS,
    displayMode: 'taskbar',
    taskbar: TASKBAR
  })
  const fittedTaskbar = fitIslandViewport(resolveIslandDrawingLayout(taskbar), compact)
  assert.deepEqual(fittedTaskbar.bounds, fitIslandViewport(taskbar, compact).bounds)
  const taskbarButton = screenRect(taskbar, taskbar.compact)

  assert.deepEqual(
    { width: taskbarButton.width, height: taskbarButton.height },
    { width: TASKBAR_BUTTON_WIDTH, height: TASKBAR_BUTTON_HEIGHT }
  )
  assert.deepEqual(fittedTaskbar.bounds, taskbarButton)
})

test('固定 drawing canvas 是全部状态及阴影的最小包络，与当前 native region 无关', () => {
  for (const layout of DRAWING_LAYOUTS) {
    const drawing = resolveIslandDrawingLayout(layout)
    const regions = DRAWING_STATES.map((state) => fitIslandViewport(layout, state).bounds)
    assert.deepEqual(drawing.bounds, unionBounds(regions))
    assertSameScreenRects(layout, drawing)
    assert.deepEqual(resolveIslandDrawingLayout(drawing), drawing)
    for (const state of DRAWING_STATES) {
      assert.deepEqual(resolveIslandDrawingLayout(fitIslandViewport(layout, state)), drawing)
      assertInside(drawing.bounds, fitIslandViewport(drawing, state).bounds)
      const content = resolveIslandModeRect({ layout: drawing, ...state })
      assertInside(drawing.bounds, screenRect(drawing, content))
    }
  }
})

test('drawing canvas 内的动态 region 与原 fit 完全一致，边缘任务栏和卫星坐标不变', () => {
  for (const layout of DRAWING_LAYOUTS) {
    const drawing = resolveIslandDrawingLayout(layout)
    const canvas = { x: 0, y: 0, width: drawing.bounds.width, height: drawing.bounds.height }
    for (const state of DRAWING_STATES) {
      for (const previous of [[], DRAWING_STATES]) {
        const fitted = fitIslandViewport(drawing, state, previous)
        const original = fitIslandViewport(layout, state, previous)
        assert.deepEqual(fitted.bounds, original.bounds)
        assertSameScreenRects(layout, fitted)
        assert.deepEqual(
          screenRect(fitted, resolveIslandModeRect({ layout: fitted, ...state })),
          screenRect(layout, resolveIslandModeRect({ layout, ...state }))
        )
        assertInside(canvas, {
          ...fitted.bounds,
          x: fitted.bounds.x - drawing.bounds.x,
          y: fitted.bounds.y - drawing.bounds.y
        })
      }
    }
  }
})

test('prepare 同时容纳旧内容和目标内容，settle 后才缩小 HWND', () => {
  const layout = resolveIslandLayout({ display: DISPLAY, displays: DISPLAYS })
  const compact = viewport('compact')
  const tall = viewport('expanded', ISLAND_EXPANDED_HEIGHT)
  const short = viewport('expanded', ISLAND_SINGLE_TASK_HEIGHT)
  const tallContent = expandedScreenRect(layout, ISLAND_EXPANDED_HEIGHT)
  const shortContent = expandedScreenRect(layout, ISLAND_SINGLE_TASK_HEIGHT)

  const tallCanvas = fitIslandViewport(layout, tall)
  const prepare = fitIslandViewport(layout, short, [tall])
  const targetOnly = fitIslandViewport(layout, short)
  assert.deepEqual(prepare.bounds, tallCanvas.bounds)
  assert.ok(prepare.bounds.height > targetOnly.bounds.height)
  assertInside(prepare.bounds, tallContent)
  assertInside(prepare.bounds, shortContent)
  assertSameScreenRects(layout, prepare)

  const collapsePrepare = fitIslandViewport(tallCanvas, compact, [tall])
  assert.deepEqual(collapsePrepare.bounds, tallCanvas.bounds)
  assertInside(collapsePrepare.bounds, tallContent)
  const settled = fitIslandViewport(collapsePrepare, compact)
  assert.deepEqual(settled.bounds, fitIslandViewport(layout, compact).bounds)
  assert.ok(settled.bounds.height < collapsePrepare.bounds.height)
  assertSameScreenRects(layout, settled)
})

for (const displayMode of ['island', 'taskbar']) {
  for (const modes of [
    ['expanded', 'compact', 'alert'],
    ['compact', 'expanded', 'alert']
  ]) {
    test(`${displayMode} 连续 prepare ${modes.join('→')} 保留所有旧屏幕区域，settle 才回收`, () => {
      const layout = resolveIslandLayout({
        display: DISPLAY,
        displays: DISPLAYS,
        displayMode,
        ...(displayMode === 'taskbar' ? { taskbar: TASKBAR } : {})
      })
      const states = modes.map((mode) => viewport(mode, ISLAND_EXPANDED_HEIGHT))
      const contents = states.map((state) =>
        screenRect(layout, resolveIslandModeRect({ layout, ...state }))
      )
      let prepared = fitIslandViewport(layout, states[0])
      for (let index = 1; index < states.length; index++) {
        prepared = fitIslandViewport(prepared, states[index], states.slice(0, index))
        for (const content of contents.slice(0, index + 1)) {
          assertInside(prepared.bounds, content)
        }
        assertSameScreenRects(layout, prepared)
      }
      const settled = fitIslandViewport(prepared, states.at(-1))
      assert.deepEqual(settled.bounds, fitIslandViewport(layout, states.at(-1)).bounds)
      assert.ok(settled.bounds.height < prepared.bounds.height)
      assertInside(settled.bounds, contents.at(-1))
      assertSameScreenRects(layout, settled)
    })
  }
}

test('fit 保持 compact、alert、expanded 和配套 hit geometry 的屏幕坐标', () => {
  const layout = resolveIslandLayout({ display: DISPLAY, displays: DISPLAYS })
  for (const state of [
    viewport('compact'),
    viewport('alert'),
    viewport('expanded', ISLAND_TWO_TASK_HEIGHT)
  ]) {
    assertSameScreenRects(layout, fitIslandViewport(layout, state))
  }
})

test('只有岛模式的 satellite 会扩大紧凑原生范围，重复 fit 保持幂等', () => {
  const island = resolveIslandLayout({ display: DISPLAY, displays: DISPLAYS })
  const withoutSatellite = fitIslandViewport(island, viewport('compact'))
  const withSatellite = fitIslandViewport(island, viewport('compact', undefined, true))
  assertInside(withSatellite.bounds, screenRect(withSatellite, withSatellite.satellite))
  assert.ok(withSatellite.bounds.width > withoutSatellite.bounds.width)
  assertSameScreenRects(withoutSatellite, withSatellite)
  assert.deepEqual(
    fitIslandViewport(withSatellite, viewport('compact', undefined, true)),
    withSatellite
  )

  const taskbar = resolveIslandLayout({
    display: DISPLAY,
    displays: DISPLAYS,
    displayMode: 'taskbar',
    taskbar: TASKBAR
  })
  assert.deepEqual(
    fitIslandViewport(taskbar, viewport('compact', undefined, true)).bounds,
    fitIslandViewport(taskbar, viewport('compact')).bounds
  )
})

test('带 satellite 的 viewport 包住旧版左移紧凑胶囊及右侧卫星', () => {
  const layout = resolveIslandLayout({ display: DISPLAY, displays: DISPLAYS })
  const state = viewport('compact', ISLAND_SINGLE_TASK_HEIGHT, true)
  const compact = screenRect(layout, resolveIslandModeRect({ layout, ...state }))
  const fitted = fitIslandViewport(layout, state)
  const prepared = fitIslandViewport(layout, viewport('expanded'), [state])

  assert.equal(
    fitted.bounds.width,
    SATELLITE_COMPACT_WIDTH + SATELLITE_GAP + SATELLITE_SIZE + SHADOW_PADDING * 2
  )
  assert.equal(fitted.bounds.x + SHADOW_PADDING, compact.x)
  assert.deepEqual(screenRect(fitted, resolveIslandModeRect({ layout: fitted, ...state })), compact)
  assertInside(fitted.bounds, compact)
  assertInside(prepared.bounds, compact)
  assertInside(prepared.bounds, screenRect(layout, layout.satellite))
})

test('200、281、362 DIP 的展开画布跟随当前内容包络', () => {
  const layout = resolveIslandLayout({ display: DISPLAY, displays: DISPLAYS })
  const heights = [ISLAND_SINGLE_TASK_HEIGHT, ISLAND_TWO_TASK_HEIGHT, ISLAND_EXPANDED_HEIGHT]
  const fitted = heights.map((height) => {
    const state = viewport('expanded', height)
    const content = expandedScreenRect(layout, height)
    const result = fitIslandViewport(layout, state)
    assert.equal(content.height, height)
    assertInside(result.bounds, content)
    assertSameScreenRects(layout, result)
    return result
  })

  assert.ok(fitted[0].bounds.height < fitted[1].bounds.height)
  assert.ok(fitted[1].bounds.height < fitted[2].bounds.height)
})

test('负坐标显示器上的 compact fit 保留原始屏幕位置', () => {
  const display = {
    id: 2,
    bounds: { x: -1600, y: -180, width: 1600, height: 900 },
    workArea: { x: -1600, y: -180, width: 1600, height: 860 }
  }
  const layout = resolveIslandLayout({ display, displays: [display] })
  const fitted = fitIslandViewport(layout, viewport('compact'))

  assert.ok(fitted.bounds.x < 0)
  assert.ok(fitted.bounds.y < 0)
  assertSameScreenRects(layout, fitted)
})

test('native viewport 请求拒绝非法模式、阶段、尺寸和修订号', () => {
  const valid = {
    displayMode: 'island',
    mode: 'compact',
    expandedHeight: ISLAND_SINGLE_TASK_HEIGHT,
    hasSatellite: false,
    revision: 1,
    presentationRevision: 1,
    phase: 'prepare'
  }
  assert.deepEqual(normalizeIslandViewportRequest(valid), valid)

  const invalidRequests = [
    { ...valid, displayMode: 'other' },
    { ...valid, mode: 'hidden' },
    { ...valid, phase: 'sample' },
    { ...valid, expandedHeight: Number.NaN },
    { ...valid, expandedHeight: Number.POSITIVE_INFINITY },
    { ...valid, expandedHeight: Number.NEGATIVE_INFINITY },
    { ...valid, revision: 0 },
    { ...valid, revision: Number.NaN },
    { ...valid, revision: Number.POSITIVE_INFINITY },
    { ...valid, revision: 1.5 },
    { ...valid, revision: 'bad' },
    { ...valid, revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, presentationRevision: 0 },
    { ...valid, presentationRevision: Number.NaN },
    { ...valid, presentationRevision: Number.POSITIVE_INFINITY },
    { ...valid, presentationRevision: 1.5 },
    { ...valid, presentationRevision: 'bad' },
    { ...valid, presentationRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, hasSatellite: 'yes' }
  ]

  for (const request of invalidRequests) {
    assert.equal(normalizeIslandViewportRequest(request), undefined)
  }
  assert.equal(
    normalizeIslandViewportRequest({ ...valid, displayMode: 'taskbar', hasSatellite: true })
      ?.hasSatellite,
    false
  )
})

function viewport(mode, expandedHeight = ISLAND_SINGLE_TASK_HEIGHT, hasSatellite = false) {
  return { mode, expandedHeight, hasSatellite }
}

function expandedScreenRect(layout, expandedHeight) {
  const rect = resolveIslandModeRect({
    layout,
    mode: 'expanded',
    expandedHeight,
    hasSatellite: false
  })
  return screenRect(layout, rect)
}

function screenRect(layout, rect) {
  return { ...rect, x: layout.bounds.x + rect.x, y: layout.bounds.y + rect.y }
}

function assertInside(bounds, rect) {
  assert.ok(rect.x >= bounds.x, JSON.stringify({ bounds, rect }))
  assert.ok(rect.y >= bounds.y, JSON.stringify({ bounds, rect }))
  assert.ok(rect.x + rect.width <= bounds.x + bounds.width, JSON.stringify({ bounds, rect }))
  assert.ok(rect.y + rect.height <= bounds.y + bounds.height, JSON.stringify({ bounds, rect }))
}

function assertSameScreenRects(before, after) {
  for (const key of SCREEN_RECT_KEYS) {
    assert.deepEqual(screenRect(after, after[key]), screenRect(before, before[key]), key)
  }
}

function unionBounds(rects) {
  const x = Math.min(...rects.map((rect) => rect.x))
  const y = Math.min(...rects.map((rect) => rect.y))
  return {
    x,
    y,
    width: Math.max(...rects.map((rect) => rect.x + rect.width)) - x,
    height: Math.max(...rects.map((rect) => rect.y + rect.height)) - y
  }
}
