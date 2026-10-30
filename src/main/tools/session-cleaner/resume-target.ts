import { realpathSync, statSync, type Stats } from 'node:fs'
import path from 'node:path'

import type { CleanerSource } from '../../../shared/session-cleaner.ts'
import type { ManagedSession } from '../../../shared/session-manager.ts'

const ALLOWED_EXECUTABLES = new Set([
  'agy',
  'claude',
  'codex',
  'gemini',
  'grok',
  'kimi',
  'mcode',
  'omp',
  'opencode',
  'pi'
])
const SAFE_PROVIDER_ID = /^[A-Za-z0-9_-]+$/
const OMP_PROFILE_MAX_BYTES = 64
const OMP_RESERVED_NAMES = new Set(['CON', 'PRN', 'AUX', 'NUL'])
const OMP_PROFILE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/

export interface ResumeTarget {
  executable: string
  args: string[]
  env: Record<string, string>
  cwd?: string
}

export function buildResumeTarget(input: {
  session: ManagedSession
  source: CleanerSource
}): ResumeTarget {
  const { session, source } = input
  validateIdentity(session, source)

  if (session.providerId === 'hermes') {
    throw new Error('Hermes 上游未提供会话续聊命令')
  }
  if (session.providerId === 'openclaw') {
    throw new Error('OpenClaw 会话由网关管理，没有本地 CLI 续聊命令')
  }
  if (!session.capabilities.resume || !session.resumeCommand?.trim()) {
    throw new Error('此会话没有原工具提供的续聊命令')
  }

  // resumeCommand 是上游展示用的命令文本；参数只从已知 provider 字段生成。
  const target = targetForProvider(session, source)
  const cwd = optionalDirectory(session.projectDir, '会话项目目录')
  return cwd ? { ...target, cwd } : target
}

function validateIdentity(session: ManagedSession, source: CleanerSource): void {
  if (session.providerId !== source.kind || session.sourceId !== source.id) {
    throw new Error('会话与来源不匹配，请重新扫描')
  }
  if (!session.sessionId || session.sessionId.includes(String.fromCharCode(0))) {
    throw new Error('会话 ID 无效')
  }
  if (source.unavailable) {
    throw new Error(source.note || '会话来源目录不可用')
  }
  if (source.capability !== 'sessions') {
    throw new Error('此来源不包含可续聊会话')
  }
}

function targetForProvider(session: ManagedSession, source: CleanerSource): ResumeTarget {
  switch (session.providerId) {
    case 'codex':
      return makeTarget('codex', ['resume', session.sessionId], {
        CODEX_HOME: configRootFromSource(source, ['sessions', 'archived_sessions'], 'Codex')
      })
    case 'claude':
      return makeTarget('claude', ['--resume', session.sessionId], {
        CLAUDE_CONFIG_DIR: configRootFromSource(source, ['projects'], 'Claude')
      })
    case 'opencode':
      return openCodeTarget(session, source)
    case 'pi':
      return fileSessionTarget('pi', '--session', session, source)
    case 'omp':
      return ompTarget(session, source)
    case 'mcode':
      return mcodeTarget(session, source)
    case 'kimi':
      return kimiTarget(session, source)
    case 'gemini':
      return idSessionTarget('gemini', '--resume', session, source)
    case 'grokbuild':
      return idSessionTarget('grok', '--resume', session, source)
    case 'agy':
      return agyTarget(session, source)
    default:
      throw new Error(`上游没有为 ${session.providerId} 提供受支持的续聊命令`)
  }
}

function fileSessionTarget(
  executable: string,
  flag: string,
  session: ManagedSession,
  source: CleanerSource
): ResumeTarget {
  const sessionPath = fileInsideSource(source, session.sourcePath)
  return makeTarget(executable, [flag, sessionPath], {})
}

function idSessionTarget(
  executable: string,
  flag: string,
  session: ManagedSession,
  source: CleanerSource
): ResumeTarget {
  fileInsideSource(source, session.sourcePath)
  return makeTarget(executable, [flag, session.sessionId], {})
}
function mcodeTarget(session: ManagedSession, source: CleanerSource): ResumeTarget {
  requireSafeProviderId(session.sessionId, 'MCode')
  if (session.sourcePath !== `mcode:${session.sessionId}`) {
    throw new Error('MCode 会话引用与会话 ID 不匹配')
  }
  const dataDirectory = requireDirectory(source.path, 'MCode 数据目录')
  return makeTarget('mcode', ['--session', session.sessionId], {
    MINIMAX_DATA_DIR: dataDirectory
  })
}

function kimiTarget(session: ManagedSession, source: CleanerSource): ResumeTarget {
  requireSafeProviderId(session.sessionId, 'Kimi')
  fileInsideSource(source, session.sourcePath)
  const sessionsDirectory = requireDirectory(source.path, 'Kimi 会话目录')
  const homeDirectory =
    path.basename(sessionsDirectory).toLowerCase() === 'sessions'
      ? path.dirname(sessionsDirectory)
      : sessionsDirectory
  return makeTarget('kimi', ['--session', session.sessionId], {
    KIMI_CODE_HOME: requireDirectory(homeDirectory, 'Kimi 配置目录')
  })
}

function ompTarget(session: ManagedSession, source: CleanerSource): ResumeTarget {
  const sessionRoot = requireDirectory(source.path, 'OMP 会话目录')
  const sessionFile = fileInsideSource(source, session.sourcePath)
  const profile = ompProfile(sessionRoot)
  const configuredAgent = process.env.PI_CODING_AGENT_DIR
  const agentDirectory = configuredAgent
    ? requireDirectory(configuredAgent, 'OMP agent 目录')
    : requireDirectory(path.dirname(sessionRoot), 'OMP agent 目录')
  const env: Record<string, string> = {
    OMP_PROFILE: profile,
    PI_PROFILE: profile,
    PI_CODING_AGENT_DIR: agentDirectory,
    PI_CODING_AGENT_SESSION_DIR: sessionRoot,
    PI_CONFIG_DIR: process.env.PI_CONFIG_DIR ?? '',
    XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? '',
    XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? '',
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? ''
  }
  // 当前上游 OMP adapter 用 --resume；Pi adapter 使用 --session。
  return makeTarget('omp', ['--resume', sessionFile], env)
}

function ompProfile(sessionRoot: string): string {
  const parts = path.resolve(sessionRoot).split(path.sep)
  const profileIndex = parts.findIndex(
    (part, index) => part.toLowerCase() === 'profiles' && index + 2 < parts.length
  )
  if (profileIndex < 0) return 'default'
  const profile = parts[profileIndex + 1]
  const next = parts[profileIndex + 2].toLowerCase()
  if (next !== 'agent' && next !== 'sessions') return 'default'
  validateOmpProfile(profile)
  return profile
}

function validateOmpProfile(profile: string): void {
  const reserved = profile.split('.')[0].toUpperCase()
  const isReservedDevice = OMP_RESERVED_NAMES.has(reserved) || /^(COM|LPT)[0-9]$/.test(reserved)
  if (
    Buffer.byteLength(profile, 'utf8') > OMP_PROFILE_MAX_BYTES ||
    !OMP_PROFILE_PATTERN.test(profile) ||
    profile.endsWith('.') ||
    isReservedDevice
  ) {
    throw new Error('OMP profile 名称无效')
  }
}

function openCodeTarget(session: ManagedSession, source: CleanerSource): ResumeTarget {
  if (!session.sourcePath.startsWith('sqlite:')) {
    fileInsideSource(source, session.sourcePath)
    const root = requireDirectory(source.path, 'OpenCode 来源目录')
    const dataRoot = path.basename(root).toLowerCase() === 'storage' ? path.dirname(root) : root
    return makeTarget('opencode', ['-s', session.sessionId], {
      XDG_DATA_HOME: path.dirname(dataRoot),
      ...(source.databasePath
        ? { OPENCODE_DB: requireFile(source.databasePath, 'OpenCode 数据库') }
        : {})
    })
  }
  const databaseFromSession = openCodeDatabaseFromSession(session)
  const databaseCandidate = source.databasePath ?? databaseFromSource(source)
  const databasePath = requireFile(databaseCandidate, 'OpenCode 数据库')
  if (!samePath(databasePath, databaseFromSession)) {
    throw new Error('OpenCode 来源数据库与会话引用不匹配')
  }
  const dataHome = openCodeDataHome(source.path, databasePath)
  return makeTarget('opencode', ['-s', session.sessionId], {
    OPENCODE_DB: databasePath,
    XDG_DATA_HOME: dataHome
  })
}

function databaseFromSource(source: CleanerSource): string {
  const sourcePath = absolutePath(source.path, 'OpenCode 来源路径')
  const information = existingStat(sourcePath, 'OpenCode 来源路径')
  return information.isFile() ? sourcePath : path.join(sourcePath, 'opencode.db')
}

function openCodeDatabaseFromSession(session: ManagedSession): string {
  const prefix = 'sqlite:'
  const suffix = `:${session.sessionId}`
  if (!session.sourcePath.startsWith(prefix) || !session.sourcePath.endsWith(suffix)) {
    throw new Error('OpenCode 会话引用无效')
  }
  const databasePath = session.sourcePath.slice(prefix.length, -suffix.length)
  return absolutePath(databasePath, 'OpenCode 会话数据库路径')
}

function openCodeDataHome(sourcePath: string, databasePath: string): string {
  let dataRoot = path.dirname(databasePath)
  try {
    const resolvedSource = absolutePath(sourcePath, 'OpenCode 来源路径')
    const information = statSync(resolvedSource)
    dataRoot = information.isDirectory() ? resolvedSource : path.dirname(resolvedSource)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('OpenCode 来源目录不可用')
    }
  }
  const xdgDataHome =
    path.basename(dataRoot).toLowerCase() === 'opencode' ? path.dirname(dataRoot) : dataRoot
  return requireDirectory(xdgDataHome, 'OpenCode XDG 数据目录')
}

function agyTarget(session: ManagedSession, source: CleanerSource): ResumeTarget {
  const root = requireDirectory(source.path, 'AGY 会话目录')
  if (isCcSwitchAgyProfile(root)) {
    throw new Error('CC Switch AGY key profile 依赖账号配置，不能作为普通 CLI 会话续聊')
  }
  existingPathInside(root, session.sourcePath, 'AGY 会话引用', true)
  return makeTarget('agy', [`--conversation=${session.sessionId}`], {})
}

function isCcSwitchAgyProfile(root: string): boolean {
  const tail = path
    .resolve(root)
    .split(path.sep)
    .slice(-4)
    .map((part) => part.toLowerCase())
  return (
    tail.length === 4 && tail[0] === 'agy' && tail[2] === 'antigravity-cli' && tail[3] === 'brain'
  )
}

function configRootFromSource(
  source: CleanerSource,
  sessionDirectoryNames: string[],
  providerName: string
): string {
  const sourceDirectory = requireDirectory(source.path, `${providerName} 会话目录`)
  if (source.configPath) {
    const config = requireDirectory(source.configPath, `${providerName} 配置目录`)
    existingPathInside(config, sourceDirectory, `${providerName} 会话目录`, true)
    return config
  }
  const leaf = path.basename(sourceDirectory).toLowerCase()
  const configDirectory = sessionDirectoryNames.includes(leaf)
    ? path.dirname(sourceDirectory)
    : sourceDirectory
  return requireDirectory(configDirectory, `${providerName} 配置目录`)
}

function fileInsideSource(source: CleanerSource, sessionPath: string): string {
  const root = requireDirectory(source.path, `${source.kind} 来源目录`)
  const file = requireFile(sessionPath, `${source.kind} 会话文件`)
  existingPathInside(root, file, `${source.kind} 会话文件`)
  return file
}

function existingPathInside(
  root: string,
  target: string,
  label: string,
  allowSame = false
): string {
  const sourceRoot = realPath(root, `${label}来源目录`)
  const resolvedTarget = absolutePath(target, label)
  const existingTarget = realPath(resolvedTarget, label)
  const relative = path.relative(sourceRoot, existingTarget)
  const inside =
    relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  if ((!allowSame && relative === '') || !inside) {
    throw new Error(`${label}不属于登记来源`)
  }
  return resolvedTarget
}

function requireSafeProviderId(sessionId: string, provider: string): void {
  if (!SAFE_PROVIDER_ID.test(sessionId)) {
    throw new Error(`${provider} 会话 ID 不符合上游续聊参数格式`)
  }
}

function requireDirectory(value: string, label: string): string {
  const resolved = absolutePath(value, label)
  if (!existingStat(resolved, label).isDirectory()) {
    throw new Error(`${label}不是目录`)
  }
  return resolved
}

function requireFile(value: string, label: string): string {
  const resolved = absolutePath(value, label)
  if (!existingStat(resolved, label).isFile()) {
    throw new Error(`${label}不是文件`)
  }
  return resolved
}

function existingStat(value: string, label: string): Stats {
  try {
    const information = statSync(value)
    if (!information) throw new Error()
    return information
  } catch {
    throw new Error(`${label}不存在或不可访问`)
  }
}

function realPath(value: string, label: string): string {
  try {
    return realpathSync(value)
  } catch {
    throw new Error(`${label}不存在或不可访问`)
  }
}

function absolutePath(value: string, label: string): string {
  if (!value || !path.isAbsolute(value) || value.includes(String.fromCharCode(0))) {
    throw new Error(`${label}必须是有效绝对路径`)
  }
  try {
    return path.resolve(value)
  } catch {
    throw new Error(`${label}无效`)
  }
}

function optionalDirectory(value: string | undefined, label: string): string | undefined {
  if (value === undefined || value === '') return undefined
  return requireDirectory(value, label)
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function makeTarget(executable: string, args: string[], env: Record<string, string>): ResumeTarget {
  if (!ALLOWED_EXECUTABLES.has(executable)) {
    throw new Error('续聊程序不在允许清单中')
  }
  return { executable, args, env }
}
