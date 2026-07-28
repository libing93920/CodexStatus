# CodexStatus

基于 Electron + React + TypeScript 的 Codex 额度悬浮监控。桌面常驻胶囊窗口展示额度剩余，带详情面板、团队排行榜、模型雷达推荐、重置预测，以及应用内在线自动更新。

当前版本：`1.0.36`

## 功能概览

### 额度监控

- 桌面胶囊窗口常驻顶层，展示 5 小时 / 7 天两个额度窗口
- 支持剩余百分比 / 已使用百分比两种口径切换
- 支持胶囊 / 球形（orb）两种窗口形态，可吸附屏幕左右边缘
- 优先读取官方额度接口，不可用时回退到本地 sessions JSONL
- 自动 / 手动两种刷新模式，间隔可调

### 详情面板

点击胶囊打开面板，分三个页签：

- **详情**：额度卡片、官方接口来源、最近刷新时间、重置卡到期与数量
- **团队**：同组成员额度排行榜（需加入团队口令），按剩余降序排名
- **设置**：刷新模式、百分比口径、IQ 阈值、开机自启、语言、团队口令、检查更新

### 团队排行榜

- 局域网内同组口令的成员互见，展示各自剩余额度百分比与重置卡数量
- 基于 mDNS（Bonjour）发现 peer，WebSocket 互发派生展示数据
- 组口令经 SHA-256 哈希比对，明文不传出，不同口令的 peer 连上即断
- 同事开 TUN/全局代理会劫持内网多播导致互不可见，需内网网段走 DIRECT

### 雷达推荐模型

- 从 `codex-reset-radar.pages.dev` 拉取模型 IQ 评分榜
- 按 IQ 阈值过滤后在合格模型里选每题成本最低的，作为性价比推荐
- 10 分钟独立定时刷新，不跟随额度刷新节奏

### 重置预测

- 从 `hascodexratelimitreset.today` 拉取额度重置状态与预测时间
- 显示是否已重置、预测重置时间点、自动重置周期

### 在线自动更新

- 设置页「检查更新」按钮，手动检查 GitHub Releases 是否有新版本
- 发现新版 → 确认下载 → 进度显示 → 安装并重启，覆盖升级
- Windows 安装包无代码签名，已关闭签名校验

## 数据来源

| 数据 | 来源 | 走代理 |
|------|------|--------|
| 官方额度 | `https://chatgpt.com/backend-api/wham/usage` | 是（Electron net，走系统代理） |
| 重置卡 | `https://chatgpt.com/backend-api/wham/rate-limit-reset-credits` | 是 |
| 雷达模型 | `https://codex-reset-radar.pages.dev/current.json` | 否（Node 原生 fetch 直连） |
| 重置预测 | `https://hascodexratelimitreset.today/api/status` | 否 |
| 团队数据 | 局域网 mDNS + WebSocket | 否（内网直连） |

官方接口不可用时，应用回退到本地 `~/.codex/sessions` 下的 JSONL 会话文件解析额度。

## 使用前提

- 读取官方额度需要 `~/.codex/auth.json`，且处于 ChatGPT OAuth 模式含可用 `access_token`
- 凭据不可用时仍可从本地 sessions 读取回退数据，但只读一次不再自动轮询
- 团队功能需多名成员在同一局域网、设置相同的团队口令

## 本地开发

### 安装依赖

```bash
npm install
```

### 启动开发

```bash
npm run dev
```

### 代码检查

```bash
npm run lint
npm run typecheck
```

## 构建与发布

### 打包

国内网络下用镜像命令，避免 electron-builder 连 GitHub 校验超时：

```bash
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" \
ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/" \
npm run build:win
```

其他平台：`npm run build:mac` / `npm run build:linux`。

### 一键打包发布

[scripts/publish.py](scripts/publish.py) 自动完成：升 patch 版本号 → 镜像打包 → 发布到 GitHub Release。

前置：已装 `gh` CLI（`winget install --id GitHub.cli`）并 `gh auth login` 登录。

```bash
python scripts/publish.py              # 升版本号 + 打包 + 发布
python scripts/publish.py --no-bump    # 用当前版本号打包发布
python scripts/publish.py --dry-run    # 只打包不发布
python scripts/publish.py --notes "说明"   # 自定义 Release 备注
```

发布后产物：`CodexStatus-{version}-setup.exe` + `latest.yml` + `.blockmap`，客户端靠 `latest.yml` 发现更新。

## 状态持久化

窗口位置、设置、本机 LAN 标识保存到 Electron `userData` 目录下 `codex-status-state.json`。

## 技术栈

- Electron 39 + electron-vite
- React 19 + TypeScript 5
- electron-updater（在线更新）
- bonjour-service（mDNS 局域网发现）
- ws（WebSocket peer 通信）

## 友情社区

- [linux.do](https://linux.do/)
