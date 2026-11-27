import { playableHere, staleStandIns } from '@shared/recomp-play'
import type { Game, Platform, Settings } from '@shared/types'
import { sortPlatforms, syntheticPlatform } from './platforms'

/**
 * Pure library selectors. They never touch stores or the API so screens and tests can call them with any
 * Game[]; the zustand store in state/library.ts holds the data they operate on.
 */

/** The user-facing title: the user's override when set, else the scanned/scraped title. */
export function displayTitle(game: Game): string {
  const override = game.user?.titleOverride?.trim()
  return override && override.length > 0 ? override : game.title
}

/**
 * Games the UI should show: installed, plus the uninstalled ones (owned store games, games a rescan no longer
 * found) while `library.showUninstalled` (default true), and hidden ones only with showHidden. The rule is
 * `installed || (showUninstalled && (owned || previously installed))`; every remaining uninstalled record is one of
 * those two (ARCHITECTURE.md §3), so the test stays `(installed || showUninstalled) && (!hidden || showHidden)`.
 * Home's Recent row is a list of its own over these (lib/recent.ts `recentlyPlayed`).
 */
/** The settings visibleGames and hiddenGames read (the Library selects just these, not every settings change). */
export type GameVisibility = {
  library: Pick<Settings['library'], 'showUninstalled' | 'showHidden'>
}

export function visibleGames(games: Game[], settings: GameVisibility | null | undefined): Game[] {
  const showUninstalled = settings?.library.showUninstalled ?? true
  const showHidden = settings?.library.showHidden ?? false
  // An old record standing in through its recompilation beside a copy on this PC shows once (staleStandIns).
  const stale = staleStandIns(games)
  return games.filter(
    (g) => !stale.has(g.id) && (playableHere(g) || showUninstalled) && (!g.hidden || showHidden)
  )
}

/** The list behind Filters > Hidden: every hidden game, whatever showHidden says. */
export function hiddenGames(games: Game[], settings: GameVisibility | null | undefined): Game[] {
  const showUninstalled = settings?.library.showUninstalled ?? true
  const stale = staleStandIns(games)
  return games.filter((g) => !stale.has(g.id) && g.hidden && (playableHere(g) || showUninstalled))
}

function time(iso: string | undefined): number {
  if (!iso) return 0
  const t = Date.parse(iso)
  return Number.isNaN(t) ? 0 : t
}

/** Sort key for titles: sortTitle (lowercase, 'The ' stripped) falling back to the display title. */
export function sortKey(game: Game): string {
  return (
    game.sortTitle && game.sortTitle.length > 0 ? game.sortTitle : displayTitle(game)
  ).toLowerCase()
}

/** Alphabetical comparator by sortTitle, ties broken by id for stability. */
export function compareByTitle(a: Game, b: Game): number {
  return sortKey(a).localeCompare(sortKey(b)) || a.id.localeCompare(b.id)
}

/**
 * Most recently played first (lastPlayed desc), never-played games after them by addedAt desc; at most `count`.
 * Which games may be in the Recent row at all is lib/recent.ts's to say (`recentlyPlayed`).
 */
export function recentGames(games: Game[], count: number): Game[] {
  const sorted = [...games].sort((a, b) => {
    const played = time(b.lastPlayed) - time(a.lastPlayed)
    if (played !== 0) return played
    const added = time(b.addedAt) - time(a.addedAt)
    if (added !== 0) return added
    return compareByTitle(a, b)
  })
  return count >= 0 ? sorted.slice(0, count) : sorted
}

export interface PlatformGroup {
  platform: Platform
  games: Game[]
}

/**
 * Group games by platform in row order (platform sortOrder); only platforms that have games are returned
 * and each group is alphabetical by sortTitle. Games whose platformId has no row get a synthetic platform.
 */
export function gamesByPlatform(games: Game[], platforms: Platform[]): PlatformGroup[] {
  const byPlatform = new Map<string, Game[]>()
  for (const game of games) {
    const list = byPlatform.get(game.platformId)
    if (list) list.push(game)
    else byPlatform.set(game.platformId, [game])
  }
  const known = sortPlatforms(platforms)
  const groups: PlatformGroup[] = []
  for (const platform of known) {
    const list = byPlatform.get(platform.id)
    if (list && list.length > 0) {
      groups.push({ platform, games: list.sort(compareByTitle) })
      byPlatform.delete(platform.id)
    }
  }
  const leftovers = [...byPlatform.entries()].sort(([a], [b]) => a.localeCompare(b))
  for (const [id, list] of leftovers) {
    groups.push({ platform: syntheticPlatform(id), games: list.sort(compareByTitle) })
  }
  return groups
}

function normalize(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}

/**
 * Case- and accent-insensitive search over the display title, original title and sortTitle. Every word of
 * the query must match; results are ranked by prefix matches first, then alphabetically. Empty query -> [].
 */
export function searchGames(games: Game[], query: string): Game[] {
  const words = normalize(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const ranked: { game: Game; rank: number }[] = []
  for (const game of games) {
    const haystacks = [displayTitle(game), game.title, game.sortTitle]
      .filter(Boolean)
      .map(normalize)
    const matchesAll = words.every((w) => haystacks.some((h) => h.includes(w)))
    if (!matchesAll) continue
    const first = words[0]!
    const rank = haystacks.some((h) => h.startsWith(first))
      ? 0
      : haystacks.some((h) => h.split(/\s+/).some((token) => token.startsWith(first)))
        ? 1
        : 2
    ranked.push({ game, rank })
  }
  return ranked.sort((a, b) => a.rank - b.rank || compareByTitle(a.game, b.game)).map((r) => r.game)
}

/** Favourites first, then alphabetical: handy for a "Favourites" row. */
export function favoriteGames(games: Game[]): Game[] {
  return games.filter((g) => g.favorite).sort(compareByTitle)
}
