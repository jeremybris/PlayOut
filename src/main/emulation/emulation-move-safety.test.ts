import { promises as fs, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings, SettingsPatch } from '../../shared/types'
import { createEmulationMoveService, JOURNAL_FILE } from './emulation-move-service'
import { moveEmulationFolder, type JournalPhase } from './emulation-move'

// Data safety of the Emulation folder move: writes during the copy, junctions into the new place, a commit that fails,
// and startup recovery of a move cut short.

vi.mock('../i18n', () => ({ tMain: (key: string) => key }))

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-move-safety-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const OLD = Date.UTC(2024, 0, 1) / 1000
const NEW = Date.UTC(2025, 0, 1) / 1000

/** Acts out another drive: the rename of the folder itself (named ...Old) fails as across volumes. */
const exdev = async (a: string, b: string): Promise<void> => {
  if (/Old[\\/]?$/.test(a)) {
    const err = new Error('cross-device') as NodeJS.ErrnoException
    err.code = 'EXDEV'
    throw err
  }
  await fs.rename(a, b)
}

async function saveFolder(root: string): Promise<string> {
  const card = join(root, 'saves', 'card.mcd')
  await fs.mkdir(join(root, 'saves'), { recursive: true })
  await fs.writeFile(card, 'OLDSAVE1')
  await fs.utimes(card, OLD, OLD)
  await fs.writeFile(join(root, 'saves', 'other.srm'), 'other')
  return card
}

describe('writes into the old folder during a move', () => {
  it('other drive: a save rewritten (same size) after it was copied is copied again, not lost', async () => {
    const from = join(dir, 'Old')
    const to = join(dir, 'New', 'Emulation')
    const card = await saveFolder(from)
    let rewritten = false
    const out = await moveEmulationFolder(from, to, {
      mode: 'move',
      commit: async () => {},
      rename: exdev,
      onProgress: (tick) => {
        if (!rewritten && tick.phase === 'copying' && tick.current === join('saves', 'card.mcd')) {
          rewritten = true
          // The emulator saves while the copy runs: same size, newer time.
          writeFileSync(card, 'NEWSAVE2')
          utimesSync(card, NEW, NEW)
        }
      }
    })
    expect(rewritten).toBe(true)
    expect(out.leftInOld).toBe(0)
    expect(await fs.readFile(join(to, 'saves', 'card.mcd'), 'utf8')).toBe('NEWSAVE2')
    await expect(fs.stat(from)).rejects.toThrow()
  })

  it('other drive: a save written after the last check stays in the old folder (never deleted)', async () => {
    const from = join(dir, 'Old')
    const to = join(dir, 'New', 'Emulation')
    const card = await saveFolder(from)
    const out = await moveEmulationFolder(from, to, {
      mode: 'move',
      commit: async () => {
        await fs.writeFile(card, 'NEWSAVE2')
        await fs.utimes(card, NEW, NEW)
      },
      rename: exdev
    })
    expect(out.leftInOld).toBe(1)
    expect(await fs.readFile(card, 'utf8')).toBe('NEWSAVE2')
    // Everything else left the old folder.
    await expect(fs.stat(join(from, 'saves', 'other.srm'))).rejects.toThrow()
  })

  it('merge: a source file rewritten after it was copied stays in the old folder', async () => {
    const from = join(dir, 'Old')
    const to = join(dir, 'D', 'Emulation')
    const card = await saveFolder(from)
    await fs.mkdir(join(to, 'roms'), { recursive: true })
    const out = await moveEmulationFolder(from, to, {
      mode: 'merge',
      commit: async () => {
        await fs.writeFile(card, 'NEWSAVE2')
        await fs.utimes(card, NEW, NEW)
      }
    })
    expect(out.leftInOld).toBe(1)
    expect(await fs.readFile(card, 'utf8')).toBe('NEWSAVE2')
    expect(await fs.readFile(join(to, 'saves', 'other.srm'), 'utf8')).toBe('other')
    await expect(fs.stat(join(from, 'saves', 'other.srm'))).rejects.toThrow()
  })
})

describe('junctions into the new place', () => {
  it('merge never copies into itself a folder that is (through a junction) the new place', async () => {
    const from = join(dir, 'a', 'Emulation')
    await fs.mkdir(join(from, 'roms', 'Emulation'), { recursive: true })
    await fs.writeFile(join(from, 'roms', 'Emulation', 'x.txt'), 'x')
    await fs.writeFile(join(from, 'roms', 'game.sfc'), 'rom')
    await fs.symlink(join(from, 'roms'), join(dir, 'link'), 'junction')
    // The new place, named through the junction: really from\roms\Emulation.
    const to = join(dir, 'link', 'Emulation')
    await moveEmulationFolder(from, to, { mode: 'merge', commit: async () => {} })
    // Finished, without Emulation\roms\Emulation\roms\... nesting.
    await expect(fs.stat(join(from, 'roms', 'Emulation', 'roms', 'Emulation'))).rejects.toThrow()
    expect(await fs.readFile(join(from, 'roms', 'Emulation', 'x.txt'), 'utf8')).toBe('x')
    expect(await fs.readFile(join(from, 'roms', 'Emulation', 'roms', 'game.sfc'), 'utf8')).toBe(
      'rom'
    )
  })
})

describe('the move service: commit and recovery', () => {
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
  function service(
    settings: TestSettings,
    extra: Partial<Parameters<typeof createEmulationMoveService>[0]> = {}
  ): ReturnType<typeof createEmulationMoveService> {
    return createEmulationMoveService({
      settings,
      userData: join(dir, 'appdata'),
      documents: join(dir, 'Documents'),
      forbidden: () => [
        { path: join(dir, 'PlayOut'), kind: 'install' },
        { path: join(dir, 'appdata'), kind: 'data' }
      ],
      busy: async () => null,
      emit: () => undefined,
      log: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      },
      progressEveryMs: 0,
      ...extra
    })
  }

  it('refuses a target reached through a junction into the folder in use', async () => {
    const from = join(dir, 'a', 'Emulation')
    await fs.mkdir(join(from, 'roms', 'Emulation'), { recursive: true })
    await fs.writeFile(join(from, 'roms', 'Emulation', 'x.txt'), 'x')
    await fs.symlink(join(from, 'roms'), join(dir, 'link'), 'junction')
    const svc = service(settingsWith(from))
    const plan = await svc.plan({ kind: 'choose', picked: join(dir, 'link', 'Emulation') })
    expect(plan.blocked).toBe('mainEmulationMove.blocked.insideCurrent')
    await expect(svc.start(plan.to, 'merge')).rejects.toThrow('insideCurrent')
    expect((await fs.readdir(join(from, 'roms', 'Emulation'))).sort()).toEqual(['x.txt'])
  })

  it('a settings file that cannot be written: nothing moves and the setting stays', async () => {
    const from = join(dir, 'Old')
    await saveFolder(from)
    const settings = settingsWith(from, false)
    const svc = service(settings, { rename: exdev })
    const to = join(dir, 'New', 'Emulation')
    await expect(svc.start(to, 'move')).rejects.toThrow('mainEmulationMove.saveFailed')
    expect(settings.get().library.emulationDir).toBe(from)
    expect(await fs.readFile(join(from, 'saves', 'card.mcd'), 'utf8')).toBe('OLDSAVE1')
    await expect(fs.stat(to)).rejects.toThrow()
  })

  it('checks again for a running game right before the switch, and rolls back', async () => {
    const from = join(dir, 'Old')
    await saveFolder(from)
    const settings = settingsWith(from)
    let calls = 0
    const svc = service(settings, {
      rename: exdev,
      busy: async () => (++calls > 1 ? 'busy: a game started' : null)
    })
    const to = join(dir, 'New', 'Emulation')
    await expect(svc.start(to, 'move')).rejects.toThrow('busy: a game started')
    expect(settings.get().library.emulationDir).toBe(from)
    expect(await fs.readFile(join(from, 'saves', 'card.mcd'), 'utf8')).toBe('OLDSAVE1')
    await expect(fs.stat(to)).rejects.toThrow()
  })

  it('says a move is under way while it runs (launches and writers wait)', async () => {
    const from = join(dir, 'Old')
    await saveFolder(from)
    let seen: boolean | null = null
    const settings = settingsWith(from)
    const ref: { svc?: ReturnType<typeof createEmulationMoveService> } = {}
    const svc = service(settings, {
      beforeSwitch: async () => {
        seen = ref.svc?.moving() ?? null
      }
    })
    ref.svc = svc
    expect(svc.moving()).toBe(false)
    await svc.start(join(dir, 'New', 'Emulation'), 'move')
    expect(seen).toBe(true)
    expect(svc.moving()).toBe(false)
  })

  it('records rolling-back before removing the copy of a failed switch', async () => {
    const from = join(dir, 'Old')
    const to = join(dir, 'New', 'Emulation')
    await saveFolder(from)
    const phases: JournalPhase[] = []
    await expect(
      moveEmulationFolder(from, to, {
        mode: 'move',
        rename: exdev,
        commit: async () => {
          throw new Error('no')
        },
        journal: { write: async (p) => void phases.push(p) }
      })
    ).rejects.toThrow('no')
    expect(phases).toEqual(['renamed', 'copying', 'copied', 'rolling-back'])
  })

  it('recovery: a "copied" move whose copy is not whole keeps the old folder', async () => {
    const from = join(dir, 'Old')
    const to = join(dir, 'New', 'Emulation')
    await saveFolder(from)
    await fs.mkdir(join(to, 'saves'), { recursive: true })
    await fs.writeFile(join(to, 'saves', 'card.mcd'), 'OLDSAVE1') // other.srm was already removed
    await fs.mkdir(join(dir, 'appdata'), { recursive: true })
    await fs.writeFile(
      join(dir, 'appdata', JOURNAL_FILE),
      JSON.stringify({ from, to, mode: 'move', phase: 'copied', copy: { files: 2, bytes: 13 } })
    )
    const settings = settingsWith(from)
    await service(settings).recover()
    expect(settings.get().library.emulationDir).toBe(from)
    expect(await fs.readFile(join(from, 'saves', 'card.mcd'), 'utf8')).toBe('OLDSAVE1')
    expect(await fs.readFile(join(from, 'saves', 'other.srm'), 'utf8')).toBe('other')
    await expect(fs.stat(to)).rejects.toThrow()
  })

  it('recovery: "rolling-back" removes the copy and keeps the old folder in use', async () => {
    const from = join(dir, 'Old')
    const to = join(dir, 'New', 'Emulation')
    await saveFolder(from)
    await fs.mkdir(join(to, 'saves'), { recursive: true })
    await fs.mkdir(join(dir, 'appdata'), { recursive: true })
    await fs.writeFile(
      join(dir, 'appdata', JOURNAL_FILE),
      JSON.stringify({ from, to, mode: 'move', phase: 'rolling-back' })
    )
    const settings = settingsWith(from)
    await service(settings).recover()
    expect(settings.get().library.emulationDir).toBe(from)
    await expect(fs.stat(to)).rejects.toThrow()
    expect(await fs.readFile(join(from, 'saves', 'card.mcd'), 'utf8')).toBe('OLDSAVE1')
  })

  it('recovery: "cleaning" deletes only old files the new place holds as they are', async () => {
    const from = join(dir, 'Old')
    const to = join(dir, 'New', 'Emulation')
    const card = await saveFolder(from)
    await fs.mkdir(join(to, 'saves'), { recursive: true })
    await fs.writeFile(join(to, 'saves', 'other.srm'), 'other')
    await fs.writeFile(join(to, 'saves', 'card.mcd'), 'OLDSAVE1')
    await fs.utimes(join(to, 'saves', 'card.mcd'), OLD, OLD)
    // Written after the copy: newer than the new place's.
    await fs.writeFile(card, 'NEWSAVE2')
    await fs.utimes(card, NEW, NEW)
    await fs.mkdir(join(dir, 'appdata'), { recursive: true })
    await fs.writeFile(
      join(dir, 'appdata', JOURNAL_FILE),
      JSON.stringify({ from, to, mode: 'move', phase: 'cleaning' })
    )
    const settings = settingsWith(to)
    await service(settings).recover()
    expect(await fs.readFile(card, 'utf8')).toBe('NEWSAVE2')
    await expect(fs.stat(join(from, 'saves', 'other.srm'))).rejects.toThrow()
  })
})
