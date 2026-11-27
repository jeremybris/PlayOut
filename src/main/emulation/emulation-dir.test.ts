import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../../shared/defaults'
import type { Settings, SettingsPatch } from '../../shared/types'
import {
  adoptOldRomsFolder,
  emulationDirOf,
  ensureDefaultEmulationDir,
  keepRomsRootInSync,
  romsRootOf
} from './emulation-dir'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never

let userData: string
beforeEach(async () => {
  userData = await fs.mkdtemp(join(tmpdir(), 'playout-userdata-'))
})
afterEach(async () => {
  await fs.rm(userData, { recursive: true, force: true })
})

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- a test fixture
function settingsWith(library: Partial<Settings['library']>) {
  let current: Settings = {
    ...defaultSettings(),
    library: { ...defaultSettings().library, ...library }
  }
  return {
    get: () => current,
    update: (patch: SettingsPatch) => {
      current = { ...current, library: { ...current.library, ...(patch.library as object) } }
    }
  }
}

describe('the Emulation folder', () => {
  it("is PlayOut's own unless one is chosen", () => {
    expect(emulationDirOf(settingsWith({}).get(), userData)).toBe(join(userData, 'Emulation'))
    expect(emulationDirOf(settingsWith({ emulationDir: 'E:/Emulation' }).get(), userData)).toBe(
      'E:/Emulation'
    )
  })

  it('is made at launch (the ROM folder is left to keepRomsRootInSync)', async () => {
    const settings = settingsWith({})
    const made = await ensureDefaultEmulationDir({ settings, userData, systemIds: ['ps2'], log })
    expect(made?.path).toBe(join(userData, 'Emulation'))
    await fs.access(join(userData, 'Emulation', 'bios', 'ps3'))
    await fs.access(join(userData, 'Emulation', 'roms', 'ps2'))
    await fs.access(join(userData, 'Emulation', 'Updates and DLC', 'PS3', 'dev_hdd0', 'game'))
    await fs.access(join(userData, 'Emulation', 'Updates and DLC', 'Switch'))
    await fs.access(join(userData, 'Emulation', 'Updates and DLC', 'Xbox360'))
    await expect(fs.access(join(userData, 'Emulation', 'roms', 'PS3 HDD'))).rejects.toThrow()
    expect(settings.get().library.romsRoot).toBeNull()
  })

  it('leaves a set ROM folder and a chosen Emulation folder alone', async () => {
    const chosen = settingsWith({ emulationDir: join(userData, 'Mine') })
    expect(
      await ensureDefaultEmulationDir({ settings: chosen, userData, systemIds: [], log })
    ).toBeNull()
    await expect(fs.access(join(userData, 'Emulation'))).rejects.toThrow()
    // A chosen folder that exists only gets Updates and DLC and Recompilations Saves (one that is missing is not made).
    await expect(fs.access(join(userData, 'Mine'))).rejects.toThrow()
    await fs.mkdir(join(userData, 'Mine'))
    await ensureDefaultEmulationDir({ settings: chosen, userData, systemIds: ['ps2'], log })
    expect((await fs.readdir(join(userData, 'Mine'))).sort()).toEqual([
      'Recompilations Saves',
      'Updates and DLC'
    ])
    expect((await fs.readdir(join(userData, 'Mine', 'Updates and DLC'))).sort()).toEqual([
      'PS3',
      'Switch',
      'Xbox360'
    ])
    await fs.access(
      join(userData, 'Mine', 'Updates and DLC', 'PS3', 'dev_hdd0', 'home', '00000001')
    )
    // A chosen folder with a roms folder gets the roms folders of systems added later.
    await fs.mkdir(join(userData, 'Mine', 'roms', 'snes'), { recursive: true })
    await ensureDefaultEmulationDir({ settings: chosen, userData, systemIds: ['ps2'], log })
    expect((await fs.readdir(join(userData, 'Mine', 'roms'))).sort()).toEqual([
      'ps5',
      'snes',
      'switch2'
    ])
    const kept = settingsWith({ romsRoot: 'D:/roms' })
    await ensureDefaultEmulationDir({ settings: kept, userData, systemIds: [], log })
    expect(kept.get().library.romsRoot).toBe('D:/roms')
  })

  it('leaves an old roms\\PS3 HDD where it is at start-up and still makes Updates and DLC', async () => {
    const mine = join(userData, 'Mine')
    const own = join(userData, 'Emulation')
    const file = join('dev_hdd0', 'game', 'BLUS30443', 'PARAM.SFO')
    for (const emulation of [mine, own]) {
      await fs.mkdir(join(emulation, 'roms', 'PS3 HDD', 'dev_hdd0', 'game', 'BLUS30443'), {
        recursive: true
      })
      await fs.writeFile(join(emulation, 'roms', 'PS3 HDD', file), 'update')
    }
    await ensureDefaultEmulationDir({
      settings: settingsWith({ emulationDir: mine }),
      userData,
      systemIds: [],
      log
    })
    await ensureDefaultEmulationDir({ settings: settingsWith({}), userData, systemIds: [], log })
    for (const dir of [mine, own]) {
      expect(await fs.readFile(join(dir, 'roms', 'PS3 HDD', file), 'utf8')).toBe('update')
      await expect(fs.access(join(dir, 'roms', 'PS3 HDD.playout-old'))).rejects.toThrow()
      expect((await fs.readdir(join(dir, 'Updates and DLC'))).sort()).toEqual([
        'PS3',
        'Switch',
        'Xbox360'
      ])
      expect(await fs.readdir(join(dir, 'Updates and DLC', 'PS3', 'dev_hdd0', 'game'))).toEqual([])
      await fs.access(join(dir, 'Updates and DLC', 'PS3', 'dev_hdd0', 'home', '00000001'))
    }
  })
})

describe('the ROM folder', () => {
  /** A settings store like SettingsStore: every update tells the listeners, even an update made inside one. */
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- a test fixture
  function storeWith(library: Partial<Settings['library']>) {
    let current: Settings = {
      ...defaultSettings(),
      library: { ...defaultSettings().library, ...library }
    }
    const listeners = new Set<(settings: Settings) => void>()
    const store = {
      updates: 0,
      get: () => current,
      update: (patch: SettingsPatch) => {
        store.updates++
        current = { ...current, library: { ...current.library, ...(patch.library as object) } }
        for (const listener of listeners) listener(current)
        return current
      },
      onChange: (listener: (settings: Settings) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
    return store
  }

  it("is the Emulation folder's roms folder", () => {
    expect(romsRootOf(storeWith({}).get(), userData)).toBe(join(userData, 'Emulation', 'roms'))
    expect(romsRootOf(storeWith({ emulationDir: 'E:/Emulation' }).get(), userData)).toBe(
      join('E:/Emulation', 'roms')
    )
  })

  it('is set at startup, over an old settings file’s own ROM folder', () => {
    const store = storeWith({ romsRoot: 'D:/My ROMs' })
    keepRomsRootInSync({ settings: store, userData })
    expect(store.get().library.romsRoot).toBe(join(userData, 'Emulation', 'roms'))
    const fresh = storeWith({})
    keepRomsRootInSync({ settings: fresh, userData })
    expect(fresh.get().library.romsRoot).toBe(join(userData, 'Emulation', 'roms'))
  })

  it('follows the Emulation folder when it is chosen or set back to Default, without looping', () => {
    const store = storeWith({})
    const stop = keepRomsRootInSync({ settings: store, userData })
    expect(store.updates).toBe(1)
    store.update({ library: { emulationDir: 'E:/Emulation' } })
    expect(store.get().library.romsRoot).toBe(join('E:/Emulation', 'roms'))
    // The user's update and the sync's own one; the sync's own update finds nothing to change.
    expect(store.updates).toBe(3)
    store.update({ library: { emulationDir: null } })
    expect(store.get().library.romsRoot).toBe(join(userData, 'Emulation', 'roms'))
    // Another setting changing writes nothing more.
    store.update({ library: { showHidden: true } })
    expect(store.updates).toBe(6)
    // A ROM folder written by anything else is put back.
    store.update({ library: { romsRoot: 'D:/elsewhere' } })
    expect(store.get().library.romsRoot).toBe(join(userData, 'Emulation', 'roms'))
    stop()
    store.update({ library: { emulationDir: 'F:/Emu' } })
    expect(store.get().library.romsRoot).toBe(join(userData, 'Emulation', 'roms'))
  })
})

describe("an old settings file's own ROM folder", () => {
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- a test fixture
  function storeWith(library: Partial<Settings['library']>) {
    const base = settingsWith(library)
    const listeners = new Set<(settings: Settings) => void>()
    return {
      get: base.get,
      update: (patch: SettingsPatch) => {
        base.update(patch)
        for (const listener of listeners) listener(base.get())
      },
      onChange: (listener: (settings: Settings) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
  }

  it('named roms (any case) makes the folder holding it the Emulation folder, so the ROMs stay put', () => {
    const store = storeWith({ romsRoot: join('C:/Users/Me/Desktop', 'Roms') })
    keepRomsRootInSync({ settings: store, userData })
    expect(store.get().library.emulationDir).toBe(join('C:/Users/Me/Desktop'))
    // The same folder (Windows paths compare without case).
    expect(store.get().library.romsRoot!.toLowerCase()).toBe(
      join('C:/Users/Me/Desktop', 'Roms').toLowerCase()
    )
  })

  it('is left to the scan when it is named otherwise or an Emulation folder is chosen', () => {
    const other = storeWith({ romsRoot: 'D:/My ROMs' })
    expect(adoptOldRomsFolder({ settings: other, userData })).toBeNull()
    expect(other.get().library.emulationDir).toBeNull()
    const chosen = storeWith({ romsRoot: 'D:/roms', emulationDir: 'E:/Emu' })
    expect(adoptOldRomsFolder({ settings: chosen, userData })).toBeNull()
    expect(chosen.get().library.emulationDir).toBe('E:/Emu')
    // Already the Default Emulation folder's roms folder: nothing to adopt.
    const current = storeWith({ romsRoot: join(userData, 'Emulation', 'roms') })
    expect(adoptOldRomsFolder({ settings: current, userData })).toBeNull()
  })

  it('is adopted only at startup: setting the Emulation folder back to Default later goes to Default', () => {
    const store = storeWith({})
    keepRomsRootInSync({ settings: store, userData })
    store.update({ library: { emulationDir: 'E:/Emulation' } })
    store.update({ library: { emulationDir: null } })
    expect(store.get().library.emulationDir).toBeNull()
    expect(store.get().library.romsRoot).toBe(join(userData, 'Emulation', 'roms'))
  })
})
