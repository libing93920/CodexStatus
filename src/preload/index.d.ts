import { ElectronAPI } from '@electron-toolkit/preload'
import type { CodexStatusApi } from '../shared/capsule'

declare global {
  interface Window {
    electron: ElectronAPI
    codexStatus: CodexStatusApi
  }
}
