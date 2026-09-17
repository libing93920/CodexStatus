import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { logDiag } from './diag-log.ts'

const MANAGED_STATUS = 'CodexStatus task activity'
// 保留 PreToolUse 用于清除审批状态;PostToolUse 每次工具完成都 spawn 进程,由 IPC 状态流兜底
const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'Stop',
  'Interrupt'
] as const

interface HookHandler {
  type: 'command'
  command: string
  commandWindows?: string
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
  // 先清后装:移除旧版本写入的全部 managed 组(含 PreToolUse/PostToolUse 等已缩事件),
  // 再按当前事件表安装 —— 修复存量用户升级后旧事件组永不清理的问题
  const merged = mergeCodexHooks(
    removeCodexHooks(current),
    quoteCommand(launcherPath),
    buildWindowsHookCommand(launcherPath)
  )
  await writeJsonAtomic(options.hooksPath, merged)
  logDiag(
    `hook installed hooksPath=${JSON.stringify(options.hooksPath)} ` +
      `descriptor=${JSON.stringify(options.descriptorPath)}`
  )
}

export async function uninstallCodexHooks(
  hooksPath: string,
  installDirectory: string
): Promise<void> {
  let current: HooksFile = {}
  let hooksFileExists = true
  try {
    await fs.access(hooksPath)
    current = await readHooksFile(hooksPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    hooksFileExists = false
  }
  const next = removeCodexHooks(current)
  if (hooksFileExists && JSON.stringify(next) !== JSON.stringify(current)) {
    await writeJsonAtomic(hooksPath, next)
  }
  await Promise.all([
    fs.unlink(path.join(installDirectory, 'codex-status-hook.cjs')).catch(() => undefined),
    fs.unlink(path.join(installDirectory, 'codex-status-hook.cmd')).catch(() => undefined)
  ])
}

export function mergeCodexHooks(
  current: HooksFile,
  command: string,
  commandWindows?: string
): HooksFile {
  const hooks = { ...(current.hooks ?? {}) }
  for (const eventName of HOOK_EVENTS) {
    const existing = (hooks[eventName] ?? []).filter((group) => !isManagedGroup(group))
    hooks[eventName] = [...existing, createManagedGroup(eventName, command, commandWindows)]
  }
  return { ...current, hooks }
}

// 历史版本曾注册的事件(含工具级事件):卸载/迁移时需一并清理,
// 否则缩减事件表后,旧版本写入的 managed 组会残留在用户 hooks.json
const LEGACY_MANAGED_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
  'Interrupt'
] as const

export function removeCodexHooks(current: HooksFile): HooksFile {
  const hooks = { ...(current.hooks ?? {}) }
  for (const eventName of LEGACY_MANAGED_EVENTS) {
    const remaining = (hooks[eventName] ?? []).filter((group) => !isManagedGroup(group))
    if (remaining.length > 0) hooks[eventName] = remaining
    else delete hooks[eventName]
  }
  return { ...current, hooks }
}

function createManagedGroup(
  eventName: string,
  command: string,
  commandWindows?: string
): HookGroup {
  const handler: HookHandler = {
    type: 'command',
    command,
    timeout: eventName === 'PermissionRequest' ? 1 : 2,
    statusMessage: MANAGED_STATUS
  }
  if (commandWindows !== undefined) handler.commandWindows = commandWindows
  if (eventName !== 'PermissionRequest') handler.async = true
  const matcher = getMatcher(eventName)
  return matcher ? { matcher, hooks: [handler] } : { hooks: [handler] }
}

function getMatcher(eventName: string): string | undefined {
  if (eventName === 'SessionStart') return 'startup|resume|clear|compact'
  if (eventName === 'PreToolUse' || eventName === 'PermissionRequest') return '*'
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

function buildWindowsHookCommand(launcherPath: string): string {
  // cmd.exe /C 需要双层引号，才能保留含空格路径的边界。
  return `cmd.exe /d /c "${quoteCommand(launcherPath)}"`
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
