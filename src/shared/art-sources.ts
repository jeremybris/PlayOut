// Which sign-in art sources are set up: the services that can find a cover for any game by its name or hash
// (SteamGridDB, ScreenScraper, IGDB, TheGamesDB). Without one of them a game the stores and the local caches
// have no art for gets no cover; the library card says so (GameCard) and Settings › Metadata's "Refresh
// missing" names them. The rules match each scraper's own `isConfigured` (src/main/scrapers/*.ts).
import type { ArtKind, Game, Settings } from './types'

/** The art sources that need the user's key or developer credentials, in Settings › Metadata order. */
export type ArtSignInSource = 'steamgriddb' | 'screenscraper' | 'igdb' | 'thegamesdb'

function filled(value: string | undefined): boolean {
  return (value?.trim().length ?? 0) > 0
}

/** The sign-in art sources whose credentials are filled in. */
export function configuredArtSources(scrapers: Settings['scrapers']): ArtSignInSource[] {
  const out: ArtSignInSource[] = []
  if (filled(scrapers.steamgriddb?.apiKey)) out.push('steamgriddb')
  if (filled(scrapers.screenscraper?.devId) && filled(scrapers.screenscraper?.devPassword))
    out.push('screenscraper')
  if (filled(scrapers.igdb?.clientId) && filled(scrapers.igdb?.clientSecret)) out.push('igdb')
  if (filled(scrapers.thegamesdb?.apiKey)) out.push('thegamesdb')
  return out
}

/** Whether any sign-in art source is set up (else a missing cover needs one: the card's notice). */
export function artSourcesConfigured(settings: Pick<Settings, 'scrapers'>): boolean {
  return configuredArtSources(settings.scrapers).length > 0
}

/** The art kinds "Refresh missing" fills (screenshots are extras, not missing art). */
export const MISSING_ART_KINDS = [
  'cover',
  'hero',
  'logo',
  'icon'
] as const satisfies readonly ArtKind[]
export type MissingArtKind = (typeof MISSING_ART_KINDS)[number]

/**
 * The art kinds the game has neither scraped art nor the user's own file for. A paired host's game (Streaming) has
 * its host's art: nothing is missing here.
 */
export function missingArtKinds(game: Pick<Game, 'media' | 'user' | 'remote'>): MissingArtKind[] {
  if (game.remote) return []
  return MISSING_ART_KINDS.filter((kind) => !game.media[kind] && !game.user.customMedia?.[kind])
}
