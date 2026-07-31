import { DEFAULT_IQ_THRESHOLD, MAX_IQ_THRESHOLD, MIN_IQ_THRESHOLD } from '../../shared/capsule'
import { net } from 'electron'

const RADAR_URL = 'https://codex-reset-radar.pages.dev/current.json'
const RADAR_TIMEOUT_MS = 8000
const RADAR_CACHE_TTL_MS = 10 * 60 * 1000
// radar 独立定时周期:与缓存 TTL 对齐,到期就强制重拉(不再跟随额度刷新节奏)
const RADAR_TICK_MS = RADAR_CACHE_TTL_MS

interface RadarModelEntry {
  label: string
  model: string
  effort: string
  score: number
  averageCostUsd: number
  averageTaskSeconds: number
  status: 'green' | 'yellow' | 'red'
}

export interface RadarBestPick {
  label: string
  shortLabel: string
  score: number
  averageCostUsd: number
  averageTaskMinutes: number
  status: 'green' | 'yellow' | 'red'
  threshold: number
  updatedAt?: string
}

interface RawCacheEntry {
  entries: RadarModelEntry[]
  updatedAt?: string
  fetchedAtMs: number
}

let rawCache: RawCacheEntry | undefined

// 走 Electron net(Chromium 网络栈),跟随系统代理,与浏览器行为一致
export async function fetchRadarBestPick(
  minScore: number = DEFAULT_IQ_THRESHOLD
): Promise<RadarBestPick | undefined> {
  const threshold = clampThreshold(minScore)
  const now = Date.now()
  let entries = rawCache?.entries
  let updatedAt = rawCache?.updatedAt

  if (!rawCache || now - rawCache.fetchedAtMs >= RADAR_CACHE_TTL_MS) {
    const fetched = await fetchRawEntries()
    if (fetched) {
      entries = fetched.entries
      updatedAt = fetched.updatedAt
      rawCache = { entries, updatedAt, fetchedAtMs: now }
    } else if (!entries) {
      return undefined
    }
  }

  return pickBest(entries!, threshold, updatedAt)
}

function clampThreshold(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_IQ_THRESHOLD
  return Math.min(MAX_IQ_THRESHOLD, Math.max(MIN_IQ_THRESHOLD, Math.round(value)))
}

async function fetchRawEntries(): Promise<{ entries: RadarModelEntry[]; updatedAt?: string } | undefined> {
  try {
    const response = await Promise.race([
      net.fetch(RADAR_URL, { headers: { Accept: 'application/json' } }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), RADAR_TIMEOUT_MS)
      )
    ]) as Response
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = (await response.json()) as unknown
    return parseComparisons(data)
  } catch (error) {
    console.warn('[codex-status] radar fetch failed:', error instanceof Error ? error.message : error)
    return undefined
  }
}

function parseComparisons(response: unknown): { entries: RadarModelEntry[]; updatedAt?: string } | undefined {
  const body = getRecord(response)
  const modelIq = getRecord(body?.model_iq)
  const comparisons = modelIq?.comparisons
  if (!comparisons || typeof comparisons !== 'object') {
    console.warn('[codex-status] radar parse: comparisons missing, model_iq keys:', modelIq ? Object.keys(modelIq) : 'model_iq missing')
    return undefined
  }

  const entries: RadarModelEntry[] = []
  for (const value of Object.values(comparisons as Record<string, unknown>)) {
    const record = getRecord(value)
    const latest = getRecord(record?.latest)
    if (!latest) continue
    const score = getNumber(latest.score)
    const cost = getNumber(latest.average_cost_usd)
    const taskSec = getNumber(latest.average_task_seconds)
    const model = getString(latest.model)
    const effort = getString(latest.reasoning_effort)
    const label = getString(record?.label)
    const statusRaw = getString(latest.status)
    const status =
      statusRaw === 'green' || statusRaw === 'yellow' || statusRaw === 'red' ? statusRaw : 'yellow'
    if (
      score === undefined ||
      cost === undefined ||
      taskSec === undefined ||
      !label ||
      !model ||
      !effort
    ) continue
    entries.push({ label, model, effort, score, averageCostUsd: cost, averageTaskSeconds: taskSec, status })
  }
  return { entries, updatedAt: getString(modelIq?.updated_at) }
}

interface Extremes {
  minScore: number
  maxScore: number
  minCost: number
  maxCost: number
  minTaskSec: number
  maxTaskSec: number
}

function pickBest(
  entries: RadarModelEntry[],
  minScore: number,
  updatedAt?: string
): RadarBestPick | undefined {
  if (entries.length === 0) return undefined

  let threshold = minScore
  let qualified = entries.filter((e) => e.score >= threshold)
  while (qualified.length === 0) {
    threshold--
    qualified = entries.filter((e) => e.score >= threshold)
  }
  if (threshold < minScore) {
    console.warn(
      `[codex-status] radar: no model above IQ ${minScore}, auto-lowered to ${threshold} (${qualified.length} candidates)`
    )
  }

  const ext = calcExtremes(qualified)
  const scored = qualified.map((e) => ({
    entry: e,
    final: compositeScore(e, ext)
  }))
  scored.sort((a, b) => b.final - a.final)
  const best = scored[0]

  return {
    label: best.entry.label,
    shortLabel: shortenLabel(best.entry.label),
    score: best.entry.score,
    averageCostUsd: best.entry.averageCostUsd,
    averageTaskMinutes: Math.max(1, Math.round(best.entry.averageTaskSeconds / 60)),
    status: best.entry.status,
    threshold,
    updatedAt
  }
}

function calcExtremes(entries: RadarModelEntry[]): Extremes {
  let minScore = Infinity, maxScore = -Infinity
  let minCost = Infinity, maxCost = -Infinity
  let minTaskSec = Infinity, maxTaskSec = -Infinity
  for (const e of entries) {
    if (e.score < minScore) minScore = e.score
    if (e.score > maxScore) maxScore = e.score
    if (e.averageCostUsd < minCost) minCost = e.averageCostUsd
    if (e.averageCostUsd > maxCost) maxCost = e.averageCostUsd
    if (e.averageTaskSeconds < minTaskSec) minTaskSec = e.averageTaskSeconds
    if (e.averageTaskSeconds > maxTaskSec) maxTaskSec = e.averageTaskSeconds
  }
  return { minScore, maxScore, minCost, maxCost, minTaskSec, maxTaskSec }
}

function compositeScore(entry: RadarModelEntry, ext: Extremes): number {
  const perf = normalizePositive(entry.score, ext.minScore, ext.maxScore)
  const model = calcModelFamily(entry.label)
  const price = normalizeReverse(entry.averageCostUsd, ext.minCost, ext.maxCost)
  const time = normalizeReverse(entry.averageTaskSeconds, ext.minTaskSec, ext.maxTaskSec)
  // 表现分 50% + 模型分 5% + 价格分 40% + 时间分 5%
  return perf * 0.5 + model * 0.05 + price * 0.4 + time * 0.05
}

function normalizePositive(value: number, min: number, max: number): number {
  if (max === min) return 100
  return ((value - min) / (max - min)) * 100
}

function normalizeReverse(value: number, min: number, max: number): number {
  if (max === min) return 100
  return ((max - value) / (max - min)) * 100
}

function calcModelFamily(label: string): number {
  const lower = label.toLowerCase()
  if (lower.includes('sol')) return 100
  if (/gpt-5\.5/i.test(lower)) return 90
  if (lower.includes('terra')) return 80
  if (lower.includes('luna')) return 60
  return 50
}

// 让设置面板更改阈值时能立即得到新的pick(基于已缓存数据)
export function invalidateRadarCache(): void {
  rawCache = undefined
}

// radar 独立定时:不再跟随额度刷新,由主进程按 RADAR_TICK_MS 自行节拍
let radarTimer: NodeJS.Timeout | undefined
let radarHandler: ((pick: RadarBestPick | undefined) => void) | undefined
let radarThreshold = DEFAULT_IQ_THRESHOLD

export function startRadarTimer(
  threshold: number,
  handler: (pick: RadarBestPick | undefined) => void
): void {
  stopRadarTimer()
  radarThreshold = clampThreshold(threshold)
  radarHandler = handler
  // 首次立即拉一次,后续按周期定时
  void tickRadar()
  radarTimer = setInterval(() => void tickRadar(), RADAR_TICK_MS)
}

export function stopRadarTimer(): void {
  if (radarTimer) {
    clearInterval(radarTimer)
    radarTimer = undefined
  }
  radarHandler = undefined
}

// IQ 阈值变更:更新阈值并清缓存强制走网络立即重拉一次
export async function refreshRadarNow(threshold: number): Promise<RadarBestPick | undefined> {
  radarThreshold = clampThreshold(threshold)
  invalidateRadarCache()
  return await tickRadar()
}

async function tickRadar(): Promise<RadarBestPick | undefined> {
  const pick = await fetchRadarBestPick(radarThreshold).catch(() => undefined)
  radarHandler?.(pick)
  return pick
}

function shortenLabel(label: string): string {
  return label.replace(/^GPT-[\d.]+\s+/i, '').trim()
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function getNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}
