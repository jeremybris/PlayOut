/**
 * Pictures for the Filters > Genre choices no line icon fits (the user's Desktop "Icons" set, scaled to 96 px;
 * scripts/build-genre-icons.ps1 makes them), by TAG_FILTERS id. A "mask" picture is a black drawing whose ink
 * GenreIcon paints in the text colour, like the line icons; a "color" one is shown as it is.
 */
export interface GenrePicture {
  url: string
  kind: 'mask' | 'color'
}

const files = import.meta.glob<string>('../assets/genre-icons/*.png', {
  eager: true,
  query: '?url',
  import: 'default'
})

/** File slug (the genre id with every run of other characters as "-") -> picture. */
const bySlug = new Map<string, GenrePicture>()
for (const [path, url] of Object.entries(files)) {
  const name = path.slice(path.lastIndexOf('/') + 1, -'.png'.length)
  if (name.endsWith('.mask')) bySlug.set(name.slice(0, -'.mask'.length), { url, kind: 'mask' })
  else bySlug.set(name, { url, kind: 'color' })
}

/** The picture of a Filters > Genre id, or undefined when it has none. */
export function genrePicture(genreId: string): GenrePicture | undefined {
  return bySlug.get(genreId.replace(/[^a-z0-9]+/g, '-'))
}
