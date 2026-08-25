// 精准诊断:8-24 那批文件 session_meta 的完整结构
// 用法: node --experimental-strip-types diag-meta.mjs
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const SESSIONS = path.join(os.homedir(), '.codex', 'sessions')
const ARCHIVE = path.join(os.homedir(), '.codex', 'archived_sessions')

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

// 找 8-24 文件(或最近的大文件)
const targets = []
for (const f of all) {
  const name = path.basename(f)
  // 优先 8-24,否则取最近 30 天大文件
  if (!name.includes('2026-08-24')) continue
  targets.push(f)
}
// 若无 8-24,取最大的 5 个文件
if (targets.length === 0) {
  const sized = []
  for (const f of all) {
    try {
      const st = await fs.stat(f)
      sized.push({ f, size: st.size })
    } catch {}
  }
  sized.sort((a, b) => b.size - a.size)
  targets.push(...sized.slice(0, 5).map(s => s.f))
}

console.log(`检查 ${targets.length} 个文件\n`)

for (const f of targets.slice(0, 5)) {
  const name = path.basename(f)
  const fileTid = name.match(/rollout-.*-([0-9a-f-]{36})\.jsonl$/i)?.[1] ?? null
  console.log(`=== ${name.slice(-30)} ===`)
  console.log(`  文件名 UUID: ${fileTid}`)
  let content
  try { content = await fs.readFile(f, 'utf8') } catch { console.log('  读取失败'); continue }
  // 找第一条 session_meta
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue
    let p
    try { p = JSON.parse(line) } catch { continue }
    if (p.type === 'session_meta') {
      const pl = p.payload ?? {}
      console.log(`  payload.id:        ${pl.id ?? '(无)'}`)
      console.log(`  payload.session_id: ${pl.session_id ?? '(无)'}`)
      console.log(`  forked_from_id:   ${pl.forked_from_id ?? '(无)'}`)
      console.log(`  thread_source:    ${pl.thread_source ?? '(无)'}`)
      const sub = pl.source?.subagent
      console.log(`  source.subagent:  ${sub ? '有' : '(无)'}`)
      if (sub) {
        console.log(`    parent_thread_id: ${sub.thread_spawn?.parent_thread_id ?? '(无)'}`)
      }
      console.log(`  timestamp:        ${p.timestamp ?? pl.timestamp ?? '(无)'}`)
      // dump payload 所有顶层 key
      console.log(`  payload 所有字段: ${Object.keys(pl).join(', ')}`)
      // dump 完整 payload(前 800 字符)
      console.log(`  payload 完整(前800字符):`)
      console.log(`    ${JSON.stringify(pl).slice(0, 800)}`)
      break
    }
  }
  console.log('')
}
