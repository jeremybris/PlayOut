import { trimCSharpMembers } from '../performance/memory/trim-cs'

/**
 * The C# behind native-ops.ts, compiled once per worker process with Add-Type (Windows PowerShell 5.1: C# 5 only).
 * Every method returns a JSON string built here, so the TypeScript side parses one known shape.
 *
 * Coordinates are physical pixels: each call switches its thread to per-monitor DPI awareness first, otherwise
 * Windows would scale rectangles for a DPI-unaware powershell.exe and they would not match the monitor's.
 */
export const NATIVE_CS = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class PlayOutNative {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct MONITORINFOEX {
    public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion; public short dmDriverVersion; public short dmSize; public short dmDriverExtra;
    public int dmFields;
    public int dmPositionX; public int dmPositionY; public int dmDisplayOrientation; public int dmDisplayFixedOutput;
    public short dmColor; public short dmDuplex; public short dmYResolution; public short dmTTOption; public short dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels; public int dmBitsPerPel; public int dmPelsWidth; public int dmPelsHeight;
    public int dmDisplayFlags; public int dmDisplayFrequency;
    public int dmICMMethod; public int dmICMIntent; public int dmMediaType; public int dmDitherType;
    public int dmReserved1; public int dmReserved2; public int dmPanningWidth; public int dmPanningHeight;
  }

  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(int pid);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFOEX info);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long creation, out long exit, out long kernel, out long user);
  [DllImport("ntdll.dll")] static extern int NtSuspendProcess(IntPtr h);
  [DllImport("ntdll.dll")] static extern int NtResumeProcess(IntPtr h);
  const uint PROCESS_SUSPEND_RESUME = 0x0800;
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder s, ref int size);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplaySettings(string device, int mode, ref DEVMODE dm);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int ChangeDisplaySettingsEx(string device, ref DEVMODE dm, IntPtr hwnd, uint flags, IntPtr param);

  const int SW_RESTORE = 9;
  const byte VK_MENU = 0x12;
  const uint KEYEVENTF_KEYUP = 2;
  const int ASFW_ANY = -1;
  const uint MONITOR_DEFAULTTONEAREST = 2;
  const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  const int ENUM_CURRENT_SETTINGS = -1;
  const int DM_PELSWIDTH = 0x80000, DM_PELSHEIGHT = 0x100000, DM_DISPLAYFREQUENCY = 0x400000;
  const uint CDS_UPDATEREGISTRY = 1, CDS_TEST = 2;
  const int QUNS_RUNNING_D3D_FULL_SCREEN = 3;
  const int GWL_STYLE = -16;
  const int WS_CAPTION = 0x00C00000;
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);

  static void PerMonitorDpi() {
    // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2; absent before Windows 10 1703, where the call just fails.
    try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) { }
  }

  static string Esc(string s) {
    if (s == null) return "";
    var b = new StringBuilder();
    foreach (char c in s) {
      if (c == '"' || c == '\\') { b.Append('\\'); b.Append(c); }
      else if (c < ' ') b.Append("\\u").Append(((int)c).ToString("x4"));
      else b.Append(c);
    }
    return b.ToString();
  }

  static string Rect(RECT r) {
    return "{\"x\":" + r.Left + ",\"y\":" + r.Top + ",\"width\":" + (r.Right - r.Left) + ",\"height\":" + (r.Bottom - r.Top) + "}";
  }

  // An HWND is a 32-bit value even in 64-bit Windows (it is shared with 32-bit processes), which 64-bit code may see
  // sign-extended. Its low 32 bits as an unsigned decimal are the one spelling both sides agree on (hwndOf in
  // native-ops.ts does the same); turning it back sign-extends, which Windows documents as safe.
  static string HwndText(IntPtr h) {
    return unchecked((uint)h.ToInt64()).ToString();
  }

  static IntPtr HwndOf(string text) {
    return new IntPtr(unchecked((int)(uint)(ulong.Parse(text) & 0xFFFFFFFFUL)));
  }

  static string ExeOf(uint pid) {
    IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (h != IntPtr.Zero) {
      try {
        var sb = new StringBuilder(1024);
        int size = sb.Capacity;
        if (QueryFullProcessImageName(h, 0, sb, ref size)) return sb.ToString();
      } finally { CloseHandle(h); }
    }
    // A protected or elevated process: its name is still known, its folder is not.
    try { return Process.GetProcessById((int)pid).ProcessName + ".exe"; } catch (Exception) { return ""; }
  }

  public static string Foreground() {
    PerMonitorDpi();
    IntPtr h = GetForegroundWindow();
    if (h == IntPtr.Zero) return "null";
    uint pid;
    GetWindowThreadProcessId(h, out pid);
    var title = new StringBuilder(512);
    GetWindowText(h, title, title.Capacity);
    var cls = new StringBuilder(256);
    GetClassName(h, cls, cls.Capacity);
    RECT r;
    GetWindowRect(h, out r);
    var mi = new MONITORINFOEX();
    mi.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
    IntPtr mon = MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST);
    bool hasMon = mon != IntPtr.Zero && GetMonitorInfo(mon, ref mi);
    string c = cls.ToString();
    // The desktop (Progman / WorkerW) covers the monitor too, but nothing is "full screen" there; neither is a
    // maximized window with a title bar, whose frame overhangs the monitor by its border width.
    bool desktop = c == "Progman" || c == "WorkerW";
    bool captioned = (GetWindowLong(h, GWL_STYLE) & WS_CAPTION) == WS_CAPTION;
    bool full = hasMon && !desktop && !captioned && r.Left <= mi.rcMonitor.Left && r.Top <= mi.rcMonitor.Top &&
      r.Right >= mi.rcMonitor.Right && r.Bottom >= mi.rcMonitor.Bottom;
    int quns = 0;
    bool exclusive = false;
    try { exclusive = SHQueryUserNotificationState(out quns) == 0 && quns == QUNS_RUNNING_D3D_FULL_SCREEN; } catch (Exception) { }
    var b = new StringBuilder("{");
    b.Append("\"hwnd\":\"").Append(HwndText(h)).Append("\",\"pid\":").Append(pid);
    b.Append(",\"exe\":\"").Append(Esc(ExeOf(pid))).Append("\",\"title\":\"").Append(Esc(title.ToString()));
    b.Append("\",\"className\":\"").Append(Esc(c)).Append("\",\"rect\":").Append(Rect(r));
    if (hasMon) {
      b.Append(",\"monitor\":{\"device\":\"").Append(Esc(mi.szDevice)).Append("\",\"rect\":").Append(Rect(mi.rcMonitor));
      b.Append(",\"workArea\":").Append(Rect(mi.rcWork)).Append("}");
    } else b.Append(",\"monitor\":null");
    b.Append(",\"fullscreen\":").Append(full ? "true" : "false");
    b.Append(",\"exclusive\":").Append(exclusive ? "true" : "false").Append("}");
    return b.ToString();
  }

  static void AltTap() {
    // A key event makes this process the last one to receive input, which lifts the foreground lock for it.
    keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
    keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
  }

  /**
   * Gives a window the foreground from this background process. Windows refuses SetForegroundWindow to a process
   * that did not receive the last input, so the steps escalate: plain, after an Alt tap, then attached to the
   * foreground thread's input queue. The plain try comes first so a game sees no Alt when it is not needed.
   */
  public static bool Activate(string hwnd) {
    IntPtr h = HwndOf(hwnd);
    if (!IsWindow(h)) return false;
    AllowSetForegroundWindow(ASFW_ANY);
    if (IsIconic(h)) ShowWindow(h, SW_RESTORE);
    if (GetForegroundWindow() == h) return true;
    SetForegroundWindow(h);
    BringWindowToTop(h);
    if (GetForegroundWindow() == h) return true;
    AltTap();
    SetForegroundWindow(h);
    BringWindowToTop(h);
    if (GetForegroundWindow() == h) return true;
    IntPtr fg = GetForegroundWindow();
    uint ignored;
    uint fgThread = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, out ignored);
    uint me = GetCurrentThreadId();
    bool attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
    try {
      BringWindowToTop(h);
      SetForegroundWindow(h);
    } finally {
      if (attached) AttachThreadInput(me, fgThread, false);
    }
    return GetForegroundWindow() == h;
  }

  static string Mode(DEVMODE dm) {
    return "{\"width\":" + dm.dmPelsWidth + ",\"height\":" + dm.dmPelsHeight + ",\"hz\":" + dm.dmDisplayFrequency + ",\"bpp\":" + dm.dmBitsPerPel + "}";
  }

  static DEVMODE NewMode() {
    var dm = new DEVMODE();
    dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
    return dm;
  }

  /** The current mode and every mode the driver lists (duplicates included; TypeScript dedupes and sorts). */
  public static string DisplayModes(string device) {
    var cur = NewMode();
    if (!EnumDisplaySettings(device, ENUM_CURRENT_SETTINGS, ref cur)) return "null";
    var b = new StringBuilder("{\"current\":" + Mode(cur) + ",\"modes\":[");
    var dm = NewMode();
    for (int i = 0; EnumDisplaySettings(device, i, ref dm); i++) {
      if (i > 0) b.Append(',');
      b.Append(Mode(dm));
      dm = NewMode();
    }
    b.Append("]}");
    return b.ToString();
  }

  /**
   * Pause (suspend every thread of) or resume a process. "created" is the process's start time (ms since 1601): a
   * resume names it so a PID reused by another process since is never touched (0 skips the check). Returns
   * {"ok":bool,"created":ticks,"error":"..."}; a process of another user or an elevated one gives "access".
   */
  public static string Pause(uint pid, bool pause, long created) {
    IntPtr h = OpenProcess(PROCESS_SUSPEND_RESUME | PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (h == IntPtr.Zero) return "{\"ok\":false,\"error\":\"access\"}";
    try {
      long c, e, k, u;
      // Milliseconds since 1601: FILETIME ticks do not fit a JavaScript number exactly.
      long start = GetProcessTimes(h, out c, out e, out k, out u) ? c / 10000 : 0;
      if (created != 0 && start != created) return "{\"ok\":false,\"error\":\"gone\"}";
      int status = pause ? NtSuspendProcess(h) : NtResumeProcess(h);
      return "{\"ok\":" + (status == 0 ? "true" : "false") + ",\"created\":" + start + ",\"error\":\"" + (status == 0 ? "" : "status " + status) + "\"}";
    } finally { CloseHandle(h); }
  }

  /** Tests the mode first (CDS_TEST) and only then applies and persists it. 0 = DISP_CHANGE_SUCCESSFUL. */
  public static int SetDisplayMode(string device, int width, int height, int hz) {
    var dm = NewMode();
    if (!EnumDisplaySettings(device, ENUM_CURRENT_SETTINGS, ref dm)) return -100;
    dm.dmPelsWidth = width;
    dm.dmPelsHeight = height;
    dm.dmDisplayFrequency = hz;
    dm.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT | DM_DISPLAYFREQUENCY;
    int test = ChangeDisplaySettingsEx(device, ref dm, IntPtr.Zero, CDS_TEST, IntPtr.Zero);
    if (test != 0) return test;
    return ChangeDisplaySettingsEx(device, ref dm, IntPtr.Zero, CDS_UPDATEREGISTRY, IntPtr.Zero);
  }
}
`

/**
 * RivaTuner Statistics Server's shared memory (RTSSSharedMemoryV2, SDK RTSSSharedMemory.h v2.x) and Windows' HDR state,
 * compiled in the same worker as PlayOutNative (native-cs.ts) but in its own Add-Type with /unsafe: the OSD lock and
 * the profile-reload flag are interlocked operations on the mapped memory, exactly as RTSS and its SDK sample do them.
 * RTSSHooks64.dll is never loaded: its UpdateProfiles export only sets a flag on every app entry, done here instead.
 */
export const RTSS_CS = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class PlayOutRtss {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Ansi, BestFitMapping = false)]
  static extern IntPtr OpenFileMappingA(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr MapViewOfFile(IntPtr h, uint access, uint offsetHigh, uint offsetLow, UIntPtr bytes);
  [DllImport("kernel32.dll")] static extern bool UnmapViewOfFile(IntPtr p);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern UIntPtr VirtualQuery(IntPtr address, out MBI info, UIntPtr length);

  [StructLayout(LayoutKind.Sequential)]
  struct MBI {
    public IntPtr BaseAddress; public IntPtr AllocationBase; public uint AllocationProtect;
    public UIntPtr RegionSize; public uint State; public uint Protect; public uint Type;
  }

  const string Name = "RTSSSharedMemoryV2";
  const uint FILE_MAP_WRITE = 2, FILE_MAP_READ = 4;
  const uint Signature = 0x52545353;
  const uint ProfileUpdate = 0x10000000;
  // Header: signature, version, app entry size / array offset / count, OSD entry size / array offset / count,
  // OSD frame, busy (v2.14+) ... last foreground app pid at 0x44 (v2.16+).
  const int H_VERSION = 0x04, H_APP_SIZE = 0x08, H_APP_OFF = 0x0C, H_APP_COUNT = 0x10;
  const int H_OSD_SIZE = 0x14, H_OSD_OFF = 0x18, H_OSD_COUNT = 0x1C, H_OSD_FRAME = 0x20, H_BUSY = 0x24, H_FG_PID = 0x44;
  // App entry: pid, szName[260], flags, time0, time1, frames, frame time (us).
  const int A_NAME = 0x04, A_FLAGS = 0x108, A_TIME0 = 0x10C, A_TIME1 = 0x110, A_FRAMES = 0x114, A_FRAMETIME = 0x118;
  // OSD entry: szOSD[256], szOSDOwner[256], szOSDEx[4096] (v2.7+).
  const int O_OWNER = 0x100, O_EX = 0x200, OWNER_LEN = 256, OSD_LEN = 256, EX_LEN = 4096;

  sealed class View : IDisposable {
    public IntPtr H, P;
    public long Size;
    public uint U(long off) { return (uint)Marshal.ReadInt32(new IntPtr(P.ToInt64() + off)); }
    public IntPtr At(long off) { return new IntPtr(P.ToInt64() + off); }
    public void Dispose() {
      if (P != IntPtr.Zero) UnmapViewOfFile(P);
      if (H != IntPtr.Zero) CloseHandle(H);
      P = IntPtr.Zero; H = IntPtr.Zero;
    }
  }

  // The mapping, or null when RTSS is not running (or the memory is not RTSS v2.x).
  static View Open(bool write) {
    uint access = write ? (FILE_MAP_READ | FILE_MAP_WRITE) : FILE_MAP_READ;
    IntPtr h = OpenFileMappingA(access, false, Name);
    if (h == IntPtr.Zero) return null;
    View v = new View();
    v.H = h;
    v.P = MapViewOfFile(h, access, 0, 0, UIntPtr.Zero);
    if (v.P == IntPtr.Zero) { v.Dispose(); return null; }
    MBI m;
    if (VirtualQuery(v.P, out m, (UIntPtr)Marshal.SizeOf(typeof(MBI))) == UIntPtr.Zero) { v.Dispose(); return null; }
    v.Size = (long)m.RegionSize.ToUInt64();
    if (v.Size < 0x48 || v.U(0) != Signature || v.U(H_VERSION) < 0x00020000) { v.Dispose(); return null; }
    return v;
  }

  // An array that fits the mapping: entries of at least minEntry bytes.
  static bool Fits(View v, int sizeAt, int offAt, int countAt, long minEntry) {
    long size = v.U(sizeAt), off = v.U(offAt), count = v.U(countAt);
    return size >= minEntry && off >= 0x48 && count <= 4096 && off + size * count <= v.Size;
  }

  static string ReadAnsi(View v, long off, int max) {
    byte[] b = new byte[max];
    Marshal.Copy(v.At(off), b, 0, max);
    int n = Array.IndexOf(b, (byte)0);
    return Encoding.Default.GetString(b, 0, n < 0 ? max : n);
  }

  static void WriteAnsi(View v, long off, string text, int max) {
    byte[] b = Encoding.Default.GetBytes(text ?? "");
    int n = Math.Min(b.Length, max - 1);
    Marshal.Copy(b, 0, v.At(off), n);
    Marshal.WriteByte(v.At(off + n), 0);
  }

  static void Clear(View v, long off, int len) {
    Marshal.Copy(new byte[len], 0, v.At(off), len);
  }

  static string Esc(string s) {
    StringBuilder b = new StringBuilder();
    foreach (char c in s ?? "") {
      if (c == '"' || c == '\\') { b.Append('\\'); b.Append(c); }
      else if (c < ' ') b.Append("\\u").Append(((int)c).ToString("x4"));
      else b.Append(c);
    }
    return b.ToString();
  }

  // Sets bits in a DWORD of the mapping atomically; false when a bit of "unless" was already set (nothing changed).
  static unsafe bool SetBits(View v, long off, int bits, int unless) {
    int* p = (int*)v.At(off).ToPointer();
    for (int i = 0; i < 1000; i++) {
      int old = Thread.VolatileRead(ref *p);
      if ((old & unless) != 0) return false;
      if (Interlocked.CompareExchange(ref *p, old | bits, old) == old) return true;
    }
    return false;
  }

  static unsafe void Store(View v, long off, int value) {
    int* p = (int*)v.At(off).ToPointer();
    Interlocked.Exchange(ref *p, value);
  }

  static unsafe void Increment(View v, long off) {
    int* p = (int*)v.At(off).ToPointer();
    Interlocked.Increment(ref *p);
  }

  /** {version, foregroundPid, tick, apps:[{pid,name,flags,time0,time1,frames,frameTimeUs}]} or null (read-only). */
  public static string Snapshot() {
    using (View v = Open(false)) {
      if (v == null) return "null";
      uint version = v.U(H_VERSION);
      StringBuilder b = new StringBuilder();
      b.Append("{\"version\":").Append(version).Append(",\"foregroundPid\":");
      if (version >= 0x00020010) b.Append(v.U(H_FG_PID)); else b.Append("null");
      // GetTickCount, the clock of time0/time1: TS treats an entry whose window ended long ago as not measured.
      b.Append(",\"tick\":").Append(unchecked((uint)Environment.TickCount));
      b.Append(",\"apps\":[");
      if (Fits(v, H_APP_SIZE, H_APP_OFF, H_APP_COUNT, A_FRAMETIME + 4)) {
        long size = v.U(H_APP_SIZE), off = v.U(H_APP_OFF), count = v.U(H_APP_COUNT);
        bool first = true;
        for (long i = 0; i < count; i++) {
          long e = off + i * size;
          uint pid = v.U(e);
          if (pid == 0) continue;
          if (!first) b.Append(',');
          first = false;
          b.Append("{\"pid\":").Append(pid);
          b.Append(",\"name\":\"").Append(Esc(ReadAnsi(v, e + A_NAME, 260))).Append('"');
          b.Append(",\"flags\":").Append(v.U(e + A_FLAGS));
          b.Append(",\"time0\":").Append(v.U(e + A_TIME0));
          b.Append(",\"time1\":").Append(v.U(e + A_TIME1));
          b.Append(",\"frames\":").Append(v.U(e + A_FRAMES));
          b.Append(",\"frameTimeUs\":").Append(v.U(e + A_FRAMETIME)).Append('}');
        }
      }
      b.Append("]}");
      return b.ToString();
    }
  }

  // The dwBusy lock (v2.14+), as the SDK sample takes it; a few short tries before giving up this tick.
  static bool Lock(View v) {
    if (v.U(H_VERSION) < 0x0002000E) return true;
    for (int i = 0; i < 20; i++) {
      if (SetBits(v, H_BUSY, 1, 1)) return true;
      Thread.Sleep(1);
    }
    return false;
  }

  static void Unlock(View v) {
    if (v.U(H_VERSION) >= 0x0002000E) Store(v, H_BUSY, 0);
  }

  /**
   * Writes text into the OSD slot of owner (claiming the first free one from index 1: slot 0 is Afterburner's), or
   * with text null clears and frees it (even while the lock is busy). {ok, slot} or
   * {ok:false, error:'missing'|'busy'|'full'}; a write that answers 'busy' may already have claimed a slot.
   */
  public static string Osd(string owner, string text) {
    if (string.IsNullOrEmpty(owner) || owner.Length > 31) return "{\"ok\":false,\"error\":\"owner\"}";
    using (View v = Open(true)) {
      if (v == null || !Fits(v, H_OSD_SIZE, H_OSD_OFF, H_OSD_COUNT, O_OWNER + OWNER_LEN)) return "{\"ok\":false,\"error\":\"missing\"}";
      long size = v.U(H_OSD_SIZE), off = v.U(H_OSD_OFF), count = v.U(H_OSD_COUNT);
      bool ex = size >= O_EX + EX_LEN;
      long slot = -1;
      for (long i = 1; i < count && slot < 0; i++)
        if (ReadAnsi(v, off + i * size + O_OWNER, OWNER_LEN) == owner) slot = i;
      if (slot < 0) {
        if (text == null) return "{\"ok\":true}";
        for (long i = 1; i < count && slot < 0; i++) {
          long e = off + i * size;
          if (ReadAnsi(v, e + O_OWNER, OWNER_LEN).Length == 0) {
            WriteAnsi(v, e + O_OWNER, owner, OWNER_LEN);
            slot = i;
          }
        }
        if (slot < 0) return "{\"ok\":false,\"error\":\"full\"}";
      }
      long entry = off + slot * size;
      if (text == null) {
        // Freeing never depends on the lock (the SDK's ReleaseOSD zeroes the whole entry without it): a busy lock
        // must not leave PlayOut's last text drawn in every hooked app. The lock is still taken when it can be.
        bool locked = Lock(v);
        try {
          Clear(v, entry, (int)Math.Min(size, (long)int.MaxValue));
        } finally {
          if (locked) Unlock(v);
        }
        Increment(v, H_OSD_FRAME);
        return "{\"ok\":true,\"slot\":" + slot + "}";
      }
      if (!Lock(v)) return "{\"ok\":false,\"error\":\"busy\"}";
      try {
        if (ex) WriteAnsi(v, entry + O_EX, text, EX_LEN);
        else WriteAnsi(v, entry, text, OSD_LEN);
      } finally {
        Unlock(v);
      }
      Increment(v, H_OSD_FRAME);
      return "{\"ok\":true,\"slot\":" + slot + "}";
    }
  }

  /** RTSSHooks64.dll UpdateProfiles' work: every hooked app reloads its profile. {ok, flagged}. */
  public static string RequestProfileUpdate() {
    using (View v = Open(true)) {
      if (v == null || !Fits(v, H_APP_SIZE, H_APP_OFF, H_APP_COUNT, A_FLAGS + 4)) return "{\"ok\":false,\"flagged\":0}";
      long size = v.U(H_APP_SIZE), off = v.U(H_APP_OFF), count = v.U(H_APP_COUNT);
      int n = 0;
      for (long i = 0; i < count; i++) {
        long e = off + i * size;
        if (v.U(e) == 0) continue;
        SetBits(v, e + A_FLAGS, unchecked((int)ProfileUpdate), 0);
        n++;
      }
      return "{\"ok\":true,\"flagged\":" + n + "}";
    }
  }
}

public static class PlayOutHdr {
  [StructLayout(LayoutKind.Sequential)] public struct LUID { public uint Low; public int High; }
  [StructLayout(LayoutKind.Sequential)] public struct RATIONAL { public uint Numerator; public uint Denominator; }
  [StructLayout(LayoutKind.Sequential)]
  public struct SOURCE_INFO { public LUID adapterId; public uint id; public uint modeInfoIdx; public uint statusFlags; }
  [StructLayout(LayoutKind.Sequential)]
  public struct TARGET_INFO {
    public LUID adapterId; public uint id; public uint modeInfoIdx; public uint outputTechnology; public uint rotation;
    public uint scaling; public RATIONAL refreshRate; public uint scanLineOrdering; public int targetAvailable; public uint statusFlags;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct PATH_INFO { public SOURCE_INFO sourceInfo; public TARGET_INFO targetInfo; public uint flags; }
  // DISPLAYCONFIG_MODE_INFO: type, id, adapter, then a 48-byte union (8-byte aligned).
  [StructLayout(LayoutKind.Sequential)]
  public struct MODE_INFO { public uint infoType; public uint id; public LUID adapterId; public ulong u0, u1, u2, u3, u4, u5; }
  [StructLayout(LayoutKind.Sequential)]
  public struct HEADER { public uint type; public uint size; public LUID adapterId; public uint id; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct SOURCE_NAME { public HEADER header; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string viewGdiDeviceName; }
  [StructLayout(LayoutKind.Sequential)]
  public struct COLOR_INFO { public HEADER header; public uint value; public uint colorEncoding; public uint bitsPerColorChannel; }
  [StructLayout(LayoutKind.Sequential)]
  public struct COLOR_INFO_2 { public HEADER header; public uint value; public uint colorEncoding; public uint bitsPerColorChannel; public uint activeColorMode; }

  [DllImport("user32.dll")] static extern int GetDisplayConfigBufferSizes(uint flags, out uint paths, out uint modes);
  [DllImport("user32.dll")]
  static extern int QueryDisplayConfig(uint flags, ref uint numPaths, [Out] PATH_INFO[] paths, ref uint numModes, [Out] MODE_INFO[] modes, IntPtr topology);
  [DllImport("user32.dll")] static extern int DisplayConfigGetDeviceInfo(ref SOURCE_NAME info);
  [DllImport("user32.dll")] static extern int DisplayConfigGetDeviceInfo(ref COLOR_INFO info);
  [DllImport("user32.dll")] static extern int DisplayConfigGetDeviceInfo(ref COLOR_INFO_2 info);

  const uint QDC_ONLY_ACTIVE_PATHS = 2;
  const uint GET_SOURCE_NAME = 1, GET_ADVANCED_COLOR_INFO = 9, GET_ADVANCED_COLOR_INFO_2 = 15;
  const int ERROR_INSUFFICIENT_BUFFER = 122;

  static string Answer(bool supported, bool enabled, uint source) {
    return "{\"supported\":" + (supported ? "true" : "false") + ",\"enabled\":" + (enabled ? "true" : "false") + ",\"source\":" + source + "}";
  }

  /**
   * Windows HDR for a GDI device (\\.\DISPLAY1): {supported, enabled, source} or null. Windows 11 24H2+ answers
   * ADVANCED_COLOR_INFO_2 (HDR = activeColorMode 2); older builds ADVANCED_COLOR_INFO (enabled and not merely wide
   * colour enforced, which is Automatic Color Management on an SDR panel).
   */
  public static string State(string device) {
    for (int attempt = 0; attempt < 3; attempt++) {
      uint np, nm;
      if (GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, out np, out nm) != 0) return "null";
      PATH_INFO[] paths = new PATH_INFO[np];
      MODE_INFO[] modes = new MODE_INFO[nm];
      int rc = QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, ref np, paths, ref nm, modes, IntPtr.Zero);
      if (rc == ERROR_INSUFFICIENT_BUFFER) continue;
      if (rc != 0) return "null";
      for (int i = 0; i < np; i++) {
        SOURCE_NAME sn = new SOURCE_NAME();
        sn.header.type = GET_SOURCE_NAME;
        sn.header.size = (uint)Marshal.SizeOf(typeof(SOURCE_NAME));
        sn.header.adapterId = paths[i].sourceInfo.adapterId;
        sn.header.id = paths[i].sourceInfo.id;
        if (DisplayConfigGetDeviceInfo(ref sn) != 0) continue;
        if (!string.Equals(sn.viewGdiDeviceName, device, StringComparison.OrdinalIgnoreCase)) continue;
        COLOR_INFO_2 c2 = new COLOR_INFO_2();
        c2.header.type = GET_ADVANCED_COLOR_INFO_2;
        c2.header.size = (uint)Marshal.SizeOf(typeof(COLOR_INFO_2));
        c2.header.adapterId = paths[i].targetInfo.adapterId;
        c2.header.id = paths[i].targetInfo.id;
        // value bit 4: highDynamicRangeSupported.
        if (DisplayConfigGetDeviceInfo(ref c2) == 0) return Answer((c2.value & 0x10) != 0, c2.activeColorMode == 2, 15);
        COLOR_INFO c = new COLOR_INFO();
        c.header.type = GET_ADVANCED_COLOR_INFO;
        c.header.size = (uint)Marshal.SizeOf(typeof(COLOR_INFO));
        c.header.adapterId = paths[i].targetInfo.adapterId;
        c.header.id = paths[i].targetInfo.id;
        // value bit 0: advancedColorSupported, 1: advancedColorEnabled, 2: wideColorEnforced.
        if (DisplayConfigGetDeviceInfo(ref c) == 0) return Answer((c.value & 1) != 0, (c.value & 2) != 0 && (c.value & 4) == 0, 9);
      }
      return "null";
    }
    return "null";
  }
}
`

/**
 * Compiles RTSS_CS once per worker (after PlayOutNative). A failure leaves the other classes working: the RTSS and HDR
 * calls then fail and native-ops.ts reports "not running" / unknown.
 */
export const RTSS_INIT = `
if (-not ('PlayOutRtss' -as [type])) {
  try {
    $cp = New-Object System.CodeDom.Compiler.CompilerParameters
    $cp.CompilerOptions = '/unsafe'
    $cp.GenerateInMemory = $true
    [void]$cp.ReferencedAssemblies.Add('System.dll')
    $src = @'
${RTSS_CS}
'@
    Add-Type -TypeDefinition $src -CompilerParameters $cp
  } catch { $global:PlayOutRtssError = $_.Exception.Message }
}
`

/**
 * WinRT's media session manager (SMTC), set up as globals: `PlayOutAwait` turns an IAsyncOperation into its result
 * through WindowsRuntimeSystemExtensions.AsTask (PowerShell cannot await). Wrapped so a PC without the WinRT
 * projection still gets the C# above.
 */
const MEDIA_INIT = `
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $global:PlayOutAsTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
  })[0]
  function global:PlayOutAwait($op, [Type]$t) {
    $task = $global:PlayOutAsTask.MakeGenericMethod($t).Invoke($null, @($op))
    if (-not $task.Wait(5000)) { throw 'Windows did not answer in time' }
    $task.Result
  }
  [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
  [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
  [Windows.Storage.Streams.IInputStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
  $global:PlayOutMediaReady = $true
} catch { $global:PlayOutMediaReady = $false; $global:PlayOutMediaError = $_.Exception.Message }
`

/**
 * "Free up memory" without the power helper (performance/memory): the working sets of the pids PlayOut names are
 * trimmed with this user's own rights, so only this user's non-elevated programs can be; the rest is counted as
 * denied. The trimming itself is trim-cs.ts, the same members the elevated helper compiles.
 */
export const MEMORY_CS = `
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class PlayOutMemory {
${trimCSharpMembers()}
  /**
   * {"trimmed":n,"denied":n,"skipped":n,"gone":n} for the given pids (explorer.exe only when shell is true; nothing
   * created at or after createdBeforeMs, Unix milliseconds); "ms" is how long the trim took.
   */
  public static string Trim(int[] pids, bool shell, long createdBeforeMs) {
    System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
    int[] c = TrimProcesses(pids, shell, createdBeforeMs, false);
    return "{\\"trimmed\\":" + c[0] + ",\\"denied\\":" + c[1] + ",\\"skipped\\":" + c[2] + ",\\"gone\\":" + c[3] + ",\\"ms\\":" + sw.ElapsedMilliseconds + "}";
  }
}
`

/** Compiles MEMORY_CS once per worker; a failure leaves the other classes working (the trim call then fails). */
export const MEMORY_INIT = `
if (-not ('PlayOutMemory' -as [type])) {
  try {
    Add-Type -TypeDefinition @'
${MEMORY_CS}
'@
  } catch { $global:PlayOutMemoryError = $_.Exception.Message }
}
`

/** The worker's init script: the C# classes (once per process) and the media globals. */
export const NATIVE_INIT = `
if (-not ('PlayOutNative' -as [type])) {
Add-Type -TypeDefinition @'
${NATIVE_CS}
'@
}
${RTSS_INIT}
${MEMORY_INIT}
${MEDIA_INIT}
`

/** Album art above this is left out (it travels as base64 through JSON, to the overlay). */
export const ART_MAX_BYTES = 512 * 1024

/** The current media session as a hashtable (null when none). Art is read only when the app shares it. */
export const MEDIA_SESSION_SCRIPT = `
if (-not $global:PlayOutMediaReady) { throw "Media sessions are unavailable: $global:PlayOutMediaError" }
$mgr = PlayOutAwait ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$s = $mgr.GetCurrentSession()
if ($null -eq $s) { return $null }
$p = PlayOutAwait ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
$info = $s.GetPlaybackInfo()
$art = $null
if ($null -ne $p.Thumbnail) {
  try {
    $stream = PlayOutAwait ($p.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    # The stream arrives as a bare __ComObject: PowerShell sees none of its members and will not cast it, but
    # reflection through the interfaces reaches them.
    $size = [Windows.Storage.Streams.IRandomAccessStream].GetProperty('Size').GetValue($stream)
    if ($size -gt 0 -and $size -le ${ART_MAX_BYTES}) {
      $net = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStreamForRead', [Type[]]@([Windows.Storage.Streams.IInputStream])).Invoke($null, @($stream))
      try {
        $ms = New-Object System.IO.MemoryStream
        $net.CopyTo($ms)
        # Often a list ('image/jpeg,image/jpe,image/jpg'): the first is the type.
        $type = ([string][Windows.Storage.Streams.IContentTypeProvider].GetProperty('ContentType').GetValue($stream)).Split(',')[0].Trim()
        if ($type -notmatch '^image/') { $type = 'image/jpeg' }
        $art = 'data:' + $type + ';base64,' + [Convert]::ToBase64String($ms.ToArray())
      } finally { $net.Dispose() }
    }
  } catch { $art = $null }
}
@{
  app = [string]$s.SourceAppUserModelId
  title = [string]$p.Title
  artist = [string]$p.Artist
  album = [string]$p.AlbumTitle
  status = [string]$info.PlaybackStatus
  art = $art
  canNext = [bool]$info.Controls.IsNextEnabled
  canPrevious = [bool]$info.Controls.IsPreviousEnabled
}
`

/** One media command on the current session; $false when there is none or the app refused. */
export function mediaControlScript(method: string): string {
  return `
if (-not $global:PlayOutMediaReady) { throw "Media sessions are unavailable: $global:PlayOutMediaError" }
$mgr = PlayOutAwait ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$s = $mgr.GetCurrentSession()
if ($null -eq $s) { return $false }
[bool](PlayOutAwait ($s.${method}()) ([bool]))
`
}
