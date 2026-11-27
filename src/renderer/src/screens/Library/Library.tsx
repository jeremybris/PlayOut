import type { Game, LibraryScrollPosition } from '@shared/types'
import { withSortIcons } from '../../components/SortIcon'
import { Download, FolderOpen, Gamepad2, X } from 'lucide-react'
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type AnimationEvent,
  type ReactElement
} from 'react'
import { ButtonHints, type Hint } from '../../components/ButtonHints'
import { SelectField } from '../../components/SelectField'
import { TextField } from '../../components/TextField'
import { useActionHandlers } from '../../hooks/useActionHandlers'
import { useActivePlayersRefresh } from '../../hooks/useActivePlayersRefresh'
import { useHltbTimesRefresh } from '../../hooks/useHltbTimesRefresh'
import { useFocusableControl } from '../../hooks/useFocusableControl'
import { useLanguage, useT, type Translate } from '../../i18n'
import { ROOT_LAYER, topLayer } from '../../input/actions'
import {
  FocusContext,
  doesFocusableExist,
  getCurrentFocusKey,
  isFocusWithin,
  pressEnter,
  releaseEnter,
  setFocus,
  useFocusable
} from '../../input/focus'
import { libraryControlsFilters } from '../../lib/controls'
import { cx } from '../../lib/cx'
import { cardFocusKey, parseCardFocusKey } from '../../lib/focusKeys'
import { hiddenGames, visibleGames } from '../../lib/library'
import { MAX_LIBRARY_TABS_UI, platformLabelOf, stripTabs } from '../../lib/libraryTabs'
import {
  everyCopyOf,
  filterTabGroups,
  hasRecomp,
  tabGroupsOf,
  tabPoolOf
} from '../../lib/libraryFilter'
import {
  LIBRARY_SETTINGS_TAB,
  gameDifficultyOf,
  librarySortOptions,
  sortLibrary,
  stepTab,
  type LibrarySort
} from '../../lib/libraryView'
import { librarySections } from '../../lib/librarySections'
import { hostGamesShown, withRemoteGames } from '../../lib/streaming'
import { focusCardInRow, openPopup } from '../../lib/popupOpeners'
import { WheelExit } from '../../lib/wheelExit'
import { customFilterNames } from '../../lib/customFilters'
import { useCustomFilters } from '../../state/customFilters'
import { toggleFocusedFavorite } from '../../state/favorite'
import { useLibraryStore } from '../../state/library'
import { useLanPartyIds } from '../../state/peerparty'
import { LAN_PARTY } from '../../lib/localMultiplayer'
import {
  activateTab,
  addTab,
  deleteTab,
  libraryTabDefs,
  rememberPosition,
  rememberScroll,
  updateActiveTab
} from '../../state/libraryTabs'
import { useSettingsStore } from '../../state/settings'
import { api } from '../../api/client'
import { filterFolders, missingFoldersMessage } from '../../lib/libraryFolders'
import { useStreamingStore } from '../../state/streaming'
import { useModalOpen, useUiStore } from '../../state/ui'
import { HeroBackdrop } from '../Home/HeroBackdrop'
import { useHeroGame } from '../Home/useHeroGame'
import { SettingsTab } from './SettingsTab'
import { FiltersPill } from './FiltersPill'
import { libraryPlatformFilters, type PlatformFilter } from '../../lib/platformFilters'
import { LibraryGrid } from './LibraryGrid'
import { TabStrip } from './TabStrip'
import {
  SETTINGS_TAB_KEY,
  CATEGORY_KEY,
  DELETE_TAB_KEY,
  GRID_KEY,
  HEADER_KEY,
  IMPORT_KEY,
  LIBRARY_KEY,
  LIBRARY_ROW,
  PLAYABLE_KEY,
  FOLDERS_KEY,
  SEARCH_KEY,
  SORT_KEY,
  TABS_KEY,
  tabFocusKey
} from './keys'
import { libraryTagFilters, type TagFilter } from '../../lib/steamTags'
import { libraryReleaseEras, type ReleaseEra } from '../../lib/releaseEras'
import { libraryStoreFilters, platformKindOf, type StoreFilter } from '../../lib/storeFilters'
import './library.css'

/**
 * Wheel up while the grid rests at its top: Home returns after this much deltaY (one full notch) that
 * started at the resting top; the momentum that scrolled the grid up, or that opened the view, never counts.
 */
const WHEEL_EXIT = { step: 120, restMs: 300, gapMs: 400, graceMs: 300 }
/** Vertical touch swipe (in rem) downwards at the top of the grid that returns Home. */
const SWIPE_REM = 4.8

/**
 * The view's button hints, built for the language shown (a constant would keep the language it loaded in). The
 * Settings tab has no grid, search field or pills, so only the view's own buttons are offered there.
 */
function libraryHints(t: Translate, onSettings: boolean): Hint[] {
  const own: Hint[] = [
    { button: 'start', label: t('library.hints.settings') },
    { button: 'rs', label: t('library.hints.home') },
    { button: 'b', label: t('library.hints.close') },
    { button: 'a', label: t('library.hints.select') }
  ]
  if (onSettings) return own
  return [
    { button: 'dpad', label: t('library.hints.section') },
    { button: 'lt', label: t('library.hints.sort') },
    { button: 'rt', label: t('library.hints.filters') },
    { button: 'x', label: t('library.hints.favourite') },
    { button: 'y', label: t('library.hints.options') },
    { button: 'select', label: t('library.hints.search') },
    ...own
  ]
}

export interface LibraryScreenProps {
  /** Playing the exit animation: input is off and `onLeft` fires when it ends. */
  leaving: boolean
  onLeft: () => void
}

/**
 * The full-screen Library view below Home (design: the reference library grid): a translucent tab band
 * over the hero art (Settings, All Games + one tab per platform, LB/RB or Q/E switch), the game count
 * header with the live search field, sort and category pills, a windowed six-column cover grid, and a
 * translucent bottom band with Library Import (the Add Games modal, where stores are signed in and out) and the
 * button hints. The Settings tab swaps the header and grid for the Settings menu (SettingsTab). B / Escape, up from the tabs, a wheel up at the top of
 * the grid or a downward swipe there return to Home. Filters and the per-tab focused card live in the ui
 * store, so they survive leaving and re-entering the view.
 */
export function LibraryScreen({ leaving, onLeft }: LibraryScreenProps): ReactElement {
  const t = useT()
  const games = useLibraryStore((s) => s.games)
  const platforms = useLibraryStore((s) => s.platforms)
  const platformsById = useLibraryStore((s) => s.platformsById)
  // Only the settings the game lists read: a saved tab or position (every filter pick, search keystroke and card rest)
  // must not recompute the whole library.
  const showUninstalled = useSettingsStore((s) => s.settings?.library.showUninstalled ?? true)
  const showHidden = useSettingsStore((s) => s.settings?.library.showHidden ?? false)
  const showDuplicates = useSettingsStore((s) => s.settings?.library.showDuplicates ?? false)
  // One cover size for every tab (the slider left of the grid); followed by both windows like other ui settings.
  const coverScale = useSettingsStore((s) => s.settings?.ui.libraryCoverScale ?? 1)
  const onCoverScale = useCallback((scale: number) => {
    void useSettingsStore.getState().update({ ui: { libraryCoverScale: scale } })
  }, [])
  const visibility = useMemo(
    () => ({ library: { showUninstalled, showHidden } }),
    [showUninstalled, showHidden]
  )
  const filters = useUiStore((s) => s.library)
  const openModal = useUiStore((s) => s.openModal)
  const modalOpen = useModalOpen()
  const settingsModalOpen = useUiStore(
    (s) => s.settingsModalsMounted > 0 || s.modals.some((m) => m.type === 'settings')
  )
  const active = !leaving && !modalOpen

  // The paired hosts' games this PC does not have (Streaming): shown even with showUninstalled off (Settings >
  // Streaming has its own switch), never under Filters > Hidden (they cannot be hidden from this PC). This PC's own
  // uninstalled copy of a game a host can stream counts too (lib/streaming.ts localOnHost).
  const remote = useStreamingStore((s) => s.remote)
  const showHostGames = useSettingsStore((s) => s.settings?.streaming.showHostGames ?? true)
  const remoteShown = useMemo(
    () => hostGamesShown(games, remote, showHostGames),
    [games, remote, showHostGames]
  )
  const visible = useMemo(
    () => withRemoteGames(visibleGames(games, visibility), remoteShown),
    [games, visibility, remoteShown]
  )
  const hiddenList = useMemo(() => hiddenGames(games, visibility), [games, visibility])
  // Filters > Hidden swaps what the tab, genre and search filters apply to.
  const pool = filters.hidden ? hiddenList : visible
  // The user's tabs (Settings > Library), each named by its filters; [] until App made them on the first run.
  const defs = useSettingsStore((s) => s.settings?.ui.libraryTabs)
  const platformLabel = useMemo(() => platformLabelOf(platformsById), [platformsById])
  // The user's own filters (Filters > Custom): their names name a tab that picks them.
  const customFilters = useCustomFilters()
  const customName = useMemo(() => customFilterNames(customFilters), [customFilters])
  const tabs = useMemo(
    () => stripTabs(defs ?? [], platformLabel, customName),
    [defs, platformLabel, customName]
  )
  const tabCount = tabs.length - 1
  // A tab that went away (removed in Settings) falls back to the first of the user's tabs.
  const tab = tabs.some((entry) => entry.id === filters.tab)
    ? filters.tab
    : (tabs[1]?.id ?? LIBRARY_SETTINGS_TAB)
  const onSettings = tab === LIBRARY_SETTINGS_TAB
  // The Active Players sort shown (any tab): its counts are read from SteamCharts now and hourly while it stays.
  useActivePlayersRefresh(!leaving && !onSettings && filters.sort === 'players')
  // The H.L.T.B. sort shown (any tab): games without a time are looked up now and every 30 min while it stays.
  useHltbTimesRefresh(!leaving && !onSettings && filters.sort === 'hltb')
  const tagOptions = useMemo(() => libraryTagFilters(pool), [pool])
  const kindOf = useMemo(() => platformKindOf(platformsById), [platformsById])
  const storeOptions = useMemo(() => libraryStoreFilters(pool, kindOf), [pool, kindOf])
  const eraOptions = useMemo(() => libraryReleaseEras(pool), [pool])
  // Filters > Controls: the choices with games (the others, Touch today, are not offered).
  const controlsOptions = useMemo(() => libraryControlsFilters(pool), [pool])
  // Filters > Platform: the consoles and other systems with games (stores are below its line, storeFilters.ts).
  const platformOptions = useMemo(
    () => libraryPlatformFilters(pool, platforms, platformLabel),
    [pool, platforms, platformLabel]
  )
  // Filters > Platform's systems and stores narrow the games before the same game's copies collapse into one card
  // (lib/copies.ts), so an Epic tab shows the Epic copy of a game owned on Epic and Steam; Filters > Favorites then
  // keeps the games any copy of which is a favourite.
  // Grouped before the search and genre filters, which then keep a group when any copy matches: a filter must
  // not change which copy stands for the game, nor its count or merged play facts.
  // The filtering steps are lib/libraryFilter.ts's (a game page asks it whether a card shows: tabShowsGame).
  const tabPool = useMemo(
    () => tabPoolOf(pool, { platforms: filters.platforms, stores: filters.stores }, kindOf),
    [pool, filters.platforms, filters.stores, kindOf]
  )
  // The header's folder button: the folders holding the games the Platform / PC filters pick (no button without one).
  const romsRoot = useSettingsStore((s) => s.settings?.library.romsRoot ?? null)
  const folderTarget = useMemo(
    () =>
      filters.platforms.length === 0 && filters.stores.length === 0
        ? // Filters > Recompilations alone: the Recompilations folder only (main adds it), no game's folder.
          filters.recomp
          ? { folders: [], more: 0 }
          : null
        : filterFolders(
            tabPool,
            filters.platforms.filter((id) => kindOf(id) === 'system'),
            romsRoot
          ),
    [tabPool, filters.platforms, filters.stores, filters.recomp, kindOf, romsRoot]
  )
  const onOpenFolders = useCallback(() => {
    const toast = useUiStore.getState().toast
    const recompilations = filters.recomp
    if (!folderTarget || (folderTarget.folders.length === 0 && !recompilations)) {
      toast(t('library.folders.none'), 'info')
      return
    }
    api
      .openFolders(folderTarget.folders, { recompilations })
      .then(({ opened, missing }) => {
        // The games' folders are gone (moved by hand, a drive disconnected): say which, and advice that fits them.
        if (opened.length === 0 && missing.length)
          toast(missingFoldersMessage(missing, tabPool, romsRoot), 'error')
        else if (opened.length === 0) toast(t('library.folders.none'), 'info')
        else if (missing.length || folderTarget.more)
          toast(
            folderTarget.more
              ? t('library.folders.openedMore', {
                  count: opened.length,
                  more: folderTarget.more
                })
              : t('library.folders.opened', { count: opened.length }),
            'info'
          )
      })
      .catch(() => toast(t('library.folders.failed'), 'error'))
  }, [folderTarget, filters.recomp, tabPool, romsRoot, t])

  // A host game never groups with this PC's copies: main already dropped the host games this PC has.
  // One card per game (lib/copies.ts: the copy with a recompilation, else Steam > GOG > Epic > PS3 > PS2 > GameCube >
  // Xbox 360 > Xbox > the other PC stores; ROMs of other systems always have a card each), except while searching or
  // with Filters > Platform / PC on: then every copy has its own card, so the PS2 and the Xbox copy can both be found.
  const everyCopy = everyCopyOf(filters)
  // Local Multiplayer > L.A.N. Party: main's list of the games PeerParty is offered for, asked only while it is on.
  const installedCount = useLibraryStore((s) =>
    s.games.reduce((n, g) => (g.installed ? n + 1 : n), 0)
  )
  const lanParty = useLanPartyIds(filters.players.includes(LAN_PARTY.id), installedCount)
  const tabGroups = useMemo(
    () => tabGroupsOf(tabPool, everyCopy, showDuplicates),
    [tabPool, everyCopy, showDuplicates]
  )
  const { shown, copies, shownOf, sizeOf, releaseOf, playersOf, reviewsOf, difficultyOf, hltbOf } =
    useMemo(() => {
      const {
        kept,
        sizeOfGroup,
        releaseOfGroup,
        playersOfGroup,
        reviewsOfGroup,
        difficultyOfGroup,
        hltbOfGroup
      } = filterTabGroups(tabGroups, tabPool, {
        query: filters.query,
        platforms: filters.platforms,
        stores: filters.stores,
        genres: filters.genres,
        tags: filters.tags,
        eras: filters.eras,
        sizes: filters.sizes,
        hltb: filters.hltb,
        difficulty: filters.difficulty,
        reviews: filters.reviews,
        controls: filters.controls,
        players: filters.players,
        online: filters.online,
        hidden: filters.hidden,
        favorites: filters.favorites,
        coop: filters.coop,
        recomp: filters.recomp,
        developers: filters.developers,
        publishers: filters.publishers,
        custom: filters.custom,
        customFilters,
        lanParty
      })
      const counts = new Map<string, number>()
      const owners = new Map<string, string>()
      for (const group of kept) {
        if (group.copies.length > 1) counts.set(group.game.id, group.copies.length)
        for (const copy of group.copies) owners.set(copy.id, group.game.id)
      }
      return {
        shown: sortLibrary(
          kept.map((g) => g.game),
          filters.sort,
          filters.sortReversed,
          (game) => sizeOfGroup.get(game.id),
          (game) => releaseOfGroup.get(game.id),
          filters.playableFirst,
          (game) => playersOfGroup.get(game.id),
          (game) => reviewsOfGroup.get(game.id),
          (game) => difficultyOfGroup.get(game.id) ?? gameDifficultyOf(game),
          (game) => hltbOfGroup.get(game.id)
        ),
        sizeOf: sizeOfGroup,
        releaseOf: releaseOfGroup,
        playersOf: playersOfGroup,
        reviewsOf: reviewsOfGroup,
        difficultyOf: difficultyOfGroup,
        hltbOf: hltbOfGroup,
        copies: counts,
        shownOf: owners
      }
    }, [
      tabGroups,
      tabPool,
      filters.query,
      filters.platforms,
      filters.stores,
      filters.hidden,
      filters.genres,
      filters.tags,
      filters.favorites,
      filters.coop,
      filters.recomp,
      filters.developers,
      filters.publishers,
      filters.eras,
      filters.sizes,
      filters.hltb,
      filters.difficulty,
      filters.reviews,
      filters.controls,
      filters.players,
      filters.online,
      filters.sort,
      filters.sortReversed,
      filters.playableFirst,
      filters.custom,
      customFilters,
      lanParty
    ])
  const sections = useMemo(
    () =>
      librarySections(
        shown,
        filters.sort,
        new Date(),
        (game) => sizeOf.get(game.id),
        (game) => releaseOf.get(game.id),
        filters.playableFirst,
        (game) => playersOf.get(game.id),
        (game) => reviewsOf.get(game.id),
        (game) => difficultyOf.get(game.id) ?? gameDifficultyOf(game),
        (game) => hltbOf.get(game.id)
      ),
    [
      shown,
      filters.sort,
      sizeOf,
      releaseOf,
      playersOf,
      reviewsOf,
      difficultyOf,
      hltbOf,
      filters.playableFirst
    ]
  )
  // What Filters > Favorites would show on this tab.
  const favoriteCount = useMemo(() => tabGroups.filter((g) => g.game.favorite).length, [tabGroups])
  // What Filters > Nucleus Co-Op would show on this tab.
  // What Filters > Recompilations would show on this tab.
  const recompCount = useMemo(() => tabGroups.filter(hasRecomp).length, [tabGroups])
  // What each of Filters > Custom's filters would show on this tab (a card any copy of which is in it).
  const customCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const filter of customFilters) {
      const ids = new Set(filter.gameIds)
      counts.set(
        filter.id,
        tabGroups.filter((g) => ids.has(g.game.id) || g.copies.some((c) => ids.has(c.id))).length
      )
    }
    return counts
  }, [customFilters, tabGroups])
  // The tab's remembered card, read once per tab: the grid uses it on mount, and subscribing to the
  // store's libraryFocus would re-render the whole view on every card focus. A remembered copy that another
  // copy now stands for (Preferred Copy changed) resolves to that card.
  const initialGameId = useMemo(() => {
    const remembered = useUiStore.getState().libraryFocus[tab] ?? null
    return remembered ? (shownOf.get(remembered) ?? remembered) : null
    // per tab only (see above)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])
  // The tab's scroll, read once per tab like the card above (a remembered copy resolves the same way).
  const initialScroll = useMemo(() => {
    const saved = useUiStore.getState().libraryScroll[tab]
    return saved ? { ...saved, gameId: shownOf.get(saved.gameId) ?? saved.gameId } : null
    // per tab only (see above)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  const empty = shown.length === 0

  // The view is a focus boundary: directional moves never leave it for Home's (hidden) cards. Its preferred
  // child is the grid, or the accounts panel while the Settings tab is active.
  const { ref, focusKey } = useFocusable<object, HTMLDivElement>({
    focusKey: LIBRARY_KEY,
    isFocusBoundary: true,
    trackChildren: true,
    preferredChildFocusKey: onSettings ? SETTINGS_TAB_KEY : GRID_KEY
  })

  // Focus recovery whenever the view becomes interactive: after a modal closed over a card that vanished
  // with it (hidden or removed from the Play menu), or when the view is re-opened during its exit
  // animation (focus is back on a Home card by then), nothing else moves focus into the view. The
  // boundary resolves to the grid's remembered or first card, or to the search field when the grid is empty.
  // The Settings tab is left out: its Settings menu seeds and recovers its own focus (SettingsTab), and a second
  // seed from here would race it.
  useEffect(() => {
    if (!active) return undefined
    // Deferred past the grid's own initial focus (Norigin's setFocus resolves asynchronously): checked
    // synchronously here, the Home card would still be focused and the two moves would race.
    const timer = setTimeout(() => {
      if (useUiStore.getState().library.tab === LIBRARY_SETTINGS_TAB) return
      const current = getCurrentFocusKey()
      if (!current || !doesFocusableExist(current) || !isFocusWithin(LIBRARY_KEY)) {
        // An empty grid mounted earlier has no card to land on (the last hidden game was just shown again).
        void setFocus(empty ? SEARCH_KEY : LIBRARY_KEY)
      }
    }, 0)
    return () => clearTimeout(timer)
  }, [active, empty])

  // A game page's chip opened this view filtered by it (ui.showInLibrary): its card takes focus once the view is
  // interactive. Declared after the recovery above, so this runs after it (the recovery would land on the first card
  // of the new list; a grid already mounted on this tab does not read its remembered card again).
  const focusRequest = useUiStore((s) => s.libraryFocusRequest)
  useEffect(() => {
    if (!active || !focusRequest) return undefined
    const timer = setTimeout(() => {
      useUiStore.getState().clearLibraryFocusRequest()
      const id = shownOf.get(focusRequest.gameId) ?? focusRequest.gameId
      const key = cardFocusKey(LIBRARY_ROW, id)
      if (doesFocusableExist(key)) void setFocus(key)
      else focusCardInRow(LIBRARY_ROW, id)
    }, 0)
    return () => clearTimeout(timer)
  }, [active, focusRequest, shownOf])

  // A focused card that left the grid while the view stayed interactive (un-favourited under Filters > Favorites,
  // another copy chosen as the preferred one): focus the card that now stands for the game, or the one that took
  // its place, instead of leaving focus on an unmounted key.
  // A tab switch re-mounts the grid, which focuses the tab's remembered card itself: not a vanished card.
  const previousShown = useRef({ tab, shown })
  useEffect(() => {
    const before = previousShown.current
    previousShown.current = { tab, shown }
    if (!active || before.shown === shown || before.tab !== tab) return undefined
    const vanished = getCurrentFocusKey()
    const card = parseCardFocusKey(vanished)
    if (!card || card.rowId !== LIBRARY_ROW || shown.some((g) => g.id === card.gameId))
      return undefined
    const stand = shownOf.get(card.gameId)
    const index = before.shown.findIndex((g) => g.id === card.gameId)
    const next = stand ?? shown[Math.min(Math.max(0, index), shown.length - 1)]?.id
    // After the grid's commit, so the card is registered; and only while focus is still on the vanished card
    // (something else may have moved it meanwhile).
    const timer = setTimeout(() => {
      if (getCurrentFocusKey() !== vanished) return
      const key = next ? cardFocusKey(LIBRARY_ROW, next) : null
      if (key && doesFocusableExist(key)) void setFocus(key)
      else if (next && focusCardInRow(LIBRARY_ROW, next)) return
      else void setFocus(SEARCH_KEY)
    }, 0)
    return () => clearTimeout(timer)
  }, [tab, shown, shownOf, active])

  // ---- leaving: Home takes focus back at once; the view fades out and tells App when it is gone -------
  const close = useCallback((): boolean => {
    const ui = useUiStore.getState()
    if (ui.screen !== 'library') return false
    ui.setScreen('home')
    return true
  }, [])
  const onAnimationEnd = useCallback(
    (event: AnimationEvent<HTMLDivElement>) => {
      if (leaving && event.target === event.currentTarget) onLeft()
    },
    [leaving, onLeft]
  )
  useEffect(() => {
    if (!leaving) return
    const el = ref.current
    const duration = el ? parseFloat(getComputedStyle(el).animationDuration) : 0
    if (!(duration > 0)) onLeft()
  }, [leaving, onLeft, ref])

  // ---- tabs: the grid re-mounts per tab and slides in from the side the new tab is on ---------------
  const [slide, setSlide] = useState<1 | -1 | 0>(0)
  // Focus follows a tab switch into the grid unless the user was on the tabs or header controls.
  const [gridAutoFocus, setGridAutoFocus] = useState(true)
  const selectTab = useCallback(
    (next: string) => {
      if (next === tab) return
      const from = tabs.findIndex((entry) => entry.id === tab)
      const to = tabs.findIndex((entry) => entry.id === next)
      const onTabs = isFocusWithin(TABS_KEY)
      setSlide(to > from ? 1 : -1)
      // The header (search, sort pills) unmounts with the Settings tab, so a focus there cannot be kept across
      // a switch to it: the Settings menu takes the focus (its section list), as it does from a card (the
      // panel seeds itself whenever the focused control is gone, so it needs no flag).
      const keepsHeader = next !== LIBRARY_SETTINGS_TAB && isFocusWithin(HEADER_KEY)
      setGridAutoFocus(!(onTabs || keepsHeader))
      activateTab(next)
      // LB/RB (Q/E) while on the strip: the focus ring follows the underline to the new tab (every tab
      // button is mounted, so this resolves at once); a click already focused the tab, so it is a no-op.
      if (onTabs) void setFocus(tabFocusKey(next))
    },
    [tabs, tab]
  )
  const step = useCallback(
    (delta: 1 | -1): boolean => {
      const next = stepTab(tabs, tab, delta)
      if (next === tab) return true
      selectTab(next)
      return true
    },
    [tabs, tab, selectTab]
  )

  const focusSearch = useCallback((): boolean => {
    void setFocus(SEARCH_KEY)
    return true
  }, [])
  // View / '/': focus the search pill and activate it, so a gamepad gets the on-screen keyboard and a
  // keyboard the caret without a second press. The Settings tab has no search field: View does nothing there.
  const activateSearch = useCallback((): boolean => {
    if (onSettings) return true
    void setFocus(SEARCH_KEY).then(() => {
      if (getCurrentFocusKey() !== SEARCH_KEY) return
      pressEnter()
      releaseEnter()
    })
    return true
  }, [onSettings])

  // Y (the cover menu) and Start (Settings) are App's.
  useActionHandlers(
    {
      back: close,
      // Right stick up returns Home, except on the Settings tab while its section is scrolled down: then the stick
      // scrolls it back up first (input/stickScroll.ts), as the wheel does.
      'rs-up': () => {
        const pane = ref.current?.querySelector<HTMLElement>(
          '.library__settings .settings__content'
        )
        if (onSettings && pane && pane.scrollTop > 0) return false
        return close()
      },
      lb: () => step(-1),
      rb: () => step(1),
      x: () => toggleFocusedFavorite(),
      select: activateSearch,
      // LT / RT open the Sort / Filters menus where they are, without moving focus to the pills first, so
      // closing a menu returns to the card. The Settings tab has neither (no pill registered: nothing opens).
      lt: () => {
        openPopup(SORT_KEY)
        return true
      },
      rt: () => {
        openPopup(CATEGORY_KEY)
        return true
      }
    },
    active
  )

  const openDetail = useCallback(
    (game: Game) => {
      openModal({ type: 'detail', gameId: game.id })
    },
    [openModal]
  )
  const onCardFocus = useCallback((game: Game) => rememberPosition(tab, game.id), [tab])
  const onScrollChange = useCallback(
    (position: LibraryScrollPosition | null) => rememberScroll(tab, position),
    [tab]
  )

  // ---- "+" adds a tab (All Games, Title A–Z, playable first) at the end; the X next to Filters removes the shown one ---
  const onAddTab = useCallback(() => {
    if (libraryTabDefs().length >= MAX_LIBRARY_TABS_UI) {
      useUiStore.getState().toast(t('library.tabs.limit', { max: MAX_LIBRARY_TABS_UI }), 'info')
      return
    }
    const onTabs = isFocusWithin(TABS_KEY)
    setSlide(1)
    setGridAutoFocus(!onTabs)
    const def = addTab()
    if (def && onTabs) void setFocus(tabFocusKey(def.id))
  }, [t])
  // The X asks first (Delete Tab, Yes / No); only Yes deletes the tab it was pressed on.
  const onDeleteTab = useCallback(() => {
    const id = useUiStore.getState().library.tab
    if (id === LIBRARY_SETTINGS_TAB) return
    const name = tabs.find((entry) => entry.id === id)?.label ?? t('library.tabs.thisTab')
    useUiStore.getState().openModal({
      type: 'confirm',
      title: t('library.tabs.deleteTitle'),
      message: t('library.tabs.deleteMessage', { name }),
      confirmLabel: t('library.tabs.yes'),
      cancelLabel: t('library.tabs.no'),
      danger: true,
      onConfirm: () => {
        setSlide(1)
        // The focus stays on the X, now the next tab's.
        setGridAutoFocus(false)
        deleteTab(id)
      }
    })
  }, [tabs, t])

  // ---- wheel up / swipe down at the top of the grid returns Home ---------------------------------------
  useEffect(() => {
    const root = ref.current
    if (!root || leaving) return undefined
    const exit = new WheelExit(WHEEL_EXIT, performance.now())
    let touch: { id: number; x: number; y: number } | null = null
    // Whichever scroller the active tab renders: the grid viewport, or the Settings menu's section pane on the
    // Settings tab, so a wheel-up there scrolls it before it exits.
    const atTop = (): boolean => {
      const viewport = root.querySelector<HTMLElement>(
        '.library__viewport, .library__settings .settings__content'
      )
      return !viewport || viewport.scrollTop <= 0
    }
    // Any pushed layer (a modal, the floating on-screen keyboard) owns the input.
    const blocked = (): boolean => topLayer() !== ROOT_LAYER
    // `scroll` does not bubble and the viewport is re-keyed per tab: capture it on the root instead.
    // The tab strip scrolling sideways (dragged, the wheel over it, the right stick) is not the grid moving.
    const onScroll = (event: Event): void => {
      if (event.target instanceof Element && event.target.classList.contains('library__tabs'))
        return
      exit.scrolled(performance.now())
    }
    const onWheel = (event: WheelEvent): void => {
      if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
      const done = exit.wheel({
        deltaY: event.deltaY,
        now: performance.now(),
        atTop: atTop(),
        blocked: blocked()
      })
      if (done) close()
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (event.pointerType !== 'touch') return
      // A finger on the tabs while they scroll sideways, or on their scroll bar, drags those: never a swipe Home.
      if (
        event.target instanceof Element &&
        event.target.closest('.library__tabs-group--scrolls, .library__tabs-scrollbar')
      ) {
        touch = null
        return
      }
      // Only a swipe that starts at a resting top exits (not one finishing an inertial scroll up).
      touch = exit.restedAtTop(performance.now(), atTop())
        ? { id: event.pointerId, x: event.clientX, y: event.clientY }
        : null
    }
    const onPointerMove = (event: PointerEvent): void => {
      if (!touch || event.pointerId !== touch.id) return
      const dx = event.clientX - touch.x
      const dy = event.clientY - touch.y
      if (dy < SWIPE_REM * remPx() || Math.abs(dy) < Math.abs(dx)) return
      touch = null
      if (atTop() && !blocked()) close()
    }
    const onPointerEnd = (event: PointerEvent): void => {
      if (touch && event.pointerId === touch.id) touch = null
    }
    root.addEventListener('scroll', onScroll, { capture: true, passive: true })
    root.addEventListener('wheel', onWheel, { passive: true })
    root.addEventListener('pointerdown', onPointerDown)
    root.addEventListener('pointermove', onPointerMove)
    root.addEventListener('pointerup', onPointerEnd)
    root.addEventListener('pointercancel', onPointerEnd)
    return () => {
      root.removeEventListener('scroll', onScroll, { capture: true })
      root.removeEventListener('wheel', onWheel)
      root.removeEventListener('pointerdown', onPointerDown)
      root.removeEventListener('pointermove', onPointerMove)
      root.removeEventListener('pointerup', onPointerEnd)
      root.removeEventListener('pointercancel', onPointerEnd)
    }
  }, [ref, leaving, close])

  const openAddGames = useCallback(() => {
    openModal({ type: 'addgames' })
  }, [openModal])
  const hints = useMemo(() => libraryHints(t, onSettings), [t, onSettings])

  // Stable header callbacks: the header, its text field and pills then re-render only when a value changes.
  // Every change is the shown tab's: kept with it between sessions (state/libraryTabs.ts).
  const onQuery = useCallback((query: string) => updateActiveTab({ query }), [])
  // Picking the current sort again turns it around; another sort starts in its own direction.
  const onSort = useCallback((sort: LibrarySort) => {
    const current = useUiStore.getState().library
    updateActiveTab(
      sort === current.sort
        ? { sortReversed: !current.sortReversed }
        : { sort, sortReversed: false }
    )
  }, [])
  // The playable-first button: on and off, the sort and filters as they are.
  const onPlayableFirst = useCallback(() => {
    updateActiveTab({ playableFirst: !useUiStore.getState().library.playableFirst })
  }, [])
  const onSizes = useCallback((sizes: string[]) => updateActiveTab({ sizes }), [])
  const onHltb = useCallback((hltb: string[]) => updateActiveTab({ hltb }), [])
  const onDifficulty = useCallback((difficulty: string[]) => updateActiveTab({ difficulty }), [])
  const onReviews = useCallback((reviews: string[]) => updateActiveTab({ reviews }), [])
  const onControls = useCallback((controls: string[]) => updateActiveTab({ controls }), [])
  const onPlayers = useCallback((players: string[]) => updateActiveTab({ players }), [])
  const onOnline = useCallback((online: string[]) => updateActiveTab({ online }), [])
  const onTags = useCallback((tags: string[]) => updateActiveTab({ tags }), [])
  const onStores = useCallback((stores: string[]) => updateActiveTab({ stores }), [])
  const onEras = useCallback((eras: string[]) => updateActiveTab({ eras }), [])
  const onPlatforms = useCallback((platforms: string[]) => updateActiveTab({ platforms }), [])
  const onHidden = useCallback((hidden: boolean) => updateActiveTab({ hidden }), [])
  const onFavorites = useCallback((favorites: boolean) => updateActiveTab({ favorites }), [])
  const onCoop = useCallback((coop: boolean) => updateActiveTab({ coop }), [])
  const onRecomp = useCallback((recomp: boolean) => updateActiveTab({ recomp }), [])
  const onDevelopers = useCallback((developers: string[]) => updateActiveTab({ developers }), [])
  const onPublishers = useCallback((publishers: string[]) => updateActiveTab({ publishers }), [])
  const onCustom = useCallback((custom: string[]) => updateActiveTab({ custom }), [])
  // Filters > Clear filters (> All): every choice of this tab off, a game page's developers and publishers too (the
  // search and sort stay); the tab is All Games then.
  const onClearFilters = useCallback(
    () =>
      updateActiveTab({
        platforms: [],
        genres: [],
        tags: [],
        stores: [],
        eras: [],
        sizes: [],
        hltb: [],
        difficulty: [],
        reviews: [],
        controls: [],
        players: [],
        online: [],
        hidden: false,
        favorites: false,
        coop: false,
        recomp: false,
        developers: [],
        publishers: [],
        custom: []
      }),
    []
  )

  return (
    <FocusContext.Provider value={focusKey}>
      <div
        ref={ref}
        className={cx('library-page', leaving && 'library-page--leaving')}
        aria-hidden={leaving}
        onAnimationEnd={onAnimationEnd}
      >
        <LibraryBackdrop />
        <div className="library__band">
          <TabStrip
            tabs={tabs}
            active={tab}
            onSelect={selectTab}
            onUp={close}
            onAdd={onAddTab}
            shown={active}
          />
        </div>

        <div className="library__body">
          {onSettings ? (
            // The Settings modal shows the same menu, with the same focus keys: the tab gives way while one is
            // mounted (open or closing).
            settingsModalOpen ? null : (
              <SettingsTab key={tab} active={active} direction={slide} />
            )
          ) : (
            <>
              <LibraryHeader
                query={filters.query}
                onQuery={onQuery}
                playableFirst={filters.playableFirst}
                onPlayableFirst={onPlayableFirst}
                onOpenFolders={folderTarget ? onOpenFolders : undefined}
                sort={filters.sort}
                sortReversed={filters.sortReversed}
                onSort={onSort}
                platforms={filters.platforms}
                platformOptions={platformOptions}
                onPlatforms={onPlatforms}
                sizes={filters.sizes}
                onSizes={onSizes}
                hltb={filters.hltb}
                onHltb={onHltb}
                difficulty={filters.difficulty}
                onDifficulty={onDifficulty}
                reviews={filters.reviews}
                onReviews={onReviews}
                controls={filters.controls}
                onControls={onControls}
                players={filters.players}
                onPlayers={onPlayers}
                online={filters.online}
                onOnline={onOnline}
                tags={filters.tags}
                tagOptions={tagOptions}
                onTags={onTags}
                stores={filters.stores}
                storeOptions={storeOptions}
                onStores={onStores}
                eras={filters.eras}
                eraOptions={eraOptions}
                controlsOptions={controlsOptions}
                onEras={onEras}
                hidden={filters.hidden}
                onHidden={onHidden}
                hiddenCount={hiddenList.length}
                favorites={filters.favorites}
                onFavorites={onFavorites}
                favoriteCount={favoriteCount}
                coop={filters.coop}
                onCoop={onCoop}
                recomp={filters.recomp}
                onRecomp={onRecomp}
                recompCount={recompCount}
                developers={filters.developers}
                onDevelopers={onDevelopers}
                publishers={filters.publishers}
                onPublishers={onPublishers}
                custom={filters.custom}
                onCustom={onCustom}
                customCounts={customCounts}
                onClearFilters={onClearFilters}
                onDeleteTab={onDeleteTab}
                canDeleteTab={tabCount > 1}
              />
              <LibraryGrid
                key={tab}
                games={shown}
                platformsById={platformsById}
                initialGameId={initialGameId}
                autoFocus={gridAutoFocus}
                direction={slide}
                onOpen={openDetail}
                onCardFocus={onCardFocus}
                onEmpty={focusSearch}
                copies={copies}
                sections={sections}
                sort={filters.sort}
                sortReversed={filters.sortReversed}
                active={active}
                initialScroll={initialScroll}
                onScrollChange={onScrollChange}
                coverScale={coverScale}
                onCoverScale={onCoverScale}
              />
            </>
          )}
        </div>

        <div className="library__bar">
          <ImportButton onPress={openAddGames} />
        </div>
        {active ? <ButtonHints hints={hints} /> : null}
      </div>
    </FocusContext.Provider>
  )
}

interface LibraryHeaderProps {
  query: string
  onQuery: (query: string) => void
  playableFirst: boolean
  onPlayableFirst: () => void
  /** The folder button (a tab with Platform or PC filters): opens the folders of the games they pick. */
  onOpenFolders?: () => void
  sort: LibrarySort
  sortReversed: boolean
  onSort: (sort: LibrarySort) => void
  platforms: readonly string[]
  platformOptions: readonly PlatformFilter[]
  onPlatforms: (platforms: string[]) => void
  sizes: readonly string[]
  onSizes: (sizes: string[]) => void
  hltb: readonly string[]
  onHltb: (hltb: string[]) => void
  difficulty: readonly string[]
  onDifficulty: (difficulty: string[]) => void
  reviews: readonly string[]
  onReviews: (reviews: string[]) => void
  controls: readonly string[]
  controlsOptions: readonly string[]
  onControls: (controls: string[]) => void
  players: readonly string[]
  onPlayers: (players: string[]) => void
  online: readonly string[]
  onOnline: (online: string[]) => void
  tags: readonly string[]
  tagOptions: readonly TagFilter[]
  onTags: (tags: string[]) => void
  stores: readonly string[]
  storeOptions: readonly StoreFilter[]
  onStores: (stores: string[]) => void
  eras: readonly string[]
  eraOptions: readonly ReleaseEra[]
  onEras: (eras: string[]) => void
  hidden: boolean
  onHidden: (hidden: boolean) => void
  hiddenCount: number
  favorites: boolean
  onFavorites: (favorites: boolean) => void
  favoriteCount: number
  coop: boolean
  onCoop: (coop: boolean) => void
  recomp: boolean
  onRecomp: (recomp: boolean) => void
  recompCount: number
  developers: readonly string[]
  onDevelopers: (developers: string[]) => void
  publishers: readonly string[]
  onPublishers: (publishers: string[]) => void
  custom: readonly string[]
  onCustom: (custom: string[]) => void
  customCounts: ReadonlyMap<string, number>
  onClearFilters: () => void
  onDeleteTab: () => void
  canDeleteTab: boolean
}

/**
 * The game count ("Hidden" or "Favorites" before it in those views), the search pill and the sort / category pills; a container that remembers its last
 * focused control. The count stays short: the title block has ~340u next to the fixed-width search field
 * (the reference's geometry), which a "N games · M not installed" form does not fit; the greyed cards and
 * their "Not installed" markers carry that information in the grid.
 */
const LibraryHeader = memo(function LibraryHeader({
  query,
  onQuery,
  playableFirst,
  onPlayableFirst,
  onOpenFolders,
  sort,
  sortReversed,
  onSort,
  platforms,
  platformOptions,
  onPlatforms,
  sizes,
  onSizes,
  hltb,
  onHltb,
  difficulty,
  onDifficulty,
  reviews,
  onReviews,
  controls,
  onControls,
  players,
  onPlayers,
  online,
  onOnline,
  tags,
  tagOptions,
  onTags,
  stores,
  storeOptions,
  onStores,
  eras,
  eraOptions,
  controlsOptions,
  onEras,
  hidden,
  onHidden,
  hiddenCount,
  favorites,
  onFavorites,
  favoriteCount,
  coop,
  onCoop,
  recomp,
  onRecomp,
  recompCount,
  developers,
  onDevelopers,
  publishers,
  onPublishers,
  custom,
  onCustom,
  customCounts,
  onClearFilters,
  onDeleteTab,
  canDeleteTab
}: LibraryHeaderProps): ReactElement {
  const t = useT()
  // The Sort menu alphabetical in the language shown.
  const language = useLanguage()
  const sortOptions = useMemo(() => withSortIcons(librarySortOptions(language)), [language])
  // "fetching covers 1,234 left" while the cover lane runs, "fetching details N left" while only the full lane
  // does (ARCHITECTURE.md §4.6 "Progress"); nothing while the queues are idle.
  const progress = useLibraryStore((s) => s.metadataProgress)
  // "sizes N left" while the install-size pass looks up games that are not installed (after covers and details).
  const sizesLeft = useLibraryStore((s) => s.sizesLeft)
  // "Looking up H.L.T.B. times… N left" while the H.L.T.B. sort is shown and HowLongToBeat times are being looked up
  // (the sort's own lookups of games without a time only: the start-up pass, which also re-checks games with times,
  // keeps the bottom bar); nothing when idle, and nothing while HLTB is paused (the run stops then and reports total
  // 0; the sort asks again on its next 30-minute round).
  const hltbLeft = useLibraryStore((s) =>
    sort === 'hltb' && s.hltbScan.source === 'sort' && s.hltbScan.total > 0
      ? Math.max(0, s.hltbScan.total - s.hltbScan.done)
      : 0
  )
  const fetching = useMemo(() => {
    if (progress?.queued && progress.coverLane)
      return t('library.progress.covers', { left: progress.coverLane.toLocaleString() })
    if (progress?.queued && progress.fullLane)
      return t('library.progress.details', { left: progress.fullLane.toLocaleString() })
    if (hltbLeft > 0) return t('lib.view.hltbLookup', { count: hltbLeft })
    return sizesLeft > 0 ? t('library.progress.sizes', { left: sizesLeft.toLocaleString() }) : ''
  }, [progress, sizesLeft, hltbLeft, t])
  const { ref, focusKey } = useFocusable<object, HTMLDivElement>({
    focusKey: HEADER_KEY,
    trackChildren: true,
    saveLastFocusedChild: true,
    preferredChildFocusKey: SEARCH_KEY
  })
  const title = hidden ? t('library.title.hidden') : favorites ? t('library.title.favorites') : null
  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="library__header">
        {/* The folder button stands where the count was (a tab with Platform / PC filters), its own size like the
            row's other round buttons. */}
        {onOpenFolders ? <OpenFoldersButton onPress={onOpenFolders} /> : null}
        {/* The whole library has no title (the search field left it no room); the Hidden and Favorites views keep
            theirs, so it is clear which games are shown. The art and size progress line stays while there is some.
            With neither, no block at all: an empty one would still take a gap of the row. */}
        {title || fetching ? (
          <div className="library__title-block">
            {title ? <h1 className="library__title">{title}</h1> : null}
            {fetching ? <span className="library__count">{fetching}</span> : null}
          </div>
        ) : null}
        <TextField
          focusKey={SEARCH_KEY}
          className="library__search"
          placeholder={t('library.search.placeholder')}
          aria-label={t('library.search.label')}
          oskTitle={t('library.search.keyboardTitle')}
          value={query}
          onChange={onQuery}
          clearable
        />
        <PlayableFirstButton active={playableFirst} onPress={onPlayableFirst} />
        <SelectField
          focusKey={SORT_KEY}
          variant="pill"
          className="library__select library__select--sort"
          label={t('library.sort')}
          value={sort}
          options={sortOptions}
          direction={sortReversed ? 'up' : 'down'}
          onChange={onSort}
        />
        <FiltersPill
          platforms={platforms}
          platformOptions={platformOptions}
          onPlatforms={onPlatforms}
          tags={tags}
          tagOptions={tagOptions}
          onTags={onTags}
          stores={stores}
          storeOptions={storeOptions}
          onStores={onStores}
          eras={eras}
          eraOptions={eraOptions}
          onEras={onEras}
          sizes={sizes}
          onSizes={onSizes}
          hltb={hltb}
          onHltb={onHltb}
          difficulty={difficulty}
          onDifficulty={onDifficulty}
          reviews={reviews}
          onReviews={onReviews}
          controls={controls}
          controlsOptions={controlsOptions}
          onControls={onControls}
          players={players}
          onPlayers={onPlayers}
          online={online}
          onOnline={onOnline}
          hidden={hidden}
          onHidden={onHidden}
          hiddenCount={hiddenCount}
          favorites={favorites}
          onFavorites={onFavorites}
          favoriteCount={favoriteCount}
          coop={coop}
          onCoop={onCoop}
          recomp={recomp}
          onRecomp={onRecomp}
          recompCount={recompCount}
          developers={developers}
          onDevelopers={onDevelopers}
          publishers={publishers}
          onPublishers={onPublishers}
          custom={custom}
          onCustom={onCustom}
          customCounts={customCounts}
          onClearFilters={onClearFilters}
        />
        <DeleteTabButton onPress={onDeleteTab} disabled={!canDeleteTab} />
      </div>
    </FocusContext.Provider>
  )
})

/**
 * The focused game's hero art behind the page, blurred to a flat tone that the translucent top and
 * bottom bands show (Home's backdrop no longer reaches the bottom band). Follows the settled hero
 * (useHeroGame: 150 ms after the last focus change) through HeroBackdrop's layered crossfade, so D-pad
 * repeat through a large grid neither thrashes the art nor flashes the bands dark between heroes. Its
 * own component so the focus subscription re-renders only this subtree.
 */
function LibraryBackdrop(): ReactElement {
  const game = useHeroGame(undefined)
  return (
    <div className="library__backdrop" aria-hidden="true">
      <HeroBackdrop game={game} gradients={false} />
    </div>
  )
}

/**
 * The playable-first button between the search and the Sort pill: on, the games installed on this PC come before the
 * rest, each part in the tab's sort (and direction); the filters decide which games show either way. A round
 * pill-height bubble like the X; it glows in the accent colour while on. Pressing keeps the focus on it.
 */
function PlayableFirstButton({
  active,
  onPress
}: {
  active: boolean
  onPress: () => void
}): ReactElement {
  const t = useT()
  const { ref, props: controlProps } = useFocusableControl<HTMLButtonElement>({
    focusKey: PLAYABLE_KEY,
    onPress,
    scroll: false
  })
  return (
    <button
      ref={ref}
      type="button"
      className={cx('library__playable', active && 'library__playable--on')}
      aria-label={t('library.playableFirst.label')}
      aria-pressed={active}
      title={active ? t('library.playableFirst.on') : t('library.playableFirst.off')}
      {...controlProps}
    >
      <Download aria-hidden="true" />
    </button>
  )
}

/** The header's folder button: opens the folders of the games the tab's Platform / PC filters pick. */
function OpenFoldersButton({ onPress }: { onPress: () => void }): ReactElement {
  const t = useT()
  const { ref, props: controlProps } = useFocusableControl<HTMLButtonElement>({
    focusKey: FOLDERS_KEY,
    onPress,
    scroll: false
  })
  return (
    <button
      ref={ref}
      type="button"
      className="library__playable library__folders"
      aria-label={t('library.folders.button')}
      title={t('library.folders.button')}
      {...controlProps}
    >
      <FolderOpen aria-hidden="true" />
    </button>
  )
}

/** The X right of the Filters pill: removes the tab shown (not the last one: there is always a tab). */
function DeleteTabButton({
  onPress,
  disabled
}: {
  onPress: () => void
  disabled: boolean
}): ReactElement {
  const t = useT()
  const press = useCallback(() => {
    if (!disabled) onPress()
  }, [disabled, onPress])
  const { ref, props: controlProps } = useFocusableControl<HTMLButtonElement>({
    focusKey: DELETE_TAB_KEY,
    onPress: press,
    scroll: false
  })
  return (
    <button
      ref={ref}
      type="button"
      className="library__delete-tab"
      aria-label={t('library.tabs.delete')}
      title={disabled ? t('library.tabs.lastTab') : t('library.tabs.delete')}
      aria-disabled={disabled}
      {...controlProps}
    >
      <X aria-hidden="true" />
    </button>
  )
}

/** "Library Import" at the left of the bottom band: opens the Add Games modal. */
function ImportButton({ onPress }: { onPress: () => void }): ReactElement {
  const t = useT()
  const { ref, props: controlProps } = useFocusableControl<HTMLButtonElement>({
    focusKey: IMPORT_KEY,
    onPress,
    scroll: false
  })
  return (
    <button ref={ref} type="button" className="library__import" {...controlProps}>
      <Gamepad2 aria-hidden="true" />
      <span>{t('library.import')}</span>
    </button>
  )
}

function remPx(): number {
  const size = parseFloat(getComputedStyle(document.documentElement).fontSize)
  return Number.isFinite(size) && size > 0 ? size : 10
}
