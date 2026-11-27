import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpError } from '../scrapers/http'
import {
  apiJson,
  OPTIONAL_CALL_RETRY,
  OWNED_IMPORT_DELAYS_MS,
  OWNED_IMPORT_RETRIES,
  runOwnedImport
} from './api'
import { describeForTrace, endpointOf, formatAttempt, stripUrlQueries } from './import-trace'
import {
  classifyStoreFailure,
  SessionExpiredError,
  StoreUnavailableError,
  storeFailureMessage
} from './types'

const STEAM_URL =
  'https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=ABCDEF123&steamid=7656&access_token=TOK123'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('classifyStoreFailure', () => {
  it('treats HTTP 5xx and 429 from the store as store-side', () => {
    expect(
      classifyStoreFailure(
        new HttpError('HTTP 502 Bad Gateway for x', {
          status: 502,
          statusText: 'Bad Gateway',
          url: STEAM_URL
        })
      )
    ).toEqual({ kind: 'server', status: 502, statusText: 'Bad Gateway' })
    // No reason phrase on the wire (HTTP/2): the common one is filled in.
    expect(classifyStoreFailure(new HttpError('HTTP 503', { status: 503, url: 'u' }))).toEqual({
      kind: 'server',
      status: 503,
      statusText: 'Service Unavailable'
    })
    expect(classifyStoreFailure(new HttpError('HTTP 429', { status: 429, url: 'u' }))?.kind).toBe(
      'rate-limit'
    )
  })

  it('treats timeouts and network errors as unreachable, with the detail', () => {
    expect(
      classifyStoreFailure(
        new HttpError('request timed out after 20000 ms (https://x)', { status: 0, url: 'u' })
      )
    ).toEqual({ kind: 'timeout', detail: 'no answer after 20 s' })
    expect(
      classifyStoreFailure(
        new HttpError('network error: ECONNRESET (https://x)', { status: 0, url: 'u' })
      )
    ).toEqual({ kind: 'network', detail: 'ECONNRESET' })
    expect(classifyStoreFailure(new Error('fetch failed'))).toEqual({
      kind: 'network',
      detail: 'fetch failed'
    })
  })

  it('classifies a wrapping error by its cause (Epic catalog lookup)', () => {
    const wrapped = (cause: unknown): Error =>
      new Error('Epic catalog lookup failed: something', { cause })
    expect(
      classifyStoreFailure(
        wrapped(new HttpError('HTTP 502', { status: 502, statusText: 'Bad Gateway', url: 'u' }))
      )
    ).toEqual({ kind: 'server', status: 502, statusText: 'Bad Gateway' })
    expect(
      classifyStoreFailure(
        wrapped(new HttpError('request timed out after 20000 ms (u)', { status: 0, url: 'u' }))
      )?.kind
    ).toBe('timeout')
    expect(
      classifyStoreFailure(wrapped(new HttpError('invalid JSON', { status: 200, url: 'u' })))
    ).toBeNull()
  })

  it('does not treat StoreUnavailableError (store answered oddly, page reader mismatch) as store-side', () => {
    expect(
      classifyStoreFailure(new StoreUnavailableError('Steam', 'the store page did not load'))
    ).toBeNull()
    expect(
      classifyStoreFailure(
        new StoreUnavailableError('the EA app site', "Cannot query field 'originOfferId'")
      )
    ).toBeNull()
  })

  it('leaves auth failures and PlayOut-side errors alone', () => {
    expect(classifyStoreFailure(new SessionExpiredError('Steam'))).toBeNull()
    expect(classifyStoreFailure(new HttpError('HTTP 401', { status: 401, url: 'u' }))).toBeNull()
    expect(
      classifyStoreFailure(new HttpError('invalid JSON from x', { status: 200, url: 'u' }))
    ).toBeNull()
    expect(classifyStoreFailure(new SyntaxError('Unexpected token < in JSON'))).toBeNull()
    expect(classifyStoreFailure(new Error('EPERM: operation not permitted'))).toBeNull()
  })
})

describe('storeFailureMessage', () => {
  it('blames the store, not PlayOut, for a 502', () => {
    const text = storeFailureMessage(
      'Steam',
      { kind: 'server', status: 502, statusText: 'Bad Gateway' },
      10
    )
    expect(text).toBe(
      "Steam's servers are not responding right now (HTTP 502 Bad Gateway). This is a problem on Steam's side, not in PlayOut. Your Steam games are unchanged; PlayOut will try again in 10 minutes."
    )
  })

  it('words rate limits, unreachable stores and the no-retry case', () => {
    expect(
      storeFailureMessage(
        'Epic Games',
        { kind: 'rate-limit', status: 429, statusText: 'Too Many Requests' },
        30
      )
    ).toBe(
      "Epic Games is limiting requests right now (HTTP 429 Too Many Requests). This is on Epic Games' side, not in PlayOut. Your Epic Games games are unchanged; PlayOut will try again in 30 minutes."
    )
    const network = storeFailureMessage('GOG', { kind: 'network', detail: 'ENOTFOUND' })
    expect(network).toMatch(
      /^Could not reach GOG \(ENOTFOUND\)\. Your internet connection may be down/
    )
    expect(network).not.toContain('not in PlayOut')
    expect(network).toMatch(/Import again later to try once more\.$/)
    expect(storeFailureMessage('Xbox', { kind: 'timeout' }, 10)).toMatch(
      /^Xbox did not answer in time\. Xbox's servers may be overloaded, or your internet connection/
    )
  })
})

describe('store-import trace lines', () => {
  it('drops the query string and redacts keys and tokens in the body excerpt', () => {
    const line = formatAttempt('steam', {
      url: STEAM_URL,
      method: 'GET',
      attempt: 1,
      attempts: 4,
      status: 502,
      statusText: 'Bad Gateway',
      durationMs: 312,
      bytes: 157,
      retryAfter: '5',
      retryInMs: 5000,
      body: '<html>\n  <b>502</b> key=ABCDEF123 {"access_token":"TOK123","refresh_token":"R1"} Bearer abc.def</html>'
    })
    expect(line).toBe(
      'steam GET api.steampowered.com/IPlayerService/GetOwnedGames/v1/ attempt 1/4: HTTP 502 Bad Gateway, 312 ms, 157 bytes, retry-after 5, retry in 5000 ms, body: "<html> <b>502</b> key=*** {\\"access_token\\":\\"***\\",\\"refresh_token\\":\\"***\\"} Bearer ***</html>"'
    )
    expect(line).not.toContain('ABCDEF123')
    expect(line).not.toContain('TOK123')
    expect(line).not.toContain('R1')
    expect(endpointOf('not a url?key=1')).toBe('not a url')
  })

  it('describes a network failure', () => {
    expect(
      formatAttempt('gog', {
        url: 'https://embed.gog.com/user/data/games',
        method: 'GET',
        attempt: 4,
        attempts: 4,
        status: 0,
        durationMs: 20001,
        error: 'request timed out after 20000 ms'
      })
    ).toBe(
      'gog GET embed.gog.com/user/data/games attempt 4/4: request timed out after 20000 ms, 20001 ms'
    )
  })
})

describe('runOwnedImport', () => {
  it('gives the owned fetch slower retries (2 s, 6 s, 15 s), the trace hook and the logger', async () => {
    expect(OWNED_IMPORT_RETRIES).toBe(3)
    expect(OWNED_IMPORT_DELAYS_MS).toEqual([2_000, 6_000, 15_000])
    vi.useFakeTimers()
    const fetchMock = vi.fn(
      async () => new Response('down', { status: 502, statusText: 'Bad Gateway' })
    )
    vi.stubGlobal('fetch', fetchMock)
    const attempts: number[] = []
    const lines: string[] = []
    const sleeps: number[] = []
    const run = runOwnedImport(
      {
        retries: OWNED_IMPORT_RETRIES,
        delaysMs: OWNED_IMPORT_DELAYS_MS,
        onAttempt: (a) => {
          attempts.push(a.attempt)
          if (a.retryInMs !== undefined) sleeps.push(a.retryInMs)
        },
        log: { debug: (m: string) => lines.push(m) } as never
      },
      () => apiJson(STEAM_URL, {}, { store: 'Steam' })
    ).catch((e: unknown) => e)
    await vi.runAllTimersAsync()
    const err = (await run) as HttpError
    expect(err).toBeInstanceOf(HttpError)
    expect(err.status).toBe(502)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(attempts).toEqual([1, 2, 3, 4])
    expect(sleeps).toEqual([2_000, 6_000, 15_000])
    expect(lines).toHaveLength(3)
    expect(lines.join('\n')).not.toContain('ABCDEF123')
  })

  it('leaves calls outside an owned import on the default retries', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => new Response('down', { status: 502 }))
    vi.stubGlobal('fetch', fetchMock)
    const run = apiJson(STEAM_URL, {}, { store: 'Steam' }).catch((e: unknown) => e)
    await vi.runAllTimersAsync()
    await run
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('keeps optional side calls (OPTIONAL_CALL_RETRY) on the quick retries inside an owned import', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => new Response('down', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    const sleeps: number[] = []
    const run = runOwnedImport(
      {
        retries: OWNED_IMPORT_RETRIES,
        delaysMs: OWNED_IMPORT_DELAYS_MS,
        onAttempt: (a) => {
          if (a.retryInMs !== undefined) sleeps.push(a.retryInMs)
        }
      },
      () => apiJson(STEAM_URL, {}, { store: 'Epic Games', ...OPTIONAL_CALL_RETRY })
    ).catch((e: unknown) => e)
    await vi.runAllTimersAsync()
    await run
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(sleeps).toEqual([500, 1_000])
  })
})

describe('trace outcome text', () => {
  it('drops the query string (steamid, keys) from URLs in an error', () => {
    const err = new HttpError(`HTTP 502 Bad Gateway for ${STEAM_URL.replace('ABCDEF123', '***')}`, {
      status: 502,
      statusText: 'Bad Gateway',
      url: STEAM_URL
    })
    const text = describeForTrace(err)
    expect(text).toBe(
      'HTTP 502 Bad Gateway for https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/'
    )
    expect(text).not.toContain('steamid=')
    expect(text).not.toContain('?')
    expect(
      stripUrlQueries('network error: ECONNRESET (https://embed.gog.com/a?mediaType=1&page=2)')
    ).toBe('network error: ECONNRESET (https://embed.gog.com/a)')
  })
})
