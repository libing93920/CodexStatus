/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import {
  CAPSULE_NATIVE_PROBE,
  encodeNativeProbe
} from '../src/main/services/capsule-native-probe.ts'

const windowsOnly = { skip: process.platform !== 'win32' }

test('生产探测脚本输出就绪和缺失窗口状态，stdin EOF 后退出', windowsOnly, () => {
  const lines = runPowershell(
    CAPSULE_NATIVE_PROBE,
    `${JSON.stringify({ action: 'sample', hwnd: '0', pid: process.pid })}\n`
  )
  assert.equal(lines[0], 'ready')
  const snapshot = JSON.parse(lines[1])
  assert.equal(snapshot.capsule, null)
  assert.deepEqual(snapshot.overlapCandidates, [])
  assert.equal(snapshot.reachedCapsule, false)
  assert.equal(lines.length, 2)
})

test('原生置顶丢失、重叠窗口顺序与候选数量限制来自实际 Win32 窗口', windowsOnly, () => {
  const native = CAPSULE_NATIVE_PROBE.match(/Add-Type @'\r?\n([\s\S]*?)\r?\n'@/)?.[1]
  assert.ok(native)
  const lines = runPowershell(
    [
      "$ErrorActionPreference = 'Stop'",
      "Add-Type @'",
      native,
      NATIVE_FIXTURE,
      "'@",
      '[CapsuleProbeFixture]::Run() | ForEach-Object { ConvertTo-Json -InputObject $_ -Depth 6 -Compress }'
    ].join('\n')
  )
  const [covered, uncovered, demoted, bounded] = lines.map((line) => JSON.parse(line))
  assert.equal(covered.capsule.topmost, true)
  assert.equal(covered.capsule.visible, true)
  assert.deepEqual(covered.capsule.boundsPx, [-20000, -20000, 40, 40])
  assert.equal(covered.overlapCandidates.length, 1)
  assert.equal(covered.overlapCandidates[0].topmost, true)
  assert.equal(covered.topmostOccluder.pid, covered.capsule.pid)
  assert.equal(covered.reachedCapsule, true)
  assert.equal(uncovered.overlapCandidates.length, 0)
  assert.equal(demoted.capsule.topmost, false)
  assert.equal(demoted.overlapCandidates.length, 1)
  assert.equal(demoted.overlapCandidates[0].topmost, false)
  assert.equal(bounded.overlapCandidates.length, 3)
  assert.equal(bounded.reachedCapsule, true)
  assert.ok(bounded.scanned <= 4096)
  assert.match(covered.capsule.windowClass, /Fixture\n"\\Class$/)
  assert.doesNotMatch(lines.join('\n'), /private-document-title|"title"|"url"/)
})

test('任务栏关联请求接受实际锚点结构，窗口已失效时不建立关联且 EOF 可退出', windowsOnly, () => {
  const lines = runPowershell(
    CAPSULE_NATIVE_PROBE,
    `${JSON.stringify({
      action: 'sample',
      hwnd: '0',
      pid: process.pid,
      watchTaskbar: true,
      taskbarAnchor: { x: 198, y: 388, width: 248, height: 48 },
      originalOwner: '0'
    })}\n`
  )
  assert.equal(lines[0], 'ready')
  assert.equal(lines.length, 2)
  const snapshot = JSON.parse(lines[1])
  assert.equal(snapshot.capsule, null)
  assert.equal(snapshot.ownerBinding, null)
})

test('只从有效 TrayNotifyWnd 子窗口返回通知区边界', windowsOnly, () => {
  const native = CAPSULE_NATIVE_PROBE.match(/Add-Type @'\r?\n([\s\S]*?)\r?\n'@/)?.[1]
  assert.ok(native)
  const lines = runPowershell(
    [
      "$ErrorActionPreference = 'Stop'",
      "Add-Type @'",
      native,
      TASKBAR_GEOMETRY_FIXTURE,
      "'@",
      '[CapsuleWindowProbe]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null',
      '$handles = [TaskbarGeometryFixture]::Create()',
      '$visible = [CapsuleWindowProbe]::ReadTaskbarGeometry([long]$handles[0])',
      '[TaskbarGeometryFixture]::Hide([long]$handles[1])',
      '$hidden = [CapsuleWindowProbe]::ReadTaskbarGeometry([long]$handles[0])',
      '[TaskbarGeometryFixture]::Expand([long]$handles[0])',
      '$expanded = [CapsuleWindowProbe]::ReadTaskbarGeometry([long]$handles[0])',
      '[TaskbarGeometryFixture]::Collapse([long]$handles[0])',
      '$collapsed = [CapsuleWindowProbe]::ReadTaskbarGeometry([long]$handles[0])',
      '[Console]::WriteLine((ConvertTo-Json -InputObject @{ visible = $visible; hidden = $hidden; expanded = $expanded; collapsed = $collapsed } -Depth 6 -Compress))',
      '[TaskbarGeometryFixture]::Destroy($handles)'
    ].join('\n')
  )
  const { visible, hidden, expanded, collapsed } = JSON.parse(lines[0])
  assert.deepEqual(visible.bounds, { x: 120, y: 200, width: 320, height: 64 })
  assert.deepEqual(visible.notificationArea, { x: 240, y: 208, width: 180, height: 48 })
  assert.equal(typeof visible.autoHide, 'boolean')
  assert.equal(visible.visible, true)
  if ('dark' in visible) assert.equal(typeof visible.dark, 'boolean')
  assert.equal(Object.hasOwn(hidden, 'notificationArea'), false)
  assert.equal(expanded.visible, true)
  if (expanded.autoHide) assert.equal(expanded.visible, true)
  assert.equal(collapsed.visible, false)
})

function runPowershell(script, input) {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeNativeProbe(script)],
    { input, encoding: 'utf8', windowsHide: true, timeout: 20_000 }
  )
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout)
  return result.stdout.trim().split(/\r?\n/)
}

test(
  '跨进程普通遮挡可恢复，执行前复核隐藏、PID 和遮挡状态且不抢焦点',
  { ...windowsOnly, timeout: 20_000 },
  async (context) => {
    const target = await startFixture(context)
    const blocker = await startFixture(context)
    await target.request('normal')
    await blocker.request('normal')
    // 后台进程提到组顶不保证相对顺序，显式把自建目标放到遮挡窗口之后。
    await target.request('behind', target.info.pid, blocker.info.hwnd)
    const covered = await waitForOcclusion(target, blocker.info.pid)
    // 原生窗口验证实际恢复动作；标志仍为 true 的判定另由服务回归测试覆盖。
    assert.equal(covered.capsule.topmost, false)
    assert.ok(covered.normalOccluder, JSON.stringify(covered))
    assert.equal(covered.normalOccluder.pid, blocker.info.pid)
    const restored = await target.request('recover')
    assert.equal(restored.recovery.status, 'restored')
    assert.equal(restored.recovery.error, 0)
    assert.equal(restored.recovery.before.normalOccluder.pid, blocker.info.pid)
    assert.equal(restored.normalOccluder, null)
    assert.deepEqual(restored.capsule.boundsPx, covered.capsule.boundsPx)
    assert.equal(restored.foreground?.hwnd, covered.foreground?.hwnd)

    await blocker.request('topmost')
    await target.request('behind', target.info.pid, blocker.info.hwnd)
    const topmostCovered = await target.request('recover')
    assert.equal(topmostCovered.recovery.status, 'skipped')
    assert.equal(
      topmostCovered.overlapCandidates[0]?.pid,
      blocker.info.pid,
      JSON.stringify(topmostCovered)
    )
    await target.request('normal')
    await blocker.request('normal')
    await target.request('behind', target.info.pid, blocker.info.hwnd)
    await waitForOcclusion(target, blocker.info.pid)
    const wrongPid = await target.request('recover', 0)
    assert.equal(wrongPid.recovery.status, 'skipped')
    assert.equal(wrongPid.capsule.topmost, false)
    const overlay = await startFixture(context)
    await overlay.request('topmost')
    const mixed = await target.request('recover')
    assert.equal(mixed.normalOccluder.pid, blocker.info.pid)
    assert.equal(mixed.topmostOccluder.pid, overlay.info.pid)
    assert.equal(mixed.recovery.status, 'skipped')
    await overlay.request('hide')
    await target.request('hide')
    const hidden = await target.request('recover')
    assert.equal(hidden.recovery.status, 'skipped')
    assert.equal(hidden.capsule.visible, false)
    await target.request('normal')
    await blocker.request('hide')
    const cleared = await target.request('recover')
    assert.equal(cleared.recovery.status, 'skipped')
    assert.equal(cleared.capsule.topmost, false)
  }
)

async function waitForOcclusion(target, blockerPid) {
  // 创建/重排窗口后先等待原生采样确认测试前提；恢复调用及其结果不重试。
  const readinessSamples = 10
  const readinessIntervalMs = 50
  let snapshot
  for (let attempt = 0; attempt < readinessSamples; attempt++) {
    snapshot = await target.request('sample')
    if (snapshot.reachedCapsule && snapshot.normalOccluder?.pid === blockerPid) return snapshot
    await delay(readinessIntervalMs)
  }
  assert.fail(`Fixture occlusion not ready: ${JSON.stringify(snapshot)}`)
}

async function startFixture(context) {
  const native = CAPSULE_NATIVE_PROBE.match(/Add-Type @'\r?\n([\s\S]*?)\r?\n'@/)?.[1]
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type @'",
    native,
    RECOVERY_FIXTURE,
    "'@",
    '[CapsuleWindowProbe]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null',
    '$handle = [RecoveryFixture]::Create()',
    'try {',
    '  [Console]::WriteLine((ConvertTo-Json -Compress @{ hwnd = $handle.ToInt64(); pid = $PID }))',
    '  while ($null -ne ($line = [Console]::ReadLine())) {',
    '    $request = ConvertFrom-Json $line',
    '    if ($request.action -eq "recover") {',
    '      $snapshot = [CapsuleWindowProbe]::Recover($handle.ToInt64(), [uint32]$request.pid)',
    '    } else {',
    '      [RecoveryFixture]::Change($handle, $request.action, [long]$request.after)',
    '      $snapshot = [CapsuleWindowProbe]::Sample($handle.ToInt64())',
    '    }',
    '    [Console]::WriteLine((ConvertTo-Json -InputObject $snapshot -Depth 8 -Compress))',
    '  }',
    '} finally { [RecoveryFixture]::DestroyWindow($handle) | Out-Null }'
  ].join('\n')
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeNativeProbe(script)],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
  )
  let error = ''
  child.stderr.on('data', (chunk) => {
    error += chunk
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
    assert.equal(line.done, false, error)
    return JSON.parse(line.value)
  }
  const info = await read()
  return {
    info,
    async request(action, pid = info.pid, after = 0) {
      child.stdin.write(`${JSON.stringify({ action, pid, after })}\n`)
      return read()
    }
  }
}

const RECOVERY_FIXTURE = String.raw`
public static class RecoveryFixture {
  const uint Popup = 0x80000000, NoActivatePosition = 0x13;
  const int Offscreen = -24000, WindowSize = 40, ShowNoActivate = 4, Hide = 0;
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateWindowExW(uint ex, string cls, string title, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int command);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern bool DestroyWindow(IntPtr h);
  public static IntPtr Create() {
    var h = CreateWindowExW(0, "STATIC", "private-document-title", Popup, Offscreen, Offscreen, WindowSize, WindowSize, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
    if (h == IntPtr.Zero) throw new Exception("Cannot create recovery fixture");
    Change(h, "normal");
    return h;
  }
  public static void Change(IntPtr h, string action, long afterHandle = 0) {
    if (action == "sample") return;
    if (action == "behind") {
      if (!SetWindowPos(h, new IntPtr(afterHandle), 0, 0, 0, 0, NoActivatePosition))
        throw new Exception("Cannot order recovery fixture");
      return;
    }
    if (action == "hide") { ShowWindow(h, Hide); return; }
    ShowWindow(h, ShowNoActivate);
    var after = action == "topmost" ? new IntPtr(-1) : new IntPtr(-2);
    if (!SetWindowPos(h, after, 0, 0, 0, 0, NoActivatePosition)) throw new Exception("Cannot position recovery fixture");
    if (action == "normal" && !SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0, NoActivatePosition))
      throw new Exception("Cannot raise normal fixture");
  }
}
`

// 测试窗口放在屏幕外且从不激活；仅改变自建窗口的层级，不触碰用户应用。
const NATIVE_FIXTURE = String.raw`
public static class CapsuleProbeFixture {
  const uint Topmost = 8;
  const uint Popup = 0x80000000;
  const uint PositionFlags = 0x13;
  const int Offscreen = -20000;
  const int WindowSize = 40;
  const int ShowNoActivate = 4;
  static readonly IntPtr Top = IntPtr.Zero;
  static readonly IntPtr Bottom = new IntPtr(1);
  static readonly IntPtr NotTopmost = new IntPtr(-2);
  static readonly IntPtr TopmostPosition = new IntPtr(-1);
  delegate IntPtr WindowProc(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
  static readonly WindowProc Procedure = DefWindowProcW;
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct WndClass {
    public uint style; public IntPtr procedure; public int classExtra, windowExtra;
    public IntPtr instance, icon, cursor, background;
    public string menuName, className;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandleW(string name);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern ushort RegisterClassW(ref WndClass value);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateWindowExW(uint ex, string cls, string title, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
  [DllImport("user32.dll")] static extern IntPtr DefWindowProcW(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int command);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool UnregisterClassW(string cls, IntPtr instance);

  public static CapsuleWindowProbe.Snapshot[] Run() {
    CapsuleWindowProbe.SetThreadDpiAwarenessContext(new IntPtr(-4));
    var instance = GetModuleHandleW(null);
    string name = "CapsuleDiagFixture\n\"\\Class";
    var cls = new WndClass { procedure = Marshal.GetFunctionPointerForDelegate(Procedure), instance = instance, className = name };
    if (RegisterClassW(ref cls) == 0) throw new Exception("Cannot register fixture");
    var handles = new List<IntPtr>();
    var samples = new List<CapsuleWindowProbe.Snapshot>();
    try {
      for (int index = 0; index < 2; index++) handles.Add(Create(name, instance));
      IntPtr capsule = handles[0], other = handles[1];
      samples.Add(CapsuleWindowProbe.Sample(capsule.ToInt64()));
      Position(other, Bottom);
      samples.Add(CapsuleWindowProbe.Sample(capsule.ToInt64()));
      Position(capsule, NotTopmost);
      Position(other, Top);
      samples.Add(CapsuleWindowProbe.Sample(capsule.ToInt64()));
      Position(capsule, TopmostPosition);
      for (int index = 0; index < 5; index++) handles.Add(Create(name, instance));
      samples.Add(CapsuleWindowProbe.Sample(capsule.ToInt64()));
      return samples.ToArray();
    } finally {
      foreach (var handle in handles) DestroyWindow(handle);
      UnregisterClassW(name, instance);
    }
  }
  static IntPtr Create(string name, IntPtr instance) {
    var h = CreateWindowExW(Topmost, name, "private-document-title", Popup, Offscreen, Offscreen, WindowSize, WindowSize, IntPtr.Zero, IntPtr.Zero, instance, IntPtr.Zero);
    if (h == IntPtr.Zero) throw new Exception("Cannot create fixture");
    ShowWindow(h, ShowNoActivate);
    Position(h, TopmostPosition);
    return h;
  }
  static void Position(IntPtr hwnd, IntPtr after) {
    if (!SetWindowPos(hwnd, after, 0, 0, 0, 0, PositionFlags)) throw new Exception("Cannot position fixture");
  }
}
`

const TASKBAR_GEOMETRY_FIXTURE = String.raw`
public static class TaskbarGeometryFixture {
  const uint Popup = 0x80000000, Child = 0x40000000, Visible = 0x10000000;
  const uint NoActivate = 0x10, MonitorDefaultToNearest = 2;
  const int Show = 5, HideCommand = 0;
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)] struct MonitorInfo { public int size; public Rect monitor, work; public int flags; }
  delegate IntPtr WindowProc(IntPtr hwnd, uint message, IntPtr wp, IntPtr lp);
  static readonly WindowProc Procedure = DefWindowProcW;
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct WndClass {
    public uint style; public IntPtr procedure; public int classExtra, windowExtra;
    public IntPtr instance, icon, cursor, background; public string menuName, className;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandleW(string name);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern ushort RegisterClassW(ref WndClass value);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateWindowExW(uint ex, string cls, string title, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
  [DllImport("user32.dll")] static extern IntPtr DefWindowProcW(IntPtr hwnd, uint message, IntPtr wp, IntPtr lp);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
  [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr hwnd);
  public static long[] Create() {
    var instance = GetModuleHandleW(null);
    var taskbarClass = new WndClass { procedure = Marshal.GetFunctionPointerForDelegate(Procedure), instance = instance, className = "Shell_TrayWnd" };
    var areaClass = new WndClass { procedure = Marshal.GetFunctionPointerForDelegate(Procedure), instance = instance, className = "TrayNotifyWnd" };
    if (RegisterClassW(ref taskbarClass) == 0 || RegisterClassW(ref areaClass) == 0) throw new Exception("Cannot register taskbar geometry fixture");
    var taskbar = CreateWindowExW(0, "Shell_TrayWnd", "", Popup, 120, 200, 320, 64, IntPtr.Zero, IntPtr.Zero, instance, IntPtr.Zero);
    var area = CreateWindowExW(0, "TrayNotifyWnd", "", Child | Visible, 120, 8, 180, 48, taskbar, IntPtr.Zero, instance, IntPtr.Zero);
    if (taskbar == IntPtr.Zero || area == IntPtr.Zero) throw new Exception("Cannot create taskbar geometry fixture");
    ShowWindow(taskbar, Show);
    ShowWindow(area, Show);
    return new long[] { taskbar.ToInt64(), area.ToInt64() };
  }
  public static void Hide(long hwnd) { ShowWindow(new IntPtr(hwnd), HideCommand); }
  public static void Expand(long hwnd) { Place(hwnd, false); }
  public static void Collapse(long hwnd) { Place(hwnd, true); }
  static void Place(long value, bool collapsed) {
    var hwnd = new IntPtr(value);
    var monitor = new MonitorInfo { size = Marshal.SizeOf(typeof(MonitorInfo)) };
    var handle = MonitorFromWindow(hwnd, MonitorDefaultToNearest);
    if (handle == IntPtr.Zero || !GetMonitorInfo(handle, ref monitor)) throw new Exception("Cannot read fixture monitor");
    var y = collapsed ? monitor.monitor.bottom - 2 : monitor.monitor.top + 20;
    if (!SetWindowPos(hwnd, IntPtr.Zero, monitor.monitor.left + 20, y, 320, 64, NoActivate)) throw new Exception("Cannot position taskbar geometry fixture");
  }
  public static void Destroy(long[] windows) { foreach (var hwnd in windows) DestroyWindow(new IntPtr(hwnd)); }
}
`

test(
  '任务栏 Z 序 watcher 与 RecoverTaskbar 仅抬升遮挡灵动岛的自有假任务栏',
  { ...windowsOnly, timeout: 20_000 },
  () => {
    const native = CAPSULE_NATIVE_PROBE.match(/Add-Type @'\r?\n([\s\S]*?)\r?\n'@/)?.[1]
    assert.ok(native)
    const lines = runPowershell(
      [
        "$ErrorActionPreference = 'Stop'",
        "Add-Type @'",
        native,
        TASKBAR_FIXTURE,
        "'@",
        '[CapsuleWindowProbe]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null',
        '$handles = [TaskbarRecoveryFixture]::Create()',
        '$target = $handles[0]',
        'function Write-ProbeSnapshot([string]$step, $snapshot) {',
        '  [Console]::WriteLine((ConvertTo-Json -InputObject @{ step = $step; snapshot = $snapshot } -Depth 8 -Compress))',
        '  [Console]::Out.Flush()',
        '}',
        'try {',
        '  [TaskbarWindowWatcher]::Start($target.ToInt64())',
        "  [Console]::WriteLine('phase:watcher-started'); [Console]::Out.Flush()",
        "  [Console]::WriteLine('phase:primary-start'); [Console]::Out.Flush()",
        "  [TaskbarRecoveryFixture]::Change($handles, 'raise-primary')",
        '  Start-Sleep -Milliseconds 140',
        "  [Console]::WriteLine('phase:primary-end'); [Console]::Out.Flush()",
        "  Write-ProbeSnapshot 'primary-covered' ([CapsuleWindowProbe]::Sample($target.ToInt64()))",
        "  Write-ProbeSnapshot 'primary-recovered' ([CapsuleWindowProbe]::RecoverTaskbar($target.ToInt64(), [uint32]$PID))",
        "  [TaskbarRecoveryFixture]::Change($handles, 'move-primary-away')",
        '  Start-Sleep -Milliseconds 100',
        "  [Console]::WriteLine('phase:secondary-start'); [Console]::Out.Flush()",
        "  [TaskbarRecoveryFixture]::Change($handles, 'raise-secondary')",
        '  Start-Sleep -Milliseconds 140',
        "  [Console]::WriteLine('phase:secondary-end'); [Console]::Out.Flush()",
        "  Write-ProbeSnapshot 'secondary-covered' ([CapsuleWindowProbe]::Sample($target.ToInt64()))",
        "  Write-ProbeSnapshot 'secondary-recovered' ([CapsuleWindowProbe]::RecoverTaskbar($target.ToInt64(), [uint32]$PID))",
        "  [TaskbarRecoveryFixture]::Change($handles, 'move-secondary-away')",
        "  [TaskbarRecoveryFixture]::Change($handles, 'raise-primary')",
        '  Start-Sleep -Milliseconds 140',
        "  [Console]::WriteLine('phase:overlay-start'); [Console]::Out.Flush()",
        "  [TaskbarRecoveryFixture]::Change($handles, 'raise-overlay')",
        '  Start-Sleep -Milliseconds 140',
        "  [Console]::WriteLine('phase:overlay-end'); [Console]::Out.Flush()",
        "  Write-ProbeSnapshot 'overlay-covered' ([CapsuleWindowProbe]::Sample($target.ToInt64()))",
        "  Write-ProbeSnapshot 'overlay-before-recovery' ([CapsuleWindowProbe]::Sample($target.ToInt64()))",
        "  Write-ProbeSnapshot 'overlay-skipped' ([CapsuleWindowProbe]::RecoverTaskbar($target.ToInt64(), [uint32]$PID))",
        "  [TaskbarRecoveryFixture]::Change($handles, 'move-overlay-away')",
        "  Write-ProbeSnapshot 'wrong-pid-before' ([CapsuleWindowProbe]::Sample($target.ToInt64()))",
        "  Write-ProbeSnapshot 'wrong-pid-skipped' ([CapsuleWindowProbe]::RecoverTaskbar($target.ToInt64(), [uint32]0))",
        "  [TaskbarRecoveryFixture]::Change($handles, 'hide-target')",
        "  Write-ProbeSnapshot 'hidden-before' ([CapsuleWindowProbe]::Sample($target.ToInt64()))",
        "  Write-ProbeSnapshot 'hidden-skipped' ([CapsuleWindowProbe]::RecoverTaskbar($target.ToInt64(), [uint32]$PID))",
        '  # 模拟全屏结束后的窗口show与任务栏重排；不启动全屏应用或发送F11。',
        "  [TaskbarRecoveryFixture]::Change($handles, 'show-target')",
        "  Write-ProbeSnapshot 'post-show-topmost' ([CapsuleWindowProbe]::Sample($target.ToInt64()))",
        "  [Console]::WriteLine('phase:post-show-taskbar-start'); [Console]::Out.Flush()",
        "  [TaskbarRecoveryFixture]::Change($handles, 'raise-primary')",
        '  Start-Sleep -Milliseconds 140',
        "  [Console]::WriteLine('phase:post-show-taskbar-end'); [Console]::Out.Flush()",
        "  Write-ProbeSnapshot 'post-show-covered' ([CapsuleWindowProbe]::Sample($target.ToInt64()))",
        "  Write-ProbeSnapshot 'post-show-recovered' ([CapsuleWindowProbe]::RecoverTaskbar($target.ToInt64(), [uint32]$PID))",
        "  [TaskbarRecoveryFixture]::Change($handles, 'minimize-target')",
        "  Write-ProbeSnapshot 'minimized-before' ([CapsuleWindowProbe]::Sample($target.ToInt64()))",
        "  Write-ProbeSnapshot 'minimized-skipped' ([CapsuleWindowProbe]::RecoverTaskbar($target.ToInt64(), [uint32]$PID))",
        "  [TaskbarRecoveryFixture]::Change($handles, 'show-target')",
        "  [TaskbarRecoveryFixture]::Change($handles, 'move-primary-away')",
        "  [TaskbarRecoveryFixture]::Change($handles, 'move-secondary-away')",
        '  Start-Sleep -Milliseconds 100',
        "  Write-ProbeSnapshot 'moved-away-before' ([CapsuleWindowProbe]::Sample($target.ToInt64()))",
        "  Write-ProbeSnapshot 'moved-away-skipped' ([CapsuleWindowProbe]::RecoverTaskbar($target.ToInt64(), [uint32]$PID))",
        '  [TaskbarWindowWatcher]::Stop()',
        '  Start-Sleep -Milliseconds 120',
        "  [Console]::WriteLine('phase:stop-settled'); [Console]::Out.Flush()",
        "  [TaskbarRecoveryFixture]::Change($handles, 'raise-primary')",
        '  Start-Sleep -Milliseconds 180',
        "  [Console]::WriteLine('phase:stopped-raise-end'); [Console]::Out.Flush()",
        "  Write-ProbeSnapshot 'stopped-sample' ([CapsuleWindowProbe]::Sample($target.ToInt64()))",
        '} finally {',
        '  [TaskbarWindowWatcher]::Stop()',
        '  [TaskbarRecoveryFixture]::Destroy($handles) | Out-Null',
        '}'
      ].join('\n')
    )
    const { events, samples } = parseTaskbarProbeOutput(lines)
    assertTaskbarEventBetween(lines, 'primary-start', 'primary-end')
    assertTaskbarEventBetween(lines, 'secondary-start', 'secondary-end')
    assert.equal(taskbarEventCountBetween(lines, 'overlay-start', 'overlay-end'), 0)
    assert.equal(taskbarEventCountBetween(lines, 'stop-settled', 'stopped-raise-end'), 0)
    assert.ok(events >= 2)

    assertTaskbarRestored(
      samples.get('primary-covered'),
      samples.get('primary-recovered'),
      'Shell_TrayWnd'
    )
    assertTaskbarRestored(
      samples.get('secondary-covered'),
      samples.get('secondary-recovered'),
      'Shell_SecondaryTrayWnd'
    )
    const overlay = samples.get('overlay-covered')
    assert.equal(overlay.taskbarOccluder.windowClass, 'Shell_TrayWnd')
    assert.equal(overlay.nonTaskbarTopmostOccluder.windowClass, 'CapsuleTaskbarFixtureOverlay')
    assertTaskbarSkippedWithoutMove(
      samples.get('overlay-before-recovery'),
      samples.get('overlay-skipped')
    )
    assertTaskbarSkippedWithoutMove(
      samples.get('wrong-pid-before'),
      samples.get('wrong-pid-skipped')
    )
    assertTaskbarSkippedWithoutMove(samples.get('hidden-before'), samples.get('hidden-skipped'))
    assert.equal(samples.get('hidden-skipped').capsule.visible, false)
    const postShow = samples.get('post-show-topmost')
    assert.equal(postShow.capsule.visible, true)
    assert.equal(postShow.capsule.topmost, true)
    assert.equal(postShow.taskbarOccluder, null)
    const postShowCovered = samples.get('post-show-covered')
    assert.equal(
      postShowCovered.taskbarOccluder?.windowClass,
      'Shell_TrayWnd',
      JSON.stringify({
        targetZ: postShowCovered.capsule.zOrder,
        taskbarOccluder: postShowCovered.taskbarOccluder,
        phases: lines.filter((line) => line.startsWith('phase:') || line.includes('taskbar-zorder'))
      })
    )
    assertTaskbarEventBetween(lines, 'post-show-taskbar-start', 'post-show-taskbar-end')
    assertTaskbarRestored(postShowCovered, samples.get('post-show-recovered'), 'Shell_TrayWnd')
    assertTaskbarSkippedWithoutMove(
      samples.get('minimized-before'),
      samples.get('minimized-skipped')
    )
    assert.equal(samples.get('minimized-before').capsule.minimized, true)
    assertTaskbarSkippedWithoutMove(
      samples.get('moved-away-before'),
      samples.get('moved-away-skipped')
    )
    assert.equal(samples.get('moved-away-before').taskbarOccluder, null)
    assert.equal(samples.get('stopped-sample').taskbarOccluder.windowClass, 'Shell_TrayWnd')
  }
)

function parseTaskbarProbeOutput(lines) {
  const samples = new Map()
  let events = 0
  for (const line of lines) {
    if (!line.startsWith('{')) continue
    const value = JSON.parse(line)
    if (value.event === 'taskbar-zorder') events++
    else if (value.step) samples.set(value.step, value.snapshot)
  }
  return { events, samples }
}

function taskbarEventCountBetween(lines, start, end) {
  const startIndex = lines.indexOf(`phase:${start}`)
  const endIndex = lines.indexOf(`phase:${end}`)
  assert.ok(startIndex >= 0 && endIndex > startIndex)
  return lines.slice(startIndex + 1, endIndex).filter((line) => {
    try {
      return JSON.parse(line).event === 'taskbar-zorder'
    } catch {
      return false
    }
  }).length
}

function assertTaskbarEventBetween(lines, start, end) {
  assert.ok(
    taskbarEventCountBetween(lines, start, end) > 0,
    `${start} did not notify taskbar z-order`
  )
}

function assertTaskbarRestored(before, after, taskbarClass) {
  assert.equal(before.taskbarOccluder.windowClass, taskbarClass)
  assert.equal(before.nonTaskbarTopmostOccluder, null)
  assert.equal(after.recovery.status, 'restored')
  assert.equal(after.recovery.error, 0)
  assert.deepEqual(after.capsule.boundsPx, before.capsule.boundsPx)
  assert.equal(after.foreground?.hwnd, before.foreground?.hwnd)
  assert.equal(after.capsule.topmost, true)
  assert.equal(after.taskbarOccluder, null)
  assert.equal(after.nonTaskbarTopmostOccluder, null)
  assert.deepEqual(after.recovery.before.capsule.boundsPx, before.capsule.boundsPx)
  assert.equal(after.recovery.before.foreground?.hwnd, before.foreground?.hwnd)
}

function assertTaskbarSkippedWithoutMove(before, after) {
  assert.equal(after.recovery.status, 'skipped')
  assert.deepEqual(after.capsule.boundsPx, before.capsule.boundsPx)
  assert.equal(after.foreground?.hwnd, before.foreground?.hwnd)
}

const TASKBAR_FIXTURE = String.raw`
public static class TaskbarRecoveryFixture {
  const uint Popup = 0x80000000, TopmostStyle = 8, ToolWindow = 0x80, NoActivateStyle = 0x08000000;
  const uint NoSize = 1, NoMove = 2, NoActivate = 0x10;
  const int Offscreen = -20000, Away = -22000, Size = 40, ShowNoActivate = 4, ShowMinNoActivate = 7, Hide = 0;
  static readonly string[] Classes = { "CapsuleTaskbarFixtureTarget", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "CapsuleTaskbarFixtureOverlay" };
  delegate IntPtr WindowProc(IntPtr hwnd, uint message, IntPtr wp, IntPtr lp);
  static readonly WindowProc Procedure = DefWindowProcW;
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct WndClass {
    public uint style; public IntPtr procedure; public int classExtra, windowExtra;
    public IntPtr instance, icon, cursor, background; public string menuName, className;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandleW(string name);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern ushort RegisterClassW(ref WndClass value);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateWindowExW(uint ex, string cls, string title, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
  [DllImport("user32.dll")] static extern IntPtr DefWindowProcW(IntPtr hwnd, uint message, IntPtr wp, IntPtr lp);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool UnregisterClassW(string cls, IntPtr instance);

  public static IntPtr[] Create() {
    var instance = GetModuleHandleW(null);
    var handles = new IntPtr[Classes.Length];
    try {
      foreach (var name in Classes) {
        var cls = new WndClass { procedure = Marshal.GetFunctionPointerForDelegate(Procedure), instance = instance, className = name };
        if (RegisterClassW(ref cls) == 0) throw new Exception("Cannot register taskbar fixture class");
      }
      for (int index = 0; index < Classes.Length; index++) {
        var exStyle = ToolWindow | NoActivateStyle | (index == 0 ? TopmostStyle : 0);
        handles[index] = CreateWindowExW(exStyle, Classes[index], "", Popup, Offscreen, Offscreen, Size, Size, IntPtr.Zero, IntPtr.Zero, instance, IntPtr.Zero);
        if (handles[index] == IntPtr.Zero) throw new Exception("Cannot create taskbar fixture window");
      }
      ShowWindow(handles[0], ShowNoActivate);
      Place(handles[0], Offscreen, Offscreen);
      return handles;
    } catch {
      Destroy(handles);
      throw;
    }
  }

  public static void Change(IntPtr[] windows, string action) {
    if (action == "raise-primary") Raise(windows[1]);
    else if (action == "raise-secondary") Raise(windows[2]);
    else if (action == "raise-overlay") Raise(windows[3]);
    else if (action == "move-primary-away") Place(windows[1], Away, Away);
    else if (action == "move-secondary-away") Place(windows[2], Away, Away);
    else if (action == "move-overlay-away") Place(windows[3], Away, Away);
    else if (action == "hide-target") ShowWindow(windows[0], Hide);
    else if (action == "minimize-target") ShowWindow(windows[0], ShowMinNoActivate);
    else if (action == "show-target") { ShowWindow(windows[0], ShowNoActivate); Place(windows[0], Offscreen, Offscreen); }
    else throw new Exception("Unknown taskbar fixture action");
  }

  static void Raise(IntPtr hwnd) { ShowWindow(hwnd, ShowNoActivate); Place(hwnd, Offscreen, Offscreen); }
  static void Place(IntPtr hwnd, int x, int y) {
    if (!SetWindowPos(hwnd, new IntPtr(-1), x, y, Size, Size, NoActivate)) throw new Exception("Cannot position taskbar fixture window");
  }
  public static void Destroy(IntPtr[] windows) {
    if (windows != null) foreach (var hwnd in windows) if (hwnd != IntPtr.Zero) DestroyWindow(hwnd);
    var instance = GetModuleHandleW(null);
    foreach (var name in Classes) UnregisterClassW(name, instance);
  }
}
`
