import type { ReactNode } from 'react'

export type FilterOption = { label: string; value: string }

export function SelectFilter({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: string
  options: readonly FilterOption[]
  onChange: (value: string) => void
}): ReactNode {
  return (
    <label className="manager-filter-field">
      <span>{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {options.map((option) => (
          <option value={option.value} key={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

export function MultiSelectFilter({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: string[]
  options: readonly FilterOption[]
  onChange: (value: string[]) => void
}): ReactNode {
  return (
    <fieldset className="calm-filter-choices" aria-label={label}>
      <legend>{label}</legend>
      {options.length ? (
        options.map((option) => (
          <label key={option.value}>
            <input
              type="checkbox"
              checked={value.includes(option.value)}
              value={option.value}
              onChange={(event) =>
                onChange(
                  event.currentTarget.checked
                    ? [...value, option.value]
                    : value.filter((id) => id !== option.value)
                )
              }
            />
            <span>{option.label}</span>
          </label>
        ))
      ) : (
        <small>暂无可选项</small>
      )}
    </fieldset>
  )
}

export function NumberFilter({
  label,
  value,
  min = 0,
  unit,
  onChange
}: {
  label: string
  value: number | null
  min?: number
  unit?: string
  onChange: (value: number | null) => void
}): ReactNode {
  return (
    <label className="manager-filter-field">
      <span>{label}</span>
      <span className="manager-number-control">
        <input
          aria-label={label}
          type="number"
          min={min}
          step={unit === 'MB' ? 'any' : '1'}
          value={value ?? ''}
          placeholder="不限"
          onChange={(event) => {
            const text = event.currentTarget.value
            onChange(text === '' ? null : Number(text))
          }}
        />
        {unit ? <small>{unit}</small> : null}
      </span>
    </label>
  )
}
