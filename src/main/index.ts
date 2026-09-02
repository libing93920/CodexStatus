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
  createApiModeSnapshot,
  normalizeSettings,
  type AnnouncementState,
  type BroadcastMessage,
  type CapsuleDragMovePayload,
  type DockEdge,
  type PanelFocusTarget,
  type PanelView,
  type RateLimitWindowSnapshot,
  type AppSettings,
  type PreferencesPayload,
  type RendererCommandPayload,
  type PersistedState,
  type RendererWindowRole,
  type ShowPanelOptions,
  type TeamPeer,
  type UsageSnapshot,
  type UsageWindow,
  type WindowPreferences
} from '../shared/capsule'
import {
  ANNOUNCEMENT_PREFIX,
  acknowledgeAnnouncement,
  createAnnouncementState,
  markAnnouncementRead,
  parseAnnouncementText
} from '../shared/announcement'
import { collectUsageSnapshot, invalidateQuotaCaches, resolveCodexAuthPath } from './services/quota'
import { refreshRadarNow, startRadarTimer, stopRadarTimer } from './services/radar'
import {
  getCachedAgentTokenTotals,
  getCachedTokenTotals,
  getTokenUsage,
  getTokenUsageRange,
  invalidateUsageCache,
  warmAllAgentTokenTotals
} from './services/usage'
import { setRateLookup } from './services/rate'
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
  capsuleReady: 'codex-status:capsule-ready',
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
  announcementUpdated: 'codex-status:announcement-updated',
  markAnnouncementRead: 'codex-status:mark-announcement-read',
  acknowledgeAnnouncement: 'codex-status:acknowledge-announcement',
  sendReaction: 'codex-status:send-reaction',
  reaction: 'codex-status:reaction'
} as const

const SINGLE_CAPSULE_WINDOW_WIDTH = 160
const SINGLE_ORB_WINDOW_HEIGHT = 96

let mainWindow: BrowserWindow | null = null
let panelWindow: BrowserWindow | null = null
let panelRevealPending = false
let tray: Tray | null = null
let refreshTimer: NodeJS.Timeout | undefined
let persistTimer: NodeJS.Timeout | undefined
let refreshPromise: Promise<void> | undefined
let watchedCodexAuthPath: string | undefined
let isQuitting = false
let userHidCapsule = false
let currentPanelView: PanelView = 'details'
// 胶囊版本角标跳转设置页时的一次性定位标志:由 bootstrap 或 command 消费后清除
let panelFocusUpdate = false
let panelFocusTarget: PanelFocusTarget | undefined
let currentAnnouncement: AnnouncementState | null = null
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

  // 不在 ready-to-show 直接 show:胶囊需等首次有数据后再显示,
  // 避免启动时以最大尺寸空壳先露一帧、数据回来再缩小的"由大变小"闪烁。
  // 显示时机改由渲染层 notifyCapsuleReady(数据就绪)驱动,见 CHANNELS.capsuleReady handler。

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
    panelRevealPending = false
    window.hide()
    window.setOpacity(1)
    window.webContents.setBackgroundThrottling(true)
  })

  window.on('closed', () => {
    panelRevealPending = false
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
      const doCheck = async (): Promise<void> => {
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
    syncRadarTimer()
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
    const role = resolveRendererRole(event.sender.id)
    return {
      settings: persistedState.settings,
      window: persistedState.window,
      panel: persistedState.panel,
      snapshot: currentSnapshot,
      role,
      panelView: currentPanelView,
      focusUpdate: role === 'panel' ? consumeFocusUpdate() : false,
      focusTarget: role === 'panel' ? consumeFocusTarget() : undefined,
      announcement: currentAnnouncement,
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
    const previousAgentId = persistedState.settings.agentId
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
    const agentIdChanged = patch.agentId !== undefined && patch.agentId !== previousAgentId

    if (agentIdChanged) {
      // 切换工具:清用量缓存,radar 仅 Codex 启动,强制全量刷新
      invalidateUsageCache()
      invalidateQuotaCaches()
      syncRadarTimer()
      void refreshStatus({ forceCredentialCheck: true })
    } else if (iqThresholdChanged) {
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
    if (!panelWindow || panelWindow.isDestroyed()) {
      return
    }
    panelRevealPending = false
    panelWindow.hide()
    panelWindow.setOpacity(1)
    panelWindow.webContents.setBackgroundThrottling(true)
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
    if (!panelRevealPending || !panelWindow || panelWindow.isDestroyed()) {
      return
    }
    if (!panelWindow.isVisible()) {
      panelWindow.show()
    }
    panelWindow.setOpacity(1)
    panelWindow.webContents.setBackgroundThrottling(true)
    panelWindow.focus()
    panelRevealPending = false
  })

  // 胶囊显示时机:渲染层确认有数据(generatedAt 存在)并完成一帧绘制后通知,
  // 此时窗口尺寸已是最终值,避免空壳先露再缩小的闪烁
  ipcMain.handle(CHANNELS.capsuleReady, async () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return
    }
    if (!hasCapsuleData(currentSnapshot)) {
      return
    }
    if (!mainWindow.isVisible()) {
      showWindow()
    }
  })

  // 普通点击沿用显隐切换;提醒跳转用 forceOpen 保证 panel 显示、聚焦并定位目标区域
  ipcMain.handle(CHANNELS.showPanel, async (_, rawView: unknown, rawOptions?: unknown) => {
    if (!isPanelView(rawView)) {
      return
    }
    const options = normalizeShowPanelOptions(rawOptions)
    if (options.focusUpdate) {
      panelFocusUpdate = true
    }
    panelFocusTarget = options.focusTarget
    if (
      !options.forceOpen &&
      panelWindow &&
      !panelWindow.isDestroyed() &&
      panelWindow.isVisible()
    ) {
      panelRevealPending = false
      panelWindow.hide()
      panelWindow.setOpacity(1)
      panelWindow.webContents.setBackgroundThrottling(true)
      return
    }
    openPanelWindow(rawView)
  })

  // 手动检查更新:dev 环境返回 available=false,打包后查 GitHub Releases
  ipcMain.handle(CHANNELS.checkUpdate, async () => {
    return checkForUpdates()
  })

  // 按需拉取 1/7/30 天 token 用量统计(独立 IPC,不进快照广播)
  ipcMain.handle(CHANNELS.tokenUsage, async (_event, window: UsageWindow) => {
    return getTokenUsage(persistedState.settings.agentId, window)
  })

  // 自定义起止时间区间内的 token 用量统计(本地扫描,边界精确到毫秒,上限 30 天)
  ipcMain.handle(CHANNELS.tokenUsageRange, async (_event, startMs: number, endMs: number) => {
    return getTokenUsageRange(persistedState.settings.agentId, startMs, endMs)
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

  // 发送局域网广播消息:校验失败返回原因(渲染层据此区分提示);成功后回显给自己
  ipcMain.handle(CHANNELS.sendBroadcast, async (_event, text: unknown) => {
    if (typeof text !== 'string') {
      return { ok: false, reason: 'too-long' }
    }
    if (
      text.startsWith(ANNOUNCEMENT_PREFIX) &&
      parseAnnouncementText(text) === undefined
    ) {
      return { ok: false, reason: 'too-long' }
    }
    const result = lanService.broadcastMessage(text)
    if (result.ok) {
      handleBroadcastMessage(result.message)
    }
    return result
  })

  ipcMain.handle(CHANNELS.markAnnouncementRead, async (event, id: unknown) => {
    if (
      resolveRendererRole(event.sender.id) !== 'panel' ||
      typeof id !== 'string' ||
      !panelWindow?.isVisible() ||
      !panelWindow.isFocused()
    ) {
      return
    }
    markCurrentAnnouncementRead(id)
  })

  ipcMain.handle(CHANNELS.acknowledgeAnnouncement, async (event, id: unknown) => {
    if (
      resolveRendererRole(event.sender.id) !== 'panel' ||
      typeof id !== 'string' ||
      !currentAnnouncement
    ) {
      return
    }
    const nextAnnouncement = acknowledgeAnnouncement(currentAnnouncement, id)
    if (nextAnnouncement !== currentAnnouncement) {
      currentAnnouncement = nextAnnouncement
      broadcastAnnouncement()
    }
  })

  // 给某成员点赞/取消:校验 targetPeerId 与 action 后广播,成功回显给自己(所有端各自聚合)
  ipcMain.handle(CHANNELS.sendReaction, async (_event, targetPeerId: unknown, action: unknown) => {
    if (typeof targetPeerId !== 'string' || (action !== 'add' && action !== 'remove')) {
      return { ok: false, reason: 'not-in-team' }
    }
    const result = lanService.broadcastReaction(targetPeerId, action)
    if (result.ok) {
      sendToRenderers(CHANNELS.reaction, result.reaction)
    }
    return result
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
    // 用户主动点击托盘:即使无数据也显示(守卫仅拦自动 show 路径,不拦用户主动操作)
    const bounds = resolveCapsuleBounds(persistedState.window)
    mainWindow.setBounds(bounds)
    mainWindow.show()
    mainWindow.focus()
  }
}

function showWindow(): void {
  if (!mainWindow) {
    return
  }
  // 自动 show 路径(second-instance/resume/display-metrics)在无数据时不提前显示,
  // 避免空壳先露;数据就绪后由 capsuleReady 驱动显示
  if (!hasCapsuleData(currentSnapshot)) {
    return
  }

  const bounds = resolveCapsuleBounds(persistedState.window)
  mainWindow.setBounds(bounds)
  mainWindow.show()
  mainWindow.focus()
}

// 数据就绪判定:首次刷新完成(无论成功/失败/无凭据)后 snapshot 带 generatedAt,
// 启动初始空快照(createEmptySnapshot)无此字段
function hasCapsuleData(snapshot: UsageSnapshot): boolean {
  return snapshot.generatedAt !== undefined
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
    authMode: currentSnapshot.authMode,
    remainingPercent: selfRemaining,
    shortWindow: short
      ? { label: short.label, remainingPercent: short.remainingPercent }
      : undefined,
    longWindow: long
      ? { label: long.label, remainingPercent: long.remainingPercent }
      : undefined,
    resetCreditCount: currentSnapshot.resetCredit?.availableCount,
    tokenUsage: getCachedTokenTotals(),
    tokenUsageByAgent: getCachedAgentTokenTotals(),
    appVersion: app.getVersion(),
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
    nickname: persistedState.settings.teamNickname ?? '我',
    authMode: currentSnapshot.authMode,
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
    tokenUsage: getCachedTokenTotals(),
    tokenUsageByAgent: getCachedAgentTokenTotals(),
    appVersion: app.getVersion()
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
    },
    onMessage: (message) => {
      handleBroadcastMessage(message)
    },
    onReaction: (reaction) => {
      sendToRenderers(CHANNELS.reaction, reaction)
    }
  })
}

function handleBroadcastMessage(message: BroadcastMessage): void {
  if (typeof message.text !== 'string') {
    return
  }
  const announcementText = parseAnnouncementText(message.text)
  if (announcementText === undefined) {
    if (message.text.startsWith(ANNOUNCEMENT_PREFIX)) {
      return
    }
    sendToRenderers(CHANNELS.broadcastMessage, message)
    return
  }

  const selfPeerId = persistedState.peerId ?? 'self'
  currentAnnouncement = createAnnouncementState({ ...message, text: announcementText }, selfPeerId)
  broadcastAnnouncement()
}

function markCurrentAnnouncementRead(id: string): void {
  if (!currentAnnouncement) {
    return
  }
  const nextAnnouncement = markAnnouncementRead(currentAnnouncement, id)
  if (nextAnnouncement === currentAnnouncement) {
    return
  }
  currentAnnouncement = nextAnnouncement
  broadcastAnnouncement()
}

function broadcastAnnouncement(): void {
  sendToRenderers(CHANNELS.announcementUpdated, currentAnnouncement)
}

function applyRadarPick(pick: UsageSnapshot['bestModelPick']): void {
  currentSnapshot = { ...currentSnapshot, bestModelPick: pick }
  broadcastSnapshot()
}

// radar 仅 Codex 有意义(推荐模型);非 Codex 停掉定时器避免无谓请求与 bestModelPick 残留
function syncRadarTimer(): void {
  if (persistedState.settings.agentId === 'codex') {
    startRadarTimer(persistedState.settings.iqThreshold, applyRadarPick)
  } else {
    stopRadarTimer()
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
      const agentId = persistedState.settings.agentId
      const collected =
        agentId === 'codex'
          ? await collectUsageSnapshot({
              iqThreshold: persistedState.settings.iqThreshold,
              bestModelPick: currentSnapshot.bestModelPick
            })
          : createApiModeSnapshot()
      // 预热三窗口 token 汇总,供本机排行榜与 LAN 广播同步读取
      await warmAllAgentTokenTotals()
      // collect 期间 radar 回调可能已更新 bestModelPick;优先取最新值,旧值仅作兜底
      currentSnapshot = {
        ...collected,
        // 非 Codex 不保留雷达推荐(切换工具时避免旧 Codex 推荐残留)
        bestModelPick:
          agentId === 'codex' ? currentSnapshot.bestModelPick ?? collected.bestModelPick : undefined,
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

function isPanelView(value: unknown): value is PanelView {
  return value === 'details' || value === 'team' || value === 'settings'
}

function normalizeShowPanelOptions(value: unknown): ShowPanelOptions {
  if (!value || typeof value !== 'object') {
    return {}
  }
  const options = value as Record<string, unknown>
  const focusTarget =
    options.focusTarget === 'announcement' || options.focusTarget === 'messages'
      ? options.focusTarget
      : undefined
  return {
    focusUpdate: options.focusUpdate === true,
    focusTarget,
    forceOpen: options.forceOpen === true
  }
}

function openPanelWindow(view: PanelView): void {
  currentPanelView = view
  if (!panelWindow || panelWindow.isDestroyed()) {
    // 新窗口页面未加载,command 收不到;focusUpdate 留给 bootstrap 消费
    panelRevealPending = true
    panelWindow = createPanelWindow()
    return
  }
  const isVisible = panelWindow.isVisible()
  if (!isVisible) {
    panelWindow.setBounds(resolvePanelBounds(persistedState.panel.x, persistedState.panel.y))
    // 先以完全透明状态进入可见绘制，避免隐藏窗口停帧或复用旧合成帧。
    panelRevealPending = true
    panelWindow.setOpacity(0)
    panelWindow.webContents.setBackgroundThrottling(false)
    panelWindow.showInactive()
  }

  panelWindow.webContents.send(CHANNELS.command, {
    type: 'show-panel-view',
    panelView: currentPanelView,
    focusUpdate: consumeFocusUpdate(),
    focusTarget: consumeFocusTarget()
  } satisfies RendererCommandPayload)

  // 隐藏窗口等目标页面完成绘制后由 panelReady 显示，避免旧页面先露一帧。
  if (isVisible) {
    panelWindow.focus()
  }
}

// 读取并清除一次性定位标志:已存在窗口由 command 消费,新窗口由 bootstrap 消费
function consumeFocusUpdate(): boolean {
  const value = panelFocusUpdate
  panelFocusUpdate = false
  return value
}

function consumeFocusTarget(): PanelFocusTarget | undefined {
  const value = panelFocusTarget
  panelFocusTarget = undefined
  return value
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
  const workAreaBottom = workArea.y + workArea.height
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
    // 横版胶囊吸附上下边缘:松手时贴近上下边则贴齐该边
    const nearTop = capsuleBounds.y <= workArea.y + CAPSULE_DOCK_THRESHOLD
    const nearBottom =
      capsuleBounds.y + capsuleSize.height >= workAreaBottom - CAPSULE_DOCK_THRESHOLD
    return {
      x: capsuleBounds.x,
      y: nearTop
        ? workArea.y + CAPSULE_EDGE_GAP
        : nearBottom
          ? workAreaBottom - capsuleSize.height - CAPSULE_EDGE_GAP
          : capsuleBounds.y,
      viewMode: 'capsule'
    }
  }

  const y = clamp(
    capsuleBounds.y + Math.round((capsuleSize.height - orbSize.height) / 2),
    workArea.y + CAPSULE_EDGE_GAP,
    workAreaBottom - orbSize.height - CAPSULE_EDGE_GAP
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
  const workAreaBottom = workArea.y + workArea.height
  const capsuleSize = resolveCapsuleWindowSize('capsule')
  const orbSize = resolveCapsuleWindowSize('orb')
  const orbRight = orbBounds.x + orbSize.width
  const orbBottom = orbBounds.y + orbSize.height
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

  // 未停靠:转横版胶囊。竖版贴近上下边缘时,横版吸附贴齐该边,否则按竖版中心对齐
  const nearTop = orbBounds.y <= workArea.y + CAPSULE_UNDOCK_THRESHOLD
  const nearBottom = orbBottom >= workAreaBottom - CAPSULE_UNDOCK_THRESHOLD
  return {
    x: clamp(
      orbBounds.x + Math.round((orbSize.width - capsuleSize.width) / 2),
      workArea.x + CAPSULE_EDGE_GAP,
      workAreaRight - capsuleSize.width - CAPSULE_EDGE_GAP
    ),
    y: nearTop
      ? workArea.y + CAPSULE_EDGE_GAP
      : nearBottom
        ? workAreaBottom - capsuleSize.height - CAPSULE_EDGE_GAP
        : clamp(
            orbBounds.y + Math.round((orbSize.height - capsuleSize.height) / 2),
            workArea.y + CAPSULE_EDGE_GAP,
            workAreaBottom - capsuleSize.height - CAPSULE_EDGE_GAP
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
  // 胶囊只展示单个窗口(5h 优先,无 5h 取 7d 兜底),尺寸不随 rateLimits 数量变化,
  // 避免 5h 回来后窗口从 160 撑到 250 而内容不变产生大片空白
  return viewMode === 'orb'
    ? { width: ORB_WINDOW_SIZE.width, height: SINGLE_ORB_WINDOW_HEIGHT }
    : { width: SINGLE_CAPSULE_WINDOW_WIDTH, height: CAPSULE_WINDOW_SIZE.height }
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
