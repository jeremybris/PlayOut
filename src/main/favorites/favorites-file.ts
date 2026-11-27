import { promises as fs } from 'fs'
import { basename, join } from 'path'
import { z } from 'zod'
import type { Game } from '../../shared/types'
import type { Logger } from '../logger'
import { favoriteAtMs, MAX_FUTURE_MS, pickFavorite } from '../streaming/favorites-sync'
import { titleKey } from '../streaming/remote-library'
import { renameRetry } from '../util/fs'

/**
 * The favourites list kept in the Emulation folder (<Emulation>\PlayOut\Favorites\<PC>.json), so favourites outlive
 * PlayOut: the Emulation folder is the user's (Documents\Emulation by default, never in the install or data folder),
 * an uninstall leaves it, and a reinstall that starts without library.json gets its favourites back from it as the
 * games come back (scans, imports). It also rides the two-way Emulation folder sync to paired PCs.
 *
 * One file per PC, written only by that PC, so the sync (which keeps the newer copy of a whole file) never makes one
 * PC's changes overwrite another's. Each file is a set of entries, one per game id: a favourite, or a removal (a
 * favourite turned off, kept with its time for a year so an older "on" in another PC's file does not bring it back).
 * Reading merges every file per game by the newest change (favorites-sync.ts pickFavorite: the same rule as the live
 * favourites exchange with paired PCs). Other PCs' files are read only while Settings › Streaming › Sync favourites is
 * on; this PC's own file always is.
 *
 * Game ids are stable across a reinstall (store id; a ROM's path inside the roms folder). An entry whose id is not in
 * the library is kept and matched again later. Only for the sources whose id can change (a manual game: its exe moved;
 * a ROM: its file moved to another folder) does it fall back to the one game of that source and platform with the
 * same title (a ROM: the same file name); a store game (Steam, Epic, GOG…) is matched by its id alone, so an old
 * favourite never lands on another game of the same name. Entries dated more than a day ahead of this PC's clock
 * are ignored (favorites-sync.ts MAX_FUTURE_MS: a wrong clock must not win forever).
 */

export const FAVORITES_DIR = join('PlayOut', 'Favorites')
/** Removals older than this are dropped from this PC's file. */
export const TOMBSTONE_KEEP_MS = 365 * 24 * 60 * 60 * 1000

export interface FavoriteFileEntry {
  id: string
  favorite: boolean
  /** When it last changed (ms; 0 = a favourite from before the time was kept). */
  at: number
  source: string
  platformId: string
  title: string
  /** The store's id (a ROM: its path inside the roms folder). */
  externalId: string
}

export interface FavoritesFile {
  version: 1
  pc: string
  entries: FavoriteFileEntry[]
}

const entrySchema = z.object({
  id: z.string().min(1).max(1024),
  favorite: z.boolean(),
  at: z.number().finite().min(0),
  source: z.string().max(64).default(''),
  platformId: z.string().max(128).default(''),
  title: z.string().max(1024).default(''),
  externalId: z.string().max(4096).default('')
})

/** A file's entries, checked (invalid entries dropped); [] when it is not a favourites file. */
export function parseFavoritesFile(text: string): FavoriteFileEntry[] {
  try {
    const raw = JSON.parse(text) as { entries?: unknown }
    if (!raw || !Array.isArray(raw.entries)) return []
    const out: FavoriteFileEntry[] = []
    for (const item of raw.entries) {
      const parsed = entrySchema.safeParse(item)
      if (parsed.success) out.push(parsed.data)
    }
    return out
  } catch {
    return []
  }
}

/** The file name of a PC's file (its computer name, kept to safe characters). */
export function pcFileName(pc: string): string {
  const safe = pc.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '') || 'PC'
  return `${safe.slice(0, 64)}.json`
}

export function favoritesDir(emulationDir: string): string {
  return join(emulationDir, FAVORITES_DIR)
}

/** Whether `rel` (a path inside the Emulation folder, either slash) is a favourites file. */
export function isFavoritesFilePath(rel: string): boolean {
  const p = rel.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()
  return p.startsWith('playout/favorites/') && p.endsWith('.json') && !p.slice(18).includes('/')
}

/** Entries without those dated more than MAX_FUTURE_MS ahead of `nowMs` (a PC whose clock ran ahead). */
export function withoutFutureEntries(
  entries: FavoriteFileEntry[],
  nowMs: number
): FavoriteFileEntry[] {
  return entries.filter((e) => e.at <= nowMs + MAX_FUTURE_MS)
}

/** A game's entry as the library has it now. */
export function entryOf(game: Game): FavoriteFileEntry {
  return {
    id: game.id,
    favorite: game.favorite,
    at: favoriteAtMs(game),
    source: game.source,
    platformId: game.platformId,
    title: game.title,
    externalId: game.externalId
  }
}

/** Whether a game's favourite is worth an entry: a favourite, or one turned on or off at a known time. */
function worthKeeping(game: Game): boolean {
  return game.favorite || favoriteAtMs(game) > 0
}

/** Which of two entries for one game wins: the newer change; equal times: the favourite. */
function newer(a: FavoriteFileEntry, b: FavoriteFileEntry): FavoriteFileEntry {
  if (a.at !== b.at) return a.at > b.at ? a : b
  return b.favorite && !a.favorite ? b : a
}

/** Every file's entries as one set: per game id, the newest change. */
export function mergeEntries(lists: FavoriteFileEntry[][]): Map<string, FavoriteFileEntry> {
  const out = new Map<string, FavoriteFileEntry>()
  for (const list of lists)
    for (const entry of list) {
      const had = out.get(entry.id)
      out.set(entry.id, had ? newer(had, entry) : entry)
    }
  return out
}

/**
 * The key an entry is matched by when its id is not in the library; null for sources whose ids never change (the
 * stores'): those match by id only.
 */
export function fallbackKey(e: {
  source: string
  platformId: string
  title: string
  externalId: string
}): string | null {
  if (e.source === 'rom') {
    const file = basename(e.externalId.replace(/\\/g, '/')).toLowerCase()
    return file ? `rom|${e.platformId}|${file}` : null
  }
  if (e.source !== 'manual') return null
  const title = titleKey(e.title)
  return title ? `manual|${e.platformId}|${title}` : null
}

/**
 * The favourites to set in the library from the merged entries: for each game, its entry (by id), else the newest of
 * the entries that fall back to it (it being the one game matching their key, with no entry of its own), set when
 * that entry's change wins over the library's (pickFavorite).
 */
export function planRestore(
  games: Game[],
  entries: Map<string, FavoriteFileEntry>
): { id: string; favorite: boolean; at: number }[] {
  const byId = new Map(games.map((g) => [g.id, g]))
  const byKey = new Map<string, Game[]>()
  for (const g of games) {
    if (entries.has(g.id)) continue
    const key = fallbackKey(g)
    if (!key) continue
    const list = byKey.get(key)
    if (list) list.push(g)
    else byKey.set(key, [g])
  }
  // One entry per game: its own, or the newest of those falling back to it (never the Map's order).
  const chosen = new Map<string, { game: Game; entry: FavoriteFileEntry }>()
  for (const entry of entries.values()) {
    let game = byId.get(entry.id)
    if (!game) {
      const key = fallbackKey(entry)
      const candidates = key ? byKey.get(key) : undefined
      if (candidates?.length !== 1) continue
      game = candidates[0]!
    }
    const had = chosen.get(game.id)
    chosen.set(game.id, { game, entry: had ? newer(had.entry, entry) : entry })
  }
  const out: { id: string; favorite: boolean; at: number }[] = []
  for (const { game, entry } of chosen.values()) {
    const mine = { favorite: game.favorite, at: favoriteAtMs(game) }
    if (pickFavorite(mine, { favorite: entry.favorite, at: entry.at }, false) !== 'theirs') continue
    out.push({ id: game.id, favorite: entry.favorite, at: entry.at })
  }
  return out
}

/**
 * This PC's file from the library and the file as it was: every game with a favourite (or a known change) as the
 * library has it, plus the earlier entries of games the library does not have now (they come back with the game),
 * removals older than TOMBSTONE_KEEP_MS dropped. Sorted by id, so an unchanged list writes the same text.
 */
export function buildOwnEntries(
  games: Game[],
  previous: FavoriteFileEntry[],
  nowMs: number
): FavoriteFileEntry[] {
  const out = new Map<string, FavoriteFileEntry>()
  for (const e of previous) out.set(e.id, e)
  for (const g of games) if (worthKeeping(g)) out.set(g.id, entryOf(g))
  return [...out.values()]
    .filter((e) => e.favorite || e.at === 0 || nowMs - e.at < TOMBSTONE_KEEP_MS)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** Writes `text` to `file` through one fixed sibling (`<file>.playout-new`, left out of the Emulation sync). */
export async function writeFileAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.playout-new`
  await fs.writeFile(tmp, text, 'utf8')
  await renameRetry(tmp, file)
}

export interface FavoritesBackupDeps {
  library: {
    games(): Game[]
    setSyncedFavorite(id: string, favorite: boolean, atMs: number): boolean
  }
  /** The Emulation folder in use. */
  emulationDir: () => string
  /** This PC's name (its file's name). */
  pc: string
  /** Read the other PCs' files too (Settings › Streaming › Sync favourites). */
  readOthers: () => boolean
  log: Logger
  now?: () => number
  /** Wait after a library change before writing (ms). */
  debounceMs?: number
  /** Nothing is read or written meanwhile (the Emulation folder is being moved); tried again later. */
  paused?: () => boolean
}

export interface FavoritesBackup {
  /** Restores from the files, then writes this PC's file. */
  start(): Promise<void>
  /** The library changed (any favourite change, games added): written soon; `restore` also re-reads the files. */
  noteLibraryChanged(restore: boolean): void
  /** Restore from the files now (games came back), then write. Resolves when done. */
  restoreNow(): Promise<number>
  /** Write this PC's file now. */
  flush(): Promise<void>
  dispose(): void
}

export function createFavoritesBackup(deps: FavoritesBackupDeps): FavoritesBackup {
  const now = deps.now ?? Date.now
  const debounceMs = deps.debounceMs ?? 1500
  const own = pcFileName(deps.pc)
  let lastWritten: { file: string; text: string } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let restoreWanted = false
  let chain: Promise<unknown> = Promise.resolve()
  let disposed = false

  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = chain.then(task, task)
    chain = next.catch(() => undefined)
    return next
  }

  async function readFiles(
    dir: string
  ): Promise<{ own: FavoriteFileEntry[]; others: FavoriteFileEntry[][] }> {
    const names = await fs.readdir(dir).catch(() => [] as string[])
    let mine: FavoriteFileEntry[] = []
    const others: FavoriteFileEntry[][] = []
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.json')) continue
      const text = await fs.readFile(join(dir, name), 'utf8').catch(() => null)
      if (text === null) continue
      const entries = parseFavoritesFile(text)
      if (name.toLowerCase() === own.toLowerCase()) mine = entries
      else others.push(entries)
    }
    return { own: mine, others }
  }

  async function restore(): Promise<number> {
    const dir = favoritesDir(deps.emulationDir())
    const files = await readFiles(dir)
    const lists = (deps.readOthers() ? [files.own, ...files.others] : [files.own]).map((list) =>
      withoutFutureEntries(list, now())
    )
    const changes = planRestore(deps.library.games(), mergeEntries(lists))
    for (const c of changes) deps.library.setSyncedFavorite(c.id, c.favorite, c.at)
    if (changes.length) deps.log.info(`favourites: ${changes.length} restored from ${dir}`)
    return changes.length
  }

  async function write(): Promise<void> {
    const dir = favoritesDir(deps.emulationDir())
    const file = join(dir, own)
    const existing = await fs.readFile(file, 'utf8').catch(() => null)
    const previous = existing === null ? [] : parseFavoritesFile(existing)
    const entries = buildOwnEntries(deps.library.games(), previous, now())
    const doc: FavoritesFile = { version: 1, pc: deps.pc, entries }
    const text = `${JSON.stringify(doc, null, 1)}\n`
    if (lastWritten && lastWritten.file === file && lastWritten.text === text) return
    // Nothing to keep and no file yet: no empty file.
    if (!entries.length && !previous.length) return
    if (existing !== text) {
      await fs.mkdir(dir, { recursive: true })
      await writeFileAtomic(file, text)
    }
    lastWritten = { file, text }
  }

  const schedule = (): void => {
    if (disposed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      const again = restoreWanted
      restoreWanted = false
      void run(again).catch((err) => deps.log.warn('favourites file could not be written', err))
    }, debounceMs)
    timer.unref?.()
  }

  const run = (withRestore: boolean): Promise<number> =>
    serial(async () => {
      if (deps.paused?.()) {
        // The Emulation folder is moving: tried again once it stands at its new place.
        if (withRestore) restoreWanted = true
        schedule()
        return 0
      }
      let restored = 0
      if (withRestore) restored = await restore()
      await write()
      return restored
    })

  return {
    async start() {
      await run(true).catch((err) =>
        deps.log.warn('favourites file could not be read or written', err)
      )
    },
    noteLibraryChanged(withRestore) {
      if (disposed) return
      if (withRestore) restoreWanted = true
      schedule()
    },
    restoreNow() {
      return run(true)
    },
    async flush() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      await run(restoreWanted).catch((err) =>
        deps.log.warn('favourites file could not be written', err)
      )
      restoreWanted = false
    },
    dispose() {
      disposed = true
      if (timer) clearTimeout(timer)
      timer = null
    }
  }
}
