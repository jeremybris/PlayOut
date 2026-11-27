import { promises as fs } from 'fs'
import { extname, join, resolve, sep } from 'path'
import type { MediaKind } from '../../shared/types'
import type { Logger } from '../logger'
import { ensureDir, listDir } from '../util/fs'
import { httpBytes, HttpError, redactUrl, USER_AGENT } from './http'
import type { ImageCache, MediaPolicy } from './types'

const DOWNLOAD_TIMEOUT_MS = 45_000
/** Extra attempts for 429 / 5xx and network errors (ScreenScraper answers 429 when its thread limit is hit). */
const DOWNLOAD_RETRIES = 3
/** Statuses that are an answer about the URL itself; any other failure may pass (see `MediaPolicy.onNetworkError`). */
const MISSING_STATUSES = new Set([400, 404, 410])

export const MEDIA_SCHEME = 'media'
export const MEDIA_URL_PREFIX = `${MEDIA_SCHEME}://cache/`

/** Game ids contain ':' which cannot appear in file names or URL hosts; map them to a safe folder name. */
export function safeGameId(gameId: string): string {
  return gameId.replace(/[^A-Za-z0-9_-]/g, '_')
}

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
  'video/mp4': '.mp4',
  'video/webm': '.webm'
}

const KNOWN_EXTS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.svg',
  '.ico',
  '.mp4',
  '.webm'
])

function extFromUrl(url: string): string | null {
  try {
    const ext = extname(new URL(url).pathname).toLowerCase()
    return KNOWN_EXTS.has(ext) ? (ext === '.jpeg' ? '.jpg' : ext) : null
  } catch {
    return null
  }
}

/** File stem of scraped art: `cover`, `screenshot-N`. */
function stemOf(kind: MediaKind, index?: number): string {
  return kind === 'screenshot' ? `screenshot-${index ?? 0}` : kind
}

const STEAM_THUMB_PREFIX = 'steam-thumb-'

/**
 * File stem of a Steam store screenshot's thumbnail (the game page's screenshot row): never starts like a scraped kind's
 * stem, so removing a kind's files (`remove`) leaves it alone.
 */
export function steamThumbnailStem(key: string): string {
  return `${STEAM_THUMB_PREFIX}${key}`
}

/** File stem of the user's own art (`custom-cover`): never touched by the scraped `cover.*` writes or removals. */
export function customStem(kind: Exclude<MediaKind, 'screenshot'>): string {
  return `custom-${kind}`
}

export function createImageCache(deps: { dir: string; log: Logger }): ImageCache {
  const dir = resolve(deps.dir)
  const inflight = new Map<string, Promise<string | null>>()

  function toUrl(sid: string, name: string, mtimeMs: number): string {
    return `${MEDIA_URL_PREFIX}${sid}/${name}?v=${Math.round(mtimeMs)}`
  }

  /** Remove stale variants of the same media kind (e.g. cover.png once cover.jpg is written), keeping `keep`. */
  async function removeVariants(gameDir: string, stem: string, keep: string): Promise<void> {
    for (const entry of await listDir(gameDir)) {
      if (entry.isFile() && entry.name !== keep && entry.name.startsWith(stem + '.')) {
        await fs.rm(join(gameDir, entry.name), { force: true })
      }
    }
  }

  /**
   * Write `<stem>.<ext>` atomically (tmp file, then rename over the old file of the same name) and only then drop
   * the other extensions of the stem: a failed write (ENOSPC, a locked tmp file) leaves the file `media[kind]`
   * points at in place instead of a URL to a deleted file.
   */
  async function writeBuffer(
    gameId: string,
    stem: string,
    ext: string,
    data: Buffer
  ): Promise<string> {
    const sid = safeGameId(gameId)
    const gameDir = join(dir, sid)
    await ensureDir(gameDir)
    const name = `${stem}${ext}`
    const file = join(gameDir, name)
    const tmp = `${file}.${process.pid}.tmp`
    await fs.writeFile(tmp, data)
    await fs.rename(tmp, file)
    await removeVariants(gameDir, stem, name)
    const st = await fs.stat(file)
    return toUrl(sid, name, st.mtimeMs)
  }

  async function copyFile(gameId: string, stem: string, filePath: string): Promise<string | null> {
    try {
      const data = await fs.readFile(filePath)
      if (data.length < 64) return null
      let ext = extname(filePath).toLowerCase()
      if (ext === '.jpeg') ext = '.jpg'
      if (!KNOWN_EXTS.has(ext)) ext = '.jpg'
      return await writeBuffer(gameId, stem, ext, data)
    } catch (err) {
      deps.log.warn(`media copy error ${filePath}: ${(err as Error).message}`)
      return null
    }
  }

  /** Download a remote image into the game's folder as `<stem>.<ext>` (one download per game, stem and URL at a time). */
  function download(
    gameId: string,
    stem: string,
    url: string,
    policy?: MediaPolicy
  ): Promise<string | null> {
    const key = `${gameId}|${stem}|${url}`
    const existing = inflight.get(key)
    if (existing) return existing
    const task = (async (): Promise<string | null> => {
      try {
        const { data, contentType } = await httpBytes(
          url,
          { headers: { 'User-Agent': USER_AGENT, Accept: 'image/*, */*;q=0.8' } },
          {
            timeoutMs: policy?.timeoutMs ?? DOWNLOAD_TIMEOUT_MS,
            retries: policy?.retries ?? DOWNLOAD_RETRIES,
            limiter: policy?.limiter,
            gate: policy?.gate,
            log: deps.log
          }
        )
        const type = (contentType || '').split(';')[0].trim().toLowerCase()
        if (policy?.imageOnly && !type.startsWith('image/')) {
          // An error page in place of the file (Drive's quota and sign-in pages): a failure, never saved as art.
          deps.log.debug(
            `media download got ${type || 'no type'} instead of an image: ${redactUrl(url)}`
          )
          policy.onNetworkError?.(url)
          return null
        }
        const ext = EXT_BY_TYPE[type] || extFromUrl(url) || '.jpg'
        // Tiny bodies are placeholders or error texts (ScreenScraper answers "NOMEDIA" with status 200).
        if (data.length < 64) return null
        return await writeBuffer(gameId, stem, ext, data)
      } catch (err) {
        if (err instanceof HttpError && err.status > 0) {
          // A 404 is the expected answer for a direct URL that does not exist: debug, not a warning per miss.
          const line = `media download failed ${err.status} ${redactUrl(url)}`
          if (err.status === 404) deps.log.debug(line)
          else deps.log.warn(line)
          if (!MISSING_STATUSES.has(err.status)) policy?.onNetworkError?.(url, err.status)
        } else {
          deps.log.warn(`media download error ${redactUrl(url)}: ${(err as Error).message}`)
          policy?.onNetworkError?.(url)
        }
        return null
      } finally {
        inflight.delete(key)
      }
    })()
    inflight.set(key, task)
    return task
  }

  return {
    dir,

    importRemote(gameId, kind, url, index, policy) {
      return download(gameId, stemOf(kind, index), url, policy)
    },

    importSteamThumbnail(gameId, key, url, policy) {
      return download(gameId, steamThumbnailStem(key), url, policy)
    },

    async moveGame(fromId, toId) {
      const from = safeGameId(fromId)
      const to = safeGameId(toId)
      const same = (url: string): string => url
      if (from === to) return same
      const source = join(dir, from)
      const target = join(dir, to)
      try {
        await fs.access(target)
        return same
      } catch {
        // Free: the folder moves there.
      }
      try {
        await fs.rename(source, target)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
          deps.log.warn(`media folder of ${fromId} could not move: ${(err as Error).message}`)
        return same
      }
      const prefix = `${MEDIA_URL_PREFIX}${from}/`
      return (url) =>
        url.startsWith(prefix) ? `${MEDIA_URL_PREFIX}${to}/${url.slice(prefix.length)}` : url
    },

    async pruneSteamThumbnails(gameId, keep) {
      const stems = new Set([...keep].map(steamThumbnailStem))
      const gameDir = join(dir, safeGameId(gameId))
      for (const entry of await listDir(gameDir)) {
        if (!entry.isFile() || !entry.name.startsWith(STEAM_THUMB_PREFIX)) continue
        const stem = entry.name.slice(0, entry.name.length - extname(entry.name).length)
        if (!stems.has(stem)) await fs.rm(join(gameDir, entry.name), { force: true })
      }
    },

    importLocal(gameId, kind, filePath, index) {
      return copyFile(gameId, stemOf(kind, index), filePath)
    },

    importHostCopy(gameId, kind, filePath, index) {
      return copyFile(gameId, `${stemOf(kind, index)}-host`, filePath)
    },

    importCustom(gameId, kind, filePath) {
      return copyFile(gameId, customStem(kind), filePath)
    },

    async remove(gameId, kind, options) {
      const gameDir = join(dir, safeGameId(gameId))
      if (!kind) {
        await fs.rm(gameDir, { recursive: true, force: true })
        return
      }
      const stem = options?.custom ? customStem(kind as Exclude<MediaKind, 'screenshot'>) : kind
      for (const entry of await listDir(gameDir)) {
        if (entry.isFile() && entry.name.startsWith(stem))
          await fs.rm(join(gameDir, entry.name), { force: true })
      }
    },

    resolve(urlPath) {
      let rel: string
      try {
        rel = decodeURIComponent(urlPath)
      } catch {
        return null
      }
      rel = rel.replace(/^\/+/, '').replace(/\//g, sep)
      if (!rel || rel.split(sep).some((part) => part === '..' || part === '')) return null
      const abs = resolve(dir, rel)
      const root = dir.toLowerCase() + sep
      if (!abs.toLowerCase().startsWith(root)) return null
      return abs
    }
  }
}
