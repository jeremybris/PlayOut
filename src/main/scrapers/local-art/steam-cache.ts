// Steam `appcache\librarycache` as a local art source (docs/ARCHITECTURE.md §4.6 "Art pipeline", research §13.2):
// Steam caches library art for every game the user owns or has looked at, not only installed ones, so for an owned
// import this folder answers roughly half of the covers with zero network. `assetcache.vdf` (binary KeyValues) maps
// each appid to its current files; the folder walk is the fallback for apps the index does not list.
import { promises as fs } from 'fs'
import { join } from 'path'
import type { ArtKind, Game, Settings } from '../../../shared/types'
import type { Logger } from '../../logger'
import { detectSteam } from '../../providers/steam'
import { listDir, statSafe } from '../../util/fs'
import { sniffForKind, type ImageInfo } from '../image-sniff'
import type { ArtCandidate, ArtCandidates, ArtIds, LocalArtSource } from '../types'

const SOURCE_ID = 'steam-cache' as const
const SHA1_NAME_RE = /^[0-9a-f]{40}$/i
const ICON_FILE_RE = /^[0-9a-f]{40}\.(jpg|jpeg|png|ico)$/i

/** `assetcache.vdf` indices per kind (research §13.2): `3f` headers, `5f` blur, `6f` markers and `7f` squares are never art. */
const VDF_INDEX: Record<SteamArtKind, string> = { cover: '0f', hero: '1f', logo: '2f', icon: '4f' }

/** File names per kind inside `<appid>\` and `<appid>\<40hex>\`, best first. */
const WALK_FILES: Record<Exclude<SteamArtKind, 'icon'>, string[]> = {
  cover: ['library_600x900_2x.jpg', 'library_600x900.jpg', 'library_capsule.jpg'],
  hero: ['library_hero.jpg'],
  logo: ['logo.png']
}

type SteamArtKind = 'cover' | 'hero' | 'logo' | 'icon'

/**
 * A Steam library-cache cover the Steam client drew itself: a game without portrait art on Steam's servers (F.E.A.R.,
 * most older games) gets the store banner over a blurred copy of it, saved as PNG data under the JPEG name. Steam's
 * own covers are always JPEG, so a PNG cover from the cache is that stand-in, never real art.
 */
export function isSteamDrawnCover(kind: ArtKind, info: Pick<ImageInfo, 'format'>): boolean {
  return kind === 'cover' && info.format === 'png'
}
const STEAM_KINDS: SteamArtKind[] = ['cover', 'hero', 'logo', 'icon']

export interface SteamCacheOptions {
  /** Override the Steam root (tests, the probe); default = the registry detection of `providers/steam.ts`. */
  steamRoot?: () => Promise<string | null>
  log?: Logger
}

export interface SteamCacheSource extends LocalArtSource {
  /** Appids that have an index entry or a folder, for the `--art-bench` probe. */
  cachedAppIds(settings: Settings): Promise<number[]>
}

// ---------------------------------------------------------------------------
// Binary KeyValues
// ---------------------------------------------------------------------------

export type BinaryVdfValue = string | number | BinaryVdfObject
export interface BinaryVdfObject {
  [key: string]: BinaryVdfValue
}

/**
 * Parse Valve's binary KeyValues (type byte, NUL-terminated key, value; `0x08` / `0x0b` end an object). Types:
 * `0x00` object, `0x01` string, `0x02` int32, `0x03` float, `0x04` pointer, `0x07` uint64, `0x0a` int64. 64-bit
 * values are returned as decimal strings. A truncated file ends the current object instead of throwing.
 */
export function parseBinaryVdf(buf: Buffer): BinaryVdfObject {
  let pos = 0
  const cstring = (): string => {
    let end = buf.indexOf(0, pos)
    if (end < 0) end = buf.length
    const s = buf.toString('utf8', pos, end)
    pos = end + 1
    return s
  }
  const object = (): BinaryVdfObject => {
    const out: BinaryVdfObject = {}
    while (pos < buf.length) {
      const type = buf[pos++]
      if (type === 0x08 || type === 0x0b) return out
      const key = cstring()
      switch (type) {
        case 0x00:
          out[key] = object()
          break
        case 0x01:
          out[key] = cstring()
          break
        case 0x02:
        case 0x04:
          if (pos + 4 > buf.length) return out
          out[key] = type === 0x02 ? buf.readInt32LE(pos) : buf.readUInt32LE(pos)
          pos += 4
          break
        case 0x03:
          if (pos + 4 > buf.length) return out
          out[key] = buf.readFloatLE(pos)
          pos += 4
          break
        case 0x07:
        case 0x0a:
          if (pos + 8 > buf.length) return out
          out[key] = (type === 0x07 ? buf.readBigUInt64LE(pos) : buf.readBigInt64LE(pos)).toString()
          pos += 8
          break
        default:
          throw new Error(`binary VDF: unknown type 0x${type.toString(16)} at ${pos - 1}`)
      }
    }
    return out
  }
  return object()
}

/** `assetcache.vdf` -> appid -> kind -> file path relative to `librarycache\<appid>\`. */
export function parseAssetCache(buf: Buffer): Map<number, Partial<Record<SteamArtKind, string>>> {
  const index = new Map<number, Partial<Record<SteamArtKind, string>>>()
  let root = parseBinaryVdf(buf)
  const unnamed = root['']
  if (unnamed && typeof unnamed === 'object') root = unnamed
  for (const [sectionKey, section] of Object.entries(root)) {
    if (!/^\d+$/.test(sectionKey) || typeof section !== 'object') continue
    for (const [appKey, entry] of Object.entries(section)) {
      if (!/^\d+$/.test(appKey) || typeof entry !== 'object') continue
      const files: Partial<Record<SteamArtKind, string>> = {}
      for (const kind of STEAM_KINDS) {
        const value = entry[VDF_INDEX[kind]]
        if (typeof value === 'string' && value && !value.toLowerCase().endsWith('.svg'))
          files[kind] = value.replace(/\//g, '\\')
      }
      if (Object.keys(files).length) index.set(Number(appKey), files)
    }
  }
  return index
}

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

interface SteamCacheIndex {
  cacheDir: string
  /** From `assetcache.vdf`; empty when the file is absent or unreadable. */
  files: Map<number, Partial<Record<SteamArtKind, string>>>
  /** Appids with a folder under `librarycache` (one readdir). */
  folders: Set<number>
}

export function createSteamCacheSource(options: SteamCacheOptions = {}): SteamCacheSource {
  const log = options.log
  const steamRoot = options.steamRoot ?? (async () => (await detectSteam(log)).root)
  let rootPromise: Promise<string | null> | null = null
  let indexPromise: Promise<SteamCacheIndex | null> | null = null
  /** Folder walks already done this run (fallback path only), keyed by appid. */
  const walks = new Map<number, Promise<Map<string, string>[]>>()

  function root(): Promise<string | null> {
    // The install path does not move during a run, so a found root outlives `reset()` (the registry detection is
    // the slow part of the first lookup: ~1 s of reg.exe queries); a miss is asked again next time.
    rootPromise ??= steamRoot()
      .catch((err) => {
        log?.warn(`steam-cache: Steam detection failed: ${(err as Error).message}`)
        return null
      })
      .then((found) => {
        if (found === null) rootPromise = null
        return found
      })
    return rootPromise
  }

  async function buildIndex(): Promise<SteamCacheIndex | null> {
    const steam = await root()
    if (!steam) return null
    const cacheDir = join(steam, 'appcache', 'librarycache')
    const started = performance.now()
    let files = new Map<number, Partial<Record<SteamArtKind, string>>>()
    try {
      files = parseAssetCache(await fs.readFile(join(cacheDir, 'assetcache.vdf')))
    } catch (err) {
      log?.info(
        `steam-cache: no usable assetcache.vdf (${(err as Error).message}); walking folders instead`
      )
    }
    const folders = new Set<number>()
    for (const entry of await listDir(cacheDir)) {
      if (entry.isDirectory() && /^\d+$/.test(entry.name)) folders.add(Number(entry.name))
    }
    log?.info(
      `steam-cache: indexed ${files.size} apps from assetcache.vdf and ${folders.size} folders in ${Math.round(performance.now() - started)} ms`
    )
    return { cacheDir, files, folders }
  }

  function index(): Promise<SteamCacheIndex | null> {
    indexPromise ??= buildIndex()
    return indexPromise
  }

  /**
   * Fallback listing of `<appid>\` and its hash sub-folders, newest first: one map of lower-cased file name ->
   * absolute path per directory. Memoised per appid for the run.
   */
  function walkApp(cacheDir: string, appId: number): Promise<Map<string, string>[]> {
    let pending = walks.get(appId)
    if (!pending) {
      pending = (async () => {
        const appDir = join(cacheDir, String(appId))
        const entries = await listDir(appDir)
        const subdirs = entries.filter((e) => e.isDirectory() && SHA1_NAME_RE.test(e.name))
        const dated = await Promise.all(
          subdirs.map(async (e) => {
            const path = join(appDir, e.name)
            return { path, mtime: (await statSafe(path))?.mtimeMs ?? 0 }
          })
        )
        dated.sort((a, b) => b.mtime - a.mtime)
        const listings: Map<string, string>[] = []
        const toMap = (
          dir: string,
          files: { name: string; isFile(): boolean }[]
        ): Map<string, string> => {
          const names = new Map<string, string>()
          for (const f of files) if (f.isFile()) names.set(f.name.toLowerCase(), join(dir, f.name))
          return names
        }
        listings.push(toMap(appDir, entries))
        for (const d of dated) listings.push(toMap(d.path, await listDir(d.path)))
        // Pre-2024 flat naming next to the folders (research §5.4), last resort.
        const flat = new Map<string, string>()
        for (const [kind, name] of [
          ['library_600x900.jpg', `${appId}_library_600x900.jpg`],
          ['library_hero.jpg', `${appId}_library_hero.jpg`],
          ['logo.png', `${appId}_logo.png`]
        ] as const) {
          flat.set(kind, join(cacheDir, name))
        }
        listings.push(flat)
        return listings
      })()
      walks.set(appId, pending)
    }
    return pending
  }

  async function candidate(path: string, kind: SteamArtKind): Promise<ArtCandidate | null> {
    const sniffed = await sniffForKind(path, kind)
    if (!sniffed) return null
    // Steam's own stand-in for a game with no portrait art: not a cover (the lane goes on to the real sources).
    if (isSteamDrawnCover(kind, sniffed.info)) {
      log?.debug(`steam-cache: ${path} is Steam's drawn stand-in, not a cover`)
      return null
    }
    return {
      kind,
      source: SOURCE_ID,
      path,
      width: sniffed.info.width,
      height: sniffed.info.height
    }
  }

  async function fromWalk(
    cacheDir: string,
    appId: number,
    kind: SteamArtKind
  ): Promise<ArtCandidate | null> {
    const listings = await walkApp(cacheDir, appId)
    if (kind === 'icon') {
      // Only the top-level hash-named file is the 32x32 icon; the same pattern in a sub-folder is the `7f` square.
      for (const [name, path] of listings[0] ?? []) {
        if (!ICON_FILE_RE.test(name)) continue
        const found = await candidate(path, kind)
        if (found) return found
      }
      return null
    }
    for (const name of WALK_FILES[kind]) {
      for (const listing of listings) {
        const path = listing.get(name)
        if (!path) continue
        const found = await candidate(path, kind)
        if (found) return found
      }
    }
    return null
  }

  const source: SteamCacheSource = {
    id: SOURCE_ID,

    async isAvailable() {
      return (await index()) !== null
    },

    async index() {
      await index()
    },

    reset() {
      indexPromise = null
      walks.clear()
    },

    async cachedAppIds() {
      const idx = await index()
      if (!idx) return []
      return [...new Set([...idx.files.keys(), ...idx.folders])].sort((a, b) => a - b)
    },

    async lookup(_game: Game, ids: ArtIds, kinds: ArtKind[]) {
      const appId = ids.steamAppId
      const out: ArtCandidates = {}
      if (!appId) return out
      const idx = await index()
      if (!idx) return out
      const listed = idx.files.get(appId)
      if (!listed && !idx.folders.has(appId)) return out
      for (const kind of kinds) {
        if (kind === 'screenshot') continue
        let found: ArtCandidate | null = null
        const rel = listed?.[kind]
        if (rel) found = await candidate(join(idx.cacheDir, String(appId), rel), kind)
        // Walk the folder when the index does not know the app or names a file that is gone / fails the kind's
        // rules. An indexed app without an entry for the kind has no such file (the index is Steam's own view).
        if (!found && (!listed || rel)) found = await fromWalk(idx.cacheDir, appId, kind)
        if (found) out[kind] = [found]
      }
      return out
    }
  }
  return source
}
