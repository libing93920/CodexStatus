import { useCallback } from 'react'
import type { Dispatch, MutableRefObject } from 'react'
import { DEFAULT_CLEANER_SETTINGS } from '../../../../shared/session-cleaner'
import type { CleanerSettings, SessionCleanerApi } from '../../../../shared/session-cleaner'
import { parseSettingsDraft, settingsToDraft, sourcesEqual } from './model'
import { canResumeSession, getExportableIds } from './manager-model'
import { reduceCleanerUiState } from './state'
import type { BusyAction, CleanerUiState } from './state'
import type { ApiExecutor, SessionCleanerController } from './hooks'

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请重试。'
}

export function useScanActions(
  ui: CleanerUiState,
  api: SessionCleanerApi,
  execute: ApiExecutor,
  dispatch: Dispatch<Parameters<typeof reduceCleanerUiState>[1]>,
  busyRef: MutableRefObject<BusyAction | null>,
  cancelRef: MutableRefObject<boolean>
): Pick<SessionCleanerController, 'scan' | 'cancelScan'> {
  const scan = useCallback((): void => {
    dispatch({ type: 'invalidate', clearSelection: true })
    dispatch({ type: 'progress', progress: null })
    void execute('scan', api.scan, (data) => {
      dispatch({ type: 'data', data, clearSelection: true, invalidateReview: true })
      dispatch({
        type: 'notice',
        message: `扫描结束：${data.items.filter((item) => item.category === 'sessions').length} 个会话，${data.items.filter((item) => item.category !== 'sessions').length} 个资源，${data.issues.length} 条问题或提示。`
      })
    })
  }, [api, dispatch, execute])
  const cancelScan = useCallback((): void => {
    const active = busyRef.current === 'scan' || (!busyRef.current && Boolean(ui.data?.scanning))
    if (!active || cancelRef.current) return
    cancelRef.current = true
    dispatch({ type: 'cancel-pending', value: true })
    void api
      .cancelScan()
      .then(
        () => dispatch({ type: 'notice', message: '取消请求已发送，等待扫描结束。' }),
        (error: unknown) => dispatch({ type: 'error', message: errorText(error) })
      )
      .finally(() => {
        cancelRef.current = false
        dispatch({ type: 'cancel-pending', value: false })
      })
  }, [api, busyRef, cancelRef, dispatch, ui.data?.scanning])
  return { scan, cancelScan }
}

export function useSourceActions(
  ui: CleanerUiState,
  api: SessionCleanerApi,
  execute: ApiExecutor,
  dispatch: Dispatch<Parameters<typeof reduceCleanerUiState>[1]>
): Pick<SessionCleanerController, 'discover' | 'importSource' | 'removeSource'> {
  const discover = (): void => {
    dispatch({ type: 'invalidate', clearSelection: true })
    void execute('discover', api.discover, (data) => {
      dispatch({ type: 'data', data, clearSelection: true, invalidateReview: true })
      dispatch({ type: 'notice', message: `来源检查完成：${data.sources.length} 个来源。` })
    })
  }
  const importSource = (): void => {
    void execute('import', api.importSource, (data) => {
      const changed = !ui.data || !sourcesEqual(ui.data.sources, data.sources)
      dispatch({ type: 'data', data, clearSelection: changed, invalidateReview: changed })
      dispatch({ type: 'notice', message: changed ? '来源列表已更新。' : '没有新增来源。' })
    })
  }
  const removeSource = (id: string): void => {
    dispatch({ type: 'invalidate', clearSelection: true })
    void execute(
      'remove',
      () => api.removeSource(id),
      (data) => {
        dispatch({ type: 'data', data, clearSelection: true, invalidateReview: true })
        dispatch({ type: 'notice', message: '来源已从清理列表移除；原目录内容未被删除。' })
      }
    )
  }
  return { discover, importSource, removeSource }
}

export function useSelectionActions(
  dispatch: Dispatch<Parameters<typeof reduceCleanerUiState>[1]>
): Pick<
  SessionCleanerController,
  'setPage' | 'setFilters' | 'toggleSelection' | 'toggleVisibleSelection' | 'clearSelection'
> {
  return {
    setPage: (page) => dispatch({ type: 'page', page }),
    setFilters: (filters) => dispatch({ type: 'filters', filters }),
    toggleSelection: (id) => dispatch({ type: 'toggle-selection', id }),
    toggleVisibleSelection: (ids) => dispatch({ type: 'toggle-visible-selection', ids }),
    clearSelection: () => dispatch({ type: 'clear-selection' })
  }
}

export function reloadInvalidatedDetail(
  ui: Pick<CleanerUiState, 'busy' | 'data' | 'detailReloadId'>,
  api: SessionCleanerApi,
  execute: ApiExecutor,
  dispatch: Dispatch<Parameters<typeof reduceCleanerUiState>[1]>
): void {
  const id = ui.detailReloadId
  if (!id || ui.busy) return
  const item = ui.data?.items.find((entry) => entry.id === id)
  dispatch({ type: 'detail-reload-start', id })
  if (!item?.managed?.capabilities.read) return
  void execute(
    'details',
    () => api.transcript(id),
    (details) => dispatch({ type: 'detail-loaded', id, details })
  )
}

export function useItemActions(
  ui: CleanerUiState,
  api: SessionCleanerApi,
  execute: ApiExecutor,
  dispatch: Dispatch<Parameters<typeof reduceCleanerUiState>[1]>
): Pick<SessionCleanerController, 'protect' | 'openDetails' | 'closeDetails' | 'reveal'> {
  const protect = (ids: string[], protectedValue: boolean): void => {
    const selected = new Set(ids)
    const validIds =
      ui.data?.items
        .filter((item) => item.status !== 'active' && selected.has(item.id))
        .map((item) => item.id) ?? []
    if (!validIds.length) return
    dispatch({ type: 'invalidate', clearSelection: true })
    void execute(
      'protect',
      () => api.protect(validIds, protectedValue),
      (data) => {
        dispatch({ type: 'data', data, clearSelection: true, invalidateReview: true })
        dispatch({
          type: 'notice',
          message: protectedValue ? '已保护所选项。' : '已解除保护；请重新扫描以重新核验。'
        })
      }
    )
  }
  const openDetails = (id: string): void => {
    dispatch({ type: 'detail-open', id })
    if (Object.prototype.hasOwnProperty.call(ui.details, id)) return
    const item = ui.data?.items.find((entry) => entry.id === id)
    if (!item?.managed?.capabilities.read) return
    void execute(
      'details',
      () => api.transcript(id),
      (details) => dispatch({ type: 'detail-loaded', id, details })
    )
  }
  const closeDetails = (): void => dispatch({ type: 'detail-open', id: null })
  const reveal = (id: string): void => {
    void execute(
      'reveal',
      () => api.reveal(id),
      () => dispatch({ type: 'notice', message: '已请求在文件管理器中定位条目。' })
    )
  }
  return { protect, openDetails, closeDetails, reveal }
}

export function useManagerActions(
  ui: CleanerUiState,
  api: SessionCleanerApi,
  execute: ApiExecutor,
  dispatch: Dispatch<Parameters<typeof reduceCleanerUiState>[1]>
): Pick<SessionCleanerController, 'exportSessions' | 'resumeSession' | 'compactDatabase'> {
  const exportSessions = (ids = ui.selectedIds): void => {
    const requestedIds = getExportableIds(ui.data?.items ?? [], ids)
    if (!requestedIds.length) return
    void execute(
      'export',
      async () => {
        const result = await api.exportSessions(requestedIds)
        return { result, data: await api.getState(), requested: requestedIds.length }
      },
      ({ result, data, requested }) => {
        dispatch({ type: 'data', data })
        const action = result.cancelled ? '导出已取消' : '导出完成'
        dispatch({
          type: 'notice',
          message: `${action}：${result.count}/${requested} 项；逐项结果已记入操作记录。`
        })
      }
    )
  }
  const resumeSession = (id: string): void => {
    const item = ui.data?.items.find((entry) => entry.id === id)
    if (!item || !canResumeSession(item)) return
    void execute(
      'resume',
      () => api.resumeSession(id),
      () => {
        dispatch({ type: 'notice', message: '已请求在对应 Agent 中继续此会话。' })
      }
    )
  }
  const compactDatabase = (sourceId: string): void => {
    const source = ui.data?.sources.find((entry) => entry.id === sourceId)
    if (
      source?.kind !== 'opencode' ||
      !ui.data?.storage?.some((entry) => entry.sourceId === sourceId)
    )
      return
    void execute(
      'compact',
      () => api.compactDatabase(sourceId),
      (data) => {
        dispatch({ type: 'data', data, clearSelection: true, invalidateReview: true })
        dispatch({ type: 'notice', message: '数据库整理已完成；空间数据与逐项结果已刷新。' })
      }
    )
  }
  return { exportSessions, resumeSession, compactDatabase }
}

export function useCancelOperation(
  ui: CleanerUiState,
  api: SessionCleanerApi,
  busyRef: MutableRefObject<BusyAction | null>,
  cancelOperationRef: MutableRefObject<boolean>,
  dispatch: Dispatch<Parameters<typeof reduceCleanerUiState>[1]>
): () => void {
  return () => {
    const active = Boolean(
      busyRef.current === 'scan' ||
      busyRef.current === 'recycle' ||
      busyRef.current === 'export' ||
      busyRef.current === 'compact' ||
      ui.data?.scanning ||
      ui.data?.recycling
    )
    if (!active || cancelOperationRef.current) return
    const activeAction = busyRef.current
    cancelOperationRef.current = true
    dispatch({ type: 'cancel-pending', value: true })
    void api
      .cancelOperation()
      .then(
        () => {
          if (activeAction && busyRef.current === activeAction)
            dispatch({ type: 'notice', message: '取消请求已发送，正在等待当前操作结束。' })
        },
        (error: unknown) => {
          cancelOperationRef.current = false
          dispatch({ type: 'cancel-pending', value: false })
          dispatch({ type: 'error', message: errorText(error) })
        }
      )
      .finally(() => {
        if (!busyRef.current) {
          cancelOperationRef.current = false
          dispatch({ type: 'cancel-pending', value: false })
        }
      })
  }
}

export function useSettingsActions(
  ui: CleanerUiState,
  api: SessionCleanerApi,
  execute: ApiExecutor,
  dispatch: Dispatch<Parameters<typeof reduceCleanerUiState>[1]>
): Pick<SessionCleanerController, 'changeSetting' | 'resetSettings' | 'saveSettings'> {
  const changeSetting = (key: keyof CleanerSettings, value: string): void => {
    dispatch({ type: 'settings-draft', key, value })
  }
  const resetSettings = (): void =>
    dispatch({ type: 'settings-reset', draft: settingsToDraft(DEFAULT_CLEANER_SETTINGS) })
  const saveSettings = (): void => {
    const settings = ui.settingsDraft ? parseSettingsDraft(ui.settingsDraft) : null
    if (!settings) {
      dispatch({ type: 'error', message: '策略值无效，请检查字段范围和期限关系。' })
      return
    }
    dispatch({ type: 'invalidate', clearSelection: true })
    void execute(
      'settings',
      () => api.saveSettings(settings),
      (data) => {
        dispatch({
          type: 'data',
          data,
          clearSelection: true,
          invalidateReview: true,
          settingsSaved: true
        })
        dispatch({ type: 'notice', message: '策略已保存；旧扫描已清除，请重新扫描。' })
      }
    )
  }
  return { changeSetting, resetSettings, saveSettings }
}
