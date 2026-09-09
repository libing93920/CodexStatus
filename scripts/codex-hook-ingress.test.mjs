/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CodexHookIngress } from '../src/main/services/codex-hook-ingress.ts'

const hookPath = path.resolve('resources/hooks/codex-status-hook.cjs')

test('Hook 客户端通过随机管道上报，审批输出空决定', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-status-hook-'))
  const descriptorPath = path.join(directory, 'endpoint.json')
  const events = []
  const ingress = new CodexHookIngress({ descriptorPath, onEvent: (event) => events.push(event) })
  context.after(async () => {
    await ingress.stop()
    await fs.rm(directory, { recursive: true, force: true })
  })
  const endpoint = await ingress.start()
  assert.match(endpoint.pipePath, /codex-status-hook-/)
  assert.equal(endpoint.nonce.length, 64)

  const result = await runHook(descriptorPath, {
    hook_event_name: 'PermissionRequest',
    session_id: 'thread-1',
    turn_id: 'turn-1',
    tool_name: 'Bash',
    tool_input: { command: 'must not persist' }
  })
  await waitFor(() => events.length === 1)
  assert.equal(result.stdout.trim(), '{}')
  assert.equal(events[0].tool_name, 'Bash')
  assert.equal('tool_input' in events[0], false)
})

test('伪造 nonce 被拒绝', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-status-hook-'))
  const descriptorPath = path.join(directory, 'endpoint.json')
  const events = []
  const ingress = new CodexHookIngress({ descriptorPath, onEvent: (event) => events.push(event) })
  context.after(async () => {
    await ingress.stop()
    await fs.rm(directory, { recursive: true, force: true })
  })
  const endpoint = await ingress.start()
  await sendLine(endpoint.pipePath, { nonce: 'wrong', event: hookEvent() })
  assert.equal(events.length, 0)
})

function runHook(descriptorPath, event) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookPath, descriptorPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.once('error', reject)
    child.once('close', (code) =>
      code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr))
    )
    child.stdin.end(JSON.stringify(event))
  })
}

function sendLine(pipePath, message) {
  return new Promise((resolve, reject) => {
    const socket = netConnect(pipePath)
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error('管道响应超时'))
    }, 1_000)
    socket.once('connect', () => socket.end(`${JSON.stringify(message)}\n`))
    socket.once('data', () => {
      clearTimeout(timeout)
      socket.destroy()
      resolve()
    })
    socket.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
  })
}

function netConnect(pipePath) {
  return net.createConnection(pipePath)
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('等待 Hook 事件超时')
}

function hookEvent() {
  return { hook_event_name: 'Stop', session_id: 'thread-1', turn_id: 'turn-1' }
}
