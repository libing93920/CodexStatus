import type { PercentageMode, ThemeId } from '../../shared/capsule'

const LIGHT_THEME_IDS: ReadonlySet<ThemeId> = new Set([
  'poster',
  'memphis',
  'inksong',
  'greenhouse',
  'swiss'
])

const LIGHT_METRIC_COLORS = {
  green: '#15803D',
  yellow: '#A16207',
  orange: '#C2410C',
  red: '#B91C1C'
} as const

const DARK_METRIC_COLORS = {
  green: '#4ADE80',
  yellow: '#FACC15',
  orange: '#FB923C',
  red: '#F87171'
} as const

export function clampProgressPercent(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined
  }
  return Math.min(100, Math.max(0, value))
}

export function isLightTheme(theme: ThemeId): boolean {
  return LIGHT_THEME_IDS.has(theme)
}

export function resolveMetricColor(
  displayPercent: number | undefined,
  percentageMode: PercentageMode,
  theme: ThemeId
): string {
  if (displayPercent === undefined || !Number.isFinite(displayPercent)) {
    return 'rgba(158, 168, 179, 0.74)'
  }

  const goodScore = percentageMode === 'remaining' ? displayPercent : 100 - displayPercent
  const clampedScore = Math.min(100, Math.max(0, goodScore))
  const colors = isLightTheme(theme) ? LIGHT_METRIC_COLORS : DARK_METRIC_COLORS

  if (clampedScore > 50) {
    return colors.green
  }
  if (clampedScore >= 25) {
    return colors.yellow
  }
  if (clampedScore >= 10) {
    return colors.orange
  }
  return colors.red
}

// 极简球与完整额度组件共享分段额度色；浅色主题使用深色调色板。
export function resolveMinimalMetricColor(
  remainingPercent: number | undefined,
  theme: ThemeId
): string {
  const progress = clampProgressPercent(remainingPercent)

  if (progress === undefined) {
    return isLightTheme(theme) ? '#1f2937' : 'rgba(158, 168, 179, 0.86)'
  }

  return resolveMetricColor(progress, 'remaining', theme)
}
