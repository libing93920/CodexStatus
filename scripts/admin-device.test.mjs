/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import test from 'node:test'
import { isAdminDevice, isTeamAdmin } from '../src/main/services/admin-device.ts'

const AUTHORIZED_MACS = ['20:88:10:68:fb:0a', '20-88-10-68-fb-0a', '20:88:10:68:FB:0A']

function interfaceInfo(mac, internal = false) {
  return {
    address: '192.0.2.10',
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac,
    internal,
    cidr: '192.0.2.10/24'
  }
}

function interfaces(name, entries) {
  return { [name]: entries }
}

test('只接受固定授权MAC的归一化指纹，拒绝虚拟卡、空接口和读取异常', () => {
  for (const mac of AUTHORIZED_MACS)
    assert.equal(
      isAdminDevice(() => interfaces('Ethernet', [interfaceInfo(mac)])),
      true
    )

  assert.equal(
    isAdminDevice(() => interfaces('KM-TEST Loopback', [interfaceInfo('02:00:4c:4f:4f:50')])),
    false
  )
  assert.equal(
    isAdminDevice(() => interfaces('vEthernet (WSL)', [interfaceInfo('02:00:4c:4f:4f:50')])),
    false
  )
  assert.equal(
    isAdminDevice(() => ({})),
    false
  )
  assert.equal(
    isAdminDevice(() => {
      throw new Error('fixture read failure')
    }),
    false
  )

  for (const mac of ['', 'not-a-mac', '20:88:10:68:fb', '20:88:10:68:fb:zz'])
    assert.equal(
      isAdminDevice(() => interfaces('Ethernet', [interfaceInfo(mac)])),
      false
    )

  assert.equal(
    isAdminDevice(() => interfaces('Ethernet', [interfaceInfo('20:88:10:68:fb:0a', true)])),
    false
  )
})

test('团队管理员要求有效的非空大写GM口令和严格为true的设备许可', () => {
  assert.equal(isTeamAdmin('9527GM', true), true)
  assert.equal(isTeamAdmin(' 9527GM ', true), true)
  assert.equal(isTeamAdmin('9527GM', false), false)
  assert.equal(isTeamAdmin('9527GM', 'true'), false)
  for (const group of [undefined, '', 'GM', '9527', '9527gm', '9527GMx'])
    assert.equal(isTeamAdmin(group, true), false)
})
