/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyStatePatches,
  projectTerminalTransition
} from '../src/main/services/codex-ipc-client.ts'
import { CodexActivityService } from '../src/main/services/codex-activity.ts'
import { getDisplayStatus } from '../src/shared/island.ts'

test('路径复制隔离连续数组补丁，失败不污染原状态', () => {
  const untouched = { text: 'large history' }
  const source = { items: [{ value: 1 }, { value: 2 }], untouched }
  const before = structuredClone(source)
  const result = applyStatePatches(source, [
    { op: 'add', path: ['items', 0], value: { value: 0 } },
    { op: 'replace', path: ['items', 1, 'value'], value: 3 },
    { op: 'remove', path: ['items', 2] }
  ])
  assert.deepEqual(result.items, [{ value: 0 }, { value: 3 }])
  assert.equal(result.untouched, untouched)
  assert.deepEqual(source, before)
  assert.throws(() =>
    applyStatePatches(source, [
      { op: 'replace', path: ['items', 0, 'value'], value: 9 },
      { op: 'replace', path: ['missing', 'value'], value: 8 }
    ])
  )
  assert.deepEqual(source, before)
})

test('结构共享保留终态转换所需的旧回合', () => {
  const source = {
    turnHistory: {
      history: {
        entitiesByKey: {
          tail: { turnId: 'turn', turnStartedAtMs: 1000, status: 'inProgress' }
        }
      }
    },
    requests: []
  }
  const next = applyStatePatches(source, [
    {
      op: 'replace',
      path: ['turnHistory', 'history', 'entitiesByKey', 'tail', 'status'],
      value: 'failed'
    }
  ])
  assert.equal(projectTerminalTransition('local', 'thread', source, next)?.phase, 'failed')
  assert.equal(source.turnHistory.history.entitiesByKey.tail.status, 'inProgress')
})

function createService() {
  const snapshots = []
  const service = new CodexActivityService({
    cwd: '.',
    descriptorPath: 'unused',
    onSnapshot: (snapshot) => snapshots.push(snapshot)
  })
  for (const id of ['thread', 'ipc-thread', 'second'])
    service.threadSources.set(`local\u0000${id}`, 'vscode')
  const hook = (hook_event_name, extra = {}) =>
    service.handleHookPayload({
      hook_event_name,
      session_id: 'thread',
      turn_id: 'turn',
      ...extra
    })
  return { service, snapshots, hook }
}

test('默认窗口合并执行态，审批及解除立即送达', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const { hook, snapshots } = createService()
  hook('UserPromptSubmit')
  hook('PreToolUse', { tool_use_id: 'previous-tool' })
  assert.equal(snapshots.length, 0)
  context.mock.timers.tick(100)
  assert.equal(snapshots.length, 1)
  hook('PermissionRequest', { tool_use_id: 'tool-1' })
  assert.equal(getDisplayStatus(snapshots.at(-1).tasks[0]), 'waiting-approval')
  hook('PreToolUse', { tool_use_id: 'tool-1' })
  assert.equal(getDisplayStatus(snapshots.at(-1).tasks[0]), 'running')
  const count = snapshots.length
  context.mock.timers.tick(1000)
  assert.equal(snapshots.length, count)
})

test('停止服务取消排队回调', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const { service, hook, snapshots } = createService()
  hook('UserPromptSubmit')
  await service.stop()
  const count = snapshots.length
  context.mock.timers.tick(1000)
  assert.equal(snapshots.length, count)
})

test('IPC失败立即发送，保留的失败任务不使其他执行更新绕过合并', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const { service, snapshots } = createService()
  const task = {
    hostId: 'local',
    threadId: 'ipc-thread',
    turnId: 'ipc-turn',
    title: 'test',
    project: 'test',
    phase: 'running',
    requests: [],
    updatedAt: 1000,
    latestEventId: 'running'
  }
  service.updateIpcTasks([task])
  assert.equal(snapshots.length, 0)
  const failed = { ...task, phase: 'failed', latestEventId: 'failed' }
  service.updateIpcTasks([failed])
  assert.equal(snapshots.length, 1)
  assert.equal(snapshots[0].tasks[0].phase, 'failed')
  service.updateIpcTasks([failed, { ...task, threadId: 'second' }])
  assert.equal(snapshots.length, 1)
  context.mock.timers.tick(100)
  assert.equal(snapshots.length, 2)
  assert.equal(snapshots[1].tasks.length, 2)
})
