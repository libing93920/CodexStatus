/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RETRY_DELAYS_MS,
  WINDOW_KEEPER_MAX_RETRY_DURATION_MS,
  WINDOW_KEEPER_TRIGGER_BUFFER_MS,
  WindowKeeper,
  calculateWindowKeeperPlan
} from '../src/main/services/window-keeper.ts'

const BASE_NOW = Date.parse('2026-09-04T00:00:00.000Z')

class FakeClock {
  constructor(nowMs) {
    this.nowMs = nowMs
    this.nextId = 1
    this.timers = []
  }

  setTimeout(callback, delayMs) {
    const timer = {
      id: this.nextId++,
      dueAt: this.nowMs + delayMs,
      callback,
      cleared: false
    }
    this.timers.push(timer)
    return timer
  }

  clearTimeout(timer) {
    if (timer) {
      timer.cleared = true
    }
  }

  advance(delayMs) {
    this.nowMs += delayMs
    let dueTimer
    do {
      dueTimer = this.timers
        .filter((timer) => !timer.cleared && timer.dueAt <= this.nowMs)
        .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0]
      if (dueTimer) {
        dueTimer.cleared = true
        dueTimer.callback()
      }
    } while (dueTimer)
  }

  activeTimers() {
    return this.timers.filter((timer) => !timer.cleared)
  }
}

function fiveHourWindow({ resetAt, usedPercent = 0 } = {}) {
  return {
    id: 'primary',
    label: '5h',
    windowMinutes: 300,
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetsAt: resetAt,
    observedAt: new Date(BASE_NOW).toISOString()
  }
}

function weeklyWindow() {
  return {
    id: 'secondary',
    label: '7d',
    windowMinutes: 10080,
    usedPercent: 20,
    remainingPercent: 80,
    resetsAt: new Date(BASE_NOW + 7 * 24 * 60 * 60 * 1000).toISOString(),
    observedAt: new Date(BASE_NOW).toISOString()
  }
}

function usageSnapshot({ authMode = 'chatgpt', rateLimits = [] } = {}) {
  return {
    available: rateLimits.length > 0,
    isRefreshing: false,
    canRefresh: true,
    authMode,
    generatedAt: new Date(BASE_NOW).toISOString(),
    rateLimits,
    rateLimitSource: 'official',
    sourceHost: 'chatgpt.com',
    issues: [],
    filesScanned: 0
  }
}

function createRunner(outcomes = []) {
  const calls = []
  return {
    calls,
    run: async (request, signal) => {
      calls.push({ request, signal })
      const outcome = outcomes[calls.length - 1] ?? outcomes.at(-1)
      if (outcome instanceof Error) {
        throw outcome
      }
    }
  }
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
}

function createKeeper({ clock, runner, persisted, onRefresh, onExhausted } = {}) {
  const effectiveClock = clock ?? new FakeClock(BASE_NOW)
  const statuses = []
  const persistedChanges = []
  const keeper = new WindowKeeper({
    enabled: true,
    now: () => effectiveClock.nowMs,
    setTimeout: (callback, delayMs) => effectiveClock.setTimeout(callback, delayMs),
    clearTimeout: (timer) => effectiveClock.clearTimeout(timer),
    runner: runner ?? createRunner(),
    persisted,
    onRefresh: onRefresh ?? (async () => {}),
    onStatusChange: (status) => statuses.push(status),
    onPersistenceChange: (state) => persistedChanges.push(state),
    onExhausted
  })
  return { clock: effectiveClock, keeper, persistedChanges, statuses }
}

test('初始空快照等待额度数据而不是等待 5h 窗口', () => {
  const snapshot = usageSnapshot()
  delete snapshot.generatedAt

  const plan = calculateWindowKeeperPlan(snapshot, BASE_NOW, undefined)

  assert.equal(plan.kind, 'wait-data')
})

test('reset_at 未到时计算 reset_at 加 10 秒的等待时间', () => {
  const resetAtMs = BASE_NOW + 60_000
  const plan = calculateWindowKeeperPlan(
    usageSnapshot({
      rateLimits: [fiveHourWindow({ resetAt: new Date(resetAtMs).toISOString(), usedPercent: 20 })]
    }),
    BASE_NOW,
    undefined
  )

  assert.equal(plan.kind, 'wait-reset')
  assert.equal(plan.delayMs, 70_000)
  assert.equal(plan.triggerAtMs, resetAtMs + WINDOW_KEEPER_TRIGGER_BUFFER_MS)
})

test('reset_at 已过且窗口无使用记录时等待 10 秒后触发', async () => {
  const resetAtMs = BASE_NOW - 1_000
  const runner = createRunner([undefined])
  const { clock, keeper } = createKeeper({ runner })
  keeper.updateSnapshot(
    usageSnapshot({
      rateLimits: [fiveHourWindow({ resetAt: new Date(resetAtMs).toISOString(), usedPercent: 0 })]
    })
  )

  assert.equal(runner.calls.length, 0)
  clock.advance(WINDOW_KEEPER_TRIGGER_BUFFER_MS - 1)
  await flush()
  assert.equal(runner.calls.length, 0)

  clock.advance(1)
  await flush()
  assert.equal(runner.calls.length, 1)
  assert.equal(runner.calls[0].request.model, 'gpt-5.6-luna')
  assert.equal(runner.calls[0].request.reasoningEffort, 'low')
  assert.equal(runner.calls[0].request.prompt, '6')
})

test('成功触发后记录窗口 identity、成功时间并请求刷新', async () => {
  const resetAt = new Date(BASE_NOW - 1_000).toISOString()
  const runner = createRunner([undefined])
  let refreshCount = 0
  const { clock, keeper, persistedChanges, statuses } = createKeeper({
    runner,
    onRefresh: async () => {
      refreshCount += 1
    }
  })
  keeper.updateSnapshot(
    usageSnapshot({
      rateLimits: [fiveHourWindow({ resetAt, usedPercent: 0 })]
    })
  )

  clock.advance(WINDOW_KEEPER_TRIGGER_BUFFER_MS)
  await flush()
  const persisted = persistedChanges.at(-1)
  assert.deepEqual(persisted, {
    windowId: 'primary',
    resetAt,
    lastTriggeredAt: new Date(clock.nowMs).toISOString()
  })
  assert.equal(refreshCount, 1)
  assert.equal(statuses.at(-1).lastTriggeredAt, persisted.lastTriggeredAt)
})

test('reset_at 已过但窗口已有使用记录时跳过', async () => {
  const runner = createRunner()
  const { clock, keeper } = createKeeper({ runner })
  keeper.updateSnapshot(
    usageSnapshot({
      rateLimits: [
        fiveHourWindow({
          resetAt: new Date(BASE_NOW - 1_000).toISOString(),
          usedPercent: 1
        })
      ]
    })
  )

  clock.advance(WINDOW_KEEPER_TRIGGER_BUFFER_MS + 1)
  await flush()
  assert.equal(runner.calls.length, 0)
  assert.equal(clock.activeTimers().length, 0)
})

test('5h 窗口不存在时不触发', async () => {
  const runner = createRunner()
  const { clock, keeper } = createKeeper({ runner })
  keeper.updateSnapshot(usageSnapshot({ rateLimits: [weeklyWindow()] }))

  clock.advance(8 * 24 * 60 * 60 * 1000)
  await flush()
  assert.equal(runner.calls.length, 0)
})

test('API Key 模式不触发', async () => {
  const runner = createRunner()
  const { clock, keeper } = createKeeper({ runner })
  keeper.updateSnapshot(
    usageSnapshot({
      authMode: 'api',
      rateLimits: [
        fiveHourWindow({
          resetAt: new Date(BASE_NOW - 1_000).toISOString(),
          usedPercent: 0
        })
      ]
    })
  )

  clock.advance(WINDOW_KEEPER_TRIGGER_BUFFER_MS + 1)
  await flush()
  assert.equal(runner.calls.length, 0)
})

test('重试退避序列为 30、60、120、240、480 秒', () => {
  assert.deepEqual(RETRY_DELAYS_MS, [30_000, 60_000, 120_000, 240_000, 480_000])
})

test('单次 reset 事件在 10 分钟后结束重试并进入异常', async () => {
  const runner = createRunner([
    new Error('first'),
    new Error('second'),
    new Error('third'),
    new Error('fourth'),
    new Error('fifth')
  ])
  let exhaustedCount = 0
  const { clock, keeper, statuses } = createKeeper({
    runner,
    onExhausted: () => {
      exhaustedCount += 1
    }
  })
  keeper.updateSnapshot(
    usageSnapshot({
      rateLimits: [
        fiveHourWindow({
          resetAt: new Date(BASE_NOW - 1_000).toISOString(),
          usedPercent: 0
        })
      ]
    })
  )

  clock.advance(WINDOW_KEEPER_TRIGGER_BUFFER_MS)
  await flush()
  for (const delayMs of RETRY_DELAYS_MS.slice(0, 4)) {
    clock.advance(delayMs)
    await flush()
  }

  assert.equal(runner.calls.length, 5)
  assert.equal(statuses.at(-1).state, 'retrying')
  const remainingMs = WINDOW_KEEPER_MAX_RETRY_DURATION_MS - 450_000
  clock.advance(remainingMs - 1)
  await flush()
  assert.equal(statuses.at(-1).state, 'retrying')

  clock.advance(1)
  await flush()
  assert.equal(statuses.at(-1).state, 'error')
  assert.equal(runner.calls.length, 5)
  assert.equal(exhaustedCount, 1)

  clock.advance(10 * 60 * 1000)
  await flush()
  assert.equal(exhaustedCount, 1)
})

test('初始等待 timer 延迟到重试截止后会进入异常', async () => {
  const resetAt = new Date(BASE_NOW + 60_000).toISOString()
  const runner = createRunner()
  const { clock, keeper, statuses } = createKeeper({ runner })
  keeper.updateSnapshot(
    usageSnapshot({
      rateLimits: [fiveHourWindow({ resetAt, usedPercent: 0 })]
    })
  )

  clock.advance(70_000 + WINDOW_KEEPER_MAX_RETRY_DURATION_MS + 1)
  await flush()

  assert.equal(runner.calls.length, 0)
  assert.equal(statuses.at(-1).state, 'error')
})

test('同一 reset 事件后续刷新不会清除异常状态', async () => {
  const resetAt = new Date(BASE_NOW - 1_000).toISOString()
  const snapshot = usageSnapshot({
    rateLimits: [fiveHourWindow({ resetAt, usedPercent: 0 })]
  })
  const runner = createRunner([
    new Error('first'),
    new Error('second'),
    new Error('third'),
    new Error('fourth'),
    new Error('fifth')
  ])
  const { clock, keeper, statuses } = createKeeper({ runner })
  keeper.updateSnapshot(snapshot)

  clock.advance(WINDOW_KEEPER_TRIGGER_BUFFER_MS)
  await flush()
  for (const delayMs of RETRY_DELAYS_MS.slice(0, 4)) {
    clock.advance(delayMs)
    await flush()
  }
  clock.advance(WINDOW_KEEPER_MAX_RETRY_DURATION_MS - 450_000)
  await flush()
  assert.equal(statuses.at(-1).state, 'error')

  keeper.updateSnapshot(snapshot)
  assert.equal(statuses.at(-1).state, 'error')
  assert.equal(statuses.at(-1).recentError, 'fifth')
})

test('关闭开关时取消调度', async () => {
  const runner = createRunner()
  const { clock, keeper, statuses } = createKeeper({ runner })
  keeper.updateSnapshot(
    usageSnapshot({
      rateLimits: [
        fiveHourWindow({
          resetAt: new Date(BASE_NOW + 60_000).toISOString(),
          usedPercent: 0
        })
      ]
    })
  )

  assert.equal(clock.activeTimers().length, 1)
  keeper.setEnabled(false)
  clock.advance(10 * 60 * 1000)
  await flush()
  assert.equal(runner.calls.length, 0)
  assert.equal(clock.activeTimers().length, 0)
  assert.equal(statuses.at(-1).state, 'disabled')
})

test('重复设置相同开关值时不重置当前调度', () => {
  const runner = createRunner()
  const { clock, keeper } = createKeeper({ runner })
  keeper.updateSnapshot(
    usageSnapshot({
      rateLimits: [
        fiveHourWindow({
          resetAt: new Date(BASE_NOW + 60_000).toISOString(),
          usedPercent: 0
        })
      ]
    })
  )

  const firstTimer = clock.activeTimers()[0]
  keeper.setEnabled(true)
  assert.equal(clock.activeTimers().length, 1)
  assert.equal(clock.activeTimers()[0], firstTimer)
})

test('应用重启后同一 reset_at 和窗口 identity 不重复触发', async () => {
  const resetAt = new Date(BASE_NOW - 1_000).toISOString()
  const runner = createRunner()
  const { clock, keeper } = createKeeper({
    runner,
    persisted: {
      windowId: 'primary',
      resetAt,
      lastTriggeredAt: new Date(BASE_NOW - 500).toISOString()
    }
  })
  keeper.updateSnapshot(
    usageSnapshot({
      rateLimits: [fiveHourWindow({ resetAt, usedPercent: 0 })]
    })
  )

  clock.advance(WINDOW_KEEPER_TRIGGER_BUFFER_MS + 1)
  await flush()
  assert.equal(runner.calls.length, 0)
})

test('API 模式暂不可用后恢复到 ChatGPT 时仍会调度同一窗口', async () => {
  const resetAt = new Date(BASE_NOW + 60_000).toISOString()
  const runner = createRunner()
  const { clock, keeper } = createKeeper({ runner })
  const rateLimits = [fiveHourWindow({ resetAt, usedPercent: 0 })]

  keeper.updateSnapshot(usageSnapshot({ authMode: 'api', rateLimits }))
  keeper.updateSnapshot(usageSnapshot({ authMode: 'chatgpt', rateLimits }))
  clock.advance(70_000)
  await flush()

  assert.equal(runner.calls.length, 1)
})

test('新快照确认窗口已有使用后取消当前重试流程', async () => {
  const runner = createRunner([new Error('temporary')])
  const { clock, keeper, statuses } = createKeeper({ runner })
  const resetAt = new Date(BASE_NOW - 1_000).toISOString()
  keeper.updateSnapshot(
    usageSnapshot({
      rateLimits: [fiveHourWindow({ resetAt, usedPercent: 0 })]
    })
  )
  clock.advance(WINDOW_KEEPER_TRIGGER_BUFFER_MS)
  await flush()
  assert.equal(statuses.at(-1).state, 'retrying')

  keeper.updateSnapshot(
    usageSnapshot({
      rateLimits: [fiveHourWindow({ resetAt, usedPercent: 2 })]
    })
  )
  clock.advance(10 * 60 * 1000)
  await flush()
  assert.equal(runner.calls.length, 1)
  assert.equal(statuses.at(-1).state, 'waiting-reset')
})

test('关闭开关会取消正在运行的 runner', async () => {
  let aborted = false
  const runner = {
    calls: 0,
    run: async (_request, signal) => {
      runner.calls += 1
      signal.addEventListener('abort', () => {
        aborted = true
      })
      await new Promise(() => {})
    }
  }
  const { clock, keeper } = createKeeper({ runner })
  keeper.updateSnapshot(
    usageSnapshot({
      rateLimits: [
        fiveHourWindow({
          resetAt: new Date(BASE_NOW - 1_000).toISOString(),
          usedPercent: 0
        })
      ]
    })
  )
  clock.advance(WINDOW_KEEPER_TRIGGER_BUFFER_MS)
  await flush()
  keeper.setEnabled(false)
  assert.equal(runner.calls, 1)
  assert.equal(aborted, true)
})

test('runner 超时后进入重试而不是被当作取消', async () => {
  let aborted = false
  const runner = {
    calls: 0,
    run: async (_request, signal) => {
      runner.calls += 1
      signal.addEventListener('abort', () => {
        aborted = true
      })
      await new Promise(() => {})
    }
  }
  const { clock, keeper, statuses } = createKeeper({ runner })
  keeper.updateSnapshot(
    usageSnapshot({
      rateLimits: [
        fiveHourWindow({
          resetAt: new Date(BASE_NOW - 1_000).toISOString(),
          usedPercent: 0
        })
      ]
    })
  )

  clock.advance(WINDOW_KEEPER_TRIGGER_BUFFER_MS)
  await flush()
  clock.advance(60_000)
  await flush()
  assert.equal(runner.calls, 1)
  assert.equal(aborted, true)
  assert.equal(statuses.at(-1).state, 'retrying')
  assert.equal(statuses.at(-1).recentError, 'Codex CLI timed out')
})
