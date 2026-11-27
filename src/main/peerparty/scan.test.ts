import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import type { FsIo } from '../upgrades/anticheat'
import { fileContains, scanNetworkServices, SDK_SCAN_DEPTH, servicesOfFile } from './scan'

/** A fake folder tree: paths ("a/b/file.dll"); folders are implied. */
function fakeFs(root: string, files: string[], links: string[] = []): FsIo {
  return {
    async readdir(dir) {
      const rel = dir === root ? '' : dir.slice(root.length + 1).replace(/\\/g, '/') + '/'
      const names = new Map<string, boolean>()
      for (const f of [...files, ...links]) {
        if (!f.startsWith(rel)) continue
        const rest = f.slice(rel.length)
        const [head, ...more] = rest.split('/')
        names.set(head!, more.length > 0 || links.includes(f))
      }
      if (!names.size && rel) throw Object.assign(new Error('nope'), { code: 'ENOENT' })
      return [...names].map(([name, isDirectory]) => ({
        name,
        isDirectory,
        isLink: links.includes(rel + name)
      }))
    }
  }
}

const never = async (): Promise<boolean> => false

describe('servicesOfFile', () => {
  it('knows each service by its libraries', () => {
    expect(servicesOfFile('steam_api64.dll')).toEqual(['steamworks'])
    expect(servicesOfFile('EOSSDK-Win64-Shipping.dll')).toEqual(['eos'])
    expect(servicesOfFile('PlayFabMultiplayerWin.dll')).toEqual(['playfab'])
    expect(servicesOfFile('Galaxy64.dll')).toEqual(['galaxy'])
    expect(servicesOfFile('Fusion.Runtime.dll')).toEqual(['photon'])
    expect(servicesOfFile('Unity.Services.Lobbies.dll')).toEqual(['ugs'])
    expect(servicesOfFile('steam_api64.dll.bak')).toEqual([])
    expect(servicesOfFile('galaxy.exe')).toEqual([])
  })
})

describe('scanNetworkServices', () => {
  const root = 'D:\\G'
  it('finds libraries as deep as Unreal keeps them, and never follows links', async () => {
    const io = fakeFs(
      root,
      [
        'Engine/Binaries/ThirdParty/Steamworks/Steamv157/Win64/steam_api64.dll',
        'Engine/Binaries/ThirdParty/EOSSDK/Win64/EOSSDK-Win64-Shipping.dll',
        'Game.exe'
      ],
      ['Linked']
    )
    const r = await scanNetworkServices(
      { installDir: root, exe: null, source: 'epic' },
      io,
      undefined,
      never
    )
    expect(r).toEqual({ services: ['steamworks', 'eos'], complete: true })
    expect(SDK_SCAN_DEPTH).toBe(6)
  })

  it('does not open folders below the depth limit', async () => {
    const io = fakeFs(root, ['a/b/c/d/e/f/g/steam_api.dll'])
    const r = await scanNetworkServices(
      { installDir: root, exe: null, source: 'gog' },
      io,
      undefined,
      never
    )
    expect(r.services).toEqual([])
  })

  it('adds Demonware from the program and Xbox from the store', async () => {
    const io = fakeFs(root, ['Game.exe'])
    const r = await scanNetworkServices(
      { installDir: root, exe: 'D:\\G\\Game.exe', source: 'xbox' },
      io,
      undefined,
      async (_p, needle) => needle === 'demonware.net'
    )
    expect(r.services).toEqual(['demonware', 'xbox'])
  })
})

describe('fileContains', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const file = (data: Buffer): string => {
    const d = mkdtempSync(join(tmpdir(), 'playout-pp-scan-'))
    dirs.push(d)
    const p = join(d, 'game.exe')
    writeFileSync(p, data)
    return p
  }

  it('finds ASCII and UTF-16 text in any case, also across the 1 MiB piece border', async () => {
    const mib = 1024 * 1024
    const across = Buffer.alloc(mib + 64)
    across.write('DemonWare.NET', mib - 5, 'latin1')
    expect(await fileContains(file(across), 'demonware.net')).toBe(true)
    const wide = Buffer.alloc(mib + 64)
    wide.write('prod.DEMONWARE.net', mib - 11, 'utf16le')
    expect(await fileContains(file(wide), 'demonware.net')).toBe(true)
    expect(await fileContains(file(Buffer.from('demonware.ne')), 'demonware.net')).toBe(false)
  })

  it('skips files above the size limit', async () => {
    expect(await fileContains(file(Buffer.from('demonware.net')), 'demonware.net', 5)).toBe(false)
  })
})
