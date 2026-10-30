import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { ItemFilters } from '../model'

const PRESET_STORAGE_KEY = 'codex-status.session-manager.filters.v1'

interface FilterPreset {
  name: string
  filters: ItemFilters
}

function readPresets(): FilterPreset[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PRESET_STORAGE_KEY) ?? '[]')
    if (!Array.isArray(value)) return []
    return value.filter(
      (entry): entry is FilterPreset =>
        typeof entry === 'object' &&
        entry !== null &&
        'name' in entry &&
        typeof entry.name === 'string' &&
        'filters' in entry &&
        typeof entry.filters === 'object' &&
        entry.filters !== null
    )
  } catch {
    return []
  }
}

interface PresetController {
  presets: FilterPreset[]
  name: string
  selectedName: string
  setName: (value: string) => void
  setSelectedName: (value: string) => void
  save: () => void
  apply: () => void
  remove: () => void
}

function usePresetController(
  filters: ItemFilters,
  onFilters: (filters: Partial<ItemFilters>) => void
): PresetController {
  const [presets, setPresets] = useState(readPresets)
  const [name, setName] = useState('')
  const [selectedName, setSelectedName] = useState('')

  useEffect(() => {
    try {
      localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(presets))
    } catch {
      // 预设仅保存在本机；存储不可用时，当前筛选仍可使用。
    }
  }, [presets])

  const save = (): void => {
    const trimmedName = name.trim()
    if (!trimmedName) return
    const snapshot = {
      ...filters,
      agentKinds: [...filters.agentKinds],
      sourceIds: [...filters.sourceIds],
      modelIds: [...filters.modelIds]
    }
    setPresets((current) => [
      ...current.filter((entry) => entry.name !== trimmedName),
      { name: trimmedName, filters: snapshot }
    ])
    setSelectedName(trimmedName)
    setName('')
  }
  const apply = (): void => {
    const preset = presets.find((entry) => entry.name === selectedName)
    if (preset) onFilters(preset.filters)
  }
  const remove = (): void => {
    setPresets((current) => current.filter((entry) => entry.name !== selectedName))
    setSelectedName('')
  }
  return { presets, name, selectedName, setName, setSelectedName, save, apply, remove }
}

export function FilterPresets({
  filters,
  onFilters
}: {
  filters: ItemFilters
  onFilters: (filters: Partial<ItemFilters>) => void
}): ReactNode {
  const controller = usePresetController(filters, onFilters)
  return (
    <fieldset className="manager-preset-box">
      <legend>本机筛选预设</legend>
      <label className="manager-filter-field" htmlFor="manager-preset-name">
        <span>预设名称</span>
        <input
          id="manager-preset-name"
          value={controller.name}
          maxLength={48}
          onChange={(event) => controller.setName(event.currentTarget.value)}
        />
      </label>
      <button
        className="text-button"
        type="button"
        onClick={controller.save}
        disabled={!controller.name.trim()}
      >
        保存当前组合
      </button>
      <label className="manager-filter-field" htmlFor="manager-preset-select">
        <span>已保存预设</span>
        <select
          id="manager-preset-select"
          value={controller.selectedName}
          onChange={(event) => controller.setSelectedName(event.currentTarget.value)}
        >
          <option value="">选择预设</option>
          {controller.presets.map((preset) => (
            <option key={preset.name} value={preset.name}>
              {preset.name}
            </option>
          ))}
        </select>
      </label>
      <button
        className="text-button"
        type="button"
        onClick={controller.apply}
        disabled={!controller.selectedName}
      >
        应用
      </button>
      <button
        className="text-button muted-button"
        type="button"
        onClick={controller.remove}
        disabled={!controller.selectedName}
      >
        删除预设
      </button>
    </fieldset>
  )
}
