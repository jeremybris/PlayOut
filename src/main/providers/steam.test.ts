import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
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
import { isDirectory } from '../util/fs'
import type { ScanContext } from './types'
import {
  parseHiddenCollection,
  findLibraryCacheArt,
  isFullyInstalled,
  nonGameReason,
  normalizeSteamTitle,
  orderAccountCandidates,
  parseAppManifest,
  parseLibraryFolders,
  parseLocalConfig,
  parseLoginUsers,
  parseSteamVdf,
  scanSteamLibraries,
  scanSteamRoot,
  steamProvider,
  unescapeVdf
} from './steam'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build an appmanifest_*.acf text in Steam's own layout. */
function acf(fields: Record<string, string | number>, extra = ''): string {
  const lines = Object.entries(fields).map(([k, v]) => `\t"${k}"\t\t"${v}"`)
  return `"AppState"\n{\n${lines.join('\n')}\n${extra}}\n`
}

const MAFIA_ACF = acf(
  {
    appid: 1030840,
    Universe: 1,
    LauncherPath: 'C:\\\\Program Files (x86)\\\\Steam\\\\steam.exe',
    name: 'Mafia: Definitive Edition',
    StateFlags: 4,
    installdir: 'Mafia Definitive Edition',
    lastupdated: 1784575104,
    LastPlayed: 1785354716,
    SizeOnDisk: 38908493197,
    buildid: 16502642,
    LastOwner: '76561198000000101'
  },
  '\t"InstalledDepots"\n\t{\n\t\t"1030841"\n\t\t{\n\t\t\t"manifest"\t\t"2886022585972111903"\n\t\t\t"size"\t\t"38908493117"\n\t\t}\n\t}\n\t"UserConfig"\n\t{\n\t\t"language"\t\t"english"\n\t}\n'
)

const LOCALCONFIG = `"UserLocalConfigStore"
{
\t"Broadcast"
\t{
\t\t"Permissions"\t\t"0"
\t}
\t"Software"
\t{
\t\t"Valve"
\t\t{
\t\t\t"Steam"
\t\t\t{
\t\t\t\t"apps"
\t\t\t\t{
\t\t\t\t\t"7"
\t\t\t\t\t{
\t\t\t\t\t\t"cloud"
\t\t\t\t\t\t{
\t\t\t\t\t\t\t"last_sync_state"\t\t"synchronized"
\t\t\t\t\t\t}
\t\t\t\t\t}
\t\t\t\t\t"294100"
\t\t\t\t\t{
\t\t\t\t\t\t"LastPlayed"\t\t"1791856007"
\t\t\t\t\t\t"Playtime"\t\t"10625"
\t\t\t\t\t\t"294100_eula_1"\t\t"1"
\t\t\t\t\t\t"cloud"
\t\t\t\t\t\t{
\t\t\t\t\t\t\t"last_sync_state"\t\t"synchronized"
\t\t\t\t\t\t}
\t\t\t\t\t\t"autocloud"
\t\t\t\t\t\t{
\t\t\t\t\t\t\t"lastlaunch"\t\t"1791854250"
\t\t\t\t\t\t\t"lastexit"\t\t"1791855995"
\t\t\t\t\t\t}
\t\t\t\t\t\t"BadgeData"\t\t"20000000828"
\t\t\t\t\t\t"PlaytimeDisconnected"\t\t"88"
\t\t\t\t\t}
\t\t\t\t\t"620"
\t\t\t\t\t{
\t\t\t\t\t\t"LastPlayed"\t\t"1777548408"
\t\t\t\t\t\t"Playtime"\t\t"1108"
\t\t\t\t\t}
\t\t\t\t\t"70_123456"
\t\t\t\t\t{
\t\t\t\t\t\t"LastPlayed"\t\t"1600000000"
\t\t\t\t\t\t"Playtime"\t\t"5"
\t\t\t\t\t}
\t\t\t\t\t"2185060"
\t\t\t\t\t{
\t\t\t\t\t\t"LaunchOptions"\t\t"-windowed \\"quoted arg\\""
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\t"LastPlayedTimesSyncTime"\t\t"1793300000"
\t\t\t\t"PlayerLevel"\t\t"12"
\t\t\t}
\t\t}
\t}
\t"apps"
\t{
\t\t"620"
\t\t{
\t\t\t"UseSteamControllerConfig"\t\t"2"
\t\t\t"SteamControllerRumble"\t\t"-1"
\t\t}
\t\t"999999"
\t\t{
\t\t\t"Playtime"\t\t"42"
\t\t}
\t}
}
`

function loginUsers(
  users: { id: string; name: string; fields: Record<string, string | number> }[]
): string {
  const blocks = users.map((u) => {
    const lines = Object.entries({ AccountName: u.name, PersonaName: u.name, ...u.fields })
      .map(([k, v]) => `\t\t"${k}"\t\t"${v}"`)
      .join('\n')
    return `\t"${u.id}"\n\t{\n${lines}\n\t}`
  })
  return `"users"\n{\n${blocks.join('\n')}\n}\n`
}

const noop = (): void => undefined
const silentLog = { debug: noop, info: noop, warn: noop, error: noop }

function scanContext(overrides: Partial<ScanContext> = {}): ScanContext {
  return {
    settings: defaultSettings(),
    log: silentLog,
    resourcesDir: '',
    progress: () => {},
    ...overrides
  }
}

/** Escape a Windows path for a VDF string value. */
const vdfPath = (p: string): string => p.replace(/\\/g, '\\\\')

async function writeFile(path: string, content: string | Buffer): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, content)
}

// ---------------------------------------------------------------------------
// Pure parsers
// ---------------------------------------------------------------------------

describe('VDF helpers', () => {
  // @node-steam/vdf loops forever on an unterminated quoted value; the guard must turn that into a throw.
  it('throws instead of hanging on an unterminated quoted value', { timeout: 5_000 }, () => {
    expect(() =>
      parseSteamVdf('"AppState"\n{\n\t"appid"\t\t"4000"\n\t"name"\t\t"Truncated')
    ).toThrow(/unterminated/)
    expect(() => parseSteamVdf('"a"\n{\n\t"b"\t\t"c\n')).toThrow(/unterminated/)
    expect(() => parseSteamVdf('"a"\n{\n\tb\t\t"c')).toThrow(/unterminated/)
    expect(() => parseSteamVdf('"a"\n{\n\t"b"\t\t"c\\"')).toThrow(/unterminated/)
  })

  it('still parses well-formed text with escaped quotes, multi-line values and comments', () => {
    const text = [
      '// comment with an "odd" quote count"',
      '/* block "comment',
      'still "in" comment */',
      '"a"',
      '{',
      '\t"b"\t\t"say \\"hi\\""',
      '\t"c"\t\t"multi',
      'line"',
      '\t"d"\t\t"C:\\\\Steam\\\\"',
      '}',
      ''
    ].join('\n')
    expect(parseSteamVdf(text)).toEqual({
      a: { b: 'say \\"hi\\"', c: 'multi\nline', d: 'C:\\\\Steam\\\\' }
    })
    expect(parseSteamVdf('')).toEqual({})
  })

  it('unescapes KeyValues text escapes and strips trademark symbols', () => {
    expect(unescapeVdf('C:\\\\Program Files (x86)\\\\Steam')).toBe('C:\\Program Files (x86)\\Steam')
    expect(unescapeVdf('say \\"hi\\"\\n')).toBe('say "hi"\n')
    expect(unescapeVdf('Foo\\Bar')).toBe('Foo\\Bar')
    expect(normalizeSteamTitle('Call of Duty®: Modern Warfare® III')).toBe(
      'Call of Duty: Modern Warfare III'
    )
    expect(normalizeSteamTitle('  The Sims™ 2   Legacy Collection ')).toBe(
      'The Sims 2 Legacy Collection'
    )
  })
})

describe('parseLibraryFolders', () => {
  it('reads the new object format, unescapes paths and always includes the Steam folder', () => {
    const text = `"libraryfolders"
{
\t"0"
\t{
\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"
\t\t"label"\t\t""
\t\t"contentid"\t\t"4321074267863743339"
\t\t"apps"
\t\t{
\t\t\t"2620"\t\t"954204780"
\t\t}
\t}
\t"1"
\t{
\t\t"path"\t\t"D:\\\\SteamLibrary"
\t}
\t"2"
\t{
\t\t"path"\t\t"E:\\\\"
\t}
\t"contentstatsid"\t\t"-123"
}
`
    expect(parseLibraryFolders(text, 'c:\\program files (x86)\\steam')).toEqual([
      'C:\\Program Files (x86)\\Steam',
      'D:\\SteamLibrary',
      'E:\\'
    ])
  })

  it('reads the old string format and dedupes case-insensitively', () => {
    const text = `"LibraryFolders"
{
\t"TimeNextStatsReport"\t\t"1500000000"
\t"ContentStatsID"\t\t"123"
\t"1"\t\t"D:\\\\Games\\\\Steam"
\t"2"\t\t"d:/games/steam/"
}
`
    expect(parseLibraryFolders(text, 'C:\\Steam')).toEqual(['D:\\Games\\Steam', 'C:\\Steam'])
  })

  it('falls back to the Steam folder when the file has no libraryfolders block', () => {
    expect(parseLibraryFolders('"something"\n{\n}\n', 'C:\\Steam')).toEqual(['C:\\Steam'])
  })
})

describe('parseAppManifest', () => {
  it('extracts the fields PlayOut needs from a real-world manifest', () => {
    expect(parseAppManifest(MAFIA_ACF)).toEqual({
      appId: 1030840,
      name: 'Mafia: Definitive Edition',
      installDir: 'Mafia Definitive Edition',
      stateFlags: 4,
      lastPlayed: 1785354716,
      sizeOnDisk: 38908493197,
      buildId: 16502642
    })
  })

  it('cleans trademark symbols, falls back to UserConfig.name and tolerates missing fields', () => {
    const text = acf({
      appid: 3314070,
      name: 'The Sims™ 2 Legacy Collection',
      StateFlags: 6,
      installdir: 'The Sims 2 Legacy Collection'
    })
    expect(parseAppManifest(text)).toMatchObject({
      appId: 3314070,
      name: 'The Sims 2 Legacy Collection',
      stateFlags: 6,
      lastPlayed: 0,
      sizeOnDisk: 0
    })

    const fallback = acf(
      { appid: 140, StateFlags: 4, installdir: 'Hundred Forty' },
      '\t"UserConfig"\n\t{\n\t\t"name"\t\t"140"\n\t}\n'
    )
    expect(parseAppManifest(fallback)).toMatchObject({
      appId: 140,
      name: '140',
      installDir: 'Hundred Forty'
    })

    expect(parseAppManifest(acf({ StateFlags: 4, installdir: 'NoId' }))).toBeNull()
    expect(parseAppManifest('"Other"\n{\n\t"appid"\t\t"1"\n}\n')).toBeNull()
  })

  it(
    'throws on a truncated manifest so the scanner can log and skip it',
    { timeout: 5_000 },
    () => {
      expect(() =>
        parseAppManifest('"AppState"\n{\n\t"appid"\t\t"620"\n\t"name"\t\t"Portal 2"\n')
      ).toThrow()
      expect(() =>
        parseAppManifest('"AppState"\n{\n\t"appid"\t\t"4000"\n\t"name"\t\t"Truncated')
      ).toThrow()
    }
  )
})

describe('manifest filtering', () => {
  it('requires the FullyInstalled bit (4) whatever else is set', () => {
    expect(isFullyInstalled(4)).toBe(true)
    expect(isFullyInstalled(6)).toBe(true)
    expect(isFullyInstalled(68)).toBe(true)
    expect(isFullyInstalled(1028)).toBe(true)
    expect(isFullyInstalled(1026)).toBe(false)
    expect(isFullyInstalled(2)).toBe(false)
    expect(isFullyInstalled(1)).toBe(false)
    expect(isFullyInstalled(0)).toBe(false)
    expect(isFullyInstalled(1048578)).toBe(false)
    // Bit 4 with an installing bit and buildid 0 is a fresh install still downloading (StateFlags 1030 / 1542),
    // not an installed game; a pending update (6) or an update of an installed build is.
    expect(isFullyInstalled(1030, 0)).toBe(false)
    expect(isFullyInstalled(1542, 0)).toBe(false)
    expect(isFullyInstalled(1030, 777)).toBe(true)
    expect(isFullyInstalled(6, 0)).toBe(true)
    expect(isFullyInstalled(4, 0)).toBe(true)
    expect(parseAppManifest(MAFIA_ACF)?.buildId).toBe(16502642)
  })

  it('recognises tools, runtimes, redistributables, servers and soundtracks', () => {
    expect(
      nonGameReason({
        appId: 228980,
        name: 'Steamworks Common Redistributables',
        installDir: 'Steamworks Shared'
      })
    ).toBeTruthy()
    expect(
      nonGameReason({
        appId: 4099820,
        name: 'Ubisoft Connect Services',
        installDir: 'Ubisoft Connect Services'
      })
    ).toBeTruthy()
    expect(nonGameReason({ appId: 1, name: 'Proton 10.0', installDir: 'Proton 10.0' })).toBe(
      'Proton compatibility tool'
    )
    expect(
      nonGameReason({
        appId: 10,
        name: 'Proton - Experimental',
        installDir: 'Proton - Experimental'
      })
    ).toBe('Proton compatibility tool')
    expect(nonGameReason({ appId: 11, name: '', installDir: 'Proton 11.0 (Beta)' })).toBe(
      'Proton compatibility tool'
    )
    expect(nonGameReason({ appId: 12, name: '', installDir: 'Proton Hotfix' })).toBe(
      'Proton compatibility tool'
    )
    expect(
      nonGameReason({
        appId: 2,
        name: 'Steam Linux Runtime 3.0 (sniper)',
        installDir: 'SteamLinuxRuntime_sniper'
      })
    ).toBe('Steam Linux Runtime')
    expect(
      nonGameReason({
        appId: 3,
        name: 'Valheim Dedicated Server',
        installDir: 'Valheim dedicated server'
      })
    ).toBe('dedicated server')
    expect(
      nonGameReason({
        appId: 4,
        name: 'Source SDK Base 2013 Multiplayer',
        installDir: 'Source SDK Base 2013 Multiplayer'
      })
    ).toBe('development tool')
    expect(
      nonGameReason({ appId: 5, name: 'Hades Original Soundtrack', installDir: 'Hades OST' })
    ).toBe('soundtrack')
    expect(nonGameReason({ appId: 6, name: '', installDir: 'SteamLinuxRuntime_soldier' })).toBe(
      'Steam Linux Runtime'
    )
  })

  it('keeps ordinary games, including ones whose names contain tool-like words', () => {
    expect(nonGameReason({ appId: 294100, name: 'RimWorld', installDir: 'RimWorld' })).toBeNull()
    expect(
      nonGameReason({ appId: 7, name: 'Protonic Blast', installDir: 'Protonic Blast' })
    ).toBeNull()
    expect(
      nonGameReason({ appId: 295070, name: 'Proton Pulse', installDir: 'Proton Pulse' })
    ).toBeNull()
    expect(nonGameReason({ appId: 13, name: '', installDir: 'Proton Pulse' })).toBeNull()
    expect(
      nonGameReason({ appId: 8, name: 'Server Tycoon', installDir: 'Server Tycoon' })
    ).toBeNull()
    expect(
      nonGameReason({ appId: 9, name: 'Soundtrack Hero', installDir: 'Soundtrack Hero' })
    ).toBeNull()
    expect(nonGameReason({ appId: 3354750, name: 'skate.', installDir: 'Skate' })).toBeNull()
  })
})

describe('parseHiddenCollection', () => {
  const file = (entry: unknown): string =>
    JSON.stringify([
      ['user-collections.other', { value: '{}' }],
      ['user-collections.hidden', entry]
    ])
  const value = (collection: unknown): string => file({ value: JSON.stringify(collection) })

  it('reads added minus removed', () => {
    expect(
      parseHiddenCollection(value({ id: 'hidden', added: [220, 280, 400], removed: [280] }))
    ).toEqual(new Set([220, 400]))
  })

  it('reads an account with nothing hidden as an empty set', () => {
    expect(parseHiddenCollection('[]')).toEqual(new Set())
    expect(parseHiddenCollection(file({ is_deleted: true }))).toEqual(new Set())
    expect(parseHiddenCollection(value({ added: [] }))).toEqual(new Set())
  })

  it('answers null when the file cannot be understood', () => {
    expect(parseHiddenCollection('[["user-collec')).toBeNull()
    expect(parseHiddenCollection('{}')).toBeNull()
    expect(parseHiddenCollection(file({ value: 'not json' }))).toBeNull()
    expect(parseHiddenCollection(value({ removed: [1] }))).toBeNull()
  })
})

describe('parseLocalConfig', () => {
  it('reads play time and last played from the nested apps block only', () => {
    const stats = parseLocalConfig(LOCALCONFIG)
    expect(stats.get(294100)).toEqual({ playtimeMinutes: 10713, lastPlayed: 1791856007 })
    expect(stats.get(620)).toEqual({ playtimeMinutes: 1108, lastPlayed: 1777548408 })
    expect(stats.has(7)).toBe(false)
    expect(stats.has(2185060)).toBe(false)
    expect(stats.has(999999)).toBe(false)
    expect([...stats.keys()].sort((a, b) => a - b)).toEqual([620, 294100])
  })

  it('returns an empty map for a config without the Steam apps block', () => {
    expect(parseLocalConfig('"UserLocalConfigStore"\n{\n\t"apps"\n\t{\n\t}\n}\n').size).toBe(0)
  })
})

describe('login users', () => {
  const USERS = loginUsers([
    {
      id: '76561198000000101',
      name: 'player_one',
      fields: { RememberPassword: 1, AutoLogin: 1, timestamp: 1793300699 }
    },
    {
      id: '76561198000000202',
      name: 'player_two',
      fields: { RememberPassword: 1, AutoLogin: 0, timestamp: 1788375528 }
    }
  ])

  it('converts steamid64 keys to account ids exactly (beyond double precision)', () => {
    const users = parseLoginUsers(USERS)
    expect(users.map((u) => u.accountId)).toEqual(['39734373', '39734474'])
    expect(users[0]).toMatchObject({
      steamId64: '76561198000000101',
      accountName: 'player_one',
      mostRecent: false,
      autoLogin: true,
      timestamp: 1793300699
    })
  })

  it('orders candidates: MostRecent, AutoLoginUser, AutoLogin, timestamp, then unknown folders', () => {
    const users = parseLoginUsers(USERS)
    expect(orderAccountCandidates(users, ['39734474', '39734373', '111'])).toEqual([
      '39734373',
      '39734474',
      '111'
    ])
    expect(orderAccountCandidates(users, [], 'Player_Two')).toEqual(['39734474', '39734373'])

    const withMostRecent = parseLoginUsers(
      loginUsers([
        {
          id: '76561198000000101',
          name: 'player_one',
          fields: { AutoLogin: 1, timestamp: 1793300699 }
        },
        { id: '76561198000000202', name: 'other', fields: { MostRecent: 1, timestamp: 1 } }
      ])
    )
    expect(orderAccountCandidates(withMostRecent, [], 'player_one')).toEqual([
      '39734474',
      '39734373'
    ])
    expect(orderAccountCandidates([], ['39734474', '39734373'])).toEqual(['39734474', '39734373'])
  })
})

// ---------------------------------------------------------------------------
// File-system based tests on a fixture folder
// ---------------------------------------------------------------------------

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-steam-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('findLibraryCacheArt', () => {
  it('reads the per-app folder layout, preferring top-level files and the newest hash subfolder', async () => {
    const cache = join(dir, 'librarycache')
    const app = join(cache, '620')
    await writeFile(join(app, 'library_600x900.jpg'), 'cover')
    await writeFile(join(app, 'logo.png'), 'logo')
    await writeFile(join(app, '25a5a16b2423bf7487ac5340b5b0948cef48c5f8.jpg'), 'icon')
    await writeFile(join(app, 'library_hero_blur.jpg'), 'blur')
    const older = join(app, 'a58588d857b8683f8065e55f97ab82ad8a945c51')
    const newer = join(app, 'faffc0f560786e2f05104a8d2fac837c6969bf13')
    await writeFile(join(older, 'library_hero.jpg'), 'old hero')
    await writeFile(join(older, 'logo.png'), 'old logo')
    await writeFile(join(newer, 'library_hero.jpg'), 'new hero')
    await writeFile(join(newer, 'library_header.jpg'), 'header')
    await fs.utimes(older, new Date('2025-01-01'), new Date('2025-01-01'))
    await fs.utimes(newer, new Date('2026-01-01'), new Date('2026-01-01'))

    expect(await findLibraryCacheArt(cache, 620)).toEqual({
      cover: join(app, 'library_600x900.jpg'),
      hero: join(newer, 'library_hero.jpg'),
      logo: join(app, 'logo.png'),
      icon: join(app, '25a5a16b2423bf7487ac5340b5b0948cef48c5f8.jpg')
    })
  })

  it('uses library_capsule.jpg from hash subfolders when the app folder has no top-level cover', async () => {
    const cache = join(dir, 'librarycache')
    const app = join(cache, '2111550')
    await writeFile(join(app, 'f1533e1805fd7af96b4ccd2775c75499a2761ec3.jpg'), 'icon')
    await writeFile(
      join(app, '584b32a1a3e31fe238d689d7b4a897ae9fa8953d', 'library_capsule.jpg'),
      'cover'
    )
    await writeFile(
      join(app, '5ebb980bd87db4a46d3aca7a9d9ec5c4ec7f4692', 'library_hero.jpg'),
      'hero'
    )
    await writeFile(join(app, 'ab0d8f66d1e0630ebb4b8d73beb02179a31beff1', 'logo.png'), 'logo')
    expect(await findLibraryCacheArt(cache, 2111550)).toEqual({
      cover: join(app, '584b32a1a3e31fe238d689d7b4a897ae9fa8953d', 'library_capsule.jpg'),
      hero: join(app, '5ebb980bd87db4a46d3aca7a9d9ec5c4ec7f4692', 'library_hero.jpg'),
      logo: join(app, 'ab0d8f66d1e0630ebb4b8d73beb02179a31beff1', 'logo.png'),
      icon: join(app, 'f1533e1805fd7af96b4ccd2775c75499a2761ec3.jpg')
    })
  })

  it('reads the old flat layout and returns nothing when there is no art', async () => {
    const cache = join(dir, 'librarycache')
    await writeFile(join(cache, '440_library_600x900.jpg'), 'cover')
    await writeFile(join(cache, '440_library_hero.jpg'), 'hero')
    await writeFile(join(cache, '440_logo.png'), 'logo')
    await writeFile(join(cache, '440_icon.jpg'), 'icon')
    await writeFile(join(cache, '440_header.jpg'), 'header')
    expect(await findLibraryCacheArt(cache, 440)).toEqual({
      cover: join(cache, '440_library_600x900.jpg'),
      hero: join(cache, '440_library_hero.jpg'),
      logo: join(cache, '440_logo.png'),
      icon: join(cache, '440_icon.jpg')
    })
    expect(await findLibraryCacheArt(cache, 4400)).toEqual({})
    expect(await findLibraryCacheArt(join(dir, 'missing'), 440)).toEqual({})
  })

  it('never reports a kind without a file (no undefined-valued keys)', async () => {
    const cache = join(dir, 'librarycache')
    const app = join(cache, '2640')
    await writeFile(join(app, 'library_600x900.jpg'), 'cover')
    await writeFile(join(app, 'header.jpg'), 'header')
    await writeFile(
      join(app, 'e5fbc61fce98c303a9c49dc988163499b183f037', 'library_hero_blur.jpg'),
      'blur'
    )
    const media = await findLibraryCacheArt(cache, 2640)
    expect(media).toStrictEqual({ cover: join(app, 'library_600x900.jpg') })
    expect(Object.values(media).every((path) => typeof path === 'string')).toBe(true)
  })
})

describe('scanSteamRoot', () => {
  it('scans every library, filters manifests, adds play time and local art', async () => {
    const root = join(dir, 'Steam')
    const lib2 = join(dir, 'SteamLibrary')
    const common = join(root, 'steamapps', 'common')
    const common2 = join(lib2, 'steamapps', 'common')
    await writeFile(join(root, 'steam.exe'), 'exe')
    await writeFile(
      join(root, 'steamapps', 'libraryfolders.vdf'),
      `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${vdfPath(root)}"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"${vdfPath(lib2)}"\n\t}\n\t"2"\n\t{\n\t\t"path"\t\t"${vdfPath(join(dir, 'Unplugged'))}"\n\t}\n}\n`
    )
    const manifests: Record<string, string> = {
      appmanifest_620: acf({
        appid: 620,
        name: 'Portal 2',
        StateFlags: 4,
        installdir: 'Portal 2',
        LastPlayed: 1600000000,
        SizeOnDisk: 12345
      }),
      appmanifest_2185060: acf({
        appid: 2185060,
        name: 'Two Point Museum™',
        StateFlags: 6,
        installdir: 'Two Point Museum',
        LastPlayed: 1783255739
      }),
      appmanifest_1000: acf({
        appid: 1000,
        name: 'Downloading Game',
        StateFlags: 1026,
        installdir: 'Downloading Game'
      }),
      appmanifest_2000: acf({
        appid: 2000,
        name: 'Deleted Game',
        StateFlags: 4,
        installdir: 'Deleted Game'
      }),
      appmanifest_228980: acf({
        appid: 228980,
        name: 'Steamworks Common Redistributables',
        StateFlags: 4,
        installdir: 'Steamworks Shared'
      }),
      appmanifest_2805730: acf({
        appid: 2805730,
        name: 'Proton 9.0 (Beta)',
        StateFlags: 4,
        installdir: 'Proton 9.0 (Beta)'
      }),
      appmanifest_3000: acf({
        appid: 3000,
        name: 'Portal 2 Soundtrack',
        StateFlags: 4,
        installdir: 'Portal 2 OST'
      }),
      appmanifest_4000: '"AppState"\n{\n\t"appid"\t\t"4000"\n\t"name"\t\t"Truncated',
      appmanifest_5000: acf({ appid: 5000, StateFlags: 4, installdir: 'Nameless' })
    }
    for (const [name, text] of Object.entries(manifests))
      await writeFile(join(root, 'steamapps', `${name}.acf`), text)
    await writeFile(
      join(root, 'steamapps', 'appmanifest_6000.acf.tmp'),
      acf({ appid: 6000, name: 'Temp', StateFlags: 4, installdir: 'Portal 2' })
    )
    await writeFile(join(root, 'steamapps', 'appmanifest_7000.acf'), '')
    for (const folder of [
      'Portal 2',
      'Two Point Museum',
      'Downloading Game',
      'Steamworks Shared',
      'Proton 9.0 (Beta)',
      'Nameless'
    ]) {
      await fs.mkdir(join(common, folder), { recursive: true })
    }
    await fs.mkdir(join(root, 'steamapps', 'music', 'Portal 2 OST'), { recursive: true })

    await writeFile(
      join(lib2, 'steamapps', 'appmanifest_620.acf'),
      acf({ appid: 620, name: 'Portal 2 (duplicate)', StateFlags: 4, installdir: 'Portal 2' })
    )
    await writeFile(
      join(lib2, 'steamapps', 'appmanifest_440.acf'),
      acf({ appid: 440, name: 'Team Fortress 2', StateFlags: 4, installdir: 'Team Fortress 2' })
    )
    await fs.mkdir(join(common2, 'Portal 2'), { recursive: true })
    await fs.mkdir(join(common2, 'Team Fortress 2'), { recursive: true })

    await writeFile(
      join(root, 'config', 'loginusers.vdf'),
      loginUsers([
        { id: '76561198000000202', name: 'other', fields: { AutoLogin: 1, timestamp: 1793300699 } },
        {
          id: '76561198000000101',
          name: 'player_one',
          fields: { MostRecent: 1, timestamp: 1700000000 }
        }
      ])
    )
    await writeFile(join(root, 'userdata', '39734373', 'config', 'localconfig.vdf'), LOCALCONFIG)
    await writeFile(
      join(root, 'userdata', '39734474', 'config', 'localconfig.vdf'),
      LOCALCONFIG.replace('"Playtime"\t\t"1108"', '"Playtime"\t\t"1"')
    )

    const cache = join(root, 'appcache', 'librarycache')
    await writeFile(join(cache, '620', 'library_600x900.jpg'), 'cover')
    await writeFile(join(cache, '620', 'logo.png'), 'logo')
    await writeFile(join(cache, '620', '25a5a16b2423bf7487ac5340b5b0948cef48c5f8.jpg'), 'icon')
    await writeFile(
      join(cache, '620', 'a58588d857b8683f8065e55f97ab82ad8a945c51', 'library_hero.jpg'),
      'hero'
    )
    await writeFile(join(cache, '440_library_600x900.jpg'), 'cover')
    await writeFile(join(cache, '440_logo.png'), 'logo')

    const progress = vi.fn()
    const warn = vi.fn()
    const games = await scanSteamRoot(
      root,
      scanContext({ progress, log: { ...silentLog, warn } }),
      { autoLoginUser: 'other' }
    )

    // Manifests are visited sorted by app id within a library; libraries in libraryfolders.vdf order.
    expect(games.map((g) => g.externalId)).toEqual(['620', '5000', '2185060', '440'])

    const portal = games[0]
    expect(portal).toEqual({
      source: 'steam',
      externalId: '620',
      platformId: 'steam',
      title: 'Portal 2',
      installDir: join(common, 'Portal 2'),
      launch: { kind: 'uri', uri: 'steam://rungameid/620' },
      tracking: { mode: 'installDir', installDir: join(common, 'Portal 2') },
      storePlaytimeMinutes: 1108,
      lastPlayed: new Date(1777548408 * 1000).toISOString(),
      localMedia: {
        cover: join(cache, '620', 'library_600x900.jpg'),
        hero: join(cache, '620', 'a58588d857b8683f8065e55f97ab82ad8a945c51', 'library_hero.jpg'),
        logo: join(cache, '620', 'logo.png'),
        icon: join(cache, '620', '25a5a16b2423bf7487ac5340b5b0948cef48c5f8.jpg')
      },
      metadata: { links: { store: 'https://store.steampowered.com/app/620' } },
      extra: { steamAppId: 620, sizeOnDisk: 12345 }
    })

    const museum = games[2]
    expect(museum.title).toBe('Two Point Museum')
    expect(museum.storePlaytimeMinutes).toBeUndefined()
    expect(museum.lastPlayed).toBe(new Date(1783255739 * 1000).toISOString())
    expect(museum.localMedia).toBeUndefined()
    // No SizeOnDisk in the manifest: 0 (unknown) is written so a stale size from an older scan is replaced.
    expect(museum.extra).toEqual({ steamAppId: 2185060, sizeOnDisk: 0 })

    expect(games[1].title).toBe('Nameless')
    expect(games[1].lastPlayed).toBeUndefined()

    const tf2 = games[3]
    expect(tf2.installDir).toBe(join(common2, 'Team Fortress 2'))
    expect(tf2.localMedia).toEqual({
      cover: join(cache, '440_library_600x900.jpg'),
      logo: join(cache, '440_logo.png')
    })

    // One warning per unparsable manifest (truncated 4000, empty 7000); everything else is skipped quietly.
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringContaining('appmanifest_4000.acf'),
      expect.stringContaining('appmanifest_7000.acf')
    ])

    // Progress: start and end of each of the two existing libraries; the unplugged one is skipped.
    expect(progress.mock.calls).toEqual([
      [0, `Scanning ${root}`],
      [3, `${root}: 3 games`],
      [3, `Scanning ${lib2}`],
      [4, `${lib2}: 1 game`]
    ])
  })

  it('still scans when libraryfolders.vdf, loginusers.vdf and the art cache are missing', async () => {
    const root = join(dir, 'Steam')
    await writeFile(
      join(root, 'steamapps', 'appmanifest_620.acf'),
      acf({ appid: 620, name: 'Portal 2', StateFlags: 4, installdir: 'Portal 2' })
    )
    await fs.mkdir(join(root, 'steamapps', 'common', 'Portal 2'), { recursive: true })
    const games = await scanSteamRoot(root, scanContext())
    expect(games).toHaveLength(1)
    expect(games[0]).toMatchObject({
      title: 'Portal 2',
      storePlaytimeMinutes: undefined,
      lastPlayed: undefined,
      localMedia: undefined
    })
  })
})

// ---------------------------------------------------------------------------
// Integration: the Steam client on this machine (skipped when absent)
// ---------------------------------------------------------------------------

describe('scanSteamLibraries: unreachable libraries', () => {
  it('reports a library whose folder is gone (unplugged drive) and not one that merely lost its steamapps', async () => {
    const root = join(dir, 'Steam')
    const unplugged = join(dir, 'Unplugged', 'SteamLibrary')
    const emptied = join(dir, 'Emptied')
    await writeFile(join(root, 'steam.exe'), 'exe')
    await fs.mkdir(emptied, { recursive: true })
    await writeFile(
      join(root, 'steamapps', 'libraryfolders.vdf'),
      `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${vdfPath(root)}"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"${vdfPath(unplugged)}"\n\t}\n\t"2"\n\t{\n\t\t"path"\t\t"${vdfPath(emptied)}"\n\t}\n}\n`
    )
    await writeFile(
      join(root, 'steamapps', 'appmanifest_620.acf'),
      acf({ appid: 620, name: 'Portal 2', StateFlags: 4, installdir: 'Portal 2' })
    )
    await fs.mkdir(join(root, 'steamapps', 'common', 'Portal 2'), { recursive: true })

    const result = await scanSteamLibraries(root, scanContext())
    expect(result.games.map((g) => g.externalId)).toEqual(['620'])
    expect(result.unreachableLibraries).toEqual([unplugged])
    // The plain form still answers the games alone.
    expect((await scanSteamRoot(root, scanContext())).map((g) => g.externalId)).toEqual(['620'])
  })
})

describe('steamProvider (integration)', () => {
  // Two one-shot PowerShell registry reads (20 s cap each inside readRegistryKey) plus the scan: bounded by 60 s.
  it(
    'detects and scans the locally installed Steam client',
    { timeout: 60_000 },
    async ({ skip }) => {
      const info = await steamProvider.detectClient()
      if (!info.installed) skip('Steam is not installed on this machine')
      expect(info.path).toMatch(/\\steam$/i)

      const found: number[] = []
      const games = await steamProvider.scanInstalled(
        scanContext({ progress: (n) => found.push(n) })
      )
      console.log(
        `steam: ${games.length} installed games from ${info.path}; e.g. ${games
          .slice(0, 3)
          .map((g) => g.title)
          .join(' | ')}`
      )

      expect(games.length).toBeGreaterThan(0)
      expect(found.length).toBeGreaterThanOrEqual(2)
      expect(found[found.length - 1]).toBe(games.length)
      expect(new Set(games.map((g) => g.externalId)).size).toBe(games.length)
      for (const game of games) {
        expect(game.source).toBe('steam')
        expect(game.title).not.toMatch(/[™®©]/)
        expect(game.launch).toEqual({ kind: 'uri', uri: `steam://rungameid/${game.externalId}` })
        expect(game.tracking).toEqual({ mode: 'installDir', installDir: game.installDir })
        expect(game.extra?.steamAppId).toBe(Number(game.externalId))
        expect(await isDirectory(game.installDir!)).toBe(true)
        for (const path of Object.values(game.localMedia ?? {}))
          expect(await fs.stat(path)).toBeTruthy()
      }
      expect(games.find((g) => g.externalId === '228980')).toBeUndefined()
      const withArt = games.filter((g) => g.localMedia?.cover).length
      const withPlaytime = games.filter((g) => g.storePlaytimeMinutes !== undefined).length
      console.log(`steam: ${withArt} with a cached cover, ${withPlaytime} with store play time`)
    }
  )
})
