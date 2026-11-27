import { describe, expect, it, vi } from 'vitest'
import type { Game, Settings } from '../../../shared/types'
import type { AntiCheatScan } from '../../upgrades/anticheat'
import type { ForegroundWindow, OverlayTarget } from '../overlay-logic'
import { createIngameGate, gameOfExe, probeBlock, SCAN_WAIT_MS, type IngameGateDeps } from './gate'
import type { ProbeResult } from './helper'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

function makeGame(overrides: Partial<Game> = {}): Game {
  return {
    id: 'steam:418530',
    source: 'steam',
    externalId: '418530',
    platformId: 'windows',
    title: 'Spelunky 2',
    sortTitle: 'spelunky 2',
    installed: true,
    installDir: 'D:\\Steam\\steamapps\\common\\Spelunky 2',
    launch: { kind: 'uri', uri: 'steam://rungameid/418530' },
    tracking: { mode: 'installDir', installDir: 'D:\\Steam\\steamapps\\common\\Spelunky 2' },
    hidden: false,
    favorite: false,
    playtimeMinutes: 0,
    playCount: 0,
    addedAt: '2026-01-01T00:00:00.000Z',
    metadata: { steamTags: { tags: ['Platformer', 'Roguelike'], vac: false } } as Game['metadata'],
    media: {},
    metadataStatus: 'done',
    user: {},
    ...overrides
  }
}

const EXE = 'D:\\Steam\\steamapps\\common\\Spelunky 2\\Spel2.exe'
const fg: ForegroundWindow = {
  hwnd: '500',
  pid: 77,
  exe: EXE,
  title: 'Spelunky 2',
  rect: { x: 0, y: 0, width: 1920, height: 1080 },
  monitor: null,
  fullscreen: true,
  exclusive: true
}
const target: OverlayTarget = { hwnd: '500', pid: 77, exclusive: true, program: 'Spel2.exe' }

const goodProbe: ProbeResult = {
  ok: true,
  pid: 77,
  arch: 'x64',
  elevated: false,
  protected: false,
  appContainer: false,
  antiCheat: [],
  graphics: ['d3d11', 'dxgi'],
  injected: false,
  exe: EXE,
  checked: { drivers: 245, processes: 140, modules: 68 }
}

function setup(
  over: {
    game?: Partial<Game>
    settings?: Partial<Settings['input']>
    scan?: () => Promise<AntiCheatScan>
    images?: Set<string> | null
    probe?: ProbeResult | null
    available?: boolean
  } = {}
): { gate: ReturnType<typeof createIngameGate>; deps: IngameGateDeps; scans: string[] } {
  const game = makeGame(over.game)
  const scans: string[] = []
  const deps: IngameGateDeps = {
    log,
    settings: () =>
      ({
        input: { ingameOverlay: true, ingameNever: [], ...over.settings }
      }) as unknown as Settings,
    running: () => ({ gameId: game.id }),
    game: (id) => (id === game.id ? game : undefined),
    games: () => [game],
    runningImages: async () => (over.images === undefined ? new Set(['spel2.exe']) : over.images),
    helper: {
      available: async () => over.available ?? true,
      probe: vi.fn(async () => (over.probe === undefined ? goodProbe : over.probe))
    },
    scan: async (dir) => {
      scans.push(dir)
      return over.scan ? over.scan() : { names: [], complete: true }
    }
  }
  return { gate: createIngameGate(deps), deps, scans }
}

/** Check twice: the first press only starts the folder scan. */
async function verdict(s: ReturnType<typeof setup>): Promise<string> {
  const first = await s.gate.check(target, fg)
  if (!first.ok && first.reason === 'scan-pending') {
    await new Promise((r) => setTimeout(r, 0))
    const second = await s.gate.check(target, fg)
    return second.ok ? 'ok' : second.reason
  }
  return first.ok ? 'ok' : first.reason
}

describe('createIngameGate', () => {
  it('lets a clean Steam game without VAC through on the first press, waiting for its folder scan', async () => {
    const s = setup()
    const first = await s.gate.check(target, fg)
    expect(first.ok).toBe(true)
    expect(first.ok && first.game.id).toBe('steam:418530')
    expect(s.scans).toEqual(['D:\\Steam\\steamapps\\common\\Spelunky 2'])
    expect((await s.gate.check(target, fg)).ok).toBe(true)
    expect(s.scans).toHaveLength(1)
  })

  it('falls back when the first folder scan takes longer than SCAN_WAIT_MS, and uses it on the next press', async () => {
    vi.useFakeTimers()
    try {
      let finish: (scan: AntiCheatScan) => void = () => {}
      const s = setup({ scan: () => new Promise<AntiCheatScan>((r) => (finish = r)) })
      const first = s.gate.check(target, fg)
      await vi.advanceTimersByTimeAsync(SCAN_WAIT_MS)
      expect(await first).toMatchObject({ ok: false, reason: 'scan-pending' })
      finish({ names: [], complete: true } as AntiCheatScan)
      await vi.advanceTimersByTimeAsync(0)
      expect((await s.gate.check(target, fg)).ok).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('scans ahead with prewarm', async () => {
    const s = setup()
    s.gate.prewarm('steam:418530')
    await new Promise((r) => setTimeout(r, 0))
    expect((await s.gate.check(target, fg)).ok).toBe(true)
  })

  it('is off with the setting, and never for a game on the never list', async () => {
    expect(await verdict(setup({ settings: { ingameOverlay: false } }))).toBe('off')
    expect(await verdict(setup({ settings: { ingameNever: ['steam:418530'] } }))).toBe('never')
  })

  it('blocks a Steam game unless Steam says no VAC', async () => {
    const unknown = makeGame().metadata
    expect(
      await verdict(setup({ game: { metadata: { ...unknown, steamTags: { tags: [] } } } }))
    ).toBe('vac-unknown')
    expect(await verdict(setup({ game: { metadata: {} as Game['metadata'] } }))).toBe('vac-unknown')
    expect(
      await verdict(
        setup({ game: { metadata: { steamTags: { tags: [], vac: true } } as Game['metadata'] } })
      )
    ).toBe('vac')
    // Not a Steam game: no Steam answer needed.
    expect(
      await verdict(setup({ game: { source: 'gog', metadata: {} as Game['metadata'] } }))
    ).toBe('ok')
  })

  it('blocks by the record: remote, ROM, recompilation, not installed, Xbox 360, WindowsApps, title, tags', async () => {
    expect(await verdict(setup({ game: { remote: {} as Game['remote'] } }))).toBe('unknown-game')
    expect(await verdict(setup({ game: { source: 'rom' } }))).toBe('rom')
    expect(await verdict(setup({ game: { extra: { recompOnly: 'sm64' } } }))).toBe('recomp')
    expect(await verdict(setup({ game: { installed: false } }))).toBe('not-installed')
    expect(
      await verdict(
        setup({ game: { source: 'xbox', externalId: 'Xbox360BackwardCompatibility_x' } })
      )
    ).toBe('xbox360')
    expect(
      await verdict(
        setup({ game: { installDir: 'C:\\Program Files\\WindowsApps\\Spelunky 2', source: 'gog' } })
      )
    ).toBe('unknown-game')
    expect(
      await verdict(
        setup({
          game: {
            title: 'Call of Duty: Black Ops 6',
            metadata: { steamTags: { tags: [], vac: false } } as Game['metadata']
          }
        })
      )
    ).toBe('kernel-anti-cheat')
    expect(
      await verdict(
        setup({
          game: {
            metadata: { steamTags: { tags: ['Free to Play'], vac: false } } as Game['metadata']
          }
        })
      )
    ).toBe('tags')
    expect(
      await verdict(
        setup({
          game: {
            metadata: {
              steamTags: { tags: ['Massively Multiplayer'], vac: false }
            } as Game['metadata']
          }
        })
      )
    ).toBe('tags')
  })

  it('blocks a program it cannot tie to a library game', async () => {
    const s = setup()
    const other = { ...fg, exe: 'D:\\Elsewhere\\game.exe' }
    expect(await s.gate.check(target, other)).toMatchObject({ ok: false, reason: 'unknown-game' })
    expect(await s.gate.check(target, { ...fg, exe: 'Spel2.exe' })).toMatchObject({
      ok: false,
      reason: 'no-exe'
    })
  })

  it('blocks on anti-cheat in the folder, an incomplete scan or a failed one', async () => {
    expect(
      await verdict(setup({ scan: async () => ({ names: ['BattlEye'], complete: true }) }))
    ).toBe('anti-cheat')
    expect(await verdict(setup({ scan: async () => ({ names: [], complete: false }) }))).toBe(
      'anti-cheat-unknown'
    )
    expect(
      await verdict(
        setup({
          scan: async () => {
            throw new Error('denied')
          }
        })
      )
    ).toBe('anti-cheat-unknown')
  })

  it('blocks while an anti-cheat service runs or the running programs are unknown', async () => {
    expect(await verdict(setup({ images: new Set(['easyanticheat.exe']) }))).toBe(
      'anti-cheat-running'
    )
    expect(await verdict(setup({ images: null }))).toBe('running-unknown')
  })

  it('blocks on the probe, and without the helper', async () => {
    expect(await verdict(setup({ available: false }))).toBe('helper-missing')
    expect(await verdict(setup({ probe: null }))).toBe('probe-failed')
    expect(await verdict(setup({ probe: { ...goodProbe, arch: 'x86' } }))).toBe('arch')
    expect(
      await verdict(setup({ probe: { ...goodProbe, antiCheat: ['EasyAntiCheat.sys'] } }))
    ).toBe('anti-cheat-loaded')
    expect(await verdict(setup({ probe: { ...goodProbe, graphics: ['d3d9'] } }))).toBe('graphics')
  })

  it('counts anti-cheat as unknown (blocked) when the helper could not read every source', async () => {
    const unread = [
      null,
      { drivers: 0, processes: 140, modules: 68 },
      { drivers: 245, processes: 0, modules: 68 },
      { drivers: 245, processes: 140, modules: 0 }
    ]
    for (const checked of unread)
      expect(await verdict(setup({ probe: { ...goodProbe, checked } }))).toBe('anti-cheat-loaded')
    expect(await verdict(setup({ probe: { ...goodProbe, antiCheat: ['unknown'] } }))).toBe(
      'anti-cheat-loaded'
    )
  })

  it('asks for the running programs and the probe on every press', async () => {
    const s = setup()
    await verdict(s)
    await s.gate.check(target, fg)
    expect(s.deps.helper.probe).toHaveBeenCalledTimes(2)
  })
})

describe('probeBlock', () => {
  it('names each refusal', () => {
    expect(probeBlock(goodProbe)).toBeNull()
    expect(probeBlock({ ok: false, pid: 1, error: 'x', step: 'open' })?.reason).toBe('probe-failed')
    expect(probeBlock({ ...goodProbe, elevated: true })?.reason).toBe('elevated')
    expect(probeBlock({ ...goodProbe, protected: true })?.reason).toBe('protected')
    expect(probeBlock({ ...goodProbe, appContainer: true })?.reason).toBe('app-container')
    expect(probeBlock({ ...goodProbe, graphics: ['dxgi', 'd3d12'] })).toBeNull()
  })
})

describe('gameOfExe', () => {
  it('prefers the exact exe, then the deepest folder, and never a remote game', () => {
    const a = makeGame({ id: 'a', installDir: 'D:\\G' })
    const b = makeGame({ id: 'b', installDir: 'D:\\G\\Sub' })
    const c = makeGame({ id: 'c', installDir: 'D:\\X', exePath: 'D:\\G\\Sub\\run.exe' })
    const r = makeGame({ id: 'r', installDir: 'D:\\G\\Sub', remote: {} as Game['remote'] })
    expect(gameOfExe('D:\\G\\Sub\\run.exe', undefined, () => [a, b, c, r])?.id).toBe('c')
    expect(gameOfExe('d:/g/sub/other.exe', undefined, () => [a, b, r])?.id).toBe('b')
    expect(gameOfExe('D:\\G\\x.exe', b, () => [a, b])?.id).toBe('a')
    expect(gameOfExe('D:\\Gx\\x.exe', undefined, () => [a])).toBeUndefined()
  })
})
