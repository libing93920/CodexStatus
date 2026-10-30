import { useMemo } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { CleanerState } from '../../../../../shared/session-cleaner'
import { EmptyState, Icon, PageHeading } from '../components'
import { formatBytes, formatDateTime } from '../model'
import { canPermanentlyDelete } from '../manager-model'
import { agentSummaries, totalResourceBytes } from '../agent-summary'
import type { AgentSummary } from '../agent-summary'
import { AgentBadge } from '../AgentBadge'
import { sourceColor } from '../visual-model'

export interface OverviewPageProps {
  data: CleanerState | null
  scanActive: boolean
  isBusy: boolean
  cancelPending: boolean
  onScan: () => void
  onCancelScan: () => void
  onItems: () => void
  onSources: () => void
  onSourceSelect: (sourceId: string) => void
}

function StorageVisual({
  data,
  agents,
  total,
  onSourceSelect
}: Pick<OverviewPageProps, 'onSourceSelect'> & {
  data: CleanerState
  agents: AgentSummary[]
  total: number
}): ReactNode {
  const background = useMemo(() => {
    let position = 0
    const segments: string[] = []
    for (const agent of agents) {
      const bytes = data.resources?.length
        ? data.resources
            .filter((resource) => agent.sourceIds.includes(resource.sourceId))
            .reduce((sum, resource) => sum + resource.bytes, 0)
        : agent.bytes
      if (!total || !bytes) continue
      const start = position
      position += (bytes / total) * 100
      segments.push(sourceColor(agent.kind) + ' ' + start + '% ' + position + '%')
    }
    return segments.length ? 'conic-gradient(' + segments.join(', ') + ')' : 'var(--line)'
  }, [agents, data.resources, total])
  return (
    <section className="calm-overview-chart" aria-labelledby="agent-storage-title">
      <div className="calm-section-heading">
        <h2 id="agent-storage-title">会话空间分布</h2>
        <span>按 Agent 查看</span>
      </div>
      <div className="calm-chart-layout">
        <div className="calm-donut-wrap">
          <div
            className="calm-donut"
            style={{ '--donut-fill': background } as CSSProperties}
            role="img"
            aria-label={'已统计会话空间 ' + formatBytes(total)}
          >
            <div>
              <span>会话总占用</span>
              <strong>{data.scannedAt ? formatBytes(total) : '—'}</strong>
              <small>共享文件只计算一次</small>
            </div>
          </div>
        </div>
        <div className="calm-agent-legend">
          {agents.map((agent) => (
            <button
              type="button"
              className="calm-agent-legend-row"
              key={agent.id}
              onClick={() => onSourceSelect(agent.id)}
            >
              <AgentBadge kind={agent.kind} />
              <span>
                <strong>{agent.name}</strong>
                <small>
                  {agent.capability === 'files' ? '历史与资源文件' : agent.sessionCount + ' 个会话'}
                </small>
              </span>
              <b>{data.scannedAt ? formatBytes(agent.bytes) : '—'}</b>
              <Icon name="chevron" />
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}

export function OverviewPage(props: OverviewPageProps): ReactNode {
  const { data, scanActive, isBusy, cancelPending } = props
  const sessions = useMemo(
    () => data?.items.filter((item) => item.category === 'sessions') ?? [],
    [data?.items]
  )
  const deletable = useMemo(() => sessions.filter(canPermanentlyDelete).length, [sessions])
  const agents = useMemo(() => (data ? agentSummaries(data) : []), [data])
  const total = useMemo(() => (data ? totalResourceBytes(data) : 0), [data])
  return (
    <>
      <PageHeading
        id="overview-heading"
        title="存储总览"
        description=""
        actions={
          <button
            type="button"
            className="button primary"
            disabled={(!scanActive && isBusy) || cancelPending}
            onClick={scanActive ? props.onCancelScan : props.onScan}
          >
            <Icon
              name={scanActive ? 'refresh' : 'scan'}
              className={scanActive ? 'scan-active' : ''}
            />
            {scanActive ? (cancelPending ? '取消中…' : '取消扫描') : '扫描会话'}
          </button>
        }
      />
      {!data ? (
        <p className="calm-loading" role="status">
          正在读取 Agent…
        </p>
      ) : (
        <>
          <div className="calm-overview-stats" aria-label="会话概况">
            <div>
              <span>已发现 Agent</span>
              <strong>
                {agents.length}
                <small>个工具</small>
              </strong>
            </div>
            <div>
              <span>本地会话</span>
              <strong>
                {data.scannedAt ? sessions.length : '—'}
                <small>个会话</small>
              </strong>
            </div>
            <button type="button" onClick={props.onItems}>
              <span>可以删除</span>
              <strong>
                {data.scannedAt ? deletable : '—'}
                <small>
                  个会话 <Icon name="arrow" />
                </small>
              </strong>
            </button>
          </div>
          {data.sources.length ? (
            <StorageVisual
              data={data}
              agents={agents}
              total={total}
              onSourceSelect={props.onSourceSelect}
            />
          ) : (
            <EmptyState
              title="还没有发现 Agent"
              description="添加你的 Agent 数据目录，即可查看会话占用。"
              action={
                <button className="button" type="button" onClick={props.onSources}>
                  添加 Agent
                </button>
              }
            />
          )}
          <footer className="calm-overview-footer">
            <span>
              {scanActive
                ? '正在扫描本地会话…'
                : data.scannedAt
                  ? '更新于 ' + formatDateTime(data.scannedAt)
                  : '扫描后显示真实占用'}
            </span>
            <button type="button" className="text-button" onClick={props.onSources}>
              管理 Agent 目录 <Icon name="arrow" />
            </button>
          </footer>
          {data.issues.length ? (
            <details className="calm-scan-notes">
              <summary>部分资源需核对 · {data.issues.length} 条提示</summary>
              <p>已读取的文件仍计入占用；无法确认归属的资源保持只读。</p>
              <ul>
                {data.issues.slice(0, 20).map((issue, index) => (
                  <li key={index}>
                    <span>{issue.message}</span>
                    <code>{issue.path}</code>
                  </li>
                ))}
              </ul>
              {data.issues.length > 20 ? (
                <p>此处展示前 20 条。可在来源管理中定位相关目录。</p>
              ) : null}
            </details>
          ) : null}
        </>
      )}
    </>
  )
}
