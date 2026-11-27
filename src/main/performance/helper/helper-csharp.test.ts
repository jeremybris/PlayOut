import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir, totalmem } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { decodePowerLimit, encodePowerLimit, intelWattsRange, decodePowerInfo } from '../msr'
import { FpsMeter, PRESENTMON_ARGS, PRESENTMON_DOWNLOAD } from '../presentmon'
import { SMU_FAMILIES, smuFamilyFor, smuSend, type SmuRegisters } from '../smu'
import { getIniValue, iniIsEmpty, setIniValue } from '../../rtss/ini'
import { isProfileExe } from '../../rtss/memory'
import { HARD_NEVER_NAMES } from '../memory/names'
import { helperCSharp } from './csharp'
import { MAX_PURGE_BELOW_MB, MAX_TRIM_PIDS, parseMemSteps } from './protocol'

/**
 * Compiles the helper's C# exactly as helper.ps1 does (Windows PowerShell 5.1 Add-Type) and checks its pure parts
 * against the TypeScript reference: RAPL encoding, the SMU family table and the MP1 mailbox sequence (fake register
 * file), request parsing and the pipe's ACL. Nothing touches a driver.
 */

const ENCODE_CASES: [bigint, number, number | null, number | null][] = [
  [0x0042_8168_00df_8118n, 1 / 8, 15, 25],
  [0x0042_8168_00df_8118n, 1 / 8, 28, null],
  [0x0042_8168_00df_8118n, 1 / 8, null, 64],
  [0x8000_0000_0000_0000n, 1 / 8, 10, 11],
  [0x0000_0000_0000_0000n, 1 / 16, 4.5, 37.03],
  [0x00ff_ffff_ffff_ffffn, 1 / 8, 5000, 0.01]
]

const INFO_CASES: bigint[] = [
  0n,
  0x0000_0168_0028_00e0n,
  0x0000_0000_0000_00e0n,
  0x0000_0000_0000_0050n
]

/** An SMU that answers `answer` on the (busyReads + 1)th read of RSP after a message is written. */
class FakeRegs implements SmuRegisters {
  private readonly regs = new Map<number, number>()
  readonly log: string[] = []
  private pendingReads = 0
  constructor(
    private readonly rsp: number,
    private readonly msg: number,
    private readonly answer: number,
    private readonly busyReads: number,
    initial: number
  ) {
    this.regs.set(rsp, initial)
  }
  read(addr: number): number {
    if (addr === this.rsp && this.pendingReads > 0) {
      this.pendingReads--
      if (this.pendingReads === 0) this.regs.set(this.rsp, this.answer)
    }
    const v = this.regs.get(addr) ?? 0
    this.log.push(`R${addr.toString(16)}=${v}`)
    return v
  }
  write(addr: number, value: number): void {
    this.log.push(`W${addr.toString(16)}=${value}`)
    this.regs.set(addr, value)
    if (addr === this.msg) this.pendingReads = this.busyReads + 1
  }
}

const FAKE_CS = `
public class FakeRegs : PlayOutPower.IRegs {
  public System.Collections.Generic.List<string> Log = new System.Collections.Generic.List<string>();
  System.Collections.Generic.Dictionary<uint, uint> regs = new System.Collections.Generic.Dictionary<uint, uint>();
  uint rsp, msg, answer; int busyReads, pendingReads;
  public FakeRegs(uint rsp, uint msg, uint answer, int busyReads, uint initial) { this.rsp = rsp; this.msg = msg; this.answer = answer; this.busyReads = busyReads; regs[rsp] = initial; }
  public uint Read(uint addr) {
    if (addr == rsp && pendingReads > 0) { pendingReads--; if (pendingReads == 0) regs[rsp] = answer; }
    uint v; if (!regs.TryGetValue(addr, out v)) v = 0;
    Log.Add("R" + addr.ToString("x") + "=" + v); return v;
  }
  public void Write(uint addr, uint value) {
    Log.Add("W" + addr.ToString("x") + "=" + value); regs[addr] = value;
    if (addr == msg) pendingReads = busyReads + 1;
  }
}
// Looks an export up by name without calling it: the entry points the memory cleanup binds to exist on this Windows.
public static class ExportProbe {
  [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
  static extern System.IntPtr GetModuleHandleW(string name);
  [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
  static extern System.IntPtr LoadLibraryW(string name);
  [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Ansi, BestFitMapping = false)]
  static extern System.IntPtr GetProcAddress(System.IntPtr module, string name);
  public static bool Has(string dll, string name) {
    System.IntPtr m = GetModuleHandleW(dll);
    if (m == System.IntPtr.Zero) m = LoadLibraryW(dll);
    return m != System.IntPtr.Zero && GetProcAddress(m, name) != System.IntPtr.Zero;
  }
}
`

/** The Windows entry points the memory cleanup's P/Invokes name (trim-cs.ts, csharp.ts Privilege and Mem). */
const MEM_EXPORTS: [string, string][] = [
  ['kernel32.dll', 'OpenProcess'],
  ['kernel32.dll', 'K32EmptyWorkingSet'],
  ['kernel32.dll', 'QueryFullProcessImageNameW'],
  ['kernel32.dll', 'GetProcessTimes'],
  ['ntdll.dll', 'NtQuerySystemInformation'],
  ['ntdll.dll', 'NtSetSystemInformation'],
  ['advapi32.dll', 'OpenProcessToken'],
  ['advapi32.dll', 'LookupPrivilegeValueW'],
  ['advapi32.dll', 'AdjustTokenPrivileges']
]

const SEND_CASES = [
  { fam: 'Phoenix', cmd: 0x14, args: [15000], answer: 1, busy: 3, initial: 1 },
  { fam: 'Strix Point', cmd: 0x15, args: [25000, 7], answer: 0xfe, busy: 0, initial: 1 },
  { fam: 'Dragon Range', cmd: 0x4f, args: [], answer: 1, busy: 40, initial: 0 },
  { fam: 'Renoir', cmd: 0x16, args: [1, 2, 3, 4, 5, 6], answer: 1, busy: 100, initial: 1 }
]
const MAX_POLLS = 20

/** PresentMon CSV lines (2.x columns; a 1.x-style header case and a comma in a name) and when they arrived. */
const FPS_HEADER =
  'Application,ProcessID,SwapChainAddress,PresentRuntime,SyncInterval,PresentFlags,AllowsTearing,PresentMode,CPUStartTime,MsBetweenPresents,MsInPresentAPI'
const row = (app: string, pid: number, ms: string): string =>
  `${app},${pid},0x0000021F,DXGI,1,0,0,Hardware: Independent Flip,1.25,${ms},0.2`
const FPS_LINES: [string, number][] = [
  ['garbage before the header', 0],
  [FPS_HEADER, 10],
  [row('old.exe', 100, '50'), 100],
  ...Array.from({ length: 40 }, (_, i): [string, number] => [
    row('game.exe', 100, (16 + (i % 3)).toFixed(3)),
    700 + i * 16
  ]),
  ...Array.from({ length: 20 }, (_, i): [string, number] => [
    row('My, Launcher.exe', 200, '33.333'),
    700 + i * 33
  ]),
  [row('dwm.exe', 300, '4.0'), 1300],
  // A watched overlay's burst: a far higher rate than the game, but fewer frames (and one under FPS_MIN_FRAMES).
  ...Array.from({ length: 6 }, (_, i): [string, number] => [
    row('overlay.exe', 400, '1.0'),
    1300 + i
  ]),
  ...Array.from({ length: 3 }, (_, i): [string, number] => [
    row('helper.exe', 500, '0.5'),
    1300 + i
  ]),
  [row('game.exe', 100, 'NA'), 1350],
  [row('game.exe', 100, '-3'), 1360],
  ['game.exe,100', 1370]
]
const FPS_READS = [1400, 1800, 2600, 5000]
const FPS_PIDS = [100, 200, 400, 500]
const psString = (s: string): string => `'${s.replace(/'/g, "''")}'`

function psLiteral(n: number | null): string {
  return n === null ? '-1' : `[double]${n}`
}

/** RTSS profile edits: the C# RtssIni must give exactly what rtss/ini.ts gives. */
const INI_CASES: [string | null, string, string, string | null][] = [
  [null, 'Framerate', 'Limit', '60'],
  ['', 'Hooking', 'EnableHooking', '0'],
  ['[Hooking]\r\nUseDetours=1\r\n', 'Framerate', 'Limit', '60'],
  [
    '[OSD]\r\nEnableOSD=1\r\n[Framerate]\r\nlimit = 30\r\nLimitDenominator=1\r\n[Hooking]\r\nX=1\r\n',
    'framerate',
    'Limit',
    '90'
  ],
  ['[Framerate]\nLimitDenominator=1\n\n[Hooking]\nX=1', 'Framerate', 'Limit', '45'],
  [
    '[Framerate]\r\nLimit=60\r\n; Limit=1 comment\r\nLimit=70\r\n[Other]\r\nLimit=5\r\n',
    'Framerate',
    'Limit',
    null
  ],
  ['[Hooking]\r\nUseDetours=1\r\n', 'Framerate', 'Limit', null],
  ['[Hooking]\nEnableHooking=0', 'Hooking', 'EnableHooking', '0'],
  ['a\r\r\nb=1\n[Framerate]\r\n', 'Framerate', 'Limit', '72'],
  ['[Framerate]', 'Framerate', 'Limit', '30'],
  ['  [ Framerate ]  \r\n Limit =1\r\n\r\n\r\n', 'Framerate', 'Limit', '120'],
  ['[Framerate]\r\n=5\r\nLimitX=3\r\n# Limit=9\r\n', 'Framerate', 'Limit', '40']
]
const EXE_CASES = [
  'Game.exe',
  'JWE3.exe',
  'my game (x64).EXE',
  'Global',
  'Config',
  '..\\Global.exe',
  'a/b.exe',
  '...exe',
  ' x.exe',
  'x..y.exe',
  'x.exe\n',
  'x?.exe',
  `${'a'.repeat(201)}.exe`
]

/** A string for the script, byte for byte (Latin-1, as the helper reads profiles); null stays null. */
const psBytes = (s: string | null): string =>
  s === null
    ? '[NullString]::Value'
    : `[Text.Encoding]::GetEncoding(28591).GetString([Convert]::FromBase64String('${Buffer.from(s, 'latin1').toString('base64')}'))`

const CRLF = '"`r`n"'
/** Runs against a temporary folder as RTSS's Profiles; the real RTSS folder (and the registry) is never touched. */
const RTSS_LINES: string[] = [
  '$r.iniSet = @(' +
    INI_CASES.map(
      ([t, s, k, v]) => `[PlayOutPower.RtssIni]::Set(${psBytes(t)}, '${s}', '${k}', ${psBytes(v)})`
    ).join(', ') +
    ')',
  '$r.iniGet = @(' +
    INI_CASES.map(
      ([t, s, k]) => `([string][PlayOutPower.RtssIni]::Get(${psBytes(t)}, '${s}', '${k}') + '|')`
    ).join(', ') +
    ')',
  '$r.iniEmpty = @(' +
    INI_CASES.map(([t]) => `[PlayOutPower.RtssIni]::Empty(${psBytes(t)})`).join(', ') +
    ')',
  '$r.exes = @(' +
    EXE_CASES.map((e) => `[PlayOutPower.Rtss]::IsProfileExe(${psBytes(e)})`).join(', ') +
    ')',
  "$pd = Join-Path $env:PLAYOUT_TEST_DIR 'Profiles'",
  'New-Item -ItemType Directory -Path $pd | Out-Null',
  "$rf = Join-Path $env:PLAYOUT_TEST_DIR 'rtss-limits.json'",
  "$read = { param($n) $p = Join-Path $pd $n; if (Test-Path -LiteralPath $p) { [Text.Encoding]::GetEncoding(28591).GetString([IO.File]::ReadAllBytes($p)) } else { '<absent>' } }",
  '$put = { param($n, $t) [IO.File]::WriteAllText((Join-Path $pd $n), $t) }',
  "$step = { param($e, $f) $x = [PlayOutPower.Rtss]::Limit($pd, $rf, $e, $f); @{ created = $x['created']; fps = $x['fps']; text = (& $read ($e + '.cfg')); rec = (Test-Path -LiteralPath $rf) } }",
  // An existing profile: limited twice, then put back exactly.
  `& $put 'A.exe.cfg' ("[Hooking]" + ${CRLF} + "UseDetours=1" + ${CRLF})`,
  "$r.a = @((& $step 'A.exe' 60), (& $step 'A.exe' 90), (& $step 'A.exe' 0))",
  // No profile: created, then deleted.
  "$r.b = @((& $step 'B.exe' 45), (& $step 'B.exe' 0))",
  // Changed by someone else after PlayOut: only the Limit line goes back to its old value.
  `& $put 'C.exe.cfg' ("[Framerate]" + ${CRLF} + "Limit=30" + ${CRLF})`,
  "$c1 = & $step 'C.exe' 60",
  `& $put 'C.exe.cfg' ("[Framerate]" + ${CRLF} + "Limit=60" + ${CRLF} + "LimitDenominator=1" + ${CRLF} + "SyncDisplay=0" + ${CRLF})`,
  "$r.c = @($c1, (& $step 'C.exe' 0))",
  // Never limited by PlayOut: 0 changes nothing.
  `& $put 'D.exe.cfg' ("[Hooking]" + ${CRLF} + "X=1" + ${CRLF})`,
  "$r.d = & $step 'D.exe' 0",
  // Created by PlayOut, then another setting was added: kept, without the limit.
  "$e1 = & $step 'E.exe' 72",
  `[IO.File]::AppendAllText((Join-Path $pd 'E.exe.cfg'), "[Hooking]" + ${CRLF} + "EnableHooking=0" + ${CRLF})`,
  "$r.e = @($e1, (& $step 'E.exe' 0))",
  // A fractional limit set in RTSS (59.94 = 5994 / 100): the denominator becomes 1 with PlayOut's limit and comes back.
  `& $put 'I.exe.cfg' ("[Framerate]" + ${CRLF} + "Limit=5994" + ${CRLF} + "LimitDenominator=100" + ${CRLF})`,
  "$i1 = & $step 'I.exe' 60",
  `[IO.File]::AppendAllText((Join-Path $pd 'I.exe.cfg'), "[OSD]" + ${CRLF} + "EnableOSD=1" + ${CRLF})`,
  "$r.i = @($i1, (& $step 'I.exe' 0))",
  // Two programs: each record goes on its own.
  "$r.fg = @((& $step 'F.exe' 60), (& $step 'G.exe' 30), (& $step 'F.exe' 0), (& $step 'G.exe' 0))",
  // PlayOut's own exe: EnableHooking=0, created or set in place, once.
  "$r.self = @([PlayOutPower.Rtss]::Self($pd, $rf, 'PlayOut.exe'), (& $read 'PlayOut.exe.cfg'), [PlayOutPower.Rtss]::Self($pd, $rf, 'PlayOut.exe'))",
  `& $put 'H.exe.cfg' ("[Hooking]" + ${CRLF} + "EnableHooking=1" + ${CRLF} + "UseDetours=1" + ${CRLF})`,
  "$r.selfH = @([PlayOutPower.Rtss]::Self($pd, $rf, 'H.exe'), (& $read 'H.exe.cfg'))",
  '$r.files = @(Get-ChildItem -LiteralPath $pd | Sort-Object Name | ForEach-Object { $_.Name })',
  // Before the helper is removed: every limit and the hooking exclusions go back, and the records with them.
  `& $put 'J.exe.cfg' ("[Hooking]" + ${CRLF} + "UseDetours=1" + ${CRLF})`,
  "$null = & $step 'J.exe' 50",
  "$null = & $step 'L.exe' 40",
  '$r.restored = [PlayOutPower.Rtss]::RestoreAll($pd, $rf)',
  "$r.afterRestore = @((& $read 'J.exe.cfg'), (& $read 'L.exe.cfg'), (& $read 'PlayOut.exe.cfg'), (& $read 'H.exe.cfg'), (Test-Path -LiteralPath $rf))",
  '$r.restoredAgain = [PlayOutPower.Rtss]::RestoreAll($pd, $rf)',
  // A hard link to a file elsewhere is never written through.
  "$outside = Join-Path $env:PLAYOUT_TEST_DIR 'outside.txt'",
  "[IO.File]::WriteAllText($outside, 'keep')",
  "cmd.exe /d /c mklink /H (Join-Path $pd 'M.exe.cfg') $outside | Out-Null",
  "try { [void][PlayOutPower.Rtss]::Limit($pd, $rf, 'M.exe', 60); $r.hardLink = 'written' } catch { $r.hardLink = $_.Exception.InnerException.Message }",
  '$r.hardLinkText = [IO.File]::ReadAllText($outside)',
  "try { [void][PlayOutPower.Rtss]::Limit($pd, $rf, 'Global', 60); $r.global = 'written' } catch { $r.global = $_.Exception.InnerException.Message }",
  "try { [void][PlayOutPower.Rtss]::Limit($pd, $rf, 'x.exe', 1001); $r.tooHigh = 'written' } catch { $r.tooHigh = $_.Exception.InnerException.Message }",
  "try { [void][PlayOutPower.Rtss]::Self($pd, $rf, '..\\x.exe'); $r.selfBad = 'written' } catch { $r.selfBad = $_.Exception.InnerException.Message }",
  // The install folder: absolute, local, with RTSS.exe and Profiles.
  '$ci = { param($d) try { [PlayOutPower.Rtss]::CheckInstall($d, $false) } catch { $_.Exception.InnerException.Message } }',
  "$fake = Join-Path $env:PLAYOUT_TEST_DIR 'rt'",
  "New-Item -ItemType Directory -Path (Join-Path $fake 'Profiles') | Out-Null",
  "[IO.File]::WriteAllText((Join-Path $fake 'RTSS.exe'), '')",
  "$r.install = @((& $ci $env:PLAYOUT_TEST_DIR), (& $ci 'rt\\Profiles'), (& $ci '\\\\server\\share\\RTSS'), (& $ci ''), (& $ci ('\"' + $fake + '\"')))",
  "$r.installWant = (Join-Path $fake 'Profiles')",
  // This user made $fake: as SYSTEM the helper would write into a folder users can change, so it is refused, and so is
  // a junction to it. A Windows folder (read only: its owner) is trusted.
  "$jn = Join-Path $env:PLAYOUT_TEST_DIR 'rtj'",
  'cmd.exe /d /c mklink /J $jn $fake | Out-Null',
  '$r.installUser = @(try { [PlayOutPower.Rtss]::CheckInstall($fake) } catch { $_.Exception.InnerException.Message })',
  '$r.adminOwned = @([PlayOutPower.Rtss]::AdminOwned($fake), [PlayOutPower.Rtss]::AdminOwned($jn), [PlayOutPower.Rtss]::AdminOwned($env:SystemRoot))',
  'cmd.exe /d /c rmdir $jn',
  // Requests that fail before anything is read: bad names and limits.
  `$r.handle = @([PlayOutPower.Server]::Handle('{"op":"rtssLimit","exe":"..\\\\\\\\x.exe","fps":60}'), [PlayOutPower.Server]::Handle('{"op":"rtssLimit","exe":"x.exe","fps":60.5}'), [PlayOutPower.Server]::Handle('{"op":"rtssLimit","exe":"x.exe","fps":"60"}'), [PlayOutPower.Server]::Handle('{"op":"rtssLimit","exe":"x.exe"}'), [PlayOutPower.Server]::Handle('{"op":"rtssSelf","exe":"Global"}'), [PlayOutPower.Server]::Handle('{"op":"rtssSelf"}'))`,
  `$fpsReq = $js.DeserializeObject('{"a":[60,0,1000,1001,-1,59.5,"60",true,null]}')`,
  "$r.fpsParse = @(foreach ($v in $fpsReq['a']) { [PlayOutPower.Rtss]::ParseFps($v) })"
]

/**
 * "Free up memory" (protocol 4): only what is pure or a dry run. Nothing here trims a working set, switches a
 * privilege on or sends Windows a memory list command: every memTrim request below is refused before it starts.
 */
const PROTECTED_CASES: [string | null, boolean, boolean][] = [
  ['C:\\Windows\\explorer.exe', false, true],
  ['C:\\Windows\\explorer.exe', true, false],
  ['c:\\windows\\Explorer.EXE', true, false],
  ['C:\\Windows\\System32\\notepad.exe', true, true],
  ['C:\\Windows\\System32\\svchost.exe', true, true],
  ['C:\\WindowsApps\\app.exe', false, false],
  ['C:\\Program Files\\App\\app.exe', false, false],
  ['D:\\Tools\\explorer.exe', false, false],
  ['D:\\x\\MsMpEng.exe', false, true],
  ['D:\\Games\\EasyAntiCheat.exe', false, true],
  ['C:\\ProgramData\\x\\SenseNdr.exe', false, true],
  ['C:\\Program Files\\Sunshine\\sunshine.exe', false, true],
  ['C:\\Program Files\\App\\', false, true],
  [null, false, true]
]
const MEM_HANDLE_CASES = [
  '{"op":"memTrim"}',
  '{"op":"memTrim","pids":"all"}',
  '{"op":"memTrim","pids":[1234,"5678"]}',
  '{"op":"memTrim","pids":[1234,3]}',
  '{"op":"memTrim","pids":[1234],"shell":"yes","purgeBelowMb":0,"createdBefore":1700000000000}',
  '{"op":"memTrim","pids":[1234],"shell":false,"purgeBelowMb":-5,"createdBefore":1700000000000}',
  '{"op":"memTrim","pids":[1234],"shell":false,"purgeBelowMb":"2048","createdBefore":1700000000000}',
  // Without the time the process list was read (or with a bad one) nothing starts.
  '{"op":"memTrim","pids":[1234],"shell":false,"purgeBelowMb":0}',
  '{"op":"memTrim","pids":[1234],"shell":false,"purgeBelowMb":0,"createdBefore":"1700000000000"}',
  '{"op":"memTrim","pids":[1234],"shell":false,"purgeBelowMb":0,"createdBefore":0}',
  '{"op":"memTrim","pids":[1234],"shell":false,"purgeBelowMb":0,"createdBefore":1.5}'
]
const MEM_LINES: string[] = [
  '$r.memSizes = @([PlayOutPower.Privilege]::StateSize(), [PlayOutPower.Mem]::CombineInfoSize(), [IntPtr]::Size, [PlayOutPower.Mem]::MaxPids, [PlayOutPower.Mem]::MemoryListsSize())',
  `$memReq = $js.DeserializeObject('{"a":[1234,4321,1234],"b":[1234,4],"c":[1234,"77"],"d":"1234","e":[5.5],"f":[],"g":[true],"h":[1234,null],"i":[99999999999]}')`,
  "$r.memPids = @(foreach ($k in 'a','b','c','d','e','f','g','h','i') { $x = [PlayOutPower.Mem]::ParsePids($memReq[$k]); if ($null -eq $x) { 'refused' } else { 'ok:' + ($x -join ',') } })",
  '$r.memPidsNone = ($null -eq [PlayOutPower.Mem]::ParsePids($null))',
  '$r.memPidsCap = @(([PlayOutPower.Mem]::ParsePids([object[]](5..1028))).Length, ($null -eq [PlayOutPower.Mem]::ParsePids([object[]](5..1029))))',
  `$mbReq = $js.DeserializeObject('{"a":[0,2048,1048576,1048577,-1,1.5,"5",true,null]}')`,
  "$r.memMb = @(foreach ($v in $mbReq['a']) { [PlayOutPower.Mem]::ParseMb($v) })",
  '$r.memProtected = @(' +
    PROTECTED_CASES.map(
      ([path, shell]) =>
        `[PlayOutPower.Mem]::Protected(${path === null ? '[NullString]::Value' : psString(path)}, $${shell}, 'C:\\Windows\\')`
    ).join(', ') +
    ')',
  '$r.memNever = @(' +
    HARD_NEVER_NAMES.map(
      (n) =>
        `[PlayOutPower.Mem]::Protected(${psString(`D:\\Apps\\${n}.exe`)}, $true, 'C:\\Windows\\')`
    ).join(', ') +
    ')',
  "$r.memWindowsDir = @([PlayOutPower.Mem]::WindowsDir(), [PlayOutPower.Mem]::Protected([IO.Path]::Combine([PlayOutPower.Mem]::WindowsDir(), 'System32\\notepad.exe'), $false))",
  // { free MB, standby MB }: asked or not, unreadable, enough free, a small standby list (a 16 GB PC with 700 MB
  // available: purging would only cost the cache), and the one case it is for (little free, a large standby list).
  '$r.memStandby = @(' +
    [
      '0, [long[]]@(100, 9000)',
      '2048, $null',
      '2048, [long[]]@(-1, 9000)',
      '2048, [long[]]@(2048, 9000)',
      '1024, [long[]]@(200, 500)',
      '2048, [long[]]@(2047, 2047)'
    ]
      .map((a) => `([string][PlayOutPower.Mem]::StandbyDecision(${a}))`)
      .join(', ') +
    ', ($null -eq [PlayOutPower.Mem]::StandbyDecision(2048, [long[]]@(2047, 2048))))',
  '$r.memStatus = @([PlayOutPower.Mem]::StatusText(-1073741727), [PlayOutPower.Mem]::StatusText(-1073741821), [PlayOutPower.Mem]::StatusText(-1073741823))',
  // Read only; null where Windows does not answer this account.
  '$r.memLists = [PlayOutPower.Mem]::FreeAndStandbyMb()',
  // A dry run opens and checks, and trims nothing: this PowerShell itself and pid 4 are skipped, an odd pid cannot
  // exist, the test's own node.exe is the fourth (would be trimmed, or protected when node sits in Windows' folder).
  '$dry = [PlayOutPower.Mem]::Run([int[]]@([int]$env:PLAYOUT_TEST_PID, $PID, 4, 999999), $false, [long]::MaxValue, 2048, $true)',
  // The same, as if the process list had been read before any of these processes started (a reused process id).
  "$r.memDryOld = ([PlayOutPower.Mem]::Run([int[]]@([int]$env:PLAYOUT_TEST_PID, $PID, 4, 999999), $false, [long]1000, 2048, $true))['workingSets']",
  `$timeReq = $js.DeserializeObject('{"a":[1700000000000,1,0,-1,1.5,"5",true,null,9007199254740993]}')`,
  "$r.memTime = @(foreach ($v in $timeReq['a']) { [PlayOutPower.Mem]::ParseTime($v) })",
  // 2023-11-14T22:13:20Z as a FILETIME, the epoch itself, and nothing.
  '$r.memFileTime = @([PlayOutPower.Mem]::FileTimeToUnixMs(133444736000000000), [PlayOutPower.Mem]::FileTimeToUnixMs(116444736000000000), [PlayOutPower.Mem]::FileTimeToUnixMs(0))',
  '$r.memTooNew = @([PlayOutPower.Mem]::TooNew(999, 1000), [PlayOutPower.Mem]::TooNew(1000, 1000), [PlayOutPower.Mem]::TooNew(1001, 1000), [PlayOutPower.Mem]::TooNew(-1, 1000))',
  "$r.memDry = @{ ws = $dry['workingSets']; rest = @($dry['modifiedList']['state'], $dry['lowPriorityStandby']['state'], $dry['standby']['state'], $dry['combine']['state']); detail = $dry['combine']['detail'] }",
  // Timings: a step that ran says how long it took, a skipped one does not; the whole cleanup has its total.
  "$r.memDryTimes = @{ total = $dry['totalMs']; ws = $dry['workingSets']['ms']; skippedHaveMs = @(foreach ($n in 'modifiedList','lowPriorityStandby','standby','combine') { $dry[$n].ContainsKey('ms') }); json = $js.Serialize($dry); line = [PlayOutPower.Mem]::Summary($dry) }",
  // The helper.log line of a made-up result (nothing runs).
  `$sumReq = New-Object 'System.Collections.Generic.Dictionary[string,object]'`,
  `foreach ($kv in $js.DeserializeObject('[["workingSets",{"state":"done","trimmed":131,"ms":412}],["modifiedList",{"state":"done","ms":1830}],["lowPriorityStandby",{"state":"failed","detail":"access denied","ms":95}],["standby",{"state":"skipped","detail":"enough memory is free"}],["combine",{"state":"done","pages":7,"ms":2210}],["totalMs",4547]]')) { $sumReq[$kv[0]] = $kv[1] }`,
  '$r.memSummary = [PlayOutPower.Mem]::Summary($sumReq)',
  '$r.memDryNone = [PlayOutPower.Mem]::TrimProcesses([int[]]@(), $false, [long]::MaxValue, $true)',
  "try { [void][PlayOutPower.Mem]::TrimProcesses([int[]](5..1029), $false, [long]::MaxValue, $true); $r.memTooMany = 'ran' } catch { $r.memTooMany = $_.Exception.InnerException.Message }",
  // A privilege Windows does not know: refused before anything is adjusted.
  "$pv = New-Object PlayOutPower.Privilege('SePlayOutNoSuchPrivilege')",
  '$r.memPrivilege = @($pv.Error, $pv.Changed)',
  '$pv.Dispose()',
  // Requests refused before a cleanup starts, and the answer while none ever ran.
  '$r.memHandle = @(' +
    MEM_HANDLE_CASES.map((c) => `[PlayOutPower.Server]::Handle(${psString(c)})`).join(', ') +
    ')',
  `$r.memIdle = [PlayOutPower.Server]::Handle('{"op":"memResult"}')`,
  '$r.memExports = @(' +
    MEM_EXPORTS.map(([dll, name]) => `[ExportProbe]::Has('${dll}', '${name}')`).join(', ') +
    ')'
]

let result: Record<string, unknown> | null = null
let dir = ''

beforeAll(() => {
  if (process.platform !== 'win32') return
  dir = mkdtempSync(join(tmpdir(), 'playout-helper-cs-'))
  const lines: string[] = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -ReferencedAssemblies System.Core, System.Web.Extensions -TypeDefinition @'",
    helperCSharp(),
    FAKE_CS,
    "'@",
    '$r = @{}',
    '$r.encode = @(' +
      ENCODE_CASES.map(
        ([v, u, a, b]) =>
          `[string][PlayOutPower.Rapl]::Encode([UInt64]::Parse('${v}'), [double]${u}, ${psLiteral(a)}, ${psLiteral(b)})`
      ).join(', ') +
      ')',
    '$r.decode = @(' +
      ENCODE_CASES.map(
        ([v, u]) =>
          `@([PlayOutPower.Rapl]::Pl1([UInt64]::Parse('${v}'), [double]${u}), [PlayOutPower.Rapl]::Pl2([UInt64]::Parse('${v}'), [double]${u}), [PlayOutPower.Rapl]::Locked([UInt64]::Parse('${v}')))`
      ).join(', ') +
      ')',
    '$r.range = @(' +
      INFO_CASES.map(
        (v) => `[PlayOutPower.Rapl]::Range([UInt64]::Parse('${v}'), [double]0.125)`
      ).join(', ') +
      ')',
    '$r.units = @([PlayOutPower.Rapl]::UnitWatts([UInt64]0xA0E03), [PlayOutPower.Rapl]::EnergyJoules([UInt64]0xA0E03))',
    '$fams = @()',
    'foreach ($f in 23, 25, 26, 6) { foreach ($m in 0..200) { $x = [PlayOutPower.Smu]::For($f, $m); if ($x) { $fams += ,@($f, $m, $x.Name, $x.Msg, $x.Rsp, $x.Arg, $x.Stapm, $x.Fast, $x.Slow, $x.MaxWatts) } } }',
    '$r.families = $fams',
    '$sends = @()'
  ]
  for (const c of SEND_CASES) {
    const f = SMU_FAMILIES.find((x) => x.name === c.fam)!
    lines.push(
      `$fam = [PlayOutPower.Smu]::For(${f.family}, ${f.models[0]})`,
      `$fake = New-Object FakeRegs([uint32]${f.mailbox.rsp}, [uint32]${f.mailbox.msg}, [uint32]${c.answer}, ${c.busy}, [uint32]${c.initial})`,
      `$code = [PlayOutPower.Smu]::Send($fake, $fam, [uint32]${c.cmd}, [uint32[]]@(${c.args.join(', ')}), ${MAX_POLLS})`,
      '$sends += ,@($code, ($fake.Log -join " "))'
    )
  }
  lines.push(
    '$r.sends = $sends',
    "$r.badJson = [PlayOutPower.Server]::Handle('{nope')",
    `$r.unknown = [PlayOutPower.Server]::Handle('{"op":"format"}')`,
    "$r.sddl = [PlayOutPower.Server]::Security('S-1-5-21-1-2-3-1001').GetSecurityDescriptorSddlForm('Access')",
    // Boot stamp: this boot, compared with one minute either way.
    '$boot = [PlayOutPower.Boot]::Minute()',
    '$r.bootAge = [Math]::Round(([DateTime]::UtcNow - (New-Object DateTime(1970, 1, 1, 0, 0, 0, [DateTimeKind]::Utc))).TotalMinutes - $boot)',
    '$st = { param($b) $d = New-Object "System.Collections.Generic.Dictionary[string,object]"; if ($b -ne $null) { $d["boot"] = $b }; $d }',
    '$r.same = @([PlayOutPower.Boot]::Same((& $st $boot), $boot), [PlayOutPower.Boot]::Same((& $st ($boot + 1)), $boot), [PlayOutPower.Boot]::Same((& $st ($boot - 90)), $boot), [PlayOutPower.Boot]::Same((& $st $null), $boot), [PlayOutPower.Boot]::Same((& $st "x"), $boot))',
    // A state.json from another boot is dropped (and deleted); one from this boot is kept.
    "$sf = Join-Path $env:PLAYOUT_TEST_DIR 'state.json'",
    '[IO.File]::WriteAllText($sf, \'{"intel610":"123","boot":\' + ($boot - 600) + \'}\')',
    '$r.stale = @(($null -eq [PlayOutPower.Server]::ReadState($sf, $boot)), (Test-Path -LiteralPath $sf))',
    '[IO.File]::WriteAllText($sf, \'{"intel610":"123","boot":\' + $boot + \'}\')',
    '$kept = [PlayOutPower.Server]::ReadState($sf, $boot)',
    "$r.fresh = @([string]$kept['intel610'], (Test-Path -LiteralPath $sf))",
    '[IO.File]::WriteAllText($sf, \'{"intel610":"123"}\')',
    '$r.noBoot = ($null -eq [PlayOutPower.Server]::ReadState($sf, $boot))',
    // The saved MSR state is only trusted while the register still holds what PlayOut wrote.
    '$ours = { param($w) $d = New-Object "System.Collections.Generic.Dictionary[string,object]"; $d["intel610"] = "1"; if ($w -ne $null) { $d["intel610w"] = $w }; $d }',
    "$r.stillOurs = @([PlayOutPower.Server]::StillOurs((& $ours '18446744073709551615'), [UInt64]::MaxValue), [PlayOutPower.Server]::StillOurs((& $ours '42'), [UInt64]43), [PlayOutPower.Server]::StillOurs((& $ours $null), [UInt64]43), [PlayOutPower.Server]::StillOurs($null, [UInt64]43))",
    // AMD: no backup of the limits in force -> refuse.
    'try { [void][PlayOutPower.Server]::AmdBackup($null); $r.amdNull = "no error" } catch { $r.amdNull = $_.Exception.InnerException.Message }',
    '$bk = [PlayOutPower.Server]::AmdBackup([float[]]@(15, 9, 25, 20, 18, 12))',
    '$r.amdBackup = @($bk["amdStapm"], $bk["amdFast"], $bk["amdSlow"])',
    // user.sid: local or domain users only.
    "$r.sids = @([PlayOutPower.Server]::UserSid(\"S-1-5-21-1-2-3-1001`r`n\"), [PlayOutPower.Server]::UserSid('S-1-5-18'), [PlayOutPower.Server]::UserSid('S-1-5-21-1-2-3-1001; x'), [PlayOutPower.Server]::UserSid($null))",
    // Dynamic TDP: PresentMon's CSV, the pids of an fpsStart, the fps ops without a PresentMon running.
    '$meter = [PlayOutPower.FpsMeter]::new([int[]]@(' + FPS_PIDS.join(', ') + '))',
    ...FPS_LINES.map(([l, t]) => `$meter.Push(${psString(l)}, [double]${t})`),
    '$fr = @(); foreach ($t in ' +
      FPS_READS.join(', ') +
      ') { $fr += ,($meter.Read([double]$t)) }; $r.fpsReads = $fr',
    '$js = New-Object System.Web.Script.Serialization.JavaScriptSerializer',
    `$req = $js.DeserializeObject('{"pids":[1234,4,1234,5.5,"77",true,99999999999,42,null]}')`,
    "$r.pids = @([PlayOutPower.Fps]::ParsePids($req['pids']))",
    "$r.pidsString = @([PlayOutPower.Fps]::ParsePids('1234'))",
    '$r.fpsIdle = [PlayOutPower.Server]::Handle(\'{"op":"fps"}\')',
    '$r.fpsNoPids = [PlayOutPower.Server]::Handle(\'{"op":"fpsStart","pids":[]}\')',
    '$r.fpsStop = [PlayOutPower.Server]::Handle(\'{"op":"fpsStop"}\')',
    '$r.fpsConst = @([PlayOutPower.Fps]::Sha256, [PlayOutPower.Fps]::Arguments, [PlayOutPower.Fps]::Exe)',
    // Never runs a PresentMon that is missing or not the pinned copy.
    'try { [PlayOutPower.Fps]::Start($env:PLAYOUT_TEST_DIR, [int[]]@(1234)); $r.pmMissing = "started" } catch { $r.pmMissing = $_.Exception.InnerException.Message }',
    "[IO.File]::WriteAllText((Join-Path $env:PLAYOUT_TEST_DIR 'PresentMon.exe'), 'not presentmon')",
    'try { [PlayOutPower.Fps]::Start($env:PLAYOUT_TEST_DIR, [int[]]@(1234)); $r.pmSwapped = "started" } catch { $r.pmSwapped = $_.Exception.InnerException.Message }',
    '$r.pmRunning = [PlayOutPower.Fps]::Running()',
    ...RTSS_LINES,
    ...MEM_LINES,
    '$r | ConvertTo-Json -Depth 6 -Compress'
  )
  const file = join(dir, 'check.ps1')
  writeFileSync(file, `\ufeff${lines.join('\r\n')}`, 'utf8')
  const ps = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
    {
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true,
      env: { ...process.env, PLAYOUT_TEST_DIR: dir, PLAYOUT_TEST_PID: String(process.pid) }
    }
  )
  if (ps.status !== 0)
    throw new Error(`PowerShell failed (${ps.status}): ${ps.stderr || ps.stdout}`)
  result = JSON.parse(ps.stdout.trim()) as Record<string, unknown>
}, 120_000)

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(process.platform !== 'win32')('power helper C# (compiled with Add-Type)', () => {
  it('encodes MSR 0x610 like msr.ts', () => {
    const got = (result!.encode as string[]).map((s) => BigInt(s))
    expect(got).toEqual(ENCODE_CASES.map(([v, u, a, b]) => encodePowerLimit(v, u, a, b)))
  })

  it('decodes MSR 0x610 like msr.ts', () => {
    const got = result!.decode as [number, number, boolean][]
    expect(got).toEqual(
      ENCODE_CASES.map(([v, u]) => {
        const d = decodePowerLimit(v, u)
        return [d.pl1, d.pl2, d.locked]
      })
    )
  })

  it('computes the Intel watts range like msr.ts', () => {
    const got = result!.range as [number, number][]
    expect(got).toEqual(
      INFO_CASES.map((v) => {
        const r = intelWattsRange(decodePowerInfo(v, 0.125))
        return [r.min, r.max]
      })
    )
    expect(result!.units).toEqual([1 / 8, 1 / 2 ** 14])
  })

  it('has the same SMU family table as smu.ts', () => {
    const got = result!.families as unknown[][]
    const want: unknown[][] = []
    for (const f of [23, 25, 26, 6])
      for (let m = 0; m <= 200; m++) {
        const x = smuFamilyFor({ vendor: 'amd', family: f, model: m })
        if (x)
          want.push([
            f,
            m,
            x.name,
            x.mailbox.msg,
            x.mailbox.rsp,
            x.mailbox.arg,
            x.cmds.stapm,
            x.cmds.fast,
            x.cmds.slow,
            x.maxWatts
          ])
      }
    expect(got).toEqual(want)
  })

  it('drives the MP1 mailbox in the same order as smu.ts', () => {
    const got = result!.sends as [number, string][]
    SEND_CASES.forEach((c, i) => {
      const f = SMU_FAMILIES.find((x) => x.name === c.fam)!
      const fake = new FakeRegs(f.mailbox.rsp, f.mailbox.msg, c.answer, c.busy, c.initial)
      const code = smuSend(fake, f.mailbox, c.cmd, c.args, MAX_POLLS)
      expect(got[i][0]).toBe(code)
      expect(got[i][1]).toBe(fake.log.join(' '))
    })
    // The reference itself: success after the busy reads, unknown command passed through, timeout = 0.
    expect(got.map((g) => g[0])).toEqual([1, 0xfe, 0, 0])
  })

  it('answers bad requests with an error line', () => {
    expect(JSON.parse(result!.badJson as string)).toEqual({
      ok: false,
      error: 'Not a JSON request.'
    })
    expect(JSON.parse(result!.unknown as string)).toEqual({ ok: false, error: 'Unknown request.' })
  })

  it('opens the pipe to the installing user, SYSTEM and Administrators only, never over the network', () => {
    const sddl = result!.sddl as string
    // Network logons: denied all; SYSTEM and Administrators: all; the user (from user.sid): generic read + write
    // (0x12019f), no WRITE_DAC or delete.
    expect(sddl).toMatch(/\(D;;0x1f019f;;;NU\)/)
    expect(sddl).toMatch(/\(A;;0x1f019f;;;SY\)/)
    expect(sddl).toMatch(/\(A;;0x1f019f;;;BA\)/)
    expect(sddl).toMatch(/\(A;;0x12019f;;;S-1-5-21-1-2-3-1001\)/)
    expect(sddl).not.toMatch(/;;;(WD|AU|BU|IU)\)/)
  })

  it('reads the user the pipe is for from user.sid, local or domain users only', () => {
    expect(result!.sids).toEqual(['S-1-5-21-1-2-3-1001', null, null, null])
  })

  it('stamps the saved limits with this boot and drops a state from another boot', () => {
    // Boot minute = now minus the uptime: in the past, and the same for two readings.
    expect(result!.bootAge).toBeGreaterThanOrEqual(0)
    expect(result!.same).toEqual([true, true, false, false, false])
    // Another boot: dropped and deleted, so the next set reads the limits in force as the new "before".
    expect(result!.stale).toEqual([true, false])
    expect(result!.fresh).toEqual(['123', true])
    // A state without a boot stamp (an older helper's) is not trusted either.
    expect(result!.noBoot).toBe(true)
  })

  it('trusts the saved MSR value only while the register still holds what PlayOut wrote', () => {
    // Equal; changed by the firmware (a fast-startup boot keeps the uptime) or a tool; no record (a write in flight).
    expect(result!.stillOurs).toEqual([true, false, true, true])
  })

  it('reads PresentMon CSV like presentmon.ts FpsMeter (busiest watched pid, rolling window)', () => {
    const ts = new FpsMeter(new Set(FPS_PIDS))
    for (const [l, t] of FPS_LINES) ts.push(l, t)
    const want = FPS_READS.map((t) => {
      const x = ts.read(t)
      return x ? [x.fps, x.frameTimeMs, x.pid, x.frames] : null
    })
    const got = (result!.fpsReads as (number[] | null)[]).map((x) => (x && x.length ? x : null))
    expect(got.length).toBe(want.length)
    got.forEach((g, i) => {
      if (want[i] === null) expect(g).toBeNull()
      else g!.forEach((v, j) => expect(v).toBeCloseTo(want[i]![j]!, 6))
    })
    // The reference: the game's ~60 fps (most frames) wins over the launcher's 30, the overlay's short 1000 fps
    // burst and the unwatched dwm; gone after the window.
    expect(want[0]![2]).toBe(100)
    expect(want[2]![2]).toBe(100)
    expect(want[0]![0]).toBeGreaterThan(55)
    expect(want[3]).toBeNull()
  })

  it('takes only sane pids from fpsStart and answers the fps ops without PresentMon', () => {
    expect(result!.pids).toEqual([1234, 42])
    expect(result!.pidsString).toEqual([])
    expect(JSON.parse(result!.fpsIdle as string)).toEqual({ ok: true, running: false, fps: null })
    expect(JSON.parse(result!.fpsNoPids as string)).toEqual({
      ok: false,
      error: 'No processes to measure.'
    })
    expect(JSON.parse(result!.fpsStop as string)).toEqual({ ok: true })
    expect(result!.fpsConst).toEqual([
      PRESENTMON_DOWNLOAD.sha256,
      PRESENTMON_ARGS.join(' '),
      'PresentMon.exe'
    ])
  })

  it('never starts a PresentMon that is missing or not the pinned copy', () => {
    expect(result!.pmMissing).toBe('PresentMon is missing; reinstall the power helper.')
    expect(result!.pmSwapped).toBe(
      'PresentMon.exe is not the copy PlayOut installed; reinstall the power helper.'
    )
    expect(result!.pmRunning).toBe(false)
  })

  it('edits RTSS profiles exactly like rtss/ini.ts', () => {
    expect(result!.iniSet).toEqual(INI_CASES.map(([t, s, k, v]) => setIniValue(t, s, k, v)))
    expect(result!.iniGet).toEqual(INI_CASES.map(([t, s, k]) => `${getIniValue(t, s, k) ?? ''}|`))
    expect(result!.iniEmpty).toEqual(INI_CASES.map(([t]) => iniIsEmpty(t)))
    expect(result!.exes).toEqual(EXE_CASES.map(isProfileExe))
  })

  it('limits a program in its own profile and puts back exactly what was there', () => {
    const hooking = '[Hooking]\r\nUseDetours=1\r\n'
    expect(result!.a).toEqual([
      {
        created: false,
        fps: 60,
        text: `${hooking}[Framerate]\r\nLimit=60\r\nLimitDenominator=1\r\n`,
        rec: true
      },
      {
        created: false,
        fps: 90,
        text: `${hooking}[Framerate]\r\nLimit=90\r\nLimitDenominator=1\r\n`,
        rec: true
      },
      { created: false, fps: 0, text: hooking, rec: false }
    ])
    expect(result!.b).toEqual([
      {
        created: true,
        fps: 45,
        text: '[Framerate]\r\nLimit=45\r\nLimitDenominator=1\r\n',
        rec: true
      },
      { created: true, fps: 0, text: '<absent>', rec: false }
    ])
    // Someone else changed the file since: only the Limit and LimitDenominator lines go back.
    expect((result!.c as { text: string }[])[1]!.text).toBe(
      '[Framerate]\r\nLimit=30\r\nSyncDisplay=0\r\n'
    )
    // A fractional limit: the denominator is 1 while PlayOut's limit is on, then back to RTSS's own.
    const i = result!.i as { text: string }[]
    expect(i[0]!.text).toBe('[Framerate]\r\nLimit=60\r\nLimitDenominator=1\r\n')
    expect(i[1]!.text).toBe(
      '[Framerate]\r\nLimit=5994\r\nLimitDenominator=100\r\n[OSD]\r\nEnableOSD=1\r\n'
    )
    // Never limited by PlayOut: left alone.
    expect(result!.d).toEqual({ created: false, fps: 0, text: '[Hooking]\r\nX=1\r\n', rec: false })
    // Created by PlayOut but holding another setting now: kept, without the limit.
    expect((result!.e as { text: string }[])[1]!.text).toBe(
      '[Framerate]\r\n[Hooking]\r\nEnableHooking=0\r\n'
    )
    expect((result!.fg as { rec: boolean }[]).map((x) => x.rec)).toEqual([true, true, true, false])
  })

  it('excludes PlayOut from hooking, keeping the rest of its profile', () => {
    expect(result!.self).toEqual([true, '[Hooking]\r\nEnableHooking=0\r\n', false])
    expect(result!.selfH).toEqual([true, '[Hooking]\r\nEnableHooking=0\r\nUseDetours=1\r\n'])
  })

  it('writes only <exe>.cfg files in Profiles, never Global, and leaves no temporary file', () => {
    expect(result!.files).toEqual([
      'A.exe.cfg',
      'C.exe.cfg',
      'D.exe.cfg',
      'E.exe.cfg',
      'H.exe.cfg',
      'I.exe.cfg',
      'PlayOut.exe.cfg'
    ])
    expect(result!.global).toBe('Not a program name.')
    expect(result!.tooHigh).toBe('Not a frame rate limit.')
    expect(result!.selfBad).toBe('Not a program name.')
  })

  it('takes RTSS from an absolute local install folder with RTSS.exe and Profiles only', () => {
    const missing = 'RivaTuner Statistics Server is not installed'
    expect(result!.install).toEqual([missing, missing, missing, missing, result!.installWant])
  })

  it('refuses an RTSS folder users can change, a junction and a hard-linked profile', () => {
    expect(result!.installUser).toEqual([
      "RivaTuner's folder is not protected (any user could change it), so PlayOut does not write its profiles."
    ])
    expect(result!.adminOwned).toEqual([false, false, true])
    expect(result!.hardLink).toBe('The RivaTuner profile of M.exe is a link; it was left alone.')
    expect(result!.hardLinkText).toBe('keep')
  })

  it('puts back every limit and the hooking exclusions before the helper is removed', () => {
    // J and L limits, PlayOut.exe and H.exe exclusions.
    expect(result!.restored).toBe(4)
    expect(result!.afterRestore).toEqual([
      '[Hooking]\r\nUseDetours=1\r\n',
      '<absent>',
      '<absent>',
      '[Hooking]\r\nEnableHooking=1\r\nUseDetours=1\r\n',
      false
    ])
    expect(result!.restoredAgain).toBe(0)
  })

  it('refuses bad RTSS requests before touching anything', () => {
    const answers = (result!.handle as string[]).map((s) => JSON.parse(s))
    expect(answers).toEqual([
      { ok: false, error: 'Not a program name.' },
      { ok: false, error: 'Not a frame rate limit.' },
      { ok: false, error: 'Not a frame rate limit.' },
      { ok: false, error: 'Not a frame rate limit.' },
      { ok: false, error: 'Not a program name.' },
      { ok: false, error: 'Not a program name.' }
    ])
    expect(result!.fpsParse).toEqual([60, 0, 1000, -1, -1, -1, -1, -1, -1])
  })

  it('lays out the token privilege and memory combine structures as Windows expects', () => {
    const [state, combine, pointer, maxPids, lists] = result!.memSizes as number[]
    expect(state).toBe(16)
    expect(combine).toBe(pointer === 8 ? 24 : 12)
    expect(lists).toBe(22 * pointer!)
    expect(maxPids).toBe(MAX_TRIM_PIDS)
  })

  it('takes a memory cleanup pid list only when every entry is a whole pid above 4, at most the cap', () => {
    expect(result!.memPids).toEqual([
      'ok:1234,4321',
      'refused',
      'refused',
      'refused',
      'refused',
      'ok:',
      'refused',
      'refused',
      'refused'
    ])
    expect(result!.memPidsNone).toBe(true)
    expect(result!.memPidsCap).toEqual([MAX_TRIM_PIDS, true])
    expect(result!.memMb).toEqual([0, 2048, MAX_PURGE_BELOW_MB, -1, -1, -1, -1, -1, 0])
  })

  it('never trims Windows, security software, anti-cheat or streaming, whatever the pid list says', () => {
    expect(result!.memProtected).toEqual(PROTECTED_CASES.map(([, , want]) => want))
    expect(result!.memNever).toEqual(HARD_NEVER_NAMES.map(() => true))
    const [windowsDir, notepad] = result!.memWindowsDir as [string, boolean]
    expect(windowsDir).toMatch(/^[A-Za-z]:\\.*\\$/)
    expect(notepad).toBe(true)
  })

  it('purges the whole standby list only when asked, little memory is free and the list is large', () => {
    expect(result!.memStandby).toEqual([
      'not asked for',
      'the memory lists could not be read',
      'the memory lists could not be read',
      'enough memory is free',
      'the standby list is small',
      'the standby list is small',
      true
    ])
    expect(result!.memStatus).toEqual([
      'the privilege is not held',
      'this Windows version does not support it',
      'status 0xC0000001'
    ])
    // Free and standby memory are parts of the PC's memory, and both are available memory.
    const read = result!.memLists as [number, number] | null
    if (read !== null) {
      expect(read).toHaveLength(2)
      expect(read[0]).toBeGreaterThanOrEqual(0)
      expect(read[1]).toBeGreaterThanOrEqual(0)
      expect(read[0] + read[1]).toBeLessThanOrEqual(Math.ceil(totalmem() / 1048576))
    }
  })

  it('opens and checks the processes in a dry run and does nothing else', () => {
    const dry = result!.memDry as {
      ws: { state: string; trimmed: number; denied: number; skipped: number; gone: number }
      rest: string[]
      detail: string
    }
    expect(dry.ws.state).toBe('done')
    // The PowerShell running this and pid 4 are skipped; the odd pid does not exist; node.exe is the fourth.
    expect(dry.ws.gone).toBe(1)
    expect(dry.ws.skipped).toBeGreaterThanOrEqual(2)
    expect(dry.ws.trimmed + dry.ws.denied + dry.ws.skipped + dry.ws.gone).toBe(4)
    expect(dry.rest).toEqual(['skipped', 'skipped', 'skipped', 'skipped'])
    expect(dry.detail).toBe('dry run')
    expect(result!.memDryNone).toEqual([0, 0, 0, 0])
  })

  it('times each step that ran and the whole cleanup, in whole milliseconds', () => {
    const t = result!.memDryTimes as {
      total: number
      ws: number
      skippedHaveMs: boolean[]
      json: string
      line: string
    }
    for (const ms of [t.ws, t.total]) {
      expect(Number.isInteger(ms)).toBe(true)
      expect(ms).toBeGreaterThanOrEqual(0)
      expect(ms).toBeLessThan(60_000)
    }
    expect(t.total).toBeGreaterThanOrEqual(t.ws)
    expect(t.skippedHaveMs).toEqual([false, false, false, false])
    // As it goes over the pipe, and as PlayOut reads it.
    const parsed = parseMemSteps(JSON.parse(t.json))
    expect(parsed.totalMs).toBe(t.total)
    expect(parsed.steps.workingSets).toEqual({ state: 'done', ms: t.ws })
    expect(parsed.steps.combine).toEqual({ state: 'skipped', detail: 'dry run' })
    expect(t.line).toMatch(
      /^memory: workingSets=done \(\d+ trimmed, \d+ ms\) modifiedList=skipped \(dry run\) lowPriorityStandby=skipped \(dry run\) standby=skipped \(dry run\) combine=skipped \(dry run\) total=\d+ ms$/
    )
    expect(result!.memSummary).toBe(
      'memory: workingSets=done (131 trimmed, 412 ms) modifiedList=done (1830 ms) lowPriorityStandby=failed (access denied, 95 ms) standby=skipped (enough memory is free) combine=done (2210 ms) total=4547 ms'
    )
  })

  it('refuses a list of too many processes', () => {
    expect(result!.memTooMany).toBe('Too many processes.')
  })

  it('leaves alone every process created after the process list was read (a reused process id)', () => {
    const old = result!.memDryOld as {
      state: string
      trimmed: number
      denied: number
      skipped: number
      gone: number
    }
    expect(old.state).toBe('done')
    // node.exe, which the run above let through, is now skipped (or denied when it could not be opened).
    expect(old.trimmed).toBe(0)
    expect(old.gone).toBe(1)
    expect(old.skipped + old.denied).toBe(3)
    expect(result!.memTime).toEqual([1_700_000_000_000, 1, -1, -1, -1, -1, -1, -1, -1])
    expect(result!.memFileTime).toEqual([1_700_000_000_000, -1, -1])
    // Created before the list was read: fine. At that moment, later, or unknown: too new.
    expect(result!.memTooNew).toEqual([false, true, true, true])
  })

  it('reports a privilege Windows does not know instead of adjusting anything', () => {
    const [error, changed] = result!.memPrivilege as [string, boolean]
    expect(error).toMatch(
      /^Windows does not know the privilege SePlayOutNoSuchPrivilege \(error \d+\)$/
    )
    expect(changed).toBe(false)
  })

  it('refuses bad memory cleanup requests before anything starts', () => {
    const answers = (result!.memHandle as string[]).map((s) => JSON.parse(s))
    const notList = { ok: false, error: 'Not a list of processes.' }
    expect(answers).toEqual([
      notList,
      notList,
      notList,
      notList,
      { ok: false, error: 'Not a yes or no.' },
      { ok: false, error: 'Not a memory amount.' },
      { ok: false, error: 'Not a memory amount.' },
      { ok: false, error: 'Not a time.' },
      { ok: false, error: 'Not a time.' },
      { ok: false, error: 'Not a time.' },
      { ok: false, error: 'Not a time.' }
    ])
    // No cleanup ever ran in this process.
    expect(JSON.parse(result!.memIdle as string)).toEqual({ ok: true, id: 0, running: false })
  })

  it('binds the memory cleanup to entry points this Windows exports (looked up, never called)', () => {
    expect(result!.memExports).toEqual(MEM_EXPORTS.map(() => true))
  })

  it('refuses to set AMD limits when the limits in force could not be backed up', () => {
    expect(result!.amdNull).toBe(
      'Could not read the current power limits, so they were not changed.'
    )
    expect(result!.amdBackup).toEqual([15, 25, 18])
  })
})
