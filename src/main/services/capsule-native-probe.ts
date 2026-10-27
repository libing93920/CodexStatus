import { gzipSync } from 'node:zlib'
import { ISLAND_TASKBAR_OWNER_NATIVE } from './island-taskbar-owner.ts'

/** 独立进程采样 Win32 层级，仅在主进程授权且原生复核异常后重新置顶。 */
export const CAPSULE_NATIVE_PROBE = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using Microsoft.Win32;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class CapsuleWindowProbe {
  const int ExtendedStyle = -20;
  const int TopmostStyle = 0x00000008;
  const int CloakedAttribute = 14;
  const int MaxWindows = 4096;
  const int MaxCandidates = 3;
  const int ClassNameCapacity = 128;
  const uint NextWindow = 2, OwnerWindow = 4;
  const uint NoSize = 0x0001, NoMove = 0x0002, NoActivate = 0x0010, NoOwnerZOrder = 0x0200;
  const uint AppBarGetState = 0x00000004, AppBarAutoHide = 0x00000001;
  const uint MonitorDefaultToNearest = 2;
  const double MinimumVisibleTaskbarRatio = 0.9;
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct MonitorInfo {
    public int cbSize; public Rect rcMonitor, rcWork; public int dwFlags;
  }
  [StructLayout(LayoutKind.Sequential)] struct AppBarData {
    public int cbSize; public IntPtr hWnd; public uint uCallbackMessage, uEdge; public Rect rc; public IntPtr lParam;
  }
  delegate bool EnumChildProc(IntPtr hwnd, IntPtr lParam);
  public class Bounds { public int x, y, width, height; }
  public class WindowInfo {
    public string hwnd;
    public string ownerHwnd;
    public uint pid;
    public string windowClass;
    public bool visible, minimized;
    public bool? topmost;
    public int styleError;
    public int? cloaked;
    public string exStyle;
    public int[] boundsPx;
    public int? zOrder;
  }
  public class Snapshot {
    public WindowInfo capsule, foreground, taskbar;
    public WindowInfo[] overlapCandidates;
    public WindowInfo normalOccluder;
    public WindowInfo topmostOccluder;
    public WindowInfo taskbarOccluder, nonTaskbarTopmostOccluder;
    public Dictionary<string, object> taskbarGeometry;
    public int scanned;
    public bool reachedCapsule;
    public Recovery recovery;
    public IslandTaskbarOwner.State ownerBinding;
  }
  public class Recovery {
    public string status;
    public int error;
    public Snapshot before;
  }
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("kernel32.dll")] static extern void SetLastError(uint error);
  [DllImport("user32.dll", SetLastError=true)] static extern int GetWindowLong(IntPtr hwnd, int index);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr FindWindow(string name, string title);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumChildProc callback, IntPtr lParam);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr GetTopWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint command);
  [DllImport("user32.dll", SetLastError=true)] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
  [DllImport("shell32.dll")] static extern UIntPtr SHAppBarMessage(uint message, ref AppBarData data);

  static WindowInfo ReadWindow(IntPtr hwnd) {
    if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) return null;
    uint pid;
    GetWindowThreadProcessId(hwnd, out pid);
    var name = new StringBuilder(ClassNameCapacity);
    GetClassName(hwnd, name, name.Capacity);
    SetLastError(0);
    int style = GetWindowLong(hwnd, ExtendedStyle);
    int styleError = style == 0 ? Marshal.GetLastWin32Error() : 0;
    int cloaked;
    int result = DwmGetWindowAttribute(hwnd, CloakedAttribute, out cloaked, sizeof(int));
    Rect rect;
    bool hasBounds = GetWindowRect(hwnd, out rect);
    return new WindowInfo {
      hwnd = hwnd.ToInt64().ToString(), pid = pid, windowClass = name.ToString(),
      ownerHwnd = GetWindow(hwnd, OwnerWindow).ToInt64().ToString(),
      visible = IsWindowVisible(hwnd), topmost = styleError == 0 ? (bool?)((style & TopmostStyle) != 0) : null,
      styleError = styleError,
      minimized = IsIconic(hwnd), cloaked = result == 0 ? (int?)cloaked : null,
      exStyle = styleError == 0 ? unchecked((uint)style).ToString("X8") : null,
      boundsPx = hasBounds ? new int[] { rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top } : null
    };
  }

  static bool Overlaps(int[] first, int[] second) {
    return first != null && second != null && first[2] > 0 && first[3] > 0 && second[2] > 0 && second[3] > 0
      && first[0] < second[0] + second[2] && first[0] + first[2] > second[0]
      && first[1] < second[1] + second[3] && first[1] + first[3] > second[1];
  }

  public static Snapshot Sample(long handle) {
    return SampleRegion(handle, null);
  }

  public static Snapshot SampleRegion(long handle, int[] sampledBounds) {
    var hwnd = new IntPtr(handle);
    var state = new Snapshot {
      capsule = ReadWindow(hwnd), foreground = ReadWindow(GetForegroundWindow()),
      taskbar = ReadWindow(FindWindow("Shell_TrayWnd", null)),
      overlapCandidates = new WindowInfo[0], ownerBinding = IslandTaskbarOwner.Current
    };
    state.taskbarGeometry = ReadTaskbarGeometry(state.taskbar);
    if (state.capsule == null || !state.capsule.visible || state.capsule.minimized) return state;
    var candidates = new List<WindowInfo>();
    var visited = new HashSet<IntPtr>();
    // GetWindow 显式读取 Z 序；有界遍历避免窗口销毁/重排导致循环。
    for (var other = GetTopWindow(IntPtr.Zero);
         other != IntPtr.Zero && state.scanned < MaxWindows && visited.Add(other);
         other = GetWindow(other, NextWindow)) {
      int rank = state.scanned++;
      if (other == hwnd) { state.reachedCapsule = true; state.capsule.zOrder = rank; break; }
      if (!IsWindowVisible(other) || IsIconic(other)) continue;
      var info = ReadWindow(other);
      if (info == null || info.cloaked != 0 || !Overlaps(sampledBounds ?? state.capsule.boundsPx, info.boundsPx)) continue;
      info.zOrder = rank;
      if (candidates.Count < MaxCandidates) candidates.Add(info);
      // 候选日志最多三项，但不能因此漏掉排在它们后面的普通遮挡窗口。
      if (state.normalOccluder == null && info.topmost == false && info.pid != state.capsule.pid)
        state.normalOccluder = info;
      // 置顶状态读取失败也暂缓恢复，避免越过未知层级的覆盖窗口。
      if (state.topmostOccluder == null && info.topmost != false)
        state.topmostOccluder = info;
      if (info.topmost != false) {
        if (IsTaskbar(info.windowClass)) {
          if (state.taskbarOccluder == null) state.taskbarOccluder = info;
        } else if (state.nonTaskbarTopmostOccluder == null) state.nonTaskbarTopmostOccluder = info;
      }
    }
    state.overlapCandidates = candidates.ToArray();
    return state;
  }

  static Dictionary<string, object> ReadTaskbarGeometry(WindowInfo taskbar) {
    if (taskbar == null || taskbar.windowClass != "Shell_TrayWnd" || taskbar.boundsPx == null) return null;
    bool autoHide = ReadTaskbarAutoHide();
    var geometry = new Dictionary<string, object> {
      { "bounds", ToBounds(taskbar.boundsPx) },
      { "visible", IsTaskbarCurrentlyVisible(taskbar) },
      { "autoHide", autoHide }
    };
    var notificationArea = ReadNotificationArea(new IntPtr(Int64.Parse(taskbar.hwnd)), taskbar.boundsPx);
    if (notificationArea != null) geometry.Add("notificationArea", notificationArea);
    var dark = ReadTaskbarDarkMode();
    if (dark.HasValue) geometry.Add("dark", dark.Value);
    return geometry;
  }

  static bool IsTaskbarCurrentlyVisible(WindowInfo taskbar) {
    if (!taskbar.visible || taskbar.boundsPx == null) return false;
    var monitorHandle = MonitorFromWindow(new IntPtr(Int64.Parse(taskbar.hwnd)), MonitorDefaultToNearest);
    var monitor = new MonitorInfo { cbSize = Marshal.SizeOf(typeof(MonitorInfo)) };
    if (monitorHandle == IntPtr.Zero || !GetMonitorInfo(monitorHandle, ref monitor)) return false;
    var bounds = taskbar.boundsPx;
    long width = Math.Max(0, Math.Min((long)bounds[0] + bounds[2], monitor.rcMonitor.Right)
      - Math.Max(bounds[0], monitor.rcMonitor.Left));
    long height = Math.Max(0, Math.Min((long)bounds[1] + bounds[3], monitor.rcMonitor.Bottom)
      - Math.Max(bounds[1], monitor.rcMonitor.Top));
    long totalArea = (long)bounds[2] * bounds[3];
    return totalArea > 0 && width * height / (double)totalArea >= MinimumVisibleTaskbarRatio;
  }

  public static Dictionary<string, object> ReadTaskbarGeometry(long handle) {
    return ReadTaskbarGeometry(ReadWindow(new IntPtr(handle)));
  }

  static Bounds ReadNotificationArea(IntPtr taskbar, int[] taskbarBounds) {
    Bounds result = null;
    EnumChildProc callback = delegate(IntPtr child, IntPtr lParam) {
      var name = new StringBuilder(ClassNameCapacity);
      if (GetClassName(child, name, name.Capacity) <= 0 || name.ToString() != "TrayNotifyWnd") return true;
      Rect rect;
      if (!IsWindowVisible(child) || !GetWindowRect(child, out rect)) return true;
      var candidate = new int[] { rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top };
      if (!IsContained(taskbarBounds, candidate)) return true;
      result = ToBounds(candidate);
      return false;
    };
    EnumChildWindows(taskbar, callback, IntPtr.Zero);
    GC.KeepAlive(callback);
    return result;
  }

  static Bounds ToBounds(int[] bounds) {
    return new Bounds { x = bounds[0], y = bounds[1], width = bounds[2], height = bounds[3] };
  }

  static bool IsContained(int[] outer, int[] inner) {
    return outer != null && inner != null && inner[2] > 0 && inner[3] > 0
      && inner[0] >= outer[0] && inner[1] >= outer[1]
      && (long)inner[0] + inner[2] <= (long)outer[0] + outer[2]
      && (long)inner[1] + inner[3] <= (long)outer[1] + outer[3];
  }

  static bool ReadTaskbarAutoHide() {
    var data = new AppBarData { cbSize = Marshal.SizeOf(typeof(AppBarData)) };
    return (SHAppBarMessage(AppBarGetState, ref data).ToUInt64() & AppBarAutoHide) != 0;
  }

  static bool? ReadTaskbarDarkMode() {
    try {
      using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")) {
        if (key == null) return null;
        var value = key.GetValue("SystemUsesLightTheme");
        if (!(value is int)) return null;
        int light = (int)value;
        return light == 0 ? (bool?)true : light == 1 ? (bool?)false : null;
      }
    } catch { return null; }
  }

  public static Snapshot Recover(long handle, uint expectedPid) {
    return RecoverCore(handle, expectedPid, false);
  }

  public static Snapshot RecoverTaskbar(long handle, uint expectedPid) {
    return RecoverCore(handle, expectedPid, true);
  }

  static bool IsTaskbar(string windowClass) {
    return windowClass == "Shell_TrayWnd" || windowClass == "Shell_SecondaryTrayWnd";
  }

  static Snapshot RecoverCore(long handle, uint expectedPid, bool taskbarOnly) {
    var before = Sample(handle);
    var target = before.capsule;
    bool blocked = taskbarOnly
      ? before.taskbarOccluder == null || before.taskbarOccluder.topmost != true || before.nonTaskbarTopmostOccluder != null
      : before.normalOccluder == null || before.topmostOccluder != null;
    if (target == null || target.pid != expectedPid || !target.visible || target.minimized
        || target.cloaked != 0 || !before.reachedCapsule || blocked) {
      before.recovery = new Recovery { status = "skipped" };
      return before;
    }
    // 不使用 SHOWWINDOW，也不激活、移动、缩放；隐藏中的窗口不会被重新显示。
    bool success = SetWindowPos(new IntPtr(handle), new IntPtr(-1), 0, 0, 0, 0,
      NoSize | NoMove | NoActivate | NoOwnerZOrder);
    int error = success ? 0 : Marshal.GetLastWin32Error();
    var after = Sample(handle);
    bool verified = after.capsule != null && after.capsule.pid == expectedPid
      && after.capsule.visible && !after.capsule.minimized && after.capsule.cloaked == 0
      && after.capsule.topmost == true && after.reachedCapsule
      && (taskbarOnly ? after.taskbarOccluder == null && after.nonTaskbarTopmostOccluder == null : after.normalOccluder == null);
    after.recovery = new Recovery {
      status = !success ? "failed" : verified ? "restored" : "unverified", error = error, before = before
    };
    return after;
  }
}

public static class TaskbarWindowWatcher {
  const uint ForegroundEvent = 0x0003, ShowEvent = 0x8002, ReorderEvent = 0x8004, LocationEvent = 0x800B;
  const uint QuitMessage = 0x0012, OutOfContext = 0;
  const int WindowObject = 0, CoalesceMs = 40, EventCooldownMs = 100, StartupTimeoutMs = 3000;
  static Thread worker;
  static uint threadId;
  static long target;
  static int pending, checking;
  static long lastEventAt = -1;
  static volatile bool stopping;
  static Timer timer;
  static readonly object TimerGate = new object();
  static readonly ManualResetEventSlim Started = new ManualResetEventSlim(false);
  static readonly WinEventProc Callback = OnEvent;
  delegate void WinEventProc(IntPtr hook, uint eventId, IntPtr hwnd, int objectId, int childId, uint eventThread, uint time);
  [StructLayout(LayoutKind.Sequential)] struct Message {
    public IntPtr hwnd; public uint id; public UIntPtr wParam; public IntPtr lParam;
    public uint time; public int x, y; public uint reserved;
  }
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEventProc callback, uint process, uint thread, uint flags);
  [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
  [DllImport("user32.dll")] static extern int GetMessage(out Message message, IntPtr window, uint min, uint max);
  [DllImport("user32.dll")] static extern bool PeekMessage(out Message message, IntPtr window, uint min, uint max, uint remove);
  [DllImport("user32.dll")] static extern bool PostThreadMessage(uint thread, uint message, UIntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref Message message);

  public static void Start(long handle) {
    if (worker != null) return;
    target = handle;
    worker = new Thread(Run) { IsBackground = true };
    worker.Start();
    if (!Started.Wait(StartupTimeoutMs) || threadId == 0) throw new Exception("Cannot watch taskbar Z order");
  }

  static void Run() {
    Message message;
    PeekMessage(out message, IntPtr.Zero, 0, 0, 0);
    threadId = GetCurrentThreadId();
    var callbackHandle = GCHandle.Alloc(Callback);
    var foreground = SetWinEventHook(ForegroundEvent, ForegroundEvent, IntPtr.Zero, Callback, 0, 0, OutOfContext);
    var reorder = SetWinEventHook(ShowEvent, ReorderEvent, IntPtr.Zero, Callback, 0, 0, OutOfContext);
    var location = SetWinEventHook(LocationEvent, LocationEvent, IntPtr.Zero, Callback, 0, 0, OutOfContext);
    try {
      if (foreground == IntPtr.Zero || reorder == IntPtr.Zero || location == IntPtr.Zero) { threadId = 0; return; }
      timer = new Timer(Check, null, Timeout.Infinite, Timeout.Infinite);
      Started.Set();
      while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) DispatchMessage(ref message);
    } finally {
      lock (TimerGate) stopping = true;
      if (foreground != IntPtr.Zero) UnhookWinEvent(foreground);
      if (reorder != IntPtr.Zero) UnhookWinEvent(reorder);
      if (location != IntPtr.Zero) UnhookWinEvent(location);
      if (timer != null) {
        using (var drained = new ManualResetEvent(false)) {
          timer.Dispose(drained);
          drained.WaitOne(StartupTimeoutMs);
        }
      }
      callbackHandle.Free();
      threadId = 0;
      Started.Set();
    }
  }

  static void OnEvent(IntPtr hook, uint eventId, IntPtr hwnd, int objectId, int childId, uint eventThread, uint time) {
    if (stopping || (eventId != ForegroundEvent && objectId != WindowObject)) return;
    if (!AcceptEvent()) return;
    if (Interlocked.CompareExchange(ref pending, 1, 0) == 0) ScheduleCheck();
  }

  static bool AcceptEvent() {
    long now = Stopwatch.GetTimestamp();
    long cooldown = Stopwatch.Frequency * EventCooldownMs / 1000;
    while (true) {
      long previous = Interlocked.Read(ref lastEventAt);
      if (previous >= 0 && now - previous < cooldown) return false;
      if (Interlocked.CompareExchange(ref lastEventAt, now, previous) == previous) return true;
    }
  }

  static void ScheduleCheck() {
    lock (TimerGate) {
      if (!stopping) timer.Change(CoalesceMs, Timeout.Infinite);
    }
  }

  static void Check(object state) {
    if (stopping || Interlocked.CompareExchange(ref checking, 1, 0) != 0) return;
    Interlocked.Exchange(ref pending, 0);
    var previousDpi = CapsuleWindowProbe.SetThreadDpiAwarenessContext(new IntPtr(-4));
    try {
      IslandTaskbarOwner.Refresh();
      var snapshot = CapsuleWindowProbe.Sample(target);
      if (!stopping && snapshot.reachedCapsule && snapshot.taskbarOccluder != null && snapshot.nonTaskbarTopmostOccluder == null)
        Console.WriteLine("{\"event\":\"taskbar-zorder\"}");
    } catch (System.IO.IOException) {
      // 主进程关闭管道后不再发送提示；进程退出会解除原生钩子。
    } finally {
      if (previousDpi != IntPtr.Zero) CapsuleWindowProbe.SetThreadDpiAwarenessContext(previousDpi);
      Interlocked.Exchange(ref checking, 0);
      if (!stopping && Interlocked.CompareExchange(ref pending, 0, 0) != 0)
        ScheduleCheck();
    }
  }

  public static void Stop() {
    lock (TimerGate) stopping = true;
    if (threadId != 0) PostThreadMessage(threadId, QuitMessage, UIntPtr.Zero, IntPtr.Zero);
    if (worker != null) worker.Join(StartupTimeoutMs);
  }
}
${ISLAND_TASKBAR_OWNER_NATIVE}
'@
# 所有原生边界统一使用物理像素；不与 Electron 的 DIP 边界直接比较。
if ([CapsuleWindowProbe]::SetThreadDpiAwarenessContext([IntPtr](-4)) -eq [IntPtr]::Zero) {
  throw 'Cannot establish physical-pixel DPI context'
}
[Console]::WriteLine('ready')
[Console]::Out.Flush()
try {
  while ($null -ne ($request = [Console]::ReadLine())) {
    $command = ConvertFrom-Json -InputObject $request
    if ($command.watchTaskbar -eq $true) {
      $anchor = $null
      if ($null -ne $command.taskbarAnchor) {
        $anchor = [IslandTaskbarOwner+Anchor]@{
          x = [double]$command.taskbarAnchor.x; y = [double]$command.taskbarAnchor.y
          width = [double]$command.taskbarAnchor.width; height = [double]$command.taskbarAnchor.height
        }
      }
      [IslandTaskbarOwner]::Configure([long]$command.hwnd, [uint32]$command.pid, $anchor, [string]$command.originalOwner)
      [TaskbarWindowWatcher]::Start([long]$command.hwnd)
    }
    $snapshot = if ($command.action -eq 'recover-taskbar') {
      [CapsuleWindowProbe]::RecoverTaskbar([long]$command.hwnd, [uint32]$command.pid)
    } elseif ($command.action -eq 'recover') {
      [CapsuleWindowProbe]::Recover([long]$command.hwnd, [uint32]$command.pid)
    } else {
      [CapsuleWindowProbe]::Sample([long]$command.hwnd)
    }
    [Console]::WriteLine((ConvertTo-Json -InputObject $snapshot -Depth 8 -Compress))
    [Console]::Out.Flush()
  }
} finally { [TaskbarWindowWatcher]::Stop() }
`

export function encodeNativeProbe(script: string): string {
  // 原生探针超过 Windows 命令行长度上限，压缩源码后用短启动器加载。
  const compressed = gzipSync(Buffer.from(script, 'utf8')).toString('base64')
  const loader = [
    `$probeStream = [IO.MemoryStream]::new([Convert]::FromBase64String('${compressed}'))`,
    '$probeGzip = [IO.Compression.GzipStream]::new($probeStream, [IO.Compression.CompressionMode]::Decompress)',
    '$probeReader = [IO.StreamReader]::new($probeGzip, [Text.Encoding]::UTF8)',
    'try { & ([ScriptBlock]::Create($probeReader.ReadToEnd())) } finally { $probeReader.Dispose() }'
  ].join('\n')
  return Buffer.from(loader, 'utf16le').toString('base64')
}
