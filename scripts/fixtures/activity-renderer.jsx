import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import App from '../../src/renderer/src/App'
import { ActivityPanel } from '../../src/renderer/src/activity/ActivityPanel'
import {
  DEFAULT_SETTINGS,
  DEFAULT_WINDOW_PREFERENCES,
  normalizeSettings,
  createEmptySnapshot
} from '../../src/shared/capsule'
import { createEmptyIslandSnapshot } from '../../src/shared/island'
import { calendarWorkWindows, isCalendarWorkday } from '../../src/shared/work-time'
import seed from '../../resources/holidays/2026.json'
import { summarizeActivity } from '../../src/shared/activity'
import { THEME_OPTIONS } from '../../src/renderer/src/copy'

const NOW = Date.parse('2026-10-13T14:30:00+08:00')
let currentNow = NOW
Date.now = () => currentNow
let settings = { ...DEFAULT_SETTINGS, teamGroup: '9527GM' }
let preferencesListener
let fixtureSettingsListener
const root = createRoot(document.getElementById('root'))
const unsubscribe = () => () => {}
const fixture = {
  themes: THEME_OPTIONS.map((theme) => theme.value),
  boardCalls: 0,
  boardError: '',
  settingsError: '',
  empty: false,
  noDay: false,
  dateNames: false,
  missingCalendar: false,
  holdBoard: false,
  pending: [],
  settingsPatches: [],
  externalUrls: [],
  requestedDates: [],
  setNow(value) {
    currentNow = Date.parse(value)
  },
  settings: () => settings,
  setSettings(patch) {
    settings = normalizeSettings({ ...settings, ...patch })
    preferencesListener?.({ settings, window: DEFAULT_WINDOW_PREFERENCES })
    fixtureSettingsListener?.(settings)
  },
  mount(view = 'app') {
    root.render(view === 'app' ? <App key={`app-${settings.teamGroup}`} /> : <Fixture key={view} />)
  },
  release() {
    fixture.pending.splice(0).forEach((resolve) => resolve())
  }
}
window.activityFixture = fixture

function makeBoard(date) {
  const calendarAvailable = !fixture.missingCalendar && Number(date.slice(0, 4)) === seed.year
  const windows = calendarAvailable ? calendarWorkWindows(date, [seed]) : []
  const at = (clock) => Date.parse(`${date}T${clock}+08:00`)
  const day = {
    version: 1,
    team: '123456abcdef',
    peerId: '10000000-0000-4000-8000-000000000001',
    nickname: fixture.dateNames ? `测试成员甲 ${date}` : '测试成员甲',
    date,
    revision: 3,
    calendarVersion: 'fixture',
    observedAt: at('14:30:00'),
    firstInputAt: at('08:35:10'),
    lastInputAt: at('14:10:35'),
    incomplete: true,
    intervals: [
      { start: at('08:30:00'), end: at('09:00:00'), kind: 'active' },
      { start: at('09:00:00'), end: at('09:12:00'), kind: 'idle' },
      { start: at('09:12:00'), end: at('09:30:00'), kind: 'locked' },
      { start: at('10:00:00'), end: at('10:30:00'), kind: 'suspended' },
      { start: at('13:30:00'), end: at('14:10:35'), kind: 'active' },
      { start: at('14:10:35'), end: at('14:30:00'), kind: 'idle' }
    ]
  }
  const member = {
    id: day.peerId,
    nickname: day.nickname,
    isSelf: false,
    online: true,
    supported: true,
    enabled: true,
    receivedAt: currentNow,
    live: { observedAt: currentNow, state: 'idle', enabled: true, idleSince: at('14:10:35') },
    ...(!fixture.noDay && calendarAvailable
      ? {
          day,
          summary: summarizeActivity(
            day,
            windows,
            settings.activityIdleThresholdMinutes,
            currentNow
          )
        }
      : {})
  }
  return {
    date,
    generatedAt: currentNow,
    thresholdMinutes: settings.activityIdleThresholdMinutes,
    calendar: {
      year: Number(date.slice(0, 4)),
      available: calendarAvailable,
      isWorkday: calendarAvailable ? isCalendarWorkday(date, [seed]) : undefined,
      windows,
      version: 'fixture',
      papers: ['https://www.gov.cn/zhengce/content/202511/content_7046381.htm'],
      updating: false,
      lastCheckedAt: currentNow
    },
    members: fixture.empty
      ? []
      : [
          member,
          { id: 'unsupported', nickname: '旧版测试成员', online: true, supported: false },
          {
            id: 'disabled',
            nickname: '未分享测试成员',
            online: true,
            supported: true,
            enabled: false
          }
        ],
    issues: []
  }
}

window.codexStatus = {
  openExternal: async (url) => {
    fixture.externalUrls.push(url)
  },
  bootstrap: async () => ({
    settings,
    window: DEFAULT_WINDOW_PREFERENCES,
    snapshot: createEmptySnapshot(),
    role: 'panel',
    panelView: 'team',
    island: createEmptyIslandSnapshot(),
    announcement: null,
    version: 'fixture'
  }),
  onSnapshotUpdated: unsubscribe,
  onPreferencesUpdated: (listener) => {
    preferencesListener = listener
    return () => {
      preferencesListener = undefined
    }
  },
  onIslandUpdated: unsubscribe,
  onCommand: unsubscribe,
  getPanelVisibility: () => window.activityVisibility.getPanelVisibility(),
  onPanelVisibilityChanged: (listener) =>
    window.activityVisibility.onPanelVisibilityChanged(listener),
  onUpdateProgress: unsubscribe,
  onBroadcastMessage: unsubscribe,
  onAnnouncementUpdated: unsubscribe,
  onReaction: unsubscribe,
  notifyPanelReady: async () => {},
  updateSettings: async (patch) => {
    fixture.settingsPatches.push(patch)
    if (fixture.settingsError) throw new Error(fixture.settingsError)
    fixture.setSettings(patch)
    return { settings, window: DEFAULT_WINDOW_PREFERENCES }
  },
  getActivityBoard: async (date) => {
    fixture.boardCalls++
    fixture.requestedDates.push(date)
    if (fixture.holdBoard) await new Promise((resolve) => fixture.pending.push(resolve))
    if (fixture.boardError) throw new Error(fixture.boardError)
    return makeBoard(date)
  }
}

function Fixture() {
  const [current, setCurrent] = useState(settings)
  fixtureSettingsListener = setCurrent
  return (
    <div data-theme={current.theme} className="panel">
      <div className="panel__content">
        <ActivityPanel settings={current} />
      </div>
    </div>
  )
}
fixture.mount()
