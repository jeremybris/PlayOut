import { net, protocol } from 'electron'
import { pathToFileURL } from 'url'
import { createLogger } from './logger'
import { MUSIC_SCHEME } from './media/music-protocol'
import { MEDIA_SCHEME } from './scrapers/image-cache'
import { isMediaRevision } from './streaming/remote-library'

const log = createLogger('media')

/** Must run before app.whenReady(). Every custom scheme goes in this one call (Electron keeps only the last call). */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: false
      }
    },
    // The overlay's music player (media/music-protocol.ts).
    MUSIC_SCHEME
  ])
}

/**
 * A paired host's image (Streaming): `media://remote/<hostId>/<hostGameId>/<kind>` resolved to a local file, fetched
 * through the host connection and cached first. Null = 404 (host unknown or offline with nothing cached). `rev`: the
 * URL's `?v=`, the host's revision of the image (a replaced image is fetched again). The file may be an earlier
 * revision's (the host could not be reached): that answer is not to be kept under the new revision's URL.
 */
export type RemoteMediaResolver = (
  hostId: string,
  hostGameId: string,
  kind: string,
  rev?: string
) => Promise<string | null>

/** The three parts of a `media://remote/...` path, decoded; null when the path is not exactly that. */
export function remoteMediaParts(
  pathname: string
): { hostId: string; hostGameId: string; kind: string } | null {
  const parts = pathname.split('/').filter(Boolean)
  if (parts.length !== 3) return null
  try {
    const [hostId, hostGameId, kind] = parts.map((p) => decodeURIComponent(p))
    if (!hostId || !hostGameId || !kind) return null
    return { hostId, hostGameId, kind }
  } catch {
    return null
  }
}

/**
 * The Cache-Control of a served image: kept for good (its URL names its revision), except a stand-in for a revision
 * that could not be fetched, which must not stay bound to that revision's URL.
 */
export function remoteMediaCacheControl(stale: boolean): string {
  return stale ? 'no-store' : 'public, max-age=31536000, immutable'
}

/**
 * Serve media://cache/<safeGameId>/<file> from the image cache. `resolveFile` maps the URL path to an absolute file
 * inside the cache or returns null (traversal attempts, unknown files). With `remote`, media://remote/... serves a
 * paired host's art (validated and cached by the streaming service).
 */
export function installMediaProtocol(
  resolveFile: (urlPath: string) => string | null,
  remote?: RemoteMediaResolver
): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('Bad request', { status: 400 })
    }
    let file: string | null
    // An earlier revision's file served for a new revision's URL (the host did not answer): asked for again next time.
    let stale = false
    if (url.hostname === 'remote') {
      const parts = remote ? remoteMediaParts(url.pathname) : null
      const rev = url.searchParams.get('v') ?? undefined
      file =
        parts && remote
          ? await remote(parts.hostId, parts.hostGameId, parts.kind, rev).catch(() => null)
          : null
      stale = !!file && !isMediaRevision(file, rev)
    } else file = resolveFile(url.pathname)
    if (!file) return new Response('Not found', { status: 404 })
    try {
      const response = await net.fetch(pathToFileURL(file).toString())
      const headers = new Headers(response.headers)
      headers.set('Cache-Control', remoteMediaCacheControl(stale))
      return new Response(response.body, { status: response.status, headers })
    } catch (err) {
      log.warn(`cannot serve ${file}: ${(err as Error).message}`)
      return new Response('Not found', { status: 404 })
    }
  })
}
