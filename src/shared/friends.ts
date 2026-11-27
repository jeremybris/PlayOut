// The overlay's Friends tab (docs/home-overlay.md, "Friends"): the user's Steam friends and what they play, read
// with the Steam Web API key and SteamID64 of Settings › Metadata (main/friends/steam-friends.ts). Messaging opens
// Steam's own chat (steam://friends/message/<id>); PlayOut has no chat of its own.

import type { Translate } from './i18n'

/** Steam's `personastate`, as words the tab can show. */
export type FriendPresence = 'offline' | 'online' | 'busy' | 'away' | 'snooze' | 'trade' | 'play'

export interface SteamFriend {
  /** SteamID64: 17 digits. */
  steamId: string
  name: string
  /** Steam's CDN picture (https only); absent when Steam gave none or it was not an https Steam URL. */
  avatarUrl?: string
  presence: FriendPresence
  /** The game being played (Steam's `gameextrainfo`); set only while the friend is online and in a game. */
  game?: string
  /** Steam's `gameid` of that game (an app id, or a long id for a non-Steam shortcut). */
  gameId?: string
  /** When the friend was last online (Steam's `lastlogoff`, ms since the epoch); absent when Steam does not say. */
  lastOnlineAt?: number
}

/**
 * Why the list could not be read: `no-credentials` (no key or SteamID64 in Settings), `private` (Steam answered 401:
 * the friends list is not public), `key-refused` (403: Steam refused the key), `network` (anything else).
 */
export type FriendsErrorCode = 'no-credentials' | 'private' | 'key-refused' | 'network'

export interface FriendsError {
  code: FriendsErrorCode
  /** A sentence for the user. */
  message: string
}

export interface SteamFriendsStatus {
  /** The friends Steam listed (empty on an error). */
  friends: SteamFriend[]
  /** When this answer was read from Steam (ms since the epoch). */
  fetchedAt: number
  error?: FriendsError
}

/**
 * The sentence for an error code, in the caller's language (tMain in main, t in the renderer). The overlay shows it by
 * `code` in its own language, so a message main wrote before a language change is never shown stale.
 */
export function friendsErrorText(code: FriendsErrorCode, t: Translate): string {
  switch (code) {
    case 'no-credentials':
      return t('friends.errors.noCredentials')
    case 'private':
      return t('friends.errors.private')
    case 'key-refused':
      return t('friends.errors.keyRefused')
    case 'network':
      return t('friends.errors.network')
  }
}

/** A SteamID64: 17 digits. */
export const STEAM_ID64 = /^\d{17}$/

/** Steam's chat with one friend, opened by Steam itself. */
export function steamChatUri(steamId: string): string {
  if (!STEAM_ID64.test(steamId)) throw new Error('Not a SteamID64')
  return `steam://friends/message/${steamId}`
}
