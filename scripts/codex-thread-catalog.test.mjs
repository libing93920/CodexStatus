import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseThreadCatalogResult,
  parseThreadListResult
} from '../src/main/services/codex-thread-catalog.ts'

test('目录响应只保留合法任务 ID', () => {
  const ids = parseThreadListResult({
    id: 2,
    result: { data: [{ id: 'thread-1', title: 'private' }, { id: '' }, null, { id: 'thread-2' }] }
  })
  assert.deepEqual(ids, ['thread-1', 'thread-2'])
})

test('非目录响应被忽略，目录错误不泄露服务端内容', () => {
  assert.equal(parseThreadListResult({ id: 1, result: {} }), undefined)
  assert.throws(
    () => parseThreadListResult({ id: 2, error: { message: 'sensitive' } }),
    /^Error: Codex thread catalog failed$/
  )
})

test('目录响应保留 CLI/Desktop 来源，未知来源安全降级', () => {
  assert.deepEqual(
    parseThreadCatalogResult({
      id: 2,
      result: {
        data: [
          { id: 'cli-thread', source: 'cli' },
          { id: 'desktop-thread', source: 'vscode' },
          { id: 'other-thread', source: 'appServer' }
        ]
      }
    }),
    [
      { id: 'cli-thread', source: 'cli' },
      { id: 'desktop-thread', source: 'vscode' },
      { id: 'other-thread', source: 'unknown' }
    ]
  )
})
