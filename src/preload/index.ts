import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  AppSettings,
  BootstrapPayload,
  BroadcastSendResult,
  CapsuleDragMovePayload,
  CodexStatusApi,
  PanelView,
  PreferencesPayload,
  ReactionSendResult,
  SpendUsage,
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
  spendUsage: 'codex-status:spend-usage',
  tokenUsageRange: 'codex-status:token-usage-range',
  setCapsuleSize: 'codex-status:set-capsule-size',
  updateProgress: 'codex-status:update-progress',
  sendBroadcast: 'codex-status:send-broadcast',
  broadcastMessage: 'codex-status:broadcast-message',
  sendReaction: 'codex-status:send-reaction',
  reaction: 'codex-status:reaction'
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
  showPanel: (view: PanelView, options?: { focusUpdate?: boolean }) =>
    ipcRenderer.invoke(CHANNELS.showPanel, view, options) as Promise<void>,
  checkForUpdate: () => ipcRenderer.invoke(CHANNELS.checkUpdate) as Promise<UpdateCheckResult>,
  getTokenUsage: (window: UsageWindow) =>
    ipcRenderer.invoke(CHANNELS.tokenUsage, window) as Promise<TokenUsageOverview>,
  getTokenUsageRange: (startMs: number, endMs: number) =>
    ipcRenderer.invoke(CHANNELS.tokenUsageRange, startMs, endMs) as Promise<TokenUsageOverview>,
  getSpendUsage: (window: UsageWindow) =>
    ipcRenderer.invoke(CHANNELS.spendUsage, window) as Promise<SpendUsage>,
  setCapsuleSize: (size: { width: number; height: number }) =>
    ipcRenderer.invoke(CHANNELS.setCapsuleSize, size) as Promise<void>,
  sendBroadcast: (text: string) =>
    ipcRenderer.invoke(CHANNELS.sendBroadcast, text) as Promise<BroadcastSendResult>,
  sendReaction: (targetPeerId: string, action: 'add' | 'remove') =>
    ipcRenderer.invoke(CHANNELS.sendReaction, targetPeerId, action) as Promise<ReactionSendResult>,
  downloadUpdate: () => ipcRenderer.invoke(CHANNELS.downloadUpdate) as Promise<void>,
  installUpdate: () => ipcRenderer.invoke(CHANNELS.installUpdate) as Promise<void>,
  onSnapshotUpdated: listener => subscribe(CHANNELS.snapshotUpdated, listener),
  onPreferencesUpdated: listener => subscribe(CHANNELS.preferencesUpdated, listener),
  onCommand: listener => subscribe(CHANNELS.command, listener),
  onUpdateProgress: listener => subscribe(CHANNELS.updateProgress, listener),
  onBroadcastMessage: listener => subscribe(CHANNELS.broadcastMessage, listener),
  onReaction: listener => subscribe(CHANNELS.reaction, listener)
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
