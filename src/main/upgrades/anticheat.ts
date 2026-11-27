// The ban-risk signals of a game, shown before an upgrade is turned on (docs/research/upgrades/gpu-anticheat.md,
// part B): its multiplayer tags (RISK_TAGS) and the anti-cheat found in its folder. The folder rules follow SteamDB's
// FileDetectionRuleSets (MIT; reimplemented, not copied) with a few precise additions: every path inside the folder,
// lowercased with "/" separators and folders ending in "/", is tested against them. Anti-cheat built into the game's
// program (VAC, Denuvo Anti-Cheat) or installed only system-wide (FACEIT) leaves nothing to find there.
import { promises as fs } from 'fs'
import { join } from 'path'
import type { Game } from '../../shared/types'
import { riskTagsOf } from '../../shared/upgrades'

/** The file system access findAntiCheat needs (tests pass a fake). */
export interface FsIo {
  /** The entries of a folder; `isLink`: a symbolic link, junction or other reparse point (never followed). */
  readdir(dir: string): Promise<Array<{ name: string; isDirectory: boolean; isLink: boolean }>>
}

/** The real file system. */
export const nodeFsIo: FsIo = {
  async readdir(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries.map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
      isLink: e.isSymbolicLink()
    }))
  }
}

/**
 * How many folder levels below the game's folder findAntiCheat opens: 4 lists names up to five deep (ACE's folder
 * sits at Game\DeltaForce\Binaries\Win64\AntiCheatExpert).
 */
export const ANTICHEAT_SCAN_DEPTH = 4

/** How many folders findAntiCheat opens, at most (nearest the top first); files do not count. */
export const ANTICHEAT_SCAN_LIMIT = 20000

/** One anti-cheat: its name as the player knows it and the paths that show it is there. */
interface AntiCheatRule {
  name: string
  patterns: RegExp[]
}

/** Paths are tested lowercased, "/"-separated, folders ending in "/"; `(?:^|/)` means at any depth. */
const RULES: AntiCheatRule[] = [
  {
    name: 'Easy Anti-Cheat',
    patterns: [
      /(?:^|\/)easyanticheat\//,
      /(?:^|\/)easyanticheat_(?:eos_)?setup\.exe$/,
      /(?:^|\/)(?:easyanticheat(?:_x64)?|eac_server64)\.dll$/,
      /^start_protected_game\.exe$/
    ]
  },
  {
    name: 'BattlEye',
    patterns: [
      /(?:^|\/)battleye\//,
      /(?:^|\/)beservice(?:_x64)?\.exe$/,
      /(?:^|\/)beclient(?:_x64)?\.dll$/
    ]
  },
  {
    name: 'EA Javelin Anticheat',
    patterns: [
      /(?:^|\/)eaanticheat\.installer\.exe$/,
      /(?:^|\/)eaanticheat\.gameservicelauncher\.(?:exe|dll)$/
    ]
  },
  {
    // Vanguard is installed system-wide; VALORANT and League of Legends need it.
    name: 'Riot Vanguard',
    patterns: [/(?:^|\/)valorant(?:-win64-shipping)?\.exe$/, /(?:^|\/)league of legends\.exe$/]
  },
  {
    name: 'nProtect GameGuard',
    patterns: [/(?:^|\/)gameguard\.des$/, /(?:^|\/)gameguard\/gamemon(?:64)?\.des$/]
  },
  {
    name: 'XIGNCODE3',
    patterns: [/\.xem$/, /(?:^|\/)xhunter1\.sys$/]
  },
  {
    name: 'PunkBuster',
    patterns: [
      /(?:^|\/)(?:pnkbstra|pbsvc)\.exe$/,
      /(?:^|\/)pbsv\.dll$/,
      /(?:^|\/)punkbuster(?:$|\/)/,
      /(?:^|\/)pb\/(?:pbcl|pbag)\.dll$/
    ]
  },
  {
    name: 'ACE',
    patterns: [/(?:^|\/)anticheatexpert\//, /(?:^|\/)aceantibotclient\//]
  },
  { name: 'Ricochet', patterns: [/(?:^|\/)randgrid\.sys$/] },
  {
    name: 'HoYoKProtect',
    patterns: [/(?:^|\/)(?:mhyprot\d?\.sys|hoyokprotect\.sys|mhypbase\.dll)$/]
  },
  { name: 'TenProtect', patterns: [/(?:^|\/)tp3helper\.exe$/] },
  {
    name: 'NetEase Anti-Cheat',
    patterns: [/(?:^|\/)neacsafe64(?:_ex)?\.sys$/, /(?:^|\/)nep2\.dll$/]
  },
  { name: 'EQU8', patterns: [/(?:^|\/)equ8_conf\.json$/] },
  { name: 'HackShield', patterns: [/(?:^|\/)hshield\/hsinst\.dll$/] },
  {
    name: 'BlackCipher',
    patterns: [/(?:^|\/)blackcall(?:64)?\.aes$/, /(?:^|\/)blackcat64\.sys$/]
  },
  { name: 'AnyBrain', patterns: [/(?:^|\/)anybrainsdk\.dll$/, /(?:^|\/)cerebro\.dll$/] },
  { name: 'Fredaikis Anti-Cheat', patterns: [/(?:^|\/)fredaikisanticheat\//] }
]

/**
 * The game's tags that may mean an anti-cheat bans modified games: its Steam tags, genres and tags among RISK_TAGS
 * (case-insensitive, in RISK_TAGS order, each once).
 */
export function gameRiskTags(game: Pick<Game, 'metadata'>): string[] {
  const m = game.metadata
  return riskTagsOf([...(m?.steamTags?.tags ?? []), ...(m?.genres ?? []), ...(m?.tags ?? [])])
}

/** The anti-cheat names a list of paths inside a game's folder shows (lowercase, "/", folders ending in "/"). */
export function antiCheatOfPaths(paths: readonly string[]): string[] {
  const found = new Set<string>()
  for (const path of paths) {
    const p = path.toLowerCase()
    for (const rule of RULES) {
      if (!found.has(rule.name) && rule.patterns.some((re) => re.test(p))) found.add(rule.name)
    }
  }
  return RULES.filter((r) => found.has(r.name)).map((r) => r.name)
}

/** Why findAntiCheat could not check a game's folder. */
export type AntiCheatScanFailure = 'protected' | 'unreadable' | 'incomplete'

/**
 * Thrown by findAntiCheat when the game's folder could not be checked, so "no anti-cheat" is never claimed for it:
 * `protected`, a Microsoft Store / Game Pass folder (inside WindowsApps), which apps may not read; `unreadable`, the
 * folder itself could not be listed (access denied, for one); `incomplete`, the scan reached its limit or passed over
 * a protected subfolder and found nothing in the part it read.
 */
export class AntiCheatScanError extends Error {
  /** What stopped the check. */
  readonly reason: AntiCheatScanFailure

  constructor(reason: AntiCheatScanFailure, installDir: string) {
    super(
      reason === 'protected'
        ? `${installDir} is a protected folder`
        : reason === 'unreadable'
          ? `${installDir} could not be read`
          : `${installDir} was too large to check completely`
    )
    this.name = 'AntiCheatScanError'
    this.reason = reason
  }
}

/** What scanAntiCheat found: the anti-cheat names, and whether every folder in reach was read. */
export interface AntiCheatScan {
  /** The anti-cheat names found, in a fixed order, each once. */
  names: string[]
  /** False when the folder limit was reached or a protected or unreadable subfolder was passed over. */
  complete: boolean
}

/**
 * Scans a game's folder for anti-cheat and says whether the scan was complete. Opens folders ANTICHEAT_SCAN_DEPTH
 * levels below it, breadth first, and at most ANTICHEAT_SCAN_LIMIT folders; every file name is tested as it is read
 * (files do not count toward the limit, so a folder of loose assets cannot crowd out the deeper ones) and it stops
 * early once every anti-cheat it knows has been found. Never follows symbolic links or junctions and passes over
 * WindowsApps subfolders and unreadable subfolders (the scan is then not complete). A missing game folder gives no
 * names, complete. Throws AntiCheatScanError (`protected`) for a folder inside WindowsApps and (`unreadable`) when
 * the game's folder itself cannot be listed.
 */
export async function scanAntiCheat(
  installDir: string,
  io: FsIo = nodeFsIo
): Promise<AntiCheatScan> {
  if (/(?:^|[\\/])windowsapps(?:[\\/]|$)/i.test(installDir)) {
    throw new AntiCheatScanError('protected', installDir)
  }
  const found = new Set<string>()
  const test = (path: string): void => {
    for (const rule of RULES) {
      if (!found.has(rule.name) && rule.patterns.some((re) => re.test(path))) found.add(rule.name)
    }
  }
  const result = (complete: boolean): AntiCheatScan => ({
    names: RULES.filter((r) => found.has(r.name)).map((r) => r.name),
    complete
  })
  let complete = true
  let opened = 0
  let queue: Array<{ dir: string; rel: string }> = [{ dir: installDir, rel: '' }]
  for (let depth = 0; depth <= ANTICHEAT_SCAN_DEPTH && queue.length > 0; depth++) {
    const next: typeof queue = []
    for (const { dir, rel } of queue) {
      if (found.size === RULES.length) return result(true)
      if (opened >= ANTICHEAT_SCAN_LIMIT) return result(false)
      opened++
      let entries: Awaited<ReturnType<FsIo['readdir']>>
      try {
        entries = await io.readdir(dir)
      } catch (err) {
        if (depth > 0) {
          complete = false
          continue
        }
        const code = (err as NodeJS.ErrnoException | null)?.code
        if (code === 'ENOENT' || code === 'ENOTDIR') return result(true)
        throw new AntiCheatScanError('unreadable', installDir)
      }
      for (const e of entries) {
        if (e.isLink) continue
        const relPath = rel + e.name.toLowerCase()
        if (!e.isDirectory) {
          test(relPath)
          continue
        }
        test(`${relPath}/`)
        if (depth >= ANTICHEAT_SCAN_DEPTH) continue
        if (e.name.toLowerCase() === 'windowsapps') complete = false
        else next.push({ dir: join(dir, e.name), rel: `${relPath}/` })
      }
    }
    queue = next
  }
  return result(complete)
}

/**
 * The anti-cheat found in a game's folder ("Easy Anti-Cheat", "BattlEye", …; in a fixed order, each once), by
 * scanAntiCheat's bounded scan. A missing game folder gives an empty list. Throws AntiCheatScanError when the folder
 * could not be checked: a protected (WindowsApps) or unreadable game folder, or an incomplete scan that found
 * nothing. An empty list therefore always means the folder was checked and nothing was found; treat the error as
 * "anti-cheat unknown".
 */
export async function findAntiCheat(installDir: string, io: FsIo = nodeFsIo): Promise<string[]> {
  const scan = await scanAntiCheat(installDir, io)
  if (!scan.complete && scan.names.length === 0) {
    throw new AntiCheatScanError('incomplete', installDir)
  }
  return scan.names
}
