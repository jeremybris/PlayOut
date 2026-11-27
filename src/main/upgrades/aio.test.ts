import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addToAioLibrary,
  ensureAioSwapper,
  latestAioSwapper,
  openAioSwapper,
  spawnDetached,
  type AioRelease
} from './aio'

const HASH = '732a6a3d29579cefc20956f9c967f69971282af8748820b326c8c0a561ca0703'
const BASE = 'https://github.com/machiavelli31/DLSS-AiO-Swapper/releases/download/v3.0.15/'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-aio-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('latestAioSwapper', () => {
  const release = {
    tag_name: 'v3.0.15',
    assets: [
      {
        name: 'DLSS-AiO-Swapper-Setup-3.0.15.exe',
        browser_download_url: `${BASE}DLSS-AiO-Swapper-Setup-3.0.15.exe`
      },
      {
        name: 'DLSS-AiO-Swapper-3.0.15-portable.exe',
        browser_download_url: `${BASE}DLSS-AiO-Swapper-3.0.15-portable.exe`,
        size: 82053080,
        digest: `sha256:${HASH.toUpperCase()}`
      }
    ]
  }

  it('picks the portable exe with its digest', async () => {
    expect(await latestAioSwapper({ fetchJson: async () => release })).toEqual({
      version: '3.0.15',
      url: `${BASE}DLSS-AiO-Swapper-3.0.15-portable.exe`,
      size: 82053080,
      sha256: HASH,
      fileName: 'DLSS-AiO-Swapper-3.0.15-portable.exe'
    })
  })

  it('returns null without a portable exe or outside the project', async () => {
    expect(await latestAioSwapper({ fetchJson: async () => ({ assets: [] }) })).toBeNull()
    const moved = structuredClone(release)
    moved.assets[1]!.browser_download_url = 'https://example.com/x.exe'
    expect(await latestAioSwapper({ fetchJson: async () => moved })).toBeNull()
  })
})

describe('ensureAioSwapper', () => {
  const release: AioRelease = {
    version: '3.0.15',
    url: `${BASE}DLSS-AiO-Swapper-3.0.15-portable.exe`,
    size: 10,
    sha256: HASH,
    fileName: 'DLSS-AiO-Swapper-3.0.15-portable.exe'
  }
  const download = vi.fn(async (d: { fileName: string; sha256?: string }, into: string) => {
    await fs.mkdir(into, { recursive: true })
    const file = join(into, d.fileName)
    await fs.writeFile(file, 'exe')
    return file
  })
  beforeEach(() => {
    download.mockClear()
  })

  it('downloads with the digest, removes older copies and reuses the file', async () => {
    const folder = join(dir, 'DLSS-AiO-Swapper')
    await fs.mkdir(folder)
    await fs.writeFile(join(folder, 'DLSS-AiO-Swapper-3.0.14-portable.exe'), 'old')
    await fs.writeFile(join(folder, 'notes.txt'), 'keep')
    const exe = await ensureAioSwapper(release, dir, { download })
    expect(exe).toBe(join(folder, release.fileName))
    expect(download.mock.calls[0]![0]).toMatchObject({ sha256: HASH, url: release.url })
    expect((await fs.readdir(folder)).sort()).toEqual([release.fileName, 'notes.txt'])
    await ensureAioSwapper(release, dir, { download })
    expect(download).toHaveBeenCalledTimes(1)
  })

  it('runs two calls at once one after the other, so they never share one download', async () => {
    let active = 0
    let most = 0
    const slow = vi.fn(async (d: { fileName: string }, into: string) => {
      active++
      most = Math.max(most, active)
      await new Promise((r) => setTimeout(r, 30))
      try {
        return await download(d, into)
      } finally {
        active--
      }
    })
    const [a, b] = await Promise.all([
      ensureAioSwapper(release, dir, { download: slow }),
      ensureAioSwapper(release, dir, { download: slow })
    ])
    expect(a).toBe(b)
    expect(most).toBe(1)
    expect(slow).toHaveBeenCalledTimes(1)
  })

  it('refuses without a checksum or from elsewhere', async () => {
    await expect(ensureAioSwapper({ ...release, sha256: null }, dir, { download })).rejects.toThrow(
      /checksum/
    )
    await expect(
      ensureAioSwapper({ ...release, url: 'https://example.com/a.exe' }, dir, { download })
    ).rejects.toThrow(/outside/)
    await expect(
      ensureAioSwapper({ ...release, fileName: '..\\evil.exe' }, dir, { download })
    ).rejects.toThrow(/file name/)
    expect(download).not.toHaveBeenCalled()
  })
})

describe('addToAioLibrary', () => {
  it('creates the library with the game and does not add it twice', async () => {
    const file = join(dir, 'dlss5-swapper', 'library.json')
    expect(await addToAioLibrary(file, 'D:\\Games\\Foo')).toBe(true)
    const lib = JSON.parse(await fs.readFile(file, 'utf8'))
    expect(lib.folders).toEqual([])
    expect(lib.manual).toHaveLength(1)
    expect(await addToAioLibrary(file, 'd:\\games\\foo\\')).toBe(false)
  })

  it('keeps the other fields and leaves broken files and Steam games alone', async () => {
    const file = join(dir, 'library.json')
    await fs.writeFile(file, '{"manual":[],"closeToTray":true}')
    await addToAioLibrary(file, 'D:\\Games\\Bar')
    expect(JSON.parse(await fs.readFile(file, 'utf8')).closeToTray).toBe(true)
    await fs.writeFile(file, '{oops')
    expect(await addToAioLibrary(file, 'D:\\Games\\Bar')).toBe(false)
    expect(await fs.readFile(file, 'utf8')).toBe('{oops')
    expect(await addToAioLibrary(join(dir, 'x.json'), 'D:\\Steam\\steamapps\\common\\Foo')).toBe(
      false
    )
  })
})

describe('openAioSwapper', () => {
  it('starts the exe with no arguments in its folder', async () => {
    const exe = join(dir, 'app.exe')
    await fs.writeFile(exe, 'exe')
    const spawnDetached = vi.fn()
    const libraryFile = join(dir, 'library.json')
    await openAioSwapper(exe, 'D:\\Games\\Foo', {
      spawnDetached,
      isAppRunning: async () => false,
      libraryFile
    })
    expect(spawnDetached).toHaveBeenCalledWith(exe, [], { cwd: dir })
    expect(JSON.parse(await fs.readFile(libraryFile, 'utf8')).manual).toHaveLength(1)
  })

  it('leaves the library alone while the app runs or when nobody can tell', async () => {
    const exe = join(dir, 'app.exe')
    await fs.writeFile(exe, 'exe')
    const libraryFile = join(dir, 'library.json')
    await openAioSwapper(exe, 'D:\\Games\\Foo', {
      spawnDetached: vi.fn(),
      isAppRunning: async () => true,
      libraryFile
    })
    await openAioSwapper(exe, 'D:\\Games\\Foo', { spawnDetached: vi.fn(), libraryFile })
    await expect(fs.access(libraryFile)).rejects.toThrow()
  })

  it('throws when the app fails to start', async () => {
    const exe = join(dir, 'app.exe')
    await fs.writeFile(exe, 'exe')
    const spawnDetached = vi.fn(async () => {
      throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES' })
    })
    await expect(openAioSwapper(exe, null, { spawnDetached })).rejects.toThrow(
      /could not start.*EACCES/
    )
  })

  it('throws when the exe is missing', async () => {
    const spawnDetached = vi.fn()
    await expect(openAioSwapper(join(dir, 'nope.exe'), null, { spawnDetached })).rejects.toThrow(
      /not downloaded/
    )
    expect(spawnDetached).not.toHaveBeenCalled()
  })
})

describe('spawnDetached', () => {
  it('resolves once the program has started and rejects when it cannot start', async () => {
    await expect(
      spawnDetached(process.execPath, ['-e', ''], { cwd: tmpdir() })
    ).resolves.toBeUndefined()
    await expect(spawnDetached(join(dir, 'missing.exe'), [], { cwd: dir })).rejects.toThrow()
  })
})
