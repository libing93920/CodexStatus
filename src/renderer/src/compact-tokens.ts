type CompactTokenLocale = 'zh-CN' | 'en-US'

// 紧凑数字:zh-CN 用 1.2万 / 3.4亿,其余用 1.2K / 3.4M / 1.1B
export function formatCompactTokens(value: number, locale: CompactTokenLocale): string {
  if (locale === 'zh-CN') {
    if (value >= 1e8) return `${trimTrailingZero((value / 1e8).toFixed(1))}亿`
    if (value >= 1e4) return `${trimTrailingZero((value / 1e4).toFixed(1))}万`
    return String(Math.round(value))
  }
  if (value >= 1e9) return `${trimTrailingZero((value / 1e9).toFixed(1))}B`
  if (value >= 1e6) return `${trimTrailingZero((value / 1e6).toFixed(1))}M`
  if (value >= 1e3) return `${trimTrailingZero((value / 1e3).toFixed(1))}K`
  return String(Math.round(value))
}

// 胶囊与排行榜显示 token:中文万级取整,亿级沿用公共格式保留 1 位小数
export function formatCompactTokensDisplay(value: number, locale: CompactTokenLocale): string {
  if (locale === 'zh-CN' && value >= 1e4 && value < 1e8) {
    return `${Math.round(value / 1e4)}万`
  }
  return formatCompactTokens(value, locale)
}

function trimTrailingZero(value: string): string {
  return value.endsWith('.0') ? value.slice(0, -2) : value
}
