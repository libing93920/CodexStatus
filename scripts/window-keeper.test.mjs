/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RETRY_DELAYS_MS,
  WINDOW_KEEPER_MAX_RETRY_DURATION_MS,
  WINDOW_KEEPER_TRIGGER_BUFFER_MS,
  WINDOW_KEEPER_VERIFY_DELAY_MS,
  WindowKeeper,
  calculateWindowKeeperPlan
} from '../src/main/services/window-keeper.ts'
import * as windowKeeperRunner from '../src/main/services/window-keeper-runner.ts'
import {
  DEFAULT_WINDOW_KEEPER_START_TIME,
  getNextWindowKeeperAllowedTime,
  isWindowKeeperStartTime,
  normalizeWindowKeeperStartTime
} from '../src/shared/window-keeper-time.ts'

const BASE_NOW = Date.parse('2026-09-04T00:00:00.000Z')

test('已确认 resetAt 不受使用率和 CLI 完成时间影响', () => {
  const resetAt = new Date(BASE_NOW + 120_000).toISOString()
  const persisted = {
    windowId: 'primary',
    resetAt,
    verified: true,
    lastTriggeredAt: new Date(BASE_NOW - 60_000).toISOString()
  }
  for (const usedPercent of [0, 20, undefined]) {
    const window = { ...fiveHourWindow({ resetAt }), usedPercent }
    const plan = calculateWindowKeeperPlan(
      usageSnapshot({ rateLimits: [window] }),
      BASE_NOW,
      persisted
    )
    assert.equal(plan.kind, 'wait-reset')
    assert.equal(plan.delayMs, 130_000)
  }
})

test('未知未来窗口先观察，稳定时不调用 CLI，不伪造成功记录', async () => {
  const resetAt = new Date(BASE_NOW + 3_600_000).toISOString()
  const snapshot = usageSnapshot({ rateLimits: [fiveHourWindow({ resetAt })] })
  const runner = createRunner()
  const { clock, keeper, persistedChanges } = createKeeper({
    runner,
    onRefresh: async () => snapshot
  })
  keeper.updateSnapshot(snapshot)
  assert.equal(keeper.getStatus().state, 'verifying')
  clock.advance(WINDOW_KEEPER_VERIFY_DELAY_MS)
  await flush()
  assert.equal(runner.calls.length, 0)
  assert.equal(persistedChanges.length, 0)
  assert.equal(
    keeper.getStatus().nextActionAt,
    new Date(Date.parse(resetAt) + 10_000).toISOString()
  )
  keeper.stop()
})
const { selectCodexExecutablePath } = windowKeeperRunner

test('官方改变 resetAt 后稳定则跟随新窗口，不依赖使用率', async () => {
  for (const usedPercent of [0, 20, undefined]) {
    const oldResetAt = new Date(BASE_NOW + 120_000).toISOString()
    const resetAt = new Date(BASE_NOW + 3_600_000).toISOString()
    const snapshot = usageSnapshot({
      rateLimits: [{ ...fiveHourWindow({ resetAt }), usedPercent }]
    })
    const runner = createRunner()
    const { clock, keeper, persistedChanges } = createKeeper({
      runner,
      persisted: { windowId: 'primary', resetAt: oldResetAt, verified: true },
      onRefresh: async () => snapshot
    })
    keeper.updateSnapshot(snapshot)
    clock.advance(WINDOW_KEEPER_VERIFY_DELAY_MS)
    await flush()
    assert.equal(runner.calls.length, 0)
    assert.equal(persistedChanges.length, 0)
    assert.equal(clock.activeTimers()[0].dueAt, Date.parse(resetAt) + 10_000)
    clock.advance(Date.parse(resetAt) + 10_000 - clock.nowMs)
    await flush()
    assert.equal(runner.calls.length, 1)
    keeper.stop()
  }
})

test('观察失败只重试查询，恢复后时间滚动才发送 CLI', async () => {
  const firstResetAt = new Date(BASE_NOW + 3_600_000).toISOString()
  const secondResetAt = new Date(BASE_NOW + 3_660_000).toISOString()
  let refreshCount = 0
  const runner = createRunner()
  const { clock, keeper } = createKeeper({
    runner,
    onRefresh: async () => {
      if (++refreshCount === 1) throw new Error('offline')
      return usageSnapshot({
        rateLimits: [fiveHourWindow({ resetAt: secondResetAt, usedPercent: 20 })]
      })
    }
  })
  keeper.updateSnapshot(
    usageSnapshot({ rateLimits: [fiveHourWindow({ resetAt: firstResetAt, usedPercent: 20 })] })
  )
  clock.advance(WINDOW_KEEPER_VERIFY_DELAY_MS)
  await flush()
  assert.equal(keeper.getStatus().state, 'retrying')
  assert.equal(runner.calls.length, 0)
  clock.advance(RETRY_DELAYS_MS[0])
  await flush()
  assert.equal(runner.calls.length, 0)
  clock.advance(WINDOW_KEEPER_TRIGGER_BUFFER_MS)
  await flush()
  assert.equal(runner.calls.length, 1)
  keeper.stop()
})

test('观察查询返回前关闭功能，不重新创建调度', async () => {
  const resetAt = new Date(BASE_NOW + 3_600_000).toISOString()
  const snapshot = usageSnapshot({ rateLimits: [fiveHourWindow({ resetAt })] })
  let resolveRefresh
  const runner = createRunner()
  const { clock, keeper } = createKeeper({
    runner,
    onRefresh: () =>
      new Promise((resolve) => {
        resolveRefresh = resolve
      })
  })
  keeper.updateSnapshot(snapshot)
  clock.advance(WINDOW_KEEPER_VERIFY_DELAY_MS)
  keeper.setEnabled(false)
  resolveRefresh(snapshot)
  await flush()
  assert.equal(clock.activeTimers().length, 0)
  assert.equal(runner.calls.length, 0)
  assert.equal(keeper.getStatus().state, 'disabled')
})

test('CLI 后重复返回已到期 resetAt 不算成功', async () => {
  const resetAt = new Date(BASE_NOW - 1_000).toISOString()
  const snapshot = usageSnapshot({ rateLimits: [fiveHourWindow({ resetAt })] })
  const { clock, keeper, persistedChanges } = createKeeper({ onRefresh: async () => snapshot })
  keeper.updateSnapshot(snapshot)
  clock.advance(WINDOW_KEEPER_TRIGGER_BUFFER_MS)
  await flush()
  clock.advance(WINDOW_KEEPER_VERIFY_DELAY_MS)
  await flush()
  assert.equal(persistedChanges.length, 0)
  assert.equal(keeper.getStatus().state, 'retrying')
  keeper.stop()
})

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
  return weeklyWindowWith({ usedPercent: 20, remainingPercent: 80 })
}

function weeklyWindowWith({ usedPercent, remainingPercent, resetsAt } = {}) {
  return {
    id: 'secondary',
    label: '7d',
    windowMinutes: 10080,
    usedPercent,
    remainingPercent,
    resetsAt,
    observedAt: new Date(BASE_NOW).toISOString()
  }
}

function usageSnapshot({
  authMode = 'chatgpt',
  rateLimits = [],
  rateLimitSource = 'official'
} = {}) {
  return {
    available: rateLimits.length > 0,
    isRefreshing: false,
    canRefresh: true,
    authMode,
    generatedAt: new Date(BASE_NOW).toISOString(),
    rateLimits,
    rateLimitSource,
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

test('Windows PATH 解析优先 exe，无 exe 时使用 codex.cmd', () => {
  const executable = 'C:\\Users\\libing\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe'
  const commandShim = 'C:\\Users\\libing\\AppData\\Roaming\\npm\\codex.cmd'

  assert.equal(
    selectCodexExecutablePath(
      ['C:\\Users\\libing\\AppData\\Roaming\\npm\\codex', commandShim, executable],
      'win32'
    ),
    executable
  )
  assert.equal(
    selectCodexExecutablePath(
      ['C:\\Users\\libing\\AppData\\Roaming\\npm\\codex', commandShim],
      'win32'
    ),
    commandShim
  )
  assert.equal(
    selectCodexExecutablePath(['C:\\Users\\libing\\AppData\\Roaming\\npm\\codex'], 'win32'),
    undefined
  )
})

test('Window Keeper 使用隔离配置执行官方 codex exec', () => {
  const outputPath = 'C:\\Temp\\window-keeper-output.txt'
  const args = windowKeeperRunner.buildCodexExecArgs(
    {
      model: 'gpt-5.6-luna',
      reasoningEffort: 'low',
      prompt: '6'
    },
    outputPath
  )

  assert.deepEqual(args, [
    'exec',
    '--ignore-user-config',
    '--enable',
    'respect_system_proxy',
    '--ephemeral',
    '--skip-git-repo-check',
    '--model',
    'gpt-5.6-luna',
    '--config',
    'model_reasoning_effort=low',
    '--output-last-message',
    outputPath,
    '6'
  ])
})

test('Window Keeper 直接启动可执行文件并通过 ComSpec 兼容 codex.cmd', () => {
  const args = ['exec', '6']
  assert.deepEqual(
    windowKeeperRunner.buildCodexSpawnCommand('C:\\Codex\\codex.exe', args, 'win32'),
    {
      file: 'C:\\Codex\\codex.exe',
      args
    }
  )
  assert.deepEqual(
    windowKeeperRunner.buildCodexSpawnCommand(
      'C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd',
      args,
      'win32',
      'C:\\Windows\\System32\\cmd.exe'
    ),
    {
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/c', 'C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd', ...args]
    }
  )
})

test('codex exec 退出码为 0 但没有模型回复仍判定失败', () => {
  assert.doesNotThrow(() => windowKeeperRunner.assertCodexExecCompleted(0, '6'))
  assert.throws(
    () => windowKeeperRunner.assertCodexExecCompleted(0, '  '),
    /without a completed model reply/
  )
  assert.throws(() => windowKeeperRunner.assertCodexExecCompleted(1, '6'), /exited with code 1/)
  assert.throws(
    () =>
      windowKeeperRunner.assertCodexExecCompleted(
        1,
        '',
        '\u001b[31mnetwork failed Bearer secret-token\u001b[0m'
      ),
    (error) => {
      assert.match(error.message, /network failed Bearer \[redacted\]/)
      assert.doesNotMatch(error.message, /secret-token/)
      return true
    }
  )
})

test('Window Keeper 不把父 Codex Desktop 内部环境传给子 CLI', () => {
  const env = windowKeeperRunner.buildCodexCliEnvironment({
    PATH: 'C:\\Windows',
    CODEX_HOME: 'C:\\CodexHome',
    CODEX_THREAD_ID: 'parent-thread',
    CODEX_APP_TOOLS_PIPE_PATH: '\\\\.\\pipe\\parent-tools',
    TERM: 'dumb'
  })

  assert.equal(env.PATH, 'C:\\Windows')
  assert.equal(env.CODEX_HOME, 'C:\\CodexHome')
  assert.equal(env.CODEX_THREAD_ID, undefined)
  assert.equal(env.CODEX_APP_TOOLS_PIPE_PATH, undefined)
  assert.equal(env.TERM, undefined)
})

async function flush() {
  await new Promise((resolve) => setImmediate(resolve))
}

function createKeeper({ clock, runner, persisted, onRefresh, onExhausted, startTime } = {}) {
  const effectiveClock = clock ?? new FakeClock(BASE_NOW)
  const statuses = []
  const persistedChanges = []
  const keeper = new WindowKeeper({
    enabled: true,
    startTime,
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
    { windowId: 'primary', resetAt: new Date(resetAtMs).toISOString(), verified: true }
  )

  assert.equal(plan.kind, 'wait-reset')
  assert.equal(plan.delayMs, 70_000)
  assert.equal(plan.triggerAtMs, resetAtMs + WINDOW_KEEPER_TRIGGER_BUFFER_MS)
})

test('未知未来 reset_at 先观察而不根据零使用率触发', () => {
  const plan = calculateWindowKeeperPlan(
    usageSnapshot({
      rateLimits: [
        fiveHourWindow({
          resetAt: new Date(BASE_NOW + 60 * 60 * 1000).toISOString(),
          usedPercent: 0
        })
      ]
    }),
    BASE_NOW,
    undefined
  )

  assert.equal(plan.kind, 'observe')
  assert.equal(plan.delayMs, WINDOW_KEEPER_VERIFY_DELAY_MS)
  assert.equal(plan.triggerAtMs, BASE_NOW + WINDOW_KEEPER_VERIFY_DELAY_MS)
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
  const verifiedResetAt = new Date(BASE_NOW + 5 * 60 * 60 * 1000).toISOString()
  const runner = createRunner([undefined])
  let refreshCount = 0
  const { clock, keeper, persistedChanges, statuses } = createKeeper({
    runner,
    onRefresh: async () => {
      refreshCount += 1
      return usageSnapshot({
        rateLimits: [
          fiveHourWindow({
            resetAt: verifiedResetAt,
            usedPercent: 1
          })
        ]
      })
    }
  })
  keeper.updateSnapshot(
    usageSnapshot({
      rateLimits: [fiveHourWindow({ resetAt, usedPercent: 0 })]
    })
  )

  clock.advance(WINDOW_KEEPER_TRIGGER_BUFFER_MS)
  await flush()

  assert.equal(refreshCount, 1)
  assert.equal(persistedChanges.length, 0)
  assert.equal(statuses.at(-1).state, 'verifying')

  clock.advance(WINDOW_KEEPER_VERIFY_DELAY_MS)
  await flush()

  const persisted = persistedChanges.at(-1)
  assert.deepEqual(persisted, {
    windowId: 'primary',
    resetAt: verifiedResetAt,
    lastTriggeredAt: new Date(BASE_NOW + WINDOW_KEEPER_TRIGGER_BUFFER_MS).toISOString(),
    verified: true
  })
  assert.equal(refreshCount, 2)
  assert.equal(statuses.at(-1).lastTriggeredAt, persisted.lastTriggeredAt)
})

test('额度验证成功后按新窗口 reset_at 安排下一轮', async () => {
  const nextResetAtMs = BASE_NOW + 5 * 60 * 60 * 1000
  const { clock, keeper } = createKeeper({
    runner: createRunner([undefined]),
    onRefresh: async () =>
      usageSnapshot({
        rateLimits: [
          fiveHourWindow({ resetAt: new Date(nextResetAtMs).toISOString(), usedPercent: 1 })
        ]
      })
  })
  keeper.updateSnapshot(
    usageSnapshot({
      rateLimits: [fiveHourWindow({ resetAt: new Date(BASE_NOW - 1_000).toISOString() })]
    })
  )

  clock.advance(WINDOW_KEEPER_TRIGGER_BUFFER_MS)
  await flush()
  clock.advance(WINDOW_KEEPER_VERIFY_DELAY_MS)
  await flush()

  assert.equal(clock.activeTimers().length, 1)
  assert.equal(clock.activeTimers()[0].dueAt, nextResetAtMs + WINDOW_KEEPER_TRIGGER_BUFFER_MS)
})

test('空窗口触发后 reset_at 滚动不会重建下一次调度', async () => {
  const runner = createRunner([undefined])
  const stableResetAt = new Date(BASE_NOW + 5 * 60 * 60 * 1000).toISOString()
  const refreshSnapshots = [
    usageSnapshot({
      rateLimits: [fiveHourWindow({ resetAt: stableResetAt, usedPercent: 0 })]
    }),
    usageSnapshot({
      rateLimits: [fiveHourWindow({ resetAt: stableResetAt, usedPercent: 0 })]
    })
  ]
  const { clock, keeper } = createKeeper({
    runner,
    onRefresh: async () => refreshSnapshots.shift()
  })
  const firstSnapshot = usageSnapshot({
    rateLimits: [
      fiveHourWindow({
        resetAt: new Date(BASE_NOW - 1_000).toISOString(),
        usedPercent: 0
      })
    ]
  })
  keeper.updateSnapshot(firstSnapshot)

  clock.advance(WINDOW_KEEPER_TRIGGER_BUFFER_MS)
  await flush()
  assert.equal(runner.calls.length, 1)

  keeper.updateSnapshot(
    usageSnapshot({
      rateLimits: [
        fiveHourWindow({
          resetAt: new Date(BASE_NOW + 2 * 60 * 60 * 1000).toISOString(),
          usedPercent: 0
        })
      ]
    })
  )

  assert.equal(runner.calls.length, 1)
  assert.equal(clock.activeTimers().length, 1)
  clock.advance(60_000)
  await flush()
  assert.equal(
    clock.activeTimers()[0].dueAt,
    BASE_NOW + 5 * 60 * 60 * 1000 + WINDOW_KEEPER_TRIGGER_BUFFER_MS
  )
})

test('应用重启后沿用已确认 resetAt 防止重复触发', () => {
  const lastTriggeredAt = new Date(BASE_NOW - 60_000).toISOString()
  const plan = calculateWindowKeeperPlan(
    usageSnapshot({
      rateLimits: [
        fiveHourWindow({
          resetAt: new Date(BASE_NOW + 60 * 60 * 1000).toISOString(),
          usedPercent: 0
        })
      ]
    }),
    BASE_NOW,
    {
      windowId: 'primary',
      resetAt: new Date(BASE_NOW + 60 * 60 * 1000).toISOString(),
      lastTriggeredAt,
      verified: true
    }
  )

  assert.equal(plan.kind, 'wait-reset')
  assert.equal(plan.delayMs, 60 * 60 * 1000 + WINDOW_KEEPER_TRIGGER_BUFFER_MS)
})

test('观察期间使用率变化不跳过时间稳定性检查', () => {
  const clock = new FakeClock(BASE_NOW)
  const runner = createRunner()
  const { keeper } = createKeeper({ clock, runner })
  keeper.updateSnapshot(
    usageSnapshot({
      rateLimits: [
        fiveHourWindow({
          resetAt: new Date(BASE_NOW + 60 * 60 * 1000).toISOString(),
          usedPercent: 0
        })
      ]
    })
  )

  const resetAtMs = BASE_NOW + 2 * 60 * 60 * 1000
  keeper.updateSnapshot(
    usageSnapshot({
      rateLimits: [
        fiveHourWindow({
          resetAt: new Date(resetAtMs).toISOString(),
          usedPercent: 2
        })
      ]
    })
  )

  assert.equal(clock.activeTimers().length, 1)
  assert.equal(clock.activeTimers()[0].dueAt, BASE_NOW + WINDOW_KEEPER_VERIFY_DELAY_MS)
})

test('reset_at 已过即触发，不受残留使用率影响', async () => {
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
  assert.equal(runner.calls.length, 1)
  assert.equal(clock.activeTimers().length, 1)
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

test('未来 resetAt 到期后的失败事件不会被后续同步重新开启', async () => {
  const resetAt = new Date(BASE_NOW + 60_000).toISOString()
  const runner = createRunner([
    new Error('first'),
    new Error('second'),
    new Error('third'),
    new Error('fourth'),
    new Error('fifth')
  ])
  const { clock, keeper, statuses } = createKeeper({
    runner,
    persisted: { windowId: 'primary', resetAt, verified: true }
  })
  keeper.updateSnapshot(
    usageSnapshot({ rateLimits: [fiveHourWindow({ resetAt, usedPercent: 20 })] })
  )
  clock.advance(70_000)
  await flush()
  for (const delayMs of RETRY_DELAYS_MS.slice(0, 4)) {
    clock.advance(delayMs)
    await flush()
  }
  clock.advance(WINDOW_KEEPER_MAX_RETRY_DURATION_MS - 450_000)
  await flush()
  assert.equal(statuses.at(-1).state, 'error')
  const callsAfterError = runner.calls.length
  keeper.updateSnapshot(
    usageSnapshot({ rateLimits: [fiveHourWindow({ resetAt, usedPercent: 20 })] })
  )
  assert.equal(runner.calls.length, callsAfterError)
  assert.equal(statuses.at(-1).state, 'error')
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
  const resetAt = new Date(BASE_NOW + 3_600_000).toISOString()
  const runner = createRunner()
  const { clock, keeper } = createKeeper({
    runner,
    persisted: {
      windowId: 'primary',
      resetAt,
      lastTriggeredAt: new Date(BASE_NOW - 500).toISOString(),
      verified: true
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
  const resetAt = new Date(BASE_NOW - 1_000).toISOString()
  const runner = createRunner()
  const { clock, keeper } = createKeeper({ runner })
  const rateLimits = [fiveHourWindow({ resetAt, usedPercent: 0 })]

  keeper.updateSnapshot(usageSnapshot({ authMode: 'api', rateLimits }))
  keeper.updateSnapshot(usageSnapshot({ authMode: 'chatgpt', rateLimits }))
  clock.advance(70_000)
  await flush()

  assert.equal(runner.calls.length, 1)
})

test('使用率变化不会清除已过期窗口的重试状态', async () => {
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
  assert.equal(statuses.at(-1).state, 'error')
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

test('weekly remaining 0% returns waiting-weekly-reset', () => {
  const plan = calculateWindowKeeperPlan(
    usageSnapshot({
      rateLimits: [
        fiveHourWindow({ resetAt: new Date(BASE_NOW + 60_000).toISOString(), usedPercent: 0 }),
        weeklyWindowWith({
          usedPercent: 100,
          remainingPercent: 0,
          resetsAt: new Date(BASE_NOW + 7 * 24 * 60 * 60 * 1000).toISOString()
        })
      ]
    }),
    BASE_NOW,
    undefined
  )

  assert.equal(plan.kind, 'waiting-weekly-reset')
})

test('weekly action time is weekly reset_at plus ten seconds', () => {
  const resetsAtMs = BASE_NOW + 7 * 24 * 60 * 60 * 1000
  const plan = calculateWindowKeeperPlan(
    usageSnapshot({
      rateLimits: [
        fiveHourWindow({ resetAt: new Date(BASE_NOW + 60_000).toISOString(), usedPercent: 0 }),
        weeklyWindowWith({
          usedPercent: 40,
          remainingPercent: 0,
          resetsAt: new Date(resetsAtMs).toISOString()
        })
      ]
    }),
    BASE_NOW,
    undefined
  )

  assert.equal(plan.kind, 'waiting-weekly-reset')
  assert.equal(plan.triggerAtMs, resetsAtMs + WINDOW_KEEPER_TRIGGER_BUFFER_MS)
  assert.equal(plan.delayMs, 7 * 24 * 60 * 60 * 1000 + WINDOW_KEEPER_TRIGGER_BUFFER_MS)
})

test('expired weekly reset schedules now plus ten seconds', () => {
  const plan = calculateWindowKeeperPlan(
    usageSnapshot({
      rateLimits: [
        fiveHourWindow({ resetAt: new Date(BASE_NOW + 60_000).toISOString(), usedPercent: 0 }),
        weeklyWindowWith({
          usedPercent: 100,
          remainingPercent: 0,
          resetsAt: new Date(BASE_NOW - 1_000).toISOString()
        })
      ]
    }),
    BASE_NOW,
    undefined
  )

  assert.equal(plan.kind, 'waiting-weekly-reset')
  assert.equal(plan.triggerAtMs, BASE_NOW + WINDOW_KEEPER_TRIGGER_BUFFER_MS)
})

test('exhausted weekly quota ignores rolling 5h reset_at', () => {
  const plan = calculateWindowKeeperPlan(
    usageSnapshot({
      rateLimits: [
        fiveHourWindow({ resetAt: new Date(BASE_NOW + 60_000).toISOString(), usedPercent: 20 }),
        weeklyWindowWith({
          usedPercent: 100,
          remainingPercent: 0,
          resetsAt: new Date(BASE_NOW + 7 * 24 * 60 * 60 * 1000).toISOString()
        })
      ]
    }),
    BASE_NOW,
    undefined
  )

  assert.equal(plan.kind, 'waiting-weekly-reset')
  assert.equal(
    plan.triggerAtMs,
    BASE_NOW + 7 * 24 * 60 * 60 * 1000 + WINDOW_KEEPER_TRIGGER_BUFFER_MS
  )
})

test('missing weekly reset waits for data', () => {
  const plan = calculateWindowKeeperPlan(
    usageSnapshot({
      rateLimits: [
        fiveHourWindow({ resetAt: new Date(BASE_NOW + 60_000).toISOString(), usedPercent: 0 }),
        weeklyWindowWith({ usedPercent: 100, remainingPercent: 0, resetsAt: undefined })
      ]
    }),
    BASE_NOW,
    undefined
  )

  assert.equal(plan.kind, 'wait-data')
})

test('recovered weekly quota cancels weekly timer', async () => {
  const clock = new FakeClock(BASE_NOW)
  const runner = createRunner()
  const { keeper } = createKeeper({ clock, runner })
  keeper.updateSnapshot(
    usageSnapshot({
      rateLimits: [
        fiveHourWindow({ resetAt: new Date(BASE_NOW + 60_000).toISOString(), usedPercent: 0 }),
        weeklyWindowWith({
          usedPercent: 100,
          remainingPercent: 0,
          resetsAt: new Date(BASE_NOW + 7 * 24 * 60 * 60 * 1000).toISOString()
        })
      ]
    })
  )

  assert.equal(clock.activeTimers().length, 1)
  const weeklyTimer = clock.activeTimers()[0]

  keeper.updateSnapshot(
    usageSnapshot({
      rateLimits: [
        fiveHourWindow({ resetAt: new Date(BASE_NOW + 60_000).toISOString(), usedPercent: 0 }),
        weeklyWindowWith({
          usedPercent: 20,
          remainingPercent: 80,
          resetsAt: new Date(BASE_NOW + 7 * 24 * 60 * 60 * 1000).toISOString()
        })
      ]
    })
  )

  assert.equal(weeklyTimer.cleared, true)
  assert.equal(clock.activeTimers().length, 1)
  assert.equal(clock.activeTimers()[0].dueAt, BASE_NOW + WINDOW_KEEPER_VERIFY_DELAY_MS)
})

test('recovered weekly quota resumes existing 5h empty/used logic', async () => {
  const clock = new FakeClock(BASE_NOW)
  const runner = createRunner()
  const { keeper } = createKeeper({ clock, runner })
  keeper.updateSnapshot(
    usageSnapshot({
      rateLimits: [
        fiveHourWindow({ resetAt: new Date(BASE_NOW - 1_000).toISOString(), usedPercent: 0 }),
        weeklyWindowWith({
          usedPercent: 100,
          remainingPercent: 0,
          resetsAt: new Date(BASE_NOW + 7 * 24 * 60 * 60 * 1000).toISOString()
        })
      ]
    })
  )
  keeper.updateSnapshot(
    usageSnapshot({
      rateLimits: [
        fiveHourWindow({ resetAt: new Date(BASE_NOW - 1_000).toISOString(), usedPercent: 0 }),
        weeklyWindowWith({
          usedPercent: 20,
          remainingPercent: 80,
          resetsAt: new Date(BASE_NOW + 7 * 24 * 60 * 60 * 1000).toISOString()
        })
      ]
    })
  )

  clock.advance(WINDOW_KEEPER_TRIGGER_BUFFER_MS)
  await flush()
  assert.equal(runner.calls.length, 1)
})

test('exhausted weekly quota does not start CLI early', async () => {
  const runner = createRunner()
  const clock = new FakeClock(BASE_NOW)
  const { keeper } = createKeeper({ clock, runner })
  keeper.updateSnapshot(
    usageSnapshot({
      rateLimits: [
        fiveHourWindow({ resetAt: new Date(BASE_NOW - 1_000).toISOString(), usedPercent: 0 }),
        weeklyWindowWith({
          usedPercent: 100,
          remainingPercent: 0,
          resetsAt: new Date(BASE_NOW + 7 * 24 * 60 * 60 * 1000).toISOString()
        })
      ]
    })
  )

  clock.advance(WINDOW_KEEPER_TRIGGER_BUFFER_MS + 1)
  await flush()
  assert.equal(runner.calls.length, 0)
  assert.equal(clock.activeTimers().length, 1)
})

test('local quota cannot establish an official window schedule', () => {
  const plan = calculateWindowKeeperPlan(
    usageSnapshot({
      rateLimitSource: 'local',
      rateLimits: [
        fiveHourWindow({ resetAt: new Date(BASE_NOW + 60_000).toISOString(), usedPercent: 0 }),
        weeklyWindowWith({
          usedPercent: 100,
          remainingPercent: 0,
          resetsAt: new Date(BASE_NOW + 7 * 24 * 60 * 60 * 1000).toISOString()
        })
      ]
    }),
    BASE_NOW,
    undefined
  )

  assert.equal(plan.kind, 'wait-data')
})

test('changing weekly resetAt cancels and reschedules the active weekly timer', async () => {
  const clock = new FakeClock(BASE_NOW)
  const runner = createRunner()
  const { keeper } = createKeeper({ clock, runner })
  const firstResetAt = new Date(BASE_NOW + 7 * 24 * 60 * 60 * 1000).toISOString()
  const secondResetAt = new Date(BASE_NOW + 3 * 24 * 60 * 60 * 1000).toISOString()

  keeper.updateSnapshot(
    usageSnapshot({
      rateLimits: [
        fiveHourWindow({ resetAt: new Date(BASE_NOW + 60_000).toISOString(), usedPercent: 0 }),
        weeklyWindowWith({
          usedPercent: 100,
          remainingPercent: 0,
          resetsAt: firstResetAt
        })
      ]
    })
  )

  assert.equal(clock.activeTimers().length, 1)
  const initialTimer = clock.activeTimers()[0]
  assert.equal(
    initialTimer.dueAt,
    BASE_NOW + 7 * 24 * 60 * 60 * 1000 + WINDOW_KEEPER_TRIGGER_BUFFER_MS
  )

  keeper.updateSnapshot(
    usageSnapshot({
      rateLimits: [
        fiveHourWindow({ resetAt: new Date(BASE_NOW + 60_000).toISOString(), usedPercent: 0 }),
        weeklyWindowWith({
          usedPercent: 100,
          remainingPercent: 0,
          resetsAt: secondResetAt
        })
      ]
    })
  )

  assert.equal(initialTimer.cleared, true)
  assert.equal(clock.activeTimers().length, 1)
  const rescheduledTimer = clock.activeTimers()[0]
  assert.equal(
    rescheduledTimer.dueAt,
    BASE_NOW + 3 * 24 * 60 * 60 * 1000 + WINDOW_KEEPER_TRIGGER_BUFFER_MS
  )
})

test('weekly timer treats handle 0 as active and cancels on disable', () => {
  let timerId = 0
  const scheduled = []
  const cleared = []
  const customTimer = {
    now: () => BASE_NOW,
    setTimeout: (callback, delayMs) => {
      const id = timerId++
      scheduled.push({ id, delayMs, callback })
      return id
    },
    clearTimeout: (id) => {
      cleared.push(id)
    }
  }
  const keeper = new WindowKeeper({
    enabled: true,
    onRefresh: async () => {},
    ...customTimer
  })
  const snapshot = usageSnapshot({
    rateLimits: [
      fiveHourWindow({ resetAt: new Date(BASE_NOW + 60_000).toISOString(), usedPercent: 0 }),
      weeklyWindowWith({
        usedPercent: 100,
        remainingPercent: 0,
        resetsAt: new Date(BASE_NOW + 7 * 24 * 60 * 60 * 1000).toISOString()
      })
    ]
  })
  keeper.updateSnapshot(snapshot)
  assert.equal(scheduled.length, 1)
  assert.equal(scheduled[0].id, 0)

  keeper.updateSnapshot(snapshot)
  assert.equal(scheduled.length, 1)

  keeper.setEnabled(false)
  assert.deepEqual(cleared, [0])
})

test('CLI 完成后先验证官方额度再记录成功', async () => {
  const clock = new FakeClock(BASE_NOW)
  const runner = createRunner([undefined])
  const stableResetAt = new Date(BASE_NOW + 5 * 60 * 60 * 1000).toISOString()
  const refreshSnapshots = [
    usageSnapshot({
      rateLimits: [fiveHourWindow({ resetAt: stableResetAt, usedPercent: 0 })]
    }),
    usageSnapshot({
      rateLimits: [fiveHourWindow({ resetAt: stableResetAt, usedPercent: 0 })]
    })
  ]
  const { keeper, persistedChanges, statuses } = createKeeper({
    clock,
    runner,
    onRefresh: async () => refreshSnapshots.shift()
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

  assert.equal(statuses.at(-1).state, 'verifying')
  assert.equal(persistedChanges.length, 0)

  clock.advance(60_000)
  await flush()

  assert.equal(persistedChanges.length, 1)
  assert.equal(persistedChanges[0].verified, true)
  assert.equal(persistedChanges[0].resetAt, stableResetAt)
})

test('额度验证只依赖 reset_at，不要求 used_percent', async () => {
  const clock = new FakeClock(BASE_NOW)
  const stableResetAt = new Date(BASE_NOW + 5 * 60 * 60 * 1000).toISOString()
  const windowWithoutUsage = () => {
    const windowState = fiveHourWindow({ resetAt: stableResetAt })
    delete windowState.usedPercent
    delete windowState.remainingPercent
    return windowState
  }
  const refreshSnapshots = [
    usageSnapshot({ rateLimits: [windowWithoutUsage()] }),
    usageSnapshot({ rateLimits: [windowWithoutUsage()] })
  ]
  const { keeper, persistedChanges } = createKeeper({
    clock,
    runner: createRunner([undefined]),
    onRefresh: async () => refreshSnapshots.shift()
  })
  keeper.updateSnapshot(
    usageSnapshot({
      rateLimits: [
        fiveHourWindow({ resetAt: new Date(BASE_NOW - 1_000).toISOString(), usedPercent: 0 })
      ]
    })
  )

  clock.advance(WINDOW_KEEPER_TRIGGER_BUFFER_MS)
  await flush()
  clock.advance(WINDOW_KEEPER_VERIFY_DELAY_MS)
  await flush()

  assert.equal(persistedChanges.length, 1)
  assert.equal(persistedChanges[0].resetAt, stableResetAt)
})

test('额度验证期间 reset_at 先变化后固定会继续观察并成功', async () => {
  const clock = new FakeClock(BASE_NOW)
  const firstResetAt = new Date(BASE_NOW + 5 * 60 * 60 * 1000).toISOString()
  const secondResetAt = new Date(BASE_NOW + 5 * 60 * 60 * 1000 + 60_000).toISOString()
  const refreshSnapshots = [
    usageSnapshot({
      rateLimits: [fiveHourWindow({ resetAt: firstResetAt, usedPercent: 0 })]
    }),
    usageSnapshot({
      rateLimits: [fiveHourWindow({ resetAt: secondResetAt, usedPercent: 0 })]
    }),
    usageSnapshot({
      rateLimits: [fiveHourWindow({ resetAt: secondResetAt, usedPercent: 0 })]
    })
  ]
  const runner = createRunner([undefined])
  const { keeper, persistedChanges, statuses } = createKeeper({
    clock,
    runner,
    onRefresh: async () => refreshSnapshots.shift()
  })
  keeper.updateSnapshot(
    usageSnapshot({
      rateLimits: [
        fiveHourWindow({ resetAt: new Date(BASE_NOW - 1_000).toISOString(), usedPercent: 0 })
      ]
    })
  )

  clock.advance(WINDOW_KEEPER_TRIGGER_BUFFER_MS)
  await flush()
  clock.advance(60_000)
  await flush()

  assert.equal(persistedChanges.length, 0)
  assert.equal(statuses.at(-1).state, 'verifying')
  assert.equal(runner.calls.length, 1)

  clock.advance(60_000)
  await flush()

  assert.equal(persistedChanges.length, 1)
  assert.equal(persistedChanges[0].resetAt, secondResetAt)
  assert.equal(statuses.at(-1).state, 'waiting-reset')
  assert.equal(runner.calls.length, 1)
})

test('额度验证期间 reset_at 持续滚动会在期限结束后失败且不重复发送 CLI', async () => {
  const clock = new FakeClock(BASE_NOW)
  const runner = createRunner([undefined])
  let refreshCount = 0
  let exhaustedCount = 0
  const { keeper, persistedChanges, statuses } = createKeeper({
    clock,
    runner,
    onRefresh: async () => {
      refreshCount += 1
      return usageSnapshot({
        rateLimits: [
          fiveHourWindow({
            resetAt: new Date(clock.nowMs + 5 * 60 * 60 * 1000 + refreshCount * 1000).toISOString(),
            usedPercent: 0
          })
        ]
      })
    },
    onExhausted: () => {
      exhaustedCount += 1
    }
  })
  keeper.updateSnapshot(
    usageSnapshot({
      rateLimits: [
        fiveHourWindow({ resetAt: new Date(BASE_NOW - 1_000).toISOString(), usedPercent: 0 })
      ]
    })
  )

  clock.advance(WINDOW_KEEPER_TRIGGER_BUFFER_MS)
  await flush()
  for (let elapsedMs = 0; elapsedMs < WINDOW_KEEPER_MAX_RETRY_DURATION_MS; elapsedMs += 60_000) {
    clock.advance(60_000)
    await flush()
  }

  assert.equal(persistedChanges.length, 0)
  assert.equal(statuses.at(-1).state, 'error')
  assert.match(statuses.at(-1).recentError, /did not stabilize/i)
  assert.equal(runner.calls.length, 1)
  assert.equal(exhaustedCount, 1)
})

test('剩余重试期限不足一分钟时不会提前判定 reset_at 稳定', async () => {
  const clock = new FakeClock(BASE_NOW)
  const stableResetAt = new Date(BASE_NOW + 5 * 60 * 60 * 1000).toISOString()
  let refreshCount = 0
  const { keeper, persistedChanges, statuses } = createKeeper({
    clock,
    runner: createRunner([undefined]),
    onRefresh: async () => {
      refreshCount += 1
      if (refreshCount === 1) {
        clock.nowMs += 9 * 60 * 1000 + 30_000
      }
      return usageSnapshot({
        rateLimits: [fiveHourWindow({ resetAt: stableResetAt, usedPercent: 0 })]
      })
    }
  })
  keeper.updateSnapshot(
    usageSnapshot({
      rateLimits: [
        fiveHourWindow({ resetAt: new Date(BASE_NOW - 1_000).toISOString(), usedPercent: 0 })
      ]
    })
  )

  clock.advance(WINDOW_KEEPER_TRIGGER_BUFFER_MS)
  await flush()
  clock.advance(30_000)
  await flush()

  assert.equal(refreshCount, 1)
  assert.equal(persistedChanges.length, 0)
  assert.equal(statuses.at(-1).state, 'error')
})

test('CLI 无有效回复且官方周额度耗尽时等待周额度恢复', async () => {
  const clock = new FakeClock(BASE_NOW)
  const weeklyResetAt = new Date(BASE_NOW + 7 * 24 * 60 * 60 * 1000).toISOString()
  const exhaustedSnapshot = usageSnapshot({
    rateLimits: [
      fiveHourWindow({ resetAt: new Date(BASE_NOW - 1_000).toISOString(), usedPercent: 0 }),
      weeklyWindowWith({ usedPercent: 100, remainingPercent: 0, resetsAt: weeklyResetAt })
    ]
  })
  const { keeper, statuses } = createKeeper({
    clock,
    runner: createRunner([new Error('Codex CLI session completed without a model reply')]),
    onRefresh: async () => exhaustedSnapshot
  })
  keeper.updateSnapshot(
    usageSnapshot({
      rateLimits: [
        fiveHourWindow({ resetAt: new Date(BASE_NOW - 1_000).toISOString(), usedPercent: 0 }),
        weeklyWindowWith({
          usedPercent: 99,
          remainingPercent: 1,
          resetsAt: weeklyResetAt
        })
      ]
    })
  )

  clock.advance(WINDOW_KEEPER_TRIGGER_BUFFER_MS)
  await flush()

  assert.equal(statuses.at(-1).state, 'waiting-weekly-reset')
  assert.equal(
    statuses.at(-1).nextActionAt,
    new Date(Date.parse(weeklyResetAt) + 10_000).toISOString()
  )
})

test('未验证记录不会跳过未来窗口的观察', () => {
  const plan = calculateWindowKeeperPlan(
    usageSnapshot({
      rateLimits: [
        fiveHourWindow({
          resetAt: new Date(BASE_NOW + 60_000).toISOString(),
          usedPercent: 0
        })
      ]
    }),
    BASE_NOW,
    {
      windowId: 'primary',
      lastTriggeredAt: new Date(BASE_NOW - 60_000).toISOString()
    }
  )

  assert.equal(plan.kind, 'observe')
  assert.equal(plan.delayMs, WINDOW_KEEPER_VERIFY_DELAY_MS)
})

test('旧版未验证成功时间不会显示为上次成功', () => {
  const { statuses } = createKeeper({
    persisted: {
      windowId: 'primary',
      lastTriggeredAt: new Date(BASE_NOW - 60_000).toISOString()
    }
  })

  assert.equal(statuses[0].lastTriggeredAt, undefined)
})

test('官方重置后时间滚动才补请求，连续同步不推迟观察，验证后按 resetAt 等待', async () => {
  const oldResetAt = new Date(BASE_NOW + 3 * 60 * 60 * 1000).toISOString()
  const newResetAt = new Date(BASE_NOW + 5 * 60 * 60 * 1000).toISOString()
  const runner = createRunner()
  const snapshot = (resetAt, usedPercent = 0) =>
    usageSnapshot({ rateLimits: [fiveHourWindow({ resetAt, usedPercent })] })
  const { clock, keeper, persistedChanges } = createKeeper({
    runner,
    persisted: {
      windowId: 'primary',
      resetAt: oldResetAt,
      lastTriggeredAt: new Date(BASE_NOW - 2 * 60 * 60 * 1000).toISOString(),
      verified: true
    },
    onRefresh: async () => snapshot(new Date(Date.parse(newResetAt) + 60_000).toISOString())
  })
  keeper.updateSnapshot(snapshot(oldResetAt, 20))
  const oldTimer = clock.activeTimers()[0]
  keeper.updateSnapshot(snapshot(newResetAt))
  assert.equal(oldTimer.cleared, true)
  assert.equal(clock.activeTimers()[0].dueAt, BASE_NOW + WINDOW_KEEPER_VERIFY_DELAY_MS)
  clock.advance(5_000)
  keeper.updateSnapshot(snapshot(new Date(Date.parse(newResetAt) + 5_000).toISOString()))
  assert.equal(clock.activeTimers()[0].dueAt, BASE_NOW + WINDOW_KEEPER_VERIFY_DELAY_MS)
  assert.equal(runner.calls.length, 0)
  clock.advance(55_000)
  await flush()
  assert.equal(runner.calls.length, 0)
  clock.advance(WINDOW_KEEPER_TRIGGER_BUFFER_MS)
  await flush()
  assert.equal(runner.calls.length, 1)
  clock.advance(WINDOW_KEEPER_VERIFY_DELAY_MS)
  await flush()
  assert.equal(
    persistedChanges.at(-1).resetAt,
    new Date(Date.parse(newResetAt) + 60_000).toISOString()
  )
  keeper.updateSnapshot(snapshot(new Date(Date.parse(newResetAt) + 60_000).toISOString()))
  assert.equal(runner.calls.length, 1)
  assert.equal(
    clock.activeTimers()[0].dueAt,
    Date.parse(newResetAt) + 60_000 + WINDOW_KEEPER_TRIGGER_BUFFER_MS
  )
  keeper.stop()
})

test('官方窗口变化统一观察，无效或本地数据不触发', () => {
  const oldResetAt = new Date(BASE_NOW + 3 * 60 * 60 * 1000).toISOString()
  const newResetAt = new Date(BASE_NOW + 5 * 60 * 60 * 1000).toISOString()
  const persisted = {
    windowId: 'primary',
    resetAt: oldResetAt,
    lastTriggeredAt: new Date(BASE_NOW - 2 * 60 * 60 * 1000).toISOString(),
    verified: true
  }
  for (const { source, resetAt, usedPercent, expectedDelay } of [
    { source: 'official', resetAt: newResetAt, usedPercent: 0, expectedDelay: 60_000 },
    { source: 'official', resetAt: oldResetAt, usedPercent: 0, expectedDelay: 10_810_000 },
    { source: 'local', resetAt: newResetAt, usedPercent: 0, expectedDelay: undefined },
    { source: 'official', resetAt: undefined, usedPercent: 0, expectedDelay: undefined },
    { source: 'official', resetAt: 'invalid', usedPercent: 0, expectedDelay: undefined },
    { source: 'official', resetAt: newResetAt, usedPercent: 2, expectedDelay: 60_000 }
  ]) {
    const plan = calculateWindowKeeperPlan(
      usageSnapshot({
        rateLimitSource: source,
        rateLimits: [fiveHourWindow({ resetAt, usedPercent })]
      }),
      BASE_NOW,
      persisted
    )
    assert.equal(plan.delayMs, expectedDelay, `${source}/${resetAt}/${usedPercent}`)
  }
})

test('验证额度期间关闭开关会取消验证 timer', async () => {
  const stableResetAt = new Date(BASE_NOW + 5 * 60 * 60 * 1000).toISOString()
  const { clock, keeper, persistedChanges, statuses } = createKeeper({
    runner: createRunner([undefined]),
    onRefresh: async () =>
      usageSnapshot({
        rateLimits: [fiveHourWindow({ resetAt: stableResetAt, usedPercent: 0 })]
      })
  })
  keeper.updateSnapshot(
    usageSnapshot({
      rateLimits: [fiveHourWindow({ resetAt: stableResetAt, usedPercent: 0 })]
    })
  )
  clock.advance(WINDOW_KEEPER_TRIGGER_BUFFER_MS)
  await flush()

  assert.equal(statuses.at(-1).state, 'verifying')
  keeper.setEnabled(false)
  clock.advance(60_000)
  await flush()

  assert.equal(clock.activeTimers().length, 0)
  assert.equal(persistedChanges.length, 0)
  assert.equal(statuses.at(-1).state, 'disabled')
})

function localTime(hours, minutes = 0, dayOffset = 0, seconds = 0) {
  return new Date(2026, 9, 9 + dayOffset, hours, minutes, seconds).getTime()
}

function snapshotWithResetAt(resetAtMs) {
  return usageSnapshot({
    rateLimits: [fiveHourWindow({ resetAt: new Date(resetAtMs).toISOString() })]
  })
}

test('开始时间严格使用 HH:mm，缺失或非法值恢复全天运行默认值', () => {
  assert.equal(DEFAULT_WINDOW_KEEPER_START_TIME, '00:00')
  for (const value of ['00:00', '08:30', '12:59', '23:59']) {
    assert.equal(isWindowKeeperStartTime(value), true)
    assert.equal(normalizeWindowKeeperStartTime(value), value)
  }
  for (const value of [undefined, null, '', '8:30', '24:00', '08:60', '08:30:00', ' 08:30', 830]) {
    assert.equal(isWindowKeeperStartTime(value), false)
    assert.equal(normalizeWindowKeeperStartTime(value), '00:00')
  }
})

test('时间门槛使用候选时间的本地日期，包含开始分钟与次日', () => {
  assert.equal(getNextWindowKeeperAllowedTime(localTime(8, 29), '08:30'), localTime(8, 30))
  assert.equal(getNextWindowKeeperAllowedTime(localTime(8, 30), '08:30'), localTime(8, 30))
  assert.equal(getNextWindowKeeperAllowedTime(localTime(9), '08:30'), localTime(9))
  assert.equal(getNextWindowKeeperAllowedTime(localTime(6, 30, 1), '08:30'), localTime(8, 30, 1))
  assert.equal(getNextWindowKeeperAllowedTime(localTime(0), '00:00'), localTime(0))
  assert.equal(getNextWindowKeeperAllowedTime(localTime(23, 59), '00:00'), localTime(23, 59))
})

test('开始前不发保活请求，到点先刷新额度再沿用 10 秒缓冲', async () => {
  const clock = new FakeClock(localTime(8))
  const runner = createRunner()
  const snapshot = snapshotWithResetAt(localTime(7))
  let refreshCount = 0
  const { keeper } = createKeeper({
    clock,
    runner,
    startTime: '08:30',
    onRefresh: async () => {
      refreshCount++
      return snapshot
    }
  })
  keeper.updateSnapshot(snapshot)
  const waitingTimer = clock.activeTimers()[0]
  for (let index = 0; index < 5; index++) keeper.updateSnapshot(snapshot)
  assert.equal(clock.activeTimers().length, 1)
  assert.equal(clock.activeTimers()[0], waitingTimer)
  assert.equal(keeper.getStatus().state, 'waiting-start-time')
  assert.equal(keeper.getStatus().nextActionAt, new Date(localTime(8, 30)).toISOString())
  clock.advance(localTime(8, 30) - clock.nowMs - 1)
  await flush()
  assert.equal(refreshCount, 0)
  assert.equal(runner.calls.length, 0)
  clock.advance(1)
  await flush()
  assert.equal(refreshCount, 1)
  assert.equal(runner.calls.length, 0)
  clock.advance(WINDOW_KEEPER_TRIGGER_BUFFER_MS)
  await flush()
  assert.equal(runner.calls.length, 1)
  keeper.stop()
})

test('开始时间后才启动不漏触发，默认时间仍保持原有行为', async () => {
  for (const startTime of ['08:30', '00:00', undefined]) {
    const clock = new FakeClock(localTime(9))
    const runner = createRunner()
    const { keeper } = createKeeper({ clock, runner, startTime })
    keeper.updateSnapshot(snapshotWithResetAt(localTime(7)))
    clock.advance(WINDOW_KEEPER_TRIGGER_BUFFER_MS)
    await flush()
    assert.equal(runner.calls.length, 1)
    keeper.stop()
  }
})

test('放行时刷新发现已确认的有效窗口，不额外补发请求', async () => {
  const clock = new FakeClock(localTime(8))
  const runner = createRunner()
  const resetAtMs = localTime(11, 30)
  const freshSnapshot = snapshotWithResetAt(resetAtMs)
  const { keeper, persistedChanges } = createKeeper({
    clock,
    runner,
    startTime: '08:30',
    persisted: { windowId: 'primary', resetAt: new Date(resetAtMs).toISOString(), verified: true },
    onRefresh: async () => freshSnapshot
  })
  keeper.updateSnapshot(snapshotWithResetAt(localTime(7)))
  clock.advance(localTime(8, 30) - clock.nowMs)
  await flush()
  assert.equal(runner.calls.length, 0)
  assert.equal(persistedChanges.length, 0)
  assert.equal(clock.activeTimers()[0].dueAt, resetAtMs + WINDOW_KEEPER_TRIGGER_BUFFER_MS)
  keeper.stop()
})

test('开始后未知但稳定的未来窗口仍先观察同步，不写假成功记录', async () => {
  const clock = new FakeClock(localTime(8))
  const runner = createRunner()
  const snapshot = snapshotWithResetAt(localTime(11, 30))
  const { keeper, persistedChanges } = createKeeper({
    clock,
    runner,
    startTime: '08:30',
    onRefresh: async () => snapshot
  })
  keeper.updateSnapshot(snapshot)
  clock.advance(localTime(8, 30) - clock.nowMs)
  await flush()
  assert.equal(keeper.getStatus().state, 'verifying')
  clock.advance(WINDOW_KEEPER_VERIFY_DELAY_MS)
  await flush()
  assert.equal(runner.calls.length, 0)
  assert.equal(persistedChanges.length, 0)
  assert.equal(clock.activeTimers()[0].dueAt, localTime(11, 30) + WINDOW_KEEPER_TRIGGER_BUFFER_MS)
  keeper.stop()
})

test('次日 06:30 到期延后至 08:30，等待数小时不会提前消耗重试期限', async () => {
  const clock = new FakeClock(localTime(23, 30))
  const runner = createRunner()
  const expiredSnapshot = snapshotWithResetAt(localTime(6, 30, 1))
  const { keeper, persistedChanges } = createKeeper({
    clock,
    runner,
    startTime: '08:30',
    persisted: {
      windowId: 'primary',
      resetAt: expiredSnapshot.rateLimits[0].resetsAt,
      verified: true
    },
    onRefresh: async () =>
      runner.calls.length ? snapshotWithResetAt(localTime(13, 30, 1)) : expiredSnapshot
  })
  keeper.updateSnapshot(expiredSnapshot)
  assert.equal(keeper.getStatus().state, 'waiting-start-time')
  assert.equal(clock.activeTimers()[0].dueAt, localTime(8, 30, 1))
  clock.advance(localTime(6, 30, 1) - clock.nowMs)
  await flush()
  assert.equal(runner.calls.length, 0)
  clock.advance(localTime(8, 30, 1) - clock.nowMs)
  await flush()
  clock.advance(WINDOW_KEEPER_TRIGGER_BUFFER_MS)
  await flush()
  assert.equal(runner.calls.length, 1)
  clock.advance(WINDOW_KEEPER_VERIFY_DELAY_MS)
  await flush()
  assert.equal(persistedChanges.length, 1)
  assert.equal(keeper.getStatus().state, 'waiting-reset')
  const persisted = persistedChanges[0]
  keeper.stop()
  const { keeper: restarted } = createKeeper({ clock, runner, startTime: '08:30', persisted })
  restarted.updateSnapshot(snapshotWithResetAt(localTime(13, 30, 1)))
  assert.equal(
    clock.activeTimers()[0].dueAt,
    localTime(13, 30, 1) + WINDOW_KEEPER_TRIGGER_BUFFER_MS
  )
  assert.equal(runner.calls.length, 1)
  restarted.stop()
})

test('过期回调在午夜后执行时重查开始时间，不提前发请求', async () => {
  const clock = new FakeClock(localTime(23, 59, 0, 40))
  const runner = createRunner()
  const snapshot = snapshotWithResetAt(localTime(23, 58))
  const { keeper } = createKeeper({
    clock,
    runner,
    startTime: '08:30',
    onRefresh: async () => snapshot
  })
  keeper.updateSnapshot(snapshot)
  clock.advance(localTime(0, 0, 1) - clock.nowMs)
  await flush()
  assert.equal(runner.calls.length, 0)
  assert.equal(keeper.getStatus().state, 'waiting-start-time')
  assert.equal(clock.activeTimers()[0].dueAt, localTime(8, 30, 1))
  clock.advance(localTime(8, 30, 1) - clock.nowMs)
  await flush()
  clock.advance(WINDOW_KEEPER_TRIGGER_BUFFER_MS)
  await flush()
  assert.equal(runner.calls.length, 1)
  keeper.stop()
})

test('午夜后的请求重试禁止发送，仍按原截止时间失败且不会被同窗口重新开启', async () => {
  const clock = new FakeClock(localTime(23, 59, 0, 40))
  const runner = createRunner([new Error('offline')])
  const snapshot = snapshotWithResetAt(localTime(23, 58))
  const { keeper } = createKeeper({
    clock,
    runner,
    startTime: '08:30',
    onRefresh: async () => snapshot
  })
  keeper.updateSnapshot(snapshot)
  clock.advance(WINDOW_KEEPER_TRIGGER_BUFFER_MS)
  await flush()
  assert.equal(runner.calls.length, 1)
  const deadlineAtMs = clock.nowMs + WINDOW_KEEPER_MAX_RETRY_DURATION_MS
  assert.equal(clock.activeTimers()[0].dueAt, deadlineAtMs)
  assert.equal(keeper.getStatus().state, 'waiting-start-time')
  clock.advance(deadlineAtMs - clock.nowMs)
  await flush()
  assert.equal(keeper.getStatus().state, 'error')
  assert.equal(runner.calls.length, 1)
  clock.advance(localTime(8, 30, 1) - clock.nowMs)
  keeper.updateSnapshot(snapshot)
  assert.equal(clock.activeTimers().length, 0)
  assert.equal(runner.calls.length, 1)
  keeper.stop()
})

test('已发出的请求可以跨午夜完成只读验证，不在禁用时段重发', async () => {
  const clock = new FakeClock(localTime(23, 59, 0, 30))
  const runner = createRunner()
  const { keeper, persistedChanges } = createKeeper({
    clock,
    runner,
    startTime: '08:30',
    onRefresh: async () => snapshotWithResetAt(localTime(4, 59, 1))
  })
  keeper.updateSnapshot(snapshotWithResetAt(localTime(23, 58)))
  clock.advance(WINDOW_KEEPER_TRIGGER_BUFFER_MS)
  await flush()
  clock.advance(WINDOW_KEEPER_VERIFY_DELAY_MS)
  await flush()
  assert.equal(persistedChanges.length, 1)
  assert.equal(runner.calls.length, 1)
  assert.equal(keeper.getStatus().state, 'waiting-start-time')
  assert.equal(clock.activeTimers()[0].dueAt, localTime(8, 30, 1))
  keeper.stop()
})

test('修改开始时间清理旧 timer，相同设置不重建 timer，关闭后保留配置', async () => {
  const clock = new FakeClock(localTime(8))
  const runner = createRunner()
  const snapshot = snapshotWithResetAt(localTime(7))
  const { keeper } = createKeeper({
    clock,
    runner,
    startTime: '08:30',
    onRefresh: async () => snapshot
  })
  keeper.updateSnapshot(snapshot)
  const oldTimer = clock.activeTimers()[0]
  keeper.setEnabled(true, '09:15')
  assert.equal(oldTimer.cleared, true)
  const updatedTimer = clock.activeTimers()[0]
  assert.equal(updatedTimer.dueAt, localTime(9, 15))
  keeper.setEnabled(true, '09:15')
  assert.equal(clock.activeTimers()[0], updatedTimer)
  keeper.setEnabled(false)
  assert.equal(clock.activeTimers().length, 0)
  keeper.setEnabled(true)
  assert.equal(clock.activeTimers()[0].dueAt, localTime(9, 15))
  clock.advance(localTime(8, 30) - clock.nowMs)
  await flush()
  assert.equal(runner.calls.length, 0)
  clock.advance(localTime(9, 15) - clock.nowMs)
  await flush()
  clock.advance(WINDOW_KEEPER_TRIGGER_BUFFER_MS)
  await flush()
  assert.equal(runner.calls.length, 1)
  keeper.stop()
})

for (const action of ['disable', 'stop', 'change-time']) {
  test(`放行刷新返回前 ${action}，旧异步返回不能恢复调度`, async () => {
    const clock = new FakeClock(localTime(8))
    const runner = createRunner()
    const snapshot = snapshotWithResetAt(localTime(7))
    let resolveRefresh
    const { keeper } = createKeeper({
      clock,
      runner,
      startTime: '08:30',
      onRefresh: () =>
        new Promise((resolve) => {
          resolveRefresh = resolve
        })
    })
    keeper.updateSnapshot(snapshot)
    clock.advance(localTime(8, 30) - clock.nowMs)
    if (action === 'disable') keeper.setEnabled(false)
    else if (action === 'stop') keeper.stop()
    else keeper.setEnabled(true, '10:00')
    resolveRefresh(snapshot)
    await flush()
    assert.equal(runner.calls.length, 0)
    if (action === 'change-time') {
      assert.equal(clock.activeTimers().length, 1)
      assert.equal(clock.activeTimers()[0].dueAt, localTime(10))
    } else {
      assert.equal(clock.activeTimers().length, 0)
    }
    keeper.stop()
  })
}

test('旧放行刷新拒绝后，不覆盖重新启用的新调度状态', async () => {
  const clock = new FakeClock(localTime(8))
  const snapshot = snapshotWithResetAt(localTime(7))
  let rejectRefresh
  const { keeper } = createKeeper({
    clock,
    startTime: '08:30',
    onRefresh: () =>
      new Promise((_, reject) => {
        rejectRefresh = reject
      })
  })
  keeper.updateSnapshot(snapshot)
  clock.advance(localTime(8, 30) - clock.nowMs)
  keeper.setEnabled(false)
  keeper.setEnabled(true, '00:00')
  const newTimer = clock.activeTimers()[0]
  rejectRefresh(new Error('old refresh failed'))
  await flush()
  assert.equal(keeper.getStatus().state, 'waiting-start-time')
  assert.equal(keeper.getStatus().recentError, undefined)
  assert.equal(clock.activeTimers()[0], newTimer)
  keeper.stop()
})

test('修改开始时间不会延长已开始的请求重试周期', async () => {
  const clock = new FakeClock(localTime(9))
  const runner = createRunner([new Error('offline')])
  const snapshot = snapshotWithResetAt(localTime(7))
  const { keeper } = createKeeper({
    clock,
    runner,
    startTime: '08:30',
    onRefresh: async () => snapshot
  })
  keeper.updateSnapshot(snapshot)
  clock.advance(WINDOW_KEEPER_TRIGGER_BUFFER_MS)
  await flush()
  const deadlineAtMs = clock.nowMs + WINDOW_KEEPER_MAX_RETRY_DURATION_MS
  keeper.setEnabled(true, '10:00')
  assert.equal(clock.activeTimers()[0].dueAt, deadlineAtMs)
  keeper.updateSnapshot(snapshot)
  assert.equal(clock.activeTimers()[0].dueAt, deadlineAtMs)
  clock.advance(deadlineAtMs - clock.nowMs)
  await flush()
  assert.equal(runner.calls.length, 1)
  assert.equal(keeper.getStatus().state, 'error')
  keeper.stop()
})

for (const outcome of ['failure', 'no-fresh-snapshot']) {
  test(`放行刷新 ${outcome} 时等待新额度，不使用旧快照发送请求`, async () => {
    const clock = new FakeClock(localTime(8))
    const runner = createRunner()
    const { keeper } = createKeeper({
      clock,
      runner,
      startTime: '08:30',
      onRefresh: async () => {
        if (outcome === 'failure') throw new Error('offline')
      }
    })
    keeper.updateSnapshot(snapshotWithResetAt(localTime(7)))
    clock.advance(localTime(8, 30) - clock.nowMs)
    await flush()
    assert.equal(keeper.getStatus().state, 'waiting-data')
    assert.equal(clock.activeTimers().length, 0)
    assert.equal(runner.calls.length, 0)
    keeper.stop()
  })
}

test('快照更新发现已超过开始时间时主动放行，不等待旧时钟 timer', async () => {
  const clock = new FakeClock(localTime(8))
  const runner = createRunner()
  const snapshot = snapshotWithResetAt(localTime(7))
  const { keeper } = createKeeper({
    clock,
    runner,
    startTime: '08:30',
    onRefresh: async () => snapshot
  })
  keeper.updateSnapshot(snapshot)
  const oldTimer = clock.activeTimers()[0]
  clock.nowMs = localTime(9)
  keeper.updateSnapshot(snapshot)
  await flush()
  assert.equal(oldTimer.cleared, true)
  clock.advance(WINDOW_KEEPER_TRIGGER_BUFFER_MS)
  await flush()
  assert.equal(runner.calls.length, 1)
  keeper.stop()
})

test('自定义时间不绕过登录方式、官方数据和周额度限制', async () => {
  const expiredWindow = fiveHourWindow({ resetAt: new Date(localTime(7)).toISOString() })
  const snapshots = [
    usageSnapshot({ authMode: 'api', rateLimits: [expiredWindow] }),
    usageSnapshot({ rateLimitSource: 'local', rateLimits: [expiredWindow] }),
    usageSnapshot({
      rateLimits: [
        expiredWindow,
        weeklyWindowWith({ remainingPercent: 0, resetsAt: new Date(localTime(12)).toISOString() })
      ]
    })
  ]
  for (const snapshot of snapshots) {
    const clock = new FakeClock(localTime(9))
    const runner = createRunner()
    const { keeper } = createKeeper({ clock, runner, startTime: '08:30' })
    keeper.updateSnapshot(snapshot)
    clock.advance(WINDOW_KEEPER_TRIGGER_BUFFER_MS)
    await flush()
    assert.equal(runner.calls.length, 0)
    keeper.stop()
  }
})

test('尚未发请求的观察重试跨午夜后重新等待门槛，不创建立即重复回调', async () => {
  const clock = new FakeClock(localTime(23, 58, 0, 30))
  const runner = createRunner()
  let refreshCount = 0
  const { keeper } = createKeeper({
    clock,
    runner,
    startTime: '08:30',
    onRefresh: async () => {
      if (++refreshCount === 1) throw new Error('offline')
      return snapshotWithResetAt(localTime(23, 58))
    }
  })
  keeper.updateSnapshot(snapshotWithResetAt(localTime(1, 0, 1)))
  clock.advance(WINDOW_KEEPER_VERIFY_DELAY_MS)
  await flush()
  assert.equal(keeper.getStatus().state, 'retrying')
  clock.advance(RETRY_DELAYS_MS[0])
  await flush()
  clock.advance(WINDOW_KEEPER_TRIGGER_BUFFER_MS)
  await flush()
  assert.equal(runner.calls.length, 0)
  assert.equal(keeper.getStatus().state, 'waiting-start-time')
  assert.equal(clock.activeTimers().length, 1)
  assert.equal(clock.activeTimers()[0].dueAt, localTime(8, 30, 1))
  keeper.stop()
})

for (const outcome of ['refresh-failed', 'refreshing-snapshot-only']) {
  test(`放行 ${outcome} 后旧轮询快照不能绕过新鲜额度门闩`, async () => {
    const clock = new FakeClock(localTime(8))
    const runner = createRunner()
    const snapshot = snapshotWithResetAt(localTime(7))
    let keeper
    ;({ keeper } = createKeeper({
      clock,
      runner,
      startTime: '08:30',
      onRefresh: async () => {
        if (outcome === 'refresh-failed') throw new Error('offline')
        keeper.updateSnapshot({ ...snapshot, isRefreshing: true })
      }
    }))
    keeper.updateSnapshot(snapshot)
    clock.advance(localTime(8, 30) - clock.nowMs)
    await flush()
    keeper.updateSnapshot({ ...snapshot, isRefreshing: true })
    clock.advance(WINDOW_KEEPER_TRIGGER_BUFFER_MS * 2)
    await flush()
    keeper.updateSnapshot({ ...snapshot, isRefreshing: false })
    assert.equal(runner.calls.length, 0)
    assert.equal(keeper.getStatus().state, 'waiting-data')
    assert.equal(clock.activeTimers().length, 0)
    const fresh = { ...snapshot, generatedAt: new Date(clock.nowMs).toISOString() }
    keeper.updateSnapshot({ ...fresh, isRefreshing: true })
    assert.equal(clock.activeTimers().length, 0)
    keeper.updateSnapshot(fresh)
    clock.advance(WINDOW_KEEPER_TRIGGER_BUFFER_MS)
    await flush()
    assert.equal(runner.calls.length, 1)
    keeper.stop()
  })
}

for (const action of ['change-time', 're-enable']) {
  test(`${action} 在允许时段打开门槛时先读新额度，慢刷新不使用旧快照`, async () => {
    const clock = new FakeClock(localTime(9))
    const runner = createRunner()
    const snapshot = snapshotWithResetAt(localTime(7))
    let resolveRefresh
    const { keeper } = createKeeper({
      clock,
      runner,
      startTime: action === 'change-time' ? '10:00' : '08:30',
      onRefresh: () =>
        new Promise((resolve) => {
          resolveRefresh = resolve
        })
    })
    keeper.updateSnapshot(snapshot)
    if (action === 're-enable') keeper.setEnabled(false)
    keeper.setEnabled(true, '08:30')
    clock.advance(0)
    keeper.updateSnapshot({ ...snapshot, isRefreshing: true })
    clock.advance(WINDOW_KEEPER_TRIGGER_BUFFER_MS * 2)
    await flush()
    assert.equal(runner.calls.length, 0)
    resolveRefresh({ ...snapshot, generatedAt: new Date(clock.nowMs).toISOString() })
    await flush()
    assert.equal(runner.calls.length, 0)
    clock.advance(WINDOW_KEEPER_TRIGGER_BUFFER_MS)
    await flush()
    assert.equal(runner.calls.length, 1)
    keeper.stop()
  })
}
