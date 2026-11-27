import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  defaultHeldIo,
  HELD_DIR,
  heldEntryValid,
  heldPathFor,
  isHeldDirName,
  moveAside,
  newHoldId,
  putBack,
  trashHeld,
  validHoldId,
  type HeldEntry,
  type HeldIo
} from './held-files'

let tmp: string
const ID = 'm3x9k2-4f7a1c'

beforeEach(async () => {
  tmp = await fs.mkdtemp(join(tmpdir(), 'playout-held-'))
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 })
})

const exists = (p: string): Promise<boolean> =>
  fs.stat(p).then(
    () => true,
    () => false
  )

/** Real renames in the temp folder; a fake Recycle Bin that records and removes. */
function io(over: Partial<HeldIo> = {}): HeldIo & { trashed: string[] } {
  const trashed: string[] = []
  return {
    ...defaultHeldIo,
    trash: async (p) => {
      trashed.push(p)
      await fs.rm(p, { recursive: true, force: true })
    },
    trashed,
    ...over
  }
}

/** A .cue set in <tmp>/roms/psx: the data file first, the card's own file last (imageTrashOrder). */
async function discSet(): Promise<{ cue: string; bin: string; entries: HeldEntry[] }> {
  const dir = join(tmp, 'roms', 'psx')
  await fs.mkdir(dir, { recursive: true })
  const cue = join(dir, 'Game.cue')
  const bin = join(dir, 'Game.bin')
  await fs.writeFile(cue, 'cue')
  await fs.writeFile(bin, 'bin')
  return {
    cue,
    bin,
    entries: [bin, cue].map((original) => ({ original, held: heldPathFor(original, ID) }))
  }
}

describe('held-files: paths', () => {
  it('holds a file in a hidden folder right beside it, never anywhere else', () => {
    expect(heldPathFor('C:\\roms\\ps2\\Game.iso', ID)).toBe(
      join('C:\\roms\\ps2', HELD_DIR, ID, 'Game.iso')
    )
    expect(isHeldDirName('.playout-held')).toBe(true)
    expect(isHeldDirName('.PlayOut-Held')).toBe(true)
    expect(isHeldDirName('held')).toBe(false)
  })

  it('accepts only entries PlayOut made for that hold', () => {
    const original = join(tmp, 'Game.iso')
    expect(heldEntryValid({ original, held: heldPathFor(original, ID) }, ID)).toBe(true)
    // Another hold's path, a path elsewhere, a relative original, a bad id.
    expect(heldEntryValid({ original, held: heldPathFor(original, 'other-123456') }, ID)).toBe(
      false
    )
    expect(heldEntryValid({ original, held: join(tmp, 'elsewhere', 'Game.iso') }, ID)).toBe(false)
    expect(heldEntryValid({ original: 'Game.iso', held: heldPathFor('Game.iso', ID) }, ID)).toBe(
      false
    )
    expect(heldEntryValid({ original, held: heldPathFor(original, '../x') }, '../x')).toBe(false)
    // An original inside a holding folder (a hold of a hold) is refused too.
    const inside = join(tmp, HELD_DIR, ID, 'Game.iso')
    expect(heldEntryValid({ original: inside, held: heldPathFor(inside, ID) }, ID)).toBe(false)
  })

  it('makes valid hold ids', () => {
    const id = newHoldId(1_700_000_000_000, () => 0.5)
    expect(validHoldId(id)).toBe(true)
    expect(validHoldId('a/b')).toBe(false)
    expect(validHoldId('')).toBe(false)
  })
})

describe('held-files: move aside, put back, Recycle Bin', () => {
  it('moves the set aside and puts it back exactly (card file first), leaving no holding folder', async () => {
    const { cue, bin, entries } = await discSet()
    expect(await moveAside(entries, ID, io())).toEqual({ ok: true })
    expect(await exists(cue)).toBe(false)
    expect(await exists(bin)).toBe(false)
    expect(await fs.readFile(heldPathFor(cue, ID), 'utf8')).toBe('cue')
    const renames: string[] = []
    const back = await putBack(
      entries,
      ID,
      io({
        rename: async (from, to) => {
          renames.push(to)
          await fs.rename(from, to)
        }
      })
    )
    expect(back).toMatchObject({ ok: true, message: 'Restored', left: [] })
    expect(renames).toEqual([cue, bin])
    expect(await fs.readFile(cue, 'utf8')).toBe('cue')
    expect(await fs.readFile(bin, 'utf8')).toBe('bin')
    expect(await exists(join(tmp, 'roms', 'psx', HELD_DIR))).toBe(false)
  })

  it('a rename that fails part way puts back what moved (a rename across drives too)', async () => {
    const { cue, bin, entries } = await discSet()
    let n = 0
    const failing = io({
      rename: async (from, to) => {
        if (++n === 2)
          throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' })
        await fs.rename(from, to)
      }
    })
    const r = await moveAside(entries, ID, failing)
    expect(r).toEqual({
      ok: false,
      message: 'Game.cue could not be moved aside on its own drive',
      stuck: []
    })
    expect(await fs.readFile(cue, 'utf8')).toBe('cue')
    expect(await fs.readFile(bin, 'utf8')).toBe('bin')
    expect(await exists(join(tmp, 'roms', 'psx', HELD_DIR))).toBe(false)
  })

  it('reports what could not be put back after a failure (still held, never lost)', async () => {
    const { bin, entries } = await discSet()
    let n = 0
    const r = await moveAside(
      entries,
      ID,
      io({
        rename: async (from, to) => {
          n++
          if (n === 2) throw new Error('locked')
          if (n === 3) throw new Error('locked too')
          await fs.rename(from, to)
        }
      })
    )
    expect(r).toMatchObject({ ok: false, stuck: [entries[0]] })
    expect(await exists(heldPathFor(bin, ID))).toBe(true)
  })

  it('never moves over something already held at that path', async () => {
    const { bin, entries } = await discSet()
    await fs.mkdir(join(tmp, 'roms', 'psx', HELD_DIR, ID), { recursive: true })
    await fs.writeFile(heldPathFor(bin, ID), 'other')
    const r = await moveAside(entries, ID, io())
    expect(r.ok).toBe(false)
    expect(await fs.readFile(bin, 'utf8')).toBe('bin')
    expect(await fs.readFile(heldPathFor(bin, ID), 'utf8')).toBe('other')
  })

  it('refuses to restore over a file that is at the original path now (nothing moves)', async () => {
    const { cue, bin, entries } = await discSet()
    await moveAside(entries, ID, io())
    await fs.writeFile(cue, 'new')
    const r = await putBack(entries, ID, io())
    expect(r.ok).toBe(false)
    expect(r.message).toContain(cue)
    expect(r.restored).toEqual([])
    expect(await fs.readFile(cue, 'utf8')).toBe('new')
    expect(await exists(bin)).toBe(false)
    expect(await exists(heldPathFor(bin, ID))).toBe(true)
  })

  it('counts a file already back as restored, and says which one is gone', async () => {
    const { cue, bin, entries } = await discSet()
    await moveAside(entries, ID, io())
    await fs.rename(heldPathFor(bin, ID), bin)
    await fs.rm(heldPathFor(cue, ID))
    const r = await putBack(entries, ID, io())
    expect(r).toMatchObject({ ok: true, left: [] })
    expect(r.message).toContain('Game.cue was no longer there')
  })

  it('trashes the held files from where they wait, and stops at a failure (the rest stays held)', async () => {
    const { cue, bin, entries } = await discSet()
    await moveAside(entries, ID, io())
    const bin1 = io()
    expect(await trashHeld(entries, ID, bin1)).toMatchObject({ ok: true, left: [] })
    expect(bin1.trashed).toEqual([heldPathFor(bin, ID), heldPathFor(cue, ID)])
    expect(await exists(join(tmp, 'roms', 'psx', HELD_DIR))).toBe(false)

    const again = await discSet()
    await moveAside(again.entries, ID, io())
    const failing = io({
      trash: async () => {
        throw new Error('no Recycle Bin on this drive')
      }
    })
    const r = await trashHeld(again.entries, ID, failing)
    expect(r.ok).toBe(false)
    expect(r.left).toEqual(again.entries)
    expect(await exists(heldPathFor(again.bin, ID))).toBe(true)
  })

  it('never trashes or renames an entry that is not one of its own', async () => {
    const outside = join(tmp, 'keep.txt')
    await fs.writeFile(outside, 'keep')
    const bad: HeldEntry[] = [{ original: join(tmp, 'x.iso'), held: outside }]
    const bin = io()
    expect((await trashHeld(bad, ID, bin)).ok).toBe(false)
    expect(bin.trashed).toEqual([])
    expect((await putBack(bad, ID, bin)).ok).toBe(false)
    expect((await moveAside(bad, ID, bin)).ok).toBe(false)
    expect(await fs.readFile(outside, 'utf8')).toBe('keep')
  })

  it('leaves a holding folder that still has something else in it', async () => {
    const { entries } = await discSet()
    await moveAside(entries, ID, io())
    const other = join(tmp, 'roms', 'psx', HELD_DIR, 'other-123456')
    await fs.mkdir(other, { recursive: true })
    await putBack(entries, ID, io())
    expect(await exists(other)).toBe(true)
    expect(await exists(join(tmp, 'roms', 'psx', HELD_DIR, ID))).toBe(false)
  })
})
