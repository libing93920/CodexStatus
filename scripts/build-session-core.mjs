import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeSessionCoreLicenses } from './session-core-licenses.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const targetDirectory = path.join(root, 'native', 'target')
const manifest = path.join(root, 'native', 'session-core', 'Cargo.toml')
const executable = process.platform === 'win32' ? 'session-core.exe' : 'session-core'
const result = spawnSync('cargo', ['build', '--release', '--locked', '--manifest-path', manifest], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
  env: { ...process.env, CARGO_TARGET_DIR: targetDirectory }
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
const resources = path.join(root, 'resources', 'session-core')
mkdirSync(resources, { recursive: true })
copyFileSync(path.join(targetDirectory, 'release', executable), path.join(resources, executable))
writeSessionCoreLicenses({ root, manifest })
