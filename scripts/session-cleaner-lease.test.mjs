import assert from 'node:assert/strict'
import { mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { acquireRecycleLease } from '../src/main/tools/session-cleaner/file-lease.ts'

test(
  'Windows 回收保护支持中文路径，阻止写入并允许改名',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cleaner-lease-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const original = path.join(directory, '会话.jsonl')
    const moved = path.join(directory, '已移动.jsonl')
    await writeFile(original, 'fixture\n')
    const lease = await acquireRecycleLease(original)
    try {
      lease.assertHeld()
      await assert.rejects(open(original, 'a'), /EPERM|EACCES|EBUSY/)
      await rename(original, moved)
      assert.equal(await readFile(moved, 'utf8'), 'fixture\n')
    } finally {
      lease.release()
    }
  }
)

test('已有写入句柄时回收保护明确失败', { skip: process.platform !== 'win32' }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cleaner-held-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = path.join(directory, 'session.jsonl')
  await writeFile(filePath, 'fixture\n')
  const writer = await open(filePath, 'a')
  try {
    await assert.rejects(acquireRecycleLease(filePath), /文件正被使用|无法取得/)
  } finally {
    await writer.close()
  }
})
