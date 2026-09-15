import type { CSSProperties } from 'react'
import type { LocaleCode, PercentageMode, ThemeId } from '../../shared/capsule'
import {
  MAX_REFRESH_INTERVAL_SECONDS,
  MIN_REFRESH_INTERVAL_SECONDS,
  REFRESH_INTERVAL_OPTIONS
} from '../../shared/capsule'
import { COPY } from './copy'
import { resolveMetricColor } from './minimal-quota'

export { resolveMetricColor } from './minimal-quota'

// 窗口天数多时只标首/末与每 5 天,避免拥挤
export function shouldShowDateLabel(count: number, index: number): boolean {
  if (count <= 7) {
    return true
  }
  return index % 5 === 0 || index === count - 1
}

export function formatDayLabel(date: string): string {
  return date.slice(5)
}

// 紧凑数字:zh-CN 用 1.2万 / 3.4亿,其余用 1.2K / 3.4M / 1.1B
export function formatCompactTokens(value: number, locale: LocaleCode): string {
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

// 胶囊今日 token:万级(1万~9999万)取整不显示小数;亿级沿用公共格式化保留 1 位小数
export function formatCapsuleTokens(value: number, locale: LocaleCode): string {
  if (locale === 'zh-CN' && value >= 1e4 && value < 1e8) {
    return `${Math.round(value / 1e4)}万`
  }
  return formatCompactTokens(value, locale)
}

export function trimTrailingZero(value: string): string {
  return value.endsWith('.0') ? value.slice(0, -2) : value
}

// 胶囊自适应字号:按文本宽度估算(CJK≈1em,数字/字母≈0.55em,符号≈0.3em),
// 长文本自动缩小,保证不超出给定最大宽度
export function fitFontSize(text: string, basePx: number, maxWidth: number): number {
  let units = 0
  for (const ch of text) {
    if (/[一-鿿]/.test(ch)) units += 1
    else if (ch === '.' || ch === ',' || ch === '：' || ch === '·') units += 0.3
    else units += 0.55
  }
  if (units <= 0) {
    return basePx
  }
  const fitted = (maxWidth / units) * 0.95
  return Math.max(10, Math.min(basePx, Math.floor(fitted * 10) / 10))
}

// 缓存命中率 = cached_input / input(input 含缓存)
export function formatCacheHit(input: number, cached: number): string {
  if (input <= 0) {
    return '--'
  }
  const rate = (cached / input) * 100
  return `${rate >= 99.95 ? rate.toFixed(0) : rate.toFixed(1)}%`
}

export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) {
    return '--'
  }
  if (value <= 0) {
    return '$0'
  }
  if (value >= 100) {
    return `$${Math.round(value)}`
  }
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`
}

// 推荐模型品牌色:按模型名关键词上色
// Sol=#eab308, Terra=#3b82f6, Luna=#c7d2e0, GPT-5.5=#00e5ff, 兜底灰蓝
export function resolveModelColor(label: string | undefined): string {
  if (!label) {
    return 'rgba(197, 210, 224, 0.85)'
  }
  if (label.includes('Sol')) return '#eab308'
  if (label.includes('Terra')) return '#3b82f6'
  if (label.includes('Luna')) return '#c7d2e0'
  if (label.includes('GPT-5.5')) return '#00e5ff'
  return 'rgba(197, 210, 224, 0.85)'
}

export function createMetricProgressStyle(
  displayPercent: number | undefined,
  percentageMode: PercentageMode,
  theme: ThemeId
): CSSProperties {
  const progress =
    displayPercent === undefined || !Number.isFinite(displayPercent)
      ? 0
      : Math.min(100, Math.max(0, displayPercent))

  return {
    '--metric-progress': `${progress}%`,
    '--metric-accent': resolveMetricColor(displayPercent, percentageMode, theme)
  } as CSSProperties
}

export function formatAbsoluteDate(value: string | undefined, locale: LocaleCode): string {
  if (!value) {
    return '--'
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return '--'
  }

  const now = new Date()
  const sameYear = date.getFullYear() === now.getFullYear()
  const sameDay = isSameDay(date, now)

  if (locale === 'zh-CN') {
    const time = new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit'
    }).format(date)

    if (sameDay) {
      return `${COPY['zh-CN'].today} ${time}`
    }

    return sameYear
      ? `${date.getMonth() + 1}月${date.getDate()}日 ${time}`
      : `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${time}`
  }

  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit'
  }).format(date)

  if (sameDay) {
    return `${COPY['en-US'].today}, ${time}`
  }

  return sameYear
    ? `${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(date)}, ${time}`
    : `${new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric' }).format(date)}, ${time}`
}

export function formatRelativeDuration(
  value: number | undefined,
  locale: LocaleCode,
  withSuffix = false
): string | undefined {
  if (value === undefined) {
    return undefined
  }

  const totalSeconds = Math.max(0, Math.floor(value))
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)

  if (locale === 'zh-CN') {
    const parts: string[] = []
    if (days > 0) {
      parts.push(`${days}天`)
    }
    if (hours > 0) {
      parts.push(`${hours}小时`)
    }
    if (minutes > 0 || parts.length === 0) {
      parts.push(`${minutes}分`)
    }
    return `${parts.slice(0, 2).join('')}${withSuffix ? '后' : ''}`
  }

  const parts: string[] = []
  if (days > 0) {
    parts.push(`${days}d`)
  }
  if (hours > 0) {
    parts.push(`${hours}h`)
  }
  if (minutes > 0 || parts.length === 0) {
    parts.push(`${minutes}m`)
  }
  return parts.slice(0, 2).join(' ')
}

// 本地自然日键(YYYY-MM-DD):点赞过期与 token 榜 1d 窗口都按自然日对齐
export function localDayKey(ms: number): string {
  const d = new Date(ms)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

// semver 比较:按 . 分段数字比较(缺段按 0),a>b 返回正数、相等 0
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export function formatRelativeDate(
  value: string | undefined,
  locale: LocaleCode
): string | undefined {
  if (!value) {
    return undefined
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return undefined
  }

  const diffSeconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000))
  if (diffSeconds < 60) {
    return locale === 'zh-CN' ? '刚刚' : 'just now'
  }

  const diffMinutes = Math.floor(diffSeconds / 60)
  if (diffMinutes < 60) {
    return locale === 'zh-CN' ? `${diffMinutes}分钟前` : `${diffMinutes}m ago`
  }

  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) {
    return locale === 'zh-CN' ? `${diffHours}小时前` : `${diffHours}h ago`
  }

  const diffDays = Math.floor(diffHours / 24)
  return locale === 'zh-CN' ? `${diffDays}天前` : `${diffDays}d ago`
}

export function formatCapsuleResetTime(value: string | undefined, locale: LocaleCode): string {
  if (!value) {
    return '--'
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return '--'
  }

  const now = new Date()
  const time = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)

  if (isSameDay(date, now)) {
    return time
  }

  const monthDay = new Intl.DateTimeFormat(locale, {
    month: 'numeric',
    day: 'numeric'
  }).format(date)
  return `${monthDay} ${time}`
}

export function formatCountdownShort(value: string, locale: LocaleCode): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return '--'
  }
  const diffMs = date.getTime() - Date.now()
  if (diffMs <= 0) {
    return '0m'
  }
  const totalMinutes = Math.max(1, Math.ceil(diffMs / 60000))
  const days = Math.floor(totalMinutes / 1440)
  if (days >= 1) {
    return locale === 'zh-CN' ? `${days}天` : `${days}d`
  }
  const hours = Math.floor(totalMinutes / 60)
  if (hours >= 1) {
    return locale === 'zh-CN' ? `${hours}时` : `${hours}h`
  }
  return locale === 'zh-CN' ? `${totalMinutes}分` : `${totalMinutes}m`
}

// 胶囊周重置倒计时:单单位大写 D/H/M/S,秒级(有天显天,0天显时,0时显分,0分显秒)
// 与重置卡(formatCountdownShort,中文)区分;胶囊里统一用英文单位更紧凑
export function formatCountdownCapsule(value: string | undefined, nowMs: number): string {
  if (!value) {
    return '--'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return '--'
  }
  const diffMs = date.getTime() - nowMs
  if (diffMs <= 0) {
    return '0S'
  }
  const totalSeconds = Math.floor(diffMs / 1000)
  const days = Math.floor(totalSeconds / 86400)
  if (days >= 1) {
    return `${days}D`
  }
  const hours = Math.floor(totalSeconds / 3600)
  if (hours >= 1) {
    return `${hours}H`
  }
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes >= 1) {
    return `${minutes}M`
  }
  return `${totalSeconds}S`
}

export function formatModelPick(shortLabel: string): string {
  // shortLabel 形如 "Terra xhigh" -> "Terra Xh", "Sol medium" -> "Sol M", "Luna max" -> "Luna U"
  const parts = shortLabel.split(/\s+/)
  if (parts.length < 2) return shortLabel
  const name = parts[0]
  const effort = parts.slice(1).join(' ').toLowerCase()
  const effortAbbr: Record<string, string> = {
    ultra: 'U',
    max: 'Mx',
    xhigh: 'Xh',
    high: 'H',
    medium: 'M',
    low: 'L'
  }
  const abbr = effortAbbr[effort] ?? effort.charAt(0).toUpperCase()
  return `${name} ${abbr}`
}

export function normalizeCustomRefreshInterval(value: number): number {
  return Math.min(
    MAX_REFRESH_INTERVAL_SECONDS,
    Math.max(MIN_REFRESH_INTERVAL_SECONDS, Math.round(value))
  )
}

export function isFixedRefreshInterval(value: number): boolean {
  return REFRESH_INTERVAL_OPTIONS.some((option) => option === value)
}

export function isSameDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  )
}
