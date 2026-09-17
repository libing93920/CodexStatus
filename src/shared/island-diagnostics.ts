/** 灵动岛诊断事件的有限协议；诊断数据不包含业务正文或工具输入。 */

export const ISLAND_DIAG_EVENTS = [
  'ready',
  'mode-request',
  'mode-commit',
  'pointer',
  'focus',
  'effect',
  'interactive',
  'reminder',
  'presentation',
  'hidden-ack',
  'native',
  'window'
] as const
export type IslandDiagEventName = (typeof ISLAND_DIAG_EVENTS)[number]

export const ISLAND_DIAG_MODES = ['hidden', 'compact', 'alert', 'expanded'] as const
export type IslandDiagMode = (typeof ISLAND_DIAG_MODES)[number]

export const ISLAND_DIAG_FIELDS = [
  'mode',
  'modeRef',
  'displayMode',
  'from',
  'to',
  'reason',
  'revision',
  'visible',
  'hovering',
  'focused',
  'documentFocused',
  'x',
  'y',
  'pointAge',
  'button',
  'interaction',
  'request',
  'effect',
  'timer',
  'firstRequest',
  'lastRequest',
  'interactive',
  'expandedHeight',
  'satellite',
  'reducedMotion',
  'ignore',
  'forward',
  'accepted',
  'count',
  'cancelled',
  'enabled',
  'taskCount',
  'fullscreen',
  'fullscreenSuppressed',
  'alertUntil',
  'delay',
  'peerInstance'
] as const
export type IslandDiagFieldName = (typeof ISLAND_DIAG_FIELDS)[number]
export type IslandDiagReason = string

export interface IslandDiagFields {
  mode?: IslandDiagMode
  modeRef?: IslandDiagMode
  displayMode?: IslandDiagMode
  from?: IslandDiagMode
  to?: IslandDiagMode
  reason?: IslandDiagReason
  revision?: number
  visible?: boolean
  hovering?: boolean
  focused?: boolean
  documentFocused?: boolean
  x?: number
  y?: number
  pointAge?: number
  button?: number
  interaction?: number
  request?: number
  effect?: number
  timer?: number
  firstRequest?: number
  lastRequest?: number
  interactive?: boolean
  expandedHeight?: number
  satellite?: boolean
  reducedMotion?: boolean
  ignore?: boolean
  forward?: boolean
  accepted?: boolean
  count?: number
  cancelled?: boolean
  enabled?: boolean
  taskCount?: number
  fullscreen?: boolean
  fullscreenSuppressed?: boolean
  alertUntil?: number
  delay?: number
  peerInstance?: string
}

export interface IslandDiagEvent {
  instance: string
  seq: number
  at: number
  mono: number
  event: IslandDiagEventName
  fields: IslandDiagFields
}

export interface IslandDiagBatch {
  events: IslandDiagEvent[]
  dropped: number
}

export interface IslandDiagClock {
  now: () => number
  mono: () => number
}

export interface IslandDiagScheduler {
  setTimeout: (callback: () => void, delayMs: number) => unknown
  clearTimeout: (handle: unknown) => void
}

export interface IslandDiagBufferOptions {
  enabled?: boolean
  clock?: IslandDiagClock
  scheduler?: IslandDiagScheduler
}

export interface IslandDiagBuffer {
  readonly enabled: boolean
  readonly instance: string | undefined
  setEnabled(enabled: boolean): void
  record(event: IslandDiagEventName, fields?: IslandDiagFields): number | undefined
  flush(): void
  dispose(): void
}

export const ISLAND_DIAG_MAX_QUEUE = 64
export const ISLAND_DIAG_FLUSH_DELAY_MS = 50
export const ISLAND_DIAG_MAX_PER_SECOND = 200

const MAX_STRING_LENGTH = 64
const MAX_NUMBER_ABS = 1e15
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/
const INSTANCE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const EVENT_SET = new Set<string>(ISLAND_DIAG_EVENTS)
const FIELD_SET = new Set<string>(ISLAND_DIAG_FIELDS)
const MODE_SET = new Set<string>(ISLAND_DIAG_MODES)
const BOOLEAN_FIELDS = new Set<IslandDiagFieldName>([
  'visible',
  'hovering',
  'focused',
  'documentFocused',
  'interactive',
  'satellite',
  'reducedMotion',
  'ignore',
  'forward',
  'accepted',
  'cancelled',
  'enabled',
  'fullscreen',
  'fullscreenSuppressed'
])
const MODE_FIELDS = new Set<IslandDiagFieldName>(['mode', 'modeRef', 'displayMode', 'from', 'to'])

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_NUMBER_ABS
}

function isCode(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_STRING_LENGTH && CODE_PATTERN.test(value)
}

function isInstance(value: unknown): value is string {
  return typeof value === 'string' && INSTANCE_PATTERN.test(value)
}

function isValidFieldValue(name: IslandDiagFieldName, value: unknown): boolean {
  if (BOOLEAN_FIELDS.has(name)) return typeof value === 'boolean'
  if (MODE_FIELDS.has(name)) return typeof value === 'string' && MODE_SET.has(value)
  if (name === 'peerInstance') return isInstance(value)
  if (name === 'reason') return isCode(value)
  return isFiniteNumber(value)
}

function isValidFields(value: unknown): value is IslandDiagFields {
  if (!isPlainRecord(value)) return false
  return Object.entries(value).every(
    ([name, fieldValue]) =>
      FIELD_SET.has(name) && isValidFieldValue(name as IslandDiagFieldName, fieldValue)
  )
}

function isValidEvent(value: unknown): value is IslandDiagEvent {
  if (!isPlainRecord(value)) return false
  if (Object.keys(value).sort().join(',') !== 'at,event,fields,instance,mono,seq') return false
  const { instance, seq, at, mono, event, fields } = value
  return (
    isInstance(instance) &&
    typeof seq === 'number' &&
    Number.isInteger(seq) &&
    seq > 0 &&
    seq <= Number.MAX_SAFE_INTEGER &&
    isFiniteNumber(at) &&
    at >= 0 &&
    isFiniteNumber(mono) &&
    mono >= 0 &&
    typeof event === 'string' &&
    EVENT_SET.has(event) &&
    isValidFields(fields)
  )
}

/** IPC 边界使用的严格类型守卫；拒绝未知字段、正文和超大批次。 */
export function validateIslandDiagBatch(value: unknown): value is IslandDiagBatch {
  if (!isPlainRecord(value)) return false
  if (Object.keys(value).sort().join(',') !== 'dropped,events') return false
  const { events, dropped } = value
  if (!Array.isArray(events) || events.length > ISLAND_DIAG_MAX_QUEUE) return false
  if (
    typeof dropped !== 'number' ||
    !Number.isInteger(dropped) ||
    dropped < 0 ||
    dropped > Number.MAX_SAFE_INTEGER ||
    (events.length === 0 && dropped === 0)
  ) {
    return false
  }
  return events.every(isValidEvent)
}

function defaultClock(): IslandDiagClock {
  return { now: () => Date.now(), mono: () => performance.now() }
}

function defaultScheduler(): IslandDiagScheduler {
  return {
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)
  }
}

/** 创建有界诊断缓冲；关闭时 record 立即返回且不读取时钟。 */
export function createIslandDiagBuffer(
  send: (batch: IslandDiagBatch) => void,
  options: IslandDiagBufferOptions = {}
): IslandDiagBuffer {
  const clock = options.clock ?? defaultClock()
  const scheduler = options.scheduler ?? defaultScheduler()
  let enabled = options.enabled === true
  let instance: string | undefined
  let sequence = 0
  let dropped = 0
  let rateWindowStart: number | undefined
  let rateCount = 0
  let pendingTimer: unknown
  let timerGeneration = 0
  let timerPending = false
  const queue: IslandDiagEvent[] = []

  const clearPendingTimer = (): void => {
    timerGeneration += 1
    if (!timerPending) return
    scheduler.clearTimeout(pendingTimer)
    timerPending = false
    pendingTimer = undefined
  }

  const flush = (): void => {
    if (!enabled || (queue.length === 0 && dropped === 0)) return
    clearPendingTimer()
    const batch = { events: queue.splice(0), dropped }
    dropped = 0
    try {
      send(batch)
    } catch {
      // 诊断发送失败不能影响 UI 输入和 IPC 主流程。
    }
  }

  const scheduleFlush = (): void => {
    if (timerPending) return
    const generation = timerGeneration
    timerPending = true
    pendingTimer = scheduler.setTimeout(() => {
      if (generation !== timerGeneration) return
      timerPending = false
      pendingTimer = undefined
      flush()
    }, ISLAND_DIAG_FLUSH_DELAY_MS)
  }

  const drop = (): void => {
    dropped += 1
    scheduleFlush()
  }

  const record = (
    event: IslandDiagEventName,
    fields: IslandDiagFields = {}
  ): number | undefined => {
    // 先早退：关闭时不读取时钟、不生成 instance、不触碰队列。
    if (!enabled) return undefined
    if (!EVENT_SET.has(event)) return undefined
    if (queue.length >= ISLAND_DIAG_MAX_QUEUE) {
      drop()
      return undefined
    }
    const at = clock.now()
    const mono = clock.mono()
    if (!isFiniteNumber(at) || at < 0 || !isFiniteNumber(mono) || mono < 0) {
      drop()
      return undefined
    }
    if (
      rateWindowStart === undefined ||
      mono < rateWindowStart ||
      mono - rateWindowStart >= 1_000
    ) {
      rateWindowStart = mono
      rateCount = 0
    }
    if (rateCount >= ISLAND_DIAG_MAX_PER_SECOND) {
      drop()
      return undefined
    }
    instance ??= globalThis.crypto.randomUUID()
    sequence += 1
    rateCount += 1
    queue.push({ instance, seq: sequence, at, mono, event, fields })
    if (queue.length === 1) scheduleFlush()
    return sequence
  }

  return {
    get enabled(): boolean {
      return enabled
    },
    get instance(): string | undefined {
      return instance
    },
    setEnabled(value: boolean): void {
      enabled = value
      if (!value) {
        clearPendingTimer()
        queue.length = 0
        dropped = 0
        rateWindowStart = undefined
        rateCount = 0
      }
    },
    record,
    flush,
    // 清空本轮资源但允许同一 hook 在 StrictMode 重挂载后再次 setEnabled(true)。
    dispose(): void {
      enabled = false
      clearPendingTimer()
      queue.length = 0
      dropped = 0
      rateWindowStart = undefined
      rateCount = 0
    }
  }
}
