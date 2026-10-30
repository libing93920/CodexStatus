/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { mkdtemp, rm, appendFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  appendCleanerRecord,
  loadCleanerConfig,
  loadCleanerRecords,
  saveCleanerConfig,
  validateCleanerSettings
} from '../src/main/tools/session-cleaner/store.ts'
import { DEFAULT_CLEANER_SETTINGS } from '../src/shared/session-cleaner.ts'

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cleaner-store-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('工具配置独立保存，损坏时不静默恢复默认并丢失保护', async (t) => {
  const directory = await temporaryDirectory(t)
  const config = await loadCleanerConfig(directory)
  config.protectedIds.push('protected-session')
  await saveCleanerConfig(directory, config)
  assert.deepEqual(await loadCleanerConfig(directory), config)
  await writeFile(path.join(directory, 'config.json'), '{broken')
  await assert.rejects(loadCleanerConfig(directory))
})

test('策略不能把候选期限设置到近期保留期限以内', () => {
  assert.throws(() => validateCleanerSettings({ ...DEFAULT_CLEANER_SETTINGS, olderSessionDays: 1 }))
  assert.throws(() => validateCleanerSettings({ ...DEFAULT_CLEANER_SETTINGS, keepRecentDays: 0 }))
  assert.throws(() => validateCleanerSettings({ ...DEFAULT_CLEANER_SETTINGS, alertGiB: Infinity }))
})

test('操作先记录pending，成功结果按同一id覆盖，未完成保持待核对', async (t) => {
  const directory = await temporaryDirectory(t)
  const record = {
    id: 'operation',
    batchId: 'batch',
    sourceId: 'source',
    title: 'fixture',
    path: path.join(directory, 'fixture.jsonl'),
    bytes: 10,
    at: Date.now(),
    status: 'pending'
  }
  await appendCleanerRecord(directory, record)
  const interrupted = await loadCleanerRecords(directory)
  assert.equal(interrupted.records[0].status, 'pending')
  assert.match(interrupted.records[0].reason, /待人工核对/)
  await appendCleanerRecord(directory, { ...record, status: 'recycled' })
  const completed = await loadCleanerRecords(directory)
  assert.equal(completed.records.length, 1)
  assert.equal(completed.records[0].status, 'recycled')
})

test('中断的日志尾部明确标记不完整，保留此前可读记录', async (t) => {
  const directory = await temporaryDirectory(t)
  const record = {
    id: 'operation',
    batchId: 'batch',
    sourceId: 'source',
    title: 'fixture',
    path: path.join(directory, 'fixture.jsonl'),
    bytes: 10,
    at: Date.now(),
    status: 'pending'
  }
  await appendCleanerRecord(directory, record)
  await appendFile(path.join(directory, 'operations.jsonl'), '{"id":')
  const result = await loadCleanerRecords(directory)
  assert.equal(result.incompleteTail, true)
  assert.equal(result.records.length, 1)
  assert.equal(result.records[0].status, 'pending')
})
