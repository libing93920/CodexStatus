/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const MINUTE_MS = 60_000
const FAILURE_RETRY_MS = 5 * MINUTE_MS
const source = await readFile(new URL('../src/main/services/billing.ts', import.meta.url), 'utf8')
const javascript = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText

function fixture() {
  const state = {
    nowMs: Date.parse('2026-10-19T04:00:00Z'),
    credentials: { mode: 'api', apiKey: 'synthetic-key-A' },
    status: 403,
    networkError: false,
    pending: undefined,
    requests: []
  }
  class Clock extends Date {
    static now() {
      return state.nowMs
    }
  }
  const runtime = vm.createContext({
    exports: {},
    Date: Clock,
    setTimeout: () => 0,
    require(name) {
      if (name === 'node:crypto') return { createHash }
      if (name === './quota') {
        return { readOfficialCodexCredentials: async () => state.credentials }
      }
      if (name === './diag-log') return { logDiag: () => undefined, formatDiagError: String }
      assert.equal(name, 'electron')
      return {
        net: {
          fetch: async (url, options) => {
            state.requests.push({ url, authorization: options.headers.Authorization })
            if (state.pending) return new Promise((resolve) => state.pending.push(resolve))
            if (state.networkError) throw new Error('synthetic offline')
            return {
              ok: state.status === 200,
              status: state.status,
              json: async () => ({ total_usage: 125 })
            }
          }
        }
      }
    }
  })
  vm.runInContext(javascript, runtime)
  return { state, read: runtime.exports.getSpendUsage }
}

async function readAllWindows(current) {
  return Promise.all(['1d', '7d', '30d'].map((window) => current.read(window)))
}

test('账单 403 后连续三个快照只发送首轮 30 个日期请求', async () => {
  const current = fixture()
  for (let snapshot = 0; snapshot < 3; snapshot++) {
    const results = await readAllWindows(current)
    assert.ok(results.every((result) => !result.available))
    assert.equal(current.state.requests.length, 30)
    current.state.nowMs += 30_000
  }
})

test('失败缓存到期后允许重新请求，成功结果恢复正常缓存', async () => {
  const current = fixture()
  assert.equal((await current.read('1d')).available, false)
  current.state.nowMs += FAILURE_RETRY_MS - 1
  assert.equal((await current.read('1d')).available, false)
  assert.equal(current.state.requests.length, 1)
  current.state.nowMs++
  current.state.status = 200
  const recovered = await current.read('1d')
  assert.equal(recovered.available, true)
  assert.equal(recovered.total, 1.25)
  assert.equal(current.state.requests.length, 2)
  current.state.nowMs += FAILURE_RETRY_MS
  assert.equal((await current.read('1d')).total, 1.25)
  assert.equal(current.state.requests.length, 2)
})

test('网络错误也受失败缓存限制，不被快照反复重试', async () => {
  const current = fixture()
  current.state.networkError = true
  await current.read('1d')
  await current.read('1d')
  assert.equal(current.state.requests.length, 1)
})

test('更换 Key 不继承旧 Key 的失败缓存或成功账单', async () => {
  const current = fixture()
  await current.read('1d')
  current.state.credentials.apiKey = 'synthetic-key-B'
  current.state.status = 200
  assert.equal((await current.read('1d')).total, 1.25)
  assert.equal(current.state.requests.length, 2)
  current.state.credentials.apiKey = 'synthetic-key-C'
  current.state.status = 403
  assert.equal((await current.read('1d')).available, false)
  assert.equal(current.state.requests.length, 3)
})

test('在途请求只在同一 Key 内合并，不把旧 Key 结果交给新 Key', async () => {
  const current = fixture()
  current.state.pending = []
  const first = current.read('1d')
  await new Promise(setImmediate)
  current.state.credentials.apiKey = 'synthetic-key-B'
  const second = current.read('1d')
  const duplicate = current.read('1d')
  await new Promise(setImmediate)
  const pending = current.state.pending
  const requestCount = pending.length
  pending[0]({ ok: true, json: async () => ({ total_usage: 100 }) })
  if (pending[1]) pending[1]({ ok: true, json: async () => ({ total_usage: 200 }) })
  const results = await Promise.all([first, second, duplicate])
  assert.equal(requestCount, 2)
  assert.deepEqual(
    results.map((result) => result.total),
    [1, 2, 2]
  )
})
