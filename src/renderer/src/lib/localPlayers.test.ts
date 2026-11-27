import { describe, expect, it } from 'vitest'
import { localPlayersShown, MAX_LOCAL_PLAYERS } from './localPlayers'

describe('localPlayersShown', () => {
  it('shows LaunchBox counts up to eight, nothing for online-sized counts or none', () => {
    expect(MAX_LOCAL_PLAYERS).toBe(8)
    expect(localPlayersShown({ localPlayers: { max: 1 } })).toBe(1)
    expect(localPlayersShown({ localPlayers: { max: 4, coop: true } })).toBe(4)
    expect(localPlayersShown({ localPlayers: { max: 8 } })).toBe(8)
    expect(localPlayersShown({ localPlayers: { max: 16 } })).toBeUndefined()
    expect(localPlayersShown({ localPlayers: { max: 64 } })).toBeUndefined()
    expect(localPlayersShown({ localPlayers: { missedAt: 'T' } })).toBeUndefined()
    expect(localPlayersShown({})).toBeUndefined()
  })
})
