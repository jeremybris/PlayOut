import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: class {},
  dialog: {},
  shell: {}
}))

import type { Game } from '../../shared/types'
import { createHandlers, type AppServices } from './handlers'

const HOST_GAME = { id: 'remote:host-1:steam:620', title: 'Portal 2' } as Game

function services(): {
  library: Record<string, ReturnType<typeof vi.fn>>
  streaming: { remoteGameBase: ReturnType<typeof vi.fn> }
  handlers: ReturnType<typeof createHandlers>
} {
  const library = {
    metadataLayers: vi.fn(() => ({ key: 'local' })),
    setMetadataEdit: vi.fn(() => ({ id: 'steam:620' })),
    clearMetadataEdit: vi.fn(() => ({ id: 'steam:620' })),
    remoteMetadataLayers: vi.fn(() => ({ key: 'remote' })),
    setRemoteMetadataEdit: vi.fn(() => ({ id: HOST_GAME.id })),
    clearRemoteMetadataEdit: vi.fn(() => ({ id: HOST_GAME.id }))
  }
  const streaming = {
    remoteGameBase: vi.fn(async (id: string) => (id === HOST_GAME.id ? HOST_GAME : undefined))
  }
  return {
    library,
    streaming,
    handlers: createHandlers({
      library,
      streaming,
      log: { error: vi.fn(), warn: vi.fn() },
      window: { get: () => null }
    } as unknown as AppServices)
  }
}

describe('metadata edit handlers', () => {
  it("send a paired host's game to the remote edits, with the host's copy of it", async () => {
    const { library, streaming, handlers } = services()
    expect(await handlers.getMetadataLayers(HOST_GAME.id)).toEqual({ key: 'remote' })
    await handlers.setMetadataEdit(HOST_GAME.id, { description: 'Mine' }, ['genres'])
    await handlers.clearMetadataEdit(HOST_GAME.id, ['description'])
    await handlers.clearMetadataEdit(HOST_GAME.id)
    expect(streaming.remoteGameBase).toHaveBeenCalledWith(HOST_GAME.id)
    expect(library.remoteMetadataLayers).toHaveBeenCalledWith(HOST_GAME)
    expect(library.setRemoteMetadataEdit).toHaveBeenCalledWith(HOST_GAME, { description: 'Mine' }, [
      'genres'
    ])
    expect(library.clearRemoteMetadataEdit.mock.calls).toEqual([
      [HOST_GAME, ['description']],
      [HOST_GAME, undefined]
    ])
    expect(library.metadataLayers).not.toHaveBeenCalled()
    expect(library.setMetadataEdit).not.toHaveBeenCalled()
  })

  it("keep this PC's games on the library and refuse an unknown host game", async () => {
    const { library, streaming, handlers } = services()
    expect(await handlers.getMetadataLayers('steam:620')).toEqual({ key: 'local' })
    await handlers.setMetadataEdit('steam:620', { genres: ['A'] })
    await handlers.clearMetadataEdit('steam:620', ['genres'])
    expect(library.setMetadataEdit).toHaveBeenCalledWith('steam:620', { genres: ['A'] }, undefined)
    expect(library.clearMetadataEdit).toHaveBeenCalledWith('steam:620', ['genres'])
    expect(streaming.remoteGameBase).not.toHaveBeenCalled()
    await expect(handlers.getMetadataLayers('remote:host-1:nope')).rejects.toThrow(/Unknown game/)
    await expect(
      handlers.setMetadataEdit('remote:host-1:nope', { description: 'x' })
    ).rejects.toThrow(/Unknown game/)
    expect(library.setRemoteMetadataEdit).not.toHaveBeenCalled()
  })
})
