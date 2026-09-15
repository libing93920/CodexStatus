import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  installCodexHooks,
  mergeCodexHooks,
  removeCodexHooks,
  uninstallCodexHooks
} from '../src/main/services/codex-hook-installer.ts'

const existing = {
  description: 'user hooks',
  custom: { preserved: true },
  hooks: {
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'user.cmd', timeout: 30 }] }
    ]
  }
}

// 模拟旧版本(含 PreToolUse/PostToolUse managed 组)已安装的 hooks.json:
// 验证"先清后装"迁移路径 —— 旧 managed 组必须被移除,用户组保留
const legacyInstalled = mergeCodexHooks(
  {
    ...existing,
    hooks: {
      ...existing.hooks,
      PreToolUse: [
        ...existing.hooks.PreToolUse,
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command: '"C:\\Old\\codex-status-hook.cmd"',
              timeout: 2,
              statusMessage: 'CodexStatus task activity'
            }
          ]
        }
      ],
      PostToolUse: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command: '"C:\\Old\\codex-status-hook.cmd"',
              timeout: 2,
              statusMessage: 'CodexStatus task activity',
              async: true
            }
          ]
        }
      ]
    }
  },
  '"C:\\Old\\codex-status-hook.cmd"'
)

test('合并保留用户 Hook 且重复安装不重复', () => {
  const first = mergeCodexHooks(removeCodexHooks(existing), '"C:\\CodexStatus\\hook.cmd"')
  const second = mergeCodexHooks(removeCodexHooks(first), '"C:\\CodexStatus\\hook.cmd"')
  assert.equal(second.description, 'user hooks')
  assert.deepEqual(second.custom, { preserved: true })
  assert.equal(second.hooks.PreToolUse.length, 2)
  assert.equal(second.hooks.PreToolUse[1].matcher, '*')
  assert.equal(second.hooks.PreToolUse[1].hooks[0].statusMessage, 'CodexStatus task activity')
  assert.equal(second.hooks.PermissionRequest[0].hooks[0].async, undefined)
  assert.equal(second.hooks.UserPromptSubmit[0].hooks[0].async, true)
})

test('移除只删除 CodexStatus 管理项', () => {
  const merged = mergeCodexHooks(removeCodexHooks(existing), '"C:\\CodexStatus\\hook.cmd"')
  const removed = removeCodexHooks(merged)
  assert.deepEqual(removed, existing)
})

test('迁移:旧版本 managed 组(PreToolUse/PostToolUse)被清除且不重装', () => {
  const migrated = mergeCodexHooks(removeCodexHooks(legacyInstalled), '"C:\\New\\hook.cmd"')
  // PreToolUse 保留用户组并安装当前 managed 组,PostToolUse 整项消失
  assert.equal(migrated.hooks.PreToolUse.length, 2)
  assert.equal(migrated.hooks.PreToolUse[0].matcher, 'Bash')
  assert.equal(migrated.hooks.PreToolUse[1].matcher, '*')
  assert.equal(migrated.hooks.PostToolUse, undefined)
  // 新事件表只装生命周期节点
  assert.ok(migrated.hooks.SessionStart)
  assert.ok(migrated.hooks.UserPromptSubmit)
  assert.ok(migrated.hooks.PermissionRequest)
  assert.ok(migrated.hooks.Stop)
  assert.ok(migrated.hooks.Interrupt)
})

test('安装和关闭只管理自己的文件与配置项', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-hook-install-'))
  const hooksPath = path.join(directory, '.codex', 'hooks.json')
  const installDirectory = path.join(directory, 'app-hooks')
  const sourceScriptPath = path.join(directory, 'source.cjs')
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  await fs.mkdir(path.dirname(hooksPath), { recursive: true })
  await fs.writeFile(hooksPath, `${JSON.stringify(existing)}\n`)
  await fs.writeFile(sourceScriptPath, 'process.exit(0)\n')
  await installCodexHooks({
    hooksPath,
    installDirectory,
    sourceScriptPath,
    executablePath: 'C:\\Program Files\\CodexStatus.exe',
    descriptorPath: 'C:\\Data\\endpoint.json'
  })
  assert.equal(
    (await fs.readFile(path.join(installDirectory, 'codex-status-hook.cmd'), 'utf8')).includes(
      'ELECTRON_RUN_AS_NODE=1'
    ),
    true
  )
  const installed = JSON.parse(await fs.readFile(hooksPath, 'utf8'))
  assert.equal(installed.hooks.PreToolUse.length, 2)
  assert.equal(installed.hooks.PostToolUse, undefined)
  await uninstallCodexHooks(hooksPath, installDirectory)
  assert.deepEqual(JSON.parse(await fs.readFile(hooksPath, 'utf8')), existing)
  await assert.rejects(fs.access(path.join(installDirectory, 'codex-status-hook.cjs')))
})
