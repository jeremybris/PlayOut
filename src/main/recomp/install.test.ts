import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { InstalledRecomp, RecompEntry, RecompProgress } from '../../shared/recomp'
import { extractZip, listZip } from '../util/zip'
import {
  backupPlayerFiles,
  dirSize,
  findExe,
  installRecomp,
  notGameReason,
  safeRecompFolder,
  safeRecompId,
  uninstallRecomp,
  unverifiedWarning,
  writeZip,
  type InstallDeps
} from './install'
import type { GhRelease } from './releases'

const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

let tmp: string
let root: string
let cacheDir: string
let served: Map<string, Buffer>
let progress: RecompProgress[]

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'recomp-install-'))
  root = join(tmp, 'Recompilations')
  cacheDir = join(tmp, 'cache')
  served = new Map()
  progress = []
})
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

function entry(over: Partial<RecompEntry> = {}): RecompEntry {
  return {
    id: 'github:zelda64recomp/zelda64recomp',
    name: 'Zelda 64: Recompiled',
    game: "The Legend of Zelda: Majora's Mask",
    systemId: 'n64',
    console: 'Nintendo 64',
    host: 'github',
    repo: 'Zelda64Recomp/Zelda64Recomp',
    repoUrl: 'https://github.com/Zelda64Recomp/Zelda64Recomp',
    author: 'Zelda64Recomp',
    blurb: '',
    description: '',
    features: [],
    tags: [],
    latestTag: null,
    released: null,
    downloadBytes: null,
    stars: null,
    downloads: null,
    license: null,
    completeness: null,
    recommended: false,
    assetPattern: null,
    exe: null,
    installer: false,
    scannedSha256: null,
    needs: [],
    setupNotes: [],
    savePaths: [],
    iconUrl: null,
    coverUrl: null,
    heroUrl: null,
    archived: false,
    sources: ['decomp-buddy'],
    ...over
  }
}

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

/** A zip of `files` (path -> text) made with PlayOut's writer, served at a GitHub download URL. */
async function zipAsset(
  name: string,
  files: Record<string, string>,
  opts: { digest?: 'good' | 'bad' | 'none'; tag?: string } = {}
): Promise<GhRelease['assets'][number]> {
  const src = join(tmp, `src-${name}-${Math.random().toString(36).slice(2)}`)
  const entries: { name: string; path: string }[] = []
  for (const [rel, text] of Object.entries(files)) {
    const path = join(src, ...rel.split('/'))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text)
    entries.push({ name: rel, path })
  }
  const zipPath = join(tmp, `${name}-${Math.random().toString(36).slice(2)}.zip`)
  await writeZip(zipPath, entries)
  return rawAsset(name, await readFile(zipPath), opts)
}

function rawAsset(
  name: string,
  data: Buffer,
  opts: { digest?: 'good' | 'bad' | 'none'; tag?: string } = {}
): GhRelease['assets'][number] {
  const url = `https://github.com/Zelda64Recomp/Zelda64Recomp/releases/download/${opts.tag ?? 'v1'}/${name}`
  served.set(url, data)
  const digest =
    opts.digest === 'none'
      ? null
      : opts.digest === 'bad'
        ? `sha256:${'0'.repeat(64)}`
        : `sha256:${sha(data)}`
  return { name, size: data.length, browser_download_url: url, digest }
}

function release(tag: string, assets: GhRelease['assets']): GhRelease {
  return {
    tag_name: tag,
    name: tag,
    published_at: null,
    prerelease: false,
    draft: false,
    body: null,
    html_url: '',
    assets
  }
}

function deps(over: Partial<InstallDeps> = {}): InstallDeps {
  return {
    root,
    cacheDir,
    http: {
      log,
      retryDelayMs: 0,
      fetch: (async (url: string) => {
        const data = served.get(url)
        if (!data) return new Response('missing', { status: 404 })
        return new Response(new Uint8Array(data), {
          status: 200,
          headers: { 'content-length': String(data.length) }
        })
      }) as unknown as typeof fetch
    },
    sevenZip: () => Promise.reject(new Error('7-Zip is not available in tests')),
    run: () => Promise.reject(new Error('nothing is run in tests')),
    log,
    onProgress: (p) => progress.push(p),
    freeSpace: async () => 1e12,
    ...over
  }
}

const V1_FILES = {
  'Zelda64Recompiled/Zelda64Recompiled.exe': 'program v1',
  'Zelda64Recompiled/crashpad_handler.exe': 'crash handler',
  'Zelda64Recompiled/assets/keep.dat': 'same in both',
  'Zelda64Recompiled/assets/old.dat': 'dropped in v2',
  'Zelda64Recompiled/assets/oldchanged.dat': 'dropped in v2 but the player changed it',
  'Zelda64Recompiled/olddir/x.txt': 'a folder v2 no longer has'
}

describe('installRecomp', () => {
  it('installs a zip: single top folder removed, checked against GitHub digest, program found', async () => {
    const asset = await zipAsset('Zelda64Recompiled-v1.2.2-Windows.zip', V1_FILES)
    const rec = await installRecomp(entry(), release('v1.2.2', [asset]), null, deps())
    const dir = join(root, 'Zelda 64 Recompiled (zelda64recomp-zelda64recomp)')
    expect(rec.dir).toBe(dir)
    expect(await readFile(join(dir, 'Zelda64Recompiled.exe'), 'utf8')).toBe('program v1')
    expect(rec).toMatchObject({
      id: 'github:zelda64recomp/zelda64recomp',
      tag: 'v1.2.2',
      asset: 'Zelda64Recompiled-v1.2.2-Windows.zip',
      verified: 'github',
      sha256: sha(served.get(asset.browser_download_url)!),
      exe: 'Zelda64Recompiled.exe',
      downloadBytes: asset.size,
      prevTag: null,
      autoUpdate: false,
      savePaths: [],
      saveSource: null
    })
    expect(rec.releaseFiles).toEqual([
      'assets/keep.dat',
      'assets/old.dat',
      'assets/oldchanged.dat',
      'crashpad_handler.exe',
      'olddir/x.txt',
      'zelda64recompiled.exe'
    ])
    expect(rec.diskBytes).toBe(await dirSize(dir))
    expect(rec.diskBytes).toBeGreaterThan(0)
    expect(existsSync(`${dir}.staging`)).toBe(false)
    expect(existsSync(join(cacheDir, 'downloads', 'zelda64recomp-zelda64recomp'))).toBe(false)
    const phases = progress.map((p) => p.phase)
    expect(phases[0]).toBe('checking')
    expect(phases).toContain('downloading')
    expect(phases).toContain('extracting')
    expect(phases.at(-1)).toBe('done')
    expect(progress.every((p) => p.warning === null)).toBe(true)
  })

  it('installs a download without a checksum with a warning', async () => {
    const asset = await zipAsset('Game-windows.zip', { 'Game.exe': 'x' }, { digest: 'none' })
    const rec = await installRecomp(entry(), release('v1', [asset]), null, deps())
    expect(rec.verified).toBe('unverified')
    expect(rec.sha256).toBe(sha(served.get(asset.browser_download_url)!))
    expect(progress.at(-1)).toMatchObject({ phase: 'done', warning: unverifiedWarning() })
  })

  it('fails on a checksum mismatch and installs nothing', async () => {
    const asset = await zipAsset('Game-windows.zip', { 'Game.exe': 'x' }, { digest: 'bad' })
    await expect(installRecomp(entry(), release('v1', [asset]), null, deps())).rejects.toThrow(
      /checksum/
    )
    expect(existsSync(join(root, safeRecompFolder(entry())))).toBe(false)
    expect(progress.at(-1)?.phase).toBe('failed')
  })

  it("prefers decomp-buddy's scanned checksum for exactly its release and file", async () => {
    const asset = await zipAsset('Game-v1-windows.zip', { 'Game.exe': 'x' }, { digest: 'none' })
    const good = sha(served.get(asset.browser_download_url)!)
    const scannedEntry = entry({
      latestTag: 'v1',
      assetPattern: 'Game-v1-windows.zip',
      scannedSha256: good.toUpperCase()
    })
    const rec = await installRecomp(scannedEntry, release('v1', [asset]), null, deps())
    expect(rec.verified).toBe('scanned')

    const wrong = entry({
      latestTag: 'v1',
      assetPattern: 'Game-v1-windows.zip',
      scannedSha256: 'f'.repeat(64)
    })
    await expect(
      installRecomp(wrong, release('v1', [asset]), null, deps({ root: join(tmp, 'other') }))
    ).rejects.toThrow(/checksum/)
    // Another release: the scanned checksum does not apply.
    const other = await installRecomp(
      wrong,
      release('v2', [asset]),
      null,
      deps({ root: join(tmp, 'third') })
    )
    expect(other.verified).toBe('unverified')
  })

  it('uses the scanned checksum for the file the catalog names, also behind a wildcard pattern', async () => {
    const asset = await zipAsset('Game-v1-Windows.zip', { 'Game.exe': 'x' }, { digest: 'none' })
    const good = sha(served.get(asset.browser_download_url)!)
    const wild = entry({
      latestTag: 'v1',
      assetPattern: 'Game-*-Windows.zip',
      scannedSha256: good,
      scannedAsset: 'game-v1-windows.zip'
    })
    const rec = await installRecomp(wild, release('v1', [asset]), null, deps())
    expect(rec.verified).toBe('scanned')

    const wrong = entry({
      latestTag: 'v1',
      assetPattern: 'Game-*-Windows.zip',
      scannedSha256: 'f'.repeat(64),
      scannedAsset: 'Game-v1-Windows.zip'
    })
    await expect(
      installRecomp(wrong, release('v1', [asset]), null, deps({ root: join(tmp, 'other') }))
    ).rejects.toThrow(/checksum/)
    // An older catalog without the file name: a wildcard pattern names no file, the checksum is not applied.
    const old = entry({
      latestTag: 'v1',
      assetPattern: 'Game-*-Windows.zip',
      scannedSha256: 'f'.repeat(64)
    })
    const unverified = await installRecomp(
      old,
      release('v1', [asset]),
      null,
      deps({ root: join(tmp, 'third') })
    )
    expect(unverified.verified).toBe('unverified')
  })

  it('stops an update, changing nothing, when the player files cannot be backed up', async () => {
    const v1 = await installRecomp(
      entry(),
      release('v1', [await zipAsset('Zelda64Recompiled-v1-Windows.zip', V1_FILES)]),
      null,
      deps()
    )
    const dir = v1.dir
    await writeFile(join(dir, 'config.ini'), 'fullscreen=1')
    // A file where the backups folder should be: the backup cannot be written.
    await mkdir(join(root, '.playout'), { recursive: true })
    await writeFile(join(root, '.playout', 'backups'), 'in the way')
    const v2Asset = await zipAsset(
      'Zelda64Recompiled-v2-Windows.zip',
      {
        'Zelda64Recompiled/Zelda64Recompiled.exe': 'program v2',
        'Zelda64Recompiled/config.ini': 'fullscreen=0'
      },
      { tag: 'v2' }
    )
    await expect(installRecomp(entry(), release('v2', [v2Asset]), v1, deps())).rejects.toThrow(
      /could not be backed up/
    )
    expect(await readFile(join(dir, 'config.ini'), 'utf8')).toBe('fullscreen=1')
    expect(await readFile(join(dir, 'Zelda64Recompiled.exe'), 'utf8')).toBe('program v1')
    expect(existsSync(`${dir}.staging`)).toBe(false)
  })

  it('keeps a player file the backup leaves out when the new release ships one of that name', async () => {
    const v1 = await installRecomp(
      entry(),
      release('v1', [await zipAsset('Zelda64Recompiled-v1-Windows.zip', V1_FILES)]),
      null,
      deps()
    )
    const dir = v1.dir
    await writeFile(join(dir, 'mm.z64'), 'my rom') // game data: never in the backup zip
    await writeFile(join(dir, 'config.ini'), 'mine') // in the backup zip: replaced
    const v2Asset = await zipAsset(
      'Zelda64Recompiled-v2-Windows.zip',
      {
        'Zelda64Recompiled/Zelda64Recompiled.exe': 'program v2',
        'Zelda64Recompiled/mm.z64': 'shipped',
        'Zelda64Recompiled/config.ini': 'default'
      },
      { tag: 'v2' }
    )
    await installRecomp(entry(), release('v2', [v2Asset]), v1, deps())
    expect(await readFile(join(dir, 'mm.z64'), 'utf8')).toBe('shipped')
    expect(await readFile(join(dir, 'mm.z64.playout-old'), 'utf8')).toBe('my rom')
    expect(await readFile(join(dir, 'config.ini'), 'utf8')).toBe('default')
    expect(existsSync(join(dir, 'config.ini.playout-old'))).toBe(false)
  })

  it('updates over the old release, keeping the player files and backing them up', async () => {
    const v1 = await installRecomp(
      entry(),
      release('v1', [await zipAsset('Zelda64Recompiled-v1-Windows.zip', V1_FILES)]),
      null,
      deps()
    )
    const previous: InstalledRecomp = {
      ...v1,
      autoUpdate: true,
      savePaths: ['{install}/saves'],
      saveSource: 'detected',
      gameFiles: { game: { path: 'C:\\roms\\mm.z64', source: 'picked' } }
    }
    const dir = v1.dir
    // The player's own files.
    await mkdir(join(dir, 'saves'), { recursive: true })
    await writeFile(join(dir, 'saves', 'slot1.sav'), 'my save')
    await writeFile(join(dir, 'config.ini'), 'fullscreen=1')
    await writeFile(join(dir, 'mm.z64'), 'a rom (game data: not backed up)')
    await mkdir(join(dir, 'cache'))
    await writeFile(join(dir, 'cache', 'shader.bin'), 'cache')
    const later = new Date(Date.now() + 60_000)
    await writeFile(join(dir, 'assets', 'oldchanged.dat'), 'changed by the player')
    await utimes(join(dir, 'assets', 'oldchanged.dat'), later, later)

    const v2Asset = await zipAsset(
      'Zelda64Recompiled-v2-Windows.zip',
      {
        'Zelda64Recompiled/Zelda64Recompiled.exe': 'program v2',
        'Zelda64Recompiled/assets/keep.dat': 'same in both',
        'Zelda64Recompiled/assets/new.dat': 'new in v2'
      },
      { tag: 'v2' }
    )
    const rec = await installRecomp(entry(), release('v2', [v2Asset]), previous, deps())

    expect(rec.dir).toBe(dir)
    expect(await readFile(join(dir, 'Zelda64Recompiled.exe'), 'utf8')).toBe('program v2')
    expect(await readFile(join(dir, 'assets', 'new.dat'), 'utf8')).toBe('new in v2')
    expect(await readFile(join(dir, 'saves', 'slot1.sav'), 'utf8')).toBe('my save')
    expect(await readFile(join(dir, 'config.ini'), 'utf8')).toBe('fullscreen=1')
    expect(await readFile(join(dir, 'assets', 'oldchanged.dat'), 'utf8')).toBe(
      'changed by the player'
    )
    expect(existsSync(join(dir, 'assets', 'old.dat'))).toBe(false)
    expect(existsSync(join(dir, 'crashpad_handler.exe'))).toBe(false)
    expect(existsSync(join(dir, 'olddir'))).toBe(false)
    expect(existsSync(`${dir}.staging`)).toBe(false)

    expect(rec).toMatchObject({
      tag: 'v2',
      prevTag: 'v1',
      installedAt: v1.installedAt,
      autoUpdate: true,
      savePaths: ['{install}/saves'],
      saveSource: 'detected',
      gameFiles: { game: { path: 'C:\\roms\\mm.z64', source: 'picked' } },
      exe: 'Zelda64Recompiled.exe',
      releaseFiles: ['assets/keep.dat', 'assets/new.dat', 'zelda64recompiled.exe']
    })

    const backups = join(root, '.playout', 'backups', 'zelda64recomp-zelda64recomp')
    const zips = await readdir(backups)
    expect(zips).toHaveLength(1)
    const names = (await listZip(join(backups, zips[0]!))).map((e) => e.name).sort()
    expect(names).toEqual(['assets/oldchanged.dat', 'config.ini', 'saves/slot1.sav'])
  })

  it('saves an installer for the player to run, never running it', async () => {
    const data = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100, 1)])
    const asset = rawAsset('Game-1.0-Setup.exe', data)
    const rec = await installRecomp(entry(), release('v1', [asset]), null, deps())
    expect(rec.exe).toBe('Game-1.0-Setup.exe')
    expect(rec.releaseFiles).toEqual(['game-1.0-setup.exe'])
    expect(await readFile(join(rec.dir, 'Game-1.0-Setup.exe')).then((b) => b.length)).toBe(
      data.length
    )
  })

  it('places a portable program as it is', async () => {
    const data = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 7)])
    const asset = rawAsset('SomeGame-windows.exe', data)
    const rec = await installRecomp(entry(), release('v1', [asset]), null, deps())
    expect(rec.exe).toBe('SomeGame-windows.exe')
    expect(rec.releaseFiles).toEqual(['somegame-windows.exe'])
  })

  it('refuses without three times the download free', async () => {
    const asset = await zipAsset('Game-windows.zip', { 'Game.exe': 'x' })
    await expect(
      installRecomp(
        entry(),
        release('v1', [asset]),
        null,
        deps({ freeSpace: async () => asset.size * 2 })
      )
    ).rejects.toThrow(/Not enough free space/)
  })

  it('refuses a release without a Windows build, and a file from another site', async () => {
    const linux = await zipAsset('Game-linux.zip', { game: 'x' })
    await expect(installRecomp(entry(), release('v1', [linux]), null, deps())).rejects.toThrow(
      /no download for Windows/
    )
    const elsewhere = {
      ...(await zipAsset('Game-windows.zip', { 'Game.exe': 'x' })),
      browser_download_url: 'https://evil.example/Game-windows.zip'
    }
    await expect(installRecomp(entry(), release('v1', [elsewhere]), null, deps())).rejects.toThrow(
      /own site/
    )
  })
})

describe('uninstallRecomp', () => {
  it('backs up the player files and removes the folder', async () => {
    const rec = await installRecomp(
      entry(),
      release('v1', [await zipAsset('Game-windows.zip', { 'Game.exe': 'x' })]),
      null,
      deps()
    )
    await writeFile(join(rec.dir, 'save.dat'), 'progress')
    await uninstallRecomp(rec, { root, cacheDir, log })
    expect(existsSync(rec.dir)).toBe(false)
    const backups = await readdir(join(root, '.playout', 'backups', safeRecompId(rec.id)))
    expect(backups).toHaveLength(1)
  })

  it('never deletes a folder outside the Recompilations folder', async () => {
    const outside = join(tmp, 'elsewhere')
    await mkdir(outside)
    const rec = { id: 'github:a/b', dir: outside, releaseFiles: [] } as unknown as InstalledRecomp
    await expect(uninstallRecomp(rec, { root, cacheDir, log })).rejects.toThrow(/not inside/)
    await expect(uninstallRecomp({ ...rec, dir: root }, { root, cacheDir, log })).rejects.toThrow(
      /not inside/
    )
    expect(existsSync(outside)).toBe(true)
  })
})

describe('findExe', () => {
  const e = entry()
  async function layout(files: string[]): Promise<string> {
    const dir = join(tmp, `exe-${Math.random().toString(36).slice(2)}`)
    for (const f of files) {
      await mkdir(dirname(join(dir, f)), { recursive: true })
      await writeFile(join(dir, f), 'x')
    }
    return dir
  }

  it('uses the hint as a relative path or a bare name searched below', async () => {
    const dir = await layout(['bin/x64/Game.exe', 'Other.exe'])
    expect(await findExe(dir, 'bin/x64/Game.exe', e)).toBe(join('bin', 'x64', 'Game.exe'))
    expect(await findExe(dir, 'game.EXE', e)).toBe(join('bin', 'x64', 'Game.exe'))
  })

  it('skips uninstallers, crash handlers, runtimes and setup programs', async () => {
    const dir = await layout([
      'unins000.exe',
      'crashpad_handler.exe',
      'vc_redist.x64.exe',
      'MyPort.exe'
    ])
    expect(await findExe(dir, null, e)).toBe('MyPort.exe')
  })

  it('picks the game over an extractor or tool in a subfolder', async () => {
    expect(await findExe(await layout(['soh.exe', 'assets/extractor/ZAPD.exe']), null, e)).toBe(
      'soh.exe'
    )
    expect(await findExe(await layout(['tools/wadgen.exe', 'DOOM64EX-Plus.exe']), null, e)).toBe(
      'DOOM64EX-Plus.exe'
    )
  })

  it('of several programs, prefers the one named like the project', async () => {
    const dir = await layout(['RT64Tool.exe', 'Zelda64Recompiled.exe', 'tools/patcher.exe'])
    expect(await findExe(dir, null, e)).toBe('Zelda64Recompiled.exe')
    expect(await findExe(dir, 'missing.exe', e)).toBe('Zelda64Recompiled.exe')
    expect(await findExe(await layout(['readme.txt']), null, e)).toBeNull()
  })
})

describe('notGameReason', () => {
  it('names runtime installers, extractors and tools, also by their folder', () => {
    for (const f of [
      'oalinst.exe',
      'windowsdesktop-runtime-8.0.0-win-x64.exe',
      'dotnet-runtime-6.0.0-win-x64.exe',
      'NDP472-KB4054530-x86-x64-AllOS-ENU.exe',
      'PhysX_9.21.0713_SystemSoftware.exe'
    ])
      expect(notGameReason(f)).toBe('Runtime installer')
    for (const f of ['assets/extractor/ZAPD.exe', 'ZAPD.exe', 'tools\\wadgen.exe', 'RT64Tool.exe'])
      expect(notGameReason(f)).toBe('Helper program')
    expect(notGameReason('tools/Anything.exe')).toBe('Helper program')
    expect(notGameReason('redist/Something.exe')).toBe('Helper program')
    for (const f of ['soh.exe', '2ship.exe', 'DOOM64EX-Plus.exe', 'bin/x64/Game.exe'])
      expect(notGameReason(f)).toBeNull()
  })
})

describe('names, sizes and backups', () => {
  it('makes safe, unique folder names', () => {
    expect(safeRecompFolder(entry())).toBe('Zelda 64 Recompiled (zelda64recomp-zelda64recomp)')
    expect(
      safeRecompFolder(entry({ id: 'gitlab:Group/Sub/Proj#mario-kart-64', name: 'A/B: C?. ' }))
    ).toBe('A B C (gitlab-group-sub-proj-mario-kart-64)')
    expect(safeRecompId('github:' + 'x'.repeat(200))).toHaveLength(79)
  })

  it('sums folder sizes', async () => {
    const dir = join(tmp, 'size')
    await mkdir(join(dir, 'a', 'b'), { recursive: true })
    await writeFile(join(dir, 'one'), '12345')
    await writeFile(join(dir, 'a', 'b', 'two'), '123')
    expect(await dirSize(dir)).toBe(8)
    expect(await dirSize(join(tmp, 'missing'))).toBe(0)
  })

  it('writes zips PlayOut and other readers can open, and keeps the newest five backups', async () => {
    const dir = join(tmp, 'player')
    await mkdir(join(dir, 'saves'), { recursive: true })
    await writeFile(join(dir, 'saves', 'a.sav'), 'A'.repeat(5000))
    await writeFile(join(dir, 'game.exe'), 'release file')
    const backups = join(tmp, 'backups')
    for (let i = 0; i < 7; i++)
      await backupPlayerFiles(dir, ['game.exe'], backups, new Date(Date.UTC(2026, 0, 1, 0, 0, i)))
    const zips = (await readdir(backups)).sort()
    expect(zips).toHaveLength(5)
    expect(zips[0]).toBe('2026-01-01T00-00-02.000Z.zip')
    const out = join(tmp, 'out')
    await extractZip(join(backups, zips[4]!), out)
    expect(await readFile(join(out, 'saves', 'a.sav'), 'utf8')).toBe('A'.repeat(5000))
    expect(existsSync(join(out, 'game.exe'))).toBe(false)
    expect(await backupPlayerFiles(join(tmp, 'missing'), [], backups, new Date())).toBeNull()
  })
})
