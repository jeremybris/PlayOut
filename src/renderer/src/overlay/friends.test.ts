import { describe, expect, it } from 'vitest'
import type { SteamFriend } from '@shared/friends'
import {
  agoText,
  friendSections,
  initialOf,
  lastOnlineText,
  presenceWord,
  updatedText
} from './friends'

const f = (steamId: string, name: string, over: Partial<SteamFriend> = {}): SteamFriend => ({
  steamId,
  name,
  presence: 'online',
  ...over
})

describe('friend sections', () => {
  it('puts friends in a game first, other online states next, offline last', () => {
    const { playing, online, offline } = friendSections([
      f('1', 'zed', { game: 'Hades II' }),
      f('2', 'Amy', { game: 'Helldivers 2', presence: 'away' }),
      f('3', 'bob', { presence: 'busy' }),
      f('4', 'Ann', { presence: 'play' }),
      f('5', 'Old', { presence: 'offline', lastOnlineAt: 1000 }),
      f('6', 'New', { presence: 'offline', lastOnlineAt: 5000 }),
      f('7', 'Unknown', { presence: 'offline' })
    ])
    expect(playing.map((x) => x.name)).toEqual(['Amy', 'zed'])
    expect(online.map((x) => x.name)).toEqual(['Ann', 'bob'])
    expect(offline.map((x) => x.name)).toEqual(['New', 'Old', 'Unknown'])
  })

  it('words every status', () => {
    expect(
      (['online', 'busy', 'away', 'snooze', 'trade', 'play', 'offline'] as const).map(presenceWord)
    ).toEqual([
      'Online',
      'Busy',
      'Away',
      'Snooze',
      'Looking to trade',
      'Looking to play',
      'Offline'
    ])
  })

  it('says how long ago', () => {
    expect(agoText(30_000)).toBe('just now')
    expect(agoText(25 * 60_000)).toBe('25 min ago')
    expect(agoText(3 * 3600_000 + 59 * 60_000)).toBe('3 h ago')
    expect(agoText(26 * 3600_000)).toBe('1 day ago')
    expect(agoText(40 * 86400_000)).toBe('40 days ago')
    const now = 10 * 86400_000
    expect(lastOnlineText(f('1', 'a', { lastOnlineAt: now - 3 * 3600_000 }), now)).toBe(
      'Last online 3 h ago'
    )
    expect(lastOnlineText(f('1', 'a', { presence: 'offline' }), now)).toBe('Offline')
    expect(updatedText(now, now + 2000)).toBe('Updated just now')
    expect(updatedText(now, now + 12_000)).toBe('Updated 12 s ago')
    expect(updatedText(now, now + 3 * 60_000)).toBe('Updated 3 min ago')
  })

  it('draws an initial for a friend without a picture', () => {
    expect(initialOf(' kestrel')).toBe('K')
    expect(initialOf('')).toBe('?')
  })
})
