# Agent 切换排行榜稳定性修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复应用启动和 Agent 热切换时团队成员丢失、self 快照滞后及强制刷新被吞掉的问题，同时保持 Token 排行榜统计三种工具总和。

**Architecture:** 把团队榜纯状态计算移到无 Electron 副作用的 `team-state.ts`，让局部设置判断和 self 快照可直接测试；用一个小型单飞刷新协调器合并快速切换请求。`src/main/index.ts` 只负责注入当前设置、快照、LAN peer 和刷新动作。

**Tech Stack:** Electron 39、TypeScript 5.9、Node.js `node:test`、现有 `--experimental-strip-types` 测试方式。

## Global Constraints

- Token 排行榜始终统计 Codex、Claude Code、OpenCode 三者 Token 总和。
- 不修改 LAN 消息协议，不持久化在线成员。
- 不增加依赖，不重构无关设置、额度采集或 UI。
- 每个行为先写失败测试，再写最小生产代码。

---

## 文件结构

- Create: `src/main/services/team-state.ts`：团队设置变更判断、额度窗口选择、self 与 peer 合并。
- Create: `src/main/services/refresh-coordinator.ts`：串行刷新与强制补刷合并。
- Create: `scripts/leaderboard-switch.test.mjs`：覆盖三个根因和 Token 总和口径。
- Modify: `src/main/index.ts`：接入纯状态函数和刷新协调器。
- Modify: `src/main/services/usage.ts`：提取并复用三 Agent 总和函数。
- Modify: `package.json`：增加独立排行榜回归测试命令。

---

### Task 1: 团队设置与快照纯状态

**Files:**
- Create: `src/main/services/team-state.ts`
- Create: `scripts/leaderboard-switch.test.mjs`
- Modify: `src/main/index.ts:441-473,871-925,950-977,1057-1065`
- Modify: `package.json:7-18`

**Interfaces:**
- Produces: `shouldRestartLanService(patch, previousSettings): boolean`
- Produces: `buildTeamPeers(input: BuildTeamPeersInput): TeamPeer[]`
- Produces: `getShortWindow(snapshot): RateLimitWindowSnapshot | undefined`
- Produces: `getLongWindow(snapshot): RateLimitWindowSnapshot | undefined`
- Produces: `getSelfRemaining(snapshot): number | undefined`

- [ ] **Step 1: 写局部设置与新快照失败测试**

在 `scripts/leaderboard-switch.test.mjs` 写入：

```javascript
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTeamPeers,
  shouldRestartLanService
} from '../src/main/services/team-state.ts'

const settings = {
  refreshMode: 'auto',
  refreshIntervalSeconds: 30,
  percentageMode: 'remaining',
  locale: 'zh-CN',
  agentId: 'codex',
  launchAtLogin: false,
  iqThreshold: 90,
  teamGroup: 'team-a',
  teamNickname: '本机'
}

test('Agent 局部 patch 不重启 LAN', () => {
  assert.equal(shouldRestartLanService({ agentId: 'claude' }, settings), false)
})

test('明确修改或清空团队口令时重启 LAN', () => {
  assert.equal(shouldRestartLanService({ teamGroup: 'team-b' }, settings), true)
  assert.equal(shouldRestartLanService({ teamGroup: undefined }, settings), true)
})

test('切回 Codex 时 self 使用新快照', () => {
  const snapshot = {
    available: true,
    isRefreshing: false,
    canRefresh: true,
    authMode: 'chatgpt',
    rateLimitSource: 'official',
    sourceHost: 'chatgpt.com',
    issues: [],
    filesScanned: 1,
    rateLimits: [
      { id: '5h', label: '5h', windowMinutes: 300, remainingPercent: 70 },
      { id: '7d', label: '7d', windowMinutes: 10080, remainingPercent: 60 }
    ]
  }
  const peers = buildTeamPeers({
    settings,
    peerId: 'self-id',
    snapshot,
    appVersion: '1.1.0',
    peers: [],
    tokenUsage: { '1d': 30 },
    tokenUsageByAgent: { '1d': { codex: 10, claude: 10, opencode: 10 } }
  })

  assert.equal(peers[0].authMode, 'chatgpt')
  assert.equal(peers[0].remainingPercent, 70)
  assert.equal(peers[0].shortWindow?.remainingPercent, 70)
  assert.equal(peers[0].longWindow?.remainingPercent, 60)
})
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node --experimental-strip-types --test scripts/leaderboard-switch.test.mjs`

Expected: FAIL，错误包含 `ERR_MODULE_NOT_FOUND`，因为 `team-state.ts` 尚不存在。

- [ ] **Step 3: 写最小团队状态实现**

创建 `src/main/services/team-state.ts`：

```typescript
import type {
  AppSettings,
  RateLimitWindowSnapshot,
  TeamPeer,
  UsageSnapshot
} from '../../shared/capsule'

export interface BuildTeamPeersInput {
  settings: AppSettings
  peerId?: string
  snapshot: UsageSnapshot
  appVersion: string
  peers: readonly TeamPeer[]
  tokenUsage?: TeamPeer['tokenUsage']
  tokenUsageByAgent?: TeamPeer['tokenUsageByAgent']
}

export function shouldRestartLanService(
  patch: Partial<AppSettings>,
  previousSettings: AppSettings
): boolean {
  const groupChanged =
    Object.hasOwn(patch, 'teamGroup') && patch.teamGroup !== previousSettings.teamGroup
  const nicknameChanged =
    Object.hasOwn(patch, 'teamNickname') && patch.teamNickname !== previousSettings.teamNickname
  return groupChanged || nicknameChanged
}

export function buildTeamPeers(input: BuildTeamPeersInput): TeamPeer[] {
  const short = getShortWindow(input.snapshot)
  const long = getLongWindow(input.snapshot)
  const nickname = input.settings.teamNickname?.trim() || '我'
  const selfPeer: TeamPeer = {
    id: input.peerId ?? 'self',
    nickname,
    isSelf: true,
    authMode: input.snapshot.authMode,
    remainingPercent: getSelfRemaining(input.snapshot),
    shortWindow: short
      ? { label: short.label, remainingPercent: short.remainingPercent }
      : undefined,
    longWindow: long
      ? { label: long.label, remainingPercent: long.remainingPercent }
      : undefined,
    resetCreditCount: input.snapshot.resetCredit?.availableCount,
    tokenUsage: input.tokenUsage,
    tokenUsageByAgent: input.tokenUsageByAgent,
    appVersion: input.appVersion,
    updatedAt: new Date().toISOString()
  }
  return [selfPeer, ...input.peers]
}

export function getShortWindow(snapshot: UsageSnapshot): RateLimitWindowSnapshot | undefined {
  return snapshot.rateLimits
    .filter((window) => window.windowMinutes !== undefined && window.windowMinutes < 1440)
    .sort((a, b) => (a.windowMinutes ?? 0) - (b.windowMinutes ?? 0))[0]
}

export function getLongWindow(snapshot: UsageSnapshot): RateLimitWindowSnapshot | undefined {
  return snapshot.rateLimits
    .filter((window) => window.windowMinutes !== undefined && window.windowMinutes >= 1440)
    .sort((a, b) => (a.windowMinutes ?? 0) - (b.windowMinutes ?? 0))[0]
}

export function getSelfRemaining(snapshot: UsageSnapshot): number | undefined {
  const short = snapshot.rateLimits.find(
    (window) => window.windowMinutes === undefined || window.windowMinutes < 1440
  )
  if (short?.remainingPercent !== undefined) return short.remainingPercent
  return snapshot.rateLimits.find(
    (window) => window.windowMinutes !== undefined && window.windowMinutes >= 1440
  )?.remainingPercent
}
```

- [ ] **Step 4: 接入主进程并确保新快照先于 self 构建**

在 `src/main/index.ts`：

```typescript
const previousSettings = persistedState.settings
// 更新 persistedState 后：
if (shouldRestartLanService(patch, previousSettings)) {
  syncLanService()
}
```

用小包装器注入运行时依赖：

```typescript
function buildCurrentTeamPeers(snapshot: UsageSnapshot): TeamPeer[] {
  return buildTeamPeers({
    settings: persistedState.settings,
    peerId: persistedState.peerId,
    snapshot,
    appVersion: app.getVersion(),
    peers: lanService.getPeers(),
    tokenUsage: getCachedTokenTotals(),
    tokenUsageByAgent: getCachedAgentTokenTotals()
  })
}
```

刷新完成时先构造基础快照，再构建团队成员：

```typescript
const nextSnapshot: UsageSnapshot = {
  ...collected,
  bestModelPick:
    agentId === 'codex' ? currentSnapshot.bestModelPick ?? collected.bestModelPick : undefined
}
currentSnapshot = {
  ...nextSnapshot,
  teamPeers: buildCurrentTeamPeers(nextSnapshot)
}
```

`onPeersChange`、`getLanSnapshot` 同步改为显式传入 `currentSnapshot`。

- [ ] **Step 5: 增加测试命令并确认 GREEN**

在 `package.json` scripts 增加：

```json
"test:leaderboard": "node --experimental-strip-types --test scripts/leaderboard-switch.test.mjs"
```

Run: `npm run test:leaderboard`

Expected: 3 tests PASS。

- [ ] **Step 6: 提交本任务**

```bash
git add src/main/services/team-state.ts src/main/index.ts scripts/leaderboard-switch.test.mjs package.json
git commit -m "fix:保留Agent切换时的团队排行榜" -m "- 局部设置不再错误重启LAN服务" -m "- self成员使用最新Agent快照"
```

---

### Task 2: 强制刷新单飞补跑

**Files:**
- Create: `src/main/services/refresh-coordinator.ts`
- Modify: `scripts/leaderboard-switch.test.mjs`
- Modify: `src/main/index.ts:1027-1085`

**Interfaces:**
- Produces: `RefreshCoordinator.run(force: boolean, operation: (force: boolean) => Promise<void>): Promise<void>`
- Consumes: `performRefresh(forceCredentialCheck: boolean): Promise<void>` from `src/main/index.ts`

- [ ] **Step 1: 写刷新合并失败测试**

追加到 `scripts/leaderboard-switch.test.mjs`：

```javascript
import { RefreshCoordinator } from '../src/main/services/refresh-coordinator.ts'

test('刷新中多次强制请求只为最新状态补跑一次', async () => {
  const coordinator = new RefreshCoordinator()
  const releases = []
  const calls = []
  const operation = async (force) => {
    calls.push(force)
    await new Promise((resolve) => releases.push(resolve))
  }

  const first = coordinator.run(false, operation)
  const second = coordinator.run(true, operation)
  const third = coordinator.run(true, operation)
  assert.deepEqual(calls, [false])

  releases.shift()()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(calls, [false, true])

  releases.shift()()
  await Promise.all([first, second, third])
  assert.deepEqual(calls, [false, true])
})
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `npm run test:leaderboard`

Expected: FAIL，错误包含 `ERR_MODULE_NOT_FOUND`，因为 `refresh-coordinator.ts` 尚不存在。

- [ ] **Step 3: 写最小刷新协调器**

创建 `src/main/services/refresh-coordinator.ts`：

```typescript
export class RefreshCoordinator {
  private current: Promise<void> | undefined
  private forcePending = false

  run(force: boolean, operation: (force: boolean) => Promise<void>): Promise<void> {
    if (this.current) {
      this.forcePending ||= force
      return this.current
    }
    this.current = this.drain(force, operation).finally(() => {
      this.current = undefined
    })
    return this.current
  }

  private async drain(
    force: boolean,
    operation: (force: boolean) => Promise<void>
  ): Promise<void> {
    let nextForce = force
    do {
      this.forcePending = false
      await operation(nextForce)
      nextForce = this.forcePending
    } while (nextForce)
  }
}
```

- [ ] **Step 4: 接入 `refreshStatus`**

在 `src/main/index.ts` 创建单例，并把当前函数体移动到 `performRefresh`：

```typescript
const refreshCoordinator = new RefreshCoordinator()

function refreshStatus(options: { forceCredentialCheck?: boolean } = {}): Promise<void> {
  return refreshCoordinator.run(options.forceCredentialCheck === true, performRefresh)
}

async function performRefresh(forceCredentialCheck: boolean): Promise<void> {
  if (!forceCredentialCheck && !canRefreshStatus() && currentSnapshot.generatedAt) {
    syncRefreshTimer()
    return
  }

  currentSnapshot = { ...currentSnapshot, isRefreshing: true }
  broadcastSnapshot()
  refreshTrayMenu()

  try {
    const agentId = persistedState.settings.agentId
    const collected =
      agentId === 'codex'
        ? await collectUsageSnapshot({
            iqThreshold: persistedState.settings.iqThreshold,
            bestModelPick: currentSnapshot.bestModelPick
          })
        : createApiModeSnapshot()
    await warmAllAgentTokenTotals()
    const nextSnapshot: UsageSnapshot = {
      ...collected,
      bestModelPick:
        agentId === 'codex' ? currentSnapshot.bestModelPick ?? collected.bestModelPick : undefined
    }
    currentSnapshot = {
      ...nextSnapshot,
      teamPeers: buildCurrentTeamPeers(nextSnapshot)
    }
    lanService.broadcastSnapshot()
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    currentSnapshot = {
      ...currentSnapshot,
      isRefreshing: false,
      issues: Array.from(new Set([errorMessage, ...currentSnapshot.issues])).slice(0, 6)
    }
  } finally {
    currentSnapshot = { ...currentSnapshot, isRefreshing: false }
    syncCapsuleWindowBounds()
    broadcastSnapshot()
    refreshTrayMenu()
    syncRefreshTimer()
  }
}
```

删除旧 `refreshPromise`；协调器保证普通重复刷新复用当前 Promise，强制请求只补跑一次。

- [ ] **Step 5: 运行测试并确认 GREEN**

Run: `npm run test:leaderboard`

Expected: 4 tests PASS。

- [ ] **Step 6: 提交本任务**

```bash
git add src/main/services/refresh-coordinator.ts src/main/index.ts scripts/leaderboard-switch.test.mjs
git commit -m "fix:补跑Agent切换期间的强制刷新" -m "- 合并快速切换请求并保持刷新串行" -m "- 最终快照始终对应最新监控工具"
```

---

### Task 3: 固定 Token 三 Agent 总和口径

**Files:**
- Modify: `src/main/services/usage.ts:222-240`
- Modify: `scripts/leaderboard-switch.test.mjs`

**Interfaces:**
- Produces: `sumAgentTokenTotals(agentTotals): Partial<Record<UsageWindow, number>>`
- Consumes: `lastAgentTotals` from `src/main/services/usage.ts`

- [ ] **Step 1: 写三 Agent 总和失败测试**

追加到 `scripts/leaderboard-switch.test.mjs`：

```javascript
import { sumAgentTokenTotals } from '../src/main/services/usage.ts'

test('Token 排行总量为三种 Agent 之和', () => {
  assert.deepEqual(
    sumAgentTokenTotals({
      '1d': { codex: 10, claude: 20, opencode: 30 },
      '7d': { codex: 100, claude: 200 }
    }),
    { '1d': 60, '7d': 300 }
  )
})
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `npm run test:leaderboard`

Expected: FAIL，错误指出 `sumAgentTokenTotals` 未导出。

- [ ] **Step 3: 提取现有求和逻辑**

在 `src/main/services/usage.ts`：

```typescript
export function sumAgentTokenTotals(
  agentTotals: Partial<Record<UsageWindow, Partial<Record<AgentId, number>>>>
): Partial<Record<UsageWindow, number>> {
  const totals: Partial<Record<UsageWindow, number>> = {}
  for (const [window, agents] of Object.entries(agentTotals)) {
    totals[window as UsageWindow] =
      (agents.codex ?? 0) + (agents.claude ?? 0) + (agents.opencode ?? 0)
  }
  return totals
}

export function getCachedTokenTotals(): Partial<Record<UsageWindow, number>> | undefined {
  return lastAgentTotals ? sumAgentTokenTotals(lastAgentTotals) : undefined
}
```

- [ ] **Step 4: 运行测试并确认 GREEN**

Run: `npm run test:leaderboard`

Expected: 5 tests PASS。

- [ ] **Step 5: 提交本任务**

```bash
git add src/main/services/usage.ts scripts/leaderboard-switch.test.mjs
git commit -m "test:固定Token排行榜汇总口径" -m "- 验证三种Agent用量始终相加" -m "- 复用现有团队榜总量计算"
```

---

### Task 4: 全量验证

**Files:**
- Verify: `scripts/leaderboard-switch.test.mjs`
- Verify: `scripts/quota-recheck.test.mjs`
- Verify: `src/main/**/*.ts`
- Verify: `src/renderer/**/*.tsx`

**Interfaces:**
- Consumes: Tasks 1-3 的全部行为。
- Produces: 可构建的最终修复。

- [ ] **Step 1: 运行排行榜回归测试**

Run: `npm run test:leaderboard`

Expected: 5 tests PASS，0 failures。

- [ ] **Step 2: 运行现有额度测试**

Run: `npm run test:quota`

Expected: 全部 PASS，0 failures。

- [ ] **Step 3: 运行类型检查**

Run: `npm run typecheck`

Expected: exit 0，无 TypeScript 错误。

- [ ] **Step 4: 运行 lint**

Run: `npm run lint`

Expected: exit 0，无 ESLint 错误。

- [ ] **Step 5: 运行构建**

Run: `npm run build`

Expected: exit 0，Electron 主进程、preload、renderer 均构建成功。

- [ ] **Step 6: 检查最终差异**

Run: `git diff --check && git status --short`

Expected: 无空白错误；只包含计划列出的实现和测试文件。
