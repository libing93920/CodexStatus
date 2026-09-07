import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MAX_DIAGNOSTIC_LENGTH = 1000
const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g')

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
  const command = buildCodexSpawnCommand(executable, buildCodexExecArgs(request, outputPath))
  const childProcess = spawn(command.file, command.args, {
    cwd: os.homedir(),
    env: buildCodexCliEnvironment(process.env),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  const getDiagnostic = captureProcessOutput(childProcess)

  try {
    const exitCode = await waitForExit(childProcess, signal)
    const finalMessage = await readFinalMessage(outputPath)
    assertCodexExecCompleted(exitCode, finalMessage, getDiagnostic())
  } finally {
    await fs.unlink(outputPath).catch(() => undefined)
  }
}

export function buildCodexSpawnCommand(
  executable: string,
  args: readonly string[],
  platform = process.platform,
  comSpec = process.env.ComSpec
): { file: string; args: string[] } {
  if (platform === 'win32' && /\.cmd$/i.test(executable)) {
    return {
      file: comSpec?.trim() || 'cmd.exe',
      args: ['/d', '/c', executable, ...args]
    }
  }
  return { file: executable, args: [...args] }
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

export function assertCodexExecCompleted(
  exitCode: number,
  finalMessage: string,
  diagnostic = ''
): void {
  const normalizedDiagnostic = normalizeDiagnostic(diagnostic)
  const detail = normalizedDiagnostic ? `: ${normalizedDiagnostic}` : ''
  if (exitCode !== 0) {
    throw new Error(`Codex CLI exited with code ${exitCode}${detail}`)
  }
  if (!finalMessage.trim()) {
    throw new Error(`Codex CLI exited without a completed model reply${detail}`)
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
  return env
}

function waitForExit(childProcess: ChildProcess, signal: AbortSignal): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let settled = false
    const settle = (exitCode?: number, error?: Error): void => {
      if (settled) {
        return
      }
      settled = true
      signal.removeEventListener('abort', handleAbort)
      childProcess.removeListener('error', handleError)
      childProcess.removeListener('close', handleClose)
      error ? reject(error) : resolve(exitCode ?? -1)
    }
    const handleAbort = (): void => {
      terminateProcess(childProcess)
      settle(undefined, new Error('Codex CLI cancelled'))
    }
    const handleError = (error: Error): void => settle(undefined, error)
    const handleClose = (exitCode: number | null): void => settle(exitCode ?? -1)

    childProcess.once('error', handleError)
    childProcess.once('close', handleClose)
    signal.addEventListener('abort', handleAbort, { once: true })
    if (signal.aborted) {
      handleAbort()
    }
  })
}

function captureProcessOutput(childProcess: ChildProcess): () => string {
  let stdout = ''
  let stderr = ''
  childProcess.stdout?.on('data', (chunk: Buffer | string) => {
    stdout = appendDiagnostic(stdout, chunk)
  })
  childProcess.stderr?.on('data', (chunk: Buffer | string) => {
    stderr = appendDiagnostic(stderr, chunk)
  })
  return () => normalizeDiagnostic(stderr || stdout)
}

function appendDiagnostic(current: string, chunk: Buffer | string): string {
  return `${current}${String(chunk)}`.slice(-MAX_DIAGNOSTIC_LENGTH * 2)
}

function normalizeDiagnostic(value: string): string {
  return value
    .replace(ANSI_ESCAPE_PATTERN, '')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(access_token|refresh_token)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-MAX_DIAGNOSTIC_LENGTH)
}

function terminateProcess(childProcess: ChildProcess): void {
  if (childProcess.exitCode !== null || childProcess.signalCode !== null) {
    return
  }
  if (process.platform === 'win32' && childProcess.pid !== undefined) {
    spawnSync('taskkill.exe', ['/pid', String(childProcess.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true
    })
    return
  }
  childProcess.kill('SIGTERM')
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
