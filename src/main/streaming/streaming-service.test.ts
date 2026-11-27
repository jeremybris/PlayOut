import type { ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { defaultSettings } from '../../shared/defaults'
import type {
  AchievementsInfo,
  Game,
  LaunchResult,
  LibraryTabDef,
  PlaySession,
  PlayOutEventName,
  PlayOutEvents,
  RemoteLibrary,
  RomDownloadProgress,
  Settings,
  StreamSession
} from '../../shared/types'
import type { TokenCrypto } from '../accounts/token-store'
import { EventBus } from '../events'
import { createInstallQueue, type InstallQueue, type InstallQueueItem } from '../installs/queue'
import type { Logger } from '../logger'
import { HostRequestError, type HostConnection, type HostClient } from './host-client'
import type { HostHandlers, HostServerDeps, RequestContext } from './host-server'
import type { Moonlight } from './moonlight'
import { markPs3HddInUse } from '../emulation/ps3-hdd'
import { syntheticIso } from '../emulation/disc-test-helpers'
import { createSecretsStore, type SecretsStore } from './secrets'
import type { StreamLaunchServerDeps } from './stream-launch'
import {
  createStreamingService,
  friendlyNetError,
  hostOfflineMessage,
  HOST_TRANSFER_ATTEMPTS,
  isHostUnreachable,
  isLanAddress,
  offeredMetadata,
  parseHostAddress,
  RETRY_FIRST_MS,
  RETRY_MAX_MS,
  type StreamingIo,
  type StreamingService,
  type StreamingServiceDeps
} from './streaming-service'
import type { Sunshine, SunshineConfig, SunshineDeps } from './sunshine'
import type { FoundHost } from './discovery'
import type { UpnpGateway } from './upnp'
import { isMediaRevision, offeredId } from './remote-library'

/**
 * The streaming service's orchestration with fakes around it (one test pairs two services over a real TLS host
 * server on localhost): hosting order, pairing, the remote library, ROM downloads, Moonlight sessions and the host's
 * prepare / run / stop.
 */

const quiet: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

const crypto: TokenCrypto = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
  decryptString: (b) => b.toString('utf8').slice(4)
}

function game(partial: Partial<Game> & Pick<Game, 'id' | 'source' | 'title'>): Game {
  return {
    externalId: partial.id.split(':').slice(1).join(':'),
    platformId: partial.source === 'rom' ? 'snes' : partial.source,
    sortTitle: partial.title.toLowerCase(),
    installed: true,
    launch: { kind: 'uri', uri: 'steam://rungameid/1' },
    tracking: { mode: 'none' },
    hidden: false,
    favorite: false,
    playtimeMinutes: 0,
    playCount: 0,
    addedAt: '2026-01-01T00:00:00.000Z',
    metadata: {},
    media: {},
    metadataStatus: 'done',
    user: {},
    ...partial
  }
}

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'playout-streaming-'))
  dirs.push(dir)
  return dir
}

const services: StreamingService[] = []
const queues: InstallQueue[] = []
afterEach(async () => {
  await Promise.all(queues.splice(0).map((q) => q.dispose()))
  await Promise.all(services.splice(0).map((s) => s.dispose()))
  // The services are disposed (their writes flushed) by now; the retries are for Windows itself still holding a file
  // (an antivirus or the indexer reading a just-written one), which fails a removal with EBUSY / EPERM / ENOTEMPTY.
  await Promise.all(
    dirs
      .splice(0)
      .map((d) => fs.rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  )
})

interface FakeSettings {
  get(): Settings
  onChange(listener: (s: Settings) => void): () => void
  set(change: (s: Settings) => void): void
}

function fakeSettings(patch: (s: Settings) => void = () => {}): FakeSettings {
  const value = defaultSettings()
  patch(value)
  const listeners = new Set<(s: Settings) => void>()
  return {
    get: () => value,
    onChange(listener: (s: Settings) => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    set(change: (s: Settings) => void) {
      change(value)
      for (const l of listeners) l(value)
    }
  }
}

function recorder<E extends PlayOutEventName>(events: EventBus, name: E): PlayOutEvents[E][] {
  const seen: PlayOutEvents[E][] = []
  events.on(name, (p) => seen.push(JSON.parse(JSON.stringify(p)) as PlayOutEvents[E]))
  return seen
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 10))
  }
}

function fakeSunshine(calls: string[], over: Partial<Sunshine> = {}): Sunshine {
  let running = false
  return {
    status: () => ({ state: running ? 'running' : 'installed' }),
    ensureInstalled: async () => {
      calls.push('sunshine.ensureInstalled')
      return { tag: 'v1', asset: 'a', sha256: 'x', installedAt: '', dir: '' }
    },
    configure: async (config: SunshineConfig) => {
      calls.push(`sunshine.configure name=${config.name}`)
    },
    ensureCredentials: async () => void calls.push('sunshine.ensureCredentials'),
    start: async () => {
      calls.push('sunshine.start')
      running = true
    },
    stop: async () => {
      if (running) calls.push('sunshine.stop')
      running = false
    },
    running: () => running,
    portInUse: async () => false,
    api: async () => ({}) as never,
    pendingPairings: async () => [],
    approvePairing: async ({ pin }) => {
      calls.push(`sunshine.approve ${pin}`)
      return true
    },
    closeApp: async () => void calls.push('sunshine.closeApp'),
    unpairAll: async () => {},
    controllerDriverInstalled: async () => true,
    dispose: () => {},
    ...over
  }
}

class FakeChild extends EventEmitter {
  exitCode: number | null = null
  stderr = new EventEmitter()
  kill(): boolean {
    this.finish(1)
    return true
  }
  finish(code: number): void {
    if (this.exitCode !== null) return
    this.exitCode = code
    this.emit('close', code)
  }
}

function fakeMoonlight(over: Partial<Moonlight> = {}): Moonlight & { paired: Set<string> } {
  const paired = new Set<string>()
  return {
    paired,
    status: () => ({ state: 'installed' }),
    ensureInstalled: async () => ({ tag: 'v6', asset: 'a', sha256: 'x', installedAt: '', dir: '' }),
    async pair(host) {
      const child = new FakeChild()
      const done = new Promise<void>((resolve) => child.once('close', () => resolve()))
      // The host approves; Moonlight then lists it as paired.
      paired.add(host)
      return { child: child as unknown as ChildProcess, done }
    },
    isPaired: async (host) => paired.has(host),
    async closeWindow(child) {
      child.kill()
    },
    stream: async () => new FakeChild() as unknown as ChildProcess,
    quit: async () => {},
    ...over
  }
}

interface Setup {
  service: StreamingService
  events: EventBus
  settings: ReturnType<typeof fakeSettings>
  games: Game[]
  calls: string[]
  dataDir: string
  launcher: {
    launch: ReturnType<typeof vi.fn>
    running: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>
  }
  window: { minimize: ReturnType<typeof vi.fn>; restore: ReturnType<typeof vi.fn> }
  scan: { run: ReturnType<typeof vi.fn> }
  installQueue: InstallQueue
}

async function setup(options: {
  settings?: (s: Settings) => void
  games?: Game[]
  io?: Partial<StreamingIo>
  hostName?: string
  mediaFile?: StreamingServiceDeps['mediaFile']
  calls?: string[]
  secrets?: SecretsStore
  /** Reuse a data folder (a restart). */
  dataDir?: string
  importFromHost?: StreamingServiceDeps['importFromHost']
  /** The Emulation folder (turns the Emulation folder sync on). */
  emulationDir?: string
  readChd?: StreamingServiceDeps['readChd']
  gameIdTimeoutMs?: number
  firewall?: StreamingServiceDeps['firewall']
  /** The queue's and the service's waits for an older run / job of the same game. */
  settleWaitMs?: number
  olderDownloadWaitMs?: number
  recompFor?: StreamingServiceDeps['recompFor']
  /** LibraryService's host-game parts (viewRemote, onRemoteViewChange, adoptRemoteMetadataEdit). */
  remoteView?: Partial<StreamingServiceDeps['library']>
  fillLogins?: StreamingServiceDeps['fillLogins']
  firstStart?: boolean
  /** The Library tabs sync on (its file in the data folder; a winning copy goes into the fake settings). */
  syncTabs?: { afterChangeMs?: number }
  favoritesAfterChangeMs?: number
  /** The play time sync on (its state file in the data folder). */
  playtime?: { afterGameMs?: number }
  /** This PC's achievements service (a client's host-only games ask for their list). */
  achievements?: StreamingServiceDeps['achievements']
}): Promise<Setup> {
  const dataDir = options.dataDir ?? (await tempDir())
  const events = new EventBus()
  // Hosting is on by default for a new install; these tests switch it on where they host (with fakes for the server).
  const settings = fakeSettings((s) => {
    s.streaming.hostEnabled = false
    options.settings?.(s)
  })
  const games = options.games ?? []
  const calls = options.calls ?? []
  const launcher = {
    launch: vi.fn(async (): Promise<LaunchResult> => ({ ok: true })),
    running: vi.fn((): { gameId: string; startedAt: string } | null => null),
    stop: vi.fn(async () => true)
  }
  const window = { minimize: vi.fn(), restore: vi.fn() }
  const scan = { run: vi.fn(async () => undefined) }
  const installQueue = createInstallQueue({
    stateFile: join(dataDir, 'install-queue.json'),
    events,
    log: quiet,
    ...(options.settleWaitMs ? { settleWaitMs: options.settleWaitMs } : {})
  })
  queues.push(installQueue)
  const service = createStreamingService({
    settings,
    library: {
      games: () => games,
      getGame: (id) => games.find((g) => g.id === id),
      ...options.remoteView
    },
    ...(options.recompFor ? { recompFor: options.recompFor } : {}),
    ...(options.fillLogins ? { fillLogins: options.fillLogins } : {}),
    ...(options.syncTabs
      ? {
          libraryTabs: {
            file: join(dataDir, 'library-tabs-sync.json'),
            apply: (tabs: LibraryTabDef[]) => settings.set((x) => (x.ui.libraryTabs = tabs)),
            ...(options.syncTabs.afterChangeMs !== undefined
              ? { afterChangeMs: options.syncTabs.afterChangeMs }
              : {})
          }
        }
      : {}),
    ...(options.firstStart !== undefined ? { firstStart: options.firstStart } : {}),
    ...(options.achievements ? { achievements: options.achievements } : {}),
    ...(options.favoritesAfterChangeMs !== undefined
      ? { favoritesAfterChangeMs: options.favoritesAfterChangeMs }
      : {}),
    ...(options.playtime
      ? { playtime: { file: join(dataDir, 'playtime-sync.json'), ...options.playtime } }
      : {}),
    launcher,
    scan,
    events,
    log: quiet,
    dataDir,
    appVersion: '0.1.0',
    appCommand: '"PlayOut.exe" --stream-launch',
    pipeName: '\\\\.\\pipe\\playout-test',
    launchTokenFile: join(dataDir, 'stream-launch.token'),
    window,
    screenSize: () => ({ width: 2560, height: 1440 }),
    mediaFile: options.mediaFile ?? (() => null),
    hostName: options.hostName ?? 'TESTPC',
    installQueue,
    ...(options.olderDownloadWaitMs ? { olderDownloadWaitMs: options.olderDownloadWaitMs } : {}),
    ...(options.importFromHost ? { importFromHost: options.importFromHost } : {}),
    ...(options.emulationDir ? { emulationDir: () => options.emulationDir! } : {}),
    ...(options.firewall ? { firewall: options.firewall } : {}),
    ...(options.readChd ? { readChd: options.readChd } : {}),
    ...(options.gameIdTimeoutMs ? { gameIdTimeoutMs: options.gameIdTimeoutMs } : {}),
    io: {
      secrets: options.secrets ?? createSecretsStore(join(dataDir, 'secrets.json'), quiet, crypto),
      createSunshine: () => fakeSunshine(calls),
      createMoonlight: () => fakeMoonlight(),
      discoverHosts: async () => [],
      upnp: { discover: async () => null },
      publicIp: async () => null,
      localAddresses: () => ['192.168.1.10'],
      sleep: async () => {},
      ...options.io
    }
  })
  services.push(service)
  await installQueue.begin()
  return {
    service,
    events,
    settings,
    games,
    calls,
    dataDir,
    launcher,
    window,
    scan,
    installQueue
  }
}

/** Fakes for everything hosting opens, recording the order. */
function hostIo(
  calls: string[],
  over: { gateway?: Partial<UpnpGateway>; discover?: () => Promise<UpnpGateway | null> } = {}
): {
  io: Partial<StreamingIo>
  server: { deps: HostServerDeps | null }
  pipe: { deps: StreamLaunchServerDeps | null; active: string | null }
} {
  const server: { deps: HostServerDeps | null } = { deps: null }
  const pipe: { deps: StreamLaunchServerDeps | null; active: string | null } = {
    deps: null,
    active: null
  }
  const gateway: UpnpGateway = {
    location: 'http://192.168.1.1/root.xml',
    host: '192.168.1.1',
    serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:1',
    controlUrl: 'http://192.168.1.1/ctl',
    externalIp: async () => '203.0.113.5',
    addPortMapping: async (req) => {
      calls.push(`upnp.map ${req.protocol} ${req.externalPort} -> ${req.internalClient}`)
      return { leaseSeconds: req.leaseSeconds }
    },
    deletePortMapping: async (req) =>
      void calls.push(`upnp.unmap ${req.protocol} ${req.externalPort}`),
    ...over.gateway
  }
  return {
    server,
    pipe,
    io: {
      certificate: async () => ({ key: 'k', cert: 'c', fingerprint: 'ab'.repeat(32) }),
      createHostServer: (deps) => {
        server.deps = deps
        return {
          port: deps.port,
          listen: async () => void calls.push(`server.listen ${deps.port}`),
          close: async () => void calls.push('server.close')
        }
      },
      createDiscoveryResponder: (deps) => ({
        start: async () => void calls.push(`responder.start ${deps.port}`),
        stop: async () => void calls.push('responder.stop')
      }),
      ensureLaunchToken: async () => 'a'.repeat(64),
      createStreamLaunchServer: (deps) => {
        pipe.deps = deps
        return {
          listen: async () => void calls.push('pipe.listen'),
          close: async () => void calls.push('pipe.close'),
          active: () => pipe.active,
          dropClient: () => void calls.push('pipe.dropClient')
        }
      },
      upnp: { discover: over.discover ?? (async () => gateway) },
      internalClient: () => '192.168.1.10'
    }
  }
}

describe('address helpers', () => {
  it('tells LAN addresses from internet ones', () => {
    expect(isLanAddress('192.168.1.20')).toBe(true)
    expect(isLanAddress('10.0.0.3')).toBe(true)
    expect(isLanAddress('172.20.1.1')).toBe(true)
    expect(isLanAddress('DESKTOP-ABC')).toBe(true)
    expect(isLanAddress('gamer.local')).toBe(true)
    expect(isLanAddress('203.0.113.5')).toBe(false)
    expect(isLanAddress('home.example.com')).toBe(false)
  })

  it('parses host and host:port, and refuses IPv6 (nothing in the chain speaks it)', () => {
    expect(parseHostAddress(' 192.168.1.20 ', 47900)).toEqual({
      address: '192.168.1.20',
      port: 47900
    })
    expect(parseHostAddress('pc.example.com:5000', 47900)).toEqual({
      address: 'pc.example.com',
      port: 5000
    })
    expect(() => parseHostAddress('[fe80::1]:6000', 47900)).toThrow(/IPv4/)
    expect(() => parseHostAddress('fd00::5', 47900)).toThrow(/IPv4/)
    expect(isLanAddress('fd00::5')).toBe(false)
    expect(() => parseHostAddress('-x', 47900)).toThrow()
    expect(() => parseHostAddress('a b', 47900)).toThrow()
    expect(() => parseHostAddress('host:99999', 47900)).toThrow()
  })
})

describe('hosting', () => {
  it('is ready while the firewall prompt is up, shows a declined prompt, and asks again when switched on again', async () => {
    const calls: string[] = []
    const fakes = hostIo(calls)
    let answer!: (r: 'declined') => void
    const firewall = {
      ensure: vi.fn(() => new Promise<'declined'>((r) => (answer = r))),
      forgetDeclined: vi.fn(async () => {})
    }
    const { service, settings } = await setup({
      calls,
      io: fakes.io,
      firewall,
      settings: (s) => {
        s.streaming.hostEnabled = true
      }
    })
    await service.start()
    await service.idle()
    expect(firewall.ensure).toHaveBeenCalledWith(47900, 47901)
    expect((await service.status()).host.state).toBe('ready')
    answer('declined')
    await vi.waitFor(async () =>
      expect((await service.status()).host).toMatchObject({
        state: 'error',
        error: expect.stringMatching(/Windows Firewall blocks other PCs/)
      })
    )
    expect(firewall.forgetDeclined).not.toHaveBeenCalled()
    settings.set((s) => {
      s.streaming.hostEnabled = false
    })
    await service.idle()
    settings.set((s) => {
      s.streaming.hostEnabled = true
    })
    await vi.waitFor(() => expect(firewall.forgetDeclined).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(firewall.ensure).toHaveBeenCalledTimes(2))
    answer('declined')
  })

  it('starts in order (server, discovery, pipe, port forwarding, Sunshine) and stops everything', async () => {
    const calls: string[] = []
    const fakes = hostIo(calls)
    const { service, settings } = await setup({
      calls,
      io: fakes.io,
      settings: (s) => {
        s.streaming.hostEnabled = true
      }
    })
    await service.start()
    await service.idle()
    expect(calls).toEqual([
      'server.listen 47900',
      'responder.start 47901',
      'pipe.listen',
      'upnp.map TCP 47900 -> 192.168.1.10',
      // Sunshine's own ports, by PlayOut: Sunshine's UPnP is off (its mappings would outlive its forced stop).
      'upnp.map TCP 47984 -> 192.168.1.10',
      'upnp.map TCP 47989 -> 192.168.1.10',
      'upnp.map TCP 48010 -> 192.168.1.10',
      'upnp.map UDP 47998 -> 192.168.1.10',
      'upnp.map UDP 47999 -> 192.168.1.10',
      'upnp.map UDP 48000 -> 192.168.1.10',
      'sunshine.ensureInstalled',
      'sunshine.configure name=PlayOut TESTPC',
      'sunshine.ensureCredentials',
      'sunshine.start'
    ])
    expect(fakes.server.deps?.host).toBe('0.0.0.0')
    const on = await service.status()
    expect(on.host.state).toBe('ready')
    expect(on.host.portForwarding).toEqual({ state: 'mapped', externalIp: '203.0.113.5' })
    expect(on.host.controllerDriver).toBe(true)

    calls.length = 0
    settings.set((s) => {
      s.streaming.hostEnabled = false
    })
    await service.idle()
    expect(calls).toEqual(
      expect.arrayContaining([
        'server.close',
        'responder.stop',
        'pipe.close',
        'sunshine.stop',
        'upnp.unmap TCP 47900',
        'upnp.unmap TCP 47984',
        'upnp.unmap UDP 48000'
      ])
    )
    const off = await service.status()
    expect(off.host.state).toBe('off')
    expect(off.host.portForwarding.state).toBe('off')
  })

  it('keeps what works: same network only without UPnP, an error when Sunshine fails', async () => {
    const calls: string[] = []
    const fakes = hostIo(calls)
    const { service } = await setup({
      calls,
      io: {
        ...fakes.io,
        upnp: { discover: async () => null },
        createSunshine: () =>
          fakeSunshine(calls, {
            ensureInstalled: async () => {
              throw new Error('download failed')
            }
          })
      },
      settings: (s) => {
        s.streaming.hostEnabled = true
      }
    })
    await service.start()
    await service.idle()
    const status = await service.status()
    expect(status.host.portForwarding.state).toBe('unavailable')
    expect(status.host.state).toBe('error')
    expect(status.host.error).toContain('download failed')
    // The host service itself still runs: pairing and ROM downloads work without Sunshine.
    expect(calls).toContain('server.listen 47900')
    expect(calls).not.toContain('server.close')
    expect(status.host.listening).toBe(true)
    expect((await service.startPairing()).host.pairing).not.toBeNull()
  })

  it('behind double NAT or CGNAT: same network only, nothing left forwarded, no internet address sent', async () => {
    const calls: string[] = []
    const fakes = hostIo(calls, { gateway: { externalIp: async () => '100.64.1.2' } })
    const { service } = await setup({
      calls,
      io: fakes.io,
      settings: (s) => {
        s.streaming.hostEnabled = true
      }
    })
    await service.start()
    await service.idle()
    const pf = (await service.status()).host.portForwarding
    expect(pf.state).toBe('unavailable')
    expect(pf.externalIp).toBeUndefined()
    expect(pf.error).toMatch(/CGNAT/)
    expect(calls).toContain('upnp.unmap TCP 47900')
    expect(calls).toContain('upnp.unmap UDP 48000')
    expect(fakes.server.deps!.handlers.info().externalIp).toBeUndefined()
  })

  it('says so when the stream ports are not forwarded, and warns a client on another network', async () => {
    const calls: string[] = []
    const fakes = hostIo(calls, {
      gateway: {
        addPortMapping: async (req) => {
          if (req.protocol === 'UDP') throw new Error('ConflictInMappingEntry')
          calls.push(`upnp.map ${req.protocol} ${req.externalPort}`)
          return { leaseSeconds: req.leaseSeconds }
        }
      }
    })
    const games = [game({ id: 'steam:7', source: 'steam', title: 'Hades' })]
    const { service } = await setup({
      calls,
      games,
      io: fakes.io,
      settings: (s) => {
        s.streaming.hostEnabled = true
      }
    })
    await service.start()
    await service.idle()
    const pf = (await service.status()).host.portForwarding
    expect(pf).toMatchObject({ state: 'mapped', externalIp: '203.0.113.5' })
    expect(pf.error).toMatch(/Streaming ports could not be forwarded/)
    const handlers = fakes.server.deps!.handlers
    const client = { id: 'client-1', name: 'Attic' }
    const away = await handlers.prepareStream({ client, address: '198.51.100.20' }, 'steam:7')
    expect(away).toMatchObject({ ok: true, warning: expect.stringMatching(/streaming ports/) })
    await handlers.stopStream({ client, address: '198.51.100.20' })
    const home = await handlers.prepareStream({ client, address: '192.168.1.30' }, 'steam:7')
    expect(home).toEqual({ ok: true, sunshinePort: 47989 })
  })

  it('turning hosting off mid-start closes the listener at once and deletes a mapping that arrives late', async () => {
    const calls: string[] = []
    let answer: ((v: { leaseSeconds: number }) => void) | null = null
    const fakes = hostIo(calls, {
      gateway: {
        addPortMapping: (req) => {
          calls.push(`upnp.map ${req.protocol} ${req.externalPort}`)
          return new Promise((resolve) => (answer = resolve))
        }
      }
    })
    const { service, settings } = await setup({
      calls,
      io: fakes.io,
      settings: (s) => {
        s.streaming.hostEnabled = true
      }
    })
    await service.start()
    await until(() => calls.includes('upnp.map TCP 47900'))
    settings.set((s) => {
      s.streaming.hostEnabled = false
    })
    // Not after the router answers: now.
    await until(() => calls.includes('server.close'))
    expect((await service.status()).host.listening).toBe(false)
    answer!({ leaseSeconds: 3600 })
    await service.idle()
    expect(calls).toContain('upnp.unmap TCP 47900')
    expect(calls).not.toContain('upnp.map TCP 47984')
    expect(calls).not.toContain('sunshine.start')
  })

  it('quitting while the router answers still deletes the mapping, and records no permanent one', async () => {
    const calls: string[] = []
    let answer: ((v: { leaseSeconds: number }) => void) | null = null
    const fakes = hostIo(calls, {
      gateway: {
        addPortMapping: (req) => {
          calls.push(`upnp.map ${req.protocol} ${req.externalPort}`)
          return new Promise((resolve) => (answer = resolve))
        }
      }
    })
    const dir = await tempDir()
    const secrets = createSecretsStore(join(dir, 'secrets.json'), quiet, crypto)
    const { service } = await setup({
      calls,
      secrets,
      io: fakes.io,
      settings: (s) => {
        s.streaming.hostEnabled = true
      }
    })
    await service.start()
    await until(() => calls.includes('upnp.map TCP 47900'))
    const disposing = service.dispose()
    answer!({ leaseSeconds: 0 })
    await disposing
    expect(calls).toContain('upnp.unmap TCP 47900')
    expect(secrets.get().permanentMappings).toEqual([])
  })

  it('removing a client makes Sunshine forget Moonlight pairings, now or at its next start', async () => {
    const calls: string[] = []
    const fakes = hostIo(calls)
    let unpairs = 0
    const { service, settings } = await setup({
      calls,
      io: {
        ...fakes.io,
        createSunshine: () => fakeSunshine(calls, { unpairAll: async () => void unpairs++ })
      },
      settings: (s) => {
        s.streaming.hostEnabled = true
      }
    })
    await service.start()
    await service.idle()
    await service.removeClient('client-1')
    expect(unpairs).toBe(1)
    // The client unpairing itself does the same.
    await fakes.server.deps!.handlers.unpair({
      client: { id: 'client-2', name: 'Attic' },
      address: '192.168.1.30'
    })
    expect(unpairs).toBe(2)

    settings.set((s) => {
      s.streaming.hostEnabled = false
    })
    await service.idle()
    await service.removeClient('client-3')
    expect(unpairs).toBe(2)
    settings.set((s) => {
      s.streaming.hostEnabled = true
    })
    await service.idle()
    expect(unpairs).toBe(3)
  })

  it('refuses a PIN while hosting is off', async () => {
    const { service } = await setup({})
    await service.start()
    await expect(service.startPairing()).rejects.toThrow(/Let other PlayOut computers connect/)
  })
})

describe('host stream hand-off', () => {
  async function hosting(
    io: Partial<StreamingIo> = {}
  ): Promise<Setup & { handlers: HostHandlers; pipe: ReturnType<typeof hostIo>['pipe'] }> {
    const calls: string[] = []
    const fakes = hostIo(calls)
    const games = [
      game({ id: 'steam:1', source: 'steam', title: 'Hades' }),
      game({ id: 'steam:2', source: 'steam', title: 'Other' })
    ]
    const s = await setup({
      calls,
      games,
      io: { ...fakes.io, ...io },
      settings: (st) => {
        st.streaming.hostEnabled = true
      }
    })
    await s.service.start()
    await s.service.idle()
    return { ...s, handlers: fakes.server.deps!.handlers, pipe: fakes.pipe }
  }
  const ctx: RequestContext = {
    client: { id: 'client-1', name: 'Laptop' },
    address: '192.168.1.20'
  }

  it('prepares, runs the armed game through the pipe, and stops it', async () => {
    const h = await hosting()
    const prepared = await h.handlers.prepareStream(ctx, 'steam:1')
    expect(prepared).toEqual({ ok: true, sunshinePort: 47989 })
    const run = await h.pipe.deps!.onRun()
    expect(run).toEqual({ gameId: 'steam:1' })
    // A paired PC's stream: the launch says so (PC Saves then starts it with a saves question open).
    expect(h.launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ id: 'steam:1' }), {
      streamed: true
    })
    expect((await h.service.status()).host.streaming).toEqual({
      clientName: 'Laptop',
      gameId: 'steam:1',
      title: 'Hades'
    })
    // Armed once: a second run without a new prepare starts nothing.
    expect(await h.pipe.deps!.onRun()).toHaveProperty('error')

    h.pipe.active = 'steam:1'
    await h.handlers.stopStream(ctx)
    expect(h.calls).toContain('sunshine.closeApp')
    expect(h.launcher.stop).toHaveBeenCalledWith('steam:1')

    await h.pipe.deps!.onClientGone('steam:1')
    expect((await h.service.status()).host.streaming).toBeNull()
  })

  it("only the client that started a stream can stop it; another client's prepare is busy", async () => {
    const h = await hosting()
    const other: RequestContext = {
      client: { id: 'client-2', name: 'Attic PC' },
      address: '192.168.1.30'
    }
    expect(await h.handlers.prepareStream(ctx, 'steam:1')).toMatchObject({ ok: true })
    // Armed for the laptop: the attic PC neither takes it over nor cancels it.
    expect(await h.handlers.prepareStream(other, 'steam:1')).toMatchObject({
      ok: false,
      error: 'busy'
    })
    await h.handlers.stopStream(other)
    expect(await h.pipe.deps!.onRun()).toEqual({ gameId: 'steam:1' })
    h.pipe.active = 'steam:1'
    expect(await h.handlers.prepareStream(other, 'steam:1')).toMatchObject({ error: 'busy' })
    await h.handlers.stopStream(other)
    expect(h.calls).not.toContain('sunshine.closeApp')
    expect(h.launcher.stop).not.toHaveBeenCalled()
    await h.handlers.stopStream(ctx)
    expect(h.launcher.stop).toHaveBeenCalledWith('steam:1')
  })

  it('forgets the stream when Sunshine closes on its own, and drops its launcher', async () => {
    let sunshineDeps: SunshineDeps | null = null
    const h = await hosting({
      createSunshine: (deps) => {
        sunshineDeps = deps
        return fakeSunshine([])
      }
    })
    const other: RequestContext = {
      client: { id: 'client-2', name: 'Attic PC' },
      address: '192.168.1.30'
    }
    await h.handlers.prepareStream(ctx, 'steam:1')
    expect(await h.pipe.deps!.onRun()).toEqual({ gameId: 'steam:1' })
    expect((await h.service.status()).host.streaming).not.toBeNull()
    expect(await h.handlers.prepareStream(other, 'steam:1')).toMatchObject({ error: 'busy' })

    // Sunshine dies; its launcher stays connected to the pipe (nothing says the client is gone).
    sunshineDeps!.onExit!()
    expect(h.calls).toContain('pipe.dropClient')
    expect((await h.service.status()).host.streaming).toBeNull()
    expect(await h.handlers.prepareStream(other, 'steam:1')).toMatchObject({ ok: true })
  })

  it('answers busy while another game runs, and refuses games it does not offer', async () => {
    const h = await hosting()
    h.launcher.running.mockReturnValue({ gameId: 'steam:2', startedAt: '' })
    expect(await h.handlers.prepareStream(ctx, 'steam:1')).toMatchObject({
      ok: false,
      error: 'busy'
    })
    expect(await h.handlers.prepareStream(ctx, 'steam:99')).toMatchObject({
      ok: false,
      error: 'not-installed'
    })
  })

  it('keeps a launch failure for the client that asked, reports it once, and forgets it after 2 minutes', async () => {
    const clock = { t: Date.parse('2026-11-07T12:00:00Z') }
    const h = await hosting({ now: () => clock.t })
    const other: RequestContext = {
      client: { id: 'client-2', name: 'Attic PC' },
      address: '192.168.1.30'
    }
    const missing: LaunchResult = {
      ok: false,
      error: {
        kind: 'emulator-missing',
        message: 'Mesen (MESEN) is not installed or could not be found'
      }
    }
    h.launcher.launch.mockResolvedValue(missing)
    expect(await h.handlers.streamStatus(ctx)).toEqual({})

    await h.handlers.prepareStream(ctx, 'steam:1')
    expect(await h.pipe.deps!.onRun()).toEqual({
      error: 'Mesen (MESEN) is not installed or could not be found'
    })
    expect((await h.service.status()).host.streaming).toBeNull()
    // Only the client whose start failed sees it, and only once.
    expect(await h.handlers.streamStatus(other)).toEqual({})
    expect(await h.handlers.streamStatus(ctx)).toEqual({
      lastError: {
        gameId: 'steam:1',
        message: 'Mesen (MESEN) is not installed or could not be found'
      }
    })
    expect(await h.handlers.streamStatus(ctx)).toEqual({})

    // Too old to describe what the client just saw.
    await h.handlers.prepareStream(ctx, 'steam:1')
    await h.pipe.deps!.onRun()
    clock.t += 2 * 60_000 + 1
    expect(await h.handlers.streamStatus(ctx)).toEqual({})

    // A new prepare clears an unread failure of the previous start.
    await h.handlers.prepareStream(ctx, 'steam:1')
    await h.pipe.deps!.onRun()
    await h.handlers.prepareStream(ctx, 'steam:1')
    expect(await h.handlers.streamStatus(ctx)).toEqual({})
  })

  it('approves Moonlight only with the PIN the client sent', async () => {
    const h = await hosting()
    expect(await h.handlers.moonlightPair(ctx, undefined)).toMatchObject({ ok: false })
    expect(await h.handlers.moonlightPair(ctx, '4321')).toEqual({ ok: true })
    expect(h.calls).toContain('sunshine.approve 4321')
  })
})

describe('pairing two PCs', () => {
  it('pairs over the real host service, then pairs Moonlight with a fresh PIN', async () => {
    const hostCalls: string[] = []
    const art = join(await tempDir(), 'cover.png')
    await fs.writeFile(art, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
    const hostSide = await setup({
      calls: hostCalls,
      hostName: 'LIVINGROOM',
      games: [
        game({
          id: 'steam:10',
          source: 'steam',
          title: 'Hades',
          media: { cover: 'media://cache/steam_10/cover.png' }
        }),
        game({ id: 'rom:snes:abc', source: 'rom', title: 'Mega Man X', externalId: 'snes/mmx.sfc' })
      ],
      mediaFile: (url) => (url.endsWith('/cover.png') ? art : null),
      io: {
        createDiscoveryResponder: () => ({ start: async () => {}, stop: async () => {} }),
        ensureLaunchToken: async () => 'b'.repeat(64),
        createStreamLaunchServer: () => ({
          listen: async () => {},
          close: async () => {},
          active: () => null,
          dropClient: () => {}
        })
      },
      settings: (s) => {
        s.streaming.hostEnabled = true
        s.streaming.hostPort = 0
      }
    })
    await hostSide.service.start()
    await hostSide.service.idle()
    const host = await hostSide.service.status()
    expect(host.host.state).toBe('ready')
    const port = host.host.port
    expect(port).toBeGreaterThan(0)

    const moonlight = fakeMoonlight()
    const clientSide = await setup({
      hostName: 'LAPTOP',
      io: { createMoonlight: () => moonlight, newPin: () => '4321' }
    })
    await clientSide.service.start()

    await expect(clientSide.service.pairHost(`127.0.0.1:${port}`, '0000')).rejects.toThrow(
      /not showing a PIN/
    )
    const { host: shown } = await hostSide.service.startPairing()
    const pin = shown.pairing!.pin
    const wrong = pin === '1111' ? '2222' : '1111'
    await expect(clientSide.service.pairHost(`127.0.0.1:${port}`, wrong)).rejects.toThrow(
      /Wrong PIN/
    )
    const paired = await clientSide.service.pairHost(`127.0.0.1:${port}`, pin)
    expect(paired).toMatchObject({ name: 'LIVINGROOM', online: true, lanAddress: '127.0.0.1' })

    const clients = (await hostSide.service.status()).host.clients
    expect(clients).toHaveLength(1)
    expect(clients[0].name).toBe('LAPTOP')
    // The PIN is used up.
    expect((await hostSide.service.status()).host.pairing).toBeNull()

    // Moonlight pairs in the background with its own PIN, approved by the host.
    await until(() => hostCalls.includes('sunshine.approve 4321'))
    await until(() => moonlight.paired.has('127.0.0.1'))

    const remote = await clientSide.service.refreshRemoteLibrary()
    expect(remote.games.map((g) => g.title).sort()).toEqual(['Hades', 'Mega Man X'])
    const hades = remote.games.find((g) => g.title === 'Hades')!
    expect(hades.id).toBe(`remote:${paired.id}:steam:10`)
    expect(hades.media.cover).toBe(`media://remote/${paired.id}/steam%3A10/cover`)

    // Art comes through the host connection into the client's cache.
    const file = await clientSide.service.remoteMedia(paired.id, 'steam:10', 'cover')
    expect(file).toMatch(/\.png$/)
    expect(await fs.readFile(file!)).toEqual(await fs.readFile(art))
    expect(await clientSide.service.remoteMedia(paired.id, 'steam:10', 'hero')).toBeNull()

    // The host matched the game again and has another cover: the cache alone would keep the first one for good.
    await fs.writeFile(art, Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]))
    const stale = await clientSide.service.remoteMedia(paired.id, 'steam:10', 'cover')
    expect(stale).toBe(file)
    // With the revision the host's offer names, the image is fetched again and the old file goes.
    const fresh = await clientSide.service.remoteMedia(
      paired.id,
      'steam:10',
      'cover',
      '1800000000000'
    )
    expect(fresh).toMatch(/-cover\.v1800000000000\.png$/)
    expect(await fs.readFile(fresh!)).toEqual(await fs.readFile(art))
    await expect(fs.stat(file!)).rejects.toThrow()
    // The same revision is served from the cache, whatever the host has by now.
    await fs.writeFile(art, Buffer.from([0x89, 0x50, 0x4e, 0x47, 5, 5, 5]))
    const again = await clientSide.service.remoteMedia(
      paired.id,
      'steam:10',
      'cover',
      '1800000000000'
    )
    expect(again).toBe(fresh)
    expect([...(await fs.readFile(again!))].slice(4)).toEqual([9, 9, 9])
    // A revision the host cannot serve (it no longer has the image) keeps showing the last one fetched.
    expect(await clientSide.service.remoteMedia(paired.id, 'steam:10', 'hero', '5')).toBeNull()
    expect(await clientSide.service.remoteMedia(paired.id, 'steam:10', 'cover', '../x')).toBe(fresh)

    // Removing the host also unpairs on the host.
    await clientSide.service.removeHost(paired.id)
    expect((await clientSide.service.status()).client.hosts).toEqual([])
    expect((await hostSide.service.status()).host.clients).toEqual([])
  }, 30_000)
})

/** A host connection over plain objects. */
function fakeConnection(over: Partial<HostConnection> = {}): HostConnection {
  return {
    info: async () => ({
      id: 'host-1',
      name: 'Living Room',
      version: '1',
      fingerprint: 'cd'.repeat(32)
    }),
    library: async () => [],
    scan: async () => {},
    scanRunning: async () => false,
    media: async () => null,
    romFiles: async () => ({ files: [], totalBytes: 0 }),
    downloadFile: async () => {},
    prepareStream: async () => ({ app: 'PlayOut', sunshinePort: 47989 }),
    stopStream: async () => {},
    streamStatus: async () => ({}),
    logins: async () => null,
    moonlightPair: async () => ({ ok: true }),
    unpair: async () => {},
    emulation: {
      manifest: async () => ({
        root: 'R',
        folderId: 'f',
        now: 0,
        files: [],
        unsettled: [],
        linked: [],
        excluded: []
      }),
      download: async () => {},
      uploadChunk: async () => {},
      commit: async () => {},
      remove: async () => {}
    },
    ...over
  }
}

async function pairedSecrets(
  dir: string,
  hosts: { id: string; address: string }[]
): Promise<SecretsStore> {
  const secrets = createSecretsStore(join(dir, 'secrets.json'), quiet, crypto)
  await secrets.load()
  await secrets.update((d) => {
    for (const h of hosts)
      d.hosts.push({
        id: h.id,
        name: h.id === 'host-1' ? 'Living Room' : 'Office',
        fingerprint: 'cd'.repeat(32),
        token: 'token-token-token-token',
        lanAddress: h.address,
        port: 47900,
        pairedAt: '2026-11-01T00:00:00.000Z'
      })
  })
  return secrets
}

function clientIo(connections: Record<string, HostConnection>): HostClient {
  return {
    probe: async () => {
      throw new Error('not used')
    },
    pair: async () => {
      throw new Error('not used')
    },
    connect: ({ address }) =>
      connections[address] ??
      fakeConnection({
        info: async () => {
          throw new Error('ECONNREFUSED')
        }
      })
  }
}

describe('client side', () => {
  it('builds the remote library from the hosts that answer and rebuilds it on library changes', async () => {
    const dir = await tempDir()
    const secrets = await pairedSecrets(dir, [
      { id: 'host-1', address: '192.168.1.5' },
      { id: 'host-2', address: '192.168.1.6' }
    ])
    const offer = [
      game({ id: 'steam:1', source: 'steam', title: 'Hades' }),
      game({ id: 'steam:2', source: 'steam', title: 'Celeste' })
    ].map((g) => ({ ...g, mediaKinds: [] }))
    const games = [game({ id: 'steam:1', source: 'steam', title: 'Hades' })]
    const s = await setup({
      games,
      secrets,
      io: {
        hostClient: clientIo({
          '192.168.1.5': fakeConnection({ library: async () => JSON.parse(JSON.stringify(offer)) })
        })
      }
    })
    const libraries = recorder(s.events, 'streaming:library')
    await s.service.start()
    const remote = await s.service.refreshRemoteLibrary()
    expect(remote.games.map((g) => g.id)).toEqual(['remote:host-1:steam:2'])
    expect(remote.alsoOnHost['steam:1'].map((i) => i.hostId)).toEqual(['host-1'])
    const hosts = (await s.service.status()).client.hosts
    expect(hosts.find((h) => h.id === 'host-1')).toMatchObject({ online: true, games: 2 })
    expect(hosts.find((h) => h.id === 'host-2')).toMatchObject({ online: false })
    expect(hosts.find((h) => h.id === 'host-2')?.error).toMatch(/offline/)

    // The client gets Celeste itself: the remote card goes away without asking the host again.
    games.push(game({ id: 'steam:2', source: 'steam', title: 'Celeste' }))
    const before = libraries.length
    s.events.emit('library:changed', { reason: 'scan' })
    await until(() => libraries.length > before)
    const last = libraries[libraries.length - 1] as RemoteLibrary
    expect(last.games).toEqual([])
    expect(last.alsoOnHost['steam:2'].map((i) => i.hostId)).toEqual(['host-1'])
  })

  it('downloads a ROM into the ROM folder, rescans and reports the local game', async () => {
    const dir = await tempDir()
    const romsRoot = join(dir, 'roms')
    const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
    const content = Buffer.from('0123456789')
    const offer = [
      {
        ...game({
          id: 'rom:snes:mmx',
          source: 'rom',
          title: 'Mega Man X',
          externalId: 'snes/Mega Man X.sfc'
        }),
        mediaKinds: [],
        sizeBytes: 10
      }
    ]
    const games: Game[] = []
    const conn = fakeConnection({
      library: async () => JSON.parse(JSON.stringify(offer)),
      romFiles: async () => ({
        files: [{ path: 'snes/Mega Man X.sfc', size: 10 }],
        totalBytes: 10
      }),
      downloadFile: async (_id, _path, dest, opts) => {
        const part = content.subarray(opts?.from ?? 0)
        await fs.appendFile(dest, part)
        opts?.onBytes?.(part.length)
      }
    })
    const adopt = vi.fn(() => true)
    const s = await setup({
      games,
      secrets,
      settings: (st) => {
        st.library.romsRoot = romsRoot
      },
      io: { hostClient: clientIo({ '192.168.1.5': conn }) },
      remoteView: { adoptRemoteMetadataEdit: adopt }
    })
    s.scan.run.mockImplementation(async () => {
      games.push(
        game({
          id: 'rom:snes:local',
          source: 'rom',
          title: 'Mega Man X',
          externalId: 'snes/Mega Man X.sfc'
        })
      )
    })
    const progress = recorder(s.events, 'streaming:download')
    await s.service.start()
    await s.service.refreshRemoteLibrary()
    await s.service.downloadRemoteRom('remote:host-1:rom:snes:mmx')
    await until(() => progress.some((p) => p.state !== 'downloading'))
    const last = progress[progress.length - 1] as RomDownloadProgress
    expect(last).toMatchObject({ state: 'done', installedGameId: 'rom:snes:local' })
    // The user's edit of the host's copy goes with the downloaded game.
    expect(adopt).toHaveBeenCalledWith('rom:snes:local', 'rom:snes:mmx')
    expect(await fs.readFile(join(romsRoot, 'snes', 'Mega Man X.sfc'))).toEqual(content)
    expect(s.scan.run).toHaveBeenCalledWith(['rom'])
  })

  it("offers a recompilation-only game's original from a host, matched by recompilation title, and downloads it", async () => {
    const dir = await tempDir()
    const romsRoot = join(dir, 'roms')
    const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
    const content = Buffer.from('0123456789')
    const offer = [
      {
        ...game({
          id: 'rom:snes:mmx',
          source: 'rom',
          title: 'Mega Man X',
          externalId: 'snes/Mega Man X.sfc'
        }),
        mediaKinds: [],
        sizeBytes: 10
      },
      // Another game the recompilation is not for.
      {
        ...game({
          id: 'rom:snes:other',
          source: 'rom',
          title: 'Other',
          externalId: 'snes/Other.sfc'
        }),
        mediaKinds: [],
        sizeBytes: 5
      }
    ]
    const applyMetadata = vi.fn(() => undefined)
    // This PC: the recompilation's own card (no game file).
    const card = game({
      id: 'rom:snes:own',
      source: 'rom',
      title: 'Mega Man X',
      externalId: 'Recompilations/snes:mega man x',
      installed: false
    })
    card.extra = { recompOnly: 'snes:mega man x' }
    const games: Game[] = [card]
    const conn = fakeConnection({
      library: async () => JSON.parse(JSON.stringify(offer)),
      romFiles: async () => ({
        files: [{ path: 'snes/Mega Man X.sfc', size: 10 }],
        totalBytes: 10
      }),
      downloadFile: async (_id, _path, dest, opts) => {
        const part = content.subarray(opts?.from ?? 0)
        await fs.appendFile(dest, part)
        opts?.onBytes?.(part.length)
      }
    })
    const s = await setup({
      games,
      secrets,
      settings: (st) => {
        st.library.romsRoot = romsRoot
      },
      io: { hostClient: clientIo({ '192.168.1.5': conn }) },
      recompFor: (g) =>
        g.title === 'Mega Man X'
          ? { titleKey: 'snes:mega man x', count: 1, installed: [], preferred: 'r', updatedAt: '' }
          : null,
      remoteView: { applyMetadata }
    })
    // The file name does not say what it is: the downloaded game takes the host's title.
    s.scan.run.mockImplementation(async () => {
      games.push(
        game({
          id: 'rom:snes:local',
          source: 'rom',
          title: 'mmx-u',
          externalId: 'snes/Mega Man X.sfc'
        })
      )
    })
    const progress = recorder(s.events, 'streaming:download')
    await s.service.start()
    const lib = await s.service.refreshRemoteLibrary()
    expect(lib.recompSources?.['rom:snes:own']).toEqual([
      expect.objectContaining({ hostId: 'host-1', hostGameId: 'rom:snes:mmx', downloadable: true })
    ])
    // Downloadable by its remote: id whether or not it was folded into the card.
    await s.service.downloadRemoteRom('remote:host-1:rom:snes:mmx')
    await until(() => progress.some((p) => p.state !== 'downloading'))
    expect(progress[progress.length - 1]).toMatchObject({
      state: 'done',
      installedGameId: 'rom:snes:local'
    })
    expect(await fs.readFile(join(romsRoot, 'snes', 'Mega Man X.sfc'))).toEqual(content)
    expect(applyMetadata).toHaveBeenCalledWith(
      'rom:snes:local',
      { title: 'Mega Man X' },
      { overwrite: true }
    )
  })

  it("gives the downloaded ROM the host's cover and details before it reports done", async () => {
    const dir = await tempDir()
    const romsRoot = join(dir, 'roms')
    const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
    const offer = [
      {
        ...game({
          id: 'rom:snes:mmx',
          source: 'rom',
          title: 'Mega Man X',
          externalId: 'snes/Mega Man X.sfc'
        }),
        metadata: { description: 'Maverick hunter.' },
        mediaKinds: ['cover', 'hero'],
        sizeBytes: 3
      }
    ]
    const games: Game[] = []
    const conn = fakeConnection({
      library: async () => JSON.parse(JSON.stringify(offer)),
      media: async () => ({ data: Buffer.from('png'), type: 'image/png' }),
      romFiles: async () => ({ files: [{ path: 'snes/Mega Man X.sfc', size: 3 }], totalBytes: 3 }),
      downloadFile: async (_id, _path, dest, opts) => {
        await fs.appendFile(dest, Buffer.from('rom'))
        opts?.onBytes?.(3)
      }
    })
    const imported: { at: number; gameId: string; kinds: string[]; metadata: unknown }[] = []
    let doneAt = -1
    let step = 0
    const s = await setup({
      games,
      secrets,
      settings: (st) => {
        st.library.romsRoot = romsRoot
      },
      importFromHost: async (gameId, update) => {
        imported.push({
          at: step++,
          gameId,
          kinds: update.art.map((a) => a.kind).sort(),
          metadata: update.metadata
        })
      },
      io: { hostClient: clientIo({ '192.168.1.5': conn }) }
    })
    // The ROM scan adds the downloaded game with no art (no internet lookup has found any yet).
    s.scan.run.mockImplementation(async () => {
      if (!games.length)
        games.push(
          game({
            id: 'rom:snes:local',
            source: 'rom',
            title: 'Mega Man X',
            externalId: 'snes/Mega Man X.sfc'
          })
        )
    })
    const progress = recorder(s.events, 'streaming:download')
    s.events.on('streaming:download', (p) => {
      if ((p as RomDownloadProgress).state === 'done' && doneAt < 0) doneAt = step++
    })
    await s.service.start()
    await s.service.refreshRemoteLibrary()
    await s.service.downloadRemoteRom('remote:host-1:rom:snes:mmx')
    await until(() => progress.some((p) => p.state !== 'downloading'))
    expect(progress[progress.length - 1]).toMatchObject({
      state: 'done',
      installedGameId: 'rom:snes:local'
    })
    const forLocal = imported.filter((i) => i.gameId === 'rom:snes:local')
    // The cover and details first, on their own; then the other images.
    expect(forLocal[0]).toMatchObject({
      kinds: ['cover'],
      metadata: { description: 'Maverick hunter.' }
    })
    expect(forLocal[1]).toMatchObject({ kinds: ['hero'], metadata: {} })
    // Copied before the download reported done.
    expect(forLocal[1]!.at).toBeLessThan(doneAt)
  })

  it('scans once more when the first ROM scan (one already running) misses the download', async () => {
    const dir = await tempDir()
    const romsRoot = join(dir, 'roms')
    const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
    const offer = [
      {
        ...game({ id: 'rom:snes:a', source: 'rom', title: 'A', externalId: 'snes/a.sfc' }),
        mediaKinds: []
      }
    ]
    const games: Game[] = []
    const conn = fakeConnection({
      library: async () => JSON.parse(JSON.stringify(offer)),
      romFiles: async () => ({ files: [{ path: 'snes/a.sfc', size: 2 }], totalBytes: 2 }),
      downloadFile: async (_id, _path, dest, opts) => {
        await fs.appendFile(dest, 'ab')
        opts?.onBytes?.(2)
      }
    })
    const s = await setup({
      games,
      secrets,
      settings: (st) => {
        st.library.romsRoot = romsRoot
      },
      io: { hostClient: clientIo({ '192.168.1.5': conn }) }
    })
    let scans = 0
    s.scan.run.mockImplementation(async () => {
      // The first scan walked the folder before the file was there.
      if (++scans === 2)
        games.push(
          game({ id: 'rom:snes:local', source: 'rom', title: 'A', externalId: 'snes/a.sfc' })
        )
    })
    const progress = recorder(s.events, 'streaming:download')
    await s.service.start()
    await s.service.refreshRemoteLibrary()
    await s.service.downloadRemoteRom('remote:host-1:rom:snes:a')
    await until(() => progress.some((p) => p.state !== 'downloading'))
    expect(progress[progress.length - 1]).toMatchObject({
      state: 'done',
      installedGameId: 'rom:snes:local'
    })
    expect(scans).toBe(2)
  })

  it('learns a new LAN address only when the pinned host answers there', async () => {
    const dir = await tempDir()
    const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
    const found = (address: string): FoundHost => ({
      id: 'host-1',
      name: 'Living Room',
      port: 47900,
      fingerprint: 'cd'.repeat(32),
      address
    })
    let answers = [found('192.168.1.66')]
    const s = await setup({
      secrets,
      io: {
        // .66 repeats the host's public id and fingerprint but is not the host (no pinned TLS answer); .77 is.
        hostClient: clientIo({ '192.168.1.77': fakeConnection() }),
        discoverHosts: async () => answers
      }
    })
    await s.service.start()
    await s.service.refreshRemoteLibrary()
    expect((await s.service.status()).client.hosts[0].lanAddress).toBe('192.168.1.5')
    answers = [found('192.168.1.77')]
    await s.service.refreshRemoteLibrary()
    expect((await s.service.status()).client.hosts[0]).toMatchObject({
      lanAddress: '192.168.1.77',
      online: true
    })
  })

  it('asks a host again at once when it answers discovery at its known address (it was still starting)', async () => {
    const dir = await tempDir()
    const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
    // The first try comes while the host's server is still starting; by discovery it is up.
    let up = false
    const host = fakeConnection()
    const s = await setup({
      secrets,
      io: {
        hostClient: clientIo({
          '192.168.1.5': {
            ...host,
            info: async () => {
              if (!up) throw new Error('connect ETIMEDOUT')
              return host.info()
            }
          }
        }),
        discoverHosts: async () => {
          up = true
          return [
            {
              id: 'host-1',
              name: 'Living Room',
              port: 47900,
              fingerprint: 'cd'.repeat(32),
              address: '192.168.1.5'
            }
          ]
        }
      }
    })
    await s.service.start()
    await s.service.refreshRemoteLibrary()
    expect((await s.service.status()).client.hosts[0]).toMatchObject({
      lanAddress: '192.168.1.5',
      online: true
    })
  })

  it('tries an unreachable host again after 30 s, doubling to 2 minutes until it answers, not only every 5 minutes', async () => {
    const dir = await tempDir()
    const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
    let tries = 0
    let up = false
    const host = fakeConnection()
    const s = await setup({
      secrets,
      io: {
        hostClient: clientIo({
          '192.168.1.5': {
            ...host,
            info: async () => {
              tries++
              if (!up) throw new Error('connect ETIMEDOUT')
              return host.info()
            }
          }
        })
      }
    })
    // vi.waitFor moves fake timers on by itself: wait on real I/O with setImmediate (not faked) instead.
    const settle = async (ok: () => boolean | Promise<boolean>): Promise<void> => {
      for (let i = 0; i < 500 && !(await ok()); i++) await new Promise((r) => setImmediate(r))
      expect(await ok()).toBe(true)
    }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    try {
      await s.service.start()
      await settle(() => tries === 1)
      await vi.advanceTimersByTimeAsync(RETRY_FIRST_MS - 1)
      expect(tries).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      await settle(() => tries === 2)
      // Still down: the next try comes after twice as long, then every RETRY_MAX_MS for as long as it takes (a host
      // that waits at the sign-in screen after an update is reached minutes later, not at a 5-minute refresh).
      await vi.advanceTimersByTimeAsync(RETRY_FIRST_MS * 2 - 1)
      expect(tries).toBe(2)
      await vi.advanceTimersByTimeAsync(1)
      await settle(() => tries === 3)
      // (The regular 5-minute refresh may also land in between.)
      for (let n = 0; n < 4; n++) {
        const before = tries
        await vi.advanceTimersByTimeAsync(RETRY_MAX_MS)
        await settle(() => tries > before)
      }
      up = true
      await vi.advanceTimersByTimeAsync(RETRY_MAX_MS)
      await settle(async () => (await s.service.status()).client.hosts[0].online === true)
      // Reached: no more early tries, only the regular refresh.
      const after = tries
      await vi.advanceTimersByTimeAsync(RETRY_FIRST_MS * 4)
      expect(tries).toBe(after)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries only the unreachable host, stops while asleep, starts over at 30 s on waking and ends at quit', async () => {
    const dir = await tempDir()
    const secrets = await pairedSecrets(dir, [
      { id: 'host-1', address: '192.168.1.5' },
      { id: 'host-2', address: '192.168.1.6' }
    ])
    const asked: string[] = []
    let libraries = 0
    const on = fakeConnection({
      info: async () => {
        asked.push('host-1')
        return { id: 'host-1', name: 'Living Room', version: '1', fingerprint: 'cd'.repeat(32) }
      },
      library: async () => {
        libraries++
        return []
      }
    })
    const off = fakeConnection({
      info: async () => {
        asked.push('host-2')
        throw new Error('connect ETIMEDOUT')
      }
    })
    const s = await setup({
      secrets,
      io: { hostClient: clientIo({ '192.168.1.5': on, '192.168.1.6': off }) }
    })
    const settle = async (ok: () => boolean): Promise<void> => {
      for (let i = 0; i < 500 && !ok(); i++) await new Promise((r) => setImmediate(r))
      expect(ok()).toBe(true)
    }
    const count = (id: string): number => asked.filter((a) => a === id).length
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    try {
      await s.service.start()
      await settle(() => count('host-1') === 1 && count('host-2') === 1 && libraries === 1)
      const fetched = libraries
      // The retry asks the switched-off PC again, not the one that answers (nor its games, nor a sync with it).
      await vi.advanceTimersByTimeAsync(RETRY_FIRST_MS)
      await settle(() => count('host-2') === 2)
      expect(count('host-1')).toBe(1)
      expect(libraries).toBe(fetched)
      // Asleep: no retry.
      s.service.suspend()
      await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * 2)
      expect(count('host-2')).toBe(2)
      // Awake: a full refresh at once, then the retries start over at 30 s.
      s.service.resume()
      await settle(() => count('host-2') === 3)
      await vi.advanceTimersByTimeAsync(RETRY_FIRST_MS)
      await settle(() => count('host-2') === 4)
      // Quit: no timer left behind.
      await s.service.dispose()
      const before = asked.length
      await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * 3)
      expect(asked.length).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps the host's internet address current from its info answer, but never a typed name", async () => {
    const dir = await tempDir()
    const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
    let externalIp: string | undefined
    const s = await setup({
      secrets,
      io: {
        hostClient: clientIo({
          '192.168.1.5': fakeConnection({
            info: async () => ({
              id: 'host-1',
              name: 'Living Room',
              version: '1',
              fingerprint: 'cd'.repeat(32),
              externalIp
            })
          })
        })
      }
    })
    await s.service.start()
    // Paired on the LAN before the host's port forwarding worked: no internet address yet.
    await s.service.refreshRemoteLibrary()
    expect(secrets.get().hosts[0].wanAddress).toBeUndefined()
    externalIp = '203.0.113.5'
    await s.service.refreshRemoteLibrary()
    expect(secrets.get().hosts[0].wanAddress).toBe('203.0.113.5')
    // The provider handed out a new IP.
    externalIp = '198.51.100.7'
    await s.service.refreshRemoteLibrary()
    expect((await s.service.status()).client.hosts[0].wanAddress).toBe('198.51.100.7')
    // A private or shared (CGNAT) address is never taken.
    externalIp = '100.64.1.2'
    await s.service.refreshRemoteLibrary()
    expect(secrets.get().hosts[0].wanAddress).toBe('198.51.100.7')
    // A name the user typed stays.
    await secrets.update((d) => {
      d.hosts[0].wanAddress = 'home.example.com'
    })
    externalIp = '198.51.100.9'
    await s.service.refreshRemoteLibrary()
    expect(secrets.get().hosts[0].wanAddress).toBe('home.example.com')
  })

  it('words socket errors for people and keeps other messages', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 192.168.1.20:47900'), {
      code: 'ECONNREFUSED'
    })
    expect(friendlyNetError(refused)).toBe('PlayOut is not accepting connections there')
    expect(friendlyNetError(new Error('getaddrinfo ENOTFOUND gamer.example.com'))).toBe(
      'that computer name was not found'
    )
    expect(friendlyNetError(new Error('connect ETIMEDOUT 203.0.113.5:47900'))).toBe(
      'no answer: is it on and on this network?'
    )
    expect(friendlyNetError(new Error('The host did not answer in time'))).toBe(
      'no answer: is it on and on this network?'
    )
    expect(friendlyNetError(new Error('The host sent an unreadable answer'))).toBe(
      'The host sent an unreadable answer'
    )
  })

  it('Stop during the Moonlight pairing step closes the pair window and ends at once', async () => {
    const dir = await tempDir()
    const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
    const offer = [{ ...game({ id: 'steam:7', source: 'steam', title: 'Hades' }), mediaKinds: [] }]
    const pairWindow = new FakeChild()
    const moonlight = fakeMoonlight({
      pair: async () => ({
        child: pairWindow as unknown as ChildProcess,
        done: new Promise<void>((resolve) => pairWindow.once('close', () => resolve()))
      }),
      isPaired: async () => false
    })
    const s = await setup({
      secrets,
      io: {
        hostClient: clientIo({
          '192.168.1.5': fakeConnection({
            library: async () => JSON.parse(JSON.stringify(offer)),
            // The host waits up to 90 s for Moonlight's request.
            moonlightPair: () => new Promise(() => undefined)
          })
        }),
        createMoonlight: () => moonlight
      }
    })
    const sessions = recorder(s.events, 'streaming:session')
    await s.service.start()
    await s.service.refreshRemoteLibrary()
    const started = s.service.streamGame('remote:host-1:steam:7')
    await until(() => sessions.some((x) => x.state === 'pairing'))
    await s.service.stopStream()
    await started
    expect(pairWindow.exitCode).not.toBeNull()
    expect(sessions[sessions.length - 1].state).toBe('ended')
    // A cancelled pairing is not a pairing failure.
    expect((await s.service.status()).client.hosts[0].error).toBeUndefined()
  })

  it('downloads one game at a time: a second one waits in the install queue', async () => {
    const dir = await tempDir()
    const romsRoot = join(dir, 'roms')
    const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
    const offer = ['a', 'b', 'c'].map((x) => ({
      ...game({
        id: `rom:snes:${x}`,
        source: 'rom',
        title: x.toUpperCase(),
        externalId: `snes/${x}.sfc`
      }),
      mediaKinds: []
    }))
    const release = new Map<string, () => void>()
    const conn = fakeConnection({
      library: async () => JSON.parse(JSON.stringify(offer)),
      romFiles: async (id) => ({
        files: [{ path: `snes/${id.split(':').pop()}.sfc`, size: 1 }],
        totalBytes: 1
      }),
      downloadFile: async (id, _path, dest, opts) => {
        await new Promise<void>((resolve, reject) => {
          release.set(id, resolve)
          opts?.signal?.addEventListener('abort', () => reject(opts.signal?.reason), { once: true })
        })
        await fs.appendFile(dest, 'x')
        opts?.onBytes?.(1)
      }
    })
    const s = await setup({
      secrets,
      settings: (st) => {
        st.library.romsRoot = romsRoot
      },
      io: { hostClient: clientIo({ '192.168.1.5': conn }) }
    })
    const progress = recorder(s.events, 'streaming:download')
    const queued = recorder(s.events, 'installs:queue')
    await s.service.start()
    await s.service.refreshRemoteLibrary()
    await s.service.downloadRemoteRom('remote:host-1:rom:snes:a')
    await s.service.downloadRemoteRom('remote:host-1:rom:snes:b')
    await s.service.downloadRemoteRom('remote:host-1:rom:snes:c')
    await until(() => release.has('rom:snes:a'))
    expect(s.installQueue.list()).toMatchObject([
      { gameId: 'remote:host-1:rom:snes:a', state: 'active', kind: 'host-rom', source: 'host' },
      { gameId: 'remote:host-1:rom:snes:b', state: 'waiting', title: 'B' },
      { gameId: 'remote:host-1:rom:snes:c', state: 'waiting' }
    ])
    expect(queued.at(-1)).toHaveLength(3)
    // Only the active one reports progress; the waiting ones are shown by the queue.
    expect(new Set(progress.map((p) => p.gameId))).toEqual(new Set(['remote:host-1:rom:snes:a']))
    expect(release.has('rom:snes:b')).toBe(false)

    // A waiting one leaves without a word; the next one starts once the first finished.
    await s.service.cancelRemoteRomDownload('remote:host-1:rom:snes:b')
    release.get('rom:snes:a')!()
    await until(() => release.has('rom:snes:c'))
    expect(progress.some((p) => p.gameId === 'remote:host-1:rom:snes:b')).toBe(false)
    expect(s.installQueue.list().map((e) => e.gameId)).toEqual(['remote:host-1:rom:snes:c'])

    // The active one is cancelled.
    await s.service.cancelRemoteRomDownload('remote:host-1:rom:snes:c')
    await until(() =>
      progress.some((p) => p.gameId === 'remote:host-1:rom:snes:c' && p.state === 'cancelled')
    )
    expect(s.installQueue.list()).toEqual([])
  })

  it('reports a queued download whose host no longer offers the game in its turn', async () => {
    const dir = await tempDir()
    const romsRoot = join(dir, 'roms')
    const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
    const s = await setup({
      secrets,
      settings: (st) => {
        st.library.romsRoot = romsRoot
      }
    })
    await s.service.start()
    const store = { start: vi.fn(), reportError: vi.fn() }
    let end: () => void = () => {}
    store.start.mockImplementation(async () => ({
      done: new Promise<void>((resolve) => (end = resolve))
    }))
    s.installQueue.register('store', store)
    await s.installQueue.add({
      gameId: 'steam:1',
      title: 'Portal',
      kind: 'store',
      source: 'steam',
      from: 'Steam'
    })
    // Queued straight into the queue (the host's offer is not checked here, as after a restart).
    await s.installQueue.add({
      gameId: 'remote:host-1:rom:snes:gone',
      title: 'Gone',
      kind: 'host-rom',
      source: 'host',
      from: 'DESKTOP'
    })
    const progress = recorder(s.events, 'streaming:download')
    end()
    await until(() => progress.length > 0)
    expect(progress[0]).toMatchObject({
      gameId: 'remote:host-1:rom:snes:gone',
      hostId: 'host-1',
      state: 'failed'
    })
    expect(progress[0].message).toMatch(/does not offer this game/)
    expect(s.installQueue.list()).toEqual([])
  })

  it('an older stopped download of a game ending late neither cancels nor clears the new one; quitting aborts both', async () => {
    const dir = await tempDir()
    const romsRoot = join(dir, 'roms')
    const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
    const offer = [
      {
        ...game({ id: 'rom:snes:a', source: 'rom', title: 'A', externalId: 'snes/a.sfc' }),
        mediaKinds: []
      }
    ]
    const signals: AbortSignal[] = []
    let releaseOld: () => void = () => {}
    const conn = fakeConnection({
      library: async () => JSON.parse(JSON.stringify(offer)),
      romFiles: async () => ({ files: [{ path: 'snes/a.sfc', size: 1 }], totalBytes: 1 }),
      downloadFile: async (_id, _path, _dest, opts) => {
        signals.push(opts!.signal!)
        // The first download hangs past its abort (a stuck socket); the later ones end when aborted.
        if (signals.length === 1) await new Promise<void>((resolve) => (releaseOld = resolve))
        else
          await new Promise<void>((_resolve, reject) =>
            opts?.signal?.addEventListener('abort', () => reject(opts.signal?.reason), {
              once: true
            })
          )
        throw opts?.signal?.reason ?? new Error('aborted')
      }
    })
    const s = await setup({
      secrets,
      settings: (st) => {
        st.library.romsRoot = romsRoot
      },
      io: { hostClient: clientIo({ '192.168.1.5': conn }) },
      settleWaitMs: 10,
      olderDownloadWaitMs: 10
    })
    const progress = recorder(s.events, 'streaming:download')
    await s.service.start()
    await s.service.refreshRemoteLibrary()
    const id = 'remote:host-1:rom:snes:a'
    await s.service.downloadRemoteRom(id)
    await until(() => signals.length === 1)
    await s.service.cancelRemoteRomDownload(id)
    expect(signals[0].aborted).toBe(true)
    // Added again while the old one is stuck: the new one starts once the bounded waits ran out.
    await s.service.downloadRemoteRom(id)
    await until(() => signals.length === 2)
    const before = progress.length
    releaseOld()
    await new Promise((r) => setTimeout(r, 30))
    // The old job ending says nothing for the game, and the new one is still the game's download.
    expect(progress.slice(before)).toEqual([])
    expect(s.installQueue.list()).toMatchObject([{ gameId: id, state: 'active' }])
    expect(signals[1].aborted).toBe(false)

    // Quitting aborts every live job, the current one included.
    await s.service.dispose()
    expect(signals[1].aborted).toBe(true)
  })

  it('a download whose turn comes before the saved host lists were read waits for them', async () => {
    const dir = await tempDir()
    const romsRoot = join(dir, 'roms')
    const offer = [
      {
        ...game({ id: 'rom:snes:a', source: 'rom', title: 'A', externalId: 'snes/a.sfc' }),
        mediaKinds: []
      }
    ]
    const first = await setup({
      secrets: await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }]),
      dataDir: dir,
      io: {
        hostClient: clientIo({
          '192.168.1.5': fakeConnection({ library: async () => JSON.parse(JSON.stringify(offer)) })
        })
      }
    })
    await first.service.start()
    expect((await first.service.refreshRemoteLibrary()).games).toHaveLength(1)
    await first.service.dispose()

    // The next run: the host does not answer yet, but its saved list is on disk.
    const again = await setup({
      secrets: await pairedSecrets(await tempDir(), [{ id: 'host-1', address: '192.168.1.5' }]),
      dataDir: dir,
      settings: (st) => {
        st.library.romsRoot = romsRoot
      },
      io: { hostClient: clientIo({}) }
    })
    const progress = recorder(again.events, 'streaming:download')
    const id = 'remote:host-1:rom:snes:a'
    // Its turn comes at once, before the service started.
    const adding = again.installQueue.add({
      gameId: id,
      title: 'A',
      kind: 'host-rom',
      source: 'host',
      from: 'Living Room'
    })
    await new Promise((r) => setTimeout(r, 20))
    await again.service.start()
    expect(await adding).toEqual({ position: 0 })
    expect(progress[0]).toMatchObject({ gameId: id, state: 'downloading' })
  })

  it('keeps the downloads of a host that went offline, lets others go on, and goes on when it is back', async () => {
    const dir = await tempDir()
    const romsRoot = join(dir, 'roms')
    const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
    const offer = ['a', 'b'].map((x) => ({
      ...game({
        id: `rom:snes:${x}`,
        source: 'rom',
        title: x.toUpperCase(),
        externalId: `snes/${x}.sfc`
      }),
      mediaKinds: []
    }))
    let up = true
    const started: string[] = []
    const conn = fakeConnection({
      info: async () => {
        if (!up) throw new Error('connect ETIMEDOUT 192.168.1.5:47900')
        return { id: 'host-1', name: 'Living Room', version: '1', fingerprint: 'cd'.repeat(32) }
      },
      library: async () => JSON.parse(JSON.stringify(offer)),
      romFiles: async (id) => ({
        files: [{ path: `snes/${id.split(':').pop()}.sfc`, size: 1 }],
        totalBytes: 1
      }),
      downloadFile: async (id, _path, dest, opts) => {
        started.push(id)
        await fs.appendFile(dest, 'x')
        opts?.onBytes?.(1)
      }
    })
    const s = await setup({
      secrets,
      settings: (st) => {
        st.library.romsRoot = romsRoot
      },
      io: { hostClient: clientIo({ '192.168.1.5': conn }) }
    })
    await s.service.start()
    await s.service.refreshRemoteLibrary()
    // A store install runs first; the host's two downloads wait behind it.
    const store = { start: vi.fn(), reportError: vi.fn() }
    const ends: (() => void)[] = []
    store.start.mockImplementation(async () => ({
      done: new Promise<void>((resolve) => ends.push(resolve))
    }))
    s.installQueue.register('store', store)
    const storeItem = (gameId: string): InstallQueueItem => ({
      gameId,
      title: gameId,
      kind: 'store',
      source: 'steam',
      from: 'Steam'
    })
    await s.installQueue.add(storeItem('steam:1'))
    await s.service.downloadRemoteRom('remote:host-1:rom:snes:a')
    await s.service.downloadRemoteRom('remote:host-1:rom:snes:b')
    await s.installQueue.add(storeItem('steam:2'))
    const progress = recorder(s.events, 'streaming:download')

    // The host goes offline; its turn comes.
    up = false
    ends[0]()
    await until(() => store.start.mock.calls.length === 2)
    // Said once (after its 'downloading'), and both downloads are kept in their order; the store game went on.
    expect(progress.map((p) => p.state)).toEqual(['downloading', 'failed'])
    expect(progress[1]).toMatchObject({
      gameId: 'remote:host-1:rom:snes:a',
      state: 'failed',
      message: hostOfflineMessage('Living Room'),
      hostOffline: true
    })
    expect(s.installQueue.list().map((e) => `${e.gameId}:${e.state}`)).toEqual([
      'steam:2:active',
      'remote:host-1:rom:snes:a:waiting',
      'remote:host-1:rom:snes:b:waiting'
    ])
    expect(started).toEqual([])
    // The UI is told why the host's downloads wait (not the store game simply waiting its turn).
    expect(s.installQueue.list().map((e) => e.waitingFor)).toEqual([
      undefined,
      hostOfflineMessage('Living Room'),
      hostOfflineMessage('Living Room')
    ])
    // The store game ends: nothing is ready, the queue waits (no retry loop against the offline host).
    ends[1]()
    await new Promise((r) => setTimeout(r, 30))
    expect(s.installQueue.activeId()).toBeNull()
    expect(progress).toHaveLength(2)
    // Another refresh that fails changes nothing.
    await s.service.refreshRemoteLibrary()
    await new Promise((r) => setTimeout(r, 30))
    expect(progress).toHaveLength(2)
    expect(s.installQueue.list()).toHaveLength(2)

    // The host answers again: its downloads go on, in order, and the waiting reason is gone.
    up = true
    const lists = recorder(s.events, 'installs:queue')
    await s.service.refreshRemoteLibrary()
    expect(lists[0].map((e) => e.waitingFor)).toEqual([undefined, undefined])
    await until(() => s.installQueue.list().length === 0)
    expect(started).toEqual(['rom:snes:a', 'rom:snes:b'])
    // (Each then ends as the fake ROM scan leaves it; the offline line was said only once.)
    expect(progress.filter((p) => p.message === hostOfflineMessage('Living Room'))).toHaveLength(1)
  })

  it('retries a download whose connection broke off while the host answered, then fails it without holding the host', async () => {
    const dir = await tempDir()
    const romsRoot = join(dir, 'roms')
    const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
    const offer = ['a', 'b'].map((x) => ({
      ...game({
        id: `rom:snes:${x}`,
        source: 'rom',
        title: x.toUpperCase(),
        externalId: `snes/${x}.sfc`
      }),
      mediaKinds: []
    }))
    const tries: string[] = []
    let failA = Infinity
    const conn = fakeConnection({
      library: async () => JSON.parse(JSON.stringify(offer)),
      romFiles: async (id) => ({
        files: [{ path: `snes/${id.split(':').pop()}.sfc`, size: 1 }],
        totalBytes: 1
      }),
      downloadFile: async (id, _path, dest, opts) => {
        tries.push(id)
        if (id === 'rom:snes:a' && tries.filter((t) => t === id).length <= failA)
          throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
        await fs.appendFile(dest, 'x')
        opts?.onBytes?.(1)
      }
    })
    const s = await setup({
      secrets,
      settings: (st) => {
        st.library.romsRoot = romsRoot
      },
      io: { hostClient: clientIo({ '192.168.1.5': conn }) }
    })
    await s.service.start()
    await s.service.refreshRemoteLibrary()
    const progress = recorder(s.events, 'streaming:download')
    await s.service.downloadRemoteRom('remote:host-1:rom:snes:a')
    await s.service.downloadRemoteRom('remote:host-1:rom:snes:b')
    // A keeps breaking off: tried HOST_TRANSFER_ATTEMPTS times in all, then an ordinary failure; B still goes.
    await until(() => tries.includes('rom:snes:b'))
    expect(tries.filter((t) => t === 'rom:snes:a')).toHaveLength(HOST_TRANSFER_ATTEMPTS)
    expect(HOST_TRANSFER_ATTEMPTS).toBe(3)
    const failed = progress.filter(
      (p) => p.state === 'failed' && p.gameId === 'remote:host-1:rom:snes:a'
    )
    expect(failed).toHaveLength(1)
    expect(failed[0].message).toMatch(/^Download failed: .*ECONNRESET/)
    expect(progress.some((p) => p.message === hostOfflineMessage('Living Room'))).toBe(false)
    await until(() => s.installQueue.list().length === 0)

    // A connection that breaks off once is simply tried again and finishes.
    tries.length = 0
    failA = 1
    progress.length = 0
    await s.service.downloadRemoteRom('remote:host-1:rom:snes:a')
    await until(() => s.installQueue.list().length === 0)
    expect(tries).toEqual(['rom:snes:a', 'rom:snes:a'])
    expect(
      progress.some((p) => p.state === 'failed' && /Download failed/.test(p.message ?? ''))
    ).toBe(false)
  })

  it('tells an unreachable host from errors of the game itself', () => {
    expect(isHostUnreachable(new Error('connect ECONNREFUSED 192.168.1.5:47900'))).toBe(true)
    expect(isHostUnreachable(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true)
    expect(isHostUnreachable(new Error('The host did not answer in time'))).toBe(true)
    expect(isHostUnreachable(new HostRequestError(404, 'not-found'))).toBe(false)
    expect(isHostUnreachable(Object.assign(new Error('no space'), { code: 'ENOSPC' }))).toBe(false)
    expect(isHostUnreachable(Object.assign(new Error('gone'), { code: 'ENOENT' }))).toBe(false)
    expect(isHostUnreachable(new Error('Living Room lists no files for this game'))).toBe(false)
  })

  it('pausing a ROM download keeps its partial file and how far it got, and resuming continues from there', async () => {
    const dir = await tempDir()
    const romsRoot = join(dir, 'roms')
    const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
    const content = Buffer.from('0123456789')
    const offer = [
      {
        ...game({
          id: 'rom:snes:mmx',
          source: 'rom',
          title: 'Mega Man X',
          externalId: 'snes/mmx.sfc'
        }),
        mediaKinds: [],
        sizeBytes: 10
      }
    ]
    const games: Game[] = []
    const froms: number[] = []
    let gotFour = false
    const conn = fakeConnection({
      library: async () => JSON.parse(JSON.stringify(offer)),
      romFiles: async () => ({ files: [{ path: 'snes/mmx.sfc', size: 10 }], totalBytes: 10 }),
      downloadFile: async (_id, _path, dest, opts) => {
        const from = opts?.from ?? 0
        froms.push(from)
        if (froms.length === 1) {
          // The first run gets 4 bytes, then hangs until it is stopped.
          await fs.appendFile(dest, content.subarray(0, 4))
          opts?.onBytes?.(4)
          gotFour = true
          await new Promise<void>((_resolve, reject) =>
            opts?.signal?.addEventListener('abort', () => reject(opts.signal?.reason), {
              once: true
            })
          )
        }
        const part = content.subarray(from)
        await fs.appendFile(dest, part)
        opts?.onBytes?.(part.length)
      }
    })
    const s = await setup({
      games,
      secrets,
      settings: (st) => {
        st.library.romsRoot = romsRoot
      },
      io: { hostClient: clientIo({ '192.168.1.5': conn }) }
    })
    s.scan.run.mockImplementation(async () => {
      games.push(
        game({
          id: 'rom:snes:local',
          source: 'rom',
          title: 'Mega Man X',
          externalId: 'snes/mmx.sfc'
        })
      )
    })
    const progress = recorder(s.events, 'streaming:download')
    await s.service.start()
    await s.service.refreshRemoteLibrary()
    const id = 'remote:host-1:rom:snes:mmx'
    await s.service.downloadRemoteRom(id)
    await until(() => gotFour)

    s.installQueue.pause(id)
    await until(() => progress.some((p) => p.state === 'paused'))
    expect(progress.at(-1)).toMatchObject({
      gameId: id,
      hostId: 'host-1',
      state: 'paused',
      bytesDone: 4,
      bytesTotal: 10,
      percent: 40
    })
    expect(progress.some((p) => p.state === 'cancelled' || p.state === 'failed')).toBe(false)
    expect(s.installQueue.list()).toMatchObject([{ gameId: id, state: 'waiting', paused: true }])
    // What it had stays on disk.
    expect(await fs.readFile(join(romsRoot, 'snes', 'mmx.sfc.part'))).toEqual(
      content.subarray(0, 4)
    )

    s.installQueue.resume(id)
    await until(() => progress.some((p) => p.state === 'done'))
    expect(froms).toEqual([0, 4])
    expect(await fs.readFile(join(romsRoot, 'snes', 'mmx.sfc'))).toEqual(content)
    expect(progress.at(-1)).toMatchObject({ state: 'done', installedGameId: 'rom:snes:local' })
    expect(s.installQueue.list()).toEqual([])
  })

  it('removing a host takes its queued downloads out without starting them', async () => {
    const dir = await tempDir()
    const romsRoot = join(dir, 'roms')
    const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
    const offer = ['a', 'b', 'c'].map((x) => ({
      ...game({
        id: `rom:snes:${x}`,
        source: 'rom',
        title: x.toUpperCase(),
        externalId: `snes/${x}.sfc`
      }),
      mediaKinds: []
    }))
    const started: string[] = []
    const conn = fakeConnection({
      library: async () => JSON.parse(JSON.stringify(offer)),
      romFiles: async (id) => ({
        files: [{ path: `snes/${id.split(':').pop()}.sfc`, size: 1 }],
        totalBytes: 1
      }),
      downloadFile: async (id, _path, _dest, opts) => {
        started.push(id)
        await new Promise<void>((_resolve, reject) =>
          opts?.signal?.addEventListener('abort', () => reject(opts.signal?.reason), { once: true })
        )
      }
    })
    const s = await setup({
      secrets,
      settings: (st) => {
        st.library.romsRoot = romsRoot
      },
      io: { hostClient: clientIo({ '192.168.1.5': conn }) }
    })
    const progress = recorder(s.events, 'streaming:download')
    await s.service.start()
    await s.service.refreshRemoteLibrary()
    for (const x of ['a', 'b', 'c'])
      await s.service.downloadRemoteRom(`remote:host-1:rom:snes:${x}`)
    await until(() => started.length === 1)
    await s.service.removeHost('host-1')
    await until(() => progress.some((p) => p.state === 'cancelled'))
    await new Promise((r) => setTimeout(r, 30))
    expect(s.installQueue.list()).toEqual([])
    expect(started).toEqual(['rom:snes:a'])
    // Only the running one speaks (its cancel); the waiting ones never said 'downloading'.
    expect(new Set(progress.map((p) => p.gameId))).toEqual(new Set(['remote:host-1:rom:snes:a']))
    expect(progress.at(-1)?.state).toBe('cancelled')
  })

  it('stops a host that sends more than the listed size, and needs a ROM folder', async () => {
    const dir = await tempDir()
    const romsRoot = join(dir, 'roms')
    const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
    const offer = [
      {
        ...game({ id: 'rom:snes:a', source: 'rom', title: 'A', externalId: 'snes/a.sfc' }),
        mediaKinds: []
      }
    ]
    const conn = fakeConnection({
      library: async () => JSON.parse(JSON.stringify(offer)),
      romFiles: async () => ({ files: [{ path: 'snes/a.sfc', size: 4 }], totalBytes: 4 }),
      downloadFile: async (_id, _path, dest, opts) => {
        for (let i = 0; i < 10; i++) {
          if (opts?.signal?.aborted) throw opts.signal.reason
          await fs.appendFile(dest, 'xx')
          opts?.onBytes?.(2)
        }
      }
    })
    const s = await setup({
      secrets,
      io: { hostClient: clientIo({ '192.168.1.5': conn }) }
    })
    const progress = recorder(s.events, 'streaming:download')
    await s.service.start()
    await s.service.refreshRemoteLibrary()
    await expect(s.service.downloadRemoteRom('remote:host-1:rom:snes:a')).rejects.toThrow(
      /Emulation folder/
    )
    s.settings.set((st) => {
      st.library.romsRoot = romsRoot
    })
    await s.service.downloadRemoteRom('remote:host-1:rom:snes:a')
    await until(() => progress.some((p) => p.state === 'failed'))
    expect(progress.find((p) => p.state === 'failed')?.message).toMatch(/more data/)
  })

  it('streams: preparing, connecting, streaming, ended; PlayOut steps aside meanwhile', async () => {
    const dir = await tempDir()
    const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
    const offer = [{ ...game({ id: 'steam:7', source: 'steam', title: 'Hades' }), mediaKinds: [] }]
    const prepareStream = vi.fn(async () => ({ app: 'PlayOut', sunshinePort: 47989 }))
    const moonlight = fakeMoonlight()
    moonlight.paired.add('192.168.1.5')
    const child = new FakeChild()
    const stream = vi.fn(async () => child as unknown as ChildProcess)
    const s = await setup({
      secrets,
      io: {
        hostClient: clientIo({
          '192.168.1.5': fakeConnection({
            library: async () => JSON.parse(JSON.stringify(offer)),
            prepareStream
          })
        }),
        createMoonlight: () => ({ ...moonlight, stream }),
        streamingAfterMs: 30
      }
    })
    const sessions = recorder(s.events, 'streaming:session')
    await s.service.start()
    await s.service.refreshRemoteLibrary()
    await s.service.streamGame('remote:host-1:steam:7')
    expect(prepareStream).toHaveBeenCalledWith('steam:7')
    expect(stream).toHaveBeenCalledWith(
      '192.168.1.5',
      'PlayOut',
      expect.objectContaining({ screen: { width: 2560, height: 1440 }, displayMode: 'fullscreen' })
    )
    expect(s.window.minimize).toHaveBeenCalled()
    await until(() => sessions.some((x) => x.state === 'streaming'))
    child.finish(0)
    await until(() => sessions.some((x) => x.state === 'ended'))
    expect(sessions.map((x: StreamSession) => x.state)).toEqual([
      'preparing',
      'connecting',
      'streaming',
      'ended'
    ])
    expect(s.window.restore).toHaveBeenCalled()
  })

  it('reports Moonlight closing early as an error, and a busy host as a rejection', async () => {
    const dir = await tempDir()
    const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
    const offer = [{ ...game({ id: 'steam:7', source: 'steam', title: 'Hades' }), mediaKinds: [] }]
    const moonlight = fakeMoonlight()
    moonlight.paired.add('192.168.1.5')
    const child = new FakeChild()
    let busy = false
    const s = await setup({
      secrets,
      io: {
        hostClient: clientIo({
          '192.168.1.5': fakeConnection({
            library: async () => JSON.parse(JSON.stringify(offer)),
            prepareStream: async () => {
              if (!busy) return { app: 'PlayOut', sunshinePort: 47989 }
              const { HostRequestError } = await import('./host-client')
              throw new HostRequestError(409, 'busy', 'Living Room is already running another game')
            }
          })
        }),
        createMoonlight: () => ({ ...moonlight, stream: async () => child as never }),
        streamingAfterMs: 5_000
      }
    })
    const sessions = recorder(s.events, 'streaming:session')
    await s.service.start()
    await s.service.refreshRemoteLibrary()
    await s.service.streamGame('remote:host-1:steam:7')
    child.stderr.emit('data', Buffer.from('info: starting\nError: connection to host refused\n'))
    child.finish(1)
    await until(() => sessions.some((x) => x.state === 'error'))
    expect(sessions[sessions.length - 1].message).toContain('connection to host refused')

    busy = true
    await expect(s.service.streamGame('remote:host-1:steam:7')).rejects.toThrow(
      /already running another game/
    )
  })

  describe("the host's launch failure", () => {
    async function streaming(
      streamStatus: HostConnection['streamStatus'],
      streamingAfterMs: number
    ): Promise<{ sessions: StreamSession[]; child: FakeChild }> {
      const dir = await tempDir()
      const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
      const offer = [
        { ...game({ id: 'rom:nes/Zelda', source: 'rom', title: 'Zelda' }), mediaKinds: [] }
      ]
      const moonlight = fakeMoonlight()
      moonlight.paired.add('192.168.1.5')
      const child = new FakeChild()
      const s = await setup({
        secrets,
        io: {
          hostClient: clientIo({
            '192.168.1.5': fakeConnection({
              library: async () => JSON.parse(JSON.stringify(offer)),
              streamStatus
            })
          }),
          createMoonlight: () => ({ ...moonlight, stream: async () => child as never }),
          streamingAfterMs
        }
      })
      const sessions = recorder(s.events, 'streaming:session')
      await s.service.start()
      await s.service.refreshRemoteLibrary()
      await s.service.streamGame('remote:host-1:rom:nes/Zelda')
      return { sessions, child }
    }
    const failure = {
      lastError: {
        gameId: 'rom:nes/Zelda',
        message: 'Mesen (MESEN) is not installed or could not be found'
      }
    }

    it('turns a stream that closes after it seemed to start into an error with the reason', async () => {
      const { sessions, child } = await streaming(async () => failure, 30)
      await until(() => sessions.some((x) => x.state === 'streaming'))
      child.finish(0)
      await until(() => sessions.some((x) => x.state === 'error'))
      expect(sessions.map((x) => x.state)).toEqual([
        'preparing',
        'connecting',
        'streaming',
        'error'
      ])
      expect(sessions[sessions.length - 1].message).toBe(
        'The host could not start the game: Mesen (MESEN) is not installed or could not be found'
      )
    })

    it("prefers the host's reason over Moonlight's when Moonlight closes at once", async () => {
      const { sessions, child } = await streaming(async () => failure, 5_000)
      child.stderr.emit('data', Buffer.from('Error: the host closed the connection\n'))
      child.finish(1)
      await until(() => sessions.some((x) => x.state === 'error'))
      expect(sessions[sessions.length - 1].message).toMatch(
        /^The host could not start the game: Mesen/
      )
    })

    it('ends normally when the failure is for another game, or the host does not answer', async () => {
      const other = await streaming(
        async () => ({ lastError: { gameId: 'steam:9', message: 'nope' } }),
        30
      )
      await until(() => other.sessions.some((x) => x.state === 'streaming'))
      other.child.finish(0)
      await until(() => other.sessions.some((x) => x.state === 'ended'))
      expect(other.sessions.some((x) => x.state === 'error')).toBe(false)

      const down = await streaming(async () => {
        throw new Error('ECONNREFUSED')
      }, 30)
      await until(() => down.sessions.some((x) => x.state === 'streaming'))
      down.child.finish(0)
      await until(() => down.sessions.some((x) => x.state === 'ended'))
      expect(down.sessions.some((x) => x.state === 'error')).toBe(false)
    })
  })
})

describe('the library over the internet, one way, and Scan', () => {
  const offerOf = (...titles: string[]): unknown[] =>
    titles.map((title, i) => ({
      ...game({ id: `steam:${i + 1}`, source: 'steam', title }),
      mediaKinds: []
    }))

  it("matches host-only games with this PC's recompilation catalogs (Filters > Recompilations)", async () => {
    const dir = await tempDir()
    const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
    const hostsMatch = {
      titleKey: 'pc:host',
      count: 9,
      installed: ['x'],
      preferred: 'x',
      updatedAt: ''
    }
    const conn = fakeConnection({
      info: async () => ({
        id: 'host-1',
        name: 'Living Room',
        version: '1',
        fingerprint: 'cd'.repeat(32)
      }),
      library: async () => [
        { ...game({ id: 'steam:1', source: 'steam', title: 'Doom 64' }), mediaKinds: [] },
        {
          ...game({ id: 'steam:2', source: 'steam', title: 'Celeste' }),
          metadata: { recomp: hostsMatch },
          mediaKinds: []
        },
        {
          ...game({ id: 'steam:3', source: 'steam', title: 'Unknown Yet' }),
          metadata: { recomp: hostsMatch },
          mediaKinds: []
        }
      ]
    })
    const mine = { titleKey: 'n64:doom 64', count: 2, installed: [], preferred: 'a', updatedAt: '' }
    let loaded = false
    const s = await setup({
      secrets,
      dataDir: dir,
      io: { hostClient: clientIo({ '192.168.1.5': conn }) },
      recompFor: (g) =>
        !loaded
          ? undefined
          : g.title === 'Doom 64'
            ? mine
            : g.title === 'Unknown Yet'
              ? undefined
              : null
    })
    await s.service.start()
    let lib = await s.service.refreshRemoteLibrary()
    const recompOf = (title: string): unknown =>
      lib.games.find((g) => g.title === title)?.metadata.recomp
    // Catalogs not loaded yet: none (a host's own match never comes through: its installed versions are not ours).
    expect(recompOf('Doom 64')).toBeUndefined()
    expect(recompOf('Celeste')).toBeUndefined()
    // Loaded: this PC's match.
    loaded = true
    const libraries = recorder(s.events, 'streaming:library')
    s.events.emit('recomp:changed', { ids: [] })
    await until(() => libraries.length > 0)
    lib = await s.service.remoteLibrary()
    expect(recompOf('Doom 64')).toEqual(mine)
    expect(recompOf('Celeste')).toBeUndefined()
    expect(recompOf('Unknown Yet')).toBeUndefined()
  })

  it("shows host-only games through this PC's edits and builds them again when an edit is saved", async () => {
    const dir = await tempDir()
    const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
    const conn = fakeConnection({
      info: async () => ({
        id: 'host-1',
        name: 'Living Room',
        version: '1',
        fingerprint: 'cd'.repeat(32)
      }),
      library: async () => offerOf('Hades', 'Celeste')
    })
    let suffix = ''
    let notify = null as (() => void) | null
    const s = await setup({
      secrets,
      dataDir: dir,
      io: { hostClient: clientIo({ '192.168.1.5': conn }) },
      remoteView: {
        viewRemote: (g) => ({ ...g, user: { titleOverride: `${g.title}${suffix}` } }),
        onRemoteViewChange: (listener) => {
          notify = listener
          return () => {
            notify = null
          }
        }
      }
    })
    await s.service.start()
    const lib = await s.service.refreshRemoteLibrary()
    const hades = lib.games.find((g) => g.title === 'Hades')!
    expect(hades.user.titleOverride).toBe('Hades')
    // The host's own copy (the Edit sheet's "scraped" layer) has none of this PC's edits.
    const base = await s.service.remoteGameBase(hades.id)
    expect(base?.user).toEqual({})
    expect(await s.service.remoteGameBase('remote:host-1:nope')).toBeUndefined()
    // A saved edit shows at once (no request to the host).
    suffix = ' (mine)'
    const libraries = recorder(s.events, 'streaming:library')
    expect(notify).not.toBeNull()
    notify!()
    expect(libraries.length).toBe(1)
    const shown = (await s.service.remoteLibrary()).games.find((g) => g.id === hades.id)
    expect(shown?.user.titleOverride).toBe('Hades (mine)')
  })

  it("keeps a host's last games when it stops answering, and shows them after a restart", async () => {
    const dir = await tempDir()
    const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
    let up = true
    const conn = fakeConnection({
      info: async () => {
        if (!up) throw new Error('ETIMEDOUT')
        return { id: 'host-1', name: 'Living Room', version: '1', fingerprint: 'cd'.repeat(32) }
      },
      library: async () => offerOf('Hades', 'Celeste')
    })
    const s = await setup({
      secrets,
      dataDir: dir,
      io: { hostClient: clientIo({ '192.168.1.5': conn }) }
    })
    await s.service.start()
    expect((await s.service.refreshRemoteLibrary()).games).toHaveLength(2)
    up = false
    const stale = await s.service.refreshRemoteLibrary()
    expect(stale.games.map((g) => g.title)).toEqual(['Hades', 'Celeste'])
    // Marked as what the host offered when last reached.
    expect(stale.games[0]?.remote?.offline).toBe(true)
    expect((await s.service.status()).client.hosts[0]).toMatchObject({ online: false })
    // The offer is written in the background after the fetch: the restart below must find it on disk.
    const saved = join(dir, 'offers', 'host-1.json')
    let written = false
    await until(() => {
      void fs.stat(saved).then(
        () => (written = true),
        () => undefined
      )
      return written
    })

    // A restart away from the host: its last games show at once, from disk.
    const again = await setup({
      secrets: await pairedSecrets(await tempDir(), [{ id: 'host-1', address: '192.168.1.5' }]),
      dataDir: dir,
      io: { hostClient: clientIo({}) }
    })
    await again.service.start()
    expect((await again.service.remoteLibrary()).games.map((g) => g.title)).toEqual([
      'Hades',
      'Celeste'
    ])
  })

  it('takes no games from a computer that is also its client, and will not pair the other way', async () => {
    const dir = await tempDir()
    const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
    await secrets.update((d) => {
      d.clients.push({
        id: 'host-1',
        name: 'Living Room',
        tokenHash: 'ab'.repeat(32),
        pairedAt: '2026-11-01T00:00:00.000Z'
      } as never)
    })
    const library = vi.fn(async () => offerOf('Hades'))
    const unpair = vi.fn(async () => {})
    const hostClient = clientIo({ '192.168.1.5': fakeConnection({ library, unpair }) })
    hostClient.pair = async () =>
      ({
        hostId: 'host-1',
        hostName: 'Living Room',
        token: 't'.repeat(32),
        fingerprint: 'cd'.repeat(32)
      }) as never
    const s = await setup({ secrets, io: { hostClient } })
    await s.service.start()
    expect((await s.service.refreshRemoteLibrary()).games).toEqual([])
    expect(library).not.toHaveBeenCalled()
    expect((await s.service.status()).client.hosts[0]?.error).toMatch(/also a client of this PC/)
    await expect(s.service.pairHost('192.168.1.5', '1234')).rejects.toThrow(/client of this PC/)
    expect(unpair).toHaveBeenCalled()
  })

  it("a client's Scan has the host rescan, waits for it, then takes its new games", async () => {
    const dir = await tempDir()
    const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
    let scanned = false
    let polls = 0
    const conn = fakeConnection({
      library: async () => (scanned ? offerOf('Hades', 'Celeste') : offerOf('Hades')),
      scan: async () => {},
      scanRunning: async () => {
        polls++
        if (polls < 2) return true
        scanned = true
        return false
      }
    })
    const s = await setup({ secrets, io: { hostClient: clientIo({ '192.168.1.5': conn }) } })
    await s.service.start()
    expect((await s.service.refreshRemoteLibrary()).games).toHaveLength(1)
    await s.service.scanHosts()
    expect(polls).toBe(2)
    expect((await s.service.remoteLibrary()).games.map((g) => g.title)).toEqual([
      'Hades',
      'Celeste'
    ])
  })

  it("sets a host's internet address, refusing a local one", async () => {
    const dir = await tempDir()
    const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
    const s = await setup({ secrets, io: { hostClient: clientIo({}) } })
    await s.service.start()
    await expect(s.service.setHostAddress('host-1', '192.168.1.99')).rejects.toThrow(
      /local network/
    )
    // One port for both addresses: a different one outside would break the local one.
    await expect(s.service.setHostAddress('host-1', 'home.example.net:47950')).rejects.toThrow(
      /port 47900/
    )
    const status = await s.service.setHostAddress('host-1', 'home.example.net')
    expect(status.client.hosts[0]).toMatchObject({ wanAddress: 'home.example.net', port: 47900 })
    expect(
      (await s.service.setHostAddress('host-1', null)).client.hosts[0]?.wanAddress
    ).toBeUndefined()
  })

  it("looks up this PC's internet address when the router forwards nothing automatically", async () => {
    const calls: string[] = []
    const fakes = hostIo(calls)
    const { service } = await setup({
      calls,
      io: {
        ...fakes.io,
        upnp: { discover: async () => null },
        publicIp: async () => '203.0.113.7'
      },
      settings: (st) => {
        st.streaming.hostEnabled = true
      }
    })
    await service.start()
    await service.idle()
    expect((await service.status()).host.portForwarding).toMatchObject({
      state: 'unavailable',
      externalIp: '203.0.113.7'
    })
  })
})

describe('copying from the hosts', () => {
  it("fills this PC's own games from the host's copy and fetches every host game's art, covers first", async () => {
    const dir = await tempDir()
    const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
    const offer = [
      {
        ...game({ id: 'steam:1', source: 'steam', title: 'Hades' }),
        metadata: {
          description: 'Escape the underworld.',
          genres: ['Roguelike'],
          hltb: { main: 22 }
        },
        mediaKinds: ['cover', 'logo']
      },
      {
        ...game({ id: 'steam:2', source: 'steam', title: 'Celeste' }),
        mediaKinds: ['hero', 'cover']
      }
    ]
    const asked: string[] = []
    const conn = fakeConnection({
      library: async () => JSON.parse(JSON.stringify(offer)),
      media: async (gameId, kind) => {
        asked.push(`${gameId}/${kind}`)
        return { data: Buffer.from('png'), type: 'image/png' }
      }
    })
    // This PC has Hades already, with its own logo and genres but no cover or description.
    const mine = game({ id: 'steam:1', source: 'steam', title: 'Hades' })
    mine.metadata = { genres: ['Action'] }
    mine.media = { logo: 'media://cache/steam_1/logo.png' }
    const importFromHost = vi.fn(async () => {})
    const s = await setup({
      secrets,
      games: [mine],
      importFromHost,
      io: { hostClient: clientIo({ '192.168.1.5': conn }) }
    })
    const progress = recorder(s.events, 'host-sync:progress')
    await s.service.start()
    await s.service.refreshRemoteLibrary()
    await until(() => progress.length > 1 && progress[progress.length - 1]!.total === 0)
    expect(importFromHost).toHaveBeenCalledTimes(1)
    const [gameId, update] = importFromHost.mock.calls[0] as unknown as [
      string,
      { metadata: Record<string, unknown>; art: { kind: string; file: string }[] }
    ]
    expect(gameId).toBe('steam:1')
    // Only what this PC lacks: the description and times, not its own genres; the cover, not its own logo.
    expect(update.metadata).toEqual({ description: 'Escape the underworld.', hltb: { main: 22 } })
    expect(update.art.map((a) => a.kind)).toEqual(['cover'])
    // The host-only game's art, every kind it has (fetched several at once).
    const celeste = asked.filter((a) => a.startsWith('steam:2/')).sort()
    expect(celeste).toEqual(['steam:2/cover', 'steam:2/hero'])
    // One game filled and two images fetched.
    expect(progress.some((p) => p.total === 3)).toBe(true)
  })
})

describe('copying from the hosts: an image the host lists anew but does not serve', () => {
  it('is asked for once, not on every pass, while the earlier image stands in for it', async () => {
    const dir = await tempDir()
    const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
    let rev = '1'
    let serves = true
    const asked: string[] = []
    const conn = fakeConnection({
      library: async () => [
        {
          ...game({ id: 'steam:2', source: 'steam', title: 'Celeste' }),
          mediaKinds: ['cover'],
          mediaRevs: { cover: rev }
        }
      ],
      media: async (gameId, kind) => {
        asked.push(`${gameId}/${kind}`)
        return serves ? { data: Buffer.from('png'), type: 'image/png' } : null
      }
    })
    const s = await setup({ secrets, io: { hostClient: clientIo({ '192.168.1.5': conn }) } })
    const progress = recorder(s.events, 'host-sync:progress')
    const pass = async (): Promise<void> => {
      const from = progress.length
      await s.service.refreshRemoteLibrary()
      await until(() => progress.length > from && progress[progress.length - 1]!.total === 0)
    }
    await s.service.start()
    await pass()
    expect(asked).toEqual(['steam:2/cover'])
    const first = await s.service.remoteMedia('host-1', 'steam:2', 'cover', '1')
    expect(first).toMatch(/-cover\.v1\.png$/)
    expect(isMediaRevision(first!, '1')).toBe(true)
    // The host matched the game again (another cover) but cannot serve it right now.
    rev = '2'
    serves = false
    await pass()
    expect(asked).toHaveLength(2)
    // The card still shows the earlier image, known to be a stand-in (media-protocol.ts does not let it be cached).
    const shown = await s.service.remoteMedia('host-1', 'steam:2', 'cover', '2')
    expect(shown).toBe(first)
    expect(isMediaRevision(shown!, '2')).toBe(false)
    const before = asked.length
    await pass()
    await pass()
    expect(asked).toHaveLength(before)
  })
})

describe('copying from the hosts, only for the same game', () => {
  it("never fills a game from another store's game of the same title when a year is unknown", async () => {
    const dir = await tempDir()
    const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
    const offer = [
      {
        ...game({ id: 'steam:379720', source: 'steam', title: 'DOOM' }),
        metadata: { description: 'The 2016 one.', releaseDate: '2016-05-13' },
        mediaKinds: ['cover']
      }
    ]
    const conn = fakeConnection({
      library: async () => JSON.parse(JSON.stringify(offer)),
      media: async () => ({ data: Buffer.from('png'), type: 'image/png' })
    })
    // This PC's DOOM is GOG's 1993 game, not looked up yet (no year).
    const mine = game({ id: 'gog:doom', source: 'gog', title: 'DOOM' })
    const importFromHost = vi.fn(async () => {})
    const s = await setup({
      secrets,
      games: [mine],
      importFromHost,
      io: { hostClient: clientIo({ '192.168.1.5': conn }) }
    })
    await s.service.start()
    const remote = await s.service.refreshRemoteLibrary()
    expect(remote.alsoOnHost['gog:doom']).toBeDefined()
    await new Promise((r) => setTimeout(r, 50))
    expect(importFromHost).not.toHaveBeenCalled()
  })
})

describe('the Emulation folder sync', () => {
  const ctx: RequestContext = {
    client: { id: 'client-1', name: 'Laptop' },
    address: '192.168.1.30'
  }

  it('the host answers only with the setting on and no game running', async () => {
    const calls: string[] = []
    const { io, server } = hostIo(calls)
    const emu = await tempDir()
    await fs.mkdir(join(emu, 'saves'), { recursive: true })
    await fs.writeFile(join(emu, 'saves', 'a.srm'), 'save')
    await fs.mkdir(join(emu, 'roms'), { recursive: true })
    await fs.writeFile(join(emu, 'roms', 'game.chd'), 'rom')
    const s = await setup({
      io,
      calls,
      emulationDir: emu,
      settings: (x) => (x.streaming.hostEnabled = true)
    })
    await s.service.start()
    await s.service.idle()
    const handlers = server.deps!.handlers
    const manifest = await handlers.emulationManifest(ctx)
    expect(manifest.files.map((f) => f.path)).toEqual(['saves/a.srm'])

    s.launcher.running.mockReturnValue({ gameId: 'rom:psx:x', startedAt: '' })
    await expect(handlers.emulationManifest(ctx)).rejects.toMatchObject({
      status: 409,
      code: 'busy'
    })
    s.launcher.running.mockReturnValue(null)
    s.settings.set((x) => (x.streaming.syncEmulation = false))
    await expect(handlers.emulationManifest(ctx)).rejects.toMatchObject({
      status: 403,
      code: 'sync-off'
    })
  })

  it('a client syncs with each reachable host after a refresh and reports how it went', async () => {
    const dir = await tempDir()
    const emu = await tempDir()
    const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
    const asked = vi.fn(async () => ({
      root: 'D:\\Emulation',
      folderId: 'host-folder',
      now: Date.now(),
      files: [],
      unsettled: [],
      linked: [],
      excluded: []
    }))
    const conn = fakeConnection()
    conn.emulation.manifest = asked
    const s = await setup({
      secrets,
      emulationDir: emu,
      io: { hostClient: clientIo({ '192.168.1.5': conn }) }
    })
    await s.service.start()
    await s.service.refreshRemoteLibrary()
    await until(() => asked.mock.calls.length > 0)
    await vi.waitFor(async () => {
      const host = (await s.service.status()).client.hosts[0]!
      expect(host.emulationSync?.state).toBe('synced')
      expect(host.emulationSync?.last).toMatchObject({ downloaded: 0, uploaded: 0 })
    })

    // The host refusing (a game running there) is shown as waiting, not as an error.
    conn.emulation.manifest = async () => {
      throw new HostRequestError(409, 'busy')
    }
    await s.service.refreshRemoteLibrary()
    await vi.waitFor(async () => {
      const host = (await s.service.status()).client.hosts[0]!
      expect(host.emulationSync).toMatchObject({
        state: 'waiting',
        message: 'a game is running on Living Room'
      })
      expect(host.emulationSync?.lastSync).toBeDefined()
    })
  })

  it('a client does not sync while a game runs on it', async () => {
    const dir = await tempDir()
    const emu = await tempDir()
    const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
    const conn = fakeConnection()
    const asked = vi.fn(conn.emulation.manifest)
    conn.emulation.manifest = asked
    const s = await setup({
      secrets,
      emulationDir: emu,
      io: { hostClient: clientIo({ '192.168.1.5': conn }) }
    })
    s.launcher.running.mockReturnValue({ gameId: 'rom:psx:x', startedAt: '' })
    await s.service.start()
    await s.service.refreshRemoteLibrary()
    await vi.waitFor(async () => {
      const host = (await s.service.status()).client.hosts[0]!
      expect(host.emulationSync).toMatchObject({ state: 'waiting' })
    })
    expect(asked).not.toHaveBeenCalled()
  })
})

describe("a PS3 game's updates and DLC", () => {
  it('the host offers what RPCS3 installed for the game in the PS3 HDD with it', async () => {
    const calls: string[] = []
    const { io, server } = hostIo(calls)
    const emu = await tempDir()
    const roms = join(emu, 'roms')
    await fs.mkdir(join(roms, 'ps3', 'Game.ps3'), { recursive: true })
    await fs.writeFile(join(roms, 'ps3', 'Game.ps3', 'Game.ps3'), 'BLUS30443')
    const dev0 = join(emu, 'Updates and DLC', 'PS3', 'dev_hdd0')
    await fs.mkdir(join(dev0, 'game', 'BLUS30443', 'USRDIR'), { recursive: true })
    await fs.writeFile(join(dev0, 'game', 'BLUS30443', 'USRDIR', 'EBOOT.BIN'), 'update')
    await fs.mkdir(join(dev0, 'game', 'BLUS99999'), { recursive: true })
    await fs.writeFile(join(dev0, 'game', 'BLUS99999', 'PARAM.SFO'), 'other')
    const ps3 = game({
      id: 'rom:ps3:g',
      source: 'rom',
      title: 'Game',
      externalId: 'ps3/Game.ps3',
      platformId: 'ps3',
      launch: { kind: 'emulator', systemId: 'ps3', romPath: join(roms, 'ps3', 'Game.ps3') }
    })
    const s = await setup({
      io,
      calls,
      games: [ps3],
      emulationDir: emu,
      settings: (x) => {
        x.streaming.hostEnabled = true
        x.library.romsRoot = roms
      }
    })
    await s.service.start()
    await s.service.idle()
    const handlers = server.deps!.handlers
    const ctx = { client: { id: 'client-1', name: 'Laptop' }, address: '192.168.1.30' }
    const set = await handlers.romFiles(ctx, 'rom:ps3:g', { ps3Hdd: true })
    expect(set?.files.map((f) => f.path)).toEqual([
      'ps3/Game.ps3/Game.ps3',
      'PS3 HDD/dev_hdd0/game/BLUS30443/USRDIR/EBOOT.BIN'
    ])
    expect(set?.totalBytes).toBe(9 + 6)
    expect(set?.files[1]?.mtimeMs).toEqual(expect.any(Number))
    // An older client (no ?with=ps3-hdd) gets the game alone: it would put these where its RPCS3 never looks.
    expect(await handlers.romFiles(ctx, 'rom:ps3:g')).toEqual({
      files: [{ path: 'ps3/Game.ps3/Game.ps3', size: 9 }],
      totalBytes: 9
    })
    // Only the game's own folders and licenses: never the savedata junction.
    expect(
      await handlers.romFile(ctx, 'rom:ps3:g', 'PS3 HDD/dev_hdd0/home/00000001/savedata/x')
    ).toBeNull()
    expect(
      await handlers.romFile(ctx, 'rom:ps3:g', 'PS3 HDD/dev_hdd0/game/BLUS30443/USRDIR/EBOOT.BIN')
    ).toBe(join(dev0, 'game', 'BLUS30443', 'USRDIR', 'EBOOT.BIN'))
    expect(
      await handlers.romFile(ctx, 'rom:ps3:g', 'PS3 HDD/dev_hdd0/game/BLUS99999/PARAM.SFO')
    ).toBeNull()
    // Once RPCS3 uses the new place (its marker), a leftover old roms\PS3 HDD is not offered.
    await markPs3HddInUse(emu)
    const oldDev0 = join(roms, 'PS3 HDD', 'dev_hdd0')
    await fs.mkdir(join(oldDev0, 'game', 'BLUS30443'), { recursive: true })
    await fs.writeFile(join(oldDev0, 'game', 'BLUS30443', 'OLD.BIN'), 'old')
    expect(
      await handlers.romFile(ctx, 'rom:ps3:g', 'PS3 HDD/dev_hdd0/game/BLUS30443/OLD.BIN')
    ).toBeNull()
  })

  it('the host offers the old roms\\PS3 HDD before the move and the new place after it', async () => {
    const calls: string[] = []
    const { io, server } = hostIo(calls)
    const clock = { t: Date.parse('2026-11-15T12:00:00Z') }
    const emu = await tempDir()
    const roms = join(emu, 'roms')
    await fs.mkdir(join(roms, 'ps3', 'Game.ps3'), { recursive: true })
    await fs.writeFile(join(roms, 'ps3', 'Game.ps3', 'Game.ps3'), 'BLUS30443')
    // Before RPCS3's configure moved it: the old folder holds the update, the new place (made at start-up) is empty.
    const oldDev0 = join(roms, 'PS3 HDD', 'dev_hdd0')
    await fs.mkdir(join(oldDev0, 'game', 'BLUS30443'), { recursive: true })
    await fs.writeFile(join(oldDev0, 'game', 'BLUS30443', 'OLD.BIN'), 'old!')
    const newDev0 = join(emu, 'Updates and DLC', 'PS3', 'dev_hdd0')
    await fs.mkdir(join(newDev0, 'game'), { recursive: true })
    const ps3 = game({
      id: 'rom:ps3:g',
      source: 'rom',
      title: 'Game',
      externalId: 'ps3/Game.ps3',
      platformId: 'ps3',
      launch: { kind: 'emulator', systemId: 'ps3', romPath: join(roms, 'ps3', 'Game.ps3') }
    })
    const s = await setup({
      io: { ...io, now: () => clock.t },
      calls,
      games: [ps3],
      emulationDir: emu,
      settings: (x) => {
        x.streaming.hostEnabled = true
        x.library.romsRoot = roms
      }
    })
    await s.service.start()
    await s.service.idle()
    const handlers = server.deps!.handlers
    const ctx = { client: { id: 'client-1', name: 'Laptop' }, address: '192.168.1.30' }
    const oldPath = 'PS3 HDD/dev_hdd0/game/BLUS30443/OLD.BIN'
    const newPath = 'PS3 HDD/dev_hdd0/game/BLUS30443/NEW.BIN'
    expect(
      (await handlers.romFiles(ctx, 'rom:ps3:g', { ps3Hdd: true }))?.files.map((f) => f.path)
    ).toEqual(['ps3/Game.ps3/Game.ps3', oldPath])
    expect(await handlers.romFile(ctx, 'rom:ps3:g', oldPath)).toBe(
      join(oldDev0, 'game', 'BLUS30443', 'OLD.BIN')
    )
    // Right after the move (well within the host's 5-minute file list cache): the new place holds the game's folder,
    // RPCS3's configure marked it as in use, and it is offered at once (the list read from the old place is not reused).
    clock.t += 1000
    await markPs3HddInUse(emu)
    await fs.mkdir(join(newDev0, 'game', 'BLUS30443'), { recursive: true })
    await fs.writeFile(join(newDev0, 'game', 'BLUS30443', 'NEW.BIN'), 'new')
    expect(
      (await handlers.romFiles(ctx, 'rom:ps3:g', { ps3Hdd: true }))?.files.map((f) => f.path)
    ).toEqual(['ps3/Game.ps3/Game.ps3', newPath])
    expect(await handlers.romFile(ctx, 'rom:ps3:g', newPath)).toBe(
      join(newDev0, 'game', 'BLUS30443', 'NEW.BIN')
    )
    expect(await handlers.romFile(ctx, 'rom:ps3:g', oldPath)).toBeNull()
  })

  it.each([
    ['no old roms\\PS3 HDD', 'new'],
    ['an old roms\\PS3 HDD still in use', 'old'],
    ['an old roms\\PS3 HDD left after the move', 'new']
  ] as const)(
    "the client puts the game's PS3 HDD files in its active PS3 HDD (%s)",
    async (situation, active) => {
      const dir = await tempDir()
      const emu = join(dir, 'Emulation')
      const romsRoot = join(dir, 'roms')
      const oldHdd = join(emu, 'roms', 'PS3 HDD')
      const newHdd = join(emu, 'Updates and DLC', 'PS3')
      await fs.mkdir(join(newHdd, 'dev_hdd0', 'game'), { recursive: true })
      if (situation !== 'no old roms\\PS3 HDD')
        await fs.mkdir(join(oldHdd, 'dev_hdd0', 'game', 'BLUS11111'), { recursive: true })
      // After the move RPCS3's configure marked the new place as the one in use.
      if (situation === 'an old roms\\PS3 HDD left after the move') await markPs3HddInUse(emu)
      const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
      const offer = [
        {
          ...game({
            id: 'rom:ps3:g',
            source: 'rom',
            title: 'Game',
            externalId: 'ps3/Game.ps3',
            platformId: 'ps3'
          }),
          mediaKinds: [],
          sizeBytes: 15
        }
      ]
      const files: Record<string, string> = {
        'ps3/Game.ps3/Game.ps3': 'BLUS30443',
        'PS3 HDD/dev_hdd0/game/BLUS30443/USRDIR/EBOOT.BIN': 'update'
      }
      const conn = fakeConnection({
        library: async () => JSON.parse(JSON.stringify(offer)),
        romFiles: async () => ({
          files: Object.entries(files).map(([path, c]) => ({ path, size: c.length })),
          totalBytes: 15
        }),
        downloadFile: async (_id, path, dest, opts) => {
          const part = Buffer.from(files[path]!).subarray(opts?.from ?? 0)
          await fs.appendFile(dest, part)
          opts?.onBytes?.(part.length)
        }
      })
      const games: Game[] = []
      const s = await setup({
        games,
        secrets,
        emulationDir: emu,
        settings: (st) => {
          st.library.romsRoot = romsRoot
        },
        io: { hostClient: clientIo({ '192.168.1.5': conn }) }
      })
      s.scan.run.mockImplementation(async () => {
        games.push(
          game({
            id: 'rom:ps3:local',
            source: 'rom',
            title: 'Game',
            externalId: 'ps3/Game.ps3',
            platformId: 'ps3'
          })
        )
      })
      const progress = recorder(s.events, 'streaming:download')
      await s.service.start()
      await s.service.refreshRemoteLibrary()
      await s.service.downloadRemoteRom('remote:host-1:rom:ps3:g')
      await until(() => progress.some((p) => p.state !== 'downloading'))
      expect(progress[progress.length - 1]).toMatchObject({
        state: 'done',
        installedGameId: 'rom:ps3:local'
      })
      expect(await fs.readFile(join(romsRoot, 'ps3', 'Game.ps3', 'Game.ps3'), 'utf8')).toBe(
        'BLUS30443'
      )
      const eboot = join('dev_hdd0', 'game', 'BLUS30443', 'USRDIR', 'EBOOT.BIN')
      const [into, notInto] = active === 'old' ? [oldHdd, newHdd] : [newHdd, oldHdd]
      expect(await fs.readFile(join(into, eboot), 'utf8')).toBe('update')
      await expect(fs.stat(join(notInto, eboot))).rejects.toThrow()
      await expect(fs.stat(join(romsRoot, 'PS3 HDD'))).rejects.toThrow()
    }
  )
})

describe("a game's texture packs", () => {
  const ctx = { client: { id: 'client-1', name: 'Laptop' }, address: '192.168.1.30' }
  const cnf = `BOOT2 = cdrom0:${String.fromCharCode(92)}SLUS_209.99;1\r\nVER = 1.00\r\n`

  async function ps2Host(
    romName: string,
    image: Buffer,
    readChd?: StreamingServiceDeps['readChd'],
    gameIdTimeoutMs?: number,
    clock?: () => number
  ): Promise<{ handlers: HostHandlers; tex: string; size: number; rom: string }> {
    const calls: string[] = []
    const { io: baseIo, server } = hostIo(calls)
    const io = clock ? { ...baseIo, now: clock } : baseIo
    const emu = await tempDir()
    const roms = join(emu, 'roms')
    await fs.mkdir(join(roms, 'ps2'), { recursive: true })
    await fs.writeFile(join(roms, 'ps2', romName), image)
    const tex = join(emu, 'texturepacks')
    const put = async (rel: string, data: string): Promise<void> => {
      await fs.mkdir(join(tex, rel, '..'), { recursive: true })
      await fs.writeFile(join(tex, rel), data)
    }
    await put('pcsx2/SLUS-20999/replacements/a.png', 'aaaa')
    await put('pcsx2/SLUS_20999 HD/b.png', 'bb')
    await put('pcsx2/SLUS-12345/other.png', 'other')
    await put('duckstation/SLUS-20999/psx.png', 'psx')
    const ps2 = game({
      id: 'rom:ps2:g',
      source: 'rom',
      title: 'Game',
      externalId: `ps2/${romName}`,
      platformId: 'ps2',
      launch: { kind: 'emulator', systemId: 'ps2', romPath: join(roms, 'ps2', romName) }
    })
    const s = await setup({
      io,
      calls,
      games: [ps2],
      emulationDir: emu,
      ...(readChd ? { readChd } : {}),
      ...(gameIdTimeoutMs ? { gameIdTimeoutMs } : {}),
      settings: (x) => {
        x.streaming.hostEnabled = true
        x.library.romsRoot = roms
      }
    })
    await s.service.start()
    await s.service.idle()
    return {
      handlers: server.deps!.handlers,
      tex,
      size: image.length,
      rom: join(roms, 'ps2', romName)
    }
  }

  it('the host offers the folders named after the serial in its disc, to a client that takes them', async () => {
    const { handlers, tex, size } = await ps2Host(
      'Game (USA).iso',
      syntheticIso({ 'SYSTEM.CNF': cnf })
    )
    const set = await handlers.romFiles(ctx, 'rom:ps2:g', { ps3Hdd: true, textures: true })
    expect(set?.files.map((f) => f.path).sort()).toEqual([
      'Texture Packs/pcsx2/SLUS-20999/replacements/a.png',
      'Texture Packs/pcsx2/SLUS_20999 HD/b.png',
      'ps2/Game (USA).iso'
    ])
    expect(set?.files[0]?.path).toBe('ps2/Game (USA).iso')
    expect(set?.totalBytes).toBe(size + 4 + 2)
    // An older client (no ?with=textures) gets the game alone: it would put them inside its ROM folder.
    const game = { files: [{ path: 'ps2/Game (USA).iso', size }], totalBytes: size }
    expect(await handlers.romFiles(ctx, 'rom:ps2:g', { ps3Hdd: true })).toEqual(game)
    expect(await handlers.romFiles(ctx, 'rom:ps2:g')).toEqual(game)
    // Only the listed files are served.
    expect(
      await handlers.romFile(ctx, 'rom:ps2:g', 'Texture Packs/pcsx2/SLUS-20999/replacements/a.png')
    ).toBe(join(tex, 'pcsx2', 'SLUS-20999', 'replacements', 'a.png'))
    expect(
      await handlers.romFile(ctx, 'rom:ps2:g', 'Texture Packs/pcsx2/SLUS-12345/other.png')
    ).toBeNull()
    expect(
      await handlers.romFile(ctx, 'rom:ps2:g', 'Texture Packs/duckstation/SLUS-20999/psx.png')
    ).toBeNull()
  })

  it("a CHD's serial is read through the helper; without one, its name decides", async () => {
    const image = syntheticIso({ 'SYSTEM.CNF': cnf }, 300)
    const readChd = vi.fn<NonNullable<StreamingServiceDeps['readChd']>>(
      async (_p, offset, length) => ({
        classification: 'dvd',
        imageBytes: image.length,
        data: image.subarray(offset, offset + length)
      })
    )
    const { handlers } = await ps2Host('Game.chd', Buffer.from('chd'), readChd)
    const set = await handlers.romFiles(ctx, 'rom:ps2:g', { textures: true })
    expect(set?.files).toHaveLength(3)
    expect(readChd).toHaveBeenCalled()
    const noHelper = await ps2Host('Game.chd', Buffer.from('chd'))
    expect(
      (await noHelper.handlers.romFiles(ctx, 'rom:ps2:g', { textures: true }))?.files
    ).toHaveLength(1)
    const named = await ps2Host('Game [SLUS-20999].chd', Buffer.from('chd'))
    expect(
      (await named.handlers.romFiles(ctx, 'rom:ps2:g', { textures: true }))?.files
    ).toHaveLength(3)
  })

  it('a serial lookup that hangs is cut off: the game is offered without its texture packs', async () => {
    const readChd = vi.fn<NonNullable<StreamingServiceDeps['readChd']>>(() => new Promise(() => {}))
    const { handlers, size } = await ps2Host('Game.chd', Buffer.from('chd'), readChd, 50)
    const set = await handlers.romFiles(ctx, 'rom:ps2:g', { textures: true })
    expect(set).toEqual({ files: [{ path: 'ps2/Game.chd', size }], totalBytes: size })
    expect(readChd).toHaveBeenCalled()
  })

  it('past the deadline the reads left stop, and the serial in the name still brings the packs', async () => {
    const readChd = vi.fn<NonNullable<StreamingServiceDeps['readChd']>>(() => new Promise(() => {}))
    const { handlers } = await ps2Host('Game [SLUS-20999].chd', Buffer.from('chd'), readChd, 50)
    const started = Date.now()
    const set = await handlers.romFiles(ctx, 'rom:ps2:g', { textures: true })
    // The deadline, not the outer backstop, ended it.
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(set?.files).toHaveLength(3)
    await new Promise((r) => setTimeout(r, 50))
    // The stuck first read was the last one made.
    expect(readChd).toHaveBeenCalledTimes(1)
  })

  const chdOf = (
    image: Buffer,
    hang: { on: boolean }
  ): Mock<NonNullable<StreamingServiceDeps['readChd']>> =>
    vi.fn<NonNullable<StreamingServiceDeps['readChd']>>(async (_p, offset, length) =>
      hang.on
        ? new Promise(() => {})
        : {
            classification: 'dvd',
            imageBytes: image.length,
            data: image.subarray(offset, offset + length)
          }
    )

  it('callers asking for a set at once share one build', async () => {
    const image = syntheticIso({ 'SYSTEM.CNF': cnf }, 300)
    const once = chdOf(image, { on: false })
    const single = await ps2Host('Game.chd', Buffer.from('chd'), once)
    await single.handlers.romFiles(ctx, 'rom:ps2:g', { textures: true })
    const readChd = chdOf(image, { on: false })
    const { handlers } = await ps2Host('Game.chd', Buffer.from('chd'), readChd)
    const sets = await Promise.all(
      [1, 2, 3].map(() => handlers.romFiles(ctx, 'rom:ps2:g', { textures: true }))
    )
    for (const set of sets) expect(set?.files).toHaveLength(3)
    expect(readChd.mock.calls.length).toBe(once.mock.calls.length)
  })

  it('a rebuild whose serial read is cut short keeps the last texture packs, and is built again sooner', async () => {
    const image = syntheticIso({ 'SYSTEM.CNF': cnf }, 300)
    const hang = { on: false }
    const readChd = chdOf(image, hang)
    let t = Date.now()
    const { handlers, rom } = await ps2Host('Game.chd', Buffer.from('chd'), readChd, 50, () => t)
    expect((await handlers.romFiles(ctx, 'rom:ps2:g', { textures: true }))?.files).toHaveLength(3)
    // The game changed (its read is no longer cached) and the helper is stuck now.
    await fs.writeFile(rom, 'chd, changed')
    hang.on = true
    t += 5 * 60_000 + 1
    const kept = await handlers.romFiles(ctx, 'rom:ps2:g', { textures: true })
    expect(kept?.files.map((f) => f.path).sort()).toEqual([
      'Texture Packs/pcsx2/SLUS-20999/replacements/a.png',
      'Texture Packs/pcsx2/SLUS_20999 HD/b.png',
      'ps2/Game.chd'
    ])
    expect(kept?.files.find((f) => f.path === 'ps2/Game.chd')?.size).toBe(12)
    // Not kept for the full five minutes: a minute on, the serial is read again.
    const reads = readChd.mock.calls.length
    t += 61_000
    await handlers.romFiles(ctx, 'rom:ps2:g', { textures: true })
    expect(readChd.mock.calls.length).toBeGreaterThan(reads)
  })

  it('the client puts them in its own texturepacks and keeps the ones it has', async () => {
    const dir = await tempDir()
    const emu = join(dir, 'Emulation')
    const romsRoot = join(dir, 'roms')
    const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
    const offer = [
      {
        ...game({
          id: 'rom:ps2:g',
          source: 'rom',
          title: 'Game',
          externalId: 'ps2/Game.iso',
          platformId: 'ps2'
        }),
        mediaKinds: [],
        sizeBytes: 10
      }
    ]
    const files: Record<string, string> = {
      'ps2/Game.iso': 'game',
      'Texture Packs/pcsx2/SLUS-20999/replacements/a.png': 'aaaa',
      'Texture Packs/pcsx2/SLUS-20999/b.png': 'bb'
    }
    // b.png is already there (this PC's own edit, another size than the host's): kept, not fetched.
    await fs.mkdir(join(emu, 'texturepacks', 'pcsx2', 'SLUS-20999'), { recursive: true })
    await fs.writeFile(join(emu, 'texturepacks', 'pcsx2', 'SLUS-20999', 'b.png'), 'mine, edited')
    const fetched: string[] = []
    const asked: string[] = []
    const sessions: string[] = []
    const download: HostConnection['downloadFile'] = async (_id, path, dest, opts) => {
      fetched.push(path)
      const part = Buffer.from(files[path]!).subarray(opts?.from ?? 0)
      await fs.appendFile(dest, part)
      opts?.onBytes?.(part.length)
    }
    const conn = fakeConnection({
      library: async () => JSON.parse(JSON.stringify(offer)),
      romFiles: async () => {
        asked.push('list')
        return {
          files: Object.entries(files).map(([path, c]) => ({ path, size: c.length })),
          totalBytes: 10
        }
      },
      downloadFile: async () => {
        throw new Error('the session is used')
      },
      // The files go through one download session, closed at the end.
      downloadSession: () => {
        sessions.push('open')
        return {
          downloadFile: download,
          connectionsOpened: () => 1,
          close: () => sessions.push('close')
        }
      }
    })
    const games: Game[] = []
    const s = await setup({
      games,
      secrets,
      emulationDir: emu,
      settings: (st) => {
        st.library.romsRoot = romsRoot
      },
      io: { hostClient: clientIo({ '192.168.1.5': conn }) }
    })
    s.scan.run.mockImplementation(async () => {
      games.push(
        game({
          id: 'rom:ps2:local',
          source: 'rom',
          title: 'Game',
          externalId: 'ps2/Game.iso',
          platformId: 'ps2'
        })
      )
    })
    const progress = recorder(s.events, 'streaming:download')
    await s.service.start()
    await s.service.refreshRemoteLibrary()
    await s.service.downloadRemoteRom('remote:host-1:rom:ps2:g')
    await until(() => progress.some((p) => p.state !== 'downloading'))
    expect(progress[progress.length - 1]).toMatchObject({
      state: 'done',
      installedGameId: 'rom:ps2:local'
    })
    // The texture packs count in the download's size and progress.
    expect(progress.some((p) => p.state === 'downloading' && p.bytesTotal === 10)).toBe(true)
    expect(await fs.readFile(join(romsRoot, 'ps2', 'Game.iso'), 'utf8')).toBe('game')
    const pack = join(emu, 'texturepacks', 'pcsx2', 'SLUS-20999')
    expect(await fs.readFile(join(pack, 'replacements', 'a.png'), 'utf8')).toBe('aaaa')
    expect(await fs.readFile(join(pack, 'b.png'), 'utf8')).toBe('mine, edited')
    expect(sessions).toEqual(['open', 'close'])
    expect(fetched.sort()).toEqual([
      'Texture Packs/pcsx2/SLUS-20999/replacements/a.png',
      'ps2/Game.iso'
    ])
    await expect(fs.stat(join(romsRoot, 'Texture Packs'))).rejects.toThrow()
  })

  it('a file the host refuses as busy (429) is asked for again and the download finishes', async () => {
    const dir = await tempDir()
    const emu = join(dir, 'Emulation')
    const romsRoot = join(dir, 'roms')
    const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
    const offer = [
      {
        ...game({
          id: 'rom:ps2:g',
          source: 'rom',
          title: 'Game',
          externalId: 'ps2/Game.iso',
          platformId: 'ps2'
        }),
        mediaKinds: [],
        sizeBytes: 8
      }
    ]
    const files: Record<string, string> = {
      'ps2/Game.iso': 'game',
      'Texture Packs/pcsx2/SLUS-20999/a.png': 'aaaa'
    }
    const asked: string[] = []
    let refused = 0
    const download: HostConnection['downloadFile'] = async (_id, path, dest, opts) => {
      asked.push(path)
      if (path === 'Texture Packs/pcsx2/SLUS-20999/a.png' && refused++ === 0)
        throw new HostRequestError(429, 'too-many-downloads')
      const part = Buffer.from(files[path]!).subarray(opts?.from ?? 0)
      await fs.appendFile(dest, part)
      opts?.onBytes?.(part.length)
    }
    const conn = fakeConnection({
      library: async () => JSON.parse(JSON.stringify(offer)),
      romFiles: async () => ({
        files: Object.entries(files).map(([path, c]) => ({ path, size: c.length })),
        totalBytes: 8
      }),
      downloadFile: download
    })
    const games: Game[] = []
    const s = await setup({
      games,
      secrets,
      emulationDir: emu,
      settings: (st) => {
        st.library.romsRoot = romsRoot
      },
      io: { hostClient: clientIo({ '192.168.1.5': conn }) }
    })
    s.scan.run.mockImplementation(async () => {
      games.push(
        game({
          id: 'rom:ps2:local',
          source: 'rom',
          title: 'Game',
          externalId: 'ps2/Game.iso',
          platformId: 'ps2'
        })
      )
    })
    const progress = recorder(s.events, 'streaming:download')
    await s.service.start()
    await s.service.refreshRemoteLibrary()
    await s.service.downloadRemoteRom('remote:host-1:rom:ps2:g')
    await until(() => progress.some((p) => p.state !== 'downloading'))
    expect(progress[progress.length - 1]).toMatchObject({ state: 'done' })
    expect(
      await fs.readFile(join(emu, 'texturepacks', 'pcsx2', 'SLUS-20999', 'a.png'), 'utf8')
    ).toBe('aaaa')
    expect(asked.filter((p) => p.endsWith('a.png'))).toHaveLength(2)
  })

  it('the client refuses a texture pack path outside a known emulator folder', async () => {
    const dir = await tempDir()
    const emu = join(dir, 'Emulation')
    const romsRoot = join(dir, 'roms')
    const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
    const offer = [
      {
        ...game({
          id: 'rom:ps2:g',
          source: 'rom',
          title: 'Game',
          externalId: 'ps2/Game.iso',
          platformId: 'ps2'
        }),
        mediaKinds: [],
        sizeBytes: 5
      }
    ]
    const conn = fakeConnection({
      library: async () => JSON.parse(JSON.stringify(offer)),
      romFiles: async () => ({
        files: [
          { path: 'ps2/Game.iso', size: 4 },
          { path: 'Texture Packs/bios/scph.bin', size: 1 }
        ],
        totalBytes: 5
      }),
      downloadFile: async () => {
        throw new Error('nothing is fetched')
      }
    })
    const s = await setup({
      secrets,
      emulationDir: emu,
      settings: (st) => {
        st.library.romsRoot = romsRoot
      },
      io: { hostClient: clientIo({ '192.168.1.5': conn }) }
    })
    const progress = recorder(s.events, 'streaming:download')
    await s.service.start()
    await s.service.refreshRemoteLibrary()
    await s.service.downloadRemoteRom('remote:host-1:rom:ps2:g')
    await until(() => progress.some((p) => p.state !== 'downloading'))
    expect(progress[progress.length - 1]).toMatchObject({ state: 'failed' })
    expect(progress[progress.length - 1]?.message).toMatch(/Unsafe file path/)
    await expect(fs.stat(join(emu, 'texturepacks', 'bios'))).rejects.toThrow()
  })
})

describe('sharing logins with paired computers', () => {
  const ctx: RequestContext = {
    client: { id: 'client-1', name: 'Laptop' },
    address: '192.168.1.30'
  }

  async function hostWithLogins(
    patch: (s: Settings) => void = () => {},
    secrets?: SecretsStore
  ): Promise<{ s: Setup; handlers: HostHandlers }> {
    const calls: string[] = []
    const { io, server } = hostIo(calls)
    const s = await setup({
      io,
      calls,
      ...(secrets ? { secrets } : {}),
      settings: (x) => {
        x.streaming.hostEnabled = true
        x.scrapers.steamgriddb.apiKey = 'fake-key-1'
        x.scrapers.steam.apiKey = 'fake-key-2'
        x.scrapers.steam.steamId64 = '76561190000000000'
        patch(x)
      }
    })
    await s.service.start()
    await s.service.idle()
    return { s, handlers: server.deps!.handlers }
  }

  it("as host: a paired client gets this PC's set logins", async () => {
    const { handlers } = await hostWithLogins()
    expect(handlers.logins(ctx)).toEqual({
      steamgriddb: { apiKey: 'fake-key-1' },
      steam: { apiKey: 'fake-key-2', steamId64: '76561190000000000' }
    })
  })

  it('as host: nothing (403 logins-off) while "Share my logins" is off', async () => {
    const { s, handlers } = await hostWithLogins((x) => (x.streaming.shareLogins = false))
    expect(handlers.logins(ctx)).toBeNull()
    // Switched on again: shared without a restart.
    s.settings.set((x) => (x.streaming.shareLogins = true))
    expect(handlers.logins(ctx)).toMatchObject({ steamgriddb: { apiKey: 'fake-key-1' } })
  })

  it("as host: a PC that is this PC's own host gets nothing", async () => {
    const dir = await tempDir()
    const secrets = await pairedSecrets(dir, [{ id: 'client-1', address: '192.168.1.30' }])
    const { handlers } = await hostWithLogins(() => {}, secrets)
    expect(handlers.logins(ctx)).toBeNull()
  })

  /** A client paired with host-1, whose connection answers `answer` for logins. */
  async function clientWithLogins(answer: () => unknown): Promise<{
    s: Setup
    logins: ReturnType<typeof vi.fn>
    fillLogins: ReturnType<typeof vi.fn>
    seen: PlayOutEvents['streaming:logins'][]
  }> {
    const dir = await tempDir()
    const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
    const logins = vi.fn(async () => answer())
    const conn = fakeConnection({ logins })
    const ref: { settings?: FakeSettings } = {}
    // What main/index.ts does: the patch goes into Settings (deep merged).
    const fillLogins = vi.fn((patch: Partial<Settings['scrapers']>) =>
      ref.settings!.set((x) => {
        for (const [service, fields] of Object.entries(patch))
          Object.assign((x.scrapers as unknown as Record<string, object>)[service]!, fields)
      })
    )
    const s = await setup({
      secrets,
      fillLogins,
      settings: (x) => (x.scrapers.thegamesdb.apiKey = 'my-own-key'),
      io: { hostClient: clientIo({ '192.168.1.5': conn }) }
    })
    ref.settings = s.settings
    const seen = recorder(s.events, 'streaming:logins')
    return { s, logins, fillLogins, seen }
  }

  it("as client: takes the host's logins for the services it has none of, once", async () => {
    const { s, logins, fillLogins, seen } = await clientWithLogins(() => ({
      steamgriddb: { apiKey: 'fake-key-1' },
      thegamesdb: { apiKey: 'fake-key-2' },
      steam: { apiKey: 'fake-key-3', steamId64: '76561190000000000' }
    }))
    await s.service.start()
    await s.service.refreshRemoteLibrary()
    await until(() => seen.length > 0)
    expect(fillLogins).toHaveBeenCalledTimes(1)
    // Not TheGamesDB: this PC has its own key.
    expect(fillLogins).toHaveBeenCalledWith({
      steamgriddb: { apiKey: 'fake-key-1' },
      steam: { apiKey: 'fake-key-3', steamId64: '76561190000000000' }
    })
    expect(seen).toEqual([{ hostName: 'Living Room', services: ['SteamGridDB', 'Steam'] }])
    expect(s.settings.get().scrapers.thegamesdb.apiKey).toBe('my-own-key')
    expect(s.settings.get().scrapers.steamgriddb.apiKey).toBe('fake-key-1')

    // The next refresh asks again, but this PC has them now: nothing more is filled or shown.
    const asked = logins.mock.calls.length
    await s.service.refreshRemoteLibrary()
    await until(() => logins.mock.calls.length > asked)
    await new Promise((r) => setTimeout(r, 50))
    expect(fillLogins).toHaveBeenCalledTimes(1)
    expect(seen).toHaveLength(1)
  })

  it('as client: nothing is filled when the host shares none (403/404 read as null)', async () => {
    const { s, logins, fillLogins, seen } = await clientWithLogins(() => null)
    await s.service.start()
    await s.service.refreshRemoteLibrary()
    await until(() => logins.mock.calls.length > 0)
    await new Promise((r) => setTimeout(r, 50))
    expect(fillLogins).not.toHaveBeenCalled()
    expect(seen).toEqual([])
  })

  it('as client: a failed logins request leaves the library online', async () => {
    const { s, logins, fillLogins } = await clientWithLogins(() => {
      throw new HostRequestError(500, 'internal')
    })
    await s.service.start()
    await s.service.refreshRemoteLibrary()
    await until(() => logins.mock.calls.length > 0)
    await new Promise((r) => setTimeout(r, 50))
    expect(fillLogins).not.toHaveBeenCalled()
    expect((await s.service.status()).client.hosts[0]).toMatchObject({ online: true })
  })

  it('as client: takes them right after pairing', async () => {
    const logins = vi.fn(async () => ({
      igdb: { clientId: 'fake-id', clientSecret: 'fake-secret' }
    }))
    const hostClient = clientIo({ '192.168.1.5': fakeConnection({ logins }) })
    hostClient.pair = async () =>
      ({
        hostId: 'host-1',
        hostName: 'Living Room',
        token: 't'.repeat(32),
        fingerprint: 'cd'.repeat(32)
      }) as never
    const fillLogins = vi.fn()
    const s = await setup({ fillLogins, io: { hostClient } })
    const seen = recorder(s.events, 'streaming:logins')
    await s.service.start()
    await s.service.pairHost('192.168.1.5', '1234')
    await until(() => seen.length > 0)
    expect(fillLogins).toHaveBeenCalledWith({
      igdb: { clientId: 'fake-id', clientSecret: 'fake-secret' }
    })
    expect(seen).toEqual([{ hostName: 'Living Room', services: ['IGDB'] }])
  })

  it('as client: takes nothing from a host that is also its client', async () => {
    const dir = await tempDir()
    const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
    await secrets.update((d) => {
      d.clients.push({
        id: 'host-1',
        name: 'Living Room',
        tokenHash: 'ab'.repeat(32),
        pairedAt: '2026-11-01T00:00:00.000Z'
      } as never)
    })
    const logins = vi.fn(async () => ({ steamgriddb: { apiKey: 'fake-key-1' } }))
    const fillLogins = vi.fn()
    const s = await setup({
      secrets,
      fillLogins,
      io: { hostClient: clientIo({ '192.168.1.5': fakeConnection({ logins }) }) }
    })
    await s.service.start()
    await s.service.refreshRemoteLibrary()
    await new Promise((r) => setTimeout(r, 50))
    expect(logins).not.toHaveBeenCalled()
    expect(fillLogins).not.toHaveBeenCalled()
  })
})

describe('first start', () => {
  const found = (id: string, address: string): FoundHost => ({
    id,
    name: id === 'host-1' ? 'Living Room' : 'Office',
    port: 47900,
    fingerprint: 'cd'.repeat(32),
    address
  })

  it('looks for nothing when it is not the first start', async () => {
    const discoverHosts = vi.fn(async () => [found('host-2', '192.168.1.6')])
    const s = await setup({ io: { discoverHosts } })
    expect(await s.service.firstStartHosts()).toEqual([])
    const again = await setup({ firstStart: false, io: { discoverHosts } })
    expect(await again.service.firstStartHosts()).toEqual([])
    expect(discoverHosts).not.toHaveBeenCalled()
  })

  it('looks for nothing when a host is already paired', async () => {
    const dir = await tempDir()
    const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
    const discoverHosts = vi.fn(async () => [found('host-2', '192.168.1.6')])
    const s = await setup({
      firstStart: true,
      secrets,
      io: { hostClient: clientIo({}), discoverHosts }
    })
    expect(await s.service.firstStartHosts()).toEqual([])
    expect(discoverHosts).not.toHaveBeenCalled()
  })

  it("offers the network's hosts, looking once however often it is asked", async () => {
    const discoverHosts = vi.fn(async () => [
      found('host-1', '192.168.1.5'),
      found('host-2', '192.168.1.6')
    ])
    const s = await setup({ firstStart: true, io: { discoverHosts } })
    const [a, b] = await Promise.all([s.service.firstStartHosts(), s.service.firstStartHosts()])
    const expected = [
      { id: 'host-1', name: 'Living Room', address: '192.168.1.5', port: 47900, paired: false },
      { id: 'host-2', name: 'Office', address: '192.168.1.6', port: 47900, paired: false }
    ]
    expect(a).toEqual(expected)
    expect(b).toEqual(expected)
    expect(await s.service.firstStartHosts()).toEqual(expected)
    expect(discoverHosts).toHaveBeenCalledTimes(1)
  })

  it('offers nothing more once a host is paired, without looking again', async () => {
    const discoverHosts = vi.fn(async () => [found('host-2', '192.168.1.6')])
    const hostClient = clientIo({ '192.168.1.6': fakeConnection() })
    hostClient.pair = async () =>
      ({
        hostId: 'host-2',
        hostName: 'Office',
        token: 't'.repeat(32),
        fingerprint: 'cd'.repeat(32)
      }) as never
    const s = await setup({ firstStart: true, io: { discoverHosts, hostClient } })
    expect((await s.service.firstStartHosts()).map((h) => h.id)).toEqual(['host-2'])
    await s.service.pairHost('192.168.1.6', '1234')
    expect(await s.service.firstStartHosts()).toEqual([])
    expect(discoverHosts).toHaveBeenCalledTimes(1)
  })

  it('answers [] when looking fails', async () => {
    const discoverHosts = vi.fn(async (): Promise<FoundHost[]> => {
      throw new Error('EADDRINUSE')
    })
    const s = await setup({ firstStart: true, io: { discoverHosts } })
    expect(await s.service.firstStartHosts()).toEqual([])
  })
})

describe('pairing and the Emulation folder', () => {
  it('syncs the Emulation folder with a new host right after pairing, not at the next refresh', async () => {
    const emu = await tempDir()
    const manifest = vi.fn(async () => ({
      root: 'D:\\Emulation',
      folderId: 'host-folder',
      now: Date.now(),
      files: [],
      unsettled: [],
      linked: [],
      excluded: []
    }))
    const conn = fakeConnection()
    conn.emulation.manifest = manifest
    const hostClient = clientIo({ '192.168.1.5': conn })
    hostClient.pair = async () =>
      ({
        hostId: 'host-1',
        hostName: 'Living Room',
        token: 't'.repeat(32),
        fingerprint: 'cd'.repeat(32)
      }) as never
    const s = await setup({ emulationDir: emu, io: { hostClient } })
    await s.service.start()
    // No host yet: nothing synced at start.
    await new Promise((r) => setTimeout(r, 50))
    expect(manifest).not.toHaveBeenCalled()
    await s.service.pairHost('192.168.1.5', '1234')
    // No refresh asked for: the pairing alone starts the pass.
    await until(() => manifest.mock.calls.length > 0)
    await vi.waitFor(async () => {
      expect((await s.service.status()).client.hosts[0]?.emulationSync?.state).toBe('synced')
    })
  })

  it('does not sync after pairing with the setting off', async () => {
    const emu = await tempDir()
    const conn = fakeConnection()
    const manifest = vi.fn(conn.emulation.manifest)
    conn.emulation.manifest = manifest
    const library = vi.fn(async () => [])
    const hostClient = clientIo({ '192.168.1.5': { ...conn, library } })
    hostClient.pair = async () =>
      ({
        hostId: 'host-1',
        hostName: 'Living Room',
        token: 't'.repeat(32),
        fingerprint: 'cd'.repeat(32)
      }) as never
    const s = await setup({
      emulationDir: emu,
      settings: (x) => (x.streaming.syncEmulation = false),
      io: { hostClient }
    })
    await s.service.start()
    await s.service.pairHost('192.168.1.5', '1234')
    await until(() => library.mock.calls.length > 0)
    await new Promise((r) => setTimeout(r, 50))
    expect(manifest).not.toHaveBeenCalled()
  })
})

describe('offeredMetadata', () => {
  const base = {
    id: 'steam:620',
    source: 'steam',
    externalId: '620',
    platformId: 'pc',
    title: 'Portal 2',
    sortTitle: 'portal 2',
    installed: true,
    favorite: false,
    hidden: false,
    addedAt: '2026-01-01T00:00:00.000Z',
    metadata: { genres: ['Scraped'], developers: ['Valve'] },
    media: {},
    user: {
      titleOverride: 'My Portal',
      metadataEdits: { genres: ['Private'], description: 'My notes' }
    }
  } as unknown as Game

  it("lays the cloud over the scraped metadata, never this PC's own edits", () => {
    const offered = offeredMetadata(base, { developers: ['Valve Corporation'] })
    expect(offered.metadata.genres).toEqual(['Scraped'])
    expect(offered.metadata.developers).toEqual(['Valve Corporation'])
    expect(offered.metadata.description).toBeUndefined()
    expect(offered.user.metadataEdits).toBeUndefined()
    // the stored game is untouched
    expect(base.user.metadataEdits?.genres).toEqual(['Private'])
  })

  it('offers the scraped metadata as it is without a cloud entry', () => {
    expect(offeredMetadata(base, undefined).metadata).toEqual(base.metadata)
  })
})

describe('Library tabs sync with paired computers', () => {
  function tab(id: string, over: Partial<LibraryTabDef> = {}): LibraryTabDef {
    return {
      id,
      filters: {
        platforms: [],
        stores: [],
        genres: [],
        eras: [],
        tags: [],
        sizes: [],
        hltb: [],
        controls: [],
        players: [],
        online: [],
        hidden: false,
        favorites: false,
        coop: false,
        recomp: false
      },
      sort: 'title-asc',
      sortReversed: false,
      playableFirst: true,
      ...over
    }
  }
  const later = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const ctxOf = (id: string): RequestContext => ({
    client: { id, name: id },
    address: '192.168.1.30'
  })

  async function host(
    patch: (s: Settings) => void = () => {},
    secrets?: SecretsStore
  ): Promise<{ s: Setup; handlers: HostHandlers }> {
    const calls: string[] = []
    const { io, server } = hostIo(calls)
    const s = await setup({
      io,
      calls,
      syncTabs: {},
      ...(secrets ? { secrets } : {}),
      settings: (x) => {
        x.streaming.hostEnabled = true
        x.ui.libraryTabs = [tab('h1')]
        patch(x)
      }
    })
    await s.service.start()
    await s.service.idle()
    return { s, handlers: server.deps!.handlers }
  }

  type Answer = (doc: unknown, now: number) => Promise<{ doc: unknown; now: unknown } | null>

  /** A client paired with host-1, whose tabs exchange goes to `answer`. */
  async function client(
    answer: Answer,
    patch: (s: Settings) => void = () => {},
    options: { alsoClient?: boolean } = {}
  ): Promise<{ s: Setup; libraryTabs: Mock<Answer> }> {
    const dir = await tempDir()
    const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
    if (options.alsoClient)
      await secrets.update((d) => {
        d.clients.push({
          id: 'host-1',
          name: 'Living Room',
          tokenHash: 'ab'.repeat(32),
          pairedAt: '2026-11-01T00:00:00.000Z'
        } as never)
      })
    const libraryTabs = vi.fn(answer)
    const s = await setup({
      secrets,
      syncTabs: { afterChangeMs: 50 },
      settings: (x) => {
        x.ui.libraryTabs = [tab('c1')]
        patch(x)
      },
      io: { hostClient: clientIo({ '192.168.1.5': fakeConnection({ libraryTabs }) }) }
    })
    await s.service.start()
    return { s, libraryTabs }
  }

  const docOf = (tabs: LibraryTabDef[], updatedAt: string, by: string): unknown => ({
    v: 1,
    tabs,
    updatedAt,
    by
  })
  const NEVER = '1970-01-01T00:00:00.000Z'

  it('as host: takes a newer copy from a client and answers with it; an older one gets the host copy', async () => {
    const { s, handlers } = await host()
    const t = Date.now()
    const newer = docOf([tab('c1')], new Date(t).toISOString(), 'client-1')
    const answer = handlers.libraryTabs!(ctxOf('client-1'), { doc: newer, now: t })
    expect(s.settings.get().ui.libraryTabs).toEqual([tab('c1')])
    expect(answer).toMatchObject({ doc: { tabs: [tab('c1')], by: 'client-1' } })
    // An older (never edited) copy: the host keeps its own and answers with it.
    const old = docOf([tab('x')], NEVER, 'client-2')
    expect(handlers.libraryTabs!(ctxOf('client-2'), { doc: old, now: t })).toMatchObject({
      doc: { tabs: [tab('c1')] }
    })
    expect(s.settings.get().ui.libraryTabs).toEqual([tab('c1')])
  })

  it('as host: ignores a malformed copy', async () => {
    const { s, handlers } = await host()
    const answer = handlers.libraryTabs!(ctxOf('client-1'), { doc: { v: 1, tabs: 'no' } })
    expect(answer).toMatchObject({ doc: { tabs: [tab('h1')] } })
    expect(s.settings.get().ui.libraryTabs).toEqual([tab('h1')])
  })

  it('as host: answers nothing (403) while the sync is off here, and takes nothing', async () => {
    const { s, handlers } = await host((x) => (x.streaming.syncLibraryTabs = false))
    const newer = docOf([tab('c1')], new Date().toISOString(), 'client-1')
    expect(handlers.libraryTabs!(ctxOf('client-1'), { doc: newer, now: Date.now() })).toBeNull()
    expect(s.settings.get().ui.libraryTabs).toEqual([tab('h1')])
  })

  it("as host: nothing with a PC that is this PC's own host", async () => {
    const dir = await tempDir()
    const secrets = await pairedSecrets(dir, [{ id: 'client-1', address: '192.168.1.30' }])
    const { handlers } = await host(() => {}, secrets)
    expect(handlers.libraryTabs!(ctxOf('client-1'), { doc: null })).toBeNull()
  })

  it("as client: takes the host's tabs on first contact, without stamping or sending them back", async () => {
    const hostDoc = docOf([tab('h1'), tab('h2')], NEVER, 'host-1')
    const { s, libraryTabs } = await client(async () => ({ doc: hostDoc, now: Date.now() }))
    await s.service.refreshRemoteLibrary()
    await until(() => s.settings.get().ui.libraryTabs?.length === 2)
    expect(s.settings.get().ui.libraryTabs).toEqual([tab('h1'), tab('h2')])
    expect(libraryTabs.mock.calls[0]?.[0]).toMatchObject({ tabs: [tab('c1')], updatedAt: NEVER })
    // Taking them was no local change: no exchange follows the pause.
    await later(200)
    expect(libraryTabs).toHaveBeenCalledTimes(1)
  })

  it('as client: a burst of tab changes here goes to the host once, after the pause', async () => {
    const { s, libraryTabs } = await client(async (doc) => ({ doc, now: Date.now() }))
    await s.service.refreshRemoteLibrary()
    await until(() => libraryTabs.mock.calls.length === 1)
    s.settings.set((x) => (x.ui.libraryTabs = [tab('c1'), tab('c2')]))
    s.settings.set((x) => (x.ui.libraryTabs = [tab('c1'), tab('c2', { sort: 'recent' })]))
    expect(libraryTabs).toHaveBeenCalledTimes(1)
    await until(() => libraryTabs.mock.calls.length === 2)
    const sent = libraryTabs.mock.calls[1]?.[0] as { tabs: unknown; updatedAt: string }
    expect(sent.tabs).toEqual([tab('c1'), tab('c2', { sort: 'recent' })])
    expect(sent.updatedAt).not.toBe(NEVER)
    await later(200)
    expect(libraryTabs).toHaveBeenCalledTimes(2)
  })

  it('as client: nothing is sent or taken while the sync is off here', async () => {
    const { s, libraryTabs } = await client(
      async () => ({
        doc: docOf([tab('h')], new Date(Date.now() - 60_000).toISOString(), 'host-1'),
        now: Date.now()
      }),
      (x) => (x.streaming.syncLibraryTabs = false)
    )
    await s.service.refreshRemoteLibrary()
    s.settings.set((x) => (x.ui.libraryTabs = [tab('c2')]))
    await later(200)
    expect(libraryTabs).not.toHaveBeenCalled()
    expect(s.settings.get().ui.libraryTabs).toEqual([tab('c2')])
    // Switched on: the tabs go at once; the change made while it was off is the newest and stays.
    s.settings.set((x) => (x.streaming.syncLibraryTabs = true))
    await until(() => libraryTabs.mock.calls.length > 0)
    expect(libraryTabs.mock.calls[0]?.[0]).toMatchObject({ tabs: [tab('c2')] })
    expect(s.settings.get().ui.libraryTabs).toEqual([tab('c2')])
  })

  it('as client: nothing with a host that is also its client', async () => {
    const { s, libraryTabs } = await client(
      async () => null,
      () => {},
      { alsoClient: true }
    )
    await s.service.refreshRemoteLibrary()
    s.settings.set((x) => (x.ui.libraryTabs = [tab('c2')]))
    await later(200)
    expect(libraryTabs).not.toHaveBeenCalled()
  })

  it('a change on client A reaches the host, then client B', async () => {
    const h = await host()
    const via =
      (id: string): Answer =>
      async (doc, now) =>
        h.handlers.libraryTabs!(ctxOf(id), { doc, now })
    const a = await client(via('client-a'))
    const b = await client(via('client-b'))
    await a.s.service.refreshRemoteLibrary()
    await b.s.service.refreshRemoteLibrary()
    await until(() => b.s.settings.get().ui.libraryTabs?.[0]?.id === 'h1')
    await until(() => a.s.settings.get().ui.libraryTabs?.[0]?.id === 'h1')
    expect(h.s.settings.get().ui.libraryTabs).toEqual([tab('h1')])

    a.s.settings.set((x) => (x.ui.libraryTabs = [tab('h1'), tab('a2', { sort: 'size' })]))
    await until(() => h.s.settings.get().ui.libraryTabs?.length === 2)
    expect(h.s.settings.get().ui.libraryTabs).toEqual([tab('h1'), tab('a2', { sort: 'size' })])
    await b.s.service.refreshRemoteLibrary()
    await until(() => b.s.settings.get().ui.libraryTabs?.length === 2)
    expect(b.s.settings.get().ui.libraryTabs).toEqual([tab('h1'), tab('a2', { sort: 'size' })])
  })
})

describe('Favourites sync with paired computers', () => {
  const later = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const ctxOf = (id: string): RequestContext => ({
    client: { id, name: id },
    address: '192.168.1.30'
  })
  const T1 = Date.parse('2026-11-10T10:00:00.000Z')
  const T2 = Date.parse('2026-11-12T10:00:00.000Z')
  const iso = (t: number): string => new Date(t).toISOString()
  const wire = (games: Game[]) => async (): Promise<unknown[]> =>
    JSON.parse(JSON.stringify(games)) as unknown[]

  type FavLibrary = {
    parts: Partial<StreamingServiceDeps['library']>
    toggle(id: string, favorite: boolean, at?: number): void
    synced: Mock<(id: string, favorite: boolean, atMs: number) => boolean>
  }

  /** LibraryService's favourite parts over a list of games: a user toggle (stamped, listeners told) and a synced set. */
  function favoriteLibrary(games: Game[]): FavLibrary {
    const listeners = new Set<(id: string) => void>()
    const synced = vi.fn((id: string, favorite: boolean, atMs: number): boolean => {
      const g = games.find((x) => x.id === id)
      if (!g) return false
      g.favorite = favorite
      if (atMs > 0) g.favoriteAt = iso(atMs)
      else delete g.favoriteAt
      return true
    })
    return {
      parts: {
        setSyncedFavorite: synced,
        onUserFavorite: (l) => {
          listeners.add(l)
          return () => void listeners.delete(l)
        }
      },
      toggle(id, favorite, at = Date.now()) {
        const g = games.find((x) => x.id === id)!
        g.favorite = favorite
        g.favoriteAt = iso(at)
        for (const l of listeners) l(id)
      },
      synced
    }
  }

  async function host(
    games: Game[],
    patch: (s: Settings) => void = () => {},
    secrets?: SecretsStore
  ): Promise<{ s: Setup; handlers: HostHandlers; lib: FavLibrary }> {
    const calls: string[] = []
    const { io, server } = hostIo(calls)
    const lib = favoriteLibrary(games)
    const s = await setup({
      io,
      calls,
      games,
      remoteView: lib.parts,
      ...(secrets ? { secrets } : {}),
      settings: (x) => {
        x.streaming.hostEnabled = true
        patch(x)
      }
    })
    await s.service.start()
    await s.service.idle()
    return { s, handlers: server.deps!.handlers, lib }
  }

  type Exchange = NonNullable<HostConnection['favorites']>

  /** A client paired with host-1 that offers `offer`, whose favourites exchange goes to `favorites`. */
  async function client(
    games: Game[],
    offer: () => Promise<unknown[]>,
    favorites: Exchange | undefined,
    patch: (s: Settings) => void = () => {},
    options: { alsoClient?: boolean } = {}
  ): Promise<{ s: Setup; favorites: Mock<Exchange> | undefined; lib: FavLibrary }> {
    const dir = await tempDir()
    const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
    if (options.alsoClient)
      await secrets.update((d) => {
        d.clients.push({
          id: 'host-1',
          name: 'Living Room',
          tokenHash: 'ab'.repeat(32),
          pairedAt: '2026-11-01T00:00:00.000Z'
        } as never)
      })
    const spy = favorites ? vi.fn(favorites) : undefined
    const lib = favoriteLibrary(games)
    const s = await setup({
      secrets,
      games,
      remoteView: lib.parts,
      favoritesAfterChangeMs: 50,
      settings: patch,
      io: {
        hostClient: clientIo({
          '192.168.1.5': fakeConnection({ library: offer, ...(spy ? { favorites: spy } : {}) })
        })
      }
    })
    await s.service.start()
    return { s, favorites: spy, lib }
  }

  it('as host: takes a newer favourite from a client, keeps its own newer one, and answers with its favourites', async () => {
    const games = [
      game({ id: 'steam:1', source: 'steam', title: 'A' }),
      game({ id: 'steam:2', source: 'steam', title: 'B', favorite: true, favoriteAt: iso(T2) }),
      game({ id: 'steam:3', source: 'steam', title: 'C', hidden: true })
    ]
    const { handlers, lib } = await host(games)
    const answer = handlers.favorites!(ctxOf('client-1'), {
      entries: [
        { id: 'steam:1', favorite: true, at: T1 },
        // Older than the host's own change: kept.
        { id: 'steam:2', favorite: false, at: T1 },
        // Not offered (hidden): not the client's to change.
        { id: 'steam:3', favorite: true, at: T2 },
        { id: 'steam:404', favorite: true, at: T2 },
        'junk'
      ],
      now: Date.now()
    })
    // On this PC's clock (the two clocks agree here, to the millisecond or so).
    expect(games[0].favorite).toBe(true)
    expect(Math.abs(Date.parse(games[0].favoriteAt!) - T1)).toBeLessThan(1_000)
    expect(games[1]).toMatchObject({ favorite: true, favoriteAt: iso(T2) })
    expect(games[2].favorite).toBe(false)
    expect(lib.synced).toHaveBeenCalledTimes(1)
    expect(answer).toMatchObject({
      entries: [
        { id: 'steam:1', favorite: true },
        { id: 'steam:2', favorite: true, at: T2 }
      ]
    })
  })

  it("as host: corrects the client's clock", async () => {
    const games = [game({ id: 'steam:1', source: 'steam', title: 'A' })]
    const { handlers } = await host(games)
    const skew = 3_600_000 // the client's clock is an hour ahead
    handlers.favorites!(ctxOf('client-1'), {
      entries: [{ id: 'steam:1', favorite: true, at: T2 + skew }],
      now: Date.now() + skew
    })
    expect(Math.abs(Date.parse(games[0].favoriteAt!) - T2)).toBeLessThan(5_000)
  })

  it('as host: answers nothing (403) and takes nothing while off; its offer then carries no favourites', async () => {
    const games = [
      game({ id: 'steam:1', source: 'steam', title: 'A' }),
      game({ id: 'steam:2', source: 'steam', title: 'B', favorite: true, favoriteAt: iso(T1) })
    ]
    const { handlers, lib } = await host(games, (x) => (x.streaming.syncFavorites = false))
    expect(
      handlers.favorites!(ctxOf('client-1'), {
        entries: [{ id: 'steam:1', favorite: true, at: T2 }],
        now: Date.now()
      })
    ).toBeNull()
    expect(lib.synced).not.toHaveBeenCalled()
    const offer = (await handlers.library(ctxOf('client-1'))) as Game[]
    expect(offer.find((g) => g.id === 'steam:2')).toMatchObject({ favorite: false })
    expect(offer.find((g) => g.id === 'steam:2')?.favoriteAt).toBeUndefined()
  })

  it("as host: nothing with a PC that is this PC's own host", async () => {
    const dir = await tempDir()
    const secrets = await pairedSecrets(dir, [{ id: 'client-1', address: '192.168.1.30' }])
    const { handlers } = await host(
      [game({ id: 'steam:1', source: 'steam', title: 'A' })],
      () => {},
      secrets
    )
    expect(handlers.favorites!(ctxOf('client-1'), { entries: [], now: Date.now() })).toBeNull()
  })

  it("as client: takes the host's newer favourite for a game both have, without stamping or sending it back", async () => {
    const mine = [game({ id: 'steam:620', source: 'steam', title: 'Portal 2' })]
    const hostGames = [
      game({
        id: 'steam:620',
        source: 'steam',
        title: 'Portal 2',
        favorite: true,
        favoriteAt: iso(T1)
      })
    ]
    const { s, favorites, lib } = await client(mine, wire(hostGames), async () => ({
      entries: [{ id: 'steam:620', favorite: true, at: T1 }],
      now: Date.now()
    }))
    await s.service.refreshRemoteLibrary()
    await until(() => mine[0].favorite)
    expect(mine[0].favoriteAt).toBe(iso(T1))
    // Nothing to propose: this PC's copy had no change.
    expect(favorites!.mock.calls[0]?.[0]).toEqual([])
    // Taking it was no change of the user's: no exchange follows the pause.
    await later(200)
    expect(favorites).toHaveBeenCalledTimes(1)
    expect(lib.synced).toHaveBeenCalledTimes(1)
  })

  it('as client: a favourite changed here goes to the host after the pause, on one host copy', async () => {
    const released = { releaseDate: '2017-02-24' }
    const mine = [
      game({ id: 'epic:hk', source: 'epic', title: 'Hollow Knight', metadata: released }),
      // Same title as a host game, years 1993 and 2016: different games, never proposed.
      game({
        id: 'gog:doom',
        source: 'gog',
        title: 'Doom',
        favorite: true,
        favoriteAt: iso(T2),
        metadata: { releaseDate: '1993' }
      })
    ]
    const hostGames = [
      game({ id: 'steam:1', source: 'steam', title: 'Hollow Knight', metadata: released }),
      game({ id: 'gog:1', source: 'gog', title: 'Hollow Knight', metadata: released }),
      game({ id: 'steam:9', source: 'steam', title: 'Doom', metadata: { releaseDate: '2016' } })
    ]
    const { s, favorites, lib } = await client(mine, wire(hostGames), async () => ({
      entries: [],
      now: Date.now()
    }))
    await s.service.refreshRemoteLibrary()
    await until(() => favorites!.mock.calls.length === 1)
    expect(favorites!.mock.calls[0]?.[0]).toEqual([])
    const at = Date.now()
    lib.toggle('epic:hk', true, at)
    lib.toggle('epic:hk', false, at + 1)
    lib.toggle('epic:hk', true, at + 2)
    expect(favorites).toHaveBeenCalledTimes(1)
    await until(() => favorites!.mock.calls.length === 2)
    expect(favorites!.mock.calls[1]?.[0]).toEqual([{ id: 'steam:1', favorite: true, at: at + 2 }])
    await later(200)
    expect(favorites).toHaveBeenCalledTimes(2)
  })

  it('a favourite of a host-only game made on the client is set on the host and shows on its card', async () => {
    const hostGames = [game({ id: 'steam:9', source: 'steam', title: 'Celeste' })]
    const h = await host(hostGames)
    const { s, favorites } = await client(
      [],
      async () => (await h.handlers.library(ctxOf('client-1'))) as unknown[],
      async (entries, now) => h.handlers.favorites!(ctxOf('client-1'), { entries, now })
    )
    await s.service.refreshRemoteLibrary()
    const card = (await s.service.remoteLibrary()).games[0]!
    expect(card).toMatchObject({ id: 'remote:host-1:steam:9', favorite: false })
    const shown = recorder(s.events, 'streaming:library')
    await s.service.setRemoteFavorite(card.id, true)
    expect(hostGames[0].favorite).toBe(true)
    expect(hostGames[0].favoriteAt).toBeTruthy()
    expect(favorites!.mock.calls.at(-1)?.[0]).toMatchObject([{ id: 'steam:9', favorite: true }])
    expect((await s.service.remoteLibrary()).games[0]).toMatchObject({ favorite: true })
    expect(shown.at(-1)?.games[0]).toMatchObject({ favorite: true })
    // The next refresh brings the same from the host's offer.
    await s.service.refreshRemoteLibrary()
    expect((await s.service.remoteLibrary()).games[0]).toMatchObject({ favorite: true })
    // A later change (an exact tie on the clock goes to the host, which a person can't make by toggling).
    await new Promise((r) => setTimeout(r, 5))
    await s.service.setRemoteFavorite(card.id, false)
    expect(hostGames[0].favorite).toBe(false)
    expect((await s.service.remoteLibrary()).games[0]).toMatchObject({ favorite: false })
  })

  it('a change on client A reaches the host, then client B', async () => {
    const hostGames = [game({ id: 'steam:620', source: 'steam', title: 'Portal 2' })]
    const h = await host(hostGames)
    const peer = async (id: string): Promise<{ s: Setup; lib: FavLibrary; games: Game[] }> => {
      const games = [game({ id: 'steam:620', source: 'steam', title: 'Portal 2' })]
      const c = await client(
        games,
        async () => (await h.handlers.library(ctxOf(id))) as unknown[],
        async (entries, now) => h.handlers.favorites!(ctxOf(id), { entries, now })
      )
      return { s: c.s, lib: c.lib, games }
    }
    const a = await peer('client-a')
    const b = await peer('client-b')
    await a.s.service.refreshRemoteLibrary()
    await b.s.service.refreshRemoteLibrary()
    a.lib.toggle('steam:620', true)
    await until(() => hostGames[0].favorite)
    await b.s.service.refreshRemoteLibrary()
    await until(() => b.games[0].favorite)
    // B unfavourites it later: the host and then A follow.
    b.lib.toggle('steam:620', false, Date.now() + 10)
    await until(() => !hostGames[0].favorite)
    await a.s.service.refreshRemoteLibrary()
    await until(() => !a.games[0].favorite)
  })

  it('as client: nothing is sent or taken while off, and host-only cards show no favourite; switched on, it goes at once', async () => {
    const mine = [game({ id: 'steam:620', source: 'steam', title: 'Portal 2' })]
    const hostGames = [
      game({
        id: 'steam:620',
        source: 'steam',
        title: 'Portal 2',
        favorite: true,
        favoriteAt: iso(T1)
      }),
      game({ id: 'steam:9', source: 'steam', title: 'Celeste', favorite: true })
    ]
    const { s, favorites } = await client(
      mine,
      wire(hostGames),
      async () => ({
        entries: [
          { id: 'steam:620', favorite: true, at: T1 },
          { id: 'steam:9', favorite: true, at: 0 }
        ],
        now: Date.now()
      }),
      (x) => (x.streaming.syncFavorites = false)
    )
    await s.service.refreshRemoteLibrary()
    await later(200)
    expect(favorites).not.toHaveBeenCalled()
    expect(mine[0].favorite).toBe(false)
    expect((await s.service.remoteLibrary()).games[0]).toMatchObject({
      id: 'remote:host-1:steam:9',
      favorite: false
    })
    await expect(s.service.setRemoteFavorite('remote:host-1:steam:9', true)).rejects.toThrow(
      /Sync favourites/
    )
    s.settings.set((x) => (x.streaming.syncFavorites = true))
    await until(() => (favorites?.mock.calls.length ?? 0) > 0)
    await until(() => mine[0].favorite)
    expect((await s.service.remoteLibrary()).games[0]).toMatchObject({ favorite: true })
  })

  it('as client: an older host (no favourites endpoint, or one read as null) changes nothing', async () => {
    const mine = [
      game({
        id: 'steam:620',
        source: 'steam',
        title: 'Portal 2',
        favorite: true,
        favoriteAt: iso(T2)
      })
    ]
    const hostGames = [
      game({ id: 'steam:620', source: 'steam', title: 'Portal 2' }),
      game({ id: 'steam:9', source: 'steam', title: 'Celeste' })
    ]
    const old = await client(mine, wire(hostGames), async () => null)
    await old.s.service.refreshRemoteLibrary()
    await until(() => old.favorites!.mock.calls.length === 1)
    expect(mine[0].favorite).toBe(true)
    await expect(old.s.service.setRemoteFavorite('remote:host-1:steam:9', true)).rejects.toThrow(
      /does not sync favourites/
    )
    const older = await client([], wire(hostGames), undefined)
    await older.s.service.refreshRemoteLibrary()
    await expect(older.s.service.setRemoteFavorite('remote:host-1:steam:9', true)).rejects.toThrow()
  })

  it('as client: nothing with a host that is also its client', async () => {
    const mine = [game({ id: 'steam:620', source: 'steam', title: 'Portal 2' })]
    const { s, favorites, lib } = await client(
      mine,
      async () => [],
      async () => ({ entries: [], now: Date.now() }),
      () => {},
      { alsoClient: true }
    )
    await s.service.refreshRemoteLibrary()
    lib.toggle('steam:620', true)
    await later(200)
    expect(favorites).not.toHaveBeenCalled()
  })
})

describe('Play time sync with paired computers', () => {
  const later = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const ctxOf = (id: string): RequestContext => ({
    client: { id, name: id },
    address: '192.168.1.30'
  })
  let n = 0
  const sid = (): string => `s_test${++n}`

  type SessionLibrary = {
    sessions: PlaySession[]
    parts: Partial<StreamingServiceDeps['library']>
    /** A session played on this PC (ended now). */
    play(gameId: string, minutes: number, startedAt?: string): PlaySession
    added: Mock<NonNullable<StreamingServiceDeps['library']['addSyncedSessions']>>
  }

  /**
   * LibraryService's session parts over a list of games (the counters as LibraryService keeps them). `recency`: with
   * setSyncedLastPlayed too (the last played relay of the store games a host does not offer).
   */
  function sessionLibrary(games: Game[], recency = false): SessionLibrary {
    const sessions: PlaySession[] = []
    const added = vi.fn(
      (
        list: {
          id: string
          gameId: string
          startedAt: string
          endedAt: string
          minutes: number
          store?: string
        }[],
        from: string
      ): number => {
        let count = 0
        const syncedAt = new Date().toISOString()
        for (const s of list) {
          const g = games.find((x) => x.id === s.gameId)
          if (!g || sessions.some((x) => x.id === s.id)) continue
          sessions.push({ ...s, from, syncedAt })
          g.playtimeMinutes = (g.playtimeMinutes ?? 0) + s.minutes
          g.playCount = (g.playCount ?? 0) + 1
          if (!g.lastPlayed || s.startedAt > g.lastPlayed) g.lastPlayed = s.startedAt
          count++
        }
        return count
      }
    )
    return {
      sessions,
      parts: {
        allSessions: () => sessions,
        addSyncedSessions: added,
        ...(recency
          ? {
              setSyncedLastPlayed: (entries) => {
                let changed = 0
                for (const { id, atMs } of entries) {
                  const g = games.find((x) => x.id === id)
                  if (!g || (g.lastPlayed && Date.parse(g.lastPlayed) >= atMs)) continue
                  g.lastPlayed = new Date(atMs).toISOString()
                  changed++
                }
                return changed
              }
            }
          : {})
      },
      play(gameId, minutes, startedAt = new Date(Date.now() - minutes * 60_000).toISOString()) {
        const s: PlaySession = {
          id: sid(),
          gameId,
          startedAt,
          endedAt: new Date().toISOString(),
          minutes
        }
        sessions.push(s)
        const g = games.find((x) => x.id === gameId)!
        g.playtimeMinutes = (g.playtimeMinutes ?? 0) + minutes
        g.playCount = (g.playCount ?? 0) + 1
        if (!g.lastPlayed || startedAt > g.lastPlayed) g.lastPlayed = startedAt
        return s
      },
      added
    }
  }

  async function host(
    games: Game[],
    patch: (s: Settings) => void = () => {},
    secrets?: SecretsStore,
    recency = false
  ): Promise<{ s: Setup; handlers: HostHandlers; lib: SessionLibrary }> {
    const calls: string[] = []
    const { io, server } = hostIo(calls)
    const lib = sessionLibrary(games, recency)
    const s = await setup({
      io,
      calls,
      games,
      remoteView: lib.parts,
      ...(secrets ? { secrets } : {}),
      settings: (x) => {
        x.streaming.hostEnabled = true
        patch(x)
      }
    })
    await s.service.start()
    await s.service.idle()
    return { s, handlers: server.deps!.handlers, lib }
  }

  type Exchange = NonNullable<HostConnection['playtime']>

  /**
   * A client paired with host-1 that offers `offer` (with its clock, as an updated host does), whose play time
   * exchange goes to `playtime`.
   */
  async function client(
    games: Game[],
    offer: () => Promise<unknown[]>,
    playtime: Exchange | undefined,
    patch: (s: Settings) => void = () => {},
    options: {
      alsoClient?: boolean
      dataDir?: string
      recency?: boolean
      /** This PC's clock (the service's). */
      now?: () => number
    } = {}
  ): Promise<{ s: Setup; playtime: Mock<Exchange> | undefined; lib: SessionLibrary }> {
    const dir = options.dataDir ?? (await tempDir())
    const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
    if (options.alsoClient)
      await secrets.update((d) => {
        d.clients.push({
          id: 'host-1',
          name: 'Living Room',
          tokenHash: 'ab'.repeat(32),
          pairedAt: '2026-11-01T00:00:00.000Z'
        } as never)
      })
    const spy = playtime ? vi.fn(playtime) : undefined
    const lib = sessionLibrary(games, options.recency)
    const s = await setup({
      secrets,
      games,
      remoteView: lib.parts,
      playtime: { afterGameMs: 50 },
      settings: patch,
      dataDir: dir,
      io: {
        hostClient: clientIo({
          '192.168.1.5': fakeConnection({
            library: offer,
            libraryAt: async () => ({ games: await offer(), now: Date.now() }),
            ...(spy ? { playtime: spy } : {})
          })
        }),
        ...(options.now ? { now: options.now } : {})
      }
    })
    await s.service.start()
    return { s, playtime: spy, lib }
  }

  /** A client of the host `h`, as the PC `id`. */
  const viaHost = (
    h: { handlers: HostHandlers },
    id: string
  ): { offer: () => Promise<unknown[]>; exchange: Exchange } => ({
    offer: async () => (await h.handlers.library(ctxOf(id))) as unknown[],
    exchange: (async (request) =>
      h.handlers.playtime!(ctxOf(id), request as Record<string, unknown>)) as Exchange
  })

  const wireSession = (id: string, game: string, minutes = 30): Record<string, unknown> => ({
    id,
    game,
    startedAt: '2026-11-10T10:00:00.000Z',
    endedAt: '2026-11-10T10:30:00.000Z',
    minutes
  })

  it('as host: takes the sessions of games it offers once, and answers with its own of the games asked, a page at a time', async () => {
    const games = [
      game({ id: 'steam:1', source: 'steam', title: 'A' }),
      game({ id: 'steam:2', source: 'steam', title: 'B', hidden: true })
    ]
    const { handlers, lib } = await host(games)
    const send = {
      sessions: [
        wireSession('s_c1', 'steam:1'),
        // Not offered (hidden) or unknown: not the client's to change.
        wireSession('s_c2', 'steam:2'),
        wireSession('s_c3', 'steam:404'),
        'junk'
      ],
      now: Date.now()
    }
    expect(handlers.playtime!(ctxOf('client-1'), send)).toMatchObject({ took: 1, sessions: [] })
    expect(games[0]).toMatchObject({ playtimeMinutes: 30, playCount: 1 })
    expect(games[1].playtimeMinutes ?? 0).toBe(0)
    // The same again (a repeat): nothing counted twice.
    expect(handlers.playtime!(ctxOf('client-1'), send)).toMatchObject({ took: 0 })
    expect(games[0]).toMatchObject({ playtimeMinutes: 30, playCount: 1 })
    expect(lib.sessions.find((s) => s.id === 's_c1')).toMatchObject({ from: 'client-1' })

    for (let i = 0; i < 501; i++) lib.play('steam:1', 1)
    lib.play('steam:2', 5) // hidden: never answered
    const first = handlers.playtime!(ctxOf('client-1'), {
      games: ['steam:1', 'steam:2', 'steam:404'],
      after: null,
      now: Date.now()
    })!
    // Not the client's own session back; the first 500 of this PC's.
    expect(first.sessions).toHaveLength(500)
    expect(first.sessions.some((s) => (s as { id: string }).id === 's_c1')).toBe(false)
    expect(first.more).toBe(true)
    const second = handlers.playtime!(ctxOf('client-1'), {
      games: ['steam:1'],
      after: first.next,
      now: Date.now()
    })!
    expect(second.sessions).toHaveLength(1)
    expect(second.more).toBe(false)
    expect(second.sessions[0]).toMatchObject({ game: 'steam:1', minutes: 1 })
    // Another client gets client-1's session too (passed on).
    const other = handlers.playtime!(ctxOf('client-2'), {
      games: ['steam:1'],
      after: null,
      now: Date.now()
    })!
    expect(other.sessions.some((s) => (s as { id: string }).id === 's_c1')).toBe(true)
  })

  it("as host: corrects the client's clock", async () => {
    const games = [game({ id: 'steam:1', source: 'steam', title: 'A' })]
    const { handlers, lib } = await host(games)
    const skew = 3_600_000 // the client's clock is an hour ahead
    handlers.playtime!(ctxOf('client-1'), {
      sessions: [
        {
          ...wireSession('s_c1', 'steam:1'),
          startedAt: '2026-11-10T11:00:00.000Z',
          endedAt: '2026-11-10T11:30:00.000Z'
        }
      ],
      now: Date.now() + skew
    })
    const at = Date.parse(lib.sessions[0].startedAt)
    expect(Math.abs(at - Date.parse('2026-11-10T10:00:00.000Z'))).toBeLessThan(5_000)
  })

  it("as host: nothing while off, nor with a PC that is this PC's own host", async () => {
    const games = [game({ id: 'steam:1', source: 'steam', title: 'A' })]
    const off = await host(games, (x) => (x.streaming.syncPlaytime = false))
    expect(
      off.handlers.playtime!(ctxOf('client-1'), {
        sessions: [wireSession('s_c1', 'steam:1')],
        now: Date.now()
      })
    ).toBeNull()
    expect(off.lib.added).not.toHaveBeenCalled()
    const dir = await tempDir()
    const secrets = await pairedSecrets(dir, [{ id: 'client-1', address: '192.168.1.30' }])
    const mine = await host(games, () => {}, secrets)
    expect(mine.handlers.playtime!(ctxOf('client-1'), { games: ['steam:1'], now: 1 })).toBeNull()
  })

  it('both PCs end with the union of their sessions of the games they share, counted once, however often they exchange', async () => {
    const released = { releaseDate: '2017-02-24' }
    const hostGames = [
      game({ id: 'steam:620', source: 'steam', title: 'Portal 2' }),
      game({ id: 'steam:9', source: 'steam', title: 'Celeste' }),
      game({ id: 'gog:hk', source: 'gog', title: 'Hollow Knight', metadata: released }),
      game({ id: 'steam:doom', source: 'steam', title: 'Doom', metadata: { releaseDate: '2016' } })
    ]
    const h = await host(hostGames)
    const mine = [
      game({ id: 'steam:620', source: 'steam', title: 'Portal 2' }),
      game({ id: 'epic:hk', source: 'epic', title: 'Hollow Knight', metadata: released }),
      // Same title as the host's, years 1993 and 2016: different games, never exchanged.
      game({ id: 'gog:doom', source: 'gog', title: 'Doom', metadata: { releaseDate: '1993' } }),
      game({ id: 'steam:only-here', source: 'steam', title: 'Only Here' })
    ]
    const hostPortal = h.lib.play('steam:620', 60, '2026-11-01T10:00:00.000Z')
    h.lib.play('steam:9', 20) // host-only game: stays on the host
    h.lib.play('gog:hk', 40)
    h.lib.play('steam:doom', 10)
    const peer = viaHost(h, 'client-1')
    const { s, playtime, lib } = await client(mine, peer.offer, peer.exchange)
    lib.play('steam:620', 15, '2026-11-12T10:00:00.000Z')
    lib.play('epic:hk', 5)
    lib.play('gog:doom', 7)
    lib.play('steam:only-here', 3)
    await s.service.refreshRemoteLibrary()
    await until(() => (mine[0].playtimeMinutes ?? 0) === 75)
    await s.service.idle()
    await until(() => (mine[1].playtimeMinutes ?? 0) === 45)
    expect(mine[0]).toMatchObject({ playCount: 2, lastPlayed: '2026-11-12T10:00:00.000Z' })
    expect(mine[2].playtimeMinutes).toBe(7)
    expect(mine[3].playtimeMinutes).toBe(3)
    expect(hostGames[0]).toMatchObject({ playtimeMinutes: 75, playCount: 2 })
    expect(hostGames[2]).toMatchObject({ playtimeMinutes: 45, playCount: 2 })
    expect(hostGames[3].playtimeMinutes).toBe(10)
    expect(lib.sessions.find((x) => x.id === hostPortal.id)).toMatchObject({ from: 'host-1' })
    // Again and again: nothing more is counted, and only what is new crosses.
    const calls = playtime!.mock.calls.length
    await s.service.refreshRemoteLibrary()
    await until(() => playtime!.mock.calls.length > calls)
    await later(100)
    await s.service.refreshRemoteLibrary()
    await later(100)
    expect(mine[0]).toMatchObject({ playtimeMinutes: 75, playCount: 2 })
    expect(hostGames[0]).toMatchObject({ playtimeMinutes: 75, playCount: 2 })
    for (const [request] of playtime!.mock.calls.slice(calls))
      expect((request.sessions ?? []).length).toBe(0)
    // Every request is bounded.
    for (const [request] of playtime!.mock.calls)
      expect((request.sessions ?? []).length).toBeLessThanOrEqual(500)
  })

  it("a store's session goes to the other PC's copy of that store, naming the store (its total counts it there)", async () => {
    const released = { releaseDate: '2017-02-24' }
    const hostGames = [
      game({ id: 'gog:hk', source: 'gog', title: 'Hollow Knight', metadata: released }),
      game({ id: 'steam:hk', source: 'steam', title: 'Hollow Knight', metadata: released })
    ]
    const h = await host(hostGames)
    const hostSteam = h.lib.play('steam:hk', 40)
    const hostGog = h.lib.play('gog:hk', 10)
    const mine = [
      // The preferred copy here is GOG; the Steam copy reads the account's Steam total.
      game({
        id: 'gog:hk2',
        source: 'gog',
        title: 'Hollow Knight',
        metadata: released,
        user: { preferredCopy: true }
      }),
      game({ id: 'steam:hk', source: 'steam', title: 'Hollow Knight', metadata: released })
    ]
    const peer = viaHost(h, 'client-1')
    const { s, lib } = await client(mine, peer.offer, peer.exchange)
    const mySteam = lib.play('steam:hk', 5)
    await s.service.refreshRemoteLibrary()
    await until(() => lib.sessions.some((x) => x.id === hostSteam.id))
    await until(() => h.lib.sessions.some((x) => x.id === mySteam.id))
    await s.service.idle()
    const taken = lib.added.mock.calls.flatMap(([list]) => list)
    // The host's Steam session: on this PC's Steam copy, with its store; the GOG one on the preferred copy, without.
    expect(taken.find((x) => x.id === hostSteam.id)).toMatchObject({
      gameId: 'steam:hk',
      store: 'steam'
    })
    const gogTaken = taken.find((x) => x.id === hostGog.id)!
    expect(gogTaken.gameId).toBe('gog:hk2')
    expect(gogTaken).not.toHaveProperty('store')
    // This PC's Steam session: on the host's Steam copy, with its store.
    expect(
      h.lib.added.mock.calls.flatMap(([list]) => list).find((x) => x.id === mySteam.id)
    ).toMatchObject({ gameId: 'steam:hk', store: 'steam' })
  })

  it('a session played here goes to the host soon after the game ends; a stream of a host game is timed on the host only', async () => {
    const hostGames = [game({ id: 'steam:620', source: 'steam', title: 'Portal 2' })]
    const h = await host(hostGames)
    const mine = [game({ id: 'steam:620', source: 'steam', title: 'Portal 2' })]
    const peer = viaHost(h, 'client-1')
    const { s, lib } = await client(mine, peer.offer, peer.exchange)
    await s.service.refreshRemoteLibrary()
    await s.service.idle()
    const played = lib.play('steam:620', 25)
    s.events.emit('session:ended', {
      gameId: 'steam:620',
      startedAt: played.startedAt,
      endedAt: played.endedAt!,
      minutes: 25
    })
    await until(() => hostGames[0].playtimeMinutes === 25)
    // Streaming the host's game: the host plays and times it; the client only takes that session.
    h.lib.play('steam:620', 50)
    await s.service.refreshRemoteLibrary()
    await until(() => mine[0].playtimeMinutes === 75)
    await later(100)
    expect(hostGames[0].playtimeMinutes).toBe(75)
    expect(lib.sessions.filter((x) => !x.from)).toHaveLength(1)
  })

  it('a session from client A reaches client B through the host, and never goes back to A as a new one', async () => {
    const hostGames = [game({ id: 'steam:620', source: 'steam', title: 'Portal 2' })]
    const h = await host(hostGames)
    const peerOf = async (
      id: string
    ): Promise<{ s: Setup; lib: SessionLibrary; games: Game[] }> => {
      const games = [game({ id: 'steam:620', source: 'steam', title: 'Portal 2' })]
      const p = viaHost(h, id)
      const c = await client(games, p.offer, p.exchange)
      return { ...c, games }
    }
    const a = await peerOf('client-a')
    const b = await peerOf('client-b')
    a.lib.play('steam:620', 30)
    await a.s.service.refreshRemoteLibrary()
    await until(() => hostGames[0].playtimeMinutes === 30)
    await b.s.service.refreshRemoteLibrary()
    await until(() => b.games[0].playtimeMinutes === 30)
    await b.s.service.refreshRemoteLibrary()
    await a.s.service.refreshRemoteLibrary()
    await later(150)
    expect(a.games[0]).toMatchObject({ playtimeMinutes: 30, playCount: 1 })
    expect(b.games[0]).toMatchObject({ playtimeMinutes: 30, playCount: 1 })
    expect(hostGames[0]).toMatchObject({ playtimeMinutes: 30, playCount: 1 })
  })

  it('a game matched later gets its whole history, though the cursors are past it', async () => {
    const hostGames = [
      game({ id: 'steam:620', source: 'steam', title: 'Portal 2' }),
      game({ id: 'steam:9', source: 'steam', title: 'Celeste' })
    ]
    const h = await host(hostGames)
    h.lib.play('steam:9', 20)
    const mine = [game({ id: 'steam:620', source: 'steam', title: 'Portal 2' })]
    const peer = viaHost(h, 'client-1')
    const { s, playtime } = await client(mine, peer.offer, peer.exchange)
    h.lib.play('steam:620', 5)
    await s.service.refreshRemoteLibrary()
    await until(() => mine[0].playtimeMinutes === 5)
    // Celeste installed here now: its sessions on the host (older than the cursor) come too.
    const celeste = game({ id: 'steam:9', source: 'steam', title: 'Celeste' })
    mine.push(celeste)
    const before = playtime!.mock.calls.length
    await s.service.refreshRemoteLibrary()
    await until(() => celeste.playtimeMinutes === 20)
    expect(playtime!.mock.calls.length).toBeGreaterThan(before)
    expect(mine[0].playtimeMinutes).toBe(5)
  })

  it('as client: nothing is sent or taken while off; switched on, it goes at once', async () => {
    const hostGames = [game({ id: 'steam:620', source: 'steam', title: 'Portal 2' })]
    const h = await host(hostGames)
    h.lib.play('steam:620', 10)
    const mine = [game({ id: 'steam:620', source: 'steam', title: 'Portal 2' })]
    const peer = viaHost(h, 'client-1')
    const { s, playtime } = await client(
      mine,
      peer.offer,
      peer.exchange,
      (x) => (x.streaming.syncPlaytime = false)
    )
    await s.service.refreshRemoteLibrary()
    s.events.emit('session:ended', {
      gameId: 'steam:620',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      minutes: 1
    })
    await later(200)
    expect(playtime).not.toHaveBeenCalled()
    expect(mine[0].playtimeMinutes ?? 0).toBe(0)
    s.settings.set((x) => (x.streaming.syncPlaytime = true))
    await until(() => mine[0].playtimeMinutes === 10)
  })

  it('as client: an older host (no endpoint, or one read as null) changes nothing', async () => {
    const hostGames = [game({ id: 'steam:620', source: 'steam', title: 'Portal 2' })]
    const mine = [game({ id: 'steam:620', source: 'steam', title: 'Portal 2' })]
    const wire = async (): Promise<unknown[]> => JSON.parse(JSON.stringify(hostGames)) as unknown[]
    const old = await client(mine, wire, async () => null)
    old.lib.play('steam:620', 10)
    await old.s.service.refreshRemoteLibrary()
    await until(() => old.playtime!.mock.calls.length === 1)
    await later(100)
    // It stopped at the first refusal: nothing asked for, nothing taken.
    expect(old.playtime).toHaveBeenCalledTimes(1)
    expect(mine[0].playtimeMinutes).toBe(10)
    expect(old.lib.added).not.toHaveBeenCalled()
    const older = await client(
      [game({ id: 'steam:620', source: 'steam', title: 'Portal 2' })],
      wire,
      undefined
    )
    await older.s.service.refreshRemoteLibrary()
    await later(100)
    expect(older.lib.added).not.toHaveBeenCalled()
  })

  it('as client: nothing with a host that is also its client', async () => {
    const mine = [game({ id: 'steam:620', source: 'steam', title: 'Portal 2' })]
    const { s, playtime, lib } = await client(
      mine,
      async () => [game({ id: 'steam:620', source: 'steam', title: 'Portal 2' })],
      async () => ({ took: 0, sessions: [], next: null, more: false, now: Date.now() }),
      () => {},
      { alsoClient: true }
    )
    lib.play('steam:620', 5)
    await s.service.refreshRemoteLibrary()
    await later(200)
    expect(playtime).not.toHaveBeenCalled()
  })
  describe('when a store game the host does not offer was last played (the last played relay)', () => {
    const store = (id: string, over: Partial<Game> = {}): Game =>
      game({ id, source: id.split(':')[0] as Game['source'], title: id, ...over })
    const ownedOnly = (id: string, over: Partial<Game> = {}): Game =>
      store(id, { installed: false, owned: true, ...over })
    const playedOf = (games: Game[]): Record<string, string | undefined> =>
      Object.fromEntries(games.map((g) => [g.id, g.lastPlayed]))
    /** A refresh and the exchange that follows it. */
    const sync = async (c: { s: Setup }): Promise<void> => {
      await c.s.service.refreshRemoteLibrary()
      await c.s.service.idle()
    }

    it("another client's play of a game the host lacks reaches a client that owns it, date only; a game only that client has never does", async () => {
      // The host has no copy of the GOG and Steam games, and only an owned, not installed record of steam:888.
      const hGames = [store('steam:620'), ownedOnly('steam:888')]
      const h = await host(hGames, undefined, undefined, true)
      // B has them installed and plays them; steam:55 is B's alone.
      const bGames = [store('gog:777'), store('steam:777'), store('steam:888'), store('steam:55')]
      const pb = viaHost(h, 'client-b')
      const b = await client(bGames, pb.offer, pb.exchange, undefined, { recency: true })
      // A's accounts own them, not installed; its ROM record is no store game.
      const aGames = [
        ownedOnly('gog:777'),
        ownedOnly('steam:777'),
        ownedOnly('steam:888'),
        game({ id: 'rom:snes/z.sfc', source: 'rom', title: 'Z', installed: false })
      ]
      const pa = viaHost(h, 'client-a')
      const a = await client(aGames, pa.offer, pa.exchange, undefined, { recency: true })
      await sync(a)
      expect(playedOf(aGames)).toEqual({})

      const gog = b.lib.play('gog:777', 30, '2026-11-18T18:00:00.000Z')
      const steam = b.lib.play('steam:777', 30, '2026-11-19T18:00:00.000Z')
      const onHostRecord = b.lib.play('steam:888', 30, '2026-11-20T18:00:00.000Z')
      b.lib.play('steam:55', 30, '2026-11-21T18:00:00.000Z')
      await sync(b)
      await sync(a)
      // A's own records are dated by B's play: with `owned` they are in A's Recent row (lib/recent.ts).
      expect(playedOf(aGames)).toEqual({
        'gog:777': gog.startedAt,
        'steam:777': steam.startedAt,
        'steam:888': onHostRecord.startedAt
      })
      // The date only: no play time, no play count, no session, here or on the host.
      expect(aGames.map((g) => [g.playtimeMinutes, g.playCount])).toEqual(aGames.map(() => [0, 0]))
      expect(a.lib.added).not.toHaveBeenCalled()
      expect(h.lib.sessions).toEqual([])
      // The host only passes the dates on: its own records (a game it does not offer) are not the clients' to change.
      expect(playedOf(hGames)).toEqual({})
      // A game only B has: no record of it appears on A, no card either.
      expect(aGames.map((g) => g.id)).not.toContain('steam:55')
      expect((await a.s.service.remoteLibrary()).games.map((g) => g.id)).toEqual([
        'remote:host-1:steam:620'
      ])
      // Again and again: nothing more changes, and B never gets its own dates back as later ones.
      const before = JSON.stringify([aGames, bGames, hGames])
      await sync(a)
      await sync(b)
      await sync(a)
      expect(JSON.stringify([aGames, bGames, hGames])).toBe(before)
    })

    it("the host's own play of a game it no longer has installed reaches the client that owns it; a hidden game's never leaves", async () => {
      const lastPlayed = '2026-11-12T18:00:00.000Z'
      const h = await host(
        [
          ownedOnly('steam:888', { lastPlayed }),
          ownedOnly('steam:889', { lastPlayed, hidden: true })
        ],
        undefined,
        undefined,
        true
      )
      const bGames = [
        store('steam:1', { lastPlayed, hidden: true }),
        store('steam:2', { lastPlayed })
      ]
      const pb = viaHost(h, 'client-b')
      const b = await client(bGames, pb.offer, pb.exchange, undefined, { recency: true })
      const aGames = [
        ownedOnly('steam:888'),
        ownedOnly('steam:889'),
        ownedOnly('steam:1'),
        ownedOnly('steam:2')
      ]
      const pa = viaHost(h, 'client-a')
      const a = await client(aGames, pa.offer, pa.exchange, undefined, { recency: true })
      await sync(b)
      expect(b.playtime!.mock.calls[0]![0].recent).toEqual([
        { game: 'steam:2', at: Date.parse(lastPlayed) }
      ])
      await sync(a)
      expect(playedOf(aGames)).toEqual({ 'steam:888': lastPlayed, 'steam:2': lastPlayed })
    })

    it('only while both PCs sync play time', async () => {
      const lastPlayed = '2026-11-12T18:00:00.000Z'
      const sent = { recent: [{ game: 'gog:777', at: Date.parse(lastPlayed) }], now: Date.now() }
      const off = await host(
        [],
        (x) => {
          x.streaming.syncPlaytime = false
        },
        undefined,
        true
      )
      expect(off.handlers.playtime!(ctxOf('client-b'), sent)).toBeNull()
      const h = await host([], undefined, undefined, true)
      expect(h.handlers.playtime!(ctxOf('client-b'), sent)).toMatchObject({ recent: [] })
      // A client with the switch off neither sends its dates nor takes the others'.
      const aGames = [ownedOnly('gog:777'), store('steam:3', { lastPlayed })]
      const pa = viaHost(h, 'client-a')
      const a = await client(
        aGames,
        pa.offer,
        pa.exchange,
        (x) => {
          x.streaming.syncPlaytime = false
        },
        { recency: true }
      )
      await sync(a)
      expect(a.playtime).not.toHaveBeenCalled()
      expect(aGames[0].lastPlayed).toBeUndefined()
      a.s.settings.set((x) => {
        x.streaming.syncPlaytime = true
      })
      await until(() => aGames[0].lastPlayed === lastPlayed)
      const want = ['gog:777', 'steam:3']
      expect(
        h.handlers.playtime!(ctxOf('client-c'), { recent: [], want, now: Date.now() })!.recent
      ).toEqual([
        { game: 'gog:777', at: Date.parse(lastPlayed) },
        { game: 'steam:3', at: Date.parse(lastPlayed) }
      ])
    })

    it('as host: tells a PC only about the games it names, never what else the other PCs or the host own', async () => {
      const lastPlayed = '2026-11-12T18:00:00.000Z'
      const at = Date.parse(lastPlayed)
      // The host's own record of a game it does not offer, and client A's two games.
      const h = await host([ownedOnly('steam:888', { lastPlayed })], undefined, undefined, true)
      const ask = (id: string, body: Record<string, unknown>): unknown =>
        h.handlers.playtime!(ctxOf(id), { now: Date.now(), ...body })!.recent
      const sent = [
        { game: 'steam:55', at },
        { game: 'gog:777', at }
      ]
      ask('client-a', { recent: sent })
      // Naming nothing: told nothing (not the ids and dates of games only another PC has).
      expect(ask('client-c', { recent: [] })).toEqual([])
      expect(ask('client-c', { recent: [], want: 'all' })).toEqual([])
      expect(ask('client-c', { recent: [], want: ['rom:snes/z.sfc', 7] })).toEqual([])
      // Named in `want` (a game it owns, played or not), or by a date of its own.
      expect(ask('client-c', { recent: [], want: ['gog:777', 'gog:404'] })).toEqual([
        { game: 'gog:777', at }
      ])
      expect(ask('client-c', { recent: [], want: ['steam:888'] })).toEqual([
        { game: 'steam:888', at }
      ])
      expect(ask('client-d', { recent: [{ game: 'steam:55', at: at - 3_600_000 }] })).toEqual([
        { game: 'steam:55', at }
      ])
      // A client asks about its own games: the ones the host does not offer, played here or not.
      const eGames = [ownedOnly('gog:777'), store('steam:9', { lastPlayed })]
      const pe = viaHost(h, 'client-e')
      const e = await client(eGames, pe.offer, pe.exchange, undefined, { recency: true })
      await sync(e)
      expect(e.playtime!.mock.calls[0]![0]).toMatchObject({
        recent: [{ game: 'steam:9', at }],
        want: ['gog:777', 'steam:9']
      })
      expect(playedOf(eGames)).toEqual({ 'gog:777': lastPlayed, 'steam:9': lastPlayed })
    })

    it('a date that went to another PC and came back is not a later play: clocks apart and a slow network change nothing more', async () => {
      const h = await host([], undefined, undefined, true)
      /** A client whose clock is `skew` off the host's, each request taking a while each way. */
      const skewed = async (
        id: string,
        games: Game[],
        skew: number
      ): Promise<() => Promise<void>> => {
        const peer = viaHost(h, id)
        let answered = 0
        const exchange: Exchange = async (request) => {
          await later(25)
          const answer = await peer.exchange(request)
          await later(25)
          answered++
          return answer
        }
        const c = await client(games, peer.offer, exchange, undefined, {
          recency: true,
          now: () => Date.now() + skew
        })
        // A refresh, and its exchange answered and taken.
        return async () => {
          const had = answered
          await sync(c)
          await until(() => answered > had)
          await later(20)
        }
      }
      // B (5 s behind) played an hour ago; A (5 s ahead) owns the game, not installed.
      const played = new Date(Date.now() - 5000 - 3_600_000).toISOString()
      const bGames = [store('gog:777', { lastPlayed: played })]
      const aGames = [ownedOnly('gog:777')]
      const syncB = await skewed('client-b', bGames, -5000)
      const syncA = await skewed('client-a', aGames, 5000)
      await syncB()
      await syncA()
      // On A's clock B's play is 10 s later (within the requests' own timing).
      const onA = Date.parse(aGames[0].lastPlayed!)
      expect(Math.abs(onA - (Date.parse(played) + 10_000))).toBeLessThan(1000)
      const told = (): unknown =>
        h.handlers.playtime!(ctxOf('client-z'), { recent: [], want: ['gog:777'], now: Date.now() })!
          .recent
      const before = JSON.stringify([aGames, bGames, told()])
      for (let round = 0; round < 4; round++) {
        await syncB()
        await syncA()
      }
      // B's own date is still its own play, A's the one it took, and the host's the one B sent first.
      expect(bGames[0].lastPlayed).toBe(played)
      expect(JSON.stringify([aGames, bGames, told()])).toBe(before)
    })

    it('as host: a client no longer listing a game, or no longer paired, takes its dates with it', async () => {
      const at = Date.parse('2026-11-12T18:00:00.000Z')
      const h = await host([], undefined, undefined, true)
      const want = ['gog:1', 'gog:2']
      const told = (): unknown =>
        h.handlers.playtime!(ctxOf('client-b'), { recent: [], want, now: Date.now() })!.recent
      const send = (recent: unknown): unknown =>
        h.handlers.playtime!(ctxOf('client-a'), { recent, now: Date.now() })
      send([
        { game: 'gog:1', at },
        { game: 'gog:2', at }
      ])
      expect(told()).toHaveLength(2)
      // A hid gog:1: it no longer sends it, and B is no longer told.
      send([{ game: 'gog:2', at }])
      expect(told()).toEqual([{ game: 'gog:2', at }])
      // A list that is none changes nothing.
      send('all')
      expect(told()).toEqual([{ game: 'gog:2', at }])
      // A is removed in Settings.
      await h.s.service.removeClient('client-a')
      expect(told()).toEqual([])
      // The same when a client unpairs itself.
      h.handlers.playtime!(ctxOf('client-c'), { recent: [{ game: 'gog:2', at }], now: Date.now() })
      expect(told()).toEqual([{ game: 'gog:2', at }])
      await h.handlers.unpair(ctxOf('client-c'))
      expect(told()).toEqual([])
    })

    it("as host: puts the dates on its own clock, never ahead of it, and takes only a store game's", async () => {
      const h = await host([], undefined, undefined, true)
      const t = Date.now()
      const hour = 3_600_000
      // The client's clock runs an hour ahead.
      h.handlers.playtime!(ctxOf('client-b'), {
        recent: [
          { game: 'gog:1', at: t - 2 * hour },
          // "Now" on its clock, and a date an hour past that: both are now here at the latest.
          { game: 'gog:2', at: t + hour },
          { game: 'gog:3', at: t + 2 * hour },
          // More than a day ahead: a wrong clock, dropped.
          { game: 'gog:4', at: t + 30 * hour },
          { game: 'rom:snes/z.sfc', at: t - hour },
          { game: 'manual:abc', at: t - hour },
          { game: 'gog:5', at: 'yesterday' },
          { game: 'gog:6' },
          'junk'
        ],
        now: t + hour
      })
      const want = ['gog:1', 'gog:2', 'gog:3', 'gog:4', 'gog:5', 'gog:6', 'rom:snes/z.sfc']
      const told = h.handlers.playtime!(ctxOf('client-a'), { recent: [], want, now: Date.now() })!
        .recent as { game: string; at: number }[]
      expect(told.map((e) => e.game).sort()).toEqual(['gog:1', 'gog:2', 'gog:3'])
      const at = Object.fromEntries(told.map((e) => [e.game, e.at]))
      expect(Math.abs(at['gog:1'] - (t - 3 * hour))).toBeLessThan(5000)
      expect(Math.abs(at['gog:2'] - t)).toBeLessThan(5000)
      for (const e of told) expect(e.at).toBeLessThanOrEqual(Date.now())
      // Not a list, or one too long: nothing is taken and nothing answered.
      for (const recent of ['all', Array.from({ length: 501 }, () => ({ game: 'gog:9', at: t }))])
        expect(h.handlers.playtime!(ctxOf('client-b'), { recent, now: t })).not.toHaveProperty(
          'recent'
        )
      // The sender never gets its own dates back.
      expect(h.handlers.playtime!(ctxOf('client-b'), { recent: [], now: t })!.recent).toEqual([])
    })

    it('as client: an older host (no dates in its answer) still exchanges the sessions, and a junk answer changes nothing', async () => {
      const hostGames = [store('steam:620')]
      const h = await host(hostGames)
      const older = viaHost(h, 'client-a')
      // First as an older host answers (no dates at all), then two answers that are no dates of this PC's games.
      const answers: unknown[] = [
        undefined,
        'soon',
        [
          { game: 'rom:snes/z.sfc', at: 5 },
          { game: 'gog:404', at: 5 }
        ]
      ]
      const asked: unknown[] = []
      const exchange: Exchange = async (request) => {
        const answer = await older.exchange(request)
        if (!answer || request.recent === undefined) return answer
        asked.push(request.recent)
        const rest = { ...answer }
        delete rest.recent
        const recent = answers.shift()
        return recent === undefined ? rest : { ...rest, recent }
      }
      const aGames = [store('steam:620'), ownedOnly('gog:777')]
      const a = await client(aGames, older.offer, exchange, undefined, { recency: true })
      a.lib.play('steam:620', 10)
      await sync(a)
      await sync(a)
      await sync(a)
      await until(() => hostGames[0].playCount === 1)
      // Asked each time, for the game the host does not offer only (it has no date of its own to send yet).
      expect(asked).toEqual([[], [], []])
      expect(aGames[1].lastPlayed).toBeUndefined()
      expect(aGames).toHaveLength(2)
    })
  })

  describe('when a game only the host has was last played', () => {
    const portalOf = (over: Partial<Game> = {}): Game =>
      game({ id: 'steam:620', source: 'steam', title: 'Portal 2', ...over })
    const cardOf = async (s: Setup, id = 'remote:host-1:steam:620'): Promise<Game | undefined> =>
      (await s.service.remoteLibrary()).games.find((g) => g.id === id)

    it("the host's own play shows on the client's card; a game the host never played has none", async () => {
      const hostGames = [portalOf(), game({ id: 'steam:9', source: 'steam', title: 'Celeste' })]
      const h = await host(hostGames)
      const peer = viaHost(h, 'client-1')
      const { s, lib } = await client([], peer.offer, peer.exchange)
      await s.service.refreshRemoteLibrary()
      expect(await cardOf(s)).toBeDefined()
      expect(await cardOf(s)).not.toHaveProperty('lastPlayed')
      const played = h.lib.play('steam:620', 40)
      await s.service.refreshRemoteLibrary()
      // The date only: the play time and the play count are the host's.
      expect(await cardOf(s)).toMatchObject({
        lastPlayed: played.startedAt,
        playtimeMinutes: 0,
        playCount: 0
      })
      expect(await cardOf(s, 'remote:host-1:steam:9')).not.toHaveProperty('lastPlayed')
      // No copy here: no session is taken for it.
      await s.service.idle()
      expect(lib.added).not.toHaveBeenCalled()
    })

    it("another client's play reaches a client without the game through the host; a game only that client has never does", async () => {
      const hostGames = [portalOf()]
      const h = await host(hostGames)
      const aGames = [portalOf(), game({ id: 'steam:77', source: 'steam', title: 'Only On A' })]
      const pa = viaHost(h, 'client-a')
      const a = await client(aGames, pa.offer, pa.exchange)
      const pb = viaHost(h, 'client-b')
      const b = await client([], pb.offer, pb.exchange)
      const startedAt = '2026-11-20T18:00:00.000Z'
      a.lib.play('steam:620', 30, startedAt)
      a.lib.play('steam:77', 30, '2026-11-21T18:00:00.000Z')
      await a.s.service.refreshRemoteLibrary()
      await until(() => hostGames[0].playCount === 1)
      await a.s.service.idle()
      await b.s.service.refreshRemoteLibrary()
      expect(await cardOf(b.s)).toMatchObject({ lastPlayed: startedAt })
      // The host has no copy of A's other game: nothing of it is kept on the host or shown on B.
      expect(h.lib.sessions.map((x) => x.gameId)).toEqual(['steam:620'])
      expect((await b.s.service.remoteLibrary()).games.map((g) => g.title)).toEqual(['Portal 2'])
    })

    it('only while both PCs sync play time; the switch turned on here shows it at once', async () => {
      const lastPlayed = '2026-11-20T18:00:00.000Z'
      const off = await host([portalOf({ lastPlayed })], (x) => {
        x.streaming.syncPlaytime = false
      })
      expect((await off.handlers.library(ctxOf('client-1')))[0]).not.toHaveProperty('lastPlayed')
      const h = await host([portalOf({ lastPlayed, favorite: true })])
      expect((await h.handlers.library(ctxOf('client-1')))[0]).toMatchObject({
        lastPlayed,
        favorite: true
      })
      const peer = viaHost(h, 'client-1')
      const { s } = await client([], peer.offer, peer.exchange, (x) => {
        x.streaming.syncPlaytime = false
      })
      await s.service.refreshRemoteLibrary()
      expect(await cardOf(s)).toBeDefined()
      expect(await cardOf(s)).not.toHaveProperty('lastPlayed')
      s.settings.set((x) => {
        x.streaming.syncPlaytime = true
      })
      expect(await cardOf(s)).toMatchObject({ lastPlayed })
      s.settings.set((x) => {
        x.streaming.syncPlaytime = false
      })
      expect(await cardOf(s)).not.toHaveProperty('lastPlayed')
    })

    it("is dated on this PC's clock when the host's clock differs; an older host (no clock) shows none", async () => {
      const lastPlayed = '2026-11-20T18:00:00.000Z'
      const offer = [{ ...portalOf({ lastPlayed }), mediaKinds: [] }]
      const clientOf = async (libraryAt: HostConnection['libraryAt']): Promise<Setup> => {
        const dir = await tempDir()
        const s = await setup({
          secrets: await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }]),
          dataDir: dir,
          io: {
            hostClient: clientIo({
              '192.168.1.5': fakeConnection({ library: async () => offer, libraryAt })
            })
          }
        })
        await s.service.start()
        await s.service.refreshRemoteLibrary()
        return s
      }
      // The host's clock runs an hour ahead.
      const ahead = await clientOf(async () => ({ games: offer, now: Date.now() + 3_600_000 }))
      const shown = Date.parse((await cardOf(ahead))!.lastPlayed!)
      expect(Math.abs(shown - (Date.parse(lastPlayed) - 3_600_000))).toBeLessThan(5000)
      // A host that sends no clock is an older PlayOut: it sends its dates even while its own Sync play time is off,
      // so they are not shown (0.9.5 never showed them either).
      const older = await clientOf(async () => ({ games: offer }))
      expect(await cardOf(older)).toBeDefined()
      expect(await cardOf(older)).not.toHaveProperty('lastPlayed')
      const junk = await clientOf(async () => ({ games: offer, now: 'noon' }))
      expect(await cardOf(junk)).not.toHaveProperty('lastPlayed')
      const noLibraryAt = await clientOf(undefined)
      expect(await cardOf(noLibraryAt)).not.toHaveProperty('lastPlayed')
    })

    it("a host's date never lands ahead of this PC's clock", async () => {
      // Dated 3 hours from now by the host, whose clock agrees with this PC's (a store's own date, a wrong time zone).
      const soon = new Date(Date.now() + 3 * 3_600_000).toISOString()
      const offer = [{ ...portalOf({ lastPlayed: soon }), mediaKinds: [] }]
      const dir = await tempDir()
      const s = await setup({
        secrets: await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }]),
        dataDir: dir,
        io: {
          hostClient: clientIo({
            '192.168.1.5': fakeConnection({
              library: async () => offer,
              libraryAt: async () => ({ games: offer, now: Date.now() })
            })
          })
        }
      })
      await s.service.start()
      const before = Date.now()
      await s.service.refreshRemoteLibrary()
      const shown = Date.parse((await cardOf(s))!.lastPlayed!)
      expect(shown).toBeGreaterThanOrEqual(before)
      expect(shown).toBeLessThanOrEqual(Date.now())
    })

    it("keeps a host's dates, on this PC's clock, after a restart away from it", async () => {
      const lastPlayed = '2026-11-20T18:00:00.000Z'
      const offer = [{ ...portalOf({ lastPlayed }), mediaKinds: [] }]
      const restartedAwayFrom = async (
        libraryAt: HostConnection['libraryAt']
      ): Promise<Game | undefined> => {
        const dir = await tempDir()
        const first = await setup({
          secrets: await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }]),
          dataDir: dir,
          io: {
            hostClient: clientIo({
              '192.168.1.5': fakeConnection({ library: async () => offer, libraryAt })
            })
          }
        })
        await first.service.start()
        await first.service.refreshRemoteLibrary()
        const saved = join(dir, 'offers', 'host-1.json')
        let written = false
        await until(() => {
          void fs.stat(saved).then(
            () => (written = true),
            () => undefined
          )
          return written
        })
        // The host is away: its last offer comes from disk.
        const again = await setup({
          secrets: await pairedSecrets(await tempDir(), [{ id: 'host-1', address: '192.168.1.5' }]),
          dataDir: dir,
          io: { hostClient: clientIo({}) }
        })
        await again.service.start()
        return cardOf(again)
      }
      // Its clock ran an hour ahead: the date is still corrected, not taken as the host wrote it.
      const ahead = await restartedAwayFrom(async () => ({
        games: offer,
        now: Date.now() + 3_600_000
      }))
      expect(ahead?.remote?.offline).toBe(true)
      expect(
        Math.abs(Date.parse(ahead!.lastPlayed!) - (Date.parse(lastPlayed) - 3_600_000))
      ).toBeLessThan(5000)
      // An older host's saved offer (the bare list) still shows no dates.
      const older = await restartedAwayFrom(async () => ({ games: offer }))
      expect(older).toBeDefined()
      expect(older).not.toHaveProperty('lastPlayed')
    })

    /** A client whose stream of the host's Portal 2 is on screen; `finish` closes it. */
    const streaming = async (
      hostGame: Game,
      patch: (s: Settings) => void = () => {}
    ): Promise<{ s: Setup; library: Mock<() => Promise<unknown[]>>; finish: () => void }> => {
      const dir = await tempDir()
      const library = vi.fn(
        async () => JSON.parse(JSON.stringify([{ ...hostGame, mediaKinds: [] }])) as unknown[]
      )
      const moonlight = fakeMoonlight()
      moonlight.paired.add('192.168.1.5')
      const child = new FakeChild()
      const s = await setup({
        secrets: await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }]),
        dataDir: dir,
        playtime: { afterGameMs: 30 },
        settings: patch,
        io: {
          hostClient: clientIo({
            '192.168.1.5': fakeConnection({
              library,
              libraryAt: async () => ({ games: await library(), now: Date.now() })
            })
          }),
          createMoonlight: () => ({
            ...moonlight,
            stream: async () => child as unknown as ChildProcess
          }),
          streamingAfterMs: 10
        }
      })
      const sessions = recorder(s.events, 'streaming:session')
      await s.service.start()
      await s.service.refreshRemoteLibrary()
      await s.service.idle()
      await s.service.streamGame('remote:host-1:steam:620')
      await until(() => sessions.some((x) => x.state === 'streaming'))
      return {
        s,
        library,
        finish: () => child.finish(0)
      }
    }

    it('a stream closing asks the host again soon after: the game just streamed is the last played', async () => {
      const hostGame = portalOf()
      const { s, library, finish } = await streaming(hostGame)
      // The host started the game and dated it.
      hostGame.lastPlayed = '2026-11-22T09:00:00.000Z'
      const asked = library.mock.calls.length
      const libraries = recorder(s.events, 'streaming:library')
      finish()
      await until(() => library.mock.calls.length > asked)
      await until(() => libraries.some((l) => l.games[0]?.lastPlayed === hostGame.lastPlayed))
    })

    it('a stream closing asks nothing while the play time sync is off here', async () => {
      const { library, finish } = await streaming(portalOf(), (x) => {
        x.streaming.syncPlaytime = false
      })
      const asked = library.mock.calls.length
      finish()
      await later(150)
      expect(library.mock.calls.length).toBe(asked)
    })
  })
})

describe("a host game's achievements", () => {
  const ctxOf = (id: string): RequestContext => ({
    client: { id, name: id },
    address: '192.168.1.30'
  })
  const portal: AchievementsInfo = {
    provider: 'steam',
    total: 2,
    unlocked: 1,
    list: [
      { id: 'A', name: 'First', unlocked: true },
      { id: 'B', name: 'Second', unlocked: false }
    ]
  }
  const counts = { unlocked: 1, total: 2, updatedAt: '2026-11-01T00:00:00.000Z' }

  async function host(
    games: Game[],
    achievements: StreamingServiceDeps['achievements'] | undefined,
    secrets?: SecretsStore
  ): Promise<HostHandlers> {
    const calls: string[] = []
    const { io, server } = hostIo(calls)
    const s = await setup({
      io,
      calls,
      games,
      ...(achievements ? { achievements } : {}),
      ...(secrets ? { secrets } : {}),
      settings: (x) => (x.streaming.hostEnabled = true)
    })
    await s.service.start()
    await s.service.idle()
    return server.deps!.handlers
  }

  it("as host: offers each game's counts and answers its list by the offered id", async () => {
    const manual = game({
      id: 'manual:c:/users/someone/games/thing.exe',
      source: 'manual',
      title: 'Thing'
    })
    const games = [
      game({
        id: 'steam:620',
        source: 'steam',
        title: 'Portal 2',
        metadata: { achievements: counts }
      }),
      game({ id: 'steam:3', source: 'steam', title: 'Hidden', hidden: true }),
      manual
    ]
    const get = vi.fn(async (id: string) => (id === 'steam:3' ? portal : { ...portal, url: id }))
    const handlers = await host(games, { get })
    const offer = (await handlers.library(ctxOf('client-1'))) as Record<string, unknown>[]
    const entry = offer.find((g) => g.id === 'steam:620')!
    expect(entry.achievements).toEqual({ unlocked: 1, total: 2 })
    expect((entry.metadata as Record<string, unknown>).achievements).toBeUndefined()
    expect(await handlers.achievements!(ctxOf('client-1'), 'steam:620')).toMatchObject({
      url: 'steam:620'
    })
    // A game added by its .exe goes by its stand-in; this PC's service is asked by the real id.
    expect(await handlers.achievements!(ctxOf('client-1'), offeredId(manual))).toMatchObject({
      url: manual.id
    })
    // Not offered (hidden, unknown): none, and the service is not asked.
    expect(await handlers.achievements!(ctxOf('client-1'), 'steam:3')).toBeNull()
    expect(await handlers.achievements!(ctxOf('client-1'), 'steam:404')).toBeNull()
    expect(get.mock.calls.map((c) => c[0])).toEqual(['steam:620', manual.id])
  })

  it("as host: none for a PC that is this PC's own host, or without an achievements service", async () => {
    const games = [game({ id: 'steam:620', source: 'steam', title: 'Portal 2' })]
    const get = vi.fn(async () => portal)
    const dir = await tempDir()
    const secrets = await pairedSecrets(dir, [{ id: 'client-1', address: '192.168.1.30' }])
    const mine = await host(games, { get }, secrets)
    expect(await mine.achievements!(ctxOf('client-1'), 'steam:620')).toBeNull()
    expect(get).not.toHaveBeenCalled()
    const without = await host(games, undefined)
    expect(await without.achievements!(ctxOf('client-1'), 'steam:620')).toBeNull()
  })

  async function client(
    hostGames: Game[],
    over: Partial<HostConnection>,
    games: Game[] = []
  ): Promise<Setup> {
    const dir = await tempDir()
    const secrets = await pairedSecrets(dir, [{ id: 'host-1', address: '192.168.1.5' }])
    const s = await setup({
      secrets,
      games,
      io: {
        hostClient: clientIo({
          '192.168.1.5': fakeConnection({
            library: async () => JSON.parse(JSON.stringify(hostGames)) as unknown[],
            ...over
          })
        })
      }
    })
    await s.service.start()
    return s
  }

  it("as client: a host-only game shows the host's counts and gets its list from the host", async () => {
    // As the host offers it: the counts beside the metadata.
    const hostGames = [
      {
        ...game({ id: 'steam:620', source: 'steam', title: 'Portal 2' }),
        achievements: { unlocked: 1, total: 2 }
      } as Game
    ]
    const achievements = vi.fn(async (id: string) =>
      id === 'steam:620' ? { ...portal, list: [...portal.list, 'junk'] } : null
    )
    const s = await client(hostGames, { achievements })
    const lib = await s.service.refreshRemoteLibrary()
    expect(lib.games[0]).toMatchObject({
      id: 'remote:host-1:steam:620',
      metadata: { achievements: { unlocked: 1, total: 2 } }
    })
    expect(await s.service.achievementsFor('remote:host-1:steam:620')).toEqual(portal)
    expect(achievements).toHaveBeenCalledWith('steam:620')
    // Only games shown here: not one the host does not offer, nor a game of this PC.
    expect(await s.service.achievementsFor('remote:host-1:steam:404')).toBeNull()
    expect(await s.service.achievementsFor('steam:620')).toBeNull()
    expect(achievements).toHaveBeenCalledTimes(1)
  })

  it("as client: the host's counts never become this PC's own copy's", async () => {
    const mine = [game({ id: 'steam:620', source: 'steam', title: 'Portal 2' })]
    const hostGames = [
      {
        ...game({ id: 'steam:620', source: 'steam', title: 'Portal 2' }),
        achievements: { unlocked: 1, total: 2 }
      } as Game
    ]
    const s = await client(hostGames, { achievements: async () => portal }, mine)
    const lib = await s.service.refreshRemoteLibrary()
    expect(lib.games).toEqual([])
    expect(lib.alsoOnHost['steam:620']).toHaveLength(1)
    expect(mine[0].metadata.achievements).toBeUndefined()
  })

  it('as client: an older host (no endpoint, or none to give) gives none; an unreachable one rejects', async () => {
    const hostGames = [game({ id: 'steam:620', source: 'steam', title: 'Portal 2' })]
    const older = await client(hostGames, {})
    await older.service.refreshRemoteLibrary()
    expect(await older.service.achievementsFor('remote:host-1:steam:620')).toBeNull()

    const none = await client(hostGames, { achievements: async () => null })
    await none.service.refreshRemoteLibrary()
    expect(await none.service.achievementsFor('remote:host-1:steam:620')).toBeNull()

    const failing = await client(hostGames, {
      achievements: async () => {
        throw new Error('ECONNRESET')
      }
    })
    await failing.service.refreshRemoteLibrary()
    await expect(failing.service.achievementsFor('remote:host-1:steam:620')).rejects.toThrow(
      /Living Room could not be reached/
    )
  })
})
