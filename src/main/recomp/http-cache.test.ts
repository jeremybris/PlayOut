import { mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Logger } from '../logger'
import {
  FetchFailed,
  RECOMP_USER_AGENT,
  cacheKey,
  cachedFetch,
  type CachedFetchDeps
} from './http-cache'

const URL_A = 'https://api.github.com/repos/zelda64recomp/zelda64recomp/releases?per_page=30'
const URL_B = 'https://tanookistudios.com/decomp-buddy/finds.json'
const HOUR = 60 * 60 * 1000

interface Call {
  url: string
  headers: Record<string, string>
}

type Reply =
  | { status: number; body?: string; headers?: Record<string, string> }
  | Error
  | { brokenBody: Error; status?: number }

/** A fetch that answers from a queue and records what it was asked. */
function fakeFetch(replies: Reply[], calls: Call[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) } })
    const r = replies.shift()
    if (!r) throw new Error('no reply queued')
    if (r instanceof Error) throw r
    if ('brokenBody' in r) {
      const err = r.brokenBody
      return {
        ok: true,
        status: r.status ?? 200,
        headers: new Headers(),
        text: () => Promise.reject(err)
      } as unknown as Response
    }
    const body = r.status === 304 || r.status === 204 ? null : (r.body ?? '')
    return new Response(body, { status: r.status, headers: r.headers })
  }) as typeof fetch
}

const log: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

describe('cachedFetch', () => {
  let dir: string
  let now: number
  let calls: Call[]
  const deps = (replies: Reply[], extra: Partial<CachedFetchDeps> = {}): CachedFetchDeps => ({
    dir,
    log,
    now: () => now,
    fetch: fakeFetch(replies, calls),
    ...extra
  })

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'recomp-http-cache-'))
    now = Date.parse('2026-11-14T12:00:00Z')
    calls = []
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('fetches, caches, and answers from the cache while fresh', async () => {
    const first = await cachedFetch(
      URL_A,
      deps([{ status: 200, body: '[1]', headers: { etag: '"abc"' } }]),
      { maxAgeMs: HOUR }
    )
    expect(first).toEqual({ body: '[1]', from: 'network', fetchedAt: now })
    expect(calls[0].headers['User-Agent']).toBe(RECOMP_USER_AGENT)
    expect(calls[0].headers['If-None-Match']).toBeUndefined()

    now += HOUR - 1
    const second = await cachedFetch(URL_A, deps([]), { maxAgeMs: HOUR })
    expect(second).toEqual({ body: '[1]', from: 'cache', fetchedAt: first.fetchedAt })
    expect(calls).toHaveLength(1)

    const files = (await readdir(dir)).sort()
    expect(files).toEqual([`${cacheKey(URL_A)}.body`, `${cacheKey(URL_A)}.meta.json`])
  })

  it('revalidates a stale copy with its ETag and Last-Modified, and a 304 refreshes it', async () => {
    const t0 = now
    await cachedFetch(
      URL_A,
      deps([
        {
          status: 200,
          body: 'old',
          headers: { etag: '"v1"', 'last-modified': 'Fri, 13 Nov 2026 10:00:00 GMT' }
        }
      ]),
      { maxAgeMs: HOUR }
    )
    now += 2 * HOUR
    const res = await cachedFetch(URL_A, deps([{ status: 304 }]), { maxAgeMs: HOUR })
    expect(res).toEqual({ body: 'old', from: 'revalidated', fetchedAt: now })
    expect(calls[1].headers['If-None-Match']).toBe('"v1"')
    expect(calls[1].headers['If-Modified-Since']).toBe('Fri, 13 Nov 2026 10:00:00 GMT')
    // The 304 counts as a fresh confirmation: the next lookup within the hour stays local.
    now += HOUR / 2
    expect((await cachedFetch(URL_A, deps([]), { maxAgeMs: HOUR })).from).toBe('cache')
    expect(t0).toBeLessThan(now)
  })

  it('replaces the copy when the host sends a new one', async () => {
    await cachedFetch(URL_A, deps([{ status: 200, body: 'v1', headers: { etag: '"1"' } }]), {
      maxAgeMs: 0
    })
    const res = await cachedFetch(
      URL_A,
      deps([{ status: 200, body: 'v2', headers: { etag: '"2"' } }]),
      {
        maxAgeMs: 0
      }
    )
    expect(res.body).toBe('v2')
    expect(res.from).toBe('network')
    const meta = JSON.parse(await readFile(join(dir, `${cacheKey(URL_A)}.meta.json`), 'utf8'))
    expect(meta).toMatchObject({ url: URL_A, etag: '"2"', fetchedAt: now })
  })

  it('revalidates a fresh copy when forced', async () => {
    await cachedFetch(URL_A, deps([{ status: 200, body: 'x', headers: { etag: '"e"' } }]), {
      maxAgeMs: HOUR
    })
    const res = await cachedFetch(URL_A, deps([{ status: 304 }]), { maxAgeMs: HOUR, force: true })
    expect(res.from).toBe('revalidated')
    expect(calls).toHaveLength(2)
  })

  it('sends extra headers', async () => {
    await cachedFetch(URL_A, deps([{ status: 200, body: '' }]), {
      maxAgeMs: 0,
      headers: { Accept: 'application/vnd.github+json' }
    })
    expect(calls[0].headers.Accept).toBe('application/vnd.github+json')
    expect(calls[0].headers['User-Agent']).toBe(RECOMP_USER_AGENT)
  })

  it('uses the cached copy of any age when the host cannot be reached', async () => {
    const t0 = now
    await cachedFetch(URL_B, deps([{ status: 200, body: 'catalog' }]), { maxAgeMs: HOUR })
    now += 30 * 24 * HOUR
    const res = await cachedFetch(URL_B, deps([new Error('ECONNRESET')]), { maxAgeMs: HOUR })
    expect(res).toEqual({ body: 'catalog', from: 'offline', fetchedAt: t0 })
  })

  it('uses the cached copy when the host answers with an error', async () => {
    await cachedFetch(URL_B, deps([{ status: 200, body: 'catalog' }]), { maxAgeMs: 0 })
    const res = await cachedFetch(URL_B, deps([{ status: 502, body: 'bad gateway' }]), {
      maxAgeMs: 0
    })
    expect(res.from).toBe('offline')
    expect(res.body).toBe('catalog')
  })

  it('throws FetchFailed when the host fails and nothing is cached', async () => {
    const err = await cachedFetch(URL_B, deps([new Error('getaddrinfo ENOTFOUND')]), {
      maxAgeMs: 0
    }).catch((e) => e)
    expect(err).toBeInstanceOf(FetchFailed)
    expect(err.message).toBe('tanookistudios.com could not be reached: getaddrinfo ENOTFOUND')
    expect(err.status).toBeNull()
    expect(err.rateLimited).toBe(false)

    const http = await cachedFetch(URL_B, deps([{ status: 500 }]), { maxAgeMs: 0 }).catch((e) => e)
    expect(http).toBeInstanceOf(FetchFailed)
    expect(http.message).toBe('tanookistudios.com answered HTTP 500')
    expect(http.status).toBe(500)
  })

  it("recognizes GitHub's rate limit", async () => {
    const err = await cachedFetch(
      URL_A,
      deps([{ status: 403, headers: { 'x-ratelimit-remaining': '0' } }]),
      { maxAgeMs: 0 }
    ).catch((e) => e)
    expect(err).toBeInstanceOf(FetchFailed)
    expect(err.rateLimited).toBe(true)
    expect(err.message).toMatch(/GitHub's limit/)

    const forbidden = await cachedFetch(URL_A, deps([{ status: 403 }]), { maxAgeMs: 0 }).catch(
      (e) => e
    )
    expect(forbidden.rateLimited).toBe(false)

    const other = await cachedFetch(URL_B, deps([{ status: 429 }]), { maxAgeMs: 0 }).catch((e) => e)
    expect(other.rateLimited).toBe(true)
    expect(other.message).toBe(
      'tanookistudios.com is turning away requests for now; try again later'
    )
  })

  it('caches a 404 as an empty body (a repo without a README)', async () => {
    const res = await cachedFetch(URL_A, deps([{ status: 404, body: 'Not Found' }]), {
      maxAgeMs: HOUR
    })
    expect(res).toEqual({ body: '', from: 'network', fetchedAt: now })
    expect((await cachedFetch(URL_A, deps([]), { maxAgeMs: HOUR })).body).toBe('')
  })

  it('treats a 404 as a failure when asked, keeping the cached copy', async () => {
    await cachedFetch(URL_B, deps([{ status: 200, body: 'catalog' }]), { maxAgeMs: 0 })
    const res = await cachedFetch(URL_B, deps([{ status: 404 }]), {
      maxAgeMs: 0,
      notFoundIsError: true
    })
    expect(res).toMatchObject({ body: 'catalog', from: 'offline' })
    expect(await readFile(join(dir, `${cacheKey(URL_B)}.body`), 'utf8')).toBe('catalog')

    await rm(join(dir, `${cacheKey(URL_B)}.body`))
    const err = await cachedFetch(URL_B, deps([{ status: 404 }]), {
      maxAgeMs: 0,
      notFoundIsError: true
    }).catch((e) => e)
    expect(err).toBeInstanceOf(FetchFailed)
    expect(err.status).toBe(404)
  })

  it('falls back to the cache when the body breaks off mid-download', async () => {
    await cachedFetch(URL_B, deps([{ status: 200, body: 'catalog' }]), { maxAgeMs: 0 })
    const res = await cachedFetch(URL_B, deps([{ brokenBody: new Error('terminated') }]), {
      maxAgeMs: 0
    })
    expect(res).toMatchObject({ body: 'catalog', from: 'offline' })

    await rm(join(dir, `${cacheKey(URL_B)}.body`))
    const err = await cachedFetch(URL_B, deps([{ brokenBody: new Error('terminated') }]), {
      maxAgeMs: 0
    }).catch((e) => e)
    expect(err).toBeInstanceOf(FetchFailed)
  })

  it('passes a caller abort through instead of falling back', async () => {
    await cachedFetch(URL_B, deps([{ status: 200, body: 'catalog' }]), { maxAgeMs: 0 })
    const ac = new AbortController()
    ac.abort()
    const abortErr = new Error('aborted')
    const err = await cachedFetch(URL_B, deps([abortErr], { signal: ac.signal }), {
      maxAgeMs: 0
    }).catch((e) => e)
    expect(err).toBe(abortErr)
  })

  it('ignores a corrupt cache entry', async () => {
    await writeFile(join(dir, `${cacheKey(URL_B)}.meta.json`), '{not json')
    await writeFile(join(dir, `${cacheKey(URL_B)}.body`), 'stale')
    const res = await cachedFetch(URL_B, deps([{ status: 200, body: 'new' }]), { maxAgeMs: HOUR })
    expect(res).toMatchObject({ body: 'new', from: 'network' })
  })

  it('keeps two URLs apart and leaves no temp files behind', async () => {
    await Promise.all([
      cachedFetch(URL_A, deps([{ status: 200, body: 'a' }]), { maxAgeMs: HOUR }),
      cachedFetch(URL_A, deps([{ status: 200, body: 'a' }]), { maxAgeMs: HOUR }),
      cachedFetch(URL_B, deps([{ status: 200, body: 'b' }]), { maxAgeMs: HOUR })
    ])
    expect((await cachedFetch(URL_A, deps([]), { maxAgeMs: HOUR })).body).toBe('a')
    expect((await cachedFetch(URL_B, deps([]), { maxAgeMs: HOUR })).body).toBe('b')
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('makes the cache folder on first write', async () => {
    const nested = join(dir, 'a', 'b')
    await cachedFetch(URL_A, deps([{ status: 200, body: 'x' }], { dir: nested }), {
      maxAgeMs: HOUR
    })
    expect(await readFile(join(nested, `${cacheKey(URL_A)}.body`), 'utf8')).toBe('x')
  })
})

describe('cacheKey', () => {
  it('is stable, short and differs per URL', () => {
    expect(cacheKey(URL_A)).toBe(cacheKey(URL_A))
    expect(cacheKey(URL_A)).toMatch(/^[0-9a-f]{20}$/)
    expect(cacheKey(URL_A)).not.toBe(cacheKey(URL_B))
  })
})
