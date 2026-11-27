import { describe, expect, it } from 'vitest'
import type { CustomFilter, Game } from '../../shared/types'
import { followCustomFilters } from './custom-filters-follow'

function game(id: string, extra: Partial<Game> = {}): Game {
  const [source, ...rest] = id.split(':')
  return {
    id,
    source: source as Game['source'],
    externalId: rest.join(':'),
    platformId: 'pc',
    title: id,
    favorite: false,
    user: {},
    ...extra
  } as unknown as Game
}

const filter = (gameIds: string[], gameKeys?: Record<string, string>): CustomFilter => ({
  id: 'cf1',
  name: 'Mine',
  icon: 'star',
  gameIds,
  ...(gameKeys ? { gameKeys } : {})
})

describe('followCustomFilters', () => {
  it('changes nothing for store games that are where they were', () => {
    expect(followCustomFilters([filter(['steam:1'])], [game('steam:1')])).toBeNull()
    expect(followCustomFilters([], [game('steam:1')])).toBeNull()
  })

  it("moves a card's id to where it went (a recompilation absorbed into the original game)", () => {
    const out = followCustomFilters(
      [filter(['recomp:sm64', 'steam:2'])],
      [game('steam:9'), game('steam:2')],
      { 'recomp:sm64': 'steam:9' }
    )
    expect(out![0]!.gameIds).toEqual(['steam:9', 'steam:2'])
  })

  it('keeps one id when the card it moved to is in the filter already', () => {
    const out = followCustomFilters([filter(['a:1', 'steam:9'])], [game('steam:9')], {
      'a:1': 'steam:9'
    })
    expect(out![0]!.gameIds).toEqual(['steam:9'])
  })

  it('records the key a manual game or ROM is found again by, and not for store games', () => {
    const manual = game('manual:c:/games/old/doom.exe', { title: 'DOOM' })
    const out = followCustomFilters([filter([manual.id, 'steam:1'])], [manual, game('steam:1')])
    expect(out![0]!.gameKeys).toEqual({ [manual.id]: 'manual|pc|doom' })
    // Already recorded: nothing to change.
    expect(followCustomFilters(out!, [manual, game('steam:1')])).toBeNull()
  })

  it('follows a manual game whose exe moved (its old card gone, a new one with the same title)', () => {
    const old = game('manual:c:/games/old/doom.exe', { title: 'DOOM' })
    const [recorded] = followCustomFilters([filter([old.id])], [old])!
    const moved = game('manual:d:/games/doom/doom.exe', { title: 'DOOM' })
    const out = followCustomFilters([recorded!], [moved])
    expect(out![0]!.gameIds).toEqual([moved.id])
    expect(out![0]!.gameKeys).toEqual({ [moved.id]: 'manual|pc|doom' })
  })

  it('follows a ROM moved to another folder by its file name', () => {
    const old = game('rom:snes/old/Zelda.sfc', { platformId: 'snes', title: 'Zelda' })
    const [recorded] = followCustomFilters([filter([old.id])], [old])!
    const moved = game('rom:snes/new/Zelda.sfc', { platformId: 'snes', title: 'Zelda' })
    expect(followCustomFilters([recorded!], [moved])![0]!.gameIds).toEqual([moved.id])
  })

  it('leaves a gone game as it is when several games match its key, or none', () => {
    const old = game('manual:c:/a/doom.exe', { title: 'DOOM' })
    const [recorded] = followCustomFilters([filter([old.id])], [old])!
    const two = [
      game('manual:d:/b/doom.exe', { title: 'DOOM' }),
      game('manual:e:/c/doom.exe', { title: 'DOOM' })
    ]
    expect(followCustomFilters([recorded!], two)).toBeNull()
    expect(followCustomFilters([recorded!], [])).toBeNull()
  })

  it("drops the keys of games taken out of the filter (the renderer's remove leaves them)", () => {
    const out = followCustomFilters(
      [filter(['steam:1'], { 'manual:x': 'manual|pc|x' })],
      [game('steam:1')]
    )
    expect(out![0]).not.toHaveProperty('gameKeys')
  })
})
