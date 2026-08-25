// codex-status-line 用量偏差诊断脚本(自包含版,无需项目源码)
// 用法: node --experimental-strip-types diagnose-usage.mjs
// 只读 ~/.codex 会话文件,不改任何状态。
// 报告各算法口径的 token 总量,定位与 cc-switch 偏差来源。
// 对照基准: codex-status-line app 报的值(你看到的 360亿) + cc-switch 报的值(15亿)

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const DAY_MS = 86_400_000
const now = Date.now()
const cutoff30 = now - 30 * DAY_MS

// —— 内联扫描逻辑(不依赖项目源码) ——
function resolveSessionPaths() {
  const paths = []
  const codexHome = process.env.CODEX_HOME?.trim()
  const home = os.homedir()
  if (codexHome) {
    const base = codexHome === '~' ? home : path.resolve(codexHome)
    paths.push(path.join(base, 'sessions'))
    paths.push(path.join(base, 'archived_sessions'))
  }
  paths.push(path.join(home, '.codex', 'sessions'))
  paths.push(path.join(home, '.codex', 'archived_sessions'))
  return [...new Set(paths)]
}

async function pathExists(p) {
  try { await fs.access(p); return true } catch { return false }
}

async function collectJsonlFiles(root) {
  const entries = []
  await walk(root, entries)
  return entries
}
async function walk(root, entries) {
  let dirents
  try { dirents = await fs.readdir(root, { withFileTypes: true }) } catch { return }
  for (const d of dirents) {
    const full = path.join(root, d.name)
    if (d.isDirectory()) { await walk(full, entries); continue }
    if (!d.isFile() || !d.name.endsWith('.jsonl')) continue
    try { const st = await fs.stat(full); entries.push({ filePath: full, mtimeMs: st.mtimeMs }) } catch {}
  }
}

function threadIdFromName(filePath) {
  const m = path.basename(filePath).match(/rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)
  return m ? m[1] : null
}

function getNum(o, k) { const v = o?.[k]; return typeof v === 'number' && v >= 0 ? v : undefined }

// 读单个文件的 session_meta(父子关系) + token_count 序列,返回结构化信息
async function analyzeFile(filePath) {
  let content
  try { content = await fs.readFile(filePath, 'utf8') } catch { return null }
  let parent = null, deferred = false, hasMeta = false
  let naiveSum = 0, rawTotalSum = 0, lastSum = 0, prevTotal, events = 0
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue
    let p
    try { p = JSON.parse(line) } catch { continue }
    if (p.type === 'session_meta') {
      const pl = p.payload ?? {}
      const forked = pl.forked_from_id
      const sub = pl.source?.subagent?.thread_spawn?.parent_thread_id
      if (forked && sub && forked !== sub) deferred = true
      else parent = forked ?? sub ?? null
      hasMeta = true
      continue
    }
    if (p.type !== 'event_msg' || p.payload?.type !== 'token_count') continue
    const info = p.payload.info
    if (!info?.total_token_usage) continue
    events++
    const tt = info.total_token_usage.total_tokens ?? 0
    rawTotalSum += tt
    naiveSum += prevTotal !== undefined ? Math.max(0, tt - prevTotal) : tt
    prevTotal = tt
    if (info.last_token_usage) lastSum += info.last_token_usage.total_tokens ?? 0
  }
  return { parent, deferred, hasMeta, events, naiveSum, rawTotalSum, lastSum }
}

console.log('=== 1. 扫描目录 ===')
const roots = resolveSessionPaths()
console.log('  根:', roots.join(' | '))
const byDir = []
for (const root of roots) {
  if (!(await pathExists(root))) continue
  const entries = await collectJsonlFiles(root)
  byDir.push({ root, entries })
  console.log(`  ${root}: ${entries.length} 文件`)
}
const allFiles = byDir.flatMap(d => d.entries)
const recent = allFiles.filter(e => e.mtimeMs >= cutoff30)
console.log(`  30天内: ${recent.length} / 总 ${allFiles.length}`)

console.log('\n=== 2. threadId 跨目录重复(sessions+archived 双份计入?) ===')
const tidLocs = new Map()
for (const e of allFiles) {
  const tid = threadIdFromName(e.filePath)
  if (!tid) continue
  if (!tidLocs.has(tid)) tidLocs.set(tid, [])
  tidLocs.get(tid).push(e.filePath)
}
const crossDup = [...tidLocs.entries()].filter(([, locs]) => locs.length > 1)
console.log(`  唯一 threadId: ${tidLocs.size}`)
console.log(`  多文件同名 threadId: ${crossDup.length}  <-- >0 说明同一会话被多份计入`)
for (const [tid, locs] of crossDup.slice(0, 5)) {
  console.log(`    ${tid.slice(0, 8)}: ${locs.length} 份`)
}

console.log('\n=== 3. 父子会话结构(subagent 重放深度) ===')
let hasParent = 0, deferredCnt = 0, noMeta = 0
const parentRef = new Map()
const perFile = []
for (const e of recent) {
  const a = await analyzeFile(e.filePath)
  if (!a) continue
  perFile.push({ name: path.basename(e.filePath), naive: a.naiveSum, mtime: new Date(e.mtimeMs).toISOString().slice(0, 10) })
  if (!a.hasMeta) noMeta++
  if (a.deferred) deferredCnt++
  if (a.parent) { hasParent++; parentRef.set(a.parent, (parentRef.get(a.parent) ?? 0) + 1) }
}
console.log(`  有 parent 的子会话: ${hasParent}`)
console.log(`  deferred(fork 延迟): ${deferredCnt}`)
console.log(`  无 session_meta: ${noMeta}`)
console.log(`  被引用的父 thread: ${parentRef.size}, 共 ${[...parentRef.values()].reduce((a, b) => a + b, 0)} 个子会话引用`)
const topP = [...parentRef.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
console.log(`  最热 parent(子会话最多): ${topP.map(([t, c]) => t.slice(0, 8) + 'x' + c).join(', ')}`)

console.log('\n=== 4. 各算法口径对比(30天 codex, 不做父子去重) ===')
let naiveSum = 0, rawTotalSum = 0, lastSum = 0
for (const f of perFile) {
  // 已在 analyzeFile 算过,这里重新累加结构里的值
}
// 重新扫一遍累加(避免上面 perFile 没存 rawTotal/last)
let naiveTotal = 0, rawTotal = 0, lastTotal = 0
for (const e of recent) {
  const a = await analyzeFile(e.filePath)
  if (!a) continue
  naiveTotal += a.naiveSum
  rawTotal += a.rawTotalSum
  lastTotal += a.lastSum
}
console.log(`  算法A 累计差(不判重):     ${fmt(naiveTotal)}  <-- 不做任何去重的基线`)
console.log(`  算法B 累计值直求(荒谬):   ${fmt(rawTotal)}  (每条都是文件内累计,严重虚高)`)
console.log(`  算法C last_usage 直求:    ${fmt(lastTotal)}`)

console.log('\n=== 5. 单文件 token 贡献 top10(找异常大文件) ===')
perFile.sort((a, b) => b.naive - a.naive)
for (const f of perFile.slice(0, 10)) {
  console.log(`  ${f.name}: ${fmt(f.naive)}  (${f.mtime})`)
}

console.log('\n=== 6. 偏差定位(关键) ===')
console.log(`  算法A 朴素累计差(不判重) 30天 = ${fmt(naiveTotal)}`)
console.log(`  codex-status-line app 报的值 = (你看到的, 比如 360亿)`)
console.log(`  cc-switch 报的值          = (比如 15亿)`)
console.log('')
console.log(`  判断方向:`)
console.log(`  - 若 app 报的值 ≈ 算法A 朴素值: 说明 app 的父子去重完全失效(subagent 重放没被跳过)`)
console.log(`  - 若 app 报的值 << 算法A 朴素值 但 >> cc-switch: 说明 app 去重生效但不如 cc-switch 激进`)
console.log(`  - 若算法A 远大于 app 报的值: 去 cc-switch 那边查(它可能额外去重或漏扫)`)
console.log(`  本机基线参考: 朴素/项目去重后 ≈ 2.8x(去重压掉 ~65%)`)
console.log('')
console.log(`  请把以上全部输出贴回, 重点带: app 报的实际数字 + 第3节父子结构 + 第5节 top文件`)

function fmt(n) {
  n = Number(n || 0)
  if (n >= 1e8) return (n / 1e8).toFixed(2) + '亿'
  if (n >= 1e4) return (n / 1e4).toFixed(1) + '万'
  return String(n)
}
