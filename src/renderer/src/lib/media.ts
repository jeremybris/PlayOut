import type { Game } from '@shared/types'

/**
 * Media URL helpers. Game.media already contains opaque image URLs (media:// in Electron, https:// in the
 * mock); custom user art is applied by the main process, so the renderer never looks at user.customMedia.
 */

/** Portrait 2:3 cover, or undefined when none is cached. */
export function coverUrl(game: Game): string | undefined {
  return nonEmpty(game.media.cover)
}

/** Wide hero art; falls back to the first screenshot, then to the cover. */
export function heroUrl(game: Game): string | undefined {
  return nonEmpty(game.media.hero) ?? screenshotUrls(game)[0] ?? coverUrl(game)
}

/** Transparent logo, or undefined (callers render the title text instead). */
export function logoUrl(game: Game): string | undefined {
  return nonEmpty(game.media.logo)
}

/** Small square icon, falling back to the cover. */
export function iconUrl(game: Game): string | undefined {
  return nonEmpty(game.media.icon) ?? coverUrl(game)
}

/** Screenshot URLs (never undefined entries). */
export function screenshotUrls(game: Game): string[] {
  return (game.media.screenshots ?? []).filter(
    (url): url is string => typeof url === 'string' && url.length > 0
  )
}

/** True when the hero should be drawn from a blurred cover because no wide art exists. */
export function heroIsCoverFallback(game: Game): boolean {
  return !nonEmpty(game.media.hero) && screenshotUrls(game).length === 0
}

function nonEmpty(url: string | undefined): string | undefined {
  return url && url.length > 0 ? url : undefined
}
