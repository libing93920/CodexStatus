import type {
  CleanerItem,
  CleanerPlan,
  CleanerProgress,
  CleanerState
} from '../../../../shared/session-cleaner'
import type { SessionDetails } from '../../../../shared/session-manager'
import { DEFAULT_ITEM_FILTERS, settingsToDraft, sourcesEqual } from './model'
import { isItemSelectable } from './manager-model'
import type { CleanerSettingsDraft, ItemFilters, PageId } from './model'

export type BusyAction =
  | 'load'
  | 'discover'
  | 'import'
  | 'remove'
  | 'scan'
  | 'export'
  | 'resume'
  | 'compact'
  | 'protect'
  | 'settings'
  | 'review'
  | 'recycle'
  | 'details'
  | 'reveal'
  | 'recycle-bin'

export interface CleanerUiState {
  data: CleanerState | null
  page: PageId
  busy: BusyAction | null
  progress: CleanerProgress | null
  cancelPending: boolean
  error: string | null
  notice: string | null
  filters: ItemFilters
  selectedIds: string[]
  detailId: string | null
  details: Record<string, SessionDetails>
  detailReloadId: string | null
  plan: CleanerPlan | null
  reviewInvalidated: boolean
  confirmOpen: boolean
  settingsDraft: CleanerSettingsDraft | null
}

export const INITIAL_CLEANER_UI_STATE: CleanerUiState = {
  data: null,
  page: 'overview',
  busy: null,
  progress: null,
  cancelPending: false,
  error: null,
  notice: null,
  filters: DEFAULT_ITEM_FILTERS,
  selectedIds: [],
  detailId: null,
  details: {},
  detailReloadId: null,
  plan: null,
  reviewInvalidated: false,
  confirmOpen: false,
  settingsDraft: null
}

type CleanerUiAction =
  | { type: 'page'; page: PageId }
  | { type: 'busy'; busy: BusyAction | null }
  | {
      type: 'data'
      data: CleanerState
      clearSelection?: boolean
      invalidateReview?: boolean
      settingsSaved?: boolean
    }
  | { type: 'progress'; progress: CleanerProgress | null }
  | { type: 'cancel-pending'; value: boolean }
  | { type: 'error'; message: string; invalidateReview?: boolean }
  | { type: 'clear-error' }
  | { type: 'notice'; message: string | null }
  | { type: 'filters'; filters: Partial<ItemFilters> }
  | { type: 'toggle-selection'; id: string }
  | { type: 'toggle-visible-selection'; ids: string[] }
  | { type: 'clear-selection' }
  | { type: 'invalidate'; clearSelection?: boolean }
  | { type: 'plan'; plan: CleanerPlan }
  | { type: 'detail-open'; id: string | null }
  | { type: 'detail-reload-start'; id: string }
  | { type: 'detail-loaded'; id: string; details: SessionDetails }
  | { type: 'settings-draft'; key: keyof CleanerSettingsDraft; value: string }
  | { type: 'settings-reset'; draft: CleanerSettingsDraft }
  | { type: 'confirm'; open: boolean }

function invalidateReview(state: CleanerUiState, clearSelection = false): CleanerUiState {
  return {
    ...state,
    plan: null,
    reviewInvalidated: state.reviewInvalidated || Boolean(state.plan),
    confirmOpen: false,
    selectedIds: clearSelection ? [] : state.selectedIds
  }
}

function receiveData(
  state: CleanerUiState,
  action: Extract<CleanerUiAction, { type: 'data' }>
): CleanerUiState {
  const sourceChanged =
    state.data !== null && !sourcesEqual(state.data.sources, action.data.sources)
  const invalidates = Boolean(action.invalidateReview || sourceChanged)
  const clearSelection = Boolean(action.clearSelection || sourceChanged)
  const availableIds = new Set(action.data.items.filter(isItemSelectable).map((item) => item.id))
  const selectedIds = clearSelection ? [] : state.selectedIds.filter((id) => availableIds.has(id))
  const previous = new Map(state.data?.items.map((item) => [item.id, item]))
  const current = new Map(action.data.items.map((item) => [item.id, item]))
  const detailId = state.detailId && current.has(state.detailId) ? state.detailId : null
  const before = detailId ? previous.get(detailId) : undefined
  const after = detailId ? current.get(detailId) : undefined
  const sameRevision = Boolean(
    before &&
    after &&
    (before.managed?.revision ?? before.fingerprint) ===
      (after.managed?.revision ?? after.fingerprint)
  )
  const hasCachedDetail = Boolean(
    detailId && Object.prototype.hasOwnProperty.call(state.details, detailId)
  )
  const details =
    detailId && hasCachedDetail && sameRevision ? { [detailId]: state.details[detailId] } : {}
  const canReadDetail = after?.managed?.capabilities.read === true
  const detailReloadId =
    detailId &&
    canReadDetail &&
    (state.detailReloadId === detailId || (hasCachedDetail && !sameRevision))
      ? detailId
      : null
  return {
    ...state,
    data: action.data,
    selectedIds,
    details,
    detailId,
    detailReloadId,
    plan: invalidates ? null : state.plan,
    reviewInvalidated: invalidates
      ? state.reviewInvalidated || Boolean(state.plan)
      : state.reviewInvalidated,
    confirmOpen: invalidates ? false : state.confirmOpen,
    settingsDraft:
      action.settingsSaved || !state.settingsDraft
        ? settingsToDraft(action.data.settings)
        : state.settingsDraft
  }
}

function toggleSelection(state: CleanerUiState, ids: string[]): CleanerUiState {
  const candidates = new Set(
    state.data?.items.filter(isItemSelectable).map((item) => item.id) ?? []
  )
  const validIds = [...new Set(ids)].filter((id) => candidates.has(id))
  if (!validIds.length) return state
  const selected = new Set(state.selectedIds)
  const shouldSelect = validIds.some((id) => !selected.has(id))
  for (const id of validIds) shouldSelect ? selected.add(id) : selected.delete(id)
  return invalidateReview({ ...state, selectedIds: [...selected] })
}

function updateSettingsDraft(state: CleanerUiState, draft: CleanerSettingsDraft): CleanerUiState {
  return invalidateReview({ ...state, settingsDraft: draft })
}

export function reduceCleanerUiState(
  state: CleanerUiState,
  action: CleanerUiAction
): CleanerUiState {
  switch (action.type) {
    case 'page':
      return { ...state, page: action.page }
    case 'busy':
      return { ...state, busy: action.busy, error: action.busy ? null : state.error }
    case 'data':
      return receiveData(state, action)
    case 'progress':
      return { ...state, progress: action.progress }
    case 'cancel-pending':
      return { ...state, cancelPending: action.value }
    case 'error':
      return {
        ...(action.invalidateReview ? invalidateReview(state) : state),
        error: action.message
      }
    case 'clear-error':
      return { ...state, error: null }
    case 'notice':
      return { ...state, notice: action.message }
    case 'filters':
      return { ...state, filters: { ...state.filters, ...action.filters } }
    case 'toggle-selection':
      return toggleSelection(state, [action.id])
    case 'toggle-visible-selection':
      return toggleSelection(state, action.ids)
    case 'clear-selection':
      return state.selectedIds.length ? invalidateReview({ ...state, selectedIds: [] }) : state
    case 'invalidate':
      return invalidateReview(state, action.clearSelection)
    case 'plan':
      return { ...state, plan: action.plan, reviewInvalidated: false, confirmOpen: false }
    case 'detail-open': {
      const details =
        action.id && Object.prototype.hasOwnProperty.call(state.details, action.id)
          ? { [action.id]: state.details[action.id] }
          : {}
      return { ...state, detailId: action.id, details, detailReloadId: null }
    }
    case 'detail-reload-start':
      return state.detailReloadId === action.id ? { ...state, detailReloadId: null } : state
    case 'detail-loaded':
      return state.detailId === action.id
        ? { ...state, details: { [action.id]: action.details }, detailReloadId: null }
        : state
    case 'settings-draft':
      return updateSettingsDraft(state, { ...state.settingsDraft!, [action.key]: action.value })
    case 'settings-reset':
      return updateSettingsDraft(state, action.draft)
    case 'confirm':
      return { ...state, confirmOpen: action.open }
  }
}

export function candidateSelection(items: CleanerItem[], ids: string[]): CleanerItem[] {
  const selected = new Set(ids)
  return items.filter((item) => item.status === 'candidate' && selected.has(item.id))
}
