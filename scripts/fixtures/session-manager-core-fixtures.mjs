/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const OPEN_CODE_MIGRATION_TIME = 2_000
const FIXTURE_TIME = '2026-10-29T00:00:00.000Z'
const CLAUDE_CWD = '/fixture/claude-project'
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const ZSTD_SINGLE_SEGMENT_DESCRIPTOR = 0x20
const ZSTD_MAX_RAW_BLOCK_BYTES = 128 * 1024
const ZSTD_ONE_BYTE_CONTENT_SIZE_LIMIT = 255
const OPEN_CODE_SCHEMA_SQL = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT NOT NULL, directory TEXT NOT NULL,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
  CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
    data TEXT NOT NULL, FOREIGN KEY(session_id) REFERENCES session(id) ON DELETE CASCADE);
  CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, message_id TEXT NOT NULL,
    time_created INTEGER NOT NULL, data TEXT NOT NULL,
    FOREIGN KEY(session_id) REFERENCES session(id) ON DELETE CASCADE,
    FOREIGN KEY(message_id) REFERENCES message(id) ON DELETE CASCADE);
  CREATE TABLE session_v2 (id TEXT PRIMARY KEY, title TEXT, directory TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
  CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
    seq INTEGER NOT NULL, data TEXT NOT NULL, time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    FOREIGN KEY(session_id) REFERENCES session_v2(id) ON DELETE CASCADE);
  CREATE TABLE kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
`

export async function createOpenCodeFixture(root) {
  const base = join(root, 'opencode')
  const databasePath = join(base, 'opencode.db')
  const v1SessionId = 'ses_v1_keep'
  const v2SessionId = 'ses_v2_delete'
  const v1Body = 'OpenCode V1 preserved body'
  const v2Body = 'OpenCode V2 body <img src=x>'
  const legacyDuplicatePath = join(base, 'storage', 'session', 'project-v2', `${v2SessionId}.json`)
  await mkdir(base, { recursive: true })
  createOpenCodeDatabase(databasePath, { v1SessionId, v1Body, v2SessionId, v2Body })
  await writeJson(legacyDuplicatePath, {
    id: v2SessionId,
    title: 'OpenCode V2 legacy copy',
    directory: '/fixture/v2',
    time: { created: 5_000, updated: 6_000 }
  })
  return {
    source: { id: 'fixture-opencode', kind: 'opencode', path: base, databasePath },
    databasePath,
    v1SessionId,
    v1Body,
    v2SessionId,
    v2Body,
    legacyDuplicatePath
  }
}

function createOpenCodeDatabase(databasePath, { v1SessionId, v1Body, v2SessionId, v2Body }) {
  const database = new DatabaseSync(databasePath)
  try {
    database.exec(OPEN_CODE_SCHEMA_SQL)
    insert(
      database,
      'INSERT INTO kv VALUES (?, ?, ?, ?)',
      'migration.v1-v2',
      '{"phase":"completed"}',
      1_900,
      OPEN_CODE_MIGRATION_TIME
    )
    insert(
      database,
      'INSERT INTO session VALUES (?, ?, ?, ?, ?)',
      v1SessionId,
      'OpenCode V1 keep',
      '/fixture/v1',
      2_800,
      4_000
    )
    insert(
      database,
      'INSERT INTO message VALUES (?, ?, ?, ?)',
      'msg_v1_keep',
      v1SessionId,
      2_800,
      '{"role":"user"}'
    )
    insert(
      database,
      'INSERT INTO part VALUES (?, ?, ?, ?, ?)',
      'prt_v1_keep',
      v1SessionId,
      'msg_v1_keep',
      2_800,
      JSON.stringify({ type: 'text', text: v1Body })
    )
    insert(
      database,
      'INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?)',
      v2SessionId,
      'OpenCode V2 delete',
      '/fixture/v2',
      5_000,
      6_000
    )
    insert(
      database,
      'INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)',
      'msg_v2_delete',
      v2SessionId,
      'user',
      1,
      JSON.stringify({ text: v2Body }),
      5_000,
      6_000
    )
  } finally {
    database.close()
  }
}

export function failNextOpenCodeV2Delete(databasePath) {
  const database = new DatabaseSync(databasePath)
  try {
    database.exec(`CREATE TRIGGER fail_v2_session_delete BEFORE DELETE ON session_v2
      BEGIN SELECT RAISE(ABORT, 'injected rollback evidence'); END;`)
  } finally {
    database.close()
  }
}

export function restoreOpenCodeV2Delete(databasePath) {
  const database = new DatabaseSync(databasePath)
  try {
    database.exec('DROP TRIGGER fail_v2_session_delete')
  } finally {
    database.close()
  }
}

export async function createClaudeFixture(root, sessionId = 'claude-session-fixture') {
  const projectsRoot = join(root, 'claude-projects')
  const projectDir = join(projectsRoot, '-fixture-project')
  const transcriptPath = join(projectDir, `${sessionId}.jsonl`)
  const sidecarDirectory = transcriptPath.slice(0, -'.jsonl'.length)
  const toolResultPath = join(sidecarDirectory, 'tool-results', 'toolu_fixture.txt')
  const userBody = 'Claude user body <img src=x>'
  const assistantBody = 'Claude assistant body'
  const toolOutput = Array.from(
    { length: 200 },
    (_, index) => `Claude persisted line ${index + 1}`
  ).join('\n')

  await Promise.all([
    mkdir(dirname(transcriptPath), { recursive: true }),
    mkdir(dirname(toolResultPath), { recursive: true }),
    mkdir(join(sidecarDirectory, 'subagents'), { recursive: true })
  ])
  await Promise.all([
    writeFile(toolResultPath, toolOutput, 'utf8'),
    writeFile(join(sidecarDirectory, 'subagents', 'agent-fixture.jsonl'), '{}\n', 'utf8'),
    writeJsonl(transcriptPath, [
      claudeRecord(sessionId, 'user', 'user-fixture', null, {
        role: 'user',
        content: [{ type: 'text', text: userBody }]
      }),
      claudeRecord(sessionId, 'assistant', 'assistant-fixture', 'user-fixture', {
        id: 'msg_fixture',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'text', text: assistantBody },
          {
            type: 'tool_use',
            id: 'toolu_fixture',
            name: 'Bash',
            input: { command: 'cat fixture-output.txt' }
          }
        ],
        stop_reason: 'tool_use'
      }),
      claudeRecord(
        sessionId,
        'user',
        'tool-result-fixture',
        'assistant-fixture',
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_fixture', content: toolOutput }]
        },
        {
          toolUseResult: {
            stdout: toolOutput,
            stderr: '',
            interrupted: true,
            persistedOutputPath: toolResultPath
          }
        }
      )
    ])
  ])
  return {
    source: { id: 'fixture-claude', kind: 'claude', path: projectsRoot, layout: 'projects' },
    sessionId,
    transcriptPath,
    sidecarDirectory,
    toolResultPath,
    userBody,
    assistantBody
  }
}

function claudeRecord(sessionId, type, uuid, parentUuid, message, extra = {}) {
  return {
    type,
    uuid,
    parentUuid,
    sessionId,
    timestamp: FIXTURE_TIME,
    cwd: CLAUDE_CWD,
    message,
    ...extra
  }
}

export async function createCodexFixture(root) {
  const configRoot = join(root, 'codex')
  const sessionRoot = join(configRoot, 'sessions')
  const sessionId = '12345678-9abc-4def-8123-456789abcdef'
  const keepThreadId = 'abcdef01-2345-6789-abcd-ef0123456789'
  const rolloutPath = join(sessionRoot, '2026', '10', '29', `rollout-${sessionId}.jsonl`)
  const compressedPath = `${rolloutPath}.zst`
  const sessionIndexPath = join(configRoot, 'session_index.jsonl')
  const databasePath = join(configRoot, 'state_5.sqlite')
  const userBody = 'Codex body <img src=x>'
  const rollout = await writeJsonl(rolloutPath, [
    {
      timestamp: FIXTURE_TIME,
      type: 'session_meta',
      payload: { id: sessionId, cwd: '/fixture/codex-project' }
    },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: userBody } }
  ])
  await writeFile(compressedPath, encodeOneBlockZstd(rollout))
  await writeJsonl(sessionIndexPath, [
    { id: sessionId, thread_name: 'Codex legacy index title' },
    { id: keepThreadId, thread_name: 'Unrelated Codex thread' }
  ])
  createCodexDatabase(databasePath, sessionId, keepThreadId, userBody)
  return {
    source: { id: 'fixture-codex', kind: 'codex', path: sessionRoot, databasePath },
    sessionId,
    keepThreadId,
    rolloutPath,
    compressedPath,
    sessionIndexPath,
    databasePath,
    userBody
  }
}

function createCodexDatabase(databasePath, sessionId, keepThreadId, userBody) {
  const database = new DatabaseSync(databasePath)
  try {
    database.exec(
      'CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, first_user_message TEXT NOT NULL)'
    )
    const insertThread = database.prepare('INSERT INTO threads VALUES (?, ?, ?)')
    insertThread.run(sessionId, 'Codex state index title', userBody)
    insertThread.run(keepThreadId, 'Unrelated state title', 'Unrelated prompt')
  } finally {
    database.close()
  }
}

export async function createReadOnlyProviderFixtures(root) {
  return Promise.all([createKimiFixture(root), createMCodeFixture(root), createAgyFixture(root)])
}

export async function createAdditionalDeleteProviderFixtures(root) {
  return Promise.all([
    createOpenClawDeleteFixture(root),
    createGeminiDeleteFixture(root),
    createGrokBuildDeleteFixture(root),
    createHermesDeleteFixture(root),
    createTreeDeleteFixture(root, 'pi'),
    createTreeDeleteFixture(root, 'omp')
  ])
}

async function createOpenClawDeleteFixture(root) {
  const agentsRoot = join(root, 'openclaw', 'agents')
  const sessionId = 'openclaw-session-fixture'
  const sessionsDir = join(agentsRoot, 'main', 'sessions')
  const sessionPath = join(sessionsDir, `${sessionId}.jsonl`)
  const indexPath = join(sessionsDir, 'sessions.json')
  await writeJsonl(sessionPath, [
    { type: 'session', id: sessionId, cwd: '/fixture/openclaw', timestamp: FIXTURE_TIME },
    {
      type: 'message',
      message: { role: 'user', content: 'OpenClaw fixture' },
      timestamp: FIXTURE_TIME
    }
  ])
  await writeJson(indexPath, {
    'agent:main:main': { sessionId, displayName: 'OpenClaw fixture', sessionFile: sessionPath }
  })
  return deleteFixture('OpenClaw', 'openclaw', agentsRoot, sessionId, [sessionPath], { indexPath })
}

async function createGeminiDeleteFixture(root) {
  const sessionRoot = join(root, 'gemini', 'tmp')
  const sessionId = 'gemini-session-fixture'
  const chats = join(sessionRoot, 'fixture-project', 'chats')
  const transcriptPath = join(chats, 'session-2026-10-29T10-00-fixture.jsonl')
  const legacyPath = transcriptPath.replace(/\.jsonl$/, '.json')
  await writeJsonl(transcriptPath, [
    {
      sessionId,
      projectHash: 'fixture-project',
      startTime: FIXTURE_TIME,
      lastUpdated: FIXTURE_TIME
    },
    {
      id: 'gemini-message',
      timestamp: FIXTURE_TIME,
      type: 'user',
      content: [{ text: 'Gemini fixture' }]
    }
  ])
  await writeJson(legacyPath, {
    sessionId,
    startTime: FIXTURE_TIME,
    lastUpdated: FIXTURE_TIME,
    messages: []
  })
  return deleteFixture('Gemini', 'gemini', sessionRoot, sessionId, [transcriptPath, legacyPath])
}

async function createGrokBuildDeleteFixture(root) {
  const sessionRoot = join(root, 'grokbuild', 'sessions')
  const sessionId = 'grokbuild-session-fixture'
  const sessionDirectory = join(sessionRoot, 'encoded-project', sessionId)
  const summaryPath = join(sessionDirectory, 'summary.json')
  await writeJson(summaryPath, {
    info: { id: sessionId, cwd: '/fixture/grokbuild' },
    generated_title: 'GrokBuild fixture',
    session_summary: 'GrokBuild fixture summary'
  })
  return deleteFixture('Grok Build', 'grokbuild', sessionRoot, sessionId, [sessionDirectory])
}

async function createHermesDeleteFixture(root) {
  const dataDirectory = join(root, 'hermes')
  const sessionId = 'hermes-session-fixture'
  const databasePath = join(dataDirectory, 'state.db')
  await mkdir(dataDirectory, { recursive: true })
  const database = new DatabaseSync(databasePath)
  try {
    database.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, cwd TEXT, title TEXT, started_at REAL NOT NULL,
        ended_at REAL, last_activity_at REAL
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL,
        active INTEGER NOT NULL DEFAULT 1, compacted INTEGER NOT NULL DEFAULT 0, display_metadata TEXT
      );
    `)
    database
      .prepare(
        'INSERT INTO sessions (id, cwd, title, started_at, last_activity_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(sessionId, '/fixture/hermes', 'Hermes fixture', 1_700_000_000, 1_700_000_001)
    database
      .prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
      .run(sessionId, 'user', 'Hermes fixture body', 1_700_000_000.5)
  } finally {
    database.close()
  }
  return deleteFixture('Hermes', 'hermes', dataDirectory, sessionId, [], { databasePath })
}
async function createTreeDeleteFixture(root, kind) {
  const sessionRoot = join(root, kind, 'sessions')
  const sessionId = `${kind}-session-fixture`
  const sessionPath = join(sessionRoot, `${sessionId}.jsonl`)
  await writeJsonl(sessionPath, [
    {
      type: 'session',
      version: 3,
      id: sessionId,
      cwd: `/fixture/${kind}`,
      createdAt: FIXTURE_TIME
    },
    {
      type: 'message',
      id: 'message-1',
      parentId: null,
      timestamp: FIXTURE_TIME,
      message: { role: 'user', content: [{ type: 'text', text: `${kind} fixture body` }] }
    }
  ])
  return deleteFixture(
    kind === 'pi' ? 'Pi' : 'Oh My Pi',
    kind,
    sessionRoot,
    sessionId,
    [sessionPath],
    {
      layout: 'flat'
    }
  )
}

function deleteFixture(name, kind, path, sessionId, deletedPaths, extraSourceFields = {}) {
  const { indexPath, ...sourceFields } = extraSourceFields
  return {
    name,
    expectedSessionId: sessionId,
    deletedPaths,
    ...(indexPath ? { indexPath } : {}),
    source: { id: `fixture-${kind}`, kind, path, ...sourceFields }
  }
}
async function createKimiFixture(root) {
  const sessionsRoot = join(root, 'kimi-code', 'sessions')
  const sessionId = 'session-kimi-fixture'
  const sessionDirectory = join(sessionsRoot, 'wd_project_123', sessionId)
  const wirePath = join(sessionDirectory, 'agents', 'main', 'wire.jsonl')
  await mkdir(dirname(wirePath), { recursive: true })
  await writeJson(join(sessionDirectory, 'state.json'), {
    title: 'Kimi fixture',
    cwd: '/fixture/kimi-project',
    lastPrompt: 'Kimi read-only fixture',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000
  })
  await writeJsonl(wirePath, [
    { type: 'metadata', protocol_version: '1.5' },
    {
      type: 'agent.message.appended',
      message: {
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Kimi read-only fixture' }]
        }
      }
    }
  ])
  return {
    name: 'Kimi',
    expectedSessionId: sessionId,
    protectedPath: wirePath,
    source: { id: 'fixture-kimi', kind: 'kimi', path: sessionsRoot }
  }
}

async function createMCodeFixture(root) {
  const dataDirectory = join(root, 'minimax')
  const databasePath = join(dataDirectory, 'v2', 'sqlite', 'runtime-state.sqlite')
  const sessionId = 'mvs_fixture_readonly'
  await mkdir(dirname(databasePath), { recursive: true })
  const database = new DatabaseSync(databasePath)
  try {
    database.exec(`CREATE TABLE local_runtime_sessions (
      session_id TEXT, title TEXT, workspace_dir TEXT, created_at_ms INTEGER, updated_at_ms INTEGER,
      visibility TEXT, parent_session_id TEXT, session_kind TEXT, archived INTEGER);`)
    database
      .prepare('INSERT INTO local_runtime_sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        sessionId,
        'MCode fixture',
        '/fixture/minimax-project',
        1_700_000_000_000,
        1_700_000_001_000,
        'visible',
        null,
        'conversation',
        0
      )
  } finally {
    database.close()
  }
  return {
    name: 'MCode',
    expectedSessionId: sessionId,
    protectedPath: databasePath,
    databasePath,
    source: { id: 'fixture-mcode', kind: 'mcode', path: dataDirectory, databasePath }
  }
}

async function createAgyFixture(root) {
  const brainRoot = join(root, 'antigravity-cli', 'brain')
  const sessionId = 'agy-fixture-1'
  const transcriptPath = join(
    brainRoot,
    sessionId,
    '.system_generated',
    'logs',
    'transcript_full.jsonl'
  )
  await writeJsonl(transcriptPath, [
    {
      step_index: 0,
      type: 'USER_INPUT',
      content: '<USER_REQUEST>AGY read-only fixture</USER_REQUEST>'
    }
  ])
  return {
    name: 'AGY',
    expectedSessionId: sessionId,
    protectedPath: transcriptPath,
    source: { id: 'fixture-agy', kind: 'agy', path: brainRoot }
  }
}

async function writeJson(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(value)}\n`, 'utf8')
}

async function writeJsonl(filePath, records) {
  await mkdir(dirname(filePath), { recursive: true })
  const text = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
  await writeFile(filePath, text, 'utf8')
  return text
}

function insert(database, sql, ...values) {
  database.prepare(sql).run(...values)
}

function encodeOneBlockZstd(text) {
  const payload = Buffer.from(text, 'utf8')
  assert.ok(payload.length <= ZSTD_ONE_BYTE_CONTENT_SIZE_LIMIT)
  assert.ok(payload.length <= ZSTD_MAX_RAW_BLOCK_BYTES)
  const blockHeader = (payload.length << 3) | 1
  return Buffer.concat([
    ZSTD_MAGIC,
    Buffer.from([ZSTD_SINGLE_SEGMENT_DESCRIPTOR, payload.length]),
    Buffer.from([blockHeader & 0xff, (blockHeader >> 8) & 0xff, (blockHeader >> 16) & 0xff]),
    payload
  ])
}
