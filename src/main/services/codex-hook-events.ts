import type { IslandActivityEvent, IslandRequest, IslandRequestKind } from '../../shared/island'

const SUPPORTED_EVENTS = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
  'Interrupt'
])

export interface CodexHookPayload {
  hook_event_name: string
  session_id: string
  turn_id?: string
  cwd?: string
  tool_name?: string
  tool_use_id?: string
  request_id?: string
}

export function parseCodexHookPayload(value: unknown): CodexHookPayload | undefined {
  const input = getRecord(value)
  const eventName = getString(input?.hook_event_name)
  const sessionId = getString(input?.session_id)
  if (!eventName || !sessionId || !SUPPORTED_EVENTS.has(eventName)) return undefined
  return {
    hook_event_name: eventName,
    session_id: sessionId,
    turn_id: getString(input?.turn_id),
    cwd: getString(input?.cwd),
    tool_name: getString(input?.tool_name),
    tool_use_id: getString(input?.tool_use_id),
    request_id: getString(input?.request_id)
  }
}

export function mapCodexHookEvent(
  payload: CodexHookPayload,
  receivedAt = Date.now()
): IslandActivityEvent | undefined {
  const turnId = payload.turn_id ?? `session:${payload.session_id}`
  const base = {
    eventId: createEventId(payload, receivedAt),
    hostId: 'local',
    threadId: payload.session_id,
    turnId,
    occurredAt: receivedAt,
    project: getProjectName(payload.cwd)
  }
  switch (payload.hook_event_name) {
    case 'UserPromptSubmit':
      return { ...base, kind: 'turn-started' }
    case 'PreToolUse':
      return payload.tool_use_id
        ? { ...base, kind: 'request-resolved', requestId: payload.tool_use_id }
        : { ...base, kind: 'activity' }
    case 'PostToolUse':
      return { ...base, kind: 'activity' }
    case 'PermissionRequest': {
      const requestId = payload.request_id ?? payload.tool_use_id ?? base.eventId
      return {
        ...base,
        kind: 'request-opened',
        request: createRequest(requestId, 'approval', payload.tool_name, receivedAt)
      }
    }
    case 'Stop':
      return { ...base, kind: 'turn-finished', outcome: 'completed' }
    case 'Interrupt':
      return { ...base, kind: 'turn-finished', outcome: 'stopped' }
    default:
      return undefined
  }
}

function createRequest(
  id: string,
  kind: IslandRequestKind,
  toolName: string | undefined,
  createdAt: number
): IslandRequest {
  return { id, kind, summary: toolName ? `${toolName} 请求权限` : '请求权限', createdAt }
}

function createEventId(payload: CodexHookPayload, receivedAt: number): string {
  const uniqueId = payload.request_id ?? payload.tool_use_id ?? String(receivedAt)
  return [payload.hook_event_name, payload.session_id, payload.turn_id ?? '', uniqueId].join(':')
}

function getProjectName(cwd: string | undefined): string | undefined {
  return cwd
    ?.replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop()
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
