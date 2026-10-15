/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import ts from 'typescript'
import { parseTeamIdentity } from '../src/shared/team-role.ts'
import { isTeamAdmin } from '../src/main/services/admin-device.ts'
import { getPanelVisibility } from '../src/main/services/panel-visibility.ts'
import {
  ACTIVITY_CHANNELS,
  DEFAULT_IDLE_THRESHOLD_MINUTES,
  MIN_IDLE_THRESHOLD_MINUTES,
  MAX_IDLE_THRESHOLD_MINUTES
} from '../src/shared/activity.ts'

const settingsBundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/shared/capsule.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false
})
const { normalizeSettings } = await import(
  `data:text/javascript;base64,${Buffer.from(settingsBundle.outputFiles[0].text).toString('base64')}`
)

// AST提取真实入口，避免测试启动生产主进程或改写生产设置。
const source = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const file = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
const functionNode = (name) =>
  file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name)
const registration = functionNode('registerIpcHandlers')
const keys = new Set([
  'CHANNELS.bootstrap',
  'ACTIVITY_CHANNELS.board',
  'ACTIVITY_CHANNELS.calendarRefresh',
  'ACTIVITY_CHANNELS.panelVisibility',
  'CHANNELS.updateSettings'
])
const handlers = registration.body.statements.filter(
  (node) =>
    ts.isExpressionStatement(node) &&
    ts.isCallExpression(node.expression) &&
    keys.has(node.expression.arguments[0]?.getText(file))
)
assert.equal(handlers.length, 5)
const code = ts.transpileModule(
  `${functionNode('requireActivityPanel').getText(file)}\n${functionNode('queueSettingsUpdate').getText(file)}\n${functionNode('syncTeamActivity').getText(file)}\n${functionNode('refreshTeamAdminAccess').getText(file)}\n${functionNode('createPreferencesPayload').getText(file)}\n${handlers.map((node) => node.getText(file)).join('\n')}`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }
).outputText

function fixture(group = '9527GM', initiallyAllowed = true) {
  const callbacks = new Map()
  const frame = {}
  let deviceAllowed = initiallyAllowed
  const context = {
    lastTeamAdminAllowed: initiallyAllowed,
    settingsUpdateQueue: Promise.resolve(),
    savePersistedState: async () => {},
    parseTeamIdentity,
    isTeamAdmin: (teamGroup) => isTeamAdmin(teamGroup, deviceAllowed),
    hashGroup: (teamGroup) => `hash:${teamGroup}`,
    process: { platform: 'win32' },
    app: { getVersion: () => 'test-version' },
    ACTIVITY_CHANNELS,
    getPanelVisibility,
    MIN_IDLE_THRESHOLD_MINUTES,
    MAX_IDLE_THRESHOLD_MINUTES,
    CHANNELS: { bootstrap: 'bootstrap', updateSettings: 'update-settings' },
    ipcMain: { handle: (channel, callback) => callbacks.set(channel, callback) },
    panelWindow: { isDestroyed: () => false, isVisible: () => true, webContents: { id: 12 } },
    persistedState: {
      peerId: '10000000-0000-4000-8000-000000000002',
      settings: {
        teamGroup: group,
        refreshMode: 'manual',
        agentId: 'codex',
        activityEnabled: false,
        activityIdleThresholdMinutes: 5
      },
      window: { viewMode: 'capsule' },
      panel: {}
    },
    teamActivity: {
      configured: undefined,
      configure(config) {
        this.configured = config
      },
      getBoard: (date) => ({ date }),
      refreshCalendar: async () => ({ available: true })
    },
    currentSnapshot: {},
    currentPanelView: 'team',
    currentAnnouncement: null,
    resolveRendererRole: () => 'panel',
    consumeFocusUpdate: () => false,
    consumeFocusTarget: () => undefined,
    createIslandRendererSnapshot: () => ({}),
    resolveDiagEnabled: () => false,
    windowKeeper: undefined,
    syncLaunchAtLoginPreference: normalizeSettings,
    queuePersistState: () => {},
    syncRefreshTimer: () => {},
    refreshTrayMenu: () => {},
    broadcastPreferences: () => {},
    syncLanService: () => {},
    syncTeamActivity: () => {},
    createPreferencesPayload: () => ({ settings: context.persistedState.settings })
  }
  vm.runInNewContext(code, context)
  return {
    context,
    callbacks,
    event: { sender: { id: 12, mainFrame: frame }, senderFrame: frame },
    setDeviceAllowed(value) {
      deviceAllowed = value
    }
  }
}

test('可见性IPC只返回调用方自身面板的原生状态，隐藏或销毁时为false', () => {
  const { callbacks, event, context } = fixture()
  const visible = callbacks.get(ACTIVITY_CHANNELS.panelVisibility)
  assert.equal(visible(event), true)
  assert.equal(visible({ sender: { id: 13 } }), false)
  context.panelWindow.isVisible = () => false
  assert.equal(visible(event), false)
  context.panelWindow.isVisible = () => true
  context.panelWindow.isDestroyed = () => true
  assert.equal(visible(event), false)
  context.panelWindow = null
  assert.equal(visible(event), false)
})

test('活动IPC按实际面板和主frame核验，不允许胶囊或iframe', async () => {
  const { callbacks, event, context } = fixture()
  const board = callbacks.get(ACTIVITY_CHANNELS.board)
  assert.equal(board(event, '2026-10-13').date, '2026-10-13')
  assert.throws(
    () => board({ ...event, sender: { ...event.sender, id: 13 } }, '2026-10-13'),
    /主面板/
  )
  assert.throws(() => board({ ...event, senderFrame: {} }, '2026-10-13'), /主面板/)
  context.panelWindow.isDestroyed = () => true
  await assert.rejects(callbacks.get(ACTIVITY_CHANNELS.calendarRefresh)(event), /主面板/)
})

test('普通成员、仅GM及撤销管理员后拒绝统计和日历IPC', async () => {
  for (const group of ['9527', 'GM', undefined, '']) {
    const { callbacks, event, context } = fixture()
    context.persistedState.settings.teamGroup = group
    assert.throws(() => callbacks.get(ACTIVITY_CHANNELS.board)(event, '2026-10-13'), /仅团队管理员/)
    await assert.rejects(callbacks.get(ACTIVITY_CHANNELS.calendarRefresh)(event), /仅团队管理员/)
  }
  const { context, callbacks, event } = fixture()
  context.persistedState.settings.teamGroup = '9527'
  assert.throws(() => callbacks.get(ACTIVITY_CHANNELS.board)(event, '2026-10-13'), /仅团队管理员/)
})

test('GM口令仍须本机授权，统计、日历刷新和阈值设置共同受限', async () => {
  const { callbacks, event, context, setDeviceAllowed } = fixture('9527GM', false)
  const board = callbacks.get(ACTIVITY_CHANNELS.board)
  const refreshCalendar = callbacks.get(ACTIVITY_CHANNELS.calendarRefresh)
  const save = callbacks.get('update-settings')

  assert.throws(() => board(event, '2026-10-13'), /仅团队管理员/)
  await assert.rejects(refreshCalendar(event), /仅团队管理员/)
  await assert.rejects(save(event, { activityIdleThresholdMinutes: 6 }), /仅团队管理员/)

  setDeviceAllowed(true)
  assert.equal(board(event, '2026-10-13').date, '2026-10-13')
  assert.deepEqual(await refreshCalendar(event), { available: true })
  await assert.doesNotReject(save(event, { activityIdleThresholdMinutes: 6 }))
  context.persistedState.settings.teamGroup = '9527'
  assert.throws(() => board(event, '2026-10-13'), /仅团队管理员/)
})

test('同步服务、偏好和启动payload都使用主进程的设备授权结果', async () => {
  const { callbacks, context, setDeviceAllowed } = fixture('9527GM', false)
  const bootstrap = callbacks.get('bootstrap')

  context.syncTeamActivity()
  assert.equal(context.teamActivity.configured.admin, false)
  assert.equal(context.createPreferencesPayload().teamAdminAllowed, false)
  assert.equal((await bootstrap({ sender: { id: 12 } })).teamAdminAllowed, false)

  setDeviceAllowed(true)
  context.syncTeamActivity()
  assert.equal(context.teamActivity.configured.admin, true)
  assert.equal(context.createPreferencesPayload().teamAdminAllowed, true)
  assert.equal((await bootstrap({ sender: { id: 12 } })).teamAdminAllowed, true)
})

test('运行期设备授权变化先同步服务/LAN再广播，状态不变时不重启', () => {
  const { context, setDeviceAllowed } = fixture('9527GM', true)
  const events = []
  context.syncLanService = () => {
    context.lastTeamAdminAllowed = context.isTeamAdmin(context.persistedState.settings.teamGroup)
    context.syncTeamActivity()
    events.push(`sync:${context.teamActivity.configured.admin}`)
  }
  context.broadcastPreferences = () => {
    events.push(`broadcast:${context.createPreferencesPayload().teamAdminAllowed}`)
  }

  setDeviceAllowed(false)
  context.refreshTeamAdminAccess()
  assert.deepEqual(events, ['sync:false', 'broadcast:false'])
  assert.equal(context.lastTeamAdminAllowed, false)

  events.length = 0
  context.refreshTeamAdminAccess()
  assert.deepEqual(events, [])

  setDeviceAllowed(true)
  context.refreshTeamAdminAccess()
  assert.deepEqual(events, ['sync:true', 'broadcast:true'])
  assert.equal(context.lastTeamAdminAllowed, true)
})

test('旧阈值设置归一化为5分钟，活动开启须来自面板且已入组', async () => {
  const { callbacks, event, context } = fixture()
  const save = callbacks.get('update-settings')
  for (const value of [0, 61, 1.5, NaN, '5'])
    await assert.rejects(save(event, { activityIdleThresholdMinutes: value }), /空闲阈值/)
  for (const value of [1, 60])
    assert.equal(
      (await save(event, { activityIdleThresholdMinutes: value })).settings
        .activityIdleThresholdMinutes,
      DEFAULT_IDLE_THRESHOLD_MINUTES
    )
  context.persistedState.settings.teamGroup = '9527'
  await assert.rejects(save(event, { activityIdleThresholdMinutes: 5 }), /仅团队管理员/)
  assert.equal((await save(event, { activityEnabled: true })).settings.activityEnabled, true)
  await assert.rejects(save({ ...event, senderFrame: {} }, { activityEnabled: false }), /主面板/)
  context.persistedState.settings.teamGroup = undefined
  await assert.rejects(save(event, { activityEnabled: true }), /请先加入团队/)
  await assert.rejects(save(event, { activityEnabled: 'true' }), /采集开关/)
  await assert.rejects(save(event, { teamGroup: 'GM' }), /团队口令/)
  for (const patch of [null, [], 'bad']) await assert.rejects(save(event, patch), /设置格式/)
})

test('活动设置落盘失败撤回开关，并允许后续保存和并发设置按序完成', async () => {
  const { callbacks, event, context } = fixture()
  const save = callbacks.get('update-settings')
  let starts = 0
  context.syncLanService = () => {
    starts++
  }
  context.savePersistedState = async () => {
    throw new Error('fixture-disk-failure')
  }
  await assert.rejects(save(event, { activityEnabled: true }), /fixture-disk-failure/)
  assert.equal(context.persistedState.settings.activityEnabled, false)
  assert.equal(starts, 0)
  context.savePersistedState = async () => {}
  await Promise.all([
    save(event, { activityIdleThresholdMinutes: 6 }),
    save(event, { theme: 'memphis' })
  ])
  assert.equal(
    context.persistedState.settings.activityIdleThresholdMinutes,
    DEFAULT_IDLE_THRESHOLD_MINUTES
  )
  assert.equal(context.persistedState.settings.theme, 'memphis')
})
