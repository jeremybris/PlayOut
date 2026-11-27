/**
 * Focus key conventions shared by components and screens (kept out of the component files so React
 * fast-refresh keeps working). Modals prefix their children with their own focus key ('settings:...').
 */

/** Focus key of a GameCard: 'card:<rowId>:<gameId>'. Screens use it to restore focus to a specific card. */
export function cardFocusKey(rowId: string, gameId: string): string {
  return `card:${rowId}:${gameId}`
}

/** Focus key of the AddGamesTile in a row. */
export function addGamesTileFocusKey(rowId: string): string {
  return cardFocusKey(rowId, 'add-games')
}

/** Focus key of a Row container: 'row:<id>'. setFocus(rowFocusKey(id)) lands on the row's remembered card. */
export function rowFocusKey(id: string): string {
  return `row:${id}`
}

/** Parse a card focus key back into its row id and game id, or null for any other key. */
export function parseCardFocusKey(
  key: string | null | undefined
): { rowId: string; gameId: string } | null {
  if (!key || !key.startsWith('card:')) return null
  const rest = key.slice('card:'.length)
  // Row ids may contain one colon ('platform:steam'); game ids contain colons too ('steam:620',
  // 'rom:snes:hash'), so the split point is the first colon after an optional 'platform:' prefix.
  const rowEnd = rest.startsWith('platform:')
    ? rest.indexOf(':', 'platform:'.length)
    : rest.indexOf(':')
  if (rowEnd <= 0) return null
  return { rowId: rest.slice(0, rowEnd), gameId: rest.slice(rowEnd + 1) }
}

/** A DownloadQueueList row's focus key: its title (`info`, no action) or one of its buttons. */
export function downloadQueueRowKey(
  listKey: string,
  gameId: string,
  part: 'info' | 'pause' | 'up' | 'down' | 'remove'
): string {
  return `${listKey}:${gameId}:${part}`
}

/** A DownloadQueueList's "Pause all" / "Resume all" button above its rows. */
export function downloadQueueAllKey(listKey: string): string {
  return `${listKey}:pause-all`
}

/**
 * An empty DownloadQueueList's "No downloads" line: a focus stop of its own, so focus that entered the list (the
 * overlay's Downloads tab opened on an empty queue, or the last row went while focused) rests somewhere visible.
 */
export function downloadQueueEmptyKey(listKey: string): string {
  return `${listKey}:empty`
}

/**
 * Where focus may safely land in a DownloadQueueList keyed `listKey`: the first row's title (focusable, it does
 * nothing on A), so a press right after opening never stops or reorders a download. Undefined while it is empty.
 */
export function downloadQueueSafeFocusKey(
  listKey: string,
  entries: readonly { gameId: string }[]
): string | undefined {
  const first = entries[0]
  return first ? downloadQueueRowKey(listKey, first.gameId, 'info') : undefined
}
