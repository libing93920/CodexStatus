import { lstat, readdir } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { SessionResource } from '../../../shared/session-manager.ts'
import type {
  ManagedSpaceFile,
  ManagedSpaceIssueReporter,
  ManagedSpaceSessionState,
  ManagedSpaceSourceState
} from './managed-space.ts'

export interface ManagedSpaceProgress {
  visited: number
  bytes: number
}

export function normalizeManagedPath(filePath: string): string {
  const resolved = path.resolve(filePath)
  if (process.platform !== 'win32') return resolved

  const verbatimUncPrefix = '\\\\?\\UNC\\'
  if (resolved.toLowerCase().startsWith(verbatimUncPrefix.toLowerCase())) {
    return ('\\\\' + resolved.slice(verbatimUncPrefix.length)).toLowerCase()
  }

  const verbatimPrefix = '\\\\?\\'
  const resolvedWithoutVerbatimPrefix = resolved.slice(verbatimPrefix.length)
  if (resolved.startsWith(verbatimPrefix) && /^[a-z]:\\/i.test(resolvedWithoutVerbatimPrefix)) {
    return resolvedWithoutVerbatimPrefix.toLowerCase()
  }
  return resolved.toLowerCase()
}

export function isManagedPathInside(directory: string, filePath: string): boolean {
  const relative = path.relative(normalizeManagedPath(directory), normalizeManagedPath(filePath))
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
  )
}

export function addManagedPathOwner(
  owners: Map<string, Set<ManagedSpaceSessionState>>,
  filePath: string,
  session: ManagedSpaceSessionState
): void {
  const key = normalizeManagedPath(filePath)
  const existing = owners.get(key) ?? new Set<ManagedSpaceSessionState>()
  existing.add(session)
  owners.set(key, existing)
}

export function createSessionPathOwners(
  sessions: ManagedSpaceSessionState[]
): Map<string, Set<ManagedSpaceSessionState>> {
  const owners = new Map<string, Set<ManagedSpaceSessionState>>()
  for (const session of sessions) {
    const source = session.sourceState
    if (session.databasePath && source) {
      for (const databasePath of [
        session.databasePath,
        session.databasePath + '-wal',
        session.databasePath + '-shm'
      ]) {
        const file = source.filesByPath.get(normalizeManagedPath(databasePath))
        if (file) addManagedPathOwner(owners, file.path, session)
      }
    }
    if (session.filePath && source) {
      const primary = source.filesByPath.get(normalizeManagedPath(session.filePath))
      if (primary) primary.kindHint ??= 'transcript'
      addManagedPathOwner(owners, session.filePath, session)
      if (session.storageKind === 'directory') {
        for (const file of filesInsideDirectory(source, session.filePath)) {
          file.kindHint = isTranscriptPath(file.path) ? 'transcript' : 'attachment'
          addManagedPathOwner(owners, file.path, session)
        }
      }
    }
    if (!session.filePath || !source) continue
    addProviderSpecificPathOwners(owners, session, source)
  }
  return owners
}

function addProviderSpecificPathOwners(
  owners: Map<string, Set<ManagedSpaceSessionState>>,
  session: ManagedSpaceSessionState,
  source: ManagedSpaceSourceState
): void {
  const filePath = session.filePath
  if (!filePath) return

  if (session.session.providerId === 'claude' && filePath.endsWith('.jsonl')) {
    const sidecar = filePath.slice(0, -'.jsonl'.length)
    for (const file of filesInsideDirectory(source, sidecar)) {
      file.kindHint = 'attachment'
      addManagedPathOwner(owners, file.path, session)
    }
  }
  if (session.session.providerId === 'codex') {
    for (const sibling of codexTranscriptSiblings(filePath)) {
      const file = source.filesByPath.get(normalizeManagedPath(sibling))
      if (!file) continue
      file.kindHint = 'transcript'
      addManagedPathOwner(owners, file.path, session)
    }
  }
  if (
    session.session.providerId === 'gemini' &&
    path.extname(filePath).toLowerCase() === '.jsonl'
  ) {
    const parsedPath = path.parse(normalizeManagedPath(filePath))
    const sidecarPath = path.join(parsedPath.dir, parsedPath.name + '.json')
    const sidecar = source.filesByPath.get(normalizeManagedPath(sidecarPath))
    if (sidecar) {
      sidecar.kindHint = 'attachment'
      addManagedPathOwner(owners, sidecar.path, session)
    }
  }
  if (session.session.providerId === 'omp' && path.extname(filePath).toLowerCase() === '.jsonl') {
    addOmpSessionResourceOwners(owners, filePath, source, session)
  }
}

function addOmpSessionResourceOwners(
  owners: Map<string, Set<ManagedSpaceSessionState>>,
  filePath: string,
  source: ManagedSpaceSourceState,
  session: ManagedSpaceSessionState
): void {
  const parsedPath = path.parse(normalizeManagedPath(filePath))
  const artifactDirectory = path.join(parsedPath.dir, parsedPath.name)
  const backups = source.ompBackups.get(normalizeManagedPath(filePath)) ?? []
  for (const file of [...filesInsideDirectory(source, artifactDirectory), ...backups]) {
    file.kindHint = 'attachment'
    addManagedPathOwner(owners, file.path, session)
  }
}

export async function collectManagedFiles(options: {
  sources: Iterable<ManagedSpaceSourceState>
  signal?: AbortSignal
  onProgress?: (progress: ManagedSpaceProgress) => void
  reportIssue: ManagedSpaceIssueReporter
}): Promise<void> {
  const identities = new Set<string>()
  let visited = 0
  let bytes = 0
  for (const source of options.sources) {
    if (options.signal?.aborted) return
    if (source.source.unavailable) continue
    for (const root of source.roots.values()) {
      const pending = [root.path]
      let isRoot = true
      while (pending.length) {
        if (options.signal?.aborted) return
        const target = pending.pop()!
        const key = normalizeManagedPath(target)
        const info = await lstat(target, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT' && !isRoot && !root.required) return undefined
          if (error.code === 'ENOENT' && !root.required) return undefined
          options.reportIssue(source, target, fileErrorMessage(error))
          return undefined
        })
        isRoot = false
        if (!info) continue
        visited++
        if (info.isSymbolicLink()) {
          options.reportIssue(source, target, '链接或 junction 未跟随')
          continue
        }
        if (info.isDirectory()) {
          if (source.visitedDirectories.has(key)) continue
          source.visitedDirectories.add(key)
          const names = await readdir(target).catch((error: NodeJS.ErrnoException) => {
            options.reportIssue(source, target, fileErrorMessage(error))
            return []
          })
          for (const name of names.sort().reverse()) pending.push(path.join(target, name))
          reportProgress(options.onProgress, visited, bytes)
          continue
        }
        if (!info.isFile()) {
          options.reportIssue(source, target, '特殊文件未计入')
          continue
        }
        if (source.seenFilePaths.has(key)) continue
        source.seenFilePaths.add(key)
        const identity = fileIdentity(info, target)
        const file: ManagedSpaceFile = {
          sourceId: source.source.id,
          sourceState: source,
          path: target,
          info,
          identity
        }
        source.files.push(file)
        indexManagedFile(source, file)
        if (identity.startsWith('path:'))
          options.reportIssue(source, target, '文件系统未提供硬链接去重身份')
        if (!identities.has(identity)) {
          identities.add(identity)
          bytes += Number(info.size)
        }
        reportProgress(options.onProgress, visited, bytes)
      }
    }
  }
}

export function buildManagedResources(options: {
  sources: Iterable<ManagedSpaceSourceState>
  sessions: ManagedSpaceSessionState[]
  owners: Map<string, Set<ManagedSpaceSessionState>>
  reportIssue: ManagedSpaceIssueReporter
}): SessionResource[] {
  const sources = [...options.sources]
  const groups = groupManagedFiles(sources)
  const resources: SessionResource[] = []
  for (const group of groups.values()) {
    const resource = buildResource(group, options.owners, options.reportIssue)
    resources.push(resource)
    updateSourceSummaries(group, resource, sources)
    updateSessionStorage(group, resource, options.owners)
    markUnknownOwnership(group, resource, options)
  }
  for (const source of sources) {
    source.summary.otherBytes = Math.max(
      0,
      source.summary.fileBytes - source.summary.databaseBytes - source.summary.walBytes
    )
    source.summary.complete = source.complete
  }
  return resources.sort(
    (left, right) =>
      left.sourceId.localeCompare(right.sourceId) || left.path.localeCompare(right.path)
  )
}

interface FileGroup {
  identity: string
  files: ManagedSpaceFile[]
  bytes: number
  kind: SessionResource['kind']
  owners: Set<ManagedSpaceSessionState>
  externalLinks: boolean
  inconsistentSize: boolean
}

function groupManagedFiles(sources: Iterable<ManagedSpaceSourceState>): Map<string, FileGroup> {
  const groups = new Map<string, FileGroup>()
  for (const source of sources) {
    for (const file of source.files) {
      const group = groups.get(file.identity) ?? {
        identity: file.identity,
        files: [],
        bytes: Number(file.info.size),
        kind: fileKind(file),
        owners: new Set<ManagedSpaceSessionState>(),
        externalLinks: false,
        inconsistentSize: false
      }
      group.files.push(file)
      group.bytes = Math.max(group.bytes, Number(file.info.size))
      group.kind = mergeResourceKind(group.kind, fileKind(file))
      groups.set(file.identity, group)
    }
  }
  return groups
}

function buildResource(
  group: FileGroup,
  owners: Map<string, Set<ManagedSpaceSessionState>>,
  reportIssue: ManagedSpaceIssueReporter
): SessionResource {
  const uniquePaths = new Set(group.files.map((file) => normalizeManagedPath(file.path)))
  const linkCount = group.files.reduce(
    (maximum, file) => Math.max(maximum, Number(file.info.nlink)),
    1
  )
  group.externalLinks = linkCount > uniquePaths.size
  group.inconsistentSize = new Set(group.files.map((file) => file.info.size)).size > 1
  for (const file of group.files) {
    for (const owner of owners.get(normalizeManagedPath(file.path)) ?? []) group.owners.add(owner)
  }
  if (group.inconsistentSize) {
    for (const file of group.files)
      reportIssue(file.sourceState, file.path, '硬链接文件在扫描期间大小发生变化')
  }
  if (group.externalLinks) {
    for (const file of group.files)
      reportIssue(file.sourceState, file.path, '存在扫描范围外硬链接，归属不完整')
  }
  const pathOwners = group.files.map(
    (file) => owners.get(normalizeManagedPath(file.path))?.size ?? 0
  )
  const aliasesWithoutOwner = pathOwners.some((count) => count === 0)
  const sourceIds = new Set(group.files.map((file) => file.sourceId))
  const shared =
    group.kind === 'database' ||
    group.kind === 'wal' ||
    group.owners.size > 1 ||
    aliasesWithoutOwner ||
    group.externalLinks ||
    sourceIds.size > 1
  const primary = [...group.files].sort(
    (left, right) =>
      left.sourceId.localeCompare(right.sourceId) ||
      normalizeManagedPath(left.path).localeCompare(normalizeManagedPath(right.path))
  )[0]
  const id = createHash('sha256').update(group.identity).digest('hex').slice(0, 32)
  return {
    id,
    sourceId: primary.sourceId,
    sourceIds: [...sourceIds].sort(),
    path: primary.path,
    kind: group.kind,
    bytes: group.bytes,
    sessionIds: [...new Set([...group.owners].map((session) => session.session.sessionId))].sort(),
    shared
  }
}

function updateSourceSummaries(
  group: FileGroup,
  resource: SessionResource,
  sources: Iterable<ManagedSpaceSourceState>
): void {
  const uniqueSources = new Set(group.files.map((file) => file.sourceId))
  for (const source of sources) {
    if (!uniqueSources.has(source.source.id)) continue
    source.summary.fileBytes += group.bytes
    if (group.kind === 'database') source.summary.databaseBytes += group.bytes
    else if (group.kind === 'wal') source.summary.walBytes += group.bytes
    if (resource.shared) source.summary.sharedBytes += group.bytes
  }
}

function updateSessionStorage(
  group: FileGroup,
  resource: SessionResource,
  owners: Map<string, Set<ManagedSpaceSessionState>>
): void {
  const uniqueOwners = new Set(group.owners)
  const hasUnownedAlias = group.files.some(
    (file) => (owners.get(normalizeManagedPath(file.path))?.size ?? 0) === 0
  )
  const exclusivelyOwned =
    uniqueOwners.size === 1 &&
    !group.externalLinks &&
    !group.inconsistentSize &&
    !hasUnownedAlias &&
    !resource.shared
  const containerOnly =
    resource.kind === 'database' || resource.kind === 'wal' || /-shm$/i.test(resource.path)
  for (const session of uniqueOwners) {
    session.resourceIds.add(resource.id)
    if (containerOnly) continue
    if (exclusivelyOwned) session.fileBytes += group.bytes
    else session.sharedBytes += group.bytes
  }
  if (group.externalLinks || group.inconsistentSize || hasUnownedAlias) {
    for (const session of uniqueOwners) session.complete = false
  }
}

function markUnknownOwnership(
  group: FileGroup,
  resource: SessionResource,
  options: {
    owners: Map<string, Set<ManagedSpaceSessionState>>
    reportIssue: ManagedSpaceIssueReporter
  }
): void {
  if (['database', 'wal', 'log'].includes(resource.kind)) return
  const unknownFiles = group.files.filter(
    (file) => !options.owners.has(normalizeManagedPath(file.path))
  )
  for (const file of unknownFiles) {
    options.reportIssue(file.sourceState, file.path, '文件大小已统计，但会话归属无法确证')
  }
}

function fileKind(file: ManagedSpaceFile): SessionResource['kind'] {
  const name = path.basename(file.path)
  if (/-wal$/i.test(name)) return 'wal'
  if (/\.(db|sqlite|sqlite3)$/i.test(name)) return 'database'
  if (name.toLowerCase().endsWith('.log') || /[\\/]logs?[\\/]/i.test(file.path)) return 'log'
  if (file.kindHint) return file.kindHint
  return isTranscriptPath(file.path) ? 'transcript' : 'other'
}

function mergeResourceKind(
  current: SessionResource['kind'],
  next: SessionResource['kind']
): SessionResource['kind'] {
  return current === next ? current : 'other'
}

function isTranscriptPath(filePath: string): boolean {
  return /\.(jsonl(?:\.zst)?|json)$/i.test(filePath)
}

function codexTranscriptSiblings(filePath: string): string[] {
  if (filePath.endsWith('.jsonl')) return [filePath, `${filePath}.zst`]
  if (filePath.endsWith('.jsonl.zst')) return [filePath, filePath.slice(0, -'.zst'.length)]
  return [filePath]
}

export function fileIdentity(info: Pick<BigIntStats, 'ino' | 'dev'>, filePath: string): string {
  return info.ino ? `inode:${info.dev}:${info.ino}` : `path:${normalizeManagedPath(filePath)}`
}

function indexManagedFile(source: ManagedSpaceSourceState, file: ManagedSpaceFile): void {
  const key = normalizeManagedPath(file.path)
  source.filesByPath.set(key, file)
  // 目录归属按祖先索引一次，避免每个会话重新遍历全部文件。
  let directory = path.dirname(key)
  while (true) {
    const files = source.filesByDirectory.get(directory) ?? []
    files.push(file)
    source.filesByDirectory.set(directory, files)
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  if (source.source.kind !== 'omp' || !file.path.endsWith('.bak')) return
  const name = path.basename(file.path)
  const extensionName = name.toLowerCase()
  let separator = extensionName.indexOf('.jsonl.')
  while (separator !== -1) {
    const transcript = normalizeManagedPath(
      path.join(path.dirname(file.path), name.slice(0, separator + '.jsonl'.length))
    )
    const backups = source.ompBackups.get(transcript) ?? []
    backups.push(file)
    source.ompBackups.set(transcript, backups)
    separator = extensionName.indexOf('.jsonl.', separator + 1)
  }
}

function filesInsideDirectory(
  source: ManagedSpaceSourceState,
  directory: string
): ManagedSpaceFile[] {
  const key = normalizeManagedPath(directory)
  const file = source.filesByPath.get(key)
  return file ? [file] : (source.filesByDirectory.get(key) ?? [])
}

function fileErrorMessage(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code
  return code ? `文件读取失败（${code}）` : '文件读取失败'
}

function reportProgress(
  onProgress: ((progress: ManagedSpaceProgress) => void) | undefined,
  visited: number,
  bytes: number
): void {
  try {
    onProgress?.({ visited, bytes })
  } catch {
    /* 进度回调异常不应中断只读扫描。 */
  }
}
