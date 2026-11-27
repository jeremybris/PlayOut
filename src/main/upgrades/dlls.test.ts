import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { FoundUpscalerDll } from '../../shared/upgrades'
import {
  BACKUP_SUFFIX,
  DLL_FILE_NAMES,
  DLL_MANIFEST,
  compareVersions,
  ensureVendorDll,
  fsrDisplayVersion,
  gitBlobSha1,
  isNewerDll,
  latestVendorDlls,
  nodeDllIo,
  readPeFileVersion,
  restoreDlls,
  scanUpscalerDlls,
  swapDlls,
  type DllIo,
  type VendorDll
} from './dlls'

/** A tiny fake Windows program file carrying a version resource with the given file version. */
function makePe(version: string, options: { bare?: boolean; filler?: number } = {}): Buffer {
  const [a, b, c, d] = version.split('.').map(Number)
  const head = Buffer.alloc(64 + (options.filler ?? 0), 0x11)
  head.write('MZ', 0, 'latin1')
  const key = options.bare
    ? Buffer.alloc(0)
    : Buffer.concat([Buffer.from('VS_VERSION_INFO', 'utf16le'), Buffer.alloc(2)])
  const fixed = Buffer.alloc(52)
  fixed.writeUInt32LE(0xfeef04bd, 0)
  fixed.writeUInt32LE(0x00010000, 4)
  fixed.writeUInt32LE(((a << 16) | b) >>> 0, 8)
  fixed.writeUInt32LE(((c << 16) | d) >>> 0, 12)
  return Buffer.concat([head, key, fixed, Buffer.alloc(16)])
}

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'playout-dlls-'))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function put(path: string, bytes: Buffer | string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, bytes)
}

describe('readPeFileVersion', () => {
  it('reads the numeric file version after the VS_VERSION_INFO key', () => {
    expect(readPeFileVersion(makePe('310.9.16.0'))).toBe('310.9.16.0')
  })
  it('falls back to the bare fixed-info signature', () => {
    expect(readPeFileVersion(makePe('1.0.1.41314', { bare: true }))).toBe('1.0.1.41314')
  })
  it('rejects non-program files and files without a version', () => {
    expect(readPeFileVersion(Buffer.from('not a dll at all, just some text in a file....'))).toBe(
      null
    )
    const noVersion = Buffer.alloc(200)
    noVersion.write('MZ')
    expect(readPeFileVersion(noVersion)).toBe(null)
  })
})

describe('compareVersions / isNewerDll', () => {
  it('compares numeric dotted parts, missing parts as 0', () => {
    expect(compareVersions('310.9.16', '310.9.16.0')).toBe(0)
    expect(compareVersions('3.5.10.0', '310.9.16.0')).toBe(-1)
    expect(compareVersions('2.0.10', '2.0.9')).toBe(1)
    expect(compareVersions('v3.0.2', '3.0.1')).toBe(1)
  })
  it('compares FSR 3.1 files by their FSR version', () => {
    expect(fsrDisplayVersion('1.0.2.38022')).toBe('3.1.2')
    // 1.0.2.38022 is FSR 3.1.2: older than 1.0.1.41314 (FSR 3.1.4) despite the bigger file version.
    expect(isNewerDll('fsr-dx12', '1.0.2.38022', '1.0.1.41314')).toBe(true)
    // Same FSR version: not an update.
    expect(isNewerDll('fsr-vk', '1.0.1.42386', '1.0.1.41314')).toBe(false)
    // Unknown build: compared by build number.
    expect(isNewerDll('fsr-dx12', '1.0.1.45000', '1.0.1.41314')).toBe(false)
    // An unknown file with a higher version but a lower build is newer, not older: never replaced.
    expect(isNewerDll('fsr-dx12', '2.0.0.5000', '1.0.1.41314')).toBe(false)
    expect(isNewerDll('fsr-vk', '1.0.3.100', '1.0.1.41314')).toBe(false)
    expect(isNewerDll('fsr-dx12', '1.1.0.40000', '1.0.1.41314')).toBe(false)
    // An unknown older file (lower version and lower build) still gets the update.
    expect(isNewerDll('fsr-dx12', '1.0.0.30000', '1.0.1.41314')).toBe(true)
    expect(isNewerDll('dlss', '3.5.10.0', '310.9.16.0')).toBe(true)
    expect(isNewerDll('dlss', '310.9.16.0', '310.9.16.0')).toBe(false)
  })
})

describe('scanUpscalerDlls', () => {
  it('finds the files by name in any case, with versions; an unlisted backup is not ours', async () => {
    await put(join(root, 'Engine', 'NVNGX_DLSS.dll'), makePe('3.5.10.0'))
    await put(join(root, 'Engine', 'NVNGX_DLSS.dll' + BACKUP_SUFFIX), makePe('3.5.0.0'))
    await put(join(root, 'bin', 'libxess.dll'), 'garbage')
    await put(join(root, 'bin', 'other.dll'), makePe('1.0.0.0'))
    const found = await scanUpscalerDlls(root)
    expect(found).toEqual([
      {
        kind: 'xess',
        relPath: join('bin', 'libxess.dll'),
        path: join(root, 'bin', 'libxess.dll'),
        version: null,
        swapped: false
      },
      {
        kind: 'dlss',
        relPath: join('Engine', 'NVNGX_DLSS.dll'),
        path: join(root, 'Engine', 'NVNGX_DLSS.dll'),
        version: '3.5.10.0',
        // The backup is not in PlayOut's list (another upgrade's, such as OptiScaler's).
        swapped: false
      }
    ])
  })

  it('stops 8 folders deep and skips WindowsApps folders', async () => {
    const deep8 = join(root, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h')
    await put(join(deep8, 'nvngx_dlssg.dll'), makePe('3.7.0.0'))
    await put(join(deep8, 'i', 'nvngx_dlssd.dll'), makePe('3.7.0.0'))
    await put(join(root, 'WindowsApps', 'libxell.dll'), makePe('1.0.0.0'))
    const found = await scanUpscalerDlls(root)
    expect(found.map((f) => f.kind)).toEqual(['dlssg'])
  })

  it('never follows junctions', async () => {
    const outside = await fs.mkdtemp(join(tmpdir(), 'playout-dlls-outside-'))
    try {
      await put(join(outside, 'nvngx_dlss.dll'), makePe('3.5.0.0'))
      await fs.symlink(outside, join(root, 'link'), 'junction')
      expect(await scanUpscalerDlls(root)).toEqual([])
    } finally {
      await fs.rm(join(root, 'link'), { force: true, recursive: false }).catch(() => undefined)
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('answers nothing for a missing folder', async () => {
    expect(await scanUpscalerDlls(join(root, 'missing'))).toEqual([])
  })
})

describe('latestVendorDlls', () => {
  const nvidiaFiles = [
    {
      name: 'nvngx_dlss.dll',
      type: 'file',
      size: 58956912,
      sha: '23C4672E4A31EF303E8F98FF4F0D146BD1718CCF',
      download_url:
        'https://raw.githubusercontent.com/NVIDIA/DLSS/v310.9.16/lib/Windows_x86_64/rel/nvngx_dlss.dll'
    },
    {
      name: 'nvngx_dlssg.dll',
      type: 'file',
      size: 7506544,
      sha: '71b8070cdced79e8df3414060337c84d91e38422',
      download_url: 'https://evil.example.com/nvngx_dlssg.dll'
    }
  ]
  const intelFiles = [
    { name: 'libxess.dll', type: 'file', size: 77795704, sha: 'a'.repeat(40) },
    { name: 'libxell.dll', type: 'file', size: 415368, sha: 'b'.repeat(40) },
    // A size PlayOut does not know yet: left out.
    { name: 'libxess_fg.dll', type: 'file', size: 123, sha: 'c'.repeat(40) }
  ]
  const amdFiles = [
    { name: 'amd_fidelityfx_dx12.dll', type: 'file', size: 6675664, sha: 'd'.repeat(40) },
    { name: 'amd_fidelityfx_vk.dll', type: 'file', size: 9332432, sha: 'e'.repeat(40) }
  ]
  const answers: Record<string, unknown> = {
    'https://api.github.com/repos/NVIDIA/DLSS/releases/latest': { tag_name: 'v310.9.16' },
    'https://api.github.com/repos/NVIDIA/DLSS/contents/lib/Windows_x86_64/rel?ref=v310.9.16':
      nvidiaFiles,
    'https://api.github.com/repos/intel/xess/releases/latest': { tag_name: 'v3.0.2' },
    'https://api.github.com/repos/intel/xess/contents/bin?ref=v3.0.2': intelFiles,
    'https://api.github.com/repos/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK/contents/PrebuiltSignedDLL?ref=v1.1.4':
      amdFiles
  }

  it('lists the newest file of each kind from the vendors', async () => {
    const fetchJson = vi.fn(async (url: string) => {
      if (!(url in answers)) throw new Error(`unexpected ${url}`)
      return answers[url]
    }) as unknown as <T>(url: string) => Promise<T>
    const latest = await latestVendorDlls({ fetchJson })
    expect(Object.keys(latest).sort()).toEqual([
      'dlss',
      'dlssg',
      'fsr-dx12',
      'fsr-vk',
      'xell',
      'xess'
    ])
    expect(latest.dlss).toEqual({
      kind: 'dlss',
      version: '310.9.16.0',
      fileName: 'nvngx_dlss.dll',
      url: 'https://raw.githubusercontent.com/NVIDIA/DLSS/v310.9.16/lib/Windows_x86_64/rel/nvngx_dlss.dll',
      size: 58956912,
      gitBlobSha: '23c4672e4a31ef303e8f98ff4f0d146bd1718ccf',
      sha256: null,
      signer: 'NVIDIA Corporation'
    })
    // A download address outside the vendor's repository is never used.
    expect(latest.dlssg?.url).toBe(
      'https://raw.githubusercontent.com/NVIDIA/DLSS/v310.9.16/lib/Windows_x86_64/rel/nvngx_dlssg.dll'
    )
    expect(latest.xess?.version).toBe('2.0.2.68')
    expect(latest.xell?.signer).toBe('Microsoft Windows Hardware Compatibility Publisher')
    expect(latest['fsr-dx12']).toMatchObject({
      version: '1.0.1.41314',
      signer: 'Advanced Micro Devices, Inc.',
      url: 'https://raw.githubusercontent.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK/v1.1.4/PrebuiltSignedDLL/amd_fidelityfx_dx12.dll'
    })
  })

  it('still answers the other vendors when one cannot be reached', async () => {
    const fetchJson = (async (url: string) => {
      if (url.includes('NVIDIA')) throw new Error('rate limited')
      return answers[url]
    }) as <T>(url: string) => Promise<T>
    const failed: string[] = []
    const latest = await latestVendorDlls({
      fetchJson,
      onVendorFailed: (vendor) => failed.push(vendor)
    })
    expect(latest.dlss).toBeUndefined()
    expect(latest.xess).toBeDefined()
    expect(latest['fsr-vk']).toBeDefined()
    // The caller learns the answer is partial (so it does not keep it as complete).
    expect(failed).toEqual(['NVIDIA'])
  })

  it('leaves out a file the API gives no git blob SHA-1 for', async () => {
    const fetchJson = (async (url: string) =>
      url.includes('PrebuiltSignedDLL')
        ? amdFiles.map((f) => (f.name === 'amd_fidelityfx_vk.dll' ? { ...f, sha: undefined } : f))
        : answers[url]) as <T>(url: string) => Promise<T>
    const latest = await latestVendorDlls({ fetchJson })
    expect(latest['fsr-vk']).toBeUndefined()
    expect(latest['fsr-dx12']).toBeDefined()
  })

  it('ignores a release tag that is not a version', async () => {
    const fetchJson = (async (url: string) =>
      url.endsWith('NVIDIA/DLSS/releases/latest') ? { tag_name: 'v1/../../x' } : answers[url]) as <
      T
    >(
      url: string
    ) => Promise<T>
    expect((await latestVendorDlls({ fetchJson })).dlss).toBeUndefined()
  })
})

describe('ensureVendorDll', () => {
  const bytes = makePe('310.9.16.0', { filler: 1000 })
  const file: VendorDll = {
    kind: 'dlss',
    version: '310.9.16.0',
    fileName: 'nvngx_dlss.dll',
    url: 'https://raw.githubusercontent.com/NVIDIA/DLSS/v310.9.16/lib/Windows_x86_64/rel/nvngx_dlss.dll',
    size: bytes.length,
    gitBlobSha: gitBlobSha1(bytes),
    sha256: null,
    signer: 'NVIDIA Corporation'
  }
  const fakeDownload = (
    body: Buffer
  ): Mock<(d: { fileName: string }, dir: string) => Promise<string>> =>
    vi.fn(async (d: { fileName: string }, dir: string) => {
      const path = join(dir, d.fileName)
      await fs.writeFile(path, body)
      return path
    })

  it('matches git hash-object', () => {
    // `printf 'hello' | git hash-object --stdin`
    expect(gitBlobSha1(Buffer.from('hello'))).toBe('b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0')
  })

  it('downloads, checks and caches the file, then reuses it', async () => {
    const download = fakeDownload(bytes)
    const verifySigner = vi.fn(async () => true)
    const path = await ensureVendorDll(file, root, { download, verifySigner })
    expect(path).toBe(join(root, 'dlss', '310.9.16.0', 'nvngx_dlss.dll'))
    expect(await fs.readFile(path)).toEqual(bytes)
    expect(verifySigner).toHaveBeenCalledWith(expect.any(String), 'NVIDIA Corporation', undefined)
    expect(await fs.readdir(join(root, 'dlss', '310.9.16.0'))).toEqual(['nvngx_dlss.dll'])
    expect(await ensureVendorDll(file, root, { download, verifySigner })).toBe(path)
    expect(download).toHaveBeenCalledTimes(1)
  })

  it('refuses a file with the wrong checksum, version or signer, keeping nothing', async () => {
    const verifySigner = vi.fn(async () => true)
    const other = Buffer.from(bytes)
    other[100] ^= 1
    await expect(
      ensureVendorDll(file, root, { download: fakeDownload(other), verifySigner })
    ).rejects.toThrow(/checksum/)
    const older = makePe('310.9.1.0', { filler: 1000 })
    await expect(
      ensureVendorDll({ ...file, gitBlobSha: gitBlobSha1(older) }, root, {
        download: fakeDownload(older),
        verifySigner
      })
    ).rejects.toThrow(/version 310\.9\.1\.0/)
    await expect(
      ensureVendorDll(file, root, {
        download: fakeDownload(bytes),
        verifySigner: async () => false
      })
    ).rejects.toThrow(/not signed by NVIDIA Corporation/)
    expect(await fs.readdir(join(root, 'dlss', '310.9.16.0'))).toEqual([])
  })

  it('asks for the Intel company name on XeLL (signed by Microsoft)', async () => {
    const xell = makePe('1.3.2.10')
    const verifySigner = vi.fn(async () => true)
    await ensureVendorDll(
      {
        ...file,
        kind: 'xell',
        version: '1.3.2.10',
        fileName: 'libxell.dll',
        url: 'https://raw.githubusercontent.com/intel/xess/v3.0.2/bin/libxell.dll',
        size: xell.length,
        gitBlobSha: gitBlobSha1(xell),
        signer: 'Microsoft Windows Hardware Compatibility Publisher'
      },
      root,
      { download: fakeDownload(xell), verifySigner }
    )
    expect(verifySigner).toHaveBeenCalledWith(
      expect.any(String),
      'Microsoft Windows Hardware Compatibility Publisher',
      'Intel Corporation'
    )
  })

  it('checks the signer of a cached file again before reusing it', async () => {
    const cached = join(root, 'dlss', '310.9.16.0', 'nvngx_dlss.dll')
    await put(cached, bytes)
    const download = fakeDownload(bytes)
    // The cached copy (same size, version and hash) fails the signer check; the fresh download passes.
    const verifySigner = vi.fn(async (path: string) => path !== cached)
    expect(await ensureVendorDll(file, root, { download, verifySigner })).toBe(cached)
    expect(download).toHaveBeenCalledTimes(1)
    expect(verifySigner.mock.calls[0][0]).toBe(cached)
  })

  it('refuses a file with no checksum to check', async () => {
    const download = fakeDownload(bytes)
    await expect(
      ensureVendorDll({ ...file, gitBlobSha: null, sha256: null }, root, {
        download,
        verifySigner: async () => true
      })
    ).rejects.toThrow(/no checksum/)
    expect(download).not.toHaveBeenCalled()
  })

  it('shares one download between calls for the same file at once', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const download = vi.fn(async (d: { fileName: string }, dir: string) => {
      await gate
      const path = join(dir, d.fileName)
      await fs.writeFile(path, bytes)
      return path
    })
    const verifySigner = vi.fn(async () => true)
    const a = ensureVendorDll(file, root, { download, verifySigner })
    const b = ensureVendorDll(file, root, { download, verifySigner })
    release()
    const [pa, pb] = await Promise.all([a, b])
    expect(pa).toBe(pb)
    expect(download).toHaveBeenCalledTimes(1)
    expect(await fs.readFile(pa)).toEqual(bytes)
    // The temporary download folder is gone.
    expect(await fs.readdir(join(root, 'dlss', '310.9.16.0'))).toEqual(['nvngx_dlss.dll'])
  })

  it('does not fail a caller that joined a download the first caller stopped: it downloads with its own', async () => {
    let stop: () => void = () => undefined
    const stopped = new Promise<void>((resolve) => (stop = resolve))
    // The first caller's download is stopped (its job's Stop) while the second waits on it.
    const aborted = vi.fn(async () => {
      await stopped
      throw new Error('This operation was aborted')
    })
    const own = fakeDownload(bytes)
    const verifySigner = vi.fn(async () => true)
    const a = ensureVendorDll(file, root, { download: aborted, verifySigner })
    const b = ensureVendorDll(file, root, { download: own, verifySigner })
    await vi.waitFor(() => expect(aborted).toHaveBeenCalled())
    stop()
    await expect(a).rejects.toThrow(/aborted/)
    expect(await b).toBe(join(root, 'dlss', '310.9.16.0', 'nvngx_dlss.dll'))
    expect(own).toHaveBeenCalledTimes(1)
    expect(await fs.readdir(join(root, 'dlss', '310.9.16.0'))).toEqual(['nvngx_dlss.dll'])
  })

  it('downloads into a folder of its own and keeps a checked file that appeared meanwhile', async () => {
    const cached = join(root, 'dlss', '310.9.16.0', 'nvngx_dlss.dll')
    // A folder left by an older run is not touched (another call may be using it).
    await put(join(root, 'dlss', '310.9.16.0', 'download', 'keep.txt'), 'x')
    const dirs: string[] = []
    const download = vi.fn(async (d: { fileName: string }, dir: string) => {
      dirs.push(dir)
      const path = join(dir, d.fileName)
      await fs.writeFile(path, bytes)
      // Another process finishes the same file first.
      await fs.writeFile(cached, bytes)
      return path
    })
    expect(await ensureVendorDll(file, root, { download, verifySigner: async () => true })).toBe(
      cached
    )
    expect(dirs[0]).toMatch(/download-[0-9a-f]{12}$/)
    expect((await fs.readdir(join(root, 'dlss', '310.9.16.0'))).sort()).toEqual([
      'download',
      'nvngx_dlss.dll'
    ])
  })

  it('refuses addresses outside raw.githubusercontent.com', async () => {
    await expect(
      ensureVendorDll({ ...file, url: 'https://example.com/x.dll' }, root, {
        download: fakeDownload(bytes),
        verifySigner: async () => true
      })
    ).rejects.toThrow(/GitHub/)
  })
})

describe('swapDlls / restoreDlls', () => {
  let game: string
  let newDlss: string
  beforeEach(async () => {
    game = join(root, 'game')
    newDlss = join(root, 'cache', DLL_FILE_NAMES.dlss)
    await put(newDlss, makePe('310.9.16.0'))
  })

  const dll = (
    kind: FoundUpscalerDll['kind'],
    relPath: string,
    version: string | null
  ): FoundUpscalerDll => ({ kind, relPath, version, swapped: false })

  it('replaces older files of the same kind, keeping the originals, and restores them', async () => {
    const original = makePe('3.5.10.0')
    await put(join(game, 'a', 'nvngx_dlss.dll'), original)
    await put(join(game, 'b', 'nvngx_dlss.dll'), makePe('2.4.0.0'))
    await put(join(game, 'a', 'nvngx_dlssg.dll'), makePe('3.5.0.0'))
    const found = [
      dll('dlss', join('a', 'nvngx_dlss.dll'), '3.5.10.0'),
      dll('dlss', join('b', 'nvngx_dlss.dll'), '2.4.0.0'),
      dll('dlssg', join('a', 'nvngx_dlssg.dll'), '3.5.0.0')
    ]
    const result = await swapDlls(game, found, {
      dlss: { path: newDlss, version: '310.9.16.0' }
    })
    expect(result).toEqual({
      replaced: [join('a', 'nvngx_dlss.dll'), join('b', 'nvngx_dlss.dll')],
      skipped: []
    })
    expect(readPeFileVersion(await fs.readFile(join(game, 'a', 'nvngx_dlss.dll')))).toBe(
      '310.9.16.0'
    )
    expect(await fs.readFile(join(game, 'a', 'nvngx_dlss.dll' + BACKUP_SUFFIX))).toEqual(original)
    expect(readPeFileVersion(await fs.readFile(join(game, 'a', 'nvngx_dlssg.dll')))).toBe('3.5.0.0')
    const scanned = await scanUpscalerDlls(game)
    expect(scanned.filter((f) => f.swapped).map((f) => f.relPath)).toEqual([
      join('a', 'nvngx_dlss.dll'),
      join('b', 'nvngx_dlss.dll')
    ])

    const restored = await restoreDlls(game, scanned)
    expect(restored.restored).toEqual([join('a', 'nvngx_dlss.dll'), join('b', 'nvngx_dlss.dll')])
    expect(await fs.readFile(join(game, 'a', 'nvngx_dlss.dll'))).toEqual(original)
    expect((await scanUpscalerDlls(game)).some((f) => f.swapped)).toBe(false)
  })

  const swapTo = (version: string, path = newDlss): Parameters<typeof swapDlls>[2] => ({
    dlss: { path, version }
  })

  it('never overwrites its own backup when swapping again', async () => {
    const first = makePe('3.1.0.0')
    await put(join(game, 'nvngx_dlss.dll'), first)
    await swapDlls(game, [dll('dlss', 'nvngx_dlss.dll', '3.1.0.0')], swapTo('310.9.16.0'))
    const newer = join(root, 'cache2', DLL_FILE_NAMES.dlss)
    await put(newer, makePe('310.10.0.0'))
    const again = await swapDlls(game, await scanUpscalerDlls(game), swapTo('310.10.0.0', newer))
    expect(again.replaced).toEqual(['nvngx_dlss.dll'])
    expect(await fs.readFile(join(game, 'nvngx_dlss.dll' + BACKUP_SUFFIX))).toEqual(first)
    expect((await scanUpscalerDlls(game))[0].swapped).toBe(true)
  })

  it('leaves alone a file whose backup belongs to another upgrade', async () => {
    const theirs = makePe('3.1.0.0')
    await put(join(game, 'nvngx_dlss.dll'), makePe('3.5.0.0'))
    await put(join(game, 'nvngx_dlss.dll' + BACKUP_SUFFIX), theirs)
    const result = await swapDlls(
      game,
      [dll('dlss', 'nvngx_dlss.dll', '3.5.0.0')],
      swapTo('310.9.16.0')
    )
    expect(result.replaced).toEqual([])
    expect(result.skipped[0].reason).toMatch(/another upgrade/)
    expect(await restoreDlls(game, await scanUpscalerDlls(game))).toEqual({
      restored: [],
      failed: []
    })
    expect(await fs.readFile(join(game, 'nvngx_dlss.dll' + BACKUP_SUFFIX))).toEqual(theirs)
    expect(readPeFileVersion(await fs.readFile(join(game, 'nvngx_dlss.dll')))).toBe('3.5.0.0')
  })

  it('never downgrades and leaves DLSS 1 and unreadable files alone', async () => {
    await put(join(game, 'new', 'nvngx_dlss.dll'), makePe('310.10.0.0'))
    await put(join(game, 'old', 'nvngx_dlss.dll'), makePe('1.0.13.0'))
    await put(join(game, 'odd', 'nvngx_dlss.dll'), 'garbage')
    const result = await swapDlls(
      game,
      [
        dll('dlss', join('new', 'nvngx_dlss.dll'), '310.10.0.0'),
        dll('dlss', join('old', 'nvngx_dlss.dll'), '1.0.13.0'),
        dll('dlss', join('odd', 'nvngx_dlss.dll'), null)
      ],
      swapTo('310.9.16.0')
    )
    expect(result.replaced).toEqual([])
    expect(result.skipped.map((s) => s.reason)).toEqual([
      'it is already the newest version',
      'DLSS 1 games cannot use newer DLSS files',
      'its version could not be read'
    ])
    expect(await fs.readdir(join(game, 'new'))).toEqual(['nvngx_dlss.dll'])
    expect(await fs.readdir(game)).not.toContain(DLL_MANIFEST)
  })

  it('reports protected files and goes on with the rest', async () => {
    await put(join(game, 'locked', 'nvngx_dlss.dll'), makePe('3.5.0.0'))
    await put(join(game, 'free', 'nvngx_dlss.dll'), makePe('3.5.0.0'))
    const locked = join(game, 'locked', 'nvngx_dlss.dll')
    const io: DllIo = {
      ...nodeDllIo,
      rename: async (from, to) => {
        if (to === locked) throw Object.assign(new Error('denied'), { code: 'EPERM' })
        return nodeDllIo.rename(from, to)
      }
    }
    const result = await swapDlls(
      game,
      [
        dll('dlss', join('locked', 'nvngx_dlss.dll'), '3.5.0.0'),
        dll('dlss', join('free', 'nvngx_dlss.dll'), '3.5.0.0')
      ],
      swapTo('310.9.16.0'),
      io
    )
    expect(result).toEqual({
      replaced: [join('free', 'nvngx_dlss.dll')],
      skipped: [{ relPath: join('locked', 'nvngx_dlss.dll'), reason: 'the folder is protected' }]
    })
    // No backup and no temporary file are left for the file that was not replaced, and it is not listed.
    expect(await fs.readdir(join(game, 'locked'))).toEqual(['nvngx_dlss.dll'])
    const scanned = await scanUpscalerDlls(game)
    expect(scanned.filter((f) => f.swapped).map((f) => f.relPath)).toEqual([
      join('free', 'nvngx_dlss.dll')
    ])
  })

  it('leaves the game file untouched and drops the new backup when copying the new file fails', async () => {
    const original = makePe('3.5.0.0')
    await put(join(game, 'nvngx_dlss.dll'), original)
    const io: DllIo = {
      ...nodeDllIo,
      copyFile: async (from, to, exclusive) => {
        if (from === newDlss) {
          await fs.writeFile(to, Buffer.alloc(10))
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
        }
        return nodeDllIo.copyFile(from, to, exclusive)
      }
    }
    const result = await swapDlls(
      game,
      [dll('dlss', 'nvngx_dlss.dll', '3.5.0.0')],
      swapTo('310.9.16.0'),
      io
    )
    expect(result).toEqual({
      replaced: [],
      skipped: [{ relPath: 'nvngx_dlss.dll', reason: 'disk full' }]
    })
    expect(await fs.readFile(join(game, 'nvngx_dlss.dll'))).toEqual(original)
    expect(await fs.readdir(game)).toEqual(['nvngx_dlss.dll'])
  })

  it('keeps the backup (and offers Restore) when a failure damaged the game file', async () => {
    const original = makePe('3.5.0.0')
    await put(join(game, 'nvngx_dlss.dll'), original)
    const target = join(game, 'nvngx_dlss.dll')
    const io: DllIo = {
      ...nodeDllIo,
      rename: async (from, to) => {
        if (to === target) {
          // Truncates the game's file, then fails.
          await fs.writeFile(target, Buffer.alloc(0))
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
        }
        return nodeDllIo.rename(from, to)
      }
    }
    const result = await swapDlls(
      game,
      [dll('dlss', 'nvngx_dlss.dll', '3.5.0.0')],
      swapTo('310.9.16.0'),
      io
    )
    expect(result.replaced).toEqual([])
    expect(result.skipped[0].reason).toMatch(/disk full.*Restore/)
    expect(await fs.readFile(target + BACKUP_SUFFIX)).toEqual(original)
    const scanned = await scanUpscalerDlls(game)
    expect(scanned[0].swapped).toBe(true)
    expect((await restoreDlls(game, scanned)).restored).toEqual(['nvngx_dlss.dll'])
    expect(await fs.readFile(target)).toEqual(original)
  })

  it('keeps the backup when the game file is gone after a failure', async () => {
    const original = makePe('3.5.0.0')
    const target = join(game, 'nvngx_dlss.dll')
    await put(target, original)
    const io: DllIo = {
      ...nodeDllIo,
      rename: async (from, to) => {
        if (to === target) {
          await fs.rm(target)
          throw Object.assign(new Error('interrupted'), { code: 'EIO' })
        }
        return nodeDllIo.rename(from, to)
      }
    }
    await swapDlls(game, [dll('dlss', 'nvngx_dlss.dll', '3.5.0.0')], swapTo('310.9.16.0'), io)
    const scanned = await scanUpscalerDlls(game)
    expect(scanned).toEqual([
      expect.objectContaining({ relPath: 'nvngx_dlss.dll', version: null, swapped: true })
    ])
    expect((await restoreDlls(game, scanned)).restored).toEqual(['nvngx_dlss.dll'])
    expect(await fs.readFile(target)).toEqual(original)
  })

  it('drops an outdated backup after a game update and keeps the updated file on Restore', async () => {
    const target = join(game, 'nvngx_dlss.dll')
    await put(target, makePe('2.4.0.0'))
    await swapDlls(game, [dll('dlss', 'nvngx_dlss.dll', '2.4.0.0')], swapTo('310.9.16.0'))
    // The game's own update puts in its newer (but still older than PlayOut's) file.
    const updated = makePe('3.7.0.0')
    await fs.writeFile(target, updated)
    const scanned = await scanUpscalerDlls(game)
    expect(scanned[0].swapped).toBe(false)
    expect(await restoreDlls(game, scanned)).toEqual({ restored: [], failed: [] })
    expect(await fs.readFile(target)).toEqual(updated)
    expect(await fs.readdir(game)).toEqual(['nvngx_dlss.dll'])
  })

  it('keeps the updated game file as the new original when swapping after a game update', async () => {
    const target = join(game, 'nvngx_dlss.dll')
    await put(target, makePe('2.4.0.0'))
    await swapDlls(game, [dll('dlss', 'nvngx_dlss.dll', '2.4.0.0')], swapTo('310.9.16.0'))
    const updated = makePe('3.7.0.0')
    await fs.writeFile(target, updated)
    const result = await swapDlls(game, await scanUpscalerDlls(game), swapTo('310.9.16.0'))
    expect(result.replaced).toEqual(['nvngx_dlss.dll'])
    expect(await fs.readFile(target + BACKUP_SUFFIX)).toEqual(updated)
    await restoreDlls(game, await scanUpscalerDlls(game))
    expect(await fs.readFile(target)).toEqual(updated)
  })

  it('drops an outdated backup when the updated game file is already the newest', async () => {
    const target = join(game, 'nvngx_dlss.dll')
    await put(target, makePe('2.4.0.0'))
    await swapDlls(game, [dll('dlss', 'nvngx_dlss.dll', '2.4.0.0')], swapTo('310.9.16.0'))
    await fs.writeFile(target, makePe('310.20.0.0'))
    const result = await swapDlls(game, await scanUpscalerDlls(game), swapTo('310.9.16.0'))
    expect(result.skipped[0].reason).toBe('it is already the newest version')
    expect(await fs.readdir(game)).toEqual(['nvngx_dlss.dll'])
  })

  it('restores listed files the scan did not give, and files that are gone', async () => {
    const original = makePe('3.5.0.0')
    await put(join(game, 'a', 'nvngx_dlss.dll'), original)
    await put(join(game, 'b', 'nvngx_dlss.dll'), original)
    await swapDlls(
      game,
      [
        dll('dlss', join('a', 'nvngx_dlss.dll'), '3.5.0.0'),
        dll('dlss', join('b', 'nvngx_dlss.dll'), '3.5.0.0')
      ],
      swapTo('310.9.16.0')
    )
    // A mod manager deletes one; the caller passes an empty (stale or cut short) list.
    await fs.rm(join(game, 'b', 'nvngx_dlss.dll'))
    expect(await restoreDlls(game, [])).toEqual({
      restored: [join('a', 'nvngx_dlss.dll'), join('b', 'nvngx_dlss.dll')],
      failed: []
    })
    expect(await fs.readFile(join(game, 'a', 'nvngx_dlss.dll'))).toEqual(original)
    expect(await fs.readFile(join(game, 'b', 'nvngx_dlss.dll'))).toEqual(original)
    expect(await fs.readdir(game)).not.toContain(DLL_MANIFEST)
  })

  it('changes nothing and reports a damaged list', async () => {
    await put(join(game, 'nvngx_dlss.dll'), makePe('3.5.0.0'))
    await put(join(game, DLL_MANIFEST), '{ not json')
    const swap = await swapDlls(
      game,
      [dll('dlss', 'nvngx_dlss.dll', '3.5.0.0')],
      swapTo('310.9.16.0')
    )
    expect(swap.replaced).toEqual([])
    expect(swap.skipped[0].reason).toMatch(/cannot be read/)
    expect(await restoreDlls(game, [])).toEqual({
      restored: [],
      failed: [{ relPath: DLL_MANIFEST, reason: expect.stringMatching(/cannot be read/) }]
    })
  })

  it('skips games in WindowsApps and paths outside the game', async () => {
    const store = join(root, 'WindowsApps', 'Game')
    await put(join(store, 'nvngx_dlss.dll'), makePe('3.5.0.0'))
    const result = await swapDlls(
      store,
      [dll('dlss', 'nvngx_dlss.dll', '3.5.0.0')],
      swapTo('310.9.16.0')
    )
    expect(result.skipped).toEqual([
      { relPath: 'nvngx_dlss.dll', reason: 'the folder is protected' }
    ])
    const outside = await swapDlls(
      game,
      [dll('dlss', join('..', 'x.dll'), '3.5.0.0')],
      swapTo('310.9.16.0')
    )
    expect(outside.skipped[0].reason).toBe('the file is outside the game folder')
  })

  it('reports a restore that is refused', async () => {
    await put(join(game, 'nvngx_dlss.dll'), makePe('3.5.0.0'))
    await swapDlls(game, [dll('dlss', 'nvngx_dlss.dll', '3.5.0.0')], swapTo('310.9.16.0'))
    const io: DllIo = {
      ...nodeDllIo,
      rename: async () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' })
      }
    }
    expect(await restoreDlls(game, [], io)).toEqual({
      restored: [],
      failed: [{ relPath: 'nvngx_dlss.dll', reason: 'the folder is protected' }]
    })
    // Still listed, so a later Restore can try again.
    expect((await scanUpscalerDlls(game))[0].swapped).toBe(true)
  })
})
