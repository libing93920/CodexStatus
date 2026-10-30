import type { CleanerSourceKind } from '../../../../shared/session-cleaner'
import { formatBytes } from './model'

export const PAGE_LABELS = {
  overview: '存储总览',
  analytics: '空间分析',
  items: '会话管理',
  sources: '来源管理',
  review: '清理中心',
  records: '操作记录',
  policy: '策略设置'
} as const
export const BYTES_PER_GIB = 1024 ** 3
const DAY_MS = 86_400_000

export function sourceColor(kind: CleanerSourceKind): string {
  const aliases: Partial<Record<CleanerSourceKind, string>> = {
    unknown: 'custom',
    openclaw: 'claude',
    hermes: 'opencode',
    grokbuild: 'codex',
    omp: 'pi',
    mcode: 'gemini',
    kimi: 'claude',
    agy: 'gemini'
  }
  return `var(--${aliases[kind] ?? kind})`
}

export function sumBytes(items: Array<{ bytes: number }>): number {
  return items.reduce((total, item) => total + item.bytes, 0)
}

export function sizeParts(bytes: number): { value: string; unit: string } {
  const text = formatBytes(bytes)
  const split = text.lastIndexOf(' ')
  return split < 0
    ? { value: text, unit: '' }
    : { value: text.slice(0, split), unit: text.slice(split + 1) }
}

export function daysAgo(timestamp: number): number {
  return Math.max(0, Math.floor((Date.now() - timestamp) / DAY_MS))
}
