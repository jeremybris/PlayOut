import { ANTI_CHEAT } from '../../overlay/overlay-logic'

/**
 * Image names the memory cleanup never trims, as lower-case base names without ".exe" (what normalizeImage gives).
 * Free of other imports, so the C# of both tiers (trim-cs.ts) is generated from the same lists: HARD_NEVER_NAMES and
 * HARD_NEVER_PREFIXES are checked again there, against the name of the process that was actually opened.
 */

/** 'C:\\x\\Game.EXE' -> 'game' (the same rule as process-monitor.ts normalizeProcessName). */
export function normalizeImage(name: string): string {
  return name
    .replace(/^.*[\\/]/, '')
    .trim()
    .toLowerCase()
    .replace(/\.exe$/, '')
}

/** Windows' kernel-side and session processes: trimming one stalls the whole desktop, sound or sign-in. */
export const CRITICAL_NAMES: readonly string[] = [
  'system',
  'system idle process',
  'idle',
  'secure system',
  'registry',
  'memory compression',
  'memcompression',
  'smss',
  'csrss',
  'wininit',
  'winlogon',
  'services',
  'lsass',
  'lsaiso',
  'svchost',
  'dwm',
  'fontdrvhost',
  'audiodg',
  'sihost',
  'ctfmon',
  'wudfhost',
  'vmmem',
  'vmmemwsl',
  'vmwp',
  'vmcompute'
]

/** Security software: Microsoft Defender's processes and the common third-party engines' services. */
export const SECURITY_NAMES: readonly string[] = [
  'msmpeng',
  'nissrv',
  'securityhealthservice',
  'securityhealthsystray',
  'mpdefendercoreservice',
  'mpcmdrun',
  'smartscreen',
  'sgrmbroker',
  'mssense',
  'avp',
  'avpui',
  'avgsvc',
  'avastsvc',
  'mbamservice',
  'ekrn',
  'bdservicehost',
  'vsserv',
  'mcshield',
  'mfemms',
  'nortonsecurity',
  'wrsa',
  'savservice',
  'csfalconservice',
  'csfalconcontainer',
  'sentinelagent',
  'sentinelservicehost',
  'bdagent',
  'avastui',
  'avgui',
  'egui',
  'nswscsvc',
  // Riot Vanguard's tray program (its service, vgc, is in the anti-cheat list).
  'vgtray'
]

/** Name prefixes of security software (Defender for Endpoint: SenseNdr, SenseCncProxy, SenseIR, SenseTVM ...). */
export const SECURITY_PREFIXES: readonly string[] = ['sense']

/** Game streaming hosts and clients: a trimmed encoder or decoder drops frames. */
export const STREAMING_NAMES: readonly string[] = [
  'sunshine',
  'sunshinesvc',
  'moonlight',
  'apollo',
  'nvstreamer',
  'steam_monitor'
]

/** Anti-cheat services (overlay-logic.ts ANTI_CHEAT, the list the overlay's pause and Enhanced Sleep/Wake use). */
export const ANTI_CHEAT_NAMES: readonly string[] = [...ANTI_CHEAT].map(normalizeImage)

/**
 * The names both tiers' C# refuses whatever pid list it is given: Windows' critical processes, security software,
 * anti-cheat and streaming.
 */
export const HARD_NEVER_NAMES: readonly string[] = [
  ...new Set([...CRITICAL_NAMES, ...SECURITY_NAMES, ...ANTI_CHEAT_NAMES, ...STREAMING_NAMES])
]
export const HARD_NEVER_PREFIXES: readonly string[] = [...SECURITY_PREFIXES]

/**
 * Store clients, their overlays and the tools that draw into a game (RivaTuner, PresentMon): left alone while a game
 * runs, because one of them owns the game's licence check, overlay, cloud saves or controller support.
 */
export const LAUNCHER_NAMES: readonly string[] = [
  'steam',
  'steamwebhelper',
  'steamservice',
  'gameoverlayui',
  'gameoverlayui64',
  'epicgameslauncher',
  'epicwebhelper',
  'epiconlineservicesuserhelper',
  'eosoverlayrenderer-win64-shipping',
  'eosoverlayrenderer-win32-shipping',
  'galaxyclient',
  'galaxyclient helper',
  'galaxyclientservice',
  'galaxycommunication',
  'galaxyoverlay',
  'battle.net',
  'agent',
  'eadesktop',
  'eabackgroundservice',
  'ealocalhostsvc',
  'origin',
  'originwebhelperservice',
  'ubisoftconnect',
  'upc',
  'uplaywebcore',
  'ubisoftgamelauncher',
  'ubisoftgamelauncher64',
  'gamingservices',
  'gamingservicesnet',
  'xboxpcapp',
  'xboxpcappft',
  'xboxapp',
  'gamebar',
  'gamebarftserver',
  'gamebarpresencewriter',
  'rockstarservice',
  'socialclubhelper',
  'amazon games',
  'itch',
  'playnite.desktopapp',
  'playnite.fullscreenapp',
  'rtss',
  'rtsshooksloader64',
  'encoderserver',
  'encoderserver64',
  'msiafterburner',
  'presentmon'
]

/** Emulators: never trimmed, whether PlayOut started them or not (an emulator's whole memory is the game). */
export const EMULATOR_NAMES: readonly string[] = [
  'retroarch',
  'rpcs3',
  'cemu',
  'ryujinx',
  'ryujinx.ava',
  'yuzu',
  'eden',
  'citron',
  'sudachi',
  'suyu',
  'azahar',
  'lime3ds',
  'xemu',
  'mame',
  'melonds',
  'mgba',
  'mgba-sdl',
  'flycast',
  'redream',
  'vita3k',
  'shadps4',
  'mesen',
  'bsnes',
  'ares',
  'desmume',
  'project64',
  'simple64-gui',
  'rmg',
  'scummvm',
  'fs-uae',
  'winuae',
  'winuae64',
  'bigpemu',
  'supermodel',
  'cxbx',
  'cxbxr-ldr',
  'visualboyadvance-m',
  'stella',
  'hatari',
  'openmsx',
  'vice',
  'x64sc',
  'play',
  'gopher64',
  'model2',
  'emulator_multicpu',
  'demul',
  'nulldc',
  'ruffle'
]

/** Emulators whose file name carries a build suffix (pcsx2-qtx64-avx2, duckstation-qt-x64-ReleaseLTCG, ...). */
export const EMULATOR_PREFIXES: readonly string[] = [
  'pcsx2',
  'duckstation',
  'dolphin',
  'ppsspp',
  'xenia',
  'snes9x',
  'citra',
  'mupen64plus',
  'dosbox',
  'primehack',
  'mednafen'
]

const startsWithAny = (name: string, prefixes: readonly string[]): boolean =>
  prefixes.some((p) => name.startsWith(p))

const CRITICAL = new Set(CRITICAL_NAMES)
const SECURITY = new Set(SECURITY_NAMES)
const STREAMING = new Set(STREAMING_NAMES)
const ANTI = new Set(ANTI_CHEAT_NAMES)
const LAUNCHERS = new Set(LAUNCHER_NAMES)
const EMULATORS = new Set(EMULATOR_NAMES)

export const isCriticalName = (name: string): boolean => CRITICAL.has(name)
export const isSecurityName = (name: string): boolean =>
  SECURITY.has(name) || startsWithAny(name, SECURITY_PREFIXES)
export const isStreamingName = (name: string): boolean => STREAMING.has(name)
export const isAntiCheatName = (name: string): boolean => ANTI.has(name)
export const isLauncherName = (name: string): boolean => LAUNCHERS.has(name)
export const isEmulatorName = (name: string): boolean =>
  EMULATORS.has(name) || startsWithAny(name, EMULATOR_PREFIXES)
