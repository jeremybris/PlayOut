import type { PsRunner } from './ps-worker'

export interface VolumeState {
  /** 0-100 */
  level: number
  muted: boolean
}

/**
 * CoreAudio endpoint volume through COM interop (docs/research/electron-stack.md section 6.4). Compiling the type
 * costs ~150-250 ms once per PowerShell process, so this runs in the persistent worker's init script; each
 * get/set then costs a few milliseconds. The default render endpoint is re-queried on every call so switching
 * output devices needs no restart.
 */
export const AUDIO_TYPE_INIT = `
if (-not ('PlayOut.Audio' -as [type])) {
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
namespace PlayOut {
  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr pNotify); int UnregisterControlChangeNotify(IntPtr pNotify);
    int GetChannelCount(out uint pnChannelCount);
    int SetMasterVolumeLevel(float fLevelDB, ref Guid pguidEventContext);
    int SetMasterVolumeLevelScalar(float fLevel, ref Guid pguidEventContext);
    int GetMasterVolumeLevel(out float pfLevelDB);
    int GetMasterVolumeLevelScalar(out float pfLevel);
    int SetChannelVolumeLevel(uint nChannel, float fLevelDB, ref Guid pguidEventContext);
    int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, ref Guid pguidEventContext);
    int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
    int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, ref Guid pguidEventContext);
    int GetMute([MarshalAs(UnmanagedType.Bool)] out bool pbMute);
    int GetVolumeStepInfo(out uint pnStep, out uint pnStepCount);
    int VolumeStepUp(ref Guid pguidEventContext); int VolumeStepDown(ref Guid pguidEventContext);
    int QueryHardwareSupport(out uint pdwHardwareSupportMask);
    int GetVolumeRange(out float pflVolumeMindB, out float pflVolumeMaxdB, out float pflVolumeIncrementdB);
  }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDevice {
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
    int OpenPropertyStore(int stgmAccess, out IntPtr ppProperties);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId); int GetState(out int pdwState);
  }
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int dwStateMask, out IntPtr ppDevices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppEndpoint);
    int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string pwstrId, out IMMDevice ppDevice);
    int RegisterEndpointNotificationCallback(IntPtr pClient); int UnregisterEndpointNotificationCallback(IntPtr pClient);
  }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] public class MMDeviceEnumerator { }
  public static class Audio {
    static IAudioEndpointVolume Vol() {
      var en = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
      IMMDevice dev; en.GetDefaultAudioEndpoint(0 /*eRender*/, 1 /*eMultimedia*/, out dev);
      var iid = typeof(IAudioEndpointVolume).GUID; object o; dev.Activate(ref iid, 23 /*CLSCTX_ALL*/, IntPtr.Zero, out o);
      return (IAudioEndpointVolume)o;
    }
    public static float GetVolume() { float v; Vol().GetMasterVolumeLevelScalar(out v); return v; }
    public static bool GetMute() { bool m; Vol().GetMute(out m); return m; }
    public static void SetVolume(float v) { var g = Guid.Empty; Vol().SetMasterVolumeLevelScalar(v, ref g); }
    public static void SetMute(bool m) { var g = Guid.Empty; Vol().SetMute(m, ref g); }
  }
}
'@
}
`

const READ_SCRIPT = `
@{ level = [math]::Round([PlayOut.Audio]::GetVolume() * 100); muted = [bool][PlayOut.Audio]::GetMute() }
`

interface RawVolume {
  level?: unknown
  muted?: unknown
}

export function parseVolume(raw: unknown): VolumeState | null {
  if (!raw || typeof raw !== 'object') return null
  const { level, muted } = raw as RawVolume
  if (typeof level !== 'number' || !Number.isFinite(level)) return null
  return { level: clampPercent(level), muted: muted === true }
}

/** Current master volume of the default output device; null when there is no audio endpoint. */
export async function readVolume(ps: PsRunner, timeoutMs = 5_000): Promise<VolumeState | null> {
  return parseVolume(await ps.run(READ_SCRIPT, { timeoutMs }))
}

export async function setVolume(ps: PsRunner, level: number, timeoutMs = 5_000): Promise<void> {
  const percent = clampPercent(level)
  // Numbers only ever reach the script (never strings from the renderer), so no quoting is needed.
  await ps.run(`[PlayOut.Audio]::SetVolume([float]${(percent / 100).toFixed(4)})`, { timeoutMs })
}

export async function setMuted(ps: PsRunner, muted: boolean, timeoutMs = 5_000): Promise<void> {
  await ps.run(`[PlayOut.Audio]::SetMute(${muted ? '$true' : '$false'})`, { timeoutMs })
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, Math.round(value)))
}
