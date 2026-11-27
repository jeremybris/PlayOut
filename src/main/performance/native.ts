import type { PsRunner } from '../system/ps-worker'
import { asusCaps, ATK_METHOD, ATK_IOCTL, ATK_DEVID, type AsusCaps, type AsusProbe } from './asus'
import {
  normalizeGuid,
  PERFBOOSTMODE,
  PROCTHROTTLEMAX,
  SUB_PROCESSOR,
  validCpuValues
} from './powercfg'
import type { CpuPowerValues } from './powercfg'
import { parseCpuIdentifier, type CpuId } from './smu'
import { tMain } from '../i18n'

/**
 * The user-level native calls of the Power section, in a PowerShell worker (createPsWorker) with one small C# class:
 * ATKACPI DSTS / DEVS (ASUS firmware, no admin), PowerReadAC/DCValueIndex (the processor settings of the active
 * plan, hidden ones included, whatever the Windows language), the Windows power mode overlays for AC and for DC (raw
 * GUIDs from HKLM\...\Power\User\PowerSchemes, readable without admin) and PowerSetUserConfiguredAC/DCPowerMode
 * (powrprof, Windows 11 22H2+; their presence is checked with GetProcAddress first). Windows PowerShell 5.1 compiles
 * C# 5 only.
 */

const hex = (n: number): string => `0x${n.toString(16).toUpperCase().padStart(8, '0')}`

/** Added to the worker's init (once per powershell.exe). */
export const PERF_NATIVE_INIT = String.raw`
if (-not ('PlayOut.PerfNative' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32;
namespace PlayOut {
  public static class PerfNative {
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr sa, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DeviceIoControl(IntPtr h, uint code, byte[] inBuf, int inLen, byte[] outBuf, int outLen, out int returned, IntPtr overlapped);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr h);
    [DllImport("powrprof.dll")]
    static extern uint PowerGetActiveScheme(IntPtr root, out IntPtr scheme);
    [DllImport("powrprof.dll")]
    static extern uint PowerReadACValueIndex(IntPtr root, ref Guid scheme, ref Guid sub, ref Guid setting, out uint value);
    [DllImport("powrprof.dll")]
    static extern uint PowerReadDCValueIndex(IntPtr root, ref Guid scheme, ref Guid sub, ref Guid setting, out uint value);
    [DllImport("kernel32.dll")]
    static extern IntPtr LocalFree(IntPtr p);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr LoadLibraryW(string path);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, BestFitMapping = false)]
    static extern IntPtr GetProcAddress(IntPtr module, string name);
    // Bound on first call only: never called unless OverlayApi() found both exports.
    [DllImport("powrprof.dll")]
    static extern uint PowerSetUserConfiguredACPowerMode(ref Guid mode);
    [DllImport("powrprof.dll")]
    static extern uint PowerSetUserConfiguredDCPowerMode(ref Guid mode);
    [StructLayout(LayoutKind.Sequential)]
    struct PowerStatus { public byte AcLine, BatteryFlag, BatteryPercent, SystemStatus; public int LifeTime, FullLifeTime; }
    [DllImport("kernel32.dll")]
    static extern bool GetSystemPowerStatus(out PowerStatus status);

    // -2: no ATKACPI device (not an ASUS PC); -1: the firmware refused the call; else the raw 32-bit answer.
    static long Atk(uint method, uint devid, uint value) {
      IntPtr h = CreateFile(@"\\.\ATKACPI", 0xC0000000, 3, IntPtr.Zero, 3, 0x80, IntPtr.Zero);
      if (h == new IntPtr(-1)) return -2;
      try {
        byte[] inb = new byte[16];
        BitConverter.GetBytes(method).CopyTo(inb, 0);
        BitConverter.GetBytes(8u).CopyTo(inb, 4);
        BitConverter.GetBytes(devid).CopyTo(inb, 8);
        BitConverter.GetBytes(value).CopyTo(inb, 12);
        byte[] outb = new byte[16];
        int ret;
        if (!DeviceIoControl(h, ${hex(ATK_IOCTL)}, inb, 16, outb, 16, out ret, IntPtr.Zero)) return -1;
        return BitConverter.ToUInt32(outb, 0);
      } finally {
        CloseHandle(h);
      }
    }

    public static long AtkGet(uint devid) { return Atk(${hex(ATK_METHOD.DSTS)}, devid, 0); }
    public static long AtkSet(uint devid, uint value) { return Atk(${hex(ATK_METHOD.DEVS)}, devid, value); }

    // The active plan's GUID, or null.
    public static string ActiveScheme() {
      IntPtr p;
      if (PowerGetActiveScheme(IntPtr.Zero, out p) != 0) return null;
      Guid scheme = (Guid)Marshal.PtrToStructure(p, typeof(Guid));
      LocalFree(p);
      return scheme.ToString("D");
    }

    // [ac, dc] of a processor setting in the given plan, or null.
    public static long[] ReadProcessor(string schemeId, string setting) {
      if (String.IsNullOrEmpty(schemeId)) return null;
      Guid scheme = new Guid(schemeId);
      Guid sub = new Guid("${SUB_PROCESSOR}");
      Guid s = new Guid(setting);
      uint ac, dc;
      if (PowerReadACValueIndex(IntPtr.Zero, ref scheme, ref sub, ref s, out ac) != 0) return null;
      if (PowerReadDCValueIndex(IntPtr.Zero, ref scheme, ref sub, ref s, out dc) != 0) return null;
      return new long[] { ac, dc };
    }

    // [ac, dc] power mode overlays as Windows stores them ("" when a value is missing); null without the key.
    public static string[] Overlays() {
      using (RegistryKey k = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes")) {
        if (k == null) return null;
        return new string[] {
          Convert.ToString(k.GetValue("ActiveOverlayAcPowerScheme", "")),
          Convert.ToString(k.GetValue("ActiveOverlayDcPowerScheme", ""))
        };
      }
    }

    // True when powrprof exports PowerSetUserConfiguredAC/DCPowerMode (Windows 11 22H2+). Read-only.
    public static bool OverlayApi() {
      IntPtr h = LoadLibraryW(System.IO.Path.Combine(Environment.SystemDirectory, "powrprof.dll"));
      if (h == IntPtr.Zero) return false;
      return GetProcAddress(h, "PowerSetUserConfiguredACPowerMode") != IntPtr.Zero
        && GetProcAddress(h, "PowerSetUserConfiguredDCPowerMode") != IntPtr.Zero;
    }

    public static bool OnBattery() {
      PowerStatus s;
      return GetSystemPowerStatus(out s) && s.AcLine == 0;
    }

    // 0 when Windows took the overlay, else its error code. Only after OverlayApi() returned true.
    public static long SetOverlay(bool dc, string mode) {
      Guid g = new Guid(mode);
      return dc ? PowerSetUserConfiguredDCPowerMode(ref g) : PowerSetUserConfiguredACPowerMode(ref g);
    }
  }
}
'@
}
`

/** One read of everything the Power section needs from Windows and the ASUS firmware. */
export const PERF_READ_SCRIPT = `
$atk = @(
  [PlayOut.PerfNative]::AtkGet(${hex(ATK_DEVID.VIVO_MODE)}),
  [PlayOut.PerfNative]::AtkGet(${hex(ATK_DEVID.ROG_MODE)}),
  [PlayOut.PerfNative]::AtkGet(${hex(ATK_DEVID.PL1)}),
  [PlayOut.PerfNative]::AtkGet(${hex(ATK_DEVID.PL2)})
)
$scheme = [PlayOut.PerfNative]::ActiveScheme()
@{
  atk = $atk
  scheme = $scheme
  max = [PlayOut.PerfNative]::ReadProcessor($scheme, '${PROCTHROTTLEMAX}')
  boost = [PlayOut.PerfNative]::ReadProcessor($scheme, '${PERFBOOSTMODE}')
  overlay = [PlayOut.PerfNative]::Overlays()
}
`

export const OVERLAY_API_SCRIPT = `
@{ api = [PlayOut.PerfNative]::OverlayApi(); onBattery = [PlayOut.PerfNative]::OnBattery() }
`

export const CPU_SCRIPT = `
Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1 Name, Caption, Manufacturer
`

/** The power mode overlay GUIDs for AC and DC; a side is null when Windows has no (valid) value for it. */
export interface OverlayValues {
  ac: string | null
  dc: string | null
}

export interface NativeRead {
  /** null on a PC without \\.\ATKACPI. */
  asus: AsusProbe | null
  /** The active power plan's GUID when read; null when it could not be read. */
  scheme: string | null
  /** The processor values of `scheme`; null when they could not be read. */
  cpu: CpuPowerValues | null
  /** null when the overlays could not be read. */
  overlay: OverlayValues | null
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : -1
}

function pair(v: unknown): [number, number] | null {
  return Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number')
    ? [v[0] as number, v[1] as number]
    : null
}

export function parseOverlays(v: unknown): OverlayValues | null {
  if (!Array.isArray(v) || v.length !== 2) return null
  return { ac: normalizeGuid(v[0]), dc: normalizeGuid(v[1]) }
}

export function parseNativeRead(raw: unknown): NativeRead {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const atk = Array.isArray(o.atk) ? o.atk.map(num) : []
  const asus: AsusProbe | null =
    atk.length === 4 && atk[0] !== -2
      ? { vivo: atk[0], rog: atk[1], pl1: atk[2], pl2: atk[3] }
      : null
  const scheme = normalizeGuid(o.scheme)
  const max = pair(o.max)
  const boost = pair(o.boost)
  const cpu =
    scheme && max && boost
      ? { maxAc: max[0], maxDc: max[1], boostAc: boost[0], boostDc: boost[1] }
      : null
  return {
    asus,
    scheme,
    cpu: cpu && validCpuValues(cpu) ? cpu : null,
    overlay: parseOverlays(o.overlay)
  }
}

export interface CpuInfo {
  name: string
  id: CpuId | null
}

export function parseCpu(raw: unknown): CpuInfo | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const name = typeof o.Name === 'string' ? o.Name.trim().replace(/\s+/g, ' ') : ''
  const id = parseCpuIdentifier(typeof o.Caption === 'string' ? o.Caption : '')
  if (id && id.vendor === 'other' && typeof o.Manufacturer === 'string') {
    if (/intel/i.test(o.Manufacturer)) id.vendor = 'intel'
    else if (/amd/i.test(o.Manufacturer)) id.vendor = 'amd'
  }
  return { name: name || 'Unknown CPU', id }
}

/** How this Windows sets the power mode overlay. */
export interface OverlayApi {
  /** PowerSetUserConfiguredAC/DCPowerMode exist: each source can be set on its own. */
  api: boolean
  /** Running on battery now (which overlay `powercfg /overlaysetactive` changes without the API). */
  onBattery: boolean
}

/** What the rest of the module calls (fakes in tests). */
export interface PerfNative {
  read(): Promise<NativeRead>
  cpu(): Promise<CpuInfo | null>
  /** DEVS: resolves with the firmware's answer (1 = done); throws when the call itself failed. */
  atkSet(devid: number, value: number): Promise<number>
  /** The active plan's GUID; null when it could not be read. */
  activeScheme(): Promise<string | null>
  overlayApi(): Promise<OverlayApi>
  /** PowerSetUserConfiguredAC/DCPowerMode; only when overlayApi() said `api`. Throws Windows' error. */
  setOverlay(source: 'ac' | 'dc', guid: string): Promise<void>
}

export function asusCapsOf(read: NativeRead): AsusCaps {
  return asusCaps(read.asus)
}

/** `ps` must have PERF_NATIVE_INIT in its init. */
export function createPerfNative(ps: PsRunner): PerfNative {
  return {
    async read() {
      return parseNativeRead(await ps.run(PERF_READ_SCRIPT, { timeoutMs: 15_000 }))
    },
    async cpu() {
      return parseCpu(await ps.run(CPU_SCRIPT, { timeoutMs: 15_000 }))
    },
    async atkSet(devid, value) {
      if (!Number.isInteger(devid) || !Number.isInteger(value) || value < 0 || value > 0xffff)
        throw new Error('Invalid ASUS firmware value')
      const r = await ps.run<number>(`[PlayOut.PerfNative]::AtkSet(${hex(devid)}, ${value})`, {
        timeoutMs: 10_000
      })
      if (typeof r !== 'number' || r < 0)
        throw new Error(tMain('mainPerformance.asus.deviceRefused', { device: hex(devid) }))
      return r
    },
    async activeScheme() {
      return normalizeGuid(
        await ps.run<string>('[PlayOut.PerfNative]::ActiveScheme()', { timeoutMs: 10_000 })
      )
    },
    async overlayApi() {
      const r = await ps.run<{ api?: unknown; onBattery?: unknown }>(OVERLAY_API_SCRIPT, {
        timeoutMs: 10_000
      })
      return { api: r?.api === true, onBattery: r?.onBattery === true }
    },
    async setOverlay(source, guid) {
      const g = normalizeGuid(guid)
      if (!g) throw new Error('Invalid power mode')
      const r = await ps.run<number>(
        `[PlayOut.PerfNative]::SetOverlay($${source === 'dc' ? 'true' : 'false'}, '${g}')`,
        { timeoutMs: 10_000 }
      )
      if (r !== 0)
        throw new Error(
          tMain(
            source === 'dc'
              ? 'mainPerformance.mode.refusedBattery'
              : 'mainPerformance.mode.refusedPluggedIn',
            { error: typeof r === 'number' ? r : '?' }
          )
        )
    }
  }
}
