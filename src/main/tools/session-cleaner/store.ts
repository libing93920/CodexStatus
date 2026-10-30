import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { writeAtomicJson } from '../../services/activity-store.ts'
import {
  DEFAULT_CLEANER_SETTINGS,
  type CleanerRecord,
  type CleanerSettings,
  type CleanerSource
} from '../../../shared/session-cleaner.ts'

export interface CleanerConfig {
  sources: CleanerSource[]
  protectedIds: string[]
  settings: CleanerSettings
}

export function validateCleanerSettings(value: CleanerSettings): CleanerSettings {
  const limits = {
    keepRecentDays: [1, 3650],
    olderSessionDays: [1, 3650],
    logAgeDays: [1, 3650],
    alertGiB: [1, 100_000]
  }
  const result = { ...DEFAULT_CLEANER_SETTINGS }
  for (const key of Object.keys(limits) as Array<keyof CleanerSettings>) {
    const number = value?.[key]
    const [minimum, maximum] = limits[key]
    if (!Number.isInteger(number) || number < minimum || number > maximum)
      throw new Error(`策略字段 ${key} 超出允许范围`)
    result[key] = number
  }
  if (result.olderSessionDays < result.keepRecentDays || result.logAgeDays < result.keepRecentDays)
    throw new Error('候选期限不能短于近期保留天数')
  return result
}

export async function loadCleanerConfig(directory: string): Promise<CleanerConfig> {
  try {
    const value = JSON.parse(
      await readFile(path.join(directory, 'config.json'), 'utf8')
    ) as CleanerConfig
    if (
      !Array.isArray(value.sources) ||
      !Array.isArray(value.protectedIds) ||
      !value.protectedIds.every((id) => typeof id === 'string')
    )
      throw new Error('工具配置格式损坏')
    for (const source of value.sources) {
      if (
        !source.id ||
        !source.path ||
        !path.isAbsolute(source.path) ||
        typeof source.name !== 'string'
      )
        throw new Error('来源配置无效')
    }
    return {
      sources: value.sources,
      protectedIds: value.protectedIds,
      settings: validateCleanerSettings(value.settings)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { sources: [], protectedIds: [], settings: { ...DEFAULT_CLEANER_SETTINGS } }
  }
}

export async function saveCleanerConfig(directory: string, config: CleanerConfig): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeAtomicJson(path.join(directory, 'config.json'), config)
}

export async function appendCleanerRecord(directory: string, record: CleanerRecord): Promise<void> {
  await mkdir(directory, { recursive: true })
  await appendFile(path.join(directory, 'operations.jsonl'), `${JSON.stringify(record)}\n`, {
    encoding: 'utf8',
    flush: true
  })
}

export async function loadCleanerRecords(directory: string): Promise<{
  records: CleanerRecord[]
  incompleteTail: boolean
}> {
  let content: string
  try {
    content = await readFile(path.join(directory, 'operations.jsonl'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { records: [], incompleteTail: false }
    throw error
  }
  const records = new Map<string, CleanerRecord>()
  const lines = content.split('\n')
  let incompleteTail = false
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue
    let record: CleanerRecord
    try {
      record = JSON.parse(line) as CleanerRecord
    } catch (error) {
      if (index !== lines.length - 1) throw error
      incompleteTail = true
      break
    }
    if (!record.id || !record.batchId || !record.path) throw new Error('回收记录格式损坏')
    records.set(
      record.id,
      record.status === 'pending' ? { ...record, reason: '上次操作中断，结果待人工核对' } : record
    )
  }
  return {
    records: [...records.values()].sort((left, right) => right.at - left.at),
    incompleteTail
  }
}
