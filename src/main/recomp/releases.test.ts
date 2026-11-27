import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CachedFetchDeps } from './http-cache'
import {
  fetchReadme,
  fetchReleases,
  isNewer,
  isRepublished,
  latestRelease,
  newestRelease,
  pinFor,
  replacesSidePiece,
  RepoNotFound,
  sha256FromDigest,
  toRecompRelease,
  versionKey,
  type GhRelease
} from './releases'

const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
const HEX = 'd02b95f1cf5e4d44d6587fa6136c6db521f61aa41ba8700c05f91bea8b0a26d0'

function rel(
  tag: string,
  publishedAt: string | null,
  assets: string[],
  extra: Partial<GhRelease> = {}
): GhRelease {
  return {
    tag_name: tag,
    name: tag,
    published_at: publishedAt,
    prerelease: false,
    draft: false,
    body: `notes for ${tag}`,
    html_url: `https://github.com/o/r/releases/tag/${tag}`,
    assets: assets.map((name) => ({
      name,
      size: 10,
      browser_download_url: `https://github.com/o/r/releases/download/${tag}/${name}`,
      digest: `sha256:${HEX.toUpperCase()}`
    })),
    ...extra
  }
}

let dir: string
let calls: { url: string; headers: Record<string, string> }[]
function deps(respond: (url: string) => Response | Promise<Response>): CachedFetchDeps {
  return {
    dir,
    log,
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
      return respond(url)
    }) as unknown as typeof fetch
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'recomp-releases-'))
  calls = []
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('fetchReleases', () => {
  it('reads GitHub release lists and caches them', async () => {
    const body = JSON.stringify([
      rel('v1.2.2', '2025-08-27T00:58:35Z', ['Zelda64Recompiled-v1.2.2-Windows.zip']),
      { junk: true }
    ])
    const d = deps(() => new Response(body, { status: 200 }))
    const list = await fetchReleases({ host: 'github', repo: 'Zelda64Recomp/Zelda64Recomp' }, d)
    expect(list).toHaveLength(1)
    expect(list[0]!.assets[0]!.name).toBe('Zelda64Recompiled-v1.2.2-Windows.zip')
    expect(calls[0]!.url).toBe(
      'https://api.github.com/repos/Zelda64Recomp/Zelda64Recomp/releases?per_page=30'
    )
    expect(calls[0]!.headers.Accept).toBe('application/vnd.github+json')
    // Fresh in the cache: no second request.
    await fetchReleases({ host: 'github', repo: 'Zelda64Recomp/Zelda64Recomp' }, d)
    expect(calls).toHaveLength(1)
  })

  it('maps GitLab releases', async () => {
    const body = JSON.stringify([
      {
        tag_name: 'v2.0',
        name: 'Two',
        released_at: '2026-01-02T00:00:00Z',
        description: 'gitlab notes',
        upcoming_release: false,
        _links: { self: 'https://gitlab.com/g/p/-/releases/v2.0' },
        assets: {
          sources: [{ format: 'zip', url: 'https://gitlab.com/g/p/-/archive/v2.0/p-v2.0.zip' }],
          links: [
            {
              name: 'Game-windows.zip',
              url: 'https://gitlab.com/g/p/-/package_files/1/download',
              direct_asset_url: 'https://gitlab.com/g/p/-/releases/v2.0/downloads/Game-windows.zip'
            }
          ]
        }
      },
      { tag_name: 'v3.0', upcoming_release: true, assets: { links: [] } }
    ])
    const list = await fetchReleases(
      { host: 'gitlab', repo: 'g/p' },
      deps(() => new Response(body))
    )
    expect(calls[0]!.url).toBe('https://gitlab.com/api/v4/projects/g%2Fp/releases?per_page=30')
    expect(list[0]).toEqual({
      tag_name: 'v2.0',
      name: 'Two',
      published_at: '2026-01-02T00:00:00Z',
      prerelease: false,
      draft: false,
      body: 'gitlab notes',
      html_url: 'https://gitlab.com/g/p/-/releases/v2.0',
      assets: [
        {
          name: 'Game-windows.zip',
          size: 0,
          browser_download_url: 'https://gitlab.com/g/p/-/releases/v2.0/downloads/Game-windows.zip',
          digest: null
        }
      ]
    })
    expect(list[1]!.draft).toBe(true)
  })

  it('reads Codeberg (Forgejo) releases', async () => {
    const body = JSON.stringify([rel('1.0', '2026-01-01T00:00:00Z', ['Game-win64.zip'])])
    const list = await fetchReleases(
      { host: 'codeberg', repo: 'o/r' },
      deps(() => new Response(body))
    )
    expect(calls[0]!.url).toBe('https://codeberg.org/api/v1/repos/o/r/releases?limit=30')
    expect(list[0]!.tag_name).toBe('1.0')
  })

  it('says a repository is gone on a 404 (also when cached), and fails when nothing is cached', async () => {
    const gone = deps(() => new Response('', { status: 404 }))
    await expect(fetchReleases({ host: 'github', repo: 'o/gone' }, gone)).rejects.toThrow(
      new RepoNotFound({ host: 'github', repo: 'o/gone' })
    )
    await expect(fetchReleases({ host: 'github', repo: 'o/gone' }, gone)).rejects.toThrow(
      'o/gone was not found on GitHub (removed, renamed or made private)'
    )
    expect(calls).toHaveLength(1) // the 404 was cached
    expect(
      await fetchReleases(
        { host: 'github', repo: 'o/empty' },
        deps(() => new Response('[]'))
      )
    ).toEqual([])
    await expect(
      fetchReleases(
        { host: 'github', repo: 'o/down' },
        deps(() => new Response('', { status: 500 }))
      )
    ).rejects.toThrow()
  })
})

describe('latestRelease / isNewer', () => {
  const list = [
    rel('v1.3.0-beta1', '2026-03-01T00:00:00Z', ['Game-v1.3.0-beta1-Windows.zip'], {
      prerelease: true
    }),
    rel('v1.2.2', '2026-02-01T00:00:00Z', ['Game-v1.2.2-Linux.zip']),
    rel('v1.2.1', '2026-01-15T00:00:00Z', ['Game-v1.2.1-Windows.zip']),
    rel('v1.2.0', '2026-01-01T00:00:00Z', ['Game-v1.2.0-Windows.zip']),
    rel('v1.1.0', '2025-12-01T00:00:00Z', ['Game-v1.1.0-Windows.zip'], { draft: true })
  ]
  const hint = { pattern: 'Game-*-Windows.zip' }

  it('offers the newest stable release with a Windows build', () => {
    expect(latestRelease(list, null, hint)?.tag_name).toBe('v1.2.1')
    expect(latestRelease(list, 'v1.2.0', hint)?.tag_name).toBe('v1.2.1')
    expect(latestRelease(list, '1.2.1', hint)?.tag_name).toBe('v1.2.1')
  })

  it('newestRelease / pinFor: the newest installable release, and the pin a chosen release leaves', () => {
    expect(newestRelease(list, hint)?.tag_name).toBe('v1.2.1')
    // Only pre-releases have a Windows build: the newest pre-release.
    const preOnly = [list[0]!, rel('v1.2.2', '2026-02-01T00:00:00Z', ['Game-v1.2.2-Linux.zip'])]
    expect(newestRelease(preOnly, hint)?.tag_name).toBe('v1.3.0-beta1')
    expect(newestRelease([list[1]!], hint)).toBeNull()
    // Older than the newest: kept. The newest, or a pre-release newer than it: follows updates again.
    expect(pinFor(list, 'v1.2.0', hint)).toBe('v1.2.0')
    expect(pinFor(list, 'v1.2.1', hint)).toBeNull()
    expect(pinFor(list, 'v1.3.0-beta1', hint)).toBeNull()
    expect(pinFor([list[1]!], 'v1.2.2', hint)).toBeNull()
  })

  it('offers pre-releases to a player on a pre-release', () => {
    const withOlderPre = [
      ...list,
      rel('v1.0.0-rc1', '2025-01-01T00:00:00Z', ['Game-v1.0.0-rc1-Windows.zip'], {
        prerelease: true
      })
    ]
    expect(latestRelease(withOlderPre, 'v1.0.0-rc1', hint)?.tag_name).toBe('v1.3.0-beta1')
  })

  it('never offers something older than the installed release', () => {
    // On a pre-release that has no Windows build any more: the older stable releases are not offered.
    const preGone = [
      rel('v1.3.0-beta1', '2026-03-01T00:00:00Z', ['Game-v1.3.0-beta1-Linux.zip'], {
        prerelease: true
      }),
      ...list.slice(1)
    ]
    expect(latestRelease(preGone, 'v1.3.0-beta1', hint)).toBeNull()
    const onlyOld = [list[3]!]
    expect(latestRelease(onlyOld, 'v2.0.0', hint)).toBeNull()
  })

  it('ignores test uploads', () => {
    const tests = [
      rel('v9', '2027-01-01T00:00:00Z', ['Game-v9-Windows.zip'], { name: 'Test build only' }),
      ...list
    ]
    expect(latestRelease(tests, null, hint)?.tag_name).toBe('v1.2.1')
  })

  it('compares by date, list order, then version numbers', () => {
    expect(isNewer('v1.2.1', 'v1.2.0', list)).toBe(true)
    expect(isNewer('v1.2.0', 'v1.2.1', list)).toBe(false)
    expect(isNewer('V1.2.0', 'v1.2.0', list)).toBe(false)
    const undated = [rel('b', null, []), rel('a', null, [])]
    expect(isNewer('b', 'a', undated)).toBe(true)
    expect(isNewer('a', 'b', undated)).toBe(false)
    // Installed tag no longer listed: version numbers decide.
    expect(isNewer('v1.2.1', 'v1.0.9', list)).toBe(true)
    expect(isNewer('v1.2.1', 'v1.10.0', list)).toBe(false)
    expect(isNewer('1.0.0', '1.0.0-rc2', [])).toBe(true)
    expect(isNewer('nightly', 'stable', [])).toBe(false)
  })

  it('never offers a backport published after a higher version', () => {
    const backport = [
      rel('v1.9.5', '2026-02-01T00:00:00Z', ['Game-v1.9.5-Windows.zip']),
      rel('v2.0.0', '2026-01-01T00:00:00Z', ['Game-v2.0.0-Windows.zip'])
    ]
    expect(isNewer('v1.9.5', 'v2.0.0', backport)).toBe(false)
    expect(isNewer('v2.0.0', 'v1.9.5', backport)).toBe(true)
    expect(latestRelease(backport, null, hint)?.tag_name).toBe('v2.0.0')
    expect(latestRelease(backport, 'v2.0.0', hint)?.tag_name).toBe('v2.0.0')
    // Tags numbered differently ("geometrywars3-v1" / "splitsecond-v2") still go by date.
    const mixed = [
      rel('splitsecond-v1', '2026-02-01T00:00:00Z', ['Game-a-Windows.zip']),
      rel('geometrywars3-v2', '2026-01-01T00:00:00Z', ['Game-b-Windows.zip'])
    ]
    expect(isNewer('splitsecond-v1', 'geometrywars3-v2', mixed)).toBe(true)
  })

  it('tells a rolling tag published again from the installed build', () => {
    const nightly = (at: string, size = 10, digest = HEX): GhRelease => ({
      ...rel('nightly', at, ['Game-nightly-Windows.zip']),
      assets: [
        {
          name: 'Game-nightly-Windows.zip',
          size,
          browser_download_url: 'https://github.com/o/r/releases/download/nightly/x.zip',
          digest: `sha256:${digest}`
        }
      ]
    })
    const installed = {
      tag: 'nightly',
      asset: 'Game-nightly-Windows.zip',
      downloadBytes: 10,
      sha256: HEX,
      publishedAt: '2026-01-01T00:00:00Z'
    }
    expect(isRepublished(nightly('2026-01-01T00:00:00Z'), installed, hint)).toBe(false)
    expect(isRepublished(nightly('2026-02-01T00:00:00Z'), installed, hint)).toBe(true)
    expect(isRepublished(rel('v1', '2027-01-01T00:00:00Z', []), installed, hint)).toBe(false)
    // An older record without a publish date: the same file by checksum, else size.
    const old = { ...installed, publishedAt: undefined }
    expect(isRepublished(nightly('2026-02-01T00:00:00Z'), old, hint)).toBe(false)
    expect(isRepublished(nightly('2026-02-01T00:00:00Z', 10, 'a'.repeat(64)), old, hint)).toBe(true)
    expect(
      isRepublished(nightly('2026-02-01T00:00:00Z', 11, ''), { ...old, sha256: '' }, hint)
    ).toBe(true)
    expect(isNewer('nightly', 'nightly', [nightly('2026-02-01T00:00:00Z')])).toBe(false)
  })

  it('builds version keys', () => {
    expect(versionKey('v1.2.3')).toEqual([1, 2, 3, 0, 1, 0])
    expect(versionKey('1.2.0-beta2')).toEqual([1, 2, 0, 0, 0, 2])
    expect(versionKey('nightly')).toBeNull()
  })
})

describe('toRecompRelease / sha256FromDigest', () => {
  it('describes a release with its Windows file', () => {
    const r = toRecompRelease(
      rel('v1.2.2', '2025-08-27T00:58:35Z', ['Z-v1.2.2-macOS.zip', 'Z-v1.2.2-Windows.zip']),
      {
        pattern: null
      }
    )
    expect(r).toEqual({
      tag: 'v1.2.2',
      name: 'v1.2.2',
      publishedAt: '2025-08-27T00:58:35Z',
      prerelease: false,
      notes: 'notes for v1.2.2',
      url: 'https://github.com/o/r/releases/tag/v1.2.2',
      asset: { name: 'Z-v1.2.2-Windows.zip', size: 10, sha256: HEX }
    })
    expect(toRecompRelease(rel('x', null, ['Z-Linux.zip']), { pattern: null }).asset).toBeNull()
  })

  it('reads GitHub digests', () => {
    expect(sha256FromDigest(`sha256:${HEX}`)).toBe(HEX)
    expect(sha256FromDigest('sha1:abc')).toBeNull()
    expect(sha256FromDigest(null)).toBeNull()
    expect(sha256FromDigest(undefined)).toBeNull()
  })
})

describe('fetchReadme', () => {
  it('reads the raw README, cut at 200 KB', async () => {
    const big = '#'.repeat(300 * 1024)
    const text = await fetchReadme(
      { host: 'github', repo: 'o/r' },
      deps(() => new Response(big))
    )
    expect(text.length).toBe(200 * 1024)
    expect(calls[0]!.url).toBe('https://api.github.com/repos/o/r/readme')
    expect(calls[0]!.headers.Accept).toBe('application/vnd.github.raw')
  })

  it("is '' when there is none or GitHub cannot be reached", async () => {
    expect(
      await fetchReadme(
        { host: 'github', repo: 'o/none' },
        deps(() => new Response('', { status: 404 }))
      )
    ).toBe('')
    expect(
      await fetchReadme(
        { host: 'github', repo: 'o/down' },
        deps(() => Promise.reject(new Error('offline')))
      )
    ).toBe('')
  })
})

describe('replacesSidePiece', () => {
  it("offers the game, even at the same tag, to an install of the game's server", () => {
    const release = rel('v0.4.2', '2026-11-22T01:13:27Z', [
      'ProjectAvalanche-server-windows-x64.zip',
      'ProjectAvalanche-windows-x64.zip'
    ])
    const hint = { pattern: null }
    const server = { tag: 'v0.4.2', asset: 'ProjectAvalanche-server-windows-x64.zip' }
    expect(replacesSidePiece(release, server, hint)).toBe(true)
    expect(
      replacesSidePiece(release, { ...server, asset: 'ProjectAvalanche-windows-x64.zip' }, hint)
    ).toBe(false)
    // Nothing better in the release: no offer.
    expect(
      replacesSidePiece(
        rel('v0.4.2', null, ['ProjectAvalanche-server-windows-x64.zip']),
        server,
        hint
      )
    ).toBe(false)
  })
})
