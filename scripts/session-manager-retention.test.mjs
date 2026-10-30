/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import test from 'node:test'

import {
  createOpenCodeMessageIdentity,
  createOpenCodeSessionRetentionKey,
  normalizeOpenCodeDatabasePath,
  OPENCODE_SCAN_WINDOW_MS,
  readOpenCodeDatabaseUsage,
  readOpenCodeSessionUsage
} from '../src/main/services/agents.ts'
import { dedupParsedFiles, parseSessionFile } from '../src/main/services/codex-session-parser.ts'
import {
  mergeRetainedCodex,
  mergeRetainedOpenCode,
  readRetainedUsage
} from '../src/main/services/usage-retention.ts'
import { retainManagedUsage } from '../src/main/tools/session-cleaner/managed-retention.ts'

const PARENT_ID = '11111111-1111-4111-8111-111111111111'
const CHILD_ID = '22222222-2222-4222-8222-222222222222'
const V2_SESSION_ID = 'ses_v2_fixture'
const V1_MIGRATED_SESSION_ID = 'ses_v1_migrated_fixture'
const MIGRATION_STAMP = Date.now() - 10 * 24 * 60 * 60 * 1000

function sessionMeta(threadId, timestamp, parentThreadId) {
  return JSON.stringify({
    type: 'session_meta',
    payload: {
      id: threadId,
      timestamp,
      ...(parentThreadId ? { forked_from_id: parentThreadId } : {})
    }
  })
}

function turnContext(model) {
  return JSON.stringify({ type: 'turn_context', payload: { model } })
}

function tokenCount(timestamp, totalTokens) {
  return JSON.stringify({
    type: 'event_msg',
    timestamp,
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: totalTokens,
          cached_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
          total_tokens: totalTokens
        }
      }
    }
  })
}

function managedSession(providerId, sessionId, sourcePath) {
  return {
    providerId,
    sourceId: `source-${providerId}`,
    sessionId,
    sourcePath,
    modelIds: [],
    capabilities: { read: true, delete: true, export: true, resume: false },
    storage: { kind: 'file', fileBytes: 0, sharedBytes: 0, complete: true },
    resourceIds: [],
    revision: 'fixture-revision'
  }
}

function sortUsageEvents(events) {
  return [...events].sort(
    (left, right) =>
      left.ts - right.ts || (left.messageId ?? '').localeCompare(right.messageId ?? '')
  )
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-status-session-manager-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

function usageData({
  model = 'fixture-model',
  input = 0,
  output = 0,
  reasoning = 0,
  cacheRead = 0,
  cacheWrite = 0,
  cost = 0,
  created,
  completed,
  status,
  role
}) {
  return JSON.stringify({
    ...(role ? { role } : {}),
    ...(status ? { status } : {}),
    model,
    cost,
    tokens: {
      input,
      output,
      reasoning,
      cache: { read: cacheRead, write: cacheWrite }
    },
    time: { created, ...(completed === undefined ? {} : { completed }) }
  })
}

function createOpenCodeSchema(database) {
  database.exec(`
    CREATE TABLE session(id TEXT PRIMARY KEY,title TEXT,directory TEXT,time_created INTEGER,time_updated INTEGER);
    CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT,time_created INTEGER,time_updated INTEGER);
    CREATE TABLE part(id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,data TEXT,time_created INTEGER,time_updated INTEGER);
    CREATE TABLE session_v2(id TEXT PRIMARY KEY,title TEXT,directory TEXT,time_created INTEGER,time_updated INTEGER);
    CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,data TEXT,time_created INTEGER,time_updated INTEGER);
    CREATE TABLE kv(key TEXT PRIMARY KEY,time_created INTEGER,time_updated INTEGER);
  `)
  database
    .prepare('INSERT INTO kv(key,time_created,time_updated) VALUES(?,?,?)')
    .run('migration.v1-v2', MIGRATION_STAMP, MIGRATION_STAMP)
}

test('Codex 压缩会话留存后保持父子去重，还原副本不重复', async (t) => {
  const directory = await temporaryDirectory(t)
  const sessionDirectory = path.join(directory, 'sessions')
  const retentionDirectory = path.join(directory, 'retained')
  await mkdir(sessionDirectory)
  const parentPath = path.join(sessionDirectory, `rollout-parent-${PARENT_ID}.jsonl`)
  const childTextPath = path.join(sessionDirectory, 'child-reference.jsonl')
  const childPath = path.join(sessionDirectory, `rollout-child-${CHILD_ID}.jsonl.zst`)
  const parentText =
    [
      sessionMeta(PARENT_ID, '2026-10-20T00:00:00.000Z'),
      turnContext('codex-parent-fixture'),
      tokenCount('2026-10-20T00:00:01.000Z', 100),
      tokenCount('2026-10-20T00:00:02.000Z', 200),
      tokenCount('2026-10-20T00:00:06.000Z', 300)
    ].join('\n') + '\n'
  const childText =
    [
      sessionMeta(CHILD_ID, '2026-10-20T00:00:05.000Z', PARENT_ID),
      turnContext('codex-child-fixture'),
      tokenCount('2026-10-20T00:00:05.100Z', 100),
      tokenCount('2026-10-20T00:00:05.200Z', 200),
      tokenCount('2026-10-20T00:00:07.000Z', 999)
    ].join('\n') + '\n'
  await writeFile(parentPath, parentText)
  await writeFile(childTextPath, childText)
  await writeFile(childPath, zstdCompressSync(await readFile(childTextPath)))

  const parent = await parseSessionFile(parentPath, PARENT_ID)
  const child = await parseSessionFile(childTextPath, CHILD_ID)
  assert.ok(parent && child)
  const before = sortUsageEvents(
    dedupParsedFiles([
      { threadId: PARENT_ID, file: parent },
      { threadId: CHILD_ID, file: child }
    ])
  )
  await retainManagedUsage({
    session: managedSession('codex', CHILD_ID, childPath),
    directory: retentionDirectory
  })

  const removedPath = path.join(sessionDirectory, 'deleted-child.jsonl.zst')
  await rename(childPath, removedPath)
  const retained = await readRetainedUsage('codex', retentionDirectory)
  const afterDelete = sortUsageEvents(
    dedupParsedFiles(mergeRetainedCodex([{ threadId: PARENT_ID, file: parent }], retained))
  )
  assert.deepEqual(afterDelete, before)

  await rename(removedPath, childPath)
  const restored = mergeRetainedCodex(
    [
      { threadId: PARENT_ID, file: parent },
      { threadId: CHILD_ID, file: child }
    ],
    retained
  )
  assert.deepEqual(sortUsageEvents(dedupParsedFiles(restored)), before)
})

test('OpenCode V1/V2 留存保留完整事件，删除与还原均按库和消息身份去重', async (t) => {
  const directory = await temporaryDirectory(t)
  const dbPath = path.join(directory, 'opencode.db')
  const retentionDirectory = path.join(directory, 'retained')
  const now = Date.now()
  const firstData = usageData({
    model: { id: 'fixture-v2-model', providerID: 'provider', variant: 'fast' },
    input: 7,
    output: 3,
    reasoning: 2,
    cacheRead: 4,
    cacheWrite: 5,
    cost: 0.125,
    created: now - 3 * 24 * 60 * 60 * 1000,
    completed: now - 3 * 24 * 60 * 60 * 1000 + 5000
  })
  const compactionData = usageData({
    model: { id: 'fixture-compaction-model' },
    input: 1,
    cacheRead: 2,
    cost: 0.01,
    created: now - 2 * 24 * 60 * 60 * 1000,
    status: 'completed'
  })
  const failedCompactionData = usageData({
    model: 'fixture-failed-compaction-model',
    output: 4,
    created: now - 24 * 60 * 60 * 1000,
    status: 'failed'
  })
  const v1DuplicateData = usageData({
    model: 'stale-v1-copy',
    input: 999,
    cost: 0.999,
    created: now - 3 * 24 * 60 * 60 * 1000,
    completed: now - 3 * 24 * 60 * 60 * 1000 + 5000,
    role: 'assistant'
  })
  const v1OnlyData = usageData({
    model: 'fixture-v1-model',
    input: 13,
    output: 8,
    cost: 0.034,
    created: now - 4 * 24 * 60 * 60 * 1000,
    completed: now - 4 * 24 * 60 * 60 * 1000 + 2000,
    role: 'assistant'
  })
  const v2Messages = [
    ['msg-v2-assistant', 'assistant', firstData, now - 3 * 86400000],
    ['msg-v2-compaction', 'compaction', compactionData, now - 2 * 86400000],
    ['msg-v2-failed-compaction', 'compaction', failedCompactionData, now - 86400000],
    [
      'msg-v2-pending-assistant',
      'assistant',
      usageData({ input: 200, created: now, model: { id: 'pending' } }),
      now
    ],
    [
      'msg-v2-pending-compaction',
      'compaction',
      usageData({ input: 200, created: now, status: 'running' }),
      now
    ],
    ['msg-v2-user', 'user', usageData({ input: 500, created: now, completed: now }), now]
  ]

  const database = new DatabaseSync(dbPath)
  createOpenCodeSchema(database)
  const insertSession = database.prepare(
    'INSERT INTO session(id,title,directory,time_created,time_updated) VALUES(?,?,?,?,?)'
  )
  const insertV2Session = database.prepare(
    'INSERT INTO session_v2(id,title,directory,time_created,time_updated) VALUES(?,?,?,?,?)'
  )
  const insertV1Message = database.prepare(
    'INSERT INTO message(id,session_id,data,time_created,time_updated) VALUES(?,?,?,?,?)'
  )
  const insertV2Message = database.prepare(
    'INSERT INTO session_message(id,session_id,type,data,time_created,time_updated) VALUES(?,?,?,?,?,?)'
  )
  insertSession.run(V2_SESSION_ID, 'legacy duplicate', '/legacy', now, now)
  insertSession.run(V1_MIGRATED_SESSION_ID, 'migrated V1', '/v1', now, now)
  insertV2Session.run(V2_SESSION_ID, 'V2 source', '/v2', now, now)
  for (const [id, type, data, created] of v2Messages) {
    insertV2Message.run(id, V2_SESSION_ID, type, data, created, now)
  }
  insertV1Message.run('msg-v2-assistant', V2_SESSION_ID, v1DuplicateData, now - 3 * 86400000, now)
  insertV1Message.run('msg-v1-only', V1_MIGRATED_SESSION_ID, v1OnlyData, now - 4 * 86400000, now)
  database.close()

  const cutoffMs = Date.now() - OPENCODE_SCAN_WINDOW_MS
  const before = await readOpenCodeDatabaseUsage(dbPath, cutoffMs)
  assert.equal(before.length, 4)
  assert.equal(
    before.some((event) => event.model === 'stale-v1-copy'),
    false
  )
  const originalEvent = before.find((event) => event.messageId?.endsWith(':msg-v2-assistant'))
  assert.ok(originalEvent)
  assert.equal(originalEvent.model, 'fixture-v2-model')
  assert.equal(originalEvent.tokens.input, 16)
  assert.equal(originalEvent.tokens.cachedInput, 9)
  assert.equal(originalEvent.tokens.cacheCreation, 5)
  assert.equal(originalEvent.tokens.output, 5)
  assert.equal(originalEvent.tokens.reasoning, 2)
  assert.equal(originalEvent.costUsd, 0.125)

  await retainManagedUsage({
    session: managedSession('opencode', V2_SESSION_ID, `sqlite:${dbPath}:${V2_SESSION_ID}`),
    directory: retentionDirectory
  })
  const retainedSources = await readRetainedUsage('opencode', retentionDirectory)
  assert.equal(retainedSources.length, 1)
  assert.equal(retainedSources[0].key, createOpenCodeSessionRetentionKey(dbPath, V2_SESSION_ID))
  assert.ok(retainedSources[0].key.includes(normalizeOpenCodeDatabasePath(dbPath)))
  assert.deepEqual(
    sortUsageEvents(retainedSources[0].events),
    sortUsageEvents(before.filter((event) => !event.messageId?.endsWith(':msg-v1-only')))
  )

  const writer = new DatabaseSync(dbPath)
  writer.prepare('DELETE FROM session_message WHERE session_id=?').run(V2_SESSION_ID)
  writer.prepare('DELETE FROM session_v2 WHERE id=?').run(V2_SESSION_ID)
  writer.close()
  const liveAfterDelete = await readOpenCodeDatabaseUsage(dbPath, cutoffMs)
  const afterDelete = mergeRetainedOpenCode(
    liveAfterDelete,
    retainedSources.flatMap((source) => source.events ?? []),
    cutoffMs
  )
  assert.deepEqual(sortUsageEvents(afterDelete), sortUsageEvents(before))

  const restoredWriter = new DatabaseSync(dbPath)
  restoredWriter
    .prepare(
      'INSERT INTO session_v2(id,title,directory,time_created,time_updated) VALUES(?,?,?,?,?)'
    )
    .run(V2_SESSION_ID, 'restored V2 source', '/v2', now, now)
  const restoreMessage = restoredWriter.prepare(
    'INSERT INTO session_message(id,session_id,type,data,time_created,time_updated) VALUES(?,?,?,?,?,?)'
  )
  for (const [id, type, data, created] of v2Messages.slice(0, 3)) {
    restoreMessage.run(id, V2_SESSION_ID, type, data, created, now)
  }
  restoredWriter.close()
  const liveAfterRestore = await readOpenCodeDatabaseUsage(dbPath, cutoffMs)
  const afterRestore = mergeRetainedOpenCode(
    liveAfterRestore,
    retainedSources.flatMap((source) => source.events ?? []),
    cutoffMs
  )
  assert.deepEqual(sortUsageEvents(afterRestore), sortUsageEvents(before))

  const expired = { ...originalEvent, ts: cutoffMs - 1, messageId: 'outside-window' }
  assert.equal(mergeRetainedOpenCode([], [expired], cutoffMs).length, 0)
  assert.equal(createOpenCodeMessageIdentity(dbPath, 'msg-v2-assistant'), originalEvent.messageId)
})

test('OpenCode V1-only 数据库可留存；缺表或缺会话时显式失败', async (t) => {
  const directory = await temporaryDirectory(t)
  const dbPath = path.join(directory, 'opencode-v1.db')
  const retentionDirectory = path.join(directory, 'retained')
  const now = Date.now()
  const database = new DatabaseSync(dbPath)
  database.exec(`
    CREATE TABLE session(id TEXT PRIMARY KEY,title TEXT,directory TEXT,time_created INTEGER,time_updated INTEGER);
    CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT,time_created INTEGER,time_updated INTEGER);
    CREATE TABLE part(id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,data TEXT,time_created INTEGER,time_updated INTEGER);
  `)
  database
    .prepare('INSERT INTO session(id,title,directory,time_created,time_updated) VALUES(?,?,?,?,?)')
    .run('ses_v1_only', 'V1', '/v1', now, now)
  database
    .prepare('INSERT INTO message(id,session_id,data,time_created,time_updated) VALUES(?,?,?,?,?)')
    .run(
      'msg-v1',
      'ses_v1_only',
      usageData({ role: 'assistant', input: 12, created: now, completed: now + 1 }),
      now,
      now
    )
  database.close()

  await retainManagedUsage({
    session: managedSession('opencode', 'ses_v1_only', `sqlite:${dbPath}:ses_v1_only`),
    directory: retentionDirectory
  })
  const retained = await readRetainedUsage('opencode', retentionDirectory)
  assert.equal(retained[0].events?.[0].tokens.input, 12)
  assert.equal(retained[0].events?.[0].messageId, createOpenCodeMessageIdentity(dbPath, 'msg-v1'))
  await assert.rejects(
    retainManagedUsage({
      session: managedSession('opencode', 'missing', `sqlite:${dbPath}:missing`),
      directory: retentionDirectory
    }),
    /不存在指定的 V1 会话/
  )

  const emptyDatabasePath = path.join(directory, 'empty.db')
  new DatabaseSync(emptyDatabasePath).close()
  await assert.rejects(
    readOpenCodeSessionUsage(emptyDatabasePath, 'ses_unknown'),
    /缺少已验证的 V1 或 V2 会话表结构/
  )
})
