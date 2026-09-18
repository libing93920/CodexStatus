import type { IslandTaskSource } from '../../shared/island.ts'

export interface IslandTaskIdentity {
  source: IslandTaskSource
  admitted: boolean
  legacyDesktopCandidate: boolean
}

export interface IslandTaskIdentityOptions {
  catalog?: boolean
  ephemeral?: unknown
  path?: unknown
}

const USER_VISIBLE_THREAD_SOURCES = new Set([
  'user',
  'agent_created_thread',
  'agent_forked_thread',
  'ambient_suggestion_task',
  'avatar_quick_chat',
  'chatgpt_handoff',
  'code_review',
  'codex_replay',
  'conversation_digest',
  'implement_todo',
  'local_environment_configuration',
  'mcp_app_follow_up',
  'onboarding_checklist',
  'security_remediation',
  'security_scan',
  'voice_chat'
])

// 已核实的内部用途优先于客户端来源，不能被 cli/vscode 标签放行。
const INTERNAL_THREAD_SOURCES = new Set([
  'memory_consolidation',
  'guardian_review',
  'guardian_classifier',
  'ambient_suggestions',
  'ambient_suggestion_safety',
  'thread_title'
])

export function normalizeIslandTaskSource(value: unknown): IslandTaskSource | undefined {
  if (value === 'cli' || value === 'vscode' || value === 'subagent' || value === 'internal')
    return value
  return typeof value === 'string' ? 'unknown' : undefined
}

export function classifyIslandTaskIdentity(
  rawSource: unknown,
  rawThreadSource: unknown,
  options: IslandTaskIdentityOptions = {}
): IslandTaskIdentity {
  if (isSubagentIdentity(rawSource, rawThreadSource)) {
    return { source: 'subagent', admitted: false, legacyDesktopCandidate: false }
  }
  if (
    getRecord(rawSource)?.internal !== undefined ||
    rawSource === 'internal' ||
    (typeof rawThreadSource === 'string' && INTERNAL_THREAD_SOURCES.has(rawThreadSource))
  ) {
    return { source: 'internal', admitted: false, legacyDesktopCandidate: false }
  }
  const source = normalizeIslandTaskSource(rawSource)
  if (source === 'cli') return classifyCliIdentity(rawThreadSource)
  if (source === 'vscode') return classifyDesktopIdentity(rawThreadSource, options)
  return { source: 'unknown', admitted: false, legacyDesktopCandidate: false }
}

export function isAdmittedIslandTaskSource(
  source: IslandTaskSource | undefined
): source is 'cli' | 'vscode' {
  return source === 'cli' || source === 'vscode'
}

function classifyCliIdentity(rawThreadSource: unknown): IslandTaskIdentity {
  const threadSource = normalizeThreadSource(rawThreadSource)
  const hasExplicitThreadSource = rawThreadSource !== undefined && rawThreadSource !== null
  return {
    source: !hasExplicitThreadSource || isUserVisibleThreadSource(threadSource) ? 'cli' : 'unknown',
    admitted: !hasExplicitThreadSource || isUserVisibleThreadSource(threadSource),
    legacyDesktopCandidate: false
  }
}

function classifyDesktopIdentity(
  rawThreadSource: unknown,
  options: IslandTaskIdentityOptions
): IslandTaskIdentity {
  const threadSource = normalizeThreadSource(rawThreadSource)
  const missingThreadSource = rawThreadSource === undefined || rawThreadSource === null
  const legacyDesktopCandidate = missingThreadSource && options.ephemeral !== true
  const admitted =
    isUserVisibleThreadSource(threadSource) || isHistoricalDesktopIdentity(rawThreadSource, options)
  return { source: admitted ? 'vscode' : 'unknown', admitted, legacyDesktopCandidate }
}

function isHistoricalDesktopIdentity(
  rawThreadSource: unknown,
  options: IslandTaskIdentityOptions
): boolean {
  return (
    options.catalog === true &&
    (rawThreadSource === undefined || rawThreadSource === null) &&
    options.ephemeral === false &&
    typeof options.path === 'string' &&
    options.path.trim().length > 0
  )
}

function isUserVisibleThreadSource(value: string | undefined): boolean {
  return value !== undefined && USER_VISIBLE_THREAD_SOURCES.has(value)
}

function normalizeThreadSource(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function isSubagentIdentity(rawSource: unknown, rawThreadSource: unknown): boolean {
  return isSubagentValue(rawSource) || isSubagentValue(rawThreadSource)
}

function isSubagentValue(value: unknown): boolean {
  if (value === 'subagent') return true
  const record = getRecord(value)
  if (!record) return false
  return 'subagent' in record || 'subAgent' in record
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
