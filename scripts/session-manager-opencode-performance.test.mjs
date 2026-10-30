import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { readOpenCodeDatabaseUsage, readOpenCodeSessionUsage } from '../src/main/services/agents.ts'

const SESSION_ID = 'ses_v1_performance'
const SCRATCH_PREFIX = 'opencode-performance-'

test('OpenCode V1 filters unused rows and parses returned data once without hiding malformed JSON', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), SCRATCH_PREFIX))
  t.after(async () => {
    const target = path.resolve(directory)
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()))
    assert.ok(path.basename(target).startsWith(SCRATCH_PREFIX))
    await rm(target, { recursive: true, force: true })
  })

  const dbPath = path.join(directory, 'opencode.db')
  const timestamp = Date.now() - 1000
  const database = new DatabaseSync(dbPath)
  database.exec(`
    CREATE TABLE session(id TEXT PRIMARY KEY);
    CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER);
  `)
  database.prepare('INSERT INTO session(id) VALUES(?)').run(SESSION_ID)
  const insertMessage = database.prepare(
    'INSERT INTO message(id,session_id,data,time_created) VALUES(?,?,?,?)'
  )
  const tokens = { input: 5, output: 1 }
  const completedTime = { created: timestamp, completed: timestamp + 1 }

  for (let index = 0; index < 20; index += 1) {
    insertMessage.run(
      `user-${index}`,
      SESSION_ID,
      JSON.stringify({ role: 'user', tokens, time: completedTime }),
      timestamp
    )
    insertMessage.run(
      `assistant-no-tokens-${index}`,
      SESSION_ID,
      JSON.stringify({ role: 'assistant', time: completedTime }),
      timestamp
    )
    insertMessage.run(
      `assistant-incomplete-${index}`,
      SESSION_ID,
      JSON.stringify({ role: 'assistant', tokens, time: { created: timestamp } }),
      timestamp
    )
  }
  insertMessage.run('000-malformed', SESSION_ID, '{broken JSON', timestamp - 1)
  insertMessage.run(
    'valid-assistant',
    SESSION_ID,
    JSON.stringify({
      role: 'assistant',
      modelID: 'fixture-model',
      tokens: { input: 7, output: 2 },
      time: completedTime
    }),
    timestamp
  )
  database.close()

  const originalParse = JSON.parse
  let parseCount = 0
  JSON.parse = function (...args) {
    parseCount += 1
    return originalParse.apply(this, args)
  }
  let events
  try {
    events = await readOpenCodeDatabaseUsage(dbPath, timestamp - 10)
  } finally {
    JSON.parse = originalParse
  }

  assert.equal(events.length, 1)
  assert.equal(events[0].model, 'fixture-model')
  assert.equal(events[0].tokens.input, 7)
  assert.equal(parseCount, 2)
  await assert.rejects(
    readOpenCodeSessionUsage(dbPath, SESSION_ID),
    /OpenCode message.data 不是有效 JSON/
  )
  const updated = new DatabaseSync(dbPath)
  updated.prepare('DELETE FROM message WHERE id=?').run('000-malformed')
  updated.prepare('UPDATE message SET data=? WHERE id=?').run('null', 'user-0')
  updated.close()
  await assert.rejects(
    readOpenCodeSessionUsage(dbPath, SESSION_ID),
    /OpenCode message.data 不是有效 JSON/
  )
})
