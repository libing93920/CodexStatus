import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { CleanerSourceKind } from '../../../../../shared/session-cleaner'
import type { CleanerState } from '../../../../../shared/session-cleaner'
import { Icon } from '../components'
import { DEFAULT_ITEM_FILTERS, sourceKindLabel } from '../model'
import { groupSources } from '../source-groups'
import { Drawer } from './Drawer'
import type { ItemFilters } from '../model'
import { FilterPresets } from './FilterPresets'

interface FilterProps {
  data: CleanerState
  filters: ItemFilters
  onFilters: (filters: Partial<ItemFilters>) => void
}

interface FilterPanelProps extends FilterProps {
  matchingCount: number
}

import { SelectFilter, MultiSelectFilter, NumberFilter } from './FilterFields'
import type { FilterOption } from './FilterFields'

const CATEGORY_OPTIONS: FilterOption[] = [
  { value: 'sessions', label: '会话' },
  { value: 'all', label: '全部内容' },
  { value: 'resources', label: '资源' },
  { value: 'logs', label: '日志' },
  { value: 'unknown', label: '未知类型' }
]

const STATUS_OPTIONS: FilterOption[] = [
  { value: 'all', label: '全部状态' },
  { value: 'candidate', label: '已识别' },
  { value: 'protected', label: '已保护' },
  { value: 'recent', label: '近期活动' },
  { value: 'active', label: '正在使用' },
  { value: 'read-only', label: '能力受限' }
]

const RELATION_OPTIONS: FilterOption[] = [
  { value: 'all', label: '全部关系' },
  { value: 'parent', label: '父会话' },
  { value: 'child', label: '子会话' },
  { value: 'both', label: '父会话与子会话' },
  { value: 'unavailable', label: '未提供' }
]

const SIZE_BASIS_OPTIONS: FilterOption[] = [
  { value: 'session', label: '会话大小（默认）' },
  { value: 'attributed', label: '计入总量的大小' },
  { value: 'file', label: '独占文件大小' },
  { value: 'logical', label: '数据库会话数据量' }
]

const SORT_OPTIONS: FilterOption[] = [
  { value: 'newest', label: '最近使用' },
  { value: 'oldest', label: '最久未用' },
  { value: 'size-desc', label: '占用最大' }
]

interface FilterOptions {
  agents: FilterOption[]
  sources: FilterOption[]
  models: FilterOption[]
}

type FilterHandlers = Pick<FilterProps, 'filters' | 'onFilters'>

function getFilterOptions(data: CleanerState): FilterOptions {
  const agents = [...new Set(data.sources.map((source) => source.kind))].map((kind) => ({
    value: kind,
    label: sourceKindLabel(kind)
  }))
  const sources = data.sources.map((source) => ({ value: source.id, label: source.name }))
  const models = [
    ...new Set(data.items.flatMap((item) => item.managed?.modelIds ?? []).filter(Boolean))
  ].map((modelId) => ({ value: modelId, label: modelId }))
  return { agents, sources, models }
}

function QuickFilters({ data, filters, onFilters }: FilterProps): ReactNode {
  const groups = useMemo(() => groupSources(data), [data])
  return (
    <div className="calm-quick-filters">
      <label className="search-field" htmlFor="item-query">
        <Icon name="search" />
        <span className="sr-only">搜索标题、项目、路径或摘要</span>
        <input
          id="item-query"
          type="search"
          value={filters.query}
          placeholder="搜索会话或项目"
          onChange={(event) => onFilters({ query: event.currentTarget.value })}
        />
      </label>
      <SelectFilter
        label="Agent"
        value={filters.sourceId}
        options={[
          { value: 'all', label: '全部 Agent' },
          ...groups.map((group) => ({ value: group.id, label: group.name }))
        ]}
        onChange={(value) => onFilters({ sourceId: value })}
      />
      <SelectFilter
        label="排序"
        value={filters.sort}
        options={SORT_OPTIONS}
        onChange={(value) => onFilters({ sort: value as ItemFilters['sort'] })}
      />
    </div>
  )
}

function AgentFilters({
  filters,
  onFilters,
  options
}: FilterHandlers & { options: FilterOptions }): ReactNode {
  return (
    <>
      <MultiSelectFilter
        label="Agent 多选"
        value={filters.agentKinds}
        options={options.agents}
        onChange={(value) => onFilters({ agentKinds: value as CleanerSourceKind[] })}
      />
      <MultiSelectFilter
        label="数据目录多选"
        value={filters.sourceIds}
        options={options.sources}
        onChange={(value) => onFilters({ sourceIds: value })}
      />
      <label className="manager-filter-field">
        <span>项目包含</span>
        <input
          value={filters.project}
          placeholder="项目名称或目录片段"
          onChange={(event) => onFilters({ project: event.currentTarget.value })}
        />
      </label>
    </>
  )
}

function DateFilters({ filters, onFilters }: FilterHandlers): ReactNode {
  return (
    <>
      <div className="manager-filter-field manager-date-range">
        <span>创建日期范围</span>
        <div>
          <input
            aria-label="创建日期起始"
            type="date"
            value={filters.createdAfter}
            onChange={(event) => onFilters({ createdAfter: event.currentTarget.value })}
          />
          <input
            aria-label="创建日期结束"
            type="date"
            value={filters.createdBefore}
            onChange={(event) => onFilters({ createdBefore: event.currentTarget.value })}
          />
        </div>
      </div>
      <NumberFilter
        label="最少闲置天数"
        value={filters.minimumIdleDays}
        unit="天"
        onChange={(value) => onFilters({ minimumIdleDays: value })}
      />
      <NumberFilter
        label="最多闲置天数"
        value={filters.maximumIdleDays}
        unit="天"
        onChange={(value) => onFilters({ maximumIdleDays: value })}
      />
    </>
  )
}

function SizeFilters({ filters, onFilters }: FilterHandlers): ReactNode {
  return (
    <>
      <SelectFilter
        label="大小口径"
        value={filters.sizeBasis}
        options={SIZE_BASIS_OPTIONS}
        onChange={(value) => onFilters({ sizeBasis: value as ItemFilters['sizeBasis'] })}
      />
      <NumberFilter
        label="最小大小"
        value={filters.minimumBytes ? filters.minimumBytes / 1024 ** 2 : null}
        unit="MB"
        onChange={(value) => onFilters({ minimumBytes: Math.round((value ?? 0) * 1024 ** 2) })}
      />
      <NumberFilter
        label="最大大小"
        value={filters.maximumBytes === null ? null : filters.maximumBytes / 1024 ** 2}
        unit="MB"
        onChange={(value) =>
          onFilters({ maximumBytes: value === null ? null : Math.round(value * 1024 ** 2) })
        }
      />
    </>
  )
}

function ConversationFilters({
  filters,
  onFilters,
  options
}: FilterHandlers & { options: FilterOptions }): ReactNode {
  return (
    <>
      <MultiSelectFilter
        label="模型多选"
        value={filters.modelIds}
        options={options.models}
        onChange={(value) => onFilters({ modelIds: value })}
      />
      <NumberFilter
        label="最少消息数"
        value={filters.minimumMessageCount}
        onChange={(value) => onFilters({ minimumMessageCount: value })}
      />
      <NumberFilter
        label="最多消息数"
        value={filters.maximumMessageCount}
        onChange={(value) => onFilters({ maximumMessageCount: value })}
      />
      <SelectFilter
        label="父子关系"
        value={filters.relationship}
        options={RELATION_OPTIONS}
        onChange={(value) => onFilters({ relationship: value as ItemFilters['relationship'] })}
      />
    </>
  )
}

function AdvancedFilters({
  filters,
  onFilters,
  options,
  invalidRange
}: FilterHandlers & { options: FilterOptions; invalidRange: boolean }): ReactNode {
  return (
    <div className="calm-filter-groups">
      <details open>
        <summary>时间</summary>
        <div className="calm-filter-group-body">
          <DateFilters filters={filters} onFilters={onFilters} />
        </div>
      </details>
      <details>
        <summary>会话大小</summary>
        <div className="calm-filter-group-body">
          <SizeFilters filters={filters} onFilters={onFilters} />
        </div>
      </details>
      <details>
        <summary>Agent、目录与项目</summary>
        <div className="calm-filter-group-body">
          <AgentFilters filters={filters} onFilters={onFilters} options={options} />
        </div>
      </details>
      <details>
        <summary>模型与消息</summary>
        <div className="calm-filter-group-body">
          <ConversationFilters filters={filters} onFilters={onFilters} options={options} />
        </div>
      </details>
      <details>
        <summary>类型与状态</summary>
        <div className="calm-filter-group-body">
          <SelectFilter
            label="内容类型"
            value={filters.category}
            options={CATEGORY_OPTIONS}
            onChange={(value) => onFilters({ category: value as ItemFilters['category'] })}
          />
          <SelectFilter
            label="能力状态"
            value={filters.status}
            options={STATUS_OPTIONS}
            onChange={(value) =>
              onFilters({ status: value as ItemFilters['status'], deletion: 'all' })
            }
          />
        </div>
      </details>
      {invalidRange ? (
        <p className="manager-filter-error" role="alert">
          最小值不能大于最大值。
        </p>
      ) : null}
      <details>
        <summary>保存的筛选</summary>
        <div className="calm-filter-group-body">
          <FilterPresets filters={filters} onFilters={onFilters} />
        </div>
      </details>
    </div>
  )
}

function hasInvalidRange(filters: ItemFilters): boolean {
  return (
    (filters.minimumBytes > 0 &&
      filters.maximumBytes !== null &&
      filters.minimumBytes > filters.maximumBytes) ||
    (Boolean(filters.createdAfter && filters.createdBefore) &&
      filters.createdAfter > filters.createdBefore) ||
    (filters.minimumMessageCount !== null &&
      filters.maximumMessageCount !== null &&
      filters.minimumMessageCount > filters.maximumMessageCount) ||
    (filters.minimumIdleDays !== null &&
      filters.maximumIdleDays !== null &&
      filters.minimumIdleDays > filters.maximumIdleDays)
  )
}

export function FilterPanel({
  data,
  filters,
  matchingCount,
  onFilters
}: FilterPanelProps): ReactNode {
  const [open, setOpen] = useState(false)
  const options = useMemo(() => getFilterOptions(data), [data])
  const count = Object.entries(DEFAULT_ITEM_FILTERS).filter(
    ([key, value]) =>
      !['query', 'sourceId', 'sort', 'deletion'].includes(key) &&
      JSON.stringify(filters[key as keyof ItemFilters]) !== JSON.stringify(value)
  ).length
  return (
    <section className="calm-toolbar" aria-label="会话筛选与排序">
      <QuickFilters data={data} filters={filters} onFilters={onFilters} />
      <button
        className={'button calm-filter-trigger' + (count ? ' active' : '')}
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <Icon name="policy" />
        筛选{count ? <span>{count}</span> : null}
      </button>
      {open ? (
        <Drawer title="筛选会话" className="calm-filter-drawer" onClose={() => setOpen(false)}>
          <div className="calm-drawer-content">
            <p className="calm-supporting-note">只展开需要的条件，结果会即时更新。</p>
            <AdvancedFilters
              filters={filters}
              onFilters={onFilters}
              options={options}
              invalidRange={hasInvalidRange(filters)}
            />
          </div>
          <footer>
            <button
              type="button"
              className="text-button"
              onClick={() =>
                onFilters({
                  ...DEFAULT_ITEM_FILTERS,
                  query: filters.query,
                  sourceId: filters.sourceId,
                  deletion: filters.deletion,
                  sort: filters.sort
                })
              }
            >
              重置筛选
            </button>
            <button className="button primary" type="button" onClick={() => setOpen(false)}>
              查看 {matchingCount} 条结果
            </button>
          </footer>
        </Drawer>
      ) : null}
    </section>
  )
}
