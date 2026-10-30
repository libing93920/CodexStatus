/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createAdditionalDeleteProviderFixtures,
  createClaudeFixture,
  createCodexFixture,
  createOpenCodeFixture,
  createReadOnlyProviderFixtures,
  failNextOpenCodeV2Delete,
  restoreOpenCodeV2Delete
} from './fixtures/session-manager-core-fixtures.mjs'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CORE_EXECUTABLE = join(
  PROJECT_ROOT,
  'native',
  'target',
  'release',
  `session-core${process.platform === 'win32' ? '.exe' : ''}`
)
const SCRATCH_PREFIX = 'session-manager-core-'
const REQUEST_TIMEOUT_MS = 120_000
const WINDOWS_SEPARATOR = String.fromCharCode(92)
const WINDOWS_UNC_PREFIX = WINDOWS_SEPARATOR.repeat(2)
const WINDOWS_EXTENDED_PATH_PREFIX = `${WINDOWS_UNC_PREFIX}?${WINDOWS_SEPARATOR}`
const WINDOWS_EXTENDED_UNC_PREFIX = `${WINDOWS_EXTENDED_PATH_PREFIX}UNC${WINDOWS_SEPARATOR}`
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024
let requestSequence = 0

async function createScratch(testContext) {
  const parent = resolve(tmpdir())
  const directory = await mkdtemp(join(parent, SCRATCH_PREFIX))
  testContext.after(async () => {
    const target = resolve(directory)
    assert.equal(dirname(target), parent, 'cleanup must stay inside the system temp directory')
    assert.ok(basename(target).startsWith(SCRATCH_PREFIX), 'cleanup must own this test directory')
    await rm(target, { recursive: true, force: true })
  })
  return directory
}
test('Core handles multiple JSONL requests in one process', async (t) => {
  const scratch = await createScratch(t)
  const fixture = await createOpenCodeFixture(scratch)
  const requests = [1, 2].map(() => ({
    id: ++requestSequence,
    method: 'scan',
    source: fixture.source
  }))
  for (const request of requests) assertPathsInsideScratch(request, scratch)
  const result = spawnSync(CORE_EXECUTABLE, [], {
    cwd: PROJECT_ROOT,
    env: isolatedEnvironment(scratch),
    input: requests.map((request) => JSON.stringify(request)).join('\n') + '\n',
    encoding: 'utf8',
    maxBuffer: MAX_RESPONSE_BYTES,
    timeout: REQUEST_TIMEOUT_MS,
    windowsHide: true
  })
  assert.ifError(result.error, `cannot start ${CORE_EXECUTABLE}`)
  assert.equal(
    result.status,
    0,
    `core exited ${result.status}: ${String(result.stderr ?? '').slice(0, 500)}`
  )
  const responses = String(result.stdout ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map(JSON.parse)
  assert.deepEqual(
    responses.map((response) => response.id),
    requests.map((request) => request.id)
  )
  const expectedIds = [fixture.v1SessionId, fixture.v2SessionId].sort()
  assert.deepEqual(
    responses.map((response) => sessionIds(response.result.sessions)),
    [expectedIds, expectedIds]
  )
})
test('OpenCode mixed V1/V2 reads and deletes without harming the other session or reviving JSON copies', async (t) => {
  const scratch = await createScratch(t)
  const fixture = await createOpenCodeFixture(scratch)
  const sessions = request('scan', { source: fixture.source }, scratch)
  assert.deepEqual(sessionIds(sessions), [fixture.v1SessionId, fixture.v2SessionId].sort())
  const v1 = findSession(sessions, fixture.v1SessionId)
  const v2 = findSession(sessions, fixture.v2SessionId)
  assert.equal(v1.providerId, 'opencode')
  assert.equal(v1.sourceId, fixture.source.id)
  assert.equal(v2.capabilities.delete, true)
  assert.deepEqual(
    messageShape(request('read', { source: fixture.source, session: v1 }, scratch)),
    [['user', fixture.v1Body]]
  )
  assert.deepEqual(
    messageShape(request('read', { source: fixture.source, session: v2 }, scratch)),
    [['user', fixture.v2Body]]
  )
  const preview = request(
    'inspect',
    { source: fixture.source, session: v2, revision: v2.revision },
    scratch
  )
  assert.equal(preview.session.sessionId, fixture.v2SessionId)
  assert.equal(preview.revision, v2.revision)
  assert.ok(Array.isArray(preview.files))

  assert.equal(deleteSession(fixture.source, v2, scratch).deleted, true)
  const remaining = request('scan', { source: fixture.source }, scratch)
  assert.deepEqual(sessionIds(remaining), [fixture.v1SessionId])
  assert.equal(
    request('read', { source: fixture.source, session: remaining[0] }, scratch).messages[0].content,
    fixture.v1Body
  )
  assert.equal(deleteSession(fixture.source, remaining[0], scratch).deleted, true)
  assert.deepEqual(request('scan', { source: fixture.source }, scratch), [])
})

test('OpenCode deletion rolls back earlier message changes after a later SQLite failure', async (t) => {
  const scratch = await createScratch(t)
  const fixture = await createOpenCodeFixture(scratch)
  failNextOpenCodeV2Delete(fixture.databasePath)
  const target = findSession(
    request('scan', { source: fixture.source }, scratch),
    fixture.v2SessionId
  )
  assertRejected(
    deleteResponse(fixture.source, target, scratch),
    'forced database failure must reject deletion'
  )
  assert.equal(countOpenCodeRows(fixture.databasePath, 'session_v2', fixture.v2SessionId), 1)
  assert.equal(countOpenCodeRows(fixture.databasePath, 'session_message', fixture.v2SessionId), 1)
  assert.deepEqual(
    sessionIds(request('scan', { source: fixture.source }, scratch)),
    [fixture.v1SessionId, fixture.v2SessionId].sort()
  )
  restoreOpenCodeV2Delete(fixture.databasePath)
})

test('OpenCode deletes only unshared blobs with the selected session', async (t) => {
  const scratch = await createScratch(t)
  const fixture = await createOpenCodeFixture(scratch)
  const database = new DatabaseSync(fixture.databasePath)
  try {
    database.exec(`
      CREATE TABLE blob (hash TEXT PRIMARY KEY);
      CREATE TABLE blob_ref (session_id TEXT NOT NULL, hash TEXT NOT NULL);
      INSERT INTO blob VALUES ('shared-hash'), ('exclusive-hash');
      INSERT INTO blob_ref VALUES
        ('ses_v1_keep', 'shared-hash'),
        ('ses_v2_delete', 'shared-hash'),
        ('ses_v2_delete', 'exclusive-hash');
    `)
  } finally {
    database.close()
  }
  const session = findSession(
    request('scan', { source: fixture.source }, scratch),
    fixture.v2SessionId
  )
  assert.equal(deleteSession(fixture.source, session, scratch).deleted, true)
  const result = new DatabaseSync(fixture.databasePath, { readOnly: true })
  try {
    assert.deepEqual(
      result
        .prepare('SELECT hash FROM blob ORDER BY hash')
        .all()
        .map((row) => row.hash),
      ['shared-hash']
    )
    assert.deepEqual(
      result
        .prepare('SELECT session_id, hash FROM blob_ref ORDER BY session_id, hash')
        .all()
        .map((row) => [row.session_id, row.hash]),
      [['ses_v1_keep', 'shared-hash']]
    )
  } finally {
    result.close()
  }
})

test('OpenCode compact uses the config-root database without an override', async (t) => {
  const scratch = await createScratch(t)
  const fixture = await createOpenCodeFixture(scratch)
  const source = { id: fixture.source.id, kind: 'opencode', path: fixture.source.path }
  const compacted = request('compact', { source }, scratch)
  assert.equal(typeof compacted.fileBytesBefore, 'number')
  assert.equal(typeof compacted.fileBytesAfter, 'number')
  assert.deepEqual(
    sessionIds(request('scan', { source }, scratch)),
    [fixture.v1SessionId, fixture.v2SessionId].sort()
  )
})
test('OpenCode compact rejects an active WAL writer without dropping sessions', async (t) => {
  const scratch = await createScratch(t)
  const fixture = await createOpenCodeFixture(scratch)
  const database = new DatabaseSync(fixture.databasePath)
  let transactionStarted = false
  try {
    const journalMode = database.prepare('PRAGMA journal_mode=WAL').get().journal_mode
    assert.equal(journalMode, 'wal')
    database.exec('PRAGMA wal_autocheckpoint = 0')
    database.exec('BEGIN IMMEDIATE')
    transactionStarted = true
    database
      .prepare('UPDATE session SET title = ? WHERE id = ?')
      .run('Uncommitted title', fixture.v1SessionId)

    const response = requestResponse('compact', { source: fixture.source }, scratch)
    assert.equal(response.error, '数据库仍在使用，未执行整理，请关闭原工具后重试')
  } finally {
    try {
      if (transactionStarted) database.exec('ROLLBACK')
    } finally {
      database.close()
    }
  }
  assert.deepEqual(
    sessionIds(request('scan', { source: fixture.source }, scratch)),
    [fixture.v1SessionId, fixture.v2SessionId].sort()
  )
})

test('OpenCode uses the config-root database when databasePath is omitted', async (t) => {
  const scratch = await createScratch(t)
  const fixture = await createOpenCodeFixture(scratch)
  const source = { id: fixture.source.id, kind: 'opencode', path: fixture.source.path }
  const sessions = request('scan', { source }, scratch)
  assert.deepEqual(sessionIds(sessions), [fixture.v1SessionId, fixture.v2SessionId].sort())
  const target = findSession(sessions, fixture.v2SessionId)
  assert.equal(deleteSession(source, target, scratch).deleted, true)
  await assertPathMissing(fixture.legacyDuplicatePath)
  assert.deepEqual(sessionIds(request('scan', { source }, scratch)), [fixture.v1SessionId])
})

test('OpenCode honors an explicit custom databasePath', async (t) => {
  const scratch = await createScratch(t)
  const fixture = await createOpenCodeFixture(scratch)
  const databasePath = join(scratch, 'custom-storage', 'opencode-custom.db')
  await mkdir(dirname(databasePath), { recursive: true })
  await rename(fixture.databasePath, databasePath)
  const source = {
    id: fixture.source.id,
    kind: 'opencode',
    path: fixture.source.path,
    databasePath
  }
  const sessions = request('scan', { source }, scratch)
  assert.deepEqual(sessionIds(sessions), [fixture.v1SessionId, fixture.v2SessionId].sort())
  assert.equal(
    deleteSession(source, findSession(sessions, fixture.v2SessionId), scratch).deleted,
    true
  )
  await assertPathMissing(fixture.legacyDuplicatePath)
  assert.deepEqual(sessionIds(request('scan', { source }, scratch)), [fixture.v1SessionId])
})
test('OpenCode database-file source still resolves storage JSON copies', async (t) => {
  const scratch = await createScratch(t)
  const fixture = await createOpenCodeFixture(scratch)
  const source = { id: 'fixture-opencode-db-file', kind: 'opencode', path: fixture.databasePath }
  const sessions = request('scan', { source }, scratch)
  assert.deepEqual(sessionIds(sessions), [fixture.v1SessionId, fixture.v2SessionId].sort())
  assert.ok(findSession(sessions, fixture.v2SessionId).sourcePath.startsWith('sqlite:'))
  assert.equal(
    deleteSession(source, findSession(sessions, fixture.v2SessionId), scratch).deleted,
    true
  )
  await assertPathMissing(fixture.legacyDuplicatePath)
  assert.deepEqual(sessionIds(request('scan', { source }, scratch)), [fixture.v1SessionId])
})
test('Claude reads structured text and sidecar resources, deletes, then rescans empty', async (t) => {
  const scratch = await createScratch(t)
  const fixture = await createClaudeFixture(scratch)
  const sessions = request('scan', { source: fixture.source }, scratch)
  assert.equal(sessions.length, 1)
  const session = sessions[0]
  assert.equal(session.sessionId, fixture.sessionId)
  assert.equal(session.capabilities.delete, true)
  const details = request('read', { source: fixture.source, session }, scratch)
  assert.ok(
    details.messages.some(
      (message) => message.role === 'user' && message.content === fixture.userBody
    )
  )
  assert.ok(
    details.messages.some(
      (message) => message.role === 'assistant' && message.content.includes(fixture.assistantBody)
    )
  )
  const sidecar = details.messages
    .flatMap((message) => (Array.isArray(message.blocks) ? message.blocks : []))
    .find((block) => block.type === 'tool_result' && block.full?.kind === 'sidecar')
  assert.ok(sidecar)
  assert.ok(sidecar.savedPath.endsWith('toolu_fixture.txt'))
  const toolResult = request(
    'block',
    { source: fixture.source, session, contentRef: sidecar.full, offset: 0 },
    scratch
  )
  assert.ok(toolResult.text.includes('Claude persisted line 200'))
  assert.equal(deleteSession(fixture.source, session, scratch).deleted, true)
  await assertPathMissing(fixture.transcriptPath)
  await assertPathMissing(fixture.sidecarDirectory)
  assert.deepEqual(request('scan', { source: fixture.source }, scratch), [])
})

test('Codex removes plain and compressed rollouts plus matching thread-index rows', async (t) => {
  const scratch = await createScratch(t)
  const fixture = await createCodexFixture(scratch)
  const sessions = request('scan', { source: fixture.source }, scratch)
  assert.equal(sessions.length, 1, 'plain and compressed siblings must represent one session')
  const session = sessions[0]
  assert.equal(session.sessionId, fixture.sessionId)
  assert.equal(session.capabilities.delete, true)
  assert.deepEqual(messageShape(request('read', { source: fixture.source, session }, scratch)), [
    ['user', fixture.userBody]
  ])
  assert.equal(deleteSession(fixture.source, session, scratch).deleted, true)
  await assertPathMissing(fixture.rolloutPath)
  await assertPathMissing(fixture.compressedPath)
  assert.deepEqual(await readJsonl(fixture.sessionIndexPath), [
    { id: fixture.keepThreadId, thread_name: 'Unrelated Codex thread' }
  ])
  assert.equal(countCodexThreads(fixture.databasePath, fixture.sessionId), 0)
  assert.equal(countCodexThreads(fixture.databasePath, fixture.keepThreadId), 1)
  assert.deepEqual(request('scan', { source: fixture.source }, scratch), [])
})

test('Core rejects stale revisions and forged session IDs', async (t) => {
  const scratch = await createScratch(t)
  const fixture = await createClaudeFixture(scratch)
  const stale = request('scan', { source: fixture.source }, scratch)[0]
  await appendFile(
    fixture.transcriptPath,
    `${JSON.stringify({ type: 'progress', content: 'revision changed '.repeat(32) })}\n`,
    'utf8'
  )
  assertRejected(deleteResponse(fixture.source, stale, scratch), 'stale revision must be rejected')
  await assertPathExists(fixture.transcriptPath)

  const current = request('scan', { source: fixture.source }, scratch)[0]
  assertRejected(
    deleteResponse(fixture.source, { ...current, sessionId: 'forged-session-id' }, scratch),
    'forged session ID must be rejected'
  )
  await assertPathExists(fixture.transcriptPath)
})

test('Codex scan index snapshot never bypasses fresh mutation checks', async (t) => {
  const scratch = await createScratch(t)
  const fixture = await createCodexFixture(scratch)
  const session = findSession(
    request('scan', { source: fixture.source }, scratch),
    fixture.sessionId
  )
  await appendFile(
    fixture.sessionIndexPath,
    `${JSON.stringify({ id: fixture.sessionId, thread_name: 'changed after scan' })}\n`
  )
  assertRejected(
    deleteResponse(fixture.source, session, scratch),
    'changed Codex index must reject a revision obtained from the shared scan snapshot'
  )
  await assertPathExists(fixture.rolloutPath)
  await assertPathExists(fixture.compressedPath)
  assert.equal(countCodexThreads(fixture.databasePath, fixture.sessionId), 1)
})

test('Core rejects outside and linked paths', async (t) => {
  const scratch = await createScratch(t)
  const fixture = await createClaudeFixture(scratch)
  const outside = await createClaudeFixture(join(scratch, 'outside'), 'outside-session-fixture')
  const outsideSource = { ...outside.source, id: 'fixture-claude-outside' }
  const outsideSession = request('scan', { source: outsideSource }, scratch)[0]
  const forged = { ...outsideSession, sourceId: fixture.source.id }
  assertRejected(
    deleteResponse(fixture.source, forged, scratch),
    'outside source.path must be rejected'
  )
  await assertPathExists(outside.transcriptPath)

  const linkedDirectory = join(fixture.source.path, 'linked-outside')
  await symlink(
    dirname(outside.transcriptPath),
    linkedDirectory,
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  const linked = { ...forged, sourcePath: join(linkedDirectory, basename(outside.transcriptPath)) }
  assertRejected(deleteResponse(fixture.source, linked, scratch), 'linked path must be rejected')
  assert.deepEqual(sessionIds(request('scan', { source: fixture.source }, scratch)), [
    fixture.sessionId
  ])
  await assertPathExists(fixture.transcriptPath)
  await assertPathExists(outside.transcriptPath)
})

test('Gemini deletes the JSONL session and its migration JSON copy', async (t) => {
  const scratch = await createScratch(t)
  const fixture = (await createAdditionalDeleteProviderFixtures(scratch)).find(
    (entry) => entry.name === 'Gemini'
  )
  assert.ok(fixture)
  const session = findSession(
    request('scan', { source: fixture.source }, scratch),
    fixture.expectedSessionId
  )
  assert.ok(session.sourcePath.endsWith('.jsonl'))
  assert.equal(deleteSession(fixture.source, session, scratch).deleted, true)
  for (const path of fixture.deletedPaths) await assertPathMissing(path)
  assert.deepEqual(request('scan', { source: fixture.source }, scratch), [])
})

test('Gemini still deletes a legacy JSON-only session', async (t) => {
  const scratch = await createScratch(t)
  const sourceRoot = join(scratch, 'gemini', 'tmp')
  const chatDirectory = join(sourceRoot, 'fixture-project', 'chats')
  const sessionPath = join(chatDirectory, 'session-2026-10-29T10-00-legacy.json')
  const sessionId = 'gemini-legacy-session-fixture'
  await mkdir(chatDirectory, { recursive: true })
  await writeFile(
    sessionPath,
    JSON.stringify({ sessionId, startTime: '2026-10-29T00:00:00.000Z', messages: [] }),
    'utf8'
  )
  const source = { id: 'fixture-gemini-legacy', kind: 'gemini', path: sourceRoot }
  const session = findSession(request('scan', { source }, scratch), sessionId)
  assert.ok(session.sourcePath.endsWith('.json'))
  assert.equal(deleteSession(source, session, scratch).deleted, true)
  await assertPathMissing(sessionPath)
  assert.deepEqual(request('scan', { source }, scratch), [])
})
test('Other upstream providers with delete support remove only their temp fixture session', async (t) => {
  const scratch = await createScratch(t)
  const fixtures = await createAdditionalDeleteProviderFixtures(scratch)
  for (const fixture of fixtures) {
    const session = findSession(
      request('scan', { source: fixture.source }, scratch),
      fixture.expectedSessionId
    )
    assert.equal(
      session.capabilities.delete,
      true,
      `${fixture.name} should support deletion: ${session.capabilities.deleteReason ?? 'no reason returned'}`
    )
    assert.equal(deleteSession(fixture.source, session, scratch).deleted, true)
    for (const path of fixture.deletedPaths) await assertPathMissing(path)
    if (fixture.source.databasePath) {
      assert.deepEqual(countHermesRows(fixture.source.databasePath, fixture.expectedSessionId), {
        sessions: 0,
        messages: 0
      })
    }
    if (fixture.indexPath) {
      const index = await readFile(fixture.indexPath, 'utf8')
        .then(JSON.parse)
        .catch((error) => (error.code === 'ENOENT' ? {} : Promise.reject(error)))
      assert.ok(
        Object.values(index).every((entry) => entry.sessionId !== fixture.expectedSessionId)
      )
    }
    assert.deepEqual(request('scan', { source: fixture.source }, scratch), [])
  }
})
test('Kimi, MCode, and AGY never advertise session deletion', async (t) => {
  const scratch = await createScratch(t)
  for (const fixture of await createReadOnlyProviderFixtures(scratch)) {
    const sessions = request('scan', { source: fixture.source }, scratch)
    assert.equal(sessions.length, 1, `${fixture.name} fixture should be discovered`)
    const session = sessions[0]
    assert.equal(session.sessionId, fixture.expectedSessionId)
    assert.equal(session.capabilities.read, true)
    assert.equal(session.capabilities.delete, false)
    assertRejected(
      deleteResponse(fixture.source, session, scratch),
      `${fixture.name} deletion must fail`
    )
    await assertPathExists(fixture.protectedPath)
  }
})

function deleteResponse(source, session, scratch) {
  return requestResponse('delete', { source, session, revision: session.revision }, scratch)
}

function deleteSession(source, session, scratch) {
  return request('delete', { source, session, revision: session.revision }, scratch)
}

function request(method, params, scratch) {
  const response = requestResponse(method, params, scratch)
  if (response.error !== undefined) throw new Error(String(response.error))
  assert.ok(Object.hasOwn(response, 'result'), `${method} response must contain result`)
  return method === 'scan' ? response.result.sessions : response.result
}

function requestResponse(method, params, scratch) {
  assertPathsInsideScratch(params, scratch)
  const id = ++requestSequence
  const result = spawnSync(CORE_EXECUTABLE, [], {
    cwd: PROJECT_ROOT,
    env: isolatedEnvironment(scratch),
    input: `${JSON.stringify({ id, method, ...params })}\n`,
    encoding: 'utf8',
    maxBuffer: MAX_RESPONSE_BYTES,
    timeout: REQUEST_TIMEOUT_MS,
    windowsHide: true
  })
  assert.ifError(result.error, `cannot start ${CORE_EXECUTABLE}`)
  const lines = String(result.stdout ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim())
  assert.equal(
    lines.length,
    1,
    `${method} must return one protocol line; stderr: ${String(result.stderr ?? '').slice(0, 500)}`
  )
  const response = JSON.parse(lines[0])
  assert.equal(response.id, id)
  if (response.error === undefined) {
    assert.equal(
      result.status,
      0,
      `${method} exited ${result.status}; stderr: ${String(result.stderr ?? '').slice(0, 500)}`
    )
    assert.ok(Object.hasOwn(response, 'result'), `${method} response must contain result`)
  }
  return response
}

function normalizeWindowsExtendedPath(path) {
  if (process.platform !== 'win32') return path
  if (path.startsWith(WINDOWS_EXTENDED_UNC_PREFIX))
    return `${WINDOWS_UNC_PREFIX}${path.slice(WINDOWS_EXTENDED_UNC_PREFIX.length)}`
  return path.startsWith(WINDOWS_EXTENDED_PATH_PREFIX)
    ? path.slice(WINDOWS_EXTENDED_PATH_PREFIX.length)
    : path
}
function assertPathsInsideScratch(params, scratch) {
  for (const inputPath of [
    params.source?.path,
    params.source?.databasePath,
    params.session?.sourcePath
  ]) {
    if (typeof inputPath !== 'string' || /^(?:sqlite|mcode):/.test(inputPath)) continue
    const normalizedPath = normalizeWindowsExtendedPath(inputPath)
    const pathFromScratch = relative(resolve(scratch), resolve(normalizedPath))
    assert.ok(
      pathFromScratch === '' ||
        (pathFromScratch !== '..' &&
          !pathFromScratch.startsWith(`..${sep}`) &&
          !isAbsolute(pathFromScratch)),
      `test input path must stay under its owned scratch directory: ${inputPath}`
    )
  }
}

function assertRejected(response, message) {
  assert.ok(
    (typeof response.error === 'string' && response.error.length > 0) ||
      response.result?.deleted === false,
    message
  )
}

function findSession(sessions, sessionId) {
  const session = sessions.find((entry) => entry.sessionId === sessionId)
  assert.ok(session, `expected session ${sessionId}`)
  return session
}

function sessionIds(sessions) {
  return sessions.map((session) => session.sessionId).sort()
}

function messageShape(details) {
  assert.ok(Array.isArray(details.messages))
  return details.messages.map((message) => [message.role, message.content])
}

function countOpenCodeRows(databasePath, table, sessionId) {
  const queries = {
    session_v2: 'SELECT COUNT(*) AS count FROM session_v2 WHERE id = ?',
    session_message: 'SELECT COUNT(*) AS count FROM session_message WHERE session_id = ?'
  }
  assert.ok(queries[table], `unexpected OpenCode table ${table}`)
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    return Number(database.prepare(queries[table]).get(sessionId).count)
  } finally {
    database.close()
  }
}

function countHermesRows(databasePath, sessionId) {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    return {
      sessions: Number(
        database.prepare('SELECT COUNT(*) AS count FROM sessions WHERE id = ?').get(sessionId).count
      ),
      messages: Number(
        database
          .prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?')
          .get(sessionId).count
      )
    }
  } finally {
    database.close()
  }
}
function countCodexThreads(databasePath, threadId) {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    return Number(
      database.prepare('SELECT COUNT(*) AS count FROM threads WHERE id = ?').get(threadId).count
    )
  } finally {
    database.close()
  }
}

async function readJsonl(filePath) {
  return (await readFile(filePath, 'utf8'))
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
}

async function assertPathMissing(path) {
  await assert.rejects(access(path), { code: 'ENOENT' }, `expected ${path} to be removed`)
}

async function assertPathExists(path) {
  await access(path)
}

function isolatedEnvironment(scratch) {
  return {
    ...process.env,
    HOME: scratch,
    USERPROFILE: scratch,
    APPDATA: join(scratch, 'appdata'),
    LOCALAPPDATA: join(scratch, 'local-appdata'),
    TEMP: scratch,
    TMP: scratch,
    XDG_CONFIG_HOME: join(scratch, 'xdg-config'),
    XDG_DATA_HOME: join(scratch, 'xdg-data'),
    CODEX_HOME: join(scratch, 'codex-home'),
    CODEX_SQLITE_HOME: join(scratch, 'codex-sqlite'),
    CLAUDE_CONFIG_DIR: join(scratch, 'claude-config'),
    MINIMAX_DATA_DIR: join(scratch, 'minimax'),
    KIMI_CODE_HOME: join(scratch, 'kimi-code')
  }
}
