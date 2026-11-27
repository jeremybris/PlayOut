import type { Game } from '@shared/types'
import { describe, expect, it } from 'vitest'
import {
  isCompetitiveOnline,
  knownOnlineMultiplayerIds,
  matchesOnlineMultiplayer,
  ONLINE_ALL,
  ONLINE_CHOICES,
  onlineMultiplayerLabel
} from './onlineMultiplayer'

const tagged = (...tags: string[]): Game =>
  ({ metadata: { steamTags: { tags } } }) as unknown as Game

describe('Online Multiplayer filter', () => {
  it('lists All Online Multiplayer first, then its choices A to Z', () => {
    const labels = ONLINE_CHOICES.map((c) => c.label)
    expect(labels).toEqual([
      'All Online Multiplayer',
      'All Competitive',
      'All Cooperative',
      'eSports',
      'Massively Multiplayer',
      'PvP',
      'Team Based'
    ])
    const rest = labels.slice(1)
    expect([...rest].sort((a, b) => a.localeCompare(b))).toEqual(rest)
    expect(onlineMultiplayerLabel(ONLINE_ALL)).toBe('Online Multiplayer')
    expect(onlineMultiplayerLabel('pvp')).toBe('All Competitive')
  })

  it("All Cooperative takes Steam's Online Co-Op tag (any case)", () => {
    expect(matchesOnlineMultiplayer(tagged('Online Co-op'), 'coop')).toBe(true)
    expect(matchesOnlineMultiplayer(tagged('Local Co-Op'), 'coop')).toBe(false)
    expect(matchesOnlineMultiplayer(tagged('PvP'), 'coop')).toBe(false)
  })

  it('each tag choice takes its own Steam tag (Massively Multiplayer also MMO)', () => {
    const cases: [string, string][] = [
      ['mmo', 'Massively Multiplayer'],
      ['mmo', 'MMO'],
      ['team', 'Team-Based'],
      ['pvp', 'Competitive'],
      ['versus', 'PvP'],
      ['esports', 'eSports']
    ]
    for (const [id, tag] of cases)
      expect(matchesOnlineMultiplayer(tagged('Action', tag), id)).toBe(true)
    // All Competitive: Competitive, eSports, PvP, Team-Based and Massively Multiplayer.
    for (const tag of [
      'Competitive',
      'eSports',
      'PvP',
      'Team-Based',
      'Massively Multiplayer',
      'MMO'
    ])
      expect(matchesOnlineMultiplayer(tagged(tag), 'pvp')).toBe(true)
    expect(matchesOnlineMultiplayer(tagged('Online Co-Op'), 'pvp')).toBe(false)
  })

  it('All Online Multiplayer takes both, plus Team-Based and MMO', () => {
    for (const tag of [
      'Online Co-Op',
      'Competitive',
      'eSports',
      'PvP',
      'Team-Based',
      'MMO',
      'Massively Multiplayer'
    ])
      expect(matchesOnlineMultiplayer(tagged(tag), ONLINE_ALL)).toBe(true)
    expect(matchesOnlineMultiplayer(tagged('Singleplayer'), ONLINE_ALL)).toBe(false)
    // No Steam tags read: nothing matches.
    expect(matchesOnlineMultiplayer({ metadata: {} } as Game, ONLINE_ALL)).toBe(false)
  })

  it('drops saved choices it does not know', () => {
    expect(knownOnlineMultiplayerIds(['pvp', 'x', ONLINE_ALL])).toEqual(['pvp', ONLINE_ALL])
  })
})

describe('isCompetitiveOnline (the overlay never pauses these)', () => {
  it('is All Competitive: Competitive, eSports, PvP, Team-Based or Massively Multiplayer', () => {
    for (const tag of [
      'Competitive',
      'esports',
      'PvP',
      'Team-Based',
      'Massively Multiplayer',
      'MMO'
    ])
      expect(isCompetitiveOnline(tagged('Action', tag))).toBe(true)
    expect(isCompetitiveOnline(tagged('Online Co-Op', 'Action'))).toBe(false)
    expect(isCompetitiveOnline({ metadata: {} } as unknown as Game)).toBe(false)
  })
})
