// Playnite's media as a local art source (docs/ARCHITECTURE.md §4.6 "Art pipeline", research §13.5): when Playnite
// is installed, `%APPDATA%\Playnite\library\files\<playniteGameId>\*` holds the cover / background / icon it
// scraped and `library\games\*.json` (one record per game: `Id`, `GameId` = the store's own id, `CoverImage`,
// `BackgroundImage`, `Icon` as `<playniteGameId>\<file>`, `PluginId` = the library plugin that owns the id) maps a
// store id to that folder. `GameId` is only unique per plugin (itch.io, Amazon, Humble and the ROM importers use
// short numeric ids too), so records are keyed by (plugin, id) with Playnite's well-known plugin GUIDs. Only the
// JSON records are read; Playnite's LiteDB `games.db` is not opened (no native modules).
import { join, normalize } from 'path'
import type { ArtKind, Game } from '../../../shared/types'
import type { Logger } from '../../logger'
import { isDirectory, listDir, readJson } from '../../util/fs'
import { knownFolders } from '../../util/paths'
import { sniffForKind } from '../image-sniff'
import type { ArtCandidate, ArtCandidates, ArtIds, LocalArtSource } from '../types'

const SOURCE_ID = 'playnite-files' as const

type PlayniteKind = 'cover' | 'hero' | 'icon'

interface PlayniteRecord {
  Id?: string
  GameId?: string
  PluginId?: string
  CoverImage?: string
  BackgroundImage?: string
  Icon?: string
}

interface PlayniteEntry {
  id: string
  dir: string
  cover?: string
  hero?: string
  icon?: string
}

export interface PlayniteFilesOptions {
  /** Override the Playnite data folder (tests); default `%APPDATA%\Playnite`. */
  playniteDir?: string
  log?: Logger
}

interface PlayniteIndex {
  filesDir: string
  /** `<plugin guid>|<store id>`, lower-cased -> record. */
  byStoreId: Map<string, PlayniteEntry>
}

/** Playnite's library plugin GUIDs per store (research §13.5). */
export const PLAYNITE_PLUGINS = {
  steam: 'cb91dfc9-b977-43bf-8e70-55f46e410fab',
  gog: 'aebe8b7c-6dc3-4a66-af31-e7375c6b5e9e',
  epic: '00000002-dbd1-46c6-b5d0-b1ba559d10e4',
  ea: '85dd7072-2f20-4e76-a007-41035e390724',
  xbox: '7e4fbb5e-2ae3-48d4-8ba0-6b30e7a4e287',
  battlenet: 'e3c26a3d-d695-4cb7-a769-5ff7612c7edd',
  ubisoft: 'c2f038e5-8b92-4877-91f1-da9094155fc5'
} as const

export function playniteKey(pluginId: string, gameId: string): string {
  return `${pluginId.toLowerCase()}|${gameId.toLowerCase()}`
}

export function defaultPlayniteDir(): string {
  return join(knownFolders().appData, 'Playnite')
}

/** The (plugin, store id) keys a game can be looked up under, lower-cased, in Playnite's per-plugin `GameId` space. */
export function playniteKeysOf(ids: ArtIds): string[] {
  const keys: [string, string | undefined][] = [
    [PLAYNITE_PLUGINS.steam, ids.steamAppId ? String(ids.steamAppId) : undefined],
    [PLAYNITE_PLUGINS.gog, ids.gogProductId],
    [PLAYNITE_PLUGINS.epic, ids.epicAppName],
    [PLAYNITE_PLUGINS.ea, ids.eaOfferId],
    [PLAYNITE_PLUGINS.xbox, ids.xboxStoreId],
    [PLAYNITE_PLUGINS.battlenet, ids.battlenetCode],
    [PLAYNITE_PLUGINS.ubisoft, ids.ubisoftId]
  ]
  return keys.filter((k): k is [string, string] => !!k[1]).map(([p, id]) => playniteKey(p, id))
}

export function createPlayniteFilesSource(options: PlayniteFilesOptions = {}): LocalArtSource {
  const log = options.log
  const playniteDir = options.playniteDir ?? defaultPlayniteDir()
  let indexPromise: Promise<PlayniteIndex | null> | null = null
  const listings = new Map<string, Promise<string[]>>()

  async function buildIndex(): Promise<PlayniteIndex | null> {
    const filesDir = join(playniteDir, 'library', 'files')
    if (!(await isDirectory(filesDir))) return null
    const started = performance.now()
    const byStoreId = new Map<string, PlayniteEntry>()
    const gamesDir = join(playniteDir, 'library', 'games')
    for (const e of await listDir(gamesDir)) {
      if (!e.isFile() || !e.name.toLowerCase().endsWith('.json')) continue
      const record = await readJson<PlayniteRecord>(join(gamesDir, e.name))
      const id = record?.Id?.trim()
      const storeId = record?.GameId?.trim()
      const pluginId = record?.PluginId?.trim()
      if (!id || !storeId || !pluginId) continue
      const file = (value: string | undefined): string | undefined =>
        value?.trim() ? normalize(join(filesDir, value.trim())) : undefined
      const entry: PlayniteEntry = {
        id,
        dir: join(filesDir, id),
        cover: file(record?.CoverImage),
        hero: file(record?.BackgroundImage),
        icon: file(record?.Icon)
      }
      const key = playniteKey(pluginId, storeId)
      if (!byStoreId.has(key)) byStoreId.set(key, entry)
    }
    log?.info(
      `playnite-files: indexed ${byStoreId.size} game records in ${Math.round(performance.now() - started)} ms`
    )
    return { filesDir, byStoreId }
  }

  function index(): Promise<PlayniteIndex | null> {
    indexPromise ??= buildIndex()
    return indexPromise
  }

  function listing(dir: string): Promise<string[]> {
    let pending = listings.get(dir)
    if (!pending) {
      pending = listDir(dir).then((entries) =>
        entries.filter((e) => e.isFile()).map((e) => join(dir, e.name))
      )
      listings.set(dir, pending)
    }
    return pending
  }

  async function candidate(path: string, kind: PlayniteKind): Promise<ArtCandidate | null> {
    const sniffed = await sniffForKind(path, kind)
    if (!sniffed) return null
    return { kind, source: SOURCE_ID, path, width: sniffed.info.width, height: sniffed.info.height }
  }

  return {
    id: SOURCE_ID,

    async isAvailable() {
      return (await index()) !== null
    },

    async index() {
      await index()
    },

    reset() {
      indexPromise = null
      listings.clear()
    },

    async lookup(_game: Game, ids: ArtIds, kinds: ArtKind[]) {
      const out: ArtCandidates = {}
      const idx = await index()
      if (!idx) return out
      let entry: PlayniteEntry | undefined
      for (const key of playniteKeysOf(ids)) {
        entry = idx.byStoreId.get(key)
        if (entry) break
      }
      if (!entry) return out
      for (const kind of kinds) {
        if (kind !== 'cover' && kind !== 'hero' && kind !== 'icon') continue
        // The record's own path first, then any other file in the folder that fits the kind.
        const named = entry[kind]
        let found = named ? await candidate(named, kind) : null
        if (!found) {
          for (const path of await listing(entry.dir)) {
            if (path === named) continue
            found = await candidate(path, kind)
            if (found) break
          }
        }
        if (found) out[kind] = [found]
      }
      return out
    }
  }
}
