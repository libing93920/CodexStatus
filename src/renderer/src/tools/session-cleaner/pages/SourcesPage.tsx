import type { CSSProperties, ReactNode } from 'react'
import type { CleanerSource, CleanerState } from '../../../../../shared/session-cleaner'
import { EmptyState, Icon, PageHeading } from '../components'
import { formatBytes } from '../model'
import { sourceColor } from '../visual-model'
import { sourceDirectoryLabel } from '../source-groups'

interface SourceRowData {
  source: CleanerSource
  bytes: number
  hasIssue: boolean
}

export interface SourcesPageProps {
  data: CleanerState | null
  isBusy: boolean
  onDiscover: () => void
  onImport: () => void
  onRemove: (id: string) => void
}

function sourceColorStyle(source: CleanerSource): CSSProperties {
  return { '--source-color': sourceColor(source.kind) } as CSSProperties
}

function createSourceRows(data: CleanerState): SourceRowData[] {
  const bytesBySource = new Map<string, number>()
  for (const item of data.items)
    bytesBySource.set(item.sourceId, (bytesBySource.get(item.sourceId) ?? 0) + item.bytes)
  return data.sources
    .map((source) => ({
      source,
      bytes: bytesBySource.get(source.id) ?? 0,
      hasIssue: data.issues.some(
        (issue) => issue.path === source.path || issue.path.startsWith(`${source.path}\\`)
      )
    }))
    .sort((left, right) => right.bytes - left.bytes)
}

function SourceCard({
  row,
  scannedAt,
  isBusy,
  onRemove
}: {
  row: SourceRowData
  scannedAt: number | undefined
  isBusy: boolean
  onRemove: (id: string) => void
}): ReactNode {
  const { source, bytes, hasIssue } = row
  const capability = source.capability === 'sessions' ? '会话扫描' : '文件只读'
  const amount = scannedAt ? (hasIssue && !bytes ? '未完成' : formatBytes(bytes)) : '待扫描'
  return (
    <article className="source-card">
      <div className="source-identity">
        <div className="source-card-head">
          <span className="source-dot" style={sourceColorStyle(source)} />
          <h3>{sourceDirectoryLabel(source)}</h3>
        </div>
        <p className="source-card-path" title={source.path}>
          {source.path}
        </p>
      </div>
      <div className="source-capability">
        <span className={`status-pill ${source.capability === 'sessions' ? 'green' : 'neutral'}`}>
          {capability}
        </span>
      </div>
      <span
        className="source-amount mono"
        title={hasIssue ? '此来源存在未完成或无法解析项；占用量可能不完整。' : undefined}
      >
        {amount}
      </span>
      <button
        className="icon-button"
        type="button"
        onClick={() => onRemove(source.id)}
        disabled={isBusy}
        aria-label={`移除${sourceDirectoryLabel(source)}来源`}
        title="移除来源登记，不会删除原文件"
      >
        <Icon name="close" />
      </button>
    </article>
  )
}

function SourceActions({
  isBusy,
  onDiscover,
  onImport
}: Pick<SourcesPageProps, 'isBusy' | 'onDiscover' | 'onImport'>): ReactNode {
  return (
    <>
      <button className="button" type="button" onClick={onDiscover} disabled={isBusy}>
        <Icon name="scan" />
        检查已知来源
      </button>
      <button className="button primary" type="button" onClick={onImport} disabled={isBusy}>
        <Icon name="add" />
        导入目录
      </button>
    </>
  )
}

function SourceDirectory({
  data,
  rows,
  isBusy,
  onDiscover,
  onImport,
  onRemove
}: {
  data: CleanerState
  rows: SourceRowData[]
  isBusy: boolean
  onDiscover: () => void
  onImport: () => void
  onRemove: (id: string) => void
}): ReactNode {
  return (
    <>
      <PageHeading
        id="sources-heading"
        title="来源管理"
        description="只扫描已登记目录；移除来源登记会保留本地文件。"
        actions={<SourceActions isBusy={isBusy} onDiscover={onDiscover} onImport={onImport} />}
      />
      <div className="source-columns">
        <span>来源 / 根目录</span>
        <span>能力</span>
        <span>占用</span>
        <span />
      </div>
      <section className="source-cards" aria-label="已登记来源">
        {rows.length ? (
          rows.map((row) => (
            <SourceCard
              key={row.source.id}
              row={row}
              scannedAt={data.scannedAt}
              isBusy={isBusy}
              onRemove={onRemove}
            />
          ))
        ) : (
          <EmptyState
            title="尚无登记来源"
            description="检查已知位置，或通过系统目录选择器导入本地 Agent 数据目录。"
          />
        )}
      </section>
    </>
  )
}

export function SourcesPage({
  data,
  isBusy,
  onDiscover,
  onImport,
  onRemove
}: SourcesPageProps): ReactNode {
  if (!data)
    return (
      <section className="panel loading-panel" role="status">
        正在读取来源…
      </section>
    )

  return (
    <SourceDirectory
      data={data}
      rows={createSourceRows(data)}
      isBusy={isBusy}
      onDiscover={onDiscover}
      onImport={onImport}
      onRemove={onRemove}
    />
  )
}
