/** 独立进程采样 Win32 层级，仅在主进程授权且原生复核异常后重新置顶。 */
export const CAPSULE_NATIVE_PROBE = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class CapsuleWindowProbe {
  const int ExtendedStyle = -20;
  const int TopmostStyle = 0x00000008;
  const int CloakedAttribute = 14;
  const int MaxWindows = 4096;
  const int MaxCandidates = 3;
  const int ClassNameCapacity = 128;
  const uint NextWindow = 2;
  const uint NoSize = 0x0001, NoMove = 0x0002, NoActivate = 0x0010, NoOwnerZOrder = 0x0200;
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
  public class WindowInfo {
    public string hwnd;
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
    public int scanned;
    public bool reachedCapsule;
    public Recovery recovery;
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
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr FindWindow(string name, string title);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr GetTopWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint command);
  [DllImport("user32.dll", SetLastError=true)] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);

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
    var hwnd = new IntPtr(handle);
    var state = new Snapshot {
      capsule = ReadWindow(hwnd), foreground = ReadWindow(GetForegroundWindow()),
      taskbar = ReadWindow(FindWindow("Shell_TrayWnd", null)),
      overlapCandidates = new WindowInfo[0]
    };
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
      if (info == null || info.cloaked != 0 || !Overlaps(state.capsule.boundsPx, info.boundsPx)) continue;
      info.zOrder = rank;
      if (candidates.Count < MaxCandidates) candidates.Add(info);
      // 候选日志最多三项，但不能因此漏掉排在它们后面的普通遮挡窗口。
      if (state.normalOccluder == null && info.topmost == false && info.pid != state.capsule.pid)
        state.normalOccluder = info;
      // 置顶状态读取失败也暂缓恢复，避免越过未知层级的覆盖窗口。
      if (state.topmostOccluder == null && info.topmost != false)
        state.topmostOccluder = info;
    }
    state.overlapCandidates = candidates.ToArray();
    return state;
  }

  public static Snapshot Recover(long handle, uint expectedPid) {
    var before = Sample(handle);
    var target = before.capsule;
    if (target == null || target.pid != expectedPid || !target.visible || target.minimized
        || target.cloaked != 0 || !before.reachedCapsule || before.normalOccluder == null
        || before.topmostOccluder != null) {
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
      && after.capsule.topmost == true && after.reachedCapsule && after.normalOccluder == null;
    after.recovery = new Recovery {
      status = !success ? "failed" : verified ? "restored" : "unverified", error = error, before = before
    };
    return after;
  }
}
'@
# 所有原生边界统一使用物理像素；不与 Electron 的 DIP 边界直接比较。
if ([CapsuleWindowProbe]::SetThreadDpiAwarenessContext([IntPtr](-4)) -eq [IntPtr]::Zero) {
  throw 'Cannot establish physical-pixel DPI context'
}
[Console]::WriteLine('ready')
[Console]::Out.Flush()
while ($null -ne ($request = [Console]::ReadLine())) {
  $command = ConvertFrom-Json -InputObject $request
  $snapshot = if ($command.action -eq 'recover') {
    [CapsuleWindowProbe]::Recover([long]$command.hwnd, [uint32]$command.pid)
  } else {
    [CapsuleWindowProbe]::Sample([long]$command.hwnd)
  }
  [Console]::WriteLine((ConvertTo-Json -InputObject $snapshot -Depth 8 -Compress))
  [Console]::Out.Flush()
}
`
