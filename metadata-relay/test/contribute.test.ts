import { describe, expect, it } from 'vitest'
import { encodeGameDbCsv, gameDbShardPath, type GameDbRow } from '../src/database-format'
import { DB_LATER_RETRY_AFTER, handle, MAX_DB_GITHUB_CALLS, type Env } from '../src/index'
import { DEFAULT_DB_RATE_LIMITS, dbRateLimitConfig } from '../src/ratelimit'
import { FakeDbLimits, FakeGitHub, FakeKV } from './fakes'
import { DB_PLATFORMS } from '../src/platforms'

const NOW = Date.UTC(2026, 10, 24, 12, 30)

const row = (key: string, patch: Partial<GameDbRow> = {}): GameDbRow => ({
  key,
  title: `Game ${key}`,
  platform: 'pc',
  releaseDate: '2020-01-02',
  genres: ['Action'],
  tags: ['Indie'],
  developers: ['Studio'],
  publishers: ['Publisher'],
  localPlayers: null,
  steamAppId: key.startsWith('steam-') ? Number(key.slice(6)) : null,
  ...patch
})

function setup(envPatch: Partial<Env> = {}): {
  gh: FakeGitHub
  kv: FakeKV
  limits: FakeDbLimits
  send: (body: unknown, opts?: { ip?: string; type?: string; method?: string }) => Promise<Response>
} {
  const gh = new FakeGitHub()
  const kv = new FakeKV()
  const limits = new FakeDbLimits()
  const env: Env = {
    GITHUB_TOKEN: 'test-token',
    RATE_LIMIT: kv.asKV(),
    DB_LIMITS: limits.asNamespace(),
    DB_REPO_OWNER: 'jeremybris',
    DB_REPO_NAME: 'PlayOut-metadata',
    DB_BRANCH: 'database',
    RATE_DB_CLIENT_PER_HOUR: '2',
    RATE_DB_IP_PER_HOUR: '3',
    RATE_DB_GLOBAL_PER_HOUR: '5',
    ...envPatch
  }
  const send = (
    body: unknown,
    opts: { ip?: string; type?: string; method?: string } = {}
  ): Promise<Response> =>
    handle(
      new Request('https://relay.example.workers.dev/contribute', {
        method: opts.method ?? 'POST',
        headers: {
          'Content-Type': opts.type ?? 'application/json',
          'CF-Connecting-IP': opts.ip ?? '203.0.113.7'
        },
        body:
          opts.method === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
      }),
      env,
      { fetch: gh.fetch, now: () => NOW, sleep: async () => {} }
    )
  return { gh, kv, limits, send }
}

const request = (rows: unknown[], extra: Record<string, unknown> = {}): unknown => ({
  clientId: 'client-0001',
  appVersion: '0.9.40',
  rows,
  ...extra
})

describe('POST /contribute', () => {
  it('appends the games to their shards on the database branch and says which it added', async () => {
    const { gh, kv, limits, send } = setup()
    const rows = [row('steam-620'), row('ps2-slus20772', { platform: 'ps2', steamAppId: null })]
    const mainBefore = new Map(gh.branches.get('main')!.files)
    const res = await send(request(rows))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      added: expect.arrayContaining(['steam-620', 'ps2-slus20772']),
      present: [],
      refused: [],
      later: []
    })
    for (const r of rows) expect(gh.dbFile(gameDbShardPath(r.key))).toBe(encodeGameDbCsv([r]))
    expect(gh.calls.every((c) => c.auth === 'Bearer test-token')).toBe(true)
    // Every call was on the database branch: main and suggest/... are left as they were, no pull request.
    expect(gh.calls.length).toBeGreaterThan(0)
    expect(gh.calls.every((c) => c.branch === 'database')).toBe(true)
    expect(gh.branches.get('main')!.files).toEqual(mainBefore)
    expect(gh.suggestBranches()).toEqual([])
    expect(gh.pulls).toHaveLength(0)
    expect(gh.strayCalls).toHaveLength(0)
    // Counted once, as a contribution, in the database's own counters (the Durable Object, never KV).
    expect(kv.puts).toHaveLength(0)
    expect(limits.ops).toEqual(['peek', 'take'])
    expect(limits.keys().filter((k) => k.startsWith('db:rl:client:'))).toHaveLength(1)
    expect(res.headers.get('Retry-After')).toBeNull()
  })

  it('never changes a game the database has, and counts a request that adds nothing as turned away', async () => {
    const { gh, limits, send } = setup()
    const path = gameDbShardPath('steam-620')
    const theirs = encodeGameDbCsv([row('steam-620', { title: 'Portal 2' })])
    gh.dbFiles.set(path, theirs)
    const res = await send(request([row('steam-620', { title: 'Vandalised' })]))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      added: [],
      present: ['steam-620'],
      refused: [],
      later: []
    })
    expect(gh.dbFile(path)).toBe(theirs)
    expect(gh.dbCalls.map((c) => c.method)).toEqual(['GET'])
    expect(limits.keys().some((k) => k.startsWith('db:rl:client:'))).toBe(false)
    expect(limits.keys().some((k) => k.startsWith('db:rl:no:'))).toBe(true)
  })

  it('reports refused rows and adds the rest', async () => {
    const { gh, send } = setup()
    const res = await send(
      request([
        row('steam-620'),
        row('steam-10', { title: '=HYPERLINK("https://evil.example")' }),
        row('gog-1', { platform: 'ps2' }),
        row('ps2-x', { platform: 'snes' }),
        row('steam-30', { steamAppId: 31 }),
        row('steam-abc', { steamAppId: null }),
        row('a_b-1'),
        row('manual-jeremy-private-backups-tool'),
        row('zzz123-x', { platform: 'zzz123' }),
        row('steam-60', { developers: ['-HYPERLINK("https://evil.example","Valve")'] }),
        { key: 'steam-40', title: 'Extra', platform: 'pc', releaseDate: '2001', hltb: 3 },
        { key: 'steam-50', title: 'Wrong type', platform: 'pc', genres: 'Action' },
        'not a row',
        row('steam-620')
      ])
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      added: string[]
      refused: { key: string; error: string }[]
    }
    expect(body.added).toEqual(['steam-620'])
    expect(body.refused).toEqual([
      { key: 'steam-10', error: 'title starts like a spreadsheet formula' },
      { key: 'gog-1', error: 'platform of a gog game must be pc' },
      { key: 'ps2-x', error: 'key does not belong to the platform' },
      { key: 'steam-30', error: 'Steam app id does not match the key' },
      { key: 'steam-abc', error: 'key is not a valid game key' },
      { key: 'a_b-1', error: 'key cannot be stored in the database' },
      { key: 'manual-jeremy-private-backups-tool', error: 'added programs are not taken' },
      { key: 'zzz123-x', error: 'platform is not one PlayOut knows' },
      { key: 'steam-60', error: 'developers value starts like a spreadsheet formula' },
      { key: 'steam-40', error: 'row has unknown property hltb' },
      { key: 'steam-50', error: 'genres must be a list' },
      { key: '', error: 'row must be an object' },
      { key: 'steam-620', error: 'is sent twice' }
    ])
    expect([...gh.dbFiles.keys()]).toEqual([gameDbShardPath('steam-620')])
  })

  it('answers 400 when no row can go in, without asking GitHub', async () => {
    const { gh, limits, send } = setup()
    const res = await send(request([row('steam-1', { title: '+1' })]))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      ok: false,
      error: 'no game in the request can go in the database',
      refused: [{ key: 'steam-1', error: 'title starts like a spreadsheet formula' }]
    })
    expect(gh.calls).toHaveLength(0)
    expect(limits.ops).toHaveLength(0)
  })

  it('rejects invalid requests before touching GitHub or the counters', async () => {
    const { gh, limits, send } = setup()
    const bad: [unknown, number, RegExp][] = [
      ['{nope', 400, /JSON/],
      [[], 400, /object/],
      [request([]), 400, /at least one/],
      [request(Array.from({ length: 26 }, (_, i) => row(`steam-${i + 1}`))), 400, /more than 25/],
      [request([row('steam-1')], { clientId: 'x' }), 400, /clientId/],
      [request([row('steam-1')], { appVersion: 'latest' }), 400, /appVersion/],
      [request([row('steam-1')], { extra: 1 }), 400, /unknown property extra/],
      [{ clientId: 'client-0001', appVersion: '0.9.40', rows: 'x' }, 400, /rows/],
      [JSON.stringify(request([row('steam-1', { title: 'x'.repeat(70_000) })])), 413, /64 KB/]
    ]
    for (const [body, status, error] of bad) {
      const res = await send(body)
      expect(res.status, String(error)).toBe(status)
      expect(((await res.json()) as { error: string }).error).toMatch(error)
    }
    expect((await send(request([row('steam-1')]), { type: 'text/plain' })).status).toBe(415)
    expect((await send(undefined, { method: 'GET' })).status).toBe(405)
    expect(gh.calls).toHaveLength(0)
    expect(limits.ops).toHaveLength(0)
  })

  it('rate limits per client, per IP and in total, apart from the suggestions', async () => {
    const { gh, kv, limits, send } = setup()
    let n = 0
    const next = (): unknown => request([row(`steam-${++n}`)])
    expect((await send(next())).status).toBe(200)
    expect((await send(next())).status).toBe(200)
    const limited = await send(next())
    expect(limited.status).toBe(429)
    expect(((await limited.json()) as { error: string }).error).toBe(
      'too many contributions (client); try again later'
    )
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0)
    // Another install on the same address: the per-IP limit (3).
    expect((await send(next())).status).toBe(429)
    const other = (id: string, ip: string): Promise<Response> =>
      send(request([row(`steam-${++n}`)], { clientId: id }), { ip })
    expect((await other('client-0002', '203.0.113.7')).status).toBe(200)
    const ipLimited = await other('client-0003', '203.0.113.7')
    expect(ipLimited.status).toBe(429)
    expect(((await ipLimited.json()) as { error: string }).error).toContain('(ip)')
    expect((await other('client-0004', '198.51.100.1')).status).toBe(200)
    expect((await other('client-0005', '198.51.100.2')).status).toBe(200)
    const globalLimited = await other('client-0006', '198.51.100.3')
    expect(((await globalLimited.json()) as { error: string }).error).toContain('(global)')
    // Only the database's counters moved; the suggestions' (in KV) are untouched.
    expect(kv.data.size).toBe(0)
    expect(limits.keys().every((k) => k === 'hour' || k.startsWith('db:rl:'))).toBe(true)
    // GitHub saw the database branch only: no suggest/ branch, no pull request.
    expect(gh.calls.every((c) => c.branch === 'database')).toBe(true)
    expect(gh.suggestBranches()).toEqual([])
    expect(gh.pulls).toHaveLength(0)
  })

  it('holds its limits when many requests arrive at the same moment', async () => {
    const { gh, send } = setup({ RATE_DB_CLIENT_PER_HOUR: '2', RATE_DB_IP_PER_HOUR: '50' })
    // All of them read the counters before any is counted; the Durable Object counts one at a time.
    const answers = await Promise.all(
      Array.from({ length: 10 }, (_, i) => send(request([row(`steam-${i + 1}`)])))
    )
    expect(answers.filter((r) => r.status === 200)).toHaveLength(2)
    expect(answers.filter((r) => r.status === 429)).toHaveLength(8)
    expect(gh.dbCalls.filter((c) => c.method === 'PUT')).toHaveLength(2)
  })

  it('counts nothing in a new hour that the previous hour counted', async () => {
    const { limits, send } = setup()
    expect((await send(request([row('steam-1')]))).status).toBe(200)
    expect((await send(request([row('steam-2')]))).status).toBe(200)
    expect((await send(request([row('steam-3')]))).status).toBe(429)
    limits.data.set('hour', Math.floor(NOW / 3_600_000) - 1)
    // The stored hour is behind the clock: everything is cleared, and the client may send again.
    expect((await send(request([row('steam-3')]))).status).toBe(200)
  })

  it('answers 503, writing nothing, when the counters cannot be read', async () => {
    const { gh, limits, send } = setup()
    limits.failWith = 500
    const res = await send(request([row('steam-1')]))
    expect(res.status).toBe(503)
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(gh.calls).toHaveLength(0)
  })

  it('runs with the deployed limits when the variables are missing', () => {
    expect(dbRateLimitConfig({})).toEqual(DEFAULT_DB_RATE_LIMITS)
    expect(dbRateLimitConfig({ RATE_DB_CLIENT_PER_HOUR: '7' }).clientPerHour).toBe(7)
  })

  it('reads again and retries when another commit landed between its read and its write', async () => {
    const { gh, send } = setup()
    const path = gameDbShardPath('steam-620')
    // Two more keys in the same shard as steam-620.
    const [old, mine] = Array.from({ length: 200 }, (_, i) => `steam-${i + 1}`)
      .filter((k) => k !== 'steam-620' && gameDbShardPath(k) === path)
      .slice(0, 2)
    gh.dbFiles.set(path, encodeGameDbCsv([row(old)]))
    // steam-620 arrives from someone else between the relay's read and its write.
    gh.races = [
      (files) => files.set(path, encodeGameDbCsv([row(old), row('steam-620', { title: 'X' })]))
    ]
    const res = await send(request([row('steam-620'), row(mine)]))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ added: [mine], present: ['steam-620'], later: [] })
    expect(gh.dbFile(path)).toBe(
      encodeGameDbCsv([row(old), row(mine), row('steam-620', { title: 'X' })])
    )
    expect(gh.dbCalls.map((c) => c.method)).toEqual(['GET', 'PUT', 'GET', 'PUT'])
  })

  it('reports games whose shards it did not get to as later, and keeps what it wrote', async () => {
    const { gh, send } = setup()
    // Shards are written in path order; the second one fails.
    const keys = ['steam-1', 'steam-2', 'steam-3', 'steam-4', 'steam-5', 'steam-6']
    const paths = [...new Set(keys.map(gameDbShardPath))].sort()
    gh.failures = [{ method: 'PUT', path: `/contents/${paths[1]}`, status: 500 }]
    const res = await send(request(keys.map((k) => row(k))))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { added: string[]; later: string[] }
    const inFirst = keys.filter((k) => gameDbShardPath(k) === paths[0])
    expect(body.added).toEqual(inFirst)
    expect([...body.later].sort()).toEqual(keys.filter((k) => !inFirst.includes(k)).sort())
    // The sender keeps the later ones and sends them again after a short wait.
    expect(Number(res.headers.get('Retry-After'))).toBe(DB_LATER_RETRY_AFTER)
  })

  it('says when to send the rest when a rate limit stopped it part way', async () => {
    const { gh, limits, send } = setup()
    // The first shard holds its games already (nothing to count); the second would be the first write.
    const keys = ['steam-1', 'steam-2', 'steam-3', 'steam-4', 'steam-5', 'steam-6']
    const paths = [...new Set(keys.map(gameDbShardPath))].sort()
    const first = keys.filter((k) => gameDbShardPath(k) === paths[0])
    gh.dbFiles.set(paths[0], encodeGameDbCsv(first.map((k) => row(k))))
    // Other requests from this client use up its hour while this one reads the first shard.
    const github = gh.fetch
    gh.fetch = async (input, init) => {
      limits.data.set(`db:rl:client:client-0001:${Math.floor(NOW / 3_600_000)}`, '2')
      return github(input, init)
    }
    const res = await send(request(keys.map((k) => row(k))))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { added: string[]; present: string[]; later: string[] }
    expect(body.added).toEqual([])
    expect(body.present).toEqual(first)
    expect(body.later.length).toBe(keys.length - first.length)
    const wait = Number(res.headers.get('Retry-After'))
    expect(wait).toBeGreaterThan(DB_LATER_RETRY_AFTER)
    expect(wait).toBeLessThanOrEqual(3600)
  })

  it('stays within the GitHub calls one request may make', async () => {
    const { gh, send } = setup()
    // 25 keys over many prefixes (real systems, none a store's): one shard each, more than the call budget allows.
    const systems = [...DB_PLATFORMS]
      .filter((p) => !['pc', 'steam', 'epic', 'xbox'].includes(p) && !p.includes('-'))
      .slice(0, 25)
    const rows = systems.map((p) => row(`${p}-game`, { platform: p, steamAppId: null }))
    expect(new Set(rows.map((r) => gameDbShardPath(r.key))).size).toBe(25)
    const res = await send(request(rows))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { added: string[]; later: string[] }
    expect(gh.dbCalls.length).toBeLessThanOrEqual(MAX_DB_GITHUB_CALLS)
    expect(body.added).toHaveLength(Math.floor(MAX_DB_GITHUB_CALLS / 2))
    expect(body.added.length + body.later.length).toBe(25)
    expect(Number(res.headers.get('Retry-After'))).toBe(DB_LATER_RETRY_AFTER)
  })

  it('answers 502 when GitHub refuses the first write, and counts it as turned away', async () => {
    const { gh, limits, send } = setup()
    gh.failures = [{ method: 'PUT', path: '/contents/', status: 403 }]
    const res = await send(request([row('steam-1')]))
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: string }).error).toBe(
      'relay cannot reach the PlayOut database (token)'
    )
    expect(limits.keys().some((k) => k.startsWith('db:rl:client:'))).toBe(true)
  })

  it('answers 503 when the relay is not configured for the database', async () => {
    for (const patch of [
      { DB_LIMITS: undefined },
      { DB_REPO_OWNER: undefined },
      { DB_REPO_NAME: undefined },
      { GITHUB_TOKEN: undefined },
      // Any other branch of the metadata repository, above all main and the suggestion branches.
      { DB_BRANCH: 'main' },
      { DB_BRANCH: 'suggest/steam-1-x' },
      { DB_BRANCH: 'refs/heads/database' },
      { DB_BRANCH: 'Database' },
      // Any other repository.
      { DB_REPO_NAME: 'PlayOut-db' },
      { DB_REPO_NAME: 'PlayOut' },
      { DB_REPO_OWNER: 'someone' }
    ]) {
      const { gh, send } = setup(patch)
      const res = await send(request([row('steam-1')]))
      expect(res.status, JSON.stringify(patch)).toBe(503)
      expect(((await res.json()) as { ok: boolean }).ok).toBe(false)
      expect(gh.calls).toHaveLength(0)
      expect(gh.strayCalls).toHaveLength(0)
    }
    // DB_BRANCH may be left out: the database branch.
    const { gh, send } = setup({ DB_BRANCH: undefined })
    expect((await send(request([row('steam-1')]))).status).toBe(200)
    expect(gh.dbFile(gameDbShardPath('steam-1'))).toBe(encodeGameDbCsv([row('steam-1')]))
    expect(gh.calls.every((c) => c.branch === 'database')).toBe(true)
  })
})
