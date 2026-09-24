import { useEffect, useState, type CSSProperties } from 'react'
import {
  createEmptySnapshot,
  DEFAULT_SETTINGS,
  type AppSettings,
  type UsageSnapshot
} from '../../shared/capsule'
import { resolveMinimalMetricColor } from './minimal-quota'
import './capsule-hover.css'

const FIVE_HOUR_WINDOW_MINUTES = 300
const WEEKLY_WINDOW_MINUTES = 10080

export default function CapsuleHover(): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings>({ ...DEFAULT_SETTINGS })
  const [snapshot, setSnapshot] = useState<UsageSnapshot>(createEmptySnapshot)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let active = true
    void window.codexStatus.bootstrap().then((payload) => {
      if (!active) return
      setSettings(payload.settings)
      setSnapshot(payload.snapshot)
      setReady(true)
    })
    const disposeSnapshot = window.codexStatus.onSnapshotUpdated(setSnapshot)
    const disposePreferences = window.codexStatus.onPreferencesUpdated((payload) => {
      setSettings(payload.settings)
    })
    return () => {
      active = false
      disposeSnapshot()
      disposePreferences()
    }
  }, [])

  useEffect(() => {
    if (!ready) return
    void window.codexStatus.notifyCapsuleHoverReady()
  }, [ready])

  // 官方额度可能不带窗口时长；此时使用已有的 primary / secondary 标识。
  const short = snapshot.rateLimits.find((item) =>
    item.windowMinutes === undefined
      ? item.id === 'primary'
      : item.windowMinutes === FIVE_HOUR_WINDOW_MINUTES
  )
  const long = snapshot.rateLimits.find((item) =>
    item.windowMinutes === undefined
      ? item.id === 'secondary'
      : item.windowMinutes === WEEKLY_WINDOW_MINUTES
  )
  const values = [
    { label: '5h', remaining: short?.remainingPercent },
    { label: '7d', remaining: long?.remainingPercent }
  ]

  return (
    <div className="quota-hover-root" data-theme={settings.theme}>
      <div className="panel quota-hover-theme">
        <div className="team-row__tooltip quota-hover-tooltip" role="tooltip">
          {values.map(({ label, remaining }) => (
            <span className="quota-hover__group" key={label}>
              <span className="team-row__tooltip-label">{label}</span>
              <strong
                className="quota-hover__value"
                style={
                  {
                    '--metric-accent': resolveMinimalMetricColor(remaining, settings.theme)
                  } as CSSProperties
                }
              >
                {remaining === undefined ? '--' : `${Math.round(remaining)}%`}
              </strong>
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
