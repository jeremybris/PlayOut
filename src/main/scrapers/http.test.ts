import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildUrl,
  HttpError,
  httpJson,
  httpText,
  RateLimiter,
  redactUrl,
  type HttpAttempt
} from './http'

type FetchMock = ReturnType<typeof vi.fn>

function response(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers })
}

function stubFetch(...responses: (Response | Error)[]): FetchMock {
  const mock = vi.fn()
  for (const r of responses) {
    if (r instanceof Error) mock.mockRejectedValueOnce(r)
    else mock.mockResolvedValueOnce(r)
  }
  vi.stubGlobal('fetch', mock)
  return mock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('redactUrl / buildUrl', () => {
  it('masks credential query parameters and keeps the rest', () => {
    const url =
      'https://api.screenscraper.fr/api2/jeuInfos.php?devid=dev&devpassword=s3cret&softname=PlayOut&ssid=me&sspassword=pw&romnom=a%20b.nes'
    const redacted = redactUrl(url)
    expect(redacted).not.toContain('s3cret')
    expect(redacted).not.toContain('=pw')
    expect(redacted).toContain('softname=PlayOut')
    expect(redacted).toContain('romnom=a+b.nes')
    expect(redactUrl('not a url?apikey=abc&x=1')).toBe('not a url?apikey=***&x=1')
    expect(redactUrl('https://example.com/path')).toBe('https://example.com/path')
    // Store-account secrets: OAuth codes and refresh tokens never reach a log line either.
    const oauth = redactUrl(
      'https://auth.gog.com/token?client_id=1&client_secret=2&grant_type=refresh_token&refresh_token=SECRET_REFRESH&code=C0DE&webapi_token=W'
    )
    expect(oauth).not.toContain('SECRET_REFRESH')
    expect(oauth).not.toContain('C0DE')
    expect(oauth).not.toContain('webapi_token=W')
    expect(oauth).toContain('grant_type=refresh_token')
  })

  it('builds URLs and skips undefined values', () => {
    const url = buildUrl('https://api.thegamesdb.net/v1/Games/ByGameName', {
      apikey: 'k',
      name: 'Super Mario Bros. 3',
      'filter[platform]': 7,
      page: undefined,
      include: null
    })
    expect(url).toBe(
      'https://api.thegamesdb.net/v1/Games/ByGameName?apikey=k&name=Super+Mario+Bros.+3&filter%5Bplatform%5D=7'
    )
  })
})

describe('httpJson', () => {
  it('parses JSON and sends a user agent', async () => {
    const mock = stubFetch(response(200, '{"ok":true}'))
    const data = await httpJson<{ ok: boolean }>('https://example.com/x', {
      headers: { Authorization: 'Bearer k' }
    })
    expect(data).toEqual({ ok: true })
    const [url, init] = mock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://example.com/x')
    const headers = init.headers as Headers
    expect(headers.get('user-agent')).toMatch(/^PlayOut\//)
    expect(headers.get('authorization')).toBe('Bearer k')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('retries 429 and 5xx with backoff, honouring Retry-After, then succeeds', async () => {
    const mock = stubFetch(
      response(429, 'slow down', { 'retry-after': '0' }),
      response(503, 'down'),
      response(200, '[1]')
    )
    const start = performance.now()
    const data = await httpJson<number[]>('https://example.com/r', {}, { backoffBaseMs: 5 })
    expect(data).toEqual([1])
    expect(mock).toHaveBeenCalledTimes(3)
    expect(performance.now() - start).toBeGreaterThanOrEqual(5 + 10 - 2)
  })

  it('waits the fixed delaysMs between retries and reports every attempt', async () => {
    stubFetch(
      new Response('bad', { status: 502, statusText: 'Bad Gateway' }),
      new Response('bad', {
        status: 502,
        statusText: 'Bad Gateway',
        headers: { 'retry-after': '0' }
      }),
      response(200, '[1]')
    )
    const attempts: HttpAttempt[] = []
    const retryLines: string[] = []
    const start = performance.now()
    const data = await httpJson<number[]>(
      'https://example.com/r?key=SECRET',
      {},
      {
        retries: 3,
        delaysMs: [20, 40],
        onAttempt: (a) => attempts.push(a),
        log: { debug: (m: string) => retryLines.push(m) } as never
      }
    )
    expect(data).toEqual([1])
    expect(performance.now() - start).toBeGreaterThanOrEqual(20 + 40 - 4)
    expect(attempts.map((a) => [a.attempt, a.attempts, a.status, a.retryInMs])).toEqual([
      [1, 4, 502, 20],
      [2, 4, 502, 40],
      [3, 4, 200, undefined]
    ])
    expect(attempts[0]).toMatchObject({ statusText: 'Bad Gateway', bytes: 3, body: 'bad' })
    expect(attempts[1].retryAfter).toBe('0')
    expect(attempts[2].body).toBeUndefined()
    expect(attempts.every((a) => !a.url.includes('SECRET'))).toBe(true)
    expect(retryLines[0]).toMatch(/HTTP 502 .*retry 1\/3 in 20 ms/)
  })

  it('keeps the reason phrase on the HttpError', async () => {
    stubFetch(new Response('x', { status: 502, statusText: 'Bad Gateway' }))
    const err = (await httpJson('https://example.com/r', {}, { retries: 0 }).catch(
      (e) => e
    )) as HttpError
    expect(err.status).toBe(502)
    expect(err.statusText).toBe('Bad Gateway')
    expect(err.message).toBe('HTTP 502 Bad Gateway for https://example.com/r')
  })

  it('gives up after the configured retries and reports the status, url and body', async () => {
    const mock = stubFetch(response(500, 'boom'), response(500, 'boom'))
    const err = await httpJson(
      'https://example.com/f?apikey=zzz',
      {},
      { retries: 1, backoffBaseMs: 1 }
    ).catch((e) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBe(500)
    expect((err as HttpError).url).toBe('https://example.com/f?apikey=***')
    expect((err as HttpError).message).not.toContain('zzz')
    expect((err as HttpError).body).toBe('boom')
    expect(mock).toHaveBeenCalledTimes(2)
  })

  it('does not retry other 4xx responses', async () => {
    const mock = stubFetch(response(401, '{"success":false,"errors":["Unauthorized"]}'))
    const err = await httpJson('https://example.com/a', {}, { backoffBaseMs: 1 }).catch((e) => e)
    expect((err as HttpError).status).toBe(401)
    expect(mock).toHaveBeenCalledTimes(1)
  })

  it('retries network failures and wraps the final one as HttpError status 0', async () => {
    const failure = new TypeError('fetch failed')
    ;(failure as TypeError & { cause: { code: string } }).cause = { code: 'ECONNREFUSED' }
    const mock = stubFetch(failure, failure)
    const err = await httpText('https://example.com/n', {}, { retries: 1, backoffBaseMs: 1 }).catch(
      (e) => e
    )
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBe(0)
    expect((err as HttpError).message).toContain('ECONNREFUSED')
    expect(mock).toHaveBeenCalledTimes(2)
  })

  it('times out slow responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) =>
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
          )
      )
    )
    const err = await httpText('https://example.com/slow', {}, { timeoutMs: 20, retries: 0 }).catch(
      (e) => e
    )
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).message).toContain('timed out')
  })

  it('reports non-JSON bodies with the status and an excerpt', async () => {
    stubFetch(response(200, 'Erreur de login : Verifier vos identifiants developpeur !'))
    const err = await httpJson('https://example.com/j', {}, { retries: 0 }).catch((e) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBe(200)
    expect((err as HttpError).body).toContain('Erreur de login')
  })

  it('waits on the limiter before every attempt', async () => {
    const limiter = new RateLimiter(1000, 1)
    const take = vi.spyOn(limiter, 'take')
    stubFetch(response(502, 'x'), response(200, '{}'))
    await httpJson('https://example.com/l', {}, { limiter, backoffBaseMs: 1 })
    expect(take).toHaveBeenCalledTimes(2)
  })
})

describe('RateLimiter', () => {
  it('lets a burst through immediately and spaces the rest', async () => {
    const limiter = new RateLimiter(20, 2)
    const start = performance.now()
    await limiter.take()
    await limiter.take()
    expect(performance.now() - start).toBeLessThan(40)
    const order: number[] = []
    await Promise.all([1, 2, 3, 4].map((n) => limiter.take().then(() => order.push(n))))
    const elapsed = performance.now() - start
    // four queued calls at 20/s: slots at 50, 100, 150 and 200 ms after the burst
    expect(elapsed).toBeGreaterThanOrEqual(190)
    expect(elapsed).toBeLessThan(600)
    expect(order).toEqual([1, 2, 3, 4])
  })

  it('refills over time', async () => {
    const limiter = new RateLimiter(50, 1)
    await limiter.take()
    await new Promise((r) => setTimeout(r, 40))
    const start = performance.now()
    await limiter.take()
    expect(performance.now() - start).toBeLessThan(15)
  })

  it('rejects a non-positive rate', () => {
    expect(() => new RateLimiter(0)).toThrow()
  })
})
