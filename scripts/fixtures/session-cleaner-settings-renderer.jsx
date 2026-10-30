import React from 'react'
import { createRoot } from 'react-dom/client'
import App from '../../src/renderer/src/App'
import { THEME_OPTIONS } from '../../src/renderer/src/copy'
import {
  createEmptySnapshot,
  DEFAULT_SETTINGS,
  DEFAULT_WINDOW_PREFERENCES
} from '../../src/shared/capsule'
import { createEmptyIslandSnapshot } from '../../src/shared/island'

let settings = { ...DEFAULT_SETTINGS }
let openRequest
let rejectNextOpen = false
const calls = []

window.cleanerSettingsTest = {
  themes: THEME_OPTIONS,
  calls: () => [...calls],
  clearCalls: () => {
    calls.length = 0
  },
  settleOpen: () => {
    openRequest?.resolve()
  },
  rejectNextOpen: () => {
    rejectNextOpen = true
  }
}

window.codexStatus = new Proxy(
  {
    bootstrap: async () => ({
      settings,
      teamAdminAllowed: false,
      window: { ...DEFAULT_WINDOW_PREFERENCES },
      panel: {},
      snapshot: createEmptySnapshot(),
      role: 'panel',
      panelView: 'settings',
      version: '1.3.31-test',
      announcement: null,
      island: createEmptyIslandSnapshot(),
      islandDiagnostics: false
    }),
    updateSettings: async (patch) => {
      settings = { ...settings, ...patch }
      return {
        settings,
        teamAdminAllowed: false,
        window: { ...DEFAULT_WINDOW_PREFERENCES },
        panel: {}
      }
    },
    openSessionCleaner: () => {
      calls.push('open')
      if (rejectNextOpen) {
        rejectNextOpen = false
        return Promise.reject(new Error('测试：打开会话清理失败'))
      }
      return new Promise((resolve, reject) => {
        openRequest = { resolve, reject }
      })
    },
    closePanel: async () => {
      calls.push('close')
    },
    onSnapshotUpdated: () => () => {},
    onPreferencesUpdated: () => () => {},
    onIslandUpdated: () => () => {},
    onCommand: () => () => {},
    onUpdateProgress: () => () => {},
    onBroadcastMessage: () => () => {},
    onAnnouncementUpdated: () => () => {},
    onReaction: () => () => {}
  },
  {
    get: (target, property) => target[property] ?? (async () => undefined)
  }
)

createRoot(document.getElementById('root')).render(<App />)
