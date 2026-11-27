import { basename, dirname } from 'path'
import { withoutXisoSuffix } from '../../shared/convert'
import { STORE_PLATFORMS } from '../../shared/platforms'
import type { Game, Platform } from '../../shared/types'
import { staleGameFolderSize } from '../emulation/rom-scanner'
import { cleanRomTitle, sortTitle } from '../util/text'
import { JsonStore } from './json-store'

export interface SourceState {
  lastScanAt?: string
  error?: string
}

export interface LibraryFile {
  version: 1
  games: Record<string, Game>
  platforms: Record<string, Platform>
  sources: Record<string, SourceState>
}

/**
 * The Xbox app's platform used to have the id 'xbox', which is also ES-DE's id for the emulated original Xbox: the
 * two shared one platform row, so emulated Xbox games were taken for store games (no Filters > Platform entry, the
 * old Xbox tab turned into a store filter). The store's games move to its own platform id; the 'xbox' row, when it is
 * the store's, goes (the ROM scan registers the emulated system's row again).
 */
export function migrateXboxStorePlatform(
  games: Record<string, Game>,
  platforms: Record<string, Platform>
): void {
  const storeId = STORE_PLATFORMS.xbox.id
  let storeGames = false
  for (const game of Object.values(games)) {
    if (game?.source === 'xbox' && game.platformId === 'xbox') game.platformId = storeId
    if (game?.source === 'xbox') storeGames = true
  }
  if (platforms.xbox?.kind === 'store') delete platforms.xbox
  if (storeGames && !platforms[storeId]) platforms[storeId] = STORE_PLATFORMS.xbox
}

/**
 * Before PlayOut 0.1.63 every .bin in a dumped PS4 game folder was a game: the folder's eboot.bin was titled
 * "eboot" (and scraped under that name), its other .bin files were games of their own. The eboot.bin record keeps
 * its id (the scan still lists that file), so its play time, sessions and favourite stay; here it takes the
 * folder's title, and metadata or art fetched for "eboot" is dropped and fetched again under the real title. The
 * other .bin records go with the next ROM scan (or stay greyed when they carry user history).
 */
export function migratePs4EbootTitles(games: Record<string, Game>): void {
  for (const game of Object.values(games)) {
    if (game?.source !== 'rom' || game.platformId !== 'ps4' || !game.romPath) continue
    if (basename(game.romPath).toLowerCase() !== 'eboot.bin') continue
    if (game.title?.trim().toLowerCase() !== 'eboot') continue
    const title = cleanRomTitle(basename(dirname(game.romPath)), false).title
    game.title = title
    game.sortTitle = sortTitle(title)
    if (game.metadataStatus !== 'none') {
      game.metadata = {}
      game.media = {}
      // 'pending' is resumed by the metadata service at startup (or reset to 'none' with auto-scrape off).
      game.metadataStatus = 'pending'
    }
  }
}

/**
 * A trimmed Xbox image ("Halo (USA).xiso.iso", what Trim Games and Convert make of "Halo (USA).iso") was titled
 * "Halo.xiso": its file name less only the last extension. The ".xiso" goes (the scan now leaves it out too), so the
 * game is "Halo" again for recompilation matching (rematched at start), copies and search. Metadata and art stay: a
 * converted game carried them over from the full dump, scraped under its real name. A game whose lookup found nothing
 * (failed, or done with nothing found) is looked up again under the real title. The user's title is theirs: untouched.
 */
export function migrateXisoTitles(games: Record<string, Game>): void {
  for (const game of Object.values(games)) {
    if (game?.source !== 'rom' || typeof game.title !== 'string') continue
    const title = withoutXisoSuffix(game.title.trim()).trim()
    if (title === game.title.trim()) continue
    game.title = title
    game.sortTitle = sortTitle(title)
    const found =
      !!game.metadata?.description ||
      !!game.metadata?.shortDescription ||
      !!game.media?.cover ||
      !!game.media?.hero
    if (game.metadataStatus === 'failed' || (game.metadataStatus === 'done' && !found)) {
      // 'pending' is resumed by the metadata service at startup (or reset to 'none' with auto-scrape off).
      game.metadataStatus = 'pending'
    }
  }
}

/**
 * Before PlayOut measured a dumped PS4 game's whole folder, its size was that of its eboot.bin (a few MB): dropped, so
 * the game page and the Library show no size until the install-size pass measures the folder.
 */
export function dropStaleGameFolderSizes(games: Record<string, Game>): void {
  for (const game of Object.values(games)) {
    if (game && staleGameFolderSize(game)) delete game.installSize
  }
}

function emptyLibrary(): LibraryFile {
  return { version: 1, games: {}, platforms: {}, sources: {} }
}

export class LibraryStore {
  private readonly store: JsonStore<LibraryFile>

  constructor(file: string) {
    this.store = new JsonStore<LibraryFile>({
      file,
      defaults: emptyLibrary,
      normalize: (raw) => {
        const r = raw as Partial<LibraryFile> | null
        if (!r || typeof r !== 'object') return null
        const games = r.games && typeof r.games === 'object' ? r.games : {}
        // MobyGames scores, IGDB ratings and Backloggd ratings were replaced by `reviewScore` (Steam, then IGDB):
        // theirs go with the next save.
        for (const game of Object.values(games)) {
          const metadata = (game as unknown as { metadata?: Record<string, unknown> } | null)
            ?.metadata
          if (metadata && typeof metadata === 'object') {
            delete metadata.moby
            delete metadata.igdbRating
            delete metadata.backloggdRating
          }
        }
        const platforms = r.platforms && typeof r.platforms === 'object' ? r.platforms : {}
        migrateXboxStorePlatform(games, platforms)
        migratePs4EbootTitles(games)
        migrateXisoTitles(games)
        dropStaleGameFolderSizes(games)
        return {
          version: 1,
          games,
          platforms,
          sources: r.sources && typeof r.sources === 'object' ? r.sources : {}
        }
      },
      debounceMs: 400,
      // The cover lane sets media every 250 ms for minutes: still persist every few seconds (a kill or a crash
      // then loses a few seconds of landed covers, not the whole run).
      maxWaitMs: 3000
    })
  }

  load(): Promise<LibraryFile> {
    return this.store.load()
  }

  games(): Game[] {
    return Object.values(this.store.get().games)
  }

  getGame(id: string): Game | undefined {
    return this.store.get().games[id]
  }

  upsert(game: Game): Game {
    this.store.set((d) => {
      d.games[game.id] = game
    })
    return game
  }

  /** Apply a mutation to one game; returns the game or undefined when it does not exist. */
  patch(id: string, mutate: (game: Game) => void): Game | undefined {
    const game = this.store.get().games[id]
    if (!game) return undefined
    this.store.set(() => {
      mutate(game)
    })
    return game
  }

  remove(id: string): boolean {
    const exists = !!this.store.get().games[id]
    if (exists) {
      this.store.set((d) => {
        delete d.games[id]
      })
    }
    return exists
  }

  platforms(): Platform[] {
    return Object.values(this.store.get().platforms)
  }

  setPlatform(platform: Platform): void {
    this.store.set((d) => {
      d.platforms[platform.id] = platform
    })
  }

  sourceState(id: string): SourceState {
    return this.store.get().sources[id] ?? {}
  }

  setSourceState(id: string, state: SourceState): void {
    this.store.set((d) => {
      d.sources[id] = { ...d.sources[id], ...state }
    })
  }

  /** Bulk mutation with a single write. */
  transaction(mutate: (file: LibraryFile) => void): void {
    this.store.set((d) => {
      mutate(d)
    })
  }

  onChange(listener: () => void): () => void {
    return this.store.onChange(() => listener())
  }

  /** `flush()` that tells whether the write reached the disk (false = it failed); never rejects. */
  tryFlush(): Promise<boolean> {
    return this.store.tryFlush()
  }

  flush(): Promise<void> {
    return this.store.flush()
  }
}
