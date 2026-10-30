import { performance } from 'node:perf_hooks'
import type { CleanerProgress } from '../../../shared/session-cleaner.ts'

const SCAN_PROGRESS_INTERVAL_MS = 100

export function createScanProgressReporter(
  send: (progress: CleanerProgress) => void,
  now: () => number = () => performance.now()
): {
  report: (progress: CleanerProgress) => void
  finish: () => void
} {
  let lastSentAt: number | undefined
  let pending: CleanerProgress | undefined
  let finished = false

  return {
    report(progress: CleanerProgress): void {
      if (finished) return
      const currentTime = now()
      if (lastSentAt === undefined || currentTime - lastSentAt >= SCAN_PROGRESS_INTERVAL_MS) {
        pending = undefined
        send(progress)
        lastSentAt = currentTime
      } else {
        pending = progress
      }
    },
    finish(): void {
      if (finished) return
      finished = true
      // 扫描结束时清空最后一个样本，并忽略其后的异步回调，避免串入下一次扫描。
      const finalProgress = pending
      pending = undefined
      if (finalProgress) send(finalProgress)
    }
  }
}
