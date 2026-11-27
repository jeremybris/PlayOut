import type { LaunchError, LibraryScrollPosition } from '@shared/types'
import { create } from 'zustand'
import { LIBRARY_ALL_TAB, type LibrarySort, LIBRARY_SETTINGS_TAB } from '../lib/libraryView'

/**
 * UI store: the modal stack, toasts, the game the hero follows and the active input method.
 * Modals are rendered by App's ModalHost in stack order; only the top one receives non-directional actions
 * (see input/actions.ts layers).
 */

export type Modal =
  | { type: 'detail'; gameId: string }
  | { type: 'addgames' }
  | { type: 'settings'; section?: string }
  | { type: 'search' }
  /** `focus`: 'downloads' opens on the install queue's list (the system bar's Downloads item); else the tiles. */
  | { type: 'quickpanel'; focus?: 'downloads' }
  | { type: 'launch-error'; gameId: string; error: LaunchError }
  /**
   * The game's Recompilation page (screens/Recomp): its native PC ports, which one to use, install / update / play.
   * `focus`: 'files' opens on the game files it still needs (the UP button's launch asked for them).
   */
  | { type: 'recomp'; gameId: string; focus?: 'files'; recompId?: string }
  /**
   * "Delete the original disc image?" (screens/Recomp/RecompImageDialog): a recompilation is ready and no longer
   * needs the game's disc image (state/recompImage.ts asks main's questions one at a time).
   */
  | { type: 'recomp-image'; offer: import('@shared/recomp').RecompImageOffer }
  /**
   * The disc image a Delete answer moved aside while the recompilation was started to check it runs without it has a
   * verdict (screens/Recomp/RecompHeldDialog): Restore, Delete anyway or Test again.
   */
  | { type: 'recomp-held'; item: import('@shared/recomp').RecompHeldImage }
  /** Every recompilation in the catalogs (Settings › Recompilations › Browse recompilations). */
  | { type: 'recomp-browser' }
  /** Every mod on the VR mod list (Settings › VR › Browse). */
  | { type: 'vr-browser' }
  /** PlayOut's first start found PlayOut hosts on the network: offer to pair with one (screens/FirstStart). */
  | { type: 'first-start-hosts'; hosts: import('@shared/types').DiscoveredHost[] }
  /**
   * Moving the Emulation folder (screens/Settings/EmulationMoveDialog): Settings › Library's Choose / Generate /
   * Default, Add games' ROM folder step, and at startup (`offer`) an Emulation folder inside PlayOut's install folder.
   */
  | {
      type: 'emulation-move'
      request: import('@shared/emulation-move').EmulationMoveRequest
      offer?: boolean
      onDone?: (dir: string) => void
    }
  /**
   * A Steam game's DLC (screens/SteamDlc): 'install' = pick the DLC before its install (Install starts it), 'manage'
   * = turn the installed game's DLC on or off (the Play menu's Manage DLC).
   */
  | { type: 'steam-dlc'; gameId: string; mode: 'install' | 'manage' }
  /**
   * One of the user's own filters (screens/CustomFilter): `gameId` = Create a filter from a game's options menu (the
   * game goes in it); `filterId` = rename it or change its icon from Filters > Custom (`focus` = where focus starts).
   */
  | {
      type: 'custom-filter'
      gameId?: string
      filterId?: string
      focus?: 'name' | 'icon'
    }
  | {
      type: 'confirm'
      title: string
      message: string
      confirmLabel?: string
      /** The button that closes it without doing anything (default "Cancel"). */
      cancelLabel?: string
      danger?: boolean
      /** A switch shown under the message; onConfirm gets its state. */
      option?: { label: string; description?: string; checked: boolean }
      onConfirm: (optionChecked: boolean) => void
    }

export type ModalType = Modal['type']

/** Section ids the Settings modal understands (`openModal({ type: 'settings', section })`). */
export const SETTINGS_SECTIONS = [
  'library',
  'emulators',
  'recompilations',
  'vr',
  'convert',
  'streaming',
  'metadata',
  'appearance',
  'input',
  'storage',
  'system',
  'about'
] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

/** A modal on the stack; `id` is unique per openModal call and is used as the React key. */
export type OpenModal = Modal & { id: number }

export type ToastKind = 'info' | 'success' | 'warning' | 'error'

export interface Toast {
  id: number
  text: string
  kind: ToastKind
  createdAt: number
  /** Auto-dismiss delay; ToastHost removes the toast after it. */
  durationMs: number
}

export type InputMethod = 'gamepad' | 'keyboard' | 'mouse' | 'touch'

/** The full-screen view under the modal stack: the Home dashboard or the Library grid below it. */
export type Screen = 'home' | 'library'

/**
 * The Library view: the shown tab and its filters and sort (copied from the tab, and saved back to it: state/
 * libraryTabs.ts), plus the search, which is the view's only.
 */
export interface LibraryFilters {
  tab: string
  query: string
  sort: LibrarySort
  /** The sort order turned around (its menu entry picked again): Z–A, oldest first, smallest first. */
  sortReversed: boolean
  /** The playable-first button (beside the search): playable games before the rest, each part in the sort's order. */
  playableFirst: boolean
  /** Filters > Platform: the platform ids picked (consoles and other systems); empty = every platform. */
  platforms: string[]
  /** Filters > Genre: the genres picked (a game with any of them shows); empty = every genre. */
  genres: string[]
  /** Filters > Tags: the TAG_FILTERS ids picked (lib/steamTags.ts; a game with any of them shows); empty = every game. */
  tags: string[]
  /** Filters > Platform, below the line: the stores picked (source ids, lib/storeFilters.ts; a card with a copy from any of them shows). */
  stores: string[]
  /** Filters > Release: the RELEASE_ERAS ids picked (lib/releaseEras.ts); empty = every year. */
  eras: string[]
  /** Filters > Size: the SIZE_BUCKETS ids picked (lib/installSize.ts); empty = every size. */
  sizes: string[]
  /** Filters > H.L.T.B.: the HLTB_BUCKETS ids picked (lib/hltb.ts); empty = every time. */
  hltb: string[]
  /** Filters > Difficulty: the levels picked (shared/difficulty.ts DIFFICULTY_IDS); empty = every level. */
  difficulty: string[]
  /** Filters > Reviews: the REVIEW_BANDS ids picked (lib/reviews.ts); empty = every game. */
  reviews: string[]
  /** Filters > Controls: the CONTROLS_FILTERS ids picked (lib/controls.ts); empty = any controls. */
  controls: string[]
  /** Filters > Local Multiplayer: 'local-all' and player counts (lib/localMultiplayer.ts); empty = any. */
  players: string[]
  /** Filters > Online Multiplayer: 'online-all', 'coop', 'pvp' (lib/onlineMultiplayer.ts); empty = any. */
  online: string[]
  /** Filters > Hidden: show the hidden games instead of the visible ones. */
  hidden: boolean
  /** Filters > Favorites: only favourite games. */
  favorites: boolean
  /** Filters > Nucleus Co-Op: only games with a Co-Op handler. */
  coop: boolean
  /** Filters > Recompilations: only games with a recompilation available. */
  recomp: boolean
  /** A game page's developer buttons: games by any of these developers (case-insensitive); empty = any. */
  developers: string[]
  /** A game page's publisher buttons: games by any of these publishers (case-insensitive); empty = any. */
  publishers: string[]
  /** Filters > Custom: the user's filters picked (settings.library.customFilters ids); empty = every game. */
  custom: string[]
}

export const DEFAULT_LIBRARY_FILTERS: LibraryFilters = {
  tab: LIBRARY_ALL_TAB,
  query: '',
  sort: 'title-asc',
  sortReversed: false,
  playableFirst: true,
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
}

export interface UiState {
  /** Which full-screen view is shown; the Library keeps its DOM through its exit animation (App). */
  screen: Screen
  setScreen(screen: Screen): void
  /** Focus key of the Home element that was focused when the Library opened; Home restores it on return. */
  homeFocusKey: string | null
  setHomeFocusKey(key: string | null): void
  library: LibraryFilters
  setLibraryFilters(patch: Partial<LibraryFilters>): void
  /**
   * Control last focused in each Library tab (tab id -> game id of the card, or the focus key of a store-accounts
   * control on the Settings tab), so switching back lands on the same one.
   */
  libraryFocus: Record<string, string>
  rememberLibraryFocus(tab: string, gameId: string): void
  /** Each Library tab's scroll (tab id -> top row's game and offset), so switching back opens scrolled the same. */
  libraryScroll: Record<string, LibraryScrollPosition>
  rememberLibraryScroll(tab: string, position: LibraryScrollPosition | null): void
  /**
   * Show the Library on tab `tabId` with `view` (its filters and sort: state/libraryTabs.ts showChoiceInLibrary and
   * toggleTabChoice, for a chip, developer or publisher pressed on a game's page): every modal closes, the search is
   * cleared unless `view` has one, and the grid opens on `gameId`'s card. With `gameId` null (the game's card is not
   * on that tab) no card is asked for: the Library keeps its own focus and the tab's scroll.
   */
  showInLibrary(view: Partial<LibraryFilters>, gameId: string | null, tabId: string): void
  /** The card the Library focuses once it is interactive (showInLibrary); `n` tells repeated requests apart. */
  libraryFocusRequest: { gameId: string; n: number } | null
  clearLibraryFocusRequest(): void
  modals: OpenModal[]
  /**
   * Push a modal; returns its id. Opening the same modal that is already on top is a no-op (returns its id). The
   * Settings modal is not opened while the Library shows its Settings tab, which is the same menu: the request goes
   * to the tab instead (`settingsTabRequest`) and 0 is returned.
   */
  openModal(modal: Modal): number
  /** A Settings request the Library's Settings tab shows (its section, then focus); `n` tells repeats apart. */
  settingsTabRequest: { section?: string; n: number } | null
  clearSettingsTabRequest(): void
  /** A host address for Settings › Streaming's pair form (the first-start prompt); `n` tells repeats apart. */
  pairingRequest: { address: string; n: number } | null
  requestPairing(address: string): void
  clearPairingRequest(): void
  /**
   * Settings modals mounted right now, the one playing its exit animation included (it left `modals` already):
   * the Library's Settings tab, which uses the same focus keys, mounts only while this is 0.
   */
  settingsModalsMounted: number
  noteSettingsModal(delta: 1 | -1): void
  /** Close the top modal, or the given one. */
  closeModal(id?: number): void
  closeAll(): void
  toasts: Toast[]
  /** Show a toast; returns its id. Default duration 4 s (6 s for errors). */
  toast(text: string, kind?: ToastKind, durationMs?: number): number
  dismissToast(id: number): void
  /** The game whose hero/meta the Home screen shows (last focused card). */
  focusedGameId: string | null
  setFocusedGame(id: string | null): void
  inputMethod: InputMethod
  setInputMethod(method: InputMethod): void
  /**
   * The options menu (Y) open over a cover: the game and the focus key of the card it was opened on, which the
   * menu is placed over and gives focus back to.
   */
  coverMenu: { gameId: string; focusKey: string } | null
  setCoverMenu(menu: { gameId: string; focusKey: string } | null): void
}

let nextId = 1

function applyInputMethodAttribute(method: InputMethod): void {
  if (typeof document !== 'undefined') document.documentElement.dataset.inputMethod = method
}

function sameModal(a: Modal, b: Modal): boolean {
  if (a.type !== b.type) return false
  switch (a.type) {
    case 'detail':
      return a.gameId === (b as Extract<Modal, { type: 'detail' }>).gameId
    case 'settings':
      return a.section === (b as Extract<Modal, { type: 'settings' }>).section
    case 'recomp':
      return a.gameId === (b as Extract<Modal, { type: 'recomp' }>).gameId
    case 'steam-dlc': {
      const other = b as Extract<Modal, { type: 'steam-dlc' }>
      return a.gameId === other.gameId && a.mode === other.mode
    }
    case 'recomp-image':
      return a.offer.key === (b as Extract<Modal, { type: 'recomp-image' }>).offer.key
    case 'recomp-held':
      return a.item.holdId === (b as Extract<Modal, { type: 'recomp-held' }>).item.holdId
    case 'launch-error':
    case 'confirm':
      return false
    default:
      return true
  }
}

export const useUiStore = create<UiState>()((set, get) => ({
  screen: 'home',
  setScreen(screen) {
    if (get().screen !== screen) set({ screen })
  },
  homeFocusKey: null,
  setHomeFocusKey(key) {
    if (get().homeFocusKey !== key) set({ homeFocusKey: key })
  },
  library: DEFAULT_LIBRARY_FILTERS,
  setLibraryFilters(patch) {
    set((s) => ({ library: { ...s.library, ...patch } }))
  },
  libraryFocus: {},
  rememberLibraryFocus(tab, gameId) {
    if (get().libraryFocus[tab] === gameId) return
    set((s) => ({ libraryFocus: { ...s.libraryFocus, [tab]: gameId } }))
  },
  libraryScroll: {},
  rememberLibraryScroll(tab, position) {
    const was = get().libraryScroll[tab]
    if (!position) {
      if (!was) return
      const { [tab]: _gone, ...rest } = get().libraryScroll
      void _gone
      set({ libraryScroll: rest })
      return
    }
    if (was && was.gameId === position.gameId && was.offset === position.offset) return
    set((s) => ({ libraryScroll: { ...s.libraryScroll, [tab]: position } }))
  },
  libraryFocusRequest: null,
  clearLibraryFocusRequest() {
    if (get().libraryFocusRequest) set({ libraryFocusRequest: null })
  },
  showInLibrary(view, gameId, tabId) {
    if (gameId === null) {
      set({
        library: { ...DEFAULT_LIBRARY_FILTERS, ...view, tab: tabId },
        modals: [],
        screen: 'library'
      })
      return
    }
    set((s) => ({
      library: { ...DEFAULT_LIBRARY_FILTERS, ...view, tab: tabId },
      libraryFocus: { ...s.libraryFocus, [tabId]: gameId },
      // The tab opens on that game, not scrolled where it was left.
      libraryScroll: Object.fromEntries(
        Object.entries(s.libraryScroll).filter(([id]) => id !== tabId)
      ),
      libraryFocusRequest: { gameId, n: nextId++ },
      // Home, on return, lands on this game's card (focusedGameId) rather than on a card from an earlier visit.
      homeFocusKey: s.screen === 'home' ? null : s.homeFocusKey,
      modals: [],
      screen: 'library'
    }))
  },

  modals: [],
  openModal(modal) {
    const state = get()
    if (
      modal.type === 'settings' &&
      state.screen === 'library' &&
      state.library.tab === LIBRARY_SETTINGS_TAB
    ) {
      set({ settingsTabRequest: { section: modal.section, n: nextId++ } })
      return 0
    }
    const top = get().modals.at(-1)
    if (top && sameModal(top, modal)) return top.id
    const id = nextId++
    set((s) => ({ modals: [...s.modals, { ...modal, id }] }))
    return id
  },
  settingsModalsMounted: 0,
  noteSettingsModal(delta) {
    set((s) => ({ settingsModalsMounted: Math.max(0, s.settingsModalsMounted + delta) }))
  },
  settingsTabRequest: null,
  clearSettingsTabRequest() {
    if (get().settingsTabRequest) set({ settingsTabRequest: null })
  },
  pairingRequest: null,
  requestPairing(address) {
    set({ pairingRequest: { address, n: nextId++ } })
  },
  clearPairingRequest() {
    if (get().pairingRequest) set({ pairingRequest: null })
  },
  closeModal(id) {
    set((s) => {
      if (s.modals.length === 0) return s
      if (id === undefined) return { modals: s.modals.slice(0, -1) }
      return { modals: s.modals.filter((m) => m.id !== id) }
    })
  },
  closeAll() {
    set({ modals: [] })
  },

  toasts: [],
  toast(text, kind = 'info', durationMs) {
    const id = nextId++
    const toast: Toast = {
      id,
      text,
      kind,
      createdAt: Date.now(),
      durationMs: durationMs ?? (kind === 'error' ? 6000 : 4000)
    }
    set((s) => ({ toasts: [...s.toasts.slice(-4), toast] }))
    return id
  },
  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },

  coverMenu: null,
  setCoverMenu(menu) {
    set({ coverMenu: menu })
  },

  focusedGameId: null,
  setFocusedGame(id) {
    if (get().focusedGameId !== id) set({ focusedGameId: id })
  },

  inputMethod: 'gamepad',
  setInputMethod(method) {
    if (get().inputMethod === method) return
    applyInputMethodAttribute(method)
    set({ inputMethod: method })
  }
}))

applyInputMethodAttribute(useUiStore.getState().inputMethod)

/** The modal currently on top of the stack, if any. */
export function topModal(): OpenModal | undefined {
  return useUiStore.getState().modals.at(-1)
}

/** React hook: true when at least one modal is open. */
export function useModalOpen(): boolean {
  return useUiStore((s) => s.modals.length > 0)
}

/** React hook: the full-screen view currently shown. */
export function useScreen(): Screen {
  return useUiStore((s) => s.screen)
}
