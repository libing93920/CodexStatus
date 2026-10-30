# 会话管理

## 阅读与操作

主界面围绕三个问题：有哪些 Agent、它们占用多少空间、哪些会话可以删除。

- 存储总览只保留三个统计和一张 Agent 空间分布图，点击 Agent 可查看其会话。
- 空间分析按占用从大到小逐行排列；文件组成与路径默认折叠。只有存在数据库的 OpenCode 来源提供整理入口。
- 会话管理默认只显示会话、大小、最近使用和删除状态。顶部提供搜索、Agent 与排序；日期、模型、大小等详细条件放入分组筛选抽屉，支持勾选多项。
- 切换“可以删除”即可聚焦可操作会话。跨页选择会保留，若选择来自其他筛选会明确提示；选中后才出现保护、导出和删除预览。
- 正文在独立抽屉中阅读，普通文字自然换行；工具块按需展开。文件清单、会话元信息和消息字段默认折叠。

会话列表的数据库条目显示会话数据量，文件会话显示所关联文件大小；工具实际磁盘占用在空间分析中查看。删除仍须经过原有预览与明确确认。

## 实现边界

界面沿用 AgentSpace，独立受限 preload 通过主进程授权操作。utilityProcess 负责扫描、空间统计和用量留存，按需启动本地 Rust stdio helper。helper 不加载 cc-switch 的账号、代理或 Tauri 应用状态，不依赖安装 cc-switch。

上游固定为 [cc-switch v4.0.21](https://github.com/farion1231/cc-switch/tree/c4db63c60d2a1ddcb4bd9f81152b9c6126413659/src-tauri/src/session_manager)，保留 MIT 许可。源文件、本地适配和差异见 `native/session-core/UPSTREAM.md`。

| 来源 | 扫描/正文/导出 | 删除 | 续聊 |
| --- | --- | --- | --- |
| Codex / Claude / OpenCode / Gemini / Grok Build / Pi / Oh My Pi | 支持 | 支持 | Windows，目录与参数可验证时 |
| OpenClaw / Hermes | 支持 | 支持 | 无本地续聊入口 |
| MCode / Kimi / Antigravity | 支持 | 上游不支持，使用原工具 | Windows，具体来源支持时 |
| Cline / Aider / 未知目录 | 文件或原有目录清单 | 不支持 | 不支持 |

能力、保护、宿主活跃状态、清理建议相互独立。14/90 天用于筛选建议，不授权或禁止删除。原工具格式变化或资源无法核验时会显示具体原因。

## 大小口径

- 会话文件：确认归属会话的独占正文、附件、Claude 附属目录、Codex 压缩兄弟等物理文件字节。
- SQLite 逻辑载荷：已识别表中会话记录与消息字段的字节量；不等于 SQLite 页、索引和文件占用。
- 共享资源：被多个会话引用的文件或 blob 单独表示，不能相加当作可释放大小。
- Agent 总量：已纳入来源目录的资源按文件身份去重；数据库、WAL、其他文件是总量的分类，共享字节是总量的子集。未登记目录、安装程序和来源目录外的缓存不在此统计范围。
- 库内空闲页：数据库可以复用的空间；与文件实际缩小分开显示。
- 无法完整读取时标为统计不完整，未知逻辑载荷不显示为零。

OpenCode 删除关联行不会自动执行 VACUUM。用户另行确认整理时，先检查额外磁盘空间，再执行 checkpoint/VACUUM，并重新扫描。操作记录的整理前后大小包含数据库、WAL 和 SHM。

## 删除与记录

审核固定选中 ID、来源、资源、版本与警告。执行前再次检查保护、宿主活跃状态和内容版本；数据库在写事务中复核相关记录。文件来源核验目录边界，拒绝链接或 reparse point，Windows 文件租约阻止正文并发改写。

OpenCode 处理 V1/V2、消息、part、事件和无剩余引用的 blob，并暂存同身份旧 JSON 副本；SQL 失败还原旧副本。Hermes 同步处理 SQLite 和同身份 JSONL。Codex 暂存普通/压缩正文，处理状态库和索引后清理暂存；索引失败时尝试还原正文。多文件与多个 SQLite 库不构成跨库原子事务，异常结果需要按操作记录与重扫结果核对。

主进程先刷盘 pending 记录，再逐项执行；成功、跳过和失败分别记录。宿主已统计的 Codex/Claude/OpenCode 用量在删除前保留，不将正文写进留存库。取消在条目之间生效，已经完成的删除不可撤销；数据库整理不能强制中断。

Markdown 导出用于阅读，不包含原数据库结构或完整附件恢复包。续聊参数从已验证的来源、会话 ID 和 provider 规则构造，元数据中的命令文本只用于来源能力描述，不交给 shell 执行。实际 CLI 安装与登录状态由原工具负责。

## 开发与验证

需要 Node、Rust/Cargo 和 Windows 原生构建工具链。

```powershell
npm run build
npm run test:session-manager
npm run test:session-manager-integration
npm run test:session-manager-visual
npm run test:session-cleaner
```

原生黑盒测试覆盖临时 OpenCode 混合库、删除隔离、SQL 失败回滚、Codex 索引/压缩正文、Claude 附属资源、来源边界和版本变化。Electron 集成通过实际 utilityProcess 与 helper 检查保护、过期计划、取消、用量留存和删除后刷新。未安装来源主要由夹具验证；不能据此宣称所有 CLI 版本的实机续聊均已验收。

原上游 Rust 单测依赖完整 cc-switch 的 fixture 与应用测试环境，尚未迁入本独立 crate，`cargo test --lib` 当前不通过；不要与已通过的编译和应用原生黑盒测试混为一谈。

无法确认归属的文件会显示为独立只读资源，仍计入来源大小；扫描期间有文件继续写入时会标记统计不完整。它们不会因此成为可批量删除的会话。

helper 输出到 `resources/session-core/`，electron-builder 将其复制到安装包 resources/session-core。不要将开发机二进制当作跨平台产物；目标平台构建时需要对应 Rust 工具链。
