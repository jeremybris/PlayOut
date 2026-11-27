import type { Game, GameUserPatch } from '@shared/types'
import { useMemo } from 'react'
import { api } from '../api/client'
import { t } from '../i18n'
import { doesFocusableExist, getCurrentFocusKey, setFocus } from '../input/focus'
import { copiesOf } from '../lib/copies'
import { parseCardFocusKey } from '../lib/focusKeys'
import { focusCardInRow } from '../lib/popupOpeners'
import { displayTitle, hiddenGames, visibleGames } from '../lib/library'
import { createLog } from '../lib/log'
import { findGame } from '../lib/streaming'
import { useLibraryStore } from './library'
import { currentSettings } from './settings'
import { useStreamingStore } from './streaming'
import { useUiStore } from './ui'

const log = createLog('favorite')

/** The Library's card row and view (screens/Library/keys.ts), kept here to stay free of screen imports. */
const LIBRARY_ROW = 'library'
const LIBRARY_KEY = 'library'

/**
 * Per-game actions of the Library, Home and the cover menu. A game owned several times is one card (lib/copies.ts):
 * completed is written to every copy (the card reads "any copy", and a later change of the shown copy must not make
 * it disappear). A favourite is the one copy the user picked: it leaves its group and always has its own card.
 */

/**
 * Every copy of a game, grouped the way the screens group their cards: among the visible games (or among the
 * hidden ones, for a game Filters > Hidden shows), so a hidden copy never joins a visible card's group.
 */
export function copiesFor(gameId: string): Game[] {
  const { games } = useLibraryStore.getState()
  const settings = currentSettings()
  const visible = visibleGames(games, settings)
  const pool = visible.some((g) => g.id === gameId) ? visible : hiddenGames(games, settings)
  return copiesOf(pool, gameId, { showDuplicates: settings?.library.showDuplicates ?? false })
}

/** A paired host's game (`remote:` id) as the remote library shows it, or undefined. */
function remoteGame(gameId: string): Game | undefined {
  if (!gameId.startsWith('remote:')) return undefined
  return useStreamingStore.getState().remote?.games.find((g) => g.id === gameId)
}

/**
 * Whether a game can be made a favourite here: any game of this PC; a paired host's game only while the favourites
 * sync is on (Settings › Streaming), as its favourite is the host's.
 */
export function canFavorite(game: Pick<Game, 'remote'>, settings = currentSettings()): boolean {
  return !game.remote || settings.streaming.syncFavorites
}

/**
 * Whether a game is a favourite: any of its copies is (the rule its card and the X toggle follow). A paired host's
 * game: its host's favourite (the favourites sync).
 */
export function isFavorite(gameId: string): boolean {
  const remote = remoteGame(gameId)
  if (remote) return remote.favorite
  return copiesFor(gameId).some((c) => c.favorite)
}

/**
 * Apply one patch to every copy of a game. Copies that were saved are applied locally even when another failed,
 * so the screen matches what is on disk; rejects with the first error after that.
 */
async function updateCopies(
  gameId: string,
  patch: (copy: Game) => GameUserPatch | null
): Promise<void> {
  const results = await Promise.allSettled(
    copiesFor(gameId).map((copy) => {
      const change = patch(copy)
      return change ? api.updateGame(copy.id, change) : Promise.resolve(copy)
    })
  )
  const saved = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
  if (saved.length) useLibraryStore.getState().applyGames(saved)
  const failure = results.find((r) => r.status === 'rejected')
  if (failure) throw (failure as PromiseRejectedResult).reason
}

function failed(err: unknown): void {
  log.error('updateGame failed', err)
  useUiStore.getState().toast(t('state.favorite.updateFailed'), 'error')
}

/**
 * Toggle a game's favourite flag on the copy the card shows (a favourite always has its own card, lib/copies.ts:
 * favouriting a grouped card takes that copy out of the group, un-favouriting puts it back), apply the result
 * locally and confirm with a toast.
 */
export function toggleFavorite(gameId: string): void {
  const remote = remoteGame(gameId)
  if (remote) {
    toggleRemoteFavorite(remote)
    return
  }
  const game = useLibraryStore.getState().byId.get(gameId)
  if (!game) return
  const favorite = !game.favorite
  api
    .updateGame(game.id, { favorite })
    .then((saved) => useLibraryStore.getState().applyGames([saved]))
    .then(() =>
      useUiStore
        .getState()
        .toast(
          favorite
            ? t('state.favorite.added', { title: displayTitle(game) })
            : t('state.favorite.removed', { title: displayTitle(game) }),
          'success'
        )
    )
    .catch(failed)
}

/**
 * A paired host's game: made a favourite or not on its host (the favourites sync); the remote library brings the
 * change back. Nothing while the sync is off here.
 */
function toggleRemoteFavorite(game: Game): void {
  if (!canFavorite(game)) return
  const favorite = !game.favorite
  api
    .setRemoteFavorite(game.id, favorite)
    .then(() =>
      useUiStore
        .getState()
        .toast(
          favorite
            ? t('state.favorite.added', { title: displayTitle(game) })
            : t('state.favorite.removed', { title: displayTitle(game) }),
          'success'
        )
    )
    .catch((err) => {
      log.error('setRemoteFavorite failed', err)
      useUiStore
        .getState()
        .toast(
          err instanceof Error && err.message ? err.message : t('state.favorite.updateFailed'),
          'error'
        )
    })
}

/** Mark a game completed or not (on every copy). */
export function toggleCompleted(gameId: string): void {
  const game = useLibraryStore.getState().byId.get(gameId)
  if (!game) return
  const completed = !copiesFor(gameId).some((c) => c.completed)
  updateCopies(gameId, (copy) => (Boolean(copy.completed) === completed ? null : { completed }))
    .then(() =>
      useUiStore
        .getState()
        .toast(
          completed
            ? t('state.favorite.completed', { title: displayTitle(game) })
            : t('state.favorite.notCompleted', { title: displayTitle(game) }),
          'success'
        )
    )
    .catch(failed)
}

/**
 * Show `chosenId`'s copy for its game: set its preferred flag and clear the others'. Resolves to whether every
 * copy was saved, once the library holds the change, so the caller can focus the card that now stands for it.
 */
export function setPreferredCopy(chosenId: string): Promise<boolean> {
  return updateCopies(chosenId, (copy) => {
    const preferred = copy.id === chosenId
    if (Boolean(copy.user.preferredCopy) === preferred) return null
    return { user: { preferredCopy: preferred ? true : null } }
  })
    .then(() => true)
    .catch((err) => {
      failed(err)
      return false
    })
}

/** Reveal a game's files in Explorer: the installed copy's executable or ROM, else its install folder. */
export function showInFolder(game: Game): void {
  const target = game.exePath ?? game.romPath
  const call = target
    ? api.showItemInFolder(target)
    : game.installDir
      ? api.openPath(game.installDir)
      : Promise.reject(new Error('no install location'))
  call.catch((err) => {
    log.error('show in folder failed', err)
    useUiStore.getState().toast(t('state.favorite.folderFailed'), 'error')
  })
}

/** X on Home / in the Library: toggle the focused card's game; false (declined) when no card is focused. */
export function toggleFocusedFavorite(): boolean {
  const card = parseCardFocusKey(getCurrentFocusKey())
  if (!card) return false
  const remote = remoteGame(card.gameId)
  if (remote ? !canFavorite(remote) : !useLibraryStore.getState().byId.has(card.gameId))
    return false
  toggleFavorite(card.gameId)
  return true
}

/** Y on Home / in the Library: open the options menu over the focused cover; false when no card is focused. */
export function openFocusedCoverMenu(): boolean {
  const focusKey = getCurrentFocusKey()
  const card = parseCardFocusKey(focusKey)
  // Host-only games (Streaming) have a menu too: Stream, Download and Details.
  const known =
    card &&
    findGame(card.gameId, useLibraryStore.getState().byId, useStreamingStore.getState().remote)
  if (!card || !focusKey || !known) return false
  useUiStore.getState().setCoverMenu({ gameId: card.gameId, focusKey })
  return true
}

/**
 * Focus the first of `keys` that can take it: a mounted control, or a Library card the grid can bring into view
 * (it scrolls to an unmounted one, and resolves a copy it does not show to the copy that stands for the game).
 * Nothing found: the Library view itself (its remembered card); on Home, Home's own focus effect recovers. A
 * key that exists nowhere is never focused, so the D-pad cannot go dead.
 */
export function focusFirst(keys: readonly (string | null | undefined)[]): void {
  for (const key of keys) {
    if (!key) continue
    if (doesFocusableExist(key)) {
      void setFocus(key)
      return
    }
    const card = parseCardFocusKey(key)
    if (card?.rowId === LIBRARY_ROW && focusCardInRow(LIBRARY_ROW, card.gameId)) return
  }
  if (useUiStore.getState().screen === 'library' && doesFocusableExist(LIBRARY_KEY)) {
    void setFocus(LIBRARY_KEY)
  }
}

/**
 * Close the cover menu and give focus to `focusKey` (the card that now stands for the game) or to the card the
 * menu was opened on (focusFirst). Two ticks later: the menu's focus layer restores its own target one tick after
 * the commit that unmounts it, and this must come after that.
 */
export function closeCoverMenu(focusKey?: string): void {
  const ui = useUiStore.getState()
  const opened = ui.coverMenu?.focusKey
  ui.setCoverMenu(null)
  setTimeout(() => setTimeout(() => focusFirst([focusKey, opened]), 0), 0)
}

/** isFavorite as a hook: follows library changes (the detail panel's star and X hint). */
export function useIsFavorite(gameId: string | undefined): boolean {
  const games = useLibraryStore((s) => s.games)
  const remote = useStreamingStore((s) => s.remote)
  return useMemo(
    () => (gameId ? isFavorite(gameId) : false),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- games, remote: recompute when either library changes
    [gameId, games, remote]
  )
}
