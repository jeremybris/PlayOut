import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { API_METHODS, type PlayOutApi } from '@shared/api'
import { defaultSettings } from '@shared/defaults'
import type { AccountStatus, InstallProgress, InstallQueueEntry, SteamDlcItem } from '@shared/types'
import type { ScanProgress, SessionEndedPayload } from './test-types'
import {
  EMULATOR_MISSING_GAME_ID,
  HLTB_MOCK_STEP_MS,
  INSTALLING_SCREEN_PERCENT,
  INSTALL_MS,
  LARGE_LIBRARY_COUNT,
  MOCK_BASE_DATE,
  MOCK_DISPLAY_NAMES,
  MOCK_SETTINGS_KEY,
  UBISOFT_REASON,
  createMockApi,
  ownedGames,
  readMockFlags
} from './index'
import { MOCK_HOST_ID, MOCK_STREAMING_PIN, ROM_DOWNLOAD_MS, STREAM_MS } from './streaming'
import { ROMS_ROOT } from './data'

function createStorageStub(): Storage {
  const store = new Map<string, string>()
  return {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => {
      store.delete(key)
    },
    setItem: (key, value) => {
      store.set(key, String(value))
    }
  }
}

/** Same scheme as src/main/util/ids.ts makeGameId for ROM games. */
const romId = (systemId: string, relativePath: string): string =>
  `rom:${systemId}:${createHash('sha1').update(relativePath.replace(/\\/g, '/')).digest('base64url').slice(0, 16)}`

const DAY = 86_400_000

describe('mock api', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createStorageStub())
    vi.spyOn(console, 'info').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('saves, shows and clears metadata edits like main', async () => {
    const api = createMockApi({ search: '' })
    const [first] = (await api.getLibrary()).games
    const before = await api.getMetadataLayers(first.id)
    expect(before.local).toEqual({})
    const shown = await api.setMetadataEdit(first.id, { genres: ['Edited'], title: 'Edited title' })
    expect(shown.metadata.genres).toEqual(['Edited'])
    expect(shown.user.titleOverride).toBe('Edited title')
    expect((await api.getGame(first.id))?.metadata.genres).toEqual(['Edited'])
    expect((await api.getMetadataLayers(first.id)).local).toEqual({
      title: 'Edited title',
      genres: ['Edited']
    })
    const cleared = await api.clearMetadataEdit(first.id)
    expect(cleared.user.titleOverride).toBeUndefined()
    expect(cleared.metadata.genres).toEqual(before.scraped.genres)
  })

  it('returns the shown copy (local edits laid over) from every method that returns a game', async () => {
    const api = createMockApi({ search: '' })
    // A game of this mock alone (the sample games' objects are shared between mocks).
    const exePath = 'C:\\Games\\Mine\\Mine.exe'
    const game = await api.addManualGame({ exePath })
    await api.setMetadataEdit(game.id, { genres: ['Edited'], description: 'Mine' })
    const shown = (
      g: { metadata: { genres?: string[]; description?: string } } | null
    ): { genres?: string[]; description?: string } => ({
      genres: g?.metadata.genres,
      description: g?.metadata.description
    })
    const expected = { genres: ['Edited'], description: 'Mine' }
    expect(shown(await api.setCustomMedia(game.id, 'cover', 'C:\\art\\cover.png'))).toEqual(
      expected
    )
    expect(shown(await api.setCustomMedia(game.id, 'cover', null))).toEqual(expected)
    expect(shown(await api.refreshInstallSize(game.id))).toEqual(expected)
    expect(shown(await api.refreshLivePlayers(game.id))).toEqual(expected)
    expect(
      shown(await api.applyMetadata(game.id, { scraper: 'igdb', externalId: '1', title: 'Match' }))
    ).toEqual(expected)
    expect(shown(await api.addManualGame({ exePath }))).toEqual(expected)
  })

  it('refreshActivePlayers resolves without changing the library', async () => {
    const api = createMockApi({ search: '' })
    const counts = async (): Promise<unknown[]> =>
      (await api.getLibrary()).games.map((g) => [g.id, g.metadata.currentPlayers])
    const before = await counts()
    await expect(api.refreshActivePlayers()).resolves.toBeUndefined()
    expect(await counts()).toEqual(before)
  })

  it('refreshHltbTimes looks up the games without times, one run at a time, with progress', async () => {
    vi.useFakeTimers()
    try {
      const api = createMockApi({ search: '' })
      const untimed = (await api.getLibrary()).games.filter(
        (g) => !g.metadata.hltb?.main && !g.metadata.hltb?.solo
      )
      expect(untimed.length).toBeGreaterThan(0)
      const progress: { done: number; total: number }[] = []
      const changed: string[] = []
      api.on('hltb:progress', (p) => progress.push(p))
      api.on('library:changed', (p) => changed.push(...(p.gameIds ?? [])))
      const run = api.refreshHltbTimes()
      expect(api.refreshHltbTimes()).toBe(run)
      await vi.advanceTimersByTimeAsync(HLTB_MOCK_STEP_MS * (untimed.length + 2))
      await run
      expect(progress[0]).toMatchObject({ done: 0, total: untimed.length })
      expect(progress.at(-1)).toEqual({ done: 0, total: 0, source: 'sort' })
      const after = (await api.getLibrary()).games
      // Every game was looked up: it has times now, or a recorded miss.
      for (const g of untimed) {
        const hltb = after.find((a) => a.id === g.id)?.metadata.hltb
        expect(hltb?.main ?? hltb?.missedAt, g.id).toBeDefined()
      }
      expect(changed.length).toBeGreaterThan(0)
      // Nothing left: a second run does nothing.
      const count = progress.length
      await api.refreshHltbTimes()
      expect(progress).toHaveLength(count)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stopHltbTimes stops the H.L.T.B. sort lookups after the game in progress', async () => {
    vi.useFakeTimers()
    try {
      const api = createMockApi({ search: '' })
      const progress: { done: number; total: number; source?: string }[] = []
      api.on('hltb:progress', (p) => progress.push(p))
      const run = api.refreshHltbTimes()
      await vi.advanceTimersByTimeAsync(0)
      await api.stopHltbTimes()
      await vi.advanceTimersByTimeAsync(HLTB_MOCK_STEP_MS * 3)
      await run
      // One game looked at, then the closing report.
      expect(progress).toHaveLength(2)
      expect(progress[0]).toMatchObject({ done: 0, source: 'sort' })
      expect(progress.at(-1)).toEqual({ done: 0, total: 0, source: 'sort' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('screen=library-large generates a large library of distinct, sortable games', async () => {
    expect(readMockFlags('?mock=1&screen=library-large')).toEqual({
      empty: false,
      slow: false,
      large: true,
      installing: false,
      queue: false,
      bars: false,
      streaming: false,
      firstStart: false,
      overlay: false,
      recompConflict: false,
      recompPinned: false,
      peerParty: false
    })
    const api = createMockApi({ search: '?screen=library-large' })
    const { games, platforms } = await api.getLibrary()
    expect(games).toHaveLength(LARGE_LIBRARY_COUNT)
    expect(new Set(games.map((g) => g.id)).size).toBe(LARGE_LIBRARY_COUNT)
    expect(games.some((g) => !g.installed)).toBe(true)
    expect(games.some((g) => g.lastPlayed)).toBe(true)
    expect(games.some((g) => !g.lastPlayed)).toBe(true)
    expect(platforms.length).toBeGreaterThan(1)
    expect(games.filter((g) => g.title === 'Hades 2')).toHaveLength(1)
  })

  it('getLibrary returns the sample library with the expected counts', async () => {
    const api = createMockApi({ search: '' })
    const { games, platforms } = await api.getLibrary()

    // 37 installed samples plus the owned, not installed games of the signed-in Steam (3) and GOG (2) accounts.
    expect(games).toHaveLength(42)
    const bySource = (source: string): number => games.filter((g) => g.source === source).length
    expect(bySource('steam')).toBe(16)
    expect(bySource('epic')).toBe(3)
    expect(bySource('gog')).toBe(5)
    expect(bySource('ea')).toBe(2)
    expect(bySource('battlenet')).toBe(2)
    expect(bySource('ubisoft')).toBe(1)
    expect(bySource('xbox')).toBe(1)
    expect(bySource('manual')).toBe(1)
    expect(bySource('rom')).toBe(11)

    expect(new Set(games.map((g) => g.id)).size).toBe(42)
    expect(games.filter((g) => g.hidden)).toHaveLength(1)
    expect(games.filter((g) => !g.installed)).toHaveLength(6)
    expect(games.filter((g) => g.favorite)).toHaveLength(4)
    const owned = games.filter((g) => g.owned)
    expect(owned).toHaveLength(5)
    for (const g of owned) {
      expect(g.installed).toBe(false)
      expect(g.installDir).toBeUndefined()
      expect(g.tracking).toEqual({ mode: 'none' })
      expect(g.launch.kind).toBe('uri')
      expect(g.media.cover).toContain('library_600x900_2x.jpg')
    }
    expect(owned.find((g) => g.source === 'steam')?.launch).toMatchObject({
      uri: expect.stringMatching(/^steam:\/\/install\/\d+$/)
    })

    // 7 stores + PC + 9 systems, sorted by sortOrder
    expect(platforms).toHaveLength(17)
    expect(platforms.map((p) => p.id)).toEqual([
      'steam',
      'epic',
      'gog',
      'ea',
      'battlenet',
      'ubisoft',
      'xbox-pc',
      'pc',
      'arcade',
      'dreamcast',
      'gba',
      'genesis',
      'n64',
      'psx',
      'snes',
      'switch',
      'xbox360'
    ])
    const snes = platforms.find((p) => p.id === 'snes')!
    expect(snes).toMatchObject({
      kind: 'system',
      icon: 'nintendo',
      manufacturer: 'Nintendo',
      sortOrder: 249
    })
    expect(platforms.find((p) => p.id === 'psx')?.icon).toBe('playstation')
    expect(platforms.find((p) => p.id === 'dreamcast')?.icon).toBe('sega')

    for (const g of games.filter((g) => g.source === 'steam' && g.installed)) {
      expect(g.media.cover).toBe(
        `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.externalId}/library_600x900_2x.jpg`
      )
      expect(g.media.hero).toBe(
        `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.externalId}/library_hero.jpg`
      )
      expect(g.media.logo).toBe(
        `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.externalId}/logo.png`
      )
      expect(g.media.screenshots?.length).toBe(2)
      expect(g.metadata.currentPlayers?.count).toBeGreaterThan(0)
      expect(g.metadata.hltb?.main).toBeGreaterThan(0)
      expect(g.launch).toEqual({ kind: 'uri', uri: `steam://rungameid/${g.externalId}` })
    }

    for (const g of games.filter((g) => g.source === 'rom')) {
      expect(g.id).toBe(romId(g.platformId, g.externalId))
      expect(g.romPath).toBe(`${ROMS_ROOT}\\${g.externalId.replace(/\//g, '\\')}`)
      expect(g.launch.kind).toBe('emulator')
    }
    expect(games.find((g) => g.id === EMULATOR_MISSING_GAME_ID)?.media).toEqual({})

    const base = Date.parse(MOCK_BASE_DATE)
    // The installed samples were all played within the last month; the owned-only records carry the store's
    // own (older) last-played time.
    const played = games.filter((g) => g.lastPlayed && !g.owned)
    expect(played.length).toBe(33)
    expect(games.filter((g) => g.lastPlayed && g.owned)).toHaveLength(2)
    for (const g of played) {
      const age = base - Date.parse(g.lastPlayed!)
      expect(age).toBeGreaterThanOrEqual(0)
      expect(age).toBeLessThanOrEqual(30 * DAY)
      expect(g.sortTitle).toBe(g.sortTitle.toLowerCase())
    }
    expect(games.find((g) => g.title === 'The Witcher 3: Wild Hunt')?.sortTitle).toBe(
      'witcher 3 wild hunt'
    )

    const sessions = await api.getSessions('steam:1145360')
    expect(sessions.length).toBeGreaterThanOrEqual(1)
    expect(sessions.every((s) => s.gameId === 'steam:1145360' && s.minutes > 0)).toBe(true)
  })

  it('getLibrary returns copies, so callers cannot corrupt the mock state', async () => {
    const api = createMockApi({ search: '' })
    const first = await api.getLibrary()
    first.games[0].title = 'changed'
    const second = await api.getLibrary()
    expect(second.games[0].title).not.toBe('changed')
  })

  it('launchGame runs a six-second session and emits the session events', async () => {
    vi.useFakeTimers()
    const api = createMockApi({ search: '' })
    const events: string[] = []
    let ended: SessionEndedPayload | null = null
    api.on('session:started', (p) => events.push(`started:${p.gameId}`))
    api.on('library:changed', (p) => events.push(`changed:${p.reason}`))
    api.on('session:ended', (p) => {
      ended = p
      events.push(`ended:${p.gameId}`)
    })

    const before = (await api.getGame('steam:1145360'))!
    const result = await api.launchGame('steam:1145360')
    expect(result.ok).toBe(true)
    expect(result.startedAt).toBeTruthy()
    expect(await api.getRunningGame()).toEqual({
      gameId: 'steam:1145360',
      startedAt: result.startedAt
    })
    expect(events).toEqual(['started:steam:1145360', 'changed:session'])

    const second = await api.launchGame('steam:620')
    expect(second.ok).toBe(false)
    expect(second.error?.kind).toBe('failed')

    await vi.advanceTimersByTimeAsync(5_900)
    expect(ended).toBeNull()
    await vi.advanceTimersByTimeAsync(200)
    expect(ended).not.toBeNull()
    const payload = ended as unknown as SessionEndedPayload
    expect(payload.gameId).toBe('steam:1145360')
    expect(payload.startedAt).toBe(result.startedAt)
    expect(payload.minutes).toBeGreaterThanOrEqual(0)
    expect(payload.minutes).toBeLessThanOrEqual(1)
    expect(await api.getRunningGame()).toBeNull()

    const after = (await api.getGame('steam:1145360'))!
    expect(after.playCount).toBe(before.playCount + 1)
    expect(after.playtimeMinutes).toBe(before.playtimeMinutes + payload.minutes)
    expect(after.lastPlayed).toBe(result.startedAt)
    const sessions = await api.getSessions('steam:1145360')
    expect(sessions[sessions.length - 1]).toMatchObject({
      startedAt: result.startedAt,
      minutes: payload.minutes
    })
  })

  it('refuses to launch an uninstalled game with a launch:error', async () => {
    const api = createMockApi({ search: '' })
    const errors: string[] = []
    api.on('launch:error', (p) => errors.push(`${p.gameId}:${p.error.kind}`))
    const result = await api.launchGame('ubisoft:5541')
    expect(result).toMatchObject({ ok: false, error: { kind: 'file-missing' } })
    expect(errors).toEqual(['ubisoft:5541:file-missing'])
  })

  it('reports a missing emulator for the Switch ROM until its path is set', async () => {
    vi.useFakeTimers()
    const api = createMockApi({ search: '' })
    const errors: string[] = []
    api.on('launch:error', (p) => errors.push(p.error.kind))

    const missing = await api.launchGame(EMULATOR_MISSING_GAME_ID)
    expect(missing.ok).toBe(false)
    expect(missing.error).toMatchObject({ kind: 'emulator-missing', emulatorId: 'RYUJINX' })
    expect(errors).toEqual(['emulator-missing'])

    const emulators = await api.getEmulators()
    expect(emulators.filter((e) => e.path === null).map((e) => e.id)).toEqual([
      'DUCKSTATION',
      'RYUJINX'
    ])
    expect(emulators.every((e) => e.searchedPaths.length > 0)).toBe(true)
    expect(emulators.find((e) => e.id === 'RETROARCH')?.coresDir).toBe('C:\\RetroArch-Win64\\cores')

    const updated = await api.setEmulatorPath('RYUJINX', 'C:\\Emulators\\Ryujinx\\Ryujinx.exe')
    expect(updated.find((e) => e.id === 'RYUJINX')).toMatchObject({
      path: 'C:\\Emulators\\Ryujinx\\Ryujinx.exe',
      foundBy: 'override'
    })
    expect((await api.getSettings()).emulators.overrides.RYUJINX).toBe(
      'C:\\Emulators\\Ryujinx\\Ryujinx.exe'
    )
    const ok = await api.launchGame(EMULATOR_MISSING_GAME_ID)
    expect(ok.ok).toBe(true)

    const systems = await api.getSystems()
    expect(systems.map((s) => s.id).sort()).toEqual([
      'arcade',
      'dreamcast',
      'gba',
      'genesis',
      'n64',
      'psx',
      'snes',
      'switch',
      'xbox360'
    ])
    expect(systems.find((s) => s.id === 'switch')?.availableEmulators).toEqual(['ryujinx'])
    expect(systems.find((s) => s.id === 'psx')?.availableEmulators).toEqual([
      'retroarch-swanstation',
      'retroarch-beetle-psx-hw'
    ])
    expect(systems.find((s) => s.id === 'snes')?.gameCount).toBe(1)
  })

  it('scanSources emits progress per source and adds one game to the first scanned source', async () => {
    vi.useFakeTimers()
    const api = createMockApi({ search: '' })
    const progress: ScanProgress[] = []
    const changes: string[] = []
    api.on('scan:progress', (p) => progress.push(p))
    api.on('library:changed', (p) => changes.push(p.reason))

    const pending = api.scanSources(['gog', 'ubisoft'])
    await vi.advanceTimersByTimeAsync(3_000)
    const result = await pending

    const gogPhases = progress.filter((p) => p.sourceId === 'gog').map((p) => p.phase)
    expect(gogPhases[0]).toBe('detecting')
    expect(gogPhases).toContain('scanning')
    expect(gogPhases[gogPhases.length - 1]).toBe('done')
    expect(progress.filter((p) => p.sourceId === 'ubisoft').map((p) => p.phase)).toEqual([
      'detecting',
      'done'
    ])
    expect(progress.find((p) => p.sourceId === 'ubisoft' && p.phase === 'done')?.message).toMatch(
      /not installed/
    )

    expect(result.added).toBe(1)
    expect(result.updated).toBe(3)
    expect(result.sources.find((s) => s.id === 'gog')).toMatchObject({
      name: 'GOG',
      gameCount: 4,
      client: { installed: true }
    })
    expect(result.sources.find((s) => s.id === 'ubisoft')).toMatchObject({
      gameCount: 0,
      client: { installed: false }
    })
    expect(changes).toContain('scan')

    const library = await api.getLibrary()
    const cuphead = library.games.find((g) => g.title === 'Cuphead')!
    expect(cuphead.source).toBe('gog')
    expect(library.games).toHaveLength(43)

    // The scrape runs in the background after the scan.
    await vi.advanceTimersByTimeAsync(1_000)
    const scraped = (await api.getGame(cuphead.id))!
    expect(scraped.metadataStatus).toBe('done')
    expect(scraped.media.cover).toContain('/268910/')
    expect(changes).toContain('metadata')

    // A second scan finds nothing new.
    const again = api.scanSources(['gog'])
    await vi.advanceTimersByTimeAsync(3_000)
    expect((await again).added).toBe(0)
  })

  it('screen=empty gives an empty library, no detected store clients and no signed-in accounts', async () => {
    const api = createMockApi({ search: '?screen=empty&mock=1' })
    const library = await api.getLibrary()
    expect(library.games).toEqual([])
    expect(library.platforms).toEqual([])
    const sources = await api.getSources()
    expect(sources).toHaveLength(9)
    expect(sources.filter((s) => s.client.installed).map((s) => s.id)).toEqual(['manual', 'rom'])
    expect(sources.every((s) => s.gameCount === 0)).toBe(true)
    // The first-run screen has the ROM folder too (main's startup sets it), so Add Games' ROM card is never stuck on
    // 'Loading…' and its scan finds no ROM rather than 'No ROM folder selected'.
    expect((await api.getSettings()).library.romsRoot).toBe(ROMS_ROOT)
    expect((await api.importEsde()).gamesUpdated).toBe(0)
    expect((await api.getAccounts()).every((a) => !a.signedIn)).toBe(true)
  })

  it('lists one account per store, Steam and GOG signed in, Ubisoft unsupported', async () => {
    const api = createMockApi({ search: '' })
    const accounts = await api.getAccounts()
    expect(accounts.map((a) => a.source)).toEqual([
      'steam',
      'epic',
      'gog',
      'ea',
      'battlenet',
      'ubisoft',
      'xbox'
    ])
    expect(accounts.find((a) => a.source === 'steam')).toMatchObject({
      supported: true,
      signedIn: true,
      displayName: MOCK_DISPLAY_NAMES.steam,
      lastImportCount: 15,
      importing: false
    })
    expect(accounts.find((a) => a.source === 'gog')?.signedIn).toBe(true)
    expect(accounts.find((a) => a.source === 'epic')).toMatchObject({
      supported: true,
      signedIn: false
    })
    expect(accounts.find((a) => a.source === 'ubisoft')).toMatchObject({
      supported: false,
      signedIn: false,
      reason: UBISOFT_REASON
    })
    await expect(api.signIn('ubisoft')).rejects.toThrow(/Ubisoft/)
  })

  it('signIn flips the account after the dialog and imports its owned games; signOut drops them', async () => {
    vi.useFakeTimers()
    const api = createMockApi({ search: '' })
    const accountEvents: AccountStatus[][] = []
    const changes: string[] = []
    api.on('accounts:changed', (list) => accountEvents.push(list))
    api.on('library:changed', (p) => changes.push(p.reason))

    const pending = api.signIn('epic')
    await vi.advanceTimersByTimeAsync(300)
    const status = await pending
    expect(status).toMatchObject({
      source: 'epic',
      signedIn: true,
      displayName: MOCK_DISPLAY_NAMES.epic
    })
    // The import runs in the background: importing true first, then the games arrive.
    expect(accountEvents.at(-1)?.find((a) => a.source === 'epic')?.importing).toBe(true)
    expect((await api.getLibrary()).games.filter((g) => g.source === 'epic')).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1_500)
    const epic = (await api.getAccounts()).find((a) => a.source === 'epic')!
    expect(epic).toMatchObject({ signedIn: true, importing: false, lastImportCount: 3 })
    expect(epic.lastImportAt).toBeDefined()
    const library = await api.getLibrary()
    const epicOwned = library.games.filter((g) => g.source === 'epic' && g.owned)
    expect(epicOwned).toHaveLength(3)
    expect(epicOwned.map((g) => g.title).sort()).toEqual(
      ownedGames('epic')
        .map((g) => g.title)
        .sort()
    )
    expect(changes).toContain('import')

    // A manual import of a signed-in store reports its counts; a signed-out one is skipped.
    const importing = api.importOwned(['epic', 'xbox'])
    await vi.advanceTimersByTimeAsync(1_500)
    const result = await importing
    expect(result.sources).toEqual([{ id: 'epic', imported: 3, added: 0, removed: 0 }])

    const signedOut = await api.signOut('epic')
    expect(signedOut).toMatchObject({ source: 'epic', signedIn: false })
    expect(signedOut.displayName).toBeUndefined()
    const after = await api.getLibrary()
    // The three installed Epic samples stay; the owned-only records are gone.
    expect(after.games.filter((g) => g.source === 'epic')).toHaveLength(3)
    expect(after.games.some((g) => g.source === 'epic' && g.owned)).toBe(false)
  })

  it('installGame tracks a fake download to done and marks the game installed', async () => {
    vi.useFakeTimers()
    const api = createMockApi({ search: '' })
    const owned = (await api.getLibrary()).games.find((g) => g.owned && g.source === 'steam')!
    const progress: InstallProgress[] = []
    const changes: string[] = []
    api.on('install:progress', (p) => progress.push(p))
    api.on('library:changed', (p) => changes.push(p.reason))

    expect(await api.installGame('steam:1145360')).toMatchObject({ ok: false })
    expect(await api.installGame(owned.id)).toEqual({ ok: true })
    expect(progress[0]).toMatchObject({ gameId: owned.id, source: 'steam', state: 'starting' })
    expect(progress[0]!.bytesTotal).toBeGreaterThan(0)
    expect(await api.getInstalls()).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(INSTALL_MS / 2)
    const midway = progress.at(-1)!
    expect(midway.state).toBe('downloading')
    expect(midway.percent).toBeGreaterThan(30)
    expect(midway.percent).toBeLessThan(70)
    expect(midway.bytesDone).toBeLessThan(midway.bytesTotal!)
    expect(midway.message).toBe('Installing through Steam…')

    await vi.advanceTimersByTimeAsync(INSTALL_MS)
    expect(progress.at(-1)).toMatchObject({ state: 'done', percent: 100 })
    expect(progress.some((p) => p.state === 'installing')).toBe(true)
    expect(await api.getInstalls()).toEqual([])
    const installed = (await api.getGame(owned.id))!
    expect(installed.installed).toBe(true)
    expect(installed.owned).toBe(true)
    expect(installed.installDir).toContain('steamapps')
    expect(installed.launch).toEqual({ kind: 'uri', uri: `steam://rungameid/${owned.externalId}` })
    expect(changes).toContain('scan')
    expect(await api.installGame(owned.id)).toMatchObject({ ok: false, error: /already installed/ })
  })

  it('cancelInstallTracking ends the watch silently and screen=detail-installing seeds one at 42 %', async () => {
    vi.useFakeTimers()
    const api = createMockApi({ search: '?screen=detail-installing' })
    expect(readMockFlags('?screen=detail-installing').installing).toBe(true)
    const [seeded] = await api.getInstalls()
    expect(seeded).toMatchObject({
      source: 'steam',
      state: 'downloading',
      percent: INSTALLING_SCREEN_PERCENT
    })
    const events: InstallProgress[] = []
    api.on('install:progress', (p) => events.push(p))
    // Held for the capture: no movement in the first seconds.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(events).toEqual([])
    await api.cancelInstallTracking(seeded!.gameId)
    expect(await api.getInstalls()).toEqual([])
    await vi.advanceTimersByTimeAsync(INSTALL_MS * 2)
    expect(events).toEqual([])
    expect((await api.getGame(seeded!.gameId))?.installed).toBe(false)
  })

  it('queues a second install while one runs and starts it when the first finishes', async () => {
    vi.useFakeTimers()
    const api = createMockApi({ search: '' })
    const [first, second, third] = (await api.getLibrary()).games.filter(
      (g) => g.owned && !g.installed
    )
    const queues: InstallQueueEntry[][] = []
    api.on('installs:queue', (q) => queues.push(q))

    expect(await api.installGame(first!.id)).toEqual({ ok: true })
    expect(await api.installGame(second!.id)).toEqual({ ok: true, queued: 1 })
    expect(await api.installGame(third!.id)).toEqual({ ok: true, queued: 2 })
    // Asking again keeps its place; only the active game downloads.
    expect(await api.installGame(third!.id)).toEqual({ ok: true, queued: 2 })
    expect((await api.getInstalls()).map((p) => p.gameId)).toEqual([first!.id])
    expect((await api.getInstallQueue()).map((e) => [e.gameId, e.state])).toEqual([
      [first!.id, 'active'],
      [second!.id, 'waiting'],
      [third!.id, 'waiting']
    ])

    await api.moveInInstallQueue(third!.id, -1)
    await api.moveInInstallQueue(third!.id, -1) // never ahead of the active one
    expect((await api.getInstallQueue()).map((e) => e.gameId)).toEqual([
      first!.id,
      third!.id,
      second!.id
    ])

    await vi.advanceTimersByTimeAsync(INSTALL_MS * 1.5)
    expect((await api.getGame(first!.id))?.installed).toBe(true)
    expect((await api.getInstallQueue()).map((e) => [e.gameId, e.state])).toEqual([
      [third!.id, 'active'],
      [second!.id, 'waiting']
    ])
    expect((await api.getInstalls()).map((p) => p.gameId)).toEqual([third!.id])

    // Removing the active one starts the next; removing a waiting one just drops it.
    await api.removeFromInstallQueue(third!.id)
    expect((await api.getInstallQueue()).map((e) => [e.gameId, e.state])).toEqual([
      [second!.id, 'active']
    ])
    await api.removeFromInstallQueue(second!.id)
    expect(await api.getInstallQueue()).toEqual([])
    expect(await api.getInstalls()).toEqual([])
    expect(queues.at(-1)).toEqual([])
  })

  it('pauses and resumes queued store installs like main: a waiting one is skipped, the active one stays active', async () => {
    vi.useFakeTimers()
    const api = createMockApi({ search: '' })
    const [first, second, third] = (await api.getLibrary()).games.filter(
      (g) => g.owned && !g.installed
    )
    const view = async (): Promise<string[]> =>
      (await api.getInstallQueue()).map((e) => `${e.gameId}:${e.state}${e.paused ? ':paused' : ''}`)
    await api.installGame(first!.id)
    await api.installGame(second!.id)
    await api.installGame(third!.id)

    // The active store install cannot be paused: it stays active (the queue is held), marked paused.
    await api.pauseInstall(first!.id)
    await api.pauseInstall(second!.id)
    expect(await view()).toEqual([
      `${first!.id}:active:paused`,
      `${second!.id}:waiting:paused`,
      `${third!.id}:waiting`
    ])
    // A paused waiting game keeps its place and can still move.
    await api.moveInInstallQueue(third!.id, -1)
    expect((await api.getInstallQueue()).map((e) => e.gameId)).toEqual([
      first!.id,
      third!.id,
      second!.id
    ])

    // When the store finishes, the next game not paused starts; the paused one keeps waiting.
    await vi.advanceTimersByTimeAsync(INSTALL_MS * 1.5)
    expect(await view()).toEqual([`${third!.id}:active`, `${second!.id}:waiting:paused`])

    // Pause all, then resume all: flags only (nothing else could start); removing a paused one works as before.
    await api.pauseInstall(null)
    expect(await view()).toEqual([`${third!.id}:active:paused`, `${second!.id}:waiting:paused`])
    await api.resumeInstall(null)
    expect(await view()).toEqual([`${third!.id}:active`, `${second!.id}:waiting`])
    await api.pauseInstall(second!.id)
    await api.removeFromInstallQueue(second!.id)
    expect(await view()).toEqual([`${third!.id}:active`])
  })

  it('a resumed game starts at once when nothing downloads', async () => {
    vi.useFakeTimers()
    const api = createMockApi({ search: '' })
    const [first, second] = (await api.getLibrary()).games.filter((g) => g.owned && !g.installed)
    await api.installGame(first!.id)
    await api.installGame(second!.id)
    await api.pauseInstall(second!.id)
    await api.removeFromInstallQueue(first!.id)
    // Nothing active: the paused game is not started.
    expect((await api.getInstallQueue()).map((e) => [e.state, e.paused])).toEqual([
      ['waiting', true]
    ])
    expect(await api.getInstalls()).toEqual([])
    await api.resumeInstall(second!.id)
    expect((await api.getInstallQueue()).map((e) => [e.gameId, e.state, e.paused])).toEqual([
      [second!.id, 'active', undefined]
    ])
    expect((await api.getInstalls()).map((p) => p.gameId)).toEqual([second!.id])
  })

  it('queue=1 seeds an install with two games waiting behind it', async () => {
    const api = createMockApi({ search: '?queue=1' })
    expect((await api.getInstallQueue()).map((e) => e.state)).toEqual([
      'active',
      'waiting',
      'waiting'
    ])
    expect(await api.getInstalls()).toHaveLength(1)
  })

  it('mock=slow delays every call by 800 ms', async () => {
    vi.useFakeTimers()
    const api = createMockApi({ search: '?mock=slow' })
    let resolved = false
    const pending = api.getAppInfo().then((info) => {
      resolved = true
      return info
    })
    await vi.advanceTimersByTimeAsync(799)
    expect(resolved).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect((await pending).version).toBe('0.1.0-mock')
    expect(resolved).toBe(true)
  })

  it('persists settings in localStorage and merges them over the defaults', async () => {
    const api = createMockApi({ search: '' })
    const initial = await api.getSettings()
    // As main: the ROM folder is the Default Emulation folder's roms folder, which holds the seeded ROM games.
    expect(initial.library.romsRoot).toBe(ROMS_ROOT)
    expect(ROMS_ROOT).toBe('C:\\Users\\Player\\AppData\\Roaming\\PlayOut\\Emulation\\roms')
    expect(initial.ui.recentCount).toBe(defaultSettings().ui.recentCount)

    const updated = await api.updateSettings({
      ui: { recentCount: 6 },
      library: { sources: { steam: { enabled: false } } as never }
    })
    expect(updated.ui.recentCount).toBe(6)
    expect(updated.ui.animations).toBe(true)
    expect(updated.library.sources.steam.enabled).toBe(false)
    expect(updated.library.sources.gog.enabled).toBe(true)

    const stored = JSON.parse(localStorage.getItem(MOCK_SETTINGS_KEY)!)
    expect(stored.ui.recentCount).toBe(6)

    const reloaded = await createMockApi({ search: '' }).getSettings()
    expect(reloaded.ui.recentCount).toBe(6)
    expect(reloaded.library.sources.steam.enabled).toBe(false)
    expect(reloaded.scrapers.artPriority).toEqual(defaultSettings().scrapers.artPriority)

    // As main: the ROM folder follows the Emulation folder (its roms folder).
    await api.updateSettings({ library: { emulationDir: 'E:\\Emulation' } })
    expect((await api.getSettings()).library.romsRoot).toBe('E:\\Emulation\\roms')
  })

  it('metadata helpers: search, apply, achievements and custom media', async () => {
    vi.useFakeTimers()
    const api = createMockApi({ search: '' })
    const candidates = await api.searchMetadata('steam:620', 'portal 2')
    expect(candidates).toHaveLength(4)
    expect(candidates.map((c) => c.scraper)).toEqual([
      'steamgriddb',
      'igdb',
      'screenscraper',
      'thegamesdb'
    ])
    expect(candidates[0].title).toBe('Portal 2')

    const custom = await api.setCustomMedia(
      'steam:620',
      'cover',
      'C:\\Users\\Player\\Pictures\\portal.png'
    )
    expect(custom.media.cover).toBe('file:///C:/Users/Player/Pictures/portal.png')
    expect(custom.user.customMedia?.cover).toBe('C:\\Users\\Player\\Pictures\\portal.png')
    const restored = await api.setCustomMedia('steam:620', 'cover', null)
    expect(restored.media.cover).toBe(
      'https://cdn.cloudflare.steamstatic.com/steam/apps/620/library_600x900_2x.jpg'
    )
    expect(restored.user.customMedia?.cover).toBeUndefined()

    // Same semantics as the main process: the chosen match replaces the previous source ids and art it does not
    // supply (the thegamesdb candidate has no cover) is dropped; custom art would survive.
    const applied = await api.applyMetadata('steam:620', candidates[3])
    expect(applied.title).toBe('Portal 2: Definitive Edition')
    expect(applied.sortTitle).toBe('portal 2 definitive edition')
    expect(applied.metadata.sources).toEqual({ thegamesdb: candidates[3].externalId })
    expect(applied.media.cover).toBeUndefined()
    expect(applied.media.hero).toBeUndefined()

    const achievements = await api.getAchievements('steam:1145360')
    expect(achievements?.list).toHaveLength(12)
    expect(achievements).toMatchObject({ total: 49, unlocked: 31 })
    expect(achievements?.list.filter((a) => a.unlocked).length).toBe(8)
    expect(await api.getAchievements('manual:c:/games/balatro/balatro.exe')).toBeNull()

    const progress: string[] = []
    api.on('metadata:progress', (p) => progress.push(`${p.status}:${p.remaining}`))
    await api.refreshMetadata(['epic:AlanWake2', 'steam:620'])
    await vi.advanceTimersByTimeAsync(2_000)
    expect(progress).toEqual(['pending:2', 'failed:1', 'pending:1', 'done:0'])
    expect((await api.getGame('epic:AlanWake2'))?.metadataStatus).toBe('failed')

    const chosen = api.chooseFile({
      title: 'Choose an image',
      filters: [{ name: 'Images', extensions: ['png', 'jpg'] }]
    })
    await vi.advanceTimersByTimeAsync(300)
    expect(await chosen).toBe('C:\\Users\\Player\\Pictures\\custom-cover.png')
  })

  it('adds manual games and scans folders', async () => {
    vi.useFakeTimers()
    const api = createMockApi({ search: '' })
    const game = await api.addManualGame({
      exePath: 'C:\\Games\\Super Game\\super-game.exe',
      args: '--windowed "extra arg"'
    })
    expect(game).toMatchObject({
      source: 'manual',
      platformId: 'pc',
      title: 'Super Game',
      // Auto-scrape is on by default: the real metadata service marks a new game pending as soon as it is queued.
      metadataStatus: 'pending'
    })
    expect(game.launch).toEqual({
      kind: 'exec',
      file: 'C:\\Games\\Super Game\\super-game.exe',
      args: ['--windowed', 'extra arg'],
      cwd: 'C:\\Games\\Super Game'
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect((await api.getGame(game.id))?.metadataStatus).toBe('failed')

    const pending = api.addGamesFromFolder('C:\\Games')
    await vi.advanceTimersByTimeAsync(1_000)
    const added = await pending
    expect(added.map((g) => g.title)).toEqual(['Noita', 'Dwarf Fortress'])
    await vi.advanceTimersByTimeAsync(2_000)
    expect((await api.getGame(added[0].id))?.media.cover).toContain('/881100/')
    expect((await api.getLibrary()).games).toHaveLength(45)

    await api.removeGame(game.id)
    expect(await api.getGame(game.id)).toBeNull()
  })

  it('system status drains the battery over uptime and reflects the controls', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-29T10:00:00.000Z'))
    const api = createMockApi({ search: '' })
    const statuses: number[] = []
    const off = api.on('system:status', (s) => statuses.push(s.battery?.percent ?? -1))

    const initial = await api.getSystemStatus()
    expect(initial).toMatchObject({
      battery: { present: true, percent: 85, charging: false },
      network: { connected: true, kind: 'wifi', ssid: 'Home', signal: 80 },
      bluetooth: { available: true, on: true },
      volume: { level: 60, muted: false },
      brightness: 70,
      powerMode: 'balanced'
    })

    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect((await api.getSystemStatus()).battery?.percent).toBe(83)
    expect(statuses.length).toBe(8)

    await api.setVolume(25)
    await api.setBrightness(40)
    await api.setPowerMode('performance')
    await api.setMuted(true)
    expect(await api.getSystemStatus()).toMatchObject({
      volume: { level: 25, muted: true },
      brightness: 40,
      powerMode: 'performance'
    })
    off()

    const perf = await api.getPerfSample()
    expect(perf.cpuPercent).toBeGreaterThanOrEqual(0)
    expect(perf.memoryTotalMb).toBe(16310)
    expect(await api.isFullscreen()).toBe(true)
    await api.setFullscreen(false)
    expect(await api.isFullscreen()).toBe(false)
  })

  describe('streaming', () => {
    /** Saved mock settings from before hosting was on by default: the host switched off. */
    const saveHostOff = (): void => {
      const settings = defaultSettings()
      settings.streaming.hostEnabled = false
      localStorage.setItem(MOCK_SETTINGS_KEY, JSON.stringify(settings))
    }

    it("setRemoteFavorite makes a host-only game a favourite on its host, as main's favourites sync", async () => {
      vi.useFakeTimers()
      const api = createMockApi({ search: '' })
      const card = (await api.getRemoteLibrary()).games[0]!
      expect(card.favorite).toBe(false)
      const done = api.setRemoteFavorite(card.id, true)
      await vi.advanceTimersByTimeAsync(500)
      await done
      expect((await api.getRemoteLibrary()).games.find((g) => g.id === card.id)?.favorite).toBe(
        true
      )
      // The sync off here: host favourites are not shown, and none can be set.
      await api.updateSettings({ streaming: { syncFavorites: false } })
      expect((await api.getRemoteLibrary()).games.find((g) => g.id === card.id)?.favorite).toBe(
        false
      )
      await expect(api.setRemoteFavorite(card.id, false)).rejects.toThrow(/Sync favourites/)
    })

    it("a host-only game shows its host's achievement counts and gets the host's list", async () => {
      const api = createMockApi({ search: '' })
      const cards = (await api.getRemoteLibrary()).games
      const counted = cards.find((g) => g.metadata.achievements)!
      expect(counted.id.startsWith('remote:')).toBe(true)
      const info = await api.getAchievements(counted.id)
      expect(info).toMatchObject({
        total: counted.metadata.achievements!.total,
        unlocked: counted.metadata.achievements!.unlocked
      })
      expect(info!.list.length).toBeGreaterThan(0)
      // A host-only game without counts, or one that is not shown: none.
      const plain = cards.find((g) => !g.metadata.achievements)!
      expect(await api.getAchievements(plain.id)).toBeNull()
      expect(await api.getAchievements('remote:nobody:steam:1')).toBeNull()
    })

    it("a refresh adds the host's play sessions of games both PCs have, once, as main's play time sync", async () => {
      vi.useFakeTimers()
      const api = createMockApi({ search: '' })
      const shared = Object.keys((await api.getRemoteLibrary()).alsoOnHost)
      expect(shared.length).toBeGreaterThan(0)
      const id = shared[0]!
      const start = (await api.getLibrary()).games.find((g) => g.id === id)!
      const before = start.playtimeMinutes
      // A session of a store whose account total this copy reads (Steam, Epic, Xbox) adds no minutes: counted there.
      const minutes = ['steam', 'epic', 'xbox'].includes(start.source) ? 0 : 45
      const refresh = async (): Promise<void> => {
        const done = api.refreshRemoteLibrary()
        await vi.advanceTimersByTimeAsync(500)
        await done
      }
      await refresh()
      const after = (await api.getLibrary()).games.find((g) => g.id === id)!
      expect(after.playtimeMinutes).toBe(before + minutes)
      expect(after.playCount).toBe(start.playCount + 1)
      expect((await api.getSessions(id)).some((s) => s.from)).toBe(true)
      // Again: counted once.
      await refresh()
      expect((await api.getLibrary()).games.find((g) => g.id === id)).toMatchObject({
        playtimeMinutes: before + minutes,
        playCount: start.playCount + 1
      })
      // The sync off: nothing taken.
      await api.updateSettings({ streaming: { syncPlaytime: false } })
      const other = createMockApi({ search: '' })
      const base = (await other.getLibrary()).games.find((g) => g.id === id)!.playtimeMinutes
      const pending = other.refreshRemoteLibrary()
      await vi.advanceTimersByTimeAsync(500)
      await pending
      expect((await other.getLibrary()).games.find((g) => g.id === id)!.playtimeMinutes).toBe(base)
    })

    it("updateGame stamps the user's favourite change (favoriteAt)", async () => {
      const api = createMockApi({ search: '' })
      const game = (await api.getLibrary()).games[0]!
      const saved = await api.updateGame(game.id, { favorite: !game.favorite })
      expect(saved.favoriteAt).toBeTruthy()
    })

    it('firstStartHosts offers nothing unless firststart=1', async () => {
      expect(readMockFlags('?firststart=1').firstStart).toBe(true)
      expect(readMockFlags('').firstStart).toBe(false)
      vi.useFakeTimers()
      const api = createMockApi({ search: '' })
      expect(await api.firstStartHosts()).toEqual([])
    })

    it('firstStartHosts with firststart=1 offers the unpaired network hosts', async () => {
      vi.useFakeTimers()
      const api = createMockApi({ search: '?firststart=1' })
      const pending = api.firstStartHosts()
      await vi.advanceTimersByTimeAsync(2_000)
      const hosts = await pending
      expect(hosts.map((h) => [h.name, h.paired])).toEqual([['Office PC', false]])
      // The same hosts as the network search, without the paired ones.
      const found = api.findStreamingHosts()
      await vi.advanceTimersByTimeAsync(2_000)
      expect((await found).filter((h) => !h.paired)).toEqual(hosts)
    })
    it('reports a paired host, a paired client and the host-only games with the duplicate kept apart', async () => {
      const api = createMockApi({ search: '' })
      const status = await api.getStreamingStatus()
      // Hosting is on for a new install (no saved settings).
      expect(status.host).toMatchObject({ enabled: true, state: 'ready', pairing: null })
      expect(status.host.clients.map((c) => c.name)).toEqual(['Bedroom Laptop'])
      expect(status.client.hosts).toMatchObject([
        { id: MOCK_HOST_ID, name: 'Living Room PC', online: true }
      ])
      const remote = await api.getRemoteLibrary()
      expect(remote.games.map((g) => g.title).sort()).toEqual([
        'Hades II',
        'Mega Man X',
        'Sonic the Hedgehog'
      ])
      // The host-only Sonic has recompilations, matched with this PC's catalog (Filters > Recompilations).
      expect(
        remote.games.find((g) => g.title === 'Sonic the Hedgehog')?.metadata.recomp
      ).toMatchObject({
        titleKey: 'genesis:sonic the hedgehog'
      })
      expect(remote.games.find((g) => g.title === 'Mega Man X')?.metadata.recomp).toBeUndefined()
      for (const g of remote.games) {
        expect(g.id.startsWith(`remote:${MOCK_HOST_ID}:`)).toBe(true)
        expect(g).toMatchObject({ installed: false, remote: { hostName: 'Living Room PC' } })
      }
      const rom = remote.games.find((g) => g.title === 'Mega Man X')!
      expect(rom.remote).toMatchObject({ downloadable: true, streamable: true })
      expect(rom.remote!.sizeBytes).toBeGreaterThan(0)
      expect(remote.alsoOnHost['steam:1145360']).toMatchObject([
        { hostId: MOCK_HOST_ID, hostGameId: 'steam:1145360' }
      ])
    })

    it('screen=settings-streaming turns the host on and shows a PIN; screen=empty has nothing paired', async () => {
      expect(readMockFlags('?screen=settings-streaming').streaming).toBe(true)
      const api = createMockApi({ search: '?screen=settings-streaming' })
      expect((await api.getSettings()).streaming.hostEnabled).toBe(true)
      const { host } = await api.getStreamingStatus()
      expect(host).toMatchObject({
        enabled: true,
        state: 'ready',
        portForwarding: { state: 'mapped' }
      })
      expect(host.pairing?.pin).toMatch(/^\d{4}$/)
      const empty = await createMockApi({ search: '?screen=empty' }).getStreamingStatus()
      expect(empty.client.hosts).toEqual([])
      expect(empty.host.clients).toEqual([])
    })

    it('turning the host on downloads Sunshine, then maps the ports; pairing needs the host on', async () => {
      vi.useFakeTimers()
      saveHostOff()
      const api = createMockApi({ search: '' })
      await expect(api.startStreamingPairing()).rejects.toThrow(/Turn on/)
      const states: string[] = []
      api.on('streaming:status', (s) =>
        states.push(`${s.host.state}/${s.host.sunshine.state}/${s.host.portForwarding.state}`)
      )
      await api.updateSettings({ streaming: { hostEnabled: true } })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(states[0]).toBe('starting/downloading/off')
      expect(states.at(-1)).toBe('ready/running/mapped')
      const opened = await api.startStreamingPairing()
      expect(opened.host.pairing?.pin).toMatch(/^\d{4}$/)
      expect((await api.cancelStreamingPairing()).host.pairing).toBeNull()
      expect((await api.removeStreamingClient('client-laptop')).host.clients).toEqual([])
      await api.updateSettings({ streaming: { hostEnabled: false } })
      expect((await api.getStreamingStatus()).host).toMatchObject({
        state: 'off',
        sunshine: { state: 'installed' }
      })
    })

    it('finds hosts and pairs with the PIN 1234 only', async () => {
      vi.useFakeTimers()
      const api = createMockApi({ search: '' })
      const found = api.findStreamingHosts()
      await vi.advanceTimersByTimeAsync(2_000)
      expect((await found).map((h) => [h.name, h.paired])).toEqual([
        ['Living Room PC', true],
        ['Office PC', false]
      ])
      const wrong = expect(api.pairStreamingHost('192.168.1.40', '0000')).rejects.toThrow(
        /Wrong PIN/
      )
      await vi.advanceTimersByTimeAsync(1_000)
      await wrong
      await expect(api.pairStreamingHost('192.168.1.40', '12')).rejects.toThrow(/4 digits/)
      const paired = api.pairStreamingHost('192.168.1.40:47900', MOCK_STREAMING_PIN)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(await paired).toMatchObject({ id: 'host-office', name: 'Office PC', online: true })
      expect((await api.getRemoteLibrary()).games.map((g) => g.title)).toContain(
        'Vampire Survivors'
      )
      await api.removeStreamingHost('host-office')
      expect((await api.getRemoteLibrary()).games.map((g) => g.title)).not.toContain(
        'Vampire Survivors'
      )
    })

    it('streams through preparing, connecting and streaming, and stopStream ends it', async () => {
      vi.useFakeTimers()
      const api = createMockApi({ search: '' })
      const states: string[] = []
      api.on('streaming:session', (s) => states.push(s.state))
      const { games } = await api.getRemoteLibrary()
      const hades2 = games.find((g) => g.title === 'Hades II')!
      const started = api.streamGame(hades2.id)
      await vi.advanceTimersByTimeAsync(2_000)
      await started
      expect(states).toEqual(['preparing', 'connecting', 'streaming'])
      await expect(api.streamGame('steam:1145360', MOCK_HOST_ID)).rejects.toThrow(
        /already streaming/
      )
      await api.stopStream()
      expect(states.at(-1)).toBe('ended')
      // A game both PCs have streams from the host named.
      const both = api.streamGame('steam:1145360', MOCK_HOST_ID)
      await vi.advanceTimersByTimeAsync(STREAM_MS + 2_000)
      await both
      expect(states.slice(-4)).toEqual(['preparing', 'connecting', 'streaming', 'ended'])
      await expect(api.streamGame('steam:999')).rejects.toThrow(/No paired computer/)
    })

    it('a stream stopped while preparing or connecting stays stopped', async () => {
      vi.useFakeTimers()
      const api = createMockApi({ search: '' })
      const states: string[] = []
      api.on('streaming:session', (s) => states.push(s.state))
      const { games } = await api.getRemoteLibrary()
      const started = api.streamGame(games.find((g) => g.title === 'Hades II')!.id)
      await vi.advanceTimersByTimeAsync(100)
      await api.stopStream()
      await vi.advanceTimersByTimeAsync(STREAM_MS + 2_000)
      await started
      expect(states).toEqual(['preparing', 'ended'])
    })

    it("edits a host-only game like main: the host's values are scraped, the edit goes with a download", async () => {
      vi.useFakeTimers()
      const api = createMockApi({ search: '' })
      const libraries: string[] = []
      api.on('streaming:library', (lib) =>
        libraries.push(lib.games.find((g) => g.source === 'rom')?.metadata.description ?? '')
      )
      const rom = (await api.getRemoteLibrary()).games.find((g) => g.source === 'rom')!
      const before = await api.getMetadataLayers(rom.id)
      expect(before.local).toEqual({})
      expect(before.scraped.title).toBe(rom.title)
      const shown = await api.setMetadataEdit(rom.id, { description: 'Mine', title: 'MMX' })
      expect(shown).toMatchObject({ id: rom.id, metadata: { description: 'Mine' } })
      expect(shown.user.titleOverride).toBe('MMX')
      expect(libraries.at(-1)).toBe('Mine')
      expect((await api.getMetadataLayers(rom.id)).local).toEqual({
        title: 'MMX',
        description: 'Mine'
      })
      expect((await api.clearMetadataEdit(rom.id, ['title'])).user.titleOverride).toBeUndefined()
      await expect(api.getMetadataLayers('remote:nowhere:x')).rejects.toThrow(/Unknown game/)
      // Downloaded: this PC's record has the edit.
      await api.downloadRemoteRom(rom.id)
      await vi.advanceTimersByTimeAsync(ROM_DOWNLOAD_MS + 1_000)
      const local = (await api.getLibrary()).games.find((g) => g.title === rom.title)!
      expect(local.metadata.description).toBe('Mine')
      expect((await api.getMetadataLayers(local.id)).local).toEqual({ description: 'Mine' })
    })

    it('removing a host cancels its running ROM downloads, like the real service', async () => {
      vi.useFakeTimers()
      const api = createMockApi({ search: '' })
      const progress: string[] = []
      api.on('streaming:download', (p) => progress.push(`${p.state}:${p.message ?? ''}`))
      const rom = (await api.getRemoteLibrary()).games.find((g) => g.source === 'rom')!
      await api.downloadRemoteRom(rom.id)
      await vi.advanceTimersByTimeAsync(1_000)
      await api.removeStreamingHost(MOCK_HOST_ID)
      expect(progress.at(-1)).toBe('cancelled:')
      const count = progress.length
      await vi.advanceTimersByTimeAsync(ROM_DOWNLOAD_MS + 500)
      expect(progress).toHaveLength(count)
    })

    it('screen=settings-streaming does not save the host as on for later mock sessions', async () => {
      saveHostOff()
      const saved = localStorage.getItem(MOCK_SETTINGS_KEY)
      const api = createMockApi({ search: '?screen=settings-streaming' })
      expect((await api.getSettings()).streaming.hostEnabled).toBe(true)
      await api.updateSettings({ ui: {} })
      expect(localStorage.getItem(MOCK_SETTINGS_KEY)).toBe(saved)
      expect((await createMockApi({ search: '' }).getSettings()).streaming.hostEnabled).toBe(false)
    })

    it('downloads a host-only ROM into the library, and cancels one', async () => {
      vi.useFakeTimers()
      const api = createMockApi({ search: '' })
      const progress: string[] = []
      api.on('streaming:download', (p) => progress.push(`${p.state}:${p.percent}`))
      const remote = await api.getRemoteLibrary()
      const rom = remote.games.find((g) => g.source === 'rom')!
      const pc = remote.games.find((g) => g.source === 'steam')!
      await expect(api.downloadRemoteRom(pc.id)).rejects.toThrow(/Only ROM games/)
      await api.downloadRemoteRom(rom.id)
      await vi.advanceTimersByTimeAsync(1_000)
      await api.cancelRemoteRomDownload(rom.id)
      expect(progress.at(-1)).toMatch(/^cancelled:/)
      await api.downloadRemoteRom(rom.id)
      await vi.advanceTimersByTimeAsync(ROM_DOWNLOAD_MS + 500)
      expect(progress.at(-1)).toBe('done:100')
      const local = (await api.getLibrary()).games.find((g) => g.title === 'Mega Man X')
      expect(local).toMatchObject({ source: 'rom', installed: true, platformId: 'snes' })
      const after = await api.getRemoteLibrary()
      expect(after.games.map((g) => g.title)).toEqual(['Hades II', 'Sonic the Hedgehog'])
      expect(after.alsoOnHost[local!.id]).toHaveLength(1)
    })

    it('queues a host ROM download behind a store install, like main, and cancelling leaves the queue', async () => {
      vi.useFakeTimers()
      const api = createMockApi({ search: '' })
      const progress: string[] = []
      api.on('streaming:download', (p) => progress.push(p.state))
      const rom = (await api.getRemoteLibrary()).games.find((g) => g.source === 'rom')!
      const store = (await api.getLibrary()).games.find((g) => g.owned && !g.installed)!
      await api.updateGame(store.id, { user: { titleOverride: 'Renamed' } })

      expect(await api.installGame(store.id)).toEqual({ ok: true })
      await api.downloadRemoteRom(rom.id)
      await api.downloadRemoteRom(rom.id) // asking again keeps its place
      expect(progress).toEqual([])
      expect(
        (await api.getInstallQueue()).map((e) => [e.gameId, e.kind, e.state, e.title])
      ).toEqual([
        [store.id, 'store', 'active', 'Renamed'],
        [rom.id, 'host-rom', 'waiting', 'Mega Man X']
      ])

      // Its turn comes when the install ends; then it downloads and leaves the queue once done.
      await vi.advanceTimersByTimeAsync(INSTALL_MS * 1.5)
      expect((await api.getInstallQueue()).map((e) => [e.gameId, e.state])).toEqual([
        [rom.id, 'active']
      ])
      expect(progress[0]).toBe('downloading')
      await vi.advanceTimersByTimeAsync(ROM_DOWNLOAD_MS + 500)
      expect(progress.at(-1)).toBe('done')
      expect(await api.getInstallQueue()).toEqual([])
    })

    it('cancelRemoteRomDownload takes the ROM out of the queue: waiting or active, the next one starts', async () => {
      vi.useFakeTimers()
      const api = createMockApi({ search: '' })
      const progress: string[] = []
      api.on('streaming:download', (p) => progress.push(p.state))
      const rom = (await api.getRemoteLibrary()).games.find((g) => g.source === 'rom')!
      const [first, second] = (await api.getLibrary()).games.filter((g) => g.owned && !g.installed)

      // Waiting: it just leaves.
      await api.installGame(first!.id)
      await api.downloadRemoteRom(rom.id)
      await api.cancelRemoteRomDownload(rom.id)
      expect((await api.getInstallQueue()).map((e) => e.gameId)).toEqual([first!.id])
      expect(progress).toEqual([])

      // Active: the download is cancelled and the next game starts.
      await api.removeFromInstallQueue(first!.id)
      await api.downloadRemoteRom(rom.id)
      await api.installGame(second!.id)
      expect(progress).toEqual(['downloading'])
      await api.cancelRemoteRomDownload(rom.id)
      expect(progress.at(-1)).toBe('cancelled')
      expect((await api.getInstallQueue()).map((e) => [e.gameId, e.state])).toEqual([
        [second!.id, 'active']
      ])
      expect((await api.getInstalls()).map((p) => p.gameId)).toEqual([second!.id])
    })

    it("removeStreamingHost drops that host's ROM downloads waiting in the queue, like main", async () => {
      vi.useFakeTimers()
      const api = createMockApi({ search: '' })
      const rom = (await api.getRemoteLibrary()).games.find((g) => g.source === 'rom')!
      const store = (await api.getLibrary()).games.find((g) => g.owned && !g.installed)!
      await api.installGame(store.id)
      await api.downloadRemoteRom(rom.id)
      expect((await api.getInstallQueue()).map((e) => e.gameId)).toEqual([store.id, rom.id])
      await api.removeStreamingHost(MOCK_HOST_ID)
      expect((await api.getInstallQueue()).map((e) => [e.gameId, e.state])).toEqual([
        [store.id, 'active']
      ])
    })

    it('pausing the active ROM download keeps what it has, starts the next, and resumes from there', async () => {
      vi.useFakeTimers()
      const api = createMockApi({ search: '' })
      const progress: { state: string; bytesDone: number }[] = []
      api.on('streaming:download', (p) => progress.push({ state: p.state, bytesDone: p.bytesDone }))
      const rom = (await api.getRemoteLibrary()).games.find((g) => g.source === 'rom')!
      const store = (await api.getLibrary()).games.find((g) => g.owned && !g.installed)!
      await api.downloadRemoteRom(rom.id)
      await api.installGame(store.id)
      await vi.advanceTimersByTimeAsync(ROM_DOWNLOAD_MS / 2)

      await api.pauseInstall(rom.id)
      const paused = progress.at(-1)!
      expect(paused.state).toBe('paused')
      expect(paused.bytesDone).toBeGreaterThan(0)
      expect((await api.getInstallQueue()).map((e) => [e.gameId, e.state, !!e.paused])).toEqual([
        [store.id, 'active', false],
        [rom.id, 'waiting', true]
      ])
      // Nothing more arrives while paused, even after the store install ends.
      const count = progress.length
      await vi.advanceTimersByTimeAsync(INSTALL_MS * 1.5)
      expect(progress).toHaveLength(count)
      expect((await api.getInstallQueue()).map((e) => [e.gameId, e.state])).toEqual([
        [rom.id, 'waiting']
      ])

      // Resumed: it starts at once (nothing else downloads) from what it had.
      await api.resumeInstall(rom.id)
      expect(progress[count]).toEqual({ state: 'downloading', bytesDone: paused.bytesDone })
      await vi.advanceTimersByTimeAsync(ROM_DOWNLOAD_MS / 2 + 1_000)
      expect(progress.at(-1)!.state).toBe('done')
      expect(await api.getInstallQueue()).toEqual([])
    })

    it('removing a paused ROM download drops what it kept (cancelled)', async () => {
      vi.useFakeTimers()
      const api = createMockApi({ search: '' })
      const progress: string[] = []
      api.on('streaming:download', (p) => progress.push(p.state))
      const rom = (await api.getRemoteLibrary()).games.find((g) => g.source === 'rom')!
      await api.downloadRemoteRom(rom.id)
      await vi.advanceTimersByTimeAsync(1_000)
      await api.pauseInstall(null)
      expect(progress.at(-1)).toBe('paused')
      await api.removeFromInstallQueue(rom.id)
      expect(progress.at(-1)).toBe('cancelled')
      expect(await api.getInstallQueue()).toEqual([])
      // Downloading it again starts from nothing.
      await api.downloadRemoteRom(rom.id)
      expect(progress.at(-1)).toBe('downloading')
    })

    it('refuses a ROM download while no ROM folder is set, like main', async () => {
      const api = createMockApi({ search: '' })
      const rom = (await api.getRemoteLibrary()).games.find((g) => g.source === 'rom')!
      await api.updateSettings({ library: { romsRoot: null } })
      await expect(api.downloadRemoteRom(rom.id)).rejects.toThrow(/Choose your Emulation folder/)
    })
  })

  it('sets up the missing emulators with progress, then reports them installed by PlayOut', async () => {
    vi.useFakeTimers()
    const api = createMockApi({ search: '' })
    const progress: { done: number; total: number; stage?: string }[] = []
    api.on('emulator-setup:progress', (p) => progress.push(p))

    const before = await api.getEmulatorSetup()
    expect(before.items).toHaveLength(14)
    expect(before.items.every((i) => i.state === 'missing')).toBe(true)
    expect(before.biosDir).toBe(`${before.emulationDir}\\bios`)
    const listed = await api.getEmulators()
    expect(listed.find((e) => e.id === 'RYUJINX')).toMatchObject({ installable: true, path: null })
    expect(listed.find((e) => e.id === 'SNES9X')?.installable).toBe(false)

    const started = await api.setupEmulators(['RYUJINX', 'DUCKSTATION'])
    expect(started.progress.total).toBe(2)
    expect(started.items.find((i) => i.id === 'RYUJINX')?.state).toBe('installing')
    // A second call while running changes nothing.
    expect((await api.setupEmulators()).progress.total).toBe(2)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(progress.map((p) => p.stage)).toContain('runtimes')
    expect(progress.map((p) => p.stage)).toContain('bios')
    expect(progress.at(-1)).toEqual({ done: 0, total: 0 })

    const after = await api.getEmulatorSetup()
    expect(after.items.filter((i) => i.state === 'installed').map((i) => i.id)).toEqual([
      'DUCKSTATION',
      'RYUJINX'
    ])
    expect(after.notices.length).toBeGreaterThan(0)
    expect((await api.getEmulators()).find((e) => e.id === 'RYUJINX')).toMatchObject({
      foundBy: 'playout',
      path: expect.stringMatching(/\\Emulators\\Ryujinx\\Ryujinx\.exe$/)
    })
  })

  it('keeps every queued emulator installing until its worker finishes it', async () => {
    vi.useFakeTimers()
    const api = createMockApi({ search: '' })
    const progress: { current?: string[] }[] = []
    api.on('emulator-setup:progress', (p) => progress.push(p))

    await api.setupEmulators()
    // Past the runtimes stage: three workers are busy, the rest wait in the queue.
    await vi.advanceTimersByTimeAsync(1_300)
    const mid = await api.getEmulatorSetup()
    expect(mid.items.every((i) => i.state === 'installing')).toBe(true)
    expect(mid.progress.current).toHaveLength(3)

    // After the first batch, those three are installed and the rest still installing.
    await vi.advanceTimersByTimeAsync(1_850)
    const later = await api.getEmulatorSetup()
    expect(later.items.filter((i) => i.state === 'installed')).toHaveLength(3)
    expect(later.items.filter((i) => i.state === 'installing')).toHaveLength(11)
    expect(later.items.some((i) => i.state === 'missing')).toBe(false)
    expect(progress.every((p) => (p.current?.length ?? 0) <= 3)).toBe(true)
  })

  it('steamDlc lists an installed game’s DLC and setSteamDlc applies the choice at once', async () => {
    vi.useFakeTimers()
    const api = createMockApi({ search: '' })
    const info = await api.steamDlc('steam:1091500')
    expect(info).toMatchObject({
      appId: 1091500,
      installed: true,
      steamRunning: true,
      blocked: null,
      notOwnedCount: 2,
      plannedDisabled: null
    })
    expect(info.error).toBeUndefined()
    const byName = (name: string): SteamDlcItem => info.dlc.find((d) => d.name.endsWith(name))!
    expect(info.dlc).toHaveLength(4)
    expect(byName('Phantom Liberty')).toMatchObject({ enabled: true, installed: true })
    expect(byName('Bonus Content')).toMatchObject({ enabled: false, installed: false })
    expect(byName('Digital Goodies')).toMatchObject({ sizeBytes: null, enabled: true })
    expect(byName('REDmod')).toMatchObject({ steamOnly: true })

    // Phantom Liberty off, Bonus Content on: content removed and downloaded, Steam restarted.
    const result = await api.setSteamDlc('steam:1091500', [2138330])
    expect(result).toEqual({ ok: true, restartedSteam: true })
    const after = await api.steamDlc('steam:1091500')
    expect(after.dlc.find((d) => d.appId === 2138330)).toMatchObject({
      enabled: false,
      installed: false
    })
    expect(after.dlc.find((d) => d.appId === 1477390)).toMatchObject({
      enabled: true,
      installed: true
    })
    // The Steam-only DLC kept its state.
    expect(after.dlc.find((d) => d.appId === 2060310)).toMatchObject({ enabled: false })

    // A running game blocks it (Steam is never closed during a game).
    await api.launchGame('steam:1091500')
    expect((await api.steamDlc('steam:1091500')).blocked).toMatch(/Cyberpunk 2077 is running/)
    expect(await api.setSteamDlc('steam:1091500', [])).toMatchObject({ ok: false })

    expect((await api.steamDlc('steam:620')).dlc).toEqual([])
    expect((await api.steamDlc('steam:2050650')).error).toBeTruthy()
    await expect(api.steamDlc(EMULATOR_MISSING_GAME_ID)).rejects.toThrow(/not a Steam game/)
  })

  it('setSteamDlc on a game not installed is planned and applied when its install finishes', async () => {
    vi.useFakeTimers()
    const api = createMockApi({ search: '' })
    const applied: string[] = []
    api.on('steam-dlc:applied', (p) => applied.push(`${p.gameId}:${p.ok}`))
    const rdr2 = 'steam:1174180'
    const before = await api.steamDlc(rdr2)
    expect(before.installed).toBe(false)
    expect(before.dlc.every((d) => d.enabled && d.owned === null)).toBe(true)
    expect(before.notOwnedCount).toBe(0)

    expect(await api.installGame(rdr2)).toEqual({ ok: true })
    expect(await api.setSteamDlc(rdr2, [1404211])).toEqual({ ok: true, planned: true })
    expect((await api.steamDlc(rdr2)).plannedDisabled).toEqual([1404211])

    await vi.advanceTimersByTimeAsync(INSTALL_MS * 2)
    expect(applied).toEqual([`${rdr2}:true`])
    const after = await api.steamDlc(rdr2)
    expect(after.installed).toBe(true)
    expect(after.plannedDisabled).toBeNull()
    expect(after.dlc.find((d) => d.appId === 1404211)).toMatchObject({
      enabled: false,
      installed: false
    })
    expect(after.dlc.find((d) => d.appId === 1404212)).toMatchObject({
      enabled: true,
      installed: true
    })
  })

  it('implements every method of the PlayOutApi contract', () => {
    const api: PlayOutApi = createMockApi({ search: '' })
    for (const method of Object.keys(api))
      expect(typeof api[method as keyof PlayOutApi]).toBe('function')
  })

  it('lists every invokable PlayOutApi method in API_METHODS exactly once', () => {
    // The mock implements the whole interface (the compiler checks that), so its keys are the contract at run time.
    // Preload builds window.playout from API_METHODS: a method missing there would be undefined in the real app.
    const api: PlayOutApi = createMockApi({ search: '' })
    const invokable = Object.keys(api).filter((method) => method !== 'on')
    const listed: readonly string[] = API_METHODS
    expect(invokable.filter((method) => !listed.includes(method))).toEqual([])
    expect(listed.filter((method) => !invokable.includes(method))).toEqual([])
    expect(listed.filter((method, i) => listed.indexOf(method) !== i)).toEqual([])
    expect(listed).not.toContain('on')
  })
})
