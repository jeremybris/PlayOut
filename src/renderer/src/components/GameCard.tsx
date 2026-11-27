import { artSourcesConfigured } from '@shared/art-sources'
import { playableHere, recompToPlay } from '@shared/recomp-play'
import type { Game, Platform } from '@shared/types'
import { Cast, Check, Download, Gamepad2, Hourglass, KeyRound, Pause, Plus } from 'lucide-react'
import { memo, useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import { useFocusableControl } from '../hooks/useFocusableControl'
import { useT } from '../i18n'
import { setFocus, type Direction } from '../input/focus'
import { cx } from '../lib/cx'
import { addGamesTileFocusKey, cardFocusKey } from '../lib/focusKeys'
import { displayTitle } from '../lib/library'
import { coverUrl } from '../lib/media'
import {
  isInstalledHere,
  queuePlaceText,
  queueStarting,
  useQueuePaused,
  useQueuePosition
} from '../state/installQueue'
import { installPercent, useInstallProgress } from '../state/installs'
import { useSettingsStore } from '../state/settings'
import { useRomDownload } from '../state/streaming'
import { useUiStore } from '../state/ui'
import { PlatformBadge, RecompBadge } from './PlatformBadge'

/** Mouse hover dwell before a card takes focus (design 6.8: prevents focus skipping while crossing cards). */
const CARD_HOVER_MS = 60

export interface GameCardProps {
  game: Game
  /** The row the card sits in; part of the focus key (lib/focusKeys.ts cardFocusKey). */
  rowId: string
  /** Platform row for the badge; the badge falls back to the platform id's initial when omitted. */
  platform?: Platform | null
  /** A / Enter / click / tap. */
  onSelect?: (game: Game) => void
  /** Called after the card received focus (the ui store's focusedGameId is updated first). */
  onFocus?: (game: Game) => void
  /** Return false to consume a direction before the focus engine moves (Home: down from the Recent row opens the Library). */
  onArrowPress?: (direction: Direction, game: Game) => boolean
  /** Override the default focus key (cardFocusKey(rowId, game.id)). */
  focusKey?: string
  /** Mark a favourite with the glow around its cover (default true). */
  showFavorite?: boolean
  /**
   * Copies of this game across stores (lib/copies.ts) when it stands for more than one: the count is drawn above
   * the store badge, which shows the store of the copy this card is.
   */
  copies?: number
  className?: string
}

/**
 * 2:3 cover card (240x360u) with the platform badge bottom-right; scales 1.10 with a white/accent ring and
 * shadow when focused (design 2.5 / 6.3). Without a cover it shows a placeholder with the title. Focusing
 * the card sets ui.focusedGameId so the hero follows it. An uninstalled game (owned through a store account,
 * or no longer found by a rescan) is greyed with a "Not installed" marker, and a tracked install draws a thin
 * progress bar along the bottom edge (its own store subscription, so only that card re-renders); a game waiting in
 * the install queue carries its place there instead of the marker (a pause glyph once paused). Memoised: a
 * focus change re-renders the focused and blurred cards only (through useFocusable), never the hundreds of
 * others in the library.
 */
export const GameCard = memo(function GameCard({
  game,
  rowId,
  platform,
  onSelect,
  onFocus,
  onArrowPress,
  focusKey,
  showFavorite = true,
  copies,
  className
}: GameCardProps): ReactElement {
  const t = useT()
  const setFocusedGame = useUiStore((s) => s.setFocusedGame)
  const cover = coverUrl(game)
  // The URL that failed to load; a new cover URL automatically gets another chance.
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null)
  const showCover = cover !== undefined && cover !== brokenUrl
  const title = displayTitle(game)
  // No cover and no sign-in art source (SteamGridDB, ScreenScraper, IGDB, TheGamesDB) set up: the placeholder says
  // where covers come from. Not for a paired host's game (its art is the host's), nor before the settings load.
  const signInForCover = useSettingsStore(
    (s) => cover === undefined && !game.remote && !!s.settings && !artSourcesConfigured(s.settings)
  )
  const install = useInstallProgress(game.installed ? null : game.id)
  // A host ROM downloading to this PC (Streaming) draws the same bar: started from the cover menu, it shows here.
  const romDownload = useRomDownload(game.id)
  const downloading = !!game.remote && romDownload?.state === 'downloading'
  const percent = downloading
    ? romDownload.bytesTotal > 0
      ? Math.max(0, Math.min(100, romDownload.percent))
      : null
    : installPercent(install)
  // 1 = next in the install queue; 0 (downloading now, the bar shows it) and null draw no badge.
  // An installed game of this PC is never treated as queued.
  const queuePosition = useQueuePosition(game.id, isInstalledHere(game))
  // Paused in the queue: the marker shows a pause glyph (with the place of a waiting game).
  const paused = useQueuePaused(queuePosition !== null ? game.id : null)
  // Its turn came but no progress yet (a store hand-off, a host ROM download resuming): an indeterminate bar, not
  // the "Not installed" marker.
  const starting = queueStarting(queuePosition, game.remote ? romDownload : install)
  const queuedText = queuePosition
    ? paused
      ? t('components.gameCard.pausedInQueue', { place: queuePlaceText(queuePosition) })
      : t('components.gameCard.queued', { place: queuePlaceText(queuePosition) })
    : ''

  // A favourite glows around its cover (components.css .card--favorite); nothing is drawn on the art itself.
  const favorite = showFavorite && game.favorite
  const key = focusKey ?? cardFocusKey(rowId, game.id)
  const { ref, props: controlProps } = useFocusableControl<HTMLDivElement>({
    focusKey: key,
    hoverDelayMs: CARD_HOVER_MS,
    onPress: () => onSelect?.(game),
    onFocus: () => {
      setFocusedGame(game.id)
      onFocus?.(game)
    },
    onArrowPress: onArrowPress ? (direction) => onArrowPress(direction, game) : undefined
  })

  return (
    <div
      ref={ref}
      className={cx(
        'card',
        !playableHere(game) && 'card--uninstalled',
        favorite && 'card--favorite',
        className
      )}
      role="button"
      aria-label={favorite ? t('components.gameCard.favourite', { title }) : title}
      data-favorite={favorite ? 'true' : undefined}
      data-game-id={game.id}
      data-card-key={key}
      {...controlProps}
      onContextMenu={(event) => {
        // Right click: the options menu Y opens for a controller (cover menu).
        event.preventDefault()
        // Focus this card first: the menu gives focus back to the card it opened on, not one focused earlier.
        void setFocus(key).then(() =>
          useUiStore.getState().setCoverMenu({ gameId: game.id, focusKey: key })
        )
      }}
    >
      {showCover ? (
        <img
          className="card__cover"
          src={cover}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setBrokenUrl(cover)}
        />
      ) : (
        <div className="card__placeholder">
          <Gamepad2 className="card__placeholder-icon" aria-hidden="true" />
          {signInForCover ? (
            <span
              className="card__placeholder-notice"
              title={t('components.gameCard.coverSignInTitle')}
              data-testid="cover-sign-in"
            >
              <KeyRound aria-hidden="true" />
              <span>{t('components.gameCard.coverSignIn')}</span>
            </span>
          ) : null}
          <span className="card__placeholder-title">{title}</span>
        </div>
      )}
      {game.completed ? (
        <span
          className="card__completed"
          aria-label={t('components.gameCard.completed')}
          title={t('components.gameCard.completed')}
        >
          <Check strokeWidth={3} />
        </span>
      ) : null}
      {queuePosition ? (
        <span
          className="card__marker card__marker--queued"
          aria-label={queuedText}
          title={queuedText}
        >
          {paused ? <Pause /> : <Hourglass />}
          <span>{queuePosition}</span>
        </span>
      ) : queuePosition === 0 && paused ? (
        // The store install PlayOut cannot pause, marked paused (its bar keeps the store's progress).
        <span
          className="card__marker"
          aria-label={t('components.gameCard.paused')}
          title={t('components.gameCard.paused')}
        >
          <Pause />
        </span>
      ) : game.remote ? (
        // A paired host's game (Streaming): it streams or downloads from there, so not "Not installed".
        <span
          className="card__marker card__marker--remote"
          aria-label={t('components.gameCard.remoteLabel', { host: game.remote.hostName })}
          title={t('components.gameCard.remoteTitle', { host: game.remote.hostName })}
        >
          <Cast />
        </span>
      ) : !playableHere(game) ? (
        <span
          className="card__marker"
          aria-label={t('components.gameCard.notInstalled')}
          title={t('components.gameCard.notInstalled')}
        >
          <Download />
        </span>
      ) : null}
      {/* A recompilation of it is installed: the Recomp badge stands in for the platform's. */}
      {recompToPlay(game) ? (
        <RecompBadge className="card__badge" />
      ) : (
        <PlatformBadge
          platform={platform}
          icon={platform ? undefined : game.platformId}
          name={platform?.name ?? game.platformId}
          className="card__badge"
        />
      )}
      {copies && copies > 1 ? (
        <span
          className="card__copies"
          aria-label={t('components.gameCard.copies', { count: copies })}
          title={t('components.gameCard.copies', { count: copies })}
        >
          {copies}
        </span>
      ) : null}
      {starting ? (
        <span
          className="card__progress card__progress--indeterminate"
          role="progressbar"
          aria-label={t('components.gameCard.starting')}
        />
      ) : downloading || (install && install.state !== 'failed') ? (
        <span
          className={cx('card__progress', percent === null && 'card__progress--indeterminate')}
          style={percent === null ? undefined : ({ '--p': percent } as CSSProperties)}
          role="progressbar"
          aria-label={
            downloading
              ? t('components.gameCard.downloading')
              : (install?.message ?? t('components.gameCard.installing'))
          }
          aria-valuenow={percent ?? undefined}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      ) : null}
    </div>
  )
})

export interface AddGamesTileProps {
  /** The row the tile sits in; the focus key is addGamesTileFocusKey(rowId). */
  rowId: string
  onSelect: () => void
  label?: string
  autoFocus?: boolean
  /** Return false to consume a direction before the focus engine moves. */
  onArrowPress?: (direction: Direction) => boolean
  className?: string
}

/** The dashed "Add games" tile (design 6.10), card-sized so it sits in a Row like a GameCard. */
export function AddGamesTile({
  rowId,
  onSelect,
  label,
  autoFocus,
  onArrowPress,
  className
}: AddGamesTileProps): ReactElement {
  const t = useT()
  const text = label ?? t('components.gameCard.addGames')
  const {
    ref,
    props: controlProps,
    focusSelf
  } = useFocusableControl<HTMLDivElement>({
    focusKey: addGamesTileFocusKey(rowId),
    hoverDelayMs: CARD_HOVER_MS,
    onPress: onSelect,
    onArrowPress
  })
  useEffect(() => {
    if (autoFocus) focusSelf()
    // on mount only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div
      ref={ref}
      className={cx('card', 'card--tile', className)}
      role="button"
      aria-label={text}
      {...controlProps}
    >
      <Plus aria-hidden="true" />
      <span>{text}</span>
    </div>
  )
}
