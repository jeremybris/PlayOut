/**
 * Popups that can be opened without first moving focus to the control that owns them (LT / RT in the Library open
 * the Sort and Filters menus over the focused card, so closing a menu returns to that card). A control registers
 * an opener under its focus key while it is mounted; the menu it opens records the focus it was opened from.
 */

const openers = new Map<string, () => void>()

/** Register `open` for the control `focusKey`; returns the unregister function. */
export function registerPopupOpener(focusKey: string, open: () => void): () => void {
  openers.set(focusKey, open)
  return () => {
    if (openers.get(focusKey) === open) openers.delete(focusKey)
  }
}

/** Open the popup of the control `focusKey`; false when no such control is mounted. */
export function openPopup(focusKey: string): boolean {
  const open = openers.get(focusKey)
  if (!open) return false
  open()
  return true
}

const cardFocusers = new Map<string, (gameId: string) => boolean>()

/**
 * A card row that can bring a game's card into view and focus it even when the card is not mounted (the windowed
 * Library grid). Returns the unregister function.
 */
export function registerCardFocuser(rowId: string, focus: (gameId: string) => boolean): () => void {
  cardFocusers.set(rowId, focus)
  return () => {
    if (cardFocusers.get(rowId) === focus) cardFocusers.delete(rowId)
  }
}

/** Focus `gameId`'s card in row `rowId` through its registered focuser; false when the row cannot. */
export function focusCardInRow(rowId: string, gameId: string): boolean {
  return cardFocusers.get(rowId)?.(gameId) ?? false
}
