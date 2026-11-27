import { difficultyLabel, isDifficultyId } from '@shared/difficulty'
import type { LibrarySortId, LibraryTabDef, LibraryTabFilters, Platform } from '@shared/types'
import { t, useLanguageStore } from '../i18n'
import { controlsFilterLabel } from './controls'
import { knownLocalMultiplayerIds, localMultiplayerLabel } from './localMultiplayer'
import { knownOnlineMultiplayerIds, onlineMultiplayerLabel } from './onlineMultiplayer'
import { HLTB_BUCKETS } from './hltb'
import { isReviewBandId, reviewBandLabel } from './reviews'
import { SIZE_BUCKETS } from './installSize'
import {
  LIBRARY_ALL_TAB,
  LIBRARY_OTHER_TAB,
  LIBRARY_SETTINGS_TAB,
  tabLabel,
  type LibraryTab
} from './libraryView'
import { currentEraIds, releaseEraLabel } from './releaseEras'
import { tagFilterLabel, genreFilterFor } from './steamTags'
import { ALL_ROM_PLATFORMS, ALL_ROM_PLATFORMS_LABEL } from './platformFilters'
import { isStoreFilter, storeFilterLabel } from './storeFilters'

/**
 * The Library's tabs as the user keeps them (Settings > Library; settings.ui.libraryTabs): each its filters and sort.
 * Pure helpers: names, defaults, the first run's tabs made from the platform tabs of earlier versions, and the
 * recommended tabs.
 */

/** Most tabs kept (settings-schema.ts MAX_LIBRARY_TABS): "+" and Add tab do nothing past it. */
export const MAX_LIBRARY_TABS_UI = 40

/** A new tab's sort order (Title A–Z), with the playable-first button on. */
export const DEFAULT_TAB_SORT: LibrarySortId = 'title-asc'

export function emptyTabFilters(): LibraryTabFilters {
  return {
    platforms: [],
    stores: [],
    genres: [],
    eras: [],
    tags: [],
    sizes: [],
    hltb: [],
    controls: [],
    players: [],
    online: [],
    hidden: false,
    favorites: false,
    coop: false,
    recomp: false
    // No `developers` / `publishers` / `difficulty` / `reviews`: absent is none (left out of a saved tab while empty,
    // tabFiltersOf).
  }
}

/** Most names one developer / publisher list keeps (settings-schema.ts: 100 choices per list). */
export const MAX_CREATOR_NAMES = 100

/**
 * Developer / publisher names as a tab keeps them: trimmed, none empty, each once (case-insensitive, the first
 * spelling kept), at most MAX_CREATOR_NAMES of up to 200 characters.
 */
export function creatorNames(names: readonly string[] | undefined): string[] {
  const out: string[] = []
  for (const raw of names ?? []) {
    const name = typeof raw === 'string' ? raw.trim().slice(0, 200) : ''
    if (name && !out.some((n) => sameName(n, name))) out.push(name)
    if (out.length >= MAX_CREATOR_NAMES) break
  }
  return out
}

/** Whether a developer / publisher list holds this name (case-insensitive). */
export function hasName(names: readonly string[] | undefined, name: string): boolean {
  return !!name.trim() && (names ?? []).some((n) => sameName(n, name))
}

/** `names` with `name` added, or removed when it is there already (case-insensitive). */
export function toggleName(names: readonly string[] | undefined, name: string): string[] {
  const list = creatorNames(names)
  if (hasName(list, name)) return list.filter((n) => !sameName(n, name))
  return creatorNames([...list, name])
}

/**
 * A game page's developer / publisher filter: whether a card (any of its copies) is by one of the developers picked
 * (any one: names in one list are OR, as Genre's choices are) and by one of the publishers picked; both case-
 * insensitive, an empty list keeps every game.
 */
export function matchesCreators(
  copies: readonly {
    metadata: { developers?: readonly string[]; publishers?: readonly string[] }
  }[],
  developers: readonly string[],
  publishers: readonly string[]
): boolean {
  if (developers.length === 0 && publishers.length === 0) return true
  const anyOf = (names: readonly string[] | undefined, wanted: readonly string[]): boolean =>
    wanted.length === 0 || (names ?? []).some((n) => wanted.some((w) => sameName(n, w)))
  return copies.some(
    (copy) =>
      anyOf(copy.metadata.developers, developers) && anyOf(copy.metadata.publishers, publishers)
  )
}

/**
 * A choice a game page adds to the Library's current tab and Filters > Clear filters lists: a developer, a publisher
 * (by name), or a genre / Steam tag (by its Genre filter id, lib/steamTags.ts: the tab's `tags`).
 */
export type TabChoice =
  { kind: 'developer' | 'publisher'; name: string } | { kind: 'genre'; id: string }

/** The lists of a tab's filters a TabChoice is in. */
interface ChoiceLists {
  /** Absent: none (a saved tab leaves an empty list out). */
  developers?: readonly string[]
  publishers?: readonly string[]
  tags: readonly string[]
}

/** A change to those lists (each a fresh list). */
type ChoicePatch = Partial<Pick<LibraryTabFilters, 'developers' | 'publishers' | 'tags'>>

/** Whether a tab's filters hold this choice (the game page's button or chip shows it is on). */
export function hasTabChoice(filters: ChoiceLists | null, choice: TabChoice): boolean {
  if (!filters) return false
  if (choice.kind === 'genre') return filters.tags.includes(choice.id)
  return hasName(choice.kind === 'developer' ? filters.developers : filters.publishers, choice.name)
}

/** The filter change that adds the choice to `filters`, or removes it when they hold it already. */
export function toggledChoice(filters: ChoiceLists, choice: TabChoice): ChoicePatch {
  if (choice.kind === 'genre')
    return {
      tags: filters.tags.includes(choice.id)
        ? filters.tags.filter((id) => id !== choice.id)
        : [...filters.tags, choice.id]
    }
  return choice.kind === 'developer'
    ? { developers: toggleName(filters.developers, choice.name) }
    : { publishers: toggleName(filters.publishers, choice.name) }
}

/** The filter change that removes one choice (Filters > Clear filters' row for it); nothing when it is not on. */
export function withoutChoice(filters: ChoiceLists, choice: TabChoice): ChoicePatch {
  return hasTabChoice(filters, choice) ? toggledChoice(filters, choice) : {}
}

/** A developer, publisher or genre / tag a tab's filters hold: a row of Filters > Clear filters. */
export interface ClearableChoice {
  choice: TabChoice
  /** The name shown ("FromSoftware", "RPG"). */
  label: string
  /** What it is, at the right of the row: "Developer", "Publisher", "Genre". */
  hint: string
  /** Unique within the list (the row's focus key). */
  key: string
}

/** The developers, publishers and genres / tags of a tab's filters, in that order (Filters > Clear filters' rows). */
export function clearableChoices(
  filters: ChoiceLists,
  tagLabel: (id: string) => string
): ClearableChoice[] {
  return [
    ...creatorNames(filters.developers).map((name) => ({
      choice: { kind: 'developer' as const, name },
      label: name,
      hint: t('lib.tabs.hint.developer'),
      key: `developer:${name.toLowerCase()}`
    })),
    ...creatorNames(filters.publishers).map((name) => ({
      choice: { kind: 'publisher' as const, name },
      label: name,
      hint: t('lib.tabs.hint.publisher'),
      key: `publisher:${name.toLowerCase()}`
    })),
    ...filters.tags.map((id) => ({
      choice: { kind: 'genre' as const, id },
      label: tagLabel(id),
      hint: t('lib.tabs.hint.genre'),
      key: `genre:${id}`
    }))
  ]
}

/** A tab's filters as saved before 0.9.42 may have them: one developer / publisher name instead of the lists. */
type LegacyCreatorFilters = { developer?: unknown; publisher?: unknown }

/** A saved single name (before 0.9.42) followed by the lists, as one list. */
function creatorsOf(list: readonly string[] | undefined, legacy: unknown): string[] {
  const one = typeof legacy === 'string' ? [legacy] : []
  return creatorNames([...one, ...(Array.isArray(list) ? list : [])])
}

let counter = 0
/** A fresh tab id: never one of the fixed ids (Settings), unique within a session and across sessions. */
export function newTabId(now = Date.now()): string {
  counter = (counter + 1) % 1_000_000
  return `t${now.toString(36)}${counter.toString(36)}`
}

/** A new tab: All Games (no filters) on Title A–Z with playable games first, or the filters and sort given. */
export function newTabDef(
  partial: {
    filters?: Partial<LibraryTabFilters>
    sort?: LibrarySortId
    sortReversed?: boolean
    playableFirst?: boolean
  } = {},
  id = newTabId()
): LibraryTabDef {
  return {
    id,
    filters: { ...emptyTabFilters(), ...partial.filters },
    sort: partial.sort ?? DEFAULT_TAB_SORT,
    sortReversed: partial.sortReversed ?? false,
    playableFirst: partial.playableFirst ?? true
  }
}

/**
 * A saved tab as this version reads it: the removed Playable First sort ('playable') becomes Recently played with the
 * playable-first button on (the same order; a reversed one, not-installed games first, has no match and loads
 * unreversed), and a tab saved before the button has it on. main reads settings.json
 * the same way (settings-schema.ts); this covers tabs that did not pass through it (the browser mock's saved ones).
 * The same object when nothing changes.
 */
export function migrateTabDef(def: LibraryTabDef): LibraryTabDef {
  // Saved before 0.9.42: one developer / publisher name, now a list of one. An empty (or malformed) list is left out
  // (tabFiltersOf), as an older PlayOut syncing tabs would refuse it.
  const filters = def.filters as LibraryTabFilters & LegacyCreatorFilters
  const unsaved = (list: unknown): boolean =>
    list !== undefined && (!Array.isArray(list) || list.length === 0)
  if (
    'developer' in filters ||
    'publisher' in filters ||
    unsaved(filters.developers) ||
    unsaved(filters.publishers) ||
    unsaved(filters.difficulty) ||
    unsaved(filters.reviews)
  )
    return migrateTabDef({ ...def, filters: tabFiltersOf(filters) })
  const sort = def.sort as string
  if (sort === 'playable')
    return { ...def, sort: 'recent', sortReversed: false, playableFirst: true }
  if (typeof def.playableFirst !== 'boolean') return { ...def, playableFirst: true }
  return def
}

/**
 * A tab as it is saved: an empty `developers` / `publishers` / `difficulty` / `reviews` list left out (an older PlayOut syncing
 * tabs refuses a key it does not know). The same object when there is none.
 */
export function savableTabDef(def: LibraryTabDef): LibraryTabDef {
  const { developers, publishers, difficulty, reviews } = def.filters
  const empty = (list: readonly string[] | undefined): boolean => !!list && list.length === 0
  if (!empty(developers) && !empty(publishers) && !empty(difficulty) && !empty(reviews)) return def
  const filters = { ...def.filters }
  if (empty(developers)) delete filters.developers
  if (empty(publishers)) delete filters.publishers
  if (empty(difficulty)) delete filters.difficulty
  if (empty(reviews)) delete filters.reviews
  return { ...def, filters }
}

/** The tabs as they are saved (savableTabDef); the same list when no tab changes. */
export function savableTabs(defs: LibraryTabDef[]): LibraryTabDef[] {
  const out = defs.map(savableTabDef)
  return out.every((d, i) => d === defs[i]) ? defs : out
}

/**
 * The filters of a tab, every list copied (a tab's filters are never shared with another's). A tab saved before
 * 0.9.42 with one `developer` / `publisher` name gets it as its list of one. `developers` / `publishers` are left out
 * while empty, so a tab without them is exactly what an older PlayOut accepts (the Library tabs sync with paired PCs);
 * readers take absent as [].
 */
export function tabFiltersOf(
  source: Partial<LibraryTabFilters> & LegacyCreatorFilters
): LibraryTabFilters {
  const base = emptyTabFilters()
  // Filters > Genre and Tags are one Genre filter since 0.1.185: a genre picked before counts as its choice (by name or
  // another spelling of it); one that is no choice any more goes.
  const tags = [...(source.tags ?? base.tags)]
  for (const genre of source.genres ?? []) {
    const id = genreFilterFor(genre)?.id
    if (id && !tags.includes(id)) tags.push(id)
  }
  const developers = creatorsOf(source.developers, source.developer)
  const publishers = creatorsOf(source.publishers, source.publisher)
  // Filters > Difficulty: its levels, each once (an id this version does not know goes).
  const difficulty = [...new Set((source.difficulty ?? []).filter(isDifficultyId))]
  // Filters > Reviews: its score bands, each once (an id this version does not know goes).
  const reviews = [...new Set((source.reviews ?? []).filter(isReviewBandId))]
  return {
    platforms: [...(source.platforms ?? base.platforms)],
    stores: [...(source.stores ?? base.stores)],
    genres: [],
    eras: currentEraIds(source.eras ?? base.eras),
    tags,
    sizes: [...(source.sizes ?? base.sizes)],
    hltb: [...(source.hltb ?? base.hltb)],
    ...(difficulty.length ? { difficulty } : {}),
    ...(reviews.length ? { reviews } : {}),
    controls: [...(source.controls ?? base.controls)],
    players: knownLocalMultiplayerIds(source.players ?? base.players),
    online: knownOnlineMultiplayerIds(source.online ?? base.online),
    hidden: source.hidden ?? false,
    favorites: source.favorites ?? false,
    coop: source.coop ?? false,
    recomp: source.recomp ?? false,
    ...(developers.length ? { developers } : {}),
    ...(publishers.length ? { publishers } : {})
  }
}

/** Whether two tabs' filters are the same choices (order inside a list ignored). */
export function sameTabFilters(a: LibraryTabFilters, b: LibraryTabFilters): boolean {
  const lists: (keyof LibraryTabFilters)[] = [
    'platforms',
    'stores',
    'genres',
    'eras',
    'tags',
    'sizes',
    'hltb',
    'controls',
    'players',
    'online'
  ]
  const same = (x: readonly string[], y: readonly string[]): boolean =>
    x.length === y.length && x.every((v) => y.includes(v))
  return (
    lists.every((k) => same(a[k] as string[], b[k] as string[])) &&
    same(a.difficulty ?? [], b.difficulty ?? []) &&
    same(a.reviews ?? [], b.reviews ?? []) &&
    a.hidden === b.hidden &&
    a.favorites === b.favorites &&
    !!a.coop === !!b.coop &&
    !!a.recomp === !!b.recomp &&
    sameNames(a.developers, b.developers) &&
    sameNames(a.publishers, b.publishers)
  )
}

/** Whether two developer / publisher lists hold the same names (case-insensitive, order ignored). */
function sameNames(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const x = creatorNames(a)
  const y = creatorNames(b)
  return x.length === y.length && x.every((n) => hasName(y, n))
}

/** Whether two developer / publisher names are the same one (case-insensitive; '' and absent are none). */
export function sameName(a: string | undefined, b: string | undefined): boolean {
  return (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase()
}

/**
 * The name All Games: a tab with no filters. In the language shown: reassigned when it changes, and an ES module's
 * importers read the new value.
 */
export let ALL_GAMES_NAME = t('lib.tabs.allGames')
useLanguageStore.subscribe(() => {
  ALL_GAMES_NAME = t('lib.tabs.allGames')
})

const sizeLabel = (id: string): string => SIZE_BUCKETS.find((b) => b.id === id)?.label ?? id
const hltbLabel = (id: string): string => HLTB_BUCKETS.find((b) => b.id === id)?.label ?? id

/**
 * A tab's name, from its filters: every active choice, the choices of one filter joined by "+" and the filters by
 * " · " ("Epic · RPG · 2020-2025", "Epic + G.O.G · RPG"); "All Games" with none. Platform first, then PC (stores),
 * Genre, Release, Tags, Size, H.L.T.B., Difficulty, Reviews, Co-Op, Recompilations, developer, publisher (a game page's buttons),
 * Favorites, Hidden.
 */
export function tabName(
  filters: LibraryTabFilters,
  platformLabel: (id: string) => string = (id) => id
): string {
  const parts = [
    filters.platforms.map(platformLabel),
    filters.stores.map(storeFilterLabel),
    filters.genres,
    filters.eras.map(releaseEraLabel),
    filters.tags.map(tagFilterLabel),
    filters.sizes.map(sizeLabel),
    filters.hltb.map(hltbLabel),
    (filters.difficulty ?? []).map(difficultyLabel),
    (filters.reviews ?? []).map(reviewBandLabel),
    (filters.controls ?? []).map(controlsFilterLabel),
    (filters.players ?? []).map(localMultiplayerLabel),
    (filters.online ?? []).map(onlineMultiplayerLabel),
    filters.coop ? [t('lib.tabs.coop')] : [],
    filters.recomp ? [t('lib.tabs.recomp')] : [],
    creatorNames(filters.developers),
    // A publisher that is also a developer picked is named once.
    creatorNames(filters.publishers).filter((name) => !hasName(filters.developers, name)),
    filters.favorites ? [t('lib.tabs.favorites')] : [],
    filters.hidden ? [t('lib.tabs.hidden')] : []
  ]
    .filter((list) => list.length > 0)
    .map((list) => list.join(' + '))
  return parts.length ? parts.join(' · ') : ALL_GAMES_NAME
}

/** The platform label tabName uses: its short name ("SNES"), as the strip showed platform tabs. */
export function platformLabelOf(
  platformsById: ReadonlyMap<string, Platform>
): (id: string) => string {
  return (id) => {
    if (id === ALL_ROM_PLATFORMS) return ALL_ROM_PLATFORMS_LABEL
    const platform = platformsById.get(id)
    return platform ? tabLabel(platform) : id
  }
}

/** The strip's tabs: Settings first, then the user's tabs, each named by its filters. */
export function stripTabs(
  defs: readonly LibraryTabDef[],
  platformLabel: (id: string) => string
): LibraryTab[] {
  return [
    { id: LIBRARY_SETTINGS_TAB, label: t('lib.tabs.settings') },
    ...defs.map((def) => ({ id: def.id, label: tabName(def.filters, platformLabel) }))
  ]
}

/**
 * The first run's tabs, made from the platform tabs of earlier versions (libraryView.libraryTabs) in their order:
 * All Games with no filters, a store's tab with Filters > Platform (below the line) on that store, a console's with Filters > Platform on it,
 * Other with Filters > Platform (below the line) on the stores folded into it and Filters > Platform on the other systems (two tabs when
 * it folded both). All on Title A–Z with playable games first. The All Games tab keeps the
 * id 'all', so a remembered position on it carries over.
 */
export function migrateTabs(tabs: readonly LibraryTab[]): LibraryTabDef[] {
  const out: LibraryTabDef[] = []
  for (const tab of tabs) {
    if (tab.id === LIBRARY_SETTINGS_TAB) continue
    if (tab.id === LIBRARY_ALL_TAB) out.push(newTabDef({}, LIBRARY_ALL_TAB))
    else if (tab.id === LIBRARY_OTHER_TAB) {
      // Other folded stores and systems alike: its stores go below Filters > Platform's line and its systems above it,
      // two tabs when it had both (the two filters narrow together, so one tab would show neither).
      const ids = tab.platformIds ?? []
      const stores = ids.filter((id) => isStoreFilter(id as never))
      const systems = ids.filter((id) => !isStoreFilter(id as never))
      if (stores.length)
        out.push(newTabDef({ filters: { stores } }, systems.length ? `${tab.id}-stores` : tab.id))
      if (systems.length) out.push(newTabDef({ filters: { platforms: systems } }, tab.id))
    } else if (tab.platform?.kind === 'store' && isStoreFilter(tab.id as never))
      out.push(newTabDef({ filters: { stores: [tab.id] } }, tab.id))
    else out.push(newTabDef({ filters: { platforms: [tab.id] } }, tab.id))
  }
  if (!out.some((d) => d.id === LIBRARY_ALL_TAB)) out.unshift(newTabDef({}, LIBRARY_ALL_TAB))
  return out
}

/** A tab Settings > Library recommends: what it is called and the tab it adds. */
export interface RecommendedTab {
  key: string
  name: string
  description: string
  filters: Partial<LibraryTabFilters>
  sort: LibrarySortId
  /** The playable-first button. */
  playableFirst: boolean
}

/** Settings > Library' recommended tabs (more to come). Names and descriptions are read in the language shown. */
export const RECOMMENDED_TABS: readonly RecommendedTab[] = [
  {
    key: 'all-games',
    get name() {
      return ALL_GAMES_NAME
    },
    get description() {
      return t('lib.tabs.recommended.allGames')
    },
    filters: {},
    sort: DEFAULT_TAB_SORT,
    playableFirst: true
  }
]

/**
 * Whether a recommended tab is already one of the tabs: a tab with the same filters (the same games), whatever its
 * sort and playable-first button, so an All Games tab saved on another sort (or migrated from Playable First) counts.
 */
export function hasRecommendedTab(defs: readonly LibraryTabDef[], tab: RecommendedTab): boolean {
  const filters = tabFiltersOf(tab.filters)
  return defs.some((d) => sameTabFilters(d.filters, filters))
}

/** `defs` with tab `id` moved `delta` places (clamped to the ends); the same list when it cannot move. */
export function moveTab(
  defs: readonly LibraryTabDef[],
  id: string,
  delta: number
): LibraryTabDef[] {
  const from = defs.findIndex((d) => d.id === id)
  if (from < 0) return [...defs]
  const to = Math.min(defs.length - 1, Math.max(0, from + delta))
  if (to === from) return [...defs]
  const next = [...defs]
  const [tab] = next.splice(from, 1)
  next.splice(to, 0, tab!)
  return next
}

/**
 * The tab that takes the place of a removed one: the next to its right, else the one to its left. undefined when
 * the removed tab was the only one.
 */
export function neighbourAfterRemoval(
  defs: readonly LibraryTabDef[],
  removedId: string
): string | undefined {
  const index = defs.findIndex((d) => d.id === removedId)
  if (index < 0) return defs[0]?.id
  return (defs[index + 1] ?? defs[index - 1])?.id
}
