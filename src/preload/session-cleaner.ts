import { contextBridge, ipcRenderer } from 'electron'
import { CLEANER_CHANNELS as channels, type SessionCleanerApi } from '../shared/session-cleaner'

let scanRequestedListener: (() => void) | undefined
let scanRequestPending = false
ipcRenderer.on(channels.scanRequested, () => {
  if (scanRequestedListener) scanRequestedListener()
  else scanRequestPending = true
})

const api: SessionCleanerApi = {
  getState: () => ipcRenderer.invoke(channels.state),
  discover: () => ipcRenderer.invoke(channels.discover),
  importSource: () => ipcRenderer.invoke(channels.importSource),
  removeSource: (id) => ipcRenderer.invoke(channels.removeSource, id),
  scan: () => ipcRenderer.invoke(channels.scan),
  cancelScan: () => ipcRenderer.invoke(channels.cancel),
  protect: (ids, value) => ipcRenderer.invoke(channels.protect, ids, value),
  saveSettings: (settings) => ipcRenderer.invoke(channels.settings, settings),
  review: (ids) => ipcRenderer.invoke(channels.review, ids),
  recycle: (id) => ipcRenderer.invoke(channels.recycle, id),
  details: (id) => ipcRenderer.invoke(channels.details, id),
  transcript: (id) => ipcRenderer.invoke(channels.transcript, id),
  blockContent: (id, reference, offset) =>
    ipcRenderer.invoke(channels.blockContent, id, reference, offset),
  exportSessions: (ids) => ipcRenderer.invoke(channels.exportSessions, ids),
  resumeSession: (id) => ipcRenderer.invoke(channels.resume, id),
  compactDatabase: (sourceId) => ipcRenderer.invoke(channels.compact, sourceId),
  cancelOperation: () => ipcRenderer.invoke(channels.cancelOperation),
  reveal: (id) => ipcRenderer.invoke(channels.reveal, id),
  openRecycleBin: () => ipcRenderer.invoke(channels.recycleBin),
  minimizeWindow: () => ipcRenderer.send(channels.windowMinimize),
  toggleMaximizeWindow: () => ipcRenderer.send(channels.windowToggleMaximize),
  closeWindow: () => ipcRenderer.send(channels.windowClose),
  isWindowMaximized: () => ipcRenderer.invoke(channels.windowIsMaximized) as Promise<boolean>,
  onWindowMaximized: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, maximized: boolean): void =>
      listener(maximized)
    ipcRenderer.on(channels.windowMaximized, wrapped)
    return () => {
      ipcRenderer.removeListener(channels.windowMaximized, wrapped)
    }
  },
  onScanRequested: (listener) => {
    scanRequestedListener = listener
    if (scanRequestPending) {
      scanRequestPending = false
      queueMicrotask(() => {
        if (scanRequestedListener === listener) listener()
      })
    }
    return () => {
      if (scanRequestedListener === listener) scanRequestedListener = undefined
    }
  },
  onProgress: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, value): void => listener(value)
    ipcRenderer.on(channels.progress, wrapped)
    return () => {
      ipcRenderer.removeListener(channels.progress, wrapped)
    }
  }
}

contextBridge.exposeInMainWorld('sessionCleaner', api)
