import { app } from 'electron'
import { autoUpdater, NsisUpdater } from 'electron-updater'
import type { UpdateCheckResult } from 'electron-updater'
import type { UpdateCheckResult as ApiCheckResult, UpdateProgress } from '../../shared/capsule'

// 进度回调:由主进程注册,把 autoUpdater 事件转发给渲染层
let progressListener: ((payload: UpdateProgress) => void) | undefined

export function setUpdaterProgressListener(listener: (payload: UpdateProgress) => void): void {
  progressListener = listener
}

function emit(payload: UpdateProgress): void {
  progressListener?.(payload)
}

/** 初始化 autoUpdater:仅在打包后生效,dev 下为 no-op */
export function initAutoUpdater(): void {
  if (!app.isPackaged) {
    // dev 下 electron-updater 读不到 app-update.yml,直接跳过初始化避免噪音
    return
  }

  // 手动策略:不自动下载,由用户确认后才 downloadUpdate
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  // 静默 electron-updater 自带日志,避免探针刷屏控制台
  autoUpdater.logger = null

  // Windows 下关闭安装包代码签名校验:本项目无代码签名证书,
  // NsisUpdater 默认会校验 publisherName;app-update.yml 未配 publisherName 时
  // verifySignature 本就返回 null 跳过,这里再显式覆盖成恒通过,双保险
  if (autoUpdater instanceof NsisUpdater) {
    autoUpdater.verifyUpdateCodeSignature = async () => null
  }

  autoUpdater.on('checking-for-update', () => {
    emit({ stage: 'checking' })
  })
  autoUpdater.on('update-available', (info) => {
    emit({ stage: 'available', version: info.version })
  })
  autoUpdater.on('update-not-available', () => {
    emit({ stage: 'not-available' })
  })
  autoUpdater.on('download-progress', (info) => {
    emit({ stage: 'downloading', percent: info.percent })
  })
  autoUpdater.on('update-downloaded', (event) => {
    emit({ stage: 'downloaded', version: event.version })
  })
  autoUpdater.on('error', (error, message) => {
    emit({ stage: 'error', message: message ?? error.message })
  })
}

/** 检查是否有新版本;dev 环境直接返回不可用 */
export async function checkForUpdates(): Promise<ApiCheckResult> {
  if (!app.isPackaged) {
    return { available: false }
  }
  try {
    const result: UpdateCheckResult | null = await autoUpdater.checkForUpdates()
    if (!result || !result.updateInfo) {
      return { available: false }
    }
    return {
      available: true,
      version: result.updateInfo.version,
      releaseNotes: extractReleaseNotes(result.updateInfo)
    }
  } catch (error) {
    emit({
      stage: 'error',
      message: error instanceof Error ? error.message : String(error)
    })
    return { available: false }
  }
}

// releaseNotes 可能是字符串或结构化对象,统一抽成可展示文本
function extractReleaseNotes(updateInfo: { releaseNotes?: unknown }): string | undefined {
  const notes = updateInfo.releaseNotes
  if (typeof notes === 'string') return notes
  if (Array.isArray(notes)) {
    return notes.map((note) => (typeof note === 'string' ? note : note?.note ?? '')).join('\n')
  }
  if (notes && typeof notes === 'object' && 'note' in notes) {
    return String((notes as { note: unknown }).note)
  }
  return undefined
}

/** 下载已检测到的新版本 */
export async function downloadUpdate(): Promise<void> {
  if (!app.isPackaged) return
  await autoUpdater.downloadUpdate()
}

/** 退出并运行安装程序,覆盖升级;isForceRunAfter=true 确保安装后重启应用 */
export function installUpdate(): void {
  autoUpdater.quitAndInstall(false, true)
}
