export const DEFAULT_WINDOW_KEEPER_START_TIME = '00:00'

const WINDOW_KEEPER_START_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/

export function isWindowKeeperStartTime(value: unknown): value is string {
  return typeof value === 'string' && WINDOW_KEEPER_START_TIME_PATTERN.test(value)
}

export function normalizeWindowKeeperStartTime(value: unknown): string {
  return isWindowKeeperStartTime(value) ? value : DEFAULT_WINDOW_KEEPER_START_TIME
}

export function getNextWindowKeeperAllowedTime(candidateAtMs: number, startTime: string): number {
  const [hours, minutes] = normalizeWindowKeeperStartTime(startTime).split(':').map(Number)
  const start = new Date(candidateAtMs)
  // 使用候选时间的本地日期，跨午夜后也必须遵守当天的开始时间。
  start.setHours(hours, minutes, 0, 0)
  return Math.max(candidateAtMs, start.getTime())
}
