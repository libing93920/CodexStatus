/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'
import { build } from 'esbuild'
import ts from 'typescript'

const FIXTURE_BOUNDS = { x: -20000, y: -20000, width: 80, height: 80 }
const TEST_TIMEOUT_MS = 30_000
assert.ok(process.env.PI_SCRATCH_DIR, 'Run through run-with-test-scratch.mjs')
app.setPath('userData', join(process.env.PI_SCRATCH_DIR, 'island-zorder'))
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('no-sandbox')
app.on('window-all-closed', () => {})

async function loadSource(relativePath, functionName) {
  if (!functionName) {
    const result = await build({
      entryPoints: [fileURLToPath(new URL(relativePath, import.meta.url))],
      bundle: true,
      platform: 'node',
      format: 'esm',
      write: false
    })
    return import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
    )
  }
  const source = await readFile(new URL(relativePath, import.meta.url), 'utf8')
  const file = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true)
  const declaration = functionName
    ? file.statements.find(
        (node) => ts.isFunctionDeclaration(node) && node.name?.text === functionName
      )
    : undefined
  if (functionName) assert.ok(declaration, `Missing production function ${functionName}`)
  const selectedSource = declaration
    ? [
        ...file.statements.filter(ts.isVariableStatement),
        ...file.statements.filter(
          (node) =>
            ts.isFunctionDeclaration(node) && node.name?.text === 'stopIslandPointerTracking'
        ),
        declaration
      ]
        .map((node) => node.getText(file))
        .join('\n')
    : source
  const code = ts.transpileModule(selectedSource, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
  }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
}

async function startProbe() {
  const { CAPSULE_NATIVE_PROBE, encodeNativeProbe } = await loadSource(
    '../src/main/services/capsule-native-probe.ts'
  )
  const native = CAPSULE_NATIVE_PROBE.match(/Add-Type @'\r?\n([\s\S]*?)\r?\n'@/)?.[1]
  assert.ok(native)
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type @'",
    native,
    "'@",
    '[CapsuleWindowProbe]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null',
    "[Console]::WriteLine('ready')",
    'while ($null -ne ($line = [Console]::ReadLine())) {',
    '  $command = ConvertFrom-Json $line',
    "  if ($command.action -eq 'owner') {",
    '    $binding = [IslandTaskbarOwner]::Apply([long]$command.hwnd, [uint32]$command.pid, [long]$command.owner)',
    '    $result = @{ binding = $binding; snapshot = [CapsuleWindowProbe]::Sample([long]$command.hwnd) }',
    '  } else { $result = [CapsuleWindowProbe]::Sample([long]$command.hwnd) }',
    '  [Console]::WriteLine((ConvertTo-Json -InputObject $result -Depth 8 -Compress))',
    '}'
  ].join('\n')
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeNativeProbe(script)],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
  )
  let error = ''
  child.stderr.on('data', (chunk) => (error += chunk))
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  const ready = await lines.next()
  assert.equal(ready.value, 'ready', error)
  async function request(window, action, owner = '0') {
    const hwnd = window.getNativeWindowHandle().readBigUInt64LE().toString()
    child.stdin.write(`${JSON.stringify({ action, hwnd, pid: process.pid, owner })}\n`)
    const line = await lines.next()
    assert.equal(line.done, false, error)
    return JSON.parse(line.value)
  }
  return {
    sample: (window) => request(window, 'sample'),
    setOwner: (window, owner) => request(window, 'owner', owner),
    async close() {
      child.stdin.end()
      if (child.exitCode === null) await once(child, 'exit')
    }
  }
}

function createFixture() {
  return new BrowserWindow({
    ...FIXTURE_BOUNDS,
    show: false,
    frame: false,
    thickFrame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true
  })
}

function assertRestored(snapshot, before) {
  assert.equal(snapshot.capsule.visible, true)
  assert.equal(snapshot.capsule.topmost, true)
  assert.equal(snapshot.topmostOccluder, null)
  assert.equal(snapshot.reachedCapsule, true)
  assert.equal(snapshot.foreground?.hwnd, before.foreground?.hwnd)
  assert.deepEqual(snapshot.capsule.boundsPx, before.capsule.boundsPx)
}

async function verifyZOrder() {
  const { showIslandWindow } = await loadSource(
    '../src/main/windows/island-window.ts',
    'showIslandWindow'
  )
  await app.whenReady()
  const probe = await startProbe()
  const target = createFixture()
  const blocker = createFixture()
  try {
    target.showInactive()
    blocker.showInactive()
    target.setBounds(FIXTURE_BOUNDS)
    blocker.setBounds(FIXTURE_BOUNDS)
    blocker.moveTop()
    const covered = await probe.sample(target)
    const blockerHandle = blocker.getNativeWindowHandle().readBigUInt64LE().toString()
    assert.equal(covered.capsule.topmost, true)
    assert.equal(covered.topmostOccluder?.hwnd, blockerHandle)
    assert.ok(covered.capsule.boundsPx[0] < 0 && covered.capsule.boundsPx[1] < 0)
    const bounds = target.getBounds()

    // 模拟隐藏动画尚未结束即恢复，此时原生窗口仍可见，置顶标志也仍为 true。
    showIslandWindow(target)
    const visibleRestored = await probe.sample(target)
    assertRestored(visibleRestored, covered)
    assert.deepEqual(target.getBounds(), bounds)

    target.hide()
    blocker.moveTop()
    const hidden = await probe.sample(target)
    assert.equal(hidden.capsule.visible, false)
    showIslandWindow(target)
    const hiddenRestored = await probe.sample(target)
    assertRestored(hiddenRestored, hidden)
    assert.deepEqual(target.getBounds(), bounds)
    await verifyOwnerInvariant({ probe, target, blocker, bounds })
    console.log('Island native Z-order passed: visible/hidden restore, bounds and focus unchanged')
  } finally {
    target.destroy()
    blocker.destroy()
    await probe.close()
  }
}

async function verifyOwnerInvariant({ probe, target, blocker, bounds }) {
  const blockerHandle = blocker.getNativeWindowHandle().readBigUInt64LE().toString()
  blocker.moveTop()
  const covered = await probe.sample(target)
  assert.equal(covered.topmostOccluder?.hwnd, blockerHandle)
  const attached = await probe.setOwner(target, blockerHandle)
  assertRestored(attached.snapshot, covered)
  assert.equal(attached.binding.status, 'bound', JSON.stringify(attached.binding))
  assert.equal(attached.snapshot.capsule.ownerHwnd, blockerHandle)
  for (let raised = 0; raised < 3; raised++) {
    blocker.moveTop()
    const snapshot = await probe.sample(target)
    assertRestored(snapshot, attached.snapshot)
    assert.deepEqual(target.getBounds(), bounds)
  }
  target.hide()
  blocker.moveTop()
  assert.equal((await probe.sample(target)).capsule.visible, false)
  const detached = await probe.setOwner(target, '0')
  assert.equal(detached.binding.status, 'detached')
  assert.equal(detached.snapshot.capsule.visible, false)
  assert.equal(detached.snapshot.capsule.ownerHwnd, '0')
  console.log('Island owner invariant passed: repeated owner raise stays below the Electron window')
}

const timeout = setTimeout(() => {
  console.error('Island native Z-order test timed out')
  app.exit(1)
}, TEST_TIMEOUT_MS)
void verifyZOrder().then(
  () => {
    clearTimeout(timeout)
    app.exit(0)
  },
  (error) => {
    console.error(error)
    clearTimeout(timeout)
    app.exit(1)
  }
)
