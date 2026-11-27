// A conditional-GET cache for the recompilation catalogs, GitHub release lists and READMEs: each URL's body is kept
// in a file with its ETag / Last-Modified, a fresh copy is used as is, a stale one is revalidated (If-None-Match /
// If-Modified-Since; a 304 costs nothing against GitHub's 60-an-hour anonymous limit), and when the host cannot be
// reached (or rate-limits) the cached copy of any age is used and reported as offline.
import { createHash, randomBytes } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { Logger } from '../logger'

/** Identifies PlayOut to the hosts (never a browser user agent). */
export const RECOMP_USER_AGENT = 'PlayOut (+https://github.com/jeremybris/PlayOut)'

export interface CachedFetchDeps {
  /** Folder the cache files live in (made on first write). */
  dir: string
  fetch?: typeof fetch
  log: Logger
  signal?: AbortSignal
  /** Clock (tests). */
  now?: () => number
  timeoutMs?: number
}

export interface CachedResult {
  body: string
  /** Where the body came from: the network (200), revalidated (304), the cache (fresh) or a stale copy (offline). */
  from: 'network' | 'revalidated' | 'cache' | 'offline'
  /** When the body was last confirmed by the host (ms). */
  fetchedAt: number
}

interface Meta {
  url: string
  etag?: string
  lastModified?: string
  fetchedAt: number
}

const DEFAULT_TIMEOUT_MS = 60_000

/** The cache file base name of a URL (stable, filesystem-safe). */
export function cacheKey(url: string): string {
  return createHash('sha1').update(url).digest('hex').slice(0, 20)
}

/** An error whose cached copy could not stand in (nothing cached). */
export class FetchFailed extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    /** GitHub's rate limit was hit (403/429 with x-ratelimit-remaining 0, or a 429). */
    readonly rateLimited: boolean
  ) {
    super(message)
    this.name = 'FetchFailed'
  }
}

async function readCached(dir: string, key: string): Promise<{ meta: Meta; body: string } | null> {
  try {
    const [metaText, body] = await Promise.all([
      fs.readFile(join(dir, `${key}.meta.json`), 'utf8'),
      fs.readFile(join(dir, `${key}.body`), 'utf8')
    ])
    return { meta: JSON.parse(metaText) as Meta, body }
  } catch {
    return null
  }
}

async function writeAtomic(file: string, text: string): Promise<void> {
  // Unique per write: two lookups of one URL at once must not share a temp file.
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await fs.writeFile(tmp, text, 'utf8')
    await fs.rename(tmp, file)
  } catch (err) {
    // Windows refuses the rename while another write (or a virus scanner) holds the target: drop the temp file.
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

async function writeCached(
  dir: string,
  key: string,
  meta: Meta,
  body: string | null
): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  if (body !== null) await writeAtomic(join(dir, `${key}.body`), body)
  await writeAtomic(join(dir, `${key}.meta.json`), JSON.stringify(meta))
}

/**
 * GET `url` as text through the cache. `maxAgeMs`: a cached copy younger than this is used without asking the host
 * (0 = always revalidate). `force`: revalidate even a fresh copy. 404 is cached as an empty body (a repo without a
 * README) unless `notFoundIsError`, where it is treated like any other failed answer (a catalog that briefly 404s
 * must not replace the cached copy with nothing). Throws FetchFailed only when the host fails and nothing is cached.
 */
export async function cachedFetch(
  url: string,
  deps: CachedFetchDeps,
  opts: {
    maxAgeMs: number
    force?: boolean
    headers?: Record<string, string>
    notFoundIsError?: boolean
  }
): Promise<CachedResult> {
  const now = deps.now ?? Date.now
  const key = cacheKey(url)
  const cached = await readCached(deps.dir, key)
  if (cached && !opts.force && now() - cached.meta.fetchedAt < opts.maxAgeMs) {
    return { body: cached.body, from: 'cache', fetchedAt: cached.meta.fetchedAt }
  }
  const headers: Record<string, string> = { 'User-Agent': RECOMP_USER_AGENT, ...opts.headers }
  if (cached?.meta.etag) headers['If-None-Match'] = cached.meta.etag
  if (cached?.meta.lastModified) headers['If-Modified-Since'] = cached.meta.lastModified
  const doFetch = deps.fetch ?? fetch
  const timeout = AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout
  let res: Response
  try {
    res = await doFetch(url, { headers, signal, redirect: 'follow' })
  } catch (err) {
    if (deps.signal?.aborted) throw err
    if (cached) {
      deps.log.warn(`${url}: ${(err as Error).message}; using the cached copy`)
      return { body: cached.body, from: 'offline', fetchedAt: cached.meta.fetchedAt }
    }
    throw new FetchFailed(
      `${new URL(url).host} could not be reached: ${(err as Error).message}`,
      null,
      false
    )
  }
  if (res.status === 304 && cached) {
    const meta: Meta = { ...cached.meta, fetchedAt: now() }
    await writeCached(deps.dir, key, meta, null).catch(() => undefined)
    return { body: cached.body, from: 'revalidated', fetchedAt: meta.fetchedAt }
  }
  if (res.status === 404 && !opts.notFoundIsError) {
    const meta: Meta = { url, fetchedAt: now() }
    await writeCached(deps.dir, key, meta, '').catch(() => undefined)
    return { body: '', from: 'network', fetchedAt: meta.fetchedAt }
  }
  if (!res.ok) {
    const rateLimited =
      res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')
    if (cached) {
      deps.log.warn(`${url}: HTTP ${res.status}; using the cached copy`)
      return { body: cached.body, from: 'offline', fetchedAt: cached.meta.fetchedAt }
    }
    const host = new URL(url).host
    throw new FetchFailed(
      rateLimited
        ? host === 'api.github.com'
          ? `GitHub's limit of requests without an account was reached; try again within the hour`
          : `${host} is turning away requests for now; try again later`
        : `${host} answered HTTP ${res.status}`,
      res.status,
      rateLimited
    )
  }
  let body: string
  try {
    body = await res.text()
  } catch (err) {
    // The connection dropped (or timed out) while the body was arriving: the same as not reaching the host.
    if (deps.signal?.aborted) throw err
    if (cached) {
      deps.log.warn(`${url}: ${(err as Error).message}; using the cached copy`)
      return { body: cached.body, from: 'offline', fetchedAt: cached.meta.fetchedAt }
    }
    throw new FetchFailed(
      `${new URL(url).host} could not be reached: ${(err as Error).message}`,
      null,
      false
    )
  }
  const meta: Meta = {
    url,
    etag: res.headers.get('etag') ?? undefined,
    lastModified: res.headers.get('last-modified') ?? undefined,
    fetchedAt: now()
  }
  await writeCached(deps.dir, key, meta, body).catch((err) =>
    deps.log.warn(`could not cache ${url}: ${(err as Error).message}`)
  )
  return { body, from: 'network', fetchedAt: meta.fetchedAt }
}
