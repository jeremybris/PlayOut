import iconBySystem from './console-icons.json'

/**
 * Console pictures for Filters > Platform (the user's "HD Video Games" set plus the pictures they added later in
 * scripts/console-icons-extra, scaled to 96 px; scripts/build-console-icons.ps1 makes them). `console-icons.json` maps
 * an emulation system id to its picture; regional twins share one (megadrivejp is the Genesis, the Android variants
 * share Android's). A system without one gets ConsoleIcon's generic controller.
 */
const files = import.meta.glob<string>('../assets/console-icons/*.png', {
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

/** The console picture of an emulation system id, or undefined when it has none. */
export function consoleIcon(systemId: string | undefined): string | undefined {
  if (!systemId) return undefined
  const slug = (iconBySystem as Record<string, string>)[systemId]
  return slug ? urlBySlug.get(slug) : undefined
}
