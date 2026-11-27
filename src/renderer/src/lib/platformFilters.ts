import type { Game, Platform } from '@shared/types'
import { t, useLanguageStore } from '../i18n'
import { gameFamily, type PlatformKindOf } from './storeFilters'

/** One choice of Filters > Platform: an emulated system (stores and other PC games are its choices below the line). */
export interface PlatformFilter {
  id: string
  label: string
}

/**
 * Filters > Platform's choices: the emulated systems that have games in `games`, in the platforms' own order, each
 * labelled as its tab was ("SNES"). Stores and plain PC games are below the line (storeFilters.ts).
 */
export function libraryPlatformFilters(
  games: readonly Game[],
  platforms: readonly Platform[],
  label: (id: string) => string
): PlatformFilter[] {
  const present = new Set(games.map((g) => g.platformId))
  return platforms
    .filter((p) => p.kind === 'system' && present.has(p.id))
    .map((p) => ({ id: p.id, label: label(p.id) }))
}

/**
 * Filters > Platform's "All Platforms": every emulation game (ROMs, whatever their system), that is every game that
 * is neither a store's nor another PC game. Kept in the tab's `platforms` like a platform id; the "*" keeps it apart
 * from every real platform id.
 */
export const ALL_ROM_PLATFORMS = '*roms'

/**
 * The label of a Filters > Platform choice ("All Platforms" for ALL_ROM_PLATFORMS). In the language shown: reassigned
 * when it changes, and an ES module's importers read the new value.
 */
export let ALL_ROM_PLATFORMS_LABEL = t('lib.platforms.all')
useLanguageStore.subscribe(() => {
  ALL_ROM_PLATFORMS_LABEL = t('lib.platforms.all')
})

/**
 * Whether a game passes Filters > Platform: any game when nothing is picked, an emulation game for "All Platforms",
 * else a game on one of the picked platforms.
 */
export function matchesPlatformFilter(
  game: Pick<Game, 'source' | 'platformId'>,
  picked: ReadonlySet<string>,
  kindOf: PlatformKindOf
): boolean {
  if (picked.size === 0) return true
  if (picked.has(ALL_ROM_PLATFORMS) && gameFamily(game, kindOf) === 'emulation') return true
  return picked.has(game.platformId)
}

/**
 * Filters > Platform after pressing `value`: "All Platforms" is on alone (pressed again: off), and a platform pressed
 * while it is on replaces it; otherwise a platform toggles as every choice does.
 */
export function pickPlatform(picked: readonly string[], value: string): string[] {
  if (value === ALL_ROM_PLATFORMS) return picked.includes(value) ? [] : [value]
  const platforms = picked.filter((id) => id !== ALL_ROM_PLATFORMS)
  return platforms.includes(value) ? platforms.filter((id) => id !== value) : [...platforms, value]
}
