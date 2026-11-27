// GOG Galaxy's webcache as a local art source (docs/ARCHITECTURE.md §4.6 "Art pipeline", research §13.3): Galaxy
// keeps a vertical cover, a hero and an icon for every game of every connected store (Steam, Epic, GOG, EA/Origin,
// Xbox, Battle.net), owned or not, under `%ProgramData%\GOG.com\Galaxy\webcache\<userId>\<platform>\<externalId>\`.
// The folder is self-describing (kind by file suffix), so `galaxy-2.0.db` is never opened.
import { join } from 'path'
import type { ArtKind, Game } from '../../../shared/types'
import type { Logger } from '../../logger'
import { listDir } from '../../util/fs'
import { knownFolders } from '../../util/paths'
import { sniffForKind } from '../image-sniff'
import type { ArtCandidate, ArtCandidates, ArtIds, LocalArtSource } from '../types'

const SOURCE_ID = 'galaxy-cache' as const

export type GalaxyPlatform = 'steam' | 'epic' | 'gog' | 'origin' | 'xboxone' | 'battlenet'
export const GALAXY_PLATFORMS: GalaxyPlatform[] = [
  'steam',
  'epic',
  'gog',
  'origin',
  'xboxone',
  'battlenet'
]

type GalaxyKind = 'cover' | 'hero' | 'icon'
/** File name suffix per kind: `<sha256>_glx_<suffix>.webp`. */
const SUFFIX: Record<GalaxyKind, string> = {
  cover: '_glx_vertical_cover.webp',
  hero: '_glx_bg_top_padding_7.webp',
  icon: '_glx_square_icon_v2.webp'
}

export interface GalaxyCacheOptions {
  /** Override the webcache root (tests); default `%ProgramData%\GOG.com\Galaxy\webcache`. */
  webcacheDir?: string
  log?: Logger
}

export interface GalaxyCacheSource extends LocalArtSource {
  /** External ids present for a platform, for the `--art-bench` probe. */
  cachedIds(platform: GalaxyPlatform): Promise<string[]>
}

export function defaultGalaxyWebcacheDir(): string {
  return join(knownFolders().programData, 'GOG.com', 'Galaxy', 'webcache')
}

/** The (platform, id) pairs a game can be looked up under, in Galaxy's own id spaces. */
export function galaxyKeysOf(ids: ArtIds): { platform: GalaxyPlatform; id: string }[] {
  const keys: { platform: GalaxyPlatform; id: string }[] = []
  if (ids.steamAppId) keys.push({ platform: 'steam', id: String(ids.steamAppId) })
  if (ids.epicAppName) keys.push({ platform: 'epic', id: ids.epicAppName })
  if (ids.gogProductId) keys.push({ platform: 'gog', id: ids.gogProductId })
  if (ids.eaOfferId) keys.push({ platform: 'origin', id: ids.eaOfferId })
  // Galaxy keys Xbox by its own numeric id, not the PFN or the store id; only numeric values can match a folder.
  for (const xbox of [ids.xboxTitleId, ids.xboxStoreId]) {
    if (xbox && /^\d+$/.test(xbox)) keys.push({ platform: 'xboxone', id: xbox })
  }
  if (ids.battlenetCode) keys.push({ platform: 'battlenet', id: ids.battlenetCode })
  return keys
}

interface GalaxyIndex {
  /** platform -> lower-cased external id -> entry folder. */
  entries: Map<GalaxyPlatform, Map<string, string>>
}

export function createGalaxyCacheSource(options: GalaxyCacheOptions = {}): GalaxyCacheSource {
  const log = options.log
  const webcacheDir = options.webcacheDir ?? defaultGalaxyWebcacheDir()
  let indexPromise: Promise<GalaxyIndex | null> | null = null
  /** Entry folder -> lower-cased file name -> absolute path, memoised per run. */
  const listings = new Map<string, Promise<Map<string, string>>>()

  async function buildIndex(): Promise<GalaxyIndex | null> {
    const started = performance.now()
    // The one numeric folder is the Galaxy user; `common` and `<n>-overlay` are Chromium profiles.
    const users = (await listDir(webcacheDir)).filter(
      (e) => e.isDirectory() && /^\d+$/.test(e.name)
    )
    if (!users.length) return null
    const entries = new Map<GalaxyPlatform, Map<string, string>>()
    let total = 0
    for (const user of users) {
      for (const platform of GALAXY_PLATFORMS) {
        const dir = join(webcacheDir, user.name, platform)
        const map = entries.get(platform) ?? new Map<string, string>()
        for (const e of await listDir(dir)) {
          if (!e.isDirectory()) continue
          const key = e.name.toLowerCase()
          if (!map.has(key)) map.set(key, join(dir, e.name))
        }
        if (map.size) entries.set(platform, map)
        total += map.size
      }
    }
    if (!total) return null
    log?.info(
      `galaxy-cache: indexed ${total} entries over ${entries.size} platforms in ${Math.round(performance.now() - started)} ms`
    )
    return { entries }
  }

  function index(): Promise<GalaxyIndex | null> {
    indexPromise ??= buildIndex()
    return indexPromise
  }

  function listing(dir: string): Promise<Map<string, string>> {
    let pending = listings.get(dir)
    if (!pending) {
      pending = listDir(dir).then((files) => {
        const names = new Map<string, string>()
        for (const f of files) if (f.isFile()) names.set(f.name.toLowerCase(), join(dir, f.name))
        return names
      })
      listings.set(dir, pending)
    }
    return pending
  }

  async function candidate(dir: string, kind: GalaxyKind): Promise<ArtCandidate | null> {
    const suffix = SUFFIX[kind]
    for (const [name, path] of await listing(dir)) {
      if (!name.endsWith(suffix)) continue
      const sniffed = await sniffForKind(path, kind)
      if (!sniffed) continue
      return {
        kind,
        source: SOURCE_ID,
        path,
        width: sniffed.info.width,
        height: sniffed.info.height
      }
    }
    return null
  }

  const source: GalaxyCacheSource = {
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

    async cachedIds(platform) {
      const idx = await index()
      return idx ? [...(idx.entries.get(platform)?.keys() ?? [])] : []
    },

    async lookup(_game: Game, ids: ArtIds, kinds: ArtKind[]) {
      const out: ArtCandidates = {}
      const idx = await index()
      if (!idx) return out
      const dirs: string[] = []
      for (const key of galaxyKeysOf(ids)) {
        const dir = idx.entries.get(key.platform)?.get(key.id.toLowerCase())
        if (dir && !dirs.includes(dir)) dirs.push(dir)
      }
      if (!dirs.length) return out
      for (const kind of kinds) {
        if (kind !== 'cover' && kind !== 'hero' && kind !== 'icon') continue
        for (const dir of dirs) {
          const found = await candidate(dir, kind)
          if (found) {
            out[kind] = [found]
            break
          }
        }
      }
      return out
    }
  }
  return source
}
