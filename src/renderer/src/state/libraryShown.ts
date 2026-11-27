import { tabShowsGame } from '../lib/libraryFilter'
import { useLibraryStore } from './library'
import { lanPartyIdsNow } from './peerparty'
import { currentSettings } from './settings'
import { useStreamingStore } from './streaming'
import type { LibraryFilters } from './ui'

/**
 * Whether the Library, on a tab with the filters of `view`, shows the card of game `gameId`: the grid's own filtering
 * (lib/libraryFilter.ts tabShowsGame) over this PC's games, the paired hosts' and the Library settings (Show hidden /
 * uninstalled games, host games, duplicates). A game page's developer, publisher and genre / tag buttons ask it
 * before they focus the game's card (state/libraryTabs.ts toggleTabChoice).
 */
export function libraryShowsGame(gameId: string, view: LibraryFilters): boolean {
  const { games, platformsById } = useLibraryStore.getState()
  const settings = currentSettings()
  return tabShowsGame(
    gameId,
    {
      games,
      remote: useStreamingStore.getState().remote,
      platformsById,
      showUninstalled: settings.library.showUninstalled ?? true,
      showHidden: settings.library.showHidden ?? false,
      showHostGames: settings.streaming.showHostGames ?? true,
      showDuplicates: settings.library.showDuplicates ?? false
    },
    { ...view, lanParty: lanPartyIdsNow(view.players) }
  )
}
