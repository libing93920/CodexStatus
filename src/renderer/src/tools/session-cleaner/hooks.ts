import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { Dispatch, MutableRefObject } from 'react'
import type { CleanerSettings, SessionCleanerApi } from '../../../../shared/session-cleaner'
import { canPermanentlyDelete } from './manager-model'
import { INITIAL_CLEANER_UI_STATE, reduceCleanerUiState } from './state'
import type { BusyAction, CleanerUiState } from './state'
import {
  errorText,
  reloadInvalidatedDetail,
  useCancelOperation,
  useItemActions,
  useManagerActions,
  useScanActions,
  useSelectionActions,
  useSettingsActions,
  useSourceActions
} from './hooks-actions'
import { useReviewActions } from './hooks-review-actions'

export type ApiExecutor = <T>(
  action: BusyAction,
  request: () => Promise<T>,
  onSuccess: (value: T) => void
) => Promise<boolean>

export interface SessionCleanerController {
  ui: CleanerUiState
  isBusy: boolean
  scanActive: boolean
  canReview: boolean
  canDelete: boolean
  setPage: (page: CleanerUiState['page']) => void
  setFilters: (filters: Partial<CleanerUiState['filters']>) => void
  toggleSelection: (id: string) => void
  toggleVisibleSelection: (ids: string[]) => void
  clearSelection: () => void
  scan: () => void
  cancelScan: () => void
  cancelOperation: () => void
  discover: () => void
  importSource: () => void
  removeSource: (id: string) => void
  protect: (ids: string[], protectedValue: boolean) => void
  openDetails: (id: string) => void
  closeDetails: () => void
  reveal: (id: string) => void
  exportSessions: (ids?: string[]) => void
  resumeSession: (id: string) => void
  compactDatabase: (sourceId: string) => void
  openRecycleBin: () => void
  changeSetting: (key: keyof CleanerSettings, value: string) => void
  resetSettings: () => void
  saveSettings: () => void
  createReview: () => void
  openConfirmation: () => void
  closeConfirmation: () => void
  confirmDelete: (exportBeforeDelete?: boolean) => void
  clearError: () => void
  clearNotice: () => void
}

function useApiExecutor(
  dispatch: Dispatch<Parameters<typeof reduceCleanerUiState>[1]>,
  busyRef: MutableRefObject<BusyAction | null>,
  cancelOperationRef: MutableRefObject<boolean>
): ApiExecutor {
  return useCallback(
    async <T>(action: BusyAction, request: () => Promise<T>, onSuccess: (value: T) => void) => {
      if (busyRef.current) return false
      busyRef.current = action
      dispatch({ type: 'busy', busy: action })
      try {
        onSuccess(await request())
        return true
      } catch (error) {
        dispatch({
          type: 'error',
          message: errorText(error),
          invalidateReview: action === 'recycle'
        })
        return false
      } finally {
        busyRef.current = null
        dispatch({ type: 'busy', busy: null })
        if (cancelOperationRef.current) {
          cancelOperationRef.current = false
          dispatch({ type: 'cancel-pending', value: false })
        }
      }
    },
    [busyRef, cancelOperationRef, dispatch]
  )
}

function useInitialState(
  api: SessionCleanerApi,
  execute: ApiExecutor,
  dispatch: Dispatch<Parameters<typeof reduceCleanerUiState>[1]>,
  scan: () => void
): void {
  useEffect(() => {
    let active = true
    let loading = true
    let scanRequested = false
    const unsubscribeProgress = api.onProgress((progress) =>
      dispatch({ type: 'progress', progress })
    )
    const unsubscribeScan = api.onScanRequested(() => {
      if (loading) scanRequested = true
      else scan()
    })
    void execute('load', api.getState, (data) => dispatch({ type: 'data', data })).finally(() => {
      loading = false
      if (active && scanRequested) scan()
    })
    return () => {
      active = false
      unsubscribeProgress()
      unsubscribeScan()
    }
  }, [api, dispatch, execute, scan])
}

export function useSessionCleaner(): SessionCleanerController {
  const [ui, dispatch] = useReducer(reduceCleanerUiState, INITIAL_CLEANER_UI_STATE)
  const [api] = useState(() => window.sessionCleaner)
  const busyRef = useRef<BusyAction | null>(null)
  const cancelRef = useRef(false)
  const cancelOperationRef = useRef(false)
  const execute = useApiExecutor(dispatch, busyRef, cancelOperationRef)
  const scans = useScanActions(ui, api, execute, dispatch, busyRef, cancelRef)
  useInitialState(api, execute, dispatch, scans.scan)
  const cancelOperation = useCancelOperation(ui, api, busyRef, cancelOperationRef, dispatch)
  const sources = useSourceActions(ui, api, execute, dispatch)
  const selection = useSelectionActions(dispatch)
  const items = useItemActions(ui, api, execute, dispatch)
  const { busy, data, detailReloadId } = ui
  useEffect(() => {
    reloadInvalidatedDetail({ busy, data, detailReloadId }, api, execute, dispatch)
  }, [api, busy, data, detailReloadId, dispatch, execute])
  const manager = useManagerActions(ui, api, execute, dispatch)
  const settings = useSettingsActions(ui, api, execute, dispatch)
  const review = useReviewActions(ui, api, execute, dispatch)
  const isBusy = Boolean(ui.busy || ui.data?.scanning || ui.data?.recycling)
  const canReview = Boolean(ui.data?.scannedAt && !isBusy)
  const canDelete = Boolean(
    !isBusy &&
    ui.plan?.deletionMode === 'permanent' &&
    ui.plan.items.length &&
    ui.plan.items.every(canPermanentlyDelete)
  )
  const clearNotice = useCallback(() => dispatch({ type: 'notice', message: null }), [])
  return {
    ui,
    isBusy,
    scanActive: ui.busy === 'scan' || Boolean(ui.data?.scanning),
    canReview,
    canDelete,
    ...selection,
    ...scans,
    cancelOperation,
    ...sources,
    ...items,
    ...manager,
    ...settings,
    ...review,
    openRecycleBin: () => {
      void execute('recycle-bin', api.openRecycleBin, () =>
        dispatch({ type: 'notice', message: '已请求打开系统回收站。' })
      )
    },
    clearError: () => dispatch({ type: 'clear-error' }),
    clearNotice
  }
}
