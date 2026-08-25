// codex 用量去重验证脚本(自包含,对齐 cc-switch mark_deferred 逻辑)
// 用法: node --experimental-strip-types verify-dedup-fix.mjs
// 对比"修复前(孤儿全量计入)" vs "修复后(孤儿跳过)" 两个口径
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const DAY_MS = 86_400_000
const cutoff30 = Date.now() - 30 * DAY_MS

const roots = [
  path.join(os.homedir(), '.codex', 'sessions'),
  path.join(os.homedir(), '.codex', 'archived_sessions')
]
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
for (const r of roots) await collect(r, all)
const recent = []
for (const f of all) {
  try { const st = await fs.stat(f); if (st.mtimeMs >= cutoff30) recent.push(f) } catch {}
}

// 文件名 UUID 集合
const fileTids = new Set()
for (const f of recent) {
  const m = path.basename(f).match(/rollout-.*-([0-9a-f-]{36})\.jsonl$/i)
  if (m) fileTids.add(m[1])
}

// 解析每个文件:parent + events
function getStr(o, k) { const v = o?.[k]; return typeof v === 'string' && v.trim() ? v.trim() : undefined }
function getNum(o, k) { const v = o?.[k]; return typeof v === 'number' && v >= 0 ? v : undefined }

async function parseFile(f) {
  const threadId = path.basename(f).match(/rollout-.*-([0-9a-f-]{36})\.jsonl$/i)?.[1] ?? null
  let content
  try { content = await fs.readFile(f, 'utf8') } catch { return null }
  let parent = null, deferred = false, rootTs = undefined
  const events = []
  let prevTotal = undefined
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue
    let p
    try { p = JSON.parse(line) } catch { continue }
    if (p.type === 'session_meta') {
      const pl = p.payload ?? {}
      const forked = getStr(pl, 'forked_from_id')
      const sub = pl.source?.subagent?.thread_spawn?.parent_thread_id
      if (forked && sub && forked !== sub) deferred = true
      else parent = forked ?? sub ?? null
      const tsRaw = getStr(pl, 'timestamp') || getStr(p, 'timestamp')
      if (tsRaw && rootTs === undefined) rootTs = Date.parse(tsRaw)
      continue
    }
    if (p.type === 'event_msg' && p.payload?.type === 'token_count') {
      const info = p.payload.info
      if (!info?.total_token_usage) continue
      const tt = info.total_token_usage
      const total = getNum(tt, 'total_tokens') ?? 0
      const input = getNum(tt, 'input_tokens') ?? 0
      const last = info.last_token_usage
      let delta
      if (last) {
        delta = { input: getNum(last, 'input_tokens') ?? 0, output: getNum(last, 'output_tokens') ?? 0 }
      } else {
        delta = prevTotal ? { input: Math.max(0, input - prevTotal.input), output: Math.max(0, (getNum(tt,'output_tokens')??0) - prevTotal.output) } : { input, output: getNum(tt,'output_tokens') ?? 0 }
      }
      prevTotal = { input, output: getNum(tt, 'output_tokens') ?? 0 }
      const tsRaw = getStr(p, 'timestamp')
      const ts = tsRaw ? Date.parse(tsRaw) : 0
      events.push({ ts, delta })
    }
  }
  return { threadId, parent, deferred, rootTs, events }
}

const parsed = []
let naiveTotal = 0  // 修复前:所有文件全量计入(孤儿也全算)
let orphanCount = 0, orphanToken = 0
for (const f of recent) {
  const p = await parseFile(f)
  if (!p || p.events.length === 0) continue
  parsed.push(p)
  for (const e of p.events) naiveTotal += e.delta.input + e.delta.output
  // 统计孤儿
  if (p.parent && !p.deferred && p.rootTs !== undefined && !fileTids.has(p.parent)) {
    orphanCount++
    orphanToken += p.events.reduce((s, e) => s + e.delta.input + e.delta.output, 0)
  }
}

console.log(`扫描到 ${recent.length} 个文件(30天)\n`)
console.log('=== 孤儿 subagent 统计 ===')
console.log(`  孤儿子会话(父文件不在): ${orphanCount} 个`)
console.log(`  孤儿 token 总量: ${fmt(orphanToken)}`)
console.log('')
console.log('=== 修复前 vs 修复后(30天 codex) ===')
console.log(`  修复前(孤儿全量计入): ${fmt(naiveTotal)}`)
console.log(`  修复后(孤儿跳过):     ${fmt(naiveTotal - orphanToken)}`)
console.log(`  差值:                 ${fmt(orphanToken)} (${orphanCount} 个孤儿)`)
console.log('')
console.log(`  注:修复后 = 修复前 - 孤儿token`)
console.log(`  cc-switch 也跳过孤儿(mark_deferred), 修复后应接近 cc-switch 报值`)

function fmt(n) {
  n = Number(n || 0)
  if (n >= 1e8) return (n / 1e8).toFixed(2) + '亿'
  if (n >= 1e4) return (n / 1e4).toFixed(1) + '万'
  return String(n)
}
