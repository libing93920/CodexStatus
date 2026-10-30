import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { CleanerItem, CleanerState } from '../../../../../shared/session-cleaner'
import type { SessionDetails } from '../../../../../shared/session-manager'
import { Icon, PageHeading } from '../components'
import {
  canPermanentlyDelete,
  filterItems,
  getDeletableIds,
  getExportableIds,
  isItemSelectable
} from '../manager-model'
import type { ItemFilters } from '../model'
import { FilterPanel } from './ItemFilters'
import { ItemTable } from './ItemTable'

const PAGE_SIZE = 40

export interface ItemsPageProps {
  data: CleanerState | null
  filters: ItemFilters
  selectedIds: string[]
  detailId: string | null
  details: SessionDetails | undefined
  detailLoaded: boolean
  isBusy: boolean
  detailsLoading: boolean
  canReview: boolean
  onFilters: (filters: Partial<ItemFilters>) => void
  onSelect: (id: string) => void
  onSelectVisible: (ids: string[]) => void
  onClearSelection: () => void
  onProtect: (ids: string[], protectedValue: boolean) => void
  onDetails: (id: string) => void
  onCloseDetails: () => void
  onReveal: (id: string) => void
  onExport: (ids?: string[]) => void
  onResume: (id: string) => void
  onReview: () => void
  onScan: () => void
}

function DeletionTabs({
  items,
  filters,
  onFilters
}: Pick<ItemsPageProps, 'filters' | 'onFilters'> & { items: CleanerItem[] }): ReactNode {
  const allowed = useMemo(() => items.filter(canPermanentlyDelete).length, [items])
  const tabs = [
    {
      value: 'all',
      label: filters.category === 'sessions' ? '全部会话' : '全部内容',
      count: items.length
    },
    { value: 'allowed', label: '可以删除', count: allowed },
    { value: 'blocked', label: '暂不可删', count: items.length - allowed }
  ] as const
  return (
    <div className="calm-deletion-tabs" role="group" aria-label="按删除状态查看">
      {tabs.map((tab) => (
        <button
          type="button"
          className={filters.deletion === tab.value ? 'active' : ''}
          key={tab.value}
          aria-pressed={filters.deletion === tab.value}
          onClick={() => onFilters({ deletion: tab.value, status: 'all' })}
        >
          {tab.label}
          <span>{tab.count}</span>
        </button>
      ))}
    </div>
  )
}

function SelectionBar(props: ItemsPageProps & { matchingIds: string[] }): ReactNode {
  const { data, selectedIds, isBusy } = props
  const { deletable, exportable, protectedIds, allProtected } = useMemo(() => {
    const allItems = data?.items ?? []
    const selected = new Set(selectedIds)
    const items = allItems.filter((item) => selected.has(item.id))
    return {
      deletable: getDeletableIds(allItems, selectedIds),
      exportable: getExportableIds(allItems, selectedIds),
      protectedIds: items.filter((item) => item.status !== 'active').map((item) => item.id),
      allProtected: items.every((item) => item.status === 'protected')
    }
  }, [data?.items, selectedIds])
  const hiddenCount = useMemo(() => {
    const matching = new Set(props.matchingIds)
    return selectedIds.filter((id) => !matching.has(id)).length
  }, [props.matchingIds, selectedIds])
  if (!selectedIds.length) return null
  return (
    <div
      className="manager-selection-bar calm-selection-bar"
      role="region"
      aria-label="所选会话操作"
    >
      <div className="selection-summary" aria-live="polite">
        <strong>{selectedIds.length}</strong> 项已选
        {hiddenCount ? (
          <small className="calm-selection-context">含 {hiddenCount} 项来自其他筛选</small>
        ) : null}
        <button
          className="text-button"
          type="button"
          onClick={props.onClearSelection}
          disabled={isBusy}
        >
          清空
        </button>
        {props.matchingIds.length > PAGE_SIZE ? (
          <button
            className="text-button"
            type="button"
            disabled={isBusy}
            onClick={() => props.onSelectVisible(props.matchingIds)}
          >
            选择全部 {props.matchingIds.length} 项
          </button>
        ) : null}
      </div>
      <div className="selection-actions">
        {protectedIds.length ? (
          <button
            className="text-button"
            type="button"
            disabled={isBusy}
            onClick={() => props.onProtect(protectedIds, !allProtected)}
          >
            {allProtected ? '解除保护' : '保护'}
          </button>
        ) : null}
        <button
          className="button"
          type="button"
          disabled={isBusy || !exportable.length}
          onClick={() => props.onExport(exportable)}
        >
          导出 {exportable.length} 项
        </button>
        <button
          className="button danger"
          type="button"
          disabled={isBusy || !props.canReview || !deletable.length}
          onClick={props.onReview}
        >
          预览删除 {deletable.length} 项
        </button>
      </div>
    </div>
  )
}

function Pagination({
  count,
  page,
  onPage
}: {
  count: number
  page: number
  onPage: (page: number) => void
}): ReactNode {
  const pages = Math.max(1, Math.ceil(count / PAGE_SIZE))
  return (
    <nav className="manager-pagination calm-pagination" aria-label="会话列表分页">
      <span>
        {count ? page * PAGE_SIZE + 1 : 0}–{Math.min(count, (page + 1) * PAGE_SIZE)} / {count}
      </span>
      <div>
        <button
          className="text-button"
          type="button"
          disabled={page <= 0}
          onClick={() => onPage(page - 1)}
        >
          上一页
        </button>
        <span>
          第 {page + 1} / {pages} 页
        </span>
        <button
          className="text-button"
          type="button"
          disabled={page + 1 >= pages}
          onClick={() => onPage(page + 1)}
        >
          下一页
        </button>
      </div>
    </nav>
  )
}

export function ItemsPage(props: ItemsPageProps): ReactNode {
  const filterKey = JSON.stringify(props.filters)
  const [pagination, setPagination] = useState({ filterKey, page: 0 })
  if (pagination.filterKey !== filterKey) setPagination({ filterKey, page: 0 })
  const data = props.data
  const allMatching = useMemo(
    () => (data ? filterItems(data, { ...props.filters, deletion: 'all' }) : []),
    [data, props.filters]
  )
  const matching = useMemo(() => {
    if (props.filters.deletion === 'allowed') return allMatching.filter(canPermanentlyDelete)
    if (props.filters.deletion === 'blocked')
      return allMatching.filter((item) => !canPermanentlyDelete(item))
    return allMatching
  }, [allMatching, props.filters.deletion])
  const matchingIds = useMemo(
    () => matching.filter(isItemSelectable).map((item) => item.id),
    [matching]
  )
  const currentPage = Math.min(
    pagination.filterKey === filterKey ? pagination.page : 0,
    Math.max(0, Math.ceil(matching.length / PAGE_SIZE) - 1)
  )
  const pageItems = useMemo(
    () => matching.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE),
    [matching, currentPage]
  )
  if (!data)
    return (
      <p className="calm-loading" role="status">
        正在读取会话…
      </p>
    )
  return (
    <>
      <PageHeading
        id="items-heading"
        title="会话管理"
        description=""
        actions={
          <button
            className="button"
            type="button"
            onClick={props.onScan}
            disabled={props.isBusy || !data.sources.length}
          >
            <Icon name="scan" />
            重新扫描
          </button>
        }
      />
      <section className="sessions-workspace" aria-label="会话管理">
        <FilterPanel
          data={data}
          filters={props.filters}
          matchingCount={matching.length}
          onFilters={props.onFilters}
        />
        <div className="manager-library-heading calm-list-heading">
          <DeletionTabs items={allMatching} filters={props.filters} onFilters={props.onFilters} />
          <span className="muted">{matching.length} 条匹配</span>
        </div>
        <ItemTable
          {...props}
          data={data}
          items={pageItems}
          onExport={(id) => props.onExport([id])}
        />
        <Pagination
          count={matching.length}
          page={currentPage}
          onPage={(page) => setPagination({ filterKey, page })}
        />
        <SelectionBar {...props} matchingIds={matchingIds} />
      </section>
      <p className="calm-session-footnote">
        数据库会话显示会话数据量；工具实际占用见空间分析。选中会话后可预览删除。
      </p>
    </>
  )
}
