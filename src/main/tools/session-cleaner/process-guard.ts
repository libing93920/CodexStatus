import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const PROCESS_TIMEOUT_MS = 15_000
const PROCESS_PROBE = String.raw`
$ErrorActionPreference = 'Stop'
$claudeActive = $false
$piActive = $false
Get-CimInstance Win32_Process | ForEach-Object {
  if ($_.Name -match '^(node|bun)(\.exe)?$' -and -not $_.CommandLine) { throw 'Process command line unavailable' }
  if ($_.Name -match '^(claude)(\.exe)?$' -or
      ($_.Name -match '^(node|bun)(\.exe)?$' -and $_.CommandLine -match '(claude-code|[\\/]claude[\\/]|claude\.js)')) { $claudeActive = $true }
  if ($_.Name -match '^(pi)(\.exe)?$' -or
      ($_.Name -match '^(node|bun)(\.exe)?$' -and $_.CommandLine -match '(pi-coding-agent|[\\/]pi[\\/].*cli)')) { $piActive = $true }
}
@{ claude = $claudeActive; pi = $piActive } | ConvertTo-Json -Compress
`

export async function getRunningAgents(): Promise<{ claude: boolean; pi: boolean }> {
  if (process.platform !== 'win32') throw new Error('首版真实回收仅支持 Windows')
  const { stdout } = await execute(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', PROCESS_PROBE],
    {
      windowsHide: true,
      timeout: PROCESS_TIMEOUT_MS,
      maxBuffer: 4096
    }
  )
  const result = JSON.parse(stdout.trim()) as { claude?: unknown; pi?: unknown }
  if (typeof result.claude !== 'boolean' || typeof result.pi !== 'boolean')
    throw new Error('无法核验 Agent 进程状态')
  return { claude: result.claude, pi: result.pi }
}
