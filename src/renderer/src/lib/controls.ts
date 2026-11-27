import type { Game } from '@shared/types'
import { t } from '../i18n'

/**
 * How a game is played, for the controls badge on its page (left of the players badge): Steam's controller and VR
 * support (GameMetadata.steamTags.controls, read with the Steam tags); a console game (a ROM) plays with a
 * controller; anything else, keyboard and mouse.
 */
export type ControlsKind = 'controller' | 'partial' | 'vr-only' | 'vr' | 'keyboard'

export interface Controls {
  kind: ControlsKind
  /** The word on the badge. */
  label: string
  /** Its full description (tooltip and screen readers). */
  text: string
}

/** Filters > Controls: its choices, in the menu's order (labels read in the language shown). */
export const CONTROLS_FILTERS = [
  {
    id: 'vr',
    get label(): string {
      return t('lib.controls.filters.vr')
    }
  },
  {
    id: 'controller',
    get label(): string {
      return t('lib.controls.filters.controller')
    }
  },
  {
    id: 'keyboard',
    get label(): string {
      return t('lib.controls.filters.keyboard')
    }
  },
  {
    id: 'touch',
    get label(): string {
      return t('lib.controls.filters.touch')
    }
  }
] as const

export function controlsFilterLabel(id: string): string {
  return CONTROLS_FILTERS.find((c) => c.id === id)?.label ?? id
}

/**
 * The Controls filter choices a game falls under, from its controls badge: VR = VR only or VR supported; Controller
 * = full or partial controller support (and every console game); Mouse and Keyboard = keyboard and mouse games, plus
 * those with only partial controller support or VR as an option, which are played with them too; Touch = games with
 * touch screen support (GameMetadata.steamTags.controls.touch), as well as their other choices.
 */
export function controlsFilterIds(game: Pick<Game, 'source' | 'launch' | 'metadata'>): string[] {
  const ids = playIds(game)
  // Touch, on top of how else the game plays: set by SteamControls.touch (no source sets it yet).
  return game.metadata.steamTags?.controls?.touch === 'supported' ? [...ids, 'touch'] : ids
}

/**
 * Filters > Controls: the choices (CONTROLS_FILTERS ids, in the menu's order) at least one of these games falls under;
 * the others are not offered.
 */
export function libraryControlsFilters(
  games: readonly Pick<Game, 'source' | 'launch' | 'metadata'>[]
): string[] {
  const found = new Set<string>()
  for (const game of games) {
    for (const id of controlsFilterIds(game)) found.add(id)
    if (found.size === CONTROLS_FILTERS.length) break
  }
  return CONTROLS_FILTERS.filter((c) => found.has(c.id)).map((c) => c.id)
}

function playIds(game: Pick<Game, 'source' | 'launch' | 'metadata'>): string[] {
  switch (gameControls(game).kind) {
    case 'vr-only':
      return ['vr']
    case 'vr':
      return ['vr', 'keyboard']
    case 'controller':
      return ['controller']
    case 'partial':
      return ['controller', 'keyboard']
    case 'keyboard':
      return ['keyboard']
  }
}

export function gameControls(game: Pick<Game, 'source' | 'launch' | 'metadata'>): Controls {
  const pad = (): string => t('lib.controls.badge.pad')
  const vrBadge = (): string => t('lib.controls.badge.vr')
  if (game.source === 'rom' || game.launch.kind === 'emulator')
    return { kind: 'controller', label: pad(), text: t('lib.controls.console') }
  const c = game.metadata.steamTags?.controls
  const vr = c?.vr === 'supported'
  if (c?.vr === 'only') return { kind: 'vr-only', label: vrBadge(), text: t('lib.controls.vrOnly') }
  if (c?.controller === 'full')
    return {
      kind: 'controller',
      label: pad(),
      text: vr ? t('lib.controls.fullVr') : t('lib.controls.full')
    }
  if (c?.controller === 'partial')
    return {
      kind: 'partial',
      label: t('lib.controls.badge.partial'),
      text: vr ? t('lib.controls.partialVr') : t('lib.controls.partial')
    }
  if (vr) return { kind: 'vr', label: vrBadge(), text: t('lib.controls.vrSupported') }
  return {
    kind: 'keyboard',
    label: t('lib.controls.badge.keyboard'),
    text: t('lib.controls.keyboard')
  }
}
