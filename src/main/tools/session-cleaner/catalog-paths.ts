import { opendir, readdir, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import JSON5 from 'json5'
import { readPathOverrides } from './catalog-settings.ts'
import type { CleanerSourceKind } from '../../../shared/session-cleaner.ts'

const PI_SETTINGS_MAX_BYTES = 1024 * 1024
const OMP_PROFILE_MAX_BYTES = 64
const CC_SWITCH_BUNDLE_ID = 'com.ccswitch.desktop'

type SessionLayout = 'flat' | 'projects'
type Platform = NodeJS.Platform

export interface CatalogPathOptions {
  home?: string
  env?: NodeJS.ProcessEnv
  platform?: Platform
}

export interface CatalogSourceSpec {
  kind: CleanerSourceKind
  path: string
  aliases?: string[]
  databasePath?: string
  configPath?: string
  layout?: SessionLayout
  unavailable?: boolean
  note?: string
}

interface PathContext {
  home: string
  env: NodeJS.ProcessEnv
  platform: Platform
}

export async function resolveCatalogSourceSpecs(
  options: CatalogPathOptions = {}
): Promise<CatalogSourceSpec[]> {
  const context = createContext(options)
  const overrides = await readPathOverrides(context.home)
  const codex = configuredDirectory(overrides.codexConfigDir, context.home, '.codex')
  const claude = configuredDirectory(overrides.claudeConfigDir, context.home, '.claude')
  const gemini = configuredDirectory(overrides.geminiConfigDir, context.home, '.gemini')
  const grok = configuredDirectory(overrides.grokConfigDir, context.home, '.grok')
  const openclaw = configuredDirectory(overrides.openclawConfigDir, context.home, '.openclaw')
  const hermes = resolveHermesDirectory(context, overrides.hermesConfigDir)
  const pi = await resolvePiSessionSpec(context, overrides.piConfigDir)
  const omp = await resolveOmpSessionSpec(context, overrides.ompConfigDir)
  const openCodeBase = resolveOpenCodeBasePath(context)
  const openCodeDatabase = resolveOpenCodeDatabasePath(context)
  const mcode = resolveMcodeDirectory(context)
  const kimi = resolveKimiDirectory(context)
  const agyRoots = await resolveAgySessionRoots(context)

  return [
    ...['sessions', 'archived_sessions'].map((name) =>
      spec('codex', path.join(codex, name), { configPath: codex })
    ),
    spec('claude', path.join(claude, 'projects'), { configPath: claude }),
    spec('opencode', openCodeBase, { aliases: [openCodeDatabase], databasePath: openCodeDatabase }),
    pi,
    spec('gemini', path.join(gemini, 'tmp')),
    spec('openclaw', path.join(openclaw, 'agents')),
    spec('hermes', hermes),
    ...['sessions', 'archived_sessions'].map((name) => spec('grokbuild', path.join(grok, name))),
    omp,
    spec('mcode', mcode),
    spec('kimi', path.join(kimi, 'sessions')),
    ...agyRoots.map((root) =>
      spec('agy', root, {
        aliases: [path.join(path.dirname(root), 'conversation_summaries.db')]
      })
    )
  ]
}

export function resolveOpenCodeBasePath(options: CatalogPathOptions = {}): string {
  const { home, env } = createContext(options)
  const dataHome = nonemptyRaw(env.XDG_DATA_HOME)
  const root = dataHome
    ? path.join(dataHome, 'opencode')
    : path.join(home, '.local', 'share', 'opencode')
  return path.resolve(root)
}

export function resolveOpenCodeDatabasePath(options: CatalogPathOptions = {}): string {
  const context = createContext(options)
  const configured = nonemptyRaw(context.env.OPENCODE_DB)
  if (!configured) return path.join(resolveOpenCodeBasePath(context), 'opencode.db')
  return path.isAbsolute(configured)
    ? path.resolve(configured)
    : path.resolve(resolveOpenCodeBasePath(context), configured)
}

function createContext(options: CatalogPathOptions): PathContext {
  const env = options.env ?? process.env
  const testHome = nonempty(env.CC_SWITCH_TEST_HOME)
  return {
    home: path.resolve(options.home ?? testHome ?? os.homedir()),
    env,
    platform: options.platform ?? process.platform
  }
}

function configuredDirectory(value: string | undefined, home: string, fallback: string): string {
  return path.resolve(value ? expandOverridePath(value, home) : path.join(home, fallback))
}

function expandOverridePath(value: string, home: string): string {
  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.resolve(home, value.slice(2))
  return value
}

async function resolvePiSessionSpec(
  context: PathContext,
  settingsAgentDir: string | undefined
): Promise<CatalogSourceSpec> {
  const defaultRoot = path.join(context.home, '.pi', 'agent', 'sessions')
  const configured = nonemptyRaw(context.env.PI_CODING_AGENT_SESSION_DIR)
  if (configured) return configuredPiRoot(configured, context.home, defaultRoot)

  let agentDirectory: string
  try {
    agentDirectory = resolvePiAgentDirectory(context, settingsAgentDir)
  } catch (error) {
    return unavailablePi(defaultRoot, `Pi 配置目录不可用：${errorText(error)}`)
  }
  const configuredAgentRoot = path.join(agentDirectory, 'sessions')

  const settingsFile = path.join(agentDirectory, 'settings.json')
  let settings: Record<string, unknown>
  try {
    const info = await stat(settingsFile)
    if (info.size > PI_SETTINGS_MAX_BYTES) throw new Error('settings.json 超过 1 MB')
    const parsed = JSON5.parse(await readFile(settingsFile, 'utf8'))
    if (!isRecord(parsed)) throw new Error('settings.json 根节点不是对象')
    settings = parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return spec('pi', configuredAgentRoot, { layout: 'projects' })
    return unavailablePi(configuredAgentRoot, `Pi settings.json 无法读取：${errorText(error)}`)
  }

  const sessionDir = settings.sessionDir
  if (sessionDir === undefined || sessionDir === null || sessionDir === '')
    return spec('pi', configuredAgentRoot, { layout: 'projects' })
  if (typeof sessionDir !== 'string')
    return unavailablePi(configuredAgentRoot, 'Pi settings.json 的 sessionDir 不是字符串')
  const resolved = resolvePiConfiguredSessionDir(sessionDir, context.home)
  if (!resolved)
    return unavailablePi(configuredAgentRoot, 'Pi sessionDir 是相对路径，cc-switch 无法全局枚举')
  const issue = await configuredDirectoryIssue(resolved)
  return issue
    ? unavailablePi(resolved, `Pi 会话目录不可用：${issue}`)
    : spec('pi', resolved, { layout: 'flat' })
}

function resolvePiAgentDirectory(context: PathContext, settingsOverride?: string): string {
  const agentOverride = nonemptyRaw(context.env.PI_CODING_AGENT_DIR)
  const configured = settingsOverride
    ? expandOverridePath(settingsOverride, context.home)
    : agentOverride
      ? expandOverridePath(agentOverride, context.home)
      : path.join(context.home, '.pi', 'agent')
  if (!path.isAbsolute(configured)) throw new Error('Pi agent directory must be absolute')
  return path.resolve(configured)
}

async function configuredPiRoot(
  value: string,
  home: string,
  fallback: string
): Promise<CatalogSourceSpec> {
  const root = resolvePiConfiguredSessionDir(value, home)
  if (!root) return unavailablePi(fallback, 'Pi sessionDir 是相对路径，cc-switch 无法全局枚举')
  const issue = await configuredDirectoryIssue(root)
  return issue
    ? unavailablePi(root, `Pi 会话目录不可用：${issue}`)
    : spec('pi', root, { layout: 'flat' })
}

function resolvePiConfiguredSessionDir(value: string, home: string): string | undefined {
  const expanded =
    value === '~'
      ? home
      : value.startsWith('~/') || value.startsWith('~\\')
        ? path.resolve(home, value.slice(2))
        : value
  return path.isAbsolute(expanded) ? path.resolve(expanded) : undefined
}

async function configuredDirectoryIssue(directory: string): Promise<string | undefined> {
  try {
    if (!(await stat(directory)).isDirectory()) return '配置路径不是目录'
    const handle = await opendir(directory)
    await handle.close()
    return undefined
  } catch (error) {
    return errorText(error)
  }
}

function unavailablePi(directory: string, reason: string): CatalogSourceSpec {
  return spec('pi', directory, {
    layout: 'projects',
    unavailable: true,
    note: `${reason}；不会退回默认目录`
  })
}

function resolveHermesDirectory(context: PathContext, settingsOverride?: string): string {
  if (settingsOverride) return path.resolve(expandOverridePath(settingsOverride, context.home))
  const configured = nonempty(context.env.HERMES_HOME)
  if (configured) return path.resolve(configured)
  if (context.platform === 'win32') {
    const local = nonempty(context.env.LOCALAPPDATA) ?? path.join(context.home, 'AppData', 'Local')
    return path.resolve(local, 'hermes')
  }
  return path.join(context.home, '.hermes')
}

async function resolveOmpSessionSpec(
  context: PathContext,
  settingsAgentDir: string | undefined
): Promise<CatalogSourceSpec> {
  const fallback = path.resolve(context.home, '.omp', 'agent', 'sessions')
  const configured = nonemptyRaw(context.env.PI_CODING_AGENT_SESSION_DIR)
  if (configured) {
    if (!path.isAbsolute(configured))
      return spec('omp', fallback, {
        layout: 'projects',
        unavailable: true,
        note: 'OMP 会话目录是相对路径，cc-switch 无法全局枚举；不会退回默认目录'
      })
    return spec('omp', configured, { layout: 'flat' })
  }
  if (settingsAgentDir && context.platform === 'win32')
    return spec(
      'omp',
      path.resolve(expandOverridePath(settingsAgentDir, context.home), 'sessions'),
      {
        layout: 'projects'
      }
    )
  const activeProfile = parseProfile(context.env.OMP_PROFILE ?? context.env.PI_PROFILE)
  if (activeProfile.error) return unavailableOmp(fallback, activeProfile.error)
  const inheritedProfile = parseProfile(context.env.PI_PROFILE).value
  const nativeAgent = nativeOmpAgentDirectory(context, activeProfile.value, inheritedProfile)
  const agent = settingsAgentDir ? expandOverridePath(settingsAgentDir, context.home) : nativeAgent
  const data = await resolveOmpDataDirectory(context, agent, nativeAgent, activeProfile.value)
  return spec('omp', path.resolve(data, 'sessions'), { layout: 'projects' })
}

function nativeOmpAgentDirectory(
  context: PathContext,
  activeProfile?: string,
  inheritedProfile?: string
): string {
  const configDir = nonemptyRaw(context.env.PI_CONFIG_DIR) ?? '.omp'
  const root = path.resolve(context.home, trimMainSeparators(configDir, context.platform))
  if (activeProfile) return path.join(root, 'profiles', activeProfile, 'agent')
  const rawAgent = nonemptyRaw(context.env.PI_CODING_AGENT_DIR)
  const inherited = inheritedProfile
    ? path.join(root, 'profiles', inheritedProfile, 'agent')
    : undefined
  if (rawAgent && !(path.isAbsolute(rawAgent) && samePath(rawAgent, inherited)))
    return path.resolve(rawAgent)
  return path.join(root, 'agent')
}

async function resolveOmpDataDirectory(
  context: PathContext,
  agentDirectory: string,
  defaultAgentDirectory: string,
  profile?: string
): Promise<string> {
  if (
    !['linux', 'darwin'].includes(context.platform) ||
    !samePath(agentDirectory, defaultAgentDirectory)
  )
    return agentDirectory
  const xdg = nonemptyRaw(context.env.XDG_DATA_HOME)
  if (!xdg) return agentDirectory
  const root = path.join(xdg, 'omp', ...(profile ? ['profiles', profile] : []))
  try {
    await stat(root)
    return path.resolve(root)
  } catch {
    return agentDirectory
  }
}

function parseProfile(raw: string | undefined): { value?: string; error?: string } {
  const name = raw?.trim() ?? ''
  if (!name || name === 'default') return {}
  const reserved = name.split('.')[0].toUpperCase()
  const reservedDevice =
    ['CON', 'PRN', 'AUX', 'NUL'].includes(reserved) || /^(COM|LPT)[0-9]$/.test(reserved)
  const valid =
    name.length <= OMP_PROFILE_MAX_BYTES &&
    /^[a-z0-9][a-z0-9._-]*$/.test(name) &&
    !name.endsWith('.') &&
    !reservedDevice
  return valid ? { value: name } : { error: `OMP profile 名称无效：${name}` }
}

function unavailableOmp(directory: string, reason: string): CatalogSourceSpec {
  return spec('omp', directory, {
    layout: 'projects',
    unavailable: true,
    note: `${reason}；不会退回默认目录`
  })
}

function trimMainSeparators(value: string, platform: Platform): string {
  const separator = platform === 'win32' ? '\\' : '/'
  let result = value
  while (result.startsWith(separator)) result = result.slice(separator.length)
  return result
}

function resolveMcodeDirectory(context: PathContext): string {
  const configured = nonempty(context.env.MINIMAX_DATA_DIR) ?? nonempty(context.env.MAVIS_DATA_DIR)
  return path.resolve(configured ?? path.join(context.home, '.minimax'))
}

function resolveKimiDirectory(context: PathContext): string {
  const configured = nonemptyRaw(context.env.KIMI_CODE_HOME)
  return path.resolve(configured ?? path.join(context.home, '.kimi-code'))
}

async function resolveAgySessionRoots(context: PathContext): Promise<string[]> {
  const roots = [
    path.join(context.home, '.gemini', 'antigravity-cli', 'brain'),
    path.join(context.home, '.gemini', 'antigravity', 'brain')
  ]
  const configRoot = await resolveAgyConfigRoot(context)
  const profilesRoot = path.join(configRoot, 'agy')
  try {
    const entries = await readdir(profilesRoot, { withFileTypes: true })
    for (const entry of entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    ))
      if (entry.isDirectory())
        roots.push(path.join(profilesRoot, entry.name, 'antigravity-cli', 'brain'))
  } catch {
    // CC Switch treats a missing profile root as an empty profile list.
  }
  return roots.map((root) => path.resolve(root))
}

async function resolveAgyConfigRoot(context: PathContext): Promise<string> {
  const appData = resolveAppDataDirectory(context)
  const storePath = path.join(appData, CC_SWITCH_BUNDLE_ID, 'app_paths.json')
  try {
    const store = object(JSON.parse(await readFile(storePath, 'utf8')))
    const configured = nonempty(store.app_config_dir_override)
    if (configured) {
      const root = path.resolve(expandOverridePath(configured, context.home))
      await stat(root)
      return root
    }
  } catch {
    // A missing, unreadable, or invalid store leaves CC Switch on its default path.
  }
  const defaultRoot = path.join(context.home, '.cc-switch')
  if (context.platform === 'win32' && !nonempty(context.env.CC_SWITCH_TEST_HOME)) {
    const oldHome = nonempty(context.env.HOME)
    const defaultDatabase = path.join(defaultRoot, 'cc-switch.db')
    if (oldHome && !(await exists(defaultDatabase))) {
      const legacyRoot = path.resolve(oldHome, '.cc-switch')
      if (await exists(path.join(legacyRoot, 'cc-switch.db'))) return legacyRoot
    }
  }
  return defaultRoot
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

function resolveAppDataDirectory(context: PathContext): string {
  if (context.platform === 'win32')
    return path.resolve(
      nonempty(context.env.APPDATA) ?? path.join(context.home, 'AppData', 'Roaming')
    )
  if (context.platform === 'darwin')
    return path.join(context.home, 'Library', 'Application Support')
  return path.resolve(
    nonemptyRaw(context.env.XDG_DATA_HOME) ?? path.join(context.home, '.local', 'share')
  )
}

function samePath(left: string, right?: string): boolean {
  return right !== undefined && path.normalize(left) === path.normalize(right)
}

function spec(
  kind: CleanerSourceKind,
  sourcePath: string,
  metadata: Omit<CatalogSourceSpec, 'kind' | 'path'> = {}
): CatalogSourceSpec {
  return { kind, path: path.resolve(sourcePath), ...metadata }
}

function object(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonempty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.trim() || undefined
}

function nonemptyRaw(value: string | undefined): string | undefined {
  return value !== undefined && value !== '' ? value : undefined
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
