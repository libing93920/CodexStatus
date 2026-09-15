import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const electronExecutable = join(
  repositoryRoot,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron'
)
const testScript = join(repositoryRoot, 'scripts', 'capsule-minimal-window.test.mjs')

if (!existsSync(electronExecutable))
  throw new Error(`Electron executable not found: ${electronExecutable}`)

const child = spawn(electronExecutable, [testScript], {
  cwd: repositoryRoot,
  env: { ...process.env },
  stdio: 'inherit',
  windowsHide: true
})

child.once('error', (error) => {
  console.error(error)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  if (signal) {
    console.error(`Capsule minimal test terminated by ${signal}`)
    process.exitCode = 1
  } else {
    process.exitCode = code ?? 1
  }
})
