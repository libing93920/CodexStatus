import type { CleanerSource, CleanerState } from '../../../../shared/session-cleaner'

export interface SourceGroup {
  id: string
  kind: CleanerSource['kind']
  name: string
  capability: CleanerSource['capability']
  sourceIds: string[]
  bytes: number
}

export function sourceGroupId(source: Pick<CleanerSource, 'id' | 'kind'>): string {
  return source.kind === 'unknown' ? source.id : `agent:${source.kind}`
}

export function groupSources(
  data: Pick<CleanerState, 'sources' | 'items' | 'resources'>
): SourceGroup[] {
  const bytesBySource = new Map<string, number>()
  for (const item of data.items)
    bytesBySource.set(item.sourceId, (bytesBySource.get(item.sourceId) ?? 0) + item.bytes)
  const groups = new Map<string, SourceGroup>()
  for (const source of data.sources) {
    const id = sourceGroupId(source)
    const group: SourceGroup = groups.get(id) ?? {
      id,
      kind: source.kind,
      name: source.name,
      capability: source.capability,
      sourceIds: [],
      bytes: 0
    }
    group.sourceIds.push(source.id)
    group.bytes += bytesBySource.get(source.id) ?? 0
    if (source.capability === 'sessions') group.capability = 'sessions'
    groups.set(id, group)
  }
  for (const group of groups.values()) {
    const matching = data.resources?.filter((resource) =>
      (resource.sourceIds ?? [resource.sourceId]).some((id) => group.sourceIds.includes(id))
    )
    if (matching?.length)
      group.bytes = [
        ...new Map(matching.map((resource) => [resource.id, resource])).values()
      ].reduce((total, resource) => total + resource.bytes, 0)
  }
  return [...groups.values()]
}

export function sourceDirectoryLabel(
  source: Pick<CleanerSource, 'name' | 'kind' | 'path'>
): string {
  if (source.kind !== 'codex') return source.name
  const directory = source.path.replace(/\\/g, '/').split('/').filter(Boolean).at(-1)
  if (directory === 'sessions') return `${source.name} · 普通会话`
  if (directory === 'archived_sessions') return `${source.name} · 已归档会话`
  return source.name
}
