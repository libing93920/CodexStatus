import type { ReactNode } from 'react'
import type { CleanerItem, CleanerState } from '../../../../../shared/session-cleaner'
import type { SessionDetails } from '../../../../../shared/session-manager'
import { Icon, StatusBadge } from '../components'
import { formatBytes, formatDateTime, statusLabel, statusReason } from '../model'
import { canExportSession, canResumeSession } from '../manager-model'
import { SessionMessageList } from './SessionMessage'

function DetailMetadata({ data, item }: { data: CleanerState; item: CleanerItem }): ReactNode {
  const source = data.sources.find((entry) => entry.id === item.sourceId)
  const managed = item.managed
  return (
    <dl className="detail-grid manager-detail-grid">
      <div>
        <dt>Agent / 来源</dt>
        <dd>{source?.name ?? '未提供'}</dd>
      </div>
      <div>
        <dt>项目</dt>
        <dd>{managed?.projectDir ?? item.project ?? '未提供'}</dd>
      </div>
      <div>
        <dt>模型</dt>
        <dd>{managed?.modelIds.length ? managed.modelIds.join('、') : '未提供'}</dd>
      </div>
      <div>
        <dt>消息数</dt>
        <dd>{managed?.messageCount ?? '未提供'}</dd>
      </div>
      <div>
        <dt>创建时间</dt>
        <dd>
          {managed?.createdAt === undefined && item.createdAt === undefined
            ? '未提供'
            : formatDateTime(managed?.createdAt ?? item.createdAt)}
        </dd>
      </div>
      <div>
        <dt>最近活动</dt>
        <dd>
          {managed?.lastActiveAt === undefined ? '未提供' : formatDateTime(managed.lastActiveAt)}
        </dd>
      </div>
      <div className="detail-path">
        <dt>原位置</dt>
        <dd>
          <code>{item.path}</code>
        </dd>
      </div>
      <div className="detail-status">
        <dt>状态与原因</dt>
        <dd>{statusReason(item)}</dd>
      </div>
    </dl>
  )
}

function DetailResources({ details }: { details: SessionDetails }): ReactNode {
  return (
    <details className="manager-resources">
      <summary>关联资源 · {details.resources.length}</summary>
      <ul className="file-list">
        {details.resources.map((resource) => (
          <li key={resource.id}>
            <span>{resource.kind}</span>
            <code>{resource.path}</code>
            <span>{formatBytes(resource.bytes)}</span>
          </li>
        ))}
      </ul>
    </details>
  )
}

function DetailSizeBreakdown({ item }: { item: CleanerItem }): ReactNode {
  return (
    <div className="manager-size-breakdown">
      <div>
        <span>去重计入</span>
        <strong>{formatBytes(item.bytes)}</strong>
      </div>
      <div>
        <span>文件大小</span>
        <strong>{item.managed ? formatBytes(item.managed.storage.fileBytes) : '未提供'}</strong>
      </div>
      <div>
        <span>逻辑大小</span>
        <strong>
          {item.managed?.storage.logicalBytes === undefined
            ? '未提供'
            : formatBytes(item.managed.storage.logicalBytes)}
        </strong>
      </div>
    </div>
  )
}

function DetailActions({
  item,
  isBusy,
  onReveal,
  onExport,
  onResume
}: {
  item: CleanerItem
  isBusy: boolean
  onReveal: (id: string) => void
  onExport: (id: string) => void
  onResume: (id: string) => void
}): ReactNode {
  return (
    <div className="manager-detail-actions">
      {canExportSession(item) ? (
        <button
          className="button"
          type="button"
          onClick={() => onExport(item.id)}
          disabled={isBusy}
        >
          导出会话
        </button>
      ) : null}
      {canResumeSession(item) ? (
        <button
          className="button primary"
          type="button"
          onClick={() => onResume(item.id)}
          disabled={isBusy}
        >
          继续会话
        </button>
      ) : null}
      <button
        className="text-button"
        type="button"
        onClick={() => onReveal(item.id)}
        disabled={isBusy}
      >
        定位文件
      </button>
    </div>
  )
}

function DetailTranscript({
  item,
  details,
  loaded,
  loading
}: {
  item: CleanerItem
  details: SessionDetails | undefined
  loaded: boolean
  loading: boolean
}): ReactNode {
  const canRead = item.managed?.capabilities.read === true
  return (
    <>
      {loading ? <p role="status">正在读取结构化正文…</p> : null}
      {!loading && !canRead ? <p className="muted">此来源未提供读取正文的能力。</p> : null}
      {!loading && canRead && !loaded ? <p className="muted">选择“详情”后读取正文。</p> : null}
      {!loading && details ? (
        <>
          <SessionMessageList messages={details.messages} sessionId={item.id} />
          <DetailResources details={details} />
        </>
      ) : null}
      {!loading && loaded && !details ? <p className="muted">未读取到正文。</p> : null}
    </>
  )
}

function DetailFiles({ item }: { item: CleanerItem }): ReactNode {
  return (
    <details className="manager-files">
      <summary>扫描文件 · {item.files.length}</summary>
      <ul className="file-list">
        {item.files.map((file) => (
          <li key={file}>
            <code>{file}</code>
          </li>
        ))}
      </ul>
    </details>
  )
}

export function ItemDetails({
  data,
  item,
  details,
  loaded,
  loading,
  isBusy,
  onClose,
  onReveal,
  onExport,
  onResume
}: {
  data: CleanerState
  item: CleanerItem
  details: SessionDetails | undefined
  loaded: boolean
  loading: boolean
  isBusy: boolean
  onClose: () => void
  onReveal: (id: string) => void
  onExport: (id: string) => void
  onResume: (id: string) => void
}): ReactNode {
  return (
    <section className="detail-panel manager-detail-panel" aria-labelledby="detail-heading">
      <div className="detail-label">
        <span>会话详情</span>
        <StatusBadge
          label={statusLabel(item.status)}
          tone={item.status === 'candidate' ? 'candidate' : 'neutral'}
        />
        <button className="icon-button" type="button" onClick={onClose} aria-label="关闭条目详情">
          <Icon name="close" />
        </button>
      </div>
      <h2 id="detail-heading" className="detail-title">
        {item.title}
      </h2>
      <DetailActions
        item={item}
        isBusy={isBusy}
        onReveal={onReveal}
        onExport={onExport}
        onResume={onResume}
      />
      <DetailTranscript item={item} details={details} loaded={loaded} loading={loading} />
      <details className="calm-session-metadata">
        <summary>会话信息与文件</summary>
        <DetailSizeBreakdown item={item} />
        <DetailMetadata data={data} item={item} />
        <DetailFiles item={item} />
      </details>
    </section>
  )
}
