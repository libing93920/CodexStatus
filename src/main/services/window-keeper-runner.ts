import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface CodexCliRequest {
  model: string
  reasoningEffort: 'low'
  prompt: string
}

export interface CodexCliRunner {
  run(request: CodexCliRequest, signal: AbortSignal): Promise<void>
}

export function createCodexCliRunner(): CodexCliRunner {
  return {
    run: (request, signal) => runCodexExec(request, signal)
  }
}

async function runCodexExec(request: CodexCliRequest, signal: AbortSignal): Promise<void> {
  const executable = resolveCodexExecutable()
  const outputPath = path.join(os.tmpdir(), `codex-status-window-keeper-${randomUUID()}.txt`)
  const nodePty = await loadNodePty()
  const ptyProcess = nodePty.spawn(executable, buildCodexExecArgs(request, outputPath), {
    name: 'xterm-color',
    cols: 80,
    rows: 24,
    cwd: os.homedir(),
    env: buildCodexCliEnvironment(process.env)
  })

  try {
    const exitCode = await waitForExit(ptyProcess, signal)
    const finalMessage = await readFinalMessage(outputPath)
    assertCodexExecCompleted(exitCode, finalMessage)
  } finally {
    await fs.unlink(outputPath).catch(() => undefined)
  }
}

export function buildCodexExecArgs(request: CodexCliRequest, outputPath: string): string[] {
  return [
    'exec',
    '--ignore-user-config',
    '--ephemeral',
    '--skip-git-repo-check',
    '--model',
    request.model,
    '--config',
    `model_reasoning_effort=${request.reasoningEffort}`,
    '--output-last-message',
    outputPath,
    request.prompt
  ]
}

export function assertCodexExecCompleted(exitCode: number, finalMessage: string): void {
  if (exitCode !== 0) {
    throw new Error(`Codex CLI exited with code ${exitCode}`)
  }
  if (!finalMessage.trim()) {
    throw new Error('Codex CLI exited without a completed model reply')
  }
}

export function buildCodexCliEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source }
  for (const key of Object.keys(env)) {
    const normalized = key.toUpperCase()
    if (normalized.startsWith('CODEX_') && normalized !== 'CODEX_HOME') {
      delete env[key]
    }
    if (normalized === 'TERM') {
      delete env[key]
    }
  }
  env.TERM = 'xterm-256color'
  return env
}

function waitForExit(ptyProcess: PtyProcess, signal: AbortSignal): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let settled = false
    const settle = (exitCode?: number, error?: Error): void => {
      if (settled) {
        return
      }
      settled = true
      signal.removeEventListener('abort', handleAbort)
      error ? reject(error) : resolve(exitCode ?? -1)
    }
    const handleAbort = (): void => {
      settle(undefined, new Error('Codex CLI cancelled'))
      ptyProcess.kill()
    }

    ptyProcess.onExit(({ exitCode }) => settle(exitCode))
    signal.addEventListener('abort', handleAbort, { once: true })
    if (signal.aborted) {
      handleAbort()
    }
  })
}

async function readFinalMessage(outputPath: string): Promise<string> {
  try {
    return await fs.readFile(outputPath, 'utf8')
  } catch {
    return ''
  }
}

function resolveCodexExecutable(): string {
  const lookupCommand = process.platform === 'win32' ? 'where.exe' : 'which'
  const candidates = process.platform === 'win32' ? ['codex.exe', 'codex'] : ['codex', 'codex.exe']
  for (const candidate of candidates) {
    const result = spawnSync(lookupCommand, [candidate], {
      encoding: 'utf8',
      windowsHide: true
    })
    if (result.status !== 0) {
      continue
    }
    const executable = selectCodexExecutablePath(
      String(result.stdout)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    )
    if (executable) {
      return executable
    }
  }
  throw new Error(
    process.platform === 'win32'
      ? 'Codex CLI executable or Windows shim not found on PATH'
      : 'Codex CLI not found on PATH'
  )
}

export function selectCodexExecutablePath(
  candidates: readonly string[],
  platform = process.platform
): string | undefined {
  if (platform !== 'win32') {
    return candidates[0]
  }

  return (
    candidates.find((candidate) => /(^|[\\/])codex\.exe$/i.test(candidate)) ??
    candidates.find((candidate) => /(^|[\\/])codex\.cmd$/i.test(candidate))
  )
}

async function loadNodePty(): Promise<NodePtyModule> {
  return (await import('node-pty')) as unknown as NodePtyModule
}

interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string
      cols: number
      rows: number
      cwd: string
      env: NodeJS.ProcessEnv
    }
  ): PtyProcess
}

interface PtyProcess {
  onExit(listener: (event: { exitCode: number }) => void): void
  kill(): void
}
