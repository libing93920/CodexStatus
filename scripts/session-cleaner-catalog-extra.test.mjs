/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { scanAgyCatalog } from '../src/main/tools/session-cleaner/catalog-agy.ts'
import { scanGrokBuildCatalog } from '../src/main/tools/session-cleaner/catalog-grokbuild.ts'
import { scanHermesCatalog } from '../src/main/tools/session-cleaner/catalog-hermes.ts'
import { hermesWslTarget } from '../src/main/tools/session-cleaner/catalog-hermes-wsl.ts'
import { scanKimiCatalog } from '../src/main/tools/session-cleaner/catalog-kimi.ts'
import { scanMCodeCatalog } from '../src/main/tools/session-cleaner/catalog-mcode.ts'
import { scanOpenClawCatalog } from '../src/main/tools/session-cleaner/catalog-openclaw.ts'
import { scanExtraCatalog } from '../src/main/tools/session-cleaner/catalog-extra.ts'
import { scanSources } from '../src/main/tools/session-cleaner/scanner.ts'
import { DEFAULT_CLEANER_SETTINGS } from '../src/shared/session-cleaner.ts'

const STAMP = '2026-01-02T03:04:05Z'
const AGY_ID = 'agy-summary-001'
const AGY_TRANSCRIPT_ID = 'agy-transcript-002'

test('Antigravity 只有摘要库时仍列出会话；多个根目录重复ID保留首个', async (t) => {
  const root = await tempRoot(t, 'cleaner-agy-summary-only-')
  const sources = []
  let totalBytes = 0
  for (const name of ['first', 'second']) {
    const folder = path.join(root, name)
    await fs.mkdir(folder)
    const database = path.join(folder, 'conversation_summaries.db')
    createAgyDatabase(database, '[]')
    totalBytes += (await fs.stat(database)).size
    sources.push({ ...source('agy', path.join(folder, 'missing-brain')), id: name })
  }
  const result = await scanSources({
    sources,
    settings: DEFAULT_CLEANER_SETTINGS,
    protectedIds: []
  })
  const sessions = result.items.filter((item) => item.category === 'sessions')
  assert.equal(sessions.length, 2)
  assert.ok(sessions.every((item) => item.sourceId === 'first' && item.bytes === 0))
  assert.equal(
    result.items.reduce((sum, item) => sum + item.bytes, 0),
    totalBytes
  )
  assert.equal(result.issues.length, 0)
})

function source(kind, root) {
  return { kind, path: root }
}

async function tempRoot(t, prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(value))
}

async function writeJsonl(filePath, records) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
}

test('OpenClaw prefers sessions.json displayName and scans direct session JSONL files', async (t) => {
  const root = await tempRoot(t, 'cleaner-openclaw-')
  const sessions = path.join(root, 'agent-one', 'sessions')
  const sessionPath = path.join(sessions, 'openclaw-session.jsonl')
  await writeJson(path.join(sessions, 'sessions.json'), {
    active: { sessionId: 'openclaw-session', displayName: 'Visible conversation name' }
  })
  await writeJsonl(sessionPath, [
    { type: 'session', id: 'openclaw-session', cwd: 'C:\\work\\demo', timestamp: STAMP },
    {
      type: 'message',
      timestamp: STAMP,
      message: { role: 'user', content: 'synthetic user request' }
    },
    {
      type: 'message',
      timestamp: '2026-01-02T04:04:05Z',
      message: { role: 'assistant', content: 'synthetic reply' }
    }
  ])
  await writeJsonl(path.join(sessions, 'nested', 'ignored.jsonl'), [
    { type: 'session', id: 'nested-session', timestamp: STAMP }
  ])

  const result = await scanOpenClawCatalog(source('openclaw', root))
  assert.equal(result.issues.length, 0)
  assert.equal(result.sessions.length, 1)
  assert.equal(result.sessions[0].sessionId, 'openclaw-session')
  assert.equal(result.sessions[0].title, 'Visible conversation name')
  assert.equal(result.sessions[0].project, 'C:\\work\\demo')
  assert.equal(result.sessions[0].createdAt, Date.parse(STAMP))
  assert.equal(result.sessions[0].modifiedAt, Date.parse('2026-01-02T04:04:05Z'))
})

function createHermesDatabase(databasePath) {
  const database = new DatabaseSync(databasePath)
  database.exec(`
    CREATE TABLE sessions(id TEXT, title TEXT, started_at TEXT, last_activity_at TEXT, cwd TEXT);
    CREATE TABLE messages(id INTEGER, session_id TEXT, role TEXT, content TEXT, active INTEGER, compacted INTEGER);
  `)
  const insertSession = database.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)')
  for (let index = 0; index <= 500; index += 1) {
    const id = `hermes-${String(index).padStart(3, '0')}`
    insertSession.run(id, `database title ${index}`, STAMP, STAMP, '/fixture/project')
  }
  const insertMessage = database.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)')
  insertMessage.run(1, 'hermes-500', 'user', 'database first message', 1, 0)
  insertMessage.run(2, 'hermes-500', 'assistant', 'database last message', 1, 0)
  database.close()
}

test('Hermes merges SQLite and JSONL, prefers SQLite IDs, and caps database rows at 500', async (t) => {
  const root = await tempRoot(t, 'cleaner-hermes-')
  createHermesDatabase(path.join(root, 'state.db'))
  const sessions = path.join(root, 'sessions')
  await writeJsonl(path.join(sessions, 'duplicate.jsonl'), [
    { type: 'session', id: 'hermes-500', timestamp: STAMP, title: 'JSONL duplicate title' },
    { type: 'message', role: 'user', content: 'JSONL duplicate message', timestamp: STAMP }
  ])
  await writeJsonl(path.join(sessions, 'json-only.jsonl'), [
    { type: 'session', id: 'json-only', timestamp: STAMP, title: 'JSONL only title' },
    { type: 'message', role: 'user', content: 'JSONL only prompt', timestamp: STAMP }
  ])

  const result = await scanHermesCatalog(source('hermes', root))
  assert.equal(result.issues.length, 0)
  assert.equal(result.sessions.length, 501)
  assert.equal(
    result.sessions.some((session) => session.sessionId === 'hermes-000'),
    false
  )
  const databaseSession = result.sessions.find((session) => session.sessionId === 'hermes-500')
  assert.equal(databaseSession.title, 'database title 500')
  assert.equal(databaseSession.summary, 'database last message')
  assert.equal(databaseSession.path, path.join(root, 'state.db'))
  assert.equal(
    result.sessions.find((session) => session.sessionId === 'json-only').title,
    'JSONL only title'
  )
})

test('Hermes recognizes WSL UNC roots and rejects traversal components', () => {
  assert.deepEqual(
    hermesWslTarget(String.raw`\\wsl.localhost\Ubuntu\home\tester\.hermes\state.db`),
    {
      distro: 'Ubuntu',
      linuxPath: '/home/tester/.hermes/state.db'
    }
  )
  assert.deepEqual(hermesWslTarget(String.raw`\\wsl$\Ubuntu-22.04\home\tester\state.db`), {
    distro: 'Ubuntu-22.04',
    linuxPath: '/home/tester/state.db'
  })
  assert.equal(hermesWslTarget(String.raw`\\wsl.localhost\Ubuntu\home\..\state.db`), undefined)
})

test('GrokBuild reads generated title, summary, project, and activity time from summary.json', async (t) => {
  const root = await tempRoot(t, 'cleaner-grokbuild-')
  const summaryPath = path.join(root, 'session-a', 'summary.json')
  await writeJson(summaryPath, {
    info: { id: 'grok-session', cwd: '/fixture/workspace' },
    generated_title: 'Generated session title',
    session_summary: 'Synthetic session summary',
    created_at: STAMP,
    last_active_at: '2026-01-03T04:05:06Z'
  })

  const result = await scanGrokBuildCatalog(source('grokbuild', root))
  assert.equal(result.issues.length, 0)
  assert.equal(result.sessions.length, 1)
  assert.equal(result.sessions[0].sessionId, 'grok-session')
  assert.equal(result.sessions[0].title, 'Generated session title')
  assert.equal(result.sessions[0].summary, 'Synthetic session summary')
  assert.equal(result.sessions[0].project, '/fixture/workspace')
  assert.equal(result.sessions[0].path, summaryPath)
})

function createMCodeDatabase(databasePath) {
  const database = new DatabaseSync(databasePath)
  database.exec(`CREATE TABLE local_runtime_sessions(
    session_id TEXT, title TEXT, workspace_dir TEXT, created_at_ms INTEGER,
    updated_at_ms INTEGER, visibility TEXT, archived INTEGER,
    parent_session_id TEXT, session_kind TEXT
  )`)
  const insert = database.prepare('INSERT INTO local_runtime_sessions VALUES(?,?,?,?,?,?,?,?,?)')
  const rows = [
    ['visible', 'Visible session', '/fixture/project', 100, 200, 'visible', 0, null, 'main'],
    ['hidden', 'Hidden session', null, 100, 200, 'hidden', 0, null, 'main'],
    ['archived', 'Archived session', null, 100, 200, 'visible', 1, null, 'main'],
    ['child', 'Child session', null, 100, 200, 'visible', 0, 'visible', 'main'],
    ['peek', 'Peek session', null, 100, 200, 'visible', 0, null, 'peek']
  ]
  for (const row of rows) insert.run(...row)
  database.close()
}

test('MCode filters hidden, archived, child, and peek rows without changing millisecond values', async (t) => {
  const root = await tempRoot(t, 'cleaner-mcode-')
  const databasePath = path.join(root, 'v2', 'sqlite', 'runtime-state.sqlite')
  await fs.mkdir(path.dirname(databasePath), { recursive: true })
  createMCodeDatabase(databasePath)

  const result = await scanMCodeCatalog(source('mcode', root))
  assert.equal(result.issues.length, 0)
  assert.deepEqual(
    result.sessions.map((session) => session.sessionId),
    ['visible']
  )
  assert.equal(result.sessions[0].createdAt, 100)
  assert.equal(result.sessions[0].modifiedAt, 200)
  assert.equal(result.sessions[0].path, databasePath)
})

async function writeKimiSession(root, id, state, withWire = true) {
  const directory = path.join(root, 'workspace-one', id)
  await writeJson(path.join(directory, 'state.json'), state)
  if (withWire) await writeJsonl(path.join(directory, 'agents', 'main', 'wire.jsonl'), [])
}

test('Kimi keeps main sessions with wire files and filters archived, child, and missing-wire entries', async (t) => {
  const root = await tempRoot(t, 'cleaner-kimi-')
  await writeKimiSession(root, 'main-session', {
    title: 'Kimi title',
    lastPrompt: 'Synthetic prompt',
    cwd: '/fixture/project',
    createdAt: STAMP,
    updatedAt: '2026-01-03T04:05:06Z'
  })
  await writeKimiSession(root, 'archived-session', { archived: true })
  await writeKimiSession(root, 'child-session', { custom: { session_kind: 'child' } })
  await writeKimiSession(root, 'missing-wire-session', { title: 'No wire' }, false)

  const result = await scanKimiCatalog(source('kimi', root))
  assert.equal(result.issues.length, 0)
  assert.equal(result.sessions.length, 1)
  assert.equal(result.sessions[0].sessionId, 'main-session')
  assert.equal(result.sessions[0].title, 'Kimi title')
  assert.equal(result.sessions[0].summary, 'Synthetic prompt')
  assert.equal(result.sessions[0].project, '/fixture/project')
  assert.equal(
    result.sessions[0].path,
    path.join(root, 'workspace-one', 'main-session', 'agents', 'main', 'wire.jsonl')
  )
})

function createAgyDatabase(databasePath, workspaceUrl) {
  const database = new DatabaseSync(databasePath)
  database.exec(`CREATE TABLE conversation_summaries(
    conversation_id TEXT, title TEXT, workspace_uris TEXT, preview TEXT, last_modified_time TEXT
  )`)
  const insert = database.prepare('INSERT INTO conversation_summaries VALUES(?,?,?,?,?)')
  insert.run(
    AGY_ID,
    'Summary database title',
    JSON.stringify([workspaceUrl]),
    'Synthetic preview',
    '2026-01-03 04:05:06.123'
  )
  insert.run(
    'agy-binary-only-003',
    'Binary-only title',
    '[]',
    'Binary-only preview',
    '2026-01-03 04:05:06'
  )
  database.close()
}

test('Antigravity joins brain transcripts with summaries and retains summary-only entries', async (t) => {
  const root = await tempRoot(t, 'cleaner-agy-')
  const brain = path.join(root, 'brain')
  await fs.mkdir(brain, { recursive: true })
  const workspace = path.join(root, 'workspace')
  const databasePath = path.join(root, 'conversation_summaries.db')
  createAgyDatabase(databasePath, pathToFileURL(workspace).href)
  const transcriptPath = path.join(
    brain,
    AGY_ID,
    '.system_generated',
    'logs',
    'transcript_full.jsonl'
  )
  await writeJsonl(transcriptPath, [
    {
      step_index: 1,
      type: 'USER_INPUT',
      content: '<USER_REQUEST>synthetic prompt</USER_REQUEST>',
      created_at: STAMP
    }
  ])
  const transcriptOnlyPath = path.join(
    brain,
    AGY_TRANSCRIPT_ID,
    '.system_generated',
    'logs',
    'transcript_full.jsonl'
  )
  await writeJsonl(transcriptOnlyPath, [
    {
      step_index: 2,
      type: 'USER_INPUT',
      content: '<USER_REQUEST>transcript-derived title</USER_REQUEST>',
      created_at: STAMP
    }
  ])

  const result = await scanAgyCatalog(source('agy', brain))
  assert.equal(result.issues.length, 0)
  assert.equal(result.sessions.length, 3)
  const joined = result.sessions.find((session) => session.sessionId === AGY_ID)
  assert.equal(joined.title, 'Summary database title')
  assert.equal(joined.summary, 'Synthetic preview')
  assert.equal(joined.project, workspace)
  assert.equal(joined.path, transcriptPath)
  const transcriptOnly = result.sessions.find((session) => session.sessionId === AGY_TRANSCRIPT_ID)
  assert.equal(transcriptOnly.title, 'transcript-derived title')
  assert.equal(transcriptOnly.path, transcriptOnlyPath)
  const binaryOnly = result.sessions.find((session) => session.sessionId === 'agy-binary-only-003')
  assert.equal(binaryOnly.path, databasePath)
})
test('OMP dispatches to Pi tree reader with OMP title semantics', async (t) => {
  const root = await tempRoot(t, 'cleaner-omp-')
  const sessionPath = path.join(root, '2026-01', 'session.jsonl')
  await writeJsonl(sessionPath, [
    { type: 'title', title: 'OMP display title' },
    { type: 'session', id: 'omp-session', cwd: '/fixture/project', timestamp: STAMP },
    {
      type: 'message',
      message: { role: 'user', content: 'synthetic OMP request' },
      timestamp: STAMP
    }
  ])

  const result = await scanExtraCatalog(source('omp', root))
  assert.equal(result.issues.length, 0)
  assert.equal(result.sessions.length, 1)
  assert.equal(result.sessions[0].title, 'OMP display title')
  assert.equal(result.sessions[0].sessionId, 'omp-session')
})
