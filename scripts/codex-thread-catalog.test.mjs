import assert from 'node:assert/strict'
import test from 'node:test'
import { parseThreadListResult } from '../src/main/services/codex-thread-catalog.ts'

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
