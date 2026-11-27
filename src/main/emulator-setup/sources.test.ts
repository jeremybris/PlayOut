import { describe, expect, it } from 'vitest'
import type { Logger } from '../logger'
import type { HttpDeps } from './download'
import { resolveSource, stableVersions } from './sources'

const log: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
const HEX = 'ab'.repeat(32)

/** A fetch answering by URL from a table; unknown URLs are 404. */
function fake(routes: Record<string, () => Response>): { deps: HttpDeps; calls: string[] } {
  const calls: string[] = []
  const fn = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input)
    calls.push(url)
    const route = routes[url]
    return route ? route() : new Response('not found', { status: 404 })
  }
  return { deps: { fetch: fn as typeof fetch, log, retryDelayMs: 0 }, calls }
}

describe('resolveSource', () => {
  it('github: first matching asset with digest, size and tag', async () => {
    const { deps, calls } = fake({
      'https://api.github.com/repos/PCSX2/pcsx2/releases/latest': () =>
        Response.json({
          tag_name: 'v2.6.3',
          assets: [
            {
              name: 'pcsx2-v2.6.3-linux.AppImage',
              browser_download_url: 'https://gh/linux',
              size: 1
            },
            {
              name: 'pcsx2-v2.6.3-windows-x64-Qt.7z',
              browser_download_url: 'https://gh/win.7z',
              size: 1234,
              digest: `sha256:${HEX.toUpperCase()}`
            }
          ]
        })
    })
    const out = await resolveSource(
      { kind: 'github', repo: 'PCSX2/pcsx2', asset: /^pcsx2-v[\d.]+-windows-x64-Qt\.7z$/i },
      deps
    )
    expect(out).toEqual([
      {
        version: 'v2.6.3',
        url: 'https://gh/win.7z',
        fileName: 'pcsx2-v2.6.3-windows-x64-Qt.7z',
        sha256: HEX,
        size: 1234
      }
    ])
    expect(calls).toEqual(['https://api.github.com/repos/PCSX2/pcsx2/releases/latest'])
  })

  it('github: no matching asset names the repo', async () => {
    const { deps } = fake({
      'https://api.github.com/repos/o/r/releases/latest': () =>
        Response.json({
          tag_name: 'v1',
          assets: [{ name: 'src.tar.gz', browser_download_url: 'https://x' }]
        })
    })
    await expect(
      resolveSource({ kind: 'github', repo: 'o/r', asset: /win\.zip$/ }, deps)
    ).rejects.toThrow(/GitHub release of o\/r: .*no file matching/)
  })

  it('github: a 403 rate limit is reported as such', async () => {
    const { deps } = fake({
      'https://api.github.com/repos/o/r/releases/latest': () =>
        new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } })
    })
    await expect(resolveSource({ kind: 'github', repo: 'o/r', asset: /x/ }, deps)).rejects.toThrow(
      /GitHub release of o\/r: GitHub's API rate limit/
    )
  })

  it('forgejo: asset without digest', async () => {
    const api = 'https://git.ryujinx.app/api/v1/repos/ryubing/ryujinx/releases/latest'
    const { deps } = fake({
      [api]: () =>
        Response.json({
          tag_name: '1.3.3',
          assets: [
            {
              name: 'ryujinx-1.3.3-win_x64.zip',
              browser_download_url: 'https://git/r.zip',
              size: 99
            }
          ]
        })
    })
    expect(await resolveSource({ kind: 'forgejo', api, asset: /win_x64\.zip$/ }, deps)).toEqual([
      {
        version: '1.3.3',
        url: 'https://git/r.zip',
        fileName: 'ryujinx-1.3.3-win_x64.zip',
        sha256: undefined,
        size: 99
      }
    ])
  })

  it('dolphin: the Windows x64 artifact, version = shortrev', async () => {
    const { deps } = fake({
      'https://dolphin-emu.org/update/latest/beta/': () =>
        Response.json({
          shortrev: '2609b',
          hash: 'abc',
          artifacts: [
            {
              system: 'macOS',
              url: 'https://dl.dolphin-emu.org/releases/2609b/dolphin-2609b-universal.dmg'
            },
            {
              system: 'Windows x64',
              url: 'https://dl.dolphin-emu.org/releases/2609b/dolphin-2609b-x64.7z'
            }
          ]
        })
    })
    expect(await resolveSource({ kind: 'dolphin' }, deps)).toEqual([
      {
        version: '2609b',
        url: 'https://dl.dolphin-emu.org/releases/2609b/dolphin-2609b-x64.7z',
        fileName: 'dolphin-2609b-x64.7z'
      }
    ])
  })

  it('dolphin: tolerates a changed JSON shape', async () => {
    const { deps } = fake({
      'https://dolphin-emu.org/update/latest/beta/': () =>
        Response.json({
          builds: { win: { link: 'https://dl.dolphin-emu.org/releases/2610/dolphin-2610-x64.7z' } }
        })
    })
    const [d] = await resolveSource({ kind: 'dolphin' }, deps)
    expect(d).toMatchObject({ version: '2610', fileName: 'dolphin-2610-x64.7z' })
  })

  it('dolphin: no build is an error naming Dolphin', async () => {
    const { deps } = fake({
      'https://dolphin-emu.org/update/latest/beta/': () => Response.json({ artifacts: [] })
    })
    await expect(resolveSource({ kind: 'dolphin' }, deps)).rejects.toThrow(/Dolphin update service/)
  })

  it('retroarch: highest stable folder, frontend and cores', async () => {
    const html =
      '<a href="/stable/1.9.0/">1.9.0</a><a href="/stable/1.22.2/">1.22.2</a><a href="1.21.0/">x</a>' +
      '<a href="/stable/1.3.6/">'
    const { deps } = fake({ 'https://buildbot.libretro.com/stable/': () => new Response(html) })
    expect(await resolveSource({ kind: 'retroarch' }, deps)).toEqual([
      {
        version: '1.22.2',
        url: 'https://buildbot.libretro.com/stable/1.22.2/windows/x86_64/RetroArch.7z',
        fileName: 'RetroArch.7z'
      },
      {
        version: '1.22.2',
        url: 'https://buildbot.libretro.com/stable/1.22.2/windows/x86_64/RetroArch_cores.7z',
        fileName: 'RetroArch_cores.7z'
      }
    ])
    expect(stableVersions(html)).toEqual(['1.3.6', '1.9.0', '1.21.0', '1.22.2'])
  })

  it('retroarch: an empty index is an error', async () => {
    const { deps } = fake({
      'https://buildbot.libretro.com/stable/': () => new Response('<html></html>')
    })
    await expect(resolveSource({ kind: 'retroarch' }, deps)).rejects.toThrow(/libretro buildbot/)
  })

  it('scummvm: tag without v, downloads.scummvm.org URL and its .sha256', async () => {
    const url =
      'https://downloads.scummvm.org/frs/scummvm/2026.4.0/scummvm-2026.4.0-win32-x86_64.zip'
    const { deps } = fake({
      'https://api.github.com/repos/scummvm/scummvm/releases/latest': () =>
        Response.json({ tag_name: 'v2026.4.0' }),
      [`${url}.sha256`]: () =>
        new Response(`${HEX.toUpperCase()}  scummvm-2026.4.0-win32-x86_64.zip\n`)
    })
    expect(await resolveSource({ kind: 'scummvm' }, deps)).toEqual([
      { version: '2026.4.0', url, fileName: 'scummvm-2026.4.0-win32-x86_64.zip', sha256: HEX }
    ])
  })

  it('scummvm: a missing .sha256 is tolerated', async () => {
    const { deps } = fake({
      'https://api.github.com/repos/scummvm/scummvm/releases/latest': () =>
        Response.json({ tag_name: 'v2026.4.0' })
    })
    const [d] = await resolveSource({ kind: 'scummvm' }, deps)
    expect(d!.sha256).toBeUndefined()
  })

  it('fixed: returned as is', async () => {
    const { deps, calls } = fake({})
    expect(
      await resolveSource(
        {
          kind: 'fixed',
          url: 'https://host/m2.7z',
          version: '1.1a',
          sha256: HEX,
          fileName: 'm2.7z'
        },
        deps
      )
    ).toEqual([{ version: '1.1a', url: 'https://host/m2.7z', fileName: 'm2.7z', sha256: HEX }])
    expect(calls).toEqual([])
  })
})
