import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))
vi.mock('./download', () => ({ downloadFile: vi.fn() }))

import { downloadFile } from './download'
import {
  DIRECTX_DOWNLOAD,
  directxScript,
  ensureRuntimes,
  parseRegistryNumber,
  runtimesMissing,
  VCREDIST_DOWNLOAD,
  type RuntimeDeps
} from './runtimes'

const VC = 'SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64'
const VC_WOW = 'SOFTWARE\\WOW6432Node\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64'

let root: string
let workDir: string
let registry: Record<string, string>
let files: Set<string>
let elevated: { file: string; args: string[]; script?: string }[]
let elevatedCode: (file: string) => number | null

function deps(): RuntimeDeps {
  return {
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    workDir,
    windowsDir: 'C:\\Win',
    readRegistry: async (hive, key, name) => registry[`${hive}\\${key}\\${name}`] ?? null,
    exists: async (path) => files.has(path),
    runElevated: async (file, args) => {
      const ps1 = args[args.indexOf('-File') + 1]
      const script = args.includes('-File') ? await fs.readFile(ps1, 'utf8') : undefined
      elevated.push({ file, args, script })
      return elevatedCode(file)
    }
  }
}

function setVc(key: string, installed: string, major: string, minor: string): void {
  registry[`HKLM\\${key}\\Installed`] = installed
  registry[`HKLM\\${key}\\Major`] = major
  registry[`HKLM\\${key}\\Minor`] = minor
}

const D3DX = join('C:\\Win', 'SysWOW64', 'd3dx9_42.dll')
const XINPUT = join('C:\\Win', 'SysWOW64', 'xinput1_3.dll')

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'playout-runtimes-'))
  workDir = join(root, 'downloads')
  registry = {}
  files = new Set()
  elevated = []
  elevatedCode = () => 0
  vi.mocked(downloadFile).mockReset()
  vi.mocked(downloadFile).mockImplementation(async (d, dir) => {
    const path = join(dir, d.fileName)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path, '')
    if (d.size) await fs.truncate(path, d.size)
    return path
  })
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('parseRegistryNumber', () => {
  it('reads decimal and 0x hex', () => {
    expect(parseRegistryNumber('14')).toBe(14)
    expect(parseRegistryNumber('0x1')).toBe(1)
    expect(parseRegistryNumber('0x2A')).toBe(42)
    expect(parseRegistryNumber('')).toBeNull()
    expect(parseRegistryNumber('abc')).toBeNull()
    expect(parseRegistryNumber(null)).toBeNull()
  })
})

describe('runtimesMissing', () => {
  it('detects the Visual C++ runtime from either registry view', async () => {
    expect(await runtimesMissing(['vcredist'], deps())).toEqual(['vcredist'])
    setVc(VC, '1', '14', '38')
    expect(await runtimesMissing(['vcredist'], deps())).toEqual(['vcredist'])
    setVc(VC_WOW, '0x1', '0xe', '44')
    expect(await runtimesMissing(['vcredist', 'vcredist'], deps())).toEqual([])
    registry = {}
    setVc(VC, '1', '15', '40')
    expect(await runtimesMissing(['vcredist'], deps())).toEqual([])
    setVc(VC, '0', '15', '40')
    expect(await runtimesMissing(['vcredist'], deps())).toEqual(['vcredist'])
  })

  it('detects DirectX 9 from both DLLs in SysWOW64', async () => {
    files.add(D3DX)
    expect(await runtimesMissing(['directx9'], deps())).toEqual(['directx9'])
    files.add(XINPUT)
    expect(await runtimesMissing(['directx9'], deps())).toEqual([])
  })
})

describe('ensureRuntimes', () => {
  it('does nothing when everything is installed', async () => {
    setVc(VC, '1', '14', '44')
    files.add(D3DX).add(XINPUT)
    expect(await ensureRuntimes(['vcredist', 'directx9'], deps())).toEqual([])
    expect(downloadFile).not.toHaveBeenCalled()
    expect(elevated).toEqual([])
  })

  it('installs the Visual C++ runtime elevated and deletes the installer', async () => {
    elevatedCode = () => {
      setVc(VC, '1', '14', '44')
      return 3010
    }
    expect(await ensureRuntimes(['vcredist'], deps())).toEqual([])
    expect(vi.mocked(downloadFile).mock.calls[0][0]).toEqual(VCREDIST_DOWNLOAD)
    expect(vi.mocked(downloadFile).mock.calls[0][1]).toBe(workDir)
    expect(elevated).toEqual([
      {
        file: join(workDir, 'vc_redist.x64.exe'),
        args: ['/install', '/passive', '/norestart'],
        script: undefined
      }
    ])
    expect(await fs.readdir(workDir)).toEqual([])
  })

  it('reports a declined, failed or ineffective Visual C++ install', async () => {
    elevatedCode = () => 1223
    expect((await ensureRuntimes(['vcredist'], deps()))[0]).toMatch(
      /^Visual C\+\+ runtime install was declined; /
    )
    elevatedCode = () => 1603
    expect(await ensureRuntimes(['vcredist'], deps())).toEqual([
      'The Visual C++ runtime install failed (code 1603).'
    ])
    elevatedCode = () => 0
    expect((await ensureRuntimes(['vcredist'], deps()))[0]).toMatch(/still looks missing/)
  })

  it('turns a download failure into a notice', async () => {
    vi.mocked(downloadFile).mockRejectedValueOnce(new Error('offline'))
    expect(await ensureRuntimes(['vcredist'], deps())).toEqual([
      'The Visual C++ runtime could not be installed: offline'
    ])
  })

  it('extracts and installs DirectX in one elevated PowerShell script', async () => {
    elevatedCode = () => {
      files.add(D3DX).add(XINPUT)
      return 0
    }
    expect(await ensureRuntimes(['directx9'], deps())).toEqual([])
    expect(vi.mocked(downloadFile).mock.calls[0][0]).toEqual(DIRECTX_DOWNLOAD)
    expect(elevated).toHaveLength(1)
    expect(elevated[0].file).toBe('powershell.exe')
    expect(elevated[0].args).toContain('-File')
    const redist = join(workDir, 'directx_Jun2010_redist.exe')
    const extract = join(workDir, 'directx')
    expect(elevated[0].script).toBe('\ufeff' + directxScript(redist, extract))
    expect(elevated[0].script).toContain(`'/Q /T:${extract}'`)
    expect(elevated[0].script).toContain(
      `'${join(extract, 'DXSETUP.exe')}' -ArgumentList '/silent'`
    )
    expect(await fs.readdir(workDir)).toEqual([])
  })

  it('quotes an extract folder with spaces and rejects an incomplete DirectX download', async () => {
    expect(directxScript('C:\\a b\\dx.exe', 'C:\\a b\\directx')).toContain(
      `-FilePath 'C:\\a b\\dx.exe' -ArgumentList '/Q /T:"C:\\a b\\directx"'`
    )
    vi.mocked(downloadFile).mockImplementationOnce(async (d, dir) => {
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(join(dir, d.fileName), 'short')
      return join(dir, d.fileName)
    })
    expect(await ensureRuntimes(['directx9'], deps())).toEqual([
      'The DirectX 9 runtime download was incomplete (5 of 100275120 bytes).'
    ])
    expect(elevated).toEqual([])
    expect(await fs.readdir(workDir)).toEqual([])
  })

  it('reports a declined DirectX install', async () => {
    elevatedCode = () => 1223
    expect((await ensureRuntimes(['directx9'], deps()))[0]).toMatch(
      /^DirectX 9 runtime install was declined; /
    )
  })
})
