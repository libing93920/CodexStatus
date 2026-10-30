import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { CleanerSource, CleanerSourceKind } from '../../../shared/session-cleaner.ts'
import {
  resolveCatalogSourceSpecs,
  type CatalogPathOptions,
  type CatalogSourceSpec
} from './catalog-paths.ts'

const SOURCE_DETAILS: Record<
  CleanerSourceKind,
  { name: string; note: string; capability: CleanerSource['capability'] }
> = {
  codex: {
    name: 'Codex',
    note: 'JSONL 与压缩会话；删除时同步处理状态索引',
    capability: 'sessions'
  },
  claude: {
    name: 'Claude Code',
    note: '会话及独占附属资源；时间条件仅作为清理建议',
    capability: 'sessions'
  },
  opencode: {
    name: 'OpenCode',
    note: 'SQLite 与旧 JSON；按会话身份删除关联数据',
    capability: 'sessions'
  },
  pi: { name: 'Pi', note: '原生会话与分支读取；支持会话删除', capability: 'sessions' },
  gemini: { name: 'Gemini CLI', note: '支持会话阅读、导出与删除', capability: 'sessions' },
  openclaw: { name: 'OpenClaw', note: '会话与索引同步处理', capability: 'sessions' },
  hermes: { name: 'Hermes', note: 'SQLite 与 JSONL 会话管理', capability: 'sessions' },
  grokbuild: { name: 'Grok Build', note: '按独立会话目录管理资源', capability: 'sessions' },
  omp: {
    name: 'Oh My Pi',
    note: '支持会话阅读、导出与删除',
    capability: 'sessions'
  },
  mcode: { name: 'MCode', note: '支持会话检索与阅读；删除请使用原工具', capability: 'sessions' },
  kimi: { name: 'Kimi Code', note: '支持会话检索与阅读；删除请使用原工具', capability: 'sessions' },
  agy: {
    name: 'Antigravity',
    note: '支持会话检索与阅读；删除请使用原工具',
    capability: 'sessions'
  },
  cline: { name: 'Cline', note: '会话数据库和任务文件仅只读扫描', capability: 'sessions' },
  aider: { name: 'Aider', note: '历史文件按项目聚合，保持只读', capability: 'files' },
  unknown: {
    name: '未知来源',
    note: '未知目录仅基于文件元数据只读清单；凭据与配置文件排除',
    capability: 'files'
  }
}

interface DiscoveryOptions extends CatalogPathOptions {
  registered: CleanerSource[]
}

export async function discoverSources(options: DiscoveryOptions): Promise<CleanerSource[]> {
  const env = options.env ?? process.env
  const home = path.resolve(options.home ?? nonempty(env.CC_SWITCH_TEST_HOME) ?? os.homedir())
  const pathOptions = { home, env, platform: options.platform }
  const specs = [...(await resolveCatalogSourceSpecs(pathOptions)), ...legacySourceSpecs(home, env)]
  const discovered: CleanerSource[] = []
  for (const sourceSpec of specs) {
    if (!(await sourceExists(sourceSpec))) {
      if (sourceSpec.unavailable) discovered.push(createSource(sourceSpec))
      continue
    }
    discovered.push(createSource(sourceSpec))
  }
  const manual = options.registered.filter((source) => source.origin === 'manual')
  return deduplicateSources([...manual, ...discovered])
}

export async function identifySource(targetPath: string): Promise<CleanerSource> {
  const sourcePath = path.resolve(targetPath)
  const env = process.env
  const home = path.resolve(nonempty(env.CC_SWITCH_TEST_HOME) ?? os.homedir())
  const specs = [
    ...(await resolveCatalogSourceSpecs({ home, env })),
    ...legacySourceSpecs(home, env)
  ]
  const matches = specs.filter((sourceSpec) => matchesSpec(sourcePath, sourceSpec))
  const selected = matches.sort((left, right) => right.path.length - left.path.length)[0]
  const kind = selected?.kind ?? identifyKindFromPath(sourcePath) ?? 'unknown'
  let note = selected?.note
  if (selected && matches.some((entry) => entry.kind !== selected.kind))
    note = appendNote(note, 'Pi 与 OMP 共用此会话目录；自动发现会分别登记两种来源')
  try {
    const info = await lstat(sourcePath)
    if (info.isSymbolicLink()) note = appendNote(note, '链接或 junction 不跟随；来源保持只读')
    else if (!info.isDirectory() && !info.isFile())
      note = appendNote(note, '不是普通文件或目录；来源保持只读')
  } catch (error) {
    note = appendNote(
      note,
      (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? '目录不存在；扫描时会显示错误'
        : `无法探测路径：${formatError(error)}`
    )
  }
  const source = createSource(
    {
      kind,
      path: sourcePath,
      layout: selected?.layout,
      databasePath: selected?.databasePath,
      configPath: selected?.configPath,
      unavailable: selected?.unavailable,
      note
    },
    'manual'
  )
  return source
}

function legacySourceSpecs(home: string, env: NodeJS.ProcessEnv): CatalogSourceSpec[] {
  const roots: CatalogSourceSpec[] = [
    {
      kind: 'cline',
      path: resolveConfiguredPath(env.CLINE_DATA_DIR, home, path.join(home, '.cline', 'data'))
    },
    ...resolveLegacyClineRoots(home, env).map((root) => ({ kind: 'cline' as const, path: root }))
  ]
  const aiderHistory = env.AIDER_CHAT_HISTORY_FILE?.trim()
    ? resolveConfiguredPath(env.AIDER_CHAT_HISTORY_FILE, home)
    : path.join(home, '.aider.chat.history.md')
  roots.push({ kind: 'aider', path: aiderHistory })
  const cwdHistory = path.join(process.cwd(), '.aider.chat.history.md')
  if (normalizePath(cwdHistory) !== normalizePath(aiderHistory))
    roots.push({ kind: 'aider', path: cwdHistory })
  return roots
}

async function sourceExists(source: CatalogSourceSpec): Promise<boolean> {
  if (source.unavailable) return true
  for (const candidate of [source.path, ...(source.aliases ?? [])]) {
    try {
      await lstat(candidate)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true
    }
  }
  return false
}

function matchesSpec(sourcePath: string, sourceSpec: CatalogSourceSpec): boolean {
  const roots = [sourceSpec.path, ...(sourceSpec.aliases ?? [])]
  return roots.some((root) => {
    const normalizedTarget = normalizePath(sourcePath)
    const normalizedRoot = normalizePath(root)
    return normalizedTarget === normalizedRoot || isParentRoot(normalizedRoot, normalizedTarget)
  })
}

function resolveConfiguredPath(value: string | undefined, home: string, fallback?: string): string {
  if (!value?.trim()) return fallback ?? home
  const configured = value.trim()
  if (configured === '~') return home
  if (configured.startsWith('~/') || configured.startsWith(`~${path.sep}`))
    return path.resolve(home, configured.slice(2))
  return path.resolve(configured)
}

function resolveLegacyClineRoots(home: string, env: NodeJS.ProcessEnv): string[] {
  if (process.platform === 'win32') {
    const appData = env.APPDATA?.trim() || path.join(home, 'AppData', 'Roaming')
    return ['Code', 'Code - Insiders', 'VSCodium'].map((app) =>
      path.join(appData, app, 'User', 'globalStorage', 'saoudrizwan.claude-dev')
    )
  }
  const configHome = env.XDG_CONFIG_HOME?.trim()
    ? resolveConfiguredPath(env.XDG_CONFIG_HOME, home)
    : process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : path.join(home, '.config')
  return ['Code', 'Code - Insiders', 'VSCodium'].map((app) =>
    path.join(configHome, app, 'User', 'globalStorage', 'saoudrizwan.claude-dev')
  )
}

function identifyKindFromPath(sourcePath: string): CleanerSourceKind | undefined {
  const parts = sourcePath.toLowerCase().replace(/\\/g, '/').split('/').filter(Boolean)
  const hasPair = (parent: string, child: string): boolean =>
    parts.some((part, index) => part === parent && parts[index + 1] === child)
  if (hasPair('.codex', 'sessions') || hasPair('.codex', 'archived_sessions')) return 'codex'
  if (hasPair('.claude', 'projects')) return 'claude'
  if (hasPair('.pi', 'agent') && parts.includes('sessions')) return 'pi'
  if (hasPair('.gemini', 'tmp')) return 'gemini'
  if (hasPair('.openclaw', 'agents')) return 'openclaw'
  if (parts.includes('.hermes') || hasPair('local', 'hermes')) return 'hermes'
  if (hasPair('.grok', 'sessions') || hasPair('.grok', 'archived_sessions')) return 'grokbuild'
  if (hasPair('.omp', 'agent') && parts.includes('sessions')) return 'omp'
  if (parts.includes('.minimax')) return 'mcode'
  if (hasPair('.kimi-code', 'sessions')) return 'kimi'
  if (hasPair('antigravity-cli', 'brain') || hasPair('antigravity', 'brain')) return 'agy'
  if (hasPair('.cline', 'data') || hasPair('globalstorage', 'saoudrizwan.claude-dev'))
    return 'cline'
  if (path.basename(sourcePath).toLowerCase() === '.aider.chat.history.md') return 'aider'
  if (path.basename(sourcePath).toLowerCase() === 'opencode.db') return 'opencode'
  return undefined
}

function createSource(
  sourceSpec: CatalogSourceSpec,
  origin: CleanerSource['origin'] = 'discovered'
): CleanerSource {
  const details = SOURCE_DETAILS[sourceSpec.kind]
  const sourcePath = path.resolve(sourceSpec.path)
  return {
    id: createHash('sha256')
      .update(`${sourceSpec.kind}\0${normalizePath(sourcePath)}`)
      .digest('hex')
      .slice(0, 24),
    kind: sourceSpec.kind,
    name: details.name,
    path: sourcePath,
    origin,
    capability: details.capability,
    note: sourceSpec.note ?? details.note,
    ...(sourceSpec.unavailable ? { unavailable: true } : {}),
    ...(sourceSpec.layout ? { layout: sourceSpec.layout } : {}),
    ...(sourceSpec.databasePath ? { databasePath: path.resolve(sourceSpec.databasePath) } : {}),
    ...(sourceSpec.configPath ? { configPath: path.resolve(sourceSpec.configPath) } : {})
  }
}

function deduplicateSources(sources: CleanerSource[]): CleanerSource[] {
  const deduplicated: CleanerSource[] = []
  for (const source of sources) {
    const samePath = deduplicated.filter(
      (entry) => normalizePath(entry.path) === normalizePath(source.path)
    )
    const sameKind = samePath.find((entry) => entry.kind === source.kind)
    if (sameKind) {
      if (sameKind.origin === 'discovered' && source.origin === 'manual')
        deduplicated[deduplicated.indexOf(sameKind)] = source
      continue
    }
    if (samePath.some((entry) => isPiOmpPair(entry.kind, source.kind))) {
      deduplicated.push(source)
      continue
    }
    if (samePath.some((entry) => entry.origin === 'manual')) continue
    if (samePath.some((entry) => entry.kind !== 'unknown' && source.kind === 'unknown')) continue
    if (source.kind !== 'unknown') {
      for (const entry of samePath.filter((candidate) => candidate.kind === 'unknown'))
        deduplicated.splice(deduplicated.indexOf(entry), 1)
    }
    deduplicated.push(source)
  }
  return mergeNestedSources(deduplicated)
}

function mergeNestedSources(sources: CleanerSource[]): CleanerSource[] {
  const result = [...sources]
  for (const parent of [...sources]) {
    if (!result.includes(parent)) continue
    for (const child of [...result]) {
      if (
        !result.includes(parent) ||
        !result.includes(child) ||
        parent === child ||
        parent.kind !== child.kind ||
        !isParentRoot(parent.path, child.path)
      )
        continue
      if (parent.origin === 'discovered' && child.origin === 'manual')
        result.splice(result.indexOf(parent), 1)
      else result.splice(result.indexOf(child), 1)
    }
  }
  return result
}

function isPiOmpPair(left: CleanerSourceKind, right: CleanerSourceKind): boolean {
  return (left === 'pi' && right === 'omp') || (left === 'omp' && right === 'pi')
}

function isParentRoot(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

function appendNote(base: string | undefined, next: string): string {
  return base ? `${base}；${next}` : next
}

function normalizePath(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function nonempty(value: string | undefined): string | undefined {
  return value?.trim() || undefined
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
