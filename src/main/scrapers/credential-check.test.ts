import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import { testCredentials } from './credential-check'

// Response bodies below are the ones the live services returned to deliberately fake credentials (2026-11-03).

interface Call {
  url: URL
  init: RequestInit
}

type Route = (call: Call) => Response | Promise<Response>

function stubFetch(route: Route): Call[] {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const call = { url: new URL(input), init }
      calls.push(call)
      return route(call)
    })
  )
  return calls
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function text(body: string, status = 200, type = 'text/html'): Response {
  return new Response(body, { status, headers: { 'content-type': type } })
}

function networkDown(): never {
  throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SteamGridDB', () => {
  const creds = { apiKey: ' abc123 ' }

  it('accepts a key the API answers with success', async () => {
    const calls = stubFetch(() => json({ success: true, data: { id: 1, name: 'Portal 2' } }))
    expect(await testCredentials('steamgriddb', creds)).toEqual({
      status: 'valid',
      message: 'SteamGridDB: API key works'
    })
    expect(calls).toHaveLength(1)
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer abc123')
  })

  it("rejects a key with SteamGridDB's own 401 and names its reason", async () => {
    stubFetch(() => json({ success: false, errors: ['Invalid API key'] }, 401))
    expect(await testCredentials('steamgriddb', creds)).toEqual({
      status: 'invalid',
      message: "SteamGridDB: API key doesn't work (Invalid API key)"
    })
  })

  it('does not blame the key for a Cloudflare 403 page', async () => {
    stubFetch(() => text('<html>Attention Required! | Cloudflare</html>', 403))
    const result = await testCredentials('steamgriddb', creds)
    expect(result.status).toBe('unchecked')
  })

  it('reports a network failure as unchecked without retrying', async () => {
    const calls = stubFetch(networkDown)
    const result = await testCredentials('steamgriddb', creds)
    expect(result.status).toBe('unchecked')
    expect(result.message).toMatch(/^SteamGridDB: couldn't check right now \(network error/)
    expect(calls).toHaveLength(1)
  })

  it('reports a 503 as unchecked without retrying', async () => {
    const calls = stubFetch(() => text('busy', 503))
    expect((await testCredentials('steamgriddb', creds)).status).toBe('unchecked')
    expect(calls).toHaveLength(1)
  })

  it('sends nothing for an empty key', async () => {
    const calls = stubFetch(() => json({ success: true }))
    expect((await testCredentials('steamgriddb', { apiKey: '  ' })).status).toBe('unchecked')
    expect(calls).toHaveLength(0)
  })
})

describe('IGDB', () => {
  const creds = { clientId: 'id', clientSecret: 'secret' }

  it('accepts credentials Twitch issues a token for, and revokes that token', async () => {
    const calls = stubFetch(({ url }) =>
      url.pathname.endsWith('/token')
        ? json({ access_token: 'tok', expires_in: 5000, token_type: 'bearer' })
        : text('', 200)
    )
    expect(await testCredentials('igdb', creds)).toEqual({
      status: 'valid',
      message: 'IGDB: client ID and secret work'
    })
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[0]!.init.body).toBe(
      'client_id=id&client_secret=secret&grant_type=client_credentials'
    )
    expect(calls[1]!.url.pathname).toBe('/oauth2/revoke')
    expect(calls[1]!.init.body).toBe('client_id=id&token=tok')
  })

  it("rejects Twitch's 400 invalid client", async () => {
    stubFetch(() => json({ status: 400, message: 'invalid client' }, 400))
    expect((await testCredentials('igdb', creds)).status).toBe('invalid')
  })

  it("rejects Twitch's 403 invalid client secret", async () => {
    stubFetch(() => json({ status: 403, message: 'invalid client secret' }, 403))
    expect((await testCredentials('igdb', creds)).status).toBe('invalid')
  })

  it('does not blame the credentials for a non-JSON 403', async () => {
    stubFetch(() => text('<html>blocked</html>', 403))
    expect((await testCredentials('igdb', creds)).status).toBe('unchecked')
  })

  it('needs both fields', async () => {
    const calls = stubFetch(() => json({ access_token: 'tok' }))
    expect((await testCredentials('igdb', { clientId: 'id', clientSecret: '' })).status).toBe(
      'unchecked'
    )
    expect(calls).toHaveLength(0)
  })
})

describe('ScreenScraper', () => {
  const DEV_ERROR = 'Erreur de login : Vérifier vos identifiants développeur !   \n'
  const USER_ERROR = 'Erreur de login : Vérifier les identifiants utilisateurs !   \n'
  const dev = { devId: 'dev', devPassword: 'devpw', user: '', password: '' }
  const full = { ...dev, user: 'me', password: ' pw ' }

  it('checks the developer pair alone through ssinfraInfos', async () => {
    const calls = stubFetch(() => json({ header: {}, response: { serveurs: {} } }))
    expect(await testCredentials('screenscraper', dev)).toEqual({
      status: 'valid',
      message: 'ScreenScraper: developer ID and password work'
    })
    expect(calls[0]!.url.pathname).toBe('/api2/ssinfraInfos.php')
    expect(calls[0]!.url.searchParams.get('devid')).toBe('dev')
    expect(calls[0]!.url.searchParams.has('ssid')).toBe(false)
  })

  it('rejects a developer pair (accented 403 body)', async () => {
    stubFetch(() => text(DEV_ERROR, 403, 'application/json; charset=utf-8'))
    expect(await testCredentials('screenscraper', dev)).toEqual({
      status: 'invalid',
      message: "ScreenScraper: developer ID or password doesn't work"
    })
  })

  it('rejects a developer pair reported as a plain-text 200', async () => {
    stubFetch(() =>
      text(
        'Erreur de login : Verifier vos identifiants developpeur !',
        200,
        'application/json; charset=utf-8'
      )
    )
    expect((await testCredentials('screenscraper', dev)).status).toBe('invalid')
  })

  it('checks all four fields with one ssuserInfos call, password untrimmed', async () => {
    const calls = stubFetch(() => json({ response: { ssuser: { id: 'me', niveau: '1' } } }))
    expect(await testCredentials('screenscraper', full)).toEqual({
      status: 'valid',
      message: 'ScreenScraper: login and developer credentials work'
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url.pathname).toBe('/api2/ssuserInfos.php')
    expect(calls[0]!.url.searchParams.get('sspassword')).toBe(' pw ')
  })

  it('rejects a level-0 account as a wrong login', async () => {
    stubFetch(() => json({ response: { ssuser: { id: 'me', niveau: '0' } } }))
    expect(await testCredentials('screenscraper', full)).toEqual({
      status: 'invalid',
      message: "ScreenScraper: user name or password doesn't work"
    })
  })

  it('tells a wrong user login from a wrong developer pair with a second call', async () => {
    const calls = stubFetch(({ url }) =>
      url.pathname.endsWith('ssuserInfos.php')
        ? text(USER_ERROR, 403)
        : json({ response: { serveurs: {} } })
    )
    expect(await testCredentials('screenscraper', full)).toEqual({
      status: 'invalid',
      message: "ScreenScraper: user name or password doesn't work"
    })
    expect(calls.map((c) => c.url.pathname)).toEqual([
      '/api2/ssuserInfos.php',
      '/api2/ssinfraInfos.php'
    ])
  })

  it('blames the developer pair when ssinfraInfos rejects it too', async () => {
    stubFetch(({ url }) =>
      url.pathname.endsWith('ssuserInfos.php') ? text(USER_ERROR, 403) : text(DEV_ERROR, 403)
    )
    expect((await testCredentials('screenscraper', full)).message).toBe(
      "ScreenScraper: developer ID or password doesn't work"
    )
  })

  it('does not blame the login when the API is closed (401) or out of quota (430)', async () => {
    stubFetch(() => text('API closed for non-members', 401))
    expect((await testCredentials('screenscraper', full)).status).toBe('unchecked')
    stubFetch(() => text('quota', 430))
    expect((await testCredentials('screenscraper', full)).status).toBe('unchecked')
  })

  it('asks for the developer pair before sending anything', async () => {
    const calls = stubFetch(() => json({}))
    const result = await testCredentials('screenscraper', { ...full, devId: '', devPassword: '' })
    expect(result.status).toBe('unchecked')
    expect(result.message).toMatch(/developer ID and password/)
    expect(calls).toHaveLength(0)
  })
})

describe('TheGamesDB', () => {
  const creds = { apiKey: 'k' }

  it('accepts a key and reports the allowance left', async () => {
    const calls = stubFetch(() =>
      json({
        code: 200,
        status: 'Success',
        data: {},
        remaining_monthly_allowance: 2990,
        extra_allowance: 10
      })
    )
    expect(await testCredentials('thegamesdb', creds)).toEqual({
      status: 'valid',
      message: 'TheGamesDB: API key works (3000 requests left this month)'
    })
    expect(calls[0]!.url.searchParams.get('apikey')).toBe('k')
  })

  it("rejects TheGamesDB's 403 Invalid API key", async () => {
    stubFetch(() =>
      json(
        {
          code: 403,
          status: 'Invalid API key was provided.',
          remaining_monthly_allowance: 0,
          allowance_refresh_timer: 0
        },
        403
      )
    )
    expect((await testCredentials('thegamesdb', creds)).status).toBe('invalid')
  })

  it('does not call another 403 a bad key', async () => {
    stubFetch(() => json({ code: 403, status: 'Rate limit reached' }, 403))
    expect((await testCredentials('thegamesdb', creds)).status).toBe('unchecked')
  })
})

describe('Steam', () => {
  const DENIED =
    '<html><head><title>Forbidden</title></head><body><h1>Forbidden</h1>Access is denied. Retrying will not help. Please verify your <pre>key=</pre> parameter.</body></html>'

  it('accepts the key and the SteamID64 and names the account', async () => {
    const calls = stubFetch(() =>
      json({ response: { players: [{ steamid: '76561198000000001', personaname: 'Jer' }] } })
    )
    expect(await testCredentials('steam', { apiKey: 'K', steamId64: '76561198000000001' })).toEqual(
      { status: 'valid', message: 'Steam: Web API key and SteamID64 work (Jer)' }
    )
    expect(calls[0]!.url.searchParams.get('steamids')).toBe('76561198000000001')
  })

  it('checks the key alone against a public account before the SteamID64 is entered', async () => {
    const calls = stubFetch(() => json({ response: { players: [{ steamid: 'x' }] } }))
    const result = await testCredentials('steam', { apiKey: 'K', steamId64: '' })
    expect(result).toEqual({
      status: 'valid',
      message: 'Steam: Web API key works; enter your SteamID64 too'
    })
    expect(calls[0]!.url.searchParams.get('steamids')).toMatch(/^\d{17}$/)
  })

  it('says when the key works but the SteamID64 belongs to no account', async () => {
    stubFetch(() => json({ response: { players: [] } }))
    expect(await testCredentials('steam', { apiKey: 'K', steamId64: '76561198000000001' })).toEqual(
      {
        status: 'invalid',
        message: 'Steam: the Web API key works, but no account has that SteamID64'
      }
    )
  })

  it("rejects Steam's 403 Access is denied", async () => {
    stubFetch(() => text(DENIED, 403))
    expect((await testCredentials('steam', { apiKey: 'K', steamId64: '' })).status).toBe('invalid')
  })

  it('rejects a malformed SteamID64 without a request', async () => {
    const calls = stubFetch(() => json({}))
    expect((await testCredentials('steam', { apiKey: 'K', steamId64: '7656abc' })).status).toBe(
      'invalid'
    )
    expect(calls).toHaveLength(0)
  })

  it('reports Steam maintenance (500) as unchecked', async () => {
    stubFetch(() => text('', 500))
    expect((await testCredentials('steam', { apiKey: 'K', steamId64: '' })).status).toBe(
      'unchecked'
    )
  })
})

it('never puts the credentials in a message', async () => {
  stubFetch(networkDown)
  const secret = 'SUPERSECRETKEY123'
  for (const result of [
    await testCredentials('steamgriddb', { apiKey: secret }),
    await testCredentials('thegamesdb', { apiKey: secret }),
    await testCredentials('steam', { apiKey: secret, steamId64: '' }),
    await testCredentials('igdb', { clientId: secret, clientSecret: secret }),
    await testCredentials('screenscraper', {
      devId: secret,
      devPassword: secret,
      user: secret,
      password: secret
    })
  ]) {
    expect(result.message).not.toContain(secret)
  }
})

describe('review fixes', () => {
  it('rejects a SteamGridDB key with a line break or a zero-width space without sending it', async () => {
    const calls = stubFetch(() => json({ success: true }))
    for (const apiKey of ['abc\ndef', `abc${String.fromCharCode(0x200b)}`, 'abc def']) {
      const result = await testCredentials('steamgriddb', { apiKey })
      expect(result.status).toBe('invalid')
      expect(result.message).not.toContain('abc')
    }
    expect(calls).toHaveLength(0)
  })

  it('never quotes an unexpected error, which may repeat a header value', async () => {
    stubFetch(() => {
      throw new TypeError('Headers.append: "Bearer SECRETKEY" is an invalid header value.')
    })
    const result = await testCredentials('steamgriddb', { apiKey: 'SECRETKEY' })
    expect(result.status).toBe('unchecked')
    expect(result.message).not.toContain('SECRETKEY')
  })

  it('does not blame the ScreenScraper login when the developer re-check fails', async () => {
    stubFetch(({ url }) =>
      url.pathname.endsWith('ssuserInfos.php')
        ? text('Erreur de login : Vérifier les identifiants utilisateurs !', 403)
        : text('API closed for non-members', 401)
    )
    const result = await testCredentials('screenscraper', {
      devId: 'd',
      devPassword: 'p',
      user: 'me',
      password: 'x'
    })
    expect(result.status).toBe('unchecked')
  })
})
