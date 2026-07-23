# codex-status

一个基于 Electron、React 和 TypeScript 的 Codex 额度状态悬浮窗。

应用会在桌面显示一个胶囊窗口，用来展示 5 小时和 7 天两个额度窗口的剩余或已用百分比，并提供系统托盘菜单、详情面板和设置面板。

## 友情社区

- [linux.do](https://linux.do/)

## 功能概览

- 悬浮胶囊窗口，常驻桌面顶层显示 5h / 7d 两个额度窗口
- 支持剩余百分比 / 已使用百分比两种口径切换
- 官方 OAuth 可用时支持自动刷新和手动刷新
- 支持中英文界面
- 支持系统托盘菜单：显示/隐藏、刷新、设置、退出
- 优先读取官方额度接口，接口不可用时回退到本地 sessions JSONL 数据

## 数据来源

应用按以下顺序读取额度信息：

1. 官方接口：`https://chatgpt.com/backend-api/wham/usage`
2. 本地 sessions 回退数据：最近的 Codex 会话 JSONL 文件

如果官方接口不可用，但本地 sessions 中存在可解析的额度窗口，界面会继续显示本地回退结果。

## 使用前提

- 若要读取官方额度，当前环境需要存在 `~/.codex/auth.json`
- `auth.json` 需要处于 ChatGPT OAuth 模式，并包含可用的 `access_token`
- 若官方凭据不可用，应用仍会尝试从本地 sessions 读取回退数据
- 如果当前不是 ChatGPT OAuth 模式，应用只做一次本地回退读取，不再自动轮询刷新

## 本地开发

### 安装依赖

```bash
npm install
```

### 启动开发环境

```bash
npm run dev
```

### 代码检查

```bash
npm run lint
npm run typecheck
```

## 构建命令

```bash
npm run build
npm run build:unpack
npm run build:win
npm run build:mac
npm run build:linux
```

说明：

- `npm run build` 会先执行 TypeScript 检查，再执行 `electron-vite build`
- `npm run build:unpack` 会生成未打包目录
- 各平台打包命令会在当前平台配置基础上生成安装产物

## 使用方式

- 启动后会创建桌面胶囊窗口
- 点击系统托盘图标可显示或隐藏胶囊窗口
- 官方 OAuth 可用时，点击胶囊或托盘刷新项可立即手动刷新
- 从系统托盘菜单可打开设置面板、手动刷新或退出应用

## 状态持久化

应用会将窗口位置和设置保存到 Electron `userData` 目录下的 `codex-status-state.json`。
