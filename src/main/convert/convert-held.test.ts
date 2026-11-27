import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HELD_DIR } from '../services/held-files'
import { primaryOutput, removeNew } from './convert-service'

// A recompilation's test run after Delete moves a disc image aside into <its folder>\.playout-held while a conversion
// may run in the same folder: a stopped or refused run never removes that folder, nor takes it for its output.
describe('convert: the held disc image folder', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'playout-convert-held-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('removeNew leaves a .playout-held folder made during the run', async () => {
    await fs.writeFile(join(dir, 'A.iso'), 'a')
    const before = new Set(await fs.readdir(dir))
    await fs.writeFile(join(dir, 'A.chd'), 'partial')
    await fs.mkdir(join(dir, HELD_DIR, 'm3x9k2-4f7a1c'), { recursive: true })
    await fs.writeFile(join(dir, HELD_DIR, 'm3x9k2-4f7a1c', 'B.iso'), 'b')
    await removeNew(dir, before)
    expect((await fs.readdir(dir)).sort()).toEqual(['.playout-held', 'A.iso'])
    expect(await fs.readFile(join(dir, HELD_DIR, 'm3x9k2-4f7a1c', 'B.iso'), 'utf8')).toBe('b')
  })

  it('primaryOutput never picks the .playout-held folder', async () => {
    await fs.mkdir(join(dir, HELD_DIR, 'm3x9k2-4f7a1c'), { recursive: true })
    await fs.writeFile(join(dir, HELD_DIR, 'm3x9k2-4f7a1c', 'B.chd'), 'b')
    const folderFormat = { exts: [], folder: true } as never
    expect(await primaryOutput(dir, [HELD_DIR], folderFormat)).toBeUndefined()
    const chd = { exts: ['.chd'], folder: false } as never
    expect(await primaryOutput(dir, [HELD_DIR], chd)).toBeUndefined()
    // Nothing moved out of it.
    expect(await fs.readdir(dir)).toEqual([HELD_DIR])
  })
})
