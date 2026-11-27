// In-memory PlayOutApi for the browser (`npm run dev:web`), Electron `--mock` and screenshots (docs/ARCHITECTURE.md §6.4).
// Deterministic sample data lives in data.ts / fixtures.ts / systems.ts; this module adds behaviour: scans, launches,
// metadata jobs, settings persistence and a system status that changes over time.
//
// Query flags (window.location.search): `screen=empty` -> empty library and no store clients; `mock=slow` -> every
// call waits 800 ms so loading states can be checked.
import { API_METHODS, type ApiMethod, type PlayOutApi } from '@shared/api'
import { missingArtKinds } from '@shared/art-sources'
import { convertPair, type ConvertStatus } from '@shared/convert'
import { defaultSettings } from '@shared/defaults'
import { hltbTimesDue } from '@shared/hltb-time'
import {
  effectiveGame,
  metadataLayers,
  withMetadataEdit,
  withoutMetadataEdit
} from '@shared/metadata-edit'
import { PC_PLATFORM, STORE_PLATFORMS } from '@shared/platforms'
import {
  STORE_SOURCES,
  type AccountStatus,
  type EmulatorSetupProgress,
  type EmulatorSetupStatus,
  type EmulatorUpdateItem,
  type EmulatorUpdateReport,
  type EmulatorStatus,
  type Game,
  type GameUserData,
  type ImportOwnedResult,
  type InstallProgress,
  type InstallQueueEntry,
  type GameRecompInfo,
  type LaunchError,
  type LaunchResult,
  type LaunchSpec,
  type LocalDeletePlan,
  type LocalDeleteResult,
  type MediaKind,
  type PerfSample,
  type Platform,
  type PlaySession,
  type PowerMode,
  type RetroAchievementsStatus,
  type ScanProgress,
  type ScanResult,
  type Settings,
  type SettingsPatch,
  type SourceId,
  type SourceStatus,
  type StoreSourceId,
  type SystemStatus,
  type UpdateStatus
} from '@shared/types'
import {
  MOCK_DISPLAY_NAMES,
  installDirFor,
  launchUri,
  mockAccounts,
  ownedGameBytes,
  ownedGames,
  signedOutAccounts
} from './accounts'
import { fileUrl } from './art'
import {
  DETECTED_CLIENTS,
  ESDE_HOME,
  MOCK_EMULATION_DIR,
  NO_CLIENTS,
  ROMS_ROOT,
  SOURCE_NAMES,
  buildGame,
  daysAgo,
  largeLibrary,
  platformsFor,
  sampleGames,
  sortTitle
} from './data'
import { createEmitter } from './emitter'
import {
  discoverableGames,
  folderGames,
  sampleAchievements,
  sampleCandidates,
  sampleSessions,
  scrapeForTitle,
  shortId,
  type Discoverable
} from './fixtures'
import { createRecompMock } from './recomp'
import { createVrModsMock } from './vrMods'
import { createSteamDlcMock } from './steamDlc'
import { createUpgradesMock } from './upgrades'
import { createPcSavesMock } from './pcSaves'
import { createPeerPartyMock } from './peerparty'
import { createMetadataCloudMock } from './metadataCloud'
import { createStreamingMock } from './streaming'
import { displayTitle } from '../../lib/library'
import { createOverlayMock } from './overlay'
import { createFriendsMock, type MockFriendsMode } from './friends'
import {
  MOCK_SETUP_ROOT,
  SETUP_EMULATORS,
  emulatorStatuses,
  primaryEmulatorFor,
  setupExeOf,
  systemInfos,
  systemPlatforms
} from './systems'

export { EMULATOR_MISSING_GAME_ID, MOCK_BASE_DATE } from './data'
export { MOCK_DISPLAY_NAMES, UBISOFT_REASON, ownedGames } from './accounts'

export const MOCK_SETTINGS_KEY = 'playout.mock.settings'
export const MOCK_VERSION = '0.1.0-mock'

const SLOW_LATENCY_MS = 800
const SESSION_MS = 6_000
const DIALOG_MS = 300
const SCAN_MS = 2_000
const SCRAPE_STEP_MS = 450
const STATUS_INTERVAL_MS = 15_000
const BATTERY_AT_START = 85
/** A fake owned-library import takes this long per store. */
const IMPORT_MS = 1_200
/** A fake install downloads 0 -> 100 % over INSTALL_MS, reporting every INSTALL_TICK_MS. */
export const INSTALL_MS = 6_000
const INSTALL_TICK_MS = 500
/** `screen=detail-installing`: the seeded install holds at this percent for INSTALL_HOLD_MS before it moves on. */
export const INSTALLING_SCREEN_PERCENT = 42
const INSTALL_HOLD_MS = 5_000

const ALL_SOURCES: SourceId[] = [...STORE_SOURCES, 'manual', 'rom']
type CustomMediaKind = Exclude<MediaKind, 'screenshot' | 'video'>

export interface MockFlags {
  /** `firststart=1`: PlayOut's first start (firstStartHosts offers the network's hosts). */
  firstStart?: boolean
  empty: boolean
  slow: boolean
  /** `screen=library-large`: a generated library of LARGE_LIBRARY_COUNT games instead of the 33 samples. */
  large: boolean
  /** `screen=detail-installing`: the first owned Steam game starts with a tracked install at INSTALLING_SCREEN_PERCENT. */
  installing: boolean
  /** `queue=1`: the same seeded install, plus the next two owned games waiting in the install queue behind it. */
  queue: boolean
  /**
   * `bars=1`: a slow install-size scan, review scores and HowLongToBeat pass run beside the art downloads (covers,
   * then the remaining art), so the bottom bars show.
   */
  bars: boolean
  /** `screen=settings-streaming`: this PC's host is on and shows a pairing PIN (mock/streaming.ts). */
  streaming: boolean
  /** `overlay=1`: the overlay window preview (mock/overlay.ts): it starts open over a running game. */
  overlay: boolean
  /** `recomp=conflict`: Doom64EX+'s saves start in a conflict with their copy (mock/recomp.ts), for the banner on its page. */
  recompConflict: boolean
  /** `recomp=pinned`: Doom64EX+ starts pinned to its older release (Change version / Back to latest). */
  recompPinned: boolean
  /** `peerparty=1` (with `overlay=1`): the game running under the overlay preview runs through PeerParty (its tile). */
  peerParty?: boolean
  /** `friends=empty|private|nokey`: the overlay's Friends tab with no friends or one of its errors (mock/friends.ts). */
  friends?: MockFriendsMode
}

/** Size of the generated library behind `screen=library-large` (100 grid rows at six columns). */
export const LARGE_LIBRARY_COUNT = 600

export interface MockOptions {
  /** Query string to read the flags from; defaults to window.location.search. */
  search?: string
}

export function readMockFlags(search?: string): MockFlags {
  let query = search
  if (query === undefined) {
    try {
      query = typeof window !== 'undefined' ? window.location.search : ''
    } catch {
      query = ''
    }
  }
  const params = new URLSearchParams(query)
  const screen = params.get('screen')
  return {
    empty: screen === 'empty',
    slow: params.get('mock') === 'slow',
    large: screen === 'library-large',
    installing: screen === 'detail-installing' || params.get('queue') === '1',
    queue: params.get('queue') === '1',
    bars: params.get('bars') === '1',
    streaming: screen === 'settings-streaming',
    firstStart: params.get('firststart') === '1',
    overlay: params.get('overlay') === '1',
    recompConflict: params.get('recomp') === 'conflict',
    recompPinned: params.get('recomp') === 'pinned',
    peerParty: params.get('peerparty') === '1',
    friends: friendsMode(params.get('friends'))
  }
}

/** `friends=`: unset (undefined) unless the query names one of the states. */
function friendsMode(value: string | null): MockFriendsMode | undefined {
  return value === 'empty' || value === 'private' || value === 'nokey' ? value : undefined
}

/** The owned, not installed games in STORE_SOURCES order, Steam first: the `detail-install*` screens open the first. */
export function firstOwnedGame(games: Iterable<Game>): Game | undefined {
  return ownedGamesInOrder(games)[0]
}

function ownedGamesInOrder(games: Iterable<Game>): Game[] {
  const owned = [...games].filter((g) => g.owned && !g.installed)
  owned.sort(
    (a, b) =>
      STORE_SOURCES.indexOf(a.source) - STORE_SOURCES.indexOf(b.source) ||
      a.sortTitle.localeCompare(b.sortTitle)
  )
  return owned
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
/** One mock H.L.T.B. lookup (refreshHltbTimes): about HLTB's one a second. */
export const HLTB_MOCK_STEP_MS = 800
/** A mock miss is asked about again after this long (main's HLTB_MISS_RETRY_MS). */
const HLTB_MOCK_MISS_RETRY_MS = 30 * 24 * 60 * 60 * 1000
const clone = <T>(value: T): T => structuredClone(value)
/** A game as main shows it: the user's metadata edit laid over (the browser mock has no metadata cloud). */
const view = (game: Game): Game => effectiveGame(clone(game))
const now = (): string => new Date().toISOString()
const log = (...args: unknown[]): void => console.info('[mock]', ...args)
const reportError = (err: unknown): void => console.error('[mock] background job failed', err)

// ---------------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------------

function loadSettings(flags: MockFlags): Settings {
  const base = defaultSettings()
  let stored: SettingsPatch | null = null
  try {
    const raw = globalThis.localStorage.getItem(MOCK_SETTINGS_KEY)
    if (raw) stored = JSON.parse(raw) as SettingsPatch
  } catch (err) {
    console.warn('[mock] saved settings are unavailable, using defaults', err)
  }
  const settings = stored ? mergeSettings(base, stored) : base
  // Over the stored settings, which always carry hostEnabled; updateSettings does not save while this screen is up.
  if (flags.streaming) settings.streaming.hostEnabled = true
  // As main's startup sync (keepRomsRootInSync), the empty screen too: the ROM folder is the Emulation folder's roms
  // folder, over a stored one of an older mock session.
  settings.library.romsRoot = `${settings.library.emulationDir ?? MOCK_EMULATION_DIR}\\roms`
  return settings
}

function saveSettings(settings: Settings): void {
  try {
    globalThis.localStorage.setItem(MOCK_SETTINGS_KEY, JSON.stringify(settings))
  } catch (err) {
    console.warn('[mock] settings could not be saved', err)
  }
}

/** One-level-deep merge (SettingsPatch is one level deep); `library.sources` is merged per source as well. */
function mergeSettings(base: Settings, patch: SettingsPatch): Settings {
  const next = clone(base)
  for (const key of Object.keys(patch) as (keyof SettingsPatch)[]) {
    if (key === 'version') continue
    const section = patch[key]
    if (!section || typeof section !== 'object') continue
    Object.assign(next[key] as object, section)
  }
  if (patch.library?.sources)
    next.library.sources = { ...base.library.sources, ...patch.library.sources }
  return next
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function titleFromFile(fileName: string): string {
  return fileName
    .replace(/\.[^.]+$/, '')
    .replace(/[-_.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\p{L}/gu, (c) => c.toUpperCase())
}

function splitArgs(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2])
}

function describeLaunch(spec: LaunchSpec): string {
  switch (spec.kind) {
    case 'uri':
      return spec.uri
    case 'exec':
      return [spec.file, ...spec.args].join(' ')
    case 'emulator':
      return `${spec.systemId} ${spec.romPath}${spec.emulatorId ? ` (${spec.emulatorId})` : ''}`
    case 'uwp':
      return `shell:AppsFolder\\${spec.aumid}`
  }
}

/** Wrap every invokable method so it resolves after `ms` (the `mock=slow` flag). */
function withLatency(api: PlayOutApi, ms: number): PlayOutApi {
  if (ms <= 0) return api
  const delayed: PlayOutApi = { ...api }
  const target = delayed as unknown as Record<ApiMethod, (...args: unknown[]) => Promise<unknown>>
  for (const method of API_METHODS) {
    const impl = api[method] as (...args: unknown[]) => Promise<unknown>
    target[method] = (...args) => sleep(ms).then(() => impl(...args))
  }
  return delayed
}

interface RunningSession {
  sessionId: string
  gameId: string
  startedAt: string
  timer: ReturnType<typeof setTimeout>
}

/** One fake background install: its last reported progress plus the ticker that advances it. */
interface TrackedInstall {
  progress: InstallProgress
  /** The install does not advance before this time (the `detail-installing` capture holds at 42 %). */
  holdUntil: number
  timer: ReturnType<typeof setTimeout> | null
}

// ---------------------------------------------------------------------------
// The mock
// ---------------------------------------------------------------------------

export function createMockApi(options: MockOptions = {}): PlayOutApi {
  const flags = readMockFlags(options.search)
  const emitter = createEmitter()
  const startedAtMs = Date.now()

  // The update flow with its timing, against a pretend release (no download, no restart).
  let updateStatus: UpdateStatus = {
    state: 'idle',
    currentVersion: MOCK_VERSION,
    manual: false,
    releaseUrl: 'https://github.com/jeremybris/PlayOut/releases/latest'
  }
  const setUpdate = (state: UpdateStatus['state'], patch: Partial<UpdateStatus> = {}): void => {
    const { currentVersion, manual, releaseUrl, version } = updateStatus
    updateStatus = { state, currentVersion, manual, releaseUrl, version, ...patch }
    emitter.emit('update:status', clone(updateStatus))
  }

  const games = new Map<string, Game>()
  /** The H.L.T.B. sort's mock lookups while they run (refreshHltbTimes). */
  let hltbRun: Promise<void> | null = null
  /** Bumped by stopHltbTimes: a run of an older generation stops before its next game. */
  let hltbGeneration = 0
  let hltbRunGeneration = -1
  /** A game's mock size, derived from its id so it never changes: 0.5-80 GB. */
  const mockSizeOf = (id: string): number => {
    const seed = [...id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7)
    return Math.round((0.5 + (seed % 800) / 10) * 1024 ** 3)
  }
  const platforms = new Map<string, Platform>()
  let sessions: PlaySession[] = []
  const sourceState = new Map<SourceId, { lastScanAt?: string; error?: string }>()
  const clients = flags.empty ? NO_CLIENTS : DETECTED_CLIENTS
  /** Games the next scan of a source can find; each is found once. */
  const discoverable: Partial<Record<SourceId, Discoverable>> = discoverableGames()
  /** What the scraper will "find" for games added after start-up (null = no match). */
  const pendingScrape = new Map<string, Discoverable['scrape']>()
  /** Scraped art replaced by custom media, so clearing the custom image restores it. */
  const replacedMedia = new Map<string, Partial<Record<CustomMediaKind, string>>>()
  let settings = loadSettings(flags)
  let running: RunningSession | null = null
  // RetroAchievements (Settings > Emulators): a user name or key containing "bad" or "invalid" is rejected.
  let retroRevision = 0
  const retroStatus = (): RetroAchievementsStatus => {
    const { username, apiKey } = settings.scrapers.retroachievements
    const revision = retroRevision
    if (!username.trim() || !apiKey.trim()) return { state: 'signed-out', revision }
    if (/bad|invalid/i.test(username + apiKey))
      return {
        state: 'invalid',
        message: 'RetroAchievements rejected the Web API key. (mock)',
        revision
      }
    const roms = [...games.values()].filter((g) => g.source === 'rom').length
    return {
      state: 'signed-in',
      user: username.trim(),
      points: 1234,
      softcorePoints: 56,
      roms,
      matched: Math.ceil(roms / 2),
      syncedAt: new Date().toISOString(),
      revision
    }
  }
  let retroKey = ''
  let fullscreen = settings.ui.startFullscreen
  const system: {
    network: SystemStatus['network']
    bluetooth: SystemStatus['bluetooth']
    volume: { level: number; muted: boolean }
    brightness: number
    powerMode: PowerMode
  } = {
    network: { connected: true, kind: 'wifi', ssid: 'Home', signal: 80 },
    bluetooth: { available: true, on: true },
    volume: { level: 60, muted: false },
    brightness: 70,
    powerMode: 'balanced'
  }

  // Store accounts (§4.8): the empty screen has nobody signed in; the large library keeps its exact count, so the
  // owned fixtures are only merged into the sample library.
  const accounts = new Map<StoreSourceId, AccountStatus>(
    (flags.empty ? signedOutAccounts() : mockAccounts()).map((a) => [a.source, a])
  )
  const installs = new Map<string, TrackedInstall>()

  if (!flags.empty) {
    for (const g of flags.large ? largeLibrary(LARGE_LIBRARY_COUNT) : sampleGames())
      games.set(g.id, g)
    if (!flags.large) {
      for (const account of accounts.values())
        if (account.signedIn) for (const g of ownedGames(account.source)) games.set(g.id, g)
    }
    // The installed games come sized, as the app's startup pass sizes them (Settings › Storage lists them).
    for (const g of games.values())
      if (g.installed && !g.installSize)
        g.installSize = {
          bytes: mockSizeOf(g.id),
          how: 'folder',
          path: g.installDir ?? g.romPath,
          measuredAt: '2026-11-01T00:00:00.000Z'
        }
    for (const p of platformsFor([...games.values()])) platforms.set(p.id, p)
    sessions = sampleSessions([...games.values()])
    for (const id of ALL_SOURCES)
      if (clients[id].installed) sourceState.set(id, { lastScanAt: daysAgo(0.3) })
  }

  // --- library helpers --------------------------------------------------------

  const requireGame = (id: string): Game => {
    const game = games.get(id)
    if (!game) throw new Error(`Unknown game ${id}`)
    return game
  }
  const allGames = (): Game[] => [...games.values()]
  const installedCount = (source: SourceId): number =>
    allGames().filter((g) => g.source === source && g.installed).length
  const sortedPlatforms = (): Platform[] =>
    [...platforms.values()].sort(
      (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)
    )
  const gameCountsByPlatform = (): Record<string, number> => {
    const counts: Record<string, number> = {}
    for (const g of games.values())
      if (g.installed) counts[g.platformId] = (counts[g.platformId] ?? 0) + 1
    return counts
  }
  const registerPlatformFor = (game: Game): void => {
    if (platforms.has(game.platformId)) return
    if (game.source === 'manual') platforms.set(PC_PLATFORM.id, PC_PLATFORM)
    else if (game.source === 'rom')
      for (const p of systemPlatforms([game.platformId])) platforms.set(p.id, p)
    else platforms.set(game.source, STORE_PLATFORMS[game.source])
  }
  const addGame = (game: Game, scrape: Discoverable['scrape']): Game => {
    game.addedAt = now()
    games.set(game.id, game)
    registerPlatformFor(game)
    pendingScrape.set(game.id, scrape)
    return game
  }
  const emulators = (): EmulatorStatus[] =>
    emulatorStatuses(settings.emulators.overrides, settings.emulators.coresDir, setupInstalled)
  const sourceStatuses = (): SourceStatus[] =>
    ALL_SOURCES.map((id) => ({
      id,
      name: SOURCE_NAMES[id],
      enabled: settings.library.sources[id]?.enabled !== false,
      client: clone(clients[id]),
      lastScanAt: sourceState.get(id)?.lastScanAt,
      gameCount: installedCount(id),
      error: sourceState.get(id)?.error
    }))
  // --- emulator setup (Settings > Emulators > PlayOut emulators) --------------------
  // Nothing is set up at first; a run takes a few seconds per emulator, three at a time, like the real service.

  const setupInstalled = new Set<string>()
  const setupRunning = new Set<string>()
  let setupProgress: EmulatorSetupProgress = { done: 0, total: 0 }
  let setupNotices: string[] = []
  const mockEmulationDir = (): string => settings.library.emulationDir ?? MOCK_EMULATION_DIR
  const setupStatus = (): EmulatorSetupStatus => ({
    root: MOCK_SETUP_ROOT,
    emulationDir: mockEmulationDir(),
    biosDir: `${mockEmulationDir()}\\bios`,
    items: SETUP_EMULATORS.map((e) => ({
      id: e.id,
      name: e.name,
      state: setupRunning.has(e.id)
        ? 'installing'
        : setupInstalled.has(e.id)
          ? 'installed'
          : 'missing',
      exe: setupInstalled.has(e.id) ? (setupExeOf(e.id) ?? undefined) : undefined,
      ...(setupInstalled.has(e.id) && setupVersions.has(e.id)
        ? { version: setupVersions.get(e.id)!.version, channel: setupVersions.get(e.id)!.channel }
        : {})
    })),
    progress: clone(setupProgress),
    notices: [...setupNotices],
    ...(lastUpdate ? { lastUpdate: clone(lastUpdate) } : {})
  })
  const emitSetup = (progress: EmulatorSetupProgress): void => {
    setupProgress = progress
    emitter.emit('emulator-setup:progress', clone(progress))
  }
  /**
   * Runs one mock setup: runtimes, then three workers over the emulators, then BIOS. Like the real
   * service, every target stays `installing` until its worker finishes it; `current` lists only the
   * emulators a worker is on right now.
   */
  async function runSetup(targets: typeof SETUP_EMULATORS): Promise<void> {
    const total = targets.length
    const sizes = targets.map((_, i) => 30_000_000 + ((i * 37) % 9) * 20_000_000)
    const bytesTotal = sizes.reduce((a, b) => a + b, 0)
    const active = new Set<string>()
    let bytesDone = 0
    let done = 0
    const report = (): void =>
      emitSetup({
        done,
        total,
        stage: 'emulators',
        current: targets.filter((e) => active.has(e.id)).map((e) => e.name),
        bytesDone,
        bytesTotal
      })
    for (const e of targets) setupRunning.add(e.id)
    emitSetup({ done, total, stage: 'runtimes' })
    await sleep(1200)
    const queue = targets.map((e, i) => ({ e, size: sizes[i] }))
    const worker = async (): Promise<void> => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        active.add(next.e.id)
        report()
        for (let step = 0; step < 6; step++) {
          await sleep(300)
          bytesDone += next.size / 6
          report()
        }
        active.delete(next.e.id)
        setupRunning.delete(next.e.id)
        setupInstalled.add(next.e.id)
        done++
        report()
      }
    }
    await Promise.all([worker(), worker(), worker()])
    emitSetup({ done, total, stage: 'bios' })
    await sleep(800)
    setupNotices = ['RPCS3 has no PS3 firmware yet: put PS3UPDAT.PUP in the BIOS folder.']
    emitSetup({ done: 0, total: 0 })
    log(`set up ${targets.map((e) => e.id).join(', ')}`)
  }

  // --- Update all emulators (mock) ---------------------------------------------------------------------------
  // Model 2 publishes no newer builds; PCSX2 is "open" the first time (left alone); DuckStation is already current
  // after its first update; the others get a new nightly each time.
  const setupVersions = new Map<string, { version: string; channel?: string }>()
  let lastUpdate: EmulatorUpdateReport | undefined
  let updateRuns = 0
  const MOCK_CHANNELS: Record<string, string> = {
    DUCKSTATION: 'preview',
    PCSX2: 'nightly',
    RPCS3: 'nightly',
    DOLPHIN: 'dev',
    PPSSPP: 'dev',
    FLYCAST: 'dev',
    AZAHAR: 'pre-release',
    MELONDS: 'nightly',
    MGBA: 'nightly',
    RYUJINX: 'canary',
    SCUMMVM: 'daily',
    MAME: 'stable',
    RETROARCH: 'nightly'
  }
  async function runUpdate(): Promise<void> {
    updateRuns++
    const targets = SETUP_EMULATORS.filter((e) => setupInstalled.has(e.id))
    const items: EmulatorUpdateItem[] = []
    const candidates = targets.filter((e) => MOCK_CHANNELS[e.id])
    for (const e of targets)
      if (!MOCK_CHANNELS[e.id])
        items.push({
          id: e.id,
          name: e.name,
          result: 'unavailable',
          from: setupVersions.get(e.id)?.version ?? '1.1a'
        })
    let done = 0
    const total = candidates.length
    for (const e of candidates) {
      emitSetup({
        done,
        total,
        stage: 'updates',
        current: [e.name],
        bytesDone: done * 40_000_000,
        bytesTotal: total * 40_000_000
      })
      await sleep(350)
      const from = setupVersions.get(e.id)?.version ?? 'v1.0'
      const channel = MOCK_CHANNELS[e.id]
      if (e.id === 'PCSX2' && updateRuns === 1)
        items.push({ id: e.id, name: e.name, result: 'running', from, channel })
      else if (e.id === 'DUCKSTATION' && updateRuns > 1)
        items.push({ id: e.id, name: e.name, result: 'current', from, to: from, channel })
      else if (e.id === 'MELONDS' && updateRuns === 1)
        items.push({
          id: e.id,
          name: e.name,
          result: 'failed',
          from,
          channel,
          error: 'melonds.kuribo64.net answered 503'
        })
      else {
        const to = `${channel}-${new Date().toISOString().slice(0, 10)}.${updateRuns}`
        setupVersions.set(e.id, { version: to, channel })
        items.push({ id: e.id, name: e.name, result: 'updated', from, to, channel })
      }
      done++
    }
    const order = SETUP_EMULATORS.map((e) => e.id)
    items.sort((x, y) => order.indexOf(x.id) - order.indexOf(y.id))
    lastUpdate = { at: new Date().toISOString(), items }
    emitSetup({ done: 0, total: 0 })
    log(`updated emulators: ${items.map((i) => `${i.id}=${i.result}`).join(', ')}`)
  }

  const updateSettings = (patch: SettingsPatch): Settings => {
    settings = mergeSettings(settings, patch)
    // As main (keepRomsRootInSync): the ROM folder is the Emulation folder's roms folder, so it follows a new one.
    if (patch.library && 'emulationDir' in patch.library)
      settings = mergeSettings(settings, { library: { romsRoot: `${mockEmulationDir()}\\roms` } })
    // The settings-streaming screen forces the host on; saving would leave it on in every later mock session.
    if (!flags.streaming) saveSettings(settings)
    // Like main: every window's settings store follows the saved settings.
    emitter.emit('settings:changed', clone(settings))
    return settings
  }

  // --- metadata jobs ------------------------------------------------------------

  /** Scrape runs in flight: the art bar goes idle when the last one ends. */
  let scrapeRuns = 0

  async function scrape(ids: string[], force: boolean): Promise<void> {
    scrapeRuns++
    try {
      await scrapeQueue(ids, force)
    } finally {
      if (--scrapeRuns === 0) emitter.emit('art:progress', { stage: 'cover', done: 0, total: 0 })
    }
  }

  async function scrapeQueue(ids: string[], force: boolean): Promise<void> {
    const queue = ids.filter((id) => games.has(id))
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i]
      const remaining = queue.length - i - 1
      const pending = games.get(id)
      if (!pending) continue
      pending.metadataStatus = 'pending'
      // One queue here, so a game's cover and the rest of its art land together: the bar shows the cover stage.
      emitter.emit('art:progress', { stage: 'cover', done: i, total: queue.length })
      // The real service reports both lanes (ARCHITECTURE.md §4.6); the mock has one queue, so every game is
      // "in the full lane" and the cover lane is always empty.
      emitter.emit('metadata:progress', {
        gameId: id,
        status: 'pending',
        remaining: remaining + 1,
        lane: 'full',
        queued: remaining + 1,
        coverLane: 0,
        fullLane: remaining + 1,
        done: i
      })
      await sleep(SCRAPE_STEP_MS)
      const game = games.get(id)
      if (!game) continue
      const queued = pendingScrape.get(id)
      pendingScrape.delete(id)
      let found: boolean
      if (queued) {
        game.metadata = {
          ...queued.metadata,
          ...(force ? {} : game.metadata),
          sources: { ...game.metadata.sources, ...queued.metadata.sources },
          updatedAt: now()
        }
        for (const [kind, url] of Object.entries(queued.media) as [
          keyof Game['media'],
          string | string[]
        ][]) {
          const custom = kind !== 'screenshots' && kind !== 'video' && game.user.customMedia?.[kind]
          if (custom) continue
          if (force || !game.media[kind]) (game.media as Record<string, unknown>)[kind] = url
        }
        found = true
      } else if (queued === null) {
        found = false
      } else {
        // An existing library game: the scrape "succeeds" unless nothing is known about it at all.
        found = Boolean(game.media.cover || game.metadata.description)
        if (found) game.metadata = { ...game.metadata, updatedAt: now() }
      }
      game.metadataStatus = found ? 'done' : 'failed'
      emitter.emit('metadata:progress', {
        gameId: id,
        status: game.metadataStatus,
        remaining,
        message: found ? undefined : `No match found for "${game.title}"`,
        lane: 'full',
        queued: remaining,
        coverLane: 0,
        fullLane: remaining,
        done: i + 1
      })
      emitter.emit('library:changed', { reason: 'metadata', gameIds: [id] })
    }
  }

  const scrapeInBackground = (ids: string[], force = false): void => {
    if (ids.length) void scrape(ids, force).catch(reportError)
  }

  // --- scanning ------------------------------------------------------------------

  async function scanOne(
    id: SourceId,
    index: number,
    first: boolean,
    totals: ScanResult,
    newIds: string[]
  ): Promise<void> {
    const emit = (phase: ScanProgress['phase'], found: number, message?: string): void =>
      emitter.emit('scan:progress', { sourceId: id, phase, found, message })
    const name = SOURCE_NAMES[id]
    await sleep(index * 120)
    emit('detecting', 0)
    await sleep(SCAN_MS * 0.25)
    if (!clients[id].installed) {
      emit('done', 0, `${name} is not installed`)
      sourceState.set(id, { lastScanAt: now() })
      return
    }
    if (id === 'rom' && !settings.library.romsRoot) {
      emit('done', 0, 'No ROM folder selected')
      sourceState.set(id, { lastScanAt: now() })
      return
    }
    emit('scanning', 0)
    const existing = allGames().filter((g) => g.source === id && g.installed)
    const candidate = first ? discoverable[id] : undefined
    const steps = existing.length + (candidate ? 1 : 0)
    const stepMs = (SCAN_MS * 0.6) / Math.max(1, steps)
    let found = 0
    for (const g of existing) {
      await sleep(stepMs)
      found++
      emit('scanning', found, g.title)
    }
    if (candidate) {
      await sleep(stepMs)
      const game = addGame(clone(candidate.game), candidate.scrape)
      delete discoverable[id]
      found++
      totals.added++
      newIds.push(game.id)
      emit('scanning', found, game.title)
    }
    totals.updated += existing.length
    if (id === 'rom') totals.unknownFolders = ['bios', 'tools']
    sourceState.set(id, { lastScanAt: now() })
    await sleep(SCAN_MS * 0.15)
    emit('done', found)
  }

  // --- sessions -------------------------------------------------------------------

  const launchFailed = (gameId: string, error: LaunchError): LaunchResult => {
    log(`launch of ${gameId} failed: ${error.message}`)
    emitter.emit('launch:error', { gameId, error })
    return { ok: false, error }
  }

  let coopHandlers = 0
  let convertStatus: ConvertStatus = { tool: null, downloading: null, running: false, items: [] }
  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  let coopTools = false
  const coopExtracted = new Set<string>()

  function endSession(): void {
    if (!running) return
    const { gameId, startedAt, sessionId } = running
    running = null
    const endedAt = now()
    // Real sessions round to the nearest minute; the 6 s demo session counts as one so play time visibly changes.
    const minutes = Math.max(1, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 60_000))
    const session = sessions.find((s) => s.id === sessionId)
    if (session) {
      session.endedAt = endedAt
      session.minutes = minutes
    }
    const game = games.get(gameId)
    if (game) game.playtimeMinutes += minutes
    log(`session for ${game?.title ?? gameId} ended after ${minutes} min`)
    emitter.emit('session:ended', { gameId, startedAt, endedAt, minutes })
    emitter.emit('library:changed', { reason: 'session', gameIds: [gameId] })
  }

  // --- system ---------------------------------------------------------------------

  const systemStatus = (): SystemStatus => {
    const uptimeMinutes = Math.floor((Date.now() - startedAtMs) / 60_000)
    return {
      battery: {
        present: true,
        percent: Math.max(5, BATTERY_AT_START - uptimeMinutes),
        charging: false
      },
      network: clone(system.network),
      bluetooth: clone(system.bluetooth),
      volume: clone(system.volume),
      brightness: system.brightness,
      powerMode: system.powerMode,
      updatedAt: now()
    }
  }
  const pushStatus = (): void => emitter.emit('system:status', systemStatus())

  let statusTimer: ReturnType<typeof setInterval> | null = null
  const startStatusTicker = (): void => {
    if (statusTimer === null) statusTimer = setInterval(pushStatus, STATUS_INTERVAL_MS)
  }
  const stopStatusTickerWhenIdle = (): void => {
    if (statusTimer !== null && emitter.listenerCount('system:status') === 0) {
      clearInterval(statusTimer)
      statusTimer = null
    }
  }

  const perfSample = (): PerfSample => {
    const t = (Date.now() - startedAtMs) / 1000
    const wave = (periodSeconds: number, phase = 0): number =>
      Math.sin((t / periodSeconds) * 2 * Math.PI + phase)
    return {
      cpuPercent: Math.round(14 + 6 * wave(37) + 3 * wave(7, 1)),
      memoryUsedMb: Math.round(6400 + 220 * wave(53)),
      memoryTotalMb: 16310,
      gpuPercent: Math.max(0, Math.round(6 + 4 * wave(23, 2))),
      updatedAt: now()
    }
  }

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('focus', () => emitter.emit('window:focus', { focused: true }))
    window.addEventListener('blur', () => emitter.emit('window:focus', { focused: false }))
  }

  // --- store accounts -------------------------------------------------------------

  const accountList = (): AccountStatus[] =>
    STORE_SOURCES.map((id) => clone(accounts.get(id as StoreSourceId)!))
  const emitAccounts = (): void => emitter.emit('accounts:changed', accountList())
  const requireAccount = (source: StoreSourceId): AccountStatus => {
    const account = accounts.get(source)
    if (!account) throw new Error(`Unknown store ${source}`)
    return account
  }

  /**
   * The mock's `mergeOwned`: the fixture games of `source` become owned library records (existing ones keep their
   * state and gain `owned`); games the account no longer lists lose `owned` and are dropped when they existed only
   * because of the account. Returns the counts the importer reports.
   */
  function mergeOwned(
    source: StoreSourceId,
    owned: Game[]
  ): { imported: number; added: number; removed: number } {
    const listed = new Set(owned.map((g) => g.id))
    let added = 0
    let removed = 0
    let changed = false
    for (const g of owned) {
      const existing = games.get(g.id)
      if (existing) {
        if (!existing.owned) changed = true
        existing.owned = true
      } else {
        g.addedAt = now()
        games.set(g.id, g)
        registerPlatformFor(g)
        added++
        changed = true
      }
    }
    for (const g of allGames()) {
      if (g.source !== source || !g.owned || listed.has(g.id)) continue
      g.owned = false
      changed = true
      if (!g.installed && !g.installDir && g.playCount === 0) {
        games.delete(g.id)
        removed++
      }
    }
    if (changed) emitter.emit('library:changed', { reason: 'import' })
    return { imported: owned.length, added, removed }
  }

  async function importOne(source: StoreSourceId): Promise<ImportOwnedResult['sources'][number]> {
    const account = requireAccount(source)
    if (!account.supported)
      return { id: source, imported: 0, added: 0, removed: 0, error: account.reason }
    if (!account.signedIn)
      return { id: source, imported: 0, added: 0, removed: 0, error: 'Not signed in' }
    account.importing = true
    account.error = undefined
    emitAccounts()
    await sleep(IMPORT_MS)
    const counts = mergeOwned(source, ownedGames(source))
    account.importing = false
    account.lastImportAt = now()
    account.lastImportCount = counts.imported
    emitAccounts()
    log(
      `import of ${SOURCE_NAMES[source]}: ${counts.imported} owned, +${counts.added} / -${counts.removed}`
    )
    return { id: source, ...counts }
  }

  // --- background installs -----------------------------------------------------------

  const emitInstall = (tracked: TrackedInstall): void =>
    emitter.emit('install:progress', clone(tracked.progress))

  function finishInstall(tracked: TrackedInstall): void {
    const game = games.get(tracked.progress.gameId)
    if (game && game.source !== 'manual' && game.source !== 'rom') {
      const installDir = installDirFor(game.source, game.title)
      game.installed = true
      game.installDir = installDir
      game.launch = { kind: 'uri', uri: launchUri(game.source, game.externalId) }
      game.tracking = { mode: 'installDir', installDir }
    }
    // The real tracker ends when the confirming scan reports the game installed: same order of events here.
    emitter.emit('library:changed', { reason: 'scan', gameIds: [tracked.progress.gameId] })
    tracked.progress = { ...tracked.progress, state: 'done', percent: 100, updatedAt: now() }
    if (tracked.progress.bytesTotal !== undefined)
      tracked.progress.bytesDone = tracked.progress.bytesTotal
    installs.delete(tracked.progress.gameId)
    emitInstall(tracked)
    log(`install of ${game?.title ?? tracked.progress.gameId} finished`)
    leaveQueue(tracked.progress.gameId)
    // Steam installed every owned DLC; the ones turned off at install time are removed now.
    if (game) steamDlc.installed(game)
  }

  function tickInstall(tracked: TrackedInstall): void {
    tracked.timer = null
    if (!installs.has(tracked.progress.gameId)) return
    const percent = tracked.progress.percent ?? 0
    if (Date.now() >= tracked.holdUntil) {
      const next = Math.min(100, percent + (100 * INSTALL_TICK_MS) / INSTALL_MS)
      if (next >= 100) {
        finishInstall(tracked)
        return
      }
      const bytesTotal = tracked.progress.bytesTotal
      tracked.progress = {
        ...tracked.progress,
        state: next < 92 ? 'downloading' : 'installing',
        percent: Math.round(next),
        bytesDone: bytesTotal !== undefined ? Math.round((bytesTotal * next) / 100) : undefined,
        message:
          next < 92
            ? `Installing through ${SOURCE_NAMES[tracked.progress.source]}…`
            : `Finishing the install in ${SOURCE_NAMES[tracked.progress.source]}…`,
        updatedAt: now()
      }
      emitInstall(tracked)
    }
    tracked.timer = setTimeout(() => tickInstall(tracked), INSTALL_TICK_MS)
  }

  /** Start (or restart at `percent`) the fake download of an owned game. Xbox installs expose no byte counts. */
  function startInstall(game: Game, percent: number, holdMs = 0): void {
    if (game.source === 'manual' || game.source === 'rom') return
    const existing = installs.get(game.id)
    if (existing) {
      if (existing.timer) clearTimeout(existing.timer)
      installs.delete(game.id)
    }
    const bytesTotal = ownedGameBytes(game.id)
    const startedAt = now()
    const tracked: TrackedInstall = {
      progress: {
        gameId: game.id,
        source: game.source,
        state: percent > 0 ? 'downloading' : 'starting',
        percent: bytesTotal !== undefined || percent > 0 ? percent : undefined,
        bytesTotal,
        bytesDone: bytesTotal !== undefined ? Math.round((bytesTotal * percent) / 100) : undefined,
        message:
          percent > 0
            ? `Installing through ${SOURCE_NAMES[game.source]}…`
            : `Confirm the install in ${SOURCE_NAMES[game.source]}`,
        startedAt,
        updatedAt: startedAt
      },
      holdUntil: Date.now() + holdMs,
      timer: null
    }
    installs.set(game.id, tracked)
    emitInstall(tracked)
    tracked.timer = setTimeout(() => tickInstall(tracked), INSTALL_TICK_MS)
  }

  // --- install queue: store installs and ROM downloads from another PC, one at a time (like main's) ----------------

  let queue: InstallQueueEntry[] = []
  const emitQueue = (): void => emitter.emit('installs:queue', clone(queue))

  function queueEntry(game: Game, state: InstallQueueEntry['state']): InstallQueueEntry {
    return {
      gameId: game.id,
      title: displayTitle(game),
      kind: 'store',
      source: game.source as StoreSourceId,
      from: SOURCE_NAMES[game.source],
      state,
      addedAt: now()
    }
  }

  function romQueueEntry(
    gameId: string,
    rom: { title: string; hostName: string },
    state: InstallQueueEntry['state']
  ): InstallQueueEntry {
    return {
      gameId,
      title: rom.title,
      kind: 'host-rom',
      source: 'host',
      from: rom.hostName,
      state,
      addedAt: now()
    }
  }

  /** Start the queue's first entry; false when it cannot start any more (installed meanwhile, host gone). */
  function startEntry(entry: InstallQueueEntry): boolean {
    if (entry.kind === 'host-rom') return streaming.rom.start(entry.gameId)
    const game = games.get(entry.gameId)
    if (!game || game.installed) return false
    startInstall(game, 0)
    return true
  }

  /**
   * With nothing active, start the first waiting game that is not paused (it moves to the front: the active entry is
   * listed first). Like main's queue: a game that got installed meanwhile (or left the library, or whose host went)
   * is skipped and leaves. Does not emit.
   */
  function startNext(): void {
    if (queue.some((e) => e.state === 'active')) return
    for (;;) {
      const index = queue.findIndex((e) => e.state === 'waiting' && !e.paused)
      if (index < 0) return
      const entry: InstallQueueEntry = { ...queue[index]!, state: 'active' }
      queue = [entry, ...queue.filter((_, i) => i !== index)]
      if (startEntry(entry)) return
      queue = queue.slice(1)
    }
  }

  /** Drop a game from the queue; when it was the active one, the next waiting game starts. */
  function leaveQueue(gameId: string): void {
    const index = queue.findIndex((e) => e.gameId === gameId)
    if (index < 0) return
    const wasActive = queue[index]!.state === 'active'
    queue = queue.filter((e) => e.gameId !== gameId)
    if (wasActive) startNext()
    emitQueue()
  }

  /**
   * Pause one queued game (main's pauseInstall): a waiting one is only marked; the active ROM download from another
   * PC stops keeping what it has, waits paused at the front of the waiting games, and the next one starts; the active
   * store install stays active, marked paused (the store keeps downloading until paused there). No emit.
   */
  function pauseEntry(gameId: string): void {
    const index = queue.findIndex((e) => e.gameId === gameId)
    const entry = queue[index]
    if (!entry || entry.paused) return
    if (entry.state === 'active' && entry.kind === 'host-rom') {
      streaming.rom.pause(gameId)
      queue = [...queue]
      queue[index] = { ...entry, state: 'waiting', paused: true }
      startNext()
      return
    }
    if (entry.state === 'active')
      log(`paused ${entry.title}: opened the downloads page of ${entry.from}`)
    queue = [...queue]
    queue[index] = { ...entry, paused: true }
  }

  /** Resume one paused game: it downloads in its turn (now, when nothing is active). No emit. */
  function resumeEntry(gameId: string): void {
    const index = queue.findIndex((e) => e.gameId === gameId)
    const entry = queue[index]
    if (!entry?.paused) return
    // Like main: a game that is not paused has no `paused` field at all.
    const resumed: InstallQueueEntry = { ...entry }
    delete resumed.paused
    queue = [...queue]
    queue[index] = resumed
    startNext()
  }

  /**
   * Queue a ROM download from another PC: it starts now when nothing downloads, else it waits its turn (a game already
   * queued stays where it is). Refusals (not a ROM, no ROM folder) throw before anything is queued, as main's do.
   */
  function queueRomDownload(gameId: string): void {
    const rom = streaming.rom.check(gameId)
    if (queue.some((e) => e.gameId === gameId)) return
    const active = queue.find((e) => e.state === 'active')
    if (active) {
      queue.push(romQueueEntry(gameId, rom, 'waiting'))
      emitQueue()
      log(`download ${rom.title}: queued behind ${active.title}`)
      return
    }
    queue = [romQueueEntry(gameId, rom, 'active')]
    emitQueue()
    if (!streaming.rom.start(gameId)) leaveQueue(gameId)
  }

  /** Take a game out of the queue: a waiting one just leaves; the active one stops and the next starts. */
  function removeFromQueue(gameId: string): void {
    const entry = queue.find((e) => e.gameId === gameId)
    if (entry?.kind === 'host-rom') {
      // Cancelling ends the download, which leaves the queue (downloadEnded) and starts the next. A paused one drops
      // what it had kept.
      if (entry.state === 'active') streaming.rom.cancel(gameId)
      else streaming.rom.discard(gameId)
      leaveQueue(gameId)
      return
    }
    const tracked = installs.get(gameId)
    if (tracked) {
      if (tracked.timer) clearTimeout(tracked.timer)
      installs.delete(gameId)
      log(`stopped tracking the install of ${gameId}`)
    }
    leaveQueue(gameId)
  }

  // Bound once the recompilation mock exists (created below): host-only games' recompilations.
  let recompForGame: ((game: Game) => GameRecompInfo | null) | null = null
  const streaming = createStreamingMock({
    firstStart: flags.firstStart,
    recompFor: (game) => recompForGame?.(game),
    emitter,
    settings: () => settings,
    games,
    downloadEnded: leaveQueue,
    hostRemoved(hostId) {
      // Its waiting ROM downloads can never start: they leave the queue (the active one ended as cancelled).
      const gone = queue.filter(
        (e) => e.kind === 'host-rom' && e.gameId.startsWith(`remote:${hostId}:`)
      )
      for (const entry of gone) leaveQueue(entry.gameId)
    },
    addGame(game) {
      games.set(game.id, game)
      registerPlatformFor(game)
      emitter.emit('library:changed', { reason: 'scan', gameIds: [game.id] })
    },
    // As main's LibraryService.addSyncedSessions: each new session (by id) counted once in its game; one of a store
    // whose account total this copy reads already (the same store) adds no minutes.
    takeSessions(hostId, list) {
      const touched: string[] = []
      for (const s of list) {
        const game = games.get(s.gameId)
        if (!game || !s.endedAt || sessions.some((x) => x.id === s.id)) continue
        sessions.push({ ...s, from: hostId, syncedAt: now() })
        if (!s.store || game.source !== s.store) game.playtimeMinutes += s.minutes
        game.playCount += 1
        if (!game.lastPlayed || s.startedAt > game.lastPlayed) game.lastPlayed = s.startedAt
        touched.push(game.id)
      }
      if (touched.length) {
        log(`play time taken from ${hostId}: ${touched.length} sessions`)
        emitter.emit('library:changed', { reason: 'session', gameIds: touched })
      }
    },
    empty: flags.empty,
    showcase: flags.streaming
  })

  // `?overlay=1` previews the overlay window: a game is running (with no end, so the preview stays) under it.
  if (flags.overlay && !running) {
    const game = allGames()
      .filter((g) => g.installed && !g.hidden)
      .sort((a, b) => (b.lastPlayed ?? '').localeCompare(a.lastPlayed ?? ''))[0]
    if (game) {
      const startedAt = now()
      const sessionId = shortId('s', `${game.id}:${startedAt}`)
      sessions.push({ id: sessionId, gameId: game.id, startedAt, minutes: 0 })
      running = { sessionId, gameId: game.id, startedAt, timer: setTimeout(() => undefined, 0) }
    }
  }

  /** A play session of `game` from now (launchGame, and a recompilation started from the game's page). */
  function beginSession(game: Game): string {
    const startedAt = now()
    const sessionId = shortId('s', `${game.id}:${startedAt}`)
    sessions.push({ id: sessionId, gameId: game.id, startedAt, minutes: 0 })
    game.lastPlayed = startedAt
    game.playCount += 1
    emitter.emit('session:started', { gameId: game.id, startedAt })
    emitter.emit('library:changed', { reason: 'session', gameIds: [game.id] })
    running = { sessionId, gameId: game.id, startedAt, timer: setTimeout(endSession, SESSION_MS) }
    return startedAt
  }

  // Recompilations (mock/recomp.ts): Doom 64 has two, one installed; Sonic 2 has one that needs Data.rsdk.
  const recomp = createRecompMock({
    emitter,
    games,
    startSession(gameId) {
      const game = games.get(gameId)
      if (!game) return 'Unknown game'
      if (running) {
        const current = games.get(running.gameId)
        return `${current?.title ?? 'Another game'} is still running. Close it before launching another game.`
      }
      beginSession(game)
      return null
    },
    endSession,
    runningGameId: () => running?.gameId ?? null,
    conflict: flags.recompConflict,
    pinned: flags.recompPinned,
    emulationDir: mockEmulationDir,
    log
  })
  recompForGame = (game) => recomp.recompForGame(game)

  // VR mods (mock/vrMods.ts): Final Fantasy 16 VR downloaded one release behind, GitHub, Quest-only and Nexus mods.
  const vrMods = createVrModsMock({ emitter, log })

  // Steam DLC (mock/steamDlc.ts): Cyberpunk 2077 and Helldivers 2 installed, Red Dead Redemption 2 to install.
  const metadataCloud = createMetadataCloudMock({ emitter })

  const steamDlc = createSteamDlcMock({
    emitter,
    games,
    runningTitle: () => (running ? (games.get(running.gameId)?.title ?? 'A game') : null),
    openExternal: (url) => api.openExternal(url),
    log
  })

  // Upgrades (mock/upgrades.ts): Cyberpunk 2077 has old DLSS / FSR / XeSS files, Helldivers 2 warns about bans.
  const upgrades = createUpgradesMock({ emitter, games, log })

  // PC Saves (mock/pcSaves.ts): a game you added gets a save folder from its Edit sheet; the path picked picks the state.
  const pcSaves = createPcSavesMock({
    emitter,
    games,
    emulationDir: mockEmulationDir,
    featureOn: () => settings.library.copyPcSaves,
    runningId: () => running?.gameId ?? null,
    now
  })

  // PeerParty (mock/peerparty.ts): installed multiplayer PC games without competitive tags or anti-cheat get LAN play.
  const peerParty = createPeerPartyMock({
    emitter,
    games,
    startSession(gameId) {
      const game = games.get(gameId)
      if (!game) return 'Unknown game'
      if (running) {
        const current = games.get(running.gameId)
        return `${current?.title ?? 'Another game'} is still running. Close it before launching another game.`
      }
      beginSession(game)
      return null
    },
    runningGameId: () => running?.gameId ?? null,
    startWithSession: flags.overlay && flags.peerParty,
    log
  })

  const overlay = createOverlayMock({
    emitter,
    settings: () => settings,
    updateSettings,
    games,
    runningGameId: () => running?.gameId ?? null,
    endSession,
    openAtStart: flags.overlay
  })

  // The overlay's Friends tab (mock/friends.ts): Steam friends in a game, online and offline.
  const friends = createFriendsMock({
    mode: flags.friends ?? null,
    closeOverlay: () => overlay.api.closeOverlay(),
    log
  })

  if (flags.installing) {
    const [seeded, ...rest] = ownedGamesInOrder(games.values())
    if (seeded) {
      queue = [queueEntry(seeded, 'active')]
      startInstall(seeded, INSTALLING_SCREEN_PERCENT, INSTALL_HOLD_MS)
      if (flags.queue) queue.push(...rest.slice(0, 2).map((g) => queueEntry(g, 'waiting')))
    }
  }

  if (flags.bars) {
    // A review scores pass (a moment of Steam, then IGDB title searches) beside a slow install-size scan.
    // Both end with the ratings pass: the size scan counts the same games.
    const titles = allGames().map((g) => g.title)
    const total = titles.length
    // After the store has subscribed (the emitter drops events nobody listens to yet).
    setTimeout(() => emitter.emit('ratings:progress', { done: 0, total, stage: 'steam' }), 0)
    let step = 0
    const timer = setInterval(() => {
      step++
      const done = Math.min(total, step - 1)
      if (step > total + 1) {
        clearInterval(timer)
        emitter.emit('hltb:progress', { done: 0, total: 0 })
        emitter.emit('screenshots:progress', { done: 0, total: 0 })
        emitter.emit('ratings:progress', { done: 0, total: 0, stage: 'steam' })
        emitter.emit('install-size:progress', { remaining: 0, done: 0, total: 0 })
        return
      }
      emitter.emit('ratings:progress', {
        done,
        total,
        stage: 'igdb',
        current: titles[done % total]
      })
      emitter.emit('install-size:progress', { remaining: total - done, done, total })
      emitter.emit('hltb:progress', { done, total, current: titles[(done + 7) % total] })
      emitter.emit('screenshots:progress', { done, total, current: titles[(done + 3) % total] })
    }, 1000)

    // The art downloads of an import: one cover per game in a few seconds, then the remaining art more slowly.
    let covered = 0
    let arted = 0
    const art = setInterval(() => {
      if (covered < total) {
        covered = Math.min(total, covered + 3)
        emitter.emit('art:progress', { stage: 'cover', done: covered, total })
      } else if (arted < total) {
        arted++
        emitter.emit('art:progress', { stage: 'art', done: arted, total })
      } else {
        clearInterval(art)
        emitter.emit('art:progress', { stage: 'cover', done: 0, total: 0 })
      }
    }, 250)
  }

  // --- the API --------------------------------------------------------------------

  const api: PlayOutApi = {
    // --- library -------------------------------------------------------------
    async getLibrary() {
      return {
        games: allGames().map(view),
        platforms: sortedPlatforms().map(clone),
        generatedAt: now()
      }
    },
    async getGame(id) {
      const game = games.get(id)
      return game ? view(game) : null
    },
    async getMetadataLayers(id) {
      // A paired host's game: the streaming mock keeps its edit (main: remote-edits.ts).
      if (id.startsWith('remote:')) {
        const layers = streaming.metadata.layers(id)
        if (!layers) throw new Error(`Unknown game ${id}`)
        return layers
      }
      return metadataLayers(clone(requireGame(id)))
    },
    async setMetadataEdit(id, edit, clear) {
      if (id.startsWith('remote:')) {
        const shown = streaming.metadata.set(id, edit, clear)
        if (!shown) throw new Error(`Unknown game ${id}`)
        const sent = { ...edit }
        if (sent.title !== undefined && !sent.title.trim()) delete sent.title
        metadataCloud.edited(shown.title, sent)
        return shown
      }
      const game = requireGame(id)
      const user = clear?.length ? withoutMetadataEdit(game.user, clear) : game.user
      game.user = withMetadataEdit(user, edit)
      emitter.emit('library:changed', { reason: 'update', gameIds: [id] })
      const shown = view(game)
      // As main: an empty title only removes the own title; it is never sent to the cloud.
      const sent = { ...edit }
      if (sent.title !== undefined && !sent.title.trim()) delete sent.title
      metadataCloud.edited(shown.title, sent)
      return shown
    },
    async clearMetadataEdit(id, fields) {
      if (id.startsWith('remote:')) {
        const shown = streaming.metadata.clear(id, fields)
        if (!shown) throw new Error(`Unknown game ${id}`)
        return shown
      }
      const game = requireGame(id)
      game.user = withoutMetadataEdit(game.user, fields)
      emitter.emit('library:changed', { reason: 'update', gameIds: [id] })
      return view(game)
    },
    async updateGame(id, patch) {
      const game = requireGame(id)
      // The user's own change: stamped for the favourites sync, as main's updateGame (byUser).
      if (patch.favorite !== undefined && patch.favorite !== game.favorite)
        game.favoriteAt = new Date().toISOString()
      if (patch.favorite !== undefined) game.favorite = patch.favorite
      if (patch.hidden !== undefined) game.hidden = patch.hidden
      if (patch.completed) game.completed = true
      else if (patch.completed === false) delete game.completed
      if (patch.user) {
        const user = { ...game.user }
        for (const [key, value] of Object.entries(patch.user) as [keyof GameUserData, unknown][]) {
          if (value === undefined) continue
          if (value === null || (key === 'preferredCopy' && value === false)) delete user[key]
          else if (key === 'customMedia')
            user.customMedia = {
              ...(game.user.customMedia ?? {}),
              ...(value as GameUserData['customMedia'])
            }
          else (user as Record<string, unknown>)[key] = value
        }
        game.user = user
      }
      emitter.emit('library:changed', { reason: 'update', gameIds: [id] })
      return view(game)
    },
    async removeGame(id) {
      if (!games.delete(id)) return
      pendingScrape.delete(id)
      replacedMedia.delete(id)
      emitter.emit('library:changed', { reason: 'remove', gameIds: [id] })
    },
    // "Delete from this PC": nothing on disk in the browser; ROMs and manual games leave the library, store games
    // only get the store's (pretend) uninstall.
    async getLocalDeletePlan(id) {
      const game = games.get(id)
      const refused = (reason: string): LocalDeletePlan => ({
        gameId: id,
        kind: 'refused',
        reason,
        paths: []
      })
      if (!game) return refused('This game is not in the library')
      if (!game.installed) return refused(`${game.title} is not installed on this PC`)
      if (running?.gameId === id) return refused(`${game.title} is running. Quit it first.`)
      if (queue.some((e) => e.gameId === id))
        return refused(`${game.title} is in the download queue. Remove it from the queue first.`)
      // Kept for its recompilation (its disc image is already in the Recycle Bin): only the card is left (as main).
      if (game.romRemoved)
        return {
          gameId: id,
          kind: 'remove-only',
          reason: `The disc image of ${game.title} is already in the Recycle Bin (it starts its recompilation)`,
          paths: []
        }
      if (game.source === 'rom') {
        const path = game.romPath ?? `C:\\Emulation\\roms\\${game.externalId}`
        const plan: LocalDeletePlan = {
          gameId: id,
          kind: 'files',
          paths: [path],
          totalBytes: game.installSize?.bytes
        }
        // The sample Switch game has an update and a DLC in Updates and DLC\Switch (main/emulation/updates-dlc.ts).
        if (game.launch.kind === 'emulator' && game.launch.systemId === 'switch')
          plan.updatesDlc = {
            paths: [
              `C:\\Emulation\\Updates and DLC\\Switch\\${game.title} [Update v2.1.0][0100A96014FD0800].nsp`,
              `C:\\Emulation\\Updates and DLC\\Switch\\${game.title} [DLC][0100A96014FD1001].nsp`
            ],
            totalBytes: 812 * 1024 ** 2
          }
        return plan
      }
      if (game.source === 'manual') {
        const dir = game.installDir ?? (game.exePath ? game.exePath.replace(/\\[^\\]*$/, '') : '')
        return dir
          ? {
              gameId: id,
              kind: 'files',
              paths: [dir],
              totalBytes: game.installSize?.bytes,
              folder: true
            }
          : { gameId: id, kind: 'remove-only', reason: 'The game has no install folder', paths: [] }
      }
      return {
        gameId: id,
        kind: 'store',
        paths: [],
        storeName: STORE_PLATFORMS[game.source].name,
        ...(game.source === 'xbox' ? { opens: 'settings' as const } : {})
      }
    },
    async updatePs3Game(gameId) {
      const game = games.get(gameId)
      if (!game || game.launch.kind !== 'emulator' || game.launch.systemId !== 'ps3')
        return { outcome: 'failed', version: null, message: 'That is not a PS3 game on this PC' }
      return {
        outcome: 'up-to-date',
        version: '01.00',
        message: `${game.title} is up to date (01.00)`
      }
    },
    async deleteGameLocally(id, options): Promise<LocalDeleteResult> {
      const plan = await api.getLocalDeletePlan(id)
      const game = games.get(id)
      if (!game || plan.kind === 'refused' || plan.kind === 'remove-only')
        return { ok: false, kind: plan.kind, message: plan.reason ?? 'Cannot delete this game' }
      if (plan.kind === 'store')
        return {
          ok: true,
          kind: 'store',
          removed: false,
          message:
            plan.opens === 'settings'
              ? `Windows Settings is open: uninstall ${game.title} from Apps there`
              : `${plan.storeName} is uninstalling ${game.title}`
        }
      await api.removeGame(id)
      return {
        ok: true,
        kind: plan.kind,
        removed: true,
        message:
          options?.updatesDlc && plan.updatesDlc
            ? `Moved ${game.title} and its updates and DLC to the Recycle Bin`
            : `Moved ${game.title} to the Recycle Bin`
      }
    },
    async getSessions(gameId) {
      return sessions.filter((s) => s.gameId === gameId).map(clone)
    },

    // --- sources / scanning ----------------------------------------------------
    async getSources() {
      return sourceStatuses()
    },
    async scanSources(ids) {
      const requested = (ids ?? ALL_SOURCES)
        .filter((id) => ALL_SOURCES.includes(id))
        .filter((id) => settings.library.sources[id]?.enabled !== false)
      const totals: ScanResult = { sources: [], added: 0, updated: 0, removed: 0 }
      const newIds: string[] = []
      await Promise.all(
        requested.map((id, index) => scanOne(id, index, index === 0, totals, newIds))
      )
      emitter.emit('library:changed', { reason: 'scan' })
      if (settings.scrapers.autoScrape) scrapeInBackground(newIds)
      totals.sources = sourceStatuses()
      log(
        `scan of ${requested.join(', ') || 'nothing'}: +${totals.added} / ${totals.updated} updated`
      )
      return totals
    },
    async generateFolders(kind) {
      await sleep(DIALOG_MS)
      // Roughly the real counts: roms + 195 system folders; Emulation's folders with its roms.
      if (kind === 'roms') return { path: 'D:\\Games\\roms', created: 196, existing: 0 }
      // As main: the generated Emulation folder is the one in use from now on.
      updateSettings({ library: { emulationDir: 'D:\\Games\\Emulation' } })
      return { path: 'D:\\Games\\Emulation', created: 372, existing: 0 }
    },
    // Moving the Emulation folder: a pretend plan (12.3 GB on another drive) and a copy reported in a few steps.
    async planEmulationMove(request) {
      await sleep(DIALOG_MS)
      const from = mockEmulationDir()
      const picked = request.picked ?? 'C:\\Users\\Player\\Documents'
      const to =
        request.kind === 'default'
          ? 'C:\\Users\\Player\\Documents\\Emulation'
          : /[\\/]emulation$/i.test(picked)
            ? picked
            : `${picked.replace(/[\\/]+$/, '')}\\Emulation`
      const same = to.toLowerCase() === from.toLowerCase()
      const blocked = /[\\/]PlayOut([\\/]|$)/i.test(to)
        ? "The Emulation folder cannot be inside PlayOut's install folder: uninstalling or updating PlayOut would delete it. Choose a folder outside it, such as Documents."
        : null
      return {
        from,
        to,
        blocked,
        same,
        hasContent: !same,
        bytes: same ? 0 : 12.3 * 1024 ** 3,
        files: same ? 0 : 4821,
        sameDrive: from.slice(0, 2).toLowerCase() === to.slice(0, 2).toLowerCase(),
        freeBytes: 210 * 1024 ** 3,
        neededBytes: 12.3 * 1024 ** 3,
        targetHasContent: false,
        targetIsEmulation: false
      }
    },
    async startEmulationMove(to, mode) {
      const total = { bytesTotal: 12.3 * 1024 ** 3, filesTotal: 4821 }
      for (let i = 1; i <= 5 && mode !== 'switch'; i++) {
        await sleep(400)
        emitter.emit('emulation-move:progress', {
          phase: 'copying',
          bytesDone: (total.bytesTotal * i) / 5,
          filesDone: Math.round((total.filesTotal * i) / 5),
          current: 'saves\\pcsx2\\memcards\\Mcd001.ps2',
          ...total
        })
      }
      updateSettings({ library: { emulationDir: to } })
      emitter.emit('emulation-move:progress', {
        phase: 'done',
        bytesDone: 0,
        filesDone: 0,
        bytesTotal: 0,
        filesTotal: 0
      })
      return { dir: to, moved: mode !== 'switch', leftInOld: 0, keptOlder: 0 }
    },
    async cancelEmulationMove() {
      await sleep(0)
    },
    async getEmulationFolderOffer() {
      return null
    },
    async answerEmulationFolderOffer() {
      await sleep(0)
    },
    async addManualGame(input) {
      const exePath = input.exePath.trim()
      if (!exePath) throw new Error('An executable path is required.')
      const externalId = exePath.toLowerCase().replace(/\\/g, '/')
      const existing = allGames().find((g) => g.source === 'manual' && g.externalId === externalId)
      if (existing) return view(existing)
      const dir = exePath.replace(/[\\/][^\\/]*$/, '')
      const title = input.title?.trim() || titleFromFile(exePath.slice(dir.length + 1))
      const game = addGame(
        buildGame({
          source: 'manual',
          externalId,
          platformId: PC_PLATFORM.id,
          title,
          installDir: dir,
          exePath,
          launch: {
            kind: 'exec',
            file: exePath,
            args: input.args ? splitArgs(input.args) : [],
            cwd: input.cwd?.trim() || dir
          },
          tracking: { mode: 'spawned' },
          playtime: 0,
          playCount: 0,
          added: 0,
          metadata: {},
          media: {},
          metadataStatus: 'none'
        }),
        scrapeForTitle(title)
      )
      emitter.emit('library:changed', { reason: 'scan', gameIds: [game.id] })
      if (settings.scrapers.autoScrape) scrapeInBackground([game.id])
      return view(game)
    },
    async addGamesFromFolder(folder) {
      await sleep(SCAN_MS * 0.4)
      const known = new Set(
        allGames()
          .filter((g) => g.source === 'manual')
          .map((g) => g.externalId)
      )
      const added = folderGames(folder)
        .filter((g) => !known.has(g.externalId))
        .map((g) => addGame(g, scrapeForTitle(g.title)))
      if (!added.length) return []
      emitter.emit('library:changed', { reason: 'scan', gameIds: added.map((g) => g.id) })
      if (settings.scrapers.autoScrape) scrapeInBackground(added.map((g) => g.id))
      return added.map(view)
    },

    // --- store accounts / installs (ARCHITECTURE.md §4.8) -----------------------
    async getAccounts() {
      return accountList()
    },
    async signIn(source) {
      const account = requireAccount(source)
      if (!account.supported)
        throw new Error(account.reason ?? `${SOURCE_NAMES[source]} sign-in is not supported`)
      // The sign-in window: the user types there, then it closes and the owned import starts in the background.
      await sleep(DIALOG_MS)
      account.signedIn = true
      account.displayName = MOCK_DISPLAY_NAMES[source]
      account.error = undefined
      emitAccounts()
      log(`signed in to ${SOURCE_NAMES[source]} as ${account.displayName}`)
      void importOne(source).catch(reportError)
      return clone(account)
    },
    async signOut(source) {
      const account = requireAccount(source)
      account.signedIn = false
      account.displayName = undefined
      account.lastImportAt = undefined
      account.lastImportCount = undefined
      account.error = undefined
      mergeOwned(source, [])
      emitAccounts()
      log(`signed out of ${SOURCE_NAMES[source]}`)
      return clone(account)
    },
    async importOwned(sources) {
      const requested = (sources ?? [...accounts.keys()]).filter(
        (id) => accounts.get(id)?.signedIn && accounts.get(id)?.supported
      )
      const results = await Promise.all(requested.map((id) => importOne(id)))
      return { sources: results }
    },
    async installGame(id) {
      const game = requireGame(id)
      const title = game.user.titleOverride || game.title
      if (game.installed) return { ok: false, error: `${title} is already installed.` }
      if (game.source === 'manual' || game.source === 'rom')
        return { ok: false, error: `${title} has no store client that could install it.` }
      if (!clients[game.source].installed)
        return {
          ok: false,
          error: `${SOURCE_NAMES[game.source]} is not installed. Install the client, then try again.`
        }
      // One game downloads at a time: another one waits its turn (the one active now is handed over again).
      const active = queue.find((e) => e.state === 'active')
      if (active && active.gameId !== id) {
        if (!queue.some((e) => e.gameId === id)) {
          queue.push(queueEntry(game, 'waiting'))
          emitQueue()
          log(`install ${title}: queued behind ${active.title}`)
        }
        return { ok: true, queued: queue.findIndex((e) => e.gameId === id) }
      }
      if (!active) {
        queue = [queueEntry(game, 'active')]
        emitQueue()
      }
      log(`install ${title}: ${describeLaunch(game.launch)}`)
      startInstall(game, installs.has(id) ? (installs.get(id)!.progress.percent ?? 0) : 0)
      return { ok: true }
    },
    async cancelInstallTracking(id) {
      removeFromQueue(id)
    },
    async getInstalls() {
      return [...installs.values()].map((t) => clone(t.progress))
    },
    async getInstallQueue() {
      return clone(queue)
    },
    async removeFromInstallQueue(gameId) {
      removeFromQueue(gameId)
    },
    async moveInInstallQueue(gameId, delta) {
      const index = queue.findIndex((e) => e.gameId === gameId)
      const target = index + delta
      // Waiting entries only, and never ahead of the active one.
      if (index < 0 || queue[index]!.state !== 'waiting') return
      if (target < 0 || target >= queue.length || queue[target]!.state !== 'waiting') return
      const next = [...queue]
      ;[next[index], next[target]] = [next[target]!, next[index]!]
      queue = next
      emitQueue()
    },
    async pauseInstall(gameId) {
      if (gameId !== null) pauseEntry(gameId)
      else {
        // Pause all: the waiting games first, so pausing the active one starts none of them.
        for (const e of queue.filter((x) => x.state === 'waiting')) pauseEntry(e.gameId)
        const active = queue.find((e) => e.state === 'active')
        if (active) pauseEntry(active.gameId)
      }
      emitQueue()
    },
    async resumeInstall(gameId) {
      // In queue order: with nothing active, the first one resumed starts.
      const ids = gameId === null ? queue.map((e) => e.gameId) : [gameId]
      for (const id of ids) resumeEntry(id)
      emitQueue()
    },

    // --- emulation -------------------------------------------------------------
    async getSystems() {
      return systemInfos(gameCountsByPlatform(), emulators())
    },
    async getEmulators() {
      return emulators()
    },
    async getEmulatorSetup() {
      return setupStatus()
    },
    async setupEmulators(ids) {
      if (setupProgress.total > 0) return setupStatus()
      const targets = SETUP_EMULATORS.filter(
        (e) => !setupInstalled.has(e.id) && (!ids || ids.includes(e.id))
      )
      if (targets.length) {
        for (const e of targets) setupRunning.add(e.id)
        setupProgress = { done: 0, total: targets.length, stage: 'runtimes' }
        void runSetup(targets).catch(reportError)
      }
      return setupStatus()
    },
    async updateEmulators() {
      if (setupProgress.total > 0) return setupStatus()
      // Like main: resolves when the run has ended, with its report.
      setupProgress = { done: 0, total: 1, stage: 'updates' }
      await runUpdate().catch(reportError)
      return setupStatus()
    },
    async setEmulatorPath(emulatorId, path) {
      const overrides = { ...settings.emulators.overrides }
      if (path) overrides[emulatorId] = path
      else delete overrides[emulatorId]
      updateSettings({ emulators: { overrides } })
      return emulators()
    },
    async importEsde() {
      await sleep(SCAN_MS * 0.6)
      const home = settings.library.esdeHome ?? (flags.empty ? null : ESDE_HOME)
      if (!home) {
        return {
          gamesUpdated: 0,
          mediaCopied: 0,
          message: 'No ES-DE installation found (set the ES-DE folder in Settings → Library).'
        }
      }
      const roms = allGames().filter((g) => g.source === 'rom')
      let mediaCopied = 0
      for (const g of roms) {
        const gamelistName = g.externalId.replace(/^.*\//, '').replace(/\.[^.]+$/, '')
        g.metadata = {
          ...g.metadata,
          sources: { ...g.metadata.sources, esde: gamelistName },
          updatedAt: now()
        }
        g.metadataStatus = 'done'
        pendingScrape.delete(g.id)
        if (g.media.cover) mediaCopied++
      }
      if (roms.length)
        emitter.emit('library:changed', { reason: 'import', gameIds: roms.map((g) => g.id) })
      return { gamesUpdated: roms.length, mediaCopied, message: `Imported from ${home}` }
    },

    // --- launching -------------------------------------------------------------
    async launchGame(id, options) {
      const game = requireGame(id)
      const title = game.user.titleOverride || game.title
      if (!game.installed)
        return launchFailed(id, { kind: 'file-missing', message: `${title} is not installed.` })
      if (running) {
        const current = games.get(running.gameId)
        return launchFailed(id, {
          kind: 'failed',
          message: `${current?.title ?? 'Another game'} is still running. Close it before launching another game.`
        })
      }
      // Its disc image went to the Recycle Bin for its recompilation: Play starts the recompilation (as main).
      if (game.romRemoved) {
        const started = await recomp.api.launchRecomp(id, game.romRemoved.recompId)
        if (started.ok) return { ok: true, startedAt: game.lastPlayed ?? now() }
        return launchFailed(id, {
          kind: 'failed',
          message:
            'message' in started ? started.message : 'Open the Recompilation page to start it.'
        })
      }
      if (game.launch.kind === 'emulator') {
        const systemId = game.launch.systemId
        const choice = primaryEmulatorFor(
          systemId,
          options?.emulatorId ?? game.user.emulatorId ?? settings.emulators.preferred[systemId]
        )
        if (!choice)
          return launchFailed(id, {
            kind: 'failed',
            message: `No emulator is configured for ${systemId}.`
          })
        const status = emulators().find((e) => e.id === choice.emulatorId)
        if (!status?.path) {
          return launchFailed(id, {
            kind: 'emulator-missing',
            message: `${status?.name ?? choice.emulatorId} was not found. Install it or set its location in Settings → Emulators.`,
            emulatorId: choice.emulatorId
          })
        }
      }
      if (pcSaves.blocksLaunch(id))
        return launchFailed(id, {
          kind: 'save-conflict',
          message: `The saves of ${title} changed on this PC and in the Emulation folder since they were last copied. Choose which to keep.`
        })
      log(`launch ${title}: ${describeLaunch(game.launch)}`)
      return { ok: true, startedAt: beginSession(game) }
    },
    async getRunningGame() {
      return running ? { gameId: running.gameId, startedAt: running.startedAt } : null
    },

    // --- metadata --------------------------------------------------------------
    async refreshMetadata(ids, options) {
      const force = options?.force === true
      const targets =
        ids ??
        allGames()
          // Like main's `missingTargets`: a paired host's game is never queued by "Refresh missing".
          .filter((g) => force || (!g.remote && g.metadataStatus !== 'done'))
          .map((g) => g.id)
      scrapeInBackground(targets, force)
      // "Refresh missing" also looks for the missing art of matched games (no art source in the mock: nothing lands).
      const artOnly =
        ids || force
          ? 0
          : allGames().filter(
              (g) => !g.remote && g.metadataStatus === 'done' && missingArtKinds(g).length > 0
            ).length
      return { queued: targets.length + artOnly }
    },
    async searchMetadata(gameId, query) {
      return sampleCandidates(requireGame(gameId), query)
    },
    async applyMetadata(gameId, candidate) {
      const game = requireGame(gameId)
      game.title = candidate.title
      game.sortTitle = sortTitle(candidate.title)
      // Same semantics as the main process: the chosen match replaces the previous match's source ids, and art
      // the chosen candidate does not supply is dropped unless it is the user's own custom art.
      game.metadata = {
        ...game.metadata,
        sources: { [candidate.scraper]: candidate.externalId },
        updatedAt: now()
      }
      if (candidate.releaseDate) game.metadata.releaseDate = candidate.releaseDate
      for (const kind of ['cover', 'hero', 'logo', 'icon', 'screenshots', 'video'] as const) {
        const custom = kind !== 'screenshots' && kind !== 'video' && game.user.customMedia?.[kind]
        if (custom) continue
        if (kind === 'cover' && candidate.cover) game.media.cover = candidate.cover
        else delete game.media[kind]
      }
      game.metadataStatus = 'done'
      pendingScrape.delete(gameId)
      emitter.emit('library:changed', { reason: 'metadata', gameIds: [gameId] })
      return view(game)
    },
    async getAchievements(gameId) {
      // A host-only game: its host's list (main's streaming achievementsFor), from the counts its offer carries.
      if (gameId.startsWith('remote:')) {
        const shown = (await streaming.api.getRemoteLibrary()).games.find((g) => g.id === gameId)
        return shown ? sampleAchievements(shown, []) : null
      }
      const game = games.get(gameId)
      return game ? sampleAchievements(game, sessions) : null
    },
    async getSteamScreenshots(gameId) {
      // The sample Steam games' store screenshots (their media.screenshots are Steam's 1920x1080 ones).
      const game = games.get(gameId)
      if (!game || game.source !== 'steam') return null
      await sleep(300)
      return (game.media.screenshots ?? []).map((url) => ({ thumbnail: url, full: url }))
    },
    async refreshLivePlayers(gameId) {
      // The mock's numbers are fixed (data.ts): the game as it is.
      const game = games.get(gameId)
      return game ? view(game) : null
    },
    async refreshActivePlayers() {
      // The mock's numbers are fixed (data.ts): nothing to read.
    },
    refreshHltbTimes() {
      // Main's H.L.T.B. sort lookups, played out: the games without times are "looked up" one at a time (about half
      // get times derived from their id, the rest are recorded as HLTB having no match), with 'hltb:progress' and
      // 'library:changed' every few games. One run at a time; stopHltbTimes stops it after the game in progress, and a
      // refresh after a stop starts a new run once that one is through. Due games: main's rule (shared/hltb-time.ts).
      if (hltbRun && hltbRunGeneration === hltbGeneration) return hltbRun
      const gen = hltbGeneration
      const previous = hltbRun ?? Promise.resolve()
      const next: Promise<void> = previous
        .then(async () => {
          const at0 = Date.now()
          const due = [...games.values()].filter((g) =>
            hltbTimesDue(g, at0, HLTB_MOCK_MISS_RETRY_MS)
          )
          if (!due.length || gen !== hltbGeneration) return
          await lookUp(due, gen)
        })
        .finally(() => {
          if (hltbRun === next) hltbRun = null
        })
      hltbRun = next
      hltbRunGeneration = gen
      return next
      async function lookUp(due: Game[], gen: number): Promise<void> {
        const total = due.length
        const batch: string[] = []
        const flush = (): void => {
          if (batch.length)
            emitter.emit('library:changed', { reason: 'metadata', gameIds: batch.splice(0) })
        }
        for (const [index, game] of due.entries()) {
          if (gen !== hltbGeneration) break
          emitter.emit('hltb:progress', { done: index, total, current: game.title, source: 'sort' })
          await sleep(HLTB_MOCK_STEP_MS)
          const seed = [...game.id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 11)
          const at = now()
          game.metadata = {
            ...game.metadata,
            hltb:
              seed % 2 === 0
                ? { main: 2 + (seed % 60), extra: 4 + (seed % 90), rules: 5, updatedAt: at }
                : { missedAt: at, rules: 5 }
          }
          if (seed % 2 === 0) batch.push(game.id)
          if (batch.length >= 3) flush()
        }
        flush()
        emitter.emit('hltb:progress', { done: 0, total: 0, source: 'sort' })
      }
    },
    async stopHltbTimes() {
      hltbGeneration++
    },
    async refreshInstallSize(gameId) {
      // Sizes derived from the id, so every game keeps the same one: 0.5-80 GB installed, an estimate otherwise.
      const game = games.get(gameId)
      if (!game) return null
      const bytes = mockSizeOf(game.id)
      const now = new Date().toISOString()
      if (game.installed && !game.installSize)
        game.installSize = { bytes, how: 'folder', path: game.installDir, measuredAt: now }
      else if (!game.installed && !game.metadata.storage && game.source !== 'rom')
        game.metadata.storage = {
          bytes,
          // Steam's own games are exact; other stores' copies are matched to Steam (an estimate).
          how: game.source === 'steam' ? 'steam' : 'steam-match',
          checkedAt: now
        }
      return view(game)
    },
    async setCustomMedia(gameId, kind, filePath) {
      const game = requireGame(gameId)
      const replaced = replacedMedia.get(gameId) ?? {}
      const customMedia = { ...(game.user.customMedia ?? {}) }
      if (filePath === null) {
        delete customMedia[kind]
        const previous = replaced[kind]
        if (previous) game.media[kind] = previous
        else delete game.media[kind]
        delete replaced[kind]
      } else {
        if (!customMedia[kind] && game.media[kind]) replaced[kind] = game.media[kind]
        customMedia[kind] = filePath
        game.media[kind] = fileUrl(filePath)
      }
      game.user.customMedia = customMedia
      replacedMedia.set(gameId, replaced)
      emitter.emit('library:changed', { reason: 'metadata', gameIds: [gameId] })
      return view(game)
    },

    // --- settings --------------------------------------------------------------
    async getSettings() {
      return clone(settings)
    },
    async updateSettings(patch) {
      const next = clone(updateSettings(patch))
      if (patch.streaming) streaming.settingsChanged(settings)
      if (patch.input || patch.performance) overlay.settingsChanged(settings, patch)
      const { username, apiKey } = settings.scrapers.retroachievements
      if (
        `${username}
${apiKey}` !== retroKey
      ) {
        retroKey = `${username}
${apiKey}`
        retroRevision++
        setTimeout(() => emitter.emit('retroachievements:status', retroStatus()), DIALOG_MS)
      }
      return next
    },
    async getRetroAchievementsStatus() {
      return retroStatus()
    },
    async syncRetroAchievements() {
      await sleep(DIALOG_MS)
      const status = retroStatus()
      emitter.emit('retroachievements:status', status)
      return status
    },
    async testCredentials(service, credentials) {
      // Browser dev mode has no services to ask: any value containing "bad" or "invalid" is rejected, the rest work.
      await sleep(DIALOG_MS)
      const values = Object.values(credentials as Record<string, string>)
      const rejected = values.some((v) => /bad|invalid/i.test(v))
      return rejected
        ? { status: 'invalid', message: `${service}: credentials don't work (mock)` }
        : { status: 'valid', message: `${service}: credentials work (mock)` }
    },

    // --- dialogs ---------------------------------------------------------------
    async chooseFolder(title) {
      await sleep(DIALOG_MS)
      const t = title ?? ''
      if (/es-?de/i.test(t)) return ESDE_HOME
      if (/core/i.test(t)) return 'C:\\RetroArch-Win64\\cores'
      if (/rom/i.test(t)) return ROMS_ROOT
      return 'C:\\Games'
    },
    async chooseFile(options) {
      await sleep(DIALOG_MS)
      const title = options?.title ?? ''
      const extensions = (options?.filters ?? []).flatMap((f) =>
        f.extensions.map((e) => e.toLowerCase())
      )
      const emulator = title.match(/retroarch|ryujinx|duckstation|snes9x|mgba|flycast|mame/i)?.[0]
      if (emulator || /emulator/i.test(title)) {
        const name = emulator ? emulator[0].toUpperCase() + emulator.slice(1) : 'Ryujinx'
        return `C:\\Emulators\\${name}\\${name}.exe`
      }
      if (extensions.some((e) => ['png', 'jpg', 'jpeg', 'webp'].includes(e)))
        return 'C:\\Users\\Player\\Pictures\\custom-cover.png'
      if (extensions.includes('exe') || /exe|game/i.test(title))
        return 'C:\\Games\\Noita\\noita.exe'
      return 'C:\\Users\\Player\\Downloads\\example.bin'
    },

    // --- system ----------------------------------------------------------------
    async getSystemStatus() {
      return systemStatus()
    },
    async setVolume(level) {
      system.volume.level = Math.max(0, Math.min(100, Math.round(level)))
      if (system.volume.level > 0) system.volume.muted = false
      pushStatus()
    },
    async setMuted(muted) {
      system.volume.muted = muted
      pushStatus()
    },
    async setBrightness(percent) {
      system.brightness = Math.max(0, Math.min(100, Math.round(percent)))
      pushStatus()
    },
    async setPowerMode(mode) {
      system.powerMode = mode
      pushStatus()
    },
    async powerAction(action) {
      log(`powerAction(${action}) ignored in the mock`)
    },
    async openWindowsSettings(page) {
      log(`openWindowsSettings(${page}) would open ms-settings:${page}`)
    },
    async getPerfSample() {
      return perfSample()
    },

    // --- app / window ----------------------------------------------------------
    async getAppInfo() {
      return {
        name: 'PlayOut',
        version: MOCK_VERSION,
        userDataPath: 'C:\\Users\\Player\\AppData\\Roaming\\PlayOut',
        documentsPath: 'C:\\Users\\Player\\Documents',
        isPackaged: false,
        platform: 'win32'
      }
    },
    async getUpdateStatus() {
      return clone(updateStatus)
    },

    // --- streaming (mock/streaming.ts) ------------------------------------------------
    ...streaming.api,
    // ROM downloads from another PC wait their turn in the install queue, as main's do; cancelling one is taking it
    // out of the queue (a waiting one just leaves).
    async downloadRemoteRom(gameId) {
      queueRomDownload(gameId)
    },
    async cancelRemoteRomDownload(gameId) {
      removeFromQueue(gameId)
    },

    // --- home button, overlay, performance, display, media (mock/overlay.ts) ----------------
    ...overlay.api,
    ...friends.api,

    // --- Recompilations (mock/recomp.ts) ----------------------------------------------
    ...recomp.api,

    // --- VR mods (mock/vrMods.ts) -------------------------------------------------
    ...vrMods.api,

    // --- Steam DLC (mock/steamDlc.ts) ---------------------------------------------------
    ...steamDlc.api,
    ...upgrades.api,
    ...pcSaves.api,

    // --- PeerParty (mock/peerparty.ts) ----------------------------------------------------
    ...peerParty.api,
    // Settings › Storage: a 1 TB system drive and a 2 TB games drive.
    // The Library's folder button: every folder counts as there (the mock has no disk).
    async openFolders(paths, options) {
      log('mock openFolders', paths, options)
      const all = options?.recompilations ? ['D:\\Emulation\\Recompilations', ...paths] : [...paths]
      return { opened: all, missing: [] }
    },
    async getStorageDrives() {
      return [
        {
          root: 'C:\\',
          label: 'Windows',
          totalBytes: 1000 * 1024 ** 3,
          freeBytes: 212 * 1024 ** 3
        },
        { root: 'D:\\', label: 'Games', totalBytes: 2000 * 1024 ** 3, freeBytes: 640 * 1024 ** 3 }
      ]
    },
    ...metadataCloud.api,

    // --- Co-Op ------------------------------------------------------------------
    async getConvertStatus() {
      return convertStatus
    },
    async checkConvert(request) {
      const pair = convertPair(request.platformId, request.pairId)
      const direction = pair && (request.reversed ? pair.backward : pair.forward)
      return (direction?.needs ?? []).map((need) => ({
        need,
        message:
          need === 'switchKeys'
            ? 'Switch packages that carry a ticket need your prod.keys (packages without one convert without it).'
            : 'This conversion needs your own key (mock).',
        place: [
          'C:',
          'Users',
          'you',
          'AppData',
          'Roaming',
          'playout',
          'Emulation',
          'bios',
          ...(need === 'switchKeys' ? ['switch', 'prod.keys'] : ['ps3', 'pkg-key.txt'])
        ].join('\\'),
        blocking: need !== 'switchKeys'
      }))
    },
    async chooseConvertPaths(request) {
      const pair = convertPair(request.platformId, request.pairId)
      const from = pair && (request.reversed ? pair.right : pair.left)
      const ext = from?.folder ? '' : (from?.exts[0] ?? '')
      return [1, 2, 3].map((n) => ['D:', 'roms', request.platformId, `Game ${n}${ext}`].join('\\'))
    },
    async startConvert(request) {
      convertStatus = {
        tool: { version: '2.1.0' },
        downloading: null,
        running: true,
        items: request.paths.map((path) => ({ path, state: 'queued' as const }))
      }
      emitter.emit('convert:progress', convertStatus)
      void (async () => {
        for (const item of convertStatus.items) {
          item.state = 'running'
          emitter.emit('convert:progress', {
            ...convertStatus,
            items: convertStatus.items.map((i) => ({ ...i }))
          })
          await delay(700)
          item.state = 'done'
          item.detail = '1.2 GB → 640 MB'
        }
        convertStatus = { ...convertStatus, running: false }
        emitter.emit('convert:progress', {
          ...convertStatus,
          items: convertStatus.items.map((i) => ({ ...i }))
        })
        log('startConvert: done')
      })()
      return convertStatus
    },
    async stopConvert() {
      log('stopConvert')
    },
    async openConvertPlace(need) {
      log(`openConvertPlace: ${need}`)
    },
    async getCoopStatus() {
      return {
        handlers: coopHandlers,
        games: [...games.values()].filter((g) => g.metadata.coop).length,
        busy: false,
        toolsReady: coopTools,
        helperReady: true
      }
    },
    async downloadCoopHandlers() {
      const total = 896
      for (let done = 0; done <= total; done += 64) {
        emitter.emit('coop:progress', { stage: 'download', done: Math.min(done, total), total })
        await delay(120)
      }
      emitter.emit('coop:progress', { stage: 'download', done: 0, total: 0 })
      coopHandlers = total
      log('downloadCoopHandlers: 896 handlers')
      return api.getCoopStatus()
    },
    async getCoopPlan(gameId) {
      const game = requireGame(gameId)
      const coop = game.metadata.coop
      const devices = [
        { id: 'xinput:0', kind: 'xinput' as const, index: 0, name: 'Xbox Wireless Controller' },
        { id: 'xinput:1', kind: 'xinput' as const, index: 1, name: 'Xbox Wireless Controller' },
        ...(settings.library.coopKeyboardMouse
          ? [{ id: 'kb', kind: 'keyboard' as const, name: 'Keyboard and mouse' }]
          : [])
      ]
      const setup = game.user.coop
      const players = Math.min(
        setup?.players ?? devices.length,
        coop?.maxPlayers ?? 4,
        devices.length
      )
      const exe = `C:\\Games\\${game.title.replace(/[^\w ]/g, '')}\\game.exe`
      const layout =
        setup?.layout ??
        (players <= 2
          ? settings.library.coopTwoPlayerLayout === 'sideBySide'
            ? ('DualVertical' as const)
            : ('DualHorizontal' as const)
          : ('FourPlayers' as const))
      return {
        gameId,
        exePath: setup?.exePath ?? exe,
        exeChoices: [exe],
        players,
        maxPlayers: coop?.maxPlayers ?? 4,
        layout,
        devices,
        assigned: (setup?.devices ?? devices.map((d) => d.id)).slice(0, players),
        screens: [{ index: 0, primary: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }],
        monitors: [{ index: 0, layout, players }],
        problem: coop ? null : 'No Co-Op handler.',
        risks: coop?.risks ?? []
      }
    },
    async playCoop(gameId) {
      const game = requireGame(gameId)
      emitter.emit('coop:session', { gameId, state: 'preparing', message: 'Getting Co-Op ready…' })
      if (!coopTools) {
        for (let done = 0; done <= 97; done += 16) {
          emitter.emit('coop:progress', { stage: 'tools', done: done * 1e6, total: 97e6 })
          await delay(150)
        }
        emitter.emit('coop:progress', { stage: 'tools', done: 0, total: 0 })
        coopTools = true
      }
      emitter.emit('coop:session', { gameId, state: 'starting', message: 'Starting 2 players…' })
      await delay(600)
      coopExtracted.add(gameId)
      const result = await api.launchGame(gameId)
      if (!result.ok) {
        emitter.emit('coop:session', {
          gameId,
          state: 'error',
          message: result.error?.message ?? 'Could not start'
        })
        throw new Error(result.error?.message ?? 'Could not start')
      }
      emitter.emit('coop:session', { gameId, state: 'running' })
      log(`playCoop ${game.title}`)
    },
    async stopCoop(gameId) {
      emitter.emit('coop:session', { gameId, state: 'ended', message: 'stopped' })
    },
    async removeCoopHandler(gameId) {
      coopExtracted.delete(gameId)
    },
    async isCoopHandlerExtracted(gameId) {
      return coopExtracted.has(gameId)
    },
    async checkForUpdates() {
      if (updateStatus.state !== 'idle' && updateStatus.state !== 'up-to-date')
        return clone(updateStatus)
      setUpdate('checking', { version: undefined })
      await sleep(600)
      setUpdate('available', { version: '0.2.0' })
      return clone(updateStatus)
    },
    async downloadUpdate() {
      if (updateStatus.state !== 'available') return clone(updateStatus)
      const bytesTotal = 122 * 1024 * 1024
      for (let percent = 0; percent < 100; percent += 5) {
        setUpdate('downloading', {
          percent,
          bytesDone: (bytesTotal * percent) / 100,
          bytesTotal,
          bytesPerSecond: 6 * 1024 * 1024
        })
        await sleep(200)
      }
      setUpdate('downloaded', { percent: 100 })
      return clone(updateStatus)
    },
    async installUpdate() {
      if (updateStatus.state !== 'downloaded') return clone(updateStatus)
      setUpdate('installing')
      await sleep(800)
      setUpdate('up-to-date', { version: undefined, currentVersion: '0.2.0' })
      return clone(updateStatus)
    },
    async setFullscreen(value) {
      fullscreen = value
    },
    async isFullscreen() {
      return fullscreen
    },
    async openExternal(url) {
      if (typeof window !== 'undefined' && typeof window.open === 'function')
        window.open(url, '_blank', 'noopener,noreferrer')
      else log(`openExternal(${url})`)
    },
    async openPath(path) {
      log(`openPath(${path})`)
    },
    async showItemInFolder(path) {
      log(`showItemInFolder(${path})`)
    },
    async showTouchKeyboard() {
      log('showTouchKeyboard()')
    },

    // --- events ----------------------------------------------------------------
    on(event, listener) {
      const off = emitter.on(event, listener)
      if (event === 'system:status') startStatusTicker()
      return () => {
        off()
        if (event === 'system:status') stopStatusTickerWhenIdle()
      }
    }
  }

  log(
    `mock API ready: ${games.size} games${flags.empty ? ' (empty screen)' : ''}${flags.large ? ' (generated large library)' : ''}${flags.slow ? ', slow mode' : ''}`
  )
  return withLatency(api, flags.slow ? SLOW_LATENCY_MS : 0)
}
