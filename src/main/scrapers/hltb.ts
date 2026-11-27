import { createLogger } from '../logger'
import { httpJson, httpText, HttpError, RateLimiter } from './http'
import { describeError } from './steam-store'

const log = createLogger('scrapers:hltb')

const BASE_URL = 'https://howlongtobeat.com'
const DEFAULT_SEARCH_PATH = '/api/search/site'
const SESSION_INIT_SUFFIX = '/init'
// HLTB's firewall answers tool-style User-Agents with 403, and the session token it mints is bound to the
// User-Agent (and public IP) that requested it, so every call must send this same browser string.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const TIMEOUT_MS = 15_000
const RATE_LIMIT_BACKOFF_MS = 2_000
const DISCOVERY_MIN_INTERVAL_MS = 60 * 60 * 1000
const MAX_CHUNKS_TO_SCAN = 20
const COOLDOWN_AFTER_FAILURES = 3
const COOLDOWN_MS = 30 * 60 * 1000
const HIT_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MISS_TTL_MS = 60 * 60 * 1000
const CACHE_MAX = 500
const MIN_SIMILARITY = 0.6
const MIN_SCORE = 0.8
const MAX_SEARCHES_PER_LOOKUP = 3

const limiter = new RateLimiter(1, 1)

export interface HltbTimes {
  main?: number
  extra?: number
  completionist?: number
  /**
   * HLTB's "Solo" time: for a game whose play styles HLTB combines (an endless, multiplayer or compilation entry:
   * its page shows Solo / Co-Op / Vs. instead of Main Story), and for any game without a Main Story time.
   */
  solo?: number
  /** HLTB shows this game's single-player time as "Solo" rather than "Main Story" (`comp_lvl_combine`). */
  combined?: boolean
}

/** One `data[]` item of the search response (only the fields we read). */
export interface HltbSearchResult {
  game_id: number
  game_name: string
  game_alias?: string
  game_type?: string
  game_image?: string
  comp_main?: number
  comp_plus?: number
  comp_100?: number
  comp_all?: number
  /** 1: HLTB combines the play styles and shows "Solo" (`comp_all`) instead of Main Story / Extras / Completionist. */
  comp_lvl_combine?: number
  release_world?: number | string
  profile_steam?: number
  /** The platforms HLTB lists the entry on, comma separated ("Nintendo Switch, PC"). */
  profile_platform?: string
}

interface HltbSession {
  token: string
  hpKey?: string
  hpVal?: string
}

const state = {
  session: null as HltbSession | null,
  searchPath: DEFAULT_SEARCH_PATH,
  lastDiscoveryAt: 0,
  consecutiveFailures: 0,
  disabledUntil: 0
}
const cache = new Map<string, { at: number; ttl: number; value: HltbTimes | null }>()

// ---------------------------------------------------------------------------
// Title normalisation and matching
// ---------------------------------------------------------------------------

const EDITION_RE =
  /\b(?:the )?(?:enhanced|definitive|complete|deluxe|ultimate|remastered|special|gold|collector s|collectors|anniversary|legendary|premium|standard|digital|game of the year|goty|director s cut|directors cut|royal|final|extended|limited|platinum|hd) edition\b/g
// Edition markers that appear without the word "edition" ("Director's Cut", "GOTY"); stripped repeatedly from the end.
const TRAILING_VARIANT_RE =
  /\s+(?:goty|game of the year|remastered|remaster|hd|redux|definitive|enhanced|complete|director s cut|directors cut|anniversary|ultimate|deluxe|edition)$/

/** Lower-case ASCII words only: accents, punctuation and trademark symbols removed, '&' spelled out. */
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

/** Remove "... Edition" / "GOTY" / "Remastered" style suffixes from a normalised title. */
export function stripEdition(normalized: string): string {
  let stripped = normalized.replace(EDITION_RE, ' ').replace(/\s+/g, ' ').trim()
  for (;;) {
    const next = stripped.replace(TRAILING_VARIANT_RE, '').trim()
    if (next === stripped) break
    stripped = next
  }
  return stripped || normalized
}

function bigrams(text: string): Map<string, number> {
  const out = new Map<string, number>()
  for (let i = 0; i < text.length - 1; i++) {
    const g = text.slice(i, i + 2)
    out.set(g, (out.get(g) ?? 0) + 1)
  }
  return out
}

function diceCoefficient(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0
  const ga = bigrams(a)
  const gb = bigrams(b)
  let shared = 0
  for (const [g, n] of ga) shared += Math.min(n, gb.get(g) ?? 0)
  return (2 * shared) / (a.length - 1 + (b.length - 1))
}

/**
 * Similarity in [0, 1] between two normalised titles: half character bigrams (typos, punctuation), half whole
 * tokens (so "Portal" is clearly not "Portal 2").
 */
export function titleSimilarity(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  const ta = new Set(a.split(' '))
  const tb = new Set(b.split(' '))
  let shared = 0
  for (const t of ta) if (tb.has(t)) shared++
  const jaccard = shared / (ta.size + tb.size - shared)
  return 0.5 * diceCoefficient(a, b) + 0.5 * jaccard
}

function releaseYear(value: unknown): number | undefined {
  if (typeof value === 'number') return value > 1900 && value < 2100 ? value : undefined
  if (typeof value === 'string') {
    const m = value.match(/^(\d{4})/)
    if (m) return releaseYear(Number.parseInt(m[1], 10))
  }
  return undefined
}

/**
 * The year HLTB puts in an entry's name to tell it from an older game of the same name ("SSX (2012)", "The Legend of
 * Zelda: Link's Awakening (2019)"), and the name without it; undefined for a name without one.
 */
function yearTagOf(name: string): { name: string; year: number } | undefined {
  const m = name.match(/^(.*\S)\s*\((\d{4})\)\s*$/)
  const year = m ? releaseYear(Number.parseInt(m[2]!, 10)) : undefined
  return m && year ? { name: m[1]!, year } : undefined
}

/**
 * Whether the matching before HLTB's year tags were read could have taken another entry for a game of this title and
 * year, or none: it compared "SSX" with "SSX (2012)" as it stands, which only a long title is still close to. True of
 * most titles of up to three or four words, and it only matters where HLTB has two entries of that name, so the caller
 * (metadata-service.ts `backfillHltb`) looks up again a recorded miss (`missed`) of such a game, and recorded times
 * only where another game is known to have the name; no other game's.
 */
export function yearTagHidden(title: string, year: number, missed = false): boolean {
  const wanted = normalizeTitle(title)
  // What the entry of the game's own year scored then (+0.1 for the year): under an older same-named one's 0.95 it
  // lost to that one, under the acceptance score it was no match at all.
  const scored = titleSimilarity(wanted, `${wanted} ${year}`) + 0.1
  return !!wanted && scored < (missed ? MIN_SCORE : 0.95)
}

const CONSOLE_MAKER_RE = /^(?:sony|microsoft|nintendo|sega|nec|snk|atari|bandai|commodore)\s+/

/** A console's name as two lists of platforms can share it: "Sony PlayStation 3" is HLTB's "PlayStation 3". */
function consoleKey(name: string): string {
  const normalized = normalizeTitle(name)
  return normalized.replace(CONSOLE_MAKER_RE, '') || normalized
}

/** HLTB's names of the consoles it does not call by the platform table's name less its maker. */
const HLTB_CONSOLE_NAMES: Record<string, string[]> = {
  psx: ['PlayStation'],
  psp: ['PSP'],
  psvita: ['PlayStation Vita', 'PS Vita'],
  nes: ['NES'],
  famicom: ['NES'],
  snes: ['Super Nintendo', 'SNES'],
  snesna: ['Super Nintendo', 'SNES'],
  sfc: ['Super Nintendo', 'SNES'],
  gc: ['Nintendo GameCube', 'GameCube'],
  genesis: ['Sega Mega Drive/Genesis'],
  megadrive: ['Sega Mega Drive/Genesis'],
  megadrivejp: ['Sega Mega Drive/Genesis'],
  pcengine: ['TurboGrafx-16'],
  tg16: ['TurboGrafx-16']
}

/**
 * The names HLTB may list a console by, for a platform key (`platform-ids.json`) and its name there: an entry on the
 * console a ROM was found on is preferred among same-named ones (`pickBestHltbMatch`).
 */
export function hltbConsolesFor(platformKey: string, name?: string): string[] {
  return [...(name ? [name] : []), ...(HLTB_CONSOLE_NAMES[platformKey.trim().toLowerCase()] ?? [])]
}

/** An entry HLTB lists on one of these consoles earns this: less than a year's worth, more than a year tag's cost. */
const CONSOLE_BONUS = 0.05

function secondsToHours(seconds: unknown): number | undefined {
  return typeof seconds === 'number' && seconds > 0 ? Math.round(seconds / 360) / 10 : undefined
}

/** Completion times in hours (one decimal), or null when HLTB has none for the entry. */
export function hltbTimesOf(result: HltbSearchResult): HltbTimes | null {
  const combined = result.comp_lvl_combine === 1
  const times: HltbTimes = { combined }
  const main = secondsToHours(result.comp_main)
  const extra = secondsToHours(result.comp_plus)
  const completionist = secondsToHours(result.comp_100)
  // HLTB's "Solo" (all single-player styles): what its page shows for a combined game, and the only single-player
  // figure of a game without a Main Story time.
  const solo = combined || main === undefined ? secondsToHours(result.comp_all) : undefined
  if (main !== undefined) times.main = main
  if (extra !== undefined) times.extra = extra
  if (completionist !== undefined) times.completionist = completionist
  if (solo !== undefined) times.solo = solo
  return (main ?? extra ?? completionist ?? solo) ? times : null
}

/**
 * Pick the search result that best matches a title (and release year when known). Aliases count as names,
 * a matching year is rewarded, a year more than one apart is penalised, DLC entries lose a little and entries
 * without any completion time are ignored (they have nothing to offer). A year HLTB put in an entry's name ("SSX
 * (2012)") is not part of the name: it is the entry's year when HLTB gives no other, and the entry is nearly as good
 * a match as one named without it (so the year, or the console, decides between the two). `consoles`: the names of
 * the console the game was found on; an entry HLTB lists on it is preferred (never required: HLTB's lists have gaps).
 * Returns null when nothing reaches the acceptance score.
 */
export function pickBestHltbMatch(
  title: string,
  year: number | undefined,
  results: HltbSearchResult[],
  options: { noDlc?: boolean; consoles?: string[] } = {}
): { result: HltbSearchResult; score: number } | null {
  const wanted = normalizeTitle(title)
  if (!wanted) return null
  const wantedBase = stripEdition(wanted)
  const consoles = new Set((options.consoles ?? []).map(consoleKey).filter(Boolean))
  let best: { result: HltbSearchResult; score: number } | null = null
  for (const result of results) {
    if (!result || typeof result.game_id !== 'number' || typeof result.game_name !== 'string')
      continue
    if (!hltbTimesOf(result)) continue
    // A store's "Game + Add-on" is the game with its add-on, never the add-on alone.
    if (options.noDlc && result.game_type === 'dlc') continue
    const names = [result.game_name, ...(result.game_alias ?? '').split(',')]
      .map(normalizeTitle)
      .filter(Boolean)
    let similarity = 0
    for (const name of names) {
      similarity = Math.max(
        similarity,
        titleSimilarity(wanted, name),
        // An edition-less match is nearly as good; the exact title still wins ties.
        titleSimilarity(wantedBase, stripEdition(name)) - 0.01
      )
    }
    const tagged = yearTagOf(result.game_name)
    if (tagged) {
      const name = normalizeTitle(tagged.name)
      similarity = Math.max(
        similarity,
        titleSimilarity(wanted, name) - 0.01,
        titleSimilarity(wantedBase, stripEdition(name)) - 0.02
      )
    }
    if (similarity < MIN_SIMILARITY) continue
    let score = similarity
    const resultYear = releaseYear(result.release_world) ?? tagged?.year
    if (year && resultYear) {
      const gap = year - resultYear
      // Within a year: the same release. The store's copy years after HLTB's entry: usually a port or re-release of
      // that game (Phoenix Wright: Ace Attorney Trilogy: 2014 on HLTB, 2019 on Steam), a small doubt. HLTB's entry
      // years after the store's: another game of that name (a remake), a large one. An entry of the right year still
      // wins over both.
      score += Math.abs(gap) <= 1 ? 0.1 : gap > 1 ? -0.05 : -0.15
    }
    if (
      consoles.size &&
      typeof result.profile_platform === 'string' &&
      result.profile_platform.split(',').some((p) => consoles.has(consoleKey(p)))
    )
      score += CONSOLE_BONUS
    if (result.game_type && result.game_type !== 'game') score -= 0.05
    // Rounding: 1 - 0.15 - 0.05 must not land a hair under a threshold it meets.
    if (score >= MIN_SCORE - 1e-9 && (!best || score > best.score)) best = { result, score }
  }
  return best
}

/**
 * Words to send as `searchTerms`: trademark symbols and sentence punctuation dropped, hyphenated words kept. HLTB
 * matches each word on its own, so a word must be one the game's name has: dashes that only wrap words go
 * ("KINGDOM HEARTS -HD 1.5+2.5 ReMIX-": "-HD" and "ReMIX-"), and words joined by "+" are split ("1.5+2.5": HLTB's
 * "1.5 + 2.5").
 */
export function hltbSearchTerms(title: string): string[] {
  return title
    .normalize('NFKC')
    .replace(/[™®©]/g, ' ')
    .replace(/\s[-–—]\s/g, ' ')
    .replace(/[:;,!?"“”()[\]+]/g, ' ')
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/^[-–—]+|[-–—]+$/g, ''))
    .filter(Boolean)
}

/**
 * The game of a store's "Game + Add-on" title ("KINGDOM HEARTS III + Re Mind (DLC)": "KINGDOM HEARTS III"); undefined
 * for any other title. A "+" between numbers is part of a name ("1.5 + 2.5"), so the add-on must start with a letter.
 */
export function bundleBase(title: string): string | undefined {
  const m = title.match(/^(.*?\S)\s+\+\s+(?=\p{L})/u)
  const base = m?.[1]?.trim()
  return base && normalizeTitle(base).length >= 3 ? base : undefined
}

/**
 * Progressively broader search strings: as given, without edition suffixes, the game of a "Game + Add-on" title
 * (before the part before a subtitle: it is the better guess), then the part before a subtitle.
 */
export function searchVariants(title: string): string[] {
  const variants: string[] = []
  const push = (v: string): void => {
    const t = v.replace(/\s+/g, ' ').trim()
    if (t && !variants.some((x) => normalizeTitle(x) === normalizeTitle(t))) variants.push(t)
  }
  push(title)
  push(
    title.replace(
      /\s*[-–—:(]?\s*\b(?:the\s+)?(?:enhanced|definitive|complete|deluxe|ultimate|remastered|special|gold|collector'?s|anniversary|legendary|premium|standard|digital|game of the year|goty|director'?s cut|royal|final|extended|limited|platinum|hd)\s+edition\b\)?/gi,
      ''
    )
  )
  const base = bundleBase(title)
  if (base) push(base)
  const parts = title.split(/\s*(?::|\s[-–—]\s)\s*/)
  const head = parts[0]
  if (head && head !== title && (head.length >= 5 || head.includes(' '))) push(head)
  // A short series label before the name ("007: From Russia with Love", "007 - Nightfire"): HLTB often lists the
  // game by its name alone ("From Russia with Love") and matches every search word, so the label finds nothing.
  // Results are still scored against the whole title, so this only widens the search.
  const tail = parts.slice(1).join(': ').trim()
  if (head && head.length < 5 && !head.includes(' ') && normalizeTitle(tail).length >= 3) push(tail)
  return variants
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export function buildSearchPayload(terms: string[]): Record<string, unknown> {
  return {
    searchType: 'games',
    searchTerms: terms,
    searchPage: 1,
    size: 20,
    searchOptions: {
      games: {
        userId: 0,
        platform: '',
        sortCategory: 'popular',
        rangeCategory: 'main',
        rangeTime: { min: null, max: null },
        gameplay: { perspective: '', flow: '', genre: '' },
        year: '',
        modifier: ''
      },
      users: { sortCategory: 'postcount' },
      lists: { sortCategory: 'follows' },
      filter: '',
      sort: 0,
      randomizer: 0
    },
    useCache: true
  }
}

/** Find the POST search route in one of the site's own script chunks. */
export function extractSearchPath(js: string): string | null {
  const m = js.match(
    /fetch\(\s*["'`](\/api\/[^"'`]+)["'`]\s*,\s*\{\s*method\s*:\s*["']POST["']\s*,\s*headers\s*:\s*\{\s*["']Content-Type["']\s*:\s*["']application\/json["']\s*,\s*["']x-auth-token["']/
  )
  return m ? m[1] : null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function mintSession(): Promise<HltbSession | null> {
  await limiter.take()
  const url = `${BASE_URL}${state.searchPath}${SESSION_INIT_SUFFIX}?t=${Date.now()}`
  const res = await httpJson<{ token?: unknown; hpKey?: unknown; hpVal?: unknown }>(
    url,
    { headers: { 'User-Agent': USER_AGENT, Referer: `${BASE_URL}/` } },
    { timeoutMs: TIMEOUT_MS, retries: 0 }
  )
  if (!res || typeof res.token !== 'string' || !res.token) return null
  const session: HltbSession = { token: res.token }
  if (typeof res.hpKey === 'string' && res.hpKey && typeof res.hpVal === 'string' && res.hpVal) {
    session.hpKey = res.hpKey
    session.hpVal = res.hpVal
  }
  state.session = session
  return session
}

/** HLTB renames its search route now and then; the current one is in the site's Next.js chunks. */
async function discoverSearchPath(): Promise<boolean> {
  if (Date.now() - state.lastDiscoveryAt < DISCOVERY_MIN_INTERVAL_MS) return false
  state.lastDiscoveryAt = Date.now()
  try {
    await limiter.take()
    const home = await httpText(
      `${BASE_URL}/`,
      { headers: { 'User-Agent': USER_AGENT } },
      { timeoutMs: TIMEOUT_MS, retries: 0 }
    )
    const chunks = [...home.matchAll(/src="(\/_next\/static\/chunks\/[^"]+\.js)"/g)].map(
      (m) => m[1]
    )
    for (const src of chunks.slice(0, MAX_CHUNKS_TO_SCAN)) {
      await limiter.take()
      const js = await httpText(
        `${BASE_URL}${src}`,
        { headers: { 'User-Agent': USER_AGENT } },
        { timeoutMs: TIMEOUT_MS, retries: 0 }
      )
      const found = extractSearchPath(js)
      if (found) {
        if (found !== state.searchPath) log.info(`search endpoint is now ${found}`)
        state.searchPath = found
        return true
      }
    }
    log.warn('could not find the search endpoint in the site scripts')
  } catch (err) {
    log.debug(`endpoint discovery failed: ${describeError(err)}`)
  }
  return false
}

function isSearchResult(value: unknown): value is HltbSearchResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as HltbSearchResult).game_id === 'number' &&
    typeof (value as HltbSearchResult).game_name === 'string'
  )
}

/** One search; renews a rejected session, backs off once on 429, re-discovers a renamed route on 404. */
export async function searchHltb(terms: string[]): Promise<HltbSearchResult[]> {
  let renewed = false
  let backedOff = false
  let rediscovered = false
  for (;;) {
    const session = state.session ?? (await mintSession())
    if (!session) throw new Error('HowLongToBeat did not issue a search session')
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      Referer: `${BASE_URL}/`,
      Origin: BASE_URL,
      'x-auth-token': session.token
    }
    const payload = buildSearchPayload(terms)
    if (session.hpKey && session.hpVal) {
      headers['x-hp-key'] = session.hpKey
      headers['x-hp-val'] = session.hpVal
      payload[session.hpKey] = session.hpVal
    }
    await limiter.take()
    try {
      const res = await httpJson<{ data?: unknown }>(
        `${BASE_URL}${state.searchPath}`,
        { method: 'POST', headers, body: JSON.stringify(payload) },
        { timeoutMs: TIMEOUT_MS, retries: 0 }
      )
      return Array.isArray(res?.data) ? res.data.filter(isSearchResult) : []
    } catch (err) {
      if (!(err instanceof HttpError)) throw err
      if (err.status === 403 && !renewed) {
        renewed = true
        state.session = null
        log.debug('search session rejected, renewing it')
        continue
      }
      if (err.status === 429 && !backedOff) {
        backedOff = true
        log.debug(`rate limited, retrying in ${RATE_LIMIT_BACKOFF_MS} ms`)
        await sleep(RATE_LIMIT_BACKOFF_MS)
        continue
      }
      if (err.status === 404 && !rediscovered) {
        rediscovered = true
        if (await discoverSearchPath()) {
          state.session = null
          continue
        }
      }
      throw err
    }
  }
}

function remember(key: string, value: HltbTimes | null, ttl: number): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, { at: Date.now(), ttl, value })
}

/**
 * Main / Main + Extra / Completionist (and Solo) hours for a game title, or null when HLTB has no convincing match.
 * Never throws: failures are logged at debug level, and after repeated failures lookups pause for a while.
 */
export async function hltbLookup(
  title: string,
  year?: number,
  consoles?: string[]
): Promise<HltbTimes | null> {
  return (await hltbLookupOutcome(title, year, consoles)).times
}

/**
 * hltbLookup, telling a failure (HLTB unreachable, paused after failures) from an answer of "no match"
 * (`failed` false, `times` null): only an answer may be recorded as such. `consoles`: the names of the console a ROM
 * was found on (`hltbConsolesFor`), to choose among same-named entries.
 */
export async function hltbLookupOutcome(
  title: string,
  year?: number,
  consoles?: string[]
): Promise<{ times: HltbTimes | null; failed: boolean }> {
  const trimmed = title?.trim()
  if (!trimmed) return { times: null, failed: false }
  try {
    const key = `${normalizeTitle(trimmed)}|${year ?? ''}|${(consoles ?? []).join(',')}`
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < hit.ttl) return { times: hit.value, failed: false }
    if (Date.now() < state.disabledUntil) {
      log.debug(`paused after repeated failures; skipping "${trimmed}"`)
      return { times: null, failed: true }
    }
    // A "Game + Add-on" title: no DLC entry is its match, and its game's own name is matched by that name.
    const base = bundleBase(trimmed)
    // The game's own name is searched only when the part after "+" is an add-on: the title says so ("+ Re Mind
    // (DLC)"), or HLTB lists the whole title as a DLC entry. "Bayonetta + Vanquish" names two games: never only the
    // first one's times.
    let addon = !!base && /\bdlc\b/i.test(trimmed)
    for (const variant of searchVariants(trimmed).slice(0, MAX_SEARCHES_PER_LOOKUP)) {
      if (base && variant === base && !addon) continue
      const terms = hltbSearchTerms(variant)
      if (!terms.length) continue
      const results = await searchHltb(terms)
      state.consecutiveFailures = 0
      if (!results.length) {
        log.debug(`no results for "${variant}"`)
        continue
      }
      if (base && !addon && variant !== base)
        addon = !!pickBestHltbMatch(
          trimmed,
          year,
          results.filter((r) => r?.game_type === 'dlc')
        )
      const best = pickBestHltbMatch(base && variant === base ? base : trimmed, year, results, {
        noDlc: !!base,
        consoles
      })
      if (!best) {
        log.debug(`no acceptable match for "${variant}" among ${results.length} results`)
        continue
      }
      const times = hltbTimesOf(best.result)
      if (!times) continue
      log.debug(
        `"${trimmed}" -> "${best.result.game_name}" (#${best.result.game_id}, score ${best.score.toFixed(2)})`
      )
      remember(key, times, HIT_TTL_MS)
      return { times, failed: false }
    }
    remember(key, null, MISS_TTL_MS)
    return { times: null, failed: false }
  } catch (err) {
    state.consecutiveFailures++
    if (state.consecutiveFailures >= COOLDOWN_AFTER_FAILURES) {
      state.consecutiveFailures = 0
      state.disabledUntil = Date.now() + COOLDOWN_MS
      log.warn(
        `pausing lookups for ${COOLDOWN_MS / 60_000} min after repeated failures: ${describeError(err)}`
      )
    } else {
      log.debug(`lookup failed for "${trimmed}": ${describeError(err)}`)
    }
    return { times: null, failed: true }
  }
}

/**
 * Whether lookups are paused after repeated failures (COOLDOWN_MS from the last of them): a lookup now answers
 * `failed` without asking HLTB. The H.L.T.B. sort's lookups (hltb-times.ts) stop then.
 */
export function hltbPaused(now = Date.now()): boolean {
  return now < state.disabledUntil
}

/** Test hook: forget the session, the discovered route, the cooldown and cached lookups. */
export function resetHltbState(): void {
  state.session = null
  state.searchPath = DEFAULT_SEARCH_PATH
  state.lastDiscoveryAt = 0
  state.consecutiveFailures = 0
  state.disabledUntil = 0
  cache.clear()
}
