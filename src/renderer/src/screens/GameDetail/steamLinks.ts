// The Steam links grid right of the feature grid (SteamLinksGrid.tsx): which squares a game has, their focus keys
// and order. Kept apart from the component so fast refresh keeps working on it.
import type { Game } from '@shared/types'
import {
  STEAM_LINK_KINDS,
  steamLinksAppId,
  steamWorkshopShown,
  type SteamLinkKind
} from '@shared/web-viewer'

/** Focus keys of the grid and its four squares. */
export const STEAM_LINK_FOCUS = {
  links: 'detail:steam-links',
  store: 'detail:steam-link:store',
  workshop: 'detail:steam-link:workshop',
  pcgamingwiki: 'detail:steam-link:pcgamingwiki',
  guides: 'detail:steam-link:guides'
} as const satisfies Record<'links' | SteamLinkKind, string>

/** A Steam game's links: its app id and the squares it shows, in grid order (null: none, no grid). */
export interface SteamLinks {
  appId: number
  kinds: readonly SteamLinkKind[]
}

/**
 * The links a game shows: Steam games with a Steam app id only (a paired host's too). Workshop shows only when Steam
 * said the app has one (not known yet or none: left out); the other three always show.
 */
export function steamLinksOf(
  game: Pick<Game, 'source' | 'externalId' | 'extra' | 'metadata'>
): SteamLinks | null {
  const appId = steamLinksAppId(game)
  if (appId === null) return null
  const workshop = steamWorkshopShown(game)
  return { appId, kinds: STEAM_LINK_KINDS.filter((kind) => kind !== 'workshop' || workshop) }
}

/** The squares a game shows ('store|workshop|...'), for the action bar's fit check; '' without the grid. */
export function presentSteamLinks(
  game: Pick<Game, 'source' | 'externalId' | 'extra' | 'metadata'>
): string {
  return steamLinksOf(game)?.kinds.join('|') ?? ''
}

/** Scroll steps of the viewer's page: D-pad up / down (repeats while held) and a right-stick flick (a screenful). */
export const WEB_VIEWER_LINE_STEP = 160
export const WEB_VIEWER_PAGE_SHARE = 0.8
