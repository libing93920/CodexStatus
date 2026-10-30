import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { UsageEvent } from './agents.ts'
import type { ParsedFile } from './codex-session-parser.ts'

const DATABASE_NAME = 'retained-usage.sqlite'
const DATABASE_VERSION = 1
let retentionDirectory: string | undefined

export type RetainedUsageAgent = 'codex' | 'claude' | 'opencode'

export interface RetainedUsageSource {
  key: string
  agent: RetainedUsageAgent
  path: string
  threadId?: string
  sessionId?: string
  parsed?: ParsedFile
  events?: UsageEvent[]
}

export function configureUsageRetention(directory: string): void {
  retentionDirectory = directory
}

export function getUsageRetentionDirectory(): string | undefined {
  return retentionDirectory
}

async function openDatabase(
  directory: string,
  readOnly: boolean
): Promise<DatabaseSync | undefined> {
  const filePath = path.join(directory, DATABASE_NAME)
  if (readOnly) {
    try {
      await fs.access(filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  } else {
    await fs.mkdir(directory, { recursive: true })
  }
  const { DatabaseSync } = await import('node:sqlite')
  const database = new DatabaseSync(filePath, { readOnly })
  database.exec('PRAGMA busy_timeout = 5000')
  if (!readOnly) {
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS retained_sources (
        key TEXT PRIMARY KEY, agent TEXT NOT NULL, version INTEGER NOT NULL,
        payload TEXT NOT NULL, recorded_at INTEGER NOT NULL
      );
    `)
  }
  return database
}

export async function retainUsageSource(
  directory: string,
  source: RetainedUsageSource
): Promise<void> {
  const database = await openDatabase(directory, false)
  if (!database) throw new Error('无法打开用量留存库')
  try {
    database
      .prepare(
        `INSERT INTO retained_sources(key, agent, version, payload, recorded_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,
           version=excluded.version, recorded_at=excluded.recorded_at`
      )
      .run(source.key, source.agent, DATABASE_VERSION, JSON.stringify(source), Date.now())
  } finally {
    database.close()
  }
}

export async function readRetainedUsage(
  agent: RetainedUsageAgent,
  directory = retentionDirectory
): Promise<RetainedUsageSource[]> {
  if (!directory) return []
  const database = await openDatabase(directory, true)
  if (!database) return []
  try {
    const sources: RetainedUsageSource[] = []
    for (const row of database
      .prepare('SELECT version, payload FROM retained_sources WHERE agent=?')
      .iterate(agent)) {
      if (row.version !== DATABASE_VERSION) throw new Error('用量留存格式版本不受支持')
      const source = JSON.parse(String(row.payload)) as RetainedUsageSource
      if (
        source.agent !== agent ||
        !source.key ||
        (source.agent === 'opencode' && (!source.sessionId || !source.events))
      )
        throw new Error('用量留存内容损坏')
      sources.push(source)
      // 分批让出主进程，历史摘要读取不能长时间阻塞窗口事件。
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    return sources
  } finally {
    database.close()
  }
}

export function mergeRetainedCodex(
  live: Array<{ threadId: string | undefined; file: ParsedFile }>,
  retained: RetainedUsageSource[]
): Array<{ threadId: string | undefined; file: ParsedFile }> {
  const liveIds = new Set(live.map((entry) => entry.threadId))
  const archived = new Map<string, ParsedFile>()
  for (const source of retained) {
    if (
      source.agent !== 'codex' ||
      !source.parsed ||
      !source.threadId ||
      liveIds.has(source.threadId)
    )
      continue
    const previous = archived.get(source.threadId)
    if (!previous || source.parsed.events.length > previous.events.length)
      archived.set(source.threadId, source.parsed)
  }
  return live.concat([...archived].map(([threadId, file]) => ({ threadId, file })))
}

export function mergeRetainedOpenCode(
  live: UsageEvent[],
  retained: UsageEvent[],
  cutoffMs: number
): UsageEvent[] {
  if (!Number.isFinite(cutoffMs)) throw new Error('OpenCode 用量窗口无效')
  const merged: UsageEvent[] = []
  const identities = new Set<string>()
  const append = (event: UsageEvent): void => {
    if (event.ts < cutoffMs) return
    if (event.messageId) {
      if (identities.has(event.messageId)) return
      identities.add(event.messageId)
    }
    merged.push(event)
  }
  retained.forEach(append)
  live.forEach(append)
  return merged
}
