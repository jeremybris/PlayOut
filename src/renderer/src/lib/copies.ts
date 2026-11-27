import type { Game } from '@shared/types'
import { displayTitle } from './library'

/**
 * Pure grouping of the copies of one game into a single library card: owned in several PC stores (Steam and GOG),
 * and as ROMs of the systems in GROUPED_SYSTEMS (PS3, PS2, GameCube, Xbox 360, Xbox). The card shows one copy (the
 * user's preferred one, else the best-ranked, COPY_PREFERENCE) merged with the facts of every copy, so sorting and
 * badges treat the game as one. ROMs of every other system (GBA, GBC, Wii, ...) never group: always a card each.
 */

/** The ROM systems whose games group with the same game elsewhere (the others always show on their own). */
export const GROUPED_SYSTEMS: readonly string[] = ['ps3', 'ps2', 'gc', 'xbox360', 'xbox']

/**
 * Which copy a card shows, best first: a copy with a recompilation (an installed one before one only available, see
 * recompRank), then by where it is from, in this order (a PC store is its source, a ROM "rom:<system>"), then every
 * other PC store (the Xbox app, EA, Ubisoft, Battle.net, manual games).
 */
export const COPY_PREFERENCE: readonly string[] = [
  'steam',
  'gog',
  'epic',
  'rom:ps3',
  'rom:ps2',
  'rom:gc',
  'rom:xbox360',
  'rom:xbox'
]

/** The PC stores in the order they rank (the ones COPY_PREFERENCE does not name come after it, in this order). */
export const STORE_PREFERENCE: readonly string[] = ['steam', 'gog', 'epic', 'xbox']

/**
 * The fields of a parallel change to Game (`completed`, `user.preferredCopy`), read defensively so this
 * module works whether or not shared/types.ts has them yet.
 */
type CopyFacts = { completed?: boolean; user?: { preferredCopy?: boolean } }

function facts(game: Game): CopyFacts {
  return game as unknown as CopyFacts
}

/**
 * The grouping key of a game: its display title lowercased, accents and ™ ® © removed, a leading "the",
 * "a" or "an" dropped, every run of other characters than letters and digits made one space. Null for an empty
 * title, for a favourite (a copy the user favourited always shows as its own card), and for a ROM of a system outside
 * GROUPED_SYSTEMS (it always shows on its own). A ROM's title is already
 * without its region and dump tags ("(USA)", "[!]"), so the same game on several systems shares a key.
 */
export function copyKey(game: Game, options: CopyOptions = {}): string | null {
  if (game.favorite) return null
  // Show duplicates: no ROM shares a card (only PC store copies do).
  if (
    game.source === 'rom' &&
    (options.showDuplicates || !GROUPED_SYSTEMS.includes(game.platformId))
  )
    return null
  const key = displayTitle(game)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[™®©]/g, '')
    .trim()
    .replace(/^(the|a|an)\s+/, '')
    // Marks other than Latin accents (Indic vowel signs, kana voicing) belong to their letters: kept.
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim()
  return key.length > 0 ? key : null
}

export interface CopyGroup {
  /** The shown copy merged with the group's facts; the input game itself when the group has one copy. */
  game: Game
  /** Every copy: the shown one first, then the rest by preference. */
  copies: Game[]
}

export function releaseYear(game: Game): number | null {
  const match = /^(\d{4})/.exec(game.metadata?.releaseDate ?? '')
  return match ? Number(match[1]) : null
}

/**
 * Where a copy is from, as COPY_PREFERENCE names it: a PC store ('steam', 'xbox' for the Xbox app), or a ROM's system
 * ('rom:xbox' for the original Xbox). Two copies of one group never share it.
 */
export function copyOrigin(game: Game): string {
  return game.source === 'rom' ? `rom:${game.platformId}` : game.source
}

/** 0: a recompilation of it is installed; 1: one is available; 2: none (Game.metadata.recomp, main/recomp). */
function recompRank(game: Game): number {
  const recomp = game.metadata?.recomp
  if (!recomp) return 2
  return recomp.installed?.length ? 0 : 1
}

function originRank(game: Game): number {
  const rank = COPY_PREFERENCE.indexOf(copyOrigin(game))
  if (rank !== -1) return rank
  // Every other PC store: the Xbox app first (as before), then the rest alike.
  const store = STORE_PREFERENCE.indexOf(game.source)
  return COPY_PREFERENCE.length + (store !== -1 ? store : STORE_PREFERENCE.length)
}

/** How copies group (Settings › Library › Show duplicates). */
export interface CopyOptions {
  /**
   * Only PC store copies share a card, ranked Steam > GOG > Epic > Xbox > the rest (as before 0.1.125); every ROM
   * has its own card. Default false: COPY_PREFERENCE across stores and the GROUPED_SYSTEMS.
   */
  showDuplicates?: boolean
}

/** Preference order: recompilation, COPY_PREFERENCE rank, installed first, then id. */
function comparePreference(a: Game, b: Game): number {
  return (
    recompRank(a) - recompRank(b) ||
    originRank(a) - originRank(b) ||
    Number(b.installed) - Number(a.installed) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
}

function storeRank(game: Game): number {
  const rank = STORE_PREFERENCE.indexOf(game.source)
  return rank === -1 ? STORE_PREFERENCE.length : rank
}

/** Show duplicates' order (PC store copies only): STORE_PREFERENCE rank, installed first, then id. */
function compareStorePreference(a: Game, b: Game): number {
  return (
    storeRank(a) - storeRank(b) ||
    Number(b.installed) - Number(a.installed) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
}

/** The copies in display order: the first user-preferred copy, else the best-ranked; then the rest ranked. */
function orderCopies(copies: readonly Game[], options: CopyOptions): Game[] {
  const preferred = copies.find((copy) => facts(copy).user?.preferredCopy === true)
  const rest = copies
    .filter((copy) => copy !== preferred)
    .sort(options.showDuplicates ? compareStorePreference : comparePreference)
  return preferred ? [preferred, ...rest] : rest
}

function time(iso: string | undefined): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : t
}

/** The shown copy with the group's facts: latest lastPlayed, summed playtimes, earliest addedAt, any flag. */
export function mergeCopies(copies: readonly Game[]): Game {
  const shown = copies[0]!
  if (copies.length === 1) return shown
  let lastPlayed: string | undefined
  let lastPlayedAt = -Infinity
  let addedAt = shown.addedAt
  let addedAtTime = time(shown.addedAt) ?? Infinity
  let playtimeMinutes = 0
  let storePlaytimeMinutes: number | undefined
  for (const copy of copies) {
    const played = time(copy.lastPlayed)
    if (played !== null && played > lastPlayedAt) {
      lastPlayedAt = played
      lastPlayed = copy.lastPlayed
    }
    const added = time(copy.addedAt)
    if (added !== null && added < addedAtTime) {
      addedAtTime = added
      addedAt = copy.addedAt
    }
    playtimeMinutes += copy.playtimeMinutes
    if (copy.storePlaytimeMinutes !== undefined) {
      storePlaytimeMinutes = (storePlaytimeMinutes ?? 0) + copy.storePlaytimeMinutes
    }
  }
  const merged: Game = {
    ...shown,
    lastPlayed,
    playtimeMinutes,
    storePlaytimeMinutes,
    addedAt,
    favorite: copies.some((copy) => copy.favorite)
  }
  if (copies.some((copy) => facts(copy).completed !== undefined)) {
    ;(merged as unknown as CopyFacts).completed = copies.some(
      (copy) => facts(copy).completed === true
    )
  }
  return merged
}

interface Cluster {
  members: Game[]
  sources: Set<string>
  years: number[]
  /** The ROM members matched to an IGDB game: that game, and the member's release year when it is known. */
  roms: RomMatch[]
}

interface RomMatch {
  igdb: string
  year: number | null
}

/**
 * How many years apart the releases of two ROMs matched to two IGDB records may be and still be one game (a port a
 * year or two later, one of them matched to an edition's record).
 */
const ROM_YEAR_WINDOW = 2

/**
 * Two ROMs of one title are two games only on evidence: IGDB, which has one record for a game on all its consoles,
 * matched them to two records, and their years do not say otherwise ("SSX" of 2000 and "SSX" of 2012). Years alone
 * say nothing: ScreenScraper and TheGamesDB date a game per console ("Chrono Trigger": 1995, 1999, 2008), and IGDB
 * is optional.
 */
function otherGame(a: RomMatch, b: RomMatch): boolean {
  if (a.igdb === b.igdb) return false
  return a.year === null || b.year === null || Math.abs(a.year - b.year) > ROM_YEAR_WINDOW
}

/**
 * The library with every game's copies collapsed into one group. Games group by copyKey, greedily in input
 * order, except that two copies from one store or one system never group (two products sharing a title, two dumps of
 * one system) and a copy whose release year is more than one year off a member's known year does not join (DOOM 1993
 * vs DOOM 2016). Two ROMs of one title group as before (by title, whatever their years), unless IGDB has them as
 * two games (`otherGame`: "SSX" on the PlayStation 2, 2000, is not "SSX" on the PlayStation 3 and Xbox 360, 2012:
 * two cards).
 * Groups come out in the order of their first member, so callers sort afterwards.
 */
export function collapseCopies(games: readonly Game[], options: CopyOptions = {}): CopyGroup[] {
  const clusters: (Cluster | Game)[] = []
  const byKey = new Map<string, Cluster[]>()
  for (const game of games) {
    const key = copyKey(game, options)
    if (key === null) {
      clusters.push(game)
      continue
    }
    // The release-year check is between PC store copies only (DOOM 1993 vs DOOM 2016): a ROM's date is the console
    // original's, years before a PC port's (Bayonetta: Xbox 360 2009, Steam 2017), which still groups.
    const year = game.source === 'rom' ? null : releaseYear(game)
    // Between two ROMs only their IGDB matches tell two games of one title apart.
    const igdb = game.source === 'rom' ? game.metadata?.sources?.igdb : undefined
    const match: RomMatch | null = igdb ? { igdb, year: releaseYear(game) } : null
    const candidates = byKey.get(key) ?? []
    const home = candidates.find(
      (cluster) =>
        !cluster.sources.has(copyOrigin(game)) &&
        (year === null || cluster.years.every((known) => Math.abs(known - year) <= 1)) &&
        (match === null || !cluster.roms.some((rom) => otherGame(rom, match)))
    )
    if (home) {
      home.members.push(game)
      home.sources.add(copyOrigin(game))
      if (year !== null) home.years.push(year)
      if (match) home.roms.push(match)
      continue
    }
    const cluster: Cluster = {
      members: [game],
      sources: new Set([copyOrigin(game)]),
      years: year === null ? [] : [year],
      roms: match ? [match] : []
    }
    candidates.push(cluster)
    byKey.set(key, candidates)
    clusters.push(cluster)
  }
  return clusters.map((entry) => {
    if (!('members' in entry)) return { game: entry, copies: [entry] }
    const copies = orderCopies(entry.members, options)
    return { game: mergeCopies(copies), copies }
  })
}

/** Every copy in the group holding `gameId` (just that game when ungrouped); [] when unknown. */
export function copiesOf(
  games: readonly Game[],
  gameId: string,
  options: CopyOptions = {}
): Game[] {
  if (!games.some((game) => game.id === gameId)) return []
  const group = collapseCopies(games, options).find((g) =>
    g.copies.some((copy) => copy.id === gameId)
  )
  return group ? group.copies : []
}

/** collapseCopies flattened for a list of cards: the shown games, and the copy count of those that stand for more. */
export function collapsedGames(
  games: readonly Game[],
  options: CopyOptions = {}
): {
  games: Game[]
  copies: Map<string, number>
} {
  const copies = new Map<string, number>()
  const shown: Game[] = []
  for (const group of collapseCopies(games, options)) {
    shown.push(group.game)
    if (group.copies.length > 1) copies.set(group.game.id, group.copies.length)
  }
  return { games: shown, copies }
}
