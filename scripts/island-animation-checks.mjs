/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'

const INTERRUPT_PROGRESS = 0.2
const RECT_TOLERANCE = 1
const MIN_INTERMEDIATE_SAMPLES = 2

const ANIMATION_TIMEOUT_MS = 5_000
const ENTRY_OPACITY_MIN = 0.15
const ENTRY_OPACITY_MAX = 0.65
const SAME_FRAME_OPACITY_TOLERANCE = 0.02
const BACKGROUND_CHANNEL_TOLERANCE = 0.002

export async function waitForIslandAnimations(window, mode) {
  return window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const started = performance.now()
    let stableFrames = 0
    const sample = () => {
      const island = document.querySelector('.island')
      const finite = document.querySelector('.island-stage').getAnimations({ subtree: true }).filter(animation =>
        animation.effect?.getComputedTiming().iterations !== Infinity &&
        (animation.playState === 'running' || animation.pending))
      const rebasing = document.querySelector('.island-window').dataset.viewportRebasing === 'true'
      stableFrames = document.querySelector('.island-window').dataset.mode === ${JSON.stringify(mode)} && !rebasing && !finite.length
        ? stableFrames + 1 : 0
      if (stableFrames >= 2) resolve()
      else if (performance.now() - started > ${ANIMATION_TIMEOUT_MS}) reject(new Error('Island animation did not settle: ${mode}'))
      else requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })`)
}

export async function verifyEntryClickContinuity({ window, present, click, label }) {
  const selector = label === 'taskbar' ? '.taskbar-anchor' : '.island'
  await installEntryProbe(window, selector)
  present()
  await waitForEntryOpacity(window, selector)
  await click()
  await window.webContents.executeJavaScript(
    `Promise.race([window.__entryClickProbe.clicked, new Promise((_, reject) => setTimeout(() => reject(new Error('Trusted click was not delivered')), ${ANIMATION_TIMEOUT_MS}))])`
  )
  const result = await window.webContents.executeJavaScript(`new Promise(resolve => {
    requestAnimationFrame(() => {
      const probe = window.__entryClickProbe
      probe.dispose()
      resolve({ before: probe.before, after: probe.after, mutations: probe.mutations })
    })
  })`)
  console.log(JSON.stringify({ islandEntryClick: label, ...result }))
  assert.ok(result.before, `${label}: real click event was not observed`)
  assert.ok(result.after, `${label}: click microtask was not observed`)
  assert.equal(result.before.isTrusted, true)
  assert.ok(result.before.opacity < 1, `${label}: entry had already finished`)
  const immediate = [result.after, ...result.mutations].filter(
    (sample) => sample.frameTime === result.before.frameTime
  )
  for (const sample of immediate) {
    assert.notEqual(sample.opacityAnimationState, 'idle', `${label}: click cancelled entry opacity`)
    assert.ok(
      Math.abs(sample.opacity - result.before.opacity) <= SAME_FRAME_OPACITY_TOLERANCE,
      `${label}: entry opacity snapped ${result.before.opacity} -> ${sample.opacity}`
    )
    assert.ok(
      Math.abs(sample.width - result.before.width) <= RECT_TOLERANCE,
      `${label}: entry width snapped ${result.before.width} -> ${sample.width}`
    )
  }
  await waitForIslandAnimations(window, 'expanded')
  return result
}

function installEntryProbe(window, selector) {
  return window.webContents.executeJavaScript(`(() => {
    const island = document.querySelector(${JSON.stringify(selector)})
    const probe = { mutations: [] }
    probe.clicked = new Promise(resolve => { probe.resolveClick = resolve })
    const sample = () => ({
      frameTime: document.timeline.currentTime,
      opacity: Number(getComputedStyle(island).opacity),
      width: island.getBoundingClientRect().width,
      mode: document.querySelector('.island-window').dataset.mode,
      opacityAnimationState: probe.opacityAnimation?.playState,
      opacityAnimationTime: probe.opacityAnimation?.currentTime
    })
    const handleClick = event => {
      if (!event.target.closest('.compact, .taskbar-anchor')) return
      probe.before = { ...sample(), isTrusted: event.isTrusted }
      probe.resolveClick()
      queueMicrotask(() => { probe.after = sample() })
    }
    const observer = new MutationObserver(() => {
      if (probe.before) probe.mutations.push(sample())
    })
    observer.observe(document.querySelector('.island-window'), { attributes: true, subtree: true })
    document.addEventListener('click', handleClick, true)
    probe.dispose = () => { observer.disconnect(); document.removeEventListener('click', handleClick, true) }
    window.__entryClickProbe = probe
  })()`)
}

function waitForEntryOpacity(window, selector) {
  return window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const started = performance.now()
    const sample = () => {
      const island = document.querySelector(${JSON.stringify(selector)})
      const opacity = Number(getComputedStyle(island).opacity)
      const animation = island.getAnimations().find(item => item.transitionProperty === 'opacity')
      if (document.querySelector('.island-window').dataset.mode === 'compact' && opacity >= ${ENTRY_OPACITY_MIN} && opacity <= ${ENTRY_OPACITY_MAX} && animation?.playState === 'running') {
        window.__entryClickProbe.opacityAnimation = animation
        resolve()
      } else if (performance.now() - started > ${ANIMATION_TIMEOUT_MS}) reject(new Error('Entry opacity interval was not observed'))
      else requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })`)
}

export async function verifyIslandMorph({ window, rects, label, expand, collapse, resize }) {
  const reports = []
  const verify = async (mode, trigger, target) => {
    const transition = await sampleTransition(window, { mode, target }, trigger)
    reports.push(assertTransition({ transition, target, label }))
  }
  await verify('expanded', expand, rects.expanded)
  await verify('compact', collapse, rects.compact)
  const reducedMotion = await window.webContents.executeJavaScript(
    "matchMedia('(prefers-reduced-motion: reduce)').matches"
  )
  if (!reducedMotion) {
    await sampleTransition(
      window,
      { mode: 'expanded', target: rects.expanded, interrupt: true },
      expand
    )
    await verify('compact', collapse, rects.compact)
  }
  await verify('expanded', expand, rects.expanded)
  if (!reducedMotion) {
    await sampleTransition(
      window,
      { mode: 'compact', target: rects.compact, interrupt: true },
      collapse
    )
    await verify('expanded', expand, rects.expanded)
  }
  await verify('expanded', () => resize(1), rects.shortExpanded)
  await verify('expanded', () => resize(4), rects.expanded)
  await verify('compact', collapse, rects.compact)
  return reports
}

async function sampleTransition(window, options, trigger) {
  await window.webContents.executeJavaScript(`(() => {
    const options = ${JSON.stringify(options)}
    const island = document.querySelector('.island')
    const rectOf = () => {
      const rect = island.getBoundingClientRect()
      return { x: screenX + rect.x, y: screenY + rect.y, width: rect.width, height: rect.height }
    }
    const before = rectOf()
    const samples = []
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
    const startedAt = performance.now()
    let stableFrames = 0
    window.__islandTransition = new Promise((resolve, reject) => {
      const sample = now => {
        const rect = rectOf()
        const mode = document.querySelector('.island-window').dataset.mode
        const rebasing = document.querySelector('.island-window').dataset.viewportRebasing === 'true'
        samples.push({ ...rect, time: now - startedAt, mode, rebasing })
        const finite = document.querySelector('.island-stage').getAnimations({ subtree: true }).filter(animation =>
          animation.effect?.getComputedTiming().iterations !== Infinity &&
          (animation.playState === 'running' || animation.pending))
        const atTarget = Object.keys(options.target).every(key => Math.abs(rect[key] - options.target[key]) <= ${RECT_TOLERANCE})
        stableFrames = mode === options.mode && !rebasing && !finite.length && atTarget ? stableFrames + 1 : 0
        const progress = (rect.width - before.width) / (options.target.width - before.width)
        if (options.interrupt && progress >= ${INTERRUPT_PROGRESS} && progress < 1) {
          resolve({ before, samples, mode: options.mode, reducedMotion })
        } else if (stableFrames >= 2 && !options.interrupt) {
          resolve({ before, samples, mode: options.mode, reducedMotion })
        } else if (now - startedAt > ${ANIMATION_TIMEOUT_MS}) {
          reject(new Error('Island transition did not reach target: ' + JSON.stringify({ options, before, last: samples.at(-1) })))
        } else requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    })
  })()`)
  await trigger()
  return window.webContents.executeJavaScript('window.__islandTransition')
}
export async function verifyTaskbarContinuity({ window, open, close, resize, rects }) {
  const reducedMotion = await window.webContents.executeJavaScript(
    "matchMedia('(prefers-reduced-motion: reduce)').matches"
  )
  for (const interrupt of reducedMotion ? [false] : [false, true]) {
    const opened = await samplePopup(window, { visible: true, interrupt }, open)
    assertTaskbarFrames(opened, false)
    if (!interrupt) {
      for (const count of [4, 1]) {
        const target = count === 4 ? rects.expanded : rects.shortExpanded
        const transition = await sampleTransition(window, { mode: 'expanded', target }, () =>
          resize(count)
        )
        assertTransition({ transition, target, label: 'taskbar-height' })
      }
    }
    const closed = await samplePopup(window, { visible: false }, close)
    assertTaskbarFrames(closed, true)
    assert.equal(closed.samples.at(-1).popupOpacity, 0)
    if (!reducedMotion)
      assert.ok(closed.samples.some((sample) => sample.popupOpacity > 0 && sample.popupOpacity < 1))
  }
  if (!reducedMotion) {
    assertTaskbarFrames(await samplePopup(window, { visible: true }, open), false)
    const closing = await samplePopup(window, { visible: false, interrupt: true }, close)
    assertTaskbarFrames(closing, true)
    const reopened = await samplePopup(window, { visible: true }, open)
    assertTaskbarFrames(reopened, false)
    assert.ok(reopened.before.popupOpacity > 0 && reopened.before.popupOpacity < 1)
    assert.ok(
      reopened.samples.some(
        (sample) => sample.popupOpacity > reopened.before.popupOpacity && sample.popupOpacity < 1
      )
    )
    assertTaskbarFrames(await samplePopup(window, { visible: false }, close), true)
    console.log(JSON.stringify({ taskbarReopen: 'continued-from-closing-frame' }))
  }
}

async function samplePopup(window, options, trigger) {
  await window.webContents.executeJavaScript(`(() => {
    const options = ${JSON.stringify(options)}
    const anchor = document.querySelector('.taskbar-anchor')
    if (!anchor) throw new Error('Taskbar anchor is missing before popup opens')
    const popup = document.querySelector('.island')
    const rectOf = element => {
      const rect = element.getBoundingClientRect()
      return { x: screenX + rect.x, y: screenY + rect.y, width: rect.width, height: rect.height }
    }
    const sample = () => {
      const current = document.querySelector('.taskbar-anchor')
      const style = getComputedStyle(current)
      return {
        sameNode: current === anchor,
        hovered: current.dataset.hovered === 'true',
        pressed: current.dataset.pressed === 'true',
        selected: current.getAttribute('aria-expanded') === 'true',
        nativeHovered: current.matches(':hover'),
        anchorClientRect: { x: current.getBoundingClientRect().x, y: current.getBoundingClientRect().y },
        trustedPointerClient: window.__trustedPointerClient,
        fixturePointerScreen: window.__fixturePointerScreen,
        anchorRect: rectOf(current),
        anchorBackground: style.backgroundColor,
        backgroundAnimating: current.getAnimations().some(animation =>
          animation.transitionProperty === 'background-color' &&
          (animation.playState === 'running' || animation.pending)),
        baseBackground: style.getPropertyValue('--taskbar-button'),
        hoverBackground: style.getPropertyValue('--taskbar-button-hover'),
        selectedBackground: style.getPropertyValue('--taskbar-button-selected'),
        pressedBackground: style.getPropertyValue('--taskbar-button-pressed'),
        anchorOpacity: Number(style.opacity),
        popupOpacity: Number(getComputedStyle(popup).opacity),
        logicalMode: document.querySelector('.island-window').dataset.mode,
        popupVisible: popup.dataset.popupVisible === 'true',
        popupInert: popup.inert,
        contentInert: popup.querySelector('.' + popup.dataset.mode).inert,
        contentTitle: popup.querySelector('.' + popup.dataset.mode + ' h2')?.textContent,
        taskRows: document.querySelectorAll('.task').length,
        cardMode: popup.dataset.mode,
        contentOpacity: Number(getComputedStyle(popup.querySelector('.' + popup.dataset.mode)).opacity)
      }
    }
    const before = sample()
    const samples = []
    const observer = new MutationObserver(() => samples.push(sample()))
    observer.observe(document.querySelector('.island-window'), { attributes: true, subtree: true, childList: true, attributeFilter: ['inert', 'aria-hidden', 'aria-expanded', 'data-mode', 'data-popup-visible', 'data-hovered', 'data-pressed'] })
    const started = performance.now()
    let stableFrames = 0
    window.__taskbarTransition = new Promise((resolve, reject) => {
      const finish = result => { observer.disconnect(); resolve(result) }
      const frame = () => {
        const current = sample()
        samples.push(current)
        const active = document.querySelector('.island-stage').getAnimations({ subtree: true }).some(animation =>
          animation.effect?.getComputedTiming().iterations !== Infinity &&
          (animation.playState === 'running' || animation.pending))
        const target = options.visible ? 1 : 0
        const visible = popup.dataset.popupVisible === String(options.visible)
        const rebasing = document.querySelector('.island-window').dataset.viewportRebasing === 'true'
        stableFrames = current.popupOpacity === target && visible && !active && !rebasing ? stableFrames + 1 : 0
        const progress = options.visible ? current.popupOpacity : 1 - current.popupOpacity
        if (options.interrupt && visible && progress >= ${INTERRUPT_PROGRESS} && progress < 1) finish({ before, samples, settled: false })
        else if (!options.interrupt && stableFrames >= 2) finish({ before, samples, settled: true })
        else if (performance.now() - started > ${ANIMATION_TIMEOUT_MS}) { observer.disconnect(); reject(new Error('Taskbar popup did not settle: ' + JSON.stringify(current))) }
        else requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    })
  })()`)
  await trigger()
  return window.webContents.executeJavaScript('window.__taskbarTransition')
}

function assertTaskbarFrames({ before, samples, settled }, closing) {
  assert.ok(samples.length)
  const hoverChange = samples.find((sample) => sample.anchorBackground !== before.anchorBackground)
  if (hoverChange)
    console.log(JSON.stringify({ taskbarHoverTransition: { before, firstChanged: hoverChange } }))
  let feedbackChanged = before.backgroundAnimating
  for (const sample of samples) {
    feedbackChanged ||=
      sample.hovered !== before.hovered ||
      sample.pressed !== before.pressed ||
      sample.selected !== before.selected
    assert.equal(sample.sameNode, true, 'popup replaced the taskbar anchor')
    assert.equal(sample.anchorOpacity, 1, 'popup faded the taskbar anchor')
    assert.equal(sample.baseBackground, before.baseBackground)
    assert.equal(sample.hoverBackground, before.hoverBackground)
    assert.equal(sample.selectedBackground, before.selectedBackground)
    assert.equal(sample.pressedBackground, before.pressedBackground)
    assertAnchorBackground(sample)
    if (!feedbackChanged) {
      assert.equal(
        sample.anchorBackground,
        before.anchorBackground,
        'popup changed anchor background'
      )
    }
    assertSettledRect(sample.anchorRect, before.anchorRect, 'taskbar anchor')
    if (closing && sample.popupOpacity > 0) {
      assert.equal(sample.cardMode, before.cardMode, 'close changed visible popup content')
      assert.equal(sample.contentTitle, before.contentTitle, 'close removed visible popup content')
      assert.equal(
        sample.contentOpacity,
        before.contentOpacity,
        'close faded content inside a visible popup shell'
      )
    }
  }
  if (settled) {
    const last = samples.at(-1)
    assert.equal(last.selected, !closing, 'anchor selection does not follow popup state')
    assert.equal(last.pressed, false, 'popup transition left anchor pressed')
    assertTaskbarFeedback(last)
  }
  console.log(
    JSON.stringify({ taskbarContinuity: closing ? 'close' : 'open', sampleCount: samples.length })
  )
}

function assertAnchorBackground(sample) {
  // 反馈可在开关浮层时切换；过渡帧只能落在当前主题定义的颜色范围内。
  const colors = [
    sample.baseBackground,
    sample.hoverBackground,
    sample.selectedBackground,
    sample.pressedBackground
  ].map(colorChannels)
  for (const [index, value] of colorChannels(sample.anchorBackground).entries()) {
    const minimum = Math.min(...colors.map((color) => color[index])) - BACKGROUND_CHANNEL_TOLERANCE
    const maximum = Math.max(...colors.map((color) => color[index])) + BACKGROUND_CHANNEL_TOLERANCE
    assert.ok(
      value >= minimum && value <= maximum,
      `popup changed anchor background: ${sample.anchorBackground}`
    )
  }
}

export function assertTaskbarFeedback(sample) {
  const expected = sample.pressed
    ? sample.pressedBackground
    : sample.hovered
      ? sample.hoverBackground
      : sample.selected
        ? sample.selectedBackground
        : sample.baseBackground
  const expectedChannels = colorChannels(expected)
  for (const [index, value] of colorChannels(sample.anchorBackground).entries()) {
    assert.ok(
      Math.abs(value - expectedChannels[index]) <= BACKGROUND_CHANNEL_TOLERANCE,
      `anchor feedback did not settle: ${JSON.stringify(sample)}`
    )
  }
}

function colorChannels(color) {
  const normalized = color.trim()
  assert.match(normalized, /^rgba?\(/, `unsupported taskbar color: ${color}`)
  const channels = normalized.match(/[\d.]+/g).map(Number)
  assert.ok(channels.length === 3 || channels.length === 4, `invalid taskbar color: ${color}`)
  return channels.length === 3 ? [...channels, 1] : channels
}

export async function verifyTaskbarAlertExit({ window, trigger, label }) {
  const transition = await samplePopup(window, { visible: false }, trigger)
  assert.equal(transition.before.cardMode, 'alert')
  assert.ok(transition.before.contentTitle)
  assertTaskbarFrames(transition, true)
  const exiting = transition.samples.filter((sample) => sample.logicalMode === 'compact')
  assert.ok(exiting.length)
  for (const sample of exiting) {
    assert.equal(sample.popupInert, true, `${label}: popup still accepts input during exit`)
    assert.equal(sample.contentInert, true, `${label}: stale alert still accepts input`)
  }
  if (label === 'removed') {
    const removed = transition.samples.filter((sample) => sample.taskRows === 0)
    assert.ok(removed.length)
    assert.ok(
      removed.every((sample) => sample.contentInert),
      'removed alert remains interactive'
    )
  }
  assert.equal(transition.samples.at(-1).popupOpacity, 0)
  console.log(JSON.stringify({ taskbarAlertExit: label, sampleCount: transition.samples.length }))
  return transition
}
function assertTransition({ transition, target, label }) {
  const { before, samples } = transition
  const axis = Math.abs(target.width - before.width) > RECT_TOLERANCE ? 'width' : 'height'
  const distance = target[axis] - before[axis]
  assert.ok(Math.abs(distance) > RECT_TOLERANCE, `${label}: missing geometry change`)
  let maxHorizontalDrift = 0
  let maxVerticalDrift = 0
  let intermediateCount = 0
  let largestDriftSample
  for (const sample of samples) {
    const progress = (sample[axis] - before[axis]) / distance
    // 宽度和位置应沿同一条伸缩路径变化，不能收缩后再横移或上下漂移。
    const expectedX = before.x + (target.x - before.x) * progress
    const expectedY = before.y + (target.y - before.y) * progress
    const horizontalDrift = Math.abs(sample.x - expectedX)
    if (horizontalDrift > maxHorizontalDrift) largestDriftSample = sample
    maxHorizontalDrift = Math.max(maxHorizontalDrift, horizontalDrift)
    maxVerticalDrift = Math.max(maxVerticalDrift, Math.abs(sample.y - expectedY))
    if (progress > 0 && progress < 1) intermediateCount++
  }
  const report = {
    label,
    mode: transition.mode,
    sampleCount: samples.length,
    intermediateCount,
    maxHorizontalDrift,
    maxVerticalDrift
  }
  console.log(JSON.stringify({ islandMorph: report }))
  assert.ok(
    maxHorizontalDrift <= RECT_TOLERANCE,
    JSON.stringify({ ...report, before, target, largestDriftSample })
  )
  assert.ok(maxVerticalDrift <= RECT_TOLERANCE, JSON.stringify(report))
  if (!transition.reducedMotion) assert.ok(intermediateCount >= MIN_INTERMEDIATE_SAMPLES)
  assertSettledRect(samples.at(-1), target, label)
  assert.equal(samples.at(-1).mode, transition.mode)
  return report
}

function assertSettledRect(actual, expected, label) {
  for (const key of ['x', 'y', 'width', 'height']) {
    assert.ok(Math.abs(actual[key] - expected[key]) <= RECT_TOLERANCE, `${label}: ${key}`)
  }
}
