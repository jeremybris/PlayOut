import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { convertPair, type ConvertStatus } from '../../shared/convert'
import { createConvertService } from './convert-service'
import type { HelperRun } from './xbox-helper'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-convert-ps5-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const REQUEST = { platformId: 'ps5', pairId: 'ps5-pkg-folder', reversed: false }
const json = (o: unknown): string => JSON.stringify(o)

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- a test fixture
async function setup(runHelper: HelperRun, withHelper = true) {
  const helper = join(dir, 'ps5pkg', 'PlayOutPs5Pkg.exe')
  if (withHelper) {
    await fs.mkdir(join(dir, 'ps5pkg'), { recursive: true })
    await fs.writeFile(helper, 'exe')
  }
  const statuses: ConvertStatus[] = []
  const ensure = vi.fn(async () => ({ version: '2.1.0', exe: 'gfc.exe' }))
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
    ensure,
    ps5Helper: helper,
    runHelper
  })
  const finished = async (): Promise<ConvertStatus> => {
    await vi.waitFor(() => expect(statuses.at(-1)?.running).toBe(false))
    return statuses.at(-1)!
  }
  return { service, statuses, ensure, trash, finished, helper }
}

describe('PS5 package to game folder', () => {
  it('is offered for PlayStation 5, one way, run by the PS5 package helper', () => {
    const pair = convertPair('ps5', 'ps5-pkg-folder')!
    expect(pair.left.exts).toEqual(['.pkg'])
    expect(pair.right.folder).toBe(true)
    expect(pair.backward).toBeUndefined()
    expect(pair.forward.builtIn).toBe('ps5pkg')
  })

  it('unpacks next to the package with the helper, keeps the package and needs no converter', async () => {
    const pkg = join(dir, 'PPSA01234-app.pkg')
    await fs.writeFile(pkg, 'pkg')
    const out = join(dir, 'PPSA01234-app')
    const calls: string[][] = []
    const t = await setup(async (_exe, args, onLine) => {
      calls.push(args)
      onLine(json({ type: 'progress', phase: 'reading', done: 0, total: 0, percent: 0 }))
      onLine(json({ type: 'progress', done: 5, total: 10, percent: 50, path: 'eboot.bin' }))
      await fs.mkdir(join(out, 'sce_sys'), { recursive: true })
      onLine(json({ type: 'done', dest: out, files: 12, bytes: 10 }))
      return 0
    })
    await t.service.start({ ...REQUEST, paths: [pkg] })
    const done = await t.finished()
    expect(calls).toEqual([['extract', pkg, out]])
    expect(done.items).toEqual([
      {
        path: pkg,
        state: 'done',
        detail: '→ PPSA01234-app (12 files) (the package is kept)',
        output: out
      }
    ])
    expect(t.ensure).not.toHaveBeenCalled()
    expect(t.trash).not.toHaveBeenCalled()
    expect(t.statuses.some((s) => s.items[0]?.progress === 0.5)).toBe(true)
  })

  it('shows the helper’s reason for a retail package', async () => {
    const pkg = join(dir, 'Retail.pkg')
    await fs.writeFile(pkg, 'pkg')
    const t = await setup(async (_exe, _args, onLine) => {
      onLine(
        json({
          type: 'error',
          code: 'retail',
          message:
            'This is a retail package: it is locked with Sony’s keys, so it cannot be unpacked.'
        })
      )
      return 1
    })
    await t.service.start({ ...REQUEST, paths: [pkg] })
    const done = await t.finished()
    expect(done.items[0]).toMatchObject({
      state: 'failed',
      detail: 'This is a retail package: it is locked with Sony’s keys, so it cannot be unpacked.'
    })
  })

  it('skips a package whose folder is already there', async () => {
    const pkg = join(dir, 'Game.pkg')
    await fs.writeFile(pkg, 'pkg')
    await fs.mkdir(join(dir, 'Game'))
    const run = vi.fn(async () => 0)
    const t = await setup(run)
    await t.service.start({ ...REQUEST, paths: [pkg] })
    const done = await t.finished()
    expect(done.items[0]).toMatchObject({
      state: 'skipped',
      detail: 'already unpacked: Game is there'
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('a stop kills the helper and removes the staging folder it left, never an older one', async () => {
    const pkg = join(dir, 'Game.pkg')
    await fs.writeFile(pkg, 'pkg')
    await fs.mkdir(join(dir, 'Game.extracting.old'))
    const t = await setup(
      (_exe, _args, onLine, signal) =>
        new Promise((resolve) => {
          void fs.mkdir(join(dir, 'Game.extracting.abc123')).then(() => {
            onLine(json({ type: 'progress', done: 1, total: 10, percent: 10, path: 'x' }))
          })
          signal.addEventListener('abort', () => resolve(1), { once: true })
        })
    )
    await t.service.start({ ...REQUEST, paths: [pkg] })
    await vi.waitFor(async () => {
      await fs.access(join(dir, 'Game.extracting.abc123'))
    })
    await t.service.stop()
    const done = await t.finished()
    expect(done.items[0]?.state).toBe('stopped')
    const left = await fs.readdir(dir)
    expect(left).toContain('Game.extracting.old')
    expect(left).not.toContain('Game.extracting.abc123')
    expect(left).not.toContain('Game')
  })

  it('keeps a result the helper finished just before a stop', async () => {
    const pkg = join(dir, 'Game.pkg')
    await fs.writeFile(pkg, 'pkg')
    const out = join(dir, 'Game')
    let service: Awaited<ReturnType<typeof setup>>['service'] | null = null
    const t = await setup(async (_exe, _args, onLine) => {
      await fs.mkdir(out)
      onLine(json({ type: 'done', dest: out, files: 3, bytes: 3 }))
      void service!.stop()
      return 0
    })
    service = t.service
    await t.service.start({ ...REQUEST, paths: [pkg] })
    const done = await t.finished()
    expect(done.items[0]).toMatchObject({ state: 'done', output: out })
  })

  it('says the helper is missing', async () => {
    const pkg = join(dir, 'Game.pkg')
    await fs.writeFile(pkg, 'pkg')
    const t = await setup(async () => 0, false)
    await t.service.start({ ...REQUEST, paths: [pkg] })
    const done = await t.finished()
    expect(done.items[0]?.detail).toMatch(/PS5 package helper is missing/)
  })
})
