import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function readRendererStyles() {
  const assetRoot = resolve(repositoryRoot, 'src/renderer/src/assets')
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  const readCssTree = async (filePath, seen = new Set()) => {
    const normalizedPath = resolve(filePath)
    if (seen.has(normalizedPath)) {
      return ''
    }
    seen.add(normalizedPath)
    const source = await readFile(normalizedPath, 'utf8')
    const parts = source.split(/(@import\s+['"][^'"]+['"]\s*;)/g)
    let flattened = ''
    for (const part of parts) {
      const match = part.match(/^@import\s+['"]([^'"]+)['"]\s*;$/)
      flattened += match
        ? await readCssTree(resolve(resolve(normalizedPath, '..'), match[1]), seen)
        : part
    }
    return flattened
  }

  const [mainCss, themesCss] = await Promise.all([
    readCssTree(resolve(assetRoot, 'main.css')),
    readCssTree(resolve(assetRoot, 'themes.css'))
  ])
  return `${mainCss}\n${themesCss}`
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function verifyCockpitAnimations() {
  await app.whenReady()
  const window = new BrowserWindow({ show: false })

  try {
    const styles = await readRendererStyles()
    const html = `<!doctype html>
      <html>
        <head><style>${styles}</style></head>
        <body>
          <div data-theme="cockpit">
            <div id="normal" class="capsule__percent">73%</div>
            <div id="refreshed" class="capsule__percent is-just-refreshed">73%</div>
            <div id="critical" class="capsule__percent is-critical">12%</div>
          </div>
        </body>
      </html>`
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)

    const animations = await window.webContents.executeJavaScript(`({
      normal: getComputedStyle(document.querySelector('#normal')).animationName,
      refreshed: getComputedStyle(document.querySelector('#refreshed')).animationName,
      critical: getComputedStyle(document.querySelector('#critical')).animationName
    })`)

    assert.deepEqual(animations, {
      normal: 'cockpit-nixie-flicker',
      refreshed: 'capsule-percent-pop',
      critical: 'capsule-critical-pulse'
    })
  } finally {
    window.destroy()
  }
}

verifyCockpitAnimations().then(
  () => app.quit(),
  (error) => {
    console.error(error)
    app.exit(1)
  }
)
