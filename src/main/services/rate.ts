// 模型价目与费用计算(纯逻辑,不依赖 electron,可在 node 单测中直接导入)。
// 语义对齐 cc-switch:input 是"非缓存"输入,cache_read 与 cache_creation(缓存写)按不同单价,
// output 已含 reasoning,无独立 reasoning 单价。

export interface ModelRate {
  /** 每百万非缓存输入 token 价格(USD) */
  input: number
  /** 每百万缓存读取 token 价格 */
  cachedInput: number
  /** 每百万输出 token 价格(output 含 reasoning) */
  output: number
  /** 每百万缓存写入(creation) token 价格;未配置时回落 cachedInput */
  cacheCreation?: number
}

// 各模型每百万 token 价格(USD),取官方标准(short context)价目:
// https://developers.openai.com/api/docs/pricing
// 说明:① 官方无独立 reasoning 单价,思考输出按 output 价计,故公式不含 reasoning 项;
//   ② 无缓存价的模型(pro 系)按"缓存无折扣=按 input 全价"处理;
//   ③ 表中未登记模型(如 codex-auto-review、第三方 GLM/DeepSeek 等)落到 DEFAULT_RATE;
//   ④ 未单配 cacheCreation 的条目回落 cachedInput(缓存写按读价,models.dev 主路径另有真实写价)。
const MODEL_RATES: Record<string, ModelRate> = {
  'gpt-5.6-sol': { input: 5.0, cachedInput: 0.5, output: 30.0 },
  'gpt-5.6-terra': { input: 2.0, cachedInput: 0.2, output: 12.0 },
  'gpt-5.6-luna': { input: 0.2, cachedInput: 0.02, output: 1.2 },
  'gpt-5.5': { input: 5.0, cachedInput: 0.5, output: 30.0 },
  'gpt-5.5-pro': { input: 30.0, cachedInput: 30.0, output: 180.0 },
  'gpt-5.4': { input: 2.5, cachedInput: 0.25, output: 15.0 },
  'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, cachedInput: 0.02, output: 1.25 },
  'gpt-5.4-pro': { input: 30.0, cachedInput: 30.0, output: 180.0 },
  'gpt-5.3-codex': { input: 1.75, cachedInput: 0.175, output: 14.0 },
  'gpt-5.2': { input: 1.75, cachedInput: 0.175, output: 14.0 },
  'gpt-5.2-pro': { input: 21.0, cachedInput: 21.0, output: 168.0 },
  'gpt-5.1': { input: 1.25, cachedInput: 0.125, output: 10.0 },
  'gpt-5': { input: 1.25, cachedInput: 0.125, output: 10.0 },
  'gpt-5-mini': { input: 0.25, cachedInput: 0.025, output: 2.0 },
  'gpt-5-nano': { input: 0.05, cachedInput: 0.005, output: 0.4 },
  'gpt-5-pro': { input: 15.0, cachedInput: 15.0, output: 120.0 },
  'gpt-4.1': { input: 2.0, cachedInput: 0.5, output: 8.0 },
  'gpt-4.1-mini': { input: 0.4, cachedInput: 0.1, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, cachedInput: 0.025, output: 0.4 },
  'gpt-4o': { input: 2.5, cachedInput: 1.25, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, cachedInput: 0.075, output: 0.6 },
  o3: { input: 2.0, cachedInput: 0.5, output: 8.0 },
  'o4-mini': { input: 1.1, cachedInput: 0.275, output: 4.4 },
  'o3-mini': { input: 1.1, cachedInput: 0.55, output: 4.4 },
  o1: { input: 15.0, cachedInput: 7.5, output: 60.0 }
}
// 兜底价(未登记模型):取 gpt-5.1 档位,中性偏低;第三方模型实际常更便宜,为估算上限。
// cacheCreation 取标准"缓存写 = 1.25× 输入"档(claude-sonnet-5 / gpt-5.6-sol 均为此倍率)。
const DEFAULT_RATE: ModelRate = { input: 1.25, cachedInput: 0.125, output: 10, cacheCreation: 1.5625 }

// 外部注入的价格查询(主进程启动时挂 models.dev 拉取结果);未注入/查不到时回落硬编码表
let rateLookup: ((model: string | undefined) => ModelRate | undefined) | undefined

export function setRateLookup(
  lookup: ((model: string | undefined) => ModelRate | undefined) | undefined
): void {
  rateLookup = lookup
}

/** computeCost 的计费输入(input 为总输入含缓存,cachedInput 为其子集;cacheCreation 缺失按 0) */
export interface CostTokenDelta {
  input: number
  cachedInput: number
  output: number
  cacheCreation?: number
}

// input 含 cachedInput,常规输入部分需减去;cache_read 与 cache_creation 分开按不同单价;
// output 已含 reasoning,无独立思考单价
export function computeCost(delta: CostTokenDelta, model: string | undefined): number {
  const rate =
    rateLookup?.(model) ??
    (model !== undefined ? MODEL_RATES[model] : undefined) ??
    DEFAULT_RATE
  const cacheCreation = delta.cacheCreation ?? 0
  const cacheRead = Math.max(0, delta.cachedInput - cacheCreation)
  const regularInput = Math.max(0, delta.input - delta.cachedInput)
  const cost =
    (regularInput * rate.input +
      cacheRead * rate.cachedInput +
      cacheCreation * (rate.cacheCreation ?? rate.cachedInput) +
      delta.output * rate.output) /
    1e6
  return Math.round(cost * 10000) / 10000
}

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
