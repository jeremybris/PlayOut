import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EMULATION_FOLDERS, EMUDECK_ROM_SYSTEMS } from './emulation-folders'
import { generateFolders, generatedFolderPath, generatedFolderPlan } from './generated-folders'
import { loadSystemCatalog } from './systems'

const systems = ['nes', 'snes', 'psx']
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'playout-generated-folders-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function isDir(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isDirectory() ?? false
}

describe('generatedFolderPlan', () => {
  it('gives the roms folder one folder per ES-DE system', () => {
    expect(generatedFolderPlan('roms', systems)).toEqual(['nes', 'snes', 'psx'])
  })

  it("gives the Emulation folder EmuDeck's top folders and their subfolders", () => {
    const plan = generatedFolderPlan('emulation', systems)
    const top = plan.filter((p) => !p.includes('\\') && !p.includes('/'))
    expect(top.sort()).toEqual(
      [
        'bios',
        'hdpacks',
        'Recompilations Saves',
        'roms',
        'saves',
        'storage',
        'texturepacks',
        'tools',
        'Updates and DLC'
      ].sort()
    )
    for (const sub of [
      'bios/Mupen64plus/cache',
      'saves/retroarch/saves',
      'saves/retroarch/states',
      'saves/dolphin/GC',
      'storage/downloaded_media',
      'storage/es-de/gamelists',
      'tools/launchers/esde',
      'roms/snes',
      'roms/ps4/shortcuts',
      'roms/xbox360/xbla',
      'Updates and DLC/Switch',
      'Updates and DLC/Xbox360',
      'Updates and DLC/PS3/dev_hdd0/game',
      'Updates and DLC/PS3/dev_hdd0/home/00000001'
    ])
      expect(plan).toContain(join(...sub.split('/')))
    expect(new Set(plan).size).toBe(plan.length)
  })

  it('gives roms every ES-DE system plus the extra ones of EmuDeck', () => {
    const plan = generatedFolderPlan('emulation', ['windows', 'snes'])
    expect(plan).toContain(join('roms', 'windows'))
    for (const id of EMUDECK_ROM_SYSTEMS) expect(plan).toContain(join('roms', id))
    expect(plan.filter((p) => p === join('roms', 'snes'))).toHaveLength(1)
  })

  it('lists every parent before its children and names folders plainly', () => {
    for (const path of EMULATION_FOLDERS) {
      const parent = path.split('/').slice(0, -1).join('/')
      if (parent) expect(EMULATION_FOLDERS.indexOf(parent)).toBeGreaterThanOrEqual(0)
      expect(path).toMatch(/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/)
    }
  })

  it("covers every system of PlayOut's ES-DE catalog", () => {
    const catalog = loadSystemCatalog(join(__dirname, '../../../resources/systems/systems.json'))
    const ids = catalog.systems.map((s) => s.id)
    expect(generatedFolderPlan('roms', ids)).toHaveLength(ids.length)
    const plan = generatedFolderPlan('emulation', ids)
    for (const id of ids) expect(plan).toContain(join('roms', id))
    expect(plan).toContain(join('roms', 'switch2'))
    expect(plan).toContain(join('roms', 'ps5'))
  })
})

describe('generatedFolderPath', () => {
  it('makes a roms / Emulation folder in the picked folder, or uses a picked folder already named so', () => {
    expect(generatedFolderPath('roms', join('D:', 'Games'))).toBe(join('D:', 'Games', 'roms'))
    expect(generatedFolderPath('roms', join('D:', 'Games', 'ROMS'))).toBe(
      join('D:', 'Games', 'ROMS')
    )
    expect(generatedFolderPath('emulation', join('D:', 'Games'))).toBe(
      join('D:', 'Games', 'Emulation')
    )
    expect(generatedFolderPath('emulation', join('D:', 'emulation'))).toBe(join('D:', 'emulation'))
  })
})

describe('generateFolders', () => {
  it('creates the roms folder and its system folders', async () => {
    const result = await generateFolders('roms', dir, systems)
    expect(result).toEqual({ path: join(dir, 'roms'), created: 4, existing: 0 })
    expect((await readdir(join(dir, 'roms'))).sort()).toEqual(['nes', 'psx', 'snes'])
  })

  it('creates the Emulation folder structure', async () => {
    const result = await generateFolders('emulation', dir, systems)
    const root = join(dir, 'Emulation')
    expect(result.path).toBe(root)
    expect(result.created).toBe(1 + generatedFolderPlan('emulation', systems).length)
    expect((await readdir(root)).sort()).toEqual(
      [
        'bios',
        'hdpacks',
        'Recompilations Saves',
        'roms',
        'saves',
        'storage',
        'texturepacks',
        'tools',
        'Updates and DLC'
      ].sort()
    )
    expect(await isDir(join(root, 'saves', 'retroarch', 'states'))).toBe(true)
    expect(await isDir(join(root, 'roms', 'psx'))).toBe(true)
    expect((await readdir(join(root, 'Updates and DLC'))).sort()).toEqual(
      ['PS3', 'Switch', 'Xbox360'].sort()
    )
    expect(await isDir(join(root, 'Updates and DLC', 'PS3', 'dev_hdd0', 'game'))).toBe(true)
    expect(await isDir(join(root, 'roms', 'PS3 HDD'))).toBe(false)
  })

  it('keeps what is already there and only adds what is missing', async () => {
    await mkdir(join(dir, 'roms', 'snes'), { recursive: true })
    await writeFile(join(dir, 'roms', 'snes', 'game.sfc'), 'rom')
    const first = await generateFolders('roms', dir, systems)
    expect(first).toEqual({ path: join(dir, 'roms'), created: 2, existing: 2 })
    expect(await readFile(join(dir, 'roms', 'snes', 'game.sfc'), 'utf8')).toBe('rom')
    const again = await generateFolders('roms', dir, systems)
    expect(again).toEqual({ path: join(dir, 'roms'), created: 0, existing: 4 })
  })

  it('fails when a file is in the way', async () => {
    await mkdir(join(dir, 'roms'))
    await writeFile(join(dir, 'roms', 'nes'), 'not a folder')
    await expect(generateFolders('roms', dir, systems)).rejects.toThrow()
  })
})
