import assert from 'node:assert/strict'
import { parsePiEntryLine } from '../src/main/services/agents.ts'

// 1) Anthropic 风格:并列字段(input 不含缓存),totalTokens = input+output+cacheRead+cacheWrite
const anthropicLine = JSON.stringify({
  type: 'message',
  id: 'e1',
  parentId: null,
  timestamp: '2026-08-20T10:00:00.000Z',
  message: {
    role: 'assistant',
    model: 'claude-sonnet-4',
    usage: {
      input: 100,
      output: 50,
      cacheRead: 200,
      cacheWrite: 30,
      reasoning: 10,
      totalTokens: 380,
      cost: { total: 0.012 }
    }
  }
})
const e1 = parsePiEntryLine(anthropicLine)
assert.ok(e1, 'anthropic line should parse')
assert.equal(e1.tokens.input, 330, 'input = raw + cacheRead + cacheWrite')
assert.equal(e1.tokens.cachedInput, 230)
assert.equal(e1.tokens.output, 50)
assert.equal(e1.tokens.reasoning, 10)
assert.equal(e1.tokens.total, 380)
assert.equal(e1.tokens.cacheCreation, 30)
assert.equal(e1.costUsd, 0.012)
assert.equal(e1.model, 'claude-sonnet-4')
assert.ok(e1.ts > 0)

// 2) OpenAI 风格:input 已含缓存,totalTokens = input+output
const openaiLine = JSON.stringify({
  type: 'message',
  id: 'e2',
  parentId: null,
  timestamp: '2026-08-20T11:00:00.000Z',
  message: {
    role: 'assistant',
    model: 'gpt-5',
    usage: { input: 500, output: 100, cacheRead: 200, cacheWrite: 0, totalTokens: 600 }
  }
})
const e2 = parsePiEntryLine(openaiLine)
assert.ok(e2, 'openai line should parse')
assert.equal(e2.tokens.input, 500, 'inclusive: input not double-counted')
assert.equal(e2.tokens.cachedInput, 0)
assert.equal(e2.tokens.total, 600)
assert.equal(e2.tokens.cacheCreation, undefined)

// 3) compaction 条目带 usage,时间取 entry 级 timestamp
const compactionLine = JSON.stringify({
  type: 'compaction',
  id: 'e3',
  parentId: 'e2',
  timestamp: '2026-08-21T10:00:00.000Z',
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }
})
const e3 = parsePiEntryLine(compactionLine)
assert.ok(e3, 'compaction should parse')
assert.equal(e3.tokens.total, 15)
assert.ok(e1.ts !== e3.ts)

// 4) user 消息/无 usage 行 → 忽略
assert.equal(parsePiEntryLine(JSON.stringify({ type: 'message', timestamp: '2026-08-20T10:00:00Z', message: { role: 'user' } })), undefined)
assert.equal(parsePiEntryLine('not-json'), undefined)

console.log('parsePiEntryLine: 全部断言通过 ✓')