import type {
  CleanerItem,
  CleanerPlan,
  CleanerSourceKind,
  CleanerState
} from '../../../../shared/session-cleaner'
import type { SessionResource } from '../../../../shared/session-manager'
import type { ItemFilters } from './model'
import { groupSources, sourceGroupId } from './source-groups.ts'

const DAY_MS = 86_400_000

export interface AgentStorageGroup {
  id: string
  name: string
  kind: CleanerSourceKind
  sourceIds: string[]
  storage: {
    fileBytes: number
    databaseBytes: number
    walBytes: number
    sharedBytes: number
    otherBytes: number
    complete: boolean
  }
  resourceDataAvailable: boolean
  totalBytes: number
}

interface ItemFilterContext {
  sourceKinds: Map<string, CleanerSourceKind>
  groupedSourceIds: Set<string>
  selectedSourceIds: Set<string>
  agentKinds: Set<CleanerSourceKind>
  modelIds: Set<string>
  childSessionIds: Set<string>
  query: string
  project: string
}

function itemContext(
  data: Pick<CleanerState, 'items' | 'sources'>,
  filters: ItemFilters
): ItemFilterContext {
  return {
    sourceKinds: new Map(data.sources.map((source) => [source.id, source.kind])),
    groupedSourceIds: new Set(
      data.sources
        .filter((source) => sourceGroupId(source) === filters.sourceId)
        .map((source) => source.id)
    ),
    selectedSourceIds: new Set(filters.sourceIds ?? []),
    agentKinds: new Set(filters.agentKinds ?? []),
    modelIds: new Set(filters.modelIds ?? []),
    childSessionIds: new Set(
      data.items
        .map((item) => item.managed?.parentSessionId)
        .filter((sessionId): sessionId is string => Boolean(sessionId))
    ),
    query: filters.query.trim().toLocaleLowerCase(),
    project: filters.project?.trim().toLocaleLowerCase() ?? ''
  }
}

export function itemSize(
  item: CleanerItem,
  basis: ItemFilters['sizeBasis'] = 'session'
): number | null {
  if (basis === 'session') {
    const storage = item.managed?.storage
    if (!storage) return item.bytes
    return storage.kind === 'sqlite'
      ? (storage.logicalBytes ?? null)
      : storage.fileBytes + storage.sharedBytes
  }
  if (basis === 'logical') return item.managed?.storage.logicalBytes ?? null
  if (basis === 'file') return item.managed?.storage.fileBytes ?? null
  return item.bytes
}

function matchesSize(item: CleanerItem, filters: ItemFilters): boolean {
  const size = itemSize(item, filters.sizeBasis ?? 'session')
  if (filters.minimumBytes && (size === null || size < filters.minimumBytes)) return false
  return !(
    filters.maximumBytes !== null &&
    filters.maximumBytes !== undefined &&
    (size === null || size > filters.maximumBytes)
  )
}

function localDateStart(value: string | undefined): number | null {
  if (!value) return null
  const [year, month, day] = value.split('-').map(Number)
  if (![year, month, day].every(Number.isFinite)) return null
  return new Date(year, month - 1, day).getTime()
}

function localDateEnd(value: string | undefined): number | null {
  const start = localDateStart(value)
  if (start === null) return null
  const nextDay = new Date(start)
  nextDay.setDate(nextDay.getDate() + 1)
  return nextDay.getTime()
}

function idleDays(lastActiveAt: number, now: number): number {
  return Math.max(0, Math.floor((now - lastActiveAt) / DAY_MS))
}

function matchesDateAndIdle(item: CleanerItem, filters: ItemFilters, now: number): boolean {
  if (filters.minimumAgeDays && now - item.modifiedAt < filters.minimumAgeDays * DAY_MS)
    return false
  const createdAt = item.managed?.createdAt ?? item.createdAt
  if (filters.createdAfter || filters.createdBefore) {
    if (createdAt === undefined) return false
    const after = localDateStart(filters.createdAfter)
    const before = localDateEnd(filters.createdBefore)
    if (after !== null && createdAt < after) return false
    if (before !== null && createdAt >= before) return false
  }
  const lastActiveAt = item.managed?.lastActiveAt
  if (filters.minimumIdleDays !== null && filters.minimumIdleDays !== undefined) {
    if (lastActiveAt === undefined || idleDays(lastActiveAt, now) < filters.minimumIdleDays)
      return false
  }
  if (filters.maximumIdleDays !== null && filters.maximumIdleDays !== undefined) {
    if (lastActiveAt === undefined || idleDays(lastActiveAt, now) > filters.maximumIdleDays)
      return false
  }
  return true
}

function matchesSessionMetadata(
  item: CleanerItem,
  filters: ItemFilters,
  context: ItemFilterContext
): boolean {
  if (context.modelIds.size && !item.managed?.modelIds.some((id) => context.modelIds.has(id)))
    return false
  const count = item.managed?.messageCount
  if (filters.minimumMessageCount !== null && filters.minimumMessageCount !== undefined) {
    if (count === undefined || count < filters.minimumMessageCount) return false
  }
  if (filters.maximumMessageCount !== null && filters.maximumMessageCount !== undefined) {
    if (count === undefined || count > filters.maximumMessageCount) return false
  }
  if (filters.relationship && filters.relationship !== 'all') {
    if (sessionRelationship(item, context.childSessionIds) !== filters.relationship) return false
  }
  return true
}

function matchesSourceAndText(
  item: CleanerItem,
  filters: ItemFilters,
  context: ItemFilterContext
): boolean {
  if (filters.category !== 'all' && item.category !== filters.category) return false
  if (filters.status !== 'all' && item.status !== filters.status) return false
  if (filters.sourceId !== 'all' && !context.groupedSourceIds.has(item.sourceId)) return false
  const sourceKind = context.sourceKinds.get(item.sourceId)
  if (context.agentKinds.size && (!sourceKind || !context.agentKinds.has(sourceKind))) return false
  if (context.selectedSourceIds.size && !context.selectedSourceIds.has(item.sourceId)) return false
  const project = `${item.project ?? ''} ${item.managed?.projectDir ?? ''}`.toLocaleLowerCase()
  if (context.project && !project.includes(context.project)) return false
  if (!context.query) return true
  const searchable =
    `${item.title} ${item.path} ${item.reason} ${item.summary ?? ''} ${item.project ?? ''} ${item.managed?.projectDir ?? ''}`.toLocaleLowerCase()
  return searchable.includes(context.query)
}

function recommendationRank(item: CleanerItem): number {
  if (item.recommendation === 'old') return 0
  if (item.recommendation === 'normal') return 1
  if (item.recommendation === 'recent') return 2
  return item.status === 'candidate' ? 1 : 3
}

function compareItems(left: CleanerItem, right: CleanerItem, filters: ItemFilters): number {
  if (filters.sort === 'oldest') return left.modifiedAt - right.modifiedAt
  if (filters.sort === 'newest') return right.modifiedAt - left.modifiedAt
  if (filters.sort === 'recommended' && recommendationRank(left) !== recommendationRank(right))
    return recommendationRank(left) - recommendationRank(right)
  return (itemSize(right, filters.sizeBasis) ?? -1) - (itemSize(left, filters.sizeBasis) ?? -1)
}

export function filterItems(
  data: Pick<CleanerState, 'items' | 'sources'>,
  filters: ItemFilters,
  now = Date.now()
): CleanerItem[] {
  const context = itemContext(data, filters)
  return data.items
    .filter(
      (item) =>
        matchesSize(item, filters) &&
        (filters.deletion !== 'allowed' || canPermanentlyDelete(item)) &&
        (filters.deletion !== 'blocked' || !canPermanentlyDelete(item)) &&
        matchesDateAndIdle(item, filters, now) &&
        matchesSessionMetadata(item, filters, context) &&
        matchesSourceAndText(item, filters, context)
    )
    .sort((left, right) => compareItems(left, right, filters))
}

export function sessionRelationship(
  item: CleanerItem,
  childSessionIds: ReadonlySet<string>
): Exclude<ItemFilters['relationship'], 'all'> {
  const hasParent = Boolean(item.managed?.parentSessionId)
  const sessionId = item.managed?.sessionId ?? item.sessionId
  const hasChildren = Boolean(sessionId && childSessionIds.has(sessionId))
  if (hasParent && hasChildren) return 'both'
  if (hasParent) return 'child'
  if (hasChildren) return 'parent'
  return 'unavailable'
}

export function isItemSelectable(item: CleanerItem): boolean {
  if (item.category !== 'sessions') return item.status === 'candidate'
  const capabilities = item.managed?.capabilities
  return Boolean(
    capabilities &&
    (capabilities.read || capabilities.delete || capabilities.export || capabilities.resume)
  )
}

export function canPermanentlyDelete(item: CleanerItem): boolean {
  if (item.status === 'protected' || item.status === 'active') return false
  return item.category === 'sessions'
    ? item.managed?.capabilities.delete === true
    : item.status === 'candidate'
}

export function canExportSession(item: CleanerItem): boolean {
  return item.category === 'sessions' && item.managed?.capabilities.export === true
}

export function canResumeSession(item: CleanerItem): boolean {
  return item.category === 'sessions' && item.managed?.capabilities.resume === true
}

export function getDeletableIds(items: CleanerItem[], selectedIds?: string[]): string[] {
  const selected = selectedIds ? new Set(selectedIds) : null
  return items
    .filter((item) => canPermanentlyDelete(item) && (!selected || selected.has(item.id)))
    .map((item) => item.id)
}

export function getExportableIds(items: CleanerItem[], selectedIds?: string[]): string[] {
  const selected = selectedIds ? new Set(selectedIds) : null
  return items
    .filter((item) => canExportSession(item) && (!selected || selected.has(item.id)))
    .map((item) => item.id)
}

function uniqueResources(resources: SessionResource[]): SessionResource[] {
  return [...new Map(resources.map((resource) => [resource.id, resource])).values()]
}

export function getUniqueResourceBytes(resources: SessionResource[] | undefined): number | null {
  if (!resources) return null
  return uniqueResources(resources).reduce((total, resource) => total + resource.bytes, 0)
}

export function getPlanWarnings(plan: Pick<CleanerPlan, 'warnings' | 'previews'>): string[] {
  return [
    ...new Set([
      ...(plan.warnings ?? []),
      ...(plan.previews ?? []).flatMap((preview) => preview.warnings)
    ])
  ]
}

export function groupAgentStorage(
  data: Pick<CleanerState, 'sources' | 'items' | 'storage' | 'resources'>
): AgentStorageGroup[] {
  const summaryBySource = new Map(
    (data.storage ?? []).map((summary) => [summary.sourceId, summary])
  )
  const resources = uniqueResources(data.resources ?? [])
  return groupSources(data).map((group) => {
    const summaries = group.sourceIds.map((id) => summaryBySource.get(id))
    const sourceIds = new Set(group.sourceIds)
    const groupResources = data.resources
      ? resources.filter((resource) => {
          const referencedSources = resource.sourceIds ?? [resource.sourceId]
          return referencedSources.some((sourceId) => sourceIds.has(sourceId))
        })
      : []
    const sumResources = (matches: (resource: SessionResource) => boolean = () => true): number =>
      groupResources.reduce(
        (total, resource) => total + (matches(resource) ? resource.bytes : 0),
        0
      )
    const storage = {
      fileBytes: sumResources(),
      databaseBytes: sumResources((resource) => resource.kind === 'database'),
      walBytes: sumResources((resource) => resource.kind === 'wal'),
      sharedBytes: sumResources((resource) => resource.shared),
      otherBytes: sumResources(
        (resource) => resource.kind !== 'database' && resource.kind !== 'wal'
      ),
      complete:
        data.resources !== undefined &&
        summaries.length === group.sourceIds.length &&
        summaries.every((entry) => entry?.complete)
    }
    return {
      id: group.id,
      name: group.name,
      kind: group.kind,
      sourceIds: group.sourceIds,
      storage,
      resourceDataAvailable: data.resources !== undefined,
      totalBytes: storage.fileBytes
    }
  })
}
