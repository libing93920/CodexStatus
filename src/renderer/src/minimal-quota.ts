const LIGHT_MINIMAL_THEMES = new Set(['poster', 'memphis', 'inksong', 'greenhouse', 'swiss'])

export function clampProgressPercent(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined
  }
  return Math.min(100, Math.max(0, value))
}

// 浅色主题用深色额度色,避免原有粉绿渐变在纸色/橙色底上失去对比度。
export function resolveMinimalMetricColor(
  remainingPercent: number | undefined,
  theme: string
): string {
  const progress = clampProgressPercent(remainingPercent)
  const lightTheme = LIGHT_MINIMAL_THEMES.has(theme)

  if (progress === undefined) {
    return lightTheme ? '#1f2937' : 'rgba(158, 168, 179, 0.86)'
  }

  const start = lightTheme ? [104, 21, 29] : theme === 'titan' ? [255, 190, 190] : [248, 113, 113]
  const end = lightTheme ? [8, 59, 32] : theme === 'titan' ? [143, 230, 157] : [86, 211, 108]
  const t = progress / 100
  const r = Math.round(start[0] + (end[0] - start[0]) * t)
  const g = Math.round(start[1] + (end[1] - start[1]) * t)
  const b = Math.round(start[2] + (end[2] - start[2]) * t)
  return `rgb(${r}, ${g}, ${b})`
}
