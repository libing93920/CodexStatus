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

test('合并保留用户 Hook 且重复安装不重复', () => {
  const first = mergeCodexHooks(existing, '"C:\\CodexStatus\\hook.cmd"')
  const second = mergeCodexHooks(first, '"C:\\CodexStatus\\hook.cmd"')
  assert.equal(second.description, 'user hooks')
  assert.deepEqual(second.custom, { preserved: true })
  assert.equal(second.hooks.PreToolUse.length, 2)
  assert.equal(second.hooks.PermissionRequest[0].hooks[0].async, undefined)
  assert.equal(second.hooks.PostToolUse[0].hooks[0].async, true)
})

test('移除只删除 CodexStatus 管理项', () => {
  const merged = mergeCodexHooks(existing, '"C:\\CodexStatus\\hook.cmd"')
  const removed = removeCodexHooks(merged)
  assert.deepEqual(removed, existing)
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
  await uninstallCodexHooks(hooksPath, installDirectory)
  assert.deepEqual(JSON.parse(await fs.readFile(hooksPath, 'utf8')), existing)
  await assert.rejects(fs.access(path.join(installDirectory, 'codex-status-hook.cjs')))
})
