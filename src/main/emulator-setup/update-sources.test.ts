import { describe, expect, it } from 'vitest'
import type { Logger } from '../logger'
import type { HttpDeps } from './download'
import { resolveSource } from './sources'
import {
  DOLPHIN_DEV,
  FLYCAST_LIST,
  compareTags,
  iniSection,
  MELONDS_NIGHTLIES,
  MGBA_LATEST,
  PPSSPP_STATUS,
  RETROARCH_NIGHTLY,
  RPCS3_UPDATE,
  RYUJINX_CANARY,
  SCUMMVM_DAILY
} from './update-sources'

// Shapes as the feeds answered on 2026-11-18 (trimmed).

const log: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
const HEX = 'c3'.repeat(32)

function fake(routes: Record<string, () => Response>): HttpDeps {
  const fn = async (input: string | URL | Request): Promise<Response> => {
    const route = routes[String(input)]
    return route ? route() : new Response('not found', { status: 404 })
  }
  return { fetch: fn as typeof fetch, log, retryDelayMs: 0 }
}

describe('update channels', () => {
  it('github-tag: the moving tag, versioned by date and digest', async () => {
    const deps = fake({
      'https://api.github.com/repos/stenzek/duckstation/releases/tags/preview': () =>
        Response.json({
          tag_name: 'preview',
          published_at: '2026-11-18T12:25:10Z',
          assets: [
            {
              name: 'duckstation-windows-x64-release.zip',
              browser_download_url:
                'https://github.com/x/preview/duckstation-windows-x64-release.zip',
              size: 75138316,
              digest: `sha256:343dcf4c${'0'.repeat(56)}`,
              updated_at: '2026-11-18T12:25:16Z'
            }
          ]
        })
    })
    const [d] = await resolveSource(
      {
        kind: 'github-tag',
        repo: 'stenzek/duckstation',
        tag: 'preview',
        asset: /^duckstation-windows-x64-release\.zip$/i
      },
      deps
    )
    expect(d).toMatchObject({
      version: 'preview-2026-11-18-343dcf4c',
      size: 75138316,
      sha256: `343dcf4c${'0'.repeat(56)}`
    })
  })

  it('github-newest: the newest non-draft release, by asset preference', async () => {
    const deps = fake({
      'https://api.github.com/repos/azahar-emu/azahar/releases?per_page=20': () =>
        Response.json([
          { tag_name: '2128.0-rc1', draft: true, assets: [] },
          {
            tag_name: '2127.0-rc4',
            prerelease: true,
            assets: [
              {
                name: 'azahar-libretro-windows-x86_64-2127.0-rc4.zip',
                browser_download_url: 'https://g/core'
              },
              { name: 'azahar-windows-mxe-2127.0-rc4.zip', browser_download_url: 'https://g/mxe' },
              { name: 'azahar-windows-msvc-2127.0-rc4.zip', browser_download_url: 'https://g/msvc' }
            ]
          }
        ])
    })
    const [d] = await resolveSource(
      {
        kind: 'github-newest',
        repo: 'azahar-emu/azahar',
        asset: [/^azahar-windows-msvc-[\w.-]+\.zip$/i, /^azahar-windows-msys2-[\w.-]+\.zip$/i]
      },
      deps
    )
    expect(d).toMatchObject({ version: '2127.0-rc4', url: 'https://g/msvc' })
  })

  it('rpcs3: the update server, with its checksum (code -1 still lists the newest build)', async () => {
    const deps = fake({
      [RPCS3_UPDATE]: () =>
        Response.json({
          return_code: -1,
          latest_build: {
            version: '0.0.43-20623',
            windows: {
              download:
                'https://github.com/RPCS3/rpcs3-binaries-win/releases/download/b/rpcs3-v0.0.43-20623_win64_msvc.7z',
              size: 37315950,
              checksum: HEX.toUpperCase()
            }
          }
        })
    })
    const [d] = await resolveSource({ kind: 'rpcs3' }, deps)
    expect(d).toEqual({
      version: '0.0.43-20623',
      url: 'https://github.com/RPCS3/rpcs3-binaries-win/releases/download/b/rpcs3-v0.0.43-20623_win64_msvc.7z',
      fileName: 'rpcs3-v0.0.43-20623_win64_msvc.7z',
      sha256: HEX,
      size: 37315950
    })
  })

  it('rpcs3: a server error code fails', async () => {
    const deps = fake({ [RPCS3_UPDATE]: () => Response.json({ return_code: -2 }) })
    await expect(resolveSource({ kind: 'rpcs3' }, deps)).rejects.toThrow(/code -2/)
  })

  it('dolphin-dev: the Windows x64 artifact of the dev track', async () => {
    const deps = fake({
      [DOLPHIN_DEV]: () =>
        Response.json({
          shortrev: '2609-289',
          artifacts: [
            {
              system: 'Windows arm64',
              url: 'https://dl.dolphin-emu.org/builds/a/dolphin-master-2609-289-ARM64.7z'
            },
            {
              system: 'Windows x64',
              url: 'https://dl.dolphin-emu.org/builds/79/3c/dolphin-master-2609-289-x64.7z'
            }
          ]
        })
    })
    const [d] = await resolveSource({ kind: 'dolphin-dev' }, deps)
    expect(d).toEqual({
      version: '2609-289',
      url: 'https://dl.dolphin-emu.org/builds/79/3c/dolphin-master-2609-289-x64.7z',
      fileName: 'dolphin-master-2609-289-x64.7z'
    })
  })

  it('ppsspp-dev: the latest finished build, never the one building', async () => {
    const deps = fake({
      [PPSSPP_STATUS]: () =>
        Response.json({
          building: { description: 'v1.20.4-5005-gaaaa' },
          latest: {
            description: 'v1.20.4-5015-g9416bbcab0d7',
            builds: {
              Windows: [
                'PPSSPPSetup_v1.20.4-5015-g9416bbcab0d7.exe',
                'ppsspp_win_v1.20.4-5015-g9416bbcab0d7.zip'
              ]
            }
          }
        })
    })
    const [d] = await resolveSource({ kind: 'ppsspp-dev' }, deps)
    expect(d).toEqual({
      version: 'v1.20.4-5015-g9416bbcab0d7',
      url: 'https://builds.ppsspp.org/builds/v1.20.4-5015-g9416bbcab0d7/ppsspp_win_v1.20.4-5015-g9416bbcab0d7.zip',
      fileName: 'ppsspp_win_v1.20.4-5015-g9416bbcab0d7.zip'
    })
  })

  it('flycast-dev: the newest master key by date (keys are not in date order)', async () => {
    const entry = (sha: string, at: string, size: number): string =>
      `<Contents><Key>win/heads/master-${sha}/flycast.zip</Key><LastModified>${at}</LastModified><ETag>&#34;e9&#34;</ETag><Size>${size}</Size></Contents>`
    const deps = fake({
      [FLYCAST_LIST]: () =>
        new Response(
          `<ListBucketResult>${entry('3a5267a5e32438026e1c5b97d5de6cd77236f72c', '2026-11-13T12:50:12.000Z', 9888652)}${entry('0'.repeat(40), '2026-10-01T00:00:00.000Z', 1)}<Contents><Key>win/heads/master-${'1'.repeat(40)}/flycast.pdb</Key><LastModified>2026-12-01T00:00:00.000Z</LastModified></Contents></ListBucketResult>`
        )
    })
    const [d] = await resolveSource({ kind: 'flycast-dev' }, deps)
    expect(d).toEqual({
      version: 'master-3a5267a',
      url: 'https://flycast-builds.s3.fr-par.scw.cloud/win/heads/master-3a5267a5e32438026e1c5b97d5de6cd77236f72c/flycast.zip',
      fileName: 'flycast-master-3a5267a.zip',
      size: 9888652
    })
  })

  it('melonds-nightly: the first Windows x86_64 entry, its commit and checksum', async () => {
    const sha = 'ab'.repeat(32)
    const deps = fake({
      [MELONDS_NIGHTLIES]: () =>
        new Response(`
<span class="entrytitle">Commit 361ffa9</span><span class="entrydate">Nov 18th 2026</span>
<table>
<tr><td class="c1"><a href="nightly/44354887100/melonDS-windows-arm64.zip">melonDS-windows-arm64</a></td><td>13 MB</td><td>${'cd'.repeat(32)}</td></tr>
<tr><td class="c1"><a href="nightly/44354887244/melonDS-windows-x86_64.zip">melonDS-windows-x86_64</a></td><td class="c1">14.08&nbsp;MB</td><td class="c1">${sha}</td></tr>
</table>
<span class="entrytitle">Commit 1111111</span>
<a href="nightly/1/melonDS-windows-x86_64.zip">old</a>`)
    })
    const [d] = await resolveSource({ kind: 'melonds-nightly' }, deps)
    expect(d).toEqual({
      version: 'nightly-361ffa9',
      url: 'https://melonds.kuribo64.net/nightly/44354887244/melonDS-windows-x86_64.zip',
      fileName: 'melonDS-nightly-361ffa9-windows-x86_64.zip',
      sha256: sha
    })
  })

  it('mgba-dev: the win64 dev build of latest.ini (win32 comes first with the same keys)', async () => {
    const deps = fake({
      [MGBA_LATEST]: () =>
        new Response(
          [
            '[meta]',
            'bucket: https://s3.amazonaws.com/mgba/',
            '[platform.win32]',
            'dev.name: build/mGBA-build-2026-11-18-win32-9186-9fcaa88.7z',
            '[platform.win64]',
            'dev.name: build/mGBA-build-2026-11-18-win64-9186-9fcaa882f25de40258f9578480854e590db12699.7z',
            'dev.size: 15573453',
            'dev.rev: 9186',
            'dev.commit: 9fcaa882f25de40258f9578480854e590db12699',
            `dev.sha256: ${HEX}`,
            'dev.debug.name: build/mGBA-build-debug.7z',
            'stable.version: 0.10.5'
          ].join('\n')
        )
    })
    const [d] = await resolveSource({ kind: 'mgba-dev' }, deps)
    expect(d).toEqual({
      version: 'r9186-9fcaa88',
      url: 'https://s3.amazonaws.com/mgba/build/mGBA-build-2026-11-18-win64-9186-9fcaa882f25de40258f9578480854e590db12699.7z',
      fileName: 'mGBA-build-2026-11-18-win64-9186-9fcaa882f25de40258f9578480854e590db12699.7z',
      sha256: HEX,
      size: 15573453
    })
  })

  it('iniSection reads one section only', () => {
    expect(iniSection('[a]\nx: 1\n[b]\nx: 2', 'b').get('x')).toBe('2')
  })

  it('ryujinx-canary: the update server tag and link', async () => {
    const deps = fake({
      [RYUJINX_CANARY]: () =>
        Response.json({
          tag: '1.3.354',
          download_url:
            'https://git.ryujinx.app/Ryubing/Canary/releases/download/1.3.354/ryujinx-canary-1.3.354-win_x64.zip'
        })
    })
    const [d] = await resolveSource({ kind: 'ryujinx-canary' }, deps)
    expect(d).toMatchObject({ version: '1.3.354', fileName: 'ryujinx-canary-1.3.354-win_x64.zip' })
  })

  it('ryujinx-canary: refuses a non-https link', async () => {
    const deps = fake({
      [RYUJINX_CANARY]: () =>
        Response.json({ tag: '1.3.354', download_url: 'http://x/ryujinx-win_x64.zip' })
    })
    await expect(resolveSource({ kind: 'ryujinx-canary' }, deps)).rejects.toThrow(/https/)
  })

  it('scummvm-daily: the -latest zip, versioned by its date and ETag', async () => {
    const deps = fake({
      [SCUMMVM_DAILY]: () =>
        new Response(null, {
          headers: {
            'last-modified': 'Wed, 18 Nov 2026 07:49:31 GMT',
            etag: '"7d91448-660884056c7cd"',
            'content-length': '131667016'
          }
        })
    })
    const [d] = await resolveSource({ kind: 'scummvm-daily' }, deps)
    expect(d).toEqual({
      version: 'master-2026-11-18-7d914486',
      url: SCUMMVM_DAILY,
      fileName: 'scummvm-windows-x86-64-master-latest.zip',
      size: 131667016
    })
  })

  it('retroarch-nightly: the frontend update and the cores, dated by the newest snapshot', async () => {
    const deps = fake({
      [RETROARCH_NIGHTLY]: () =>
        new Response(
          '<a href="/nightly/windows/x86_64/2026-11-06_RetroArch.7z">x</a><a href="/nightly/windows/x86_64/2026-11-19_RetroArch.7z">x</a><a href="RetroArch_update.7z">u</a><a href="RetroArch_cores.7z">c</a>'
        )
    })
    const d = await resolveSource({ kind: 'retroarch-nightly' }, deps)
    expect(d.map((x) => [x.version, x.fileName])).toEqual([
      ['nightly-2026-11-19', 'RetroArch_update.7z'],
      ['nightly-2026-11-19', 'RetroArch_cores.7z']
    ])
  })
})

describe('compareTags', () => {
  it('orders versions, releases above their pre-releases', () => {
    expect(compareTags('v2.9.183', 'v2.8.3')).toBeGreaterThan(0)
    expect(compareTags('2127.0-rc4', '2126.2')).toBeGreaterThan(0)
    expect(compareTags('2127.0', '2127.0-rc4')).toBeGreaterThan(0)
    expect(compareTags('2127.0-rc4', '2127.0-rc3')).toBeGreaterThan(0)
    expect(compareTags('mame0289', 'mame0289')).toBe(0)
  })
})

describe('github-newest picks by version', () => {
  it('skips a later hotfix of an older line and a release whose files are not up yet', async () => {
    const asset = (tag: string): { name: string; browser_download_url: string } => ({
      name: `pcsx2-${tag}-windows-x64-Qt.7z`,
      browser_download_url: `https://g/${tag}`
    })
    const deps = fake({
      'https://api.github.com/repos/PCSX2/pcsx2/releases?per_page=20': () =>
        Response.json([
          { tag_name: 'v2.9.184', prerelease: true, assets: [] },
          { tag_name: 'v2.8.3', assets: [asset('v2.8.3')] },
          { tag_name: 'v2.9.183', prerelease: true, assets: [asset('v2.9.183')] }
        ])
    })
    const [d] = await resolveSource(
      {
        kind: 'github-newest',
        repo: 'PCSX2/pcsx2',
        asset: [/^pcsx2-v[\d.]+-windows-x64-Qt\.7z$/i]
      },
      deps
    )
    expect(d?.version).toBe('v2.9.183')
  })
})
