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

test('其他客户端发现的新任务只补充一次本地订阅', () => {
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

  assert.deepEqual(followed, [{ threadId: 'new-thread', following: true }])
  assert.equal(client.threadIds?.has('new-thread'), true)
  assert.deepEqual(visibleThreads, ['new-thread', 'new-thread', undefined])
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
    assert.equal(
      projectTerminalTransition('local', 'thread-1', previous, current, 3_000)?.phase,
      phase
    )
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
    threadIds: [],
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
