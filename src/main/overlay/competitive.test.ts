import { describe, expect, it } from 'vitest'
import type { Game } from '../../shared/types'
import { competitiveUnder } from './competitive'

const game = (over: Partial<Game> & { tags?: string[] }): Game =>
  ({
    id: over.id ?? 'g',
    title: over.title ?? 'Game',
    installDir: over.installDir,
    exePath: over.exePath,
    remote: over.remote,
    metadata: { steamTags: { tags: over.tags ?? [] } }
  }) as unknown as Game

describe('competitiveUnder (the overlay never pauses these)', () => {
  const cs = game({
    id: 'cs',
    title: 'Arena Shooter',
    tags: ['FPS', 'Competitive'],
    installDir: 'C:\\Steam\\steamapps\\common\\Arena'
  })
  const coop = game({
    id: 'co',
    title: 'Co-op Quest',
    tags: ['Online Co-Op'],
    installDir: 'C:\\Steam\\steamapps\\common\\Quest'
  })
  const mmo = game({ id: 'mmo', title: 'Big World', tags: ['MMO'], exePath: 'D:\\BW\\bin\\bw.exe' })

  it('names the competitive game PlayOut is running', () => {
    expect(competitiveUnder({ program: 'x.exe', exe: null }, cs, () => [])).toBe(
      'Arena Shooter is a competitive online game'
    )
    expect(competitiveUnder({ program: 'x.exe', exe: null }, coop, () => [])).toBeNull()
  })

  it('finds a Steam game started outside PlayOut by its install folder, and others by their exe', () => {
    const all = (): Game[] => [coop, cs, mmo]
    expect(
      competitiveUnder(
        { program: 'arena.exe', exe: 'c:/steam/steamapps/common/arena/bin/win64/arena.exe' },
        undefined,
        all
      )
    ).toBe('Arena Shooter is a competitive online game')
    expect(competitiveUnder({ program: 'BW.EXE', exe: null }, undefined, all)).toBe(
      'Big World is a competitive online game'
    )
    // A co-op game, a folder that only starts with the same name, and a host's game: paused as before.
    expect(
      competitiveUnder(
        { program: 'quest.exe', exe: 'C:\\Steam\\steamapps\\common\\Quest\\quest.exe' },
        undefined,
        all
      )
    ).toBeNull()
    expect(
      competitiveUnder(
        { program: 'a.exe', exe: 'C:\\Steam\\steamapps\\common\\Arena2\\a.exe' },
        undefined,
        all
      )
    ).toBeNull()
    expect(
      competitiveUnder({ program: 'bw.exe', exe: null }, undefined, () => [
        game({ ...mmo, tags: ['MMO'], remote: {} as Game['remote'] })
      ])
    ).toBeNull()
  })
})
