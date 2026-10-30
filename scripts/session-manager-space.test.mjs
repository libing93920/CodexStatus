/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { link, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { zstdCompressSync } from 'node:zlib'

import { measureManagedSpace } from '../src/main/tools/session-cleaner/managed-space.ts'
import { normalizeManagedPath } from '../src/main/tools/session-cleaner/managed-space-files.ts'

const SCRATCH_PREFIX = 'session-manager-space-'
const V1_SESSION_ID = 'ses_space_v1'
const V2_SESSION_ID = 'ses_space_v2'

async function createScratch(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), SCRATCH_PREFIX))
  t.after(async () => {
    assert.ok(path.basename(path.resolve(directory)).startsWith(SCRATCH_PREFIX))
    await rm(path.resolve(directory), { recursive: true, force: true })
  })
  return directory
}

function source(id, kind, root, databasePath) {
  return {
    id,
    kind,
    name: id,
    path: root,
    origin: 'discovered',
    capability: 'sessions',
    note: '',
    ...(databasePath ? { databasePath } : {})
  }
}

function managedSession(sourceId, providerId, sessionId, sourcePath, kind = 'file', storagePath) {
  return {
    providerId,
    sourceId,
    sessionId,
    sourcePath,
    ...(storagePath ? { storagePath } : {}),
    modelIds: [],
    capabilities: { read: true, delete: true, export: true, resume: false },
    storage: { kind, fileBytes: 0, sharedBytes: 0, complete: true },
    resourceIds: [],
    revision: `revision-${sessionId}`
  }
}

function createOpenCodeSchema(database, withBlobTables = false) {
  database.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, data TEXT, parent_id TEXT);
    CREATE TABLE message (id TEXT, session_id TEXT, data);
    CREATE TABLE part (id TEXT, session_id TEXT, data);
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, data TEXT, parent_id TEXT);
    CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, data);
    ${
      withBlobTables
        ? `
      CREATE TABLE blob (
        hash TEXT PRIMARY KEY, mime TEXT, bytes INTEGER, width INTEGER, height INTEGER,
        data BLOB, time_created INTEGER
      );
      CREATE TABLE blob_ref (session_id TEXT, message_id TEXT, hash TEXT, seq INTEGER);
    `
        : ''
    }
  `)
}

function insertBlob(database, hash, payload) {
  database
    .prepare(
      'INSERT INTO blob (hash, mime, bytes, width, height, data, time_created) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(hash, 'application/octet-stream', payload.length, 1, 1, payload, 0)
}

function insertBlobReference(database, sessionId, messageId, hash, sequence) {
  database
    .prepare('INSERT INTO blob_ref (session_id, message_id, hash, seq) VALUES (?, ?, ?, ?)')
    .run(sessionId, messageId, hash, sequence)
}
function insertSqliteFixture(database) {
  const v1Message = '{"text":"短"}'
  const v1Part = '{"text":"v1-part-payload"}'
  const v2Message = '{"text":"a substantially longer v2 payload"}'
  database
    .prepare('INSERT INTO session (id, data) VALUES (?, ?)')
    .run(V1_SESSION_ID, '{"title":"v1"}')
  database
    .prepare('INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)')
    .run('msg_v1', V1_SESSION_ID, v1Message)
  database
    .prepare('INSERT INTO part (id, session_id, data) VALUES (?, ?, ?)')
    .run('part_v1', V1_SESSION_ID, v1Part)
  database
    .prepare('INSERT INTO session_v2 (id, data) VALUES (?, ?)')
    .run(V2_SESSION_ID, '{"title":"v2"}')
  database
    .prepare('INSERT INTO session_message (id, session_id, type, data) VALUES (?, ?, ?, ?)')
    .run('msg_v2', V2_SESSION_ID, 'user', v2Message)
  return {
    v1Bytes: Buffer.byteLength(v1Message) + Buffer.byteLength(v1Part),
    v2Bytes: Buffer.byteLength(v2Message)
  }
}

function sessionFileBytes(resources, sessionId) {
  return resources
    .filter(
      (resource) =>
        resource.sessionIds.includes(sessionId) &&
        !['database', 'wal'].includes(resource.kind) &&
        !/-shm$/i.test(resource.path)
    )
    .reduce((total, resource) => total + resource.bytes, 0)
}
function createHermesDatabase(databasePath) {
  const sessionId = 'hermes-space-fixture'
  const userContent = 'Hermes 用户文本'
  const assistantContent = 'Hermes 回答'
  const toolCalls = '[{"name":"fixture","arguments":"{}"}]'
  const reasoning = 'Hermes 推理'
  const database = new DatabaseSync(databasePath)
  try {
    database.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, started_at REAL);
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,
        tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL,
        active INTEGER, compacted INTEGER, display_metadata TEXT, reasoning TEXT
      );
    `)
    database
      .prepare('INSERT INTO sessions (id, title) VALUES (?, ?)')
      .run(sessionId, 'Hermes fixture')
    const insert = database.prepare(
      'INSERT INTO messages (session_id, role, content, tool_calls, reasoning) VALUES (?, ?, ?, ?, ?)'
    )
    insert.run(sessionId, 'user', userContent, null, null)
    insert.run(sessionId, 'assistant', assistantContent, toolCalls, reasoning)
  } finally {
    database.close()
  }
  return {
    sessionId,
    logicalBytes: [userContent, assistantContent, toolCalls, reasoning].reduce(
      (sum, value) => sum + Buffer.byteLength(value),
      0
    )
  }
}

function createMCodeDatabase(databasePath) {
  const migratedId = 'mvs_migrated_fixture'
  const legacyId = 'mvs_legacy_fixture'
  const migratedMessages = [
    { role: 'user', msg_content: 'migrated user payload' },
    { role: 'assistant', msg_content: 'migrated assistant payload' },
    { role: 'tool', msg_content: 'hidden tool payload' }
  ]
  const legacyMessages = [
    { role: 'user', msg_content: 'legacy user payload' },
    { role: 'assistant', msg_content: 'legacy assistant payload' },
    { role: 'tool', msg_content: 'hidden legacy tool payload' }
  ]
  const database = new DatabaseSync(databasePath)
  try {
    database.exec(`
      CREATE TABLE local_runtime_sessions (session_id TEXT, visibility TEXT, archived INTEGER,
        parent_session_id TEXT, session_kind TEXT);
      CREATE TABLE local_runtime_message_row_migrations (session_id TEXT);
      CREATE TABLE local_runtime_message_rows (id INTEGER, session_id TEXT, role TEXT,
        data_json TEXT, created_at_ms INTEGER);
      CREATE TABLE local_runtime_messages (session_id TEXT, display_messages_json TEXT);
    `)
    const insertSession = database.prepare(
      'INSERT INTO local_runtime_sessions VALUES (?, ?, ?, ?, ?)'
    )
    insertSession.run(migratedId, 'visible', 0, null, 'conversation')
    insertSession.run(legacyId, 'visible', 0, null, 'conversation')
    database.prepare('INSERT INTO local_runtime_message_row_migrations VALUES (?)').run(migratedId)
    const insertRow = database.prepare(
      'INSERT INTO local_runtime_message_rows VALUES (?, ?, ?, ?, ?)'
    )
    migratedMessages.forEach((message, index) =>
      insertRow.run(index + 1, migratedId, message.role, JSON.stringify(message), index)
    )
    database
      .prepare('INSERT INTO local_runtime_messages VALUES (?, ?)')
      .run(legacyId, JSON.stringify(legacyMessages))
  } finally {
    database.close()
  }
  return {
    migratedId,
    legacyId,
    migratedBytes: migratedMessages
      .slice(0, 2)
      .reduce((sum, message) => sum + Buffer.byteLength(JSON.stringify(message)), 0),
    legacyBytes: legacyMessages
      .slice(0, 2)
      .reduce((sum, message) => sum + Buffer.byteLength(JSON.stringify(message)), 0)
  }
}
function resourceBytes(resources, sourceId, kind) {
  return resources
    .filter(
      (resource) =>
        resource.sourceIds?.includes(sourceId) && (kind === undefined || resource.kind === kind)
    )
    .reduce((total, resource) => total + resource.bytes, 0)
}

test('OpenCode mixed SQLite V1/V2 and JSON resources report distinct measured sizes', async (t) => {
  const scratch = await createScratch(t)
  const root = path.join(scratch, 'opencode')
  const databasePath = path.join(root, 'opencode.db')
  await mkdir(root, { recursive: true })
  const database = new DatabaseSync(databasePath)
  try {
    database.exec('PRAGMA journal_mode=WAL')
    createOpenCodeSchema(database)
    const expected = insertSqliteFixture(database)
    const sourceId = 'source-opencode-space'
    const currentSource = source(sourceId, 'opencode', root, databasePath)
    const v1SessionPath = path.join(root, 'storage', 'session', 'project', `${V1_SESSION_ID}.json`)
    const v1MessagePath = path.join(root, 'storage', 'message', V1_SESSION_ID, 'msg_json.json')
    const v1PartPath = path.join(root, 'storage', 'part', 'msg_json', 'part_json.json')
    const diffPath = path.join(root, 'storage', 'session_diff', `${V1_SESSION_ID}.json`)
    const logPath = path.join(root, 'logs', 'runtime.log')
    await Promise.all([
      mkdir(path.dirname(v1SessionPath), { recursive: true }),
      mkdir(path.dirname(v1MessagePath), { recursive: true }),
      mkdir(path.dirname(v1PartPath), { recursive: true }),
      mkdir(path.dirname(diffPath), { recursive: true }),
      mkdir(path.dirname(logPath), { recursive: true })
    ])
    await Promise.all([
      writeFile(
        v1SessionPath,
        JSON.stringify({
          id: V1_SESSION_ID,
          parentSessionId: 'ses_parent_fixture',
          modelID: 'model-json-fixture'
        })
      ),
      writeFile(
        v1MessagePath,
        JSON.stringify({
          info: { id: 'msg_json', sessionID: V1_SESSION_ID, role: 'user' }
        })
      ),
      writeFile(v1PartPath, JSON.stringify({ type: 'text', text: 'private part body' })),
      writeFile(diffPath, JSON.stringify({ sessionID: V1_SESSION_ID, diff: 'private diff body' })),
      writeFile(logPath, 'log data\n')
    ])
    const walPath = `${databasePath}-wal`
    const walBytesBefore = (await stat(walPath)).size
    const databaseBytesBefore = (await stat(databasePath)).size
    const sessions = [
      managedSession(
        sourceId,
        'opencode',
        V1_SESSION_ID,
        `sqlite:${databasePath}:${V1_SESSION_ID}`,
        'sqlite'
      ),
      managedSession(
        sourceId,
        'opencode',
        V2_SESSION_ID,
        `sqlite:${databasePath}:${V2_SESSION_ID}`,
        'sqlite'
      )
    ]

    const result = await measureManagedSpace({ sources: [currentSource], sessions })
    const v1 = result.sessions.find((session) => session.sessionId === V1_SESSION_ID)
    const v2 = result.sessions.find((session) => session.sessionId === V2_SESSION_ID)
    const summary = result.storage[0]

    assert.equal(v1.storage.fileBytes, sessionFileBytes(result.resources, V1_SESSION_ID))
    assert.equal(v1.storage.sharedBytes, 0)
    assert.equal(v1.storage.logicalBytes, expected.v1Bytes)
    assert.equal(v1.messageCount, 1)
    assert.equal(v1.parentSessionId, 'ses_parent_fixture')
    assert.ok(v1.modelIds.includes('model-json-fixture'))
    assert.equal(v2.storage.fileBytes, sessionFileBytes(result.resources, V2_SESSION_ID))
    assert.equal(v2.storage.sharedBytes, 0)
    assert.equal(v2.storage.logicalBytes, expected.v2Bytes)
    assert.equal(v2.messageCount, 1)
    assert.notEqual(v1.storage.logicalBytes, v2.storage.logicalBytes)
    assert.equal(v1.revision, sessions[0].revision)
    assert.deepEqual(v1.capabilities, sessions[0].capabilities)
    assert.equal(v1.storage.complete, true, JSON.stringify(result.issues))
    assert.equal(v2.storage.complete, true)

    const v1Resources = result.resources.filter(
      (resource) =>
        resource.sourceIds?.includes(sourceId) && resource.sessionIds.includes(V1_SESSION_ID)
    )
    assert.ok(v1Resources.some((resource) => resource.path === v1SessionPath))
    assert.ok(v1Resources.some((resource) => resource.path === v1MessagePath))
    assert.ok(v1Resources.some((resource) => resource.path === v1PartPath))
    assert.ok(
      v1Resources.some((resource) => resource.path === diffPath && resource.kind === 'attachment')
    )
    assert.ok(v1.resourceIds.every((id) => v1Resources.some((resource) => resource.id === id)))
    assert.ok(
      result.resources.some((resource) => resource.path === logPath && resource.kind === 'log')
    )
    const databaseResource = result.resources.find(
      (resource) => resource.path === databasePath && resource.kind === 'database'
    )
    assert.ok(databaseResource)
    assert.equal(databaseResource.bytes, databaseBytesBefore)
    assert.equal(databaseResource.shared, true)
    assert.deepEqual(databaseResource.sessionIds, [V1_SESSION_ID, V2_SESSION_ID])
    assert.equal(v2.storage.fileBytes, 0)
    assert.ok(
      result.resources.some((resource) => resource.path === walPath && resource.kind === 'wal')
    )
    assert.equal(summary.databaseBytes, resourceBytes(result.resources, sourceId, 'database'))
    assert.equal(summary.walBytes, resourceBytes(result.resources, sourceId, 'wal'))
    assert.equal(summary.fileBytes, resourceBytes(result.resources, sourceId))
    assert.equal(summary.otherBytes, summary.fileBytes - summary.databaseBytes - summary.walBytes)
    assert.ok(summary.otherBytes >= Buffer.byteLength('log data\n'))
    assert.equal(typeof summary.databaseFreeBytes, 'number')
    assert.equal((await stat(databasePath)).size, databaseBytesBefore)
    assert.equal((await stat(walPath)).size, walBytesBefore)

    const serialized = JSON.stringify(result)
    assert.equal(serialized.includes('private part body'), false)
    assert.equal(serialized.includes('private diff body'), false)
  } finally {
    database.close()
  }
})

test('OpenCode SQLite V1/V2 sessions expose model and parent metadata', async (t) => {
  const scratch = await createScratch(t)
  const root = path.join(scratch, 'opencode-metadata')
  const databasePath = path.join(root, 'opencode.db')
  const sourceId = 'source-opencode-metadata'
  const v1SessionId = 'ses_metadata_v1'
  const v2SessionId = 'ses_metadata_v2'
  const v1ParentId = 'ses_parent_v1'
  const v2ParentId = 'ses_parent_v2'
  await mkdir(root, { recursive: true })

  const database = new DatabaseSync(databasePath)
  try {
    createOpenCodeSchema(database)
    database
      .prepare('INSERT INTO session (id, data, parent_id) VALUES (?, ?, ?)')
      .run(v1SessionId, JSON.stringify({ title: 'V1 fixture' }), v1ParentId)
    database
      .prepare('INSERT INTO session_v2 (id, data, parent_id) VALUES (?, ?, ?)')
      .run(v2SessionId, JSON.stringify({ title: 'V2 fixture' }), v2ParentId)

    const v1Messages = [
      { modelID: 'model-v1-primary', model: { id: 'model-v1-ignored' }, text: 'private v1 body' },
      { model: { id: 'model-v1-nested' }, text: 'private v1 body' },
      { model: 'model-v1-string', text: 'private v1 body' }
    ]
    const insertV1 = database.prepare('INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)')
    v1Messages.forEach((data, index) =>
      insertV1.run('v1-message-' + index, v1SessionId, JSON.stringify(data))
    )

    const v2Messages = [
      { modelID: 'model-v2-primary', model: { id: 'model-v2-ignored' }, text: 'private v2 body' },
      { model: { id: 'model-v2-nested' }, text: 'private v2 body' },
      { model: 'model-v2-string', text: 'private v2 body' }
    ]
    const insertV2 = database.prepare(
      'INSERT INTO session_message (id, session_id, type, data) VALUES (?, ?, ?, ?)'
    )
    v2Messages.forEach((data, index) =>
      insertV2.run('v2-message-' + index, v2SessionId, 'assistant', JSON.stringify(data))
    )
  } finally {
    database.close()
  }

  const sqliteSession = (sessionId) =>
    managedSession(
      sourceId,
      'opencode',
      sessionId,
      'sqlite:' + databasePath + ':' + sessionId,
      'sqlite'
    )
  const result = await measureManagedSpace({
    sources: [source(sourceId, 'opencode', root, databasePath)],
    sessions: [sqliteSession(v1SessionId), sqliteSession(v2SessionId)]
  })
  const v1Session = result.sessions.find((session) => session.sessionId === v1SessionId)
  const v2Session = result.sessions.find((session) => session.sessionId === v2SessionId)

  assert.deepEqual(v1Session.modelIds, ['model-v1-nested', 'model-v1-primary', 'model-v1-string'])
  assert.deepEqual(v2Session.modelIds, ['model-v2-nested', 'model-v2-primary', 'model-v2-string'])
  assert.equal(v1Session.parentSessionId, v1ParentId)
  assert.equal(v2Session.parentSessionId, v2ParentId)
  assert.equal(v1Session.storage.complete, true)
  assert.equal(v2Session.storage.complete, true)
  assert.equal(JSON.stringify(result).includes('private v1 body'), false)
  assert.equal(JSON.stringify(result).includes('private v2 body'), false)
})

test('cancellation during measurement keeps collected files and unknown SQLite size', async (t) => {
  const scratch = await createScratch(t)
  const piRoot = path.join(scratch, 'pi')
  const opencodeRoot = path.join(scratch, 'opencode')
  const firstPath = path.join(piRoot, 'a.jsonl')
  const skippedPath = path.join(piRoot, 'z.jsonl')
  const firstContents = JSON.stringify({ type: 'message', message: { role: 'user' } }) + '\n'
  await Promise.all([mkdir(piRoot, { recursive: true }), mkdir(opencodeRoot, { recursive: true })])
  await Promise.all([writeFile(firstPath, firstContents), writeFile(skippedPath, 'not measured')])

  const databasePath = path.join(opencodeRoot, 'opencode.db')
  const sqliteSessionId = 'ses_cancelled_sqlite'
  const database = new DatabaseSync(databasePath)
  try {
    createOpenCodeSchema(database)
    database
      .prepare('INSERT INTO session_v2 (id, data) VALUES (?, ?)')
      .run(sqliteSessionId, JSON.stringify({ title: 'unmeasured' }))
    database
      .prepare('INSERT INTO session_message (id, session_id, type, data) VALUES (?, ?, ?, ?)')
      .run('message-cancelled', sqliteSessionId, 'user', JSON.stringify({ text: 'payload' }))
  } finally {
    database.close()
  }

  const piSourceId = 'source-cancelled-pi'
  const opencodeSourceId = 'source-cancelled-opencode'
  const controller = new AbortController()
  let abortedDuringMeasurement = false
  const result = await measureManagedSpace({
    sources: [
      source(piSourceId, 'pi', piRoot),
      source(opencodeSourceId, 'opencode', opencodeRoot, databasePath)
    ],
    sessions: [
      managedSession(piSourceId, 'pi', 'pi-cancelled', firstPath),
      managedSession(
        opencodeSourceId,
        'opencode',
        sqliteSessionId,
        'sqlite:' + databasePath + ':' + sqliteSessionId,
        'sqlite'
      )
    ],
    signal: controller.signal,
    onProgress: (progress) => {
      if (!abortedDuringMeasurement && progress.phase === 'scan' && progress.bytes > 0) {
        abortedDuringMeasurement = true
        controller.abort()
      }
    }
  })

  const fileSession = result.sessions.find((session) => session.sessionId === 'pi-cancelled')
  const sqliteSession = result.sessions.find((session) => session.sessionId === sqliteSessionId)
  assert.equal(abortedDuringMeasurement, true)
  assert.ok(fileSession)
  assert.ok(sqliteSession)
  assert.ok(result.resources.some((resource) => resource.path === firstPath))
  assert.equal(
    result.resources.some((resource) => resource.path === skippedPath),
    false
  )
  assert.equal(fileSession.storage.fileBytes, Buffer.byteLength(firstContents))
  assert.equal(fileSession.storage.complete, false)
  assert.equal(sqliteSession.storage.logicalBytes, undefined)
  assert.equal(sqliteSession.storage.complete, false)
  assert.ok(result.storage.every((summary) => !summary.complete))
})

test('Windows verbatim Pi and OMP paths match inventoried files without damaging UNC roots', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows verbatim path behavior is platform-specific')
    return
  }

  const scratch = await createScratch(t)
  const piRoot = path.join(scratch, 'pi-verbatim')
  const ompRoot = path.join(scratch, 'omp-verbatim')
  const piPath = path.join(piRoot, 'pi-session.jsonl')
  const ompPath = path.join(ompRoot, 'omp-session.jsonl')
  const piContents =
    JSON.stringify({
      type: 'message',
      id: 'pi-verbatim-message',
      message: { role: 'user', content: [{ type: 'text', text: 'pi fixture' }] }
    }) + '\n'
  const ompContents =
    JSON.stringify({
      type: 'message',
      id: 'omp-verbatim-message',
      message: { role: 'user', content: [{ type: 'text', text: 'omp fixture' }] }
    }) + '\n'
  await Promise.all([mkdir(piRoot, { recursive: true }), mkdir(ompRoot, { recursive: true })])
  await Promise.all([writeFile(piPath, piContents), writeFile(ompPath, ompContents)])

  const verbatimPath = (filePath) => '\\\\?\\' + path.resolve(filePath)
  const piSourceId = 'source-pi-verbatim'
  const ompSourceId = 'source-omp-verbatim'
  const piSessionId = 'pi-verbatim-session'
  const ompSessionId = 'omp-verbatim-session'
  const result = await measureManagedSpace({
    sources: [source(piSourceId, 'pi', piRoot), source(ompSourceId, 'omp', ompRoot)],
    sessions: [
      managedSession(piSourceId, 'pi', piSessionId, verbatimPath(piPath)),
      managedSession(ompSourceId, 'omp', ompSessionId, verbatimPath(ompPath))
    ]
  })
  const piSession = result.sessions.find((session) => session.sessionId === piSessionId)
  const ompSession = result.sessions.find((session) => session.sessionId === ompSessionId)
  const uncPath = '\\\\server\\share\\sessions\\session.jsonl'
  const verbatimUncPath = '\\\\?\\UNC\\server\\share\\sessions\\session.jsonl'

  assert.equal(normalizeManagedPath(verbatimPath(piPath)), normalizeManagedPath(piPath))
  assert.equal(normalizeManagedPath(verbatimUncPath), normalizeManagedPath(uncPath))
  assert.ok(normalizeManagedPath(uncPath).startsWith('\\\\server\\share\\'))
  assert.equal(piSession.storage.fileBytes, Buffer.byteLength(piContents))
  assert.equal(ompSession.storage.fileBytes, Buffer.byteLength(ompContents))
  assert.equal(piSession.storage.complete, true)
  assert.equal(ompSession.storage.complete, true)
  assert.ok(
    result.resources.some(
      (resource) => resource.path === piPath && resource.sessionIds.includes(piSessionId)
    )
  )
  assert.ok(
    result.resources.some(
      (resource) => resource.path === ompPath && resource.sessionIds.includes(ompSessionId)
    )
  )
})

test('Gemini same-stem JSON sidecars contribute to session storage', async (t) => {
  const scratch = await createScratch(t)
  const root = path.join(scratch, 'gemini')
  const chats = path.join(root, 'project', 'chats')
  const sessionId = 'gemini-space-fixture'
  const transcriptPath = path.join(chats, 'arbitrary-session.jsonl')
  const sidecarPath = transcriptPath.replace(/\.jsonl$/, '.json')
  const transcript =
    [
      JSON.stringify({ sessionId, projectHash: 'fixture-project', startTime: 1, lastUpdated: 2 }),
      JSON.stringify({ id: 'gemini-message', type: 'user', content: [{ text: 'fixture' }] })
    ].join('\n') + '\n'
  const sidecar = JSON.stringify({ sessionId, startTime: 1, lastUpdated: 2, messages: [] })
  await mkdir(chats, { recursive: true })
  await Promise.all([writeFile(transcriptPath, transcript), writeFile(sidecarPath, sidecar)])

  const sourceId = 'source-gemini-space'
  const result = await measureManagedSpace({
    sources: [source(sourceId, 'gemini', root)],
    sessions: [managedSession(sourceId, 'gemini', sessionId, transcriptPath)]
  })
  const [session] = result.sessions
  const sidecarResource = result.resources.find((resource) => resource.path === sidecarPath)

  assert.equal(
    session.storage.fileBytes,
    Buffer.byteLength(transcript) + Buffer.byteLength(sidecar)
  )
  assert.equal(session.storage.sharedBytes, 0)
  assert.equal(session.storage.complete, true)
  assert.equal(sidecarResource.kind, 'attachment')
  assert.deepEqual(sidecarResource.sessionIds, [sessionId])
  assert.ok(sidecarResource.sourceIds.includes(sourceId))
})

for (const extension of ['.jsonl', '.JSONL']) {
  test(`OMP artifact directory files and matching backups contribute to session storage (${extension})`, async (t) => {
    const scratch = await createScratch(t)
    const root = path.join(scratch, 'omp')
    const sessionsDirectory = path.join(root, 'sessions')
    const sessionId = 'omp-space-fixture'
    const transcriptPath = path.join(sessionsDirectory, sessionId + extension)
    const artifactPath = path.join(sessionsDirectory, sessionId, 'attachments', 'image.bin')
    const backupPath = transcriptPath + '.recovery.bak'
    const transcript =
      [
        JSON.stringify({ type: 'session', id: sessionId, cwd: '/fixture/omp' }),
        JSON.stringify({
          type: 'message',
          id: 'omp-message',
          message: { role: 'user', content: [{ type: 'text', text: 'fixture' }] }
        })
      ].join('\n') + '\n'
    const artifact = Buffer.from('omp artifact bytes')
    const backup = Buffer.from('omp backup bytes')
    await mkdir(path.dirname(artifactPath), { recursive: true })
    await Promise.all([
      writeFile(transcriptPath, transcript),
      writeFile(artifactPath, artifact),
      writeFile(backupPath, backup)
    ])

    const sourceId = 'source-omp-space'
    const sessionSourcePath =
      process.platform === 'win32' ? '\\\\?\\' + path.resolve(transcriptPath) : transcriptPath
    const result = await measureManagedSpace({
      sources: [source(sourceId, 'omp', root)],
      sessions: [managedSession(sourceId, 'omp', sessionId, sessionSourcePath)]
    })
    const [session] = result.sessions
    const artifactResource = result.resources.find((resource) => resource.path === artifactPath)
    const backupResource = result.resources.find((resource) => resource.path === backupPath)

    assert.equal(
      session.storage.fileBytes,
      Buffer.byteLength(transcript) + artifact.length + backup.length
    )
    assert.equal(session.storage.sharedBytes, 0)
    assert.equal(session.storage.complete, true)
    assert.equal(artifactResource.kind, 'attachment')
    assert.equal(backupResource.kind, 'attachment')
    assert.deepEqual(artifactResource.sessionIds, [sessionId])
    assert.deepEqual(backupResource.sessionIds, [sessionId])
    assert.ok(artifactResource.sourceIds.includes(sourceId))
    assert.ok(backupResource.sourceIds.includes(sourceId))
  })
}

test('Claude sidecar files are exclusively owned and transcript metadata is retained', async (t) => {
  const scratch = await createScratch(t)
  const root = path.join(scratch, 'claude-projects')
  const sessionId = 'claude-space-fixture'
  const transcriptPath = path.join(root, '-project', `${sessionId}.jsonl`)
  const sidecarFile = path.join(root, '-project', sessionId, 'tool-results', 'result.txt')
  const record = {
    type: 'user',
    sessionId,
    uuid: 'message-fixture',
    parentSessionId: 'claude-parent-fixture',
    modelID: 'claude-model-fixture',
    message: { role: 'user', content: [{ type: 'text', text: 'private transcript body' }] }
  }
  await mkdir(path.dirname(sidecarFile), { recursive: true })
  await writeFile(transcriptPath, `${JSON.stringify(record)}\n`)
  await writeFile(sidecarFile, 'private sidecar data')
  const sourceId = 'source-claude-space'
  const original = managedSession(sourceId, 'claude', sessionId, transcriptPath)

  const result = await measureManagedSpace({
    sources: [source(sourceId, 'claude', root)],
    sessions: [original]
  })
  const [session] = result.sessions
  const resources = result.resources.filter((resource) => resource.sessionIds.includes(sessionId))

  assert.equal(
    session.storage.fileBytes,
    Buffer.byteLength(`${JSON.stringify(record)}\n`) + Buffer.byteLength('private sidecar data')
  )
  assert.equal(session.storage.sharedBytes, 0)
  assert.equal(session.messageCount, 1)
  assert.equal(session.parentSessionId, 'claude-parent-fixture')
  assert.ok(session.modelIds.includes('claude-model-fixture'))
  assert.ok(
    resources.some((resource) => resource.path === transcriptPath && resource.kind === 'transcript')
  )
  assert.ok(
    resources.some((resource) => resource.path === sidecarFile && resource.kind === 'attachment')
  )
  assert.ok(resources.every((resource) => resource.sourceIds?.includes(sourceId)))
  assert.equal(JSON.stringify(result).includes('private transcript body'), false)
})

test('Codex compressed compaction siblings are included in exclusive session storage', async (t) => {
  const scratch = await createScratch(t)
  const root = path.join(scratch, 'codex-sessions')
  const sessionId = '11111111-2222-4333-8444-555555555555'
  const transcriptPath = path.join(root, 'rollout.jsonl')
  const compressedPath = `${transcriptPath}.zst`
  const transcript = `${JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ text: 'private message' }] }
  })}\n`
  const compressed = zstdCompressSync(Buffer.from('compressed compaction payload'))
  await mkdir(root, { recursive: true })
  await Promise.all([writeFile(transcriptPath, transcript), writeFile(compressedPath, compressed)])
  const sourceId = 'source-codex-space'
  const result = await measureManagedSpace({
    sources: [source(sourceId, 'codex', root)],
    sessions: [managedSession(sourceId, 'codex', sessionId, transcriptPath)]
  })

  assert.equal(
    result.sessions[0].storage.fileBytes,
    Buffer.byteLength(transcript) + compressed.length
  )
  assert.equal(result.sessions[0].messageCount, 1)
  assert.equal(
    result.resources.some(
      (resource) =>
        resource.path === compressedPath && resource.kind === 'transcript' && !resource.shared
    ),
    true
  )
})
test('hard-linked paths across sources are globally deduplicated and unknown files mark one source incomplete', async (t) => {
  const scratch = await createScratch(t)
  const firstRoot = path.join(scratch, 'pi-source-a')
  const secondRoot = path.join(scratch, 'pi-source-b')
  const firstPath = path.join(firstRoot, 'first.jsonl')
  const firstAliasPath = path.join(firstRoot, 'first-alias.jsonl')
  const secondPath = path.join(secondRoot, 'second.jsonl')
  const unknownPath = path.join(firstRoot, 'unmapped.bin')
  await Promise.all([mkdir(firstRoot, { recursive: true }), mkdir(secondRoot, { recursive: true })])
  const transcript = `${JSON.stringify({ type: 'message', message: { role: 'user' } })}\n`
  await writeFile(firstPath, transcript)
  await link(firstPath, firstAliasPath)
  await link(firstPath, secondPath)
  await writeFile(unknownPath, 'unknown ownership')
  const firstSourceId = 'source-pi-a'
  const secondSourceId = 'source-pi-b'
  const sources = [source(firstSourceId, 'pi', firstRoot), source(secondSourceId, 'pi', secondRoot)]
  const sessions = [
    managedSession(firstSourceId, 'pi', 'pi-first', firstPath),
    managedSession(firstSourceId, 'pi', 'pi-first-alias', firstAliasPath),
    managedSession(secondSourceId, 'pi', 'pi-second', secondPath)
  ]

  const result = await measureManagedSpace({ sources, sessions })
  const shared = result.resources.find(
    (resource) =>
      resource.sessionIds.includes('pi-first') && resource.sessionIds.includes('pi-second')
  )
  const [firstSummary, secondSummary] = result.storage

  assert.equal(shared.bytes, Buffer.byteLength(transcript))
  assert.equal(shared.shared, true)
  assert.deepEqual(shared.sessionIds, ['pi-first', 'pi-first-alias', 'pi-second'])
  assert.deepEqual(shared.sourceIds, [firstSourceId, secondSourceId])
  assert.equal(result.sessions.length, 3)
  assert.ok(result.sessions.every((session) => session.storage.fileBytes === 0))
  assert.ok(
    result.sessions.every(
      (session) => session.storage.sharedBytes === Buffer.byteLength(transcript)
    )
  )
  assert.ok(result.sessions.every((session) => session.messageCount === 1))
  assert.equal(firstSummary.fileBytes, resourceBytes(result.resources, firstSourceId))
  assert.equal(secondSummary.fileBytes, resourceBytes(result.resources, secondSourceId))
  assert.equal(result.resources.filter((resource) => resource.id === shared.id).length, 1)
  assert.equal(firstSummary.complete, false)
  assert.equal(secondSummary.complete, true)
  assert.ok(
    result.sessions
      .filter((session) => session.sourceId === firstSourceId)
      .every((session) => !session.storage.complete)
  )
  assert.equal(
    result.sessions.find((session) => session.sessionId === 'pi-second')?.storage.complete,
    true
  )
  assert.ok(
    result.issues.some(
      (issue) => issue.path === unknownPath && issue.message.includes('归属无法确证')
    )
  )
})
test('OpenCode blob references count shared hashes once and keep exclusive blobs logical', async (t) => {
  const scratch = await createScratch(t)
  const root = path.join(scratch, 'opencode-blobs')
  const databasePath = path.join(root, 'opencode.db')
  await mkdir(root, { recursive: true })
  const database = new DatabaseSync(databasePath)
  const firstSessionId = 'ses_space_blob_first'
  const secondSessionId = 'ses_space_blob_second'
  const firstMessage = Buffer.from('{"text":"first message"}')
  const secondMessage = Buffer.from('{"text":"second message"}')
  const sharedBlob = Buffer.from('shared attachment bytes')
  const exclusiveBlob = Buffer.from('exclusive attachment bytes')
  try {
    createOpenCodeSchema(database, true)
    database
      .prepare('INSERT INTO session_v2 (id, data) VALUES (?, ?)')
      .run(firstSessionId, '{"title":"first"}')
    database
      .prepare('INSERT INTO session_v2 (id, data) VALUES (?, ?)')
      .run(secondSessionId, '{"title":"second"}')
    database
      .prepare('INSERT INTO session_message (id, session_id, type, data) VALUES (?, ?, ?, ?)')
      .run('message_first', firstSessionId, 'user', firstMessage.toString())
    database
      .prepare('INSERT INTO session_message (id, session_id, type, data) VALUES (?, ?, ?, ?)')
      .run('message_second', secondSessionId, 'user', secondMessage.toString())
    insertBlob(database, 'hash-shared', sharedBlob)
    insertBlob(database, 'hash-exclusive', exclusiveBlob)
    insertBlobReference(database, firstSessionId, 'message_first', 'hash-shared', 0)
    insertBlobReference(database, firstSessionId, 'message_first_copy', 'hash-shared', 1)
    insertBlobReference(database, firstSessionId, 'message_first', 'hash-exclusive', 2)
    insertBlobReference(database, secondSessionId, 'message_second', 'hash-shared', 0)
  } finally {
    database.close()
  }
  const sourceId = 'source-opencode-blobs'
  const result = await measureManagedSpace({
    sources: [source(sourceId, 'opencode', root, databasePath)],
    sessions: [
      managedSession(
        sourceId,
        'opencode',
        firstSessionId,
        `sqlite:${databasePath}:${firstSessionId}`,
        'sqlite'
      ),
      managedSession(
        sourceId,
        'opencode',
        secondSessionId,
        `sqlite:${databasePath}:${secondSessionId}`,
        'sqlite'
      )
    ]
  })
  const first = result.sessions.find((session) => session.sessionId === firstSessionId)
  const second = result.sessions.find((session) => session.sessionId === secondSessionId)

  assert.equal(first.storage.fileBytes, 0)
  assert.equal(first.storage.logicalBytes, firstMessage.length + exclusiveBlob.length)
  assert.equal(first.storage.sharedBytes, sharedBlob.length)
  assert.equal(second.storage.fileBytes, 0)
  assert.equal(second.storage.logicalBytes, secondMessage.length)
  assert.equal(second.storage.sharedBytes, sharedBlob.length)
  assert.equal(first.storage.complete, true)
  assert.equal(second.storage.complete, true)
  assert.equal(JSON.stringify(result).includes('shared attachment bytes'), false)
  assert.equal(JSON.stringify(result).includes('exclusive attachment bytes'), false)
})

test('OpenCode blob schemas missing confirmed size fields leave logical size unknown', async (t) => {
  const scratch = await createScratch(t)
  const root = path.join(scratch, 'opencode-unknown-blobs')
  const databasePath = path.join(root, 'opencode.db')
  await mkdir(root, { recursive: true })
  const database = new DatabaseSync(databasePath)
  try {
    createOpenCodeSchema(database)
    database.exec('CREATE TABLE blob (hash TEXT PRIMARY KEY);')
    database.exec('CREATE TABLE blob_ref (session_id TEXT, hash TEXT);')
    database
      .prepare('INSERT INTO session_v2 (id, data) VALUES (?, ?)')
      .run(V2_SESSION_ID, '{"title":"fixture"}')
    database
      .prepare('INSERT INTO session_message (id, session_id, type, data) VALUES (?, ?, ?, ?)')
      .run('message_unknown', V2_SESSION_ID, 'user', '{"text":"private payload"}')
    database
      .prepare('INSERT INTO blob_ref (session_id, hash) VALUES (?, ?)')
      .run(V2_SESSION_ID, 'unknown-hash')
  } finally {
    database.close()
  }
  const sourceId = 'source-opencode-unknown-blobs'
  const result = await measureManagedSpace({
    sources: [source(sourceId, 'opencode', root, databasePath)],
    sessions: [
      managedSession(
        sourceId,
        'opencode',
        V2_SESSION_ID,
        `sqlite:${databasePath}:${V2_SESSION_ID}`,
        'sqlite'
      )
    ]
  })

  assert.equal(result.sessions[0].storage.fileBytes, 0)
  assert.equal(result.sessions[0].storage.logicalBytes, undefined)
  assert.equal(result.sessions[0].storage.sharedBytes, 0)
  assert.equal(result.sessions[0].storage.complete, false)
  assert.equal(result.storage[0].complete, false)
  assert.ok(result.issues.some((issue) => issue.message.includes('逻辑字节数未知')))
  assert.equal(JSON.stringify(result).includes('private payload'), false)
})

test('Hermes and MCode SQLite sessions use provider-specific read-only payload layouts', async (t) => {
  const scratch = await createScratch(t)
  const hermesRoot = path.join(scratch, 'hermes')
  const mcodeRoot = path.join(scratch, 'mcode')
  const incompleteRoot = path.join(scratch, 'mcode-incomplete')
  await Promise.all([
    mkdir(hermesRoot, { recursive: true }),
    mkdir(mcodeRoot, { recursive: true }),
    mkdir(incompleteRoot, { recursive: true })
  ])
  const hermesPath = path.join(hermesRoot, 'state.db')
  const mcodePath = path.join(mcodeRoot, 'v2', 'sqlite', 'runtime-state.sqlite')
  const incompletePath = path.join(incompleteRoot, 'runtime-state.sqlite')
  await mkdir(path.dirname(mcodePath), { recursive: true })
  const hermes = createHermesDatabase(hermesPath)
  const mcode = createMCodeDatabase(mcodePath)
  const incomplete = new DatabaseSync(incompletePath)
  try {
    incomplete.exec(`
      CREATE TABLE local_runtime_sessions (session_id TEXT);
      CREATE TABLE local_runtime_message_rows (session_id TEXT, role TEXT, data_json TEXT);
      CREATE TABLE local_runtime_messages (session_id TEXT, display_messages_json TEXT);
      INSERT INTO local_runtime_sessions VALUES ('mvs_missing_layout');
    `)
  } finally {
    incomplete.close()
  }
  const hermesSourceId = 'source-hermes-sqlite'
  const mcodeSourceId = 'source-mcode-sqlite'
  const incompleteSourceId = 'source-mcode-incomplete'
  const result = await measureManagedSpace({
    sources: [
      source(hermesSourceId, 'hermes', hermesRoot),
      source(mcodeSourceId, 'mcode', mcodeRoot),
      source(incompleteSourceId, 'mcode', incompleteRoot)
    ],
    sessions: [
      managedSession(
        hermesSourceId,
        'hermes',
        hermes.sessionId,
        `sqlite:${hermesPath}#${hermes.sessionId}`,
        'sqlite'
      ),
      managedSession(
        mcodeSourceId,
        'mcode',
        mcode.migratedId,
        `mcode:${mcode.migratedId}`,
        'sqlite',
        mcodePath
      ),
      managedSession(
        mcodeSourceId,
        'mcode',
        mcode.legacyId,
        `mcode:${mcode.legacyId}`,
        'sqlite',
        mcodePath
      ),
      managedSession(
        incompleteSourceId,
        'mcode',
        'mvs_missing_layout',
        'mcode:mvs_missing_layout',
        'sqlite',
        incompletePath
      )
    ]
  })
  const hermesResult = result.sessions.find((session) => session.sessionId === hermes.sessionId)
  const migratedResult = result.sessions.find((session) => session.sessionId === mcode.migratedId)
  const legacyResult = result.sessions.find((session) => session.sessionId === mcode.legacyId)
  const incompleteResult = result.sessions.find(
    (session) => session.sessionId === 'mvs_missing_layout'
  )

  assert.equal(hermesResult.storage.logicalBytes, hermes.logicalBytes)
  assert.equal(hermesResult.messageCount, 2)
  assert.equal(hermesResult.storage.fileBytes, 0)
  assert.equal(hermesResult.storage.sharedBytes, 0)
  assert.equal(hermesResult.storage.complete, true)
  assert.equal(migratedResult.storage.logicalBytes, mcode.migratedBytes)
  assert.equal(migratedResult.messageCount, 2)
  assert.equal(migratedResult.storage.fileBytes, 0)
  assert.equal(migratedResult.storage.complete, true)
  assert.equal(legacyResult.storage.logicalBytes, mcode.legacyBytes)
  assert.equal(legacyResult.messageCount, 2)
  assert.equal(legacyResult.storage.fileBytes, 0)
  assert.equal(legacyResult.storage.complete, true)
  assert.equal(incompleteResult.storage.logicalBytes, undefined)
  assert.equal(incompleteResult.storage.complete, false)
})
