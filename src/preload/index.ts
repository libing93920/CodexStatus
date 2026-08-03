import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  AppSettings,
  BootstrapPayload,
  CapsuleDragMovePayload,
  CodexStatusApi,
  PanelView,
  PreferencesPayload,
  TokenUsageOverview,
  UpdateCheckResult,
  UsageSnapshot,
  UsageWindow,
  WindowPreferences
} from '../shared/capsule'

const CHANNELS = {
  bootstrap: 'codex-status:bootstrap',
  refresh: 'codex-status:refresh',
  updateSettings: 'codex-status:update-settings',
  closePanel: 'codex-status:close-panel',
  moveCapsuleWindow: 'codex-status:move-capsule-window',
  finishCapsuleWindowDrag: 'codex-status:finish-capsule-window-drag',
  openExternal: 'codex-status:open-external',
  panelReady: 'codex-status:panel-ready',
  showPanel: 'codex-status:show-panel',
  snapshotUpdated: 'codex-status:snapshot-updated',
  preferencesUpdated: 'codex-status:preferences-updated',
  command: 'codex-status:command',
  checkUpdate: 'codex-status:check-update',
  downloadUpdate: 'codex-status:download-update',
  installUpdate: 'codex-status:install-update',
  tokenUsage: 'codex-status:token-usage',
  updateProgress: 'codex-status:update-progress'
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
  openExternal: (url) => ipcRenderer.invoke(CHANNELS.openExternal, url) as Promise<void>,
  notifyPanelReady: () => ipcRenderer.invoke(CHANNELS.panelReady) as Promise<void>,
  showPanel: (view: PanelView) => ipcRenderer.invoke(CHANNELS.showPanel, view) as Promise<void>,
  checkForUpdate: () => ipcRenderer.invoke(CHANNELS.checkUpdate) as Promise<UpdateCheckResult>,
  getTokenUsage: (window: UsageWindow) =>
    ipcRenderer.invoke(CHANNELS.tokenUsage, window) as Promise<TokenUsageOverview>,
  downloadUpdate: () => ipcRenderer.invoke(CHANNELS.downloadUpdate) as Promise<void>,
  installUpdate: () => ipcRenderer.invoke(CHANNELS.installUpdate) as Promise<void>,
  onSnapshotUpdated: listener => subscribe(CHANNELS.snapshotUpdated, listener),
  onPreferencesUpdated: listener => subscribe(CHANNELS.preferencesUpdated, listener),
  onCommand: listener => subscribe(CHANNELS.command, listener),
  onUpdateProgress: listener => subscribe(CHANNELS.updateProgress, listener)
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
