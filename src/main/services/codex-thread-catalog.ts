import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import readline from 'node:readline'
import type { IslandTaskSource } from '../../shared/island.ts'
import { classifyIslandTaskIdentity } from './codex-task-identity.ts'
import { buildCodexSpawnCommand } from './window-keeper-runner.ts'

const INITIALIZE_ID = 1
const LIST_ID = 2

export interface CodexThreadCatalogEntry {
  id: string
  source: IslandTaskSource
}

export async function listCodexThreadIds(
  executable: string,
  cwd: string,
  timeoutMs = 15_000
): Promise<string[]> {
  const catalog = await listCodexThreadCatalog(executable, cwd, timeoutMs)
  return catalog.map((thread) => thread.id)
}

export async function listCodexThreadCatalog(
  executable: string,
  cwd: string,
  timeoutMs = 15_000
): Promise<CodexThreadCatalogEntry[]> {
  const command = buildCodexSpawnCommand(executable, ['app-server', '--stdio'])
  const child = spawn(command.file, command.args, {
    cwd,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  try {
    return await readThreadCatalog(child, timeoutMs)
  } finally {
    child.kill()
  }
}

export function parseThreadListResult(value: unknown): string[] | undefined {
  const catalog = parseThreadCatalogResult(value)
  return catalog?.map((thread) => thread.id)
}

export function parseThreadCatalogResult(value: unknown): CodexThreadCatalogEntry[] | undefined {
  const message = getRecord(value)
  if (message?.id !== LIST_ID) return undefined
  if (message.error) throw new Error('Codex thread catalog failed')
  const data = getRecord(message.result)?.data
  if (!Array.isArray(data)) return []
  return data.flatMap((item) => {
    const record = getRecord(item)
    const id = getString(record?.id)
    if (!id) return []
    const identity = classifyIslandTaskIdentity(record?.source, record?.threadSource, {
      catalog: true,
      ephemeral: record?.ephemeral,
      path: record?.path
    })
    return [{ id, source: identity.source }]
  })
}

function readThreadCatalog(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<CodexThreadCatalogEntry[]> {
  return new Promise((resolve, reject) => {
    const lines = readline.createInterface({ input: child.stdout })
    const timeout = setTimeout(() => finish(new Error('Codex thread catalog timed out')), timeoutMs)
    let settled = false
    const finish = (error?: Error, catalog: CodexThreadCatalogEntry[] = []): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      lines.close()
      error ? reject(error) : resolve(catalog)
    }
    child.once('error', finish)
    child.once('close', (code) => {
      if (!settled) finish(new Error(`Codex thread catalog exited with code ${code ?? -1}`))
    })
    lines.on('line', (line) => handleLine(line, child, finish))
    send(child, {
      id: INITIALIZE_ID,
      method: 'initialize',
      params: {
        clientInfo: { name: 'codex-status', version: '1' },
        capabilities: { experimentalApi: false }
      }
    })
  })
}

function handleLine(
  line: string,
  child: ChildProcessWithoutNullStreams,
  finish: (error?: Error, catalog?: CodexThreadCatalogEntry[]) => void
): void {
  let message: unknown
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  const record = getRecord(message)
  if (record?.id === INITIALIZE_ID && record.result) {
    send(child, { method: 'initialized', params: {} })
    send(child, {
      id: LIST_ID,
      method: 'thread/list',
      params: { limit: 100, sortKey: 'updated_at', sortDirection: 'desc', useStateDbOnly: true }
    })
    return
  }
  try {
    const catalog = parseThreadCatalogResult(message)
    if (catalog) finish(undefined, catalog)
  } catch (error) {
    finish(error instanceof Error ? error : new Error('Codex thread catalog failed'))
  }
}

function send(child: ChildProcessWithoutNullStreams, message: unknown): void {
  child.stdin.write(`${JSON.stringify(message)}\n`)
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
