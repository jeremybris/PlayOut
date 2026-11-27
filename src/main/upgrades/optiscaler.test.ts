import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BACKUP_SUFFIX,
  OPTISCALER_MANIFEST,
  OPTISCALER_RELEASE_API,
  carryIniValues,
  ensureOptiScaler,
  findOptiScalerInstall,
  installOptiScaler,
  latestOptiScaler,
  nodeOptiScalerIo,
  pickExeDir,
  readOriginalFilename,
  removeOptiScaler,
  setIniValue,
  type OptiScalerIo,
  type OptiScalerRelease
} from './optiscaler'

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'playout-optiscaler-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

/** A buffer holding a version-information String block "OriginalFilename" = `value`, padded like a dll. */
function versionBlob(value: string): Buffer {
  const key = Buffer.from('OriginalFilename\0', 'utf16le')
  const val = Buffer.from(`${value}\0`, 'utf16le')
  const head = Buffer.alloc(6)
  head.writeUInt16LE(6 + key.length + val.length, 0)
  head.writeUInt16LE(value.length + 1, 2)
  head.writeUInt16LE(1, 4)
  return Buffer.concat([Buffer.from('MZ fake program....'), Buffer.alloc(1), head, key, val])
}

async function write(path: string, data: string | Buffer): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, data)
}

async function exists(path: string): Promise<boolean> {
  return fs.access(path).then(
    () => true,
    () => false
  )
}

/** Every file under `dir` with its content, relative with forward slashes. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const e of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    const full = join(e.parentPath, e.name)
    const rel = full.slice(dir.length + 1).replace(/\\/g, '/')
    out[rel] = e.isDirectory() ? '<dir>' : (await fs.readFile(full)).toString('base64')
  }
  return out
}

const INI = [
  '[Upscalers]',
  '; comment',
  'Dx11Upscaler=auto',
  'Dx12Upscaler=auto',
  'VulkanUpscaler=auto',
  '',
  '[Spoofing]',
  'Dxgi=auto',
  ''
].join('\r\n')

/** A fake extracted release. */
async function makePackage(): Promise<string> {
  const pkg = join(root, 'pkg')
  await write(join(pkg, 'OptiScaler.dll'), versionBlob('OptiScaler.dll'))
  await write(join(pkg, 'OptiScaler.ini'), INI)
  await write(join(pkg, 'fakenvapi.dll'), 'fakenvapi')
  await write(join(pkg, 'fakenvapi.ini'), 'enable_logs=1')
  await write(join(pkg, 'dlssg_to_fsr3_amd_is_better.dll'), 'nukem')
  await write(join(pkg, 'libxess.dll'), 'new xess')
  await write(join(pkg, 'amd_fidelityfx_dx12.dll'), 'new ffx')
  await write(join(pkg, 'D3D12_Optiscaler', 'D3D12Core.dll'), 'agility')
  await write(join(pkg, 'Licenses', 'XeSS_LICENSE.txt'), 'license')
  await write(join(pkg, 'setup_windows.bat'), 'bat')
  await write(join(pkg, 'setup_linux.sh'), 'sh')
  await write(join(pkg, '!! README_EXTRACT ALL FILES TO GAME FOLDER !!.txt'), 'readme')
  return pkg
}

/** A fake game: an exe plus a libxess.dll of its own. */
async function makeGame(): Promise<{ installDir: string; exeDir: string }> {
  const installDir = join(root, 'Game')
  const exeDir = join(installDir, 'Sandfall', 'Binaries', 'Win64')
  await write(join(exeDir, 'Sandfall-Win64-Shipping.exe'), 'exe')
  await write(join(exeDir, 'libxess.dll'), 'game xess')
  return { installDir, exeDir }
}

describe('latestOptiScaler', () => {
  const asset = {
    name: 'Optiscaler_0.9.5-final.20261116.7z',
    browser_download_url:
      'https://github.com/optiscaler/OptiScaler/releases/download/v0.9.5/Optiscaler_0.9.5-final.20261116.7z',
    size: 70418897,
    digest: 'sha256:' + 'ab'.repeat(32)
  }

  it('reads the release and its archive', async () => {
    const urls: string[] = []
    const r = await latestOptiScaler({
      fetchJson: async (url) => {
        urls.push(url)
        return { tag_name: 'v0.9.5', assets: [{ name: 'notes.txt' }, asset] }
      }
    })
    expect(urls).toEqual([OPTISCALER_RELEASE_API])
    expect(r).toEqual({
      version: '0.9.5',
      url: asset.browser_download_url,
      size: 70418897,
      sha256: 'ab'.repeat(32),
      fileName: asset.name
    })
  })

  it('gives null for nightlies, prereleases, missing archives and foreign hosts', async () => {
    const of = (release: unknown): Promise<OptiScalerRelease | null> =>
      latestOptiScaler({ fetchJson: async () => release })
    expect(await of({ tag_name: 'nightly', assets: [asset] })).toBeNull()
    expect(await of({ tag_name: 'v1.0', prerelease: true, assets: [asset] })).toBeNull()
    expect(await of({ tag_name: 'v1.0', assets: [] })).toBeNull()
    expect(
      await of({
        tag_name: 'v1.0',
        assets: [{ ...asset, browser_download_url: 'https://example.com/Optiscaler_1.7z' }]
      })
    ).toBeNull()
    expect(await of(null)).toBeNull()
    expect((await of({ tag_name: 'v1.0', assets: [{ ...asset, digest: null }] }))?.sha256).toBe(
      null
    )
  })
})

describe('ensureOptiScaler', () => {
  const release: OptiScalerRelease = {
    version: '0.9.5',
    url: 'https://github.com/optiscaler/OptiScaler/releases/download/v0.9.5/Optiscaler_0.9.5.7z',
    size: 10,
    sha256: 'cd'.repeat(32),
    fileName: 'Optiscaler_0.9.5.7z'
  }

  /** Fake download / extract steps that write a release like the real one; counts downloads. */
  function fakeDeps(extra: Record<string, string> = {}): {
    downloads: () => number
    download: (file: { fileName: string }, dir: string) => Promise<string>
    extract7z: (archive: string, dest: string) => Promise<void>
  } {
    let count = 0
    return {
      downloads: () => count,
      download: async (file, dir) => {
        count++
        const p = join(dir, file.fileName)
        await fs.writeFile(p, 'archive')
        return p
      },
      extract7z: async (_archive, dest) => {
        await write(join(dest, 'OptiScaler.dll'), 'dll')
        await write(join(dest, 'OptiScaler.ini'), INI)
        for (const [name, data] of Object.entries(extra)) await write(join(dest, name), data)
      }
    }
  }

  it('refuses a release without a checksum unless the user agreed', async () => {
    const cache = join(root, 'cache')
    const deps = fakeDeps()
    await expect(ensureOptiScaler({ ...release, sha256: null }, cache, deps)).rejects.toThrow(
      /no checksum/
    )
    expect(deps.downloads()).toBe(0)
    expect(
      await ensureOptiScaler({ ...release, sha256: null }, cache, deps, { allowUnverified: true })
    ).toBe(join(cache, 'OptiScaler-0.9.5'))
  })

  it('checks the AMD and Intel dlls against their signers before keeping the release', async () => {
    const cache = join(root, 'cache')
    const checked: [string, string, string | undefined][] = []
    const deps = fakeDeps({
      'amd_fidelityfx_upscaler_dx12.dll': 'amd',
      'libxess.dll': 'xess',
      'libxell.dll': 'xell',
      'fakenvapi.dll': 'community'
    })
    const dir = await ensureOptiScaler(release, cache, {
      ...deps,
      verifySigner: async (path, signer, company) => {
        checked.push([path.split(/[\\/]/).pop()!, signer, company])
        return true
      }
    })
    expect(checked.sort()).toEqual([
      ['amd_fidelityfx_upscaler_dx12.dll', 'Advanced Micro Devices, Inc.', undefined],
      ['libxell.dll', 'Microsoft Windows Hardware Compatibility Publisher', 'Intel Corporation'],
      ['libxess.dll', 'Intel Corporation', undefined]
    ])
    expect(await exists(join(dir, '.playout-complete'))).toBe(true)

    await fs.rm(cache, { recursive: true })
    await expect(
      ensureOptiScaler(release, cache, {
        ...deps,
        verifySigner: async (path) => !path.endsWith('libxess.dll')
      })
    ).rejects.toThrow(/libxess\.dll .* not signed by Intel Corporation/)
    expect(await fs.readdir(cache)).toEqual([])
  })

  it('runs one at a time and keeps a cached release an install is copying from', async () => {
    const cache = join(root, 'cache')
    const deps = fakeDeps()
    // Two games asking at once download once.
    const [a, b] = await Promise.all([
      ensureOptiScaler(release, cache, deps),
      ensureOptiScaler(release, cache, deps)
    ])
    expect(a).toBe(b)
    expect(deps.downloads()).toBe(1)

    // A game installs from 0.9.5 while another game's ensure fetches 0.9.6.
    const { exeDir } = await makeGame()
    let release1: () => void = () => undefined
    const gate = new Promise<void>((r) => (release1 = r))
    let copying: () => void = () => undefined
    const started = new Promise<void>((r) => (copying = r))
    const io: OptiScalerIo = {
      ...nodeOptiScalerIo,
      copyFile: async (from, to) => {
        copying()
        await gate
        await nodeOptiScalerIo.copyFile(from, to)
      }
    }
    const install = installOptiScaler(exeDir, a, { gpuVendor: 'amd', version: '0.9.5' }, io)
    await started
    const newer = await ensureOptiScaler({ ...release, version: '0.9.6' }, cache, deps)
    expect(await exists(a)).toBe(true)
    release1()
    await install
    expect(await fs.readFile(join(exeDir, 'dxgi.dll'), 'utf8')).toBe('dll')
    // Once nothing uses it, the next clean-up removes it.
    await fs.rm(join(newer, '.playout-complete'))
    await ensureOptiScaler({ ...release, version: '0.9.6' }, cache, deps)
    expect(await exists(a)).toBe(false)
  })

  it('downloads, extracts once, then reuses the cache and drops older versions', async () => {
    const cache = join(root, 'cache')
    await write(join(cache, 'OptiScaler-0.9.4', 'OptiScaler.dll'), 'old')
    let downloads = 0
    const deps = {
      download: async (file: { fileName: string }, dir: string) => {
        downloads++
        const p = join(dir, file.fileName)
        await fs.writeFile(p, 'archive')
        return p
      },
      extract7z: async (_archive: string, dest: string) => {
        await write(join(dest, 'Optiscaler', 'OptiScaler.dll'), 'dll')
        await write(join(dest, 'Optiscaler', 'OptiScaler.ini'), INI)
      }
    }
    const dir = await ensureOptiScaler(release, cache, deps)
    expect(dir).toBe(join(cache, 'OptiScaler-0.9.5'))
    expect(await fs.readFile(join(dir, 'OptiScaler.dll'), 'utf8')).toBe('dll')
    expect(await exists(join(cache, release.fileName))).toBe(false)
    expect(await exists(join(cache, 'OptiScaler-0.9.4'))).toBe(false)
    expect(await ensureOptiScaler(release, cache, deps)).toBe(dir)
    expect(downloads).toBe(1)
  })

  it('refuses a source-code download and leaves nothing behind', async () => {
    const cache = join(root, 'cache')
    await expect(
      ensureOptiScaler(release, cache, {
        download: async (file, dir) => {
          const p = join(dir, file.fileName)
          await fs.writeFile(p, 'x')
          return p
        },
        extract7z: async (_a, dest) => {
          await write(join(dest, 'OptiScaler.sln'), 'sln')
          await write(join(dest, 'OptiScaler.dll'), 'dll')
        }
      })
    ).rejects.toThrow(/source code/)
    expect(await fs.readdir(cache)).toEqual([])
  })

  it('refuses a download from elsewhere', async () => {
    await expect(
      ensureOptiScaler({ ...release, url: 'https://example.com/x.7z' }, root, {
        download: async () => {
          throw new Error('not called')
        },
        extract7z: async () => undefined
      })
    ).rejects.toThrow(/own GitHub/)
  })
})

describe('pickExeDir', () => {
  it('prefers the Unreal shipping exe under Binaries, ignoring Engine', async () => {
    const game = join(root, 'Game')
    await write(join(game, 'Sandfall.exe'), 'stub')
    await write(join(game, 'Engine', 'Binaries', 'Win64', 'Foo-Win64-Shipping.exe'), 'x')
    await write(join(game, 'Sandfall', 'Binaries', 'WinGDK', 'Sandfall-WinGDK-Shipping.exe'), 'x')
    await write(join(game, 'Sandfall', 'Binaries', 'Win64', 'Sandfall-Win64-Shipping.exe'), 'x')
    expect(await pickExeDir(game, join(game, 'Sandfall.exe'))).toBe(
      join(game, 'Sandfall', 'Binaries', 'Win64')
    )
  })

  it("uses the game's known exe, unless it is a launcher", async () => {
    const game = join(root, 'Game')
    await write(join(game, 'bin', 'x64', 'Cyberpunk2077.exe'), 'x'.repeat(10))
    await write(join(game, 'REDprelauncher.exe'), 'x'.repeat(100))
    expect(await pickExeDir(game, join(game, 'bin', 'x64', 'Cyberpunk2077.exe'))).toBe(
      join(game, 'bin', 'x64')
    )
    // The launcher is skipped; the largest other exe near the top wins.
    expect(await pickExeDir(game, join(game, 'REDprelauncher.exe'))).toBe(join(game, 'bin', 'x64'))
  })

  it("ignores a known exe outside the game's folder", async () => {
    const game = join(root, 'Game')
    await write(join(game, 'Retail', 'Game.exe'), 'x'.repeat(50))
    await write(join(root, 'Ubisoft', 'Shared', 'GameRunner.exe'), 'x')
    expect(await pickExeDir(game, join(root, 'Ubisoft', 'Shared', 'GameRunner.exe'))).toBe(
      join(game, 'Retail')
    )
    // A sibling folder whose name starts the same is outside too.
    await write(join(root, 'Game2', 'Other.exe'), 'x')
    expect(await pickExeDir(game, join(root, 'Game2', 'Other.exe'))).toBe(join(game, 'Retail'))
    // Different letter case is still inside on Windows.
    if (process.platform === 'win32')
      expect(await pickExeDir(game.toUpperCase(), join(game, 'Retail', 'Game.exe'))).toBe(
        join(game, 'Retail')
      )
  })

  it('takes the largest exe that is not a launcher or redistributable', async () => {
    const game = join(root, 'Game')
    await write(join(game, 'UnityCrashHandler64.exe'), 'x'.repeat(500))
    await write(join(game, '_CommonRedist', 'vc_big.exe'), 'x'.repeat(900))
    await write(join(game, 'Small.exe'), 'x'.repeat(5))
    await write(join(game, 'Retail', 'Big.exe'), 'x'.repeat(50))
    expect(await pickExeDir(game)).toBe(join(game, 'Retail'))
  })

  it('gives null without an exe or in WindowsApps', async () => {
    await write(join(root, 'Game', 'readme.txt'), 'x')
    expect(await pickExeDir(join(root, 'Game'))).toBeNull()
    expect(await pickExeDir('C:\\Program Files\\WindowsApps\\Game')).toBeNull()
  })
})

describe('readOriginalFilename', () => {
  it('reads the version information name', () => {
    expect(readOriginalFilename(versionBlob('OptiScaler.dll'))).toBe('OptiScaler.dll')
    expect(readOriginalFilename(versionBlob('ReShade64.dll'))).toBe('ReShade64.dll')
    expect(readOriginalFilename(Buffer.from('no version here'))).toBeNull()
  })
})

describe('setIniValue', () => {
  it('edits in place, keeping comments and line endings', () => {
    const out = setIniValue(INI, 'upscalers', 'Dx12Upscaler', 'fsr31')
    expect(out).toBe(INI.replace('Dx12Upscaler=auto', 'Dx12Upscaler=fsr31'))
  })

  it('only touches the named section and adds missing keys and sections', () => {
    const text = '[A]\nKey=1\n\n[B]\nKey=2\n'
    expect(setIniValue(text, 'B', 'Key', '3')).toBe('[A]\nKey=1\n\n[B]\nKey=3\n')
    expect(setIniValue(text, 'A', 'New', 'x')).toBe('[A]\nKey=1\nNew=x\n\n[B]\nKey=2\n')
    expect(setIniValue(text, 'C', 'K', 'v')).toBe('[A]\nKey=1\n\n[B]\nKey=2\n[C]\nK=v\n')
    expect(setIniValue('[A]\n;Key=1\n', 'A', 'Key', '2')).toBe('[A]\n;Key=1\nKey=2\n')
  })
})

describe('carryIniValues', () => {
  it("carries the user's values into keys the new ini still has", () => {
    const oldIni = '[Upscalers]\nDx12Upscaler=xess\nGone=1\n[FrameGen]\nFGType=optifg\n'
    const newIni =
      '[Upscalers]\r\n; note\r\nDx12Upscaler=auto\r\nNew=auto\r\n[FrameGen]\r\nFGType=auto\r\n'
    expect(carryIniValues(newIni, oldIni)).toBe(
      '[Upscalers]\r\n; note\r\nDx12Upscaler=xess\r\nNew=auto\r\n[FrameGen]\r\nFGType=optifg\r\n'
    )
    expect(
      carryIniValues(newIni, oldIni, [{ section: 'upscalers', key: 'dx12upscaler' }])
    ).toContain('Dx12Upscaler=auto')
  })
})

describe('installOptiScaler / removeOptiScaler', () => {
  it("refuses a folder outside the game's folder", async () => {
    const pkg = await makePackage()
    const { installDir } = await makeGame()
    const outside = join(root, 'Launcher')
    await fs.mkdir(outside)
    await expect(
      installOptiScaler(outside, pkg, { gpuVendor: 'amd', version: '0.9.5', installDir })
    ).rejects.toThrow(/inside the game's folder/)
    expect(await fs.readdir(outside)).toEqual([])
  })

  it('refuses an older OptiScaler installed by hand as nvngx.dll or nvapi64.dll', async () => {
    const pkg = await makePackage()
    const { exeDir } = await makeGame()
    for (const name of ['nvngx.dll', 'nvapi64.dll']) {
      await fs.writeFile(join(exeDir, name), versionBlob('OptiScaler.dll'))
      await expect(
        installOptiScaler(exeDir, pkg, { gpuVendor: 'amd', version: '0.9.5' })
      ).rejects.toThrow(new RegExp(`by hand \\(${name.replace('.', '\\.')}\\)`))
      // The game's own NVIDIA dll is fine.
      await fs.writeFile(join(exeDir, name), versionBlob('nvngx.dll'))
    }
    await installOptiScaler(exeDir, pkg, { gpuVendor: 'amd', version: '0.9.5' })
    expect(await exists(join(exeDir, 'dxgi.dll'))).toBe(true)
  })

  it("keeps the user's ini settings across an update", async () => {
    const pkg = await makePackage()
    const { exeDir } = await makeGame()
    await installOptiScaler(exeDir, pkg, { gpuVendor: 'amd', version: '0.9.4' })
    const ini = join(exeDir, 'OptiScaler.ini')
    // The user picks other settings in OptiScaler's overlay.
    const chosen = (await fs.readFile(ini, 'utf8'))
      .replace('Dx12Upscaler=fsr31', 'Dx12Upscaler=xess')
      .replace('Dxgi=auto', 'Dxgi=false')
    await fs.writeFile(ini, chosen)
    await installOptiScaler(exeDir, pkg, { gpuVendor: 'amd', version: '0.9.5' })
    const after = await fs.readFile(ini, 'utf8')
    expect(after).toContain('Dx12Upscaler=xess')
    expect(after).toContain('Dxgi=false')
    expect(after).toContain('VulkanUpscaler=fsr31_12')
    expect(await exists(join(exeDir, '.playout-optiscaler-previous'))).toBe(false)
  })

  it('keeps the previous version installed when an update fails', async () => {
    const pkg = await makePackage()
    const { installDir, exeDir } = await makeGame()
    const before = await snapshot(installDir)
    await installOptiScaler(exeDir, pkg, { gpuVendor: 'amd', version: '0.9.4' })
    await fs.writeFile(join(exeDir, 'OptiScaler.log'), 'log')
    const installed = await snapshot(installDir)
    let copies = 0
    const io: OptiScalerIo = {
      ...nodeOptiScalerIo,
      copyFile: async (from, to) => {
        if (++copies === 5) throw new Error('file locked')
        await nodeOptiScalerIo.copyFile(from, to)
      }
    }
    await expect(
      installOptiScaler(exeDir, pkg, { gpuVendor: 'amd', version: '0.9.5' }, io)
    ).rejects.toThrow('file locked')
    expect(await snapshot(installDir)).toEqual(installed)
    expect((await findOptiScalerInstall(installDir))?.version).toBe('0.9.4')
    await removeOptiScaler(installDir)
    expect(await snapshot(installDir)).toEqual(before)
  })

  it('keeps the previous version when the update stops at a check', async () => {
    const pkg = await makePackage()
    const { installDir, exeDir } = await makeGame()
    await installOptiScaler(exeDir, pkg, { gpuVendor: 'amd', version: '0.9.4' })
    const installed = await snapshot(installDir)
    await fs.writeFile(join(exeDir, 'Remove_OptiScaler.bat'), 'bat')
    await expect(
      installOptiScaler(exeDir, pkg, { gpuVendor: 'amd', version: '0.9.5' })
    ).rejects.toThrow(/by hand/)
    await fs.rm(join(exeDir, 'Remove_OptiScaler.bat'))
    expect(await snapshot(installDir)).toEqual(installed)
  })

  it('leaves files a game update put back in place when removing', async () => {
    const pkg = await makePackage()
    const { installDir, exeDir } = await makeGame()
    await installOptiScaler(exeDir, pkg, { gpuVendor: 'amd', version: '0.9.5' })
    // A game patch ships a newer libxess.dll and its own amd_fidelityfx_dx12.dll.
    await fs.writeFile(join(exeDir, 'libxess.dll'), 'patched game xess')
    await fs.writeFile(join(exeDir, 'amd_fidelityfx_dx12.dll'), 'patched game ffx')
    const left = await removeOptiScaler(installDir)
    expect(left.sort()).toEqual([
      'Sandfall/Binaries/Win64/amd_fidelityfx_dx12.dll',
      'Sandfall/Binaries/Win64/libxess.dll'
    ])
    expect(await fs.readFile(join(exeDir, 'libxess.dll'), 'utf8')).toBe('patched game xess')
    expect(await exists(join(exeDir, 'libxess.dll' + BACKUP_SUFFIX))).toBe(false)
    expect(await fs.readFile(join(exeDir, 'amd_fidelityfx_dx12.dll'), 'utf8')).toBe(
      'patched game ffx'
    )
    expect(await exists(join(exeDir, 'dxgi.dll'))).toBe(false)
    expect(await exists(join(exeDir, OPTISCALER_MANIFEST))).toBe(false)
  })

  it('an update takes a game-patched file as the game file to back up', async () => {
    const pkg = await makePackage()
    const { installDir, exeDir } = await makeGame()
    await installOptiScaler(exeDir, pkg, { gpuVendor: 'amd', version: '0.9.4' })
    await fs.writeFile(join(exeDir, 'libxess.dll'), 'patched game xess')
    await installOptiScaler(exeDir, pkg, { gpuVendor: 'amd', version: '0.9.5' })
    expect(await fs.readFile(join(exeDir, 'libxess.dll' + BACKUP_SUFFIX), 'utf8')).toBe(
      'patched game xess'
    )
    expect(await removeOptiScaler(installDir)).toEqual([])
    expect(await fs.readFile(join(exeDir, 'libxess.dll'), 'utf8')).toBe('patched game xess')
  })

  it('installs as dxgi.dll on AMD with the ini edits, then removes exactly', async () => {
    const pkg = await makePackage()
    const { installDir, exeDir } = await makeGame()
    const before = await snapshot(installDir)

    const result = await installOptiScaler(
      exeDir,
      pkg,
      { gpuVendor: 'amd', version: '0.9.5', installDir },
      nodeOptiScalerIo
    )
    expect(result).toEqual({
      relDir: join('Sandfall', 'Binaries', 'Win64'),
      asName: 'dxgi.dll',
      version: '0.9.5'
    })
    expect(readOriginalFilename(await fs.readFile(join(exeDir, 'dxgi.dll')))).toBe('OptiScaler.dll')
    expect(await exists(join(exeDir, 'OptiScaler.dll'))).toBe(false)
    expect(await exists(join(exeDir, 'setup_windows.bat'))).toBe(false)
    expect(await exists(join(exeDir, 'setup_linux.sh'))).toBe(false)
    expect(await exists(join(exeDir, 'fakenvapi.dll'))).toBe(true)
    expect(await exists(join(exeDir, 'dlssg_to_fsr3_amd_is_better.dll'))).toBe(true)
    expect(await exists(join(exeDir, 'D3D12_Optiscaler', 'D3D12Core.dll'))).toBe(true)
    // The game's own libxess.dll is kept to put back.
    expect(await fs.readFile(join(exeDir, 'libxess.dll'), 'utf8')).toBe('new xess')
    expect(await fs.readFile(join(exeDir, 'libxess.dll' + BACKUP_SUFFIX), 'utf8')).toBe('game xess')
    const ini = await fs.readFile(join(exeDir, 'OptiScaler.ini'), 'utf8')
    expect(ini).toContain('Dx12Upscaler=fsr31\r\n')
    expect(ini).toContain('Dx11Upscaler=fsr31_12\r\n')
    expect(ini).toContain('VulkanUpscaler=fsr31_12\r\n')
    expect(ini).toContain('Dxgi=auto')

    const manifest = JSON.parse(await fs.readFile(join(exeDir, OPTISCALER_MANIFEST), 'utf8'))
    expect(manifest.replaced).toEqual(['libxess.dll'])
    expect(manifest.added).toContain('dxgi.dll')
    expect(manifest.dirs).toEqual(expect.arrayContaining(['D3D12_Optiscaler', 'Licenses']))

    expect(await findOptiScalerInstall(installDir)).toEqual(result)

    // Logs OptiScaler writes while the game runs go too.
    await fs.writeFile(join(exeDir, 'OptiScaler.log'), 'log')
    await write(join(exeDir, 'DlssOverrides', 'x.json'), '{}')

    await removeOptiScaler(installDir)
    expect(await snapshot(installDir)).toEqual(before)
    expect(await findOptiScalerInstall(installDir)).toBeNull()
  })

  it('never overwrites another mod: falls back to winmm.dll when dxgi.dll is taken', async () => {
    const pkg = await makePackage()
    const { installDir, exeDir } = await makeGame()
    await fs.writeFile(join(exeDir, 'dxgi.dll'), versionBlob('ReShade64.dll'))
    const before = await snapshot(installDir)
    const r = await installOptiScaler(exeDir, pkg, { gpuVendor: 'intel', version: '0.9.5' })
    expect(r.asName).toBe('winmm.dll')
    expect(r.relDir).toBe('')
    expect(readOriginalFilename(await fs.readFile(join(exeDir, 'dxgi.dll')))).toBe('ReShade64.dll')
    expect(await fs.readFile(join(exeDir, 'OptiScaler.ini'), 'utf8')).toContain('Dx12Upscaler=xess')
    await removeOptiScaler(installDir)
    expect(await snapshot(installDir)).toEqual(before)
  })

  it('on NVIDIA leaves the ini alone and skips the AMD / Intel extras', async () => {
    const pkg = await makePackage()
    const { exeDir } = await makeGame()
    await installOptiScaler(exeDir, pkg, { gpuVendor: 'nvidia', version: '0.9.5' })
    expect(await fs.readFile(join(exeDir, 'OptiScaler.ini'), 'utf8')).toBe(INI)
    expect(await exists(join(exeDir, 'fakenvapi.dll'))).toBe(false)
    expect(await exists(join(exeDir, 'fakenvapi.ini'))).toBe(false)
    expect(await exists(join(exeDir, 'dlssg_to_fsr3_amd_is_better.dll'))).toBe(false)
  })

  it('refuses when every proxy name is taken', async () => {
    const pkg = await makePackage()
    const { exeDir } = await makeGame()
    for (const n of [
      'dxgi.dll',
      'winmm.dll',
      'version.dll',
      'dbghelp.dll',
      'd3d12.dll',
      'wininet.dll',
      'winhttp.dll'
    ])
      await fs.writeFile(join(exeDir, n), 'other mod')
    await expect(
      installOptiScaler(exeDir, pkg, { gpuVendor: 'amd', version: '0.9.5' })
    ).rejects.toThrow(/taken by other mods/)
    expect(await exists(join(exeDir, OPTISCALER_MANIFEST))).toBe(false)
  })

  it('refuses an OptiScaler installed by hand', async () => {
    const pkg = await makePackage()
    const { exeDir } = await makeGame()
    await fs.writeFile(join(exeDir, 'version.dll'), versionBlob('OptiScaler.dll'))
    await expect(
      installOptiScaler(exeDir, pkg, { gpuVendor: 'amd', version: '0.9.5' })
    ).rejects.toThrow(/by hand \(version\.dll\)/)
    await fs.rm(join(exeDir, 'version.dll'))
    await fs.writeFile(join(exeDir, 'OptiScaler.ini'), 'x')
    await expect(
      installOptiScaler(exeDir, pkg, { gpuVendor: 'amd', version: '0.9.5' })
    ).rejects.toThrow(/by hand \(OptiScaler\.ini\)/)
  })

  it('updates over its own earlier install and still restores the original game files', async () => {
    const pkg = await makePackage()
    const { installDir, exeDir } = await makeGame()
    const before = await snapshot(installDir)
    await installOptiScaler(exeDir, pkg, { gpuVendor: 'amd', version: '0.9.4' })
    const r = await installOptiScaler(exeDir, pkg, { gpuVendor: 'amd', version: '0.9.5' })
    expect(r.asName).toBe('dxgi.dll')
    expect((await findOptiScalerInstall(installDir))?.version).toBe('0.9.5')
    expect(await fs.readFile(join(exeDir, 'libxess.dll' + BACKUP_SUFFIX), 'utf8')).toBe('game xess')
    await removeOptiScaler(installDir)
    expect(await snapshot(installDir)).toEqual(before)
  })

  it('keeps a game file whose backup slot is already used by another upgrade', async () => {
    const pkg = await makePackage()
    const { installDir, exeDir } = await makeGame()
    await fs.writeFile(join(exeDir, 'libxess.dll' + BACKUP_SUFFIX), 'older xess')
    const before = await snapshot(installDir)
    await installOptiScaler(exeDir, pkg, { gpuVendor: 'amd', version: '0.9.5' })
    expect(await fs.readFile(join(exeDir, 'libxess.dll'), 'utf8')).toBe('game xess')
    expect(await fs.readFile(join(exeDir, 'libxess.dll' + BACKUP_SUFFIX), 'utf8')).toBe(
      'older xess'
    )
    await removeOptiScaler(installDir)
    expect(await snapshot(installDir)).toEqual(before)
  })

  it('puts the folder back when a copy fails part way', async () => {
    const pkg = await makePackage()
    const { installDir, exeDir } = await makeGame()
    const before = await snapshot(installDir)
    let copies = 0
    const io: OptiScalerIo = {
      ...nodeOptiScalerIo,
      copyFile: async (from, to) => {
        if (++copies === 4) throw new Error('disk full')
        await nodeOptiScalerIo.copyFile(from, to)
      }
    }
    await expect(
      installOptiScaler(exeDir, pkg, { gpuVendor: 'amd', version: '0.9.5' }, io)
    ).rejects.toThrow('disk full')
    expect(await snapshot(installDir)).toEqual(before)
  })

  it('refuses WindowsApps and a package without OptiScaler.dll', async () => {
    await expect(
      installOptiScaler('C:\\Program Files\\WindowsApps\\Game', root, {
        gpuVendor: 'amd',
        version: '1'
      })
    ).rejects.toThrow(/protected folder/)
    const { exeDir } = await makeGame()
    await fs.mkdir(join(root, 'empty'))
    await expect(
      installOptiScaler(exeDir, join(root, 'empty'), { gpuVendor: 'amd', version: '1' })
    ).rejects.toThrow(/no OptiScaler\.dll/)
  })

  it('removing does nothing when PlayOut did not install it', async () => {
    const { installDir } = await makeGame()
    const before = await snapshot(installDir)
    await removeOptiScaler(installDir)
    expect(await snapshot(installDir)).toEqual(before)
  })
})
