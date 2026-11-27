import { describe, expect, it, vi } from 'vitest'
import type { PadInfo } from '../../../shared/overlay'
import type { Game, Settings } from '../../../shared/types'
import type { ForegroundWindow, OverlayTarget } from '../overlay-logic'
import type { GateResult } from './gate'
import type { InjectResult } from './helper'
import type { PipeServer, PipeServerEvent, PipeServerEvents } from './pipe-server'
import { ToDll } from './protocol'
import { createIngameSession, type IngameSessionDeps } from './session'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

const fg = { pid: 77, exe: 'D:\\G\\Spel2.exe' } as ForegroundWindow
const target: OverlayTarget = { hwnd: '500', pid: 77, exclusive: true, program: 'Spel2.exe' }
const game = { id: 'steam:1', title: 'Spelunky 2' } as Game

interface FakePipe extends PipeServer {
  sent: { type: number; json?: object }[]
  frames: Buffer[]
  live: boolean
  fire<E extends PipeServerEvent>(event: E, payload: PipeServerEvents[E]): void
  closed: boolean
}

const helloPayload = {
  proto: 1,
  dll: '0.1.0',
  pid: 77,
  token: 't',
  api: 'd3d11',
  width: 1920,
  height: 1080,
  format: 87,
  exclusive: true,
  hwnd: '500'
}

function fakePipe(): FakePipe {
  const listeners = new Map<string, Set<(p: unknown) => void>>()
  let hello: typeof helloPayload | null = null
  const p: FakePipe = {
    name: '\\\\.\\pipe\\PlayOut-ingame-x',
    token: 't'.repeat(64),
    sent: [],
    frames: [],
    live: false,
    closed: false,
    listen: async () => {},
    connected: () => p.live,
    hello: () => hello as never,
    send: (type, json) => {
      if (!p.live) return false
      p.sent.push({ type, json })
      return true
    },
    sendFrame: (m) => (p.frames.push(m), true),
    on: (event, l) => {
      const set = listeners.get(event) ?? new Set()
      set.add(l as (p: unknown) => void)
      listeners.set(event, set)
      return () => set.delete(l as (p: unknown) => void)
    },
    fire: (event, payload) => {
      if (event === 'hello') {
        hello = payload as typeof helloPayload
        p.live = true
      }
      if (event === 'gone') p.live = false
      for (const l of [...(listeners.get(event) ?? [])]) l(payload)
    },
    close: () => {
      p.closed = true
      p.live = false
    }
  }
  return p
}

interface Script {
  /** What the DLL does when injected / on SHOW / on HIDE. */
  onInject?: (pipe: FakePipe) => void
  onShow?: (pipe: FakePipe, hold: boolean) => void
  onHide?: (pipe: FakePipe) => void
}

function setup(
  over: {
    gate?: GateResult
    inject?: InjectResult | null
    script?: Script
    pads?: PadInfo[]
    prepare?: boolean
  } = {}
): {
  session: ReturnType<typeof createIngameSession>
  pipes: FakePipe[]
  deps: IngameSessionDeps
  pump: {
    prepare: ReturnType<typeof vi.fn>
    show: ReturnType<typeof vi.fn>
    hide: ReturnType<typeof vi.fn>
  }
  exit(code: number | null): void
  settings: { input: { ingameNever: string[] } }
  notices: string[]
  clock: { now: number }
  pads: { list: PadInfo[] }
} {
  const pipes: FakePipe[] = []
  const script: Script = {
    onInject: (pipe) => setTimeout(() => pipe.fire('hello', helloPayload), 1),
    onShow: (pipe, hold) => setTimeout(() => pipe.fire('presenting', { held: hold }), 1),
    onHide: (pipe) => setTimeout(() => pipe.fire('hidden', {}), 1),
    ...over.script
  }
  let exit: (code: number | null) => void = () => {}
  const settings = { input: { ingameNever: [] as string[] } }
  const notices: string[] = []
  const clock = { now: 1_000_000 }
  const pads = { list: over.pads ?? [] }
  const pump = {
    prepare: vi.fn(async () => over.prepare ?? true),
    show: vi.fn(),
    hide: vi.fn()
  }
  const deps: IngameSessionDeps = {
    log,
    gate: {
      check: vi.fn(
        async () => over.gate ?? ({ ok: true, game, probe: {} } as unknown as GateResult)
      )
    },
    helper: {
      dll: 'C:\\x\\PlayOutOverlay64.dll',
      inject: vi.fn(async () => {
        const pipe = pipes.at(-1)!
        const r =
          over.inject === undefined ? ({ ok: true, pid: 77, step: 'done' } as const) : over.inject
        if (r?.ok) script.onInject?.(pipe)
        return r
      }),
      watch: vi.fn(() => new Promise<number | null>((r) => (exit = r)))
    },
    createPipe: () => {
      const p = fakePipe()
      const send = p.send
      p.send = (type, json) => {
        const ok = send(type, json)
        if (type === ToDll.SHOW) script.onShow?.(p, (json as { hold: boolean }).hold)
        if (type === ToDll.HIDE) script.onHide?.(p)
        return ok
      }
      pipes.push(p)
      return p
    },
    pump,
    pads: { pads: () => pads.list },
    settings: {
      get: () => settings as unknown as Settings,
      update: vi.fn((patch: { input?: { ingameNever?: string[] } }) => {
        if (patch.input?.ingameNever) settings.input.ingameNever = patch.input.ingameNever
      })
    },
    notify: (_g, m) => notices.push(m),
    ownPid: 999,
    now: () => clock.now,
    timing: {
      helloMs: 50,
      resizeMs: 50,
      presentingMs: 50,
      hiddenMs: 50,
      releaseMaxMs: 100,
      releasePollMs: 5
    }
  }
  return {
    session: createIngameSession(deps),
    pipes,
    deps,
    pump,
    exit: (code) => exit(code),
    settings,
    notices,
    clock,
    pads
  }
}

const types = (p: FakePipe): number[] => p.sent.map((s) => s.type)
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

describe('createIngameSession', () => {
  it('injects, waits for HELLO, sizes the page, shows and waits for the first Present', async () => {
    const s = setup()
    expect(await s.session.tryOpen(target, fg, { hold: true })).toBe(true)
    expect(s.deps.helper.inject).toHaveBeenCalledWith({
      pid: 77,
      dll: 'C:\\x\\PlayOutOverlay64.dll',
      pipe: s.pipes[0]!.name,
      token: s.pipes[0]!.token,
      playoutPid: 999
    })
    expect(s.pump.prepare).toHaveBeenCalledWith({ width: 1920, height: 1080 })
    expect(s.pump.show).toHaveBeenCalledTimes(1)
    expect(s.pipes[0]!.sent[0]).toEqual({ type: ToDll.SHOW, json: { hold: true } })
    expect(s.session.active()).toBe(true)
    expect(s.session.activePid()).toBe(77)

    // Frames from the pump go down the pipe.
    const sink = s.pump.show.mock.calls[0]![0] as { sendFrame(m: Buffer): boolean }
    expect(sink.sendFrame(Buffer.from([1]))).toBe(true)
    expect(s.pipes[0]!.frames).toHaveLength(1)

    await s.session.close()
    expect(s.session.active()).toBe(false)
    expect(s.pump.hide).toHaveBeenCalled()
    await s.session.idle()
    expect(types(s.pipes[0]!)).toEqual([ToDll.SHOW, ToDll.HIDE, ToDll.INPUT_RELEASE])

    // The next open reuses the connection: no second injection.
    expect(await s.session.tryOpen(target, fg, { hold: false })).toBe(true)
    expect(s.deps.helper.inject).toHaveBeenCalledTimes(1)
    expect(s.pipes).toHaveLength(1)
  })

  it('gives the controller back only once every button is up (at most releaseMaxMs)', async () => {
    const s = setup({ pads: [{ id: 'p', name: 'Pad', buttons: 4 }] })
    await s.session.tryOpen(target, fg, { hold: false })
    await s.session.close()
    await new Promise((r) => setTimeout(r, 30))
    expect(types(s.pipes[0]!)).not.toContain(ToDll.INPUT_RELEASE)
    s.pads.list = [{ id: 'p', name: 'Pad', buttons: 0 }]
    await s.session.idle()
    expect(types(s.pipes[0]!).at(-1)).toBe(ToDll.INPUT_RELEASE)

    // A button held for good: released after releaseMaxMs anyway.
    const held = setup({ pads: [{ id: 'p', name: 'Pad', buttons: 1 }] })
    await held.session.tryOpen(target, fg, { hold: false })
    await held.session.close()
    await held.session.idle()
    expect(types(held.pipes[0]!).at(-1)).toBe(ToDll.INPUT_RELEASE)
  })

  it('an open during a pending release drops the release (SHOW blocks the controller again)', async () => {
    const s = setup({ pads: [{ id: 'p', name: 'Pad', buttons: 4 }] })
    await s.session.tryOpen(target, fg, { hold: false })
    await s.session.close()
    expect(await s.session.tryOpen(target, fg, { hold: false })).toBe(true)
    s.pads.list = []
    await s.session.idle()
    expect(types(s.pipes[0]!)).toEqual([ToDll.SHOW, ToDll.HIDE, ToDll.SHOW])
  })

  it('says no without injecting when the gate blocks', async () => {
    const s = setup({ gate: { ok: false, reason: 'vac-unknown' } })
    expect(await s.session.tryOpen(target, fg, { hold: true })).toBe(false)
    expect(s.deps.helper.inject).not.toHaveBeenCalled()
  })

  it('fails on a refused injection, no HELLO, or an undrawable back buffer; two failures skip the process', async () => {
    const refused = setup({ inject: { ok: false, pid: 77, error: 'no', step: 'check' } })
    expect(await refused.session.tryOpen(target, fg, { hold: false })).toBe(false)
    expect(await refused.session.tryOpen(target, fg, { hold: false })).toBe(false)
    expect(await refused.session.tryOpen(target, fg, { hold: false })).toBe(false)
    // The third press does not even ask the gate.
    expect(refused.deps.gate.check).toHaveBeenCalledTimes(2)

    const silent = setup({ script: { onInject: () => {} } })
    expect(await silent.session.tryOpen(target, fg, { hold: false })).toBe(false)

    const hdr = setup({
      script: {
        onInject: (p) => setTimeout(() => p.fire('hello', { ...helloPayload, format: 10 }), 1)
      }
    })
    expect(await hdr.session.tryOpen(target, fg, { hold: false })).toBe(false)
    expect(hdr.pump.show).not.toHaveBeenCalled()

    const windowed = setup({
      script: {
        onInject: (p) => setTimeout(() => p.fire('hello', { ...helloPayload, exclusive: false }), 1)
      }
    })
    expect(await windowed.session.tryOpen(target, fg, { hold: false })).toBe(false)
  })

  it('waits for the first RESIZE when HELLO has no back buffer yet', async () => {
    const s = setup({
      script: {
        onInject: (p) => {
          setTimeout(() => p.fire('hello', { ...helloPayload, width: 0, height: 0, format: 0 }), 1)
          setTimeout(
            () => p.fire('resize', { width: 2560, height: 1440, format: 28, exclusive: true }),
            10
          )
        }
      }
    })
    expect(await s.session.tryOpen(target, fg, { hold: false })).toBe(true)
    expect(s.pump.prepare).toHaveBeenCalledWith({ width: 2560, height: 1440 })
  })

  it('backs out (HIDE, input released) when the game draws no frame or answers UNSUPPORTED', async () => {
    const none = setup({ script: { onShow: () => {} } })
    expect(await none.session.tryOpen(target, fg, { hold: true })).toBe(false)
    expect(none.session.active()).toBe(false)
    expect(types(none.pipes[0]!)).toEqual([ToDll.SHOW, ToDll.HIDE, ToDll.INPUT_RELEASE])
    expect(none.pump.hide).toHaveBeenCalled()

    const unsupported = setup({
      script: { onShow: (p) => setTimeout(() => p.fire('unsupported', { reason: 'device' }), 1) }
    })
    // The open itself fails (the window overlay is used then): no 'ended', which would close that fallback.
    const ended: string[] = []
    unsupported.session.onEnded((why) => ended.push(why))
    expect(await unsupported.session.tryOpen(target, fg, { hold: false })).toBe(false)
    expect(types(unsupported.pipes[0]!).at(-1)).toBe(ToDll.INPUT_RELEASE)
    expect(ended).toEqual([])

    const gone = setup({
      script: { onShow: (p) => setTimeout(() => p.fire('gone', { reason: 'pipe closed' }), 1) }
    })
    const goneEnded: string[] = []
    gone.session.onEnded((why) => goneEnded.push(why))
    expect(await gone.session.tryOpen(target, fg, { hold: false })).toBe(false)
    expect(goneEnded).toEqual([])
  })

  it('fails when the page cannot be prepared', async () => {
    const s = setup({ prepare: false })
    expect(await s.session.tryOpen(target, fg, { hold: false })).toBe(false)
    expect(s.pump.show).not.toHaveBeenCalled()
  })

  it('ends by itself when the DLL goes away or the game leaves exclusive mode', async () => {
    const s = setup()
    const ended: string[] = []
    s.session.onEnded((why) => ended.push(why))
    await s.session.tryOpen(target, fg, { hold: false })
    s.pipes[0]!.fire('resize', { width: 1280, height: 720, format: 87, exclusive: true })
    await flush()
    expect(s.pump.prepare).toHaveBeenLastCalledWith({ width: 1280, height: 720 })
    expect(s.session.active()).toBe(true)
    s.pipes[0]!.fire('resize', { width: 1280, height: 720, format: 87, exclusive: false })
    expect(s.session.active()).toBe(false)
    expect(ended).toHaveLength(1)
    // Not exclusive any more: the window overlay is used (it no longer makes the game minimize).
    expect(await s.session.tryOpen(target, fg, { hold: false })).toBe(false)

    s.pipes[0]!.fire('resize', { width: 1280, height: 720, format: 87, exclusive: true })
    expect(await s.session.tryOpen(target, fg, { hold: false })).toBe(true)
    s.pipes[0]!.fire('gone', { reason: 'no PONG' })
    expect(s.session.active()).toBe(false)
    expect(ended).toHaveLength(2)
    // The next open injects again on a new pipe (the DLL picks up the new mapping).
    expect(await s.session.tryOpen(target, fg, { hold: false })).toBe(true)
    expect(s.pipes).toHaveLength(2)
    expect(s.deps.helper.inject).toHaveBeenCalledTimes(2)
  })

  it('turns itself off for a game whose hook faults, and tells the user', async () => {
    const s = setup()
    const ended: string[] = []
    s.session.onEnded((why) => ended.push(why))
    await s.session.tryOpen(target, fg, { hold: true })
    s.pipes[0]!.fire('fault', { where: 'present', code: 3221225477 })
    expect(s.settings.input.ingameNever).toEqual(['steam:1'])
    expect(s.notices[0]).toMatch(/Spelunky 2/)
    expect(s.session.active()).toBe(false)
    expect(ended).toHaveLength(1)
    expect(s.pipes[0]!.closed).toBe(true)
    expect(await s.session.tryOpen(target, fg, { hold: true })).toBe(false)
  })

  it('turns itself off for a game that crashes within 10 minutes of the injection', async () => {
    const s = setup()
    await s.session.tryOpen(target, fg, { hold: false })
    s.clock.now += 60_000
    s.exit(0xc0000005)
    await flush()
    expect(s.settings.input.ingameNever).toEqual(['steam:1'])
    expect(s.notices[0]).toMatch(/crashed \(0xC0000005\)/)
    expect(s.session.active()).toBe(false)
  })

  it('leaves a game alone that exits normally, or crashes long after', async () => {
    const ok = setup()
    await ok.session.tryOpen(target, fg, { hold: false })
    ok.exit(0)
    await flush()
    expect(ok.settings.input.ingameNever).toEqual([])
    expect(ok.session.active()).toBe(false)

    const late = setup()
    await late.session.tryOpen(target, fg, { hold: false })
    late.clock.now += 11 * 60_000
    late.exit(0xc0000005)
    await flush()
    expect(late.settings.input.ingameNever).toEqual([])
  })

  it('detaches from every game on dispose', async () => {
    const s = setup()
    await s.session.tryOpen(target, fg, { hold: false })
    s.session.dispose()
    expect(s.pipes[0]!.closed).toBe(true)
    expect(s.session.active()).toBe(false)
    expect(await s.session.tryOpen(target, fg, { hold: false })).toBe(false)
  })
})
