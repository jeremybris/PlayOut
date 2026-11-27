import { ONLINE_TAGS, ONLINE_ALL } from './online-multiplayer'
import type { Game } from './types'

/** The multiplayer services PeerParty can stand in for (README, "What it covers"). */
export type PeerPartyService =
  'steamworks' | 'eos' | 'playfab' | 'galaxy' | 'photon' | 'ugs' | 'demonware' | 'xbox'

export const PEERPARTY_SERVICE_LABELS: Record<PeerPartyService, string> = {
  steamworks: 'Steamworks',
  eos: 'Epic Online Services',
  playfab: 'PlayFab',
  galaxy: 'GOG Galaxy',
  photon: 'Photon',
  ugs: 'Unity Gaming Services',
  demonware: 'Demonware',
  xbox: 'Xbox app'
}

/** Why the PeerParty square is not offered for a game. */
export type PeerPartyBlock =
  | 'remote'
  | 'rom'
  | 'recomp'
  | 'not-installed'
  | 'no-folder'
  | 'competitive'
  | 'no-multiplayer'
  | 'anti-cheat'
  | 'anti-cheat-unknown'
  | 'no-exe'
  | 'no-service'

/**
 * Tags that block PeerParty: games whose online play is likely protected by server-side or kernel anti-cheat (Free to
 * Play, Competitive, eSports, MMO). A plain "PvP" tag does not block: many LAN-friendly games without anti-cheat carry
 * it (TowerFall, Spelunky 2, Age of Mythology); anti-cheat itself is found by the folder scan, Valve Anti-Cheat by
 * Steam's listing, and anti-cheat that leaves no files by PEERPARTY_KERNEL_ANTICHEAT.
 */
export const PEERPARTY_BLOCK_TAGS: readonly string[] = [
  'Free to Play',
  'Competitive',
  'eSports',
  ...ONLINE_TAGS.mmo!
]

/**
 * Games whose kernel anti-cheat leaves no file in their folder for the scan to find, by title: Activision's Ricochet,
 * in Call of Duty since 2019 (Modern Warfare, Modern Warfare II and III, Black Ops Cold War, 6 and 7, Vanguard, Warzone
 * and the Call of Duty HQ app). Not Call of Duty 4: Modern Warfare or Modern Warfare Remastered, which have none.
 */
export const PEERPARTY_KERNEL_ANTICHEAT: ReadonlyArray<{ name: string; title: RegExp }> = [
  {
    name: 'Ricochet',
    title:
      /^call of duty[®™]?(?:\s*hq)?$|^call of duty[®™]?:\s*(?:modern warfare[®™]?(?:\s*(?:ii|iii|2|3)[®™]?)?|black ops(?:[®™]?\s*(?:cold war|6|7))|vanguard|warzone(?:\s*\d+(?:\.0)?)?)\s*$/i
  }
]

/** The kernel anti-cheat a game's title is listed with (PEERPARTY_KERNEL_ANTICHEAT), else null. */
export function peerPartyKernelAntiCheat(title: string): string | null {
  const t = title.trim()
  return PEERPARTY_KERNEL_ANTICHEAT.find((k) => k.title.test(t))?.name ?? null
}

/**
 * An Xbox 360 game that Windows runs in its backward-compatibility emulator (an Xbox app package named
 * "Xbox360BackwardCompatibility…", started through EmuMenu.exe): not a PC game, so PeerParty cannot carry it.
 */
export function isXbox360BackwardCompatible(
  game: Pick<Game, 'source' | 'externalId'>,
  exe?: string | null
): boolean {
  if (game.source !== 'xbox') return false
  if (/xbox360backwardcompatib/i.test(game.externalId)) return true
  return !!exe && /(?:^|[\\/])emumenu\.exe$/i.test(exe)
}

/** Kept equal to renderer lib/localMultiplayer.ts LOCAL_MULTIPLAYER_TAGS (a renderer test checks it). */
export const PEERPARTY_LOCAL_TAGS: readonly string[] = [
  '4 Player Local',
  'Co-Op Campaign',
  'Local Co-Op',
  'Local Multiplayer',
  'Split Screen'
]

/** Tags (Steam tags, genres, tags; case-insensitive) that mark a game as multiplayer. */
export const PEERPARTY_MULTIPLAYER_TAGS: readonly string[] = [
  ...new Set([
    ...ONLINE_TAGS[ONLINE_ALL]!,
    ...PEERPARTY_LOCAL_TAGS,
    'Multiplayer',
    'Co-op',
    'LAN',
    'LAN Co-Op',
    'LAN PvP',
    'Online PvP',
    'Asynchronous Multiplayer'
  ])
]

const lowerTags = (game: Pick<Game, 'metadata'>): Set<string> =>
  new Set(
    [
      ...(game.metadata.steamTags?.tags ?? []),
      ...(game.metadata.genres ?? []),
      ...(game.metadata.tags ?? [])
    ].map((t) => t.trim().toLowerCase())
  )

/**
 * The blocking tags a game has (PEERPARTY_BLOCK_TAGS order), from its Steam tags, genres and tags alike, so a game
 * from another store whose genres say PvP or MMO is blocked too.
 */
export function peerPartyBlockTags(game: Pick<Game, 'metadata'>): string[] {
  const have = lowerTags(game)
  return PEERPARTY_BLOCK_TAGS.filter((t) => have.has(t.toLowerCase()))
}

/** Online or Local Multiplayer filter, a multiplayer/LAN tag, a Nucleus Co-Op handler, or LaunchBox's 2+ players. */
export function peerPartyHasMultiplayer(game: Pick<Game, 'metadata'>): boolean {
  const have = lowerTags(game)
  return (
    PEERPARTY_MULTIPLAYER_TAGS.some((t) => have.has(t.toLowerCase())) ||
    !!game.metadata.coop ||
    (game.metadata.localPlayers?.max ?? 0) >= 2
  )
}

export interface PeerPartyProgress {
  /** The game being started, or null for a download not tied to one. */
  gameId: string | null
  phase: 'checking' | 'downloading' | 'verifying' | 'installing' | 'starting' | 'done' | 'failed'
  percent?: number
  bytesDone?: number
  bytesTotal?: number
  message?: string
}

/** What the game page shows for PeerParty ('peerparty:status'). */
export interface PeerPartyStatus {
  gameId: string
  /** The PeerParty square is offered (blocked === null and not checking). */
  supported: boolean
  /** The game's folder is being scanned for the first time; the square stays empty until 'peerparty:status'. */
  checking: boolean
  /** Services found (folder files, the exe's demonware.net, an Xbox app game). */
  services: PeerPartyService[]
  blocked: PeerPartyBlock | null
  /** One sentence saying why it is blocked (for logs / tooltips), else null. */
  reason: string | null
  /** Anti-cheat names found in its folder. */
  antiCheat: string[]
  /** The program PeerParty would start, or null. */
  exe: string | null
  /** PlayOut's copy of PeerParty: its release tag, null before the first download. */
  installedVersion: string | null
  /** A download, check or start running now for this game (or a download for any game). */
  busy: PeerPartyProgress | null
  /** This game runs through PeerParty now. */
  running: boolean
}

/**
 * Filters > Local Multiplayer > L.A.N. Party: the games the game page offers PeerParty for ('peerparty:compatible').
 * `scanning`: folders not scanned before are still being checked, one at a time, so more may follow.
 */
export interface PeerPartyCompatible {
  ids: string[]
  scanning: boolean
}

/** A game running through PeerParty ('peerparty:session'). */
export interface PeerPartySession {
  gameId: string
  title: string
  startedAt: string
  exe: string
  pid?: number
}

/** Name of PlayOut's PeerParty folder in userData (peerparty.exe, peerparty-data, logs). */
export const PEERPARTY_FOLDER = 'PeerParty'
export const PEERPARTY_REPO_URL = 'https://github.com/MaximumFreak/PeerParty'

/**
 * The overlay's PeerParty tab ('peerPartyOverlay'), shown in place of Friends while a game runs through PeerParty.
 * `lan`: 'on' while PeerParty's LAN engine runs in the game (its peer board file is held open), 'starting' for a
 * while after the start until it does, else 'off'. `players`: the players of this game PeerParty sees on the network,
 * this PC's included; left out when PeerParty's files could not be read as expected.
 */
export interface PeerPartyOverlayStatus {
  active: boolean
  gameTitle?: string
  lan: 'on' | 'starting' | 'off'
  players?: number
}

/**
 * The overlay's "Invite everyone on the LAN" ('peerPartyInvite'): 'sent' when a PeerParty game took the invite,
 * 'none' when none answered, 'error' (with `message`) when it could not be asked.
 */
export interface PeerPartyInviteResult {
  result: 'sent' | 'none' | 'error'
  message?: string
}

/** The base name of a Windows or POSIX path, lower-cased. */
const baseNameLower = (path: string): string => (path.split(/[\\/]/).pop() ?? path).toLowerCase()

/**
 * Whether the overlay shows the PeerParty tab for a session: the overlay opened over that game (by PlayOut's game id,
 * or by its program when the overlay knows only the program), or over nothing in particular.
 */
export function peerPartyForOverlay(
  session: Pick<PeerPartySession, 'gameId' | 'exe'> | null | undefined,
  target: { gameId?: string; program?: string }
): boolean {
  if (!session) return false
  if (target.gameId) return target.gameId === session.gameId
  if (target.program) return baseNameLower(target.program) === baseNameLower(session.exe)
  return true
}
