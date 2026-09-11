/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  IslandState,
  PausableReminder,
  normalizeIslandPreferences,
  getDisplayStatus,
  resolveIslandWindowBounds,
  shouldPresentAlert
} from '../src/shared/island.ts'
import { mapCodexHookEvent, parseCodexHookPayload } from '../src/main/services/codex-hook-events.ts'
import { CodexActivityService } from '../src/main/services/codex-activity.ts'

const NOW = 1_000

test('灵动岛在主屏顶部中央且支持负坐标显示器', () => {
  assert.deepEqual(
    resolveIslandWindowBounds(
      { x: 0, y: 0, width: 1920, height: 1080 },
      { width: 464, height: 416 }
    ),
    { x: 728, y: 0, width: 464, height: 416 }
  )
  assert.deepEqual(
    resolveIslandWindowBounds(
      { x: -1920, y: -120, width: 1920, height: 1080 },
      { width: 464, height: 416 }
    ),
    { x: -1192, y: -120, width: 464, height: 416 }
  )
})

test('待审批覆盖执行中，查看不等于处理', () => {
  const state = new IslandState()
  state.apply(event('turn-started', 'start'))
  state.apply({
    ...event('request-opened', 'approval'),
    request: { id: 'request-1', kind: 'approval', createdAt: NOW + 1 }
  })
  const task = state.getSnapshot().tasks[0]
  assert.equal(getDisplayStatus(task), 'waiting-approval')
  state.markViewed(task.latestEventId)
  assert.equal(state.isViewed(task.latestEventId), true)
  assert.deepEqual(state.getSnapshot().viewedEventIds, [task.latestEventId])
  assert.equal(getDisplayStatus(state.getSnapshot().tasks[0]), 'waiting-approval')
})

test('六种展示状态按请求优先级和 turn 终态切换', () => {
  const base = authoritativeTask('running', 'turn-1')
  const state = new IslandState()
  state.upsertAuthoritative(base)
  assert.equal(getDisplayStatus(state.getSnapshot().tasks[0]), 'running')
  state.upsertAuthoritative({
    ...base,
    requests: [{ id: 'approval', kind: 'approval', createdAt: NOW }]
  })
  assert.equal(getDisplayStatus(state.getSnapshot().tasks[0]), 'waiting-approval')
  state.upsertAuthoritative({
    ...base,
    requests: [{ id: 'input', kind: 'input', createdAt: NOW }]
  })
  assert.equal(getDisplayStatus(state.getSnapshot().tasks[0]), 'waiting-input')
  for (const phase of ['completed', 'failed', 'stopped']) {
    state.upsertAuthoritative({ ...base, phase, requests: [] })
    assert.equal(getDisplayStatus(state.getSnapshot().tasks[0]), phase)
  }
})

test('重复和乱序事件不覆盖最新状态', () => {
  const state = new IslandState()
  const finished = { ...event('turn-finished', 'done', NOW + 10), outcome: 'failed' }
  assert.equal(state.apply(finished), true)
  assert.equal(state.apply(finished), false)
  assert.equal(state.apply(event('activity', 'old', NOW)), false)
  assert.equal(state.getSnapshot().tasks[0].phase, 'failed')
})

test('未知任务的请求解决事件不创建幽灵任务', () => {
  const state = new IslandState()
  assert.equal(
    state.apply({ ...event('request-resolved', 'resolved'), requestId: 'missing-request' }),
    false
  )
  assert.equal(state.getSnapshot().tasks.length, 0)
})

test('新回合清除旧请求并重置开始时间', () => {
  const state = new IslandState()
  state.apply({
    ...event('request-opened', 'request'),
    request: { id: 'request-1', kind: 'input', createdAt: NOW }
  })
  state.apply({ ...event('turn-started', 'next', NOW + 20), turnId: 'turn-2' })
  const task = state.getSnapshot().tasks[0]
  assert.equal(task.turnId, 'turn-2')
  assert.equal(task.requests.length, 0)
  assert.equal(task.startedAt, NOW + 20)
})

test('IPC 未载入当前 turn 时保留 Hook 观测到的开始时间', () => {
  const state = new IslandState()
  state.apply(event('turn-started', 'start'))
  state.upsertAuthoritative({
    ...state.getSnapshot().tasks[0],
    turnId: 'thread:thread-1',
    startedAt: NOW + 1,
    updatedAt: NOW + 1,
    latestEventId: 'ipc:thread-1:1001'
  })
  const task = state.getSnapshot().tasks[0]
  assert.equal(task.startedAt, NOW)
  assert.equal(task.turnId, 'turn-1')
})

test('IPC 活动列表移除任务时清理已取消的执行态', () => {
  let latest
  const service = new CodexActivityService({
    cwd: '.',
    descriptorPath: 'unused',
    onSnapshot: (snapshot) => {
      latest = snapshot
    }
  })
  service.updateIpcTasks?.([
    {
      hostId: 'local',
      threadId: 'cancelled-thread',
      turnId: 'turn-1',
      title: '已取消任务',
      project: 'project',
      phase: 'running',
      startedAt: NOW,
      updatedAt: NOW,
      requests: [],
      latestEventId: 'ipc:start'
    }
  ])
  assert.equal(latest.tasks.length, 1)
  service.updateIpcTasks?.([])
  assert.equal(latest.tasks.length, 0)
})

test('完成状态不被迟到 Hook 或 IPC 活动快照覆盖', () => {
  const state = new IslandState()
  state.apply(event('turn-started', 'start'))
  state.apply({ ...event('turn-finished', 'completed', NOW + 1), outcome: 'completed' })
  assert.equal(state.apply(event('activity', 'late', NOW + 2)), false)
  state.upsertAuthoritative({
    ...state.getSnapshot().tasks[0],
    turnId: 'thread:thread-1',
    phase: 'running',
    updatedAt: NOW + 3,
    latestEventId: 'ipc:fallback'
  })
  assert.equal(state.getSnapshot().tasks[0].phase, 'completed')
})

test('IPC 终态后的模糊 active 快照不复活已结束任务', () => {
  let latest
  const service = new CodexActivityService({
    cwd: '.',
    descriptorPath: 'unused',
    onSnapshot: (snapshot) => {
      latest = snapshot
    }
  })
  const running = authoritativeTask('running', 'turn-1')
  service.updateIpcTasks?.([running])
  service.updateIpcTasks?.([{ ...running, phase: 'completed', latestEventId: 'ipc:completed' }])
  service.updateIpcTasks?.([
    { ...running, turnId: 'thread:thread-1', latestEventId: 'ipc:fallback' }
  ])
  assert.equal(latest.tasks[0].phase, 'completed')

  service.updateIpcTasks?.([{ ...running, phase: 'stopped', latestEventId: 'ipc:stopped' }])
  service.updateIpcTasks?.([
    { ...running, turnId: 'thread:thread-1', latestEventId: 'ipc:stale-active' }
  ])
  assert.equal(latest.tasks.length, 0)
})

test('已查看的 IPC 完成任务不会被后续快照重新加入', () => {
  let latest
  const service = new CodexActivityService({
    cwd: '.',
    descriptorPath: 'unused',
    onSnapshot: (snapshot) => {
      latest = snapshot
    }
  })
  const completed = authoritativeTask('completed', 'turn-1')
  service.updateIpcTasks?.([completed])
  service.markViewed(completed.latestEventId)
  service.updateIpcTasks?.([completed])
  assert.equal(latest.tasks.length, 0)
})

test('Hook 任务不会被 IPC 缺失或完成快照覆盖', () => {
  let latest
  const service = activityService((snapshot) => {
    latest = snapshot
  })
  service.handleHookPayload?.(hookPayload('UserPromptSubmit'), NOW)
  const startedAt = latest.tasks[0].startedAt
  service.updateIpcTasks?.([])
  service.updateIpcTasks?.([{ ...authoritativeTask('completed', 'turn-1'), updatedAt: NOW + 99 }])
  assert.equal(latest.tasks[0].phase, 'running')
  assert.equal(latest.tasks[0].startedAt, startedAt)
})

test('缺少 turn_id 时新输入建立新回合且后续 Hook 继承', () => {
  const service = activityService(() => undefined)
  const payload = (hookEventName) => ({
    hook_event_name: hookEventName,
    session_id: 'thread-without-turn',
    cwd: 'F:\\WorkSpace\\codex-status-line'
  })

  service.handleHookPayload?.(payload('UserPromptSubmit'), NOW)
  const firstTurnId = service.getSnapshot().tasks[0].turnId
  assert.equal(firstTurnId, `hook:thread-without-turn:${NOW}`)

  service.handleHookPayload?.(payload('PostToolUse'), NOW + 1)
  assert.equal(service.getSnapshot().tasks[0].turnId, firstTurnId)
  service.handleHookPayload?.(payload('Stop'), NOW + 2)
  assert.equal(service.getSnapshot().tasks[0].phase, 'completed')

  service.handleHookPayload?.(payload('UserPromptSubmit'), NOW + 3)
  const next = service.getSnapshot().tasks[0]
  assert.equal(next.phase, 'running')
  assert.equal(next.turnId, `hook:thread-without-turn:${NOW + 3}`)
  assert.notEqual(next.turnId, firstTurnId)
})

test('旧回合迟到 Hook 不覆盖当前回合或回退回合映射', () => {
  const service = activityService(() => undefined)
  const payload = (hookEventName, turnId) => ({
    hook_event_name: hookEventName,
    session_id: 'thread-with-late-turn',
    turn_id: turnId,
    cwd: 'F:\\WorkSpace\\codex-status-line'
  })

  service.handleHookPayload?.(payload('UserPromptSubmit', 'turn-1'), NOW)
  service.handleHookPayload?.(payload('Stop', 'turn-1'), NOW + 1)
  service.handleHookPayload?.(payload('UserPromptSubmit', 'turn-2'), NOW + 2)
  service.handleHookPayload?.(payload('PostToolUse', 'turn-1'), NOW + 3)
  service.handleHookPayload?.(payload('UserPromptSubmit', 'turn-1'), NOW + 4)
  service.handleHookPayload?.(
    {
      hook_event_name: 'PostToolUse',
      session_id: 'thread-with-late-turn'
    },
    NOW + 5
  )

  const current = service.getSnapshot().tasks[0]
  assert.equal(current.turnId, 'turn-2')
  assert.equal(current.phase, 'running')
  assert.equal(service.hookTurnIds?.get('thread-with-late-turn'), 'turn-2')
})

test('被拒绝的 Hook 不接管任务且不会屏蔽后续 IPC 任务', () => {
  let latest
  const service = activityService((snapshot) => {
    latest = snapshot
  })
  const first = authoritativeTask('running', 'turn-1')
  const second = {
    ...authoritativeTask('running', 'turn-2'),
    threadId: 'thread-2',
    latestEventId: 'ipc:thread-2:running'
  }

  service.updateIpcTasks?.([first])
  service.handleHookPayload?.(
    {
      hook_event_name: 'PreToolUse',
      session_id: 'thread-2',
      tool_use_id: 'unknown-tool'
    },
    NOW + 1
  )
  service.updateIpcTasks?.([first, second])

  assert.deepEqual(latest.tasks.map((task) => task.threadId).sort(), ['thread-1', 'thread-2'])
  assert.equal(service.hookTaskKeys?.has('local\u0000thread-2'), false)
})

test('IPC 只向 Hook 任务补充待回复并可清除', () => {
  let latest
  const service = activityService((snapshot) => {
    latest = snapshot
  })
  service.handleHookPayload?.(hookPayload('UserPromptSubmit'), NOW)
  const running = authoritativeTask('running', 'turn-1')
  service.updateIpcTasks?.([
    {
      ...running,
      requests: [{ id: 'input-1', kind: 'input', summary: '需要回复', createdAt: NOW }]
    }
  ])
  assert.equal(getDisplayStatus(latest.tasks[0]), 'waiting-input')
  service.updateIpcTasks?.([running])
  assert.equal(getDisplayStatus(latest.tasks[0]), 'running')
})

test('IPC 可补充 Hook 没有的失败终态但保留 Hook 开始时间', () => {
  let latest
  const service = activityService((snapshot) => {
    latest = snapshot
  })
  service.handleHookPayload?.(hookPayload('UserPromptSubmit'), NOW)
  service.updateIpcTasks?.([
    { ...authoritativeTask('failed', 'turn-1'), startedAt: 1, updatedAt: NOW + 99 }
  ])
  assert.equal(latest.tasks[0].phase, 'failed')
  assert.equal(latest.tasks[0].startedAt, NOW)
  assert.equal(latest.tasks[0].updatedAt, NOW + 99)
})

test('全屏只提醒审批、回复和失败，前台任务始终抑制', () => {
  const state = new IslandState()
  state.apply({ ...event('turn-finished', 'failed'), outcome: 'failed' })
  const task = state.getSnapshot().tasks[0]
  assert.equal(shouldPresentAlert(task, false, { fullscreen: true }), true)
  assert.equal(
    shouldPresentAlert(task, false, { fullscreen: false, visibleThreadId: task.threadId }),
    false
  )
})

test('停止不新增提醒，完成和失败提醒遵循查看规则', () => {
  const stopped = { ...authoritativeTask('stopped', 'turn-1'), requests: [] }
  assert.equal(shouldPresentAlert(stopped, false, { fullscreen: false }), false)
  assert.equal(shouldPresentAlert(stopped, false, { fullscreen: true }), false)

  const completed = { ...authoritativeTask('completed', 'turn-1'), requests: [] }
  const failed = { ...authoritativeTask('failed', 'turn-1'), requests: [] }
  assert.equal(shouldPresentAlert(completed, false, { fullscreen: false }), true)
  assert.equal(shouldPresentAlert(failed, false, { fullscreen: false }), true)
  assert.equal(shouldPresentAlert(completed, true, { fullscreen: false }), false)
  assert.equal(shouldPresentAlert(failed, true, { fullscreen: false }), false)
})

test('审批和回复查看只标记已读，不改变待处理状态', () => {
  let latest
  const service = activityService((snapshot) => {
    latest = snapshot
  })
  service.handleHookPayload?.(
    {
      ...hookPayload('PermissionRequest'),
      tool_name: 'Bash',
      tool_use_id: 'request-1'
    },
    NOW
  )
  const approval = latest.tasks[0].requests[0]
  assert.equal(approval.kind, 'approval')
  service.markViewed(latest.tasks[0].latestEventId)
  assert.equal(getDisplayStatus(latest.tasks[0]), 'waiting-approval')
  assert.deepEqual(latest.viewedEventIds, [latest.tasks[0].latestEventId])
})
test('提醒暂停后只等待剩余时长', () => {
  const clock = new FakeClock(NOW)
  let elapsed = 0
  const reminder = new PausableReminder(5_000, () => elapsed++, clock)
  reminder.start()
  clock.advance(2_000)
  reminder.pause()
  clock.advance(10_000)
  assert.equal(elapsed, 0)
  reminder.start()
  clock.advance(2_999)
  assert.equal(elapsed, 0)
  clock.advance(1)
  assert.equal(elapsed, 1)
})

test('Hook 只投影必要字段，权限请求不保留工具输入', () => {
  const payload = parseCodexHookPayload({
    hook_event_name: 'PermissionRequest',
    session_id: 'thread-1',
    turn_id: 'turn-1',
    cwd: 'F:\\WorkSpace\\codex-status-line',
    tool_name: 'Bash',
    tool_use_id: 'tool-1',
    tool_input: { command: 'secret command' }
  })
  assert.ok(payload)
  const mapped = mapCodexHookEvent(payload, NOW)
  assert.equal(mapped?.kind, 'request-opened')
  assert.equal(mapped?.project, 'codex-status-line')
  assert.equal(JSON.stringify(mapped).includes('secret command'), false)
})

test('PreToolUse 解决同一工具的 Hook 审批请求', () => {
  const mapped = mapCodexHookEvent({ ...hookPayload('PreToolUse'), tool_use_id: 'tool-1' }, NOW)
  assert.equal(mapped?.kind, 'request-resolved')
  assert.equal(mapped?.requestId, 'tool-1')
})

test('旧配置默认关闭灵动岛并规范化独立设置', () => {
  assert.deepEqual(normalizeIslandPreferences(undefined), { enabled: false })
  assert.deepEqual(normalizeIslandPreferences({ enabled: true, alertDurationSeconds: 99 }), {
    enabled: true
  })
})

function event(kind, eventId, occurredAt = NOW) {
  return {
    kind,
    eventId,
    hostId: 'local',
    threadId: 'thread-1',
    turnId: 'turn-1',
    occurredAt,
    title: '测试任务',
    project: 'project'
  }
}

function authoritativeTask(phase, turnId) {
  return {
    hostId: 'local',
    threadId: 'thread-1',
    turnId,
    title: '任务',
    project: 'project',
    phase,
    startedAt: NOW,
    updatedAt: NOW,
    requests: [],
    latestEventId: `ipc:${phase}`
  }
}

function activityService(onSnapshot) {
  return new CodexActivityService({ cwd: '.', descriptorPath: 'unused', onSnapshot })
}

function hookPayload(hookEventName) {
  return {
    hook_event_name: hookEventName,
    session_id: 'thread-1',
    turn_id: 'turn-1',
    cwd: 'F:\\WorkSpace\\codex-status-line'
  }
}

class FakeClock {
  constructor(now) {
    this.time = now
    this.timers = []
  }
  now = () => this.time
  setTimeout = (callback, delayMs) => {
    const timer = { callback, dueAt: this.time + delayMs, cleared: false }
    this.timers.push(timer)
    return timer
  }
  clearTimeout = (timer) => {
    timer.cleared = true
  }
  advance(delayMs) {
    this.time += delayMs
    for (const timer of this.timers.filter((item) => !item.cleared && item.dueAt <= this.time)) {
      timer.cleared = true
      timer.callback()
    }
  }
}
