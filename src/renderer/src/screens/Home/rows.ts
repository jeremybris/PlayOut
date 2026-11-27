/**
 * Focus-tree ids of the Home screen. The Recent row is a Norigin container ('row:<id>', see
 * lib/focusKeys.ts); the quick actions and the system bar are containers of their own so they remember
 * their last focused item; all of them sit inside the Home boundary container.
 */

/** Focus key of the Home boundary container (everything on Home except the backdrop). */
export const HOME_KEY = 'home'

/** The Recent Games row (also the row that holds the Add Games tile). */
export const RECENT_ROW = 'recent'

/** Focus key of the quick-action container ([Settings] [Exit]). */
export const QUICK_KEY = 'quick'

/** Focus key of the system pill container (top right). */
export const SYSTEMBAR_KEY = 'systembar'

/** Settle time after the last focus change before the hero art, logo and meta line follow the focused card. */
export const HERO_FOLLOW_MS = 150
