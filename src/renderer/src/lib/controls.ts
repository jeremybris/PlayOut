import type { Game } from '@shared/types'
import { t } from '../i18n'

/**
 * How a game is played, for the controls badge on its page (left of the players badge): Steam's controller and VR
 * support (GameMetadata.steamTags.controls, read with the Steam tags, or set by the Edit sheet's Controls choice); a
 * console game (a ROM) plays with a controller; anything else, keyboard and mouse. 'touch' = touch screen only,
 * 'both' = full controller and full mouse and keyboard support, 'all' = those and VR.
 */
export type ControlsKind =
  'controller' | 'partial' | 'vr-only' | 'vr' | 'keyboard' | 'touch' | 'both' | 'all'

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
 * those with only partial controller support, full mouse and keyboard support beside the controller or VR as an
 * option, which are played with them too; Touch = games with touch screen support
 * (GameMetadata.steamTags.controls.touch), as well as their other choices (a touch-only game is under Touch alone).
 */
export function controlsFilterIds(game: Pick<Game, 'source' | 'launch' | 'metadata'>): string[] {
  const ids = playIds(game)
  // Touch, on top of how else the game plays.
  return game.metadata.steamTags?.controls?.touch === 'supported' && !ids.includes('touch')
    ? [...ids, 'touch']
    : ids
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
    case 'touch':
      return ['touch']
    case 'both':
      return ['controller', 'keyboard']
    case 'all':
      return ['vr', 'controller', 'keyboard']
  }
}

export function gameControls(game: Pick<Game, 'source' | 'launch' | 'metadata'>): Controls {
  const pad = (): string => t('lib.controls.badge.pad')
  const vrBadge = (): string => t('lib.controls.badge.vr')
  if (game.source === 'rom' || game.launch.kind === 'emulator')
    return { kind: 'controller', label: pad(), text: t('lib.controls.console') }
  const c = game.metadata.steamTags?.controls
  const vr = c?.vr === 'supported'
  // VR only (a headset is needed) wins over anything else the entry says.
  if (c?.vr === 'only') return { kind: 'vr-only', label: vrBadge(), text: t('lib.controls.vrOnly') }
  // Full controller and full mouse and keyboard (the Edit sheet's Mouse & Keyboard + Controller, and All with VR).
  if (c?.controller === 'full' && c.keyboard === 'full')
    return vr
      ? { kind: 'all', label: t('lib.controls.badge.all'), text: t('lib.controls.all') }
      : { kind: 'both', label: t('lib.controls.badge.both'), text: t('lib.controls.both') }
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
  // Touch screen only (no controller, no VR): with either, touch only adds to Filters > Controls.
  if (c?.touch === 'supported')
    return { kind: 'touch', label: t('lib.controls.badge.touch'), text: t('lib.controls.touch') }
  return {
    kind: 'keyboard',
    label: t('lib.controls.badge.keyboard'),
    text: t('lib.controls.keyboard')
  }
}
