/**
 * Focus-tree ids of the Library view (screens/Library). The view is a Norigin focus boundary; the tab
 * strip, the header controls and the grid are containers inside it that remember their last focused child.
 * Kept out of the component files so React fast-refresh keeps working.
 */

/** Focus key of the Library boundary container. */
export const LIBRARY_KEY = 'library'

/** Row id of the grid's GameCards: their focus keys are cardFocusKey(LIBRARY_ROW, gameId). */
export const LIBRARY_ROW = 'library'

export const TABS_KEY = 'library:tabs'
export const HEADER_KEY = 'library:header'
export const SEARCH_KEY = 'library:search'
/** The playable-first button between the search and the Sort pill. */
export const PLAYABLE_KEY = 'library:playable'
/** The header's folder button (a tab with Platform / PC filters). */
export const FOLDERS_KEY = 'library:folders'
export const SORT_KEY = 'library:sort'
export const CATEGORY_KEY = 'library:category'
export const GRID_KEY = 'library:grid'
/** The cover-size slider left of the grid (CoverSizeSlider.tsx): its track, and its − / + buttons. */
export const COVER_SIZE_KEY = 'library:cover-size'
export const COVER_SMALLER_KEY = 'library:cover-size:smaller'
export const COVER_LARGER_KEY = 'library:cover-size:larger'
export const IMPORT_KEY = 'library:import'
/** The X right of the Filters pill (deletes the tab shown). */
export const DELETE_TAB_KEY = 'library:delete-tab'
/** The "+" at the end of the tab strip (adds a tab). */
export const ADD_TAB_KEY = 'library:add-tab'
/** The Settings tab's Settings menu (SettingsTab.tsx). */
export const SETTINGS_TAB_KEY = 'library:settings'

/** Focus key of one tab. */
export function tabFocusKey(tabId: string): string {
  return `library:tab:${tabId}`
}

/** Most columns the grid uses at today's cover size (six 240u cards fit a 1920u canvas); more for smaller covers. */
export const MAX_COLUMNS = 6

/** Grid rows rendered beyond each edge of the visible range (and around the focused row). */
export const ROW_OVERSCAN = 1

/** Grid rows mounted before the scroll viewport could be measured (first paint). */
export const INITIAL_ROWS = 4
