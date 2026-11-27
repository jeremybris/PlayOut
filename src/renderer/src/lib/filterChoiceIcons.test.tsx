import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { tabPartIcon } from './filterChoiceIcons'
import {
  MAX_TAB_ICONS,
  cappedTabGroups,
  emptyTabFilters,
  tabFiltersOf,
  tabName,
  tabNameGroups,
  type TabNameKind,
  type TabNamePart
} from './libraryTabs'
import { ALL_STORES, OTHER_PC } from './storeFilters'
import { ALL_ROM_PLATFORMS } from './platformFilters'
import { LOCAL_ALL } from './localMultiplayer'

/**
 * Settings > Library "Icons for tabs": each tab choice's icon is the one its Filters sub-menu shows; a choice without
 * one (developers, publishers, "All …" choices, a genre or system without a picture) keeps its words.
 */

const part = (kind: TabNameKind, id: string): TabNamePart => ({ kind, id, label: id })
const markup = (p: TabNamePart, customIcon?: (id: string) => string | undefined): string | null => {
  const icon = tabPartIcon(p, customIcon)
  return icon === null || icon === undefined ? null : renderToStaticMarkup(<>{icon}</>)
}

describe('tabPartIcon', () => {
  it('draws each filter kind with its Filters sub-menu icon', () => {
    expect(markup(part('platform', 'snes'))).toContain('console-icon__img')
    expect(markup(part('store', 'steam'))).toContain('console-icon')
    expect(markup(part('era', 'y-2000-2005'))).toContain('console-icon__img')
    // A line-icon genre, tinted by its filter colour.
    expect(markup(part('genre', 'rpg'))).toContain('genre-icon')
    expect(markup(part('size', 'gb-5-15'))).toContain('size-pie')
    expect(markup(part('hltb', 'h-0-3'))).toContain('hltb-clock')
    expect(markup(part('difficulty', 'hard'))).toContain('console-icon__img')
    expect(markup(part('reviews', 'r95'))).toContain('review-star')
    expect(markup(part('controls', 'touch'))).toContain('controls-icon')
    expect(markup(part('controls', 'lightgun'))).toContain('data-controls="lightgun"')
    expect(markup(part('players', '3-4'))).toContain('players-art')
    expect(markup(part('players', 'party'))).toContain('console-icon__generic')
    expect(markup(part('players', 'lan-party'))).toContain('console-icon__generic')
    expect(markup(part('online', 'pvp'))).toContain('console-icon__generic')
    expect(markup(part('coop', 'coop'))).toContain('console-icon__generic')
    expect(markup(part('hidden', 'hidden'))).toContain('library__tab-flag')
    expect(markup(part('favorites', 'favorites'))).toContain('filters-menu__icon--favorite')
    expect(markup(part('recomp', 'recomp'))).toContain('filters-menu__icon--recomp')
  })

  it('draws a custom filter with its own icon, by its id', () => {
    const icons = new Map([['cf1', 'skull']])
    expect(markup(part('custom', 'cf1'), (id) => icons.get(id))).toContain('console-icon__generic')
    expect(markup(part('custom', 'cf-unknown'), (id) => icons.get(id))).toBeNull()
  })

  it('keeps the words of choices without an icon', () => {
    expect(markup(part('developer', 'FromSoftware'))).toBeNull()
    expect(markup(part('publisher', 'Capcom'))).toBeNull()
    expect(markup(part('genreName', 'Action'))).toBeNull()
    expect(markup(part('store', ALL_STORES))).toBeNull()
    expect(markup(part('platform', ALL_ROM_PLATFORMS))).toBeNull()
    // A system without a console picture: the sub-menu's generic controller would not say which one it is.
    expect(markup(part('platform', 'no-such-system'))).toBeNull()
    expect(markup(part('genre', 'no-such-genre'))).toBeNull()
    expect(markup(part('players', LOCAL_ALL))).toBeNull()
    expect(markup(part('online', 'no-such-choice'))).toBeNull()
    expect(markup(part('size', 'no-such-band'))).toBeNull()
  })
})

describe('tabNameGroups', () => {
  it('lists the choices per filter in the order tabName names them', () => {
    const filters = tabFiltersOf({
      stores: ['epic', 'gog'],
      tags: ['rpg'],
      developers: ['FromSoftware'],
      favorites: true
    })
    const groups = tabNameGroups(filters)
    expect(groups.map((g) => g.map((p) => `${p.kind}:${p.id}`))).toEqual([
      ['store:epic', 'store:gog'],
      ['genre:rpg'],
      ['developer:FromSoftware'],
      ['favorites:favorites']
    ])
    expect(groups.map((g) => g.map((p) => p.label).join(' + ')).join(' · ')).toBe(tabName(filters))
  })

  it('is empty for All Games', () => {
    expect(tabNameGroups(emptyTabFilters())).toEqual([])
  })
})

describe('cappedTabGroups', () => {
  it(`keeps the first ${MAX_TAB_ICONS} choices and counts the rest`, () => {
    const groups = [
      ['a', 'b', 'c'].map((id) => part('store', id)),
      ['d', 'e', 'f'].map((id) => part('genre', id)),
      [part('favorites', 'favorites')]
    ]
    const capped = cappedTabGroups(groups)
    expect(capped.groups.map((g) => g.map((p) => p.id))).toEqual([
      ['a', 'b', 'c'],
      ['d', 'e']
    ])
    expect(capped.more).toBe(2)
  })

  it('keeps everything under the cap', () => {
    const groups = [[part('store', 'a')], [part('genre', 'b')]]
    expect(cappedTabGroups(groups)).toEqual({ groups, more: 0 })
  })

  it('counts only choices drawn as icons toward the cap', () => {
    const isIcon = (p: TabNamePart): boolean => p.kind !== 'developer'
    // Six developers: all words, none hidden behind a "+N".
    const devs = [['a', 'b', 'c', 'd', 'e', 'f'].map((id) => part('developer', id))]
    expect(cappedTabGroups(devs, isIcon)).toEqual({ groups: devs, more: 0 })
    // Words before the fifth icon stay; what follows it is counted.
    const mixed = [
      [part('developer', 'x'), part('developer', 'y')],
      ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => part('genre', id)),
      [part('developer', 'z')]
    ]
    const capped = cappedTabGroups(mixed, isIcon)
    expect(capped.groups.map((g) => g.map((p) => p.id))).toEqual([
      ['x', 'y'],
      ['a', 'b', 'c', 'd', 'e']
    ])
    expect(capped.more).toBe(2)
  })
})

describe('storeChoiceIcon', () => {
  it('draws a known store and Other, words for an id that is no longer a store', () => {
    expect(markup(part('store', 'epic'))).toContain('badge')
    expect(markup(part('store', OTHER_PC))).toContain('badge')
    expect(markup(part('store', 'removed-store'))).toBeNull()
  })
})
