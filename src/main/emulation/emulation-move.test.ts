import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings, SettingsPatch } from '../../shared/types'
import { createEmulationMoveService, JOURNAL_FILE } from './emulation-move-service'
import { moveEmulationFolder, stagingDir } from './emulation-move'

vi.mock('../i18n', () => ({ tMain: (key: string) => key }))

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-move-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const OLD = Date.UTC(2024, 0, 1) / 1000
const NEW = Date.UTC(2025, 0, 1) / 1000

/** An Emulation folder: saves, a ROM, and RPCS3's savedata junction into its own saves folder. */
async function makeEmulation(root: string, outside: string): Promise<void> {
  await fs.mkdir(join(root, 'saves', 'rpcs3', 'saves'), { recursive: true })
  await fs.mkdir(join(root, 'roms', 'snes'), { recursive: true })
  await fs.mkdir(join(root, 'Updates and DLC', 'PS3', 'home'), { recursive: true })
  await fs.writeFile(join(root, 'saves', 'rpcs3', 'saves', 'slot1.dat'), 'save-data')
  await fs.writeFile(join(root, 'roms', 'snes', 'game.sfc'), 'rom-bytes')
  await fs.writeFile(join(root, '.playout-sync-id'), 'abc')
  await fs.utimes(join(root, 'saves', 'rpcs3', 'saves', 'slot1.dat'), OLD, OLD)
  await fs.symlink(
    join(root, 'saves', 'rpcs3', 'saves'),
    join(root, 'Updates and DLC', 'PS3', 'home', 'savedata'),
    'junction'
  )
  // A link to a folder outside (roms of another drive): kept pointing there, never followed.
  await fs.mkdir(outside, { recursive: true })
  await fs.writeFile(join(outside, 'big.iso'), 'outside')
  await fs.symlink(outside, join(root, 'roms', 'ps2'), 'junction')
}

const exdev = (real: (a: string, b: string) => Promise<void>) => async (a: string, b: string) => {
  // Acts out another drive: the first rename of the folder itself fails as across volumes.
  if (a.endsWith('Old') || a.endsWith('Old\\')) {
    const err = new Error('cross-device') as NodeJS.ErrnoException
    err.code = 'EXDEV'
    throw err
  }
  await real(a, b)
}

async function linkTargetOf(path: string): Promise<string> {
  return (await fs.readlink(path))
    .replace(/^\\\\\?\\/, '')
    .replace(/[\\/]+$/, '')
    .toLowerCase()
}

describe('moving the Emulation folder', () => {
  it('same drive: renames, and re-points the links inside it', async () => {
    const from = join(dir, 'Old')
    const to = join(dir, 'New', 'Emulation')
    await makeEmulation(from, join(dir, 'Other'))
    const commit = vi.fn(async () => {})
    const out = await moveEmulationFolder(from, to, { mode: 'move', commit })
    expect(out).toEqual({ renamed: true, leftInOld: 0, keptOlder: 0 })
    expect(commit).toHaveBeenCalledOnce()
    await expect(fs.stat(from)).rejects.toThrow()
    expect(await fs.readFile(join(to, 'saves', 'rpcs3', 'saves', 'slot1.dat'), 'utf8')).toBe(
      'save-data'
    )
    const savedata = join(to, 'Updates and DLC', 'PS3', 'home', 'savedata')
    expect((await fs.lstat(savedata)).isSymbolicLink()).toBe(true)
    expect(await linkTargetOf(savedata)).toBe(join(to, 'saves', 'rpcs3', 'saves').toLowerCase())
    expect(await linkTargetOf(join(to, 'roms', 'ps2'))).toBe(join(dir, 'Other').toLowerCase())
  })

  it('other drive: copies with file times, makes the links again, then removes the old folder', async () => {
    const from = join(dir, 'Old')
    const to = join(dir, 'New', 'Emulation')
    await makeEmulation(from, join(dir, 'Other'))
    const phases: string[] = []
    const out = await moveEmulationFolder(from, to, {
      mode: 'move',
      commit: async () => {
        // The switch happens with the copy complete and the old folder still whole.
        expect(await fs.readFile(join(to, 'roms', 'snes', 'game.sfc'), 'utf8')).toBe('rom-bytes')
        expect(await fs.readFile(join(from, 'roms', 'snes', 'game.sfc'), 'utf8')).toBe('rom-bytes')
      },
      rename: exdev((a, b) => fs.rename(a, b)),
      journal: { write: async (p) => void phases.push(p) }
    })
    expect(out).toEqual({ renamed: false, leftInOld: 0, keptOlder: 0 })
    expect(phases).toEqual(['renamed', 'copying', 'copied', 'cleaning'])
    await expect(fs.stat(from)).rejects.toThrow()
    await expect(fs.stat(stagingDir(to))).rejects.toThrow()
    const st = await fs.stat(join(to, 'saves', 'rpcs3', 'saves', 'slot1.dat'))
    expect(Math.round(st.mtimeMs / 1000)).toBe(OLD)
    const savedata = join(to, 'Updates and DLC', 'PS3', 'home', 'savedata')
    expect((await fs.lstat(savedata)).isSymbolicLink()).toBe(true)
    expect(await linkTargetOf(savedata)).toBe(join(to, 'saves', 'rpcs3', 'saves').toLowerCase())
    // The outside link was made again, not followed: its files were neither copied nor deleted.
    expect((await fs.lstat(join(to, 'roms', 'ps2'))).isSymbolicLink()).toBe(true)
    expect(await fs.readFile(join(dir, 'Other', 'big.iso'), 'utf8')).toBe('outside')
    expect(await fs.readFile(join(to, '.playout-sync-id'), 'utf8')).toBe('abc')
  })

  it('a failed switch puts everything back (other drive): the old folder stays, the copy goes', async () => {
    const from = join(dir, 'Old')
    const to = join(dir, 'New', 'Emulation')
    await makeEmulation(from, join(dir, 'Other'))
    await expect(
      moveEmulationFolder(from, to, {
        mode: 'move',
        commit: async () => {
          throw new Error('settings could not be saved')
        },
        rename: exdev((a, b) => fs.rename(a, b))
      })
    ).rejects.toThrow('settings could not be saved')
    expect(await fs.readFile(join(from, 'roms', 'snes', 'game.sfc'), 'utf8')).toBe('rom-bytes')
    await expect(fs.stat(to)).rejects.toThrow()
    await expect(fs.stat(stagingDir(to))).rejects.toThrow()
    expect(await fs.readFile(join(dir, 'Other', 'big.iso'), 'utf8')).toBe('outside')
  })

  it('a failed switch puts everything back (same drive), links included', async () => {
    const from = join(dir, 'Old')
    const to = join(dir, 'New', 'Emulation')
    await makeEmulation(from, join(dir, 'Other'))
    await expect(
      moveEmulationFolder(from, to, {
        mode: 'move',
        commit: async () => {
          throw new Error('no')
        }
      })
    ).rejects.toThrow('no')
    await expect(fs.stat(to)).rejects.toThrow()
    const savedata = join(from, 'Updates and DLC', 'PS3', 'home', 'savedata')
    expect(await linkTargetOf(savedata)).toBe(join(from, 'saves', 'rpcs3', 'saves').toLowerCase())
  })

  it('cancel mid-copy: nothing moved, no partial copy', async () => {
    const from = join(dir, 'Old')
    const to = join(dir, 'New', 'Emulation')
    await makeEmulation(from, join(dir, 'Other'))
    const abort = new AbortController()
    await expect(
      moveEmulationFolder(from, to, {
        mode: 'move',
        signal: abort.signal,
        commit: async () => {},
        rename: exdev((a, b) => fs.rename(a, b)),
        onProgress: (tick) => {
          if (tick.phase === 'copying' && tick.filesDone >= 1) abort.abort()
        }
      })
    ).rejects.toThrow()
    await expect(fs.stat(stagingDir(to))).rejects.toThrow()
    await expect(fs.stat(to)).rejects.toThrow()
    expect(await fs.readFile(join(from, 'roms', 'snes', 'game.sfc'), 'utf8')).toBe('rom-bytes')
  })

  it('merge into a non-empty folder: adds what is missing, never overwrites a newer file', async () => {
    const from = join(dir, 'Old')
    const to = join(dir, 'Target')
    await fs.mkdir(join(from, 'saves'), { recursive: true })
    await fs.mkdir(join(to, 'saves'), { recursive: true })
    await fs.writeFile(join(from, 'saves', 'a.sav'), 'old-a')
    await fs.writeFile(join(to, 'saves', 'a.sav'), 'new-a')
    await fs.utimes(join(from, 'saves', 'a.sav'), OLD, OLD)
    await fs.utimes(join(to, 'saves', 'a.sav'), NEW, NEW)
    await fs.writeFile(join(from, 'saves', 'b.sav'), 'newer-b')
    await fs.writeFile(join(to, 'saves', 'b.sav'), 'older-b')
    await fs.utimes(join(from, 'saves', 'b.sav'), NEW, NEW)
    await fs.utimes(join(to, 'saves', 'b.sav'), OLD, OLD)
    await fs.writeFile(join(from, 'saves', 'c.sav'), 'only-old')
    const out = await moveEmulationFolder(from, to, { mode: 'merge', commit: async () => {} })
    expect(await fs.readFile(join(to, 'saves', 'a.sav'), 'utf8')).toBe('new-a')
    expect(await fs.readFile(join(to, 'saves', 'b.sav'), 'utf8')).toBe('newer-b')
    expect(await fs.readFile(join(to, 'saves', 'b.sav.playout-old'), 'utf8')).toBe('older-b')
    expect(await fs.readFile(join(to, 'saves', 'c.sav'), 'utf8')).toBe('only-old')
    // The older a.sav stays in the old folder; everything else left it.
    expect(out).toEqual({ renamed: false, leftInOld: 1, keptOlder: 1 })
    expect(await fs.readdir(join(from, 'saves'))).toEqual(['a.sav'])
  })

  it('merge: a failed switch undoes every change in the target', async () => {
    const from = join(dir, 'Old')
    const to = join(dir, 'Target')
    await fs.mkdir(join(from, 'saves'), { recursive: true })
    await fs.mkdir(join(to, 'saves'), { recursive: true })
    await fs.writeFile(join(from, 'saves', 'b.sav'), 'newer-b')
    await fs.writeFile(join(to, 'saves', 'b.sav'), 'older-b')
    await fs.utimes(join(from, 'saves', 'b.sav'), NEW, NEW)
    await fs.utimes(join(to, 'saves', 'b.sav'), OLD, OLD)
    await fs.writeFile(join(from, 'saves', 'c.sav'), 'only-old')
    await expect(
      moveEmulationFolder(from, to, {
        mode: 'merge',
        commit: async () => {
          throw new Error('no')
        }
      })
    ).rejects.toThrow('no')
    expect((await fs.readdir(join(to, 'saves'))).sort()).toEqual(['b.sav'])
    expect(await fs.readFile(join(to, 'saves', 'b.sav'), 'utf8')).toBe('older-b')
    expect((await fs.readdir(join(from, 'saves'))).sort()).toEqual(['b.sav', 'c.sav'])
  })
})

describe('the move service', () => {
  type TestSettings = {
    get(): Settings
    update(patch: SettingsPatch): void
    tryFlush: ReturnType<typeof vi.fn<() => Promise<boolean>>>
  }
  function settingsWith(emulationDir: string | null): TestSettings {
    let s = { library: { emulationDir } } as unknown as Settings
    return {
      get: () => s,
      update(patch: SettingsPatch) {
        s = { ...s, library: { ...s.library, ...patch.library } } as Settings
      },
      tryFlush: vi.fn(async () => true)
    }
  }

  function service(
    emulationDir: string,
    extra: Partial<Parameters<typeof createEmulationMoveService>[0]> = {}
  ): {
    svc: ReturnType<typeof createEmulationMoveService>
    settings: TestSettings
    events: string[]
  } {
    const settings = settingsWith(emulationDir)
    const events: string[] = []
    const svc = createEmulationMoveService({
      settings,
      userData: join(dir, 'appdata'),
      documents: join(dir, 'Documents'),
      forbidden: () => [
        { path: join(dir, 'PlayOut'), kind: 'install' },
        { path: join(dir, 'appdata'), kind: 'data' }
      ],
      busy: async () => null,
      emit: (p) => events.push(p.phase),
      log: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      },
      progressEveryMs: 0,
      ...extra
    })
    return { svc, settings, events }
  }

  it('refuses the install and data folders', async () => {
    const from = join(dir, 'Documents', 'Emulation')
    await fs.mkdir(from, { recursive: true })
    const { svc } = service(from)
    const plan = await svc.plan({ kind: 'generate', picked: join(dir, 'PlayOut', 'Stuff') })
    expect(plan.blocked).toBe('mainEmulationMove.blocked.install')
    const data = await svc.plan({ kind: 'choose', picked: join(dir, 'APPDATA', 'Emulation') })
    expect(data.blocked).toBe('mainEmulationMove.blocked.data')
    expect(() => svc.validate(join(dir, 'playout', 'Emulation') + '\\')).toThrow(
      'mainEmulationMove.blocked.install'
    )
    expect(() => svc.validate(join(dir, 'Elsewhere'))).not.toThrow()
  })

  it('refuses while a game or an emulator runs, and moves nothing', async () => {
    const from = join(dir, 'Documents', 'Emulation')
    await fs.mkdir(join(from, 'saves'), { recursive: true })
    await fs.writeFile(join(from, 'saves', 'x.sav'), 'x')
    const { svc, settings } = service(from, { busy: async () => 'busy: RPCS3 is running' })
    const plan = await svc.plan({ kind: 'generate', picked: join(dir, 'D') })
    expect(plan.blocked).toBe('busy: RPCS3 is running')
    await expect(svc.start(plan.to, 'move')).rejects.toThrow('busy: RPCS3 is running')
    expect(settings.get().library.emulationDir).toBe(from)
    expect(await fs.readFile(join(from, 'saves', 'x.sav'), 'utf8')).toBe('x')
  })

  it('moves, switches the setting, holds the sync meanwhile, and reports the size', async () => {
    const from = join(dir, 'Documents', 'Emulation')
    await fs.mkdir(join(from, 'saves'), { recursive: true })
    await fs.writeFile(join(from, 'saves', 'x.sav'), '12345')
    const release = vi.fn()
    const holdSync = vi.fn(() => release)
    const before = vi.fn(async () => {})
    const after = vi.fn(async () => {})
    const { svc, settings, events } = service(from, {
      holdSync,
      beforeSwitch: before,
      afterSwitch: after
    })
    const plan = await svc.plan({ kind: 'generate', picked: join(dir, 'Games') })
    expect(plan).toMatchObject({
      to: join(dir, 'Games', 'Emulation'),
      blocked: null,
      hasContent: true,
      bytes: 5,
      files: 1,
      sameDrive: true,
      targetHasContent: false
    })
    const result = await svc.start(plan.to, 'move')
    expect(result).toEqual({ dir: plan.to, moved: true, leftInOld: 0, keptOlder: 0 })
    expect(settings.get().library.emulationDir).toBe(plan.to)
    expect(settings.tryFlush).toHaveBeenCalled()
    expect(before).toHaveBeenCalledWith(from, plan.to)
    expect(after).toHaveBeenCalledWith(from, plan.to)
    expect(holdSync).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
    expect(events.at(-1)).toBe('done')
    expect(await fs.readFile(join(plan.to, 'saves', 'x.sav'), 'utf8')).toBe('12345')
    await expect(fs.stat(join(dir, 'appdata', JOURNAL_FILE))).rejects.toThrow()
  })

  it('a non-empty target: "use as it is" switches without moving anything', async () => {
    const from = join(dir, 'Documents', 'Emulation')
    const target = join(dir, 'D', 'Emulation')
    await fs.mkdir(join(from, 'saves'), { recursive: true })
    await fs.writeFile(join(from, 'saves', 'x.sav'), 'x')
    await fs.mkdir(join(target, 'roms'), { recursive: true })
    const { svc, settings } = service(from)
    const plan = await svc.plan({ kind: 'choose', picked: target })
    expect(plan).toMatchObject({ to: target, targetHasContent: true, targetIsEmulation: true })
    const result = await svc.start(plan.to, 'switch')
    expect(result.moved).toBe(false)
    expect(settings.get().library.emulationDir).toBe(target)
    expect(await fs.readFile(join(from, 'saves', 'x.sav'), 'utf8')).toBe('x')
  })

  it('the default is Documents\\Emulation', async () => {
    const from = join(dir, 'appdata', 'Emulation')
    await fs.mkdir(from, { recursive: true })
    const { svc } = service(from)
    const plan = await svc.plan({ kind: 'default' })
    expect(plan.to).toBe(join(dir, 'Documents', 'Emulation'))
  })

  it('startup recovery: a copy cut short is removed; a checked copy is finished', async () => {
    const from = join(dir, 'Old')
    const to = join(dir, 'New')
    await fs.mkdir(join(stagingDir(to), 'saves'), { recursive: true })
    await fs.mkdir(join(dir, 'appdata'), { recursive: true })
    await fs.mkdir(join(from, 'saves'), { recursive: true })
    const journal = join(dir, 'appdata', JOURNAL_FILE)
    await fs.writeFile(journal, JSON.stringify({ from, to, mode: 'move', phase: 'copying' }))
    const a = service(from)
    await a.svc.recover()
    await expect(fs.stat(stagingDir(to))).rejects.toThrow()
    expect(a.settings.get().library.emulationDir).toBe(from)
    await expect(fs.stat(journal)).rejects.toThrow()

    await fs.mkdir(join(to, 'saves'), { recursive: true })
    await fs.writeFile(journal, JSON.stringify({ from, to, mode: 'move', phase: 'copied' }))
    const b = service(from)
    await b.svc.recover()
    expect(b.settings.get().library.emulationDir).toBe(to)
    await expect(fs.stat(from)).rejects.toThrow()
    expect((await fs.stat(join(to, 'saves'))).isDirectory()).toBe(true)
  })

  it('offers once to move an Emulation folder that is inside the install folder', async () => {
    const inside = join(dir, 'PlayOut', 'Emulation')
    await fs.mkdir(inside, { recursive: true })
    const { svc } = service(inside)
    expect(await svc.offer()).toEqual({
      current: inside,
      suggested: join(dir, 'Documents', 'Emulation')
    })
    // The folder in use may stay where it is until it is moved.
    expect(() => svc.validate(inside)).not.toThrow()
    await svc.answerOffer()
    expect(await svc.offer()).toBeNull()
    const outside = service(join(dir, 'Documents', 'Emulation'))
    expect(await outside.svc.offer()).toBeNull()
  })
})
