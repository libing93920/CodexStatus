/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire, Module } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildSync } from 'esbuild'
import { measureManagedSpace } from '../src/main/tools/session-cleaner/managed-space.ts'
import { fileIdentity } from '../src/main/tools/session-cleaner/managed-space-files.ts'
import { scanSources } from '../src/main/tools/session-cleaner/scanner.ts'
import { DEFAULT_CLEANER_SETTINGS } from '../src/shared/session-cleaner.ts'

const require = createRequire(import.meta.url)
const SCRATCH_PREFIX = 'session-manager-performance-'
const SESSION_COUNT = 300

async function scratch(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), SCRATCH_PREFIX))
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()))
    assert.ok(path.basename(directory).startsWith(SCRATCH_PREFIX))
    await rm(directory, { recursive: true, force: true })
  })
  return directory
}

test('64-bit file identities stay distinct even when Number rounds them to the same inode', () => {
  const left = { dev: 1n, ino: 37999121857198405n }
  const right = { dev: 1n, ino: 37999121857198411n }
  assert.equal(Number(left.ino), Number(right.ino))
  assert.notEqual(fileIdentity(left, 'same-path'), fileIdentity(right, 'same-path'))
  assert.equal(fileIdentity(left, 'alias-path'), fileIdentity(left, 'original-path'))
})

test('many file sessions keep exact resource counts, bytes and ownership', async (t) => {
  const directory = await scratch(t)
  const source = { id: 'fixture-pi', kind: 'pi', path: directory, layout: 'flat' }
  const sessions = []
  let expectedBytes = 0
  for (let index = 0; index < SESSION_COUNT; index++) {
    const sourcePath = path.join(directory, `session-${index}.jsonl`)
    const content = `${JSON.stringify({ type: 'session', id: String(index), version: 3 })}\n`
    expectedBytes += Buffer.byteLength(content)
    await writeFile(sourcePath, content)
    sessions.push({
      providerId: 'pi',
      sourceId: source.id,
      sessionId: String(index),
      sourcePath,
      capabilities: { read: true, delete: true, export: true, resume: false },
      storage: { kind: 'file', fileBytes: 0, sharedBytes: 0, complete: true },
      resourceIds: [],
      modelIds: [],
      revision: 'fixture'
    })
  }
  const result = await measureManagedSpace({ sources: [source], sessions })
  assert.equal(result.resources.length, SESSION_COUNT)
  assert.equal(result.storage[0].fileBytes, expectedBytes)
  assert.equal(result.issues.length, 0)
  assert.ok(
    result.resources.every((resource) => !resource.shared && resource.sessionIds.length === 1)
  )
  assert.ok(
    result.sessions.every((session) => session.resourceIds.length === 1 && session.storage.complete)
  )
  const legacy = await scanSources({
    sources: [{ ...source, kind: 'unknown' }],
    settings: DEFAULT_CLEANER_SETTINGS,
    protectedIds: []
  })
  assert.equal(legacy.items.length, SESSION_COUNT)
  assert.equal(
    legacy.items.reduce((total, item) => total + item.bytes, 0),
    expectedBytes
  )
})

function controllerClass() {
  const result = buildSync({
    entryPoints: ['src/main/tools/session-cleaner/controller.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    write: false
  })
  const compiled = new Module('session-cleaner-controller-test')
  compiled.paths = [path.dirname(require.resolve('electron/package.json')) + '/..']
  compiled._compile(result.outputFiles[0].text, 'session-cleaner-controller-test.cjs')
  return compiled.exports.CleanerController
}

test('bulk protection preserves alias protection and immediately observes live active IDs', async (t) => {
  const directory = await scratch(t)
  await mkdir(path.join(directory, 'sessions'))
  let active = []
  const Controller = controllerClass()
  const controller = new Controller({
    directory,
    retentionDirectory: directory,
    coreExecutable: '',
    activeThreadIds: () => active,
    onProgress: () => undefined
  })
  const items = Array.from({ length: SESSION_COUNT }, (_, index) => ({
    id: `session-${index}`,
    sourceId: 'source',
    sessionId: `thread-${index}`,
    path: path.join(directory, 'sessions', `${index}.jsonl`),
    status: 'candidate'
  }))
  items.push({ ...items[0], id: 'shared-alias', sourceId: 'alias-source' })
  controller.config = {
    sources: [],
    protectedIds: items.slice(0, SESSION_COUNT / 2).map((item) => item.id),
    settings: {}
  }
  controller.items = items
  assert.equal(controller.selectedItems(['shared-alias'])[0].status, 'protected')
  assert.equal(controller.selectedItems(['session-299'])[0].status, 'candidate')
  active = ['thread-299']
  assert.equal(controller.selectedItems(['session-299'])[0].status, 'active')
  controller.config.protectedIds = []
  assert.equal(controller.selectedItems(['shared-alias'])[0].status, 'candidate')
})
