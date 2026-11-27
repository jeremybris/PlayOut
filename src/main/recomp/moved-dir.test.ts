import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { findMovedRecompDir } from './moved-dir'

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'moved-dir-'))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function file(path: string): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, 'x')
}

describe('findMovedRecompDir', () => {
  it('leaves a folder that is still there', async () => {
    const dir = join(root, 'Xerenge (shipa-2-xerenge)')
    await fs.mkdir(dir)
    expect(
      await findMovedRecompDir({ id: 'github:shipa-2/xerenge', dir, exe: 'a.exe' }, root, [])
    ).toBeNull()
  })

  it('follows the program the user chose into a renamed folder (Burnout Revenge)', async () => {
    const exe = join(root, 'Burnout Revenge', 'Burnout Revenge.exe')
    await file(exe)
    await fs.mkdir(join(root, 'Other (a-b)'))
    const rec = { id: 'github:shipa-2/xerenge', dir: join(root, 'Xerenge (shipa-2-xerenge)'), exe }
    expect(await findMovedRecompDir(rec, root, [])).toBe(join(root, 'Burnout Revenge'))
  })

  it('finds a folder renamed but still ending in its id', async () => {
    await fs.mkdir(join(root, 'My Game (shipa-2-xerenge)'))
    const rec = {
      id: 'github:shipa-2/xerenge',
      dir: join(root, 'Xerenge (shipa-2-xerenge)'),
      exe: 'x.exe'
    }
    expect(await findMovedRecompDir(rec, root, [])).toBe(join(root, 'My Game (shipa-2-xerenge)'))
  })

  it('finds the folder by its name when the Recompilations folder moved', async () => {
    await fs.mkdir(join(root, 'Xerenge (shipa-2-xerenge)'))
    const rec = {
      id: 'github:shipa-2/xerenge',
      dir: 'D:\\Old\\Recompilations\\Xerenge (shipa-2-xerenge)',
      exe: 'x.exe'
    }
    expect(await findMovedRecompDir(rec, root, [])).toBe(join(root, 'Xerenge (shipa-2-xerenge)'))
  })

  it('finds the one folder holding its program', async () => {
    await file(join(root, 'Renamed', 'bin', 'game.exe'))
    await fs.mkdir(join(root, 'Unrelated'))
    const rec = { id: 'github:a/b', dir: join(root, 'B (a-b)'), exe: 'bin\\game.exe' }
    expect(await findMovedRecompDir(rec, root, [])).toBe(join(root, 'Renamed'))
  })

  it('never takes a folder another recompilation owns, or guesses between two', async () => {
    await file(join(root, 'One', 'game.exe'))
    await file(join(root, 'Two', 'game.exe'))
    const rec = { id: 'github:a/b', dir: join(root, 'B (a-b)'), exe: 'game.exe' }
    expect(await findMovedRecompDir(rec, root, [])).toBeNull()
    expect(await findMovedRecompDir(rec, root, [join(root, 'Two')])).toBe(join(root, 'One'))
    const exe = join(root, 'One', 'game.exe')
    expect(
      await findMovedRecompDir({ ...rec, exe }, root, [join(root, 'One'), join(root, 'Two')])
    ).toBeNull()
  })

  it('ignores a chosen program outside the Recompilations folder', async () => {
    const outside = await fs.mkdtemp(join(tmpdir(), 'moved-out-'))
    try {
      await file(join(outside, 'game.exe'))
      const rec = { id: 'github:a/b', dir: join(root, 'B (a-b)'), exe: join(outside, 'game.exe') }
      expect(await findMovedRecompDir(rec, root, [])).toBeNull()
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })
})
