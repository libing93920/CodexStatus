import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  AppSettings,
  BootstrapPayload,
  CapsuleDragMovePayload,
  CodexStatusApi,
  PreferencesPayload,
  UsageSnapshot,
  WindowPreferences
} from '../shared/capsule'

const CHANNELS = {
  bootstrap: 'codex-status:bootstrap',
  refresh: 'codex-status:refresh',
  updateSettings: 'codex-status:update-settings',
  closePanel: 'codex-status:close-panel',
  moveCapsuleWindow: 'codex-status:move-capsule-window',
  finishCapsuleWindowDrag: 'codex-status:finish-capsule-window-drag',
  snapshotUpdated: 'codex-status:snapshot-updated',
  preferencesUpdated: 'codex-status:preferences-updated',
  command: 'codex-status:command'
} as const

const api: CodexStatusApi = {
  bootstrap: () => ipcRenderer.invoke(CHANNELS.bootstrap) as Promise<BootstrapPayload>,
  refreshStatus: () => ipcRenderer.invoke(CHANNELS.refresh) as Promise<UsageSnapshot>,
  updateSettings: (patch: Partial<AppSettings>) =>
    ipcRenderer.invoke(CHANNELS.updateSettings, patch) as Promise<PreferencesPayload>,
  closePanel: () => ipcRenderer.invoke(CHANNELS.closePanel) as Promise<void>,
  moveCapsuleWindow: (payload: CapsuleDragMovePayload) =>
    ipcRenderer.invoke(CHANNELS.moveCapsuleWindow, payload) as Promise<WindowPreferences>,
  finishCapsuleWindowDrag: () =>
    ipcRenderer.invoke(CHANNELS.finishCapsuleWindowDrag) as Promise<WindowPreferences>,
  onSnapshotUpdated: listener => subscribe(CHANNELS.snapshotUpdated, listener),
  onPreferencesUpdated: listener => subscribe(CHANNELS.preferencesUpdated, listener),
  onCommand: listener => subscribe(CHANNELS.command, listener)
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('codexStatus', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.codexStatus = api
}

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrappedListener = (_event: Electron.IpcRendererEvent, payload: T): void => {
    listener(payload)
  }

  ipcRenderer.on(channel, wrappedListener)
  return () => {
    ipcRenderer.removeListener(channel, wrappedListener)
  }
}
