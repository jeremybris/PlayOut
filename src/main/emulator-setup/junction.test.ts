import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile
} from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isJunction, link, mergeFolderInto, moveEntry } from './junction'
import type { JunctionFs, MergeResult } from './junction'

let dir: string
const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'playout-junction-'))
  vi.clearAllMocks()
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const norm = (p: string): string => resolve(p.replace(/^\\\\\?\\/, '')).toLowerCase()

describe('link', () => {
  it('creates the target, the parent folders and a junction', async () => {
    const target = join(dir, 'D', 'saves', 'x')
    const lp = join(dir, 'E', 'deep', 'memcards')
    await link(lp, target, log)
    expect(await isJunction(lp)).toBe(true)
    expect(norm(await readlink(lp))).toBe(norm(target))
    await writeFile(join(lp, 'a.mcd'), 'data')
    expect(await readFile(join(target, 'a.mcd'), 'utf8')).toBe('data')
  })

  it('is idempotent when the junction already points at the target', async () => {
    const target = join(dir, 'T')
    const lp = join(dir, 'L')
    await link(lp, target, log)
    const before = (await lstat(lp)).birthtimeMs
    await link(lp, target.toUpperCase(), log)
    expect((await lstat(lp)).birthtimeMs).toBe(before)
    expect(log.info).not.toHaveBeenCalled()
  })

  it('re-points a junction without deleting through it', async () => {
    const oldT = join(dir, 'old')
    const newT = join(dir, 'new')
    const lp = join(dir, 'L')
    await link(lp, oldT, log)
    await writeFile(join(oldT, 'keep.sav'), 'x')
    await link(lp, newT, log)
    expect(norm(await readlink(lp))).toBe(norm(newT))
    expect(await readFile(join(oldT, 'keep.sav'), 'utf8')).toBe('x')
    expect(await readdir(newT)).toEqual([])
  })

  it('re-points a junction whose target was deleted', async () => {
    const oldT = join(dir, 'old')
    const lp = join(dir, 'L')
    await link(lp, oldT, log)
    await rm(oldT, { recursive: true })
    await link(lp, join(dir, 'new'), log)
    expect(norm(await readlink(lp))).toBe(norm(join(dir, 'new')))
  })

  it('moves a real folder into the target and replaces it with a junction', async () => {
    const lp = join(dir, 'L')
    const target = join(dir, 'T')
    await mkdir(join(lp, 'sub'), { recursive: true })
    await writeFile(join(lp, 'a.txt'), 'a')
    await writeFile(join(lp, 'sub', 'b.txt'), 'b')
    await link(lp, target, log)
    expect(await isJunction(lp)).toBe(true)
    expect(await readFile(join(target, 'a.txt'), 'utf8')).toBe('a')
    expect(await readFile(join(target, 'sub', 'b.txt'), 'utf8')).toBe('b')
    expect((await readdir(dir)).sort()).toEqual(['L', 'T'])
  })

  it('keeps leftovers that already exist in the target in .playout-old', async () => {
    const lp = join(dir, 'L')
    const target = join(dir, 'T')
    await mkdir(lp)
    await mkdir(target)
    await writeFile(join(lp, 'same.txt'), 'from link')
    await writeFile(join(lp, 'new.txt'), 'new')
    await writeFile(join(target, 'same.txt'), 'from target')
    await mkdir(join(dir, 'L.playout-old'))
    await link(lp, target, log)
    expect(await readFile(join(target, 'same.txt'), 'utf8')).toBe('from target')
    expect(await readFile(join(target, 'new.txt'), 'utf8')).toBe('new')
    expect(await readFile(join(dir, 'L.playout-old-2', 'same.txt'), 'utf8')).toBe('from link')
    expect(log.warn).toHaveBeenCalledOnce()
    expect(await isJunction(lp)).toBe(true)
  })

  it('throws when a file is in the way', async () => {
    const lp = join(dir, 'L')
    await writeFile(lp, 'x')
    await expect(link(lp, join(dir, 'T'), log)).rejects.toThrow(/file is in the way/)
    expect(await readFile(lp, 'utf8')).toBe('x')
  })

  describe('when the volume cannot hold a junction', () => {
    const einval = Object.assign(new Error('EINVAL: invalid argument, symlink'), { code: 'EINVAL' })
    const failingFs: JunctionFs = {
      symlink: vi.fn(async () => {
        throw einval
      }),
      stat: (p) => stat(p),
      realpath: (p) => realpath(p)
    }

    it('leaves a real folder untouched and explains why', async () => {
      const lp = join(dir, 'L')
      const target = join(dir, 'T')
      await mkdir(join(lp, 'sub'), { recursive: true })
      await writeFile(join(lp, 'a.txt'), 'a')
      await writeFile(join(lp, 'sub', 'b.txt'), 'b')
      await expect(link(lp, target, log, failingFs)).rejects.toThrow(
        /^Could not link .*L to .*T: EINVAL.*The Emulation folder must be on a local NTFS drive\.$/
      )
      expect(await isJunction(lp)).toBe(false)
      expect(await readFile(join(lp, 'a.txt'), 'utf8')).toBe('a')
      expect(await readFile(join(lp, 'sub', 'b.txt'), 'utf8')).toBe('b')
      expect(await readdir(target)).toEqual([])
      expect((await readdir(dir)).sort()).toEqual(['L', 'T'])
    })

    it('keeps an existing junction when re-pointing fails', async () => {
      const oldT = join(dir, 'old')
      const lp = join(dir, 'L')
      await link(lp, oldT, log)
      await expect(link(lp, join(dir, 'new'), log, failingFs)).rejects.toThrow(/Could not link/)
      expect(norm(await readlink(lp))).toBe(norm(oldT))
    })

    it('rejects and removes a probe junction that resolves somewhere else', async () => {
      const lp = join(dir, 'L')
      await mkdir(lp)
      await writeFile(join(lp, 'a.txt'), 'a')
      const elsewhere = join(dir, 'elsewhere')
      await mkdir(elsewhere)
      const wrongFs: JunctionFs = {
        symlink: (_t, p, type) => symlink(elsewhere, p, type),
        stat: (p) => stat(p),
        realpath: (p) => realpath(p)
      }
      await expect(link(lp, join(dir, 'T'), log, wrongFs)).rejects.toThrow(/resolves to/)
      expect(await readFile(join(lp, 'a.txt'), 'utf8')).toBe('a')
      expect((await readdir(dir)).sort()).toEqual(['L', 'T', 'elsewhere'])
    })
  })

  it('replaces a stale probe junction or empty probe folder', async () => {
    const target = join(dir, 'T')
    await symlink(join(dir, 'gone'), join(dir, 'L.playout-new'), 'junction')
    await link(join(dir, 'L'), target, log)
    await mkdir(join(dir, 'M.playout-new'))
    await link(join(dir, 'M'), target, log)
    expect((await readdir(dir)).sort()).toEqual(['L', 'M', 'T'])
    expect(await isJunction(join(dir, 'L'))).toBe(true)
    expect(await isJunction(join(dir, 'M'))).toBe(true)
  })

  it('never removes a probe folder that holds data', async () => {
    const lp = join(dir, 'L')
    await mkdir(lp)
    await mkdir(join(dir, 'L.playout-new'))
    await writeFile(join(dir, 'L.playout-new', 'x.sav'), 'x')
    await expect(link(lp, join(dir, 'T'), log)).rejects.toThrow(/in the way/)
    expect(await readFile(join(dir, 'L.playout-new', 'x.sav'), 'utf8')).toBe('x')
    expect(await isJunction(lp)).toBe(false)
  })
})

describe('isJunction', () => {
  it('is false for a missing path, a folder and a file', async () => {
    await writeFile(join(dir, 'f'), '')
    expect(await isJunction(join(dir, 'missing'))).toBe(false)
    expect(await isJunction(dir)).toBe(false)
    expect(await isJunction(join(dir, 'f'))).toBe(false)
  })
})

describe('moveEntry across drives', () => {
  it('copies to a .playout-new name and renames it into place, replacing a copy cut short earlier', async () => {
    const { promises } = await import('fs')
    const realRename = promises.rename.bind(promises)
    const from = join(dir, 'from')
    const to = join(dir, 'to')
    await mkdir(join(from, 'USRDIR'), { recursive: true })
    await writeFile(join(from, 'USRDIR', 'EBOOT.BIN'), 'whole update')
    // What an earlier move left when PlayOut closed mid-copy.
    await mkdir(join(`${to}.playout-new`, 'USRDIR'), { recursive: true })
    await writeFile(join(`${to}.playout-new`, 'USRDIR', 'EBOOT.BIN'), 'wh')
    const spy = vi.spyOn(promises, 'rename').mockImplementation(async (a, b) => {
      if (String(a) === from) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
      return realRename(a, b)
    })
    try {
      await moveEntry(from, to)
    } finally {
      spy.mockRestore()
    }
    expect(await readFile(join(to, 'USRDIR', 'EBOOT.BIN'), 'utf8')).toBe('whole update')
    expect((await readdir(dir)).sort()).toEqual(['to'])
  })
})

describe('mergeFolderInto', () => {
  /** Runs `body` with fs.promises.rename failing (with the error `when` gives) for some paths. */
  const failRename = async <T>(
    when: (from: string, to: string) => NodeJS.ErrnoException | null,
    body: () => Promise<T>
  ): Promise<T> => {
    const { promises } = await import('fs')
    const realRename = promises.rename.bind(promises)
    const spy = vi.spyOn(promises, 'rename').mockImplementation(async (a, b) => {
      const err = when(String(a), String(b))
      if (err) throw err
      return realRename(a, b)
    })
    try {
      return await body()
    } finally {
      spy.mockRestore()
    }
  }
  // EIO is not one of the short locks renameRetry waits out, so a failure is immediate.
  const errno = (code: string): NodeJS.ErrnoException =>
    Object.assign(new Error(code), { code }) as NodeJS.ErrnoException

  it('renames the whole folder when the destination is missing', async () => {
    const from = join(dir, 'from')
    const to = join(dir, 'deep', 'to')
    await mkdir(join(from, 'game', 'BLUS1'), { recursive: true })
    await writeFile(join(from, 'game', 'BLUS1', 'PARAM.SFO'), 'p')
    expect(await mergeFolderInto(from, to, log, 'T')).toEqual({ conflicts: 0, left: 0 })
    expect(await readFile(join(to, 'game', 'BLUS1', 'PARAM.SFO'), 'utf8')).toBe('p')
    expect((await readdir(dir)).sort()).toEqual(['deep'])
  })

  it('removes a junction in the source while its target stays intact', async () => {
    const from = join(dir, 'from')
    const to = join(dir, 'to')
    const target = join(dir, 'saves')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'save.dat'), 'save')
    await mkdir(join(from, 'home', 'u'), { recursive: true })
    await symlink(target, join(from, 'home', 'u', 'trophy'), 'junction')
    await writeFile(join(from, 'home', 'u', 'name'), 'Me')
    await mkdir(join(to, 'home', 'u'), { recursive: true })
    expect(await mergeFolderInto(from, to, log, 'T')).toEqual({ conflicts: 0, left: 0 })
    expect(await readdir(join(to, 'home', 'u'))).toEqual(['name'])
    expect(await readFile(join(target, 'save.dat'), 'utf8')).toBe('save')
    expect((await readdir(dir)).sort()).toEqual(['saves', 'to'])
  })

  it('merges a real savedata folder into the target of a savedata junction at the destination', async () => {
    const from = join(dir, 'from')
    const to = join(dir, 'to')
    const saves = join(dir, 'saves')
    await mkdir(join(saves, 'BLUS1-OLD'), { recursive: true })
    await writeFile(join(saves, 'BLUS1-OLD', 'DATA'), 'kept')
    await writeFile(join(saves, 'shared.dat'), 'link side')
    await mkdir(join(to, 'home', 'u'), { recursive: true })
    await symlink(saves, join(to, 'home', 'u', 'savedata'), 'junction')
    await mkdir(join(from, 'home', 'u', 'savedata', 'BLUS1-SAVE'), { recursive: true })
    await writeFile(join(from, 'home', 'u', 'savedata', 'BLUS1-SAVE', 'DATA'), 'new')
    await writeFile(join(from, 'home', 'u', 'savedata', 'shared.dat'), 'from side')
    // One conflict (shared.dat), nothing failed: the source is set aside as .playout-old.
    expect(await mergeFolderInto(from, to, log, 'T')).toEqual({ conflicts: 1, left: 0 })
    expect(await isJunction(join(to, 'home', 'u', 'savedata'))).toBe(true)
    expect(await readFile(join(saves, 'BLUS1-SAVE', 'DATA'), 'utf8')).toBe('new')
    expect(await readFile(join(saves, 'BLUS1-OLD', 'DATA'), 'utf8')).toBe('kept')
    // A file already at the link's target wins; the other is kept aside.
    expect(await readFile(join(saves, 'shared.dat'), 'utf8')).toBe('link side')
    expect(
      await readFile(join(`${from}.playout-old`, 'home', 'u', 'savedata', 'shared.dat'), 'utf8')
    ).toBe('from side')
    expect((await readdir(dir)).sort()).toEqual(['from.playout-old', 'saves', 'to'])
  })

  it('leaves an entry that fails to move in the source (no .playout-old), moving the rest', async () => {
    const from = join(dir, 'from')
    const to = join(dir, 'to')
    for (const g of ['A', 'B', 'C']) {
      await mkdir(join(from, 'game', g), { recursive: true })
      await writeFile(join(from, 'game', g, 'f'), g)
    }
    await mkdir(join(to, 'game'), { recursive: true })
    // B's folder cannot be renamed (so it is walked) and its file cannot be moved either.
    const stuck = (a: string): boolean =>
      a === join(from, 'game', 'B') || a === join(from, 'game', 'B', 'f')
    const result = await failRename(
      (a) => (stuck(a) ? errno('EIO') : null),
      () => mergeFolderInto(from, to, log, 'T')
    )
    expect(result).toEqual({ conflicts: 0, left: 1 })
    expect(await readFile(join(to, 'game', 'A', 'f'), 'utf8')).toBe('A')
    expect(await readFile(join(to, 'game', 'C', 'f'), 'utf8')).toBe('C')
    await expect(stat(join(to, 'game', 'B', 'f'))).rejects.toThrow()
    // Left where it was for the next run; nothing is set aside.
    expect(await readFile(join(from, 'game', 'B', 'f'), 'utf8')).toBe('B')
    expect(await readdir(join(from, 'game'))).toEqual(['B'])
    expect((await readdir(dir)).sort()).toEqual(['from', 'to'])
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/could not be moved/))
  })

  it('walks a folder whose whole rename fails (a lock or another volume), dropping its links', async () => {
    const from = join(dir, 'from')
    const to = join(dir, 'to')
    const target = join(dir, 'saves')
    await mkdir(target)
    await writeFile(join(target, 'save.dat'), 'save')
    await mkdir(join(from, 'home', 'u'), { recursive: true })
    await writeFile(join(from, 'home', 'u', 'name'), 'Me')
    await symlink(target, join(from, 'home', 'u', 'savedata'), 'junction')
    await symlink(target, join(from, 'trophy'), 'junction')
    // The whole folder and its subfolders fail to rename (another volume): all are walked.
    const result = await failRename(
      (a) =>
        [from, join(from, 'home'), join(from, 'home', 'u')].includes(a) ? errno('EXDEV') : null,
      () => mergeFolderInto(from, to, log, 'T')
    )
    expect(result).toEqual({ conflicts: 0, left: 0 })
    expect(await readFile(join(to, 'home', 'u', 'name'), 'utf8')).toBe('Me')
    expect(await readdir(to)).toEqual(['home'])
    expect(await readdir(join(to, 'home', 'u'))).toEqual(['name'])
    expect(await readFile(join(target, 'save.dat'), 'utf8')).toBe('save')
    expect((await readdir(dir)).sort()).toEqual(['saves', 'to'])
  })

  it('keeps a file written into the source while it ran (left in place, never deleted)', async () => {
    const from = join(dir, 'from')
    const to = join(dir, 'to')
    await mkdir(join(from, 'game', 'A'), { recursive: true })
    await writeFile(join(from, 'game', 'A', 'f'), 'A')
    await mkdir(join(to, 'game'), { recursive: true })
    const late = join(from, 'game', 'LATE', 'download.part')
    const { promises } = await import('fs')
    const realRename = promises.rename.bind(promises)
    // Right after A moves, a download writes a new file into the source.
    const spy = vi.spyOn(promises, 'rename').mockImplementation(async (a, b) => {
      await realRename(a, b)
      if (String(a) === join(from, 'game', 'A')) {
        await mkdir(join(late, '..'), { recursive: true })
        await writeFile(late, 'late')
      }
    })
    let result: MergeResult
    try {
      result = await mergeFolderInto(from, to, log, 'T')
    } finally {
      spy.mockRestore()
    }
    expect(result.conflicts).toBe(0)
    expect(result.left).toBeGreaterThanOrEqual(1)
    expect(await readFile(join(to, 'game', 'A', 'f'), 'utf8')).toBe('A')
    expect(await readFile(late, 'utf8')).toBe('late')
    expect((await readdir(dir)).sort()).toEqual(['from', 'to'])
  })

  it('reports the source as left when setting it aside as .playout-old fails', async () => {
    const from = join(dir, 'from')
    const to = join(dir, 'to')
    await mkdir(from)
    await writeFile(join(from, 'f'), 'from')
    await mkdir(to)
    await writeFile(join(to, 'f'), 'to')
    const result = await failRename(
      (_a, b) => (b.endsWith('.playout-old') ? errno('EIO') : null),
      () => mergeFolderInto(from, to, log, 'T')
    )
    expect(result).toEqual({ conflicts: 1, left: 1 })
    expect(await readFile(join(from, 'f'), 'utf8')).toBe('from')
    expect(await readFile(join(to, 'f'), 'utf8')).toBe('to')
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/could not be set aside/))
  })

  it('counts a folder it cannot read as left', async () => {
    const from = join(dir, 'from')
    const to = join(dir, 'to')
    await mkdir(join(from, 'locked'), { recursive: true })
    await writeFile(join(from, 'locked', 'f'), 'x')
    await mkdir(join(to, 'locked'), { recursive: true })
    const { promises } = await import('fs')
    const realReaddir = promises.readdir.bind(promises) as (p: string) => Promise<string[]>
    const spy = vi.spyOn(promises, 'readdir').mockImplementation((async (p: string) => {
      if (String(p) === join(from, 'locked')) throw errno('EACCES')
      return realReaddir(p)
    }) as never)
    let result: MergeResult | undefined
    try {
      result = await mergeFolderInto(from, to, log, 'T')
    } finally {
      spy.mockRestore()
    }
    expect(result).toEqual({ conflicts: 0, left: 1 })
    expect(await readFile(join(from, 'locked', 'f'), 'utf8')).toBe('x')
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/could not be read/))
  })

  it('leaves a junction or a missing source alone', async () => {
    const target = join(dir, 'real')
    await mkdir(target)
    await writeFile(join(target, 'f'), 'x')
    await symlink(target, join(dir, 'from'), 'junction')
    expect(await mergeFolderInto(join(dir, 'from'), join(dir, 'to'), log, 'T')).toEqual({
      conflicts: 0,
      left: 0
    })
    expect(await mergeFolderInto(join(dir, 'missing'), join(dir, 'to'), log, 'T')).toEqual({
      conflicts: 0,
      left: 0
    })
    expect((await readdir(dir)).sort()).toEqual(['from', 'real'])
    expect(await readFile(join(target, 'f'), 'utf8')).toBe('x')
  })
})
