import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LIBRARY_SORT_OPTIONS } from '../lib/libraryView'
import { sortIcon, withSortIcons } from './SortIcon'

describe('Sort menu icons', () => {
  it('gives every order an icon except A-Z', () => {
    for (const { value } of LIBRARY_SORT_OPTIONS) {
      const icon = sortIcon(value)
      if (value === 'title-asc') expect(icon).toBeUndefined()
      else expect(renderToStaticMarkup(<>{icon}</>)).toContain('console-icon')
    }
  })

  it('draws every icon in the text colour: the Difficulty arm as a mask, line icons with a heavier stroke', () => {
    const difficulty = renderToStaticMarkup(<>{sortIcon('difficulty')}</>)
    expect(difficulty).toContain('sort-icon__mask')
    expect(difficulty).not.toContain('<img')
    for (const sort of ['most-played', 'recent', 'players', 'added', 'release'] as const)
      expect(renderToStaticMarkup(<>{sortIcon(sort)}</>)).toContain('stroke-width="2.75"')
  })

  it('keeps the order and names, adding icons (an empty slot for A-Z)', () => {
    const options = withSortIcons([
      { value: 'title-asc' as const, label: 'A-Z' },
      { value: 'size' as const, label: 'Size' }
    ])
    expect(options.map((o) => o.label)).toEqual(['A-Z', 'Size'])
    // A-Z: an empty slot only, so its name lines up.
    expect(renderToStaticMarkup(<>{options[0]!.icon}</>)).toBe(
      '<span class="console-icon" aria-hidden="true"></span>'
    )
    expect(renderToStaticMarkup(<>{options[1]!.icon}</>)).toContain('size-pie')
  })
})
