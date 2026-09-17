import {
  createIslandDiagBuffer,
  validateIslandDiagBatch,
  type IslandDiagBatch
} from '../../shared/island-diagnostics.ts'
import { resolveDiagEnabled, writeDiagBatch } from './diag-log.ts'

const MAX_PENDING_WRITES = 2
const MAX_BATCHES_PER_SECOND = 40
const WINDOW_MS = 1_000

/** 与其他日志共享写入器，但不能让交互诊断在慢磁盘后无限排队。 */
export function createIslandDiagWriter(write = writeDiagBatch): {
  submit: (source: 'main' | 'renderer', batch: IslandDiagBatch) => void
} {
  let pending = 0
  let windowStart = 0
  let batches = 0
  let dropped = 0
  let reportTimer: ReturnType<typeof setTimeout> | undefined

  function reportDropped(): void {
    if (reportTimer !== undefined) return
    reportTimer = setTimeout(() => {
      reportTimer = undefined
      if (!dropped) return
      submit('main', { events: [], dropped: 0 })
    }, WINDOW_MS)
    reportTimer.unref?.()
  }

  function submit(source: 'main' | 'renderer', batch: IslandDiagBatch): void {
    if (!resolveDiagEnabled()) return
    const now = Date.now()
    if (now - windowStart >= WINDOW_MS) {
      windowStart = now
      batches = 0
    }
    if (pending >= MAX_PENDING_WRITES || batches >= MAX_BATCHES_PER_SECOND) {
      dropped += batch.events.length + batch.dropped
      reportDropped()
      return
    }
    batches++
    pending++
    const message = `island-diag ${JSON.stringify({
      source,
      receivedAt: now,
      sinkDropped: dropped,
      ...batch
    })}`
    dropped = 0
    // 只有已获写入名额的批次才序列化；每批次只做一次文件追加。
    void write(message)
      .catch(() => undefined)
      .finally(() => {
        pending--
      })
  }

  return { submit }
}

const writer = createIslandDiagWriter()
export const islandDiagnostics = createIslandDiagBuffer((batch) => writer.submit('main', batch))

export function islandInteractiveDiagnostic(value: unknown): {
  peerInstance?: string
  request?: number
} {
  if (!resolveDiagEnabled() || typeof value !== 'object' || value === null) return {}
  const candidate = value as Record<string, unknown>
  if (typeof candidate.instance !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(candidate.instance))
    return {}
  if (!Number.isSafeInteger(candidate.request) || (candidate.request as number) < 1) return {}
  return { peerInstance: candidate.instance, request: candidate.request as number }
}

export function receiveIslandDiagnostics(
  senderId: number,
  islandSenderId: number | undefined,
  payload: unknown
): void {
  if (!resolveDiagEnabled() || senderId !== islandSenderId) return
  if (!validateIslandDiagBatch(payload)) return
  writer.submit('renderer', payload)
}
