/**
 * Era pictures for Filters > Release (the user's "Gaming Epoch Icons" set, scaled to 96 px; scripts/build-era-icons.ps1
 * makes them), one per RELEASE_ERAS id: an Earth globe, from 8 x 8 pixels for "Before 1990" to photoreal for
 * "2025-Present".
 */
const files = import.meta.glob<string>('../assets/era-icons/*.png', {
  eager: true,
  query: '?url',
  import: 'default'
})

const urlByEra = new Map(
  Object.entries(files).map(([path, url]) => [
    path.slice(path.lastIndexOf('/') + 1, -'.png'.length),
    url
  ])
)

/** The picture of a Filters > Release era id, or undefined when it has none. */
export function eraIcon(eraId: string | undefined): string | undefined {
  return eraId ? urlByEra.get(eraId) : undefined
}
