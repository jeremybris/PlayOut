import { existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { SYSTEM_SORT_BASE } from '../../shared/platforms'
import type { SystemDefinition } from '../../shared/types'
import {
  FALLBACK_ICON,
  MANUFACTURER_ICONS,
  SYSTEM_ICONS,
  createSystemCatalog,
  emulatorIdsInCommand,
  loadSystemCatalog,
  parseSystemCatalog,
  platformIconFor
} from './systems'

const ROOT = resolve(__dirname, '../../..')
const SYSTEMS_FILE = join(ROOT, 'resources', 'systems', 'systems.json')
const PLATFORM_IDS_FILE = join(ROOT, 'resources', 'systems', 'platform-ids.json')
const SIMPLE_ICONS_DIR = join(ROOT, 'node_modules', 'simple-icons', 'icons')

const catalog = loadSystemCatalog(SYSTEMS_FILE)

describe('resources/systems/systems.json', () => {
  it('carries the ES-DE attribution and a non-trivial number of systems', () => {
    const raw = JSON.parse(readFileSync(SYSTEMS_FILE, 'utf8')) as {
      _license: string
      systems: unknown[]
    }
    expect(raw._license).toMatch(/ES-DE/)
    expect(raw._license).toMatch(/MIT/)
    expect(raw._license).toMatch(/gitlab\.com\/es-de\/emulationstation-de/)
    expect(raw.systems.length).toBeGreaterThan(150)
    expect(catalog.systems.length).toBe(raw.systems.length)
  })

  it('gives every system an id, a name, extensions and at least one command', () => {
    for (const system of catalog.systems) {
      expect(system.id, 'id').toMatch(/^[a-z0-9-]+$/)
      expect(system.name.length, `${system.id} name`).toBeGreaterThan(0)
      expect(system.extensions.length, `${system.id} extensions`).toBeGreaterThan(0)
      for (const ext of system.extensions) {
        expect(ext, `${system.id} extension ${ext}`).toMatch(/^\.[a-z0-9]*$/)
      }
      expect(system.emulators.length, `${system.id} emulators`).toBeGreaterThan(0)
      for (const e of system.emulators) {
        expect(e.id, `${system.id} command id`).toMatch(/^[a-z0-9-]+$/)
        expect(e.label.length).toBeGreaterThan(0)
        expect(e.command.length).toBeGreaterThan(0)
      }
      expect(system.platformKey.length, `${system.id} platformKey`).toBeGreaterThan(0)
      for (const ext of system.dirExtensions ?? [])
        expect(system.extensions, `${system.id} dirExtension ${ext}`).toContain(ext)
    }
  })

  it('has unique ids and aliases (case-insensitively, across all systems)', () => {
    const seen = new Map<string, string>()
    for (const system of catalog.systems) {
      for (const name of [system.id, ...(system.aliases ?? [])]) {
        const key = name.toLowerCase()
        expect(seen.has(key), `${name} already used by ${seen.get(key)}`).toBe(false)
        seen.set(key, system.id)
      }
    }
  })

  it('uses platform keys that platform-ids.json knows', () => {
    const platformIds = JSON.parse(readFileSync(PLATFORM_IDS_FILE, 'utf8')) as Record<
      string,
      unknown
    >
    const unknown = catalog.systems
      .filter((s) => !(s.platformKey in platformIds))
      .map((s) => `${s.id} -> ${s.platformKey}`)
    expect(unknown).toEqual([])
  })

  it('fills manufacturer and release year for the best-known systems', () => {
    const expectations: Record<string, [string, number]> = {
      nes: ['Nintendo', 1985],
      snes: ['Nintendo', 1991],
      n64: ['Nintendo', 1996],
      gc: ['Nintendo', 2001],
      switch: ['Nintendo', 2017],
      switch2: ['Nintendo', 2025],
      psx: ['Sony', 1994],
      ps2: ['Sony', 2000],
      ps5: ['Sony', 2020],
      psp: ['Sony', 2004],
      megadrive: ['Sega', 1988],
      genesis: ['Sega', 1989],
      dreamcast: ['Sega', 1998],
      xbox: ['Microsoft', 2001],
      atari2600: ['Atari', 1977],
      c64: ['Commodore', 1982],
      pcengine: ['NEC', 1987],
      neogeo: ['SNK', 1990]
    }
    for (const [id, [manufacturer, year]] of Object.entries(expectations)) {
      const system = catalog.findSystem(id)
      expect(system, id).toBeDefined()
      expect(system?.manufacturer, id).toBe(manufacturer)
      expect(system?.releaseYear, id).toBe(year)
    }
    const withManufacturer = catalog.systems.filter((s) => s.manufacturer).length
    expect(withManufacturer).toBeGreaterThan(150)
  })

  it('adds Nintendo Switch 2 next to the Switch, with its dump formats and no emulator but shortcuts', () => {
    const ids = catalog.systems.map((s) => s.id)
    expect(ids.indexOf('switch2')).toBe(ids.indexOf('switch') + 1)
    const switch2 = catalog.findSystem('switch2')
    expect(switch2).toMatchObject({
      name: 'Nintendo Switch 2',
      extensions: ['.lnk', '.nup', '.nx', '.nsp', '.xci'],
      platformKey: 'switch2',
      manufacturer: 'Nintendo',
      releaseYear: 2025
    })
    expect(switch2?.emulators.map((e) => e.id)).toEqual(['shortcut'])
    for (const folder of ['switch2', 'Switch 2', 'switch-2', 'NintendoSwitch2'])
      expect(catalog.findSystemForFolder(folder)?.id, folder).toBe('switch2')
    expect(catalog.findSystemForFolder('switch')?.id).toBe('switch')
    const ids2 = JSON.parse(readFileSync(PLATFORM_IDS_FILE, 'utf8')) as Record<string, unknown>
    expect(ids2.switch2).toMatchObject({ igdb: 508, screenscraper: 296, thegamesdb: 5021 })
  })

  it('adds Sony PlayStation 5 next to the PS4, with its dump formats and no emulator but shortcuts', () => {
    const ids = catalog.systems.map((s) => s.id)
    expect(ids.indexOf('ps5')).toBe(ids.indexOf('ps4') + 1)
    const ps5 = catalog.findSystem('ps5')
    expect(ps5).toMatchObject({
      name: 'Sony PlayStation 5',
      extensions: ['.lnk', '.ffpkg', '.ffpfs', '.ffpfsc', '.exfat', '.pkg'],
      platformKey: 'ps5',
      manufacturer: 'Sony',
      releaseYear: 2020
    })
    expect(ps5?.emulators.map((e) => e.id)).toEqual(['shortcut'])
    for (const folder of ['ps5', 'PS5', 'PlayStation 5', 'playstation5', 'playstation-5'])
      expect(catalog.findSystemForFolder(folder)?.id, folder).toBe('ps5')
    expect(catalog.findSystemForFolder('ps4')?.id).toBe('ps4')
    const platformIds = JSON.parse(readFileSync(PLATFORM_IDS_FILE, 'utf8')) as Record<
      string,
      unknown
    >
    expect(platformIds.ps5).toMatchObject({ igdb: 167, screenscraper: 284, thegamesdb: 4980 })
  })

  it('treats directories as games where ES-DE conventions say so', () => {
    expect(catalog.findSystem('ps3')?.dirExtensions).toEqual(['.ps3', '.ps3dir'])
    expect(catalog.findSystem('scummvm')?.dirExtensions).toEqual(['.scummvm', '.svm'])
    expect(catalog.findSystem('psx')?.dirExtensions).toContain('.m3u')
    expect(catalog.findSystem('snes')?.dirExtensions).toBeUndefined()
  })

  it('keeps every ES-DE command of a system, in ES-DE order, with slugged ids', () => {
    const snes = catalog.findSystem('snes')!
    expect(snes.emulators[0]).toEqual({
      id: 'snes9x-current',
      label: 'Snes9x - Current',
      command: '%EMULATOR_RETROARCH% -L %CORE_RETROARCH%\\snes9x_libretro.dll %ROM%'
    })
    expect(snes.emulators.map((e) => e.id)).toContain('bsnes-standalone')
    expect(
      catalog.findSystem('gc')?.emulators.some((e) => e.command.includes('%EMULATOR_DOLPHIN%'))
    ).toBe(true)
  })

  it("puts PlayOut's default emulator first for the systems it chose one for", () => {
    const defaults: Record<string, string> = {
      ps3: 'RPCS3 (Standalone)',
      ps2: 'PCSX2 (Standalone)',
      psx: 'DuckStation (Standalone)',
      gba: 'mGBA (Standalone)',
      switch: 'Ryujinx (Standalone)',
      gbc: 'Gambatte',
      gc: 'Dolphin (Standalone)',
      wii: 'Dolphin (Standalone)',
      n3ds: 'Azahar (Standalone)',
      psp: 'PPSSPP (Standalone)',
      nds: 'melonDS DS',
      snes: 'Snes9x - Current'
    }
    for (const [id, label] of Object.entries(defaults)) {
      const system = catalog.findSystem(id)!
      expect(system.emulators[0].label, id).toBe(label)
      // Moving the default keeps every other command, once.
      expect(new Set(system.emulators.map((e) => e.id)).size, id).toBe(system.emulators.length)
    }
    // The RetroArch cores the standalone defaults replaced are still there to choose.
    expect(catalog.findSystem('psx')!.emulators.map((e) => e.id)).toContain('beetle-psx')
    expect(catalog.findSystem('ps2')!.emulators[1].id).toBe('pcee2')
    // Standalone defaults that cannot open .zip / .7z are marked where the system accepts archives.
    const marked = catalog.systems.flatMap((s) =>
      s.emulators.filter((e) => e.noArchives).map((e) => `${s.id}:${e.id}`)
    )
    expect(marked.sort()).toEqual([
      'gc:dolphin-standalone',
      'n3ds:azahar-standalone',
      'psp:ppsspp-standalone',
      'psx:duckstation-standalone',
      'wii:dolphin-standalone'
    ])
  })
})

describe('system catalog lookups', () => {
  it('matches folder names by id or alias, case-insensitively', () => {
    expect(catalog.findSystemForFolder('snes')?.id).toBe('snes')
    expect(catalog.findSystemForFolder('SNES')?.id).toBe('snes')
    expect(catalog.findSystemForFolder('  Super-Nintendo ')?.id).toBe('snes')
    expect(catalog.findSystemForFolder('PS1')?.id).toBe('psx')
    expect(catalog.findSystemForFolder('PlayStation')?.id).toBe('psx')
    expect(catalog.findSystemForFolder('GameCube')?.id).toBe('gc')
    expect(catalog.findSystemForFolder('ngc')?.id).toBe('gc')
    expect(catalog.findSystemForFolder('TurboGrafx16')?.id).toBe('pcengine')
    expect(catalog.findSystemForFolder('tg16')?.id).toBe('tg16')
    expect(catalog.findSystemForFolder('sfc')?.id).toBe('sfc')
    expect(catalog.findSystemForFolder('famicom')?.id).toBe('famicom')
    expect(catalog.findSystemForFolder('finalburnneo')?.id).toBe('fbneo')
    expect(catalog.findSystemForFolder('MAME')?.id).toBe('mame')
    expect(catalog.findSystemForFolder('nintendo64')?.id).toBe('n64')
    expect(catalog.findSystemForFolder('mega-drive')?.id).toBe('megadrive')
    expect(catalog.findSystemForFolder('whatever')).toBeUndefined()
  })

  it('finds systems by id, case-insensitively', () => {
    expect(catalog.findSystem('psx')?.name).toBe('Sony PlayStation')
    expect(catalog.findSystem('PSX')?.id).toBe('psx')
    expect(catalog.findSystem('nope')).toBeUndefined()
  })

  it('builds platform rows ordered by catalog position with manufacturer icons', () => {
    const platforms = catalog.platformsForSystems(['psx', 'snes', 'nes', 'nonexistent'])
    expect(platforms.map((p) => p.id)).toEqual(['nes', 'psx', 'snes'])
    for (const platform of platforms) {
      expect(platform.kind).toBe('system')
      const index = catalog.systems.findIndex((s) => s.id === platform.id)
      expect(platform.sortOrder).toBe(SYSTEM_SORT_BASE + index)
    }
    const psx = platforms.find((p) => p.id === 'psx')!
    expect(psx).toMatchObject({
      name: 'Sony PlayStation',
      shortName: 'PS1',
      manufacturer: 'Sony',
      releaseYear: 1994,
      icon: 'playstation'
    })
    const snes = platforms.find((p) => p.id === 'snes')!
    expect(snes.icon).toBe(FALLBACK_ICON)
    expect(snes.shortName).toBe('SNES')
  })

  it('only uses simple-icons slugs that exist in the installed package', () => {
    expect(existsSync(SIMPLE_ICONS_DIR)).toBe(true)
    const slugs = new Set([...Object.values(MANUFACTURER_ICONS), ...Object.values(SYSTEM_ICONS)])
    for (const slug of slugs)
      expect(existsSync(join(SIMPLE_ICONS_DIR, `${slug}.svg`)), `simple-icons/${slug}`).toBe(true)
    for (const system of catalog.systems) {
      const icon = platformIconFor(system)
      expect(
        icon === FALLBACK_ICON || existsSync(join(SIMPLE_ICONS_DIR, `${icon}.svg`)),
        `${system.id}: ${icon}`
      ).toBe(true)
    }
    expect(platformIconFor(catalog.findSystem('megadrive')!)).toBe('sega')
    expect(platformIconFor(catalog.findSystem('atari2600')!)).toBe('atari')
    expect(platformIconFor(catalog.findSystem('c64')!)).toBe('commodore')
    expect(platformIconFor(catalog.findSystem('ps2')!)).toBe('playstation2')
  })

  it('lists the %EMULATOR_X% ids a system refers to', () => {
    expect(emulatorIdsInCommand('%EMULATOR_RETROARCH% -L %CORE_RETROARCH%\\x.dll %ROM%')).toEqual([
      'RETROARCH'
    ])
    expect(emulatorIdsInCommand('%HIDEWINDOW% %EMULATOR_OS-SHELL% /C %ROM%')).toEqual(['OS-SHELL'])
    expect(emulatorIdsInCommand('PLACEHOLDER %ROM%')).toEqual([])
    const ids = catalog.emulatorIdsFor(catalog.findSystem('gc')!)
    expect(ids).toContain('RETROARCH')
    expect(ids).toContain('DOLPHIN')
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('parseSystemCatalog', () => {
  const minimal = (): SystemDefinition[] => [
    {
      id: 'snes',
      name: 'SNES',
      extensions: ['.sfc'],
      platformKey: 'snes',
      emulators: [{ id: 'a', label: 'A', command: 'a %ROM%' }]
    }
  ]

  it('accepts a bare array and the { _license, systems } wrapper', () => {
    expect(parseSystemCatalog(JSON.stringify(minimal())).systems.length).toBe(1)
    expect(
      parseSystemCatalog(JSON.stringify({ _license: 'x', systems: minimal() })).systems.length
    ).toBe(1)
  })

  it('throws a clear error for malformed content', () => {
    expect(() => parseSystemCatalog('{ not json', 'x.json')).toThrow(/x\.json is not valid JSON/)
    expect(() => parseSystemCatalog('[]', 'x.json')).toThrow(/contains no systems/)
    const noCommand = minimal()
    noCommand[0].emulators = []
    expect(() => parseSystemCatalog(JSON.stringify(noCommand), 'x.json')).toThrow(
      /x\.json is malformed: 0\.emulators/
    )
    const duplicate = [...minimal(), { ...minimal()[0], id: 'SNES' }]
    expect(() => parseSystemCatalog(JSON.stringify(duplicate))).toThrow(
      /id 'SNES' of system SNES collides/
    )
    const aliasClash = [...minimal(), { ...minimal()[0], id: 'sfc', aliases: ['Snes'] }]
    expect(() => parseSystemCatalog(JSON.stringify(aliasClash))).toThrow(/alias 'Snes'/)
  })

  it('throws when the file cannot be read', () => {
    expect(() =>
      loadSystemCatalog(join(ROOT, 'resources', 'systems', 'does-not-exist.json'))
    ).toThrow(/Cannot read the system definitions/)
  })

  it('never lets an alias shadow a real system id', () => {
    const systems: SystemDefinition[] = [
      { ...minimal()[0], id: 'a', aliases: ['b'] },
      { ...minimal()[0], id: 'b' }
    ]
    const cat = createSystemCatalog(systems)
    expect(cat.findSystemForFolder('b')?.id).toBe('b')
  })
})
