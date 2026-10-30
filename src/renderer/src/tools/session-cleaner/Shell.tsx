import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { HelpTip, Icon } from './components'
import type { SessionCleanerController } from './hooks'
import type { CleanerProgress } from '../../../../shared/session-cleaner'
import { DEFAULT_ITEM_FILTERS, formatBytes } from './model'
import type { PageId } from './model'
import { PAGE_LABELS, sourceColor } from './visual-model'
import { totalResourceBytes } from './agent-summary'
import { groupSources } from './source-groups'

const PAGES = Object.keys(PAGE_LABELS) as PageId[]
const NOTICE_DURATION_MS = 6000

function SourceFilters({ controller }: { controller: SessionCleanerController }): ReactNode {
  const { data, filters } = controller.ui
  const groups = useMemo(() => (data ? groupSources(data) : []), [data])
  const totalBytes = useMemo(() => (data ? totalResourceBytes(data) : 0), [data])
  const sources = [
    {
      id: 'all',
      name: '全部 Agent',
      color: 'var(--muted)',
      bytes: totalBytes
    },
    ...groups.map((source) => ({
      ...source,
      color: sourceColor(source.kind)
    }))
  ]
  return (
    <>
      <div className="source-label">
        <span className="section-label">已纳入 Agent</span>
        <span className="tiny">大小</span>
      </div>
      <div className="source-list" aria-label="按来源查看内容">
        {sources.map((source) => (
          <button
            key={source.id}
            data-source-id={source.id}
            type="button"
            className={`source-item${filters.sourceId === source.id ? ' active' : ''}`}
            aria-pressed={filters.sourceId === source.id}
            onClick={() => {
              controller.setFilters({
                ...DEFAULT_ITEM_FILTERS,
                sourceId: source.id,
                category:
                  'capability' in source && source.capability === 'files' ? 'all' : 'sessions'
              })
              controller.setPage('items')
            }}
          >
            {source.id === 'all' ? (
              <Icon name="overview" />
            ) : (
              <span
                className="source-dot"
                style={{ '--source-color': source.color } as CSSProperties}
              />
            )}
            <span className="source-name" title={source.name}>
              {source.name}
            </span>
            <span className="source-size" title={formatBytes(source.bytes)}>
              {formatBytes(source.bytes)}
            </span>
          </button>
        ))}
      </div>
    </>
  )
}

export function Sidebar({ controller }: { controller: SessionCleanerController }): ReactNode {
  const { data, page } = controller.ui
  const sessionCount = useMemo(
    () => data?.items.filter((item) => item.category === 'sessions').length ?? null,
    [data?.items]
  )
  const count = (id: PageId): number | null =>
    id === 'items' ? sessionCount : id === 'review' ? controller.ui.selectedIds.length : null
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-symbol">
          <Icon name="overview" />
        </span>
        <span>
          AgentSpace<span className="brand-caption">AI Agent 空间管理</span>
        </span>
      </div>
      <nav className="main-nav" aria-label="会话清理页面">
        {PAGES.map((id) => (
          <button
            className={`nav-item${page === id ? ' active' : ''}`}
            type="button"
            key={id}
            onClick={() => controller.setPage(id)}
            aria-current={page === id ? 'page' : undefined}
          >
            <Icon name={id} />
            <span>{PAGE_LABELS[id]}</span>
            {count(id) ? <span className="nav-count">{count(id)}</span> : null}
          </button>
        ))}
      </nav>
      <SourceFilters controller={controller} />
      <button
        className="add-source"
        type="button"
        onClick={controller.importSource}
        disabled={controller.isBusy}
      >
        <Icon name="add" />
        添加 Agent 目录
      </button>
      <div className="sidebar-bottom">
        <div className="sidebar-foot">
          <span className="local-dot" />
          本机处理<span>CodexStatus</span>
        </div>
      </div>
    </aside>
  )
}

function WindowControls(): ReactNode {
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    const unsubscribe = window.sessionCleaner.onWindowMaximized(setMaximized)
    void window.sessionCleaner
      .isWindowMaximized()
      .then(setMaximized)
      .catch(() => undefined)
    return unsubscribe
  }, [])

  return (
    <div className="window-controls" role="group" aria-label="窗口控制">
      <button
        className="window-control"
        type="button"
        title="最小化"
        aria-label="最小化"
        onClick={window.sessionCleaner.minimizeWindow}
      >
        <Icon name="minimize" />
      </button>
      <button
        className="window-control"
        type="button"
        title={maximized ? '还原' : '最大化'}
        aria-label={maximized ? '还原' : '最大化'}
        onClick={window.sessionCleaner.toggleMaximizeWindow}
      >
        <Icon name={maximized ? 'windowRestore' : 'maximize'} />
      </button>
      <button
        className="window-control window-control-close"
        type="button"
        title="关闭"
        aria-label="关闭"
        onClick={window.sessionCleaner.closeWindow}
      >
        <Icon name="close" />
      </button>
    </div>
  )
}

function progressSuffix(progress: CleanerProgress | null, phase: CleanerProgress['phase']): string {
  if (!progress || progress.phase !== phase) return ''
  if (progress.completed !== undefined && progress.total !== undefined && progress.total > 0)
    return ' · ' + progress.completed + '/' + progress.total + ' 项'
  if (phase === 'scan') return ' · ' + progress.visited + ' 项'
  return ''
}

function workspaceActivityLabel(controller: SessionCleanerController): string {
  const { progress, busy } = controller.ui
  if (controller.scanActive) return '扫描中' + progressSuffix(progress, 'scan')
  if (progress?.phase === 'export' || busy === 'export')
    return '导出中' + progressSuffix(progress, 'export')
  if (progress?.phase === 'delete' || busy === 'recycle')
    return '永久删除中' + progressSuffix(progress, 'delete')
  if (progress?.phase === 'compact' || busy === 'compact')
    return '整理数据库中' + progressSuffix(progress, 'compact')
  return controller.isBusy ? '处理中' : '本地数据'
}

export function WorkspaceHeader({
  controller
}: {
  controller: SessionCleanerController
}): ReactNode {
  const label = workspaceActivityLabel(controller)
  return (
    <header className="topbar">
      <div className="breadcrumb">
        个人工作台
        <Icon name="chevron" />
        <span>{PAGE_LABELS[controller.ui.page]}</span>
      </div>
      <div className="topbar-right">
        <span className="prototype-label" role="status" aria-live="polite">
          {label}
        </span>
        {['scan', 'recycle', 'export', 'compact'].includes(controller.ui.busy ?? '') ||
        controller.ui.data?.scanning ||
        controller.ui.data?.recycling ? (
          <button
            className="text-button"
            type="button"
            onClick={controller.cancelOperation}
            disabled={controller.ui.cancelPending}
          >
            {controller.ui.cancelPending ? '取消中…' : '取消当前操作'}
          </button>
        ) : null}
        <HelpTip
          text="按需扫描本机目录。永久删除会直接移除所选会话；确认前提供逐项预览。Token 与费用历史统计会保留。"
          label="查看本机处理说明"
        />
        <WindowControls />
      </div>
    </header>
  )
}

export function Feedback({ controller }: { controller: SessionCleanerController }): ReactNode {
  const { notice, error } = controller.ui
  const clearNotice = controller.clearNotice
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(clearNotice, NOTICE_DURATION_MS)
    return () => clearTimeout(timer)
  }, [notice, clearNotice])
  return (
    <div className="feedback-stack">
      {error ? (
        <div className="feedback feedback-error" role="alert">
          <Icon name="info" />
          <span>{error}</span>
          <button
            className="icon-button"
            type="button"
            onClick={controller.clearError}
            aria-label="关闭错误提示"
          >
            <Icon name="close" />
          </button>
        </div>
      ) : null}
      {notice ? (
        <div className="toast" role="status" aria-live="polite">
          <span>{notice}</span>
          <button
            className="icon-button"
            type="button"
            onClick={clearNotice}
            aria-label="关闭操作提示"
          >
            <Icon name="close" />
          </button>
        </div>
      ) : null}
    </div>
  )
}
