/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  IslandState,
  PausableReminder,
  normalizeIslandPreferences,
  getDisplayStatus,
  resolveIslandWindowBounds,
  shouldPresentAlert,
  shouldNavigateIslandTask
} from '../src/shared/island.ts'
import {
  mapCodexHookEvent,
  parseCodexHookPayload,
  readCodexTranscriptSource
} from '../src/main/services/codex-hook-events.ts'
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
    emitDebounceMs: 0,
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
    emitDebounceMs: 0,
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
    emitDebounceMs: 0,
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

test('CLI 任务不订阅或合并私有 IPC，未知来源仍跟踪', () => {
  let latest
  const service = activityService((snapshot) => {
    latest = snapshot
  })
  const followed = []
  service.ipc = { followThread: (threadId) => followed.push(threadId) }
  service.threadSources?.set('local\u0000thread-1', 'cli')
  service.handleHookPayload?.(hookPayload('UserPromptSubmit'), NOW)
  assert.deepEqual(followed, [])

  service.updateIpcTasks?.([
    {
      ...authoritativeTask('failed', 'turn-1'),
      source: 'cli',
      requests: [{ id: 'input-1', kind: 'input', summary: '不要合并', createdAt: NOW }]
    }
  ])
  assert.equal(latest.tasks[0].phase, 'running')
  assert.equal(getDisplayStatus(latest.tasks[0]), 'running')

  service.threadSources?.set('local\u0000cli-only', 'cli')
  service.updateIpcTasks?.([
    { ...authoritativeTask('running', 'turn-1'), threadId: 'cli-only', source: 'cli' }
  ])
  assert.equal(
    latest.tasks.some((task) => task.threadId === 'cli-only'),
    false
  )

  service.threadSources?.set('local\u0000unknown-thread', 'unknown')
  service.handleHookPayload?.(
    { ...hookPayload('UserPromptSubmit'), session_id: 'unknown-thread' },
    NOW + 1
  )
  assert.deepEqual(followed, ['unknown-thread'])
  assert.equal(latest.tasks.find((task) => task.threadId === 'unknown-thread')?.source, 'unknown')
})

test('子代理 transcript 被识别并在 Hook 进入状态机前忽略', async (context) => {
  const variants = [{ thread_source: 'subagent' }, { source: { subagent: { thread_spawn: {} } } }]

  for (const [index, metadata] of variants.entries()) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), `codex-status-subagent-${index}-`))
    const transcriptPath = path.join(directory, 'session.jsonl')
    const sessionId = `subagent-thread-${index}`
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({ type: 'session_meta', payload: metadata })}\n`
    )
    context.after(() => fs.rm(directory, { recursive: true, force: true }))

    assert.equal(readCodexTranscriptSource(transcriptPath), 'subagent')
    const service = activityService(() => undefined)
    const followed = []
    service.ipc = { followThread: (threadId) => followed.push(threadId) }
    service.handleHookPayload?.(
      parseCodexHookPayload({
        ...hookPayload('UserPromptSubmit'),
        session_id: sessionId,
        transcript_path: transcriptPath
      }),
      NOW
    )

    assert.deepEqual(followed, [])
    assert.equal(service.getSnapshot().tasks.length, 0)
    assert.equal(service.hookTaskKeys?.has(`local\u0000${sessionId}`), false)
  }
})

test('transcript 尚未可读时首个子代理 Hook 延迟重放后仍忽略', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-status-subagent-race-'))
  const transcriptPath = path.join(directory, 'session.jsonl')
  const sessionId = 'subagent-race-thread'
  const payload = {
    ...hookPayload('UserPromptSubmit'),
    session_id: sessionId,
    transcript_path: transcriptPath
  }
  const key = `local\u0000${sessionId}`
  context.after(() => fs.rm(directory, { recursive: true, force: true }))

  const service = activityService(() => undefined)
  const retries = []
  service.scheduleHookRetry = (callback) => retries.push(callback)
  const followed = []
  service.ipc = { followThread: (threadId) => followed.push(threadId) }
  service.handleHookPayload?.(payload, NOW)
  assert.equal(retries.length, 1)
  assert.deepEqual(followed, [])
  assert.equal(service.getSnapshot().tasks.length, 0)
  assert.equal(service.hookTaskKeys?.has(key), false)

  await fs.writeFile(
    transcriptPath,
    `${JSON.stringify({ type: 'session_meta', payload: { thread_source: 'subagent' } })}\n`
  )
  retries[0]()

  assert.deepEqual(followed, [])
  assert.equal(service.getSnapshot().tasks.length, 0)
  assert.equal(service.hookTaskKeys?.has(key), false)
})

test('transcript 重试仍不可读时同一 Hook 按 unknown 处理且不再次调度', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-status-unknown-race-'))
  const transcriptPath = path.join(directory, 'session.jsonl')
  const sessionId = 'unknown-race-thread'
  const payload = {
    ...hookPayload('UserPromptSubmit'),
    session_id: sessionId,
    transcript_path: transcriptPath
  }
  context.after(() => fs.rm(directory, { recursive: true, force: true }))

  const service = activityService(() => undefined)
  const retries = []
  service.scheduleHookRetry = (callback) => retries.push(callback)
  const followed = []
  service.ipc = { followThread: (threadId) => followed.push(threadId) }
  service.handleHookPayload?.(payload, NOW)
  assert.equal(retries.length, 1)
  assert.equal(service.getSnapshot().tasks.length, 0)

  retries[0]()

  assert.equal(retries.length, 1)
  assert.deepEqual(followed, [sessionId])
  assert.equal(service.getSnapshot().tasks[0]?.threadId, sessionId)
  assert.equal(service.getSnapshot().tasks[0]?.source, undefined)
})

test('transcript 重试回调在服务停止后不再处理 Hook', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-status-stop-race-'))
  const transcriptPath = path.join(directory, 'session.jsonl')
  const sessionId = 'stopped-race-thread'
  const payload = {
    ...hookPayload('UserPromptSubmit'),
    session_id: sessionId,
    transcript_path: transcriptPath
  }
  const key = `local\u0000${sessionId}`
  context.after(() => fs.rm(directory, { recursive: true, force: true }))

  const service = activityService(() => undefined)
  const retries = []
  service.scheduleHookRetry = (callback) => retries.push(callback)
  const followed = []
  service.ipc = {
    followThread: (threadId) => followed.push(threadId),
    stop: () => undefined
  }
  service.handleHookPayload?.(payload, NOW)
  assert.equal(retries.length, 1)

  await service.stop()
  retries[0]()

  assert.deepEqual(followed, [])
  assert.equal(service.getSnapshot().tasks.length, 0)
  assert.equal(service.hookTaskKeys?.has(key), false)
})

test('目录中的 CLI 任务不进入私有 IPC 初始订阅', async () => {
  const source = await fs.readFile(
    new URL('../src/main/services/codex-activity.ts', import.meta.url),
    'utf8'
  )
  const start = source.indexOf('async start()')
  const end = source.indexOf('\n  async stop()', start)
  assert.ok(start >= 0)
  assert.ok(end > start)
  assert.match(
    source.slice(start, end),
    /for \(const entry of catalog\) \{\s*this\.threadSources\.set\(createTaskKey\('local', entry\.id\), entry\.source\)\s*if \(entry\.source !== 'cli'\) threadIds\.push\(entry\.id\)/
  )
})

test('新 Hook 线程从 transcript 首行识别 CLI 来源', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-status-transcript-'))
  const transcriptPath = path.join(directory, 'session.jsonl')
  await fs.writeFile(
    transcriptPath,
    `${JSON.stringify({ type: 'session_meta', payload: { source: 'cli' } })}\n` +
      `${JSON.stringify({ type: 'response', payload: { secret: 'must not read' } })}\n`
  )
  context.after(() => fs.rm(directory, { recursive: true, force: true }))

  const service = activityService(() => undefined)
  const payload = parseCodexHookPayload({
    ...hookPayload('UserPromptSubmit'),
    transcript_path: transcriptPath
  })
  assert.equal(payload?.transcript_path, transcriptPath)
  service.handleHookPayload?.(payload, NOW)

  assert.equal(service.getSnapshot().tasks[0].source, 'cli')
})

test('可解析但没有来源的 transcript 稳定缓存为 unknown', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-status-transcript-unknown-'))
  const transcriptPath = path.join(directory, 'session.jsonl')
  await fs.writeFile(transcriptPath, `${JSON.stringify({ type: 'response', payload: {} })}\n`)
  context.after(() => fs.rm(directory, { recursive: true, force: true }))

  assert.equal(readCodexTranscriptSource(transcriptPath), 'unknown')
  const service = activityService(() => undefined)
  const payload = {
    ...hookPayload('SessionStart'),
    session_id: 'unknown-source',
    transcript_path: transcriptPath
  }
  assert.equal(service.resolveHookSource?.(payload), 'unknown')
  await fs.unlink(transcriptPath)
  assert.equal(service.resolveHookSource?.(payload), 'unknown')
})

test('Hook 来源临时读盘失败在冷却后重试并恢复', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-status-transcript-retry-'))
  const transcriptPath = path.join(directory, 'session.jsonl')
  await fs.writeFile(transcriptPath, '{')
  context.after(() => fs.rm(directory, { recursive: true, force: true }))

  const service = activityService(() => undefined)
  const payload = {
    ...hookPayload('SessionStart'),
    session_id: 'retry-source',
    transcript_path: transcriptPath
  }
  const key = 'local\u0000retry-source'
  assert.equal(service.resolveHookSource?.(payload), undefined)
  assert.ok(service.hookSourceRetryAt?.get(key) > Date.now())

  await fs.writeFile(
    transcriptPath,
    `${JSON.stringify({ type: 'session_meta', payload: { source: 'cli' } })}\n`
  )
  service.hookSourceRetryAt?.set(key, Date.now() + 60_000)
  assert.equal(service.resolveHookSource?.(payload), undefined)
  service.hookSourceRetryAt?.set(key, 0)
  assert.equal(service.resolveHookSource?.(payload), 'cli')
  assert.equal(service.hookSourceRetryAt?.has(key), false)
})

test('transcript 延迟识别后普通 CLI/VSCode Hook 可恢复', async (context) => {
  for (const source of ['cli', 'vscode']) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), `codex-status-${source}-race-`))
    const transcriptPath = path.join(directory, 'session.jsonl')
    const sessionId = `${source}-race-thread`
    const payload = {
      ...hookPayload('UserPromptSubmit'),
      session_id: sessionId,
      transcript_path: transcriptPath
    }
    context.after(() => fs.rm(directory, { recursive: true, force: true }))

    const service = activityService(() => undefined)
    const retries = []
    service.scheduleHookRetry = (callback) => retries.push(callback)
    const followed = []
    service.ipc = { followThread: (threadId) => followed.push(threadId) }
    service.handleHookPayload?.(payload, NOW)
    assert.equal(retries.length, 1)
    assert.equal(service.getSnapshot().tasks.length, 0)

    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({ type: 'session_meta', payload: { source } })}\n`
    )
    retries[0]()

    assert.equal(service.getSnapshot().tasks[0]?.source, source)
    assert.deepEqual(followed, source === 'vscode' ? [sessionId] : [])
  }
})

test('灵动岛点击仅排除 CLI 和子代理来源', () => {
  assert.equal(shouldNavigateIslandTask('cli'), false)
  assert.equal(shouldNavigateIslandTask('vscode'), true)
  assert.equal(shouldNavigateIslandTask('subagent'), false)
  assert.equal(shouldNavigateIslandTask('unknown'), true)
  assert.equal(shouldNavigateIslandTask(undefined), true)
})

test('灵动岛点击在导航分支之后统一记录已查看', async () => {
  const source = await fs.readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const start = source.indexOf('ipcMain.handle(CHANNELS.islandOpenTask')
  const end = source.indexOf('ipcMain.handle(CHANNELS.islandDismissTask', start)
  assert.ok(start >= 0)
  assert.ok(end > start)
  const handler = source.slice(start, end)
  assert.match(
    handler,
    /if \(shouldNavigateIslandTask\(task\.source\)\) \{\s*await shell\.openExternal\(`codex:\/\/threads\/\$\{encodeURIComponent\(threadId\)\}`\)\s*\}\s*codexActivity\?\.markViewed\(/
  )
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
  return new CodexActivityService({
    cwd: '.',
    descriptorPath: 'unused',
    onSnapshot,
    // 测试断言同步读取最新快照,关闭 emit debounce
    emitDebounceMs: 0
  })
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
