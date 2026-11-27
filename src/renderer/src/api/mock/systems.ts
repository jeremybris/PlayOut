// Emulated systems and emulators for the mock: a subset of ES-DE's Windows es_systems.xml / es_find_rules.xml
// (docs/research/esde-systems.json, esde-find-rules.json) shaped exactly like the real emulation service's output.
import type { EmulatorStatus, Platform, SystemDefinition, SystemInfo } from '@shared/types'
import { findEmulatorCommand } from '@shared/emulators'
import { SYSTEM_SORT_BASE } from '@shared/platforms'

/** Where PlayOut's find rules expand %ESPATH% (the app folder) and ~ (the user profile) on this fake machine. */
const APP_DIR = 'C:\\Users\\Player\\AppData\\Local\\Programs\\PlayOut'
const USER_DATA_DIR = 'C:\\Users\\Player\\AppData\\Roaming\\PlayOut'
const HOME = 'C:\\Users\\Player'

const RA = '%EMULATOR_RETROARCH% -L %CORE_RETROARCH%'

interface MockSystem extends SystemDefinition {
  /** Position of the system in resources/systems/systems.json; sortOrder = SYSTEM_SORT_BASE + position. */
  position: number
  /** simple-icons slug of the manufacturer, or a lucide icon name when there is no brand glyph. */
  icon: string
}

export const MOCK_SYSTEMS: MockSystem[] = [
  {
    id: 'snes',
    name: 'Nintendo SNES (Super Nintendo)',
    aliases: ['sfc', 'superfamicom'],
    extensions: ['.bin', '.bml', '.bs', '.bsx', '.fig', '.sfc', '.smc', '.swc', '.7z', '.zip'],
    platformKey: 'snes',
    manufacturer: 'Nintendo',
    releaseYear: 1992,
    position: 149,
    icon: 'nintendo',
    emulators: [
      {
        id: 'retroarch-snes9x',
        label: 'Snes9x - Current',
        command: `${RA}\\snes9x_libretro.dll %ROM%`
      },
      { id: 'retroarch-bsnes', label: 'bsnes', command: `${RA}\\bsnes_libretro.dll %ROM%` },
      { id: 'snes9x', label: 'Snes9x (Standalone)', command: '%EMULATOR_SNES9X% %ROM%' }
    ]
  },
  {
    id: 'psx',
    name: 'Sony PlayStation',
    aliases: ['ps1', 'playstation'],
    extensions: [
      '.bin',
      '.chd',
      '.cue',
      '.ecm',
      '.img',
      '.iso',
      '.m3u',
      '.mdf',
      '.pbp',
      '.7z',
      '.zip'
    ],
    platformKey: 'psx',
    manufacturer: 'Sony',
    releaseYear: 1994,
    position: 133,
    icon: 'playstation',
    emulators: [
      {
        id: 'duckstation',
        label: 'DuckStation (Standalone)',
        command: '%EMULATOR_DUCKSTATION% -batch -fullscreen %ROM%',
        noArchives: true
      },
      {
        id: 'retroarch-swanstation',
        label: 'SwanStation',
        command: `${RA}\\swanstation_libretro.dll %ROM%`
      },
      {
        id: 'retroarch-beetle-psx-hw',
        label: 'Beetle PSX HW',
        command: `${RA}\\mednafen_psx_hw_libretro.dll %ROM%`
      }
    ]
  },
  {
    id: 'n64',
    name: 'Nintendo 64',
    aliases: ['nintendo64'],
    extensions: ['.bin', '.d64', '.n64', '.ndd', '.u1', '.v64', '.z64', '.7z', '.zip'],
    platformKey: 'n64',
    manufacturer: 'Nintendo',
    releaseYear: 1996,
    position: 100,
    icon: 'nintendo',
    emulators: [
      {
        id: 'retroarch-mupen64plus-next',
        label: 'Mupen64Plus-Next',
        command: `${RA}\\mupen64plus_next_libretro.dll %ROM%`
      },
      {
        id: 'retroarch-parallel-n64',
        label: 'ParaLLEl N64',
        command: `${RA}\\parallel_n64_libretro.dll %ROM%`
      }
    ]
  },
  {
    id: 'gba',
    name: 'Nintendo Game Boy Advance',
    aliases: ['gameboyadvance'],
    extensions: ['.agb', '.bin', '.cgb', '.gb', '.gba', '.gbc', '.sgb', '.7z', '.zip'],
    platformKey: 'gba',
    manufacturer: 'Nintendo',
    releaseYear: 2001,
    position: 65,
    icon: 'nintendo',
    emulators: [
      { id: 'mgba', label: 'mGBA (Standalone)', command: '%EMULATOR_MGBA% -f %ROM%' },
      { id: 'retroarch-mgba', label: 'mGBA', command: `${RA}\\mgba_libretro.dll %ROM%` }
    ]
  },
  {
    id: 'switch',
    name: 'Nintendo Switch',
    aliases: ['nsw'],
    extensions: ['.nca', '.nro', '.nso', '.nsp', '.xci'],
    platformKey: 'switch',
    manufacturer: 'Nintendo',
    releaseYear: 2017,
    position: 159,
    icon: 'nintendo',
    emulators: [
      { id: 'ryujinx', label: 'Ryujinx (Standalone)', command: '%EMULATOR_RYUJINX% %ROM%' },
      { id: 'eden', label: 'Eden (Standalone)', command: '%EMULATOR_EDEN% -f -g %ROM%' }
    ]
  },
  {
    // The mock's Burnout Revenge (an ISO): its Play menu's Convert lists the Xbox 360 conversions.
    id: 'xbox360',
    name: 'Microsoft Xbox 360',
    aliases: ['x360'],
    extensions: ['.', '.iso', '.lnk', '.xex', '.zar'],
    platformKey: 'xbox360',
    manufacturer: 'Microsoft',
    releaseYear: 2005,
    position: 200,
    icon: 'microsoft',
    emulators: [{ id: 'xenia', label: 'Xenia (Standalone)', command: '%EMULATOR_XENIA% %ROM%' }]
  },
  {
    id: 'dreamcast',
    name: 'Sega Dreamcast',
    aliases: ['dc'],
    extensions: ['.cdi', '.chd', '.cue', '.gdi', '.iso', '.m3u', '.7z', '.zip'],
    platformKey: 'dreamcast',
    manufacturer: 'Sega',
    releaseYear: 1998,
    position: 47,
    icon: 'sega',
    emulators: [
      { id: 'retroarch-flycast', label: 'Flycast', command: `${RA}\\flycast_libretro.dll %ROM%` },
      { id: 'flycast', label: 'Flycast (Standalone)', command: '%EMULATOR_FLYCAST% %ROM%' },
      { id: 'redream', label: 'Redream (Standalone)', command: '%EMULATOR_REDREAM% %ROM%' }
    ]
  },
  {
    id: 'genesis',
    name: 'Sega Genesis',
    aliases: ['megadrive', 'md'],
    extensions: [
      '.32x',
      '.bin',
      '.chd',
      '.cue',
      '.gen',
      '.iso',
      '.md',
      '.sg',
      '.smd',
      '.7z',
      '.zip'
    ],
    platformKey: 'genesis',
    manufacturer: 'Sega',
    releaseYear: 1989,
    position: 68,
    icon: 'sega',
    emulators: [
      {
        id: 'retroarch-genesis-plus-gx',
        label: 'Genesis Plus GX',
        command: `${RA}\\genesis_plus_gx_libretro.dll %ROM%`
      },
      { id: 'retroarch-blastem', label: 'BlastEm', command: `${RA}\\blastem_libretro.dll %ROM%` }
    ]
  },
  {
    id: 'arcade',
    name: 'Arcade',
    aliases: ['mame', 'fba', 'fbneo'],
    extensions: ['.7z', '.zip'],
    platformKey: 'arcade',
    position: 13,
    icon: 'gamepad-2',
    emulators: [
      { id: 'retroarch-mame', label: 'MAME - Current', command: `${RA}\\mame_libretro.dll %ROM%` },
      { id: 'retroarch-fbneo', label: 'FinalBurn Neo', command: `${RA}\\fbneo_libretro.dll %ROM%` },
      { id: 'mame', label: 'MAME (Standalone)', command: '%EMULATOR_MAME% %BASENAME%' }
    ]
  }
]

interface MockEmulator {
  id: string
  name: string
  /** Where the find rules locate it on this fake machine; null = not installed. */
  rulePath: string | null
  searchedPaths: string[]
  coresDir?: string
  downloadUrl: string
}

const emulatorsDir = (relative: string): string[] => [
  `${APP_DIR}\\Emulators\\${relative}`,
  `${USER_DATA_DIR}\\Emulators\\${relative}`
]

const MOCK_EMULATORS: MockEmulator[] = [
  {
    id: 'RETROARCH',
    name: 'RetroArch',
    rulePath: 'C:\\RetroArch-Win64\\retroarch.exe',
    coresDir: 'C:\\RetroArch-Win64\\cores',
    searchedPaths: [
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\retroarch.exe',
      '%PATH%\\retroarch.exe',
      'C:\\RetroArch-Win64\\retroarch.exe'
    ],
    downloadUrl: 'https://www.retroarch.com/?page=platforms'
  },
  {
    id: 'SNES9X',
    name: 'Snes9x',
    rulePath: `${APP_DIR}\\Emulators\\snes9x\\snes9x-x64.exe`,
    searchedPaths: ['%PATH%\\snes9x-x64.exe', ...emulatorsDir('snes9x\\snes9x-x64.exe')],
    downloadUrl: 'https://github.com/snes9xgit/snes9x/releases'
  },
  {
    id: 'DUCKSTATION',
    name: 'DuckStation',
    rulePath: null,
    searchedPaths: [
      '%PATH%\\duckstation-qt-x64-ReleaseLTCG.exe',
      '%PATH%\\duckstation-qt-x64-ReleaseLTCG-SSE2.exe',
      '%PATH%\\duckstation-nogui-x64-ReleaseLTCG.exe',
      ...emulatorsDir('duckstation\\duckstation-qt-x64-ReleaseLTCG.exe'),
      ...emulatorsDir('duckstation\\duckstation-qt-x64-ReleaseLTCG-SSE2.exe'),
      ...emulatorsDir('duckstation\\duckstation-nogui-x64-ReleaseLTCG.exe')
    ],
    downloadUrl: 'https://github.com/stenzel/duckstation/releases'
  },
  {
    id: 'MGBA',
    name: 'mGBA',
    rulePath: 'C:\\Program Files\\mGBA\\mGBA.exe',
    searchedPaths: [
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\mGBA_is1\\InstallLocation',
      '%PATH%\\mGBA.exe',
      'C:\\Program Files\\mGBA\\mGBA.exe'
    ],
    downloadUrl: 'https://mgba.io/downloads.html'
  },
  {
    id: 'RYUJINX',
    name: 'Ryujinx',
    rulePath: null,
    searchedPaths: [
      '%PATH%\\Ryujinx.exe',
      '%PATH%\\Ryujinx.Ava.exe',
      ...emulatorsDir('ryujinx\\Ryujinx.exe'),
      ...emulatorsDir('ryujinx\\Ryujinx.Ava.exe'),
      `${HOME}\\Desktop\\ryujinx\\Ryujinx.exe`
    ],
    downloadUrl: 'https://git.ryujinx.app/ryubing/ryujinx/-/releases'
  },
  {
    id: 'FLYCAST',
    name: 'Flycast',
    rulePath: `${APP_DIR}\\Emulators\\flycast\\flycast.exe`,
    searchedPaths: ['%PATH%\\flycast.exe', ...emulatorsDir('flycast\\flycast.exe')],
    downloadUrl: 'https://github.com/flyinghead/flycast/releases'
  },
  {
    id: 'MAME',
    name: 'MAME',
    rulePath: `${USER_DATA_DIR}\\Emulators\\mame\\mame.exe`,
    searchedPaths: ['%PATH%\\mame.exe', ...emulatorsDir('mame\\mame.exe')],
    downloadUrl: 'https://www.mamedev.org/release.html'
  }
]

/** Where PlayOut installs its own emulators on this fake machine (the Emulators folder next to PlayOut.exe). */
export const MOCK_SETUP_ROOT = `${APP_DIR}\\Emulators`

/** The emulators PlayOut downloads and sets up itself (src/main/emulator-setup/catalog.ts): id, name, folder, exe. */
export const SETUP_EMULATORS: { id: string; name: string; folder: string; exe: string }[] = [
  {
    id: 'DUCKSTATION',
    name: 'DuckStation',
    folder: 'DuckStation',
    exe: 'duckstation-qt-x64-ReleaseLTCG.exe'
  },
  { id: 'PCSX2', name: 'PCSX2', folder: 'PCSX2', exe: 'pcsx2-qt.exe' },
  { id: 'RPCS3', name: 'RPCS3', folder: 'RPCS3', exe: 'rpcs3.exe' },
  { id: 'DOLPHIN', name: 'Dolphin', folder: 'Dolphin', exe: 'Dolphin.exe' },
  { id: 'PPSSPP', name: 'PPSSPP', folder: 'PPSSPP', exe: 'PPSSPPWindows64.exe' },
  { id: 'FLYCAST', name: 'Flycast', folder: 'Flycast', exe: 'flycast.exe' },
  { id: 'AZAHAR', name: 'Azahar', folder: 'Azahar', exe: 'azahar.exe' },
  { id: 'MELONDS', name: 'melonDS', folder: 'melonDS', exe: 'melonDS.exe' },
  { id: 'MGBA', name: 'mGBA', folder: 'mGBA', exe: 'mGBA.exe' },
  { id: 'RYUJINX', name: 'Ryujinx', folder: 'Ryujinx', exe: 'Ryujinx.exe' },
  { id: 'M2EMULATOR', name: 'Model 2 Emulator', folder: 'Model2', exe: 'EMULATOR.EXE' },
  { id: 'SCUMMVM', name: 'ScummVM', folder: 'ScummVM', exe: 'scummvm.exe' },
  { id: 'MAME', name: 'MAME', folder: 'MAME', exe: 'mame.exe' },
  { id: 'RETROARCH', name: 'RetroArch', folder: 'RetroArch', exe: 'retroarch.exe' }
]

/** The exe a set-up emulator runs from on this fake machine. */
export function setupExeOf(id: string): string | null {
  const spec = SETUP_EMULATORS.find((e) => e.id === id)
  return spec ? `${MOCK_SETUP_ROOT}\\${spec.folder}\\${spec.exe}` : null
}

/**
 * Emulator statuses as getEmulators() reports them, honouring settings.emulators.overrides. `installed` holds the ids
 * PlayOut set up itself: after a user override and before the find rules, like the real resolver.
 */
export function emulatorStatuses(
  overrides: Record<string, string>,
  coresDirOverride: string | null,
  installed: ReadonlySet<string> = new Set()
): EmulatorStatus[] {
  const installable = new Set(SETUP_EMULATORS.map((e) => e.id))
  return MOCK_EMULATORS.map((e) => {
    const override = overrides[e.id]
    const managed = installed.has(e.id) ? setupExeOf(e.id) : null
    const path = override ?? managed ?? e.rulePath
    const status: EmulatorStatus = {
      id: e.id,
      name: e.name,
      path,
      foundBy: override ? 'override' : managed ? 'playout' : e.rulePath ? 'rule' : null,
      searchedPaths: e.searchedPaths,
      downloadUrl: e.downloadUrl,
      installable: installable.has(e.id)
    }
    if (e.id === 'RETROARCH')
      status.coresDir = coresDirOverride ?? (path ? (e.coresDir ?? null) : null)
    return status
  })
}

const EMULATOR_PLACEHOLDER = /%EMULATOR_([A-Z0-9!._-]+)%/g

/** Which %EMULATOR_X% names a command template needs. */
export function emulatorsReferenced(command: string): string[] {
  return [...command.matchAll(EMULATOR_PLACEHOLDER)].map((m) => m[1])
}

/** SystemInfo rows for getSystems(): definitions plus game counts and the command ids whose emulator was found. */
export function systemInfos(
  gameCounts: Record<string, number>,
  emulators: EmulatorStatus[]
): SystemInfo[] {
  const found = new Set(emulators.filter((e) => e.path).map((e) => e.id))
  return MOCK_SYSTEMS.map((s) => {
    const definition: SystemDefinition & Partial<MockSystem> = { ...s }
    delete definition.position
    delete definition.icon
    return {
      ...definition,
      gameCount: gameCounts[s.id] ?? 0,
      availableEmulators: s.emulators
        .filter((c) => emulatorsReferenced(c.command).every((id) => found.has(id)))
        .map((c) => c.id)
    }
  })
}

/** Platform rows (kind 'system') for the systems that have games, as the ROM provider registers them. */
export function systemPlatforms(systemIds: Iterable<string>): Platform[] {
  const wanted = new Set(systemIds)
  return MOCK_SYSTEMS.filter((s) => wanted.has(s.id)).map((s) => ({
    id: s.id,
    name: s.name,
    shortName: SHORT_NAMES[s.id],
    kind: 'system',
    icon: s.icon,
    sortOrder: SYSTEM_SORT_BASE + s.position,
    manufacturer: s.manufacturer,
    releaseYear: s.releaseYear
  }))
}

const SHORT_NAMES: Record<string, string> = {
  snes: 'SNES',
  psx: 'PS1',
  n64: 'N64',
  gba: 'GBA',
  switch: 'Switch',
  dreamcast: 'Dreamcast',
  genesis: 'Genesis',
  arcade: 'Arcade'
}

/** The emulator a ROM launch needs for its system's preferred (first) command, e.g. 'RYUJINX' for switch. */
export function primaryEmulatorFor(
  systemId: string,
  commandId?: string
): { emulatorId: string; commandLabel: string } | null {
  const system = MOCK_SYSTEMS.find((s) => s.id === systemId)
  if (!system) return null
  const command = findEmulatorCommand(system, commandId) ?? system.emulators[0]
  if (!command) return null
  const [emulatorId] = emulatorsReferenced(command.command)
  return emulatorId ? { emulatorId, commandLabel: command.label } : null
}
