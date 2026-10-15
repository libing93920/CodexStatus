import { createHash } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { parseTeamIdentity } from '../../shared/team-role.ts'

// 固定授权网卡指纹，不能在任意机器首次启动时自动登记。
const ADMIN_MAC_SHA256 = '8033d4b7c612427d8485ec57791f63d7626c0dcf970f5a361204ef6e06c1d9d3'

export function isAdminDevice(readInterfaces = networkInterfaces): boolean {
  try {
    return Object.values(readInterfaces()).some((addresses) =>
      addresses?.some((address) => address.internal === false && matchesAdminMac(address.mac))
    )
  } catch {
    return false
  }
}

export function isTeamAdmin(group: unknown, deviceAllowed = isAdminDevice()): boolean {
  const identity = parseTeamIdentity(group)
  return identity.valid && !!identity.group && identity.role === 'admin' && deviceAllowed === true
}

function matchesAdminMac(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const mac = value.replace(/[:-]/g, '').toLowerCase()
  if (!/^[0-9a-f]{12}$/.test(mac)) return false
  return createHash('sha256').update(mac).digest('hex') === ADMIN_MAC_SHA256
}
