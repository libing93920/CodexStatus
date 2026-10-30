/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_CLEANER_SETTINGS } from '../src/shared/session-cleaner.ts'
import { discoverSources, identifySource } from '../src/main/tools/session-cleaner/sources.ts'
import { fingerprintFile, scanSources } from '../src/main/tools/session-cleaner/scanner.ts'
import { MAX_SCAN_FILE_BYTES } from '../src/main/tools/session-cleaner/scan-files.ts'

const DAY_MS = 86_400_000
const temporaryRoots = []

after(async () => {
  await Promise.all(temporaryRoots.map((root) => fs.rm(root, { recursive: true, force: true })))
})

test('discovers default roots for all seven supported tools', async () => {
  const home = await tempDirectory('defaults')
  const directories = [
    '.codex/sessions',
    '.codex/archived_sessions',
    '.claude/projects',
    '.pi/agent/sessions',
    '.gemini/tmp',
    '.cline/data',
    '.local/share/opencode'
  ]
  for (const directory of directories)
    await fs.mkdir(path.join(home, directory), { recursive: true })
  await fs.writeFile(path.join(home, '.local/share/opencode/opencode.db'), '')
  await fs.writeFile(path.join(home, '.aider.chat.history.md'), 'fixture')

  const sources = await discoverSources({ home, env: {}, registered: [] })
  const paths = new Set(sources.map((source) => source.path))
  const kinds = new Set(sources.map((source) => source.kind))

  assert.deepEqual(
    kinds,
    new Set(['codex', 'claude', 'opencode', 'pi', 'gemini', 'cline', 'aider'])
  )
  assert.ok(
    paths.has(path.join(home, '.claude', 'projects')),
    'Claude defaults to ~/.claude/projects'
  )
  assert.ok(
    paths.has(path.join(home, '.pi', 'agent', 'sessions')),
    'Pi defaults to ~/.pi/agent/sessions'
  )
  assert.ok(paths.has(path.join(home, '.gemini', 'tmp')), 'Gemini defaults to ~/.gemini/tmp')
  assert.ok(paths.has(path.join(home, '.codex', 'sessions')))
  assert.ok(paths.has(path.join(home, '.codex', 'archived_sessions')))
})

test('unknown manual directories are inventory-only and credential files are excluded', async () => {
  const root = await tempDirectory('unknown')
  const sessionPath = path.join(root, 'sample.jsonl')
  const imagePath = path.join(root, 'preview.png')
  const binaryPath = path.join(root, 'archive.bin')
  const configPath = path.join(root, '.config', 'app-state.bin')
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])
  const privateBytes = Buffer.from('fixture-private-content')
  await fs.writeFile(sessionPath, '{"type":"unknown-session"}\n')
  await fs.writeFile(imagePath, imageBytes)
  await fs.writeFile(binaryPath, privateBytes)
  await fs.mkdir(path.dirname(configPath))
  await fs.writeFile(configPath, privateBytes)
  await fs.writeFile(path.join(root, 'auth.json'), '{"api_key":"fixture-secret"}')
  const source = await identifySource(root)

  assert.equal(source.kind, 'unknown')
  assert.equal(source.capability, 'files')
  const result = await scanSources({
    sources: [source],
    settings: settings(),
    protectedIds: []
  })

  const items = new Map(result.items.map((item) => [item.path, item]))
  assert.deepEqual(new Set(items.keys()), new Set([sessionPath, imagePath, binaryPath, configPath]))
  assert.equal(items.get(sessionPath).status, 'read-only')
  assert.equal(items.get(imagePath).bytes, imageBytes.length)
  assert.equal(items.get(binaryPath).bytes, privateBytes.length)
  assert.equal(items.get(configPath).bytes, privateBytes.length)
  for (const item of items.values()) assert.match(item.fingerprint, /^readonly-stat:/)
  assert.ok(!JSON.stringify(result).includes('fixture-secret'))
  assert.ok(!JSON.stringify(result).includes('fixture-private-content'))
})

test('does not follow directory symlinks or junctions', async (context) => {
  const root = await tempDirectory('links')
  const outside = path.join(root, 'outside')
  const sourceRoot = path.join(root, 'manual')
  await fs.mkdir(outside)
  await fs.mkdir(sourceRoot)
  await fs.writeFile(path.join(outside, 'escaped.jsonl'), '{"type":"fixture"}\n')
  const link = path.join(sourceRoot, 'escape')
  try {
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : undefined
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
      context.skip(`directory links unavailable: ${code}`)
      return
    }
    throw error
  }

  const result = await scanSources({
    sources: [await identifySource(sourceRoot)],
    settings: settings(),
    protectedIds: []
  })
  assert.equal(result.items.length, 0)
  assert.ok(result.issues.some((issue) => issue.path === link))
})

test('Claude and Pi candidates require complete standalone old files; Codex stays read-only', async () => {
  const home = await tempDirectory('sessions')
  const claudeRoot = path.join(home, '.claude', 'projects')
  const piRoot = path.join(home, '.pi', 'agent', 'sessions')
  const codexRoot = path.join(home, '.codex', 'sessions')
  await Promise.all(
    [claudeRoot, piRoot, codexRoot].map((directory) => fs.mkdir(directory, { recursive: true }))
  )

  const claudePath = path.join(claudeRoot, 'claude-older.jsonl')
  const piProject = path.join(piRoot, 'fixture-project')
  await fs.mkdir(piProject)
  const piPath = path.join(piProject, 'pi-older.jsonl')
  const codexPath = path.join(
    codexRoot,
    'rollout-2026-01-01T00-00-00-000Z-12345678-1234-4234-8234-123456789abc.jsonl'
  )
  const resourcePath = path.join(piProject, 'pi-with-resources.jsonl')
  const recentPath = path.join(claudeRoot, 'claude-recent.jsonl')
  await writeJsonl(
    claudePath,
    [
      { type: 'user', sessionId: 'claude-session', cwd: '/work/claude' },
      { type: 'custom-title', sessionId: 'claude-session', customTitle: 'Claude title' }
    ],
    100
  )
  await writeJsonl(
    piPath,
    [
      { type: 'session', version: 3, id: 'pi-session', cwd: '/work/pi' },
      { type: 'message', id: 'message-1' },
      { type: 'session_info', name: 'Pi title' }
    ],
    100
  )
  await writeJsonl(
    codexPath,
    [
      {
        type: 'session_meta',
        payload: { id: '12345678-1234-4234-8234-123456789abc', cwd: '/work/codex' }
      },
      { type: 'event_msg', payload: { type: 'task_started' } }
    ],
    100
  )
  await writeJsonl(
    resourcePath,
    [{ type: 'session', id: 'pi-resource-session', cwd: '/work/pi' }, { type: 'message' }],
    100
  )
  const resourceDirectory = resourcePath.replace(/\.jsonl$/, '')
  const resourceImagePath = path.join(resourceDirectory, 'screenshot.png')
  const resourceImageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x11, 0x22])
  await fs.mkdir(resourceDirectory)
  await fs.writeFile(resourceImagePath, resourceImageBytes)
  await writeJsonl(
    recentPath,
    [{ type: 'assistant', sessionId: 'claude-recent', cwd: '/work/claude' }],
    2
  )

  const sources = await Promise.all([claudeRoot, piRoot, codexRoot].map(identifySource))
  const result = await scanSources({ sources, settings: settings(), protectedIds: [] })
  const item = (filePath) => result.items.find((entry) => entry.path === filePath)
  const claude = item(claudePath)
  const pi = item(piPath)
  assert.ok(claude)
  assert.ok(pi)

  assert.equal(claude.status, 'candidate')
  assert.equal(claude.sessionId, 'claude-session')
  assert.equal(claude.title, 'Claude title')
  assert.equal(claude.project, '/work/claude')
  assert.equal(pi.status, 'candidate')
  assert.equal(pi.sessionId, 'pi-session')
  assert.equal(pi.title, 'Pi title')
  assert.equal(pi.project, '/work/pi')
  assert.equal(item(codexPath)?.status, 'read-only')
  assert.equal(item(resourcePath)?.status, 'read-only')
  assert.equal(item(resourceImagePath)?.status, 'read-only')
  assert.equal(item(resourceImagePath)?.category, 'resources')
  assert.equal(item(resourceImagePath)?.bytes, resourceImageBytes.length)
  assert.match(item(resourceImagePath)?.fingerprint, /^readonly-stat:/)
  assert.equal(item(recentPath)?.status, 'recent')
  assert.equal(await fingerprintFile(piPath), pi.fingerprint)

  const protectedScan = await scanSources({
    sources,
    settings: settings(),
    protectedIds: [pi.id]
  })
  assert.equal(protectedScan.items.find((entry) => entry.path === piPath)?.status, 'protected')
})

test('OpenCode counts database bytes once and keeps session metadata rows at zero', async () => {
  const root = await tempDirectory('opencode')
  const databasePath = path.join(root, 'opencode.db')
  const { DatabaseSync } = await import('node:sqlite')
  const database = new DatabaseSync(databasePath)
  database.exec(
    'CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER DEFAULT 0, time_updated INTEGER)'
  )
  const insert = database.prepare(
    'INSERT INTO session (id, title, directory, time_updated) VALUES (?, ?, ?, ?)'
  )
  insert.run('session-one', 'OpenCode title one', '/work/one', Date.now() - 2 * DAY_MS)
  insert.run('session-two', 'OpenCode title two', '/work/two', Date.now() - 3 * DAY_MS)
  database.close()

  const result = await scanSources({
    sources: [await identifySource(databasePath)],
    settings: settings(),
    protectedIds: []
  })
  const databaseItems = result.items.filter((item) => item.path === databasePath && item.bytes > 0)
  const sessionItems = result.items.filter((item) => item.sessionId)
  assert.equal(databaseItems.length, 1)
  assert.equal(databaseItems[0].bytes, (await fs.stat(databasePath)).size)
  assert.deepEqual(
    sessionItems.map((item) => item.bytes),
    [0, 0]
  )
  assert.deepEqual(
    sessionItems.map((item) => item.sessionId),
    ['session-one', 'session-two']
  )
  assert.deepEqual(
    sessionItems.map((item) => item.project),
    ['/work/one', '/work/two']
  )
})

test('大于旧扫描限制的有效会话仍读取目录元数据，独立资源占用不丢失', async () => {
  const root = await tempDirectory('scan-limit')
  const sessions = path.join(root, '.codex', 'sessions')
  const filePath = path.join(sessions, 'rollout-large.jsonl')
  await fs.mkdir(sessions, { recursive: true })
  const head = [
    { type: 'session_meta', payload: { id: 'large-session', cwd: '/large/project' } },
    ...Array.from({ length: 9 }, () => ({ type: 'event_msg', payload: { type: 'empty' } }))
  ]
  await fs.writeFile(filePath, head.map((record) => JSON.stringify(record)).join('\n') + '\n')
  await fs.truncate(filePath, MAX_SCAN_FILE_BYTES + 1)

  const result = await scanSources({
    sources: [await identifySource(sessions)],
    settings: settings(),
    protectedIds: []
  })
  const item = result.items.find((entry) => entry.path === filePath)
  assert.equal(item?.bytes, MAX_SCAN_FILE_BYTES + 1)
  assert.equal(item?.status, 'read-only')
  assert.match(item?.fingerprint, /^readonly-stat:/)
  assert.equal(item?.sessionId, 'large-session')
  assert.equal(item?.category, 'sessions')
  assert.equal(result.issues.length, 0)
})

test('partial failures stay visible and cancellation returns completed items', async () => {
  const root = await tempDirectory('partial')
  await fs.writeFile(path.join(root, 'a.jsonl'), '{"type":"a"}\n')
  await fs.writeFile(path.join(root, 'b.jsonl'), '{"type":"b"}\n')
  const source = await identifySource(root)
  const missing = await identifySource(path.join(root, 'missing'))
  const partial = await scanSources({
    sources: [source, missing],
    settings: settings(),
    protectedIds: []
  })
  assert.equal(partial.items.length, 2)
  assert.ok(partial.issues.some((issue) => issue.path === missing.path))

  const controller = new AbortController()
  const cancelled = await scanSources({
    sources: [source],
    settings: settings(),
    protectedIds: [],
    signal: controller.signal,
    onProgress: (progress) => {
      if (progress.bytes > 0 && progress.visited > 0) controller.abort()
    }
  })
  assert.equal(cancelled.cancelled, true)
  assert.equal(cancelled.items.length, 1)
})

test('fingerprint changes when file contents change and malformed sessions are reported read-only', async () => {
  const home = await tempDirectory('fingerprint')
  const root = path.join(home, '.pi', 'agent', 'sessions')
  await fs.mkdir(root, { recursive: true })
  const project = path.join(root, 'fixture-project')
  await fs.mkdir(project)
  const filePath = path.join(project, 'truncated.jsonl')
  await fs.writeFile(filePath, '{"type":"session","version":3,"id":"broken"}\n{"type":"message"')
  await setAge(filePath, 100)
  const before = await fingerprintFile(filePath)
  await fs.appendFile(filePath, '}')
  await setAge(filePath, 100)
  const after = await fingerprintFile(filePath)
  assert.notEqual(after, before)

  const result = await scanSources({
    sources: [await identifySource(root)],
    settings: settings(),
    protectedIds: []
  })
  assert.equal(result.items[0].status, 'candidate')
  // A valid final JSON object has no required trailing newline; malformed variants are covered by the next fixture.
  await fs.writeFile(filePath, '{"type":"session","version":3,"id":"broken"}\n{"type":"message"')
  await setAge(filePath, 100)
  const malformed = await scanSources({
    sources: [await identifySource(root)],
    settings: settings(),
    protectedIds: []
  })
  assert.equal(malformed.items[0].status, 'read-only')
  assert.ok(malformed.issues.some((issue) => issue.path === filePath))
})

function settings() {
  return { ...DEFAULT_CLEANER_SETTINGS, keepRecentDays: 14, olderSessionDays: 90, logAgeDays: 30 }
}

async function tempDirectory(label) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `session-cleaner-${label}-`))
  temporaryRoots.push(root)
  return root
}

async function writeJsonl(filePath, records, ageDays) {
  await fs.writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
  await setAge(filePath, ageDays)
}

async function setAge(filePath, ageDays) {
  const date = new Date(Date.now() - ageDays * DAY_MS)
  await fs.utimes(filePath, date, date)
}
