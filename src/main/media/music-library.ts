// The local music folder (docs/home-overlay.md, Media): every audio file under settings.music.folder, listed for
// the overlay's player and served through playout-music:// (music-protocol.ts).
import { promises as fs } from 'fs'
import path from 'path'
import type { MusicTrack } from '@shared/overlay'

/** Formats Chromium plays from a file, lower case without the dot. */
export const MUSIC_EXTENSIONS = ['mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wav'] as const

/** How deep below the music folder the scan goes (artist/album/disc nests are 2-3 deep; 6 leaves room). */
export const MAX_DEPTH = 6
/** A cap so a folder pointed at a whole drive cannot stall the overlay or blow up the IPC payload. */
export const MAX_TRACKS = 20_000
/** The overlay asks on every open; a minute keeps that instant while still noticing new files soon. */
export const CACHE_MS = 60_000

const extensions = new Set<string>(MUSIC_EXTENSIONS)

/** The file's audio extension (lower case, no dot) when it is one PlayOut plays, else null. */
export function musicExtension(file: string): string | null {
  const ext = path.extname(file).slice(1).toLowerCase()
  return extensions.has(ext) ? ext : null
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Folder, then title, naturally ("2 x" before "10 x"); the path breaks ties so the order is stable. */
export function compareTracks(a: MusicTrack, b: MusicTrack): number {
  return (
    collator.compare(a.folder, b.folder) ||
    collator.compare(a.title, b.title) ||
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  )
}

/** A track for `rel` (relative path, forward slashes); `rootName` names files that sit in the folder itself. */
export function trackFor(rel: string, rootName: string): MusicTrack {
  const parts = rel.split('/')
  const file = parts[parts.length - 1]
  return {
    path: rel,
    title: file.slice(0, file.length - path.extname(file).length),
    folder: parts.length > 1 ? parts[parts.length - 2] : rootName
  }
}

/**
 * Scan without the cache. Breadth first, so when the cap is hit it is the deepest files that are missing. Links
 * and junctions are skipped (Node reports junctions as symbolic links on Windows), which also rules out loops.
 * Folders that cannot be read (System Volume Information…) are skipped. A missing folder gives no tracks.
 */
export async function scanMusic(
  folder: string,
  limits: { maxDepth?: number; maxTracks?: number } = {}
): Promise<MusicTrack[]> {
  const maxDepth = limits.maxDepth ?? MAX_DEPTH
  const maxTracks = limits.maxTracks ?? MAX_TRACKS
  const root = path.resolve(folder)
  const rootName = path.basename(root) || root
  const tracks: MusicTrack[] = []
  let level: string[] = [''] // relative folders at this depth, forward slashes, '' = the root
  for (let depth = 0; depth <= maxDepth && level.length > 0; depth++) {
    const next: string[] = []
    for (const rel of level) {
      let entries: import('fs').Dirent[]
      try {
        entries = await fs.readdir(path.join(root, rel), { withFileTypes: true })
      } catch {
        continue
      }
      // Sorted so the cap cuts the same files every time.
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        const child = rel ? `${rel}/${entry.name}` : entry.name
        if (entry.isDirectory()) next.push(child)
        else if (entry.isFile() && musicExtension(entry.name)) {
          tracks.push(trackFor(child, rootName))
          if (tracks.length >= maxTracks) return tracks.sort(compareTracks)
        }
      }
    }
    level = next
  }
  return tracks.sort(compareTracks)
}

interface CacheEntry {
  at: number
  tracks: Promise<MusicTrack[]>
}

const cache = new Map<string, CacheEntry>()

/** Windows paths are case-insensitive, so "D:\Music" and "d:\music\" share one entry. */
function cacheKey(folder: string): string {
  const resolved = path.resolve(folder)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * The folder's tracks, cached per folder for CACHE_MS. A scan in flight is shared, so the overlay opening twice
 * does not walk the folder twice. `now` is for tests.
 */
export function listMusic(folder: string, now: number = Date.now()): Promise<MusicTrack[]> {
  const key = cacheKey(folder)
  const hit = cache.get(key)
  if (hit && now - hit.at < CACHE_MS) return hit.tracks
  const tracks = scanMusic(folder)
  cache.set(key, { at: now, tracks })
  // A failed scan is not kept (scanMusic does not normally throw; this is belt and braces).
  tracks.catch(() => {
    if (cache.get(key)?.tracks === tracks) cache.delete(key)
  })
  return tracks
}

/** Forget the cache: one folder (after the user picks it again) or all of them. */
export function clearMusicCache(folder?: string): void {
  if (folder === undefined) cache.clear()
  else cache.delete(cacheKey(folder))
}
