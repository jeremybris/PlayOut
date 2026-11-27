import { friendsErrorText, type SteamFriend } from '@shared/friends'
import { MessageCircle, RefreshCw, UserX } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { api } from '../api/client'
import { Button } from '../components/Button'
import { useFocusableControl } from '../hooks/useFocusableControl'
import { useT } from '../i18n'
import { setFocus } from '../input/focus'
import { cx } from '../lib/cx'
import { createLog } from '../lib/log'
import { useUiStore } from '../state/ui'
import {
  friendSections,
  initialOf,
  lastOnlineText,
  presenceWord,
  updatedText,
  type FriendSections
} from './friends'
import { useFriendsStore } from './friendsStore'

const log = createLog('overlay-friends')

/** Offline friends drawn per "Show more" (a list of 200+ stays light: most of it is never drawn). */
export const OFFLINE_PAGE = 50
/** How often "Updated n s ago" is redrawn. */
const UPDATED_TICK_MS = 5000

/**
 * Friends tab (docs/home-overlay.md, "Friends"): the user's Steam friends, in a game first, then online, then
 * offline (folded away until asked for). Read when the tab opens and every 60 s while it stays open, never otherwise.
 * Each friend is one row: A opens Steam's own chat with them, after the overlay closes.
 */
export function FriendsTab(): ReactElement {
  const status = useFriendsStore((s) => s.status)
  const busy = useFriendsStore((s) => s.busy)
  const refresh = useFriendsStore((s) => s.refresh)
  const watch = useFriendsStore((s) => s.watch)
  const t = useT()
  useEffect(() => watch(), [watch])

  const sections = useMemo(() => friendSections(status?.friends ?? []), [status])
  const error = status?.error
  const listed = (status?.friends.length ?? 0) > 0

  return (
    <>
      <div className="ov-friends-bar">
        {status && error?.code !== 'no-credentials' ? (
          <UpdatedLine fetchedAt={status.fetchedAt} />
        ) : (
          <span />
        )}
        <Button
          focusKey="overlay:friends:refresh"
          icon={<RefreshCw />}
          aria-disabled={busy || undefined}
          onPress={() => {
            if (!busy) void refresh(true)
          }}
        >
          {busy && status ? t('overlay.friends.refreshing') : t('overlay.friends.refresh')}
        </Button>
      </div>
      {error ? (
        <div className="ov-note" role="alert">
          <UserX className="ov-note__icon" />
          <span className="ov-note__text">{friendsErrorText(error.code, t)}</span>
        </div>
      ) : null}
      {!status ? <p className="ov-hint">{t('overlay.friends.loading')}</p> : null}
      {status && !error && !listed ? <p className="ov-hint">{t('overlay.friends.none')}</p> : null}
      {listed && status ? <FriendList sections={sections} now={status.fetchedAt} /> : null}
    </>
  )
}

/**
 * "Updated 12 s ago", redrawn on its own so the list does not re-render with it. A fresh answer can be newer than the
 * last tick: updatedText reads that as "just now".
 */
function UpdatedLine({ fetchedAt }: { fetchedAt: number }): ReactElement {
  // updatedText reads the language itself; subscribing re-renders the line when it changes.
  useT()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), UPDATED_TICK_MS)
    return () => clearInterval(timer)
  }, [])
  return <span className="ov-hint">{updatedText(fetchedAt, now)}</span>
}

/**
 * The three sections in one list, so a friend moving between them (starting a game) keeps their row and the focus.
 * `now`: when the list was read, for the offline friends' "Last online" times.
 */
export function FriendList({
  sections,
  now
}: {
  sections: FriendSections
  now: number
}): ReactElement {
  const { playing, online, offline } = sections
  // With nobody online the offline friends are the list: shown straight away.
  const [showOffline, setShowOffline] = useState(false)
  const [offlineShown, setOfflineShown] = useState(OFFLINE_PAGE)
  const offlineOpen = showOffline || playing.length + online.length === 0
  const toast = useUiStore((s) => s.toast)
  const t = useT()

  const message = useCallback(
    (friend: SteamFriend) => {
      api.messageSteamFriend(friend.steamId).catch((err) => {
        log.error('messageSteamFriend failed', err)
        toast(t('overlay.friends.chatFailed'), 'error')
      })
    },
    [t, toast]
  )

  const rows: ReactElement[] = []
  const head = (key: string, title: string, count: number): void => {
    rows.push(
      <div key={`head:${key}`} className="ov-group__head ov-friends__head">
        <h3 className="ov-group__title">{title}</h3>
        <span className="ov-friends__count">{count}</span>
      </div>
    )
  }
  const row = (friend: SteamFriend, detail: string): void => {
    rows.push(
      <FriendRow key={friend.steamId} friend={friend} detail={detail} onMessage={message} />
    )
  }

  if (playing.length) {
    head('playing', t('overlay.friends.playing'), playing.length)
    for (const f of playing) row(f, f.game ?? '')
  }
  if (online.length) {
    head('online', t('overlay.friends.online'), online.length)
    for (const f of online) row(f, presenceWord(f.presence))
  }
  if (offline.length) {
    head('offline', t('overlay.friends.offline'), offline.length)
    if (offlineOpen) {
      for (const f of offline.slice(0, offlineShown)) row(f, lastOnlineText(f, now))
      const left = offline.length - offlineShown
      if (left > 0) {
        rows.push(
          <Button
            key="more"
            focusKey="overlay:friends:more"
            className="ov-friends__more"
            onPress={() => {
              setOfflineShown((n) => n + OFFLINE_PAGE)
              focusSoon(offline[offlineShown])
            }}
          >
            {t('overlay.friends.showMore', { count: Math.min(left, OFFLINE_PAGE) })}
          </Button>
        )
      }
    } else {
      rows.push(
        <Button
          key="show-offline"
          focusKey="overlay:friends:offline"
          className="ov-friends__more"
          onPress={() => {
            setShowOffline(true)
            focusSoon(offline[0])
          }}
        >
          {t('overlay.friends.showOffline', { count: offline.length })}
        </Button>
      )
    }
  }

  return (
    <div className="ov-friends" role="group" aria-label={t('overlay.friends.listLabel')}>
      {rows}
    </div>
  )
}

const rowKey = (friend: SteamFriend): string => `overlay:friends:${friend.steamId}`

/**
 * The button pressed to show more friends goes away (or moves below them): focus goes to the first friend it showed,
 * once that row has mounted, so the gamepad is never left without a focus.
 */
function focusSoon(friend: SteamFriend | undefined): void {
  if (friend) requestAnimationFrame(() => void setFocus(rowKey(friend)))
}

/** One friend: picture with a presence dot, name, what they play (or their status), and the Message hint. */
const FriendRow = memo(function FriendRow({
  friend,
  detail,
  onMessage
}: {
  friend: SteamFriend
  detail: string
  onMessage: (friend: SteamFriend) => void
}): ReactElement {
  const { ref, props } = useFocusableControl<HTMLButtonElement>({
    focusKey: rowKey(friend),
    onPress: () => onMessage(friend),
    scroll: { inline: 'nearest', block: 'nearest' }
  })
  const t = useT()
  const kind = friend.presence === 'offline' ? 'offline' : friend.game ? 'playing' : 'online'
  const dim = friend.presence === 'away' || friend.presence === 'snooze'
  return (
    <button
      ref={ref}
      type="button"
      className={cx('ov-friend', `ov-friend--${kind}`)}
      aria-label={t('overlay.friends.row', { name: friend.name, detail })}
      {...props}
    >
      <span className="ov-friend__avatar" aria-hidden="true">
        <Avatar key={friend.avatarUrl ?? ''} url={friend.avatarUrl} name={friend.name} />
        {kind === 'offline' ? null : (
          <span
            className={cx(
              'ov-friend__dot',
              `ov-friend__dot--${kind}`,
              dim && 'ov-friend__dot--dim'
            )}
          />
        )}
      </span>
      <span className="ov-friend__text">
        <span className="ov-friend__name u-truncate">{friend.name}</span>
        <span className="ov-friend__detail u-truncate">{detail}</span>
      </span>
      <span className="ov-friend__action" aria-hidden="true">
        <MessageCircle />
        {t('overlay.friends.message')}
      </span>
    </button>
  )
})

/** Steam's picture, or the name's first letter when there is none or it does not load. */
function Avatar({ url, name }: { url?: string; name: string }): ReactElement {
  const [failed, setFailed] = useState(false)
  if (!url || failed) return <span className="ov-friend__initial">{initialOf(name)}</span>
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  )
}
