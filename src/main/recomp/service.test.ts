import type { ChildProcess, SpawnOptions } from 'child_process'
import { EventEmitter } from 'events'
import { promises as fs, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RECOMP_SAVES_FOLDER,
  type GameRecomps,
  type InstalledRecomp,
  type RecompEntry,
  type RecompHeldImage,
  type RecompImageOffer,
  type RecompProgress,
  type RecompRow,
  type RecompTitle
} from '../../shared/recomp'
import type { Game, GameMetadata, PlayOutEventName, PlayOutEvents } from '../../shared/types'
import type { Logger } from '../logger'
import {
  defaultHeldIo,
  HELD_DIR,
  heldPathFor,
  moveAside,
  putBack,
  trashHeld
} from '../services/held-files'
import type { KnownFolders } from '../util/paths'
import type { RecompCatalog } from './catalog'
import { oldCloudSaveDir, readCopyMeta, syncSaves } from './cloud'
import type { ExtractImage, UnpackedGameSetup } from './game-folder'
import { safeRecompFolder, type InstallDeps } from './install'
import type { GhRelease } from './releases'
import {
  createRecompService,
  stubEntry,
  type RecompLibrary,
  type RecompService,
  type RecompServiceDeps
} from './service'
import { createRecompState, defaultCloudState } from './state'
import { titleKeyOf } from './titles'

const log: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

const GAME_NAME = "The Legend of Zelda: Majora's Mask"
const KEY = titleKeyOf('n64', GAME_NAME)
const ZELDA = 'github:zelda64/zelda64recomp'
const OTHER = 'github:someone/mmport'
const SETUP = 'github:setupmaker/setupgame'

function entry(id: string, over: Partial<RecompEntry> = {}): RecompEntry {
  return {
    ...stubEntry(id, null),
    game: GAME_NAME,
    systemId: 'n64',
    console: 'Nintendo 64',
    assetPattern: '*Windows*.zip',
    sources: ['decomp-buddy'],
    ...over
  }
}

function catalogFixture(): RecompCatalog {
  const zelda = entry(ZELDA, {
    name: 'Zelda 64: Recompiled',
    recommended: true,
    exe: 'Zelda64Recompiled.exe',
    needs: [
      {
        id: 'game',
        label: 'Your Majora’s Mask ROM',
        description: '',
        kind: 'game',
        how: 'flag',
        flag: '--rom',
        accepts: 'file',
        formats: ['.z64'],
        optional: false,
        hashes: []
      }
    ]
  })
  const other = entry(OTHER, { name: 'MM Port' })
  const setup = entry(SETUP, {
    name: 'Setup Game',
    game: 'Setup Game',
    systemId: 'pc',
    installer: true,
    assetPattern: '*setup*.msi'
  })
  const titles = new Map<string, RecompTitle>([
    [
      KEY,
      {
        key: KEY,
        game: GAME_NAME,
        systemId: 'n64',
        console: 'Nintendo 64',
        entries: [ZELDA, OTHER]
      }
    ],
    [
      titleKeyOf('pc', 'Setup Game'),
      {
        key: titleKeyOf('pc', 'Setup Game'),
        game: 'Setup Game',
        systemId: 'pc',
        console: 'PC',
        entries: [SETUP]
      }
    ]
  ])
  return {
    entries: new Map([
      [ZELDA, zelda],
      [OTHER, other],
      [SETUP, setup]
    ]),
    titles,
    byRepo: new Map(),
    fetchedAt: { 'decomp-buddy': '2026-11-01T00:00:00.000Z', recomplauncher: null },
    offline: ['recomplauncher']
  }
}

function release(tag: string, date: string, asset = 'Zelda64Recompiled-Windows.zip'): GhRelease {
  return {
    tag_name: tag,
    name: tag,
    published_at: date,
    prerelease: false,
    draft: false,
    body: `Notes for ${tag}`,
    html_url: `https://github.com/zelda64/zelda64recomp/releases/tag/${tag}`,
    assets: [
      {
        name: asset,
        size: 1000,
        browser_download_url: `https://github.com/x/${asset}`,
        digest: null
      }
    ]
  }
}

function makeGame(over: Partial<Game> = {}): Game {
  return {
    id: 'rom:n64:mm',
    source: 'rom',
    externalId: 'mm',
    platformId: 'n64',
    title: GAME_NAME,
    sortTitle: 'legend of zelda',
    installed: true,
    launch: { kind: 'none' } as never,
    tracking: { mode: 'none' },
    hidden: false,
    favorite: false,
    playtimeMinutes: 0,
    playCount: 0,
    addedAt: '',
    metadata: {},
    media: {},
    metadataStatus: 'done',
    user: {},
    ...over
  } as Game
}

function fakeLibrary(games: Game[]): RecompLibrary {
  const byId = new Map(games.map((g) => [g.id, g]))
  return {
    games: () => [...byId.values()],
    getGame: (id: string) => byId.get(id),
    applyMetadata: ((id: string, update: { metadata?: Partial<GameMetadata> }) => {
      const g = byId.get(id)!
      g.metadata = { ...g.metadata, ...update.metadata }
      return g
    }) as RecompLibrary['applyMetadata'],
    clearMetadataField: ((id: string, key: keyof GameMetadata) => {
      const g = byId.get(id)
      if (!g || g.metadata[key] === undefined) return false
      const next = { ...g.metadata }
      delete next[key]
      g.metadata = next
      return true
    }) as RecompLibrary['clearMetadataField']
  }
}

class FakeChild extends EventEmitter {
  pid = 4242
  /** The service was told that it started (a test lets it exit only after that, as a real program would). */
  started = false
  unref(): this {
    return this
  }
}

interface Harness {
  service: RecompService
  root: string
  game: Game
  events: { name: PlayOutEventName; payload: unknown }[]
  spawned: { file: string; args: string[]; options: SpawnOptions; child: FakeChild }[]
  tracked: { game: Game; child: ChildProcess }[]
  installs: { id: string; tag: string; previous: InstalledRecomp | null }[]
  uninstalls: string[]
  folders: KnownFolders
  rom: string
  progress(): RecompProgress[]
}

let tmp: string
let services: RecompService[] = []
/** The Emulation folder the services use (a test may move it, as Settings › Library would). */
let emu: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(join(tmpdir(), 'playout-recomp-service-'))
  emu = join(tmp, 'Emulation')
  await fs.mkdir(emu, { recursive: true })
})

/** Where the service keeps the copy of Zelda's saves in the Emulation folder. */
const zeldaCopy = (dir = emu): string =>
  join(dir, RECOMP_SAVES_FOLDER, safeRecompFolder({ id: ZELDA, name: 'Zelda 64: Recompiled' }))

afterEach(async () => {
  for (const s of services) s.dispose()
  services = []
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 })
})

async function harness(
  opts: {
    game?: Partial<Game>
    releases?: GhRelease[]
    over?: Partial<RecompServiceDeps>
    /** Awaited by the fake install before it does anything (to change settings mid-install). */
    installGate?: () => Promise<void>
    /** More programs a release ships next to Zelda64Recompiled.exe (relative paths), by tag. */
    shipped?: (tag: string) => string[]
  } = {}
): Promise<Harness> {
  const root = join(tmp, 'Recompilations')
  const profile = join(tmp, 'profile')
  const folders: KnownFolders = {
    userProfile: profile,
    appData: join(profile, 'AppData', 'Roaming'),
    localAppData: join(profile, 'AppData', 'Local'),
    programData: join(tmp, 'ProgramData'),
    programFiles: join(tmp, 'Program Files'),
    programFilesX86: join(tmp, 'Program Files (x86)'),
    publicDir: join(tmp, 'Public'),
    systemDrive: 'C:'
  }
  for (const d of [folders.appData, folders.localAppData]) await fs.mkdir(d, { recursive: true })
  const rom = join(tmp, 'roms', 'mm.z64')
  await fs.mkdir(join(tmp, 'roms'), { recursive: true })
  await fs.writeFile(rom, 'rom data')
  const game = makeGame({ romPath: rom, ...opts.game })
  const events: Harness['events'] = []
  const spawned: Harness['spawned'] = []
  const tracked: Harness['tracked'] = []
  const installs: Harness['installs'] = []
  const uninstalls: string[] = []
  const releases = opts.releases ?? [
    release('v2.0.0', '2026-10-01T00:00:00Z'),
    release('v1.0.0', '2026-01-01T00:00:00Z')
  ]
  const service = createRecompService({
    userData: join(tmp, 'userData'),
    exeDir: tmp,
    root,
    library: fakeLibrary([game]),
    launcher: { track: (g, child) => void tracked.push({ game: g, child }), running: () => null },
    events: {
      emit: <E extends PlayOutEventName>(name: E, payload: PlayOutEvents[E]) =>
        void events.push({ name, payload })
    },
    dialog: { chooseFile: async () => null, chooseFolder: async () => null },
    openPath: async () => {},
    log,
    fetch: (() => Promise.reject(new Error('no network in tests'))) as typeof fetch,
    loadCatalog: async () => catalogFixture(),
    fetchReleases: async () => releases,
    fetchReadme: async () => '# Readme',
    install: async (
      e: RecompEntry,
      r: GhRelease,
      previous: InstalledRecomp | null,
      d: InstallDeps
    ) => {
      installs.push({ id: e.id, tag: r.tag_name, previous })
      await opts.installGate?.()
      const dir = previous?.dir ?? join(d.root, e.name.replace(/[^\w ]+/g, ''))
      await fs.mkdir(dir, { recursive: true })
      const asset = r.assets[0]!.name
      const exe = e.installer ? asset : 'Zelda64Recompiled.exe'
      await fs.writeFile(join(dir, exe), 'MZ')
      const extra = e.installer ? [] : (opts.shipped?.(r.tag_name) ?? [])
      for (const f of extra) {
        await fs.mkdir(dirname(join(dir, f)), { recursive: true })
        await fs.writeFile(join(dir, f), 'MZ')
      }
      d.onProgress({
        id: e.id,
        phase: 'done',
        progress: 1,
        bytes: 1000,
        total: 1000,
        message: null,
        warning: null
      })
      const at = new Date().toISOString()
      return {
        id: e.id,
        dir,
        tag: r.tag_name,
        asset,
        downloadBytes: 1000,
        diskBytes: 2000,
        sha256: 'ab'.repeat(32),
        verified: 'unverified',
        exe,
        installedAt: previous?.installedAt ?? at,
        updatedAt: at,
        releaseFiles: [exe, ...extra].map((f) => f.split('\\').join('/').toLowerCase()),
        autoUpdate: previous?.autoUpdate ?? false,
        gameFiles: previous?.gameFiles ?? {},
        savePaths: previous?.savePaths ?? [],
        saveSource: previous?.saveSource ?? null,
        cloud: previous?.cloud ?? defaultCloudState(),
        prevTag: previous?.tag ?? null
      }
    },
    uninstall: async (installed) => {
      uninstalls.push(installed.id)
      await fs.rm(installed.dir, { recursive: true, force: true })
    },
    spawn: (file, args, options) => {
      const child = new FakeChild()
      spawned.push({ file, args, options, child })
      setImmediate(() => {
        child.emit('spawn')
        // One turn of the event loop later: the service has noted the start by then (it does that right after).
        setImmediate(() => (child.started = true))
      })
      return child as unknown as ChildProcess
    },
    knownFolders: () => folders,
    documents: join(profile, 'Documents'),
    emulationDir: () => emu,
    machine: 'TEST-PC',
    sessionPollMs: 5,
    startDelayMs: 60_000,
    ...opts.over
  })
  services.push(service)
  return {
    service,
    root,
    game,
    events,
    spawned,
    tracked,
    installs,
    uninstalls,
    folders,
    rom,
    progress: () =>
      events.filter((e) => e.name === 'recomp:progress').map((e) => e.payload as RecompProgress)
  }
}

/**
 * The longest a wait for something the service does may take. vi.waitFor gives up after 1 s by default, which a few
 * file writes exceed on a loaded PC (the whole suite runs in parallel); a wait whose condition holds returns at
 * once, so the bound costs a passing test nothing. Below the 20 s test timeout, so a wait that fails reports its
 * own assertion.
 */
const WAIT_MS = 15_000

/** Wait until `check` stops throwing (what the service does in the background), for at most WAIT_MS. */
function until<T>(check: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(check, { timeout: WAIT_MS })
}

/**
 * Wait until the install (update, version switch) of `id` asked for after the first `from` events has finished:
 * the service reports 'done' once the record is stored and the library matched again ('failed' when it gave up),
 * and 'recomp:changed' for it follows as the last thing the install does.
 */
async function installFinished(h: Harness, id: string, from: number): Promise<void> {
  await until(() => {
    const events = h.events.slice(from)
    const end = events.findIndex((e) => {
      if (e.name !== 'recomp:progress') return false
      const p = e.payload as RecompProgress
      return p.id === id && (p.phase === 'done' || p.phase === 'failed')
    })
    expect(end, `the install of ${id} has ended`).toBeGreaterThanOrEqual(0)
    const told = events
      .slice(end + 1)
      .some((e) => e.name === 'recomp:changed' && (e.payload as { ids: string[] }).ids.includes(id))
    expect(told, `recomp:changed for ${id} after its install`).toBe(true)
  })
}

/**
 * The `count`-th program the service started, once the service knows it runs. A test that makes it exit must wait
 * for this, not just for the spawn call: an 'exit' sent before the service listens for it is lost, and the test
 * then waits for a verdict that never comes (seen on a loaded PC, where the test's poll can run in between).
 */
function started(h: Pick<Harness, 'spawned'>, count: number): Promise<FakeChild> {
  return until(() => {
    const child = h.spawned[count - 1]?.child
    expect(child?.started, `program ${count} has started`).toBe(true)
    return child!
  })
}

async function installAndWait(h: Harness, id: string, tag?: string): Promise<void> {
  const from = h.events.length
  await h.service.installRecomp(id, tag)
  await installFinished(h, id, from)
}

describe('recomp service: catalog and matching', () => {
  it("matches a game not in the library (a host's) with the catalogs, once they are loaded", async () => {
    const h = await harness()
    const hostOnly = makeGame({ id: 'remote:host-1:rom:n64:x', romPath: undefined })
    expect(h.service.recompForGame(hostOnly)).toBeUndefined()
    await h.service.refreshRecompCatalog()
    expect(h.service.recompForGame(hostOnly)).toMatchObject({ titleKey: KEY, count: 2 })
    expect(
      h.service.recompForGame(makeGame({ title: 'Not A Recompiled Game', romPath: undefined }))
    ).toBeNull()
  })

  it('matches the library to the catalog and writes metadata.recomp', async () => {
    const h = await harness()
    const status = await h.service.refreshRecompCatalog()
    expect(status).toMatchObject({
      entries: 3,
      titles: 2,
      matchedGames: 1,
      offline: ['recomplauncher']
    })
    expect(h.game.metadata.recomp).toMatchObject({
      titleKey: KEY,
      count: 2,
      installed: [],
      preferred: ZELDA
    })
    expect(h.events.some((e) => e.name === 'library:changed')).toBe(true)
  })

  it('skips games streamed from another PC', async () => {
    const h = await harness({ game: { remote: { hostId: 'h' } as never } })
    await h.service.refreshRecompCatalog()
    expect(h.game.metadata.recomp).toBeUndefined()
  })

  it('lists the game recomps with library files picked for the game need', async () => {
    const h = await harness()
    const view = await h.service.getGameRecomps(h.game.id)
    expect(view?.entries.map((e) => e.id)).toEqual([ZELDA, OTHER])
    expect(view?.preferred).toBe(ZELDA)
    expect(view?.libraryFiles).toEqual([h.rom])
    expect(view?.gameFiles[ZELDA]?.[0]).toMatchObject({
      id: 'game',
      path: h.rom,
      source: 'library',
      ready: true
    })
  })

  it('returns null for a game without recompilations', async () => {
    const h = await harness({ game: { title: 'Some Other Game' } })
    expect(await h.service.getGameRecomps(h.game.id)).toBeNull()
  })

  it('remembers the preferred version per title', async () => {
    const h = await harness()
    await h.service.setPreferredRecomp(h.game.id, OTHER)
    expect(h.game.metadata.recomp?.preferred).toBe(OTHER)
    await expect(h.service.setPreferredRecomp(h.game.id, SETUP)).rejects.toThrow(
      /not a recompilation/
    )
  })
})

describe('recomp service: installs and updates', () => {
  it('installs the newest release, saves the record and marks the game', async () => {
    const h = await harness()
    await installAndWait(h, ZELDA)
    expect(h.installs).toEqual([{ id: ZELDA, tag: 'v2.0.0', previous: null }])
    const view = await h.service.getGameRecomps(h.game.id)
    expect(view?.installed[ZELDA]?.tag).toBe('v2.0.0')
    expect(h.game.metadata.recomp?.installed).toEqual([ZELDA])
    const settings = await h.service.getRecompSettings()
    expect(settings.root).toBe(h.root)
    expect(settings.rows.map((r) => [r.entry.id, r.gameIds, r.alternatives])).toEqual([
      [ZELDA, [h.game.id], [{ id: OTHER, name: 'MM Port', installed: false }]]
    ])
  })

  it('installs a chosen release, then finds and applies the update', async () => {
    const h = await harness()
    await installAndWait(h, ZELDA, 'v1.0.0')
    expect(h.installs[0]?.tag).toBe('v1.0.0')
    expect(await h.service.checkRecompUpdates()).toEqual({ [ZELDA]: 'v2.0.0' })
    expect((await h.service.getRecompSettings()).rows[0]?.update).toBe('v2.0.0')
    await h.service.updateAllRecomps()
    await until(() => expect(h.installs).toHaveLength(2))
    await until(async () =>
      expect((await h.service.getRecompSettings()).rows[0]?.installed.tag).toBe('v2.0.0')
    )
    expect(h.installs[1]?.previous?.tag).toBe('v1.0.0')
    expect(await h.service.checkRecompUpdates()).toEqual({})
  })

  it('updates a rolling tag published again with another build', async () => {
    const releases = [release('nightly', '2026-10-01T00:00:00Z')]
    const h = await harness({ releases })
    await installAndWait(h, ZELDA)
    expect(await h.service.checkRecompUpdates()).toEqual({})
    // The same tag, deleted and created again: another file under the same name.
    releases[0] = {
      ...release('nightly', '2026-11-01T00:00:00Z'),
      assets: [{ ...release('nightly', '').assets[0]!, size: 2000 }]
    }
    expect(await h.service.checkRecompUpdates()).toEqual({ [ZELDA]: 'nightly' })
    await h.service.updateAllRecomps()
    await until(() => expect(h.installs).toHaveLength(2))
    expect(h.installs[1]).toMatchObject({ tag: 'nightly', previous: { tag: 'nightly' } })
  })

  it('reports a release that does not exist as a failed install', async () => {
    const h = await harness()
    await installAndWait(h, ZELDA, 'v9')
    expect(h.progress().pop()).toMatchObject({ id: ZELDA, phase: 'failed' })
    expect(h.installs).toHaveLength(0)
  })

  it('refuses a second install of the same recompilation while one is queued', async () => {
    const h = await harness()
    await h.service.installRecomp(ZELDA)
    await expect(h.service.installRecomp(ZELDA)).rejects.toThrow(/already installing/)
  })

  it('uninstalls and unmarks the game', async () => {
    const h = await harness()
    await installAndWait(h, ZELDA)
    await h.service.uninstallRecomp(ZELDA)
    expect(h.uninstalls).toEqual([ZELDA])
    expect(h.game.metadata.recomp?.installed).toEqual([])
    expect((await h.service.getRecompSettings()).rows).toEqual([])
  })

  it('maps releases for the Updates list', async () => {
    const h = await harness()
    const list = await h.service.getRecompReleases(ZELDA)
    expect(list.map((r) => [r.tag, r.asset?.name])).toEqual([
      ['v2.0.0', 'Zelda64Recompiled-Windows.zip'],
      ['v1.0.0', 'Zelda64Recompiled-Windows.zip']
    ])
    // Main marks the newest and which choices pin, so the screens label and warn as it acts.
    expect(list.map((r) => [r.tag, r.newest, r.pins])).toEqual([
      ['v2.0.0', true, false],
      ['v1.0.0', false, true]
    ])
    expect(await h.service.getRecompReadme(ZELDA)).toBe('# Readme')
  })
})

describe('recomp service: launch', () => {
  it('says the recompilation is not installed', async () => {
    const h = await harness()
    expect(await h.service.launchRecomp(h.game.id)).toMatchObject({
      ok: false,
      reason: 'not-installed'
    })
  })

  it('asks for game files when the library has none', async () => {
    const h = await harness({ game: { romPath: undefined } })
    await installAndWait(h, ZELDA)
    const result = await h.service.launchRecomp(h.game.id)
    expect(result).toMatchObject({ ok: false, reason: 'needs-files' })
    if (!result.ok && result.reason === 'needs-files')
      expect(result.needs[0]).toMatchObject({ id: 'game', ready: false })
    expect(h.spawned).toHaveLength(0)
  })

  it('starts the program detached in its folder with the ROM, tracks it and detects saves after', async () => {
    const h = await harness()
    await installAndWait(h, ZELDA)
    const result = await h.service.launchRecomp(h.game.id)
    expect(result).toEqual({ ok: true })
    const [run] = h.spawned
    const dir = (await h.service.getRecompSettings()).rows[0]!.installed.dir
    expect(run?.file).toBe(join(dir, 'Zelda64Recompiled.exe'))
    expect(run?.args).toEqual(['--rom', h.rom])
    expect(run?.options).toMatchObject({ cwd: dir, detached: true, stdio: 'ignore' })
    expect(h.tracked[0]?.game.id).toBe(h.game.id)
    // The library ROM is remembered as the game file.
    expect((await h.service.getRecompSettings()).rows[0]?.installed.gameFiles).toEqual({
      game: { path: h.rom, source: 'library' }
    })
    // A second start while it runs is refused.
    expect(await h.service.launchRecomp(h.game.id)).toMatchObject({ ok: false, reason: 'running' })
    // The game writes a save, then exits: the folder becomes the save folder.
    await fs.mkdir(join(dir, 'saves'), { recursive: true })
    await fs.writeFile(join(dir, 'saves', 'mm.sav'), 'save 1')
    run!.child.emit('exit', 0)
    await until(async () => {
      const row = (await h.service.getRecompSettings()).rows[0]!
      expect(row.installed.saveSource).toBe('detected')
      expect(row.resolvedSavePaths).toEqual([join(dir, 'saves')])
    })
  })

  // A program that closes right away (it cannot find its game, a launcher that hands over) may do so while PlayOut
  // is still noting the start: it must still be seen closing. 'event': its 'exit' comes while the start is noted (the
  // launcher is told about it between the two state writes). 'code': it had exited before anyone could listen (its
  // exit code is set and no 'exit' follows).
  it.each(['event', 'code'] as const)(
    'sees a program that closed while its start was still being noted (%s)',
    async (how) => {
      let dir = ''
      let early = true
      /** The game writes a save and closes: once, for the first program started. */
      const close = (child: EventEmitter): void => {
        if (!early) return
        early = false
        mkdirSync(join(dir, 'saves'), { recursive: true })
        writeFileSync(join(dir, 'saves', 'mm.sav'), 'save 1')
        if (how === 'event') child.emit('exit', 0)
        else Object.assign(child, { exitCode: 0 })
      }
      const tracked: ChildProcess[] = []
      const spawned: ChildProcess[] = []
      const h = await harness({
        over: {
          launcher: {
            track: (_game, child) => {
              tracked.push(child)
              if (how === 'event') close(child)
            },
            running: () => null
          },
          spawn: () => {
            const child = new FakeChild()
            spawned.push(child as unknown as ChildProcess)
            setImmediate(() => {
              if (how === 'code') close(child)
              child.emit('spawn')
            })
            return child as unknown as ChildProcess
          }
        }
      })
      await installAndWait(h, ZELDA)
      dir = (await h.service.getRecompSettings()).rows[0]!.installed.dir
      expect(await h.service.launchRecomp(h.game.id)).toEqual({ ok: true })
      expect(tracked).toEqual([spawned[0]])
      // The after-play work ran: the save folder was found and copied to the Emulation folder.
      await until(async () => {
        const row = (await h.service.getRecompSettings()).rows[0]!
        expect(row.installed.saveSource).toBe('detected')
        expect(row.resolvedSavePaths).toEqual([join(dir, 'saves')])
        expect(row.installed.cloud.syncedHash).toBeTruthy()
      })
      expect(await fs.readFile(join(zeldaCopy(), 'current', '0', 'mm.sav'), 'utf8')).toBe('save 1')
      // And it no longer counts as running: it starts again (and that one does run: an update is refused).
      expect(await h.service.launchRecomp(h.game.id)).toEqual({ ok: true })
      expect(spawned).toHaveLength(2)
      await expect(h.service.updateRecomp(ZELDA)).rejects.toThrow(/running/)
    }
  )

  it('copies the saves to the Emulation folder after play, on by default', async () => {
    const h = await harness()
    await installAndWait(h, ZELDA)
    let row = (await h.service.getRecompSettings()).rows[0]!
    expect(row.installed.cloud.enabled).toBe(true)
    expect(row.savesDir).toBe(zeldaCopy())
    expect((await h.service.getRecompSettings()).savesDir).toBe(join(emu, RECOMP_SAVES_FOLDER))
    expect(await h.service.launchRecomp(h.game.id)).toEqual({ ok: true })
    await fs.mkdir(join(row.installed.dir, 'saves'), { recursive: true })
    await fs.writeFile(join(row.installed.dir, 'saves', 'mm.sav'), 'save 1')
    h.spawned[0]!.child.emit('exit', 0)
    await until(async () => expect(await readCopyMeta(zeldaCopy())).not.toBeNull())
    await until(async () => {
      row = (await h.service.getRecompSettings()).rows[0]!
      expect(row.installed.cloud.syncedHash).toBeTruthy()
    })
    expect((await readCopyMeta(zeldaCopy()))?.machine).toBe('TEST-PC')
    expect(await fs.readFile(join(zeldaCopy(), 'current', '0', 'mm.sav'), 'utf8')).toBe('save 1')
    // Manual sync with nothing changed: still in step.
    const state = await h.service.syncRecompSaves(ZELDA)
    expect(state).toMatchObject({ pending: false, error: null, conflict: null })
  })

  it('asks before copying back saves deleted from this PC, and restores them when told to', async () => {
    const h = await harness()
    await installAndWait(h, ZELDA)
    let row = (await h.service.getRecompSettings()).rows[0]!
    expect(await h.service.launchRecomp(h.game.id)).toEqual({ ok: true })
    await fs.mkdir(join(row.installed.dir, 'saves'), { recursive: true })
    await fs.writeFile(join(row.installed.dir, 'saves', 'mm.sav'), 'save 1')
    h.spawned[0]!.child.emit('exit', 0)
    await until(async () => {
      row = (await h.service.getRecompSettings()).rows[0]!
      expect(row.installed.cloud.syncedHash).toBeTruthy()
    })
    await fs.rm(join(row.installed.dir, 'saves', 'mm.sav'))
    const refused = await h.service.launchRecomp(h.game.id)
    expect(refused).toMatchObject({ ok: false, reason: 'save-conflict', conflict: { gone: true } })
    expect(h.spawned).toHaveLength(1)
    await expect(fs.access(join(row.installed.dir, 'saves', 'mm.sav'))).rejects.toThrow()
    // Asked again (stored) until answered.
    expect(await h.service.launchRecomp(h.game.id)).toMatchObject({ reason: 'save-conflict' })
    const restored = await h.service.resolveRecompConflict(ZELDA, 'cloud')
    expect(restored).toMatchObject({ conflict: null, error: null })
    expect(await fs.readFile(join(row.installed.dir, 'saves', 'mm.sav'), 'utf8')).toBe('save 1')
    expect(await h.service.launchRecomp(h.game.id)).toEqual({ ok: true })
  })

  it('stops for a save conflict that is waiting on the user', async () => {
    const root = join(tmp, 'Recompilations')
    const dir = join(root, 'Zelda')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'Zelda64Recompiled.exe'), 'MZ')
    const conflict = {
      localAt: '2026-11-01T00:00:00Z',
      cloudAt: '2026-11-02T00:00:00Z',
      cloudDevice: 'LAPTOP'
    }
    await createRecompState(root).update((m) => {
      m.savesMigrated = true
      m.savesRoot = emu
      m.installed[ZELDA] = {
        id: ZELDA,
        dir,
        tag: 'v2.0.0',
        asset: 'Zelda64Recompiled-Windows.zip',
        downloadBytes: 1,
        diskBytes: 1,
        sha256: '',
        verified: 'github',
        exe: 'Zelda64Recompiled.exe',
        installedAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        releaseFiles: ['zelda64recompiled.exe'],
        autoUpdate: false,
        gameFiles: {},
        savePaths: [],
        saveSource: null,
        cloud: { ...defaultCloudState(), enabled: true, conflict },
        prevTag: null
      }
    })
    const h = await harness()
    expect(await h.service.launchRecomp(h.game.id)).toEqual({
      ok: false,
      reason: 'save-conflict',
      conflict
    })
    expect(h.spawned).toHaveLength(0)
  })

  it('runs the setup program of an installer-type recompilation instead of tracking it', async () => {
    const h = await harness({
      game: {
        id: 'manual:setup',
        source: 'manual',
        platformId: 'pc',
        title: 'Setup Game',
        romPath: undefined
      },
      releases: [release('v1', '2026-01-01T00:00:00Z', 'game-setup.msi')]
    })
    await installAndWait(h, SETUP)
    expect(await h.service.launchRecomp(h.game.id)).toEqual({ ok: true })
    expect(h.spawned[0]?.file).toBe('msiexec.exe')
    expect(h.spawned[0]?.args[0]).toBe('/i')
    expect(h.tracked).toHaveLength(0)
  })

  describe('a setup program that takes the game unpacked', () => {
    const SETUP_GAME: UnpackedGameSetup = {
      recompId: SETUP.toUpperCase(),
      game: 'Setup Game',
      platform: 'xbox360',
      homeRelative: ['Games', 'Setup Game', 'game'],
      marker: 'default.xex'
    }
    const home = (): string => join(tmp, 'home')
    const gameDir = (): string => join(home(), 'Games', 'Setup Game', 'game')

    async function setupHarness(extract: ExtractImage, game: Partial<Game> = {}): Promise<Harness> {
      const image = join(tmp, 'roms', 'Setup Game.xiso.iso')
      await fs.mkdir(join(tmp, 'roms'), { recursive: true })
      await fs.writeFile(image, 'xiso')
      const h = await harness({
        game: {
          id: 'rom:xbox360:setup',
          source: 'rom',
          platformId: 'xbox360',
          title: 'Setup Game',
          romPath: image,
          ...game
        },
        releases: [release('v1', '2026-01-01T00:00:00Z', 'game-setup.msi')],
        over: {
          homedir: home,
          extractXboxImage: extract,
          unpackedGameSetups: [SETUP_GAME]
        }
      })
      await installAndWait(h, SETUP)
      return h
    }

    it('unpacks the library image where the setup reads it, then runs the setup', async () => {
      const calls: string[][] = []
      const h = await setupHarness(async (image, outDir, onPercent) => {
        calls.push([image, outDir])
        onPercent(50)
        await fs.mkdir(outDir, { recursive: true })
        await fs.writeFile(join(outDir, 'default.xex'), 'xex')
      })
      expect(await h.service.launchRecomp(h.game.id, SETUP)).toEqual({ ok: true })
      expect(calls).toEqual([[h.game.romPath, gameDir()]])
      expect(h.spawned[0]?.file).toBe('msiexec.exe')
      const mine = h.progress().filter((p) => p.id === SETUP)
      expect(mine.some((p) => p.phase === 'extracting' && p.progress === 0.5)).toBe(true)
      expect(mine.at(-1)?.phase).toBe('done')
    })

    it('does nothing more when the game is already unpacked', async () => {
      let called = false
      const h = await setupHarness(async () => {
        called = true
      })
      await fs.mkdir(gameDir(), { recursive: true })
      await fs.writeFile(join(gameDir(), 'default.xex'), 'xex')
      expect(await h.service.launchRecomp(h.game.id, SETUP)).toEqual({ ok: true })
      expect(called).toBe(false)
      expect(h.spawned).toHaveLength(1)
    })

    it('still runs the setup, with a warning, when the image cannot be unpacked', async () => {
      const h = await setupHarness(async () => {
        throw new Error('damaged image')
      })
      const result = await h.service.launchRecomp(h.game.id, SETUP)
      expect(result.ok).toBe(true)
      expect(result.ok && result.warning).toMatch(
        /could not unpack your Setup Game disc.*damaged image/
      )
      expect(h.spawned).toHaveLength(1)
    })

    it('runs the setup as before when the library has no image of the game', async () => {
      let called = false
      const h = await setupHarness(
        async () => {
          called = true
        },
        { id: 'manual:setup', source: 'manual', platformId: 'pc', romPath: undefined }
      )
      expect(await h.service.launchRecomp(h.game.id, SETUP)).toEqual({ ok: true })
      expect(called).toBe(false)
      expect(h.spawned).toHaveLength(1)
      expect(h.progress().filter((p) => p.phase === 'extracting')).toHaveLength(0)
    })

    it('does not start the setup when PlayOut closes during the unpack, and removes the partial folder', async () => {
      let started!: () => void
      const running = new Promise<void>((r) => (started = r))
      const h = await setupHarness(async (_image, outDir, _onPercent, signal) => {
        await fs.mkdir(`${outDir}.playout-partial`, { recursive: true })
        started()
        await new Promise<void>((_r, reject) =>
          signal.addEventListener('abort', () => reject(new Error('stopped')))
        )
      })
      const launching = h.service.launchRecomp(h.game.id, SETUP)
      await running
      h.service.dispose()
      expect(await launching).toMatchObject({ ok: false, reason: 'failed' })
      expect(h.spawned).toHaveLength(0)
      await expect(fs.stat(`${gameDir()}.playout-partial`)).rejects.toThrow()
    })

    it('says the game is being prepared, not installed, on a second start during the unpack', async () => {
      let started!: () => void
      let finish!: () => void
      const running = new Promise<void>((r) => (started = r))
      const done = new Promise<void>((r) => (finish = r))
      const h = await setupHarness(async (_image, outDir) => {
        started()
        await done
        await fs.mkdir(outDir, { recursive: true })
        await fs.writeFile(join(outDir, 'default.xex'), 'xex')
      })
      const first = h.service.launchRecomp(h.game.id, SETUP)
      await running
      const second = await h.service.launchRecomp(h.game.id, SETUP)
      expect(second).toMatchObject({ ok: false, reason: 'running' })
      const text = 'message' in second ? second.message : ''
      expect(text).toMatch(/already starting/)
      expect(text).not.toMatch(/installing or updating/)
      finish()
      expect(await first).toEqual({ ok: true })
      expect(h.spawned).toHaveLength(1)
    })

    it("keeps the install's last report (and its warning) after the unpack", async () => {
      const h = await setupHarness(async (_image, outDir, onPercent) => {
        onPercent(10)
        await fs.mkdir(outDir, { recursive: true })
        await fs.writeFile(join(outDir, 'default.xex'), 'xex')
      })
      const before = h
        .progress()
        .filter((p) => p.id === SETUP)
        .at(-1)
      expect(before).toBeDefined()
      const count = h.progress().length
      await h.service.launchRecomp(h.game.id, SETUP)
      const mine = h
        .progress()
        .slice(count)
        .filter((p) => p.id === SETUP)
      expect(
        mine.filter((p) => p.phase === 'extracting').every((p) => p.warning === before!.warning)
      ).toBe(true)
      expect(mine.at(-1)).toEqual(before)
    })
  })
})

describe('recomp service: the program it starts', () => {
  const dirOf = async (h: Harness, id = ZELDA): Promise<string> =>
    (await h.service.getRecompSettings()).rows.find((r) => r.entry.id === id)!.installed.dir
  const writeExe = async (path: string): Promise<string> => {
    await fs.mkdir(join(path, '..'), { recursive: true })
    await fs.writeFile(path, 'MZ')
    return path
  }

  it('lists the programs and starts one chosen in the folder, in its own folder', async () => {
    const h = await harness()
    await installAndWait(h, ZELDA)
    const dir = await dirOf(h)
    await writeExe(join(dir, 'bin', 'Other.exe'))
    await writeExe(join(dir, 'unins000.exe'))
    const before = await h.service.listRecompExecutables(ZELDA)
    expect(before).toMatchObject({ current: 'Zelda64Recompiled.exe', source: 'auto' })
    expect(before.candidates.map((c) => [c.path, c.note])).toEqual([
      ['Zelda64Recompiled.exe', null],
      [join('bin', 'Other.exe'), null],
      ['unins000.exe', 'Uninstaller']
    ])
    const view = await h.service.setRecompExecutable(ZELDA, join('bin', 'Other.exe'))
    expect(view).toMatchObject({
      current: join('bin', 'Other.exe'),
      source: 'user',
      auto: 'Zelda64Recompiled.exe',
      outside: false
    })
    expect(h.events.at(-1)).toEqual({ name: 'recomp:changed', payload: { ids: [ZELDA] } })
    expect(await h.service.launchRecomp(h.game.id, ZELDA)).toEqual({ ok: true })
    expect(h.spawned[0]?.file).toBe(join(dir, 'bin', 'Other.exe'))
    expect(h.spawned[0]?.args).toEqual(['--rom', h.rom])
    // A program in a subfolder still runs in the install folder (game files are placed relative to it).
    expect(h.spawned[0]?.options.cwd).toBe(dir)
    expect(h.tracked).toHaveLength(1)
  })

  it('opens the folder of the program in use, and finds a folder renamed by hand', async () => {
    const opened: string[] = []
    const h = await harness({ over: { openPath: async (p) => void opened.push(p) } })
    await installAndWait(h, ZELDA)
    const dir = await dirOf(h)
    await h.service.openRecompFolder(ZELDA, 'install')
    expect(opened.at(-1)).toBe(dir)
    await writeExe(join(dir, 'bin', 'Other.exe'))
    await h.service.setRecompExecutable(ZELDA, join('bin', 'Other.exe'))
    await h.service.openRecompFolder(ZELDA, 'install')
    expect(opened.at(-1)).toBe(join(dir, 'bin'))
    // Renamed by hand: the record follows it (the folder holding its program) and the program's folder opens.
    const renamed = join(dirname(dir), 'Renamed by hand')
    await fs.rename(dir, renamed)
    await h.service.openRecompFolder(ZELDA, 'install')
    expect(opened.at(-1)).toBe(join(renamed, 'bin'))
  })

  it('starts a program chosen outside the folder, and refuses one that went', async () => {
    const h = await harness()
    await installAndWait(h, ZELDA)
    const outside = await writeExe(join(tmp, 'Games', 'MM', 'MM.exe'))
    expect(await h.service.setRecompExecutable(ZELDA, outside)).toMatchObject({
      current: outside,
      outside: true,
      source: 'user'
    })
    expect(await h.service.launchRecomp(h.game.id, ZELDA)).toEqual({ ok: true })
    expect(h.spawned[0]?.file).toBe(outside)
    expect(h.spawned[0]?.options.cwd).toBe(join(tmp, 'Games', 'MM'))
    await fs.rm(outside)
    h.spawned[0]!.child.emit('exit', 0)
    await until(async () => {
      const result = await h.service.launchRecomp(h.game.id, ZELDA)
      expect(result).toMatchObject({ ok: false, reason: 'failed' })
      if (!result.ok && result.reason === 'failed')
        expect(result.message).toContain('no longer there')
    })
    expect(h.spawned).toHaveLength(1)
  })

  it('refuses what is not an existing program and keeps the choice as it was', async () => {
    const h = await harness()
    await installAndWait(h, ZELDA)
    const dir = await dirOf(h)
    await fs.writeFile(join(dir, 'readme.txt'), 'x')
    await writeExe(join(tmp, 'Elsewhere.exe'))
    await expect(h.service.setRecompExecutable(ZELDA, join(dir, 'readme.txt'))).rejects.toThrow(
      'not a program'
    )
    await expect(h.service.setRecompExecutable(ZELDA, join(dir, 'Gone.exe'))).rejects.toThrow(
      'was not found'
    )
    await expect(
      h.service.setRecompExecutable(ZELDA, join('..', '..', 'Elsewhere.exe'))
    ).rejects.toThrow("not in the recompilation's folder")
    await expect(h.service.setRecompExecutable(OTHER, join(dir, 'x.exe'))).rejects.toThrow(
      'not installed'
    )
    expect(await h.service.listRecompExecutables(ZELDA)).toMatchObject({
      current: 'Zelda64Recompiled.exe',
      source: 'auto'
    })
  })

  it('turns a setup-program port into a tracked game once its game program is chosen', async () => {
    const h = await harness({
      game: {
        id: 'manual:setup',
        source: 'manual',
        platformId: 'pc',
        title: 'Setup Game',
        romPath: undefined
      },
      releases: [release('v1', '2026-01-01T00:00:00Z', 'Setup_Game_Installer-win-amd64.exe')]
    })
    await installAndWait(h, SETUP)
    expect(await h.service.launchRecomp(h.game.id)).toEqual({ ok: true })
    expect(h.spawned[0]?.file).toMatch(/Setup_Game_Installer-win-amd64\.exe$/)
    expect(h.tracked).toHaveLength(0)
    // The setup put the game in the user's Games folder: the user chooses it.
    const game = await writeExe(join(tmp, 'profile', 'Games', 'Setup Game', 'SetupGame.exe'))
    await h.service.setRecompExecutable(SETUP, game)
    expect(await h.service.launchRecomp(h.game.id)).toEqual({ ok: true })
    expect(h.spawned[1]?.file).toBe(game)
    expect(h.spawned[1]?.options.cwd).toBe(join(tmp, 'profile', 'Games', 'Setup Game'))
    expect(h.tracked).toHaveLength(1)
    // Automatic: the setup program again (not tracked).
    h.spawned[1]!.child.emit('exit', 0)
    await until(async () =>
      expect((await h.service.setRecompExecutable(SETUP, null)).source).toBe('auto')
    )
    expect((await h.service.listRecompExecutables(SETUP)).current).toBe(
      'Setup_Game_Installer-win-amd64.exe'
    )
  })

  it('chooses through the file picker (programs only, opening in the folder)', async () => {
    const outside = join(tmp, 'Games', 'MM', 'MM.exe')
    const chooseFile = vi.fn(async () => outside as string | null)
    const h = await harness({
      over: { dialog: { chooseFile, chooseFolder: async () => null } }
    })
    await installAndWait(h, ZELDA)
    await writeExe(outside)
    expect(await h.service.pickRecompExecutable(ZELDA)).toMatchObject({
      current: outside,
      source: 'user'
    })
    expect(chooseFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [{ name: 'Programs', extensions: ['exe'] }],
        defaultPath: await dirOf(h)
      })
    )
    chooseFile.mockResolvedValueOnce(null)
    expect((await h.service.pickRecompExecutable(ZELDA)).current).toBe(outside)
  })

  it('keeps the choice over an update while its file is there, else goes back to PlayOut’s pick', async () => {
    const h = await harness()
    await installAndWait(h, ZELDA, 'v1.0.0')
    const dir = await dirOf(h)
    await writeExe(join(dir, 'bin', 'Other.exe'))
    await h.service.setRecompExecutable(ZELDA, join('bin', 'Other.exe'))
    await installAndWait(h, ZELDA)
    expect(h.installs.at(-1)?.tag).toBe('v2.0.0')
    expect(await h.service.listRecompExecutables(ZELDA)).toMatchObject({
      current: join('bin', 'Other.exe'),
      source: 'user',
      auto: 'Zelda64Recompiled.exe'
    })
    await fs.rm(join(dir, 'bin', 'Other.exe'))
    await installAndWait(h, ZELDA, 'v1.0.0')
    expect(await h.service.listRecompExecutables(ZELDA)).toMatchObject({
      current: 'Zelda64Recompiled.exe',
      source: 'auto'
    })
  })

  it('goes back to PlayOut’s pick with Automatic, and an uninstall forgets the choice', async () => {
    const h = await harness({ shipped: () => ['Other.exe'] })
    await installAndWait(h, ZELDA)
    const dir = await dirOf(h)
    // Two programs the release shipped could be the game: UP asks.
    expect(await h.service.launchRecomp(h.game.id, ZELDA)).toMatchObject({ reason: 'choose-exe' })
    await h.service.setRecompExecutable(ZELDA, 'Other.exe')
    expect(await h.service.setRecompExecutable(ZELDA, null)).toMatchObject({
      current: 'Zelda64Recompiled.exe',
      source: 'auto'
    })
    // Automatic is the player accepting PlayOut's pick: UP starts it without asking.
    expect(await h.service.launchRecomp(h.game.id, ZELDA)).toEqual({ ok: true })
    expect(h.spawned[0]?.file).toBe(join(dir, 'Zelda64Recompiled.exe'))
    expect(h.spawned[0]?.options.cwd).toBe(dir)
    h.spawned[0]!.child.emit('exit', 0)
    await until(async () =>
      expect(await h.service.setRecompExecutable(ZELDA, 'Other.exe')).toMatchObject({
        source: 'user'
      })
    )
    await h.service.uninstallRecomp(ZELDA)
    await installAndWait(h, ZELDA)
    expect((await h.service.listRecompExecutables(ZELDA)).source).toBe('auto')
    // ...and the confirmation: UP asks again.
    expect(await h.service.launchRecomp(h.game.id, ZELDA)).toMatchObject({ reason: 'choose-exe' })
  })

  it('asks which program starts the game when several could, then starts the one picked without asking again', async () => {
    const h = await harness({ shipped: () => ['Editor.exe', 'unins000.exe'] })
    await installAndWait(h, ZELDA)
    const dir = await dirOf(h)
    const result = await h.service.launchRecomp(h.game.id, ZELDA)
    expect(result).toMatchObject({ ok: false, reason: 'choose-exe', recompId: ZELDA })
    if (!result.ok && result.reason === 'choose-exe') {
      expect(result.executables.source).toBe('auto')
      expect(result.executables.candidates.map((c) => [c.path, c.note, c.auto])).toEqual([
        ['Zelda64Recompiled.exe', null, true],
        ['Editor.exe', null, false],
        ['unins000.exe', 'Uninstaller', false]
      ])
    }
    // Nothing started, no game files placed, and the start is not left reserved.
    expect(h.spawned).toHaveLength(0)
    expect(h.tracked).toHaveLength(0)
    expect(await h.service.launchRecomp(h.game.id, ZELDA)).toMatchObject({ reason: 'choose-exe' })
    await h.service.setRecompExecutable(ZELDA, 'Editor.exe')
    expect(await h.service.launchRecomp(h.game.id, ZELDA)).toEqual({ ok: true })
    expect(h.spawned[0]?.file).toBe(join(dir, 'Editor.exe'))
    h.spawned[0]!.child.emit('exit', 0)
    // Later starts use the pick without asking.
    await until(async () =>
      expect(await h.service.launchRecomp(h.game.id, ZELDA)).toEqual({ ok: true })
    )
    expect(h.spawned[1]?.file).toBe(join(dir, 'Editor.exe'))
  })

  it('does not ask for programs the release did not ship (game files copied in, the player’s own)', async () => {
    const h = await harness()
    await installAndWait(h, ZELDA)
    const dir = await dirOf(h)
    await writeExe(join(dir, 'OriginalGame.exe'))
    expect(await h.service.launchRecomp(h.game.id, ZELDA)).toEqual({ ok: true })
    expect(h.spawned[0]?.file).toBe(join(dir, 'Zelda64Recompiled.exe'))
  })

  it('does not ask after PlayOut’s pick has started the game, also after an update that keeps it', async () => {
    const h = await harness({ shipped: (tag) => (tag === 'v2.0.0' ? ['Editor.exe'] : []) })
    await installAndWait(h, ZELDA, 'v1.0.0')
    expect(await h.service.launchRecomp(h.game.id, ZELDA)).toEqual({ ok: true })
    h.spawned[0]!.child.emit('exit', 0)
    await until(async () =>
      expect((await h.service.getRecompSettings()).rows[0]?.installed.exeChosen).toBe('confirmed')
    )
    await installAndWait(h, ZELDA)
    expect(h.installs.at(-1)?.tag).toBe('v2.0.0')
    expect(await h.service.launchRecomp(h.game.id, ZELDA)).toEqual({ ok: true })
    expect(h.spawned[1]?.file).toBe(join(await dirOf(h), 'Zelda64Recompiled.exe'))
  })

  it('does not ask when the only other programs are helpers', async () => {
    const h = await harness({
      shipped: () => [
        'unins000.exe',
        'crashpad_handler.exe',
        'assets/extractor/ZAPD.exe',
        'tools/wadgen.exe',
        'oalinst.exe',
        'windowsdesktop-runtime-8.0.0-win-x64.exe'
      ]
    })
    await installAndWait(h, ZELDA)
    const dir = await dirOf(h)
    expect(await h.service.launchRecomp(h.game.id, ZELDA)).toEqual({ ok: true })
    expect(h.spawned[0]?.file).toBe(join(dir, 'Zelda64Recompiled.exe'))
  })

  it('starts an installed version when the chosen one is not installed', async () => {
    const h = await harness()
    await installAndWait(h, OTHER)
    await h.service.setPreferredRecomp(h.game.id, ZELDA)
    expect(h.game.metadata.recomp).toMatchObject({ preferred: ZELDA, installed: [OTHER] })
    expect(await h.service.launchRecomp(h.game.id)).toEqual({ ok: true })
    expect(h.spawned[0]?.file).toBe(join(await dirOf(h, OTHER), 'Zelda64Recompiled.exe'))
  })
})

describe('recomp service: settings', () => {
  it('stores user save folders as templates and detects again on request', async () => {
    const h = await harness()
    await installAndWait(h, ZELDA)
    const saves = join(h.folders.appData, 'Zelda64Recompiled', 'saves')
    await fs.mkdir(saves, { recursive: true })
    expect(await h.service.setRecompSavePaths(ZELDA, [saves])).toEqual([saves])
    let row = (await h.service.getRecompSettings()).rows[0]!
    expect(row.installed.saveSource).toBe('user')
    expect(row.installed.savePaths[0]).not.toBe(saves)
    expect(row.resolvedSavePaths).toEqual([saves])
    // A folder too broad to sync is left out.
    expect(await h.service.setRecompSavePaths(ZELDA, [h.folders.appData])).toEqual([])
    expect(await h.service.setRecompSavePaths(ZELDA, null)).toEqual([])
    row = (await h.service.getRecompSettings()).rows[0]!
    expect(row.installed.saveSource).toBeNull()
  })

  it('needs an install before game files can be picked, then stores the pick', async () => {
    const h = await harness()
    await expect(h.service.setRecompGameFile(h.game.id, ZELDA, 'game', h.rom)).rejects.toThrow(
      /Install/
    )
    await installAndWait(h, ZELDA)
    const other = join(tmp, 'roms', 'other.z64')
    await fs.writeFile(other, 'x')
    const states = await h.service.setRecompGameFile(h.game.id, ZELDA, 'game', other)
    expect(states[0]).toMatchObject({ path: other, source: 'picked', ready: true })
    const cleared = await h.service.setRecompGameFile(h.game.id, ZELDA, 'game', null)
    expect(cleared[0]).toMatchObject({ path: h.rom, source: 'library' })
  })

  it('turns the save copy off and on per recompilation', async () => {
    const h = await harness()
    await installAndWait(h, ZELDA)
    await h.service.setRecompCloud(ZELDA, false)
    expect((await h.service.getRecompSettings()).rows[0]?.installed.cloud.enabled).toBe(false)
    await h.service.setRecompCloud(ZELDA, true)
    expect((await h.service.getRecompSettings()).rows[0]?.installed.cloud.enabled).toBe(true)
    await h.service.setRecompAutoUpdate(ZELDA, true)
    expect((await h.service.getRecompSettings()).rows[0]?.installed.autoUpdate).toBe(true)
  })

  it('updates recompilations set to update automatically after the start-up check', async () => {
    const h = await harness({ over: { startDelayMs: 10 } })
    await installAndWait(h, ZELDA, 'v1.0.0')
    await h.service.setRecompAutoUpdate(ZELDA, true)
    h.service.start()
    await until(() => expect(h.installs.map((i) => i.tag)).toEqual(['v1.0.0', 'v2.0.0']))
  })
})

describe('recomp service: defects fixed', () => {
  const emptyCatalog = (): RecompCatalog => ({
    entries: new Map(),
    titles: new Map(),
    byRepo: new Map(),
    fetchedAt: { 'decomp-buddy': null, recomplauncher: null },
    offline: ['decomp-buddy', 'recomplauncher']
  })

  it('checks the catalogs for new recompilations at start when online, then every cycle', async () => {
    const calls: boolean[] = []
    const h = await harness({
      over: {
        startDelayMs: 5,
        refreshEveryMs: 30,
        isOnline: () => true,
        loadCatalog: async (d) => {
          calls.push(!!d.force)
          return catalogFixture()
        }
      }
    })
    h.service.start()
    await until(() => expect(calls.length).toBeGreaterThanOrEqual(3))
    expect(calls.every(Boolean)).toBe(true)
  })

  it('offline at start, uses the cached catalogs and checks again once online', async () => {
    const calls: boolean[] = []
    let online = false
    const h = await harness({
      over: {
        startDelayMs: 5,
        onlineRetryMs: 10,
        isOnline: () => online,
        loadCatalog: async (d) => {
          calls.push(!!d.force)
          return { ...catalogFixture(), offline: [] }
        }
      }
    })
    h.service.start()
    await until(() => expect(calls).toEqual([false]))
    await new Promise((r) => setTimeout(r, 50))
    expect(calls).toEqual([false])
    online = true
    await until(() => expect(calls).toEqual([false, true]))
    // A check that reached every catalog ends the retries.
    await new Promise((r) => setTimeout(r, 60))
    expect(calls).toEqual([false, true])
  })

  it('gives up the start-up retries after six checks that reach no catalog', async () => {
    const calls: boolean[] = []
    const h = await harness({
      over: {
        startDelayMs: 5,
        onlineRetryMs: 2,
        isOnline: () => true,
        loadCatalog: async (d) => {
          calls.push(!!d.force)
          return { ...catalogFixture(), offline: ['decomp-buddy', 'recomplauncher'] }
        }
      }
    })
    h.service.start()
    // 1 start-up check + 6 retries (2, 4, 8, ... ms), then nothing until the daily check.
    await until(() => expect(calls.length).toBe(7))
    await new Promise((r) => setTimeout(r, 400))
    expect(calls.length).toBe(7)
  })

  it('ends the start-up retries once a check reaches one catalog', async () => {
    const calls: boolean[] = []
    const h = await harness({
      over: {
        startDelayMs: 5,
        onlineRetryMs: 2,
        isOnline: () => true,
        loadCatalog: async (d) => {
          calls.push(!!d.force)
          return { ...catalogFixture(), offline: ['recomplauncher'] }
        }
      }
    })
    h.service.start()
    await until(() => expect(calls.length).toBe(1))
    await new Promise((r) => setTimeout(r, 100))
    expect(calls.length).toBe(1)
  })

  it('marks recompilations that appear in a later check as new in the browser', async () => {
    const full = (): RecompCatalog => ({ ...catalogFixture(), offline: [] })
    let c = full()
    const first = [...c.entries.keys()][0]!
    const keep = new Map([...c.entries].filter(([id]) => id !== first))
    let clock = Date.parse('2026-11-10T00:00:00Z')
    const h = await harness({
      over: { loadCatalog: async () => c, now: () => new Date((clock += 60_000)) }
    })
    c = { ...c, entries: keep }
    await h.service.refreshRecompCatalog()
    // A check with a catalog offline records nothing.
    c = { ...full(), offline: ['recomplauncher'] }
    await h.service.refreshRecompCatalog()
    expect((await h.service.browseRecomps()).newCount).toBe(0)
    c = { ...c, entries: keep, offline: [] }
    await h.service.refreshRecompCatalog()
    let view = await h.service.browseRecomps()
    expect(view.newCount).toBe(0)
    c = full()
    await h.service.refreshRecompCatalog()
    view = await h.service.browseRecomps()
    expect(view.newCount).toBe(1)
    const entry = view.titles.flatMap((t) => t.entries).find((e) => e.id === first)
    expect(entry?.isNew).toBe(true)
    expect(view.titles.flatMap((t) => t.entries).filter((e) => e.isNew)).toHaveLength(1)
  })

  it('does not keep an empty catalog from an offline start', async () => {
    let online = false
    const h = await harness({
      over: { loadCatalog: async () => (online ? catalogFixture() : emptyCatalog()) }
    })
    expect(await h.service.getGameRecomps(h.game.id)).toBeNull()
    online = true
    const view = await h.service.getGameRecomps(h.game.id)
    expect(view?.entries.map((e) => e.id)).toEqual([ZELDA, OTHER])
  })

  it('reserves a recompilation while its start is prepared', async () => {
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const children: FakeChild[] = []
    const h = await harness({
      over: {
        spawn: () => {
          const child = new FakeChild()
          children.push(child)
          void held.then(() => child.emit('spawn'))
          return child as unknown as ChildProcess
        }
      }
    })
    await installAndWait(h, ZELDA, 'v1.0.0')
    const first = h.service.launchRecomp(h.game.id)
    await until(() => expect(children).toHaveLength(1))
    expect(await h.service.launchRecomp(h.game.id)).toMatchObject({ ok: false, reason: 'running' })
    await expect(h.service.uninstallRecomp(ZELDA)).rejects.toThrow(/running/)
    await expect(h.service.updateRecomp(ZELDA)).rejects.toThrow(/running/)
    release()
    expect(await first).toEqual({ ok: true })
    expect(children).toHaveLength(1)
    expect(h.tracked).toHaveLength(1)
  })

  it('frees the reservation when a start stops early', async () => {
    const h = await harness({ game: { romPath: undefined } })
    await installAndWait(h, ZELDA)
    expect(await h.service.launchRecomp(h.game.id)).toMatchObject({ reason: 'needs-files' })
    await h.service.uninstallRecomp(ZELDA)
    expect(h.uninstalls).toEqual([ZELDA])
  })

  async function cloudSaves(h: Harness): Promise<{ saves: string; file: string; cloud: string }> {
    const saves = join(h.folders.appData, 'Zelda64Recompiled', 'saves')
    await fs.mkdir(saves, { recursive: true })
    const file = join(saves, 'mm.sav')
    await fs.writeFile(file, 'save 1')
    await h.service.setRecompSavePaths(ZELDA, [saves])
    expect(await h.service.syncRecompSaves(ZELDA)).toMatchObject({ conflict: null, error: null })
    return { saves, file, cloud: zeldaCopy() }
  }

  it('refuses a manual sync, a conflict pick and the first sync of cloud saves while the game runs', async () => {
    const h = await harness()
    await installAndWait(h, ZELDA)
    const { file, cloud } = await cloudSaves(h)
    const snapshot = join(tmp, 'snapshot')
    await fs.cp(cloud, snapshot, { recursive: true })
    await fs.writeFile(file, 'save 2')
    await h.service.syncRecompSaves(ZELDA)
    expect(await h.service.launchRecomp(h.game.id)).toEqual({ ok: true })
    // Another PC's (older) copy arrives while playing: nothing may be restored under the game.
    await fs.rm(cloud, { recursive: true, force: true })
    await fs.cp(snapshot, cloud, { recursive: true })
    await expect(h.service.syncRecompSaves(ZELDA)).rejects.toThrow(/running/)
    await expect(h.service.resolveRecompConflict(ZELDA, 'cloud')).rejects.toThrow(/running/)
    await h.service.setRecompCloud(ZELDA, false)
    await h.service.setRecompCloud(ZELDA, true)
    await new Promise((r) => setTimeout(r, 50))
    expect(await fs.readFile(file, 'utf8')).toBe('save 2')
  })

  it('treats a copy in a newly chosen Emulation folder as a conflict, not as newer saves', async () => {
    const h = await harness()
    await installAndWait(h, ZELDA)
    const { file, cloud } = await cloudSaves(h)
    // Emulation folder B holds an old copy (save 1); folder A then gets save 2.
    const other = join(tmp, 'Emulation B')
    await fs.cp(cloud, zeldaCopy(other), { recursive: true })
    await fs.writeFile(file, 'save 2')
    expect(await h.service.syncRecompSaves(ZELDA)).toMatchObject({ conflict: null })
    emu = other
    const state = await h.service.syncRecompSaves(ZELDA)
    expect(state.conflict).not.toBeNull()
    expect(await fs.readFile(file, 'utf8')).toBe('save 2')
    expect((await h.service.getRecompSettings()).rows[0]?.installed.cloud.syncedHash).toBeNull()
  })

  it('switches every recompilation on once and forgets what was synced with the old cloud folder', async () => {
    const root = join(tmp, 'Recompilations')
    const dir = join(root, 'Zelda')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'Zelda64Recompiled.exe'), 'MZ')
    const text = JSON.stringify({
      version: 1,
      installed: {
        [ZELDA]: {
          dir,
          tag: 'v2.0.0',
          cloud: {
            enabled: false,
            syncedHash: 'abc',
            conflict: { localAt: '', cloudAt: '', cloudDevice: '' }
          }
        }
      },
      preferred: {},
      cloudDir: join(tmp, 'Old Drive')
    })
    await fs.mkdir(join(root, '.playout'), { recursive: true })
    await fs.writeFile(join(root, '.playout', 'recomps.json'), text)
    const h = await harness()
    let row = (await h.service.getRecompSettings()).rows[0]!
    expect(row.installed.cloud).toMatchObject({ enabled: true, syncedHash: null, conflict: null })
    // Once only: switched off afterwards, it stays off.
    await h.service.setRecompCloud(ZELDA, false)
    services.forEach((s) => s.dispose())
    const again = await harness()
    row = (await again.service.getRecompSettings()).rows[0]!
    expect(row.installed.cloud.enabled).toBe(false)
  })

  it('adopts the copy an older PlayOut kept in the cloud folder, once, leaving it as it was', async () => {
    // The old cloud copy (written by the same sync code into the old place), with "save from laptop".
    const drive = join(tmp, 'Old Drive')
    const old = oldCloudSaveDir(drive, ZELDA)
    const laptop = join(tmp, 'laptop', 'saves')
    await fs.mkdir(laptop, { recursive: true })
    await fs.writeFile(join(laptop, 'mm.sav'), 'save from laptop')
    await fs.mkdir(drive, { recursive: true })
    await syncSaves(
      ZELDA,
      [laptop],
      defaultCloudState(),
      {
        rootDir: drive,
        dir: old,
        machine: 'LAPTOP',
        log,
        backupsDir: join(tmp, 'laptop-backups'),
        templates: ['{config}/Zelda64Recompiled/saves']
      },
      'after-play'
    )
    // A manifest from an older PlayOut that had chosen that cloud folder.
    await createRecompState(join(tmp, 'Recompilations')).update((m) => {
      m.cloudDir = drive
    })
    const h = await harness()
    await installAndWait(h, ZELDA)
    const saves = join(h.folders.appData, 'Zelda64Recompiled', 'saves')
    await fs.mkdir(saves, { recursive: true })
    await h.service.setRecompSavePaths(ZELDA, [saves])
    // Nothing here yet: the adopted copy comes back to this PC.
    const first = await h.service.syncRecompSaves(ZELDA)
    expect(first).toMatchObject({ conflict: null, error: null })
    expect(await fs.readFile(join(saves, 'mm.sav'), 'utf8')).toBe('save from laptop')
    expect((await readCopyMeta(zeldaCopy()))?.machine).toBe('LAPTOP')
    // The old copy is left as it was, and never adopted again (the Emulation folder's copy wins from now on).
    await fs.writeFile(join(saves, 'mm.sav'), 'played here')
    expect(await h.service.syncRecompSaves(ZELDA)).toMatchObject({ conflict: null, error: null })
    expect(await fs.readFile(join(zeldaCopy(), 'current', '0', 'mm.sav'), 'utf8')).toBe(
      'played here'
    )
    expect(await fs.readFile(join(old, 'current', '0', 'mm.sav'), 'utf8')).toBe('save from laptop')
  })

  it('looks for the old cloud copy only once: a new empty Emulation folder gets this PC’s saves', async () => {
    const drive = join(tmp, 'Old Drive')
    const old = oldCloudSaveDir(drive, ZELDA)
    const laptop = join(tmp, 'laptop', 'saves')
    await fs.mkdir(laptop, { recursive: true })
    await fs.writeFile(join(laptop, 'mm.sav'), 'old save from laptop')
    await fs.mkdir(drive, { recursive: true })
    await syncSaves(
      ZELDA,
      [laptop],
      defaultCloudState(),
      {
        rootDir: drive,
        dir: old,
        machine: 'LAPTOP',
        log,
        backupsDir: join(tmp, 'laptop-backups'),
        templates: ['{config}/Zelda64Recompiled/saves']
      },
      'after-play'
    )
    await createRecompState(join(tmp, 'Recompilations')).update((m) => {
      m.cloudDir = drive
    })
    const h = await harness()
    await installAndWait(h, ZELDA)
    const saves = join(h.folders.appData, 'Zelda64Recompiled', 'saves')
    await fs.mkdir(saves, { recursive: true })
    await h.service.setRecompSavePaths(ZELDA, [saves])
    await h.service.syncRecompSaves(ZELDA)
    expect(await fs.readFile(join(saves, 'mm.sav'), 'utf8')).toBe('old save from laptop')
    await fs.writeFile(join(saves, 'mm.sav'), 'played here')
    // A new, empty Emulation folder: the months-old copy is not adopted again (no bogus conflict).
    emu = join(tmp, 'Emulation New')
    await fs.mkdir(emu, { recursive: true })
    expect(await h.service.syncRecompSaves(ZELDA)).toMatchObject({ conflict: null, error: null })
    expect(await fs.readFile(join(zeldaCopy(), 'current', '0', 'mm.sav'), 'utf8')).toBe(
      'played here'
    )
    expect(await fs.readFile(join(saves, 'mm.sav'), 'utf8')).toBe('played here')
  })

  it('keeps its copy folder whatever the catalog says, and a switched copy folder is a conflict', async () => {
    const h = await harness()
    await installAndWait(h, ZELDA)
    const { file } = await cloudSaves(h)
    const roots = (await readCopyMeta(zeldaCopy()))!.roots
    services.forEach((s) => s.dispose())
    // Another PC (catalog not loaded there) made a copy named after the repository, with other saves.
    const stubCopy = join(
      emu,
      RECOMP_SAVES_FOLDER,
      safeRecompFolder({ id: ZELDA, name: 'Zelda64Recomp' })
    )
    expect(stubCopy).not.toBe(zeldaCopy())
    const pcB = join(tmp, 'pcB', 'saves')
    await fs.mkdir(pcB, { recursive: true })
    await fs.writeFile(join(pcB, 'mm.sav'), 'from PC-B')
    await syncSaves(
      ZELDA,
      [pcB],
      defaultCloudState(),
      {
        rootDir: emu,
        dir: stubCopy,
        machine: 'PC-B',
        log,
        backupsDir: join(tmp, 'b'),
        templates: roots
      },
      'after-play'
    )
    // This PC starts without the catalog: the folder chosen before is still used.
    const offline = await harness({
      over: {
        loadCatalog: async () => {
          throw new Error('offline')
        }
      }
    })
    expect(await offline.service.syncRecompSaves(ZELDA)).toMatchObject({ conflict: null })
    expect(await fs.readFile(file, 'utf8')).toBe('save 1')
    // Its folder is deleted: the other folder is used, as a conflict (never copied back over the saves).
    await fs.rm(zeldaCopy(), { recursive: true, force: true })
    const state = await offline.service.syncRecompSaves(ZELDA)
    expect(state.conflict).toMatchObject({ cloudDevice: 'PC-B' })
    expect(await fs.readFile(file, 'utf8')).toBe('save 1')
  })

  it('only suggests a folder that just shares a word with the game after install', async () => {
    const h = await harness()
    const loose = join(h.folders.appData, 'MajorasMaskFanRemake')
    await fs.mkdir(loose, { recursive: true })
    await fs.writeFile(join(loose, 'slot.sav'), 'another game')
    await installAndWait(h, ZELDA)
    expect(await h.service.getRecompSaves(ZELDA)).toMatchObject({
      resolved: [],
      suggestions: [loose]
    })
  })

  it('adds a save folder inside its own install, never PlayOut’s or another install', async () => {
    const h = await harness()
    await installAndWait(h, ZELDA)
    const install = join(h.root, 'Zelda 64 Recompiled')
    const inInstall = join(install, 'saves')
    await fs.mkdir(inInstall, { recursive: true })
    expect(await h.service.addRecompSaveFolder(ZELDA, inInstall)).toEqual([inInstall])
    const other = join(h.root, 'Other Recomp', 'saves')
    await fs.mkdir(other, { recursive: true })
    await expect(h.service.addRecompSaveFolder(ZELDA, other)).rejects.toThrow(/PlayOut/)
    await expect(h.service.addRecompSaveFolder(ZELDA, h.root)).rejects.toThrow()
    await expect(h.service.addRecompSaveFolder(ZELDA, install)).rejects.toThrow()
  })

  it('adds a save folder beside the chosen game program outside the install (a setup-program port)', async () => {
    const h = await harness()
    await installAndWait(h, ZELDA)
    // Like Xerenge: its setup put the game in a folder of its own beside it in the Recompilations folder.
    const gameDir = join(h.root, 'Burnout Revenge')
    const saves = join(gameDir, 'saves')
    await fs.mkdir(saves, { recursive: true })
    await fs.writeFile(join(gameDir, 'Burnout Revenge.exe'), 'MZ')
    await h.service.setRecompExecutable(ZELDA, join(gameDir, 'Burnout Revenge.exe'))
    expect(await h.service.addRecompSaveFolder(ZELDA, saves)).toEqual([saves])
    // The game folder itself, another recompilation's folder and the Recompilations folder stay refused.
    await expect(h.service.addRecompSaveFolder(ZELDA, gameDir)).rejects.toThrow()
    const other = join(h.root, 'Other Recomp', 'saves')
    await fs.mkdir(other, { recursive: true })
    await expect(h.service.addRecompSaveFolder(ZELDA, other)).rejects.toThrow(/PlayOut/)
    await expect(h.service.addRecompSaveFolder(ZELDA, h.root)).rejects.toThrow()
  })

  it('never opens the Recompilations folder through a program chosen right inside it', async () => {
    const h = await harness()
    await installAndWait(h, ZELDA)
    await fs.writeFile(join(h.root, 'Loose.exe'), 'MZ')
    await h.service.setRecompExecutable(ZELDA, join(h.root, 'Loose.exe'))
    const other = join(h.root, 'Other Recomp', 'saves')
    await fs.mkdir(other, { recursive: true })
    await expect(h.service.addRecompSaveFolder(ZELDA, other)).rejects.toThrow(/PlayOut/)
  })

  it('finds a save folder inside the install (under the excluded Recompilations folder)', async () => {
    const h = await harness()
    const inInstall = join(h.root, 'Zelda 64 Recompiled', 'saves')
    await fs.mkdir(inInstall, { recursive: true })
    await fs.writeFile(join(inInstall, 'slot1.sav'), 'x')
    await installAndWait(h, ZELDA)
    expect(await h.service.getRecompSaves(ZELDA)).toMatchObject({
      resolved: [inInstall],
      source: 'detected'
    })
  })

  it('finds the save folder after install: one is used, several are suggested', async () => {
    const h = await harness()
    const only = join(h.folders.localAppData, 'Zelda64Recompiled')
    await fs.mkdir(only, { recursive: true })
    await fs.writeFile(join(only, 'mm.sav'), 'x')
    await installAndWait(h, ZELDA)
    let saves = await h.service.getRecompSaves(ZELDA)
    expect(saves).toMatchObject({ resolved: [only], source: 'detected', suggestions: [] })
    expect(saves.savesDir).toBe(zeldaCopy())
    // A second candidate appears: Find automatically keeps the one in use and suggests the other.
    const second = join(h.folders.userProfile, 'Saved Games', 'Zelda64')
    await fs.mkdir(second, { recursive: true })
    await fs.writeFile(join(second, 'b.sav'), 'x')
    saves = await h.service.findRecompSaveFolders(ZELDA)
    expect(saves).toMatchObject({ resolved: [only], suggestions: [second] })
    expect((await h.service.getRecompSettings()).rows[0]?.saveSuggestions).toEqual([second])
    // Adding the suggestion uses it and stops suggesting it.
    expect(await h.service.addRecompSaveFolder(ZELDA, second)).toEqual([only, second])
    saves = await h.service.getRecompSaves(ZELDA)
    expect(saves).toMatchObject({ resolved: [only, second], source: 'user', suggestions: [] })
  })

  it('refuses to add broad folders or PlayOut’s own as save folders, and opens the copies folder', async () => {
    const opened: string[] = []
    const h = await harness({ over: { openPath: async (p) => void opened.push(p) } })
    await installAndWait(h, ZELDA)
    await expect(h.service.addRecompSaveFolder(ZELDA, h.folders.appData)).rejects.toThrow(
      /too broad/
    )
    await expect(h.service.addRecompSaveFolder(ZELDA, join(emu, 'saves'))).rejects.toThrow(
      /PlayOut/
    )
    await h.service.openRecompFolder(ZELDA, 'copies')
    expect(opened).toEqual([zeldaCopy()])
    expect((await fs.stat(zeldaCopy())).isDirectory()).toBe(true)
  })

  it('keeps settings changed while an update downloads', async () => {
    let open!: () => void
    let gate: Promise<void> = Promise.resolve()
    const h = await harness({ installGate: () => gate })
    await installAndWait(h, ZELDA, 'v1.0.0')
    gate = new Promise<void>((r) => (open = r))
    await h.service.updateRecomp(ZELDA)
    await until(() => expect(h.installs).toHaveLength(2))
    await h.service.setRecompAutoUpdate(ZELDA, true)
    const saves = join(h.folders.appData, 'Zelda64Recompiled', 'saves')
    await fs.mkdir(saves, { recursive: true })
    await h.service.setRecompSavePaths(ZELDA, [saves])
    await h.service.setRecompCloud(ZELDA, false)
    open()
    await until(async () =>
      expect((await h.service.getRecompSettings()).rows[0]?.installed.tag).toBe('v2.0.0')
    )
    const row = (await h.service.getRecompSettings()).rows[0]!
    expect(row.installed).toMatchObject({ autoUpdate: true, saveSource: 'user', prevTag: 'v1.0.0' })
    expect(row.installed.cloud.enabled).toBe(false)
    expect(row.resolvedSavePaths).toEqual([saves])
  })
})

describe('recomp service: change version (pinning)', () => {
  /** Ask for a release (or Back to latest, null) and wait for the switch to finish. */
  async function switchAndWait(h: Harness, tag: string | null): Promise<void> {
    const from = h.events.length
    await h.service.setRecompVersion(ZELDA, tag)
    await installFinished(h, ZELDA, from)
  }
  const row = async (h: Harness): Promise<RecompRow> =>
    (await h.service.getRecompSettings()).rows[0]!

  it('choosing an older release installs it and pins it; updates skip it; Back to latest unpins', async () => {
    const h = await harness()
    await installAndWait(h, ZELDA)
    await switchAndWait(h, 'v1.0.0')
    expect(h.installs.map((i) => i.tag)).toEqual(['v2.0.0', 'v1.0.0'])
    // The install pipeline got the installed record (saves, game files, program are carried over by it).
    expect(h.installs[1]?.previous?.tag).toBe('v2.0.0')
    let r = await row(h)
    expect(r.installed).toMatchObject({ tag: 'v1.0.0', pinnedTag: 'v1.0.0', prevTag: 'v2.0.0' })
    expect(r.release).toEqual({ prerelease: false, latest: 'v2.0.0' })
    // No update while pinned: not offered, not by Update all, not on the game page.
    expect(await h.service.checkRecompUpdates()).toEqual({})
    expect(r.update).toBeNull()
    await h.service.updateAllRecomps()
    await new Promise((res) => setTimeout(res, 30))
    expect(h.installs).toHaveLength(2)
    expect((await h.service.getGameRecomps(h.game.id))?.updates).toEqual({})

    await switchAndWait(h, null)
    r = await row(h)
    expect(h.installs.map((i) => i.tag)).toEqual(['v2.0.0', 'v1.0.0', 'v2.0.0'])
    expect(r.installed).toMatchObject({ tag: 'v2.0.0', pinnedTag: null, prevTag: 'v1.0.0' })
  })

  it('choosing the newest release clears the pin', async () => {
    const h = await harness()
    await installAndWait(h, ZELDA)
    await switchAndWait(h, 'v1.0.0')
    await switchAndWait(h, 'v2.0.0')
    expect((await row(h)).installed).toMatchObject({ tag: 'v2.0.0', pinnedTag: null })
  })

  it('choosing the release in use only pins it (no download)', async () => {
    const h = await harness()
    await installAndWait(h, ZELDA, 'v1.0.0')
    // A first install of a chosen release is not pinned: the update is offered.
    expect((await row(h)).installed.pinnedTag).toBeNull()
    expect(await h.service.checkRecompUpdates()).toEqual({ [ZELDA]: 'v2.0.0' })
    await h.service.setRecompVersion(ZELDA, 'v1.0.0')
    expect(h.installs).toHaveLength(1)
    const r = await row(h)
    expect(r.installed.pinnedTag).toBe('v1.0.0')
    expect(r.update).toBeNull()
  })

  it('an older release installed from the Recompilation page’s Releases list pins it too', async () => {
    const h = await harness()
    await installAndWait(h, ZELDA)
    await installAndWait(h, ZELDA, 'v1.0.0')
    expect((await row(h)).installed).toMatchObject({ tag: 'v1.0.0', pinnedTag: 'v1.0.0' })
    expect(await h.service.checkRecompUpdates()).toEqual({})
    // The newest from that list unpins.
    await installAndWait(h, ZELDA, 'v2.0.0')
    expect((await row(h)).installed).toMatchObject({ tag: 'v2.0.0', pinnedTag: null })
  })

  it('reports an install as done only once its record is stored (it is busy until then)', async () => {
    const events: Harness['events'] = []
    const atDone: Promise<RecompRow | undefined>[] = []
    let service: RecompService | null = null
    const made = await harness({
      over: {
        events: {
          emit: <E extends PlayOutEventName>(name: E, payload: PlayOutEvents[E]) => {
            events.push({ name, payload })
            // What Settings would show when it hears that the install is done.
            if (name === 'recomp:progress' && (payload as RecompProgress).phase === 'done')
              atDone.push(service!.getRecompSettings().then((s) => s.rows[0]))
          }
        }
      }
    })
    service = made.service
    const h: Harness = { ...made, events }
    await installAndWait(h, ZELDA)
    await installAndWait(h, ZELDA, 'v1.0.0')
    const rows = await Promise.all(atDone)
    expect(rows.map((r) => r?.installed.tag)).toEqual(['v2.0.0', 'v1.0.0'])
    expect(rows[1]?.installed.pinnedTag).toBe('v1.0.0')
  })

  it('an update check that started before a pin does not offer the pinned one an update', async () => {
    let open!: () => void
    let gate: Promise<void> = Promise.resolve()
    const rels = [
      release('v2.0.0', '2026-10-01T00:00:00Z'),
      release('v1.0.0', '2026-01-01T00:00:00Z')
    ]
    const h = await harness({
      releases: rels,
      over: {
        fetchReleases: async (_e, _c, o) => {
          if (o?.force) await gate
          return rels
        }
      }
    })
    await installAndWait(h, ZELDA, 'v1.0.0')
    gate = new Promise<void>((r) => (open = r))
    const check = h.service.checkRecompUpdates()
    await new Promise((r) => setTimeout(r, 20))
    // Pinned while the check waits for the releases.
    await h.service.setRecompVersion(ZELDA, 'v1.0.0')
    open()
    expect(await check).toEqual({})
    expect((await row(h)).update).toBeNull()
    expect((await h.service.getGameRecomps(h.game.id))?.updates).toEqual({})
  })

  it('automatic updates skip a pinned recompilation', async () => {
    const h = await harness({ over: { startDelayMs: 10 } })
    await installAndWait(h, ZELDA)
    await switchAndWait(h, 'v1.0.0')
    await h.service.setRecompAutoUpdate(ZELDA, true)
    h.service.start()
    await until(async () => expect((await row(h)).release).not.toBeNull())
    await new Promise((res) => setTimeout(res, 50))
    expect(h.installs.map((i) => i.tag)).toEqual(['v2.0.0', 'v1.0.0'])
  })

  it('refuses a tag that is not a release, one without a Windows download, and while installing', async () => {
    let open: () => void = () => undefined
    let gated = false
    const h = await harness({
      releases: [
        release('v2.0.0', '2026-10-01T00:00:00Z'),
        release('v1.5.0', '2026-06-01T00:00:00Z', 'Zelda64Recompiled-Linux.tar.gz'),
        release('v1.0.0', '2026-01-01T00:00:00Z')
      ],
      installGate: () =>
        gated ? new Promise<void>((res) => (open = res)) : Promise.resolve(undefined)
    })
    await installAndWait(h, ZELDA)
    await expect(h.service.setRecompVersion(ZELDA, 'v9.9.9')).rejects.toThrow(/not a release/)
    await expect(h.service.setRecompVersion(ZELDA, 'v1.5.0')).rejects.toThrow(/no Windows download/)
    await expect(h.service.setRecompVersion(OTHER, 'v1.0.0')).rejects.toThrow(/not installed/)
    gated = true
    await h.service.setRecompVersion(ZELDA, 'v1.0.0')
    await until(() => expect(h.installs).toHaveLength(2))
    await expect(h.service.setRecompVersion(ZELDA, null)).rejects.toThrow(/installing/)
    open()
    await until(async () => expect((await row(h)).installed.tag).toBe('v1.0.0'))
  })

  it('uninstalling clears the pin', async () => {
    const h = await harness()
    await installAndWait(h, ZELDA)
    await switchAndWait(h, 'v1.0.0')
    await h.service.uninstallRecomp(ZELDA)
    await installAndWait(h, ZELDA)
    expect((await row(h)).installed).toMatchObject({ tag: 'v2.0.0', pinnedTag: null })
  })
})

describe('recomp service: delete the original disc image', () => {
  /** A harness whose game is a disc image (mm.iso) and whose disc images are planned and trashed by fakes. */
  async function imageHarness(
    opts: { trashOk?: boolean; isoNeed?: boolean; spawnFails?: () => boolean } = {}
  ): Promise<
    Harness & {
      iso: string
      trashed: { gameId: string; recompId: string; recompRunning: boolean }[]
      offers(): { key: string; fileName: string }[][]
    }
  > {
    const iso = join(tmp, 'roms', 'mm.iso')
    await fs.mkdir(join(tmp, 'roms'), { recursive: true })
    await fs.writeFile(iso, 'disc data')
    const trashed: { gameId: string; recompId: string; recompRunning: boolean }[] = []
    let game: Game | null = null
    const spawnFails = opts.spawnFails
    const h = await harness({
      game: { romPath: iso },
      over: {
        ...(opts.isoNeed
          ? {
              loadCatalog: async () => {
                const c = catalogFixture()
                const z = c.entries.get(ZELDA)!
                z.needs = [{ ...z.needs[0]!, formats: ['.iso'] }]
                return c
              }
            }
          : {}),
        ...(spawnFails
          ? {
              spawn: (file: string, args: string[], options: SpawnOptions) => {
                const child = new FakeChild()
                h.spawned.push({ file, args, options, child })
                const fail = spawnFails()
                setImmediate(() =>
                  fail ? child.emit('error', new Error('cannot start')) : child.emit('spawn')
                )
                return child as unknown as ChildProcess
              }
            }
          : {}),
        originalImage: {
          plan: async () => ({ paths: [iso], totalBytes: 9 }),
          trash: async (gameId, recompId, options) => {
            trashed.push({ gameId, recompId, recompRunning: options.recompRunning })
            if (opts.trashOk === false) return { ok: false, message: 'Nothing was deleted: busy.' }
            game!.romRemoved = { at: 'now', recompId, romPath: iso }
            delete game!.romPath
            return { ok: true, message: 'Moved mm.iso to the Recycle Bin' }
          }
        }
      }
    })
    game = h.game
    return {
      ...h,
      iso,
      trashed,
      offers: () =>
        h.events
          .filter((e) => e.name === 'recomp:image-offers')
          .map((e) => (e.payload as { offers: { key: string; fileName: string }[] }).offers)
    }
  }

  /** Start a recompilation (OTHER: one program, no game files), let it close and wait for the after-play work. */
  async function playOnce(h: Harness, id = OTHER): Promise<void> {
    expect(await h.service.launchRecomp(h.game.id, id)).toEqual({ ok: true })
    const changes = h.events.filter((e) => e.name === 'recomp:changed').length
    h.spawned.at(-1)!.child.emit('exit', 0)
    // 'recomp:changed' is the last thing the after-play work does (and the only one it sends here: no saves to copy).
    await until(() =>
      expect(h.events.filter((e) => e.name === 'recomp:changed').length).toBeGreaterThan(changes)
    )
  }

  it('asks at once when the player picks the program', async () => {
    const h = await imageHarness()
    await installAndWait(h, OTHER)
    expect(h.offers()).toEqual([])
    await h.service.setRecompExecutable(OTHER, 'Zelda64Recompiled.exe')
    expect(h.offers().at(-1)).toEqual([
      expect.objectContaining({
        recompId: OTHER,
        recompName: 'MM Port',
        gameId: h.game.id,
        fileName: 'mm.iso',
        files: ['mm.iso'],
        totalBytes: 9
      })
    ])
    expect(await h.service.getRecompImageOffers()).toHaveLength(1)
    // Asked once: picking again does not ask again (the waiting question is just checked again).
    const [asked] = await h.service.getRecompImageOffers()
    await h.service.setRecompExecutable(OTHER, null)
    expect(await h.service.getRecompImageOffers()).toEqual([asked])
    expect(h.offers().at(-1)).toEqual([asked])
  })

  it('never asks about an image no longer on disk, and drops a waiting question once its image is gone', async () => {
    const h = await imageHarness()
    await installAndWait(h, OTHER)
    // Asked while the image is there.
    await h.service.setRecompExecutable(OTHER, 'Zelda64Recompiled.exe')
    expect(await h.service.getRecompImageOffers()).toHaveLength(1)
    // The player moved the image into the recompilation's folder by hand: the question goes, at every start.
    await fs.rm(h.iso)
    expect(await h.service.getRecompImageOffers()).toEqual([])
    expect(h.trashed).toEqual([])
  })

  it('does not ask at all when the library names an image that is already gone', async () => {
    const h = await imageHarness()
    await installAndWait(h, OTHER)
    await fs.rm(h.iso)
    await h.service.setRecompExecutable(OTHER, 'Zelda64Recompiled.exe')
    expect(h.offers().flat()).toEqual([])
    expect(await h.service.getRecompImageOffers()).toEqual([])
  })

  it("asks after the second start of PlayOut's own pick, not at identification or after the first", async () => {
    const h = await imageHarness()
    await installAndWait(h, OTHER)
    expect(h.offers()).toEqual([])
    await playOnce(h)
    expect(h.offers()).toEqual([])
    expect((await h.service.getRecompSettings()).rows[0]!.installed.exeIdentified).toMatchObject({
      by: 'auto',
      starts: 1
    })
    await playOnce(h)
    await until(() => expect(h.offers().at(-1)).toHaveLength(1))
    expect(h.offers().at(-1)![0]).toMatchObject({ recompId: OTHER, fileName: 'mm.iso' })
  })

  it('does not count a start that failed', async () => {
    let fail = true
    const h = await imageHarness({ spawnFails: () => fail })
    await installAndWait(h, OTHER)
    expect(await h.service.launchRecomp(h.game.id, OTHER)).toMatchObject({
      ok: false,
      reason: 'failed'
    })
    fail = false
    await playOnce(h)
    expect(h.offers()).toEqual([])
    expect((await h.service.getRecompSettings()).rows[0]!.installed.exeIdentified).toMatchObject({
      starts: 1
    })
    await playOnce(h)
    await until(() => expect(h.offers().at(-1)).toHaveLength(1))
  })

  it('remembers Keep it, and asks again only from the Recompilation page', async () => {
    const h = await imageHarness()
    await installAndWait(h, OTHER)
    await h.service.setRecompExecutable(OTHER, 'Zelda64Recompiled.exe')
    const [offer] = await h.service.getRecompImageOffers()
    expect(await h.service.answerRecompImageOffer(offer!.key, 'keep')).toMatchObject({ ok: true })
    expect(await h.service.getRecompImageOffers()).toEqual([])
    expect(h.offers().at(-1)).toEqual([])
    await playOnce(h)
    await playOnce(h)
    expect(await h.service.getRecompImageOffers()).toEqual([])
    expect(h.trashed).toEqual([])
    expect((await h.service.getGameRecomps(h.game.id))?.originalImage).toEqual({
      recompId: OTHER,
      fileName: 'mm.iso',
      kept: true,
      folder: null
    })
    // Settings › Recompilations offers the same for the recompilation's row, naming the game.
    expect(
      (await h.service.getRecompSettings()).rows.find((r) => r.entry.id === OTHER)?.originalImage
    ).toEqual({ recompId: OTHER, gameId: h.game.id, fileName: 'mm.iso', kept: true, folder: null })
    expect(await h.service.askRecompImageDelete(h.game.id, OTHER)).toMatchObject({
      key: offer!.key
    })
    expect(await h.service.getRecompImageOffers()).toHaveLength(1)
  })

  it('moves the image to the Recycle Bin on Delete; the card stays matched', async () => {
    const h = await imageHarness()
    await installAndWait(h, OTHER)
    await h.service.setRecompExecutable(OTHER, 'Zelda64Recompiled.exe')
    const [offer] = await h.service.getRecompImageOffers()
    expect(await h.service.answerRecompImageOffer(offer!.key, 'delete')).toEqual({
      ok: true,
      message: 'Moved mm.iso to the Recycle Bin'
    })
    expect(h.trashed).toEqual([{ gameId: h.game.id, recompId: OTHER, recompRunning: false }])
    expect(await h.service.getRecompImageOffers()).toEqual([])
    expect(await h.service.answerRecompImageOffer(offer!.key, 'delete')).toMatchObject({
      ok: false
    })
    // Matched by its image's name still (the record lost its romPath), and nothing more to offer.
    await h.service.refreshRecompCatalog()
    expect(h.game.metadata.recomp?.titleKey).toBe(KEY)
    expect((await h.service.getGameRecomps(h.game.id))?.originalImage).toBeNull()
  })

  it('keeps the question when the image cannot go now', async () => {
    const h = await imageHarness({ trashOk: false })
    await installAndWait(h, OTHER)
    await h.service.setRecompExecutable(OTHER, 'Zelda64Recompiled.exe')
    const [offer] = await h.service.getRecompImageOffers()
    expect(await h.service.answerRecompImageOffer(offer!.key, 'delete')).toEqual({
      ok: false,
      message: 'Nothing was deleted: busy.'
    })
    expect(await h.service.getRecompImageOffers()).toHaveLength(1)
  })

  it('never asks for a recompilation that reads the image at every start', async () => {
    const h = await imageHarness({ isoNeed: true })
    await installAndWait(h, ZELDA)
    await h.service.setRecompExecutable(ZELDA, 'Zelda64Recompiled.exe')
    expect(h.offers()).toEqual([])
    expect((await h.service.getGameRecomps(h.game.id))?.originalImage).toBeNull()
    expect((await h.service.getRecompSettings()).rows[0]?.originalImage).toBeNull()
    await expect(h.service.askRecompImageDelete(h.game.id, ZELDA)).rejects.toThrow(
      /reads it at every start/
    )
  })

  /** ZELDA's game file (a .z64; the library's mm.iso does not fit it): a file of its own, picked. */
  async function pickZ64(h: Harness): Promise<string> {
    const z64 = join(tmp, 'roms', 'own.z64')
    await fs.writeFile(z64, 'rom')
    await h.service.setRecompGameFile(h.game.id, ZELDA, 'game', z64)
    return z64
  }

  it('does not ask while a game file it needs is not picked, and asks at the next start once it is', async () => {
    const h = await imageHarness()
    await installAndWait(h, ZELDA)
    await h.service.setRecompExecutable(ZELDA, 'Zelda64Recompiled.exe')
    expect(h.offers()).toEqual([])
    expect((await h.service.getGameRecomps(h.game.id))?.originalImage).toBeNull()
    await expect(h.service.askRecompImageDelete(h.game.id, ZELDA)).rejects.toThrow(
      /still needs its game files/
    )
    await pickZ64(h)
    // The player chose the program: the next start asks.
    await playOnce(h, ZELDA)
    await until(() => expect(h.offers().at(-1)).toHaveLength(1))
    expect(h.offers().at(-1)![0]).toMatchObject({ recompId: ZELDA, fileName: 'mm.iso' })
  })

  it('drops a waiting question once the recompilation reads the image, and Delete checks again', async () => {
    const h = await imageHarness()
    await installAndWait(h, ZELDA)
    await pickZ64(h)
    await h.service.setRecompExecutable(ZELDA, 'Zelda64Recompiled.exe')
    const [offer] = await h.service.getRecompImageOffers()
    expect(offer).toMatchObject({ recompId: ZELDA })
    // Now the image itself is its game file (passed with --rom at every start).
    await h.service.setRecompGameFile(h.game.id, ZELDA, 'game', h.iso)
    expect(h.offers().at(-1)).toEqual([])
    expect(await h.service.getRecompImageOffers()).toEqual([])
    expect(await h.service.answerRecompImageOffer(offer!.key, 'delete')).toMatchObject({
      ok: false
    })
    expect(h.trashed).toEqual([])
  })

  it('never deletes for a question answered after the recompilation was uninstalled', async () => {
    const h = await imageHarness()
    await installAndWait(h, OTHER)
    await h.service.setRecompExecutable(OTHER, 'Zelda64Recompiled.exe')
    const [offer] = await h.service.getRecompImageOffers()
    await h.service.uninstallRecomp(OTHER)
    expect(await h.service.answerRecompImageOffer(offer!.key, 'delete')).toMatchObject({
      ok: false,
      message: /no longer installed/
    })
    expect(h.trashed).toEqual([])
  })

  it('keeps the start count over an update of the recompilation', async () => {
    const h = await imageHarness()
    await installAndWait(h, ZELDA, 'v1.0.0')
    await pickZ64(h)
    await playOnce(h, ZELDA)
    const counted = (): unknown =>
      h.service.getRecompSettings().then((s) => s.rows[0]!.installed.exeIdentified)
    expect(await counted()).toMatchObject({ by: 'auto', starts: 1 })
    await h.service.updateRecomp(ZELDA)
    await until(async () =>
      expect((await h.service.getRecompSettings()).rows[0]?.installed.tag).toBe('v2.0.0')
    )
    expect(await counted()).toMatchObject({ by: 'auto', starts: 1 })
    expect(h.offers()).toEqual([])
    await playOnce(h, ZELDA)
    await until(() => expect(h.offers().at(-1)).toHaveLength(1))
  })

  it('never asks about a cartridge ROM', async () => {
    const h = await harness({
      over: {
        originalImage: {
          plan: async () => ({ paths: [], totalBytes: 0 }),
          trash: async () => ({ ok: true, message: '' })
        }
      }
    })
    await installAndWait(h, OTHER)
    await h.service.setRecompExecutable(OTHER, 'Zelda64Recompiled.exe')
    expect(h.events.some((e) => e.name === 'recomp:image-offers')).toBe(false)
  })
})

describe('recomp service: delete the unpacked game folder', () => {
  const SETUP_GAME: UnpackedGameSetup = {
    recompId: SETUP,
    game: 'Setup Game',
    platform: 'xbox360',
    homeRelative: ['Games', 'Setup Game', 'game'],
    marker: 'default.xex'
  }
  const home = (): string => join(tmp, 'home')
  const gameDir = (): string => join(home(), 'Games', 'Setup Game', 'game')
  /** Where the setup installs the game by default: around PlayOut's unpacked folder (as Xerenge does). */
  const around = (): string => join(home(), 'Games', 'Setup Game', 'bin', 'game.exe')
  /** The game installed somewhere else than around PlayOut's unpacked folder. */
  const elsewhere = (): string => join(tmp, 'Elsewhere', 'Setup Game', 'bin', 'game.exe')

  type FolderHarness = Harness & {
    image: string
    /** What went to the (fake) Recycle Bin, in order: 'image' or the folder's path. */
    trashed: string[]
    /** Unpack and run the setup (it exits), then the player picks the installed program at `program`. */
    installGame(program: string): Promise<void>
    choose(program: string): Promise<void>
  }

  /** A setup-type recompilation of an Xbox 360 image PlayOut unpacks; files go to a fake Recycle Bin. */
  async function folderHarness(
    opts: {
      preUnpacked?: boolean
      folderTrashFails?: boolean
      /** Runs while the folder is being moved (before it has moved). */
      duringFolderTrash?: (h: Harness) => Promise<void>
    } = {}
  ): Promise<FolderHarness> {
    const image = join(tmp, 'roms', 'Setup Game.xiso.iso')
    await fs.mkdir(join(tmp, 'roms'), { recursive: true })
    await fs.writeFile(image, 'xiso')
    const trashed: string[] = []
    let game: Game | null = null
    let self: Harness | null = null
    const h = await harness({
      game: {
        id: 'rom:xbox360:setup',
        source: 'rom',
        platformId: 'xbox360',
        title: 'Setup Game',
        romPath: image
      },
      releases: [release('v1', '2026-01-01T00:00:00Z', 'game-setup.msi')],
      over: {
        // The setup recompilation of an Xbox 360 game (as Xerenge is), so the library's image matches it.
        loadCatalog: async () => {
          const c = catalogFixture()
          const pc = titleKeyOf('pc', 'Setup Game')
          const key = titleKeyOf('xbox360', 'Setup Game')
          c.titles.set(key, { ...c.titles.get(pc)!, key, systemId: 'xbox360', console: 'Xbox 360' })
          c.titles.delete(pc)
          c.entries.get(SETUP)!.systemId = 'xbox360'
          return c
        },
        homedir: home,
        extractXboxImage: async (_image, outDir) => {
          await fs.mkdir(outDir, { recursive: true })
          await fs.writeFile(join(outDir, 'default.xex'), 'xex')
        },
        unpackedGameSetups: [SETUP_GAME],
        originalImage: {
          plan: async () =>
            game?.romPath ? { paths: [image], totalBytes: 4 } : { refusal: 'no disc image' },
          trash: async (_gameId, recompId) => {
            trashed.push('image')
            game!.romRemoved = { at: 'now', recompId, romPath: image }
            delete game!.romPath
            return { ok: true, message: 'Moved Setup Game.xiso.iso to the Recycle Bin' }
          },
          folderPlan: async (dir) =>
            (await fs.stat(dir).catch(() => null))?.isDirectory()
              ? { totalBytes: 3 }
              : { refusal: `${dir} is not there any more` },
          trashFolder: async (dir) => {
            if (opts.folderTrashFails) return { ok: false, message: 'Nothing was deleted: no bin.' }
            await opts.duringFolderTrash?.(self!)
            trashed.push(dir)
            // The fake Recycle Bin: a folder in the test's own temp folder.
            await fs.rename(dir, join(tmp, `binned-${trashed.length}`))
            return { ok: true, message: `Moved ${dir} to the Recycle Bin` }
          }
        }
      }
    })
    game = h.game
    self = h
    await installAndWait(h, SETUP)
    if (opts.preUnpacked) {
      await fs.mkdir(gameDir(), { recursive: true })
      await fs.writeFile(join(gameDir(), 'default.xex'), 'xex')
    }
    const choose = async (program: string): Promise<void> => {
      await fs.mkdir(dirname(program), { recursive: true })
      await fs.writeFile(program, 'MZ')
      await h.service.setRecompExecutable(SETUP, program)
    }
    return {
      ...h,
      image,
      trashed,
      choose,
      async installGame(program) {
        expect(await h.service.launchRecomp(h.game.id, SETUP)).toEqual({ ok: true })
        h.spawned.at(-1)!.child.emit('exit', 0)
        await choose(program)
      }
    }
  }

  const offers = (h: Harness): Promise<RecompImageOffer[]> => h.service.getRecompImageOffers()
  const page = async (h: Harness): Promise<GameRecomps['originalImage']> =>
    (await h.service.getGameRecomps(h.game.id))?.originalImage

  it('offers the folder PlayOut unpacked, with the image, once the game is installed elsewhere', async () => {
    const h = await folderHarness()
    await h.installGame(elsewhere())
    const [offer] = await offers(h)
    expect(offer).toMatchObject({
      recompId: SETUP,
      fileName: 'Setup Game.xiso.iso',
      folder: { path: gameDir(), totalBytes: 3, kept: false }
    })
    expect(await page(h)).toEqual({
      recompId: SETUP,
      fileName: 'Setup Game.xiso.iso',
      kept: false,
      folder: { path: gameDir(), totalBytes: 3, kept: false }
    })
    // Settings › Recompilations' row offers the same, for the matched game.
    const row = (await h.service.getRecompSettings()).rows.find((r) => r.entry.id === SETUP)
    expect(row?.originalImage).toEqual({ ...(await page(h)), gameId: h.game.id })
  })

  it('never offers a folder PlayOut did not unpack', async () => {
    const h = await folderHarness({ preUnpacked: true })
    await h.installGame(elsewhere())
    expect((await offers(h))[0]).toMatchObject({ fileName: 'Setup Game.xiso.iso', folder: null })
    expect((await page(h))?.folder).toBeNull()
  })

  it('never offers the folder while the game installed around it reads it (Xerenge: bin beside game)', async () => {
    const h = await folderHarness()
    await h.installGame(around())
    const [offer] = await offers(h)
    expect(offer).toMatchObject({ fileName: 'Setup Game.xiso.iso', folder: null })
    expect(await h.service.answerRecompImageOffer(offer!.key, 'delete-folder')).toMatchObject({
      ok: false,
      message: /offers no game folder/
    })
    expect(h.trashed).toEqual([])
    expect((await page(h))?.folder).toBeNull()
  })

  it('never offers the folder when the program is inside it', async () => {
    const h = await folderHarness()
    await h.installGame(join(gameDir(), 'game.exe'))
    expect((await offers(h))[0]?.folder).toBeNull()
  })

  it('never offers the folder while the setup program is still what starts the recompilation', async () => {
    const h = await folderHarness()
    expect(await h.service.launchRecomp(h.game.id, SETUP)).toEqual({ ok: true })
    h.spawned.at(-1)!.child.emit('exit', 0)
    expect(await page(h)).toBeNull()
    await expect(h.service.askRecompImageDelete(h.game.id, SETUP)).rejects.toThrow(
      /still installs from it/
    )
  })

  it('does not offer the folder while the setup program runs', async () => {
    const h = await folderHarness()
    expect(await h.service.launchRecomp(h.game.id, SETUP)).toEqual({ ok: true })
    await h.choose(elsewhere())
    expect((await offers(h))[0]?.folder).toBeNull()
    h.spawned.at(-1)!.child.emit('exit', 0)
    // Asked again from the Recompilation page once it closed.
    expect((await h.service.askRecompImageDelete(h.game.id, SETUP)).folder).toMatchObject({
      path: gameDir()
    })
  })

  it('Delete the disc image moves the image only and remembers the folder as kept', async () => {
    const h = await folderHarness()
    await h.installGame(elsewhere())
    const [offer] = await offers(h)
    expect(await h.service.answerRecompImageOffer(offer!.key, 'delete')).toMatchObject({
      ok: true
    })
    expect(h.trashed).toEqual(['image'])
    expect((await fs.stat(gameDir())).isDirectory()).toBe(true)
    expect(await offers(h)).toEqual([])
    // No image left: the page still offers the folder (kept before), in a question of its own.
    expect(await page(h)).toEqual({
      recompId: SETUP,
      fileName: null,
      kept: false,
      folder: { path: gameDir(), totalBytes: 3, kept: true }
    })
    const again = await h.service.askRecompImageDelete(h.game.id, SETUP)
    expect(again).toMatchObject({ fileName: null, files: [], folder: { path: gameDir() } })
    expect(again.key).toBe(`${SETUP}|folder|${gameDir().toLowerCase()}`)
    expect(await h.service.answerRecompImageOffer(again.key, 'delete')).toMatchObject({
      ok: false,
      message: /offers no disc image/
    })
    expect(await h.service.answerRecompImageOffer(again.key, 'delete-folder')).toMatchObject({
      ok: true
    })
    expect(h.trashed).toEqual(['image', gameDir()])
    expect(await page(h)).toBeNull()
  })

  it('Delete the unpacked game folder moves the folder only and remembers the image as kept', async () => {
    const h = await folderHarness()
    await h.installGame(elsewhere())
    const [offer] = await offers(h)
    expect(await h.service.answerRecompImageOffer(offer!.key, 'delete-folder')).toEqual({
      ok: true,
      message: `Moved ${gameDir()} to the Recycle Bin`
    })
    expect(h.trashed).toEqual([gameDir()])
    expect(h.game.romPath).toBe(h.image)
    expect(await offers(h)).toEqual([])
    expect(await page(h)).toEqual({
      recompId: SETUP,
      fileName: 'Setup Game.xiso.iso',
      kept: true,
      folder: null
    })
  })

  it('Delete both moves the folder first, then the image', async () => {
    const h = await folderHarness()
    await h.installGame(elsewhere())
    const [offer] = await offers(h)
    expect(await h.service.answerRecompImageOffer(offer!.key, 'delete-both')).toEqual({
      ok: true,
      message: `Moved Setup Game.xiso.iso and ${gameDir()} to the Recycle Bin`
    })
    expect(h.trashed).toEqual([gameDir(), 'image'])
    expect(await page(h)).toBeNull()
  })

  it('moves nothing when the folder cannot go to the Recycle Bin', async () => {
    const h = await folderHarness({ folderTrashFails: true })
    await h.installGame(elsewhere())
    const [offer] = await offers(h)
    expect(await h.service.answerRecompImageOffer(offer!.key, 'delete-both')).toEqual({
      ok: false,
      message: 'Nothing was deleted: no bin.'
    })
    expect(h.trashed).toEqual([])
    expect(h.game.romPath).toBe(h.image)
    expect(await offers(h)).toHaveLength(1)
  })

  it('Keep it remembers both, and they are not asked again', async () => {
    const h = await folderHarness()
    await h.installGame(elsewhere())
    const [offer] = await offers(h)
    expect(await h.service.answerRecompImageOffer(offer!.key, 'keep')).toMatchObject({ ok: true })
    await h.service.setRecompExecutable(SETUP, null)
    await h.choose(elsewhere())
    expect(await offers(h)).toEqual([])
    expect(h.trashed).toEqual([])
    expect(await page(h)).toMatchObject({ kept: true, folder: { kept: true } })
  })

  it('checks again when answering: nothing moves once the game is installed around the folder', async () => {
    const h = await folderHarness()
    await h.installGame(elsewhere())
    const [offer] = await offers(h)
    await h.choose(around())
    expect(await h.service.answerRecompImageOffer(offer!.key, 'delete-both')).toMatchObject({
      ok: false,
      message: /must stay \(the game is installed around it/
    })
    expect(h.trashed).toEqual([])
    // The image part is still asked about.
    expect((await offers(h))[0]).toMatchObject({
      fileName: 'Setup Game.xiso.iso',
      folder: null
    })
  })

  it('asks about the folder on its own once it is unused, after the image was answered', async () => {
    const h = await folderHarness()
    await h.installGame(around())
    const [first] = await offers(h)
    expect(first?.folder).toBeNull()
    await h.service.answerRecompImageOffer(first!.key, 'keep')
    // Then the player installs the game elsewhere: the folder is asked about in a question of its own.
    await h.choose(elsewhere())
    const [offer] = await offers(h)
    expect(offer).toMatchObject({ fileName: null, folder: { path: gameDir(), kept: false } })
    expect(offer!.key).toBe(`${SETUP}|folder|${gameDir().toLowerCase()}`)
    expect(await h.service.answerRecompImageOffer(offer!.key, 'keep')).toMatchObject({ ok: true })
    expect(await offers(h)).toEqual([])
  })

  it('starts nothing that uses the folder from the check of a Delete answer until the folder has moved', async () => {
    let start: Awaited<ReturnType<Harness['service']['launchRecomp']>> | null = null
    const h = await folderHarness({
      duringFolderTrash: async (hh) => {
        start = await hh.service.launchRecomp(hh.game.id, SETUP)
      }
    })
    await h.installGame(elsewhere())
    const spawned = h.spawned.length
    const [offer] = await offers(h)
    expect(await h.service.answerRecompImageOffer(offer!.key, 'delete-folder')).toMatchObject({
      ok: true
    })
    expect(start).toMatchObject({ ok: false, message: /is moving .* to the Recycle Bin/ })
    expect(h.spawned).toHaveLength(spawned)
    expect(h.trashed).toEqual([gameDir()])
    // Once it moved, starts go through again.
    expect(await h.service.launchRecomp(h.game.id, SETUP)).toEqual({ ok: true })
  })

  it('Delete the unpacked game folder does not keep an image the question no longer showed', async () => {
    const h = await folderHarness()
    await h.installGame(elsewhere())
    const [offer] = await offers(h)
    // The image leaves the library while the question waits: it shows the folder alone.
    delete h.game.romPath
    const [view] = await offers(h)
    expect(view).toMatchObject({ key: offer!.key, fileName: null, folder: { path: gameDir() } })
    expect(await h.service.answerRecompImageOffer(offer!.key, 'delete-folder')).toMatchObject({
      ok: true
    })
    expect(h.trashed).toEqual([gameDir()])
    // The image comes back: it is not remembered as kept, so it is offered (not "You chose to keep it before").
    h.game.romPath = h.image
    expect(await page(h)).toMatchObject({
      fileName: 'Setup Game.xiso.iso',
      kept: false,
      folder: null
    })
  })

  it('Keep it on a question showing the folder alone keeps the folder only', async () => {
    const h = await folderHarness()
    await h.installGame(elsewhere())
    const [offer] = await offers(h)
    delete h.game.romPath
    expect(await h.service.answerRecompImageOffer(offer!.key, 'keep')).toMatchObject({ ok: true })
    h.game.romPath = h.image
    expect(await page(h)).toMatchObject({
      fileName: 'Setup Game.xiso.iso',
      kept: false,
      folder: { path: gameDir(), kept: true }
    })
  })
})

describe('recomp service: the test run after Delete', () => {
  /**
   * A harness whose game is a disc image set (mm.cue listing mm.bin) moved aside, released and restored by the real
   * held-files.ts helpers in the temp folder (the Recycle Bin is a fake that records and removes). `session`: how the
   * fake launcher's play session follows the game's process: 'child' ends with it, 'sticky' goes on (a launcher handed
   * over to the game).
   */
  async function heldHarness(
    opts: {
      session?: 'child' | 'sticky'
      writeFiles?: boolean
      testMs?: number
      /** The first 'recomp:image-offers' event after the move aside throws (a manifest write that fails then). */
      failAfterHold?: boolean
    } = {}
  ): Promise<
    Harness & {
      cue: string
      bin: string
      trashed: string[]
      held(): RecompHeldImage[]
      notes(): { ok: boolean; message: string }[]
      endSession(): void
      /** How often the service has asked the launcher whether a play session is going on. */
      sessionAsked(): number
    }
  > {
    const cue = join(tmp, 'roms', 'mm.cue')
    const bin = join(tmp, 'roms', 'mm.bin')
    if (opts.writeFiles !== false) {
      await fs.mkdir(join(tmp, 'roms'), { recursive: true })
      await fs.writeFile(cue, 'FILE "mm.bin" BINARY')
      await fs.writeFile(bin, 'disc data')
    }
    const trashed: string[] = []
    const io = {
      ...defaultHeldIo,
      trash: async (p: string): Promise<void> => {
        trashed.push(p)
        await fs.rm(p, { recursive: true, force: true })
      }
    }
    let game: Game | null = null
    let session: { gameId: string; ended: boolean } | null = null
    let sessionAsked = 0
    const tracked: Harness['tracked'] = []
    const events: Harness['events'] = []
    let heldOnce = false
    let failed = false
    const h = await harness({
      game: { romPath: cue },
      over: {
        events: {
          emit: <E extends PlayOutEventName>(name: E, payload: PlayOutEvents[E]) => {
            if (opts.failAfterHold && heldOnce && !failed && name === 'recomp:image-offers') {
              failed = true
              throw new Error('the manifest is locked')
            }
            events.push({ name, payload })
          }
        },
        imageTestMs: opts.testMs ?? 80,
        imageTestPollMs: 5,
        launcher: {
          track: (g, child) => {
            tracked.push({ game: g, child })
            const s = { gameId: g.id, ended: false }
            session = s
            if (opts.session !== 'sticky') child.once('exit', () => (s.ended = true))
          },
          running: () => {
            sessionAsked++
            return session && !session.ended ? { gameId: session.gameId, startedAt: 'now' } : null
          }
        },
        originalImage: {
          plan: async () => ({ paths: [bin, cue], totalBytes: 9 }),
          trash: async () => {
            throw new Error('a Delete answer must not trash at once')
          },
          hold: async (_gameId, recompId, holdId, o) => {
            const entries = [bin, cue].map((p) => ({ original: p, held: heldPathFor(p, holdId) }))
            await o.beforeMove(entries)
            const r = await moveAside(entries, holdId, io)
            if (!r.ok) return { ok: false, message: r.message, stuck: r.stuck }
            heldOnce = true
            game!.romRemoved = { at: 'now', recompId, romPath: cue }
            delete game!.romPath
            return { ok: true, message: 'Moved mm.cue aside', entries }
          },
          release: (entries, holdId) => trashHeld(entries, holdId, io),
          restore: async (entries, holdId, card) => {
            const r = await putBack(entries, holdId, io)
            if (card && game?.romRemoved && r.restored.some((e) => e.original === card.image)) {
              game.romPath = game.romRemoved.romPath
              delete game.romRemoved
            }
            return r
          }
        }
      }
    })
    game = h.game
    return {
      ...h,
      events,
      progress: () =>
        events.filter((e) => e.name === 'recomp:progress').map((e) => e.payload as RecompProgress),
      tracked,
      cue,
      bin,
      trashed,
      held: () => {
        const all = events.filter((e) => e.name === 'recomp:held-images')
        return (all.at(-1)?.payload as { items: RecompHeldImage[] } | undefined)?.items ?? []
      },
      notes: () =>
        events
          .filter((e) => e.name === 'recomp:held-images')
          .flatMap((e) => {
            const note = (e.payload as { note?: { ok: boolean; message: string } }).note
            return note ? [note] : []
          }),
      endSession: () => {
        if (session) session.ended = true
      },
      sessionAsked: () => sessionAsked
    }
  }

  const exists = (p: string): Promise<boolean> =>
    fs.stat(p).then(
      () => true,
      () => false
    )

  /** Install OTHER, pick its program (asked at once) and answer Delete. */
  async function deleteIt(
    h: Awaited<ReturnType<typeof heldHarness>>
  ): Promise<{ ok: boolean; message: string }> {
    await installAndWait(h, OTHER)
    await h.service.setRecompExecutable(OTHER, 'Zelda64Recompiled.exe')
    const [offer] = await h.service.getRecompImageOffers()
    expect(offer).toMatchObject({ fileName: 'mm.cue' })
    return h.service.answerRecompImageOffer(offer!.key, 'delete')
  }

  it('moves the image aside, starts the recompilation, and trashes it once it ran fine and closed', async () => {
    const h = await heldHarness()
    const answer = await deleteIt(h)
    expect(answer).toMatchObject({ ok: true })
    expect(answer.message).toContain('aside')
    // Moved aside into the hidden folder beside it (not deleted), the card kept, the recompilation started at once.
    expect(await exists(h.cue)).toBe(false)
    expect(await exists(h.bin)).toBe(false)
    const [item] = await h.service.getRecompHeldImages()
    expect(item).toMatchObject({ recompId: OTHER, fileName: 'mm.cue', state: 'testing' })
    expect(item!.files).toEqual(['mm.cue', 'mm.bin'])
    expect(h.game.romRemoved).toMatchObject({ recompId: OTHER })
    await started(h, 1)
    expect(h.trashed).toEqual([])
    // Still running after the grace period proves nothing (it may sit on a "disc image not found" box): kept aside.
    await new Promise((r) => setTimeout(r, 200))
    expect(h.trashed).toEqual([])
    expect((await h.service.getRecompHeldImages())[0]).toMatchObject({ state: 'testing' })
    // Closed normally after it ran past the grace period: the files go to the Recycle Bin, and a note says so.
    h.spawned[0]!.child.emit('exit', 0, null)
    await until(() => expect(h.notes()).toHaveLength(1))
    expect(h.notes()[0]).toEqual({
      ok: true,
      message: 'MM Port started without mm.cue; it is now in the Recycle Bin.'
    })
    expect(h.trashed.map((p) => basename(p))).toEqual(['mm.bin', 'mm.cue'])
    expect(h.trashed.every((p) => p.includes(HELD_DIR))).toBe(true)
    expect(await h.service.getRecompHeldImages()).toEqual([])
    expect(await exists(join(tmp, 'roms', HELD_DIR))).toBe(false)
    expect(await h.service.getRecompImageOffers()).toEqual([])
  })

  it('asks when it closes right after it starts, and Restore puts every file back exactly', async () => {
    // A grace period this test cannot outlast: with the 80 ms of the other tests, a loaded PC gets to the exit below
    // after it, and the reason then reads "closed after … with an error" instead.
    const h = await heldHarness({ testMs: 60_000 })
    await deleteIt(h)
    await started(h, 1)
    h.spawned[0]!.child.emit('exit', 3221225477, null)
    await until(() => expect(h.held()[0]?.state).toBe('crashed'))
    const [item] = await h.service.getRecompHeldImages()
    expect(item).toMatchObject({ state: 'crashed', fileName: 'mm.cue' })
    expect(item!.reason).toMatch(/^MM Port closed \d+ s after it started \(exit code 3221225477\)$/)
    expect(item!.decidedAt).toBeTruthy()
    expect(h.trashed).toEqual([])
    expect(await exists(h.cue)).toBe(false)

    expect(await h.service.answerRecompHeldImage(item!.holdId, 'restore')).toEqual({
      ok: true,
      message: 'Restored mm.cue'
    })
    expect(await fs.readFile(h.cue, 'utf8')).toBe('FILE "mm.bin" BINARY')
    expect(await fs.readFile(h.bin, 'utf8')).toBe('disc data')
    expect(await exists(join(tmp, 'roms', HELD_DIR))).toBe(false)
    expect(h.game.romRemoved).toBeUndefined()
    expect(h.game.romPath).toBe(h.cue)
    expect(await h.service.getRecompHeldImages()).toEqual([])
    // Kept for that recompilation: never offered again (the page shows it as kept).
    expect(await h.service.getRecompImageOffers()).toEqual([])
    expect((await h.service.getGameRecomps(h.game.id))?.originalImage).toMatchObject({
      recompId: OTHER,
      fileName: 'mm.cue',
      kept: true
    })
    expect(h.trashed).toEqual([])
  })

  it('a start that fails is a crash too; Delete anyway trashes the held files', async () => {
    const h = await heldHarness()
    await installAndWait(h, OTHER)
    await h.service.setRecompExecutable(OTHER, 'Zelda64Recompiled.exe')
    // The program is gone: the start fails.
    const rec = (await h.service.getRecompSettings()).rows[0]!.installed
    await fs.rm(join(rec.dir, 'Zelda64Recompiled.exe'))
    const [offer] = await h.service.getRecompImageOffers()
    await h.service.answerRecompImageOffer(offer!.key, 'delete')
    await until(() => expect(h.held()[0]?.state).toBe('crashed'))
    expect(h.held()[0]!.reason).toMatch(/^MM Port did not start: /)
    expect(await h.service.answerRecompHeldImage(h.held()[0]!.holdId, 'delete')).toEqual({
      ok: true,
      message: 'Moved mm.cue to the Recycle Bin'
    })
    expect(h.trashed.map((p) => basename(p))).toEqual(['mm.bin', 'mm.cue'])
    expect(await h.service.getRecompHeldImages()).toEqual([])
    expect(h.game.romRemoved).toMatchObject({ recompId: OTHER })
  })

  it('a launcher that hands over to the game (its process exits, the session goes on) passes', async () => {
    const h = await heldHarness({ session: 'sticky' })
    await deleteIt(h)
    await started(h, 1)
    h.spawned[0]!.child.emit('exit', 0, null)
    // The game it handed over to keeps running: nothing judged yet.
    await new Promise((r) => setTimeout(r, 200))
    expect(h.trashed).toEqual([])
    // The check has to see the session going on past the grace period, and it asks only once the start is noted
    // (a file write: on a loaded PC that can take longer than the wait above, and a session that ended before the
    // check first asked reads as "closed right after it started"). Three more answers: the after-play wait asks
    // too, in turn with the check, so one of them is the check's.
    const asked = h.sessionAsked()
    await until(() => expect(h.sessionAsked()).toBeGreaterThanOrEqual(asked + 3))
    h.endSession()
    await until(() => expect(h.notes()).toHaveLength(1))
    expect(h.notes()[0]!.ok).toBe(true)
    expect(h.trashed).toHaveLength(2)
  })

  it('still running past the grace period, then closing with an error code, is a crash (asked, not trashed)', async () => {
    const h = await heldHarness()
    await deleteIt(h)
    await started(h, 1)
    // A "disc image not found" box keeps it open past the grace period.
    await new Promise((r) => setTimeout(r, 200))
    expect(h.trashed).toEqual([])
    h.spawned[0]!.child.emit('exit', 1, null)
    await until(() => expect(h.held()[0]?.state).toBe('crashed'))
    expect(h.held()[0]!.reason).toMatch(
      /^MM Port closed after \d+ s with an error \(exit code 1\)$/
    )
    expect(h.trashed).toEqual([])
    expect(h.notes()).toEqual([])
    expect(await exists(h.cue)).toBe(false)
  })

  it('a manifest write that fails after the move aside still runs the check (never stuck as testing)', async () => {
    const h = await heldHarness({ failAfterHold: true })
    await expect(deleteIt(h)).rejects.toThrow('the manifest is locked')
    // The test still starts, and its verdict is asked about as usual.
    await started(h, 1)
    h.spawned[0]!.child.emit('exit', 3221225477, null)
    await until(() => expect(h.held()[0]?.state).toBe('crashed'))
    expect(await h.service.answerRecompHeldImage(h.held()[0]!.holdId, 'restore')).toMatchObject({
      ok: true
    })
    expect(await fs.readFile(h.cue, 'utf8')).toBe('FILE "mm.bin" BINARY')
    expect(await exists(join(tmp, 'roms', HELD_DIR))).toBe(false)
  })

  it('a start refused for another reason judges nothing: kept aside until Restore, Test again or Delete anyway', async () => {
    const h = await heldHarness()
    await installAndWait(h, OTHER)
    await h.service.setRecompExecutable(OTHER, 'Zelda64Recompiled.exe')
    // Already being played: the check cannot start it.
    expect(await h.service.launchRecomp(h.game.id, OTHER)).toEqual({ ok: true })
    const [offer] = await h.service.getRecompImageOffers()
    await h.service.answerRecompImageOffer(offer!.key, 'delete')
    await until(() => expect(h.held()[0]?.state).toBe('not-tested'))
    expect(h.held()[0]!.reason).toBe('MM Port is already running.')
    expect(h.trashed).toEqual([])
    // Closed (its after-play work done): Test again starts it and it passes.
    const changes = h.events.filter((e) => e.name === 'recomp:changed').length
    h.spawned[0]!.child.emit('exit', 0, null)
    await until(() =>
      expect(h.events.filter((e) => e.name === 'recomp:changed').length).toBeGreaterThan(changes)
    )
    expect(await h.service.answerRecompHeldImage(h.held()[0]!.holdId, 'retry')).toMatchObject({
      ok: true
    })
    await started(h, 2)
    await new Promise((r) => setTimeout(r, 120))
    h.spawned[1]!.child.emit('exit', 0, null)
    await until(() => expect(h.notes()).toHaveLength(1))
    expect(h.trashed).toHaveLength(2)
  })

  it('a check PlayOut did not finish is asked about at the next start, and Restore still works', async () => {
    const first = await heldHarness({ testMs: 60_000 })
    await deleteIt(first)
    await started(first, 1)
    expect((await first.service.getRecompHeldImages())[0]).toMatchObject({ state: 'testing' })
    // PlayOut closes during the check: nothing is trashed, nothing is put back.
    first.service.dispose()
    await new Promise((r) => setTimeout(r, 30))
    expect(first.trashed).toEqual([])
    expect(await exists(first.cue)).toBe(false)

    const again = await heldHarness({ writeFiles: false })
    const [item] = await again.service.getRecompHeldImages()
    expect(item).toMatchObject({ state: 'interrupted', fileName: 'mm.cue' })
    expect(item!.reason).toBe('PlayOut closed before the check finished')
    expect(await again.service.answerRecompHeldImage(item!.holdId, 'restore')).toMatchObject({
      ok: true
    })
    expect(await fs.readFile(again.cue, 'utf8')).toBe('FILE "mm.bin" BINARY')
    expect(await fs.readFile(again.bin, 'utf8')).toBe('disc data')
    expect(await again.service.getRecompHeldImages()).toEqual([])
  })

  it('Restore never overwrites a file that is at the original path now', async () => {
    const h = await heldHarness()
    await deleteIt(h)
    await started(h, 1)
    h.spawned[0]!.child.emit('exit', 1, null)
    await until(() => expect(h.held()[0]?.state).toBe('crashed'))
    await fs.writeFile(h.cue, 'a new file')
    const result = await h.service.answerRecompHeldImage(h.held()[0]!.holdId, 'restore')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('never overwrites')
    expect(await fs.readFile(h.cue, 'utf8')).toBe('a new file')
    expect(await exists(h.bin)).toBe(false)
    // Still asked about, still held.
    expect(await h.service.getRecompHeldImages()).toHaveLength(1)
    expect(h.game.romRemoved).toBeTruthy()
  })

  it('refuses an answer while the check runs, and an unknown hold', async () => {
    const h = await heldHarness({ testMs: 60_000 })
    await deleteIt(h)
    const [item] = await h.service.getRecompHeldImages()
    expect(await h.service.answerRecompHeldImage(item!.holdId, 'delete')).toMatchObject({
      ok: false
    })
    expect(await h.service.answerRecompHeldImage('nothing-here', 'restore')).toEqual({
      ok: false,
      message: 'That question was already answered.'
    })
    expect(h.trashed).toEqual([])
  })
})

describe("a recompilation's own library card", () => {
  /** A library holding only games of other titles, with the cards RecompGames makes put in it. */
  function ownCardsLibrary(): {
    library: RecompLibrary
    recompGames: NonNullable<RecompServiceDeps['recompGames']>
    games: Map<string, Game>
    added: Parameters<NonNullable<RecompServiceDeps['recompGames']>['add']>[0][]
    absorbed: [string, string][]
  } {
    const unrelated = makeGame({
      id: 'rom:n64:other',
      title: 'Unrelated Game',
      externalId: 'other'
    })
    const games = new Map<string, Game>([[unrelated.id, unrelated]])
    const added: Parameters<NonNullable<RecompServiceDeps['recompGames']>['add']>[0][] = []
    const absorbed: [string, string][] = []
    const base = fakeLibrary([])
    const library: RecompLibrary = {
      ...base,
      games: () => [...games.values()],
      getGame: (id: string) => games.get(id),
      applyMetadata: ((id: string, update: { metadata?: Partial<GameMetadata> }) => {
        const g = games.get(id)!
        g.metadata = { ...g.metadata, ...update.metadata }
        return g
      }) as RecompLibrary['applyMetadata'],
      clearMetadataField: ((id: string, key: keyof GameMetadata) => {
        const g = games.get(id)
        if (!g || g.metadata[key] === undefined) return false
        const next = { ...g.metadata }
        delete next[key]
        g.metadata = next
        return true
      }) as RecompLibrary['clearMetadataField']
    }
    const recompGames: NonNullable<RecompServiceDeps['recompGames']> = {
      add: (input) => {
        added.push(input)
        const id = `rom:${input.platformId}:own`
        if (games.has(id)) return null
        games.set(
          id,
          makeGame({
            id,
            title: input.title,
            platformId: input.platformId,
            installed: false,
            romPath: undefined,
            metadata: { recomp: input.recomp },
            extra: { recompOnly: input.titleKey }
          })
        )
        return id
      },
      remove: (id) => void games.delete(id),
      absorb: (from, into) => {
        absorbed.push([from, into])
        games.delete(from)
      },
      addEntry: (input) => {
        const id = `rom:${input.platformId}:added-${input.recompId}`
        if (!games.has(id))
          games.set(
            id,
            makeGame({
              id,
              title: input.title,
              platformId: input.platformId,
              installed: false,
              romPath: undefined,
              favorite: input.favorite,
              metadata: { recomp: input.recomp },
              extra: { recompAdded: input.recompId }
            })
          )
        return id
      },
      setFavorite: (id, favorite) => {
        const g = games.get(id)
        if (g) g.favorite = favorite
      }
    }
    return { library, recompGames, games, added, absorbed }
  }

  it('is added when its game is not in the library, and leaves with its last recompilation', async () => {
    const own = ownCardsLibrary()
    const h = await harness({ over: { library: own.library, recompGames: own.recompGames } })
    await installAndWait(h, ZELDA)
    await until(() => expect(own.games.has('rom:n64:own')).toBe(true))
    expect(own.added[0]).toMatchObject({
      titleKey: KEY,
      title: GAME_NAME,
      platformId: 'n64',
      recomp: { titleKey: KEY, installed: [ZELDA] }
    })
    // Installing a second version of the same game adds no second card.
    await installAndWait(h, OTHER)
    expect([...own.games.keys()].filter((id) => id === 'rom:n64:own')).toHaveLength(1)
    expect(own.games.get('rom:n64:own')!.metadata.recomp?.installed.sort()).toEqual(
      [ZELDA, OTHER].sort()
    )
    // Deleting one keeps the card (the other is still installed); deleting the last removes it.
    await h.service.uninstallRecomp(ZELDA)
    expect(own.games.has('rom:n64:own')).toBe(true)
    await h.service.uninstallRecomp(OTHER)
    expect(own.games.has('rom:n64:own')).toBe(false)
  })

  it('keeps a card filed under an old title key (no second card), and moves it to the new key', async () => {
    const own = ownCardsLibrary()
    const h = await harness({ over: { library: own.library, recompGames: own.recompGames } })
    await installAndWait(h, ZELDA)
    await until(() => expect(own.games.has('rom:n64:own')).toBe(true))
    // The card was made under a key the catalog no longer has (it files the game under another key now).
    const card = own.games.get('rom:n64:own')!
    card.extra = { recompOnly: 'n64:old key' }
    card.metadata = { recomp: { ...card.metadata.recomp!, titleKey: 'n64:old key' } }
    await installAndWait(h, OTHER)
    expect(own.added).toHaveLength(1)
    expect(own.games.has('rom:n64:own')).toBe(true)
    expect(own.games.get('rom:n64:own')!.metadata.recomp?.titleKey).toBe(KEY)
  })

  it('merges (not deletes) its card when the original arrives as its last recompilation is deleted', async () => {
    const own = ownCardsLibrary()
    const h = await harness({ over: { library: own.library, recompGames: own.recompGames } })
    await installAndWait(h, ZELDA)
    await until(() => expect(own.games.has('rom:n64:own')).toBe(true))
    const original = makeGame({ id: 'rom:n64:mm', romPath: h.rom })
    own.games.set(original.id, original)
    await h.service.uninstallRecomp(ZELDA)
    expect(own.absorbed).toEqual([['rom:n64:own', 'rom:n64:mm']])
  })

  it('does not count a store game that is only owned (not installed) as the game', async () => {
    const own = ownCardsLibrary()
    own.games.set(
      'gog:setup',
      makeGame({
        id: 'gog:setup',
        source: 'gog',
        title: 'Setup Game',
        platformId: 'pc',
        installed: false,
        owned: true
      })
    )
    const h = await harness({ over: { library: own.library, recompGames: own.recompGames } })
    await installAndWait(h, SETUP)
    await until(() => expect(own.added.map((a) => a.title)).toEqual(['Setup Game']))
  })

  it('is not added when the game is in the library, and merges into it when the game is added', async () => {
    const own = ownCardsLibrary()
    const h = await harness({ over: { library: own.library, recompGames: own.recompGames } })
    await installAndWait(h, ZELDA)
    await until(() => expect(own.games.has('rom:n64:own')).toBe(true))
    // The original's ROM is scanned in: the next match folds the recompilation's card into it.
    const original = makeGame({ id: 'rom:n64:mm', romPath: h.rom })
    own.games.set(original.id, original)
    await h.service.setPreferredRecomp(original.id, ZELDA).catch(() => undefined)
    await h.service.installRecomp(OTHER)
    await until(() => expect(own.absorbed).toEqual([['rom:n64:own', 'rom:n64:mm']]))
    expect(own.games.has('rom:n64:own')).toBe(false)
    expect(own.games.get('rom:n64:mm')!.metadata.recomp?.installed).toContain(ZELDA)
    expect(own.added).toHaveLength(1)
  })

  it('adds one recompilation to the library from the browser, keeps its favourite, and makes no second card', async () => {
    const own = ownCardsLibrary()
    const h = await harness({ over: { library: own.library, recompGames: own.recompGames } })
    // A favourite in the browser alone: nothing is added to the library.
    await h.service.setRecompFavorite(ZELDA, true)
    expect([...own.games.values()].some((g) => g.extra?.recompAdded)).toBe(false)
    let browse = await h.service.browseRecomps()
    const entry = (): { favorite: boolean; libraryGameId: string | null } =>
      browse.titles.flatMap((t) => t.entries).find((e) => e.id === ZELDA)!
    expect(entry()).toMatchObject({ favorite: true, libraryGameId: null })
    // Add to library: its own card, a favourite, not installed.
    const gameId = await h.service.addRecompToLibrary(ZELDA)
    const card = own.games.get(gameId)!
    expect(card).toMatchObject({ favorite: true, installed: false, extra: { recompAdded: ZELDA } })
    expect(card.metadata.recomp).toMatchObject({ installed: [], preferred: ZELDA })
    expect(await h.service.addRecompToLibrary(ZELDA)).toBe(gameId)
    browse = await h.service.browseRecomps()
    expect(entry().libraryGameId).toBe(gameId)
    // Installed: its card plays it; no recompilation-only card is made beside it.
    await installAndWait(h, ZELDA)
    await until(() => expect(own.games.get(gameId)!.metadata.recomp?.installed).toEqual([ZELDA]))
    expect(own.added).toHaveLength(0)
    // Unfavourited in the browser: the card follows.
    await h.service.setRecompFavorite(ZELDA, false)
    expect(own.games.get(gameId)!.favorite).toBe(false)
    // Favourited on the card in the library: the browser follows.
    own.games.get(gameId)!.favorite = true
    h.service.noteLibraryFavorite(gameId)
    await until(async () => {
      browse = await h.service.browseRecomps()
      expect(entry().favorite).toBe(true)
    })
  })

  it('keeps a card for another installed recompilation of a game whose added one is not installed', async () => {
    const own = ownCardsLibrary()
    const h = await harness({ over: { library: own.library, recompGames: own.recompGames } })
    const added = await h.service.addRecompToLibrary(OTHER)
    await installAndWait(h, ZELDA)
    // ZELDA (installed) still gets a card of its own that plays it; OTHER's card still offers Install.
    await until(() => expect(own.games.has('rom:n64:own')).toBe(true))
    expect(own.games.get('rom:n64:own')!.metadata.recomp?.installed).toContain(ZELDA)
    expect(own.games.get(added)!.metadata.recomp?.installed).toEqual([])
    expect(own.absorbed).toEqual([])
  })

  it('waits for two starts with the arrived original before the disc image question', async () => {
    const own = ownCardsLibrary()
    const h = await harness({ over: { library: own.library, recompGames: own.recompGames } })
    await installAndWait(h, ZELDA)
    await until(() => expect(own.games.has('rom:n64:own')).toBe(true))
    const manifest = async (): Promise<InstalledRecomp | undefined> =>
      (await createRecompState(h.root).read()).installed[ZELDA]
    // The original arrives (downloaded from a paired PC): the question waits for two starts with it.
    own.games.set('rom:n64:mm', makeGame({ id: 'rom:n64:mm', romPath: h.rom }))
    await h.service.installRecomp(OTHER)
    await until(() => expect(own.absorbed).toHaveLength(1))
    await until(async () => expect((await manifest())?.imageAskAfter).toBe(2))
    expect(await h.service.launchRecomp('rom:n64:mm', ZELDA)).toEqual({ ok: true })
    await until(async () => expect((await manifest())?.imageAskAfter).toBe(1))
  })
})

describe('recomp service: achievements', () => {
  /** The catalog with Zelda as an Xbox 360 recompilation the catalog gives a title id and user data folder for. */
  function x360Catalog(): RecompCatalog {
    const c = catalogFixture()
    const zelda = c.entries.get(ZELDA)!
    c.entries.set(ZELDA, {
      ...zelda,
      systemId: 'xbox360',
      rl: { id: 'zelda-x360', titleId: '4D5307E6', achievementsFolder: '{game}\\userdata' }
    })
    return c
  }

  it('marks the installed recompilations PlayOut reads achievements of, and says where to read them', async () => {
    const afterPlayed = vi.fn()
    const h = await harness({ over: { loadCatalog: async () => x360Catalog(), afterPlayed } })
    await h.service.refreshRecompCatalog()
    expect(h.game.metadata.recomp?.achievements).toBeUndefined()
    await installAndWait(h, ZELDA)
    await until(() => expect(h.game.metadata.recomp?.achievements).toEqual([ZELDA]))
    const row = (await h.service.getRecompSettings()).rows[0]!
    expect(await h.service.achievementSource(ZELDA)).toMatchObject({
      recompId: ZELDA,
      titleId: '4D5307E6',
      folder: '{game}\\userdata',
      install: row.installed.dir,
      saveTemplates: [],
      gameFiles: []
    })
    // Not installed, or no achievements PlayOut can read: nothing.
    expect(await h.service.achievementSource(OTHER)).toBeNull()
    // A play session's end has its achievements read again.
    expect(await h.service.launchRecomp(h.game.id)).toEqual({ ok: true })
    h.spawned[0]!.child.emit('exit', 0)
    await until(() => expect(afterPlayed).toHaveBeenCalledWith(ZELDA))
  })

  it('leaves recompilations of other consoles unmarked', async () => {
    const h = await harness()
    await installAndWait(h, ZELDA)
    await until(() => expect(h.game.metadata.recomp?.installed).toEqual([ZELDA]))
    expect(h.game.metadata.recomp?.achievements).toBeUndefined()
    expect(await h.service.achievementSource(ZELDA)).toBeNull()
  })
})
