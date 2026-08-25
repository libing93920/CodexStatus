// 确认根因:统计 subagent 子会话找不到父的数量
// 用法: node --experimental-strip-types check-missing-parent.mjs
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

// 文件名 UUID 集合(用于判断父文件在不在)
const fileTids = new Set()
for (const f of recent) {
  const m = path.basename(f).match(/rollout-.*-([0-9a-f-]{36})\.jsonl$/i)
  if (m) fileTids.add(m[1])
}

// 逐文件提取 parent(forked_from_id 或 thread_spawn.parent_thread_id)
let hasParent = 0, noParent = 0, parentMissing = 0, parentPresent = 0
const missingParentFiles = []
for (const f of recent) {
  let content
  try { content = await fs.readFile(f, 'utf8') } catch { continue }
  let parent = null
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue
    let p
    try { p = JSON.parse(line) } catch { continue }
    if (p.type !== 'session_meta') continue
    const pl = p.payload ?? {}
    const forked = pl.forked_from_id
    const sub = pl.source?.subagent?.thread_spawn?.parent_thread_id
    parent = forked ?? sub ?? null
    break
  }
  if (parent) {
    hasParent++
    if (fileTids.has(parent)) parentPresent++
    else {
      parentMissing++
      missingParentFiles.push({ file: path.basename(f).slice(-30), parent: parent.slice(0, 8) })
    }
  } else {
    noParent++
  }
}

console.log(`=== subagent 父文件存在性(30天 ${recent.length} 文件) ===`)
console.log(`  无 parent(主会话/guardian): ${noParent}`)
console.log(`  有 parent(subagent): ${hasParent}`)
console.log(`    父文件在扫描集: ${parentPresent}`)
console.log(`    父文件不在(找不到父): ${parentMissing}  <-- cc-switch 挂起不报,项目全量计入`)
console.log('')
console.log(`=== 找不到父的子会话样例 ===`)
for (const m of missingParentFiles.slice(0, 10)) {
  console.log(`  ${m.file} → 父 ${m.parent} 不在`)
}
console.log('')
console.log(`=== 根因判断 ===`)
if (parentMissing > 0) {
  console.log(`  ${parentMissing} 个 subagent 子会话找不到父文件`)
  console.log(`  cc-switch: mark_deferred 挂起,不计 token → 少报`)
  console.log(`  本项目: skipPrefix=0 全量计入 → 多报`)
  console.log(`  这就是 ${parentMissing} 个子会话 × 各自15亿 = ${(parentMissing * 15).toFixed(0)}亿 偏差来源`)
}
