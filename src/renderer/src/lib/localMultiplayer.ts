import type { Game } from '@shared/types'
import { t } from '../i18n'
import { hltbBucketOf, hltbHours } from './hltb'
import { localPlayersShown, MAX_LOCAL_PLAYERS } from './localPlayers'

/**
 * Filters > Local Multiplayer: "All Local Multiplayer" (Steam's local multiplayer tags, and every Nucleus Co-Op game),
 * then the player counts (shown as a controller with the number above it), then Nucleus Co-Op (the tab's `coop`).
 */
export const LOCAL_ALL = 'local-all'

/** The player counts (labels read in the language shown). */
export const PLAYER_BANDS = [
  {
    id: '2',
    get label(): string {
      return t('lib.players.band', { players: '2' })
    },
    badge: '2',
    min: 2,
    max: 2
  },
  {
    id: '3-4',
    get label(): string {
      return t('lib.players.band', { players: '3-4' })
    },
    badge: '3-4',
    min: 3,
    max: 4
  },
  {
    id: '5+',
    get label(): string {
      return t('lib.players.band', { players: '5+' })
    },
    badge: '5+',
    min: 5,
    max: Infinity
  }
] as const

/**
 * The player bands before 0.9.88 ("2-4 Players", "4+ Players"), as saved in tabs: they become the band that replaced
 * each one ("3-4 Players", "5+ Players").
 */
const RENAMED_PLAYER_BANDS: Readonly<Record<string, string>> = { '2-4': '3-4', '4+': '5+' }

/** Steam tags that mark a game as played together on one PC (compared case-insensitively). */
export const LOCAL_MULTIPLAYER_TAGS = [
  '4 Player Local',
  'Co-Op Campaign',
  'Local Co-Op',
  'Local Multiplayer',
  'Split Screen'
] as const

const LOCAL_TAGS = new Set(LOCAL_MULTIPLAYER_TAGS.map((t) => t.toLowerCase()))

/**
 * "All Local Multiplayer" games of a How Long To Beat length (lib/hltb.ts HLTB_BUCKETS ids): Party Games, short
 * enough for an evening or a few with friends (0-3 and 3-10 hours), and S.O. Games, long ones to play through with a significant other
 * (10 hours and more). A game without an HLTB time is in neither.
 */
export const LOCAL_LENGTH_CHOICES = [
  {
    id: 'party',
    get label(): string {
      return t('lib.players.party')
    },
    buckets: ['h-0-3', 'h-3-10']
  },
  {
    id: 'so',
    get label(): string {
      return t('lib.players.so')
    },
    buckets: ['h-10-20', 'h-20-50', 'h-50-100', 'h-100']
  }
] as const

/**
 * L.A.N. Party: the games the game page offers PeerParty for (LAN play, main/peerparty). Main scans the games' folders
 * for that, so it matches by the ids main sends (TabCardFilters.lanParty), never by a game's metadata alone.
 */
export const LAN_PARTY = {
  id: 'lan-party',
  get label(): string {
    return t('lib.players.lanParty')
  }
} as const

/** The choices this version knows (a tab saved with one since dropped, such as '1', loses it). */
export function knownLocalMultiplayerIds(ids: readonly string[]): string[] {
  const renamed = ids.map((id) => RENAMED_PLAYER_BANDS[id] ?? id)
  return [...new Set(renamed)].filter(
    (id) =>
      id === LOCAL_ALL ||
      PLAYER_BANDS.some((b) => b.id === id) ||
      LOCAL_LENGTH_CHOICES.some((c) => c.id === id) ||
      id === LAN_PARTY.id
  )
}

export function localMultiplayerLabel(id: string): string {
  if (id === LOCAL_ALL) return t('lib.players.all')
  if (id === LAN_PARTY.id) return LAN_PARTY.label
  return (
    PLAYER_BANDS.find((b) => b.id === id)?.label ??
    LOCAL_LENGTH_CHOICES.find((c) => c.id === id)?.label ??
    id
  )
}

/**
 * Most players on one PC: LaunchBox's count (the game page's players badge), or the Nucleus Co-Op handler's when it
 * is larger or LaunchBox has none (a Co-Op game plays split-screen on one PC).
 */
export function localPlayerCount(game: Pick<Game, 'metadata'>): number | undefined {
  const launchbox = localPlayersShown(game.metadata)
  const coop = game.metadata.coop?.maxPlayers
  const handler =
    typeof coop === 'number' && coop >= 1 && coop <= MAX_LOCAL_PLAYERS ? coop : undefined
  if (launchbox === undefined) return handler
  return handler === undefined ? launchbox : Math.max(launchbox, handler)
}

/** Steam says the game is played together on one PC (one of LOCAL_MULTIPLAYER_TAGS). */
export function hasLocalMultiplayerTag(game: Pick<Game, 'metadata'>): boolean {
  return !!game.metadata.steamTags?.tags.some((t) => LOCAL_TAGS.has(t.trim().toLowerCase()))
}

/**
 * Whether a game falls under one Local Multiplayer choice (LOCAL_ALL, a PLAYER_BANDS id, or a LOCAL_LENGTH_CHOICES
 * id: All Local Multiplayer and that How Long To Beat length).
 */
export function matchesLocalMultiplayer(game: Pick<Game, 'metadata'>, id: string): boolean {
  if (id === LOCAL_ALL) return hasLocalMultiplayerTag(game) || !!game.metadata.coop
  // By main's list of ids (lib/libraryFilter.ts), not by metadata.
  if (id === LAN_PARTY.id) return false
  const length = LOCAL_LENGTH_CHOICES.find((c) => c.id === id)
  if (length) {
    const bucket = hltbBucketOf(hltbHours(game))
    return (
      matchesLocalMultiplayer(game, LOCAL_ALL) &&
      bucket !== undefined &&
      (length.buckets as readonly string[]).includes(bucket)
    )
  }
  const band = PLAYER_BANDS.find((b) => b.id === id)
  const count = localPlayerCount(game)
  return !!band && count !== undefined && count >= band.min && count <= band.max
}
