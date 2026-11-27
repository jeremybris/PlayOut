import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  writeFile
} from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activePs3HddDir,
  edatContentId,
  ensurePs3Hdd,
  isoTitleId,
  isPs3HddTransferPath,
  markPs3HddInUse,
  movePs3HddToUpdates,
  PS3_HDD_IN_USE_MARKER,
  ps3Dev0Dir,
  ps3HddDir,
  ps3HddFiles,
  ps3TitleIds,
  sfoTitleId
} from './ps3-hdd'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'playout-ps3-hdd-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A PARAM.SFO with these string entries (format 0x0204, utf8 with a trailing null). */
function sfo(entries: Record<string, string>): Buffer {
  const keys = Object.keys(entries)
  const keyTable = Buffer.from(keys.map((k) => `${k}\0`).join(''), 'latin1')
  const values = keys.map((k) => Buffer.from(`${entries[k]}\0`, 'latin1'))
  const indexSize = 16 * keys.length
  const keyStart = 20 + indexSize
  const dataStart = keyStart + keyTable.length
  const header = Buffer.alloc(20)
  header.writeUInt32BE(0x00505346, 0)
  header.writeUInt32LE(0x0101, 4)
  header.writeUInt32LE(keyStart, 8)
  header.writeUInt32LE(dataStart, 12)
  header.writeUInt32LE(keys.length, 16)
  const index = Buffer.alloc(indexSize)
  let keyOffset = 0
  let dataOffset = 0
  keys.forEach((k, i) => {
    index.writeUInt16LE(keyOffset, i * 16)
    index.writeUInt16LE(0x0204, i * 16 + 2)
    index.writeUInt32LE(values[i].length, i * 16 + 4)
    index.writeUInt32LE(values[i].length, i * 16 + 8)
    index.writeUInt32LE(dataOffset, i * 16 + 12)
    keyOffset += k.length + 1
    dataOffset += values[i].length
  })
  return Buffer.concat([header, index, keyTable, ...values])
}

/** An ISO 9660 image holding PS3_GAME/PARAM.SFO (and the PS3 disc header when `header` is given). */
function iso(param: Buffer | null, header?: string): Buffer {
  const S = 2048
  const img = Buffer.alloc(S * 24)
  if (header) {
    img.write('PlayStation3', S, 'latin1')
    img.write(header, S + 16, 'latin1')
  }
  const record = (
    at: number,
    name: string,
    lba: number,
    size: number,
    dirFlag: boolean
  ): number => {
    const nameBuf = Buffer.from(name, 'latin1')
    const len = 33 + nameBuf.length + (nameBuf.length % 2 === 0 ? 1 : 0)
    img[at] = len
    img.writeUInt32LE(lba, at + 2)
    img.writeUInt32LE(size, at + 10)
    img[at + 25] = dirFlag ? 2 : 0
    img[at + 32] = nameBuf.length
    nameBuf.copy(img, at + 33)
    return at + len
  }
  const pvd = 16 * S
  img[pvd] = 1
  img.write('CD001', pvd + 1, 'latin1')
  record(pvd + 156, '\0', 20, S, true)
  let at = record(20 * S, '\0', 20, S, true)
  at = record(at, '\x01', 20, S, true)
  record(at, 'PS3_GAME', 21, S, true)
  at = record(21 * S, '\0', 21, S, true)
  at = record(at, '\x01', 20, S, true)
  if (param) {
    record(at, 'PARAM.SFO;1', 22, param.length, false)
    param.copy(img, 22 * S)
  }
  return img
}

describe('sfoTitleId', () => {
  it('reads TITLE_ID among the other keys', () => {
    expect(sfoTitleId(sfo({ CATEGORY: 'DG', TITLE: 'A Game', TITLE_ID: 'BLUS30443' }))).toBe(
      'BLUS30443'
    )
    expect(sfoTitleId(sfo({ TITLE: 'No id' }))).toBeNull()
    expect(sfoTitleId(sfo({ TITLE_ID: 'not one' }))).toBeNull()
    expect(sfoTitleId(Buffer.from('not an sfo at all, just text'))).toBeNull()
    expect(sfoTitleId(sfo({ TITLE_ID: 'BLUS30443' }).subarray(0, 40))).toBeNull()
  })
})

describe('isoTitleId', () => {
  it("reads PS3_GAME/PARAM.SFO of a disc image, else the disc header's serial", async () => {
    const a = join(dir, 'a.iso')
    await writeFile(a, iso(sfo({ TITLE_ID: 'BLES01234' }), 'BLUS-99999'))
    expect(await isoTitleId(a)).toBe('BLES01234')
    const b = join(dir, 'b.iso')
    await writeFile(b, iso(null, 'BLUS-30443  '))
    expect(await isoTitleId(b)).toBe('BLUS30443')
    const c = join(dir, 'c.iso')
    await writeFile(c, Buffer.alloc(4096))
    expect(await isoTitleId(c)).toBeNull()
    expect(await isoTitleId(join(dir, 'missing.iso'))).toBeNull()
  })
})

describe('ps3TitleIds', () => {
  it('reads a game folder, a serial file, a disc image, else the name', async () => {
    const disc = join(dir, 'Disc Game.ps3')
    await mkdir(join(disc, 'PS3_GAME'), { recursive: true })
    await writeFile(join(disc, 'PS3_GAME', 'PARAM.SFO'), sfo({ TITLE_ID: 'BLUS30443' }))
    expect(await ps3TitleIds(disc)).toEqual(['BLUS30443'])

    const psn = join(dir, 'PSN Game')
    await mkdir(psn)
    await writeFile(join(psn, 'PARAM.SFO'), sfo({ TITLE_ID: 'NPUB30024' }))
    expect(await ps3TitleIds(psn)).toEqual(['NPUB30024'])

    // ES-DE's Game Serial layout, as a file and as a folder holding it.
    await writeFile(join(dir, 'Serial.ps3'), 'npeb00001\n')
    expect(await ps3TitleIds(join(dir, 'Serial.ps3'))).toEqual(['NPEB00001'])
    const layout = join(dir, 'Inner.ps3')
    await mkdir(layout)
    await writeFile(join(layout, 'Inner.ps3'), 'BCUS98174')
    expect(await ps3TitleIds(layout)).toEqual(['BCUS98174'])

    await writeFile(join(dir, 'Disc.iso'), iso(sfo({ TITLE_ID: 'BLJM60001' })))
    expect(await ps3TitleIds(join(dir, 'Disc.iso'))).toEqual(['BLJM60001'])

    // EBOOT.BIN of a disc folder: its PARAM.SFO is two folders up.
    await mkdir(join(disc, 'PS3_GAME', 'USRDIR'))
    await writeFile(join(disc, 'PS3_GAME', 'USRDIR', 'EBOOT.BIN'), 'x')
    expect(await ps3TitleIds(join(disc, 'PS3_GAME', 'USRDIR', 'EBOOT.BIN'))).toEqual(['BLUS30443'])

    // Nothing inside says it: the serial in the name, if any.
    await mkdir(join(dir, 'Some Game [BLES-01807]'))
    expect(await ps3TitleIds(join(dir, 'Some Game [BLES-01807]'))).toEqual(['BLES01807'])
    await mkdir(join(dir, 'Some Game'))
    expect(await ps3TitleIds(join(dir, 'Some Game'))).toEqual([])
    expect(await ps3TitleIds(join(dir, 'gone.iso'))).toEqual([])
  })

  it("reads an RPCS3 shortcut's serial", async () => {
    const lnk = join(dir, 'Game.lnk')
    await writeFile(lnk, 'x')
    const ids = await ps3TitleIds(lnk, async () => ({
      target: 'C:\\RPCS3\\rpcs3.exe',
      args: '--no-gui "%RPCS3_GAMEID%:BLUS31142"'
    }))
    expect(ids).toEqual(['BLUS31142'])
  })
})

describe('PS3 HDD folders', () => {
  it('lives in Emulation\\Updates and DLC\\PS3\\dev_hdd0 and is made when missing', async () => {
    expect(ps3HddDir(dir)).toBe(join(dir, 'Updates and DLC', 'PS3'))
    expect(ps3Dev0Dir(dir)).toBe(join(dir, 'Updates and DLC', 'PS3', 'dev_hdd0'))
    await ensurePs3Hdd(dir)
    await ensurePs3Hdd(dir)
    expect(await readdir(ps3Dev0Dir(dir))).toEqual(expect.arrayContaining(['game', 'home']))
    expect((await readdir(join(dir, 'Updates and DLC'))).sort()).toEqual(
      ['PS3', 'Switch', 'Xbox360'].sort()
    )
    await stat(join(ps3Dev0Dir(dir), 'home', '00000001'))
    expect(await readdir(dir)).toEqual(['Updates and DLC'])
  })
})

describe('movePs3HddToUpdates', () => {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never
  const oldHdd = (): string => join(dir, 'roms', 'PS3 HDD')

  it('moves the old folder whole when the new one is missing', async () => {
    const game = join(oldHdd(), 'dev_hdd0', 'game', 'BLUS30443', 'USRDIR')
    await mkdir(game, { recursive: true })
    await writeFile(join(game, 'EBOOT.BIN'), 'update')
    await writeFile(join(oldHdd(), 'dev_hdd0', 'note.txt'), 'note')
    expect(await movePs3HddToUpdates(dir, log)).toEqual({ outcome: 'moved' })
    expect(
      await readFile(join(ps3Dev0Dir(dir), 'game', 'BLUS30443', 'USRDIR', 'EBOOT.BIN'), 'utf8')
    ).toBe('update')
    expect(await readFile(join(ps3Dev0Dir(dir), 'note.txt'), 'utf8')).toBe('note')
    expect(await readdir(join(dir, 'roms'))).toEqual([])
  })

  it('merges into an existing new folder: a file already there wins, the old one is kept', async () => {
    const oldDev0 = join(oldHdd(), 'dev_hdd0')
    await mkdir(join(oldDev0, 'game', 'BLUS30443'), { recursive: true })
    await mkdir(join(oldDev0, 'game', 'BLUS30444'), { recursive: true })
    await writeFile(join(oldDev0, 'game', 'BLUS30443', 'PARAM.SFO'), 'old')
    await writeFile(join(oldDev0, 'game', 'BLUS30443', 'only-old.bin'), 'only old')
    await writeFile(join(oldDev0, 'game', 'BLUS30444', 'PARAM.SFO'), 'other')
    await ensurePs3Hdd(dir)
    await mkdir(join(ps3Dev0Dir(dir), 'game', 'BLUS30443'), { recursive: true })
    await writeFile(join(ps3Dev0Dir(dir), 'game', 'BLUS30443', 'PARAM.SFO'), 'new')
    expect(await movePs3HddToUpdates(dir, log)).toEqual({ outcome: 'moved' })
    const newGame = join(ps3Dev0Dir(dir), 'game')
    expect(await readFile(join(newGame, 'BLUS30443', 'PARAM.SFO'), 'utf8')).toBe('new')
    expect(await readFile(join(newGame, 'BLUS30443', 'only-old.bin'), 'utf8')).toBe('only old')
    expect(await readFile(join(newGame, 'BLUS30444', 'PARAM.SFO'), 'utf8')).toBe('other')
    const kept = join(dir, 'roms', 'PS3 HDD.playout-old')
    expect(await readFile(join(kept, 'dev_hdd0', 'game', 'BLUS30443', 'PARAM.SFO'), 'utf8')).toBe(
      'old'
    )
    expect(await readdir(join(dir, 'roms'))).toEqual(['PS3 HDD.playout-old'])
  })

  it('does nothing when there is no old folder', async () => {
    expect(await movePs3HddToUpdates(dir, log)).toEqual({ outcome: 'none' })
    expect(await readdir(dir)).toEqual([])
    await mkdir(join(dir, 'roms', 'ps3'), { recursive: true })
    expect(await movePs3HddToUpdates(dir, log)).toEqual({ outcome: 'none' })
    expect(await readdir(dir)).toEqual(['roms'])
    expect(await readdir(join(dir, 'roms'))).toEqual(['ps3'])
  })

  it('is partial when a file cannot be moved: it stays in the old folder, nothing is set aside', async () => {
    const oldGame = join(oldHdd(), 'dev_hdd0', 'game')
    await mkdir(join(oldGame, 'BLUS30443'), { recursive: true })
    await mkdir(join(oldGame, 'BLUS30444'), { recursive: true })
    await writeFile(join(oldGame, 'BLUS30443', 'EBOOT.BIN'), 'held')
    await writeFile(join(oldGame, 'BLUS30444', 'EBOOT.BIN'), 'free')
    await ensurePs3Hdd(dir)
    const { promises } = await import('fs')
    const realRename = promises.rename.bind(promises)
    const held = (p: string): boolean =>
      p === join(oldGame, 'BLUS30443') || p === join(oldGame, 'BLUS30443', 'EBOOT.BIN')
    const spy = vi.spyOn(promises, 'rename').mockImplementation(async (a, b) => {
      if (held(String(a))) throw Object.assign(new Error('held open'), { code: 'EIO' })
      return realRename(a, b)
    })
    let move
    try {
      move = await movePs3HddToUpdates(dir, log)
    } finally {
      spy.mockRestore()
    }
    expect(move).toEqual({ outcome: 'partial', message: expect.stringContaining(oldHdd()) })
    expect(await readFile(join(ps3Dev0Dir(dir), 'game', 'BLUS30444', 'EBOOT.BIN'), 'utf8')).toBe(
      'free'
    )
    expect(await readFile(join(oldGame, 'BLUS30443', 'EBOOT.BIN'), 'utf8')).toBe('held')
    expect(await readdir(join(dir, 'roms'))).toEqual(['PS3 HDD'])
  })

  /** Fakes the old folder being on drive Z: (realpath) and `freeBytes` free on the new place's drive (statfs). */
  async function otherVolume<T>(freeBytes: number, body: () => Promise<T>): Promise<T> {
    const { promises } = await import('fs')
    const realRealpath = promises.realpath.bind(promises) as (p: string) => Promise<string>
    const realpathSpy = vi
      .spyOn(promises, 'realpath')
      .mockImplementation((async (p: string) =>
        String(p) === oldHdd() ? 'Z:\\Emulation\\roms\\PS3 HDD' : realRealpath(p)) as never)
    const statfsSpy = vi
      .spyOn(promises, 'statfs')
      .mockImplementation((async () => ({ bavail: freeBytes / 4096, bsize: 4096 })) as never)
    try {
      return await body()
    } finally {
      realpathSpy.mockRestore()
      statfsSpy.mockRestore()
    }
  }

  it('moves nothing across drives when the new drive lacks room for it plus 1 GB', async () => {
    const game = join(oldHdd(), 'dev_hdd0', 'game', 'BLUS30443')
    await mkdir(game, { recursive: true })
    await writeFile(join(game, 'EBOOT.BIN'), Buffer.alloc(4096))
    await ensurePs3Hdd(dir)
    // 1 GB free: the 4 KB tree plus the 1 GB headroom does not fit.
    const move = await otherVolume(1024 ** 3, () => movePs3HddToUpdates(dir, log))
    expect(move).toEqual({ outcome: 'no-space', message: expect.stringMatching(/does not fit/) })
    expect(await readFile(join(game, 'EBOOT.BIN'))).toHaveLength(4096)
    expect(await readdir(join(ps3Dev0Dir(dir), 'game'))).toEqual([])
    expect(await readdir(join(dir, 'roms'))).toEqual(['PS3 HDD'])
  })

  it('moves across drives when the new drive has room', async () => {
    const game = join(oldHdd(), 'dev_hdd0', 'game', 'BLUS30443')
    await mkdir(game, { recursive: true })
    await writeFile(join(game, 'EBOOT.BIN'), 'update')
    const move = await otherVolume(2 * 1024 ** 3, () => movePs3HddToUpdates(dir, log))
    expect(move).toEqual({ outcome: 'moved' })
    expect(await readFile(join(ps3Dev0Dir(dir), 'game', 'BLUS30443', 'EBOOT.BIN'), 'utf8')).toBe(
      'update'
    )
  })

  it('moves a junction inside as a junction when the whole folder is renamed (new one missing)', async () => {
    const target = join(dir, 'saves', 'rpcs3', 'savedata')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'save.dat'), 'save')
    const user = join(oldHdd(), 'dev_hdd0', 'home', '00000001')
    await mkdir(user, { recursive: true })
    await symlink(target, join(user, 'savedata'), 'junction')
    expect(await movePs3HddToUpdates(dir, log)).toEqual({ outcome: 'moved' })
    const moved = join(ps3Dev0Dir(dir), 'home', '00000001', 'savedata')
    expect((await lstat(moved)).isSymbolicLink()).toBe(true)
    expect(resolve(await readlink(moved))).toBe(resolve(target))
    expect(await readFile(join(moved, 'save.dat'), 'utf8')).toBe('save')
    expect(await readFile(join(target, 'save.dat'), 'utf8')).toBe('save')
  })

  it('drops a junction inside when merging into an existing new folder, keeping its target', async () => {
    const target = join(dir, 'saves', 'rpcs3', 'savedata')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'save.dat'), 'save')
    const user = join(oldHdd(), 'dev_hdd0', 'home', '00000001')
    await mkdir(user, { recursive: true })
    await symlink(target, join(user, 'savedata'), 'junction')
    await writeFile(join(user, 'localusername'), 'Me')
    await ensurePs3Hdd(dir)
    expect(await movePs3HddToUpdates(dir, log)).toEqual({ outcome: 'moved' })
    const newUser = join(ps3Dev0Dir(dir), 'home', '00000001')
    expect(await readdir(newUser)).toEqual(['localusername'])
    expect(await readFile(join(newUser, 'localusername'), 'utf8')).toBe('Me')
    expect(await readFile(join(target, 'save.dat'), 'utf8')).toBe('save')
    expect(await readdir(join(dir, 'roms'))).toEqual([])
  })
})

describe('activePs3HddDir', () => {
  const oldHdd = (): string => join(dir, 'roms', 'PS3 HDD')
  const newHdd = (): string => join(dir, 'Updates and DLC', 'PS3')

  it('is the new folder when there is no old one', async () => {
    expect(await activePs3HddDir(dir)).toBe(newHdd())
    await ensurePs3Hdd(dir)
    expect(await activePs3HddDir(dir)).toBe(newHdd())
    // An old folder without dev_hdd0 does not count.
    await mkdir(oldHdd(), { recursive: true })
    expect(await activePs3HddDir(dir)).toBe(newHdd())
  })

  it('is the old folder while it holds dev_hdd0 and the marker is absent, even with games in the new one', async () => {
    await mkdir(join(oldHdd(), 'dev_hdd0', 'game', 'BLUS30443'), { recursive: true })
    expect(await activePs3HddDir(dir)).toBe(oldHdd())
    // Made at start-up: an empty new game folder.
    await ensurePs3Hdd(dir)
    expect(await activePs3HddDir(dir)).toBe(oldHdd())
    // Without the marker, what is in the new place does not matter.
    await mkdir(join(newHdd(), 'dev_hdd0', 'game', 'BLUS30444'), { recursive: true })
    expect(await activePs3HddDir(dir)).toBe(oldHdd())
  })

  it('is the new folder once the marker is there, even with an old one left', async () => {
    await mkdir(join(oldHdd(), 'dev_hdd0', 'game', 'BLUS30443'), { recursive: true })
    await markPs3HddInUse(dir)
    expect(await readdir(newHdd())).toContain(PS3_HDD_IN_USE_MARKER)
    expect(await activePs3HddDir(dir)).toBe(newHdd())
    await rm(join(newHdd(), PS3_HDD_IN_USE_MARKER))
    expect(await activePs3HddDir(dir)).toBe(oldHdd())
  })

  it('counts a junctioned old folder as moved', async () => {
    const elsewhere = join(dir, 'elsewhere')
    await mkdir(join(elsewhere, 'dev_hdd0', 'game', 'BLUS30443'), { recursive: true })
    await mkdir(join(dir, 'roms'), { recursive: true })
    await symlink(elsewhere, oldHdd(), 'junction')
    expect(await activePs3HddDir(dir)).toBe(newHdd())
  })
})

describe('ps3HddFiles', () => {
  it("lists a game's updates, DLC and licenses, and nothing of other games", async () => {
    const hdd = join(dir, 'PS3 HDD')
    const dev0 = join(hdd, 'dev_hdd0')
    await mkdir(join(dev0, 'game', 'BLUS30443', 'USRDIR', 'DLC'), { recursive: true })
    await writeFile(join(dev0, 'game', 'BLUS30443', 'PARAM.SFO'), 'sfo')
    await writeFile(join(dev0, 'game', 'BLUS30443', 'USRDIR', 'EBOOT.BIN'), 'update')
    await writeFile(join(dev0, 'game', 'BLUS30443', 'USRDIR', 'DLC', 'pack.edat'), 'dlc!')
    await mkdir(join(dev0, 'game', 'BLUS30444'), { recursive: true })
    await writeFile(join(dev0, 'game', 'BLUS30444', 'PARAM.SFO'), 'other')
    // The game's own data folder (named after its serial) goes too; a longer serial's does not.
    await mkdir(join(dev0, 'game', 'BLUS30443DATA'), { recursive: true })
    await writeFile(join(dev0, 'game', 'BLUS30443DATA', 'DATA.BIN'), 'data')
    // A copy PlayOut was making when it closed: not the game's.
    await mkdir(join(dev0, 'game', 'BLUS30443.playout-new'), { recursive: true })
    await writeFile(join(dev0, 'game', 'BLUS30443.playout-new', 'half'), 'h')
    await mkdir(join(dev0, 'game', 'BLUS304431'), { recursive: true })
    await writeFile(join(dev0, 'game', 'BLUS304431', 'PARAM.SFO'), 'not ours')
    await mkdir(join(dev0, 'home', '00000001', 'exdata'), { recursive: true })
    await writeFile(
      join(dev0, 'home', '00000001', 'exdata', 'UP0001-BLUS30443_00-DLCPACK0000001.rap'),
      'r'
    )
    await writeFile(
      join(dev0, 'home', '00000001', 'exdata', 'UP0001-BLUS30444_00-DLCPACK0000001.rap'),
      'o'
    )
    await mkdir(join(dev0, 'exdata'), { recursive: true })
    await writeFile(join(dev0, 'exdata', 'UP0001-BLUS30443_00-DLCPACK0000002.edat'), 'e')
    // savedata is a junction into the saves folder: never followed.
    const saves = join(dir, 'saves')
    await mkdir(join(saves, 'BLUS30443-SAVE'), { recursive: true })
    await writeFile(join(saves, 'BLUS30443-SAVE', 'DATA'), 'save')
    await symlink(saves, join(dev0, 'home', '00000001', 'savedata'), 'junction')
    await symlink(saves, join(dev0, 'game', 'BLUS30443', 'linked'), 'junction')

    const files = await ps3HddFiles(hdd, ['blus30443'])
    expect(files.map((f) => f.path).sort()).toEqual(
      [
        'dev_hdd0/exdata/UP0001-BLUS30443_00-DLCPACK0000002.edat',
        'dev_hdd0/game/BLUS30443/PARAM.SFO',
        'dev_hdd0/game/BLUS30443/USRDIR/DLC/pack.edat',
        'dev_hdd0/game/BLUS30443/USRDIR/EBOOT.BIN',
        'dev_hdd0/game/BLUS30443DATA/DATA.BIN',
        'dev_hdd0/home/00000001/exdata/UP0001-BLUS30443_00-DLCPACK0000001.rap'
      ].sort()
    )
    expect(files.find((f) => f.path.endsWith('pack.edat'))?.size).toBe(4)
    expect(await ps3HddFiles(hdd, [])).toEqual([])
    expect(await ps3HddFiles(hdd, ['../game'])).toEqual([])
    expect(await ps3HddFiles(join(dir, 'nowhere'), ['BLUS30443'])).toEqual([])
  })

  it("sends the licenses of the game's DLC filed under another serial (the content id its EDAT names)", async () => {
    const hdd = join(dir, 'Updates and DLC', 'PS3')
    const dev0 = join(hdd, 'dev_hdd0')
    // An EDAT's NPD header: "NPD\0", then the content id at 0x10 (0x30 bytes).
    const npd = (contentId: string): Buffer => {
      const b = Buffer.alloc(0x80)
      b.write('NPD\0', 0, 'latin1')
      b.write(contentId, 0x10, 'latin1')
      return b
    }
    const dlc = 'UP9000-NPUA80999_00-DLCMAPPACK000001'
    await mkdir(join(dev0, 'game', 'BCUS98176', 'USRDIR', 'DLC'), { recursive: true })
    await writeFile(join(dev0, 'game', 'BCUS98176', 'USRDIR', 'DLC', 'maps.edat'), npd(dlc))
    // Not an EDAT (no NPD header), and an EDAT with garbage where the id goes: no license from them.
    await writeFile(join(dev0, 'game', 'BCUS98176', 'USRDIR', 'other.edat'), 'not npd')
    await writeFile(join(dev0, 'game', 'BCUS98176', 'USRDIR', 'bad.edat'), npd('../../x'))
    const exdata = join(dev0, 'home', '00000001', 'exdata')
    await mkdir(exdata, { recursive: true })
    await writeFile(join(exdata, `${dlc}.rap`), 'license')
    await writeFile(join(exdata, 'UP9000-NPUA80998_00-DLCMAPPACK000001.rap'), 'another game')
    const paths = (await ps3HddFiles(hdd, ['BCUS98176'])).map((f) => f.path).sort()
    expect(paths).toContain(`dev_hdd0/home/00000001/exdata/${dlc}.rap`)
    expect(paths).not.toContain(
      'dev_hdd0/home/00000001/exdata/UP9000-NPUA80998_00-DLCMAPPACK000001.rap'
    )
    expect(await edatContentId(join(dev0, 'game', 'BCUS98176', 'USRDIR', 'DLC', 'maps.edat'))).toBe(
      dlc
    )
    expect(await edatContentId(join(dev0, 'game', 'BCUS98176', 'USRDIR', 'other.edat'))).toBeNull()
    expect(await edatContentId(join(dev0, 'game', 'BCUS98176', 'USRDIR', 'bad.edat'))).toBeNull()
  })
})

describe('isPs3HddTransferPath', () => {
  it("takes a game's folders and licenses only", () => {
    const ok = (p: string): boolean => isPs3HddTransferPath(p.split('/'))
    expect(ok('dev_hdd0/game/BLUS30443/USRDIR/EBOOT.BIN')).toBe(true)
    expect(ok('dev_hdd0/game/BLUS30443DATA/x')).toBe(true)
    expect(ok('dev_hdd0/exdata/UP0001-BLUS30443_00-X.rap')).toBe(true)
    expect(ok('dev_hdd0/home/00000001/exdata/UP0001-BLUS30443_00-X.rap')).toBe(true)
    expect(ok('dev_hdd0/home/00000001/savedata/BLUS30443-SAVE/DATA')).toBe(false)
    expect(ok('dev_hdd0/home/00000001/trophy/x')).toBe(false)
    expect(ok('dev_hdd0/game/BLUS30443')).toBe(false)
    expect(ok('dev_hdd0/exdata/sub/x.rap')).toBe(false)
    expect(ok('dev_flash/x')).toBe(false)
  })
})
