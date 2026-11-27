import { HARD_NEVER_NAMES, HARD_NEVER_PREFIXES } from './names'

/**
 * The C# that trims working sets, shared by both tiers so they cannot drift apart: the members below are compiled
 * into PlayOutMemory (native-host/native-cs.ts, PlayOut's own non-elevated PowerShell worker) and into
 * PlayOutPower.Mem (helper/csharp.ts, the elevated power helper). C# 5 (Windows PowerShell 5.1's Add-Type).
 *
 * It only ever trims the pids it is given (exclusions.ts decides them), and checks each opened process again:
 * - by its creation time: a process created at or after `createdBeforeMs` (when the process list the pids come from
 *   was read) is left alone. That is what keeps a process id reused since then (by a new game process, a new PlayOut
 *   process, the program just brought to the front) from being trimmed: PlayOut's own processes, the game and the
 *   foreground program are known to TypeScript only, by pid.
 * - by its own image path: nothing in Windows' folder (explorer.exe only when `shell` says so), no security
 *   software, anti-cheat service or streaming host.
 * A process whose creation time or path cannot be read is left alone.
 *
 * Needs: using System; System.Collections.Generic; System.IO; System.Runtime.InteropServices; System.Text.
 */

/** The same cap as exclusions.ts MAX_TRIM_PIDS (kept apart: this file must not import the launcher). */
export const TRIM_CS_MAX_PIDS = 1024

const csList = (names: readonly string[]): string =>
  names
    .map((n) => {
      if (!/^[a-z0-9 ._-]+$/.test(n)) throw new Error(`Not an image name: ${n}`)
      return `"${n}"`
    })
    .join(', ')

/** Class members (no class header): constants, P/Invokes, Protected, ParsePids and TrimProcesses. */
export function trimCSharpMembers(): string {
  return String.raw`
    public const int MaxPids = ${TRIM_CS_MAX_PIDS};
    const uint ProcessSetQuota = 0x0100;
    const uint ProcessQueryLimitedInformation = 0x1000;
    const int ErrorInvalidParameter = 87;
    static readonly HashSet<string> NeverNames = new HashSet<string>(new string[] { ${csList(HARD_NEVER_NAMES)} }, StringComparer.OrdinalIgnoreCase);
    static readonly string[] NeverPrefixes = new string[] { ${csList(HARD_NEVER_PREFIXES)} };

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", EntryPoint = "CloseHandle")]
    static extern bool CloseProcessHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool K32EmptyWorkingSet(IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll")]
    static extern uint GetCurrentProcessId();

    // FILETIME (100 ns since 1601, UTC) of the Unix epoch.
    const long UnixEpochFileTime = 116444736000000000L;

    // When the opened process was created, in Unix milliseconds (what JavaScript's Date.now() gives); -1 when unknown.
    public static long CreatedMs(IntPtr process) {
      long creation, exit, kernel, user;
      if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) return -1;
      return FileTimeToUnixMs(creation);
    }

    public static long FileTimeToUnixMs(long fileTime) {
      if (fileTime <= UnixEpochFileTime) return -1;
      return (fileTime - UnixEpochFileTime) / 10000L;
    }

    // A process created at or after the moment the pid list was read is not the one the list meant (or is too new to
    // have been decided about): never trimmed. Unknown creation time: never trimmed either.
    public static bool TooNew(long createdMs, long createdBeforeMs) {
      return createdMs < 0 || createdMs >= createdBeforeMs;
    }

    // createdBefore of a request: whole Unix milliseconds above 0, else -1 (the request is refused).
    public static long ParseTime(object v) {
      if (v == null || v is string || v is bool) return -1;
      double d;
      try { d = Convert.ToDouble(v, System.Globalization.CultureInfo.InvariantCulture); } catch { return -1; }
      if (double.IsNaN(d) || d != Math.Floor(d) || d <= 0 || d > 9007199254740991.0) return -1;
      return (long)d;
    }

    // Windows' folder with a trailing backslash ("C:\Windows\").
    public static string WindowsDir() {
      string w = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
      if (string.IsNullOrEmpty(w)) return null;
      return w.TrimEnd('\\') + "\\";
    }

    // Never trimmed, whatever the pid list says: a program whose path is unknown, anything in Windows' folder
    // (explorer.exe itself only when "shell" allows it), security software, anti-cheat services and streaming.
    public static bool Protected(string path, bool shell) { return Protected(path, shell, WindowsDir()); }

    public static bool Protected(string path, bool shell, string windowsDir) {
      if (string.IsNullOrEmpty(path) || string.IsNullOrEmpty(windowsDir)) return true;
      string name;
      try { name = Path.GetFileName(path); } catch { return true; }
      if (string.IsNullOrEmpty(name)) return true;
      name = name.ToLowerInvariant();
      if (name.EndsWith(".exe")) name = name.Substring(0, name.Length - 4);
      if (name.Length == 0 || NeverNames.Contains(name)) return true;
      foreach (string p in NeverPrefixes) if (name.StartsWith(p, StringComparison.Ordinal)) return true;
      if (path.StartsWith(windowsDir, StringComparison.OrdinalIgnoreCase))
        return !(shell && string.Equals(path, windowsDir + "explorer.exe", StringComparison.OrdinalIgnoreCase));
      return false;
    }

    // A pid list from a request: every entry a whole number above 4, at most MaxPids of them (repeats dropped).
    // Null when it is anything else: the whole request is refused, nothing is guessed.
    public static int[] ParsePids(object v) {
      System.Collections.IEnumerable list = v as System.Collections.IEnumerable;
      if (list == null || v is string) return null;
      List<int> pids = new List<int>();
      HashSet<int> seen = new HashSet<int>();
      foreach (object o in list) {
        if (o == null || o is string || o is bool) return null;
        double d;
        try { d = Convert.ToDouble(o, System.Globalization.CultureInfo.InvariantCulture); } catch { return null; }
        if (double.IsNaN(d) || d != Math.Floor(d) || d <= 4 || d > int.MaxValue) return null;
        if (seen.Add((int)d)) pids.Add((int)d);
        if (pids.Count > MaxPids) return null;
      }
      return pids.ToArray();
    }

    // Trims the working set of each pid: { trimmed, denied, skipped, gone }. "denied": Windows did not let this
    // account open or trim it (normal for other accounts' and protected programs). "skipped": this process itself, a
    // process created at or after createdBeforeMs (Unix ms: when the pid list was read) or a protected program.
    // "gone": no such process any more. dryRun opens and checks each process but trims nothing.
    public static int[] TrimProcesses(int[] pids, bool shell, long createdBeforeMs, bool dryRun) {
      int trimmed = 0, denied = 0, skipped = 0, gone = 0;
      if (pids == null) return new int[] { 0, 0, 0, 0 };
      if (pids.Length > MaxPids) throw new Exception("Too many processes.");
      uint self = GetCurrentProcessId();
      string windowsDir = WindowsDir();
      uint access = dryRun ? ProcessQueryLimitedInformation : (ProcessSetQuota | ProcessQueryLimitedInformation);
      foreach (int pid in pids) {
        if (pid <= 4 || (uint)pid == self) { skipped++; continue; }
        IntPtr h = OpenProcess(access, false, (uint)pid);
        if (h == IntPtr.Zero) {
          if (Marshal.GetLastWin32Error() == ErrorInvalidParameter) gone++; else denied++;
          continue;
        }
        try {
          if (TooNew(CreatedMs(h), createdBeforeMs)) { skipped++; continue; }
          StringBuilder sb = new StringBuilder(1024);
          uint size = (uint)sb.Capacity;
          string path = QueryFullProcessImageNameW(h, 0, sb, ref size) ? sb.ToString() : null;
          if (Protected(path, shell, windowsDir)) skipped++;
          else if (dryRun || K32EmptyWorkingSet(h)) trimmed++;
          else denied++;
        } finally {
          CloseProcessHandle(h);
        }
      }
      return new int[] { trimmed, denied, skipped, gone };
    }
`
}

/** What TrimProcesses counted. */
export interface TrimCounts {
  trimmed: number
  denied: number
  /** Left alone by the C#'s own checks (created after the process list was read, or protected by path or name). */
  skipped: number
  /** Ended between the process list and the trim. */
  gone: number
  /** How long the trim took, when the answer says (PlayOutMemory.Trim does; see parseElapsedMs). */
  ms?: number
}

/** No step of a cleanup is believed to have taken longer than this (ten minutes): a larger number is cut to it. */
export const MAX_ELAPSED_MS = 600_000

/**
 * An elapsed time either tier reports ("ms" of a step, "totalMs" of a cleanup): whole milliseconds from 0 to
 * MAX_ELAPSED_MS. Undefined when it is missing or not a time (a helper from before timings existed, a negative or
 * non-finite number): the time is then simply not known, the answer around it is still good.
 */
export function parseElapsedMs(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined
  return Math.min(Math.round(v), MAX_ELAPSED_MS)
}

const count = (v: unknown): number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0

/** { trimmed, denied, skipped, gone } from either tier's answer; anything missing counts as 0. */
export function parseTrimCounts(raw: unknown): TrimCounts {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    trimmed: count(o.trimmed),
    denied: count(o.denied),
    skipped: count(o.skipped),
    gone: count(o.gone)
  }
}
