import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { convertPair, type ConvertStatus } from '../../shared/convert'
import { createConvertService, type ConvertServiceDeps } from './convert-service'
import { buildFakePkg } from './test-helpers'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-convert-ps4-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const GAME = [
  { path: 'eboot.bin', data: Buffer.from('the game') },
  { path: 'Media/big.dat', data: Buffer.alloc(0x24000, 9) }
]
const REQUEST = { platformId: 'ps4', pairId: 'ps4-pkg-folder', reversed: false }

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- a test fixture
function setup(unpackPs4?: ConvertServiceDeps['unpackPs4']) {
  const statuses: ConvertStatus[] = []
  const ensure = vi.fn(async () => ({ version: '2.1.0', exe: 'gfc.exe' }))
  const run = vi.fn(async () => 0)
  const trash = vi.fn(async () => {})
  const rescans = vi.fn(async () => {})
  const service = createConvertService({
    toolRoot: join(dir, 'tool'),
    workDir: join(dir, 'work'),
    emulationDir: () => join(dir, 'Emulation'),
    emulatorPath: async () => null,
    library: { games: () => [], rekeyRom: () => null },
    romExtensions: () => ['.bin'],
    imageCache: { moveGame: async () => (url: string) => url },
    trash,
    rescanRoms: rescans,
    emit: (s) => statuses.push(s),
    log,
    run,
    ensure,
    ...(unpackPs4 ? { unpackPs4 } : {})
  })
  const finished = async (): Promise<ConvertStatus> => {
    await vi.waitFor(() => expect(statuses.at(-1)?.running).toBe(false))
    return statuses.at(-1)!
  }
  return { service, statuses, ensure, run, trash, rescans, finished }
}

describe('PS4 package to game folder', () => {
  it('is offered for PlayStation 4, one way, without a converter', () => {
    const pair = convertPair('ps4', 'ps4-pkg-folder')!
    expect(pair.left.exts).toEqual(['.pkg'])
    expect(pair.right.folder).toBe(true)
    expect(pair.backward).toBeUndefined()
    expect(pair.forward.builtIn).toBe('ps4pkg')
  })

  it('unpacks next to the package with PlayOut itself, keeps the package and rescans', async () => {
    const pkg = join(dir, 'Game - [US] [1.00].pkg')
    await fs.writeFile(pkg, buildFakePkg({ files: GAME, entries: { 0x1000: Buffer.from('sfo') } }))
    const t = setup()
    await t.service.start({ ...REQUEST, paths: [pkg] })
    const done = await t.finished()
    const out = join(dir, 'Game - [US] [1.00]')
    expect(done.items).toEqual([
      {
        path: pkg,
        state: 'done',
        detail: '→ Game - [US] [1.00] (3 files) (the package is kept)',
        output: out
      }
    ])
    expect(await fs.readFile(join(out, 'eboot.bin'), 'utf8')).toBe('the game')
    expect(await fs.readFile(join(out, 'sce_sys', 'param.sfo'), 'utf8')).toBe('sfo')
    expect(t.ensure).not.toHaveBeenCalled()
    expect(t.run).not.toHaveBeenCalled()
    expect(t.trash).not.toHaveBeenCalled()
    expect(t.rescans).toHaveBeenCalledOnce()
    expect(done.tool).toBeNull()
    expect(done.error).toBeUndefined()
  })

  it('leaves a folder of that name alone', async () => {
    const pkg = join(dir, 'Game.pkg')
    await fs.writeFile(pkg, buildFakePkg({ files: GAME }))
    await fs.mkdir(join(dir, 'Game'))
    await fs.writeFile(join(dir, 'Game', 'mine.txt'), 'keep')
    const t = setup()
    await t.service.start({ ...REQUEST, paths: [pkg] })
    const done = await t.finished()
    expect(done.items[0]).toMatchObject({
      state: 'skipped',
      detail: 'already unpacked: Game is there'
    })
    expect(await fs.readdir(join(dir, 'Game'))).toEqual(['mine.txt'])
  })

  it('says why a package cannot be unpacked and goes on with the next', async () => {
    const retail = join(dir, 'Retail.pkg')
    await fs.writeFile(retail, buildFakePkg({ files: GAME, retail: true }))
    const next = join(dir, 'Next.pkg')
    await fs.writeFile(next, buildFakePkg({ files: GAME }))
    const t = setup()
    await t.service.start({ ...REQUEST, paths: [retail, next] })
    const done = await t.finished()
    expect(done.items[0]).toMatchObject({ state: 'failed' })
    expect(done.items[0]!.detail).toMatch(/retail package/)
    expect(done.items[1]).toMatchObject({ state: 'done' })
    await expect(fs.access(join(dir, 'Retail'))).rejects.toThrow()
  })

  it('shows progress, says a stop or failure, and never removes a folder it did not make', async () => {
    const pkg = join(dir, 'Game.pkg')
    await fs.writeFile(pkg, 'stand-in')
    const t = setup(async (_pkg, _outDir, { signal, onProgress }) => {
      onProgress?.({ done: 50, total: 100 })
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve()))
      throw Object.assign(new Error('stopped'), { name: 'AbortError' })
    })
    await t.service.start({ ...REQUEST, paths: [pkg] })
    await vi.waitFor(() => expect(t.statuses.at(-1)?.items[0]?.progress).toBe(0.5))
    t.service.stop()
    const done = await t.finished()
    expect(done.items[0]).toMatchObject({ state: 'stopped' })
    expect(done.items[0]).not.toHaveProperty('progress')

    // A folder of that name made by someone else while unpacking: the unpack fails, the folder stays.
    const failing = setup(async (_pkg, outDir) => {
      await fs.mkdir(outDir)
      await fs.writeFile(join(outDir, 'theirs.txt'), 'theirs')
      throw new Error('disk full')
    })
    await failing.service.start({ ...REQUEST, paths: [pkg] })
    const failed = await failing.finished()
    expect(failed.items[0]).toMatchObject({
      state: 'failed',
      detail: 'could not be unpacked: disk full'
    })
    expect(await fs.readFile(join(dir, 'Game', 'theirs.txt'), 'utf8')).toBe('theirs')
  })
})
