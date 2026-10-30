import type { CleanerState } from '../../../../shared/session-cleaner'
import { canPermanentlyDelete, getUniqueResourceBytes, groupAgentStorage } from './manager-model'
import type { AgentStorageGroup } from './manager-model'
import { sourceKindLabel } from './model'
import { groupSources } from './source-groups'
import type { SourceGroup } from './source-groups'
import { sumBytes } from './visual-model'

export interface AgentSummary extends SourceGroup {
  sessionCount: number
  deletableCount: number
  storage: AgentStorageGroup['storage'] | undefined
  complete: boolean
}

export function agentSummaries(data: CleanerState): AgentSummary[] {
  const storage = new Map(groupAgentStorage(data).map((group) => [group.id, group]))
  return groupSources(data)
    .map((group) => {
      const sessions = data.items.filter(
        (item) => group.sourceIds.includes(item.sourceId) && item.category === 'sessions'
      )
      return {
        ...group,
        name: group.kind === 'unknown' ? group.name : sourceKindLabel(group.kind),
        sessionCount: sessions.length,
        deletableCount: sessions.filter(canPermanentlyDelete).length,
        bytes: group.bytes,
        storage: storage.get(group.id)?.storage,
        complete: storage.get(group.id)?.storage.complete ?? false
      }
    })
    .sort((left, right) => right.bytes - left.bytes)
}

export function totalResourceBytes(data: CleanerState): number {
  const managed = getUniqueResourceBytes(data.resources)
  if (managed === null) return sumBytes(data.items)
  const managedSources = new Set(
    (data.resources ?? []).flatMap((resource) => resource.sourceIds ?? [resource.sourceId])
  )
  return managed + sumBytes(data.items.filter((item) => !managedSources.has(item.sourceId)))
}
