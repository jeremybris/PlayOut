import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { SteamFriend, SteamFriendsStatus } from '@shared/friends'
import { createFriendsMock } from '../api/mock/friends'

// The store as a plain object (a server render reads a zustand store's initial state only).
const { state } = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))
vi.mock('./friendsStore', () => ({
  useFriendsStore: (select: (s: Record<string, unknown>) => unknown) => select(state)
}))

const { FriendList, FriendsTab, OFFLINE_PAGE } = await import('./FriendsTab')
const { friendSections } = await import('./friends')

const NOW = Date.UTC(2026, 10, 25, 12)

async function mockStatus(
  mode: 'empty' | 'private' | 'nokey' | null = null
): Promise<SteamFriendsStatus> {
  const mock = createFriendsMock({ mode, closeOverlay: async () => undefined, now: () => NOW })
  return mock.api.getSteamFriends()
}

function tab(status: SteamFriendsStatus | null, busy = false): string {
  for (const k of Object.keys(state)) delete state[k]
  Object.assign(state, {
    status,
    busy,
    refresh: async () => undefined,
    watch: () => () => undefined
  })
  return renderToStaticMarkup(<FriendsTab />)
}

/** The section titles and their counts, in order. */
const heads = (html: string): string[] =>
  [...html.matchAll(/ov-group__title">([^<]+)<\/h3><span class="ov-friends__count">(\d+)/g)].map(
    (m) => `${m[1]} ${m[2]}`
  )

describe('Friends tab', () => {
  // "Updated n s ago" reads the clock: the mock's answers are read at NOW.
  beforeAll(() => {
    vi.useFakeTimers({ now: NOW })
  })
  afterAll(() => {
    vi.useRealTimers()
  })

  it('shows the mock friends in Playing, Online and Offline, offline folded', async () => {
    const html = tab(await mockStatus())
    expect(heads(html)).toEqual(['Playing 3', 'Online 5', 'Offline 5'])
    // Playing: name and game, by name.
    expect(html.indexOf('Aurora')).toBeLessThan(html.indexOf('Kestrel'))
    expect(html).toContain('Helldivers 2')
    expect(html).toContain('Stardew Valley')
    // Online: the status words.
    for (const word of ['Online', 'Busy', 'Away', 'Snooze', 'Looking to play']) {
      expect(html).toContain(`>${word}</span>`)
    }
    // Offline: folded behind a button, so none of them is drawn yet.
    expect(html).toContain('Show offline friends (5)')
    expect(html).not.toContain('Last online')
    expect(html).toContain('Updated just now')
    expect(html).toContain('Message')
    // Pictures only from Steam's https CDN, lazily.
    expect(html).toMatch(
      /<img src="https:\/\/avatars\.steamstatic\.com\/[^"]+" alt="" loading="lazy"/
    )
  })

  it('shows offline friends with their last online time when nobody is online', async () => {
    const status = await mockStatus()
    const offline = status.friends.filter((f) => f.presence === 'offline')
    const html = renderToStaticMarkup(<FriendList sections={friendSections(offline)} now={NOW} />)
    expect(heads(html)).toEqual(['Offline 5'])
    expect(html).toContain('Last online 25 min ago')
    expect(html).toContain('Last online 3 h ago')
    expect(html).toContain('Last online 40 days ago')
  })

  it('draws a long offline list a page at a time', () => {
    const offline: SteamFriend[] = Array.from({ length: 230 }, (_, i) => ({
      steamId: `765611980${String(i).padStart(8, '0')}`,
      name: `Friend ${String(i).padStart(3, '0')}`,
      presence: 'offline',
      lastOnlineAt: NOW - (i + 1) * 60_000
    }))
    const html = renderToStaticMarkup(<FriendList sections={friendSections(offline)} now={NOW} />)
    expect(html.match(/class="ov-friend /g)).toHaveLength(OFFLINE_PAGE)
    expect(html).toContain(`Show ${OFFLINE_PAGE} more`)
  })

  it('says it is loading, that there are no friends, or why the list could not be read', async () => {
    expect(tab(null, true)).toContain('Loading your Steam friends')
    expect(tab(await mockStatus('empty'))).toContain('No Steam friends')
    const priv = tab(await mockStatus('private'))
    expect(priv).toContain('set Friends List to Public')
    expect(priv).not.toContain('No Steam friends')
    const nokey = tab(await mockStatus('nokey'))
    expect(nokey).toContain('Add your Steam Web API key and SteamID64')
    // Without a key there is nothing to be "updated".
    expect(nokey).not.toContain('Updated')
  })
})
