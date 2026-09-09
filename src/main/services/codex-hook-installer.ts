import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MANAGED_STATUS = 'CodexStatus task activity'
const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
  'Interrupt'
] as const

interface HookHandler {
  type: 'command'
  command: string
  timeout: number
  async?: boolean
  statusMessage?: string
}

interface HookGroup {
  matcher?: string
  hooks: HookHandler[]
}

interface HooksFile {
  description?: string
  hooks?: Record<string, HookGroup[]>
  [key: string]: unknown
}

export interface InstallCodexHooksOptions {
  hooksPath: string
  installDirectory: string
  sourceScriptPath: string
  executablePath: string
  descriptorPath: string
}

export function getDefaultCodexHooksPath(): string {
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex')
  return path.join(codexHome, 'hooks.json')
}

export async function installCodexHooks(options: InstallCodexHooksOptions): Promise<void> {
  const scriptPath = path.join(options.installDirectory, 'codex-status-hook.cjs')
  const launcherPath = path.join(options.installDirectory, 'codex-status-hook.cmd')
  await fs.mkdir(options.installDirectory, { recursive: true })
  await fs.copyFile(options.sourceScriptPath, scriptPath)
  await fs.writeFile(
    launcherPath,
    buildLauncher(options.executablePath, scriptPath, options.descriptorPath),
    'utf8'
  )
  const current = await readHooksFile(options.hooksPath)
  const merged = mergeCodexHooks(current, quoteCommand(launcherPath))
  await writeJsonAtomic(options.hooksPath, merged)
}

export async function uninstallCodexHooks(
  hooksPath: string,
  installDirectory: string
): Promise<void> {
  try {
    await fs.access(hooksPath)
  } catch {
    return
  }
  const current = await readHooksFile(hooksPath)
  const next = removeCodexHooks(current)
  if (JSON.stringify(next) === JSON.stringify(current)) return
  await writeJsonAtomic(hooksPath, next)
  await Promise.all([
    fs.unlink(path.join(installDirectory, 'codex-status-hook.cjs')).catch(() => undefined),
    fs.unlink(path.join(installDirectory, 'codex-status-hook.cmd')).catch(() => undefined)
  ])
}

export function mergeCodexHooks(current: HooksFile, command: string): HooksFile {
  const hooks = { ...(current.hooks ?? {}) }
  for (const eventName of HOOK_EVENTS) {
    const existing = (hooks[eventName] ?? []).filter((group) => !isManagedGroup(group))
    hooks[eventName] = [...existing, createManagedGroup(eventName, command)]
  }
  return { ...current, hooks }
}

export function removeCodexHooks(current: HooksFile): HooksFile {
  const hooks = { ...(current.hooks ?? {}) }
  for (const eventName of HOOK_EVENTS) {
    const remaining = (hooks[eventName] ?? []).filter((group) => !isManagedGroup(group))
    if (remaining.length > 0) hooks[eventName] = remaining
    else delete hooks[eventName]
  }
  return { ...current, hooks }
}

function createManagedGroup(eventName: string, command: string): HookGroup {
  const handler: HookHandler = {
    type: 'command',
    command,
    timeout: eventName === 'PermissionRequest' ? 1 : 2,
    statusMessage: MANAGED_STATUS
  }
  if (eventName !== 'PermissionRequest') handler.async = true
  const matcher = getMatcher(eventName)
  return matcher ? { matcher, hooks: [handler] } : { hooks: [handler] }
}

function getMatcher(eventName: string): string | undefined {
  if (eventName === 'SessionStart') return 'startup|resume|clear|compact'
  if (['PreToolUse', 'PostToolUse', 'PermissionRequest'].includes(eventName)) return '*'
  return undefined
}

function isManagedGroup(group: HookGroup): boolean {
  return group.hooks.some((handler) => handler.statusMessage === MANAGED_STATUS)
}

function buildLauncher(executablePath: string, scriptPath: string, descriptorPath: string): string {
  return [
    '@echo off',
    'set "ELECTRON_RUN_AS_NODE=1"',
    `${quoteCommand(executablePath)} ${quoteCommand(scriptPath)} ${quoteCommand(descriptorPath)}`,
    ''
  ].join('\r\n')
}

function quoteCommand(value: string): string {
  if (value.includes('"') || /[\r\n]/.test(value)) throw new Error('Invalid hook path')
  return `"${value}"`
}

async function readHooksFile(filePath: string): Promise<HooksFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    return parsed as HooksFile
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error('Codex hooks.json is invalid; no changes were written')
  }
}

async function writeJsonAtomic(filePath: string, value: HooksFile): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await fs.rename(temporaryPath, filePath)
}
