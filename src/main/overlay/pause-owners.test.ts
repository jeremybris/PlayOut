import { describe, expect, it, vi } from 'vitest'
import type { PauseResult } from '../native-host/native-ops'
import { createPauseOwners } from './pause-owners'

/** Windows' own bookkeeping: every suspend counts, and the process runs only at count 0. */
function fakeWindows(): {
  count: Map<number, number>
  pauseProcess: ReturnType<
    typeof vi.fn<(pid: number, pause: boolean, created?: number) => Promise<PauseResult>>
  >
} {
  const count = new Map<number, number>()
  const pauseProcess = vi.fn(
    async (pid: number, pause: boolean, created?: number): Promise<PauseResult> => {
      if (created && created !== 99) return { ok: false, error: 'gone' }
      count.set(pid, Math.max(0, (count.get(pid) ?? 0) + (pause ? 1 : -1)))
      return { ok: true, created: 99 }
    }
  )
  return { count, pauseProcess }
}

describe('createPauseOwners', () => {
  it('suspends a process once for two owners and resumes it with the last one, in either order', async () => {
    for (const order of [
      ['overlay', 'sleep'],
      ['sleep', 'overlay']
    ]) {
      const win = fakeWindows()
      const owners = createPauseOwners(win.pauseProcess)
      // The overlay is open over the paused game when the screen locks.
      expect(await owners.owner('overlay')(7, true)).toEqual({ ok: true, created: 99 })
      expect(await owners.owner('sleep')(7, true)).toEqual({ ok: true, created: 99 })
      expect(win.count.get(7)).toBe(1)
      expect(win.pauseProcess).toHaveBeenCalledTimes(1)

      // The first resume leaves it paused for the other owner; the second one lets it run.
      expect(await owners.owner(order[0]!)(7, false, 99)).toMatchObject({ ok: true })
      expect(win.count.get(7)).toBe(1)
      expect(await owners.owner(order[1]!)(7, false, 99)).toMatchObject({ ok: true })
      expect(win.count.get(7)).toBe(0)
      expect(win.pauseProcess.mock.calls).toEqual([
        [7, true],
        [7, false, 99]
      ])

      // Nothing is left behind: the next pause suspends it again.
      await owners.owner('overlay')(7, true)
      expect(win.count.get(7)).toBe(1)
    }
  })

  it('never suspends twice when both owners pause at the same moment', async () => {
    const win = fakeWindows()
    const owners = createPauseOwners(win.pauseProcess)
    await Promise.all([owners.owner('overlay')(7, true), owners.owner('sleep')(7, true)])
    expect(win.count.get(7)).toBe(1)
    await Promise.all([owners.owner('sleep')(7, false, 99), owners.owner('overlay')(7, false, 99)])
    expect(win.count.get(7)).toBe(0)
  })

  it('keeps the process held for an owner whose resume was not answered, so its retry resumes it', async () => {
    const win = fakeWindows()
    const owners = createPauseOwners(win.pauseProcess)
    const overlay = owners.owner('overlay')
    await overlay(7, true)
    win.pauseProcess.mockImplementationOnce(async () => ({ ok: false, error: 'timeout' }))
    expect(await overlay(7, false, 99)).toEqual({ ok: false, error: 'timeout' })
    // Still held: the other owner joins instead of suspending it again.
    await owners.owner('sleep')(7, true)
    expect(win.count.get(7)).toBe(1)
    expect(await overlay(7, false, 99)).toMatchObject({ ok: true })
    expect(win.count.get(7)).toBe(1)
    await owners.owner('sleep')(7, false, 99)
    expect(win.count.get(7)).toBe(0)
  })

  it('passes on a resume of a process it does not hold, and a refused pause', async () => {
    const win = fakeWindows()
    const owners = createPauseOwners(win.pauseProcess)
    // A record of the last run (paused.json, frozen.json).
    await owners.owner('sleep')(7, false, 5)
    expect(win.pauseProcess).toHaveBeenLastCalledWith(7, false, 5)
    win.pauseProcess.mockImplementationOnce(async () => ({ ok: false, error: 'access' }))
    expect(await owners.owner('overlay')(8, true)).toEqual({ ok: false, error: 'access' })
    // Not held after the refusal: the other owner's pause is its own.
    await owners.owner('sleep')(8, true)
    expect(win.count.get(8)).toBe(1)
    await owners.owner('sleep')(8, false, 99)
    expect(win.count.get(8)).toBe(0)
  })

  it('drops a held process that is gone', async () => {
    const win = fakeWindows()
    const owners = createPauseOwners(win.pauseProcess)
    await owners.owner('overlay')(7, true)
    win.pauseProcess.mockImplementationOnce(async () => ({ ok: false, error: 'gone' }))
    expect(await owners.owner('overlay')(7, false, 99)).toEqual({ ok: false, error: 'gone' })
    win.count.set(7, 0)
    await owners.owner('sleep')(7, true)
    expect(win.count.get(7)).toBe(1)
  })
})
