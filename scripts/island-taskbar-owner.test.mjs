/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import {
  CAPSULE_NATIVE_PROBE,
  encodeNativeProbe
} from '../src/main/services/capsule-native-probe.ts'
import { ISLAND_TASKBAR_OWNER_NATIVE } from '../src/main/services/island-taskbar-owner.ts'

const windowsOnly =
  process.platform !== 'win32'
    ? [{ name: 'Windows PowerShell', path: '', bits: 0 }]
    : resolvePowerShellVariants()

for (const variant of windowsOnly) {
  test(
    `跨进程任务栏 owner 绑定保持层级与隐藏态（${variant.name}）`,
    { skip: process.platform !== 'win32', timeout: 30_000 },
    async (context) => {
      const host = resolveHostPowerShell()
      const target = await startWindowFixture(context, host, 'target')
      const owner = await startWindowFixture(context, host, 'owner')
      const probe = await startOwnerProbe(context, variant.path)

      assert.ok(target.target.entirelyOffMonitor, JSON.stringify(target.target))
      assert.ok(owner.owner.entirelyOffMonitor, JSON.stringify(owner.owner))
      assert.ok(owner.shell.entirelyOffMonitor, JSON.stringify(owner.shell))
      assert.equal(owner.shell.windowClass, 'Shell_TrayWnd')
      assert.notEqual(owner.shell.processId, owner.shellPid)
      const initial = await probe.request({ action: 'sample', hwnd: target.target.hwnd })
      assert.equal(initial.snapshot.capsule.ownerHwnd, '0')
      const wrongPid = await probe.request({
        action: 'apply',
        hwnd: target.target.hwnd,
        pid: target.pid + 1,
        owner: owner.owner.hwnd
      })
      assert.equal(wrongPid.state.status, 'skipped')
      assert.equal(wrongPid.snapshot.capsule.ownerHwnd, '0')
      await delay(60)
      const targetBeforeApply = await probe.request({ action: 'sample', hwnd: target.target.hwnd })
      const ownerBeforeApply = await probe.request({ action: 'sample', hwnd: owner.owner.hwnd })
      assert.equal(
        targetBeforeApply.snapshot.capsule.topmost,
        true,
        JSON.stringify(targetBeforeApply.snapshot.capsule)
      )
      assert.equal(
        ownerBeforeApply.snapshot.capsule.topmost,
        true,
        JSON.stringify(ownerBeforeApply.snapshot.capsule)
      )
      assert.ok(
        targetBeforeApply.snapshot.capsule.zOrder > ownerBeforeApply.snapshot.capsule.zOrder,
        JSON.stringify({
          requirement: 'Fixture must place already-topmost target below owner before Apply',
          target: targetBeforeApply.snapshot.capsule,
          owner: ownerBeforeApply.snapshot.capsule
        })
      )

      const applied = await probe.request({
        action: 'apply',
        hwnd: target.target.hwnd,
        pid: target.pid,
        owner: owner.owner.hwnd
      })
      assert.equal(applied.state.status, 'bound', JSON.stringify(applied.state))
      assert.equal(applied.state.owner, String(owner.owner.hwnd))
      assert.equal(applied.snapshot.capsule.ownerHwnd, String(owner.owner.hwnd))
      assert.equal(applied.snapshot.capsule.pid, target.pid)
      assert.ok(target.target.boundsPx[3] > owner.owner.boundsPx[3])

      const raiseObservations = []
      for (let raise = 0; raise < 3; raise++) {
        await owner.request('raise', owner.owner.hwnd)
        const settleTimes = raise === 0 ? [20, 60, 150, 400] : [60]
        for (const settleMs of settleTimes) {
          await delay(settleMs)
          const targetOrder = await probe.request({ action: 'sample', hwnd: target.target.hwnd })
          const ownerOrder = await probe.request({ action: 'sample', hwnd: owner.owner.hwnd })
          assert.equal(targetOrder.snapshot.capsule.topmost, true)
          assert.equal(ownerOrder.snapshot.capsule.topmost, true)
          raiseObservations.push({
            raise: raise + 1,
            settleMs,
            targetZOrder: targetOrder.snapshot.capsule.zOrder,
            ownerZOrder: ownerOrder.snapshot.capsule.zOrder,
            targetAboveOwner:
              targetOrder.snapshot.capsule.zOrder < ownerOrder.snapshot.capsule.zOrder
          })
        }
      }

      await target.request('hide', target.target.hwnd)
      await owner.request('raise', owner.owner.hwnd)
      await owner.request('minimize', owner.owner.hwnd)
      await owner.request('restore', owner.owner.hwnd)
      const hidden = await probe.request({ action: 'sample', hwnd: target.target.hwnd })
      assert.equal(hidden.snapshot.capsule.visible, false)
      assert.equal(hidden.snapshot.capsule.ownerHwnd, String(owner.owner.hwnd))

      const detached = await probe.request({
        action: 'apply',
        hwnd: target.target.hwnd,
        pid: target.pid,
        owner: 0
      })
      assert.equal(detached.state.status, 'detached', JSON.stringify(detached.state))
      assert.equal(detached.snapshot.capsule.ownerHwnd, '0')

      const anchor = {
        x: owner.shell.boundsPx[0] - target.target.boundsPx[0],
        y: owner.shell.boundsPx[1] - target.target.boundsPx[1],
        width: owner.shell.boundsPx[2],
        height: owner.shell.boundsPx[3]
      }
      assert.ok(anchor.x >= 0 && anchor.y >= 0)
      const fakeShell = await probe.request({
        action: 'configure',
        hwnd: target.target.hwnd,
        pid: target.pid,
        anchor,
        originalOwner: '0'
      })
      assert.notEqual(fakeShell.snapshot.ownerBinding.status, 'bound')
      assert.equal(fakeShell.snapshot.ownerBinding.owner, '0')
      assert.equal(fakeShell.snapshot.ownerBinding.originalOwner, '0')
      assert.equal(fakeShell.snapshot.capsule.ownerHwnd, '0')

      const rebound = await probe.request({
        action: 'apply',
        hwnd: target.target.hwnd,
        pid: target.pid,
        owner: owner.owner.hwnd
      })
      assert.equal(rebound.state.status, 'bound')
      const clearedAnchor = await probe.request({
        action: 'configure',
        hwnd: target.target.hwnd,
        pid: target.pid,
        anchor: null,
        originalOwner: '0'
      })
      assert.equal(clearedAnchor.state.status, 'detached')
      assert.equal(clearedAnchor.state.originalOwner, '0')
      assert.equal(clearedAnchor.snapshot.capsule.ownerHwnd, '0')
      const reboundAfterClear = await probe.request({
        action: 'apply',
        hwnd: target.target.hwnd,
        pid: target.pid,
        owner: owner.owner.hwnd
      })
      assert.equal(reboundAfterClear.state.status, 'bound')
      await probe.stop()
      const restartedProbe = await startOwnerProbe(context, variant.path)
      assert.notEqual(restartedProbe.info.pid, probe.info.pid)
      const originalOwnerRestored = await restartedProbe.request({
        action: 'configure',
        hwnd: target.target.hwnd,
        pid: target.pid,
        anchor,
        originalOwner: ''
      })
      assert.equal(originalOwnerRestored.state.status, 'detached')
      assert.equal(originalOwnerRestored.state.originalOwner, '0')
      assert.equal(originalOwnerRestored.snapshot.capsule.ownerHwnd, '0')
      const reboundAfterRestart = await restartedProbe.request({
        action: 'apply',
        hwnd: target.target.hwnd,
        pid: target.pid,
        owner: owner.owner.hwnd
      })
      assert.equal(reboundAfterRestart.state.status, 'bound')
      await owner.stop()
      const afterOwnerExit = await restartedProbe.request({
        action: 'sample',
        hwnd: target.target.hwnd
      })
      assert.ok(afterOwnerExit.snapshot.capsule)
      assert.equal(afterOwnerExit.snapshot.capsule.ownerHwnd, '0')
      assert.ok(
        raiseObservations.every((observation) => observation.targetAboveOwner),
        JSON.stringify(raiseObservations)
      )
    }
  )
}

function resolvePowerShellVariants() {
  const windowsDirectory = process.env.WINDIR || 'C:\\Windows'
  const powerShellRelative = 'WindowsPowerShell\\v1.0\\powershell.exe'
  const candidates = [
    {
      name: '64-bit helper',
      path: joinWindowsPath(
        windowsDirectory,
        process.arch === 'ia32' ? 'Sysnative' : 'System32',
        powerShellRelative
      ),
      bits: 64
    },
    {
      name: '32-bit helper',
      path: joinWindowsPath(windowsDirectory, 'SysWOW64', powerShellRelative),
      bits: 32
    }
  ]
  return candidates.filter((candidate) => existsSync(candidate.path))
}
function joinWindowsPath(...parts) {
  return parts.join('\\')
}
function resolveHostPowerShell() {
  const variants = resolvePowerShellVariants()
  const variant = variants.find((candidate) => candidate.bits === 64) ?? variants[0]
  if (!variant) throw new Error('Windows PowerShell was not found for fixture window hosts')
  return variant.path
}
async function startWindowFixture(context, powerShell, role) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type @'",
    WINDOW_FIXTURE,
    "'@",
    '[TaskbarOwnerFixture]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null',
    `$handles = [TaskbarOwnerFixture]::Start('${role}')`,
    `$pidValue = $PID`,
    `$windows = @($handles | ForEach-Object { [TaskbarOwnerFixture]::Describe([long]$_) })`,
    "if ('" + role + "' -eq 'target') { $ready = @{ pid = $pidValue; target = $windows[0] } }",
    'else { $ready = @{ pid = $pidValue; owner = $windows[0]; shell = $windows[1]; shellPid = [TaskbarOwnerFixture]::ShellPid() } }',
    '[Console]::WriteLine((ConvertTo-Json -InputObject $ready -Compress -Depth 5))',
    'while ($null -ne ($line = [Console]::ReadLine())) {',
    '  $command = ConvertFrom-Json -InputObject $line',
    "  if ($command.action -eq 'exit') { [Console]::WriteLine((ConvertTo-Json -Compress @{ done = $true })); break }",
    '  [TaskbarOwnerFixture]::Change([long]$command.hwnd, [string]$command.action)',
    '  $state = [TaskbarOwnerFixture]::Describe([long]$command.hwnd)',
    '  [Console]::WriteLine((ConvertTo-Json -InputObject $state -Compress -Depth 5))',
    '}'
  ].join('\n')
  const fixture = await startLineProtocol(context, powerShell, script)
  return {
    ...fixture.info,
    request: (action, hwnd) => fixture.request({ action, hwnd }),
    stop: fixture.stop
  }
}
async function startOwnerProbe(context, powerShell) {
  const native = CAPSULE_NATIVE_PROBE.match(/Add-Type @'\r?\n([\s\S]*?)\r?\n'@/)?.[1]
  assert.ok(native)
  assert.ok(native.includes(ISLAND_TASKBAR_OWNER_NATIVE.trim()))
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type @'",
    native,
    "'@",
    '[CapsuleWindowProbe]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null',
    '[Console]::WriteLine((ConvertTo-Json -Compress @{ ready = $true; pid = $PID }))',
    'try {',
    '  while ($null -ne ($line = [Console]::ReadLine())) {',
    '    $command = ConvertFrom-Json -InputObject $line',
    "    if ($command.action -eq 'exit') { [Console]::WriteLine((ConvertTo-Json -Compress @{ done = $true })); break }",
    '    $state = $null',
    "    if ($command.action -eq 'apply') { $state = [IslandTaskbarOwner]::Apply([long]$command.hwnd, [uint32]$command.pid, [long]$command.owner) }",
    "    elseif ($command.action -eq 'configure') {",
    '      $anchor = $null',
    '      if ($null -ne $command.anchor) { $anchor = [IslandTaskbarOwner+Anchor]@{ x = [double]$command.anchor.x; y = [double]$command.anchor.y; width = [double]$command.anchor.width; height = [double]$command.anchor.height } }',
    '      [IslandTaskbarOwner]::Configure([long]$command.hwnd, [uint32]$command.pid, $anchor, [string]$command.originalOwner)',
    '      $state = [IslandTaskbarOwner]::Current',
    '    }',
    '    $snapshot = [CapsuleWindowProbe]::Sample([long]$command.hwnd)',
    '    [Console]::WriteLine((ConvertTo-Json -InputObject @{ state = $state; snapshot = $snapshot } -Compress -Depth 8))',
    '  }',
    '} finally { [TaskbarWindowWatcher]::Stop() }'
  ].join('\n')
  return startLineProtocol(context, powerShell, script)
}
async function startLineProtocol(context, powerShell, script) {
  const child = spawn(
    powerShell,
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeNativeProbe(script)],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
  )
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  context.after(async () => {
    child.stdin.end()
    if (child.exitCode === null) {
      await once(child, 'exit', { signal: AbortSignal.timeout(5_000) }).catch(() => child.kill())
    }
  })
  async function read() {
    const line = await lines.next()
    assert.equal(line.done, false, stderr)
    return JSON.parse(line.value)
  }
  const info = await read()
  return {
    info,
    async request(command) {
      child.stdin.write(`${JSON.stringify(command)}\n`)
      return read()
    },
    async stop() {
      child.stdin.write('{"action":"exit"}\n')
      await read()
      child.stdin.end()
      if (child.exitCode === null) await once(child, 'exit', { signal: AbortSignal.timeout(5_000) })
    }
  }
}
const WINDOW_FIXTURE = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class TaskbarOwnerFixture {
  const uint Popup = 0x80000000, ToolWindow = 0x80, TopmostStyle = 0x8, NoActivatePosition = 0x13;
  const int ShowNoActivate = 4, Hide = 0, Minimize = 6;
  const uint DefaultMonitorNull = 0;
  static readonly IntPtr Topmost = new IntPtr(-1);
  delegate IntPtr WindowProc(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
  static readonly WindowProc Procedure = DefWindowProcW;
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct WndClass {
    public uint style; public IntPtr procedure; public int classExtra, windowExtra;
    public IntPtr instance, icon, cursor, background; public string menuName, className;
  }
  [StructLayout(LayoutKind.Sequential)] struct Message { public IntPtr hwnd; public uint id; public UIntPtr wParam; public IntPtr lParam; public uint time; public int x, y; public uint reserved; }
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int left, top, right, bottom; }
  public class WindowInfo { public long hwnd; public int[] boundsPx; public bool entirelyOffMonitor; public string windowClass; public uint processId; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandleW(string name);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern ushort RegisterClassW(ref WndClass value);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateWindowExW(uint ex, string cls, string title, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
  [DllImport("user32.dll")] static extern IntPtr DefWindowProcW(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int command);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] static extern int GetMessage(out Message value, IntPtr h, uint min, uint max);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref Message value);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref Message value);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out Rect rect);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder value, int count);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  static readonly ManualResetEvent Ready = new ManualResetEvent(false);
  static long[] Handles;
  static Exception Failure;
  public static long[] Start(string role) {
    var thread = new Thread(delegate() {
      try {
        IntPtr instance = GetModuleHandleW(null);
        int x = GetSystemMetrics(76) - 4096, y = GetSystemMetrics(77) - 4096;
        if (role == "target") Handles = new long[] { Create("CodexIslandOwnerTarget", x, y, 180, 120, instance, true).ToInt64() };
        else Handles = new long[] {
          Create("CodexIslandOwnerFixture", x, y, 120, 40, instance, true).ToInt64(),
          Create("Shell_TrayWnd", x + 400, y, 120, 40, instance, false).ToInt64()
        };
        Ready.Set();
        Message message;
        while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) { TranslateMessage(ref message); DispatchMessage(ref message); }
      } catch (Exception error) { Failure = error; Ready.Set(); }
    });
    thread.IsBackground = true;
    thread.SetApartmentState(ApartmentState.STA);
    thread.Start();
    if (!Ready.WaitOne(5000)) throw new Exception("Fixture window startup timed out");
    if (Failure != null) throw Failure;
    return Handles;
  }
  static IntPtr Create(string className, int x, int y, int width, int height, IntPtr instance, bool topmost) {
    var cls = new WndClass { procedure = Marshal.GetFunctionPointerForDelegate(Procedure), instance = instance, className = className };
    if (RegisterClassW(ref cls) == 0) throw new Exception("Cannot register fixture window class");
    uint exStyle = ToolWindow | (topmost ? TopmostStyle : 0);
    IntPtr hwnd = CreateWindowExW(exStyle, className, "", Popup, x, y, width, height, IntPtr.Zero, IntPtr.Zero, instance, IntPtr.Zero);
    if (hwnd == IntPtr.Zero) throw new Exception("Cannot create fixture window");
    ShowWindow(hwnd, ShowNoActivate);
    return hwnd;
  }
  public static WindowInfo Describe(long value) {
    IntPtr hwnd = new IntPtr(value);
    Rect rect;
    if (!GetWindowRect(hwnd, out rect)) throw new Exception("Cannot query fixture bounds");
    uint pid;
    GetWindowThreadProcessId(hwnd, out pid);
    var name = new StringBuilder(128);
    GetClassNameW(hwnd, name, name.Capacity);
    return new WindowInfo {
      hwnd = value, processId = pid, windowClass = name.ToString(),
      boundsPx = new int[] { rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top },
      entirelyOffMonitor = MonitorFromWindow(hwnd, DefaultMonitorNull) == IntPtr.Zero
    };
  }
  public static uint ShellPid() {
    uint pid;
    return GetWindowThreadProcessId(GetShellWindow(), out pid) == 0 ? 0 : pid;
  }
  public static void Change(long value, string action) {
    IntPtr hwnd = new IntPtr(value);
    if (action == "hide") ShowWindow(hwnd, Hide);
    else if (action == "show") ShowWindow(hwnd, ShowNoActivate);
    else if (action == "minimize") ShowWindow(hwnd, Minimize);
    else if (action == "restore") ShowWindow(hwnd, ShowNoActivate);
    else if (action == "raise" && !SetWindowPos(hwnd, Topmost, 0, 0, 0, 0, NoActivatePosition))
      throw new Exception("Cannot raise fixture owner");
    else if (action != "raise") throw new Exception("Unknown fixture action");
  }
}
`
