/**
 * The touch watcher's PowerShell script (docs/home-overlay.md, "Touch swipe"): C# compiled with Add-Type that watches
 * touches on a touchscreen and reports the ones that start near the left edge of a monitor, so a swipe from the left
 * opens the in-game overlay.
 *
 * Touches are read through a low-level mouse hook (WH_MOUSE_LL): Windows turns a touch over a game into mouse input
 * marked as touch (dwExtraInfo & 0xFFFFFF80 == 0xFF515780; a pen has 0xFF515700), whichever program has the focus,
 * and the hook sees it in screen pixels on any monitor, rotated or not. The hook only looks; every event goes on to
 * the game unchanged. Its callback does nothing but copy touch events to a queue (a slow hook lags the mouse, and
 * Windows drops a hook that is too slow); a second thread turns them into lines.
 *
 * Windows keeps the outermost strip of the screen for its own edge swipe (on a 1920 px wide screen, the first
 * ~30 px): a touch that starts there never reaches the hook, so the swipe starts a little way in.
 *
 * Output lines:
 *   `{"ready":true,"touch":<bool>}` first; with no touchscreen the hook is never installed and the script only waits.
 *   `d <x> <y> <width> <height> <ms>` a touch went down within the left fifth of its monitor (pixels from the monitor's
 *     top-left corner, the monitor's size, a millisecond clock),
 *   `m <x> <y> <ms>` it moved (at most one line per 15 ms; the last position before the finger lifts is always sent),
 *   `u <ms>` it lifted.
 * Touches starting anywhere else write nothing.
 */
export const TOUCH_SWIPE_CS = String.raw`
using System;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Threading;

public static class PlayOutTouchSwipe {
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int Size; public RECT Monitor, Work; public uint Flags; }
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr Hwnd; public uint Message; public IntPtr W, L; public uint Time; public POINT Pt; }
  delegate IntPtr HookProc(int code, IntPtr w, IntPtr l);
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, HookProc fn, IntPtr mod, uint thread);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);

  struct Ev { public int Msg, X, Y; public long Ms; }
  static readonly ConcurrentQueue<Ev> queue = new ConcurrentQueue<Ev>();
  static readonly AutoResetEvent signal = new AutoResetEvent(false);
  static readonly System.Diagnostics.Stopwatch clock = System.Diagnostics.Stopwatch.StartNew();
  static HookProc keep;

  static IntPtr OnMouse(int code, IntPtr w, IntPtr l) {
    if (code >= 0) {
      ulong extra = (ulong)Marshal.ReadIntPtr(l, IntPtr.Size == 8 ? 24 : 20).ToInt64();
      if ((extra & 0xFFFFFF80UL) == 0xFF515780UL) {
        int msg = w.ToInt32();
        if (msg == 0x200 || msg == 0x201 || msg == 0x202) {
          queue.Enqueue(new Ev { Msg = msg, X = Marshal.ReadInt32(l, 0), Y = Marshal.ReadInt32(l, 4), Ms = clock.ElapsedMilliseconds });
          signal.Set();
        }
      }
    }
    return CallNextHookEx(IntPtr.Zero, code, w, l);
  }

  static void Write(string line) { Console.Out.WriteLine(line); Console.Out.Flush(); }

  // Turns the queued touch events into lines: a stroke runs from the first touch event to the lift (or a second
  // without events, in case the lift was missed).
  static void Writer() {
    bool active = false, wanted = false;
    int left = 0, top = 0, lastX = 0, lastY = 0;
    long lastEvent = 0, lastSent = 0;
    bool unsent = false;
    while (true) {
      signal.WaitOne(250);
      Ev e;
      while (queue.TryDequeue(out e)) {
        if (active && e.Ms - lastEvent > 1000) {
          if (wanted) Write("u " + lastEvent);
          active = false;
        }
        if (!active) {
          active = true; unsent = false;
          var info = new MONITORINFO(); info.Size = Marshal.SizeOf(typeof(MONITORINFO));
          var pt = new POINT { X = e.X, Y = e.Y };
          wanted = GetMonitorInfo(MonitorFromPoint(pt, 2), ref info);
          int width = info.Monitor.R - info.Monitor.L, height = info.Monitor.B - info.Monitor.T;
          left = info.Monitor.L; top = info.Monitor.T;
          wanted = wanted && width > 0 && height > 0 && (e.X - left) * 5 <= width;
          if (wanted) { Write("d " + (e.X - left) + " " + (e.Y - top) + " " + width + " " + height + " " + e.Ms); lastSent = e.Ms; }
        } else if (wanted) {
          lastX = e.X - left; lastY = e.Y - top;
          if (e.Msg == 0x202 || e.Ms - lastSent >= 15) { Write("m " + lastX + " " + lastY + " " + e.Ms); lastSent = e.Ms; unsent = false; }
          else unsent = true;
        }
        lastEvent = e.Ms;
        if (e.Msg == 0x202) {
          if (wanted) { if (unsent) Write("m " + lastX + " " + lastY + " " + e.Ms); Write("u " + e.Ms); }
          active = false;
        }
      }
      if (active && clock.ElapsedMilliseconds - lastEvent > 1000) {
        if (wanted) Write("u " + lastEvent);
        active = false;
      }
    }
  }

  public static void Run() {
    // The parent closing stdin (quitting, crashing) ends this process instead of leaving the hook in place.
    var watch = new Thread(() => { while (Console.In.ReadLine() != null) { } Environment.Exit(0); });
    watch.IsBackground = true;
    watch.Start();
    // SM_DIGITIZER: NID_INTEGRATED_TOUCH (1) or NID_EXTERNAL_TOUCH (2), and NID_READY (0x80).
    int digitizer = GetSystemMetrics(94);
    bool touch = (digitizer & 0x3) != 0 && (digitizer & 0x80) != 0;
    Write("{\"ready\":true,\"touch\":" + (touch ? "true" : "false") + "}");
    if (!touch) { Thread.Sleep(Timeout.Infinite); return; }
    // Per-monitor aware, so the hook's points and the monitor rectangles are both physical pixels.
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) { }
    var writer = new Thread(Writer);
    writer.IsBackground = true;
    writer.Start();
    keep = OnMouse;
    IntPtr hook = SetWindowsHookEx(14, keep, GetModuleHandle(null), 0);
    if (hook == IntPtr.Zero) throw new Exception("SetWindowsHookEx failed: " + Marshal.GetLastWin32Error());
    // A low-level hook is called on the thread that set it, through its message loop.
    MSG m;
    while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) { }
  }
}
`

/** The whole script, written to `powershell.exe -Command -` (a blank line ends the here-string; see pad-script.ts). */
export function touchSwipeScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `Add-Type -TypeDefinition @'\n${TOUCH_SWIPE_CS}\n'@`,
    '',
    '[PlayOutTouchSwipe]::Run()',
    ''
  ].join('\n')
}
