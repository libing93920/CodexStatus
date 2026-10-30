/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import test from 'node:test'
import { recycleAndRefresh } from '../src/renderer/src/tools/session-cleaner/recycle.ts'
import {
  groupSources,
  sourceDirectoryLabel
} from '../src/renderer/src/tools/session-cleaner/source-groups.ts'
import {
  formatBytes,
  formatItemSize,
  getCandidateIds,
  groupRecordsByBatch,
  parseSettingsDraft,
  settingsDraftError,
  settingsToDraft,
  sourcesEqual
} from '../src/renderer/src/tools/session-cleaner/model.ts'
import { filterItems } from '../src/renderer/src/tools/session-cleaner/manager-model.ts'

function item(id, status, overrides = {}) {
  return {
    id,
    sourceId: 'source-fixture',
    title: `会话 ${id}`,
    path: `fixture/${id}.jsonl`,
    project: 'fixture-project',
    sessionId: id,
    bytes: 128,
    modifiedAt: 1_700_000_000_000,
    category: 'sessions',
    status,
    reason: '',
    files: [`fixture/${id}.jsonl`],
    fingerprint: 'test-only',
    ...overrides
  }
}

test('容量显示使用 T、G、MB、KB、B 并按 1024 换算', () => {
  assert.equal(formatBytes(1023), '1023 B')
  assert.equal(formatBytes(1024), '1 KB')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(1024 ** 2 - 1), '1,024 KB')
  assert.equal(formatBytes(1024 ** 2), '1 MB')
  assert.equal(formatBytes(1024 ** 3), '1 G')
  assert.equal(formatBytes(1024 ** 4), '1 T')
})

test('共享数据库元数据不显示为零字节', () => {
  assert.equal(formatItemSize({ bytes: 0, path: 'state_5.sqlite' }), '共享数据库')
  assert.equal(formatItemSize({ bytes: 0, path: 'empty.jsonl' }), '0 B')
})

test('审核选择只保留 candidate 条目', () => {
  const items = [
    item('candidate', 'candidate'),
    item('protected', 'protected'),
    item('recent', 'recent'),
    item('active', 'active'),
    item('read-only', 'read-only')
  ]
  assert.deepEqual(getCandidateIds(items), ['candidate'])
  assert.deepEqual(getCandidateIds(items, ['protected', 'candidate']), ['candidate'])
})

test('筛选使用扫描条目字段且不改变其状态', () => {
  const items = [
    item('claude-old', 'candidate', { sourceId: 'claude', title: 'Alpha', bytes: 1024 }),
    item('pi-held', 'protected', { sourceId: 'pi', title: 'Beta', category: 'resources' })
  ]
  const data = {
    items,
    sources: [
      { id: 'claude', kind: 'claude' },
      { id: 'pi', kind: 'pi' }
    ]
  }
  const filtered = filterItems(data, {
    query: 'alpha',
    category: 'sessions',
    status: 'candidate',
    sourceId: 'agent:claude',
    minimumAgeDays: 0,
    minimumBytes: 0,
    sort: 'recommended'
  })
  assert.deepEqual(
    filtered.map((entry) => entry.id),
    ['claude-old']
  )
  assert.equal(items[1].status, 'protected')
})

test('时间和大小筛选可组合，排序不修改扫描原始清单', () => {
  const now = 1_800_000_000_000
  const day = 86_400_000
  const filters = {
    query: '',
    category: 'all',
    status: 'all',
    sourceId: 'all',
    minimumAgeDays: 30,
    minimumBytes: 1024,
    sort: 'oldest'
  }
  const items = [
    item('recent', 'candidate', { modifiedAt: now - day, bytes: 4096 }),
    item('old-large', 'candidate', { modifiedAt: now - 90 * day, bytes: 2048 }),
    item('older-small', 'read-only', { modifiedAt: now - 120 * day, bytes: 128 })
  ]
  const data = { items, sources: [] }
  assert.deepEqual(
    filterItems(data, filters, now).map((entry) => entry.id),
    ['old-large']
  )
  assert.deepEqual(
    filterItems(data, { ...filters, minimumBytes: 0 }, now).map((entry) => entry.id),
    ['older-small', 'old-large']
  )
  assert.deepEqual(
    filterItems(
      data,
      { ...filters, minimumAgeDays: 0, minimumBytes: 0, sort: 'recommended' },
      now
    ).map((entry) => entry.id),
    ['recent', 'old-large', 'older-small']
  )
  assert.deepEqual(
    items.map((entry) => entry.id),
    ['recent', 'old-large', 'older-small']
  )
})

test('同一 Agent 的多个目录汇总占用，未知目录保持独立且不改写文件来源身份', () => {
  const sources = [
    { id: 'codex-main', kind: 'codex', name: 'Codex', capability: 'sessions' },
    { id: 'codex-archive', kind: 'codex', name: 'Codex', capability: 'sessions' },
    { id: 'claude', kind: 'claude', name: 'Claude', capability: 'sessions' },
    { id: 'custom-a', kind: 'unknown', name: 'Custom A', capability: 'files' },
    { id: 'custom-b', kind: 'unknown', name: 'Custom B', capability: 'files' }
  ]
  const items = [
    item('main', 'read-only', { sourceId: 'codex-main', bytes: 100 }),
    item('archive', 'read-only', { sourceId: 'codex-archive', bytes: 200 }),
    item('resource', 'read-only', { sourceId: 'codex-main', category: 'resources', bytes: 50 })
  ]
  const before = structuredClone({ sources, items })
  const groups = groupSources({ sources, items })
  assert.equal(groups.length, 4)
  assert.deepEqual(groups[0], {
    id: 'agent:codex',
    kind: 'codex',
    name: 'Codex',
    capability: 'sessions',
    sourceIds: ['codex-main', 'codex-archive'],
    bytes: 350
  })
  assert.deepEqual(
    groups.slice(2).map((group) => group.id),
    ['custom-a', 'custom-b']
  )
  assert.equal(groupSources({ sources: sources.slice(1), items })[0].id, 'agent:codex')
  assert.deepEqual({ sources, items }, before)
})

test('Agent 筛选覆盖普通和归档目录，并继续叠加搜索、类别和状态筛选', () => {
  const data = {
    sources: [
      { id: 'main', kind: 'codex' },
      { id: 'archive', kind: 'codex' },
      { id: 'claude', kind: 'claude' }
    ],
    items: [
      item('main', 'read-only', { sourceId: 'main', title: 'Alpha' }),
      item('archive', 'protected', { sourceId: 'archive', title: 'Beta' }),
      item('resource', 'read-only', { sourceId: 'archive', category: 'resources' }),
      item('other', 'read-only', { sourceId: 'claude', title: 'Beta' })
    ]
  }
  const filters = {
    sourceId: 'agent:codex',
    query: '',
    category: 'sessions',
    status: 'all',
    minimumAgeDays: 0,
    minimumBytes: 0,
    sort: 'newest'
  }
  assert.deepEqual(
    filterItems(data, filters).map((entry) => entry.id),
    ['main', 'archive']
  )
  assert.deepEqual(
    filterItems(data, { ...filters, query: 'beta', status: 'protected' }).map((entry) => entry.id),
    ['archive']
  )
  assert.equal(filterItems(data, { ...filters, category: 'all' }).length, 3)
  assert.equal(filterItems(data, { ...filters, sourceId: 'agent:pi' }).length, 0)
})

test('来源管理的 Codex 目录名称明确区分普通和归档会话', () => {
  const source = { name: 'Codex', kind: 'codex', path: 'C:\\Users\\demo\\.codex\\sessions' }
  assert.equal(sourceDirectoryLabel(source), 'Codex · 普通会话')
  assert.equal(
    sourceDirectoryLabel({ ...source, path: '/demo/.codex/archived_sessions/' }),
    'Codex · 已归档会话'
  )
  assert.equal(sourceDirectoryLabel({ ...source, path: '/demo/custom' }), 'Codex')
  assert.equal(sourceDirectoryLabel({ ...source, name: 'Pi', kind: 'pi' }), 'Pi')
})

test('策略范围和期限关系符合设置要求', () => {
  const valid = settingsToDraft({
    keepRecentDays: 14,
    olderSessionDays: 90,
    logAgeDays: 30,
    alertGiB: 10
  })
  assert.equal(settingsDraftError(valid), null)
  assert.deepEqual(parseSettingsDraft(valid), {
    keepRecentDays: 14,
    olderSessionDays: 90,
    logAgeDays: 30,
    alertGiB: 10
  })
  assert.match(
    settingsDraftError({ ...valid, olderSessionDays: '13' }) ?? '',
    /不能短于近期保留天数/
  )
  assert.match(settingsDraftError({ ...valid, alertGiB: '0' }) ?? '', /空间提醒/)
})

test('回收记录按批次分组并按最新操作时间排序', () => {
  const records = [
    {
      id: 'old-1',
      batchId: 'older',
      sourceId: 's',
      title: 'A',
      path: 'a',
      bytes: 100,
      at: 10,
      status: 'recycled'
    },
    {
      id: 'new-1',
      batchId: 'latest',
      sourceId: 's',
      title: 'B',
      path: 'b',
      bytes: 200,
      at: 30,
      status: 'recycled'
    },
    {
      id: 'new-2',
      batchId: 'latest',
      sourceId: 's',
      title: 'C',
      path: 'c',
      bytes: 300,
      at: 40,
      status: 'failed'
    },
    {
      id: 'old-2',
      batchId: 'older',
      sourceId: 's',
      title: 'D',
      path: 'd',
      bytes: 50,
      at: 20,
      status: 'failed'
    }
  ]
  const batches = groupRecordsByBatch(records)
  assert.deepEqual(
    batches.map((batch) => batch.batchId),
    ['latest', 'older']
  )
  assert.equal(batches[0].records.length, 2)
  assert.equal(batches[0].latestAt, 40)
  assert.equal(batches[0].totalBytes, 500)
})

test('回收失败后读取本机状态并保留原始错误', async () => {
  const recycleError = new Error('操作记录保存失败')
  const currentState = { records: [{ id: 'record-1' }], items: [] }
  const api = {
    recycle: async () => {
      throw recycleError
    },
    getState: async () => currentState
  }
  let refreshedState
  await assert.rejects(
    recycleAndRefresh(api, 'batch-1', (data) => {
      refreshedState = data
    }),
    (error) => error === recycleError
  )
  assert.equal(refreshedState, currentState)
})

test('状态刷新失败时仍返回回收操作的原始错误', async () => {
  const recycleError = new Error('部分回收失败')
  const api = {
    recycle: async () => {
      throw recycleError
    },
    getState: async () => {
      throw new Error('状态读取失败')
    }
  }
  await assert.rejects(
    recycleAndRefresh(api, 'batch-1', () => {}),
    (error) => error === recycleError
  )
})

test('来源变化比较包含路径、能力和来源类型', () => {
  const base = [
    {
      id: 'source-fixture',
      kind: 'claude',
      name: 'Claude',
      path: 'fixture/claude',
      origin: 'manual',
      capability: 'sessions',
      note: ''
    }
  ]
  assert.equal(sourcesEqual(base, [...base]), true)
  assert.equal(sourcesEqual(base, [{ ...base[0], path: 'fixture/other' }]), false)
  assert.equal(sourcesEqual(base, [{ ...base[0], capability: 'files' }]), false)
})
