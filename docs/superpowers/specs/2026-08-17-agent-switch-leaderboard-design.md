# Agent 切换排行榜稳定性修复设计

## 目标

满足以下行为：

1. 应用以 Codex 启动时，先显示本机；收到同组在线成员广播后显示完整额度排行榜。
2. 热切换到 Claude Code 或 OpenCode 后，保留在线成员并显示 Token 消耗排行榜。
3. 热切换回 Codex 后，立即使用最新 Codex 快照显示额度排行榜。
4. Token 排行榜始终按 Codex、Claude Code、OpenCode 三者 Token 总和排名，并保留分工具展示。

## 根因

- `updateSettings` 把未包含 `teamGroup` 的局部 patch 当成清空团队口令，错误重启 LAN 服务并清空 peer。
- `refreshStatus` 在提交新快照前构建 self peer，导致 self 读取上一种 Agent 的 `authMode` 和额度窗口。
- 切换 Agent 时若已有刷新，`refreshStatus` 直接复用旧 Promise，新 Agent 刷新可能被吞掉。

## 方案比较

### 方案 A：定点修复现有流程（采用）

- 用属性存在性判断区分“未提交 `teamGroup`”和“明确清空 `teamGroup`”。
- 先提交新 Agent 基础快照，再构建包含 self 的 `teamPeers`。
- 刷新期间记录一次待补刷请求；当前刷新结束后按最新设置再刷新。

优点：改动小，不改变 LAN 协议和 Token 排行口径。缺点：刷新仍为串行，但当前业务无需并发刷新。

### 方案 B：切换时重启 LAN，并持久化 peer

可在重启后立即恢复旧成员，但持久数据可能把离线成员误显示为在线，还需过期策略。超出当前需求，不采用。

### 方案 C：重构为按 Agent 保存独立团队快照

能扩展更多 Agent 状态，但会修改协议、状态模型和 UI。当前 Token 排行已广播三者总和，无需此复杂度，不采用。

## 数据流

### 启动

1. 读取持久设置并启动 LAN 服务。
2. 生成本机快照；此时 peer 为空，排行榜可暂时只有 self。
3. 收到同组 peer 的 hello/snapshot 后合并 `self + lanService.getPeers()` 并广播给渲染层。

### 切换到 Claude Code/OpenCode

1. 只更新 `agentId`，不重启 LAN，不清空 peer。
2. 清理本地用量缓存并刷新最新 Agent 状态。
3. 扫描三种工具，Token 排行总量继续取三者之和。
4. 使用保留的 peer 生成团队榜并广播本机最新 Token 快照。

### 切回 Codex

1. 拉取最新 Codex 额度快照。
2. 先令该快照成为 `currentSnapshot`。
3. 再从新快照提取 self 的登录方式、短/长窗口和剩余额度。
4. 合并未被清空的 LAN peer 并广播。

## 刷新并发规则

- 同一时刻只运行一个刷新。
- 普通重复刷新继续复用当前 Promise。
- Agent 切换触发的强制刷新若遇到在途刷新，标记待补刷。
- 在途刷新结束后，只按最新 `settings.agentId` 补刷一次；多次快速切换合并为一次。
- 不并发扫描，不为每次中间选择排队。

## 测试

先写失败测试，再修改生产代码：

1. `{ agentId: 'claude' }` 不触发 LAN 重启；明确修改或清空 `teamGroup` 才触发。
2. 从 API 模式切回 Codex 时，self peer 使用新 Codex `authMode` 和额度，不读取旧快照。
3. 刷新进行中切换 Agent，完成后为最新 Agent 补刷一次。
4. Token 排行总量仍等于三种 Agent Token 之和。

完成后运行新增回归测试、现有测试、TypeScript 类型检查和构建。

## 范围

- 不修改 LAN 消息协议。
- 不持久化在线成员。
- 不改变 Token 排行三者总和口径。
- 不重构无关设置、额度采集或 UI。
