import type { NativeOps, PauseResult } from '../native-host/native-ops'
import { resumeSettled } from './overlay-logic'

/**
 * One suspend per process, however many parts of PlayOut want it paused. The overlay pauses the game it opens over
 * and Enhanced Sleep/Wake freezes the game when the screen locks: both can hit the same process at once (lock the
 * screen with the overlay open, or open the overlay right after waking). Windows counts suspends, so two of them
 * needed both resumes to arrive. Here the first owner suspends the process, a second one only joins, and the process
 * runs again when the last owner resumes it, in whichever order they do.
 */

export type PauseProcess = NativeOps['pauseProcess']

export interface PauseOwners {
  /** `pauseProcess` for one owner ('overlay', 'sleep'); used exactly like the native call. */
  owner(name: string): PauseProcess
}

interface Held {
  /** The process's start time, as the suspend reported it. */
  created: number
  owners: Set<string>
}

export function createPauseOwners(pauseProcess: PauseProcess): PauseOwners {
  /** The processes PlayOut holds suspended, by PID. */
  const held = new Map<number, Held>()
  // One call at a time: two owners pausing the same process together must not both suspend it.
  let chain: Promise<unknown> = Promise.resolve()
  const serialize = <T>(op: () => Promise<T>): Promise<T> => {
    const next = chain.then(op)
    chain = next.catch(() => undefined)
    return next
  }

  async function pause(name: string, pid: number): Promise<PauseResult> {
    const entry = held.get(pid)
    if (entry) {
      // Already suspended for another owner: not a second time.
      entry.owners.add(name)
      return { ok: true, created: entry.created }
    }
    const result = await pauseProcess(pid, true)
    // Without a start time the owner cannot tell this process from a later one: left to the owner, as before.
    if (result.ok && result.created)
      held.set(pid, { created: result.created, owners: new Set([name]) })
    return result
  }

  async function resume(name: string, pid: number, created?: number): Promise<PauseResult> {
    const entry = held.get(pid)
    // Not held for this owner (a record of the last run, or a pause the native host never answered): its own resume.
    if (!entry || !entry.owners.has(name)) return pauseProcess(pid, false, created)
    if (entry.owners.size > 1) {
      // Another owner still wants it paused: it runs again with that owner's resume.
      entry.owners.delete(name)
      return { ok: true, created: entry.created }
    }
    const result = await pauseProcess(pid, false, entry.created)
    // Unanswered: still held, so the owner's retry resumes it.
    if (resumeSettled(result)) held.delete(pid)
    return result
  }

  return {
    owner: (name) => (pid, pauseIt, created) =>
      serialize(() => (pauseIt ? pause(name, pid) : resume(name, pid, created)))
  }
}
