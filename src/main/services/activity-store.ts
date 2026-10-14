import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  ACTIVITY_MAX_MESSAGE_BYTES,
  validateActivityDay,
  type ActivityDay
} from '../../shared/activity.ts'
import { isRetainedWorkDate, isWorkDate, recentWorkDates } from '../../shared/work-time.ts'

const DAY_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})_[a-f0-9]{12}_[0-9a-f-]{36}\.json$/i

export interface StoredActivityDay {
  day: ActivityDay
  receivedAt: number
}

export async function writeAtomicJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, 'utf8')
  await fs.rename(temporary, filePath)
}

function dayKey(day: Pick<ActivityDay, 'team' | 'peerId' | 'date'>): string {
  return `${day.date}_${day.team}_${day.peerId}`
}

function cleanDay(day: ActivityDay): ActivityDay {
  return {
    version: day.version,
    team: day.team,
    peerId: day.peerId,
    nickname: day.nickname,
    date: day.date,
    revision: day.revision,
    calendarVersion: day.calendarVersion,
    observedAt: day.observedAt,
    firstInputAt: day.firstInputAt,
    lastInputAt: day.lastInputAt,
    incomplete: day.incomplete,
    intervals: day.intervals.map(({ start, end, kind }) => ({ start, end, kind }))
  }
}

export class ActivityStore {
  private readonly directory: string
  private readonly now: () => number
  private readonly records = new Map<string, StoredActivityDay>()
  private readonly persistedRevisions = new Map<string, number>()
  private queue: Promise<void> = Promise.resolve()
  readonly issues = new Set<string>()

  constructor(directory: string, now = Date.now) {
    this.directory = directory
    this.now = now
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true })
    await this.prune()
    const files = await fs.readdir(this.directory, { withFileTypes: true })
    for (const file of files) {
      if (!file.isFile() || !DAY_FILE_PATTERN.test(file.name)) continue
      await this.readDay(file.name)
    }
  }

  get(team: string, peerId: string, date: string): StoredActivityDay | undefined {
    const stored = this.records.get(dayKey({ team, peerId, date }))
    return stored ? structuredClone(stored) : undefined
  }

  getRevision(team: string, peerId: string, date: string): number {
    return this.records.get(dayKey({ team, peerId, date }))?.day.revision ?? 0
  }

  list(team: string, date: string): StoredActivityDay[] {
    if (!isRetainedWorkDate(date, this.now())) return []
    return [...this.records.values()]
      .filter((record) => record.day.team === team && record.day.date === date)
      .map((record) => structuredClone(record))
  }

  stage(day: ActivityDay): void {
    if (!validateActivityDay(day, this.now())) throw new Error('活动记录无效，未写入')
    const clean = cleanDay(day)
    this.records.set(dayKey(clean), { day: clean, receivedAt: this.now() })
  }

  save(day: ActivityDay): Promise<'saved' | 'unchanged' | 'stale'> {
    if (!validateActivityDay(day, this.now()))
      return Promise.reject(new Error('活动记录无效，未写入'))
    const clean = cleanDay(day)
    const task = this.queue.then(() => this.writeDay(clean))
    this.queue = task.then(
      () => undefined,
      (error: unknown) => {
        this.issues.add(
          `活动记录保存失败：${error instanceof Error ? error.message : String(error)}`
        )
      }
    )
    return task
  }

  async flush(): Promise<void> {
    await this.queue
  }

  async prune(): Promise<void> {
    const oldest = recentWorkDates(this.now()).at(-1)!
    const files = await fs.readdir(this.directory, { withFileTypes: true })
    for (const file of files) {
      const match = DAY_FILE_PATTERN.exec(file.name)
      if (!file.isFile() || !match || !isWorkDate(match[1]) || match[1] >= oldest) continue
      await fs.unlink(path.join(this.directory, file.name))
    }
    for (const [key, record] of this.records) {
      if (record.day.date >= oldest) continue
      this.records.delete(key)
      this.persistedRevisions.delete(key)
    }
  }

  private async readDay(fileName: string): Promise<void> {
    try {
      const filePath = path.join(this.directory, fileName)
      if ((await fs.stat(filePath)).size > ACTIVITY_MAX_MESSAGE_BYTES)
        throw new Error('文件超出大小限制')
      const stored = JSON.parse(await fs.readFile(filePath, 'utf8')) as StoredActivityDay
      if (!validateActivityDay(stored.day, this.now()) || `${dayKey(stored.day)}.json` !== fileName)
        throw new Error('日期、身份或区间无效')
      if (!Number.isFinite(stored.receivedAt) || stored.receivedAt < 0)
        throw new Error('同步时间无效')
      const day = cleanDay(stored.day)
      this.records.set(dayKey(day), { day, receivedAt: stored.receivedAt })
      this.persistedRevisions.set(dayKey(day), day.revision)
    } catch (error) {
      this.issues.add(
        `活动记录读取失败（${fileName}）：${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  private async writeDay(day: ActivityDay): Promise<'saved' | 'unchanged' | 'stale'> {
    const key = dayKey(day)
    const existing = this.records.get(key)?.day
    if (existing && existing.revision > day.revision) return 'stale'
    if (existing?.revision === day.revision) {
      if (JSON.stringify(existing) !== JSON.stringify(day)) throw new Error('相同日报版本内容冲突')
      if (this.persistedRevisions.get(key) === day.revision) return 'unchanged'
    }
    const stored = { day, receivedAt: this.now() }
    await writeAtomicJson(path.join(this.directory, `${key}.json`), stored)
    // 写入期间本机可能产生更新的观测，不让旧检查点覆盖内存中新版本。
    if ((this.records.get(key)?.day.revision ?? 0) <= day.revision) this.records.set(key, stored)
    this.persistedRevisions.set(key, day.revision)
    return 'saved'
  }
}
