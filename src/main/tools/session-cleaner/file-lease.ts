import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const LEASE_TIMEOUT_MS = 15_000
const LEASE_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$filePath = [Console]::ReadLine() | ConvertFrom-Json
$handle = [System.IO.File]::Open($filePath, [System.IO.FileMode]::Open,
  [System.IO.FileAccess]::Read, ([System.IO.FileShare]::Read -bor [System.IO.FileShare]::Delete))
try {
  [Console]::WriteLine('LOCKED')
  [Console]::Out.Flush()
  [Console]::ReadLine() | Out-Null
} finally { $handle.Dispose() }
`

/** 允许系统回收重命名，同时阻止 Agent 打开写句柄；占用中直接拒绝。 */
export interface RecycleLease {
  release: () => void
  assertHeld: () => void
}

export function acquireRecycleLease(filePath: string): Promise<RecycleLease> {
  if (process.platform !== 'win32') return Promise.reject(new Error('首版回收仅支持 Windows'))
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(LEASE_SCRIPT, 'utf16le').toString('base64')
      ],
      {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )
    let locked = false
    let exited = false
    const lines = createInterface({ input: child.stdout })
    const release = (): void => {
      lines.close()
      child.stdin.end('\n')
    }
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('文件占用核验超时'))
    }, LEASE_TIMEOUT_MS)
    child.stderr.resume()
    child.once('error', () => {
      clearTimeout(timer)
      reject(new Error('无法核验文件占用'))
    })
    child.once('exit', () => {
      exited = true
      clearTimeout(timer)
      lines.close()
      if (!locked) reject(new Error('文件正被使用或无法取得只读保护'))
    })
    lines.on('line', (line) => {
      if (line.trim() !== 'LOCKED' || locked) return
      locked = true
      clearTimeout(timer)
      resolve({
        release,
        assertHeld: () => {
          if (exited) throw new Error('文件保护已失效，取消回收')
        }
      })
    })
    child.stdin.on('error', () => undefined)
    child.stdin.write(`${JSON.stringify(filePath)}\n`)
  })
}
