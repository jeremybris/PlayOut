import type {
  ArtProgress,
  EmulatorSetupProgress,
  Game,
  HltbProgress,
  MetadataProgress,
  Platform,
  PlayersProgress,
  RatingsProgress,
  ScreenshotsProgress
} from '@shared/types'
import { create } from 'zustand'
import { api } from '../api/client'
import { createChangeCoalescer } from '../lib/changeCoalescer'
import { createLog } from '../lib/log'
import { useInstallsStore } from './installs'

const log = createLog('library')

/** Quiet time after a 'library:changed' before a refresh, and the longest an event waits for one. */
const CHANGE_DEBOUNCE_MS = 150
const CHANGE_MAX_WAIT_MS = 500
/** Events naming up to this many games refresh those games one by one instead of the whole snapshot. */
const CHANGE_PARTIAL_LIMIT = 50

/**
 * Library store: the full snapshot from the API plus id lookups. Selectors that derive rows live in
 * lib/library.ts; this store only holds data and refreshes it when the main process reports changes.
 */
export interface LibraryState {
  games: Game[]
  platforms: Platform[]
  byId: Map<string, Game>
  platformsById: Map<string, Platform>
  /** True once the first getLibrary() resolved (or failed). */
  loaded: boolean
  loading: boolean
  error?: string
  generatedAt: string | null
  /** The latest 'metadata:progress' payload (the Library header's "fetching covers N left" line); null when idle. */
  metadataProgress: MetadataProgress | null
  /** Games that moved to another id this run (a converted ROM's record follows its file): old id -> new id. */
  movedTo: Record<string, string>
  /** Games the install-size pass still has to look up ("sizes N left"); 0 when idle. */
  sizesLeft: number
  /** The install-size scan as the bottom bar shows it; total 0 when idle. */
  sizeScan: { done: number; total: number; paused: boolean; current?: string }
  /** The review scores pass as the bottom bar shows it; total 0 when idle. */
  ratingsScan: RatingsProgress
  /** The background HowLongToBeat pass as the bottom bar shows it; total 0 when idle. */
  hltbScan: HltbProgress
  /** The background Steam screenshot downloads as the bottom bar shows them; total 0 when idle. */
  screenshotsScan: ScreenshotsProgress
  /** Copying the paired hosts' metadata and art into this PC ('host-sync:progress'). */
  hostSync: ScreenshotsProgress
  /** PlayOut's own emulators being set up ('emulator-setup:progress'); total 0 when idle. */
  emulatorSetup: EmulatorSetupProgress
  /** LaunchBox's player counts being downloaded or read, as the bottom bar shows it; total 0 when idle. */
  playersScan: PlayersProgress
  /** The game art downloads (covers, then the remaining art) as the bottom bar shows them; total 0 when idle. */
  artScan: ArtProgress
  /** Reload the snapshot; concurrent calls are coalesced into one extra refresh. */
  refresh(): Promise<void>
  /** Replace one game locally (e.g. with the Game returned by api.updateGame) without a full refresh. */
  applyGame(game: Game): void
  /** Replace or add several games and drop the ids that no longer exist, in one state update. */
  applyGames(games: Game[], removedIds?: string[]): void
  /** Remove one game locally. */
  removeGame(id: string): void
}

function index(games: Game[], platforms: Platform[]): Pick<LibraryState, 'byId' | 'platformsById'> {
  return {
    byId: new Map(games.map((g) => [g.id, g])),
    platformsById: new Map(platforms.map((p) => [p.id, p]))
  }
}

let inFlight: Promise<void> | null = null
let dirty = false

export const useLibraryStore = create<LibraryState>()((set, get) => ({
  games: [],
  platforms: [],
  byId: new Map(),
  platformsById: new Map(),
  loaded: false,
  loading: false,
  generatedAt: null,
  metadataProgress: null,
  movedTo: {},
  sizesLeft: 0,
  sizeScan: { done: 0, total: 0, paused: false },
  ratingsScan: { done: 0, total: 0, stage: 'steam' },
  hltbScan: { done: 0, total: 0 },
  screenshotsScan: { done: 0, total: 0 },
  hostSync: { done: 0, total: 0 },
  emulatorSetup: { done: 0, total: 0 },
  playersScan: { stage: 'reading', done: 0, total: 0 },
  artScan: { stage: 'cover', done: 0, total: 0 },
  refresh() {
    if (inFlight) {
      dirty = true
      return inFlight
    }
    inFlight = (async () => {
      do {
        dirty = false
        set({ loading: true })
        try {
          const snapshot = await api.getLibrary()
          set({
            games: snapshot.games,
            platforms: snapshot.platforms,
            ...index(snapshot.games, snapshot.platforms),
            generatedAt: snapshot.generatedAt,
            loaded: true,
            loading: false,
            error: undefined
          })
          // A finished install leaves the installs map only now, when the snapshot shows the game installed.
          useInstallsStore.getState().pruneDone((id) => get().byId.get(id)?.installed)
        } catch (err) {
          log.error('getLibrary failed', err)
          set({ loaded: true, loading: false, error: String(err) })
        }
      } while (dirty)
      inFlight = null
    })()
    return inFlight
  },
  applyGame(game) {
    get().applyGames([game])
  },
  applyGames(updated, removedIds = []) {
    const byId = new Map(updated.map((g) => [g.id, g]))
    const removed = new Set(removedIds)
    const games = get()
      .games.filter((g) => !removed.has(g.id))
      .map((g) => byId.get(g.id) ?? g)
    const known = new Set(games.map((g) => g.id))
    for (const g of updated) if (!known.has(g.id)) games.push(g)
    set({ games, ...index(games, get().platforms) })
  },
  removeGame(id) {
    get().applyGames([], [id])
  }
}))

/**
 * The main process names the games an event touched; a few of them are fetched one by one (`getGame`) and
 * patched in, instead of refetching the whole snapshot (several MB for a 3,000-game library) for one game's new
 * description. A burst of events refreshes at most every 500 ms, so the first covers of a run show up while the
 * stream is still going.
 */
const changes = createChangeCoalescer({
  minMs: CHANGE_DEBOUNCE_MS,
  maxMs: CHANGE_MAX_WAIT_MS,
  limit: CHANGE_PARTIAL_LIMIT,
  onAll: () => {
    useLibraryStore
      .getState()
      .refresh()
      .catch((err) => log.error('refresh after library:changed failed', err))
  },
  onGames: (ids) => {
    const state = useLibraryStore.getState()
    // Before the first snapshot there is nothing to patch; the full load is on its way.
    if (!state.loaded) return
    Promise.all(ids.map((id) => api.getGame(id)))
      .then((games) => {
        const found = games.filter((g): g is Game => g !== null)
        const gone = ids.filter((_id, i) => games[i] === null)
        useLibraryStore.getState().applyGames(found, gone)
        // A game back under an id it moved away from (a recompilation's own card made again) is that game again.
        const back = found.filter((g) => useLibraryStore.getState().movedTo[g.id])
        if (back.length)
          useLibraryStore.setState((s) => {
            const movedTo = { ...s.movedTo }
            for (const g of back) delete movedTo[g.id]
            return { movedTo }
          })
        useInstallsStore
          .getState()
          .pruneDone((id) => useLibraryStore.getState().byId.get(id)?.installed)
      })
      .catch((err) => {
        log.error('getGame after library:changed failed; refreshing', err)
        void useLibraryStore.getState().refresh()
      })
  }
})
api.on('library:changed', (payload) => {
  if (payload.movedTo && Object.keys(payload.movedTo).length)
    useLibraryStore.setState((s) => {
      const movedTo = { ...s.movedTo, ...payload.movedTo }
      // A game moved back to an id it had (converted there and back) lives there again: no move out of it remains.
      for (const to of Object.values(payload.movedTo ?? {})) delete movedTo[to]
      return { movedTo }
    })
  changes.note(payload.gameIds)
})

// The main process coalesces these to a few per second; the header reads `coverLane` / `fullLane` from the latest.
api.on('install-size:progress', ({ remaining, done, total, paused, current }) => {
  useLibraryStore.setState({
    sizesLeft: remaining,
    sizeScan: { done, total, paused: !!paused, current }
  })
})

api.on('players:progress', (payload) => {
  useLibraryStore.setState({ playersScan: payload })
})

api.on('art:progress', (payload) => {
  useLibraryStore.setState({ artScan: payload })
})

api.on('hltb:progress', (payload) => {
  useLibraryStore.setState({ hltbScan: payload })
})

api.on('host-sync:progress', (payload) => {
  useLibraryStore.setState({ hostSync: payload })
})

api.on('emulator-setup:progress', (payload) => {
  useLibraryStore.setState({ emulatorSetup: payload })
})

api.on('screenshots:progress', (payload) => {
  useLibraryStore.setState({ screenshotsScan: payload })
})

api.on('ratings:progress', (payload) => {
  useLibraryStore.setState({ ratingsScan: payload })
})

api.on('metadata:progress', (payload) => {
  useLibraryStore.setState({ metadataProgress: payload.queued === 0 ? null : payload })
})

/** React hook: one game by id (re-renders when that game changes). */
/**
 * The id a game lives under now: `id`, or where its record moved (a converted ROM follows its new file), followed
 * through any later moves.
 */
export function useCurrentGameId(id: string | null | undefined): string | null | undefined {
  return useLibraryStore((s) => {
    let current = id
    // A move is followed once the game is there under its new id (until the library catches up, the old record is).
    for (let i = 0; current && s.movedTo[current] && s.byId.has(s.movedTo[current]) && i < 10; i++)
      current = s.movedTo[current]
    return current
  })
}

export function useGame(id: string | null | undefined): Game | undefined {
  return useLibraryStore((s) => (id ? s.byId.get(id) : undefined))
}

/** React hook: the platform row for an id (undefined while unknown). */
export function usePlatform(id: string | null | undefined): Platform | undefined {
  return useLibraryStore((s) => (id ? s.platformsById.get(id) : undefined))
}
