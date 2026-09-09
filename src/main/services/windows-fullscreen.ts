import { spawn, type ChildProcess } from 'node:child_process'
import readline from 'node:readline'

export interface NativeBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface FullscreenState {
  fullscreen: boolean
  monitor: NativeBounds
}

export class WindowsFullscreenMonitor {
  private child?: ChildProcess
  private readonly onChange: (state: FullscreenState) => void
  private readonly onError?: (message: string) => void

  constructor(onChange: (state: FullscreenState) => void, onError?: (message: string) => void) {
    this.onChange = onChange
    this.onError = onError
  }

  start(): void {
    if (process.platform !== 'win32' || this.child) return
    const encoded = Buffer.from(POWERSHELL_MONITOR, 'utf16le').toString('base64')
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      }
    )
    this.child = child
    const lines = readline.createInterface({ input: child.stdout })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-1_000)
    })
    lines.on('line', (line) => {
      const state = parseFullscreenState(line.replaceAll('\0', ''))
      if (state) this.onChange(state)
    })
    child.once('close', (code) => {
      if (this.child === child) this.child = undefined
      if (code && stderr.trim()) this.onError?.(stderr.trim().slice(-500))
    })
    child.once('error', () => {
      if (this.child === child) this.child = undefined
    })
  }

  stop(): void {
    this.child?.kill()
    this.child = undefined
  }
}

export function isFullscreenWindow(
  windowBounds: NativeBounds,
  monitorBounds: NativeBounds,
  tolerance = 2
): boolean {
  return (
    windowBounds.x <= monitorBounds.x + tolerance &&
    windowBounds.y <= monitorBounds.y + tolerance &&
    windowBounds.x + windowBounds.width >= monitorBounds.x + monitorBounds.width - tolerance &&
    windowBounds.y + windowBounds.height >= monitorBounds.y + monitorBounds.height - tolerance
  )
}

export function parseFullscreenState(line: string): FullscreenState | undefined {
  try {
    const value = JSON.parse(line) as { fullscreen?: unknown; monitor?: unknown }
    const monitor = parseBounds(value.monitor)
    if (typeof value.fullscreen !== 'boolean' || !monitor) return undefined
    return { fullscreen: value.fullscreen, monitor }
  } catch {
    return undefined
  }
}

function parseBounds(value: unknown): NativeBounds | undefined {
  if (!value || typeof value !== 'object') return undefined
  const bounds = value as Record<string, unknown>
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return undefined
  return bounds as unknown as NativeBounds
}

const POWERSHELL_MONITOR = String.raw`
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
Add-Type @'
using System;
using System.Globalization;
using System.Runtime.InteropServices;
public static class CodexStatusWindowProbe {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Auto)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public int dwFlags; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hWnd, int flags);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  public static string GetState() {
    var handle = GetForegroundWindow();
    if (handle == IntPtr.Zero) return null;
    RECT window;
    var monitorHandle = MonitorFromWindow(handle, 2);
    var monitor = new MONITORINFO { cbSize = Marshal.SizeOf(typeof(MONITORINFO)) };
    if (!GetWindowRect(handle, out window) || !GetMonitorInfo(monitorHandle, ref monitor)) return null;
    var full = window.Left <= monitor.rcMonitor.Left + 2 && window.Top <= monitor.rcMonitor.Top + 2
      && window.Right >= monitor.rcMonitor.Right - 2 && window.Bottom >= monitor.rcMonitor.Bottom - 2;
    return string.Format(CultureInfo.InvariantCulture,
      "{{\"fullscreen\":{0},\"monitor\":{{\"x\":{1},\"y\":{2},\"width\":{3},\"height\":{4}}}}}",
      full ? "true" : "false", monitor.rcMonitor.Left, monitor.rcMonitor.Top,
      monitor.rcMonitor.Right - monitor.rcMonitor.Left, monitor.rcMonitor.Bottom - monitor.rcMonitor.Top);
  }
}
'@
$last = ''
while ($true) {
  $json = [CodexStatusWindowProbe]::GetState()
  if ($json -and $json -ne $last) { [Console]::Out.WriteLine($json); [Console]::Out.Flush(); $last = $json }
  Start-Sleep -Milliseconds 500
}
`
