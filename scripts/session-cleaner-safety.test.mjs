/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, utimes, link, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DEFAULT_CLEANER_SETTINGS } from '../src/shared/session-cleaner.ts'
import { fingerprintFile, scanSources } from '../src/main/tools/session-cleaner/scanner.ts'
import {
  assertOwnedFile,
  isWithinRoot,
  retainItemUsage,
  validateRecycleItem
} from '../src/main/tools/session-cleaner/safety.ts'

const SESSION_ID = '11111111-1111-4111-8111-111111111111'
const OLD_TIME = new Date(Date.now() - 120 * 86_400_000)

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cleaner-safety-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const filePath = path.join(root, `${SESSION_ID}.jsonl`)
  const content =
    JSON.stringify({
      type: 'assistant',
      sessionId: SESSION_ID,
      timestamp: OLD_TIME.toISOString(),
      message: {
        id: 'message-id',
        model: 'claude-sonnet',
        usage: { input_tokens: 10, output_tokens: 2 }
      }
    }) + '\n'
  await writeFile(filePath, content)
  await utimes(filePath, OLD_TIME, OLD_TIME)
  const source = {
    id: 'fixture',
    kind: 'claude',
    path: root,
    name: 'Claude fixture',
    origin: 'manual',
    capability: 'sessions',
    note: ''
  }
  const item = {
    id: 'fixture-session',
    sourceId: source.id,
    title: 'fixture',
    path: filePath,
    sessionId: SESSION_ID,
    bytes: Buffer.byteLength(content),
    modifiedAt: +OLD_TIME,
    category: 'sessions',
    status: 'candidate',
    reason: '',
    files: [filePath],
    fingerprint: await fingerprintFile(filePath)
  }
  return { root, source, item, content }
}

test('相似目录前缀、来源本身及来源外文件不能回收', async (t) => {
  const { root, source, item } = await fixture(t)
  assert.equal(isWithinRoot(root, `${root}-outside/file.jsonl`), false)
  assert.equal(isWithinRoot(root, root), false)
  const changed = {
    ...item,
    path: path.join(root, '..', 'outside.jsonl'),
    files: [path.join(root, '..', 'outside.jsonl')]
  }
  await assert.rejects(
    validateRecycleItem({ source, item: changed, settings: DEFAULT_CLEANER_SETTINGS }),
    /来源目录/
  )
})

test('内容被改写但恢复mtime时指纹仍拒绝旧审核', async (t) => {
  const { source, item, content } = await fixture(t)
  await writeFile(item.path, content.replace('input_tokens":10', 'input_tokens":11'))
  await utimes(item.path, OLD_TIME, OLD_TIME)
  await assert.rejects(
    validateRecycleItem({ source, item, settings: DEFAULT_CLEANER_SETTINGS }),
    /文件已变化/
  )
})

test('关联目录出现、文件被保护、共享数据库均不能执行回收', async (t) => {
  const { source, item } = await fixture(t)
  await mkdir(item.path.replace(/\.jsonl$/, ''))
  await assert.rejects(
    validateRecycleItem({ source, item, settings: DEFAULT_CLEANER_SETTINGS }),
    /关联资源目录/
  )
  await assert.rejects(
    validateRecycleItem({
      source,
      item: { ...item, status: 'protected' },
      settings: DEFAULT_CLEANER_SETTINGS
    }),
    /已验证/
  )
  await assert.rejects(
    validateRecycleItem({
      source: { ...source, kind: 'codex' },
      item,
      settings: DEFAULT_CLEANER_SETTINGS
    }),
    /尚未验证/
  )
})

test('硬链接不被当作独立文件处理', async (t) => {
  const { source, item, root } = await fixture(t)
  await link(item.path, path.join(root, 'alias.jsonl'))
  await assert.rejects(assertOwnedFile(source, item.path), /硬链接/)
})

test('无法稳定去重的Claude用量不允许留存后删除', async (t) => {
  const { source, item, content, root } = await fixture(t)
  await writeFile(item.path, content.replace('"id":"message-id",', ''))
  await utimes(item.path, OLD_TIME, OLD_TIME)
  item.fingerprint = await fingerprintFile(item.path)
  await assert.rejects(
    retainItemUsage({ source, item, directory: path.join(root, 'history') }),
    /缺少去重身份/
  )
})

test('硬链接只计算一次占用，更换来源根仍保留文件保护', async (t) => {
  const { source, item, root } = await fixture(t)
  const first = await scanSources({
    sources: [source],
    settings: DEFAULT_CLEANER_SETTINGS,
    protectedIds: []
  })
  assert.equal(first.items.length, 1)
  const protectedId = first.items[0].id
  const changedSource = { ...source, id: 'different-registration', kind: 'unknown' }
  const changed = await scanSources({
    sources: [changedSource],
    settings: DEFAULT_CLEANER_SETTINGS,
    protectedIds: [protectedId]
  })
  assert.equal(changed.items[0].id, protectedId)
  assert.equal(changed.items[0].status, 'protected')
  await link(item.path, path.join(root, 'alias.jsonl'))
  const linked = await scanSources({
    sources: [changedSource],
    settings: DEFAULT_CLEANER_SETTINGS,
    protectedIds: []
  })
  assert.equal(linked.items.length, 1)
  assert.equal(
    linked.items.reduce((sum, entry) => sum + entry.bytes, 0),
    item.bytes
  )
  assert.ok(linked.issues.some((issue) => issue.message.includes('未重复计算')))
})

test('拼接的Pi会话和未验证的格式版本保持只读', async (t) => {
  const { source, item } = await fixture(t)
  const piSource = { ...source, kind: 'pi', layout: 'flat' }
  const headers = [
    { type: 'session', version: 3, id: SESSION_ID },
    { type: 'session', version: 3, id: 'another-session' }
  ]
  await writeFile(item.path, headers.map((header) => JSON.stringify(header)).join('\n') + '\n')
  await utimes(item.path, OLD_TIME, OLD_TIME)
  item.fingerprint = await fingerprintFile(item.path)
  const scan = await scanSources({
    sources: [piSource],
    settings: DEFAULT_CLEANER_SETTINGS,
    protectedIds: []
  })
  assert.equal(scan.items[0].status, 'read-only')
  await assert.rejects(
    validateRecycleItem({ source: piSource, item, settings: DEFAULT_CLEANER_SETTINGS }),
    /多个会话头/
  )
  await writeFile(item.path, JSON.stringify({ ...headers[0], version: 999 }) + '\n')
  await utimes(item.path, OLD_TIME, OLD_TIME)
  item.fingerprint = await fingerprintFile(item.path)
  await assert.rejects(
    validateRecycleItem({ source: piSource, item, settings: DEFAULT_CLEANER_SETTINGS }),
    /身份不匹配/
  )
})

test('无效 UTF-8 的 Pi 记录不能被替换字符伪装成可回收会话', async (t) => {
  const { source, item } = await fixture(t)
  const piSource = { ...source, kind: 'pi', layout: 'flat' }
  const header = JSON.stringify({ type: 'session', version: 3, id: SESSION_ID }) + '\n'
  await writeFile(
    item.path,
    Buffer.concat([
      Buffer.from(header + '{"type":"message","message":{"role":"user","content":"'),
      Buffer.from([0xff]),
      Buffer.from('"}}\n')
    ])
  )
  await utimes(item.path, OLD_TIME, OLD_TIME)
  item.fingerprint = await fingerprintFile(item.path)
  const result = await scanSources({
    sources: [piSource],
    settings: DEFAULT_CLEANER_SETTINGS,
    protectedIds: []
  })
  assert.equal(
    result.items.some((entry) => entry.status === 'candidate'),
    false
  )
  assert.ok(result.issues.some((issue) => issue.path === item.path))
  await assert.rejects(
    validateRecycleItem({ source: piSource, item, settings: DEFAULT_CLEANER_SETTINGS }),
    /utf-8|encoded data/i
  )
})

test(
  '扫描后新增的同名junction会使回收校验失败',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const { source, item, root } = await fixture(t)
    const target = path.join(root, 'owned-resources')
    await mkdir(target)
    await symlink(target, item.path.replace(/\.jsonl$/, ''), 'junction')
    await assert.rejects(
      validateRecycleItem({ source, item, settings: DEFAULT_CLEANER_SETTINGS }),
      /关联资源目录或链接/
    )
  }
)
