import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { isNew, NEW_FOR_MS, readSeen, recordSeen, writeSeen } from './seen'

const T0 = '2026-11-01T00:00:00.000Z'
const T1 = '2026-11-10T00:00:00.000Z'

describe('recordSeen / isNew', () => {
  it('treats everything in the first complete check as already listed', () => {
    const s = recordSeen(null, ['a', 'b'], T0)
    expect(s.baseline).toBe(T0)
    expect(isNew(s, 'a', new Date(T1))).toBe(false)
  })

  it('marks ids that appear in a later check as new, for two weeks', () => {
    const s = recordSeen(recordSeen(null, ['a'], T0), ['a', 'c'], T1)
    expect(s.ids.a).toBe(T0)
    expect(isNew(s, 'c', new Date(T1))).toBe(true)
    expect(isNew(s, 'c', new Date(Date.parse(T1) + NEW_FOR_MS + 1))).toBe(false)
    expect(isNew(s, 'unknown', new Date(T1))).toBe(false)
    expect(isNew(null, 'c', new Date(T1))).toBe(false)
  })

  it('keeps ids that drop out of a catalog (they are not new when they come back)', () => {
    const s = recordSeen(recordSeen(recordSeen(null, ['a', 'b'], T0), ['a'], T1), ['a', 'b'], T1)
    expect(isNew(s, 'b', new Date(T1))).toBe(false)
  })
})

describe('readSeen / writeSeen', () => {
  let dir = ''
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('round-trips and ignores a damaged file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'seen-'))
    const file = join(dir, 'sub', 'seen.json')
    expect(await readSeen(file)).toBeNull()
    const s = recordSeen(null, ['x'], T0)
    await writeSeen(file, s)
    expect(await readSeen(file)).toEqual(s)
    const { writeFile } = await import('fs/promises')
    await writeFile(file, '{oops', 'utf8')
    expect(await readSeen(file)).toBeNull()
  })
})
