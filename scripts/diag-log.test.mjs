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
    islandSource.indexOf('const effect = ++diagnostic.counters.current.effect')
  )
  const ending = '  }, [presentation.visible])'
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
      trace: () => undefined
    }
    const interactiveRef = { current: false }
    const pendingHitTestRef = { current: false }
    const modeRef = { current: 'compact' }
    const expandedHeightRef = { current: 200 }
    const satelliteRef = { current: false }
    const latestPointer = { current: { x: 0, y: 0, timeStamp: 0, valid: false } }
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
      interactiveRef,
      pendingHitTestRef,
      modeRef,
      expandedHeightRef,
      satelliteRef,
      latestPointer,
      presentationRef: { current: true },
      tracePointerLeave: () => undefined,
      rememberPointer: (event) => {
        Object.assign(latestPointer.current, {
          x: event.clientX,
          y: event.clientY,
          timeStamp: event.timeStamp,
          valid: true
        })
      },
      setIslandInteractive: (value) => {
        if (value === interactiveRef.current) return
        interactiveRef.current = value
        calls.push(value)
      },
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
    else events.mouseleave({ clientX: 10, clientY: 300 })
    assert.deepEqual(cancelled, [1])
    // 即使测试强行调用已取消回调，旧坐标也必须失效。
    frame()
    assert.deepEqual(calls, [])
  }
})

function pointerHarness(source = islandSource) {
  const ast = ts.createSourceFile(
    'Island.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const island = ast.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'Island'
  )
  const helpers = ['setIslandInteractive', 'rememberPointer']
  const statements = island.body.statements.filter((node) => {
    if (ts.isFunctionDeclaration(node)) return helpers.includes(node.name?.text)
    const text = node.getText(ast)
    return (
      (text.startsWith('useEffect(') && text.includes("document.addEventListener('pointermove'")) ||
      (text.startsWith('useLayoutEffect(') && text.includes("'geometry-change'"))
    )
  })
  const geometry = ast.statements.filter(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      ['isPointInIsland', 'islandHitRects'].includes(node.name?.text)
  )
  const code = ts.transpileModule(
    [...geometry, ...statements].map((n) => n.getText(ast)).join('\n'),
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022 }
    }
  ).outputText
  const events = {},
    calls = [],
    frames = new Map(),
    effects = new Map()
  let frameId = 0
  const ref = (current) => ({ current })
  const effect = (name, callback, deps) => {
    const previous = effects.get(name)
    if (previous && deps.every((value, i) => value === previous.deps[i])) return
    previous?.cleanup?.()
    effects.set(name, { deps: Array.from(deps), cleanup: callback() })
  }
  const context = vm.createContext({
    mode: 'compact',
    expandedHeight: 200,
    satelliteStatus: undefined,
    presentation: { visible: true },
    modeRef: ref('compact'),
    expandedHeightRef: ref(200),
    satelliteRef: ref(false),
    interactiveRef: ref(false),
    presentationRef: ref(true),
    pendingHitTestRef: ref(false),
    latestPointer: ref({ x: 0, y: 0, timeStamp: 0, valid: false }),
    cancelInteractiveFrameRef: ref(() => undefined),
    diagnostic: {
      counters: ref({ effect: 0 }),
      trace: () => undefined,
      samplePoint: () => undefined
    },
    tracePointerLeave: () => undefined,
    window: {
      codexStatus: {
        setIslandInteractive: (value) => {
          calls.push(value)
        }
      }
    },
    document: {
      addEventListener: (name, callback) => {
        events[name] = callback
      },
      removeEventListener: (name) => {
        delete events[name]
      }
    },
    requestAnimationFrame: (callback) => {
      frames.set(++frameId, callback)
      return frameId
    },
    cancelAnimationFrame: (id) => frames.delete(id),
    useLayoutEffect: (fn, deps) => effect('layout', fn, deps),
    useEffect: (fn, deps) => effect('pointer', fn, deps)
  })
  const render = (values = {}) => {
    Object.assign(context, values)
    vm.runInContext(code, context)
  }
  const move = (x, y) => events.pointermove({ clientX: x, clientY: y, timeStamp: 1 })
  const flush = () => {
    const pending = [...frames.values()]
    frames.clear()
    pending.forEach((fn) => fn())
  }
  render()
  return { context, events, calls, frames, render, move, flush }
}

test('生产交互在静止指针展开和尺寸变化期间不关闭穿透命中', () => {
  const h = pointerHarness()
  h.move(222, 15)
  h.flush()
  assert.deepEqual(h.calls, [true])
  h.render({ mode: 'expanded' })
  h.render({ expandedHeight: 362, satelliteStatus: 'waiting-input' })
  assert.deepEqual(h.calls, [true])
  assert.equal(h.context.diagnostic.counters.current.effect, 1)
})

test('几何提交取消待执行命中并使用最新参数，旧回调不会覆盖结果', () => {
  const h = pointerHarness()
  h.move(222, 15)
  h.flush()
  h.move(232, 250)
  const stale = [...h.frames.values()][0]
  h.render({ mode: 'expanded', expandedHeight: 362 })
  assert.equal(h.frames.size, 0)
  stale()
  assert.deepEqual(h.calls, [true])
  h.render({ expandedHeight: 200 })
  assert.deepEqual(h.calls, [true, false])
})

test('生产命中重复状态不发IPC，document leave后尺寸变化不复活旧坐标', () => {
  const h = pointerHarness()
  for (let i = 0; i < 500; i++) {
    h.move(222, 15)
    h.flush()
  }
  assert.deepEqual(h.calls, [true])
  h.events.mouseleave({ clientX: 222, clientY: 15 })
  h.render({ mode: 'expanded' })
  assert.deepEqual(h.calls, [true, false])
  assert.equal(h.context.latestPointer.current.valid, false)
})

test('隐藏清理和重显不沿用旧坐标，隐藏时迟到移动不排队', () => {
  const h = pointerHarness()
  h.move(222, 15)
  h.flush()
  const lateMove = h.events.pointermove
  h.move(222, 16)
  const stale = [...h.frames.values()][0]
  h.context.presentationRef.current = false
  h.render({ presentation: { visible: false } })
  lateMove({ clientX: 222, clientY: 17, timeStamp: 2 })
  stale()
  assert.equal(h.frames.size, 0)
  assert.deepEqual(h.calls, [true, false])
  h.context.presentationRef.current = true
  h.render({ presentation: { visible: true } })
  assert.deepEqual(h.calls, [true, false])
  h.move(222, 15)
  h.flush()
  assert.deepEqual(h.calls, [true, false, true])
})

test('关闭诊断时离开记录不读取事件字段或DOM', () => {
  const ast = ts.createSourceFile(
    'Island.tsx',
    islandSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const island = ast.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'Island'
  )
  const method = island.body.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'tracePointerLeave'
  )
  const code = ts.transpileModule(method.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  const recordLeave = vm.runInNewContext(code + ';tracePointerLeave', {
    diagnostic: { buffer: { enabled: false } }
  })
  const event = new Proxy(
    {},
    {
      get: () => {
        throw new Error('不应采集离开诊断字段')
      }
    }
  )
  assert.doesNotThrow(() => recordLeave('pointer-leave', event))
})
