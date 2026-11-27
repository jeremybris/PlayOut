import { recompAddedId, recompInPlaceOf, recompToPlay } from '@shared/recomp-play'
import type {
  EmulatorCommand,
  Game,
  InstallProgress,
  MetadataCandidate,
  RemoteGameInfo,
  RomDownloadProgress,
  ScraperId,
  StoreSourceId,
  StreamSession,
  SystemInfo
} from '@shared/types'
import {
  ArrowBigUp,
  ArrowLeftRight,
  ChevronLeft,
  Cast,
  CircleStop,
  Cpu,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FolderOpen,
  Pause,
  Play,
  Puzzle,
  RefreshCw,
  Search,
  Store,
  Trash2,
  Users,
  X
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { effectiveEmulatorCommand } from '@shared/emulators'
import { api } from '../../api/client'
import { Chip } from '../../components/Chip'
import { Menu, MenuItem } from '../../components/MenuItem'
import { Spinner } from '../../components/Spinner'
import { TextField } from '../../components/TextField'
import { LayerContext, useActionHandlersOnLayer } from '../../hooks/useActionHandlers'
import { useFocusLayer } from '../../hooks/useFocusLayer'
import { useT } from '../../i18n'
import { FocusContext, setFocus } from '../../input/focus'
import { cx } from '../../lib/cx'
import { formatDate } from '../../lib/format'
import { displayTitle } from '../../lib/library'
import { createLog } from '../../lib/log'
import { formatBytes } from '../../lib/format'
import { downloadRunning, remotePrimaryAction, streamActive, streamBusy } from '../../lib/streaming'
import { queueStarting } from '../../state/installQueue'
import { canDeleteLocally, startLocalDelete } from '../../state/localDelete'
import { useInstallsStore } from '../../state/installs'
import { useLibraryStore } from '../../state/library'
import { useSettingsStore } from '../../state/settings'
import { useSystemStore } from '../../state/system'
import { useUiStore } from '../../state/ui'
import { useConvertStore, watchConversion } from '../../state/convert'
import { ipcErrorMessage } from '../../state/coop'
import { conversionsForGame, type GameConversion } from '@shared/convert'

const log = createLog('playmenu')

const MENU_FOCUS_KEY = 'playmenu'
/** Gap between the Play button's top edge and the menu, in canvas units. */
const MENU_GAP_U = 12

/** "Open <Store>": the URI that brings the store client forward (its library / downloads view). */
const STORE_CLIENT_URIS: Record<StoreSourceId, string> = {
  steam: 'steam://open/downloads',
  epic: 'com.epicgames.launcher://store/library',
  gog: 'goggalaxy://',
  ea: 'origin2://library/open',
  battlenet: 'battlenet://',
  ubisoft: 'uplay://',
  xbox: 'msxbox://'
}

const SCRAPER_NAMES: Record<ScraperId, string> = {
  steamgriddb: 'SteamGridDB',
  igdb: 'IGDB',
  screenscraper: 'ScreenScraper',
  thegamesdb: 'TheGamesDB',
  steam: 'Steam',
  hltb: 'HowLongToBeat',
  gog: 'GOG'
}

export interface PlayMenuProps {
  game: Game
  /** The tracked background install of this (uninstalled) game, if any. */
  install?: InstallProgress
  /** The store's name when the game comes from a store client ('Steam'); undefined for manual / rom games. */
  storeName?: string
  /** The Play split button; the menu opens above it, left-aligned. */
  anchor: HTMLElement
  onClose: () => void
  /** Launch, optionally with a specific emulator command id. */
  onPlay: (emulatorId?: string) => void
  /** Install (or retry) through the store client. */
  onInstall: () => void
  /**
   * Set while the game is in the install queue (0 = downloading now, 1 = next): a waiting game gets "Remove from
   * queue" in Install's / Download's place, the active one before its first progress Cancel tracking / Cancel
   * download; both call onRemove (the queue store's remove). Every queued game also gets "Pause download" or, once
   * `paused`, "Resume download" (onPause / onResume) right after that first entry.
   */
  queue?: {
    position: number
    paused?: boolean
    onRemove: () => void
    onPause?: () => void
    onResume?: () => void
  }
  /** Close the whole detail panel (after hiding or removing the game). */
  onCloseDetail: () => void
  /** Co-Op setup (games with a Co-Op handler). */
  onCoopSetup?: () => void
  /** Open the Recompilation page (games with a recompilation; the UP button launches it once installed). */
  onRecomp?: () => void
  /** Delete the installed recompilation and the files it built (asks first); only while one is installed. */
  onDeleteRecomp?: () => void
  /** A PS3 game on this PC: check Sony's update list and install what it misses through RPCS3. */
  onPs3Update?: () => void
  /** An installed Steam game of this PC: turn its DLC on or off (screens/SteamDlc). */
  onManageDlc?: () => void
  /**
   * Streaming (ARCHITECTURE.md §4.13). `hosts`: the paired hosts the game streams from (a host-only game's own host,
   * or the hosts that also have this PC's game); `session` / `download`: this game's stream and ROM download.
   */
  streaming?: {
    hosts: RemoteGameInfo[]
    session: StreamSession | null
    download: RomDownloadProgress | null
    onStream: (hostId?: string) => void
    onStop: () => void
    onDownload: () => void
    onCancelDownload: () => void
    /** A recompilation-only game's original on a paired PC: Download from it (GameDetail's hostCopy). */
    hostCopy?: RemoteGameInfo
  }
}

type Mode = 'menu' | 'search' | 'convert'

type SearchState =
  | { status: 'idle' }
  | { status: 'searching' }
  | { status: 'done'; candidates: MetadataCandidate[] }
  | { status: 'error'; message: string }

/**
 * The launch / context menu behind the Play button's chevron (and Y): alternative emulators for ROMs,
 * install folder, store page, metadata refresh and search, hide, and remove for manual games. For an
 * uninstalled game the entries that need an install (folder, emulators) are hidden and Install, Cancel
 * tracking (while an install is tracked) and Open <Store> appear instead. Streaming adds "Stream from <host>" for
 * the paired hosts that have the game, and gives a host-only game Stream / Download / Cancel download first. A game
 * waiting in the install queue starts with "Remove from queue" instead, and any queued game offers Pause / Resume download.
 * Portaled to <body> (the panel's transform would trap a fixed backdrop) with its own focus and action layer.
 */
export function PlayMenu({
  game,
  install,
  storeName,
  anchor,
  onClose,
  onPlay,
  onInstall,
  queue,
  onCloseDetail,
  onCoopSetup,
  onRecomp,
  onDeleteRecomp,
  onPs3Update,
  onManageDlc,
  streaming
}: PlayMenuProps): ReactElement {
  const t = useT()
  const toast = useUiStore((s) => s.toast)
  const openModal = useUiStore((s) => s.openModal)
  const applyGame = useLibraryStore((s) => s.applyGame)
  const removeFromStore = useLibraryStore((s) => s.removeGame)
  const forgetInstall = useInstallsStore((s) => s.remove)
  const preferredEmulators = useSettingsStore((s) => s.settings?.emulators.preferred)
  const runningId = useSystemStore((s) => s.running?.gameId ?? null)

  const [mode, setMode] = useState<Mode>('menu')
  const [system, setSystem] = useState<SystemInfo | null>(null)
  const [query, setQuery] = useState(displayTitle(game))
  const [search, setSearch] = useState<SearchState>({ status: 'idle' })
  const [position, setPosition] = useState(() => place(anchor))

  const { ref, layerId } = useFocusLayer<HTMLDivElement>({
    focusKey: MENU_FOCUS_KEY,
    preferredChildFocusKey: `${MENU_FOCUS_KEY}:play`
  })
  useActionHandlersOnLayer(layerId, {
    back: () => {
      if (mode === 'search') {
        setMode('menu')
        void setFocus(`${MENU_FOCUS_KEY}:search`)
      } else if (mode === 'convert') leaveConvert()
      else onClose()
      return true
    }
  })

  useEffect(() => {
    const update = (): void => setPosition(place(anchor))
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [anchor])

  // ROM games: the system's emulator list for "Play with …".
  // (None for a game its recompilation stands in for, its disc image deleted or its game file gone: no emulator can
  // start it.)
  const systemId =
    game.launch.kind === 'emulator' && !recompInPlaceOf(game) ? game.launch.systemId : null
  useEffect(() => {
    if (!systemId) return undefined
    let cancelled = false
    api
      .getSystems()
      .then((systems) => {
        if (!cancelled) setSystem(systems.find((s) => s.id === systemId) ?? null)
      })
      .catch((err) => {
        log.error('getSystems failed', err)
        if (!cancelled) toast(t('gameDetail.toasts.emulatorListFailed'), 'error')
      })
    return () => {
      cancelled = true
    }
  }, [systemId, toast, t])

  const runSearch = useCallback(
    (text: string) => {
      const q = text.trim()
      if (!q) {
        setSearch({ status: 'idle' })
        return
      }
      setSearch({ status: 'searching' })
      api
        .searchMetadata(game.id, q)
        .then((candidates) => setSearch({ status: 'done', candidates }))
        .catch((err) => {
          log.error('searchMetadata failed', err)
          setSearch({ status: 'error', message: String(err) })
        })
    },
    [game.id]
  )

  // Convert: the game's own file through its platform's conversions only (shared/convert conversionsForGame: those that
  // keep it in the library), as Settings › Convert runs them (the result goes next to it; the game keeps its play
  // time and art). Known once its system is (loaded above for "Play with …"). Not while the game runs (its file is in
  // use) or another conversion does.
  const conversions = conversionsForGame(game, system)
  const convertRunning = useConvertStore((s) => !!s.status?.running)
  const gameRunning = runningId === game.id
  const convertBlocked = convertRunning || gameRunning
  // Entries from more than one of the game's file types (rare): each names its own.
  const mixedFrom =
    new Set(conversions.map((c) => (c.from.folder ? 'folder' : c.from.exts.join(',')))).size > 1
  const enterConvert = (): void => setMode('convert')
  const leaveConvert = (): void => {
    setMode('menu')
    void setFocus(`${MENU_FOCUS_KEY}:convert`)
  }
  useEffect(() => {
    if (mode === 'convert')
      void setFocus(`${MENU_FOCUS_KEY}:${convertBlocked ? 'conv-back' : 'conv:0'}`)
  }, [mode, convertBlocked])
  const startConversion = (conversion: GameConversion): void => {
    const title = displayTitle(game)
    api
      .startConvert({
        platformId: conversion.platformId,
        pairId: conversion.pairId,
        reversed: conversion.reversed,
        paths: [conversion.path]
      })
      .then((next) => {
        watchConversion(conversion.path, title, conversion.to.label)
        useConvertStore.setState({ status: next })
        toast(t('gameDetail.playMenu.convert.started', { title, to: conversion.to.label }), 'info')
      })
      .catch((err) => {
        log.error('startConvert failed', err)
        toast(ipcErrorMessage(err) || t('gameDetail.playMenu.convert.failed', { title }), 'error')
      })
    onClose()
  }

  const searchStarted = useRef(false)
  const enterSearch = (): void => {
    setMode('search')
    if (!searchStarted.current) {
      searchStarted.current = true
      runSearch(query)
    }
  }
  useEffect(() => {
    if (mode === 'search') void setFocus(`${MENU_FOCUS_KEY}:query`)
  }, [mode])

  const applyCandidate = (candidate: MetadataCandidate): void => {
    api
      .applyMetadata(game.id, candidate)
      .then((updated) => {
        applyGame(updated)
        toast(
          t('gameDetail.playMenu.toasts.applied', { source: SCRAPER_NAMES[candidate.scraper] }),
          'success'
        )
        onClose()
      })
      .catch((err) => {
        log.error('applyMetadata failed', err)
        toast(t('gameDetail.playMenu.toasts.applyFailed'), 'error')
      })
  }

  const openFolder = (): void => {
    // Played from its recompilation: that recompilation's folder.
    const recompId = recompToPlay(game)
    if (recompId) {
      api.openRecompFolder(recompId, 'install').catch((err) => {
        log.error('openRecompFolder failed', err)
        toast(t('gameDetail.playMenu.toasts.recompFolderFailed'), 'error')
      })
      onClose()
      return
    }
    const file = game.exePath ?? game.romPath
    const call = file
      ? api.showItemInFolder(file)
      : game.installDir
        ? api.openPath(game.installDir)
        : null
    if (!call) return
    call.catch((err) => {
      log.error('open folder failed', err)
      toast(t('gameDetail.playMenu.toasts.installFolderFailed'), 'error')
    })
    onClose()
  }

  const storeUrl =
    game.metadata.links?.store ??
    (game.source === 'steam' ? `steam://store/${game.externalId}` : undefined)
  const openStore = (): void => {
    if (!storeUrl) return
    api.openExternal(storeUrl).catch((err) => {
      log.error('openExternal failed', err)
      toast(t('gameDetail.playMenu.toasts.storePageFailed'), 'error')
    })
    onClose()
  }

  // Uninstalled store games: the install actions and the client itself.
  const tracking = !game.installed && install !== undefined && install.state !== 'failed'
  const storeClientUri =
    storeName && game.source !== 'manual' && game.source !== 'rom'
      ? STORE_CLIENT_URIS[game.source]
      : undefined
  const cancelTracking = (): void => {
    api
      .cancelInstallTracking(game.id)
      .then(() => {
        forgetInstall(game.id)
        toast(
          storeName
            ? t('gameDetail.playMenu.toasts.trackingStopped', {
                title: displayTitle(game),
                store: storeName
              })
            : t('gameDetail.playMenu.toasts.trackingStoppedNoStore', { title: displayTitle(game) })
        )
      })
      .catch((err) => {
        log.error('cancelInstallTracking failed', err)
        toast(t('gameDetail.playMenu.toasts.stopTrackingFailed'), 'error')
      })
    onClose()
  }
  const openStoreClient = (): void => {
    if (!storeClientUri) return
    api.openExternal(storeClientUri).catch((err) => {
      log.error('openExternal failed', err)
      toast(t('gameDetail.playMenu.toasts.openStoreFailed', { store: storeName ?? '' }), 'error')
    })
    onClose()
  }

  const refreshMetadata = (): void => {
    api
      .refreshMetadata([game.id], { force: true })
      .then(() => toast(t('gameDetail.playMenu.toasts.refreshing', { title: displayTitle(game) })))
      .catch((err) => {
        log.error('refreshMetadata failed', err)
        toast(t('gameDetail.playMenu.toasts.refreshFailed'), 'error')
      })
    onClose()
  }

  const toggleHidden = (): void => {
    const hidden = !game.hidden
    api
      .updateGame(game.id, { hidden })
      .then((updated) => {
        applyGame(updated)
        toast(
          hidden
            ? t('gameDetail.playMenu.toasts.hidden', { title: displayTitle(updated) })
            : t('gameDetail.playMenu.toasts.shown', { title: displayTitle(updated) })
        )
        onClose()
        onCloseDetail()
      })
      .catch((err) => {
        log.error('updateGame failed', err)
        toast(
          hidden
            ? t('gameDetail.playMenu.toasts.hideFailed')
            : t('gameDetail.playMenu.toasts.showFailed'),
          'error'
        )
      })
  }

  const remove = (): void => {
    const title = displayTitle(game)
    onClose()
    openModal({
      type: 'confirm',
      title: t('gameDetail.playMenu.remove.title'),
      message: recompAddedId(game)
        ? t('gameDetail.playMenu.remove.messageRecomp', { title })
        : t('gameDetail.playMenu.remove.message', { title }),
      confirmLabel: t('gameDetail.playMenu.remove.confirm'),
      danger: true,
      onConfirm: () => {
        api
          .removeGame(game.id)
          .then(() => {
            removeFromStore(game.id)
            toast(t('gameDetail.playMenu.toasts.removed', { title }))
            onCloseDetail()
          })
          .catch((err) => {
            log.error('removeGame failed', err)
            toast(t('gameDetail.playMenu.toasts.removeFailed'), 'error')
          })
      }
    })
  }

  // Delete from this PC: the files (ROM, manual game's folder) or the store's own uninstall; main decides which.
  const deleteLocally = (): void => {
    onClose()
    void startLocalDelete(game, onCloseDetail)
  }

  const onBackdropClick = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) onClose()
  }

  // The command Play runs (the game's choice, the scan's, the preferred one, the default; selectCommand's order). A
  // saved choice may name a command PlayOut merged into another (aliases): the merged one is shown.
  const currentEmulator = system
    ? effectiveEmulatorCommand(system, game, preferredEmulators)?.id
    : undefined
  // Entries that need the game on disk are hidden while it is not installed.
  // Play starts the current emulator, so the others are listed; with a recompilation installed Play starts that, and
  // every emulator is listed (the game can still be played in its emulator).
  const playsRecompFirst = !!recompToPlay(game)
  const alternatives =
    system && game.installed
      ? system.emulators.filter((e) => playsRecompFirst || e.id !== currentEmulator)
      : []
  const currentLabel = system?.emulators.find((e) => e.id === currentEmulator)?.label
  const canOpenFolder =
    !!recompToPlay(game) || (game.installed && !!(game.exePath ?? game.romPath ?? game.installDir))

  // Streaming. A host-only game's first entry is its Stream / Download (Cancel download while one runs); a ROM that
  // downloads streams from its host too. This PC's own games list "Stream from <host>" for each host that has them.
  // Entries that write this PC's record of the game (metadata, hide) are left out for a host's game.
  const remote = game.remote
  const remoteAction = remotePrimaryAction(game)
  const session = streaming?.session ?? null
  const live = streamActive(session)
  const connecting = streamBusy(session)
  const downloading = downloadRunning(streaming?.download)
  const remoteSize = remote?.downloadable && remote.sizeBytes ? formatBytes(remote.sizeBytes) : null
  // A host-only PC game on several hosts: the first entry streams from its own host, the rest are listed after it.
  const streamEntries =
    !streaming || live
      ? []
      : remote && remoteAction === 'stream'
        ? streaming.hosts.filter((h) => h.hostId !== remote.hostId)
        : streaming.hosts
  // A finished download is about to become this PC's game: no second Download while the library catches up.
  const downloaded = streaming?.download?.state === 'done'
  // The install queue: a waiting game leaves it; the active one with no progress yet stops (never Install / Download).
  // An installed game of this PC is never treated as queued: Play stays first.
  const inQueue = game.installed && !remote ? undefined : queue
  const waitingInQueue = !!inQueue && inQueue.position > 0
  const starting = queueStarting(
    inQueue?.position,
    remote || streaming?.hostCopy ? streaming?.download : install
  )
  const leaveQueue = (): void => {
    queue?.onRemove()
    onClose()
  }
  const togglePause = inQueue?.paused ? inQueue.onResume : inQueue?.onPause

  return createPortal(
    <div className="playmenu-backdrop" onClick={onBackdropClick}>
      <LayerContext.Provider value={layerId}>
        <FocusContext.Provider value={MENU_FOCUS_KEY}>
          <div
            ref={ref}
            className={cx('playmenu', mode === 'search' && 'playmenu--search')}
            style={{ left: position.left, bottom: position.bottom }}
            role="menu"
            aria-label={t('gameDetail.playMenu.label')}
            data-focus-key={MENU_FOCUS_KEY}
          >
            {mode === 'menu' ? (
              <Menu>
                {waitingInQueue ? (
                  <MenuItem
                    focusKey={`${MENU_FOCUS_KEY}:play`}
                    icon={<X />}
                    label={t('gameDetail.playMenu.removeFromQueue')}
                    onPress={leaveQueue}
                  />
                ) : starting ? (
                  <MenuItem
                    focusKey={`${MENU_FOCUS_KEY}:play`}
                    icon={<CircleStop />}
                    label={
                      remote || streaming?.hostCopy
                        ? t('gameDetail.playMenu.cancelDownload')
                        : t('gameDetail.playMenu.cancelTracking')
                    }
                    trailing={
                      <span className="playmenu__hint">{t('gameDetail.playMenu.starting')}</span>
                    }
                    onPress={leaveQueue}
                  />
                ) : remote && streaming ? (
                  live ? (
                    <MenuItem
                      focusKey={`${MENU_FOCUS_KEY}:play`}
                      icon={<CircleStop />}
                      label={t('gameDetail.playMenu.stopStreaming')}
                      onPress={streaming.onStop}
                    />
                  ) : connecting ? (
                    // Starting can take a while (Moonlight's pairing, the host's start): Cancel ends it.
                    <MenuItem
                      focusKey={`${MENU_FOCUS_KEY}:play`}
                      icon={<CircleStop />}
                      label={t('gameDetail.playMenu.cancelStream')}
                      trailing={<span className="playmenu__hint">{remote.hostName}</span>}
                      onPress={streaming.onStop}
                    />
                  ) : downloading ? (
                    <MenuItem
                      focusKey={`${MENU_FOCUS_KEY}:play`}
                      icon={<CircleStop />}
                      label={t('gameDetail.playMenu.cancelDownload')}
                      onPress={streaming.onCancelDownload}
                    />
                  ) : downloaded ? null : remoteAction === 'download' ? (
                    <MenuItem
                      focusKey={`${MENU_FOCUS_KEY}:play`}
                      icon={<Download />}
                      label={
                        streaming.download?.state === 'failed'
                          ? t('gameDetail.playMenu.retryDownload')
                          : t('gameDetail.playMenu.download')
                      }
                      trailing={
                        <span className="playmenu__hint">{remoteSize ?? remote.hostName}</span>
                      }
                      onPress={streaming.onDownload}
                    />
                  ) : remoteAction === 'stream' ? (
                    <MenuItem
                      focusKey={`${MENU_FOCUS_KEY}:play`}
                      icon={<Cast />}
                      label={t('gameDetail.playMenu.stream')}
                      trailing={<span className="playmenu__hint">{remote.hostName}</span>}
                      onPress={() => streaming.onStream(remote.hostId)}
                    />
                  ) : (
                    // Neither streams nor downloads: say so (and the menu keeps something to focus).
                    <MenuItem
                      focusKey={`${MENU_FOCUS_KEY}:play`}
                      icon={<Cast />}
                      label={t('gameDetail.playMenu.notAvailableFrom', { host: remote.hostName })}
                      disabled
                    />
                  )
                ) : game.installed || recompInPlaceOf(game) ? (
                  <>
                    <MenuItem
                      focusKey={`${MENU_FOCUS_KEY}:play`}
                      icon={<Play />}
                      label={t('gameDetail.playMenu.play')}
                      trailing={
                        // Play starts the installed recompilation (its emulators stay below as Play with …).
                        recompToPlay(game) ? (
                          <span className="playmenu__hint">
                            {t('gameDetail.playMenu.recompilationHint')}
                          </span>
                        ) : currentLabel ? (
                          <span className="playmenu__hint">{currentLabel}</span>
                        ) : undefined
                      }
                      onPress={() => onPlay()}
                    />
                    {/* Its original on a paired PC: download it, so the recompilation has its files. */}
                    {streaming?.hostCopy && !downloaded ? (
                      downloading ? (
                        <MenuItem
                          focusKey={`${MENU_FOCUS_KEY}:cancel-download`}
                          icon={<X />}
                          label={t('gameDetail.playMenu.cancelDownload')}
                          onPress={streaming.onCancelDownload}
                        />
                      ) : (
                        <MenuItem
                          focusKey={`${MENU_FOCUS_KEY}:download`}
                          icon={<Download />}
                          label={t('gameDetail.playMenu.downloadFrom', {
                            host: streaming.hostCopy.hostName
                          })}
                          trailing={
                            streaming.hostCopy.sizeBytes ? (
                              <span className="playmenu__hint">
                                {formatBytes(streaming.hostCopy.sizeBytes)}
                              </span>
                            ) : undefined
                          }
                          onPress={streaming.onDownload}
                        />
                      )
                    ) : null}
                  </>
                ) : tracking ? (
                  <MenuItem
                    focusKey={`${MENU_FOCUS_KEY}:play`}
                    icon={<CircleStop />}
                    label={t('gameDetail.playMenu.cancelTracking')}
                    onPress={cancelTracking}
                  />
                ) : storeName ? (
                  <MenuItem
                    focusKey={`${MENU_FOCUS_KEY}:play`}
                    icon={<Download />}
                    label={
                      install?.state === 'failed'
                        ? t('gameDetail.playMenu.retryInstall')
                        : t('gameDetail.playMenu.install')
                    }
                    trailing={<span className="playmenu__hint">{storeName}</span>}
                    onPress={onInstall}
                  />
                ) : null}
                {inQueue && togglePause ? (
                  <MenuItem
                    focusKey={`${MENU_FOCUS_KEY}:pause`}
                    icon={inQueue.paused ? <Play /> : <Pause />}
                    label={
                      inQueue.paused
                        ? t('gameDetail.playMenu.resumeDownload')
                        : t('gameDetail.playMenu.pauseDownload')
                    }
                    trailing={
                      inQueue.paused ? (
                        <span className="playmenu__hint">{t('gameDetail.playMenu.paused')}</span>
                      ) : undefined
                    }
                    onPress={() => {
                      togglePause()
                      onClose()
                    }}
                  />
                ) : null}
                {!remote && (live || connecting) && streaming ? (
                  <MenuItem
                    focusKey={`${MENU_FOCUS_KEY}:stop`}
                    icon={<CircleStop />}
                    label={
                      live
                        ? t('gameDetail.playMenu.stopStreaming')
                        : t('gameDetail.playMenu.cancelStream')
                    }
                    onPress={streaming.onStop}
                  />
                ) : null}
                {!remote && !game.installed && storeClientUri ? (
                  <MenuItem
                    focusKey={`${MENU_FOCUS_KEY}:client`}
                    icon={<Store />}
                    label={t('gameDetail.playMenu.openStore', { store: storeName ?? '' })}
                    onPress={openStoreClient}
                  />
                ) : null}
                {alternatives.map((command) => (
                  <MenuItem
                    key={command.id}
                    focusKey={`${MENU_FOCUS_KEY}:emu:${command.id}`}
                    icon={<Cpu />}
                    label={t('gameDetail.playMenu.playWith', { emulator: command.label })}
                    trailing={
                      system && !isAvailable(command, system) ? (
                        <Chip>{t('gameDetail.playMenu.notFound')}</Chip>
                      ) : undefined
                    }
                    onPress={() => onPlay(command.id)}
                  />
                ))}
                {streaming
                  ? streamEntries.map((host) => (
                      <MenuItem
                        key={host.hostId}
                        focusKey={`${MENU_FOCUS_KEY}:stream:${host.hostId}`}
                        icon={<Cast />}
                        label={t('gameDetail.playMenu.streamFrom', { host: host.hostName })}
                        disabled={connecting}
                        onPress={() => streaming.onStream(host.hostId)}
                      />
                    ))
                  : null}
                {onRecomp ? (
                  <MenuItem
                    focusKey={`${MENU_FOCUS_KEY}:recomp`}
                    icon={<ArrowBigUp />}
                    label={t('gameDetail.playMenu.recompilation')}
                    onPress={onRecomp}
                  />
                ) : null}
                {onPs3Update ? (
                  <MenuItem
                    focusKey={`${MENU_FOCUS_KEY}:ps3-update`}
                    icon={<Download />}
                    label={t('gameDetail.playMenu.ps3Update')}
                    onPress={onPs3Update}
                  />
                ) : null}
                {onManageDlc ? (
                  <MenuItem
                    focusKey={`${MENU_FOCUS_KEY}:dlc`}
                    icon={<Puzzle />}
                    label={t('gameDetail.playMenu.manageDlc')}
                    onPress={onManageDlc}
                  />
                ) : null}
                {onDeleteRecomp ? (
                  <MenuItem
                    focusKey={`${MENU_FOCUS_KEY}:recomp-delete`}
                    icon={<Trash2 />}
                    label={t('gameDetail.playMenu.deleteRecomp')}
                    onPress={onDeleteRecomp}
                  />
                ) : null}
                {onCoopSetup ? (
                  <MenuItem
                    focusKey={`${MENU_FOCUS_KEY}:coop`}
                    icon={<Users />}
                    label={t('gameDetail.playMenu.coopSetup')}
                    onPress={onCoopSetup}
                  />
                ) : null}
                {conversions.length ? (
                  <MenuItem
                    focusKey={`${MENU_FOCUS_KEY}:convert`}
                    icon={<ArrowLeftRight />}
                    label={t('gameDetail.playMenu.convertEntry')}
                    onPress={enterConvert}
                  />
                ) : null}
                {canOpenFolder ? (
                  <MenuItem
                    focusKey={`${MENU_FOCUS_KEY}:folder`}
                    icon={<FolderOpen />}
                    label={t('gameDetail.playMenu.openFolder')}
                    onPress={openFolder}
                  />
                ) : null}
                {storeUrl ? (
                  <MenuItem
                    focusKey={`${MENU_FOCUS_KEY}:store`}
                    icon={<ExternalLink />}
                    label={t('gameDetail.playMenu.openStorePage')}
                    onPress={openStore}
                  />
                ) : null}
                {remote ? null : (
                  <>
                    <MenuItem
                      focusKey={`${MENU_FOCUS_KEY}:refresh`}
                      icon={<RefreshCw />}
                      label={t('gameDetail.playMenu.refreshMetadata')}
                      onPress={refreshMetadata}
                    />
                    <MenuItem
                      focusKey={`${MENU_FOCUS_KEY}:search`}
                      icon={<Search />}
                      label={t('gameDetail.playMenu.searchMetadataEntry')}
                      onPress={enterSearch}
                    />
                    <MenuItem
                      focusKey={`${MENU_FOCUS_KEY}:hide`}
                      icon={game.hidden ? <Eye /> : <EyeOff />}
                      label={
                        game.hidden
                          ? t('gameDetail.playMenu.showGame')
                          : t('gameDetail.playMenu.hideGame')
                      }
                      onPress={toggleHidden}
                    />
                  </>
                )}
                {/* A game added by its .exe, or a recompilation added from the browser and not installed (an installed
                    one has Delete recompilation). */}
                {!remote &&
                (game.source === 'manual' || (!!recompAddedId(game) && !recompToPlay(game))) ? (
                  <MenuItem
                    focusKey={`${MENU_FOCUS_KEY}:remove`}
                    icon={<Trash2 />}
                    label={t('gameDetail.playMenu.removeFromLibrary')}
                    danger
                    onPress={remove}
                  />
                ) : null}
                {canDeleteLocally(game, { runningId, queued: !!queue || tracking }) ? (
                  <MenuItem
                    focusKey={`${MENU_FOCUS_KEY}:delete-local`}
                    icon={<Trash2 />}
                    label={t('gameDetail.playMenu.deleteFromPc')}
                    danger
                    onPress={deleteLocally}
                  />
                ) : null}
              </Menu>
            ) : mode === 'convert' ? (
              <Menu
                aria-label={t('gameDetail.playMenu.convert.label', { title: displayTitle(game) })}
              >
                <MenuItem
                  focusKey={`${MENU_FOCUS_KEY}:conv-back`}
                  icon={<ChevronLeft />}
                  label={t('gameDetail.playMenu.convert.back')}
                  trailing={
                    <span className="playmenu__hint">
                      {gameRunning
                        ? t('gameDetail.playMenu.convert.closeGameFirst')
                        : convertRunning
                          ? t('gameDetail.playMenu.convert.conversionRunning')
                          : mixedFrom
                            ? null
                            : conversions[0]?.from.label}
                    </span>
                  }
                  onPress={leaveConvert}
                />
                {conversions.map((conversion, index) => (
                  <MenuItem
                    key={`${conversion.pairId}:${conversion.reversed}`}
                    focusKey={`${MENU_FOCUS_KEY}:conv:${index}`}
                    icon={<ArrowLeftRight />}
                    label={
                      mixedFrom
                        ? t('gameDetail.playMenu.convert.fromTo', {
                            from: conversion.from.label,
                            to: conversion.to.label
                          })
                        : t('gameDetail.playMenu.convert.to', { to: conversion.to.label })
                    }
                    trailing={
                      conversion.playable ? undefined : (
                        <span className="playmenu__hint">
                          {t('gameDetail.playMenu.convert.notPlayableHere')}
                        </span>
                      )
                    }
                    disabled={convertBlocked}
                    onPress={() => startConversion(conversion)}
                  />
                ))}
              </Menu>
            ) : (
              <div className="playmenu__search">
                <div className="playmenu__search-title">
                  {t('gameDetail.playMenu.search.title')}
                </div>
                <TextField
                  focusKey={`${MENU_FOCUS_KEY}:query`}
                  value={query}
                  onChange={setQuery}
                  onSubmit={runSearch}
                  placeholder={t('gameDetail.playMenu.search.placeholder')}
                  icon={<Search />}
                  oskTitle={t('gameDetail.playMenu.search.title')}
                  clearable
                  autoFocus
                  aria-label={t('gameDetail.playMenu.search.title')}
                />
                <div className="playmenu__results">
                  {search.status === 'searching' ? (
                    <Spinner
                      label={t('gameDetail.playMenu.search.searching')}
                      className="playmenu__status"
                    />
                  ) : search.status === 'error' ? (
                    <p className="playmenu__status playmenu__status--error">
                      {t('gameDetail.playMenu.search.failed', { message: search.message })}
                    </p>
                  ) : search.status === 'done' && search.candidates.length === 0 ? (
                    <p className="playmenu__status">{t('gameDetail.playMenu.search.noMatches')}</p>
                  ) : search.status === 'done' ? (
                    <Menu aria-label={t('gameDetail.playMenu.search.matches')}>
                      {search.candidates.map((candidate, index) => (
                        <MenuItem
                          key={`${candidate.scraper}:${candidate.externalId}`}
                          focusKey={`${MENU_FOCUS_KEY}:cand:${index}`}
                          label={candidate.title}
                          trailing={
                            <span className="playmenu__cand-meta">
                              {[
                                candidate.releaseDate
                                  ? formatDate(candidate.releaseDate, 'year')
                                  : null,
                                candidate.platform,
                                SCRAPER_NAMES[candidate.scraper]
                              ]
                                .filter(Boolean)
                                .join(' · ')}
                            </span>
                          }
                          onPress={() => applyCandidate(candidate)}
                        />
                      ))}
                    </Menu>
                  ) : (
                    <p className="playmenu__status">{t('gameDetail.playMenu.search.prompt')}</p>
                  )}
                </div>
              </div>
            )}
          </div>
        </FocusContext.Provider>
      </LayerContext.Provider>
    </div>,
    document.body
  )
}

/** Menu position: left-aligned with the anchor, bottom edge MENU_GAP_U above it. */
function place(anchor: HTMLElement): { left: number; bottom: number } {
  const rect = anchor.getBoundingClientRect()
  const unit = window.innerHeight / 1080
  return {
    left: Math.round(rect.left),
    bottom: Math.round(window.innerHeight - rect.top + MENU_GAP_U * unit)
  }
}

const EMULATOR_PLACEHOLDER = /%EMULATOR_([A-Z0-9_-]+)%/gi

/**
 * True when the command's emulator was resolved. `availableEmulators` may hold command ids or the
 * %EMULATOR_X% names the commands reference (both shapes are accepted).
 */
function isAvailable(command: EmulatorCommand, system: SystemInfo): boolean {
  const available = new Set(system.availableEmulators.map((id) => id.toLowerCase()))
  if (available.has(command.id.toLowerCase())) return true
  const referenced = [...command.command.matchAll(EMULATOR_PLACEHOLDER)].map((m) =>
    m[1]!.toLowerCase()
  )
  return referenced.length > 0 && referenced.every((id) => available.has(id))
}
