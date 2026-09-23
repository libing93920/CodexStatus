import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import type { BrowserWindow } from 'electron'
import { CAPSULE_NATIVE_PROBE } from './capsule-native-probe.ts'
import { formatDiagError, resolveDiagEnabled, writeDiagBatch } from './diag-log.ts'

const SAMPLE_INTERVAL_MS = 2_000
const STARTUP_TIMEOUT_MS = 30_000
const REQUEST_TIMEOUT_MS = 15_000
const MAX_STARTUP_RETRIES = 1
const HEARTBEAT_INTERVAL_MS = 60_000
const MAX_PENDING_WRITES = 2
const MAX_NATIVE_LINE_LENGTH = 16_384
const MAX_ERROR_LENGTH = 500
const WINDOW_EVENTS = [
  'show',
  'hide',
  'focus',
  'blur',
  'move',
  'resize',
  'minimize',
  'restore'
] as const

interface EventSummary {
  count: number
  firstAt: number
  lastAt: number
}

interface Dependencies {
  write?: typeof writeDiagBatch
  launch?: () => ChildProcessWithoutNullStreams
}

/** 只观察，不调用 show/focus/置顶修复；事件合并后由低频采样统一落盘。 */
export class CapsuleWindowDiagnostics {
  private readonly window: BrowserWindow
  private readonly write: typeof writeDiagBatch
  private readonly listeners = new Map<string, (...args: unknown[]) => void>()
  private readonly events: Record<string, EventSummary> = {}
  private child?: ChildProcessWithoutNullStreams
  private lines?: Interface
  private launch?: () => ChildProcessWithoutNullStreams
  private startupRetries = 0
  private timer?: ReturnType<typeof setInterval>
  private timeout?: ReturnType<typeof setTimeout>
  private status: 'starting' | 'ready' | 'unavailable' | 'stopped' = 'starting'
  private stopped = false
  private requestedAt?: number
  private pendingWrites = 0
  private dropped = 0
  private sequence = 0
  private lastSignature = ''
  private lastWrittenAt = 0
  private probeError?: string
  private readonly hwnd: string

  constructor(window: BrowserWindow, dependencies: Dependencies = {}) {
    this.window = window
    this.write = dependencies.write ?? writeDiagBatch
    this.hwnd = ''
    if (process.platform !== 'win32' || !resolveDiagEnabled()) {
      this.stopped = true
      return
    }
    const handle = window.getNativeWindowHandle()
    this.hwnd = String(handle.length === 8 ? handle.readBigUInt64LE() : handle.readUInt32LE())
    for (const event of WINDOW_EVENTS) this.listen(event, () => this.record(event))
    this.listen('always-on-top-changed', (_event, topmost) =>
      this.record(topmost ? 'topmost-on' : 'topmost-off')
    )
    this.listen('closed', () => this.stop())
    this.record('created')
    this.emit()
    this.startProbe(dependencies.launch ?? launchProbe)
    this.timer = setInterval(() => this.sample(), SAMPLE_INTERVAL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.status = 'stopped'
    this.record('stopped')
    this.emit(undefined, true)
    if (this.timer) clearInterval(this.timer)
    for (const [event, listener] of this.listeners)
      this.window.removeListener(event as 'show', listener)
    this.listeners.clear()
    this.stopProbe()
  }

  private listen(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.set(event, listener)
    this.window.on(event as 'show', listener)
  }

  private record(event: string): void {
    const now = Date.now()
    const summary = this.events[event] ?? { count: 0, firstAt: now, lastAt: now }
    summary.count++
    summary.lastAt = now
    this.events[event] = summary
  }

  private startProbe(launch: () => ChildProcessWithoutNullStreams): void {
    this.launch = launch
    try {
      const child = launch()
      this.child = child
      this.lines = createInterface({ input: child.stdout })
      this.lines.on('line', (line) => this.receive(line))
      let stderr = ''
      child.stderr.on('data', (chunk) => {
        stderr = `${stderr}${String(chunk)}`.slice(-MAX_ERROR_LENGTH)
      })
      child.once('error', (error) => this.failProbe(formatDiagError(error)))
      child.stdin.on('error', (error) => this.failProbe(formatDiagError(error)))
      child.once('close', (code, signal) => {
        if (this.child !== child) return
        this.failProbe(`exit=${code} signal=${signal} ${stderr}`)
      })
      this.armTimeout(STARTUP_TIMEOUT_MS)
    } catch (error) {
      this.failProbe(formatDiagError(error))
    }
  }

  private sample(): void {
    if (this.stopped) return
    if (!resolveDiagEnabled() || this.window.isDestroyed()) return this.stop()
    if (this.status === 'starting' || this.requestedAt !== undefined) return
    if (this.status === 'unavailable') return this.emit()
    if (!this.window.isVisible() && !Object.keys(this.events).length && !this.heartbeatDue()) return
    this.requestedAt = Date.now()
    this.armTimeout(REQUEST_TIMEOUT_MS)
    // 一次只保留一个在途请求，子进程或管道变慢时不堆积采样任务。
    this.child?.stdin.write(`${this.hwnd}\n`)
  }

  private receive(line: string): void {
    if (this.stopped || this.status === 'unavailable') return
    if (line === 'ready' && this.status === 'starting') {
      this.clearTimeout()
      this.status = 'ready'
      this.startupRetries = 0
      this.record('probe-ready')
      this.sample()
      return
    }
    if (this.requestedAt === undefined) return this.failProbe('unexpected-output')
    if (line.length > MAX_NATIVE_LINE_LENGTH) return this.failProbe('oversized-output')
    try {
      const native = JSON.parse(line) as Record<string, unknown>
      if (!native || typeof native !== 'object' || !Array.isArray(native.overlapCandidates)) {
        return this.failProbe('invalid-output')
      }
      this.clearTimeout()
      this.emit(native)
      this.requestedAt = undefined
    } catch {
      this.failProbe('invalid-json')
    }
  }

  private failProbe(message: string): void {
    if (this.stopped || this.status === 'unavailable') return
    if (this.status === 'starting' && this.startupRetries < MAX_STARTUP_RETRIES) {
      this.startupRetries++
      this.probeError = message.replace(/[\r\n]+/g, ' ').slice(0, MAX_ERROR_LENGTH)
      this.record('probe-retry')
      this.stopProbe()
      this.status = 'starting'
      this.startProbe(this.launch!)
      this.emit()
      return
    }
    this.status = 'unavailable'
    this.probeError = message.replace(/[\r\n]+/g, ' ').slice(0, MAX_ERROR_LENGTH)
    this.record('probe-failed')
    this.stopProbe()
    this.emit()
  }
  private armTimeout(delay: number): void {
    this.clearTimeout()
    this.timeout = setTimeout(() => this.failProbe('probe-timeout'), delay)
    this.timeout.unref?.()
  }

  private stopProbe(): void {
    this.clearTimeout()
    this.requestedAt = undefined
    this.lines?.close()
    this.lines = undefined
    const child = this.child
    this.child = undefined
    child?.stdin.end()
    child?.kill()
  }


  private clearTimeout(): void {
    if (this.timeout) clearTimeout(this.timeout)
    this.timeout = undefined
  }

  private heartbeatDue(): boolean {
    return Date.now() - this.lastWrittenAt >= HEARTBEAT_INTERVAL_MS
  }

  private electronState(): Record<string, unknown> {
    if (this.window.isDestroyed()) return { destroyed: true }
    return {
      visible: this.window.isVisible(),
      focused: this.window.isFocused(),
      topmost: this.window.isAlwaysOnTop(),
      minimized: this.window.isMinimized(),
      // Electron 为 DIP，原生探测器为物理像素，字段名显式区分。
      boundsDip: this.window.getBounds()
    }
  }

  private emit(native: Record<string, unknown> | null = null, force = false): void {
    if (!resolveDiagEnabled()) return
    const state = { electron: this.electronState(), nativeStatus: this.status, native }
    const signature = JSON.stringify(state)
    const changed = signature !== this.lastSignature
    if (!changed && !Object.keys(this.events).length && !this.heartbeatDue() && !this.dropped)
      return
    if (!force && this.pendingWrites >= MAX_PENDING_WRITES) {
      this.dropped++
      return
    }
    const now = Date.now()
    const payload = {
      hwnd: this.hwnd,
      seq: ++this.sequence,
      at: now,
      reason: changed
        ? 'state-change'
        : Object.keys(this.events).length
          ? 'window-events'
          : 'heartbeat',
      events: this.events,
      sinkDropped: this.dropped,
      requestedAt: this.requestedAt,
      nativeElapsedMs: this.requestedAt === undefined ? undefined : now - this.requestedAt,
      probeError: this.probeError,
      ...state
    }
    const message = `capsule-diag ${JSON.stringify(payload)}`
    for (const event of Object.keys(this.events)) delete this.events[event]
    this.dropped = 0
    this.lastSignature = signature
    this.lastWrittenAt = now
    this.pendingWrites++
    void this.write(message)
      .catch(() => undefined)
      .finally(() => {
        this.pendingWrites--
      })
  }
}

function launchProbe(): ChildProcessWithoutNullStreams {
  return spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(CAPSULE_NATIVE_PROBE, 'utf16le').toString('base64')
    ],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
  )
}
