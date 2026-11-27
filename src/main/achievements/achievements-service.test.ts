import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import type {
  AchievementsInfo,
  RetroAchievementsStatus,
  ScannedGame,
  Settings
} from '../../shared/types'
import { RA_NONE } from '../../shared/ra-consoles'
import { EventBus } from '../events'
import { LibraryService } from '../services/library-service'
import { LibraryStore } from '../store/library-store'
import { SessionsStore } from '../store/sessions-store'
import { SettingsStore } from '../store/settings-store'
import {
  createAchievementsService,
  RA_SOURCE,
  type AchievementsOptions,
  type AchievementsService
} from './achievements-service'
import { RaAuthError, type RaGame, type RaProfile, type RaProgress } from './retroachievements'
import { SteamAuthError, type SteamCredential, type SteamProgress } from './steam'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

type Opt<K extends keyof AchievementsOptions> = NonNullable<AchievementsOptions[K]>

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out')
    await sleep(5)
  }
}

function scanned(overrides: Partial<ScannedGame> = {}): ScannedGame {
  return {
    source: 'steam',
    externalId: '620',
    platformId: 'steam',
    title: 'Portal 2',
    launch: { kind: 'uri', uri: 'steam://rungameid/620' },
    tracking: { mode: 'installDir', installDir: 'C:\\Steam\\steamapps\\common\\Portal 2' },
    extra: { steamAppId: 620 },
    ...overrides
  }
}

const EPIC_WITH_APPID = scanned({
  source: 'epic',
  externalId: 'hades',
  platformId: 'epic',
  title: 'Hades',
  extra: { steamAppId: 1145360 },
  launch: { kind: 'uri', uri: 'com.epicgames.launcher://apps/hades' }
})
const EPIC_NO_APPID = scanned({
  source: 'epic',
  externalId: 'fortnite',
  platformId: 'epic',
  title: 'Fortnite',
  extra: undefined,
  launch: { kind: 'uri', uri: 'com.epicgames.launcher://apps/fortnite' }
})

/** A ROM scan entry whose file exists in the temp dir (the hash cache stats it). */
async function rom(file: string, title: string, systemId = 'snes'): Promise<ScannedGame> {
  const romPath = join(dir, 'roms', file)
  await fs.mkdir(join(dir, 'roms'), { recursive: true })
  await fs.writeFile(romPath, `rom data of ${file}`)
  return {
    source: 'rom',
    externalId: `${systemId}/${file}`,
    platformId: systemId,
    title,
    romPath,
    launch: { kind: 'emulator', systemId, romPath },
    tracking: { mode: 'spawned' }
  }
}

function raGame(id: number, title: string, achievements: number, hashes: string[] = []): RaGame {
  return { id, title, consoleId: 3, achievements, points: achievements * 5, hashes }
}

const PROFILE: RaProfile = { user: 'Jeremy', points: 1234, softcorePoints: 56 }

const SNES_GAMES: RaGame[] = [
  raGame(228, 'Super Mario World', 96, ['aaa111']),
  raGame(319, 'Chrono Trigger', 77),
  raGame(400, 'Mega Man X', 40),
  raGame(401, 'Mega Man X', 12),
  raGame(500, '~Hack~ Super Metroid', 30),
  raGame(600, 'Donkey Kong Country', 0)
]

const PROGRESS: RaProgress[] = [{ gameId: 319, unlocked: 20, unlockedHardcore: 10, total: 77 }]

const listInfo = (unlocked: number, total: number): AchievementsInfo => ({
  total,
  unlocked,
  list: []
})

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let dir: string
let library: LibraryService
let settings: SettingsStore
let events: EventBus
let changed: string[][]
let statuses: RetroAchievementsStatus[]
let service: AchievementsService | null
let fetchStub: ReturnType<typeof vi.fn>

function patchSettings(patch: (s: Settings) => void): void {
  settings.mutate(patch)
}

const setSteamKey = (): void =>
  patchSettings((s) => {
    s.scrapers.steam.apiKey = ' KEY '
    s.scrapers.steam.steamId64 = '7656119'
  })

const setRaCreds = (username = 'Jeremy', apiKey = 'ra-key'): void =>
  patchSettings((s) => {
    s.scrapers.retroachievements = { username, apiKey }
  })

function createService(options: AchievementsOptions = {}): AchievementsService {
  service = createAchievementsService(
    { settings, library, events, log, cacheDir: join(dir, 'achievements') },
    { settingsDelayMs: 5, ...options }
  )
  return service
}

/** RetroAchievements fakes answering from the fixtures; overridable per test. */
type RaFakes = {
  [K in 'raProfile' | 'raGameList' | 'raCompletion' | 'raGame' | 'hashRom']: Mock<Opt<K>>
}

function raFakes(overrides: Partial<RaFakes> = {}): RaFakes {
  const fakes: RaFakes = {
    raProfile: vi.fn<Opt<'raProfile'>>(async () => PROFILE),
    raGameList: vi.fn<Opt<'raGameList'>>(async () => SNES_GAMES),
    raCompletion: vi.fn<Opt<'raCompletion'>>(async () => PROGRESS),
    raGame: vi.fn<Opt<'raGame'>>(async (id) => ({
      ...listInfo(id === 319 ? 21 : 0, id === 319 ? 77 : 96),
      provider: 'retroachievements' as const
    })),
    hashRom: vi.fn<Opt<'hashRom'>>(async (path) =>
      basename(path) === 'smw.sfc' ? 'aaa111' : 'ffff00'
    )
  }
  return { ...fakes, ...overrides }
}

/** The ROMs of the signed-in sync, by role. */
async function addRoms(): Promise<
  Record<'smw' | 'chrono' | 'megaman' | 'metroid' | 'dkc', string>
> {
  const scans = [
    // Matched by hash only: the scanned title matches nothing.
    await rom('smw.sfc', 'SMW Cart Dump'),
    await rom('Chrono Trigger (USA).sfc', 'Chrono Trigger (USA)'),
    await rom('Mega Man X (USA).sfc', 'Mega Man X (USA)'),
    await rom('Super Metroid (USA).sfc', 'Super Metroid (USA)'),
    await rom('Donkey Kong Country (USA).sfc', 'Donkey Kong Country (USA)')
  ]
  const ids = library.mergeScan('rom', scans).newGameIds
  const byPath = (file: string): string =>
    ids.find((id) => library.getGame(id)?.romPath?.endsWith(file))!
  return {
    smw: byPath('smw.sfc'),
    chrono: byPath('Chrono Trigger (USA).sfc'),
    megaman: byPath('Mega Man X (USA).sfc'),
    metroid: byPath('Super Metroid (USA).sfc'),
    dkc: byPath('Donkey Kong Country (USA).sfc')
  }
}

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-ach-'))
  events = new EventBus()
  changed = []
  statuses = []
  events.on('library:changed', (p) => {
    if (p.reason === 'metadata') changed.push(p.gameIds ?? [])
  })
  events.on('retroachievements:status', (s) => statuses.push(s))
  const libStore = new LibraryStore(join(dir, 'library.json'))
  const sessions = new SessionsStore(join(dir, 'sessions.json'))
  settings = new SettingsStore(join(dir, 'settings.json'))
  await Promise.all([libStore.load(), sessions.load(), settings.load()])
  library = new LibraryService(libStore, sessions, events)
  service = null
  // Nothing in here may reach the network: every call goes through the injected fakes.
  fetchStub = vi.fn(async () => {
    throw new Error('unexpected network call')
  })
  vi.stubGlobal('fetch', fetchStub)
})
afterEach(async () => {
  service?.dispose()
  expect(fetchStub).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await fs.rm(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Steam
// ---------------------------------------------------------------------------

describe('syncSteam', () => {
  it('does nothing without a Settings key or a signed-in account', async () => {
    library.mergeScan('steam', [scanned()])
    changed = []
    const steamProgress = vi.fn<Opt<'steamProgress'>>(async () => new Map())
    const svc = createService({ steamProgress })
    await svc.syncSteam()
    // An account that has no token stored is no credential either.
    svc.useSteamAccount(async () => null)
    await svc.syncSteam()
    expect(steamProgress).not.toHaveBeenCalled()
    expect(library.getGame('steam:620')?.metadata.achievements).toBeUndefined()
    expect(changed).toEqual([])
  })

  it('writes counts for every game with a Steam app id using the Settings key, in one event', async () => {
    library.mergeScan('steam', [
      scanned(),
      scanned({ externalId: '440', title: 'Team Fortress 2', extra: { steamAppId: 440 } })
    ])
    library.mergeScan('epic', [EPIC_WITH_APPID, EPIC_NO_APPID])
    library.mergeScan('rom', [await rom('smw.sfc', 'Super Mario World')])
    changed = []
    setSteamKey()
    const answers = new Map<number, SteamProgress>([
      [620, { unlocked: 3, total: 51 }],
      [440, { unlocked: 0, total: 0 }],
      [1145360, { unlocked: 49, total: 49 }]
    ])
    const steamProgress = vi.fn<Opt<'steamProgress'>>(async () => answers)
    const svc = createService({ steamProgress })
    await svc.syncSteam()

    expect(steamProgress).toHaveBeenCalledTimes(1)
    const [appIds, credential] = steamProgress.mock.calls[0]
    expect([...appIds].sort((a, b) => a - b)).toEqual([440, 620, 1145360])
    expect(credential).toEqual({ steamId64: '7656119', key: 'KEY' })
    expect(library.getGame('steam:620')?.metadata.achievements).toMatchObject({
      unlocked: 3,
      total: 51
    })
    expect(library.getGame('epic:hades')?.metadata.achievements).toMatchObject({
      unlocked: 49,
      total: 49
    })
    // No achievements at all: nothing to show.
    expect(library.getGame('steam:440')?.metadata.achievements).toBeUndefined()
    expect(library.getGame('epic:fortnite')?.metadata.achievements).toBeUndefined()
    expect(changed).toHaveLength(1)
    expect([...changed[0]].sort()).toEqual(['epic:hades', 'steam:620'])

    // Unchanged counts are not written again.
    const before = library.getGame('steam:620')?.metadata.achievements?.updatedAt
    await sleep(5)
    await svc.syncSteam()
    expect(steamProgress).toHaveBeenCalledTimes(2)
    expect(changed).toHaveLength(1)
    expect(library.getGame('steam:620')?.metadata.achievements?.updatedAt).toBe(before)

    // A changed count is.
    answers.set(620, { unlocked: 4, total: 51 })
    await svc.syncSteam()
    expect(changed).toEqual([changed[0], ['steam:620']])
    expect(library.getGame('steam:620')?.metadata.achievements?.unlocked).toBe(4)
  })

  it("uses the signed-in account's access token without a Settings key", async () => {
    library.mergeScan('steam', [scanned()])
    const account = vi.fn(async (refresh: boolean): Promise<SteamCredential> => ({
      steamId64: '7656119',
      accessToken: refresh ? 'fresh' : 'stored'
    }))
    const steamProgress = vi.fn<Opt<'steamProgress'>>(
      async () => new Map([[620, { unlocked: 1, total: 51 }]])
    )
    const svc = createService({ steamProgress })
    svc.useSteamAccount(account)
    await svc.syncSteam()
    expect(account.mock.calls).toEqual([[false]])
    expect(steamProgress.mock.calls[0][1]).toEqual({ steamId64: '7656119', accessToken: 'stored' })
    expect(library.getGame('steam:620')?.metadata.achievements).toMatchObject({
      unlocked: 1,
      total: 51
    })
  })

  it('mints a new access token once when Steam refuses the stored one', async () => {
    library.mergeScan('steam', [scanned()])
    const account = vi.fn(async (refresh: boolean): Promise<SteamCredential> => ({
      steamId64: '7656119',
      accessToken: refresh ? 'fresh' : 'stored'
    }))
    const steamProgress = vi.fn<Opt<'steamProgress'>>(async (_ids, credential) => {
      if ('accessToken' in credential && credential.accessToken === 'stored')
        throw new SteamAuthError()
      return new Map([[620, { unlocked: 2, total: 51 }]])
    })
    const svc = createService({ steamProgress })
    svc.useSteamAccount(account)
    await svc.syncSteam()
    expect(account.mock.calls).toEqual([[false], [true]])
    expect(steamProgress).toHaveBeenCalledTimes(2)
    expect(library.getGame('steam:620')?.metadata.achievements?.unlocked).toBe(2)

    // Refused again with the fresh token: given up (no third try), nothing written, nothing thrown.
    library.clearAchievements(['steam:620'])
    account.mockClear()
    steamProgress.mockClear()
    steamProgress.mockRejectedValue(new SteamAuthError())
    await expect(svc.syncSteam()).resolves.toBeUndefined()
    expect(account.mock.calls).toEqual([[false], [true]])
    expect(steamProgress).toHaveBeenCalledTimes(2)
    expect(library.getGame('steam:620')?.metadata.achievements).toBeUndefined()
  })

  it('falls back to the signed-in account when Steam refuses the Settings key', async () => {
    library.mergeScan('steam', [scanned()])
    setSteamKey()
    const steamProgress = vi.fn<Opt<'steamProgress'>>(async (_ids, credential) => {
      if ('key' in credential) throw new SteamAuthError()
      return new Map([[620, { unlocked: 7, total: 51 }]])
    })
    const account = vi.fn(async (): Promise<SteamCredential> => ({
      steamId64: '7656119',
      accessToken: 'stored'
    }))
    const svc = createService({ steamProgress })
    svc.useSteamAccount(account)
    await svc.syncSteam()
    expect(steamProgress.mock.calls.map((c) => c[1])).toEqual([
      { steamId64: '7656119', key: 'KEY' },
      { steamId64: '7656119', accessToken: 'stored' }
    ])
    expect(account.mock.calls).toEqual([[false]])
    expect(library.getGame('steam:620')?.metadata.achievements?.unlocked).toBe(7)
  })

  it('syncs again once a new Settings key settles', async () => {
    library.mergeScan('steam', [scanned()])
    const steamProgress = vi.fn<Opt<'steamProgress'>>(
      async () => new Map([[620, { unlocked: 5, total: 51 }]])
    )
    createService({ steamProgress })
    setSteamKey()
    await until(() => library.getGame('steam:620')?.metadata.achievements !== undefined)
    expect(steamProgress).toHaveBeenCalledTimes(1)
    expect(library.getGame('steam:620')?.metadata.achievements?.unlocked).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// RetroAchievements
// ---------------------------------------------------------------------------

describe('syncRetro: account', () => {
  it('reports signed-out without a username and key', async () => {
    const fakes = raFakes()
    const svc = createService(fakes)
    expect(svc.retroStatus()).toEqual({ state: 'signed-out', revision: expect.any(Number) })
    setRaCreds('Jeremy', '   ')
    await expect(svc.syncRetro()).resolves.toEqual({
      state: 'signed-out',
      revision: expect.any(Number)
    })
    expect(fakes.raProfile).not.toHaveBeenCalled()
    expect(statuses.at(-1)).toEqual({ state: 'signed-out', revision: expect.any(Number) })
  })

  it('reports invalid when RetroAchievements rejects the key or has no such user', async () => {
    setRaCreds()
    const fakes = raFakes({
      raProfile: vi.fn<Opt<'raProfile'>>(async () => {
        throw new RaAuthError()
      })
    })
    const svc = createService(fakes)
    const rejected = await svc.syncRetro()
    expect(rejected.state).toBe('invalid')
    expect(rejected.message).toMatch(/rejected/)
    expect(fakes.raGameList).not.toHaveBeenCalled()
    expect(statuses.map((s) => s.state)).toEqual(['checking', 'invalid'])
    svc.dispose()

    const nobody = createService(raFakes({ raProfile: vi.fn<Opt<'raProfile'>>(async () => null) }))
    const unknown = await nobody.syncRetro()
    expect(unknown).toMatchObject({ state: 'invalid' })
    expect(unknown.message).toContain('"Jeremy"')
    expect(nobody.retroStatus()).toBe(unknown)
  })

  it('reports error when RetroAchievements cannot be reached', async () => {
    setRaCreds()
    const svc = createService(
      raFakes({
        raProfile: vi.fn<Opt<'raProfile'>>(async () => {
          throw new Error('ECONNRESET')
        })
      })
    )
    const result = await svc.syncRetro()
    expect(result.state).toBe('error')
    expect(result.message).toContain('ECONNRESET')
  })
})

describe('syncRetro: ROMs', () => {
  it('matches ROMs by hash and by unique title and writes their counts', async () => {
    const ids = await addRoms()
    library.mergeScan('steam', [scanned()])
    changed = []
    setRaCreds(' Jeremy ', ' ra-key ')
    const fakes = raFakes()
    const svc = createService(fakes)
    const status = await svc.syncRetro()

    const creds = { username: 'Jeremy', apiKey: 'ra-key' }
    expect(fakes.raProfile).toHaveBeenCalledWith(creds)
    expect(fakes.raGameList).toHaveBeenCalledWith(3, creds)
    expect(fakes.raCompletion).toHaveBeenCalledTimes(1)
    expect(fakes.hashRom).toHaveBeenCalledTimes(5)

    // Hash match, never played: the game's own achievement count with nothing unlocked.
    expect(library.getGame(ids.smw)?.metadata.achievements).toMatchObject({
      unlocked: 0,
      total: 96
    })
    expect(library.getGame(ids.smw)?.metadata.sources?.[RA_SOURCE]).toBe('228')
    // Title match with progress.
    expect(library.getGame(ids.chrono)?.metadata.achievements).toMatchObject({
      unlocked: 20,
      total: 77
    })
    expect(library.getGame(ids.chrono)?.metadata.sources?.[RA_SOURCE]).toBe('319')
    // Two games share the title; only a hack has the other: neither is guessed. Their hashes are in no game of the
    // whole list (only games with achievements are listed): they have none, and are marked so.
    expect(library.getGame(ids.megaman)?.metadata.achievements).toBeUndefined()
    expect(library.getGame(ids.metroid)?.metadata.achievements).toBeUndefined()
    expect(library.getGame(ids.megaman)?.metadata.sources?.[RA_SOURCE]).toBe(RA_NONE)
    expect(library.getGame(ids.metroid)?.metadata.sources?.[RA_SOURCE]).toBe(RA_NONE)
    // Matched, but a set without achievements: no counts, marked as without achievements.
    expect(library.getGame(ids.dkc)?.metadata.achievements).toBeUndefined()
    expect(library.getGame(ids.dkc)?.metadata.sources?.[RA_SOURCE]).toBe(RA_NONE)
    expect(library.getGame('steam:620')?.metadata.achievements).toBeUndefined()

    expect(changed).toHaveLength(1)
    expect([...changed[0]].sort()).toEqual(Object.values(ids).sort())
    expect(status).toMatchObject({
      state: 'signed-in',
      user: 'Jeremy',
      points: 1234,
      softcorePoints: 56,
      roms: 5,
      matched: 3
    })
    expect(status.syncedAt).toBeTruthy()
    expect(svc.retroStatus()).toBe(status)
    expect(statuses.at(-1)).toBe(status)
    expect(statuses.map((s) => s.state)).toEqual(['checking', 'checking', 'signed-in'])
  })

  it('skips the completion request when no ROM matched', async () => {
    library.mergeScan('rom', [await rom('Unknown Thing (USA).sfc', 'Unknown Thing')])
    setRaCreds()
    const fakes = raFakes()
    const status = await createService(fakes).syncRetro()
    expect(status).toMatchObject({ state: 'signed-in', roms: 1, matched: 0 })
    expect(fakes.raCompletion).not.toHaveBeenCalled()
  })

  it('clears the ROM counts when the credentials are cleared', async () => {
    const ids = await addRoms()
    library.mergeScan('steam', [scanned()])
    library.applyMetadata(
      'steam:620',
      { metadata: { achievements: { unlocked: 1, total: 2, updatedAt: 'x' } } },
      { quiet: true }
    )
    setRaCreds()
    const svc = createService(raFakes())
    await svc.syncRetro()
    changed = []

    patchSettings((s) => {
      s.scrapers.retroachievements = { username: '', apiKey: '' }
    })
    await until(() => svc.retroStatus().state === 'signed-out')
    for (const id of [ids.smw, ids.chrono]) {
      expect(library.getGame(id)?.metadata.achievements).toBeUndefined()
      expect(library.getGame(id)?.metadata.sources?.[RA_SOURCE]).toBeUndefined()
    }
    // Steam's counts are not RetroAchievements' to clear.
    expect(library.getGame('steam:620')?.metadata.achievements).toMatchObject({ unlocked: 1 })
    expect(library.getGame(ids.dkc)?.metadata.sources?.[RA_SOURCE]).toBeUndefined()
    expect(changed).toHaveLength(1)
    expect([...changed[0]].sort()).toEqual(Object.values(ids).sort())
  })

  it('marks no ROM without achievements from a failed list or a title-only miss, and replaces a mark once matched', async () => {
    // Disc systems are matched by title only: a miss there says nothing.
    const disc = library.mergeScan('rom', [
      await rom('Unknown Disc (USA).cue', 'Unknown Disc', 'psx')
    ]).newGameIds[0]!
    const ids = await addRoms()
    setRaCreds()
    // The SNES list fails with nothing cached: nothing is known.
    const failing = raFakes({
      raGameList: vi.fn<Opt<'raGameList'>>(async (consoleId) => {
        if (consoleId === 3) throw new Error('timeout')
        return []
      })
    })
    const svc = createService(failing)
    await svc.syncRetro()
    for (const id of [...Object.values(ids), disc])
      expect(library.getGame(id)?.metadata.sources?.[RA_SOURCE]).toBeUndefined()
    svc.dispose()

    // A whole list: the hash misses are marked; the disc's title-only miss is not.
    await createService(raFakes()).syncRetro()
    expect(library.getGame(ids.megaman)?.metadata.sources?.[RA_SOURCE]).toBe(RA_NONE)
    expect(library.getGame(disc)?.metadata.sources?.[RA_SOURCE]).toBeUndefined()
    service?.dispose()

    // The ROM's hash is now known (a new set): the mark goes and its counts come.
    const known = raFakes({
      raGameList: vi.fn<Opt<'raGameList'>>(async () => [
        ...SNES_GAMES,
        raGame(700, 'Mega Man X (Rev 1)', 40, ['ffff00'])
      ])
    })
    await fs.rm(join(dir, 'achievements', 'games-3.json'), { force: true })
    await createService(known).syncRetro()
    expect(library.getGame(ids.megaman)?.metadata.sources?.[RA_SOURCE]).toBe('700')
    expect(library.getGame(ids.megaman)?.metadata.achievements).toMatchObject({ total: 40 })
  })

  it('marks no zipped ROM (another file in the zip may give the hash) and trusts a cached list for a day only', async () => {
    const zipped = library.mergeScan('rom', [await rom('Some Game (USA).zip', 'Some Game (USA)')])
      .newGameIds[0]!
    const ids = await addRoms()
    setRaCreds()
    // A list cached two days ago: still used, but a ROM missing from it is not marked.
    await fs.mkdir(join(dir, 'achievements'), { recursive: true })
    await fs.writeFile(
      join(dir, 'achievements', 'games-3.json'),
      JSON.stringify({ fetchedAt: Date.now() - 2 * 24 * 60 * 60 * 1000, games: SNES_GAMES })
    )
    const fakes = raFakes()
    await createService(fakes).syncRetro()
    expect(fakes.raGameList).not.toHaveBeenCalled()
    expect(library.getGame(ids.smw)?.metadata.sources?.[RA_SOURCE]).toBe('228')
    expect(library.getGame(ids.megaman)?.metadata.sources?.[RA_SOURCE]).toBeUndefined()
    // The zero-achievement match is certain whatever the list's age.
    expect(library.getGame(ids.dkc)?.metadata.sources?.[RA_SOURCE]).toBe(RA_NONE)
    service?.dispose()

    // A fresh list: the plain ROM's miss is marked, the zip's is not.
    await fs.rm(join(dir, 'achievements', 'games-3.json'), { force: true })
    await createService(raFakes()).syncRetro()
    expect(library.getGame(ids.megaman)?.metadata.sources?.[RA_SOURCE]).toBe(RA_NONE)
    expect(library.getGame(zipped)?.metadata.sources?.[RA_SOURCE]).toBeUndefined()
  })

  it("reuses the cached game list and ROM hashes, and doesn't rewrite unchanged counts", async () => {
    await addRoms()
    setRaCreds()
    const fakes = raFakes()
    const svc = createService(fakes)
    await svc.syncRetro()
    changed = []
    const second = await svc.syncRetro()
    expect(second).toMatchObject({ state: 'signed-in', matched: 3 })
    expect(fakes.raGameList).toHaveBeenCalledTimes(1)
    expect(fakes.hashRom).toHaveBeenCalledTimes(5)
    expect(changed).toEqual([])
    svc.dispose()

    // The list survives in <cacheDir> for the next run; so do the hashes.
    const cached = JSON.parse(
      await fs.readFile(join(dir, 'achievements', 'games-3.json'), 'utf8')
    ) as { games: RaGame[] }
    expect(cached.games.map((g) => g.id)).toEqual(SNES_GAMES.map((g) => g.id))
    const next = raFakes()
    await createService(next).syncRetro()
    expect(next.raGameList).not.toHaveBeenCalled()
    expect(next.hashRom).not.toHaveBeenCalled()
  })

  it('reports invalid when the key is refused during the game list', async () => {
    await addRoms()
    setRaCreds()
    const fakes = raFakes({
      raGameList: vi.fn<Opt<'raGameList'>>(async () => {
        throw new RaAuthError()
      })
    })
    const status = await createService(fakes).syncRetro()
    expect(status.state).toBe('invalid')
  })
})

// ---------------------------------------------------------------------------
// One game
// ---------------------------------------------------------------------------

describe('get', () => {
  it("loads a ROM's list by its stored RetroAchievements id, or matches it first", async () => {
    const ids = await addRoms()
    setRaCreds()
    const fakes = raFakes()
    const svc = createService(fakes)
    library.applyMetadata(ids.smw, { metadata: { sources: { [RA_SOURCE]: '228' } } })
    changed = []

    const smw = await svc.get(ids.smw)
    expect(smw).toMatchObject({ provider: 'retroachievements', unlocked: 0, total: 96 })
    expect(fakes.raGame).toHaveBeenCalledWith(228, { username: 'Jeremy', apiKey: 'ra-key' })
    expect(fakes.raGameList).not.toHaveBeenCalled()

    // No stored id: matched by title, then the counts and the id are written.
    const chrono = await svc.get(ids.chrono)
    expect(chrono).toMatchObject({ unlocked: 21, total: 77 })
    expect(fakes.raGame).toHaveBeenLastCalledWith(319, { username: 'Jeremy', apiKey: 'ra-key' })
    expect(library.getGame(ids.chrono)?.metadata.achievements).toMatchObject({
      unlocked: 21,
      total: 77
    })
    expect(library.getGame(ids.chrono)?.metadata.sources?.[RA_SOURCE]).toBe('319')
    expect(changed).toContainEqual([ids.chrono])

    // Unmatched: null, no list request.
    fakes.raGame.mockClear()
    await expect(svc.get(ids.megaman)).resolves.toBeNull()
    expect(fakes.raGame).not.toHaveBeenCalled()
    await expect(svc.get('nope:1')).resolves.toBeNull()
  })

  it('returns null for a ROM when signed out', async () => {
    const ids = await addRoms()
    const fakes = raFakes()
    await expect(createService(fakes).get(ids.smw)).resolves.toBeNull()
    expect(fakes.raGame).not.toHaveBeenCalled()
  })

  it("loads a Steam game's list and caches it for ten minutes", async () => {
    library.mergeScan('steam', [scanned()])
    library.mergeScan('epic', [EPIC_NO_APPID])
    setSteamKey()
    const steamGame = vi.fn<Opt<'steamGame'>>(async () => listInfo(4, 51))
    const svc = createService({ steamGame })
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)

    await expect(svc.get('steam:620')).resolves.toMatchObject({ unlocked: 4, total: 51 })
    expect(steamGame).toHaveBeenCalledWith(620, { steamId64: '7656119', key: 'KEY' })
    expect(library.getGame('steam:620')?.metadata.achievements).toMatchObject({
      unlocked: 4,
      total: 51
    })
    clock.mockReturnValue(now + 9 * 60 * 1000)
    await svc.get('steam:620')
    expect(steamGame).toHaveBeenCalledTimes(1)
    clock.mockReturnValue(now + 10 * 60 * 1000 + 1)
    await svc.get('steam:620')
    expect(steamGame).toHaveBeenCalledTimes(2)

    // No app id: nothing to ask Steam about.
    await expect(svc.get('epic:fortnite')).resolves.toBeNull()
    expect(steamGame).toHaveBeenCalledTimes(2)
  })

  it('shares one request between concurrent opens', async () => {
    library.mergeScan('steam', [scanned()])
    setSteamKey()
    const steamGame = vi.fn<Opt<'steamGame'>>(async () => {
      await sleep(10)
      return listInfo(1, 51)
    })
    const svc = createService({ steamGame })
    const [a, b] = await Promise.all([svc.get('steam:620'), svc.get('steam:620')])
    expect(a).toBe(b)
    expect(steamGame).toHaveBeenCalledTimes(1)
  })

  it('does not cache a failed load', async () => {
    library.mergeScan('steam', [scanned()])
    setSteamKey()
    const steamGame = vi
      .fn<Opt<'steamGame'>>()
      .mockRejectedValueOnce(new Error('HTTP 500'))
      .mockResolvedValue(listInfo(2, 51))
    const svc = createService({ steamGame })
    await expect(svc.get('steam:620')).resolves.toBeNull()
    await expect(svc.get('steam:620')).resolves.toMatchObject({ unlocked: 2 })
    expect(steamGame).toHaveBeenCalledTimes(2)
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 500'))
  })
})

describe('Steam account changes', () => {
  const token = (steamId64 = '7656119'): (() => Promise<SteamCredential>) =>
    vi.fn(async () => ({ steamId64, accessToken: 'stored' }))

  it('prefers the signed-in account over a Settings key for another SteamID64', async () => {
    library.mergeScan('steam', [scanned()])
    setSteamKey()
    const steamProgress = vi.fn<Opt<'steamProgress'>>(
      async () => new Map([[620, { unlocked: 9, total: 51 }]])
    )
    const svc = createService({ steamProgress })
    svc.useSteamAccount(token('76561190000000000'))
    await svc.syncSteam()
    expect(steamProgress.mock.calls.map((c) => c[1])).toEqual([
      { steamId64: '76561190000000000', accessToken: 'stored' }
    ])
  })

  it("tries the account's token when the Settings key finds no list (a private profile, a revoked key)", async () => {
    library.mergeScan('steam', [scanned()])
    setSteamKey()
    const steamGame = vi.fn<Opt<'steamGame'>>(async (_appId, credential) =>
      'key' in credential ? null : listInfo(3, 51)
    )
    const svc = createService({ steamGame })
    svc.useSteamAccount(token())
    await expect(svc.get('steam:620')).resolves.toMatchObject({ unlocked: 3 })
    expect(steamGame).toHaveBeenCalledTimes(2)
  })

  it('asks again after a sign-in instead of keeping an empty answer', async () => {
    library.mergeScan('steam', [scanned()])
    const steamGame = vi.fn<Opt<'steamGame'>>(async () => listInfo(5, 51))
    const svc = createService({ steamGame })
    // Signed out: nothing to read with.
    await expect(svc.get('steam:620')).resolves.toBeNull()
    svc.useSteamAccount(token())
    await expect(svc.get('steam:620')).resolves.toMatchObject({ unlocked: 5 })
  })

  it('clears the Steam counts on sign-out and drops a sync that was still running', async () => {
    library.mergeScan('steam', [scanned()])
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const steamProgress = vi
      .fn<Opt<'steamProgress'>>()
      .mockResolvedValueOnce(new Map([[620, { unlocked: 2, total: 51 }]]))
      .mockImplementationOnce(async () => {
        await gate
        return new Map([[620, { unlocked: 8, total: 51 }]])
      })
    const svc = createService({ steamProgress })
    svc.useSteamAccount(token())
    await svc.syncSteam()
    expect(library.getGame('steam:620')?.metadata.achievements?.unlocked).toBe(2)

    const running = svc.syncSteam()
    await until(() => steamProgress.mock.calls.length === 2)
    svc.steamSignedOut()
    expect(library.getGame('steam:620')?.metadata.achievements).toBeUndefined()
    release()
    await running
    expect(library.getGame('steam:620')?.metadata.achievements).toBeUndefined()
  })

  it('reads the counts again with the Settings key after a sign-out', async () => {
    library.mergeScan('steam', [scanned()])
    setSteamKey()
    const steamProgress = vi.fn<Opt<'steamProgress'>>(
      async () => new Map([[620, { unlocked: 2, total: 51 }]])
    )
    const svc = createService({ steamProgress })
    await svc.syncSteam()
    svc.steamSignedOut()
    await until(() => library.getGame('steam:620')?.metadata.achievements?.unlocked === 2)
    expect(steamProgress).toHaveBeenCalledTimes(2)
  })
})

describe('RetroAchievements robustness', () => {
  it('hashes a ROM again next time when reading it failed', async () => {
    const ids = await addRoms()
    setRaCreds()
    const fakes = raFakes({
      hashRom: vi
        .fn<Opt<'hashRom'>>()
        .mockRejectedValueOnce(new Error('EBUSY'))
        .mockImplementation(async (path) => (basename(path) === 'smw.sfc' ? 'aaa111' : 'ffff00'))
    })
    const svc = createService(fakes)
    await svc.syncRetro()
    await svc.syncRetro()
    // Five ROMs hashed once; the one that failed is hashed again, the others come from the cache.
    expect(fakes.hashRom).toHaveBeenCalledTimes(6)
    expect(library.getGame(ids.smw)?.metadata.sources?.[RA_SOURCE]).toBe('228')
  })

  it('downloads a console list once when a game opens during a sync', async () => {
    const ids = await addRoms()
    setRaCreds()
    const fakes = raFakes({
      raGameList: vi.fn<Opt<'raGameList'>>(async () => {
        await sleep(20)
        return SNES_GAMES
      })
    })
    const svc = createService(fakes)
    await Promise.all([svc.syncRetro(), svc.get(ids.chrono)])
    expect(fakes.raGameList).toHaveBeenCalledTimes(1)
  })

  it('reports a higher revision after the credentials change', async () => {
    setRaCreds()
    const svc = createService(raFakes())
    const first = await svc.syncRetro()
    setRaCreds('Other', 'other-key')
    await until(() => statuses.some((s) => s.revision > first.revision && s.state !== 'checking'))
    expect(svc.retroStatus().revision).toBeGreaterThan(first.revision)
  })
})

describe('credential changes mid-flight', () => {
  it('clears the Steam counts when the Settings key is removed and nothing else signs in', async () => {
    library.mergeScan('steam', [scanned()])
    setSteamKey()
    const steamProgress = vi.fn<Opt<'steamProgress'>>(
      async () => new Map([[620, { unlocked: 2, total: 51 }]])
    )
    const svc = createService({ steamProgress })
    await svc.syncSteam()
    expect(library.getGame('steam:620')?.metadata.achievements?.unlocked).toBe(2)
    patchSettings((s) => {
      s.scrapers.steam.apiKey = ''
    })
    expect(library.getGame('steam:620')?.metadata.achievements).toBeUndefined()
    await sleep(30)
    expect(steamProgress).toHaveBeenCalledTimes(1)
  })

  it("drops a ROM's list that arrives after the RetroAchievements account was cleared", async () => {
    const ids = await addRoms()
    setRaCreds()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const fakes = raFakes({
      raGame: vi.fn<Opt<'raGame'>>(async () => {
        await gate
        return { ...listInfo(5, 77), provider: 'retroachievements' as const }
      })
    })
    const svc = createService(fakes)
    const pending = svc.get(ids.chrono)
    await until(() => fakes.raGame.mock.calls.length === 1)
    setRaCreds('', '')
    release()
    await expect(pending).resolves.toBeNull()
    expect(library.getGame(ids.chrono)?.metadata.achievements).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Recompilations
// ---------------------------------------------------------------------------

describe('recompilation achievements', () => {
  const RECOMP = 'github:someone/game-recomp'
  const played = vi.fn()
  beforeEach(() => played.mockReset())

  /** A disc image card whose installed recompilation Play starts; `readable` = PlayOut reads its achievements. */
  async function recompCard(systemId: string, readable = true): Promise<string> {
    const id = library.mergeScan('rom', [await rom(`game-${systemId}.iso`, 'Some Game', systemId)])
      .newGameIds[0]!
    library.applyMetadata(
      id,
      {
        metadata: {
          recomp: {
            titleKey: `${systemId}:some game`,
            count: 1,
            installed: [RECOMP],
            preferred: RECOMP,
            ...(readable ? { achievements: [RECOMP] } : {}),
            updatedAt: new Date().toISOString()
          }
        }
      },
      { overwrite: true, quiet: true }
    )
    return id
  }

  const recompInfo = (unlocked: number, total: number): AchievementsInfo => ({
    provider: 'recomp',
    total,
    unlocked,
    points: { earned: unlocked * 10, total: total * 10 },
    list: []
  })

  it('reads the recompilation Play starts before RetroAchievements and writes its counts', async () => {
    setRaCreds()
    const id = await recompCard('snes')
    const fakes = raFakes()
    const read = vi.fn(async () => recompInfo(2, 5))
    const svc = createService(fakes)
    svc.useRecomp({ read, played })
    changed = []
    const info = await svc.get(id)
    expect(info?.provider).toBe('recomp')
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ id }), RECOMP)
    expect(fakes.raGame).not.toHaveBeenCalled()
    expect(library.getGame(id)?.metadata.achievements).toMatchObject({ unlocked: 2, total: 5 })
    expect(library.getGame(id)?.metadata.sources?.['recomp-achievements']).toBe(RECOMP)
    expect(changed).toEqual([[id]])
    // Kept a few minutes: the next open does not read again.
    await svc.get(id)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('keeps RetroAchievements for a recompilation PlayOut cannot read achievements of', async () => {
    setRaCreds()
    const id = await recompCard('snes', false)
    library.applyMetadata(
      id,
      { metadata: { sources: { [RA_SOURCE]: '319' } } },
      { overwrite: true, quiet: true }
    )
    const fakes = raFakes()
    const read = vi.fn(async () => recompInfo(1, 1))
    const svc = createService(fakes)
    svc.useRecomp({ read, played })
    expect((await svc.get(id))?.provider).toBe('retroachievements')
    expect(read).not.toHaveBeenCalled()
  })

  it('writes no counts when only the unlocks could be read, and nothing without a reader', async () => {
    const id = await recompCard('xbox360')
    const svc = createService()
    expect(await svc.get(id)).toBeNull()
    svc.useRecomp({
      read: async () => ({ provider: 'recomp', total: 0, unlocked: 3, list: [] }),
      played
    })
    expect(await svc.get(id)).toMatchObject({ unlocked: 3, total: 0 })
    expect(library.getGame(id)?.metadata.achievements).toBeUndefined()
  })

  it('reads them again after a play session of that recompilation only', async () => {
    const id = await recompCard('xbox360')
    let unlocked = 1
    const read = vi.fn(async () => recompInfo(unlocked, 4))
    const svc = createService()
    svc.useRecomp({ read, played })
    await svc.get(id)
    unlocked = 3
    await svc.recompPlayed('github:other/recomp')
    expect(read).toHaveBeenCalledTimes(1)
    expect(played).not.toHaveBeenCalledWith(RECOMP)
    await svc.recompPlayed(RECOMP)
    // The reader looks for the unlock file again (it appears with the first unlock).
    expect(played).toHaveBeenCalledWith(RECOMP)
    expect(read).toHaveBeenCalledTimes(2)
    expect(library.getGame(id)?.metadata.achievements).toMatchObject({ unlocked: 3, total: 4 })
    // The new answer is the one kept.
    expect((await svc.get(id))?.unlocked).toBe(3)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('leaves a recompilation counts on the card when RetroAchievements signs out', async () => {
    const id = await recompCard('xbox360')
    const svc = createService(raFakes())
    svc.useRecomp({ read: async () => recompInfo(1, 2), played })
    await svc.get(id)
    await svc.syncRetro()
    expect(library.getGame(id)?.metadata.achievements).toMatchObject({ unlocked: 1, total: 2 })
  })

  it("leaves a Steam card with an installed recompilation to Steam's achievements", async () => {
    library.mergeScan('steam', [scanned()])
    library.applyMetadata(
      'steam:620',
      {
        metadata: {
          recomp: {
            titleKey: 'xbox360:portal 2',
            count: 1,
            installed: [RECOMP],
            preferred: RECOMP,
            achievements: [RECOMP],
            updatedAt: new Date().toISOString()
          }
        }
      },
      { overwrite: true, quiet: true }
    )
    setSteamKey()
    const steamGame = vi.fn<Opt<'steamGame'>>(async () => listInfo(4, 51))
    const read = vi.fn(async () => recompInfo(1, 2))
    const svc = createService({ steamGame })
    svc.useRecomp({ read, played })
    expect(await svc.get('steam:620')).toMatchObject({ unlocked: 4, total: 51 })
    expect(read).not.toHaveBeenCalled()
    await svc.recompPlayed(RECOMP)
    expect(read).not.toHaveBeenCalled()
    expect(library.getGame('steam:620')?.metadata.sources?.['recomp-achievements']).toBeUndefined()
  })

  it('takes the counts off the card once the recompilation is uninstalled', async () => {
    const id = await recompCard('xbox360')
    const svc = createService()
    svc.useRecomp({ read: async () => recompInfo(2, 4), played })
    await svc.get(id)
    expect(library.getGame(id)?.metadata.achievements).toMatchObject({ unlocked: 2, total: 4 })
    // Still the recompilation Play starts: nothing to forget.
    svc.forgetStaleRecomp()
    expect(library.getGame(id)?.metadata.achievements).toMatchObject({ unlocked: 2, total: 4 })
    const recomp = library.getGame(id)!.metadata.recomp!
    library.applyMetadata(
      id,
      { metadata: { recomp: { ...recomp, installed: [], achievements: undefined } } },
      { overwrite: true, quiet: true }
    )
    changed = []
    svc.forgetStaleRecomp()
    const after = library.getGame(id)!.metadata
    expect(after.achievements).toBeUndefined()
    expect(after.sources?.['recomp-achievements']).toBeUndefined()
    expect(changed).toEqual([[id]])
  })

  it('forgets stale counts when the page opens, before RetroAchievements is asked', async () => {
    const id = await recompCard('xbox360')
    const svc = createService()
    svc.useRecomp({ read: async () => recompInfo(2, 4), played })
    await svc.get(id)
    const recomp = library.getGame(id)!.metadata.recomp!
    library.applyMetadata(
      id,
      { metadata: { recomp: { ...recomp, installed: [] } } },
      { overwrite: true, quiet: true }
    )
    expect(await svc.get(id)).toBeNull()
    expect(library.getGame(id)?.metadata.achievements).toBeUndefined()
  })
})
