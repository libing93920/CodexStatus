import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  Menu,
  Tray,
  nativeImage,
  screen,
  powerMonitor,
  type MenuItemConstructorOptions,
  type Rectangle
} from 'electron'
import { randomUUID } from 'node:crypto'
import { watchFile, unwatchFile } from 'node:fs'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'

const APP_ICON_PATH = join(__dirname, '../../build/icon-1.png')
const TRAY_ICON_PATH = join(__dirname, '../../build/icon-2.png')
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
  type RateLimitWindowSnapshot,
  type AppSettings,
  type PreferencesPayload,
  type RendererCommandPayload,
  type PersistedState,
  type RendererWindowRole,
  type TeamPeer,
  type UsageSnapshot,
  type UsageWindow,
  type WindowPreferences
} from '../shared/capsule'
import { collectUsageSnapshot, invalidateQuotaCaches, resolveCodexAuthPath } from './services/quota'
import { refreshRadarNow, startRadarTimer, stopRadarTimer } from './services/radar'
import {
  getCachedTokenTotals,
  getTokenUsage,
  setRateLookup,
  warmTokenTotals
} from './services/usage'
import { fetchModelsDevRates, getPricingRate } from './services/pricing'
import { getSpendUsage } from './services/billing'
import { loadPersistedState, savePersistedState } from './services/state'
import { LanService, type PeerSnapshot } from './services/lan'
import {
  initAutoUpdater,
  checkForUpdates,
  downloadUpdate,
  installUpdate,
  setUpdaterProgressListener
} from './services/updater'

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
  setCapsuleSize: 'codex-status:set-capsule-size',
  updateProgress: 'codex-status:update-progress'
} as const

const SINGLE_CAPSULE_WINDOW_WIDTH = 160
const SINGLE_ORB_WINDOW_HEIGHT = 96

let mainWindow: BrowserWindow | null = null
let panelWindow: BrowserWindow | null = null
let tray: Tray | null = null
let refreshTimer: NodeJS.Timeout | undefined
let persistTimer: NodeJS.Timeout | undefined
let refreshPromise: Promise<void> | undefined
let watchedCodexAuthPath: string | undefined
let isQuitting = false
let userHidCapsule = false
let currentPanelView: PanelView = 'details'
const lanService = new LanService()
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
    ...(process.platform === 'linux' ? { icon: APP_ICON_PATH } : {}),
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

  // 胶囊右键:弹原生菜单(刷新/显示隐藏/详情/设置/退出),不含投送和检查更新
  window.webContents.on('context-menu', (_event, params) => {
    const menu = Menu.buildFromTemplate(buildCapsuleContextMenuTemplate())
    menu.popup({ window, x: params.x, y: params.y })
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
    ...(process.platform === 'linux' ? { icon: APP_ICON_PATH } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  // 首次创建不在此 show:窗口 show 交给渲染层 bootstrap 完成后的 panel-ready IPC,
  // 否则 ready-to-show(Chromium 首屏可画)早于 React 挂载,会先闪一个空透明窗,
  // 等 bootstrap resolve 真正内容挂载后再"重开"一次——视觉上像弹了两遍
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
    electronApp.setAppUserModelId('com.openai.codexstatus')

    persistedState = {
      ...loadedState,
      settings: syncLaunchAtLoginPreference(loadedState.settings)
    }
    if (!persistedState.peerId) {
      persistedState.peerId = randomUUID()
      queuePersistState()
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
    // autoUpdater 初始化并注册进度转发:把更新事件推给渲染层
    setUpdaterProgressListener((payload) => {
      sendToRenderers(CHANNELS.updateProgress, payload)
    })
    initAutoUpdater()
    // 启动后自动检查更新 + 后续定时检查(每2小时)
    if (app.isPackaged) {
      let updateCheckTimer: NodeJS.Timeout | undefined
      const doCheck = async () => {
        const result = await checkForUpdates()
        if (result.available && result.version) {
          sendToRenderers(CHANNELS.updateProgress, {
            stage: 'available',
            version: result.version
          })
          // 已获知新版本,停止后续定时检查,等用户点击下载
          if (updateCheckTimer) {
            clearInterval(updateCheckTimer)
            updateCheckTimer = undefined
          }
        }
      }
      setTimeout(() => void doCheck(), 5000)
      updateCheckTimer = setInterval(() => void doCheck(), 2 * 60 * 60 * 1000)
    }
    mainWindow = createCapsuleWindow()
    createTray()
    watchCodexAuthFile()
    syncLanService()
    // radar 推荐模型走独立定时(10 分钟),不再跟随额度刷新;拉到后注入 snapshot 并广播
    startRadarTimer(persistedState.settings.iqThreshold, (pick) => {
      currentSnapshot = { ...currentSnapshot, bestModelPick: pick }
      broadcastSnapshot()
    })
    void refreshStatus()

    // models.dev 价格后台同步:注入花费计算,拉取失败自动回落内置价格表
    setRateLookup(getPricingRate)
    void fetchModelsDevRates()

    app.on('activate', function () {
      if (mainWindow === null) {
        mainWindow = createCapsuleWindow()
        refreshTrayMenu()
        return
      }

      showWindow()
    })

    // 系统从睡眠/锁屏恢复时，重新显示胶囊窗口（除非用户主动隐藏）
    powerMonitor.on('resume', () => {
      if (!userHidCapsule) showWindow()
    })
    powerMonitor.on('unlock-screen', () => {
      if (!userHidCapsule) showWindow()
    })

    // 显示器配置变更（拔插显示器/RDP/分辨率变化）时，修正窗口位置防止掉出屏幕
    screen.on('display-metrics-changed', () => {
      if (mainWindow && mainWindow.isVisible()) {
        showWindow()
      }
    })
    screen.on('display-removed', () => {
      if (mainWindow && mainWindow.isVisible()) {
        showWindow()
      }
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
  stopRadarTimer()
  lanService.stop()
})

function registerIpcHandlers(): void {
  ipcMain.handle(CHANNELS.bootstrap, async (event) => {
    return {
      settings: persistedState.settings,
      window: persistedState.window,
      panel: persistedState.panel,
      snapshot: currentSnapshot,
      role: resolveRendererRole(event.sender.id),
      panelView: currentPanelView,
      version: app.getVersion()
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
    const previousIqThreshold = persistedState.settings.iqThreshold
    const previousTeamGroup = persistedState.settings.teamGroup
    const previousTeamNickname = persistedState.settings.teamNickname
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

    // 团队口令/昵称变更:重启 LAN service(更新发布信息或启停)
    if (
      (typeof patch.teamGroup === 'string' || patch.teamGroup === undefined) &&
      patch.teamGroup !== previousTeamGroup
    ) {
      syncLanService()
    } else if (
      typeof patch.teamNickname === 'string' &&
      patch.teamNickname !== previousTeamNickname
    ) {
      // 仅昵称变化也需重启(更新 mDNS txt 的 nick)
      syncLanService()
    }

    const iqThresholdChanged =
      typeof patch.iqThreshold === 'number' && patch.iqThreshold !== previousIqThreshold

    if (iqThresholdChanged) {
      // IQ 阈值变更:重置卡缓存重拉,radar 立即按新阈值重拉(独立定时,不跟随额度刷新)
      invalidateQuotaCaches()
      void refreshRadarNow(persistedState.settings.iqThreshold)
      void refreshStatus({ forceCredentialCheck: true })
    } else if (persistedState.settings.refreshMode === 'auto' && canRefreshStatus()) {
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

  // 面板内链接跳转:仅放行 http/https,用系统默认浏览器打开(Electron 标准做法,不在面板内嵌网页)
  ipcMain.handle(CHANNELS.openExternal, async (_, url: string) => {
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return
      }
      await shell.openExternal(url)
    } catch {
      // 非法 URL 静默丢弃,不打断前端
    }
  })

  // 渲染层 bootstrap 完成、真正内容挂载后通知主进程显示窗口,
  // 避免 ready-to-show 早于 React 挂载导致空窗闪烁
  ipcMain.handle(CHANNELS.panelReady, async () => {
    if (panelWindow && !panelWindow.isDestroyed() && !panelWindow.isVisible()) {
      panelWindow.show()
      panelWindow.focus()
    }
  })

  // 胶囊窗口点击 toggle panel:已显示则关闭,未显示则打开
  ipcMain.handle(CHANNELS.showPanel, async (_, view: PanelView) => {
    if (panelWindow && !panelWindow.isDestroyed() && panelWindow.isVisible()) {
      panelWindow.hide()
      return
    }
    openPanelWindow(view)
  })

  // 手动检查更新:dev 环境返回 available=false,打包后查 GitHub Releases
  ipcMain.handle(CHANNELS.checkUpdate, async () => {
    return checkForUpdates()
  })

  // 按需拉取 1/7/30 天 token 用量统计(独立 IPC,不进快照广播)
  ipcMain.handle(CHANNELS.tokenUsage, async (_event, window: UsageWindow) => {
    return getTokenUsage(window)
  })

  // 按需拉取 1/7/30 天真实账单花费(仅 API Key 模式;不可用返回 available:false)
  ipcMain.handle(CHANNELS.spendUsage, async (_event, window: UsageWindow) => {
    return getSpendUsage(window)
  })

  // 胶囊窗口按内容自适应尺寸:渲染层量内容后调用,主进程 setSize 贴合(限幅防越界)
  ipcMain.handle(CHANNELS.setCapsuleSize, async (_event, size: { width: number; height: number }) => {
    if (!mainWindow || !Number.isFinite(size?.width) || !Number.isFinite(size?.height)) {
      return
    }
    mainWindow.setSize(
      Math.round(clamp(size.width, 40, 480)),
      Math.round(clamp(size.height, 28, 320))
    )
  })

  // 下载已检测到的新版本安装包;进度经 updateProgress 通道推送
  ipcMain.handle(CHANNELS.downloadUpdate, async () => {
    await downloadUpdate()
  })

  // 退出并运行安装程序,覆盖升级
  ipcMain.handle(CHANNELS.installUpdate, async () => {
    installUpdate()
  })
}

function createTray(): void {
  const image = nativeImage.createFromPath(TRAY_ICON_PATH)
  tray = new Tray(image.isEmpty() ? TRAY_ICON_PATH : image.resize({ width: 16, height: 16 }))
  tray.on('click', () => {
    toggleWindowVisibility()
  })
  refreshTrayMenu()
}

function refreshTrayMenu(): void {
  if (!tray) {
    return
  }

  // 托盘菜单与胶囊右键菜单共用同一模板(刷新/显示隐藏/详情/设置/退出),不含投送和检查更新
  tray.setContextMenu(Menu.buildFromTemplate(buildCapsuleContextMenuTemplate()))
  tray.setToolTip(buildTrayTooltip())
}

function getTrayLabels(): Record<'refresh' | 'toggle' | 'details' | 'team' | 'settings' | 'checkUpdate' | 'quit', string> {
  if (persistedState.settings.locale === 'en-US') {
    return {
      refresh: 'Refresh',
      toggle: 'Show/Hide',
      details: 'Details',
      team: 'Team',
      settings: 'Settings',
      checkUpdate: 'Check for updates',
      quit: 'Quit'
    }
  }

  return {
    refresh: '刷新',
    toggle: '显示/隐藏',
    details: '详情',
    team: '团队',
    settings: '设置',
    checkUpdate: '检查更新',
    quit: '退出'
  }
}

// 胶囊右键菜单:托盘子集,去掉投送和检查更新
function buildCapsuleContextMenuTemplate(): MenuItemConstructorOptions[] {
  const labels = getTrayLabels()
  return [
    {
      label: labels.refresh,
      enabled: canRefreshStatus(),
      click: () => {
        void refreshStatus()
      }
    },
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
      label: labels.team,
      click: () => {
        openTeamFromTray()
      }
    },
    {
      label: labels.settings,
      click: () => {
        openSettingsFromTray()
      }
    },
    {
      label: labels.checkUpdate,
      click: () => {
        void (async () => {
          const result = await checkForUpdates()
          if (result.available && result.version) {
            sendToRenderers(CHANNELS.updateProgress, {
              stage: 'available',
              version: result.version
            })
          }
        })()
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
    userHidCapsule = true
    mainWindow.hide()
  } else {
    userHidCapsule = false
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

function openTeamFromTray(): void {
  openPanelWindow('team')
}

function prepareToQuit(): void {
  isQuitting = true
  clearRefreshTimer()
  clearCodexAuthWatcher()
  stopRadarTimer()
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

// 团队看板:self + LAN 发现的 peer 合并;self 取当前 snapshot 的两个窗口分别展示
function buildTeamPeers(selfRemaining: number | undefined): TeamPeer[] {
  const selfName =
    persistedState.settings.teamNickname && persistedState.settings.teamNickname.trim().length > 0
      ? persistedState.settings.teamNickname
      : '我'
  const short = getShortWindow()
  const long = getLongWindow()
  const selfPeer: TeamPeer = {
    id: persistedState.peerId ?? 'self',
    nickname: selfName,
    isSelf: true,
    remainingPercent: selfRemaining,
    shortWindow: short
      ? { label: short.label, remainingPercent: short.remainingPercent }
      : undefined,
    longWindow: long
      ? { label: long.label, remainingPercent: long.remainingPercent }
      : undefined,
    resetCreditCount: currentSnapshot.resetCredit?.availableCount,
    tokenUsage: getCachedTokenTotals(),
    updatedAt: new Date().toISOString()
  }
  return [selfPeer, ...lanService.getPeers()]
}

// 取短窗口(5h):windowMinutes < 1440 且最短的
function getShortWindow(): RateLimitWindowSnapshot | undefined {
  const shorts = currentSnapshot.rateLimits.filter(
    (w) => w.windowMinutes !== undefined && w.windowMinutes < 1440
  )
  shorts.sort((a, b) => (a.windowMinutes ?? 0) - (b.windowMinutes ?? 0))
  return shorts[0]
}

// 取长窗口(7d):windowMinutes >= 1440 且最短的
function getLongWindow(): RateLimitWindowSnapshot | undefined {
  const longs = currentSnapshot.rateLimits.filter(
    (w) => w.windowMinutes !== undefined && w.windowMinutes >= 1440
  )
  longs.sort((a, b) => (a.windowMinutes ?? 0) - (b.windowMinutes ?? 0))
  return longs[0]
}

// 取本机剩余额度百分比:优先短窗口(5h 等),无短窗口则用长窗口(7d)兜底;无任何窗口返回 undefined
function getSelfRemaining(): number | undefined {
  const rateLimits = currentSnapshot.rateLimits
  const short = rateLimits.find((w) => w.windowMinutes === undefined || w.windowMinutes < 1440)
  if (short?.remainingPercent !== undefined) return short.remainingPercent
  const long = rateLimits.find((w) => w.windowMinutes !== undefined && w.windowMinutes >= 1440)
  return long?.remainingPercent
}

// 本机派生展示数据,广播给已连 peer(绝不包含 Codex 凭据)
function getLanSnapshot(): PeerSnapshot {
  const short = getShortWindow()
  const long = getLongWindow()
  return {
    remainingPercent: getSelfRemaining(),
    weeklyResetsAt: long?.resetsAt,
    bestModelLabel: currentSnapshot.bestModelPick?.shortLabel,
    resetCreditCount: currentSnapshot.resetCredit?.availableCount,
    shortWindow: short
      ? { label: short.label, remainingPercent: short.remainingPercent }
      : undefined,
    longWindow: long
      ? { label: long.label, remainingPercent: long.remainingPercent }
      : undefined,
    tokenUsage: getCachedTokenTotals()
  }
}

// 团队口令非空时启动/重启 LAN service,空则停止
function syncLanService(): void {
  const group = persistedState.settings.teamGroup
  if (!group || group.trim().length === 0) {
    lanService.stop()
    return
  }
  lanService.start({
    peerId: persistedState.peerId ?? 'self',
    nickname: persistedState.settings.teamNickname ?? '我',
    group,
    getSnapshot: getLanSnapshot,
    onPeersChange: () => {
      // peer 变化时把最新 peer 表合并进 snapshot 并推送前端
      currentSnapshot = {
        ...currentSnapshot,
        teamPeers: buildTeamPeers(getSelfRemaining())
      }
      broadcastSnapshot()
    }
  })
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
      const collected = await collectUsageSnapshot({
        iqThreshold: persistedState.settings.iqThreshold,
        bestModelPick: currentSnapshot.bestModelPick
      })
      // 预热三窗口 token 汇总,供本机排行榜与 LAN 广播同步读取
      await warmTokenTotals()
      // collect 期间 radar 回调可能已更新 bestModelPick;优先取最新值,旧值仅作兜底
      currentSnapshot = {
        ...collected,
        bestModelPick: currentSnapshot.bestModelPick ?? collected.bestModelPick,
        teamPeers: buildTeamPeers(getSelfRemaining())
      }
      // 本机数据变化,广播给已连 peer
      lanService.broadcastSnapshot()
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
  // API Key 模式:无额度窗口,胶囊固定用单窗口尺寸(横版 160 宽 / orb 96 高),
  // 与本地正确 mock 一致,避免按 rateLimits 数量变化导致机器间尺寸不一(250 宽会让紧凑内容两边空白)
  if (currentSnapshot.authMode === 'api') {
    return viewMode === 'orb'
      ? { width: ORB_WINDOW_SIZE.width, height: SINGLE_ORB_WINDOW_HEIGHT }
      : { width: SINGLE_CAPSULE_WINDOW_WIDTH, height: CAPSULE_WINDOW_SIZE.height }
  }
  const size = viewMode === 'orb' ? ORB_WINDOW_SIZE : CAPSULE_WINDOW_SIZE
  // 短窗口(百分比段)和长窗口(周重置倒计时段)都参与胶囊展示,尺寸按总窗口数增长
  const visibleCount = currentSnapshot.rateLimits.length
  const rateLimitCount = visibleCount > 0 ? visibleCount : currentSnapshot.rateLimits.length

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
