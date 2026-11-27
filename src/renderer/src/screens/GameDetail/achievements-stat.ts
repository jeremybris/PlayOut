import { knownWithoutRetroAchievements } from '@shared/ra-consoles'
import { RECOMP_ACHIEVEMENTS_SOURCE, recompAchievementsFor } from '@shared/recomp-play'
import { knownWithoutSteamAchievements } from '@shared/steam-achievements'
import { knownWithoutStoreAchievements, storeAchievementsSource } from '@shared/store-achievements'
import type { AchievementsInfo, AchievementsProvider, Game } from '@shared/types'

/** The sites each provider's link may open (a paired host's answer could carry any web address). */
const PROVIDER_HOSTS: Record<Exclude<AchievementsProvider, 'recomp'>, string[]> = {
  steam: ['steamcommunity.com', 'store.steampowered.com'],
  retroachievements: ['retroachievements.org'],
  gog: ['gog.com'],
  epic: ['store.epicgames.com']
}

/**
 * The list's "View on …" link: only an https page of its provider's own site (or a subdomain of it); else none, so a
 * paired host's answer cannot make the button open another site.
 */
export function providerLink(info: AchievementsInfo): string | undefined {
  const provider = info.provider ?? 'steam'
  if (provider === 'recomp' || !info.url) return undefined
  let url: URL
  try {
    url = new URL(info.url)
  } catch {
    return undefined
  }
  const host = url.hostname.toLowerCase()
  const allowed = (PROVIDER_HOSTS[provider] ?? []).some((h) => host === h || host.endsWith(`.${h}`))
  return url.protocol === 'https:' && allowed ? url.toString() : undefined
}

/**
 * A paired host's ROM file this PC matches with its own RetroAchievements account (main achievements-service.ts
 * isRemoteRom): a ROM it can download whose counts are not the host's recompilation's. A card without a file plays the
 * host's recompilation, so the host's counts stay on it.
 */
export function isHostRom(game: Game): boolean {
  return (
    !!game.remote &&
    game.source === 'rom' &&
    game.remote.downloadable &&
    !game.metadata.sources?.[RECOMP_ACHIEVEMENTS_SOURCE]
  )
}

/**
 * The game page's ACHIEVEMENTS stat: whether it shows, and whether it is RetroAchievements' (a ROM's) or the game's own
 * ('achievements': a store game's, or the recompilation's Play starts when PlayOut reads its achievements). A paired
 * host's game shows it when the host's offer carries counts; a host's ROM file also like this PC's own ROMs (this PC's
 * RetroAchievements account reads it). A ROM (a recompilation's game too) known to have no RetroAchievements leaves it
 * out, unless its recompilation has achievements. A Steam game Steam says has no achievements, and a GOG or Epic game its
 * store says has none, leave it out too (signed out or a failed read keep it, with its sign-in hint).
 */
export function achievementsStat(game: Game): { show: boolean; label: 'retro' | 'achievements' } {
  const remote = !!game.remote
  const recomp = !remote && recompAchievementsFor(game) !== null
  const isRom = game.source === 'rom'
  const show =
    recomp ||
    game.metadata.achievements !== undefined ||
    (isHostRom(game) && !knownWithoutRetroAchievements(game)) ||
    (!remote &&
      ((game.source === 'steam' && !knownWithoutSteamAchievements(game)) ||
        (storeAchievementsSource(game) !== null && !knownWithoutStoreAchievements(game)) ||
        (isRom && !knownWithoutRetroAchievements(game))))
  // A paired host's counts that came from its recompilation are the game's own too. On this PC only the recompilation
  // Play starts counts: counts left from one no longer installed are cleared by main (achievements-service.ts).
  const own = recomp || (remote && !!game.metadata.sources?.[RECOMP_ACHIEVEMENTS_SOURCE])
  return { show, label: isRom && !own ? 'retro' : 'achievements' }
}
