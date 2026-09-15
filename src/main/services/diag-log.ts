import { appendFile as appendFileAsync, mkdir, rename, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'

/**
 * 诊断日志:性能计数 + 关键路径耗时,写入 <userData>/diag/diag.log。
 * 默认开启(用户测试包),滚动上限 4MB;后续版本如需移除,只删本文件与各处 recordPerf 调用即可,
 * 其他业务代码零依赖。开关:环境变量 CODEX_STATUS_DIAG=0 关闭。
 *
 * 注意:本模块不得依赖 electron(单测在纯 Node 下 import 各服务模块),
 * userData 通过 app.setPath 之外的方式注入:主进程启动时调 setDiagDirectory。
 */

const DIAG_LOG_MAX_BYTES = 4 * 1024 * 1024
const PERF_REPORT_INTERVAL_MS = 10_000
const SLOW_THRESHOLD_MS = 200

let logDirectory: string | undefined
let logFilePath: string | undefined
let writeChain = Promise.resolve()

interface PerfCounter {
  count: number
  totalMs: number
  maxMs: number
}

const perfCounters = new Map<string, PerfCounter>()
const perfMarks = new Map<string, number>()

/** 主进程启动时注入日志根目录(通常是 userData);日志落在 <directory>/diag/diag.log */
export function setDiagDirectory(directory: string): void {
  logDirectory = join(directory, 'diag')
  logFilePath = undefined
}

function resolveDiagDirectory(): string {
  if (logDirectory) return logDirectory
  const base = process.env.APPDATA ?? process.env.XDG_STATE_HOME ?? tmpdir()
  return join(base, 'codex-status', 'diag')
}

function resolveDiagEnabled(): boolean {
  return process.env.CODEX_STATUS_DIAG !== '0'
}

function ensureLogPath(): string | undefined {
  if (!resolveDiagEnabled()) return undefined
  if (logFilePath) return logFilePath
  logFilePath = join(resolveDiagDirectory(), 'diag.log')
  return logFilePath
}

async function rotateIfNeeded(target: string): Promise<void> {
  let size: number
  try {
    size = (await stat(target)).size
  } catch {
    return
  }
  if (size <= DIAG_LOG_MAX_BYTES) return
  try {
    const oldPath = `${target}.old`
    await unlink(oldPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
    await rename(target, oldPath)
  } catch {
    // 轮转失败不阻塞业务,本次写入仍尝试追加到活动文件
  }
}

function appendLine(line: string): void {
  const target = ensureLogPath()
  if (!target) return
  // 串行化 mkdir/轮转/append,避免并发写入交错和同步文件操作阻塞主进程
  writeChain = writeChain.then(async () => {
    try {
      await mkdir(dirname(target), { recursive: true })
      await rotateIfNeeded(target)
      await appendFileAsync(target, line, 'utf8')
    } catch {
      // 诊断日志失败不能影响业务,也不能中断后续写入
    }
  })
}

/** 记录一条诊断日志(自动带时间戳) */
export function logDiag(message: string): void {
  appendLine(`${new Date().toISOString()} ${message}\n`)
}

/** 计数一次事件;sample 为该次耗时(毫秒)时同时统计 total/max */
export function recordPerf(name: string, sampleMs?: number): void {
  const counter = perfCounters.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 }
  counter.count += 1
  if (typeof sampleMs === 'number') {
    counter.totalMs += sampleMs
    counter.maxMs = Math.max(counter.maxMs, sampleMs)
  }
  perfCounters.set(name, counter)
  // 同步记录慢事件明细,方便定位单次卡顿时间点
  if (typeof sampleMs === 'number' && sampleMs >= SLOW_THRESHOLD_MS) {
    logDiag(`slow ${name} ${Math.round(sampleMs)}ms`)
  }
}

/** 区间耗时:开始打点 */
export function perfStart(mark: string): void {
  perfMarks.set(mark, Date.now())
}

/** 区间耗时:结束并记录 */
export function perfEnd(mark: string, name = mark): void {
  const startedAt = perfMarks.get(mark)
  if (startedAt === undefined) return
  perfMarks.delete(mark)
  recordPerf(name, Date.now() - startedAt)
}

/** 启动周期性汇总(每 10s 一行,含计数与主进程只读资源样本) */
export function startPerfReport(): void {
  if (!resolveDiagEnabled()) return
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 })
  eventLoopDelay.enable()
  let previousCpu = process.cpuUsage()
  const timer = setInterval(() => {
    const lines: string[] = []
    for (const [name, counter] of perfCounters) {
      if (counter.count === 0) continue
      const avg = counter.totalMs > 0 ? ` avg=${Math.round(counter.totalMs / counter.count)}ms` : ''
      const max = counter.maxMs > 0 ? ` max=${Math.round(counter.maxMs)}ms` : ''
      lines.push(`${name}=${counter.count}${avg}${max}`)
    }
    perfCounters.clear()
    const currentCpu = process.cpuUsage()
    const cpuUserMs = Math.round((currentCpu.user - previousCpu.user) / 1_000)
    const cpuSystemMs = Math.round((currentCpu.system - previousCpu.system) / 1_000)
    previousCpu = currentCpu
    const memory = process.memoryUsage()
    const eventLoopMaxMs = Math.round(eventLoopDelay.max / 1_000_000)
    const eventLoopP99Ms = Math.round(eventLoopDelay.percentile(99) / 1_000_000)
    lines.push(
      `process.cpu.user=${cpuUserMs}ms process.cpu.system=${cpuSystemMs}ms ` +
        `process.rss=${memory.rss}B process.heapUsed=${memory.heapUsed}B ` +
        `eventLoop.max=${eventLoopMaxMs}ms eventLoop.p99=${eventLoopP99Ms}ms`
    )
    eventLoopDelay.reset()
    logDiag(`perf ${lines.join(' ')}`)
  }, PERF_REPORT_INTERVAL_MS)
  timer.unref?.()
}
