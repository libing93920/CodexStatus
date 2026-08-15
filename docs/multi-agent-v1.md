# 多 Agent 工具支持 v1 设计

## 背景

`codex-status` 目前硬编码 Codex 的存储结构与接口，只有 Codex 用户能用。目标：让 Claude Code / OpenCode 用户也能用本工具，软件泛化。

盘定结论（2026-08-15）：核心差异不是"登录方式"，而是**三种不同的本地存储**。v1 只做「本地扫描 → token 用量 + 花费」的泛化，不做 billing / 官方额度 / 重置卡 / 雷达，不读 API key，不改名。

## 范围

| 项 | 决策 |
|---|---|
| 支持工具 | Codex / Claude Code / OpenCode，设置页单选 |
| 非 Codex 能力 | 本地扫描 token 用量 + 花费 + 团队用量榜 |
| 明确不做 | billing、官方额度、重置卡/重置预测、雷达、读 key、改名 |
| 团队额度榜 | 仅 Codex 订阅（现状已按 `authMode !== 'api'` 过滤） |
| 团队用量榜 | 三工具统一（现状已有，只是补数据源） |

## 现状关键事实（实测）

| 工具 | 数据位置 | 存储 | 用量字段 | 花费来源 |
|---|---|---|---|---|
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | JSONL | `event_msg/token_count` 累计值取差值，需子代理重放去重 | `computeCost`(pricing) + billing |
| Claude Code | `~/.claude/projects/<dir>/*.jsonl` | JSONL | `message.usage.{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens}`，**每消息独立、非累计** | `computeCost`(pricing) |
| OpenCode | `~/.local/share/opencode/opencode.db` | **SQLite** | `session` 表 `tokens_input/output/reasoning/cache_read/cache_write`，**每会话聚合** | **`session.cost` 直接有** |

关键差异：
- OpenCode 不是 JSONL 是 SQLite（Drizzle），需独立 SQLite 读取器。
- Claude usage 每消息独立 → 直接求和即可，**不需要** Codex 那套累计差值 + 子代理重放去重。
- OpenCode 每会话聚合 → 一天粒度按 `time_updated` 归桶，成本直接读 `cost` 列，不查价目。

## 架构

### 1. `agentId`

`capsule.ts`：
- 新增 `export type AgentId = 'codex' | 'claude' | 'opencode'`。
- `AppSettings` 增 `agentId: AgentId`；`DEFAULT_SETTINGS.agentId = 'codex'`；`normalizeSettings` 增合法值校验（非法回落 `'codex'`）。持久化经 `state.ts` 自动生效。

### 2. provider 抽象（窄接口，最小）

新文件 `src/main/services/agents.ts`：

```ts
export interface UsageEvent {
  ts: number                                   // 毫秒,归桶用
  model?: string                               // 计费用;OpenCode 可缺省(直接给 cost)
  tokens: { input; cachedInput; output; reasoning; total }
  costUsd?: number                             // 提供则跳过 computeCost(OpenCode)
}

export interface AgentProvider {
  id: AgentId
  label: string
  /** 扫描近 30 天用量为事件级明细;内部各自实现,抛错由调用方兜底为空数组 */
  scanRecentEvents(): Promise<UsageEvent[]>
}

export const AGENT_PROVIDERS: Record<AgentId, AgentProvider>
```

`authMode` 不在接口里：Codex 走现有 `readOfficialCodexCredentials().mode`，其余固定 `'api'`。

### 3. 统一数据流（复用 usage.ts 现有聚合）

`usage.ts` 里把「扫事件」与「聚合/序列/成本/缓存」拆开：
- 抽出 provider 分派：`scanRecentEvents(agentId)` 返回 `UsageEvent[]`。
- 下游 `getTokenUsage` / `getTokenUsageRange` / `warmTokenTotals` / `buildSeries` / `computeTotals` / `computeCost` 全部复用，只把 `EventItem` 换成 `UsageEvent`（`costUsd` 存在时跳过 `computeCost`）。
- 缓存 fingerprint 追加 `agentId`；切换工具清缓存（`invalidateUsageCache()`）。

Codex 实现 = 把现有 `scanRecentDays()` 的产物（`EventItem[]`）映射为 `UsageEvent[]`，逻辑不动。
Claude 实现 = 扫 `~/.claude/projects/**/*.jsonl`，逐条 `message.usage` 生成事件。
OpenCode 实现 = 只读 SQLite，`SELECT tokens_input,tokens_output,tokens_reasoning,tokens_cache_read,tokens_cache_write,cost,model,time_updated FROM session WHERE time_updated >= ?`，每会话一行事件。

### 4. 定价

- Claude：models.dev 已含 anthropic 价，`getPricingRate` 直接命中；离线兜底走 `DEFAULT_RATE`。`cache_creation_input_tokens` 并入 `cachedInput` 计（v1 不细分）。
- OpenCode：成本直接来自 DB，不查价。
- 代理/第三方模型名（如 `cloud-deepseek-flash`）命中不到 → `DEFAULT_RATE`，花费为估算上限，UI 不标"精确"。

## 分阶段实施

1. **数据层**（`capsule.ts` + `agents.ts` + `usage.ts` 拆 seam）：加 `AgentId`/`agentId`，建 provider 注册表，把 `usage.ts` 扫描改成分派，Codex 实现=搬现有逻辑。此阶段后行为不变、可编译。
2. **Claude 解析器**：`~/.claude/projects/**/*.jsonl` → `UsageEvent[]`。
3. **OpenCode 读取器**：只读打开 `~/.local/share/opencode/opencode.db` → `UsageEvent[]`（成本直接给）。
4. **刷新分派**（`index.ts` `refreshStatus`）：按 `settings.agentId` 分派——Codex 走现有 `collectUsageSnapshot`；非 Codex 生成 `authMode='api'`、无额度窗口、无 Codex 相关 issues 的最小快照，`warmTokenTotals` 走 provider 扫描。
5. **设置页**：`App.tsx` 设置视图加「工具」下拉，写回 `settings.agentId`。
6. **UI 收敛**：非 Codex 时隐藏额度窗口/重置卡/雷达/重置监测区块（`App.tsx` 中已按 `authMode` 分支，补 `agentId !== 'codex'` 判定），主显 API 模式视图 + 用量榜。

## 关键文件

- `src/shared/capsule.ts` — `AgentId`、`AppSettings.agentId`、默认值与校验
- `src/main/services/agents.ts`（新增）— provider 接口 + 注册表 + 各解析器
- `src/main/services/usage.ts` — 扫描 seam 化、缓存带 agentId、`UsageEvent` 替换 `EventItem`
- `src/main/services/quota.ts` — 仅导出 `readOfficialCodexCredentials` 复用；Codex 逻辑不动
- `src/main/index.ts` — `refreshStatus` 分派、`warmTokenTotals` 传 agentId
- `src/renderer/src/App.tsx` — 设置下拉、非 Codex 区块隐藏、用量榜数据接线

## 风险与假设

- **OpenCode SQLite 读取**：83MB 库、进程持续写入。只读模式打开（`file:` URI + `mode=ro`）、容忍 WAL 锁、超时兜底，不在主进程同步阻塞。实现期确认 Electron 39 内置的 `node:sqlite` 可用，否则退回 `better-sqlite3`。
- **Claude 子代理**：实测子代理存为独立文件（`<uuid>/subagents/agent-*.jsonl`，`isSidechain:true`），且 `message.usage` 每消息独立、非累计，各 API 请求只计一次 → **无需 Codex 式重放去重**，全量求和即可。唯一边缘：单会话跨文件（compact 后）可能拆成多个文件，v1 按文件求和、不做跨文件合并。
- **Claude/OpenCode 花费准确度**：第三方/代理模型命中不到价目 → `DEFAULT_RATE` 估算，UI 不标"精确"。
- **明文 key**：不改、不读、不写日志/快照/广播（你 `opencode.json` 里的 key 现状保留，不动）。

## 验证

1. `npm run typecheck` 通过。
2. 切换 agentId 到 `claude` / `opencode`，面板「用量」页出现 1/7/30d token 与花费，胶囊进 API 模式视图，额度/重置卡/雷达区块消失。
3. 团队页切到「Token 消耗」模式，三工具 peer 都能上榜；「额度」模式仍只含 Codex 订阅 peer。
4. 切回 `codex`，原额度/重置卡/雷达行为逐项回归无变化。
5. OpenCode 连续写库时点刷新，读取不报锁错、不卡主进程。
