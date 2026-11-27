import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import recompSchema from '../../metadata-repo/recomp-schema.json'
import { assertSuggestBranch } from '../src/github'
import { DEFAULT_MAX_OPEN_RECOMP_SUGGESTIONS, handle, recompFileKey, type Env } from '../src/index'
import { DEFAULT_RECOMP_RATE_LIMITS, recompRateLimitConfig } from '../src/ratelimit'
import { RECOMP_CONSOLE_IDS } from '../src/recomp-consoles'
import { parseRecompUrl, validateRecompSuggestion } from '../src/validate'
import { FakeDbLimits, FakeGitHub, FakeKV, publicRepo } from './fakes'

const NOW = Date.UTC(2026, 10, 27, 12, 30)
const ZWJ = '\u200d'

function setup(envPatch: Partial<Env> = {}): {
  gh: FakeGitHub
  limits: FakeDbLimits
  send: (body: unknown, opts?: { ip?: string; type?: string }) => Promise<Response>
} {
  const gh = new FakeGitHub()
  gh.otherRepos.set('zeldaret/mm', publicRepo('ZeldaRET/mm'))
  const limits = new FakeDbLimits()
  const env: Env = {
    GITHUB_TOKEN: 'test-token',
    RATE_LIMIT: new FakeKV().asKV(),
    DB_LIMITS: limits.asNamespace(),
    RATE_RECOMP_CLIENT_PER_HOUR: '2',
    RATE_RECOMP_IP_PER_HOUR: '3',
    RATE_RECOMP_GLOBAL_PER_HOUR: '5',
    ...envPatch
  }
  let n = 0
  const send = (body: unknown, opts: { ip?: string; type?: string } = {}): Promise<Response> =>
    handle(
      new Request('https://relay.example.workers.dev/suggest-recomp', {
        method: 'POST',
        headers: {
          'Content-Type': opts.type ?? 'application/json',
          'CF-Connecting-IP': opts.ip ?? '203.0.113.7'
        },
        body: typeof body === 'string' ? body : JSON.stringify(body)
      }),
      env,
      { fetch: gh.fetch, now: () => NOW, id: () => `abc${n++}` }
    )
  return { gh, limits, send }
}

const request = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  url: 'https://github.com/zeldaret/mm',
  game: "The Legend of Zelda: Majora's Mask",
  systemId: 'n64',
  blurb: 'A native PC port.',
  appVersion: '0.9.92',
  clientId: 'client-0001',
  ...extra
})

describe('POST /suggest-recomp', () => {
  it('opens a pull request with the record under the name GitHub spells the repository with', async () => {
    const { gh, limits, send } = setup()
    const mainBefore = new Map(gh.branches.get('main')!.files)
    const res = await send(request())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      pr: { number: 1, url: 'https://github.com/jeremybris/PlayOut-metadata/pull/1' }
    })
    const branch = 'suggest/recomp/zeldaret__mm-abc0'
    expect(gh.suggestBranches()).toEqual([branch])
    const record = JSON.parse(gh.branches.get(branch)!.files.get('recomps/zeldaret__mm.json')!)
    expect(record).toEqual({
      id: 'github:zeldaret/mm',
      repo: 'ZeldaRET/mm',
      repoUrl: 'https://github.com/ZeldaRET/mm',
      game: "The Legend of Zelda: Majora's Mask",
      systemId: 'n64',
      blurb: 'A native PC port.',
      addedAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString()
    })
    const pull = gh.pulls[0]!
    expect(pull.labels).toEqual(['recomp-suggestion'])
    expect(pull.head).toBe(branch)
    expect(pull.title).toBe("Recompilation: The Legend of Zelda: Majora's Mask (ZeldaRET/mm)")
    // main is untouched; nothing outside suggest/ was written.
    expect(gh.branches.get('main')!.files).toEqual(mainBefore)
    expect(gh.writes().every((c) => !c.branch || c.branch.startsWith('suggest/recomp/'))).toBe(true)
    // The rate limits: read first, one taken right before the branch.
    expect(limits.ops).toEqual(['peek', 'take'])
    expect(gh.otherCalls.map((c) => c.path)).toEqual([
      '/repos/zeldaret/mm',
      '/repos/zeldaret/mm/releases?per_page=10'
    ])
  })

  it('refuses requests it cannot take, before asking GitHub anything', async () => {
    const { gh, limits, send } = setup()
    for (const body of [
      request({ url: 'https://github.com/zeldaret/mm.git' }),
      request({ url: 'https://github.com/zeldaret/mm?tab=readme' }),
      request({ url: 'https://github.com/zeldaret/mm#readme' }),
      request({ url: 'https://github.com/zeldaret/mm/releases' }),
      request({ url: 'https://gitlab.com/zeldaret/mm' }),
      request({ url: 'http://github.com/zeldaret/mm' }),
      request({ url: 'https://github.com/zeldaret/..' }),
      request({ url: 'https://github.com/-bad/mm' }),
      request({ systemId: 'dreamcast9' }),
      request({ game: '<b>Majora</b>' }),
      request({ game: 'Two\nlines' }),
      request({ game: 'x'.repeat(201) }),
      request({ blurb: 'javascript:alert(1)' }),
      request({ clientId: 'x' }),
      request({ extra: true }),
      'not json'
    ]) {
      const res = await send(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    expect((await send(request(), { type: 'text/plain' })).status).toBe(415)
    expect((await send(JSON.stringify(request({ blurb: 'x'.repeat(70_000) })))).status).toBe(413)
    expect(gh.calls).toEqual([])
    expect(gh.otherCalls).toEqual([])
    expect(limits.ops).toEqual([])
  })

  it('answers 503 without the DB_LIMITS Durable Object', async () => {
    const { gh, send } = setup({ DB_LIMITS: undefined })
    const res = await send(request())
    expect(res.status).toBe(503)
    expect(gh.otherCalls).toEqual([])
  })

  it('turns away a repository that is missing, private, disabled or has no release with a download', async () => {
    const cases: [string, ReturnType<typeof publicRepo> | null][] = [
      ['nobody/missing', null],
      ['someone/private', publicRepo('someone/private', { private: true, visibility: 'private' })],
      ['someone/disabled', publicRepo('someone/disabled', { disabled: true })],
      ['someone/norel', publicRepo('someone/norel', {}, [])],
      [
        'someone/drafts',
        publicRepo('someone/drafts', {}, [
          { tag_name: 'v1', draft: true, assets: [{ name: 'a.zip' }] }
        ])
      ],
      ['someone/noassets', publicRepo('someone/noassets', {}, [{ tag_name: 'v1', assets: [] }])]
    ]
    for (const [name, repo] of cases) {
      const { gh, limits, send } = setup()
      if (repo) gh.otherRepos.set(name, repo)
      const res = await send(request({ url: `https://github.com/${name}` }))
      expect(res.status, name).toBe(400)
      expect(gh.writes(), name).toEqual([])
      expect(limits.ops, name).toEqual(['peek', 'turned-away'])
    }
  })

  it('accepts archived repositories and forks, and says so in the pull request', async () => {
    const { gh, send } = setup()
    gh.otherRepos.set('someone/fork', publicRepo('someone/fork', { archived: true, fork: true }))
    const res = await send(request({ url: 'https://github.com/someone/fork' }))
    expect(res.status).toBe(200)
    expect(gh.pulls[0]!.body).toMatch(/\*\*Archived:\*\*/)
    expect(gh.pulls[0]!.body).toMatch(/\*\*Fork:\*\*/)
  })

  it('answers 409 when PlayOut lists the recompilation already', async () => {
    const { gh, limits, send } = setup()
    gh.commitTo('main', 'recomps/zeldaret__mm.json', '{}')
    const res = await send(request())
    expect(res.status).toBe(409)
    expect(gh.suggestBranches()).toEqual([])
    expect(limits.ops).toEqual(['peek', 'turned-away-address'])
  })

  it('answers with the open pull request for the same repository instead of opening another', async () => {
    const { gh, limits, send } = setup()
    expect((await send(request())).status).toBe(200)
    const again = await send(request({ clientId: 'client-0002', game: 'Majora' }))
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({
      ok: true,
      pr: { number: 1, url: 'https://github.com/jeremybris/PlayOut-metadata/pull/1' },
      updated: false
    })
    expect(gh.pulls).toHaveLength(1)
    expect(gh.suggestBranches()).toHaveLength(1)
    expect(limits.ops).toEqual(['peek', 'take', 'peek', 'turned-away-address'])
  })

  it('rate limits per PlayOut install, and the limit is read before GitHub is asked', async () => {
    const { gh, send } = setup()
    for (const name of ['a/one', 'a/two', 'a/three']) gh.otherRepos.set(name, publicRepo(name))
    expect((await send(request({ url: 'https://github.com/a/one' }))).status).toBe(200)
    expect((await send(request({ url: 'https://github.com/a/two' }))).status).toBe(200)
    const reads = gh.otherCalls.length
    const res = await send(request({ url: 'https://github.com/a/three' }))
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBeTruthy()
    expect(gh.otherCalls.length).toBe(reads)
  })

  it('fails with 502 when the token cannot read the repository, without writing', async () => {
    const { gh, send } = setup()
    gh.otherReposStatus = 403
    const res = await send(request())
    expect(res.status).toBe(502)
    expect(gh.writes()).toEqual([])
  })

  it('keeps everything the user wrote inert in the pull request', async () => {
    const { gh, send } = setup()
    const res = await send(
      request({
        game: '@torvalds fixes #1 www.evil.example',
        blurb: '`x` | [y](https://evil.example)'
      })
    )
    expect(res.status).toBe(200)
    const pull = gh.pulls[0]!
    expect(pull.title).toContain(`@${ZWJ}torvalds`)
    const outside = pull.body.replace(/`[^`\n]*`/g, '')
    expect(outside).not.toMatch(/@torvalds|#1|https:\/\/evil|www\.evil/)
  })

  it('stops opening pull requests while too many recompilation suggestions wait for review', async () => {
    const { gh, send } = setup({ MAX_OPEN_RECOMP_SUGGESTIONS: '1' })
    gh.pulls.push({
      number: 7,
      title: 'x',
      head: 'suggest/recomp/a__b-aa',
      base: 'main',
      body: '',
      labels: ['recomp-suggestion']
    })
    gh.branches.set('suggest/recomp/a__b-aa', {
      sha: gh.branches.get('main')!.sha,
      files: new Map()
    })
    const res = await send(request())
    expect(res.status).toBe(429)
    expect(gh.suggestBranches()).toEqual(['suggest/recomp/a__b-aa'])
  })

  it('keeps the two backlogs apart: game suggestions never block recompilations, and the other way round', async () => {
    // A full game backlog: a recompilation still goes.
    const one = setup({ MAX_OPEN_SUGGESTIONS: '1' })
    one.gh.pulls.push({
      number: 7,
      title: 'x',
      head: 'suggest/steam-1-aa',
      base: 'main',
      body: '',
      labels: ['suggestion']
    })
    expect((await one.send(request())).status).toBe(200)

    // Recompilation spam up to its own cap: an honest game suggestion still goes.
    const gh = new FakeGitHub()
    for (let i = 0; i < 4; i++) gh.otherRepos.set(`any/repo${i}`, publicRepo(`any/repo${i}`))
    const env: Env = {
      GITHUB_TOKEN: 'test-token',
      RATE_LIMIT: new FakeKV().asKV(),
      DB_LIMITS: new FakeDbLimits().asNamespace(),
      MAX_OPEN_SUGGESTIONS: '3',
      MAX_OPEN_RECOMP_SUGGESTIONS: '3'
    }
    let n = 0
    const post = (path: string, body: unknown, ip: string): Promise<Response> =>
      handle(
        new Request(`https://relay.example.workers.dev${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
          body: JSON.stringify(body)
        }),
        env,
        { fetch: gh.fetch, now: () => NOW, id: () => `id${n++}` }
      )
    for (let i = 0; i < 3; i++) {
      const r = await post(
        '/suggest-recomp',
        request({ url: `https://github.com/any/repo${i}`, clientId: `spammer-client-${i}` }),
        `198.51.100.${i}`
      )
      expect(r.status).toBe(200)
    }
    const full = await post(
      '/suggest-recomp',
      request({ url: 'https://github.com/any/repo3', clientId: 'spammer-client-9' }),
      '198.51.100.9'
    )
    expect(full.status).toBe(429)
    const game = await post(
      '/suggest',
      {
        key: 'steam-620',
        title: 'Portal 2',
        fields: { localPlayers: 2 },
        appVersion: '0.9.92',
        clientId: 'honest-client-1'
      },
      '203.0.113.77'
    )
    expect(game.status).toBe(200)
  })

  it('a few addresses sending links that fail the checks do not block honest suggestions for the hour', async () => {
    const { send } = setup({ RATE_RECOMP_IP_PER_HOUR: '10', RATE_RECOMP_CLIENT_PER_HOUR: '5' })
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 10; j++) {
        const r = await send(
          request({ url: `https://github.com/nobody/missing${j}`, clientId: `attacker-${i}-${j}` }),
          { ip: `198.51.100.${i}` }
        )
        expect(r.status).toBe(400)
      }
    // Each of those addresses is full now...
    const again = await send(request({ clientId: 'attacker-0-x' }), { ip: '198.51.100.0' })
    expect(again.status).toBe(429)
    // ...but an honest sender elsewhere is not.
    const honest = await send(request({ clientId: 'honest-client-1' }), { ip: '203.0.113.50' })
    expect(honest.status).toBe(200)
  })

  it('counts "listed already" and "suggested already" against the sender only, not the global refusals', async () => {
    const { gh, limits, send } = setup({ RATE_RECOMP_TURNED_AWAY_GLOBAL_PER_HOUR: '2' })
    gh.commitTo('main', 'recomps/zeldaret__mm.json', '{}')
    for (let i = 0; i < 3; i++)
      expect(
        (await send(request({ clientId: `client-000${i}` }), { ip: `203.0.113.${i}` })).status
      ).toBe(409)
    expect(limits.ops.filter((o) => o === 'turned-away-address')).toHaveLength(3)
    expect(limits.ops).not.toContain('turned-away')
    // The global counter of refusals is still empty: a refusal that counts there goes on working.
    gh.otherRepos.set('a/one', publicRepo('a/one'))
    expect(
      (
        await send(request({ url: 'https://github.com/a/one', clientId: 'client-0009' }), {
          ip: '203.0.113.9'
        })
      ).status
    ).toBe(200)
  })

  it("answers 400 (never 502, which PlayOut retries) for a repository name the relay cannot store ('..')", async () => {
    const { gh, send } = setup()
    gh.otherRepos.set('evil/a..b', publicRepo('evil/a..b'))
    gh.otherRepos.set('evil/a.', publicRepo('evil/a.'))
    for (const url of ['https://github.com/evil/a..b', 'https://github.com/evil/a.']) {
      const res = await send(request({ url }))
      expect(res.status, url).toBe(400)
      expect(((await res.json()) as { error: string }).error).toMatch(/cannot be stored/)
    }
    expect(gh.suggestBranches()).toEqual([])
  })

  it('refuses a console PlayOut does not keep recompilations for, and tabs in the text', async () => {
    const { gh, limits, send } = setup()
    for (const body of [
      request({ systemId: 'emulators' }),
      request({ systemId: 'n46' }),
      request({ game: 'Zel\tda' }),
      request({ blurb: 'a\tb' })
    ]) {
      const res = await send(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    expect(gh.otherCalls).toEqual([])
    expect(limits.ops).toEqual([])
  })
})

describe('recompilation suggestion rules', () => {
  it('parses only https://github.com/<owner>/<repo>', () => {
    expect(parseRecompUrl('https://github.com/ZeldaRET/mm')).toEqual({
      owner: 'ZeldaRET',
      repo: 'mm'
    })
    expect(parseRecompUrl('https://github.com/ZeldaRET/mm/')).toEqual({
      owner: 'ZeldaRET',
      repo: 'mm'
    })
    expect(parseRecompUrl('https://github.com/a/b.c_d-e')).toEqual({ owner: 'a', repo: 'b.c_d-e' })
    for (const bad of [
      'https://github.com/a',
      'https://github.com/a/b/c',
      'https://github.com/a/.',
      'https://github.com/a-/b'.replace('a-', '-a'),
      'https://www.github.com/a/b',
      'https://github.com/a/b.git',
      `https://github.com/${'a'.repeat(40)}/b`
    ])
      expect(parseRecompUrl(bad), bad).toBeNull()
  })

  it('names the file after the repository and writes only suggest/recomp/ branches', () => {
    expect(recompFileKey('ZeldaRET/mm')).toBe('zeldaret__mm')
    for (const ok of [
      'suggest/recomp/zeldaret__mm-abc0',
      'suggest/recomp/a__b.c-1',
      'suggest/steam-620-ab'
    ])
      expect(() => assertSuggestBranch(ok), ok).not.toThrow()
    for (const bad of [
      'suggest/recomp/../main-1',
      'suggest/recomp/Zelda__mm-1',
      'suggest/recomp/a__b.lock',
      'suggest/recomp/',
      'suggest/recomp/a/b-1',
      'main'
    ])
      expect(() => assertSuggestBranch(bad), bad).toThrow()
  })

  it('takes exactly the consoles PlayOut keeps and the metadata repository allows', () => {
    const schemaIds = (recompSchema as unknown as { properties: { systemId: { enum: string[] } } })
      .properties.systemId.enum
    expect([...RECOMP_CONSOLE_IDS].sort()).toEqual([...schemaIds].sort())
    expect(new Set(RECOMP_CONSOLE_IDS).size).toBe(RECOMP_CONSOLE_IDS.length)
    expect(RECOMP_CONSOLE_IDS).toContain('other')
  })

  it('has code defaults equal to wrangler.toml', () => {
    expect(recompRateLimitConfig({})).toEqual(DEFAULT_RECOMP_RATE_LIMITS)
    expect(DEFAULT_RECOMP_RATE_LIMITS).toEqual({
      ipPerHour: 10,
      ip48PerHour: 15,
      clientPerHour: 5,
      globalPerHour: 30,
      turnedAwayGlobalPerHour: 400
    })
    expect(DEFAULT_MAX_OPEN_RECOMP_SUGGESTIONS).toBe(30)
    const toml = readFileSync(join(__dirname, '..', 'wrangler.toml'), 'utf8')
    expect(toml).toMatch(/^RATE_RECOMP_TURNED_AWAY_GLOBAL_PER_HOUR = "400"$/m)
    expect(toml).toMatch(/^MAX_OPEN_RECOMP_SUGGESTIONS = "30"$/m)
    expect(validateRecompSuggestion(JSON.stringify(request({ systemId: 'other' }))).ok).toBe(true)
  })
})
