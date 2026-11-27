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
import {
  knownWithoutSteamAchievements,
  STEAM_ACHIEVEMENTS_NONE,
  STEAM_ACHIEVEMENTS_SOURCE
} from '../../shared/steam-achievements'
import { EventBus } from '../events'
import { HttpError } from '../scrapers/http'
import { LibraryService } from '../services/library-service'
import { LibraryStore } from '../store/library-store'
import { SessionsStore } from '../store/sessions-store'
import { SettingsStore } from '../store/settings-store'
import {
  createAchievementsService,
  RA_SOURCE,
  type AchievementsDeps,
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

function createService(
  options: AchievementsOptions = {},
  extraDeps: Pick<AchievementsDeps, 'gameRunning'> = {}
): AchievementsService {
  service = createAchievementsService(
    { settings, library, events, log, cacheDir: join(dir, 'achievements'), ...extraDeps },
    {
      settingsDelayMs: 5,
      // The Steam scan runs when a test asks (syncSteam), without its start-up wait or request gaps. Steam's own list
      // says every game has achievements unless a test says otherwise.
      steamStartDelayMs: 0,
      steamKickDelayMs: 5,
      steamScanGapMs: 0,
      steamCount: vi.fn(async () => 5),
      ...options
    }
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
  // A scan record still being saved by the disposed service: removing the folder tries again.
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
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

    // Nothing was played since: nothing is read again.
    const before = library.getGame('steam:620')?.metadata.achievements?.updatedAt
    await sleep(5)
    await svc.syncSteam()
    expect(steamProgress).toHaveBeenCalledTimes(1)
    expect(changed).toHaveLength(1)
    expect(library.getGame('steam:620')?.metadata.achievements?.updatedAt).toBe(before)

    // A PlayOut session of one game ended: that game alone is read again, and its changed count written.
    answers.set(620, { unlocked: 4, total: 51 })
    svc.steamPlayed('steam:620', new Date().toISOString())
    await until(() => library.getGame('steam:620')?.metadata.achievements?.unlocked === 4)
    expect(steamProgress).toHaveBeenCalledTimes(2)
    expect(steamProgress.mock.calls[1][0]).toEqual([620])
    expect(changed).toEqual([changed[0], ['steam:620']])
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

    // Refused again with the fresh token: given up (no third try), nothing written, nothing thrown. (The sign-out
    // takes the counts off and makes the game due again.)
    svc.steamSignedOut()
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
        return new Map([[440, { unlocked: 8, total: 51 }]])
      })
    const svc = createService({ steamProgress })
    svc.useSteamAccount(token())
    await svc.syncSteam()
    expect(library.getGame('steam:620')?.metadata.achievements?.unlocked).toBe(2)

    // A game added since is read; the account signs out meanwhile.
    library.mergeScan('steam', [
      scanned(),
      scanned({ externalId: '440', title: 'Team Fortress 2', extra: { steamAppId: 440 } })
    ])
    const running = svc.syncSteam()
    await until(() => steamProgress.mock.calls.length === 2)
    expect(steamProgress.mock.calls[1][0]).toEqual([440])
    svc.steamSignedOut()
    expect(library.getGame('steam:620')?.metadata.achievements).toBeUndefined()
    release()
    await running
    expect(library.getGame('steam:620')?.metadata.achievements).toBeUndefined()
    expect(library.getGame('steam:440')?.metadata.achievements).toBeUndefined()
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

// ---------------------------------------------------------------------------
// Steam: games without achievements, and the background scan
// ---------------------------------------------------------------------------

describe("Steam's 'no achievements'", () => {
  const COD_UO = scanned({
    externalId: '2640',
    title: 'Call of Duty: United Offensive',
    extra: { steamAppId: 2640 }
  })
  const token = (): (() => Promise<SteamCredential>) =>
    vi.fn(async () => ({ steamId64: '7656119', accessToken: 'stored' }))

  it('marks a game Steam lists no achievements for, and its page asks nothing more', async () => {
    library.mergeScan('steam', [COD_UO])
    changed = []
    const steamGame = vi.fn<Opt<'steamGame'>>(async () => null)
    const steamCount = vi.fn<Opt<'steamCount'>>(async () => 0)
    const svc = createService({ steamGame, steamCount })
    svc.useSteamAccount(token())
    await expect(svc.get('steam:2640')).resolves.toBeNull()
    expect(steamCount).toHaveBeenCalledWith(2640)
    expect(library.getGame('steam:2640')?.metadata.sources?.[STEAM_ACHIEVEMENTS_SOURCE]).toBe(
      STEAM_ACHIEVEMENTS_NONE
    )
    expect(knownWithoutSteamAchievements(library.getGame('steam:2640')!)).toBe(true)
    expect(changed).toContainEqual(['steam:2640'])
    await svc.get('steam:2640')
    expect(steamGame).toHaveBeenCalledTimes(1)
    expect(steamCount).toHaveBeenCalledTimes(1)
  })

  it('is not taken from signing out, a failed check or a game with achievements', async () => {
    library.mergeScan('steam', [COD_UO])
    // Signed out, and Steam's own list could not be read: nothing is known.
    const steamGame = vi.fn<Opt<'steamGame'>>(async () => null)
    const steamCount = vi.fn<Opt<'steamCount'>>(async () => {
      throw new Error('HTTP 503')
    })
    const svc = createService({ steamGame, steamCount })
    await expect(svc.get('steam:2640')).resolves.toBeNull()
    expect(knownWithoutSteamAchievements(library.getGame('steam:2640')!)).toBe(false)
    // Signed out, and Steam lists achievements: the page keeps its sign-in hint.
    steamCount.mockResolvedValue(12)
    await expect(svc.get('steam:2640')).resolves.toBeNull()
    expect(library.getGame('steam:2640')?.metadata.sources?.[STEAM_ACHIEVEMENTS_SOURCE]).toBe(
      undefined
    )
    // Signed in, the list came: no check needed.
    steamGame.mockResolvedValue(listInfo(1, 12))
    steamCount.mockClear()
    svc.useSteamAccount(token())
    await expect(svc.get('steam:2640')).resolves.toMatchObject({ unlocked: 1, total: 12 })
    expect(steamCount).not.toHaveBeenCalled()
  })

  it('replaces the mark with counts once Steam has achievements for the game', async () => {
    library.mergeScan('steam', [COD_UO])
    library.applyMetadata('steam:2640', {
      metadata: { sources: { [STEAM_ACHIEVEMENTS_SOURCE]: STEAM_ACHIEVEMENTS_NONE } }
    })
    const steamProgress = vi.fn<Opt<'steamProgress'>>(
      async () => new Map([[2640, { unlocked: 0, total: 3 }]])
    )
    const svc = createService({ steamProgress })
    svc.useSteamAccount(token())
    await svc.syncSteam()
    const game = library.getGame('steam:2640')!
    expect(game.metadata.achievements).toMatchObject({ unlocked: 0, total: 3 })
    expect(game.metadata.sources?.[STEAM_ACHIEVEMENTS_SOURCE]).toBeUndefined()
  })
})

describe('Steam achievements scan', () => {
  const token = (): (() => Promise<SteamCredential>) =>
    vi.fn(async () => ({ steamId64: '7656119', accessToken: 'stored' }))
  const TF2 = scanned({ externalId: '440', title: 'Team Fortress 2', extra: { steamAppId: 440 } })
  const COD = scanned({ externalId: '2640', title: 'CoD UO', extra: { steamAppId: 2640 } })
  const scanRecord = async (): Promise<Record<string, { at?: number; retryAt?: number }>> =>
    JSON.parse(await fs.readFile(join(dir, 'achievements', 'steam-scans.json'), 'utf8'))

  it('reads new games once (counts, or Steam\'s "none"), records them, and reads nothing again without play', async () => {
    library.mergeScan('steam', [scanned(), COD])
    const steamProgress = vi.fn<Opt<'steamProgress'>>(
      async () => new Map([[620, { unlocked: 3, total: 51 }]])
    )
    const steamCount = vi.fn<Opt<'steamCount'>>(async () => 0)
    const svc = createService({ steamProgress, steamCount })
    svc.useSteamAccount(token())
    await svc.syncSteam()
    expect(library.getGame('steam:620')?.metadata.achievements?.total).toBe(51)
    // CoD had no counts: Steam's own list was asked, for it alone.
    expect(steamCount.mock.calls).toEqual([[2640]])
    expect(knownWithoutSteamAchievements(library.getGame('steam:2640')!)).toBe(true)
    expect(Object.keys(await scanRecord()).sort()).toEqual(['steam:2640', 'steam:620'])

    await svc.syncSteam()
    svc.kickSteam()
    await sleep(30)
    expect(steamProgress).toHaveBeenCalledTimes(1)
    expect(steamCount).toHaveBeenCalledTimes(1)

    // A game added later is read alone.
    library.mergeScan('steam', [scanned(), COD, TF2])
    await svc.syncSteam()
    expect(steamProgress).toHaveBeenCalledTimes(2)
    expect(steamProgress.mock.calls[1][0]).toEqual([440])
  })

  it("reads a game again once Steam's last played or playtime moves past its last read", async () => {
    library.mergeScan('steam', [scanned({ storePlaytimeMinutes: 10 }), TF2])
    const steamProgress = vi.fn<Opt<'steamProgress'>>(
      async () =>
        new Map([
          [620, { unlocked: 1, total: 51 }],
          [440, { unlocked: 1, total: 520 }]
        ])
    )
    const svc = createService({ steamProgress })
    svc.useSteamAccount(token())
    await svc.syncSteam()
    expect(steamProgress).toHaveBeenCalledTimes(1)
    await sleep(5)

    // An older last played changes nothing; a newer one (Steam's import) does, for that game only.
    library.mergeScan('steam', [
      scanned({ storePlaytimeMinutes: 10, lastPlayed: '2020-01-01T00:00:00.000Z' }),
      { ...TF2, lastPlayed: new Date().toISOString() }
    ])
    await svc.syncSteam()
    expect(steamProgress).toHaveBeenCalledTimes(2)
    expect(steamProgress.mock.calls[1][0]).toEqual([440])

    // More playtime on Steam: read again.
    library.mergeScan('steam', [scanned({ storePlaytimeMinutes: 25 }), TF2])
    await svc.syncSteam()
    expect(steamProgress.mock.calls[2][0]).toEqual([620])
    await svc.syncSteam()
    expect(steamProgress).toHaveBeenCalledTimes(3)
  })

  it('keeps games waiting while nothing can read them, and reads them once an account appears', async () => {
    library.mergeScan('steam', [scanned(), TF2])
    const steamProgress = vi.fn<Opt<'steamProgress'>>(
      async () => new Map([[620, { unlocked: 2, total: 51 }]])
    )
    const steamCount = vi.fn<Opt<'steamCount'>>(async () => 5)
    const svc = createService({ steamProgress, steamCount })
    await svc.syncSteam()
    svc.useSteamAccount(async () => null)
    await svc.syncSteam()
    expect(steamProgress).not.toHaveBeenCalled()
    expect(steamCount).not.toHaveBeenCalled()

    svc.useSteamAccount(token())
    await svc.syncSteam()
    expect(library.getGame('steam:620')?.metadata.achievements?.unlocked).toBe(2)
    // TF2: achievements, but none in this account's progress (another account owns it): read, nothing written.
    expect(steamCount.mock.calls).toEqual([[440]])
    expect(library.getGame('steam:440')?.metadata.achievements).toBeUndefined()
    expect(knownWithoutSteamAchievements(library.getGame('steam:440')!)).toBe(false)
    await svc.syncSteam()
    expect(steamProgress).toHaveBeenCalledTimes(1)
  })

  it('asks for a hundred apps per request and resumes after a restart from its record', async () => {
    const many = Array.from({ length: 150 }, (_, i) =>
      scanned({ externalId: String(1000 + i), title: `Game ${i}`, extra: { steamAppId: 1000 + i } })
    )
    library.mergeScan('steam', many)
    const steamProgress = vi.fn<Opt<'steamProgress'>>(async (ids) => {
      // The second request fails: those games are left for later.
      if (steamProgress.mock.calls.length === 2) throw new Error('HTTP 502')
      return new Map(ids.map((id) => [id, { unlocked: 0, total: 10 }]))
    })
    const first = createService({ steamProgress, steamBackoffMs: 60 * 60 * 1000 })
    first.useSteamAccount(token())
    await first.syncSteam()
    expect(steamProgress.mock.calls.map((c) => c[0].length)).toEqual([100, 50])
    first.dispose()
    const record = await scanRecord()
    expect(Object.values(record).filter((e) => e.at !== undefined)).toHaveLength(100)
    expect(Object.values(record).filter((e) => e.retryAt)).toHaveLength(50)

    // A restart: the record holds; the failed games wait out their pause, then only they are read.
    steamProgress.mockClear()
    const clock = vi.spyOn(Date, 'now')
    const second = createService({ steamProgress, steamBackoffMs: 60 * 60 * 1000 })
    second.useSteamAccount(token())
    await second.syncSteam()
    expect(steamProgress).not.toHaveBeenCalled()
    clock.mockReturnValue(Date.now() + 2 * 60 * 60 * 1000)
    await second.syncSteam()
    expect(steamProgress).toHaveBeenCalledTimes(1)
    expect(steamProgress.mock.calls[0][0]).toHaveLength(50)
    clock.mockRestore()
  })

  it('backs off after a failure (a rate limit) and tries again by itself once the pause is over', async () => {
    library.mergeScan('steam', [scanned()])
    const steamProgress = vi
      .fn<Opt<'steamProgress'>>()
      .mockRejectedValueOnce(
        new HttpError('HTTP 429', { status: 429, url: 'https://api.steampowered.com/x' })
      )
      .mockResolvedValue(new Map([[620, { unlocked: 6, total: 51 }]]))
    const svc = createService({ steamProgress, steamBackoffMs: 80 })
    svc.useSteamAccount(token())
    await svc.syncSteam()
    expect(steamProgress).toHaveBeenCalledTimes(1)
    // Asked again at once (an import, a kick): the pause holds.
    await svc.syncSteam()
    svc.kickSteam()
    expect(steamProgress).toHaveBeenCalledTimes(1)
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('rate limited'))
    await until(() => library.getGame('steam:620')?.metadata.achievements?.unlocked === 6)
    expect(steamProgress).toHaveBeenCalledTimes(2)
  })

  it('waits for the start-up delay before its first pass', async () => {
    library.mergeScan('steam', [scanned()])
    const steamProgress = vi.fn<Opt<'steamProgress'>>(
      async () => new Map([[620, { unlocked: 1, total: 51 }]])
    )
    const svc = createService({ steamProgress, steamStartDelayMs: 60 })
    svc.useSteamAccount(token())
    await svc.syncSteam()
    svc.kickSteam()
    expect(steamProgress).not.toHaveBeenCalled()
    await until(() => steamProgress.mock.calls.length === 1)
    expect(library.getGame('steam:620')?.metadata.achievements?.unlocked).toBe(1)
  })

  it('reads a game the page already read only after it is played again', async () => {
    library.mergeScan('steam', [scanned()])
    const steamGame = vi.fn<Opt<'steamGame'>>(async () => listInfo(4, 51))
    const steamProgress = vi.fn<Opt<'steamProgress'>>(
      async () => new Map([[620, { unlocked: 5, total: 51 }]])
    )
    const svc = createService({ steamGame, steamProgress })
    svc.useSteamAccount(token())
    await svc.get('steam:620')
    await svc.syncSteam()
    expect(steamProgress).not.toHaveBeenCalled()
    await sleep(5)
    svc.steamPlayed('steam:620', new Date().toISOString())
    await until(() => steamProgress.mock.calls.length === 1)
    await until(() => library.getGame('steam:620')?.metadata.achievements?.unlocked === 5)
  })
})

describe('Steam achievements scan: what it reads again, and when', () => {
  const token = (): (() => Promise<SteamCredential>) =>
    vi.fn(async () => ({ steamId64: '7656119', accessToken: 'stored' }))
  const TF2 = scanned({ externalId: '440', title: 'Team Fortress 2', extra: { steamAppId: 440 } })
  const COD = scanned({ externalId: '2640', title: 'CoD UO', extra: { steamAppId: 2640 } })
  const scanRecord = async (): Promise<
    Record<string, { at?: number; retryAt?: number; parkedAt?: number; none?: boolean }>
  > => JSON.parse(await fs.readFile(join(dir, 'achievements', 'steam-scans.json'), 'utf8'))
  const counts = (unlocked = 1): Mock<Opt<'steamProgress'>> =>
    vi.fn<Opt<'steamProgress'>>(
      async (ids) =>
        new Map(ids.filter((id) => id !== 2640).map((id) => [id, { unlocked, total: 51 }]))
    )
  const known = (id: string): boolean => knownWithoutSteamAchievements(library.getGame(id)!)

  it('keeps no mark when the store cannot say, and reads that game again only once played', async () => {
    library.mergeScan('steam', [COD])
    const steamProgress = vi.fn<Opt<'steamProgress'>>(async () => new Map())
    const steamCount = vi.fn<Opt<'steamCount'>>(async () => null)
    const svc = createService({ steamProgress, steamCount })
    svc.useSteamAccount(token())
    await svc.syncSteam()
    expect(known('steam:2640')).toBe(false)
    expect((await scanRecord())['steam:2640'].at).toBeDefined()
    await svc.syncSteam()
    expect(steamCount).toHaveBeenCalledTimes(1)
  })

  it('puts the "none" mark back after a new metadata match dropped it, without asking Steam', async () => {
    library.mergeScan('steam', [COD])
    const steamProgress = vi.fn<Opt<'steamProgress'>>(async () => new Map())
    const steamCount = vi.fn<Opt<'steamCount'>>(async () => 0)
    const steamGame = vi.fn<Opt<'steamGame'>>(async () => null)
    const svc = createService({ steamProgress, steamCount, steamGame })
    svc.useSteamAccount(token())
    await svc.syncSteam()
    expect(known('steam:2640')).toBe(true)
    const rematch = (): void => {
      library.applyMetadata(
        'steam:2640',
        { metadata: { sources: { steam: '2640' } } },
        { overwrite: true, replaceSources: true }
      )
    }
    // The page opens after the match: the stat stays hidden.
    rematch()
    expect(known('steam:2640')).toBe(false)
    await expect(svc.get('steam:2640')).resolves.toBeNull()
    expect(known('steam:2640')).toBe(true)
    // Or the scan's next pass puts it back.
    rematch()
    await svc.syncSteam()
    expect(known('steam:2640')).toBe(true)
    expect(steamProgress).toHaveBeenCalledTimes(1)
    expect(steamCount).toHaveBeenCalledTimes(1)
    expect(steamGame).not.toHaveBeenCalled()
  })

  it('reads a game played here once, not again when Steam catches up with that session', async () => {
    library.mergeScan('steam', [scanned({ storePlaytimeMinutes: 10 })])
    const steamProgress = counts()
    const svc = createService({ steamProgress })
    svc.useSteamAccount(token())
    await svc.syncSteam()
    await sleep(5)
    const session = library.beginSession('steam:620')
    await sleep(5)
    library.endSession(session, 30)
    svc.steamPlayed('steam:620', new Date().toISOString())
    await until(() => steamProgress.mock.calls.length === 2)
    await sleep(20)
    // Steam's import: the same session's playtime and Steam's own last played (its launch, just after).
    const steamLaunch = new Date(Date.parse(session.startedAt) + 1).toISOString()
    library.mergeScan('steam', [scanned({ storePlaytimeMinutes: 40, lastPlayed: steamLaunch })])
    await svc.syncSteam()
    await svc.syncSteam()
    expect(steamProgress).toHaveBeenCalledTimes(2)
    // A later play through Steam itself is new.
    library.mergeScan('steam', [
      scanned({ storePlaytimeMinutes: 70, lastPlayed: new Date(Date.now() + 1000).toISOString() })
    ])
    await svc.syncSteam()
    expect(steamProgress).toHaveBeenCalledTimes(3)
  })

  it('reads a game again once a session played on a paired PC arrives', async () => {
    library.mergeScan('steam', [scanned()])
    const steamProgress = counts()
    const svc = createService({ steamProgress })
    svc.useSteamAccount(token())
    await svc.syncSteam()
    await sleep(5)
    // Played there before this PC read it, but it only arrives now.
    library.addSyncedSessions(
      [
        {
          id: 'remote-1',
          gameId: 'steam:620',
          startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          endedAt: new Date(Date.now() - 60 * 1000).toISOString(),
          minutes: 59
        }
      ],
      'pc-2'
    )
    await svc.syncSteam()
    expect(steamProgress).toHaveBeenCalledTimes(2)
    await svc.syncSteam()
    expect(steamProgress).toHaveBeenCalledTimes(2)
  })

  it('reads a last played ahead of this clock once, not on every pass', async () => {
    library.mergeScan('steam', [scanned()])
    const steamProgress = counts()
    const svc = createService({ steamProgress })
    svc.useSteamAccount(token())
    await svc.syncSteam()
    const ahead = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    library.mergeScan('steam', [scanned({ lastPlayed: ahead })])
    await svc.syncSteam()
    expect(steamProgress).toHaveBeenCalledTimes(2)
    await svc.syncSteam()
    svc.kickSteam()
    await sleep(30)
    expect(steamProgress).toHaveBeenCalledTimes(2)
  })

  it('stops on a refused credential without holding the games back, until an import or sign-in', async () => {
    library.mergeScan('steam', [scanned()])
    const steamProgress = vi.fn<Opt<'steamProgress'>>(async () => {
      throw new SteamAuthError()
    })
    const svc = createService({ steamProgress, steamBackoffMs: 5 })
    svc.useSteamAccount(token())
    await svc.syncSteam()
    const tries = steamProgress.mock.calls.length
    expect(tries).toBeGreaterThan(0)
    expect((await scanRecord())['steam:620']?.retryAt).toBeUndefined()
    // Library changes do not ask again, nor does any timer.
    svc.kickSteam()
    await sleep(60)
    expect(steamProgress).toHaveBeenCalledTimes(tries)
    // The owned import after a sign-in does.
    steamProgress.mockResolvedValue(new Map([[620, { unlocked: 2, total: 51 }]]))
    await svc.syncSteam()
    expect(library.getGame('steam:620')?.metadata.achievements?.unlocked).toBe(2)
  })

  it("doubles the pause while Steam's own list keeps refusing, and asks only that list again", async () => {
    library.mergeScan('steam', [COD])
    const steamProgress = vi.fn<Opt<'steamProgress'>>(async () => new Map())
    const times: number[] = []
    const steamCount = vi.fn<Opt<'steamCount'>>(async () => {
      times.push(Date.now())
      throw new HttpError('HTTP 429', { status: 429, url: 'https://api.steampowered.com/x' })
    })
    const svc = createService({ steamProgress, steamCount, steamBackoffMs: 40 })
    svc.useSteamAccount(token())
    await svc.syncSteam()
    await until(() => times.length === 3)
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(75)
    expect(steamProgress).toHaveBeenCalledTimes(1)
    svc.dispose()
  })

  it('waits as long as Steam asked in its Retry-After', async () => {
    library.mergeScan('steam', [COD])
    const times: number[] = []
    const steamCount = vi.fn<Opt<'steamCount'>>(async () => {
      times.push(Date.now())
      if (times.length === 1)
        throw new HttpError('HTTP 429', {
          status: 429,
          url: 'https://api.steampowered.com/x',
          retryAfterMs: 150
        })
      return 0
    })
    const svc = createService({
      steamProgress: vi.fn<Opt<'steamProgress'>>(async () => new Map()),
      steamCount,
      steamBackoffMs: 10
    })
    svc.useSteamAccount(token())
    await svc.syncSteam()
    await until(() => known('steam:2640'))
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(140)
  })

  it('stops retrying a game that keeps failing until it is played, imported or signed in again', async () => {
    library.mergeScan('steam', [TF2])
    const steamProgress = vi.fn<Opt<'steamProgress'>>(async () => new Map())
    const steamCount = vi.fn<Opt<'steamCount'>>(async () => {
      throw new Error('Steam sent no achievement list for 440')
    })
    const svc = createService({ steamProgress, steamCount, steamBackoffMs: 5 })
    svc.useSteamAccount(token())
    await svc.syncSteam()
    await until(() => steamCount.mock.calls.length === 5)
    await sleep(120)
    expect(steamCount).toHaveBeenCalledTimes(5)
    const entry = (await scanRecord())['steam:440']
    expect(entry.parkedAt).toBeDefined()
    expect(entry.retryAt).toBeUndefined()
    steamCount.mockResolvedValue(12)
    await svc.syncSteam()
    expect(steamCount).toHaveBeenCalledTimes(6)
    expect((await scanRecord())['steam:440'].at).toBeDefined()
  })

  it("keeps a sooner kick when a pass ends with a failed game's later retry", async () => {
    library.mergeScan('steam', [scanned(), TF2])
    const steamCount = vi.fn<Opt<'steamCount'>>(async () => {
      throw new Error('HTTP 500')
    })
    const steamProgress = vi.fn<Opt<'steamProgress'>>(
      async (ids) =>
        new Map(ids.filter((id) => id === 620).map((id) => [id, { unlocked: 1, total: 51 }]))
    )
    const svc = createService({
      steamProgress,
      steamCount,
      steamBackoffMs: 60 * 60 * 1000,
      steamKickDelayMs: 80
    })
    svc.useSteamAccount(token())
    await svc.syncSteam()
    expect((await scanRecord())['steam:440'].retryAt).toBeGreaterThan(Date.now() + 30 * 60 * 1000)
    // A new game's pass: Portal 2's session ends meanwhile, and its kick is due long before TF2's retry.
    library.mergeScan('steam', [
      scanned(),
      TF2,
      scanned({ externalId: '400', title: 'Portal', extra: { steamAppId: 400 } })
    ])
    steamProgress.mockImplementationOnce(async () => {
      svc.steamPlayed('steam:620', new Date(Date.now() + 1).toISOString())
      await sleep(20)
      return new Map([[400, { unlocked: 0, total: 15 }]])
    })
    await svc.syncSteam()
    await until(() => steamProgress.mock.calls.some((c) => c[0].length === 1 && c[0][0] === 620))
  })

  it('writes the marks of a long pass in batches', async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      scanned({ externalId: String(5000 + i), title: `Old ${i}`, extra: { steamAppId: 5000 + i } })
    )
    library.mergeScan('steam', many)
    changed = []
    const svc = createService({
      steamProgress: vi.fn<Opt<'steamProgress'>>(async () => new Map()),
      steamCount: vi.fn<Opt<'steamCount'>>(async () => 0)
    })
    svc.useSteamAccount(token())
    await svc.syncSteam()
    expect(changed.flat()).toHaveLength(30)
    expect(changed.length).toBeLessThanOrEqual(2)
  })

  it('reads nothing while a game runs, and goes on once it ends', async () => {
    library.mergeScan('steam', [scanned()])
    library.mergeScan('epic', [EPIC_NO_APPID])
    let running = true
    const steamProgress = counts()
    const svc = createService({ steamProgress }, { gameRunning: () => running })
    svc.useSteamAccount(token())
    await svc.syncSteam()
    svc.kickSteam()
    await sleep(30)
    expect(steamProgress).not.toHaveBeenCalled()
    running = false
    // Another store's game ended: the held pass goes on.
    const epic = library.games().find((g) => g.source === 'epic')!
    svc.steamPlayed(epic.id, new Date().toISOString())
    await until(() => steamProgress.mock.calls.length === 1)
  })

  it("asks Steam's own list once per page while signed out, again only after a play", async () => {
    library.mergeScan('steam', [scanned()])
    const steamCount = vi.fn<Opt<'steamCount'>>(async () => 51)
    const svc = createService({
      steamGame: vi.fn<Opt<'steamGame'>>(async () => null),
      steamCount
    })
    await svc.get('steam:620')
    await svc.get('steam:620')
    expect(steamCount).toHaveBeenCalledTimes(1)
    svc.steamPlayed('steam:620', new Date().toISOString())
    await svc.get('steam:620')
    expect(steamCount).toHaveBeenCalledTimes(2)
    // Not recorded as read: once an account appears, the scan still reads the game's counts.
    await sleep(20)
    svc.dispose()
    const steamProgress = counts(7)
    const signedIn = createService({ steamProgress })
    signedIn.useSteamAccount(token())
    await signedIn.syncSteam()
    expect(library.getGame('steam:620')?.metadata.achievements?.unlocked).toBe(7)
  })
})
