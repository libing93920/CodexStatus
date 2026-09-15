/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import test from 'node:test'

import {
  dedupParsedFiles,
  parseSessionFile,
  parseSessionFileIncremental
} from '../src/main/services/codex-session-parser.ts'

const PARENT_ID = '11111111-1111-4111-8111-111111111111'
const CHILD_ID = '22222222-2222-4222-8222-222222222222'

function meta(id, timestamp, parent) {
  return JSON.stringify({
    type: 'session_meta',
    payload: { id, timestamp, ...(parent ? { forked_from_id: parent } : {}) }
  })
}

function turn(model) {
  return JSON.stringify({ type: 'turn_context', payload: { model } })
}

function token(timestamp, total) {
  return JSON.stringify({
    type: 'event_msg',
    timestamp,
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: total,
          cached_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
          total_tokens: total
        }
      }
    }
  })
}

async function tempFile(t, name, content) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-status-session-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = path.join(directory, name)
  await writeFile(filePath, content)
  return filePath
}

test('增量追加只读取新字节,并保留 highWater 与重复快照语义', async (t) => {
  const first =
    [
      meta(PARENT_ID, '2026-01-01T00:00:00.000Z'),
      turn('gpt-5.3-codex'),
      token('2026-01-01T00:00:01.000Z', 10),
      token('2026-01-01T00:00:02.000Z', 10)
    ].join('\n') + '\n'
  const appended = token('2026-01-01T00:00:03.000Z', 15) + '\n'
  const filePath = await tempFile(t, 'rollout-main.jsonl', first)

  const initial = await parseSessionFileIncremental(filePath, PARENT_ID)
  assert.ok(initial)
  await appendFile(filePath, appended)
  const incremental = await parseSessionFileIncremental(filePath, PARENT_ID, initial.state)
  const full = await parseSessionFileIncremental(filePath, PARENT_ID)

  assert.ok(incremental)
  assert.equal(incremental.bytesRead, Buffer.byteLength(appended))
  assert.deepEqual(incremental.state.parsed, full?.state.parsed)
  assert.deepEqual(
    incremental.state.parsed.events.map((event) => event.delta.total),
    [10, 0, 5]
  )
  assert.equal(incremental.bytesRead < (full?.bytesRead ?? 0), true)
})

test('跨扫描 UTF-8 半行在换行到达前不消费,补齐后正确解析', async (t) => {
  const metaLine = `${meta(PARENT_ID, '2026-01-01T00:00:00.000Z')}\n`
  const turnLine = turn('中文模型') + '\n'
  const tokenLine = token('2026-01-01T00:00:01.000Z', 7)
  const encodedTurn = Buffer.from(turnLine)
  const split = encodedTurn.indexOf(Buffer.from('中')) + 1
  const filePath = await tempFile(
    t,
    'rollout-utf8.jsonl',
    Buffer.concat([Buffer.from(metaLine), encodedTurn.subarray(0, split)])
  )

  const first = await parseSessionFileIncremental(filePath, PARENT_ID)
  assert.ok(first)
  assert.equal(first.state.parsed.events.length, 0)
  await appendFile(filePath, Buffer.concat([encodedTurn.subarray(split), Buffer.from(tokenLine)]))
  const second = await parseSessionFileIncremental(filePath, PARENT_ID, first.state)
  assert.ok(second)
  assert.equal(second.state.parsed.events.length, 0)
  await appendFile(filePath, '\n')
  const third = await parseSessionFileIncremental(filePath, PARENT_ID, second.state)
  assert.ok(third)
  assert.equal(third.state.parsed.events.length, 1)
  assert.equal(third.state.parsed.events[0].model, '中文模型')
})

test('文件截断替换后丢弃旧解析状态并重新解析', async (t) => {
  const oldContent =
    [
      meta(PARENT_ID, '2026-01-01T00:00:00.000Z'),
      token('2026-01-01T00:00:01.000Z', 10),
      token('2026-01-01T00:00:02.000Z', 20)
    ].join('\n') + '\n'
  const replacement =
    [meta(PARENT_ID, '2026-01-02T00:00:00.000Z'), token('2026-01-02T00:00:01.000Z', 7)].join('\n') +
    '\n'
  const filePath = await tempFile(t, 'rollout-replaced.jsonl', oldContent)
  const oldState = await parseSessionFileIncremental(filePath, PARENT_ID)
  assert.ok(oldState)
  assert.equal(oldState.state.parsed.events.length, 2)

  await writeFile(filePath, replacement)
  const next = await parseSessionFileIncremental(filePath, PARENT_ID, oldState.state)
  const full = await parseSessionFile(filePath, PARENT_ID)
  assert.ok(next)
  assert.deepEqual(next.state.parsed, full)
  assert.deepEqual(
    next.state.parsed.events.map((event) => event.delta.total),
    [7]
  )
})

test('父子去重在分段增量解析后与全量结果一致', async (t) => {
  const parentPrefix =
    [
      meta(PARENT_ID, '2026-01-01T00:00:00.000Z'),
      token('2026-01-01T00:00:01.000Z', 100),
      token('2026-01-01T00:00:02.000Z', 200)
    ].join('\n') + '\n'
  const parentSuffix = token('2026-01-01T00:00:06.000Z', 300) + '\n'
  const childPrefix =
    [
      meta(CHILD_ID, '2026-01-01T00:00:05.000Z', PARENT_ID),
      token('2026-01-01T00:00:05.100Z', 100),
      token('2026-01-01T00:00:05.200Z', 200)
    ].join('\n') + '\n'
  const childSuffix = token('2026-01-01T00:00:07.000Z', 999) + '\n'
  const parentPath = await tempFile(t, 'rollout-parent.jsonl', parentPrefix)
  const childPath = await tempFile(t, 'rollout-child.jsonl', childPrefix)

  const parentInitial = await parseSessionFileIncremental(parentPath, PARENT_ID)
  const childInitial = await parseSessionFileIncremental(childPath, CHILD_ID)
  assert.ok(parentInitial && childInitial)
  await appendFile(parentPath, parentSuffix)
  await appendFile(childPath, childSuffix)
  const parentIncremental = await parseSessionFileIncremental(
    parentPath,
    PARENT_ID,
    parentInitial.state
  )
  const childIncremental = await parseSessionFileIncremental(
    childPath,
    CHILD_ID,
    childInitial.state
  )
  assert.ok(parentIncremental && childIncremental)

  const incrementalEvents = dedupParsedFiles([
    { threadId: PARENT_ID, file: parentIncremental.state.parsed },
    { threadId: CHILD_ID, file: childIncremental.state.parsed }
  ])
  const parentFull = await parseSessionFile(parentPath, PARENT_ID)
  const childFull = await parseSessionFile(childPath, CHILD_ID)
  assert.ok(parentFull && childFull)
  const fullEvents = dedupParsedFiles([
    { threadId: PARENT_ID, file: parentFull },
    { threadId: CHILD_ID, file: childFull }
  ])
  assert.deepEqual(incrementalEvents, fullEvents)
  assert.deepEqual(
    incrementalEvents.map((event) => event.tokens.input),
    [100, 100, 100, 799]
  )
})

test('增量读取基准记录读取字节与耗时', async (t) => {
  const prefix = [meta(PARENT_ID, '2026-01-01T00:00:00.000Z')]
  for (let index = 0; index < 80; index++) {
    prefix.push(token(new Date(Date.UTC(2026, 0, 1) + (index + 1) * 1000).toISOString(), index + 1))
  }
  const filler = JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(1024) } })
  prefix.push(...Array(8192).fill(filler))
  const firstContent = prefix.join('\n') + '\n'
  const appended = token('2026-01-01T01:30:00.000Z', 1000) + '\n'
  const filePath = await tempFile(t, 'rollout-benchmark.jsonl', firstContent)
  const first = await parseSessionFileIncremental(filePath, PARENT_ID)
  assert.ok(first)
  await appendFile(filePath, appended)
  const startedAt = performance.now()
  const incremental = await parseSessionFileIncremental(filePath, PARENT_ID, first.state)
  const incrementalMs = performance.now() - startedAt
  const fullStartedAt = performance.now()
  const full = await parseSessionFileIncremental(filePath, PARENT_ID)
  const fullMs = performance.now() - fullStartedAt
  assert.ok(incremental && full)
  assert.equal(incremental.bytesRead, Buffer.byteLength(appended))
  assert.equal(incremental.bytesRead < full.bytesRead, true)
  assert.deepEqual(incremental.state.parsed, full.state.parsed)
  console.log(
    `[incremental benchmark] append=${incremental.bytesRead}B/full=${full.bytesRead}B ` +
      `append=${incrementalMs.toFixed(2)}ms/full=${fullMs.toFixed(2)}ms`
  )
})

test('无换行尾行保持原 parser 语义', async (t) => {
  const content = `${meta(PARENT_ID, '2026-01-01T00:00:00.000Z')}\n${token(
    '2026-01-01T00:00:01.000Z',
    7
  )}`
  const filePath = await tempFile(t, 'rollout-no-final-newline.jsonl', content)
  const parsed = await parseSessionFile(filePath, PARENT_ID)
  assert.ok(parsed)
  assert.equal(parsed.events.length, 0)
})

test('读到新事件后发生IO错误仍可回滚并正确重试', async (t) => {
  const content =
    [meta(PARENT_ID, '2026-01-01T00:00:00.000Z'), token('2026-01-01T00:00:01.000Z', 7)].join('\n') +
    '\n'
  const filePath = await tempFile(t, 'rollout-recovery.jsonl', content)
  const previous = await parseSessionFileIncremental(filePath, PARENT_ID)
  assert.ok(previous)
  const eventCount = previous.state.parsed.events.length
  const result = await parseSessionFileIncremental(`${filePath}.missing`, PARENT_ID, previous.state)
  assert.equal(result, undefined)
  assert.equal(previous.state.parsed.events.length, eventCount)
  assert.equal(previous.state.byteOffset, Buffer.byteLength(content))
  const appended = token('2026-01-01T00:00:02.000Z', 9) + '\n'
  await appendFile(filePath, appended)
  const before = structuredClone(previous.state)
  const originalOpen = fs.open
  const openMock = t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args)
    return {
      stat: () => handle.stat(),
      close: () => handle.close(),
      createReadStream: async function* () {
        yield Buffer.from(appended)
        throw new Error('injected read failure')
      }
    }
  })
  assert.equal(await parseSessionFileIncremental(filePath, PARENT_ID, previous.state), undefined)
  assert.deepEqual(previous.state.parsed, before.parsed)
  assert.equal(previous.state.byteOffset, before.byteOffset)
  openMock.mock.restore()
  const recovered = await parseSessionFileIncremental(filePath, PARENT_ID, previous.state)
  assert.deepEqual(
    recovered.state.parsed.events.map((event) => event.delta.total),
    [7, 2]
  )
})
