/** 独立进程只读 Win32 状态，避免原生枚举和 PowerShell 启动阻塞 Electron。 */
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
  const int MaxWindows = 512;
  const int MaxCandidates = 3;
  const int ClassNameCapacity = 128;
  delegate bool EnumProc(IntPtr hwnd, IntPtr param);
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
  }
  public class Snapshot {
    public WindowInfo capsule, foreground, taskbar;
    public WindowInfo[] overlapCandidates;
    public int scanned;
    public bool reachedCapsule;
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
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr param);
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
    EnumWindows((other, unused) => {
      if (other == hwnd) { state.reachedCapsule = true; return false; }
      if (!IsWindowVisible(other) || IsIconic(other)) return true;
      if (state.scanned >= MaxWindows) return false;
      state.scanned++;
      if (candidates.Count >= MaxCandidates) return true;
      var info = ReadWindow(other);
      if (info != null && (!info.cloaked.HasValue || info.cloaked.Value == 0)
          && Overlaps(state.capsule.boundsPx, info.boundsPx)) candidates.Add(info);
      return true;
    }, IntPtr.Zero);
    state.overlapCandidates = candidates.ToArray();
    return state;
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
  $snapshot = [CapsuleWindowProbe]::Sample([long]::Parse($request))
  [Console]::WriteLine((ConvertTo-Json -InputObject $snapshot -Depth 5 -Compress))
  [Console]::Out.Flush()
}
`
