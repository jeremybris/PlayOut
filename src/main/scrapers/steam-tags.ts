// Steam user tags ("Roguelike", "Souls-like", "Great Soundtrack") for the library, in the background. Keyless Steam
// Web API: IStoreBrowseService/GetItems gives up to 20 tag ids per app, strongest first, for 100 apps per request;
// IStoreService/GetTagList names them. Steam games use their own app id; games from other stores use the Steam app
// matched for them (install sizes), else the Steam game with exactly their title.
//
// Kept in `metadata.steamTags`, apart from `metadata.tags`: the text scrapers write that field (Steam's feature
// categories, IGDB themes, age ratings) and a forced refresh replaces it, which would lose the user tags.
import type { Game, GameMetadata, Settings, SteamControls } from '../../shared/types'
import { steamLinksAppId } from '../../shared/web-viewer'
import type { Logger } from '../logger'
import { buildUrl, httpJson, RateLimiter } from './http'
import { describeError, steamAppIdOf } from './steam-store'
import { sameGameKey, steamAppIdByTitle } from './store-sizes'

const GET_ITEMS = 'https://api.steampowered.com/IStoreBrowseService/GetItems/v1'
const GET_TAG_LIST = 'https://api.steampowered.com/IStoreService/GetTagList/v1/'
/** Apps per GetItems request: 200 still fits the URL limit (300 does not); 100 leaves room. */
export const STEAM_TAGS_BATCH = 100
/** Tags kept per game: all Steam returns (its top 20). */
const MAX_TAGS = 20
/** Tags are re-read after this long (players keep voting). */
export const STEAM_TAGS_REFRESH_MS = 90 * 24 * 60 * 60 * 1000
/** A game with no Steam app (or no tags) is looked for again after this long. */
export const STEAM_TAGS_MISS_RETRY_MS = 30 * 24 * 60 * 60 * 1000
/** The tag-name list is read again after this long. */
const TAG_LIST_TTL_MS = 24 * 60 * 60 * 1000
/** After Steam stops answering, the pass waits this long before carrying on. */
const PAUSE_AFTER_FAILURES_MS = 15 * 60 * 1000
const FAILURES_BEFORE_PAUSE = 3
/** Sources whose games are never on Steam: ROMs, games the user added by hand. */
const NO_STEAM_SOURCES = new Set(['rom', 'manual'])

const limiter = new RateLimiter(0.5, 1)
/**
 * Title searches share store-sizes' storesearch limiter with the install sizes; this one keeps the tags' share
 * of Steam's store allowance (about 200 calls per 5 minutes, shared with appdetails) to 60 per 5 minutes.
 */
const searchLimiter = new RateLimiter(0.2, 1)

export type SteamTagsRecord = NonNullable<GameMetadata['steamTags']>

interface GetItemsResponse {
  response?: {
    store_items?: {
      id?: number
      appid?: number
      success?: number
      tags?: { tagid?: number; weight?: number }[]
      tagids?: number[]
      /** Unix seconds; `original_release_date` for a re-release (a 1997 game sold on Steam since 2015). */
      release?: { steam_release_date?: number; original_release_date?: number }
      /** `controller_categoryids`: 28 full controller support, 18 partial (with include_platforms). */
      categories?: { controller_categoryids?: number[]; feature_categoryids?: number[] }
      /** `vr_support`: `vrhmd` (a headset works), `vrhmd_only` (needed), one flag per headset. */
      platforms?: { vr_support?: Record<string, unknown> }
    }[]
  }
}

interface TagListResponse {
  response?: { tags?: { tagid?: number; name?: string }[] }
}

/** Tag id -> English name. */
export async function fetchSteamTagNames(): Promise<Map<number, string>> {
  await limiter.take()
  const body = await httpJson<TagListResponse>(
    buildUrl(GET_TAG_LIST, { language: 'english' }),
    {},
    { timeoutMs: 20_000, retries: 1 }
  )
  const names = new Map<number, string>()
  for (const t of body?.response?.tags ?? []) {
    if (typeof t?.tagid === 'number' && typeof t.name === 'string' && t.name.trim())
      names.set(t.tagid, t.name.trim())
  }
  if (!names.size) throw new Error('Steam returned no tag names')
  return names
}

/** One app as GetItems describes it: its tag ids, strongest first, and the year the game first came out. */
export interface SteamTagItem {
  tagIds: number[]
  year?: number
  /** Controller and VR support (absent when Steam did not say, as for an app it does not show). */
  controls?: SteamControls
  /** Steam lists Valve Anti-Cheat for the app (absent when Steam did not show the app). */
  vac?: boolean
  /** Steam lists the Steam Workshop for the app (absent when Steam did not show the app). */
  workshop?: boolean
}

/** Steam's controller categories (store "Full / Partial Controller Support"). */
const FULL_CONTROLLER = 28
const PARTIAL_CONTROLLER = 18
/** Steam's feature category "Valve Anti-Cheat enabled". */
const VALVE_ANTI_CHEAT = 8
/** Steam's feature category "Steam Workshop". */
const STEAM_WORKSHOP = 30

/** Whether an app's GetItems entry lists Valve Anti-Cheat. */
export function vacOf(item: {
  categories?: { feature_categoryids?: unknown; controller_categoryids?: unknown }
}): boolean {
  const ids = item.categories?.feature_categoryids
  return Array.isArray(ids) && ids.includes(VALVE_ANTI_CHEAT)
}

/** Whether an app's GetItems entry lists the Steam Workshop (the game page's Workshop link). */
export function workshopOf(item: { categories?: { feature_categoryids?: unknown } }): boolean {
  const ids = item.categories?.feature_categoryids
  return Array.isArray(ids) && ids.includes(STEAM_WORKSHOP)
}

/** An app's controller and VR support from its GetItems entry. */
export function controlsOf(item: {
  categories?: { controller_categoryids?: unknown }
  platforms?: { vr_support?: unknown }
}): SteamControls {
  const ids = Array.isArray(item.categories?.controller_categoryids)
    ? (item.categories.controller_categoryids as unknown[])
    : []
  const vr = item.platforms?.vr_support
  const flags = vr && typeof vr === 'object' ? (vr as Record<string, unknown>) : {}
  // Touch (SteamControls.touch, Filters > Controls > Touch) is not set: Steam's GetItems has no touch flag. A future
  // source of touch support sets touch: 'supported' on the controls it returns.
  return {
    controller: ids.includes(FULL_CONTROLLER)
      ? 'full'
      : ids.includes(PARTIAL_CONTROLLER)
        ? 'partial'
        : null,
    vr:
      flags.vrhmd_only === true
        ? 'only'
        : Object.values(flags).some((v) => v === true)
          ? 'supported'
          : null
  }
}

function yearOfUnix(seconds: unknown): number | undefined {
  if (typeof seconds !== 'number' || !(seconds > 0)) return undefined
  return new Date(seconds * 1000).getUTCFullYear()
}

/**
 * Tags (and release year) per app id. An app Steam does not know (or that has no tags) has no tag ids when Steam
 * answered for it, and is absent when Steam left it out.
 */
export async function fetchSteamTagIds(
  appIds: readonly number[]
): Promise<Map<number, SteamTagItem>> {
  const out = new Map<number, SteamTagItem>()
  if (!appIds.length) return out
  await limiter.take()
  const input = {
    ids: appIds.map((appid) => ({ appid })),
    context: { language: 'english', country_code: 'US' },
    data_request: { include_tag_count: MAX_TAGS, include_release: true, include_platforms: true }
  }
  const body = await httpJson<GetItemsResponse>(
    buildUrl(GET_ITEMS, { input_json: JSON.stringify(input) }),
    {},
    { timeoutMs: 20_000, retries: 1 }
  )
  for (const item of body?.response?.store_items ?? []) {
    // `id` is the id asked for; `appid` is 0 for an app Steam does not show.
    const id = item?.id
    if (typeof id !== 'number' || !appIds.includes(id)) continue
    if (item.success !== 1) {
      out.set(id, { tagIds: [] })
      continue
    }
    const weighted = (item.tags ?? [])
      .filter((t) => typeof t?.tagid === 'number')
      .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
      .map((t) => t.tagid as number)
    const year =
      yearOfUnix(item.release?.original_release_date) ??
      yearOfUnix(item.release?.steam_release_date)
    out.set(id, {
      tagIds: weighted.length ? weighted : (item.tagids ?? []).filter((t) => typeof t === 'number'),
      ...(year !== undefined ? { year } : {}),
      controls: controlsOf(item),
      vac: vacOf(item),
      workshop: workshopOf(item)
    })
  }
  return out
}

/** Tag names for tag ids, in order; ids without a name are skipped, duplicates dropped. */
export function tagNamesOf(ids: readonly number[], names: ReadonlyMap<number, string>): string[] {
  const out: string[] = []
  for (const id of ids) {
    const name = names.get(id)
    if (name && !out.includes(name)) out.push(name)
    if (out.length >= MAX_TAGS) break
  }
  return out
}

/**
 * The Steam app a game's tags come from, without asking Steam: its own (a Steam game, or one the Steam scraper or
 * a size lookup matched), or null. `matched`: the id came from a title match rather than the game's store.
 */
export function knownSteamAppId(game: Game): { appId: number; matched: boolean } | null {
  const own = steamAppIdOf(game)
  if (own) return { appId: own, matched: false }
  const scraped = Number.parseInt(game.metadata.sources?.steam ?? '', 10)
  if (Number.isInteger(scraped) && scraped > 0) return { appId: scraped, matched: false }
  const sized = game.metadata.storage?.steamAppId
  if (typeof sized === 'number' && Number.isInteger(sized) && sized > 0)
    return { appId: sized, matched: true }
  return null
}

function titleOf(game: Game): string {
  return game.user.titleOverride?.trim() || game.title
}

/** Year of a 'YYYY…' release date. */
function yearOf(releaseDate: string | undefined): number | undefined {
  const m = releaseDate?.match(/^(\d{4})/)
  return m ? Number.parseInt(m[1], 10) : undefined
}

/**
 * Whether a Steam app found by title is this game: the same year within one, as the install sizes require. Steam's
 * original release date counts for a re-release (a GOG copy of a 1997 game, sold on Steam since 2015); a newer game
 * with the same name (Prey 2006 / Prey 2017) is not it. Either year unknown: taken.
 */
export function sameRelease(gameYear: number | undefined, steamYear: number | undefined): boolean {
  return gameYear === undefined || steamYear === undefined || Math.abs(gameYear - steamYear) <= 1
}

/**
 * Whether a Steam tags record comes from a tags read (or a title search): it names the Steam app, the title searched
 * for, or when it was read / missed. A record without any of them holds only the game page's own Workshop answer
 * (SteamTagsService.checkWorkshop): the game's tags are still unread.
 */
export function steamTagsRead(record: SteamTagsRecord): boolean {
  return (
    record.appId !== undefined ||
    record.title !== undefined ||
    !!record.missedAt ||
    !!record.updatedAt
  )
}

/** Whether a game's tags should be read now. */
export function steamTagsDue(game: Game, now: number): boolean {
  if (NO_STEAM_SOURCES.has(game.source)) return false
  if (!titleOf(game)) return false
  const record = game.metadata.steamTags
  // No record, or only the Workshop answer the game page asked for (checkWorkshop): not read yet.
  if (!record || !steamTagsRead(record)) return true
  const known = knownSteamAppId(game)
  // The game was matched to a Steam app since (a picked metadata match, a size lookup), or to another one.
  if (known && known.appId !== record.appId) return true
  if (!known) {
    // Read through a Steam app the game no longer has (a metadata match replaced): search by title instead.
    if (record.appId !== undefined && record.title === undefined) return true
    // A title search was made for another title (the user changed the title).
    if (record.title !== undefined && record.title !== titleOf(game)) return true
  }
  // Read before the controls were (0.1.127): once more, for the game page's controls badge.
  if (record.appId !== undefined && !record.missedAt && record.controls === undefined) return true
  // Read before Valve Anti-Cheat was (PeerParty): once more, so PeerParty knows whether the game has VAC.
  if (record.appId !== undefined && !record.missedAt && record.vac === undefined) return true
  if (record.missedAt) return now - Date.parse(record.missedAt) >= STEAM_TAGS_MISS_RETRY_MS
  const at = Date.parse(record.updatedAt ?? '')
  return !Number.isFinite(at) || now - at >= STEAM_TAGS_REFRESH_MS
}

export interface SteamTagsDeps {
  library: {
    games(): Game[]
    getGame(id: string): Game | undefined
    applyMetadata(
      id: string,
      update: { metadata?: Partial<GameMetadata> },
      options?: { overwrite?: boolean; quiet?: boolean }
    ): unknown
  }
  settings: { get(): Settings }
  log: Logger
  /** Tests. */
  fetchTagNames?: () => Promise<Map<number, string>>
  fetchTagIds?: (appIds: readonly number[]) => Promise<Map<number, SteamTagItem>>
  findAppId?: (title: string) => Promise<number | undefined>
  /** Waits before each title search (tests: none). */
  searchWait?: () => Promise<void>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface SteamTagsService {
  /** Read the tags of every game that is due; a call while a pass runs makes it look again when it ends. */
  kick(): void
  /** Resolves once no pass is running (tests). */
  idle(): Promise<void>
  /**
   * The user refreshed these games' metadata: one whose Steam answer predates the Workshop flag (workshopUnread) is
   * read again in the next pass, so its game page learns whether it has a Workshop. Nothing reads it in the background.
   */
  refreshed(gameIds: readonly string[]): void
  /**
   * The game's page opened (api.steamWorkshopCheck): a Steam game whose Workshop answer is not known asks Steam for
   * that one app, once per game per run, and keeps the answer (metadata.steamTags.workshop; a paired host's game: in
   * memory, laid over its card by remoteWorkshop). Resolves with the answer, or null when none (not a Steam game, the
   * Steam tags off, asked already, Steam did not answer). Never a background pass; failures stay quiet.
   */
  checkWorkshop(gameId: string): Promise<boolean | null>
  /** This PC's own Workshop answer for a paired host's game the host sent none for (undefined: none). */
  remoteWorkshop(gameId: string): boolean | undefined
  /** The paired hosts' games (streaming service), for checkWorkshop on a host-only game. */
  useRemote(remote: SteamTagsRemote): void
  dispose(): void
}

/** A paired host's games as this PC shows them (streaming service remoteLibrary). */
export interface SteamTagsRemote {
  game(gameId: string): Promise<Game | undefined>
  /** remoteWorkshop's answers changed: the remote library is shown again. */
  changed(): void
}

/**
 * Whether a game's Steam answer was read before the Workshop flag was (the game page's Workshop link): it has a Steam
 * app on record and no `workshop`. Read again only when the user refreshes the game's metadata (SteamTagsService
 * refreshed), never by a background pass.
 */
export function workshopUnread(game: Game): boolean {
  const record = game.metadata.steamTags
  if (!record || record.appId === undefined || record.missedAt) return false
  return record.workshop === undefined
}

export function createSteamTags(deps: SteamTagsDeps): SteamTagsService {
  const { library, settings, log } = deps
  const getNames = deps.fetchTagNames ?? fetchSteamTagNames
  const getIds = deps.fetchTagIds ?? fetchSteamTagIds
  const findAppId = deps.findAppId ?? steamAppIdByTitle
  const searchWait = deps.searchWait ?? (() => searchLimiter.take())
  const now = deps.now ?? Date.now
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let running: Promise<void> | null = null
  let again = false
  let disposed = false
  let names: { at: number; map: Map<number, string> } | null = null
  // Games the user refreshed whose Steam answer predates the Workshop flag (refreshed / workshopUnread).
  const refreshAsked = new Set<string>()
  // Games whose page asked Steam about their Workshop this run (checkWorkshop), and the answers for host-only games.
  const workshopAsked = new Set<string>()
  const remoteAnswers = new Map<string, boolean>()
  let remote: SteamTagsRemote | null = null
  const isDue = (game: Game): boolean =>
    steamTagsDue(game, now()) || (refreshAsked.has(game.id) && workshopUnread(game))

  const enabled = (): boolean => settings.get().scrapers.steamTags.enabled && !disposed

  async function tagNames(): Promise<Map<number, string>> {
    if (!names || now() - names.at >= TAG_LIST_TTL_MS) names = { at: now(), map: await getNames() }
    return names.map
  }

  /** Steam stopped answering: wait, then carry on; false once disabled meanwhile. */
  let failedInRow = 0
  async function failed(what: string, err: unknown): Promise<boolean> {
    log.debug(`${what} failed: ${describeError(err)}`)
    if (++failedInRow < FAILURES_BEFORE_PAUSE) return enabled()
    failedInRow = 0
    log.info(
      `Steam is not answering; tags are read again in ${PAUSE_AFTER_FAILURES_MS / 60_000} min`
    )
    await sleep(PAUSE_AFTER_FAILURES_MS)
    return enabled()
  }

  function write(gameId: string, record: SteamTagsRecord): void {
    refreshAsked.delete(gameId)
    if (!library.getGame(gameId)) return
    // Tags change what the game's page shows; a miss does not.
    library.applyMetadata(
      gameId,
      { metadata: { steamTags: record } },
      { overwrite: true, quiet: !record.tags.length }
    )
  }

  async function pass(): Promise<void> {
    if (!enabled()) return
    const due = library.games().filter(isDue)
    if (!due.length) return
    log.info(`reading the Steam tags of ${due.length} game(s)`)
    failedInRow = 0
    // Games with a Steam app first (batched, fast), then those that need a title search (one request each).
    const withApp: { gameId: string; appId: number }[] = []
    const toSearch: string[] = []
    for (const g of due) {
      const known = knownSteamAppId(g)
      if (known) withApp.push({ gameId: g.id, appId: known.appId })
      else toSearch.push(g.id)
    }
    let tagged = 0

    /**
     * Read and write the tags of a batch. `title`: the app was found by that title, so its release year must match
     * the game's (sameRelease), else the game is recorded as having no Steam app.
     */
    async function readBatch(
      batch: { gameId: string; appId: number; title?: string }[]
    ): Promise<boolean> {
      // Two pauses at most: an answer Steam keeps refusing stops the pass until the next kick.
      for (let attempt = 0; attempt < FAILURES_BEFORE_PAUSE * 2; attempt++) {
        try {
          const map = await tagNames()
          const items = await getIds([...new Set(batch.map((b) => b.appId))])
          failedInRow = 0
          const stamp = new Date(now()).toISOString()
          for (const { gameId, appId, title } of batch) {
            const item = items.get(appId)
            // Left out of the answer: asked again next pass.
            if (!item) continue
            const game = library.getGame(gameId)
            if (!game) continue
            if (title !== undefined && !sameRelease(yearOf(game.metadata.releaseDate), item.year)) {
              log.debug(`"${title}": Steam app ${appId} is from ${item.year}, another game`)
              write(gameId, { tags: [], title, missedAt: stamp })
              continue
            }
            const tags = tagNamesOf(item.tagIds, map)
            write(gameId, {
              tags,
              appId,
              ...(title !== undefined ? { title } : {}),
              ...(tags.length ? { updatedAt: stamp } : { missedAt: stamp }),
              // Always recorded once read (a game Steam says nothing about plays with keyboard and mouse).
              controls: item.controls ?? { controller: null, vr: null },
              ...(item.vac !== undefined ? { vac: item.vac } : {}),
              ...(item.workshop !== undefined ? { workshop: item.workshop } : {})
            })
            if (tags.length) tagged++
          }
          return true
        } catch (err) {
          if (!(await failed('Steam tags', err))) return false
        }
      }
      return false
    }

    for (let i = 0; i < withApp.length; i += STEAM_TAGS_BATCH) {
      if (!enabled()) return
      if (!(await readBatch(withApp.slice(i, i + STEAM_TAGS_BATCH)))) return
    }

    // Other stores' games with no Steam app on record. Like the install sizes: a single Steam copy of the same title
    // in the library decides (two: none); else the Steam game with exactly that title, if its year matches.
    const steamCopies = new Map<string, number[]>()
    for (const g of library.games()) {
      const own = g.source === 'steam' ? steamAppIdOf(g) : null
      if (!own) continue
      const key = sameGameKey(titleOf(g))
      steamCopies.set(key, [...(steamCopies.get(key) ?? []), own])
    }
    let found: { gameId: string; appId: number; title?: string }[] = []
    for (const gameId of toSearch) {
      if (!enabled()) return
      const game = library.getGame(gameId)
      if (!game || !isDue(game)) continue
      const title = titleOf(game)
      const record = game.metadata.steamTags
      const copies = steamCopies.get(sameGameKey(title))
      let entry: { gameId: string; appId: number; title?: string } | null = null
      if (copies) {
        if (copies.length === 1) entry = { gameId, appId: copies[0], title }
      } else if (record?.appId !== undefined && record.title === title && record.updatedAt) {
        // Found by this title before (a refresh): read the same app again without searching.
        entry = { gameId, appId: record.appId, title }
      } else {
        let appId: number | undefined
        try {
          await searchWait()
          appId = await findAppId(title)
          failedInRow = 0
        } catch (err) {
          if (!(await failed('Steam search', err))) return
          continue
        }
        if (appId) entry = { gameId, appId, title }
      }
      if (!entry) {
        write(gameId, { tags: [], title, missedAt: new Date(now()).toISOString() })
        continue
      }
      found.push(entry)
      if (found.length >= STEAM_TAGS_BATCH) {
        if (!(await readBatch(found))) return
        found = []
      }
    }
    if (found.length && !(await readBatch(found))) return
    log.info(`Steam tags: ${tagged} of ${due.length} game(s) have tags now`)
  }

  function start(): void {
    running = (async () => {
      do {
        again = false
        try {
          await pass()
        } catch (err) {
          log.error('Steam tags pass failed', err)
        }
      } while (again && !disposed)
      running = null
    })()
  }

  function kick(): void {
    if (disposed) return
    if (running) {
      again = true
      return
    }
    start()
  }

  return {
    kick,
    async idle() {
      while (running) await running
    },
    refreshed(gameIds) {
      if (disposed) return
      let any = false
      for (const id of gameIds) {
        const game = library.getGame(id)
        if (game && workshopUnread(game)) {
          refreshAsked.add(id)
          any = true
        }
      }
      if (any) kick()
    },
    checkWorkshop,
    remoteWorkshop(gameId) {
      return remoteAnswers.get(gameId)
    },
    useRemote(next) {
      remote = next
    },
    dispose() {
      disposed = true
    }
  }

  async function checkWorkshop(gameId: string): Promise<boolean | null> {
    if (!enabled()) return null
    const local = library.getGame(gameId)
    const game = local ?? (await remote?.game(gameId))
    if (!game) return null
    const known = game.metadata.steamTags?.workshop ?? remoteAnswers.get(gameId)
    if (known !== undefined) return known
    const appId = steamLinksAppId(game)
    if (appId === null || workshopAsked.has(gameId)) return null
    // Once per game per run, answered or not: opening the page again does not ask again.
    workshopAsked.add(gameId)
    let workshop: boolean | undefined
    try {
      workshop = (await getIds([appId])).get(appId)?.workshop
    } catch (err) {
      log.debug(`Steam Workshop of app ${appId}: ${describeError(err)}`)
      return null
    }
    if (workshop === undefined) {
      log.debug(`Steam Workshop of app ${appId}: Steam did not say`)
      return null
    }
    if (disposed) return workshop
    if (!local) {
      remoteAnswers.set(gameId, workshop)
      remote?.changed()
      return workshop
    }
    const current = library.getGame(gameId)
    // Gone meanwhile, or the tags pass wrote an answer while this one was on its way.
    if (!current || current.metadata.steamTags?.workshop !== undefined) return workshop
    // Laid into the game's record (none yet: one holding only this, which steamTagsDue still counts as unread).
    library.applyMetadata(
      gameId,
      { metadata: { steamTags: { ...(current.metadata.steamTags ?? { tags: [] }), workshop } } },
      { overwrite: true }
    )
    return workshop
  }
}
