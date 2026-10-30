import type { ReactNode } from 'react'
import type { SessionMutationPreview } from '../../../../../shared/session-manager'
import type { CleanerItem, CleanerPlan, CleanerState } from '../../../../../shared/session-cleaner'
import { EmptyState, HelpTip, Icon, PageHeading } from '../components'
import { formatBytes } from '../model'
import { canPermanentlyDelete, getExportableIds, getPlanWarnings } from '../manager-model'
import { ConfirmationDialog } from './RecycleConfirmation'

function previewForItem(plan: CleanerPlan, item: CleanerItem): SessionMutationPreview | undefined {
  const sessionId = item.managed?.sessionId
  return sessionId
    ? plan.previews?.find(
        (preview) =>
          preview.session.sessionId === sessionId && preview.session.sourceId === item.sourceId
      )
    : undefined
}

function PreviewItem({
  item,
  data,
  plan
}: {
  item: CleanerItem
  data: CleanerState | null
  plan: CleanerPlan | null
}): ReactNode {
  const preview = plan ? previewForItem(plan, item) : undefined
  const sourceName =
    data?.sources.find((source) => source.id === item.sourceId)?.name ?? '未提供来源'
  return (
    <article className="manager-preview-row" data-item-id={item.id}>
      <Icon name="items" />
      <div>
        <h3>{item.title}</h3>
        <code>{item.path}</code>
        <p>
          {sourceName} · {item.managed?.storage.kind ?? '文件资源'}
        </p>
        {preview?.warnings.length ? (
          <ul className="manager-inline-warnings">
            {preview.warnings.map((warning, index) => (
              <li key={`${warning}-${index}`}>{warning}</li>
            ))}
          </ul>
        ) : null}
      </div>
      <span className="numeric-cell">
        <strong>{formatBytes(preview?.fileBytes ?? item.bytes)}</strong>
        <small>
          {preview?.logicalBytes === undefined
            ? '会话数据量未提供'
            : `逻辑 ${formatBytes(preview.logicalBytes)}`}
        </small>
      </span>
    </article>
  )
}

function ExcludedItems({ plan }: { plan: CleanerPlan }): ReactNode {
  if (!plan.excluded.length) return null
  return (
    <details className="manager-excluded-items">
      <summary>预览排除 {plan.excluded.length} 项</summary>
      <ul>
        {plan.excluded.map((entry) => (
          <li key={entry.id}>
            <code>{entry.id}</code>
            <span>{entry.reason}</span>
          </li>
        ))}
      </ul>
    </details>
  )
}

function PreviewWarnings({ warnings }: { warnings: string[] }): ReactNode {
  if (!warnings.length) return null
  return (
    <div className="notice amber manager-preview-warnings" role="status">
      <Icon name="info" />
      <ul>
        {warnings.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
    </div>
  )
}

function SelectedUnavailable({ items }: { items: CleanerItem[] }): ReactNode {
  const unavailable = items.filter((item) => !canPermanentlyDelete(item))
  if (!unavailable.length) return null
  return (
    <details className="manager-excluded-items">
      <summary>所选中有 {unavailable.length} 项不能永久删除</summary>
      <ul>
        {unavailable.map((item) => (
          <li key={item.id}>
            <strong>{item.title}</strong>
            <span>
              {item.managed?.capabilities.deleteReason ?? item.reason ?? '来源未提供删除能力'}
            </span>
          </li>
        ))}
      </ul>
      <p>受保护和正在使用的会话始终禁止删除；近期建议不会替代删除能力判断。</p>
    </details>
  )
}

export interface ReviewPageProps {
  data: CleanerState | null
  selectedItems: CleanerItem[]
  plan: CleanerPlan | null
  invalidated: boolean
  confirmOpen: boolean
  canReview: boolean
  canDelete: boolean
  isBusy: boolean
  onCreateReview: () => void
  onOpenConfirmation: () => void
  onCloseConfirmation: () => void
  onConfirmDelete: (exportBeforeDelete?: boolean) => void
  onItems: () => void
}

export function ReviewPage(props: ReviewPageProps): ReactNode {
  const deletableItems = props.selectedItems.filter(canPermanentlyDelete)
  const rawPlan = props.plan && !props.invalidated ? props.plan : null
  const plan = rawPlan?.deletionMode === 'permanent' ? rawPlan : null
  const items = plan?.items ?? deletableItems
  const exportableCount = plan ? getExportableIds(plan.items).length : 0
  const warnings = plan ? getPlanWarnings(plan) : []
  const logicalBytes = plan?.logicalBytes
  const selectionAction = (
    <button className="button" type="button" onClick={props.onItems}>
      <Icon name="items" />
      返回会话管理
    </button>
  )
  return (
    <>
      <PageHeading
        id="review-heading"
        title="永久删除预览"
        description="先检查逐项范围、文件清单与警告，再确认直接永久删除。"
        actions={selectionAction}
      />
      {props.invalidated ? (
        <p className="notice amber" role="status">
          预览已失效。扫描或来源发生变化后，必须重新生成逐项预览。
        </p>
      ) : null}
      {rawPlan && !plan ? (
        <p className="notice danger" role="alert">
          预览未声明永久删除模式，已阻止执行。
        </p>
      ) : null}
      {!plan ? (
        <section className="panel manager-review-panel">
          <div className="manager-review-summary">
            <div>
              <span>已选会话</span>
              <strong>{props.selectedItems.length}</strong>
            </div>
            <div>
              <span>可永久删除</span>
              <strong>{deletableItems.length}</strong>
            </div>
            <HelpTip text="每个会话的删除能力与近期建议分别处理。受保护或正在使用的会话不能删除。" />
          </div>
          <SelectedUnavailable items={props.selectedItems} />
          {!deletableItems.length ? (
            <EmptyState
              title="没有可删除的选择"
              description="返回会话管理，按删除能力选择会话或可操作资源。"
            />
          ) : (
            <button
              className="button primary"
              type="button"
              disabled={props.isBusy || !props.canReview}
              onClick={props.onCreateReview}
            >
              <Icon name="review" />
              生成永久删除预览（{deletableItems.length} 项）
            </button>
          )}
        </section>
      ) : (
        <>
          <section className="manager-preview-summary" aria-label="删除预览摘要">
            <div>
              <span>将要删除</span>
              <strong>{plan.items.length} 项</strong>
            </div>
            <div>
              <span>关联文件</span>
              <strong>{formatBytes(plan.totalBytes)}</strong>
            </div>
            <div>
              <span>会话数据</span>
              <strong>{logicalBytes === undefined ? '未提供' : formatBytes(logicalBytes)}</strong>
            </div>
            <div>
              <span>执行方式</span>
              <strong>永久删除</strong>
            </div>
            <button
              className="button danger"
              type="button"
              onClick={props.onOpenConfirmation}
              disabled={!props.canDelete || props.isBusy}
            >
              <Icon name="records" />
              确认永久删除
            </button>
          </section>
          <PreviewWarnings warnings={warnings} />
          <section className="manager-preview-list" aria-label="逐项删除预览">
            {items.map((item) => (
              <PreviewItem key={item.id} item={item} data={props.data} plan={plan} />
            ))}
          </section>
          <ExcludedItems plan={plan} />
          <div className="manager-preview-footer">
            <span>预览后的扫描与来源变化会使清单失效。</span>
            <button
              className="text-button"
              type="button"
              onClick={props.onCreateReview}
              disabled={props.isBusy || !props.canReview}
            >
              重新生成预览
            </button>
          </div>
          {props.confirmOpen ? (
            <ConfirmationDialog
              open={props.confirmOpen}
              count={plan.items.length}
              attributedBytes={plan.totalBytes}
              logicalBytes={plan.logicalBytes}
              warnings={warnings}
              exportableCount={exportableCount}
              busy={props.isBusy}
              onClose={props.onCloseConfirmation}
              onConfirm={props.onConfirmDelete}
            />
          ) : null}
        </>
      )}
    </>
  )
}
