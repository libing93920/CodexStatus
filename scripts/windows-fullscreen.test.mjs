/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  isFullscreenWindow,
  parseFullscreenState
} from '../src/main/services/windows-fullscreen.ts'

const monitor = { x: 0, y: 0, width: 1920, height: 1080 }

test('覆盖显示器边界判定全屏，普通最大化不算', () => {
  assert.equal(isFullscreenWindow({ ...monitor }, monitor), true)
  assert.equal(isFullscreenWindow({ x: 0, y: 0, width: 1920, height: 1040 }, monitor), false)
  assert.equal(isFullscreenWindow({ x: -1, y: -1, width: 1922, height: 1082 }, monitor), true)
})

test('监测输出只接受完整布尔值和显示器边界', () => {
  assert.deepEqual(
    parseFullscreenState(
      '{"fullscreen":true,"windowClass":"Chrome_WidgetWin_1","monitor":{"x":-1920,"y":0,"width":1920,"height":1080}}'
    ),
    {
      fullscreen: true,
      monitor: { x: -1920, y: 0, width: 1920, height: 1080 },
      windowClass: 'Chrome_WidgetWin_1'
    }
  )
  assert.equal(parseFullscreenState('{"fullscreen":"yes"}'), undefined)
})

test('桌面 Shell 不触发全屏抑制', () => {
  const monitor = JSON.stringify({ x: 0, y: 0, width: 1920, height: 1080 })
  for (const windowClass of ['Progman', 'WorkerW']) {
    const state = parseFullscreenState(
      `{"fullscreen":true,"windowClass":"${windowClass}","monitor":${monitor}}`
    )
    assert.deepEqual(state, {
      fullscreen: false,
      monitor: { x: 0, y: 0, width: 1920, height: 1080 },
      windowClass
    })
  }
})

test('缺失窗口类名时保留原几何判定', () => {
  assert.deepEqual(
    parseFullscreenState('{"fullscreen":true,"monitor":{"x":0,"y":0,"width":1920,"height":1080}}'),
    {
      fullscreen: true,
      monitor: { x: 0, y: 0, width: 1920, height: 1080 },
      windowClass: ''
    }
  )
})

test('窗口类名中的控制字符遵循 JSON 转义', () => {
  const state = parseFullscreenState(
    '{"fullscreen":false,"windowClass":"Review\\nNative\\tClass","monitor":{"x":0,"y":0,"width":1920,"height":1080}}'
  )
  assert.equal(state?.windowClass, 'Review\nNative\tClass')
})

const NATIVE_CLASS_NAMES = ['Review\nNative\t"\\Class', 'Review\rNative\u0001Class']

test('原生探测器通过生产转义还原窗口类名', { skip: process.platform !== 'win32' }, () => {
  const source = readFileSync(
    new URL('../src/main/services/windows-fullscreen.ts', import.meta.url),
    'utf8'
  )
  const nativeSource = extractNativeProbeSource(source)
  assert.ok(nativeSource)
  const lines = runNativeClassProbe(nativeSource, NATIVE_CLASS_NAMES)
  assert.equal(lines.length, NATIVE_CLASS_NAMES.length, lines.join('\n'))
  lines.forEach((line, index) => {
    const state = parseFullscreenState(Buffer.from(line, 'base64').toString('utf8'))
    assert.ok(state)
    assert.equal(state.windowClass, NATIVE_CLASS_NAMES[index])
    assert.equal(state.fullscreen, false)
  })
})

const NATIVE_WINDOW_FIXTURE_SOURCE = String.raw`
public static class ReviewNativeFixture {
  public static IntPtr Handle;
  private delegate IntPtr WindowProc(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
  private static readonly WindowProc Procedure = DefWindowProcW;
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  private struct WNDCLASS {
    public uint style; public IntPtr lpfnWndProc; public int cbClsExtra, cbWndExtra;
    public IntPtr hInstance, hIcon, hCursor, hbrBackground;
    public string lpszMenuName, lpszClassName;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] private static extern IntPtr GetModuleHandleW(string name);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern ushort RegisterClassW(ref WNDCLASS wc);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern IntPtr CreateWindowExW(uint ex, string cls, string title, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
  [DllImport("user32.dll")] private static extern IntPtr DefWindowProcW(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
  [DllImport("user32.dll")] private static extern bool DestroyWindow(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern bool UnregisterClassW(string cls, IntPtr instance);
  public static string GetState(string name) {
    var instance = GetModuleHandleW(null);
    var wc = new WNDCLASS { lpfnWndProc = Marshal.GetFunctionPointerForDelegate(Procedure), hInstance=instance, lpszClassName=name };
    if (RegisterClassW(ref wc)==0) throw new Exception("RegisterClass error "+Marshal.GetLastWin32Error());
    try {
      Handle=CreateWindowExW(0,name,"Review hidden fixture",0,0,0,100,100,IntPtr.Zero,IntPtr.Zero,instance,IntPtr.Zero);
      if (Handle==IntPtr.Zero) throw new Exception("CreateWindow error "+Marshal.GetLastWin32Error());
      return Convert.ToBase64String(Encoding.UTF8.GetBytes(CodexStatusWindowProbe.GetState()));
    } finally { if (Handle!=IntPtr.Zero) DestroyWindow(Handle); Handle=IntPtr.Zero; UnregisterClassW(name,instance); }
  }
}
`

const extractNativeProbeSource = (source) => source.match(/Add-Type @'\r?\n([\s\S]*?)\r?\n'@/)?.[1]

const runNativeClassProbe = (nativeSource, names) => {
  const powershell = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -TypeDefinition @'",
    nativeSource.replace(
      'var handle = GetForegroundWindow();',
      'var handle = ReviewNativeFixture.Handle;'
    ),
    NATIVE_WINDOW_FIXTURE_SOURCE,
    "'@",
    ...names.map((name) => {
      const encoded = Buffer.from(name).toString('base64')
      return `[Console]::WriteLine([ReviewNativeFixture]::GetState([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))))`
    })
  ].join('\n')
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(powershell, 'utf16le').toString('base64')
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 15_000 }
  )
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout.trim().split(/\r?\n/)
}
