import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { InstalledVrMod, VrModEntry, VrModProgress } from '../../shared/vr-mods'
import { writeZip } from '../recomp/install'
import type { GhRelease } from '../recomp/releases'
import { hasVrAsset, pickVrAsset } from './assets'
import {
  installVrMod,
  removeVrModFiles,
  safeVrFolder,
  unverifiedWarning,
  type VrInstallDeps
} from './install'
import { createVrModsService, parseCatalog } from './service'

const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

const asset = (name: string): GhRelease['assets'][number] => ({
  name,
  size: 10,
  browser_download_url: `https://github.com/o/r/releases/download/v1/${name}`,
  digest: null
})

describe('pickVrAsset', () => {
  it('prefers the Windows build like a recompilation', () => {
    const picked = pickVrAsset(
      [asset('Mod-v1-Linux.zip'), asset('Mod-v1-Windows.zip'), asset('Mod-v1.apk')],
      { pattern: null }
    )
    expect(picked?.asset.name).toBe('Mod-v1-Windows.zip')
  })

  it('keeps plain files VR mods ship (a .uevrz profile, a .dll, a .pak)', () => {
    expect(
      pickVrAsset([asset('Game.uevrz'), asset('notes.txt')], { pattern: null })?.asset.name
    ).toBe('Game.uevrz')
    expect(
      pickVrAsset([asset('dxgi.dll'), asset('Mod_P.pak')], { pattern: null })?.asset.name
    ).toBe('Mod_P.pak')
  })

  it('has nothing for a Quest-only release, a .rar or only sources', () => {
    expect(hasVrAsset([asset('Mod-v1.2.apk')], 'v1.2')).toBe(false)
    expect(hasVrAsset([asset('Mod.rar')], 'v1')).toBe(false)
    expect(hasVrAsset([asset('Mod-source.zip'), asset('checksums.sha256')], 'v1')).toBe(false)
  })
})

let tmp: string
let root: string
let served: Map<string, Buffer>
let progress: VrModProgress[]

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'vr-mods-'))
  root = join(tmp, 'VR Mods')
  served = new Map()
  progress = []
})
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

function mod(over: Partial<VrModEntry> = {}): VrModEntry {
  return {
    id: 'edge-of-eternity-vr',
    title: 'Edge of Eternity VR',
    author: 'markmon',
    date: '2026-10-29',
    status: 'First build',
    kind: 'debut',
    tags: ['PCVR'],
    summary: '',
    highlights: [],
    page: 'https://github.com/mark-mon/edge-of-eternity-vr',
    github: { owner: 'mark-mon', repo: 'edge-of-eternity-vr', tag: null },
    thread: null,
    video: null,
    reddit: null,
    outside: false,
    accent: null,
    ...over
  }
}

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

function serve(
  name: string,
  data: Buffer,
  opts: { digest?: boolean; tag?: string } = {}
): GhRelease['assets'][number] {
  const url = `https://github.com/mark-mon/edge-of-eternity-vr/releases/download/${opts.tag ?? 'v1'}/${name}`
  served.set(url, data)
  return {
    name,
    size: data.length,
    browser_download_url: url,
    digest: opts.digest === false ? null : `sha256:${sha(data)}`
  }
}

async function zipOf(files: Record<string, string>): Promise<Buffer> {
  const src = join(tmp, `src-${Math.random().toString(36).slice(2)}`)
  const entries: { name: string; path: string }[] = []
  for (const [rel, text] of Object.entries(files)) {
    const path = join(src, ...rel.split('/'))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text)
    entries.push({ name: rel, path })
  }
  const zip = join(tmp, `z-${Math.random().toString(36).slice(2)}.zip`)
  await writeZip(zip, entries)
  return readFile(zip)
}

function release(
  tag: string,
  assets: GhRelease['assets'],
  over: Partial<GhRelease> = {}
): GhRelease {
  return {
    tag_name: tag,
    name: tag,
    published_at: null,
    prerelease: false,
    draft: false,
    body: null,
    html_url: '',
    assets,
    ...over
  }
}

const fakeFetch = (async (url: string) => {
  const data = served.get(url)
  if (!data) return new Response('missing', { status: 404 })
  return new Response(new Uint8Array(data), {
    status: 200,
    headers: { 'content-length': String(data.length) }
  })
}) as unknown as typeof fetch

function deps(over: Partial<VrInstallDeps> = {}): VrInstallDeps {
  return {
    root,
    cacheDir: join(root, '.playout', 'cache'),
    http: { log, retryDelayMs: 0, fetch: fakeFetch },
    sevenZip: () => Promise.reject(new Error('7-Zip is not available in tests')),
    run: () => Promise.reject(new Error('nothing is run in tests')),
    log,
    onProgress: (p) => progress.push(p),
    freeSpace: async () => 1e12,
    ...over
  }
}

describe('installVrMod', () => {
  it('unpacks a zip into <root>/<title (id)>, verified against GitHub digest', async () => {
    const zip = await zipOf({ 'EoE-VR/dxgi.dll': 'mod', 'EoE-VR/EoE-VR.ini': 'cfg' })
    const rec = await installVrMod(mod(), release('v1', [serve('EoE-VR.zip', zip)]), null, deps())
    const dir = join(root, 'Edge of Eternity VR (edge-of-eternity-vr)')
    expect(rec.dir).toBe(dir)
    expect(await readFile(join(dir, 'dxgi.dll'), 'utf8')).toBe('mod')
    expect(rec).toMatchObject({
      id: 'edge-of-eternity-vr',
      title: 'Edge of Eternity VR',
      repo: 'mark-mon/edge-of-eternity-vr',
      tag: 'v1',
      verified: 'github',
      releaseFiles: ['dxgi.dll', 'eoe-vr.ini']
    })
    expect(progress.map((p) => p.phase)).toEqual(
      expect.arrayContaining([
        'checking',
        'downloading',
        'verifying',
        'extracting',
        'installing',
        'done'
      ])
    )
  })

  it('keeps a program as it is (never run, never opened), with the unverified warning', async () => {
    const exe = Buffer.concat([
      Buffer.from('MZ'),
      Buffer.alloc(64),
      Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])
    ])
    const rec = await installVrMod(
      mod(),
      release('v1', [serve('UEVRInjector.exe', exe, { digest: false })]),
      null,
      deps()
    )
    expect(await readFile(join(rec.dir, 'UEVRInjector.exe')).then((b) => b.equals(exe))).toBe(true)
    expect(rec.verified).toBe('unverified')
    expect(progress.at(-1)?.warning).toBe(unverifiedWarning())
  })

  it('refuses a download whose checksum does not match', async () => {
    const zip = await zipOf({ 'a.dll': 'x' })
    const a = { ...serve('m.zip', zip), digest: `sha256:${'0'.repeat(64)}` }
    await expect(installVrMod(mod(), release('v1', [a]), null, deps())).rejects.toThrow()
    expect(progress.at(-1)?.phase).toBe('failed')
    expect(existsSync(join(root, safeVrFolder(mod())))).toBe(false)
  })

  it('updates over the old release: dropped files go, the player’s own files stay', async () => {
    const v1 = await zipOf({ 'mod.dll': 'v1', 'old.pak': 'old' })
    const first = await installVrMod(mod(), release('v1', [serve('m.zip', v1)]), null, deps())
    await writeFile(join(first.dir, 'mine.ini'), 'player')
    const v2 = await zipOf({ 'mod.dll': 'v2' })
    const second = await installVrMod(
      mod(),
      release('v2', [serve('m.zip', v2, { tag: 'v2' })]),
      { ...first, updatedAt: new Date(Date.now() + 60_000).toISOString() },
      deps()
    )
    expect(await readFile(join(second.dir, 'mod.dll'), 'utf8')).toBe('v2')
    expect(existsSync(join(second.dir, 'old.pak'))).toBe(false)
    expect(await readFile(join(second.dir, 'mine.ini'), 'utf8')).toBe('player')
  })

  it('removes only folders inside the VR Mods folder', async () => {
    const zip = await zipOf({ 'mod.dll': 'x' })
    const rec = await installVrMod(mod(), release('v1', [serve('m.zip', zip)]), null, deps())
    await removeVrModFiles(rec, deps())
    expect(existsSync(rec.dir)).toBe(false)
    const outside: InstalledVrMod = { ...rec, dir: join(tmp, 'elsewhere') }
    await expect(removeVrModFiles(outside, deps())).rejects.toThrow(/not inside/)
  })
})

describe('parseCatalog', () => {
  it('drops malformed and duplicate entries', () => {
    const text = JSON.stringify({
      source: 's',
      updated: '2026-10-29',
      mods: [
        { id: 'a', title: 'A', kind: 'tool', github: { owner: 'o', repo: 'r', tag: null } },
        { id: 'a', title: 'A again' },
        { title: 'no id' },
        'junk'
      ]
    })
    const cat = parseCatalog(text)
    expect(cat.mods.map((m) => m.id)).toEqual(['a'])
    expect(cat.mods[0]).toMatchObject({
      kind: 'tool',
      github: { owner: 'o', repo: 'r', tag: null }
    })
  })
})

describe('createVrModsService', () => {
  interface Harness {
    svc: ReturnType<typeof createVrModsService>
    events: { name: string; payload: unknown }[]
    opened: string[]
    waitIdle: (id: string) => Promise<void>
  }
  async function service(releases: GhRelease[]): Promise<Harness> {
    const catalogFile = join(tmp, 'vr-mods.json')
    await writeFile(
      catalogFile,
      JSON.stringify({
        source: 'list',
        updated: '2026-10-29',
        mods: [
          mod(),
          mod({
            id: 'nexus-mod',
            title: 'Nexus mod',
            page: 'https://www.nexusmods.com/x',
            github: null
          })
        ]
      })
    )
    const events: { name: string; payload: unknown }[] = []
    const opened: string[] = []
    const svc = createVrModsService({
      userData: join(tmp, 'userData'),
      root: async () => root,
      catalogFile,
      events: { emit: (name, payload) => void events.push({ name, payload }) },
      openPath: async (p) => void opened.push(p),
      log,
      fetch: fakeFetch,
      fetchReleases: async () => releases,
      fetchReadme: async () => '# README'
    })
    const waitIdle = async (id: string): Promise<void> => {
      for (let i = 0; i < 200; i++) {
        const last = events.filter((e) => e.name === 'vr-mods:progress').at(-1)?.payload as
          VrModProgress | undefined
        if (last?.id === id && (last.phase === 'done' || last.phase === 'failed')) return
        await new Promise((r) => setTimeout(r, 10))
      }
      throw new Error('download never finished')
    }
    return { svc, events, opened, waitIdle }
  }

  it('downloads, remembers, checks for updates and removes a GitHub mod', async () => {
    const zip = await zipOf({ 'mod.dll': 'v1' })
    const rels = [release('v1', [serve('m.zip', zip)])]
    const { svc, opened, waitIdle } = await service(rels)

    const before = await svc.getVrMods()
    expect(before.root).toBe(root)
    expect(before.mods.map((m) => m.id)).toEqual(['edge-of-eternity-vr', 'nexus-mod'])
    expect(before.installed).toEqual({})

    await svc.downloadVrMod('edge-of-eternity-vr')
    await waitIdle('edge-of-eternity-vr')
    const after = await svc.getVrMods()
    expect(after.installed['edge-of-eternity-vr']?.tag).toBe('v1')
    expect(
      JSON.parse(await readFile(join(tmp, 'userData', 'vr-mods.json'), 'utf8')).installed
    ).toHaveProperty('edge-of-eternity-vr')

    // A newer release shows up.
    const zip2 = await zipOf({ 'mod.dll': 'v2' })
    rels.unshift(release('v2', [serve('m.zip', zip2, { tag: 'v2' })]))
    expect(await svc.checkVrModUpdates()).toEqual({ 'edge-of-eternity-vr': 'v2' })
    await svc.updateVrMod('edge-of-eternity-vr')
    await waitIdle('edge-of-eternity-vr')
    expect((await svc.getVrMods()).installed['edge-of-eternity-vr']?.tag).toBe('v2')
    expect((await svc.getVrMods()).updates).toEqual({})

    await svc.openVrModFolder('edge-of-eternity-vr')
    await svc.openVrModFolder(null)
    expect(opened).toEqual([join(root, 'Edge of Eternity VR (edge-of-eternity-vr)'), root])

    await svc.removeVrMod('edge-of-eternity-vr')
    expect((await svc.getVrMods()).installed).toEqual({})
    expect(existsSync(join(root, 'Edge of Eternity VR (edge-of-eternity-vr)'))).toBe(false)
    svc.dispose()
  })

  it('counts a mod as busy while it is removed, so no download of it overlaps', async () => {
    const zip = await zipOf({ 'mod.dll': 'v1' })
    const { svc, events, waitIdle } = await service([release('v1', [serve('m.zip', zip)])])
    await svc.downloadVrMod('edge-of-eternity-vr')
    await waitIdle('edge-of-eternity-vr')
    const removing = svc.removeVrMod('edge-of-eternity-vr')
    await expect(svc.downloadVrMod('edge-of-eternity-vr', 'v1')).rejects.toThrow(/being removed/)
    await expect(svc.updateVrMod('edge-of-eternity-vr')).rejects.toThrow(/being removed/)
    await expect(svc.removeVrMod('edge-of-eternity-vr')).rejects.toThrow(/being removed/)
    await removing
    const phases = events
      .filter((e) => e.name === 'vr-mods:progress')
      .map((e) => (e.payload as VrModProgress).phase)
    expect(phases.slice(-2)).toEqual(['removing', 'done'])
    expect((await svc.getVrMods()).installed).toEqual({})
    // Free again: it downloads.
    await svc.downloadVrMod('edge-of-eternity-vr')
    await waitIdle('edge-of-eternity-vr')
    expect((await svc.getVrMods()).installed['edge-of-eternity-vr']?.tag).toBe('v1')
    svc.dispose()
  })

  it('refuses to download a mod that is not on GitHub', async () => {
    const { svc } = await service([])
    await expect(svc.downloadVrMod('nexus-mod')).rejects.toThrow(/not on GitHub/)
    await expect(svc.getVrModReleases('nexus-mod')).rejects.toThrow(/not on GitHub/)
    svc.dispose()
  })

  it('reports a release with nothing to keep (a Quest .apk) as failed, and lists it without a file', async () => {
    const { svc, events, waitIdle } = await service([release('v1', [{ ...asset('Mod-v1.apk') }])])
    expect((await svc.getVrModReleases('edge-of-eternity-vr'))[0]?.asset).toBeNull()
    await svc.downloadVrMod('edge-of-eternity-vr')
    await waitIdle('edge-of-eternity-vr')
    const last = events.filter((e) => e.name === 'vr-mods:progress').at(-1)
      ?.payload as VrModProgress
    expect(last.phase).toBe('failed')
    expect(last.message).toMatch(/no release PlayOut can download/)
    svc.dispose()
  })

  it('offers a pre-release when the mod has nothing else', async () => {
    const zip = await zipOf({ 'mod.dll': 'pre' })
    const { svc, waitIdle } = await service([
      release('v0.1-alpha', [serve('m.zip', zip, { tag: 'v0.1-alpha' })], { prerelease: true })
    ])
    await svc.downloadVrMod('edge-of-eternity-vr')
    await waitIdle('edge-of-eternity-vr')
    expect((await svc.getVrMods()).installed['edge-of-eternity-vr']?.tag).toBe('v0.1-alpha')
    svc.dispose()
  })
})
