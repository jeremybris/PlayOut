import logoBySystem from './system-logos.json'

/**
 * Emulation systems' logos (the user's "Dark - Color" set, trimmed and scaled to 96 px tall), shown in a light plate
 * instead of the round badge wherever a ROM game's platform badge appears. `system-logos.json` maps an ES-DE system
 * id to its logo file; regional twins share one (megadrivejp is Sega Mega Drive). Systems without one keep the badge.
 */
const files = import.meta.glob<string>('../assets/system-logos/*.png', {
  eager: true,
  query: '?url',
  import: 'default'
})

const urlBySlug = new Map(
  Object.entries(files).map(([path, url]) => [
    path.slice(path.lastIndexOf('/') + 1, -'.png'.length),
    url
  ])
)

/** The logo of an emulation system (an ES-DE system id), or undefined when it has none. */
export function systemLogo(systemId: string | undefined): string | undefined {
  if (!systemId) return undefined
  const slug = (logoBySystem as Record<string, string>)[systemId]
  return slug ? urlBySlug.get(slug) : undefined
}
