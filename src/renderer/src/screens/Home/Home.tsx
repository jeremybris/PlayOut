import type { Game, Platform } from '@shared/types'
import { memo, useCallback, useEffect, useMemo, useRef, type ReactElement } from 'react'
import { ButtonHints, type Hint } from '../../components/ButtonHints'
import { Spinner } from '../../components/Spinner'
import { useActionHandlers } from '../../hooks/useActionHandlers'
import {
  FocusContext,
  doesFocusableExist,
  getCurrentFocusKey,
  isFocusWithin,
  setFocus,
  useFocusable,
  type Direction
} from '../../input/focus'
import { useT, type Translate } from '../../i18n'
import { cx } from '../../lib/cx'
import { addGamesTileFocusKey, cardFocusKey, parseCardFocusKey } from '../../lib/focusKeys'
import { visibleGames } from '../../lib/library'
import { createLog } from '../../lib/log'
import { homeRowGames, homeRowTitle, isStreamingClient } from '../../lib/recent'
import { findGame, hostGamesShown, withRemoteGames } from '../../lib/streaming'
import { copiesFor, toggleFocusedFavorite } from '../../state/favorite'
import { useLibraryStore } from '../../state/library'
import { useSettingsStore } from '../../state/settings'
import { useStreamingStore } from '../../state/streaming'
import { useModalOpen, useUiStore, type ModalType } from '../../state/ui'
import { LIBRARY_KEY } from '../Library/keys'
import { HeroBackdrop } from './HeroBackdrop'
import { HeroText } from './HeroText'
import { QuickActions } from './QuickActions'
import { EmptyLibraryRow, RecentRow } from './RecentRow'
import { ScrollHint } from './ScrollHint'
import { SystemBar } from './SystemBar'
import { HOME_KEY, QUICK_KEY, RECENT_ROW, SYSTEMBAR_KEY } from './rows'
import { useHeroGame } from './useHeroGame'
import './home.css'

const log = createLog('home')

const DEFAULT_RECENT_COUNT = 12
/** Vertical wheel: the Library opens after this much deltaY downwards. */
const WHEEL_STEP = 40
/** Vertical touch swipe (in rem) that opens the Library. */
const SWIPE_REM = 4.8

/** Home's button hints, built for the language shown (a constant would keep the language it loaded in). */
function homeHints(t: Translate): Hint[] {
  return [
    { button: 'a', label: t('home.hints.open') },
    { button: 'x', label: t('home.hints.favourite') },
    { button: 'y', label: t('home.hints.options') },
    { button: 'rs', label: t('home.hints.library') },
    { button: 'select', label: t('home.hints.search') },
    { button: 'start', label: t('home.hints.settings') }
  ]
}

/** Modals drawn as a full panel: the system pill is raised above them so it is never covered. */
const PANEL_MODALS = new Set<ModalType>(['detail', 'addgames', 'settings'])

/**
 * The home dashboard (design 2, 6.2, 6.6): hero backdrop and text of the focused game (no version label: it is in Settings › About),
 * system pill and the Recent Games row. The [Settings] [Exit] quick actions appear only with an empty
 * library (the pill's power item and the Menu hint cover them otherwise). The full library lives in the
 * Library view below: down from the Recent row, a vertical wheel or an upward swipe opens it, and the
 * home content slides up and fades while it is shown (the hero backdrop stays, tinting the Library's bands).
 */
export function HomeScreen(): ReactElement {
  const t = useT()
  const hints = useMemo(() => homeHints(t), [t])
  const games = useLibraryStore((s) => s.games)
  const platforms = useLibraryStore((s) => s.platforms)
  const platformsById = useLibraryStore((s) => s.platformsById)
  const byId = useLibraryStore((s) => s.byId)
  const loaded = useLibraryStore((s) => s.loaded)
  const settings = useSettingsStore((s) => s.settings)
  const openModal = useUiStore((s) => s.openModal)
  const screen = useUiStore((s) => s.screen)
  const modalOpen = useModalOpen()
  const coverMenuOpen = useUiStore((s) => s.coverMenu !== null)
  const panelOpen = useUiStore((s) => {
    const top = s.modals[s.modals.length - 1]
    return top !== undefined && PANEL_MODALS.has(top.type)
  })
  const active = screen === 'home'

  // A paired host's games count as a library (Streaming): with only those, Home is not "empty" and opens the
  // Library like any other.
  const remote = useStreamingStore((s) => s.remote)
  const showHostGames = settings?.streaming.showHostGames ?? true
  const visible = useMemo(
    () =>
      withRemoteGames(visibleGames(games, settings), hostGamesShown(games, remote, showHostGames)),
    [games, settings, remote, showHostGames]
  )
  // The Recent row. On a client of a host: the games played most recently on this PC or a paired one, installed here or
  // not (a host's game, a game a store account owns: greyed, as in the Library), never one this PC cannot get
  // (lib/recent.ts). On a PC with no host: its installed games only. A game with several copies is one card
  // (lib/copies.ts).
  const client = useStreamingStore((s) => isStreamingClient(s.status))
  const showDuplicates = settings?.library.showDuplicates ?? false
  const recentCount = settings?.ui.recentCount ?? DEFAULT_RECENT_COUNT
  // Settings > Library > Front page: Recently Played (the default), Recently Added or Favorites.
  const homeRow = settings?.ui.homeRow ?? 'recent'
  const alsoOnHost = remote?.alsoOnHost
  const recent = useMemo(
    () =>
      homeRowGames(visible, {
        mode: homeRow,
        client,
        alsoOnHost,
        showHostGames,
        showDuplicates,
        count: recentCount
      }),
    [visible, homeRow, client, alsoOnHost, showHostGames, showDuplicates, recentCount]
  )
  // The count above a card's store badge: every copy the game has (the same group its cover menu lists), not only
  // the ones the row groups.
  const recentCopies = useMemo(() => {
    const counts = new Map<string, number>()
    for (const game of recent) {
      const n = copiesFor(game.id).length
      if (n > 1) counts.set(game.id, n)
    }
    return counts
    // games: the copies change with the library, not only with the recent list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recent, games])
  const empty = loaded && visible.length === 0
  const heroFallback = recent[0] ?? visible[0]

  // Home is a focus boundary: while the Library is mounted (or leaving), directional moves never cross
  // between the two views; setFocus still does.
  const { ref: boundaryRef, focusKey: boundaryKey } = useFocusable<object, HTMLDivElement>({
    focusKey: HOME_KEY,
    isFocusBoundary: true,
    trackChildren: true
  })

  const openDetail = useCallback(
    (game: Game) => {
      openModal({ type: 'detail', gameId: game.id })
    },
    [openModal]
  )

  // ---- the Library view below: remember where focus was so it comes back to the same card ----------
  const openLibrary = useCallback((): boolean => {
    const ui = useUiStore.getState()
    if (ui.screen !== 'home' || ui.modals.length > 0) return false
    if (!useLibraryStore.getState().loaded) return false
    ui.setHomeFocusKey(getCurrentFocusKey())
    ui.setScreen('library')
    return true
  }, [])
  const onRecentArrow = useCallback(
    (direction: Direction): boolean => (direction === 'down' ? !openLibrary() : true),
    [openLibrary]
  )

  // ---- focus: initial focus, after a library change stay on the same game, and the return from the Library
  // focusedGameId is read from the store, not selected: a plain focus move already lands on the card whose
  // game it names, so the effect need not run on every D-pad step.
  useEffect(() => {
    // An open cover menu (Y) holds the focus; the effect runs again when it closes.
    if (!loaded || !active || coverMenuOpen) return
    const ui = useUiStore.getState()
    const current = getCurrentFocusKey()
    if (current && isFocusWithin(LIBRARY_KEY)) {
      // Back from the Library: the element focused when it opened, when it still exists.
      const remembered = ui.homeFocusKey
      if (remembered && doesFocusableExist(remembered)) {
        void setFocus(remembered)
        return
      }
    } else {
      const card = parseCardFocusKey(current)
      if (card) {
        if (card.gameId === ui.focusedGameId || current === addGamesTileFocusKey(card.rowId)) return
      } else if (modalOpen || isFocusWithin(QUICK_KEY) || isFocusWithin(SYSTEMBAR_KEY)) {
        return
      }
    }
    // A host's game in the row is no game of this PC's store: findGame knows both.
    const keep =
      ui.focusedGameId && findGame(ui.focusedGameId, byId, remote)
        ? existingCardKey(ui.focusedGameId)
        : undefined
    const target = keep ?? defaultFocusKey(recent)
    if (doesFocusableExist(target)) void setFocus(target)
    else log.warn(`nothing to focus: ${target} is not registered`)
  }, [loaded, active, modalOpen, coverMenuOpen, byId, remote, recent])

  useActionHandlers(
    {
      x: () => toggleFocusedFavorite(),
      rb: () => openLibrary(),
      'rs-down': () => openLibrary()
    },
    !modalOpen && active
  )

  // ---- wheel down / swipe up anywhere on the page opens the Library -------------------------------
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const root = rootRef.current
    if (!root) return undefined
    let wheelAcc = 0
    let touch: { id: number; x: number; y: number } | null = null

    const onWheel = (event: WheelEvent): void => {
      // Horizontal and Shift+wheel are the Row's (it pans itself).
      if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
      wheelAcc = event.deltaY > 0 ? wheelAcc + event.deltaY : 0
      if (wheelAcc < WHEEL_STEP) return
      wheelAcc = 0
      openLibrary()
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (event.pointerType !== 'touch') return
      touch = { id: event.pointerId, x: event.clientX, y: event.clientY }
    }
    const onPointerMove = (event: PointerEvent): void => {
      if (!touch || event.pointerId !== touch.id) return
      const dx = event.clientX - touch.x
      const dy = event.clientY - touch.y
      if (Math.abs(dy) < SWIPE_REM * remPx() || Math.abs(dy) < Math.abs(dx)) return
      touch = { id: touch.id, x: event.clientX, y: event.clientY }
      if (dy < 0) openLibrary()
    }
    const onPointerEnd = (event: PointerEvent): void => {
      if (touch && event.pointerId === touch.id) touch = null
    }
    root.addEventListener('wheel', onWheel, { passive: true })
    root.addEventListener('pointerdown', onPointerDown)
    root.addEventListener('pointermove', onPointerMove)
    root.addEventListener('pointerup', onPointerEnd)
    root.addEventListener('pointercancel', onPointerEnd)
    return () => {
      root.removeEventListener('wheel', onWheel)
      root.removeEventListener('pointerdown', onPointerDown)
      root.removeEventListener('pointermove', onPointerMove)
      root.removeEventListener('pointerup', onPointerEnd)
      root.removeEventListener('pointercancel', onPointerEnd)
    }
  }, [openLibrary])

  return (
    <div ref={rootRef} className="home-page">
      <HeroArea fallback={heroFallback} platforms={platforms} dimmed={modalOpen} away={!active} />
      <FocusContext.Provider value={boundaryKey}>
        <div
          ref={boundaryRef}
          className={cx('home-content', !active && 'home-content--away')}
          aria-hidden={!active}
        >
          {empty ? <QuickActions /> : null}
          <div className="home-rows">
            <div className="home-rows__stack">
              {!loaded ? (
                <div className="home-rows__loading">
                  <Spinner size="lg" label={t('home.loadingLibrary')} />
                </div>
              ) : empty ? (
                <EmptyLibraryRow />
              ) : (
                <RecentRow
                  title={homeRowTitle(homeRow)}
                  games={recent}
                  platformsById={platformsById}
                  copies={recentCopies}
                  onOpen={openDetail}
                  onArrowPress={onRecentArrow}
                />
              )}
            </div>
          </div>
          <ScrollHint visible={loaded && !empty && !modalOpen} />
        </div>
        <SystemBar raised={panelOpen && active} away={!active} />
      </FocusContext.Provider>
      {!modalOpen && active ? <ButtonHints hints={hints} /> : null}
    </div>
  )
}

interface HeroAreaProps {
  /** Shown while no card has been focused yet (the first recent game, else the first visible game). */
  fallback: Game | undefined
  platforms: Platform[]
  dimmed: boolean
  /** Slide the text block away with the rest of Home (the backdrop stays under the Library). */
  away: boolean
}

/**
 * The hero backdrop and hero text. Its own component so the focusedGameId subscription in
 * useHeroGame re-renders only this subtree on every focus change, never the row.
 */
const HeroArea = memo(function HeroArea({
  fallback,
  platforms,
  dimmed,
  away
}: HeroAreaProps): ReactElement {
  const game = useHeroGame(fallback)
  return (
    <>
      <HeroBackdrop game={game} dimmed={dimmed} />
      <div className={cx('home-content', away && 'home-content--away')} aria-hidden={away}>
        <HeroText game={game} platforms={platforms} />
      </div>
    </>
  )
})

function remPx(): number {
  const size = parseFloat(getComputedStyle(document.documentElement).fontSize)
  return Number.isFinite(size) && size > 0 ? size : 10
}

/** The focus key of the Recent card showing `gameId` when it is mounted. */
function existingCardKey(gameId: string): string | undefined {
  const key = cardFocusKey(RECENT_ROW, gameId)
  return doesFocusableExist(key) ? key : undefined
}

/** Initial focus (design 6.2): the first recent card, else the Add Games tile. */
function defaultFocusKey(recent: Game[]): string {
  const first = recent[0]
  return first ? cardFocusKey(RECENT_ROW, first.id) : addGamesTileFocusKey(RECENT_ROW)
}
