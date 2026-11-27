import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import { defaultSettings, SETTINGS_VERSION } from '../../shared/defaults'
import {
  libraryTabDefSchema,
  normalizeSettings,
  parseSettingsPatch,
  settingsPatchSchema
} from './settings-schema'
import { SettingsStore } from './settings-store'

describe('settingsPatchSchema', () => {
  it('accepts every patch shape the Settings screens send', () => {
    const ok = [
      {},
      { library: { romsRoot: 'D:\\ROMs' } },
      { library: { romsRoot: null, esdeHome: null } },
      { library: { sources: { ...defaultSettings().library.sources, steam: { enabled: false } } } },
      { library: { sources: { steam: { enabled: false } } } },
      { emulators: { overrides: { RETROARCH: 'C:\\RetroArch\\retroarch.exe' } } },
      { emulators: { coresDir: null } },
      { emulators: { preferred: { snes: 'RETROARCH-SNES9X' } } },
      { scrapers: { steamgriddb: { apiKey: 'k' } } },
      { scrapers: { igdb: { clientId: 'a', clientSecret: 'b' } } },
      { scrapers: { screenscraper: { devId: '', devPassword: '', user: 'u', password: 'p' } } },
      { scrapers: { steam: { apiKey: '', steamId64: '76561198000000000' } } },
      { scrapers: { hltb: { enabled: false } } },
      { scrapers: { autoScrape: false, region: 'eu' } },
      { scrapers: { artPriority: ['steam', 'steamgriddb'] } },
      { ui: { recentCount: 20, startFullscreen: false } },
      { input: { deadzone: 0.05, repeatDelayMs: 150, repeatRateMs: 300 } },
      { system: { launchAtLogin: true } },
      { system: { confirmPowerActions: false } },
      { system: { minimizeToTray: true } }
    ]
    for (const patch of ok)
      expect(settingsPatchSchema.safeParse(patch).success, JSON.stringify(patch)).toBe(true)
  })

  it('rejects nulls, wrong types, out-of-range numbers and unknown keys', () => {
    const bad = [
      null,
      'x',
      [],
      { version: 2 },
      { library: null },
      { library: 'x' },
      { library: { sources: null } },
      { library: { sources: { steam: { enabled: 'yes' } } } },
      { library: { sources: { nope: { enabled: true } } } },
      { library: { romsRoot: 5 } },
      { library: { romsRoot: 'x'.repeat(5000) } },
      { library: { showHidden: 1 } },
      { library: { extra: true } },
      { emulators: { overrides: { RETROARCH: null } } },
      { emulators: { overrides: ['a'] } },
      { scrapers: { steamgriddb: { apiKey: 1 } } },
      { scrapers: { steamgriddb: { apiKey: 'k', other: 1 } } },
      { scrapers: { region: 'xx' } },
      { scrapers: { language: 'fr' } },
      { scrapers: { artPriority: ['nope'] } },
      { scrapers: { artPriority: 'steam' } },
      { ui: { recentCount: 'x' } },
      { ui: { recentCount: 3 } },
      { ui: { recentCount: 41 } },
      { ui: { recentCount: 10.5 } },
      { input: { deadzone: 1 } },
      { input: { deadzone: -0.1 } },
      { input: { repeatDelayMs: 99999 } },
      { system: 'x' },
      { system: 7 },
      { system: { launchAtLogin: 'true' } },
      { system: { launchAtLogin: null } },
      { system: { minimizeToTray: 'yes' } }
    ]
    for (const patch of bad) {
      expect(settingsPatchSchema.safeParse(patch).success, JSON.stringify(patch)).toBe(false)
      expect(() => parseSettingsPatch(patch), JSON.stringify(patch)).toThrow()
    }
  })
})

describe('normalizeSettings', () => {
  it('returns defaults for an empty object and null for a non-object', () => {
    // Defaults, except hosting: on only for a new install (no file), off for any file read back.
    const defaults = defaultSettings()
    defaults.streaming.hostEnabled = false
    expect(normalizeSettings({})).toEqual(defaults)
    expect(normalizeSettings(null)).toBeNull()
    expect(normalizeSettings('x')).toBeNull()
    expect(normalizeSettings([])).toBeNull()
  })

  it('drops the old emulators.setupDone flag (setup completion lives in the emulators manifest)', () => {
    const legacy = {
      emulators: {
        overrides: { RPCS3: 'C:\\RPCS3\\rpcs3.exe' },
        coresDir: null,
        preferred: {},
        setupDone: true
      }
    }
    expect(normalizeSettings(legacy)!.emulators).toEqual({
      overrides: { RPCS3: 'C:\\RPCS3\\rpcs3.exe' },
      coresDir: null,
      preferred: {},
      // Automatic PS3 updates are on for files from before the setting existed.
      ps3AutoUpdate: true
    })
    expect(() => parseSettingsPatch({ emulators: { setupDone: true } })).toThrow()
  })

  it('turns automatic PS3 updates on by default, keeps a choice and repairs a malformed one', () => {
    expect(defaultSettings().emulators.ps3AutoUpdate).toBe(true)
    const old = { emulators: { overrides: {}, coresDir: null, preferred: {} } }
    expect(normalizeSettings(old)!.emulators.ps3AutoUpdate).toBe(true)
    expect(
      normalizeSettings({ emulators: { ...old.emulators, ps3AutoUpdate: false } })!.emulators
        .ps3AutoUpdate
    ).toBe(false)
    expect(
      normalizeSettings({ emulators: { ...old.emulators, ps3AutoUpdate: 'no' } })!.emulators
        .ps3AutoUpdate
    ).toBe(true)
    expect(parseSettingsPatch({ emulators: { ps3AutoUpdate: false } })).toEqual({
      emulators: { ps3AutoUpdate: false }
    })
    expect(() => parseSettingsPatch({ emulators: { ps3AutoUpdate: 'yes' } })).toThrow()
  })

  it('Trim Games is off by default and for files from before it existed', () => {
    expect(defaultSettings().library.trimGames).toBe(false)
    expect(normalizeSettings({ library: { romsRoot: null } })!.library.trimGames).toBe(false)
    expect(normalizeSettings({ library: { trimGames: true } })!.library.trimGames).toBe(true)
    expect(normalizeSettings({ library: { trimGames: 'yes' } })!.library.trimGames).toBe(false)
    expect(parseSettingsPatch({ library: { trimGames: true } })).toEqual({
      library: { trimGames: true }
    })
    expect(() => parseSettingsPatch({ library: { trimGames: 1 } })).toThrow()
  })

  it('copying the saves of games you added is on by default and for files from before it existed', () => {
    expect(defaultSettings().library.copyPcSaves).toBe(true)
    expect(normalizeSettings({ library: { romsRoot: null } })!.library.copyPcSaves).toBe(true)
    expect(normalizeSettings({ library: { copyPcSaves: false } })!.library.copyPcSaves).toBe(false)
    expect(parseSettingsPatch({ library: { copyPcSaves: false } })).toEqual({
      library: { copyPcSaves: false }
    })
    expect(() => parseSettingsPatch({ library: { copyPcSaves: 'no' } })).toThrow()
  })

  it('the PlayOut database is used and contributed to by default, and a malformed choice is repaired', () => {
    expect(defaultSettings().scrapers.gameDatabase).toEqual({ enabled: true, contribute: true })
    // A file from before the setting existed.
    expect(normalizeSettings({ scrapers: { autoScrape: true } })!.scrapers.gameDatabase).toEqual({
      enabled: true,
      contribute: true
    })
    const off = { enabled: true, contribute: false }
    expect(normalizeSettings({ scrapers: { gameDatabase: off } })!.scrapers.gameDatabase).toEqual(
      off
    )
    expect(
      normalizeSettings({ scrapers: { gameDatabase: { enabled: 'no', contribute: false } } })!
        .scrapers.gameDatabase
    ).toEqual({ enabled: true, contribute: true })
    expect(parseSettingsPatch({ scrapers: { gameDatabase: off } })).toEqual({
      scrapers: { gameDatabase: off }
    })
    expect(() => parseSettingsPatch({ scrapers: { gameDatabase: { enabled: false } } })).toThrow()
    expect(() =>
      parseSettingsPatch({ scrapers: { gameDatabase: { ...off, other: true } } })
    ).toThrow()
    expect(Object.keys(defaultSettings().scrapers)).toContain('gameDatabase')
  })

  it('Minimize to tray defaults to off for older files and is repaired when malformed', () => {
    const legacy = { system: { launchAtLogin: true, confirmPowerActions: false } }
    expect(normalizeSettings(legacy)!.system).toEqual({
      // No language yet: the next start picks one (main/i18n).
      language: '',
      launchAtLogin: true,
      confirmPowerActions: false,
      minimizeToTray: false,
      // Enhanced Sleep/Wake is on for files from before it existed too.
      enhancedSleepWake: true,
      // Wake with the Xbox button is off by default.
      controllerWake: false
    })
    expect(normalizeSettings({ system: { minimizeToTray: 'yes' } })!.system.minimizeToTray).toBe(
      false
    )
    expect(normalizeSettings({ system: { minimizeToTray: true } })!.system.minimizeToTray).toBe(
      true
    )
  })

  it('keeps valid values and repairs every malformed field from defaults', () => {
    const raw = {
      version: 'old',
      library: {
        romsRoot: 5,
        showUninstalled: true,
        sources: { steam: { enabled: false }, bogus: { enabled: true }, gog: { enabled: 'x' } },
        esdeHome: 'C:\\ES-DE'
      },
      emulators: {
        overrides: { RETROARCH: 'C:\\ra.exe', BROKEN: 42, '': 'x' },
        coresDir: [],
        preferred: { snes: 'RETROARCH-SNES9X', nes: null }
      },
      scrapers: {
        steamgriddb: { apiKey: 'key' },
        igdb: { clientId: 'id' },
        region: 'jp',
        artPriority: ['steam', 'invalid'],
        autoScrape: 'no'
      },
      ui: { recentCount: 'x', clock24h: true },
      input: { deadzone: 2, repeatRateMs: 80 },
      system: null,
      unknownSection: { a: 1 }
    }
    const result = normalizeSettings(raw)!
    const d = defaultSettings()
    expect(result.version).toBe(SETTINGS_VERSION)
    expect(result.library.romsRoot).toBeNull()
    expect(result.library.showUninstalled).toBe(true)
    expect(result.library.esdeHome).toBe('C:\\ES-DE')
    expect(result.library.sources.steam).toEqual({ enabled: false })
    expect(result.library.sources.gog).toEqual({ enabled: true })
    expect(result.library.sources.rom).toEqual({ enabled: true })
    expect('bogus' in result.library.sources).toBe(false)
    expect(result.emulators.overrides).toEqual({ RETROARCH: 'C:\\ra.exe' })
    expect(result.emulators.coresDir).toBeNull()
    expect(result.emulators.preferred).toEqual({ snes: 'RETROARCH-SNES9X' })
    expect(result.scrapers.steamgriddb.apiKey).toBe('key')
    expect(result.scrapers.igdb).toEqual(d.scrapers.igdb)
    expect(result.scrapers.region).toBe('jp')
    expect(result.scrapers.artPriority).toEqual(d.scrapers.artPriority)
    expect(result.scrapers.autoScrape).toBe(true)
    expect(result.ui.recentCount).toBe(d.ui.recentCount)
    expect(result.ui.clock24h).toBe(true)
    expect(result.input.deadzone).toBe(d.input.deadzone)
    expect(result.input.repeatRateMs).toBe(80)
    expect(result.system).toEqual(d.system)
    expect('unknownSection' in result).toBe(false)
  })

  it("keeps the Library tabs' scroll positions and drops broken ones", () => {
    const result = normalizeSettings({
      version: 2,
      ui: {
        libraryScroll: {
          a: { gameId: 'g12', offset: 80 },
          b: { gameId: '', offset: 10 },
          c: { gameId: 'g1', offset: -5 },
          d: 'g1'
        }
      }
    })!
    expect(result.ui.libraryScroll).toEqual({ a: { gameId: 'g12', offset: 80 } })
    expect(normalizeSettings({ version: 2 })!.ui.libraryScroll).toEqual({})
    expect(() =>
      parseSettingsPatch({ ui: { libraryScroll: { a: { gameId: 'g1', offset: 3 } } } })
    ).not.toThrow()
  })

  it('keeps the Library cover size on a step: default 1, old files 1, others snapped or clamped', () => {
    expect(defaultSettings().ui.libraryCoverScale).toBe(1)
    expect(normalizeSettings({ version: 2, ui: {} })!.ui.libraryCoverScale).toBe(1)
    expect(normalizeSettings({ ui: { libraryCoverScale: 1.3 } })!.ui.libraryCoverScale).toBe(1.3)
    expect(normalizeSettings({ ui: { libraryCoverScale: 0.83 } })!.ui.libraryCoverScale).toBe(0.8)
    expect(normalizeSettings({ ui: { libraryCoverScale: 5 } })!.ui.libraryCoverScale).toBe(1.6)
    expect(normalizeSettings({ ui: { libraryCoverScale: 0 } })!.ui.libraryCoverScale).toBe(0.6)
    expect(normalizeSettings({ ui: { libraryCoverScale: 'big' } })!.ui.libraryCoverScale).toBe(1)
    expect(parseSettingsPatch({ ui: { libraryCoverScale: 1.16 } }).ui?.libraryCoverScale).toBe(1.15)
    expect(() => parseSettingsPatch({ ui: { libraryCoverScale: 'x' } })).toThrow()
  })

  it('"Icons for tabs" is on by default and for files from before it, keeps a choice and repairs a malformed one', () => {
    expect(defaultSettings().ui.libraryTabIcons).toBe(true)
    expect(normalizeSettings({ version: 4, ui: {} })!.ui.libraryTabIcons).toBe(true)
    expect(normalizeSettings({ ui: { libraryTabIcons: false } })!.ui.libraryTabIcons).toBe(false)
    expect(normalizeSettings({ ui: { libraryTabIcons: 'yes' } })!.ui.libraryTabIcons).toBe(true)
    expect(parseSettingsPatch({ ui: { libraryTabIcons: false } }).ui?.libraryTabIcons).toBe(false)
    expect(() => parseSettingsPatch({ ui: { libraryTabIcons: 1 } })).toThrow()
  })

  it('migrates a version-1 showUninstalled:false to true and keeps a version-2 false', () => {
    const v1 = normalizeSettings({ version: 1, library: { showUninstalled: false } })!
    expect(v1.library.showUninstalled).toBe(true)
    expect(v1.version).toBe(SETTINGS_VERSION)
    const unversioned = normalizeSettings({ library: { showUninstalled: false } })!
    expect(unversioned.library.showUninstalled).toBe(true)
    const v2 = normalizeSettings({ version: 2, library: { showUninstalled: false } })!
    expect(v2.library.showUninstalled).toBe(false)
    const v3 = normalizeSettings({ version: 3, library: { showUninstalled: false } })!
    expect(v3.library.showUninstalled).toBe(false)
  })

  it('turns an older default power profile of none into auto (Dynamic TDP with the helper) and keeps choices', () => {
    const v2 = normalizeSettings({ version: 2, performance: { defaultProfile: 'none' } })!
    expect(v2.performance.defaultProfile).toBe('auto')
    const chosen = normalizeSettings({ version: 2, performance: { defaultProfile: 'silent' } })!
    expect(chosen.performance.defaultProfile).toBe('silent')
    const v3 = normalizeSettings({ version: 3, performance: { defaultProfile: 'none' } })!
    expect(v3.performance.defaultProfile).toBe('none')
    // Version 4: "Home button opens the overlay" is switched on once; turned off after that, it stays off.
    expect(
      normalizeSettings({ version: 3, input: { homeButtonEnabled: false } })!.input
        .homeButtonEnabled
    ).toBe(true)
    expect(
      normalizeSettings({ version: 4, input: { homeButtonEnabled: false } })!.input
        .homeButtonEnabled
    ).toBe(false)
    expect(normalizeSettings({ version: 2 })!.performance.dynamic).toEqual({
      targetFps: 60,
      minWatts: null,
      maxWatts: null
    })
    const bad = normalizeSettings({
      version: 3,
      performance: { dynamic: { targetFps: 1000, minWatts: null, maxWatts: null } }
    })!
    expect(bad.performance.dynamic.targetFps).toBe(60)
    expect(() =>
      parseSettingsPatch({
        performance: {
          defaultProfile: 'dynamic',
          dynamic: { targetFps: 45, minWatts: 8, maxWatts: null }
        }
      })
    ).not.toThrow()
  })

  it('defaults and validates the overlay extras (performance overlay, sync, CPU boost overrides)', () => {
    const old = normalizeSettings({ version: 3, performance: { defaultProfile: 'silent' } })!
    expect(old.performance).toMatchObject({
      perfOverlay: 0,
      syncFpsToRefresh: false,
      boostOverrides: {}
    })
    const kept = normalizeSettings({
      version: 3,
      performance: { perfOverlay: 2, syncFpsToRefresh: true, boostOverrides: { balanced: false } }
    })!
    expect(kept.performance).toMatchObject({
      perfOverlay: 2,
      syncFpsToRefresh: true,
      boostOverrides: { balanced: false }
    })
    const bad = normalizeSettings({
      version: 3,
      performance: { perfOverlay: 4, syncFpsToRefresh: 'yes', boostOverrides: { custom: true } }
    })!
    expect(bad.performance).toMatchObject({
      perfOverlay: 0,
      syncFpsToRefresh: false,
      boostOverrides: {}
    })
    expect(() =>
      parseSettingsPatch({
        performance: { perfOverlay: 3, syncFpsToRefresh: true, boostOverrides: { silent: true } }
      })
    ).not.toThrow()
    for (const performance of [
      { perfOverlay: 1.5 },
      { perfOverlay: -1 },
      { syncFpsToRefresh: null },
      { boostOverrides: { custom: false } },
      { boostOverrides: { balanced: 'on' } }
    ])
      expect(() => parseSettingsPatch({ performance }), JSON.stringify(performance)).toThrow()
  })

  it('keeps "Free up memory" off unless it was turned on, with no migration', () => {
    expect(defaultSettings().performance.memory).toEqual({ enabled: false })
    // A settings.json from before the setting: filled from the defaults.
    const old = normalizeSettings({ version: 4, performance: { perGame: false } })!
    expect(old.performance.memory).toEqual({ enabled: false })
    expect(old.performance.perGame).toBe(false)
    const on = normalizeSettings({ performance: { memory: { enabled: true } } })!
    expect(on.performance.memory).toEqual({ enabled: true })
    for (const memory of [{ enabled: 'yes' }, { enabled: true, aggressive: true }, true, null, {}])
      expect(
        normalizeSettings({ performance: { memory } })!.performance.memory,
        JSON.stringify(memory)
      ).toEqual({ enabled: false })
    expect(parseSettingsPatch({ performance: { memory: { enabled: true } } })).toEqual({
      performance: { memory: { enabled: true } }
    })
    for (const memory of [{ enabled: 1 }, { enabled: true, services: 'stop' }, {}, null, true])
      expect(
        () => parseSettingsPatch({ performance: { memory } }),
        JSON.stringify(memory)
      ).toThrow()
  })

  it('round-trips valid settings untouched', () => {
    const s = defaultSettings()
    s.library.romsRoot = 'D:\\ROMs'
    s.library.sources.xbox.enabled = false
    s.emulators.overrides['DOLPHIN'] = 'C:\\Dolphin\\Dolphin.exe'
    s.scrapers.artPriority = ['igdb', 'steam']
    s.ui.recentCount = 8
    expect(normalizeSettings(JSON.parse(JSON.stringify(s)))).toEqual(s)
  })
})

describe('SettingsStore', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'playout-settings-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('repairs a hand-edited settings.json on load instead of merging it verbatim', async () => {
    const file = join(dir, 'settings.json')
    await fs.writeFile(
      file,
      JSON.stringify({
        version: 1,
        library: { sources: null, romsRoot: 5, showHidden: true },
        ui: { recentCount: null }
      })
    )
    const store = new SettingsStore(file)
    const loaded = await store.load()
    expect(loaded.library.sources).toEqual(defaultSettings().library.sources)
    expect(loaded.library.romsRoot).toBeNull()
    expect(loaded.library.showHidden).toBe(true)
    expect(loaded.ui.recentCount).toBe(defaultSettings().ui.recentCount)
    // Nothing was treated as corrupt: no .bak, the user's valid values survived.
    expect(await fs.readdir(dir)).toEqual(['settings.json'])
  })
})

describe('ui.libraryTabs', () => {
  const tab = (id: string, platforms: string[] = []): Record<string, unknown> => ({
    id,
    filters: {
      platforms,
      stores: [],
      genres: [],
      eras: [],
      tags: [],
      sizes: [],
      hltb: [],
      hidden: false,
      favorites: false
    },
    sort: 'playable',
    sortReversed: false
  })

  it('accepts a migrated Other tab holding every system', () => {
    const systems = Array.from({ length: 195 }, (_, i) => `system-${i}`)
    expect(() => parseSettingsPatch({ ui: { libraryTabs: [tab('other', systems)] } })).not.toThrow()
  })

  it('repairs the tabs one by one when loading', () => {
    const base = defaultSettings()
    const raw = {
      ...base,
      ui: { ...base.ui, libraryTabs: [tab('a'), { id: 'broken' }, tab('a'), tab('b')] }
    }
    expect(normalizeSettings(raw)!.ui.libraryTabs!.map((t) => t.id)).toEqual(['a', 'b'])
  })
})

describe('library.showDuplicates', () => {
  it('is off by default and for settings saved before it', () => {
    expect(defaultSettings().library.showDuplicates).toBe(false)
    const base = defaultSettings()
    const oldLibrary: Partial<typeof base.library> = { ...base.library }
    delete oldLibrary.showDuplicates
    expect(normalizeSettings({ ...base, library: oldLibrary })!.library.showDuplicates).toBe(false)
    expect(
      normalizeSettings({ ...base, library: { ...base.library, showDuplicates: true } })!.library
        .showDuplicates
    ).toBe(true)
  })
})

describe('ui.libraryTabs coop filter', () => {
  it('reads tabs saved before the Co-Op filter as off', () => {
    const base = defaultSettings()
    const old = {
      id: 'a',
      filters: {
        platforms: [],
        stores: [],
        genres: [],
        eras: [],
        tags: [],
        sizes: [],
        hltb: [],
        hidden: false,
        favorites: false
      },
      sort: 'playable',
      sortReversed: false
    }
    const raw = { ...base, ui: { ...base.ui, libraryTabs: [old] } }
    expect(normalizeSettings(raw)!.ui.libraryTabs![0]!.filters.coop).toBe(false)
    // Saved before the Controls filter: none picked.
    expect(normalizeSettings(raw)!.ui.libraryTabs![0]!.filters.controls).toEqual([])
    expect(normalizeSettings(raw)!.ui.libraryTabs![0]!.filters.players).toEqual([])
    expect(normalizeSettings(raw)!.ui.libraryTabs![0]!.filters.online).toEqual([])
    // Saved before the Recompilations filter too.
    expect(normalizeSettings(raw)!.ui.libraryTabs![0]!.filters.recomp).toBe(false)
  })
})

describe('ui.libraryTabs developers and publishers', () => {
  const filters = {
    platforms: [],
    stores: [],
    genres: [],
    eras: [],
    tags: [],
    sizes: [],
    hltb: [],
    hidden: false,
    favorites: false
  }
  const load = (tabFilters: Record<string, unknown>): Record<string, unknown> | undefined => {
    const base = defaultSettings()
    const tab = { id: 'ea', filters: tabFilters, sort: 'title-asc', sortReversed: false }
    const raw = { ...base, ui: { ...base.ui, libraryTabs: [tab] } }
    return normalizeSettings(raw)!.ui.libraryTabs![0]?.filters as unknown as
      Record<string, unknown> | undefined
  }

  it('has none on tabs saved before them', () => {
    expect(load(filters)).not.toHaveProperty('developers')
    expect(load(filters)).not.toHaveProperty('publishers')
  })

  it('leaves empty lists out, so a tab without them is byte-for-byte what an older PlayOut accepts', () => {
    const old = {
      id: 'ea',
      filters: {
        platforms: ['steam'],
        stores: [],
        genres: [],
        eras: [],
        tags: ['rpg'],
        sizes: [],
        hltb: [],
        controls: [],
        players: [],
        online: [],
        hidden: false,
        favorites: false,
        coop: false,
        recomp: false
      },
      sort: 'title-asc',
      sortReversed: false,
      playableFirst: true
    }
    // Filters > Controls > Touch is a choice like the others: a tab with it loads with it.
    const touch = { ...old, filters: { ...old.filters, controls: ['touch'] } }
    expect(libraryTabDefSchema.parse(touch).filters.controls).toEqual(['touch'])
    // As saved by 0.9.41 (no developer / publisher keys): the same JSON back.
    expect(JSON.stringify(libraryTabDefSchema.parse(old))).toBe(JSON.stringify(old))
    // Empty lists (a renderer or peer that wrote them) are dropped.
    const empty = { ...old, filters: { ...old.filters, developers: [], publishers: [] } }
    expect(JSON.stringify(libraryTabDefSchema.parse(empty))).toBe(JSON.stringify(old))
    // A tab with a developer / publisher filter keeps its lists.
    const withCreators = {
      ...old,
      filters: { ...old.filters, developers: ['Atlus'], publishers: ['Sega'] }
    }
    expect(libraryTabDefSchema.parse(withCreators)).toEqual(withCreators)
  })

  it('turns the one developer / publisher name of a tab saved before 0.9.42 into a list of one', () => {
    const loaded = load({
      ...filters,
      developer: 'EA Redwood Shores',
      publisher: 'Electronic Arts'
    })
    expect(loaded).toMatchObject({
      developers: ['EA Redwood Shores'],
      publishers: ['Electronic Arts']
    })
    expect(loaded).not.toHaveProperty('developer')
    expect(loaded).not.toHaveProperty('publisher')
    // An empty old name (the button turned off) is none.
    const none = load({ ...filters, developer: '', publisher: '' })
    expect(none).not.toHaveProperty('developers')
    expect(none).not.toHaveProperty('publishers')
    expect(none).not.toHaveProperty('developer')
  })

  it('keeps the lists, and accepts a patch with them', () => {
    expect(load({ ...filters, developers: ['Atlus', 'Sega'], publishers: ['Sega'] })).toMatchObject(
      { developers: ['Atlus', 'Sega'], publishers: ['Sega'] }
    )
    const tab = {
      id: 'a',
      filters: { ...filters, developers: ['Atlus'], publishers: [] },
      sort: 'title-asc',
      sortReversed: false
    }
    expect(() => parseSettingsPatch({ ui: { libraryTabs: [tab] } })).not.toThrow()
    // An old peer's tab (the Library tabs sync) with the single name is still read.
    const old = { ...tab, filters: { ...filters, developer: 'Atlus' } }
    expect(() => parseSettingsPatch({ ui: { libraryTabs: [old] } })).not.toThrow()
    const bad = { ...tab, filters: { ...filters, developers: [''] } }
    expect(() => parseSettingsPatch({ ui: { libraryTabs: [bad] } })).toThrow()
  })
})

describe('ui.libraryTabs playable first', () => {
  const filters = {
    platforms: [],
    stores: [],
    genres: [],
    eras: [],
    tags: [],
    sizes: [],
    hltb: [],
    hidden: false,
    favorites: false
  }
  const load = (tab: Record<string, unknown>): Record<string, unknown> => {
    const base = defaultSettings()
    const raw = { ...base, ui: { ...base.ui, libraryTabs: [tab] } }
    return normalizeSettings(raw)!.ui.libraryTabs![0]! as unknown as Record<string, unknown>
  }

  it('turns the removed Playable First sort into Recently played with playable first on', () => {
    expect(load({ id: 'a', filters, sort: 'playable', sortReversed: false })).toMatchObject({
      sort: 'recent',
      sortReversed: false,
      playableFirst: true
    })
    // reversed Playable First (not-installed first) has no match: it loads unreversed
    expect(load({ id: 'a', filters, sort: 'playable', sortReversed: true })).toMatchObject({
      sort: 'recent',
      sortReversed: false,
      playableFirst: true
    })
  })

  it('has playable first on for tabs saved before it, and keeps a saved choice and sort', () => {
    expect(load({ id: 'a', filters, sort: 'size', sortReversed: true })).toMatchObject({
      sort: 'size',
      sortReversed: true,
      playableFirst: true
    })
    expect(
      load({ id: 'a', filters, sort: 'title-asc', sortReversed: false, playableFirst: false })
    ).toMatchObject({ sort: 'title-asc', playableFirst: false })
  })

  it('accepts a patch with the button, and still refuses an unknown sort', () => {
    const tab = { id: 'a', filters, sort: 'release', sortReversed: false, playableFirst: false }
    expect(() => parseSettingsPatch({ ui: { libraryTabs: [tab] } })).not.toThrow()
    // The Active Players sort.
    expect(() =>
      parseSettingsPatch({ ui: { libraryTabs: [{ ...tab, sort: 'players', sortReversed: true }] } })
    ).not.toThrow()
    expect(load({ id: 'a', filters, sort: 'players', sortReversed: true })).toMatchObject({
      sort: 'players',
      sortReversed: true
    })
    // The Reviews sort.
    expect(() =>
      parseSettingsPatch({ ui: { libraryTabs: [{ ...tab, sort: 'reviews', sortReversed: true }] } })
    ).not.toThrow()
    expect(load({ id: 'a', filters, sort: 'reviews', sortReversed: true })).toMatchObject({
      sort: 'reviews',
      sortReversed: true
    })
    // The Difficulty sort.
    expect(() =>
      parseSettingsPatch({
        ui: { libraryTabs: [{ ...tab, sort: 'difficulty', sortReversed: true }] }
      })
    ).not.toThrow()
    expect(load({ id: 'a', filters, sort: 'difficulty', sortReversed: true })).toMatchObject({
      sort: 'difficulty',
      sortReversed: true
    })
    // The H.L.T.B. sort.
    expect(() =>
      parseSettingsPatch({ ui: { libraryTabs: [{ ...tab, sort: 'hltb', sortReversed: true }] } })
    ).not.toThrow()
    expect(load({ id: 'a', filters, sort: 'hltb', sortReversed: true })).toMatchObject({
      sort: 'hltb',
      sortReversed: true
    })
    expect(() => parseSettingsPatch({ ui: { libraryTabs: [{ ...tab, sort: 'nope' }] } })).toThrow()
  })
})

describe('streaming hosting and login sharing defaults', () => {
  const before = {
    hostEnabled: false,
    hostPort: 47900,
    showHostGames: true,
    resolution: 'auto',
    fps: 60,
    bitrateKbps: 0,
    syncEmulation: true
  }

  it('hosts and shares logins by default on a new install', () => {
    expect(defaultSettings().streaming.hostEnabled).toBe(true)
    expect(defaultSettings().streaming.shareLogins).toBe(true)
  })

  it('keeps hosting off for an existing file that never chose it, or holds a malformed value', () => {
    // An existing settings.json (anything normalizeSettings reads) is not a new install.
    expect(normalizeSettings({})!.streaming).toMatchObject({
      hostEnabled: false,
      shareLogins: true
    })
    const withoutHost: Record<string, unknown> = { ...before }
    delete withoutHost.hostEnabled
    expect(normalizeSettings({ streaming: withoutHost })!.streaming.hostEnabled).toBe(false)
    expect(normalizeSettings({ streaming: 'x' })!.streaming.hostEnabled).toBe(false)
    for (const bad of ['yes', 1, null])
      expect(
        normalizeSettings({ streaming: { ...before, hostEnabled: bad } })!.streaming.hostEnabled
      ).toBe(false)
  })

  it('keeps hosting off for settings saved with it off, and fills in Share my logins', () => {
    const streaming = normalizeSettings({ streaming: before })!.streaming
    expect(streaming.hostEnabled).toBe(false)
    expect(streaming.shareLogins).toBe(true)
    expect(streaming).toEqual({
      ...before,
      shareLogins: true,
      syncLibraryTabs: true,
      syncFavorites: true,
      syncPlaytime: true
    })
    expect(
      normalizeSettings({ streaming: { ...before, hostEnabled: true } })!.streaming.hostEnabled
    ).toBe(true)
  })

  it('keeps Share my logins off once switched off, and repairs a malformed one', () => {
    expect(
      normalizeSettings({ streaming: { ...before, shareLogins: false } })!.streaming.shareLogins
    ).toBe(false)
    expect(
      normalizeSettings({ streaming: { ...before, shareLogins: 'no' } })!.streaming.shareLogins
    ).toBe(true)
    expect(parseSettingsPatch({ streaming: { shareLogins: false } })).toEqual({
      streaming: { shareLogins: false }
    })
    expect(() => parseSettingsPatch({ streaming: { shareLogins: 'yes' } })).toThrow()
  })

  it('syncs the Library tabs by default (older files too), and keeps the switch off once off', () => {
    expect(defaultSettings().streaming.syncLibraryTabs).toBe(true)
    expect(normalizeSettings({ streaming: before })!.streaming.syncLibraryTabs).toBe(true)
    expect(
      normalizeSettings({ streaming: { ...before, syncLibraryTabs: false } })!.streaming
        .syncLibraryTabs
    ).toBe(false)
    expect(parseSettingsPatch({ streaming: { syncLibraryTabs: false } })).toEqual({
      streaming: { syncLibraryTabs: false }
    })
    expect(() => parseSettingsPatch({ streaming: { syncLibraryTabs: 1 } })).toThrow()
  })

  it('syncs the favourites by default (older files too), and keeps the switch off once off', () => {
    expect(defaultSettings().streaming.syncFavorites).toBe(true)
    expect(normalizeSettings({ streaming: before })!.streaming.syncFavorites).toBe(true)
    expect(
      normalizeSettings({ streaming: { ...before, syncFavorites: false } })!.streaming.syncFavorites
    ).toBe(false)
    expect(parseSettingsPatch({ streaming: { syncFavorites: false } })).toEqual({
      streaming: { syncFavorites: false }
    })
    expect(() => parseSettingsPatch({ streaming: { syncFavorites: 'no' } })).toThrow()
  })

  it('syncs the play time by default (older files too), and keeps the switch off once off', () => {
    expect(defaultSettings().streaming.syncPlaytime).toBe(true)
    expect(normalizeSettings({ streaming: before })!.streaming.syncPlaytime).toBe(true)
    expect(
      normalizeSettings({ streaming: { ...before, syncPlaytime: false } })!.streaming.syncPlaytime
    ).toBe(false)
    expect(parseSettingsPatch({ streaming: { syncPlaytime: false } })).toEqual({
      streaming: { syncPlaytime: false }
    })
    expect(() => parseSettingsPatch({ streaming: { syncPlaytime: 'no' } })).toThrow()
  })
})

describe('ui.libraryTabs difficulty', () => {
  const old = {
    id: 'hard',
    filters: {
      platforms: [],
      stores: [],
      genres: [],
      eras: [],
      tags: [],
      sizes: [],
      hltb: [],
      controls: [],
      players: [],
      online: [],
      hidden: false,
      favorites: false,
      coop: false,
      recomp: false
    },
    sort: 'title-asc',
    sortReversed: false,
    playableFirst: true
  }

  it('accepts a tab with Filters > Difficulty levels', () => {
    const tab = { ...old, filters: { ...old.filters, difficulty: ['hard', 'impossible'] } }
    expect(libraryTabDefSchema.parse(tab)).toEqual(tab)
    const base = defaultSettings()
    const loaded = normalizeSettings({ ...base, ui: { ...base.ui, libraryTabs: [tab] } })
    expect(loaded!.ui.libraryTabs![0]!.filters.difficulty).toEqual(['hard', 'impossible'])
  })

  it('reads tabs saved before it as none, and leaves an empty list out', () => {
    expect(libraryTabDefSchema.parse(old).filters).not.toHaveProperty('difficulty')
    const empty = { ...old, filters: { ...old.filters, difficulty: [] } }
    // The same JSON as a tab without it: what an older PlayOut syncing tabs accepts.
    expect(JSON.stringify(libraryTabDefSchema.parse(empty))).toBe(JSON.stringify(old))
  })

  it('refuses a list that is not one of names', () => {
    expect(
      libraryTabDefSchema.safeParse({ ...old, filters: { ...old.filters, difficulty: 'hard' } })
        .success
    ).toBe(false)
    expect(
      libraryTabDefSchema.safeParse({ ...old, filters: { ...old.filters, difficulty: [''] } })
        .success
    ).toBe(false)
  })
})

describe('ui.libraryTabs reviews', () => {
  const old = {
    id: 'loved',
    filters: {
      platforms: [],
      stores: [],
      genres: [],
      eras: [],
      tags: [],
      sizes: [],
      hltb: [],
      controls: [],
      players: [],
      online: [],
      hidden: false,
      favorites: false,
      coop: false,
      recomp: false
    },
    sort: 'title-asc',
    sortReversed: false,
    playableFirst: true
  }

  it('accepts a tab with Filters > Reviews bands, beside Difficulty', () => {
    const tab = {
      ...old,
      filters: { ...old.filters, difficulty: ['hard'], reviews: ['r95', 'r90'] }
    }
    expect(libraryTabDefSchema.parse(tab)).toEqual(tab)
    const base = defaultSettings()
    const loaded = normalizeSettings({ ...base, ui: { ...base.ui, libraryTabs: [tab] } })
    expect(loaded!.ui.libraryTabs![0]!.filters.reviews).toEqual(['r95', 'r90'])
  })

  it('reads tabs saved before it as none, and leaves an empty list out', () => {
    expect(libraryTabDefSchema.parse(old).filters).not.toHaveProperty('reviews')
    const empty = { ...old, filters: { ...old.filters, reviews: [] } }
    expect(JSON.stringify(libraryTabDefSchema.parse(empty))).toBe(JSON.stringify(old))
  })

  it('refuses a list that is not one of names', () => {
    expect(
      libraryTabDefSchema.safeParse({ ...old, filters: { ...old.filters, reviews: 'r95' } }).success
    ).toBe(false)
  })
})

describe('library.customFilters', () => {
  const filter = { id: 'cf1', name: 'Hard', icon: 'skull', gameIds: ['steam:1', 'rom:snes:abc'] }

  it('defaults to none, and loads and patches filters', () => {
    expect(defaultSettings().library.customFilters).toEqual([])
    expect(normalizeSettings({ library: {} })!.library.customFilters).toEqual([])
    expect(
      normalizeSettings({ library: { customFilters: [filter] } })!.library.customFilters
    ).toEqual([filter])
    expect(parseSettingsPatch({ library: { customFilters: [filter] } })).toEqual({
      library: { customFilters: [filter] }
    })
  })

  it('trims a name, gives an unknown icon the default one and keeps each game once', () => {
    const patch = parseSettingsPatch({
      library: {
        customFilters: [{ ...filter, name: '  Hard ', icon: 'nope', gameIds: ['a', 'a'] }]
      }
    })
    expect(patch.library!.customFilters).toEqual([
      { id: 'cf1', name: 'Hard', icon: 'star', gameIds: ['a'] }
    ])
  })

  it('refuses a patch past the limits or with repeated ids or names', () => {
    const bad = [
      [{ ...filter, name: '' }],
      [{ ...filter, name: 'x'.repeat(41) }],
      [{ ...filter, gameIds: Array.from({ length: 10_001 }, (_, i) => `g${i}`) }],
      Array.from({ length: 101 }, (_, i) => ({ ...filter, id: `f${i}`, name: `F${i}` })),
      [filter, { ...filter, name: 'Other' }],
      [filter, { ...filter, id: 'cf2', name: 'HARD' }],
      [{ ...filter, extra: true }]
    ]
    for (const customFilters of bad)
      expect(settingsPatchSchema.safeParse({ library: { customFilters } }).success).toBe(false)
  })

  it('removes repeated game ids before checking the limit, as the loader does', () => {
    const ids = [...Array.from({ length: 10_000 }, (_, i) => `g${i}`), 'g0']
    const patch = settingsPatchSchema.safeParse({
      library: { customFilters: [{ ...filter, gameIds: ids }] }
    })
    expect(patch.success).toBe(true)
    expect(patch.data!.library!.customFilters![0]!.gameIds).toHaveLength(10_000)
    const loaded = normalizeSettings({ library: { customFilters: [{ ...filter, gameIds: ids }] } })
    expect(loaded!.library.customFilters[0]!.gameIds).toHaveLength(10_000)
  })

  it("keeps the keys games are found again by, only for the filter's own games", () => {
    const gameKeys = { 'steam:1': 'manual|pc|x', gone: 'manual|pc|y' }
    const patch = parseSettingsPatch({ library: { customFilters: [{ ...filter, gameKeys }] } })
    expect(patch.library!.customFilters![0]!.gameKeys).toEqual({ 'steam:1': 'manual|pc|x' })
    const loaded = normalizeSettings({ library: { customFilters: [{ ...filter, gameKeys }] } })
    expect(loaded!.library.customFilters[0]!.gameKeys).toEqual({ 'steam:1': 'manual|pc|x' })
    expect(
      settingsPatchSchema.safeParse({
        library: { customFilters: [{ ...filter, gameKeys: { 'steam:1': 'k'.repeat(2001) } }] }
      }).success
    ).toBe(false)
  })

  it('repairs a saved list entry by entry: one bad filter does not cost the others', () => {
    const loaded = normalizeSettings({
      library: { customFilters: [filter, { id: '', name: 'x' }, { ...filter, id: 'cf2' }] }
    })
    expect(loaded!.library.customFilters).toEqual([
      filter,
      { ...filter, id: 'cf2', name: 'Hard 2' }
    ])
  })

  it('a tab keeps its Filters > Custom picks, and an empty list is left out', () => {
    const tab = {
      id: 'mine',
      filters: {
        platforms: [],
        stores: [],
        genres: [],
        eras: [],
        tags: [],
        sizes: [],
        hltb: [],
        controls: [],
        players: [],
        online: [],
        hidden: false,
        favorites: false,
        coop: false,
        recomp: false
      },
      sort: 'title-asc',
      sortReversed: false,
      playableFirst: true
    }
    const picked = { ...tab, filters: { ...tab.filters, custom: ['cf1'] } }
    expect(libraryTabDefSchema.parse(picked)).toEqual(picked)
    const empty = { ...tab, filters: { ...tab.filters, custom: [] } }
    expect(JSON.stringify(libraryTabDefSchema.parse(empty))).toBe(JSON.stringify(tab))
  })
})
