/* eslint-disable @typescript-eslint/explicit-function-return-type */
// 所有 JSONL 与 SQLite 文件只写入 mkdtemp 目录，不读取真实用户会话。
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { parseClaudeFile } from '../src/main/services/agents.ts'
import { dedupClaudeEvents, getTokenUsageRange } from '../src/main/services/usage.ts'
import { dedupParsedFiles, parseSessionFile } from '../src/main/services/codex-session-parser.ts'
import {
  configureUsageRetention,
  getUsageRetentionDirectory,
  mergeRetainedCodex,
  readRetainedUsage,
  retainUsageSource
} from '../src/main/services/usage-retention.ts'

const PARENT_ID = '11111111-1111-4111-8111-111111111111'
const CHILD_ID = '22222222-2222-4222-8222-222222222222'
const DATABASE_FILE_NAME = 'retained-usage.sqlite'
const UNKNOWN_DATABASE_VERSION = 999

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

function sortEventsByTimestamp(events) {
  return [...events].sort((left, right) => left.ts - right.ts)
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-status-retention-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function createCodexFixture(t) {
  const directory = await temporaryDirectory(t)
  const sessionDirectory = path.join(directory, 'sessions')
  await mkdir(sessionDirectory)

  const parentPath = path.join(sessionDirectory, `rollout-parent-${PARENT_ID}.jsonl`)
  const childPath = path.join(sessionDirectory, `rollout-child-${CHILD_ID}.jsonl`)
  const parentLines = [
    sessionMeta(PARENT_ID, '2026-01-01T00:00:00.000Z'),
    turnContext('codex-parent-fixture'),
    tokenCount('2026-01-01T00:00:01.000Z', 100),
    tokenCount('2026-01-01T00:00:02.000Z', 200),
    tokenCount('2026-01-01T00:00:06.000Z', 300)
  ]
  const childLines = [
    sessionMeta(CHILD_ID, '2026-01-01T00:00:05.000Z', PARENT_ID),
    turnContext('codex-child-fixture'),
    tokenCount('2026-01-01T00:00:05.100Z', 100),
    tokenCount('2026-01-01T00:00:05.200Z', 200),
    tokenCount('2026-01-01T00:00:07.000Z', 999)
  ]
  await writeFile(parentPath, `${parentLines.join('\n')}\n`)
  await writeFile(childPath, `${childLines.join('\n')}\n`)

  const parent = await parseSessionFile(parentPath, PARENT_ID)
  const child = await parseSessionFile(childPath, CHILD_ID)
  assert.ok(parent && child)
  return { directory, parentPath, childPath, parent, child }
}

function claudeAssistantLine({
  messageId,
  timestamp,
  model,
  inputTokens,
  outputTokens,
  stopReason
}) {
  const message = {
    id: messageId,
    model,
    usage: {
      input_tokens: inputTokens,
      cache_read_input_tokens: 0,
      output_tokens: outputTokens
    }
  }
  if (stopReason) message.stop_reason = stopReason
  return JSON.stringify({ type: 'assistant', timestamp, message })
}

test('Codex 留存后移走源文件仍保持父子去重，父还原后不重复', async (t) => {
  const fixture = await createCodexFixture(t)
  const before = sortEventsByTimestamp(
    dedupParsedFiles([
      { threadId: PARENT_ID, file: fixture.parent },
      { threadId: CHILD_ID, file: fixture.child }
    ])
  )
  assert.deepEqual(
    before.map((event) => event.tokens.input),
    [100, 100, 100, 799]
  )

  const retentionDirectory = path.join(fixture.directory, 'retained')
  const quarantineDirectory = path.join(fixture.directory, 'quarantine')
  await mkdir(quarantineDirectory)
  await retainUsageSource(retentionDirectory, {
    key: `codex:${PARENT_ID}`,
    agent: 'codex',
    path: fixture.parentPath,
    threadId: PARENT_ID,
    parsed: fixture.parent
  })
  await retainUsageSource(retentionDirectory, {
    key: `codex:${CHILD_ID}`,
    agent: 'codex',
    path: fixture.childPath,
    threadId: CHILD_ID,
    parsed: fixture.child
  })

  const quarantinedParent = path.join(quarantineDirectory, path.basename(fixture.parentPath))
  const quarantinedChild = path.join(quarantineDirectory, path.basename(fixture.childPath))
  await rename(fixture.parentPath, quarantinedParent)
  await rename(fixture.childPath, quarantinedChild)
  const retained = await readRetainedUsage('codex', retentionDirectory)
  assert.equal(retained.length, 2)
  const afterCleanup = sortEventsByTimestamp(dedupParsedFiles(mergeRetainedCodex([], retained)))
  assert.deepEqual(afterCleanup, before)

  await rename(quarantinedParent, fixture.parentPath)
  const restoredParent = await parseSessionFile(fixture.parentPath, PARENT_ID)
  assert.ok(restoredParent)
  const restoredSources = mergeRetainedCodex(
    [{ threadId: PARENT_ID, file: restoredParent }],
    retained
  )
  assert.equal(restoredSources.length, 2)
  assert.deepEqual(sortEventsByTimestamp(dedupParsedFiles(restoredSources)), before)
})

test('留存保留自定义事件时间、模型、token 与计费字段', async (t) => {
  const directory = await temporaryDirectory(t)
  const retentionDirectory = path.join(directory, 'retained')
  const event = {
    ts: Date.parse('2026-05-06T07:08:09.123Z'),
    model: 'custom-model-variant',
    tokens: {
      input: 81,
      cachedInput: 23,
      output: 17,
      reasoning: 7,
      total: 98,
      cacheCreation: 5
    },
    costUsd: 0.004321987,
    messageId: 'msg-retained-custom'
  }
  const source = {
    key: 'claude:custom-event',
    agent: 'claude',
    path: path.join(directory, 'custom-session.jsonl'),
    events: [event]
  }

  await retainUsageSource(retentionDirectory, source)
  const retained = await readRetainedUsage('claude', retentionDirectory)
  assert.deepEqual(retained, [source])
})

test('Claude 跨文件重复 messageId 保留 token 用量较大的事件', async (t) => {
  const directory = await temporaryDirectory(t)
  const sessionsDirectory = path.join(directory, 'claude-sessions')
  const retentionDirectory = path.join(directory, 'retained')
  await mkdir(sessionsDirectory)
  const fixtures = [
    {
      fileName: 'session-a.jsonl',
      messageId: 'msg-shared-across-files',
      timestamp: '2026-05-06T07:08:09.000Z',
      model: 'claude-model-before',
      inputTokens: 20,
      outputTokens: 5
    },
    {
      fileName: 'session-b.jsonl',
      messageId: 'msg-shared-across-files',
      timestamp: '2026-05-06T07:09:10.000Z',
      model: 'claude-model-final',
      inputTokens: 20,
      outputTokens: 12,
      stopReason: 'end_turn'
    }
  ]
  const parsedEvents = []
  for (const fixture of fixtures) {
    const filePath = path.join(sessionsDirectory, fixture.fileName)
    await writeFile(filePath, `${claudeAssistantLine(fixture)}\n`)
    const events = await parseClaudeFile(filePath)
    assert.equal(events.length, 1)
    parsedEvents.push(events[0])
    await retainUsageSource(retentionDirectory, {
      key: `claude:${fixture.fileName}`,
      agent: 'claude',
      path: filePath,
      events
    })
  }

  const retained = await readRetainedUsage('claude', retentionDirectory)
  const deduped = dedupClaudeEvents(retained.flatMap((source) => source.events ?? []))
  assert.deepEqual(deduped, [parsedEvents[1]])
})

test('重复 retainUsageSource 写入同一个 key 保持幂等', async (t) => {
  const fixture = await createCodexFixture(t)
  const retentionDirectory = path.join(fixture.directory, 'retained')
  const source = {
    key: `codex:${PARENT_ID}`,
    agent: 'codex',
    path: fixture.parentPath,
    threadId: PARENT_ID,
    parsed: fixture.parent
  }

  await retainUsageSource(retentionDirectory, source)
  await retainUsageSource(retentionDirectory, source)
  const retained = await readRetainedUsage('codex', retentionDirectory)
  assert.equal(retained.length, 1)
  assert.deepEqual(retained, [JSON.parse(JSON.stringify(source))])
})

test('损坏的 SQLite 文件不会伪装成空历史', async (t) => {
  const directory = await temporaryDirectory(t)
  await writeFile(path.join(directory, DATABASE_FILE_NAME), 'not a SQLite database')
  await assert.rejects(readRetainedUsage('codex', directory))
})

test('损坏的留存 payload 会报错而非返回空历史', async (t) => {
  const directory = await temporaryDirectory(t)
  await retainUsageSource(directory, {
    key: 'claude:corrupt-payload',
    agent: 'claude',
    path: path.join(directory, 'session.jsonl'),
    events: []
  })
  const database = new DatabaseSync(path.join(directory, DATABASE_FILE_NAME))
  try {
    database.prepare('UPDATE retained_sources SET payload = ?').run('{')
  } finally {
    database.close()
  }
  await assert.rejects(readRetainedUsage('claude', directory), SyntaxError)
})

test('未知留存版本会报错而非返回空历史', async (t) => {
  const directory = await temporaryDirectory(t)
  await retainUsageSource(directory, {
    key: 'codex:unknown-version',
    agent: 'codex',
    path: path.join(directory, 'session.jsonl'),
    threadId: PARENT_ID,
    parsed: {
      parent: undefined,
      deferred: false,
      rootTs: undefined,
      events: [],
      hasTokenWithoutTimestamp: false,
      maxTimestamp: undefined
    }
  })
  const database = new DatabaseSync(path.join(directory, DATABASE_FILE_NAME))
  try {
    database.prepare('UPDATE retained_sources SET version = ?').run(UNKNOWN_DATABASE_VERSION)
  } finally {
    database.close()
  }
  await assert.rejects(readRetainedUsage('codex', directory), /用量留存格式版本不受支持/)
})
function isolateUsageEnvironment(t, directory) {
  const previousCodexHome = process.env.CODEX_HOME
  const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
  const codexHome = path.join(directory, 'codex-home')
  const claudeConfigDirectory = path.join(directory, 'claude-config')
  process.env.CODEX_HOME = codexHome
  process.env.CLAUDE_CONFIG_DIR = claudeConfigDirectory
  t.after(() => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousCodexHome
    if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir
  })
  return { codexHome, claudeConfigDirectory }
}

async function createClaudeRangeFixture(t) {
  const directory = await temporaryDirectory(t)
  const environment = isolateUsageEnvironment(t, directory)
  const retentionDirectory = path.join(directory, 'retained')
  const previousRetentionDirectory = getUsageRetentionDirectory()
  configureUsageRetention(retentionDirectory)
  t.after(() => configureUsageRetention(previousRetentionDirectory ?? ''))

  const projectsDirectory = path.join(environment.claudeConfigDirectory, 'projects', 'fixture')
  await mkdir(environment.codexHome, { recursive: true })
  await mkdir(projectsDirectory, { recursive: true })
  const now = Date.now()
  const livePath = path.join(projectsDirectory, 'live-session.jsonl')
  const sharedMessageId = 'msg-range-shared'
  const liveLine = claudeAssistantLine({
    messageId: sharedMessageId,
    timestamp: new Date(now - 15_000).toISOString(),
    model: 'claude-live-fixture',
    inputTokens: 20,
    outputTokens: 5
  })
  await writeFile(livePath, `${liveLine}\n`)
  const fileMtime = new Date()
  await utimes(livePath, fileMtime, fileMtime)

  const retainedEvents = [
    {
      ts: now - 20_000,
      model: 'claude-retained-fixture',
      tokens: {
        input: 80,
        cachedInput: 20,
        output: 12,
        reasoning: 0,
        total: 92,
        cacheCreation: 5
      },
      costUsd: 0.125,
      messageId: sharedMessageId
    },
    {
      ts: now - 10_000,
      model: 'claude-history-only-fixture',
      tokens: { input: 7, cachedInput: 0, output: 3, reasoning: 0, total: 10 },
      costUsd: 0.25,
      messageId: 'msg-range-history-only'
    }
  ]
  await retainUsageSource(retentionDirectory, {
    key: 'claude:range-history',
    agent: 'claude',
    path: path.join(directory, 'archived-session.jsonl'),
    events: retainedEvents
  })
  return {
    startMs: now - 60_000,
    endMs: now + 60_000,
    expectedTotals: {
      input: 87,
      cachedInput: 20,
      output: 15,
      reasoning: 0,
      total: 102,
      cost: 0.375
    }
  }
}

test('live Codex 父会话覆盖多条同 threadId 留存摘要', async (t) => {
  const fixture = await createCodexFixture(t)
  const expected = sortEventsByTimestamp(
    dedupParsedFiles([
      { threadId: PARENT_ID, file: fixture.parent },
      { threadId: CHILD_ID, file: fixture.child }
    ])
  )
  const retentionDirectory = path.join(fixture.directory, 'retained')
  const archivedSources = [
    {
      key: `codex:${PARENT_ID}:summary-a`,
      agent: 'codex',
      path: path.join(fixture.directory, 'summary-a.jsonl'),
      threadId: PARENT_ID,
      parsed: fixture.parent
    },
    {
      key: `codex:${PARENT_ID}:summary-b`,
      agent: 'codex',
      path: path.join(fixture.directory, 'summary-b.jsonl'),
      threadId: PARENT_ID,
      parsed: fixture.parent
    },
    {
      key: `codex:${CHILD_ID}`,
      agent: 'codex',
      path: fixture.childPath,
      threadId: CHILD_ID,
      parsed: fixture.child
    }
  ]
  for (const source of archivedSources) await retainUsageSource(retentionDirectory, source)

  const retained = await readRetainedUsage('codex', retentionDirectory)
  assert.equal(retained.filter((source) => source.threadId === PARENT_ID).length, 2)
  const merged = mergeRetainedCodex([{ threadId: PARENT_ID, file: fixture.parent }], retained)
  assert.equal(merged.filter((source) => source.threadId === PARENT_ID).length, 1)
  assert.deepEqual(sortEventsByTimestamp(dedupParsedFiles(merged)), expected)
})

test('getTokenUsageRange 把隔离环境中的 Claude 留存与 live 事件合并去重', async (t) => {
  const fixture = await createClaudeRangeFixture(t)
  const overview = await getTokenUsageRange('claude', fixture.startMs, fixture.endMs)
  assert.equal(overview.available, true)
  assert.deepEqual(overview.totals, fixture.expectedTotals)
})
