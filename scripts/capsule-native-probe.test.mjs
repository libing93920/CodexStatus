/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { CAPSULE_NATIVE_PROBE } from '../src/main/services/capsule-native-probe.ts'

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

function runPowershell(script, input) {
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')
    ],
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
    const topmostCovered = await target.request('recover')
    assert.equal(topmostCovered.recovery.status, 'skipped')
    assert.equal(
      topmostCovered.overlapCandidates[0]?.pid,
      blocker.info.pid,
      JSON.stringify(topmostCovered)
    )
    await target.request('normal')
    await blocker.request('normal')
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
    '      [RecoveryFixture]::Change($handle, $request.action)',
    '      $snapshot = [CapsuleWindowProbe]::Sample($handle.ToInt64())',
    '    }',
    '    [Console]::WriteLine((ConvertTo-Json -InputObject $snapshot -Depth 8 -Compress))',
    '  }',
    '} finally { [RecoveryFixture]::DestroyWindow($handle) | Out-Null }'
  ].join('\n')
  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')
    ],
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
    async request(action, pid = info.pid) {
      child.stdin.write(`${JSON.stringify({ action, pid })}\n`)
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
  public static void Change(IntPtr h, string action) {
    if (action == "sample") return;
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
