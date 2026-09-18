import { closeSync, openSync, readSync } from 'node:fs'
import {
  type IslandActivityEvent,
  type IslandRequest,
  type IslandRequestKind,
  type IslandTaskSource
} from '../../shared/island.ts'
import { classifyIslandTaskIdentity, type IslandTaskIdentity } from './codex-task-identity.ts'

const SUPPORTED_EVENTS = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
  'Interrupt'
])
const TRANSCRIPT_META_READ_BYTES = 64 * 1024

export interface CodexHookPayload {
  hook_event_name: string
  session_id: string
  turn_id?: string
  cwd?: string
  tool_name?: string
  tool_use_id?: string
  request_id?: string
  transcript_path?: string
  source?: IslandTaskSource
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
    request_id: getString(input?.request_id),
    transcript_path: getString(input?.transcript_path)
  }
}

export function readCodexTranscriptSource(
  transcriptPath: string | undefined
): IslandTaskSource | undefined {
  return readCodexTranscriptIdentity(transcriptPath)?.source
}

export function readCodexTranscriptIdentity(
  transcriptPath: string | undefined
): IslandTaskIdentity | undefined {
  if (!transcriptPath) return undefined
  let descriptor: number | undefined
  try {
    descriptor = openSync(transcriptPath, 'r')
    const buffer = Buffer.alloc(TRANSCRIPT_META_READ_BYTES)
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0)
    const firstLine = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/, 1)[0]
    const record = getRecord(JSON.parse(firstLine.replace(/^\uFEFF/, '')))
    // 首行已成功解析但没有可识别来源时，后续重读同一首行没有收益。
    if (record?.type !== 'session_meta') return classifyIslandTaskIdentity(undefined, undefined)
    const payload = getRecord(record.payload)
    return classifyIslandTaskIdentity(payload?.source, payload?.thread_source, {
      ephemeral: payload?.ephemeral
    })
  } catch {
    return undefined
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
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
    project: getProjectName(payload.cwd),
    ...(payload.source ? { source: payload.source } : {})
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
