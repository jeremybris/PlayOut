import { promises as fs } from 'fs'
import { join } from 'path'
import type { ControllerWakeStatus } from '../../shared/controller-wake'
import type { Logger } from '../logger'
import { applyScript, parseLedger, revertScript, xboxDevices } from './scripts'

/**
 * Wake with the Xbox button (Settings > System; scripts.ts): while the setting is on, the Xbox devices whose wake
 * setting Windows lets change are allowed to wake the PC, in one administrator step; turning it off allows them no
 * longer (only those PlayOut allowed). The step runs when the setting is turned on, and at a start where an Xbox
 * device it has not tried yet (one plugged in since, or one a driver update reset) is not allowed to wake the PC; a
 * device Windows would not allow is not asked for again at every start, only when the setting is turned on again. A
 * declined prompt is not asked again until the setting is switched again.
 */

/** What the probe reads (no elevation): every device of each powercfg list. */
export interface WakeProbe {
  capable: string[]
  armed: string[]
  programmable: string[]
  adapter: boolean
}

export interface ControllerWakeDeps {
  log: Logger
  userData: string
  /** The setting (system.controllerWake). */
  enabled(): boolean
  /** Reads the wake lists (null when they cannot be read). */
  probe(): Promise<WakeProbe | null>
  /** Runs a PowerShell script elevated; its exit code (1223: declined). */
  runElevatedScript(script: string): Promise<number | null>
  events: { emit(event: 'controller-wake:status', payload: ControllerWakeStatus): void }
}

export interface ControllerWakeService {
  start(): void
  /** The setting changed. */
  sync(): void
  /** The wake lists read now. */
  status(): Promise<ControllerWakeStatus>
}

interface State {
  /** The last prompt was declined: not asked again until the setting is switched again. */
  declined: boolean
  /** Windows did not make every change of the last step. */
  failed: boolean
  /** Devices the setting tried to allow since it was turned on (not tried again at a start). */
  tried: string[]
}

const NO_STATE: State = { declined: false, failed: false, tried: [] }

export function createControllerWakeService(deps: ControllerWakeDeps): ControllerWakeService {
  const { log } = deps
  const dir = join(deps.userData, 'controller-wake')
  const ledgerFile = join(dir, 'ledger.json')
  const stateFile = join(dir, 'state.json')
  let working = false
  let lastEnabled: boolean | null = null
  let queue: Promise<void> = Promise.resolve()
  const run = (task: () => Promise<void>): Promise<void> => {
    const next = queue.then(task, task)
    queue = next.catch(() => undefined)
    return next
  }

  async function readLedger(): Promise<string[]> {
    try {
      return parseLedger(await fs.readFile(ledgerFile, 'utf8')) ?? []
    } catch {
      return []
    }
  }
  async function writeLedger(devices: string[]): Promise<void> {
    await fs.mkdir(dir, { recursive: true })
    if (devices.length) await fs.writeFile(ledgerFile, JSON.stringify({ devices }))
    else await fs.rm(ledgerFile, { force: true })
  }
  async function readState(): Promise<State> {
    try {
      const raw = JSON.parse(await fs.readFile(stateFile, 'utf8')) as Partial<State>
      return {
        declined: raw.declined === true,
        failed: raw.failed === true,
        tried: Array.isArray(raw.tried) ? raw.tried.filter((t) => typeof t === 'string') : []
      }
    } catch {
      return { ...NO_STATE }
    }
  }
  async function writeState(state: State): Promise<void> {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(stateFile, JSON.stringify(state))
  }

  async function status(): Promise<ControllerWakeStatus> {
    const [p, state] = await Promise.all([deps.probe().catch(() => null), readState()])
    return {
      enabled: deps.enabled(),
      capable: xboxDevices(p?.capable ?? []),
      armed: xboxDevices(p?.armed ?? []),
      programmable: xboxDevices(p?.programmable ?? []),
      readable: p !== null,
      adapter: p?.adapter ?? false,
      step: working ? 'working' : state.declined ? 'declined' : state.failed ? 'failed' : 'idle'
    }
  }
  async function report(): Promise<void> {
    deps.events.emit('controller-wake:status', await status())
  }
  async function elevated(script: string): Promise<number | null> {
    working = true
    await report()
    try {
      return await deps.runElevatedScript(script)
    } finally {
      working = false
    }
  }

  /** `asked`: the user just turned the setting on (every device is tried, even after a declined prompt). */
  const apply = (asked: boolean): Promise<void> =>
    run(async () => {
      if (!deps.enabled()) return
      const state = asked ? { ...NO_STATE } : await readState()
      if (state.declined) return
      const p = await deps.probe()
      if (!p) {
        log.warn('controller wake: the wake device lists could not be read')
        if (asked) await writeState(state)
        await report()
        return
      }
      const off = xboxDevices(p.programmable).filter((name) => !p.armed.includes(name))
      const targets = off.filter((name) => !state.tried.includes(name))
      if (targets.length === 0) {
        if (asked) await writeState(state)
        const armed = xboxDevices(p.armed)
        log.info(
          armed.length
            ? `controller wake: on for ${armed.join(', ')}`
            : off.length
              ? `controller wake: Windows did not allow ${off.join(', ')} earlier; tried again when the setting is turned on`
              : `controller wake: no Xbox device can wake this PC${p.adapter ? '' : ' (no Xbox Wireless Adapter plugged in)'}`
        )
        await report()
        return
      }
      await fs.mkdir(dir, { recursive: true })
      const code = await elevated(applyScript(ledgerFile, await readLedger(), targets))
      if (code === 1223) {
        await writeState({ ...state, declined: true })
        log.info(
          'controller wake: administrator approval declined; asked again when the setting is turned on'
        )
        await report()
        return
      }
      // What Windows did, read back (an exit code alone does not say a device is allowed).
      const after = await deps.probe()
      const notAllowed = after ? targets.filter((name) => !after.armed.includes(name)) : targets
      const tried = [...new Set([...state.tried, ...targets])]
      const failed = code !== 0 || notAllowed.length > 0
      await writeState({ declined: false, failed, tried })
      if (failed)
        log.warn(
          `controller wake: Windows did not allow ${notAllowed.join(', ') || 'every device'} (exit ${code ?? 'none'}); tried again when the setting is turned on`
        )
      else log.info(`controller wake: on for ${targets.join(', ')}`)
      await report()
    })

  /** `asked`: the user just turned the setting off (asked even after a declined prompt). */
  const revert = (asked: boolean): Promise<void> =>
    run(async () => {
      if (deps.enabled()) return
      const devices = await readLedger()
      const state = asked ? { ...NO_STATE } : await readState()
      if (devices.length === 0) {
        if (asked || state.declined || state.failed || state.tried.length) {
          await writeState({ ...NO_STATE })
          await report()
        }
        return
      }
      // A declined or failed undo is not asked again at every start, only when the setting is switched again.
      if (state.declined || state.failed) return
      const p = await deps.probe()
      // A device that is not plugged in stays allowed (its own setting); it stays in the ledger and is turned off once
      // it is back. With the lists unknown, the step decides from its own reading.
      const toTurnOff = p ? devices.filter((name) => p.armed.includes(name)) : devices
      const present = (name: string): boolean =>
        !!p && (p.programmable.includes(name) || p.armed.includes(name))
      if (toTurnOff.length === 0) {
        await writeLedger(devices.filter((name) => !present(name)))
        await writeState({ ...NO_STATE })
        await report()
        return
      }
      const code = await elevated(revertScript(toTurnOff))
      if (code === 1223) {
        await writeState({ ...state, declined: true })
        log.info(
          'controller wake: turning wake off was declined; asked again when the setting is turned off'
        )
        await report()
        return
      }
      const after = await deps.probe()
      // Kept: devices still allowed (tried again at the next start) and devices not plugged in.
      const kept = after
        ? devices.filter(
            (name) =>
              after.armed.includes(name) ||
              !(after.programmable.includes(name) || after.armed.includes(name))
          )
        : devices
      const stillOn = after ? kept.filter((name) => after.armed.includes(name)) : toTurnOff
      await writeLedger(kept)
      const failed = code !== 0 || stillOn.length > 0
      await writeState({ ...NO_STATE, failed })
      if (failed)
        log.warn(
          `controller wake: wake could not be turned off for ${stillOn.join(', ') || 'every device'} (exit ${code ?? 'none'}); tried again when the setting is switched on and off`
        )
      else log.info(`controller wake: off for ${toTurnOff.join(', ')}`)
      await report()
    })

  function sync(initial: boolean): void {
    const on = deps.enabled()
    const changed = lastEnabled !== null && lastEnabled !== on
    lastEnabled = on
    if (!initial && !changed) return
    const fail = (err: unknown): void => log.warn(`controller wake: ${String(err)}`)
    if (on) void apply(changed).catch(fail)
    else void revert(changed).catch(fail)
  }

  return {
    start() {
      sync(true)
    },
    sync() {
      sync(false)
    },
    status
  }
}
