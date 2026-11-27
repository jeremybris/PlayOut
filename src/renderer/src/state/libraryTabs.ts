import type {
  LibraryScrollPosition,
  LibraryTabDef,
  LibraryTabFilters,
  LibrarySortId,
  Settings
} from '@shared/types'
import {
  MAX_LIBRARY_TABS_UI,
  migrateTabDef,
  migrateTabs,
  neighbourAfterRemoval,
  newTabDef,
  sameTabFilters,
  savableTabs,
  tabFiltersOf,
  toggledChoice,
  type TabChoice
} from '../lib/libraryTabs'
import { LIBRARY_SETTINGS_TAB, type LibraryTab } from '../lib/libraryView'
import { t } from '../i18n'
import { currentSettings, useSettingsStore } from './settings'
import { DEFAULT_LIBRARY_FILTERS, useUiStore, type LibraryFilters } from './ui'

/**
 * The Library's saved tabs (settings.ui.libraryTabs) and the live view (ui store `library`): the active tab's filters
 * and sort are copied into the view when the tab is shown, and every change to them is written back to the tab, so
 * each tab keeps its own between sessions, its search text included. The active tab (ui.libraryTab) and each tab's
 * focused card (ui.libraryPositions) are saved too.
 */

/** A focused card is saved this long after the last move, not on every card the focus passes. */
const POSITION_SAVE_DELAY_MS = 1500
/** Filter and sort changes are saved after this pause (a burst of picks writes settings.json once). */
const TAB_SAVE_DELAY_MS = 400

/** The user's tabs; [] until settings are loaded and the first run has made them. */
export function libraryTabDefs(): LibraryTabDef[] {
  return currentSettings().ui.libraryTabs ?? []
}

/** The longest search kept with a tab (settings-schema.ts libraryTabDefSchema). */
const MAX_SAVED_QUERY = 200
/** The longest game id a saved position keeps (settings-schema.ts ui.libraryPositions). */
const MAX_SAVED_POSITION = 300

/** What a tab puts into the view: its filters, sort and search. */
function viewOf(def: LibraryTabDef): Partial<typeof DEFAULT_LIBRARY_FILTERS> {
  const filters = tabFiltersOf(def.filters)
  return {
    tab: def.id,
    ...filters,
    // A saved tab leaves empty lists out: the view's are replaced, not kept from the tab shown before.
    developers: filters.developers ?? [],
    publishers: filters.publishers ?? [],
    difficulty: filters.difficulty ?? [],
    reviews: filters.reviews ?? [],
    sort: def.sort,
    sortReversed: def.sortReversed,
    playableFirst: def.playableFirst,
    query: def.query ?? ''
  }
}

let tabsTimer: ReturnType<typeof setTimeout> | null = null
let pendingTabs: LibraryTabDef[] | null = null

/**
 * Whether tab changes are written to settings.json: off when the settings could not be loaded (the store holds the
 * defaults, and a write would replace the saved tabs with the ones made in memory for this session).
 */
let persist = true

/** Write ui settings, or only change them in memory while `persist` is off. */
function writeUi(patch: Partial<Settings['ui']>): void {
  const store = useSettingsStore.getState()
  if (persist) {
    void store.update({ ui: patch })
    return
  }
  if (store.settings)
    useSettingsStore.setState({
      settings: { ...store.settings, ui: { ...store.settings.ui, ...patch } }
    })
}

/** Save the tabs (now, or after TAB_SAVE_DELAY_MS for a burst of filter picks); the settings store updates at once. */
function saveTabs(given: LibraryTabDef[], delayed = false): void {
  const store = useSettingsStore.getState()
  if (!store.settings) return
  // Empty developer / publisher lists are left out: a tab without them stays what an older paired PC accepts.
  const defs = savableTabs(given)
  if (!delayed) {
    if (tabsTimer) clearTimeout(tabsTimer)
    tabsTimer = null
    pendingTabs = null
    writeUi({ libraryTabs: defs })
    return
  }
  // Optimistic in memory now; one write for the burst. Pending first: the store's subscriber below puts the
  // pending tabs back over any other.
  pendingTabs = defs
  useSettingsStore.setState({
    settings: { ...store.settings, ui: { ...store.settings.ui, libraryTabs: defs } }
  })
  if (tabsTimer) clearTimeout(tabsTimer)
  tabsTimer = setTimeout(() => {
    tabsTimer = null
    const defsToSave = pendingTabs
    pendingTabs = null
    if (defsToSave) writeUi({ libraryTabs: defsToSave })
  }, TAB_SAVE_DELAY_MS)
}

// A settings write that was already on its way returns settings without the tabs waiting for their pause: they are
// put back, so the strip and the next change never work from the older tabs.
useSettingsStore.subscribe((state) => {
  if (pendingTabs && state.settings && state.settings.ui.libraryTabs !== pendingTabs)
    useSettingsStore.setState({
      settings: { ...state.settings, ui: { ...state.settings.ui, libraryTabs: pendingTabs } }
    })
})

/** Remember which tab is shown, for the next start. */
function saveActive(id: string): void {
  if (currentSettings().ui.libraryTab === id) return
  writeUi({ libraryTab: id })
}

/** Show a tab: its filters and sort in the view, its position remembered. 'settings' shows the Settings tab. */
export function activateTab(id: string): void {
  const ui = useUiStore.getState()
  if (id === LIBRARY_SETTINGS_TAB) {
    ui.setLibraryFilters({ tab: id })
    saveActive(id)
    return
  }
  const def = libraryTabDefs().find((d) => d.id === id) ?? libraryTabDefs()[0]
  if (!def) return
  ui.setLibraryFilters(viewOf(def))
  saveActive(def.id)
}

/**
 * Change the active tab's filters or sort: the view changes at once, the tab is saved after a short pause. On the
 * Settings tab (no filters) nothing happens.
 */
export function updateActiveTab(
  patch: Partial<LibraryTabFilters> & {
    sort?: LibrarySortId
    sortReversed?: boolean
    playableFirst?: boolean
    query?: string
  }
): void {
  useUiStore.getState().setLibraryFilters(patch)
  // The view is the shown tab as the user sees it: the tab is saved as the view stands, so no change is lost to a
  // stale copy of the tabs.
  const view = useUiStore.getState().library
  const defs = libraryTabDefs()
  const index = defs.findIndex((d) => d.id === view.tab)
  if (index < 0) return
  const next: LibraryTabDef = {
    id: view.tab,
    filters: tabFiltersOf(view),
    sort: view.sort,
    sortReversed: view.sortReversed,
    playableFirst: view.playableFirst
  }
  const query = view.query.slice(0, MAX_SAVED_QUERY)
  if (query.trim()) next.query = query
  const out = [...defs]
  out[index] = next
  saveTabs(out, true)
}

/**
 * Add a tab (All Games on Title A–Z, playable games first, unless given) at the right end, and show it unless `show` is false
 * (Settings > Library adds without leaving the Settings menu). null when there are MAX_LIBRARY_TABS_UI tabs already.
 */
export function addTab(
  def: LibraryTabDef = newTabDef(),
  { show = true }: { show?: boolean } = {}
): LibraryTabDef | null {
  const defs = libraryTabDefs()
  if (!restored || defs.length >= MAX_LIBRARY_TABS_UI) return null
  saveTabs([...defs, def])
  if (show) activateTab(def.id)
  return def
}

/**
 * Remove a tab; the one to its right (else left) takes its place when it was shown. The last tab cannot be removed:
 * there is always one.
 */
export function deleteTab(id: string): boolean {
  const defs = libraryTabDefs()
  if (!restored || defs.length <= 1 || !defs.some((d) => d.id === id)) return false
  const neighbour = neighbourAfterRemoval(defs, id)
  const rest = defs.filter((d) => d.id !== id)
  saveTabs(rest)
  forgetPosition(id)
  if (useUiStore.getState().library.tab === id && neighbour) activateTab(neighbour)
  return true
}

/**
 * Replace the tabs (Settings > Library: order, filters and sort edited there). The shown tab's filters are reloaded when
 * they changed; a shown tab that went away hands over to its neighbour.
 */
export function setTabs(defs: LibraryTabDef[]): void {
  if (!restored) return
  const before = libraryTabDefs()
  saveTabs(defs)
  reconcileView(before, defs)
}

/**
 * The tabs went from `before` to `after`: the shown tab's filters are reloaded when they changed, and a shown tab that
 * went away hands over to its neighbour (else the first tab). Nothing is saved.
 */
function reconcileView(before: LibraryTabDef[], after: LibraryTabDef[]): void {
  const active = useUiStore.getState().library.tab
  if (active === LIBRARY_SETTINGS_TAB) return
  const now = after.find((d) => d.id === active)
  if (!now) {
    const neighbour =
      [neighbourAfterRemoval(before, active)].find((id) => after.some((d) => d.id === id)) ??
      after[0]?.id
    if (neighbour) activateTab(neighbour)
    return
  }
  const was = before.find((d) => d.id === active)
  if (
    !was ||
    !sameTabFilters(was.filters, now.filters) ||
    was.sort !== now.sort ||
    was.sortReversed !== now.sortReversed ||
    was.playableFirst !== now.playableFirst
  )
    useUiStore.getState().setLibraryFilters(viewOf(now))
}

/** The tabs as this module last saw them in the settings store. */
let seenTabs: LibraryTabDef[] | null = null

// Tabs that changed from outside this window (another PC's, taken by the Library tabs sync, arrive with the main
// process's settings event): the shown view follows them, as it does an edit in Settings > Library. This window's own
// edits have already updated the view (and a delayed one is still pending: its tabs win).
useSettingsStore.subscribe(() => {
  // The store as it stands (a subscriber above may have just put pending tabs back).
  const tabs = useSettingsStore.getState().settings?.ui.libraryTabs ?? null
  if (tabs === seenTabs) return
  const before = seenTabs
  seenTabs = tabs
  if (!restored || pendingTabs || !before || !tabs?.length) return
  reconcileView(before, tabs)
})

// ---- positions -------------------------------------------------------------------------------------------------

let positionsTimer: ReturnType<typeof setTimeout> | null = null

/** Remember the focused card of a tab: in the view at once, in settings after the focus rests. */
export function rememberPosition(tab: string, gameId: string): void {
  useUiStore.getState().rememberLibraryFocus(tab, gameId)
  if (positionsTimer) clearTimeout(positionsTimer)
  positionsTimer = setTimeout(() => {
    positionsTimer = null
    const positions = useUiStore.getState().libraryFocus
    const saved = currentSettings().ui.libraryPositions
    const known = new Set([LIBRARY_SETTINGS_TAB, ...libraryTabDefs().map((d) => d.id)])
    const next = savablePositions(positions, known)
    const same =
      Object.keys(next).length === Object.keys(saved).length &&
      Object.entries(next).every(([k, v]) => saved[k] === v)
    if (!same) writeUi({ libraryPositions: next })
  }, POSITION_SAVE_DELAY_MS)
}

function forgetPosition(id: string): void {
  const ui = useUiStore.getState()
  if (id in ui.libraryScroll) {
    ui.rememberLibraryScroll(id, null)
    writeUi({ libraryScroll: savableScroll(useUiStore.getState().libraryScroll) })
  }
  if (!(id in ui.libraryFocus)) return
  const { [id]: _gone, ...rest } = ui.libraryFocus
  void _gone
  useUiStore.setState({ libraryFocus: rest })
  writeUi({ libraryPositions: savablePositions(rest) })
}

let scrollTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Remember how far a tab's grid is scrolled (null: at the top): in the view at once, so switching tabs keeps it, and
 * in settings once the scrolling rests, so the next session opens there too.
 */
export function rememberScroll(tab: string, position: LibraryScrollPosition | null): void {
  useUiStore.getState().rememberLibraryScroll(tab, position)
  if (scrollTimer) clearTimeout(scrollTimer)
  scrollTimer = setTimeout(() => {
    scrollTimer = null
    saveScroll()
  }, POSITION_SAVE_DELAY_MS)
}

function saveScroll(): void {
  const known = new Set(libraryTabDefs().map((d) => d.id))
  const next = savableScroll(useUiStore.getState().libraryScroll, known)
  const saved = currentSettings().ui.libraryScroll ?? {}
  const same =
    Object.keys(next).length === Object.keys(saved).length &&
    Object.entries(next).every(
      ([k, v]) => saved[k]?.gameId === v.gameId && saved[k]?.offset === v.offset
    )
  if (!same) writeUi({ libraryScroll: next })
}

/** The scroll positions settings can keep (known tabs, ids within the schema's lengths, whole pixels). */
function savableScroll(
  scroll: Record<string, LibraryScrollPosition>,
  known?: ReadonlySet<string>
): Record<string, LibraryScrollPosition> {
  return Object.fromEntries(
    Object.entries(scroll)
      .filter(
        ([id, p]) =>
          (!known || known.has(id)) && p.gameId.length <= MAX_SAVED_POSITION && id.length <= 100
      )
      .map(([id, p]) => [
        id,
        { gameId: p.gameId, offset: Math.min(10_000, Math.max(0, Math.round(p.offset))) }
      ])
  )
}

/**
 * The positions settings can keep: those of known tabs (all when `known` is not given) whose game id fits the
 * schema (settings-schema.ts: 300 characters; a manual game's id holds its whole exe path and can be longer).
 */
function savablePositions(
  positions: Record<string, string>,
  known?: ReadonlySet<string>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(positions).filter(
      ([id, game]) =>
        (!known || known.has(id)) && game.length <= MAX_SAVED_POSITION && id.length <= 100
    )
  )
}

/**
 * Write what is waiting for its pause at once: the tabs and the positions. Called before the window goes (close,
 * reload, the power menu), so the last filter pick or card is not lost.
 */
export function flushLibraryTabs(): void {
  if (tabsTimer) {
    clearTimeout(tabsTimer)
    tabsTimer = null
    const defs = pendingTabs
    pendingTabs = null
    if (defs) writeUi({ libraryTabs: defs })
  }
  if (positionsTimer) {
    clearTimeout(positionsTimer)
    positionsTimer = null
    const known = new Set([LIBRARY_SETTINGS_TAB, ...libraryTabDefs().map((d) => d.id)])
    const next = savablePositions(useUiStore.getState().libraryFocus, known)
    writeUi({ libraryPositions: next })
  }
  if (scrollTimer) {
    clearTimeout(scrollTimer)
    scrollTimer = null
    saveScroll()
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', flushLibraryTabs)
  window.addEventListener('pagehide', flushLibraryTabs)
}

// ---- start -----------------------------------------------------------------------------------------------------

let restored = false

/**
 * Once settings and the library are loaded: make the tabs on the first run (from the platform tabs earlier versions
 * showed, `legacyTabs`), then show the tab of the last session with each tab's saved position. Runs once a session.
 */
export function restoreLibraryTabs(
  legacyTabs: readonly LibraryTab[],
  { save = true }: { save?: boolean } = {}
): void {
  if (restored) return
  const settings = useSettingsStore.getState().settings
  if (!settings) return
  restored = true
  persist = save
  let defs = settings.ui.libraryTabs
  if (!defs || defs.length === 0) {
    defs = migrateTabs(legacyTabs)
    saveTabs(defs)
  } else {
    // Tabs saved on the removed Playable First sort, or before the playable-first button (lib/libraryTabs.ts).
    const saved = defs
    const migrated = saved.map(migrateTabDef)
    if (migrated.some((d, i) => d !== saved[i])) {
      defs = migrated
      saveTabs(defs)
    }
  }
  useUiStore.setState((s) => ({
    libraryFocus: { ...settings.ui.libraryPositions, ...s.libraryFocus },
    libraryScroll: { ...(settings.ui.libraryScroll ?? {}), ...s.libraryScroll }
  }))
  const saved = settings.ui.libraryTab
  const start =
    saved === LIBRARY_SETTINGS_TAB || defs.some((d) => d.id === saved) ? saved : defs[0]!.id
  activateTab(start)
}

/** Tests: forget that the tabs were restored. */
export function resetLibraryTabsForTests(): void {
  restored = false
  persist = true
  if (tabsTimer) clearTimeout(tabsTimer)
  if (positionsTimer) clearTimeout(positionsTimer)
  if (scrollTimer) clearTimeout(scrollTimer)
  tabsTimer = positionsTimer = scrollTimer = null
  pendingTabs = null
  seenTabs = null
}

/**
 * A game page's store chip (_Owned on <Store>_): the Library on a tab with just that filter, the card of `gameId` focused.
 * A tab with exactly those filters is reused (its sort kept); otherwise one is added, so no tab of the user's has its
 * filters overwritten.
 */
export function showChoiceInLibrary(choice: Partial<LibraryTabFilters>, gameId: string): void {
  if (!restored) return
  const filters = tabFiltersOf(choice)
  const defs = libraryTabDefs()
  const existing = defs.find((d) => sameTabFilters(d.filters, filters))
  // The search is cleared on that tab, so the game is sure to show.
  if (!existing && defs.length >= MAX_LIBRARY_TABS_UI) {
    useUiStore
      .getState()
      .toast(t('state.libraryTabs.tooMany', { count: MAX_LIBRARY_TABS_UI }), 'info')
    return
  }
  const def: LibraryTabDef = existing ? { ...existing } : newTabDef({ filters })
  delete def.query
  saveTabs(existing ? defs.map((d) => (d.id === def.id ? def : d)) : [...defs, def])
  useUiStore.getState().showInLibrary(viewOf(def), gameId, def.id)
  // The tab opens on that game: its saved scroll goes from settings too, not only from the view.
  rememberScroll(def.id, null)
  saveActive(def.id)
}

/**
 * The filters of the Library's current tab: the view's while a tab of the user's is shown (it is ahead of the saved
 * tab during the save's pause), else (the Settings tab) the first tab's, which a game page's buttons change then.
 */
export function currentTabFilters(
  view: LibraryTabFilters & { tab: string },
  defs: readonly LibraryTabDef[]
): LibraryTabFilters | null {
  if (defs.some((d) => d.id === view.tab)) return view
  return defs[0]?.filters ?? null
}

/**
 * A game page's developer or publisher button, or a genre / tag chip: the choice is added to the Library's current
 * tab (the first tab when the Settings tab is shown), with every other filter of the tab kept, so the filters
 * combine; pressed again while the tab has it, only that choice goes. Saved with the tab. Either way the Library opens
 * on that tab with the game's card focused, when `shows` (state/libraryShown.ts libraryShowsGame: the Library's own
 * filtering) says the tab now shows it; when it does not (a hidden game with Show hidden off, a PC game's developer on
 * a PS2 tab), no card is asked for and the Library keeps its own focus. Without `shows` the card is taken as shown.
 */
export function toggleTabChoice(
  choice: TabChoice,
  gameId: string,
  shows?: (view: LibraryFilters) => boolean
): void {
  if (!restored) return
  if (choice.kind === 'genre' ? !choice.id : !choice.name.trim()) return
  const defs = libraryTabDefs()
  const shown = useUiStore.getState().library.tab
  const def = defs.find((d) => d.id === shown) ?? defs[0]
  if (!def) return
  if (shown !== def.id) activateTab(def.id)
  updateActiveTab(toggledChoice(useUiStore.getState().library, choice))
  // The tab is opened as it now stands (its filters, sort and search), on this game when it shows there.
  const view = useUiStore.getState().library
  const onTab = !shows || shows(view)
  useUiStore.getState().showInLibrary(view, onTab ? gameId : null, def.id)
  if (onTab) rememberScroll(def.id, null)
}
