import { spawnSync } from 'node:child_process'
import os from 'node:os'

const CLI_MIN_RUNTIME_BEFORE_EXIT_MS = 3_000
const CLI_IDLE_BEFORE_EXIT_MS = 1_500

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
    run: (request, signal) => runCodexCli(request, signal)
  }
}

async function runCodexCli(request: CodexCliRequest, signal: AbortSignal): Promise<void> {
  const executable = resolveCodexExecutable()
  const nodePty = await loadNodePty()
  const args = [
    '--model',
    request.model,
    '--config',
    `model_reasoning_effort=${request.reasoningEffort}`,
    request.prompt
  ]
  const ptyProcess = nodePty.spawn(executable, args, {
    name: 'xterm-color',
    cols: 80,
    rows: 24,
    cwd: os.homedir(),
    env: { ...process.env }
  })

  return new Promise<void>((resolve, reject) => {
    let settled = false
    let idleTimer: NodeJS.Timeout | undefined
    let minRuntimeTimer: NodeJS.Timeout | undefined
    const settle = (error?: Error): void => {
      if (settled) {
        return
      }
      settled = true
      if (idleTimer) {
        clearTimeout(idleTimer)
      }
      if (minRuntimeTimer) {
        clearTimeout(minRuntimeTimer)
      }
      signal.removeEventListener('abort', handleAbort)
      error ? reject(error) : resolve()
    }
    const handleAbort = (): void => {
      try {
        ptyProcess.kill()
      } finally {
        settle(new Error('Codex CLI cancelled'))
      }
    }
    const requestExitWhenIdle = (): void => {
      if (settled) {
        return
      }
      if (idleTimer) {
        clearTimeout(idleTimer)
      }
      idleTimer = setTimeout(() => {
        try {
          ptyProcess.write('\u0004')
        } catch {
          ptyProcess.kill()
        }
      }, CLI_IDLE_BEFORE_EXIT_MS)
    }

    ptyProcess.onData(() => {
      if (minRuntimeTimer === undefined) {
        requestExitWhenIdle()
      }
    })
    ptyProcess.onExit(({ exitCode }) => {
      settle(exitCode === 0 ? undefined : new Error(`Codex CLI exited with code ${exitCode}`))
    })
    signal.addEventListener('abort', handleAbort, { once: true })
    minRuntimeTimer = setTimeout(() => {
      minRuntimeTimer = undefined
      requestExitWhenIdle()
    }, CLI_MIN_RUNTIME_BEFORE_EXIT_MS)
  })
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
  write(data: string): void
  onData(listener: (data: string) => void): void
  onExit(listener: (event: { exitCode: number }) => void): void
  kill(): void
}
