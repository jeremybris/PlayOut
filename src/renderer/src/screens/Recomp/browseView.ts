// The recompilation browser's search and sort (RecompBrowser.tsx): pure, so it is tested on its own.

import type { RecompBrowseEntry, RecompBrowseSort, RecompBrowseTitle } from '@shared/recomp'
import { t } from '../../i18n'

/** The sort choices, labelled in the current language (built when shown, never kept). */
export function browseSorts(): { value: RecompBrowseSort; label: string }[] {
  return [
    { value: 'added', label: t('recomp.browser.sorts.added') },
    { value: 'updated', label: t('recomp.browser.sorts.updated') },
    { value: 'stars', label: t('recomp.browser.sorts.stars') }
  ]
}

/** The browser's filter: every recompilation, or only the favourited ones. */
export type RecompBrowseFilter = 'all' | 'favorites'

/** The filter choices, labelled in the current language. */
export function browseFilters(): { value: RecompBrowseFilter; label: string }[] {
  return [
    { value: 'all', label: t('recomp.browser.filters.all') },
    { value: 'favorites', label: t('recomp.browser.filters.favorites') }
  ]
}

/**
 * Favorites: only the games with a favourited recompilation, each with only its favourited recompilations. `ids` are
 * the favourites to show (a snapshot, so a heart pressed now does not make the row vanish under the focus).
 */
export function favoriteTitles(
  titles: RecompBrowseTitle[],
  ids: ReadonlySet<string>
): RecompBrowseTitle[] {
  const out: RecompBrowseTitle[] = []
  for (const t of titles) {
    const entries = t.entries.filter((e) => ids.has(e.id))
    if (entries.length) out.push(entries.length === t.entries.length ? t : { ...t, entries })
  }
  return out
}

/** Lowercase, accents and punctuation removed ("Pokémon: Red" -> "pokemon red"). */
export function foldText(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** "WWFNoMercyRecomp" -> "WWF No Mercy Recomp", "zelda64" -> "zelda 64" (repository names run words together). */
function splitWords(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])(d)/g, '$1 $2')
}

/**
 * What a game is searched by: the game's name (the title's and each project's own), the console, and each
 * recompilation's project name, GitHub repository (owner/repo, words split), author and tags. Held twice: as words,
 * and with spaces removed, so "zelda64" finds "Zelda 64" and "shipwright" finds HarbourMasters/Shipwright.
 */
function haystack(t: RecompBrowseTitle): { words: string; compact: string } {
  const parts = [t.game, t.console]
  for (const e of t.entries) {
    const repoName = e.repo.split('/').pop() ?? e.repo
    parts.push(
      e.game,
      e.name,
      e.repo,
      splitWords(repoName),
      e.author,
      ...e.tags.map((x) => x.label)
    )
  }
  const words = foldText(parts.join(' | '))
  return { words, compact: words.replace(/ /g, '') }
}

/**
 * Titles that hold every word of `query` in the game's name, a recompilation's project or repository name, the
 * console, an author or a tag. The whole query run together also matches ("zelda 64" finds "Zelda64Recomp").
 */
export function searchTitles(titles: RecompBrowseTitle[], query: string): RecompBrowseTitle[] {
  const folded = foldText(query)
  const words = folded.split(' ').filter(Boolean)
  if (!words.length) return titles
  const joined = folded.replace(/ /g, '')
  return titles.filter((t) => {
    const h = haystack(t)
    return words.every((w) => h.words.includes(w)) || h.compact.includes(joined)
  })
}

/** An entry's sort value (bigger = first); null = unknown, sorted last. */
export function entryValue(e: RecompBrowseEntry, sort: RecompBrowseSort): number | null {
  if (sort === 'stars') return e.stars
  const iso = sort === 'added' ? e.addedAt : e.updatedAt
  const ms = iso ? Date.parse(iso) : NaN
  return Number.isFinite(ms) ? ms : null
}

function titleValue(t: RecompBrowseTitle, sort: RecompBrowseSort): number | null {
  let best: number | null = null
  for (const e of t.entries) {
    const v = entryValue(e, sort)
    if (v !== null && (best === null || v > best)) best = v
  }
  return best
}

const byValue = (a: number | null, b: number | null): number =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : b - a

/**
 * Games ordered by their best recompilation for `sort` (newest added / updated, most stars; unknown last, then by
 * name), each game's recompilations in the same order with the recommended one first.
 */
export function sortTitles(
  titles: RecompBrowseTitle[],
  sort: RecompBrowseSort
): RecompBrowseTitle[] {
  return titles
    .map((t) => ({
      t: {
        ...t,
        entries: [...t.entries].sort(
          (a, b) =>
            Number(b.recommended) - Number(a.recommended) ||
            byValue(entryValue(a, sort), entryValue(b, sort)) ||
            a.name.localeCompare(b.name)
        )
      },
      v: titleValue(t, sort)
    }))
    .sort((a, b) => byValue(a.v, b.v) || a.t.game.localeCompare(b.t.game))
    .map((x) => x.t)
}
