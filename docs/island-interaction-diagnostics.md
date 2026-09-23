# 灵动岛交互诊断追查

灵动岛诊断写入现有 `<userData>/diag/diag.log`，沿用 `CODEX_STATUS_DIAG` 总开关和日志轮转。日志行以 `island-diag ` 开头，后面是一个 JSON 对象；`diag.log.old` 可能包含较早的记录。

## 关联一条链

1. 先按同一 renderer `instance` 和递增 `seq` 排序。`revision` 用来区分展示/隐藏轮次，`displayMode` 表示实际展示状态；不要只按文件行顺序推断跨进程先后。
2. 从 `mode-request` 的 `request` 开始，查看对应的 `mode-commit`（`firstRequest`、`lastRequest`）和 `effect`。模式或尺寸提交会记录 `effect` 的 `reason=geometry-change`。
3. 交互切换由 renderer 的 `interactive` 事件记录 `interactive`、`previousInteractive`、触发 `reason`；该事件的 `seq` 会作为主进程关联的 `request`。主进程随后记录相同 `peerInstance`/`request` 的 `interactive`（`reason=received`），再记录 `native`（`reason=interactive-applied`、`ignore`、`forward`）。三者能对上，才证明这次请求已经走到原生设置；缺少后续事件只能说明证据不完整，不能推定业务链中断。
4. `pointer` 的离开记录包含 `relatedInside`、`hitInside`，有可用窗口矩形时还包含 `domInside`。`pendingHitTest` 和 `pointValid` 用来判断是否有待处理命中或可用的最近坐标。普通鼠标移动不新增诊断事件，也不读取 DOM；离开路径才按需读取岛窗口矩形。
5. 展开进入以实际 `displayMode=expanded` 的 layout 提交为准。`expansion` 是 renderer 实例内的展开编号，`expandedAge` 是从该提交开始计算的时长。退出（包括 presentation 隐藏导致的实际 display mode 离开）记录 `effect` 的 `reason=expanded-exit`。

`dropped`、`sinkDropped` 大于零表示诊断通道丢过记录。先说明丢失范围，再分析剩余事件；没有对应事件不等于对应业务动作没有发生。

## 证据边界

这套日志可以证明已记录的 renderer → IPC → native 交互链、模式提交和展开退出时点，但不能证明所有触发条件都被覆盖，也不能仅凭一个 `pointer` 或 `interactive` 事件认定根因。当前修复仍需在 Windows 真机复现：静止点击、点击后移动、快速连续点击、展开后离开、presentation 隐藏/重新显示，以及需要时的 reduced-motion 路径。未完成这些验证前，不宣称问题已完全修复。

源码改动不会让已安装的旧版自动使用新日志字段。要验证新增字段，须运行包含改动的构建（安装包或隔离的本地构建），确认进程路径与构建来源后，再从该构建生成的 `diag.log` 取证；旧安装包生成的日志不能作为新字段或新链路的证据。

## 本通道开销上限

以下参数只描述灵动岛交互诊断通道：renderer 队列最多 `64` 个事件，首次事件后延迟 `50ms` 批量发送，renderer 每秒最多接受 `200 events/s`；主进程写入器最多保留 `2` 个待完成批次，每秒最多 `40 batch/s`；现有 `diag.log` 达到 `4MiB` 时轮转。诊断关闭时直接跳过记录、时钟读取和 IPC。
