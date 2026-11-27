import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import type { ClientInfo, Game, InstallProgress } from '../../shared/types'
import type { InstallSpec, StoreAccount } from '../accounts/types'
import { EventBus } from '../events'
import { LibraryStore } from '../store/library-store'
import { SessionsStore } from '../store/sessions-store'
import { LibraryService } from '../services/library-service'
import {
  createInstallService,
  STORE_START_VISIBLE_SOURCES,
  type InstallProbe,
  type InstallService
} from './index'
import { createInstallQueue, type InstallQueue } from './queue'
import {
  blindMessage,
  heldTimeoutMessage,
  stalledMessage,
  unconfirmedMessage,
  type TrackerTiming
} from './tracker'

let dir: string
let library: LibraryService
let store: LibraryStore
let sessions: SessionsStore
let events: InstallProgress[]
let bus: EventBus
let io: {
  openExternal: Mock<(uri: string) => Promise<void>>
  spawn: ReturnType<typeof vi.fn>
  running: boolean
}
let service: InstallService
let queue: InstallQueue
let scans: string[]
let client: ClientInfo
/** When set, the store client detection waits for it (a slow detection during a second Install). */
let clientGate: Promise<void> | null = null

const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

function fakeAccount(
  source: StoreAccount['source'],
  spec: (game: Game, client: ClientInfo) => InstallSpec | null
): StoreAccount {
  return {
    source,
    storeName: source === 'gog' ? 'GOG Galaxy' : 'Steam',
    supported: true,
    confirmMessage: `Confirm in ${source}`,
    signIn: async () => null,
    refresh: async (t) => t,
    displayName: async () => undefined,
    fetchOwned: async () => [],
    installSpec: spec,
    installError: () => 'cannot install'
  }
}

const accounts = new Map<string, StoreAccount>([
  ['steam', fakeAccount('steam', (g) => ({ kind: 'uri', uri: `steam://install/${g.externalId}` }))],
  [
    'gog',
    fakeAccount('gog', (g, c) =>
      c.path
        ? {
            kind: 'exec',
            file: c.path,
            args: [`/gameId=${g.externalId}`, '/command=installGame'],
            requiresProcess: 'GalaxyClient',
            followUpUri: `goggalaxy://openGameView/${g.externalId}`,
            followUpDelayMs: 0
          }
        : null
    )
  ]
])

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-install-svc-'))
  events = []
  bus = new EventBus()
  bus.on('install:progress', (p) => events.push(p))
  store = new LibraryStore(join(dir, 'library.json'))
  sessions = new SessionsStore(join(dir, 'sessions.json'))
  await store.load()
  await sessions.load()
  library = new LibraryService(store, sessions, bus)
  library.mergeOwned('steam', [{ externalId: '620', title: 'Portal 2' }])
  library.mergeOwned('gog', [{ externalId: '1207658924', title: 'Cyberpunk 2077' }])
  library.mergeScan(
    'steam',
    [
      {
        source: 'steam',
        externalId: '440',
        platformId: 'steam',
        title: 'TF2',
        launch: { kind: 'uri', uri: 'steam://rungameid/440' },
        tracking: { mode: 'none' }
      }
    ],
    { markMissing: false }
  )
  scans = []
  client = { installed: true, path: join(dir, 'GalaxyClient.exe') }
  await fs.writeFile(client.path!, 'MZ')
  const spawned = {
    once: (ev: string, cb: () => void) => (ev === 'spawn' ? setTimeout(cb, 0) : undefined),
    on: () => undefined,
    unref: () => undefined
  }
  io = { openExternal: vi.fn(async () => {}), spawn: vi.fn(() => spawned), running: true }
  await startService()
})
afterEach(async () => {
  clientGate = null
  await queue.dispose()
  service.dispose()
  // The library and sessions stores save a moment after a change (debounced: a temp file renamed into this folder).
  // In a test that outlasts that delay (a loaded PC) the save landed while the folder was being removed: ENOTEMPTY.
  // Their pending saves are written out first, so nothing writes here any more.
  await store.flush()
  await sessions.flush()
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

/** A fresh queue (read from queue.json) and install service, like a PlayOut start. */
async function startService(
  options: { probe?: InstallProbe; timing?: Partial<TrackerTiming> } = {}
): Promise<void> {
  queue = createInstallQueue({ stateFile: join(dir, 'queue.json'), events: bus, log: quiet })
  service = createInstallService({
    library,
    accounts: {
      account: (s) => accounts.get(s)!,
      installSpec: (g, c) => accounts.get(g.source)!.installSpec(g, c),
      installError: (g, c) => accounts.get(g.source)!.installError!(g, c)
    },
    scan: {
      run: async (ids) => {
        scans.push(...(ids ?? []))
        return {} as never
      },
      client: async () => {
        if (clientGate) await clientGate
        return client
      }
    },
    events: bus,
    log: quiet,
    queue,
    io: {
      openExternal: io.openExternal,
      spawn: io.spawn as never,
      isProcessRunning: async () => io.running,
      sleep: async () => {}
    },
    probeFor: async () => options.probe ?? null,
    timing: {
      stateOnlyProbeMs: 50,
      probeMs: 50,
      scanMs: 50,
      timeoutMs: 60_000,
      ...options.timing
    }
  })
  await queue.begin()
}

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('InstallService', () => {
  it('opens the allow-listed URI and tracks the game', async () => {
    const result = await service.installGame('steam:620')
    expect(result).toEqual({ ok: true })
    expect(io.openExternal).toHaveBeenCalledWith('steam://install/620')
    expect(service.getInstalls()).toMatchObject([
      { gameId: 'steam:620', source: 'steam', state: 'starting', message: 'Confirm in steam' }
    ])
    expect(events).toHaveLength(1)
    // A second Install re-sends the URI and keeps the one watch.
    await service.installGame('steam:620')
    expect(io.openExternal).toHaveBeenCalledTimes(2)
    expect(service.getInstalls()).toHaveLength(1)
  })

  it('builds the progress reader before the hand-off, so a log tail is anchored at the client output', async () => {
    const order: string[] = []
    service.dispose()
    service = createInstallService({
      library,
      accounts: {
        account: (s) => accounts.get(s)!,
        installSpec: (g, c) => accounts.get(g.source)!.installSpec(g, c),
        installError: (g, c) => accounts.get(g.source)!.installError!(g, c)
      },
      scan: { run: async () => ({}) as never, client: async () => client },
      events: bus,
      log: quiet,
      queue,
      io: {
        openExternal: async () => {
          order.push('open')
        },
        spawn: io.spawn as never,
        isProcessRunning: async () => true,
        sleep: async () => {}
      },
      probeFor: async () => {
        order.push('probe')
        return null
      },
      timing: { stateOnlyProbeMs: 50, probeMs: 50, scanMs: 50, timeoutMs: 60_000 }
    })
    expect(await service.installGame('steam:620')).toEqual({ ok: true })
    expect(order).toEqual(['probe', 'open'])
    // A second Install for the tracked game re-sends the URI without a new reader.
    await service.installGame('steam:620')
    expect(order).toEqual(['probe', 'open', 'open'])
    expect(service.trackedGameIds()).toEqual(['steam:620'])
  })

  it('refuses installed games, non-store games and games without an install form', async () => {
    expect(await service.installGame('steam:440')).toMatchObject({
      ok: false,
      error: /already installed/
    })
    client = { installed: false }
    expect(await service.installGame('gog:1207658924')).toEqual({
      ok: false,
      error: 'cannot install'
    })
    await expect(service.installGame('nope')).rejects.toThrow('Unknown game')
    expect(service.getInstalls()).toEqual([])
  })

  it('refuses a URI outside the allow-list before it reaches the shell', async () => {
    accounts.set(
      'steam',
      fakeAccount('steam', () => ({ kind: 'uri', uri: 'https://evil.example/x' }))
    )
    try {
      const result = await service.installGame('steam:620')
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/Refusing/)
      expect(io.openExternal).not.toHaveBeenCalled()
    } finally {
      accounts.set(
        'steam',
        fakeAccount('steam', (g) => ({ kind: 'uri', uri: `steam://install/${g.externalId}` }))
      )
    }
  })

  it('runs the client command when its process is up, else only the follow-up URI', async () => {
    expect(await service.installGame('gog:1207658924')).toEqual({ ok: true })
    expect(io.spawn).toHaveBeenCalledWith(
      client.path,
      ['/gameId=1207658924', '/command=installGame'],
      expect.objectContaining({ detached: true })
    )
    await new Promise((r) => setTimeout(r, 5))
    expect(io.openExternal).toHaveBeenCalledWith('goggalaxy://openGameView/1207658924')
    service.cancelInstallTracking('gog:1207658924')

    io.spawn.mockClear()
    io.openExternal.mockClear()
    io.running = false
    expect(await service.installGame('gog:1207658924')).toEqual({ ok: true })
    expect(io.spawn).not.toHaveBeenCalled()
    expect(io.openExternal).toHaveBeenCalledWith('goggalaxy://openGameView/1207658924')
  })

  it('warns when a follow-up URI outside the allow-list is dropped after the client command ran', async () => {
    const original = accounts.get('gog')!
    accounts.set(
      'gog',
      fakeAccount('gog', (g, c) =>
        c.path
          ? {
              kind: 'exec',
              file: c.path,
              args: [`/gameId=${g.externalId}`],
              requiresProcess: 'GalaxyClient',
              followUpUri: 'https://evil.example/x',
              followUpDelayMs: 0
            }
          : null
      )
    )
    const warn = vi.spyOn(quiet, 'warn')
    try {
      expect(await service.installGame('gog:1207658924')).toEqual({ ok: true })
      expect(io.spawn).toHaveBeenCalled()
      await new Promise((r) => setTimeout(r, 5))
      expect(io.openExternal).not.toHaveBeenCalled()
      expect(warn.mock.calls.map((c) => String((c as unknown[])[0]))).toEqual([
        'Cyberpunk 2077: follow-up https: URL is not on the install allow-list; not opened'
      ])
    } finally {
      warn.mockRestore()
      accounts.set('gog', original)
    }
  })

  it('releases the queue when a held watch saw no change for the long last-resort timeout', async () => {
    await queue.dispose()
    service.dispose()
    // No probe: PlayOut cannot see the store, which (say) cancelled the install.
    await startService({ timing: { unconfirmedMs: 50, timeoutMs: 100, heldTimeoutMs: 250 } })
    await service.installGame('steam:620')
    await service.installGame('gog:1207658924')
    await until(() => io.spawn.mock.calls.length > 0)
    expect(events.find((e) => e.gameId === 'steam:620' && e.state === 'failed')).toMatchObject({
      message: heldTimeoutMessage('Steam', 250)
    })
    expect(service.getInstallQueue().map((e) => `${e.gameId}:${e.state}`)).toEqual([
      'gog:1207658924:active'
    ])
    // Pressing Install again queues it again.
    expect(await service.installGame('steam:620')).toEqual({ ok: true, queued: 1 })
  })

  it('ends the watch with done when the confirming scan finds the game installed', async () => {
    await service.installGame('steam:620')
    await new Promise((r) => setTimeout(r, 120))
    expect(scans).toContain('steam')
    library.mergeScan(
      'steam',
      [
        {
          source: 'steam',
          externalId: '620',
          platformId: 'steam',
          title: 'Portal 2',
          launch: { kind: 'uri', uri: 'steam://rungameid/620' },
          tracking: { mode: 'none' }
        }
      ],
      { markMissing: false }
    )
    await new Promise((r) => setTimeout(r, 120))
    expect(events.at(-1)).toMatchObject({ gameId: 'steam:620', state: 'done' })
    expect(service.getInstalls()).toEqual([])
    expect(library.getGame('steam:620')?.owned).toBe(true)
  })

  it('cancelInstallTracking drops the entry without a final event', async () => {
    await service.installGame('steam:620')
    const count = events.length
    service.cancelInstallTracking('steam:620')
    expect(service.getInstalls()).toEqual([])
    await new Promise((r) => setTimeout(r, 80))
    expect(events.length).toBe(count)
  })

  it('queues a second game while one installs and hands it to its store when the first ends', async () => {
    expect(await service.installGame('steam:620')).toEqual({ ok: true })
    expect(await service.installGame('gog:1207658924')).toEqual({ ok: true, queued: 1 })
    expect(io.spawn).not.toHaveBeenCalled()
    expect(service.getInstallQueue()).toMatchObject([
      { gameId: 'steam:620', state: 'active', kind: 'store', from: 'Steam' },
      { gameId: 'gog:1207658924', state: 'waiting', kind: 'store', from: 'GOG Galaxy' }
    ])
    // The owned import keeps the waiting game's record too.
    expect(service.trackedGameIds().sort()).toEqual(['gog:1207658924', 'steam:620'])
    // Asking again keeps its place.
    expect(await service.installGame('gog:1207658924')).toEqual({ ok: true, queued: 1 })

    service.removeFromInstallQueue('steam:620')
    // The watch starts once the store client spawned, a moment after the spawn call.
    await until(() => io.spawn.mock.calls.length > 0 && service.getInstalls().length > 0)
    expect(service.getInstalls().map((p) => p.gameId)).toEqual(['gog:1207658924'])
    expect(service.getInstallQueue()).toMatchObject([{ gameId: 'gog:1207658924', state: 'active' }])
  })

  it('moves on when the watch of the installing game ends', async () => {
    await service.installGame('steam:620')
    await service.installGame('gog:1207658924')
    library.mergeScan(
      'steam',
      [
        {
          source: 'steam',
          externalId: '620',
          platformId: 'steam',
          title: 'Portal 2',
          launch: { kind: 'uri', uri: 'steam://rungameid/620' },
          tracking: { mode: 'none' }
        }
      ],
      { markMissing: false }
    )
    await until(() => io.spawn.mock.calls.length > 0)
    expect(events.find((e) => e.gameId === 'steam:620' && e.state === 'done')).toBeDefined()
    expect(service.getInstallQueue().map((e) => e.gameId)).toEqual(['gog:1207658924'])
  })

  it('reports a queued game that cannot be handed over in its turn', async () => {
    await service.installGame('steam:620')
    await service.installGame('gog:1207658924')
    client = { installed: false }
    service.cancelInstallTracking('steam:620')
    await until(() => events.some((e) => e.gameId === 'gog:1207658924'))
    expect(events.find((e) => e.gameId === 'gog:1207658924')).toMatchObject({
      state: 'failed',
      message: 'cannot install'
    })
    expect(service.getInstallQueue()).toEqual([])
  })

  it('a game removed and added again during its hand-off keeps its new watch, and the next game still waits', async () => {
    let release: () => void = () => {}
    io.openExternal.mockImplementationOnce(() => new Promise<void>((r) => (release = r)))
    const first = service.installGame('steam:620')
    await until(() => io.openExternal.mock.calls.length === 1)
    service.cancelInstallTracking('steam:620')
    const second = service.installGame('steam:620')
    await new Promise((r) => setTimeout(r, 20))
    // The new run waits for the old hand-off to settle: one hand-off at a time.
    expect(io.openExternal).toHaveBeenCalledTimes(1)
    release()
    expect(await first).toEqual({ ok: true })
    expect(await second).toEqual({ ok: true })
    expect(io.openExternal).toHaveBeenCalledTimes(2)
    // The old hand-off made no watch; the new one's is kept.
    expect(service.getInstalls().map((p) => p.gameId)).toEqual(['steam:620'])
    expect(service.getInstallQueue()).toMatchObject([{ gameId: 'steam:620', state: 'active' }])
    expect(await service.installGame('gog:1207658924')).toEqual({ ok: true, queued: 1 })
    await new Promise((r) => setTimeout(r, 20))
    expect(io.spawn).not.toHaveBeenCalled()
    expect(service.getInstalls().map((p) => p.gameId)).toEqual(['steam:620'])
  })

  it("queues a game under the user's own title", async () => {
    library.updateGame('gog:1207658924', { user: { titleOverride: 'CP2077' } })
    await service.installGame('steam:620')
    await service.installGame('gog:1207658924')
    expect(service.getInstallQueue().map((e) => e.title)).toEqual(['Portal 2', 'CP2077'])
  })

  it('resumes the watch of the game installing when PlayOut closed, without a new hand-off', async () => {
    await service.installGame('steam:620')
    await service.installGame('gog:1207658924')
    await queue.dispose()
    service.dispose()
    io.openExternal.mockClear()

    await startService()
    await until(() => service.getInstalls().length > 0)
    expect(io.openExternal).not.toHaveBeenCalled()
    expect(service.getInstalls()).toMatchObject([
      { gameId: 'steam:620', message: 'Installing through Steam…' }
    ])
    expect(service.getInstallQueue().map((e) => `${e.gameId}:${e.state}`)).toEqual([
      'steam:620:active',
      'gog:1207658924:waiting'
    ])
  })

  it('hands the game over again when PlayOut closed before the store was asked', async () => {
    // The entry was saved active, but PlayOut quit before the hand-off finished (no handedOff in the file).
    await queue.dispose()
    service.dispose()
    await fs.writeFile(
      join(dir, 'queue.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            gameId: 'steam:620',
            title: 'Portal 2',
            kind: 'store',
            source: 'steam',
            from: 'Steam',
            state: 'active',
            addedAt: '2026-01-01T00:00:00.000Z'
          }
        ]
      })
    )
    await startService()
    await until(() => io.openExternal.mock.calls.length > 0)
    expect(io.openExternal).toHaveBeenCalledWith('steam://install/620')
    expect(service.getInstalls()).toMatchObject([{ gameId: 'steam:620', state: 'starting' }])
    // Marked as handed off now, so the next restart only watches.
    await queue.dispose()
    const saved = JSON.parse(await fs.readFile(join(dir, 'queue.json'), 'utf8'))
    expect(saved.entries[0]).toMatchObject({ gameId: 'steam:620', handedOff: true })
    expect(service.getInstallQueue()[0]).not.toHaveProperty('handedOff')
  })

  it('moves on when the store never shows the install, with a message to press Install again', async () => {
    await queue.dispose()
    service.dispose()
    await startService({
      probe: async () => null,
      timing: { unconfirmedMs: 150 }
    })
    await service.installGame('steam:620')
    await service.installGame('gog:1207658924')
    await until(() => io.spawn.mock.calls.length > 0)
    expect(events.find((e) => e.gameId === 'steam:620' && e.state === 'failed')).toMatchObject({
      message: unconfirmedMessage('Steam')
    })
    expect(service.getInstallQueue().map((e) => `${e.gameId}:${e.state}`)).toEqual([
      'gog:1207658924:active'
    ])
    // Pressing Install again queues it again.
    expect(await service.installGame('steam:620')).toEqual({ ok: true, queued: 1 })
  })

  it('keeps the queue while the store shows the install but it stalls (paused there)', async () => {
    await queue.dispose()
    service.dispose()
    await startService({
      probe: async () => ({ state: 'downloading', percent: 30, fingerprint: 'same' }),
      timing: { unconfirmedMs: 100, timeoutMs: 150 }
    })
    await service.installGame('steam:620')
    await service.installGame('gog:1207658924')
    const stalled = stalledMessage('Steam', 150)
    await until(() => events.some((e) => e.gameId === 'steam:620' && e.message === stalled))
    await new Promise((r) => setTimeout(r, 200))
    expect(service.getInstalls()).toMatchObject([
      { gameId: 'steam:620', state: 'downloading', message: stalled }
    ])
    expect(events.some((e) => e.state === 'failed')).toBe(false)
    expect(io.spawn).not.toHaveBeenCalled()
    expect(service.getInstallQueue().map((e) => `${e.gameId}:${e.state}`)).toEqual([
      'steam:620:active',
      'gog:1207658924:waiting'
    ])
    // The user takes it out: the next one goes.
    service.removeFromInstallQueue('steam:620')
    await until(() => io.spawn.mock.calls.length > 0)
  })

  it('only ends a fresh, unconfirmed watch by a timer for stores whose probe reliably sees the start', () => {
    expect([...STORE_START_VISIBLE_SOURCES].sort()).toEqual(['battlenet', 'epic', 'gog', 'steam'])
  })

  it('never ends a resumed watch by a timer: it holds the queue and says PlayOut cannot see it', async () => {
    await service.installGame('steam:620')
    await service.installGame('gog:1207658924')
    await queue.dispose()
    service.dispose()
    events.length = 0
    // The store never shows anything PlayOut can see after the restart.
    await startService({ probe: async () => null, timing: { unconfirmedMs: 50, timeoutMs: 120 } })
    await until(() => events.some((e) => e.message === blindMessage('Steam')))
    await new Promise((r) => setTimeout(r, 150))
    expect(events.some((e) => e.state === 'failed')).toBe(false)
    expect(service.getInstalls()).toMatchObject([
      { gameId: 'steam:620', message: blindMessage('Steam') }
    ])
    expect(io.spawn).not.toHaveBeenCalled()
    expect(service.getInstallQueue().map((e) => `${e.gameId}:${e.state}`)).toEqual([
      'steam:620:active',
      'gog:1207658924:waiting'
    ])
    // The confirming scan still ends it.
    library.mergeScan(
      'steam',
      [
        {
          source: 'steam',
          externalId: '620',
          platformId: 'steam',
          title: 'Portal 2',
          launch: { kind: 'uri', uri: 'steam://rungameid/620' },
          tracking: { mode: 'none' }
        }
      ],
      { markMissing: false }
    )
    await until(() => io.spawn.mock.calls.length > 0)
  })

  it('never ends a fresh watch without a probe by a timer', async () => {
    await queue.dispose()
    service.dispose()
    await startService({ timing: { unconfirmedMs: 50, timeoutMs: 120 } })
    await service.installGame('steam:620')
    await service.installGame('gog:1207658924')
    await until(() => events.some((e) => e.message === blindMessage('Steam')))
    await new Promise((r) => setTimeout(r, 150))
    expect(events.some((e) => e.state === 'failed')).toBe(false)
    expect(io.spawn).not.toHaveBeenCalled()
    expect(queue.activeId()).toBe('steam:620')
  })

  it('a second Install whose game stopped installing meanwhile queues it instead of making its own watch', async () => {
    expect(await service.installGame('steam:620')).toEqual({ ok: true })
    expect(await service.installGame('gog:1207658924')).toEqual({ ok: true, queued: 1 })
    let release: () => void = () => {}
    clientGate = new Promise<void>((r) => (release = r))
    const again = service.installGame('steam:620')
    await new Promise((r) => setTimeout(r, 10))
    // The user takes the installing game out while the second Install looks up the store client.
    service.removeFromInstallQueue('steam:620')
    release()
    clientGate = null
    expect(await again).toEqual({ ok: true, queued: 1 })
    // The watch starts once the store client spawned, a moment after the spawn call.
    await until(() => io.spawn.mock.calls.length > 0 && service.getInstalls().length > 0)
    // Only the queue's watch (GOG's) runs; Portal 2 waits its turn, unwatched and not handed off again.
    expect(service.getInstalls().map((p) => p.gameId)).toEqual(['gog:1207658924'])
    expect(io.openExternal.mock.calls.filter(([u]) => u.startsWith('steam:'))).toHaveLength(1)
    expect(service.getInstallQueue().map((e) => `${e.gameId}:${e.state}`)).toEqual([
      'gog:1207658924:active',
      'steam:620:waiting'
    ])
  })

  it('a second Install while the game is installing re-sends the hand-off and makes no new watch', async () => {
    await service.installGame('steam:620')
    const before = service.getInstalls()
    expect(await service.installGame('steam:620')).toEqual({ ok: true })
    expect(io.openExternal).toHaveBeenCalledTimes(2)
    expect(service.getInstalls()).toEqual(before)
    expect(service.getInstallQueue()).toHaveLength(1)
  })

  it('drops a waiting store game from the queue as soon as it shows up installed', async () => {
    library.mergeOwned('steam', [
      { externalId: '620', title: 'Portal 2' },
      { externalId: '400', title: 'Portal' }
    ])
    await service.installGame('gog:1207658924')
    await service.installGame('steam:620')
    await service.installGame('steam:400')
    const lists: string[][] = []
    bus.on('installs:queue', (l) => lists.push(l.map((e) => e.gameId)))
    // Portal 2 was installed straight in Steam.
    library.mergeScan(
      'steam',
      [
        {
          source: 'steam',
          externalId: '620',
          platformId: 'steam',
          title: 'Portal 2',
          launch: { kind: 'uri', uri: 'steam://rungameid/620' },
          tracking: { mode: 'none' }
        }
      ],
      { markMissing: false }
    )
    expect(service.getInstallQueue().map((e) => `${e.gameId}:${e.state}`)).toEqual([
      'gog:1207658924:active',
      'steam:400:waiting'
    ])
    expect(lists.at(-1)).toEqual(['gog:1207658924', 'steam:400'])
    // The active game is left to its watch.
    expect(service.getInstalls().map((p) => p.gameId)).toEqual(['gog:1207658924'])
  })
})

describe('InstallService: pause and resume', () => {
  it('pausing the installing game keeps its watch and the queue, and opens the store downloads page', async () => {
    await service.installGame('steam:620')
    await service.installGame('gog:1207658924')
    io.openExternal.mockClear()
    service.pauseInstall('steam:620')
    expect(io.openExternal).toHaveBeenCalledWith('steam://open/downloads')
    expect(service.getInstallQueue()).toMatchObject([
      { gameId: 'steam:620', state: 'active', paused: true },
      { gameId: 'gog:1207658924', state: 'waiting' }
    ])
    // Still watched: the store keeps the download until it is paused there.
    expect(service.getInstalls().map((p) => p.gameId)).toEqual(['steam:620'])
    await new Promise((r) => setTimeout(r, 30))
    expect(io.spawn).not.toHaveBeenCalled()

    service.resumeInstall('steam:620')
    expect(io.openExternal).toHaveBeenCalledTimes(1)
    expect(service.getInstallQueue()[0]).not.toHaveProperty('paused')
  })

  it("opens another store's library page, and a waiting game is paused without opening anything", async () => {
    await service.installGame('steam:620')
    await service.installGame('gog:1207658924')
    io.openExternal.mockClear()
    service.pauseInstall('gog:1207658924')
    expect(io.openExternal).not.toHaveBeenCalled()
    expect(service.getInstallQueue()[1]).toMatchObject({ gameId: 'gog:1207658924', paused: true })
    // The paused game is skipped when the installing one goes.
    service.removeFromInstallQueue('steam:620')
    await new Promise((r) => setTimeout(r, 30))
    expect(io.spawn).not.toHaveBeenCalled()
    expect(service.getInstallQueue()).toMatchObject([
      { gameId: 'gog:1207658924', state: 'waiting', paused: true }
    ])
    // Resumed with nothing installing: it is handed over at once, then pausing it opens GOG Galaxy.
    service.resumeInstall(null)
    await until(() => io.spawn.mock.calls.length > 0 && service.getInstalls().length > 0)
    io.openExternal.mockClear()
    service.pauseInstall(null)
    expect(io.openExternal).toHaveBeenCalledWith('goggalaxy://openGameView')
    expect(service.getInstallQueue()).toMatchObject([
      { gameId: 'gog:1207658924', state: 'active', paused: true }
    ])
  })

  it('a paused installing game is watched again after a restart, without opening the store again', async () => {
    await service.installGame('steam:620')
    service.pauseInstall('steam:620')
    await queue.dispose()
    service.dispose()
    io.openExternal.mockClear()

    await startService()
    await until(() => service.getInstalls().length > 0)
    expect(io.openExternal).not.toHaveBeenCalled()
    expect(service.getInstallQueue()).toMatchObject([
      { gameId: 'steam:620', state: 'active', paused: true }
    ])
  })
})
