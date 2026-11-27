import {
  DEFAULT_DIFFICULTY,
  DIFFICULTY_IDS,
  isToolsDifficulty,
  pickedDifficulty,
  tagDifficulty,
  type DifficultyId,
  type EffectiveDifficulty
} from '@shared/difficulty'
import { playableHere } from '@shared/recomp-play'
import { gameGenres } from '@shared/genres'
import type { Game, LibrarySortId, Platform } from '@shared/types'
import { currentLanguage, t } from '../i18n'
import { hltbHours } from './hltb'
import { installSizeBytes } from './installSize'
import { compareByTitle, displayTitle, type PlatformGroup } from './library'
import type { TabNamePart } from './libraryTabs'
import { hasTagFilter } from './steamTags'
import { releaseTime } from './releaseEras'
import { reviewValueOf, type ReviewValue } from './reviews'

/**
 * Pure selectors of the Library view (screens/Library): tabs, filters and sort orders. They never touch
 * stores or the API; the ui store (state/ui.ts) holds the filter values they are called with.
 */

/**
 * The Settings tab id: the first tab of the strip, left of All Games, holding the Settings menu
 * (screens/Library/SettingsTab.tsx). Not a platform tab: it never counts towards MAX_PLATFORM_TABS and shows
 * no header, search or grid.
 */
export const LIBRARY_SETTINGS_TAB = 'settings'

/** The All Games tab id; every other tab id but LIBRARY_SETTINGS_TAB and LIBRARY_OTHER_TAB is a platform id. */
export const LIBRARY_ALL_TAB = 'all'

/** The Other tab id: the platforms that did not get a tab of their own (LibraryTab.platformIds). */
export const LIBRARY_OTHER_TAB = 'other'

/**
 * Most platforms with a tab of their own. With more platform groups than this plus one, the strip shows
 * the MAX_PLATFORM_TABS largest groups and folds the rest into Other: eight tabs at most (Settings, All
 * Games, five platforms, Other), so the band never overflows at 1080p (the reference strip spans ~800u).
 */
export const MAX_PLATFORM_TABS = 5

/**
 * Most choices the Filters menu holds at once (genres, tags, stores, release dates, size and time bands, Hidden and
 * Favorites).
 */
export const MAX_FILTER_CHOICES = 3

/**
 * How many choices the Filters menu holds: Platform's systems and its stores one each when any is picked, every genre, tag, store, release date, size and time band picked, Hidden,
 * Favorites, and every developer and publisher a game page added (the pill's number; any of them shows Clear filters).
 * Developers and publishers do not count toward MAX_FILTER_CHOICES: limitedChoiceCount.
 */
export function filterChoiceCount(filters: FilterChoiceInput): number {
  return (
    limitedChoiceCount(filters) +
    (filters.developers?.length ?? 0) +
    (filters.publishers?.length ?? 0)
  )
}

/** The choices that count toward MAX_FILTER_CHOICES: filterChoiceCount without a game page's developers and publishers. */
export function limitedChoiceCount(filters: FilterChoiceInput): number {
  // Platform's systems and stores say what the tab is about (a migrated Other tab holds every system folded into it): each counts as
  // one choice however many are picked, so the other filters stay open on such a tab.
  return (
    Math.min(1, filters.platforms?.length ?? 0) +
    (filters.genres?.length ?? 0) +
    filters.tags.length +
    Math.min(1, filters.stores.length) +
    (filters.eras?.length ?? 0) +
    filters.sizes.length +
    filters.hltb.length +
    (filters.difficulty?.length ?? 0) +
    (filters.reviews?.length ?? 0) +
    (filters.controls?.length ?? 0) +
    (filters.players?.length ?? 0) +
    (filters.online?.length ?? 0) +
    Number(filters.hidden) +
    Number(filters.favorites) +
    Number(!!filters.coop) +
    Number(!!filters.recomp) +
    (filters.custom?.length ?? 0)
  )
}

/** The filters filterChoiceCount counts. */
interface FilterChoiceInput {
  platforms?: readonly string[]
  genres?: readonly string[]
  tags: readonly string[]
  stores: readonly string[]
  eras?: readonly string[]
  sizes: readonly string[]
  hltb: readonly string[]
  difficulty?: readonly string[]
  reviews?: readonly string[]
  controls?: readonly string[]
  players?: readonly string[]
  online?: readonly string[]
  hidden: boolean
  favorites: boolean
  coop?: boolean
  recomp?: boolean
  developers?: readonly string[]
  publishers?: readonly string[]
  /** Filters > Custom: the user's filters picked. */
  custom?: readonly string[]
}

/** A choice picked again is turned off; a new one is added (in the order picked). */
export function toggleChoice(list: readonly string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}

/**
 * A sort order in its own direction (the down arrow in the Sort menu): A to Z, most recent, most played, most players
 * online, best reviewed, largest, hardest, shortest to beat first. Picking the same order again reverses it
 * (LibraryFilters.sortReversed): Z to A ending with '#', oldest, least played, fewest players, worst reviewed, smallest,
 * easiest, longest to beat first.
 */
export type LibrarySort = LibrarySortId

/** The sort orders; labels are read in the language shown. The menu shows them alphabetically (librarySortOptions). */
export const LIBRARY_SORT_OPTIONS: readonly { value: LibrarySort; label: string }[] = [
  {
    value: 'title-asc',
    get label() {
      return t('lib.view.sort.title')
    }
  },
  {
    value: 'recent',
    get label() {
      return t('lib.view.sort.recent')
    }
  },
  {
    value: 'most-played',
    get label() {
      return t('lib.view.sort.mostPlayed')
    }
  },
  {
    value: 'players',
    get label() {
      return t('lib.view.sort.players')
    }
  },
  {
    value: 'reviews',
    get label() {
      return t('lib.view.sort.reviews')
    }
  },
  {
    value: 'added',
    get label() {
      return t('lib.view.sort.added')
    }
  },
  {
    value: 'release',
    get label() {
      return t('lib.view.sort.release')
    }
  },
  {
    value: 'size',
    get label() {
      return t('lib.view.sort.size')
    }
  },
  {
    value: 'difficulty',
    get label() {
      return t('lib.view.sort.difficulty')
    }
  },
  {
    value: 'hltb',
    get label() {
      return t('lib.view.sort.hltb')
    }
  }
]

/**
 * The Sort menu's options as the menu shows them: alphabetical by their label in the language shown (case and accents
 * ignored), so Spanish is in Spanish order too. Build it when the menu is drawn (it reads the language then).
 */
export function librarySortOptions(
  language: string = currentLanguage()
): { value: LibrarySort; label: string }[] {
  const collator = new Intl.Collator(language, { sensitivity: 'base' })
  return LIBRARY_SORT_OPTIONS.map((o) => ({ value: o.value, label: o.label })).sort((a, b) =>
    collator.compare(a.label, b.label)
  )
}

export interface LibraryTab {
  /** LIBRARY_SETTINGS_TAB, LIBRARY_ALL_TAB, LIBRARY_OTHER_TAB or a platform id. */
  id: string
  label: string
  platform?: Platform
  /** The Other tab only: the platform ids folded into it. */
  platformIds?: readonly string[]
  /**
   * A user's tab (lib/libraryTabs.ts stripTabs): its active choices, one list per filter (tabNameGroups), which the
   * strip draws as icons while Settings > Library "Icons for tabs" is on; [] for All Games.
   */
  groups?: readonly (readonly TabNamePart[])[]
}

/**
 * The tab strip label of a platform: its short name when it has one ('SNES', 'Epic'), else its name without
 * a trailing parenthetical ('Nintendo SNES (Super Nintendo)' -> 'Nintendo SNES'). Short labels keep the
 * strip within the reference's ~800u before it has to scroll.
 */
export function tabLabel(platform: Platform): string {
  const short = platform.shortName?.trim()
  if (short) return short
  const stripped = platform.name.replace(/\s*\([^)]*\)\s*$/, '').trim()
  return stripped.length > 0 ? stripped : platform.name
}

/**
 * 'Settings', 'All Games', then one tab per platform group, in group (platform sortOrder) order. With more
 * than MAX_PLATFORM_TABS + 1 groups, only the MAX_PLATFORM_TABS groups with the most games keep a tab (ties
 * go to the earlier group) and the rest are folded into a trailing Other tab.
 */
export function libraryTabs(groups: readonly PlatformGroup[]): LibraryTab[] {
  const tabs: LibraryTab[] = [
    { id: LIBRARY_SETTINGS_TAB, label: t('lib.tabs.settings') },
    { id: LIBRARY_ALL_TAB, label: t('lib.tabs.allGames') }
  ]
  let own: readonly PlatformGroup[] = groups
  let folded: readonly PlatformGroup[] = []
  if (groups.length > MAX_PLATFORM_TABS + 1) {
    const kept = new Set(
      groups
        .map((group, index) => ({ group, index }))
        .sort((a, b) => b.group.games.length - a.group.games.length || a.index - b.index)
        .slice(0, MAX_PLATFORM_TABS)
        .map((entry) => entry.group)
    )
    own = groups.filter((group) => kept.has(group))
    folded = groups.filter((group) => !kept.has(group))
  }
  for (const group of own) {
    tabs.push({ id: group.platform.id, label: tabLabel(group.platform), platform: group.platform })
  }
  if (folded.length > 0) {
    tabs.push({
      id: LIBRARY_OTHER_TAB,
      label: t('lib.view.other'),
      platformIds: folded.map((group) => group.platform.id)
    })
  }
  return tabs
}

/**
 * The tab `delta` steps from `current` in `tabs`, wrapping around the ends (LB on the first tab, Settings, goes to the
 * last; RB on the last goes to Settings). An unknown `current` counts as the first tab.
 */
export function stepTab(tabs: readonly LibraryTab[], current: string, delta: number): string {
  if (tabs.length === 0) return current
  const index = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === current)
  )
  const next = (((index + delta) % tabs.length) + tabs.length) % tabs.length
  return tabs[next]!.id
}

/** Every genre present in `games`, trimmed, de-duplicated case-insensitively and sorted. */
export function libraryGenres(games: readonly Game[]): string[] {
  const seen = new Map<string, string>()
  for (const game of games) {
    for (const genre of gameGenres(game)) {
      const trimmed = genre.trim()
      if (trimmed.length === 0) continue
      const key = trimmed.toLowerCase()
      if (!seen.has(key)) seen.set(key, trimmed)
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b))
}

function normalize(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}

export interface LibraryFilterInput {
  /** LIBRARY_ALL_TAB, LIBRARY_OTHER_TAB or a platform id (the Settings tab has no games to filter). */
  tab: string
  /** The platform ids of the Other tab (LibraryTab.platformIds); nothing matches that tab without them. */
  folded?: readonly string[]
  query: string
  /** The genres a game must have one of (case-insensitive); empty = any genre. */
  genres: readonly string[]
  /** Filters > Tags: the TAG_FILTERS ids a game must have one of (lib/steamTags.ts); empty or absent = any. */
  tags?: readonly string[]
  /** Filters > Platform, below the line: the stores (source ids) a game must be from one of; empty or absent = any. */
  stores?: readonly string[]
}

/**
 * The games of a tab (a platform, or any of the folded platforms for Other) that match the query (every
 * word found in the title, a genre, a Steam tag or a developer, case- and accent-insensitive) and the genres (any one of
 * them, case-insensitive) the tags and the stores (any one of each). Order is preserved.
 */
export function filterLibrary(games: readonly Game[], filters: LibraryFilterInput): Game[] {
  const words = normalize(filters.query).split(/\s+/).filter(Boolean)
  const wanted = filters.genres.length
    ? new Set(filters.genres.map((g) => g.trim().toLowerCase()))
    : null
  const folded = filters.tab === LIBRARY_OTHER_TAB ? new Set(filters.folded ?? []) : null
  const out: Game[] = []
  for (const game of games) {
    if (folded) {
      if (!folded.has(game.platformId)) continue
    } else if (filters.tab !== LIBRARY_ALL_TAB && game.platformId !== filters.tab) continue
    const genres = gameGenres(game)
    if (wanted && !genres.some((g) => wanted.has(g.trim().toLowerCase()))) continue
    if (filters.tags?.length && !hasTagFilter(game, filters.tags)) continue
    if (filters.stores?.length && !filters.stores.includes(game.source)) continue
    if (words.length > 0) {
      const haystacks = [
        displayTitle(game),
        game.title,
        ...genres,
        ...(game.metadata.steamTags?.tags ?? []),
        ...(game.metadata.developers ?? [])
      ].map(normalize)
      if (!words.every((w) => haystacks.some((h) => h.includes(w)))) continue
    }
    out.push(game)
  }
  return out
}

function time(iso: string | undefined): number {
  if (!iso) return 0
  const t = Date.parse(iso)
  return Number.isNaN(t) ? 0 : t
}

function totalPlaytime(game: Game): number {
  return game.playtimeMinutes + (game.storePlaytimeMinutes ?? 0)
}

/** A game's size for the Install size sort; the Library passes one that also looks at the card's other copies. */
export type SizeOf = (game: Game) => number | undefined

/** When a game came out, for the Release Date sort (lib/releaseEras.ts releaseTime); the Library's looks at copies too. */
export type ReleaseOf = (game: Game) => number | undefined

/** A game's players online now for the Active Players sort; the Library's looks at the card's other copies too. */
export type PlayersOf = (game: Game) => number | undefined

/** A game's level for the Difficulty sort; the Library's looks at the card's other copies too (gameDifficultyOf). */
export type DifficultyOf = (game: Game) => EffectiveDifficulty

/**
 * A game's level as Filters > Difficulty sees it (shared/difficulty.ts): the user's or the cloud's pick, else the level
 * a Steam tag gives it (or N/A (Tools) for a Utilities game), else Medium. The Library passes one that looks at the
 * card's other copies the way the filter does (lib/libraryFilter.ts difficultyOfGroup).
 */
export function gameDifficultyOf(game: Game): EffectiveDifficulty {
  return pickedDifficulty(game) ?? tagDifficulty(game)?.level ?? DEFAULT_DIFFICULTY
}

/** Hardest first: Impossible 0 ... Story 4. N/A (Tools) is no level: the Difficulty sort keeps it last both ways. */
function hardestRank(level: DifficultyId): number {
  return DIFFICULTY_IDS.length - 1 - DIFFICULTY_IDS.indexOf(level)
}

/**
 * The Difficulty sort: hardest first (easiest first when `easiestFirst`), alphabetical within a level, the N/A (Tools)
 * games after every level either way (alphabetical among themselves).
 */
function byDifficulty(of: DifficultyOf, easiestFirst: boolean): (a: Game, b: Game) => number {
  return (a, b) => {
    const la = of(a)
    const lb = of(b)
    if (isToolsDifficulty(la) || isToolsDifficulty(lb))
      return Number(isToolsDifficulty(la)) - Number(isToolsDifficulty(lb)) || compareByTitle(a, b)
    const diff = hardestRank(la) - hardestRank(lb)
    return (easiestFirst ? -diff : diff) || compareByTitle(a, b)
  }
}

/**
 * The players online now (the Active Players sort): SteamCharts' latest count or Steam's own, whichever is newer
 * (main scrapers/active-players.ts, refreshed while that sort is shown). Undefined: no count (not a Steam game, not
 * read yet, or a game SteamCharts does not track).
 */
export function activePlayersOf(game: Game): number | undefined {
  const count = game.metadata.currentPlayers?.count
  return typeof count === 'number' && Number.isFinite(count) && count >= 0 ? count : undefined
}

/**
 * A game's HowLongToBeat time in hours for the H.L.T.B. sort (lib/hltb.ts hltbHours, the H.L.T.B. filter's time);
 * the Library's looks at the card's other copies too (lib/libraryFilter.ts hltbOfGroup). Undefined: no time (not
 * looked up yet, or HLTB has none).
 */
export type HltbOf = (game: Game) => number | undefined

/** Shortest first, alphabetical on a tie; games without a time after every timed one. */
function shortestFirst(of: HltbOf): (a: Game, b: Game) => number {
  return (a, b) => {
    const va = of(a)
    const vb = of(b)
    if (va === undefined || vb === undefined)
      return Number(va === undefined) - Number(vb === undefined) || compareByTitle(a, b)
    return va - vb || compareByTitle(a, b)
  }
}

/** A game's review score (and its review count) for the Reviews sort; the Library's looks at the card's other copies too. */
export type ReviewsOf = (game: Game) => ReviewValue | undefined

/** The review score a game page shows, with its review count (lib/reviews.ts reviewValueOf), for the Reviews sort. */
export function gameReviewOf(game: Game): ReviewValue | undefined {
  return reviewValueOf(game.metadata)
}

/**
 * Best reviewed first: the highest score, then (same score) the most reviews, then alphabetical; games without a
 * score after every scored one (sortedBy keeps them last when reversed too).
 */
function bestReviewedFirst(of: ReviewsOf): (a: Game, b: Game) => number {
  return (a, b) => {
    const va = of(a)
    const vb = of(b)
    if (va === undefined || vb === undefined)
      return Number(va === undefined) - Number(vb === undefined) || compareByTitle(a, b)
    return vb.score - va.score || vb.count - va.count || compareByTitle(a, b)
  }
}

/** Newest (or largest) first, with unknown values after every known one. */
function knownFirst(of: (game: Game) => number | undefined): (a: Game, b: Game) => number {
  return (a, b) => {
    const va = of(a)
    const vb = of(b)
    if (va === undefined || vb === undefined)
      return Number(va === undefined) - Number(vb === undefined) || compareByTitle(a, b)
    return vb - va || compareByTitle(a, b)
  }
}

/** Comparator for a sort order; every order falls back to the alphabetical comparator so results are stable. */
export function libraryComparator(
  sort: LibrarySort,
  sizeOf: SizeOf = installSizeBytes,
  releaseOf: ReleaseOf = releaseTime,
  playersOf: PlayersOf = activePlayersOf,
  reviewsOf: ReviewsOf = gameReviewOf,
  difficultyOf: DifficultyOf = gameDifficultyOf,
  hltbOf: HltbOf = hltbHours
): (a: Game, b: Game) => number {
  switch (sort) {
    case 'recent':
      return (a, b) => time(b.lastPlayed) - time(a.lastPlayed) || compareByTitle(a, b)
    case 'title-asc':
      return compareByTitle
    case 'most-played':
      return (a, b) => totalPlaytime(b) - totalPlaytime(a) || compareByTitle(a, b)
    case 'added':
      return (a, b) => time(b.addedAt) - time(a.addedAt) || compareByTitle(a, b)
    case 'release':
      // Newest first; games without a release date after every dated one (kept last when reversed too).
      return knownFirst(releaseOf)
    case 'size':
      // Largest first; games of unknown size after every known one (sortLibrary keeps them last when reversed).
      return knownFirst(sizeOf)
    case 'players':
      // Most players first; games without a count after every counted one (kept last when reversed too).
      return knownFirst(playersOf)
    case 'reviews':
      // Highest score first (more reviews first on a tie); games without a score last (kept last when reversed too).
      return bestReviewedFirst(reviewsOf)
    case 'difficulty':
      // Hardest first (Impossible ... Story), alphabetical within a level (reversed: Story first, still A to Z);
      // N/A (Tools) last (kept last when reversed too).
      return byDifficulty(difficultyOf, false)
    case 'hltb':
      // Shortest first, alphabetical on a tie; games without a time last (kept last when reversed too).
      return shortestFirst(hltbOf)
  }
}

/**
 * Whether a card is playable on this PC now, for the Library's playable-first button: installed here (what the old
 * Playable First sort put first). A host's game (installed false until downloaded) is not.
 */
export function isPlayable(game: Game): boolean {
  // A ROM game whose file is gone but whose recompilation is installed plays it (shared/recomp-play).
  return playableHere(game)
}

/** `games` with the playable ones (isPlayable) moved before the rest, each part keeping its order. */
export function playableFirstOrder(games: readonly Game[]): Game[] {
  const playable: Game[] = []
  const rest: Game[] = []
  for (const game of games) (isPlayable(game) ? playable : rest).push(game)
  return [...playable, ...rest]
}

/**
 * A sorted copy of `games`; `reversed` turns the whole order around. Games of unknown size (Install size), without a
 * release date (Release Date), without a player count (Active Players), without a review score (Reviews) or without a
 * HowLongToBeat time (H.L.T.B.) stay last either way (alphabetical among themselves): reversed means smallest, oldest,
 * fewest players, lowest score or longest first, not unknown first. `playableFirst` (the Library's playable-first button) puts the playable games
 * (isPlayable) before the rest, each part in the sort's own order and direction, unknown values last within it.
 */
export function sortLibrary(
  games: readonly Game[],
  sort: LibrarySort,
  reversed = false,
  sizeOf: SizeOf = installSizeBytes,
  releaseOf: ReleaseOf = releaseTime,
  playableFirst = false,
  playersOf: PlayersOf = activePlayersOf,
  reviewsOf: ReviewsOf = gameReviewOf,
  difficultyOf: DifficultyOf = gameDifficultyOf,
  hltbOf: HltbOf = hltbHours
): Game[] {
  const sorted = sortedBy(
    games,
    sort,
    reversed,
    sizeOf,
    releaseOf,
    playersOf,
    reviewsOf,
    difficultyOf,
    hltbOf
  )
  return playableFirst ? playableFirstOrder(sorted) : sorted
}

function sortedBy(
  games: readonly Game[],
  sort: LibrarySort,
  reversed: boolean,
  sizeOf: SizeOf,
  releaseOf: ReleaseOf,
  playersOf: PlayersOf,
  reviewsOf: ReviewsOf,
  difficultyOf: DifficultyOf,
  hltbOf: HltbOf
): Game[] {
  const compare = libraryComparator(
    sort,
    sizeOf,
    releaseOf,
    playersOf,
    reviewsOf,
    difficultyOf,
    hltbOf
  )
  if (!reversed) return [...games].sort(compare)
  if (sort === 'difficulty')
    // Easiest first, each level still alphabetical; N/A (Tools) games stay last (alphabetical).
    return [...games].sort(byDifficulty(difficultyOf, true))
  if (sort === 'hltb') {
    // Longest first, still alphabetical on a tie; games without a time stay last (alphabetical).
    const known = games.filter((g) => hltbOf(g) !== undefined)
    const unknown = games.filter((g) => hltbOf(g) === undefined)
    return [
      ...known.sort((a, b) => hltbOf(b)! - hltbOf(a)! || compareByTitle(a, b)),
      ...unknown.sort(compareByTitle)
    ]
  }
  const valueOf: ((game: Game) => unknown) | null =
    sort === 'size'
      ? sizeOf
      : sort === 'release'
        ? releaseOf
        : sort === 'players'
          ? playersOf
          : sort === 'reviews'
            ? reviewsOf
            : null
  if (!valueOf) return [...games].sort((a, b) => compare(b, a))
  const known = games.filter((g) => valueOf(g) !== undefined)
  const unknown = games.filter((g) => valueOf(g) === undefined)
  return [...known.sort((a, b) => compare(b, a)), ...unknown.sort(compareByTitle)]
}

/** The number of grid columns that fit `width` (px, the viewport minus its side insets): at most `max`, at least 1. */
export function gridColumns(width: number, cardWidth: number, gap: number, max = 6): number {
  if (!(cardWidth > 0) || !(width > 0)) return max
  return Math.max(1, Math.min(max, Math.floor((width + gap) / (cardWidth + gap))))
}
