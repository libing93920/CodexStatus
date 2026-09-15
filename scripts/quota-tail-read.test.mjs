/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  extractLatestRateLimitSnapshot,
  readLatestRateLimitSnapshot
} from '../src/main/services/quota.ts'

function tokenCountLine(timestamp, usedPercent) {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: usedPercent, window_minutes: 300 }
      }
    }
  })
}

test('提取多行内容中的最后一条额度快照(会话按时间顺序追加)', () => {
  const content = [
    tokenCountLine('2026-09-14T01:00:00Z', 10),
    JSON.stringify({ timestamp: '2026-09-14T02:00:00Z', type: 'event_msg', payload: { type: 'agent_message' } }),
    tokenCountLine('2026-09-14T02:30:00Z', 20),
    tokenCountLine('2026-09-14T03:00:00Z', 30)
  ].join('\n')
  const snapshot = extractLatestRateLimitSnapshot(content)
  assert.ok(snapshot)
  assert.equal(snapshot.timestamp.toISOString(), '2026-09-14T03:00:00.000Z')
  assert.equal(snapshot.primary?.usedPercent, 30)
})

test('无 token_count 行返回 undefined', () => {
  const content = [
    JSON.stringify({ timestamp: '2026-09-14T01:00:00Z', type: 'event_msg', payload: { type: 'agent_message' } }),
    ''
  ].join('\n')
  assert.equal(extractLatestRateLimitSnapshot(content), undefined)
})

test('尾部读文件:快照在文件末尾时直接命中(不回退全量)', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-tail-'))
  const filePath = path.join(directory, 'session.jsonl')
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  // 构造 >4MB 文件:头部大量无关行 + 尾部最新快照
  const filler = JSON.stringify({ padding: 'x'.repeat(64) })
  const lines = Array.from({ length: 70_000 }, () => filler)
  lines.push(tokenCountLine('2026-09-14T05:00:00Z', 55))
  await fs.writeFile(filePath, lines.join('\n'), 'utf8')
  const snapshot = await readLatestRateLimitSnapshot(filePath)
  assert.ok(snapshot)
  assert.equal(snapshot.timestamp.toISOString(), '2026-09-14T05:00:00.000Z')
  assert.equal(snapshot.primary?.usedPercent, 55)
})

test('尾部读回退:快照只在文件头部时仍能读出(语义保守)', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-tail-'))
  const filePath = path.join(directory, 'session.jsonl')
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const filler = JSON.stringify({ padding: 'x'.repeat(64) })
  const lines = [tokenCountLine('2026-09-14T01:00:00Z', 8)]
  lines.push(...Array.from({ length: 70_000 }, () => filler))
  await fs.writeFile(filePath, lines.join('\n'), 'utf8')
  const snapshot = await readLatestRateLimitSnapshot(filePath)
  assert.ok(snapshot)
  assert.equal(snapshot.timestamp.toISOString(), '2026-09-14T01:00:00.000Z')
  assert.equal(snapshot.primary?.usedPercent, 8)
})

test('小文件整读不受影响', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-tail-'))
  const filePath = path.join(directory, 'session.jsonl')
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  await fs.writeFile(
    filePath,
    [tokenCountLine('2026-09-14T09:00:00Z', 42)].join('\n'),
    'utf8'
  )
  const snapshot = await readLatestRateLimitSnapshot(filePath)
  assert.ok(snapshot)
  assert.equal(snapshot.primary?.usedPercent, 42)
})

test('乱序时间戳仍取最后有效记录，大文件尾读与全读一致', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-tail-unordered-'))
  const filePath = path.join(directory, 'session.jsonl')
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const newer = tokenCountLine('2026-09-14T10:00:00Z', 99)
  const older = tokenCountLine('2026-09-14T08:00:00Z', 7)
  const filler = `${JSON.stringify({ padding: 'x'.repeat(1024) })}\n`
  const content = `${newer}\n${filler.repeat(6100)}${older}\n`
  await fs.writeFile(filePath, content, 'utf8')
  const full = extractLatestRateLimitSnapshot(content)
  assert.equal(full?.timestamp.toISOString(), '2026-09-14T08:00:00.000Z')
  assert.equal(full?.primary?.usedPercent, 7)
  assert.deepEqual(extractLatestRateLimitSnapshot(`${newer}\n${older}\n`), full)
  assert.deepEqual(await readLatestRateLimitSnapshot(filePath), full)
})
