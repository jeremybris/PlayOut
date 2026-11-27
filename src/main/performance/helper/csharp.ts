import {
  HELPER_MEMORY_BUSY,
  HELPER_PROTOCOL_VERSION,
  MAX_FPS_PIDS,
  MAX_PURGE_BELOW_MB,
  MAX_RTSS_FPS
} from './protocol'
import { trimCSharpMembers } from '../memory/trim-cs'
import {
  FPS_MIN_FRAMES,
  FPS_WINDOW_MS,
  INTERVAL_COLUMN,
  PID_COLUMN,
  PRESENTMON_ARGS,
  PRESENTMON_DOWNLOAD,
  PRESENTMON_FILE,
  PRESENTMON_SESSION
} from '../presentmon'
import { SMU_FAMILIES, SMU_MIN_WATTS, type SmuFamily } from '../smu'

/**
 * The power helper's C# (compiled by Windows PowerShell 5.1's Add-Type, so C# 5: no string interpolation, no
 * `is not`, no `?.` on value types). It runs elevated, because PawnIO's device only opens for administrators and
 * SYSTEM. It talks to PawnIO through PawnIOLib.dll from PawnIO's own install folder, serves the pipe, and does the MSR
 * and SMU work itself, so the pipe only ever carries "info", "set watts" and "restore": never raw register access. Since
 * protocol 2 it also measures frame rates for Dynamic TDP with its own pinned PresentMon copy (class Fps): the pipe
 * gives pids, never a path or arguments. Since protocol 3 it writes RivaTuner Statistics Server's per-program
 * profiles (class Rtss: a frame rate limit, and PlayOut's own exe left unhooked): the pipe gives a program file name
 * and a number, never a path; the folder comes from RTSS's registry key. Since protocol 4 it frees memory (class Mem):
 * the working sets of the pids PlayOut names (checked again here by image path), Windows' modified and standby lists
 * and memory combining. All of it is temporary; it stops, disables and configures nothing.
 *
 * Rapl and Smu mirror msr.ts and smu.ts; helper-csharp.test.ts compiles this source and compares both.
 */

const hex = (n: number): string => `0x${n.toString(16).toUpperCase()}`

function familyCase(f: SmuFamily): string {
  const models = f.models.map((m) => `model == ${m}`).join(' || ')
  return (
    `      if (family == ${f.family} && (${models})) return new SmuFamily { Name = "${f.name}", ` +
    `Msg = ${hex(f.mailbox.msg)}, Rsp = ${hex(f.mailbox.rsp)}, Arg = ${hex(f.mailbox.arg)}, ` +
    `Stapm = ${hex(f.cmds.stapm)}, Fast = ${hex(f.cmds.fast)}, Slow = ${hex(f.cmds.slow)}, MaxWatts = ${f.maxWatts} };`
  )
}

/** The C# of the helper (namespace PlayOutPower). */
export function helperCSharp(): string {
  const families = SMU_FAMILIES.map(familyCase).join('\n')
  return String.raw`using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32;

namespace PlayOutPower {
  // Intel RAPL MSR_PKG_POWER_LIMIT (0x610): PL1 bits 14:0 + enable 15, PL2 bits 46:32 + enable 47, lock 63.
  public static class Rapl {
    public const uint PowerUnit = 0x606;
    public const uint PowerLimit = 0x610;
    public const uint EnergyStatus = 0x611;
    public const uint PowerInfo = 0x614;

    public static double UnitWatts(ulong units) { return 1.0 / (double)(1UL << (int)(units & 0xF)); }
    public static double EnergyJoules(ulong units) { return 1.0 / (double)(1UL << (int)((units >> 8) & 0x1F)); }
    public static bool Locked(ulong v) { return (v >> 63) != 0; }
    public static double Pl1(ulong v, double unit) { return (v & 0x7FFF) * unit; }
    public static double Pl2(ulong v, double unit) { return ((v >> 32) & 0x7FFF) * unit; }

    static ulong Units(double watts, double unit) {
      long n = (long)Math.Round(watts / unit, MidpointRounding.AwayFromZero);
      if (n < 1) n = 1;
      if (n > 0x7FFF) n = 0x7FFF;
      return (ulong)n;
    }

    // A negative limit keeps that half; clamp bits, time windows and the rest are kept.
    public static ulong Encode(ulong current, double unit, double pl1, double pl2) {
      ulong v = current;
      if (pl1 >= 0) v = (v & ~0x7FFFUL) | Units(pl1, unit) | (1UL << 15);
      if (pl2 >= 0) v = (v & ~(0x7FFFUL << 32)) | (Units(pl2, unit) << 32) | (1UL << 47);
      return v;
    }

    // MSR_PKG_POWER_INFO (0x614) -> the range offered: same rule as msr.ts intelWattsRange.
    public static int[] Range(ulong info, double unit) {
      double tdp = (info & 0x7FFF) * unit;
      double pmin = ((info >> 16) & 0x7FFF) * unit;
      double pmax = ((info >> 32) & 0x7FFF) * unit;
      int min = Math.Max(5, (int)Math.Ceiling(pmin));
      int max;
      if (pmax >= min + 1) max = (int)Math.Floor(pmax);
      else if (tdp > 0) max = Math.Max(min + 1, (int)Math.Floor(tdp * 2.5));
      else max = 115;
      return new int[] { min, max };
    }
  }

  public interface IRegs {
    uint Read(uint addr);
    void Write(uint addr, uint value);
  }

  public sealed class SmuFamily {
    public string Name;
    public uint Msg, Rsp, Arg, Stapm, Fast, Slow;
    public int MaxWatts;
  }

  // AMD MP1 mailbox (RyzenAdj's addresses and message ids; generated from smu.ts).
  public static class Smu {
    public static SmuFamily For(int family, int model) {
${families}
      return null;
    }

    // Wait for a message in flight, clear RSP, write the six arguments, write the message, poll RSP.
    public static uint Send(IRegs r, SmuFamily f, uint cmd, uint[] args, int maxPolls) {
      for (int i = 0; i < maxPolls && r.Read(f.Rsp) == 0; i++) { }
      r.Write(f.Rsp, 0);
      for (int i = 0; i < 6; i++) r.Write(f.Arg + (uint)(i * 4), i < args.Length ? args[i] : 0u);
      r.Write(f.Msg, cmd);
      for (int i = 0; i < maxPolls; i++) {
        uint rsp = r.Read(f.Rsp);
        if (rsp != 0) return rsp;
      }
      return 0;
    }

    public static string ResponseText(uint code) {
      switch (code) {
        case 0x1: return "ok";
        case 0xFF: return "the SMU failed the command";
        case 0xFE: return "this SMU does not know the command";
        case 0xFD: return "the SMU rejected the command (prerequisite)";
        case 0xFC: return "the SMU was busy";
        case 0: return "the SMU did not answer";
        default: return "the SMU answered 0x" + code.ToString("x");
      }
    }
  }

  // PawnIOLib.dll from PawnIO's install folder (loaded by full path first, so the DllImports bind to it).
  public sealed class Pawn : IDisposable {
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr LoadLibraryW(string path);
    [DllImport("PawnIOLib.dll")]
    static extern int pawnio_open(out IntPtr handle);
    [DllImport("PawnIOLib.dll")]
    static extern int pawnio_load(IntPtr handle, byte[] blob, UIntPtr size);
    [DllImport("PawnIOLib.dll", CharSet = CharSet.Ansi, BestFitMapping = false)]
    static extern int pawnio_execute(IntPtr handle, string name, ulong[] input, UIntPtr inSize, ulong[] output, UIntPtr outSize, out UIntPtr returned);
    [DllImport("PawnIOLib.dll")]
    static extern int pawnio_close(IntPtr handle);

    static bool loaded;
    IntPtr h;

    public static void LoadLibrary(string dir) {
      if (loaded) return;
      string p = Path.Combine(dir, "PawnIOLib.dll");
      if (!File.Exists(p)) throw new Exception("PawnIO is not installed (no " + p + ")");
      if (LoadLibraryW(p) == IntPtr.Zero) throw new Exception("Could not load PawnIOLib.dll (error " + Marshal.GetLastWin32Error() + ")");
      loaded = true;
    }

    public Pawn(string module) {
      int hr = pawnio_open(out h);
      if (hr < 0) throw new Exception("Could not open the PawnIO driver (0x" + hr.ToString("X8") + ")");
      byte[] blob = File.ReadAllBytes(module);
      hr = pawnio_load(h, blob, (UIntPtr)blob.Length);
      if (hr < 0) {
        pawnio_close(h);
        h = IntPtr.Zero;
        throw new Exception("PawnIO refused the module " + Path.GetFileName(module) + " (0x" + hr.ToString("X8") + ")");
      }
    }

    public ulong[] Exec(string fn, ulong[] input, int outCount) {
      ulong[] output = new ulong[Math.Max(outCount, 1)];
      UIntPtr returned;
      int hr = pawnio_execute(h, fn, input, (UIntPtr)input.Length, output, (UIntPtr)outCount, out returned);
      if (hr < 0) throw new Exception(fn + " failed (0x" + hr.ToString("X8") + ")");
      return output;
    }

    public void Dispose() {
      if (h != IntPtr.Zero) { pawnio_close(h); h = IntPtr.Zero; }
    }
  }

  sealed class PawnRegs : IRegs {
    readonly Pawn p;
    public PawnRegs(Pawn p) { this.p = p; }
    public uint Read(uint addr) { return (uint)p.Exec("ioctl_read_smu_register", new ulong[] { addr }, 1)[0]; }
    public void Write(uint addr, uint value) { p.Exec("ioctl_write_smu_register", new ulong[] { addr, value }, 0); }
  }

  // This boot, as the minute (since 1970, UTC) Windows started: now minus GetTickCount64, rounded to the minute.
  public static class Boot {
    [DllImport("kernel32.dll")]
    static extern ulong GetTickCount64();
    static readonly DateTime Epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);

    public static long Minute() {
      DateTime boot = DateTime.UtcNow - TimeSpan.FromMilliseconds((double)GetTickCount64());
      return (long)Math.Round((boot - Epoch).TotalMinutes, MidpointRounding.AwayFromZero);
    }

    // The state was saved in boot "boot" (one minute either way: two readings straddle a rounding edge).
    public static bool Same(Dictionary<string, object> state, long boot) {
      object v;
      if (state == null || !state.TryGetValue("boot", out v) || v == null) return false;
      long saved;
      try { saved = Convert.ToInt64(v, CultureInfo.InvariantCulture); } catch { return false; }
      return Math.Abs(saved - boot) <= 1;
    }
  }

  // Mirrors presentmon.ts FpsMeter: PresentMon's CSV lines in, the busiest watched pid's rate over WindowMs out (the
  // most presents, ties by rate, at least MinFrames of them).
  public sealed class FpsMeter {
    public const double WindowMs = ${FPS_WINDOW_MS};
    public const int MinFrames = ${FPS_MIN_FRAMES};
    readonly HashSet<int> pids;
    int pidCol = -1, msCol = -1, headerLength;
    readonly Dictionary<int, List<double[]>> frames = new Dictionary<int, List<double[]>>();

    public FpsMeter(int[] pids) { this.pids = new HashSet<int>(pids); }

    static string Field(string[] f, int i, int shift) {
      int k = i > 0 ? i + shift : i;
      return k < f.Length ? f[k] : "";
    }

    public void Push(string line, double now) {
      if (line == null) return;
      string[] f = line.Split(',');
      if (pidCol < 0) {
        int p = -1, m = -1;
        for (int i = 0; i < f.Length; i++) {
          string n = f[i].Trim();
          if (p < 0 && string.Equals(n, "${PID_COLUMN}", StringComparison.OrdinalIgnoreCase)) p = i;
          if (m < 0 && string.Equals(n, "${INTERVAL_COLUMN}", StringComparison.OrdinalIgnoreCase)) m = i;
        }
        if (p >= 0 && m >= 0) { pidCol = p; msCol = m; headerLength = f.Length; }
        return;
      }
      // The application name (the first column) is the only one that can hold a comma.
      int shift = f.Length - headerLength;
      if (shift < 0) return;
      int pid;
      if (!int.TryParse(Field(f, pidCol, shift).Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out pid)) return;
      if (!pids.Contains(pid)) return;
      double ms;
      if (!double.TryParse(Field(f, msCol, shift).Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out ms)) return;
      if (double.IsNaN(ms) || ms <= 0 || ms > 5000) return;
      List<double[]> list;
      if (!frames.TryGetValue(pid, out list)) { list = new List<double[]>(); frames[pid] = list; }
      list.Add(new double[] { now, ms });
      Prune(now);
    }

    void Prune(double now) {
      foreach (List<double[]> list in frames.Values) {
        int drop = 0;
        while (drop < list.Count && now - list[drop][0] > WindowMs) drop++;
        if (drop > 0) list.RemoveRange(0, drop);
      }
    }

    // { fps, frameTimeMs, pid, frames } of the pid with the most frames (ties: the highest rate), or null when no pid
    // has MinFrames frames in the window.
    public double[] Read(double now) {
      Prune(now);
      double[] best = null;
      foreach (KeyValuePair<int, List<double[]>> kv in frames) {
        if (kv.Value.Count < MinFrames) continue;
        double sum = 0;
        foreach (double[] x in kv.Value) sum += x[1];
        double frameMs = sum / kv.Value.Count;
        double fps = 1000.0 / frameMs;
        bool busier = best == null || kv.Value.Count > best[3] || (kv.Value.Count == best[3] && fps > best[0]);
        if (busier) best = new double[] { fps, frameMs, kv.Key, kv.Value.Count };
      }
      return best;
    }
  }

  // The helper's own PresentMon (PresentMon.exe in the helper folder, its SHA-256 pinned here and checked with the file
  // open deny-write before every start). It never runs a path or arguments from the pipe: the pipe only gives pids,
  // which PresentMon never sees (they filter its rows here). Stopped on fpsStop, when every watched pid exited, when
  // nobody asked for a reading for IdleMs, on the idle restore and when the helper exits (a kill-on-close job object
  // covers a helper crash; --stop_existing_session and logman cover the ETW session a kill leaves behind).
  public static class Fps {
    public const string Sha256 = "${PRESENTMON_DOWNLOAD.sha256}";
    public const string Exe = "${PRESENTMON_FILE}";
    public const string Session = "${PRESENTMON_SESSION}";
    public const string Arguments = "${PRESENTMON_ARGS.join(' ')}";
    public const int MaxPids = ${MAX_FPS_PIDS};
    const double IdleMs = 15000;

    public static Action<string> Log = delegate { };
    static readonly object gate = new object();
    static readonly Stopwatch clock = Stopwatch.StartNew();
    static Process pm;
    static FpsMeter meter;
    static int[] watched;
    static double lastAsk;
    static Timer timer;
    static IntPtr job = IntPtr.Zero;

    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimit {
      public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
      public uint LimitFlags;
      public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
      public uint ActiveProcessLimit;
      public UIntPtr Affinity;
      public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters { public ulong R, W, O, RB, WB, OB; }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimit {
      public BasicLimit Basic;
      public IoCounters Io;
      public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimit info, int length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    static double Now() { return clock.Elapsed.TotalMilliseconds; }

    // The pids of an fpsStart request: whole numbers above 4, no repeats, at most MaxPids (anything else is dropped).
    public static int[] ParsePids(object v) {
      List<int> outp = new List<int>();
      System.Collections.IEnumerable list = v as System.Collections.IEnumerable;
      if (list == null || v is string) return outp.ToArray();
      foreach (object o in list) {
        if (o == null || o is string || o is bool) continue;
        double d;
        try { d = Convert.ToDouble(o, CultureInfo.InvariantCulture); } catch { continue; }
        if (double.IsNaN(d) || d != Math.Floor(d) || d <= 4 || d > int.MaxValue) continue;
        int p = (int)d;
        if (!outp.Contains(p)) outp.Add(p);
        if (outp.Count >= MaxPids) break;
      }
      return outp.ToArray();
    }

    public static string HashOf(Stream s) {
      using (System.Security.Cryptography.SHA256 sha = System.Security.Cryptography.SHA256.Create()) {
        byte[] h = sha.ComputeHash(s);
        StringBuilder sb = new StringBuilder();
        foreach (byte b in h) sb.Append(b.ToString("x2"));
        return sb.ToString();
      }
    }

    static void AttachToJob(Process p) {
      try {
        if (job == IntPtr.Zero) {
          IntPtr j = CreateJobObjectW(IntPtr.Zero, null);
          if (j == IntPtr.Zero) return;
          ExtendedLimit info = new ExtendedLimit();
          info.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
          if (!SetInformationJobObject(j, 9, ref info, Marshal.SizeOf(typeof(ExtendedLimit)))) { Log("PresentMon job: limits not set"); return; }
          job = j;
        }
        if (!AssignProcessToJobObject(job, p.Handle)) Log("PresentMon job: not assigned (error " + Marshal.GetLastWin32Error() + ")");
      } catch (Exception e) { Log("PresentMon job: " + e.Message); }
    }

    // Starts (or restarts) PresentMon for these pids. Throws when the copy is missing or not the pinned one.
    public static void Start(string helperDir, int[] pids) {
      if (pids == null || pids.Length == 0) throw new Exception("No processes to measure.");
      Stop();
      string exe = Path.Combine(helperDir, Exe);
      if (!File.Exists(exe)) throw new Exception("PresentMon is missing; reinstall the power helper.");
      FpsMeter m = new FpsMeter(pids);
      Process p = new Process();
      using (FileStream fs = new FileStream(exe, FileMode.Open, FileAccess.Read, FileShare.Read)) {
        if (HashOf(fs) != Sha256) throw new Exception("PresentMon.exe is not the copy PlayOut installed; reinstall the power helper.");
        ProcessStartInfo si = new ProcessStartInfo(exe, Arguments);
        si.UseShellExecute = false;
        si.RedirectStandardOutput = true;
        si.RedirectStandardError = true;
        si.CreateNoWindow = true;
        si.WorkingDirectory = helperDir;
        p.StartInfo = si;
        p.OutputDataReceived += delegate (object s, DataReceivedEventArgs e) {
          if (e.Data == null) return;
          lock (gate) { if (meter == m) m.Push(e.Data, Now()); }
        };
        p.ErrorDataReceived += delegate (object s, DataReceivedEventArgs e) { };
        // Started while the file is still open deny-write: what runs is what was hashed.
        p.Start();
      }
      AttachToJob(p);
      p.BeginOutputReadLine();
      p.BeginErrorReadLine();
      lock (gate) { pm = p; meter = m; watched = pids; lastAsk = Now(); }
      if (timer == null) timer = new Timer(delegate (object o) { Watch(); }, null, 2000, 2000);
      Log("PresentMon started for " + pids.Length + " process(es)");
    }

    static bool Alive(int pid) {
      try {
        using (Process x = Process.GetProcessById(pid)) { return !x.HasExited; }
      } catch { return false; }
    }

    static void Watch() {
      string why = null;
      try {
        lock (gate) {
          if (pm == null) return;
          if (pm.HasExited) why = "PresentMon exited (" + pm.ExitCode + ")";
          else if (Now() - lastAsk > IdleMs) why = "no readings asked for";
          else {
            bool any = false;
            foreach (int pid in watched) if (Alive(pid)) { any = true; break; }
            if (!any) why = "the measured processes exited";
          }
        }
      } catch (Exception e) { why = e.Message; }
      if (why != null) { Log("PresentMon stopped: " + why); Stop(); }
    }

    public static bool Running() { lock (gate) { return pm != null; } }

    public static void Stop() {
      Process p;
      lock (gate) { p = pm; pm = null; meter = null; watched = null; }
      if (p == null) return;
      try { if (!p.HasExited) p.Kill(); p.WaitForExit(3000); } catch { }
      try { p.Dispose(); } catch { }
      // A killed PresentMon leaves its real-time ETW session running: stop it by name.
      try {
        ProcessStartInfo si = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "logman.exe"), "stop " + Session + " -ets");
        si.UseShellExecute = false;
        si.CreateNoWindow = true;
        using (Process l = Process.Start(si)) { l.WaitForExit(5000); }
      } catch { }
    }

    // The fps answer: the busiest watched pid over the window, or fps null.
    public static Dictionary<string, object> Read() {
      Dictionary<string, object> r = new Dictionary<string, object>();
      lock (gate) {
        lastAsk = Now();
        bool running = pm != null && !pm.HasExited;
        r["running"] = running;
        double[] x = meter == null ? null : meter.Read(Now());
        if (x == null) { r["fps"] = null; return r; }
        r["fps"] = Math.Round(x[0], 1);
        r["frameTimeMs"] = Math.Round(x[1], 2);
        r["pid"] = (int)x[2];
        r["frames"] = (int)x[3];
      }
      return r;
    }
  }

  // Mirrors rtss/ini.ts (helper-csharp.test.ts compares the two): minimal edits of an RTSS profile, keeping every other
  // line, the order and the file's own line ending.
  public static class RtssIni {
    static List<string> Split(string text, out string nl, out bool trailing) {
      nl = text.Contains("\r\n") ? "\r\n" : text.Contains("\n") ? "\n" : "\r\n";
      trailing = text.Length == 0 || text.EndsWith("\n");
      List<string> lines = new List<string>();
      if (text.Length > 0) foreach (string l in text.Split('\n')) lines.Add(l.TrimEnd('\r'));
      if (lines.Count > 0 && text.EndsWith("\n")) lines.RemoveAt(lines.Count - 1);
      return lines;
    }

    static bool IsHeader(string line) {
      string t = line.Trim();
      return t.Length >= 2 && t.StartsWith("[") && t.EndsWith("]");
    }

    static bool IsSection(string line, string section) {
      if (!IsHeader(line)) return false;
      string t = line.Trim();
      return string.Equals(t.Substring(1, t.Length - 2).Trim(), section, StringComparison.OrdinalIgnoreCase);
    }

    static string KeyOf(string line) {
      string t = line.Trim();
      if (t.Length == 0 || t.StartsWith(";") || t.StartsWith("#") || t.StartsWith("[")) return null;
      int eq = t.IndexOf('=');
      return eq > 0 ? t.Substring(0, eq).Trim() : null;
    }

    static bool IsKey(string line, string key) {
      string k = KeyOf(line);
      return k != null && string.Equals(k, key, StringComparison.OrdinalIgnoreCase);
    }

    static int[] Range(List<string> lines, string section) {
      int start = -1;
      for (int i = 0; i < lines.Count; i++) if (IsSection(lines[i], section)) { start = i; break; }
      if (start < 0) return null;
      int end = start + 1;
      while (end < lines.Count && !IsHeader(lines[end])) end++;
      return new int[] { start, end };
    }

    public static string Get(string text, string section, string key) {
      if (string.IsNullOrEmpty(text)) return null;
      string nl; bool trailing;
      List<string> lines = Split(text, out nl, out trailing);
      int[] r = Range(lines, section);
      if (r == null) return null;
      for (int i = r[0] + 1; i < r[1]; i++)
        if (IsKey(lines[i], key)) return lines[i].Substring(lines[i].IndexOf('=') + 1).Trim();
      return null;
    }

    public static string Set(string text, string section, string key, string value) {
      string source = text ?? "";
      string nl; bool trailing;
      List<string> lines = Split(source, out nl, out trailing);
      int[] r = Range(lines, section);
      bool changed = false;
      if (r == null) {
        if (value == null) return source;
        lines.Add("[" + section + "]");
        lines.Add(key + "=" + value);
        changed = true;
      } else {
        List<int> found = new List<int>();
        for (int i = r[0] + 1; i < r[1]; i++) if (IsKey(lines[i], key)) found.Add(i);
        if (value == null) {
          for (int j = found.Count - 1; j >= 0; j--) lines.RemoveAt(found[j]);
          changed = found.Count > 0;
        } else if (found.Count > 0) {
          string next = KeyOf(lines[found[0]]) + "=" + value;
          if (lines[found[0]] != next) { lines[found[0]] = next; changed = true; }
        } else {
          int at = r[1];
          while (at - 1 > r[0] && lines[at - 1].Trim().Length == 0) at--;
          lines.Insert(at, key + "=" + value);
          changed = true;
        }
      }
      if (!changed) return source;
      return string.Join(nl, lines) + (trailing ? nl : "");
    }

    public static bool Empty(string text) {
      if (string.IsNullOrEmpty(text)) return true;
      string nl; bool trailing;
      foreach (string l in Split(text, out nl, out trailing)) if (l.Trim().Length > 0 && !IsHeader(l)) return false;
      return true;
    }
  }

  // RivaTuner Statistics Server's per-program profiles (Profiles\<exe>.cfg). The folder comes from RTSS's own
  // registry key, never from the pipe; the pipe only names a program file name (rtss/memory.ts isProfileExe), and the
  // path built from it must sit directly in Profiles. The global profile ("Global") and "Config" are never written.
  // rtssLimit records each program's original file in rtss-limits.json (helper folder) before PlayOut's first change,
  // so fps 0 puts back exactly what was there, or deletes the file PlayOut created.
  public static class Rtss {
    public const int MaxFps = ${MAX_RTSS_FPS};
    public const string NotInstalled = "RivaTuner Statistics Server is not installed";
    public const string NotProgram = "Not a program name.";
    public const string NotSafe = "RivaTuner's folder is not protected (any user could change it), so PlayOut does not write its profiles.";
    // Administrators, SYSTEM, TrustedInstaller: the owners of a folder no user-level process made.
    static readonly string[] TrustedOwners = { "S-1-5-32-544", "S-1-5-18", "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464" };
    const int MaxOriginal = 65536;
    // Byte for byte: RTSS writes its profiles in the ANSI code page, and Latin-1 round-trips any byte unchanged.
    static readonly Encoding Bytes = Encoding.GetEncoding(28591);
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    public static bool IsProfileExe(string name) {
      if (name == null) return false;
      if (!System.Text.RegularExpressions.Regex.IsMatch(name, @"^[^\\/:*?""<>|\x00-\x1f]{1,200}\.exe\z", System.Text.RegularExpressions.RegexOptions.IgnoreCase)) return false;
      string stem = name.Substring(0, name.Length - 4);
      if (System.Text.RegularExpressions.Regex.IsMatch(stem, @"^[.\s]*\z") || stem.Contains("..")) return false;
      return !System.Text.RegularExpressions.Regex.IsMatch(name, @"^\s");
    }

    // A whole number from 0 to MaxFps, else -1.
    public static int ParseFps(object v) {
      if (v == null || v is string || v is bool) return -1;
      double d;
      try { d = Convert.ToDouble(v, CultureInfo.InvariantCulture); } catch { return -1; }
      if (double.IsNaN(d) || d != Math.Floor(d) || d < 0 || d > MaxFps) return -1;
      return (int)d;
    }

    static string InstallDir(RegistryView view, string path) {
      try {
        using (RegistryKey b = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view))
        using (RegistryKey k = b.OpenSubKey(path)) {
          return k == null ? null : k.GetValue("InstallDir") as string;
        }
      } catch { return null; }
    }

    // A real folder (not a junction or link) owned by Administrators, SYSTEM or TrustedInstaller.
    public static bool AdminOwned(string dir) {
      try {
        if ((File.GetAttributes(dir) & FileAttributes.ReparsePoint) != 0) return false;
        string owner = Directory.GetAccessControl(dir, AccessControlSections.Owner).GetOwner(typeof(SecurityIdentifier)).Value;
        return Array.IndexOf(TrustedOwners, owner) >= 0;
      } catch { return false; }
    }

    // RTSS's Profiles folder from an install folder: absolute, on a local drive, holding RTSS.exe and Profiles. As SYSTEM
    // the helper writes and deletes there, so both folders must be real (GetFullPath does not resolve a junction) and
    // admin-owned: RTSS installed into a folder users may change (C:\Games\RTSS) is refused.
    public static string CheckInstall(string dir) { return CheckInstall(dir, true); }

    public static string CheckInstall(string dir, bool requireAdmin) {
      if (dir == null || dir.Trim().Length == 0) throw new Exception(NotInstalled);
      string d = dir.Trim().Trim('"');
      if (d.Length < 3 || d[1] != ':' || (d[2] != '\\' && d[2] != '/')) throw new Exception(NotInstalled);
      d = Path.GetFullPath(d);
      string profiles = Path.Combine(d, "Profiles");
      if (!File.Exists(Path.Combine(d, "RTSS.exe")) || !Directory.Exists(profiles)) throw new Exception(NotInstalled);
      if (requireAdmin && (!AdminOwned(d) || !AdminOwned(profiles))) throw new Exception(NotSafe);
      return profiles;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandle(Microsoft.Win32.SafeHandles.SafeFileHandle h, out FileInfoByHandle info);

    [StructLayout(LayoutKind.Sequential)]
    struct FileInfoByHandle {
      public uint Attributes;
      public uint CreatedLow, CreatedHigh, AccessedLow, AccessedHigh, WrittenLow, WrittenHigh;
      public uint Serial, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }

    // The file's hard link count (1 for an ordinary file); 0 when it cannot be read.
    public static uint LinkCount(string path) {
      using (FileStream f = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
        FileInfoByHandle i;
        return GetFileInformationByHandle(f.SafeFileHandle, out i) ? i.Links : 0;
      }
    }

    public static string ProfilesDir() {
      string d = InstallDir(RegistryView.Registry32, @"SOFTWARE\Unwinder\RTSS");
      if (d == null) d = InstallDir(RegistryView.Registry64, @"SOFTWARE\WOW6432Node\Unwinder\RTSS");
      if (d == null) d = InstallDir(RegistryView.Registry64, @"SOFTWARE\Unwinder\RTSS");
      return CheckInstall(d);
    }

    // Profiles\<exe>.cfg, checked to sit directly in Profiles and not to be a link.
    public static string ProfilePath(string profiles, string exe) {
      if (!IsProfileExe(exe)) throw new Exception(NotProgram);
      string root = Path.GetFullPath(profiles).TrimEnd('\\');
      string full = Path.GetFullPath(Path.Combine(root, exe + ".cfg"));
      string parent = Path.GetDirectoryName(full);
      if (parent == null || !string.Equals(parent.TrimEnd('\\'), root, StringComparison.OrdinalIgnoreCase)) throw new Exception(NotProgram);
      string leaf = Path.GetFileName(full);
      if (string.Equals(leaf, "Global", StringComparison.OrdinalIgnoreCase) || string.Equals(leaf, "Config", StringComparison.OrdinalIgnoreCase)) throw new Exception(NotProgram);
      // A link (junction, symlink, or a hard link: another name of a file elsewhere) is never written through.
      if (File.Exists(full) && ((File.GetAttributes(full) & FileAttributes.ReparsePoint) != 0 || LinkCount(full) != 1)) throw new Exception("The RivaTuner profile of " + exe + " is a link; it was left alone.");
      return full;
    }

    static string ReadText(string path) {
      return File.Exists(path) ? Bytes.GetString(File.ReadAllBytes(path)) : null;
    }

    // Written next to the profile, then swapped in, so RTSS never reads half a file.
    static void WriteText(string path, string text) {
      string tmp = path + ".playout-tmp";
      File.WriteAllBytes(tmp, Bytes.GetBytes(text));
      try {
        if (File.Exists(path)) File.Replace(tmp, path, null, true);
        else File.Move(tmp, path);
      } catch {
        try { File.Copy(tmp, path, true); } finally { try { File.Delete(tmp); } catch { } }
      }
    }

    static Dictionary<string, object> LoadRecords(string file) {
      try {
        if (File.Exists(file)) {
          Dictionary<string, object> d = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(file));
          if (d != null) return d;
        }
      } catch { }
      return new Dictionary<string, object>();
    }

    static void SaveRecords(string file, Dictionary<string, object> d) {
      if (d.Count == 0) { if (File.Exists(file)) File.Delete(file); return; }
      string tmp = file + ".tmp";
      File.WriteAllText(tmp, Json.Serialize(d));
      if (File.Exists(file)) File.Replace(tmp, file, null, true);
      else File.Move(tmp, file);
    }

    static bool Flag(Dictionary<string, object> rec, string key) {
      object v;
      return rec != null && rec.TryGetValue(key, out v) && v is bool && (bool)v;
    }

    static string Text(Dictionary<string, object> rec, string key) {
      object v;
      return rec != null && rec.TryGetValue(key, out v) ? v as string : null;
    }

    // fps > 0: [Framerate] Limit=fps (the original recorded on the first change). fps 0: put back what was there:
    // the original file when nothing else changed it since, else just the Limit line; a file PlayOut created and that
    // holds nothing else is deleted. With no record (PlayOut never limited it) fps 0 changes nothing.
    public static Dictionary<string, object> Limit(string profiles, string recordFile, string exe, int fps) {
      if (fps < 0 || fps > MaxFps) throw new Exception("Not a frame rate limit.");
      string path = ProfilePath(profiles, exe);
      string key = exe.ToLowerInvariant();
      Dictionary<string, object> records = LoadRecords(recordFile);
      object found;
      records.TryGetValue(key, out found);
      Dictionary<string, object> rec = found as Dictionary<string, object>;
      string text = ReadText(path);
      if (fps > 0) {
        if (rec == null) {
          rec = new Dictionary<string, object>();
          rec["created"] = text == null;
          rec["hadLimit"] = RtssIni.Get(text, "Framerate", "Limit");
          rec["original"] = text != null && text.Length <= MaxOriginal ? text : null;
        }
        // RTSS reads the cap as Limit / LimitDenominator, inherited from Global when the profile has none: a fractional
        // limit set in RTSS (59.94 = 5994 / 100) would turn Limit=60 into 0.6 FPS. The denominator is set to 1 and put
        // back with the limit (a record from before this has none: its denominator was never changed).
        if (!rec.ContainsKey("hadDenominator")) rec["hadDenominator"] = RtssIni.Get(text, "Framerate", "LimitDenominator");
        string next = RtssIni.Set(text ?? "", "Framerate", "Limit", fps.ToString(CultureInfo.InvariantCulture));
        next = RtssIni.Set(next, "Framerate", "LimitDenominator", "1");
        rec["written"] = next.Length <= MaxOriginal ? next : null;
        records[key] = rec;
        // The record first: a crash between the two still knows what to put back.
        SaveRecords(recordFile, records);
        if (text == null || next != text) WriteText(path, next);
      } else if (rec != null) {
        if (text != null) {
          string written = Text(rec, "written");
          string original = Text(rec, "original");
          bool created = Flag(rec, "created");
          if (written != null && text == written && (created || original != null)) {
            if (created) File.Delete(path);
            else WriteText(path, original);
          } else {
            string next = RtssIni.Set(text, "Framerate", "Limit", Text(rec, "hadLimit"));
            if (rec.ContainsKey("hadDenominator")) next = RtssIni.Set(next, "Framerate", "LimitDenominator", Text(rec, "hadDenominator"));
            if (created && RtssIni.Empty(next)) File.Delete(path);
            else if (next != text) WriteText(path, next);
          }
        }
        records.Remove(key);
        SaveRecords(recordFile, records);
      }
      Dictionary<string, object> r = new Dictionary<string, object>();
      r["exe"] = exe;
      r["fps"] = fps;
      r["created"] = Flag(rec, "created");
      return r;
    }

    // <exe>.cfg with [Hooking] EnableHooking=0 (created when absent, the rest kept); true when the file changed. The
    // first change is recorded ("self:<exe>": created, hadHooking), so RestoreAll can put it back.
    public static bool Self(string profiles, string recordFile, string exe) {
      string path = ProfilePath(profiles, exe);
      string text = ReadText(path);
      string next = RtssIni.Set(text ?? "", "Hooking", "EnableHooking", "0");
      if (text != null && next == text) return false;
      string key = "self:" + exe.ToLowerInvariant();
      Dictionary<string, object> records = LoadRecords(recordFile);
      if (!records.ContainsKey(key)) {
        Dictionary<string, object> rec = new Dictionary<string, object>();
        rec["created"] = text == null;
        rec["hadHooking"] = RtssIni.Get(text, "Hooking", "EnableHooking");
        records[key] = rec;
        SaveRecords(recordFile, records);
      }
      WriteText(path, next);
      return true;
    }

    // Undoes Self: EnableHooking back to what it was (a file PlayOut created that holds nothing else is deleted).
    static void Unself(string profiles, string recordFile, string exe, Dictionary<string, object> rec) {
      string path = ProfilePath(profiles, exe);
      string text = ReadText(path);
      if (text != null && rec != null) {
        string next = RtssIni.Set(text, "Hooking", "EnableHooking", Text(rec, "hadHooking"));
        if (Flag(rec, "created") && RtssIni.Empty(next)) File.Delete(path);
        else if (next != text) WriteText(path, next);
      }
      Dictionary<string, object> records = LoadRecords(recordFile);
      records.Remove("self:" + exe.ToLowerInvariant());
      SaveRecords(recordFile, records);
    }

    // Before the helper is removed: every limit PlayOut wrote goes back (Limit with fps 0) and PlayOut's own exe is
    // hooked again, so nothing of PlayOut's stays in RTSS's admin-only folder. The number put back; throws when one
    // could not be (its record stays).
    public static int RestoreAll(string profiles, string recordFile) {
      int n = 0;
      List<string> failed = new List<string>();
      foreach (KeyValuePair<string, object> e in LoadRecords(recordFile)) {
        try {
          if (e.Key.StartsWith("self:")) Unself(profiles, recordFile, e.Key.Substring(5), e.Value as Dictionary<string, object>);
          else Limit(profiles, recordFile, e.Key, 0);
          n++;
        } catch (Exception x) { failed.Add(e.Key + ": " + x.Message); }
      }
      if (failed.Count > 0) throw new Exception("Not every RivaTuner profile could be put back: " + string.Join("; ", failed.ToArray()));
      return n;
    }
  }

  // A token privilege switched on for one call and put back as it was afterwards (Dispose, from a using block): the
  // helper never keeps a privilege on that was off before.
  public sealed class Privilege : IDisposable {
    [StructLayout(LayoutKind.Sequential)]
    struct Luid { public uint Low; public int High; }
    // TOKEN_PRIVILEGES with one entry: DWORD count, LUID, DWORD attributes (16 bytes on x86 and x64).
    [StructLayout(LayoutKind.Sequential)]
    struct TokenPrivileges { public uint Count; public Luid Id; public uint Attributes; }
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr h);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool LookupPrivilegeValueW(string system, string name, out Luid id);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref TokenPrivileges state, uint length, out TokenPrivileges previous, out uint returned);
    const uint TokenAdjustPrivileges = 0x20, TokenQuery = 0x8, SePrivilegeEnabled = 0x2;
    const int ErrorNotAllAssigned = 1300;

    IntPtr token = IntPtr.Zero;
    TokenPrivileges previous;
    bool changed;
    // Null when the privilege is on now; else why it is not.
    public readonly string Error;
    // This call switched it on (it was off before), so Dispose switches it off again.
    public bool Changed { get { return changed; } }

    public static int StateSize() { return Marshal.SizeOf(typeof(TokenPrivileges)); }

    public Privilege(string name) {
      if (!OpenProcessToken(GetCurrentProcess(), TokenAdjustPrivileges | TokenQuery, out token)) {
        token = IntPtr.Zero;
        Error = "the helper's token could not be opened (error " + Marshal.GetLastWin32Error() + ")";
        return;
      }
      Luid id;
      if (!LookupPrivilegeValueW(null, name, out id)) {
        Error = "Windows does not know the privilege " + name + " (error " + Marshal.GetLastWin32Error() + ")";
        return;
      }
      TokenPrivileges want = new TokenPrivileges();
      want.Count = 1;
      want.Id = id;
      want.Attributes = SePrivilegeEnabled;
      uint returned;
      bool ok = AdjustTokenPrivileges(token, false, ref want, (uint)StateSize(), out previous, out returned);
      int error = Marshal.GetLastWin32Error();
      // AdjustTokenPrivileges succeeds even when the token does not hold the privilege: the error code tells.
      if (!ok) Error = name + " could not be switched on (error " + error + ")";
      else if (error == ErrorNotAllAssigned) Error = "this account does not hold " + name;
      else changed = previous.Count == 1;
    }

    public void Dispose() {
      if (token == IntPtr.Zero) return;
      try {
        if (changed) {
          TokenPrivileges ignored;
          uint returned;
          AdjustTokenPrivileges(token, false, ref previous, (uint)StateSize(), out ignored, out returned);
          changed = false;
        }
      } finally {
        CloseHandle(token);
        token = IntPtr.Zero;
      }
    }
  }

  // "Free up memory" (protocol 4). The pipe gives pids, a flag and two numbers: never a name, a path or a command. One
  // cleanup at a time, on its own below-normal thread, so the pipe keeps answering (Dynamic TDP reads the frame rate
  // every second). Steps, in order, each on its own (one failing never stops the next): the working sets of the given
  // pids; Windows' modified page list flushed; the low-priority standby list purged; the whole standby list purged
  // only when asked, less than purgeBelowMb is free by then and the list holds at least that much; identical pages
  // combined. Only the trim, the flush and the combining can raise available memory: standby pages already count as
  // available, so purging them only hands them to the free list (and costs the file cache). The last four need
  // SeProfileSingleProcessPrivilege, switched on for the call only. Everything is temporary: Windows pages memory
  // back in and refills its cache by itself. No service, registry value, process state or system setting is touched.
  public static class Mem {
${trimCSharpMembers()}
    public const int MaxPurgeBelowMb = ${MAX_PURGE_BELOW_MB};
    public const string NotList = "Not a list of processes.";
    public const string NotAmount = "Not a memory amount.";
    public const string NotFlag = "Not a yes or no.";
    public const string NotTime = "Not a time.";
    public const string Busy = "${HELPER_MEMORY_BUSY}";
    const int SystemMemoryListInformation = 80;
    const int SystemCombinePhysicalMemoryInformation = 130;
    const int MemoryFlushModifiedList = 3;
    const int MemoryPurgeStandbyList = 4;
    const int MemoryPurgeLowPriorityStandbyList = 5;

    // MEMORY_COMBINE_INFORMATION_EX: HANDLE Handle, ULONG_PTR PagesCombined, ULONG Flags (24 bytes on x64, 12 on x86).
    [StructLayout(LayoutKind.Sequential)]
    struct CombineInfo { public IntPtr Handle; public UIntPtr PagesCombined; public uint Flags; }
    // SYSTEM_MEMORY_LIST_INFORMATION: 22 page counts (176 bytes on x64, 88 on x86).
    [StructLayout(LayoutKind.Sequential)]
    struct MemoryLists {
      public UIntPtr Zero; public UIntPtr Free; public UIntPtr Modified; public UIntPtr ModifiedNoWrite; public UIntPtr Bad;
      [MarshalAs(UnmanagedType.ByValArray, SizeConst = 8)] public UIntPtr[] StandbyByPriority;
      [MarshalAs(UnmanagedType.ByValArray, SizeConst = 8)] public UIntPtr[] RepurposedByPriority;
      public UIntPtr ModifiedPageFile;
    }
    [DllImport("ntdll.dll", EntryPoint = "NtSetSystemInformation")]
    static extern int NtSetMemoryList(int infoClass, ref int command, int length);
    [DllImport("ntdll.dll", EntryPoint = "NtSetSystemInformation")]
    static extern int NtSetCombine(int infoClass, ref CombineInfo info, int length);
    [DllImport("ntdll.dll", EntryPoint = "NtQuerySystemInformation")]
    static extern int NtQueryMemoryLists(int infoClass, ref MemoryLists info, int length, out int returned);

    public static Action<string> Log = delegate { };
    static readonly object gate = new object();
    static bool running;
    static int lastId;
    static Dictionary<string, object> last;

    public static int CombineInfoSize() { return Marshal.SizeOf(typeof(CombineInfo)); }
    public static int MemoryListsSize() { return Marshal.SizeOf(typeof(MemoryLists)); }

    // purgeBelowMb of a request: absent means 0 (never); a whole number from 0 to MaxPurgeBelowMb, else -1.
    public static int ParseMb(object v) {
      if (v == null) return 0;
      if (v is string || v is bool) return -1;
      double d;
      try { d = Convert.ToDouble(v, CultureInfo.InvariantCulture); } catch { return -1; }
      if (double.IsNaN(d) || d != Math.Floor(d) || d < 0 || d > MaxPurgeBelowMb) return -1;
      return (int)d;
    }

    // Free memory (zeroed and free pages) and the standby list (every priority) in MB: { free, standby }, or null
    // when Windows does not say. Read only. "Available" memory is the sum of the two, so it cannot tell them apart.
    public static long[] FreeAndStandbyMb() {
      try {
        MemoryLists l = new MemoryLists();
        int returned;
        int status = NtQueryMemoryLists(SystemMemoryListInformation, ref l, MemoryListsSize(), out returned);
        if (status < 0 || l.StandbyByPriority == null) return null;
        ulong page = (ulong)Environment.SystemPageSize;
        ulong standby = 0;
        foreach (UIntPtr n in l.StandbyByPriority) standby += n.ToUInt64();
        ulong free = l.Zero.ToUInt64() + l.Free.ToUInt64();
        return new long[] { (long)(free * page / 1048576UL), (long)(standby * page / 1048576UL) };
      } catch { return null; }
    }

    // Why the whole standby list is not purged, or null when it is: only when asked, less than purgeBelowMb is free
    // and the list holds at least that much. Purging never raises available memory (standby pages are available
    // already): it only makes them free ahead of time, which is worth the lost file cache in that one case.
    public static string StandbyDecision(int purgeBelowMb, long[] freeAndStandbyMb) {
      long[] m = freeAndStandbyMb;
      if (purgeBelowMb <= 0) return "not asked for";
      if (m == null || m.Length != 2 || m[0] < 0 || m[1] < 0) return "the memory lists could not be read";
      if (m[0] >= purgeBelowMb) return "enough memory is free";
      if (m[1] < purgeBelowMb) return "the standby list is small";
      return null;
    }

    public static string StatusText(int status) {
      switch (unchecked((uint)status)) {
        case 0xC0000061: return "the privilege is not held";
        case 0xC0000003: return "this Windows version does not support it";
        case 0xC0000004: return "this Windows version expects other data";
        case 0xC0000022: return "access denied";
        case 0xC00000BB: return "not supported";
        default: return "status 0x" + status.ToString("X8");
      }
    }

    static Dictionary<string, object> Step(string state, string detail) {
      Dictionary<string, object> r = new Dictionary<string, object>();
      r["state"] = state;
      if (!string.IsNullOrEmpty(detail)) r["detail"] = detail;
      return r;
    }

    // A step that ran, with how long it took ("ms": whole milliseconds). A step that never ran has no "ms".
    static Dictionary<string, object> Timed(Stopwatch sw, Dictionary<string, object> step) {
      step["ms"] = sw.ElapsedMilliseconds;
      return step;
    }

    static Dictionary<string, object> ListCommand(int command) {
      Stopwatch sw = Stopwatch.StartNew();
      try {
        int c = command;
        int status = NtSetMemoryList(SystemMemoryListInformation, ref c, sizeof(int));
        return Timed(sw, status >= 0 ? Step("done", null) : Step("failed", StatusText(status)));
      } catch (Exception e) { return Timed(sw, Step("failed", e.Message)); }
    }

    static Dictionary<string, object> Combine() {
      Stopwatch sw = Stopwatch.StartNew();
      try {
        CombineInfo info = new CombineInfo();
        int status = NtSetCombine(SystemCombinePhysicalMemoryInformation, ref info, CombineInfoSize());
        if (status < 0) return Timed(sw, Step("failed", StatusText(status)));
        Dictionary<string, object> r = Timed(sw, Step("done", null));
        r["pages"] = (double)info.PagesCombined.ToUInt64();
        return r;
      } catch (Exception e) { return Timed(sw, Step("failed", e.Message)); }
    }

    // The whole cleanup: its steps by name, each with the milliseconds it took ("ms") when it ran, and "totalMs" for
    // all of it. dryRun opens and checks the processes and does nothing else: no trim, no privilege, no memory list
    // command (what helper-csharp.test.ts runs).
    public static Dictionary<string, object> Run(int[] pids, bool shell, long createdBeforeMs, int purgeBelowMb, bool dryRun) {
      Stopwatch total = Stopwatch.StartNew();
      Dictionary<string, object> steps = new Dictionary<string, object>();
      RunSteps(steps, pids, shell, createdBeforeMs, purgeBelowMb, dryRun);
      steps["totalMs"] = total.ElapsedMilliseconds;
      return steps;
    }

    static void RunSteps(Dictionary<string, object> steps, int[] pids, bool shell, long createdBeforeMs, int purgeBelowMb, bool dryRun) {
      Dictionary<string, object> ws;
      Stopwatch sw = Stopwatch.StartNew();
      try {
        int[] c = TrimProcesses(pids, shell, createdBeforeMs, dryRun);
        ws = Timed(sw, Step("done", null));
        ws["trimmed"] = c[0];
        ws["denied"] = c[1];
        ws["skipped"] = c[2];
        ws["gone"] = c[3];
      } catch (Exception e) { ws = Timed(sw, Step("failed", e.Message)); }
      steps["workingSets"] = ws;
      string[] rest = new string[] { "modifiedList", "lowPriorityStandby", "standby", "combine" };
      if (dryRun) {
        foreach (string n in rest) steps[n] = Step("skipped", "dry run");
        return;
      }
      using (Privilege p = new Privilege("SeProfileSingleProcessPrivilege")) {
        if (p.Error != null) {
          foreach (string n in rest) steps[n] = Step("failed", p.Error);
          return;
        }
        steps["modifiedList"] = ListCommand(MemoryFlushModifiedList);
        steps["lowPriorityStandby"] = ListCommand(MemoryPurgeLowPriorityStandbyList);
        string why = StandbyDecision(purgeBelowMb, FreeAndStandbyMb());
        steps["standby"] = why == null ? ListCommand(MemoryPurgeStandbyList) : Step("skipped", why);
        steps["combine"] = Combine();
      }
    }

    // "memory: workingSets=done (131 trimmed, 412 ms) modifiedList=done (1830 ms) standby=skipped (why) total=4547 ms"
    public static string Summary(Dictionary<string, object> steps) {
      StringBuilder sb = new StringBuilder("memory:");
      foreach (KeyValuePair<string, object> kv in steps) {
        Dictionary<string, object> s = kv.Value as Dictionary<string, object>;
        if (s == null) continue;
        sb.Append(' ').Append(kv.Key).Append('=').Append(s["state"]);
        List<string> notes = new List<string>();
        object d;
        if (s.TryGetValue("trimmed", out d)) notes.Add(d + " trimmed");
        if (s.TryGetValue("detail", out d)) notes.Add(Convert.ToString(d));
        if (s.TryGetValue("ms", out d)) notes.Add(d + " ms");
        if (notes.Count > 0) sb.Append(" (").Append(string.Join(", ", notes.ToArray())).Append(')');
      }
      object t;
      if (steps.TryGetValue("totalMs", out t)) sb.Append(" total=").Append(t).Append(" ms");
      return sb.ToString();
    }

    // Starts a cleanup on its own thread: its id (1, 2, ...), or 0 when one is still running.
    public static int Start(int[] pids, bool shell, long createdBeforeMs, int purgeBelowMb) {
      int id;
      lock (gate) {
        if (running) return 0;
        running = true;
        last = null;
        id = ++lastId;
      }
      try {
        Thread t = new Thread(delegate () {
          Dictionary<string, object> steps;
          try { steps = Run(pids, shell, createdBeforeMs, purgeBelowMb, false); }
          catch (Exception e) {
            steps = new Dictionary<string, object>();
            steps["workingSets"] = Step("failed", e.Message);
          }
          lock (gate) { last = steps; running = false; }
          try { Log(Summary(steps)); } catch { }
        });
        t.IsBackground = true;
        t.Priority = ThreadPriority.BelowNormal;
        t.Start();
      } catch {
        lock (gate) { running = false; }
        throw;
      }
      return id;
    }

    // memResult: the last cleanup's id, whether it still runs, and its steps once it has ended.
    public static Dictionary<string, object> Result() {
      Dictionary<string, object> r = new Dictionary<string, object>();
      lock (gate) {
        r["id"] = lastId;
        r["running"] = running;
        if (!running && last != null) r["steps"] = last;
      }
      return r;
    }
  }

  public static class Server {
    public const int ProtocolVersion = ${HELPER_PROTOCOL_VERSION};
    const int IdleMs = 120000;
    const int MaxLine = 65536;
    const int SmuMinWatts = ${SMU_MIN_WATTS};

    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static string dir, pawnDir, stateFile, logFile;
    static string method, cpuName, vendor, unsupported;
    static SmuFamily fam;
    static Pawn pawn;

    static void Log(string text) {
      try {
        File.AppendAllText(logFile, DateTime.Now.ToString("s", CultureInfo.InvariantCulture) + " " + text + Environment.NewLine);
      } catch { }
    }

    static void Identify() {
      using (RegistryKey k = Registry.LocalMachine.OpenSubKey(@"HARDWARE\DESCRIPTION\System\CentralProcessor\0")) {
        vendor = k == null ? "" : Convert.ToString(k.GetValue("VendorIdentifier", ""));
        cpuName = k == null ? "" : Convert.ToString(k.GetValue("ProcessorNameString", "")).Trim();
        string id = k == null ? "" : Convert.ToString(k.GetValue("Identifier", ""));
        int family = -1, model = -1;
        string[] parts = id.Split(' ');
        for (int i = 0; i + 1 < parts.Length; i++) {
          if (parts[i] == "Family") int.TryParse(parts[i + 1], out family);
          if (parts[i] == "Model") int.TryParse(parts[i + 1], out model);
        }
        if (vendor == "GenuineIntel") method = "intel-msr";
        else if (vendor == "AuthenticAMD") {
          fam = Smu.For(family, model);
          if (fam != null) method = "ryzen-smu";
          else unsupported = "This AMD processor (family " + family + ", model " + model + ") is not one PlayOut can set watts on.";
        } else unsupported = "This processor (" + vendor + ") is not supported.";
      }
    }

    static Pawn Driver() {
      if (pawn != null) return pawn;
      Pawn.LoadLibrary(pawnDir);
      string module = Path.Combine(dir, method == "intel-msr" ? "IntelMSR.bin" : "RyzenSMU.bin");
      if (!File.Exists(module)) throw new Exception("The PawnIO module is missing (" + module + "); reinstall the power helper.");
      pawn = new Pawn(module);
      return pawn;
    }

    // --- state: the limits before PlayOut's first change, put back by "restore" ---
    // Saved with the boot it was taken in: after a restart the firmware (or an OEM tool, or a BIOS change) has put
    // its own limits back, so a state from another boot is stale and is dropped (the next set saves the limits in
    // force then).
    public static Dictionary<string, object> ReadState(string path, long boot) {
      Dictionary<string, object> s = null;
      try {
        if (File.Exists(path)) s = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(path));
      } catch { }
      if (s == null) return null;
      if (Boot.Same(s, boot)) return s;
      Log("dropping the saved limits of another boot");
      try { File.Delete(path); } catch { }
      return null;
    }
    static Dictionary<string, object> LoadState() { return ReadState(stateFile, Boot.Minute()); }
    static void SaveState(Dictionary<string, object> s) {
      if (s == null) { if (File.Exists(stateFile)) File.Delete(stateFile); return; }
      s["boot"] = Boot.Minute();
      File.WriteAllText(stateFile, Json.Serialize(s));
    }

    // --- Intel ---
    static ulong Rd(uint msr) { return Driver().Exec("ioctl_read_msr", new ulong[] { msr }, 1)[0]; }
    static void Wr(uint msr, ulong v) { Driver().Exec("ioctl_write_msr", new ulong[] { msr, v }, 0); }

    static Dictionary<string, object> IntelInfo() {
      ulong units = Rd(Rapl.PowerUnit);
      double u = Rapl.UnitWatts(units);
      ulong lim = Rd(Rapl.PowerLimit);
      int[] range = Rapl.Range(Rd(Rapl.PowerInfo), u);
      ulong e1 = Rd(Rapl.EnergyStatus) & 0xFFFFFFFFUL;
      Stopwatch sw = Stopwatch.StartNew();
      Thread.Sleep(250);
      ulong e2 = Rd(Rapl.EnergyStatus) & 0xFFFFFFFFUL;
      double seconds = sw.Elapsed.TotalSeconds;
      double now = ((e2 - e1) & 0xFFFFFFFFUL) * Rapl.EnergyJoules(units) / Math.Max(seconds, 0.01);
      Dictionary<string, object> r = new Dictionary<string, object>();
      r["minWatts"] = range[0];
      r["maxWatts"] = range[1];
      r["currentWatts"] = Math.Round(now, 1);
      r["watts"] = Math.Round(Rapl.Pl1(lim, u), 1);
      r["boostWatts"] = Math.Round(Rapl.Pl2(lim, u), 1);
      if (Rapl.Locked(lim)) {
        r["locked"] = true;
        r["message"] = "The firmware locked this processor's power limit (MSR 0x610 lock bit), so PlayOut cannot change its watts.";
      }
      return r;
    }

    static Dictionary<string, object> IntelSet(double pl1, double pl2) {
      ulong units = Rd(Rapl.PowerUnit);
      double u = Rapl.UnitWatts(units);
      ulong lim = Rd(Rapl.PowerLimit);
      if (Rapl.Locked(lim)) throw new Exception("The firmware locked this processor's power limit (MSR 0x610 lock bit), so PlayOut cannot change its watts.");
      int[] range = Rapl.Range(Rd(Rapl.PowerInfo), u);
      if (pl1 >= 0) pl1 = Math.Min(range[1], Math.Max(range[0], Math.Round(pl1)));
      if (pl2 >= 0) pl2 = Math.Min(range[1], Math.Max(range[0], Math.Round(pl2)));
      // Keep PL2 at least 1 W above PL1 (Intel's guidance), also when only PL1 changes.
      double effectivePl2 = pl2 >= 0 ? pl2 : Rapl.Pl2(lim, u);
      if (pl1 >= 0 && effectivePl2 < pl1 + 1) pl2 = pl1 + 1;
      Dictionary<string, object> s = LoadState();
      if (s != null && (!s.ContainsKey("intel610") || !StillOurs(s, lim))) {
        Log("MSR 0x610 changed since PlayOut set it: the limits in force now are the ones to put back");
        s = null;
      }
      if (s == null) {
        s = new Dictionary<string, object>();
        s["intel610"] = lim.ToString(CultureInfo.InvariantCulture);
      }
      // No "written" while the write is in flight: a crash then leaves a state that is still trusted.
      s.Remove("intel610w");
      SaveState(s);
      ulong next = Rapl.Encode(lim, u, pl1, pl2);
      Wr(Rapl.PowerLimit, next);
      ulong back = Rd(Rapl.PowerLimit);
      if (back != next) Log("MSR 0x610 reads back 0x" + back.ToString("X16") + " after writing 0x" + next.ToString("X16"));
      s["intel610w"] = back.ToString(CultureInfo.InvariantCulture);
      SaveState(s);
      Dictionary<string, object> r = new Dictionary<string, object>();
      r["watts"] = Math.Round(Rapl.Pl1(back, u), 1);
      r["boostWatts"] = Math.Round(Rapl.Pl2(back, u), 1);
      return r;
    }

    static void IntelRestore() {
      Dictionary<string, object> s = LoadState();
      if (s == null || !s.ContainsKey("intel610")) return;
      ulong v = ulong.Parse(Convert.ToString(s["intel610"], CultureInfo.InvariantCulture), CultureInfo.InvariantCulture);
      ulong cur = Rd(Rapl.PowerLimit);
      if (!StillOurs(s, cur)) Log("MSR 0x610 changed since PlayOut set it (a cold or fast-startup boot, a resume or another tool): left as it is");
      else if (!Rapl.Locked(cur)) Wr(Rapl.PowerLimit, v);
      SaveState(null);
    }

    // The register still holds what PlayOut last wrote (state "intel610w"; no record: a write was in flight, so
    // trusted). Anything else means the firmware (a cold boot, a fast-startup boot, resume from hibernation, which
    // the boot stamp misses because the uptime goes on) or another tool has put its own limits in since, so the saved
    // "before" is stale: it is neither written back nor kept.
    public static bool StillOurs(Dictionary<string, object> s, ulong current) {
      object w;
      if (s == null || !s.TryGetValue("intel610w", out w) || w == null) return true;
      return Convert.ToString(w, CultureInfo.InvariantCulture) == current.ToString(CultureInfo.InvariantCulture);
    }

    // --- AMD ---
    static T WithPci<T>(Func<T> work) {
      using (Mutex m = new Mutex(false, @"Global\Access_PCI")) {
        bool owned = false;
        try {
          try { owned = m.WaitOne(2000); } catch (AbandonedMutexException) { owned = true; }
          if (!owned) throw new Exception("Another program is using the processor's SMU; try again.");
          return work();
        } finally {
          if (owned) m.ReleaseMutex();
        }
      }
    }

    static float Half(ulong q, bool high) { return BitConverter.ToSingle(BitConverter.GetBytes(q), high ? 4 : 0); }
    static bool Sane(float w) { return !float.IsNaN(w) && w >= 1 && w <= 300; }

    // RyzenAdj's PM tables start with STAPM limit/value, fast limit/value, slow limit/value (floats, watts).
    static float[] PmLimits() {
      try {
        return WithPci(() => {
          Pawn p = Driver();
          p.Exec("ioctl_resolve_pm_table", new ulong[0], 2);
          p.Exec("ioctl_update_pm_table", new ulong[0], 0);
          ulong[] t = p.Exec("ioctl_read_pm_table", new ulong[0], 16);
          float[] f = new float[] { Half(t[0], false), Half(t[0], true), Half(t[1], false), Half(t[1], true), Half(t[2], false), Half(t[2], true) };
          return Sane(f[0]) && Sane(f[2]) && Sane(f[4]) ? f : null;
        });
      } catch (Exception e) {
        Log("PM table: " + e.Message);
        return null;
      }
    }

    public const string NoBackupMessage = "Could not read the current power limits, so they were not changed.";

    // The state that lets "restore" put the PM table's limits back; throws when they could not be read.
    public static Dictionary<string, object> AmdBackup(float[] pm) {
      if (pm == null) throw new Exception(NoBackupMessage);
      Dictionary<string, object> s = new Dictionary<string, object>();
      s["amdStapm"] = (double)pm[0];
      s["amdFast"] = (double)pm[2];
      s["amdSlow"] = (double)pm[4];
      return s;
    }

    static Dictionary<string, object> AmdInfo() {
      Dictionary<string, object> r = new Dictionary<string, object>();
      r["minWatts"] = SmuMinWatts;
      r["maxWatts"] = fam.MaxWatts;
      Driver();
      float[] pm = PmLimits();
      if (pm != null) {
        r["watts"] = Math.Round(pm[0], 1);
        r["boostWatts"] = Math.Round(pm[2], 1);
        if (pm[1] >= 0 && pm[1] <= 300) r["currentWatts"] = Math.Round(pm[1], 1);
      }
      return r;
    }

    static void AmdSend(uint cmd, double watts, string what) {
      uint mw = (uint)Math.Round(watts * 1000);
      uint rsp = WithPci(() => Smu.Send(new PawnRegs(Driver()), fam, cmd, new uint[] { mw }, 8192));
      if (rsp != 1) throw new Exception("Setting the " + what + " limit failed: " + Smu.ResponseText(rsp) + ".");
    }

    static Dictionary<string, object> AmdSet(double watts, double boost) {
      if (watts >= 0) watts = Math.Min(fam.MaxWatts, Math.Max(SmuMinWatts, Math.Round(watts)));
      if (boost >= 0) boost = Math.Min(fam.MaxWatts, Math.Max(SmuMinWatts, Math.Round(boost)));
      // Without a backup of the limits in force, "restore" could not undo the change: refuse it.
      if (LoadState() == null) SaveState(AmdBackup(PmLimits()));
      if (watts >= 0) { AmdSend(fam.Stapm, watts, "STAPM"); AmdSend(fam.Slow, watts, "slow"); }
      if (boost >= 0) AmdSend(fam.Fast, boost, "fast");
      Dictionary<string, object> r = new Dictionary<string, object>();
      if (watts >= 0) r["watts"] = watts;
      if (boost >= 0) r["boostWatts"] = boost;
      return r;
    }

    static void AmdRestore() {
      Dictionary<string, object> s = LoadState();
      if (s == null || !s.ContainsKey("amdStapm")) return;
      AmdSend(fam.Stapm, Convert.ToDouble(s["amdStapm"], CultureInfo.InvariantCulture), "STAPM");
      AmdSend(fam.Fast, Convert.ToDouble(s["amdFast"], CultureInfo.InvariantCulture), "fast");
      AmdSend(fam.Slow, Convert.ToDouble(s["amdSlow"], CultureInfo.InvariantCulture), "slow");
      SaveState(null);
    }

    // --- requests ---
    static double Num(Dictionary<string, object> d, string key) {
      object v;
      if (!d.TryGetValue(key, out v) || v == null) return -1;
      double x = Convert.ToDouble(v, CultureInfo.InvariantCulture);
      return double.IsNaN(x) || double.IsInfinity(x) || x <= 0 ? -1 : x;
    }

    static string Answer(Dictionary<string, object> r) {
      r["ok"] = true;
      return Json.Serialize(r);
    }

    static string Fail(string error) {
      Dictionary<string, object> r = new Dictionary<string, object>();
      r["ok"] = false;
      r["error"] = error;
      return Json.Serialize(r);
    }

    public static string Handle(string line) {
      Dictionary<string, object> req;
      try { req = Json.Deserialize<Dictionary<string, object>>(line); } catch { return Fail("Not a JSON request."); }
      if (req == null) return Fail("Not a JSON request.");
      object op;
      req.TryGetValue("op", out op);
      string name = op as string;
      try {
        if (name == "info") {
          Dictionary<string, object> r = new Dictionary<string, object>();
          if (method == "intel-msr") r = IntelInfo();
          else if (method == "ryzen-smu") r = AmdInfo();
          else r["message"] = unsupported;
          r["method"] = method;
          r["cpu"] = cpuName;
          r["version"] = ProtocolVersion;
          return Answer(r);
        }
        if (name == "set") {
          if (method == null) return Fail(unsupported);
          double w = Num(req, "watts"), b = Num(req, "boostWatts");
          return Answer(method == "intel-msr" ? IntelSet(w, b) : AmdSet(w, b));
        }
        if (name == "restore") {
          if (method == "intel-msr") IntelRestore();
          else if (method == "ryzen-smu") AmdRestore();
          return Answer(new Dictionary<string, object>());
        }
        if (name == "fpsStart") {
          object pids;
          req.TryGetValue("pids", out pids);
          Fps.Start(dir, Fps.ParsePids(pids));
          return Answer(new Dictionary<string, object>());
        }
        if (name == "fps") return Answer(Fps.Read());
        if (name == "fpsStop") {
          Fps.Stop();
          return Answer(new Dictionary<string, object>());
        }
        if (name == "rtssRestore") {
          Dictionary<string, object> r = new Dictionary<string, object>();
          r["restored"] = Rtss.RestoreAll(Rtss.ProfilesDir(), Path.Combine(dir, "rtss-limits.json"));
          return Answer(r);
        }
        if (name == "rtssLimit" || name == "rtssSelf") {
          object e;
          req.TryGetValue("exe", out e);
          string exe = e as string;
          if (!Rtss.IsProfileExe(exe)) return Fail(Rtss.NotProgram);
          if (name == "rtssSelf") {
            Dictionary<string, object> r = new Dictionary<string, object>();
            r["changed"] = Rtss.Self(Rtss.ProfilesDir(), Path.Combine(dir, "rtss-limits.json"), exe);
            return Answer(r);
          }
          object f;
          req.TryGetValue("fps", out f);
          int fps = Rtss.ParseFps(f);
          if (fps < 0) return Fail("Not a frame rate limit.");
          return Answer(Rtss.Limit(Rtss.ProfilesDir(), Path.Combine(dir, "rtss-limits.json"), exe, fps));
        }
        if (name == "memTrim") {
          object p, s, b, t;
          req.TryGetValue("pids", out p);
          req.TryGetValue("createdBefore", out t);
          req.TryGetValue("shell", out s);
          req.TryGetValue("purgeBelowMb", out b);
          int[] pids = Mem.ParsePids(p);
          if (pids == null) return Fail(Mem.NotList);
          if (s != null && !(s is bool)) return Fail(Mem.NotFlag);
          int below = Mem.ParseMb(b);
          if (below < 0) return Fail(Mem.NotAmount);
          long before = Mem.ParseTime(t);
          if (before < 0) return Fail(Mem.NotTime);
          int id = Mem.Start(pids, s != null && (bool)s, before, below);
          if (id == 0) return Fail(Mem.Busy);
          Dictionary<string, object> r = new Dictionary<string, object>();
          r["id"] = id;
          return Answer(r);
        }
        if (name == "memResult") return Answer(Mem.Result());
        return Fail("Unknown request.");
      } catch (Exception e) {
        Log(name + ": " + e.Message);
        return Fail(e.Message);
      }
    }

    static string ReadLine(StreamReader reader) {
      StringBuilder sb = new StringBuilder();
      while (true) {
        int c = reader.Read();
        if (c < 0) return sb.Length > 0 ? sb.ToString() : null;
        if (c == '\n') return sb.ToString().TrimEnd('\r');
        if (sb.Length >= MaxLine) return null;
        sb.Append((char)c);
      }
    }

    static void Serve(NamedPipeServerStream pipe) {
      UTF8Encoding utf8 = new UTF8Encoding(false);
      using (StreamReader reader = new StreamReader(pipe, utf8, false, 4096, true))
      using (StreamWriter writer = new StreamWriter(pipe, utf8, 4096, true)) {
        writer.NewLine = "\n";
        writer.AutoFlush = true;
        try {
          string line;
          while ((line = ReadLine(reader)) != null) {
            if (line.Trim().Length == 0) continue;
            writer.WriteLine(Handle(line));
          }
        } catch (IOException) { }
      }
    }

    static bool OwnerAlive(string[] names) {
      foreach (string n in names) {
        Process[] ps = Process.GetProcessesByName(n);
        bool any = ps.Length > 0;
        foreach (Process p in ps) p.Dispose();
        if (any) return true;
      }
      return false;
    }

    public static PipeSecurity Security(string sid) {
      PipeSecurity sec = new PipeSecurity();
      sec.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null), PipeAccessRights.FullControl, AccessControlType.Deny));
      sec.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(sid), PipeAccessRights.ReadWrite | PipeAccessRights.CreateNewInstance | PipeAccessRights.Synchronize, AccessControlType.Allow));
      sec.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
      sec.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
      return sec;
    }

    // The user the installer stored in user.sid (a local or domain account: S-1-5-21-...), or null.
    public static string UserSid(string text) {
      if (text == null) return null;
      string sid = text.Trim();
      if (!System.Text.RegularExpressions.Regex.IsMatch(sid, @"^S-1-5-21(-\d+){3,4}$")) return null;
      try { return new SecurityIdentifier(sid).Value; } catch { return null; }
    }

    static void IdleRestore() {
      try { Fps.Stop(); } catch { }
      try { if (method == "intel-msr") IntelRestore(); else if (method == "ryzen-smu") AmdRestore(); } catch (Exception e) { Log("restore: " + e.Message); }
    }

    // RivaTuner records a removal kept in the admin-only PlayOut folder (script.ts removeScript, when the profiles
    // could not be put back first) come back into the helper's folder, so those limits can still be put back.
    static void KeepRtssRecords() {
      try {
        string parent = Path.GetDirectoryName(Path.GetFullPath(dir).TrimEnd('\\'));
        if (parent == null || !Rtss.AdminOwned(parent)) return;
        string kept = Path.Combine(parent, "rtss-limits.json");
        if (!File.Exists(kept)) return;
        string records = Path.Combine(dir, "rtss-limits.json");
        if (File.Exists(records)) File.Delete(kept);
        else File.Move(kept, records);
        Log("RivaTuner records kept by the removal taken back");
      } catch (Exception e) { Log("RivaTuner records: " + e.Message); }
    }

    // Runs as SYSTEM from boot (helper.ps1 runs it again a minute after a crash) and serves the pipe of the user who
    // installed it. It never exits on its own; when PlayOut has been gone for two minutes the limits PlayOut set are
    // put back once (PlayOut crashed or was killed), and served again as soon as PlayOut connects.
    public static int Run(string helperDir, string pawnioDir, string watch, string userSidText) {
      dir = helperDir;
      pawnDir = pawnioDir;
      stateFile = Path.Combine(dir, "state.json");
      logFile = Path.Combine(dir, "helper.log");
      try { if (File.Exists(logFile) && new FileInfo(logFile).Length > 262144) File.Delete(logFile); } catch { }
      KeepRtssRecords();
      string sid = UserSid(userSidText);
      if (sid == null) {
        Log("no valid user.sid: reinstall the power helper");
        return 3;
      }
      Identify();
      Fps.Log = Log;
      Mem.Log = Log;
      PipeSecurity sec = Security(sid);
      string[] names = watch.Split(',');
      DateTime lastSeen = DateTime.UtcNow;
      bool idleRestored = false;
      Log("started: " + cpuName + " (" + (method ?? "unsupported") + ") for " + sid);
      NamedPipeServerStream server;
      try {
        // One instance, kept for the helper's life (Disconnect between clients), so the name is never free.
        server = new NamedPipeServerStream("PlayOutPower-" + sid, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 4096, 4096, sec);
      } catch (IOException) {
        Log("another helper serves the pipe");
        return 2;
      }
      AppDomain.CurrentDomain.ProcessExit += delegate (object s, EventArgs e) { Fps.Stop(); };
      try {
      using (server) {
        while (true) {
          IAsyncResult ar = server.BeginWaitForConnection(null, null);
          while (!ar.AsyncWaitHandle.WaitOne(5000)) {
            if (OwnerAlive(names)) { lastSeen = DateTime.UtcNow; idleRestored = false; }
            else if (!idleRestored && (DateTime.UtcNow - lastSeen).TotalMilliseconds > IdleMs) {
              IdleRestore();
              idleRestored = true;
              Log("PlayOut is gone: limits put back");
            }
          }
          try { server.EndWaitForConnection(ar); } catch (IOException) { try { server.Disconnect(); } catch { } continue; }
          lastSeen = DateTime.UtcNow;
          idleRestored = false;
          Serve(server);
          lastSeen = DateTime.UtcNow;
          try { server.Disconnect(); } catch { }
        }
      }
      } finally {
        Fps.Stop();
      }
    }
  }
}
`
}
