import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings, SettingsPatch } from '../../shared/types'
import { createEmulationMoveService, JOURNAL_FILE } from './emulation-move-service'
import { moveEmulationFolder, relinkTree } from './emulation-move'

// Regressions found by the 2026-11 verification of the Emulation folder move: a rename that could not go back, a
// PlayOut closed mid-move, links lost or made unreadable, merges deleting a different save, errors after the switch,
// and a move started while startup recovery ran.

vi.mock('../i18n', () => ({ tMain: (key: string) => key }))

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-move-regress-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(dir, { recursive: true, force: true })
})

const OLD = Date.UTC(2024, 0, 1) / 1000

/** Acts out another drive: the rename of the folder itself (named ...Old) fails as across volumes. */
const exdev = async (a: string, b: string): Promise<void> => {
  if (/Old[\\/]?$/.test(a)) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
  await fs.rename(a, b)
}

type TestSettings = {
  get(): Settings
  update(patch: SettingsPatch): void
  tryFlush: ReturnType<typeof vi.fn<() => Promise<boolean>>>
}
function settingsWith(emulationDir: string | null, saves = true): TestSettings {
  let s = { library: { emulationDir } } as unknown as Settings
  return {
    get: () => s,
    update(patch: SettingsPatch) {
      s = { ...s, library: { ...s.library, ...patch.library } } as Settings
    },
    tryFlush: vi.fn(async () => saves)
  }
}
const quiet = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
}
function service(
  settings: TestSettings,
  extra: Partial<Parameters<typeof createEmulationMoveService>[0]> = {}
): ReturnType<typeof createEmulationMoveService> {
  return createEmulationMoveService({
    settings,
    userData: join(dir, 'appdata'),
    documents: join(dir, 'Documents'),
    forbidden: () => [{ path: join(dir, 'appdata'), kind: 'data' }],
    busy: async () => null,
    emit: () => undefined,
    log: quiet,
    progressEveryMs: 0,
    ...extra
  })
}
const journalText = (): Promise<string> =>
  fs.readFile(join(dir, 'appdata', JOURNAL_FILE), 'utf8').catch(() => 'none')
const exists = (path: string): Promise<boolean> =>
  fs.lstat(path).then(
    () => true,
    () => false
  )
async function fill(root: string): Promise<void> {
  await fs.mkdir(join(root, 'saves'), { recursive: true })
  await fs.writeFile(join(root, 'saves', 'card.mcd'), 'MYSAVE')
}
const busyError = (): NodeJS.ErrnoException =>
  Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' })
const epermError = (): NodeJS.ErrnoException =>
  Object.assign(new Error('EPERM: operation not permitted, symlink'), { code: 'EPERM' })

describe('same drive (rename)', () => {
  it('the switch fails and the folder cannot be renamed back: the setting follows the files', async () => {
    const from = join(dir, 'Old', 'Emulation')
    const to = join(dir, 'New', 'Emulation')
    await fill(from)
    const settings = settingsWith(from)
    let busyCalls = 0
    const svc = service(settings, {
      rename: (a, b) => fs.rename(a, b),
      busy: async () => {
        if (++busyCalls === 1) return null // the plan
        // A game started in the race and wrote its save at the old path (the rename back now fails).
        await fs.mkdir(join(from, 'saves'), { recursive: true })
        await fs.writeFile(join(from, 'saves', 'new.srm'), 'X')
        return 'busy.game'
      }
    })
    const result = await svc.start(to, 'move')
    expect(result).toEqual({ dir: to, moved: true, leftInOld: 1, keptOlder: 0 })
    expect(settings.get().library.emulationDir).toBe(to)
    expect(await fs.readFile(join(to, 'saves', 'card.mcd'), 'utf8')).toBe('MYSAVE')
    expect(await fs.readFile(join(from, 'saves', 'new.srm'), 'utf8')).toBe('X')
    expect(await journalText()).toBe('none')
  })

  it('settings.json cannot be written and the rename back fails: the files stay reachable', async () => {
    const from = join(dir, 'Old', 'Emulation')
    const to = join(dir, 'New', 'Emulation')
    await fill(from)
    const settings = settingsWith(from, false)
    let renames = 0
    const svc = service(settings, {
      rename: async (a, b) => {
        if (++renames === 2) throw busyError()
        await fs.rename(a, b)
      }
    })
    // The original cause is reported, the setting names where every file is, and the journal stays.
    await expect(svc.start(to, 'move')).rejects.toThrow('saveFailed')
    expect(settings.get().library.emulationDir).toBe(to)
    expect(await fs.readFile(join(to, 'saves', 'card.mcd'), 'utf8')).toBe('MYSAVE')
    expect(JSON.parse(await journalText()).phase).toBe('renamed')
  })

  it('PlayOut closed between the rename and the switch: the next start switches to the moved folder', async () => {
    const from = join(dir, 'Old', 'Emulation')
    const to = join(dir, 'New', 'Emulation')
    await fill(from)
    const settings = settingsWith(from)
    let busyCalls = 0
    let atCommit = ''
    const svc = service(settings, {
      rename: (a, b) => fs.rename(a, b),
      busy: async () => {
        if (++busyCalls === 2) {
          atCommit = await journalText()
          return new Promise<string | null>(() => undefined) // the process dies here
        }
        return null
      }
    })
    void svc.start(to, 'move')
    for (let i = 0; i < 200 && !atCommit; i++) await new Promise((r) => setTimeout(r, 10))
    expect(JSON.parse(atCommit)).toMatchObject({ from, to, phase: 'renamed' })
    const after = vi.fn(async () => undefined)
    const restarted = service(settings, { afterSwitch: after })
    await restarted.recover()
    expect(restarted.current()).toBe(to)
    expect(await fs.readFile(join(to, 'saves', 'card.mcd'), 'utf8')).toBe('MYSAVE')
    expect(after).toHaveBeenCalledWith(from, to)
    expect(await journalText()).toBe('none')
  })

  it('a file link into the folder stays a readable file link', async () => {
    const from = join(dir, 'Old')
    const to = join(dir, 'New', 'Emulation')
    await fs.mkdir(join(from, 'bios'), { recursive: true })
    await fs.mkdir(join(from, 'roms'), { recursive: true })
    await fs.writeFile(join(from, 'bios', 'scph1001.bin'), 'BIOSDATA')
    await fs.symlink(join(from, 'bios', 'scph1001.bin'), join(from, 'roms', 'scph1001.bin'), 'file')
    await moveEmulationFolder(from, to, { mode: 'move', commit: async () => {} })
    const link = join(to, 'roms', 'scph1001.bin')
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true)
    expect(await fs.readFile(link, 'utf8')).toBe('BIOSDATA')
    expect(await fs.readdir(join(to, 'roms'))).toEqual(['scph1001.bin'])
  })

  it('a link that cannot be pointed at the new place: never removed, and the move is put back', async () => {
    const from = join(dir, 'Old')
    const to = join(dir, 'New', 'Emulation')
    await fs.mkdir(join(from, 'bios'), { recursive: true })
    await fs.writeFile(join(from, 'bios', 'b.bin'), 'B')
    await fs.symlink(join(from, 'bios'), join(from, 'bios-link'), 'junction')
    vi.spyOn(fs, 'symlink').mockRejectedValue(epermError())
    const commit = vi.fn(async () => {})
    await expect(
      moveEmulationFolder(from, to, { mode: 'move', commit, warn: () => undefined })
    ).rejects.toThrow('could not be pointed')
    vi.restoreAllMocks()
    expect(commit).not.toHaveBeenCalled()
    expect(await exists(to)).toBe(false)
    expect((await fs.lstat(join(from, 'bios-link'))).isSymbolicLink()).toBe(true)
    expect(await fs.readFile(join(from, 'bios-link', 'b.bin'), 'utf8')).toBe('B')
  })
})

describe('links on another drive and in merges', () => {
  it('other drive: a link that cannot be made at the new place stays in the old folder', async () => {
    const from = join(dir, 'Old')
    const to = join(dir, 'New', 'Emulation')
    const ext = join(dir, 'ExternalSaves')
    await fs.mkdir(join(from, 'saves'), { recursive: true })
    await fs.mkdir(ext)
    await fs.writeFile(join(ext, 'game.srm'), 'SAVE')
    await fs.writeFile(join(from, 'saves', 'x.srm'), 'X')
    await fs.symlink(join(ext, 'game.srm'), join(from, 'saves', 'game.srm'), 'file')
    const real = fs.symlink.bind(fs)
    vi.spyOn(fs, 'symlink').mockImplementation(async (target, path, type) => {
      if (String(path).includes('playout-new')) throw epermError()
      return real(target, path, type)
    })
    const out = await moveEmulationFolder(from, to, {
      mode: 'move',
      commit: async () => {},
      rename: exdev,
      warn: () => undefined
    })
    vi.restoreAllMocks()
    expect(out.leftInOld).toBe(1)
    expect(await fs.readFile(join(from, 'saves', 'game.srm'), 'utf8')).toBe('SAVE')
    expect(await fs.readFile(join(to, 'saves', 'x.srm'), 'utf8')).toBe('X')
  })

  it('merge: an old link is kept when the new place has another entry of that name', async () => {
    const from = join(dir, 'Old')
    const to = join(dir, 'Target')
    const ext = join(dir, 'D_Saves')
    await fs.mkdir(ext, { recursive: true })
    await fs.writeFile(join(ext, 'only-here.sav'), 'PRECIOUS')
    await fs.mkdir(from)
    await fs.symlink(ext, join(from, 'saves'), 'junction')
    await fs.mkdir(join(to, 'saves'), { recursive: true })
    await fs.writeFile(join(to, 'saves', 'other.sav'), 'O')
    const out = await moveEmulationFolder(from, to, { mode: 'merge', commit: async () => {} })
    expect(out.leftInOld).toBe(1)
    expect(await fs.readFile(join(from, 'saves', 'only-here.sav'), 'utf8')).toBe('PRECIOUS')
  })

  it('merge: an old link that the new place already has (same target) goes', async () => {
    const from = join(dir, 'Old')
    const to = join(dir, 'Target')
    const ext = join(dir, 'D_Saves')
    await fs.mkdir(ext, { recursive: true })
    await fs.mkdir(from)
    await fs.mkdir(to)
    await fs.symlink(ext, join(from, 'saves'), 'junction')
    await fs.symlink(ext, join(to, 'saves'), 'junction')
    const out = await moveEmulationFolder(from, to, { mode: 'merge', commit: async () => {} })
    expect(out.leftInOld).toBe(0)
    expect(await exists(join(from, 'saves'))).toBe(false)
  })

  it('merge: an old link is kept when it cannot be made at the new place', async () => {
    const from = join(dir, 'Old')
    const to = join(dir, 'Target')
    const ext = join(dir, 'D_Saves')
    await fs.mkdir(ext)
    await fs.writeFile(join(ext, 'only-here.sav'), 'PRECIOUS')
    await fs.mkdir(from)
    await fs.symlink(ext, join(from, 'saves'), 'junction')
    await fs.mkdir(to)
    await fs.writeFile(join(to, 'marker'), 'm')
    const real = fs.symlink.bind(fs)
    vi.spyOn(fs, 'symlink').mockImplementation(async (target, path, type) => {
      if (String(path).startsWith(to)) throw epermError()
      return real(target, path, type)
    })
    const out = await moveEmulationFolder(from, to, {
      mode: 'merge',
      commit: async () => {},
      warn: () => undefined
    })
    vi.restoreAllMocks()
    expect(out.leftInOld).toBe(1)
    expect((await fs.lstat(join(from, 'saves'))).isSymbolicLink()).toBe(true)
  })
})

describe('merge files', () => {
  it('a different save of the same size within 2 s is not "the same file"', async () => {
    const from = join(dir, 'Old')
    const to = join(dir, 'D', 'Emulation')
    await fs.mkdir(join(from, 'saves', 'snes'), { recursive: true })
    await fs.mkdir(join(to, 'saves', 'snes'), { recursive: true })
    const T = Date.UTC(2025, 5, 1, 12, 0, 0) / 1000
    await fs.writeFile(join(from, 'saves', 'snes', 'Zelda.srm'), Buffer.alloc(8192, 0xaa))
    await fs.utimes(join(from, 'saves', 'snes', 'Zelda.srm'), T + 1.5, T + 1.5)
    await fs.writeFile(join(to, 'saves', 'snes', 'Zelda.srm'), Buffer.alloc(8192, 0x11))
    await fs.utimes(join(to, 'saves', 'snes', 'Zelda.srm'), T, T)
    const out = await moveEmulationFolder(from, to, { mode: 'merge', commit: async () => {} })
    expect(out.keptOlder).toBe(1)
    expect((await fs.readFile(join(to, 'saves', 'snes', 'Zelda.srm')))[0]).toBe(0xaa)
    expect((await fs.readFile(join(to, 'saves', 'snes', 'Zelda.srm.playout-old')))[0]).toBe(0x11)
  })

  it('the same bytes within 2 s still count as the same file', async () => {
    const from = join(dir, 'Old')
    const to = join(dir, 'D', 'Emulation')
    await fs.mkdir(join(from, 'saves'), { recursive: true })
    await fs.mkdir(join(to, 'saves'), { recursive: true })
    const T = Date.UTC(2025, 5, 1, 12, 0, 0) / 1000
    await fs.writeFile(join(from, 'saves', 'a.srm'), 'SAME')
    await fs.utimes(join(from, 'saves', 'a.srm'), T + 1, T + 1)
    await fs.writeFile(join(to, 'saves', 'a.srm'), 'SAME')
    await fs.utimes(join(to, 'saves', 'a.srm'), T, T)
    const out = await moveEmulationFolder(from, to, { mode: 'merge', commit: async () => {} })
    expect(out).toEqual({ renamed: false, leftInOld: 0, keptOlder: 0 })
    expect(await fs.readdir(join(to, 'saves'))).toEqual(['a.srm'])
  })

  it('undo: putting the older file back fails: the file stays under its own name', async () => {
    const from = join(dir, 'Old')
    const to = join(dir, 'Target')
    await fs.mkdir(join(from, 'saves'), { recursive: true })
    await fs.mkdir(join(to, 'saves'), { recursive: true })
    await fs.writeFile(join(to, 'saves', 'game.srm'), 'TARGETS-OWN')
    await fs.utimes(join(to, 'saves', 'game.srm'), 1000, 1000)
    await fs.writeFile(join(from, 'saves', 'game.srm'), 'NEWER')
    const rename = async (a: string, b: string): Promise<void> => {
      if (a.endsWith('.playout-old')) throw busyError()
      await fs.rename(a, b)
    }
    await expect(
      moveEmulationFolder(from, to, {
        mode: 'merge',
        rename,
        warn: () => undefined,
        commit: async () => {
          throw new Error('busy: a game started')
        }
      })
    ).rejects.toThrow('busy')
    expect((await fs.readdir(join(to, 'saves'))).sort()).toEqual([
      'game.srm',
      'game.srm.playout-old'
    ])
    expect(await fs.readFile(join(to, 'saves', 'game.srm.playout-old'), 'utf8')).toBe('TARGETS-OWN')
    expect(await fs.readFile(join(from, 'saves', 'game.srm'), 'utf8')).toBe('NEWER')
  })

  it('undo puts the older file back over the new copy', async () => {
    const from = join(dir, 'Old')
    const to = join(dir, 'Target')
    await fs.mkdir(join(from, 'saves'), { recursive: true })
    await fs.mkdir(join(to, 'saves'), { recursive: true })
    await fs.writeFile(join(to, 'saves', 'game.srm'), 'TARGETS-OWN')
    await fs.utimes(join(to, 'saves', 'game.srm'), 1000, 1000)
    await fs.writeFile(join(from, 'saves', 'game.srm'), 'NEWER')
    await expect(
      moveEmulationFolder(from, to, {
        mode: 'merge',
        commit: async () => {
          throw new Error('busy')
        }
      })
    ).rejects.toThrow('busy')
    expect(await fs.readdir(join(to, 'saves'))).toEqual(['game.srm'])
    expect(await fs.readFile(join(to, 'saves', 'game.srm'), 'utf8')).toBe('TARGETS-OWN')
  })
})

describe('recovery and errors after the switch', () => {
  it('a merge cut short while replacing a file puts the file back under its name', async () => {
    const from = join(dir, 'Old', 'Emulation')
    const to = join(dir, 'Target', 'Emulation')
    await fs.mkdir(join(from, 'saves'), { recursive: true })
    await fs.mkdir(join(to, 'saves'), { recursive: true })
    await fs.writeFile(join(from, 'saves', 'game.srm'), 'NEWER')
    await fs.writeFile(join(to, 'saves', 'game.srm.playout-old'), 'TARGETS-OWN')
    await fs.writeFile(join(to, 'saves', 'game.srm.playout-new'), 'NEWER')
    // An older merge's kept file (its own file stands beside it): left alone.
    await fs.writeFile(join(to, 'saves', 'kept.srm'), 'K2')
    await fs.writeFile(join(to, 'saves', 'kept.srm.playout-old'), 'K1')
    await fs.mkdir(join(dir, 'appdata'))
    await fs.writeFile(
      join(dir, 'appdata', JOURNAL_FILE),
      JSON.stringify({ from, to, mode: 'merge', phase: 'merging' })
    )
    const settings = settingsWith(from)
    await service(settings).recover()
    expect((await fs.readdir(join(to, 'saves'))).sort()).toEqual([
      'game.srm',
      'kept.srm',
      'kept.srm.playout-old'
    ])
    expect(await fs.readFile(join(to, 'saves', 'game.srm'), 'utf8')).toBe('TARGETS-OWN')
    expect(settings.get().library.emulationDir).toBe(from)
    expect(await journalText()).toBe('none')
  })

  it('a "copied" move is not switched to when the old folder got a newer save meanwhile', async () => {
    const from = join(dir, 'Old', 'Emulation')
    const to = join(dir, 'New', 'Emulation')
    await fs.mkdir(join(from, 'saves'), { recursive: true })
    await fs.mkdir(join(to, 'saves'), { recursive: true })
    await fs.writeFile(join(to, 'saves', 'card.mcd'), 'SAVE-OLD')
    await fs.utimes(join(to, 'saves', 'card.mcd'), OLD, OLD)
    await fs.mkdir(join(dir, 'appdata'), { recursive: true })
    await fs.writeFile(
      join(dir, 'appdata', JOURNAL_FILE),
      JSON.stringify({ from, to, mode: 'move', phase: 'copied', copy: { files: 1, bytes: 8 } })
    )
    // Played while PlayOut was closed: a save of the same size, newer.
    await fs.writeFile(join(from, 'saves', 'card.mcd'), 'SAVE-NEW')
    await fs.utimes(join(from, 'saves', 'card.mcd'), OLD + 3600, OLD + 3600)
    const settings = settingsWith(from)
    await service(settings).recover()
    const inUse = settings.get().library.emulationDir as string
    expect(inUse).toBe(from)
    expect(await fs.readFile(join(inUse, 'saves', 'card.mcd'), 'utf8')).toBe('SAVE-NEW')
    expect(await exists(to)).toBe(false)
  })

  it('a "copied" move whose old folder is unchanged is switched to, with what follows a switch', async () => {
    const from = join(dir, 'Old', 'Emulation')
    const to = join(dir, 'New', 'Emulation')
    for (const root of [from, to]) {
      await fs.mkdir(join(root, 'saves'), { recursive: true })
      await fs.writeFile(join(root, 'saves', 'card.mcd'), 'SAVE-OLD')
      await fs.utimes(join(root, 'saves', 'card.mcd'), OLD, OLD)
    }
    await fs.mkdir(join(dir, 'appdata'), { recursive: true })
    await fs.writeFile(
      join(dir, 'appdata', JOURNAL_FILE),
      JSON.stringify({ from, to, mode: 'move', phase: 'copied', copy: { files: 1, bytes: 8 } })
    )
    const settings = settingsWith(from)
    const after = vi.fn(async () => undefined)
    await service(settings, { afterSwitch: after }).recover()
    expect(settings.get().library.emulationDir).toBe(to)
    expect(after).toHaveBeenCalledWith(from, to)
    expect(await exists(join(from, 'saves', 'card.mcd'))).toBe(false)
  })

  it('other drive: the journal cannot be written after the switch: the move still succeeds', async () => {
    const from = join(dir, 'Old', 'Emulation')
    const to = join(dir, 'New', 'Emulation')
    await fs.mkdir(join(from, 'saves'), { recursive: true })
    await fs.writeFile(join(from, 'saves', 'a.srm'), 'A')
    const settings = settingsWith(from)
    const after = vi.fn(async () => undefined)
    const real = fs.writeFile.bind(fs)
    const svc = service(settings, {
      rename: async (a, b) => {
        if (a === from) throw Object.assign(new Error('x'), { code: 'EXDEV' })
        await fs.rename(a, b)
      },
      // The journal file becomes unwritable right when the switch happens (an antivirus lock).
      beforeSwitch: async () => {
        vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
          if (String(args[0]).includes(JOURNAL_FILE)) throw busyError()
          return real(...(args as Parameters<typeof real>))
        })
      },
      afterSwitch: after
    })
    const result = await svc.start(to, 'move')
    vi.restoreAllMocks()
    expect(result).toEqual({ dir: to, moved: true, leftInOld: 0, keptOlder: 0 })
    expect(settings.get().library.emulationDir).toBe(to)
    expect(after).toHaveBeenCalledOnce()
    expect(await exists(from)).toBe(false)
    expect(await fs.readFile(join(to, 'saves', 'a.srm'), 'utf8')).toBe('A')
  })

  it('other drive: the "copied" journal cannot be written: the copy goes, nothing switched', async () => {
    const from = join(dir, 'Old', 'Emulation')
    const to = join(dir, 'New', 'Emulation')
    await fs.mkdir(join(from, 'saves'), { recursive: true })
    await fs.writeFile(join(from, 'saves', 'a.srm'), 'A')
    const settings = settingsWith(from)
    const real = fs.writeFile.bind(fs)
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      if (String(args[0]).includes(JOURNAL_FILE) && String(args[1]).includes('"copied"'))
        throw busyError()
      return real(...(args as Parameters<typeof real>))
    })
    const svc = service(settings, {
      rename: async (a, b) => {
        if (a === from) throw Object.assign(new Error('x'), { code: 'EXDEV' })
        await fs.rename(a, b)
      }
    })
    await expect(svc.start(to, 'move')).rejects.toThrow('EBUSY')
    vi.restoreAllMocks()
    expect(settings.get().library.emulationDir).toBe(from)
    expect(await exists(to)).toBe(false)
    expect(await fs.readFile(join(from, 'saves', 'a.srm'), 'utf8')).toBe('A')
  })

  it('a move started while startup recovery runs waits for it (nothing lost on either side)', async () => {
    const from = join(dir, 'Old', 'Emulation')
    const to = join(dir, 'New', 'Emulation')
    for (let s = 0; s < 10; s++) {
      await fs.mkdir(join(from, 'saves', `sys${s}`), { recursive: true })
      for (let f = 0; f < 10; f++)
        await fs.writeFile(join(from, 'saves', `sys${s}`, `g${f}.srm`), `save ${s}/${f}`)
    }
    // What an interrupted roll-back left of an earlier copy at `to`, with a big folder its removal walks first.
    for (let s = 0; s < 10; s++) {
      await fs.mkdir(join(to, 'saves', `sys${s}`), { recursive: true })
      for (let f = 0; f < 3; f++)
        await fs.writeFile(join(to, 'saves', `sys${s}`, `g${f}.srm`), `save ${s}/${f}`)
    }
    await fs.mkdir(join(to, 'cache'), { recursive: true })
    for (let i = 0; i < 500; i++) await fs.writeFile(join(to, 'cache', `c${i}.bin`), 'c')
    await fs.mkdir(join(dir, 'appdata'), { recursive: true })
    await fs.writeFile(
      join(dir, 'appdata', JOURNAL_FILE),
      JSON.stringify({ from, to, mode: 'move', phase: 'rolling-back' })
    )
    const settings = settingsWith(from)
    const svc = service(settings)
    const recovery = svc.recover()
    expect(svc.moving()).toBe(true)
    const moved = await svc.start(to, 'merge')
    await recovery
    expect(svc.moving()).toBe(false)
    expect(moved.moved).toBe(true)
    expect(settings.get().library.emulationDir).toBe(to)
    let lost = 0
    for (let s = 0; s < 10; s++)
      for (let f = 0; f < 10; f++) {
        const a = await exists(join(from, 'saves', `sys${s}`, `g${f}.srm`))
        const b = await exists(join(to, 'saves', `sys${s}`, `g${f}.srm`))
        if (!a && !b) lost++
      }
    expect(lost).toBe(0)
  })

  it('the offer waits for recovery', async () => {
    await fs.mkdir(join(dir, 'appdata'), { recursive: true })
    await fs.writeFile(
      join(dir, 'appdata', JOURNAL_FILE),
      JSON.stringify({ from: join(dir, 'a'), to: join(dir, 'b'), mode: 'move', phase: 'copying' })
    )
    const svc = service(settingsWith(join(dir, 'a')))
    const recovery = svc.recover()
    let recovered = false
    void recovery.then(() => (recovered = true))
    await svc.offer()
    expect(recovered).toBe(true)
    await svc.idle()
    expect(svc.moving()).toBe(false)
  })
})

// Round 2 of the verification: merges and recovery taking a different save for the copy (equal size and time, or
// within FAT's 2 s step), a link left only under its temporary name, a merge cut short after a replacement, and a
// recovery deleting a copy that was in use.
describe('round 2', () => {
  const T = 1_700_000_000
  async function put(path: string, text: string, sec: number): Promise<void> {
    await fs.mkdir(join(path, '..'), { recursive: true })
    await fs.writeFile(path, text)
    await fs.utimes(path, sec, sec)
  }
  const read = (path: string): Promise<string | null> => fs.readFile(path, 'utf8').catch(() => null)
  async function journal(record: object): Promise<void> {
    await fs.mkdir(join(dir, 'appdata'), { recursive: true })
    await fs.writeFile(join(dir, 'appdata', JOURNAL_FILE), JSON.stringify(record))
  }

  it('merge: a different save of the same size and the very same time is not the same file', async () => {
    const from = join(dir, 'Old', 'Emulation')
    const to = join(dir, 'Target', 'Emulation')
    await put(join(from, 'saves', 'game.srm'), 'SAVE-FROM-PC-A', T)
    await put(join(to, 'saves', 'game.srm'), 'SAVE-FROM-PC-B', T)
    const out = await moveEmulationFolder(from, to, { mode: 'merge', commit: async () => {} })
    // Neither is newer: the new place keeps its own, the old one stays in the old folder.
    expect(out).toMatchObject({ leftInOld: 1, keptOlder: 0 })
    expect(await read(join(from, 'saves', 'game.srm'))).toBe('SAVE-FROM-PC-A')
    expect(await read(join(to, 'saves', 'game.srm'))).toBe('SAVE-FROM-PC-B')
  })

  it('merge: the same bytes at the same time still count as the same file', async () => {
    const from = join(dir, 'Old', 'Emulation')
    const to = join(dir, 'Target', 'Emulation')
    await put(join(from, 'saves', 'game.srm'), 'SAME', T)
    await put(join(to, 'saves', 'game.srm'), 'SAME', T)
    const out = await moveEmulationFolder(from, to, { mode: 'merge', commit: async () => {} })
    expect(out).toMatchObject({ leftInOld: 0, keptOlder: 0 })
    expect(await exists(join(from, 'saves', 'game.srm'))).toBe(false)
  })

  it('recovery "copied": an old save written again (same size) 1.5 s after its copy is kept', async () => {
    const from = join(dir, 'Old', 'Emulation')
    const to = join(dir, 'New', 'Emulation')
    await put(join(to, 'saves', 'a.srm'), 'AAAA', T)
    await put(join(from, 'saves', 'a.srm'), 'BBBB', T + 1.5)
    await journal({ from, to, mode: 'move', phase: 'copied', copy: { files: 1, bytes: 4 } })
    const settings = settingsWith(from)
    await service(settings).recover()
    expect(settings.get().library.emulationDir).toBe(from)
    expect(await read(join(from, 'saves', 'a.srm'))).toBe('BBBB')
  })

  it('recovery "copied": a copy within 2 s holding the same bytes is still switched to', async () => {
    const from = join(dir, 'Old', 'Emulation')
    const to = join(dir, 'New', 'Emulation')
    await put(join(to, 'saves', 'a.srm'), 'AAAA', T) // a FAT drive rounds the copy's time
    await put(join(from, 'saves', 'a.srm'), 'AAAA', T + 1)
    await journal({ from, to, mode: 'move', phase: 'copied', copy: { files: 1, bytes: 4 } })
    const settings = settingsWith(from)
    await service(settings).recover()
    expect(settings.get().library.emulationDir).toBe(to)
    expect(await exists(join(from, 'saves', 'a.srm'))).toBe(false)
  })

  it('recovery "cleaning": an old save written again within 2 s of its copy is kept', async () => {
    const from = join(dir, 'Old', 'Emulation')
    const to = join(dir, 'New', 'Emulation')
    await put(join(to, 'saves', 'a.srm'), 'AAAA', T)
    await put(join(from, 'saves', 'a.srm'), 'BBBB', T + 1)
    await journal({ from, to, mode: 'move', phase: 'cleaning' })
    await service(settingsWith(to)).recover()
    expect(await read(join(from, 'saves', 'a.srm'))).toBe('BBBB')
    expect(await read(join(to, 'saves', 'a.srm'))).toBe('AAAA')
  })

  it('recovery "copied" whose settings.json could not be written: saves made in the copy are never deleted', async () => {
    const from = join(dir, 'Old', 'Emulation')
    const to = join(dir, 'New', 'Emulation')
    await put(join(from, 'saves', 'a.srm'), 'AAAA', T)
    await put(join(to, 'saves', 'a.srm'), 'AAAA', T)
    await journal({ from, to, mode: 'move', phase: 'copied', copy: { files: 1, bytes: 4 } })
    // Session 1: the copy is switched to in memory only (settings.json not written).
    const first = settingsWith(from, false)
    await service(first).recover()
    expect(first.get().library.emulationDir).toBe(to)
    expect(JSON.parse(await journalText())).toMatchObject({ phase: 'copied', adopted: true })
    await put(join(to, 'saves', 'b.srm'), 'NEW-SAVE-ONLY-HERE', T + 3600)
    // Next start: settings.json still names the old folder.
    const second = settingsWith(from)
    await service(second).recover()
    expect(second.get().library.emulationDir).toBe(to)
    expect(await read(join(to, 'saves', 'b.srm'))).toBe('NEW-SAVE-ONLY-HERE')
    expect(await journalText()).toBe('none')
  })

  it('recovery "copied" not switched to: only exact copies go, other files of the new place stay', async () => {
    const from = join(dir, 'Old', 'Emulation')
    const to = join(dir, 'New', 'Emulation')
    await put(join(from, 'saves', 'a.srm'), 'AAAA', T)
    await put(join(to, 'saves', 'a.srm'), 'AAAA', T)
    await put(join(to, 'saves', 'b.srm'), 'ONLY-HERE', T)
    await journal({ from, to, mode: 'move', phase: 'copied', copy: { files: 1, bytes: 4 } })
    const settings = settingsWith(from)
    await service(settings).recover()
    expect(settings.get().library.emulationDir).toBe(from)
    expect(await fs.readdir(join(to, 'saves'))).toEqual(['b.srm'])
    expect(await read(join(from, 'saves', 'a.srm'))).toBe('AAAA')
  })

  it('a relink cut short between its two renames: the next walk puts the link back under its name', async () => {
    const from = join(dir, 'Old', 'Emulation')
    const to = join(dir, 'New', 'Emulation')
    await put(join(to, 'bios', 'scph.bin'), 'BIOS', T)
    await fs.mkdir(join(to, 'storage', 'savedata'), { recursive: true })
    await fs.mkdir(join(to, 'roms', 'psx'), { recursive: true })
    await fs.mkdir(join(to, 'saves'), { recursive: true })
    // File link: cut short after the old one was renamed aside (both temporary names stand).
    const fileLink = join(to, 'roms', 'psx', 'scph.bin')
    await fs.symlink(join(from, 'bios', 'scph.bin'), `${fileLink}.playout-link-old`, 'file')
    await fs.symlink(join(to, 'bios', 'scph.bin'), `${fileLink}.playout-link`, 'file')
    // Junction: an older build removed the old one first and stopped before the rename (only the new one stands).
    const junction = join(to, 'saves', 'rpcs3')
    await fs.symlink(join(to, 'storage', 'savedata'), `${junction}.playout-link`, 'junction')
    await relinkTree(to, from, to)
    expect(await fs.readdir(join(to, 'roms', 'psx'))).toEqual(['scph.bin'])
    expect(await fs.readFile(fileLink, 'utf8')).toBe('BIOS')
    expect((await fs.lstat(junction)).isSymbolicLink()).toBe(true)
    expect(await fs.readdir(join(to, 'saves'))).toEqual(['rpcs3'])
  })

  it('a relink whose final rename fails keeps the old link under its own name', async () => {
    const from = join(dir, 'Old')
    const to = join(dir, 'New', 'Emulation')
    await put(join(to, 'storage', 'x.dat'), 'X', T)
    await fs.symlink(join(from, 'storage'), join(to, 'link'), 'junction')
    const realRename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (a, b) => {
      if (String(a).endsWith('.playout-link')) throw busyError()
      return realRename(a, b)
    })
    await expect(relinkTree(to, from, to, () => undefined, true)).rejects.toThrow('could not')
    vi.restoreAllMocks()
    expect(await fs.readdir(to)).toEqual(['link', 'storage'])
    expect((await fs.lstat(join(to, 'link'))).isSymbolicLink()).toBe(true)
  })

  it("a merge cut short after replacing a file: recovery puts the new place's own file back", async () => {
    const from = join(dir, 'Old', 'Emulation')
    const to = join(dir, 'Target', 'Emulation')
    await put(join(from, 'saves', 'b.srm'), 'SAVE-B-src', T + 500)
    await put(join(to, 'saves', 'b.srm'), 'B-tgt-old', T)
    let busyCalls = 0
    let atCommit = ''
    const svc = service(settingsWith(from), {
      busy: async () => {
        if (++busyCalls === 2) {
          atCommit = await journalText()
          return new Promise<string | null>(() => undefined) // the process dies here
        }
        return null
      }
    })
    void svc.start(to, 'merge')
    for (let i = 0; i < 200 && !atCommit; i++) await new Promise((r) => setTimeout(r, 10))
    expect(JSON.parse(atCommit)).toMatchObject({
      phase: 'merging',
      replaced: [{ path: join(to, 'saves', 'b.srm') }]
    })
    expect(await read(join(to, 'saves', 'b.srm'))).toBe('SAVE-B-src')
    await service(settingsWith(from)).recover()
    expect(await fs.readdir(join(to, 'saves'))).toEqual(['b.srm'])
    expect(await read(join(to, 'saves', 'b.srm'))).toBe('B-tgt-old')
    expect(await read(join(from, 'saves', 'b.srm'))).toBe('SAVE-B-src')
    expect(await journalText()).toBe('none')
  })
})

describe('round 3', () => {
  const T = 1_700_000_000
  async function put(path: string, text: string, sec: number): Promise<void> {
    await fs.mkdir(join(path, '..'), { recursive: true })
    await fs.writeFile(path, text)
    await fs.utimes(path, sec, sec)
  }
  const read = (path: string): Promise<string | null> => fs.readFile(path, 'utf8').catch(() => null)
  const eio = (what: string): NodeJS.ErrnoException =>
    Object.assign(new Error(`EIO: injected, ${what}`), { code: 'EIO' })
  const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  async function journal(record: object): Promise<void> {
    await fs.mkdir(join(dir, 'appdata'), { recursive: true })
    await fs.writeFile(join(dir, 'appdata', JOURNAL_FILE), JSON.stringify(record))
  }
  /** A save the old folder holds read-only, newer than the target's own: the merge replaces the target's. */
  async function readOnlyMergeFixture(): Promise<{ from: string; to: string }> {
    const from = join(dir, 'Old', 'Emulation')
    const to = join(dir, 'Target', 'Emulation')
    await put(join(from, 'saves', 'a.srm'), 'NEWER', T + 100)
    await put(join(to, 'saves', 'a.srm'), 'TARGET-OWN', T)
    await fs.chmod(join(from, 'saves', 'a.srm'), 0o444)
    return { from, to }
  }

  it('merge undone over a read-only copy: the target keeps its own save under its name', async () => {
    const { from, to } = await readOnlyMergeFixture()
    const settings = settingsWith(from)
    let busyCalls = 0
    const svc = service(settings, { busy: async () => (++busyCalls > 1 ? 'busy.game' : null) })
    await expect(svc.start(to, 'merge')).rejects.toThrow('busy.game')
    expect(settings.get().library.emulationDir).toBe(from)
    expect(await fs.readdir(join(to, 'saves'))).toEqual(['a.srm'])
    expect(await read(join(to, 'saves', 'a.srm'))).toBe('TARGET-OWN')
    expect(await read(join(from, 'saves', 'a.srm'))).toBe('NEWER')
    expect(await journalText()).toBe('none')
  })

  it('merge undo that cannot put a file back keeps the journal, and the next start does', async () => {
    const { from, to } = await readOnlyMergeFixture()
    const settings = settingsWith(from)
    let busyCalls = 0
    const svc = service(settings, {
      busy: async () => (++busyCalls > 1 ? 'busy.game' : null),
      rename: async (a, b) => {
        if (a.endsWith('.playout-old')) throw busyError() // the undo's rename back
        await fs.rename(a, b)
      }
    })
    await expect(svc.start(to, 'merge')).rejects.toThrow('busy.game')
    expect(JSON.parse(await journalText())).toMatchObject({ phase: 'merging', replaced: [{}] })
    await service(settings).recover()
    expect(await fs.readdir(join(to, 'saves'))).toEqual(['a.srm'])
    expect(await read(join(to, 'saves', 'a.srm'))).toBe('TARGET-OWN')
    expect(await journalText()).toBe('none')
  })

  it('merge cut short after replacing with a read-only copy: recovery puts the target save back', async () => {
    const { from, to } = await readOnlyMergeFixture()
    let busyCalls = 0
    const svc = service(settingsWith(from), {
      // The process dies at the switch.
      busy: async () => (++busyCalls > 1 ? new Promise<string | null>(() => undefined) : null)
    })
    void svc.start(to, 'merge')
    while (busyCalls < 2) await pause(10)
    expect(await read(join(to, 'saves', 'a.srm'))).toBe('NEWER')
    await service(settingsWith(from)).recover()
    expect(await fs.readdir(join(to, 'saves'))).toEqual(['a.srm'])
    expect(await read(join(to, 'saves', 'a.srm'))).toBe('TARGET-OWN')
    expect(await journalText()).toBe('none')
  })

  it('recovery: one backup that cannot be put back does not stop the others (journal kept)', async () => {
    const from = join(dir, 'Old', 'Emulation')
    const to = join(dir, 'Target', 'Emulation')
    for (const n of ['x', 'y']) {
      await put(join(to, 'saves', `${n}.srm`), `${n}-NEW`, T + 9)
      await put(join(to, 'saves', `${n}.srm.playout-old`), `${n}-OWN`, T)
    }
    const replaced = ['x', 'y'].map((n) => ({
      path: join(to, 'saves', `${n}.srm`),
      backup: join(to, 'saves', `${n}.srm.playout-old`)
    }))
    await journal({ from, to, mode: 'merge', phase: 'merging', replaced })
    const realRename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (a, b) => {
      if (String(a).endsWith('y.srm.playout-old')) throw epermError()
      return realRename(a, b)
    })
    await service(settingsWith(from)).recover()
    vi.restoreAllMocks()
    expect(await read(join(to, 'saves', 'x.srm'))).toBe('x-OWN')
    expect(await read(join(to, 'saves', 'y.srm.playout-old'))).toBe('y-OWN')
    expect(JSON.parse(await journalText())).toMatchObject({ phase: 'merging' })
    await service(settingsWith(from)).recover()
    expect(await read(join(to, 'saves', 'y.srm'))).toBe('y-OWN')
    expect(await journalText()).toBe('none')
  })

  it('a PlayOut killed while the journal is written leaves the previous record (merge put back)', async () => {
    const from = join(dir, 'Old', 'Emulation')
    const to = join(dir, 'Target', 'Emulation')
    for (const n of ['x', 'y']) {
      await put(join(from, 'saves', `${n}.srm`), `${n}-NEWER`, T + 100)
      await put(join(to, 'saves', `${n}.srm`), `${n}-OWN`, T)
    }
    const realWrite = fs.writeFile.bind(fs)
    let killed = false
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      if (killed) return new Promise<void>(() => undefined)
      const [path, data] = args
      if (String(path).includes(JOURNAL_FILE) && String(data).split('"backup"').length === 3) {
        await realWrite(path as string, '') // truncated, then the process is gone
        killed = true
        return new Promise<void>(() => undefined)
      }
      return realWrite(...(args as Parameters<typeof realWrite>))
    })
    void service(settingsWith(from)).start(to, 'merge')
    while (!killed) await pause(10)
    vi.restoreAllMocks()
    expect(JSON.parse(await journalText())).toMatchObject({ phase: 'merging', replaced: [{}] })
    await service(settingsWith(from)).recover()
    expect(await read(join(to, 'saves', 'x.srm'))).toBe('x-OWN')
    expect(await read(join(to, 'saves', 'y.srm'))).toBe('y-OWN')
    expect((await fs.readdir(join(to, 'saves'))).sort()).toEqual(['x.srm', 'y.srm'])
  })

  it('a journal that cannot be read is kept aside and nothing is touched', async () => {
    await fs.mkdir(join(dir, 'appdata'), { recursive: true })
    await fs.writeFile(join(dir, 'appdata', JOURNAL_FILE), '{"from": "C:')
    await service(settingsWith(join(dir, 'Old'))).recover()
    expect(await exists(join(dir, 'appdata', `${JOURNAL_FILE}.unreadable`))).toBe(true)
  })

  it('same drive, switch refused, a link not pointed back: the journal stays and the next start points it', async () => {
    const from = join(dir, 'Old', 'Emulation')
    const to = join(dir, 'New', 'Emulation')
    await put(join(from, 'storage', 'savedata', 's1.dat'), 'PS3SAVE', T)
    await fs.mkdir(join(from, 'saves'), { recursive: true })
    await fs.symlink(join(from, 'storage', 'savedata'), join(from, 'saves', 'rpcs3'), 'junction')
    const settings = settingsWith(from)
    let busyCalls = 0
    let back = false
    const realSymlink = fs.symlink.bind(fs)
    vi.spyOn(fs, 'symlink').mockImplementation(async (target, path, type) => {
      if (back && String(target).startsWith(from)) {
        back = false
        throw eio('symlink')
      }
      return realSymlink(target, path, type)
    })
    const svc = service(settings, {
      rename: (a, b) => fs.rename(a, b),
      busy: async () => {
        if (++busyCalls === 1) return null
        back = true
        return 'busy.game'
      }
    })
    await expect(svc.start(to, 'move')).rejects.toThrow('busy.game')
    vi.restoreAllMocks()
    expect(settings.get().library.emulationDir).toBe(from)
    expect(JSON.parse(await journalText())).toMatchObject({ phase: 'renamed' })
    await service(settings).recover()
    expect(await read(join(from, 'saves', 'rpcs3', 's1.dat'))).toBe('PS3SAVE')
    expect(await journalText()).toBe('none')
  })

  it('relinkTree: a folder that cannot be read does not stop the other links', async () => {
    const from = join(dir, 'Old')
    const to = join(dir, 'New')
    await fs.mkdir(join(to, 'storage', 'savedata'), { recursive: true })
    await fs.mkdir(join(to, 'a'), { recursive: true })
    await fs.mkdir(join(to, 'z'), { recursive: true })
    await fs.symlink(join(from, 'storage', 'savedata'), join(to, 'z', 'link'), 'junction')
    const realReaddir = fs.readdir.bind(fs)
    vi.spyOn(fs, 'readdir').mockImplementation((async (p: string) => {
      if (String(p) === join(to, 'a')) throw eio('readdir')
      return realReaddir(p)
    }) as unknown as typeof fs.readdir)
    await expect(relinkTree(to, from, to, () => undefined, true)).rejects.toThrow('1 links')
    vi.restoreAllMocks()
    expect(await fs.readlink(join(to, 'z', 'link'))).toContain(join(to, 'storage', 'savedata'))
  })

  for (const kind of ['same', 'other'] as const)
    it(`${kind} drive: a stat error never turns a file link into a junction (the BIOS stays readable)`, async () => {
      const from = join(dir, 'Old')
      const to = join(dir, 'New', 'Emulation')
      await put(join(from, 'bios', 'scph.bin'), 'BIOS', T)
      await fs.mkdir(join(from, 'roms', 'psx'), { recursive: true })
      const link = join(from, 'roms', 'psx', 'scph.bin')
      await fs.symlink(join(from, 'bios', 'scph.bin'), link, 'file')
      const realStat = fs.stat.bind(fs)
      let once = true
      vi.spyOn(fs, 'stat').mockImplementation((async (p: string) => {
        if (
          once &&
          /psx[\\/]scph\.bin$|New[\\/]Emulation[\\/]bios[\\/]scph\.bin$/.test(String(p))
        ) {
          once = false
          throw busyError()
        }
        return realStat(p)
      }) as unknown as typeof fs.stat)
      const settings = settingsWith(from)
      const svc = service(settings, {
        rename: kind === 'other' ? exdev : (a, b) => fs.rename(a, b)
      })
      await svc.start(to, 'move').catch(() => undefined)
      vi.restoreAllMocks()
      expect(once).toBe(false)
      const inUse = settings.get().library.emulationDir as string
      // Under the folder in use the link reads the BIOS, or (not made there) the old link still does.
      const here = await read(join(inUse, 'roms', 'psx', 'scph.bin'))
      expect(here === 'BIOS' || (await read(link)) === 'BIOS').toBe(true)
      if (here !== 'BIOS') expect(await exists(join(inUse, 'roms', 'psx', 'scph.bin'))).toBe(false)
    })

  it('merge: an internal link that cannot be made at the new place keeps what it points at', async () => {
    const from = join(dir, 'Old', 'Emulation')
    const to = join(dir, 'Target', 'Emulation')
    await put(join(from, 'storage', 'savedata', 's1.dat'), 'PS3SAVE', T)
    await fs.mkdir(join(from, 'saves'), { recursive: true })
    await fs.symlink(join(from, 'storage', 'savedata'), join(from, 'saves', 'rpcs3'), 'junction')
    await put(join(to, 'other.txt'), 'X', T)
    const realSymlink = fs.symlink.bind(fs)
    vi.spyOn(fs, 'symlink').mockImplementation(async (target, path, type) => {
      if (String(path).startsWith(to)) throw epermError()
      return realSymlink(target, path, type)
    })
    const out = await moveEmulationFolder(from, to, { mode: 'merge', commit: async () => {} })
    vi.restoreAllMocks()
    expect(out.leftInOld).toBeGreaterThanOrEqual(2)
    expect(await read(join(from, 'saves', 'rpcs3', 's1.dat'))).toBe('PS3SAVE')
    expect(await read(join(to, 'storage', 'savedata', 's1.dat'))).toBe('PS3SAVE')
  })

  it('other drive: an internal link not made at the new place keeps what it points at', async () => {
    const from = join(dir, 'Old')
    const to = join(dir, 'New', 'Emulation')
    await put(join(from, 'storage', 'savedata', 's1.dat'), 'PS3SAVE', T)
    await fs.mkdir(join(from, 'saves'), { recursive: true })
    await fs.symlink(join(from, 'storage', 'savedata'), join(from, 'saves', 'rpcs3'), 'junction')
    const realSymlink = fs.symlink.bind(fs)
    vi.spyOn(fs, 'symlink').mockImplementation(async (target, path, type) => {
      if (String(path).includes('playout-new')) throw epermError()
      return realSymlink(target, path, type)
    })
    const out = await moveEmulationFolder(from, to, {
      mode: 'move',
      commit: async () => {},
      rename: exdev
    })
    vi.restoreAllMocks()
    expect(out.leftInOld).toBeGreaterThanOrEqual(2)
    expect(await read(join(from, 'saves', 'rpcs3', 's1.dat'))).toBe('PS3SAVE')
    expect(await read(join(to, 'storage', 'savedata', 's1.dat'))).toBe('PS3SAVE')
  })

  it('merge: an error while picking the backup name leaves no *.playout-new behind', async () => {
    const from = join(dir, 'Old', 'Emulation')
    const to = join(dir, 'Target', 'Emulation')
    await put(join(from, 'saves', 'b.srm'), 'NEWER', T + 100)
    await put(join(to, 'saves', 'b.srm'), 'OWN', T)
    const realLstat = fs.lstat.bind(fs)
    vi.spyOn(fs, 'lstat').mockImplementation((async (p: string) => {
      if (String(p).endsWith('b.srm.playout-old')) throw eio('lstat')
      return realLstat(p)
    }) as unknown as typeof fs.lstat)
    await expect(
      moveEmulationFolder(from, to, { mode: 'merge', commit: async () => {} })
    ).rejects.toThrow('EIO')
    vi.restoreAllMocks()
    expect(await fs.readdir(join(to, 'saves'))).toEqual(['b.srm'])
    expect(await read(join(to, 'saves', 'b.srm'))).toBe('OWN')
  })

  /** Rewrites `path` in place right after PlayOut copied it: same size, the very same time (one clock tick). */
  function rewriteAfterCopy(path: string, text: string): void {
    const realCopy = fs.copyFile.bind(fs)
    let done = false
    vi.spyOn(fs, 'copyFile').mockImplementation(async (a, b, mode) => {
      await realCopy(a, b, mode)
      if (!done && String(a) === path) {
        done = true
        const st = await fs.stat(path)
        await fs.writeFile(path, text)
        await fs.utimes(path, st.atime, st.mtime)
      }
    })
  }

  it('other drive: a save written again within one clock tick of its copy is never deleted', async () => {
    const from = join(dir, 'Old')
    const to = join(dir, 'New', 'Emulation')
    const card = join(from, 'saves', 'card.mcd')
    await fs.mkdir(join(from, 'saves'), { recursive: true })
    await put(card, 'SAVE-2', Math.floor(Date.now() / 1000)) // written right before the move
    rewriteAfterCopy(card, 'SAVE-3')
    const out = await moveEmulationFolder(from, to, {
      mode: 'move',
      commit: async () => {},
      rename: exdev
    })
    vi.restoreAllMocks()
    expect(out.leftInOld).toBe(1)
    expect(await read(card)).toBe('SAVE-3')
  })

  it('merge: a save written again within one clock tick of its copy is never deleted', async () => {
    const from = join(dir, 'Old', 'Emulation')
    const to = join(dir, 'Target', 'Emulation')
    const card = join(from, 'saves', 'card.mcd')
    await fs.mkdir(join(from, 'saves'), { recursive: true })
    await put(card, 'SAVE-2', Math.floor(Date.now() / 1000))
    await put(join(to, 'other.txt'), 'X', T)
    rewriteAfterCopy(card, 'SAVE-3')
    const out = await moveEmulationFolder(from, to, { mode: 'merge', commit: async () => {} })
    vi.restoreAllMocks()
    expect(out.leftInOld).toBe(1)
    expect(await read(card)).toBe('SAVE-3')
  })

  it('an old file the copy holds as it is still goes after the switch', async () => {
    const from = join(dir, 'Old')
    const to = join(dir, 'New', 'Emulation')
    await put(join(from, 'roms', 'game.iso'), 'ISO', T)
    await fs.writeFile(join(from, 'saves.srm'), 'FRESH-BUT-SAME') // fresh: its bytes are compared
    const out = await moveEmulationFolder(from, to, {
      mode: 'move',
      commit: async () => {},
      rename: exdev
    })
    expect(out.leftInOld).toBe(0)
    expect(await exists(from)).toBe(false)
  })

  it('recovery: an equal size and time proves a copy only for files older than the move', async () => {
    const from = join(dir, 'Old', 'Emulation')
    const to = join(dir, 'New', 'Emulation')
    const now = Date.now() / 1000
    await put(join(to, 'saves', 'card.mcd'), 'SAVE-2', now)
    await put(join(from, 'saves', 'card.mcd'), 'SAVE-3', now)
    await put(join(to, 'roms', 'game.iso'), 'ISO', T)
    await put(join(from, 'roms', 'game.iso'), 'ISO', T)
    await journal({ from, to, mode: 'move', phase: 'cleaning', since: Date.now() - 1000 })
    await service(settingsWith(to)).recover()
    expect(await read(join(from, 'saves', 'card.mcd'))).toBe('SAVE-3')
    expect(await exists(join(from, 'roms', 'game.iso'))).toBe(false)
  })

  it('an app writing a save by its name while it is being removed: the new save is never deleted', async () => {
    const from = join(dir, 'Old')
    const to = join(dir, 'New', 'Emulation')
    const card = join(from, 'saves', 'card.mcd')
    await put(card, 'SAVE-2', T)
    const realRename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (a, b) => {
      await realRename(a, b)
      // Right after PlayOut's last check, before its delete: a game writes card.mcd again.
      if (String(b).endsWith('card.mcd.playout-del')) await fs.writeFile(card, 'SAVE-3')
    })
    const out = await moveEmulationFolder(from, to, {
      mode: 'move',
      commit: async () => {},
      rename: exdev
    })
    vi.restoreAllMocks()
    expect(out.leftInOld).toBe(1)
    expect(await read(card)).toBe('SAVE-3')
    expect(await fs.readdir(join(from, 'saves'))).toEqual(['card.mcd'])
  })

  it('recovery: a removal cut short (*.playout-del) goes back under its name and is kept when newer', async () => {
    const from = join(dir, 'Old', 'Emulation')
    const to = join(dir, 'New', 'Emulation')
    await put(join(to, 'saves', 'a.srm'), 'OLD', T)
    await put(join(from, 'saves', 'a.srm.playout-del'), 'NEWER', T + 60)
    await put(join(to, 'saves', 'b.srm'), 'B', T)
    await put(join(from, 'saves', 'b.srm.playout-del'), 'B', T)
    await journal({ from, to, mode: 'move', phase: 'cleaning', since: Date.now() })
    await service(settingsWith(to)).recover()
    expect(await fs.readdir(join(from, 'saves'))).toEqual(['a.srm'])
    expect(await read(join(from, 'saves', 'a.srm'))).toBe('NEWER')
  })

  it('names of 250 characters: a merge replaces them and a same-drive move relinks them', async () => {
    const from = join(dir, 'Old', 'Emulation')
    const to = join(dir, 'Target', 'Emulation')
    const long = `${'L'.repeat(246)}.srm`
    await put(join(from, 'saves', long), 'NEWER', T + 100)
    await put(join(to, 'saves', long), 'OWN', T)
    const out = await moveEmulationFolder(from, to, { mode: 'merge', commit: async () => {} })
    expect(out.keptOlder).toBe(1)
    expect(await read(join(to, 'saves', long))).toBe('NEWER')
    const names = await fs.readdir(join(to, 'saves'))
    expect(names).toHaveLength(2)
    expect(names.every((n) => n.length <= 255)).toBe(true)

    const a = join(dir, 'A', 'Emulation')
    const b = join(dir, 'B', 'Emulation')
    const junction = 'J'.repeat(250)
    await put(join(a, 'storage', 'savedata', 's.dat'), 'S', T)
    await fs.symlink(join(a, 'storage', 'savedata'), join(a, junction), 'junction')
    await moveEmulationFolder(a, b, {
      mode: 'move',
      commit: async () => {},
      rename: (x, y) => fs.rename(x, y)
    })
    expect(await read(join(b, junction, 's.dat'))).toBe('S')
    expect(await fs.readlink(join(b, junction))).toContain(b)
  })

  it('an Emulation folder that is itself a link is refused: the files stay where it points', async () => {
    const real = join(dir, 'Real', 'Emulation')
    await put(join(real, 'saves', 'a.srm'), 'SAVE', T)
    const from = join(dir, 'Docs', 'Emulation')
    await fs.mkdir(join(dir, 'Docs'), { recursive: true })
    await fs.symlink(real, from, 'junction')
    const settings = settingsWith(from)
    const svc = service(settings)
    for (const to of [join(dir, 'New', 'Emulation'), join(dir, 'Target', 'Emulation')]) {
      const plan = await svc.plan({ kind: 'choose', picked: to })
      expect(plan.blocked).toBe('mainEmulationMove.blocked.currentIsLink')
    }
    await put(join(dir, 'Target', 'Emulation', 'saves', 'b.srm'), 'B', T)
    await expect(svc.start(join(dir, 'New', 'Emulation'), 'move')).rejects.toThrow()
    await expect(svc.start(join(dir, 'Target', 'Emulation'), 'merge')).rejects.toThrow()
    await expect(
      moveEmulationFolder(from, join(dir, 'X', 'Emulation'), {
        mode: 'move',
        commit: async () => {}
      })
    ).rejects.toThrow('is a link')
    expect(settings.get().library.emulationDir).toBe(from)
    expect((await fs.lstat(from)).isSymbolicLink()).toBe(true)
    expect(await read(join(real, 'saves', 'a.srm'))).toBe('SAVE')
    expect(await read(join(dir, 'New', 'Emulation', 'saves', 'a.srm'))).toBeNull()
  })
})
