import type { CSSProperties, ReactNode } from 'react'
import type { CleanerState } from '../../../../../shared/session-cleaner'
import { formatBytes } from '../model'
import { sourceColor } from '../visual-model'
import { groupSources } from '../source-groups'

export function SourceRanking({
  data,
  selectedSourceId,
  onSourceSelect
}: {
  data: CleanerState
  selectedSourceId: string
  onSourceSelect: (id: string) => void
}): ReactNode {
  const rows = groupSources(data).sort((left, right) => right.bytes - left.bytes)
  const max = rows[0]?.bytes ?? 0
  return (
    <section className="insight-panel ranking-panel" aria-labelledby="ranking-title">
      <div className="insight-heading">
        <h2 id="ranking-title">Agent 占用排行</h2>
        <span className="chart-tag">{rows.length} 个 Agent</span>
      </div>
      <div className="agent-ranking">
        {rows.map((row) => (
          <button
            key={row.id}
            data-source-id={row.id}
            type="button"
            className="agent-bar-row"
            aria-pressed={selectedSourceId === row.id}
            aria-label={`${row.name}，${formatBytes(row.bytes)}，查看对应内容`}
            onClick={() => onSourceSelect(row.id)}
          >
            <span className="agent-bar-name">{row.name}</span>
            <span className="agent-bar-track">
              <span
                className="agent-bar-fill"
                style={
                  {
                    '--source-color': sourceColor(row.kind),
                    width: `${max ? (row.bytes / max) * 100 : 0}%`
                  } as CSSProperties
                }
              />
            </span>
            <span className="agent-bar-value">
              {data.scannedAt ? formatBytes(row.bytes) : '待扫描'}
            </span>
          </button>
        ))}
        {!rows.length ? <div className="chart-empty">暂无已纳入来源</div> : null}
      </div>
      {!data.scannedAt ? <p className="chart-footnote">来源尚未扫描，未计入占用。</p> : null}
    </section>
  )
}
