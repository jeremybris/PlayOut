/**
 * The controller reader's PowerShell script: C# compiled with Add-Type that polls every controller and writes one JSON
 * line whenever a pad's buttons or connection change (docs/home-overlay.md, "Controller buttons").
 *
 * - XInput pads (Xbox and most handhelds) through XInputGetStateEx, xinput1_4.dll's ordinal 100: unlike
 *   XInputGetState it reports the Guide button (0x0400). Connected slots are read every interval; empty slots once a
 *   second (asking an empty slot is slow).
 * - Other pads (DualShock 4, DualSense, Switch Pro) through SDL2, when an SDL2.dll is given. SDL's XInput, RawInput,
 *   Windows.Gaming.Input and HIDAPI-Xbox drivers are turned off so an XInput pad is never read twice; background
 *   events are on, so pads are read while a game has the focus. With SDL's XInput driver off, its DirectInput driver
 *   no longer leaves XInput pads alone, so SDL controllers of the Xbox types are skipped too (the XInput loop has
 *   them, with the Guide button DirectInput cannot see).
 *
 * Output lines: `{"pads":[{"id":"xinput:0","name":"…","buttons":<mask>,"axes":[lx,ly,rx,ry],"triggers":[lt,rt]}]}`
 * (PadButton bits, shared/overlay.ts), and one `{"ready":true,"sdl":<bool>,"sdlError":"…"}` first. Sticks are -1..1
 * with up negative (the browser Gamepad convention; XInput's thumb Y is up-positive, so it is negated, SDL's is
 * already down-positive), zero inside a small deadzone and rounded to 1/64 steps; triggers are 0..1 in 1/32 steps.
 * The rounding keeps a stick's noise from writing a line every poll: nothing is written for pads at rest between
 * changes. The home button ignores the sticks (only the in-game overlay navigates with them).
 */
export const PAD_READER_CS = String.raw`
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class PlayOutPadReader {
  [StructLayout(LayoutKind.Sequential)]
  public struct XState {
    public uint Packet; public ushort Buttons; public byte LT; public byte RT;
    public short LX; public short LY; public short RX; public short RY; public uint Extra;
  }
  [DllImport("xinput1_4.dll", EntryPoint = "#100")] static extern uint XGetEx(uint index, out XState state);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool SetDllDirectory(string path);

  [DllImport("SDL2.dll", CallingConvention = CallingConvention.Cdecl)] static extern int SDL_SetHint(string name, string value);
  [DllImport("SDL2.dll", CallingConvention = CallingConvention.Cdecl)] static extern int SDL_Init(uint flags);
  [DllImport("SDL2.dll", CallingConvention = CallingConvention.Cdecl)] static extern void SDL_PumpEvents();
  [DllImport("SDL2.dll", CallingConvention = CallingConvention.Cdecl)] static extern void SDL_GameControllerUpdate();
  [DllImport("SDL2.dll", CallingConvention = CallingConvention.Cdecl)] static extern int SDL_NumJoysticks();
  [DllImport("SDL2.dll", CallingConvention = CallingConvention.Cdecl)] static extern int SDL_IsGameController(int index);
  [DllImport("SDL2.dll", CallingConvention = CallingConvention.Cdecl)] static extern int SDL_JoystickGetDeviceInstanceID(int index);
  [DllImport("SDL2.dll", CallingConvention = CallingConvention.Cdecl)] static extern IntPtr SDL_GameControllerOpen(int index);
  [DllImport("SDL2.dll", CallingConvention = CallingConvention.Cdecl)] static extern void SDL_GameControllerClose(IntPtr gc);
  [DllImport("SDL2.dll", CallingConvention = CallingConvention.Cdecl)] static extern int SDL_GameControllerGetAttached(IntPtr gc);
  [DllImport("SDL2.dll", CallingConvention = CallingConvention.Cdecl)] static extern byte SDL_GameControllerGetButton(IntPtr gc, int button);
  [DllImport("SDL2.dll", CallingConvention = CallingConvention.Cdecl)] static extern short SDL_GameControllerGetAxis(IntPtr gc, int axis);
  [DllImport("SDL2.dll", CallingConvention = CallingConvention.Cdecl)] static extern IntPtr SDL_GameControllerName(IntPtr gc);
  // SDL 2.0.12+; older copies lack it (EntryPointNotFoundException), and then no pad is skipped by type.
  [DllImport("SDL2.dll", CallingConvention = CallingConvention.Cdecl)] static extern int SDL_GameControllerTypeForIndex(int index);
  const int SDL_CONTROLLER_TYPE_XBOX360 = 1, SDL_CONTROLLER_TYPE_XBOXONE = 2;

  static bool hasTypes = true;

  static bool IsXboxType(int index) {
    if (!hasTypes) return false;
    try {
      int t = SDL_GameControllerTypeForIndex(index);
      return t == SDL_CONTROLLER_TYPE_XBOX360 || t == SDL_CONTROLLER_TYPE_XBOXONE;
    } catch (EntryPointNotFoundException) { hasTypes = false; return false; }
  }

  // XInput wButtons bit -> PadButton bit (a0 b1 x2 y3 lb4 rb5 lt6 rt7 view8 menu9 ls10 rs11 up12 down13 left14 right15 guide16).
  static readonly int[][] XMap = new int[][] {
    new int[] { 0x1000, 0 }, new int[] { 0x2000, 1 }, new int[] { 0x4000, 2 }, new int[] { 0x8000, 3 },
    new int[] { 0x0100, 4 }, new int[] { 0x0200, 5 }, new int[] { 0x0020, 8 }, new int[] { 0x0010, 9 },
    new int[] { 0x0040, 10 }, new int[] { 0x0080, 11 }, new int[] { 0x0001, 12 }, new int[] { 0x0002, 13 },
    new int[] { 0x0004, 14 }, new int[] { 0x0008, 15 }, new int[] { 0x0400, 16 }
  };
  // SDL_GameControllerButton -> PadButton bit.
  static readonly int[][] SMap = new int[][] {
    new int[] { 0, 0 }, new int[] { 1, 1 }, new int[] { 2, 2 }, new int[] { 3, 3 }, new int[] { 4, 8 },
    new int[] { 5, 16 }, new int[] { 6, 9 }, new int[] { 7, 10 }, new int[] { 8, 11 }, new int[] { 9, 4 },
    new int[] { 10, 5 }, new int[] { 11, 12 }, new int[] { 12, 13 }, new int[] { 13, 14 }, new int[] { 14, 15 }
  };

  // A stick axis (-32768..32767) to -1..1 in 1/64 steps, zero inside the deadzone; negate flips XInput's up-positive Y.
  const double StickDeadzone = 0.12;
  static double Stick(int raw, bool negate) {
    double v = Math.Max(-1.0, Math.Min(1.0, raw / 32767.0));
    if (negate) v = -v;
    if (Math.Abs(v) < StickDeadzone) return 0;
    return Math.Round(v * 64) / 64;
  }
  // A trigger (0..max) to 0..1 in 1/32 steps; the bottom step is noise.
  static double Trigger(int raw, double max) {
    double v = Math.Max(0.0, Math.Min(1.0, raw / max));
    double q = Math.Round(v * 32) / 32;
    return q <= 1.0 / 32 ? 0 : q;
  }
  static string Num(double v) { return v == 0 ? "0" : v.ToString("R", CultureInfo.InvariantCulture); }
  static string Analog(double[] a) {
    return ",\"axes\":[" + Num(a[0]) + "," + Num(a[1]) + "," + Num(a[2]) + "," + Num(a[3]) + "],\"triggers\":[" + Num(a[4]) + "," + Num(a[5]) + "]";
  }

  static string Esc(string s) {
    var b = new StringBuilder();
    foreach (char c in s) {
      if (c == '"' || c == '\\') { b.Append('\\'); b.Append(c); }
      else if (c < ' ') b.Append(' ');
      else b.Append(c);
    }
    return b.ToString();
  }

  // Xbox Game Bar's process: closed while PlayOut is asked to keep Game Bar off (something else, such as another
  // launcher reading the Guide button, opened it).
  static DateTime lastGameBarCheck = DateTime.MinValue;
  static void CloseGameBar() {
    var now = DateTime.UtcNow;
    if ((now - lastGameBarCheck).TotalMilliseconds < 250) return;
    lastGameBarCheck = now;
    foreach (var p in System.Diagnostics.Process.GetProcessesByName("GameBar")) {
      try {
        p.Kill();
        Console.Out.WriteLine("{\"gameBarClosed\":" + p.Id + "}");
        Console.Out.Flush();
      } catch (Exception) { }
      finally { p.Dispose(); }
    }
  }

  public static void Run(string sdlDir, int intervalMs) { Run(sdlDir, intervalMs, false); }

  public static void Run(string sdlDir, int intervalMs, bool closeGameBar) {
    // The parent closing stdin (quitting, crashing) ends this process instead of leaving it polling forever.
    var watch = new Thread(() => { while (Console.In.ReadLine() != null) { } Environment.Exit(0); });
    watch.IsBackground = true;
    watch.Start();
    bool sdl = false;
    string sdlError = "";
    if (!string.IsNullOrEmpty(sdlDir)) {
      try {
        SetDllDirectory(sdlDir);
        SDL_SetHint("SDL_JOYSTICK_ALLOW_BACKGROUND_EVENTS", "1");
        SDL_SetHint("SDL_XINPUT_ENABLED", "0");
        SDL_SetHint("SDL_JOYSTICK_RAWINPUT", "0");
        SDL_SetHint("SDL_JOYSTICK_WGI", "0");
        SDL_SetHint("SDL_JOYSTICK_HIDAPI_XBOX", "0");
        SDL_SetHint("SDL_JOYSTICK_HIDAPI_XBOX_ONE", "0");
        sdl = SDL_Init(0x4000 | 0x2000 | 0x0200) == 0;
        if (!sdl) sdlError = "SDL_Init failed";
      } catch (Exception e) { sdl = false; sdlError = e.Message; }
    }
    Console.Out.WriteLine("{\"ready\":true,\"sdl\":" + (sdl ? "true" : "false") + ",\"sdlError\":\"" + Esc(sdlError) + "\"}");
    Console.Out.Flush();

    var connected = new bool[4];
    var masks = new int[4];
    var analog = new double[4][];
    for (int i = 0; i < 4; i++) analog[i] = new double[6];
    var lastProbe = new DateTime[4];
    var sdlPads = new Dictionary<int, IntPtr>();
    var sdlNames = new Dictionary<int, string>();
    var sdlMasks = new Dictionary<int, int>();
    var sdlAnalog = new Dictionary<int, double[]>();
    // Instance ids are never reused while SDL runs, so a skipped pad stays skipped without asking again.
    var sdlSkipped = new HashSet<int>();
    string last = "";
    while (true) {
      var now = DateTime.UtcNow;
      for (uint i = 0; i < 4; i++) {
        if (!connected[i] && (now - lastProbe[i]).TotalMilliseconds < 1000) continue;
        lastProbe[i] = now;
        XState s;
        if (XGetEx(i, out s) == 0) {
          int m = 0;
          foreach (var p in XMap) if ((s.Buttons & p[0]) != 0) m |= 1 << p[1];
          if (s.LT > 30) m |= 1 << 6;
          if (s.RT > 30) m |= 1 << 7;
          connected[i] = true; masks[i] = m;
          var a = analog[i];
          a[0] = Stick(s.LX, false); a[1] = Stick(s.LY, true); a[2] = Stick(s.RX, false); a[3] = Stick(s.RY, true);
          a[4] = Trigger(s.LT, 255); a[5] = Trigger(s.RT, 255);
        } else { connected[i] = false; masks[i] = 0; }
      }
      if (sdl) {
        try {
          SDL_PumpEvents();
          SDL_GameControllerUpdate();
          int n = SDL_NumJoysticks();
          for (int j = 0; j < n; j++) {
            if (SDL_IsGameController(j) == 0) continue;
            int id = SDL_JoystickGetDeviceInstanceID(j);
            if (sdlPads.ContainsKey(id) || sdlSkipped.Contains(id)) continue;
            if (IsXboxType(j)) { sdlSkipped.Add(id); continue; }
            IntPtr gc = SDL_GameControllerOpen(j);
            if (gc == IntPtr.Zero) continue;
            sdlPads[id] = gc;
            IntPtr namePtr = SDL_GameControllerName(gc);
            sdlNames[id] = namePtr == IntPtr.Zero ? "Controller" : Marshal.PtrToStringAnsi(namePtr);
          }
          foreach (var id in new List<int>(sdlPads.Keys)) {
            IntPtr gc = sdlPads[id];
            if (SDL_GameControllerGetAttached(gc) == 0) {
              SDL_GameControllerClose(gc); sdlPads.Remove(id); sdlNames.Remove(id); sdlMasks.Remove(id); sdlAnalog.Remove(id);
              continue;
            }
            int m = 0;
            foreach (var p in SMap) if (SDL_GameControllerGetButton(gc, p[0]) != 0) m |= 1 << p[1];
            if (SDL_GameControllerGetAxis(gc, 4) > 8000) m |= 1 << 6;
            if (SDL_GameControllerGetAxis(gc, 5) > 8000) m |= 1 << 7;
            sdlMasks[id] = m;
            // SDL axes: 0 left X, 1 left Y, 2 right X, 3 right Y (down-positive already), 4/5 triggers 0..32767.
            sdlAnalog[id] = new double[] {
              Stick(SDL_GameControllerGetAxis(gc, 0), false), Stick(SDL_GameControllerGetAxis(gc, 1), false),
              Stick(SDL_GameControllerGetAxis(gc, 2), false), Stick(SDL_GameControllerGetAxis(gc, 3), false),
              Trigger(SDL_GameControllerGetAxis(gc, 4), 32767), Trigger(SDL_GameControllerGetAxis(gc, 5), 32767)
            };
          }
        } catch (Exception) { sdl = false; }
      }
      var b = new StringBuilder("{\"pads\":[");
      bool first = true;
      for (int i = 0; i < 4; i++) {
        if (!connected[i]) continue;
        if (!first) b.Append(',');
        first = false;
        b.Append("{\"id\":\"xinput:" + i + "\",\"name\":\"Controller " + (i + 1) + " (XInput)\",\"buttons\":" + masks[i] + Analog(analog[i]) + "}");
      }
      foreach (var kv in sdlMasks) {
        if (!first) b.Append(',');
        first = false;
        b.Append("{\"id\":\"sdl:" + kv.Key + "\",\"name\":\"" + Esc(sdlNames[kv.Key]) + "\",\"buttons\":" + kv.Value + Analog(sdlAnalog[kv.Key]) + "}");
      }
      b.Append("]}");
      string line = b.ToString();
      if (line != last) {
        last = line;
        Console.Out.WriteLine(line);
        Console.Out.Flush();
      }
      if (closeGameBar) CloseGameBar();
      Thread.Sleep(intervalMs);
    }
  }
}
`

/**
 * The whole script: compile, then run until stdin closes (the parent quit) or the process is killed. It is written to
 * `powershell.exe -Command -`, which reads statements line by line: a statement spanning lines (the here-string) only
 * runs after a blank line, so one follows it. Without it the Run line is swallowed into the unfinished statement and
 * nothing ever runs.
 */
export function padReaderScript(
  sdlDir: string | null,
  intervalMs = 16,
  closeGameBar = false
): string {
  // powershell.exe decodes a redirected stdin in the console's OEM code page, which would mangle a folder name
  // outside it (an accented user name); base64 of the UTF-8 bytes travels as plain ASCII and needs no quoting.
  const dir = Buffer.from(sdlDir ?? '', 'utf8').toString('base64')
  return [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    `Add-Type -TypeDefinition @'\n${PAD_READER_CS}\n'@`,
    '',
    `[PlayOutPadReader]::Run([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${dir}')), ${Math.max(1, Math.round(intervalMs))}, $${closeGameBar ? 'true' : 'false'})`,
    ''
  ].join('\n')
}
