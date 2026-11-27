import { knownWithoutRetroAchievements } from '@shared/ra-consoles'
import type {
  Game,
  InstallProgress,
  RemoteGameInfo,
  RomDownloadProgress,
  StreamSession
} from '@shared/types'
import {
  Cast,
  ChevronDown,
  CircleStop,
  Download,
  Gauge,
  Heart,
  Pencil,
  Play,
  Star,
  RotateCcw,
  X
} from 'lucide-react'
import { type CSSProperties, type ReactElement, type RefObject, useEffect, useRef } from 'react'
import { Chip } from '../../components/Chip'
import { setFocus } from '../../input/focus'
import { Divider } from '../../components/Divider'
import { IconButton } from '../../components/IconButton'
import { StarRating } from '../../components/StarRating'
import { Stat } from '../../components/Stat'
import { FeatureGrid } from './FeatureGrid'
import {
  FEATURE_FOCUS,
  featuresWaitForPlay,
  presentFeatures,
  type CoopFeature,
  type PeerPartyFeature,
  type RecompFeature,
  type UpgradeFeature
} from './features'
import { PlayersStat } from './PlayersStat'
import { playersOf } from '../../lib/players'
import { COMPACT, dropClass, useDropToFit } from '../../hooks/useDropToFit'
import { useFocusableControl } from '../../hooks/useFocusableControl'
import { useT } from '../../i18n'
import { cx } from '../../lib/cx'
import { formatPlayVsBeat, formatReviewScore, reviewScoreLabel } from '../../lib/format'
import { reviewScoreOf } from '../../lib/reviews'
import { hltbUsesSolo } from '../../lib/hltb'
import { installSizeText } from '../../lib/installSize'
import {
  downloadRunning,
  hostOfflineWait,
  remotePrimaryAction,
  remoteSizeText,
  romDownloadProgressView,
  streamActive,
  streamBusy,
  streamBusyLabel,
  type ProgressView
} from '../../lib/streaming'
import { useIsFavorite } from '../../state/favorite'
import {
  QUEUE_STARTING_VIEW,
  queuePausedText,
  queuePlaceText,
  queueStarting
} from '../../state/installQueue'
import { formatBytes, installPercent, installStalled } from '../../state/installs'
import { useSettingsStore } from '../../state/settings'
import { NO_ROM_FOLDER_TEXT, useStreamingStore } from '../../state/streaming'

/** Focus key of the Play / Install button (the panel's preferred child; the progress block reuses it). */
export const PLAY_FOCUS_KEY = 'detail:play'
/** Focus key of the ACHIEVEMENTS stat (the achievements list returns focus to it). */
export const ACHIEVEMENTS_FOCUS_KEY = 'detail:achievements'

/** Focus keys of the bar's controls; the four-square grid's (features, recomp, upgrade, coop, peerParty) come from features.ts. */
const BAR_FOCUS = {
  play: PLAY_FOCUS_KEY,
  playMenu: 'detail:play-menu',
  achievements: ACHIEVEMENTS_FOCUS_KEY,
  edit: 'detail:edit',
  gauge: 'detail:gauge',
  favorite: 'detail:favorite',
  ...FEATURE_FOCUS
} as const

export interface ActionBarProps {
  game: Game
  /** The game is being tracked as running: Play reads "Running" and is disabled. */
  running: boolean
  /** The game's source has a store client that can install it (every store source; never manual / rom). */
  canInstall: boolean
  /** The tracked background install of this game, while one exists (state/installs.ts). */
  install: InstallProgress | undefined
  menuOpen: boolean
  achievementsOpen: boolean
  onPlay: () => void
  /**
   * Co-Op (Nucleus Co-op split-screen): set for a game with a Co-Op handler; the bottom-left square of the grid right
   * of Play (FeatureGrid). `busy` while a Co-Op session is being prepared.
   */
  coop?: CoopFeature
  /**
   * Upgrades (PC games, main upgrades/): the sparkles square (top right of the grid), opening the Upgrade menu
   * anchored to the grid. `open` while that menu is shown.
   */
  upgrade?: UpgradeFeature
  /**
   * Recompilations (main/recomp): the game has a native PC port. The UP-arrow square (top left of the grid):
   * 'available' opens the Recompilation page, 'installed' starts the chosen recompilation, 'busy' while one installs
   * or updates (it opens the page, which shows the progress). `label` is its tooltip and accessible name.
   */
  recomp?: RecompFeature
  /** PeerParty (main/peerparty): LAN play for an eligible installed game; the bottom-right square of the grid. */
  peerParty?: PeerPartyFeature
  /**
   * The game's recompilation stands in for it (its game file is gone: shared/recomp-play recompInPlaceOf): Play is
   * shown, and starts it, even though the game is not installed.
   */
  playsRecomp?: boolean
  /** Install (or retry a failed install) through the store client. */
  onInstall: () => void
  /**
   * Set while the game is in the install queue (state/installQueue.ts): its place (0 = downloading now, 1 = next),
   * the game being downloaded now, and taking it out of the queue. A waiting game shows "Unqueue" (Remove from queue) in
   * Install's / Download's place; the active one before its first progress shows "Starting…" (the menu stops it).
   * `waitingFor`: why it is held back (InstallQueueEntry.waitingFor, e.g. its host is offline), said in the queue note.
   * `paused`: the user paused it (InstallQueueEntry.paused): "Resume" (onResume) takes the Play slot and the note says
   * "Paused" (the active store install, which PlayOut cannot pause, adds "Pause it in <from> too").
   * Ignored for a game installed on this PC: Play always wins.
   */
  queued?: {
    position: number
    after?: string
    waitingFor?: string
    paused?: boolean
    from?: string
    onRemove: () => void
    onResume?: () => void
  }
  /**
   * Streaming (ARCHITECTURE.md §4.13). `session`: this game's stream, any game (a host-only one, or this PC's own
   * started from "Stream from <host>"). `download`: a host ROM's download into this PC's ROM folder.
   */
  streaming?: {
    session: StreamSession | null
    download: RomDownloadProgress | null
    onStream: () => void
    onStop: () => void
    onDownload: () => void
    /**
     * A recompilation-only game whose original a paired PC has (RemoteLibrary.recompSources): Download takes Play's
     * place (it gives the recompilation the original's files; UP still starts the recompilation), with the download's
     * progress as a host-only game's.
     */
    hostCopy?: RemoteGameInfo
  }
  /** The split button element, so the panel can open the play menu from X as well as from the chevron. */
  playRef: RefObject<HTMLDivElement | null>
  /** Open the play menu anchored to the split button (its element is passed for positioning). */
  onOpenMenu: (anchor: HTMLElement) => void
  onToggleAchievements: () => void
  /** The pen: the Edit sheet (metadata corrections and the game's own settings). */
  onOpenEdit: () => void
  onOpenQuickPanel: () => void
  onToggleFavorite: () => void
}

/**
 * The dark strip along the bottom of the detail panel (design 3.4): Play split button, the four-square grid of the
 * game's extra features (Recompilation, Upgrade, Co-Op, PeerParty: FeatureGrid), play-time and
 * achievement stats, a divider, the three HowLongToBeat stats and the pen (Edit) / gauge / star icon buttons.
 * For a game that is not installed the Play part is an Install button of the same size (or a "Not
 * installed" chip when no store client can install it), and while an install is tracked it becomes a
 * progress block: percent and bytes when measurable, an indeterminate bar with the tracker's message
 * otherwise; a failed install shows its message with a Retry button. A paired host's game (Streaming) has Stream
 * (PC games) or Download (ROMs, with the download's progress in the same block) there instead, and any game being
 * streamed shows "Connecting…" and then "Stop streaming". A game waiting in the install queue shows its place beside
 * an "Unqueue" button; a paused one "Resume" beside "Paused". Every variant registers the Play focus key.
 */
export function ActionBar({
  game,
  running,
  canInstall,
  install,
  menuOpen,
  achievementsOpen,
  onPlay,
  coop,
  recomp,
  upgrade,
  peerParty,
  playsRecomp,
  onInstall,
  queued: queuedProp,
  streaming,
  playRef,
  onOpenMenu,
  onToggleAchievements,
  onOpenEdit,
  onOpenQuickPanel,
  onToggleFavorite
}: ActionBarProps): ReactElement {
  const t = useT()
  const hostCopy = streaming?.hostCopy
  const favorite = useIsFavorite(game.id)
  const meta = game.metadata
  const totalMinutes = game.playtimeMinutes + (game.storePlaytimeMinutes ?? 0)
  // A paired host's game: this PC has no record of it, so nothing that writes the game (its settings) is offered.
  // Its favourite is its host's (offered while the favourites sync is on), and so are its achievements: shown when
  // the host's offer has its counts, the list comes from the host.
  const remote = !!game.remote
  const canStar = useSettingsStore((s) => !remote || (s.settings?.streaming.syncFavorites ?? true))
  // An installed game of this PC keeps Play whatever the queue still says (its entry leaves it a moment later).
  const queued = game.installed && !remote ? undefined : queuedProp
  // ROMs: RetroAchievements takes the place of store achievements (its list says how to sign in when needed); left
  // out for a ROM (a recompilation's game too) known to have none: its system has none, or the RetroAchievements
  // sync found none for it.
  const isRom = game.source === 'rom'
  const showAchievements =
    meta.achievements !== undefined ||
    (!remote && (game.source === 'steam' || (isRom && !knownWithoutRetroAchievements(game))))
  // The list open when the sync finds the game has none: it closes, and focus goes to Play (its stat is gone).
  // Once per opening: the toggle flips, so a second call would open it again.
  const closedFor = useRef(false)
  useEffect(() => {
    if (!achievementsOpen) {
      closedFor.current = false
      return
    }
    if (showAchievements || closedFor.current) return
    closedFor.current = true
    onToggleAchievements()
    void setFocus(PLAY_FOCUS_KEY)
  }, [achievementsOpen, showAchievements, onToggleAchievements])
  const achievementsValue = meta.achievements
    ? `${meta.achievements.unlocked}/${meta.achievements.total}`
    : '—'
  // A `done` install whose library refresh has not landed yet counts as installed: Play (disabled until the
  // snapshot confirms) rather than a flash of the Install button that a held A press would activate.
  const justInstalled = !game.installed && install?.state === 'done'
  const tracking =
    !game.installed && !justInstalled && install !== undefined && install.state !== 'failed'
  const failed = !game.installed && install?.state === 'failed'
  const size =
    remoteSizeText(hostCopy ? { source: game.source, remote: hostCopy } : game) ??
    installSizeText(game)
  // The size a game takes, shown only on its Install / Download button, on a smaller second line under the action
  // ("Install" / "45 GB"; an estimate "~45 GB"), never for an installed game. Unknown or still being measured: the
  // plain button.
  const sizeOnButton =
    size && size.value !== '—'
      ? size.estimate
        ? `~${size.value.replace(/^About\s+/i, '')}`
        : size.value
      : null
  const sizeAria = (action: string): string => {
    if (!sizeOnButton) return action
    const vars = { action, size: sizeOnButton.replace(/^~/, '') }
    return size!.estimate
      ? t('gameDetail.bar.sizeAriaEstimate', vars)
      : t('gameDetail.bar.sizeAria', vars)
  }

  // Streaming: a stream that is starting or running takes the slot whatever the game is; a host-only game gets
  // Stream or Download (a running download shows as the install progress does) in Install's place.
  const session = streaming?.session ?? null
  const connecting = session !== null && streamBusy(session)
  const live = session !== null && streamActive(session)
  const remoteAction = remotePrimaryAction(game)
  const download = remote || hostCopy ? (streaming?.download ?? null) : null
  // Download is this game's main action: a host-only ROM, or a recompilation-only game's original on a paired PC.
  const downloadAction = (remote && remoteAction === 'download') || !!hostCopy
  const downloading = download !== null && downloadRunning(download)
  const downloadFailed = download?.state === 'failed'
  // A stream that failed keeps its reason here (its toast fades), like a failed download or install.
  const streamFailed = session?.state === 'error'
  // The first stream downloads Moonlight while it prepares: the busy label shows that.
  const moonlight = useStreamingStore((s) => s.status?.client.moonlight)
  // Download with no ROM folder opens Settings > Library (state/streaming.ts); the line says why beforehand.
  const romFolderMissing = useSettingsStore((s) => !!s.settings && !s.settings.library.romsRoot)
  const offersDownload = downloadAction && !downloading && !download
  // In the queue: waiting for its turn, or its turn came with no progress yet (never Install / Download then).
  const waitingInQueue = !!queued && queued.position > 0
  const starting = queueStarting(queued?.position, remote || hostCopy ? download : install)
  // A ROM whose host cannot be reached keeps its place in the queue (main's waitingFor: "Waiting for <host>…"; until
  // that arrives, the download's own 'failed' event saying so): a queue note, not a failure (no Retry: it restarts by
  // itself when the host answers again).
  const waitingForHost = waitingInQueue
    ? (queued.waitingFor ?? hostOfflineWait(download))
    : undefined
  const failure = starting
    ? undefined
    : streamFailed
      ? session.message || t('gameDetail.bar.streamFailed', { host: session.hostName })
      : downloadFailed && !waitingForHost
        ? download.message
        : failed
          ? install?.message
          : offersDownload && romFolderMissing
            ? NO_ROM_FOLDER_TEXT
            : remote && game.remote?.offline && !waitingForHost
              ? t('gameDetail.bar.hostOffline', { host: game.remote.hostName })
              : undefined
  // Paused by the user: what it reached (a paused ROM download keeps it; a store install goes on in the store).
  const paused = !!queued?.paused
  const pausedAt =
    remote || hostCopy
      ? download?.state === 'paused' && download.bytesTotal > 0
        ? download.percent
        : null
      : installPercent(install)
  const placeText = queued
    ? queued.after
      ? t('gameDetail.bar.placeAfter', {
          place: queuePlaceText(queued.position),
          title: queued.after
        })
      : queuePlaceText(queued.position)
    : ''
  // A failure says more than the queue's place: a retried game that waits again shows the place once it is cleared.
  const queueNote =
    queued && paused && !failure
      ? [
          queuePausedText(
            {
              kind: remote || hostCopy ? 'host-rom' : 'store',
              state: waitingInQueue ? 'waiting' : 'active',
              from:
                queued.from ??
                game.remote?.hostName ??
                hostCopy?.hostName ??
                t('gameDetail.bar.theStore')
            },
            pausedAt
          ),
          waitingInQueue ? placeText : ''
        ]
          .filter(Boolean)
          .join(' · ')
      : queued && waitingInQueue && !failure
        ? `${waitingForHost ?? t('gameDetail.bar.queued')} · ${placeText}`
        : undefined

  // The stats after Play time are left out from the right (Players, then the review
  // score; Play time / Main story never) only as far as the bar is too narrow for them, measured with what they show: a long score
  // label takes room, a short one gives it back.
  const solo = hltbUsesSolo(game)
  const beatHours = solo ? meta.hltb?.solo : meta.hltb?.main
  // Play time against How Long To Beat's time ('12.5 / 59 Hrs'): how close the player is to beating it.
  const hasBeat = typeof beatHours === 'number' && Number.isFinite(beatHours) && beatHours > 0
  const playLabel = !hasBeat
    ? t('gameDetail.stats.playTime')
    : solo
      ? t('gameDetail.stats.playTimeVsSolo')
      : t('gameDetail.stats.playTimeVsMain')
  const playValue = formatPlayVsBeat(totalMinutes, beatHours)
  // Their short forms, for a compact row (useDropToFit): 'Played / Main', '179 / 53 Hrs'.
  const playLabelShort = !hasBeat
    ? playLabel
    : solo
      ? t('gameDetail.stats.playedVsSolo')
      : t('gameDetail.stats.playedVsMain')
  const playValueShort = formatPlayVsBeat(totalMinutes, beatHours, true)
  // Steam games: players online now against the all-time peak.
  const players = game.source === 'steam' ? playersOf(meta) : null
  const ratingLabel = reviewScoreLabel()
  const ratingValue = formatReviewScore(reviewScoreOf(meta), meta.reviewScore?.source)
  const ratingSource = meta.reviewScore?.source === 'igdb' ? 'IGDB' : 'Steam'
  const statsRef = useRef<HTMLDivElement>(null)
  const fit = useDropToFit(
    statsRef,
    [
      playLabel,
      playValue,
      playValueShort,
      showAchievements ? achievementsValue : '',
      players ? `${players.current}/${players.peak}` : '',
      ratingLabel,
      ratingValue,
      sizeOnButton ?? '',
      failure ?? '',
      queueNote ?? '',
      presentFeatures({ recomp, upgrade, coop, peerParty })
    ].join('|')
  )

  return (
    <div className="gdetail__bar" role="toolbar" aria-label={t('gameDetail.bar.label')}>
      {session && connecting && streaming ? (
        // Pressable: it cancels (Moonlight's pairing and the host's start can take a while).
        <PlaySplitButton
          label={streamBusyLabel(session, moonlight)}
          ariaLabel={t('gameDetail.bar.pressToCancel', {
            status: streamBusyLabel(session, moonlight)
          })}
          icon={<CircleStop aria-hidden="true" />}
          menuOpen={menuOpen}
          onPress={streaming.onStop}
          playRef={playRef}
          onOpenMenu={onOpenMenu}
        />
      ) : live && streaming ? (
        <PlaySplitButton
          label={t('gameDetail.bar.stopStreaming')}
          icon={<CircleStop aria-hidden="true" />}
          running
          menuOpen={menuOpen}
          onPress={streaming.onStop}
          playRef={playRef}
          onOpenMenu={onOpenMenu}
        />
      ) : queued && paused && queued.onResume ? (
        // Paused (waiting, or the store install PlayOut cannot pause): Resume; the note says it is paused.
        <PlaySplitButton
          label={t('gameDetail.bar.resume')}
          ariaLabel={t('gameDetail.bar.resumeDownload')}
          icon={<Play aria-hidden="true" />}
          menuOpen={menuOpen}
          onPress={queued.onResume}
          playRef={playRef}
          onOpenMenu={onOpenMenu}
        />
      ) : queued && waitingInQueue ? (
        // "Unqueue" fits the Play slot; the note beside it says what the game waits for.
        <PlaySplitButton
          label={t('gameDetail.bar.unqueue')}
          ariaLabel={t('gameDetail.bar.removeFromQueue')}
          icon={<X aria-hidden="true" />}
          menuOpen={menuOpen}
          onPress={queued.onRemove}
          playRef={playRef}
          onOpenMenu={onOpenMenu}
        />
      ) : starting ? (
        // Its turn came; the first progress has not (a store hand-off, a host ROM download resuming).
        <InstallProgressBlock
          install={QUEUE_STARTING_VIEW}
          menuOpen={menuOpen}
          playRef={playRef}
          onOpenMenu={onOpenMenu}
        />
      ) : download && downloading ? (
        <InstallProgressBlock
          install={romDownloadProgressView(download)}
          menuOpen={menuOpen}
          playRef={playRef}
          onOpenMenu={onOpenMenu}
        />
      ) : download?.state === 'done' ? (
        // The ROM is on this PC; the rescan that adds it to the library has not landed yet. Download again would copy
        // it a second time, so the slot waits (the panel then turns into this PC's game).
        <PlaySplitButton
          label={t('gameDetail.bar.addingToLibrary')}
          icon={<Download aria-hidden="true" />}
          disabled
          menuOpen={menuOpen}
          onPress={noop}
          playRef={playRef}
          onOpenMenu={onOpenMenu}
        />
      ) : downloadAction && streaming ? (
        <PlaySplitButton
          label={downloadFailed ? t('gameDetail.bar.retry') : t('gameDetail.bar.download')}
          subLabel={downloadFailed ? undefined : (sizeOnButton ?? undefined)}
          ariaLabel={
            downloadFailed ? t('gameDetail.bar.retry') : sizeAria(t('gameDetail.bar.download'))
          }
          icon={downloadFailed ? <RotateCcw aria-hidden="true" /> : <Download aria-hidden="true" />}
          menuOpen={menuOpen}
          onPress={streaming.onDownload}
          playRef={playRef}
          onOpenMenu={onOpenMenu}
        />
      ) : remote && remoteAction === 'stream' && streaming ? (
        <PlaySplitButton
          label={streamFailed ? t('gameDetail.bar.retry') : t('gameDetail.bar.stream')}
          icon={streamFailed ? <RotateCcw aria-hidden="true" /> : <Cast aria-hidden="true" />}
          menuOpen={menuOpen}
          onPress={streaming.onStream}
          playRef={playRef}
          onOpenMenu={onOpenMenu}
        />
      ) : game.remote ? (
        <div ref={playRef} className="gdetail__play gdetail__play--chip">
          <Chip className="gdetail__not-installed">
            {t('gameDetail.bar.notAvailableFrom', { host: game.remote.hostName })}
          </Chip>
          <MenuChevron menuOpen={menuOpen} playRef={playRef} onOpenMenu={onOpenMenu} />
        </div>
      ) : game.installed || justInstalled || playsRecomp ? (
        <PlaySplitButton
          label={running ? t('gameDetail.bar.running') : t('gameDetail.bar.play')}
          disabled={running || justInstalled}
          running={running}
          menuOpen={menuOpen}
          onPress={onPlay}
          playRef={playRef}
          onOpenMenu={onOpenMenu}
        />
      ) : tracking ? (
        <InstallProgressBlock
          install={install}
          menuOpen={menuOpen}
          playRef={playRef}
          onOpenMenu={onOpenMenu}
        />
      ) : canInstall ? (
        <PlaySplitButton
          label={failed ? t('gameDetail.bar.retry') : t('gameDetail.bar.install')}
          subLabel={failed ? undefined : (sizeOnButton ?? undefined)}
          ariaLabel={failed ? t('gameDetail.bar.retry') : sizeAria(t('gameDetail.bar.install'))}
          icon={failed ? <RotateCcw aria-hidden="true" /> : <Download aria-hidden="true" />}
          menuOpen={menuOpen}
          onPress={onInstall}
          playRef={playRef}
          onOpenMenu={onOpenMenu}
        />
      ) : (
        <div ref={playRef} className="gdetail__play gdetail__play--chip">
          <Chip className="gdetail__not-installed">{t('gameDetail.bar.notInstalled')}</Chip>
          <MenuChevron menuOpen={menuOpen} playRef={playRef} onOpenMenu={onOpenMenu} />
        </div>
      )}
      <FeatureGrid
        recomp={recomp}
        upgrade={upgrade}
        coop={coop}
        peerParty={peerParty}
        playDisabled={featuresWaitForPlay({
          running,
          justInstalled,
          streamConnecting: connecting,
          streamLive: live
        })}
      />
      {failure ? (
        <span className="gdetail__install-failed" role="status">
          {failure}
        </span>
      ) : null}
      {queueNote ? (
        <span className="gdetail__install-failed gdetail__queue-note" role="status">
          {queueNote}
        </span>
      ) : null}
      <div ref={statsRef} className={cx('gdetail__stats', fit.compact && COMPACT)}>
        {showAchievements ? (
          <Stat
            label={isRom ? 'RetroAchievements' : t('gameDetail.stats.achievements')}
            value={achievementsValue}
            trailing={
              <ChevronDown
                className={cx(
                  'gdetail__ach-chevron',
                  achievementsOpen && 'gdetail__ach-chevron--open'
                )}
                aria-hidden="true"
              />
            }
            focusKey={BAR_FOCUS.achievements}
            onPress={onToggleAchievements}
            className="gdetail__stat-achievements"
          />
        ) : null}
        {showAchievements ? <Divider vertical tight className="gdetail__hltb-divider" /> : null}
        {/* Play time, then How Long To Beat's main time (a game HLTB shows as "Solo", play styles combined or no
              Main Story time: its Solo time). Never left out: it is the player's own time. */}
        <Stat
          label={<FitText full={playLabel} short={playLabelShort} />}
          value={<FitText full={playValue} short={playValueShort} />}
          className="gdetail__playtime"
        />
        {/* Steam's user reviews (percent positive), else IGDB's user rating out of 100: five stars filled in
              proportion (84 = 4.2 stars). */}
        <Stat
          label={ratingLabel}
          value={
            ratingValue === '—' ? (
              ratingValue
            ) : (
              <>
                <span className="fit-full">
                  <StarRating score={meta.reviewScore?.score ?? 0} source={ratingSource} />
                </span>
                {/* Compact row: one star and the score ('★ 98%'). */}
                <span
                  className="fit-short gdetail__rating-short"
                  role="img"
                  aria-label={t('gameDetail.stats.rating', {
                    score: ratingValue,
                    source: ratingSource
                  })}
                  title={t('gameDetail.stats.rating', { score: ratingValue, source: ratingSource })}
                >
                  <Star aria-hidden="true" />
                  {ratingValue}
                </span>
              </>
            )
          }
          className={cx('gdetail__hltb gdetail__rating', dropClass(2, fit.upTo))}
        />
        {players ? <PlayersStat meta={meta} className={dropClass(1, fit.upTo)} /> : null}
        {/* How Long To Beat's Main + extras and Completionist are not shown: Play time already sets the player against
              Main story. */}
      </div>
      <div className="gdetail__bar-actions">
        <IconButton
          icon={<Pencil />}
          aria-label={t('gameDetail.bar.editGame')}
          shape="square"
          focusKey={BAR_FOCUS.edit}
          onPress={onOpenEdit}
        />
        <IconButton
          icon={<Gauge />}
          aria-label={t('gameDetail.bar.performancePanel')}
          shape="square"
          focusKey={BAR_FOCUS.gauge}
          onPress={onOpenQuickPanel}
        />
        {!canStar ? null : (
          <IconButton
            icon={<Heart fill={favorite ? 'currentColor' : 'none'} />}
            aria-label={
              favorite ? t('gameDetail.bar.removeFavourite') : t('gameDetail.bar.addFavourite')
            }
            shape="square"
            focusKey={BAR_FOCUS.favorite}
            onPress={onToggleFavorite}
          />
        )}
      </div>
    </div>
  )
}

/** The busy "Adding to library…" button: disabled, so its press does nothing. */
function noop(): void {
  // nothing: the button is disabled while the downloaded ROM is added
}

/** installPercent (state/installs.ts) for the progress block's narrower shape: 0-100, or null while indeterminate. */
function progressPercent(progress: ProgressView): number | null {
  if (progress.percent === undefined || !Number.isFinite(progress.percent)) return null
  return Math.max(0, Math.min(100, progress.percent))
}

interface PlaySplitButtonProps {
  /** 'Play', 'Running', 'Install', 'Retry', or Streaming's 'Stream', 'Download', 'Connecting…', 'Stop streaming'. */
  label: string
  /** What a screen reader says when it differs from the label (the busy stream button cancels). */
  ariaLabel?: string
  /** Glyph before the label (the Install / Retry variants). */
  icon?: ReactElement
  /** A smaller second line under the label (Install's and Download's size: "45 GB"). */
  subLabel?: string
  disabled?: boolean
  running?: boolean
  menuOpen: boolean
  onPress: () => void
  playRef: RefObject<HTMLDivElement | null>
  onOpenMenu: (anchor: HTMLElement) => void
}

/** 225x76u split button: the main part launches (or installs), the 52u chevron part opens the play menu. */
function PlaySplitButton({
  label,
  ariaLabel,
  icon,
  subLabel,
  disabled = false,
  running = false,
  menuOpen,
  onPress,
  playRef,
  onOpenMenu
}: PlaySplitButtonProps): ReactElement {
  const { ref: mainRef, props: mainProps } = useFocusableControl<HTMLButtonElement>({
    focusKey: BAR_FOCUS.play,
    onPress,
    disabled,
    scroll: false
  })
  return (
    <div ref={playRef} className={cx('gdetail__play', running && 'gdetail__play--running')}>
      <button
        ref={mainRef}
        type="button"
        className="gdetail__play-main"
        disabled={disabled}
        aria-label={ariaLabel ?? label}
        title={ariaLabel}
        {...mainProps}
      >
        {icon ? <span className="gdetail__play-icon">{icon}</span> : null}
        {subLabel ? (
          <span className="gdetail__play-text">
            <span>{label}</span>
            <span className="gdetail__play-sub">{subLabel}</span>
          </span>
        ) : (
          <span>{label}</span>
        )}
      </button>
      <MenuChevron menuOpen={menuOpen} playRef={playRef} onOpenMenu={onOpenMenu} />
    </div>
  )
}

/** A text with a full and a short form: the short one in a compact stats row (useDropToFit). */
function FitText({ full, short }: { full: string; short: string }): ReactElement {
  if (full === short) return <>{full}</>
  return (
    <>
      <span className="fit-full">{full}</span>
      <span className="fit-short">{short}</span>
    </>
  )
}

/** The 52u chevron segment of the split control: opens the play menu anchored to the whole control. */
function MenuChevron({
  menuOpen,
  playRef,
  onOpenMenu
}: {
  menuOpen: boolean
  playRef: RefObject<HTMLDivElement | null>
  onOpenMenu: (anchor: HTMLElement) => void
}): ReactElement {
  const t = useT()
  const { ref, props } = useFocusableControl<HTMLButtonElement>({
    focusKey: BAR_FOCUS.playMenu,
    onPress: () => {
      if (playRef.current) onOpenMenu(playRef.current)
    },
    scroll: false
  })
  return (
    <button
      ref={ref}
      type="button"
      className="gdetail__play-chevron"
      aria-label={t('gameDetail.bar.moreOptions')}
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      {...props}
    >
      <ChevronDown aria-hidden="true" />
    </button>
  )
}

interface InstallProgressBlockProps {
  /** A tracked store install, or a host ROM's download shaped like one (lib/streaming.ts). */
  install: ProgressView
  menuOpen: boolean
  playRef: RefObject<HTMLDivElement | null>
  onOpenMenu: (anchor: HTMLElement) => void
}

/**
 * The tracked install in the Play button's place: a bar with the percent and "<done> / <total>" when the
 * store exposes numbers, an indeterminate shimmer with the tracker's message otherwise. Focusable under the
 * Play key (so focus stays put and B / X / the chevron keep working) but not activatable: the menu holds
 * Cancel tracking. When the confirming scan marks the game installed the parent swaps in the Play button.
 */
function InstallProgressBlock({
  install,
  menuOpen,
  playRef,
  onOpenMenu
}: InstallProgressBlockProps): ReactElement {
  const t = useT()
  const { ref, props } = useFocusableControl<HTMLDivElement>({
    focusKey: BAR_FOCUS.play,
    scroll: false
  })
  const percent = progressPercent(install)
  const bytes =
    install.bytesTotal !== undefined && install.bytesDone !== undefined
      ? t('gameDetail.bar.bytesOf', {
          done: formatBytes(install.bytesDone),
          total: formatBytes(install.bytesTotal)
        })
      : null
  const message = install.message ?? t('gameDetail.bar.installing')
  return (
    <div
      ref={playRef}
      className={cx(
        'gdetail__play',
        'gdetail__play--progress',
        menuOpen && 'gdetail__play--menu-open'
      )}
    >
      <div
        ref={ref}
        className="gdetail__install"
        role="progressbar"
        aria-label={message}
        aria-valuenow={percent ?? undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-busy="true"
        style={percent === null ? undefined : ({ '--p': percent } as CSSProperties)}
        {...props}
      >
        <div className="gdetail__install-text">
          <span className="gdetail__install-message">
            {percent !== null ? `${Math.round(percent)}%` : message}
          </span>
          <span className="gdetail__install-detail">
            {/* A stalled store install ("No progress from <Store>…") says so in place of the bytes. */}
            {percent !== null
              ? installStalled(install)
                ? message
                : (bytes ?? message)
              : (bytes ?? '')}
          </span>
        </div>
        <span
          className={cx(
            'gdetail__install-bar',
            percent === null && 'gdetail__install-bar--indeterminate'
          )}
          aria-hidden="true"
        />
      </div>
      <MenuChevron menuOpen={menuOpen} playRef={playRef} onOpenMenu={onOpenMenu} />
    </div>
  )
}
