// A small pool of PowerShell workers for long scripts (the Upgrade menu's game folder measures): each script gets a
// worker of its own, so a measure of a huge game (minutes) never makes another game's measure wait behind it. At most
// `size` run at once (each is a powershell.exe); more wait for the first free worker. A worker left idle for `idleMs`
// is ended (the next script starts a new one). Timeouts work as in ps-worker (the worker running the script is
// restarted), and dispose ends every worker and refuses the scripts still waiting.
import { PsError, type PsRunOptions, type PsRunner, type PsWorker } from './ps-worker'

export interface PsPoolOptions {
  /** How many scripts may run at once (each in its own powershell.exe). */
  size: number
  /** Makes a worker (createPsWorker in the app; a fake in tests). */
  create: () => PsWorker
  /** An idle worker is ended after this long (default one minute). */
  idleMs?: number
}

export interface PsPool extends PsRunner {
  /** Ends every worker; scripts still waiting reject with code 'disposed'. */
  dispose(): void
}

interface Slot {
  worker: PsWorker
  busy: boolean
  idleTimer?: NodeJS.Timeout
}

const DEFAULT_IDLE_MS = 60_000

export function createPsPool(options: PsPoolOptions): PsPool {
  const size = Math.max(1, options.size)
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS
  const slots: Slot[] = []
  const waiting: Array<{ start: (slot: Slot) => void; fail: (err: PsError) => void }> = []
  let disposed = false

  const endSlot = (slot: Slot): void => {
    clearTimeout(slot.idleTimer)
    const i = slots.indexOf(slot)
    if (i >= 0) slots.splice(i, 1)
    slot.worker.dispose()
  }

  /** A free worker now: an idle one, else a new one while fewer than `size` exist; null when all are busy. */
  const freeSlot = (): Slot | null => {
    const idle = slots.find((s) => !s.busy)
    if (idle) return idle
    if (slots.length >= size) return null
    const slot: Slot = { worker: options.create(), busy: false }
    slots.push(slot)
    return slot
  }

  /** The script ended on `slot`: the next waiting script takes it, else it waits idle for a while. */
  const release = (slot: Slot): void => {
    slot.busy = false
    if (disposed) return
    const next = waiting.shift()
    if (next) {
      next.start(slot)
      return
    }
    slot.idleTimer = setTimeout(() => {
      if (!slot.busy) endSlot(slot)
    }, idleMs)
    slot.idleTimer.unref?.()
  }

  const runOn = <T>(slot: Slot, script: string, runOptions?: PsRunOptions): Promise<T | null> => {
    clearTimeout(slot.idleTimer)
    slot.busy = true
    const run = slot.worker.run<T>(script, runOptions)
    run.then(
      () => release(slot),
      () => release(slot)
    )
    return run
  }

  return {
    run<T>(script: string, runOptions?: PsRunOptions): Promise<T | null> {
      if (disposed) return Promise.reject(new PsError('disposed', 'PowerShell pool disposed'))
      const slot = freeSlot()
      if (slot) return runOn<T>(slot, script, runOptions)
      return new Promise<T | null>((resolve, reject) => {
        waiting.push({
          start: (s) => runOn<T>(s, script, runOptions).then(resolve, reject),
          fail: reject
        })
      })
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const w of waiting.splice(0)) w.fail(new PsError('disposed', 'PowerShell pool disposed'))
      for (const slot of [...slots]) endSlot(slot)
    }
  }
}
