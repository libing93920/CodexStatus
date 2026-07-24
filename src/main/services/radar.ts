import { DEFAULT_IQ_THRESHOLD, MAX_IQ_THRESHOLD, MIN_IQ_THRESHOLD } from '../../shared/capsule'

const RADAR_URL = 'https://codex-reset-radar.pages.dev/current.json'
const RADAR_TIMEOUT_MS = 8000
const RADAR_CACHE_TTL_MS = 10 * 60 * 1000

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

// 公开数据走全局 fetch (Node 24 原生,不走 Electron net/代理):
// codex-reset-radar 是 Cloudflare Pages 静态站点,不需要鉴权/cookie/系统代理;
// Electron net 在部分代理环境对 Cloudflare 可能握手异常,Node fetch 实测稳定。
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
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), RADAR_TIMEOUT_MS)
    const response = await globalThis.fetch(RADAR_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    })
    clearTimeout(timer)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = (await response.json()) as unknown
    const parsed = parseComparisons(data)
    return parsed
  } catch (error) {
    console.warn('[codex-status] radar fetch failed:', error instanceof Error ? error.message : error)
    return undefined
  }
}

function parseComparisons(response: unknown): { entries: RadarModelEntry[]; updatedAt?: string } | undefined {
  const body = getRecord(response)
  const modelIq = getRecord(body?.model_iq)
  const comparisons = modelIq?.comparisons
  if (!comparisons || typeof comparisons !== 'object') return undefined

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

function pickBest(
  entries: RadarModelEntry[],
  minScore: number,
  updatedAt?: string
): RadarBestPick | undefined {
  const eligible = entries.filter((e) => e.score >= minScore)
  if (eligible.length === 0) return undefined

  // 排序只看 IQ 与成本:性价比(score/cost)降序优先,再按 score 降序;不看 green/yellow/red 状态
  eligible.sort((left, right) => {
    const leftValue = left.score / left.averageCostUsd
    const rightValue = right.score / right.averageCostUsd
    if (rightValue !== leftValue) return rightValue - leftValue
    return right.score - left.score
  })

  const best = eligible[0]
  return {
    label: best.label,
    shortLabel: shortenLabel(best.label),
    score: best.score,
    averageCostUsd: best.averageCostUsd,
    averageTaskMinutes: Math.max(1, Math.round(best.averageTaskSeconds / 60)),
    status: best.status,
    threshold: minScore,
    updatedAt
  }
}

// 让设置面板更改阈值时能立即得到新的pick(基于已缓存数据)
export function invalidateRadarCache(): void {
  rawCache = undefined
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
