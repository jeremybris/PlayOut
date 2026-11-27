import type { Game, GameMetadata, InstallProgress } from '@shared/types'
import type { RecompExecutables } from '@shared/recomp'
import { playableHere, recompAddedId, recompOnlyKey, recompToPlay } from '@shared/recomp-play'
import { upgradeRunningMessage } from '@shared/upgrades'
import { Gamepad, Gamepad2, Glasses, Keyboard, Users, X } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement
} from 'react'
import { api } from '../../api/client'
import { ButtonHints } from '../../components/ButtonHints'
import { Chip } from '../../components/Chip'
import { IconButton } from '../../components/IconButton'
import { SimilarIcon } from '../../components/SimilarIcon'
import { Modal } from '../../components/Modal'
import { Pill } from '../../components/Pill'
import { PlatformBadge, RecompBadge } from '../../components/PlatformBadge'
import { useActionHandlers } from '../../hooks/useActionHandlers'
import { useFocusableControl } from '../../hooks/useFocusableControl'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { isFocusWithin, setFocus } from '../../input/focus'
import { gameControls } from '../../lib/controls'
import { useT } from '../../i18n'
import { cx } from '../../lib/cx'
import { DETAIL_TAG_COUNT, detailChips, genreFilterFor, tagFilterFor } from '../../lib/steamTags'
import { isStoreFilter } from '../../lib/storeFilters'
import { formatDate } from '../../lib/format'
import { displayTitle } from '../../lib/library'
import { createLog } from '../../lib/log'
import { heroUrl, logoUrl } from '../../lib/media'
import { storeNameOf } from '../../lib/platforms'
import { localPlayersShown } from '../../lib/localPlayers'
import { hostChipLabel, localCopyOfHostGame } from '../../lib/streaming'
import {
  canFavorite,
  toggleFavorite as toggleGameFavorite,
  useIsFavorite
} from '../../state/favorite'
import {
  activeQueueEntry,
  isInstalledHere,
  useInstallQueueStore,
  useQueueEntry,
  useQueuePosition,
  useQueueWaitingFor
} from '../../state/installQueue'
import { useInstallProgress } from '../../state/installs'
import { useCurrentGameId, useGame, useLibraryStore, usePlatform } from '../../state/library'
import { useSettingsStore } from '../../state/settings'
import {
  useRecompSources,
  useRomDownload,
  useRemoteFor,
  useStreamSession,
  useStreamingStore
} from '../../state/streaming'
import { useSystemStore } from '../../state/system'
import { canManageSteamDlc, picksSteamDlc, startStoreInstall } from '../../state/steamDlc'
import { useUiStore } from '../../state/ui'
import { showChoiceInLibrary, toggleTabChoice } from '../../state/libraryTabs'
import { libraryShowsGame } from '../../state/libraryShown'
import { ipcErrorMessage, startCoop, useCoopBusy } from '../../state/coop'
import {
  peerPartyProgressText,
  peerPartyTitle,
  startPeerParty,
  usePeerPartyProgress,
  usePeerPartySession,
  usePeerPartyStatus
} from '../../state/peerparty'
import { usePs3UpdateStore } from '../../state/ps3Updates'
import { clearRecompProgress, recompBusy, useRecompStore } from '../../state/recomp'
import { progressText, recompButton, recompProgressId, recompToLaunch } from '../Recomp/recompView'
import { RecompExeChooser } from '../Recomp/RecompExeChooser'
import { CoopSetupSheet } from './CoopSetupSheet'
import { CreatorButton } from './CreatorButton'
import { useTabChoiceActive } from './useTabChoiceActive'
import { AchievementsList } from './AchievementsList'
import { SimilarMenu } from './SimilarMenu'
import { UpgradeMenu } from './UpgradeMenu'
import { useUpgradeProgress } from '../../state/upgrades'
import { ACHIEVEMENTS_FOCUS_KEY, ActionBar, PLAY_FOCUS_KEY } from './ActionBar'
import { SteamScreenshots } from './SteamScreenshots'
import { GameEditSheet } from './GameEditSheet'
import { PlayMenu } from './PlayMenu'

const log = createLog('detail')

/** Focus keys of the panel's own controls (children of the 'detail' boundary); the bar's live in ActionBar. */
/** How often an open Steam game's panel asks for its player numbers again (main's own limit is the same). */
const LIVE_PLAYERS_INTERVAL_MS = 10 * 60 * 1000 + 5_000

const DETAIL_FOCUS = {
  root: 'detail',
  close: 'detail:close',
  /** The Similar button, left of the platform pill. */
  similar: 'detail:similar',
  more: 'detail:more',
  /** The pressable chips (genre, a Steam tag, the store) that open the Library filtered by them. */
  genreChip: 'detail:chip:genre',
  /** A further genre of the game (the first keeps `genreChip`). */
  otherGenreChip: (genre: string) => `detail:chip:genre:${genre.toLowerCase()}`,
  tagChip: (tag: string) => `detail:chip:tag:${tag.toLowerCase()}`,
  storeChip: 'detail:chip:store',
  developer: 'detail:developer',
  publisher: 'detail:publisher',
  play: PLAY_FOCUS_KEY,
  achievements: ACHIEVEMENTS_FOCUS_KEY
} as const

export interface GameDetailModalProps {
  gameId: string
  onClose: () => void
}

/**
 * The game detail panel (design 3.x): hero art under left/bottom gradients, logo top-left, store pill and
 * close button top-right, chips + description + meta line bottom-left, and the action bar along the bottom.
 * Opens with fresh data from api.getGame; achievements load only when their list is expanded. An uninstalled
 * game opens the same panel with Install in Play's place (ARCHITECTURE.md §6.1): Install hands the game to
 * the store client, the tracked progress shows in the bar, and the confirming scan's `library:changed`
 * re-renders the panel with Play without closing it. A paired host's game (Streaming) opens the same panel from the
 * remote library: Stream or Download in Play's place, "On <host>" among the chips, and nothing that would ask this
 * PC's services about a game they have no record of (game settings). Its achievements are its host's: the counts come
 * with the host's offer and the list from the host (api.getAchievements with the `remote:` id). Its favourite is its
 * host's too: with
 * the favourites sync on (Settings › Streaming) the star and X set it there (api.setRemoteFavorite). Metadata edits of a
 * host game do go through: the pen opens the Edit sheet with the `remote:` id, and main keeps the edit in its remote
 * edits store (src/main/metadata-edits/remote-edits.ts). The sheet is keyed by the game's id, so a host ROM download
 * that finishes while it is open (the panel switches to the local game) reopens it with the local record's layers.
 */
export function GameDetailModal({ gameId, onClose }: GameDetailModalProps): ReactElement {
  const t = useT()
  // A converted ROM's record moves to its new file's id: the open page follows it (no "Game not found").
  const localGame = useGame(useCurrentGameId(gameId))
  // A paired host's game (Streaming) is not in the library store: it comes from the remote library. A host ROM that
  // finished downloading is this PC's game from then on, under its own `rom:` id: the panel turns into that game.
  const remoteGame = useStreamingStore((s) => s.remote?.games.find((g) => g.id === gameId))
  const download = useRomDownload(gameId)
  // The downloaded game follows its record when that moves on at once (Trim Games converting the new ROM, a
  // recompilation's card merging into it), as a converted ROM's page does.
  const downloadedGame = useGame(useCurrentGameId(download?.installedGameId))
  // And when the download's own progress is gone: this PC's game the host also has this very game for (useGame
  // below finds nothing until it is in the library).
  const hostCopyLocalId = useStreamingStore((s) =>
    localCopyOfHostGame(gameId, s.remote?.alsoOnHost)
  )
  const nowLocalGame = useGame(useCurrentGameId(hostCopyLocalId))
  const resolved = localGame ?? downloadedGame ?? remoteGame ?? nowLocalGame
  // While a download from the host runs or has just finished, 'streaming:library' can drop the host's copy before the
  // download says which game it became, or before 'library:changed' brings this PC's: the panel keeps the game it
  // last showed rather than show "Game not found" (the game only moved from the host to this PC).
  // (State adjusted during render, React's pattern for remembering a previous value; a ref may not be read here.)
  const [lastGame, setLastGame] = useState(resolved)
  if (resolved && resolved !== lastGame) setLastGame(resolved)
  const moving = !!download && download.state !== 'failed' && download.state !== 'cancelled'
  const game = resolved ?? (moving ? lastGame : undefined)
  // A recompilation's own card left the library (its last recompilation was deleted): the page closes.
  const ownCardGone = !game && !!lastGame && !!recompOnlyKey(lastGame)
  const closedForOwnCard = useRef(false)
  useEffect(() => {
    if (!ownCardGone || closedForOwnCard.current) return
    closedForOwnCard.current = true
    onClose()
  }, [ownCardGone, onClose])
  // A recompilation-only game (its recompilation installed, the game not on this PC) whose original a paired PC has:
  // Download gives the recompilation the original's files (UP still starts it). Its download and queue place go by the
  // host's copy. Once the downloaded game is in the library (the card then merges into it), Play as before; a host
  // that cannot be reached offers nothing new (Play), but a download already under way keeps showing.
  const recompSources = useRecompSources(
    game && !game.remote && recompOnlyKey(game) ? game.id : null
  )
  const sourceDownloads = useStreamingStore((s) => s.downloads)
  const queueEntries = useInstallQueueStore((s) => s.entries)
  // The copy with a download or queue place already (it stays the one shown when its host goes offline), else a
  // reachable host's.
  const recompSource = useMemo(() => {
    const busy = (id: string): boolean =>
      !!sourceDownloads[id] || queueEntries.some((e) => e.gameId === id)
    return (
      recompSources.find((src) => busy(src.remoteId)) ??
      recompSources.find((src) => src.info.downloadable && !src.info.offline) ??
      null
    )
  }, [recompSources, sourceDownloads, queueEntries])
  const sourceBusy = !!recompSource && queueEntries.some((e) => e.gameId === recompSource.remoteId)
  const sourceDownload = useRomDownload(recompSource?.remoteId)
  const sourceLanded = useLibraryStore(
    (s) => !!sourceDownload?.installedGameId && s.byId.has(sourceDownload.installedGameId)
  )
  const hostCopy =
    recompSource &&
    !sourceLanded &&
    (!recompSource.info.offline ||
      sourceBusy ||
      (!!sourceDownload && sourceDownload.state !== 'done'))
      ? recompSource.info
      : undefined
  // What the install queue knows this game by: the host's copy while it downloads for the recompilation.
  const queueId = hostCopy ? recompSource!.remoteId : (game?.id ?? gameId)
  const isRemote = !!game?.remote
  // The id this PC's services know the game by; null for a host-only game, which they have no record of.
  const localId = game && !game.remote ? game.id : null
  const favorite = useIsFavorite(game?.id)
  const remoteFavorites = useSettingsStore((s) => s.settings?.streaming.syncFavorites ?? true)
  const platform = usePlatform(game?.platformId)
  const applyGame = useLibraryStore((s) => s.applyGame)
  const running = useSystemStore((s) => s.running)
  const openModal = useUiStore((s) => s.openModal)
  const toast = useUiStore((s) => s.toast)
  const install = useInstallProgress(game && !game.installed ? game.id : null)
  // Waiting in the install queue (one game downloads at a time): its place, and the game it waits for.
  // An installed game of this PC is never treated as queued: it keeps Play.
  const queuePosition = useQueuePosition(queueId, isInstalledHere(game))
  const queueWaitingFor = useQueueWaitingFor(queueId)
  const queueAfter = useInstallQueueStore((s) => activeQueueEntry(s.entries)?.title)
  const removeFromQueue = useInstallQueueStore((s) => s.remove)
  const pauseInQueue = useInstallQueueStore((s) => s.pause)
  const resumeInQueue = useInstallQueueStore((s) => s.resume)
  const queueEntry = useQueueEntry(queuePosition !== null ? queueId : null)
  // A host's game installs nowhere through a store client here: Stream / Download take Install's place.
  const storeName = game && !game.remote ? storeNameOf(game.source) : undefined
  const showHidden = useSettingsStore((s) => s.settings?.library.showHidden ?? false)
  // A chip opens the Library on a tab with just that filter (an existing one, else a new one).
  const showInLibrary = showChoiceInLibrary
  // Narrow canvases show fewer genre and tag chips so the chip row stays one line (fewer, not hidden: a chip hidden with CSS
  // would still take gamepad focus).
  const narrow = useMediaQuery('(max-aspect-ratio: 1656 / 1080)')
  const narrower = useMediaQuery('(max-aspect-ratio: 1416 / 1080)')
  const tagCount = narrower
    ? DETAIL_TAG_COUNT - 2
    : narrow
      ? DETAIL_TAG_COUNT - 1
      : DETAIL_TAG_COUNT

  const [descriptionOpen, setDescriptionOpen] = useState(false)
  const [achievementsOpen, setAchievementsOpen] = useState(false)
  // The collapsed description is clamped by CSS; "More" appears only while that clamp hides text.
  const description = game ? describe(game.metadata) : null
  const descriptionRef = useRef<HTMLParagraphElement | null>(null)
  const [descriptionClamped, setDescriptionClamped] = useState(false)
  useLayoutEffect(() => {
    const el = descriptionRef.current
    if (!el || descriptionOpen) return
    setDescriptionClamped(el.scrollHeight > el.clientHeight + 1)
  }, [description, descriptionOpen, achievementsOpen])
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  // The Upgrade menu (PC games): anchored to the four-square grid right of Play (its sparkles square) while open.
  const [upgradeAnchor, setUpgradeAnchor] = useState<HTMLElement | null>(null)
  // The Similar menu's button while it is open (the list is worked out when it opens).
  const similarRef = useRef<HTMLSpanElement>(null)
  const [similarAnchor, setSimilarAnchor] = useState<HTMLElement | null>(null)
  // An upgrade of this game running now (it may be rewriting its files): Play waits (main refuses it too).
  const upgradeRunning = useUpgradeProgress(game?.id ?? gameId)?.state === 'running'
  const [editOpen, setEditOpen] = useState(false)
  const playAnchor = useRef<HTMLDivElement | null>(null)

  // Fresh copy of the game (play time, metadata) the moment the panel opens.
  useEffect(() => {
    if (!localId) return undefined
    let cancelled = false
    api
      .getGame(localId)
      .then((fresh) => {
        if (!cancelled && fresh) applyGame(fresh)
      })
      .catch((err) => log.warn('getGame failed', err))
    return () => {
      cancelled = true
    }
  }, [localId, applyGame])

  const installed = game?.installed
  // The install size beside Play / Install: measured for an installed game that has none yet, the store's storage
  // requirement for one that is not installed. The answer arrives as the game itself.
  useEffect(() => {
    if (!localId) return undefined
    let cancelled = false
    api
      .refreshInstallSize(localId)
      .then((fresh) => {
        if (!cancelled && fresh) applyGame(fresh)
      })
      .catch((err) => log.warn('refreshInstallSize failed', err))
    return () => {
      cancelled = true
    }
    // Again when the game finishes installing (or is uninstalled) while the panel is open.
  }, [localId, applyGame, installed])

  // Steam games: the players online now and the all-time peak (the Players stat), read when the panel opens and
  // every ten minutes while it stays open (main reads Steam again after ten minutes, SteamCharts after a day).
  const isSteam = game?.source === 'steam'
  useEffect(() => {
    if (!localId || !isSteam) return undefined
    let cancelled = false
    const refresh = (): void => {
      api
        .refreshLivePlayers(localId)
        .then((fresh) => {
          if (!cancelled && fresh) applyGame(fresh)
        })
        .catch((err) => log.warn('refreshLivePlayers failed', err))
    }
    refresh()
    const timer = setInterval(refresh, LIVE_PLAYERS_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [localId, isSteam, applyGame])

  // A game that was never scraped gets one metadata request; results arrive through 'library:changed'. A host's
  // game comes with the host's metadata (this PC cannot scrape a game it has no record of).
  const metadataRequested = useRef(false)
  useEffect(() => {
    if (!game || game.remote || metadataRequested.current || game.metadataStatus !== 'none') return
    metadataRequested.current = true
    api.refreshMetadata([game.id]).catch((err) => {
      log.warn('refreshMetadata failed', err)
      toast(t('gameDetail.toasts.metadataFailed'), 'error')
    })
  }, [game, toast, t])

  const isRunning = !!game && running?.gameId === game.id
  const coopBusy = useCoopBusy(game?.id ?? '')
  // PeerParty (LAN play): offered when main found the game eligible (installed, multiplayer, no anti-cheat, a
  // multiplayer service PeerParty covers). The square says how far a download or start got.
  const peerPartyStatus = usePeerPartyStatus(game)
  const peerPartyProgress = usePeerPartyProgress(game?.id ?? '')
  const peerPartySession = usePeerPartySession()
  const [coopSetupOpen, setCoopSetupOpen] = useState(false)

  // Recompilations (main/recomp): the UP square (top left of the grid right of Play). Any recompilation installed = it starts one (the chosen
  // one when installed, else the first installed: recompToLaunch, passed to main by id so main starts the same one);
  // else it opens the Recompilation page, which also opens when the start needs game files or a save choice first.
  const recompInfo = game && !game.remote ? game.metadata.recomp : undefined
  // Busy follows the recompilation UP would start (an installed fallback updating), else the chosen one installing.
  const recompUpId = recompProgressId(recompInfo)
  const recompProgress = useRecompStore((s) => (recompUpId ? s.progress[recompUpId] : undefined))
  // A recompilation added to the library from the browser and not installed: Install installs it (its progress shows
  // as an install's; it then plays like any installed recompilation).
  const addedRecomp = game ? recompAddedId(game) : null
  const addedNotInstalled = !!addedRecomp && !!game && !recompToPlay(game)
  const addedProgress = useRecompStore((s) => (addedRecomp ? s.progress[addedRecomp] : undefined))
  const addedInstall = useMemo((): InstallProgress | undefined => {
    if (!addedNotInstalled || !addedProgress) return undefined
    const failed = addedProgress.phase === 'failed'
    const done = addedProgress.phase === 'done'
    if (!failed && !done && !recompBusy(addedProgress)) return undefined
    const text = progressText(addedProgress)
    return {
      gameId: game!.id,
      source: 'steam',
      // Done: Play (disabled) until the card says installed, never a second Install meanwhile.
      state: failed
        ? 'failed'
        : done
          ? 'done'
          : addedProgress.phase === 'downloading'
            ? 'downloading'
            : 'installing',
      ...(text.percent !== null ? { percent: text.percent } : {}),
      ...(addedProgress.bytes !== null && addedProgress.total !== null
        ? { bytesDone: addedProgress.bytes, bytesTotal: addedProgress.total }
        : {}),
      message: failed
        ? (addedProgress.message ?? t('gameDetail.recomp.installFailed'))
        : text.title,
      startedAt: '',
      updatedAt: ''
    }
  }, [addedNotInstalled, addedProgress, game, t])
  const installAdded = useCallback(() => {
    if (!addedRecomp) return
    api.installRecomp(addedRecomp).catch((err) => {
      log.error('installRecomp failed', err)
      toast(ipcErrorMessage(err) || t('gameDetail.recomp.installRecompFailed'), 'error')
    })
  }, [addedRecomp, toast, t])
  const openRecomp = useCallback(
    (focus?: 'files', recompId?: string) => {
      if (game)
        openModal({
          type: 'recomp',
          gameId: game.id,
          ...(focus ? { focus } : {}),
          ...(recompId ? { recompId } : {})
        })
    },
    [game, openModal]
  )
  // UP asked which program starts the game (the recompilation's folder has several and nobody chose): the chooser
  // saves the pick and UP starts again; later starts use the pick.
  const [exeChoice, setExeChoice] = useState<RecompExecutables | null>(null)
  const launchRecomp = useCallback(
    (recompId: string) => {
      if (!game) return
      const title = displayTitle(game)
      api
        .launchRecomp(game.id, recompId)
        .then((result) => {
          if (result.ok) {
            toast(t('gameDetail.recomp.starting', { title }))
            if (result.warning) toast(result.warning, 'error')
            return
          }
          switch (result.reason) {
            case 'needs-files':
              toast(t('gameDetail.recomp.pickFiles', { title }))
              openRecomp('files', recompId)
              return
            case 'save-conflict':
              openRecomp(undefined, recompId)
              return
            case 'choose-exe':
              setExeChoice(result.executables)
              return
            case 'not-installed':
              openRecomp()
              return
            case 'running':
              // Installing/updating (the page shows its progress) or already running: say so and open the page.
              toast(result.message)
              openRecomp(undefined, recompId)
              return
            default:
              toast(result.message || t('gameDetail.recomp.startFailed', { title }), 'error')
          }
        })
        .catch((err) => {
          log.error('launchRecomp failed', err)
          toast(t('gameDetail.recomp.startFailed', { title }), 'error')
        })
    },
    [game, toast, openRecomp, t]
  )

  // The recompilation the UP button starts (the chosen one when installed, else the first installed one): the menu's
  // "Delete recompilation" removes it and everything it built (main/recomp uninstall: its folder, the files PlayOut
  // copied in, leftover downloads; the player's own files in it are zipped to the backups first).
  const deletableRecomp = recompToLaunch(recompInfo)
  const deletableProgress = useRecompStore((s) =>
    deletableRecomp ? s.progress[deletableRecomp] : undefined
  )
  const deleteRecomp = useCallback(async () => {
    if (!game || !deletableRecomp) return
    const title = displayTitle(game)
    // The confirm names the version it deletes (a game may have several recompilations installed).
    const name = await api
      .getGameRecomps(game.id)
      .then((data) => data?.entries.find((e) => e.id === deletableRecomp)?.name ?? null)
      .catch(() => null)
    const what = name
      ? t('gameDetail.recomp.delete.messageNamed', { name, title })
      : t('gameDetail.recomp.delete.message', { title })
    openModal({
      type: 'confirm',
      title: t('gameDetail.recomp.delete.title'),
      // The last sentence only for a card that is there just for this recompilation.
      message:
        recompOnlyKey(game) && (recompInfo?.installed.length ?? 0) <= 1
          ? `${what} ${t('gameDetail.recomp.delete.leavesLibrary')}`
          : what,
      confirmLabel: t('gameDetail.recomp.delete.yes'),
      cancelLabel: t('gameDetail.recomp.delete.no'),
      danger: true,
      onConfirm: () => {
        api
          .uninstallRecomp(deletableRecomp)
          .then(() => {
            clearRecompProgress(deletableRecomp)
            toast(
              name
                ? t('gameDetail.recomp.delete.deletedNamed', { name })
                : t('gameDetail.recomp.delete.deleted', { title }),
              'success'
            )
          })
          .catch((err) => {
            log.error('uninstallRecomp failed', err)
            toast(ipcErrorMessage(err) || t('gameDetail.recomp.delete.failed', { title }), 'error')
          })
      }
    })
  }, [game, deletableRecomp, recompInfo, openModal, toast, t])

  // A PS3 game on this PC: the menu's "Update PS3 game" (main/emulation/ps3-update-service.ts; progress shows as a bar).
  const ps3Busy = usePs3UpdateStore((s) => !!game && s.current?.gameId === game.id)
  const isPs3 =
    !!game &&
    !game.remote &&
    game.installed &&
    game.launch.kind === 'emulator' &&
    game.launch.systemId === 'ps3'
  const updatePs3 = useCallback(() => {
    if (!game) return
    const title = displayTitle(game)
    toast(t('gameDetail.toasts.checkingUpdates', { title }))
    api
      .updatePs3Game(game.id)
      .then((r) =>
        toast(
          r.message,
          r.outcome === 'failed' ? 'error' : r.outcome === 'installed' ? 'success' : 'info'
        )
      )
      .catch((err) => {
        log.error('updatePs3Game failed', err)
        toast(ipcErrorMessage(err) || t('gameDetail.toasts.updateFailed', { title }), 'error')
      })
  }, [game, toast, t])

  const play = useCallback(
    (emulatorId?: string) => {
      if (!game || isRunning) return
      if (upgradeRunning) {
        toast(upgradeRunningMessage(t), 'error')
        return
      }
      // A recompilation of it is installed (its disc image may be gone too): Play starts the recompilation (as UP
      // did). Play with an emulator picked in the Play menu still starts the emulator.
      const recompId = emulatorId ? null : recompToPlay(game)
      if (recompId) {
        launchRecomp(recompId)
        return
      }
      toast(t('gameDetail.toasts.launching', { title: displayTitle(game) }))
      api
        .launchGame(game.id, emulatorId ? { emulatorId } : undefined)
        .then((result) => {
          // A failed launch also arrives as a 'launch:error' event, which App turns into the dialog.
          if (!result.ok) log.warn(`launch of ${game.id} failed`, result.error)
        })
        .catch((err) => {
          log.error('launchGame failed', err)
          toast(t('gameDetail.toasts.launchFailed', { title: displayTitle(game) }), 'error')
        })
    },
    [game, isRunning, upgradeRunning, toast, launchRecomp, t]
  )

  // Install: the store client does the download; the tracker's progress arrives through 'install:progress'. While
  // another game downloads it waits in the install queue instead, and the toast says what it waits for. A Steam game
  // first shows its DLC picker (screens/SteamDlc), which starts the install (straight away when it has no DLC).
  const installGame = useCallback(() => {
    if (!game || game.installed || !storeName) return
    if (picksSteamDlc(game)) openModal({ type: 'steam-dlc', gameId: game.id, mode: 'install' })
    else void startStoreInstall(game)
  }, [game, storeName, openModal])

  // Streaming: the hosts this game streams from (its own host for a host-only game, else the hosts that have this
  // PC's game too), the stream in progress and the ROM download; the store toasts what fails.
  const remotes = useRemoteFor(game?.id ?? gameId)
  const streamFrom = useMemo(() => remotes.filter((info) => info.streamable), [remotes])
  const session = useStreamSession(game?.id ?? gameId)
  const streamGame = useStreamingStore((s) => s.streamGame)
  const stopStream = useStreamingStore((s) => s.stopStream)
  const downloadRom = useStreamingStore((s) => s.downloadRom)
  const cancelDownload = useStreamingStore((s) => s.cancelDownload)
  const stream = useCallback(
    (hostId?: string) => {
      if (game) void streamGame(game, hostId)
    },
    [game, streamGame]
  )
  const startDownload = useCallback(() => {
    if (game?.remote) void downloadRom(game)
    // The original of a recompilation-only game: the host's copy, under this game's name.
    else if (game && hostCopy && recompSource)
      void downloadRom({ ...game, id: recompSource.remoteId, remote: hostCopy })
  }, [game, downloadRom, hostCopy, recompSource])
  const stopDownload = useCallback(() => {
    if (game?.remote) void cancelDownload(game.id)
    else if (hostCopy && recompSource) void cancelDownload(recompSource.remoteId)
  }, [game, cancelDownload, hostCopy, recompSource])

  // The confirming scan flipped the game to installed while the panel is open: the progress block (or
  // Install button) turns into Play in place; focus follows when it was on that control.
  const wasInstalled = useRef(game?.installed)
  useEffect(() => {
    const before = wasInstalled.current
    wasInstalled.current = game?.installed
    if (!game || before !== false || !game.installed) return undefined
    if (!isFocusWithin(DETAIL_FOCUS.root)) return undefined
    const timer = setTimeout(() => void setFocus(DETAIL_FOCUS.play), 0)
    return () => clearTimeout(timer)
  }, [game])

  // Every copy of the game (one card in the Library stands for all of them), as on a cover.
  const toggleFavorite = useCallback(() => {
    if (game && canFavorite(game)) toggleGameFavorite(game.id)
  }, [game])

  const openMenu = useCallback((anchor: HTMLElement) => setMenuAnchor(anchor), [])
  const closeMenu = useCallback(() => setMenuAnchor(null), [])

  // X = play menu (the panel's secondary action), Y = favourite (design 6.2). The handlers must be
  // registered from inside the Modal so they land on its action layer (see PanelActions below).
  const openMenuFromButton = useCallback((): boolean => {
    if (menuAnchor || editOpen || !playAnchor.current) return false
    openMenu(playAnchor.current)
    return true
  }, [menuAnchor, editOpen, openMenu])

  if (!game) {
    return (
      <Modal
        size="dialog"
        narrow
        focusKey={DETAIL_FOCUS.root}
        title={t('gameDetail.notFound.title')}
        onClose={onClose}
      >
        <p className="dialog__message">{t('gameDetail.notFound.message')}</p>
      </Modal>
    )
  }

  const title = displayTitle(game)
  const hero = heroUrl(game)
  const logo = logoUrl(game)
  const meta = game.metadata
  // The game's genres (LaunchBox's for a ROM game, else the scraped ones) and its strongest Steam tags, as many as
  // the one line holds.
  const chips = detailChips(game, tagCount)
  const firstGenre = chips.find((c) => c.kind === 'genre')?.label
  const localPlayers = localPlayersShown(meta)
  const platformLabel = platform?.shortName ?? platform?.name ?? game.platformId

  return (
    <Modal
      size="panel"
      bare
      focusKey={DETAIL_FOCUS.root}
      preferredChildFocusKey={DETAIL_FOCUS.play}
      onClose={onClose}
      aria-label={title}
      className="gdetail"
    >
      {hero ? (
        <img key={hero} className="gdetail__art" src={hero} alt="" draggable={false} />
      ) : null}
      <div className="gdetail__gradient gdetail__gradient--left" aria-hidden="true" />
      <div className="gdetail__gradient gdetail__gradient--bottom" aria-hidden="true" />

      <div className="gdetail__logo-box">
        <div className="gdetail__badges">
          <ControlsBadge game={game} />
          {localPlayers ? <PlayersBadge players={localPlayers} /> : null}
          {meta.coop ? <CoopBadge maxPlayers={meta.coop.maxPlayers} /> : null}
        </div>
        {logo ? (
          <img className="gdetail__logo" src={logo} alt={title} draggable={false} />
        ) : (
          <h1 className="gdetail__title">{title}</h1>
        )}
      </div>

      <div className="gdetail__header">
        <span ref={similarRef} className="gdetail__similar">
          <IconButton
            icon={<SimilarIcon />}
            aria-label={t('gameDetail.header.similar')}
            variant="glass"
            focusKey={DETAIL_FOCUS.similar}
            onPress={() => setSimilarAnchor(similarRef.current)}
          />
        </span>
        <Pill variant="solid" size="sm" className="gdetail__store" aria-label={platformLabel}>
          {recompToPlay(game) ? (
            <RecompBadge size="2.4rem" />
          ) : (
            <PlatformBadge
              platform={platform}
              icon={platform ? undefined : game.platformId}
              name={platformLabel}
              size="2.4rem"
            />
          )}
          <span>{platformLabel}</span>
        </Pill>
        <IconButton
          icon={<X />}
          aria-label={t('gameDetail.header.close')}
          variant="glass"
          focusKey={DETAIL_FOCUS.close}
          onPress={onClose}
        />
      </div>

      {achievementsOpen ? (
        <AchievementsList
          game={game}
          returnFocusKey={DETAIL_FOCUS.achievements}
          onClose={() => setAchievementsOpen(false)}
        />
      ) : (
        <div className={cx('gdetail__text', descriptionOpen && 'gdetail__text--expanded')}>
          <div className="gdetail__chips">
            {/* The genres and the Steam tags (strongest first) add their Genre choice to the Library's current tab
                (pressed again: off); a genre or tag Filters > Genre does not offer stays plain. The store opens the
                Library on a tab of that store; a hidden game brings Filters > Hidden along there, so it shows. */}
            {chips.map(({ label, kind }) => {
              const filter = kind === 'genre' ? genreFilterFor(label) : tagFilterFor(label)
              const className = kind === 'tag' ? 'gdetail__tag' : undefined
              return filter ? (
                <GenreChip
                  key={`${kind}:${label}`}
                  focusKey={
                    kind === 'tag'
                      ? DETAIL_FOCUS.tagChip(label)
                      : label === firstGenre
                        ? DETAIL_FOCUS.genreChip
                        : DETAIL_FOCUS.otherGenreChip(label)
                  }
                  filterId={filter.id}
                  filterName={filter.label}
                  gameId={game.id}
                  className={className}
                >
                  {label}
                </GenreChip>
              ) : (
                <Chip key={`${kind}:${label}`} className={className}>
                  {label}
                </Chip>
              )
            })}
            {meta.currentPlayers ? (
              <Chip
                icon={
                  game.source === 'steam' ? (
                    <PlatformBadge icon="steam" name="Steam" size="2rem" />
                  ) : undefined
                }
              >
                {t('gameDetail.chips.playingNow', {
                  players: meta.currentPlayers.count.toLocaleString()
                })}
              </Chip>
            ) : null}
            {game.remote ? (
              <Chip>{hostChipLabel(game.remote)}</Chip>
            ) : !playableHere(game) ? (
              game.owned && storeName && isStoreFilter(game.source) ? (
                <FilterChip
                  focusKey={DETAIL_FOCUS.storeChip}
                  title={t('gameDetail.chips.showStore', { store: storeName })}
                  onPress={() =>
                    showInLibrary(
                      {
                        stores: [game.source],
                        ...(game.hidden && !showHidden ? { hidden: true } : {})
                      },
                      game.id
                    )
                  }
                >
                  {t('gameDetail.chips.ownedOn', { store: storeName })}
                </FilterChip>
              ) : (
                <Chip>{t('gameDetail.chips.notInstalled')}</Chip>
              )
            ) : null}
          </div>
          {description ? (
            <div className={cx('gdetail__desc', descriptionOpen && 'gdetail__desc--expanded')}>
              <p ref={descriptionRef} className="gdetail__desc-text">
                {description}
              </p>
              {descriptionOpen || descriptionClamped ? (
                <MoreButton
                  expanded={descriptionOpen}
                  onToggle={() => setDescriptionOpen((open) => !open)}
                />
              ) : null}
            </div>
          ) : null}
          <div className="gdetail__meta">
            {meta.releaseDate ? <Released date={formatDate(meta.releaseDate, 'short')} /> : null}
            {meta.developers?.[0] ? (
              <CreatorButton
                kind="developer"
                name={meta.developers[0]}
                gameId={game.id}
                focusKey={DETAIL_FOCUS.developer}
              />
            ) : null}
            {meta.publishers?.[0] && meta.publishers[0] !== meta.developers?.[0] ? (
              <CreatorButton
                kind="publisher"
                name={meta.publishers[0]}
                gameId={game.id}
                focusKey={DETAIL_FOCUS.publisher}
              />
            ) : null}
          </div>
          <SteamScreenshots game={game} />
        </div>
      )}

      <ActionBar
        game={game}
        running={isRunning}
        canInstall={storeName !== undefined || addedNotInstalled}
        install={addedNotInstalled ? addedInstall : install}
        menuOpen={menuAnchor !== null}
        achievementsOpen={achievementsOpen}
        onPlay={() => play()}
        playsRecomp={!!recompToPlay(game)}
        coop={
          meta.coop && game.installed
            ? { onPress: () => startCoop(game), busy: coopBusy }
            : undefined
        }
        recomp={
          // A recompilation of it is installed and Play already starts it: the UP square opens the Recompilation page
          // instead (accent-filled, as an installed recompilation), except while one installs or updates (UP shows its
          // progress). While its original can be downloaded from a paired PC, UP starts the recompilation as usual.
          ((up) =>
            recompToPlay(game) && !hostCopy && up && up.state !== 'busy'
              ? {
                  state: 'installed' as const,
                  onPress: () => openRecomp(),
                  label: t('gameDetail.recomp.squareLabel')
                }
              : up)(recompButton(title, recompInfo, recompProgress, launchRecomp, openRecomp))
        }
        peerParty={
          peerPartyStatus?.supported
            ? {
                onPress: () => startPeerParty(game),
                busy: !!peerPartyProgress,
                label: peerPartyProgress
                  ? peerPartyProgressText(peerPartyProgress)
                  : peerPartyTitle(peerPartyStatus),
                running: peerPartySession?.gameId === game.id
              }
            : undefined
        }
        upgrade={
          // An installed PC game of this PC (not a ROM, not a host's game) with a folder to work on.
          game.source !== 'rom' && game.installed && !game.remote && !!game.installDir
            ? { onPress: setUpgradeAnchor, open: upgradeAnchor !== null }
            : undefined
        }
        onInstall={addedNotInstalled ? installAdded : installGame}
        queued={
          queuePosition !== null
            ? {
                position: queuePosition,
                after: queueAfter,
                waitingFor: queueWaitingFor,
                paused: !!queueEntry?.paused,
                from: queueEntry?.from,
                onRemove: () => void removeFromQueue(queueId),
                onResume: () => void resumeInQueue(queueId)
              }
            : undefined
        }
        streaming={{
          session,
          download: hostCopy ? sourceDownload : download,
          onStream: () => stream(streamFrom[0]?.hostId),
          onStop: () => void stopStream(),
          onDownload: startDownload,
          ...(hostCopy ? { hostCopy } : {})
        }}
        playRef={playAnchor}
        onOpenMenu={openMenu}
        onToggleAchievements={() => setAchievementsOpen((open) => !open)}
        onOpenEdit={() => setEditOpen(true)}
        onOpenQuickPanel={() => openModal({ type: 'quickpanel' })}
        onToggleFavorite={toggleFavorite}
      />

      {similarAnchor ? (
        <SimilarMenu
          key={game.id}
          game={game}
          anchor={similarAnchor}
          onClose={() => setSimilarAnchor(null)}
        />
      ) : null}
      {upgradeAnchor ? (
        <UpgradeMenu game={game} anchor={upgradeAnchor} onClose={() => setUpgradeAnchor(null)} />
      ) : null}
      {menuAnchor ? (
        <PlayMenu
          game={game}
          install={install}
          storeName={storeName}
          anchor={menuAnchor}
          onClose={closeMenu}
          onPlay={(emulatorId) => {
            closeMenu()
            play(emulatorId)
          }}
          onInstall={() => {
            closeMenu()
            installGame()
          }}
          queue={
            queuePosition !== null
              ? {
                  position: queuePosition,
                  paused: !!queueEntry?.paused,
                  onRemove: () => void removeFromQueue(queueId),
                  onPause: () => void pauseInQueue(queueId),
                  onResume: () => void resumeInQueue(queueId)
                }
              : undefined
          }
          onCloseDetail={onClose}
          streaming={{
            hosts: streamFrom,
            session,
            download: hostCopy ? sourceDownload : download,
            onStream: (hostId) => {
              closeMenu()
              stream(hostId)
            },
            onStop: () => {
              closeMenu()
              void stopStream()
            },
            onDownload: () => {
              closeMenu()
              startDownload()
            },
            onCancelDownload: () => {
              closeMenu()
              stopDownload()
            },
            ...(hostCopy ? { hostCopy } : {})
          }}
          onRecomp={
            recompInfo
              ? () => {
                  closeMenu()
                  openRecomp()
                }
              : undefined
          }
          onPs3Update={
            isPs3 && !ps3Busy
              ? () => {
                  closeMenu()
                  updatePs3()
                }
              : undefined
          }
          onDeleteRecomp={
            deletableRecomp && !recompBusy(deletableProgress)
              ? () => {
                  closeMenu()
                  void deleteRecomp()
                }
              : undefined
          }
          onManageDlc={
            canManageSteamDlc(game)
              ? () => {
                  closeMenu()
                  openModal({ type: 'steam-dlc', gameId: game.id, mode: 'manage' })
                }
              : undefined
          }
          onCoopSetup={
            meta.coop && game.installed
              ? () => {
                  closeMenu()
                  setCoopSetupOpen(true)
                }
              : undefined
          }
        />
      ) : null}
      {coopSetupOpen ? (
        <CoopSetupSheet game={game} onClose={() => setCoopSetupOpen(false)} />
      ) : null}
      {exeChoice ? (
        <RecompExeChooser
          title={title}
          executables={exeChoice}
          onChosen={() => {
            setExeChoice(null)
            launchRecomp(exeChoice.id)
          }}
          onClose={() => setExeChoice(null)}
        />
      ) : null}
      {editOpen ? (
        <GameEditSheet key={game.id} game={game} onClose={() => setEditOpen(false)} />
      ) : null}

      <PanelActions onOptions={openMenuFromButton} onFavorite={toggleFavorite} />
      <ButtonHints
        hints={[
          { button: 'a', label: t('gameDetail.hints.select') },
          { button: 'b', label: t('gameDetail.hints.back') },
          // A host's game is a favourite on its host, only while the favourites sync is on.
          ...(isRemote && !remoteFavorites
            ? []
            : [
                {
                  button: 'x' as const,
                  label: favorite
                    ? t('gameDetail.hints.unfavourite')
                    : t('gameDetail.hints.favourite')
                }
              ]),
          { button: 'y', label: t('gameDetail.hints.options') }
        ]}
      />
    </Modal>
  )
}

/**
 * The description to show: the full text (the CSS clamp keeps it to --modal-desc-lines until expanded),
 * falling back to the short one; null when the game has neither.
 */
function describe(meta: GameMetadata): string | null {
  const full = meta.description?.trim() ?? ''
  const short = meta.shortDescription?.trim() ?? ''
  return full || short || null
}

/**
 * A chip that opens the Library filtered by what it names (mouse, touch, or A on a gamepad). `active` (a genre on the
 * Library's current tab) draws it pressed.
 */
function FilterChip({
  focusKey,
  title,
  className,
  active,
  onPress,
  children
}: {
  focusKey: string
  title: string
  className?: string
  active?: boolean
  onPress: () => void
  children: string
}): ReactElement {
  const { ref, props: controlProps } = useFocusableControl<HTMLButtonElement>({
    focusKey,
    onPress,
    scroll: false
  })
  return (
    <button
      ref={ref}
      type="button"
      className={cx('chip', 'chip--pressable', active && 'chip--on', className)}
      aria-pressed={active}
      title={title}
      {...controlProps}
    >
      {children}
    </button>
  )
}

/**
 * A genre or Steam tag chip that is a Genre filter choice: pressed, the choice is added to the Library's current tab
 * (its other filters kept) and the Library opens there on this game; pressed while the tab has it, it goes.
 */
function GenreChip({
  focusKey,
  filterId,
  filterName,
  gameId,
  className,
  children
}: {
  focusKey: string
  filterId: string
  filterName: string
  gameId: string
  className?: string
  children: string
}): ReactElement {
  const t = useT()
  const active = useTabChoiceActive({ kind: 'genre', id: filterId })
  return (
    <FilterChip
      focusKey={focusKey}
      title={
        active
          ? t('gameDetail.chips.removeFilter', { name: filterName })
          : t('gameDetail.chips.addFilter', { name: filterName })
      }
      className={className}
      active={active}
      onPress={() =>
        toggleTabChoice({ kind: 'genre', id: filterId }, gameId, (view) =>
          libraryShowsGame(gameId, view)
        )
      }
    >
      {children}
    </FilterChip>
  )
}

/** Stands for the date while the sentence is split around it (a character no translation contains). */
const DATE_MARK = '\u0000'

/**
 * "Released <date>" with the date in bold: the whole sentence is translated with {date} where the language puts it,
 * then split there so the date can be its own element.
 */
function Released({ date }: { date: string }): ReactElement {
  const t = useT()
  const [before = '', after = ''] = t('gameDetail.meta.released', { date: DATE_MARK }).split(
    DATE_MARK
  )
  return (
    <span>
      {before}
      <strong>{date}</strong>
      {after}
    </span>
  )
}

/** Inline "More" / "Less" expander after the description. */
function MoreButton({
  expanded,
  onToggle
}: {
  expanded: boolean
  onToggle: () => void
}): ReactElement {
  const t = useT()
  const { ref, props: controlProps } = useFocusableControl<HTMLButtonElement>({
    focusKey: DETAIL_FOCUS.more,
    onPress: onToggle,
    scroll: false
  })
  return (
    <button
      ref={ref}
      type="button"
      className="gdetail__more"
      aria-expanded={expanded}
      {...controlProps}
    >
      {expanded ? t('gameDetail.description.less') : t('gameDetail.description.more')}
    </button>
  )
}

/** Registers the panel's X / Y shortcuts on the modal's own action layer (it renders nothing). */
function PanelActions({
  onOptions,
  onFavorite
}: {
  onOptions: () => boolean
  onFavorite: () => void
}): null {
  useActionHandlers({
    // As on a cover in the Library: X favourites, Y opens the options.
    x: () => {
      onFavorite()
      return true
    },
    y: () => onOptions()
  })
  return null
}

/**
 * The game has a Nucleus Co-op handler: split-screen Co-Op on one PC (the Co-Op button). Right of the players badge.
 */
function CoopBadge({ maxPlayers }: { maxPlayers?: number }): ReactElement {
  const t = useT()
  const text = maxPlayers
    ? t('gameDetail.badges.coopMax', { max: maxPlayers })
    : t('gameDetail.badges.coop')
  return (
    <div className="gdetail__players gdetail__coop" role="img" aria-label={text} title={text}>
      <span className="gdetail__coop-label">{t('gameDetail.badges.coopLabel')}</span>
      <Users className="gdetail__players-icon" aria-hidden="true" />
    </div>
  )
}

/**
 * How the game is played (lib/controls.ts): a controller (full or partial support, Steam's categories; every console
 * game), VR, else keyboard and mouse. The word above its icon, left of the players badge.
 */
function ControlsBadge({ game }: { game: Game }): ReactElement {
  const controls = gameControls(game)
  const icon =
    controls.kind === 'vr' || controls.kind === 'vr-only' ? (
      <Glasses className="gdetail__players-icon" aria-hidden="true" />
    ) : controls.kind === 'keyboard' ? (
      <Keyboard className="gdetail__players-icon" aria-hidden="true" />
    ) : (
      <Gamepad className="gdetail__players-icon" aria-hidden="true" />
    )
  return (
    <div
      className={cx('gdetail__players', 'gdetail__controls', `gdetail__controls--${controls.kind}`)}
      role="img"
      aria-label={controls.text}
      title={controls.text}
    >
      <span className="gdetail__coop-label">{controls.label}</span>
      {icon}
    </div>
  )
}

/**
 * How many players the game takes (LaunchBox's MaxPlayers): the number above a controller, at the top left of the
 * game's page.
 */
function PlayersBadge({ players }: { players: number }): ReactElement {
  const t = useT()
  const text = t('gameDetail.players.upTo', { count: players })
  return (
    <div className="gdetail__players" role="img" aria-label={text} title={text}>
      <span className="gdetail__players-count">{players}</span>
      <Gamepad2 className="gdetail__players-icon" aria-hidden="true" />
    </div>
  )
}
