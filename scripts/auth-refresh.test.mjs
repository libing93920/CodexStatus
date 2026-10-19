/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const source = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const parsed = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)

function fixture() {
  const pending = []
  const counts = { collected: 0, quotaCleared: 0 }
  let watcher
  const runtime = vm.createContext({
    refreshPromise: undefined,
    credentialRefreshPending: false,
    watchedCodexAuthPath: undefined,
    currentSnapshot: { canRefresh: true, generatedAt: 'before', issues: [] },
    persistedState: { settings: { agentId: 'codex' } },
    canRefreshStatus: () => true,
    setCurrentSnapshot(value) {
      runtime.currentSnapshot = value
    },
    resolveCodexAuthPath: () => '/isolated/auth.json',
    watchFile(_path, _options, callback) {
      watcher = callback
    },
    invalidateQuotaCaches() {
      counts.quotaCleared++
    },
    broadcastSnapshot: () => undefined,
    refreshTrayMenu: () => undefined,
    perfStart: () => undefined,
    perfEnd: () => undefined,
    collectUsageSnapshot() {
      counts.collected++
      return new Promise((resolve) => pending.push(resolve))
    },
    warmAllAgentUsageTotals: async () => {},
    buildTeamPeers: () => [],
    getSelfRemaining: () => undefined,
    lanService: { broadcastSnapshot: () => undefined },
    syncCapsuleWindowBounds: () => undefined,
    syncRefreshTimer: () => undefined
  })
  const functions = ['refreshStatus', 'watchCodexAuthFile'].map((name) => {
    const declaration = parsed.statements.find(
      (node) => ts.isFunctionDeclaration(node) && node.name?.text === name
    )
    assert.ok(declaration, `missing ${name}`)
    return declaration.getText(parsed)
  })
  const javascript = ts.transpileModule(functions.join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  vm.runInContext(javascript, runtime)
  return { runtime, counts, pending, changeAuth: (...args) => watcher(...args) }
}

function snapshot(authMode) {
  return { authMode, canRefresh: true, generatedAt: authMode, issues: [] }
}

test('凭据切换发生在刷新中时，完成旧任务后补刷一次且合并重复变更', async () => {
  const current = fixture()
  const first = current.runtime.refreshStatus()
  const forced = current.runtime.refreshStatus({ forceCredentialCheck: true })
  const repeated = current.runtime.refreshStatus({ forceCredentialCheck: true })
  assert.equal(current.counts.collected, 1)
  current.pending.shift()(snapshot('chatgpt'))
  await new Promise(setImmediate)
  assert.equal(current.counts.collected, 2)
  current.pending.shift()(snapshot('api'))
  await Promise.all([first, forced, repeated])
  assert.equal(current.runtime.currentSnapshot.authMode, 'api')
  assert.equal(current.counts.collected, 2)
})

test('普通并发刷新复用现有任务，不额外扫描', async () => {
  const current = fixture()
  const first = current.runtime.refreshStatus()
  const duplicate = current.runtime.refreshStatus()
  current.pending.shift()(snapshot('api'))
  await Promise.all([first, duplicate])
  assert.equal(current.counts.collected, 1)
})

test('auth.json 删除和重建都会清理订阅缓存并强制刷新', async () => {
  const current = fixture()
  current.runtime.watchCodexAuthFile()
  current.changeAuth({ mtimeMs: 0, size: 0 }, { mtimeMs: 1, size: 20 })
  assert.equal(current.counts.quotaCleared, 1)
  current.pending.shift()(snapshot('api'))
  await new Promise(setImmediate)
  current.changeAuth({ mtimeMs: 2, size: 30 }, { mtimeMs: 0, size: 0 })
  assert.equal(current.counts.quotaCleared, 2)
  current.pending.shift()(snapshot('chatgpt'))
  await new Promise(setImmediate)
  assert.equal(current.runtime.currentSnapshot.authMode, 'chatgpt')
  assert.equal(current.counts.collected, 2)
})
