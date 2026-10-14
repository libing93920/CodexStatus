import type { BrowserWindow } from 'electron'
import { ACTIVITY_CHANNELS } from '../../shared/activity.ts'

export function subscribePanelVisibility(window: BrowserWindow): void {
  // 禁用后台节流时DOM仍可能报告visible，使用原生窗口事件传递实际状态。
  const notify = (): void => {
    if (window.webContents.isDestroyed()) return
    window.webContents.send(ACTIVITY_CHANNELS.panelVisibilityChanged, window.isVisible())
  }
  window.on('show', notify)
  window.on('hide', notify)
}

export function getPanelVisibility(window: BrowserWindow | null, senderId: number): boolean {
  return (
    window !== null &&
    !window.isDestroyed() &&
    window.webContents.id === senderId &&
    window.isVisible()
  )
}
