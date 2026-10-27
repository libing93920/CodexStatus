/** 保留顶层弹出窗口的可展开范围，同时让 Windows 维持它与任务栏的层级关系。 */
export const ISLAND_TASKBAR_OWNER_NATIVE = String.raw`
public static class IslandTaskbarOwner {
  const int OwnerIndex = -8;
  const uint OwnerWindow = 4, NextWindow = 2;
  const uint NoSize = 1, NoMove = 2, NoZOrder = 4, NoActivate = 0x10, FrameChanged = 0x20, NoOwnerZOrder = 0x200;
  const int MaxWindows = 4096, ClassCapacity = 128;
  const double DefaultDpi = 96;
  const string OriginalOwnerProperty = "CodexStatus.IslandOriginalOwner";
  static readonly IntPtr NoOriginalOwner = new IntPtr(1);
  static readonly object Gate = new object();
  static long target;
  static uint targetPid;
  static Anchor anchor;
  static string originalOwner;
  public static State Current { get; private set; }
  public class Anchor { public double x, y, width, height; }
  public class State { public string status, owner, originalOwner; public int error; }
  [StructLayout(LayoutKind.Sequential)] struct Point { public int x, y; }
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int left, top, right, bottom; }
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint command);
  [DllImport("user32.dll")] static extern IntPtr GetTopWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd, ref Point point);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr GetProp(IntPtr hwnd, string name);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool SetProp(IntPtr hwnd, string name, IntPtr value);
  [DllImport("kernel32.dll")] static extern void SetLastError(uint error);
  [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW", SetLastError=true)] static extern IntPtr SetOwner64(IntPtr hwnd, int index, IntPtr value);
  [DllImport("user32.dll", EntryPoint="SetWindowLongW", SetLastError=true)] static extern int SetOwner32(IntPtr hwnd, int index, int value);
  [DllImport("user32.dll", SetLastError=true)] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);

  public static void Configure(long handle, uint pid, Anchor rect, string previousOwner) {
    lock (Gate) {
      var hwnd = new IntPtr(handle);
      if (!MatchesPid(hwnd, pid)) return;
      if (target != handle || originalOwner == null) {
        var saved = GetProp(hwnd, OriginalOwnerProperty);
        if (saved == IntPtr.Zero) {
          var previous = String.IsNullOrEmpty(previousOwner)
            ? GetWindow(hwnd, OwnerWindow) : new IntPtr(Int64.Parse(previousOwner));
          saved = previous == IntPtr.Zero ? NoOriginalOwner : previous;
          // 原始关系跟随 HWND 生命周期，探针在首个响应前退出也不会丢失它。
          if (!SetProp(hwnd, OriginalOwnerProperty, saved)) {
            Current = Result("failed", GetWindow(hwnd, OwnerWindow), Marshal.GetLastWin32Error());
            return;
          }
        }
        originalOwner = (saved == NoOriginalOwner ? IntPtr.Zero : saved).ToInt64().ToString();
      }
      target = handle;
      targetPid = pid;
      anchor = rect;
      if (anchor == null) {
        RestoreOriginalOwner();
        return;
      }
      Refresh();
    }
  }

  public static void Refresh() {
    lock (Gate) {
      if (!MatchesPid(new IntPtr(target), targetPid)) return;
      if (anchor == null) { RestoreOriginalOwner(); return; }
      var region = GetAnchorRect(new IntPtr(target), anchor);
      var desired = FindTaskbar(region);
      bool taskbar = desired != IntPtr.Zero;
      if (desired == IntPtr.Zero) {
        var previous = new IntPtr(Int64.Parse(originalOwner));
        desired = IsWindow(previous) ? previous : IntPtr.Zero;
      }
      if (GetWindow(new IntPtr(target), OwnerWindow) == desired) {
        if (Current == null || Current.owner != desired.ToInt64().ToString())
          Current = Result("unchanged", desired, 0);
        if (Current.status != "failed") return;
      }
      // 只检查实际岛区域，扩大后的透明画布不能把旁边窗口误判成内容遮挡。
      if (taskbar && CapsuleWindowProbe.SampleRegion(target, region).nonTaskbarTopmostOccluder != null) return;
      Current = Apply(target, targetPid, desired.ToInt64());
      Current.originalOwner = originalOwner;
    }
  }

  static void RestoreOriginalOwner() {
    var hwnd = new IntPtr(target);
    if (originalOwner == null || !MatchesPid(hwnd, targetPid)) return;
    var desired = new IntPtr(Int64.Parse(originalOwner));
    if (GetWindow(hwnd, OwnerWindow) == desired) {
      Current = Result("unchanged", desired, 0);
      return;
    }
    Current = Apply(target, targetPid, desired.ToInt64());
    Current.originalOwner = originalOwner;
  }

  static bool MatchesPid(IntPtr hwnd, uint expectedPid) {
    uint pid;
    return IsWindow(hwnd) && GetWindowThreadProcessId(hwnd, out pid) != 0 && pid == expectedPid;
  }

  static int[] GetAnchorRect(IntPtr hwnd, Anchor rect) {
    var origin = new Point();
    if (!ClientToScreen(hwnd, ref origin)) return null;
    double scale = GetDpiForWindow(hwnd) / DefaultDpi;
    if (scale <= 0) return null;
    return new int[] { origin.x + (int)Math.Round(rect.x * scale), origin.y + (int)Math.Round(rect.y * scale),
      (int)Math.Round(rect.width * scale), (int)Math.Round(rect.height * scale) };
  }

  static IntPtr FindTaskbar(int[] rect) {
    uint shellPid;
    if (rect == null || GetWindowThreadProcessId(GetShellWindow(), out shellPid) == 0) return IntPtr.Zero;
    var name = new StringBuilder(ClassCapacity);
    var result = IntPtr.Zero;
    double largest = 0;
    int scanned = 0;
    for (var other = GetTopWindow(IntPtr.Zero); other != IntPtr.Zero && scanned++ < MaxWindows; other = GetWindow(other, NextWindow)) {
      if (!IsWindowVisible(other) || !MatchesPid(other, shellPid)) continue;
      name.Clear();
      GetClassName(other, name, name.Capacity);
      if (name.ToString() != "Shell_TrayWnd" && name.ToString() != "Shell_SecondaryTrayWnd") continue;
      Rect bounds;
      if (!GetWindowRect(other, out bounds)) continue;
      double area = Math.Max(0, Math.Min(rect[0] + rect[2], bounds.right) - Math.Max(rect[0], bounds.left))
        * Math.Max(0, Math.Min(rect[1] + rect[3], bounds.bottom) - Math.Max(rect[1], bounds.top));
      if (area > largest) { largest = area; result = other; }
    }
    return result;
  }

  public static State Apply(long handle, uint expectedPid, long ownerHandle) {
    var hwnd = new IntPtr(handle);
    var owner = new IntPtr(ownerHandle);
    if (!MatchesPid(hwnd, expectedPid) || (owner != IntPtr.Zero && !IsWindow(owner)))
      return Result("skipped", GetWindow(hwnd, OwnerWindow), 0);
    SetLastError(0);
    var previous = IntPtr.Size == 8 ? SetOwner64(hwnd, OwnerIndex, owner)
      : new IntPtr(SetOwner32(hwnd, OwnerIndex, owner.ToInt32()));
    int error = previous == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
    if (error != 0) return Result("failed", GetWindow(hwnd, OwnerWindow), error);
    uint flags = NoSize | NoMove | NoActivate | NoOwnerZOrder | FrameChanged;
    if (owner == IntPtr.Zero) flags |= NoZOrder;
    bool refreshed = SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 0, 0, flags);
    error = refreshed ? 0 : Marshal.GetLastWin32Error();
    bool verified = GetWindow(hwnd, OwnerWindow) == owner;
    return Result(refreshed && verified ? (owner == IntPtr.Zero ? "detached" : "bound") : "failed", owner, error);
  }

  static State Result(string status, IntPtr owner, int error) {
    return new State { status = status, owner = owner.ToInt64().ToString(), originalOwner = originalOwner, error = error };
  }
}
`
