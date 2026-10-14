/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { app, BrowserWindow } from 'electron'
import ts from 'typescript'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mainSource = await readFile(resolve(repositoryRoot, 'src/main/index.ts'), 'utf8')
const sharedSource = await readFile(resolve(repositoryRoot, 'src/shared/capsule.ts'), 'utf8')
const mainFile = ts.createSourceFile('index.ts', mainSource, ts.ScriptTarget.Latest, true)
const sharedFile = ts.createSourceFile('capsule.ts', sharedSource, ts.ScriptTarget.Latest, true)

function functionNode(file, name) {
  const node = file.statements.find(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name
  )
  assert.ok(node, `missing function ${name}`)
  return node
}

function variableStatement(file, name) {
  const node = file.statements.find(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name
      )
  )
  assert.ok(node, `missing variable ${name}`)
  return node.getText(file).replace(/^export\s+/, '')
}

const setSizeRegistration = functionNode(mainFile, 'registerIpcHandlers').body.statements.find(
  (statement) =>
    ts.isExpressionStatement(statement) &&
    ts.isCallExpression(statement.expression) &&
    statement.expression.arguments[0]?.getText(mainFile) === 'CHANNELS.setCapsuleSize'
)
assert.ok(setSizeRegistration, 'missing setCapsuleSize IPC handler')

const resolverNode = functionNode(mainFile, 'resolveCapsuleWindowSize')
const cacheDeclaration = resolverNode.body.statements.find(
  (statement) =>
    ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some(
      (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === 'contentSize'
    )
)
const apiGuard = resolverNode.body.statements.find(
  (statement) =>
    ts.isIfStatement(statement) &&
    statement.expression.getText(mainFile).includes("currentSnapshot.authMode === 'api'")
)
assert.ok(cacheDeclaration && apiGuard, 'missing API size cache resolver branch')
const legacyResolver = `function resolveCapsuleWindowSize(viewMode) {
  ${resolverNode.body.statements
    .filter((statement) => statement !== cacheDeclaration && statement !== apiGuard)
    .map((statement) => statement.getText(mainFile))
    .join('\n')}
}`
const capsuleFunctions = [
  'clamp',
  'getFiniteNumber',
  'getTargetWorkArea',
  'resolveCapsuleWindowSize',
  'resolveCapsuleBounds',
  'resolveDraggedCapsuleWindow',
  'resolveSettledCapsuleWindow',
  'resolveSettledOrbWindow',
  'applyCapsuleWindowPreferences',
  'moveCapsuleWindow',
  'finishCapsuleWindowDrag',
  'syncCapsuleWindowBounds'
]
const capsuleConstants = [
  variableStatement(mainFile, 'capsuleApiContentSizes'),
  variableStatement(mainFile, 'SINGLE_CAPSULE_WINDOW_WIDTH'),
  variableStatement(mainFile, 'SINGLE_ORB_WINDOW_HEIGHT'),
  ...[
    'CAPSULE_WINDOW_SIZE',
    'ORB_WINDOW_SIZE',
    'CAPSULE_EDGE_GAP',
    'CAPSULE_DOCK_EDGE_GAP',
    'CAPSULE_DOCK_THRESHOLD',
    'CAPSULE_UNDOCK_THRESHOLD'
  ].map((name) => variableStatement(sharedFile, name))
].join('\n')

function compileMainFixture(useLegacyResolver = false) {
  const functions = capsuleFunctions.map((name) =>
    name === 'resolveCapsuleWindowSize' && useLegacyResolver
      ? legacyResolver
      : functionNode(mainFile, name).getText(mainFile)
  )
  return ts.transpileModule(
    `${capsuleConstants}\n${functions.join('\n')}\n${setSizeRegistration.getText(mainFile)}`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }
  ).outputText
}

const fixedMainFixture = compileMainFixture()
const legacyMainFixture = compileMainFixture(true)

function createMainFixture(mainWindow, source) {
  const handlers = new Map()
  const workArea = { x: 0, y: 0, width: 2000, height: 1000 }
  const context = vm.createContext({
    mainWindow,
    currentSnapshot: { authMode: 'api' },
    persistedState: { window: { x: 200, y: 200, viewMode: 'capsule' } },
    capsuleMinimalRuntime: null,
    CHANNELS: new Proxy({}, { get: (_target, key) => String(key) }),
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    screen: {
      getDisplayNearestPoint: () => ({ workArea }),
      getPrimaryDisplay: () => ({ workArea })
    },
    queuePersistState: () => {},
    broadcastPreferences: () => {}
  })
  vm.runInContext(source, context)
  return { context, setSize: handlers.get('setCapsuleSize') }
}

function trackBrowserWindow(window) {
  const calls = { sizes: [], bounds: [] }
  const mainWindow = new Proxy(window, {
    get(target, key) {
      if (key === 'setSize')
        return (width, height) => {
          calls.sizes.push({ width, height })
          return target.setSize(width, height)
        }
      if (key === 'setBounds')
        return (bounds) => {
          calls.bounds.push(bounds)
          return target.setBounds(bounds)
        }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
  return { mainWindow, calls }
}

async function getProgressRect(window) {
  return window.webContents.executeJavaScript(`(() => {
    const { x, y, width, height } = document.querySelector('.capsule__progress').getBoundingClientRect()
    return { x, y, width, height }
  })()`)
}

function assertRequestedSize(windowSpy, size) {
  const bounds = windowSpy.calls.bounds.at(-1)
  assert.deepEqual({ width: bounds.width, height: bounds.height }, size)
}

function resolveSize(fixture, viewMode) {
  return JSON.parse(
    JSON.stringify(vm.runInContext(`resolveCapsuleWindowSize('${viewMode}')`, fixture.context))
  )
}

function dragAndFinish(fixture, window, desired, size) {
  const offsetX = size.width / 2
  const offsetY = size.height / 2
  window.setBounds({ x: 200, y: 200, ...size })
  fixture.context.persistedState.window = { x: 200, y: 200, viewMode: 'capsule' }
  fixture.context.moveCapsuleWindow({
    screenX: desired.x + offsetX,
    screenY: desired.y + offsetY,
    offsetX,
    offsetY
  })
  fixture.context.finishCapsuleWindowDrag()
}

async function readRendererStyles() {
  const assetRoot = resolve(repositoryRoot, 'src/renderer/src/assets')
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

function capsuleFixtureHtml(styles) {
  return `<!doctype html><html><head><style>${styles}</style></head><body>
    <div class="app-shell app-shell--capsule" data-theme="cockpit"><main class="widget">
      <section id="api-capsule" class="capsule capsule--capsule">
        <span class="capsule__deco" aria-hidden="true"></span>
        <div class="capsule__layout capsule__layout--h capsule__layout--h-api">
          <div class="capsule__stat"><span class="capsule__stat-label">TODAY</span><span class="capsule__stat-value">1.2M</span></div>
          <div class="capsule__stat capsule__stat--metric"><span class="capsule__stat-label">CACHE HIT</span><span class="capsule__stat-value">73%</span><span class="capsule__progress"><span style="width:73%"></span></span></div>
        </div>
      </section>
    </main></div><div data-theme="cockpit">
      <div id="normal" class="capsule__percent">73%</div>
      <div id="refreshed" class="capsule__percent is-just-refreshed">73%</div>
      <div id="critical" class="capsule__percent is-critical">12%</div>
    </div></body></html>`
}

async function verifyAnimationNames(window) {
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
}

async function measureApiCapsule(window) {
  const measured = await window.webContents.executeJavaScript(`(() => {
    const capsule = document.querySelector('#api-capsule')
    const previous = { width: capsule.style.width, height: capsule.style.height }
    capsule.style.width = 'max-content'
    capsule.style.height = 'max-content'
    const size = { width: capsule.offsetWidth, height: capsule.offsetHeight }
    capsule.style.width = previous.width
    capsule.style.height = previous.height
    return size
  })()`)
  assert.equal(measured.height, 57, `CSS API fixture measured ${measured.width}x${measured.height}`)
  return measured
}

async function verifyLegacyDrag(windowSpy, measured, startBounds) {
  const legacy = createMainFixture(windowSpy.mainWindow, legacyMainFixture)
  await legacy.setSize({}, measured)
  legacy.context.moveCapsuleWindow({
    screenX: startBounds.x + measured.width / 2 + 20,
    screenY: startBounds.y + measured.height / 2 + 15,
    offsetX: measured.width / 2,
    offsetY: measured.height / 2
  })
  const bounds = windowSpy.calls.bounds.at(-1)
  assert.deepEqual({ width: bounds.width, height: bounds.height }, { width: 160, height: 50 })
  return bounds
}

async function verifyMeasuredDragAndSync(fixed, windowSpy, measurements) {
  const { measured, startBounds, progressRect } = measurements
  await fixed.setSize({}, measured)
  const offsetX = measured.width / 2
  const offsetY = measured.height / 2
  fixed.context.moveCapsuleWindow({
    screenX: startBounds.x + offsetX + 20,
    screenY: startBounds.y + offsetY + 15,
    offsetX,
    offsetY
  })
  assertRequestedSize(windowSpy, measured)
  fixed.context.finishCapsuleWindowDrag()
  assertRequestedSize(windowSpy, measured)
  fixed.context.syncCapsuleWindowBounds()
  assertRequestedSize(windowSpy, measured)
  assert.equal(windowSpy.mainWindow.getBounds().height, measured.height)
  assert.deepEqual(await getProgressRect(windowSpy.mainWindow), progressRect)
}

function verifyDockSizing(fixed, windowSpy, measured) {
  const orb = { width: 72, height: 103 }
  const leftY = 400 + Math.round((measured.height - orb.height) / 2)
  const docks = [
    [
      { x: 0, y: 400 },
      { x: 0, y: leftY, ...orb }
    ],
    [
      { x: 2000 - measured.width, y: 400 },
      { x: 2000 - orb.width, y: leftY, ...orb }
    ],
    [
      { x: 400, y: 0 },
      { x: 400, y: 0, ...measured }
    ],
    [
      { x: 400, y: 1000 - measured.height },
      { x: 400, y: 1000 - measured.height, ...measured }
    ]
  ]
  for (const [desired, expected] of docks) {
    dragAndFinish(fixed, windowSpy.mainWindow, desired, measured)
    const bounds = windowSpy.calls.bounds.at(-1)
    assert.deepEqual(
      { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      expected
    )
  }
}

async function verifyCachesAndOAuth(fixed, measured) {
  fixed.context.persistedState.window.viewMode = 'orb'
  await fixed.setSize({}, { width: 72, height: 103 })
  assert.deepEqual(resolveSize(fixed, 'orb'), { width: 72, height: 103 })
  fixed.context.persistedState.window.viewMode = 'capsule'
  assert.deepEqual(resolveSize(fixed, 'capsule'), measured)
  fixed.context.currentSnapshot.authMode = 'chatgpt'
  assert.deepEqual(resolveSize(fixed, 'capsule'), { width: 160, height: 50 })
  assert.deepEqual(resolveSize(fixed, 'orb'), { width: 50, height: 96 })
  fixed.context.currentSnapshot.authMode = 'api'
}

async function verifySizeHandler(fixed, windowSpy) {
  const previousCount = windowSpy.calls.sizes.length
  await fixed.setSize({}, { width: 1, height: 500 })
  assert.deepEqual(windowSpy.calls.sizes.at(-1), { width: 40, height: 320 })
  assert.deepEqual(resolveSize(fixed, 'capsule'), { width: 40, height: 320 })
  const clampedSizeCount = windowSpy.calls.sizes.length
  await fixed.setSize({}, { width: Number.NaN, height: 50 })
  await fixed.setSize({}, null)
  fixed.context.mainWindow = null
  await fixed.setSize({}, { width: 90, height: 60 })
  assert.equal(windowSpy.calls.sizes.length, clampedSizeCount)
  assert.deepEqual(resolveSize(fixed, 'capsule'), { width: 40, height: 320 })
  assert.ok(clampedSizeCount > previousCount)
}

async function verifyCockpitAnimations() {
  await app.whenReady()
  app.on('window-all-closed', () => {})
  const window = new BrowserWindow({
    show: false,
    width: 160,
    height: 57,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false
  })
  const windowSpy = trackBrowserWindow(window)
  window.setBounds({ x: 200, y: 200, width: 160, height: 57 })
  try {
    await window.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(capsuleFixtureHtml(await readRendererStyles()))}`
    )
    await verifyAnimationNames(window)
    const measured = await measureApiCapsule(window)
    const fixed = createMainFixture(windowSpy.mainWindow, fixedMainFixture)
    await fixed.setSize({}, measured)
    const startBounds = window.getBounds()
    const progressRect = await getProgressRect(window)
    const legacyBounds = await verifyLegacyDrag(windowSpy, measured, startBounds)
    await verifyMeasuredDragAndSync(fixed, windowSpy, { measured, startBounds, progressRect })
    await verifyCachesAndOAuth(fixed, measured)
    verifyDockSizing(fixed, windowSpy, measured)
    await verifySizeHandler(fixed, windowSpy)
    console.log(
      `API CSS=${measured.width}x${measured.height}; old drag=${legacyBounds.width}x${legacyBounds.height}; fixed height=${startBounds.height}; progress=${progressRect.width}x${progressRect.height}`
    )
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
