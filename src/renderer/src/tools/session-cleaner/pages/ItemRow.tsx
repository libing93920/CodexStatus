import type { ReactNode } from 'react'
import type { CleanerItem, CleanerState } from '../../../../../shared/session-cleaner'
import type { ItemFilters } from '../model'
import { formatBytes, formatDateTime } from '../model'
import { canPermanentlyDelete, isItemSelectable, itemSize } from '../manager-model'
import { AgentBadge } from '../AgentBadge'

interface ItemRowProps {
  data: CleanerState
  item: CleanerItem
  selected: boolean
  current: boolean
  isBusy: boolean
  sizeBasis: ItemFilters['sizeBasis']
  onSelect: (id: string) => void
  onDetails: (id: string) => void
}

function deletionState(item: CleanerItem): { label: string; tone: string; reason: string } {
  if (item.status === 'protected')
    return { label: '已保护', tone: 'protected', reason: '解除保护后可重新检查删除能力' }
  if (item.status === 'active')
    return { label: '正在使用', tone: 'active', reason: '正在使用的会话不能删除' }
  if (canPermanentlyDelete(item))
    return { label: '可以删除', tone: 'allowed', reason: '删除前会先生成预览并再次确认' }
  return {
    label: '仅可查看',
    tone: 'blocked',
    reason: item.managed?.capabilities.deleteReason ?? item.reason
  }
}

export function ItemRow(props: ItemRowProps): ReactNode {
  const { item, data, selected, current, isBusy } = props
  const source = data.sources.find((entry) => entry.id === item.sourceId)
  const status = deletionState(item)
  const bytes = itemSize(item, props.sizeBasis)
  const project = (item.project ?? item.managed?.projectDir ?? '')
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .at(-1)
  const updated = item.managed?.lastActiveAt ?? item.modifiedAt
  return (
    <tr className={current ? 'current' : undefined} data-item-id={item.id}>
      <td className="checkbox-cell">
        <input
          type="checkbox"
          checked={selected}
          disabled={isBusy || !isItemSelectable(item)}
          aria-label={'选择 ' + item.title}
          onChange={() => props.onSelect(item.id)}
        />
      </td>
      <td className="calm-session-name">
        <div>
          <AgentBadge kind={source?.kind ?? 'unknown'} />
          <span>
            <button
              className="item-title-button row-title"
              type="button"
              disabled={isBusy}
              title={item.title}
              onClick={() => props.onDetails(item.id)}
            >
              {item.title}
            </button>
            <small>{[source?.name, project].filter(Boolean).join(' · ')}</small>
          </span>
        </div>
      </td>
      <td className="size-cell calm-session-size">
        <strong>{bytes === null ? '未提供' : formatBytes(bytes)}</strong>
        {item.managed?.storage.kind === 'sqlite' ? (
          <small>会话数据</small>
        ) : item.managed?.storage.sharedBytes ? (
          <small>含共享文件</small>
        ) : null}
      </td>
      <td className="date-cell calm-session-date">
        {updated ? formatDateTime(updated).split(' ')[0] : '未提供'}
      </td>
      <td className="status-cell">
        <span className={'calm-deletion-state ' + status.tone} title={status.reason}>
          {status.label}
        </span>
      </td>
      <td className="calm-session-more">
        <button
          type="button"
          className="icon-button"
          disabled={isBusy}
          onClick={() => props.onDetails(item.id)}
          aria-label={'更多操作：' + item.title}
          aria-haspopup="dialog"
        >
          ···
        </button>
      </td>
    </tr>
  )
}
