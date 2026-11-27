import {
  DEFAULT_DIFFICULTY,
  pickedDifficulty,
  tagDifficulty,
  isToolsDifficulty,
  type EffectiveDifficulty
} from '@shared/difficulty'
import type { CustomFilter, Game, Platform, RemoteLibrary } from '@shared/types'
import { controlsFilterIds } from './controls'
import type { CopyGroup } from './copies'
import { customGameIds } from './customFilters'
import { hltbBucketOf, hltbHours } from './hltb'
import { installSizeBytes, sizeBucketOf } from './installSize'
import { hiddenGames, visibleGames } from './library'
import { matchesCreators } from './libraryTabs'
import { activePlayersOf, filterLibrary, LIBRARY_ALL_TAB } from './libraryView'
import { LAN_PARTY, matchesLocalMultiplayer } from './localMultiplayer'
import { matchesOnlineMultiplayer } from './onlineMultiplayer'
import { matchesPlatformFilter } from './platformFilters'
import { releaseEraOf, releaseTime, releaseYear } from './releaseEras'
import { reviewBandOf, reviewScoreOf, reviewValueOf, type ReviewValue } from './reviews'
import { matchesStoreFilter, platformKindOf, type PlatformKindOf } from './storeFilters'
import { collapseWithRemote, hostGamesShown, withRemoteGames } from './streaming'

/**
 * Which cards a Library tab shows: the Library grid's filtering (screens/Library/Library.tsx), as pure steps it keeps
 * in separate memos, and whole (tabShowsGame) for a game page that asks whether the Library would show its card.
 */

/** A card: the copy shown and every copy of the game (lib/copies.ts CopyGroup). */
type Group = { game: Game; copies: readonly Game[] }

/** The view's filters that pick the cards (state/ui.ts LibraryFilters). */
export interface TabCardFilters {
  query: string
  platforms: readonly string[]
  stores: readonly string[]
  genres: readonly string[]
  tags: readonly string[]
  eras: readonly string[]
  sizes: readonly string[]
  hltb: readonly string[]
  /** Filters > Difficulty: shared/difficulty.ts ids; absent or empty = every level. */
  difficulty?: readonly string[]
  /** Filters > Reviews: lib/reviews.ts REVIEW_BANDS ids; absent or empty = every game. */
  reviews?: readonly string[]
  controls: readonly string[]
  players: readonly string[]
  online: readonly string[]
  hidden: boolean
  favorites: boolean
  coop: boolean
  recomp: boolean
  developers?: readonly string[]
  publishers?: readonly string[]
  /** Filters > Custom: the user's filters picked (ids); absent or empty = every game. */
  custom?: readonly string[]
  /**
   * The user's filters (settings.library.customFilters) the `custom` ids are looked up in; an id not among them is
   * ignored (none known: the filter keeps every card).
   */
  customFilters: readonly CustomFilter[]
  /**
   * Local Multiplayer > L.A.N. Party: the ids of the games PeerParty is offered for (state/peerparty.ts, from main).
   * Missing: none yet, so the choice keeps no card.
   */
  lanParty?: ReadonlySet<string>
}

/**
 * Filters > Recompilations: a card any copy of which has a recompilation available (Game.metadata.recomp, written by
 * main/recomp when a catalog entry matches; the UP button beside Play).
 */
export function hasRecomp(group: Group): boolean {
  // Installed or not, and host-only games ready to download too (this PC matches those itself, main/streaming).
  return !!group.game.metadata.recomp || group.copies.some((c) => !!c.metadata.recomp)
}

/** Filters > Nucleus Co-Op: a card any copy of which has a Co-Op handler. */
export function hasCoop(group: Group): boolean {
  return !!group.game.metadata.coop || group.copies.some((c) => !!c.metadata.coop)
}

/**
 * Filters > Platform's systems and stores narrow the games before the same game's copies collapse into one card (lib/copies.ts), so
 * an Epic tab shows the Epic copy of a game owned on Epic and Steam.
 */
export function tabPoolOf(
  pool: readonly Game[],
  filters: Pick<TabCardFilters, 'platforms' | 'stores'>,
  kindOf: PlatformKindOf
): Game[] {
  if (filters.platforms.length === 0 && filters.stores.length === 0) return pool as Game[]
  const onPlatforms = new Set(filters.platforms)
  const inStores = new Set(filters.stores)
  return pool.filter(
    (g) => matchesPlatformFilter(g, onPlatforms, kindOf) && matchesStoreFilter(g, inStores, kindOf)
  )
}

/**
 * Every copy has its own card while searching or with Filters > Platform / PC on (so the PS2 and the Xbox copy can
 * both be found); otherwise one card per game.
 */
export function everyCopyOf(
  filters: Pick<TabCardFilters, 'query' | 'platforms' | 'stores'>
): boolean {
  return filters.query.trim() !== '' || filters.platforms.length > 0 || filters.stores.length > 0
}

/** The cards of a tab's games (tabPoolOf), before the other filters. */
export function tabGroupsOf(
  tabPool: readonly Game[],
  everyCopy: boolean,
  showDuplicates: boolean
): CopyGroup[] {
  return everyCopy
    ? tabPool.map((game) => ({ game, copies: [game] }))
    : collapseWithRemote(tabPool, { showDuplicates })
}

/**
 * The cards the rest of the filters keep (search, Genre, developers / publishers, Favorites, Local and Online
 * Multiplayer, Recompilations, Release, Size, H.L.T.B., Difficulty, Reviews, Controls), with each card's size, release time and
 * players online now and review score (its own copy's, else another copy's) for the sort.
 */
export function filterTabGroups<G extends Group>(
  tabGroups: readonly G[],
  tabPool: readonly Game[],
  filters: TabCardFilters
): {
  kept: G[]
  sizeOfGroup: Map<string, number | undefined>
  releaseOfGroup: Map<string, number | undefined>
  playersOfGroup: Map<string, number | undefined>
  reviewsOfGroup: Map<string, ReviewValue | undefined>
  difficultyOfGroup: Map<string, EffectiveDifficulty>
  hltbOfGroup: Map<string, number | undefined>
} {
  // Filters > Size: by the card's size (lib/installSize.ts): its own copy's, else the first other copy's that is known,
  // as the search and genre filters keep a card when any copy matches. A game of unknown size has no band. Several
  // bands picked: a game in any of them.
  const sizes = new Set(filters.sizes)
  const sizeOfGroup = new Map<string, number | undefined>()
  for (const group of tabGroups) {
    let bytes = installSizeBytes(group.game)
    for (const copy of group.copies) bytes ??= installSizeBytes(copy)
    sizeOfGroup.set(group.game.id, bytes)
  }
  // Sort > Release Date: by the card's release date, its own copy's else another copy's, like Size.
  const releaseOfGroup = new Map<string, number | undefined>()
  for (const group of tabGroups) {
    let t = releaseTime(group.game)
    for (const copy of group.copies) t ??= releaseTime(copy)
    releaseOfGroup.set(group.game.id, t)
  }
  // Sort > Active Players: the card's players online now, its own copy's else another copy's (a card shown as its Epic
  // copy counts with its Steam copy's count), like Size.
  const playersOfGroup = new Map<string, number | undefined>()
  for (const group of tabGroups) {
    let n = activePlayersOf(group.game)
    for (const copy of group.copies) n ??= activePlayersOf(copy)
    playersOfGroup.set(group.game.id, n)
  }
  // Sort > Reviews: the card's review score (and that game's review count), its own copy's else another copy's, like
  // the Reviews filter below.
  const reviewsOfGroup = new Map<string, ReviewValue | undefined>()
  for (const group of tabGroups) {
    let review = reviewValueOf(group.game.metadata)
    for (const copy of group.copies) review ??= reviewValueOf(copy.metadata)
    reviewsOfGroup.set(group.game.id, review)
  }
  // Filters > H.L.T.B.: by the card's HowLongToBeat time (lib/hltb.ts), its own copy's else another copy's, like Size.
  const hltbBands = new Set(filters.hltb)
  // Filters > Controls: a card any copy of which is played the way picked (lib/controls.ts).
  const controls = new Set(filters.controls)
  const players = filters.players
  const lanParty = filters.lanParty
  const matchesPlayers = (copy: Game, id: string): boolean =>
    id === LAN_PARTY.id ? !!lanParty?.has(copy.id) : matchesLocalMultiplayer(copy, id)
  const online = filters.online
  // Sort > H.L.T.B. sorts by the same time (hltbOfGroup, returned).
  const hltbOfGroup = new Map<string, number | undefined>()
  for (const group of tabGroups) {
    let hours = hltbHours(group.game)
    for (const copy of group.copies) hours ??= hltbHours(copy)
    hltbOfGroup.set(group.game.id, hours)
  }
  // Filters > Difficulty: by the card's level (shared/difficulty.ts): its own copy's pick, else another copy's, like
  // H.L.T.B.; without a pick, the level a Steam tag gives (Visual Novel, Casual, Free to Play, Relaxing,
  // Souls-like, Difficult; own copy first); else Medium, so every card is under exactly one level. A card Steam tags
  // Utilities (and nobody picked a level for) is N/A (Tools): under no level, so it only shows with none picked.
  // Sort > Difficulty sorts by the same level (difficultyOfGroup, returned).
  const levels = new Set(filters.difficulty ?? [])
  const difficultyOf = (group: Group): EffectiveDifficulty => {
    let level: EffectiveDifficulty | undefined = pickedDifficulty(group.game)
    for (const copy of group.copies) level ??= pickedDifficulty(copy)
    level ??= tagDifficulty(group.game)?.level
    for (const copy of group.copies) level ??= tagDifficulty(copy)?.level
    return level ?? DEFAULT_DIFFICULTY
  }
  const difficultyOfGroup = new Map<string, EffectiveDifficulty>()
  for (const group of tabGroups) difficultyOfGroup.set(group.game.id, difficultyOf(group))
  const inLevels = (group: Group): boolean => {
    const level = difficultyOfGroup.get(group.game.id) ?? difficultyOf(group)
    return !isToolsDifficulty(level) && levels.has(level)
  }
  // Filters > Reviews: by the card's review score as its game page shows it (lib/reviews.ts reviewScoreOf), its own
  // copy's else another copy's, like H.L.T.B. A game without a score is in no band.
  const reviewBands = new Set(filters.reviews ?? [])
  const reviewOfGroup = (group: Group): number | undefined => {
    let score = reviewScoreOf(group.game.metadata)
    for (const copy of group.copies) score ??= reviewScoreOf(copy.metadata)
    return score
  }
  // Filters > Release: a card with a copy released in any of the ranges picked (lib/releaseEras.ts), as Genre and
  // PC keep a card when any copy matches, so every range the menu lists (from every copy) shows a game. A game
  // whose year is unknown has no range.
  const eras = new Set(filters.eras)
  const inEras = (group: Group): boolean =>
    [group.game, ...group.copies].some((copy) => eras.has(releaseEraOf(releaseYear(copy)) ?? ''))
  // Filters > Genre / Tags: a game with any of the genres picked, and any of the tags picked (its Steam tags).
  const filtered = filters.query !== '' || filters.genres.length > 0 || filters.tags.length > 0
  const matching = filtered
    ? new Set(
        filterLibrary(tabPool, {
          tab: LIBRARY_ALL_TAB,
          query: filters.query,
          genres: filters.genres,
          tags: filters.tags
        }).map((g) => g.id)
      )
    : null
  // A game page's developer / publisher buttons: a card any copy of which names one of them (case-insensitive).
  const developers = filters.developers ?? []
  const publishers = filters.publishers ?? []
  // Filters > Custom: a card any copy of which is in any of the user's filters picked.
  const inCustom = customGameIds(filters.customFilters, filters.custom ?? [])
  const kept = tabGroups.filter(
    (g) =>
      (!matching || g.copies.some((c) => matching.has(c.id))) &&
      (!inCustom || inCustom.has(g.game.id) || g.copies.some((c) => inCustom.has(c.id))) &&
      matchesCreators([g.game, ...g.copies], developers, publishers) &&
      (!filters.favorites || g.game.favorite) &&
      // Filters > Local Multiplayer: any of its choices (player counts, all local multiplayer, Nucleus Co-Op).
      ((players.length === 0 && !filters.coop) ||
        (filters.coop && hasCoop(g)) ||
        [g.game, ...g.copies].some((copy) => players.some((id) => matchesPlayers(copy, id)))) &&
      // Filters > Online Multiplayer: any of its choices (Steam tags).
      (online.length === 0 ||
        [g.game, ...g.copies].some((copy) =>
          online.some((id) => matchesOnlineMultiplayer(copy, id))
        )) &&
      (!filters.recomp || hasRecomp(g)) &&
      (eras.size === 0 || inEras(g)) &&
      (sizes.size === 0 || sizes.has(sizeBucketOf(sizeOfGroup.get(g.game.id)) ?? '')) &&
      (hltbBands.size === 0 || hltbBands.has(hltbBucketOf(hltbOfGroup.get(g.game.id)) ?? '')) &&
      (levels.size === 0 || inLevels(g)) &&
      (reviewBands.size === 0 || reviewBands.has(reviewBandOf(reviewOfGroup(g)) ?? '')) &&
      (controls.size === 0 ||
        [g.game, ...g.copies].some((copy) =>
          controlsFilterIds(copy).some((id) => controls.has(id))
        ))
  )
  return {
    kept,
    sizeOfGroup,
    releaseOfGroup,
    playersOfGroup,
    reviewsOfGroup,
    difficultyOfGroup,
    hltbOfGroup
  }
}

/** What the Library's games come from: this PC's games, the paired hosts' and the Library settings. */
export interface LibrarySources {
  games: Game[]
  remote: RemoteLibrary | null | undefined
  platformsById: ReadonlyMap<string, Platform>
  showUninstalled: boolean
  showHidden: boolean
  showHostGames: boolean
  showDuplicates: boolean
}

/**
 * Whether the Library, on a tab with these filters, shows the card of game `gameId` (that copy's card, or the card
 * standing for it): the grid's own filtering, Show hidden / uninstalled games and Filters > Hidden included. A
 * search in `filters` counts too.
 */
export function tabShowsGame(
  gameId: string,
  sources: LibrarySources,
  filters: TabCardFilters
): boolean {
  const visibility = {
    library: { showUninstalled: sources.showUninstalled, showHidden: sources.showHidden }
  }
  const pool = filters.hidden
    ? hiddenGames(sources.games, visibility)
    : withRemoteGames(
        visibleGames(sources.games, visibility),
        hostGamesShown(sources.games, sources.remote, sources.showHostGames)
      )
  const kindOf = platformKindOf(sources.platformsById)
  const tabPool = tabPoolOf(pool, filters, kindOf)
  if (!tabPool.some((g) => g.id === gameId)) return false
  const groups = tabGroupsOf(tabPool, everyCopyOf(filters), sources.showDuplicates)
  const { kept } = filterTabGroups(groups, tabPool, filters)
  return kept.some((g) => g.game.id === gameId || g.copies.some((c) => c.id === gameId))
}
