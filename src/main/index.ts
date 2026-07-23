import {
  app,
  shell,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  Tray,
  nativeImage,
  screen,
  type MenuItemConstructorOptions,
  type Rectangle
} from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { watchFile, unwatchFile } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import electronUpdater, { type AppUpdater } from 'electron-updater'
import appIcon from '../../build/icon-1.png?asset'
import trayIcon from '../../build/icon-2.png?asset'
import {
  CAPSULE_DOCK_THRESHOLD,
  CAPSULE_DOCK_EDGE_GAP,
  CAPSULE_EDGE_GAP,
  CAPSULE_WINDOW_SIZE,
  CAPSULE_UNDOCK_THRESHOLD,
  DEFAULT_SETTINGS,
  DEFAULT_WINDOW_PREFERENCES,
  ORB_WINDOW_SIZE,
  PANEL_WINDOW_SIZE,
  createEmptySnapshot,
  normalizeSettings,
  type CapsuleDragMovePayload,
  type DockEdge,
  type PanelView,
  type AppSettings,
  type PreferencesPayload,
  type RendererCommandPayload,
  type PersistedState,
  type RendererWindowRole,
  type UsageSnapshot,
  type WindowPreferences
} from '../shared/capsule'
import {
  areOfficialDispatchResetAtsStable,
  collectUsageSnapshot,
  fetchOfficialDispatchResetAts,
  resolveCodexAuthPath
} from './services/quota'
import { loadPersistedState, savePersistedState } from './services/state'

function getAutoUpdater(): AppUpdater {
  const { autoUpdater } = electronUpdater
  return autoUpdater
}

const autoUpdater = getAutoUpdater()

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

// --ignore-user-config 隔离 ~/.codex/config.toml,模型固定为 gpt-5.4-mini,不随用户配置变化
const CODEX_DISPATCH_COMMAND =
  'codex exec --skip-git-repo-check --ephemeral --ignore-user-config --color never -m gpt-5.4-mini hi'
const CODEX_DISPATCH_TIMEOUT_MS = 180_000
const CODEX_DISPATCH_OUTPUT_LIMIT = 2000
const CODEX_DISPATCH_VERIFY_DELAY_MS = 8000
const SINGLE_CAPSULE_WINDOW_WIDTH = 160
const SINGLE_ORB_WINDOW_HEIGHT = 96
// 激活态下官方接口的 reset_at 实测存在 ±1s 抖动;漂移态两次查询差值约等于查询间隔(8s+),
// 容差取 3s 可同时避开抖动误判和漂移漏判
const CODEX_DISPATCH_RESET_AT_TOLERANCE_SECONDS = 3

let mainWindow: BrowserWindow | null = null
let panelWindow: BrowserWindow | null = null
let tray: Tray | null = null
let dispatchChild: ChildProcess | undefined
let refreshTimer: NodeJS.Timeout | undefined
let persistTimer: NodeJS.Timeout | undefined
let refreshPromise: Promise<void> | undefined
let watchedCodexAuthPath: string | undefined
let isCheckingForUpdates = false
let isQuitting = false
let currentPanelView: PanelView = 'details'
let persistedState: PersistedState = {
  settings: { ...DEFAULT_SETTINGS },
  window: { ...DEFAULT_WINDOW_PREFERENCES },
  panel: {}
}
let currentSnapshot: UsageSnapshot = createEmptySnapshot()

const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (panelWindow && !panelWindow.isDestroyed()) {
      panelWindow.show()
      panelWindow.focus()
      return
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      showWindow()
    }
  })
}

function createCapsuleWindow(): BrowserWindow {
  const bounds = resolveCapsuleBounds(persistedState.window)

  const window = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    thickFrame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon: appIcon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  window.on('ready-to-show', () => {
    window.show()
  })

  window.on('move', () => {
    const bounds = window.getBounds()
    persistedState = {
      ...persistedState,
      window: {
        ...persistedState.window,
        x: bounds.x,
        y: bounds.y
      }
    }
    queuePersistState()
  })

  window.on('show', () => {
    refreshTrayMenu()
  })

  window.on('hide', () => {
    refreshTrayMenu()
  })

  window.on('close', (event) => {
    if (isQuitting) {
      return
    }

    event.preventDefault()
    window.hide()
  })

  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  loadRenderer(window, 'capsule')

  return window
}

function createPanelWindow(): BrowserWindow {
  const window = new BrowserWindow({
    ...resolvePanelBounds(persistedState.panel.x, persistedState.panel.y),
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    thickFrame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon: appIcon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  window.on('ready-to-show', () => {
    window.show()
  })

  window.on('move', () => {
    const bounds = window.getBounds()
    persistedState = {
      ...persistedState,
      panel: {
        x: bounds.x,
        y: bounds.y
      }
    }
    queuePersistState()
  })

  window.on('close', (event) => {
    if (isQuitting) {
      return
    }

    event.preventDefault()
    window.hide()
  })

  window.on('closed', () => {
    panelWindow = null
  })

  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  loadRenderer(window, 'panel')

  return window
}

function loadRenderer(window: BrowserWindow, role: RendererWindowRole): void {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const url = new URL(process.env['ELECTRON_RENDERER_URL'])
    url.searchParams.set('window', role)
    window.loadURL(url.toString())
    return
  }

  window.loadFile(join(__dirname, '../renderer/index.html'), {
    query: {
      window: role
    }
  })
}

if (hasSingleInstanceLock) {
  app.whenReady().then(async () => {
    const loadedState = await loadPersistedState()
    electronApp.setAppUserModelId('com.openai.codex-status')

    persistedState = {
      ...loadedState,
      settings: syncLaunchAtLoginPreference(loadedState.settings)
    }
    currentSnapshot = createEmptySnapshot()

    if (persistedState.settings.launchAtLogin !== loadedState.settings.launchAtLogin) {
      queuePersistState()
    }

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    if (process.platform === 'darwin' && app.dock) {
      app.dock.hide()
    }

    registerIpcHandlers()
    mainWindow = createCapsuleWindow()
    createTray()
    watchCodexAuthFile()
    void refreshStatus()

    app.on('activate', function () {
      if (mainWindow === null) {
        mainWindow = createCapsuleWindow()
        refreshTrayMenu()
        return
      }

      showWindow()
    })
  })
}

app.on('window-all-closed', () => {
  return
})

app.on('before-quit', () => {
  isQuitting = true
  clearRefreshTimer()
  clearCodexAuthWatcher()
})

function registerIpcHandlers(): void {
  ipcMain.handle(CHANNELS.bootstrap, async (event) => {
    return {
      settings: persistedState.settings,
      window: persistedState.window,
      panel: persistedState.panel,
      snapshot: currentSnapshot,
      role: resolveRendererRole(event.sender.id),
      panelView: currentPanelView
    }
  })

  ipcMain.handle(CHANNELS.refresh, async () => {
    if (!canRefreshStatus()) {
      return currentSnapshot
    }

    await refreshStatus()
    return currentSnapshot
  })

  ipcMain.handle(CHANNELS.updateSettings, async (_, patch: Partial<AppSettings>) => {
    const nextSettings = syncLaunchAtLoginPreference({
      ...persistedState.settings,
      ...patch
    })

    persistedState = {
      ...persistedState,
      settings: nextSettings
    }

    queuePersistState()
    syncRefreshTimer()
    refreshTrayMenu()
    broadcastPreferences()

    if (persistedState.settings.refreshMode === 'auto' && canRefreshStatus()) {
      void refreshStatus()
    }

    return createPreferencesPayload()
  })

  ipcMain.handle(CHANNELS.closePanel, async () => {
    panelWindow?.hide()
  })

  ipcMain.handle(CHANNELS.moveCapsuleWindow, async (_, payload: CapsuleDragMovePayload) => {
    return moveCapsuleWindow(payload)
  })

  ipcMain.handle(CHANNELS.finishCapsuleWindowDrag, async () => {
    return finishCapsuleWindowDrag()
  })
}

function createTray(): void {
  const image = nativeImage.createFromPath(trayIcon)
  tray = new Tray(image.isEmpty() ? trayIcon : image.resize({ width: 16, height: 16 }))
  tray.on('click', () => {
    toggleWindowVisibility()
  })
  refreshTrayMenu()
}

function refreshTrayMenu(): void {
  if (!tray) {
    return
  }

  const labels = getTrayLabels()
  const dispatchMenuItems: MenuItemConstructorOptions[] =
    process.platform === 'win32'
      ? [
          {
            label: labels.dispatch,
            enabled: !dispatchChild,
            click: () => {
              launchCodexDispatch()
            }
          }
        ]
      : []
  const menuTemplate: MenuItemConstructorOptions[] = [
    {
      label: labels.refresh,
      enabled: canRefreshStatus(),
      click: () => {
        void refreshStatus()
      }
    },
    ...dispatchMenuItems,
    {
      label: labels.toggle,
      click: () => {
        toggleWindowVisibility()
      }
    },
    {
      label: labels.details,
      click: () => {
        openDetailsFromTray()
      }
    },
    {
      label: labels.settings,
      click: () => {
        openSettingsFromTray()
      }
    },
    {
      label: labels.checkForUpdates,
      enabled: !isCheckingForUpdates,
      click: () => {
        void checkForUpdates()
      }
    },
    { type: 'separator' },
    {
      label: labels.quit,
      click: () => {
        quitApp()
      }
    }
  ]

  tray.setContextMenu(Menu.buildFromTemplate(menuTemplate))
  tray.setToolTip(buildTrayTooltip())
}

function getTrayLabels(): Record<
  | 'refresh'
  | 'dispatch'
  | 'toggle'
  | 'details'
  | 'settings'
  | 'checkForUpdates'
  | 'quit',
  string
> {
  if (persistedState.settings.locale === 'en-US') {
    return {
      refresh: 'Refresh',
      dispatch: 'Dispatch',
      toggle: 'Show/Hide',
      details: 'Details',
      settings: 'Settings',
      checkForUpdates: 'Check for Updates',
      quit: 'Quit'
    }
  }

  return {
    refresh: '刷新',
    dispatch: '投送',
    toggle: '显示/隐藏',
    details: '详情',
    settings: '设置',
    checkForUpdates: '检查更新',
    quit: '退出'
  }
}

function buildTrayTooltip(): string {
  const windowTexts = currentSnapshot.rateLimits.map(formatTrayWindowText)
  const suffix = currentSnapshot.isRefreshing
    ? persistedState.settings.locale === 'en-US'
      ? ' · refreshing'
      : ' · 刷新中'
    : ''

  if (windowTexts.length === 0) {
    return persistedState.settings.locale === 'en-US'
      ? `Codex status unavailable${suffix}`
      : `Codex 暂无额度数据${suffix}`
  }

  return `${['Codex', ...windowTexts].join('  ')}${suffix}`
}

function formatTrayWindowText(windowState: UsageSnapshot['rateLimits'][number]): string {
  const percentage =
    persistedState.settings.percentageMode === 'used'
      ? windowState.usedPercent
      : windowState.remainingPercent

  return percentage === undefined
    ? `${windowState.label} --`
    : `${windowState.label} ${Math.round(percentage)}%`
}

function toggleWindowVisibility(): void {
  if (!mainWindow) {
    return
  }

  if (mainWindow.isVisible()) {
    mainWindow.hide()
  } else {
    showWindow()
  }
}

function showWindow(): void {
  if (!mainWindow) {
    return
  }

  const bounds = resolveCapsuleBounds(persistedState.window)
  mainWindow.setBounds(bounds)
  mainWindow.show()
  mainWindow.focus()
}

function openSettingsFromTray(): void {
  openPanelWindow('settings')
}

function openDetailsFromTray(): void {
  openPanelWindow('details')
}

function launchCodexDispatch(): void {
  if (process.platform !== 'win32' || dispatchChild) {
    return
  }

  const isEnglish = persistedState.settings.locale === 'en-US'
  let output = ''
  let timedOut = false

  // 静默执行不弹终端窗口;codex 的 npm shim 是 .cmd,必须经 cmd.exe 启动
  const child = spawn('cmd.exe', ['/c', CODEX_DISPATCH_COMMAND], {
    cwd: homedir(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: true
  })
  dispatchChild = child
  refreshTrayMenu()

  const appendOutput = (chunk: Buffer): void => {
    output = `${output}${chunk.toString()}`.slice(-CODEX_DISPATCH_OUTPUT_LIMIT)
  }
  child.stdout?.on('data', appendOutput)
  child.stderr?.on('data', appendOutput)

  // codex 卡死时终止整个进程树,避免静默进程无限挂起、菜单一直禁用
  const timeoutTimer = setTimeout(() => {
    timedOut = true
    if (child.pid !== undefined) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    }
  }, CODEX_DISPATCH_TIMEOUT_MS)

  const release = (): boolean => {
    if (dispatchChild !== child) {
      return false
    }

    clearTimeout(timeoutTimer)
    dispatchChild = undefined
    refreshTrayMenu()
    return true
  }

  const settleFailure = (detail: string): void => {
    if (!release()) {
      return
    }

    dialog.showErrorBox(
      isEnglish ? 'Codex dispatch failed' : 'Codex 投送失败',
      detail.trim() || (isEnglish ? 'Unknown error.' : '未知错误')
    )
  }

  // exit 0 只说明进程正常退出;是否真正启动计时窗口需向官方额度接口二次确认。
  // 验证期间保持 dispatchChild 占用,避免并发投送干扰 reset_at 对比
  const settleSuccess = async (): Promise<void> => {
    const verdict = await verifyDispatchActivation()
    if (!release()) {
      return
    }

    void refreshStatus()

    if (verdict === 'inactive') {
      dialog.showErrorBox(
        isEnglish ? 'Codex dispatch failed' : 'Codex 投送失败',
        isEnglish
          ? 'Command finished, but the rate limit window was not activated. This dispatch did not take effect.'
          : '命令已执行完成,但 Codex 计时窗口未被激活,本次投送未生效。'
      )
      return
    }

    new Notification({
      title: isEnglish ? 'Codex Dispatch' : 'Codex 投送',
      body:
        verdict === 'activated'
          ? isEnglish
            ? 'Dispatch completed. Rate limit window is counting down.'
            : '投送完成,计时窗口已激活'
          : verdict === 'unlimited'
            ? isEnglish
              ? 'Dispatch completed. The official API currently reports no rate limit window.'
              : '投送完成,官方当前未返回计时限额'
            : isEnglish
              ? 'Dispatch completed, but window activation could not be verified.'
              : '投送完成,但官方接口不可用,未能确认计时窗口',
      silent: true
    }).show()
  }

  child.on('error', (error) => {
    settleFailure(error.message)
  })

  child.on('exit', (code) => {
    if (code === 0) {
      // codex exec 正常完成一次对话必然输出 tokens used;缺失说明没有真实消费
      if (/tokens used/i.test(output)) {
        void settleSuccess()
        return
      }

      settleFailure(
        [
          isEnglish
            ? 'Process exited normally but reported no token usage; the request likely never reached Codex.'
            : '进程正常退出,但输出中没有 tokens used,请求可能没有真正发送给 Codex。',
          output
        ]
          .filter(Boolean)
          .join('\n')
      )
      return
    }

    const timeoutSeconds = Math.round(CODEX_DISPATCH_TIMEOUT_MS / 1000)
    const reason = timedOut
      ? isEnglish
        ? `Timed out after ${timeoutSeconds}s and was terminated.`
        : `等待超过 ${timeoutSeconds} 秒,已强制终止。`
      : ''
    settleFailure([reason, output].filter(Boolean).join('\n'))
  })
}

// 官方当前窗口未激活时 reset_at 恒为"当前时间+窗口全长",随查询时间漂移;激活后固定(仅 ±1s 抖动)。
// 两次间隔查询差值在容差内即已激活;首轮超差可能是激活恰好落在两次查询之间,再补一轮对比
async function verifyDispatchActivation(): Promise<
  'activated' | 'inactive' | 'unlimited' | 'unknown'
> {
  const first = await fetchOfficialDispatchResetAts()
  if (first === null) {
    return 'unlimited'
  }
  if (first === undefined) {
    return 'unknown'
  }

  await delay(CODEX_DISPATCH_VERIFY_DELAY_MS)
  const second = await fetchOfficialDispatchResetAts()
  if (second === null) {
    return 'unlimited'
  }
  if (second === undefined) {
    return 'unknown'
  }
  if (
    areOfficialDispatchResetAtsStable(
      first,
      second,
      CODEX_DISPATCH_RESET_AT_TOLERANCE_SECONDS
    )
  ) {
    return 'activated'
  }

  await delay(CODEX_DISPATCH_VERIFY_DELAY_MS)
  const third = await fetchOfficialDispatchResetAts()
  if (third === null) {
    return 'unlimited'
  }
  if (third === undefined) {
    return 'unknown'
  }
  return areOfficialDispatchResetAtsStable(
    second,
    third,
    CODEX_DISPATCH_RESET_AT_TOLERANCE_SECONDS
  )
    ? 'activated'
    : 'inactive'
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function checkForUpdates(): Promise<void> {
  if (isCheckingForUpdates) {
    return
  }

  const isEnglish = persistedState.settings.locale === 'en-US'
  if (!app.isPackaged) {
    await dialog.showMessageBox({
      type: 'info',
      title: isEnglish ? 'Check for Updates' : '检查更新',
      message: isEnglish
        ? 'Update checks are available in the installed app.'
        : '检查更新仅适用于已安装的正式版本。'
    })
    return
  }

  isCheckingForUpdates = true
  refreshTrayMenu()

  try {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    const update = await autoUpdater.checkForUpdates()
    if (!update) {
      throw new Error(isEnglish ? 'The updater is unavailable.' : '更新服务不可用。')
    }

    const currentVersion = app.getVersion()
    if (!update.isUpdateAvailable) {
      await dialog.showMessageBox({
        type: 'info',
        title: isEnglish ? 'Check for Updates' : '检查更新',
        message: isEnglish ? 'You are using the latest version.' : '当前已是最新版本。',
        detail: isEnglish ? `Current version: v${currentVersion}` : `当前版本：v${currentVersion}`
      })
      return
    }

    const latestVersion = update.updateInfo.version
    const result = await dialog.showMessageBox({
      type: 'info',
      title: isEnglish ? 'Update Available' : '发现新版本',
      message: isEnglish
        ? `Version v${latestVersion} is available.`
        : `发现新版本 v${latestVersion}。`,
      detail: isEnglish ? `Current version: v${currentVersion}` : `当前版本：v${currentVersion}`,
      buttons: isEnglish ? ['Update and Restart', 'Later'] : ['更新并重启', '稍后'],
      defaultId: 0,
      cancelId: 1
    })
    if (result.response !== 0) {
      return
    }

    new Notification({
      title: isEnglish ? 'Updating Codex Status' : '正在更新 Codex Status',
      body: isEnglish ? 'Downloading the update…' : '正在下载更新…',
      silent: true
    }).show()
    await autoUpdater.downloadUpdate()
    prepareToQuit()
    autoUpdater.quitAndInstall(true, true)
  } catch (error) {
    if (!isQuitting) {
      dialog.showErrorBox(
        isEnglish ? 'Update Check Failed' : '检查更新失败',
        error instanceof Error ? error.message : String(error)
      )
    }
  } finally {
    isCheckingForUpdates = false
    if (!isQuitting) {
      refreshTrayMenu()
    }
  }
}

function prepareToQuit(): void {
  isQuitting = true
  clearRefreshTimer()
  clearCodexAuthWatcher()
  tray?.destroy()
  panelWindow?.destroy()
}

function quitApp(): void {
  prepareToQuit()
  app.quit()
}

function watchCodexAuthFile(): void {
  watchedCodexAuthPath = resolveCodexAuthPath()
  watchFile(watchedCodexAuthPath, { interval: 2000 }, (current, previous) => {
    if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) {
      return
    }

    void refreshStatus({ forceCredentialCheck: true })
  })
}

function clearCodexAuthWatcher(): void {
  if (!watchedCodexAuthPath) {
    return
  }

  unwatchFile(watchedCodexAuthPath)
  watchedCodexAuthPath = undefined
}

function syncRefreshTimer(): void {
  clearRefreshTimer()
  if (persistedState.settings.refreshMode !== 'auto' || !canRefreshStatus()) {
    return
  }

  refreshTimer = setInterval(() => {
    void refreshStatus()
  }, persistedState.settings.refreshIntervalSeconds * 1000)
}

function clearRefreshTimer(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = undefined
  }
}

async function refreshStatus(options: { forceCredentialCheck?: boolean } = {}): Promise<void> {
  if (refreshPromise) {
    return refreshPromise
  }

  if (!options.forceCredentialCheck && !canRefreshStatus() && currentSnapshot.generatedAt) {
    syncRefreshTimer()
    return
  }

  currentSnapshot = {
    ...currentSnapshot,
    isRefreshing: true
  }
  broadcastSnapshot()
  refreshTrayMenu()

  refreshPromise = (async () => {
    try {
      currentSnapshot = await collectUsageSnapshot()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      currentSnapshot = {
        ...currentSnapshot,
        isRefreshing: false,
        issues: Array.from(new Set([message, ...currentSnapshot.issues])).slice(0, 6)
      }
    } finally {
      currentSnapshot = {
        ...currentSnapshot,
        isRefreshing: false
      }
      syncCapsuleWindowBounds()
      broadcastSnapshot()
      refreshTrayMenu()
      syncRefreshTimer()
      refreshPromise = undefined
    }
  })()

  return refreshPromise
}

function canRefreshStatus(): boolean {
  return currentSnapshot.canRefresh !== false
}

function syncCapsuleWindowBounds(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBounds(resolveCapsuleBounds(persistedState.window))
  }
}

function broadcastSnapshot(): void {
  sendToRenderers(CHANNELS.snapshotUpdated, currentSnapshot)
}

function broadcastPreferences(): void {
  sendToRenderers(CHANNELS.preferencesUpdated, createPreferencesPayload())
}

function createPreferencesPayload(): PreferencesPayload {
  return {
    settings: persistedState.settings,
    window: persistedState.window,
    panel: persistedState.panel
  }
}

function syncLaunchAtLoginPreference(settings: AppSettings): AppSettings {
  const normalizedSettings = normalizeSettings(settings)

  if (!isLaunchAtLoginSupported()) {
    return {
      ...normalizedSettings,
      launchAtLogin: false
    }
  }

  app.setLoginItemSettings({
    openAtLogin: normalizedSettings.launchAtLogin
  })

  return {
    ...normalizedSettings,
    launchAtLogin: app.getLoginItemSettings().openAtLogin
  }
}

function isLaunchAtLoginSupported(): boolean {
  return process.platform === 'win32' || process.platform === 'darwin'
}

function openPanelWindow(view: PanelView): void {
  currentPanelView = view
  if (!panelWindow || panelWindow.isDestroyed()) {
    panelWindow = createPanelWindow()
  } else {
    if (!panelWindow.isVisible()) {
      panelWindow.setBounds(resolvePanelBounds(persistedState.panel.x, persistedState.panel.y))
    }
    panelWindow.show()
    panelWindow.focus()
  }

  panelWindow.webContents.send(CHANNELS.command, {
    type: 'show-panel-view',
    panelView: currentPanelView
  } satisfies RendererCommandPayload)
}

function moveCapsuleWindow(payload: CapsuleDragMovePayload): WindowPreferences {
  if (!mainWindow) {
    return persistedState.window
  }

  const nextPreferences = resolveDraggedCapsuleWindow(payload)
  applyCapsuleWindowPreferences(nextPreferences, true)
  return persistedState.window
}

function finishCapsuleWindowDrag(): WindowPreferences {
  if (!mainWindow) {
    return persistedState.window
  }

  applyCapsuleWindowPreferences(resolveSettledCapsuleWindow(persistedState.window))
  broadcastPreferences()
  return persistedState.window
}

function applyCapsuleWindowPreferences(
  preferences: WindowPreferences,
  allowFloatingOrb = false
): void {
  const bounds = resolveCapsuleBounds(preferences, allowFloatingOrb)
  persistedState = {
    ...persistedState,
    window: {
      ...preferences,
      x: bounds.x,
      y: bounds.y
    }
  }
  mainWindow?.setBounds(bounds)
  queuePersistState()
}

function resolveDraggedCapsuleWindow(payload: CapsuleDragMovePayload): WindowPreferences {
  const currentBounds = mainWindow?.getBounds() ?? resolveCapsuleBounds(persistedState.window)
  const offsetX = clamp(
    getFiniteNumber(payload.offsetX, currentBounds.width / 2),
    0,
    currentBounds.width
  )
  const offsetY = clamp(
    getFiniteNumber(payload.offsetY, currentBounds.height / 2),
    0,
    currentBounds.height
  )
  const screenX = getFiniteNumber(payload.screenX, currentBounds.x + offsetX)
  const screenY = getFiniteNumber(payload.screenY, currentBounds.y + offsetY)
  const desiredX = Math.round(screenX - offsetX)
  const desiredY = Math.round(screenY - offsetY)
  const workArea = getTargetWorkArea(desiredX, desiredY)
  const workAreaRight = workArea.x + workArea.width
  const isDraggingOrb =
    persistedState.window.viewMode === 'orb' && Boolean(persistedState.window.dockEdge)
  const size = resolveCapsuleWindowSize(isDraggingOrb ? 'orb' : 'capsule')
  const x = clamp(
    desiredX,
    workArea.x + CAPSULE_DOCK_EDGE_GAP,
    workAreaRight - size.width - CAPSULE_DOCK_EDGE_GAP
  )
  const y = clamp(
    desiredY,
    workArea.y + CAPSULE_EDGE_GAP,
    workArea.y + workArea.height - size.height - CAPSULE_EDGE_GAP
  )

  return {
    x,
    y,
    viewMode: isDraggingOrb ? 'orb' : 'capsule',
    dockEdge: isDraggingOrb ? persistedState.window.dockEdge : undefined
  }
}

function resolveSettledCapsuleWindow(preferences: WindowPreferences): WindowPreferences {
  if (preferences.viewMode === 'orb' && preferences.dockEdge) {
    return resolveSettledOrbWindow(preferences)
  }

  const capsuleBounds = resolveCapsuleBounds({
    ...preferences,
    viewMode: 'capsule',
    dockEdge: undefined
  })
  const workArea = getTargetWorkArea(capsuleBounds.x, capsuleBounds.y)
  const workAreaRight = workArea.x + workArea.width
  const capsuleSize = resolveCapsuleWindowSize('capsule')
  const orbSize = resolveCapsuleWindowSize('orb')
  const capsuleRight = capsuleBounds.x + capsuleSize.width
  let dockEdge: DockEdge | undefined

  if (capsuleBounds.x <= workArea.x + CAPSULE_DOCK_THRESHOLD) {
    dockEdge = 'left'
  } else if (capsuleRight >= workAreaRight - CAPSULE_DOCK_THRESHOLD) {
    dockEdge = 'right'
  }

  if (!dockEdge) {
    return {
      x: capsuleBounds.x,
      y: capsuleBounds.y,
      viewMode: 'capsule'
    }
  }

  const y = clamp(
    capsuleBounds.y + Math.round((capsuleSize.height - orbSize.height) / 2),
    workArea.y + CAPSULE_EDGE_GAP,
    workArea.y + workArea.height - orbSize.height - CAPSULE_EDGE_GAP
  )

  return {
    x:
      dockEdge === 'left'
        ? workArea.x + CAPSULE_DOCK_EDGE_GAP
        : workAreaRight - orbSize.width - CAPSULE_DOCK_EDGE_GAP,
    y,
    viewMode: 'orb',
    dockEdge
  }
}

function resolveSettledOrbWindow(preferences: WindowPreferences): WindowPreferences {
  const orbBounds = resolveCapsuleBounds(preferences, true)
  const workArea = getTargetWorkArea(orbBounds.x, orbBounds.y)
  const workAreaRight = workArea.x + workArea.width
  const capsuleSize = resolveCapsuleWindowSize('capsule')
  const orbSize = resolveCapsuleWindowSize('orb')
  const orbRight = orbBounds.x + orbSize.width
  const keepsLeftDock =
    preferences.dockEdge === 'left' && orbBounds.x <= workArea.x + CAPSULE_UNDOCK_THRESHOLD
  const keepsRightDock =
    preferences.dockEdge === 'right' && orbRight >= workAreaRight - CAPSULE_UNDOCK_THRESHOLD

  if (keepsLeftDock || keepsRightDock) {
    return {
      x:
        preferences.dockEdge === 'left'
          ? workArea.x + CAPSULE_DOCK_EDGE_GAP
          : workAreaRight - orbSize.width - CAPSULE_DOCK_EDGE_GAP,
      y: orbBounds.y,
      viewMode: 'orb',
      dockEdge: preferences.dockEdge
    }
  }

  return {
    x: clamp(
      orbBounds.x + Math.round((orbSize.width - capsuleSize.width) / 2),
      workArea.x + CAPSULE_EDGE_GAP,
      workAreaRight - capsuleSize.width - CAPSULE_EDGE_GAP
    ),
    y: clamp(
      orbBounds.y + Math.round((orbSize.height - capsuleSize.height) / 2),
      workArea.y + CAPSULE_EDGE_GAP,
      workArea.y + workArea.height - capsuleSize.height - CAPSULE_EDGE_GAP
    ),
    viewMode: 'capsule'
  }
}

function resolveCapsuleBounds(
  windowPreferences: WindowPreferences,
  allowFloatingOrb = false
): Rectangle {
  const viewMode =
    windowPreferences.viewMode === 'orb' && (windowPreferences.dockEdge || allowFloatingOrb)
      ? windowPreferences.viewMode
      : 'capsule'
  const { width, height } = resolveCapsuleWindowSize(viewMode)
  const workArea = getTargetWorkArea(windowPreferences.x, windowPreferences.y)
  const fallbackX = workArea.x + workArea.width - width - 40
  const fallbackY = workArea.y + 36
  const maxX = Math.max(
    workArea.x + CAPSULE_EDGE_GAP,
    workArea.x + workArea.width - width - CAPSULE_EDGE_GAP
  )
  const maxY = Math.max(
    workArea.y + CAPSULE_EDGE_GAP,
    workArea.y + workArea.height - height - CAPSULE_EDGE_GAP
  )
  const x =
    viewMode === 'orb' && windowPreferences.dockEdge === 'left' && !allowFloatingOrb
      ? workArea.x + CAPSULE_DOCK_EDGE_GAP
      : viewMode === 'orb' && windowPreferences.dockEdge === 'right' && !allowFloatingOrb
        ? workArea.x + workArea.width - width - CAPSULE_DOCK_EDGE_GAP
        : clamp(
            typeof windowPreferences.x === 'number' ? Math.round(windowPreferences.x) : fallbackX,
            viewMode === 'orb' ? workArea.x + CAPSULE_DOCK_EDGE_GAP : workArea.x + CAPSULE_EDGE_GAP,
            viewMode === 'orb' ? workArea.x + workArea.width - width - CAPSULE_DOCK_EDGE_GAP : maxX
          )

  return {
    x,
    y: clamp(
      typeof windowPreferences.y === 'number' ? Math.round(windowPreferences.y) : fallbackY,
      workArea.y + CAPSULE_EDGE_GAP,
      maxY
    ),
    width,
    height
  }
}

function resolveCapsuleWindowSize(viewMode: 'capsule' | 'orb'): {
  width: number
  height: number
} {
  const size = viewMode === 'orb' ? ORB_WINDOW_SIZE : CAPSULE_WINDOW_SIZE
  const rateLimitCount = currentSnapshot.rateLimits.length

  if (rateLimitCount === 0) {
    return size
  }

  return viewMode === 'orb'
    ? {
        ...size,
        height:
          SINGLE_ORB_WINDOW_HEIGHT +
          (rateLimitCount - 1) * (ORB_WINDOW_SIZE.height - SINGLE_ORB_WINDOW_HEIGHT)
      }
    : {
        ...size,
        width:
          SINGLE_CAPSULE_WINDOW_WIDTH +
          (rateLimitCount - 1) * (CAPSULE_WINDOW_SIZE.width - SINGLE_CAPSULE_WINDOW_WIDTH)
      }
}

function resolvePanelBounds(x?: number, y?: number): Rectangle {
  const width = PANEL_WINDOW_SIZE.width
  const height = PANEL_WINDOW_SIZE.height
  const workArea = getTargetWorkArea(x, y)
  const fallbackX = workArea.x + workArea.width - width - 40
  const fallbackY = workArea.y + 120
  const maxX = Math.max(workArea.x + 8, workArea.x + workArea.width - width - 8)
  const maxY = Math.max(workArea.y + 8, workArea.y + workArea.height - height - 8)

  return {
    x: clamp(typeof x === 'number' ? Math.round(x) : fallbackX, workArea.x + 8, maxX),
    y: clamp(typeof y === 'number' ? Math.round(y) : fallbackY, workArea.y + 8, maxY),
    width,
    height
  }
}

function sendToRenderers(channel: string, payload: unknown): void {
  mainWindow?.webContents.send(channel, payload)
  panelWindow?.webContents.send(channel, payload)
}

function resolveRendererRole(webContentsId: number): RendererWindowRole {
  return panelWindow?.webContents.id === webContentsId ? 'panel' : 'capsule'
}

function getTargetWorkArea(x?: number, y?: number): Rectangle {
  if (typeof x === 'number' && typeof y === 'number') {
    return screen.getDisplayNearestPoint({ x, y }).workArea
  }
  return screen.getPrimaryDisplay().workArea
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function getFiniteNumber(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

function queuePersistState(): void {
  if (persistTimer) {
    clearTimeout(persistTimer)
  }

  persistTimer = setTimeout(() => {
    void savePersistedState(persistedState)
  }, 180)
}
