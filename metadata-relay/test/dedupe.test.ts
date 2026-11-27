import { describe, expect, it } from 'vitest'
import { MAX_PULL_PAGES } from '../src/github'
import { handle, type Env } from '../src/index'
import { FakeGitHub, FakeKV, type Call, type Pull } from './fakes'

// At most one open suggestion pull request per game: a later suggestion updates it.

const NOW = Date.UTC(2026, 10, 25, 9, 15)
const KEY = 'steam-253750'
const PATH = `games/${KEY}.json`
/** Workers' free plan: 50 subrequests per request; the GitHub App's sign-in may take 2 of them. */
const GITHUB_CALL_BUDGET = 48

function setup(files: Record<string, string> = {}): {
  gh: FakeGitHub
  kv: FakeKV
  env: Env
  send: (fields: Record<string, unknown>, extra?: Record<string, unknown>) => Promise<Response>
  /** GitHub calls each request made, in the order the requests were sent. */
  callsPerRequest: number[]
} {
  const gh = new FakeGitHub(files)
  const kv = new FakeKV()
  const env: Env = {
    GITHUB_TOKEN: 'test-token',
    RATE_LIMIT: kv.asKV(),
    RATE_IP_PER_HOUR: '50',
    RATE_CLIENT_PER_HOUR: '50',
    RATE_GLOBAL_PER_HOUR: '100'
  }
  let n = 0
  const callsPerRequest: number[] = []
  const send = (
    fields: Record<string, unknown>,
    extra: Record<string, unknown> = {}
  ): Promise<Response> => {
    const i = callsPerRequest.push(0) - 1
    const counting: typeof fetch = (input, init) => {
      callsPerRequest[i]++
      return gh.fetch(input, init)
    }
    return handle(
      new Request('https://relay.example/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7' },
        body: JSON.stringify({
          key: KEY,
          title: 'Ikaruga',
          fields,
          appVersion: '0.9.71',
          clientId: 'client-0001',
          ...extra
        })
      }),
      env,
      { fetch: counting, now: () => NOW, id: () => `id${++n}` }
    )
  }
  return { gh, kv, env, send, callsPerRequest }
}

const fileOn = (gh: FakeGitHub, branch: string): { fields: Record<string, unknown> } =>
  JSON.parse(gh.branches.get(branch)!.files.get(PATH)!)

const record = (fields: Record<string, unknown>): string =>
  JSON.stringify({ key: KEY, title: 'Ikaruga', fields, updatedAt: '2026-01-01T00:00:00.000Z' })

/** Calls that changed anything on GitHub (everything but reads). */
const writes = (calls: Call[]): Call[] => calls.filter((c) => c.method !== 'GET')

/** Open pull requests from the relay's suggest/ branches. */
const openSuggestions = (gh: FakeGitHub): Pull[] =>
  gh.openPulls().filter((p) => p.head.startsWith('suggest/'))

describe('one open suggestion per game', () => {
  it('updates the open pull request with a second suggestion for the same game', async () => {
    const { gh, send } = setup()
    const first = await send({ difficulty: 'hard' })
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({
      ok: true,
      pr: { number: 1, url: 'https://github.com/jeremybris/PlayOut-metadata/pull/1' }
    })
    const firstBody = gh.pulls[0].body
    const firstHead = gh.branches.get('suggest/steam-253750-id1')!.sha

    // The owner merges something else meanwhile: main moves on.
    gh.commitTo('main', 'games/steam-620.json', record({ genres: ['Puzzle'] }))
    const mainSha = gh.branches.get('main')!.sha
    const callsBefore = gh.calls.length

    const second = await send(
      { difficulty: 'impossible', localPlayers: 2 },
      { clientId: 'client-0002' }
    )
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({
      ok: true,
      pr: { number: 1, url: 'https://github.com/jeremybris/PlayOut-metadata/pull/1' },
      updated: true
    })

    // No new branch or pull request.
    expect(gh.pulls).toHaveLength(1)
    expect(gh.suggestBranches()).toEqual(['suggest/steam-253750-id1'])
    const later = gh.calls.slice(callsBefore)
    expect(later.some((c) => c.method === 'POST' && c.path === '/pulls')).toBe(false)
    expect(later.some((c) => c.method === 'POST' && c.path === '/git/refs')).toBe(false)

    // Both suggestions combined, newest wins per field.
    expect(fileOn(gh, 'suggest/steam-253750-id1')).toEqual({
      key: KEY,
      title: 'Ikaruga',
      fields: { difficulty: 'impossible', localPlayers: 2 },
      updatedAt: new Date(NOW).toISOString()
    })
    // Rebuilt on main's current head: one commit with main's tree (its newer file included) on top of the branch's
    // head and main's head, so the branch only moves forward and its merge base with main is main's head.
    const commit = later.find((c) => c.method === 'POST' && c.path === '/git/commits')!
    expect((commit.body as { parents: string[] }).parents).toEqual([firstHead, mainSha])
    expect(gh.branches.get('suggest/steam-253750-id1')!.files.get('games/steam-620.json')).toBe(
      record({ genres: ['Puzzle'] })
    )
    const move = later.find((c) => c.method === 'PATCH' && c.path.startsWith('/git/refs/'))!
    expect(move.branch).toBe('suggest/steam-253750-id1')
    expect((move.body as { force: boolean }).force).toBe(false)

    // Body: the table for the combined change, the log of both suggestions; the title stays.
    const pr = gh.pulls[0]
    expect(pr.title).toBe('Suggestion: Ikaruga')
    expect(pr.state ?? 'open').toBe('open')
    expect(pr.body).not.toBe(firstBody)
    expect(pr.body).toContain('| Difficulty | _(none)_ | `impossible` |')
    expect(pr.body).toContain('| Local players | _(none)_ | `2` |')
    expect(pr.body).toContain('new file')
    expect(pr.body).toContain('Suggestions as sent (2, oldest first)')
    expect(pr.body.indexOf('"difficulty": "hard"')).toBeGreaterThan(0)
    expect(pr.body.indexOf('"difficulty": "hard"')).toBeLessThan(
      pr.body.indexOf('"difficulty": "impossible"')
    )
    expect(pr.body).toContain('`2026-11-25 09:15 UTC`')
    // main is untouched.
    expect(gh.branches.get('main')!.files.has(PATH)).toBe(false)
    expect(gh.branches.get('main')!.sha).toBe(mainSha)
  })

  it('keeps what main gained since the pull request was opened', async () => {
    const { gh, send } = setup({ [PATH]: record({ genres: ['Action'], difficulty: 'medium' }) })
    expect((await send({ difficulty: 'hard' })).status).toBe(200)
    // The owner corrects the genres on main directly.
    gh.commitTo('main', PATH, record({ genres: ['Shooter'], difficulty: 'medium' }))
    expect((await send({ localPlayers: 2 })).status).toBe(200)
    expect(fileOn(gh, 'suggest/steam-253750-id1').fields).toEqual({
      genres: ['Shooter'],
      difficulty: 'hard',
      localPlayers: 2
    })
    const body = gh.pulls[0].body
    expect(body).not.toContain('| Genres |')
    expect(body).toContain('| Difficulty | `medium` | `hard` |')
    expect(body).not.toContain('new file')
  })

  it('closes the pull request when the newest suggestion takes everything back to the cloud value', async () => {
    const { gh, kv, send } = setup({ [PATH]: record({ difficulty: 'medium' }) })
    expect((await send({ difficulty: 'hard' })).status).toBe(200)
    const res = await send({ difficulty: 'medium' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      ok: false,
      error: 'the suggestion matches the cloud record already'
    })
    const pr = gh.pulls[0]
    expect(pr.state).toBe('closed')
    expect(pr.comments).toHaveLength(1)
    expect(pr.comments![0]).toContain('current cloud value')
    expect(gh.suggestBranches()).toEqual([])
    expect(gh.pulls).toHaveLength(1)
    // Only the real change took one of the hour's suggestions; the withdrawal was counted as turned away.
    const hour = Math.floor(NOW / 3_600_000)
    expect(kv.data.get(`rl:client:client-0001:${hour}`)).toBe('1')
    expect(kv.data.get(`rl:no:global:${hour}`)).toBe('1')
    // A later suggestion opens a fresh pull request.
    expect((await send({ difficulty: 'easy' })).status).toBe(200)
    expect(openSuggestions(gh).map((p) => p.number)).toEqual([2])
  })

  it('writes nothing when the pull request suggests exactly this already', async () => {
    const { gh, kv, send } = setup()
    expect((await send({ difficulty: 'hard' })).status).toBe(200)
    const before = gh.calls.length
    const again = await send({ difficulty: 'hard' })
    expect(again.status).toBe(200)
    expect(((await again.json()) as { updated: boolean }).updated).toBe(true)
    expect(writes(gh.calls.slice(before))).toEqual([])
    const hour = Math.floor(NOW / 3_600_000)
    expect(kv.data.get(`rl:client:client-0001:${hour}`)).toBe('1')
  })

  it('never touches a pull request for another game, a fork, or another branch', async () => {
    const { gh, send } = setup()
    const others: Pull[] = [
      // another game whose key starts the same
      {
        number: 1,
        title: 'x',
        head: 'suggest/steam-2537500-aa11',
        base: 'main',
        body: 'a',
        labels: ['suggestion']
      },
      // another game whose key is this one plus '-...'
      {
        number: 2,
        title: 'x',
        head: `suggest/${KEY}-extra-bb22`,
        base: 'main',
        body: 'b',
        labels: ['suggestion']
      },
      // not a suggest/ branch
      {
        number: 3,
        title: 'x',
        head: `docs/${KEY}-cc33`,
        base: 'main',
        body: 'c',
        labels: ['suggestion']
      },
      // a fork's branch of the same name
      {
        number: 4,
        title: 'x',
        head: `suggest/${KEY}-dd44`,
        base: 'main',
        body: 'd',
        labels: ['suggestion'],
        fork: true
      },
      // someone's own pull request: no label, not the app
      {
        number: 5,
        title: 'x',
        head: `suggest/${KEY}-ee55`,
        base: 'main',
        body: 'e',
        labels: [],
        user: { login: 'someone', type: 'User' }
      },
      // into another branch
      {
        number: 6,
        title: 'x',
        head: `suggest/${KEY}-ff66`,
        base: 'dev',
        body: 'f',
        labels: ['suggestion']
      }
    ]
    gh.pulls.push(...others.map((p) => ({ ...p })))
    // Their branches exist here (the fork's aside), so a stray update would show.
    const main = gh.branches.get('main')!
    for (const p of others.filter((o) => !o.fork)) {
      gh.branches.set(p.head, { sha: main.sha, files: new Map(main.files) })
    }
    const res = await send({ difficulty: 'hard' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { pr: { number: number }; updated?: boolean }
    expect(body.updated).toBeUndefined()
    expect(body.pr.number).toBe(7)
    expect(gh.pulls.slice(0, 6)).toEqual(others)
    const numbers = others.map((p) => p.number)
    for (const c of writes(gh.calls)) {
      const n = c.path.match(/^\/(?:pulls|issues)\/(\d+)/)?.[1]
      if (n) expect(numbers).not.toContain(Number(n))
      if (c.branch) expect(c.branch).toBe(`suggest/${KEY}-id1`)
    }
  })

  it('folds a suggestion into the earlier pull request when two arrive at the same moment', async () => {
    const { gh, send, callsPerRequest } = setup()
    let other: Promise<Response> | null = null
    // Another request for the same game runs to its end just as this one is about to open its pull request.
    gh.onCall = async (method, path) => {
      if (method === 'POST' && path === '/pulls' && !other) {
        other = send({ localPlayers: 2 }, { clientId: 'client-0002' })
        await other
      }
    }
    const res = await send({ difficulty: 'hard' })
    gh.onCall = null
    expect((await other!).status).toBe(200)
    expect(await (await other!).clone().json()).toMatchObject({ pr: { number: 1 } })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      pr: { number: 1, url: 'https://github.com/jeremybris/PlayOut-metadata/pull/1' },
      updated: true
    })
    // One open pull request with both; the later one closed, its branch gone.
    expect(openSuggestions(gh).map((p) => p.number)).toEqual([1])
    const closed = gh.pulls.find((p) => p.number === 2)!
    expect(closed.state).toBe('closed')
    expect(closed.comments).toEqual(['Combined into #1, the open suggestion for the same game.'])
    expect(gh.suggestBranches()).toEqual(['suggest/steam-253750-id2'])
    expect(fileOn(gh, 'suggest/steam-253750-id2').fields).toEqual({
      localPlayers: 2,
      difficulty: 'hard'
    })
    expect(gh.pulls[0].body).toContain('Suggestions as sent (2, oldest first)')
    for (const n of callsPerRequest) expect(n).toBeLessThanOrEqual(GITHUB_CALL_BUDGET)
  })

  it('ends with one pull request when two requests run interleaved', async () => {
    const { gh, send } = setup()
    const [a, b] = await Promise.all([
      send({ difficulty: 'hard' }),
      send({ localPlayers: 2 }, { clientId: 'client-0002' })
    ])
    expect([a.status, b.status]).toEqual([200, 200])
    const open = openSuggestions(gh)
    expect(open).toHaveLength(1)
    expect(fileOn(gh, open[0].head).fields).toEqual({ difficulty: 'hard', localPlayers: 2 })
    expect(gh.suggestBranches()).toEqual([open[0].head])
  })

  it('leaves the pull request as it was when GitHub refuses the update', async () => {
    const { gh, send } = setup()
    expect((await send({ difficulty: 'hard' })).status).toBe(200)
    const branch = gh.branches.get('suggest/steam-253750-id1')!
    const sha = branch.sha
    const text = branch.files.get(PATH)
    const body = gh.pulls[0].body
    gh.failures.push({ method: 'PATCH', path: '/git/refs/', status: 500 })
    const res = await send({ difficulty: 'impossible' })
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: string }).error).toBe(
      'GitHub did not accept the suggestion; try again later'
    )
    expect(gh.branches.get('suggest/steam-253750-id1')!.sha).toBe(sha)
    expect(gh.branches.get('suggest/steam-253750-id1')!.files.get(PATH)).toBe(text)
    expect(gh.pulls[0].body).toBe(body)
    expect(gh.pulls[0].state ?? 'open').toBe('open')
    expect(gh.pulls).toHaveLength(1)
  })

  it('loses neither of two updates to the same pull request that race', async () => {
    const { gh, send } = setup()
    expect((await send({ difficulty: 'hard' })).status).toBe(200)
    let other: Promise<Response> | null = null
    // Another update for the game runs to its end just as this one moves the branch.
    gh.onCall = async (method, path) => {
      if (method === 'PATCH' && path.startsWith('/git/refs/') && !other) {
        other = send({ localPlayers: 2 }, { clientId: 'client-0002' })
        await other
      }
    }
    const res = await send({ difficulty: 'impossible' })
    gh.onCall = null
    expect((await other!).status).toBe(200)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { updated: boolean }).updated).toBe(true)
    // This request's move was refused (not a fast-forward any more), then redone on the new head.
    const moves = gh.calls.filter((c) => c.method === 'PATCH' && c.path.startsWith('/git/refs/'))
    expect(moves.map((c) => (c.body as { force: boolean }).force)).toEqual([false, false, false])
    expect(fileOn(gh, 'suggest/steam-253750-id1').fields).toEqual({
      difficulty: 'impossible',
      localPlayers: 2
    })
    expect(gh.pulls).toHaveLength(1)
    const body = gh.pulls[0].body
    expect(body).toContain('Suggestions as sent (3, oldest first)')
    expect(body).toContain('| Difficulty | _(none)_ | `impossible` |')
    expect(body).toContain('| Local players | _(none)_ | `2` |')
  })

  it('answers 502 and overwrites nothing when the pull request was closed during the update', async () => {
    const { gh, send } = setup({ [PATH]: record({ difficulty: 'medium' }) })
    expect((await send({ difficulty: 'hard' })).status).toBe(200)
    let other: Promise<Response> | null = null
    // Meanwhile another request takes the suggestion back: the pull request is closed, its branch deleted.
    gh.onCall = async (method, path) => {
      if (method === 'PATCH' && path.startsWith('/git/refs/') && !other) {
        other = send({ difficulty: 'medium' }, { clientId: 'client-0002' })
        await other
      }
    }
    const res = await send({ localPlayers: 2 })
    gh.onCall = null
    expect((await other!).status).toBe(409)
    expect(res.status).toBe(502)
    expect(gh.pulls[0].state).toBe('closed')
    expect(gh.suggestBranches()).toEqual([])
    expect(gh.pulls).toHaveLength(1)
  })

  it('leaves the pull request as it was when GitHub refuses to close it', async () => {
    const { gh, send } = setup({ [PATH]: record({ difficulty: 'medium' }) })
    expect((await send({ difficulty: 'hard' })).status).toBe(200)
    const branch = gh.branches.get('suggest/steam-253750-id1')!
    const sha = branch.sha
    gh.failures.push({ method: 'PATCH', path: '/pulls/', status: 500 })
    const res = await send({ difficulty: 'medium' })
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: string }).error).toBe(
      'GitHub did not accept the suggestion; try again later'
    )
    // Still open, no note claiming it was closed, the branch and its suggestion untouched.
    expect(gh.pulls[0].state ?? 'open').toBe('open')
    expect(gh.pulls[0].comments ?? []).toEqual([])
    expect(gh.branches.get('suggest/steam-253750-id1')!.sha).toBe(sha)
    expect(fileOn(gh, 'suggest/steam-253750-id1').fields).toEqual({ difficulty: 'hard' })
  })

  it('folds a race into the earlier pull request on GITHUB_TOKEN before its label is on', async () => {
    const { gh, send } = setup()
    // Signed in with a token: the pull requests are a user's, and no label lands (as if added too late).
    gh.author = { login: 'jeremybris', type: 'User' }
    gh.failures.push({ method: 'POST', path: '/issues/1/labels', status: 500 })
    gh.failures.push({ method: 'POST', path: '/issues/2/labels', status: 500 })
    let other: Promise<Response> | null = null
    gh.onCall = async (method, path) => {
      if (method === 'POST' && path === '/pulls' && !other) {
        other = send({ localPlayers: 2 }, { clientId: 'client-0002' })
        await other
      }
    }
    const res = await send({ difficulty: 'hard' })
    gh.onCall = null
    expect((await other!).status).toBe(200)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ pr: { number: 1 }, updated: true })
    expect(openSuggestions(gh).map((p) => p.number)).toEqual([1])
    expect(gh.pulls[0].labels).toEqual([])
    expect(fileOn(gh, 'suggest/steam-253750-id2').fields).toEqual({
      localPlayers: 2,
      difficulty: 'hard'
    })
  })

  it('does not fold into another user’s unlabelled pull request on GITHUB_TOKEN', async () => {
    const { gh, send } = setup()
    gh.author = { login: 'jeremybris', type: 'User' }
    gh.pulls.push({
      number: 1,
      title: 'x',
      head: `suggest/${KEY}-ee55`,
      base: 'main',
      body: 'e',
      labels: [],
      user: { login: 'someone', type: 'User' }
    })
    const main = gh.branches.get('main')!
    gh.branches.set(`suggest/${KEY}-ee55`, { sha: main.sha, files: new Map(main.files) })
    const res = await send({ difficulty: 'hard' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ pr: { number: 2 } })
    expect(gh.pulls[0].state ?? 'open').toBe('open')
    expect(openSuggestions(gh).map((p) => p.number)).toEqual([1, 2])
  })

  it('still updates the branch when only the description cannot be changed', async () => {
    const { gh, send } = setup()
    expect((await send({ difficulty: 'hard' })).status).toBe(200)
    gh.failures.push({ method: 'PATCH', path: '/pulls/', status: 500 })
    const res = await send({ difficulty: 'impossible' })
    expect(res.status).toBe(200)
    expect(fileOn(gh, 'suggest/steam-253750-id1').fields).toEqual({ difficulty: 'impossible' })
  })

  it('carries on the log of a pull request opened before the log existed', async () => {
    const { gh, send } = setup()
    expect((await send({ difficulty: 'hard' })).status).toBe(200)
    gh.pulls[0].body = [
      'Suggested metadata change for `Ikaruga` (`games/steam-253750.json`, new file).',
      '',
      '<details><summary>Suggestion as sent</summary>',
      '',
      '```json',
      '{\n  "difficulty": "hard"\n}',
      '```',
      '',
      '</details>',
      '',
      'Sent from PlayOut `0.9.70` through the metadata relay. Merge to approve, close to reject.'
    ].join('\n')
    expect((await send({ localPlayers: 2 })).status).toBe(200)
    const body = gh.pulls[0].body
    expect(body).toContain('Suggestions as sent (2, oldest first)')
    expect(body).toContain('From PlayOut `0.9.70`:')
    expect(body).toContain('"localPlayers": 2')
  })

  it('keeps the body well under GitHub’s limit however many suggestions arrive', async () => {
    const { gh, send } = setup()
    for (let i = 0; i < 12; i++) {
      const res = await send({ description: `${'Long text. '.repeat(1800)}${i}` })
      expect(res.status).toBe(200)
    }
    expect(gh.pulls).toHaveLength(1)
    const body = gh.pulls[0].body
    expect(body.length).toBeLessThan(40_000)
    expect(body).toContain('Older suggestions are left out.')
    expect(body).toContain('... (cut)')
  })
})

describe('GitHub calls per /suggest request', () => {
  /** `count` open suggestion pull requests for other games. */
  function backlog(gh: FakeGitHub, count: number, from = 100): void {
    for (let i = 0; i < count; i++) {
      gh.pulls.push({
        number: from + i,
        title: 'Suggestion',
        head: `suggest/steam-${from + i}-x`,
        base: 'main',
        body: '',
        labels: ['suggestion']
      })
    }
  }

  it('updates within the budget with the backlog at its cap', async () => {
    const { gh, env, send, callsPerRequest } = setup({ [PATH]: record({ difficulty: 'medium' }) })
    env.MAX_OPEN_SUGGESTIONS = '300'
    expect((await send({ difficulty: 'hard' })).status).toBe(200)
    backlog(gh, 299)
    // main moved on, so the merge base is read too: the longest update.
    gh.commitTo('main', 'games/steam-620.json', '{}')
    const res = await send({ difficulty: 'impossible' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { updated: boolean }).updated).toBe(true)
    expect(callsPerRequest[1]).toBeLessThanOrEqual(GITHUB_CALL_BUDGET)
    // 4 pages of pull requests (300 on the first 3, the 4th is empty), then main's head and file (2), the pull
    // request's file, merge base and base file (3), the new commit (3), the branch move and the body (2).
    expect(callsPerRequest[1]).toBe(14)
    // A new game at the cap is still refused.
    const full = await send({ difficulty: 'hard' }, { key: 'steam-999' })
    expect(full.status).toBe(429)
  })

  it('finds an older pull request for the game past the cap and updates it', async () => {
    const { gh, env, send, callsPerRequest } = setup()
    env.MAX_OPEN_SUGGESTIONS = '300'
    expect((await send({ difficulty: 'hard' })).status).toBe(200)
    // 450 newer suggestions for other games: this game's pull request (#1) is on the 5th page.
    backlog(gh, 450)
    const res = await send({ difficulty: 'impossible' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ pr: { number: 1 }, updated: true })
    expect(fileOn(gh, 'suggest/steam-253750-id1').fields).toEqual({ difficulty: 'impossible' })
    expect(callsPerRequest[1]).toBeLessThanOrEqual(GITHUB_CALL_BUDGET)
    expect(
      gh.calls.filter((c) => c.method === 'GET' && c.path === '/pulls').length
    ).toBeLessThanOrEqual(1 + MAX_PULL_PAGES + 1)
    // A new game over the cap is still refused.
    expect((await send({ difficulty: 'hard' }, { key: 'steam-999' })).status).toBe(429)
  })

  it('stays within the budget when a racing update makes it redo the rebuild', async () => {
    const { gh, env, send, callsPerRequest } = setup({ [PATH]: record({ difficulty: 'medium' }) })
    env.MAX_OPEN_SUGGESTIONS = '499'
    expect((await send({ difficulty: 'hard' })).status).toBe(200)
    backlog(gh, 450)
    gh.commitTo('main', 'games/steam-620.json', '{}')
    let other: Promise<Response> | null = null
    gh.onCall = async (method, path) => {
      if (method === 'PATCH' && path.startsWith('/git/refs/') && !other) {
        other = send({ localPlayers: 2 }, { clientId: 'client-0002' })
        await other
      }
    }
    const res = await send({ difficulty: 'impossible' })
    gh.onCall = null
    expect(res.status).toBe(200)
    // 5 pages, main (2), plan (3), tree (1), commit (2), refused move (1), the pull request again (1), plan (2: its
    // new head is on main already), commit (2), move (1), body (1).
    expect(callsPerRequest[1]).toBe(MAX_PULL_PAGES + 16)
    expect(callsPerRequest[1]).toBeLessThanOrEqual(GITHUB_CALL_BUDGET)
  })

  it('opens and folds within the budget', async () => {
    const { gh, env, send, callsPerRequest } = setup()
    env.MAX_OPEN_SUGGESTIONS = '499'
    backlog(gh, 400)
    let other: Promise<Response> | null = null
    gh.onCall = async (method, path) => {
      if (method === 'POST' && path === '/pulls' && !other) {
        other = send({ localPlayers: 2 }, { clientId: 'client-0002' })
        await other
      }
    }
    const res = await send({ difficulty: 'hard' })
    gh.onCall = null
    expect(((await res.json()) as { updated: boolean }).updated).toBe(true)
    // the plain new pull request, then the one that folded itself into it
    expect(callsPerRequest[1]).toBe(MAX_PULL_PAGES + 7)
    expect(callsPerRequest[0]).toBeLessThanOrEqual(GITHUB_CALL_BUDGET)
    expect(callsPerRequest[0]).toBe(MAX_PULL_PAGES + 7 + 10)
  })

  it('pages through no more than MAX_PULL_PAGES of open pull requests', async () => {
    const { gh, send, callsPerRequest } = setup()
    for (let i = 0; i < 700; i++) {
      gh.pulls.push({
        number: i + 1,
        title: 'x',
        head: `feature-${i}`,
        base: 'main',
        body: '',
        labels: []
      })
    }
    const res = await send({ difficulty: 'hard' })
    expect(res.status).toBe(429)
    expect(callsPerRequest[0]).toBe(MAX_PULL_PAGES)
  })
})
