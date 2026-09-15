/* eslint-disable @typescript-eslint/explicit-function-return-type */
// 固定同一状态与补丁，比较旧整会话复制和生产路径复制；不连接真实 Codex。
import assert from 'node:assert/strict'
import { applyStatePatches } from '../src/main/services/codex-ipc-client.ts'

const ITERATIONS = 40
const MIB = 1024 * 1024
const patch = { op: 'replace', path: ['active', 'text'], value: 'next' }

function originalSingleReplace(source) {
  const result = structuredClone(source)
  result.active.text = patch.value
  return result
}

function measure(run, source) {
  for (let i = 0; i < 3; i++) run(source)
  const start = performance.now()
  const cpu = process.cpuUsage()
  let result
  for (let i = 0; i < ITERATIONS; i++) result = run(source)
  const elapsed = performance.now() - start
  const used = process.cpuUsage(cpu)
  assert.equal(result.active.text, 'next')
  assert.equal(source.active.text, 'previous')
  return { wallMs: +elapsed.toFixed(2), cpuMs: +((used.user + used.system) / 1000).toFixed(2) }
}

for (const historyMiB of [1, 8, 16]) {
  const source = { archive: { text: 'x'.repeat(historyMiB * MIB) }, active: { text: 'previous' } }
  const baseline = measure(originalSingleReplace, source)
  const optimized = measure((value) => applyStatePatches(value, [patch]), source)
  console.log(JSON.stringify({ historyMiB, iterations: ITERATIONS, baseline, optimized }))
}
