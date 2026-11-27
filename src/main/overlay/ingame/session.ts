import type { PadInfo } from '../../../shared/overlay'
import type { Settings, SettingsPatch } from '../../../shared/types'
import type { Logger } from '../../logger'
import type { ForegroundWindow, OverlayTarget } from '../overlay-logic'
import type { IngameGate } from './gate'
import type { IngameHelper } from './helper'
import type { PipeServer, PipeServerEvent, PipeServerEvents } from './pipe-server'
import { DRAWABLE_FORMATS, ToDll, type ResizePayload } from './protocol'
import { tMain } from '../../i18n'

/**
 * The in-game overlay for one game process at a time (docs/home-overlay.md, "In-game overlay"): the gate, the
 * injection, the pipe and the frames, put in order. tryOpen answers whether the overlay is now drawn inside the game;
 * on any doubt it answers false and the window overlay opens as before. A game that crashes soon after the injection,
 * or whose hook faults, never gets the in-game overlay again (Settings › Controls lists it) and the user is told.
 */

export const TIMING = {
  /** How long after the injector finished the DLL has to say HELLO. */
  helloMs: 2_000,
  /** How long a HELLO without a back buffer may wait for the first RESIZE. */
  resizeMs: 1_000,
  /** How long after SHOW the first Present with the overlay may take. */
  presentingMs: 1_000,
  /** How long HIDE may take to be answered. */
  hiddenMs: 1_000,
  /** Input is given back once no button is held, or after this long. */
  releaseMaxMs: 3_000,
  releasePollMs: 50,
  /** A crash (an NTSTATUS exception exit code) this soon after the injection is put down to the overlay. */
  crashWindowMs: 10 * 60_000
}

/** After this many failed opens a game process is left alone until it exits. */
export const MAX_FAILURES = 2

const NOT_DRAWABLE = 'cannot draw on its back buffer'

/** Exit codes from here up are NTSTATUS errors (0xC0000005 access violation and the like). */
const NTSTATUS_ERROR = 0xc0000000

/** Where the frames come from (frame-pump.ts). */
export interface IngamePump {
  /** Get the offscreen page ready at the back buffer's size. False when it could not be. */
  prepare(size: { width: number; height: number }): Promise<boolean>
  /** Start sending frames to `sink` (a whole frame first). */
  show(sink: { sendFrame(message: Buffer): boolean }): void
  hide(): void
}

export interface IngameSessionDeps {
  log: Logger
  gate: Pick<IngameGate, 'check'>
  helper: Pick<IngameHelper, 'inject' | 'watch' | 'dll'>
  createPipe: (gamePid: number) => PipeServer
  pump: IngamePump
  /** The controller reader: input goes back to the game only once every button is up. */
  pads: { pads(): PadInfo[] }
  settings: { get(): Settings; update(patch: SettingsPatch): unknown }
  /** Tell the user (a toast in the main window). */
  notify: (game: { id: string; title: string }, message: string) => void
  /** PlayOut main's pid (the only pipe server the DLL accepts). */
  ownPid?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  timing?: Partial<typeof TIMING>
}

export interface IngameSession {
  tryOpen(target: OverlayTarget, fg: ForegroundWindow, options: { hold: boolean }): Promise<boolean>
  /** Hide the in-game overlay; the controller goes back to the game once every button is up. */
  close(): Promise<void>
  active(): boolean
  /** The game process the in-game overlay is shown in (null while hidden). */
  activePid(): number | null
  /** The in-game overlay stopped by itself (the game or the DLL went away, or the game left exclusive mode). */
  onEnded(listener: (why: string) => void): () => void
  /** Tests: the pending input release has run. */
  idle(): Promise<void>
  /** Detach from every game (quitting PlayOut). */
  dispose(): void
}

interface Conn {
  pid: number
  game: { id: string; title: string }
  pipe: PipeServer | null
  /** When the DLL was first injected into this process (0: not yet). */
  injectedAt: number
  watching: boolean
  failures: number
  /** Left alone until it exits (too many failures, a fault, a crash). */
  skip: boolean
  buffer: ResizePayload | null
}

const drawable = (b: ResizePayload | null): b is ResizePayload =>
  !!b && b.width > 0 && b.height > 0 && b.exclusive && DRAWABLE_FORMATS.includes(b.format)

const describe = (b: ResizePayload | null): string =>
  b
    ? `${b.width}x${b.height}, format ${b.format}${b.exclusive ? ', exclusive' : ', not exclusive'}`
    : 'no back buffer'

/** The first of `events` the pipe sends within `ms`, or null. */
function waitFor<E extends PipeServerEvent>(
  pipe: PipeServer,
  events: E[],
  ms: number
): Promise<{ event: E; payload: PipeServerEvents[E] } | null> {
  return new Promise((resolve) => {
    const offs: (() => void)[] = []
    const done = (value: { event: E; payload: PipeServerEvents[E] } | null): void => {
      clearTimeout(timer)
      for (const off of offs) off()
      resolve(value)
    }
    const timer = setTimeout(() => done(null), ms)
    for (const event of events) offs.push(pipe.on(event, (payload) => done({ event, payload })))
  })
}

export function createIngameSession(deps: IngameSessionDeps): IngameSession {
  const { log } = deps
  const t = { ...TIMING, ...deps.timing }
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const ownPid = deps.ownPid ?? process.pid
  const conns = new Map<number, Conn>()
  const endedListeners = new Set<(why: string) => void>()
  let activeConn: Conn | null = null
  /** The connection an open is waiting on (its own failure is reported by open(), never as 'ended'). */
  let openingConn: Conn | null = null
  let releaseGen = 0
  let release: Promise<void> = Promise.resolve()
  let disposed = false

  const emitEnded = (why: string): void => {
    for (const l of endedListeners) {
      try {
        l(why)
      } catch (err) {
        log.warn('ingame: ended listener failed', err)
      }
    }
  }

  /** Give the controller back to the game once every button is up (at most releaseMaxMs from now). */
  function scheduleRelease(conn: Conn): void {
    const gen = ++releaseGen
    release = (async () => {
      // Counted in polls, not by the clock, so a stuck clock never keeps the controller from the game.
      for (let waited = 0; waited < t.releaseMaxMs; waited += t.releasePollMs) {
        if (gen !== releaseGen) return
        const held = deps.pads.pads().some((p) => p.buttons !== 0)
        if (!held) break
        await sleep(t.releasePollMs)
      }
      if (gen !== releaseGen) return
      conn.pipe?.send(ToDll.INPUT_RELEASE)
    })()
  }

  /** The overlay stops by itself while shown. */
  function end(conn: Conn, why: string): void {
    if (activeConn !== conn) return
    activeConn = null
    log.info(`ingame: overlay in ${conn.game.title} ended (${why})`)
    deps.pump.hide()
    conn.pipe?.send(ToDll.HIDE)
    scheduleRelease(conn)
    // During an open the open itself fails (and the window overlay is used): an 'ended' would close that fallback.
    if (openingConn !== conn) emitEnded(why)
  }

  /** Never again for this game: added to Settings › Controls' list, and the user is told. */
  function disable(conn: Conn, why: string, notice: string): void {
    conn.skip = true
    log.warn(`ingame: turning the in-game overlay off for ${conn.game.title} (${why})`)
    try {
      const never = deps.settings.get().input.ingameNever ?? []
      if (!never.includes(conn.game.id)) {
        deps.settings.update({ input: { ingameNever: [...never, conn.game.id] } })
      }
    } catch (err) {
      log.warn('ingame: could not save the game to the never list', err)
    }
    try {
      deps.notify(conn.game, notice)
    } catch (err) {
      log.warn('ingame: notice failed', err)
    }
    end(conn, why)
    conn.pipe?.close()
    conn.pipe = null
  }

  function fail(conn: Conn, why: string): void {
    conn.failures++
    log.warn(`ingame: could not open in ${conn.game.title} (${conn.pid}): ${why}`)
    if (conn.failures >= MAX_FAILURES && !conn.skip) {
      conn.skip = true
      log.info(`ingame: ${conn.game.title} (${conn.pid}) gets the window overlay until it exits`)
      conn.pipe?.close()
      conn.pipe = null
    }
  }

  function watch(conn: Conn): void {
    if (conn.watching) return
    conn.watching = true
    void deps.helper
      .watch(conn.pid)
      .catch(() => null)
      .then((code) => {
        if (conns.get(conn.pid) === conn) conns.delete(conn.pid)
        if (code === null) {
          // Unknown (the watch could not run): the process is treated as gone only when the pipe is.
          if (!conn.pipe?.connected()) end(conn, 'the game is gone')
          return
        }
        log.info(`ingame: ${conn.game.title} (${conn.pid}) exited with 0x${code.toString(16)}`)
        if (
          code >= NTSTATUS_ERROR &&
          conn.injectedAt &&
          now() - conn.injectedAt < t.crashWindowMs
        ) {
          const hex = `0x${code.toString(16).toUpperCase()}`
          disable(
            conn,
            `crashed (${hex}) after the in-game overlay was added`,
            tMain('mainOverlay.ingame.crashed', { title: conn.game.title, code: hex })
          )
        }
        end(conn, 'the game exited')
        conn.pipe?.close()
        conn.pipe = null
      })
  }

  function listen(conn: Conn, pipe: PipeServer): void {
    pipe.on('resize', (r) => {
      if (conn.pipe !== pipe) return
      conn.buffer = r
      if (activeConn !== conn) return
      if (!drawable(r)) {
        end(conn, `the back buffer changed (${describe(r)})`)
        return
      }
      void deps.pump.prepare({ width: r.width, height: r.height }).then((ok) => {
        if (!ok) end(conn, 'the overlay page could not follow the new size')
      })
    })
    pipe.on('unsupported', (u) => {
      if (conn.pipe === pipe && activeConn === conn) end(conn, `unsupported: ${u.reason}`)
    })
    pipe.on('fault', (f) => {
      if (conn.pipe !== pipe) return
      const where = `${f.where}, 0x${(f.code >>> 0).toString(16)}`
      disable(
        conn,
        `had a problem with the in-game overlay (${where})`,
        tMain('mainOverlay.ingame.fault', { title: conn.game.title, where })
      )
    })
    pipe.on('log', (l) => {
      const fn = l.level === 'error' ? log.error : l.level === 'warn' ? log.warn : log.info
      fn(`ingame dll: ${l.message}`)
    })
    pipe.on('gone', ({ reason }) => {
      if (conn.pipe !== pipe) return
      conn.pipe = null
      end(conn, `the overlay in the game stopped answering (${reason})`)
    })
  }

  /** Connect (inject first when needed), show, and wait for the first Present with the overlay. */
  async function open(conn: Conn, hold: boolean): Promise<string | null> {
    let pipe = conn.pipe
    if (!pipe || !pipe.connected()) {
      pipe?.close()
      pipe = deps.createPipe(conn.pid)
      conn.pipe = pipe
      conn.buffer = null
      listen(conn, pipe)
      try {
        await pipe.listen()
      } catch (err) {
        conn.pipe = null
        return `the pipe could not be created (${(err as Error)?.message})`
      }
      const injected = await deps.helper
        .inject({
          pid: conn.pid,
          dll: deps.helper.dll,
          pipe: pipe.name,
          token: pipe.token,
          playoutPid: ownPid
        })
        .catch(() => null)
      if (!injected) return 'the injector gave no answer'
      if (!injected.ok) return `injection failed at ${injected.step}: ${injected.error}`
      if (!conn.injectedAt) conn.injectedAt = now()
      watch(conn)
      if (!pipe.hello()) await waitFor(pipe, ['hello', 'gone'], t.helloMs)
      const hello = pipe.hello()
      if (!hello || !pipe.connected()) return 'no HELLO from the game'
      if (!conn.buffer) conn.buffer = hello
    }
    if (!conn.buffer || conn.buffer.width <= 0) {
      const got = await waitFor(pipe, ['resize', 'gone'], t.resizeMs)
      if (got?.event !== 'resize') return 'the game has presented nothing yet'
    }
    const buffer = conn.buffer
    if (!drawable(buffer)) return NOT_DRAWABLE + ` (${describe(buffer)})`
    if (!(await deps.pump.prepare({ width: buffer.width, height: buffer.height })))
      return 'the overlay page could not be prepared'
    if (conn.pipe !== pipe || !pipe.connected()) return 'the game went away'

    // Any input release still pending is dropped: SHOW blocks the controller again.
    releaseGen++
    activeConn = conn
    openingConn = conn
    let got: Awaited<ReturnType<typeof waitFor>>
    try {
      const presenting = waitFor(pipe, ['presenting', 'unsupported', 'gone'], t.presentingMs)
      deps.pump.show({ sendFrame: (m) => pipe.sendFrame(m) })
      pipe.send(ToDll.SHOW, { hold })
      got = await presenting
    } finally {
      if (openingConn === conn) openingConn = null
    }
    if (got?.event === 'presenting' && activeConn === conn) {
      log.info(
        `ingame: overlay shown in ${conn.game.title} (${conn.pid}, ${describe(buffer)}${hold ? ', held' : ''})`
      )
      return null
    }
    if (activeConn === conn) activeConn = null
    deps.pump.hide()
    pipe.send(ToDll.HIDE)
    // SHOW blocked the controller: it goes back to the game right away (the window overlay opens instead).
    pipe.send(ToDll.INPUT_RELEASE)
    if (!got) return 'the game drew no frame with the overlay'
    if (got.event === 'unsupported')
      return `unsupported: ${(got.payload as { reason: string }).reason}`
    return 'the game went away'
  }

  return {
    async tryOpen(target, fg, { hold }) {
      if (disposed || !target.pid) return false
      const existing = conns.get(target.pid)
      if (existing?.skip) {
        log.info(`ingame: skipping ${existing.game.title} (${target.pid}) this session`)
        return false
      }
      const verdict = await deps.gate.check(target, fg)
      if (!verdict.ok) {
        log.info(
          `ingame: not for ${target.program}: ${verdict.reason}${verdict.detail ? ` (${verdict.detail})` : ''}`
        )
        return false
      }
      const conn: Conn = existing ?? {
        pid: target.pid,
        game: { id: verdict.game.id, title: verdict.game.title },
        pipe: null,
        injectedAt: 0,
        watching: false,
        failures: 0,
        skip: false,
        buffer: null
      }
      conn.game = { id: verdict.game.id, title: verdict.game.title }
      conns.set(conn.pid, conn)
      let why: string | null
      try {
        why = await open(conn, hold)
      } catch (err) {
        why = `failed: ${(err as Error)?.message ?? err}`
      }
      if (why === null) return true
      if (activeConn === conn) activeConn = null
      // A game out of exclusive mode (or in HDR) is no failure: the window overlay is right for it, and it may come back.
      if (why.startsWith(NOT_DRAWABLE) && conn.pipe?.connected())
        log.info(`ingame: ${conn.game.title}: ${why}`)
      else if (!conn.skip) fail(conn, why)
      return false
    },
    async close() {
      const conn = activeConn
      if (!conn) return
      activeConn = null
      const pipe = conn.pipe
      if (pipe?.connected()) {
        const hidden = waitFor(pipe, ['hidden', 'gone'], t.hiddenMs)
        pipe.send(ToDll.HIDE)
        if (!(await hidden)) log.warn(`ingame: ${conn.game.title} did not answer HIDE`)
      }
      deps.pump.hide()
      scheduleRelease(conn)
      log.info(`ingame: overlay hidden in ${conn.game.title}`)
    },
    active: () => activeConn !== null,
    activePid: () => activeConn?.pid ?? null,
    onEnded(listener) {
      endedListeners.add(listener)
      return () => endedListeners.delete(listener)
    },
    idle: () => release,
    dispose() {
      disposed = true
      releaseGen++
      activeConn = null
      for (const conn of conns.values()) {
        conn.pipe?.close()
        conn.pipe = null
      }
      conns.clear()
      endedListeners.clear()
    }
  }
}
