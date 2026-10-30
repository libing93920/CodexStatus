/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-require-imports */
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

function disabled(action) {
  return () => Promise.reject(new Error(`Visual fixture disables ${action}`))
}

const api = Object.freeze({
  getState: () => ipcRenderer.invoke('session-cleaner-visual:state'),
  discover: () => ipcRenderer.invoke('session-cleaner-visual:state'),
  importSource: disabled('source import'),
  removeSource: disabled('source removal'),
  scan: () => ipcRenderer.invoke('session-cleaner-visual:state'),
  cancelScan: () => Promise.resolve(),
  protect: disabled('protection changes'),
  saveSettings: disabled('settings changes'),
  review: (ids) => ipcRenderer.invoke('session-cleaner-visual:review', ids),
  recycle: disabled('recycling'),
  details: (id) => ipcRenderer.invoke('session-cleaner-visual:details', id),
  reveal: disabled('file reveal'),
  openRecycleBin: disabled('recycle-bin access'),
  minimizeWindow: () => undefined,
  toggleMaximizeWindow: () => undefined,
  closeWindow: () => undefined,
  isWindowMaximized: () => Promise.resolve(false),
  onWindowMaximized: () => () => undefined,
  onScanRequested: () => () => undefined,
  onProgress: (listener) => {
    const wrapped = (_event, value) => listener(value)
    ipcRenderer.on('session-cleaner-visual:progress', wrapped)
    return () => ipcRenderer.removeListener('session-cleaner-visual:progress', wrapped)
  }
})

contextBridge.exposeInMainWorld('sessionCleaner', api)
