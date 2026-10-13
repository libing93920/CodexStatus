export type TeamRole = 'member' | 'admin'

const ADMIN_SUFFIX = 'GM'
const PEER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface TeamIdentity {
  group: string
  role: TeamRole
  valid: boolean
}

/** GM 只约定界面角色，不提供防冒充的身份认证。 */
export function parseTeamIdentity(value: unknown): TeamIdentity {
  const text = typeof value === 'string' ? value.trim() : ''
  const role: TeamRole = text.endsWith(ADMIN_SUFFIX) ? 'admin' : 'member'
  const group = role === 'admin' ? text.slice(0, -ADMIN_SUFFIX.length).trim() : text
  return { group, role, valid: text.length === 0 || group.length > 0 }
}

export function isPeerId(value: unknown): value is string {
  return typeof value === 'string' && PEER_ID_PATTERN.test(value)
}
