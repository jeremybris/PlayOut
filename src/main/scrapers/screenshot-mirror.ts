import { z } from 'zod'
import type { SteamScreenshot } from '../../shared/types'
import type { Logger } from '../logger'
import { driveFileUrl, driveListingUrl, parseDriveListing } from '../util/google-drive'
import { httpText, USER_AGENT } from './http'

/**
 * The Steam screenshot mirror: a public Google Drive folder holding PlayOut's saved screenshot thumbnails, one
 * `steam_<appId>` folder per game (its `steam-thumb-<key>.jpg` files, named as the image cache names them), plus
 * `steam-screenshots.json`: the games' screenshot lists with the Drive file of each thumbnail. A first-time setup takes
 * both from it: no Steam store read per game (one a second at most) and no Steam CDN download. A game the manifest
 * does not cover (uploaded after it was made) still gets its thumbnails from its folder; only its list comes from
 * Steam. Steam stays the source for anything the mirror lacks or fails to give.
 */
export const SCREENSHOT_MIRROR_FOLDER_ID = '17I39D1VSUFZ2SK_8271tjcG6_BL_ekGk'
export const SCREENSHOT_MANIFEST_NAME = 'steam-screenshots.json'
/** A failed folder read is tried again after this long (not on every game). */
const RETRY_AFTER_MS = 15 * 60 * 1000
const LISTING_TIMEOUT_MS = 30_000
const MANIFEST_TIMEOUT_MS = 2 * 60_000
const GAME_FOLDER = /^steam_(\d+)$/
const THUMB_FILE = /^steam-thumb-([A-Za-z0-9_-]{16})\.jpg$/

/** Steam's own image hosts: the list is shown and downloaded from, so nothing else is taken from the file. */
const STEAM_HOSTS = ['steamstatic.com', 'akamaihd.net', 'steampowered.com', 'steamusercontent.com']
function steamUrl(s: string): boolean {
  try {
    const url = new URL(s)
    const host = url.hostname.toLowerCase()
    return (
      url.protocol === 'https:' && STEAM_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
    )
  } catch {
    return false
  }
}

const manifestSchema = z.object({
  version: z.literal(1),
  games: z.record(
    z.string().regex(/^\d+$/),
    z.array(
      z.object({
        thumbnail: z.string().refine(steamUrl),
        full: z.string().refine(steamUrl),
        drive: z
          .string()
          .regex(/^[\w-]+$/)
          .optional()
      })
    )
  )
})

/** A screenshot as the manifest lists it: Steam's own URLs, plus the Drive file of its thumbnail when mirrored. */
export interface MirroredScreenshot extends SteamScreenshot {
  drive?: string
}

/** What the mirror has for a game. */
export interface MirrorEntry {
  /** The game's screenshot list (the manifest's), null when the manifest does not cover the game. */
  list: MirroredScreenshot[] | null
  /** Drive files of the game's folder by thumbnail key (`steam-thumb-<key>.jpg`), for a game the manifest lacks. */
  files: Map<string, string>
}

export interface ScreenshotMirror {
  /** The game's mirrored list and files (null: the mirror has nothing for it, or could not be read). */
  forApp(appId: number): Promise<MirrorEntry | null>
  /** A mirrored thumbnail's download URL. */
  fileUrl(driveId: string): string
}

export interface ScreenshotMirrorDeps {
  log: Logger
  folderId?: string
  /** Tests. */
  fetchText?: (url: string, timeoutMs: number) => Promise<string>
  now?: () => number
}

interface Root {
  /** Game folders by app id. */
  folders: Map<string, string>
  /** The manifest's games (empty without a manifest, or with an unreadable one). */
  games: Map<string, MirroredScreenshot[]>
}

export function createScreenshotMirror(deps: ScreenshotMirrorDeps): ScreenshotMirror {
  const folderId = deps.folderId ?? SCREENSHOT_MIRROR_FOLDER_ID
  const now = deps.now ?? Date.now
  const fetchText =
    deps.fetchText ??
    ((url: string, timeoutMs: number) =>
      httpText(
        url,
        { headers: { 'User-Agent': USER_AGENT } },
        { timeoutMs, retries: 2, log: deps.log }
      ))
  let loaded: Root | null = null
  let loading: Promise<Root | null> | null = null
  let failedAt = -Infinity

  async function readManifest(fileId: string): Promise<Map<string, MirroredScreenshot[]>> {
    try {
      const raw = await fetchText(driveFileUrl(fileId), MANIFEST_TIMEOUT_MS)
      const parsed = manifestSchema.safeParse(JSON.parse(raw.replace(/^\uFEFF/, '')))
      if (!parsed.success) throw new Error(parsed.error.message)
      return new Map(Object.entries(parsed.data.games))
    } catch (err) {
      // The game folders still serve: only the lists then come from Steam.
      deps.log.warn(
        `screenshot mirror: ${SCREENSHOT_MANIFEST_NAME} unreadable: ${(err as Error).message}`
      )
      return new Map()
    }
  }

  async function load(): Promise<Root> {
    const folders = new Map<string, string>()
    let manifestId: string | null = null
    const listing = await fetchText(driveListingUrl(folderId), LISTING_TIMEOUT_MS)
    for (const entry of parseDriveListing(listing)) {
      const m = GAME_FOLDER.exec(entry.name)
      if (m) folders.set(m[1]!, entry.id)
      else if (entry.name === SCREENSHOT_MANIFEST_NAME) manifestId = entry.id
    }
    const games = manifestId
      ? await readManifest(manifestId)
      : new Map<string, MirroredScreenshot[]>()
    deps.log.info(
      `screenshot mirror: ${folders.size} game folder(s), ${games.size} game list(s) in the manifest`
    )
    return { folders, games }
  }

  function root(): Promise<Root | null> {
    if (loaded) return Promise.resolve(loaded)
    if (now() - failedAt < RETRY_AFTER_MS) return Promise.resolve(null)
    loading ??= load()
      .then((r) => (loaded = r))
      .catch((err: unknown) => {
        deps.log.warn(`screenshot mirror unavailable: ${(err as Error).message}`)
        failedAt = now()
        return null
      })
      .finally(() => {
        loading = null
      })
    return loading
  }

  async function folderFiles(id: string): Promise<Map<string, string>> {
    const files = new Map<string, string>()
    const listing = await fetchText(driveListingUrl(id), LISTING_TIMEOUT_MS)
    for (const entry of parseDriveListing(listing)) {
      const m = THUMB_FILE.exec(entry.name)
      if (m) files.set(m[1]!, entry.id)
    }
    return files
  }

  return {
    async forApp(appId) {
      const r = await root()
      if (!r) return null
      const list = r.games.get(String(appId))
      if (list) return { list: list.map((s) => ({ ...s })), files: new Map() }
      const folder = r.folders.get(String(appId))
      if (!folder) return null
      const files = await folderFiles(folder)
      return files.size ? { list: null, files } : null
    },
    fileUrl: driveFileUrl
  }
}
