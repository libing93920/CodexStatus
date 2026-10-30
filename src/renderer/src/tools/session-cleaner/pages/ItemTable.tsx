import { useMemo } from 'react'
import type { ReactNode } from 'react'
import type { CleanerItem, CleanerState } from '../../../../../shared/session-cleaner'
import type { SessionDetails } from '../../../../../shared/session-manager'
import { EmptyState } from '../components'
import type { ItemFilters } from '../model'
import { isItemSelectable } from '../manager-model'
import { ItemDetails } from './ItemDetails'
import { ItemRow } from './ItemRow'
import { Drawer } from './Drawer'

interface ItemTableProps {
  data: CleanerState
  items: CleanerItem[]
  selectedIds: string[]
  detailId: string | null
  details: SessionDetails | undefined
  detailLoaded: boolean
  detailsLoading: boolean
  isBusy: boolean
  filters: ItemFilters
  onSelect: (id: string) => void
  onSelectVisible: (ids: string[]) => void
  onDetails: (id: string) => void
  onCloseDetails: () => void
  onReveal: (id: string) => void
  onExport: (id: string) => void
  onResume: (id: string) => void
  onScan: () => void
}

function SessionTable(props: ItemTableProps): ReactNode {
  const selected = useMemo(() => new Set(props.selectedIds), [props.selectedIds])
  const ids = useMemo(
    () => props.items.filter(isItemSelectable).map((item) => item.id),
    [props.items]
  )
  const count = useMemo(() => ids.filter((id) => selected.has(id)).length, [ids, selected])
  const all = ids.length > 0 && count === ids.length
  return (
    <div className="calm-session-table-scroll">
      <table className="item-table manager-table calm-session-table" aria-label="会话管理列表">
        <thead>
          <tr>
            <th className="checkbox-cell" scope="col">
              <input
                type="checkbox"
                aria-label="选择本页会话"
                aria-checked={count > 0 && !all ? 'mixed' : all}
                checked={all}
                disabled={props.isBusy || !ids.length}
                ref={(input) => {
                  if (input) input.indeterminate = count > 0 && !all
                }}
                onChange={() => props.onSelectVisible(ids)}
              />
            </th>
            <th scope="col">会话</th>
            <th
              className="size-cell"
              scope="col"
              aria-sort={props.filters.sort === 'size-desc' ? 'descending' : 'none'}
            >
              大小
            </th>
            <th
              className="date-cell"
              scope="col"
              aria-sort={
                props.filters.sort === 'oldest'
                  ? 'ascending'
                  : props.filters.sort === 'newest'
                    ? 'descending'
                    : 'none'
              }
            >
              最近使用
            </th>
            <th className="status-cell" scope="col">
              删除状态
            </th>
            <th scope="col">
              <span className="sr-only">更多操作</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {props.items.map((item) => (
            <ItemRow
              key={item.id}
              data={props.data}
              item={item}
              selected={selected.has(item.id)}
              current={props.detailId === item.id}
              isBusy={props.isBusy}
              sizeBasis={props.filters.sizeBasis}
              onSelect={props.onSelect}
              onDetails={props.onDetails}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function ItemTable(props: ItemTableProps): ReactNode {
  const detailItem = useMemo(
    () => props.data.items.find((item) => item.id === props.detailId),
    [props.data.items, props.detailId]
  )
  return (
    <>
      {props.items.length ? (
        <SessionTable {...props} />
      ) : (
        <EmptyState
          title={props.data.scannedAt ? '没有匹配的会话' : '还没有扫描会话'}
          description={
            props.data.scannedAt
              ? '调整筛选条件，或切换到其他 Agent。'
              : '扫描本地 Agent 后显示真实会话。'
          }
          action={
            !props.data.scannedAt ? (
              <button
                className="button primary"
                type="button"
                disabled={props.isBusy}
                onClick={props.onScan}
              >
                扫描会话
              </button>
            ) : undefined
          }
        />
      )}
      {detailItem ? (
        <Drawer title="会话详情" className="calm-session-drawer" onClose={props.onCloseDetails}>
          <div className="calm-drawer-content">
            <ItemDetails
              data={props.data}
              item={detailItem}
              details={props.details}
              loaded={props.detailLoaded}
              loading={props.detailsLoading}
              isBusy={props.isBusy}
              onClose={props.onCloseDetails}
              onReveal={props.onReveal}
              onExport={props.onExport}
              onResume={props.onResume}
            />
          </div>
        </Drawer>
      ) : null}
    </>
  )
}
