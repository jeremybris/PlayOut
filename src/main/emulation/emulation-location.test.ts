import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  documentsEmulationDir,
  forbiddenKindOf,
  forbiddenKindOfSync,
  forbiddenRoots,
  isSameOrInside,
  targetForPick
} from './emulation-location'
import { ensureDefaultEmulationDir, setDocumentsOnFirstStart } from './emulation-dir'
import type { Settings, SettingsPatch } from '../../shared/types'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-loc-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const silent = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
}

describe('where the Emulation folder may be', () => {
  const roots = forbiddenRoots({
    exeDir: 'C:\\Users\\Me\\Games\\PlayOut',
    localAppData: 'C:\\Users\\Me\\AppData\\Local',
    userData: 'C:\\Users\\Me\\AppData\\Roaming\\playout'
  })

  it('names the install folder, the old default install folder and the data folder', () => {
    expect(roots.map((r) => r.kind)).toEqual(['install', 'install', 'data'])
    expect(roots[1]!.path.toLowerCase()).toBe('c:\\users\\me\\appdata\\local\\programs\\playout')
  })

  it('refuses them and anything inside them, whatever the letter case or trailing separators', () => {
    expect(forbiddenKindOfSync('c:\\users\\me\\games\\playout\\', roots)).toBe('install')
    expect(forbiddenKindOfSync('C:/Users/Me/Games/PlayOut/Data/Emulation', roots)).toBe('install')
    expect(forbiddenKindOfSync('C:\\Users\\Me\\AppData\\Roaming\\PLAYOUT\\Emulation', roots)).toBe(
      'data'
    )
    expect(
      forbiddenKindOfSync('C:\\Users\\Me\\AppData\\Local\\Programs\\PlayOut\\Emulation', roots)
    ).toBe('install')
  })

  it('allows folders beside them', () => {
    expect(forbiddenKindOfSync('C:\\Users\\Me\\Games\\PlayOut2\\Emulation', roots)).toBeNull()
    expect(forbiddenKindOfSync('C:\\Users\\Me\\Documents\\Emulation', roots)).toBeNull()
    expect(forbiddenKindOfSync('D:\\Emulation', roots)).toBeNull()
  })

  it('isSameOrInside ignores case, slashes and trailing separators', () => {
    expect(isSameOrInside('D:\\Games\\', 'd:/games/emulation')).toBe(true)
    expect(isSameOrInside('D:\\Games', 'D:\\Games2')).toBe(false)
    expect(isSameOrInside('D:\\', 'D:\\Emulation')).toBe(true)
  })

  it('sees through a junction into the install folder', async () => {
    const install = join(dir, 'PlayOut')
    await fs.mkdir(join(install, 'Data'), { recursive: true })
    const link = join(dir, 'Shortcut')
    await fs.symlink(install, link, 'junction')
    const real = forbiddenRoots({ exeDir: install, userData: join(dir, 'appdata') })
    expect(forbiddenKindOfSync(join(link, 'Data', 'Emulation'), real)).toBeNull()
    expect(await forbiddenKindOf(join(link, 'Data', 'Emulation'), real)).toBe('install')
    expect(await forbiddenKindOf(join(dir, 'Elsewhere', 'Emulation'), real)).toBeNull()
  })
})

describe('the folder a pick names', () => {
  it('generate: an Emulation folder inside the pick, unless the pick is one', async () => {
    expect(await targetForPick('generate', join(dir, 'Games'))).toBe(
      join(dir, 'Games', 'Emulation')
    )
    expect(await targetForPick('generate', join(dir, 'emulation'))).toBe(join(dir, 'emulation'))
  })

  it('choose: an empty folder or one laid out like an Emulation folder is used itself', async () => {
    await fs.mkdir(join(dir, 'Empty'))
    await fs.mkdir(join(dir, 'Emu', 'roms'), { recursive: true })
    expect(await targetForPick('choose', join(dir, 'Empty'))).toBe(join(dir, 'Empty'))
    expect(await targetForPick('choose', join(dir, 'Emu'))).toBe(join(dir, 'Emu'))
  })

  it('choose: a folder of other things gets an Emulation folder inside it', async () => {
    await fs.mkdir(join(dir, 'Documents'))
    await fs.writeFile(join(dir, 'Documents', 'letter.txt'), 'x')
    expect(await targetForPick('choose', join(dir, 'Documents'))).toBe(
      join(dir, 'Documents', 'Emulation')
    )
  })
})

describe('the default Emulation folder: Documents\\Emulation on a new install only', () => {
  function settingsWith(emulationDir: string | null): {
    get(): Settings
    update(patch: SettingsPatch): void
  } {
    let s = { library: { emulationDir, romsRoot: null } } as unknown as Settings
    return {
      get: () => s,
      update(patch: SettingsPatch) {
        s = { ...s, library: { ...s.library, ...patch.library } } as Settings
      }
    }
  }

  it('a new install names Documents\\Emulation and it is made with every folder', async () => {
    const documents = join(dir, 'Documents')
    const settings = settingsWith(null)
    const def = documentsEmulationDir(documents)
    expect(setDocumentsOnFirstStart({ firstStart: true, settings, documentsDefault: def })).toBe(
      true
    )
    expect(settings.get().library.emulationDir).toBe(def)
    await ensureDefaultEmulationDir({
      settings,
      userData: join(dir, 'appdata'),
      systemIds: ['snes'],
      log: silent,
      documentsDefault: def
    })
    for (const sub of ['roms\\snes', 'bios', 'saves'])
      expect((await fs.stat(join(def, sub))).isDirectory()).toBe(true)
    // Nothing was made in the data folder.
    await expect(fs.stat(join(dir, 'appdata', 'Emulation'))).rejects.toThrow()
  })

  it('an existing install keeps its folder (never moved silently)', () => {
    const def = documentsEmulationDir(join(dir, 'Documents'))
    const legacy = settingsWith(null)
    expect(
      setDocumentsOnFirstStart({ firstStart: false, settings: legacy, documentsDefault: def })
    ).toBe(false)
    expect(legacy.get().library.emulationDir).toBeNull()
    const chosen = settingsWith('D:\\Emulation')
    expect(
      setDocumentsOnFirstStart({ firstStart: true, settings: chosen, documentsDefault: def })
    ).toBe(false)
    expect(chosen.get().library.emulationDir).toBe('D:\\Emulation')
  })

  it('a chosen folder that is missing (a drive not plugged in) is not made', async () => {
    const settings = settingsWith(join(dir, 'Unplugged', 'Emulation'))
    await ensureDefaultEmulationDir({
      settings,
      userData: join(dir, 'appdata'),
      systemIds: ['snes'],
      log: silent,
      documentsDefault: documentsEmulationDir(join(dir, 'Documents'))
    })
    await expect(fs.stat(join(dir, 'Unplugged'))).rejects.toThrow()
  })
})
