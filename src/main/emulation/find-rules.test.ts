import { promises as fs, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  })
}))

import { defaultSettings } from '../../shared/defaults'
import type { Settings } from '../../shared/types'
import type { Logger } from '../logger'
import {
  createEmulatorResolver,
  expandRuleEntry,
  loadFindRules,
  matchStaticPath,
  parseFindRules,
  parseRegistryValueEntry,
  pathDirs,
  searchPath,
  type EmulatorResolver,
  type ExpansionContext,
  type FindRulesData,
  type RegistryReader
} from './find-rules'

const ROOT = resolve(__dirname, '../../..')
const FIND_RULES_FILE = join(ROOT, 'resources', 'systems', 'find-rules.json')

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
}
const warnings: string[] = []
const recording: Logger = { ...silent, warn: (...args) => warnings.push(args.join(' ')) }

let dir: string
let exeDir: string
let userDataDir: string
let pathDir: string
let settings: Settings

async function touch(file: string): Promise<string> {
  await fs.mkdir(join(file, '..'), { recursive: true })
  await fs.writeFile(file, 'MZ')
  return file
}

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-find-rules-'))
  exeDir = join(dir, 'PlayOut App')
  userDataDir = join(dir, 'User Data', 'PlayOut')
  pathDir = join(dir, 'On Path')
  await fs.mkdir(exeDir, { recursive: true })
  await fs.mkdir(userDataDir, { recursive: true })
  await fs.mkdir(pathDir, { recursive: true })
  settings = defaultSettings()
  warnings.length = 0
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const rules: FindRulesData = {
  emulators: [
    {
      id: 'RETROARCH',
      name: 'RetroArch',
      downloadUrl: 'https://www.retroarch.com/?page=platforms',
      rules: [
        { type: 'winregistrypath', entries: ['retroarch.exe'] },
        { type: 'systempath', entries: ['retroarch.exe'] },
        {
          type: 'staticpath',
          entries: [
            '%ESPATH%\\Emulators\\RetroArch-Win64\\retroarch.exe',
            '%USERPROFILE%\\nowhere\\retroarch.exe',
            '%ROMPATH%\\..\\RetroArch\\retroarch.exe'
          ]
        }
      ]
    },
    {
      id: 'DOLPHIN',
      name: 'Dolphin',
      rules: [
        {
          type: 'winregistryvalue',
          entries: ['SOFTWARE\\Dolphin Emulator\\InstallDir|Dolphin.exe']
        },
        { type: 'staticpath', entries: ['%ESPATH%\\Emulators\\Dolphin-x64\\Dolphin*.exe'] }
      ]
    },
    {
      id: 'PCSX2',
      name: 'PCSX2',
      rules: [
        {
          type: 'staticpath',
          entries: ['%PROGRAMFILES%\\PCSX2\\pcsx2-qt.exe', '%PROGRAMFILES(X86)%\\PCSX2\\pcsx2.exe']
        }
      ]
    }
  ],
  cores: [{ id: 'RETROARCH', rules: [{ type: 'corepath', entries: ['%EMUPATH%\\cores'] }] }]
}

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: `${pathDir};C:\\Windows\\System32`,
    USERPROFILE: process.env.USERPROFILE,
    ...extra
  }
}

function resolver(
  options: {
    readRegistry?: RegistryReader
    now?: () => number
    env?: NodeJS.ProcessEnv
    log?: Logger
    managed?: (id: string) => string | null
  } = {}
): EmulatorResolver {
  return createEmulatorResolver({
    rules,
    paths: { exeDir, userDataDir },
    getSettings: () => settings,
    log: options.log ?? recording,
    env: options.env ?? env(),
    readRegistry: options.readRegistry ?? (async () => null),
    now: options.now,
    managed: options.managed
  })
}

describe('resources/systems/find-rules.json', () => {
  it('loads, documents the variables and covers the emulators the systems reference', () => {
    const data = loadFindRules(FIND_RULES_FILE)
    const raw = JSON.parse(readFileSync(FIND_RULES_FILE, 'utf8')) as {
      _license: string
      variables: Record<string, string>
    }
    expect(raw._license).toMatch(/ES-DE/)
    for (const name of [
      '%ESPATH%',
      '%USERPROFILE%',
      '%ROMPATH%',
      '%PROGRAMFILES%',
      '%PROGRAMFILES(X86)%',
      '%LOCALAPPDATA%',
      '%APPDATA%'
    ]) {
      expect(Object.keys(raw.variables), name).toContain(name)
    }
    expect(data.emulators.length).toBeGreaterThan(100)
    expect(data.cores.map((c) => c.id)).toEqual(['RETROARCH'])
    const retroarch = data.emulators.find((e) => e.id === 'RETROARCH')!
    expect(retroarch.downloadUrl).toMatch(/retroarch\.com/)
    expect(retroarch.rules.map((r) => r.type).sort()).toEqual([
      'staticpath',
      'systempath',
      'winregistrypath'
    ])
    const staticEntries = retroarch.rules.find((r) => r.type === 'staticpath')!.entries
    expect(staticEntries).toContain('%ESPATH%\\Emulators\\RetroArch-Win64\\retroarch.exe')
    expect(staticEntries.some((e) => e.includes('%ESPATH%\\..\\'))).toBe(false)
    for (const id of [
      'DOLPHIN',
      'PCSX2',
      'RPCS3',
      'RYUJINX',
      'DUCKSTATION',
      'PPSSPP',
      'MELONDS',
      'CEMU',
      'XEMU',
      'FLYCAST',
      'MGBA',
      'SNES9X',
      'MESEN',
      'ARES',
      'MAME',
      'SCUMMVM',
      'DOSBOX-STAGING',
      'VITA3K',
      'XENIA',
      'AZAHAR',
      'BSNES',
      'MUPEN64PLUS',
      'SIMPLE64',
      'REDREAM',
      'SUPERMODEL'
    ]) {
      const rule = data.emulators.find((e) => e.id === id)
      expect(rule, id).toBeDefined()
      expect(rule?.downloadUrl, `${id} downloadUrl`).toMatch(/^https?:\/\//)
    }
    const systems = JSON.parse(
      readFileSync(join(ROOT, 'resources', 'systems', 'systems.json'), 'utf8')
    ) as { systems: { emulators: { command: string }[] }[] }
    const referenced = new Set<string>()
    for (const s of systems.systems)
      for (const e of s.emulators)
        for (const m of e.command.matchAll(/%EMULATOR_([^%]+)%/g)) referenced.add(m[1])
    const known = new Set(data.emulators.map((e) => e.id))
    expect([...referenced].filter((id) => !known.has(id))).toEqual([])
  })

  it('rejects malformed rule files with a clear message', () => {
    expect(() => parseFindRules('nope', 'f.json')).toThrow(/f\.json is not valid JSON/)
    expect(() =>
      parseFindRules(
        JSON.stringify({
          emulators: [{ id: 'X', name: 'X', rules: [{ type: 'magic', entries: [] }] }],
          cores: []
        }),
        'f.json'
      )
    ).toThrow(/f\.json is malformed/)
    expect(() =>
      parseFindRules(
        JSON.stringify({
          emulators: [
            { id: 'X', name: 'X', rules: [] },
            { id: 'X', name: 'Y', rules: [] }
          ],
          cores: []
        })
      )
    ).toThrow(/duplicate emulator 'X'/)
  })
})

describe('expandRuleEntry', () => {
  const ctx = (): ExpansionContext => ({
    exeDir,
    userDataDir,
    romsRoot: null as string | null,
    env: env({ MYVAR: 'D:\\Custom\\' })
  })

  it('expands %ESPATH% to both the executable and the data directory', () => {
    expect(expandRuleEntry('%ESPATH%\\Emulators\\x.exe', ctx())).toEqual([
      join(exeDir, 'Emulators', 'x.exe'),
      join(userDataDir, 'Emulators', 'x.exe')
    ])
  })

  it('expands the known Windows folders and a leading ~', () => {
    const home = process.env.USERPROFILE!
    expect(expandRuleEntry('%USERPROFILE%\\a.exe', ctx())).toEqual([join(home, 'a.exe')])
    expect(expandRuleEntry('~\\a.exe', ctx())).toEqual([join(home, 'a.exe')])
    expect(expandRuleEntry('%PROGRAMFILES%\\a.exe', ctx())[0]).toMatch(
      /^[A-Z]:\\Program Files\\a\.exe$/
    )
    expect(expandRuleEntry('%PROGRAMFILES(X86)%\\a.exe', ctx())[0]).toMatch(
      /^[A-Z]:\\Program Files \(x86\)\\a\.exe$/
    )
    expect(expandRuleEntry('%LOCALAPPDATA%\\a.exe', ctx())[0]).toMatch(/\\AppData\\Local\\a\.exe$/i)
    expect(expandRuleEntry('%APPDATA%\\a.exe', ctx())[0]).toMatch(/\\AppData\\Roaming\\a\.exe$/i)
    expect(expandRuleEntry('%MyVar%\\a.exe', ctx())).toEqual(['D:\\Custom\\a.exe'])
  })

  it('skips %ROMPATH% entries while no ROM folder is configured and expands them otherwise', () => {
    expect(expandRuleEntry('%ROMPATH%\\..\\RetroArch\\retroarch.exe', ctx())).toEqual([])
    expect(
      expandRuleEntry('%ROMPATH%\\..\\RetroArch\\retroarch.exe', {
        ...ctx(),
        romsRoot: 'D:\\Games\\ROMs\\'
      })
    ).toEqual(['D:\\Games\\RetroArch\\retroarch.exe'])
    expect(expandRuleEntry('%UNKNOWN_VARIABLE%\\x.exe', ctx())).toEqual([])
  })
})

describe('path helpers', () => {
  it('parses PATH and finds executables with or without an extension', async () => {
    const exe = await touch(join(pathDir, 'retroarch.exe'))
    expect(pathDirs(env())).toEqual([pathDir, 'C:\\Windows\\System32'])
    const searched: string[] = []
    expect(await searchPath('retroarch', env(), [], searched)).toBe(exe)
    expect(searched).toEqual([exe])
    searched.length = 0
    expect(await searchPath('missing.exe', env(), [exeDir], searched)).toBeNull()
    expect(searched).toEqual([
      join(exeDir, 'missing.exe'),
      join(pathDir, 'missing.exe'),
      'C:\\Windows\\System32\\missing.exe'
    ])
  })

  it('matches wildcard file names in static paths', async () => {
    await touch(join(exeDir, 'Emulators', 'Dolphin-x64', 'Dolphin.exe'))
    await touch(join(exeDir, 'Emulators', 'Dolphin-x64', 'DolphinQt2.exe'))
    const searched: string[] = []
    expect(
      await matchStaticPath(join(exeDir, 'Emulators', 'Dolphin-x64', 'Dolphin*.exe'), searched)
    ).toBe(join(exeDir, 'Emulators', 'Dolphin-x64', 'Dolphin.exe'))
    expect(
      await matchStaticPath(join(exeDir, 'Emulators', 'Dolphin-x64', 'Nope*.exe'), searched)
    ).toBeNull()
    expect(searched.length).toBe(2)
  })

  it('parses winregistryvalue entries', () => {
    expect(parseRegistryValueEntry('SOFTWARE\\Dolphin Emulator\\InstallDir|Dolphin.exe')).toEqual({
      key: 'SOFTWARE\\Dolphin Emulator',
      valueName: 'InstallDir',
      suffix: 'Dolphin.exe'
    })
    expect(parseRegistryValueEntry('SOFTWARE\\Valve\\Steam\\SteamExe')).toEqual({
      key: 'SOFTWARE\\Valve\\Steam',
      valueName: 'SteamExe',
      suffix: ''
    })
    expect(parseRegistryValueEntry('nonsense')).toBeNull()
  })
})

describe('createEmulatorResolver', () => {
  it('prefers a settings override over every rule', async () => {
    const override = await touch(join(dir, 'My Emulators', 'ra', 'retroarch.exe'))
    await touch(join(exeDir, 'Emulators', 'RetroArch-Win64', 'retroarch.exe'))
    settings.emulators.overrides.RETROARCH = override
    const status = await resolver().resolveEmulator('RETROARCH')
    expect(status.path).toBe(override)
    expect(status.foundBy).toBe('override')
    expect(status.name).toBe('RetroArch')
    expect(status.downloadUrl).toMatch(/retroarch/)
    expect(status.searchedPaths).toEqual([override])
  })

  it('falls back to the rules when the override does not exist, and records every checked path', async () => {
    settings.emulators.overrides.RETROARCH = join(dir, 'gone', 'retroarch.exe')
    const installed = await touch(
      join(userDataDir, 'Emulators', 'RetroArch-Win64', 'retroarch.exe')
    )
    const status = await resolver().resolveEmulator('RETROARCH')
    expect(status.path).toBe(installed)
    expect(status.foundBy).toBe('rule')
    expect(status.searchedPaths[0]).toBe(join(dir, 'gone', 'retroarch.exe'))
    expect(status.searchedPaths).toContain(
      'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\retroarch.exe'
    )
    expect(status.searchedPaths).toContain(
      join(exeDir, 'Emulators', 'RetroArch-Win64', 'retroarch.exe')
    )
    expect(status.searchedPaths).toContain(installed)
    expect(status.coresDir).toBeNull()
    expect(warnings.some((w) => w.includes('override for RETROARCH does not exist'))).toBe(true)
  })

  it('uses the emulator PlayOut installed after an override and before the rules', async () => {
    const managed = await touch(join(exeDir, 'Emulation', 'RetroArch', 'retroarch.exe'))
    const core = await touch(join(exeDir, 'Emulation', 'RetroArch', 'cores', 'mgba_libretro.dll'))
    await touch(join(exeDir, 'Emulators', 'RetroArch-Win64', 'retroarch.exe'))
    const lookups: string[] = []
    const r = resolver({
      managed: (id) => {
        lookups.push(id)
        return id === 'RETROARCH' ? managed : null
      }
    })
    const status = await r.resolveEmulator('RETROARCH')
    expect(status).toMatchObject({ path: managed, foundBy: 'playout', searchedPaths: [managed] })
    expect(status.coresDir).toBe(join(exeDir, 'Emulation', 'RetroArch', 'cores'))
    expect((await r.resolveCore('RETROARCH', 'mgba_libretro.dll')).path).toBe(core)

    // Cached like any other result.
    const before = lookups.length
    await r.resolveEmulator('RETROARCH')
    expect(lookups.length).toBe(before)

    // A user override still wins.
    const override = await touch(join(dir, 'Mine', 'retroarch.exe'))
    settings.emulators.overrides.RETROARCH = override
    r.invalidate()
    expect(await r.resolveEmulator('RETROARCH')).toMatchObject({
      path: override,
      foundBy: 'override'
    })
  })

  it('falls back to the rules when the installed emulator is gone', async () => {
    const installed = await touch(join(exeDir, 'Emulators', 'RetroArch-Win64', 'retroarch.exe'))
    const gone = join(exeDir, 'Emulation', 'RetroArch', 'retroarch.exe')
    const status = await resolver({ managed: () => gone }).resolveEmulator('RETROARCH')
    expect(status.path).toBe(installed)
    expect(status.foundBy).toBe('rule')
    expect(status.searchedPaths[0]).toBe(gone)
  })

  it('searches PATH only after the static paths', async () => {
    const onPath = await touch(join(pathDir, 'retroarch.exe'))
    expect((await resolver().resolveEmulator('RETROARCH')).path).toBe(onPath)
    const installed = await touch(join(exeDir, 'Emulators', 'RetroArch-Win64', 'retroarch.exe'))
    const fresh = resolver()
    expect((await fresh.resolveEmulator('RETROARCH')).path).toBe(installed)
  })

  it('reports a missing emulator with everything it looked at', async () => {
    const status = await resolver().resolveEmulator('DOLPHIN')
    expect(status.path).toBeNull()
    expect(status.foundBy).toBeNull()
    expect(status.searchedPaths).toContain('HKCU\\SOFTWARE\\Dolphin Emulator\\InstallDir')
    expect(status.searchedPaths).toContain('HKLM\\SOFTWARE\\Dolphin Emulator\\InstallDir')
    expect(status.searchedPaths).toContain(join(exeDir, 'Emulators', 'Dolphin-x64', 'Dolphin*.exe'))
    expect(status.searchedPaths).toContain(
      join(userDataDir, 'Emulators', 'Dolphin-x64', 'Dolphin*.exe')
    )
  })

  it('uses registry rules (App Paths and arbitrary values) through the injected reader', async () => {
    const dolphin = await touch(join(dir, 'Dolphin Install', 'Dolphin.exe'))
    const ra = await touch(join(dir, 'RA From Registry', 'retroarch.exe'))
    const reads: string[] = []
    const readRegistry: RegistryReader = async (hive, key, valueName) => {
      reads.push(`${hive}\\${key}\\${valueName}`)
      if (hive === 'HKLM' && key === 'SOFTWARE\\Dolphin Emulator' && valueName === 'InstallDir')
        return join(dir, 'Dolphin Install') + '\\'
      if (hive === 'HKCU' && key.endsWith('App Paths\\retroarch.exe') && valueName === '')
        return `"${ra}"`
      return null
    }
    const r = resolver({ readRegistry })
    expect((await r.resolveEmulator('DOLPHIN')).path).toBe(dolphin)
    expect((await r.resolveEmulator('RETROARCH')).path).toBe(ra)
    expect(reads.length).toBeGreaterThan(0)
  })

  it('caches results for 60 s and invalidates on demand', async () => {
    let clock = 1_000_000
    const reads: string[] = []
    const readRegistry: RegistryReader = async (hive, key) => {
      reads.push(`${hive}\\${key}`)
      return null
    }
    const r = resolver({ readRegistry, now: () => clock })
    await r.resolveEmulator('DOLPHIN')
    const afterFirst = reads.length
    await r.resolveEmulator('DOLPHIN')
    expect(reads.length).toBe(afterFirst)
    clock += 59_000
    await r.resolveEmulator('DOLPHIN')
    expect(reads.length).toBe(afterFirst)
    clock += 2_000
    await r.resolveEmulator('DOLPHIN')
    expect(reads.length).toBe(afterFirst * 2)
    r.invalidate()
    await r.resolveEmulator('DOLPHIN')
    expect(reads.length).toBe(afterFirst * 3)
  })

  it('resolves RetroArch cores from <retroarch dir>\\cores unless settings point elsewhere', async () => {
    const retroarch = await touch(join(exeDir, 'Emulators', 'RetroArch-Win64', 'retroarch.exe'))
    const core = await touch(
      join(exeDir, 'Emulators', 'RetroArch-Win64', 'cores', 'snes9x_libretro.dll')
    )
    const r = resolver()
    const status = await r.resolveEmulator('RETROARCH')
    expect(status.path).toBe(retroarch)
    expect(status.coresDir).toBe(join(exeDir, 'Emulators', 'RetroArch-Win64', 'cores'))
    expect(await r.resolveCore('RETROARCH', 'snes9x_libretro.dll')).toEqual({
      path: core,
      coreFile: 'snes9x_libretro.dll',
      searchedPaths: [core]
    })
    const missing = await r.resolveCore('RETROARCH', '\\mesen_libretro.dll')
    expect(missing.path).toBeNull()
    expect(missing.coreFile).toBe('mesen_libretro.dll')
    expect(missing.searchedPaths).toEqual([
      join(exeDir, 'Emulators', 'RetroArch-Win64', 'cores', 'mesen_libretro.dll')
    ])

    const custom = await touch(join(dir, 'My Cores', 'mesen_libretro.dll'))
    settings.emulators.coresDir = join(dir, 'My Cores')
    r.invalidate()
    const found = await r.resolveCore('RETROARCH', 'mesen_libretro.dll')
    expect(found.path).toBe(custom)
    expect(found.searchedPaths[0]).toBe(custom)
    expect((await r.resolveEmulator('RETROARCH')).coresDir).toBe(join(dir, 'My Cores'))
  })

  it('resolves everything in rule order plus override-only ids', async () => {
    const custom = await touch(join(dir, 'custom', 'thing.exe'))
    settings.emulators.overrides.CUSTOM = custom
    const all = await resolver().resolveAll()
    expect(all.map((s) => s.id)).toEqual(['RETROARCH', 'DOLPHIN', 'PCSX2', 'CUSTOM'])
    expect(all[3]).toMatchObject({
      id: 'CUSTOM',
      name: 'CUSTOM',
      path: custom,
      foundBy: 'override'
    })
    expect(all[2].searchedPaths.length).toBe(2)
  })
})
