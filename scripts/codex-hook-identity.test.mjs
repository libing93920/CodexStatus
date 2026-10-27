/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CodexActivityService } from '../src/main/services/codex-activity.ts'

// 单测不能向正在运行的应用写诊断日志。
process.env.CODEX_STATUS_DIAG = '0'

const PARENT_ID = 'parent-thread'
const CHILD_ID = 'child-thread'
const PARENT_TURN = 'parent-turn'
const CHILD_TURN = 'child-turn'
const PARENT_KEY = `local\u0000${PARENT_ID}`
const NOW = 1_000
const HOOK_STEP_MS = 10
const APPROVAL = { id: 'parent-approval', kind: 'approval', createdAt: NOW }
const SUBAGENT_METADATA = {
  id: CHILD_ID,
  session_id: PARENT_ID,
  source: { subagent: { thread_spawn: { parent_thread_id: PARENT_ID } } },
  thread_source: 'subagent'
}

for (const channel of ['Stop', 'IPC']) {
  test(`父身份已缓存时子代理生命周期不污染父任务，父 ${channel} 仍能完成`, async (context) => {
    const fixture = await createFixture(context)
    startParent(fixture)
    const before = parentEvidence(fixture)
    for (const [index, event] of ['UserPromptSubmit', 'Stop', 'Interrupt'].entries()) {
      childHook(fixture, event, NOW + HOOK_STEP_MS * (index + 1))
      assert.deepEqual(parentEvidence(fixture), before)
    }
    assert.equal(fixture.calls.follow.includes(CHILD_ID), false)

    if (channel === 'Stop') parentHook(fixture, 'Stop', NOW + HOOK_STEP_MS * 4)
    else fixture.service.updateIpcTasks([parentTask('completed')])
    const task = fixture.service.getSnapshot().tasks[0]
    assert.equal(task.turnId, PARENT_TURN)
    assert.equal(task.phase, 'completed')
    assert.deepEqual(task.requests, [])
    assert.equal(fixture.service.dismissTask(PARENT_ID), true)
    childHook(fixture, 'UserPromptSubmit', NOW + HOOK_STEP_MS * 5)
    assert.equal(fixture.service.getSnapshot().tasks.length, 0)
  })
}

test('子代理 Hook 先到也不能撤销或退订目录已准入的父聊天', async (context) => {
  const fixture = await createFixture(context)
  fixture.service.updateIpcTasks([parentTask('running')])
  const before = parentEvidence(fixture)
  childHook(fixture, 'UserPromptSubmit', NOW + HOOK_STEP_MS)
  assert.deepEqual(parentEvidence(fixture), before)

  parentHook(fixture, 'UserPromptSubmit', NOW + HOOK_STEP_MS * 2)
  parentHook(fixture, 'Stop', NOW + HOOK_STEP_MS * 3)
  assert.equal(fixture.service.getSnapshot().tasks[0].phase, 'completed')
})

for (const unreadable of ['missing', 'partial']) {
  test(`子 transcript ${unreadable} 时不能借父缓存放行，读盘恢复后仍隔离`, async (context) => {
    const fixture = await createFixture(context, { childReady: false })
    if (unreadable === 'partial') await fs.writeFile(fixture.childPath, '{')
    startParent(fixture)
    const before = parentEvidence(fixture)
    childHook(fixture, 'UserPromptSubmit', NOW + HOOK_STEP_MS)
    assert.deepEqual(parentEvidence(fixture), before)
    assert.equal(fixture.retries.length, 1)

    await writeTranscript(fixture.childPath, SUBAGENT_METADATA)
    fixture.retries[0]()
    assert.deepEqual(parentEvidence(fixture), before)
    assert.equal(fixture.retries.length, 1)
    parentHook(fixture, 'Stop', NOW + HOOK_STEP_MS * 2)
    assert.equal(fixture.service.getSnapshot().tasks[0].phase, 'completed')
  })
}

test('未确认 transcript 的最后一次重试也不能撤销父任务', async (context) => {
  const fixture = await createFixture(context, { childReady: false })
  startParent(fixture)
  const before = parentEvidence(fixture)
  childHook(fixture, 'UserPromptSubmit', NOW + HOOK_STEP_MS)
  assert.equal(fixture.retries.length, 1)
  fixture.retries[0]()
  assert.deepEqual(parentEvidence(fixture), before)
  assert.equal(fixture.retries.length, 1)
})

test('同一父 transcript 仍复用缓存，不因文件暂不可读而丢失结束事件', async (context) => {
  const fixture = await createFixture(context)
  startParent(fixture)
  await fs.unlink(fixture.parentPath)
  parentHook(fixture, 'UserPromptSubmit', NOW + HOOK_STEP_MS)
  parentHook(fixture, 'Stop', NOW + HOOK_STEP_MS * 2)
  assert.equal(fixture.service.getSnapshot().tasks[0].phase, 'completed')
  assert.equal(fixture.retries.length, 0)
})

test('共享 session_id 的已准入 fork 使用元数据自身 id，不覆盖父聊天', async (context) => {
  const fixture = await createFixture(context)
  await writeTranscript(fixture.childPath, {
    id: CHILD_ID,
    session_id: PARENT_ID,
    source: 'vscode',
    thread_source: 'agent_forked_thread'
  })
  startParent(fixture)
  const before = fixture.service.getSnapshot().tasks.find((task) => task.threadId === PARENT_ID)
  childHook(fixture, 'UserPromptSubmit', NOW + HOOK_STEP_MS)
  const tasks = fixture.service.getSnapshot().tasks
  assert.equal(tasks.length, 2)
  assert.deepEqual(
    tasks.find((task) => task.threadId === PARENT_ID),
    before
  )
  assert.equal(tasks.find((task) => task.threadId === CHILD_ID).turnId, CHILD_TURN)
  assert.ok(fixture.calls.follow.includes(CHILD_ID))
  childHook(fixture, 'Stop', NOW + HOOK_STEP_MS * 2)
  assert.equal(
    fixture.service.getSnapshot().tasks.find((task) => task.threadId === PARENT_ID).phase,
    'running'
  )
  assert.equal(
    fixture.service.getSnapshot().tasks.find((task) => task.threadId === CHILD_ID).phase,
    'completed'
  )
})

async function createFixture(context, options = {}) {
  const directory = await fs.mkdtemp(
    path.join(process.env.PI_SCRATCH_DIR ?? os.tmpdir(), 'codex-hook-identity-')
  )
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const parentPath = path.join(directory, 'parent.jsonl')
  const childPath = path.join(directory, 'child.jsonl')
  await writeTranscript(parentPath, {
    id: PARENT_ID,
    session_id: PARENT_ID,
    source: 'vscode',
    thread_source: 'user'
  })
  if (options.childReady !== false) await writeTranscript(childPath, SUBAGENT_METADATA)
  const service = new CodexActivityService({
    cwd: directory,
    descriptorPath: path.join(directory, 'unused-endpoint.json'),
    emitDebounceMs: 0,
    onSnapshot: () => undefined
  })
  const calls = { follow: [], unfollow: [] }
  const retries = []
  service.registerCatalog([{ id: PARENT_ID, source: 'vscode' }])
  service.ipc = {
    followThread: (id) => calls.follow.push(id),
    unfollowThread: (id) => calls.unfollow.push(id),
    getTerminalTask: () => undefined
  }
  service.scheduleHookRetry = (callback) => retries.push(callback)
  return { service, parentPath, childPath, calls, retries }
}

function writeTranscript(file, payload) {
  return fs.writeFile(file, `${JSON.stringify({ type: 'session_meta', payload })}\n`)
}

function parentHook(fixture, event, at) {
  fixture.service.handleHookPayload(
    {
      hook_event_name: event,
      session_id: PARENT_ID,
      turn_id: PARENT_TURN,
      transcript_path: fixture.parentPath
    },
    at
  )
}

function childHook(fixture, event, at) {
  fixture.service.handleHookPayload(
    {
      hook_event_name: event,
      session_id: PARENT_ID,
      turn_id: CHILD_TURN,
      transcript_path: fixture.childPath
    },
    at
  )
}

function parentTask(phase) {
  return {
    hostId: 'local',
    threadId: PARENT_ID,
    turnId: PARENT_TURN,
    title: '父任务',
    project: 'project',
    phase,
    startedAt: NOW,
    updatedAt: NOW,
    requests: phase === 'running' ? [APPROVAL] : [],
    latestEventId: `ipc:parent:${phase}`
  }
}

function startParent(fixture) {
  parentHook(fixture, 'UserPromptSubmit', NOW)
  fixture.service.updateIpcTasks([parentTask('running')])
}

function parentEvidence({ service, calls }) {
  return {
    snapshot: service.getSnapshot(),
    source: service.threadSources.get(PARENT_KEY),
    turn: service.hookTurnIds.get(PARENT_ID),
    finished: [...service.finishedHookTurnIds].filter((key) =>
      key.startsWith(`${PARENT_ID}\u0000`)
    ),
    retired: [...service.retiredIpcCandidates].filter((key) =>
      key.startsWith(`${PARENT_ID}\u0000`)
    ),
    revoked: service.revokedThreadKeys.has(PARENT_KEY),
    followed: calls.follow.filter((id) => id === PARENT_ID),
    unfollowed: calls.unfollow.filter((id) => id === PARENT_ID)
  }
}
