import type { Game } from '@shared/types'
import { describe, expect, it } from 'vitest'
import { storageGames, storageTotals } from './storageView'

const GB = 1024 ** 3
const at = '2026-11-01T00:00:00.000Z'

function game(id: string, over: Partial<Game> = {}): Game {
  return {
    id,
    source: 'steam',
    title: id,
    installed: true,
    platformId: 'steam',
    metadata: {},
    media: {},
    user: {},
    ...over
  } as Game
}

describe('storageGames', () => {
  it('lists the games on this PC, largest first, unknown sizes last', () => {
    const list = storageGames([
      game('small', {
        installSize: { bytes: 2 * GB, how: 'folder', path: 'C:/s', measuredAt: at }
      }),
      game('big', { installSize: { bytes: 90 * GB, how: 'folder', path: 'C:/b', measuredAt: at } }),
      game('unknown'),
      game('typed', { user: { installSize: 40 * GB } }),
      // Not on this PC: not installed, or a paired host's game.
      game('store', { installed: false }),
      game('remote:host:x', { remote: { hostId: 'h' } as never })
    ])
    expect(list.map((g) => [g.game.id, g.bytes])).toEqual([
      ['big', 90 * GB],
      ['typed', 40 * GB],
      ['small', 2 * GB],
      ['unknown', null]
    ])
  })

  it("uses the store's figure as an estimate when the folder could not be measured", () => {
    const [entry] = storageGames([
      game('shared', {
        installSize: { bytes: 0, how: 'folder', path: 'C:/x', measuredAt: at, unmeasurable: true },
        metadata: { storage: { bytes: 12 * GB, how: 'steam', checkedAt: at } }
      })
    ])
    expect(entry).toMatchObject({ bytes: 12 * GB, estimate: true, path: 'C:/x' })
  })

  it('includes a game played from its recompilation (its disc image deleted)', () => {
    const list = storageGames([
      game('rom', {
        source: 'rom',
        installed: false,
        romRemoved: {
          at,
          recompId: 'r',
          romPath: 'D:/x.iso',
          installSize: { bytes: 5 * GB, how: 'file', path: 'D:/x.iso', measuredAt: at }
        }
      })
    ])
    expect(list.map((g) => g.bytes)).toEqual([5 * GB])
  })
})

describe('storageTotals', () => {
  const drives = [
    { root: 'C:\\', label: null, totalBytes: 1000 * GB, freeBytes: 200 * GB },
    { root: 'D:\\', label: 'Games', totalBytes: 2000 * GB, freeBytes: 600 * GB }
  ]

  it('adds the drives up; Other is size minus free minus the games', () => {
    const t = storageTotals(drives, [
      { game: game('a'), bytes: 1500 * GB, estimate: false, path: null },
      { game: game('b'), bytes: null, estimate: false, path: null }
    ])
    expect(t).toMatchObject({ total: 3000 * GB, free: 800 * GB, games: 1500 * GB, other: 700 * GB })
    expect(t.gamesShare).toBeCloseTo(0.5)
    expect(t.otherShare).toBeCloseTo(700 / 3000)
  })

  it('never lets the games (estimates) count for more than the used space', () => {
    const t = storageTotals(drives, [
      { game: game('a'), bytes: 5000 * GB, estimate: true, path: null }
    ])
    expect(t).toMatchObject({ games: 2200 * GB, other: 0 })
  })

  it('counts only games on the drives in the bar, and a folder inside another game once', () => {
    const t = storageTotals(drives, [
      { game: game('main'), bytes: 100 * GB, estimate: false, path: 'D:\\Games\\Big' },
      // A second entry for the game's launcher, inside its folder: already counted.
      { game: game('launcher'), bytes: 100 * GB, estimate: false, path: 'd:/games/big/' },
      // On a USB drive the bar does not show.
      { game: game('usb'), bytes: 50 * GB, estimate: false, path: 'F:\\Games\\Small' },
      { game: game('c'), bytes: 10 * GB, estimate: false, path: 'C:\\Games\\Tiny' }
    ])
    expect(t.games).toBe(110 * GB)
  })

  it('shows nothing for no drives', () => {
    expect(storageTotals([], [])).toMatchObject({ total: 0, gamesShare: 0, otherShare: 0 })
  })
})
