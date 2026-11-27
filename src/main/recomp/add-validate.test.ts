// Checking a repository before it is added (the browser's Add → Check), against a fake GitHub: no network.
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import type { RecompRepoCheck } from '../../shared/recomp'
import type { Logger } from '../logger'
import { checkRecompRepo, guessGame } from './add-validate'
import { FetchFailed } from './http-cache'
import { RepoNotFound, type GhRelease } from './releases'

const log: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
const cache = { dir: join(tmpdir(), 'playout-never-written'), log }

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  })

const repoInfo = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  full_name: 'Zelda64Recomp/Zelda64Recomp',
  private: false,
  visibility: 'public',
  disabled: false,
  archived: false,
  fork: false,
  description: 'Static recompilation of Majora’s Mask for PC.',
  stargazers_count: 5100,
  license: { spdx_id: 'GPL-3.0' },
  ...over
})

const release = (tag: string, assets: string[], over: Partial<GhRelease> = {}): GhRelease => ({
  tag_name: tag,
  name: tag,
  published_at: '2026-11-01T00:00:00Z',
  prerelease: false,
  draft: false,
  body: '',
  html_url: `https://github.com/x/y/releases/tag/${tag}`,
  assets: assets.map((name) => ({
    name,
    size: 30_000_000,
    browser_download_url: `https://github.com/x/y/releases/download/${tag}/${name}`
  })),
  ...over
})

function check(
  input: string,
  opts: {
    info?: Response
    releases?: GhRelease[] | Error
    listed?: (id: string) => string | null
  } = {}
): Promise<{ result: RecompRepoCheck; urls: string[] }> {
  const urls: string[] = []
  const fetchFn = (async (url: string | URL | Request) => {
    urls.push(String(url))
    return opts.info ?? json(repoInfo())
  }) as typeof fetch
  return checkRecompRepo(input, {
    cache,
    fetch: fetchFn,
    fetchReleases: async (entry) => {
      urls.push(`releases:${entry.repo}`)
      if (opts.releases instanceof Error) throw opts.releases
      return opts.releases ?? [release('v1.4.0', ['Zelda64Recompiled-v1.4.0-Windows.zip'])]
    },
    listed: opts.listed ?? (() => null)
  }).then((result) => ({ result, urls }))
}

describe('checkRecompRepo', () => {
  it('takes a public repository with a Windows download, under the name GitHub spells it with', async () => {
    const { result, urls } = await check('github.com/zelda64recomp/zelda64recomp/releases')
    expect(result).toMatchObject({
      ok: true,
      id: 'github:zelda64recomp/zelda64recomp',
      repo: 'Zelda64Recomp/Zelda64Recomp',
      repoUrl: 'https://github.com/Zelda64Recomp/Zelda64Recomp',
      stars: 5100,
      license: 'GPL-3.0',
      archived: false,
      fork: false,
      tag: 'v1.4.0',
      asset: { name: 'Zelda64Recompiled-v1.4.0-Windows.zip', size: 30_000_000 },
      game: 'Zelda64'
    })
    if (!result.ok) throw new Error('not ok')
    expect(result.consoles.at(-1)).toEqual({ id: 'other', name: 'Other' })
    expect(urls).toEqual([
      'https://api.github.com/repos/zelda64recomp/zelda64recomp',
      'releases:Zelda64Recomp/Zelda64Recomp'
    ])
  })

  it('warns about forks and archived repositories, and still takes them', async () => {
    const { result } = await check('a/b', { info: json(repoInfo({ archived: true, fork: true })) })
    expect(result).toMatchObject({ ok: true, archived: true, fork: true })
  })

  it('refuses links it cannot use, without asking GitHub', async () => {
    for (const [input, reason] of [
      ['https://gitlab.com/a/b', 'notGithub'],
      ['not a link', 'badUrl'],
      ['https://github.com/a', 'badUrl']
    ] as const) {
      const { result, urls } = await check(input)
      expect(result, input).toMatchObject({ ok: false, reason })
      expect(urls, input).toEqual([])
    }
  })

  it('refuses missing, private and disabled repositories as not found', async () => {
    for (const info of [
      json({ message: 'Not Found' }, 404),
      json(repoInfo({ private: true, visibility: 'private' })),
      json(repoInfo({ disabled: true }))
    ]) {
      const { result } = await check('a/b', { info })
      expect(result).toMatchObject({ ok: false, reason: 'notFound' })
    }
    const gone = await check('a/b', { releases: new RepoNotFound({ host: 'github', repo: 'a/b' }) })
    expect(gone.result).toMatchObject({ ok: false, reason: 'notFound' })
  })

  it('says when GitHub limited the checks, with the time it opens again', async () => {
    const limited = json({ message: 'API rate limit exceeded' }, 403, {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(Date.UTC(2026, 10, 27, 14, 5) / 1000)
    })
    const { result } = await check('a/b', { info: limited })
    expect(result).toMatchObject({ ok: false, reason: 'rateLimited' })
    const viaReleases = await check('a/b', {
      releases: new FetchFailed('limited', 403, true)
    })
    expect(viaReleases.result).toMatchObject({ ok: false, reason: 'rateLimited' })
  })

  it('refuses a repository without releases, or without a Windows download', async () => {
    expect((await check('a/b', { releases: [] })).result).toMatchObject({ reason: 'noReleases' })
    expect(
      (await check('a/b', { releases: [release('v1', ['x.zip'], { draft: true })] })).result
    ).toMatchObject({ reason: 'noReleases' })
    expect(
      (
        await check('a/b', {
          releases: [release('v1', ['game-linux-x64.tar.gz', 'game-macos.dmg'])]
        })
      ).result
    ).toMatchObject({ reason: 'noWindows' })
  })

  it('says a listed repository is listed, with the recompilation to show', async () => {
    const { result, urls } = await check('a/b', {
      listed: (id) =>
        id === 'github:zelda64recomp/zelda64recomp' ? 'github:zelda64recomp/zelda64recomp#mm' : null
    })
    expect(result).toMatchObject({
      ok: false,
      reason: 'alreadyListed',
      existingId: 'github:zelda64recomp/zelda64recomp#mm'
    })
    // Its releases were not asked for.
    expect(urls).toHaveLength(1)
  })
})

describe('guessGame', () => {
  it('splits a repository name into the game it is probably of', () => {
    expect(guessGame('Zelda64Recomp')).toBe('Zelda64')
    expect(guessGame('sm64-port')).toBe('Sm64')
    expect(guessGame('perfect_dark-decomp')).toBe('Perfect dark')
    expect(guessGame('recomp')).toBe('Recomp')
  })
})
