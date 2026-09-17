/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

import {
  formatDiagError,
  logDiag,
  setDiagDirectory,
  startPerfReport
} from '../src/main/services/diag-log.ts'

const DIAG_LOG_MAX_BYTES = 4 * 1024 * 1024
const islandSource = await fs.readFile(resolve('src/renderer/src/island/Island.tsx'), 'utf8')
const diagSource = await fs.readFile(resolve('src/main/services/diag-log.ts'), 'utf8')

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(25)
  }
  assert.fail('diagnostic log condition was not reached before timeout')
}

test('诊断日志连续轮转只保留活动文件和一个 old', async (context) => {
  const directory = await fs.mkdtemp(join(os.tmpdir(), 'codex-status-diag-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const previousEnabled = process.env.CODEX_STATUS_DIAG
  process.env.CODEX_STATUS_DIAG = '1'
  context.after(() => {
    if (previousEnabled === undefined) delete process.env.CODEX_STATUS_DIAG
    else process.env.CODEX_STATUS_DIAG = previousEnabled
  })

  setDiagDirectory(directory)
  const firstLargeLine = `cycle-one ${'x'.repeat(DIAG_LOG_MAX_BYTES)}`
  const secondLargeLine = `cycle-two ${'y'.repeat(DIAG_LOG_MAX_BYTES)}`
  logDiag(firstLargeLine)
  logDiag('cycle-one-tail')
  logDiag(secondLargeLine)
  logDiag('cycle-two-tail')

  const logDirectory = join(directory, 'diag')
  const activePath = join(logDirectory, 'diag.log')
  const oldPath = `${activePath}.old`
  await waitFor(async () => {
    try {
      const [active, old] = await Promise.all([
        fs.readFile(activePath, 'utf8'),
        fs.readFile(oldPath, 'utf8')
      ])
      return active.includes('cycle-two-tail') && old.includes('cycle-two ')
    } catch {
      return false
    }
  })

  const files = (await fs.readdir(logDirectory)).sort()
  assert.deepEqual(files, ['diag.log', 'diag.log.old'])
  assert.ok((await fs.stat(activePath)).size <= DIAG_LOG_MAX_BYTES)
  assert.match(await fs.readFile(activePath, 'utf8'), /cycle-two-tail/)
  assert.doesNotMatch(await fs.readFile(activePath, 'utf8'), /cycle-one-tail/)
  assert.match(await fs.readFile(oldPath, 'utf8'), /cycle-two /)
})

test('诊断日志 IO 失败不会抛出且后续目录仍可写入', async (context) => {
  const directory = await fs.mkdtemp(join(os.tmpdir(), 'codex-status-diag-error-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const previousEnabled = process.env.CODEX_STATUS_DIAG
  process.env.CODEX_STATUS_DIAG = '1'
  context.after(() => {
    if (previousEnabled === undefined) delete process.env.CODEX_STATUS_DIAG
    else process.env.CODEX_STATUS_DIAG = previousEnabled
  })

  const blockedPath = join(directory, 'blocked')
  await fs.writeFile(blockedPath, 'not a directory')
  setDiagDirectory(blockedPath)
  assert.doesNotThrow(() => logDiag('this write is intentionally blocked'))
  await delay(50)

  setDiagDirectory(directory)
  logDiag('write-after-error')
  const activePath = join(directory, 'diag', 'diag.log')
  await waitFor(async () => {
    try {
      return (await fs.readFile(activePath, 'utf8')).includes('write-after-error')
    } catch {
      return false
    }
  })
})

test('诊断异常格式保留错误码且不会打断单行日志', () => {
  const error = Object.assign(new Error('pipe\r\nclosed'), { code: 'ENOENT' })
  const formatted = formatDiagError(error)
  assert.match(formatted, /errorCode="ENOENT"/)
  assert.match(formatted, /error="pipe closed"/)
  assert.doesNotMatch(formatted, /[\r\n]/)
})

test('主进程性能报告保留采样契约', () => {
  assert.match(islandSource, /cancelAnimationFrame\(frameId\)/)
  assert.match(islandSource, /pendingEvent = undefined/)
  assert.match(islandSource, /cancelInteractiveFrameRef\.current\(\)/)
  assert.match(diagSource, /monitorEventLoopDelay/)
  assert.match(diagSource, /process\.cpuUsage\(\)/)
  assert.match(diagSource, /process\.memoryUsage\(\)/)
  assert.match(diagSource, /eventLoopDelay\.percentile\(99\)/)
  assert.match(diagSource, /if \(!resolveDiagEnabled\(\)\) return/)
  assert.equal(typeof startPerfReport, 'function')
})

test('生产鼠标effect在离开和清理后不会执行过期命中', () => {
  const start = islandSource.lastIndexOf(
    '  useEffect(() => {',
    islandSource.indexOf('let interactive = false')
  )
  const ending = '  }, [expandedHeight, mode, presentation.visible, satelliteStatus])'
  const end = islandSource.indexOf(ending, start) + ending.length
  const code = ts.transpileModule(islandSource.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  for (const action of ['mouseleave', 'cleanup', 'pointerleave']) {
    const events = {}
    const calls = []
    const cancelled = []
    const diagnostic = {
      counters: { current: { effect: 0 } },
      trace: () => undefined,
      samplePoint: () => undefined
    }
    let frame
    let cleanup
    const cancelInteractiveFrameRef = { current: () => undefined }
    vm.runInNewContext(code, {
      useEffect: (fn) => {
        cleanup = fn()
      },
      presentation: { visible: true },
      mode: 'compact',
      expandedHeight: 200,
      satelliteStatus: undefined,
      diagnostic,
      setIslandInteractive: (value) => calls.push(value),
      isPointInIsland: () => true,
      requestAnimationFrame: (fn) => {
        frame = fn
        return 1
      },
      cancelAnimationFrame: (id) => cancelled.push(id),
      cancelInteractiveFrameRef,
      document: {
        addEventListener: (name, fn) => {
          events[name] = fn
        },
        removeEventListener: (name) => {
          delete events[name]
        }
      }
    })
    events.pointermove({ clientX: 100, clientY: 10 })
    if (action === 'cleanup') cleanup()
    else if (action === 'pointerleave') cancelInteractiveFrameRef.current()
    else events.mouseleave()
    assert.deepEqual(cancelled, [1])
    // 即使测试强行调用已取消回调，旧坐标也必须失效。
    frame()
    assert.deepEqual(calls, [])
  }
})
