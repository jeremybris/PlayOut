import { describe, expect, it, vi } from 'vitest'
import type { OsdResult } from '../native-host/native-ops'
import type { RtssSnapshot } from './memory'
import {
  createRtssService,
  noHelperMessage,
  noRtssMessage,
  OSD_RELEASE_TRIES,
  RTSS_OSD_OWNER,
  type RtssHelper,
  type RtssServiceDeps
} from './service'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

const SNAP: RtssSnapshot = {
  version: 0x20015,
  foregroundPid: 200,
  apps: [
    {
      pid: 100,
      name: 'C:\\Games\\Launcher.exe',
      flags: 0,
      time0: 0,
      time1: 0,
      frames: 0,
      frameTimeUs: 0
    },
    {
      pid: 200,
      name: 'C:\\Games\\JWE3.exe',
      flags: 0,
      time0: 5000,
      time1: 6000,
      frames: 59,
      frameTimeUs: 16950
    },
    {
      pid: 300,
      name: 'C:\\Other\\Tool.exe',
      flags: 0,
      time0: 5000,
      time1: 6000,
      frames: 30,
      frameTimeUs: 33000
    }
  ]
}

interface World {
  snap: RtssSnapshot | null
  install: { installDir: string; version?: string } | null
  helper: (RtssHelper & { calls: string[] }) | null
  osd: (owner: string, text: string | null) => OsdResult
  osdCalls: [string, string | null][]
  reloads: number
  time: number
}

function setup(over: Partial<World> = {}): { world: World; deps: RtssServiceDeps } {
  const calls: string[] = []
  const world: World = {
    snap: SNAP,
    install: { installDir: 'C:\\RTSS', version: '7.3.7' },
    helper: {
      calls,
      async rtssLimit(exe, fps) {
        calls.push(`limit ${exe} ${fps}`)
        return { exe, fps, created: true }
      },
      async rtssSelf(exe) {
        calls.push(`self ${exe}`)
        return { changed: true }
      },
      async rtssRestore() {
        calls.push('restore')
        return { restored: 2 }
      }
    },
    osd: () => ({ ok: true, slot: 3 }),
    osdCalls: [],
    reloads: 0,
    time: 1_000_000,
    ...over
  }
  const deps: RtssServiceDeps = {
    native: {
      rtssSnapshot: async () => world.snap,
      rtssOsd: async (owner, text) => {
        world.osdCalls.push([owner, text])
        return world.osd(owner, text)
      },
      rtssRequestProfileUpdate: async () => {
        world.reloads++
        return 2
      }
    },
    helper: async () => world.helper,
    log,
    readInstall: async () => world.install,
    now: () => world.time,
    sleep: async () => undefined
  }
  return { world, deps }
}

describe('rtss service status', () => {
  it('is running with the version, stopped without the memory, missing without either', async () => {
    const { world, deps } = setup()
    const s = createRtssService(deps)
    expect(await s.status()).toEqual({ state: 'running', version: '7.3.7' })
    world.snap = null
    // Cached for 10 s.
    expect((await s.status()).state).toBe('running')
    world.time += 10_001
    expect(await s.status()).toEqual({ state: 'stopped', version: '7.3.7' })
    world.install = null
    expect(await s.status(true)).toEqual({ state: 'missing' })
    // A portable RTSS (no registry key) whose memory answers is running.
    world.snap = SNAP
    world.time += 1000
    expect(await s.status(true)).toEqual({ state: 'running' })
  })
})

describe('rtss service frame rate', () => {
  it('reads the game pid entry and its frame time', async () => {
    const { world, deps } = setup()
    const s = createRtssService(deps)
    expect(await s.gameFps([100, 200])).toEqual({
      fps: 59,
      frameTimeMs: 17,
      pid: 200,
      exe: 'JWE3.exe'
    })
    expect(await s.gameFps([100])).toBeNull()
    world.snap = null
    world.time += 1000
    expect(await s.gameFps([200])).toBeNull()
  })

  it('names the exe RTSS hooked for the game, even before frames arrive', async () => {
    const { world, deps } = setup()
    const s = createRtssService(deps)
    expect(await s.hookedExe([100, 200])).toBe('JWE3.exe')
    expect(await s.hookedExe([100])).toBe('Launcher.exe')
    expect(await s.hookedExe([999])).toBeNull()
    expect(await s.hookedExe([])).toBeNull()
    world.snap = { ...SNAP, foregroundPid: null }
    world.time += 1000
    expect(await s.hookedExe([100, 300])).toBe('Tool.exe')
  })

  it('prefers the entry drawing frames over a hooked launcher in the foreground', async () => {
    const { world, deps } = setup()
    world.snap = { ...SNAP, foregroundPid: 100 }
    expect(await createRtssService(deps).hookedExe([100, 200])).toBe('JWE3.exe')
  })

  it('does not report a frame rate for a game that stopped presenting', async () => {
    const { world, deps } = setup()
    const s = createRtssService(deps)
    // The window ended 1 s before the snapshot: measured.
    world.snap = { ...SNAP, tick: 7000 }
    expect((await s.gameFps([200]))?.fps).toBe(59)
    // 10 s later with no new frames: a hung or paused game, not 59 FPS.
    world.snap = { ...SNAP, tick: 16_000 }
    world.time += 1000
    expect(await s.gameFps([200])).toBeNull()
  })
})

describe('rtss service frame limit', () => {
  it('writes through the helper, then asks RTSS to reload profiles', async () => {
    const { world, deps } = setup()
    const s = createRtssService(deps)
    await s.setFrameLimit('JWE3.exe', 60)
    await s.setFrameLimit('JWE3.exe', 0)
    expect(world.helper!.calls).toEqual(['limit JWE3.exe 60', 'limit JWE3.exe 0'])
    expect(world.reloads).toBe(2)
  })

  it('writes but does not reload while RTSS is stopped', async () => {
    const { world, deps } = setup({ snap: null })
    await createRtssService(deps).setFrameLimit('JWE3.exe', 30)
    expect(world.helper!.calls).toEqual(['limit JWE3.exe 30'])
    expect(world.reloads).toBe(0)
  })

  it('refuses bad input, no RTSS and no helper with a readable error', async () => {
    const { world, deps } = setup()
    const s = createRtssService(deps)
    await expect(s.setFrameLimit('..\\Global', 60)).rejects.toThrow(/Not a program name/)
    await expect(s.setFrameLimit('Game.exe', 60.5)).rejects.toThrow(/Not a frame rate limit/)
    await expect(s.setFrameLimit('Game.exe', 1001)).rejects.toThrow(/Not a frame rate limit/)
    world.helper = null
    await expect(s.setFrameLimit('Game.exe', 60)).rejects.toThrow(noHelperMessage())
    world.snap = null
    world.install = null
    world.time += 1000
    await expect(s.setFrameLimit('Game.exe', 60)).rejects.toThrow(noRtssMessage())
  })

  it('passes the helper error through', async () => {
    const { world, deps } = setup()
    world.helper!.rtssLimit = async () => {
      throw new Error('RivaTuner Statistics Server is not installed')
    }
    await expect(createRtssService(deps).setFrameLimit('Game.exe', 60)).rejects.toThrow(
      'RivaTuner Statistics Server is not installed'
    )
    expect(world.reloads).toBe(0)
  })
})

describe('rtss service restore', () => {
  it('puts every profile back through the helper, reloads, and excludes PlayOut again later', async () => {
    const { world, deps } = setup()
    const s = createRtssService(deps)
    await s.excludeSelf('PlayOut.exe')
    expect(await s.restoreAll()).toBe(2)
    await s.excludeSelf('PlayOut.exe')
    expect(world.helper!.calls).toEqual(['self PlayOut.exe', 'restore', 'self PlayOut.exe'])
    expect(world.reloads).toBe(3)
    world.helper = null
    await expect(s.restoreAll()).rejects.toThrow(noHelperMessage())
  })
})

describe('rtss service self exclusion', () => {
  it('runs once per run when it worked, and again after a failure', async () => {
    const { world, deps } = setup()
    const s = createRtssService(deps)
    world.helper = null
    await s.excludeSelf('PlayOut.exe')
    const helper = setup().world.helper!
    world.helper = helper
    await Promise.all([s.excludeSelf('PlayOut.exe'), s.excludeSelf('PlayOut.exe')])
    await s.excludeSelf('PlayOut.exe')
    expect(helper.calls).toEqual(['self PlayOut.exe'])
    expect(world.reloads).toBe(1)
  })

  it('does nothing without RTSS or for a bad name', async () => {
    const { world, deps } = setup({ snap: null, install: null })
    const s = createRtssService(deps)
    await s.excludeSelf('PlayOut.exe')
    await s.excludeSelf('electron')
    expect(world.helper!.calls).toEqual([])
  })
})

describe('rtss service OSD', () => {
  it("writes into PlayOut's slot and releases it", async () => {
    const { world, deps } = setup()
    const s = createRtssService(deps)
    expect(await s.osdWrite('60 FPS')).toBe(true)
    await s.osdRelease()
    await s.osdRelease()
    expect(world.osdCalls).toEqual([
      [RTSS_OSD_OWNER, '60 FPS'],
      [RTSS_OSD_OWNER, null]
    ])
  })

  it('clears a slot left by an earlier run on the first release', async () => {
    const { world, deps } = setup()
    const s = createRtssService(deps)
    await s.osdRelease()
    await s.osdRelease()
    expect(world.osdCalls).toEqual([[RTSS_OSD_OWNER, null]])
  })

  it('tries a busy release again, and says whether the slot is still held', async () => {
    const { world, deps } = setup()
    let busy = 2
    world.osd = (_o, text) =>
      text === null && busy-- > 0 ? { ok: false, error: 'busy' } : { ok: true }
    const s = createRtssService(deps)
    expect(await s.osdRelease()).toBe(true)
    expect(world.osdCalls.length).toBe(3)
    // Busy every time: still held after OSD_RELEASE_TRIES, so a later release asks again.
    world.osdCalls = []
    world.osd = (_o, text) => (text === null ? { ok: false, error: 'busy' } : { ok: true })
    await s.osdWrite('x')
    expect(await s.osdRelease()).toBe(false)
    expect(world.osdCalls.length).toBe(1 + OSD_RELEASE_TRIES)
    world.osd = () => ({ ok: true })
    expect(await s.osdRelease()).toBe(true)
    expect(await s.osdRelease()).toBe(true)
    expect(world.osdCalls.length).toBe(2 + OSD_RELEASE_TRIES)
  })

  it('releases a slot claimed by a write that came back busy', async () => {
    const { world, deps } = setup()
    const s = createRtssService(deps)
    expect(await s.osdRelease()).toBe(true)
    world.osd = () => ({ ok: false, error: 'busy' })
    expect(await s.osdWrite('x')).toBe(false)
    world.osd = () => ({ ok: true })
    world.osdCalls = []
    await s.osdRelease()
    expect(world.osdCalls).toEqual([[RTSS_OSD_OWNER, null]])
  })

  it('reports a missing RTSS, a busy lock or no free slot as not written', async () => {
    const { world, deps } = setup()
    const s = createRtssService(deps)
    for (const error of ['missing', 'busy', 'full'] as const) {
      world.osd = () => ({ ok: false, error })
      expect(await s.osdWrite('x')).toBe(false)
    }
  })

  it('keeps writes and the release in order, and writes nothing after dispose', async () => {
    const { world, deps } = setup()
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const native = deps.native
    deps.native = {
      ...native,
      rtssOsd: async (owner, text) => {
        if (text === 'slow') await gate
        return native.rtssOsd(owner, text)
      }
    }
    const s = createRtssService(deps)
    const w = s.osdWrite('slow')
    const d = s.dispose()
    release()
    expect(await w).toBe(true)
    await d
    expect(await s.osdWrite('late')).toBe(false)
    expect(world.osdCalls).toEqual([
      [RTSS_OSD_OWNER, 'slow'],
      [RTSS_OSD_OWNER, null]
    ])
  })
})
