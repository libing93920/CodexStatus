import { randomUUID } from 'node:crypto'
import { stat, statfs } from 'node:fs/promises'
import path from 'node:path'
import type {
  CleanerItem,
  CleanerPlan,
  CleanerRecord,
  CleanerScanResult,
  CleanerSettings,
  CleanerSource,
  CleanerState,
  CleanerProgress
} from '../../../shared/session-cleaner.ts'
import type {
  AgentStorageSummary,
  SessionDetails,
  SessionMutationPreview,
  SessionMutationResult,
  SessionResource
} from '../../../shared/session-manager.ts'
import { CleanerWorkerClient } from './worker-client.ts'
import {
  appendCleanerRecord,
  loadCleanerConfig,
  loadCleanerRecords,
  saveCleanerConfig,
  validateCleanerSettings,
  type CleanerConfig
} from './store.ts'

const PLAN_LIFETIME_MS = 5 * 60_000
const VACUUM_FREE_SPACE_FACTOR = 2
const SQLITE_FILE = /\.(db|sqlite|sqlite3)$/i

export interface CleanerControllerOptions {
  directory: string
  retentionDirectory: string
  activeThreadIds: () => string[]
  onProgress: (progress: CleanerProgress) => void
  coreExecutable: string
}

export class CleanerController {
  private config!: CleanerConfig
  private items: CleanerItem[] = []
  private records: CleanerRecord[] = []
  private issues: CleanerState['issues'] = []
  private scannedAt: number | undefined
  private scanning = false
  private recycling = false
  private stopped = false
  private recordLogIncomplete = false
  private operationCancelled = false
  private resources: SessionResource[] = []
  private storage: AgentStorageSummary[] = []
  private readonly plans = new Map<string, CleanerPlan>()
  private readonly worker: CleanerWorkerClient

  constructor(private readonly options: CleanerControllerOptions) {
    this.worker = new CleanerWorkerClient(options.onProgress, options.coreExecutable)
  }

  async initialize(): Promise<void> {
    this.config = await loadCleanerConfig(this.options.directory)
    const sources = await this.worker.request<CleanerSource[]>({
      method: 'discover',
      sources: this.config.sources
    })
    await this.changeConfig({ ...this.config, sources })
    const stored = await loadCleanerRecords(this.options.directory)
    this.records = stored.records
    this.recordLogIncomplete = stored.incompleteTail
  }

  async getState(): Promise<CleanerState> {
    const roots = new Set(this.config.sources.map((source) => path.parse(source.path).root))
    const disks: CleanerState['disks'] = []
    for (const root of roots) {
      try {
        const info = await statfs(root)
        disks.push({
          path: root,
          available: info.bavail * info.bsize,
          total: info.blocks * info.bsize
        })
      } catch {
        /* 失效磁盘由来源扫描报告，不把未知容量显示成零。 */
      }
    }
    return structuredClone({
      sources: this.config.sources,
      items: this.applyProtection(this.items),
      issues: this.recordLogIncomplete
        ? [
            ...this.issues,
            {
              path: this.options.directory,
              message: '操作日志不完整，已保留可读记录；当前禁止继续删除，请先核对结果'
            }
          ]
        : this.issues,
      settings: this.config.settings,
      records: this.records,
      scannedAt: this.scannedAt,
      scanning: this.scanning,
      recycling: this.recycling,
      deletionMode: 'permanent',
      resources: this.resources,
      storage: this.storage,
      disks
    })
  }

  async discover(): Promise<CleanerState> {
    this.requireIdle()
    const sources = await this.worker.request<CleanerSource[]>({
      method: 'discover',
      sources: this.config.sources
    })
    await this.changeConfig({ ...this.config, sources })
    return this.getState()
  }

  async importSource(directory: string): Promise<CleanerState> {
    this.requireIdle()
    const source = await this.worker.request<CleanerSource>({ method: 'identify', path: directory })
    if (this.config.sources.some((entry) => entry.id === source.id))
      throw new Error('此目录已经登记')
    await this.changeConfig({ ...this.config, sources: [...this.config.sources, source] })
    return this.getState()
  }

  async removeSource(id: string): Promise<CleanerState> {
    this.requireIdle()
    await this.changeConfig({
      ...this.config,
      sources: this.config.sources.filter((source) => source.id !== id)
    })
    // 重叠来源共享同一资源清单；移除后重新扫描，避免继续展示过期归属。
    this.items = []
    this.resources = []
    this.storage = []
    this.scannedAt = undefined
    return this.getState()
  }

  async scan(): Promise<CleanerState> {
    this.requireIdle()
    this.scanning = true
    this.plans.clear()
    try {
      const result = await this.worker.request<CleanerScanResult>({
        method: 'scan',
        sources: this.config.sources,
        settings: this.config.settings,
        protectedIds: this.config.protectedIds
      })
      this.items = result.items
      this.resources = result.resources ?? []
      this.storage = result.storage ?? []
      this.issues = result.issues
      if (result.cancelled)
        this.issues.push({ path: '', message: '扫描已取消，当前仅显示部分结果' })
      this.scannedAt = result.scannedAt
    } finally {
      this.scanning = false
    }
    return this.getState()
  }

  async cancelScan(): Promise<void> {
    if (this.scanning) await this.worker.request({ method: 'cancel' })
  }

  async protect(ids: string[], protectedValue: boolean): Promise<CleanerState> {
    this.requireIdle()
    this.selectedItems(ids)
    const protectedIds = new Set(this.config.protectedIds)
    for (const id of ids) {
      if (protectedValue) protectedIds.add(id)
      else protectedIds.delete(id)
    }
    await this.changeConfig({ ...this.config, protectedIds: [...protectedIds] })
    // 能力独立于保护标记，解除保护不会丢失已扫描的来源能力。
    for (const item of this.items) {
      if (item.managed && item.status === 'protected') {
        item.status = item.managed?.capabilities.delete ? 'candidate' : 'read-only'
        item.reason = item.managed?.capabilities.deleteReason ?? '来源支持删除'
      }
    }
    return this.getState()
  }

  async saveSettings(settings: CleanerSettings): Promise<CleanerState> {
    this.requireIdle()
    await this.changeConfig({ ...this.config, settings: validateCleanerSettings(settings) })
    this.items = []
    this.resources = []
    this.storage = []
    this.scannedAt = undefined
    return this.getState()
  }

  async review(ids: string[]): Promise<CleanerPlan> {
    this.requireIdle()
    const items = this.selectedItems(ids)
    const plan: CleanerPlan = {
      id: randomUUID(),
      createdAt: Date.now(),
      items: [],
      totalBytes: 0,
      excluded: [],
      previews: [],
      warnings: [],
      deletionMode: 'permanent'
    }
    const selectedFiles = new Set<string>()
    const selectedSessions = new Set<string>()
    for (const item of items) {
      try {
        const source = this.sourceFor(item)
        this.assertDeletable(item)
        const preview = await this.worker.request<SessionMutationPreview>({
          method: 'inspect',
          source,
          item
        })
        const identity = item.managed!.sourcePath
        if (
          selectedSessions.has(identity) ||
          preview.files.some((file) => selectedFiles.has(normalizedPath(file)))
        )
          throw new Error('此会话资源已由所选另一条目包含，避免重复删除和重复计算大小')
        selectedSessions.add(identity)
        for (const file of preview.files) selectedFiles.add(normalizedPath(file))
        preview.logicalBytes = item.managed?.storage.logicalBytes
        plan.items.push(structuredClone(item))
        plan.previews!.push(preview)
        plan.totalBytes += preview.fileBytes
        if (preview.logicalBytes !== undefined)
          plan.logicalBytes = (plan.logicalBytes ?? 0) + preview.logicalBytes
        plan.warnings!.push(...preview.warnings)
      } catch (error) {
        plan.excluded.push({ id: item.id, reason: errorMessage(error) })
      }
    }
    if (
      plan.logicalBytes !== undefined &&
      plan.previews!.some((preview) => preview.logicalBytes === undefined)
    )
      plan.warnings!.push('部分会话没有可测量的逻辑大小，逻辑汇总仅包含已知部分')
    this.plans.clear()
    this.plans.set(plan.id, structuredClone(plan))
    return plan
  }

  async recycle(planId: string): Promise<CleanerState> {
    this.requireIdle()
    if (this.recordLogIncomplete) throw new Error('操作日志不完整，请先核对操作结果')
    const plan = this.plans.get(planId)
    this.plans.clear()
    if (!plan || !plan.items.length || Date.now() - plan.createdAt > PLAN_LIFETIME_MS)
      throw new Error('审核已失效，请重新生成预览')
    this.recycling = true
    this.operationCancelled = false
    try {
      for (const [index, item] of plan.items.entries()) {
        if (this.stopped || this.operationCancelled) break
        await this.recycleItem(item, plan.id)
        this.options.onProgress({
          phase: 'delete',
          visited: index + 1,
          bytes: 0,
          completed: index + 1,
          total: plan.items.length
        })
      }
    } finally {
      this.recycling = false
    }
    return this.stopped ? this.getState() : this.scan()
  }

  async details(id: string): Promise<string> {
    const [item] = this.selectedItems([id])
    return this.worker.request({ method: 'details', source: this.sourceFor(item), item })
  }

  async transcript(id: string): Promise<SessionDetails> {
    const [item] = this.selectedItems([id])
    const result = await this.worker.request<SessionDetails>({
      method: 'transcript',
      source: this.sourceFor(item),
      item
    })
    const resourceIds = new Set(item.managed?.resourceIds)
    return {
      ...result,
      resources: this.resources.filter((resource) => resourceIds.has(resource.id))
    }
  }

  async blockContent(id: string, contentRef: unknown, offset?: number): Promise<unknown> {
    if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0))
      throw new Error('正文分页位置无效')
    const [item] = this.selectedItems([id])
    return this.worker.request({
      method: 'block',
      source: this.sourceFor(item),
      item,
      contentRef,
      offset
    })
  }

  async exportContent(id: string): Promise<{ title: string; markdown: string }> {
    const [item] = this.selectedItems([id])
    const details = await this.transcript(id)
    const messages = details.messages.map((message) => `## ${message.role}\n\n${message.content}`)
    return { title: item.title, markdown: `# ${item.title}\n\n${messages.join('\n\n')}\n` }
  }

  selectedForExport(ids: string[]): CleanerItem[] {
    this.requireIdle()
    const items = this.selectedItems(ids)
    if (items.some((item) => !item.managed?.capabilities.export))
      throw new Error('所选内容包含不能导出的条目，请调整选择')
    return items
  }

  async resumeTarget(id: string): Promise<{ source: CleanerSource; item: CleanerItem }> {
    this.requireIdle()
    const [item] = this.selectedItems([id])
    if (!item.managed?.capabilities.resume) throw new Error('此来源不支持续聊')
    return { source: this.sourceFor(item), item }
  }

  cancelOperation(): void {
    this.operationCancelled = true
  }

  isOperationCancelled(): boolean {
    return this.stopped || this.operationCancelled
  }

  beginExport(): void {
    this.requireIdle()
    this.operationCancelled = false
    this.recycling = true
  }

  finishExport(): void {
    this.recycling = false
  }

  reportProgress(progress: CleanerProgress): void {
    this.options.onProgress(progress)
  }

  async recordOperation(value: Omit<CleanerRecord, 'id' | 'at'>): Promise<void> {
    const record: CleanerRecord = { ...value, id: randomUUID(), at: Date.now() }
    try {
      await appendCleanerRecord(this.options.directory, record)
      this.records.unshift(record)
    } catch (error) {
      this.recordLogIncomplete = true
      throw error
    }
  }

  async compactDatabase(sourceId: string): Promise<CleanerState> {
    this.requireIdle()
    const source = this.config.sources.find((entry) => entry.id === sourceId)
    if (!source || source.kind !== 'opencode') throw new Error('此来源不支持数据库整理')
    const database =
      source.databasePath ??
      (SQLITE_FILE.test(source.path) ? source.path : path.join(source.path, 'opencode.db'))
    const [information, disk] = await Promise.all([stat(database), statfs(database)])
    const before = await databaseFileBytes(database)
    if (disk.bavail * disk.bsize < Math.max(information.size, before) * VACUUM_FREE_SPACE_FACTOR)
      throw new Error('可用空间不足以安全整理数据库，请先释放磁盘空间')
    this.recycling = true
    try {
      this.reportProgress({ phase: 'compact', visited: 0, bytes: 0 })
      const result = await this.worker.request<{ warning?: string }>({ method: 'compact', source })
      const after = await databaseFileBytes(database)
      await this.recordOperation({
        batchId: randomUUID(),
        sourceId,
        title: '整理 OpenCode 数据库',
        path: database,
        bytes: before,
        fileBytesAfter: after,
        status: 'compacted',
        reason: result.warning
      })
    } finally {
      this.recycling = false
    }
    return this.scan()
  }

  itemPath(id: string): string {
    return this.selectedItems([id])[0].path
  }

  stop(): void {
    this.stopped = true
    this.plans.clear()
    if (!this.recycling) this.worker.dispose()
  }

  isRecycling(): boolean {
    return this.recycling
  }

  dispose(): void {
    this.worker.dispose()
  }

  private async recycleItem(item: CleanerItem, batchId: string): Promise<void> {
    const record: CleanerRecord = {
      id: randomUUID(),
      batchId,
      sourceId: item.sourceId,
      title: item.title,
      path: item.path,
      bytes: item.managed?.storage.fileBytes ?? 0,
      logicalBytes: item.managed?.storage.logicalBytes,
      at: Date.now(),
      status: 'pending'
    }
    await appendCleanerRecord(this.options.directory, record)
    this.records.unshift(record)
    let deleteAttempted = false
    try {
      const [current] = this.selectedItems([item.id])
      this.assertDeletable(current)
      const source = this.sourceFor(item)
      await this.worker.request({
        method: 'prepare',
        source,
        item,
        directory: this.options.retentionDirectory
      })
      this.assertDeletable(this.selectedItems([item.id])[0])
      if (this.operationCancelled || this.stopped) throw new Error('任务已取消，未执行删除')
      deleteAttempted = true
      const result = await this.worker.request<SessionMutationResult>({
        method: 'delete',
        source,
        item
      })
      if (!result.deleted) throw new Error(result.reason || '来源未确认删除成功')
      record.status = 'deleted'
      record.bytes = result.fileBytesBefore
      record.fileBytesAfter = result.fileBytesAfter
      record.reason = result.reason
      this.items = this.items.filter((entry) => entry.id !== item.id)
    } catch (error) {
      record.status = deleteAttempted ? 'failed' : 'skipped'
      record.reason = deleteAttempted
        ? `${errorMessage(error)}；请按刷新结果核对，未确认释放空间`
        : errorMessage(error)
    }
    try {
      await appendCleanerRecord(this.options.directory, record)
    } catch (error) {
      record.status = 'pending'
      record.reason = '操作结果未能持久化，请重新扫描并核对原工具'
      this.recordLogIncomplete = true
      throw error
    }
  }

  private requireIdle(): void {
    if (this.stopped || this.scanning || this.recycling)
      throw new Error('工具任务执行中，请稍后操作')
  }

  private selectedItems(ids: string[]): CleanerItem[] {
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > this.items.length ||
      ids.some((id) => typeof id !== 'string') ||
      new Set(ids).size !== ids.length
    )
      throw new Error('选择清单无效')
    const index = new Map(this.applyProtection(this.items).map((item) => [item.id, item]))
    return ids.map((id) => {
      const item = index.get(id)
      if (!item) throw new Error('条目已失效，请刷新')
      return item
    })
  }

  private sourceFor(item: CleanerItem): CleanerSource {
    const source = this.config.sources.find((entry) => entry.id === item.sourceId)
    if (!source) throw new Error('来源已经移除')
    return source
  }

  private assertDeletable(item: CleanerItem): void {
    if (item.status === 'active' || item.status === 'protected') throw new Error(item.reason)
    if (!item.managed?.capabilities.delete)
      throw new Error(item.managed?.capabilities.deleteReason || '此来源没有会话删除实现')
  }

  private applyProtection(items: CleanerItem[]): CleanerItem[] {
    const active = new Set(this.options.activeThreadIds())
    const protectedIds = new Set(this.config.protectedIds)
    const protectedPaths = new Set(
      items.filter((item) => protectedIds.has(item.id)).map(protectionIdentity)
    )
    return items.map((item) => {
      if (item.sessionId && active.has(item.sessionId))
        return { ...item, status: 'active', reason: '宿主正在使用此会话' }
      if (protectedIds.has(item.id) || protectedPaths.has(protectionIdentity(item)))
        return { ...item, status: 'protected', reason: '用户已保护' }
      return item
    })
  }

  private async changeConfig(config: CleanerConfig): Promise<void> {
    await saveCleanerConfig(this.options.directory, config)
    this.config = config
    this.plans.clear()
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败'
}

function normalizedPath(value: string): string {
  const absolute = path.resolve(value)
  return process.platform === 'win32' ? path.toNamespacedPath(absolute).toLowerCase() : absolute
}

function protectionIdentity(item: CleanerItem): string {
  const reference = item.managed?.sourcePath
  return reference?.startsWith('sqlite:') ? reference : normalizedPath(reference ?? item.path)
}

async function databaseFileBytes(database: string): Promise<number> {
  const sizes = await Promise.all(
    [database, `${database}-wal`, `${database}-shm`].map(async (file) => {
      try {
        return (await stat(file)).size
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
        throw error
      }
    })
  )
  return sizes.reduce((total, size) => total + size, 0)
}
