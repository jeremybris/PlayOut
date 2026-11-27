// The overlay's Friends tab in the mock (main friends/steam-friends.ts): a made-up Steam friends list with friends in
// a game, online, busy, away, looking to play and offline, so every section of the tab shows. No network: the
// pictures are Steam's default avatar, or none (the tab draws the initial). `friends=empty` lists no friends,
// `friends=private` answers like a private friends list, `friends=nokey` like Settings without the Steam key.
import type { PlayOutApi } from '@shared/api'
import {
  friendsErrorText,
  STEAM_ID64,
  type FriendsErrorCode,
  type SteamFriend,
  type SteamFriendsStatus
} from '@shared/friends'
import { t } from '../../i18n'

export type FriendsApi = Pick<PlayOutApi, 'getSteamFriends' | 'messageSteamFriend'>

/** `friends=` in the query: the list's state in the preview. */
export type MockFriendsMode = 'empty' | 'private' | 'nokey' | null

export interface FriendsMockDeps {
  mode?: MockFriendsMode
  /** The overlay closes before Steam's chat opens (as main does). */
  closeOverlay: () => Promise<void>
  now?: () => number
  log?: (...args: unknown[]) => void
}

const DEFAULT_AVATAR =
  'https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_medium.jpg'
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** The sample friends; `ago` is how long ago an offline friend was last online. */
function sampleFriends(now: number): SteamFriend[] {
  const id = (n: number): string => `765611980${String(n).padStart(8, '0')}`
  const offline = (n: number, name: string, ago: number, avatar = false): SteamFriend => ({
    steamId: id(n),
    name,
    presence: 'offline',
    lastOnlineAt: now - ago,
    ...(avatar ? { avatarUrl: DEFAULT_AVATAR } : {})
  })
  return [
    {
      steamId: id(1),
      name: 'Kestrel',
      presence: 'online',
      game: 'Helldivers 2',
      gameId: '553850',
      avatarUrl: DEFAULT_AVATAR
    },
    { steamId: id(2), name: 'mossy_tim', presence: 'online', game: 'Hades II', gameId: '1145350' },
    {
      steamId: id(3),
      name: 'Aurora',
      presence: 'away',
      game: 'Stardew Valley',
      gameId: '413150'
    },
    { steamId: id(4), name: 'Big Lou', presence: 'online', avatarUrl: DEFAULT_AVATAR },
    { steamId: id(5), name: 'pixelwitch', presence: 'busy' },
    { steamId: id(6), name: 'Dario', presence: 'away' },
    { steamId: id(7), name: 'Nightjar', presence: 'play' },
    { steamId: id(8), name: 'snoozy', presence: 'snooze' },
    offline(9, 'Quinn', 3 * HOUR, true),
    offline(10, 'Teodora', 25 * MIN),
    offline(11, 'Hollis', 2 * DAY),
    offline(12, 'grumble', 40 * DAY),
    offline(13, 'Mira', 9 * HOUR)
  ]
}

export function createFriendsMock(deps: FriendsMockDeps): { api: FriendsApi } {
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => undefined)
  const error = (code: FriendsErrorCode): SteamFriendsStatus => ({
    friends: [],
    fetchedAt: now(),
    error: { code, message: friendsErrorText(code, t) }
  })
  return {
    api: {
      async getSteamFriends(options) {
        log(`getSteamFriends(${options?.refresh ? 'refresh' : ''})`)
        if (deps.mode === 'nokey') return error('no-credentials')
        if (deps.mode === 'private') return error('private')
        if (deps.mode === 'empty') return { friends: [], fetchedAt: now() }
        return { friends: sampleFriends(now()), fetchedAt: now() }
      },
      async messageSteamFriend(steamId) {
        if (typeof steamId !== 'string' || !STEAM_ID64.test(steamId)) {
          throw new Error('Not a SteamID64')
        }
        await deps.closeOverlay()
        log(`messageSteamFriend: Steam would open its chat (steam://friends/message/${steamId})`)
      }
    }
  }
}
