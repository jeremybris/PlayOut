// playout-music://track/<relative path> (docs/home-overlay.md, Media): the overlay's <audio> element plays files
// from the music folder through this scheme. Only audio files strictly inside the folder are served, with byte
// ranges so seeking works and long files start at once.
import { createReadStream, promises as fs } from 'fs'
import path from 'path'
import { Readable } from 'stream'
import type { CustomScheme, Protocol } from 'electron'
import type { Logger } from '../logger'
import { musicExtension } from './music-library'

export const MUSIC_SCHEME_NAME = 'playout-music'

/**
 * Must be passed to protocol.registerSchemesAsPrivileged before app ready, in the same call as the other schemes
 * (Electron keeps only the last call). `stream` is what lets <audio> seek with ranges; `standard` gives the URL a
 * host ('track') and a normal path.
 */
export const MUSIC_SCHEME: CustomScheme = {
  scheme: MUSIC_SCHEME_NAME,
  privileges: {
    standard: true,
    secure: true,
    stream: true,
    supportFetchAPI: true,
    bypassCSP: false
  }
}

/** The URL that plays `trackPath` (a MusicTrack.path). Each segment is encoded so '#', '?' and '%' survive. */
export function musicTrackUrl(trackPath: string): string {
  return `${MUSIC_SCHEME_NAME}://track/${trackPath.split('/').map(encodeURIComponent).join('/')}`
}

const CONTENT_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav'
}

/** The Content-Type for a music file, or null when it is not one PlayOut serves. */
export function musicContentType(file: string): string | null {
  const ext = musicExtension(file)
  return ext ? CONTENT_TYPES[ext] : null
}

/**
 * The relative path from a playout-music:// URL path, or null when it is not a plain path inside the folder:
 * empty, '..' or '.' segments, absolute, a drive letter, a UNC or device prefix, NUL, or bad percent-encoding.
 * Both per-segment encoding and a fully encoded path ('%2F') are accepted. Returns forward slashes.
 */
export function musicRelativePath(urlPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath.replace(/^\/+/, ''))
  } catch {
    return null
  }
  if (!decoded || decoded.includes('\0')) return null
  const normal = decoded.replace(/\\/g, '/')
  if (normal.startsWith('/') || /^[a-zA-Z]:/.test(normal) || path.isAbsolute(decoded)) return null
  const parts = normal.split('/')
  // ':' anywhere would also open an NTFS alternate stream ("song.mp3:secret").
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p.includes(':'))) return null
  return parts.join('/')
}

/**
 * True when `child` is strictly below `root` (both absolute, already real paths; the root itself is not inside).
 * Only a whole '..' segment means outside: a file named '..intro.mp3' in the root is inside.
 */
export function isInside(root: string, child: string): boolean {
  const rel = path.relative(root, child)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

export type ByteRange = { start: number; end: number }

/**
 * Parse a Range header against a file of `size` bytes. null = no usable range (serve the whole file, which the
 * RFC allows for anything we do not understand, multiple ranges included); 'unsatisfiable' = answer 416.
 */
export function parseRange(
  header: string | null,
  size: number
): ByteRange | 'unsatisfiable' | null {
  if (!header) return null
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header)
  if (!m) return null
  const [, a, b] = m
  if (a === '' && b === '') return null
  if (a === '') {
    // Suffix: the last N bytes.
    const n = Number(b)
    if (n === 0 || size === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - n), end: size - 1 }
  }
  const start = Number(a)
  if (start >= size) return 'unsatisfiable'
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1)
  if (end < start) return null
  return { start, end }
}

export interface MusicProtocolDeps {
  /** The music folder now (settings.music.folder), read on every request so a new choice applies at once. */
  folder: () => string | null
  log: Logger
}

type Handler = (request: Request) => Promise<Response>

/** The request handler, without Electron (tests call it with a Request). */
export function createMusicHandler(deps: MusicProtocolDeps): Handler {
  const notFound = (): Response => new Response('Not found', { status: 404 })
  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405 })
    }
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('Bad request', { status: 400 })
    }
    const folder = deps.folder()
    if (url.hostname !== 'track' || !folder) return notFound()
    const rel = musicRelativePath(url.pathname)
    const type = rel ? musicContentType(rel) : null
    if (!rel || !type) return notFound()

    let file: string
    let size: number
    try {
      // realpath on both sides: a junction or link inside the folder that leads out of it is refused, and a
      // folder that is itself reached through a link still works.
      const root = await fs.realpath(folder)
      file = await fs.realpath(path.join(root, ...rel.split('/')))
      if (!isInside(root, file)) {
        deps.log.warn(`refused a music path outside the folder: ${rel}`)
        return notFound()
      }
      const stat = await fs.stat(file)
      if (!stat.isFile()) return notFound()
      size = stat.size
    } catch {
      return notFound()
    }

    const headers = new Headers({
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache'
    })
    const range = parseRange(request.headers.get('range'), size)
    if (range === 'unsatisfiable') {
      headers.set('Content-Range', `bytes */${size}`)
      return new Response(null, { status: 416, headers })
    }
    const start = range ? range.start : 0
    const end = range ? range.end : size - 1
    const length = size === 0 ? 0 : end - start + 1
    headers.set('Content-Length', String(length))
    if (range) headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
    const status = range ? 206 : 200
    if (request.method === 'HEAD' || length === 0) return new Response(null, { status, headers })
    try {
      const stream = createReadStream(file, { start, end })
      // When the player seeks or stops, Chromium cancels the body; toWeb's cancel destroys the file stream.
      const body = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>
      return new Response(body, { status, headers })
    } catch (err) {
      deps.log.warn(`cannot serve ${rel}: ${(err as Error).message}`)
      return notFound()
    }
  }
}

/** Serve playout-music:// (after app ready; MUSIC_SCHEME must have been registered before it). */
export function registerMusicProtocol(
  protocol: Pick<Protocol, 'handle'>,
  deps: MusicProtocolDeps
): void {
  protocol.handle(MUSIC_SCHEME_NAME, createMusicHandler(deps))
}
