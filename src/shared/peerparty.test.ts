import { describe, expect, it } from 'vitest'
import {
  isXbox360BackwardCompatible,
  PEERPARTY_BLOCK_TAGS,
  PEERPARTY_MULTIPLAYER_TAGS,
  peerPartyBlockTags,
  peerPartyHasMultiplayer,
  peerPartyKernelAntiCheat
} from './peerparty'
import type { Game } from './types'

const meta = (m: Partial<Game['metadata']>): Pick<Game, 'metadata'> => ({
  metadata: m as Game['metadata']
})

describe('PeerParty tags', () => {
  it('blocks Free to Play, Competitive, eSports and MMO, but not a plain PvP tag', () => {
    expect(PEERPARTY_BLOCK_TAGS).toContain('Free to Play')
    expect(PEERPARTY_BLOCK_TAGS).not.toContain('PvP')
    // TowerFall, Spelunky 2, Age of Mythology: PvP and LAN-friendly, no anti-cheat.
    expect(
      peerPartyBlockTags(meta({ steamTags: { tags: ['pvp', 'Online Co-Op'] } } as never))
    ).toEqual([])
    expect(
      peerPartyBlockTags(meta({ steamTags: { tags: ['PvP', 'Competitive'] } } as never))
    ).toEqual(['Competitive'])
    expect(peerPartyBlockTags(meta({ tags: ['Free To Play'] }))).toEqual(['Free to Play'])
    expect(peerPartyBlockTags(meta({ steamTags: { tags: ['Online Co-Op'] } } as never))).toEqual([])
  })

  it('blocks competitive genres and tags of games with no Steam tags', () => {
    expect(peerPartyBlockTags(meta({ genres: ['Shooter', 'PvP'] }))).toEqual([])
    expect(peerPartyBlockTags(meta({ tags: ['eSports', 'MMO'] }))).toEqual(['eSports', 'MMO'])
    expect(peerPartyBlockTags(meta({ genres: ['Massively Multiplayer'] }))).toEqual([
      'Massively Multiplayer'
    ])
  })

  it('knows the Call of Duty games whose Ricochet anti-cheat leaves no files, and no others', () => {
    for (const t of [
      'Call of Duty®',
      'Call of Duty HQ',
      'Call of Duty: Modern Warfare',
      'Call of Duty®: Modern Warfare® II',
      'Call of Duty®: Modern Warfare® III',
      'Call of Duty: Black Ops Cold War',
      'Call of Duty®: Black Ops 6',
      'Call of Duty: Vanguard',
      'Call of Duty: Warzone'
    ])
      expect(peerPartyKernelAntiCheat(t), t).toBe('Ricochet')
    for (const t of [
      'Call of Duty (2003)',
      'Call of Duty: United Offensive',
      'Call of Duty 4: Modern Warfare',
      'Call of Duty: Modern Warfare Remastered',
      'Call of Duty: Black Ops',
      'Call of Duty: World at War',
      'Factorio'
    ])
      expect(peerPartyKernelAntiCheat(t), t).toBeNull()
  })

  it("tells an Xbox 360 game in Windows' emulator from an Xbox app PC game", () => {
    const xbox = (externalId: string): Pick<Game, 'source' | 'externalId'> => ({
      source: 'xbox',
      externalId
    })
    expect(
      isXbox360BackwardCompatible(
        xbox('Xbox360BackwardCompatibil.PrimaryConkerLiveReloade_ksqcvrsvwz2jp')
      )
    ).toBe(true)
    expect(
      isXbox360BackwardCompatible(
        xbox('SomeGame_8wekyb3d8bbwe'),
        'C:\\XboxGames\\Conker\\Content\\EmuMenu\\EmuMenu.exe'
      )
    ).toBe(true)
    expect(
      isXbox360BackwardCompatible(
        xbox('Microsoft.Halo_8wekyb3d8bbwe'),
        'C:\\XboxGames\\Halo\\Content\\halo.exe'
      )
    ).toBe(false)
    expect(
      isXbox360BackwardCompatible({ source: 'steam', externalId: '1' }, 'C:\\g\\EmuMenu.exe')
    ).toBe(false)
  })

  it('finds multiplayer from any tag list, case-insensitively', () => {
    expect(PEERPARTY_MULTIPLAYER_TAGS).toContain('Online Co-Op')
    expect(PEERPARTY_MULTIPLAYER_TAGS).toContain('LAN')
    expect(new Set(PEERPARTY_MULTIPLAYER_TAGS).size).toBe(PEERPARTY_MULTIPLAYER_TAGS.length)
    expect(peerPartyHasMultiplayer(meta({ genres: ['multiplayer'] }))).toBe(true)
    expect(peerPartyHasMultiplayer(meta({ genres: ['Puzzle'] }))).toBe(false)
  })
})
