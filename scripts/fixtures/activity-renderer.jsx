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
let appMountSequence = 0
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
  coverageCase: 'summary-gap',
  lastBoard: undefined,
  teamAdminAllowed: true,
  omitTeamAdminAllowedFromBootstrap: false,
  holdBoard: false,
  pending: [],
  settingsPatches: [],
  externalUrls: [],
  requestedDates: [],
  setNow(value) {
    currentNow = Date.parse(value)
  },
  settings: () => settings,
  setTeamAdminAllowed(value) {
    fixture.teamAdminAllowed = value
    preferencesListener?.({
      settings,
      window: DEFAULT_WINDOW_PREFERENCES,
      teamAdminAllowed: fixture.teamAdminAllowed
    })
  },
  setSettings(patch) {
    settings = normalizeSettings({ ...settings, ...patch })
    preferencesListener?.({
      settings,
      window: DEFAULT_WINDOW_PREFERENCES,
      teamAdminAllowed: fixture.teamAdminAllowed
    })
    fixtureSettingsListener?.(settings)
  },
  mount(view = 'app') {
    if (view === 'app-remount') {
      root.render(<App key={`app-${settings.teamGroup}-${++appMountSequence}`} />)
      return
    }
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
  const legacyIntervals = [
    { start: at('08:30:00'), end: at('09:00:00'), kind: 'active' },
    { start: at('09:00:00'), end: at('09:12:00'), kind: 'idle' },
    { start: at('09:12:00'), end: at('09:30:00'), kind: 'locked' },
    { start: at('10:00:00'), end: at('10:30:00'), kind: 'suspended' },
    { start: at('13:30:00'), end: at('14:10:35'), kind: 'active' },
    { start: at('14:10:35'), end: at('14:30:00'), kind: 'idle' }
  ]
  const completeIntervals = windows
    .map((workWindow) => ({
      start: workWindow.start,
      end: Math.min(workWindow.end, at('14:30:00')),
      kind: 'active'
    }))
    .filter((interval) => interval.end > interval.start)
  const detailedIntervals = [
    { start: at('08:30:00'), end: at('09:00:00'), kind: 'active' },
    { start: at('09:00:00'), end: at('09:12:00'), kind: 'idle' },
    { start: at('09:12:00'), end: at('09:30:00'), kind: 'locked' },
    { start: at('09:30:00'), end: at('10:00:00'), kind: 'unknown' },
    { start: at('10:00:00'), end: at('10:30:00'), kind: 'suspended' },
    { start: at('10:30:00'), end: at('11:30:00'), kind: 'unknown' },
    { start: at('13:30:00'), end: at('14:10:35'), kind: 'active' },
    { start: at('14:10:35'), end: at('14:30:00'), kind: 'idle' }
  ]
  const twoSecondUnknownIntervals = [
    { start: at('08:30:00'), end: at('09:30:00'), kind: 'active' },
    { start: at('09:30:00'), end: at('09:30:02'), kind: 'unknown' },
    { start: at('09:30:02'), end: at('12:00:00'), kind: 'active' },
    { start: at('13:30:00'), end: at('14:30:00'), kind: 'active' }
  ]
  const boundedTwoSecondUnknownIntervals = [
    { start: at('08:29:58'), end: at('08:30:04'), kind: 'unknown' },
    { start: at('08:30:04'), end: at('12:00:00'), kind: 'active' },
    { start: at('13:30:00'), end: at('14:30:00'), kind: 'active' }
  ]
  const outsideWindowUnknownIntervals = [
    { start: at('07:30:00'), end: at('08:30:00'), kind: 'unknown' },
    ...completeIntervals
  ]
  const lunchUnknownIntervals = [
    ...completeIntervals,
    { start: at('12:30:00'), end: at('13:00:00'), kind: 'unknown' }
  ]
  const futureUnknownIntervals = [
    ...completeIntervals,
    { start: at('15:00:00'), end: at('16:00:00'), kind: 'unknown' }
  ]
  const intervalsByCoverageCase = {
    detailed: detailedIntervals,
    'two-second-unknown': twoSecondUnknownIntervals,
    'bounded-two-second': boundedTwoSecondUnknownIntervals,
    'outside-window-unknown': outsideWindowUnknownIntervals,
    'lunch-unknown': lunchUnknownIntervals,
    'future-unknown': futureUnknownIntervals,
    'point-only-diagnostic': completeIntervals,
    'complete-incomplete': completeIntervals,
    'summary-gap': legacyIntervals
  }
  const diagnostics =
    fixture.coverageCase === 'detailed'
      ? [
          { code: 'sample-gap', at: at('09:30:00'), start: at('09:30:00'), end: at('09:50:00') },
          {
            code: 'input-unavailable',
            at: at('09:40:00'),
            start: at('09:40:00'),
            end: at('09:45:00')
          },
          { code: 'clock-change', at: at('09:55:00') },
          {
            code: 'input-unavailable',
            at: at('10:30:00'),
            start: at('10:30:00'),
            end: at('11:00:00')
          },
          { code: 'input-read-failed', at: at('10:45:00') }
        ]
      : fixture.coverageCase === 'point-only-diagnostic'
        ? [{ code: 'clock-change', at: at('09:55:00') }]
        : undefined
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
    ...(diagnostics ? { diagnostics } : {}),
    intervals: intervalsByCoverageCase[fixture.coverageCase] ?? legacyIntervals
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
  const board = {
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
  fixture.lastBoard = board
  return board
}

window.codexStatus = {
  openExternal: async (url) => {
    fixture.externalUrls.push(url)
  },
  bootstrap: async () => ({
    settings,
    window: DEFAULT_WINDOW_PREFERENCES,
    ...(!fixture.omitTeamAdminAllowedFromBootstrap
      ? { teamAdminAllowed: fixture.teamAdminAllowed }
      : {}),
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
    return {
      settings,
      window: DEFAULT_WINDOW_PREFERENCES,
      teamAdminAllowed: fixture.teamAdminAllowed
    }
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
