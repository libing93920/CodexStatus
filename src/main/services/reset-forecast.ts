const FORECAST_URL = 'https://hascodexratelimitreset.today/api/status'
const FORECAST_TIMEOUT_MS = 8000
const FORECAST_CACHE_TTL_MS = 10 * 60 * 1000

// hascodexratelimitreset.today /api/status 返回的重置预测;Caddy 后端,公开端点无需鉴权
export interface ResetForecast {
  /** "yes"=已重置 / "no"=未重置,异常时缺省 */
  state?: 'yes' | 'no'
  /**
   * 自动化监测判定:automationSummary.verdict
   * "yes"=检测到官方人员发布"限额已重置" / "no"=未检测到 / "uncertain"=尚未完成有效判断
   * 缺省=站点 automation 未运行或无数据,不能作为结论
   */
  verdict?: 'yes' | 'no' | 'uncertain'
  /** 监测判定时间(automationSummary.checkedAt,毫秒时间戳) */
  checkedAt?: number
  /** 预测重置时间点(ISO),null/缺省表示未确定 */
  resetAt?: string
  /** 自动重置周期(小时),通常 20 */
  autoResetHours?: number
  /** 数据更新时间(ISO) */
  updatedAt?: string
  /** 站点返回的错误说明(如 "Status is temporarily unavailable") */
  error?: string
}

interface CacheEntry {
  forecast: ResetForecast
  fetchedAtMs: number
}

let cache: CacheEntry | undefined

// 公开端点走 Node 原生 fetch(与 radar 一致):无需系统代理/cookie,Cloudflare/Caddy 直连稳定
export async function fetchResetForecast(): Promise<ResetForecast | undefined> {
  const now = Date.now()
  if (cache && now - cache.fetchedAtMs < FORECAST_CACHE_TTL_MS) {
    return cache.forecast
  }

  const forecast = await fetchRaw().catch((error) => ({
    error: error instanceof Error ? error.message : 'fetch failed'
  }))
  // 仅缓存成功拉取且站点无 error 的结果;失败/不可用态不缓存,下次刷新立即重试
  if (forecast && !forecast.error) {
    cache = { forecast, fetchedAtMs: now }
  }
  return forecast
}

async function fetchRaw(): Promise<ResetForecast> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FORECAST_TIMEOUT_MS)
  const response = await globalThis.fetch(FORECAST_URL, {
    signal: controller.signal,
    headers: { Accept: 'application/json' }
  })
  clearTimeout(timer)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const data = (await response.json()) as unknown
  return parseForecast(data) ?? { error: 'invalid response' }
}

function parseForecast(value: unknown): ResetForecast | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const stateRaw = typeof record.state === 'string' ? record.state : undefined
  const state = stateRaw === 'yes' || stateRaw === 'no' ? stateRaw : undefined
  const automation = getRecord(record.automationSummary)
  const verdictRaw = typeof automation?.verdict === 'string' ? automation.verdict : undefined
  const verdict =
    verdictRaw === 'yes' || verdictRaw === 'no' || verdictRaw === 'uncertain'
      ? verdictRaw
      : undefined
  return {
    state,
    verdict,
    checkedAt: parseNumber(automation?.checkedAt),
    resetAt: typeof record.resetAt === 'string' ? record.resetAt : undefined,
    autoResetHours: parseNumber(record.autoResetHours),
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : undefined,
    error: typeof record.error === 'string' ? record.error : undefined
  }
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

// 强制重新拉取(刷新时调用,跳过缓存等待下次 fetch)
export function invalidateResetForecastCache(): void {
  cache = undefined
}
