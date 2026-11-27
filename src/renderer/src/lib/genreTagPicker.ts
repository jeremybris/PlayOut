import { t } from '../i18n'
import { joinList, splitList, type MetadataForm } from './metadataForm'
import { TAG_FILTERS, genreFilterFor, type TagFilter } from './steamTags'

/**
 * The Edit sheet's Genres & Tags dropdown (screens/GameDetail/GenresTagsField.tsx): the Filters › Genre choices
 * (lib/steamTags.ts TAG_FILTERS) and the game's other genres and tags as one checklist over the form's `genres` and
 * `tags` text. Pure, so what a toggle does to the two lists is tested without the UI.
 *
 * A genre or tag counts as a choice by any of its spellings (genreFilterFor: the label, Steam's spelling, the scrapers'
 * other names: "Role-playing (RPG)" and the Steam tag "RPG" are both RPG), so a choice is ticked whichever list holds
 * it, and unticking it takes every spelling out of both lists. Ticking adds the choice's label to the genres, except
 * that a choice unticked while the sheet is open gets back the very strings it had, in their places: ticking it again
 * then leaves the lists as they were, and nothing is saved.
 */

/** One row of the dropdown. */
export interface GenreTagRow {
  /** A TAG_FILTERS id, or `other:` and the lower-cased text for a genre / tag that is no choice. */
  id: string
  label: string
  checked: boolean
  /** The Filters › Genre choice; undefined for a genre / tag of the game that is none ("Indie"). */
  filter?: TagFilter
}

const OTHER = 'other:'

/** The row a genre or tag string belongs to. */
export function genreTagRowId(text: string): string {
  return genreFilterFor(text)?.id ?? `${OTHER}${text.trim().toLowerCase()}`
}

const byLabel = (a: { label: string }, b: { label: string }): number =>
  a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })

/** Every genre and tag of a form, genres first (the game's own order). */
const itemsOf = (form: Pick<MetadataForm, 'genres' | 'tags'>): string[] => [
  ...splitList(form.genres),
  ...splitList(form.tags)
]

/**
 * The dropdown's rows: every TAG_FILTERS choice, then (`others`) the genres and tags that are no choice, each list
 * alphabetical. Alphabetical rather than ticked-first: a row must not move under the controller when it is toggled,
 * and it is the order Filters › Genre lists them in. `bases`: the values the sheet opened with (what the game shows,
 * the cloud's / scraped values Reset goes back to); their other genres and tags stay listed once unticked, so the
 * row under focus does not vanish and can be ticked again.
 */
export function genreTagRows(
  form: Pick<MetadataForm, 'genres' | 'tags'>,
  bases: readonly Pick<MetadataForm, 'genres' | 'tags'>[] = []
): { choices: GenreTagRow[]; others: GenreTagRow[] } {
  const on = new Set(itemsOf(form).map(genreTagRowId))
  const choices = TAG_FILTERS.map((filter): GenreTagRow => ({
    id: filter.id,
    label: filter.label,
    checked: on.has(filter.id),
    filter
  })).sort(byLabel)
  // The form's own spelling first, then the bases'.
  const others = new Map<string, GenreTagRow>()
  for (const text of [form, ...bases].flatMap(itemsOf)) {
    const id = genreTagRowId(text)
    if (!id.startsWith(OTHER) || others.has(id)) continue
    others.set(id, { id, label: text, checked: on.has(id) })
  }
  return { choices, others: [...others.values()].sort(byLabel) }
}

/** The field's summary: the ticked rows in the game's order (its first genre first), "Action, RPG +3"; "None". */
export function genreTagSummary(form: Pick<MetadataForm, 'genres' | 'tags'>, shown = 2): string {
  const labels = new Map<string, string>()
  for (const text of itemsOf(form)) {
    const id = genreTagRowId(text)
    if (!labels.has(id)) labels.set(id, genreFilterFor(text)?.label ?? text)
  }
  const all = [...labels.values()]
  if (!all.length) return t('lib.genreTagPicker.none')
  const first = all.slice(0, shown).join(', ')
  return all.length > shown ? `${first} +${all.length - shown}` : first
}

const sameText = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * `base`'s strings of row `id` that `list` lacks, put back where they stand in `base` (before the first item that
 * comes after them there; items `base` does not have count as last), so the tags keep Steam's strongest-first order.
 */
function restore(list: string[], base: readonly string[], id: string): string[] {
  const indexIn = (text: string): number => {
    const i = base.findIndex((b) => sameText(b, text))
    return i < 0 ? Number.POSITIVE_INFINITY : i
  }
  const out = [...list]
  for (const text of base) {
    if (genreTagRowId(text) !== id || out.some((item) => sameText(item, text))) continue
    const at = out.findIndex((item) => indexIn(item) > indexIn(text))
    out.splice(at < 0 ? out.length : at, 0, text)
  }
  return out
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((item, i) => item === b[i])

/**
 * The form's genres and tags after `row` was toggled. Ticked: every genre and tag of that row goes (all spellings).
 * Not ticked: the strings `bases` had for it come back to their places, else its label is added to the genres. A
 * list the toggle did not change keeps its text as it was.
 */
export function toggleGenreTag(
  form: Pick<MetadataForm, 'genres' | 'tags'>,
  row: Pick<GenreTagRow, 'id' | 'label'>,
  bases: readonly Pick<MetadataForm, 'genres' | 'tags'>[] = []
): Pick<MetadataForm, 'genres' | 'tags'> {
  const genres = splitList(form.genres)
  const tags = splitList(form.tags)
  const ticked = [...genres, ...tags].some((text) => genreTagRowId(text) === row.id)
  let nextGenres: string[]
  let nextTags: string[]
  if (ticked) {
    nextGenres = genres.filter((text) => genreTagRowId(text) !== row.id)
    nextTags = tags.filter((text) => genreTagRowId(text) !== row.id)
  } else {
    const merged = (key: 'genres' | 'tags'): string[] => {
      const out: string[] = []
      for (const base of bases)
        for (const text of splitList(base[key]))
          if (!out.some((item) => sameText(item, text))) out.push(text)
      return out
    }
    nextGenres = restore(genres, merged('genres'), row.id)
    nextTags = restore(tags, merged('tags'), row.id)
    // A choice goes in by its English name (the label may be translated): genres are the game's data.
    if (sameList(nextGenres, genres) && sameList(nextTags, tags))
      nextGenres = [...genres, TAG_FILTERS.find((f) => f.id === row.id)?.name ?? row.label]
  }
  return {
    genres: sameList(nextGenres, genres) ? form.genres : joinList(nextGenres),
    tags: sameList(nextTags, tags) ? form.tags : joinList(nextTags)
  }
}

/** At most this many suggestions under the Edit sheet's Genres & Tags search box. */
export const GENRE_TAG_SUGGESTIONS_MAX = 8

/** Lower case without accents ("Acción" → "accion"), for the search box's matching. */
const fold = (text: string): string =>
  text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()

/**
 * The Genres & Tags search box's suggestions for `query` (GenresTagsSearch): the dropdown's rows (genreTagRows, by
 * their shown names) that the game does not have yet and whose name holds the text, ignoring case and accents. Names
 * that start with it first, then names with a word that starts with it ("Point & Click" for "cl"), then the other
 * matches; alphabetical within each group; at most `max`. Nothing for an empty query.
 */
export function genreTagSuggestions(
  query: string,
  form: Pick<MetadataForm, 'genres' | 'tags'>,
  bases: readonly Pick<MetadataForm, 'genres' | 'tags'>[] = [],
  max = GENRE_TAG_SUGGESTIONS_MAX
): GenreTagRow[] {
  const q = fold(query)
  if (!q) return []
  const { choices, others } = genreTagRows(form, bases)
  const groups: GenreTagRow[][] = [[], [], []]
  for (const row of [...choices, ...others]) {
    if (row.checked) continue
    const name = fold(row.label)
    const at = name.indexOf(q)
    if (at < 0) continue
    const wordStart = name.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(q))
    groups[at === 0 ? 0 : wordStart ? 1 : 2]!.push(row)
  }
  return groups.flatMap((group) => group.sort(byLabel)).slice(0, max)
}
