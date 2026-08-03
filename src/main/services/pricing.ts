// models.dev 价格同步:主进程启动时后台拉取全量价目,注入 usage.ts 的花费计算。
// 拉取失败/未命中时,usage.ts 回落到内置 MODEL_RATES 与 DEFAULT_RATE。
import { net } from 'electron'
import type { ModelRate } from './usage'

const MODELS_DEV_URL = 'https://models.dev/api.json'
const MODELS_DEV_TIMEOUT_MS = 15_000
// 价格变化不频繁,进程内缓存 24h 足够
const PRICING_CACHE_TTL_MS = 24 * 60 * 60 * 1000

let ratesCache: Map<string, ModelRate> | undefined
let fetchedAtMs = 0

// 归一化模型名:小写、去 provider/ 前缀、去日期后缀,与 models.dev 的 key 对齐
export function normalizeModel(raw: string): string {
  let name = raw.trim().toLowerCase()
  const slash = name.lastIndexOf('/')
  if (slash >= 0) {
    name = name.slice(slash + 1)
  }
  name = name.replace(/-\d{4}-\d{2}-\d{2}$/, '')
  name = name.replace(/-\d{8}$/, '')
  return name
}

// 拉取 models.dev 全量价目并建索引;任何失败都不抛错,回落到内置表
export async function fetchModelsDevRates(): Promise<void> {
  if (ratesCache && Date.now() - fetchedAtMs < PRICING_CACHE_TTL_MS) {
    return
  }
  try {
    const response = (await Promise.race([
      net.fetch(MODELS_DEV_URL, { headers: { Accept: 'application/json' } }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), MODELS_DEV_TIMEOUT_MS)
      )
    ])) as Response
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    const data = (await response.json()) as Record<string, unknown>
    // models.dev 聚合了多个 provider 的同名模型,价格可能不同;
    // 同一 key 取"官方 openai provider + 非版本化条目"为优先,避免被渠道价覆盖
    const best = new Map<string, { rate: ModelRate; score: number }>()
    for (const [providerId, provider] of Object.entries(data)) {
      const models = asRecord(provider)?.models as Record<string, unknown> | undefined
      if (!models) {
        continue
      }
      const isOpenai = providerId.toLowerCase() === 'openai'
      for (const [id, model] of Object.entries(models)) {
        const cost = asRecord(model)?.cost as Record<string, unknown> | undefined
        if (!cost) {
          continue
        }
        const input = asNumber(cost.input)
        const output = asNumber(cost.output)
        if (input === undefined || output === undefined) {
          continue
        }
        const key = normalizeModel(id)
        const versioned = /-\d{4}-\d{2}-\d{2}$/.test(id) || /-\d{8}$/.test(id)
        const score = (isOpenai ? 2 : 0) + (versioned ? 0 : 1)
        const existing = best.get(key)
        if (!existing || score > existing.score) {
          best.set(key, {
            // cache_read 未标价的模型按无缓存折扣(全价输入)处理
            rate: { input, output, cachedInput: asNumber(cost.cache_read) ?? input },
            score
          })
        }
      }
    }
    const map = new Map<string, ModelRate>()
    for (const [key, entry] of best) {
      map.set(key, entry.rate)
    }
    ratesCache = map
    fetchedAtMs = Date.now()
    // 用 ASCII 避免 Windows 控制台按 GBK 解码 UTF-8 中文出现乱码
    console.log(`[codex-status] models.dev pricing synced, ${map.size} models`)
  } catch (error) {
    console.warn(
      '[codex-status] models.dev pricing fetch failed, fallback to built-in table:',
      error instanceof Error ? error.message : String(error)
    )
  }
}

// 按归一化模型名查询;未拉取到或未命中返回 undefined
export function getPricingRate(model: string | undefined): ModelRate | undefined {
  if (!model || !ratesCache) {
    return undefined
  }
  return ratesCache.get(normalizeModel(model))
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
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
