import { describe, expect, it } from 'vitest'
import {
  assertSuggestBranch,
  createBranch,
  deleteBranch,
  openPullRequest,
  writeFile,
  type RepoRef
} from '../src/github'
import {
  appendRows,
  assertDbRepo,
  assertShardPath,
  DB_REPO,
  DbWriteNotAllowedError,
  readShard,
  type DbRepoRef
} from '../src/database'
import { handle, type Env } from '../src/index'
import { ipBlock48, ipBucket, takeRateLimit } from '../src/ratelimit'
import { cell, defuse, plainText, prBody } from '../src/summary'
import { FakeDbLimits, FakeGitHub, FakeKV } from './fakes'

const ZWJ = '‍'
const NOW = Date.UTC(2026, 10, 16, 12, 30)

/** The body with every code span and fenced block removed: what GitHub renders as Markdown. */
function outsideCode(body: string): string {
  return body.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
}

describe('PR text safety', () => {
  const hostile = {
    title: '@torvalds @gaearon fixes #1',
    developers: [
      '@someone',
      'closes #1',
      '[Approve here](https://evil.example/login)',
      'www.evil.example'
    ],
    tags: ['a`b`c', 'x | y', '![img](https://evil.example/p.png)']
  }
  const body = prBody({
    key: 'steam-620',
    title: hostile.title,
    before: {},
    after: { title: hostile.title, developers: hostile.developers, tags: hostile.tags },
    suggestion: { title: hostile.title, developers: hostile.developers, tags: hostile.tags },
    appVersion: '0.1.138',
    isNewFile: true
  })

  it('keeps every user value inside code spans or the code block', () => {
    const md = outsideCode(body)
    for (const bad of ['@', '#1', 'evil', '](', 'fixes', 'closes', 'torvalds']) {
      expect(md).not.toContain(bad)
    }
  })

  it('leaves no raw mention, issue reference or link anywhere, even in code', () => {
    expect(body).not.toMatch(/@[A-Za-z0-9]/)
    expect(body).not.toMatch(/#\d/)
    expect(body).not.toContain('https://')
    expect(body).not.toMatch(/www\./i)
    expect(body).toContain(`@${ZWJ}torvalds`)
  })

  it('cannot break out of a code span or a table cell', () => {
    expect(cell('a`b`c')).toBe("`a'b'c`")
    expect(cell('x | y')).toBe('`x \\| y`')
    expect(cell('line1\nline2')).toBe('`line1 ⏎ line2`')
    expect(cell(['', ''].join(''))).toBe('_(empty)_')
    // Every table row has exactly 4 unescaped pipes.
    for (const row of body.split('\n').filter((l) => l.startsWith('| '))) {
      expect(row.replace(/\\\|/g, '').split('|').length - 1).toBe(4)
    }
  })

  it('defuses PR titles and commit messages', () => {
    expect(plainText('@x fixes #2\nhttps://a.example')).toBe(
      `@${ZWJ}x fixes #${ZWJ}2 https:${ZWJ}//a.example`
    )
    expect(plainText('x'.repeat(500))).toHaveLength(120)
    expect(defuse('plain text')).toBe('plain text')
  })

  it('sends a defused title and commit message through the relay', async () => {
    const gh = new FakeGitHub()
    const kv = new FakeKV()
    const env: Env = { GITHUB_TOKEN: 't', RATE_LIMIT: kv.asKV() }
    const res = await handle(
      new Request('https://relay.example/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
        body: JSON.stringify({
          key: 'steam-620',
          title: '@victim closes #3',
          fields: { developers: ['@victim'] },
          appVersion: '0.1.138',
          clientId: 'client-0001'
        })
      }),
      env,
      { fetch: gh.fetch, now: () => NOW, id: () => 'id1' }
    )
    expect(res.status).toBe(200)
    expect(gh.pulls[0].title).toBe(`Suggestion: @${ZWJ}victim closes #${ZWJ}3`)
    const put = gh.calls.find((c) => c.method === 'PUT')!
    expect((put.body as { message: string }).message).not.toMatch(/@v|#3/)
    expect(gh.pulls[0].body).not.toMatch(/@v/)
  })
})

describe('rate-limit address buckets', () => {
  it('counts IPv4 per address', () => {
    expect(ipBucket('203.0.113.7')).toBe('v4:203.0.113.7')
    expect(ipBucket('203.0.113.8')).not.toBe(ipBucket('203.0.113.7'))
    expect(ipBucket('::ffff:203.0.113.7')).toBe('v4:203.0.113.7')
    expect(ipBucket('999.1.1.1')).toBe('unknown')
  })

  it('counts IPv6 per /64', () => {
    const a = ipBucket('2001:db8:1:2:aaaa:bbbb:cccc:dddd')
    expect(a).toBe('v6:2001:db8:1:2::/64')
    expect(ipBucket('2001:0db8:0001:0002::1')).toBe(a)
    expect(ipBucket('2001:DB8:1:2:ffff::')).toBe(a)
    expect(ipBucket('[2001:db8:1:2::5]')).toBe(a)
    expect(ipBucket('2001:db8:1:3::1')).not.toBe(a)
    expect(ipBucket('::1')).toBe('v6:0:0:0:0::/64')
    expect(ipBucket('64:ff9b::192.0.2.33')).toBe('v6:64:ff9b:0:0::/64')
  })

  it('puts unparsable addresses in one bucket', () => {
    for (const bad of [null, undefined, '', 'unknown', '1::2::3', '1:2:3:4:5:6:7:8:9', 'g::1']) {
      expect(ipBucket(bad)).toBe('unknown')
    }
  })

  it('stops one /64 that rotates addresses and client ids', async () => {
    const kv = new FakeKV().asKV()
    const config = { ipPerHour: 3, ip48PerHour: 100, clientPerHour: 100, globalPerHour: 100 }
    const results = []
    for (let i = 1; i <= 5; i++) {
      results.push(
        (await takeRateLimit(kv, `2001:db8:1:2::${i.toString(16)}`, `client-000${i}`, config, NOW))
          .ok
      )
    }
    expect(results).toEqual([true, true, true, false, false])
    expect((await takeRateLimit(kv, '2001:db8:1:99::1', 'client-0099', config, NOW)).ok).toBe(true)
  })

  it('knows the /48 of an IPv6 address and none for IPv4', () => {
    expect(ipBlock48('2001:db8:1:2:aaaa::1')).toBe('v6:2001:db8:1::/48')
    expect(ipBlock48('2001:0db8:0001:ff00::9')).toBe('v6:2001:db8:1::/48')
    expect(ipBlock48('2001:db8:2::1')).toBe('v6:2001:db8:2::/48')
    expect(ipBlock48('203.0.113.7')).toBeNull()
    expect(ipBlock48('::ffff:203.0.113.7')).toBeNull()
    expect(ipBlock48('unknown')).toBeNull()
  })

  it('stops one /48 that rotates /64s and client ids, with its own limit', async () => {
    const kv = new FakeKV().asKV()
    const config = { ipPerHour: 3, ip48PerHour: 4, clientPerHour: 100, globalPerHour: 100 }
    const results: (string | true)[] = []
    for (let i = 1; i <= 6; i++) {
      const r = await takeRateLimit(
        kv,
        `2001:db8:7:${i.toString(16)}::1`,
        `client-000${i}`,
        config,
        NOW
      )
      results.push(r.ok ? true : r.scope)
    }
    expect(results).toEqual([true, true, true, true, 'ip48', 'ip48'])
    // another /48 and IPv4 are not affected
    expect((await takeRateLimit(kv, '2001:db8:8:1::1', 'client-0100', config, NOW)).ok).toBe(true)
    expect((await takeRateLimit(kv, '203.0.113.9', 'client-0101', config, NOW)).ok).toBe(true)
  })
})

describe('writes stay under suggest/', () => {
  const gh = new FakeGitHub({ 'games/a.json': '{}' })
  const repo: RepoRef = {
    owner: 'jeremybris',
    repo: 'PlayOut-metadata',
    token: 't',
    fetch: gh.fetch
  }

  it('accepts suggest/<key>-<id> only', () => {
    expect(() => assertSuggestBranch('suggest/steam-620-ab12cd34')).not.toThrow()
    for (const bad of [
      'main',
      'refs/heads/main',
      'database',
      'refs/heads/database',
      'suggest/../database',
      'suggest/',
      'suggest/../main',
      'suggest/a/b',
      'suggest/x.lock',
      'suggest/a..b',
      'Suggest/a',
      'feature/suggest/a',
      ''
    ]) {
      expect(() => assertSuggestBranch(bad), bad).toThrow(/suggest\//)
    }
  })

  it('refuses to create, delete, commit to or open a PR from any other branch, without calling GitHub', async () => {
    const sha = gh.branches.get('main')!.sha
    await expect(createBranch(repo, 'main', sha)).rejects.toThrow()
    await expect(deleteBranch(repo, 'main')).rejects.toThrow()
    await expect(
      writeFile(repo, { path: 'games/a.json', branch: 'main', text: 'x', message: 'm' })
    ).rejects.toThrow()
    await expect(
      writeFile(repo, { path: 'config.json', branch: '', text: 'x', message: 'm' })
    ).rejects.toThrow()
    await expect(
      openPullRequest(repo, { title: 't', head: 'main', base: 'main', body: '' })
    ).rejects.toThrow()
    // Nor the database branch, which lives in the same repository.
    const dbSha = gh.branches.get('database')!.sha
    await expect(createBranch(repo, 'database', dbSha)).rejects.toThrow()
    await expect(deleteBranch(repo, 'database')).rejects.toThrow()
    await expect(
      writeFile(repo, { path: 'data/steam/07.csv', branch: 'database', text: 'x', message: 'm' })
    ).rejects.toThrow()
    await expect(
      openPullRequest(repo, { title: 't', head: 'database', base: 'main', body: '' })
    ).rejects.toThrow()
    expect(gh.calls).toHaveLength(0)
    expect(gh.branches.get('main')!.files.get('games/a.json')).toBe('{}')
    expect(gh.branches.has('database')).toBe(true)
    expect(gh.dbFiles.size).toBe(0)
  })
})

describe('database writes stay on the database shards', () => {
  const dbRow = {
    key: 'steam-620',
    title: 'Portal 2',
    platform: 'pc',
    releaseDate: '2011-04-18',
    genres: ['Puzzle'],
    tags: [],
    developers: ['Valve'],
    publishers: ['Valve'],
    localPlayers: 2,
    steamAppId: 620
  }

  it('accepts exactly the database branch of the metadata repository and data/<prefix>/<nn>.csv', () => {
    expect(DB_REPO).toEqual({ owner: 'jeremybris', repo: 'PlayOut-metadata', branch: 'database' })
    expect(() => assertDbRepo(DB_REPO)).not.toThrow()
    expect(() => assertShardPath('data/steam/07.csv')).not.toThrow()
    const repo = { owner: 'jeremybris', repo: 'PlayOut-metadata' }
    for (const bad of [
      // The metadata repository's other branches: main above all, and the suggestion branches.
      { ...repo, branch: 'main' },
      { ...repo, branch: 'suggest/x' },
      { ...repo, branch: 'suggest/steam-620-ab12cd34' },
      { ...repo, branch: 'suggest/database' },
      { ...repo, branch: 'refs/heads/database' },
      { ...repo, branch: 'heads/database' },
      { ...repo, branch: 'Database' },
      { ...repo, branch: 'database/x' },
      { ...repo, branch: 'database ' },
      { ...repo, branch: 'dev' },
      { ...repo, branch: '' },
      // Other repositories, on the database branch or not.
      { owner: 'jeremybris', repo: 'PlayOut-db', branch: 'database' },
      { owner: 'jeremybris', repo: 'PlayOut-db', branch: 'main' },
      { owner: 'jeremybris', repo: 'PlayOut', branch: 'database' },
      { owner: 'jeremybris', repo: 'playout-metadata', branch: 'database' },
      { owner: 'someone', repo: 'PlayOut-metadata', branch: 'database' },
      { owner: 'JeremyBris', repo: 'PlayOut-metadata', branch: 'database' }
    ]) {
      expect(() => assertDbRepo(bad), JSON.stringify(bad)).toThrow(DbWriteNotAllowedError)
    }
    for (const bad of [
      'data/steam/7.csv',
      'data/steam/007.csv',
      'data/steam/07.CSV',
      'data/Steam/07.csv',
      'data/a-b/07.csv',
      'data/a.b/07.csv',
      'data/../x/07.csv',
      'data/steam/../07.csv',
      'data/steam/07.csv/x',
      '/data/steam/07.csv',
      'data//07.csv',
      'data/steam/sub/07.csv',
      'games/steam-620.json',
      'README.md',
      '.github/workflows/build.yml',
      ''
    ]) {
      expect(() => assertShardPath(bad), bad).toThrow(DbWriteNotAllowedError)
    }
  })

  it('refuses to read or write anything else, without calling GitHub', async () => {
    const gh = new FakeGitHub({ 'games/a.json': '{}' })
    const ok: DbRepoRef = { ...DB_REPO, token: 't', fetch: gh.fetch }
    const rows = [dbRow]
    for (const ref of [
      { ...ok, branch: 'main' },
      { ...ok, branch: 'suggest/steam-620-ab12cd34' },
      { ...ok, branch: 'refs/heads/database' },
      { ...ok, branch: '' },
      { ...ok, branch: 'dev' },
      { ...ok, repo: 'PlayOut-db' },
      { ...ok, owner: 'other' }
    ]) {
      await expect(appendRows(ref, 'data/steam/07.csv', rows)).rejects.toThrow(
        DbWriteNotAllowedError
      )
      await expect(readShard(ref, 'data/steam/07.csv')).rejects.toThrow(DbWriteNotAllowedError)
    }
    for (const path of ['games/a.json', 'data/steam/07.json', 'all.json']) {
      await expect(appendRows(ok, path, rows)).rejects.toThrow(DbWriteNotAllowedError)
    }
    expect(gh.calls).toHaveLength(0)
    expect(gh.strayCalls).toHaveLength(0)
    expect(gh.branches.get('main')!.files.get('games/a.json')).toBe('{}')
  })

  it('/contribute writes only data/*.csv on the database branch, never main or suggest/', async () => {
    const gh = new FakeGitHub({ 'games/steam-620.json': '{}' })
    const mainBefore = new Map(gh.branches.get('main')!.files)
    const mainSha = gh.branches.get('main')!.sha
    const env: Env = {
      GITHUB_TOKEN: 't',
      RATE_LIMIT: new FakeKV().asKV(),
      DB_LIMITS: new FakeDbLimits().asNamespace(),
      DB_REPO_OWNER: 'jeremybris',
      DB_REPO_NAME: 'PlayOut-metadata',
      DB_BRANCH: 'database'
    }
    const res = await handle(
      new Request('https://relay.example/contribute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
        body: JSON.stringify({ clientId: 'client-0001', appVersion: '0.9.40', rows: [dbRow] })
      }),
      env,
      { fetch: gh.fetch, now: () => NOW }
    )
    expect(res.status).toBe(200)
    expect(gh.strayCalls).toHaveLength(0)
    // Every call, read or write, was on the database branch.
    expect(gh.calls.length).toBeGreaterThan(0)
    for (const c of gh.calls) expect(c.branch, `${c.method} ${c.path}`).toBe('database')
    const writes = gh.writes()
    expect(writes.length).toBeGreaterThan(0)
    for (const w of writes) {
      expect(w.method).toBe('PUT')
      expect(w.path).toMatch(/^\/contents\/data\/steam\/[0-9]{2}\.csv$/)
      expect((w.body as { branch: string }).branch).toBe('database')
    }
    // main is as it was (same files, same commit), no suggestion branch or pull request appeared.
    expect(gh.branches.get('main')!.files).toEqual(mainBefore)
    expect(gh.branches.get('main')!.sha).toBe(mainSha)
    expect(gh.suggestBranches()).toEqual([])
    expect(gh.pulls).toHaveLength(0)
    expect([...gh.dbFiles.keys()].every((p) => /^data\/steam\/[0-9]{2}\.csv$/.test(p))).toBe(true)
  })

  it('refuses to run /contribute against any other branch or repository in the configuration', async () => {
    for (const env of [
      { DB_REPO_OWNER: 'jeremybris', DB_REPO_NAME: 'PlayOut-metadata', DB_BRANCH: 'main' },
      { DB_REPO_OWNER: 'jeremybris', DB_REPO_NAME: 'PlayOut-metadata', DB_BRANCH: 'suggest/x' },
      {
        DB_REPO_OWNER: 'jeremybris',
        DB_REPO_NAME: 'PlayOut-metadata',
        DB_BRANCH: 'refs/heads/database'
      },
      { DB_REPO_OWNER: 'jeremybris', DB_REPO_NAME: 'PlayOut-metadata', DB_BRANCH: 'dev' },
      { DB_REPO_OWNER: 'jeremybris', DB_REPO_NAME: 'PlayOut-db' },
      { DB_REPO_OWNER: 'jeremybris', DB_REPO_NAME: 'PlayOut-db', DB_BRANCH: 'database' },
      { DB_REPO_OWNER: 'evil', DB_REPO_NAME: 'PlayOut-metadata' }
    ]) {
      const gh = new FakeGitHub()
      const res = await handle(
        new Request('https://relay.example/contribute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientId: 'client-0001', appVersion: '0.9.40', rows: [dbRow] })
        }),
        {
          GITHUB_TOKEN: 't',
          RATE_LIMIT: new FakeKV().asKV(),
          DB_LIMITS: new FakeDbLimits().asNamespace(),
          ...env
        },
        { fetch: gh.fetch, now: () => NOW }
      )
      expect(res.status, JSON.stringify(env)).toBe(503)
      expect(gh.calls).toHaveLength(0)
      expect(gh.strayCalls).toHaveLength(0)
    }
  })

  it('/suggest never writes the database branch or main, with the database configured too', async () => {
    const gh = new FakeGitHub()
    const shard = 'data/steam/07.csv'
    gh.dbFiles.set(shard, 'key,title\nsteam-620,Portal 2\n')
    const dbSha = gh.branches.get('database')!.sha
    const env: Env = {
      GITHUB_TOKEN: 't',
      RATE_LIMIT: new FakeKV().asKV(),
      DB_LIMITS: new FakeDbLimits().asNamespace(),
      DB_REPO_OWNER: 'jeremybris',
      DB_REPO_NAME: 'PlayOut-metadata',
      DB_BRANCH: 'database'
    }
    const res = await handle(
      new Request('https://relay.example/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: 'steam-620',
          title: 'Portal 2',
          fields: { genres: ['Puzzle'] },
          appVersion: '0.9.40',
          clientId: 'client-0001'
        })
      }),
      env,
      { fetch: gh.fetch, now: () => NOW, id: () => 'id1' }
    )
    expect(res.status).toBe(200)
    expect(gh.strayCalls).toHaveLength(0)
    // It does not even read the database branch.
    expect(gh.dbCalls).toHaveLength(0)
    const writes = gh.writes()
    expect(writes.some((c) => c.method === 'PUT')).toBe(true)
    for (const c of writes) {
      if (c.path.startsWith('/issues/')) continue // the label, on the pull request
      expect(c.branch, `${c.method} ${c.path}`).toMatch(/^suggest\//)
    }
    // The pull request goes from its suggest/ branch into main, for the owner to approve.
    expect(gh.pulls.map((p) => [p.head, p.base])).toEqual([['suggest/steam-620-id1', 'main']])
    expect(gh.branches.get('main')!.files.size).toBe(0)
    expect(gh.branches.get('database')!.sha).toBe(dbSha)
    expect([...gh.dbFiles.entries()]).toEqual([[shard, 'key,title\nsteam-620,Portal 2\n']])
  })
})
