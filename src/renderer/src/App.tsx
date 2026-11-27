import type { Game } from '@shared/types'
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { api } from './api/client'
import { ConfirmDialog } from './components/ConfirmDialog'
import { CoverMenuHost } from './components/CoverMenu'
import { ScanBars } from './components/ScanBars'
import { LaunchErrorDialog } from './components/LaunchErrorDialog'
import { PcSaveConflictDialog } from './components/PcSaveConflictDialog'
import { ToastHost } from './components/Toast'
import {
  MODAL_EXIT_FALLBACK_MS,
  ModalClosingContext,
  currentModalExitFallbackMs
} from './hooks/modalClosing'
import { useActionHandlers } from './hooks/useActionHandlers'
import { t } from './i18n'
import { initInput, setGamepadNeedsFocus } from './input'
import { setInputFrozen } from './input/actions'
import { pauseGamepadWhileOverlayOpen } from './input/overlayPause'
import { formatPlaytime } from './lib/format'
import { displayTitle, gamesByPlatform, visibleGames } from './lib/library'
import { LIBRARY_ALL_TAB, LIBRARY_SETTINGS_TAB, libraryTabs, sortLibrary } from './lib/libraryView'
import { createLog } from './lib/log'
import { homeRowGames, isStreamingClient } from './lib/recent'
import { isolatedStep } from './lib/startup'
import { hostGamesShown, withRemoteGames } from './lib/streaming'
import { AddGamesModal } from './screens/AddGames'
import { GameDetailModal } from './screens/GameDetail'
import { HomeScreen } from './screens/Home'
import { LibraryScreen } from './screens/Library'
import { QuickPanel } from './screens/QuickPanel'
import { RecompBrowser, RecompHeldDialog, RecompImageDialog, RecompPage } from './screens/Recomp'
import { RecompImportDialog } from './screens/Settings/RecompImportDialog'
import { VrBrowser } from './screens/VrMods'
import { FirstStartHosts } from './screens/FirstStart/FirstStartHosts'
import { EmulationMoveDialog } from './screens/Settings/EmulationMoveDialog'
import { SearchOverlay } from './screens/Search'
import { SettingsModal } from './screens/Settings'
import { SteamDlcDialog } from './screens/SteamDlc/SteamDlcDialog'
import { CustomFilterDialog } from './screens/CustomFilter/CustomFilterDialog'
// Subscribes to Trim Games' toasts at start, not only once Settings › Convert is opened.
import './state/convert'
import './state/metadataCloud'
import './state/ingameNotice'
import { openFocusedCoverMenu } from './state/favorite'
import { useInstallQueueStore } from './state/installQueue'
import { useInstallsStore } from './state/installs'
import { useLibraryStore } from './state/library'
import {
  loadRecompHeldImages,
  loadRecompImageOffers,
  nextRecompHeld,
  nextRecompImageOffer,
  onRecompHeldNote,
  useRecompHeldStore,
  useRecompImageStore
} from './state/recompImage'
import { activateTab, restoreLibraryTabs } from './state/libraryTabs'
import { useSettingsStore } from './state/settings'
import { useStreamingStore } from './state/streaming'
import { useSystemStore } from './state/system'
import { useUiStore, type OpenModal } from './state/ui'
import { startUpgradeProgress } from './state/upgrades'

const log = createLog('app')

/** Source order used to pick the `library` / `detail-install*` screens' greyed game (the stores' tab order). */
const STORE_ORDER: readonly string[] = [
  'steam',
  'epic',
  'gog',
  'ea',
  'battlenet',
  'ubisoft',
  'xbox'
]

/** The first owned, not installed game: Steam first, then by title (the mock's Spider-Man Remastered). */
function firstOwnedUninstalled(games: Game[]): Game | undefined {
  return sortLibrary(
    games.filter((g) => g.owned && !g.installed && !g.hidden),
    'title-asc'
  ).sort((a, b) => STORE_ORDER.indexOf(a.source) - STORE_ORDER.indexOf(b.source))[0]
}

/**
 * `?screen=` values the shell understands (scripts/screenshot.mjs passes them through --screen).
 * 'library-large' also makes the mock API generate a library of several hundred games; 'library-settings'
 * opens the Library on its Settings tab (the Settings menu); 'detail-install' opens the detail panel of an
 * owned, not installed game and 'detail-installing' the same with a tracked install (the mock seeds one).
 */
type StartScreen =
  | 'home'
  | 'library'
  | 'library-large'
  | 'library-settings'
  | 'detail'
  | 'detail-coop'
  | 'detail-install'
  | 'detail-installing'
  | 'addgames'
  | 'settings'
  | 'settings-metadata'
  | 'settings-streaming'
  | 'search'
  | 'quickpanel'
  | 'empty'

function startScreen(): StartScreen {
  try {
    const value = new URLSearchParams(window.location.search).get('screen')
    if (
      value === 'library' ||
      value === 'library-large' ||
      value === 'library-settings' ||
      value === 'detail' ||
      value === 'detail-coop' ||
      value === 'detail-install' ||
      value === 'detail-installing' ||
      value === 'addgames' ||
      value === 'settings' ||
      value === 'settings-metadata' ||
      value === 'settings-streaming' ||
      value === 'search' ||
      value === 'quickpanel' ||
      value === 'empty'
    ) {
      return value
    }
  } catch (err) {
    log.warn('could not read the screen query parameter', err)
  }
  return 'home'
}

/**
 * Application shell: loads settings, library and system status, starts the input engine, renders Home,
 * the Library view (kept mounted through its exit animation), the modal stack, toasts, and wires
 * main-process events to toasts and dialogs.
 */
export default function App(): ReactElement {
  const loadSettings = useSettingsStore((s) => s.load)
  const refreshLibrary = useLibraryStore((s) => s.refresh)
  const refreshSystem = useSystemStore((s) => s.refresh)
  const refreshInstalls = useInstallsStore((s) => s.refresh)
  const openModal = useUiStore((s) => s.openModal)
  const toast = useUiStore((s) => s.toast)
  const screen = useUiStore((s) => s.screen)

  // "Delete the original disc image?" (main/recomp/image-offer.ts): one question at a time, over whatever is open.
  const imageOffers = useRecompImageStore((s) => s.offers)
  const imageDismissed = useRecompImageStore((s) => s.dismissed)
  // A disc image moved aside for the recompilation's check, with a verdict (a crash: Restore?), comes first.
  const heldItems = useRecompHeldStore((s) => s.items)
  const heldDismissed = useRecompHeldStore((s) => s.dismissed)
  const askingImage = useUiStore((s) =>
    s.modals.some((m) => m.type === 'recomp-image' || m.type === 'recomp-held')
  )
  useEffect(() => {
    if (askingImage) return
    const item = nextRecompHeld(heldItems, heldDismissed)
    if (item) {
      openModal({ type: 'recomp-held', item })
      return
    }
    const offer = nextRecompImageOffer(imageOffers, imageDismissed)
    if (offer) openModal({ type: 'recomp-image', offer })
  }, [heldItems, heldDismissed, imageOffers, imageDismissed, askingImage, openModal])
  // The check passed: the image went to the Recycle Bin.
  useEffect(
    () => onRecompHeldNote((note) => toast(note.message, note.ok ? 'success' : 'error')),
    [toast]
  )

  useEffect(() => {
    // Upgrade toasts from the start, not only once an Upgrade menu was opened: Compress games automatically runs
    // without one.
    startUpgradeProgress()
    const stopInput = initInput()
    // Only while PlayOut is the active window: a game in front (or on the other screen) gets the pads to itself.
    setGamepadNeedsFocus(true)
    // The overlay window drives the pads while it is open over this window (both see the same pads).
    const stopOverlayPause = pauseGamepadWhileOverlayOpen(api)
    // Settings first: the stores and the input engine read them, and the library view depends on them.
    // The tracked installs and the install queue come along so a reloaded renderer restores its progress bars.
    // Each step is isolated (lib/startup): one that fails is logged and the later ones still run.
    const step = <T,>(label: string, run: () => T | Promise<T>): Promise<T | undefined> =>
      isolatedStep(label, run, (failed, err) => log.error(`initial load: ${failed} failed`, err))
    step('settings', loadSettings)
      // The paired hosts' games (Streaming) join the library pools once they arrive.
      .then(() =>
        Promise.all([
          step('library', refreshLibrary),
          step('system status', refreshSystem),
          step('installs', refreshInstalls),
          step('install queue', () => useInstallQueueStore.getState().refresh()),
          step('streaming', () => useStreamingStore.getState().load())
        ])
      )
      // "Delete the original disc image?" questions left from before (asked one at a time below).
      .then(() => step('disc image questions', loadRecompImageOffers))
      // A disc image still kept aside from a check PlayOut did not finish (it closed) is asked about again.
      .then(() => step('held disc images', loadRecompHeldImages))
      // PlayOut's first start on this PC: a PlayOut host on the network is offered for pairing.
      .then(() => step('first-start hosts', () => api.firstStartHosts()))
      .then((hosts) => {
        if (hosts?.length) openModal({ type: 'first-start-hosts', hosts })
      })
      // An Emulation folder inside PlayOut's install folder (an older setup): offered once to move it to Documents.
      .then(() => step('emulation folder offer', () => api.getEmulationFolderOffer()))
      .then((offer) => {
        if (offer)
          openModal({
            type: 'emulation-move',
            request: { kind: 'default' },
            offer: true,
            // The ROM folder followed: its games are found again under the new path.
            onDone: () =>
              void api.scanSources(['rom']).catch((err) => log.error('rom rescan failed', err))
          })
      })
      .catch((err) => log.error('initial load failed', err))
    return () => {
      stopOverlayPause()
      setGamepadNeedsFocus(false)
      stopInput()
    }
  }, [loadSettings, refreshLibrary, refreshSystem, refreshInstalls, openModal])

  useEffect(() => {
    const titleOf = (gameId: string): string => {
      const game = useLibraryStore.getState().byId.get(gameId)
      return game ? displayTitle(game) : t('app.unknownGame')
    }
    // The toasts' text is built when each event arrives (t() reads the language shown at that moment).
    const unsubscribe = [
      api.on('launch:error', ({ gameId, error }) => {
        log.warn(`launch failed for ${gameId}: ${error.kind} ${error.message}`)
        openModal({ type: 'launch-error', gameId, error })
      }),
      api.on('session:started', ({ gameId }) => {
        toast(t('app.sessionStarted', { title: titleOf(gameId) }), 'success')
      }),
      api.on('session:ended', ({ gameId, minutes }) => {
        toast(t('app.sessionEnded', { title: titleOf(gameId), time: formatPlaytime(minutes) }))
      }),
      // Background installs (§4.8): the end of a tracked install, good or bad, next to the session toasts.
      api.on('install:progress', (progress) => {
        if (progress.state === 'done')
          toast(t('app.installDone', { title: titleOf(progress.gameId) }), 'success')
        else if (progress.state === 'failed')
          toast(
            progress.message ?? t('app.installFailed', { title: titleOf(progress.gameId) }),
            'error'
          )
      })
    ]
    return () => {
      for (const off of unsubscribe) off()
    }
  }, [openModal, toast])

  // Global buttons on the root layer: View / '/' F1 search, Start / F10 settings, Y / Menu key the focused
  // cover's options. The Library view takes View itself (it focuses its own search field). The Quick Panel is
  // reached from the system pill.
  useActionHandlers({
    y: () => openFocusedCoverMenu(),
    start: () => {
      openModal({ type: 'settings' })
    },
    select: () => {
      openModal({ type: 'search' })
    }
  })

  useRestoreLibraryTabs()
  useStartScreen()
  const library = useExitTransition(screen === 'library')

  return (
    <>
      <HomeScreen />
      {library.mounted ? <LibraryScreen leaving={library.leaving} onLeft={library.onLeft} /> : null}
      <ModalHost />
      <CoverMenuHost />
      <ScanBars />
      <ToastHost />
    </>
  )
}

/**
 * Keeps a view mounted while it plays its exit animation: `mounted` stays true after `open` turned false
 * until the view calls `onLeft` (its animationend) or the fallback timer fires.
 */
function useExitTransition(open: boolean): {
  mounted: boolean
  leaving: boolean
  onLeft: () => void
} {
  const [mounted, setMounted] = useState(open)
  if (open && !mounted) setMounted(true)
  const leaving = mounted && !open
  const onLeft = useCallback(() => setMounted(false), [])
  useEffect(() => {
    if (!leaving) return undefined
    const timer = setTimeout(onLeft, MODAL_EXIT_FALLBACK_MS)
    return () => clearTimeout(timer)
  }, [leaving, onLeft])
  return { mounted, leaving, onLeft }
}

/**
 * The Library's saved tabs, once settings and the library are loaded: the first run makes them from the platform tabs
 * earlier versions showed; then the tab of the last session is shown again with each tab's saved card.
 */
function useRestoreLibraryTabs(): void {
  const loaded = useLibraryStore((s) => s.loaded)
  const settingsLoaded = useSettingsStore((s) => s.loaded)
  // Settings that failed to load are the defaults: the tabs are made for this session but never written (they would
  // replace the saved ones). A library that failed to load has no games to make the first run's tabs from: that waits
  // for a refresh that works; saved tabs do not need it.
  const libraryFailed = useLibraryStore((s) => !!s.error)
  const settingsFailed = useSettingsStore((s) => s.loadFailed)
  useEffect(() => {
    if (!loaded || !settingsLoaded) return
    const settings = useSettingsStore.getState().settings
    if (libraryFailed && !settings?.ui.libraryTabs?.length) return
    const { games, platforms } = useLibraryStore.getState()
    restoreLibraryTabs(libraryTabs(gamesByPlatform(visibleGames(games, settings), platforms)), {
      save: !settingsFailed
    })
  }, [loaded, settingsLoaded, libraryFailed, settingsFailed])
}

/** Open the modal (or view) named by ?screen= once the data it needs is loaded. */
function useStartScreen(): void {
  const loaded = useLibraryStore((s) => s.loaded)
  const settingsLoaded = useSettingsStore((s) => s.loaded)
  const applied = useRef(false)
  useEffect(() => {
    if (applied.current || !loaded || !settingsLoaded) return
    applied.current = true
    const screen = startScreen()
    const { openModal, setScreen, rememberLibraryFocus } = useUiStore.getState()
    switch (screen) {
      case 'library': {
        // Opened on the first greyed (owned, not installed) card when there is one, so the capture shows the
        // greyed cards among the installed ones (the playable-first button puts them after the installed ones).
        const { games } = useLibraryStore.getState()
        const greyed = firstOwnedUninstalled(games)
        activateTab(LIBRARY_ALL_TAB)
        if (greyed) rememberLibraryFocus(useUiStore.getState().library.tab, greyed.id)
        setScreen('library')
        break
      }
      case 'library-large': {
        // The mock's generated library (several hundred games), opened on a card half-way down so the
        // grid's windowing (spacers, pinned row, scroll position) is exercised in the capture.
        const { games } = useLibraryStore.getState()
        const settings = useSettingsStore.getState().settings
        activateTab(LIBRARY_ALL_TAB)
        const view = useUiStore.getState().library
        const shown = sortLibrary(
          visibleGames(games, settings),
          view.sort,
          view.sortReversed,
          undefined,
          undefined,
          view.playableFirst
        )
        const middle = shown[Math.floor(shown.length / 2)]
        if (middle) rememberLibraryFocus(view.tab, middle.id)
        setScreen('library')
        break
      }
      case 'library-settings':
        activateTab(LIBRARY_SETTINGS_TAB)
        setScreen('library')
        break
      case 'detail-coop': {
        // The first installed game with a Co-Op handler (the Co-Op badge and the Play | Co-Op button).
        const { games } = useLibraryStore.getState()
        const first = games.find((g) => g.installed && g.metadata.coop)
        if (first) openModal({ type: 'detail', gameId: first.id })
        else log.warn('?screen=detail-coop: no installed game with a Co-Op handler')
        break
      }
      case 'detail': {
        const { games } = useLibraryStore.getState()
        const settings = useSettingsStore.getState().settings
        // The first card of Home's row (lib/recent.ts homeRowGames, as Settings › Library › Front page chooses): the most recently played game this PC can play or get.
        const { remote, status } = useStreamingStore.getState()
        const showHostGames = settings?.streaming.showHostGames ?? true
        const first = homeRowGames(
          withRemoteGames(
            visibleGames(games, settings),
            hostGamesShown(games, remote, showHostGames)
          ),
          {
            mode: settings?.ui.homeRow ?? 'recent',
            client: isStreamingClient(status),
            alsoOnHost: remote?.alsoOnHost,
            showHostGames,
            showDuplicates: settings?.library.showDuplicates ?? false,
            count: 1
          }
        )[0]
        if (first) openModal({ type: 'detail', gameId: first.id })
        else log.warn('?screen=detail: the library is empty')
        break
      }
      case 'detail-install':
      case 'detail-installing': {
        // The first owned, not installed game (Steam first, then by title): the mock seeds its install for
        // 'detail-installing' before the renderer asks for the library.
        const first = firstOwnedUninstalled(useLibraryStore.getState().games)
        if (first) openModal({ type: 'detail', gameId: first.id })
        else log.warn(`?screen=${screen}: no owned, uninstalled game in the library`)
        break
      }
      case 'addgames':
        openModal({ type: 'addgames' })
        break
      case 'settings':
        openModal({ type: 'settings' })
        break
      case 'settings-metadata':
        openModal({ type: 'settings', section: 'metadata' })
        break
      case 'settings-streaming':
        openModal({ type: 'settings', section: 'streaming' })
        break
      case 'search':
        openModal({ type: 'search' })
        break
      case 'quickpanel':
        openModal({ type: 'quickpanel' })
        break
      case 'empty':
      case 'home':
        break
    }
  }, [loaded, settingsLoaded])
}

interface HostedModal {
  modal: OpenModal
  /** Left the store's stack; stays mounted until its exit animation ends. */
  closing: boolean
}

/**
 * Renders the ui store's modal stack in order; the topmost one owns the action layer. A modal that left
 * the stack is kept mounted as `closing` until its Modal reports the end of its exit animation (or the
 * fallback timer fires), so closing animates instead of vanishing.
 */
function ModalHost(): ReactElement | null {
  const modals = useUiStore((s) => s.modals)
  const closeModal = useUiStore((s) => s.closeModal)
  const [hosted, setHosted] = useState<HostedModal[]>([])
  const [seen, setSeen] = useState(modals)

  // Derive the hosted list from the store during render (React's "previous props" pattern): open modals
  // in stack order, with every one that just left the stack kept in place and marked closing.
  if (seen !== modals) {
    setSeen(modals)
    setHosted((previous) => mergeHosted(previous, modals))
  }

  const remove = useCallback((id: number) => {
    setHosted((previous) => previous.filter((h) => h.modal.id !== id))
  }, [])

  // While any modal is closing, directions and A are frozen (its fading controls are still Norigin
  // focusables; a quick B then A must not activate them). Fallback: a closing modal whose animationend
  // never arrives is removed just after the real exit duration (--dur-modal), so the freeze stays short.
  const closingIds = hosted
    .filter((h) => h.closing)
    .map((h) => h.modal.id)
    .join(',')
  useEffect(() => {
    if (!closingIds) return undefined
    setInputFrozen(true)
    const ids = closingIds.split(',').map(Number)
    const timer = setTimeout(() => {
      setHosted((previous) => previous.filter((h) => !(h.closing && ids.includes(h.modal.id))))
    }, currentModalExitFallbackMs())
    return () => {
      clearTimeout(timer)
      setInputFrozen(false)
    }
  }, [closingIds])

  if (hosted.length === 0) return null
  return (
    <>
      {hosted.map(({ modal, closing }) => (
        <ModalClosingContext.Provider
          key={modal.id}
          value={{ closing, onClosed: () => remove(modal.id) }}
        >
          <ModalView modal={modal} onClose={() => closeModal(modal.id)} />
        </ModalClosingContext.Provider>
      ))}
    </>
  )
}

/** Open modals in stack order; modals that vanished from the stack stay where they were, marked closing. */
function mergeHosted(previous: HostedModal[], modals: OpenModal[]): HostedModal[] {
  const open = new Map(modals.map((m) => [m.id, m]))
  const out: HostedModal[] = []
  const placed = new Set<number>()
  for (const entry of previous) {
    const current = open.get(entry.modal.id)
    out.push(current ? { modal: current, closing: false } : { ...entry, closing: true })
    placed.add(entry.modal.id)
  }
  for (const modal of modals) {
    if (!placed.has(modal.id)) out.push({ modal, closing: false })
  }
  return out
}

function ModalView({ modal, onClose }: { modal: OpenModal; onClose: () => void }): ReactElement {
  switch (modal.type) {
    case 'detail':
      return <GameDetailModal gameId={modal.gameId} onClose={onClose} />
    case 'addgames':
      return <AddGamesModal onClose={onClose} />
    case 'settings':
      return <SettingsModal section={modal.section} onClose={onClose} />
    case 'search':
      return <SearchOverlay onClose={onClose} />
    case 'quickpanel':
      return <QuickPanel focus={modal.focus} onClose={onClose} />
    case 'launch-error':
      // A game the user added with a saves question open: the question itself (PC Saves).
      if (modal.error.kind === 'save-conflict')
        return <PcSaveConflictDialog gameId={modal.gameId} error={modal.error} onClose={onClose} />
      return <LaunchErrorDialog gameId={modal.gameId} error={modal.error} onClose={onClose} />
    case 'recomp':
      return (
        <RecompPage
          gameId={modal.gameId}
          focus={modal.focus}
          {...(modal.recompId ? { recompId: modal.recompId } : {})}
          onClose={onClose}
        />
      )
    case 'recomp-image':
      return <RecompImageDialog offer={modal.offer} onClose={onClose} />
    case 'recomp-held':
      return <RecompHeldDialog item={modal.item} onClose={onClose} />
    case 'recomp-browser':
      return <RecompBrowser onClose={onClose} />
    case 'recomp-import':
      return <RecompImportDialog onClose={onClose} />
    case 'vr-browser':
      return <VrBrowser onClose={onClose} />
    case 'first-start-hosts':
      return <FirstStartHosts hosts={modal.hosts} onClose={onClose} />
    case 'emulation-move':
      return (
        <EmulationMoveDialog
          request={modal.request}
          offer={modal.offer}
          onDone={modal.onDone}
          onClose={onClose}
        />
      )
    case 'steam-dlc':
      return <SteamDlcDialog gameId={modal.gameId} mode={modal.mode} onClose={onClose} />
    case 'custom-filter':
      return (
        <CustomFilterDialog
          gameId={modal.gameId}
          filterId={modal.filterId}
          focus={modal.focus}
          onClose={onClose}
        />
      )
    case 'confirm':
      return (
        <ConfirmDialog
          title={modal.title}
          message={modal.message}
          confirmLabel={modal.confirmLabel}
          cancelLabel={modal.cancelLabel}
          danger={modal.danger}
          option={modal.option}
          onConfirm={modal.onConfirm}
          onClose={onClose}
        />
      )
  }
}
