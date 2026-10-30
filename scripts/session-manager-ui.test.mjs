/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createSessionManagerFixtureState } from './fixtures/session-manager-ui-fixtures.mjs'
import { DEFAULT_ITEM_FILTERS } from '../src/renderer/src/tools/session-cleaner/model.ts'
import { groupSources } from '../src/renderer/src/tools/session-cleaner/source-groups.ts'
import {
  canExportSession,
  canPermanentlyDelete,
  canResumeSession,
  filterItems,
  getDeletableIds,
  getExportableIds,
  getPlanWarnings,
  getUniqueResourceBytes,
  groupAgentStorage,
  isItemSelectable,
  itemSize
} from '../src/renderer/src/tools/session-cleaner/manager-model.ts'

const TEST_NOW = new Date(2026, 9, 29, 12, 0, 0).getTime()
const MIB = 1024 ** 2

const rendererModuleCache = new Map()

test('侧栏按来源引用计算唯一资源，与空间分析一致', () => {
  const data = createSessionManagerFixtureState()
  const groups = groupSources(data)
  const storage = groupAgentStorage(data)
  for (const group of storage.filter(
    (group) => group.resourceDataAvailable && group.totalBytes > 0
  )) {
    assert.equal(groups.find((source) => source.id === group.id)?.bytes, group.totalBytes)
  }
})

test('details cache keeps only the open session and invalidates it for reload', async () => {
  const { reduceCleanerUiState, INITIAL_CLEANER_UI_STATE } = await loadRendererModule(
    'src/renderer/src/tools/session-cleaner/state.ts'
  )
  const data = createSessionManagerFixtureState()
  const first = data.items.find((item) => item.id === 'codex-parent')
  const second = data.items.find((item) => item.id === 'codex-child')
  const details = { messages: [], resources: [] }
  let state = reduceCleanerUiState(INITIAL_CLEANER_UI_STATE, { type: 'data', data })

  state = reduceCleanerUiState(state, { type: 'detail-open', id: first.id })
  state = reduceCleanerUiState(state, { type: 'detail-loaded', id: first.id, details })
  state = reduceCleanerUiState(state, { type: 'detail-open', id: second.id })
  assert.deepEqual(Object.keys(state.details), [])
  state = reduceCleanerUiState(state, { type: 'detail-loaded', id: second.id, details })
  assert.deepEqual(Object.keys(state.details), [second.id])

  const changed = structuredClone(data)
  changed.items.find((item) => item.id === second.id).managed.revision += '-updated'
  state = reduceCleanerUiState(state, { type: 'data', data: changed })
  assert.equal(state.detailId, second.id)
  assert.equal(state.details[second.id], undefined)
  assert.equal(state.detailReloadId, second.id)

  state = reduceCleanerUiState(state, { type: 'detail-reload-start', id: second.id })
  assert.equal(state.detailReloadId, null)
  state = reduceCleanerUiState(state, { type: 'detail-loaded', id: second.id, details })
  state = reduceCleanerUiState(state, { type: 'detail-open', id: null })
  assert.deepEqual(state.details, {})
  assert.equal(
    reduceCleanerUiState(state, { type: 'detail-loaded', id: second.id, details }),
    state
  )

  changed.items = changed.items.filter((item) => item.id !== second.id)
  state = reduceCleanerUiState(state, { type: 'data', data: changed })
  assert.equal(state.detailId, null)
  assert.equal(state.detailReloadId, null)
})
async function loadRendererModule(entryPoint) {
  if (!rendererModuleCache.has(entryPoint)) {
    const result = await build({
      entryPoints: [entryPoint],
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: false
    })
    const source = Buffer.from(result.outputFiles[0].text).toString('base64')
    rendererModuleCache.set(entryPoint, import(`data:text/javascript;base64,${source}`))
  }
  return rendererModuleCache.get(entryPoint)
}

const { reloadInvalidatedDetail, useCancelOperation, useItemActions, useManagerActions } =
  await loadRendererModule('src/renderer/src/tools/session-cleaner/hooks-actions.ts')
const { useReviewActions } = await loadRendererModule(
  'src/renderer/src/tools/session-cleaner/hooks-review-actions.ts'
)
const { INITIAL_CLEANER_UI_STATE, reduceCleanerUiState } = await loadRendererModule(
  'src/renderer/src/tools/session-cleaner/state.ts'
)

test('openDetails reuses the active cache and loads an uncached session', async () => {
  const data = createSessionManagerFixtureState()
  const first = data.items.find((item) => item.id === 'codex-parent')
  const second = data.items.find((item) => item.id === 'codex-child')
  const details = { messages: [], resources: [] }
  let ui = reduceCleanerUiState(INITIAL_CLEANER_UI_STATE, { type: 'data', data })
  ui = reduceCleanerUiState(ui, { type: 'detail-open', id: first.id })
  ui = reduceCleanerUiState(ui, { type: 'detail-loaded', id: first.id, details })

  const calls = []
  const dispatched = []
  const pending = []
  const api = {
    transcript: async (id) => {
      calls.push(id)
      return details
    }
  }
  const executor = createImmediateExecutor(pending)
  const actions = useItemActions(ui, api, executor, (action) => dispatched.push(action))
  actions.openDetails(first.id)
  await Promise.all(pending.map(({ promise }) => promise))
  assert.deepEqual(calls, [])

  actions.openDetails(second.id)
  await Promise.all(pending.map(({ promise }) => promise))
  assert.deepEqual(calls, [second.id])
})

test('invalidated open details reload after scanning releases the busy state', async () => {
  const data = createSessionManagerFixtureState()
  const item = data.items.find((entry) => entry.id === 'codex-parent')
  const details = { messages: [], resources: [] }
  let ui = reduceCleanerUiState(INITIAL_CLEANER_UI_STATE, { type: 'data', data })
  ui = reduceCleanerUiState(ui, { type: 'detail-open', id: item.id })
  ui = reduceCleanerUiState(ui, { type: 'detail-loaded', id: item.id, details })
  const changed = structuredClone(data)
  changed.items.find((entry) => entry.id === item.id).managed.revision += '-updated'
  ui = reduceCleanerUiState(ui, { type: 'data', data: changed })

  const calls = []
  const dispatched = []
  const pending = []
  const api = {
    transcript: async (id) => {
      calls.push(id)
      return details
    }
  }
  const executor = createImmediateExecutor(pending)
  const dispatch = (action) => dispatched.push(action)
  reloadInvalidatedDetail({ ...ui, busy: 'scan' }, api, executor, dispatch)
  assert.deepEqual(calls, [])
  assert.deepEqual(dispatched, [])

  reloadInvalidatedDetail(ui, api, executor, dispatch)
  await Promise.all(pending.map(({ promise }) => promise))
  assert.deepEqual(calls, [item.id])
  assert.deepEqual(dispatched, [
    { type: 'detail-reload-start', id: item.id },
    { type: 'detail-loaded', id: item.id, details }
  ])
})

test('高级组合筛选同时匹配 Agent、目录、项目、日期、闲置、模型、消息数、父子关系和逻辑大小', () => {
  const data = createSessionManagerFixtureState()
  const filters = {
    ...DEFAULT_ITEM_FILTERS,
    agentKinds: ['codex'],
    sourceIds: ['codex-archive'],
    project: 'atlas',
    createdAfter: '2026-08-01',
    createdBefore: '2026-08-31',
    minimumIdleDays: 60,
    maximumIdleDays: 200,
    modelIds: ['o4-mini'],
    minimumMessageCount: 20,
    maximumMessageCount: 30,
    relationship: 'child',
    sizeBasis: 'logical',
    minimumBytes: 3 * MIB,
    maximumBytes: 5 * MIB,
    sort: 'size-desc'
  }

  assert.deepEqual(
    filterItems(data, filters, TEST_NOW).map((item) => item.id),
    ['codex-child']
  )
})

test('默认会话大小区分数据库逻辑量与文件占用；删除状态筛选互斥', () => {
  const data = createSessionManagerFixtureState()
  const parent = data.items.find((item) => item.id === 'codex-parent')
  assert.equal(DEFAULT_ITEM_FILTERS.sizeBasis, 'session')
  assert.equal(itemSize(parent), parent.managed.storage.fileBytes)

  const sharedFile = {
    ...parent,
    managed: {
      ...parent.managed,
      storage: { ...parent.managed.storage, fileBytes: 900, logicalBytes: 1200, sharedBytes: 100 }
    }
  }
  assert.equal(
    itemSize(sharedFile),
    sharedFile.managed.storage.fileBytes + sharedFile.managed.storage.sharedBytes
  )

  const databaseSession = {
    ...sharedFile,
    managed: {
      ...sharedFile.managed,
      storage: { ...sharedFile.managed.storage, kind: 'sqlite', logicalBytes: 1200 }
    }
  }
  assert.equal(itemSize(databaseSession), databaseSession.managed.storage.logicalBytes)

  const allowed = filterItems(data, { ...DEFAULT_ITEM_FILTERS, deletion: 'allowed' }, TEST_NOW)
  const blocked = filterItems(data, { ...DEFAULT_ITEM_FILTERS, deletion: 'blocked' }, TEST_NOW)
  const active = data.items.find((item) => item.id === 'codex-active')
  const protectedSession = data.items.find((item) => item.id === 'codex-protected')
  assert.ok(allowed.length > 0)
  assert.ok(blocked.length > 0)
  assert.equal(parent.recommendation, 'recent')
  assert.ok(allowed.some((item) => item.id === parent.id))
  assert.ok(!allowed.some((item) => item.id === active.id || item.id === protectedSession.id))
  assert.ok(blocked.some((item) => item.id === active.id))
  assert.ok(blocked.some((item) => item.id === protectedSession.id))
  assert.ok(allowed.every(canPermanentlyDelete))
  assert.ok(blocked.every((item) => !canPermanentlyDelete(item)))
  assert.equal(
    filterItems(data, DEFAULT_ITEM_FILTERS, TEST_NOW).length,
    allowed.length + blocked.length
  )
})

test('主搜索匹配项目名称和 managed projectDir', () => {
  const data = createSessionManagerFixtureState()
  const parent = data.items.find((item) => item.id === 'codex-parent')
  const child = data.items.find((item) => item.id === 'codex-child')
  parent.project = 'Primary Workspace Keyword'
  parent.managed.projectDir = undefined
  child.project = undefined
  child.managed.projectDir = 'F:\\Projects\\DirectoryOnlyKeyword'

  assert.deepEqual(
    filterItems(
      data,
      { ...DEFAULT_ITEM_FILTERS, query: 'primary workspace keyword' },
      TEST_NOW
    ).map((item) => item.id),
    ['codex-parent']
  )
  assert.deepEqual(
    filterItems(data, { ...DEFAULT_ITEM_FILTERS, query: 'directoryonlykeyword' }, TEST_NOW).map(
      (item) => item.id
    ),
    ['codex-child']
  )
})

test('近期建议不限制来源明确允许的删除；保护和正在使用状态仍禁止删除', () => {
  const items = createSessionManagerFixtureState().items
  const recent = items.find((item) => item.id === 'codex-parent')
  assert.equal(recent.recommendation, 'recent')
  assert.equal(canPermanentlyDelete(recent), true)

  const deletable = getDeletableIds(items)
  assert.ok(deletable.includes('codex-parent'))
  assert.ok(deletable.includes('codex-child'))
  assert.ok(!deletable.includes('codex-active'))
  assert.ok(!deletable.includes('codex-protected'))
  assert.ok(!deletable.includes('codex-missing'))
})

test('导出、续聊、读取能力独立于删除能力', () => {
  const items = createSessionManagerFixtureState().items
  const active = items.find((item) => item.id === 'codex-active')
  const protectedSession = items.find((item) => item.id === 'codex-protected')

  assert.equal(canExportSession(active), true)
  assert.equal(canResumeSession(active), true)
  assert.equal(canPermanentlyDelete(active), false)
  assert.equal(canExportSession(protectedSession), true)
  assert.equal(canPermanentlyDelete(protectedSession), false)
  assert.ok(getExportableIds(items).includes('codex-active'))
})

test('跨页选择保存固定 ID；更改筛选不扩大也不替换选择', async () => {
  const data = createSessionManagerFixtureState(50)
  const selectable = data.items.filter(isItemSelectable)
  const result = await build({
    entryPoints: ['src/renderer/src/tools/session-cleaner/state.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false
  })
  const stateModule = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
  )
  let state = stateModule.reduceCleanerUiState(stateModule.INITIAL_CLEANER_UI_STATE, {
    type: 'data',
    data
  })
  state = stateModule.reduceCleanerUiState(state, {
    type: 'toggle-visible-selection',
    ids: selectable.slice(0, 40).map((item) => item.id)
  })
  state = stateModule.reduceCleanerUiState(state, {
    type: 'toggle-visible-selection',
    ids: selectable.slice(40).map((item) => item.id)
  })
  const fixedSelection = [...state.selectedIds]
  state = stateModule.reduceCleanerUiState(state, {
    type: 'filters',
    filters: { sourceIds: ['claude-main'], query: 'claude' }
  })

  assert.equal(fixedSelection.length, selectable.length)
  assert.deepEqual(state.selectedIds, fixedSelection)
})

test('Agent 与全局总占用按唯一物理资源并集；分类与共享字节属于总量子集', () => {
  const data = createSessionManagerFixtureState()
  const groups = groupAgentStorage(data)
  const codex = groups.find((group) => group.kind === 'codex')
  const claude = groups.find((group) => group.kind === 'claude')

  assert.equal(codex.totalBytes, 1832)
  assert.equal(codex.storage.fileBytes, 1832)
  assert.equal(codex.storage.databaseBytes, 1000)
  assert.equal(codex.storage.walBytes, 50)
  assert.equal(codex.storage.sharedBytes, 632)
  assert.equal(codex.storage.otherBytes, 782)
  assert.equal(codex.storage.complete, true)
  assert.equal(claude.totalBytes, 70)
  assert.equal(claude.storage.complete, false)
  assert.equal(
    groups.reduce((total, group) => total + group.totalBytes, 0),
    1902
  )
  assert.equal(getUniqueResourceBytes(data.resources), 1832)
  assert.equal(getUniqueResourceBytes(undefined), null)
})

test('删除预览确认窗汇总计划与逐项警告并去重', () => {
  assert.deepEqual(
    getPlanWarnings({
      warnings: ['总警告', '重复警告'],
      previews: [{ warnings: ['重复警告', '会话警告'] }, { warnings: ['资源警告'] }]
    }),
    ['总警告', '重复警告', '会话警告', '资源警告']
  )
})

async function renderComponent(modulePath, componentName, props, prefix) {
  const source = `
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { ${componentName} } from ${JSON.stringify(modulePath)};
    export function render(props) {
      return renderToStaticMarkup(React.createElement(${componentName}, props));
    }
  `
  const scriptDirectory = resolve(process.cwd(), 'scripts')
  const temporaryDirectory = await mkdtemp(join(scriptDirectory, `.${prefix}-`))
  const target = resolve(temporaryDirectory)
  assert.ok(target.startsWith(`${scriptDirectory}${sep}`), '测试临时文件必须留在 scripts 内')
  try {
    const result = await build({
      stdin: {
        contents: source,
        resolveDir: process.cwd(),
        sourcefile: 'session-manager-render-fixture.tsx',
        loader: 'tsx'
      },
      bundle: true,
      external: ['react', 'react-dom', 'react-dom/server', 'react/jsx-runtime'],
      format: 'esm',
      jsx: 'automatic',
      platform: 'node',
      write: false
    })
    const bundlePath = join(temporaryDirectory, 'render.mjs')
    await writeFile(bundlePath, result.outputFiles[0].text, 'utf8')
    const module = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`)
    return module.render(props)
  } finally {
    await rm(target, { recursive: true, force: true })
  }
}

async function renderMessages(messages) {
  return renderComponent(
    './src/renderer/src/tools/session-cleaner/pages/SessionMessage.tsx',
    'SessionMessageList',
    { messages, sessionId: 'session-fixture' },
    'session-manager-render'
  )
}

test('记录页缓存边界保留分批记录与操作汇总', async () => {
  const data = createSessionManagerFixtureState()
  const base = {
    sourceId: data.sources[0].id,
    title: 'fixture record',
    path: 'fixture.jsonl',
    bytes: 1024,
    at: TEST_NOW
  }
  data.records = [
    { ...base, id: 'deleted', batchId: 'batch-one', status: 'deleted' },
    { ...base, id: 'exported', batchId: 'batch-one', status: 'exported' },
    { ...base, id: 'compacted', batchId: 'batch-two', status: 'compacted' }
  ]
  const previousDocument = globalThis.document
  // 说明按钮依赖 body；静态记录断言不打开浮层，不需要完整浏览器 DOM。
  globalThis.document = { body: {} }
  let markup
  try {
    markup = await renderComponent(
      './src/renderer/src/tools/session-cleaner/pages/RecordsPage.tsx',
      'RecordsPage',
      { data, isBusy: true },
      'session-manager-records'
    )
  } finally {
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
  }
  assert.equal((markup.match(/data-batch-id=/g) ?? []).length, 2)
  assert.equal((markup.match(/class="review-row manager-record-row"/g) ?? []).length, 3)
  assert.match(markup, /永久删除<\/span><strong>1 项 · 1 KB<\/strong>/)
  assert.match(markup, /导出<\/span><strong>1 项<\/strong>/)
  assert.match(markup, /数据库整理<\/span><strong>1 项<\/strong>/)
})

test('批量跨筛选选择保留数量和隐藏选择提示', async () => {
  const data = createSessionManagerFixtureState(2000)
  const selectedIds = data.items
    .filter((item) => item.category === 'sessions')
    .slice(0, 1000)
    .map((item) => item.id)
  const markup = await renderComponent(
    './src/renderer/src/tools/session-cleaner/pages/ItemsPage.tsx',
    'ItemsPage',
    {
      data,
      filters: { ...DEFAULT_ITEM_FILTERS, query: 'no-matching-fixture-title' },
      selectedIds,
      detailId: null,
      isBusy: false,
      canReview: true
    },
    'session-manager-selection'
  )
  assert.match(markup, /含 1000 项来自其他筛选/)
  assert.match(markup, /<strong>1000<\/strong> 项已选/)
})

async function renderItemTable(data, item, filters) {
  return renderComponent(
    './src/renderer/src/tools/session-cleaner/pages/ItemTable.tsx',
    'ItemTable',
    {
      data,
      items: [item],
      selectedIds: [],
      detailId: item.id,
      details: { messages: [], resources: [] },
      detailLoaded: true,
      detailsLoading: false,
      isBusy: true,
      filters,
      onSelect: () => undefined,
      onDetails: () => undefined,
      onCloseDetails: () => undefined,
      onReveal: () => undefined,
      onExport: () => undefined,
      onResume: () => undefined,
      onScan: () => undefined
    },
    'session-manager-table'
  )
}

function createReviewPlan(data, ids, id = 'fixture-plan') {
  const selected = new Set(ids)
  const items = data.items.filter((item) => selected.has(item.id))
  return {
    id,
    createdAt: TEST_NOW,
    items,
    totalBytes: items.reduce((total, item) => total + item.bytes, 0),
    excluded: [],
    deletionMode: 'permanent'
  }
}

function createUiWithPlan(data, plan) {
  const state = reduceCleanerUiState(INITIAL_CLEANER_UI_STATE, { type: 'data', data })
  return { ...state, selectedIds: plan.items.map((item) => item.id), plan, confirmOpen: true }
}

function createImmediateExecutor(pending) {
  return (action, request, onSuccess) => {
    const promise = (async () => {
      const result = await request()
      onSuccess(result)
      return true
    })()
    pending.push({ action, promise })
    return promise
  }
}

test('近期和只读会话可设置保护；正在使用的会话仍会被排除', async () => {
  const data = createSessionManagerFixtureState()
  assert.equal(data.items.find((item) => item.id === 'codex-parent')?.status, 'recent')
  assert.equal(data.items.find((item) => item.id === 'codex-missing')?.status, 'read-only')
  assert.equal(data.items.find((item) => item.id === 'codex-active')?.status, 'active')
  const ui = reduceCleanerUiState(INITIAL_CLEANER_UI_STATE, { type: 'data', data })
  const calls = []
  const dispatched = []
  const pending = []
  const api = {
    protect: async (ids, protectedValue) => {
      calls.push({ ids: [...ids], protectedValue })
      return data
    }
  }
  const actions = useItemActions(ui, api, createImmediateExecutor(pending), (action) =>
    dispatched.push(action)
  )

  actions.protect(['codex-parent', 'codex-missing', 'codex-active'], true)
  await Promise.all(pending.map(({ promise }) => promise))

  assert.deepEqual(calls, [{ ids: ['codex-parent', 'codex-missing'], protectedValue: true }])
  assert.deepEqual(
    pending.map(({ action }) => action),
    ['protect']
  )
  assert.deepEqual(dispatched[0], { type: 'invalidate', clearSelection: true })
  assert.ok(
    dispatched.some(
      (action) =>
        action.type === 'data' &&
        action.data === data &&
        action.clearSelection === true &&
        action.invalidateReview === true
    )
  )
  assert.ok(
    dispatched.some((action) => action.type === 'notice' && action.message === '已保护所选项。')
  )
})

test('configPath 变化会失效旧审核并清除旧选择', () => {
  const data = createSessionManagerFixtureState()
  const plan = createReviewPlan(data, ['codex-parent'])
  const initial = reduceCleanerUiState(INITIAL_CLEANER_UI_STATE, { type: 'data', data })
  const state = { ...initial, selectedIds: ['codex-parent'], plan, confirmOpen: true }
  const updatedData = structuredClone(data)
  updatedData.sources[0].configPath = 'F:\\Agents\\codex-config'

  const updated = reduceCleanerUiState(state, { type: 'data', data: updatedData })

  assert.equal(updated.plan, null)
  assert.equal(updated.confirmOpen, false)
  assert.equal(updated.reviewInvalidated, true)
  assert.deepEqual(updated.selectedIds, [])
})

test('createdBefore uses local next midnight across daylight-saving changes', () => {
  const previousTimezone = process.env.TZ
  process.env.TZ = 'America/New_York'
  try {
    const data = createSessionManagerFixtureState()
    const item = data.items.find((entry) => entry.id === 'codex-parent')
    const transitions = [
      { date: '2026-03-08', hours: 23 },
      { date: '2026-11-01', hours: 25 }
    ]
    for (const transition of transitions) {
      const [year, month, day] = transition.date.split('-').map(Number)
      const dayStart = new Date(year, month - 1, day).getTime()
      const nextMidnight = new Date(year, month - 1, day + 1).getTime()
      const filters = {
        ...DEFAULT_ITEM_FILTERS,
        createdAfter: transition.date,
        createdBefore: transition.date
      }
      const containsItem = () =>
        filterItems(data, filters, TEST_NOW).some((entry) => entry.id === item.id)

      assert.equal(nextMidnight - dayStart, transition.hours * 60 * 60 * 1000)
      item.managed.createdAt = dayStart - 1
      assert.equal(containsItem(), false)
      item.managed.createdAt = dayStart
      assert.equal(containsItem(), true)
      item.managed.createdAt = nextMidnight - 1
      assert.equal(containsItem(), true)
      item.managed.createdAt = nextMidnight
      assert.equal(containsItem(), false)
    }
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ
    else process.env.TZ = previousTimezone
  }
})

test('排序按当前指标排列，并向列表公开可访问排序状态', async () => {
  const data = createSessionManagerFixtureState(6)
  const filters = { ...DEFAULT_ITEM_FILTERS, status: 'all' }
  const oldest = filterItems(data, { ...filters, sort: 'oldest' }, TEST_NOW)
  const newest = filterItems(data, { ...filters, sort: 'newest' }, TEST_NOW)
  const largest = filterItems(data, { ...filters, sort: 'size-desc' }, TEST_NOW)
  const recommended = filterItems(data, { ...filters, sort: 'recommended' }, TEST_NOW)

  assert.deepEqual(
    oldest.map((item) => item.modifiedAt),
    [...oldest.map((item) => item.modifiedAt)].sort((a, b) => a - b)
  )
  assert.deepEqual(
    newest.map((item) => item.modifiedAt),
    [...newest.map((item) => item.modifiedAt)].sort((a, b) => b - a)
  )
  const largestSizes = largest.map((item) => itemSize(item, filters.sizeBasis))
  assert.deepEqual(
    largestSizes,
    [...largestSizes].sort((a, b) => b - a)
  )
  assert.equal(recommended.at(-1).id, 'codex-parent')

  const item = data.items[0]
  const cases = [
    { sort: 'size-desc', size: 'descending', date: 'none' },
    { sort: 'oldest', size: 'none', date: 'ascending' },
    { sort: 'newest', size: 'none', date: 'descending' },
    { sort: 'recommended', size: 'none', date: 'none' }
  ]
  for (const spec of cases) {
    const markup = await renderItemTable(data, item, { ...filters, sort: spec.sort })
    assert.ok(markup.includes(`class="size-cell" scope="col" aria-sort="${spec.size}"`))
    assert.ok(markup.includes(`class="date-cell" scope="col" aria-sort="${spec.date}"`))
    assert.doesNotMatch(markup, /class="status-cell"[^>]*aria-sort=/)
  }
})

test('导出、续聊与数据库整理调用各自支持的 API', async () => {
  const data = createSessionManagerFixtureState()
  data.sources.push({ ...data.sources[0], id: 'opencode-main', kind: 'opencode', name: 'OpenCode' })
  data.storage.push({
    sourceId: 'opencode-main',
    fileBytes: 400,
    databaseBytes: 300,
    walBytes: 0,
    sharedBytes: 0,
    otherBytes: 100,
    databaseFreeBytes: 100,
    complete: true
  })
  const initial = reduceCleanerUiState(INITIAL_CLEANER_UI_STATE, { type: 'data', data })
  const ui = { ...initial, selectedIds: ['codex-active', 'codex-protected'] }
  const calls = { exported: [], resumed: [], compacted: [] }
  const dispatched = []
  const pending = []
  const api = {
    exportSessions: async (ids) => {
      calls.exported = ids
      return { count: ids.length, cancelled: false }
    },
    getState: async () => data,
    resumeSession: async (id) => calls.resumed.push(id),
    compactDatabase: async (sourceId) => {
      calls.compacted.push(sourceId)
      return data
    }
  }
  const actions = useManagerActions(ui, api, createImmediateExecutor(pending), (action) =>
    dispatched.push(action)
  )

  actions.exportSessions()
  actions.resumeSession('codex-active')
  actions.resumeSession('codex-protected')
  actions.compactDatabase('codex-main')
  actions.compactDatabase('opencode-main')
  await Promise.all(pending.map(({ promise }) => promise))

  assert.deepEqual(calls.exported, ['codex-active', 'codex-protected'])
  assert.deepEqual(calls.resumed, ['codex-active'])
  assert.deepEqual(calls.compacted, ['opencode-main'])
  assert.deepEqual(
    pending.map(({ action }) => action),
    ['export', 'resume', 'compact']
  )
  assert.ok(
    dispatched.some((action) => action.type === 'notice' && action.message.includes('导出完成'))
  )
  assert.ok(
    dispatched.some((action) => action.type === 'notice' && action.message.includes('继续此会话'))
  )
})

test('取消当前操作只发送一次，并在操作结束后清除等待状态', async () => {
  const data = createSessionManagerFixtureState()
  const dispatched = []
  const busyRef = { current: 'export' }
  const cancelOperationRef = { current: false }
  let cancelCalls = 0
  let resolveCancel
  const api = {
    cancelOperation: () => {
      cancelCalls += 1
      return new Promise((resolve) => {
        resolveCancel = resolve
      })
    }
  }
  const cancel = useCancelOperation(
    { data, busy: 'export' },
    api,
    busyRef,
    cancelOperationRef,
    (action) => dispatched.push(action)
  )

  cancel()
  cancel()
  assert.equal(cancelCalls, 1)
  assert.deepEqual(dispatched[0], { type: 'cancel-pending', value: true })
  busyRef.current = null
  resolveCancel()
  await new Promise(setImmediate)

  assert.equal(cancelOperationRef.current, false)
  assert.ok(
    !dispatched.some(
      (action) => action.type === 'notice' && action.message.includes('取消请求已发送')
    ),
    'Late cancellation acknowledgements must not overwrite the completed-operation result'
  )
  assert.deepEqual(dispatched.at(-1), { type: 'cancel-pending', value: false })
})

test('关闭删除确认或取消导出时不会执行删除', async () => {
  const data = createSessionManagerFixtureState()
  const plan = createReviewPlan(data, ['codex-parent', 'codex-child'])
  const ui = createUiWithPlan(data, plan)
  const dispatched = []
  const pending = []
  let exportCalls = 0
  let deleteCalls = 0
  const api = {
    exportSessions: async () => {
      exportCalls += 1
      return { count: 0, cancelled: true }
    },
    getState: async () => data,
    recycle: async () => {
      deleteCalls += 1
      return data
    }
  }
  const actions = useReviewActions(ui, api, createImmediateExecutor(pending), (action) =>
    dispatched.push(action)
  )

  actions.closeConfirmation()
  assert.equal(deleteCalls, 0)
  assert.deepEqual(dispatched[0], { type: 'confirm', open: false })
  actions.confirmDelete(true)
  await Promise.all(pending.map(({ promise }) => promise))

  assert.equal(exportCalls, 1)
  assert.equal(deleteCalls, 0)
  assert.ok(
    dispatched.some((action) => action.type === 'notice' && action.message.includes('没有执行删除'))
  )
})

test('部分删除取消按逐项记录报告，并保留仍可操作的固定选择', async () => {
  const data = createSessionManagerFixtureState()
  const plan = createReviewPlan(data, ['codex-parent', 'codex-child'])
  const deletedItem = plan.items[0]
  const remainingItem = plan.items[1]
  const resultData = {
    ...data,
    items: data.items.filter((item) => item.id !== deletedItem.id),
    records: [
      {
        id: 'record-deleted',
        batchId: plan.id,
        sourceId: deletedItem.sourceId,
        title: deletedItem.title,
        path: deletedItem.path,
        bytes: deletedItem.bytes,
        at: TEST_NOW,
        status: 'deleted'
      },
      {
        id: 'record-skipped',
        batchId: plan.id,
        sourceId: remainingItem.sourceId,
        title: remainingItem.title,
        path: remainingItem.path,
        bytes: remainingItem.bytes,
        at: TEST_NOW,
        status: 'skipped'
      }
    ]
  }
  const ui = createUiWithPlan(data, plan)
  const dispatched = []
  const pending = []
  const api = { recycle: async () => resultData }
  const actions = useReviewActions(ui, api, createImmediateExecutor(pending), (action) =>
    dispatched.push(action)
  )

  actions.confirmDelete()
  await Promise.all(pending.map(({ promise }) => promise))

  const dataAction = dispatched.find((action) => action.type === 'data')
  const notice = dispatched.find((action) => action.type === 'notice')
  const updated = reduceCleanerUiState(ui, dataAction)
  assert.equal(dataAction.invalidateReview, true)
  assert.deepEqual(updated.selectedIds, [remainingItem.id])
  assert.equal(updated.plan, null)
  assert.match(notice.message, /1\/2 项/)
  assert.doesNotMatch(notice.message, /永久删除已完成：2 项/)
})

test('会话列表只保留五个主列，大小信息不堆叠技术分项', async () => {
  const data = createSessionManagerFixtureState()
  const item = data.items.find((entry) => entry.id === 'codex-parent')
  const markup = await renderItemTable(data, item, {
    ...DEFAULT_ITEM_FILTERS,
    sort: 'newest'
  })
  const header = markup.match(/<thead>([\s\S]*?)<\/thead>/)?.[1]
  const row = markup.match(/<tr[^>]*data-item-id="codex-parent">([\s\S]*?)<\/tr>/)?.[1]

  assert.ok(header)
  assert.ok(row)
  const headers = [...header.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map(([, content]) =>
    content.replace(/<[^>]*>/g, '').trim()
  )
  assert.deepEqual(headers, ['', '会话', '大小', '最近使用', '删除状态', '更多操作'])
  assert.doesNotMatch(header, /模型|消息/)

  const sizeCell = row.match(/<td class="size-cell calm-session-size">([\s\S]*?)<\/td>/)?.[1]
  assert.ok(sizeCell)
  assert.match(sizeCell, /<strong>/)
  assert.doesNotMatch(sizeCell, /去重计入|文件大小|逻辑大小|manager-size-breakdown/)
  assert.match(row, /class="item-title-button row-title"/)
  assert.match(row, /aria-label="更多操作：会话 codex-parent"/)
  assert.match(row, /aria-haspopup="dialog"/)
  assert.match(markup, /<dialog[^>]*aria-label="会话详情"/)
})

test('列表忙碌时禁止标题、更多操作与详情操作；排序状态仍可访问', async () => {
  const data = createSessionManagerFixtureState()
  const item = data.items.find((entry) => entry.id === 'codex-parent')
  const markup = await renderItemTable(data, item, {
    ...DEFAULT_ITEM_FILTERS,
    sort: 'recommended'
  })

  assert.match(markup, /class="date-cell" scope="col" aria-sort="none"/)
  assert.match(markup, /class="item-title-button row-title" type="button" disabled=""/)
  const moreButton = markup.match(
    /<button(?=[^>]*aria-label="更多操作：会话 codex-parent")[^>]*>/
  )?.[0]
  assert.ok(moreButton)
  assert.match(moreButton, /disabled=""/)
  assert.match(moreButton, /aria-haspopup="dialog"/)
  assert.match(markup, /<dialog[^>]*aria-label="会话详情"/)
  assert.match(markup, /<button[^>]*disabled="">导出会话<\/button>/)
  assert.match(markup, /<button[^>]*disabled="">继续会话<\/button>/)
})

test('正文默认展示最近 30 条消息，保留可展开的工具块', async () => {
  const messages = Array.from({ length: 31 }, (_, index) => ({
    role: 'assistant',
    content: `消息 ${index + 1}`
  }))
  messages[30] = {
    role: 'assistant',
    content: '',
    blocks: [
      { type: 'tool_call', name: 'fixture-tool', inputPreview: '参数预览' },
      { type: 'tool_result', preview: '工具输出' }
    ]
  }
  const markup = await renderMessages(messages)

  assert.equal((markup.match(/class="manager-message"/g) ?? []).length, 30)
  assert.match(markup, /显示全部 31 条消息/)
  assert.match(markup, /<details class="manager-session-block"/)
  assert.match(markup, /fixture-tool/)
})

test('正文与块内容按文本渲染；HTML 不会执行，长工具输出显示按需加载', async () => {
  const markup = await renderMessages([
    {
      role: 'assistant',
      content: '',
      blocks: [
        { type: 'text', text: '<img src=x onerror=alert(1)>' },
        {
          type: 'tool_result',
          status: 'success',
          preview: '短预览',
          totalLen: 5000,
          lineCount: 90,
          truncated: true,
          full: { kind: 'sidecar', relPath: 'output.txt' }
        }
      ]
    }
  ])

  assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.doesNotMatch(markup, /<img src=x/)
  assert.match(markup, /<details class="manager-session-block"/)
  assert.match(markup, /加载全文：正文/)
})
