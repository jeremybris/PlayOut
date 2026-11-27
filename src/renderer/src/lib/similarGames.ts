import type { Game, RemoteLibrary } from '@shared/types'
import { displayTitle, visibleGames, type GameVisibility } from './library'
import { collapsedWithRemote, hostGamesShown, withRemoteGames } from './streaming'
import { gameGenres } from '@shared/genres'
import { genreFilterFor, genreFilterIdsOf, steamTagsOf, tagFilterFor } from './steamTags'

/**
 * The games of a library most like one game (the Similar button on a game's page), by seven things the two share:
 * their Genres & Tags (the Library's merged Genre filter choices, by genres and Steam tags), their developer, their
 * publisher, their title (the words that name the game; a series and its sequels match: "SSX (2012)" and "SSX 3"),
 * their platform (PLATFORM_GROUPS: the same generation or kind of machine), their review score and their How Long To
 * Beat time. Each gives 0-1; the similarity is their weighted mean as a
 * percentage (100%: alike in everything compared, compared on at least half the criteria). A thing only one of the two
 * games knows is left out of the mean (its weight is not counted), except Genres & Tags, which always counts when
 * either game has some. A game is a candidate only when it shares a Genre & Tag choice, the developer or the
 * publisher, or is of the same series (the same first naming word of the title, or the shorter title all in the
 * longer one): two unrelated games with close review scores are not similar.
 */

export const SIMILAR_LIMIT = 10

const WEIGHTS = {
  title: 0.25,
  genres: 0.25,
  developer: 0.2,
  platform: 0.1,
  hltb: 0.1,
  review: 0.05,
  publisher: 0.05
} as const
/** Review scores this many points apart (or more) count as not alike at all. */
const REVIEW_SPAN = 50

export interface SimilarGame {
  game: Game
  /** 1-100. */
  percent: number
}

/** A developer's name for comparing: lowercase, without punctuation and company suffixes ("Valve Corporation"). */
export function developerKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(inc|llc|ltd|limited|co|corp|corporation|gmbh|s ?a|ab|oy|k ?k|plc)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Words that say nothing about which game it is: articles and joining words, and the edition words a store adds
 * ("Game of the Year Edition", "Remastered"). Numbers and Roman numerals are left out too (a sequel is the series).
 */
const TITLE_FILLER = new Set(
  (
    'the a an of and or in on at to for with from by vs versus my your our its game games edition editions ' +
    'remastered remaster remake hd definitive deluxe ultimate complete collection anniversary enhanced goty year ' +
    'special gold platinum premium standard legendary director directors cut redux reloaded classic new super ' +
    // Pronouns, number words and other everyday words that name no game ("It Takes Two", "Two Point Hospital").
    'it is be me we us you he she they them his her this that one two three all no not up out into as so'
  ).split(' ')
)
const ROMAN = /^(?=[ivxl]+$)l?x{0,3}(ix|iv|v?i{0,3})$/

/** The words of a game's title that name it, for comparing titles: "Dark Souls III: Remastered" -> dark, souls. */
export function titleWords(title: string): Set<string> {
  const words = title
    .toLowerCase()
    .normalize('NFD')
    // Latin accents off ("Pokémon" -> pokemon); other marks put back on their letters (kana voicing, Indic vowels).
    .replace(/[\u0300-\u036f]/g, '')
    .normalize('NFC')
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((w) => w.length > 1 && !TITLE_FILLER.has(w) && !/^\d+$/.test(w) && !ROMAN.test(w))
  return new Set(words)
}

/** A title for telling copies of one game apart from other games (another store's copy is not "similar"). */
function titleKey(game: Game): string {
  return displayTitle(game)
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '')
}

/**
 * The platforms that count as alike (ES-DE system ids, regional folders with their system): one generation or kind
 * of machine each. A game on a system none of them lists has no platform here (too rare to compare).
 */
const PLATFORM_GROUPS: Record<string, readonly string[]> = {
  'sixth-gen': ['gc', 'xbox', 'wii', 'psp', 'ps2'],
  'nintendo-handheld': ['gb', 'gbc', 'gba', 'nds', 'n3ds'],
  'seventh-gen': ['ps3', 'xbox360', 'switch'],
  'current-gen': ['switch2', 'ps4', 'ps5'],
  'fifth-gen': ['psx', 'saturn', 'saturnjp', 'n64', 'dreamcast'],
  'cartridge-16-bit': [
    'snes',
    'snesna',
    'sfc',
    'nes',
    'famicom',
    'genesis',
    'megadrive',
    'megadrivejp'
  ],
  'cd-consoles': ['neogeocd', 'neogeocdjp', '3do', 'amigacd32'],
  'pc-engine-dos': ['pcengine', 'pcenginecd', 'tg16', 'tg-cd', 'dos'],
  // ROM folders of Windows games, and 'pc' (PlayOut's plain PC platform: a recompilation of a Windows game); a store's
  // or an added program's game is PC by its source (platformGroupOf).
  pc: ['windows', 'windows3x', 'windows9x', 'steam', 'pc']
}
const GROUP_OF = new Map(
  Object.entries(PLATFORM_GROUPS).flatMap(([group, ids]) => ids.map((id) => [id, group] as const))
)

/**
 * The platform group a game is on (PLATFORM_GROUPS): every store's game and added program is a PC game; a ROM by its
 * system. Null: a system no group lists.
 */
export function platformGroupOf(game: Pick<Game, 'source' | 'platformId'>): string | null {
  if (game.source !== 'rom') return 'pc'
  return GROUP_OF.get(game.platformId) ?? null
}

interface Facts {
  platform: string | null
  genres: Set<string>
  developers: Set<string>
  publishers: Set<string>
  title: Set<string>
  review: number | null
  hltb: number | null
}

/**
 * A game's Genres & Tags: the Library's Genre filter choices it counts as (genres and Steam tags merged as the
 * filter merges them), plus its genres and tags that are no filter choice ("Fighting", "Arcade"), by name.
 */
function genreSetOf(game: Game): Set<string> {
  const set = genreFilterIdsOf(game)
  for (const g of gameGenres(game)) {
    const name = g.trim().toLowerCase()
    if (name && !genreFilterFor(g)) set.add(`genre:${name}`)
  }
  for (const t of steamTagsOf(game.metadata)) {
    const name = t.trim().toLowerCase()
    if (name && !tagFilterFor(t) && !genreFilterFor(t)) set.add(`genre:${name}`)
  }
  return set
}

function factsOf(game: Game): Facts {
  const meta = game.metadata
  const review = meta.reviewScore?.score
  const hltb = meta.hltb?.main ?? meta.hltb?.solo
  return {
    genres: genreSetOf(game),
    developers: new Set((meta.developers ?? []).map(developerKey).filter(Boolean)),
    publishers: new Set((meta.publishers ?? []).map(developerKey).filter(Boolean)),
    title: titleWords(displayTitle(game)),
    platform: platformGroupOf(game),
    review: typeof review === 'number' && Number.isFinite(review) && review > 0 ? review : null,
    hltb: typeof hltb === 'number' && Number.isFinite(hltb) && hltb > 0 ? hltb : null
  }
}

/** How alike two games are: 0-1, and the share of the criteria's weight both games know (what it rests on). */
export interface Similarity {
  score: number
  compared: number
}

/**
 * How alike two games are, or null when they share no Genre & Tag choice, developer or publisher, nor a series (the
 * same first naming word of the title, or the shorter title all in the longer one).
 */
export function similarity(a: Facts, b: Facts): Similarity | null {
  let shared = 0
  for (const g of a.genres) if (b.genres.has(g)) shared++
  const sameDeveloper = [...a.developers].some((d) => b.developers.has(d))
  const samePublisher = [...a.publishers].some((p) => b.publishers.has(p))
  let sharedWords = 0
  for (const w of a.title) if (b.title.has(w)) sharedWords++
  const shorter = a.title.size <= b.title.size ? a.title : b.title
  // One series (numbers, years and filler left out of the titles), told two ways:
  // - a series name of two words or more, shared, at the start of both titles or as the whole shorter one ("Grand
  //   Theft Auto III" and "Grand Theft Auto: Vice City", "Dark Souls II: …" and "Dark Souls III: …");
  // - only the same first naming word ("SSX Tricky" and "SSX On Tour", "Halo: The Master Chief Collection" and "Halo
  //   Infinite"): weaker, as an everyday first word can be no series at all ("Dead Space" and "Dead Cells").
  const firstA = a.title.values().next().value
  const sameFirst = firstA !== undefined && firstA === b.title.values().next().value
  const seriesName = sharedWords >= 2 && (sameFirst || sharedWords === shorter.size)
  const sameSeries = seriesName || (sharedWords > 0 && sameFirst)
  if (shared === 0 && !sameDeveloper && !samePublisher && !sameSeries) return null
  let total = 0
  let weight = 0
  const add = (w: number, score: number): void => {
    total += w * score
    weight += w
  }
  if (a.genres.size || b.genres.size)
    add(WEIGHTS.genres, shared / (a.genres.size + b.genres.size - shared))
  if (a.developers.size && b.developers.size) add(WEIGHTS.developer, sameDeveloper ? 1 : 0)
  if (a.publishers.size && b.publishers.size) add(WEIGHTS.publisher, samePublisher ? 1 : 0)
  // The same platform group (alone it makes no candidate: every PS2 game would be like every other).
  if (a.platform !== null && b.platform !== null)
    add(WEIGHTS.platform, a.platform === b.platform ? 1 : 0)
  // The same words count fully ("SSX (2012)" and "SSX 3", "Portal" and "Portal 2"). Otherwise the words shared, as a
  // share of the shorter title and of both titles' words together, raised for one series: from a half for a shared
  // series name, from a quarter for only the same first word. Other titles: the share of all their words in common
  // ("Control" and "Mind Control": a half).
  if (a.title.size && b.title.size) {
    const union = a.title.size + b.title.size - sharedWords
    const words = (sharedWords / shorter.size + sharedWords / union) / 2
    add(
      WEIGHTS.title,
      sharedWords === union
        ? 1
        : seriesName
          ? 0.5 + words / 2
          : sameSeries
            ? 0.25 + words / 2
            : sharedWords / union
    )
  }
  if (a.review !== null && b.review !== null)
    add(WEIGHTS.review, Math.max(0, 1 - Math.abs(a.review - b.review) / REVIEW_SPAN))
  if (a.hltb !== null && b.hltb !== null)
    add(WEIGHTS.hltb, Math.min(a.hltb, b.hltb) / Math.max(a.hltb, b.hltb))
  return weight > 0 ? { score: total / weight, compared: weight } : null
}

/** The criteria's weight both games must know for a 100% ("identical"): at least half of it. */
const IDENTICAL_COMPARED = 0.5

/**
 * The (up to `limit`) games of `pool` most like `target`, most similar first (ties by title). Copies of the target
 * itself (the same title, another store) are left out. Run only when asked (the Similar button): it reads every game.
 */
export function similarGames(
  target: Game,
  pool: readonly Game[],
  limit = SIMILAR_LIMIT
): SimilarGame[] {
  const facts = factsOf(target)
  const own = titleKey(target)
  const out: (SimilarGame & { exact: number })[] = []
  for (const game of pool) {
    if (game.id === target.id || (own !== '' && titleKey(game) === own)) continue
    const sim = similarity(facts, factsOf(game))
    if (sim === null) continue
    const s = sim.score
    // 100% only for games alike in everything compared, and compared on at least half the criteria (two games
    // known only by a title or a publisher are not "identical"); anything less shows 99% at most.
    const percent =
      s >= 1 - 1e-9 && sim.compared >= IDENTICAL_COMPARED - 1e-9
        ? 100
        : Math.min(99, Math.round(s * 100))
    if (percent >= 1) out.push({ game, percent, exact: s })
  }
  // Each title once, its best-scoring copy: a paired host's copies of one game on several systems (SSX 3 on PS2, Xbox
  // and GBA) are separate cards, and would otherwise fill the ten rows with one game.
  const titles = new Set<string>()
  return out
    .sort((x, y) => y.exact - x.exact || displayTitle(x.game).localeCompare(displayTitle(y.game)))
    .filter(({ game }) => {
      const key = titleKey(game)
      if (key === '') return true
      if (titles.has(key)) return false
      titles.add(key)
      return true
    })
    .slice(0, limit)
    .map(({ game, percent }) => ({ game, percent }))
}

/**
 * The games the Similar list picks from: the Library's own pool (as Search builds it), so a game is found from every
 * other game's page alike. This PC's games it shows, plus the games of a paired host it shows (Settings > Streaming),
 * a game's copies in several stores as one (its card).
 */
export function similarPool(
  games: readonly Game[],
  settings:
    | (GameVisibility & {
        library: { showDuplicates?: boolean }
        streaming?: { showHostGames?: boolean }
      })
    | null
    | undefined,
  remote: RemoteLibrary | null | undefined
): Game[] {
  const showHostGames = settings?.streaming?.showHostGames ?? true
  return collapsedWithRemote(
    withRemoteGames(
      visibleGames(games as Game[], settings),
      hostGamesShown(games, remote, showHostGames)
    ),
    { showDuplicates: settings?.library.showDuplicates ?? false }
  ).games
}
