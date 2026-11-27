import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { romTarget } from './rom-transfer'
import {
  gameIdKindOf,
  isTextureFolderOf,
  isTexturePackTransferPath,
  TEXTURE_AREA,
  texturePackFiles,
  texturePacksDir
} from './texture-packs'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})
async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'playout-textures-'))
  dirs.push(dir)
  return dir
}
async function put(path: string, data = 'x'): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, data)
}

describe('texture pack folders', () => {
  it('match a folder named after the id, however it is written, never a longer id or a title', () => {
    const ids = ['SLUS-20777']
    for (const name of [
      'SLUS-20777',
      'SLUS_20777',
      'slus20777',
      'SLUS-20777 HD',
      'SLUS-20777 - God of War'
    ])
      expect(isTextureFolderOf(name, ids, 'serial'), name).toBe(true)
    for (const name of ['SLUS-207771', 'SLUS-20778', 'God of War', 'SLUS', 'XSLUS-20777'])
      expect(isTextureFolderOf(name, ids, 'serial'), name).toBe(false)
    // A short candidate never matches.
    expect(isTextureFolderOf('SLUS2', ['SLUS2'], 'serial')).toBe(false)
  })

  it('Dolphin: the GameID or its three-letter prefix exactly', () => {
    expect(isTextureFolderOf('GALE01', ['GALE01'], 'gamecube')).toBe(true)
    expect(isTextureFolderOf('GAL', ['GALE01'], 'gamecube')).toBe(true)
    expect(isTextureFolderOf('GALE01 HD Pack', ['GALE01'], 'gamecube')).toBe(true)
    expect(isTextureFolderOf('GA', ['GALE01'], 'gamecube')).toBe(false)
    expect(isTextureFolderOf('GALP01', ['GALE01'], 'gamecube')).toBe(false)
    expect(isTextureFolderOf('GAL', ['GAL'], 'gamecube')).toBe(false)
  })

  it('title ids: not followed by another hex digit', () => {
    expect(isTextureFolderOf('00040000000EE000', ['00040000000EE000'], '3ds')).toBe(true)
    expect(isTextureFolderOf('00040000000ee000 HD', ['00040000000EE000'], '3ds')).toBe(true)
    expect(isTextureFolderOf('00040000000EE000A', ['00040000000EE000'], '3ds')).toBe(false)
  })

  it('systems map to their emulator folders', () => {
    expect(gameIdKindOf('ps2')).toBe('serial')
    expect(gameIdKindOf('psx')).toBe('serial')
    expect(gameIdKindOf('psp')).toBe('serial')
    expect(gameIdKindOf('wii')).toBe('gamecube')
    expect(gameIdKindOf('n3ds')).toBe('3ds')
    expect(gameIdKindOf('dreamcast')).toBe('dreamcast')
    expect(gameIdKindOf('snes')).toBeNull()
  })
})

describe('texture pack paths on the wire', () => {
  it('take <emulator>/[parent/]<folder>/<file> of a known emulator only', () => {
    expect(isTexturePackTransferPath(['pcsx2', 'SLUS-20777', 'replacements', 'a.png'])).toBe(true)
    expect(isTexturePackTransferPath(['PCSX2', 'SLUS-20777', 'a.png'])).toBe(true)
    expect(isTexturePackTransferPath(['azahar', 'textures', '00040000000EE000', 'a.png'])).toBe(
      true
    )
    expect(isTexturePackTransferPath(['azahar', '00040000000EE000', 'a.png'])).toBe(false)
    expect(isTexturePackTransferPath(['pcsx2', 'SLUS-20777'])).toBe(false)
    expect(isTexturePackTransferPath(['pcsx2', 'a.png'])).toBe(false)
    expect(isTexturePackTransferPath(['unknown', 'SLUS-20777', 'a.png'])).toBe(false)
    expect(isTexturePackTransferPath([])).toBe(false)
  })

  it("land in this PC's texturepacks; anything else is refused", async () => {
    const emu = await tempDir()
    const areas = [
      { name: TEXTURE_AREA, dir: texturePacksDir(emu), allows: isTexturePackTransferPath }
    ]
    const roms = join(emu, 'roms')
    expect(romTarget(roms, 'Texture Packs/pcsx2/SLUS-20777/replacements/a.png', areas)).toBe(
      join(emu, 'texturepacks', 'pcsx2', 'SLUS-20777', 'replacements', 'a.png')
    )
    expect(romTarget(roms, 'texture packs/dolphin/GALE01/b.png', areas)).toBe(
      join(emu, 'texturepacks', 'dolphin', 'GALE01', 'b.png')
    )
    expect(romTarget(roms, 'Texture Packs/other/SLUS-20777/a.png', areas)).toBeNull()
    expect(romTarget(roms, 'Texture Packs/pcsx2/../../bios/x', areas)).toBeNull()
    expect(romTarget(roms, 'Texture Packs/pcsx2/a.png', areas)).toBeNull()
    // Without the area (an older PlayOut) the same path would be inside the ROM folder: the host never sends it then.
    expect(romTarget(roms, 'Texture Packs/pcsx2/SLUS-20777/a.png')).toBe(
      join(roms, 'Texture Packs', 'pcsx2', 'SLUS-20777', 'a.png')
    )
  })
})

describe('a game’s texture pack files', () => {
  it('lists every file of its folders in the emulators of its system, links not followed', async () => {
    const emu = await tempDir()
    const tex = texturePacksDir(emu)
    await put(join(tex, 'pcsx2', 'SLUS-20777', 'replacements', 'a.png'), 'aaa')
    await put(join(tex, 'pcsx2', 'SLUS-20777', 'replacements', 'deep', 'b.dds'), 'bb')
    await put(join(tex, 'pcsx2', 'SLUS_20777 HD', 'c.png'), 'c')
    await put(join(tex, 'pcsx2', 'SLUS-11111', 'other.png'))
    await put(join(tex, 'pcsx2', 'loose.png'))
    // Another emulator's folder with the same name: not the PS2's.
    await put(join(tex, 'duckstation', 'SLUS-20777', 'psx.png'))
    // A link inside a pack (and a linked pack) is skipped.
    const outside = join(emu, 'outside')
    await put(join(outside, 'secret.txt'))
    await fs.symlink(outside, join(tex, 'pcsx2', 'SLUS-20777', 'link'), 'junction')
    await fs.symlink(outside, join(tex, 'pcsx2', 'SLUS-20777 linked'), 'junction')

    const files = await texturePackFiles(tex, 'ps2', ['SLUS-20777'])
    expect(files.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'pcsx2/SLUS_20777 HD/c.png', size: 1 },
      { path: 'pcsx2/SLUS-20777/replacements/a.png', size: 3 },
      { path: 'pcsx2/SLUS-20777/replacements/deep/b.dds', size: 2 }
    ])
    expect(await texturePackFiles(tex, 'ps2', [])).toEqual([])
    expect(await texturePackFiles(tex, 'snes', ['SLUS-20777'])).toEqual([])
    expect(await texturePackFiles(join(emu, 'none'), 'ps2', ['SLUS-20777'])).toEqual([])
  })

  it('Dolphin by GameID and prefix; Azahar under textures', async () => {
    const emu = await tempDir()
    const tex = texturePacksDir(emu)
    await put(join(tex, 'dolphin', 'GALE01', 'a.png'))
    await put(join(tex, 'dolphin', 'GAL', 'b.png'))
    await put(join(tex, 'dolphin', 'GALP01', 'c.png'))
    await put(join(tex, 'azahar', 'textures', '00040000000EE000', 'd.png'))
    await put(join(tex, 'azahar', 'mods', '00040000000EE000', 'e.bin'))
    expect((await texturePackFiles(tex, 'gc', ['GALE01'])).map((f) => f.path).sort()).toEqual([
      'dolphin/GAL/b.png',
      'dolphin/GALE01/a.png'
    ])
    expect((await texturePackFiles(tex, 'n3ds', ['00040000000EE000'])).map((f) => f.path)).toEqual([
      'azahar/textures/00040000000EE000/d.png'
    ])
  })

  it("leaves the emulators' own dump folders at the top of a game's folder out", async () => {
    const emu = await tempDir()
    const tex = texturePacksDir(emu)
    await put(join(tex, 'pcsx2', 'SLUS-20777', 'replacements', 'a.png'))
    await put(join(tex, 'pcsx2', 'SLUS-20777', 'Dumps', 'dumped.png'))
    // Deeper down a folder of that name is part of the pack.
    await put(join(tex, 'pcsx2', 'SLUS-20777', 'replacements', 'dumps', 'kept.png'))
    await put(join(tex, 'duckstation', 'SLUS-00594', 'dumps', 'd.png'))
    await put(join(tex, 'duckstation', 'SLUS-00594', 'e.png'))
    await put(join(tex, 'ppsspp', 'ULUS10336', 'NEW', 'n.png'))
    await put(join(tex, 'ppsspp', 'ULUS10336', 'textures.ini'))
    // Another emulator's skip name means nothing here.
    await put(join(tex, 'ppsspp', 'ULUS10336', 'dumps', 'k.png'))
    const paths = async (system: string, id: string): Promise<string[]> =>
      (await texturePackFiles(tex, system, [id])).map((f) => f.path).sort()
    expect(await paths('ps2', 'SLUS-20777')).toEqual([
      'pcsx2/SLUS-20777/replacements/a.png',
      'pcsx2/SLUS-20777/replacements/dumps/kept.png'
    ])
    expect(await paths('psx', 'SLUS-00594')).toEqual(['duckstation/SLUS-00594/e.png'])
    expect(await paths('psp', 'ULUS-10336')).toEqual([
      'ppsspp/ULUS10336/dumps/k.png',
      'ppsspp/ULUS10336/textures.ini'
    ])
  })
})
