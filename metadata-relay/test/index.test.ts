import { describe, expect, it } from 'vitest'
import { DEFAULT_MAX_OPEN_SUGGESTIONS, handle, type Env } from '../src/index'
import { rateLimitConfig } from '../src/ratelimit'
import { FakeGitHub, FakeKV } from './fakes'

const NOW = Date.UTC(2026, 10, 16, 12, 30)

function setup(files: Record<string, string> = {}): {
  gh: FakeGitHub
  kv: FakeKV
  env: Env
  send: (
    body: unknown,
    opts?: { ip?: string; type?: string; method?: string; path?: string }
  ) => Promise<Response>
} {
  const gh = new FakeGitHub(files)
  const kv = new FakeKV()
  const env: Env = {
    GITHUB_TOKEN: 'test-token',
    RATE_LIMIT: kv.asKV(),
    REPO_OWNER: 'jeremybris',
    REPO_NAME: 'PlayOut-metadata',
    BASE_BRANCH: 'main',
    RATE_IP_PER_HOUR: '3',
    RATE_CLIENT_PER_HOUR: '2',
    RATE_GLOBAL_PER_HOUR: '5'
  }
  let n = 0
  const send = (
    body: unknown,
    opts: { ip?: string; type?: string; method?: string; path?: string } = {}
  ): Promise<Response> =>
    handle(
      new Request(`https://relay.example.workers.dev${opts.path ?? '/suggest'}`, {
        method: opts.method ?? 'POST',
        headers: {
          'Content-Type': opts.type ?? 'application/json',
          'CF-Connecting-IP': opts.ip ?? '203.0.113.7'
        },
        body:
          opts.method === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
      }),
      env,
      { fetch: gh.fetch, now: () => NOW, id: () => `id${++n}` }
    )
  return { gh, kv, env, send }
}

const suggestion = (
  fields: Record<string, unknown>,
  extra: Record<string, unknown> = {}
): unknown => ({
  key: 'steam-620',
  title: 'Portal 2',
  fields,
  appVersion: '0.1.138',
  clientId: 'client-0001',
  ...extra
})

const existing = JSON.stringify({
  key: 'steam-620',
  title: 'Portal 2',
  fields: { genres: ['Action'], hltb: { main: 5, extra: 9 } },
  updatedAt: '2026-01-01T00:00:00.000Z'
})

describe('GET /health', () => {
  it('answers ok', async () => {
    const { send } = setup()
    const res = await send(undefined, { method: 'GET', path: '/health' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
  it('404s other paths and 405s wrong methods', async () => {
    const { send } = setup()
    expect((await send(undefined, { method: 'GET', path: '/nope' })).status).toBe(404)
    expect((await send(undefined, { method: 'GET', path: '/suggest' })).status).toBe(405)
  })
})

describe('POST /suggest', () => {
  it('opens a labelled PR that merges the suggestion onto the cloud file', async () => {
    const { gh, send } = setup({ 'games/steam-620.json': existing })
    const res = await send(suggestion({ genres: ['Puzzle'], hltb: { main: 8.5 } }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      pr: { number: 1, url: 'https://github.com/jeremybris/PlayOut-metadata/pull/1' }
    })

    const branch = gh.branches.get('suggest/steam-620-id1')!
    const written = JSON.parse(branch.files.get('games/steam-620.json')!)
    expect(written).toEqual({
      key: 'steam-620',
      title: 'Portal 2',
      fields: { genres: ['Puzzle'], hltb: { main: 8.5 } },
      updatedAt: new Date(NOW).toISOString()
    })
    // main is untouched until the owner merges.
    expect(gh.branches.get('main')!.files.get('games/steam-620.json')).toBe(existing)

    const pr = gh.pulls[0]
    expect(pr.title).toBe('Suggestion: Portal 2')
    expect(pr.head).toBe('suggest/steam-620-id1')
    expect(pr.base).toBe('main')
    expect(pr.labels).toEqual(['suggestion'])
    expect(pr.body).toContain('| Genres | `Action` | `Puzzle` |')
    expect(pr.body).toContain('| HowLongToBeat (hours) | `main: 5, extra: 9` | `main: 8.5` |')
    expect(gh.calls.every((c) => c.auth === 'Bearer test-token')).toBe(true)
  })

  it('creates the file for a game the cloud does not have yet', async () => {
    const { gh, send } = setup()
    const res = await send(suggestion({ developers: ['Valve'] }))
    expect(res.status).toBe(200)
    const written = JSON.parse(
      gh.branches.get('suggest/steam-620-id1')!.files.get('games/steam-620.json')!
    )
    expect(written.fields).toEqual({ developers: ['Valve'] })
    expect(gh.pulls[0].body).toContain('new file')
    expect(gh.pulls[0].body).toContain('| Developers | _(none)_ | `Valve` |')
  })

  it('refuses a suggestion that changes nothing, without a branch', async () => {
    const { gh, send } = setup({ 'games/steam-620.json': existing })
    const res = await send(suggestion({ genres: ['Action'] }))
    expect(res.status).toBe(409)
    expect(gh.suggestBranches()).toEqual([])
    expect(gh.pulls).toHaveLength(0)
  })

  it('rejects invalid input before touching GitHub or KV', async () => {
    const { gh, kv, send } = setup()
    const res = await send(suggestion({ cover: 'http://x' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ ok: false, error: 'cover is not an editable field' })
    expect((await send('not json')).status).toBe(400)
    expect((await send(suggestion({ localPlayers: 1 }), { type: 'text/plain' })).status).toBe(415)
    expect((await send('x'.repeat(70_000))).status).toBe(413)
    expect(gh.calls).toHaveLength(0)
    expect(kv.puts).toHaveLength(0)
  })

  it('rate limits per clientId, per IP and globally', async () => {
    const { send } = setup()
    const ok = async (r: Promise<Response>): Promise<number> => (await r).status
    // per clientId: 2 an hour
    expect(await ok(send(suggestion({ localPlayers: 1 })))).toBe(200)
    expect(await ok(send(suggestion({ localPlayers: 2 })))).toBe(200)
    const limited = await send(suggestion({ localPlayers: 3 }))
    expect(limited.status).toBe(429)
    expect(limited.headers.get('Retry-After')).toBe('1800')
    expect(((await limited.json()) as { error: string }).error).toContain('client')
    // per IP: 3 an hour
    expect(await ok(send(suggestion({ localPlayers: 4 }, { clientId: 'client-0002' })))).toBe(200)
    const ipLimited = await send(suggestion({ localPlayers: 5 }, { clientId: 'client-0003' }))
    expect(ipLimited.status).toBe(429)
    expect(((await ipLimited.json()) as { error: string }).error).toContain('ip')
    // global: 5 an hour
    expect(
      await ok(
        send(suggestion({ localPlayers: 6 }, { clientId: 'client-0004' }), { ip: '198.51.100.1' })
      )
    ).toBe(200)
    expect(
      await ok(
        send(suggestion({ localPlayers: 7 }, { clientId: 'client-0005' }), { ip: '198.51.100.2' })
      )
    ).toBe(200)
    const globalLimited = await send(suggestion({ localPlayers: 8 }, { clientId: 'client-0006' }), {
      ip: '198.51.100.3'
    })
    expect(globalLimited.status).toBe(429)
    expect(((await globalLimited.json()) as { error: string }).error).toContain('global')
  })

  it("a suggestion that changes nothing takes none of the hour's suggestions", async () => {
    const { kv, env, send } = setup({ 'games/steam-620.json': existing })
    env.RATE_IP_PER_HOUR = '5'
    // per clientId: 2 an hour, and three that change nothing come first
    for (let i = 0; i < 3; i++)
      expect((await send(suggestion({ genres: ['Action'] }))).status).toBe(409)
    expect([...kv.data.keys()].filter((k) => k.startsWith('rl:client:'))).toEqual([])
    expect((await send(suggestion({ localPlayers: 1 }))).status).toBe(200)
    expect((await send(suggestion({ localPlayers: 2 }))).status).toBe(200)
    const limited = await send(suggestion({ localPlayers: 3 }))
    expect(limited.status).toBe(429)
    expect(((await limited.json()) as { error: string }).error).toContain('client')
  })

  it('still bounds requests that change nothing, and asks GitHub nothing past the bound', async () => {
    const { gh, send } = setup({ 'games/steam-620.json': existing })
    // per IP: 3 an hour, whatever clientId each request names
    for (let i = 1; i <= 3; i++) {
      const res = await send(suggestion({ genres: ['Action'] }, { clientId: `client-000${i}` }))
      expect(res.status).toBe(409)
    }
    const calls = gh.calls.length
    const limited = await send(suggestion({ genres: ['Action'] }, { clientId: 'client-0004' }))
    expect(limited.status).toBe(429)
    expect(limited.headers.get('Retry-After')).toBe('1800')
    expect(((await limited.json()) as { error: string }).error).toContain('(ip)')
    expect(gh.calls).toHaveLength(calls)
    // a real suggestion from that address waits too: every request there costs GitHub calls
    expect((await send(suggestion({ localPlayers: 1 }))).status).toBe(429)
    expect(gh.calls).toHaveLength(calls)
    // another address is not held back by it
    expect((await send(suggestion({ localPlayers: 1 }), { ip: '198.51.100.1' })).status).toBe(200)
  })

  it("a suggestion refused for the backlog takes none of the hour's suggestions", async () => {
    const { gh, kv, env, send } = setup()
    env.MAX_OPEN_SUGGESTIONS = '1'
    env.RATE_IP_PER_HOUR = '5'
    gh.pulls.push({
      number: 1,
      title: 'Suggestion',
      head: 'suggest/steam-1-x',
      base: 'main',
      body: '',
      labels: ['suggestion']
    })
    for (let i = 0; i < 2; i++)
      expect((await send(suggestion({ localPlayers: 1 }))).status).toBe(429)
    expect([...kv.data.keys()].filter((k) => k.startsWith('rl:client:'))).toEqual([])
    // the owner went through the open ones: both of this client's suggestions for the hour are still there
    env.MAX_OPEN_SUGGESTIONS = '50'
    expect((await send(suggestion({ localPlayers: 1 }))).status).toBe(200)
    expect((await send(suggestion({ localPlayers: 2 }))).status).toBe(200)
  })

  it('counts a request GitHub failed on before any branch as turned away, once', async () => {
    const { gh, kv, send } = setup()
    gh.failures.push({ method: 'GET', path: '/pulls', status: 500 })
    expect((await send(suggestion({ localPlayers: 1 }))).status).toBe(502)
    expect(Object.fromEntries(kv.data)).toEqual({
      [`rl:no:ip:v4:203.0.113.7:${Math.floor(NOW / 3_600_000)}`]: '1',
      [`rl:no:global:${Math.floor(NOW / 3_600_000)}`]: '1'
    })
  })

  it('runs with the deployed limits when the variables are missing', () => {
    // wrangler.toml's values (src/main/metadata-cloud/relay-limits.test.ts reads the file and compares).
    expect(rateLimitConfig({})).toEqual({
      ipPerHour: 40,
      ip48PerHour: 60,
      clientPerHour: 30,
      globalPerHour: 120
    })
    expect(rateLimitConfig({ RATE_CLIENT_PER_HOUR: 'many' }).clientPerHour).toBe(30)
    expect(DEFAULT_MAX_OPEN_SUGGESTIONS).toBe(300)
  })

  it('deletes the branch and reports an error when GitHub refuses the PR', async () => {
    const { gh, send } = setup()
    gh.failures.push({ method: 'POST', path: '/pulls', status: 422 })
    const res = await send(suggestion({ localPlayers: 4 }))
    expect(res.status).toBe(502)
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false)
    expect(gh.branches.has('suggest/steam-620-id1')).toBe(false)
  })

  it('says so when the token is refused', async () => {
    const { gh, send } = setup()
    gh.failures.push({ method: 'GET', path: '/git/ref', status: 401 })
    const res = await send(suggestion({ localPlayers: 4 }))
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: string }).error).toContain('token')
  })

  it('keeps the PR when only the label fails', async () => {
    const { gh, send } = setup()
    gh.failures.push({ method: 'POST', path: '/issues/', status: 403 })
    const res = await send(suggestion({ localPlayers: 4 }))
    expect(res.status).toBe(200)
    expect(gh.pulls).toHaveLength(1)
  })

  it('refuses new suggestions while too many wait for review', async () => {
    const { gh, env, send } = setup()
    env.MAX_OPEN_SUGGESTIONS = '2'
    env.RATE_CLIENT_PER_HOUR = '50'
    // an open pull request from another branch does not count
    gh.pulls.push({ number: 99, title: 'Docs', head: 'docs', base: 'main', body: '', labels: [] })
    expect((await send(suggestion({ localPlayers: 1 }, { key: 'steam-1' }))).status).toBe(200)
    expect((await send(suggestion({ localPlayers: 2 }, { key: 'steam-2' }))).status).toBe(200)
    const full = await send(suggestion({ localPlayers: 3 }, { key: 'steam-3' }))
    expect(full.status).toBe(429)
    expect(full.headers.get('Retry-After')).toBe('3600')
    expect(((await full.json()) as { error: string }).error).toContain('wait for review')
    // no branch was made for it
    expect(gh.suggestBranches()).toHaveLength(2)
    expect(gh.pulls.filter((p) => p.head.startsWith('suggest/'))).toHaveLength(2)
    // a game that has an open suggestion still takes a later one: it updates that pull request, adding none
    const update = await send(suggestion({ localPlayers: 4 }, { key: 'steam-2' }))
    expect(update.status).toBe(200)
    expect(((await update.json()) as { updated?: boolean }).updated).toBe(true)
    expect(gh.pulls.filter((p) => p.head.startsWith('suggest/'))).toHaveLength(2)
  })

  it('counts open suggestions across pages', async () => {
    const { gh, env, send } = setup()
    env.MAX_OPEN_SUGGESTIONS = '150'
    for (let i = 1; i <= 150; i++)
      gh.pulls.push({
        number: i,
        title: 'Suggestion',
        head: `suggest/steam-${i}-x`,
        base: 'main',
        body: '',
        labels: ['suggestion']
      })
    expect((await send(suggestion({ localPlayers: 1 }))).status).toBe(429)
    expect(gh.calls.filter((c) => c.method === 'GET' && c.path === '/pulls')).toHaveLength(2)
  })

  // The other tests here sign in with the fallback GITHUB_TOKEN; appauth.test.ts covers the GitHub App.
  it('answers 503 when the secret is missing', async () => {
    const { env, send } = setup()
    env.GITHUB_TOKEN = ''
    expect((await send(suggestion({ localPlayers: 1 }))).status).toBe(503)
  })

  it('round-trips non-ASCII text', async () => {
    const { gh, send } = setup()
    await send(
      suggestion({ title: 'Pokémon – 日本語' }, { key: 'gba-pokemon-emerald', title: 'Pokémon' })
    )
    const text = gh.branches
      .get('suggest/gba-pokemon-emerald-id1')!
      .files.get('games/gba-pokemon-emerald.json')!
    expect(JSON.parse(text).title).toBe('Pokémon – 日本語')
  })
})
