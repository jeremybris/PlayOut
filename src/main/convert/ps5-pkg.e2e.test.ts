import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConvertStatus } from '../../shared/convert'
import { createConvertService } from './convert-service'

/**
 * The real thing: Settings › Convert › PlayStation 5 › PKG → Game Folder through the built PS5 package helper
 * (resources\ps5pkg\PlayOutPs5Pkg.exe, `node scripts/build-ps5pkg-helper.mjs`) on a fake package. Skipped unless
 * PLAYOUT_PS5_PKG names a fake (FPKG) PS5 package; PLAYOUT_PS5_EXPECT may name a file the result must hold
 * (relative, e.g. `eboot.bin`).
 */
const PKG = process.env.PLAYOUT_PS5_PKG
const HELPER = resolve(__dirname, '..', '..', '..', 'resources', 'ps5pkg', 'PlayOutPs5Pkg.exe')
const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-ps5-e2e-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe.skipIf(!PKG)('PS5 package to game folder with the real helper', () => {
  it(
    'unpacks a fake package next to it and keeps the package',
    { timeout: 10 * 60_000 },
    async () => {
      const pkg = join(dir, 'Test Game.pkg')
      await fs.copyFile(PKG!, pkg)
      const statuses: ConvertStatus[] = []
      const trash = vi.fn(async () => {})
      const service = createConvertService({
        toolRoot: join(dir, 'tool'),
        workDir: join(dir, 'work'),
        emulationDir: () => join(dir, 'Emulation'),
        emulatorPath: async () => null,
        library: { games: () => [], rekeyRom: () => null },
        romExtensions: () => ['.pkg'],
        imageCache: { moveGame: async () => (url: string) => url },
        trash,
        rescanRoms: async () => {},
        emit: (s) => statuses.push(s),
        log,
        ensure: async () => {
          throw new Error('no converter for a built-in direction')
        },
        ps5Helper: HELPER
      })
      await service.start({
        platformId: 'ps5',
        pairId: 'ps5-pkg-folder',
        reversed: false,
        paths: [pkg]
      })
      await vi.waitFor(() => expect(statuses.at(-1)?.running).toBe(false), { timeout: 10 * 60_000 })
      const item = statuses.at(-1)!.items[0]!
      expect(item.state, item.detail).toBe('done')
      const out = join(dir, 'Test Game')
      expect(item.output).toBe(out)
      expect(await fs.readFile(join(out, 'sce_sys', 'param.json'), 'utf8')).toContain('contentId')
      if (process.env.PLAYOUT_PS5_EXPECT) await fs.access(join(out, process.env.PLAYOUT_PS5_EXPECT))
      await fs.access(pkg)
      expect(trash).not.toHaveBeenCalled()
      expect((await fs.readdir(dir)).filter((n) => n.includes('.extracting.'))).toEqual([])
    }
  )
})
