/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'
import { build } from 'esbuild'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const GROUP = '.island-mode-setting [role="radiogroup"]'
const RADIO = `${GROUP} [role="radio"]`
const STYLE_KEYS = [
  'borderRadius',
  'borderWidth',
  'borderColor',
  'backgroundColor',
  'backgroundImage',
  'boxShadow',
  'color',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'letterSpacing',
  'clipPath'
]
const FRAME_DELAY_MS = 80
const MODE_STATES = [
  { enabled: true, displayMode: 'island' },
  { enabled: true, displayMode: 'taskbar' },
  { enabled: false, displayMode: 'island' },
  { enabled: false, displayMode: 'taskbar' }
]
assert.ok(process.env.PI_SCRATCH_DIR, 'Run through run-with-test-scratch.mjs')
const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR, 'island-settings-'))
app.setPath('userData', join(directory, 'user-data'))
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
let window
const timeout = setTimeout(() => {
  console.error('Island settings test timed out')
  app.exit(1)
}, 60_000)

async function cssTree(file) {
  const parts = (await readFile(file, 'utf8')).split(/(@import\s+['"][^'"]+['"]\s*;)/g)
  const styles = await Promise.all(
    parts.map((part) => {
      const match = part.match(/^@import\s+['"]([^'"]+)['"]\s*;$/)
      return match ? cssTree(resolve(dirname(file), match[1])) : part
    })
  )
  return styles.join('')
}

const evaluate = (expression) => window.webContents.executeJavaScript(expression, true)
const reset = (state = {}) => evaluate(`islandSettingsFixture.reset(${JSON.stringify(state)})`)

async function createFixture() {
  const styles =
    (await cssTree(join(ROOT, 'src/renderer/src/assets/main.css'))) +
    (await cssTree(join(ROOT, 'src/renderer/src/assets/themes.css')))
  const bundle = await build({
    entryPoints: [join(ROOT, 'scripts/fixtures/island-settings-renderer.jsx')],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' }
  })
  await writeFile(join(directory, 'fixture.js'), bundle.outputFiles[0].text)
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; img-src data:"><style>${styles}
    *{animation:none!important;transition:none!important}.panel{padding:20px;gap:12px}
  </style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`
  await writeFile(join(directory, 'fixture.html'), html)
  await app.whenReady()
  window = new BrowserWindow({
    show: false,
    width: 480,
    height: 600,
    webPreferences: { offscreen: true, backgroundThrottling: false }
  })
  await window.loadURL(pathToFileURL(join(directory, 'fixture.html')).href)
}

async function themeStyles() {
  return evaluate(`(() => {
    const pick = element => {
      const style = getComputedStyle(element)
      return Object.fromEntries(${JSON.stringify(STYLE_KEYS)}.map(key => [key, style[key]]))
    }
    const group = document.querySelector(${JSON.stringify(GROUP)})
    const buttons = Array.from(group.querySelectorAll('[role="radio"]'))
    const reference = Array.from(document.querySelectorAll('.reference .segmented button'))
    const owner = document.querySelector('.island-setting[role="group"]')
    return {
      current: buttons.map(pick), reference: reference.map(pick),
      groupOpacity: getComputedStyle(group).opacity,
      referenceOpacity: getComputedStyle(document.querySelector('.reference .segmented')).opacity,
      checked: buttons.map(button => button.getAttribute('aria-checked')),
      disabled: buttons.map(button => button.disabled),
      tabStops: buttons.map(button => button.tabIndex),
      labels: buttons.map(button => button.textContent.trim()),
      nestedWithToggle: owner?.contains(group) && owner.contains(document.querySelector('.toggle-switch')),
      overflow: buttons.some(button => button.scrollWidth > button.clientWidth + 1)
    }
  })()`)
}

async function verifyThemes() {
  const themes = await evaluate('islandSettingsFixture.themes')
  let cases = 0
  for (const theme of themes)
    for (const locale of ['zh-CN', 'en-US']) {
      for (const { enabled, displayMode } of MODE_STATES) {
        await reset({ theme, locale, enabled, displayMode })
        const styles = await themeStyles()
        const selected = displayMode === 'island' ? 0 : 1
        assert.deepEqual(styles.current, styles.reference, `${theme}/${locale}: themed options`)
        assert.equal(styles.groupOpacity, styles.referenceOpacity)
        assert.deepEqual(styles.checked, selected === 0 ? ['true', 'false'] : ['false', 'true'])
        assert.deepEqual(styles.disabled, [!enabled, !enabled])
        assert.deepEqual(styles.tabStops, selected === 0 ? [0, -1] : [-1, 0])
        assert.deepEqual(
          styles.labels,
          locale === 'zh-CN' ? ['灵动岛', '任务栏'] : ['Dynamic Island', 'Taskbar']
        )
        assert.equal(styles.overflow, false, `${theme}/${locale}: text overflow`)
        assert.equal(styles.nestedWithToggle, true, 'display mode belongs to task activity group')
        cases++
        await saveThemeScreenshot({ theme, locale, enabled, displayMode })
      }
    }
  console.log(`PASS theme styles, selection and disabled state: ${cases} cases`)
}

async function saveThemeScreenshot({ theme, locale, enabled, displayMode }) {
  if (locale !== 'zh-CN' || !enabled || displayMode !== 'island') return
  await delay(FRAME_DELAY_MS)
  await writeFile(join(directory, `${theme}.png`), (await window.webContents.capturePage()).toPNG())
}

async function click(selector) {
  const point = await evaluate(`(() => {
    const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect()
    return {x:Math.round(rect.x+rect.width/2), y:Math.round(rect.y+rect.height/2)}
  })()`)
  window.webContents.sendInputEvent({ type: 'mouseMove', ...point })
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
  await delay(FRAME_DELAY_MS)
}

async function press(keyCode, modifiers = []) {
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  if (keyCode === ' ') window.webContents.sendInputEvent({ type: 'char', keyCode, modifiers })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  await delay(FRAME_DELAY_MS)
}

async function inspect() {
  return evaluate(`(() => {
    const buttons = Array.from(document.querySelectorAll(${JSON.stringify(RADIO)}))
    return {
      preferences: islandSettingsFixture.preferences(), changes: islandSettingsFixture.changes(),
      focused: buttons.indexOf(document.activeElement), focusId: document.activeElement.id,
      checked: buttons.map(button => button.getAttribute('aria-checked'))
    }
  })()`)
}

async function verifyClickAndToggle(theme) {
  await reset({ theme })
  await click(`${RADIO}:nth-child(1)`)
  assert.deepEqual((await inspect()).changes, [], 'selected click must not resubmit')
  await click(`${RADIO}:nth-child(2)`)
  assert.deepEqual((await inspect()).changes, [{ enabled: true, displayMode: 'taskbar' }])
  await click(`${RADIO}:nth-child(2)`)
  assert.equal((await inspect()).changes.length, 1)
  await click('.toggle-switch')
  assert.deepEqual((await inspect()).preferences, { enabled: false, displayMode: 'taskbar' })
  const before = (await inspect()).changes.length
  await click(`${RADIO}:nth-child(1)`)
  await evaluate(`document.querySelector(${JSON.stringify(RADIO)}).click()`)
  assert.equal((await inspect()).changes.length, before, 'disabled cannot change preferences')
  await click('.toggle-switch')
  assert.deepEqual((await inspect()).preferences, { enabled: true, displayMode: 'taskbar' })
}

async function verifyKeyboard() {
  await reset()
  await evaluate(`document.querySelector(${JSON.stringify(RADIO)}).focus()`)
  for (const [key, mode] of [
    ['Right', 'taskbar'],
    ['Right', 'island'],
    ['Left', 'taskbar'],
    ['Up', 'island'],
    ['Down', 'taskbar']
  ]) {
    await press(key)
    const state = await inspect()
    assert.equal(state.preferences.displayMode, mode, `keyboard ${key}`)
    assert.equal(state.focused, mode === 'island' ? 0 : 1)
  }
  await evaluate(`document.querySelector(${JSON.stringify(RADIO)}).focus()`)
  await press(' ')
  assert.equal((await inspect()).preferences.displayMode, 'island', 'Space selects focused option')
  assert.equal((await inspect()).changes.length, 6)
  await press(' ')
  assert.equal((await inspect()).changes.length, 6, 'Space on selected option must not resubmit')
  console.log('PASS real arrow/Space keys, wrapped selection and focus movement')
}

async function verifyFocusVisible() {
  const focus = await evaluate(`(() => {
    const element = document.activeElement
    const style = getComputedStyle(element)
    return {width:style.outlineWidth, style:style.outlineStyle,
      visible:element.matches(':focus-visible'), focused:element.matches(':focus')}
  })()`)
  assert.deepEqual(focus, { width: '2px', style: 'solid', visible: true, focused: true })
}

async function verifyTab() {
  const themes = await evaluate('islandSettingsFixture.themes')
  for (const theme of themes)
    for (const displayMode of ['island', 'taskbar']) {
      await reset({ theme, displayMode })
      await evaluate("document.querySelector('.toggle-switch').focus()")
      await press('Tab')
      assert.equal((await inspect()).focused, displayMode === 'island' ? 0 : 1)
      await verifyFocusVisible()
      await press('Tab')
      assert.equal((await inspect()).focusId, 'after')
      await press('Tab', ['shift'])
      assert.equal((await inspect()).focused, displayMode === 'island' ? 0 : 1)
    }
  await reset({ enabled: false, displayMode: 'taskbar' })
  await evaluate("document.querySelector('.toggle-switch').focus()")
  await press('Tab')
  assert.equal((await inspect()).focusId, 'after', 'Tab skips disabled group')
  assert.deepEqual((await inspect()).changes, [])
  console.log('PASS 10-theme selected Tab stop, reverse Tab, visible focus and disabled group skip')
}

async function run() {
  await createFixture()
  await verifyThemes()
  await reset()
  window.setOpacity(0)
  window.showInactive()
  window.focus()
  window.webContents.focus()
  for (const theme of await evaluate('islandSettingsFixture.themes'))
    await verifyClickAndToggle(theme)
  console.log(
    'PASS 10-theme mouse selection, repeat selection, disabled and enable/disable preserve mode'
  )
  await verifyKeyboard()
  await verifyTab()
  console.log(`Island settings checks passed. Screenshots: ${directory}`)
}

run()
  .then(() => {
    clearTimeout(timeout)
    window?.destroy()
    app.exit(0)
  })
  .catch((error) => {
    console.error(error)
    clearTimeout(timeout)
    window?.destroy()
    app.exit(1)
  })
