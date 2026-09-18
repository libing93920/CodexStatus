import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseThreadCatalogResult,
  parseThreadListResult
} from '../src/main/services/codex-thread-catalog.ts'
import { classifyIslandTaskIdentity } from '../src/main/services/codex-task-identity.ts'

test('用户可见用途白名单：CLI、桌面、用户点选建议、用户fork允许', () => {
  for (const purpose of [
    'user',
    'ambient_suggestion_task',
    'agent_created_thread',
    'agent_forked_thread'
  ]) {
    for (const source of ['cli', 'vscode']) {
      assert.equal(classifyIslandTaskIdentity(source, purpose, { ephemeral: true }).admitted, true)
    }
  }
  assert.equal(classifyIslandTaskIdentity('cli', undefined).admitted, true)
  assert.equal(classifyIslandTaskIdentity('vscode', undefined).admitted, false)
})

test('内部、子代理、未知用途不能被客户端来源或catalog例外放行', () => {
  const options = { catalog: true, ephemeral: false, path: 'rollout.jsonl' }
  for (const purpose of [
    'memory_consolidation',
    'guardian_review',
    'ambient_suggestions',
    'ambient_suggestion_safety',
    'future-background',
    '',
    12
  ]) {
    for (const source of ['cli', 'vscode']) {
      const identity = classifyIslandTaskIdentity(source, purpose, options)
      assert.equal(identity.admitted, false, `${source}/${purpose}`)
      assert.equal(identity.legacyDesktopCandidate, false)
    }
  }
  for (const source of [
    { internal: 'memory_consolidation' },
    { subagent: 'memory_consolidation' },
    { subAgent: { thread_spawn: {} } },
    'unknown',
    undefined
  ]) {
    assert.equal(classifyIslandTaskIdentity(source, 'user', options).admitted, false)
  }
})

test('历史桌面须同时有catalog、明确持久化及有效路径，缺一不准入', () => {
  const confirmed = { catalog: true, ephemeral: false, path: 'rollout.jsonl' }
  for (const purpose of [undefined, null]) {
    assert.equal(classifyIslandTaskIdentity('vscode', purpose, confirmed).admitted, true)
    for (const options of [
      { ...confirmed, catalog: false },
      { ...confirmed, ephemeral: undefined },
      { ...confirmed, ephemeral: true },
      { ...confirmed, path: '' }
    ]) {
      assert.equal(classifyIslandTaskIdentity('vscode', purpose, options).admitted, false)
    }
  }
})

test('真实catalog字段区分历史桌面、临时后台及明确子代理', () => {
  const result = parseThreadCatalogResult({
    id: 2,
    result: {
      data: [
        {
          id: 'legacy',
          source: 'vscode',
          threadSource: null,
          ephemeral: false,
          path: 'rollout.jsonl'
        },
        {
          id: 'background',
          source: 'vscode',
          threadSource: 'ambient_suggestions',
          ephemeral: true
        },
        { id: 'subagent', source: { subAgent: { thread_spawn: {} } }, threadSource: 'user' },
        { id: 'unconfirmed', source: 'vscode' }
      ]
    }
  })
  assert.deepEqual(result, [
    { id: 'legacy', source: 'vscode' },
    { id: 'background', source: 'internal' },
    { id: 'subagent', source: 'subagent' },
    { id: 'unconfirmed', source: 'unknown' }
  ])
})

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
          { id: 'desktop-thread', source: 'vscode', threadSource: 'user' },
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
