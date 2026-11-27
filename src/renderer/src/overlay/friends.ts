/**
 * The Friends tab's sections and words (docs/home-overlay.md, "Friends"): pure, so they are tested without React.
 * Playing: online friends in a game; Online: every other online state (busy, away, snooze, looking to trade or to
 * play); Offline: the rest, most recently online first.
 */
import type { FriendPresence, SteamFriend } from '@shared/friends'
import { t } from '../i18n'

export interface FriendSections {
  playing: SteamFriend[]
  online: SteamFriend[]
  offline: SteamFriend[]
}

const byName = (a: SteamFriend, b: SteamFriend): number =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
  a.steamId.localeCompare(b.steamId)

export function friendSections(friends: readonly SteamFriend[]): FriendSections {
  const playing: SteamFriend[] = []
  const online: SteamFriend[] = []
  const offline: SteamFriend[] = []
  for (const f of friends) {
    if (f.presence === 'offline') offline.push(f)
    else if (f.game) playing.push(f)
    else online.push(f)
  }
  playing.sort(byName)
  online.sort(byName)
  // Most recently online first; friends Steam gives no time for go last, by name.
  offline.sort((a, b) => (b.lastOnlineAt ?? 0) - (a.lastOnlineAt ?? 0) || byName(a, b))
  return { playing, online, offline }
}

/** A status in the current language (built per call, so a language change shows at the next render). */
export function presenceWord(presence: FriendPresence): string {
  const words: Record<FriendPresence, string> = {
    offline: t('overlay.friends.presence.offline'),
    online: t('overlay.friends.presence.online'),
    busy: t('overlay.friends.presence.busy'),
    away: t('overlay.friends.presence.away'),
    snooze: t('overlay.friends.presence.snooze'),
    trade: t('overlay.friends.presence.trade'),
    play: t('overlay.friends.presence.play')
  }
  return words[presence] ?? words.online
}

/** "3 h ago", "25 min ago", "2 days ago", "just now". */
export function agoText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return t('overlay.friends.ago.justNow')
  const min = Math.floor(s / 60)
  if (min < 60) return t('overlay.friends.ago.minutes', { count: min })
  const h = Math.floor(min / 60)
  if (h < 24) return t('overlay.friends.ago.hours', { count: h })
  return t('overlay.friends.ago.days', { count: Math.floor(h / 24) })
}

/** An offline friend's detail line: "Last online 3 h ago", or "Offline" when Steam gives no time. */
export function lastOnlineText(friend: SteamFriend, now: number): string {
  return friend.lastOnlineAt
    ? t('overlay.friends.lastOnline', { ago: agoText(now - friend.lastOnlineAt) })
    : t('overlay.friends.presence.offline')
}

/** The tab's freshness line: "Updated just now", "Updated 12 s ago", "Updated 3 min ago". */
export function updatedText(fetchedAt: number, now: number): string {
  const s = Math.max(0, Math.floor((now - fetchedAt) / 1000))
  if (s < 5) return t('overlay.friends.updatedJustNow')
  if (s < 60) return t('overlay.friends.updatedSeconds', { count: s })
  return t('overlay.friends.updated', { ago: agoText(now - fetchedAt) })
}

/** The first letter of a name, for a friend without a picture. */
export function initialOf(name: string): string {
  const first = [...name.trim()][0]
  return first ? first.toUpperCase() : '?'
}
