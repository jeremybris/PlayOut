import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { vi } from 'vitest'
import type { PresetContext } from './types'

/**
 * Test helpers for the frontend-style presets (mGBA, Flycast, PPSSPP, RetroArch, MAME, Model 2, ScummVM): a real temp
 * folder and a context whose runner and startHidden must never be called.
 */

export interface PresetFixture {
  dir: string
  /** `previousVersion` defaults to none for a first-time run, else 3 (the current presets already applied). */
  ctx(firstTime: boolean, previousVersion?: number): PresetContext
  cleanup(): Promise<void>
}

export async function presetFixture(name: string): Promise<PresetFixture> {
  const dir = await mkdtemp(join(tmpdir(), `playout-preset-${name}-`))
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  return {
    dir,
    ctx: (firstTime, previous) => ({
      emuDir: join(dir, 'emu'),
      dataDir: join(dir, 'data'),
      log,
      firstTime,
      previousVersion: previous ?? (firstTime ? undefined : 3),
      run: vi.fn(async () => {
        throw new Error('run must not be called')
      }),
      startHidden: vi.fn(() => {
        throw new Error('startHidden must not be called')
      })
    }),
    cleanup: () => rm(dir, { recursive: true, force: true })
  }
}
