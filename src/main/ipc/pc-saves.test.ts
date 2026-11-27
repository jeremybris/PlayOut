import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: class {},
  dialog: {},
  shell: {}
}))

import { createHandlers, type AppServices } from './handlers'

function services(moving = false): {
  pcSaves: Record<string, ReturnType<typeof vi.fn>>
  handlers: ReturnType<typeof createHandlers>
} {
  const pcSaves = {
    view: vi.fn(async () => null),
    inspect: vi.fn(async () => ({})),
    setFolder: vi.fn(async () => ({})),
    syncNow: vi.fn(async () => ({})),
    resolve: vi.fn(async () => ({})),
    answerCopy: vi.fn(async () => ({}))
  }
  return {
    pcSaves,
    handlers: createHandlers({
      pcSaves,
      emulationMove: { moving: () => moving },
      log: { error: vi.fn(), warn: vi.fn() },
      window: { get: () => null }
    } as unknown as AppServices)
  }
}

describe('PC Saves handlers', () => {
  it('pass the game id, the folder and the answers on', async () => {
    const { pcSaves, handlers } = services()
    await handlers.getPcSaves('manual:a')
    await handlers.inspectPcSaveFolder('manual:a', 'C:\\Saves')
    await handlers.setPcSaveFolder('manual:a', 'C:\\Saves')
    await handlers.setPcSaveFolder('manual:a', null)
    await handlers.syncPcSaves('manual:a')
    await handlers.resolvePcSaveConflict('manual:a', 'cloud')
    await handlers.answerPcSaveCopy('manual:a', false)
    expect(pcSaves.view.mock.calls).toEqual([['manual:a']])
    expect(pcSaves.inspect.mock.calls).toEqual([['manual:a', 'C:\\Saves']])
    expect(pcSaves.setFolder.mock.calls).toEqual([
      ['manual:a', 'C:\\Saves'],
      ['manual:a', null]
    ])
    expect(pcSaves.syncNow.mock.calls).toEqual([['manual:a']])
    expect(pcSaves.resolve.mock.calls).toEqual([['manual:a', 'cloud']])
    expect(pcSaves.answerCopy.mock.calls).toEqual([['manual:a', false]])
  })

  it('refuses bad ids, paths and answers', async () => {
    const { pcSaves, handlers } = services()
    for (const bad of ['', 'x'.repeat(501), 42, null]) {
      await expect(handlers.getPcSaves(bad as never)).rejects.toThrow()
      await expect(handlers.syncPcSaves(bad as never)).rejects.toThrow()
    }
    for (const bad of ['', 'x'.repeat(4097), 7, undefined]) {
      await expect(handlers.setPcSaveFolder('manual:a', bad as never)).rejects.toThrow()
      await expect(handlers.inspectPcSaveFolder('manual:a', bad as never)).rejects.toThrow()
    }
    await expect(handlers.resolvePcSaveConflict('manual:a', 'both' as never)).rejects.toThrow()
    await expect(handlers.answerPcSaveCopy('manual:a', 'yes' as never)).rejects.toThrow()
    for (const fn of Object.values(pcSaves)) expect(fn).not.toHaveBeenCalled()
  })

  it('copies nothing while the Emulation folder moves', async () => {
    const { pcSaves, handlers } = services(true)
    await expect(handlers.syncPcSaves('manual:a')).rejects.toThrow()
    await expect(handlers.resolvePcSaveConflict('manual:a', 'local')).rejects.toThrow()
    await expect(handlers.answerPcSaveCopy('manual:a', true)).rejects.toThrow()
    expect(pcSaves.syncNow).not.toHaveBeenCalled()
    // Choosing a folder mid-move is refused (it would be checked against the folder being left); Clear is not.
    await expect(handlers.setPcSaveFolder('manual:a', 'C:\\Saves')).rejects.toThrow()
    await handlers.setPcSaveFolder('manual:a', null)
    expect(pcSaves.setFolder.mock.calls).toEqual([['manual:a', null]])
  })
})
