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
  islandHitRects,
  resolveIslandLayout,
  resolveIslandModeRect
} from '../src/shared/island-layout.ts'

const DISPLAY_WIDTH = 1920
const DISPLAY_HEIGHT = 1080
const TASKBAR_HEIGHT = 40
const SIDE_TASKBAR_WIDTH = 40
const RIGHT_TASKBAR_WIDTH = 50
const TOP_TASKBAR_HEIGHT = 30
const TASKBAR_NOTIFICATION_AREA_WIDTH = 220
const TASKBAR_NOTIFICATION_GAP = 8
const SECONDARY_DISPLAY_TOP = -200
const NARROW_TASKBAR_WIDTH = 104
const NARROW_TASKBAR_HEIGHT = 28
const NARROW_TASKBAR_X = 100
const NARROW_TASKBAR_Y = 400
const CUSTOM_TASKBAR_OFFSET = 120
const SMALL_DISPLAY_WIDTH = 640
const SMALL_DISPLAY_HEIGHT = 160
const SMALL_DISPLAY_WORK_AREA_HEIGHT = 120
const SATELLITE_COMPACT_WIDTH = 220
const SATELLITE_CENTER_OFFSET = 29
const SATELLITE_SIZE = 48
const SATELLITE_GAP = 10

const displays = [
  {
    id: 1,
    bounds: { x: 0, y: 0, width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT },
    workArea: { x: 0, y: 0, width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT - TASKBAR_HEIGHT }
  },
  {
    id: 2,
    bounds: {
      x: -DISPLAY_WIDTH,
      y: SECONDARY_DISPLAY_TOP,
      width: DISPLAY_WIDTH,
      height: DISPLAY_HEIGHT
    },
    workArea: {
      x: -DISPLAY_WIDTH + SIDE_TASKBAR_WIDTH,
      y: SECONDARY_DISPLAY_TOP,
      width: DISPLAY_WIDTH - SIDE_TASKBAR_WIDTH,
      height: DISPLAY_HEIGHT - TASKBAR_HEIGHT
    }
  }
]

const insetDisplays = [
  displays[0],
  displays[1],
  {
    id: 3,
    bounds: { x: 0, y: DISPLAY_HEIGHT, width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT },
    workArea: {
      x: 0,
      y: DISPLAY_HEIGHT,
      width: DISPLAY_WIDTH - RIGHT_TASKBAR_WIDTH,
      height: DISPLAY_HEIGHT - TASKBAR_HEIGHT
    }
  },
  {
    id: 4,
    bounds: { x: DISPLAY_WIDTH, y: 0, width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT },
    workArea: {
      x: DISPLAY_WIDTH,
      y: TOP_TASKBAR_HEIGHT,
      width: DISPLAY_WIDTH,
      height: DISPLAY_HEIGHT - TOP_TASKBAR_HEIGHT
    }
  }
]

const primaryTaskbar = {
  bounds: {
    x: 0,
    y: DISPLAY_HEIGHT - TASKBAR_HEIGHT,
    width: DISPLAY_WIDTH,
    height: TASKBAR_HEIGHT
  },
  notificationArea: {
    x: DISPLAY_WIDTH - TASKBAR_NOTIFICATION_AREA_WIDTH,
    y: DISPLAY_HEIGHT - TASKBAR_HEIGHT,
    width: TASKBAR_NOTIFICATION_AREA_WIDTH,
    height: TASKBAR_HEIGHT
  },
  dark: true
}

test('island mode defaults to a fixed top-center anchor on each display', () => {
  for (const display of displays) {
    const options = { display, displays }
    const layout = resolveIslandLayout(options)
    const explicitIsland = resolveIslandLayout({ ...options, displayMode: 'island' })
    const legacyPosition = resolveIslandLayout({
      ...options,
      position: {
        displayId: display.id,
        x: display.bounds.x + display.bounds.width - ISLAND_COMPACT_WIDTH,
        y: display.bounds.y + display.bounds.height - ISLAND_COMPACT_HEIGHT
      }
    })
    const compact = screenRect(layout, layout.compact)

    assert.equal(layout.displayMode, 'island')
    assert.equal(layout.direction, 'down')
    assert.equal(layout.alert.y, layout.compact.y)
    assert.equal(layout.expanded.y, layout.compact.y)
    assert.deepEqual(explicitIsland.compact, layout.compact)
    assert.deepEqual(legacyPosition.compact, layout.compact)
    assert.deepEqual(compact, {
      x: display.bounds.x + (display.bounds.width - ISLAND_COMPACT_WIDTH) / 2,
      y: display.bounds.y,
      width: ISLAND_COMPACT_WIDTH,
      height: ISLAND_COMPACT_HEIGHT
    })
    assertVisibleGeometry(layout, display)
  }

  const withTaskbar = resolveIslandLayout({
    display: displays[0],
    displays,
    taskbar: primaryTaskbar,
    taskbarOffsetX: CUSTOM_TASKBAR_OFFSET
  })
  assert.equal(withTaskbar.taskbarTheme, undefined)
  assert.deepEqual(
    withTaskbar.compact,
    resolveIslandLayout({ display: displays[0], displays }).compact
  )
})

test('cards stay within work area when display space is constrained', () => {
  const display = {
    id: 5,
    bounds: {
      x: 0,
      y: 0,
      width: SMALL_DISPLAY_WIDTH,
      height: SMALL_DISPLAY_HEIGHT
    },
    workArea: {
      x: 0,
      y: 0,
      width: SMALL_DISPLAY_WIDTH,
      height: SMALL_DISPLAY_WORK_AREA_HEIGHT
    }
  }
  const layout = resolveIslandLayout({ display, displays: [display] })

  assert.equal(layout.direction, 'down')
  assert.ok(layout.expanded.height < ISLAND_SINGLE_TASK_HEIGHT)
  assertVisibleGeometry(layout, display)
  for (const mode of ['alert', 'expanded']) {
    const rect = resolveIslandModeRect({
      layout,
      mode,
      expandedHeight: ISLAND_EXPANDED_HEIGHT,
      hasSatellite: false
    })
    assert.ok(contains(display.workArea, screenRect(layout, rect)))
  }
})

test('display inset variations preserve visible geometry without fixing canvas dimensions', () => {
  for (const display of insetDisplays) {
    const layout = resolveIslandLayout({ display, displays: insetDisplays })
    assertVisibleGeometry(layout, display)
    assert.equal(layout.direction, 'down')
    assert.equal(layout.alert.y, layout.compact.y)
    assert.equal(layout.expanded.y, layout.compact.y)
  }
})

test('island cards grow downward from the fixed anchor and hit regions include the island satellite', () => {
  const display = displays[0]
  const layout = resolveIslandLayout({ display, displays })
  const heights = [ISLAND_SINGLE_TASK_HEIGHT, ISLAND_TWO_TASK_HEIGHT, ISLAND_EXPANDED_HEIGHT]
  const expandedRects = heights.map((expandedHeight) =>
    resolveIslandModeRect({ layout, mode: 'expanded', expandedHeight, hasSatellite: false })
  )

  assert.equal(layout.direction, 'down')
  assert.equal(new Set(expandedRects.map((rect) => rect.y)).size, 1)
  for (const rect of expandedRects) {
    assert.ok(contains(display.workArea, screenRect(layout, rect)))
  }

  const compactWithSatellite = islandHitRects({
    layout,
    mode: 'compact',
    expandedHeight: ISLAND_TWO_TASK_HEIGHT,
    hasSatellite: true
  })
  const compactWithoutSatellite = islandHitRects({
    layout,
    mode: 'compact',
    expandedHeight: ISLAND_TWO_TASK_HEIGHT,
    hasSatellite: false
  })
  const satelliteCompact = resolveIslandModeRect({
    layout,
    mode: 'compact',
    expandedHeight: ISLAND_TWO_TASK_HEIGHT,
    hasSatellite: true
  })
  assert.deepEqual(compactWithSatellite, [satelliteCompact, layout.bridge, layout.satellite])
  assert.deepEqual(compactWithoutSatellite, [layout.compact])

  for (const mode of ['alert', 'expanded']) {
    const withSatellite = islandHitRects({
      layout,
      mode,
      expandedHeight: ISLAND_TWO_TASK_HEIGHT,
      hasSatellite: true
    })
    const withoutSatellite = islandHitRects({
      layout,
      mode,
      expandedHeight: ISLAND_TWO_TASK_HEIGHT,
      hasSatellite: false
    })
    assert.deepEqual(withSatellite[0], withoutSatellite[0])
    assert.deepEqual(withSatellite[1], satelliteCompact)
    assert.deepEqual(withoutSatellite[1], layout.compact)
    assert.ok(withSatellite.every((rect) => contains(canvasRect(layout), rect)))
  }
})

test('island satellite preserves the previous 220-DIP capsule and shifted center', () => {
  for (const display of insetDisplays) {
    const layout = resolveIslandLayout({ display, displays: insetDisplays })
    const baseline = screenRect(layout, layout.compact)
    const compact = screenRect(
      layout,
      resolveIslandModeRect({
        layout,
        mode: 'compact',
        expandedHeight: ISLAND_SINGLE_TASK_HEIGHT,
        hasSatellite: true
      })
    )
    const satellite = screenRect(layout, layout.satellite)
    const bridge = screenRect(layout, layout.bridge)

    assert.equal(baseline.width, ISLAND_COMPACT_WIDTH)
    assert.equal(compact.width, SATELLITE_COMPACT_WIDTH)
    assert.equal(compact.height, ISLAND_COMPACT_HEIGHT)
    assert.equal(compact.y, baseline.y)
    assert.equal(
      compact.x + compact.width / 2,
      baseline.x + baseline.width / 2 - SATELLITE_CENTER_OFFSET
    )
    assert.deepEqual(satellite, {
      x: compact.x + compact.width + SATELLITE_GAP,
      y: compact.y,
      width: SATELLITE_SIZE,
      height: ISLAND_COMPACT_HEIGHT
    })
    assert.deepEqual(bridge, {
      x: compact.x + compact.width,
      y: compact.y,
      width: SATELLITE_GAP,
      height: ISLAND_COMPACT_HEIGHT
    })
  }
})

test('taskbar mode places a fixed-size button before the notification area with an 8-DIP gap', () => {
  for (const [dark, expectedTheme] of [
    [true, 'dark'],
    [false, 'light']
  ]) {
    const layout = resolveIslandLayout({
      display: displays[0],
      displays,
      displayMode: 'taskbar',
      taskbar: { ...primaryTaskbar, dark }
    })
    const button = screenRect(layout, layout.compact)

    assert.equal(layout.displayMode, 'taskbar')
    assert.equal(layout.taskbarTheme, expectedTheme)
    assert.equal(layout.direction, 'up')
    assert.deepEqual(
      { width: button.width, height: button.height },
      { width: TASKBAR_BUTTON_WIDTH, height: TASKBAR_BUTTON_HEIGHT }
    )
    assert.equal(
      button.x + button.width + TASKBAR_NOTIFICATION_GAP,
      primaryTaskbar.notificationArea.x
    )
    assert.equal(
      button.y,
      primaryTaskbar.bounds.y + (primaryTaskbar.bounds.height - TASKBAR_BUTTON_HEIGHT) / 2
    )
    assertVisibleGeometry(layout, displays[0])
  }
})

test('taskbar offset is relative to the taskbar and clamps to its horizontal bounds', () => {
  const options = {
    display: displays[0],
    displays,
    displayMode: 'taskbar',
    taskbar: primaryTaskbar
  }
  const custom = resolveIslandLayout({ ...options, taskbarOffsetX: CUSTOM_TASKBAR_OFFSET })
  const left = resolveIslandLayout({ ...options, taskbarOffsetX: -1 })
  const right = resolveIslandLayout({ ...options, taskbarOffsetX: Number.MAX_SAFE_INTEGER })

  assert.equal(
    screenRect(custom, custom.compact).x,
    primaryTaskbar.bounds.x + CUSTOM_TASKBAR_OFFSET
  )
  assert.equal(screenRect(left, left.compact).x, primaryTaskbar.bounds.x)
  assert.equal(
    screenRect(right, right.compact).x + right.compact.width,
    primaryTaskbar.bounds.x + primaryTaskbar.bounds.width
  )
})

test('taskbar compact size contract remains 132 x 36 DIP', () => {
  assert.equal(TASKBAR_BUTTON_WIDTH, 132)
  assert.equal(TASKBAR_BUTTON_HEIGHT, 36)
})

test('narrow taskbar bounds constrain button size and centering', () => {
  const taskbar = {
    bounds: {
      x: NARROW_TASKBAR_X,
      y: NARROW_TASKBAR_Y,
      width: NARROW_TASKBAR_WIDTH,
      height: NARROW_TASKBAR_HEIGHT
    },
    dark: false
  }
  const layout = resolveIslandLayout({
    display: displays[0],
    displays,
    displayMode: 'taskbar',
    taskbar
  })
  const button = screenRect(layout, layout.compact)

  assert.deepEqual(button, taskbar.bounds)
  assert.equal(layout.taskbarTheme, 'light')
  assert.ok(contains(taskbar.bounds, button))
})

test('taskbar cards expand upward and expose no satellite hit target', () => {
  const display = displays[0]
  const layout = resolveIslandLayout({
    display,
    displays,
    displayMode: 'taskbar',
    taskbar: primaryTaskbar
  })
  const button = screenRect(layout, layout.compact)
  const shortCard = screenRect(
    layout,
    resolveIslandModeRect({
      layout,
      mode: 'expanded',
      expandedHeight: ISLAND_SINGLE_TASK_HEIGHT,
      hasSatellite: false
    })
  )
  const tallCard = screenRect(
    layout,
    resolveIslandModeRect({
      layout,
      mode: 'expanded',
      expandedHeight: ISLAND_EXPANDED_HEIGHT,
      hasSatellite: false
    })
  )
  const compactHits = islandHitRects({
    layout,
    mode: 'compact',
    expandedHeight: ISLAND_TWO_TASK_HEIGHT,
    hasSatellite: true
  })
  const expandedHits = islandHitRects({
    layout,
    mode: 'expanded',
    expandedHeight: ISLAND_TWO_TASK_HEIGHT,
    hasSatellite: true
  })

  assert.equal(layout.direction, 'up')
  assert.ok(tallCard.y < button.y)
  assert.ok(tallCard.y + tallCard.height <= button.y)
  assert.equal(shortCard.y + shortCard.height, tallCard.y + tallCard.height)
  assert.ok(contains(display.workArea, shortCard))
  assert.ok(contains(display.workArea, tallCard))
  assert.deepEqual(compactHits, [layout.compact])
  assert.equal(expandedHits.length, 3)
  assert.equal(
    expandedHits.some((rect) => sameRect(rect, layout.satellite)),
    false
  )
  assert.ok(expandedHits.every((rect) => contains(canvasRect(layout), rect)))
})

function assertVisibleGeometry(layout, display) {
  const canvas = canvasRect(layout)
  for (const rect of [
    layout.compact,
    layout.alert,
    layout.expanded,
    layout.satellite,
    layout.bridge
  ]) {
    assert.ok(contains(canvas, rect), `canvas ${JSON.stringify(rect)}`)
  }
  for (const rect of [layout.compact, layout.satellite, layout.bridge]) {
    assert.ok(contains(display.bounds, screenRect(layout, rect)), `display ${JSON.stringify(rect)}`)
  }
  const cardArea =
    layout.displayMode === 'island'
      ? {
          ...display.workArea,
          y: display.bounds.y,
          height: display.workArea.y + display.workArea.height - display.bounds.y
        }
      : display.workArea
  for (const rect of [layout.alert, layout.expanded]) {
    assert.ok(contains(cardArea, screenRect(layout, rect)), `work area ${JSON.stringify(rect)}`)
  }
}

function canvasRect(layout) {
  return { x: 0, y: 0, width: layout.bounds.width, height: layout.bounds.height }
}

function screenRect(layout, rect) {
  return { ...rect, x: layout.bounds.x + rect.x, y: layout.bounds.y + rect.y }
}

function contains(outer, inner) {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  )
}

function sameRect(first, second) {
  return (
    first.x === second.x &&
    first.y === second.y &&
    first.width === second.width &&
    first.height === second.height
  )
}
