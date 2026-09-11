/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const electronExecutable = resolveElectronExecutable()
const testScript = join(repositoryRoot, 'scripts', 'island-window.test.mjs')

await runIslandWindowTest()
await runIslandWindowTest({ ISLAND_TEST_REDUCED_MOTION: '1' })

function resolveElectronExecutable() {
  const executable = join(
    repositoryRoot,
    'node_modules',
    'electron',
    'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron'
  )
  if (!existsSync(executable)) throw new Error(`Electron executable not found: ${executable}`)
  return executable
}

function runIslandWindowTest(extraEnv = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(electronExecutable, [testScript], {
      cwd: repositoryRoot,
      env: { ...process.env, ...extraEnv },
      stdio: 'inherit',
      windowsHide: true
    })
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      if (signal) rejectRun(new Error(`Island window test terminated by ${signal}`))
      else if (code !== 0) rejectRun(new Error(`Island window test exited with code ${code}`))
      else resolveRun()
    })
  })
}
