/**
 * The icon slug of an ES-DE system's platform badge (the round badge at a game card's bottom right): shared by main,
 * which gives each system's Platform row its icon, and the renderer, which shows the same badge where there is no
 * Platform row at hand (Settings › Convert lists systems without games too).
 */

/**
 * simple-icons slugs by manufacturer. Only slugs that exist in the installed simple-icons package belong here
 * (emulation/systems.test.ts verifies them); manufacturers without an icon fall back to the lucide 'gamepad-2' glyph.
 */
export const MANUFACTURER_ICONS: Record<string, string> = {
  Sony: 'playstation',
  Sega: 'sega',
  Atari: 'atari',
  Commodore: 'commodore',
  NEC: 'nec',
  Apple: 'apple',
  Panasonic: 'panasonic',
  Google: 'android',
  Valve: 'steam',
  Sharp: 'sharp',
  Fujitsu: 'fujitsu',
  Nokia: 'nokia',
  Epic: 'epicgames',
  'XBMC Foundation': 'kodi',
  'Mathieu Comandon': 'lutris',
  Lenovo: 'lenovo',
  Samsung: 'samsung'
}

/** Per-system icon overrides (simple-icons slugs), more specific than the manufacturer icon. */
export const SYSTEM_ICONS: Record<string, string> = {
  psx: 'playstation',
  ps2: 'playstation2',
  ps3: 'playstation3',
  ps4: 'playstation4',
  ps5: 'playstation5',
  psp: 'playstationportable',
  psvita: 'playstationvita',
  steam: 'steam',
  epic: 'epicgames',
  kodi: 'kodi',
  lutris: 'lutris',
  android: 'android',
  androidapps: 'android',
  androidgames: 'android'
}

export const FALLBACK_ICON = 'gamepad-2'

/** The badge icon of a system: its own icon, else its manufacturer's, else a gamepad. */
export function systemIconSlug(systemId: string, manufacturer?: string): string {
  return (
    SYSTEM_ICONS[systemId] ??
    (manufacturer ? MANUFACTURER_ICONS[manufacturer] : undefined) ??
    FALLBACK_ICON
  )
}
