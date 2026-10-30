import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import path from 'node:path'
import { execFile } from 'node:child_process'
import {
  CLEANER_CHANNELS as channels,
  type CleanerSettings
} from '../../../shared/session-cleaner.ts'
import { CleanerController } from './controller.ts'
import { exportSessions, resumeSession } from './operations.ts'

const WINDOW_SIZE = { width: 1090, height: 770, minWidth: 880, minHeight: 640 }

export function registerSessionCleaner(options: {
  canOpen: (senderId: number) => boolean
  activeThreadIds: () => string[]
  retentionDirectory: string
}): void {
  let window: BrowserWindow | undefined
  let controller: CleanerController | undefined
  let initializing: Promise<void> | undefined
  let loading: Promise<void> | undefined
  let activeTask: Promise<unknown> | undefined
  let closing = false
  let quitting = false

  function windowForSender(senderId: number): BrowserWindow | undefined {
    if (!window || window.isDestroyed() || window.webContents.id !== senderId) return undefined
    return window
  }

  function requireWindow(senderId: number): CleanerController {
    if (
      !window ||
      window.isDestroyed() ||
      window.webContents.id !== senderId ||
      !controller ||
      initializing
    )
      throw new Error('此请求不属于会话清理窗口')
    return controller
  }

  async function open(): Promise<void> {
    if (quitting || closing) return
    if (!window || window.isDestroyed()) {
      const created = createWindow()
      window = created
      controller = new CleanerController({
        directory: path.join(app.getPath('userData'), 'tools', 'session-cleaner'),
        retentionDirectory: options.retentionDirectory,
        activeThreadIds: options.activeThreadIds,
        coreExecutable: path.join(
          app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources'),
          'session-core',
          process.platform === 'win32' ? 'session-core.exe' : 'session-core'
        ),
        onProgress: (progress) => {
          if (window && !window.isDestroyed()) window.webContents.send(channels.progress, progress)
        }
      })
      initializing = controller.initialize()
      try {
        await initializing
      } catch (error) {
        await dialog.showMessageBox(created, {
          type: 'error',
          message: '会话清理无法启动',
          detail: String(error)
        })
        created.destroy()
        return
      } finally {
        initializing = undefined
      }
      created.once('ready-to-show', () => {
        if (!created.isDestroyed()) created.show()
      })
      const rendererUrl = process.env.ELECTRON_RENDERER_URL
      loading =
        !app.isPackaged && rendererUrl
          ? created.loadURL(new URL('session-cleaner.html', `${rendererUrl}/`).toString())
          : created.loadFile(path.join(__dirname, '../renderer/session-cleaner.html'))
      try {
        await loading
      } finally {
        loading = undefined
      }
    } else {
      if (initializing) await initializing
      if (loading) await loading
    }
    const target = window
    if (!target || target.isDestroyed() || quitting || closing) return
    if (target.isMinimized()) target.restore()
    target.show()
    target.focus()
    target.webContents.send(channels.scanRequested)
  }

  function createWindow(): BrowserWindow {
    const created = new BrowserWindow({
      ...WINDOW_SIZE,
      title: '会话清理 · CodexStatus',
      frame: false,
      icon: path.join(app.getAppPath(), 'build', 'icon-session-cleaner.png'),
      show: false,
      backgroundColor: '#0b0f1a',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, '../preload/session-cleaner.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    created.webContents.on('will-navigate', (event) => event.preventDefault())
    const notifyMaximized = (): void => {
      if (created.isDestroyed() || created.webContents.isDestroyed()) return
      created.webContents.send(channels.windowMaximized, created.isMaximized())
    }
    created.on('maximize', notifyMaximized)
    created.on('unmaximize', notifyMaximized)
    created.on('restore', notifyMaximized)
    created.on('close', (event) => {
      if (!activeTask) return
      event.preventDefault()
      closing = true
      controller?.stop()
      void activeTask.finally(() => created.destroy()).catch(() => undefined)
    })
    created.on('closed', () => {
      controller?.stop()
      controller?.dispose()
      controller = undefined
      window = undefined
      closing = false
    })
    return created
  }

  function handle(
    channel: string,
    run: (tool: CleanerController, ...args: unknown[]) => unknown
  ): void {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      const tool = requireWindow(event.sender.id)
      if (closing || activeTask) throw new Error('工具任务执行中，请稍后操作')
      const task = Promise.resolve().then(() => run(tool, ...args))
      activeTask = task
      return task.finally(() => {
        if (activeTask === task) activeTask = undefined
      })
    })
  }

  ipcMain.handle(channels.open, (event) => {
    if (!options.canOpen(event.sender.id)) throw new Error('仅设置面板可以打开会话清理')
    return open()
  })
  ipcMain.handle(channels.windowIsMaximized, (event) => {
    requireWindow(event.sender.id)
    return window!.isMaximized()
  })
  ipcMain.on(channels.windowMinimize, (event) => {
    windowForSender(event.sender.id)?.minimize()
  })
  ipcMain.on(channels.windowToggleMaximize, (event) => {
    const target = windowForSender(event.sender.id)
    if (!target) return
    if (target.isMaximized()) target.unmaximize()
    else target.maximize()
  })
  ipcMain.on(channels.windowClose, (event) => {
    windowForSender(event.sender.id)?.close()
  })
  ipcMain.handle(channels.state, (event) => requireWindow(event.sender.id).getState())
  ipcMain.handle(channels.cancel, (event) => requireWindow(event.sender.id).cancelScan())
  ipcMain.handle(channels.cancelOperation, (event) =>
    requireWindow(event.sender.id).cancelOperation()
  )
  handle(channels.discover, (tool) => tool.discover())
  handle(channels.importSource, async (tool) => {
    const result = await dialog.showOpenDialog(window!, {
      title: '选择 Agent 数据目录',
      properties: ['openDirectory']
    })
    return result.canceled ? tool.getState() : tool.importSource(result.filePaths[0])
  })
  handle(channels.removeSource, (tool, id) => tool.removeSource(requireString(id)))
  handle(channels.scan, (tool) => tool.scan())
  handle(channels.settings, (tool, settings) => tool.saveSettings(settings as CleanerSettings))
  handle(channels.protect, (tool, ids, value) => {
    if (typeof value !== 'boolean') throw new Error('保护状态无效')
    return tool.protect(ids as string[], value)
  })
  handle(channels.review, (tool, ids) => tool.review(ids as string[]))
  handle(channels.recycle, (tool, id) => tool.recycle(requireString(id)))
  handle(channels.details, (tool, id) => tool.details(requireString(id)))
  handle(channels.transcript, (tool, id) => tool.transcript(requireString(id)))
  handle(channels.blockContent, (tool, id, reference, offset) =>
    tool.blockContent(requireString(id), reference, offset as number | undefined)
  )
  handle(channels.exportSessions, (tool, ids) =>
    exportSessions({
      window: window!,
      tool,
      ids: ids as string[]
    })
  )
  handle(channels.resume, (tool, id) => resumeSession(tool, requireString(id)))
  handle(channels.compact, async (tool, id) => {
    const result = await dialog.showMessageBox(window!, {
      type: 'warning',
      buttons: ['取消', '整理数据库'],
      defaultId: 0,
      cancelId: 0,
      message: '整理数据库以回收库内空闲页',
      detail: '请先关闭正在写入该数据库的工具。整理期间需要额外磁盘空间，且不能中途强制停止。'
    })
    return result.response === 1 ? tool.compactDatabase(requireString(id)) : tool.getState()
  })
  handle(channels.reveal, (tool, id) => shell.showItemInFolder(tool.itemPath(requireString(id))))
  handle(channels.recycleBin, () => openRecycleBin())
  app.on('before-quit', (event) => {
    quitting = true
    controller?.stop()
    if (!activeTask) return
    event.preventDefault()
    void activeTask.finally(() => app.quit()).catch(() => undefined)
  })
}

function requireString(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 1024) throw new Error('条目标识无效')
  return value
}

function openRecycleBin(): Promise<void> {
  if (process.platform !== 'win32')
    return Promise.reject(new Error('首版仅支持 Windows 系统回收站'))
  return new Promise((resolve, reject) => {
    execFile('explorer.exe', ['shell:RecycleBinFolder'], { windowsHide: true }, (error) => {
      if (error) reject(new Error('系统回收站打开失败'))
      else resolve()
    })
  })
}
