import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import type {
  CleanerItem,
  CleanerProgress,
  CleanerScanResult,
  CleanerSettings,
  CleanerSource
} from '../../../shared/session-cleaner.ts'
import type { ManagedSession } from '../../../shared/session-manager.ts'
import { SessionCoreClient } from './core-client.ts'
import { measureManagedSpace } from './managed-space.ts'
import { makeItemId } from './scan-items.ts'
import { scanSources } from './scanner.ts'
import { buildResumeTarget } from './resume-target.ts'

const DAY_MS = 86_400_000
const MANAGED_PROVIDERS = new Set([
  'codex',
  'claude',
  'opencode',
  'pi',
  'gemini',
  'openclaw',
  'hermes',
  'grokbuild',
  'omp',
  'mcode',
  'kimi',
  'agy'
])

export function coreSource(source: CleanerSource): Record<string, unknown> {
  return {
    id: source.id,
    kind: source.kind,
    path: source.path,
    databasePath: source.databasePath,
    configPath: source.configPath,
    layout: source.layout,
    home: os.homedir(),
    env: Object.fromEntries(
      ['CODEX_SQLITE_HOME'].flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : []))
    )
  }
}

export function sessionFilePath(session: ManagedSession): string {
  if (session.storagePath) return session.storagePath
  if (!session.sourcePath.startsWith('sqlite:')) return session.sourcePath
  const suffix = `${session.providerId === 'hermes' ? '#' : ':'}${session.sessionId}`
  if (
    !session.sourcePath.endsWith(suffix) ||
    session.sourcePath.length <= 'sqlite:'.length + suffix.length
  )
    throw new Error('数据库会话引用无效')
  return session.sourcePath.slice('sqlite:'.length, -suffix.length)
}

export async function scanManagedSources(options: {
  core: SessionCoreClient
  sources: CleanerSource[]
  settings: CleanerSettings
  protectedIds: string[]
  signal: AbortSignal
  onProgress: (progress: CleanerProgress) => void
}): Promise<CleanerScanResult> {
  const managedSources = options.sources.filter((source) => MANAGED_PROVIDERS.has(source.kind))
  const sessions: ManagedSession[] = []
  const issues: CleanerScanResult['issues'] = []
  for (const source of managedSources) {
    if (options.signal.aborted) break
    if (source.unavailable) {
      issues.push({ path: source.path, message: source.note })
      continue
    }
    try {
      const found = await options.core.request<{
        sessions: ManagedSession[]
        issues: CleanerScanResult['issues']
      }>('scan', {
        source: coreSource(source)
      })
      sessions.push(...found.sessions)
      for (const session of found.sessions) {
        if (!session.capabilities.resume) continue
        try {
          buildResumeTarget({ session, source })
        } catch {
          session.capabilities.resume = false
        }
      }
      issues.push(...found.issues)
      options.onProgress({ visited: sessions.length, bytes: 0, phase: 'scan' })
    } catch (error) {
      if (!options.signal.aborted) issues.push({ path: source.path, message: errorText(error) })
    }
  }
  const measured = await measureManagedSpace({
    sources: managedSources,
    sessions,
    signal: options.signal,
    onProgress: options.onProgress
  })
  const items = measured.sessions.map((session) => sessionItem(session, options.settings))
  const resourceOwners = new Map(
    items.flatMap((item) => item.managed!.resourceIds.map((id) => [id, item] as const))
  )
  const sourceIndex = new Map(options.sources.map((source) => [source.id, source]))
  for (const resource of measured.resources) {
    const owner = resource.shared ? undefined : resourceOwners.get(resource.id)
    if (owner) {
      owner.bytes += resource.bytes
      owner.files.push(resource.path)
      continue
    }
    items.push({
      id: `resource:${resource.id}`,
      sourceId: resource.sourceId,
      path: resource.path,
      title: path.basename(resource.path),
      bytes: resource.bytes,
      modifiedAt: 0,
      category: resource.kind === 'log' ? 'logs' : 'resources',
      status: 'read-only',
      reason: resource.shared
        ? '共享资源；仅由会话删除计划核验引用后处理'
        : '来源资源占用，非独立会话',
      files: [resource.path],
      fingerprint: resource.id
    })
  }
  const legacy = await scanSources({
    sources: options.sources.filter((source) => !MANAGED_PROVIDERS.has(source.kind)),
    settings: options.settings,
    protectedIds: options.protectedIds,
    signal: options.signal
  })
  const protectedIds = new Set(options.protectedIds)
  for (const item of items) {
    if (protectedIds.has(item.id) || (item.sessionId && protectedIds.has(item.sessionId))) {
      item.status = 'protected'
      item.reason = '用户已保护'
    }
    if (!sourceIndex.has(item.sourceId)) throw new Error('会话核心返回未知来源')
  }
  return {
    items: [...items, ...legacy.items].sort((a, b) => b.modifiedAt - a.modifiedAt),
    issues: [...issues, ...measured.issues, ...legacy.issues],
    cancelled: options.signal.aborted,
    scannedAt: Date.now(),
    resources: measured.resources,
    storage: measured.storage
  }
}

function sessionItem(session: ManagedSession, settings: CleanerSettings): CleanerItem {
  const filePath = sessionFilePath(session)
  const ageDays = (Date.now() - (session.lastActiveAt ?? 0)) / DAY_MS
  return {
    id: createHash('sha256')
      .update(session.sourceId)
      .update('\0')
      .update(makeItemId(session.sourcePath, session.sessionId))
      .digest('hex')
      .slice(0, 32),
    sourceId: session.sourceId,
    sessionId: session.sessionId,
    title: session.title || session.summary || '未命名会话',
    summary: session.summary,
    project: session.projectDir,
    path: filePath,
    createdAt: session.createdAt,
    modifiedAt: session.lastActiveAt ?? session.createdAt ?? 0,
    bytes: 0,
    category: 'sessions',
    status: session.capabilities.delete ? 'candidate' : 'read-only',
    reason: session.capabilities.delete
      ? '来源支持删除；时间条件仅作为清理建议'
      : session.capabilities.deleteReason || '请在原工具中管理此会话',
    files: [],
    fingerprint: session.revision,
    managed: session,
    recommendation:
      ageDays >= settings.olderSessionDays
        ? 'old'
        : ageDays < settings.keepRecentDays
          ? 'recent'
          : 'normal'
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
