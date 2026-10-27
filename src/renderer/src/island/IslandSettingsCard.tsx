import type { IslandPreferences, IslandSnapshot } from '../../../shared/island'
import type { LocaleCode } from '../../../shared/capsule'

interface IslandSettingsCardProps {
  locale: LocaleCode
  preferences: IslandPreferences
  snapshot: IslandSnapshot
  onChange: (preferences: IslandPreferences) => void
}

export function IslandSettingsCard({
  locale,
  preferences,
  snapshot,
  onChange
}: IslandSettingsCardProps): React.JSX.Element {
  const zh = locale === 'zh-CN'
  const runtime = getRuntimeHint(zh, snapshot)
  return (
    <>
      <div className="setting-row tool-setting-row">
        <div className="tool-setting-copy">
          <span className="setting-field__label">
            {zh ? '任务状态展示' : 'Task activity display'}
          </span>
          {preferences.enabled ? (
            <small
              className={`setting-field__hint tool-setting-status ${snapshot.visibility === 'visible' ? 'is-visible' : ''}`}
            >
              {runtime}
            </small>
          ) : (
            <small className="setting-field__hint">
              {zh
                ? '首次开启后，请在 Codex /hooks 中审核 CodexStatus Hook。'
                : 'After enabling for the first time, review the CodexStatus hook in Codex /hooks.'}
            </small>
          )}
        </div>
        <button
          aria-checked={preferences.enabled}
          aria-label={zh ? '启用任务状态展示' : 'Enable task activity display'}
          className={`toggle-switch ${preferences.enabled ? 'is-checked' : ''}`}
          onClick={() => onChange({ ...preferences, enabled: !preferences.enabled })}
          role="switch"
          type="button"
        >
          <span className="toggle-switch__track" aria-hidden="true">
            <span className="toggle-switch__thumb" />
          </span>
        </button>
      </div>
      <IslandModeOptions locale={locale} preferences={preferences} onChange={onChange} />
    </>
  )
}

interface IslandModeOptionsProps {
  locale: LocaleCode
  preferences: IslandPreferences
  onChange: (preferences: IslandPreferences) => void
}

function IslandModeOptions({
  locale,
  preferences,
  onChange
}: IslandModeOptionsProps): React.JSX.Element {
  const zh = locale === 'zh-CN'
  return (
    <div className={`island-mode-setting ${preferences.enabled ? '' : 'is-disabled'}`}>
      <span className="setting-field__label">{zh ? '显示方式' : 'Display mode'}</span>
      <div
        aria-label={zh ? '任务状态显示方式' : 'Task activity display mode'}
        aria-disabled={!preferences.enabled}
        className="island-mode-options"
        role="radiogroup"
      >
        <IslandModeOption
          locale={locale}
          mode="island"
          preferences={preferences}
          onChange={onChange}
        />
        <IslandModeOption
          locale={locale}
          mode="taskbar"
          preferences={preferences}
          onChange={onChange}
        />
      </div>
    </div>
  )
}

interface IslandModeOptionProps {
  locale: LocaleCode
  mode: IslandPreferences['displayMode']
  preferences: IslandPreferences
  onChange: (preferences: IslandPreferences) => void
}

function IslandModeOption({
  locale,
  mode,
  preferences,
  onChange
}: IslandModeOptionProps): React.JSX.Element {
  const zh = locale === 'zh-CN'
  const selected = preferences.displayMode === mode
  const islandMode = mode === 'island'
  const title = islandMode ? (zh ? '灵动岛' : 'Dynamic Island') : zh ? '任务栏' : 'Taskbar'

  return (
    <label className={`island-mode-option ${selected ? 'is-selected' : ''}`}>
      <input
        checked={selected}
        disabled={!preferences.enabled}
        name="island-display-mode"
        onChange={() => onChange({ ...preferences, displayMode: mode })}
        type="radio"
        value={mode}
      />
      <span className="island-mode-option__copy">
        <span className="island-mode-option__title">{title}</span>
      </span>
    </label>
  )
}

function getRuntimeHint(zh: boolean, snapshot: IslandSnapshot): string {
  if (snapshot.visibility === 'fullscreen') {
    return zh ? '暂时隐藏：主显示器正在全屏。' : 'Hidden while the primary display is fullscreen.'
  }
  if (snapshot.visibility === 'taskbar-unavailable') {
    return zh
      ? '任务栏暂不可用或处于自动隐藏状态，恢复后会显示。'
      : 'The taskbar is unavailable or auto-hidden; the button will reappear when it is available.'
  }
  if (snapshot.visibility === 'visible') {
    return zh
      ? `正在显示：检测到 ${snapshot.tasks.length} 个 Codex 任务。`
      : `Visible with ${snapshot.tasks.length} Codex task(s).`
  }
  if (!snapshot.connection.hooks) {
    return zh
      ? '未显示：状态监听服务未启动。'
      : 'Hidden because activity monitoring is not running.'
  }
  if (snapshot.connection.lastHookEventAt === undefined && !snapshot.connection.ipc) {
    return zh
      ? '未显示：尚未收到 Codex Hook 事件，请检查 /hooks。'
      : 'No Codex hook event received yet. Check /hooks.'
  }
  return zh
    ? '未显示：当前没有检测到执行中或待处理的 Codex 任务。'
    : 'No running or pending Codex task detected.'
}
