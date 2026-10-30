import type { ReactNode } from 'react'
import type { CleanerState } from '../../../../../shared/session-cleaner'
import { HelpTip, Icon } from '../components'
import { formatBytes } from '../model'
import { getDeletableIds } from '../manager-model'
import { sizeParts, sumBytes } from '../visual-model'

interface MetricsProps {
  data: CleanerState
  onItems: () => void
  onReadOnly: () => void
  onRecords: () => void
}

function DiskContext({ data, onRecords }: Pick<MetricsProps, 'data' | 'onRecords'>): ReactNode {
  const disk = data.disks.find((entry) => /^c:/i.test(entry.path)) ?? data.disks[0]
  const free = sizeParts(disk?.available ?? 0)
  const usedPercent =
    disk && disk.total > 0 ? Math.max(0, Math.min(100, (1 - disk.available / disk.total) * 100)) : 0
  const low = usedPercent > 90
  const deleted = sumBytes(data.records.filter((record) => record.status === 'deleted'))
  return (
    <section className="disk-context" aria-label="磁盘空间现状">
      <div className="disk-context-heading">
        <strong>
          {disk
            ? `${disk.path.slice(0, 2)} ${/^c:/i.test(disk.path) ? '系统盘' : '磁盘'}`
            : '磁盘空间'}
        </strong>
        <span className={`status-pill ${low ? 'amber' : 'green'}`}>
          {disk ? (low ? '可用不足 10%' : '可用充足') : '未读取'}
        </span>
      </div>
      <div className="disk-free">
        {disk ? free.value : '—'} <small>{disk ? `${free.unit} 可用` : '容量未知'}</small>
      </div>
      <div className="disk-meter" aria-label={`磁盘已使用 ${usedPercent.toFixed(1)}%`}>
        <span style={{ width: `${usedPercent}%` }} />
      </div>
      <p>{disk ? `共 ${formatBytes(disk.total)}` : '当前没有可读取的磁盘容量'}</p>
      <div className="context-stat">
        <span>{data.sources.length} 个来源 · 跨磁盘合计</span>
        <strong>{formatBytes(sumBytes(data.items))}</strong>
      </div>
      <div className="context-stat">
        <span title="历史记录字节不等同于已释放空间。">永久删除记录</span>
        <button className="text-button" type="button" onClick={onRecords}>
          {formatBytes(deleted)}
          <Icon name="chevron" />
        </button>
      </div>
    </section>
  )
}

export function OverviewMetrics({ data, onItems, onReadOnly, onRecords }: MetricsProps): ReactNode {
  const sessionCount = data.items.filter((item) => item.category === 'sessions').length
  const resourceCount = data.items.filter((item) => item.category === 'resources').length
  const deletableIds = new Set(getDeletableIds(data.items))
  const deletableItems = data.items.filter((item) => deletableIds.has(item.id))
  const amount = sizeParts(sumBytes(deletableItems))
  const readOnly = sizeParts(sumBytes(data.items.filter((item) => item.status === 'read-only')))
  const protectedCount = data.items.filter((item) =>
    ['protected', 'active'].includes(item.status)
  ).length
  const recentRecommendations = data.items.filter((item) => item.recommendation === 'recent').length
  return (
    <div className="overview-focus">
      <section className="opportunity" aria-labelledby="opportunity-title">
        <div className="opportunity-heading">
          <h2 id="opportunity-title">可永久删除占用</h2>
          <HelpTip
            text="按来源报告的删除能力统计去重计入大小。此数值不承诺释放量；确认前会展示逐项预览。近期建议与删除能力独立。"
            label="删除占用如何计算"
          />
        </div>
        <div className="opportunity-amount">
          <span>{amount.value}</span>
          <small>{amount.unit}</small>
          <span className="opportunity-count">
            <strong>{deletableItems.length}</strong> 项有删除能力
          </span>
        </div>
        <div className="opportunity-action">
          <button className="button" type="button" onClick={onItems}>
            查看会话管理
            <Icon name="arrow" />
          </button>
        </div>
        <div className="overview-inline-stats">
          <span>
            <strong>{sessionCount}</strong> 个会话 · <strong>{resourceCount}</strong> 个资源
          </span>
          <span>
            <strong>{protectedCount}</strong> 项受保护或正在使用 ·{' '}
            <strong>{recentRecommendations}</strong> 项近期建议
          </span>
        </div>
      </section>
      <DiskContext data={data} onRecords={onRecords} />
      <section className="readonly-summary">
        <div className="readonly-icon">
          <Icon name="lock" />
        </div>
        <span>能力受限 · 只读</span>
        <div>
          <strong>{readOnly.value}</strong>
          <small>{readOnly.unit}</small>
        </div>
        <button className="text-button" type="button" onClick={onReadOnly}>
          查看内容
          <Icon name="arrow" />
        </button>
      </section>
    </div>
  )
}
