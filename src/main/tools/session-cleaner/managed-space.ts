import { lstat } from 'node:fs/promises'
import path from 'node:path'
import type {
  CleanerIssue,
  CleanerProgress,
  CleanerSource
} from '../../../shared/session-cleaner.ts'
import type {
  AgentStorageSummary,
  ManagedSession,
  SessionResource,
  SessionStorage
} from '../../../shared/session-manager.ts'
import {
  buildManagedResources,
  collectManagedFiles,
  createSessionPathOwners,
  normalizeManagedPath
} from './managed-space-files.ts'
import { collectManagedMetadata } from './managed-space-metadata.ts'
import {
  measureSqliteDatabases,
  type SqliteDatabaseReference,
  type SqliteSessionMeasurement,
  type SqliteSessionReference
} from './managed-space-sqlite.ts'

const SQLITE_PREFIX = 'sqlite:'
const SQLITE_SESSION_DELIMITER = ':ses_'
const SQLITE_FILE = /\.(db|sqlite|sqlite3)$/i
const SQLITE_PROVIDERS = new Set(['opencode', 'hermes', 'mcode'])

type SessionStorageKind = SessionStorage['kind']

export interface ManagedSpaceRoot {
  path: string
  required: boolean
}

export interface ManagedSpaceFile {
  sourceId: string
  sourceState: ManagedSpaceSourceState
  path: string
  info: import('node:fs').BigIntStats
  identity: string
  kindHint?: SessionResource['kind']
}

export interface ManagedSpaceSourceState {
  source: CleanerSource
  scopeRoot: string
  scopeIsDirectory: boolean
  roots: Map<string, ManagedSpaceRoot>
  files: ManagedSpaceFile[]
  filesByPath: Map<string, ManagedSpaceFile>
  filesByDirectory: Map<string, ManagedSpaceFile[]>
  ompBackups: Map<string, ManagedSpaceFile[]>
  seenFilePaths: Set<string>
  visitedDirectories: Set<string>
  complete: boolean
  summary: AgentStorageSummary
}

export interface ManagedSpaceSessionState {
  key: string
  session: ManagedSession
  sourceState?: ManagedSpaceSourceState
  filePath?: string
  databasePath?: string
  databaseSessionId?: string
  storageKind: SessionStorageKind
  fileBytes: number
  sharedBytes: number
  logicalBytes?: number
  sqliteComplete: boolean
  sqliteMessageCount?: number
  messageCount?: number
  parentSessionId?: string
  modelIds: Set<string>
  messageFileIds: Set<string>
  resourceIds: Set<string>
  complete: boolean
}

export type ManagedSpaceIssueReporter = (
  source: ManagedSpaceSourceState | undefined,
  filePath: string,
  message: string,
  inventoryAffecting?: boolean
) => void

export async function measureManagedSpace(options: {
  sources: CleanerSource[]
  sessions: ManagedSession[]
  signal?: AbortSignal
  onProgress?: (progress: CleanerProgress) => void
}): Promise<{
  sessions: ManagedSession[]
  resources: SessionResource[]
  storage: AgentStorageSummary[]
  issues: CleanerIssue[]
}> {
  const issues: CleanerIssue[] = []
  const sourceStates = await createSourceStates(options.sources, issues)
  const sourceById = new Map(sourceStates.map((state) => [state.source.id, state]))
  const issueKeys = new Set<string>()
  const reportIssue: ManagedSpaceIssueReporter = (
    source,
    filePath,
    message,
    inventoryAffecting = true
  ) => {
    const key = `${filePath}\0${message}`
    if (!issueKeys.has(key)) {
      issueKeys.add(key)
      issues.push({ path: filePath, message })
    }
    if (source && inventoryAffecting) source.complete = false
  }
  const sessionStates = await createSessionStates(options.sessions, sourceById, reportIssue)
  addSessionInventoryRoots(sessionStates)
  await collectManagedFiles({
    sources: sourceStates,
    signal: options.signal,
    onProgress: (progress) => options.onProgress?.({ ...progress, phase: 'scan' }),
    reportIssue
  })
  const sqliteResult = await measureSqliteDatabases({
    databases: collectDatabaseReferences(sourceStates, sessionStates),
    sessions: collectSqliteSessionReferences(sessionStates, reportIssue),
    signal: options.signal,
    reportIssue: (sourceId, filePath, message) =>
      reportIssue(sourceById.get(sourceId), filePath, message)
  })
  applySqliteMeasurements(sessionStates, sqliteResult.sessions, reportIssue)
  for (const [sourceId, bytes] of sqliteResult.databaseFreeBytes) {
    const source = sourceById.get(sourceId)
    if (source) source.summary.databaseFreeBytes = bytes
  }
  const owners = createSessionPathOwners(sessionStates)
  await collectManagedMetadata({
    sources: sourceStates,
    sessions: sessionStates,
    owners,
    signal: options.signal,
    reportIssue
  })
  if (options.signal?.aborted) {
    for (const source of sourceStates) source.complete = false
    for (const session of sessionStates) session.complete = false
  }
  const resources = buildManagedResources({
    sources: sourceStates,
    sessions: sessionStates,
    owners,
    reportIssue
  })
  for (const session of sessionStates) {
    if (session.sourceState && !session.sourceState.complete) session.complete = false
  }
  return {
    sessions: sessionStates.map(toManagedSession),
    resources,
    storage: sourceStates.map((source) => source.summary),
    issues
  }
}

async function createSourceStates(
  sources: CleanerSource[],
  issues: CleanerIssue[]
): Promise<ManagedSpaceSourceState[]> {
  const result: ManagedSpaceSourceState[] = []
  for (const source of sources) {
    const info = await lstat(source.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT')
        issues.push({ path: source.path, message: fileErrorMessage(error) })
      return undefined
    })
    const scopeIsDirectory =
      info?.isDirectory() === true || (source.kind === 'opencode' && info?.isFile() === true)
    const scopeRoot =
      source.kind === 'opencode' && info?.isFile() ? path.dirname(source.path) : source.path
    const state: ManagedSpaceSourceState = {
      source,
      scopeRoot,
      scopeIsDirectory,
      roots: new Map(),
      files: [],
      filesByPath: new Map(),
      filesByDirectory: new Map(),
      ompBackups: new Map(),
      seenFilePaths: new Set(),
      visitedDirectories: new Set(),
      complete: !source.unavailable,
      summary: {
        sourceId: source.id,
        fileBytes: 0,
        databaseBytes: 0,
        walBytes: 0,
        sharedBytes: 0,
        otherBytes: 0,
        complete: !source.unavailable
      }
    }
    if (source.unavailable) {
      issues.push({ path: source.path, message: source.note })
    } else {
      addInventoryRoot(state, scopeRoot, true)
      if (source.databasePath) addInventoryRoot(state, source.databasePath, true)
    }
    result.push(state)
  }
  return result
}

async function createSessionStates(
  sessions: ManagedSession[],
  sources: Map<string, ManagedSpaceSourceState>,
  reportIssue: ManagedSpaceIssueReporter
): Promise<ManagedSpaceSessionState[]> {
  const result: ManagedSpaceSessionState[] = []
  for (const [index, session] of sessions.entries()) {
    const sourceState = sources.get(session.sourceId)
    const sqlite = parseManagedDatabaseSession(session)
    const sqliteSession = isSqliteSession(session)
    const state: ManagedSpaceSessionState = {
      key: `${session.sourceId}\0${normalizeManagedPath(session.sourcePath)}\0${session.sessionId}\0${index}`,
      session,
      sourceState,
      ...(sqlite ? { databasePath: sqlite.databasePath, databaseSessionId: sqlite.sessionId } : {}),
      storageKind: sqliteSession ? 'sqlite' : session.storage.kind,
      fileBytes: 0,
      sharedBytes: 0,
      ...(session.storage.logicalBytes === undefined
        ? {}
        : { logicalBytes: session.storage.logicalBytes }),
      sqliteComplete: false,
      messageCount: session.messageCount,
      parentSessionId: session.parentSessionId,
      modelIds: new Set(session.modelIds.filter(isMetadataString)),
      messageFileIds: new Set(),
      resourceIds: new Set(),
      complete: true
    }
    if (!sourceState) {
      reportIssue(undefined, session.sourcePath, '会话引用了未扫描来源')
      state.complete = false
      result.push(state)
      continue
    }
    if (sqliteSession) {
      if (!sqlite) {
        reportIssue(sourceState, session.sourcePath, 'SQLite 会话引用格式无效')
        state.complete = false
      } else {
        addInventoryRoot(sourceState, sqlite.databasePath, true)
      }
    } else {
      const filePath = path.resolve(session.sourcePath)
      state.filePath = filePath
      const info = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') reportIssue(sourceState, filePath, fileErrorMessage(error))
        return undefined
      })
      if (info?.isSymbolicLink()) {
        reportIssue(sourceState, filePath, '会话路径是链接或 junction，未跟随')
        state.complete = false
      } else if (info?.isDirectory()) {
        state.storageKind = 'directory'
      } else if (info?.isFile()) {
        state.storageKind = 'file'
      } else {
        reportIssue(sourceState, filePath, '会话文件缺失或不是普通文件/目录')
        state.complete = false
      }
    }
    result.push(state)
  }
  return result
}

function addSessionInventoryRoots(sessions: ManagedSpaceSessionState[]): void {
  for (const session of sessions) {
    const source = session.sourceState
    if (!source) continue
    if (session.filePath && !isInsideSourceScope(source, session.filePath))
      addInventoryRoot(source, session.filePath, true)
    if (!session.filePath) continue
    if (session.session.providerId === 'claude' && session.filePath.endsWith('.jsonl'))
      addInventoryRoot(source, session.filePath.slice(0, -'.jsonl'.length), false)
    if (session.session.providerId === 'codex') {
      const siblings = session.filePath.endsWith('.jsonl')
        ? [`${session.filePath}.zst`]
        : session.filePath.endsWith('.jsonl.zst')
          ? [session.filePath.slice(0, -'.zst'.length)]
          : []
      for (const sibling of siblings) addInventoryRoot(source, sibling, false)
    }
  }
}

function collectDatabaseReferences(
  sources: ManagedSpaceSourceState[],
  sessions: ManagedSpaceSessionState[]
): SqliteDatabaseReference[] {
  const references = new Map<string, SqliteDatabaseReference>()
  const add = (sourceId: string, filePath: string): void => {
    const key = `${sourceId}\0${normalizeManagedPath(filePath)}`
    references.set(key, { sourceId, path: filePath })
  }
  for (const source of sources) {
    if (source.source.databasePath) add(source.source.id, source.source.databasePath)
    for (const file of source.files) {
      if (SQLITE_FILE.test(file.path)) add(source.source.id, file.path)
    }
  }
  for (const session of sessions)
    if (session.databasePath && session.sourceState)
      add(session.sourceState.source.id, session.databasePath)
  return [...references.values()]
}

function collectSqliteSessionReferences(
  sessions: ManagedSpaceSessionState[],
  reportIssue: ManagedSpaceIssueReporter
): SqliteSessionReference[] {
  const references: SqliteSessionReference[] = []
  for (const session of sessions) {
    if (!session.databasePath || !session.databaseSessionId || !session.sourceState) continue
    if (!SQLITE_PROVIDERS.has(session.session.providerId)) {
      reportIssue(
        session.sourceState,
        session.session.sourcePath,
        '此 SQLite 会话没有已确认的载荷表布局'
      )
      session.complete = false
      continue
    }

    references.push({
      key: session.key,
      sourceId: session.sourceState.source.id,
      providerId: session.session.providerId,
      databasePath: session.databasePath,
      sessionId: session.databaseSessionId
    })
  }
  return references
}

function applySqliteMeasurements(
  sessions: ManagedSpaceSessionState[],
  measurements: Map<string, SqliteSessionMeasurement>,
  reportIssue: ManagedSpaceIssueReporter
): void {
  for (const session of sessions) {
    if (!session.databasePath) continue
    const measurement = measurements.get(session.key)
    if (!measurement) {
      reportIssue(session.sourceState, session.session.sourcePath, 'SQLite 会话载荷统计结果缺失')
      session.complete = false
      continue
    }
    session.logicalBytes = measurement.logicalBytes
    session.sqliteMessageCount = measurement.messageCount
    session.sqliteComplete = measurement.complete
    session.sharedBytes += measurement.sharedBytes ?? 0
    session.complete &&= measurement.complete
    if (measurement.messageCount !== undefined) session.messageCount = measurement.messageCount
    for (const modelId of measurement.modelIds ?? []) session.modelIds.add(modelId)
    session.parentSessionId ??= measurement.parentSessionId
  }
}

function toManagedSession(state: ManagedSpaceSessionState): ManagedSession {
  return {
    ...state.session,
    ...(state.parentSessionId === undefined ? {} : { parentSessionId: state.parentSessionId }),
    modelIds: [...state.modelIds].sort(),
    ...(state.messageCount === undefined ? {} : { messageCount: state.messageCount }),
    storage: {
      kind: state.storageKind,
      fileBytes: state.fileBytes,
      ...(state.logicalBytes === undefined ? {} : { logicalBytes: state.logicalBytes }),
      sharedBytes: state.sharedBytes,
      complete:
        state.complete &&
        state.sourceState?.complete !== false &&
        (state.storageKind !== 'sqlite' || state.sqliteComplete)
    },
    resourceIds: [...state.resourceIds].sort()
  }
}

function addInventoryRoot(
  source: ManagedSpaceSourceState,
  rootPath: string,
  required: boolean
): void {
  const absolute = path.resolve(rootPath)
  const key = normalizeManagedPath(absolute)
  const existing = source.roots.get(key)
  source.roots.set(key, { path: absolute, required: required || existing?.required === true })
}

function isInsideSourceScope(source: ManagedSpaceSourceState, filePath: string): boolean {
  if (!source.scopeIsDirectory)
    return normalizeManagedPath(source.scopeRoot) === normalizeManagedPath(filePath)
  const relative = path.relative(source.scopeRoot, filePath)
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
}

function parseManagedDatabaseSession(
  session: ManagedSession
): { databasePath: string; sessionId: string } | undefined {
  if (session.providerId === 'opencode') return parseOpenCodeSessionPath(session.sourcePath)
  if (session.providerId === 'hermes') return parseHermesSessionPath(session.sourcePath)
  if (session.providerId !== 'mcode') return undefined
  const prefix = 'mcode:'
  const sessionId = session.sourcePath.startsWith(prefix)
    ? session.sourcePath.slice(prefix.length)
    : ''
  if (
    !sessionId ||
    sessionId !== session.sessionId ||
    !session.storagePath ||
    !path.isAbsolute(session.storagePath)
  )
    return undefined
  return { databasePath: session.storagePath, sessionId }
}

function isSqliteSession(session: ManagedSession): boolean {
  return (
    session.storage.kind === 'sqlite' ||
    ((session.providerId === 'opencode' || session.providerId === 'hermes') &&
      session.sourcePath.startsWith(SQLITE_PREFIX))
  )
}

function parseOpenCodeSessionPath(
  sourcePath: string
): { databasePath: string; sessionId: string } | undefined {
  if (!sourcePath.startsWith(SQLITE_PREFIX)) return undefined
  const separator = sourcePath.lastIndexOf(SQLITE_SESSION_DELIMITER)
  if (separator <= SQLITE_PREFIX.length) return undefined
  const databasePath = sourcePath.slice(SQLITE_PREFIX.length, separator)
  const sessionId = sourcePath.slice(separator + 1)
  if (!path.isAbsolute(databasePath) || !sessionId.startsWith('ses_')) return undefined
  return { databasePath, sessionId }
}

function parseHermesSessionPath(
  sourcePath: string
): { databasePath: string; sessionId: string } | undefined {
  if (!sourcePath.startsWith(SQLITE_PREFIX)) return undefined
  const separator = sourcePath.lastIndexOf('#')
  if (separator <= SQLITE_PREFIX.length) return undefined
  const databasePath = sourcePath.slice(SQLITE_PREFIX.length, separator)
  const sessionId = sourcePath.slice(separator + 1)
  if (!path.isAbsolute(databasePath) || !sessionId) return undefined
  return { databasePath, sessionId }
}
function isMetadataString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256
}

function fileErrorMessage(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code
  return code ? `文件读取失败（${code}）` : '文件读取失败'
}
