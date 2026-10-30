import { useMemo } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { CleanerState } from '../../../../../shared/session-cleaner'
import { EmptyState, Icon, PageHeading } from '../components'
import { formatBytes } from '../model'
import { agentSummaries, totalResourceBytes } from '../agent-summary'
import { AgentBadge } from '../AgentBadge'
import type { AgentSummary } from '../agent-summary'
import { sourceColor } from '../visual-model'

interface AnalyticsProps {
  data: CleanerState | null
  isBusy: boolean
  onCompactDatabase: (sourceId: string) => void
  onOpenAgent: (sourceId: string) => void
}

function DatabaseActions({
  data,
  agent,
  isBusy,
  onCompactDatabase
}: AnalyticsProps & { data: CleanerState; agent: AgentSummary }): ReactNode {
  if (agent.kind !== 'opencode') return null
  const databases = (data.storage ?? []).filter(
    (summary) => agent.sourceIds.includes(summary.sourceId) && summary.databaseBytes > 0
  )
  if (!databases.length) return null
  return (
    <div className="calm-database-actions">
      <div>
        <strong>数据库整理</strong>
        <p>删除会话后，可按需整理数据库以回收空闲页。</p>
      </div>
      {databases.map((database) => (
        <div className="manager-database-row" key={database.sourceId}>
          <span>{data.sources.find((source) => source.id === database.sourceId)?.name}</span>
          <button
            className="button"
            type="button"
            disabled={isBusy}
            onClick={() => onCompactDatabase(database.sourceId)}
          >
            整理数据库
          </button>
        </div>
      ))}
    </div>
  )
}

function AgentStorageRow(
  props: AnalyticsProps & { data: CleanerState; agent: AgentSummary; maximum: number }
): ReactNode {
  const { agent, data, maximum } = props
  const width = maximum ? (agent.bytes / maximum) * 100 : 0
  return (
    <article
      className="calm-storage-agent"
      style={{ '--agent-color': sourceColor(agent.kind) } as CSSProperties}
    >
      <div className="calm-storage-row">
        <AgentBadge kind={agent.kind} />
        <div className="calm-storage-name">
          <h3>{agent.name}</h3>
          <p>
            {agent.sessionCount} 个会话 <span>·</span> {agent.deletableCount} 个可以删除
          </p>
        </div>
        <strong className="calm-storage-bytes">{formatBytes(agent.bytes)}</strong>
        <button type="button" className="text-button" onClick={() => props.onOpenAgent(agent.id)}>
          {agent.capability === 'files' ? '查看资源' : '查看会话'} <Icon name="arrow" />
        </button>
      </div>
      <div
        className="calm-storage-track"
        role="img"
        aria-label={agent.name + ' 占用 ' + formatBytes(agent.bytes)}
      >
        <span style={{ width: width + '%' }} />
      </div>
      <details className="calm-storage-details">
        <summary>
          占用明细 <Icon name="chevron" />
        </summary>
        <div className="calm-storage-breakdown">
          <div>
            <span>数据库</span>
            <strong>{formatBytes(agent.storage?.databaseBytes ?? 0)}</strong>
          </div>
          <div>
            <span>写入日志</span>
            <strong>{formatBytes(agent.storage?.walBytes ?? 0)}</strong>
          </div>
          <div>
            <span>其他文件</span>
            <strong>{formatBytes(agent.storage?.otherBytes ?? agent.bytes)}</strong>
          </div>
          <div>
            <span>其中共享</span>
            <strong>{formatBytes(agent.storage?.sharedBytes ?? 0)}</strong>
          </div>
        </div>
        {!agent.complete ? (
          <p className="calm-supporting-note">部分资源归属尚待核对，当前显示已统计占用。</p>
        ) : null}
        <div className="calm-storage-paths">
          {data.sources
            .filter((source) => agent.sourceIds.includes(source.id))
            .map((source) => (
              <code key={source.id}>{source.path}</code>
            ))}
        </div>
        <DatabaseActions {...props} />
      </details>
    </article>
  )
}

export function AnalyticsPage(props: AnalyticsProps): ReactNode {
  const { data } = props
  const agents = useMemo(() => (data ? agentSummaries(data) : []), [data])
  const maximum = useMemo(() => Math.max(0, ...agents.map((agent) => agent.bytes)), [agents])
  const total = useMemo(() => (data ? totalResourceBytes(data) : 0), [data])
  return (
    <>
      <PageHeading id="analytics-heading" title="空间分析" description="" />
      <div className="calm-analysis-intro">
        <div>
          <span>Agent 会话总占用</span>
          <strong>{data?.scannedAt ? formatBytes(total) : '—'}</strong>
        </div>
        <p>
          看看空间主要用在哪里。
          <br />
          点击 Agent 查看会话，展开明细了解文件组成。
        </p>
      </div>
      {data && agents.length ? (
        <section className="calm-storage-list" aria-label="各 Agent 占用">
          <header>
            <h2>Agent 占用排行</h2>
            <span>{agents.length} 个工具 · 按大小排列</span>
          </header>
          {agents.map((agent) => (
            <AgentStorageRow
              {...props}
              data={data}
              agent={agent}
              maximum={maximum}
              key={agent.id}
            />
          ))}
        </section>
      ) : (
        <EmptyState title="还没有空间数据" description="扫描后，这里会按 Agent 展示会话占用。" />
      )}
      <p className="calm-scope-note">
        仅统计已纳入的来源目录。共享文件在总占用中只计一次，不等同于删除后可释放的空间。
      </p>
    </>
  )
}
