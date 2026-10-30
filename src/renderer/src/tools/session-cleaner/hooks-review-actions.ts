import type { Dispatch } from 'react'
import type {
  CleanerPlan,
  CleanerState,
  SessionCleanerApi
} from '../../../../shared/session-cleaner'
import { canPermanentlyDelete, getDeletableIds, getExportableIds } from './manager-model'
import { recycleAndRefresh } from './recycle'
import { reduceCleanerUiState } from './state'
import type { CleanerUiState } from './state'
import type { ApiExecutor, SessionCleanerController } from './hooks'

type DeletionResult = {
  data: CleanerState
  deletionRequested: boolean
  exported: { count: number; cancelled: boolean } | null
  requested: number
}

function hasValidDeletionPlan(plan: CleanerPlan | null): plan is CleanerPlan {
  return Boolean(
    plan?.items.length &&
    plan.deletionMode === 'permanent' &&
    plan.items.every(canPermanentlyDelete)
  )
}

function createReviewAction(
  ui: CleanerUiState,
  api: SessionCleanerApi,
  execute: ApiExecutor,
  dispatch: Dispatch<Parameters<typeof reduceCleanerUiState>[1]>
): () => void {
  return () => {
    const data = ui.data
    if (!data?.scannedAt)
      return dispatch({ type: 'error', message: '请先扫描来源，再生成审核方案。' })
    const ids = getDeletableIds(data.items, ui.selectedIds)
    if (!ids.length) return dispatch({ type: 'error', message: '所选项没有可用的永久删除能力。' })
    dispatch({ type: 'invalidate' })
    void execute(
      'review',
      () => api.review(ids),
      (plan) => {
        if (plan.deletionMode !== 'permanent') {
          dispatch({
            type: 'error',
            message: '主进程未确认永久删除模式；没有执行删除。',
            invalidateReview: true
          })
          return
        }
        dispatch({ type: 'plan', plan })
        dispatch({
          type: 'notice',
          message:
            '永久删除预览已生成：' +
            plan.items.length +
            ' 项通过，' +
            plan.excluded.length +
            ' 项排除。'
        })
      }
    )
  }
}

function createOpenConfirmation(
  plan: CleanerPlan | null,
  dispatch: Dispatch<Parameters<typeof reduceCleanerUiState>[1]>
): () => void {
  return () => {
    if (!hasValidDeletionPlan(plan))
      return dispatch({ type: 'error', message: '没有有效的永久删除预览，请重新生成预览。' })
    dispatch({ type: 'confirm', open: true })
  }
}

function finishDeletion(
  plan: CleanerPlan,
  result: DeletionResult,
  dispatch: Dispatch<Parameters<typeof reduceCleanerUiState>[1]>
): void {
  dispatch({
    type: 'data',
    data: result.data,
    invalidateReview: result.deletionRequested
  })
  if (!result.deletionRequested) {
    dispatch({
      type: 'notice',
      message:
        '导出已取消或未完成：' +
        (result.exported?.count ?? 0) +
        '/' +
        result.requested +
        ' 项；没有执行删除。'
    })
    return
  }
  const deletedCount = result.data.records.filter(
    (record) => record.batchId === plan.id && record.status === 'deleted'
  ).length
  const message =
    deletedCount === plan.items.length
      ? '永久删除已完成：' + deletedCount + ' 项；逐项结果已记入操作记录。'
      : deletedCount > 0
        ? '永久删除已确认 ' +
          deletedCount +
          '/' +
          plan.items.length +
          ' 项；其余未确认或未处理，请查看操作记录。'
        : '没有条目确认删除；请查看操作记录核对结果。'
  dispatch({ type: 'notice', message })
}

function createConfirmDelete(
  ui: CleanerUiState,
  api: SessionCleanerApi,
  execute: ApiExecutor,
  dispatch: Dispatch<Parameters<typeof reduceCleanerUiState>[1]>
): (exportBeforeDelete?: boolean) => void {
  return (exportBeforeDelete = false): void => {
    const plan = ui.plan
    if (!hasValidDeletionPlan(plan)) {
      dispatch({ type: 'confirm', open: false })
      dispatch({
        type: 'error',
        message: '永久删除预览已失效或包含不可删除项，请重新生成预览。',
        invalidateReview: true
      })
      return
    }
    const ids = plan.items.map((item) => item.id)
    if (exportBeforeDelete && getExportableIds(plan.items).length !== ids.length) {
      dispatch({ type: 'error', message: '预览中有会话不支持导出；请取消导出选项或返回调整选择。' })
      return
    }
    dispatch({ type: 'confirm', open: false })
    void execute(
      'recycle',
      async () => {
        const exported = exportBeforeDelete ? await api.exportSessions(ids) : null
        if (exported && (exported.cancelled || exported.count < ids.length)) {
          return {
            data: await api.getState(),
            deletionRequested: false,
            exported,
            requested: ids.length
          }
        }
        const data = await recycleAndRefresh(api, plan.id, (latest) =>
          dispatch({ type: 'data', data: latest, clearSelection: true, invalidateReview: true })
        )
        return { data, deletionRequested: true, exported, requested: ids.length }
      },
      (result) => finishDeletion(plan, result, dispatch)
    )
  }
}

export function useReviewActions(
  ui: CleanerUiState,
  api: SessionCleanerApi,
  execute: ApiExecutor,
  dispatch: Dispatch<Parameters<typeof reduceCleanerUiState>[1]>
): Pick<
  SessionCleanerController,
  'createReview' | 'openConfirmation' | 'closeConfirmation' | 'confirmDelete'
> {
  return {
    createReview: createReviewAction(ui, api, execute, dispatch),
    openConfirmation: createOpenConfirmation(ui.plan, dispatch),
    closeConfirmation: () => dispatch({ type: 'confirm', open: false }),
    confirmDelete: createConfirmDelete(ui, api, execute, dispatch)
  }
}
