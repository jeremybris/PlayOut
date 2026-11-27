import type { RecompProgress } from '@shared/recomp'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The store subscribes to main's events at import time.
vi.mock('../api/client', () => ({ api: { on: vi.fn(() => () => undefined) } }))

const { clearRecompProgress, useRecompStore, whenRecompFinished } = await import('./recomp')

const ID = 'github:a/b'

function report(patch: Partial<RecompProgress> = {}): RecompProgress {
  return {
    id: ID,
    phase: 'queued',
    progress: null,
    bytes: null,
    total: null,
    message: null,
    warning: null,
    ...patch
  }
}

function emit(p: RecompProgress): void {
  useRecompStore.setState((s) => ({ progress: { ...s.progress, [p.id]: p } }))
}

describe('recomp store', () => {
  beforeEach(() => useRecompStore.setState({ progress: {}, version: 0 }))

  it('forgets a report on uninstall, so its warning or error is not shown on the uninstalled version', () => {
    emit(report({ phase: 'done', warning: 'not verified' }))
    emit(report({ id: 'other', phase: 'failed' }))
    clearRecompProgress(ID)
    expect(useRecompStore.getState().progress).toEqual({ other: expect.anything() })
    // Nothing to clear: the state is left alone.
    const before = useRecompStore.getState()
    clearRecompProgress('missing')
    expect(useRecompStore.getState()).toBe(before)
  })

  it('waits for the install started after the old report to finish', async () => {
    const old = report({ phase: 'done' })
    emit(old)
    let result: RecompProgress | null = null
    const wait = whenRecompFinished(ID, old).then((p) => (result = p))
    await Promise.resolve()
    // The old 'done' report is not taken for this install; the queued and downloading ones are not the end.
    expect(result).toBeNull()
    emit(report({ phase: 'queued' }))
    emit(report({ phase: 'downloading', progress: 0.5 }))
    await Promise.resolve()
    expect(result).toBeNull()
    const done = report({ phase: 'done' })
    emit(done)
    await wait
    expect(result).toBe(done)
  })

  it('rejects with main’s message when the install fails', async () => {
    const wait = whenRecompFinished(ID, undefined)
    emit(report({ phase: 'checking' }))
    emit(report({ phase: 'failed', message: 'Checksum mismatch' }))
    await expect(wait).rejects.toThrow('Checksum mismatch')
  })

  it('settles at once when the install already finished before it was asked', async () => {
    const done = report({ phase: 'done' })
    emit(done)
    await expect(whenRecompFinished(ID, undefined)).resolves.toBe(done)
  })
})
