import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join, parse } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import type { ScannedGame } from '../../shared/types'
import { EventBus } from '../events'
import type { GameProvider, ProviderRegistry } from '../providers/types'
import type { EnqueueOptions, MetadataService } from '../scrapers/types'
import { ensureDefaultEmulationDir, keepRomsRootInSync } from '../emulation/emulation-dir'
import { LibraryStore } from '../store/library-store'
import { SessionsStore } from '../store/sessions-store'
import { SettingsStore } from '../store/settings-store'
import { LibraryService } from './library-service'
import {
  createScanService,
  gamesOnMissingVolumes,
  startupScanSources,
  type ScanService
} from './scan-service'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

let dir: string
let library: LibraryService
let settings: SettingsStore
let enqueued: { ids: string[]; options?: EnqueueOptions }[]
let scanned: ScannedGame[]
/** The volume roots that are "not connected" (lower case); every other folder is there. */
let missingVolumes: Set<string>

function game(externalId: string, cover?: string): ScannedGame {
  return {
    source: 'steam',
    externalId,
    platformId: 'steam',
    title: `Game ${externalId}`,
    launch: { kind: 'uri', uri: `steam://rungameid/${externalId}` },
    tracking: { mode: 'installDir', installDir: `C:\\Steam\\${externalId}` },
    extra: { steamAppId: Number(externalId) },
    localMedia: cover ? { cover } : undefined
  }
}

function service(
  overrides: Partial<GameProvider> = {},
  events: EventBus = new EventBus(),
  onScanned?: (id: string) => void
): ScanService {
  const steam: GameProvider = {
    id: 'steam',
    name: 'Steam',
    platforms: () => [],
    detectClient: async () => ({ installed: true }),
    scanInstalled: async () => scanned,
    ...overrides
  }
  const providers: ProviderRegistry = {
    all: () => [steam],
    get: (id) => (id === 'steam' ? steam : undefined),
    manual: undefined as unknown as ProviderRegistry['manual'],
    rom: { lastUnknownFolders: () => [] } as unknown as ProviderRegistry['rom']
  }
  const metadata = {
    enqueue: (ids: string[], options?: EnqueueOptions) => enqueued.push({ ids, options })
  } as unknown as MetadataService
  const scan = createScanService({
    providers,
    library,
    settings,
    events,
    metadata,
    resourcesDir: join(dir, 'resources'),
    log,
    isDirectory: async (path) => !missingVolumes.has(path.toLowerCase())
  })
  if (onScanned) scan.onSourceScanned(onScanned)
  return scan
}

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-scan-'))
  const libStore = new LibraryStore(join(dir, 'library.json'))
  const sessions = new SessionsStore(join(dir, 'sessions.json'))
  settings = new SettingsStore(join(dir, 'settings.json'))
  await Promise.all([libStore.load(), sessions.load(), settings.load()])
  library = new LibraryService(libStore, sessions, new EventBus())
  enqueued = []
  scanned = []
  missingVolumes = new Set()
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('scan service and the metadata queue', () => {
  it('queues new games with their local art, and later only the art a game still lacks', async () => {
    scanned = [
      game('620', 'C:\\Steam\\appcache\\librarycache\\620\\library_600x900.jpg'),
      game('440')
    ]
    const scan = service()
    await scan.run(['steam'])
    expect(enqueued).toEqual([
      {
        ids: ['steam:620', 'steam:440', 'steam:620'],
        options: {
          seeds: [
            {
              gameId: 'steam:620',
              kind: 'cover',
              path: 'C:\\Steam\\appcache\\librarycache\\620\\library_600x900.jpg'
            }
          ],
          coverOnly: false
        }
      }
    ])
    // The cover landed; a user rescan reports the same file but the game has a cover now: nothing queued.
    library.setMedia('steam:620', 'cover', 'media://cache/steam_620/cover.jpg?v=1')
    enqueued = []
    await scan.run(['steam'])
    expect(enqueued).toEqual([])
  })

  it("does not queue the install tracker's confirming scans unless they found a new game", async () => {
    scanned = [game('620', 'C:\\Steam\\appcache\\librarycache\\620\\library_600x900.jpg')]
    const scan = service()
    await scan.run(['steam'])
    enqueued = []
    // Every 10 s while an install is tracked: same games, same art, no cover landed yet (network down).
    await scan.run(['steam'], { reason: 'confirm' })
    await scan.run(['steam'], { reason: 'confirm' })
    expect(enqueued).toEqual([])
    // The install finished: the new game is queued, with its art.
    scanned = [
      ...scanned,
      game('440', 'C:\\Steam\\appcache\\librarycache\\440\\library_600x900.jpg')
    ]
    await scan.run(['steam'], { reason: 'confirm' })
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0].ids).toContain('steam:440')
    expect(enqueued[0].options?.seeds?.map((s) => s.gameId)).toEqual(['steam:620', 'steam:440'])
  })
})

describe('scan service: libraries the provider could not reach', () => {
  const installedAt = (externalId: string, installDir: string): ScannedGame => ({
    ...game(externalId),
    installDir,
    tracking: { mode: 'installDir', installDir }
  })

  it('keeps the games of an unreachable library as they were, and still marks the others missing', async () => {
    scanned = [
      installedAt('620', 'C:\\Steam\\steamapps\\common\\Portal 2'),
      installedAt('440', 'C:\\Steam\\steamapps\\common\\Team Fortress 2'),
      installedAt('730', 'E:\\SteamLibrary\\steamapps\\common\\Counter-Strike')
    ]
    let unreachable: string[] = []
    const scan = service({ unreachableRoots: () => unreachable })
    await scan.run(['steam'])

    // The drive of E: is unplugged: the provider reports only what it could see, and says what it could not reach.
    scanned = [installedAt('620', 'C:\\Steam\\steamapps\\common\\Portal 2')]
    unreachable = ['e:/SteamLibrary/']
    const result = await scan.run(['steam'])
    expect(result.removed).toBe(1)
    expect(library.getGame('steam:440')).toMatchObject({ installed: false })
    expect(library.getGame('steam:730')).toMatchObject({
      installed: true,
      installDir: 'E:\\SteamLibrary\\steamapps\\common\\Counter-Strike'
    })

    // The library is reachable again and the game is really gone from it: now it is marked.
    unreachable = []
    await scan.run(['steam'])
    expect(library.getGame('steam:730')).toMatchObject({ installed: false })
  })

  // path.parse only knows drive letters on Windows; elsewhere these paths have no volume and the guard is not used.
  it.runIf(process.platform === 'win32')(
    'keeps the games on a drive that is not connected even when the provider does not report the library',
    async () => {
      scanned = [
        installedAt('620', 'C:\\Steam\\steamapps\\common\\Portal 2'),
        installedAt('440', 'C:\\Steam\\steamapps\\common\\Team Fortress 2'),
        installedAt('730', 'E:\\SteamLibrary\\steamapps\\common\\Counter-Strike')
      ]
      // No unreachableRoots at all: libraryfolders.vdf no longer lists the library, or is missing.
      const scan = service()
      await scan.run(['steam'])
      const before = library.getGame('steam:730')

      scanned = [installedAt('620', 'C:\\Steam\\steamapps\\common\\Portal 2')]
      missingVolumes = new Set(['e:\\'])
      const result = await scan.run(['steam'])
      // The game on the connected drive is still marked; the one on the missing drive is untouched.
      expect(result.removed).toBe(1)
      expect(library.getGame('steam:440')).toMatchObject({ installed: false })
      expect(library.getGame('steam:730')).toEqual(before)
      expect(before).toMatchObject({ installed: true })

      // The drive is back and the game is not on it: now it is marked.
      missingVolumes = new Set()
      await scan.run(['steam'])
      expect(library.getGame('steam:730')).toMatchObject({ installed: false })
    }
  )
})

describe('gamesOnMissingVolumes', () => {
  const root = parse(tmpdir()).root
  const games = [
    {
      id: 'steam:1',
      source: 'steam' as const,
      installed: true,
      installDir: join(root, 'a', 'One')
    },
    {
      id: 'steam:2',
      source: 'steam' as const,
      installed: false,
      installDir: join(root, 'a', 'Two')
    },
    { id: 'steam:3', source: 'steam' as const, installed: true, installDir: undefined },
    {
      id: 'steam:4',
      source: 'steam' as const,
      installed: true,
      installDir: join('relative', 'Four')
    },
    { id: 'epic:5', source: 'epic' as const, installed: true, installDir: join(root, 'b', 'Five') },
    { id: 'steam:6', source: 'steam' as const, installed: true, installDir: join(root, 'c', 'Six') }
  ]

  it('keeps only the installed games of the source whose volume is gone, asking once per volume', async () => {
    const asked: string[] = []
    const gone = await gamesOnMissingVolumes(games, 'steam', async (path) => {
      asked.push(path)
      return false
    })
    expect([...gone].sort()).toEqual(['steam:1', 'steam:6'])
    expect(asked).toEqual([root.toLowerCase()])
  })

  it('keeps nothing while the volume is there', async () => {
    expect((await gamesOnMissingVolumes(games, 'steam', async () => true)).size).toBe(0)
    // The real check: the volume of the temp folder exists.
    expect((await gamesOnMissingVolumes(games, 'steam')).size).toBe(0)
  })
})

describe('scan service: concurrent runs of one source', () => {
  /** A provider whose first scan waits for `release`. */
  function gated(): { overrides: Partial<GameProvider>; release: () => void; scans: () => number } {
    let release: () => void = () => {}
    let gate = new Promise<void>((r) => (release = r))
    let scans = 0
    return {
      overrides: {
        scanInstalled: async () => {
          scans++
          await gate
          gate = Promise.resolve()
          return scanned
        }
      },
      release: () => release(),
      scans: () => scans
    }
  }
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10))

  it('gives a call that joined a running scan the counts of that scan', async () => {
    scanned = [game('620'), game('440')]
    const g = gated()
    const scan = service(g.overrides)
    const first = scan.run(['steam'])
    await tick()
    const joined = scan.run(['steam'])
    await tick()
    g.release()
    const [a, b] = await Promise.all([first, joined])
    expect(g.scans()).toBe(1)
    expect(a).toMatchObject({ added: 2, updated: 0, removed: 0 })
    expect(b).toMatchObject({ added: 2, updated: 0, removed: 0 })
    expect(scan.isRunning()).toBe(false)
  })

  it('runs a full scan after a confirming one instead of joining it: progress events and the scanned listeners', async () => {
    scanned = [game('620')]
    const g = gated()
    const events = new EventBus()
    const phases: string[] = []
    events.on('scan:progress', (p) => phases.push(p.phase))
    const listened: string[] = []
    const scan = service(g.overrides, events, (id) => listened.push(id))
    const confirming = scan.run(['steam'], { reason: 'confirm' })
    await tick()
    const user = scan.run(['steam'])
    // A second confirming scan meanwhile joins what is running rather than starting a third.
    const confirmingAgain = scan.run(['steam'], { reason: 'confirm' })
    await tick()
    expect(phases).toEqual([])
    expect(scan.isRunning()).toBe(true)
    g.release()
    expect(await confirming).toMatchObject({ added: 1 })
    await Promise.all([user, confirmingAgain])
    expect(g.scans()).toBe(2)
    expect(phases).toEqual(['detecting', 'scanning', 'done'])
    expect(listened).toEqual(['steam'])
    expect(scan.isRunning()).toBe(false)
  })

  it('a confirming scan joins a full scan that is running', async () => {
    scanned = [game('620')]
    const g = gated()
    const scan = service(g.overrides)
    const user = scan.run(['steam'])
    await tick()
    const confirming = scan.run(['steam'], { reason: 'confirm' })
    await tick()
    g.release()
    expect(await confirming).toMatchObject({ added: 1 })
    expect(await user).toMatchObject({ added: 1 })
    expect(g.scans()).toBe(1)
  })
})

describe('startupScanSources', () => {
  const lib = (romsRoot: string | null): Parameters<typeof startupScanSources>[1] =>
    ({ library: { romsRoot } }) as Parameters<typeof startupScanSources>[1]

  it('scans the ROM folder at startup even before the library has a ROM', () => {
    expect([...startupScanSources([], lib('D:/ROMs'))]).toEqual(['rom'])
    expect([...startupScanSources([{ source: 'steam' }], lib('D:/ROMs'))].sort()).toEqual([
      'rom',
      'steam'
    ])
  })

  it('covers only the sources with games while no ROM folder is set', () => {
    expect([...startupScanSources([], lib(null))]).toEqual([])
    expect([...startupScanSources([{ source: 'gog' }, { source: 'gog' }], lib(null))]).toEqual([
      'gog'
    ])
  })
})

describe('scan service new-games listeners', () => {
  it('tells the listeners the ids a scan added, never the games it already had', async () => {
    scanned = [game('620')]
    const scan = service()
    const seen: [string, string[]][] = []
    const off = scan.onNewGames((id, ids) => seen.push([id, ids]))
    await scan.run(['steam'])
    await scan.run(['steam'])
    scanned = [game('620'), game('440')]
    await scan.run(['steam'], { reason: 'confirm' })
    expect(seen).toEqual([
      ['steam', ['steam:620']],
      ['steam', ['steam:440']]
    ])
    off()
    scanned = [game('620'), game('440'), game('10')]
    await scan.run(['steam'])
    expect(seen).toHaveLength(2)
  })
})

describe("an old settings file's own ROM folder at the first startup scan", () => {
  /** Like the real ROM provider: fails on a missing ROM folder, else one game per file in each system folder. */
  const romProvider: GameProvider = {
    id: 'rom',
    name: 'ROMs',
    platforms: () => [],
    detectClient: async () => ({ installed: true }),
    scansWithoutClient: true,
    scanInstalled: async (ctx) => {
      const root = ctx.settings.library.romsRoot!
      const roms = await scanRoms(root)
      if (!roms) throw new Error(`ROM folder not found: ${root}`)
      return roms
    }
  } as GameProvider

  async function scanRoms(root: string): Promise<ScannedGame[] | null> {
    const systems = await fs.readdir(root, { withFileTypes: true }).catch(() => null)
    if (!systems) return null
    const games: ScannedGame[] = []
    for (const system of systems.filter((e) => e.isDirectory()))
      for (const entry of await fs.readdir(join(root, system.name), { withFileTypes: true })) {
        if (!entry.isFile()) continue
        const file = entry.name
        const romPath = join(root, system.name, file)
        games.push({
          source: 'rom',
          externalId: `${system.name}/${file}`,
          platformId: system.name,
          title: file,
          romPath,
          launch: { kind: 'emulator', systemId: system.name, romPath },
          tracking: { mode: 'spawned' }
        })
      }
    return games
  }

  function romScan(): ScanService {
    const providers: ProviderRegistry = {
      all: () => [romProvider],
      get: (id) => (id === 'rom' ? romProvider : undefined),
      manual: undefined as unknown as ProviderRegistry['manual'],
      rom: { lastUnknownFolders: () => [] } as unknown as ProviderRegistry['rom']
    }
    const metadata = { enqueue: () => undefined } as unknown as MetadataService
    return createScanService({
      providers,
      library,
      settings,
      events: new EventBus(),
      metadata,
      resourcesDir: join(dir, 'resources'),
      log
    })
  }

  /** The old install: ROMs in `oldRoot`, scanned into the library while it was the ROM folder. */
  async function oldInstall(oldRoot: string): Promise<void> {
    await fs.mkdir(join(oldRoot, 'snes'), { recursive: true })
    await fs.writeFile(join(oldRoot, 'snes', 'Mario.sfc'), '')
    await fs.writeFile(join(oldRoot, 'snes', 'Zelda.sfc'), '')
    settings.update({ library: { romsRoot: oldRoot } })
    await romScan().run(['rom'])
    expect(library.games().filter((g) => g.installed)).toHaveLength(2)
  }

  /** The first start after the update: the sync, the Emulation folder made, then the deferred ROM scan. */
  async function firstStartup(): Promise<void> {
    const userData = join(dir, 'userData')
    keepRomsRootInSync({ settings, userData })
    await ensureDefaultEmulationDir({ settings, userData, systemIds: ['snes'], log: log as never })
    await romScan().run([...startupScanSources(library.games(), settings.get())])
  }

  it('named roms: becomes the Emulation folder, every ROM keeps its card', async () => {
    const oldRoot = join(dir, 'Desktop', 'Roms')
    await oldInstall(oldRoot)
    await firstStartup()
    expect(settings.get().library.emulationDir).toBe(join(dir, 'Desktop'))
    const games = library.games()
    expect(games.map((g) => g.title).sort()).toEqual(['Mario.sfc', 'Zelda.sfc'])
    expect(games.every((g) => g.installed)).toBe(true)
  })

  it('named otherwise: its ROMs still there keep their cards; one whose file is gone goes', async () => {
    const oldRoot = join(dir, 'My ROMs')
    await oldInstall(oldRoot)
    await fs.rm(join(oldRoot, 'snes', 'Zelda.sfc'))
    await firstStartup()
    expect(settings.get().library.romsRoot).toBe(join(dir, 'userData', 'Emulation', 'roms'))
    expect(library.games().map((g) => [g.title, g.installed])).toEqual([['Mario.sfc', true]])
    // A second start (nothing marks the first) keeps it too, while the file is there.
    await romScan().run(['rom'])
    expect(library.games().map((g) => g.title)).toEqual(['Mario.sfc'])
  })
})
