/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'
import { build } from 'esbuild'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STYLE_KEYS = [
  'borderRadius',
  'borderTopWidth',
  'borderTopColor',
  'backgroundColor',
  'backgroundImage',
  'boxShadow',
  'color',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'letterSpacing',
  'clipPath',
  'transform',
  'translate',
  'scale'
]
assert.ok(process.env.PI_SCRATCH_DIR, 'Run through run-with-test-scratch.mjs')
const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR, 'session-cleaner-settings-'))
app.setPath('userData', join(directory, 'user-data'))
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
let window
const timeout = setTimeout(() => {
  console.error('Session cleaner settings test timed out')
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

async function waitFor(label, check) {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(40)
  }
  throw new Error(`Timed out: ${label}`)
}

async function createFixture() {
  const styles =
    (await cssTree(join(ROOT, 'src/renderer/src/assets/main.css'))) +
    (await cssTree(join(ROOT, 'src/renderer/src/assets/themes.css')))
  const bundle = await build({
    entryPoints: [join(ROOT, 'scripts/fixtures/session-cleaner-settings-renderer.jsx')],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' }
  })
  await writeFile(join(directory, 'fixture.js'), bundle.outputFiles[0].text)
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${styles}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`
  await writeFile(join(directory, 'fixture.html'), html)
  await app.whenReady()
  window = new BrowserWindow({
    show: false,
    width: 480,
    height: 600,
    webPreferences: { offscreen: true, backgroundThrottling: false }
  })
  await window.loadURL(pathToFileURL(join(directory, 'fixture.html')).href)
  await waitFor('actual App settings', () =>
    evaluate("document.querySelector('.session-cleaner-setting__action') !== null")
  )
  window.setOpacity(0)
  window.showInactive()
  window.focus()
  window.webContents.focus()
}

async function selectTheme(theme, label) {
  const clicked = await evaluate(`(() => {
    const section = document.querySelector('.settings-section')
    const button = Array.from(section.querySelectorAll('.segmented button')).find(
      entry => entry.textContent.trim() === ${JSON.stringify(label)}
    )
    if (!button) return false
    button.click()
    return true
  })()`)
  assert.equal(clicked, true, `Missing theme option: ${theme}`)
  await waitFor(`theme ${theme}`, () =>
    evaluate(`document.querySelector('.app-shell').dataset.theme === ${JSON.stringify(theme)}`)
  )
  await evaluate(
    "document.querySelector('.session-cleaner-setting').scrollIntoView({ block: 'center' })"
  )
  await movePointer('.panel__title')
}

async function buttonStyles() {
  return evaluate(`(() => {
    const pick = element => {
      const style = getComputedStyle(element)
      return Object.fromEntries(${JSON.stringify(STYLE_KEYS)}.map(key => [key, style[key]]))
    }
    return {
      actual: pick(document.querySelector('.session-cleaner-setting__action')),
      reference: pick(document.querySelector('.panel__footer .ghost-button'))
    }
  })()`)
}

async function movePointer(selector) {
  const point = await evaluate(`(() => {
    const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect()
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
  })()`)
  window.webContents.sendInputEvent({ type: 'mouseMove', ...point })
  await delay(350)
}

async function click(selector) {
  const clicked = await evaluate(`(() => {
    const button = document.querySelector(${JSON.stringify(selector)})
    if (!button || button.disabled) return false
    button.click()
    return true
  })()`)
  assert.equal(clicked, true, `Cannot click ${selector}`)
  await delay(60)
}

async function verifyThemes() {
  const themes = await evaluate('cleanerSettingsTest.themes')
  for (const { value: theme, label } of themes) {
    await selectTheme(theme, label)
    const initial = await buttonStyles()
    assert.deepEqual(initial.actual, initial.reference, `${theme}: resting theme styles`)
    await movePointer('.session-cleaner-setting__action')
    const hovered = (await buttonStyles()).actual
    await movePointer('.panel__footer .ghost-button')
    const referenceHovered = (await buttonStyles()).reference
    assert.deepEqual(hovered, referenceHovered, `${theme}: hover theme styles`)
    const layout = await evaluate(`(() => {
      const row = document.querySelector('.session-cleaner-setting')
      const button = row.querySelector('.session-cleaner-setting__action')
      const icon = button.querySelector('svg')
      const rect = button.getBoundingClientRect()
      const iconRect = icon.getBoundingClientRect()
      return {
        width: rect.width, height: rect.height,
        iconWidth: iconRect.width, iconHeight: iconRect.height,
        last: row === row.parentElement.lastElementChild,
        overflow: row.scrollWidth > row.clientWidth,
        label: button.getAttribute('aria-label')
      }
    })()`)
    assert.deepEqual(layout, {
      width: 34,
      height: 34,
      iconWidth: 16,
      iconHeight: 16,
      last: true,
      overflow: false,
      label: '打开会话清理'
    })
  }
  console.log(`PASS actual App theme button and hover styles: ${themes.length} themes`)
}

async function verifyOpenAndClose() {
  await evaluate('cleanerSettingsTest.clearCalls()')
  await click('.session-cleaner-setting__action')
  assert.deepEqual(await evaluate('cleanerSettingsTest.calls()'), ['open'])
  await evaluate('cleanerSettingsTest.settleOpen()')
  await waitFor('settings close after cleaner opens', () =>
    evaluate("document.querySelector('.panel--details') !== null")
  )
  assert.deepEqual(await evaluate('cleanerSettingsTest.calls()'), ['open', 'close'])
  await evaluate(`(() => {
    const tab = Array.from(document.querySelectorAll('.panel__tab')).find(
      entry => entry.textContent.trim() === '设置'
    )
    tab.click()
  })()`)
  await waitFor('settings reopened', () =>
    evaluate("document.querySelector('.session-cleaner-setting__action') !== null")
  )
  await evaluate('cleanerSettingsTest.clearCalls(); cleanerSettingsTest.rejectNextOpen()')
  await click('.session-cleaner-setting__action')
  await delay(100)
  assert.deepEqual(await evaluate('cleanerSettingsTest.calls()'), ['open'])
  assert.equal(await evaluate("document.querySelector('.panel--settings') !== null"), true)
  console.log('PASS close settings only after cleaner successfully opens; failure keeps settings')
}

async function run() {
  await createFixture()
  await verifyThemes()
  await verifyOpenAndClose()
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
