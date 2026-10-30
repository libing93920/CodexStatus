import type { ReactNode } from 'react'
import type { CleanerSettings } from '../../../../../shared/session-cleaner'
import { HelpTip, Icon, PageHeading } from '../components'
import { parseSettingsDraft, settingsDraftError, settingsEqual } from '../model'
import type { CleanerSettingsDraft } from '../model'

const FIELDS: Array<{
  key: keyof CleanerSettings
  label: string
  hint: string
  unit: string
  max: number
}> = [
  {
    key: 'keepRecentDays',
    label: '近期活动建议',
    hint: '标记近期修改的会话和日志，作为整理建议；不会覆盖来源的删除能力。',
    unit: '天',
    max: 3650
  },
  {
    key: 'olderSessionDays',
    label: '长期未用建议阈值',
    hint: '超过此期限的会话优先显示为历史建议；删除权限由来源能力单独决定。',
    unit: '天',
    max: 3650
  },
  {
    key: 'logAgeDays',
    label: '独立日志保留',
    hint: '此期限不能短于近期会话保护天数。',
    unit: '天',
    max: 3650
  },
  {
    key: 'alertGiB',
    label: '空间提醒阈值',
    hint: '已扫描文件占用达到此值时，在总览显示提醒。',
    unit: 'G',
    max: 100_000
  }
]

function PolicyField({
  field,
  value,
  isBusy,
  onChange
}: {
  field: (typeof FIELDS)[number]
  value: string
  isBusy: boolean
  onChange: (key: keyof CleanerSettings, value: string) => void
}): ReactNode {
  const id = `policy-${field.key}`
  return (
    <div className="policy-setting">
      <div className="setting-label">
        <label className="field-label" htmlFor={id}>
          {field.label}
        </label>
        <HelpTip text={field.hint} />
      </div>
      <span className="number-input">
        <input
          className="form-input"
          id={id}
          type="number"
          min="1"
          max={field.max}
          step="1"
          value={value}
          disabled={isBusy}
          aria-describedby={`${id}-hint`}
          aria-label={`${field.label}（${field.unit}）`}
          onChange={(event) => onChange(field.key, event.currentTarget.value)}
        />
        <span aria-hidden="true">{field.unit}</span>
      </span>
      <span className="sr-only" id={`${id}-hint`}>
        允许范围为 1 到 {field.max} 的整数，单位为{field.unit}。
      </span>
    </div>
  )
}

function PolicyPanel({
  draft,
  isBusy,
  error,
  onChange
}: {
  draft: CleanerSettingsDraft
  isBusy: boolean
  error: string | null
  onChange: (key: keyof CleanerSettings, value: string) => void
}): ReactNode {
  return (
    <section className="policy-panel" aria-labelledby="policy-form-heading">
      <h2 id="policy-form-heading">保留与提醒</h2>
      {FIELDS.map((field) => (
        <PolicyField
          key={field.key}
          field={field}
          value={draft[field.key]}
          isBusy={isBusy}
          onChange={onChange}
        />
      ))}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="policy-safety">
        <Icon name="shield" />
        <span>不自动清理 · 每次预览确认</span>
      </div>
    </section>
  )
}

function PolicyActions({
  changed,
  error,
  isBusy,
  onReset,
  onSave
}: {
  changed: boolean
  error: string | null
  isBusy: boolean
  onReset: () => void
  onSave: () => void
}): ReactNode {
  return (
    <div className="policy-actions">
      <span id="policy-save-status" role="status" aria-live="polite">
        {error ? '策略草稿有误' : changed ? '有未保存的策略变更' : '策略已应用'}
      </span>
      <button
        className="button"
        type="button"
        onClick={onReset}
        disabled={isBusy}
        title="恢复默认值仅更新本页草稿；保存后生效"
      >
        恢复默认
      </button>
      <button
        className="button primary"
        type="button"
        onClick={onSave}
        disabled={isBusy || !changed || Boolean(error)}
      >
        保存策略
      </button>
    </div>
  )
}

export interface PolicyPageProps {
  saved: CleanerSettings | null
  draft: CleanerSettingsDraft | null
  isBusy: boolean
  onChange: (key: keyof CleanerSettings, value: string) => void
  onReset: () => void
  onSave: () => void
}

function PolicyContent({
  saved,
  draft,
  isBusy,
  onChange,
  onReset,
  onSave
}: PolicyPageProps & { saved: CleanerSettings; draft: CleanerSettingsDraft }): ReactNode {
  const parsed = parseSettingsDraft(draft)
  const error = settingsDraftError(draft)
  const changed = Boolean(parsed && !settingsEqual(parsed, saved))
  return (
    <div id="settings-content">
      <PageHeading
        id="policy-heading"
        title="策略设置"
        description="规则影响整理建议与空间提醒；不会自动执行操作，也不限制来源明确提供的删除能力。"
      />
      <PolicyPanel draft={draft} isBusy={isBusy} error={error} onChange={onChange} />
      <PolicyActions
        changed={changed}
        error={error}
        isBusy={isBusy}
        onReset={onReset}
        onSave={onSave}
      />
    </div>
  )
}

export function PolicyPage(props: PolicyPageProps): ReactNode {
  const { saved, draft } = props
  if (!draft || !saved)
    return (
      <section className="panel loading-panel" role="status">
        正在读取策略…
      </section>
    )
  return <PolicyContent {...props} saved={saved} draft={draft} />
}
