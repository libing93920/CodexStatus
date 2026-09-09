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
    <div className="setting-row tool-setting-row">
      <div className="tool-setting-copy">
        <span className="setting-field__label">{zh ? '灵动岛' : 'Dynamic Island'}</span>
        <small className="setting-field__hint">
          {zh
            ? '主屏顶部显示，提醒 5 秒，查看任务后隐藏'
            : 'Primary display, 5-second alerts, hidden after viewing'}
        </small>
        {preferences.enabled ? (
          <small
            className={`setting-field__hint tool-setting-status ${snapshot.visibility === 'visible' ? 'is-visible' : ''}`}
          >
            {runtime}
          </small>
        ) : null}
        <small className="setting-field__hint">
          {zh
            ? '首次开启后，请在 Codex /hooks 中审核 CodexStatus Hook。'
            : 'After enabling for the first time, review the CodexStatus hook in Codex /hooks.'}
        </small>
      </div>
      <button
        aria-checked={preferences.enabled}
        aria-label={zh ? '启用灵动岛' : 'Enable Dynamic Island'}
        className={`toggle-switch ${preferences.enabled ? 'is-checked' : ''}`}
        onClick={() => onChange({ enabled: !preferences.enabled })}
        role="switch"
        type="button"
      >
        <span className="toggle-switch__track" aria-hidden="true">
          <span className="toggle-switch__thumb" />
        </span>
      </button>
    </div>
  )
}

function getRuntimeHint(zh: boolean, snapshot: IslandSnapshot): string {
  if (snapshot.visibility === 'fullscreen') {
    return zh ? '暂时隐藏：主显示屏正在全屏。' : 'Hidden while the primary display is fullscreen.'
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
