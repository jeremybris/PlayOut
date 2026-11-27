import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A fake handler pack holding one handler that needs a file next to the exe (ExecutableContext).
const handler = {
  archive: 'handler-ctx-v1.nc',
  gameName: 'Context Game',
  exeName: 'ctxgame.exe',
  exeNames: [],
  exeContext: ['steam_api64.dll'],
  supportsKeyboard: false,
  supportsMultipleKeyboardsAndMice: false,
  risks: []
}
vi.mock('./handler-pack', () => ({
  createHandlerPack: () => ({
    downloadAll: async () => ({ downloaded: 0, total: 1, failed: 0 }),
    index: async () => [handler],
    builtAt: async () => new Date().toISOString(),
    busy: () => false,
    extract: vi.fn()
  }),
  extractedPaths: () => ({ script: '', folder: '', stamp: '' })
}))

const { createCoopService } = await import('./coop-service')

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'playout-coop-context-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('Co-Op matching: ExecutableContext', () => {
  it('checks again a context that was missing, so the game is matched once the files are there', async () => {
    const game = {
      id: 'g1',
      source: 'manual',
      title: 'Something Else',
      exePath: join(dir, 'ctxgame.exe'),
      user: {},
      metadata: {} as { coop?: unknown }
    }
    const applyMetadata = vi.fn((_id: string, patch: { metadata: { coop: unknown } }) => {
      game.metadata.coop = patch.metadata.coop
    })
    const service = createCoopService({
      library: {
        games: () => [game],
        getGame: () => game,
        applyMetadata,
        clearMetadataField: vi.fn()
      } as never,
      settings: { get: () => ({}) } as never,
      events: { emit: vi.fn(), on: vi.fn() } as never,
      launcher: {} as never,
      userData: join(dir, 'data'),
      helperDir: join(dir, 'helper'),
      log: log as never
    })

    // downloadHandlers runs the same matching as a library change (kick) and can be awaited.
    await service.downloadHandlers()
    expect(applyMetadata).not.toHaveBeenCalled()

    writeFileSync(join(dir, 'steam_api64.dll'), '')
    await service.downloadHandlers()
    expect(applyMetadata).toHaveBeenCalledTimes(1)
    expect(game.metadata.coop).toMatchObject({ archive: handler.archive, matchedBy: 'exe' })
    service.dispose()
  })
})
