import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ForegroundWindow, PauseResult } from '../native-host/native-ops'
import { createPauseOwners } from '../overlay/pause-owners'
import {
  createSleepWakeService,
  SETTLE_MS,
  THAW_SLOW_MS,
  THAW_TRIES,
  type SleepWakeDeps
} from './service'

let dir: string
const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'playout-sleep-'))
  vi.clearAllMocks()
})
// A service may still be writing its last file when its test ends: the removal is retried instead of failing on it.
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))

/**
 * Waits for something the service does in its own time. It reads and writes real files behind its timers, which takes
 * as long as the disk and the processor allow: a fixed pause is too short on a busy PC.
 */
const until = (check: () => void | Promise<void>): Promise<void> =>
  vi.waitFor(check, { timeout: 15_000, interval: 5 })
/** A step of the service is over once it has logged its outcome (the last thing each step does). */
const logged = (level: 'info' | 'warn', text: string, times = 1): Promise<void> =>
  until(() =>
    expect(log[level].mock.calls.filter((c) => String(c[0]).includes(text))).toHaveLength(times)
  )
const gone = (file: string): Promise<void> => until(() => expect(stat(file)).rejects.toThrow())

const game = (exe = 'C:\\Games\\pcsx2-qt.exe', pid = 4242, fullscreen = true): ForegroundWindow =>
  ({
    hwnd: '77',
    pid,
    exe,
    exclusive: false,
    fullscreen,
    rect: null,
    monitor: null
  }) as unknown as ForegroundWindow

/** Timers run only when the test says so. */
function timers(): {
  set: NonNullable<SleepWakeDeps['setTimer']>
  run: () => Promise<void>
} {
  let pending: (() => void)[] = []
  return {
    set: (fn) => {
      pending.push(fn)
      return { cancel: () => (pending = pending.filter((f) => f !== fn)) }
    },
    run: async () => {
      const now = pending
      pending = []
      for (const fn of now) fn()
      await new Promise((r) => setTimeout(r, 20))
    }
  }
}

function setup(over: Partial<SleepWakeDeps> = {}): {
  deps: SleepWakeDeps
  pause: ReturnType<typeof vi.fn>
  elevated: ReturnType<typeof vi.fn>
  state: {
    enabled: boolean
    running: boolean
    fg: ForegroundWindow | null
    idle: string
    images: Set<string> | null
  }
  t: ReturnType<typeof timers>
} {
  const state = {
    enabled: true,
    running: true,
    fg: game() as ForegroundWindow | null,
    idle: 'active',
    images: new Set<string>() as Set<string> | null
  }
  const pause = vi.fn(async (_pid: number, p: boolean): Promise<PauseResult> => ({
    ok: true,
    created: p ? 99 : 99
  }))
  const elevated = vi.fn(async () => 0 as number | null)
  const t = timers()
  const deps: SleepWakeDeps = {
    log,
    userData: dir,
    enabled: () => state.enabled,
    gameRunning: () => state.running,
    native: { foreground: async () => state.fg, pauseProcess: pause },
    isPlayOutWindow: () => false,
    runningImages: async () => state.images,
    idleState: () => state.idle,
    runElevatedScript: elevated,
    ownPid: 1,
    setTimer: t.set,
    ...over
  }
  return { deps, pause, elevated, state, t }
}

describe('Enhanced Sleep/Wake: the game', () => {
  it('freezes the game on sleep and resumes it once awake and unlocked, after a settle', async () => {
    const { deps, pause, state, t } = setup()
    const sleep = createSleepWakeService(deps)
    await sleep.onSleep()
    expect(pause).toHaveBeenLastCalledWith(4242, true)
    expect(JSON.parse(await readFile(join(dir, 'sleep', 'frozen.json'), 'utf8'))).toMatchObject({
      pid: 4242
    })
    // A second sleep signal (lock, then suspend) does not freeze twice.
    await sleep.onSleep()
    expect(pause).toHaveBeenCalledTimes(1)

    // Woken but still locked: the game stays frozen until the unlock.
    state.idle = 'locked'
    await sleep.onWake()
    await t.run()
    expect(pause).toHaveBeenCalledTimes(1)
    state.idle = 'active'
    await sleep.onUnlock()
    await t.run()
    expect(pause).toHaveBeenLastCalledWith(4242, false, 99)
    await gone(join(dir, 'sleep', 'frozen.json'))
    await sleep.dispose()
  })

  it('freezes the game last seen in front when the lock screen is in front', async () => {
    const { deps, pause, state, t } = setup()
    const sleep = createSleepWakeService(deps)
    sleep.start()
    await t.run() // the watch notes the game in front
    state.fg = game('C:\\Windows\\System32\\LockApp.exe', 9) // never paused
    await sleep.onSleep()
    expect(pause).toHaveBeenCalledWith(4242, true)
    await sleep.dispose()
  })

  it('never freezes without a game, with the setting off, PlayOut itself, or under anti-cheat', async () => {
    const off = setup()
    off.state.enabled = false
    await createSleepWakeService(off.deps).onSleep()
    const none = setup()
    none.state.running = false
    await createSleepWakeService(none.deps).onSleep()
    const shell = setup()
    shell.state.fg = game('C:\\Windows\\explorer.exe', 10)
    await createSleepWakeService(shell.deps).onSleep()
    const guarded = setup()
    guarded.state.images = new Set(['easyanticheat.exe'])
    await createSleepWakeService(guarded.deps).onSleep()
    for (const s of [off, none, shell, guarded]) expect(s.pause).not.toHaveBeenCalled()
  })

  it('never takes a windowed program for the game, and never freezes when the process list is unknown', async () => {
    const chat = setup()
    chat.state.fg = game('C:\\Apps\\Discord.exe', 50, false)
    await createSleepWakeService(chat.deps).onSleep()
    const unknown = setup()
    unknown.state.images = null
    await createSleepWakeService(unknown.deps).onSleep()
    expect(chat.pause).not.toHaveBeenCalled()
    expect(unknown.pause).not.toHaveBeenCalled()
  })

  it('thaws a game whose freeze finished after the PC woke up', async () => {
    const { deps, pause, t } = setup()
    let finish!: () => void
    const slow = new Promise<void>((r) => (finish = r))
    pause.mockImplementationOnce(async () => {
      await slow
      return { ok: true, created: 99 }
    })
    const sleep = createSleepWakeService(deps)
    const freezing = sleep.onSleep()
    await new Promise((r) => setTimeout(r, 10))
    // Woken (and unlocked) before the freeze answered.
    await sleep.onWake()
    finish()
    await freezing
    await t.run()
    expect(pause).toHaveBeenLastCalledWith(4242, false, 99)
    await sleep.dispose()
  })

  it('does not freeze once the PC is awake again, when the checks before the freeze outlasted the sleep', async () => {
    let finish!: (images: Set<string>) => void
    let slow = new Promise<Set<string> | null>((r) => (finish = r))
    const { deps, pause, state, t } = setup({ runningImages: () => slow })
    const sleep = createSleepWakeService(deps)
    // Suspend: Windows stops PlayOut while the process list is still being read.
    const freezing = sleep.onSleep()
    await new Promise((r) => setTimeout(r, 10))
    // Awake and unlocked before the list arrived: the game must not stall now.
    await sleep.onWake()
    finish(new Set())
    await freezing
    await t.run()
    expect(pause).not.toHaveBeenCalled()
    await expect(stat(join(dir, 'sleep', 'frozen.json'))).rejects.toThrow()

    // Woken to the lock screen instead: the PC is not in use yet, so the freeze still lands, until the unlock.
    slow = new Promise<Set<string> | null>((r) => (finish = r))
    const again = sleep.onSleep()
    await new Promise((r) => setTimeout(r, 10))
    state.idle = 'locked'
    await sleep.onWake()
    finish(new Set())
    await again
    expect(pause).toHaveBeenLastCalledWith(4242, true)
    state.idle = 'active'
    await sleep.onUnlock()
    await t.run()
    expect(pause).toHaveBeenLastCalledWith(4242, false, 99)
    await sleep.dispose()
  })

  it('never leaves the game frozen when a second sleep signal waited behind a freeze that outlasted the sleep', async () => {
    let finish!: (images: Set<string>) => void
    const slow = new Promise<Set<string> | null>((r) => (finish = r))
    const { deps, pause, t } = setup({ runningImages: () => slow })
    const sleep = createSleepWakeService(deps)
    // Lock, then suspend: the second signal waits behind the first one's checks.
    const first = sleep.onSleep()
    const second = sleep.onSleep()
    await new Promise((r) => setTimeout(r, 10))
    await sleep.onUnlock()
    finish(new Set())
    await Promise.all([first, second])
    await t.run()
    // Either nothing was frozen, or what was frozen runs again.
    const calls = pause.mock.calls.map((c) => c[1] as boolean)
    expect(calls.filter((p) => p).length).toBe(calls.filter((p) => !p).length)
    expect(calls).toEqual([])
    await sleep.dispose()
  })

  it('keeps trying to resume a game the native host does not answer for, and keeps its record', async () => {
    const delays: number[] = []
    const base = setup()
    const { deps, pause, t } = setup({
      setTimer: (fn, ms) => {
        delays.push(ms)
        return base.t.set(fn, ms)
      }
    })
    void t
    let answers = false
    pause.mockImplementation(async (_pid: number, p: boolean) =>
      p || answers ? { ok: true, created: 99 } : { ok: false, error: 'timeout' }
    )
    const sleep = createSleepWakeService(deps)
    await sleep.onSleep()
    await sleep.onWake()
    for (let i = 0; i < THAW_TRIES + 2; i++) await base.t.run()
    const resumes = (): number => pause.mock.calls.filter((c) => c[1] === false).length
    // Not given up after THAW_TRIES: tried on, slowly, and the record is still there.
    expect(resumes()).toBe(THAW_TRIES + 2)
    expect(delays.slice(0, THAW_TRIES)).toEqual(Array(THAW_TRIES).fill(SETTLE_MS))
    expect(delays.slice(THAW_TRIES)).toEqual(Array(3).fill(THAW_SLOW_MS))
    expect(JSON.parse(await readFile(join(dir, 'sleep', 'frozen.json'), 'utf8'))).toMatchObject({
      pid: 4242,
      created: 99
    })
    // Still known as frozen: another sleep never freezes it a second time over it.
    await sleep.onSleep()
    expect(pause.mock.calls.filter((c) => c[1] === true)).toHaveLength(1)

    // The host answers again: the game runs and the record goes.
    answers = true
    await sleep.onWake()
    await base.t.run()
    expect(pause).toHaveBeenLastCalledWith(4242, false, 99)
    await gone(join(dir, 'sleep', 'frozen.json'))
    const settled = resumes()
    await base.t.run()
    expect(resumes()).toBe(settled)
    await sleep.dispose()
  })

  it('shares one suspend with the overlay pause, whichever of the two resumes first', async () => {
    for (const sleepFirst of [true, false]) {
      // Windows counts suspends: the game runs only at 0.
      let suspended = 0
      const native = vi.fn(async (_pid: number, p: boolean): Promise<PauseResult> => {
        suspended = Math.max(0, suspended + (p ? 1 : -1))
        return { ok: true, created: 99 }
      })
      const owners = createPauseOwners(native)
      const overlayPause = owners.owner('overlay')
      const { deps, t } = setup({
        native: { foreground: async () => game(), pauseProcess: owners.owner('sleep') }
      })
      const sleep = createSleepWakeService(deps)
      // The overlay is open over the paused game when the screen locks.
      await overlayPause(4242, true)
      await sleep.onSleep()
      expect(suspended).toBe(1)
      const unlock = async (): Promise<void> => {
        await sleep.onUnlock()
        await t.run()
      }
      if (sleepFirst) {
        await unlock()
        // Still paused under the open overlay.
        expect(suspended).toBe(1)
        await overlayPause(4242, false, 99)
      } else {
        await overlayPause(4242, false, 99)
        // Still frozen behind the lock screen.
        expect(suspended).toBe(1)
        await unlock()
      }
      expect(suspended).toBe(0)
      await gone(join(dir, 'sleep', 'frozen.json'))
      await sleep.dispose()
    }
  })

  it('keeps a freeze the native host did not answer, so the wake still resumes it', async () => {
    const { deps, pause, t } = setup()
    pause.mockImplementationOnce(async () => ({ ok: false, error: 'timeout' }))
    const sleep = createSleepWakeService(deps)
    await sleep.onSleep()
    await sleep.onWake()
    await t.run()
    expect(pause).toHaveBeenLastCalledWith(4242, false, 0)
    await sleep.dispose()
  })

  it('resumes a game a crash left frozen, and on quit', async () => {
    await mkdir(join(dir, 'sleep'), { recursive: true })
    await writeFile(
      join(dir, 'sleep', 'frozen.json'),
      JSON.stringify({ pid: 7, created: 5, program: 'Game.exe' })
    )
    const { deps, pause } = setup()
    const sleep = createSleepWakeService(deps)
    sleep.start()
    await until(() => expect(pause).toHaveBeenCalledWith(7, false, 5))
    await sleep.onSleep()
    await sleep.dispose()
    expect(pause).toHaveBeenLastCalledWith(4242, false, 99)
  })
})

describe('Enhanced Sleep/Wake: the Windows changes', () => {
  const ledgerFile = (): string => join(dir, 'sleep', 'wake-sources.json')

  it('makes them once after start-up, and undoes exactly what the ledger records when turned off', async () => {
    const { deps, elevated, state, t } = setup()
    elevated.mockImplementationOnce(async () => {
      await writeFile(
        ledgerFile(),
        JSON.stringify({
          devices: ['Intel(R) Wi-Fi 6E AX211 160MHz'],
          hibernate: { scheme: '381b4222-f694-41f0-9685-ff5bb260df2e', ac: 0, dc: null }
        })
      )
      return 0
    })
    const sleep = createSleepWakeService(deps)
    sleep.start()
    expect(elevated).not.toHaveBeenCalled()
    await t.run()
    await t.run()
    await logged('info', 'wake disarmed')
    expect(elevated).toHaveBeenCalledTimes(1)
    expect(elevated.mock.calls[0][0]).toContain('powercfg -devicequery wake_armed')

    // A restart does not ask again.
    const again = createSleepWakeService(deps)
    again.start()
    await t.run()
    await t.run()
    expect(elevated).toHaveBeenCalledTimes(1)

    // The undo waits behind the restart's own step: the second prompt being the undo also says that step asked nothing.
    state.enabled = false
    again.sync()
    await logged('info', 'Windows changes undone')
    expect(elevated).toHaveBeenCalledTimes(2)
    const revert = String(elevated.mock.calls[1][0])
    expect(revert).toContain("powercfg -deviceenablewake 'Intel(R) Wi-Fi 6E AX211 160MHz'")
    expect(revert).toContain('/setacvalueindex')
    expect(revert).not.toContain('/setdcvalueindex')
    await expect(stat(ledgerFile())).rejects.toThrow()
    await sleep.dispose()
    await again.dispose()
  })

  it('keeps what an earlier run changed when it runs again', async () => {
    const { deps, elevated, t } = setup()
    await mkdir(join(dir, 'sleep'), { recursive: true })
    await writeFile(
      ledgerFile(),
      JSON.stringify({
        devices: ['Old NIC'],
        hibernate: { scheme: '381b4222-f694-41f0-9685-ff5bb260df2e', ac: 0, dc: 0 }
      })
    )
    elevated.mockImplementationOnce(async () => {
      await writeFile(ledgerFile(), JSON.stringify({ devices: ['New NIC'], hibernate: null }))
      return 0
    })
    const sleep = createSleepWakeService(deps)
    sleep.start()
    await t.run()
    await t.run()
    await logged('info', 'wake disarmed')
    const merged = JSON.parse(await readFile(ledgerFile(), 'utf8'))
    expect(merged.devices).toEqual(['Old NIC', 'New NIC'])
    expect(merged.power).toEqual([
      expect.objectContaining({ setting: '9d7815a6-7ee4-497e-8888-515a05f02364', ac: 0, dc: 0 })
    ])
    await sleep.dispose()
  })

  it('never counts a step that did not run as done, and keeps the earlier ledger aside until it is merged', async () => {
    const { deps, elevated, t } = setup()
    await mkdir(join(dir, 'sleep'), { recursive: true })
    await writeFile(
      join(dir, 'sleep', 'state.json'),
      JSON.stringify({ applied: true, declined: false })
    )
    await writeFile(ledgerFile(), JSON.stringify({ devices: ['Old NIC'], hibernate: null }))
    // Could not start (code null), after the script had already begun a new, empty ledger.
    elevated.mockImplementationOnce(async () => {
      expect(
        JSON.parse(await readFile(join(dir, 'sleep', 'wake-sources.prior.json'), 'utf8')).devices
      ).toEqual(['Old NIC'])
      await writeFile(ledgerFile(), JSON.stringify({ devices: [], power: [] }))
      return null
    })
    const sleep = createSleepWakeService(deps)
    sleep.start()
    await t.run()
    await t.run()
    await logged('warn', 'the Windows changes failed')
    expect(JSON.parse(await readFile(ledgerFile(), 'utf8')).devices).toEqual(['Old NIC'])
    await expect(stat(join(dir, 'sleep', 'wake-sources.prior.json'))).rejects.toThrow()
    // Tried again at the next start.
    const again = createSleepWakeService(deps)
    again.start()
    await t.run()
    await t.run()
    await logged('info', 'wake disarmed')
    expect(elevated).toHaveBeenCalledTimes(2)
    await sleep.dispose()
    await again.dispose()
  })

  it('makes the changes again when turned back on after an undo that partly failed', async () => {
    const { deps, elevated, state, t } = setup()
    await mkdir(join(dir, 'sleep'), { recursive: true })
    await writeFile(
      join(dir, 'sleep', 'state.json'),
      JSON.stringify({ applied: true, declined: false, version: 2 })
    )
    await writeFile(ledgerFile(), JSON.stringify({ devices: ['NIC'], hibernation: true }))
    state.enabled = false
    const sleep = createSleepWakeService(deps)
    elevated.mockResolvedValueOnce(2) // the undo partly failed
    sleep.start()
    await logged('warn', 'could not be undone')
    expect(String(elevated.mock.calls[0][0])).toContain('powercfg /hibernate off')
    state.enabled = true
    sleep.sync()
    await logged('info', 'wake disarmed')
    expect(elevated).toHaveBeenCalledTimes(2)
    expect(String(elevated.mock.calls[1][0])).toContain('powercfg -devicequery wake_armed')
    await sleep.dispose()
    void t
  })

  it('keeps the start-up step when another setting changes, and never undoes while the setting is on', async () => {
    const { deps, elevated, state, t } = setup()
    const sleep = createSleepWakeService(deps)
    sleep.start()
    sleep.sync() // some other setting changed within the first 20 s
    await t.run()
    await t.run()
    // (The step leaves no record in this test, so it ends as failed and is made again when turned back on.)
    await logged('warn', 'the Windows changes failed')
    expect(elevated).toHaveBeenCalledTimes(1)
    // Off then on again before the undo ran: no prompt to undo.
    state.enabled = false
    sleep.sync()
    state.enabled = true
    sleep.sync()
    // Everything the two changes started is over once the step made on turning it back on is.
    await logged('warn', 'the Windows changes failed', 2)
    expect(elevated.mock.calls.map((c) => String(c[0]).includes('wake_armed'))).not.toContain(false)
    await sleep.dispose()
  })

  it('does not ask to undo at every start after the undo was declined', async () => {
    const { deps, elevated, state } = setup()
    await mkdir(join(dir, 'sleep'), { recursive: true })
    await writeFile(
      join(dir, 'sleep', 'state.json'),
      JSON.stringify({ applied: true, declined: false, version: 2 })
    )
    await writeFile(ledgerFile(), JSON.stringify({ devices: ['NIC'] }))
    state.enabled = false
    elevated.mockResolvedValueOnce(1223)
    const first = createSleepWakeService(deps)
    first.start()
    await logged('info', 'undoing the Windows changes was declined')
    const second = createSleepWakeService(deps)
    second.start()
    await new Promise((r) => setTimeout(r, 30))
    expect(elevated).toHaveBeenCalledTimes(1)
    await first.dispose()
    await second.dispose()
  })

  it('runs once more where an older version of the step ran, keeping what it changed', async () => {
    const { deps, elevated, t } = setup()
    await mkdir(join(dir, 'sleep'), { recursive: true })
    await writeFile(
      join(dir, 'sleep', 'state.json'),
      JSON.stringify({ applied: true, declined: false })
    )
    await writeFile(ledgerFile(), JSON.stringify({ devices: ['Old NIC'], hibernate: null }))
    elevated.mockImplementationOnce(async () => {
      await writeFile(
        ledgerFile(),
        JSON.stringify({
          devices: [],
          power: [
            {
              scheme: '381b4222-f694-41f0-9685-ff5bb260df2e',
              sub: 'fea3413e-7e05-4911-9a71-700331f1c294',
              setting: 'f15576e8-98b7-4186-b944-eafa664402d9',
              target: 0,
              ac: 1,
              dc: 2
            }
          ],
          hibernation: false,
          maintenanceWake: null
        })
      )
      return 0
    })
    const sleep = createSleepWakeService(deps)
    sleep.start()
    await t.run()
    await t.run()
    await logged('info', 'wake disarmed')
    expect(elevated).toHaveBeenCalledTimes(1)
    const merged = JSON.parse(await readFile(ledgerFile(), 'utf8'))
    expect(merged.devices).toEqual(['Old NIC'])
    expect(merged.power).toHaveLength(1)
    // And not again at the next start.
    const again = createSleepWakeService(deps)
    again.start()
    await t.run()
    await t.run()
    expect(elevated).toHaveBeenCalledTimes(1)
    await sleep.dispose()
    await again.dispose()
  })

  it('never makes the game wait behind an unanswered elevation prompt, nor the quit', async () => {
    const { deps, elevated, pause, t } = setup()
    elevated.mockImplementation(() => new Promise<number | null>(() => undefined))
    const sleep = createSleepWakeService(deps)
    sleep.start()
    await t.run() // the elevated step starts and never ends
    await sleep.onSleep()
    expect(pause).toHaveBeenCalledWith(4242, true)
    const quit = Date.now()
    await sleep.dispose()
    expect(Date.now() - quit).toBeLessThan(4000)
  })

  it('does not ask again after a declined prompt, until the setting is turned on again', async () => {
    const { deps, elevated, state, t } = setup()
    elevated.mockResolvedValueOnce(1223)
    // A service runs its Windows steps one after the other, and the undo starts by reading the setting: the prompts
    // counted at that moment are all that the start-up step before it asked for.
    let turnedOffAndOn = false
    let askedByStartUp: number | null = null
    deps.enabled = () => {
      if (turnedOffAndOn) askedByStartUp ??= elevated.mock.calls.length
      return state.enabled
    }
    const sleep = createSleepWakeService(deps)
    sleep.start()
    await t.run()
    await t.run()
    // The refusal is on record (state.json) before the next start reads it.
    await logged('info', 'the Windows changes were declined')
    const later = createSleepWakeService(deps)
    later.start()
    await t.run()
    await t.run()
    expect(elevated).toHaveBeenCalledTimes(1)
    state.enabled = false
    later.sync()
    state.enabled = true
    later.sync()
    turnedOffAndOn = true
    // (The step leaves no record in this test, so it ends as failed.)
    await logged('warn', 'the Windows changes failed')
    expect(askedByStartUp).toBe(1)
    expect(elevated).toHaveBeenCalledTimes(2)
    await sleep.dispose()
    await later.dispose()
  })
})
