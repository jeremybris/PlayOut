// "Refresh missing" (Settings › Metadata) and its automatic twin, a newly saved art key: every game whose metadata
// never finished, plus every matched game missing art (cover, hero, logo, icon), whose missing art only is looked
// for (EnqueueOptions.missingArt). A paired host's game is never queued (its art is the host's).
import { promises as fs } from 'fs'
import { dirname } from 'path'
import { missingArtKinds } from '../../shared/art-sources'
import type { Game, Settings } from '../../shared/types'
import type { Logger } from '../logger'
import { coverMissingRecently } from './metadata-service'
import type { MetadataService, Scraper } from './types'

/**
 * The ids "Refresh missing" names: unfinished metadata, or a matched game missing some art. With `triedSince` (ms), a
 * matched game whose cover look already ran at or after that time (its `coverMissing.at`) is left out.
 */
export function missingTargets(games: readonly Game[], triedSince?: number): string[] {
  return games
    .filter((g) => !g.remote && (g.metadataStatus !== 'done' || missingArtKinds(g).length > 0))
    .filter((g) => triedSince === undefined || !triedAtOrAfter(g, triedSince))
    .map((g) => g.id)
}

function triedAtOrAfter(game: Game, since: number): boolean {
  if (game.metadataStatus !== 'done') return false
  const at = game.metadata.coverMissing?.at
  if (!at) return false
  const t = Date.parse(at)
  return Number.isFinite(t) && t >= since
}

/** Queue the "Refresh missing" pass; logs one line (also when nothing is queued) and returns how many were queued. */
export function queueMissing(
  library: { games(): Game[] },
  metadata: Pick<MetadataService, 'enqueue'>,
  log: Pick<Logger, 'info'>,
  why: string,
  opts: {
    /**
     * Leaves out the matched games whose missing art was already looked for at or after this time (ms): the start-up
     * pass after a new art source passes the process start, so a game the metadata resume pass just retried (its
     * `coverMissing` written moments ago) is not asked for a second time.
     */
    skipTriedSince?: number
  } = {}
): number {
  const targets = missingTargets(library.games(), opts.skipTriedSince)
  // The user asked (or just saved a key): games that failed a moment ago and the back-offs of cover-less games are
  // not waited out.
  const queued = targets.length
    ? metadata.enqueue(targets, { retryFailed: true, missingArt: true })
    : 0
  log.info(
    `${why}: ${queued} of ${targets.length} game(s) without finished metadata or with missing art queued`
  )
  return queued
}

/** The ids of the scrapers that can find art by a game's name or hash (the sign-in sources) that are set up. */
function configuredIds(scrapers: readonly Scraper[], settings: Settings): Set<string> {
  const out = new Set<string>()
  for (const s of scrapers) {
    try {
      if (s.isConfigured(settings)) out.add(s.id)
    } catch {
      // A scraper whose check throws counts as not set up.
    }
  }
  return out
}

/** Whether any scraper that can find art by a game's name or hash (the sign-in sources) is set up. */
export function artSourceConfigured(scrapers: readonly Scraper[], settings: Settings): boolean {
  return configuredIds(scrapers, settings).size > 0
}

export interface ArtKeyWatchDeps {
  settings: { get(): Settings; onChange(listener: (next: Settings) => void): unknown }
  /** SteamGridDB, ScreenScraper, IGDB, TheGamesDB: their own `isConfigured` decides. */
  scrapers: readonly Scraper[]
  /** The missing-art pass (`queueMissing`). */
  run(): void
  log: Pick<Logger, 'info'>
  /** Quiet time after the last change before the pass runs (typing a key saves on every keystroke). Default 3 s. */
  delayMs?: number
  /**
   * Remembers the set-up sources across runs (`saveArtSources`): called with the ids whenever they change, a source
   * still waiting for its pass left out (a quit before the pass then runs it at the next start), and after each pass.
   */
  save?(ids: string[]): void
}

export const ART_KEY_DEBOUNCE_MS = 3000

/**
 * Runs the missing-art pass once when an art source goes from not set up to set up (a key or developer login saved
 * in Settings › Metadata), also when another one was set up already (ScreenScraper's login beside a SteamGridDB
 * key), after `delayMs` without further changes. Not at start-up (the state at creation is the baseline), not for
 * other settings, not when the newly set-up sources are cleared again before the delay is over.
 */
export function watchArtKeys(deps: ArtKeyWatchDeps): { dispose(): void } {
  const delayMs = deps.delayMs ?? ART_KEY_DEBOUNCE_MS
  let configured = configuredIds(deps.scrapers, deps.settings.get())
  /** The sources set up since the last pass, waiting out the delay. */
  const added = new Set<string>()
  /** The last list given to `save` (sorted, joined), so an unchanged list is not written again. */
  let savedKey: string | null = null
  const save = (): void => {
    if (!deps.save) return
    const ids = [...configured].filter((id) => !added.has(id)).sort()
    const key = ids.join(',')
    if (key === savedKey) return
    savedKey = key
    deps.save(ids)
  }
  let timer: NodeJS.Timeout | null = null
  let disposed = false
  const cancel = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  deps.settings.onChange((next) => {
    if (disposed) return
    const now = configuredIds(deps.scrapers, next)
    for (const id of now) if (!configured.has(id)) added.add(id)
    configured = now
    // A newly set-up source cleared again before the delay is over is no longer waited for.
    for (const id of [...added]) if (!now.has(id)) added.delete(id)
    save()
    if (!added.size) {
      cancel()
      return
    }
    // Added (or edited again while waiting): wait for the typing to settle.
    cancel()
    timer = setTimeout(() => {
      timer = null
      if (disposed) return
      const ids = [...added].join(', ')
      added.clear()
      deps.log.info(`an art source was set up (${ids}): looking for missing art`)
      deps.run()
      save()
    }, delayMs)
    timer.unref?.()
  })
  return {
    dispose() {
      disposed = true
      cancel()
    }
  }
}

// ---------------------------------------------------------------------------
// The art sources remembered across runs (userData/missing-art.json): a key saved before an update to a version that
// watches for it, or saved just before a quit, still gets its missing-art pass at the next start.
// ---------------------------------------------------------------------------

export const ART_SOURCES_FILE = 'missing-art.json'
/** The start-up check runs a little after the metadata service's resume pass (10 s). */
export const ART_STARTUP_CHECK_MS = 12_000

/** The ids of the art sources set up at the last run; null when there is no file or it cannot be read. */
export async function readSavedArtSources(file: string): Promise<string[] | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as unknown
    const sources = (parsed as { sources?: unknown } | null)?.sources
    if (!Array.isArray(sources)) return null
    return sources.filter((id): id is string => typeof id === 'string')
  } catch {
    return null
  }
}

/**
 * Writes the set-up art sources' ids (never a key or a password). Atomic: written to one fixed sibling
 * (`missing-art.json.tmp`, overwritten each time) and renamed over the file, so a crash mid-write never leaves a
 * truncated list (which would run an unneeded pass at the next start); the sibling is removed when that fails.
 */
export async function saveArtSources(file: string, ids: readonly string[]): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  try {
    await fs.writeFile(tmp, JSON.stringify({ sources: [...ids].sort() }, null, 2), 'utf8')
    await fs.rename(tmp, file)
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined)
    throw err
  }
}

/** Matched games without a cover: due for an automatic look now, or waiting on their back-off. */
export function coverlessCounts(
  games: readonly Game[],
  now = Date.now()
): { due: number; waiting: number } {
  let due = 0
  let waiting = 0
  for (const g of games) {
    if (g.remote || g.metadataStatus !== 'done' || !missingArtKinds(g).includes('cover')) continue
    if (coverMissingRecently(g, now)) waiting++
    else due++
  }
  return { due, waiting }
}

export interface ArtSourcesStartupDeps {
  /** userData/missing-art.json */
  file: string
  settings: { get(): Settings }
  /** SteamGridDB, ScreenScraper, IGDB, TheGamesDB: their own `isConfigured` decides. */
  scrapers: readonly Scraper[]
  library: { games(): Game[] }
  /** The missing-art pass (`queueMissing`). */
  run(): void
  log: Pick<Logger, 'info'>
}

/**
 * The start-up check: logs the set-up art sources (ids only) and the cover-less games due vs waiting on their
 * back-off; runs the missing-art pass once when a source is set up now that was not at the last run (or, with no
 * remembered list yet, when any is), then remembers the current list. Nothing runs when nothing changed. Returns
 * whether the pass ran.
 */
export async function checkArtSourcesSinceLastRun(deps: ArtSourcesStartupDeps): Promise<boolean> {
  const current = [...configuredIds(deps.scrapers, deps.settings.get())].sort()
  const saved = await readSavedArtSources(deps.file)
  const known = new Set(saved ?? [])
  const added = current.filter((id) => !known.has(id))
  const { due, waiting } = coverlessCounts(deps.library.games())
  deps.log.info(
    `art sources set up: ${current.length ? current.join(', ') : 'none'}; games without a cover: ${due} due, ${waiting} waiting on their back-off`
  )
  if (added.length) {
    deps.log.info(`art source set up since last run (${added.join(', ')}): looking for missing art`)
    deps.run()
  }
  if (saved === null || saved.slice().sort().join(',') !== current.join(',')) {
    await saveArtSources(deps.file, current)
  }
  return added.length > 0
}
