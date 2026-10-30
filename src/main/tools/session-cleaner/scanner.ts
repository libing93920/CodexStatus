import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'
import type {
  CleanerItem,
  CleanerProgress,
  CleanerScanResult,
  CleanerSettings,
  CleanerSource,
  CleanerSourceKind
} from '../../../shared/session-cleaner.ts'
import {
  fileCategory,
  formatError,
  isDatabaseFile,
  isSupportedFile,
  metadataForFile,
  metadataOnlyItem,
  normalizePath,
  createFileItem,
  type ScanItemContext
} from './scan-items.ts'
import { scanOpenCodeDatabase } from './scan-opencode.ts'
import { MAX_SCAN_FILE_BYTES, scanFile } from './scan-files.ts'
import { isCatalogSource, scanCatalogSource } from './catalog-scanner.ts'

export { fingerprintFile } from './scan-files.ts'

const MAX_SCAN_ENTRIES = 10_000
const MAX_DIRECTORY_DEPTH = 32
const PROGRESS_BYTE_INTERVAL = 4 * 1024 * 1024
const CREDENTIAL_DIRECTORIES = new Set([
  '.ssh',
  '.aws',
  '.azure',
  '.gnupg',
  'credentials',
  'secrets',
  'tokens',
  'auth'
])

interface ScanContext extends ScanItemContext {
  signal?: AbortSignal
  onProgress?: (progress: CleanerProgress) => void
  seenPaths: Set<string>
  seenFileIdentities: Set<string>
  seenCatalogSessions: Set<string>
  visited: number
  bytes: number
  lastReportedBytes: number
  fileCount: number
  stoppedAtLimit: boolean
}

export async function scanSources(options: {
  sources: CleanerSource[]
  settings: CleanerSettings
  protectedIds: string[]
  signal?: AbortSignal
  onProgress?: (progress: CleanerProgress) => void
}): Promise<CleanerScanResult> {
  const context: ScanContext = {
    settings: options.settings,
    protectedIds: new Set(options.protectedIds),
    signal: options.signal,
    onProgress: options.onProgress,
    items: [],
    issues: [],
    seenPaths: new Set(),
    seenFileIdentities: new Set(),
    seenCatalogSessions: new Set(),
    visited: 0,
    bytes: 0,
    lastReportedBytes: 0,
    fileCount: 0,
    stoppedAtLimit: false
  }
  reportProgress(context)
  const sources = [...options.sources].sort(
    (left, right) => sourcePriority(left.kind) - sourcePriority(right.kind)
  )
  for (const source of sources) {
    if (isCancelled(context)) break
    if (context.stoppedAtLimit && !isCatalogSource(source)) continue
    await scanRoot(source, context)
  }
  context.items.sort((left, right) => right.modifiedAt - left.modifiedAt)
  reportProgress(context)
  return {
    items: context.items,
    issues: context.issues,
    cancelled: isCancelled(context),
    scannedAt: Date.now()
  }
}

async function scanRoot(source: CleanerSource, context: ScanContext): Promise<void> {
  try {
    if (source.unavailable) {
      addIssue(context, source.path, source.note)
      return
    }
    if ((source.kind === 'opencode' && source.databasePath) || source.kind === 'agy') {
      await scanCatalogSource(source, context)
      return
    }
    const info = await lstat(source.path)
    if (info.isSymbolicLink()) {
      addIssue(context, source.path, '来源是链接或 junction，未跟随')
      return
    }
    if (isCatalogSource(source)) {
      await scanCatalogSource(source, context)
      return
    }
    if (info.isDirectory()) {
      await scanDirectory(source, source.path, 0, context)
    } else if (
      info.isFile() &&
      (source.kind === 'unknown' ||
        source.kind === 'aider' ||
        isSupportedFile(source.kind, source.path))
    ) {
      await scanFileEntry(source, source.path, context)
    } else {
      addIssue(context, source.path, '来源不是支持的普通文件或目录')
    }
  } catch (error) {
    addIssue(context, source.path, formatError(error))
  }
}

async function scanDirectory(
  source: CleanerSource,
  directory: string,
  depth: number,
  context: ScanContext
): Promise<void> {
  if (isCancelled(context) || context.stoppedAtLimit) return
  if (depth > MAX_DIRECTORY_DEPTH) {
    addIssue(context, directory, `目录深度超过上限（${MAX_DIRECTORY_DEPTH}）`)
    return
  }
  let entries
  try {
    const info = await lstat(directory)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      addIssue(context, directory, '目录链接或类型变化未跟随')
      return
    }
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    addIssue(context, directory, formatError(error))
    return
  }
  entries.sort((left, right) => left.name.localeCompare(right.name))

  for (const entry of entries) {
    if (isCancelled(context) || context.stoppedAtLimit) return
    const entryPath = path.join(directory, entry.name)
    context.visited++
    if (isCredentialDirectory(entryPath)) continue
    if (entry.isSymbolicLink()) {
      addIssue(context, entryPath, '链接或 junction 未跟随')
    } else if (entry.isDirectory()) {
      if (await isSessionResourceDirectory(source.kind, entryPath, context))
        await scanMetadataDirectory(source, entryPath, depth + 1, context)
      else await scanDirectory(source, entryPath, depth + 1, context)
    } else if (
      entry.isFile() &&
      !isCredentialFile(entryPath) &&
      (source.kind === 'unknown' || isSupportedFile(source.kind, entryPath))
    ) {
      await scanFileEntry(source, entryPath, context)
    }
    reportProgress(context)
  }
}

async function scanMetadataDirectory(
  source: CleanerSource,
  directory: string,
  depth: number,
  context: ScanContext
): Promise<void> {
  if (isCancelled(context) || context.stoppedAtLimit) return
  if (depth > MAX_DIRECTORY_DEPTH) {
    addIssue(context, directory, `资源目录深度超过上限（${MAX_DIRECTORY_DEPTH}）`)
    return
  }
  let entries
  try {
    const info = await lstat(directory)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      addIssue(context, directory, '资源目录链接或类型变化未跟随')
      return
    }
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    addIssue(context, directory, formatError(error))
    return
  }
  entries.sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    if (isCancelled(context) || context.stoppedAtLimit) return
    const entryPath = path.join(directory, entry.name)
    context.visited++
    if (isCredentialDirectory(entryPath) || isCredentialFile(entryPath)) continue
    if (entry.isSymbolicLink()) {
      addIssue(context, entryPath, '资源链接或 junction 未跟随')
    } else if (entry.isDirectory()) {
      await scanMetadataDirectory(source, entryPath, depth + 1, context)
    } else if (entry.isFile()) {
      await scanFileEntry(source, entryPath, context, 'resources')
    }
    reportProgress(context)
  }
}

async function isSessionResourceDirectory(
  kind: CleanerSourceKind,
  directory: string,
  context: ScanContext
): Promise<boolean> {
  if (kind !== 'claude' && kind !== 'pi') return false
  const sessionPath = path.join(path.dirname(directory), `${path.basename(directory)}.jsonl`)
  try {
    return (await lstat(sessionPath)).isFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      addIssue(context, sessionPath, formatError(error))
    return false
  }
}

async function scanFileEntry(
  source: CleanerSource,
  filePath: string,
  context: ScanContext,
  categoryOverride?: CleanerItem['category']
): Promise<void> {
  if (isCancelled(context) || isCredentialFile(filePath)) return
  const normalizedPath = normalizePath(filePath)
  if (context.seenPaths.has(normalizedPath)) return
  if (context.fileCount >= MAX_SCAN_ENTRIES) {
    context.stoppedAtLimit = true
    addIssue(context, filePath, `文件数量超过扫描上限（${MAX_SCAN_ENTRIES}）`)
    return
  }
  context.seenPaths.add(normalizedPath)
  context.fileCount++
  context.visited++

  try {
    const info = await lstat(filePath, { bigint: true })
    if (info.isSymbolicLink() || !info.isFile()) {
      addIssue(context, filePath, '只接受普通文件；链接或特殊文件未跟随')
      return
    }
    const identity = `${info.dev}:${info.ino}`
    if (info.ino !== 0n && context.seenFileIdentities.has(identity)) {
      addIssue(context, filePath, '相同文件或硬链接已计入其他条目，未重复计算空间')
      return
    }
    if (info.ino !== 0n) context.seenFileIdentities.add(identity)
    if (source.kind === 'unknown' || categoryOverride === 'resources') {
      context.bytes += Number(info.size)
      context.items.push(
        metadataOnlyItem({
          source,
          filePath,
          info,
          category: categoryOverride ?? 'unknown',
          context
        })
      )
      return
    }
    if (info.size > MAX_SCAN_FILE_BYTES) {
      addIssue(
        context,
        filePath,
        `文件超过扫描上限（${MAX_SCAN_FILE_BYTES} 字节）；保留只读占用信息`
      )
      context.bytes += Number(info.size)
      context.items.push(
        metadataOnlyItem({
          source,
          filePath,
          info,
          category: categoryOverride ?? fileCategory(source.kind, filePath),
          context
        })
      )
      return
    }

    const scanned = await scanFile({
      filePath,
      kind: source.kind,
      signal: context.signal,
      onBytes: (bytes) => {
        context.bytes += bytes
        if (context.bytes - context.lastReportedBytes >= PROGRESS_BYTE_INTERVAL)
          reportProgress(context)
      }
    })
    if (scanned.formatIssue) addIssue(context, filePath, scanned.formatIssue)
    if (source.kind === 'opencode' && isDatabaseFile(filePath)) {
      await scanOpenCodeDatabase(source, filePath, scanned, context)
      return
    }
    const metadata = metadataForFile(source.kind, filePath, scanned, context)
    const category = categoryOverride ?? fileCategory(source.kind, filePath)
    context.items.push(
      await createFileItem({ source, filePath, scanned, metadata, category, context })
    )
  } catch (error) {
    if (isAbortError(error)) return
    addIssue(context, filePath, formatError(error))
    if (isScanLimitError(error)) {
      try {
        const info = await lstat(filePath)
        if (info.isFile()) {
          context.bytes += info.size
          context.items.push(
            metadataOnlyItem({
              source,
              filePath,
              info,
              category: categoryOverride ?? fileCategory(source.kind, filePath),
              context
            })
          )
        }
      } catch (statError) {
        addIssue(context, filePath, formatError(statError))
      }
    }
  } finally {
    reportProgress(context)
  }
}

function isScanLimitError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('文件超过扫描上限')
}

function isCredentialDirectory(targetPath: string): boolean {
  return targetPath.split(/[\\/]/).some((part) => CREDENTIAL_DIRECTORIES.has(part.toLowerCase()))
}

function isCredentialFile(targetPath: string): boolean {
  const name = path.basename(targetPath).toLowerCase()
  if (name.startsWith('.env') || ['.npmrc', '.netrc'].includes(name)) return true
  if (
    [
      'auth',
      'auth.json',
      'auth.jsonl',
      'credentials',
      'credentials.json',
      'credentials.jsonl',
      'secrets.json',
      'tokens.json',
      'config.json',
      'settings.json',
      'cline_mcp_settings.json'
    ].includes(name)
  )
    return true
  if (/\.(pem|p12|pfx|key|keystore|jks)$/i.test(name)) return true
  return /(^|[._-])(auth|credentials?|secrets?|tokens?|api[-_]?keys?)([._-]|$)/i.test(name)
}
function sourcePriority(kind: CleanerSourceKind): number {
  return kind === 'unknown' ? 1 : 0
}

function isCancelled(context: ScanContext): boolean {
  return context.signal?.aborted === true
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function addIssue(context: ScanContext, issuePath: string, message: string): void {
  context.issues.push({ path: issuePath, message })
}

function reportProgress(context: ScanContext): void {
  context.lastReportedBytes = context.bytes
  try {
    context.onProgress?.({ visited: context.visited, bytes: context.bytes })
  } catch {
    // A consumer progress callback must not stop a read-only scan.
  }
}
