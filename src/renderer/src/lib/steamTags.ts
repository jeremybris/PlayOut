import { gameGenres } from '@shared/genres'
import type { Game, GameMetadata } from '@shared/types'
import { t } from '../i18n'

/** Most Steam tags shown on a game's page (the strongest; narrow screens show fewer, detail.css). */
export const DETAIL_TAG_COUNT = 4 // detailChips: at most this many Steam tags, and one chip more in all

/** A game's Steam user tags, strongest first ([] until they have been read). */
export function steamTagsOf(meta: Pick<GameMetadata, 'steamTags'>): string[] {
  return meta.steamTags?.tags ?? []
}

/**
 * One choice of Filters > Genre: a label, the Steam tags and the genres (both case-insensitive) that count as it. A
 * genre of the same name always counts; `genres` adds the other spellings the scrapers give it ("Role-playing (RPG)").
 */
export interface TagFilter {
  id: string
  /**
   * The choice's English name: what it is matched by and what the Edit sheet writes into a game's genres. Data, never
   * translated.
   */
  name: string
  /** The name shown, in the language shown (tagFilterLabel). */
  label: string
  steamTags: readonly string[]
  genres: readonly string[]
}

const tag = (name: string, ...steamTags: string[]): TagFilter => {
  const id = name.toLowerCase()
  return {
    id,
    name,
    get label() {
      return tagFilterLabel(id)
    },
    steamTags: steamTags.length ? steamTags : [name],
    genres: [name, ...steamTags, ...(GENRE_ALIASES[name] ?? [])]
  }
}

/** Other genre spellings that count as a choice (the user's picks, 0.1.185). */
const GENRE_ALIASES: Record<string, readonly string[]> = {
  RPG: ['Role-Playing', 'Role-playing (RPG)'],
  RTS: ['Real Time Strategy (RTS)'],
  Sports: ['Sport'],
  Simulation: ['Simulator'],
  Flight: ['Flight Simulator'],
  Platformer: ['Platform'],
  Driving: ['Vehicle Simulation']
}

/**
 * The tags Filters > Tags offers (chosen by the user; Steam has hundreds), by Steam's spelling.
 * Science Fiction is Steam's "Sci-fi".
 */
export const TAG_FILTERS: readonly TagFilter[] = [
  tag('2D'),
  tag('Action'),
  tag('Action RPG'),
  tag('Adventure'),
  tag('Anime'),
  tag('Board Game'),
  tag('Building'),
  tag('Casual'),
  tag('Choices Matter'),
  tag('Choose Your Own Adventure'),
  tag('City Builder'),
  tag('Classic'),
  tag('Destruction'),
  tag('Detective'),
  tag('Difficult'),
  tag('Driving'),
  tag('Exploration'),
  tag('Family Friendly'),
  tag('Fantasy'),
  tag('Fast-Paced'),
  tag('Flight'),
  tag('FPS'),
  tag('Free to Play'),
  tag('Funny'),
  tag('Futuristic'),
  tag('Hidden Object'),
  tag('Historical'),
  tag('Horror'),
  tag('Immersive Sim'),
  tag('JRPG'),
  tag('Logic'),
  tag('Management'),
  tag('Massively Multiplayer'),
  tag('Metroidvania'),
  tag('Minimalist'),
  tag('Mystery'),
  tag('Open World'),
  tag('Parkour'),
  tag('Physics'),
  tag('Pixel Graphics'),
  tag('Platformer'),
  tag('Point & Click'),
  tag('Procedural Generation'),
  tag('Psychological Horror'),
  tag('Puzzle'),
  tag('Puzzle Platformer'),
  tag('Racing'),
  tag('Realistic'),
  tag('Relaxing'),
  tag('Remake'),
  tag('Replay Value'),
  tag('Resource Management'),
  tag('Retro'),
  tag('Roguelike'),
  tag('RPG'),
  tag('RTS'),
  tag('Sandbox'),
  tag('Science Fiction', 'Sci-fi'),
  tag('Shooter'),
  tag('Simulation'),
  tag('Space'),
  tag('Sports'),
  tag('Stealth'),
  tag('Story Rich'),
  tag('Strategy'),
  tag('Survival'),
  tag('Tactical'),
  tag('Tower Defense'),
  tag('Turn-Based'),
  tag('Utilities'),
  tag('Visual Novel')
]

const FILTER_BY_ID = new Map(TAG_FILTERS.map((f) => [f.id, f]))

/** The Filters > Tags choice a Steam tag counts as (case-insensitive), or undefined when the list has none. */
export function tagFilterFor(steamTag: string): TagFilter | undefined {
  const wanted = steamTag.trim().toLowerCase()
  return TAG_FILTERS.find((f) => f.steamTags.some((t) => t.toLowerCase() === wanted))
}

/**
 * The label of a Filters > Tags choice, in the language shown. The key is built from the English name
 * (tagFilterKey), which the locales test cannot see: steamTags.test.ts checks that English has one for every choice.
 */
export function tagFilterLabel(id: string): string {
  const filter = FILTER_BY_ID.get(id)
  return filter ? t(`lib.tags.${tagFilterKey(filter.name)}`) : id
}

/** A choice's key under lib.tags: its name in camelCase ("Point & Click" -> "pointClick", "2D" -> "2d"). */
export function tagFilterKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+(.)?/g, (_x, next: string | undefined) => (next ? next.toUpperCase() : ''))
}

/** The Filters > Genre choice a genre counts as (its name or another spelling of it), or undefined: not offered. */
export function genreFilterFor(genre: string): TagFilter | undefined {
  const wanted = genre.trim().toLowerCase()
  return TAG_FILTERS.find((f) => f.genres.some((g) => g.toLowerCase() === wanted))
}

type GenreFilterGame = Pick<Game, 'source'> & {
  metadata: Pick<GameMetadata, 'steamTags' | 'genres' | 'launchboxGenres'>
}

/** The Filters > Genre choices a game counts as: by its Steam tags and by its genres (shared/genres.ts gameGenres). */
export function genreFilterIdsOf(game: GenreFilterGame): Set<string> {
  const ids = new Set<string>()
  for (const t of steamTagsOf(game.metadata)) {
    const f = tagFilterFor(t)
    if (f) ids.add(f.id)
  }
  for (const g of gameGenres(game as Pick<Game, 'source' | 'metadata'>)) {
    const f = genreFilterFor(g)
    if (f) ids.add(f.id)
  }
  return ids
}

/** Whether a game has any of the Filters > Genre choices `ids` (by its Steam tags or its genres). */
export function hasTagFilter(game: GenreFilterGame, ids: readonly string[]): boolean {
  const own = genreFilterIdsOf(game)
  return ids.some((id) => own.has(id))
}

/** The Filters > Genre choices some of `games` have, in TAG_FILTERS order (choices no game has are not offered). */
export function libraryTagFilters(games: readonly GenreFilterGame[]): TagFilter[] {
  const present = new Set<string>()
  for (const game of games) for (const id of genreFilterIdsOf(game)) present.add(id)
  return TAG_FILTERS.filter((f) => present.has(f.id))
}

/**
 * The tags a game's page shows beside its genre: the strongest Steam tags, minus the genre already on the page
 * (Steam tags often repeat it: "Action", "RPG"). `genre`: the genre the page shows (shared/genres.ts gameGenres).
 */
export function detailTags(
  meta: Pick<GameMetadata, 'steamTags' | 'genres'>,
  max = DETAIL_TAG_COUNT,
  genre: string | undefined = meta.genres?.[0]
): string[] {
  const shown = genre?.trim().toLowerCase()
  return steamTagsOf(meta)
    .filter((t) => t.trim() && t.trim().toLowerCase() !== shown)
    .slice(0, max)
}

/** One chip of a game's page: a genre of the game (shared/genres.ts gameGenres) or one of its Steam tags. */
export interface DetailChip {
  label: string
  kind: 'genre' | 'tag'
}

/**
 * The genre and tag chips of a game's page, genres first, at most `tagCount` + 1 in all (one line of the page). What
 * Filters > Genre finds the game by comes first, so the page says why a filter shows it:
 * 1. the game's first genre;
 * 2. its other genres that are Filters > Genre choices ("Puzzle" beside "Adventure"), leaving room for some of its
 *    strongest Steam tags when it has any (half of `tagCount`);
 * 3. its strongest Steam tags (at most `tagCount`);
 * 4. in any room left, its genres that are no choice.
 * Genres keep the order the game lists them in. Nothing twice: not a tag that names a genre shown ("Action"), nor one
 * that is the same choice as it ("RPG" beside "Role-playing (RPG)"), nor two genres of one choice.
 */
export function detailChips(game: GenreFilterGame, tagCount = DETAIL_TAG_COUNT): DetailChip[] {
  const total = Math.max(1, tagCount + 1)
  const labels = new Set<string>()
  const choices = new Set<string>()
  /** Whether `label` is new to the page (then noted as shown). */
  const take = (label: string, choice: string | undefined): boolean => {
    const key = label.toLowerCase()
    if (labels.has(key) || (choice !== undefined && choices.has(choice))) return false
    labels.add(key)
    if (choice !== undefined) choices.add(choice)
    return true
  }
  const genres = gameGenres(game as Pick<Game, 'source' | 'metadata'>)
    .map((g) => g.trim())
    .filter((g) => g.length > 0)
  const steamTags = steamTagsOf(game.metadata)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  /** Indexes into `genres` of those shown. */
  const shown = new Set<number>()
  if (genres[0] !== undefined && take(genres[0], genreFilterFor(genres[0])?.id)) shown.add(0)
  // Room kept for Steam tags while the genres that are choices are placed.
  const forTags = tagCount > 0 ? Math.min(steamTags.length, Math.max(1, tagCount >> 1)) : 0
  const genreRoom = Math.max(1, total - forTags)
  genres.forEach((genre, i) => {
    if (i === 0 || shown.size >= genreRoom) return
    const choice = genreFilterFor(genre)?.id
    if (choice !== undefined && take(genre, choice)) shown.add(i)
  })
  const tags: string[] = []
  for (const tag of steamTags) {
    if (tags.length >= tagCount || shown.size + tags.length >= total) break
    if (take(tag, tagFilterFor(tag)?.id)) tags.push(tag)
  }
  // Room the tags left (few tags, or tags that name genres shown): first the genres that are choices, then the rest.
  for (const choicesOnly of [true, false])
    genres.forEach((genre, i) => {
      if (shown.has(i) || shown.size + tags.length >= total) return
      const choice = genreFilterFor(genre)?.id
      if (choicesOnly && choice === undefined) return
      if (take(genre, choice)) shown.add(i)
    })
  return [
    ...genres.filter((_, i) => shown.has(i)).map((label): DetailChip => ({ label, kind: 'genre' })),
    ...tags.map((label): DetailChip => ({ label, kind: 'tag' }))
  ]
}
