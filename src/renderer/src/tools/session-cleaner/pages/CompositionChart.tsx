import type { CSSProperties, ReactNode } from 'react'
import type { CleanerItem } from '../../../../../shared/session-cleaner'
import { HelpTip } from '../components'
import { formatBytes } from '../model'
import { sizeParts, sumBytes } from '../visual-model'

const CATEGORIES = [
  { key: 'sessions', label: '会话记录', color: 'var(--chart-session)' },
  { key: 'resources', label: '图片与工具输出', color: 'var(--chart-assets)' },
  { key: 'logs', label: '缓存与日志', color: 'var(--chart-cache)' },
  { key: 'unknown', label: '待识别内容', color: 'var(--chart-unknown)' }
] as const

export function CompositionChart({
  items,
  scanned
}: {
  items: CleanerItem[]
  scanned: boolean
}): ReactNode {
  const total = sumBytes(items)
  const amount = sizeParts(total)
  const rows = CATEGORIES.map((category) => ({
    ...category,
    bytes: sumBytes(items.filter((item) => item.category === category.key))
  }))
  let offset = 0
  const stops = rows.map((row) => {
    const start = offset
    offset += total ? (row.bytes / total) * 100 : 0
    return `${row.color} ${start.toFixed(2)}% ${offset.toFixed(2)}%`
  })
  return (
    <section className="insight-panel composition-panel" aria-labelledby="composition-title">
      <div className="insight-heading">
        <h2 id="composition-title">空间构成</h2>
        <HelpTip
          text="跨磁盘逻辑大小，按资源类型汇总。待识别内容保持只读，分类不等于可清理量。"
          label="查看图表统计口径"
        />
      </div>
      <div className="composition-body">
        <div
          className="composition-ring"
          role="img"
          aria-label={`空间构成：${rows.map((row) => `${row.label} ${formatBytes(row.bytes)}`).join('，')}`}
          style={{ background: total ? `conic-gradient(${stops.join(', ')})` : 'var(--surface)' }}
        >
          <div className="ring-center">
            <strong>{scanned ? amount.value : '—'}</strong>
            <span>{amount.unit} 总占用</span>
          </div>
        </div>
        <dl className="composition-legend">
          {total ? (
            rows.map((row) => (
              <div className="composition-key" key={row.key}>
                <dt>
                  <span
                    className="color-dot"
                    style={{ '--source-color': row.color } as CSSProperties}
                  />
                  <span>{row.label}</span>
                </dt>
                <dd>
                  <strong>{formatBytes(row.bytes)}</strong>
                  <span>{((row.bytes / total) * 100).toFixed(1)}%</span>
                </dd>
              </div>
            ))
          ) : (
            <div className="chart-empty">
              {scanned ? '暂无可统计资源' : '首次扫描后显示空间构成'}
            </div>
          )}
        </dl>
      </div>
    </section>
  )
}
