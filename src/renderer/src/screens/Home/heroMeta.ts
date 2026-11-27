import { gameGenres } from '@shared/genres'
import type { Game, Platform } from '@shared/types'
import { t as translate, type Translate } from '../../i18n'
import { formatPlaytime, releaseYear } from '../../lib/format'
import { platformName } from '../../lib/platforms'

/**
 * Parts of the hero meta line `Played 19.6 hours · RPG · 2026 · Steam`: play time (PlayOut sessions plus
 * the store's own count), first genre, release year and platform name; parts that are unknown are left out.
 * `t` is the component's useT(), so the line follows a language change; the default reads the language shown now.
 */
export function heroMetaParts(
  game: Game,
  platforms: Platform[],
  t: Translate = translate
): string[] {
  const parts: string[] = []
  const minutes = game.playtimeMinutes + (game.storePlaytimeMinutes ?? 0)
  if (minutes > 0) parts.push(t('home.played', { time: formatPlaytime(minutes) }))
  const genre = gameGenres(game).find((g) => g.trim().length > 0)
  if (genre) parts.push(genre.trim())
  const year = releaseYear(game.metadata)
  if (year) parts.push(String(year))
  const platform = platformName(game.platformId, platforms)
  if (platform) parts.push(platform)
  return parts
}
