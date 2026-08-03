// API Key 模式真实账单:逐日调 OpenAI billing/usage 取实际花费(USD)。
// 仅 auth_mode='api' 生效;非 api 模式或无 key 返回 available:false,不抛错。
import { net } from 'electron'
import type { SpendDay, SpendUsage, UsageWindow } from '../../shared/capsule'
import { readOfficialCodexCredentials } from './quota'

const BILLING_URL = 'https://api.openai.com/v1/dashboard/billing/usage'
const BILLING_TIMEOUT_MS = 10_000
const DAY_MS = 24 * 60 * 60 * 1000
// 账单按日缓存 24h;价格/消费高频变化下一天一刷足够
const DAY_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const WINDOW_DAYS: Record<UsageWindow, number> = { '1d': 1, '7d': 7, '30d': 30 }

interface DayCacheEntry {
  usd: number
  fetchedAtMs: number
}
const dayCache = new Map<string, DayCacheEntry>()
const inflight = new Map<string, Promise<number | undefined>>()

/** 1/7/30 天真实账单花费;非 API Key 模式或全部失败 → available:false */
export async function getSpendUsage(window: UsageWindow): Promise<SpendUsage> {
  const credentialLookup = await readOfficialCodexCredentials()
  if (credentialLookup.mode !== 'api') {
    return { available: false, generatedAt: new Date().toISOString(), days: [], total: 0 }
  }

  const length = WINDOW_DAYS[window]
  const now = Date.now()
  const dates: string[] = []
  for (let offset = length - 1; offset >= 0; offset--) {
    dates.push(toDateKey(new Date(now - offset * DAY_MS)))
  }

  const results = await Promise.all(dates.map((d) => fetchDaySpend(credentialLookup.apiKey, d)))
  const days: SpendDay[] = results.map((usd, index) => ({
    date: dates[index],
    cost: usd ?? 0
  }))
  const anyFetched = results.some((usd) => usd !== undefined)

  return {
    available: anyFetched,
    generatedAt: new Date().toISOString(),
    days,
    total: Math.round(days.reduce((sum, d) => sum + d.cost, 0) * 100) / 100
  }
}

// 缓存 + 并发去重:同一日期只发一次请求
async function fetchDaySpend(apiKey: string, date: string): Promise<number | undefined> {
  const cached = dayCache.get(date)
  if (cached && Date.now() - cached.fetchedAtMs < DAY_CACHE_TTL_MS) {
    return cached.usd
  }
  const pending = inflight.get(date)
  if (pending) {
    return pending
  }
  const promise = requestDaySpend(apiKey, date)
  inflight.set(date, promise)
  try {
    const usd = await promise
    if (usd !== undefined) {
      dayCache.set(date, { usd, fetchedAtMs: Date.now() })
    }
    return usd
  } finally {
    inflight.delete(date)
  }
}

async function requestDaySpend(apiKey: string, date: string): Promise<number | undefined> {
  try {
    const url = `${BILLING_URL}?start_date=${date}&end_date=${date}`
    const response = (await Promise.race([
      net.fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), BILLING_TIMEOUT_MS)
      )
    ])) as Response
    if (!response.ok) {
      console.warn(`[codex-status] billing ${date} HTTP ${response.status}`)
      return undefined
    }
    const body = (await response.json()) as Record<string, unknown>
    // total_usage 单位为美分
    const totalUsage = asNumber(body.total_usage ?? body.totalUsage)
    if (totalUsage === undefined) {
      return undefined
    }
    return Math.round((totalUsage / 100) * 10000) / 10000
  } catch (error) {
    console.warn(
      `[codex-status] billing ${date} failed:`,
      error instanceof Error ? error.message : String(error)
    )
    return undefined
  }
}

function toDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}
