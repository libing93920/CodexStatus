import { memo, useMemo } from 'react'
import type { ReactNode } from 'react'
import type { CleanerRecord, CleanerState } from '../../../../../shared/session-cleaner'
import { Icon, PageHeading } from '../components'
import { formatBytes, formatDateTime, groupRecordsByBatch, recordStatusLabel } from '../model'

function recordTone(status: CleanerRecord['status']): string {
  if (['deleted', 'exported', 'compacted', 'recycled'].includes(status)) return 'green'
  if (status === 'failed' || status === 'pending') return 'amber'
  return 'neutral'
}

function RecordRow({
  record,
  sourceName
}: {
  record: CleanerRecord
  sourceName: string
}): ReactNode {
  return (
    <article className="review-row manager-record-row">
      <Icon name="items" />
      <div>
        <h3>{record.title}</h3>
        <p className="mono">{record.path}</p>
        <p>
          {sourceName} · {formatDateTime(record.at)} ·{' '}
          <span className={`status-pill ${recordTone(record.status)}`}>
            {recordStatusLabel(record.status)}
          </span>
        </p>
        {record.reason ? <p>{record.reason}</p> : null}
        {record.logicalBytes !== undefined ? (
          <p>逻辑载荷 {formatBytes(record.logicalBytes)}</p>
        ) : null}
        {record.fileBytesAfter !== undefined ? (
          <p>剩余文件字节：{formatBytes(record.fileBytesAfter)}</p>
        ) : null}
      </div>
      <span className="mono">文件范围 {formatBytes(record.bytes)}</span>
    </article>
  )
}

function RecordBatch({
  batch,
  index,
  sourceNames
}: {
  batch: ReturnType<typeof groupRecordsByBatch>[number]
  index: number
  sourceNames: Map<string, string>
}): ReactNode {
  const deleted = batch.records.filter((record) => record.status === 'deleted')
  const deletedBytes = deleted.reduce((sum, record) => sum + record.bytes, 0)
  return (
    <details className="recycle-record" data-batch-id={batch.batchId} open={index === 0}>
      <summary className="record-head">
        <span>
          <strong>批次 {String(index + 1).padStart(2, '0')}</strong>
          <small>
            {formatDateTime(batch.latestAt)} · {batch.records.length} 条逐项结果
          </small>
        </span>
        <span className="mono">
          永久删除 {deleted.length} · {formatBytes(deletedBytes)}
        </span>
        <Icon name="chevron" />
      </summary>
      <div className="record-items">
        {batch.records.map((record) => (
          <RecordRow
            key={record.id}
            record={record}
            sourceName={sourceNames.get(record.sourceId) ?? '来源已移除'}
          />
        ))}
      </div>
    </details>
  )
}

function RecordSummary({ records }: { records: CleanerRecord[] }): ReactNode {
  const deleted = records.filter((record) => record.status === 'deleted')
  const exported = records.filter((record) => record.status === 'exported')
  const compacted = records.filter((record) => record.status === 'compacted')
  const recycled = records.filter((record) => record.status === 'recycled')
  const deletedBytes = deleted.reduce((sum, record) => sum + record.bytes, 0)
  return (
    <section className="manager-record-summary" aria-label="操作记录汇总">
      <div>
        <span>永久删除</span>
        <strong>
          {deleted.length} 项 · {formatBytes(deletedBytes)}
        </strong>
      </div>
      <div>
        <span>导出</span>
        <strong>{exported.length} 项</strong>
      </div>
      <div>
        <span>数据库整理</span>
        <strong>{compacted.length} 项</strong>
      </div>
      {recycled.length ? (
        <div>
          <span>旧版移入回收站</span>
          <strong>{recycled.length} 项</strong>
        </div>
      ) : null}
    </section>
  )
}

const RecordHistory = memo(function RecordHistory({ data }: { data: CleanerState }): ReactNode {
  const batches = groupRecordsByBatch(data.records)
  const sourceNames = new Map(data.sources.map((source) => [source.id, source.name]))
  return (
    <>
      <RecordSummary records={data.records} />
      {batches.length ? (
        <section aria-label="按批次排列的操作记录">
          {batches.map((batch, index) => (
            <RecordBatch
              key={batch.batchId}
              batch={batch}
              index={index}
              sourceNames={sourceNames}
            />
          ))}
        </section>
      ) : (
        <div className="recycle-empty">
          <Icon name="records" />
          <strong>暂无操作记录</strong>
          <span>导出、永久删除与数据库整理结果会逐项显示在这里。</span>
        </div>
      )}
    </>
  )
})

export function RecordsPage({
  data,
  isBusy,
  onOpenRecycleBin
}: {
  data: CleanerState | null
  isBusy: boolean
  onOpenRecycleBin: () => void
}): ReactNode {
  const hasLegacyRecycleRecords = useMemo(
    () => data?.records.some((record) => record.status === 'recycled') ?? false,
    [data?.records]
  )
  if (!data)
    return (
      <section className="panel loading-panel" role="status">
        正在读取操作记录…
      </section>
    )

  return (
    <>
      <PageHeading
        id="records-heading"
        title="操作记录"
        description="按会话逐项记录永久删除、导出、数据库整理和旧版回收结果。"
        actions={
          hasLegacyRecycleRecords ? (
            <button className="button" type="button" onClick={onOpenRecycleBin} disabled={isBusy}>
              <Icon name="restore" />
              查看旧版回收站
            </button>
          ) : undefined
        }
      />
      <RecordHistory data={data} />
    </>
  )
}
