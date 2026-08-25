// 针对性诊断:深挖 8-24 那批同秒巨文件的相互关系
// 用法: node --experimental-strip-types diagnose-replay.mjs
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const SESSIONS = path.join(os.homedir(), '.codex', 'sessions')
const ARCHIVE = path.join(os.homedir(), '.codex', 'archived_sessions')

// 收集所有 jsonl
async function collect(root, out) {
  let d
  try { d = await fs.readdir(root, { withFileTypes: true }) } catch { return }
  for (const e of d) {
    const full = path.join(root, e.name)
    if (e.isDirectory()) { await collect(full, out); continue }
    if (e.name.endsWith('.jsonl')) out.push(full)
  }
}
const all = []
await collect(SESSIONS, all)
await collect(ARCHIVE, all)

// 找 8-24 的文件 + 每个文件的 meta 信息
const targets = []
for (const f of all) {
  const name = path.basename(f)
  if (!name.startsWith('rollout-2026-08-24')) continue
  const tid = name.match(/rollout-.*-([0-9a-f-]{36})\.jsonl$/i)?.[1] ?? null
  let content
  try { content = await fs.readFile(f, 'utf8') } catch { continue }
  let parent = null, deferred = false, metaId = null, firstTs = null, eventCount = 0
  let firstTotal = null, lastTotal = null
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue
    let p
    try { p = JSON.parse(line) } catch { continue }
    if (p.type === 'session_meta') {
      const pl = p.payload ?? {}
      metaId = pl.id ?? null
      const forked = pl.forked_from_id
      const sub = pl.source?.subagent?.thread_spawn?.parent_thread_id
      if (forked && sub && forked !== sub) deferred = true
      else parent = forked ?? sub ?? null
      const ts = p.timestamp ?? pl.timestamp
      if (ts) firstTs = ts
      continue
    }
    if (p.type === 'event_msg' && p.payload?.type === 'token_count') {
      eventCount++
      const tt = p.payload.info?.total_token_usage?.total_tokens
      if (tt !== undefined) {
        if (firstTotal === null) firstTotal = tt
        lastTotal = tt
      }
    }
  }
  targets.push({ file: name, tid, metaId, parent, deferred, firstTs, eventCount, firstTotal, lastTotal })
}

targets.sort((a, b) => (a.firstTs ?? '').localeCompare(b.firstTs ?? ''))

console.log(`=== 8-24 同批文件: ${targets.length} 个 ===\n`)
console.log('文件名(尾8位) | metaId | parent | deferred | firstTotal | lastTotal | 增量(差) | events')
console.log('-'.repeat(110))
for (const t of targets) {
  const inc = (t.firstTotal !== null && t.lastTotal !== null) ? (t.lastTotal - t.firstTotal) : null
  console.log(
    `${tid8(t.tid)} | ${tid8(t.metaId)} | ${tid8(t.parent)} | ${t.deferred ? 'Y' : 'N'} | ${fmt(t.firstTotal)} | ${fmt(t.lastTotal)} | ${fmt(inc)} | ${t.eventCount}`
  )
}

// 看 parent 之间的引用关系
console.log('\n=== parent 引用关系 ===')
const parentSet = new Set(targets.map(t => t.parent).filter(Boolean))
console.log(`不同的 parent 值: ${[...parentSet].map(p => p.slice(0, 8)).join(', ')}`)
console.log(`这些 parent 是否在 8-24 文件里有对应 metaId?`)
for (const p of parentSet) {
  const match = targets.find(t => t.metaId === p)
  console.log(`  parent ${p.slice(0, 8)}: ${match ? '在本批有对应文件 ' + match.file.slice(-20) : '不在本批(外部父)'}`)
}

// 关键:看这些文件 firstTotal 是否都很大(说明各自从父会话重放了巨大上下文)
console.log('\n=== 关键诊断 ===')
const bigFirst = targets.filter(t => t.firstTotal !== null && t.firstTotal > 1e8)
console.log(`firstTotal > 1亿的文件: ${bigFirst.length} / ${targets.length}`)
console.log(`(firstTotal 是文件第一条 token_count 的累计值, 若很大说明文件开头就重放了父上下文)`)
const allInc = targets.reduce((a, t) => a + ((t.lastTotal ?? 0) - (t.firstTotal ?? 0)), 0)
console.log(`所有文件"内部增量"(lastTotal - firstTotal)之和: ${fmt(allInc)}`)
console.log(`vs 朴素累计差(含每条): ${fmt(targets.reduce((a, t) => a + (t.lastTotal ?? 0), 0))}`)

function tid8(s) { return s ? s.slice(0, 8) : '(none)' }
function fmt(n) {
  n = Number(n || 0)
  if (n >= 1e8) return (n / 1e8).toFixed(2) + '亿'
  if (n >= 1e4) return (n / 1e4).toFixed(1) + '万'
  return String(n)
}
