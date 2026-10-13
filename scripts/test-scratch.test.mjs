/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const runner = join(scriptDirectory, 'run-with-test-scratch.mjs')
const repositoryRoot = resolve(scriptDirectory, '..')

test('未设置PI_SCRATCH_DIR时自动创建隔离目录并清理', () => {
  const result = runRunner(
    [
      '-e',
      'const fs = require("node:fs"); fs.statSync(process.env.PI_SCRATCH_DIR); console.log(process.env.PI_SCRATCH_DIR)'
    ],
    environmentWithoutScratch()
  )
  assert.equal(result.status, 0, result.stderr)
  const scratchDirectory = result.stdout.trim()
  assert.ok(scratchDirectory)
  assert.equal(existsSync(scratchDirectory), false)
})

test('透传子进程失败码并清理隔离目录', () => {
  const result = runRunner(
    ['-e', 'console.log(process.env.PI_SCRATCH_DIR); process.exitCode = 23'],
    environmentWithoutScratch()
  )
  assert.equal(result.status, 23)
  const scratchDirectory = result.stdout.trim()
  assert.ok(scratchDirectory)
  assert.equal(existsSync(scratchDirectory), false)
})

test('显式指定的调用者目录保留且不误删', async () => {
  const scratchDirectory = await mkdtemp(join(tmpdir(), 'codex-status-caller-scratch-'))
  const markerPath = join(scratchDirectory, 'keep.txt')
  await writeFile(markerPath, 'caller-owned')
  try {
    const result = runRunner(['-e', 'console.log(process.env.PI_SCRATCH_DIR)'], {
      ...process.env,
      PI_SCRATCH_DIR: scratchDirectory
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), scratchDirectory)
    assert.equal(await readFile(markerPath, 'utf8'), 'caller-owned')
  } finally {
    await rm(scratchDirectory, { recursive: true, force: true })
  }
})

function runRunner(args, env) {
  return spawnSync(process.execPath, [runner, ...args], {
    cwd: repositoryRoot,
    env,
    encoding: 'utf8',
    windowsHide: true
  })
}

function environmentWithoutScratch() {
  const env = { ...process.env }
  delete env.PI_SCRATCH_DIR
  return env
}
