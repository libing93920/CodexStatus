/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import test from 'node:test'
import { LanService } from '../src/main/services/lan.ts'

const FIRST = {
  peerId: '10000000-0000-4000-8000-000000000001',
  nickname: '旧配置',
  group: 'old-team',
  activityEnabled: false
}
const SECOND = {
  peerId: '10000000-0000-4000-8000-000000000002',
  nickname: '新管理员',
  group: 'new-teamGM',
  activityEnabled: true
}

function options(base) {
  return {
    ...base,
    getSnapshot: () => ({ nickname: base.nickname }),
    onPeersChange: () => undefined,
    onActivityMessage: () => undefined,
    onMessage: () => undefined,
    onReaction: () => undefined
  }
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(message)
}

test('快速切换配置时旧 loopback server 完成回调不启动新配置的重复 discovery', async (t) => {
  const service = new LanService()
  const discoveries = []
  // mock discovery，避免启动 Bonjour/mDNS；HTTP/WebSocket server 仍使用真实 loopback 监听。
  service.startDiscovery = () => discoveries.push(service.options?.peerId)
  t.after(() => service.stop())

  service.start(options(FIRST))
  service.start(options(SECOND))

  await waitFor(() => discoveries.length === 1, '新配置未完成唯一一次 discovery')
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(discoveries, [SECOND.peerId])
  const address = service.httpServer?.address?.()
  assert.equal(typeof address?.port, 'number')
  assert.equal(service.options.peerId, SECOND.peerId)

  service.stop()
  assert.equal(service.httpServer, undefined)
  assert.equal(service.options, undefined)
})

test('停止服务清理发现模块和所有等待，重复stop不会重复释放', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const service = new LanService()
  let stoppedDiscoveries = 0
  let lateCallbacks = 0
  service.discovery = {
    stop: () => {
      stoppedDiscoveries++
    }
  }
  service.options = options(FIRST)
  const pendingSocket = {}
  service.connectionTimers.set(
    pendingSocket,
    setTimeout(() => {
      lateCallbacks++
    }, 5_000)
  )
  service.helloTimers.set(
    pendingSocket,
    setTimeout(() => {
      lateCallbacks++
    }, 3_000)
  )
  service.reconnectTimers.set(
    FIRST.peerId,
    setTimeout(() => {
      lateCallbacks++
    }, 10_000)
  )

  service.stop()
  service.stop()
  t.mock.timers.tick(30_000)
  assert.equal(stoppedDiscoveries, 1)
  assert.equal(lateCallbacks, 0)
  assert.equal(service.discovery, undefined)
  assert.equal(service.connectionTimers.size, 0)
  assert.equal(service.helloTimers.size, 0)
  assert.equal(service.reconnectTimers.size, 0)
})
