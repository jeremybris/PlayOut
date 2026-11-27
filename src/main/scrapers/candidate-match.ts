import type { MetadataCandidate } from '../../shared/types'
import { normalizeTitle, stripEdition, titleSimilarity } from './hltb'

/**
 * A name search's result is only taken when its title scores at least this against the game's (candidateScore).
 * "Rugrats: Search for Reptar" scores about 0.8 against the ROM's "Nickelodeon Rugrats - Search for Reptar";
 * "Nickelodeon GUTS" about 0.3.
 */
export const MIN_CANDIDATE_SIMILARITY = 0.6
/** Results within this of the best one count as just as good: the source's own order then decides. */
const NEAR_TIE = 0.05
/** The game's subtitle ("- Legend") has none of its words in the result: another game of the series. */
const SUBTITLE_PENALTY = 0.2
/** The source left the sequel number out of a title whose whole subtitle it has. */
const DROPPED_NUMBER_PENALTY = 0.1

/**
 * Licensor and brand names that ROM sets (No-Intro, Redump) put in front of a title and the sources' own names often
 * leave out ("Nickelodeon Rugrats - Search for Reptar" is "Rugrats: Search for Reptar"). Only dropped to search again
 * and to compare; a result is still checked against the title.
 */
const BRAND_PREFIX_RE =
  /^(?:nickelodeon|disney(?:'s)?(?:\s*[•·-]?\s*pixar(?:'s)?)?|pixar(?:'s)?|marvel(?:'s)?|dc comics|tom clancy's|sid meier's|clive barker's|american mcgee's|cartoon network|dreamworks(?:'s)?|warner bros\.?|looney tunes)\s+/i

/**
 * A remaster or remake is its own game for art and text ("Shrek 2 Remastered" is not the 2004 "Shrek 2"): unlike an
 * edition ("Special Edition", "GOTY"), the marker must be on both titles or on neither.
 */
const REMAKE_RE = /\b(?:remaster(?:ed)?|remake|reforged)\b/

function isRemake(title: string): boolean {
  return REMAKE_RE.test(normalizeTitle(title))
}

/** Words of a subtitle too common to tell games apart. */
const STOPWORDS = new Set([
  'the',
  'of',
  'and',
  'a',
  'an',
  'in',
  'on',
  'to',
  'for',
  'edition',
  'version'
])

const ROMAN: Record<string, string> = {
  ii: '2',
  iii: '3',
  iv: '4',
  v: '5',
  vi: '6',
  vii: '7',
  viii: '8',
  ix: '9',
  x: '10'
}

/** The title without a licensor or brand in front of it; undefined when it has none. */
export function withoutBrand(title: string): string | undefined {
  const stripped = title.replace(BRAND_PREFIX_RE, '').trim()
  return stripped && stripped !== title.trim() ? stripped : undefined
}

/** The part before a subtitle (": " or the ROM sets' " - "); undefined without a subtitle. */
function headOf(title: string): string | undefined {
  const head = title.split(/\s*:\s+|\s+[-–—]\s+/)[0]?.trim()
  return head && head !== title.trim() ? head : undefined
}

/** The subtitle after ": " or " - "; undefined without one. */
function subtitleOf(title: string): string | undefined {
  const m = title.match(/(?:\s*:\s+|\s+[-–—]\s+)(.+)$/)
  return m?.[1]?.trim() || undefined
}

/**
 * Names to search for, best first: the title as given, then (only if that finds no convincing result) the title
 * without a licensor or brand in front, its ROM-set " - " separators read as ": ", then the part before its subtitle.
 */
export function searchVariantsFor(name: string): string[] {
  const out: string[] = []
  const push = (v: string | undefined): void => {
    const t = v?.replace(/\s+/g, ' ').trim()
    // A form that reads the same once punctuation is gone is the same search.
    if (t && normalizeTitle(t) && !out.some((x) => normalizeTitle(x) === normalizeTitle(t)))
      out.push(t)
  }
  push(name)
  const colon = name.replace(/\s+[-–—]\s+/g, ': ')
  push(colon)
  push(withoutBrand(colon))
  push(headOf(withoutBrand(name) ?? name))
  return out
}

/** A normalised title's trailing "version" (Pokémon's) dropped, its roman numerals read as numbers. */
function plainWords(normalized: string): string {
  return normalized
    .replace(/\s+version$/, '')
    .split(' ')
    .map((w) => ROMAN[w] ?? w)
    .join(' ')
}

/** Normalised for comparing: edition words and a trailing "version" (Pokémon's) go, roman numerals read as numbers. */
function comparable(title: string): string {
  return plainWords(stripEdition(normalizeTitle(title)))
}

/** As comparable, but with its edition words kept: "Limited Edition" is not the game itself. */
function literal(title: string): string {
  return plainWords(normalizeTitle(title))
}

/** The sequel numbers of a normalised title ("donkey kong country 3" -> ["3"]); years are not sequel numbers. */
function numbersOf(normalized: string): string {
  return normalized
    .split(' ')
    .filter((w) => /^\d{1,2}$/.test(w))
    .sort()
    .join(' ')
}

/** Dice coefficient of character bigrams, spaces removed ("BrainDead 13" is "Brain Dead 13"). */
function compactDice(a: string, b: string): number {
  const x = a.replace(/\s+/g, '')
  const y = b.replace(/\s+/g, '')
  if (x.length < 2 || y.length < 2) return x === y ? 1 : 0
  const grams = new Map<string, number>()
  for (let i = 0; i < x.length - 1; i++)
    grams.set(x.slice(i, i + 2), (grams.get(x.slice(i, i + 2)) ?? 0) + 1)
  let shared = 0
  for (let i = 0; i < y.length - 1; i++) {
    const g = y.slice(i, i + 2)
    const n = grams.get(g) ?? 0
    if (n > 0) {
      shared++
      grams.set(g, n - 1)
    }
  }
  return (2 * shared) / (x.length - 1 + (y.length - 1))
}

/** One form of the game's title against one form of the result's: similarity less the series penalties. */
function formScore(wanted: string, wantedSubtitle: string | undefined, target: string): number {
  if (!wanted || !target) return 0
  const words = wantedSubtitle
    ? comparable(wantedSubtitle)
        .split(' ')
        .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    : []
  const have = new Set(target.split(' '))
  let score = Math.max(titleSimilarity(wanted, target), compactDice(wanted, target) - 0.05)
  // A sequel number (2, 3, VII) on one side only, or another number: another game of the series, never this one. The
  // one exception: a source that leaves the number out of a title whose whole subtitle it has ("The Lion King II -
  // Simba's Mighty Adventure" is "The Lion King: Simba's Mighty Adventure").
  if (numbersOf(wanted) !== numbersOf(target)) {
    const subtitleNamesIt = words.length >= 2 && words.every((w) => have.has(w))
    if (numbersOf(target) || !subtitleNamesIt) return 0
    score -= DROPPED_NUMBER_PENALTY
  }
  if (words.length && !words.some((w) => have.has(w))) score -= SUBTITLE_PENALTY
  return score
}

/**
 * How close a result's title is to the game's: the best of the game's title with and without a brand in front,
 * against the result's title with and without its subtitle ("Donkey Kong Country 3: Dixie Kong's Double Trouble!" is
 * "Donkey Kong Country 3"), none for another sequel number, less a penalty for a missing subtitle.
 */
export function candidateScore(wanted: string, candidateTitle: string): number {
  return scoreOf(wanted, candidateTitle).score
}

interface TitleScore {
  score: number
  /** The result's whole title is the game's, edition words aside ("X - Limited Edition" for "X"). */
  exact: boolean
  /** The result's whole title is the game's with nothing left out: the game's own record, not an edition of it. */
  own: boolean
}

/**
 * candidateScore, and whether the best form was the result's whole title (`exact`: same words), not its head or
 * subtitle: between results about as close, the one that is the game's title word for word wins; and whether it is
 * that with its edition words too (`own`): a source lists "X" and "X - Limited Edition" as two records, and a game
 * called "X" is the first.
 */
function scoreOf(wanted: string, candidateTitle: string): TitleScore {
  if (isRemake(wanted) !== isRemake(candidateTitle)) return { score: 0, exact: false, own: false }
  const wantedSubtitle = subtitleOf(withoutBrand(wanted) ?? wanted)
  const wantedForms = [wanted, withoutBrand(wanted)].filter((n): n is string => !!n).map(comparable)
  // The result with and without a brand in front ("Disney's Aladdin" is "Aladdin"), each whole, without its subtitle
  // ("Donkey Kong Country 3: Dixie Kong's..." is "Donkey Kong Country 3") and as its subtitle alone ("The Elder Scrolls
  // V: Skyrim" is "Skyrim", the number belonging to the franchise in front).
  const targets: [string, number][] = []
  for (const title of [candidateTitle, withoutBrand(candidateTitle)]) {
    if (!title) continue
    targets.push([comparable(title), 0])
    const head = headOf(title)
    if (head) targets.push([comparable(head), 0.02])
    const subtitle = subtitleOf(title)
    if (subtitle) targets.push([comparable(subtitle), 0.05])
  }
  const wantedOwn = [wanted, withoutBrand(wanted)].filter((n): n is string => !!n).map(literal)
  const own = [candidateTitle, withoutBrand(candidateTitle)].some(
    (title) => !!title && !!literal(title) && wantedOwn.includes(literal(title))
  )
  let best = 0
  let exact = false
  for (const form of wantedForms) {
    for (const [target, cost] of targets) {
      // Against the result's head or subtitle, the game's own subtitle is not asked for (the game may have none).
      const score = formScore(form, cost ? undefined : wantedSubtitle, target) - cost
      if (score > best) best = score
      // Two titles with nothing to compare (all Japanese, Cyrillic...) are not thereby the same title.
      if (!cost && form && form === target) exact = true
    }
  }
  return { score: best, exact, own: own && exact }
}

/**
 * A source's title against a game's: whether it is the game's word for word, edition words aside (`exact`: "X -
 * Limited Edition" for "X"), and whether it is that with nothing left out (`own`: the game's own record).
 */
export function titleMatch(wanted: string, title: string): { exact: boolean; own: boolean } {
  const { exact, own } = scoreOf(wanted, title)
  return { exact, own }
}

/**
 * The key two results share when this matching takes them for the same title ("SSX", "SSX®", "S.S.X"): the words
 * pickCandidate compares, else the plain lower-case title (for a title with nothing to compare).
 */
export function sameTitleKey(title: string): string {
  return comparable(title) || title.normalize('NFKC').trim().toLowerCase()
}

/** A candidate's release year, when it has one. */
export function candidateYear(
  candidate: Pick<MetadataCandidate, 'releaseDate'>
): number | undefined {
  const m = candidate.releaseDate?.match(/^(\d{4})/)
  return m ? Number.parseInt(m[1]!, 10) : undefined
}

/**
 * How many years apart a game and a source's game of the same title may be released and still be taken for each other
 * by year: a port or a regional release comes a year or two after the original.
 */
export const YEAR_MATCH_WINDOW = 2

/** `candidate` was released within YEAR_MATCH_WINDOW of `year` (false when it has no year). */
export function withinYear(
  candidate: Pick<MetadataCandidate, 'releaseDate'>,
  year: number
): boolean {
  const y = candidateYear(candidate)
  return y !== undefined && Math.abs(y - year) <= YEAR_MATCH_WINDOW
}

/**
 * Of equally good matches, one released near `year` (the game's own year, from its other sources): several games share
 * a title ("SSX" of 2000 and its 2012 reboot), and the source's first is often the older one. The source's first stays
 * unless it is not within YEAR_MATCH_WINDOW of `year` and another is (then the closest of those): a port whose year is
 * far from every candidate (a 1999 handheld port of a 1989 game with a 2008 reboot) keeps the source's choice.
 * `sameTitle` (the pool is of results with the game's very title): when the first is dated years away and no dated
 * result fits, the first one without a date is taken; a date known to be wrong loses to an unknown one (SteamGridDB
 * has no date for many of its newer games: "SSX" of 2000, dated, before the 2012 game, undated).
 */
function closestInYear<T extends { candidate: MetadataCandidate }>(
  pool: T[],
  year?: number,
  era?: ConsoleYears,
  sameTitle = false
): T | undefined {
  const first = pool[0]
  if (!year) return first && era ? firstInEra(pool, era, sameTitle) : first
  if (!first || withinYear(first.candidate, year)) return first
  let best: T | undefined
  let bestDistance = Infinity
  for (const entry of pool) {
    if (!withinYear(entry.candidate, year)) continue
    const distance = Math.abs(candidateYear(entry.candidate)! - year)
    if (distance < bestDistance) {
      best = entry
      bestDistance = distance
    }
  }
  if (best) return best
  const firstDated = candidateYear(first.candidate) !== undefined
  return (sameTitle && firstDated ? firstUndated(pool) : undefined) ?? first
}

/** The first result of the pool that has no release date. */
function firstUndated<T extends { candidate: MetadataCandidate }>(pool: T[]): T | undefined {
  return pool.find((entry) => candidateYear(entry.candidate) === undefined)
}

/** The years a console had new games: its first, and its last when that is over. */
export interface ConsoleYears {
  from: number
  to?: number
}

/** A game is taken for one of a console's when it came out at most this long before or after the console's years. */
const ERA_SLACK = 1

function inEra(year: number, era: ConsoleYears): boolean {
  return year >= era.from - ERA_SLACK && (era.to === undefined || year <= era.to + ERA_SLACK)
}

/**
 * Of equally good matches for a game whose year is not known (yet): the source's first, unless that one came out
 * outside the years of the console the game is on, or has no date, and another came out within them (the source's
 * first of those). "SSX" in a PlayStation 3 folder is the 2012 game, not the one of 2000.
 * A pool with none in the console's years (a late port) keeps the source's choice, unless (`sameTitle`: the pool is
 * of results with the game's very title) that choice is dated outside them and another has no date: then the first
 * undated one, as a date known to be wrong loses to an unknown one. A pool whose first result is within the console's
 * years keeps it too: when two games of one title both came out in a console's years (the PlayStation 2 had new games
 * until 2013, so "SSX" of 2012 counts as one of its), the years cannot tell them apart; only the game's own year can
 * (the text sources', by which the match is made again: metadata-service.ts `rematchByYear`).
 */
function firstInEra<T extends { candidate: MetadataCandidate }>(
  pool: T[],
  era: ConsoleYears,
  sameTitle: boolean
): T {
  const first = pool[0]!
  const year = candidateYear(first.candidate)
  if (year !== undefined && inEra(year, era)) return first
  const within = pool.find((entry) => {
    const y = candidateYear(entry.candidate)
    return y !== undefined && inEra(y, era)
  })
  return within ?? (sameTitle && year !== undefined ? firstUndated(pool) : undefined) ?? first
}

/** What is known of the console a game was found on (its ROM folder), for choosing among same-titled results. */
export interface ConsoleHint {
  /** The source's own id of the console: results the source lists on it go before those it does not. */
  platformId?: number
  /** The console's years: used while the game's own year is not known. */
  era?: ConsoleYears
}

/** Of equally good matches, those the source lists on the game's console, when it lists any of them there. */
function onConsole<T extends { candidate: MetadataCandidate }>(
  pool: T[],
  platformId?: number
): T[] {
  if (!platformId) return pool
  const on = pool.filter((entry) => entry.candidate.platformIds?.includes(platformId))
  return on.length ? on : pool
}

/**
 * Of the results that are the game's title word for word (`exact`, editions included): the game's own records, or all
 * of them when the game's year or console speaks for an edition and against every own record. A ROM named "Metro 2033"
 * whose year is 2014 is "Metro 2033 Redux" (2014), not the game of 2010; "Okami" in a Switch folder is "Okami HD".
 * Where they do not decide (the same date and console, or nothing known), the game's own record is it.
 */
function ownOrEditions<T extends { candidate: MetadataCandidate; own: boolean }>(
  exact: T[],
  year: number | undefined,
  on: ConsoleHint
): T[] {
  const own = exact.filter((s) => s.own)
  const editions = exact.filter((s) => !s.own)
  if (!own.length || !editions.length) return exact
  const listed = (s: T): boolean =>
    !!on.platformId && !!s.candidate.platformIds?.includes(on.platformId)
  if (!own.some(listed) && editions.some(listed)) return exact
  if (year) {
    const near = (s: T): boolean => withinYear(s.candidate, year)
    return !own.some(near) && editions.some(near) ? exact : own
  }
  const era = on.era
  if (!era) return own
  const dated = (s: T, within: boolean): boolean => {
    const y = candidateYear(s.candidate)
    return y !== undefined && inEra(y, era) === within
  }
  // An own record without a date is not spoken against.
  return own.every((s) => dated(s, false)) && editions.some((s) => dated(s, true)) ? exact : own
}

/**
 * The result of a search to use: one the source found by the game's own id (`byId`: a Steam app, a GOG product, a ROM
 * hash) as it is; else, of the results whose titles (or other names, `altTitles`) are close enough to the game's, among
 * those about as close as the closest: those that are the game's title word for word (of them, the game's own record
 * before an edition of it: "X" before "X - Limited Edition" for a game called "X", unless the year or the console
 * speaks for the edition, `ownOrEditions`; else all of them), of those the ones the source lists on the game's console (`on.platformId`, when it lists any there), and of those the one
 * released closest to `year` when the game's year is known (else the first from the console's years, `on.era`,
 * else the source's first; among results of the game's very title, one dated years away, or outside the console's
 * years, loses to one without a date when no dated one fits); else none.
 * A title with nothing to compare (all Japanese, Cyrillic...) keeps the source's first result, as before.
 */
export function pickCandidate(
  candidates: readonly MetadataCandidate[],
  wanted: string,
  year?: number,
  on: ConsoleHint = {}
): MetadataCandidate | undefined {
  const first = candidates[0]
  if (!first) return undefined
  if (first.byId) return first
  if (!comparable(wanted)) {
    const same = wanted.normalize('NFKC').trim().toLowerCase()
    const exact = candidates
      .filter((c) => c.title.normalize('NFKC').trim().toLowerCase() === same)
      .map((candidate) => ({ candidate }))
    return closestInYear(onConsole(exact, on.platformId), year, on.era, true)?.candidate ?? first
  }
  const scored = candidates.map((candidate) => {
    let best: TitleScore = { score: 0, exact: false, own: false }
    for (const title of [candidate.title, ...(candidate.altTitles ?? [])]) {
      const s = scoreOf(wanted, title)
      if (s.score > best.score || (s.score === best.score && s.exact && !best.own)) best = s
    }
    return { candidate, ...best }
  })
  const best = Math.max(...scored.map((s) => s.score))
  if (best < MIN_CANDIDATE_SIMILARITY - 1e-9) return undefined
  const close = scored.filter((s) => s.score >= best - NEAR_TIE)
  const exact = close.filter((s) => s.exact)
  const pool = exact.length ? ownOrEditions(exact, year, on) : close
  return closestInYear(onConsole(pool, on.platformId), year, on.era, exact.length > 0)?.candidate
}
