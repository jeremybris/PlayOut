// The list of recompilations added in the browser (userData/recomp-added.json), in a temp folder.
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AddedRecomp } from '../../shared/recomp'
import {
  ADDED_FILE,
  isPlainLine,
  oneLine,
  parseAddedEntry,
  readAdded,
  withAdded,
  writeAdded
} from './added'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-recomp-added-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const entry = (over: Partial<AddedRecomp> = {}): AddedRecomp => ({
  id: 'github:zeldaret/mm',
  repo: 'ZeldaRET/mm',
  game: "Majora's Mask",
  systemId: 'n64',
  blurb: 'A port.',
  stars: 5,
  license: 'MIT',
  addedAt: '2026-11-27T12:00:00.000Z',
  state: 'suggested',
  prUrl: 'https://github.com/jeremybris/PlayOut-metadata/pull/4',
  ...over
})

describe('recomp-added.json', () => {
  it('round-trips the list, atomically', async () => {
    const list = [
      entry(),
      entry({ id: 'github:a/b', repo: 'a/b', state: 'local', prUrl: undefined })
    ]
    await writeAdded(dir, list)
    expect(await readAdded(dir)).toEqual([
      entry(),
      {
        id: 'github:a/b',
        repo: 'a/b',
        game: "Majora's Mask",
        systemId: 'n64',
        blurb: 'A port.',
        stars: 5,
        license: 'MIT',
        addedAt: '2026-11-27T12:00:00.000Z',
        state: 'local'
      }
    ])
    expect((await fs.readdir(dir)).sort()).toEqual([ADDED_FILE])
  })

  it('reads nothing from a missing or broken file', async () => {
    expect(await readAdded(dir)).toEqual([])
    await fs.writeFile(join(dir, ADDED_FILE), '{ broken')
    expect(await readAdded(dir)).toEqual([])
  })

  it('drops entries that are not valid, and keeps each id once', async () => {
    await fs.writeFile(
      join(dir, ADDED_FILE),
      JSON.stringify({
        version: 1,
        entries: [
          entry(),
          entry(),
          entry({ id: 'github:other/mm' }),
          entry({ id: 'github:a/..', repo: 'a/..' }),
          entry({ id: 'github:a/b', repo: 'a/b', systemId: 'nope' }),
          entry({ id: 'github:a/c', repo: 'a/c', game: '   ' }),
          {
            ...entry({ id: 'github:a/d', repo: 'a/d' }),
            state: 'weird',
            prUrl: 'https://evil.example/x'
          },
          'junk'
        ]
      })
    )
    const list = await readAdded(dir)
    expect(list.map((e) => e.id)).toEqual(['github:zeldaret/mm', 'github:a/d'])
    expect(list[1]).toMatchObject({ state: 'local' })
    expect(list[1]!.prUrl).toBeUndefined()
  })

  it('keeps text to one plain line', () => {
    expect(oneLine('  a\n\tb  ', 100)).toBe('a b')
    expect(oneLine('x'.repeat(10), 5)).toBe('xxxx…')
    expect(oneLine(undefined, 5)).toBe('')
    expect(isPlainLine('A native port <3')).toBe(true)
    expect(isPlainLine('<b>bold</b>')).toBe(false)
    expect(isPlainLine('javascript:alert(1)')).toBe(false)
    expect(parseAddedEntry({ ...entry(), game: 'a\nb' })?.game).toBe('a b')
  })

  it('replaces an entry of the same id and moves it to the end', () => {
    const a = entry({ id: 'github:a/a', repo: 'a/a' })
    const b = entry({ id: 'github:b/b', repo: 'b/b' })
    expect(withAdded([a, b], { ...a, state: 'published' }).map((e) => [e.id, e.state])).toEqual([
      ['github:b/b', 'suggested'],
      ['github:a/a', 'published']
    ])
  })
})
