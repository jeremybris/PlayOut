import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Game, ScannedGame } from '../../shared/types'
import { RECOMP_ACHIEVEMENTS_SOURCE } from '../../shared/recomp-play'
import { STORE_ACHIEVEMENTS_NONE } from '../../shared/store-achievements'
import { EventBus } from '../events'
import { HttpError } from '../scrapers/http'
import { LibraryService } from '../services/library-service'
import { LibraryStore } from '../store/library-store'
import { SessionsStore } from '../store/sessions-store'
import { SCAN_PARK_AFTER } from './scan-scheduler'
import {
  createStoreScan,
  type StoreAchievementsProvider,
  type StoreRead,
  type StoreScan
} from './store-scan'

const SOURCE = 'test-achievements'

class RefusedError extends Error {}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out')
    await sleep(5)
  }
}

const list = (unlocked: number, total: number): StoreRead => ({
  kind: 'list',
  info: { provider: 'gog', total, unlocked, list: [] }
})

let dir: string
let library: LibraryService
let scan: StoreScan | null
let announced: string[][]
let running: boolean
const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

function gogGame(id: string, title = `Game ${id}`): ScannedGame {
  return {
    source: 'gog',
    externalId: id,
    platformId: 'gog',
    title,
    launch: { kind: 'uri', uri: `goggalaxy://openGameView/${id}` },
    tracking: { mode: 'none' },
    extra: { gogProductId: id }
  }
}

function addGames(...ids: string[]): string[] {
  return library.mergeScan(
    'gog',
    ids.map((id) => gogGame(id))
  ).newGameIds
}

function createScan(
  read: (game: Game, key: string, priority: 'page' | 'scan') => Promise<StoreRead>,
  backoffMs = 10
): StoreScan {
  const provider: StoreAchievementsProvider = {
    id: 'test',
    source: SOURCE,
    keyOf: (game) => (game.source === 'gog' ? game.externalId : null),
    read,
    isAuthError: (err) => err instanceof RefusedError
  }
  scan = createStoreScan(provider, {
    library,
    log,
    cacheDir: dir,
    write: async (file, value) => {
      await fs.writeFile(file, JSON.stringify(value), 'utf8')
    },
    writeCounts: (gameId, counts, extra) => {
      library.applyMetadata(
        gameId,
        {
          metadata: {
            achievements: { ...counts, updatedAt: new Date().toISOString() },
            ...(extra.sources ? { sources: extra.sources } : {})
          }
        },
        { overwrite: true, quiet: true }
      )
      return true
    },
    announce: (ids) => {
      if (ids.length) announced.push(ids)
    },
    gameRunning: () => running,
    startDelayMs: 0,
    kickDelayMs: 5,
    gapMs: 0,
    backoffMs
  })
  return scan
}

const counts = (id: string): { unlocked: number; total: number } | undefined =>
  library.getGame(id)?.metadata.achievements

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-store-scan-'))
  const events = new EventBus()
  const libStore = new LibraryStore(join(dir, 'library.json'))
  const sessions = new SessionsStore(join(dir, 'sessions.json'))
  await Promise.all([libStore.load(), sessions.load()])
  library = new LibraryService(libStore, sessions, events)
  scan = null
  announced = []
  running = false
})
afterEach(async () => {
  scan?.dispose()
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('the store achievements scan', () => {
  it('goes on past one game whose read the store refused, and asks that game again later', async () => {
    const [a, b] = addGames('1', '2')
    let refuse = true
    const read = vi.fn(async (game: Game) => {
      if (game.externalId === '1' && refuse) throw new RefusedError('refused')
      return list(2, 5)
    })
    const s = createScan(read)
    await s.sync()
    expect(counts(b)).toMatchObject({ unlocked: 2, total: 5 })
    expect(counts(a)).toBeUndefined()
    refuse = false
    await until(() => counts(a)?.unlocked === 2)
  })

  it('stops when the account is refused for two different games in a row, and goes on after a sign-in', async () => {
    const [a, b, c] = addGames('1', '2', '3')
    let refuse = true
    const read = vi.fn(async () => {
      if (refuse) throw new RefusedError('refused')
      return list(1, 4)
    })
    const s = createScan(read, 60_000)
    await s.sync()
    expect(read).toHaveBeenCalledTimes(2)
    // Waiting for a sign-in: a library change asks nothing.
    s.kick()
    await sleep(40)
    expect(read).toHaveBeenCalledTimes(2)
    refuse = false
    await s.sync()
    // The game refused second and the one never asked are read now; the first waits out its pause.
    expect(counts(b)).toMatchObject({ unlocked: 1, total: 4 })
    expect(counts(c)).toMatchObject({ unlocked: 1, total: 4 })
    expect(counts(a)).toBeUndefined()
  })

  it('parks a game whose read keeps failing, without holding the others up', async () => {
    const [a, b] = addGames('1', '2')
    const read = vi.fn(async (game: Game) => {
      if (game.externalId === '1')
        throw new HttpError('HTTP 500', { status: 500, url: 'https://store' })
      return list(3, 3)
    })
    const s = createScan(read, 1)
    await s.sync()
    expect(counts(b)).toMatchObject({ unlocked: 3, total: 3 })
    const calls = (): number => read.mock.calls.filter(([g]) => g.id === a).length
    await until(() => calls() === SCAN_PARK_AFTER)
    await sleep(60)
    expect(calls()).toBe(SCAN_PARK_AFTER)
    const record = JSON.parse(await fs.readFile(join(dir, 'test-scans.json'), 'utf8')) as Record<
      string,
      { parkedAt?: number }
    >
    expect(record[a].parkedAt).toBeDefined()
  })

  it('pauses every game on a rate limit', async () => {
    addGames('1', '2')
    const read = vi.fn(async () => {
      throw new HttpError('HTTP 429', { status: 429, url: 'https://store' })
    })
    const s = createScan(read, 60_000)
    await s.sync()
    // The first game's 429 stops the pass: the second is not asked during the pause.
    expect(read).toHaveBeenCalledTimes(1)
    s.kick()
    await sleep(40)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('writes nothing for a read that was under way when the account signed out', async () => {
    const [a] = addGames('1')
    let answer: (r: StoreRead) => void = () => undefined
    const read = vi.fn(() => new Promise<StoreRead>((resolve) => (answer = resolve)))
    const s = createScan(read)
    const pass = s.sync()
    await until(() => read.mock.calls.length === 1)
    s.signedOut()
    answer(list(5, 5))
    await pass
    expect(counts(a)).toBeUndefined()
  })

  it("keeps a recompilation's counts when the store says the game has none", async () => {
    const [a] = addGames('1')
    library.applyMetadata(
      a,
      {
        metadata: {
          achievements: { unlocked: 1, total: 2, updatedAt: new Date().toISOString() },
          sources: { [RECOMP_ACHIEVEMENTS_SOURCE]: 'github:someone/recomp' }
        }
      },
      { overwrite: true, quiet: true }
    )
    const s = createScan(async () => ({ kind: 'none' }))
    await s.sync()
    expect(library.getGame(a)?.metadata.sources?.[SOURCE]).toBe(STORE_ACHIEVEMENTS_NONE)
    expect(counts(a)).toMatchObject({ unlocked: 1, total: 2 })
  })

  it('reads the installed games first, and a page open ahead of the scan', async () => {
    library.mergeOwned('gog', [{ externalId: '9', title: 'Owned Only' }])
    const [installed] = addGames('1')
    const order: string[] = []
    const read = vi.fn(async (game: Game, _key: string, priority: 'page' | 'scan') => {
      order.push(`${game.id}:${priority}`)
      return list(0, 1)
    })
    const s = createScan(read)
    await s.sync()
    expect(order[0]).toBe(`${installed}:scan`)
    await s.load(library.getGame(installed)!)
    expect(order.at(-1)).toBe(`${installed}:page`)
  })

  it('reads nothing while a game runs', async () => {
    addGames('1')
    running = true
    const read = vi.fn(async () => list(1, 1))
    const s = createScan(read)
    await s.sync()
    expect(read).not.toHaveBeenCalled()
  })
})
