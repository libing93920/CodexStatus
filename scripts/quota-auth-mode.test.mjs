/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import {
  collectUsageSnapshot,
  invalidateQuotaCaches,
  readOfficialCodexCredentials
} from '../src/main/services/quota.ts'
import { getTokenUsage, invalidateUsageCache } from '../src/main/services/usage.ts'

const SCRATCH_DIRECTORY = process.env.PI_SCRATCH_DIR
assert.ok(SCRATCH_DIRECTORY, '请通过 scripts/run-with-test-scratch.mjs 运行测试')

async function fixture(context) {
  const directory = await fs.mkdtemp(path.join(SCRATCH_DIRECTORY, 'quota-auth-'))
  const previousHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = directory
  context.mock.method(os, 'homedir', () => directory)
  invalidateQuotaCaches()
  invalidateUsageCache()
  context.after(() => {
    if (previousHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousHome
    invalidateQuotaCaches()
    invalidateUsageCache()
  })
  const requests = []
  const server = { used: 20, credits: 2 }
  context.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(url)
    const body = url.endsWith('reset-credits')
      ? {
          credits: [{ expires_at: new Date(Date.now() + 7_200_000).toISOString() }],
          available_count: server.credits
        }
      : {
          rate_limit: { primary_window: { limit_window_seconds: 18000, used_percent: server.used } }
        }
    return new Response(JSON.stringify(body))
  })
  return {
    directory,
    requests,
    server,
    authPath: path.join(directory, 'auth.json'),
    writeAuth(value) {
      return fs.writeFile(path.join(directory, 'auth.json'), JSON.stringify(value))
    }
  }
}

function chatgptCredentials() {
  return { auth_mode: 'chatgpt', tokens: { access_token: 'synthetic-oauth', account_id: 'test' } }
}

async function writeSession(directory) {
  const timestamp = new Date().toISOString()
  await fs.mkdir(path.join(directory, 'sessions'))
  const lines = [
    { type: 'session_meta', payload: { timestamp } },
    { type: 'turn_context', payload: { model: 'gpt-5.3-codex' } },
    {
      timestamp,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } },
        rate_limits: { primary: { window_minutes: 300, used_percent: 5 } }
      }
    }
  ]
  await fs.writeFile(
    path.join(directory, 'sessions', 'session.jsonl'),
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
  )
}

test('auth.json 不存在时使用无 Key 的 API 模式并允许本地刷新', async (context) => {
  await fixture(context)
  assert.deepEqual(await readOfficialCodexCredentials(), { canRefresh: true, mode: 'api' })
})

test('文件损坏和缺少 OAuth token 不伪装成 API 模式', async (context) => {
  const current = await fixture(context)
  await fs.writeFile(current.authPath, '{broken')
  assert.equal((await readOfficialCodexCredentials()).mode, 'none')
  await current.writeAuth({ auth_mode: 'chatgpt', tokens: {} })
  assert.equal((await readOfficialCodexCredentials()).mode, 'none')
})

test('读取权限错误保留错误提示，不按文件缺失处理', async (context) => {
  const current = await fixture(context)
  const readFile = fs.readFile.bind(fs)
  context.mock.method(fs, 'readFile', (filePath, ...options) => {
    if (filePath === current.authPath) {
      return Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }))
    }
    return readFile(filePath, ...options)
  })
  const credentials = await readOfficialCodexCredentials()
  assert.equal(credentials.mode, 'none')
  assert.match(credentials.issue, /无法读取.*auth\.json/)
})

test('缺失凭据时丢弃历史订阅额度，token 统计仍可读取', async (context) => {
  const current = await fixture(context)
  await writeSession(current.directory)
  const snapshot = await collectUsageSnapshot()
  assert.equal(snapshot.authMode, 'api')
  assert.equal(snapshot.canRefresh, true)
  assert.equal(snapshot.available, false)
  assert.deepEqual(snapshot.rateLimits, [])
  assert.equal(snapshot.rateLimitSource, 'none')
  assert.equal(snapshot.resetCredit, undefined)
  assert.equal(snapshot.officialIssue, undefined)
  assert.deepEqual(snapshot.issues, [])
  assert.equal(current.requests.length, 0)
  assert.equal((await getTokenUsage('codex', '1d')).totals.total, 120)
})

test('Auth、缺失文件 API、Auth 切换后重新读取额度和重置卡', async (context) => {
  const current = await fixture(context)
  await writeSession(current.directory)
  await current.writeAuth(chatgptCredentials())
  const first = await collectUsageSnapshot()
  assert.equal(first.authMode, 'chatgpt')
  assert.equal(first.resetCredit.availableCount, 2)
  await fs.unlink(current.authPath)
  const api = await collectUsageSnapshot()
  assert.equal(api.authMode, 'api')
  assert.equal(api.resetCredit, undefined)
  assert.deepEqual(api.rateLimits, [])
  current.server.used = 35
  current.server.credits = 3
  await current.writeAuth(chatgptCredentials())
  const last = await collectUsageSnapshot()
  assert.equal(last.authMode, 'chatgpt')
  assert.equal(last.rateLimits[0].usedPercent, 35)
  assert.equal(last.resetCredit.availableCount, 3)
})

test('已有 API Key 仍正确识别，API 快照不保留历史订阅额度', async (context) => {
  const current = await fixture(context)
  await writeSession(current.directory)
  await current.writeAuth({ OPENAI_API_KEY: 'synthetic-api-key' })
  const credentials = await readOfficialCodexCredentials()
  assert.equal(credentials.mode, 'api')
  assert.equal(credentials.apiKey, 'synthetic-api-key')
  assert.deepEqual((await collectUsageSnapshot()).rateLimits, [])
  assert.equal(current.requests.length, 0)
})

test('API 模式没有 Key 时账单返回不可用，不发送 HTTP 请求', async () => {
  const source = await fs.readFile(
    new URL('../src/main/services/billing.ts', import.meta.url),
    'utf8'
  )
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  let requests = 0
  const runtime = vm.createContext({
    exports: {},
    Date,
    Promise,
    setTimeout,
    require(name) {
      if (name === 'node:crypto') return { createHash }
      if (name === './quota') {
        return { readOfficialCodexCredentials: async () => ({ mode: 'api', canRefresh: true }) }
      }
      if (name === './diag-log') return { logDiag: () => undefined, formatDiagError: String }
      assert.equal(name, 'electron')
      return {
        net: {
          fetch() {
            requests++
            throw new Error('unexpected HTTP request')
          }
        }
      }
    }
  })
  vm.runInContext(javascript, runtime)
  const result = await runtime.exports.getSpendUsage('1d')
  assert.equal(result.available, false)
  assert.equal(requests, 0)
})
