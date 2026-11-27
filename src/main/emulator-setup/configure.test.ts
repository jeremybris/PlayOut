import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile
} from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMULATOR_CATALOG } from './catalog'
import { addModel2RomDir, CONFIGURABLE_IDS, configureEmulator, localizeRpcs3Vfs } from './configure'
import { isJunction } from './junction'
import { activePs3HddDir, ensurePs3Hdd, PS3_HDD_IN_USE_MARKER } from '../emulation/ps3-hdd'
import type { ConfigureContext, Runner } from './types'

let dir: string
let D: string
let D2: string
const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
/** A runner that never starts anything (MAME's -createconfig "fails"). */
const failingRun: Runner = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'no' }))

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'playout-configure-'))
  D = join(dir, 'Data', 'Emulation')
  D2 = join(dir, 'Second Drive', 'Emu2')
  vi.clearAllMocks()
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function ctxFor(id: string, dataDir = D, run: Runner = failingRun): ConfigureContext {
  const folder = EMULATOR_CATALOG.find((s) => s.id === id)!.folder
  return { emuDir: join(dir, 'Emulation', folder), dataDir, run, log }
}

const norm = (p: string): string => resolve(p.replace(/^\\\\\?\\/, '')).toLowerCase()
async function expectLink(linkPath: string, target: string): Promise<void> {
  expect(await isJunction(linkPath), linkPath).toBe(true)
  expect(norm(await readlink(linkPath))).toBe(norm(target))
  expect((await stat(target)).isDirectory()).toBe(true)
}
const text = (p: string): Promise<string> => readFile(p, 'utf8')
const fwd = (p: string): string => p.replace(/\\/g, '/')

/** Every file (not junction contents) under E, with contents, to compare two runs. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isSymbolicLink()) out[p] = `-> ${norm(await readlink(p))}`
      else if (e.isDirectory()) await walk(p)
      else out[p] = await text(p)
    }
  }
  await walk(root)
  return out
}

describe('configureEmulator', () => {
  it('knows every catalog emulator and rejects unknown ids', async () => {
    expect([...CONFIGURABLE_IDS].sort()).toEqual(EMULATOR_CATALOG.map((s) => s.id).sort())
    await expect(configureEmulator('NOPE', ctxFor('MAME'))).rejects.toThrow(/NOPE/)
  })

  it.each(EMULATOR_CATALOG.map((s) => s.id))(
    '%s is idempotent and follows a new data folder',
    async (id) => {
      const ctx = ctxFor(id)
      await configureEmulator(id, ctx)
      const first = await snapshot(ctx.emuDir)
      await configureEmulator(id, ctx)
      expect(await snapshot(ctx.emuDir)).toEqual(first)

      await configureEmulator(id, ctxFor(id, D2))
      const moved = await snapshot(ctx.emuDir)
      const serialized = JSON.stringify(moved).toLowerCase()
      const old = (p: string): boolean =>
        serialized.includes(JSON.stringify(p).slice(1, -1).toLowerCase()) ||
        serialized.includes(fwd(p).toLowerCase())
      expect(old(D)).toBe(false)
      if (Object.keys(first).length > 0) {
        expect(old(D2)).toBe(true)
      }
    }
  )

  it('DuckStation and PCSX2: portable.txt and junctions only', async () => {
    for (const [id, states] of [
      ['DUCKSTATION', 'savestates'],
      ['PCSX2', 'sstates']
    ] as const) {
      const ctx = ctxFor(id)
      await configureEmulator(id, ctx)
      const E = ctx.emuDir
      const emu = id.toLowerCase()
      expect(await text(join(E, 'portable.txt'))).toBe('')
      await expectLink(join(E, 'bios'), join(D, 'bios'))
      await expectLink(join(E, 'memcards'), join(D, 'saves', emu, 'saves'))
      await expectLink(join(E, states), join(D, 'saves', emu, 'states'))
      await expectLink(join(E, 'textures'), join(D, 'texturepacks', emu))
      expect(await readdir(E).then((n) => n.filter((x) => x.endsWith('.ini')))).toEqual([])
    }
  })

  it('RPCS3: vfs.yml paths and save junctions inside D', async () => {
    const ctx = ctxFor('RPCS3')
    const vfs = join(ctx.emuDir, 'config', 'vfs.yml')
    await mkdir(join(ctx.emuDir, 'config'), { recursive: true })
    await writeFile(
      vfs,
      '$(EmulatorDir): ""\n/dev_hdd0/: $(EmulatorDir)dev_hdd0/\n/dev_flash/: x\n'
    )
    // PlayOut's earlier dev_hdd0 (EmuDeck's place, storage\rpcs3) holds a real savedata folder and an update.
    const old = join(D, 'storage', 'rpcs3', 'dev_hdd0')
    await mkdir(join(old, 'home', '00000001', 'savedata'), { recursive: true })
    await writeFile(join(old, 'home', '00000001', 'savedata', 'BLUS1.sav'), 's')
    await mkdir(join(old, 'game', 'BLUS30443'), { recursive: true })
    await writeFile(join(old, 'game', 'BLUS30443', 'PARAM.SFO'), 'u')
    const hdd0 = join(D, 'Updates and DLC', 'PS3', 'dev_hdd0')
    const user = join(hdd0, 'home', '00000001')
    await configureEmulator('RPCS3', ctx)
    expect(await text(vfs)).toBe(
      `$(EmulatorDir): ""\n/dev_hdd0/: ${fwd(hdd0)}/\n/dev_flash/: x\n` +
        `/games/: ${fwd(join(D, 'roms', 'ps3'))}/\n`
    )
    await expectLink(join(user, 'savedata'), join(D, 'saves', 'rpcs3', 'saves'))
    await expectLink(join(user, 'trophy'), join(D, 'saves', 'rpcs3', 'trophy'))
    await expectLink(join(ctx.emuDir, 'savestates'), join(D, 'saves', 'rpcs3', 'states'))
    expect(await text(join(D, 'saves', 'rpcs3', 'saves', 'BLUS1.sav'))).toBe('s')
    expect(await text(join(hdd0, 'game', 'BLUS30443', 'PARAM.SFO'))).toBe('u')
    expect(await readdir(join(D, 'storage', 'rpcs3'))).not.toContain('dev_hdd0')
    expect(await readdir(ctx.emuDir)).not.toContain('portable')
  })

  it('RPCS3: a dev_hdd0 next to rpcs3.exe moves into D before vfs.yml leaves it, losing nothing', async () => {
    const ctx = ctxFor('RPCS3')
    const local = join(ctx.emuDir, 'dev_hdd0')
    await mkdir(join(local, 'game', 'BLUS1', 'USRDIR'), { recursive: true })
    await writeFile(join(local, 'game', 'BLUS1', 'USRDIR', 'EBOOT.BIN'), 'eboot')
    await mkdir(join(local, 'home', '00000001', 'savedata', 'BLUS1-SAVE'), { recursive: true })
    await writeFile(join(local, 'home', '00000001', 'savedata', 'BLUS1-SAVE', 'DATA'), 'new')
    await writeFile(join(local, 'home', '00000001', 'localusername'), 'Me')
    // D already holds one of those files: D's copy wins, the other is kept aside.
    const hdd0 = join(D, 'Updates and DLC', 'PS3', 'dev_hdd0')
    await mkdir(join(hdd0, 'home', '00000001'), { recursive: true })
    await writeFile(join(hdd0, 'home', '00000001', 'localusername'), 'Already')
    await configureEmulator('RPCS3', ctx)
    expect(await text(join(hdd0, 'game', 'BLUS1', 'USRDIR', 'EBOOT.BIN'))).toBe('eboot')
    expect(await text(join(hdd0, 'home', '00000001', 'localusername'))).toBe('Already')
    // Saves end up in the save folder the savedata junction points at.
    expect(await text(join(D, 'saves', 'rpcs3', 'saves', 'BLUS1-SAVE', 'DATA'))).toBe('new')
    await expectLink(join(hdd0, 'home', '00000001', 'savedata'), join(D, 'saves', 'rpcs3', 'saves'))
    const entries = await readdir(ctx.emuDir)
    expect(entries).not.toContain('dev_hdd0')
    expect(
      await text(join(ctx.emuDir, 'dev_hdd0.playout-old', 'home', '00000001', 'localusername'))
    ).toBe('Me')
    // Without leftovers the folder is simply gone.
    await mkdir(join(local, 'game', 'BLUS2'), { recursive: true })
    await writeFile(join(local, 'game', 'BLUS2', 'PARAM.SFO'), 'p')
    await configureEmulator('RPCS3', ctx)
    expect(await text(join(hdd0, 'game', 'BLUS2', 'PARAM.SFO'))).toBe('p')
    expect(await readdir(ctx.emuDir)).not.toContain('dev_hdd0')
  })

  it.each([
    ['missing', false],
    ['made at start-up', true]
  ])(
    'RPCS3: the PS3 HDD in roms (before 0.1.120) moves to Updates and DLC\\PS3 (new place %s) and vfs.yml points there',
    async (_case, madeAtStartUp) => {
      const ctx = ctxFor('RPCS3')
      if (madeAtStartUp) await ensurePs3Hdd(D)
      const vfs = join(ctx.emuDir, 'config', 'vfs.yml')
      await mkdir(join(ctx.emuDir, 'config'), { recursive: true })
      const oldHdd0 = join(D, 'roms', 'PS3 HDD', 'dev_hdd0')
      await writeFile(vfs, `$(EmulatorDir): ""\n/dev_hdd0/: ${fwd(oldHdd0)}/\n`)
      await mkdir(join(oldHdd0, 'game', 'BLUS30443', 'USRDIR'), { recursive: true })
      await writeFile(join(oldHdd0, 'game', 'BLUS30443', 'USRDIR', 'EBOOT.BIN'), 'update')
      await mkdir(join(oldHdd0, 'home', '00000001', 'exdata'), { recursive: true })
      await writeFile(join(oldHdd0, 'home', '00000001', 'exdata', 'UP0001-BLUS30443_00-X.rap'), 'k')
      // The savedata junction the earlier configure made: moved along (whole rename) or dropped and made again by
      // link() (merge); either way the new place's savedata points at the saves.
      const saves = join(D, 'saves', 'rpcs3', 'saves')
      await mkdir(saves, { recursive: true })
      await writeFile(join(saves, 'BLUS1.sav'), 's')
      await symlink(saves, join(oldHdd0, 'home', '00000001', 'savedata'), 'junction')
      await configureEmulator('RPCS3', ctx)
      const hdd0 = join(D, 'Updates and DLC', 'PS3', 'dev_hdd0')
      expect(await text(join(hdd0, 'game', 'BLUS30443', 'USRDIR', 'EBOOT.BIN'))).toBe('update')
      expect(
        await text(join(hdd0, 'home', '00000001', 'exdata', 'UP0001-BLUS30443_00-X.rap'))
      ).toBe('k')
      await expectLink(join(hdd0, 'home', '00000001', 'savedata'), saves)
      expect(await text(join(hdd0, 'home', '00000001', 'savedata', 'BLUS1.sav'))).toBe('s')
      expect(await readdir(join(D, 'roms'))).not.toContain('PS3 HDD')
      expect(await readdir(join(D, 'roms'))).not.toContain('PS3 HDD.playout-old')
      expect(await readdir(join(D, 'Updates and DLC'))).toEqual(
        expect.arrayContaining(['PS3', 'Switch', 'Xbox360'])
      )
      expect(await text(vfs)).toContain(`/dev_hdd0/: ${fwd(hdd0)}/\n`)
      expect(await text(vfs)).not.toContain('PS3 HDD')
      await expectLink(
        join(hdd0, 'home', '00000001', 'trophy'),
        join(D, 'saves', 'rpcs3', 'trophy')
      )
      // RPCS3 now uses the new place: PlayOut's streaming follows it (activePs3HddDir).
      expect(await readdir(join(D, 'Updates and DLC', 'PS3'))).toContain(PS3_HDD_IN_USE_MARKER)
      expect(await activePs3HddDir(D)).toBe(join(D, 'Updates and DLC', 'PS3'))
    }
  )

  /** RPCS3 with vfs.yml on the old PS3 HDD (roms\PS3 HDD\dev_hdd0), which holds two games' updates. */
  async function withOldPs3Hdd(): Promise<{ ctx: ConfigureContext; vfs: string; oldHdd0: string }> {
    const ctx = ctxFor('RPCS3')
    const vfs = join(ctx.emuDir, 'config', 'vfs.yml')
    await mkdir(join(ctx.emuDir, 'config'), { recursive: true })
    const oldHdd0 = join(D, 'roms', 'PS3 HDD', 'dev_hdd0')
    await writeFile(vfs, `$(EmulatorDir): ""\n/dev_hdd0/: ${fwd(oldHdd0)}/\n`)
    for (const serial of ['BLUS30443', 'BLUS30444']) {
      await mkdir(join(oldHdd0, 'game', serial), { recursive: true })
      await writeFile(join(oldHdd0, 'game', serial, 'EBOOT.BIN'), serial)
    }
    await ensurePs3Hdd(D)
    return { ctx, vfs, oldHdd0 }
  }

  it('RPCS3: a partial PS3 HDD move throws (to run again), still pointing vfs.yml at the new place with the marker', async () => {
    const { ctx, vfs, oldHdd0 } = await withOldPs3Hdd()
    const { promises } = await import('fs')
    const realRename = promises.rename.bind(promises)
    const held = (p: string): boolean =>
      p === join(oldHdd0, 'game', 'BLUS30443') ||
      p === join(oldHdd0, 'game', 'BLUS30443', 'EBOOT.BIN')
    const spy = vi.spyOn(promises, 'rename').mockImplementation(async (a, b) => {
      if (held(String(a))) throw Object.assign(new Error('held open'), { code: 'EIO' })
      return realRename(a, b)
    })
    try {
      await expect(configureEmulator('RPCS3', ctx)).rejects.toThrow(/not fully moved/)
    } finally {
      spy.mockRestore()
    }
    const hdd0 = join(D, 'Updates and DLC', 'PS3', 'dev_hdd0')
    expect(await text(join(hdd0, 'game', 'BLUS30444', 'EBOOT.BIN'))).toBe('BLUS30444')
    expect(await text(join(oldHdd0, 'game', 'BLUS30443', 'EBOOT.BIN'))).toBe('BLUS30443')
    expect(await text(vfs)).toContain(`/dev_hdd0/: ${fwd(hdd0)}/\n`)
    expect(await readdir(join(D, 'Updates and DLC', 'PS3'))).toContain(PS3_HDD_IN_USE_MARKER)
    await expectLink(join(hdd0, 'home', '00000001', 'savedata'), join(D, 'saves', 'rpcs3', 'saves'))
    // The next start moves the rest.
    await configureEmulator('RPCS3', ctx)
    expect(await text(join(hdd0, 'game', 'BLUS30443', 'EBOOT.BIN'))).toBe('BLUS30443')
    expect(await readdir(join(D, 'roms'))).not.toContain('PS3 HDD')
  })

  it('RPCS3: without room on the new drive, the PS3 HDD stays in roms, vfs.yml and the junctions with it, and it throws', async () => {
    const { ctx, vfs, oldHdd0 } = await withOldPs3Hdd()
    const oldHdd = join(D, 'roms', 'PS3 HDD')
    const { promises } = await import('fs')
    const realRealpath = promises.realpath.bind(promises) as (p: string) => Promise<string>
    const realpathSpy = vi
      .spyOn(promises, 'realpath')
      .mockImplementation((async (p: string) =>
        String(p) === oldHdd ? 'Z:\\Emulation\\roms\\PS3 HDD' : realRealpath(p)) as never)
    const statfsSpy = vi
      .spyOn(promises, 'statfs')
      .mockImplementation((async () => ({ bavail: 1, bsize: 4096 })) as never)
    try {
      await expect(configureEmulator('RPCS3', ctx)).rejects.toThrow(/not fully moved.*does not fit/)
    } finally {
      realpathSpy.mockRestore()
      statfsSpy.mockRestore()
    }
    expect(await text(join(oldHdd0, 'game', 'BLUS30443', 'EBOOT.BIN'))).toBe('BLUS30443')
    const hdd0 = join(D, 'Updates and DLC', 'PS3', 'dev_hdd0')
    expect(await readdir(join(hdd0, 'game'))).toEqual([])
    expect(await text(vfs)).toContain(`/dev_hdd0/: ${fwd(oldHdd0)}/\n`)
    expect(await readdir(join(D, 'Updates and DLC', 'PS3'))).not.toContain(PS3_HDD_IN_USE_MARKER)
    expect(await activePs3HddDir(D)).toBe(oldHdd)
    await expectLink(
      join(oldHdd0, 'home', '00000001', 'savedata'),
      join(D, 'saves', 'rpcs3', 'saves')
    )
    await expectLink(
      join(oldHdd0, 'home', '00000001', 'trophy'),
      join(D, 'saves', 'rpcs3', 'trophy')
    )
  })

  it('RPCS3: a move that fails before it begins keeps RPCS3 on the old dev_hdd0 (no marker) and throws', async () => {
    const { ctx, vfs, oldHdd0 } = await withOldPs3Hdd()
    // Updates and DLC cannot be made: a file stands where the folder goes.
    await rm(join(D, 'Updates and DLC'), { recursive: true, force: true })
    await writeFile(join(D, 'Updates and DLC'), 'not a folder')
    await expect(configureEmulator('RPCS3', ctx)).rejects.toThrow()
    expect(await text(join(oldHdd0, 'game', 'BLUS30443', 'EBOOT.BIN'))).toBe('BLUS30443')
    expect(await text(vfs)).toContain(`/dev_hdd0/: ${fwd(oldHdd0)}/
`)
    expect(await activePs3HddDir(D)).toBe(join(D, 'roms', 'PS3 HDD'))
  })

  it("RPCS3: localizeRpcs3Vfs resets the other PC's absolute folder paths, keeping the rest", async () => {
    const ctx = ctxFor('RPCS3')
    const vfs = join(ctx.emuDir, 'config', 'vfs.yml')
    await mkdir(join(ctx.emuDir, 'config'), { recursive: true })
    const here = fwd(join(dir, 'exists'))
    await mkdir(here)
    await writeFile(
      vfs,
      '$(EmulatorDir): ""\n' +
        '/dev_hdd0/: Z:/Other PC/RPCS3/dev_hdd0/\n' +
        "/dev_flash/: 'Q:/Other PC/RPCS3/dev_flash/'\n" +
        `/dev_flash2/: ${here}/\n` +
        '/dev_flash3: x\n' +
        '/dev_bdvd/: ""\n' +
        '/dev_hdd1/: $(EmulatorDir)dev_hdd1/\n' +
        '/dev_usb***/:\n  /dev_usb000/: Q:/x/\n'
    )
    await localizeRpcs3Vfs(ctx.emuDir, log)
    expect(await text(vfs)).toBe(
      '$(EmulatorDir): ""\n' +
        '/dev_hdd0/: Z:/Other PC/RPCS3/dev_hdd0/\n' +
        '/dev_flash/: $(EmulatorDir)dev_flash/\n' +
        `/dev_flash2/: ${here}/\n` +
        '/dev_flash3: x\n' +
        '/dev_bdvd/: ""\n' +
        '/dev_hdd1/: $(EmulatorDir)dev_hdd1/\n' +
        '/dev_usb***/:\n  /dev_usb000/: Q:/x/\n'
    )
    // configure then points dev_hdd0 and the games at D.
    await configureEmulator('RPCS3', ctx)
    expect(await text(vfs)).toContain(
      `/dev_hdd0/: ${fwd(join(D, 'Updates and DLC', 'PS3', 'dev_hdd0'))}/\n`
    )
    expect(await text(vfs)).toContain('/dev_flash/: $(EmulatorDir)dev_flash/\n')
    // No vfs.yml: nothing happens.
    await localizeRpcs3Vfs(join(dir, 'nowhere'), log)
  })

  it('Dolphin: portable.txt, [General] paths kept with other settings, junctions', async () => {
    const ctx = ctxFor('DOLPHIN')
    const ini = join(ctx.emuDir, 'User', 'Config', 'Dolphin.ini')
    await mkdir(join(ctx.emuDir, 'User', 'Config'), { recursive: true })
    await writeFile(ini, '[General]\r\nISOPaths = 0\r\n[Interface]\r\nTheme = Clean\r\n')
    // A real GC folder from an earlier run moves into D.
    await mkdir(join(ctx.emuDir, 'User', 'GC', 'USA'), { recursive: true })
    await writeFile(join(ctx.emuDir, 'User', 'GC', 'USA', 'IPL.bin'), 'ipl')
    await configureEmulator('DOLPHIN', ctx)
    expect(await text(join(ctx.emuDir, 'portable.txt'))).toBe('')
    expect(await text(ini)).toBe(
      `[General]\r\nISOPaths = 2\r\nISOPath0 = ${join(D, 'roms', 'gc')}\r\nISOPath1 = ${join(D, 'roms', 'wii')}\r\n` +
        'RecursiveISOPaths = True\r\n[Interface]\r\nTheme = Clean\r\n'
    )
    await expectLink(join(ctx.emuDir, 'User', 'GC'), join(D, 'saves', 'dolphin', 'GC'))
    await expectLink(join(ctx.emuDir, 'User', 'Wii'), join(D, 'saves', 'dolphin', 'Wii'))
    await expectLink(join(ctx.emuDir, 'User', 'StateSaves'), join(D, 'saves', 'dolphin', 'states'))
    await expectLink(
      join(ctx.emuDir, 'User', 'Load', 'Textures'),
      join(D, 'texturepacks', 'dolphin')
    )
    expect(await text(join(D, 'saves', 'dolphin', 'GC', 'USA', 'IPL.bin'))).toBe('ipl')
  })

  it('PPSSPP: CurrentDirectory with forward slashes, memstick junctions, no installed.txt', async () => {
    const ctx = ctxFor('PPSSPP')
    await configureEmulator('PPSSPP', ctx)
    const psp = join(ctx.emuDir, 'memstick', 'PSP')
    expect(await text(join(psp, 'SYSTEM', 'ppsspp.ini'))).toBe(
      `[General]\r\nCurrentDirectory = ${fwd(join(D, 'roms', 'psp'))}\r\n`
    )
    await expectLink(join(psp, 'SAVEDATA'), join(D, 'saves', 'ppsspp', 'saves'))
    await expectLink(join(psp, 'PPSSPP_STATE'), join(D, 'saves', 'ppsspp', 'states'))
    await expectLink(join(psp, 'TEXTURES'), join(D, 'texturepacks', 'ppsspp'))
    expect(await readdir(ctx.emuDir)).not.toContain('installed.txt')
  })

  it('Flycast: emu.cfg [config] paths', async () => {
    const ctx = ctxFor('FLYCAST')
    await configureEmulator('FLYCAST', ctx)
    const b = join(D, 'bios')
    expect(await text(join(ctx.emuDir, 'emu.cfg'))).toBe(
      `[config]\r\nDreamcast.BiosPath = ${b};${join(b, 'dc')}\r\n` +
        `Dreamcast.VMUPath = ${join(D, 'saves', 'flycast', 'saves')}\r\n` +
        `Dreamcast.SavePath = ${join(D, 'saves', 'flycast', 'saves')}\r\n` +
        `Dreamcast.SavestatePath = ${join(D, 'saves', 'flycast', 'states')}\r\n` +
        `Dreamcast.TexturePath = ${join(D, 'texturepacks', 'flycast')}\r\n`
    )
  })

  it('Azahar: user\\ junctions', async () => {
    const ctx = ctxFor('AZAHAR')
    await configureEmulator('AZAHAR', ctx)
    const u = join(ctx.emuDir, 'user')
    await expectLink(join(u, 'sysdata'), join(D, 'bios', 'azahar', 'keys'))
    await expectLink(join(u, 'sdmc'), join(D, 'saves', 'azahar', 'saves'))
    await expectLink(join(u, 'states'), join(D, 'saves', 'azahar', 'states'))
    await expectLink(join(u, 'load'), join(D, 'texturepacks', 'azahar'))
  })

  it('melonDS: toml tables with forward slashes, no portable folder', async () => {
    const ctx = ctxFor('MELONDS')
    await configureEmulator('MELONDS', ctx)
    const f = fwd(D)
    expect(await text(join(ctx.emuDir, 'melonDS.toml'))).toBe(
      `[Instance0]\nSaveFilePath = "${f}/saves/melonds/saves"\nSavestatePath = "${f}/saves/melonds/states"\n` +
        `CheatFilePath = "${f}/storage/melonDS/cheats"\n\n` +
        `[DS]\nBIOS9Path = "${f}/bios/bios9.bin"\nBIOS7Path = "${f}/bios/bios7.bin"\n` +
        `FirmwarePath = "${f}/bios/firmware.bin"\n\n` +
        `[DSi]\nBIOS9Path = "${f}/bios/dsi_bios9.bin"\nBIOS7Path = "${f}/bios/dsi_bios7.bin"\n` +
        `FirmwarePath = "${f}/bios/dsi_firmware.bin"\nNANDPath = "${f}/bios/dsi_nand.bin"\n`
    )
    expect(await readdir(ctx.emuDir)).toEqual(['melonDS.toml'])
    expect((await stat(join(D, 'saves', 'melonds', 'saves'))).isDirectory()).toBe(true)
  })

  it('mGBA: keeps a shipped portable.ini and writes tight [ports.qt] keys', async () => {
    const ctx = ctxFor('MGBA')
    await mkdir(ctx.emuDir, { recursive: true })
    await writeFile(join(ctx.emuDir, 'portable.ini'), '; shipped')
    await configureEmulator('MGBA', ctx)
    expect(await text(join(ctx.emuDir, 'portable.ini'))).toBe('; shipped')
    expect(await text(join(ctx.emuDir, 'config.ini'))).toBe(
      `[ports.qt]\r\nsavegamePath=${join(D, 'saves', 'mgba', 'saves')}\r\n` +
        `savestatePath=${join(D, 'saves', 'mgba', 'states')}\r\ncheatsPath=${join(D, 'storage', 'mgba', 'cheats')}\r\n` +
        `patchPath=${join(D, 'storage', 'mgba', 'patches')}\r\n`
    )
  })

  it('Ryujinx: portable junctions, real system folder, no Config.json', async () => {
    const ctx = ctxFor('RYUJINX')
    await configureEmulator('RYUJINX', ctx)
    const p = join(ctx.emuDir, 'portable')
    await expectLink(join(p, 'bis', 'user', 'save'), join(D, 'saves', 'ryujinx', 'saves'))
    await expectLink(join(p, 'bis', 'system', 'save'), join(D, 'saves', 'ryujinx', 'system_saves'))
    await expectLink(join(p, 'bis', 'user', 'saveMeta'), join(D, 'saves', 'ryujinx', 'saveMeta'))
    await expectLink(join(p, 'mods'), join(D, 'texturepacks', 'ryujinx'))
    expect(await isJunction(join(p, 'system'))).toBe(false)
    expect((await stat(join(p, 'system'))).isDirectory()).toBe(true)
    expect(await readdir(p)).not.toContain('Config.json')
  })

  it.each(['DUCKSTATION', 'PCSX2', 'DOLPHIN'])(
    '%s: no portable marker when a junction cannot be made',
    async (id) => {
      const ctx = ctxFor(id)
      const first = id === 'DOLPHIN' ? join(ctx.emuDir, 'User', 'GC') : join(ctx.emuDir, 'bios')
      await mkdir(dirname(first), { recursive: true })
      await writeFile(first, 'in the way')
      await expect(configureEmulator(id, ctx)).rejects.toThrow(/file is in the way/)
      expect(await readdir(ctx.emuDir)).not.toContain('portable.txt')
    }
  )

  it('Model 2: keeps the shipped EMULATOR.INI and adds Dir1 under [RomDirs]', async () => {
    const ctx = ctxFor('M2EMULATOR')
    await mkdir(ctx.emuDir, { recursive: true })
    const ini = join(ctx.emuDir, 'EMULATOR.INI')
    await writeFile(
      ini,
      '[RomDirs]\r\n;Dir1=c:\\Model2\\roms\r\n\r\n[Renderer]\r\nFullScreenWidth=640\r\n'
    )
    await configureEmulator('M2EMULATOR', ctx)
    expect(await text(ini)).toBe(
      `[RomDirs]\r\n;Dir1=c:\\Model2\\roms\r\nDir1=${join(D, 'roms', 'model2')}\r\n\r\n[Renderer]\r\nFullScreenWidth=640\r\n`
    )
    await expectLink(join(ctx.emuDir, 'roms'), join(D, 'roms', 'model2'))
    await expectLink(join(ctx.emuDir, 'NVDATA'), join(D, 'saves', 'model2', 'saves'))
    await expectLink(join(ctx.emuDir, 'STATES'), join(D, 'saves', 'model2', 'states'))
  })

  it('Model 2: moves the shipped roms folder into D and leaves Dir1 alone for a non-ASCII path', async () => {
    const DJ = join(dir, 'José', 'Emulation')
    const ctx = ctxFor('M2EMULATOR', DJ)
    await mkdir(join(ctx.emuDir, 'roms'), { recursive: true })
    await writeFile(join(ctx.emuDir, 'roms', 'daytona.zip'), 'z')
    const ini = join(ctx.emuDir, 'EMULATOR.INI')
    const shipped =
      '[RomDirs]\r\n;Dir1=c:\\Model2\\roms\r\n\r\n[Renderer]\r\nFullScreenWidth=640\r\n'
    await writeFile(ini, shipped)
    await configureEmulator('M2EMULATOR', ctx)
    expect(await text(ini)).toBe(shipped)
    await expectLink(join(ctx.emuDir, 'roms'), join(DJ, 'roms', 'model2'))
    expect(await text(join(DJ, 'roms', 'model2', 'daytona.zip'))).toBe('z')
    expect(log.info).toHaveBeenCalledWith(expect.stringMatching(/not pure ASCII/))
  })

  it('Model 2: points Dir2 at the folder of a game sorted into a sub-folder, Dir1 untouched', async () => {
    const ctx = ctxFor('M2EMULATOR')
    await mkdir(ctx.emuDir, { recursive: true })
    const ini = join(ctx.emuDir, 'EMULATOR.INI')
    await writeFile(
      ini,
      `[RomDirs]\r\nDir1=C:\\E\\roms\\model2\r\n\r\n[Renderer]\r\nFullScreenWidth=640\r\n`
    )
    const warn = vi.fn()
    await addModel2RomDir(ctx.emuDir, 'C:\\E\\roms\\model2\\Favorites 1', { info: vi.fn(), warn })
    await addModel2RomDir(ctx.emuDir, 'C:\\E\\roms\\model2\\Favorites 2', { info: vi.fn(), warn })
    expect(await text(ini)).toBe(
      `[RomDirs]\r\nDir1=C:\\E\\roms\\model2\r\nDir2=C:\\E\\roms\\model2\\Favorites 2\r\n\r\n[Renderer]\r\nFullScreenWidth=640\r\n`
    )
    await addModel2RomDir(ctx.emuDir, 'C:\\José\\model2\\Sub', { info: vi.fn(), warn })
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/not pure ASCII/))
    expect(await text(ini)).toContain('Dir2=C:\\E\\roms\\model2\\Favorites 2\r\n')
    // A missing EMULATOR.INI is never created as a stub.
    const other = join(ctx.emuDir, 'none')
    await mkdir(other, { recursive: true })
    await addModel2RomDir(other, 'C:\\E\\roms\\model2\\Sub', { info: vi.fn(), warn })
    await expect(text(join(other, 'EMULATOR.INI'))).rejects.toThrow()
  })

  it('ScummVM: tight [scummvm] keys', async () => {
    const ctx = ctxFor('SCUMMVM')
    await configureEmulator('SCUMMVM', ctx)
    expect(await text(join(ctx.emuDir, 'scummvm.ini'))).toBe(
      `[scummvm]\r\nsavepath=${join(D, 'saves', 'scummvm', 'saves')}\r\nextrapath=${join(D, 'bios')}\r\n`
    )
  })

  it('MAME: runs -createconfig when mame.ini is missing, sets the paths and deletes mame.sym', async () => {
    const ctx = ctxFor('MAME')
    const E = ctx.emuDir
    await mkdir(E, { recursive: true })
    await writeFile(join(E, 'mame.sym'), 'symbols')
    const run: Runner = vi.fn(async (_file, _args, opts) => {
      await writeFile(
        join(opts!.cwd!, 'mame.ini'),
        '#\r\n# CORE SEARCH PATH OPTIONS\r\n#\r\nhomepath                  .\r\nrompath                   roms\r\n' +
          'inipath                   .;ini;ini/presets\r\n\r\n#\r\n# CORE OUTPUT DIRECTORY OPTIONS\r\n#\r\n' +
          'nvram_directory           nvram\r\nstate_directory           sta\r\nwindow                    0\r\n'
      )
      return { code: 0, stdout: '', stderr: '' }
    })
    await configureEmulator('MAME', { ...ctx, run })
    expect(run).toHaveBeenCalledWith(join(E, 'mame.exe'), ['-createconfig'], {
      cwd: E,
      timeoutMs: 60000
    })
    const ini = await text(join(E, 'mame.ini'))
    const p = (...x: string[]): string => join(D, ...x)
    expect(ini).toContain(
      `rompath                   ${p('roms', 'arcade')};${p('roms', 'mame')};${p('bios')};${p('bios', 'mame')};roms\r\n`
    )
    expect(ini).toContain(
      `inipath                   .;${p('storage', 'mame', 'ini')};ini;ini\\presets\r\n`
    )
    expect(ini).toContain(`nvram_directory           ${p('saves', 'mame', 'saves')}\r\n`)
    expect(ini).toContain(
      `state_directory           ${p('saves', 'mame', 'states')}\r\nwindow                    0\r\n`
    )
    expect(ini).toContain(
      `samplepath                ${p('storage', 'mame', 'samples')};samples\r\n`
    )
    expect(ini.startsWith('#\r\n# CORE SEARCH PATH OPTIONS')).toBe(true)
    expect(await readdir(E)).not.toContain('mame.sym')

    // mame.ini exists now: no second -createconfig.
    await configureEmulator('MAME', { ...ctx, run })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('MAME: a failing -createconfig still yields a mame.ini, and a throwing runner is tolerated', async () => {
    const ctx = ctxFor(
      'MAME',
      D,
      vi.fn(async () => Promise.reject(new Error('ENOENT')))
    )
    await configureEmulator('MAME', ctx)
    expect(await text(join(ctx.emuDir, 'mame.ini'))).toContain('rompath ')
    expect(log.warn).toHaveBeenCalled()
  })

  it('MAME: quotes paths containing #', async () => {
    const hashD = join(dir, 'C#', 'Emulation')
    const ctx = ctxFor('MAME', hashD)
    await configureEmulator('MAME', ctx)
    expect(await text(join(ctx.emuDir, 'mame.ini'))).toContain(
      `nvram_directory           "${join(hashD, 'saves', 'mame', 'saves')}"`
    )
  })

  it('RetroArch: double-quoted directory keys, other lines kept', async () => {
    const ctx = ctxFor('RETROARCH')
    await mkdir(ctx.emuDir, { recursive: true })
    await writeFile(
      join(ctx.emuDir, 'retroarch.cfg'),
      'video_driver = "glcore"\nsystem_directory = "default"\n'
    )
    await configureEmulator('RETROARCH', ctx)
    expect(await text(join(ctx.emuDir, 'retroarch.cfg'))).toBe(
      `video_driver = "glcore"\nsystem_directory = "${join(D, 'bios')}"\n` +
        `savefile_directory = "${join(D, 'saves', 'retroarch', 'saves')}"\n` +
        `savestate_directory = "${join(D, 'saves', 'retroarch', 'states')}"\n` +
        `rgui_browser_directory = "${join(D, 'roms')}"\n`
    )
  })
})
