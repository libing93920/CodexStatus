/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const THEMES = [
  'midnight',
  'aurora',
  'cyber',
  'titan',
  'poster',
  'memphis',
  'cockpit',
  'inksong',
  'greenhouse',
  'swiss'
]

// 保留失败结果交给底部 rejection handler，避免销毁最后一个窗口时 Electron 提前退出并返回 0。
app.on('window-all-closed', () => {})

async function inspectMinimalWindows(window) {
  return window.webContents.executeJavaScript(`(() => {
    return [...document.querySelectorAll('.minimal-preview__sample')].map((sample) => {
      const capsule = sample.querySelector('.capsule');
      const ball = sample.querySelector('.capsule__minimal');
      const ring = sample.querySelector('.capsule__minimal-ring');
      const value = sample.querySelector('.capsule__minimal-value');
      const range = document.createRange();
      range.selectNodeContents(value);
      const textRect = range.getBoundingClientRect();
      const capsuleStyle = getComputedStyle(capsule);
      const ballStyle = getComputedStyle(ball);
      const badgeStyle = getComputedStyle(capsule, '::after');
      return {
        theme: sample.dataset.theme,
        state: sample.dataset.state,
        isApiMode: sample.dataset.api === 'true',
        capsule: { width: capsule.getBoundingClientRect().width, height: capsule.getBoundingClientRect().height },
        ball: { width: ball.getBoundingClientRect().width, height: ball.getBoundingClientRect().height },
        ring: ring
          ? { width: ring.getBoundingClientRect().width, height: ring.getBoundingClientRect().height }
          : undefined,
        text: {
          value: value.textContent,
          width: textRect.width,
          height: textRect.height,
          cornerRadius: Math.hypot(textRect.width / 2, textRect.height / 2),
          fontSize: Number.parseFloat(getComputedStyle(value).fontSize)
        },
        color: ballStyle.color,
        capsuleStyle: {
          backgroundColor: capsuleStyle.backgroundColor,
          clipPath: capsuleStyle.clipPath,
          overflow: capsuleStyle.overflow
        },
        ballStyle: {
          backgroundColor: ballStyle.backgroundColor,
          backgroundImage: ballStyle.backgroundImage,
          clipPath: ballStyle.clipPath
        },
        badge: {
          top: badgeStyle.top,
          right: badgeStyle.right,
          width: badgeStyle.width,
          height: badgeStyle.height
        }
      };
    });
  })()`)
}

async function verifyMinimalWindows() {
  await app.whenReady()
  const server = await createServer({
    root: repositoryRoot,
    plugins: [react()],
    server: { host: '127.0.0.1', port: 0 }
  })
  await server.listen()
  const address = server.httpServer?.address()
  if (!address || typeof address === 'string')
    throw new Error('Vite preview server did not expose a port')

  const window = new BrowserWindow({ show: false, width: 480, height: 430 })
  try {
    await window.loadURL(`http://127.0.0.1:${address.port}/scripts/capsule-minimal-preview.html`)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 350))

    const inspected = await inspectMinimalWindows(window)
    const screenshotPath = process.argv
      .find((argument) => argument.startsWith('--screenshot='))
      ?.slice('--screenshot='.length)
    if (screenshotPath) {
      const image = await window.webContents.capturePage()
      const { writeFile } = await import('node:fs/promises')
      await writeFile(screenshotPath, image.toPNG())
    }

    const colors = new Set()
    for (const entry of inspected) {
      assert.deepEqual(entry.capsule, { width: 40, height: 40 }, entry.theme)
      assert.deepEqual(entry.ball, { width: 40, height: 40 }, entry.theme)
      if (entry.isApiMode) {
        assert.equal(
          entry.ring,
          undefined,
          `${entry.theme}/${entry.state}: API must not draw quota ring`
        )
      } else {
        assert.deepEqual(entry.ring, { width: 40, height: 40 }, `${entry.theme}/${entry.state}`)
      }
      assert.equal(entry.capsuleStyle.backgroundColor, 'rgba(0, 0, 0, 0)', entry.theme)
      assert.equal(entry.capsuleStyle.clipPath, 'none', entry.theme)
      assert.equal(entry.capsuleStyle.overflow, 'visible', entry.theme)
      assert.ok(
        entry.ballStyle.backgroundColor !== 'rgba(0, 0, 0, 0)' ||
          entry.ballStyle.backgroundImage !== 'none',
        entry.theme
      )
      assert.match(entry.ballStyle.clipPath, /circle\(50%/, entry.theme)
      assert.equal(entry.badge.top, '1px', entry.theme)
      assert.equal(entry.badge.right, '1px', entry.theme)
      assert.deepEqual(
        { width: entry.badge.width, height: entry.badge.height },
        { width: '6px', height: '6px' },
        entry.theme
      )
      assert.ok(entry.text.width > 0 && entry.text.height > 0, entry.theme)
      assert.ok(
        entry.text.cornerRadius <= (entry.isApiMode ? 18.5 : 16.9),
        `${entry.theme}/${entry.state}: text overlaps ring`
      )
      colors.add(entry.color)
    }
    assert.ok(colors.size >= 3, 'theme palette does not reach production preview')

    const apiSamples = inspected.filter((entry) => entry.isApiMode)
    assert.deepEqual(
      apiSamples.map((entry) => entry.text.value),
      ['12万', '1.2亿'],
      'API token formatting must match the production zh-CN formatter'
    )
    assert.ok(
      apiSamples.every((entry) => entry.text.fontSize <= 14),
      'API minimal font must use the production compact size'
    )
    assert.equal(inspected.length, THEMES.length + 6)
    assert.deepEqual(new Set(inspected.map((entry) => entry.theme)), new Set(THEMES))
    const capsule = window.webContents
    const badgeColors = await capsule.executeJavaScript(`(() => {
      const element = document.querySelector('#sample-midnight-100 .capsule');
      const colors = [];
      for (const className of ['has-update', 'has-announcement', 'is-outdated']) {
        element.className = 'capsule capsule--capsule capsule--minimal ' + className;
        colors.push(getComputedStyle(element, '::after').backgroundColor);
      }
      return colors;
    })()`)
    assert.equal(new Set(badgeColors).size, 3)
  } finally {
    window.destroy()
    await server.close()
  }
}

verifyMinimalWindows().then(
  () => app.quit(),
  (error) => {
    console.error(error)
    app.exit(1)
  }
)
