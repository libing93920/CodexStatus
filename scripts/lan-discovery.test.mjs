/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import {
  LanDiscovery,
  LAN_DISCOVERY_REFRESH_MS,
  getLanInterfaces
} from '../src/main/services/lan-discovery.ts'

const SELF = '10000000-0000-4000-8000-000000000001'
const PEER = '10000000-0000-4000-8000-000000000002'
const GROUP_HASH = 'test-group'
const PHYSICAL = '10.80.10.75'
const VIRTUAL = '169.254.88.69'
const PEER_ADDRESS = '10.80.30.21'

function networks(...addresses) {
  return Object.fromEntries(
    addresses.map((address, index) => [
      `接口${index}`,
      [{ address, family: 'IPv4', internal: false }]
    ])
  )
}

class FakeBonjour {
  constructor(binding, onError) {
    this.binding = binding
    this.onError = onError
    this.server = { mdns: new EventEmitter() }
    this.browsers = []
    this.publications = []
    this.unpublishCount = 0
    this.destroyCount = 0
  }
  publish(options) {
    this.publications.push(options)
    return {}
  }
  find() {
    const browser = new EventEmitter()
    browser.stopCount = 0
    browser.stop = () => {
      browser.stopCount++
    }
    this.browsers.push(browser)
    return browser
  }
  unpublishAll(callback) {
    this.unpublishCount++
    callback?.()
  }
  destroy() {
    this.destroyCount++
  }
  get browser() {
    return this.browsers.at(-1)
  }
}

function advertisement(overrides = {}) {
  return {
    name: PEER,
    txt: { peerId: PEER, nick: '测试成员', groupHash: GROUP_HASH },
    addresses: [PEER_ADDRESS],
    port: 53000,
    referer: { address: PEER_ADDRESS },
    ...overrides
  }
}

function setup(t) {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  let currentNetworks = networks(PHYSICAL, VIRTUAL)
  const clients = []
  const up = []
  const down = []
  const discovery = new LanDiscovery(
    {
      peerId: SELF,
      nickname: '本机',
      groupHash: GROUP_HASH,
      port: 54000,
      onUp: (service) => up.push(structuredClone(service)),
      onDown: (service) => down.push(service.name)
    },
    {
      networkInterfaces: () => currentNetworks,
      createBonjour: (binding, onError) => {
        const client = new FakeBonjour(binding, onError)
        clients.push(client)
        return client
      }
    }
  )
  t.after(() => discovery.stop())
  discovery.start()
  return {
    discovery,
    clients,
    up,
    down,
    setNetworks: (value) => {
      currentNetworks = value
    }
  }
}

test('枚举外部有效IPv4，不依赖虚拟标记，不重复地址', () => {
  const input = {
    ...networks(PHYSICAL, VIRTUAL, PHYSICAL),
    invalid: [
      { address: '127.0.0.1', family: 'IPv4', internal: false },
      { address: '0.0.0.0', family: 'IPv4', internal: false },
      { address: '224.0.0.251', family: 'IPv4', internal: false },
      { address: '255.255.255.255', family: 'IPv4', internal: false },
      { address: 'not-an-ip', family: 'IPv4', internal: false },
      { address: 'fe80::1', family: 'IPv6', internal: false },
      { address: '10.80.10.99', family: 'IPv4', internal: true }
    ]
  }
  assert.deepEqual(
    getLanInterfaces(input).map(({ address }) => address),
    [PHYSICAL, VIRTUAL]
  )
})

test('物理与KM-TEST各自明确发送，接收共享绑定，不使用默认出口', (t) => {
  const { clients } = setup(t)
  assert.equal(clients.length, 2)
  assert.deepEqual(
    clients.map(({ binding }) => binding.interface),
    [PHYSICAL, VIRTUAL]
  )
  for (const client of clients) {
    assert.equal(client.binding.bind, '0.0.0.0')
    assert.equal(client.binding.reuseAddr, true)
    assert.equal(client.publications[0].name, SELF)
    assert.equal(client.publications[0].port, 54000)
    assert.equal(client.publications[0].probe, false)
    assert.equal(client.browsers.length, 1)
  }
})

test('同一成员从多个接口出现只登记一次，一个来源down不误删另一来源', (t) => {
  const { clients, up, down } = setup(t)
  for (const client of clients) client.browser.emit('up', advertisement())
  assert.equal(up.length, 1)
  clients[0].browser.emit('down', advertisement())
  assert.deepEqual(down, [])
  clients[1].browser.emit('down', advertisement())
  assert.deepEqual(down, [PEER])
})

test('移除接口只释放该实例，剩余来源保持在线，新增接口独立发布', (t) => {
  const { clients, up, down, setNetworks } = setup(t)
  for (const client of clients) client.browser.emit('up', advertisement())
  setNetworks(networks(PHYSICAL))
  t.mock.timers.tick(LAN_DISCOVERY_REFRESH_MS)
  assert.equal(clients[1].destroyCount, 1)
  assert.equal(clients[0].destroyCount, 0)
  assert.deepEqual(down, [])
  assert.equal(up.length, 1)
  setNetworks(networks(PHYSICAL, '192.168.20.10'))
  t.mock.timers.tick(LAN_DISCOVERY_REFRESH_MS)
  assert.equal(clients.length, 3)
  assert.equal(clients[2].binding.interface, '192.168.20.10')
  assert.equal(clients[0].publications.length, 1)
})

test('周期换browser以重新获取IP和端口，不重复创建socket或让旧事件生效', (t) => {
  const { clients, up, down } = setup(t)
  const client = clients[0]
  const oldBrowser = client.browser
  oldBrowser.emit('up', advertisement())
  t.mock.timers.tick(LAN_DISCOVERY_REFRESH_MS)
  assert.equal(oldBrowser.stopCount, 1)
  assert.equal(client.browsers.length, 2)
  assert.equal(clients.length, 2)
  assert.equal(client.publications.length, 1)
  assert.deepEqual(down, [])
  oldBrowser.emit('up', advertisement({ port: 1 }))
  oldBrowser.emit('down', advertisement())
  assert.equal(up.length, 1)
  assert.deepEqual(down, [])
  client.browser.emit(
    'up',
    advertisement({
      addresses: ['10.80.40.21'],
      port: 53001,
      referer: { address: '10.80.40.21' }
    })
  )
  assert.equal(up.at(-1).port, 53001)
  assert.deepEqual(up.at(-1).addresses, ['10.80.40.21'])
  client.browser.emit('srv-update', advertisement({ port: 53002 }), advertisement())
  assert.equal(up.at(-1).port, 53002)
})

test('自己、异组和不完整公告不登记，修改组后撤销该来源', (t) => {
  const { clients, up, down } = setup(t)
  const browser = clients[0].browser
  browser.emit(
    'up',
    advertisement({ name: SELF, txt: { peerId: SELF, nick: '我', groupHash: GROUP_HASH } })
  )
  browser.emit('up', advertisement({ txt: { peerId: PEER, nick: '错组', groupHash: 'other' } }))
  browser.emit('up', advertisement({ txt: { peerId: PEER, groupHash: GROUP_HASH } }))
  browser.emit('up', advertisement({ port: 0 }))
  assert.deepEqual(up, [])
  browser.emit('up', advertisement())
  browser.emit(
    'txt-update',
    advertisement({ txt: { peerId: PEER, nick: '错组', groupHash: 'other' } })
  )
  assert.deepEqual(down, [PEER])
})

test('单接口失败不影响其他接口，下一周期重新创建失败接口', (t) => {
  const { clients } = setup(t)
  clients[1].onError(Object.assign(new Error('bind failed'), { code: 'EADDRINUSE' }))
  assert.equal(clients[1].destroyCount, 1)
  assert.equal(clients[0].destroyCount, 0)
  t.mock.timers.tick(LAN_DISCOVERY_REFRESH_MS)
  assert.equal(clients.length, 3)
  assert.equal(clients[2].binding.interface, VIRTUAL)
})

test('反复start/stop释放所有browser、公告和UDP实例，不留下周期回调', (t) => {
  const { discovery, clients, up } = setup(t)
  discovery.start()
  assert.equal(clients.length, 2)
  const oldBrowsers = clients.map(({ browser }) => browser)
  discovery.stop()
  discovery.stop()
  for (const client of clients) {
    assert.equal(client.unpublishCount, 1)
    assert.equal(client.destroyCount, 1)
  }
  for (const browser of oldBrowsers) browser.emit('up', advertisement())
  t.mock.timers.tick(LAN_DISCOVERY_REFRESH_MS * 3)
  assert.equal(clients.length, 2)
  assert.deepEqual(up, [])
  discovery.start()
  assert.equal(clients.length, 4)
})

test('旧接口迟到错误不会移除重建后的新实例', (t) => {
  const { clients, setNetworks } = setup(t)
  const oldClient = clients[1]
  setNetworks(networks(PHYSICAL))
  t.mock.timers.tick(LAN_DISCOVERY_REFRESH_MS)
  setNetworks(networks(PHYSICAL, VIRTUAL))
  t.mock.timers.tick(LAN_DISCOVERY_REFRESH_MS)
  const replacement = clients[2]
  oldClient.onError(new Error('late error'))
  assert.equal(replacement.destroyCount, 0)
  assert.equal(clients[0].destroyCount, 0)
})
