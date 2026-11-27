import { promises as fs } from 'fs'
import { homedir, tmpdir } from 'os'
import { join, parse } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import type { Game, ScannedGame } from '../../shared/types'
import { EventBus } from '../events'
import { HttpError } from '../scrapers/http'
import type { SteamAppDetails } from '../scrapers/steam-store'
import { LibraryStore } from '../store/library-store'
import { SessionsStore } from '../store/sessions-store'
import {
  createInstallSizeService,
  folderSize,
  isSharedFolder,
  STEAM_SIZE_RULES,
  type InstallSizeOptions,
  type InstallSizeService
} from './install-size'
import { LibraryService } from './library-service'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const DAY = 24 * 60 * 60 * 1000
const MB = 1024 ** 2
const GB = 1024 ** 3

type FolderFn = NonNullable<InstallSizeOptions['folderSize']>
type PathFn = NonNullable<InstallSizeOptions['pathSize']>
type DetailsFn = NonNullable<InstallSizeOptions['steamDetails']>
type ExactFn = NonNullable<InstallSizeOptions['steamInstallSize']>
type GogFn = NonNullable<InstallSizeOptions['gogInstallSize']>
type SearchFn = NonNullable<InstallSizeOptions['steamAppIdByTitle']>
type Size = NonNullable<Game['installSize']>

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let dir: string
let libStore: LibraryStore
let sessions: SessionsStore
let library: LibraryService
let events: EventBus
/** gameIds of every `library:changed` with reason 'update' (setInstallSizes). */
let updates: string[][]
/** gameIds of every `library:changed` with reason 'metadata' (applyMetadata). */
let metadataChanges: string[][]
let service: InstallSizeService | null
let fetchStub: ReturnType<typeof vi.fn>
/** The store lookups the last created service uses (injected or the harness's quiet defaults). */
let lookups: {
  steamDetails: DetailsFn
  steamInstallSize: ExactFn
  gogInstallSize: GogFn
  steamAppIdByTitle: SearchFn
}

/**
 * A service whose store lookups answer "nothing" unless a test injects its own: nothing may fall through to the
 * real network (the fetch stub also guards it).
 */
function createService(options: InstallSizeOptions = {}): InstallSizeService {
  lookups = {
    steamDetails: vi.fn<DetailsFn>(async () => null),
    steamInstallSize: vi.fn<ExactFn>(async () => undefined),
    gogInstallSize: vi.fn<GogFn>(async () => undefined),
    steamAppIdByTitle: vi.fn<SearchFn>(async () => undefined)
  }
  Object.assign(lookups, Object.fromEntries(Object.entries(options).filter(([k]) => k in lookups)))
  service = createInstallSizeService({ library, log }, { ...options, ...lookups })
  return service
}

function steam(appId: number, extra: ScannedGame['extra'] = {}, title?: string): ScannedGame {
  return {
    source: 'steam',
    externalId: String(appId),
    platformId: 'steam',
    title: title ?? `Steam ${appId}`,
    installDir: join(dir, 'steam', String(appId)),
    launch: { kind: 'uri', uri: `steam://rungameid/${appId}` },
    tracking: { mode: 'installDir', installDir: join(dir, 'steam', String(appId)) },
    extra: { steamAppId: appId, ...extra }
  }
}

function epic(id: string, extra?: ScannedGame['extra'], title?: string): ScannedGame {
  return {
    source: 'epic',
    externalId: id,
    platformId: 'epic',
    title: title ?? `Epic ${id}`,
    installDir: join(dir, 'epic', id),
    launch: { kind: 'uri', uri: `com.epicgames.launcher://apps/${id}` },
    tracking: { mode: 'installDir', installDir: join(dir, 'epic', id) },
    extra
  }
}

function gog(id: string, installDir: string, extra?: ScannedGame['extra']): ScannedGame {
  return {
    source: 'gog',
    externalId: id,
    platformId: 'gog',
    title: `GOG ${id}`,
    installDir,
    launch: { kind: 'exec', file: join(installDir, 'game.exe'), args: [] },
    tracking: { mode: 'installDir', installDir },
    extra
  }
}

function rom(romPath: string, name: string): ScannedGame {
  return {
    source: 'rom',
    externalId: `snes/${name}`,
    platformId: 'snes',
    title: name,
    romPath,
    launch: { kind: 'emulator', systemId: 'snes', romPath },
    tracking: { mode: 'spawned' }
  }
}

/** A game added by hand: its install folder is its exe's folder. */
function manual(installDir: string, title: string): ScannedGame {
  const exePath = join(installDir, 'game.exe')
  return {
    source: 'manual',
    externalId: exePath.toLowerCase(),
    platformId: 'pc',
    title,
    installDir,
    exePath,
    launch: { kind: 'exec', file: exePath, args: [], cwd: installDir },
    tracking: { mode: 'spawned' }
  }
}

/** Add scan entries for their sources and return their ids in order. */
function add(...scans: ScannedGame[]): string[] {
  const ids: string[] = []
  for (const s of scans) {
    const res = library.mergeScan(s.source, [s], { markMissing: false })
    ids.push(
      res.newGameIds[0] ??
        library.games().find((g) => g.source === s.source && g.externalId === s.externalId)!.id
    )
  }
  return ids
}

/** Mark every installed game of `source` not installed (a scan that reports none). */
const uninstallAll = (source: ScannedGame['source']): void => {
  // A deleted ROM without user state is removed rather than greyed out: a favourite keeps the record.
  if (source === 'rom')
    for (const g of library.games())
      if (g.source === 'rom') library.updateGame(g.id, { favorite: true })
  library.mergeScan(source, [])
}

async function writeTree(root: string, files: Record<string, number | string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel)
    await fs.mkdir(join(path, '..'), { recursive: true })
    await fs.writeFile(path, typeof content === 'string' ? content : Buffer.alloc(content, 1))
  }
}

const size = (bytes: number, path: string, how: 'store' | 'file' | 'folder', ageMs = 0): Size => ({
  bytes,
  how,
  path,
  measuredAt: new Date(Date.now() - ageMs).toISOString()
})

const unmeasurable = (path: string, ageMs = 0): Size => ({
  ...size(0, path, 'folder', ageMs),
  unmeasurable: true
})

const game = (id: string): Game => library.getGame(id)!

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

const recent = (iso: string | undefined): boolean => !!iso && Date.parse(iso) > Date.now() - 60_000

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-size-'))
  events = new EventBus()
  updates = []
  metadataChanges = []
  events.on('library:changed', (p) => {
    if (p.reason === 'update') updates.push(p.gameIds ?? [])
    if (p.reason === 'metadata') metadataChanges.push(p.gameIds ?? [])
  })
  libStore = new LibraryStore(join(dir, 'library.json'))
  sessions = new SessionsStore(join(dir, 'sessions.json'))
  await Promise.all([libStore.load(), sessions.load()])
  library = new LibraryService(libStore, sessions, events)
  service = null
  fetchStub = vi.fn(async () => {
    throw new Error('unexpected network call')
  })
  vi.stubGlobal('fetch', fetchStub)
})

afterEach(async () => {
  await service?.dispose()
  expect(fetchStub).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  // The stores' debounced saves (400 ms / 1 s) would otherwise land in the folder while it is being removed.
  await Promise.all([libStore.flush(), sessions.flush()])
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 })
})

// ---------------------------------------------------------------------------
// folderSize
// ---------------------------------------------------------------------------

describe('folderSize', () => {
  it('adds up the files of a nested tree', async () => {
    const root = join(dir, 'game')
    await writeTree(root, {
      'game.exe': 1000,
      'data/a.pak': 2048,
      'data/b.pak': 10,
      'data/deep/deeper/c.bin': 7,
      'empty.txt': 0
    })
    await fs.mkdir(join(root, 'empty-dir'))
    expect(await folderSize(root)).toBe(1000 + 2048 + 10 + 7)
  })

  it('adds up a folder with more files than one stat batch', async () => {
    const root = join(dir, 'many')
    const files: Record<string, number> = {}
    for (let i = 0; i < 37; i++) files[`f${i}.bin`] = i + 1
    await writeTree(root, files)
    expect(await folderSize(root)).toBe((37 * 38) / 2)
  })

  it('is 0 for an empty folder', async () => {
    const root = join(dir, 'empty')
    await fs.mkdir(root)
    expect(await folderSize(root)).toBe(0)
  })

  it('does not follow a junction or symlink to another folder', async () => {
    const root = join(dir, 'game')
    const outside = join(dir, 'outside')
    await writeTree(root, { 'game.exe': 100 })
    await writeTree(outside, { 'huge.bin': 50_000 })
    try {
      await fs.symlink(outside, join(root, 'link'), 'junction')
    } catch {
      return // links not creatable here
    }
    expect(await folderSize(root)).toBe(100)
  })

  it('does not count a file symlink', async () => {
    const root = join(dir, 'game')
    await writeTree(root, { 'game.exe': 100 })
    await writeTree(join(dir, 'outside'), { 'huge.bin': 50_000 })
    try {
      await fs.symlink(join(dir, 'outside', 'huge.bin'), join(root, 'huge.lnk'), 'file')
    } catch {
      return // file symlinks need Developer Mode or admin on Windows
    }
    expect(await folderSize(root)).toBe(100)
  })

  it('is null when the root cannot be read', async () => {
    expect(await folderSize(join(dir, 'missing'))).toBeNull()
    await fs.writeFile(join(dir, 'file.bin'), 'x')
    expect(await folderSize(join(dir, 'file.bin'))).toBeNull()
  })

  it('gives up (null) once the deadline has passed', async () => {
    const root = join(dir, 'game')
    await writeTree(root, { 'game.exe': 100, 'data/a.pak': 5 })
    expect(await folderSize(root, { deadlineMs: -1 })).toBeNull()
    expect(await folderSize(root, { deadlineMs: 60_000 })).toBe(105)
  })
})

// ---------------------------------------------------------------------------
// isSharedFolder
// ---------------------------------------------------------------------------

describe('isSharedFolder', () => {
  it('knows the home folder and its well-known folders', () => {
    const home = homedir()
    expect(isSharedFolder(home)).toBe(true)
    expect(isSharedFolder(join(home, 'Desktop'))).toBe(true)
    expect(isSharedFolder(join(home, 'Downloads'))).toBe(true)
    expect(isSharedFolder(join(home, 'Documents'))).toBe(true)
    expect(isSharedFolder(join(home, 'OneDrive'))).toBe(true)
    expect(isSharedFolder(join(home, 'OneDrive', 'Desktop'))).toBe(true)
  })

  it('ignores case and trailing separators', () => {
    const desktop = join(homedir(), 'Desktop')
    expect(isSharedFolder(desktop.toUpperCase() + '\\')).toBe(true)
    expect(isSharedFolder(desktop + '/')).toBe(true)
  })

  it('knows a drive root', () => {
    const root = parse(dir).root
    expect(isSharedFolder(root)).toBe(true)
    expect(isSharedFolder('D:\\')).toBe(process.platform === 'win32')
  })

  it('knows Program Files when the environment names it', () => {
    const pf = process.env['ProgramFiles']
    if (!pf) return
    expect(isSharedFolder(pf)).toBe(true)
    expect(isSharedFolder(join(pf, 'Some Game'))).toBe(false)
  })

  it('knows the program and app-data folders the environment names, but not the games inside them', () => {
    const env = {
      ProgramFiles: join(dir, 'PF'),
      'ProgramFiles(x86)': join(dir, 'PF86'),
      ProgramW6432: join(dir, 'PF64'),
      ProgramData: join(dir, 'PD'),
      APPDATA: join(dir, 'Roaming'),
      LOCALAPPDATA: join(dir, 'Local'),
      PUBLIC: join(dir, 'Public')
    }
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
    for (const v of Object.values(env)) {
      expect(isSharedFolder(v)).toBe(true)
      expect(isSharedFolder(join(v, 'Some Game'))).toBe(false)
    }
    expect(isSharedFolder(join(env.LOCALAPPDATA, 'Programs'))).toBe(true)
    expect(isSharedFolder(join(env.LOCALAPPDATA, 'Programs', 'itch-game'))).toBe(false)
    expect(isSharedFolder(join(env.PUBLIC, 'Desktop'))).toBe(true)
    expect(isSharedFolder(join(env.PUBLIC, 'Desktop', 'Game'))).toBe(false)
  })

  it('knows everything under SystemRoot (or windir), but not a sibling with the same prefix', () => {
    const windows = join(dir, 'Windows')
    vi.stubEnv('SystemRoot', windows)
    expect(isSharedFolder(windows)).toBe(true)
    expect(isSharedFolder(join(windows, 'System32'))).toBe(true)
    expect(isSharedFolder(join(windows, 'SysWOW64', 'deep', 'tool'))).toBe(true)
    expect(isSharedFolder(join(windows, 'System32').toUpperCase())).toBe(true)
    expect(isSharedFolder(join(dir, 'WindowsApps'))).toBe(false)
    expect(isSharedFolder(join(dir, 'Windows.old', 'x'))).toBe(false)

    vi.stubEnv('SystemRoot', undefined)
    vi.stubEnv('windir', join(dir, 'WinDir'))
    expect(isSharedFolder(join(dir, 'WinDir', 'System32'))).toBe(true)
    expect(isSharedFolder(join(windows, 'System32'))).toBe(false)
  })

  it('does not flag a normal game folder', () => {
    expect(isSharedFolder(join(dir, 'Games', 'Hollow Knight'))).toBe(false)
    expect(isSharedFolder(join(homedir(), 'Desktop', 'Celeste'))).toBe(false)
    expect(isSharedFolder(join(homedir(), 'Downloads', 'PlayOut'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// measure
// ---------------------------------------------------------------------------

describe('measure', () => {
  it("takes Steam's and Epic's own record without walking the folder", async () => {
    const [s, e] = add(
      steam(620, { sizeOnDisk: 12_345_678 }),
      epic('hades', { epicInstallSize: 9_999 })
    )
    const folder = vi.fn<FolderFn>(async () => 1)
    await createService({ folderSize: folder }).measure()
    expect(folder).not.toHaveBeenCalled()
    expect(game(s).installSize).toMatchObject({
      bytes: 12_345_678,
      how: 'store',
      path: join(dir, 'steam', '620')
    })
    expect(game(e).installSize).toMatchObject({
      bytes: 9_999,
      how: 'store',
      path: join(dir, 'epic', 'hades')
    })
    expect(recent(game(s).installSize?.measuredAt)).toBe(true)
    expect(game(s).installSize).not.toHaveProperty('unmeasurable')
  })

  it('walks the folder of a Steam or Epic game without a usable record (0 = unknown)', async () => {
    const [s, e] = add(steam(10, { sizeOnDisk: 0 }), epic('fn', { epicInstallSize: 0 }))
    const folder = vi.fn<FolderFn>(async (d) => (d.endsWith('10') ? 500 : 700))
    await createService({ folderSize: folder }).measure()
    expect(game(s).installSize).toMatchObject({ bytes: 500, how: 'folder' })
    expect(game(e).installSize).toMatchObject({ bytes: 700, how: 'folder' })
  })

  it('measures a ROM file and a ROM folder on disk; a missing ROM is unmeasurable', async () => {
    const file = join(dir, 'roms', 'smw.sfc')
    await writeTree(join(dir, 'roms'), { 'smw.sfc': 4096 })
    const folderRom = join(dir, 'roms', 'FF7 (USA)')
    await writeTree(folderRom, { 'disc1.bin': 300, 'disc2.bin': 200, 'game.cue': 5 })
    const gonePath = join(dir, 'roms', 'gone.sfc')
    const [a, b, gone] = add(rom(file, 'smw'), rom(folderRom, 'ff7'), rom(gonePath, 'gone'))
    await createService().measure()
    expect(game(a).installSize).toMatchObject({ bytes: 4096, how: 'file', path: file })
    expect(game(b).installSize).toMatchObject({ bytes: 505, how: 'folder', path: folderRom })
    expect(game(gone).installSize).toMatchObject({
      bytes: 0,
      how: 'folder',
      path: gonePath,
      unmeasurable: true
    })
  })

  it('adds up the discs an .m3u playlist names, and the tracks of each .cue it lists', async () => {
    const roms = join(dir, 'roms')
    const cue1 =
      'FILE "FF7 (Disc 1).bin" BINARY\r\n  TRACK 01 MODE2/2352\r\n    INDEX 01 00:00:00\r\n'
    const cue2 = [
      'REM a comment',
      'FILE "FF7 (Disc 2) (Track 1).bin" BINARY',
      '  TRACK 01 MODE2/2352',
      'FILE FF7_Disc2_Track2.bin BINARY',
      '  TRACK 02 AUDIO'
    ].join('\n')
    const m3u = [
      '#EXTM3U',
      'FF7 (Disc 1).cue',
      '',
      'FF7 (Disc 2).cue',
      'FF7 (Disc 1).cue',
      'FF7 (Disc 3).chd',
      'missing.cue'
    ].join('\n')
    await writeTree(roms, {
      'FF7.m3u': m3u,
      'FF7 (Disc 1).cue': cue1,
      'FF7 (Disc 2).cue': cue2,
      'FF7 (Disc 1).bin': 1000,
      'FF7 (Disc 2) (Track 1).bin': 2000,
      'FF7_Disc2_Track2.bin': 300,
      'FF7 (Disc 3).chd': 40,
      'unrelated.bin': 99_999
    })
    const bytes = (s: string): number => Buffer.byteLength(s)
    const [id] = add(rom(join(roms, 'FF7.m3u'), 'ff7'))
    await createService().measure()
    expect(game(id).installSize).toMatchObject({
      bytes: bytes(m3u) + bytes(cue1) + 1000 + bytes(cue2) + 2000 + 300 + 40,
      how: 'file',
      path: join(roms, 'FF7.m3u')
    })
  })

  it('adds up the data tracks a .cue sheet names', async () => {
    const roms = join(dir, 'roms')
    const cue =
      'FILE "Game (Track 1).bin" BINARY\nFILE "Game (Track 2).bin" BINARY\nFILE "gone.bin" BINARY\n'
    await writeTree(roms, {
      'Game.cue': cue,
      'Game (Track 1).bin': 700,
      'Game (Track 2).bin': 70
    })
    const [id] = add(rom(join(roms, 'Game.cue'), 'game'))
    await createService().measure()
    expect(game(id).installSize).toMatchObject({
      bytes: Buffer.byteLength(cue) + 770,
      how: 'file'
    })
  })

  it('adds up a GOG-like install folder for real', async () => {
    const root = join(dir, 'GOG Games', 'Witcher')
    await writeTree(root, { 'witcher.exe': 1234, 'data/x.dat': 66 })
    const [id] = add(gog('witcher', root))
    await createService().measure()
    expect(game(id).installSize).toMatchObject({ bytes: 1300, how: 'folder', path: root })
  })

  it('records a game whose install folder is a shared folder as unmeasurable without walking', async () => {
    const windows = join(dir, 'Windows')
    vi.stubEnv('SystemRoot', windows)
    const desktop = join(homedir(), 'Desktop')
    const root = parse(dir).root
    const system32 = join(windows, 'System32')
    const [desk, rootDrive, sys] = add(
      gog('desk', desktop),
      gog('root', root),
      gog('sys', system32)
    )
    const folder = vi.fn<FolderFn>(async () => 1)
    await createService({ folderSize: folder }).measure()
    expect(folder).not.toHaveBeenCalled()
    expect(game(desk).installSize).toMatchObject({ bytes: 0, path: desktop, unmeasurable: true })
    expect(game(rootDrive).installSize).toMatchObject({ bytes: 0, path: root, unmeasurable: true })
    expect(game(sys).installSize).toMatchObject({ bytes: 0, path: system32, unmeasurable: true })
  })

  it('records an unmeasurable entry when the walk gives up', async () => {
    const big = join(dir, 'big')
    const [id] = add(gog('big', big))
    await createService({ folderSize: async () => null }).measure()
    expect(game(id).installSize).toMatchObject({
      bytes: 0,
      how: 'folder',
      path: big,
      unmeasurable: true
    })
    expect(recent(game(id).installSize?.measuredAt)).toBe(true)
    expect(updates).toEqual([[id]])
  })

  it('tries an unmeasurable folder again only after 7 days, and quietly when it still fails', async () => {
    const big = join(dir, 'big')
    const [id] = add(gog('big', big))
    library.setInstallSizes([{ id, size: unmeasurable(big, 6 * DAY) }])
    updates = []
    const folder = vi.fn<FolderFn>(async () => null)
    const svc = createService({ folderSize: folder })
    await svc.measure()
    expect(folder).not.toHaveBeenCalled()

    library.setInstallSizes([{ id, size: unmeasurable(big, 8 * DAY) }])
    await svc.measure()
    expect(folder).toHaveBeenCalledTimes(1)
    expect(game(id).installSize?.unmeasurable).toBe(true)
    expect(recent(game(id).installSize?.measuredAt)).toBe(true)
    // Same result as before: measuredAt moved, nothing announced.
    expect(updates).toEqual([])
  })

  it('replaces an unmeasurable entry once the folder can be added up', async () => {
    const big = join(dir, 'big')
    const [id] = add(gog('big', big))
    library.setInstallSizes([{ id, size: unmeasurable(big, 8 * DAY) }])
    updates = []
    await createService({ folderSize: async () => 5 * GB }).measure()
    expect(game(id).installSize).toMatchObject({ bytes: 5 * GB, how: 'folder', path: big })
    expect(game(id).installSize).not.toHaveProperty('unmeasurable')
    expect(updates).toEqual([[id]])
  })

  it('keeps going after one game throws', async () => {
    const [bad, good] = add(gog('bad', join(dir, 'bad')), gog('good', join(dir, 'good')))
    const folder = vi.fn<FolderFn>(async (d) => {
      if (d.endsWith('bad')) throw new Error('EPERM')
      return 42
    })
    await createService({ folderSize: folder }).measure()
    expect(game(bad).installSize).toBeUndefined()
    expect(game(good).installSize?.bytes).toBe(42)
  })

  it('reuses a folder measurement of the same path for 7 days', async () => {
    const [id] = add(gog('w', join(dir, 'w')))
    library.setInstallSizes([{ id, size: size(111, join(dir, 'w'), 'folder', 6 * DAY) }])
    const folder = vi.fn<FolderFn>(async () => 222)
    await createService({ folderSize: folder }).measure()
    expect(folder).not.toHaveBeenCalled()
    expect(game(id).installSize?.bytes).toBe(111)
  })

  it('keeps a found folder size of the same path for good, however old', async () => {
    const [id] = add(gog('w', join(dir, 'w')))
    library.setInstallSizes([{ id, size: size(111, join(dir, 'w'), 'folder', 400 * DAY) }])
    updates = []
    const folder = vi.fn<FolderFn>(async () => 222)
    await createService({ folderSize: folder }).measure()
    expect(folder).not.toHaveBeenCalled()
    expect(game(id).installSize?.bytes).toBe(111)
    expect(updates).toEqual([])
  })

  it('does not walk a found folder size again on later passes', async () => {
    const [id] = add(gog('w', join(dir, 'w')))
    const folder = vi.fn<FolderFn>(async () => 222)
    const svc = createService({ folderSize: folder })
    await svc.measure()
    await svc.measure()
    await svc.measure([id])
    await svc.refresh(id)
    expect(folder).toHaveBeenCalledTimes(1)
    expect(game(id).installSize?.bytes).toBe(222)
  })

  it('measures a game installed after the first pass, and only that one', async () => {
    const [first] = add(gog('a', join(dir, 'a')))
    const folder = vi.fn<FolderFn>(async (d) => (d.endsWith('a') ? 1 : 2))
    const svc = createService({ folderSize: folder })
    await svc.measure()
    const [added] = add(gog('b', join(dir, 'b')))
    await svc.measure()
    expect(folder.mock.calls.map(([d]) => d)).toEqual([join(dir, 'a'), join(dir, 'b')])
    expect(game(first).installSize?.bytes).toBe(1)
    expect(game(added).installSize?.bytes).toBe(2)
  })

  it('measures a found size again once the install moved', async () => {
    const [id] = add(gog('w', join(dir, 'old')))
    const folder = vi.fn<FolderFn>(async (d) => (d.endsWith('old') ? 1 : 2))
    const svc = createService({ folderSize: folder })
    await svc.measure()
    library.mergeScan('gog', [gog('w', join(dir, 'new'))])
    await svc.measure()
    expect(folder.mock.calls.map(([d]) => d)).toEqual([join(dir, 'old'), join(dir, 'new')])
    expect(game(id).installSize).toMatchObject({ bytes: 2, path: join(dir, 'new') })
  })

  it('measures again when the install moved to another folder', async () => {
    const [id] = add(gog('w', join(dir, 'new')))
    library.setInstallSizes([{ id, size: size(111, join(dir, 'old'), 'folder') }])
    const folder = vi.fn<FolderFn>(async () => 333)
    await createService({ folderSize: folder }).measure()
    expect(folder).toHaveBeenCalledWith(join(dir, 'new'))
    expect(game(id).installSize).toMatchObject({ bytes: 333, path: join(dir, 'new') })
  })

  it('takes the client record once it has one, over an earlier folder walk', async () => {
    const [id] = add(steam(10, { sizeOnDisk: 0 }))
    library.setInstallSizes([{ id, size: size(111, join(dir, 'steam', '10'), 'folder') }])
    library.mergeScan('steam', [steam(10, { sizeOnDisk: 999 })])
    const folder = vi.fn<FolderFn>(async () => 1)
    await createService({ folderSize: folder }).measure()
    expect(folder).not.toHaveBeenCalled()
    expect(game(id).installSize).toMatchObject({ bytes: 999, how: 'store' })
  })

  it('walks a game whose client record went away', async () => {
    const [id] = add(steam(10, { sizeOnDisk: 999 }))
    const folder = vi.fn<FolderFn>(async () => 444)
    const svc = createService({ folderSize: folder })
    await svc.measure()
    expect(game(id).installSize).toMatchObject({ bytes: 999, how: 'store' })
    library.mergeScan('steam', [steam(10, { sizeOnDisk: 0 })])
    await svc.measure()
    expect(folder).toHaveBeenCalledTimes(1)
    expect(game(id).installSize).toMatchObject({ bytes: 444, how: 'folder' })
  })

  it('reuses ROM measurements of the same path, file or folder, however old, and re-stats a moved one', async () => {
    const f = join(dir, 'roms', 'a.sfc')
    const d = join(dir, 'roms', 'b')
    const moved = join(dir, 'roms', 'c.sfc')
    const [a, b, c] = add(rom(f, 'a'), rom(d, 'b'), rom(moved, 'c'))
    library.setInstallSizes([
      { id: a, size: size(10, f, 'file', 30 * DAY) },
      { id: b, size: size(20, d, 'folder', 30 * DAY) },
      { id: c, size: size(30, join(dir, 'old', 'c.sfc'), 'file') }
    ])
    const pathSize = vi.fn<PathFn>(async () => ({ bytes: 31, folder: false }))
    await createService({ pathSize }).measure()
    expect(pathSize).toHaveBeenCalledTimes(1)
    expect(pathSize).toHaveBeenCalledWith(moved)
    expect(game(a).installSize?.bytes).toBe(10)
    expect(game(b).installSize?.bytes).toBe(20)
    expect(game(c).installSize?.bytes).toBe(31)
  })

  it('measures a dumped PS4 game as its whole folder, correcting a size stored for its eboot.bin', async () => {
    const folder = join(dir, 'roms', 'ps4', 'GRAVITY RUSH 2')
    await writeTree(folder, {
      'eboot.bin': 100,
      'sce_sys/param.sfo': 20,
      'sce_module/libc.prx': 300,
      'data/a.pak': 4000
    })
    const eboot = join(folder, 'eboot.bin')
    const [id] = add({
      ...rom(eboot, 'x'),
      externalId: 'ps4/GRAVITY RUSH 2/eboot.bin',
      platformId: 'ps4',
      launch: { kind: 'emulator', systemId: 'ps4', romPath: eboot },
      extra: { fileSize: 100, gameFolder: folder }
    })
    // What earlier versions stored: the eboot.bin's own size.
    library.setInstallSizes([{ id, size: size(100, eboot, 'file', 30 * DAY) }])
    const svc = createService()
    await svc.measure()
    expect(game(id).installSize).toMatchObject({ bytes: 4420, how: 'folder', path: folder })
    // Measured once: the next pass keeps it.
    const pathSize = vi.fn<PathFn>(async () => ({ bytes: 1, folder: true }))
    await createService({ pathSize }).measure()
    expect(pathSize).not.toHaveBeenCalled()
  })

  it('skips games that are not installed', async () => {
    const [id] = add(gog('w', join(dir, 'w')))
    uninstallAll('gog')
    const folder = vi.fn<FolderFn>(async () => 1)
    await createService({ folderSize: folder }).measure()
    expect(folder).not.toHaveBeenCalled()
    expect(game(id).installSize).toBeUndefined()
  })

  it('does not write a game uninstalled while its folder was walked', async () => {
    const [id] = add(gog('w', join(dir, 'w')))
    const folder = vi.fn<FolderFn>(async () => {
      uninstallAll('gog')
      return 99
    })
    await createService({ folderSize: folder }).measure()
    expect(game(id).installSize).toBeUndefined()
    expect(updates).toEqual([])
  })

  it('measures only the asked games when ids are given', async () => {
    const [a, b] = add(steam(1, { sizeOnDisk: 5 }), steam(2, { sizeOnDisk: 6 }))
    await createService().measure([b])
    expect(game(a).installSize).toBeUndefined()
    expect(game(b).installSize?.bytes).toBe(6)
  })

  it('writes client records in batches of 25 with one library:changed each', async () => {
    const ids = add(
      ...Array.from({ length: 30 }, (_, i) => steam(100 + i, { sizeOnDisk: 1000 + i }))
    )
    await createService().measure()
    expect(updates.map((u) => u.length)).toEqual([25, 5])
    expect(updates.flat().sort()).toEqual([...ids].sort())
    for (const [i, id] of ids.entries()) expect(game(id).installSize?.bytes).toBe(1000 + i)
  })

  it('measures the client records before the walks, and writes each walk as soon as it is done', async () => {
    const [w1, rec, w2] = add(
      gog('w1', join(dir, 'w1')),
      steam(5, { sizeOnDisk: 55 }),
      gog('w2', join(dir, 'w2'))
    )
    const gate = deferred<number>()
    const folder = vi.fn<FolderFn>(async (d) => (d.endsWith('w2') ? gate.promise : 11))
    const run = createService({ folderSize: folder }).measure()
    await vi.waitFor(() => expect(folder).toHaveBeenCalledTimes(2))
    // The second walk is still running: the first one's size is already in the library.
    expect(game(w1).installSize?.bytes).toBe(11)
    expect(game(rec).installSize?.bytes).toBe(55)
    expect(game(w2).installSize).toBeUndefined()
    gate.resolve(22)
    await run
    expect(folder.mock.calls.map(([d]) => d)).toEqual([join(dir, 'w1'), join(dir, 'w2')])
    expect(updates.flat()).toEqual([rec, w1, w2])
    expect(updates.at(-1)).toEqual([w2])
    expect(game(w2).installSize?.bytes).toBe(22)
  })

  it('writes the client records before the first walk starts', async () => {
    const [w1, rec] = add(gog('w1', join(dir, 'w1')), steam(5, { sizeOnDisk: 55 }))
    const gate = deferred<number>()
    const folder = vi.fn<FolderFn>(() => gate.promise)
    const run = createService({ folderSize: folder }).measure()
    await vi.waitFor(() => expect(folder).toHaveBeenCalledTimes(1))
    expect(game(rec).installSize?.bytes).toBe(55)
    gate.resolve(11)
    await run
    expect(updates).toEqual([[rec], [w1]])
  })

  it('does not rewrite or announce unchanged sizes', async () => {
    add(steam(1, { sizeOnDisk: 5 }), steam(2, { sizeOnDisk: 6 }))
    const svc = createService()
    await svc.measure()
    expect(updates).toHaveLength(1)
    const before = library.games().map((g) => g.installSize?.measuredAt)
    await svc.measure()
    expect(updates).toHaveLength(1)
    expect(library.games().map((g) => g.installSize?.measuredAt)).toEqual(before)
  })

  it('leaves measuredAt of a found folder size as it was', async () => {
    const [id] = add(gog('w', join(dir, 'w')))
    const before = size(111, join(dir, 'w'), 'folder', 8 * DAY)
    library.setInstallSizes([{ id, size: before }])
    updates = []
    await createService({ folderSize: async () => 111 }).measure()
    expect(updates).toEqual([])
    expect(game(id).installSize?.measuredAt).toBe(before.measuredAt)
  })

  it('announces only the games whose size changed', async () => {
    const [a] = add(steam(1, { sizeOnDisk: 5 }), steam(2, { sizeOnDisk: 6 }))
    const svc = createService()
    await svc.measure()
    library.mergeScan('steam', [steam(1, { sizeOnDisk: 50 }), steam(2, { sizeOnDisk: 6 })])
    await svc.measure()
    expect(updates[1]).toEqual([a])
    expect(game(a).installSize?.bytes).toBe(50)
  })

  it('queues ids asked for while a pass runs into one more pass', async () => {
    const [a, b, c] = add(
      gog('a', join(dir, 'a')),
      gog('b', join(dir, 'b')),
      gog('c', join(dir, 'c'))
    )
    const gate = deferred<number>()
    const folder = vi.fn<FolderFn>(async (d) => (d.endsWith('a') ? gate.promise : 7))
    const svc = createService({ folderSize: folder })
    const first = svc.measure([a])
    await vi.waitFor(() => expect(folder).toHaveBeenCalledTimes(1))
    const second = svc.measure([b])
    const third = svc.measure([c])
    // While running, every caller waits on the same run.
    expect(second).toBe(first)
    expect(third).toBe(first)
    expect(folder).toHaveBeenCalledTimes(1)
    gate.resolve(3)
    await first
    expect(folder.mock.calls.map(([d]) => d)).toEqual([
      join(dir, 'a'),
      join(dir, 'b'),
      join(dir, 'c')
    ])
    expect(game(a).installSize?.bytes).toBe(3)
    expect(game(b).installSize?.bytes).toBe(7)
    expect(game(c).installSize?.bytes).toBe(7)
    // The run is over: a new call starts a new one.
    const next = svc.measure([a])
    expect(next).not.toBe(first)
    await next
  })

  it("a whole-library request while running widens the queued pass to 'all'", async () => {
    const [a, b] = add(gog('a', join(dir, 'a')), gog('b', join(dir, 'b')))
    const gate = deferred<number>()
    const folder = vi.fn<FolderFn>(async (d) => (d.endsWith('a') ? gate.promise : 8))
    const svc = createService({ folderSize: folder })
    const run = svc.measure([a])
    await vi.waitFor(() => expect(folder).toHaveBeenCalledTimes(1))
    void svc.measure([b])
    void svc.measure()
    gate.resolve(4)
    await run
    expect(game(a).installSize?.bytes).toBe(4)
    expect(game(b).installSize?.bytes).toBe(8)
  })

  it('does nothing after dispose', async () => {
    const [id] = add(steam(1, { sizeOnDisk: 5 }))
    const svc = createService()
    svc.dispose()
    await svc.measure()
    expect(game(id).installSize).toBeUndefined()
  })

  it('flushes the record batch before the first walk even with a single record', async () => {
    const [w1, w2, r1, r2] = add(
      gog('w1', join(dir, 'w1')),
      gog('w2', join(dir, 'w2')),
      steam(5, { sizeOnDisk: 55 }),
      epic('e', { epicInstallSize: 66 })
    )
    await createService({ folderSize: async () => 1 }).measure()
    expect(updates).toEqual([[r1, r2], [w1], [w2]])
  })

  it('records a manual game whose folder holds several games as unmeasurable without walking', async () => {
    const games = join(dir, 'Games')
    await writeTree(games, {
      'game.exe': 1,
      'Celeste/Celeste.exe': 10,
      'Hollow Knight/hollow_knight.exe': 20
    })
    const [id] = add(manual(games, 'Games'))
    const folder = vi.fn<FolderFn>(async () => 1)
    await createService({ folderSize: folder }).measure()
    expect(folder).not.toHaveBeenCalled()
    expect(game(id).installSize).toMatchObject({ bytes: 0, path: games, unmeasurable: true })
  })

  it('walks a manual game folder with only one game subfolder, or exes deeper down', async () => {
    const one = join(dir, 'One')
    await writeTree(one, { 'game.exe': 1, 'Tools/tool.exe': 2, 'Data/readme.txt': 3 })
    const deep = join(dir, 'Deep')
    await writeTree(deep, {
      'game.exe': 1,
      'A/bin/a.exe': 2,
      'B/bin/b.exe': 3,
      'C/c.EXE.txt': 4
    })
    const [a, b] = add(manual(one, 'One'), manual(deep, 'Deep'))
    const folder = vi.fn<FolderFn>(async () => 77)
    await createService({ folderSize: folder }).measure()
    expect(folder).toHaveBeenCalledTimes(2)
    expect(game(a).installSize).toMatchObject({ bytes: 77, how: 'folder' })
    expect(game(b).installSize).toMatchObject({ bytes: 77, how: 'folder' })
  })

  it('counts a subfolder exe whatever the case of its extension', async () => {
    const games = join(dir, 'Games')
    await writeTree(games, { 'A/A.EXE': 1, 'B/b.Exe': 2 })
    const [id] = add(manual(games, 'Games'))
    await createService({ folderSize: async () => 1 }).measure()
    expect(game(id).installSize?.unmeasurable).toBe(true)
  })

  it('records a manual game in a Steam library folder as unmeasurable', async () => {
    const apps = join(dir, 'SteamLibrary', 'steamapps')
    const common = join(apps, 'common')
    await fs.mkdir(common, { recursive: true })
    const [a, c] = add(manual(apps, 'Apps'), manual(common, 'Common'))
    const folder = vi.fn<FolderFn>(async () => 1)
    await createService({ folderSize: folder }).measure()
    expect(folder).not.toHaveBeenCalled()
    expect(game(a).installSize?.unmeasurable).toBe(true)
    expect(game(c).installSize?.unmeasurable).toBe(true)
  })

  it('still walks a store game whose folder holds several game folders', async () => {
    const root = join(dir, 'GOG Games', 'Collection')
    await writeTree(root, { 'A/a.exe': 1, 'B/b.exe': 2 })
    const [id] = add(gog('coll', root))
    const folder = vi.fn<FolderFn>(async () => 3)
    await createService({ folderSize: folder }).measure()
    expect(folder).toHaveBeenCalledWith(root)
    expect(game(id).installSize).toMatchObject({ bytes: 3, how: 'folder' })
  })

  it('never asks a store while measuring installed games', async () => {
    add(steam(1, { sizeOnDisk: 5 }), gog('g', join(dir, 'g')), epic('e'))
    await createService({ folderSize: async () => 3 }).measure()
    for (const fn of Object.values(lookups)) expect(fn).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// refresh
// ---------------------------------------------------------------------------

const details = (minimum?: string, recommended?: string): SteamAppDetails =>
  ({ pc_requirements: { minimum, recommended } }) as SteamAppDetails

const throws = (message: string) => async (): Promise<never> => {
  throw new Error(message)
}

describe('refresh: installed games', () => {
  it('returns null for an unknown game', async () => {
    expect(await createService().refresh('nope')).toBeNull()
  })

  it('measures an installed game that has no size yet', async () => {
    const root = join(dir, 'w')
    await writeTree(root, { 'a.bin': 321 })
    const [id] = add(gog('w', root))
    const got = await createService().refresh(id)
    expect(got?.installSize).toMatchObject({ bytes: 321, how: 'folder', path: root })
    expect(game(id).installSize?.bytes).toBe(321)
    expect(updates).toEqual([[id]])
    for (const fn of Object.values(lookups)) expect(fn).not.toHaveBeenCalled()
  })

  it('leaves an installed game with a current size alone', async () => {
    const [id, s] = add(gog('w', join(dir, 'w')), steam(7, { sizeOnDisk: 70 }))
    library.setInstallSizes([
      // A found folder size does not age either.
      { id, size: size(5, join(dir, 'w'), 'folder', 60 * DAY) },
      { id: s, size: size(70, join(dir, 'steam', '7'), 'store', 90 * DAY) }
    ])
    const folder = vi.fn<FolderFn>(async () => 9)
    const svc = createService({ folderSize: folder })
    expect((await svc.refresh(id))?.installSize?.bytes).toBe(5)
    // A client record does not age.
    expect((await svc.refresh(s))?.installSize?.bytes).toBe(70)
    expect(folder).not.toHaveBeenCalled()
  })

  it('measures again an unmeasurable entry older than 7 days, one for another path, or an outdated record', async () => {
    const [id, moved, s] = add(
      gog('w', join(dir, 'w')),
      gog('m', join(dir, 'm-new')),
      steam(7, { sizeOnDisk: 71 })
    )
    library.setInstallSizes([
      { id, size: unmeasurable(join(dir, 'w'), 8 * DAY) },
      { id: moved, size: size(5, join(dir, 'm-old'), 'folder') },
      { id: s, size: size(70, join(dir, 'steam', '7'), 'store') }
    ])
    updates = []
    const folder = vi.fn<FolderFn>(async () => 9)
    const svc = createService({ folderSize: folder })
    expect((await svc.refresh(id))?.installSize?.bytes).toBe(9)
    expect((await svc.refresh(moved))?.installSize).toMatchObject({
      bytes: 9,
      path: join(dir, 'm-new')
    })
    expect((await svc.refresh(s))?.installSize).toMatchObject({ bytes: 71, how: 'store' })
    expect(folder).toHaveBeenCalledTimes(2)
    expect(updates).toEqual([[id], [moved], [s]])
  })

  it('returns the game unchanged when the installed measurement fails', async () => {
    const [id] = add(gog('w', join(dir, 'w')))
    const got = await createService({ folderSize: throws('EPERM') }).refresh(id)
    expect(got?.id).toBe(id)
    expect(got?.installSize).toBeUndefined()
    expect(got?.metadata.storage).toBeUndefined()
  })

  it("falls back to the store's size when the installed folder cannot be measured", async () => {
    const desktop = join(homedir(), 'Desktop')
    const [id] = add(gog('1207658924', desktop, { gogProductId: '1207658924' }))
    const gogInstallSize = vi.fn<GogFn>(async () => 3 * GB)
    const folder = vi.fn<FolderFn>(async () => 1)
    const got = await createService({ folderSize: folder, gogInstallSize }).refresh(id)
    expect(folder).not.toHaveBeenCalled()
    expect(gogInstallSize).toHaveBeenCalledWith('1207658924')
    expect(got?.installSize).toMatchObject({ bytes: 0, path: desktop, unmeasurable: true })
    expect(got?.metadata.storage).toMatchObject({ bytes: 3 * GB, how: 'gog' })
    expect(game(id).metadata.storage?.bytes).toBe(3 * GB)
    expect(updates).toEqual([[id]])
    expect(metadataChanges).toEqual([[id]])
  })

  it('falls back to the store size for an unmeasurable entry that is still current', async () => {
    const [id] = add(steam(9, { sizeOnDisk: 0 }))
    library.setInstallSizes([{ id, size: unmeasurable(join(dir, 'steam', '9'), DAY) }])
    const folder = vi.fn<FolderFn>(async () => 1)
    const steamInstallSize = vi.fn<ExactFn>(async () => 12 * GB)
    const got = await createService({ folderSize: folder, steamInstallSize }).refresh(id)
    expect(folder).not.toHaveBeenCalled()
    expect(steamInstallSize).toHaveBeenCalledWith(9)
    expect(got?.metadata.storage).toMatchObject({ bytes: 12 * GB, how: 'steam' })
  })

  it('does not ask the store for an installed, measured game', async () => {
    const [id] = add(steam(9, { sizeOnDisk: 99 }))
    await createService().refresh(id)
    for (const fn of Object.values(lookups)) expect(fn).not.toHaveBeenCalled()
    expect(game(id).metadata.storage).toBeUndefined()
  })
})

describe('refresh: store sizes of games that are not installed', () => {
  it("records what Steam installs for the game's own Steam app, exactly", async () => {
    const [id] = add(steam(620))
    uninstallAll('steam')
    const steamInstallSize = vi.fn<ExactFn>(async () => 11 * GB)
    const got = await createService({ steamInstallSize }).refresh(id)
    expect(steamInstallSize).toHaveBeenCalledWith(620)
    expect(lookups.steamDetails).not.toHaveBeenCalled()
    expect(lookups.steamAppIdByTitle).not.toHaveBeenCalled()
    expect(got?.metadata.storage).toMatchObject({ bytes: 11 * GB, how: 'steam' })
    expect(got?.metadata.storage).not.toHaveProperty('steamAppId')
    expect(recent(game(id).metadata.storage?.checkedAt)).toBe(true)
    expect(game(id).installSize).toBeUndefined()
    expect(metadataChanges).toEqual([[id]])
  })

  it("records Steam's storage requirement when Steam lists no depots", async () => {
    const [id] = add(steam(620))
    uninstallAll('steam')
    const steamDetails = vi.fn<DetailsFn>(async () =>
      details('<ul><li><strong>Storage:</strong> 8 GB available space</li></ul>')
    )
    const got = await createService({ steamDetails }).refresh(id)
    expect(lookups.steamInstallSize).toHaveBeenCalledWith(620)
    expect(steamDetails).toHaveBeenCalledWith(620)
    expect(got?.metadata.storage).toMatchObject({ bytes: 8 * GB, how: 'requirement' })
    expect(got?.metadata.storage).not.toHaveProperty('steamAppId')
    expect(game(id).metadata.storage?.bytes).toBe(8 * GB)
    expect(game(id).installSize).toBeUndefined()
    expect(metadataChanges).toEqual([[id]])
  })

  it('falls back to the requirement when the exact lookup throws', async () => {
    const [id] = add(steam(620))
    uninstallAll('steam')
    const got = await createService({
      steamInstallSize: throws('503'),
      steamDetails: async () => details('<strong>Storage:</strong> 1,200 MB')
    }).refresh(id)
    expect(got?.metadata.storage).toMatchObject({ bytes: 1200 * MB, how: 'requirement' })
  })

  it('prefers the recommended requirement over the minimum', async () => {
    const [id] = add(steam(620))
    uninstallAll('steam')
    const got = await createService({
      steamDetails: async () =>
        details('<strong>Storage:</strong> 4 GB', '<strong>Storage:</strong> 12 GB')
    }).refresh(id)
    expect(got?.metadata.storage?.bytes).toBe(12 * GB)
  })

  it('records the check without bytes when Steam names no size', async () => {
    const [a, b] = add(steam(1), steam(2))
    uninstallAll('steam')
    const svc = createService({
      steamDetails: async (appId) =>
        appId === 1 ? details('<strong>OS:</strong> Windows 10') : null
    })
    for (const id of [a, b]) {
      const got = await svc.refresh(id)
      expect(got?.metadata.storage).toBeDefined()
      expect(got?.metadata.storage).not.toHaveProperty('bytes')
      expect(got?.metadata.storage).not.toHaveProperty('how')
      expect(typeof got?.metadata.storage?.checkedAt).toBe('string')
    }
    expect(metadataChanges).toEqual([[a], [b]])
  })

  it('never asks again for a size it found, however old', async () => {
    const [id] = add(steam(620))
    uninstallAll('steam')
    const steamDetails = vi.fn<DetailsFn>(async () => details('Storage: 2 GB'))
    const svc = createService({ steamDetails })
    for (const age of [29 * DAY, 31 * DAY, 400 * DAY]) {
      library.applyMetadata(
        id,
        {
          metadata: {
            storage: { bytes: GB, checkedAt: new Date(Date.now() - age).toISOString() }
          }
        },
        { overwrite: true }
      )
      expect((await svc.refresh(id))?.metadata.storage?.bytes).toBe(GB)
      await svc.fillStoreSizes()
    }
    expect(steamDetails).not.toHaveBeenCalled()
    expect(lookups.steamInstallSize).not.toHaveBeenCalled()
  })

  it('asks a check that found no size again after 30 days, not before', async () => {
    const [id] = add(steam(620))
    uninstallAll('steam')
    const steamDetails = vi.fn<DetailsFn>(async () => details('Storage: 2 GB'))
    const svc = createService({ steamDetails })
    const checkedAt = (ageMs: number): void => {
      library.applyMetadata(
        id,
        { metadata: { storage: { checkedAt: new Date(Date.now() - ageMs).toISOString() } } },
        { overwrite: true }
      )
    }
    checkedAt(29 * DAY)
    expect((await svc.refresh(id))?.metadata.storage).not.toHaveProperty('bytes')
    await svc.fillStoreSizes()
    expect(steamDetails).not.toHaveBeenCalled()
    expect(lookups.steamInstallSize).not.toHaveBeenCalled()

    checkedAt(31 * DAY)
    expect((await svc.refresh(id))?.metadata.storage?.bytes).toBe(2 * GB)
    expect(steamDetails).toHaveBeenCalledTimes(1)
  })

  it('records nothing when every Steam lookup throws, so the next open asks again', async () => {
    const [id] = add(steam(620))
    uninstallAll('steam')
    const steamDetails = vi.fn<DetailsFn>(throws('429'))
    const steamInstallSize = vi.fn<ExactFn>(throws('429'))
    const svc = createService({ steamDetails, steamInstallSize })
    const got = await svc.refresh(id)
    expect(got?.id).toBe(id)
    expect(game(id).metadata.storage).toBeUndefined()
    expect(metadataChanges).toEqual([])
    await svc.refresh(id)
    expect(steamDetails).toHaveBeenCalledTimes(2)
    expect(steamInstallSize).toHaveBeenCalledTimes(2)
  })

  it('records a partial empty check when one source answered with nothing and another threw', async () => {
    const [id] = add(steam(620))
    uninstallAll('steam')
    const got = await createService({
      steamInstallSize: async () => undefined,
      steamDetails: throws('429')
    }).refresh(id)
    expect(got?.metadata.storage).toEqual({ partial: true, checkedAt: expect.any(String) })
    expect(metadataChanges).toEqual([[id]])
  })

  it('marks a requirement found while the exact lookup threw as partial', async () => {
    const [id] = add(steam(620))
    uninstallAll('steam')
    const got = await createService({
      steamInstallSize: throws('503'),
      steamDetails: async () => details('<strong>Storage:</strong> 8 GB')
    }).refresh(id)
    expect(got?.metadata.storage).toEqual({
      bytes: 8 * GB,
      how: 'requirement',
      partial: true,
      checkedAt: expect.any(String)
    })
  })

  it('does not mark a result partial when no source threw', async () => {
    const [id] = add(steam(620))
    uninstallAll('steam')
    const got = await createService({
      steamDetails: async () => details('<strong>Storage:</strong> 8 GB')
    }).refresh(id)
    expect(got?.metadata.storage).toEqual({
      bytes: 8 * GB,
      how: 'requirement',
      checkedAt: expect.any(String)
    })
  })

  it('keeps a partial result that found a size, however old', async () => {
    const [id] = add(steam(620))
    uninstallAll('steam')
    library.applyMetadata(
      id,
      {
        metadata: {
          storage: {
            bytes: GB,
            how: 'requirement',
            partial: true,
            checkedAt: new Date(Date.now() - 40 * DAY).toISOString()
          }
        }
      },
      { overwrite: true }
    )
    const svc = createService()
    expect((await svc.refresh(id))?.metadata.storage).toMatchObject({ bytes: GB, partial: true })
    for (const fn of Object.values(lookups)) expect(fn).not.toHaveBeenCalled()
  })

  it('looks a Steam size from older depot rules up once more (Black Desert counted nine copies), then keeps it', async () => {
    const [id] = add(steam(582660))
    uninstallAll('steam')
    library.applyMetadata(
      id,
      {
        metadata: {
          storage: { bytes: 709.73 * GB, how: 'steam', checkedAt: new Date().toISOString() }
        }
      },
      { overwrite: true }
    )
    const steamInstallSize = vi.fn<ExactFn>(async () => 88.14 * GB)
    const svc = createService({ steamInstallSize })
    const got = await svc.refresh(id)
    expect(steamInstallSize).toHaveBeenCalledTimes(1)
    expect(got?.metadata.storage).toMatchObject({
      bytes: 88.14 * GB,
      how: 'steam',
      steamRules: STEAM_SIZE_RULES
    })
    await svc.refresh(id)
    expect(steamInstallSize).toHaveBeenCalledTimes(1)
  })

  it('keeps an older-rules Steam size when the new lookup fails, never the store estimate in its place', async () => {
    const [id] = add(steam(620))
    uninstallAll('steam')
    const old = { bytes: 11 * GB, how: 'steam' as const, checkedAt: new Date().toISOString() }
    library.applyMetadata(id, { metadata: { storage: old } }, { overwrite: true })
    const steamInstallSize = vi.fn<ExactFn>(async () => {
      throw new Error('HTTP 429')
    })
    const steamDetails = vi.fn<DetailsFn>(async () =>
      details('<ul><li><strong>Storage:</strong> 40 GB available space</li></ul>')
    )
    const svc = createService({ steamInstallSize, steamDetails })
    expect((await svc.refresh(id))?.metadata.storage).toEqual(old)
    expect(steamDetails).not.toHaveBeenCalled()
    // Still due: the next lookup that works updates it.
    steamInstallSize.mockImplementation(async () => 11 * GB)
    expect((await svc.refresh(id))?.metadata.storage).toMatchObject({
      bytes: 11 * GB,
      how: 'steam',
      steamRules: STEAM_SIZE_RULES
    })
  })

  it('re-checks an older-rules Steam match by the matched app, keeping it when Steam lists no size now', async () => {
    const [id] = add(epic('hades', undefined, 'Hades'))
    uninstallAll('epic')
    library.applyMetadata(
      id,
      {
        metadata: {
          storage: {
            bytes: 15 * GB,
            how: 'steam-match',
            steamAppId: 1145360,
            matchKey: 'hades',
            checkedAt: new Date().toISOString()
          }
        }
      },
      { overwrite: true }
    )
    const steamInstallSize = vi.fn<ExactFn>(async () => undefined)
    const svc = createService({ steamInstallSize })
    expect((await svc.refresh(id))?.metadata.storage).toMatchObject({
      bytes: 15 * GB,
      how: 'steam-match',
      steamAppId: 1145360,
      steamRules: STEAM_SIZE_RULES
    })
    expect(steamInstallSize).toHaveBeenCalledWith(1145360)
    await svc.refresh(id)
    expect(steamInstallSize).toHaveBeenCalledTimes(1)
  })

  it('asks a partial check without a size again after a day, not before, and drops the flag once complete', async () => {
    const [id] = add(steam(620))
    uninstallAll('steam')
    const steamInstallSize = vi.fn<ExactFn>(async () => 11 * GB)
    const svc = createService({ steamInstallSize })
    const partialAt = (ageMs: number): void => {
      library.applyMetadata(
        id,
        {
          metadata: {
            storage: { partial: true, checkedAt: new Date(Date.now() - ageMs).toISOString() }
          }
        },
        { overwrite: true }
      )
    }
    partialAt(23 * 60 * 60 * 1000)
    expect((await svc.refresh(id))?.metadata.storage).not.toHaveProperty('bytes')
    expect(steamInstallSize).not.toHaveBeenCalled()

    partialAt(25 * 60 * 60 * 1000)
    const got = await svc.refresh(id)
    expect(steamInstallSize).toHaveBeenCalledTimes(1)
    expect(got?.metadata.storage).toEqual({
      bytes: 11 * GB,
      how: 'steam',
      steamRules: STEAM_SIZE_RULES,
      checkedAt: expect.any(String)
    })
    expect(recent(got?.metadata.storage?.checkedAt)).toBe(true)
  })

  it('keeps a complete result even when it is older than a day', async () => {
    const [id] = add(steam(620))
    uninstallAll('steam')
    const svc = createService()
    library.applyMetadata(
      id,
      {
        metadata: {
          storage: {
            bytes: GB,
            how: 'steam',
            steamRules: STEAM_SIZE_RULES,
            checkedAt: new Date(Date.now() - 2 * DAY).toISOString()
          }
        }
      },
      { overwrite: true }
    )
    await svc.refresh(id)
    for (const fn of Object.values(lookups)) expect(fn).not.toHaveBeenCalled()
  })

  it('uses the Steam app id an Epic game carries, without searching by title', async () => {
    const [id] = add(epic('hades', { steamAppId: 1145360 }))
    uninstallAll('epic')
    const steamInstallSize = vi.fn<ExactFn>(async () => 15 * GB)
    const got = await createService({ steamInstallSize }).refresh(id)
    expect(steamInstallSize).toHaveBeenCalledWith(1145360)
    expect(lookups.steamAppIdByTitle).not.toHaveBeenCalled()
    expect(got?.metadata.storage).toMatchObject({ bytes: 15 * GB, how: 'steam' })
  })

  it("uses the requirement of an Epic game's own Steam app", async () => {
    const [id] = add(epic('hades', { steamAppId: 1145360 }))
    uninstallAll('epic')
    const steamDetails = vi.fn<DetailsFn>(async () => details('Storage: 15 GB'))
    const got = await createService({ steamDetails }).refresh(id)
    expect(steamDetails).toHaveBeenCalledWith(1145360)
    expect(got?.metadata.storage).toMatchObject({ bytes: 15 * GB, how: 'requirement' })
    expect(got?.metadata.storage).not.toHaveProperty('steamAppId')
  })

  it("records a GOG game's installer size, by its product id", async () => {
    const [id] = add(gog('witcher', join(dir, 'w'), { gogProductId: '1207658924' }))
    uninstallAll('gog')
    const gogInstallSize = vi.fn<GogFn>(async () => 2 * GB)
    const got = await createService({ gogInstallSize }).refresh(id)
    expect(gogInstallSize).toHaveBeenCalledWith('1207658924')
    expect(lookups.steamAppIdByTitle).not.toHaveBeenCalled()
    expect(got?.metadata.storage).toMatchObject({ bytes: 2 * GB, how: 'gog' })
  })

  it('uses the GOG external id when the game carries no product id', async () => {
    const [id] = add(gog('1495134320', join(dir, 'w')))
    uninstallAll('gog')
    const gogInstallSize = vi.fn<GogFn>(async () => GB)
    await createService({ gogInstallSize }).refresh(id)
    expect(gogInstallSize).toHaveBeenCalledWith('1495134320')
  })

  it('takes the size of the same game on Steam from a Steam copy in the library', async () => {
    const [copy, id] = add(steam(782330, {}, 'DOOM: Eternal®'), epic('doom', {}, 'Doom Eternal'))
    uninstallAll('steam')
    uninstallAll('epic')
    const steamInstallSize = vi.fn<ExactFn>(async () => 80 * GB)
    const got = await createService({ steamInstallSize }).refresh(id)
    expect(lookups.steamAppIdByTitle).not.toHaveBeenCalled()
    expect(steamInstallSize).toHaveBeenCalledWith(782330)
    expect(got?.metadata.storage).toMatchObject({
      bytes: 80 * GB,
      how: 'steam-match',
      steamAppId: 782330
    })
    expect(game(copy).metadata.storage).toBeUndefined()
  })

  it('matches a Steam copy whose title carries a trademark sign', async () => {
    const [, id] = add(steam(782330, {}, 'DOOM Eternal™'), epic('doom', {}, 'Doom Eternal'))
    uninstallAll('epic')
    const steamInstallSize = vi.fn<ExactFn>(async () => 80 * GB)
    const got = await createService({ steamInstallSize }).refresh(id)
    expect(lookups.steamAppIdByTitle).not.toHaveBeenCalled()
    expect(got?.metadata.storage).toMatchObject({ how: 'steam-match', steamAppId: 782330 })
  })

  it("searches Steam by the game's title (its override first) when no Steam copy is in the library", async () => {
    // "Hades II" in the library is another game, not a copy.
    const [, id] = add(steam(1, {}, 'Hades II'), epic('hades', {}, 'Hades (Epic)'))
    uninstallAll('epic')
    library.updateGame(id, { user: { titleOverride: '  Hades  ' } })
    const steamAppIdByTitle = vi.fn<SearchFn>(async () => 1145360)
    const steamInstallSize = vi.fn<ExactFn>(async (appId) => (appId === 1145360 ? 15 * GB : 1))
    const got = await createService({ steamAppIdByTitle, steamInstallSize }).refresh(id)
    expect(steamAppIdByTitle).toHaveBeenCalledWith('Hades')
    expect(steamInstallSize).toHaveBeenCalledWith(1145360)
    expect(got?.metadata.storage).toMatchObject({
      bytes: 15 * GB,
      how: 'steam-match',
      steamAppId: 1145360
    })
  })

  it("uses the matched Steam app's requirement when Steam lists no depots for it", async () => {
    const [id] = add(epic('fn', {}, 'Some Game'))
    uninstallAll('epic')
    const steamDetails = vi.fn<DetailsFn>(async () => details('Storage: 1,5 GB'))
    const got = await createService({
      steamAppIdByTitle: async () => 42,
      steamDetails
    }).refresh(id)
    expect(lookups.steamInstallSize).toHaveBeenCalledWith(42)
    expect(steamDetails).toHaveBeenCalledWith(42)
    expect(got?.metadata.storage).toMatchObject({
      bytes: Math.round(1.5 * GB),
      how: 'requirement',
      steamAppId: 42
    })
  })

  it('tries the GOG installer before the Steam match', async () => {
    const [id] = add(gog('1', join(dir, 'g')))
    uninstallAll('gog')
    const gogInstallSize = vi.fn<GogFn>(async () => undefined)
    const steamAppIdByTitle = vi.fn<SearchFn>(async () => 77)
    const steamInstallSize = vi.fn<ExactFn>(async () => 7 * GB)
    const got = await createService({
      gogInstallSize,
      steamAppIdByTitle,
      steamInstallSize
    }).refresh(id)
    expect(gogInstallSize.mock.invocationCallOrder[0]).toBeLessThan(
      steamAppIdByTitle.mock.invocationCallOrder[0]
    )
    expect(steamAppIdByTitle).toHaveBeenCalledWith('GOG 1')
    expect(got?.metadata.storage).toMatchObject({ bytes: 7 * GB, how: 'steam-match' })
  })

  it('records an empty check when Steam has no game by that title', async () => {
    const [id] = add(epic('fortnite'))
    uninstallAll('epic')
    const got = await createService().refresh(id)
    expect(lookups.steamAppIdByTitle).toHaveBeenCalledWith('Epic fortnite')
    expect(lookups.steamInstallSize).not.toHaveBeenCalled()
    expect(lookups.steamDetails).not.toHaveBeenCalled()
    expect(got?.metadata.storage).toEqual({
      matchKey: 'epic fortnite',
      checkedAt: expect.any(String)
    })
    expect(metadataChanges).toEqual([[id]])
  })

  it('stores the matchKey with a Steam match, and none for a Steam game of its own', async () => {
    const [s, e] = add(steam(620, {}, 'Portal 2'), epic('hades', {}, 'Hades™'))
    uninstallAll('steam')
    uninstallAll('epic')
    const svc = createService({
      steamAppIdByTitle: async () => 1145360,
      steamInstallSize: async () => 15 * GB
    })
    expect((await svc.refresh(e))?.metadata.storage).toEqual({
      bytes: 15 * GB,
      how: 'steam-match',
      steamAppId: 1145360,
      matchKey: 'hades',
      steamRules: STEAM_SIZE_RULES,
      checkedAt: expect.any(String)
    })
    expect((await svc.refresh(s))?.metadata.storage).not.toHaveProperty('matchKey')
  })

  it('keys the match by the title override', async () => {
    const [id] = add(epic('hades', {}, 'Hades (Epic)'))
    uninstallAll('epic')
    library.updateGame(id, { user: { titleOverride: ' Hades ' } })
    const got = await createService().refresh(id)
    expect(got?.metadata.storage?.matchKey).toBe('hades')
  })

  it('stores a partial requirement of a matched app with its matchKey', async () => {
    const [id] = add(epic('fn', {}, 'Some Game'))
    uninstallAll('epic')
    const got = await createService({
      steamAppIdByTitle: async () => 42,
      steamInstallSize: throws('503'),
      steamDetails: async () => details('Storage: 2 GB')
    }).refresh(id)
    expect(got?.metadata.storage).toEqual({
      bytes: 2 * GB,
      how: 'requirement',
      steamAppId: 42,
      partial: true,
      matchKey: 'some game',
      checkedAt: expect.any(String)
    })
  })

  it('asks again at once when the title changed since the match, and not while it is the same', async () => {
    const [id] = add(epic('hades', {}, 'Hades'))
    uninstallAll('epic')
    library.applyMetadata(
      id,
      {
        metadata: {
          storage: {
            bytes: 15 * GB,
            how: 'steam-match',
            steamRules: STEAM_SIZE_RULES,
            steamAppId: 1145360,
            matchKey: 'hades',
            checkedAt: new Date(Date.now() - DAY).toISOString()
          }
        }
      },
      { overwrite: true }
    )
    const steamAppIdByTitle = vi.fn<SearchFn>(async () => 1145350)
    const steamInstallSize = vi.fn<ExactFn>(async () => 20 * GB)
    const svc = createService({ steamAppIdByTitle, steamInstallSize })
    expect((await svc.refresh(id))?.metadata.storage?.bytes).toBe(15 * GB)
    expect(steamAppIdByTitle).not.toHaveBeenCalled()

    library.updateGame(id, { user: { titleOverride: 'Hades II' } })
    const got = await svc.refresh(id)
    expect(steamAppIdByTitle).toHaveBeenCalledWith('Hades II')
    expect(got?.metadata.storage).toMatchObject({
      bytes: 20 * GB,
      steamAppId: 1145350,
      matchKey: 'hades ii'
    })
  })

  it('does not ask again for a title that changed only in signs or case', async () => {
    const [id] = add(epic('hades', {}, 'Hades'))
    uninstallAll('epic')
    library.applyMetadata(
      id,
      {
        metadata: {
          storage: { matchKey: 'hades', checkedAt: new Date(Date.now() - DAY).toISOString() }
        }
      },
      { overwrite: true }
    )
    library.updateGame(id, { user: { titleOverride: 'HADES™' } })
    await createService().refresh(id)
    for (const fn of Object.values(lookups)) expect(fn).not.toHaveBeenCalled()
  })

  it('never matches a manual game to Steam by title, nor to a Steam copy', async () => {
    const [, id] = add(steam(1145360, {}, 'Hades'), manual(join(dir, 'Hades'), 'Hades'))
    uninstallAll('steam')
    uninstallAll('manual')
    const got = await createService({
      steamAppIdByTitle: vi.fn<SearchFn>(async () => 1145360)
    }).refresh(id)
    for (const fn of Object.values(lookups)) expect(fn).not.toHaveBeenCalled()
    // Nothing to ask: recorded as checked with no size, so later opens do not try again.
    expect(got?.metadata.storage).toEqual({ checkedAt: expect.any(String) })
  })

  it('makes no match when the library holds two Steam games of that name', async () => {
    const [, , id] = add(
      steam(17470, {}, 'Dead Space'),
      steam(1693980, {}, 'Dead Space™'),
      epic('ds', {}, 'Dead Space')
    )
    uninstallAll('steam')
    uninstallAll('epic')
    const got = await createService({
      steamAppIdByTitle: vi.fn<SearchFn>(async () => 17470)
    }).refresh(id)
    for (const fn of Object.values(lookups)) expect(fn).not.toHaveBeenCalled()
    expect(got?.metadata.storage?.bytes).toBeUndefined()
  })

  it('records nothing when the title search throws', async () => {
    const [id] = add(epic('fortnite'))
    uninstallAll('epic')
    const before = JSON.stringify(game(id))
    const got = await createService({ steamAppIdByTitle: throws('offline') }).refresh(id)
    expect(JSON.stringify(got)).toBe(before)
    expect(JSON.stringify(game(id))).toBe(before)
    expect(metadataChanges).toEqual([])
  })

  it('records an empty check for a ROM without asking any store', async () => {
    const [id] = add(rom(join(dir, 'roms', 'gone.sfc'), 'Super Mario World'))
    uninstallAll('rom')
    const got = await createService().refresh(id)
    for (const fn of Object.values(lookups)) expect(fn).not.toHaveBeenCalled()
    expect(got?.metadata.storage).toEqual({ checkedAt: expect.any(String) })
  })

  it('shares one lookup between overlapping refreshes of a game', async () => {
    const [id] = add(steam(620))
    uninstallAll('steam')
    const gate = deferred<SteamAppDetails | null>()
    const steamDetails = vi.fn<DetailsFn>(() => gate.promise)
    const svc = createService({ steamDetails })
    const a = svc.refresh(id)
    const b = svc.refresh(id)
    expect(b).toBe(a)
    await vi.waitFor(() => expect(steamDetails).toHaveBeenCalledTimes(1))
    gate.resolve(details('Storage: 3 GB'))
    expect((await a)?.metadata.storage?.bytes).toBe(3 * GB)
    expect(steamDetails).toHaveBeenCalledTimes(1)
    // Done: the next refresh starts its own (and finds the fresh check).
    const c = svc.refresh(id)
    expect(c).not.toBe(a)
    await c
    expect(steamDetails).toHaveBeenCalledTimes(1)
  })

  it('returns null when the game is removed while its store size is looked up', async () => {
    const [id] = add(epic('gone'))
    uninstallAll('epic')
    const gate = deferred<number | undefined>()
    const svc = createService({ steamAppIdByTitle: vi.fn<SearchFn>(() => gate.promise) })
    const run = svc.refresh(id)
    await vi.waitFor(() => expect(lookups.steamAppIdByTitle).toHaveBeenCalled())
    library.removeGame(id)
    gate.resolve(undefined)
    expect(await run).toBeNull()
    expect(library.getGame(id)).toBeUndefined()
  })
})

describe('refresh: the release year guards a Steam match', () => {
  const details = (date: string): SteamAppDetails => ({ release_date: { date } })

  it('rejects a Steam game of the same name from another year (a remake)', async () => {
    const [id] = add(epic('deadspace', {}, 'Dead Space'))
    uninstallAll('epic')
    library.applyMetadata(id, { metadata: { releaseDate: '2008-10-14' } })
    const steamAppIdByTitle = vi.fn<SearchFn>(async () => 1693980)
    const steamDetails = vi.fn<DetailsFn>(async () => details('Jan 27, 2023'))
    const steamInstallSize = vi.fn<ExactFn>(async () => 50 * GB)
    const got = await createService({ steamAppIdByTitle, steamDetails, steamInstallSize }).refresh(
      id
    )
    expect(steamInstallSize).not.toHaveBeenCalled()
    expect(got?.metadata.storage?.bytes).toBeUndefined()
  })

  it('accepts it when the years agree within a year, or when the game has no year', async () => {
    const [same, unknown] = add(
      epic('hades', {}, 'Hades'),
      epic('hades2', {}, 'Hades Unknown Year')
    )
    uninstallAll('epic')
    library.applyMetadata(same, { metadata: { releaseDate: '2021' } })
    const steamAppIdByTitle = vi.fn<SearchFn>(async () => 1145360)
    const steamDetails = vi.fn<DetailsFn>(async () => details('Sep 17, 2020'))
    const steamInstallSize = vi.fn<ExactFn>(async () => 14 * GB)
    const svc = createService({ steamAppIdByTitle, steamDetails, steamInstallSize })
    expect((await svc.refresh(same))?.metadata.storage).toMatchObject({ how: 'steam-match' })
    expect((await svc.refresh(unknown))?.metadata.storage).toMatchObject({ how: 'steam-match' })
  })
})

// ---------------------------------------------------------------------------
// fillStoreSizes
// ---------------------------------------------------------------------------

describe('fillStoreSizes', () => {
  const setStorage = (
    id: string,
    ageMs: number,
    extra: { partial?: true; matchKey?: string; empty?: true } = {}
  ): void => {
    const { empty, ...rest } = extra
    library.applyMetadata(
      id,
      {
        metadata: {
          storage: {
            ...(empty ? {} : { bytes: GB, how: 'requirement' as const }),
            checkedAt: new Date(Date.now() - ageMs).toISOString(),
            ...rest
          }
        }
      },
      { overwrite: true }
    )
  }

  it('looks up only games that are not installed or not measurable, and have no size or a stale empty check', async () => {
    const [notInstalled, fresh, stalePartial, freshPartial, stale, renamed, foundLongAgo] = add(
      steam(1),
      steam(2),
      steam(3),
      steam(4),
      steam(5),
      epic('renamed', {}, 'Renamed Game'),
      steam(6)
    )
    uninstallAll('steam')
    uninstallAll('epic')
    const [measured, unmeasurableId, romId, manualId] = add(
      steam(10, { sizeOnDisk: 5 * GB }),
      steam(11, { sizeOnDisk: 0 }),
      rom(join(dir, 'roms', 'gone.sfc'), 'Gone'),
      manual(join(dir, 'Manual'), 'Manual Game')
    )
    uninstallAll('rom')
    uninstallAll('manual')
    library.setInstallSizes([
      { id: measured, size: size(5 * GB, join(dir, 'steam', '10'), 'store') },
      { id: unmeasurableId, size: unmeasurable(join(dir, 'steam', '11')) }
    ])
    setStorage(fresh, 29 * DAY)
    // A size once found is kept, whatever its age.
    setStorage(foundLongAgo, 400 * DAY)
    setStorage(stalePartial, 25 * 60 * 60 * 1000, { partial: true, empty: true })
    setStorage(freshPartial, 23 * 60 * 60 * 1000, { partial: true, empty: true })
    setStorage(stale, 31 * DAY, { empty: true })
    // Matched under another title than the game has now: asked again at once.
    setStorage(renamed, DAY, { matchKey: 'something else' })

    const steamInstallSize = vi.fn<ExactFn>(async (appId) => appId * GB)
    const steamAppIdByTitle = vi.fn<SearchFn>(async () => undefined)
    await createService({ steamInstallSize, steamAppIdByTitle }).fillStoreSizes()

    expect(steamInstallSize.mock.calls.map(([appId]) => appId).sort((a, b) => a - b)).toEqual([
      1, 3, 5, 11
    ])
    expect(steamAppIdByTitle).toHaveBeenCalledTimes(1)
    expect(steamAppIdByTitle).toHaveBeenCalledWith('Renamed Game')
    expect(game(notInstalled).metadata.storage).toMatchObject({ bytes: GB, how: 'steam' })
    expect(game(stalePartial).metadata.storage).toMatchObject({ bytes: 3 * GB, how: 'steam' })
    expect(game(stalePartial).metadata.storage).not.toHaveProperty('partial')
    expect(game(stale).metadata.storage).toMatchObject({ bytes: 5 * GB, how: 'steam' })
    expect(game(unmeasurableId).metadata.storage).toMatchObject({ bytes: 11 * GB, how: 'steam' })
    // Left alone.
    expect(game(fresh).metadata.storage).toMatchObject({ bytes: GB, how: 'requirement' })
    expect(game(foundLongAgo).metadata.storage).toMatchObject({ bytes: GB, how: 'requirement' })
    expect(game(freshPartial).metadata.storage).toMatchObject({ partial: true })
    expect(game(freshPartial).metadata.storage).not.toHaveProperty('bytes')
    expect(game(measured).metadata.storage).toBeUndefined()
    expect(game(romId).metadata.storage).toBeUndefined()
    expect(game(manualId).metadata.storage).toBeUndefined()
    // The renamed game was checked again, under its own title now.
    expect(game(renamed).metadata.storage?.matchKey).not.toBe('something else')
    expect(recent(game(renamed).metadata.storage?.checkedAt)).toBe(true)
  })

  it('does nothing on a second pass once every game has a fresh size', async () => {
    add(steam(1), steam(2))
    uninstallAll('steam')
    const steamInstallSize = vi.fn<ExactFn>(async () => GB)
    const svc = createService({ steamInstallSize })
    await svc.fillStoreSizes()
    expect(steamInstallSize).toHaveBeenCalledTimes(2)
    await svc.fillStoreSizes()
    expect(steamInstallSize).toHaveBeenCalledTimes(2)
  })

  it('keeps going after a game whose lookups all fail, and records nothing for it', async () => {
    const [a, b] = add(steam(1), steam(2))
    uninstallAll('steam')
    const steamInstallSize = vi.fn<ExactFn>(async (appId) => {
      if (appId === 1) throw new Error('503')
      return 2 * GB
    })
    const steamDetails = vi.fn<DetailsFn>(async (appId) => {
      if (appId === 1) throw new Error('503')
      return null
    })
    await createService({ steamInstallSize, steamDetails }).fillStoreSizes()
    expect(game(a).metadata.storage).toBeUndefined()
    expect(game(b).metadata.storage).toMatchObject({ bytes: 2 * GB })
  })

  it('shares one run between concurrent calls, and a call during a run runs it again', async () => {
    const [first] = add(steam(1))
    uninstallAll('steam')
    const gate = deferred<number | undefined>()
    const steamInstallSize = vi.fn<ExactFn>((appId) =>
      appId === 1 ? gate.promise : Promise.resolve(appId * GB)
    )
    const svc = createService({ steamInstallSize })
    const a = svc.fillStoreSizes()
    const b = svc.fillStoreSizes()
    expect(b).toBe(a)
    await vi.waitFor(() => expect(steamInstallSize).toHaveBeenCalledWith(1))
    // A game imported while the pass runs is not in that pass's list: the rerun picks it up.
    const [second] = add(steam(2))
    uninstallAll('steam')
    const c = svc.fillStoreSizes()
    expect(c).toBe(a)
    gate.resolve(GB)
    await a
    expect(game(first).metadata.storage).toMatchObject({ bytes: GB })
    expect(game(second).metadata.storage).toMatchObject({ bytes: 2 * GB })
    expect(steamInstallSize).toHaveBeenCalledTimes(2)
    // Done: a later call starts a new run, which finds nothing left to do.
    const d = svc.fillStoreSizes()
    expect(d).not.toBe(a)
    await d
    expect(steamInstallSize).toHaveBeenCalledTimes(2)
  })

  it('stops after dispose: the lookups in flight finish, no new one starts', async () => {
    const ids = add(steam(1), steam(2), steam(3), steam(4), steam(5), steam(6))
    uninstallAll('steam')
    const gate = deferred<number | undefined>()
    const steamInstallSize = vi.fn<ExactFn>(() => gate.promise)
    const svc = createService({ steamInstallSize })
    const run = svc.fillStoreSizes()
    // Four lookups at a time.
    await vi.waitFor(() => expect(steamInstallSize).toHaveBeenCalledTimes(4))
    const disposing = svc.dispose()
    gate.resolve(GB)
    await run
    await disposing
    expect(steamInstallSize).toHaveBeenCalledTimes(4)
    expect(game(ids[4]!).metadata.storage).toBeUndefined()
    expect(game(ids[5]!).metadata.storage).toBeUndefined()
    await svc.fillStoreSizes()
    expect(steamInstallSize).toHaveBeenCalledTimes(4)
  })
})

describe('the local size cache', () => {
  it('asks steamcmd once for two games with the same Steam app id, and saves the answer', async () => {
    const [own, carried] = add(steam(620), epic('portal2', { steamAppId: 620 }))
    uninstallAll('steam')
    uninstallAll('epic')
    const cacheFile = join(dir, 'install-sizes.json')
    const steamInstallSize = vi.fn<ExactFn>(async () => 11 * GB)
    const quiet = {
      steamDetails: vi.fn<DetailsFn>(async () => null),
      gogInstallSize: vi.fn<GogFn>(async () => undefined),
      steamAppIdByTitle: vi.fn<SearchFn>(async () => undefined)
    }
    const svc = createInstallSizeService(
      { library, log, cacheFile },
      { steamInstallSize, ...quiet }
    )
    expect((await svc.refresh(own))?.metadata.storage).toMatchObject({
      bytes: 11 * GB,
      how: 'steam'
    })
    expect((await svc.refresh(carried))?.metadata.storage).toMatchObject({
      bytes: 11 * GB,
      how: 'steam'
    })
    expect(steamInstallSize).toHaveBeenCalledTimes(1)
    await svc.dispose()
    const saved = JSON.parse(await fs.readFile(cacheFile, 'utf8')) as Record<string, unknown>
    expect(saved[`steam:v${STEAM_SIZE_RULES}:620`]).toMatchObject({ value: 11 * GB })

    // The next start reads the answer back for a third copy without asking again.
    const [third] = add(epic('portal2-again', { steamAppId: 620 }))
    uninstallAll('epic')
    const again = vi.fn<ExactFn>(async () => 1)
    const next = createInstallSizeService(
      { library, log, cacheFile },
      { steamInstallSize: again, ...quiet }
    )
    const got = await next.refresh(third)
    await next.dispose()
    expect(again).not.toHaveBeenCalled()
    expect(got?.metadata.storage).toMatchObject({ bytes: 11 * GB, how: 'steam' })
  })
})

describe('fillStoreSizes when the stores do not answer', () => {
  it('gives up after five games in a row and tries again later, not at once', async () => {
    const ids = add(steam(1), steam(2), steam(3), steam(4), steam(5), steam(6), steam(7))
    uninstallAll('steam')
    const steamInstallSize = vi.fn<ExactFn>(async () => {
      throw new Error('offline')
    })
    const steamDetails = vi.fn<DetailsFn>(async () => {
      throw new Error('offline')
    })
    const svc = createService({ steamInstallSize, steamDetails })
    await svc.fillStoreSizes()
    // The fast lane asks steamcmd once per game and hands each to the store lane, which gives up after five
    // failures in a row; nothing is recorded.
    expect(steamInstallSize).toHaveBeenCalledTimes(7)
    expect(steamDetails).toHaveBeenCalledTimes(5)
    for (const id of ids) expect(game(id).metadata.storage).toBeUndefined()
    // A call made meanwhile (an import) runs once, it does not loop over the same failures.
    await svc.fillStoreSizes()
    expect(steamInstallSize).toHaveBeenCalledTimes(14)
    expect(steamDetails).toHaveBeenCalledTimes(10)
  })
})

describe('scanAll: the start-up scan of a run', () => {
  it('does not ask the stores again for a game that already has a size, whatever its age', async () => {
    const [known, unknown] = add(steam(1), steam(2))
    uninstallAll('steam')
    library.applyMetadata(known, {
      metadata: {
        storage: {
          bytes: GB,
          how: 'steam',
          steamRules: STEAM_SIZE_RULES,
          checkedAt: new Date(Date.now() - 400 * DAY).toISOString()
        }
      }
    })
    const steamInstallSize = vi.fn<ExactFn>(async () => 2 * GB)
    const svc = createService({ steamInstallSize })
    await svc.scanAll()
    expect(steamInstallSize.mock.calls.map(([appId]) => appId)).toEqual([2])
    expect(game(known).metadata.storage?.bytes).toBe(GB)
    expect(game(unknown).metadata.storage?.bytes).toBe(2 * GB)
    // Nothing is left to ask: a later fill and a panel open ask nothing more.
    await svc.fillStoreSizes()
    await svc.refresh(known)
    await svc.refresh(unknown)
    expect(steamInstallSize).toHaveBeenCalledTimes(1)
  })

  it('does not walk a folder with a found size again', async () => {
    const [id] = add(gog('1', join(dir, 'g1')))
    const folderSize = vi.fn(async () => 3 * GB)
    const svc = createService({ folderSize })
    await svc.measure()
    expect(folderSize).toHaveBeenCalledTimes(1)
    await svc.scanAll()
    await svc.measure()
    expect(folderSize).toHaveBeenCalledTimes(1)
    expect(game(id).installSize?.bytes).toBe(3 * GB)
  })

  it('does not walk a folder measured long ago, in an earlier run', async () => {
    const [id] = add(gog('1', join(dir, 'g1')))
    library.setInstallSizes([{ id, size: size(3 * GB, join(dir, 'g1'), 'folder', 90 * DAY) }])
    const folderSize = vi.fn(async () => 4 * GB)
    const svc = createService({ folderSize })
    await svc.scanAll()
    await svc.measure()
    expect(folderSize).not.toHaveBeenCalled()
    expect(game(id).installSize?.bytes).toBe(3 * GB)
  })

  it('measures only the games added or moved since their sizes were found', async () => {
    const [kept, moved] = add(gog('1', join(dir, 'g1')), gog('2', join(dir, 'g2')))
    library.setInstallSizes([
      { id: kept, size: size(GB, join(dir, 'g1'), 'folder', 20 * DAY) },
      { id: moved, size: size(GB, join(dir, 'g2-old'), 'folder', 20 * DAY) }
    ])
    const [added] = add(gog('3', join(dir, 'g3')))
    const folderSize = vi.fn<FolderFn>(async () => 2 * GB)
    const svc = createService({ folderSize })
    await svc.scanAll()
    await vi.waitFor(() => expect(game(added).installSize?.bytes).toBe(2 * GB))
    await svc.measure()
    expect(folderSize.mock.calls.map(([d]) => d).sort()).toEqual(
      [join(dir, 'g2'), join(dir, 'g3')].sort()
    )
    expect(game(kept).installSize?.bytes).toBe(GB)
    expect(game(moved).installSize).toMatchObject({ bytes: 2 * GB, path: join(dir, 'g2') })
  })

  it('runs once per session: a second call does nothing', async () => {
    add(gog('1', join(dir, 'g1')), steam(5))
    uninstallAll('steam')
    const folderSize = vi.fn<FolderFn>(async () => GB)
    const steamInstallSize = vi.fn<ExactFn>(async () => GB)
    const svc = createService({ folderSize, steamInstallSize })
    await svc.scanAll()
    await vi.waitFor(() => expect(folderSize).toHaveBeenCalledTimes(1))
    // A game added since: the second scanAll leaves it to the normal passes.
    const [late, lateUninstalled] = add(gog('2', join(dir, 'g2')), steam(6))
    uninstallAll('steam')
    await svc.scanAll()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(folderSize).toHaveBeenCalledTimes(1)
    expect(steamInstallSize).toHaveBeenCalledTimes(1)
    expect(game(late).installSize).toBeUndefined()
    expect(game(lateUninstalled).metadata.storage).toBeUndefined()
  })

  it('reports how many games are left to look up, ending at 0', async () => {
    add(steam(1), steam(2), steam(3))
    uninstallAll('steam')
    const seen: { done: number; total: number; remaining: number }[] = []
    events.on('install-size:progress', (p) => seen.push(p))
    service = createInstallSizeService(
      { library, log, events },
      {
        steamInstallSize: async () => GB,
        steamDetails: async () => null,
        gogInstallSize: async () => undefined,
        steamAppIdByTitle: async () => undefined
      }
    )
    await service.scanAll()
    // The lookups start at 0 of 3, count up, and the scan ends idle (total 0).
    expect(seen).toContainEqual({ done: 0, total: 3, remaining: 3 })
    expect(seen.at(-1)).toMatchObject({ total: 0, remaining: 0 })
    for (const p of seen) expect(p.remaining).toBe(p.total - p.done)
  })
})

describe('the start-up scan, in order and quietly', () => {
  it('looks up games without any size first, before a renamed game whose size is known', async () => {
    const [known, unknown] = add(epic('k', { steamAppId: 1 }, 'Known'), steam(2))
    uninstallAll('steam')
    uninstallAll('epic')
    // Matched under another title: looked up again, after the games without any size.
    library.applyMetadata(known, {
      metadata: {
        storage: {
          bytes: GB,
          how: 'steam',
          matchKey: 'something else',
          checkedAt: new Date().toISOString()
        }
      }
    })
    const order: number[] = []
    const steamInstallSize = vi.fn<ExactFn>(async (appId) => {
      order.push(appId)
      return GB
    })
    await createService({ steamInstallSize }).scanAll()
    expect(order[0]).toBe(2)
    expect(game(unknown).metadata.storage?.bytes).toBe(GB)
  })

  it('leaves a found size alone: asks nothing, tells the renderer nothing', async () => {
    const [id] = add(steam(1))
    uninstallAll('steam')
    library.applyMetadata(id, {
      metadata: {
        storage: {
          bytes: GB,
          how: 'steam',
          steamRules: STEAM_SIZE_RULES,
          checkedAt: new Date().toISOString()
        }
      }
    })
    metadataChanges = []
    const steamInstallSize = vi.fn<ExactFn>(async () => GB)
    await createService({ steamInstallSize }).scanAll()
    expect(steamInstallSize).not.toHaveBeenCalled()
    expect(metadataChanges.flat()).not.toContain(id)
  })

  it('re-checks an old empty check that still finds nothing without telling the renderer', async () => {
    const [id] = add(steam(1))
    uninstallAll('steam')
    library.applyMetadata(id, {
      metadata: { storage: { checkedAt: new Date(Date.now() - 31 * DAY).toISOString() } }
    })
    metadataChanges = []
    const steamInstallSize = vi.fn<ExactFn>(async () => undefined)
    await createService({ steamInstallSize }).scanAll()
    expect(steamInstallSize).toHaveBeenCalledTimes(1)
    expect(recent(game(id).metadata.storage?.checkedAt)).toBe(true)
    expect(metadataChanges.flat()).not.toContain(id)
  })

  it('does not let games matched by title hold up the Steam and GOG lookups', async () => {
    const ids = add(
      epic('a', {}, 'Title A'),
      epic('b', {}, 'Title B'),
      epic('c', {}, 'Title C'),
      epic('d', {}, 'Title D'),
      steam(9)
    )
    uninstallAll('epic')
    uninstallAll('steam')
    const searching = deferred<number | undefined>()
    const steamAppIdByTitle = vi.fn<SearchFn>(() => searching.promise)
    const steamInstallSize = vi.fn<ExactFn>(async () => GB)
    const svc = createService({ steamAppIdByTitle, steamInstallSize })
    const run = svc.scanAll()
    // The Steam game is answered while the first title search is still waiting.
    await vi.waitFor(() => expect(game(ids[4]!).metadata.storage?.bytes).toBe(GB))
    expect(steamAppIdByTitle).toHaveBeenCalledTimes(1)
    searching.resolve(undefined)
    await run
  })

  it('does not walk an unmeasurable folder again at every start', async () => {
    const [id] = add(gog('1', join(dir, 'g1')))
    const folderSize = vi.fn(async () => null)
    const svc = createService({ folderSize })
    await svc.measure()
    expect(game(id).installSize?.unmeasurable).toBe(true)
    await svc.scanAll()
    await svc.measure()
    expect(folderSize).toHaveBeenCalledTimes(1)
  })
})

describe('install-size:progress', () => {
  const withEvents = (options: InstallSizeOptions): InstallSizeService =>
    (service = createInstallSizeService(
      { library, log, events },
      {
        steamDetails: async () => null,
        gogInstallSize: async () => undefined,
        steamAppIdByTitle: async () => undefined,
        steamInstallSize: async () => undefined,
        ...options
      }
    ))

  it('counts the installed games being measured', async () => {
    add(gog('1', join(dir, 'g1')), gog('2', join(dir, 'g2')))
    const seen: { done: number; total: number }[] = []
    events.on('install-size:progress', (p) => seen.push(p))
    await withEvents({ folderSize: async () => GB }).measure()
    expect(seen[0]).toMatchObject({ done: 0, total: 2 })
    expect(seen.at(-1)).toMatchObject({ done: 0, total: 0 })
  })

  it('counts only the installed games without a current size', async () => {
    const [known] = add(gog('1', join(dir, 'g1')), gog('2', join(dir, 'g2')))
    add(steam(3, { sizeOnDisk: 30 }))
    library.setInstallSizes([{ id: known, size: size(GB, join(dir, 'g1'), 'folder', 30 * DAY) }])
    const seen: { done: number; total: number }[] = []
    events.on('install-size:progress', (p) => seen.push(p))
    await withEvents({ folderSize: async () => GB }).measure()
    // g2 and the new Steam record; g1 is known.
    expect(seen[0]).toMatchObject({ done: 0, total: 2 })
    expect(Math.max(...seen.map((p) => p.total))).toBe(2)
  })

  it('shows no bar when every installed game already has a current size', async () => {
    add(gog('1', join(dir, 'g1')), steam(3, { sizeOnDisk: 30 }))
    const folderSize = vi.fn<FolderFn>(async () => GB)
    const svc = withEvents({ folderSize })
    await svc.measure()
    const seen: { done: number; total: number; current?: string }[] = []
    events.on('install-size:progress', (p) => seen.push(p))
    await svc.measure()
    await svc.measure()
    expect(folderSize).toHaveBeenCalledTimes(1)
    // At most the idle report at the end of a pass: nothing to count, no game named.
    for (const p of seen) expect(p).toEqual({ done: 0, total: 0, remaining: 0 })
  })

  it('names the game whose folder is being walked, and no longer once it is done', async () => {
    add(gog('1', join(dir, 'g1')))
    const gate = deferred<number>()
    const folderSize = vi.fn<FolderFn>(() => gate.promise)
    const seen: { done: number; total: number; current?: string }[] = []
    events.on('install-size:progress', (p) => seen.push(p))
    const run = withEvents({ folderSize }).measure()
    await vi.waitFor(() => expect(folderSize).toHaveBeenCalledTimes(1))
    expect(seen.at(-1)).toMatchObject({ done: 0, total: 1, current: 'GOG 1' })
    gate.resolve(GB)
    await run
    expect(seen.at(-1)).toEqual({ done: 0, total: 0, remaining: 0 })
  })

  it('does not name a game walked by refresh() on the later lookup bar', async () => {
    // refreshOne() -> sizeOf() sets `measuring` to the walked game's title, but only pass() clears it again: after a
    // refresh of an installed game, every lookup report of fillStoreSizes carries that stale `current`.
    const [installed] = add(gog('1', join(dir, 'g1')))
    add(steam(5))
    uninstallAll('steam')
    const seen: { done: number; total: number; current?: string }[] = []
    events.on('install-size:progress', (p) => seen.push(p))
    const svc = withEvents({ folderSize: async () => GB, steamInstallSize: async () => GB })
    await svc.refresh(installed)
    await svc.fillStoreSizes()
    expect(seen.some((p) => p.total > 0)).toBe(true)
    for (const p of seen) expect(p).not.toHaveProperty('current')
  })

  it('says it is paused, with the games left, when the stores stop answering', async () => {
    add(steam(1), steam(2), steam(3), steam(4), steam(5), steam(6))
    uninstallAll('steam')
    const seen: { total: number; paused?: boolean }[] = []
    events.on('install-size:progress', (p) => seen.push(p))
    await withEvents({
      steamInstallSize: async () => {
        throw new Error('offline')
      },
      steamDetails: async () => {
        throw new Error('offline')
      }
    }).fillStoreSizes()
    expect(seen.at(-1)).toMatchObject({ paused: true, total: 6 })
  })
})

describe('the fast lane never waits on the Steam store', () => {
  it('hands a game without a steamcmd size to the store lane and carries on', async () => {
    const [old, other] = add(steam(10), steam(620))
    uninstallAll('steam')
    const store = deferred<SteamAppDetails | null>()
    const steamDetails = vi.fn<DetailsFn>(() => store.promise)
    const steamInstallSize = vi.fn<ExactFn>(async (appId) => (appId === 620 ? 12 * GB : undefined))
    const svc = createService({ steamDetails, steamInstallSize })
    const run = svc.fillStoreSizes()
    // The second game is answered while the first waits on the store.
    await vi.waitFor(() => expect(game(other).metadata.storage?.bytes).toBe(12 * GB))
    expect(game(old).metadata.storage).toBeUndefined()
    store.resolve(null)
    await run
    // steamcmd was asked once for the handed-over game, not again by the store lane.
    expect(steamInstallSize.mock.calls.filter(([id]) => id === 10)).toHaveLength(1)
    expect(game(old).metadata.storage).toMatchObject({ checkedAt: expect.any(String) })
  })
})

describe('reinstalls and shared walks', () => {
  it('measures a game reinstalled into the same folder again', async () => {
    const dirG = join(dir, 'g1')
    const [id] = add(gog('1', dirG))
    let bytes = 2 * GB
    const folderSize = vi.fn(async () => bytes)
    const svc = createService({ folderSize })
    await svc.measure()
    expect(game(id).installSize?.bytes).toBe(2 * GB)
    // Uninstalled (a scan no longer reports it), then reinstalled bigger into the same folder.
    library.mergeScan('gog', [])
    expect(game(id).installSize).toBeUndefined()
    bytes = 5 * GB
    library.mergeScan('gog', [gog('1', dirG)])
    await svc.measure()
    expect(folderSize).toHaveBeenCalledTimes(2)
    expect(game(id).installSize?.bytes).toBe(5 * GB)
  })

  it('walks a folder once when the pass and a panel open ask for it together', async () => {
    const [id] = add(gog('1', join(dir, 'g1')))
    const walk = deferred<number | null>()
    const folderSize = vi.fn(() => walk.promise)
    const svc = createService({ folderSize })
    const pass = svc.measure()
    await vi.waitFor(() => expect(folderSize).toHaveBeenCalledTimes(1))
    const opened = svc.refresh(id)
    walk.resolve(3 * GB)
    await Promise.all([pass, opened])
    expect(folderSize).toHaveBeenCalledTimes(1)
    expect(game(id).installSize?.bytes).toBe(3 * GB)
  })
})

// ---------------------------------------------------------------------------
// Epic's own build manifests (signed in to Epic)
// ---------------------------------------------------------------------------

describe('Epic manifest sizes', () => {
  type EpicFn = NonNullable<InstallSizeOptions['epicInstallSize']>
  const ids = { epicAppName: 'Fennel', epicNamespace: 'ns1', epicCatalogItemId: 'cat1' }

  it('sizes a signed-in Epic game from its manifest, before any Steam match, as exact', async () => {
    const [id] = add(epic('Fennel', ids, 'Fennel Quest'))
    uninstallAll('epic')
    const epicInstallSize = vi.fn<EpicFn>(async () => ({ bytes: 12 * GB, optional: 0 }))
    const svc = createService({ epicInstallSize })
    svc.useEpicAccount(async () => 'token-1')
    await svc.fillStoreSizes()
    expect(epicInstallSize).toHaveBeenCalledWith('token-1', {
      appName: 'Fennel',
      namespace: 'ns1',
      catalogItemId: 'cat1'
    })
    expect(lookups.steamAppIdByTitle).not.toHaveBeenCalled()
    expect(game(id).metadata.storage).toMatchObject({
      bytes: 12 * GB,
      how: 'epic',
      epicChecked: true
    })
  })

  it('falls back to the Steam match when Epic is signed out', async () => {
    const [, id] = add(steam(77, {}, 'Fennel Quest'), epic('Fennel', ids, 'Fennel Quest'))
    uninstallAll('steam')
    uninstallAll('epic')
    const epicInstallSize = vi.fn<EpicFn>(async () => ({ bytes: 12 * GB, optional: 0 }))
    const steamInstallSize = vi.fn<ExactFn>(async () => 9 * GB)
    const svc = createService({ epicInstallSize, steamInstallSize })
    svc.useEpicAccount(async () => null)
    const got = await svc.refresh(id)
    expect(epicInstallSize).not.toHaveBeenCalled()
    expect(got?.metadata.storage).toMatchObject({ bytes: 9 * GB, how: 'steam-match' })
    expect(got?.metadata.storage?.epicChecked).toBeUndefined()
  })

  it('replaces an earlier Steam match once signed in, and asks Epic only once', async () => {
    const [, id] = add(steam(77, {}, 'Fennel Quest'), epic('Fennel', ids, 'Fennel Quest'))
    uninstallAll('steam')
    uninstallAll('epic')
    const steamInstallSize = vi.fn<ExactFn>(async () => 9 * GB)
    const first = createService({ steamInstallSize })
    await first.fillStoreSizes()
    expect(game(id).metadata.storage).toMatchObject({ how: 'steam-match' })
    await first.dispose()

    const epicInstallSize = vi.fn<EpicFn>(async () => ({ bytes: 12 * GB, optional: 0 }))
    const svc = createService({ epicInstallSize, steamInstallSize })
    svc.useEpicAccount(async () => 'token-1')
    await svc.fillStoreSizes()
    expect(game(id).metadata.storage).toMatchObject({ bytes: 12 * GB, how: 'epic' })
    await svc.fillStoreSizes()
    expect(epicInstallSize).toHaveBeenCalledTimes(1)
  })

  it('keeps the Steam match when Epic has no Windows build, and does not ask Epic again', async () => {
    const [, id] = add(steam(77, {}, 'Fennel Quest'), epic('Fennel', ids, 'Fennel Quest'))
    uninstallAll('steam')
    uninstallAll('epic')
    const epicInstallSize = vi.fn<EpicFn>(async () => undefined)
    const steamInstallSize = vi.fn<ExactFn>(async () => 9 * GB)
    const svc = createService({ epicInstallSize, steamInstallSize })
    svc.useEpicAccount(async () => 'token-1')
    await svc.fillStoreSizes()
    expect(game(id).metadata.storage).toMatchObject({
      bytes: 9 * GB,
      how: 'steam-match',
      epicChecked: true
    })
    await svc.fillStoreSizes()
    expect(epicInstallSize).toHaveBeenCalledTimes(1)
  })

  it('carries on with Steam when Epic cannot be reached, and asks Epic again later', async () => {
    const [, id] = add(steam(77, {}, 'Fennel Quest'), epic('Fennel', ids, 'Fennel Quest'))
    uninstallAll('steam')
    uninstallAll('epic')
    const epicInstallSize = vi.fn<EpicFn>(throws('HTTP 503'))
    const steamInstallSize = vi.fn<ExactFn>(async () => 9 * GB)
    const svc = createService({ epicInstallSize, steamInstallSize })
    svc.useEpicAccount(async () => 'token-1')
    const got = await svc.refresh(id)
    expect(got?.metadata.storage).toMatchObject({ bytes: 9 * GB, how: 'steam-match' })
    expect(got?.metadata.storage?.epicChecked).toBeUndefined()
    // Not asked again within the hour...
    await svc.refresh(id)
    expect(epicInstallSize).toHaveBeenCalledTimes(1)
    // ...but after it, and Epic's figure then replaces the Steam match.
    epicInstallSize.mockImplementation(async () => ({ bytes: 12 * GB, optional: 0 }))
    const later = Date.now() + 2 * 60 * 60_000
    const now = vi.spyOn(Date, 'now').mockReturnValue(later)
    try {
      const again = await svc.refresh(id)
      expect(epicInstallSize).toHaveBeenCalledTimes(2)
      expect(again?.metadata.storage).toMatchObject({ bytes: 12 * GB, how: 'epic' })
    } finally {
      now.mockRestore()
    }
  })

  it('needs all three Epic ids (a game found installed without catalog ids is matched on Steam)', async () => {
    const [id] = add(epic('Fennel', { epicAppName: 'Fennel' }, 'Fennel Quest'))
    uninstallAll('epic')
    const epicInstallSize = vi.fn<EpicFn>(async () => ({ bytes: 12 * GB, optional: 0 }))
    const svc = createService({ epicInstallSize })
    svc.useEpicAccount(async () => 'token-1')
    await svc.refresh(id)
    expect(epicInstallSize).not.toHaveBeenCalled()
  })
})

describe('Epic manifest sizes when Epic misbehaves', () => {
  type EpicFn = NonNullable<InstallSizeOptions['epicInstallSize']>
  const ids = (n: number): ScannedGame['extra'] => ({
    epicAppName: `App${n}`,
    epicNamespace: `ns${n}`,
    epicCatalogItemId: `cat${n}`
  })

  it('an Epic outage neither stalls the pass nor keeps asking Epic: Steam matches fill in', async () => {
    // Seven Epic games, each the same game as a Steam copy in the library, and a Steam game of its own.
    const scans: ScannedGame[] = []
    for (let n = 1; n <= 7; n++) {
      scans.push(steam(100 + n, {}, `Fennel ${n}`), epic(`App${n}`, ids(n), `Fennel ${n}`))
    }
    scans.push(steam(500, {}, 'Lone Steam Game'))
    add(...scans)
    uninstallAll('steam')
    uninstallAll('epic')
    const epicInstallSize = vi.fn<EpicFn>(throws('HTTP 503'))
    const steamInstallSize = vi.fn<ExactFn>(async () => 9 * GB)
    const svc = createService({ epicInstallSize, steamInstallSize })
    svc.useEpicAccount(async () => 'token-1')
    await svc.fillStoreSizes()
    // Every game has a size: the Epic games their Steam match, the Steam game its own.
    for (const g of library.games()) expect(g.metadata.storage?.bytes).toBe(9 * GB)
    // Epic was left alone after five failures in a row, and a second pass does not ask it again.
    expect(epicInstallSize).toHaveBeenCalledTimes(5)
    await svc.fillStoreSizes()
    expect(epicInstallSize).toHaveBeenCalledTimes(5)
  })

  it('a refused token is refreshed once and the lookup tried again', async () => {
    const [id] = add(epic('App1', ids(1), 'Fennel Quest'))
    uninstallAll('epic')
    const epicInstallSize = vi.fn<EpicFn>(async (token) => {
      if (token === 'old') throw new HttpError('HTTP 401', { status: 401, url: 'https://x' })
      return { bytes: 12 * GB, optional: 0 }
    })
    const token = vi.fn(async (refresh?: boolean) => (refresh ? 'new' : 'old'))
    const svc = createService({ epicInstallSize })
    svc.useEpicAccount(token)
    const got = await svc.refresh(id)
    expect(token).toHaveBeenCalledWith(true)
    expect(epicInstallSize).toHaveBeenLastCalledWith('new', expect.anything())
    expect(got?.metadata.storage).toMatchObject({ bytes: 12 * GB, how: 'epic' })
  })

  it('marks a build with optional content as approximate', async () => {
    const [id] = add(epic('App1', ids(1), 'Fennel Quest'))
    uninstallAll('epic')
    const epicInstallSize = vi.fn<EpicFn>(async () => ({ bytes: 40 * GB, optional: 10 * GB }))
    const svc = createService({ epicInstallSize })
    svc.useEpicAccount(async () => 'token-1')
    const got = await svc.refresh(id)
    expect(got?.metadata.storage).toMatchObject({ bytes: 40 * GB, how: 'epic', approximate: true })
  })

  it('asks Epic again a month after it said it had no Windows build', async () => {
    const [, id] = add(steam(77, {}, 'Fennel Quest'), epic('App1', ids(1), 'Fennel Quest'))
    uninstallAll('steam')
    uninstallAll('epic')
    const old = new Date(Date.now() - 31 * DAY).toISOString()
    library.applyMetadata(
      id,
      {
        metadata: {
          storage: {
            bytes: 9 * GB,
            how: 'steam-match',
            steamAppId: 77,
            epicChecked: true,
            checkedAt: old
          }
        }
      },
      { overwrite: true }
    )
    const epicInstallSize = vi.fn<EpicFn>(async () => ({ bytes: 12 * GB, optional: 0 }))
    const svc = createService({ epicInstallSize })
    svc.useEpicAccount(async () => 'token-1')
    await svc.fillStoreSizes()
    expect(epicInstallSize).toHaveBeenCalledTimes(1)
    expect(game(id).metadata.storage).toMatchObject({ bytes: 12 * GB, how: 'epic' })
  })
})

describe('Epic re-checks and outages', () => {
  type EpicFn = NonNullable<InstallSizeOptions['epicInstallSize']>
  const ids = (n: number): ScannedGame['extra'] => ({
    epicAppName: `App${n}`,
    epicNamespace: `ns${n}`,
    epicCatalogItemId: `cat${n}`
  })

  it('a game that has a size keeps it when Epic has none, without asking Steam again', async () => {
    const [, id] = add(steam(77, {}, 'Fennel Quest'), epic('App1', ids(1), 'Fennel Quest'))
    uninstallAll('steam')
    uninstallAll('epic')
    const steamInstallSize = vi.fn<ExactFn>(async () => 9 * GB)
    const first = createService({ steamInstallSize })
    await first.refresh(id)
    await first.dispose()
    expect(game(id).metadata.storage).toMatchObject({ bytes: 9 * GB, how: 'steam-match' })

    // Steam would fail now: the size found before must not be touched.
    const failingSteam = vi.fn<ExactFn>(throws('HTTP 503'))
    const epicInstallSize = vi.fn<EpicFn>(async () => undefined)
    const svc = createService({ epicInstallSize, steamInstallSize: failingSteam })
    svc.useEpicAccount(async () => 'token-1')
    const got = await svc.refresh(id)
    expect(epicInstallSize).toHaveBeenCalledTimes(1)
    expect(failingSteam).not.toHaveBeenCalled()
    expect(got?.metadata.storage).toMatchObject({
      bytes: 9 * GB,
      how: 'steam-match',
      steamAppId: 77,
      epicChecked: true
    })
  })

  it('a silent Epic times out as an Epic failure; the lane goes on and every game gets its size', async () => {
    const scans: ScannedGame[] = []
    for (let n = 1; n <= 6; n++)
      scans.push(steam(100 + n, {}, `Fennel ${n}`), epic(`App${n}`, ids(n), `Fennel ${n}`))
    for (let n = 1; n <= 6; n++) scans.push(steam(500 + n, {}, `Lone ${n}`))
    add(...scans)
    uninstallAll('steam')
    uninstallAll('epic')
    const epicInstallSize = vi.fn<EpicFn>(() => new Promise(() => undefined))
    const steamInstallSize = vi.fn<ExactFn>(async () => 9 * GB)
    const svc = createService({ epicInstallSize, steamInstallSize, epicTimeoutMs: 20 })
    svc.useEpicAccount(async () => 'token-1')
    await svc.fillStoreSizes()
    for (const g of library.games()) expect(g.metadata.storage?.bytes).toBe(9 * GB)
    // Five silent lookups in a row pause Epic (the lane's four workers may have started a few more by then), and
    // the next pass leaves Epic alone.
    const asked = epicInstallSize.mock.calls.length
    expect(asked).toBeGreaterThanOrEqual(5)
    expect(asked).toBeLessThanOrEqual(8)
    await svc.fillStoreSizes()
    expect(epicInstallSize).toHaveBeenCalledTimes(asked)
  })

  it('a refused token that cannot be renewed counts as an Epic failure (backed off)', async () => {
    const [, id] = add(steam(77, {}, 'Fennel Quest'), epic('App1', ids(1), 'Fennel Quest'))
    uninstallAll('steam')
    uninstallAll('epic')
    const epicInstallSize = vi.fn<EpicFn>(async () => {
      throw new HttpError('HTTP 401', { status: 401, url: 'https://x' })
    })
    const token = vi.fn(async (refresh?: boolean) => (refresh ? null : 'old'))
    const steamInstallSize = vi.fn<ExactFn>(async () => 9 * GB)
    const svc = createService({ epicInstallSize, steamInstallSize })
    svc.useEpicAccount(token)
    const got = await svc.refresh(id)
    expect(got?.metadata.storage).toMatchObject({ bytes: 9 * GB, how: 'steam-match' })
    await svc.refresh(id)
    // The refused token is not tried again for that game within the hour.
    expect(epicInstallSize).toHaveBeenCalledTimes(1)
  })
})

describe('games played from their recompilation', () => {
  it("sizes a game whose disc image went for its recompilation by the recompilation's folder", async () => {
    const iso = join(dir, 'roms', 'Game.iso')
    await writeTree(join(dir, 'roms'), { 'Game.iso': 4096 })
    const [id] = add(rom(iso, 'Game'))
    library.setInstallSizes([{ id, size: size(4096, iso, 'file') }])
    library.markRomRemoved(id, 'game-recomp')
    // The disc image's size moved into romRemoved (Restore puts it back); the card has none of its own.
    expect(game(id).installSize).toBeUndefined()
    expect(game(id).romRemoved?.installSize?.bytes).toBe(4096)

    const recompDir = join(dir, 'Recompilations', 'game-recomp')
    await writeTree(recompDir, { 'game.exe': 1000, 'data/assets.pak': 3000 })
    // The harness's quiet store lookups, with a service that knows the recompilation folders.
    await createService().dispose()
    service = createInstallSizeService(
      { library, log, recompDir: async (rid) => (rid === 'game-recomp' ? recompDir : null) },
      lookups
    )
    await service.measure()
    expect(game(id).installSize).toMatchObject({ bytes: 4000, how: 'folder', path: recompDir })

    // Opening its page keeps the measured size (no store lookup for a recompilation).
    await service.refresh(id)
    expect(game(id).installSize?.bytes).toBe(4000)
    expect(lookups.steamDetails).not.toHaveBeenCalled()
  })

  it('measures the folder once (no walk on every pass) and forgets the size when the recompilation is deleted', async () => {
    const iso = join(dir, 'roms', 'Once.iso')
    await writeTree(join(dir, 'roms'), { 'Once.iso': 10 })
    const [id] = add(rom(iso, 'Once'))
    library.markRomRemoved(id, 'once-recomp')
    const recompDir = join(dir, 'Recompilations', 'once-recomp')
    await writeTree(recompDir, { 'game.exe': 500 })
    let installed: string | null = recompDir
    const pathSize = vi.fn<PathFn>(async () => ({ bytes: 500, folder: true }))
    await createService().dispose()
    service = createInstallSizeService(
      { library, log, recompDir: async () => installed },
      { ...lookups, pathSize }
    )
    await service.measure()
    await service.measure()
    expect(pathSize).toHaveBeenCalledTimes(1)
    expect(game(id).installSize?.bytes).toBe(500)

    // The recompilation was deleted: its folder's size goes (the disc image's last size shows again).
    installed = null
    await service.refresh(id)
    expect(game(id).installSize).toBeUndefined()
  })

  it('keeps the size while the recompilations are not loaded yet', async () => {
    const iso = join(dir, 'roms', 'Wait.iso')
    await writeTree(join(dir, 'roms'), { 'Wait.iso': 10 })
    const [id] = add(rom(iso, 'Wait'))
    library.markRomRemoved(id, 'wait-recomp')
    library.setInstallSizes([{ id, size: size(700, join(dir, 'R', 'wait-recomp'), 'folder') }])
    await createService().dispose()
    service = createInstallSizeService({ library, log, recompDir: async () => undefined }, lookups)
    await service.refresh(id)
    expect(game(id).installSize?.bytes).toBe(700)
  })

  it('leaves such a game without a size when its recompilation folder is unknown', async () => {
    const iso = join(dir, 'roms', 'Other.iso')
    await writeTree(join(dir, 'roms'), { 'Other.iso': 10 })
    const [id] = add(rom(iso, 'Other'))
    library.markRomRemoved(id, 'gone')
    await createService().dispose()
    service = createInstallSizeService({ library, log, recompDir: async () => null }, lookups)
    await service.measure()
    expect(game(id).installSize).toBeUndefined()
  })
})
