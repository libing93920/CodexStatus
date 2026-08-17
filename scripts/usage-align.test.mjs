// 用量/费用算法对齐 cc-switch 的纯函数测试(node --experimental-strip-types --test)。
// 覆盖:opencode 逐消息解析、claude message.id 去重 + cache_creation 拆分、
//      computeCost 拆 cache_read/cache_creation 计价、codex delta 优先 last_token_usage。
import assert from 'node:assert/strict'
import test from 'node:test'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseClaudeAssistantEvent, parseClaudeFile, parseOpenCodeMessage } from '../src/main/services/agents.ts'
import { computeCost, setRateLookup } from '../src/main/services/rate.ts'
import { buildCodexDelta, dedupClaudeEvents } from '../src/main/services/usage.ts'

// —— parseOpenCodeMessage ——
test('opencode:cache 两桶拆分 + reasoning 折入 output + cost 双轨', () => {
  const data = JSON.stringify({
    role: 'assistant',
    cost: 0.0023113,
    tokens: {
      total: 56654,
      input: 3272,
      output: 383,
      reasoning: 419,
      cache: { read: 52480, write: 100 }
    },
    modelID: 'deepseek-v4-pro',
    time: { created: 123456, completed: 123999 }
  })
  const event = parseOpenCodeMessage(data)
  assert.ok(event)
  assert.equal(event.ts, 123456)
  assert.equal(event.model, 'deepseek-v4-pro')
  assert.equal(event.tokens.input, 3272 + 52480 + 100) // fresh + cache 两桶 = 总输入
  assert.equal(event.tokens.cachedInput, 52480 + 100) // 展示合并
  assert.equal(event.tokens.cacheCreation, 100) // 计费拆分
  assert.equal(event.tokens.output, 383 + 419) // output + reasoning
  assert.equal(event.tokens.reasoning, 419)
  assert.equal(event.tokens.total, 55852 + 802)
  assert.equal(event.costUsd, 0.0023113) // opencode 自带 cost > 0 直接用
})

test('opencode:全零 token 消息跳过', () => {
  const data = JSON.stringify({
    role: 'assistant',
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: 'm',
    time: { created: 1, completed: 2 }
  })
  assert.equal(parseOpenCodeMessage(data), undefined)
})

test('opencode:未完成消息(time.completed 缺失)跳过', () => {
  const data = JSON.stringify({
    role: 'assistant',
    tokens: { input: 100, output: 200 },
    modelID: 'm',
    time: { created: 1 }
  })
  assert.equal(parseOpenCodeMessage(data), undefined)
})

test('opencode:纯缓存命中消息(无 fresh input)计入', () => {
  const data = JSON.stringify({
    role: 'assistant',
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 31231, write: 0 } },
    modelID: 'm',
    cost: 0,
    time: { created: 1, completed: 2 }
  })
  const event = parseOpenCodeMessage(data)
  assert.ok(event)
  assert.equal(event.tokens.input, 31231)
  assert.equal(event.costUsd, undefined) // cost=0 → 回落按价目估算
})

// —— parseClaudeAssistantEvent / parseClaudeFile ——
test('claude:cache_creation 单独带出,input=input_tokens+缓存', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg-1',
      model: 'claude-sonnet-5',
      usage: {
        input_tokens: 1000,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 200,
        output_tokens: 500
      }
    },
    timestamp: '2026-08-17T00:00:00.000Z'
  })
  const event = parseClaudeAssistantEvent(line)
  assert.ok(event)
  assert.equal(event.tokens.input, 1300)
  assert.equal(event.tokens.cachedInput, 300)
  assert.equal(event.tokens.cacheCreation, 100)
  assert.equal(event.tokens.output, 500)
})

test('claude:同 message.id 重复行只计一次(去重)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-test-'))
  try {
    const rows = [
      { id: 'msg-1', input: 0, output: 0 }, // 占位
      { id: 'msg-1', input: 0, output: 0 }, // 占位
      { id: 'msg-1', input: 1000, output: 500 }, // 最终块(重放多份)
      { id: 'msg-1', input: 1000, output: 500 },
      { id: 'msg-1', input: 1000, output: 500 }
    ]
    const content = rows
      .map((r) =>
        JSON.stringify({
          type: 'assistant',
          message: {
            id: r.id,
            model: 'claude-sonnet-5',
            usage: { input_tokens: r.input, cache_read_input_tokens: 0, output_tokens: r.output }
          },
          timestamp: '2026-08-17T00:00:00.000Z'
        })
      )
      .join('\n')
    const file = path.join(dir, 's.jsonl')
    await fs.writeFile(file, content, 'utf8')
    const events = await parseClaudeFile(file)
    assert.equal(events.length, 1)
    assert.equal(events[0].tokens.input, 1000)
    assert.equal(events[0].tokens.output, 500)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('claude:去重取有 stop_reason 的代表行', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-test-'))
  try {
    const base = {
      type: 'assistant',
      message: { id: 'msg-2', model: 'm' },
      timestamp: '2026-08-17T00:00:00.000Z'
    }
    const partial = { ...base, message: { ...base.message, usage: { input_tokens: 100, output_tokens: 10 } } }
    const final = {
      ...base,
      message: {
        ...base.message,
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 900 }
      }
    }
    const file = path.join(dir, 's.jsonl')
    await fs.writeFile(file, [JSON.stringify(partial), JSON.stringify(final)].join('\n'), 'utf8')
    const events = await parseClaudeFile(file)
    assert.equal(events.length, 1)
    assert.equal(events[0].tokens.output, 900) // 取了 stop_reason 的最终块
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// —— computeCost:拆 cache_read / cache_creation 计价 ——
const TEST_RATES = {
  'm-fresh': { input: 3, cachedInput: 0.3, output: 15, cacheCreation: 3.75 },
  'm-codex': { input: 3, cachedInput: 0.3, output: 15, cacheCreation: 3.75 },
  'm-nocw': { input: 3, cachedInput: 0.3, output: 15 } // 未配缓存写价
}
setRateLookup((model) => (model ? TEST_RATES[model] : undefined))

test('cost:claude/opencode(fresh 语义)缓存写按独立单价', () => {
  // input 为总输入(含缓存):fresh 1000 + cache_read 1000 + cache_creation 1000
  const delta = { input: 3000, cachedInput: 2000, output: 500, cacheCreation: 1000 }
  const cost = computeCost(delta, 'm-fresh')
  // (1000*3 + 1000*0.3 + 1000*3.75 + 500*15)/1M = 0.01455 → 4 位小数 0.0146
  assert.equal(cost, 0.0146)
})

test('cost:codex(input 含缓存)常规输入=input-cacheRead,cache_creation 缺省为 0', () => {
  const delta = { input: 1200, cachedInput: 200, output: 500 }
  const cost = computeCost(delta, 'm-codex')
  // (1000*3 + 200*0.3 + 500*15)/1M = 0.01056 → 0.0106
  assert.equal(cost, 0.0106)
})

test('cost:未配 cacheCreation 单价时缓存写按缓存读价回落', () => {
  const delta = { input: 3000, cachedInput: 2000, output: 500, cacheCreation: 1000 }
  const cost = computeCost(delta, 'm-nocw')
  // (1000*3 + 1000*0.3 + 1000*0.3 + 500*15)/1M = 0.0111
  assert.equal(cost, 0.0111)
})

test('claude:跨文件全局去重,同 message.id 留 usage 更大的代表', () => {
  const mk = (id, output) => ({
    ts: 1,
    messageId: id,
    tokens: { input: 100, cachedInput: 0, output, reasoning: 0, total: 100 + output }
  })
  const a = mk('msg-x', 10) // 文件 A 的较小输出
  const b = mk('msg-x', 900) // 文件 B 的最终块
  const c = mk(undefined, 5) // 无 id,保留
  const out = dedupClaudeEvents([a, b, c])
  assert.equal(out.length, 2)
  assert.equal(out[0].tokens.output, 900) // 保留了更大的
  assert.equal(out[1], c)
})

// —— buildCodexDelta:优先 last_token_usage ——
test('codex:有 last_token_usage 时直接用其单次用量,不用累计 total 差值', () => {
  const current = { input: 5296108, cachedInput: 5128448, output: 29522, reasoning: 15385, total: 5325630 }
  const lastUsage = {
    input_tokens: 142129,
    cached_input_tokens: 141056,
    output_tokens: 346,
    reasoning_output_tokens: 172,
    total_tokens: 142475
  }
  const delta = buildCodexDelta(current, lastUsage, undefined)
  assert.equal(delta.input, 142129)
  assert.equal(delta.cachedInput, 141056)
  assert.equal(delta.output, 346)
  assert.equal(delta.reasoning, 172)
})

test('codex:last_token_usage 的 cachedInput 钳制不超过 input', () => {
  const current = { input: 5296108, cachedInput: 5128448, output: 29522, reasoning: 15385, total: 5325630 }
  const lastUsage = { input_tokens: 10, cached_input_tokens: 999, output_tokens: 5, total_tokens: 15 }
  const delta = buildCodexDelta(current, lastUsage, undefined)
  assert.equal(delta.input, 10)
  assert.equal(delta.cachedInput, 10) // min(999, 10)
})

test('codex:无 last_token_usage 时回落相邻累计差', () => {
  const current = { input: 100, cachedInput: 50, output: 20, reasoning: 5, total: 150 }
  const prev = { input: 40, cachedInput: 10, output: 10, reasoning: 0, total: 60 }
  const delta = buildCodexDelta(current, undefined, prev)
  assert.equal(delta.input, 60)
  assert.equal(delta.cachedInput, 40)
  assert.equal(delta.output, 10)
  assert.equal(delta.reasoning, 5)
})
