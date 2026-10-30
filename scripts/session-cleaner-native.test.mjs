/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises'
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { app, shell } from 'electron'
import { buildSync } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
assert.ok(process.env.PI_SCRATCH_DIR, '请通过 run-with-test-scratch.mjs 执行')
const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR, 'cleaner-native-'))
app.setPath('userData', join(directory, 'app-data'))
const fixture = join(directory, `cleaner-native-${Date.now()}.jsonl`)
const require = createRequire(import.meta.url)
const execute = promisify(execFile)
const timeout = setTimeout(() => app.exit(1), 45_000)
app.on('window-all-closed', () => {})
const tracePath = join(directory, 'trace.log')
const trace = async (message) => {
  console.log(message)
  await writeFile(tracePath, `${message}\n`, { flag: 'a' })
}

async function run() {
  try {
    await trace('native:start')
    buildSync({
      entryPoints: [join(root, 'src/main/tools/session-cleaner/file-lease.ts')],
      outfile: join(directory, 'lease.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs'
    })
    await trace('native:bundled')
    const { acquireRecycleLease } = require(join(directory, 'lease.cjs'))
    await writeFile(fixture, '仅供回收与还原验收的临时样本\n')
    await app.whenReady()
    await trace('native:ready')
    const lease = await acquireRecycleLease(fixture)
    await trace('native:locked')
    try {
      lease.assertHeld()
      await shell.trashItem(fixture)
    } finally {
      lease.release()
    }
    await assert.rejects(access(fixture))
    await trace('native:recycled')
    const restoreScript = `
$ErrorActionPreference = 'Stop'
$Directory = $env:CLEANER_TEST_DIRECTORY
$FileName = $env:CLEANER_TEST_FILE
$recycle = (New-Object -ComObject Shell.Application).NameSpace(10)
$matches = @($recycle.Items() | Where-Object {
  $_.ExtendedProperty('System.Recycle.DeletedFrom') -eq $Directory -and
  ($_.Name -eq $FileName -or $_.Name -eq [IO.Path]::GetFileNameWithoutExtension($FileName))
})
if ($matches.Count -ne 1) { throw 'Owned fixture not found uniquely in recycle bin' }
$matches[0].InvokeVerb('undelete')
`
    await execute(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(restoreScript, 'utf16le').toString('base64')
      ],
      {
        windowsHide: true,
        timeout: 15_000,
        env: {
          ...process.env,
          CLEANER_TEST_DIRECTORY: directory,
          CLEANER_TEST_FILE: basename(fixture)
        }
      }
    )
    let restored = false
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        restored = (await readFile(fixture, 'utf8')) === '仅供回收与还原验收的临时样本\n'
      } catch {
        /* 等待原生 Shell 完成还原。 */
      }
      if (restored) break
      await delay(100)
    }
    assert.equal(restored, true, '系统原生还原未完成')
    console.log('PASS: Windows 写保护下真实移入系统回收站，并经系统原生还原且内容一致')
    clearTimeout(timeout)
    app.exit(0)
  } catch (error) {
    console.error(error)
    clearTimeout(timeout)
    app.exit(1)
  }
}
void run()
