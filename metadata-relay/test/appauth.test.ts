import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  clearAppTokenCache,
  installationToken,
  pemToPkcs8,
  pkcs1ToPkcs8,
  signAppJwt,
  TOKEN_REFRESH_MARGIN_MS,
  type AppAuthConfig
} from '../src/appauth'
import { handle, type Env } from '../src/index'
import { FakeDbLimits, FakeGitHub, FakeKV } from './fakes'

// Throwaway RSA keys made here with WebCrypto; no real key, no network.

const NOW = Date.UTC(2026, 10, 16, 12, 30)
const APP_ID = '123456'
const INSTALLATION = 7890

let keys: CryptoKeyPair
let pkcs8Der: Uint8Array
let pkcs8Pem: string
let pkcs1Pem: string

function b64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

function pem(label: string, der: Uint8Array): string {
  const lines = b64(der)
    .match(/.{1,64}/g)!
    .join('\n')
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`
}

/** Reads one DER TLV at `at`: its tag, the start of its content and the end. */
function tlv(der: Uint8Array, at: number): { tag: number; start: number; end: number } {
  const tag = der[at]
  let len = der[at + 1]
  let start = at + 2
  if (len & 0x80) {
    const n = len & 0x7f
    len = 0
    for (let i = 0; i < n; i++) len = len * 256 + der[start + i]
    start += n
  }
  return { tag, start, end: start + len }
}

/** The RSAPrivateKey (PKCS#1) inside a PKCS#8 PrivateKeyInfo, parsed independently of the code under test. */
function pkcs1Of(pkcs8: Uint8Array): Uint8Array {
  const outer = tlv(pkcs8, 0)
  const version = tlv(pkcs8, outer.start)
  const alg = tlv(pkcs8, version.end)
  const octet = tlv(pkcs8, alg.end)
  expect(octet.tag).toBe(0x04)
  return pkcs8.slice(octet.start, octet.end)
}

function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

function decodeJson(part: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(fromB64url(part))) as Record<string, unknown>
}

async function verifyJwt(jwt: string): Promise<boolean> {
  const [h, p, sig] = jwt.split('.')
  return crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    keys.publicKey,
    fromB64url(sig),
    new TextEncoder().encode(`${h}.${p}`)
  )
}

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256'
    },
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair
  pkcs8Der = new Uint8Array(
    (await crypto.subtle.exportKey('pkcs8', keys.privateKey)) as ArrayBuffer
  )
  pkcs8Pem = pem('PRIVATE KEY', pkcs8Der)
  pkcs1Pem = pem('RSA PRIVATE KEY', pkcs1Of(pkcs8Der))
})

beforeEach(() => clearAppTokenCache())

interface AppCall {
  method: string
  path: string
  auth: string | null
  body?: unknown
}

/**
 * GitHub's app endpoints (installation lookup, access tokens) in front of a FakeGitHub repository. Repository calls
 * must carry the installation token the fake handed out last.
 */
// Test fake: its return type is the object literal it builds, inferred on purpose.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function appGitHub(gh: FakeGitHub, opts: { installed?: boolean; tokenStatus?: number } = {}) {
  const appCalls: AppCall[] = []
  let issued = 0
  const state = { currentToken: '', expiresAt: NOW + 60 * 60 * 1000 }
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : (input as Request).url)
    const method = init?.method ?? 'GET'
    const auth = new Headers(init?.headers).get('Authorization')
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (url.pathname === '/repos/jeremybris/PlayOut-metadata/installation') {
      appCalls.push({ method, path: url.pathname, auth })
      if (opts.installed === false) return Response.json({ message: 'Not Found' }, { status: 404 })
      return Response.json({ id: INSTALLATION })
    }
    if (url.pathname.startsWith('/app/')) {
      appCalls.push({ method, path: url.pathname, auth, body })
      if (opts.tokenStatus) return Response.json({ message: 'nope' }, { status: opts.tokenStatus })
      state.currentToken = `ghs_fake${++issued}`
      return Response.json(
        { token: state.currentToken, expires_at: new Date(state.expiresAt).toISOString() },
        { status: 201 }
      )
    }
    if (auth !== `Bearer ${state.currentToken}`) {
      return Response.json({ message: 'Bad credentials' }, { status: 401 })
    }
    return gh.fetch(input, init)
  }
  return { appCalls, fetch: fetchFn, state }
}

const cfg = (extra: Partial<AppAuthConfig> = {}): AppAuthConfig => ({
  appId: APP_ID,
  privateKey: pkcs1Pem,
  owner: 'jeremybris',
  repo: 'PlayOut-metadata',
  ...extra
})

describe('private key', () => {
  it('wraps PKCS#1 into exactly the PKCS#8 WebCrypto exports', () => {
    expect(pkcs1ToPkcs8(pkcs1Of(pkcs8Der))).toEqual(pkcs8Der)
    expect(pemToPkcs8(pkcs1Pem)).toEqual(pkcs8Der)
  })

  it('takes PKCS#8 as is, CRLF and one-line keys with literal \\n', () => {
    expect(pemToPkcs8(pkcs8Pem)).toEqual(pkcs8Der)
    expect(pemToPkcs8(pkcs1Pem.replace(/\n/g, '\r\n'))).toEqual(pkcs8Der)
    expect(pemToPkcs8(pkcs1Pem.replace(/\n/g, '\\n'))).toEqual(pkcs8Der)
  })

  it('refuses something that is not a private key', () => {
    expect(() => pemToPkcs8('ghp_notakey')).toThrow(/not a PEM private key/)
    expect(() => pemToPkcs8('-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----')).toThrow()
  })

  it('encodes long DER lengths', () => {
    const big = new Uint8Array(70000)
    const out = pkcs1ToPkcs8(big)
    expect(Array.from(out.subarray(0, 2))).toEqual([0x30, 0x83])
    expect(out.length).toBe(70000 + 5 + 18 + 5) // 0x04/0x30 + 0x83 + 3 length bytes each, 18-byte prefix
  })
})

describe('app JWT', () => {
  it('is RS256, iat 60 s back, exp 9 min ahead, iss the app id, and verifies with the public key', async () => {
    for (const key of [pkcs1Pem, pkcs8Pem]) {
      const jwt = await signAppJwt(APP_ID, key, NOW)
      const [h, p, s] = jwt.split('.')
      expect(s).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(decodeJson(h)).toEqual({ alg: 'RS256', typ: 'JWT' })
      const now = Math.floor(NOW / 1000)
      expect(decodeJson(p)).toEqual({ iat: now - 60, exp: now + 540, iss: 123456 })
      expect(await verifyJwt(jwt)).toBe(true)
    }
  })

  it('does not verify once tampered with', async () => {
    const jwt = await signAppJwt(APP_ID, pkcs1Pem, NOW)
    const [h, , s] = jwt.split('.')
    const forged = `${h}.${btoa(JSON.stringify({ iss: 1 })).replace(/=+$/, '')}.${s}`
    expect(await verifyJwt(forged)).toBe(false)
  })
})

describe('installation token', () => {
  it('discovers the installation, asks for a token limited to the repo and caches it', async () => {
    const gh = new FakeGitHub()
    const app = appGitHub(gh)
    let now = NOW
    const deps = { fetch: app.fetch, now: () => now }
    expect(await installationToken(cfg(), deps)).toBe('ghs_fake1')
    expect(app.appCalls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /repos/jeremybris/PlayOut-metadata/installation',
      `POST /app/installations/${INSTALLATION}/access_tokens`
    ])
    expect(app.appCalls[1].body).toEqual({
      repositories: ['PlayOut-metadata'],
      permissions: { contents: 'write', pull_requests: 'write' }
    })
    // both calls are signed with a valid app JWT
    for (const c of app.appCalls) {
      expect(c.auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/)
      expect(await verifyJwt(c.auth!.slice(7))).toBe(true)
    }

    // cached until 5 minutes before expires_at
    now = app.state.expiresAt - TOKEN_REFRESH_MARGIN_MS - 1
    expect(await installationToken(cfg(), deps)).toBe('ghs_fake1')
    expect(app.appCalls).toHaveLength(2)

    // then refreshed, without looking the installation up again
    now = app.state.expiresAt - TOKEN_REFRESH_MARGIN_MS
    app.state.expiresAt = now + 60 * 60 * 1000
    expect(await installationToken(cfg(), deps)).toBe('ghs_fake2')
    expect(app.appCalls.map((c) => c.method)).toEqual(['GET', 'POST', 'POST'])
  })

  it('uses a configured installation id without discovery', async () => {
    const app = appGitHub(new FakeGitHub())
    const deps = { fetch: app.fetch, now: () => NOW }
    expect(await installationToken(cfg({ installationId: '42' }), deps)).toBe('ghs_fake1')
    expect(app.appCalls.map((c) => c.path)).toEqual(['/app/installations/42/access_tokens'])
  })

  it('fails without leaking the key when the app is not installed', async () => {
    const app = appGitHub(new FakeGitHub(), { installed: false })
    const err = await installationToken(cfg(), { fetch: app.fetch, now: () => NOW }).catch(
      (e: Error) => e
    )
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('404')
    expect((err as Error).message).not.toContain('PRIVATE KEY')
  })
})

describe('POST /suggest as the GitHub App', () => {
  // Test setup: returns the fakes it builds; the inferred type is the useful one.
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  function setup(env: Partial<Env>, opts?: { installed?: boolean; tokenStatus?: number }) {
    const gh = new FakeGitHub()
    const app = appGitHub(gh, opts)
    const fullEnv: Env = { RATE_LIMIT: new FakeKV().asKV(), RATE_CLIENT_PER_HOUR: '50', ...env }
    let n = 0
    const send = (fields: Record<string, unknown>): Promise<Response> =>
      handle(
        new Request('https://relay.example/suggest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7' },
          body: JSON.stringify({
            key: 'steam-620',
            title: 'Portal 2',
            fields,
            appVersion: '0.1.139',
            clientId: 'client-0001'
          })
        }),
        fullEnv,
        { fetch: app.fetch, now: () => NOW, id: () => `id${++n}` }
      )
    return { gh, app, send }
  }

  it('opens the PR with the installation token and reuses it for the next suggestion', async () => {
    const { gh, app, send } = setup({ GITHUB_APP_ID: APP_ID, GITHUB_APP_PRIVATE_KEY: pkcs1Pem })
    const res = await send({ developers: ['Valve'] })
    expect(res.status).toBe(200)
    expect(gh.pulls).toHaveLength(1)
    expect(gh.pulls[0].head).toBe('suggest/steam-620-id1')
    expect(gh.pulls[0].labels).toEqual(['suggestion'])
    expect(gh.calls.length).toBeGreaterThan(0)
    expect(gh.calls.every((c) => c.auth === 'Bearer ghs_fake1')).toBe(true)
    expect(gh.branches.get('main')!.files.size).toBe(0)

    expect((await send({ localPlayers: 2 })).status).toBe(200)
    expect(app.appCalls).toHaveLength(2) // one discovery, one token: the second suggestion used the cache
  })

  it('prefers the app over the fallback GITHUB_TOKEN', async () => {
    const { gh, send } = setup({
      GITHUB_APP_ID: APP_ID,
      GITHUB_APP_PRIVATE_KEY: pkcs8Pem,
      GITHUB_TOKEN: 'old-token'
    })
    expect((await send({ localPlayers: 2 })).status).toBe(200)
    expect(gh.calls.every((c) => c.auth === 'Bearer ghs_fake1')).toBe(true)
  })

  it('answers 503 when neither the app nor a token is configured', async () => {
    expect((await setup({}).send({ localPlayers: 2 })).status).toBe(503)
    expect((await setup({ GITHUB_APP_ID: APP_ID }).send({ localPlayers: 2 })).status).toBe(503)
    expect(
      (await setup({ GITHUB_APP_PRIVATE_KEY: pkcs1Pem }).send({ localPlayers: 2 })).status
    ).toBe(503)
  })

  it('answers 503 for a broken key and 502 when GitHub refuses the app, without a branch', async () => {
    const broken = setup({ GITHUB_APP_ID: APP_ID, GITHUB_APP_PRIVATE_KEY: 'not a key' })
    const r1 = await broken.send({ localPlayers: 2 })
    expect(r1.status).toBe(503)
    expect(((await r1.json()) as { error: string }).error).not.toContain('not a key')

    const refused = setup(
      { GITHUB_APP_ID: APP_ID, GITHUB_APP_PRIVATE_KEY: pkcs1Pem },
      { tokenStatus: 401 }
    )
    const r2 = await refused.send({ localPlayers: 2 })
    expect(r2.status).toBe(502)
    expect(((await r2.json()) as { error: string }).error).toContain('GitHub App')
    expect(refused.gh.calls).toHaveLength(0)
  })

  it('signs in afresh after GitHub refuses a cached token', async () => {
    const { gh, app, send } = setup({ GITHUB_APP_ID: APP_ID, GITHUB_APP_PRIVATE_KEY: pkcs1Pem })
    expect((await send({ localPlayers: 1 })).status).toBe(200)
    app.state.currentToken = 'revoked-elsewhere' // GitHub no longer takes ghs_fake1
    expect((await send({ localPlayers: 2 })).status).toBe(502)
    expect((await send({ localPlayers: 3 })).status).toBe(200)
    expect(gh.calls.at(-1)!.auth).toBe('Bearer ghs_fake2')
  })
})

describe('token permissions', () => {
  it('asks for contents and pull requests by default, and only what is named otherwise, each cached apart', async () => {
    const app = appGitHub(new FakeGitHub())
    const deps = { fetch: app.fetch, now: () => NOW }
    expect(await installationToken(cfg({ installationId: '42' }), deps)).toBe('ghs_fake1')
    expect(
      await installationToken(
        cfg({ installationId: '42', permissions: { contents: 'write' } }),
        deps
      )
    ).toBe('ghs_fake2')
    expect(app.appCalls.map((c) => c.body)).toEqual([
      {
        repositories: ['PlayOut-metadata'],
        permissions: { contents: 'write', pull_requests: 'write' }
      },
      { repositories: ['PlayOut-metadata'], permissions: { contents: 'write' } }
    ])
    // Same repository, other permissions: a token of its own.
    expect(
      await installationToken(
        cfg({ installationId: '42', permissions: { contents: 'read' } }),
        deps
      )
    ).toBe('ghs_fake3')
    expect(await installationToken(cfg({ installationId: '42' }), deps)).toBe('ghs_fake1')
    expect(app.appCalls).toHaveLength(3)
    // Another repository, same permissions: a token of its own too.
    expect(
      await installationToken(
        cfg({ installationId: '42', repo: 'Other', permissions: { contents: 'write' } }),
        deps
      )
    ).toBe('ghs_fake4')
    expect(app.appCalls.at(-1)!.body).toEqual({
      repositories: ['Other'],
      permissions: { contents: 'write' }
    })
  })

  it('/contribute signs in for the database with contents:write only', async () => {
    const gh = new FakeGitHub()
    const app = appGitHub(gh)
    const res = await handle(
      new Request('https://relay.example/contribute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: 'client-0001',
          appVersion: '0.9.40',
          rows: [
            {
              key: 'steam-620',
              title: 'Portal 2',
              platform: 'pc',
              releaseDate: '2011',
              genres: ['Puzzle'],
              tags: [],
              developers: [],
              publishers: [],
              localPlayers: 2,
              steamAppId: 620
            }
          ]
        })
      }),
      {
        RATE_LIMIT: new FakeKV().asKV(),
        DB_LIMITS: new FakeDbLimits().asNamespace(),
        GITHUB_APP_ID: APP_ID,
        GITHUB_APP_PRIVATE_KEY: pkcs1Pem,
        GITHUB_APP_INSTALLATION_ID: String(INSTALLATION),
        DB_REPO_OWNER: 'jeremybris',
        DB_REPO_NAME: 'PlayOut-metadata',
        DB_BRANCH: 'database'
      },
      { fetch: app.fetch, now: () => NOW }
    )
    expect(res.status).toBe(200)
    expect(app.appCalls.map((c) => c.body)).toEqual([
      { repositories: ['PlayOut-metadata'], permissions: { contents: 'write' } }
    ])
    expect(gh.calls.length).toBeGreaterThan(0)
    expect(gh.calls.every((c) => c.auth === 'Bearer ghs_fake1')).toBe(true)
    expect(gh.calls.every((c) => c.branch === 'database')).toBe(true)
    expect(gh.dbCalls.some((c) => c.method === 'PUT')).toBe(true)
  })

  it('/suggest and /contribute on the same repository each sign in with their own permissions', async () => {
    const gh = new FakeGitHub()
    const app = appGitHub(gh)
    const env: Env = {
      RATE_LIMIT: new FakeKV().asKV(),
      DB_LIMITS: new FakeDbLimits().asNamespace(),
      GITHUB_APP_ID: APP_ID,
      GITHUB_APP_PRIVATE_KEY: pkcs1Pem,
      GITHUB_APP_INSTALLATION_ID: String(INSTALLATION),
      DB_REPO_OWNER: 'jeremybris',
      DB_REPO_NAME: 'PlayOut-metadata',
      DB_BRANCH: 'database'
    }
    const post = (path: string, body: unknown): Promise<Response> =>
      handle(
        new Request(`https://relay.example${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        }),
        env,
        { fetch: app.fetch, now: () => NOW, id: () => 'id1' }
      )
    const suggested = await post('/suggest', {
      key: 'steam-620',
      title: 'Portal 2',
      fields: { localPlayers: 2 },
      appVersion: '0.9.40',
      clientId: 'client-0001'
    })
    expect(suggested.status).toBe(200)
    const suggestCalls = gh.calls.length
    const contributed = await post('/contribute', {
      clientId: 'client-0001',
      appVersion: '0.9.40',
      rows: [
        {
          key: 'steam-620',
          title: 'Portal 2',
          platform: 'pc',
          releaseDate: '2011',
          genres: ['Puzzle'],
          tags: [],
          developers: [],
          publishers: [],
          localPlayers: 2,
          steamAppId: 620
        }
      ]
    })
    expect(contributed.status).toBe(200)
    expect(app.appCalls.map((c) => c.body)).toEqual([
      {
        repositories: ['PlayOut-metadata'],
        permissions: { contents: 'write', pull_requests: 'write' }
      },
      { repositories: ['PlayOut-metadata'], permissions: { contents: 'write' } }
    ])
    const [bySuggest, byContribute] = [
      gh.calls.slice(0, suggestCalls),
      gh.calls.slice(suggestCalls)
    ]
    expect(bySuggest.every((c) => c.auth === 'Bearer ghs_fake1' && c.branch !== 'database')).toBe(
      true
    )
    expect(
      byContribute.every((c) => c.auth === 'Bearer ghs_fake2' && c.branch === 'database')
    ).toBe(true)
    expect(gh.branches.get('main')!.files.size).toBe(0)
    expect(gh.pulls.map((p) => p.head)).toEqual(['suggest/steam-620-id1'])
  })
})
