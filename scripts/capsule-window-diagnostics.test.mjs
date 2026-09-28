/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { CapsuleWindowDiagnostics } from '../src/main/services/capsule-window-diagnostics.ts'

const WINDOW_EVENTS = [
  'show',
  'hide',
  'focus',
  'blur',
  'move',
  'resize',
  'minimize',
  'restore',
  'always-on-top-changed',
  'closed'
]
const testWindows = (name, fn) => test(name, { skip: process.platform !== 'win32' }, fn)

testWindows('诊断关闭时保留防御采样，但不写日志', async (context) => {
  const restoreDiagnostics = setDiagnosticsEnabled('0')
  context.after(restoreDiagnostics)

  const window = new FakeWindow()
  const child = new FakeChild()
  let launchCount = 0
  let writeCount = 0
  const diagnostics = new CapsuleWindowDiagnostics(window, {
    role: 'capsule',
    canRecover: () => true,
    launch: () => {
      launchCount++
      return child
    },
    write: async () => {
      writeCount++
    }
  })

  await sendReady(child)
  await sendNative(child)
  assert.equal(launchCount, 1)
  assert.equal(writeCount, 0)
  assert.equal(child.requests.length, 1)
  assert.ok(window.eventNames().length > 0)

  diagnostics.stop()
  diagnostics.stop()
  assert.equal(window.eventNames().length, 0)
})

testWindows('隐藏窗口 ready 后首采样，60 秒前不重复采样且 native JSON 合法', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 })
  const restoreDiagnostics = setDiagnosticsEnabled('1')
  context.after(restoreDiagnostics)

  const messages = []
  const child = new FakeChild()
  const window = new FakeWindow()
  window.visible = false
  const diagnostics = new CapsuleWindowDiagnostics(window, {
    role: 'capsule',
    canRecover: () => true,
    launch: () => child,
    write: async (message) => messages.push(message)
  })
  context.after(() => diagnostics.stop())

  assert.equal(child.requests.length, 0)
  await sendReady(child)
  assert.equal(child.requests.length, 1)

  await sendNative(child)
  await flushPromises()
  assert.equal(messages.length, 2)
  assert.deepEqual(lastPayload(messages).native.overlapCandidates, [])

  for (let index = 0; index < 29; index++) {
    context.mock.timers.tick(2_000)
    assert.equal(child.requests.length, 1)
  }
  context.mock.timers.tick(2_000)
  assert.equal(child.requests.length, 2)
  await sendNative(child)
  await flushPromises()
  assert.equal(messages.length, 3)
  assert.equal(lastPayload(messages).reason, 'heartbeat')
})

testWindows('topmost 丢失和恢复会在采样中落盘，重复窗口事件只保留聚合计数', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 })
  const restoreDiagnostics = setDiagnosticsEnabled('1')
  context.after(restoreDiagnostics)

  const messages = []
  const child = new FakeChild()
  const window = new FakeWindow()
  const diagnostics = new CapsuleWindowDiagnostics(window, {
    role: 'capsule',
    canRecover: () => true,
    launch: () => child,
    write: async (message) => messages.push(message)
  })
  context.after(() => diagnostics.stop())

  await sendReady(child)
  await sendNative(child)
  await flushPromises()
  messages.length = 0

  window.topmost = false
  window.emit('always-on-top-changed', {}, false)
  context.mock.timers.tick(2_000)
  assert.equal(child.requests.length, 2)
  context.mock.timers.tick(2_000)
  assert.equal(child.requests.length, 2)
  await sendNative(child, nativeSnapshot(false))
  await flushPromises()
  const lost = lastPayload(messages)
  assert.equal(lost.electron.topmost, false)
  assert.equal(lost.native.capsule.topmost, false)
  assert.equal(lost.events['topmost-off'].count, 1)

  messages.length = 0
  window.topmost = true
  window.emit('always-on-top-changed', {}, true)
  context.mock.timers.tick(2_000)
  await sendNative(child, nativeSnapshot(true))
  await flushPromises()
  const recovered = lastPayload(messages)
  assert.equal(recovered.electron.topmost, true)
  assert.equal(recovered.native.capsule.topmost, true)
  assert.equal(recovered.events['topmost-on'].count, 1)

  messages.length = 0
  for (let index = 0; index < 1_000; index++) {
    window.emit('show')
    window.emit('show')
  }
  context.mock.timers.tick(2_000)
  await sendNative(child)
  await flushPromises()
  const coalesced = lastPayload(messages)
  assert.equal(coalesced.events.show.count, 2_000)
  assert.ok(Object.keys(coalesced.events).length <= WINDOW_EVENTS.length)
})

testWindows('稳定状态不写入，60 秒 heartbeat 会写入一次', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 })
  const restoreDiagnostics = setDiagnosticsEnabled('1')
  context.after(restoreDiagnostics)

  const messages = []
  const child = new FakeChild()
  const diagnostics = new CapsuleWindowDiagnostics(new FakeWindow(), {
    role: 'capsule',
    canRecover: () => true,
    launch: () => child,
    write: async (message) => messages.push(message)
  })
  context.after(() => diagnostics.stop())

  await sendReady(child)
  await sendNative(child)
  await flushPromises()
  messages.length = 0

  context.mock.timers.tick(1_999)
  assert.equal(messages.length, 0)
  context.mock.timers.tick(1)
  await sendNative(child)
  await flushPromises()
  assert.equal(messages.length, 0)

  for (let index = 0; index < 28; index++) {
    context.mock.timers.tick(2_000)
    await sendNative(child)
    await flushPromises()
    assert.equal(messages.length, 0)
  }
  context.mock.timers.tick(2_000)
  await sendNative(child)
  await flushPromises()
  assert.equal(messages.length, 1)
  assert.equal(lastPayload(messages).reason, 'heartbeat')
})

testWindows('慢盘最多保留两个在途写入，阻塞期间丢弃量和窗口事件仍有界聚合', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 })
  const restoreDiagnostics = setDiagnosticsEnabled('1')
  context.after(restoreDiagnostics)

  const messages = []
  const resolvers = []
  const child = new FakeChild()
  const window = new FakeWindow()
  const diagnostics = new CapsuleWindowDiagnostics(window, {
    role: 'capsule',
    canRecover: () => true,
    launch: () => child,
    write: (message) => {
      messages.push(message)
      return new Promise((resolve) => resolvers.push(resolve))
    }
  })
  context.after(() => diagnostics.stop())

  await sendReady(child)
  await sendNative(child)
  assert.equal(messages.length, 2)

  for (let index = 0; index < 2_000; index++) {
    window.emit('always-on-top-changed', {}, false)
    window.emit('always-on-top-changed', {}, true)
  }
  context.mock.timers.tick(2_000)
  await sendNative(child)
  assert.equal(messages.length, 2)

  resolvers[0]()
  await flushPromises()
  context.mock.timers.tick(2_000)
  await sendNative(child)
  await flushPromises()
  assert.equal(messages.length, 3)
  const payload = lastPayload(messages)
  assert.ok(payload.sinkDropped > 0)
  assert.equal(payload.events['topmost-off'].count, 2_000)
  assert.equal(payload.events['topmost-on'].count, 2_000)
  assert.ok(Object.keys(payload.events).length <= WINDOW_EVENTS.length)
  assert.ok(messages[2].length < 10_000)

  for (const resolve of resolvers.slice(1)) resolve()
  await flushPromises()
})

testWindows('native 输出缺少 overlapCandidates 时停止探测且不改变窗口', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 })
  const restoreDiagnostics = setDiagnosticsEnabled('1')
  context.after(restoreDiagnostics)

  const messages = []
  const children = [new FakeChild(), new FakeChild()]
  const window = new FakeWindow()
  let launchCount = 0
  const diagnostics = new CapsuleWindowDiagnostics(window, {
    role: 'capsule',
    canRecover: () => true,
    launch: () => children[launchCount++],
    write: async (message) => messages.push(message)
  })
  context.after(() => diagnostics.stop())

  await sendReady(children[0])
  children[0].stdout.write('{"capsule":null}\n')
  await flushIo()
  await flushPromises()
  assert.equal(launchCount, 2)
  assert.equal(children[0].killCount, 1)

  await sendReady(children[1])
  children[1].stdout.write('{"capsule":null}\n')
  await flushIo()
  await flushPromises()
  assert.equal(children[1].killCount, 1)
  assert.equal(lastPayload(messages).nativeStatus, 'unavailable')
  assert.deepEqual(window.mutationCalls, [])
  const messageCount = messages.length
  context.mock.timers.tick(30_000)
  assert.equal(messages.length, messageCount)
})

testWindows('探测 error、stdin error、close 都只清理探测进程', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 })
  const restoreDiagnostics = setDiagnosticsEnabled('1')
  context.after(restoreDiagnostics)

  for (const trigger of ['error', 'stdin-error', 'close']) {
    const messages = []
    const child = new FakeChild()
    const window = new FakeWindow()
    const diagnostics = new CapsuleWindowDiagnostics(window, {
      role: 'capsule',
      canRecover: () => true,
      launch: () => child,
      write: async (message) => messages.push(message)
    })

    if (trigger === 'error') child.emit('error', new Error('probe failed'))
    if (trigger === 'stdin-error') child.stdin.emit('error', new Error('pipe failed'))
    if (trigger === 'close') child.emit('close', 1, 'SIGTERM')
    if (child.killCount === 1) {
      if (trigger === 'error') child.emit('error', new Error('probe failed again'))
      if (trigger === 'stdin-error') child.stdin.emit('error', new Error('pipe failed again'))
      if (trigger === 'close') child.emit('close', 1, 'SIGTERM')
    }

    await flushPromises()
    context.mock.timers.tick(60_000)
    assert.equal(child.killCount, 2, trigger)
    assert.equal(lastPayload(messages).nativeStatus, 'unavailable', trigger)
    assert.equal(typeof lastPayload(messages).probeError, 'string', trigger)
    assert.deepEqual(window.mutationCalls, [], trigger)
    diagnostics.stop()
  }
})

testWindows('stop 在两个写入在途时仍保留最终 stopped 记录', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 })
  const restoreDiagnostics = setDiagnosticsEnabled('1')
  context.after(restoreDiagnostics)

  const messages = []
  const resolvers = []
  const child = new FakeChild()
  const diagnostics = new CapsuleWindowDiagnostics(new FakeWindow(), {
    role: 'capsule',
    canRecover: () => true,
    launch: () => child,
    write: (message) => {
      messages.push(message)
      return new Promise((resolve) => resolvers.push(resolve))
    }
  })
  await sendReady(child)
  await sendNative(child)
  assert.equal(messages.length, 2)

  diagnostics.stop()
  assert.equal(messages.length, 3)
  assert.equal(lastPayload(messages).events.stopped.count, 1)
  for (const resolve of resolvers) resolve()
  await flushPromises()
})

testWindows('探测启动失败只重试一次，第二次 ready 后恢复采样', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 })
  const restoreDiagnostics = setDiagnosticsEnabled('1')
  context.after(restoreDiagnostics)

  const messages = []
  const children = [new FakeChild(), new FakeChild()]
  let launchCount = 0
  const diagnostics = new CapsuleWindowDiagnostics(new FakeWindow(), {
    role: 'capsule',
    canRecover: () => true,
    launch: () => children[launchCount++],
    write: async (message) => messages.push(message)
  })
  context.after(() => diagnostics.stop())

  context.mock.timers.tick(30_000)
  assert.equal(launchCount, 2)
  assert.equal(children[0].killCount, 1)
  await sendReady(children[1])
  await sendNative(children[1])
  await flushPromises()
  assert.equal(lastPayload(messages).nativeStatus, 'ready')
  assert.equal(children[1].requests.length, 1)
})
testWindows('启动超时后只重试一次并清理旧探测进程', (context) => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 })
  const restoreDiagnostics = setDiagnosticsEnabled('1')
  context.after(restoreDiagnostics)

  const messages = []
  const children = [new FakeChild(), new FakeChild()]
  let launchCount = 0
  const window = new FakeWindow()
  const diagnostics = new CapsuleWindowDiagnostics(window, {
    role: 'capsule',
    canRecover: () => true,
    launch: () => children[launchCount++],
    write: async (message) => messages.push(message)
  })
  context.mock.timers.tick(30_000)
  assert.equal(launchCount, 2)
  assert.equal(children[0].killCount, 1)
  diagnostics.stop()
})

testWindows('stop 幂等地移除窗口监听、定时器并关闭子进程', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 })
  const restoreDiagnostics = setDiagnosticsEnabled('1')
  context.after(restoreDiagnostics)

  const messages = []
  const child = new FakeChild()
  const window = new FakeWindow()
  const diagnostics = new CapsuleWindowDiagnostics(window, {
    role: 'capsule',
    canRecover: () => true,
    launch: () => child,
    write: async (message) => messages.push(message)
  })

  diagnostics.stop()
  const messageCount = messages.length
  diagnostics.stop()
  assert.equal(child.killCount, 1)
  assert.equal(window.eventNames().length, 0)

  context.mock.timers.tick(30_000)
  window.emit('show')
  assert.equal(messages.length, messageCount)
  await flushPromises()
})

testWindows('探测就绪后运行期错误有限重启，有效采样后重置重试计数', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 })
  const restoreDiagnostics = setDiagnosticsEnabled('1')
  context.after(restoreDiagnostics)

  const messages = []
  const children = [new FakeChild(), new FakeChild(), new FakeChild()]
  let launchCount = 0
  const diagnostics = new CapsuleWindowDiagnostics(new FakeWindow(), {
    role: 'capsule',
    canRecover: () => true,
    launch: () => children[launchCount++],
    write: async (message) => messages.push(message)
  })
  context.after(() => diagnostics.stop())

  await sendReady(children[0])
  await sendNative(children[0])
  children[0].emit('close', 1, 'SIGTERM')
  assert.equal(launchCount, 2)

  await sendReady(children[1])
  await sendNative(children[1])
  children[1].emit('close', 1, 'SIGTERM')
  assert.equal(launchCount, 3)

  await sendReady(children[2])
  children[2].emit('close', 1, 'SIGTERM')
  assert.equal(lastPayload(messages).nativeStatus, 'unavailable')
  context.mock.timers.tick(60_000)
  assert.equal(launchCount, 3)
})

testWindows('置顶标志仍为 true 时，两次异常才恢复，失败后也遵守 30 秒冷却', async (context) => {
  const { child, messages } = setupRecovery(context)
  await sendReady(child)
  await sendNative(child, occludedSnapshot())
  assert.equal(child.requests.length, 1)
  context.mock.timers.tick(2_000)
  await sendNative(child, occludedSnapshot())
  assert.equal(JSON.parse(child.requests.at(-1)).action, 'recover')
  assert.equal(JSON.parse(child.requests.at(-1)).pid, process.pid)
  await sendNative(child, { ...occludedSnapshot(), recovery: { status: 'failed', error: 5 } })
  assert.equal(lastPayload(messages).native.recovery.error, 5)
  assert.equal(lastPayload(messages).events['recovery-result'].count, 1)
  assert.equal(lastPayload(messages).role, 'island')
  assert.ok(messages.some((message) => message.startsWith('island-window-diag ')))
  for (let index = 0; index < 14; index++) {
    context.mock.timers.tick(2_000)
    await sendNative(child, occludedSnapshot())
  }
  assert.equal(child.requests.filter((line) => JSON.parse(line).action === 'recover').length, 1)
  context.mock.timers.tick(2_000)
  await sendNative(child, occludedSnapshot())
  assert.equal(JSON.parse(child.requests.at(-1)).action, 'recover')
})

testWindows('隐藏、最小化、业务抑制、截断 Z 序和正常置顶窗口均不触发恢复', async (context) => {
  const state = { allowed: true }
  const { child, window } = setupRecovery(context, state)
  await sendReady(child)
  for (const blockedBy of [
    'hidden',
    'minimized',
    'suppressed',
    'truncated',
    'topmost',
    'mixed',
    'cleared'
  ]) {
    await sendNative(child, occludedSnapshot())
    window.visible = blockedBy !== 'hidden'
    window.minimized = blockedBy === 'minimized'
    state.allowed = blockedBy !== 'suppressed'
    // 请求已在途时改变显示意图，模拟全屏抑制/隐藏发生在原生响应之前。
    window.emit('move')
    context.mock.timers.tick(2_000)
    const native = occludedSnapshot()
    if (blockedBy === 'truncated') native.reachedCapsule = false
    if (blockedBy === 'topmost') native.normalOccluder.topmost = true
    if (blockedBy === 'mixed') native.topmostOccluder = { hwnd: '6789', topmost: true }
    if (blockedBy === 'cleared') native.normalOccluder = null
    await sendNative(child, native)
    assert.equal(child.requests.filter((line) => JSON.parse(line).action === 'recover').length, 0)
    window.visible = true
    window.minimized = false
    state.allowed = true
    context.mock.timers.tick(2_000)
  }
  assert.deepEqual(window.mutationCalls, [])
})

testWindows('恢复不依赖日志开启，关闭后仍采样且有界清理', async (context) => {
  const { child, messages, diagnostics, window } = setupRecovery(context)
  process.env.CODEX_STATUS_DIAG = '0'
  messages.length = 0
  await sendReady(child)
  await sendNative(child, occludedSnapshot())
  context.mock.timers.tick(2_000)
  await sendNative(child, occludedSnapshot())
  assert.equal(JSON.parse(child.requests.at(-1)).action, 'recover')
  await sendNative(child, { ...nativeSnapshot(), recovery: { status: 'restored' } })
  assert.equal(messages.length, 0)
  window.visible = false
  const requests = child.requests.length
  context.mock.timers.tick(2_000)
  assert.equal(child.requests.length, requests)
  diagnostics.stop()
  assert.equal(child.killCount, 1)
  assert.equal(window.eventNames().length, 0)
})

function setupRecovery(context, state = { allowed: true }) {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 })
  context.after(setDiagnosticsEnabled('1'))
  const child = new FakeChild()
  const window = new FakeWindow()
  const messages = []
  const diagnostics = new CapsuleWindowDiagnostics(window, {
    role: 'island',
    canRecover: () => state.allowed,
    launch: () => child,
    write: async (message) => messages.push(message)
  })
  context.after(() => diagnostics.stop())
  return { child, window, messages, diagnostics }
}

function occludedSnapshot() {
  return {
    ...nativeSnapshot(),
    reachedCapsule: true,
    normalOccluder: { hwnd: '9876', topmost: false }
  }
}

class FakeWindow extends EventEmitter {
  constructor() {
    super()
    this.visible = true
    this.focused = true
    this.topmost = true
    this.minimized = false
    this.destroyed = false
    this.bounds = { x: 10, y: 20, width: 300, height: 40 }
    this.mutationCalls = []
    this.handle = Buffer.alloc(8)
    this.handle.writeBigUInt64LE(0x1234n)
  }

  getNativeWindowHandle() {
    return this.handle
  }

  isDestroyed() {
    return this.destroyed
  }

  isVisible() {
    return this.visible
  }

  isFocused() {
    return this.focused
  }

  isAlwaysOnTop() {
    return this.topmost
  }

  isMinimized() {
    return this.minimized
  }

  getBounds() {
    return { ...this.bounds }
  }

  show() {
    this.mutationCalls.push('show')
  }

  focus() {
    this.mutationCalls.push('focus')
  }

  hide() {
    this.mutationCalls.push('hide')
  }

  setAlwaysOnTop() {
    this.mutationCalls.push('setAlwaysOnTop')
  }

  setBounds() {
    this.mutationCalls.push('setBounds')
  }
}

class FakeChild extends EventEmitter {
  constructor() {
    super()
    this.stdin = new PassThrough()
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
    this.requests = []
    this.killCount = 0
    this.stdin.on('data', (chunk) => this.requests.push(String(chunk)))
  }

  kill() {
    this.killCount++
    return true
  }
}

function setDiagnosticsEnabled(value) {
  const previous = process.env.CODEX_STATUS_DIAG
  process.env.CODEX_STATUS_DIAG = value
  return () => {
    if (previous === undefined) delete process.env.CODEX_STATUS_DIAG
    else process.env.CODEX_STATUS_DIAG = previous
  }
}

function nativeSnapshot(topmost = true) {
  return { capsule: { visible: true, topmost }, overlapCandidates: [] }
}

async function sendReady(child) {
  child.stdout.write('ready\n')
  await flushIo()
}

async function sendNative(child, native = nativeSnapshot()) {
  child.stdout.write(`${JSON.stringify(native)}\n`)
  await flushIo()
}

async function flushIo() {
  await new Promise((resolve) => setImmediate(resolve))
}

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function lastPayload(messages) {
  assert.ok(messages.length > 0)
  const start = messages.at(-1).indexOf('{')
  assert.notEqual(start, -1)
  return JSON.parse(messages.at(-1).slice(start))
}
