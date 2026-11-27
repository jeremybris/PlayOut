import type { ChildProcess, SpawnOptions } from 'child_process'
import { createHash } from 'crypto'
import { EventEmitter } from 'events'
import { mkdtempSync, readFileSync, rmSync, writeSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PlayOutEvents, Game } from '../../shared/types'
import type { EventBus } from '../events'
import type { PeerPartyProbe } from './eligibility'
import { RELEASES_LATEST } from './release'
import { createPeerPartyService, type PeerPartyServiceDeps } from './service'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const exeBytes = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(300, 1)])
const sha = createHash('sha256').update(exeBytes).digest('hex')

function makeGame(overrides: Partial<Game> = {}): Game {
  return {
    id: 'epic:thing',
    source: 'epic',
    externalId: 'thing',
    platformId: 'windows',
    title: 'Thing',
    sortTitle: 'thing',
    installed: true,
    installDir: 'D:\\Games\\Thing',
    launch: { kind: 'uri', uri: 'com.epicgames.launcher://apps/thing' },
    tracking: { mode: 'installDir', installDir: 'D:\\Games\\Thing' },
    hidden: false,
    favorite: false,
    playtimeMinutes: 0,
    playCount: 0,
    addedAt: '2026-01-01T00:00:00.000Z',
    metadata: { steamTags: { tags: ['Online Co-Op'] } } as Game['metadata'],
    media: {},
    metadataStatus: 'done',
    user: {},
    ...overrides
  }
}

const github = (async (url: string) => {
  if (url === RELEASES_LATEST)
    return new Response(
      JSON.stringify({
        tag_name: 'v0.5.1',
        assets: [
          {
            name: 'peerparty.exe',
            browser_download_url: 'https://dl/x.exe',
            size: exeBytes.length
          },
          { name: 'peerparty.exe.sha256', browser_download_url: 'https://dl/x.sha256', size: 80 }
        ]
      })
    )
  if (url.endsWith('.sha256')) return new Response(`${sha}  peerparty.exe`)
  return new Response(exeBytes)
}) as unknown as typeof fetch

interface FakeChild extends ChildProcess {
  exitWith(code: number): void
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- the fixture's shape is its return value
function setup(
  options: {
    probe?: PeerPartyProbe
    stderr?: string
    processes?: PeerPartyServiceDeps['processes']
    probeAntiCheat?: PeerPartyServiceDeps['probeAntiCheat']
    fetch?: typeof fetch
  } = {}
) {
  const userData = mkdtempSync(join(tmpdir(), 'playout-pp-service-'))
  dirs.push(userData)
  const emitted: Array<[keyof PlayOutEvents, unknown]> = []
  const events = {
    emit: (e: keyof PlayOutEvents, p: unknown) => emitted.push([e, p]),
    on: vi.fn()
  } as unknown as EventBus
  const spawned: Array<{ file: string; args: string[]; options: SpawnOptions; child: FakeChild }> =
    []
  const spawn = (file: string, args: string[], opts: SpawnOptions): ChildProcess => {
    const child = new EventEmitter() as FakeChild
    Object.assign(child, {
      pid: 5000 + spawned.length,
      unref: vi.fn(),
      kill: vi.fn(),
      exitWith: (code: number) => child.emit('exit', code)
    })
    const fd = Array.isArray(opts.stdio) ? opts.stdio[2] : undefined
    if (typeof fd === 'number' && options.stderr) writeSync(fd, options.stderr)
    spawned.push({ file, args, options: opts, child })
    setImmediate(() => child.emit('spawn'))
    return child
  }
  const game = makeGame()
  const other = makeGame({ id: 'epic:other', title: 'Other', installDir: 'D:\\Games\\Other' })
  const deps: PeerPartyServiceDeps = {
    library: {
      getGame: (id) => [game, other].find((g) => g.id === id),
      games: () => [game, other]
    },
    launcher: { running: () => null, track: vi.fn() },
    events,
    log,
    userData,
    processes:
      options.processes ??
      (async () => [{ pid: 1, parentPid: null, name: 'steam.exe', path: null, sessionId: 1 }]),
    openExternal: vi.fn(async () => {}),
    fetch: options.fetch ?? github,
    spawn,
    sleep: async () => {},
    ...(options.probeAntiCheat ? { probeAntiCheat: options.probeAntiCheat } : {}),
    probe: async () =>
      options.probe ?? {
        antiCheat: [],
        antiCheatComplete: true,
        exe: 'D:\\Games\\Thing\\Thing.exe',
        services: ['eos']
      }
  }
  const service = createPeerPartyService(deps)
  return { service, deps, emitted, spawned, userData, game, other }
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Waits until an event was sent (the scan and the exit check read files, which takes a few turns). */
const sentEvent = (emitted: Array<[string, unknown]>, name: string): Promise<unknown> =>
  vi.waitFor(() => {
    const found = emitted.find(([e]) => e === name)
    if (!found) throw new Error(`no ${name} yet`)
    return found[1]
  })

describe('createPeerPartyService', () => {
  it('answers checking first, then sends the scanned status', async () => {
    const { service, emitted, game } = setup()
    const first = await service.status(game.id)
    expect(first).toMatchObject({ checking: true, supported: false })
    const sent = await sentEvent(emitted, 'peerparty:status')
    expect(sent).toMatchObject({
      gameId: game.id,
      supported: true,
      services: ['eos'],
      checking: false
    })
    expect(await service.status(game.id)).toMatchObject({ supported: true })
    service.dispose()
  })

  it('lists the games L.A.N. Party shows, scanning unscanned folders in the background', async () => {
    const { service, emitted, game, other } = setup()
    expect(await service.compatible()).toEqual({ ids: [], scanning: true })
    expect(await sentEvent(emitted, 'peerparty:compatible')).toEqual({
      ids: [game.id, other.id],
      scanning: false
    })
    expect(emitted.filter(([e]) => e === 'peerparty:status')).toHaveLength(2)
    // Cached now: answered at once, with no new sweep.
    expect(await service.compatible()).toEqual({ ids: [game.id, other.id], scanning: false })
    service.dispose()
  })

  it('scans a game installed while a sweep runs once that sweep ends', async () => {
    const { service, emitted, deps, game, other } = setup()
    const third = makeGame({ id: 'epic:third', title: 'Third', installDir: 'D:\\Games\\Third' })
    expect((await service.compatible()).scanning).toBe(true)
    // Installed during the sweep: the Library asks again (the installed count changed).
    const all = [game, other, third]
    deps.library.games = () => all
    deps.library.getGame = (id) => all.find((g) => g.id === id)
    expect((await service.compatible()).scanning).toBe(true)
    expect(await sentEvent(emitted, 'peerparty:compatible')).toEqual({
      ids: [game.id, other.id, third.id],
      scanning: false
    })
    expect(emitted.filter(([e]) => e === 'peerparty:compatible')).toHaveLength(1)
    service.dispose()
  })

  it('blocks a game whose folder has anti-cheat', async () => {
    const { service, emitted, game } = setup({
      probe: { antiCheat: ['BattlEye'], antiCheatComplete: true, exe: 'x.exe', services: ['eos'] }
    })
    await service.status(game.id)
    await sentEvent(emitted, 'peerparty:status')
    expect(await service.status(game.id)).toMatchObject({ supported: false, blocked: 'anti-cheat' })
    expect((await service.play(game.id)).ok).toBe(false)
    service.dispose()
  })

  it('downloads PeerParty, writes its portable settings, starts the game through it and tracks the session', async () => {
    const { service, deps, emitted, spawned, userData, game } = setup()
    const result = await service.play(game.id)
    expect(result.ok).toBe(true)
    const root = join(userData, 'PeerParty')
    expect(readFileSync(join(root, 'peerparty.exe'))).toEqual(exeBytes)
    expect(JSON.parse(readFileSync(join(root, 'peerparty-data', 'ui.json'), 'utf8'))).toEqual({
      prefs: { hotkeys: { guide: false } }
    })
    expect(spawned[0]!.file).toBe(join(root, 'peerparty.exe'))
    expect(spawned[0]!.args).toEqual([
      '--log-dir',
      join(root, 'logs'),
      'D:\\Games\\Thing\\Thing.exe'
    ])
    expect(deps.launcher.track).toHaveBeenCalledWith(game, spawned[0]!.child, {
      handoffDir: 'D:\\Games\\Thing',
      reason: 'PeerParty'
    })
    expect(service.session()).toMatchObject({ gameId: game.id, title: 'Thing', pid: 5000 })
    expect(
      emitted
        .filter(([e]) => e === 'peerparty:progress')
        .map(([, p]) => (p as { phase: string }).phase)
    ).toEqual([
      'checking',
      'checking',
      'downloading',
      'verifying',
      'installing',
      'starting',
      'done'
    ])
    expect((await service.play(game.id)).error?.message).toMatch(/already running/)
    spawned[0]!.child.exitWith(0)
    expect(service.session()).toBeNull()
    expect(emitted.at(-1)).toEqual(['peerparty:session', { session: null }])
    service.dispose()
  })

  it("shows PeerParty's own error when it ends right away", async () => {
    const { service, emitted, spawned, game } = setup({
      stderr: 'peerparty: Steam is not running\n'
    })
    expect((await service.play(game.id)).ok).toBe(true)
    spawned[0]!.child.exitWith(1)
    expect(await sentEvent(emitted, 'launch:error')).toEqual({
      gameId: game.id,
      error: { kind: 'failed', message: 'PeerParty could not start Thing: Steam is not running' }
    })
    service.dispose()
  })

  it('starts one game at a time, so a second start cannot download PeerParty beside the first', async () => {
    let release: () => void = () => {}
    const held = new Promise<void>((r) => (release = r))
    let asked = false
    const slow = (async (url: string, init?: RequestInit) => {
      if (url === RELEASES_LATEST) {
        asked = true
        await held
      }
      return github(url, init)
    }) as unknown as typeof fetch
    const { service, spawned, game, other } = setup({ fetch: slow })
    const first = service.play(game.id)
    await vi.waitFor(() => {
      if (!asked) throw new Error('not asking GitHub yet')
    })
    const second = await service.play(other.id)
    expect(second.ok).toBe(false)
    expect(second.error?.message).toBe('Thing is already being started with PeerParty.')
    release()
    expect((await first).ok).toBe(true)
    expect(spawned).toHaveLength(1)
    service.dispose()
  })

  it('answers a start with the real scan even when the scan takes long', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      let finish: () => void = () => {}
      const scanned = new Promise<void>((r) => (finish = r))
      const { service, deps, game } = setup()
      deps.probe = async () => {
        await scanned
        return {
          antiCheat: [],
          antiCheatComplete: true,
          exe: 'D:\\Games\\Thing\\Thing.exe',
          services: ['eos']
        }
      }
      const started = service.play(game.id)
      await vi.advanceTimersByTimeAsync(45_000)
      finish()
      await vi.advanceTimersByTimeAsync(0)
      expect((await started).ok).toBe(true)
      service.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats a peerparty.exe with no path as ours: no second start', async () => {
    const { service, spawned, game } = setup({
      processes: async () => [
        { pid: 1, parentPid: null, name: 'steam.exe', path: null, sessionId: 1 },
        { pid: 2, parentPid: null, name: 'PeerParty.exe', path: null, sessionId: 1 }
      ]
    })
    const result = await service.play(game.id)
    expect(result.error?.message).toMatch(/already running a game/)
    expect(spawned).toHaveLength(0)
    service.dispose()
  })

  it('checks the folder for anti-cheat again before every start', async () => {
    let antiCheat: string[] = []
    const { service, emitted, spawned, game } = setup({
      probeAntiCheat: async () => ({ antiCheat, antiCheatComplete: true })
    })
    await service.status(game.id)
    await sentEvent(emitted, 'peerparty:status')
    expect(await service.status(game.id)).toMatchObject({ supported: true })
    // A game update added anti-cheat in a subfolder; the folder's cache key did not change.
    antiCheat = ['Easy Anti-Cheat']
    const result = await service.play(game.id)
    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('Easy Anti-Cheat')
    expect(spawned).toHaveLength(0)
    service.dispose()
  })
})
