import { lstat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import path from 'node:path'
import type {
  CleanerItem,
  CleanerProgress,
  CleanerSource
} from '../../../shared/session-cleaner.ts'
import type { CatalogResult, CatalogSession } from './catalog-types.ts'
import { checkAbort, collectFiles, errorText } from './catalog-io.ts'
import { scanCodexCatalog } from './catalog-codex.ts'
import { scanClaudeCatalog } from './catalog-claude.ts'
import { scanOpenCodeCatalog } from './catalog-opencode.ts'
import { scanGeminiCatalog } from './catalog-gemini.ts'
import { scanPiCatalog } from './catalog-pi.ts'
import { scanExtraCatalog } from './catalog-extra.ts'
import {
  createFileItem,
  makeItemId,
  metadataOnlyItem,
  normalizePath,
  type ScanItemContext
} from './scan-items.ts'
import { MAX_CANDIDATE_BYTES, scanFile } from './scan-files.ts'

const DAY_MS = 86_400_000
const CORE_KINDS = new Set(['codex', 'claude', 'opencode', 'pi', 'gemini'])
const EXTRA_KINDS = new Set(['openclaw', 'hermes', 'grokbuild', 'omp', 'mcode', 'kimi', 'agy'])
const PRIVATE_DIRECTORIES = new Set([
  '.ssh',
  '.aws',
  '.azure',
  '.gnupg',
  'credentials',
  'secrets',
  'tokens',
  'auth'
])
const PRIVATE_FILES = new Set([
  'auth',
  'credentials',
  'auth.json',
  'auth.jsonl',
  'credentials.json',
  'credentials.jsonl',
  'secrets.json',
  'tokens.json',
  'config.json',
  'settings.json',
  'cline_mcp_settings.json',
  '.npmrc',
  '.netrc'
])

export interface CatalogScanContext extends ScanItemContext {
  signal?: AbortSignal
  onProgress?: (progress: CleanerProgress) => void
  seenPaths: Set<string>
  seenFileIdentities: Set<string>
  seenCatalogSessions: Set<string>
  visited: number
  bytes: number
}

export function isCatalogSource(source: CleanerSource): boolean {
  return CORE_KINDS.has(source.kind) || EXTRA_KINDS.has(source.kind)
}

export async function scanCatalogSource(
  source: CleanerSource,
  context: CatalogScanContext
): Promise<void> {
  if (source.unavailable) {
    context.issues.push({ path: source.path, message: source.note })
    return
  }
  const sourceInfo = await lstat(source.path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  if (sourceInfo?.isSymbolicLink()) {
    context.issues.push({ path: source.path, message: '来源是链接或 junction，未跟随' })
    return
  }
  const catalog = await scanCatalog(source, context.signal)
  context.issues.push(...catalog.issues)
  const inventoryRoot =
    source.kind === 'opencode' && sourceInfo?.isFile() ? path.dirname(source.path) : source.path
  const files = await collectFiles({
    root: inventoryRoot,
    issues: context.issues,
    signal: context.signal,
    accept: (file) => !isPrivatePath(file)
  })
  const filePaths = new Set(files.map(normalizePath))
  for (const session of catalog.sessions) {
    const normalized = normalizePath(session.path)
    if (filePaths.has(normalized) || isPrivatePath(session.path)) continue
    filePaths.add(normalized)
    files.push(session.path)
  }
  const occupied = new Set<string>()
  for (const session of catalog.sessions) {
    checkAbort(context.signal)
    const key =
      source.kind === 'agy'
        ? `agy\0${session.sessionId}`
        : `${source.kind}\0${normalizePath(session.path)}\0${session.sessionId}`
    if (context.seenCatalogSessions.has(key)) continue
    context.seenCatalogSessions.add(key)
    try {
      const info = await lstat(session.path)
      if (!info.isFile() || info.isSymbolicLink()) continue
      const database = /\.(db|sqlite|sqlite3)$/i.test(session.path)
      const bytes = database ? 0 : claimFile(session.path, info, context)
      if (!database) occupied.add(normalizePath(session.path))
      const item = await sessionItem({ source, session, info, context })
      context.items.push({ ...item, bytes })
      report(context)
    } catch (error) {
      checkAbort(context.signal)
      context.issues.push({ path: session.path, message: errorText(error) })
    }
  }
  for (const file of files) {
    checkAbort(context.signal)
    if (occupied.has(normalizePath(file))) continue
    try {
      const info = await lstat(file)
      if (context.seenPaths.has(normalizePath(file))) continue
      const bytes = claimFile(file, info, context)
      if (!bytes && info.size) continue
      const item = metadataOnlyItem({
        source,
        filePath: file,
        info,
        category: resourceCategory(file),
        context
      })
      context.items.push({ ...item, bytes })
      report(context)
    } catch (error) {
      checkAbort(context.signal)
      context.issues.push({ path: file, message: errorText(error) })
    }
  }
}

async function scanCatalog(source: CleanerSource, signal?: AbortSignal): Promise<CatalogResult> {
  switch (source.kind) {
    case 'codex':
      return scanCodexCatalog(source, signal)
    case 'claude':
      return scanClaudeCatalog(source, signal)
    case 'opencode':
      return scanOpenCodeCatalog(source, signal)
    case 'gemini':
      return scanGeminiCatalog(source, signal)
    case 'pi':
      return scanPiCatalog(source, signal)
    default:
      return scanExtraCatalog(source, signal)
  }
}

async function sessionItem(options: {
  source: CleanerSource
  session: CatalogSession
  info: Stats
  context: CatalogScanContext
}): Promise<CleanerItem> {
  const { source, session, info, context } = options
  const database = /\.(db|sqlite|sqlite3)$/i.test(session.path)
  const id = makeItemId(session.path, database ? session.sessionId : undefined)
  const modifiedAt = session.modifiedAt ?? session.createdAt ?? 0
  let item: CleanerItem = {
    id,
    sourceId: source.id,
    title: session.title || '未命名会话',
    path: session.path,
    project: session.project,
    sessionId: session.sessionId,
    summary: session.summary,
    createdAt: session.createdAt,
    bytes: info.size,
    modifiedAt,
    category: 'sessions',
    status: 'read-only',
    reason: '会话检索已接入；此来源或格式保持只读',
    files: [session.path],
    fingerprint: `readonly-stat:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`
  }
  const supportsRetention = ['claude', 'pi', 'opencode'].includes(source.kind)
  const activityTime = database ? modifiedAt : Math.max(info.mtimeMs, modifiedAt)
  const recent =
    supportsRetention && Date.now() - activityTime < context.settings.keepRecentDays * DAY_MS
  if (
    (source.kind === 'claude' || source.kind === 'pi') &&
    !recent &&
    info.size <= MAX_CANDIDATE_BYTES
  ) {
    try {
      const scanned = await scanFile({
        filePath: session.path,
        kind: source.kind,
        signal: context.signal,
        onBytes: () => undefined
      })
      if (scanned.formatIssue)
        context.issues.push({ path: session.path, message: scanned.formatIssue })
      const verified = await createFileItem({
        source,
        filePath: session.path,
        scanned,
        metadata: session,
        category: 'sessions',
        context
      })
      item = {
        ...item,
        status: verified.status,
        reason: verified.reason,
        fingerprint: verified.fingerprint
      }
    } catch (error) {
      checkAbort(context.signal)
      context.issues.push({ path: session.path, message: errorText(error) })
    }
  }
  if (context.protectedIds.has(id) || context.protectedIds.has(session.sessionId))
    return { ...item, status: 'protected', reason: '已标记保护' }
  return recent ? { ...item, status: 'recent', reason: '会话或源文件仍在近期保留范围内' } : item
}

function claimFile(file: string, info: Stats, context: CatalogScanContext): number {
  const normalized = normalizePath(file)
  if (context.seenPaths.has(normalized)) return 0
  context.seenPaths.add(normalized)
  const identity = `${info.dev}:${info.ino}`
  if (info.ino && context.seenFileIdentities.has(identity)) {
    context.issues.push({ path: file, message: '相同文件或硬链接已计入其他条目，未重复计算空间' })
    return 0
  }
  if (info.ino) context.seenFileIdentities.add(identity)
  context.visited++
  context.bytes += info.size
  return info.size
}

function isPrivatePath(file: string): boolean {
  if (file.split(/[\\/]/).some((part) => PRIVATE_DIRECTORIES.has(part.toLowerCase()))) return true
  const name = path.basename(file).toLowerCase()
  return (
    PRIVATE_FILES.has(name) ||
    name.startsWith('.env') ||
    /\.(pem|p12|pfx|key|keystore|jks)$/i.test(name) ||
    /(^|[._-])(auth|credentials?|secrets?|tokens?|api[-_]?keys?)([._-]|$)/i.test(name)
  )
}

function resourceCategory(file: string): CleanerItem['category'] {
  return /[\\/]logs?[\\/].*\.log$/i.test(file) ? 'logs' : 'resources'
}

function report(context: CatalogScanContext): void {
  try {
    context.onProgress?.({ visited: context.visited, bytes: context.bytes })
  } catch {
    /* 消费方异常不能中断扫描。 */
  }
}
