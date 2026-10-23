/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyStatePatches,
  CodexIpcClient,
  projectConversationState,
  projectTerminalTransition
} from '../src/main/services/codex-ipc-client.ts'
import { getDisplayStatus } from '../src/shared/island.ts'
import { CodexActivityService } from '../src/main/services/codex-activity.ts'

test('其他客户端发现任务只通知服务层，未准入前不自动订阅', () => {
  const visibleThreads = []
  const followed = []
  const client = new CodexIpcClient({
    threadIds: ['known-thread'],
    onTasks: () => undefined,
    onVisibleThread: (threadId) => visibleThreads.push(threadId),
    onConnection: () => undefined
  })
  client.sendFollowing = (threadId, following) => followed.push({ threadId, following })

  client.handleFollowing?.({ conversationId: 'new-thread', following: true }, 'codex-ui')
  client.handleFollowing?.({ conversationId: 'new-thread', following: true }, 'codex-ui')
  client.handleFollowing?.({ conversationId: 'new-thread', following: false }, 'codex-ui')

  assert.deepEqual(followed, [])
  assert.equal(client.threadIds?.has('new-thread'), false)
  assert.deepEqual(visibleThreads, ['new-thread', 'new-thread', undefined])
  client.followThread('known-approved')
  client.followThread('known-approved')
  assert.deepEqual(followed, [{ threadId: 'known-approved', following: true }])
})

test('退订清除投影缓存并忽略迟到补丁，其他任务不受影响', () => {
  const client = new CodexIpcClient({
    threadIds: ['rejected', 'kept'],
    onTasks: () => undefined,
    onVisibleThread: () => undefined,
    onConnection: () => undefined
  })
  const following = []
  client.sendFollowing = (threadId, value) => following.push([threadId, value])
  const key = 'local\u0000rejected'
  client.conversations.set(key, { revision: 1, state: {} })
  client.activeConversationKeys.add(key)
  client.projectedTaskCache.set(key, { revision: 1 })
  client.unfollowThread('rejected')
  assert.equal(client.conversations.has(key), false)
  assert.equal(client.activeConversationKeys.has(key), false)
  assert.equal(client.projectedTaskCache.has(key), false)
  assert.equal(client.threadIds.has('kept'), true)
  assert.deepEqual(following, [['rejected', false]])
  assert.doesNotThrow(() =>
    client.handleStateChange({
      conversationId: 'rejected',
      change: { type: 'patches', baseRevision: 1, revision: 2, patches: [] }
    })
  )
  assert.equal(client.conversations.has(key), false)
})

test('getTerminalTask 精确读取当前终态，退订和停止后清除且不重发历史任务', () => {
  const outputs = []
  const createClient = () =>
    new CodexIpcClient({
      threadIds: ['thread-1'],
      onTasks: (tasks) => outputs.push(tasks),
      onVisibleThread: () => undefined,
      onConnection: () => undefined
    })
  const state = conversationWithTurns([
    { turnId: 'turn-1', turnStartedAtMs: 1_000, durationMs: 500, status: 'completed' }
  ])
  state.updatedAt = 1_500
  state.threadRuntimeStatus = { type: 'idle', activeFlags: [] }

  const client = createClient()
  client.handleStateChange({
    conversationId: 'thread-1',
    change: { type: 'snapshot', revision: 1, conversationState: state }
  })
  const projected = client.getTerminalTask('local', 'thread-1', 'turn-1')
  assert.equal(projected.phase, 'completed')
  assert.strictEqual(client.getTerminalTask('local', 'thread-1', 'turn-1'), projected)
  assert.equal(client.getTerminalTask('local', 'thread-1', 'turn-2'), undefined)
  assert.deepEqual(outputs, [[]])
  client.unfollowThread('thread-1')
  assert.equal(client.getTerminalTask('local', 'thread-1', 'turn-1'), undefined)
  assert.deepEqual(outputs, [[]])

  const stoppedClient = createClient()
  stoppedClient.handleStateChange({
    conversationId: 'thread-1',
    change: { type: 'snapshot', revision: 1, conversationState: state }
  })
  assert.equal(stoppedClient.getTerminalTask('local', 'thread-1', 'turn-1').phase, 'completed')
  stoppedClient.stop()
  assert.equal(stoppedClient.getTerminalTask('local', 'thread-1', 'turn-1'), undefined)
  assert.deepEqual(outputs, [[], []])
})

test('runtime active 时按最新真实回合读取终态而不匹配旧 ID', () => {
  for (const [updatedAt, expectedProjection] of [
    [1_500, undefined],
    [1_600, 'thread:thread-1']
  ]) {
    const state = conversationWithTurns([
      { turnId: 'turn-2', turnStartedAtMs: 1_000, durationMs: 500, status: 'completed' }
    ])
    state.updatedAt = updatedAt
    state.threadRuntimeStatus = { type: 'active', activeFlags: [] }
    const projected = projectConversationState('local', 'thread-1', state)
    assert.equal(projected?.turnId, expectedProjection)

    const client = new CodexIpcClient({
      threadIds: ['thread-1'],
      onTasks: () => undefined,
      onVisibleThread: () => undefined,
      onConnection: () => undefined
    })
    client.handleStateChange({
      conversationId: 'thread-1',
      change: { type: 'snapshot', revision: 1, conversationState: state }
    })
    const terminal = client.getTerminalTask('local', 'thread-1', 'turn-2')
    assert.equal(terminal?.turnId, 'turn-2')
    assert.equal(terminal?.phase, 'completed')
    assert.equal(client.getTerminalTask('local', 'thread-1', 'turn-1'), undefined)
  }
})

test('应用连续 revision 路径补丁且不修改原快照', () => {
  const source = { status: { type: 'active', flags: [] }, requests: [] }
  const result = applyStatePatches(source, [
    { op: 'replace', path: ['status', 'flags'], value: ['waitingOnApproval'] },
    { op: 'add', path: ['requests', '-'], value: { id: 'request-1' } }
  ])
  assert.deepEqual(source, { status: { type: 'active', flags: [] }, requests: [] })
  assert.deepEqual(result.status.flags, ['waitingOnApproval'])
  assert.equal(result.requests.length, 1)
})

test('数字下标补丁路径可正常应用', () => {
  const source = {
    turnHistory: {
      history: {
        items: [
          { turnId: 'turn-1', status: 'inProgress' },
          { turnId: 'turn-2', status: 'completed' }
        ]
      }
    }
  }
  const result = applyStatePatches(source, [
    { op: 'replace', path: ['turnHistory', 'history', 'items', 1, 'status'], value: 'failed' }
  ])
  assert.deepEqual(source.turnHistory.history.items[1].status, 'completed')
  assert.equal(result.turnHistory.history.items[1].status, 'failed')
})

test('数组补丁区分追加与替换/删除边界', () => {
  assert.deepEqual(
    applyStatePatches({ items: ['a'] }, [{ op: 'add', path: ['items', 1], value: 'b' }]),
    { items: ['a', 'b'] }
  )
  assert.deepEqual(
    applyStatePatches({ items: ['a'] }, [{ op: 'add', path: ['items', '-'], value: 'b' }]),
    { items: ['a', 'b'] }
  )
  for (const op of ['replace', 'remove']) {
    assert.throws(
      () => applyStatePatches({ items: ['a'] }, [{ op, path: ['items', 1], value: 'b' }]),
      /Invalid array index/
    )
    assert.throws(
      () => applyStatePatches({ items: ['a'] }, [{ op, path: ['items', '-'], value: 'b' }]),
      /Invalid array index/
    )
  }
})

test('快照只投影任务必要字段并以审批优先', () => {
  const state = {
    title: '修复状态',
    cwd: 'F:\\WorkSpace\\codex-status-line',
    updatedAt: 2_000,
    threadRuntimeStatus: { type: 'active', activeFlags: ['waitingOnApproval'] },
    requests: [{ requestId: 'request-1', method: 'execCommandApproval', command: 'private' }],
    turnHistory: {
      history: {
        entitiesByKey: {
          'turn:turn-1': { turnId: 'turn-1', turnStartedAtMs: 1_000, status: 'inProgress' }
        }
      }
    }
  }
  const task = projectConversationState('local', 'thread-1', state, 3_000)
  assert.ok(task)
  assert.equal(task.project, 'codex-status-line')
  assert.equal(task.turnId, 'turn-1')
  assert.equal(task.startedAt, 1_000)
  assert.equal(getDisplayStatus(task), 'waiting-approval')
  assert.equal(JSON.stringify(task).includes('private'), false)
})

test('缺少执行证据时不使用线程创建时间冒充', () => {
  const task = projectConversationState(
    'local',
    'thread-1',
    {
      title: '任务',
      createdAt: 1,
      threadRuntimeStatus: { type: 'active', activeFlags: [] }
    },
    3
  )
  assert.equal(task, undefined)
})

test('历史完成快照不会被活动筛选误认为当前任务', () => {
  const task = projectConversationState(
    'local',
    'thread-1',
    {
      title: '旧任务',
      updatedAt: 2,
      threadRuntimeStatus: { type: 'idle', activeFlags: [] },
      turnHistory: {
        history: {
          entitiesByKey: {
            'turn:old': { turnId: 'old', turnStartedAtMs: 1, status: 'completed' }
          }
        }
      }
    },
    3
  )
  assert.equal(task?.phase, 'completed')
  assert.equal(task?.requests.length, 0)
})

test('只有模糊 active 且没有 inProgress 或请求时不创建执行任务', () => {
  const task = projectConversationState(
    'local',
    'thread-1',
    {
      updatedAt: 3_000,
      threadRuntimeStatus: { type: 'active', activeFlags: [] },
      turnHistory: {
        history: {
          entitiesByKey: {
            'turn:old': { turnId: 'old', turnStartedAtMs: 1_000, status: 'failed' }
          }
        }
      }
    },
    3_000
  )
  assert.equal(task, undefined)
})

test('线程更新晚于最近终态结束时识别尚未载入的新 turn', () => {
  const task = projectConversationState(
    'local',
    'thread-1',
    {
      updatedAt: 3_000,
      threadRuntimeStatus: { type: 'active', activeFlags: [] },
      turnHistory: {
        history: {
          entitiesByKey: {
            'turn:old': {
              turnId: 'old',
              turnStartedAtMs: 1_000,
              durationMs: 500,
              status: 'completed'
            }
          }
        }
      }
    },
    4_000
  )
  assert.equal(task?.phase, 'running')
  assert.equal(task?.startedAt, 3_000)
  assert.equal(task?.turnId, 'thread:thread-1')
})

test('线程更新没有越过最近终态结束时不误报执行中', () => {
  const task = projectConversationState(
    'local',
    'thread-1',
    {
      updatedAt: 1_400,
      threadRuntimeStatus: { type: 'active', activeFlags: [] },
      turnHistory: {
        history: {
          entitiesByKey: {
            'turn:latest': {
              turnId: 'latest',
              turnStartedAtMs: 1_000,
              durationMs: 500,
              status: 'completed'
            }
          }
        }
      }
    },
    4_000
  )
  assert.equal(task, undefined)
})

test('当前 turn 未载入时待处理请求仍可建立活动任务', () => {
  const task = projectConversationState(
    'local',
    'thread-1',
    {
      updatedAt: 3_000,
      threadRuntimeStatus: { type: 'active', activeFlags: ['waitingOnUserInput'] },
      requests: [{ requestId: 'input-1', method: 'requestUserInput' }]
    },
    4_000
  )
  assert.equal(getDisplayStatus(task), 'waiting-input')
  assert.equal(task?.startedAt, 3_000)
})

test('IPC patch 新增终态 turn 时识别完成、失败和取消', () => {
  const previous = conversationWithTurns([
    { turnId: 'turn-1', turnStartedAtMs: 1_000, status: 'inProgress' }
  ])
  for (const [status, phase] of [
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['interrupted', 'stopped']
  ]) {
    const current = conversationWithTurns([{ turnId: 'turn-1', turnStartedAtMs: 1_000, status }])
    current.updatedAt = 1_000
    current.threadRuntimeStatus = { type: 'idle', activeFlags: [] }
    const transition = projectTerminalTransition('local', 'thread-1', previous, current, 3_000)
    const projection = projectConversationState('local', 'thread-1', current, 3_000)
    assert.equal(transition?.phase, phase)
    assert.equal(projection?.latestEventId, transition?.latestEventId)
  }
})

test('IPC 终态优先于尚未移除的审批和回复请求', () => {
  const previous = conversationWithTurns([
    { turnId: 'turn-1', turnStartedAtMs: 1_000, status: 'inProgress' }
  ])
  for (const status of ['completed', 'failed', 'interrupted']) {
    const current = conversationWithTurns([{ turnId: 'turn-1', turnStartedAtMs: 1_000, status }])
    current.requests = [
      { requestId: 'approval', method: 'execCommandApproval' },
      { requestId: 'input', method: 'requestUserInput' }
    ]
    current.threadRuntimeStatus.activeFlags = ['waitingOnApproval']
    const task = projectTerminalTransition('local', 'thread-1', previous, current)
    assert.deepEqual(task.requests, [])
    assert.equal(getDisplayStatus(task), task.phase)
  }
})

test('Desktop 自动审批的 IPC 快照与补丁集成流解除 Hook 任务等待', () => {
  const service = new CodexActivityService({
    cwd: '.',
    descriptorPath: 'unused',
    onSnapshot: () => undefined,
    emitDebounceMs: 0
  })
  service.threadSources.set('local\u0000thread-1', 'vscode')
  const hook = { session_id: 'thread-1', turn_id: 'turn-1', tool_use_id: 'tool-1' }
  for (const hook_event_name of ['UserPromptSubmit', 'PreToolUse', 'PermissionRequest']) {
    service.handleHookPayload({ ...hook, hook_event_name }, 1_000)
  }
  const client = new CodexIpcClient({
    threadIds: ['thread-1'],
    onTasks: (tasks) => service.updateIpcTasks(tasks),
    onVisibleThread: () => undefined,
    onConnection: () => undefined
  })
  const conversationState = conversationWithTurns([
    { turnId: 'turn-1', turnStartedAtMs: 1_000, status: 'inProgress' }
  ])
  conversationState.requests = [{ requestId: 'ipc-approval', method: 'execCommandApproval' }]
  conversationState.threadRuntimeStatus.activeFlags = ['waitingOnApproval']
  client.handleStateChange({
    conversationId: 'thread-1',
    change: { type: 'snapshot', revision: 1, conversationState }
  })
  assert.equal(getDisplayStatus(service.getSnapshot().tasks[0]), 'waiting-approval')
  client.handleStateChange({
    conversationId: 'thread-1',
    change: {
      type: 'patches',
      baseRevision: 1,
      revision: 2,
      patches: [
        { op: 'replace', path: ['requests'], value: [] },
        { op: 'replace', path: ['threadRuntimeStatus', 'activeFlags'], value: [] }
      ]
    }
  })
  assert.equal(getDisplayStatus(service.getSnapshot().tasks[0]), 'running')
  assert.deepEqual(service.getSnapshot().tasks[0].requests, [])
})

test('Desktop 同回合重复 Hook 后接受 IPC 完成且迟到终态不复活任务', () => {
  const service = new CodexActivityService({
    cwd: '.',
    descriptorPath: 'unused',
    onSnapshot: () => undefined,
    emitDebounceMs: 0
  })
  service.threadSources.set('local\u0000thread-1', 'vscode')
  const client = new CodexIpcClient({
    threadIds: ['thread-1'],
    onTasks: (tasks) => service.updateIpcTasks(tasks),
    onVisibleThread: () => undefined,
    onConnection: () => undefined
  })
  const conversationState = conversationWithTurns([
    { turnId: 'turn-1', turnStartedAtMs: 1_000, durationMs: 0, status: 'inProgress' }
  ])
  conversationState.updatedAt = 1_000
  conversationState.requests = [{ requestId: 'approval-1', method: 'execCommandApproval' }]
  conversationState.threadRuntimeStatus.activeFlags = ['waitingOnApproval']
  client.handleStateChange({
    conversationId: 'thread-1',
    change: { type: 'snapshot', revision: 1, conversationState }
  })
  assert.equal(service.getSnapshot().tasks[0].requests.length, 1)

  const hook = { session_id: 'thread-1', turn_id: 'turn-1' }
  for (const receivedAt of [1_100, 1_101]) {
    service.handleHookPayload({ ...hook, hook_event_name: 'UserPromptSubmit' }, receivedAt)
  }
  const running = service.getSnapshot().tasks[0]
  assert.equal(running.phase, 'running')
  assert.equal(running.turnId, 'turn-1')
  assert.equal(running.startedAt, 1_000)

  const completionPatches = [
    {
      op: 'replace',
      path: ['turnHistory', 'history', 'entitiesByKey', 'turn:turn-1', 'status'],
      value: 'completed'
    },
    {
      op: 'replace',
      path: ['turnHistory', 'history', 'entitiesByKey', 'turn:turn-1', 'durationMs'],
      value: 500
    },
    { op: 'replace', path: ['requests'], value: [] },
    { op: 'replace', path: ['threadRuntimeStatus', 'activeFlags'], value: [] }
  ]
  client.handleStateChange({
    conversationId: 'thread-1',
    change: { type: 'patches', baseRevision: 1, revision: 2, patches: completionPatches }
  })
  const completed = service.getSnapshot().tasks[0]
  assert.equal(completed.phase, 'completed')
  assert.deepEqual(completed.requests, [])
  assert.equal(completed.startedAt, 1_000)
  assert.equal(service.dismissTask('thread-1'), true)
  assert.deepEqual(service.getSnapshot().tasks, [])

  service.handleHookPayload({ ...hook, hook_event_name: 'Stop' }, 1_200)
  client.handleStateChange({
    conversationId: 'thread-1',
    change: { type: 'patches', baseRevision: 2, revision: 3, patches: completionPatches }
  })
  assert.deepEqual(service.getSnapshot().tasks, [])

  service.handleHookPayload(
    { ...hook, turn_id: 'turn-2', hook_event_name: 'UserPromptSubmit' },
    1_300
  )
  service.handleHookPayload({ ...hook, hook_event_name: 'Stop' }, 1_400)
  assert.equal(service.getSnapshot().tasks[0].turnId, 'turn-2')
  assert.equal(service.getSnapshot().tasks[0].phase, 'running')
})

test('IPC 独立完成卡关闭后迟到的同回合 Hook 不复活任务', () => {
  const { service, connectClient } = createDesktopIpcFixture()
  const client = connectClient()
  const running = conversationWithTurns([
    { turnId: 'turn-1', turnStartedAtMs: 1_000, status: 'inProgress' }
  ])
  running.updatedAt = 1_000
  client.handleStateChange({
    conversationId: 'thread-1',
    change: { type: 'snapshot', revision: 1, conversationState: running }
  })

  client.handleStateChange({
    conversationId: 'thread-1',
    change: {
      type: 'patches',
      baseRevision: 1,
      revision: 2,
      patches: [
        {
          op: 'replace',
          path: ['turnHistory', 'history', 'entitiesByKey', 'turn:turn-1', 'status'],
          value: 'completed'
        },
        {
          op: 'replace',
          path: ['turnHistory', 'history', 'entitiesByKey', 'turn:turn-1', 'durationMs'],
          value: 500
        },
        { op: 'replace', path: ['threadRuntimeStatus', 'type'], value: 'idle' },
        { op: 'replace', path: ['updatedAt'], value: 1_500 }
      ]
    }
  })
  const completed = service.getSnapshot().tasks[0]
  assert.equal(completed.phase, 'completed')
  assert.equal(completed.latestEventId, 'ipc:thread-1:turn-1:completed')
  assert.equal(
    client.getTerminalTask('local', 'thread-1', 'turn-1').latestEventId,
    completed.latestEventId
  )
  assert.equal(service.dismissTask('thread-1'), true)

  service.handleHookPayload(
    { session_id: 'thread-1', turn_id: 'turn-1', hook_event_name: 'UserPromptSubmit' },
    1_600
  )
  assert.deepEqual(service.getSnapshot().tasks, [])
})

test('Hook 创建后从首次 IPC 快照缓存复核完成状态', () => {
  const { service, connectClient } = createDesktopIpcFixture()
  const client = connectClient()
  const completed = conversationWithTurns([
    { turnId: 'turn-1', turnStartedAtMs: 1_000, durationMs: 500, status: 'completed' }
  ])
  completed.updatedAt = 1_500
  completed.threadRuntimeStatus = { type: 'idle', activeFlags: [] }

  client.handleStateChange({
    conversationId: 'thread-1',
    change: { type: 'snapshot', revision: 1, conversationState: completed }
  })
  assert.deepEqual(service.getSnapshot().tasks, [])

  service.handleHookPayload(
    { session_id: 'thread-1', turn_id: 'turn-1', hook_event_name: 'UserPromptSubmit' },
    1_000
  )
  const task = service.getSnapshot().tasks[0]
  assert.equal(task.turnId, 'turn-1')
  assert.equal(task.phase, 'completed')
  assert.equal(task.startedAt, 1_000)
  assert.equal(task.updatedAt, 1_500)
})

test('Hook 先到时 active 初始快照仍按真实回合终态结束任务', () => {
  for (const updatedAt of [1_500, 1_600]) {
    const { service, connectClient } = createDesktopIpcFixture()
    service.handleHookPayload(
      { session_id: 'thread-1', turn_id: 'turn-1', hook_event_name: 'UserPromptSubmit' },
      1_000
    )
    const client = connectClient()
    const completed = conversationWithTurns([
      { turnId: 'turn-1', turnStartedAtMs: 1_000, durationMs: 500, status: 'completed' }
    ])
    completed.updatedAt = updatedAt
    client.handleStateChange({
      conversationId: 'thread-1',
      change: { type: 'snapshot', revision: 1, conversationState: completed }
    })
    assert.equal(service.getSnapshot().tasks[0].turnId, 'turn-1')
    assert.equal(service.getSnapshot().tasks[0].phase, 'completed')
  }
})

test('Hook 任务从重连后的空任务快照复核完成且关闭后不复活', () => {
  const { service, connectClient } = createDesktopIpcFixture()
  service.handleHookPayload(
    { session_id: 'thread-1', turn_id: 'turn-1', hook_event_name: 'UserPromptSubmit' },
    1_000
  )
  const firstClient = connectClient()
  const running = conversationWithTurns([
    { turnId: 'turn-1', turnStartedAtMs: 1_000, status: 'inProgress' }
  ])
  firstClient.handleStateChange({
    conversationId: 'thread-1',
    change: { type: 'snapshot', revision: 1, conversationState: running }
  })
  firstClient.stop()

  const reconnectedClient = connectClient()
  const completed = conversationWithTurns([
    { turnId: 'turn-1', turnStartedAtMs: 1_000, durationMs: 500, status: 'completed' }
  ])
  completed.updatedAt = 1_500
  completed.threadRuntimeStatus = { type: 'idle', activeFlags: [] }
  for (const revision of [1, 2]) {
    reconnectedClient.handleStateChange({
      conversationId: 'thread-1',
      change: { type: 'snapshot', revision, conversationState: completed }
    })
  }
  assert.equal(service.getSnapshot().tasks[0].phase, 'completed')
  assert.equal(service.getSnapshot().tasks[0].startedAt, 1_000)
  assert.equal(service.dismissTask('thread-1'), true)
  service.handleHookPayload(
    { session_id: 'thread-1', turn_id: 'turn-1', hook_event_name: 'Stop' },
    1_600
  )
  reconnectedClient.handleStateChange({
    conversationId: 'thread-1',
    change: { type: 'snapshot', revision: 3, conversationState: completed }
  })
  assert.deepEqual(service.getSnapshot().tasks, [])
})

test('runtime active 时完成 turn 仍可结束迟到 Hook，旧终态不关闭新回合', () => {
  for (const updatedAt of [2_500, 2_600]) {
    const { service, connectClient } = createDesktopIpcFixture()
    service.handleHookPayload(
      { session_id: 'thread-1', turn_id: 'turn-1', hook_event_name: 'UserPromptSubmit' },
      1_000
    )
    const client = connectClient()
    const active = conversationWithTurns([
      { turnId: 'turn-2', turnStartedAtMs: 2_000, status: 'inProgress' }
    ])
    active.updatedAt = 2_000
    client.handleStateChange({
      conversationId: 'thread-1',
      change: { type: 'snapshot', revision: 1, conversationState: active }
    })

    const terminal = conversationWithTurns([
      { turnId: 'turn-2', turnStartedAtMs: 2_000, durationMs: 500, status: 'completed' }
    ])
    terminal.updatedAt = updatedAt
    terminal.threadRuntimeStatus = { type: 'active', activeFlags: [] }
    const ordinaryProjection = projectConversationState('local', 'thread-1', terminal)
    assert.equal(ordinaryProjection?.turnId, updatedAt === 2_500 ? undefined : 'thread:thread-1')

    client.handleStateChange({
      conversationId: 'thread-1',
      change: {
        type: 'patches',
        baseRevision: 1,
        revision: 2,
        patches: [
          {
            op: 'replace',
            path: ['turnHistory', 'history', 'entitiesByKey', 'turn:turn-2', 'status'],
            value: 'completed'
          },
          {
            op: 'replace',
            path: ['turnHistory', 'history', 'entitiesByKey', 'turn:turn-2', 'durationMs'],
            value: 500
          },
          { op: 'replace', path: ['updatedAt'], value: updatedAt }
        ]
      }
    })
    service.handleHookPayload(
      { session_id: 'thread-1', turn_id: 'turn-2', hook_event_name: 'UserPromptSubmit' },
      2_700
    )
    const completed = service.getSnapshot().tasks[0]
    assert.equal(completed.turnId, 'turn-2')
    assert.equal(completed.phase, 'completed')

    service.handleHookPayload(
      { session_id: 'thread-1', turn_id: 'turn-3', hook_event_name: 'UserPromptSubmit' },
      3_000
    )
    service.handleHookPayload(
      { session_id: 'thread-1', turn_id: 'turn-2', hook_event_name: 'Stop' },
      3_100
    )
    const current = service.getSnapshot().tasks[0]
    assert.equal(current.turnId, 'turn-3')
    assert.equal(current.phase, 'running')
  }
})

test('IPC 新回合先完成再收到 Prompt 时复核终态，旧终态和 pending turn 不关闭新回合', () => {
  const { service, connectClient } = createDesktopIpcFixture()
  service.handleHookPayload(
    { session_id: 'thread-1', turn_id: 'turn-1', hook_event_name: 'UserPromptSubmit' },
    1_000
  )
  const client = connectClient()
  const turn2Running = conversationWithTurns([
    { turnId: 'turn-2', turnStartedAtMs: 2_000, status: 'inProgress' }
  ])
  client.handleStateChange({
    conversationId: 'thread-1',
    change: { type: 'snapshot', revision: 1, conversationState: turn2Running }
  })
  client.handleStateChange({
    conversationId: 'thread-1',
    change: {
      type: 'patches',
      baseRevision: 1,
      revision: 2,
      patches: [
        {
          op: 'replace',
          path: ['turnHistory', 'history', 'entitiesByKey', 'turn:turn-2', 'status'],
          value: 'completed'
        },
        {
          op: 'replace',
          path: ['turnHistory', 'history', 'entitiesByKey', 'turn:turn-2', 'durationMs'],
          value: 500
        },
        { op: 'replace', path: ['threadRuntimeStatus', 'type'], value: 'idle' },
        { op: 'replace', path: ['updatedAt'], value: 2_500 }
      ]
    }
  })
  service.handleHookPayload(
    { session_id: 'thread-1', turn_id: 'turn-2', hook_event_name: 'UserPromptSubmit' },
    2_000
  )
  assert.equal(service.getSnapshot().tasks[0].turnId, 'turn-2')
  assert.equal(service.getSnapshot().tasks[0].phase, 'completed')

  service.handleHookPayload(
    { session_id: 'thread-1', turn_id: 'turn-3', hook_event_name: 'UserPromptSubmit' },
    3_000
  )
  service.handleHookPayload(
    { session_id: 'thread-1', turn_id: 'turn-2', hook_event_name: 'Stop' },
    3_100
  )
  assert.equal(service.getSnapshot().tasks[0].turnId, 'turn-3')
  assert.equal(service.getSnapshot().tasks[0].phase, 'running')

  const pendingTurn = conversationWithTurns([
    { turnId: 'turn-2', turnStartedAtMs: 2_000, durationMs: 500, status: 'completed' }
  ])
  pendingTurn.updatedAt = 2_600
  pendingTurn.threadRuntimeStatus = { type: 'active', activeFlags: [] }
  client.handleStateChange({
    conversationId: 'thread-1',
    change: { type: 'snapshot', revision: 3, conversationState: pendingTurn }
  })
  assert.equal(service.getSnapshot().tasks[0].turnId, 'turn-3')
  assert.equal(service.getSnapshot().tasks[0].phase, 'running')
})

test('初始及重复终态快照不把残留审批投影为执行任务', () => {
  for (const status of ['completed', 'failed', 'interrupted']) {
    const state = conversationWithTurns([
      { turnId: 'turn-1', turnStartedAtMs: 1_000, durationMs: 500, status }
    ])
    state.threadRuntimeStatus = { type: 'idle', activeFlags: ['waitingOnApproval'] }
    state.requests = [{ requestId: 'stale-approval', method: 'execCommandApproval' }]
    const task = projectConversationState('local', 'thread-1', state)
    assert.deepEqual(task.requests, [])
    assert.equal(task.turnId, 'turn-1')
    assert.equal(task.startedAt, 1_000)
    assert.equal(getDisplayStatus(task), task.phase)
    const outputs = []
    const client = new CodexIpcClient({
      threadIds: ['thread-1'],
      onTasks: (tasks) => outputs.push(tasks),
      onVisibleThread: () => undefined,
      onConnection: () => undefined
    })
    for (const revision of [1, 2]) {
      client.handleStateChange({
        conversationId: 'thread-1',
        change: { type: 'snapshot', revision, conversationState: state }
      })
    }
    assert.deepEqual(outputs, [[], []])
  }
})

test('tail 实体中的最新 turn 覆盖旧分页 turn', () => {
  const state = conversationWithTurns([
    { turnId: 'old', turnStartedAtMs: 1_000, durationMs: 500, status: 'completed' }
  ])
  state.updatedAt = 3_000
  state.turnHistory.history.entitiesByKey['tail:0:local:new'] = {
    turnId: 'new',
    turnStartedAtMs: 3_000,
    status: 'inProgress'
  }
  const task = projectConversationState('local', 'thread-1', state, 4_000)
  assert.equal(task?.turnId, 'new')
  assert.equal(task?.phase, 'running')
  assert.equal(task?.startedAt, 3_000)
})

test('tail 实体从执行中切到完成时输出终态和结束时间', () => {
  const previous = conversationWithTailTurn({
    turnId: 'turn-1',
    turnStartedAtMs: 1_000,
    status: 'inProgress'
  })
  const current = conversationWithTailTurn({
    turnId: 'turn-1',
    turnStartedAtMs: 1_000,
    durationMs: 500,
    status: 'completed'
  })
  current.updatedAt = 9_000
  const task = projectTerminalTransition('local', 'thread-1', previous, current, 3_000)
  assert.equal(task?.phase, 'completed')
  assert.equal(task?.turnId, 'turn-1')
  assert.equal(task?.startedAt, 1_000)
  assert.equal(task?.updatedAt, 1_500)
})

test('IPC 未变化的历史终态不重复通知', () => {
  const state = conversationWithTurns([
    { turnId: 'turn-1', turnStartedAtMs: 1_000, status: 'completed' }
  ])
  assert.equal(projectTerminalTransition('local', 'thread-1', state, state, 3_000), undefined)
})

test('前一帧只有模糊 active 时新失败 turn 仍会输出终态', () => {
  const outputs = []
  const client = new CodexIpcClient({
    threadIds: ['thread-1'],
    onTasks: (tasks) => outputs.push(tasks),
    onVisibleThread: () => undefined,
    onConnection: () => undefined
  })
  client.handleStateChange?.({
    conversationId: 'thread-1',
    hostId: 'local',
    change: {
      type: 'snapshot',
      revision: 1,
      conversationState: {
        title: '任务',
        updatedAt: 2_000,
        threadRuntimeStatus: { type: 'active', activeFlags: [] },
        requests: [],
        turnHistory: { history: { entitiesByKey: {} } }
      }
    }
  })
  assert.equal(outputs.at(-1)[0].phase, 'running')
  client.handleStateChange?.({
    conversationId: 'thread-1',
    hostId: 'local',
    change: {
      type: 'patches',
      baseRevision: 1,
      revision: 2,
      patches: [
        {
          op: 'add',
          path: ['turnHistory', 'history', 'entitiesByKey', 'turn:turn-1'],
          value: {
            turnId: 'turn-1',
            turnStartedAtMs: 1_000,
            status: 'failed'
          }
        }
      ]
    }
  })
  assert.equal(outputs.at(-1)[0].phase, 'failed')
})

test('IPC-only 占位回合不会退休后续 Hook，未载入 turn 时仍同步审批和输入', () => {
  for (const scenario of [
    {
      activeFlag: 'waitingOnApproval',
      request: { requestId: 'approval-1', method: 'execCommandApproval' },
      expectedStatus: 'waiting-approval',
      updatedAt: 1_200
    },
    {
      activeFlag: 'waitingOnUserInput',
      request: { requestId: 'input-1', method: 'requestUserInput' },
      expectedStatus: 'waiting-input',
      updatedAt: 1_300
    }
  ]) {
    const { service, connectClient } = createDesktopIpcFixture()
    const client = connectClient()
    const initial = conversationWithTurns([])
    initial.updatedAt = 1_000
    client.handleStateChange({
      conversationId: 'thread-1',
      change: { type: 'snapshot', revision: 1, conversationState: initial }
    })
    assert.equal(service.getSnapshot().tasks[0]?.turnId, 'thread:thread-1')

    service.handleHookPayload(
      { session_id: 'thread-1', turn_id: 'turn-1', hook_event_name: 'UserPromptSubmit' },
      1_100
    )
    assert.equal(service.getSnapshot().tasks[0]?.turnId, 'turn-1')

    client.handleStateChange({
      conversationId: 'thread-1',
      change: {
        type: 'patches',
        baseRevision: 1,
        revision: 2,
        patches: [
          { op: 'replace', path: ['requests'], value: [scenario.request] },
          {
            op: 'replace',
            path: ['threadRuntimeStatus', 'activeFlags'],
            value: [scenario.activeFlag]
          },
          { op: 'replace', path: ['updatedAt'], value: scenario.updatedAt }
        ]
      }
    })

    const task = service.getSnapshot().tasks[0]
    assert.equal(task?.turnId, 'turn-1')
    assert.equal(getDisplayStatus(task), scenario.expectedStatus)
    assert.equal(service.finishedHookTurnIds.has('thread-1\u0000thread:thread-1'), false)
  }
})

test('IPC-only 真实 B 不被迟到 A 退休，B 可由 Hook 或 IPC 完成并关闭', () => {
  for (const stopA of [false, true]) {
    for (const finishWith of ['hook', 'ipc']) {
      const { service, connectClient } = createDesktopIpcFixture()
      const client = connectClient()
      const ipcTurn = conversationWithTurns([
        { turnId: 'turn-B', turnStartedAtMs: 2_000, status: 'inProgress' }
      ])
      ipcTurn.updatedAt = 2_000
      client.handleStateChange({
        conversationId: 'thread-1',
        change: { type: 'snapshot', revision: 1, conversationState: ipcTurn }
      })

      service.handleHookPayload(
        { session_id: 'thread-1', turn_id: 'turn-A', hook_event_name: 'UserPromptSubmit' },
        2_100
      )
      if (stopA) {
        service.handleHookPayload(
          { session_id: 'thread-1', turn_id: 'turn-A', hook_event_name: 'Stop' },
          2_200
        )
      }
      service.handleHookPayload(
        { session_id: 'thread-1', turn_id: 'turn-B', hook_event_name: 'UserPromptSubmit' },
        2_300
      )
      assert.equal(service.getSnapshot().tasks[0]?.turnId, 'turn-B')
      assert.equal(service.getSnapshot().tasks[0]?.phase, 'running')

      if (finishWith === 'hook') {
        service.handleHookPayload(
          { session_id: 'thread-1', turn_id: 'turn-B', hook_event_name: 'Stop' },
          2_400
        )
      } else {
        client.handleStateChange({
          conversationId: 'thread-1',
          change: {
            type: 'patches',
            baseRevision: 1,
            revision: 2,
            patches: [
              {
                op: 'replace',
                path: ['turnHistory', 'history', 'entitiesByKey', 'turn:turn-B', 'status'],
                value: 'completed'
              },
              {
                op: 'replace',
                path: ['turnHistory', 'history', 'entitiesByKey', 'turn:turn-B', 'durationMs'],
                value: 500
              },
              { op: 'replace', path: ['threadRuntimeStatus', 'type'], value: 'idle' },
              { op: 'replace', path: ['updatedAt'], value: 2_500 }
            ]
          }
        })
      }

      assert.equal(service.getSnapshot().tasks[0]?.turnId, 'turn-B')
      assert.equal(service.getSnapshot().tasks[0]?.phase, 'completed')
      assert.equal(service.dismissTask('thread-1'), true)
      assert.deepEqual(service.getSnapshot().tasks, [])
    }
  }
})

function createDesktopIpcFixture() {
  const service = new CodexActivityService({
    cwd: '.',
    descriptorPath: 'unused',
    onSnapshot: () => undefined,
    emitDebounceMs: 0
  })
  service.threadSources.set('local\u0000thread-1', 'vscode')
  return {
    service,
    connectClient() {
      const client = new CodexIpcClient({
        threadIds: ['thread-1'],
        onTasks: (tasks) => service.updateIpcTasks(tasks),
        onVisibleThread: () => undefined,
        onConnection: () => undefined
      })
      service.ipc = client
      return client
    }
  }
}

function conversationWithTurns(turns) {
  return {
    title: '任务',
    cwd: 'F:\\WorkSpace\\codex-status-line',
    updatedAt: 3_000,
    threadRuntimeStatus: { type: 'active', activeFlags: [] },
    requests: [],
    turnHistory: {
      history: {
        entitiesByKey: Object.fromEntries(turns.map((turn) => [`turn:${turn.turnId}`, turn]))
      }
    }
  }
}

function conversationWithTailTurn(turn) {
  const state = conversationWithTurns([])
  state.updatedAt = turn.turnStartedAtMs + (turn.durationMs ?? 0)
  state.turnHistory.history.entitiesByKey[`tail:0:local:${turn.turnId}`] = turn
  return state
}
