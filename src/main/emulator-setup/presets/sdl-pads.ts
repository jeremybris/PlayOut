import { encodedPowerShellArgs } from '../run'
import type { Logger, Runner } from '../types'

/**
 * Game controller detection through an emulator's own SDL2.dll (Ryujinx binds each controller by an id computed from
 * the SDL joystick GUID, so the id must come from the same SDL build and hints the emulator uses). A 64-bit
 * PowerShell compiles a small P/Invoke class against the absolute DLL path, enumerates the game controllers and prints
 * JSON; nothing is installed and no window is shown.
 */

/** One SDL game controller, in SDL's device index order. */
export interface SdlPad {
  /** The 16 raw SDL_JoystickGUID bytes as 32 lower-case hex characters (memory order). */
  guid: string
  /** SDL_GameControllerNameForIndex (may be empty). */
  name: string
}

/** The SDL hints Ryujinx 1.3.3 sets before SDL_Init (Ryujinx.SDL2.Common/SDL2Driver.cs); they decide the GUID. */
export const RYUJINX_SDL_HINTS: [string, string][] = [
  ['SDL_JOYSTICK_HIDAPI_PS4_RUMBLE', '1'],
  ['SDL_JOYSTICK_HIDAPI_PS5_RUMBLE', '1'],
  ['SDL_JOYSTICK_ALLOW_BACKGROUND_EVENTS', '1'],
  ['SDL_JOYSTICK_HIDAPI_SWITCH_HOME_LED', '0'],
  ['SDL_JOYSTICK_HIDAPI_JOY_CONS', '1'],
  ['SDL_JOYSTICK_HIDAPI_COMBINE_JOY_CONS', '0']
]

/** PowerShell single-quoted string literal. */
const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`

/** C# verbatim string literal. */
const csVerbatim = (s: string): string => `@"${s.replace(/"/g, '""')}"`

/**
 * The PowerShell script that loads `dllPath` (an absolute SDL2.dll path), applies `hints`, initialises SDL's
 * events + game controller + joystick subsystems, pumps events for about 500 ms (RawInput/WGI/HIDAPI devices arrive
 * asynchronously), lists the game controllers and prints `{"pads":[{"guid":"<32 hex>","name":"..."}]}` as UTF-8.
 * Exits 1 with the message on stderr when the DLL cannot be loaded or SDL_Init fails.
 */
export function sdlPadsScript(dllPath: string, hints: [string, string][]): string {
  const dll = csVerbatim(dllPath)
  const imp = `[DllImport(${dll}, CallingConvention = CallingConvention.Cdecl)]`
  const hintCalls = hints
    .map(([k, v]) => `[PlayOutSdlPads]::SDL_SetHint(${psQuote(k)}, ${psQuote(v)}) | Out-Null`)
    .join('\n')
  // The C# source goes in a single-quoted here-string, so PowerShell expands nothing inside it.
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'try {',
    "Add-Type -TypeDefinition @'",
    'using System;',
    'using System.Collections.Generic;',
    'using System.Runtime.InteropServices;',
    'using System.Text;',
    'public static class PlayOutSdlPads {',
    `  ${imp} public static extern int SDL_SetHint([MarshalAs(UnmanagedType.LPStr)] string name, [MarshalAs(UnmanagedType.LPStr)] string value);`,
    `  ${imp} public static extern int SDL_Init(uint flags);`,
    `  ${imp} public static extern void SDL_Quit();`,
    `  ${imp} public static extern void SDL_PumpEvents();`,
    `  ${imp} public static extern int SDL_NumJoysticks();`,
    `  ${imp} public static extern int SDL_IsGameController(int index);`,
    `  ${imp} public static extern Guid SDL_JoystickGetDeviceGUID(int index);`,
    `  ${imp} public static extern IntPtr SDL_GameControllerNameForIndex(int index);`,
    `  ${imp} public static extern IntPtr SDL_GetError();`,
    '  public static string Utf8(IntPtr p) {',
    '    if (p == IntPtr.Zero) return "";',
    '    var bytes = new List<byte>();',
    '    for (int i = 0; ; i++) { byte b = Marshal.ReadByte(p, i); if (b == 0) break; bytes.Add(b); }',
    '    return Encoding.UTF8.GetString(bytes.ToArray());',
    '  }',
    '  public static void Pump() {',
    '    for (int i = 0; i < 10; i++) { SDL_PumpEvents(); System.Threading.Thread.Sleep(50); }',
    '    SDL_PumpEvents();',
    '  }',
    '  public static string Hex(Guid g) {',
    '    return BitConverter.ToString(g.ToByteArray()).Replace("-", "").ToLowerInvariant();',
    '  }',
    '}',
    "'@",
    hintCalls,
    // SDL_INIT_EVENTS | SDL_INIT_GAMECONTROLLER | SDL_INIT_JOYSTICK
    'if ([PlayOutSdlPads]::SDL_Init(0x6200) -ne 0) { throw ("SDL_Init failed: " + [PlayOutSdlPads]::Utf8([PlayOutSdlPads]::SDL_GetError())) }',
    'try {',
    '  [PlayOutSdlPads]::Pump()',
    '  $pads = @()',
    '  $count = [PlayOutSdlPads]::SDL_NumJoysticks()',
    '  for ($i = 0; $i -lt $count; $i++) {',
    '    if ([PlayOutSdlPads]::SDL_IsGameController($i) -eq 0) { continue }',
    '    $guid = [PlayOutSdlPads]::Hex([PlayOutSdlPads]::SDL_JoystickGetDeviceGUID($i))',
    '    $name = [PlayOutSdlPads]::Utf8([PlayOutSdlPads]::SDL_GameControllerNameForIndex($i))',
    '    $pads += New-Object PSObject -Property @{ guid = $guid; name = $name }',
    '  }',
    '  ConvertTo-Json -InputObject @{ pads = @($pads) } -Compress -Depth 3',
    '} finally {',
    '  [PlayOutSdlPads]::SDL_Quit()',
    '}',
    '} catch {',
    '  [Console]::Error.WriteLine($_.Exception.Message)',
    '  exit 1',
    '}'
  ].join('\n')
}

/** Parse the script's output; null when it is not the expected JSON. */
export function parseSdlPads(stdout: string): SdlPad[] | null {
  const start = stdout.indexOf('{')
  if (start < 0) return null
  let data: unknown
  try {
    data = JSON.parse(stdout.slice(start).trim())
  } catch {
    return null
  }
  const pads = (data as { pads?: unknown }).pads
  if (!Array.isArray(pads)) return null
  const out: SdlPad[] = []
  for (const p of pads) {
    const guid = typeof p?.guid === 'string' ? p.guid.toLowerCase() : ''
    if (!/^[0-9a-f]{32}$/.test(guid)) continue
    out.push({ guid, name: typeof p.name === 'string' ? p.name : '' })
  }
  return out
}

/**
 * List the game controllers SDL sees through `dllPath` with the given hints. Null when PowerShell, the DLL or SDL
 * failed (logged); an empty array when it worked and no controller is connected.
 */
export async function detectSdlPads(
  run: Runner,
  log: Logger,
  dllPath: string,
  hints: [string, string][]
): Promise<SdlPad[] | null> {
  const result = await run('powershell.exe', encodedPowerShellArgs(sdlPadsScript(dllPath, hints)), {
    timeoutMs: 60_000
  })
  if (result.code !== 0) {
    log.warn(`SDL controller detection failed (${result.code}): ${result.stderr.trim()}`)
    return null
  }
  const pads = parseSdlPads(result.stdout)
  if (!pads)
    log.warn(`SDL controller detection printed unexpected output: ${result.stdout.slice(0, 200)}`)
  return pads
}
