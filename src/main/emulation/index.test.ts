import { promises as fs, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join, resolve } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  })
}))
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name !== 'userData') throw new Error(`unexpected app.getPath(${name})`)
      return join(tmpdir(), 'playout-emulation-index-test', 'userData')
    }
  }
}))

import { defaultSettings } from '../../shared/defaults'
import type { Game, Settings } from '../../shared/types'
import type { Logger } from '../logger'
import type { SettingsStore } from '../store/settings-store'
import { createEmulationService } from './index'

const ROOT = resolve(__dirname, '../../..')
const RESOURCES = join(ROOT, 'resources', 'systems')
const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
}

function settingsStore(settings: Settings): SettingsStore {
  const listeners: ((s: Settings) => void)[] = []
  const store = {
    get: () => settings,
    onChange(listener: (s: Settings) => void) {
      listeners.push(listener)
      return () => undefined
    },
    emit: () => listeners.forEach((l) => l(settings))
  }
  return store as unknown as SettingsStore
}

describe('createEmulationService', () => {
  let dir: string
  const settings = defaultSettings()
  const service = createEmulationService({
    settings: settingsStore(settings),
    resourcesDir: RESOURCES,
    log: silent
  })

  beforeAll(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'playout-emulation-'))
  })
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('loads the bundled data and exposes the catalog', () => {
    expect(service.systems().length).toBeGreaterThan(150)
    expect(service.findSystem('snes')?.name).toContain('SNES')
    expect(service.findSystemForFolder('GameCube')?.id).toBe('gc')
    const platforms = service.platformsForSystems(['snes', 'psx'])
    expect(platforms.map((p) => p.id)).toEqual(['psx', 'snes'])
    expect(platforms.every((p) => p.kind === 'system')).toBe(true)
  })

  it('throws a clear error when the data files are missing or malformed', async () => {
    const broken = join(dir, 'broken')
    await fs.mkdir(broken, { recursive: true })
    expect(() =>
      createEmulationService({
        settings: settingsStore(settings),
        resourcesDir: broken,
        log: silent
      })
    ).toThrow(/Cannot read the system definitions/)
    await fs.writeFile(join(broken, 'systems.json'), '{"systems": [{"id": "x"}]}')
    expect(() =>
      createEmulationService({
        settings: settingsStore(settings),
        resourcesDir: broken,
        log: silent
      })
    ).toThrow(/systems\.json is malformed/)
    await fs.copyFile(join(RESOURCES, 'systems.json'), join(broken, 'systems.json'))
    expect(() =>
      createEmulationService({
        settings: settingsStore(settings),
        resourcesDir: broken,
        log: silent
      })
    ).toThrow(/Cannot read the emulator find rules/)
    await fs.copyFile(join(RESOURCES, 'find-rules.json'), join(broken, 'find-rules.json'))
    expect(() =>
      createEmulationService({
        settings: settingsStore(settings),
        resourcesDir: broken,
        log: silent
      })
    ).toThrow(/Cannot read the MAME BIOS\/device list/)
  })

  it('lists a command without %EMULATOR_X% as available when its program is found, as a launch would', async () => {
    const resources = join(dir, 'bare')
    await fs.mkdir(resources, { recursive: true })
    const rules = JSON.parse(readFileSync(join(RESOURCES, 'find-rules.json'), 'utf8')) as {
      emulators: { id: string }[]
    }
    // Only cmd.exe's rule: the test looks for no emulator on this PC.
    rules.emulators = rules.emulators.filter((e) => e.id === 'OS-SHELL')
    await fs.writeFile(join(resources, 'find-rules.json'), JSON.stringify(rules))
    await fs.copyFile(join(RESOURCES, 'mame-assets.json'), join(resources, 'mame-assets.json'))
    // PlayOut's own folder is searched before PATH: here the folder of the running node.
    const program = process.execPath
    const system = {
      id: 'scripts',
      name: 'Scripts',
      extensions: ['.js'],
      platformKey: 'pc',
      emulators: [
        { id: 'bare-name', label: 'By name', command: `%HIDEWINDOW% ${basename(program)} %ROM%` },
        { id: 'bare-path', label: 'By path', command: `"${program}" %ROM%` },
        { id: 'bare-missing', label: 'Missing', command: 'playout-no-such-program %ROM%' },
        { id: 'placeholder', label: 'Placeholder', command: 'PLACEHOLDER %ROM%' },
        { id: 'unknown-emulator', label: 'Unknown', command: '%EMULATOR_NOPE% %ROM%' }
      ]
    }
    await fs.writeFile(join(resources, 'systems.json'), JSON.stringify({ systems: [system] }))
    const bare = createEmulationService({
      settings: settingsStore(settings),
      resourcesDir: resources,
      log: silent
    })
    const [info] = await bare.systemInfos({ scripts: 2 })
    expect(info.gameCount).toBe(2)
    expect(info.availableEmulators).toEqual(['bare-name', 'bare-path'])
  })

  it('scans nothing without a ROM root and scans a temp root otherwise', async () => {
    const progress: number[] = []
    const ctx = {
      settings,
      log: silent,
      resourcesDir: RESOURCES,
      progress: (n: number) => progress.push(n)
    }
    expect(await service.scanRoms(ctx)).toEqual({ games: [], unknownFolders: [] })

    const romsRoot = join(dir, 'ROMs')
    await fs.mkdir(join(romsRoot, 'n64'), { recursive: true })
    await fs.mkdir(join(romsRoot, 'mystery'), { recursive: true })
    await fs.writeFile(join(romsRoot, 'n64', 'Mario Kart 64 (USA).z64'), 'rom')
    const scoped = { ...ctx, settings: { ...settings, library: { ...settings.library, romsRoot } } }
    const result = await service.scanRoms(scoped)
    expect(result.unknownFolders).toEqual(['mystery'])
    expect(result.games.map((g) => g.externalId)).toEqual(['n64/Mario Kart 64 (USA).z64'])
    expect(progress.length).toBeGreaterThan(0)
  })

  it('rejects launches for unknown systems without touching the find rules', async () => {
    const game: Game = {
      id: 'rom:nope:1',
      source: 'rom',
      externalId: 'nope/x.bin',
      platformId: 'nope',
      title: 'x',
      sortTitle: 'x',
      installed: true,
      romPath: 'C:\\nope\\x.bin',
      launch: { kind: 'emulator', systemId: 'nope', romPath: 'C:\\nope\\x.bin' },
      tracking: { mode: 'spawned' },
      hidden: false,
      favorite: false,
      playtimeMinutes: 0,
      playCount: 0,
      addedAt: '2026-01-01T00:00:00.000Z',
      metadata: {},
      media: {},
      metadataStatus: 'none',
      user: {}
    }
    const result = await service.resolveLaunch(game)
    expect(result).toMatchObject({ ok: false, error: { kind: 'failed' } })
    if (!result.ok) expect(result.error.message).toContain("Unknown system 'nope'")
  })

  it('imports nothing from an ES-DE home that does not exist', async () => {
    const scopedSettings = {
      ...settings,
      library: { ...settings.library, esdeHome: join(dir, 'no-esde-here') }
    }
    const scoped = createEmulationService({
      settings: settingsStore(scopedSettings),
      resourcesDir: RESOURCES,
      log: silent
    })
    const result = await scoped.importEsde([])
    expect(result.updates).toEqual([])
    // Auto-detection falls back to %USERPROFILE%\ES-DE, which this machine may or may not have.
    expect(result.esdeHome === null || result.esdeHome.endsWith('ES-DE')).toBe(true)
  })
})

describe('scripts/build-systems.mjs', () => {
  it('regenerates exactly the committed systems.json, find-rules.json and mame-assets.json', async () => {
    const generator = (await import('../../../scripts/build-systems.mjs')) as {
      generate: () => Promise<{
        systems: unknown
        findRules: unknown
        mameAssets: { bioses: string[]; devices: string[] }
      }>
      OUTPUTS: { systems: string; findRules: string; mameAssets: string }
    }
    const { systems, findRules, mameAssets } = await generator.generate()
    expect(JSON.stringify(systems, null, 2) + '\n').toBe(
      readFileSync(generator.OUTPUTS.systems, 'utf8')
    )
    expect(JSON.stringify(findRules, null, 2) + '\n').toBe(
      readFileSync(generator.OUTPUTS.findRules, 'utf8')
    )
    expect(JSON.stringify(mameAssets, null, 2) + '\n').toBe(
      readFileSync(generator.OUTPUTS.mameAssets, 'utf8')
    )
    // ES-DE's MAME 0.289 lists: 95 BIOS sets and 1414 device sets (research §3 step 6).
    expect(mameAssets.bioses.length).toBe(95)
    expect(mameAssets.devices.length).toBe(1414)
    for (const name of ['neogeo', 'sys573', 'coh1002m', 'konamigv', 'aristmk5'])
      expect(mameAssets.bioses).toContain(name)
    for (const name of ['qsound', 'qsound_hle', 'ym2608', 'm68705p3'])
      expect(mameAssets.devices).toContain(name)
  })
})
