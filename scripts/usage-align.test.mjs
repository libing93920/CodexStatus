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
import { buildCodexDelta, dedupClaudeEvents, dedupParsedFiles } from '../src/main/services/usage.ts'

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

test('codex:无 last_token_usage 时回落累计差(高水位只增不减)', () => {
  const current = { input: 100, cachedInput: 50, output: 20, reasoning: 5, total: 150 }
  const highWater = { input: 40, cachedInput: 10, output: 10, reasoning: 0, total: 60 }
  const delta = buildCodexDelta(current, undefined, highWater)
  assert.equal(delta.input, 60)
  assert.equal(delta.cachedInput, 40)
  assert.equal(delta.output, 10)
  assert.equal(delta.reasoning, 5)
})

test('codex:total 回退时高水位不跟着回退,避免重复计入(lane 切换场景)', () => {
  // 第一个事件 total=150,第二个 total 回退到 80(rate-limit lane 切换重新累计),
  // 第三个 total=180(在 80 基础上重新累加)。用相邻 prev 会把 180-80=100 计入,
  // 但其中 80 已在第一个事件计入过,应只计 180-150=30。高水位保证这点。
  const highWater = { input: 150, cachedInput: 0, output: 0, reasoning: 0, total: 150 }
  const afterRollback = { input: 180, cachedInput: 0, output: 0, reasoning: 0, total: 180 }
  const delta = buildCodexDelta(afterRollback, undefined, highWater)
  assert.equal(delta.input, 30) // 180 - 150(高水位),不是 180 - 80
})

// —— dedupParsedFiles:父子去重(对齐 cc-switch session_usage_codex.rs) ——
// mkFile 构造 ParsedFile,含父时间线完整性字段(对齐 cc-switch ParentTokenTimeline)
function mkSigEvent(ts, total) {
  return {
    ts,
    sig: { total: { input: total, cachedInput: 0, output: 0, reasoning: 0, total } },
    delta: { input: total, cachedInput: 0, output: 0, reasoning: 0, total },
    model: undefined
  }
}
function mkFile(events, opts = {}) {
  return {
    parent: opts.parent,
    deferred: opts.deferred ?? false,
    rootTs: opts.rootTs,
    events,
    hasTokenWithoutTimestamp: opts.hasTokenWithoutTimestamp ?? false,
    maxTimestamp: opts.maxTimestamp ?? (events.length > 0 ? events[events.length - 1].ts : undefined)
  }
}

test('codex:真孤儿 subagent(父文件不在扫描集)整体跳过', () => {
  // 父文件不在 byThread → 跳过整个子会话(对齐 cc-switch mark_deferred)
  const child = mkFile([mkSigEvent(2000, 100), mkSigEvent(2100, 200)], { parent: 'PARENT-UUID', rootTs: 2000 })
  const events = dedupParsedFiles([{ threadId: 'CHILD-UUID', file: child }])
  assert.equal(events.length, 0)
})

test('codex:父在但无签名时子会话挂起跳过(对齐 cc-switch mark_deferred)', () => {
  // 父文件在扫描集但没解析出 events(byThread 没有),挂起跳过
  const child = mkFile([mkSigEvent(2000, 100), mkSigEvent(2100, 200)], { parent: 'PARENT-UUID', rootTs: 2000 })
  const events = dedupParsedFiles([{ threadId: 'CHILD-UUID', file: child }])
  assert.equal(events.length, 0)
})

test('codex:父时间线缺 timestamp → 子会话挂起跳过(对齐 cc-switch L155-159)', () => {
  // 父有 events 但 hasTokenWithoutTimestamp=true → 父时间线不可用 → 子 skipAll
  const parent = mkFile([mkSigEvent(1000, 100)], { maxTimestamp: 1000, hasTokenWithoutTimestamp: true })
  const child = mkFile([mkSigEvent(2000, 200)], { parent: 'PARENT-UUID', rootTs: 2000 })
  const events = dedupParsedFiles([
    { threadId: 'PARENT-UUID', file: parent },
    { threadId: 'CHILD-UUID', file: child }
  ])
  assert.equal(events.length, 1) // 只有父计入,子跳过
  assert.equal(events[0].tokens.input, 100)
})

test('codex:父 maxTimestamp < 子 rootTs → 子会话挂起跳过(对齐 cc-switch L161-168)', () => {
  // 父最大 ts=1500 < 子 rootTs=2000 → 父尚未写到 fork 时刻 → 子 skipAll
  const parent = mkFile([mkSigEvent(1000, 100), mkSigEvent(1500, 200)], { maxTimestamp: 1500 })
  const child = mkFile([mkSigEvent(2000, 300)], { parent: 'PARENT-UUID', rootTs: 2000 })
  const events = dedupParsedFiles([
    { threadId: 'PARENT-UUID', file: parent },
    { threadId: 'CHILD-UUID', file: child }
  ])
  assert.equal(events.length, 2) // 只有父计入,子跳过
})

test('codex:父文件在时子会话前缀去重保留增量', () => {
  const parent = mkFile(
    [mkSigEvent(1000, 100), mkSigEvent(1100, 200), mkSigEvent(1200, 300)],
    { maxTimestamp: 2500 } // 父时间线覆盖子 fork 时刻(rootTs=2000)
  )
  // 子会话前2个事件与父签名相同(重放),第3个是新工作
  const child = mkFile(
    [mkSigEvent(2000, 100), mkSigEvent(2100, 200), mkSigEvent(2200, 999)],
    { parent: 'PARENT-UUID', rootTs: 2000 }
  )
  const events = dedupParsedFiles([
    { threadId: 'PARENT-UUID', file: parent },
    { threadId: 'CHILD-UUID', file: child }
  ])
  // 父全计(3) + 子前缀跳2留1(999)
  assert.equal(events.length, 4)
  assert.equal(events.reduce((s, e) => s + e.tokens.input, 0), 100 + 200 + 300 + 999)
})

test('codex:无 parent 的主会话全量计入', () => {
  const main = mkFile([mkSigEvent(1000, 500), mkSigEvent(1100, 600)], { rootTs: 1000 })
  const events = dedupParsedFiles([{ threadId: 'MAIN', file: main }])
  assert.equal(events.length, 2)
  assert.equal(events.reduce((s, e) => s + e.tokens.input, 0), 1100)
})

test('codex:deferred 文件(meta 异常)整个跳过,不全量计入', () => {
  // cc-switch:ParentResolution::Deferred → mark_deferred,整个文件不计入(L1206-1213)
  // deferred 文件 parent 恒为 undefined,但 deferred=true 必须触发 skipAll,不能落入全量计入
  const child = mkFile(
    [mkSigEvent(2000, 100), mkSigEvent(2100, 200)],
    { parent: undefined, deferred: true, rootTs: 2000 }
  )
  const events = dedupParsedFiles([{ threadId: 'CHILD', file: child }])
  assert.equal(events.length, 0) // deferred → 整个跳过,0 事件
})

test('codex:有 parent 但 rootTs 缺失 → 跳过整个文件', () => {
  // cc-switch:有 parent 但 root meta 缺 timestamp → mark_deferred(L1215-1223)
  const child = mkFile(
    [mkSigEvent(2000, 100), mkSigEvent(2100, 200)],
    { parent: 'PARENT-UUID', rootTs: undefined }
  )
  const events = dedupParsedFiles([{ threadId: 'CHILD', file: child }])
  assert.equal(events.length, 0)
})
