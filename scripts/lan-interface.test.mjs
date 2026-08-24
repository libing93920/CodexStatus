// lan.ts 接口选择回归测试:防止虚拟网卡排除逻辑被破坏导致团队发现失效
// 运行:node --experimental-strip-types --test scripts/lan-interface.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { isVirtualSegment, getLocalIpv4s, getPreferredInterface } from '../src/main/services/lan.ts'

test('isVirtualSegment: WSL/Hyper-V/Docker 默认段(172.16-31.x)应判为虚拟', () => {
  assert.equal(isVirtualSegment('172.31.176.1'), true) // WSL 实际案例
  assert.equal(isVirtualSegment('172.17.0.1'), true) // Docker 默认网桥
  assert.equal(isVirtualSegment('172.20.0.5'), true)
})

test('isVirtualSegment: 172.16 段边界(15 不可达误判,16 起才算)', () => {
  assert.equal(isVirtualSegment('172.15.255.255'), false)
  assert.equal(isVirtualSegment('172.16.0.0'), true)
  assert.equal(isVirtualSegment('172.32.0.1'), false) // 32 已超出 /12
})

test('isVirtualSegment: VirtualBox/VMware 常用段(192.168.56-100.x)', () => {
  assert.equal(isVirtualSegment('192.168.56.1'), true)
  assert.equal(isVirtualSegment('192.168.99.100'), true)
  assert.equal(isVirtualSegment('192.168.55.1'), false) // 边界外不算虚拟
  assert.equal(isVirtualSegment('192.168.101.1'), false)
})

test('isVirtualSegment: NAT/链路本地/CGNAT', () => {
  assert.equal(isVirtualSegment('10.0.2.15'), true) // VirtualBox NAT
  assert.equal(isVirtualSegment('169.254.88.69'), true) // 链路本地(mDNS 广播里真实出现过)
  assert.equal(isVirtualSegment('100.64.0.1'), true) // CGNAT(Tailscale 等)
})

test('isVirtualSegment: 真实局域网地址不应误判为虚拟', () => {
  assert.equal(isVirtualSegment('10.80.30.38'), false) // 用户实际网络
  assert.equal(isVirtualSegment('10.80.10.75'), false)
  assert.equal(isVirtualSegment('10.80.40.183'), false)
  assert.equal(isVirtualSegment('192.168.1.100'), false) // 家用路由常见段
  assert.equal(isVirtualSegment('192.168.0.1'), false)
})

test('isVirtualSegment: 非法输入不抛错', () => {
  assert.equal(isVirtualSegment('not-an-ip'), false)
  assert.equal(isVirtualSegment(''), false)
})

test('getLocalIpv4s: 本机结果不得包含任何虚拟网卡段地址', () => {
  const ips = getLocalIpv4s()
  for (const ip of ips) {
    assert.equal(
      isVirtualSegment(ip),
      false,
      `getLocalIpv4s 泄漏了虚拟网卡地址: ${ip}`
    )
  }
})

test('getPreferredInterface: 必须返回非虚拟网卡地址(多播发送出口)', () => {
  const preferred = getPreferredInterface()
  // 无真实网卡的机器(纯离线)允许 undefined,但一旦有返回值必须是真实网卡
  if (preferred !== undefined) {
    assert.equal(isVirtualSegment(preferred), false, `首选接口选中了虚拟网卡: ${preferred}`)
    assert.notEqual(preferred.startsWith('127.'), true)
  }
})
