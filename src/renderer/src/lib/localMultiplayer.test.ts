import type { Game } from '@shared/types'
import { describe, expect, it } from 'vitest'
import {
  knownLocalMultiplayerIds,
  LOCAL_ALL,
  PLAYER_BANDS,
  hasLocalMultiplayerTag,
  localMultiplayerLabel,
  localPlayerCount,
  matchesLocalMultiplayer
} from './localMultiplayer'

const game = (meta: Record<string, unknown>): Game => ({ metadata: meta }) as unknown as Game
const players = (max: number): Game => game({ localPlayers: { max } })
const coop = (maxPlayers?: number): Game =>
  game({ coop: { archive: 'a.nc', gameName: 'G', maxPlayers, matchedBy: 'steam', updatedAt: '' } })

describe('Local Multiplayer filter', () => {
  it('lists the player counts in order', () => {
    expect(PLAYER_BANDS.map((b) => b.label)).toEqual(['2 Players', '3-4 Players', '5+ Players'])
    expect(localMultiplayerLabel(LOCAL_ALL)).toBe('Local Multiplayer')
    expect(localMultiplayerLabel('3-4')).toBe('3-4 Players')
    expect(localMultiplayerLabel('5+')).toBe('5+ Players')
  })

  it('counts players from LaunchBox, else the Co-Op handler, the larger of the two', () => {
    expect(localPlayerCount(players(2))).toBe(2)
    expect(localPlayerCount(coop(4))).toBe(4)
    expect(localPlayerCount(game({ localPlayers: { max: 2 }, coop: { maxPlayers: 4 } }))).toBe(4)
    // Online player counts (more than eight) are not local.
    expect(localPlayerCount(players(32))).toBeUndefined()
    expect(localPlayerCount(game({}))).toBeUndefined()
  })

  it('puts a game in each band its count falls in', () => {
    expect(matchesLocalMultiplayer(players(1), '2')).toBe(false)
    expect(matchesLocalMultiplayer(players(2), '3-4')).toBe(false)
    expect(matchesLocalMultiplayer(players(3), '3-4')).toBe(true)
    expect(matchesLocalMultiplayer(players(2), '2')).toBe(true)
    expect(matchesLocalMultiplayer(players(4), '3-4')).toBe(true)
    expect(matchesLocalMultiplayer(players(5), '3-4')).toBe(false)
    expect(matchesLocalMultiplayer(players(5), '5+')).toBe(true)
    expect(matchesLocalMultiplayer(players(8), '5+')).toBe(true)
    expect(matchesLocalMultiplayer(players(4), '5+')).toBe(false)
    // A Nucleus Co-Op game counts by its handler's players.
    expect(matchesLocalMultiplayer(coop(4), '3-4')).toBe(true)
    expect(matchesLocalMultiplayer(game({}), '2')).toBe(false)
  })

  it("'All Local Multiplayer' takes Steam's local tags and every Nucleus Co-Op game", () => {
    for (const tag of [
      '4 Player Local',
      'Co-op Campaign',
      'Local Co-Op',
      'Local Multiplayer',
      'Split Screen'
    ]) {
      const g = game({ steamTags: { tags: ['Action', tag] } })
      expect(hasLocalMultiplayerTag(g)).toBe(true)
      expect(matchesLocalMultiplayer(g, LOCAL_ALL)).toBe(true)
    }
    expect(
      matchesLocalMultiplayer(game({ steamTags: { tags: ['Online Co-Op'] } }), LOCAL_ALL)
    ).toBe(false)
    expect(matchesLocalMultiplayer(coop(), LOCAL_ALL)).toBe(true)
    expect(matchesLocalMultiplayer(players(4), LOCAL_ALL)).toBe(false)
  })
})

describe('Party Games and S.O. Games', () => {
  const local = (main?: number): Game =>
    game({
      steamTags: { tags: ['Local Co-Op'] },
      ...(main !== undefined ? { hltb: { main } } : {})
    })

  it('are All Local Multiplayer games of a How Long To Beat length', () => {
    expect(localMultiplayerLabel('party')).toBe('Party Games')
    expect(localMultiplayerLabel('so')).toBe('S.O. Games')
    // Party Games: 0-3 and 3-10 hours.
    expect(matchesLocalMultiplayer(local(1.5), 'party')).toBe(true)
    expect(matchesLocalMultiplayer(local(2.9), 'party')).toBe(true)
    expect(matchesLocalMultiplayer(local(3), 'party')).toBe(true)
    expect(matchesLocalMultiplayer(local(9.9), 'party')).toBe(true)
    expect(matchesLocalMultiplayer(local(10), 'party')).toBe(false)
    // S.O. Games: 10 hours and more (10-20, 20-50, 50-100, 100+).
    expect(matchesLocalMultiplayer(local(10), 'so')).toBe(true)
    expect(matchesLocalMultiplayer(local(35), 'so')).toBe(true)
    expect(matchesLocalMultiplayer(local(150), 'so')).toBe(true)
    // 3-10 hours: Party Games only.
    expect(matchesLocalMultiplayer(local(6), 'party')).toBe(true)
    expect(matchesLocalMultiplayer(local(6), 'so')).toBe(false)
    // No HLTB time: neither.
    expect(matchesLocalMultiplayer(local(), 'party')).toBe(false)
    expect(matchesLocalMultiplayer(local(), 'so')).toBe(false)
    // A Nucleus Co-Op game counts as local multiplayer; a short single-player game does not.
    expect(matchesLocalMultiplayer(game({ ...coop().metadata, hltb: { main: 2 } }), 'party')).toBe(
      true
    )
    expect(matchesLocalMultiplayer(game({ hltb: { main: 2 } }), 'party')).toBe(false)
  })
})

describe('saved choices', () => {
  it("drops a choice this version no longer has (the old '1 Player')", () => {
    expect(knownLocalMultiplayerIds(['1', '2', 'local-all', 'x'])).toEqual(['2', 'local-all'])
    expect(knownLocalMultiplayerIds(['party', 'so'])).toEqual(['party', 'so'])
    expect(knownLocalMultiplayerIds(['lan-party'])).toEqual(['lan-party'])
    expect(localMultiplayerLabel('lan-party')).toBe('L.A.N. Party')
  })
})
