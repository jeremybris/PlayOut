import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGameExtrasStore, SYNCED_KEY } from './game-extras-store'

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'playout-extras-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('game extras store', () => {
  it('remembers, persists and forgets a game’s frame limit', async () => {
    const file = join(dir, 'overlay', 'game-extras.json')
    const store = createGameExtrasStore(file)
    expect(store.get('g1')).toBeNull()
    await store.set('g1', { frameLimit: 60, exe: 'Game.exe' })
    await store.set('exe:other.exe', { frameLimit: 30, exe: 'Other.exe' })
    expect(store.get('g1')).toEqual({ frameLimit: 60, exe: 'Game.exe' })
    const again = createGameExtrasStore(file)
    expect(again.get('exe:other.exe')).toEqual({ frameLimit: 30, exe: 'Other.exe' })
    await again.set('g1', null)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      'exe:other.exe': { frameLimit: 30, exe: 'Other.exe' }
    })
  })

  it('reads a malformed file as empty and drops malformed entries', async () => {
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, '{not json')
    expect(createGameExtrasStore(bad).get('g1')).toBeNull()
    const mixed = join(dir, 'mixed.json')
    writeFileSync(
      mixed,
      JSON.stringify({
        ok: { frameLimit: 45, exe: 'A.exe' },
        neg: { frameLimit: -1, exe: 'B.exe' },
        big: { frameLimit: 5000, exe: 'C.exe' },
        noexe: { frameLimit: 60 },
        frac: { frameLimit: 59.5, exe: 'D.exe' }
      })
    )
    const s = createGameExtrasStore(mixed)
    expect(s.get('ok')).toEqual({ frameLimit: 45, exe: 'A.exe' })
    for (const k of ['neg', 'big', 'noexe', 'frac']) expect(s.get(k)).toBeNull()
  })

  it('refuses invalid values and returns copies', async () => {
    const s = createGameExtrasStore(join(dir, 'x.json'))
    await expect(s.set('g', { frameLimit: 1001, exe: 'A.exe' })).rejects.toThrow()
    await expect(s.set('', { frameLimit: 60, exe: 'A.exe' })).rejects.toThrow()
    await s.set('g', { frameLimit: 60, exe: 'A.exe' })
    s.get('g')!.frameLimit = 1
    expect(s.get('g')!.frameLimit).toBe(60)
  })
})

describe('sync records', () => {
  it('persist the exes a sync limit is on, next to the frame limits, until forgotten', async () => {
    const file = join(dir, 'g.json')
    const s = createGameExtrasStore(file)
    await s.set('g1', { frameLimit: 60, exe: 'Game.exe' })
    await s.setSynced('g1', 'Launcher.exe')
    await s.setSynced('exe:x.exe', 'X.exe')
    const again = createGameExtrasStore(file)
    expect(again.getSynced('g1')).toBe('Launcher.exe')
    expect(again.allSynced()).toEqual([
      ['g1', 'Launcher.exe'],
      ['exe:x.exe', 'X.exe']
    ])
    // Frame limits are unaffected by the sync record (and the record is not a game).
    expect(again.get('g1')).toEqual({ frameLimit: 60, exe: 'Game.exe' })
    expect(again.get(SYNCED_KEY)).toBeNull()
    await expect(again.set(SYNCED_KEY, { frameLimit: 60, exe: 'A.exe' })).rejects.toThrow()
    await expect(again.setSynced('g2', 'a/b.exe')).rejects.toThrow()
    await again.setSynced('g1', null)
    await again.setSynced('exe:x.exe', null)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      g1: { frameLimit: 60, exe: 'Game.exe' }
    })
  })

  it('drops malformed sync records and clears everything', async () => {
    const file = join(dir, 'm.json')
    writeFileSync(file, JSON.stringify({ [SYNCED_KEY]: { ok: 'A.exe', bad: 5, path: 'C:/x.exe' } }))
    const s = createGameExtrasStore(file)
    expect(s.allSynced()).toEqual([['ok', 'A.exe']])
    await s.set('g', { frameLimit: 30, exe: 'G.exe' })
    await s.clear()
    expect(s.allSynced()).toEqual([])
    expect(s.get('g')).toBeNull()
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({})
  })
})
