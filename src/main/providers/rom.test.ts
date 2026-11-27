import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '../../shared/types'
import type { EmulationService } from '../emulation/types'
import type { ScanContext } from './types'
import { createRomProvider } from './rom'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-rom-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function setup(): {
  scanRoms: ReturnType<typeof vi.fn>
  provider: ReturnType<typeof createRomProvider>
} {
  const scanRoms = vi.fn(async () => ({ games: [], unknownFolders: ['junk'] }))
  const emulation = { scanRoms, platformsForSystems: () => [] } as unknown as EmulationService
  return { scanRoms, provider: createRomProvider({ emulation, log }) }
}

const ctx = (romsRoot: string | null): ScanContext =>
  ({
    settings: { library: { romsRoot } } as Settings,
    log,
    resourcesDir: '',
    progress: () => {}
  }) as ScanContext

describe('ROM provider', () => {
  it('scans an existing ROM folder', async () => {
    const { scanRoms, provider } = setup()
    await expect(provider.scanInstalled(ctx(dir))).resolves.toEqual([])
    expect(scanRoms).toHaveBeenCalledOnce()
    expect(provider.lastUnknownFolders()).toEqual(['junk'])
  })

  it('reports no games when no ROM folder is set', async () => {
    const { scanRoms, provider } = setup()
    await expect(provider.scanInstalled(ctx(null))).resolves.toEqual([])
    expect(scanRoms).not.toHaveBeenCalled()
  })

  it('fails instead of reporting no games when the ROM folder is missing (drive not connected)', async () => {
    const { scanRoms, provider } = setup()
    await expect(provider.scanInstalled(ctx(join(dir, 'gone')))).rejects.toThrow(
      /ROM folder not found/
    )
    expect(scanRoms).not.toHaveBeenCalled()
  })
})
