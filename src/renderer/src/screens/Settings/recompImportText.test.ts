import { describe, expect, it } from 'vitest'
import type { RecompImportChoice, RecompImportItem } from '@shared/recomp'
import {
  CHOOSE_OTHER,
  importRowState,
  importStartChoice,
  searchImportCatalog,
  SEARCH_LIMIT,
  SKIP
} from './recompImportText'

const choice = (id: string, over: Partial<RecompImportChoice> = {}): RecompImportChoice => ({
  id,
  name: id.toUpperCase(),
  game: id,
  console: 'N64',
  installed: false,
  target: `C:\\R\\${id}`,
  targetTaken: false,
  ...over
})

const item = (over: Partial<RecompImportItem> = {}): RecompImportItem => ({
  folder: 'C:\\L\\a',
  name: 'a',
  launcher: 'quiver',
  bytes: 1,
  match: 'repo',
  recompId: 'a',
  choices: [choice('a')],
  version: null,
  blocked: null,
  notes: [],
  ...over
})

describe('importStartChoice', () => {
  it('starts with the sure match only', () => {
    expect(importStartChoice(item())).toBe('a')
    expect(importStartChoice(item({ match: 'launcher-id' }))).toBe('a')
    expect(importStartChoice(item({ match: 'title' }))).toBe(SKIP)
    expect(importStartChoice(item({ match: 'none', recompId: null, choices: [] }))).toBe(SKIP)
    expect(importStartChoice(item({ recompId: null, choices: [choice('a'), choice('b')] }))).toBe(
      SKIP
    )
    expect(importStartChoice(item({ choices: [choice('a', { installed: true })] }))).toBe(SKIP)
    expect(importStartChoice(item({ choices: [choice('a', { targetTaken: true })] }))).toBe(SKIP)
    expect(importStartChoice(item({ blocked: 'running' }))).toBe(SKIP)
  })
})

describe('importRowState', () => {
  it('says where a chosen folder goes, and why another is not imported', () => {
    expect(importRowState(item(), 'a', { 'C:\\L\\a': 'a' })).toEqual({
      ok: true,
      message: 'Moves to C:\\R\\a'
    })
    expect(importRowState(item({ blocked: 'x is running' }), 'a', {})).toEqual({
      ok: false,
      message: 'x is running'
    })
    expect(importRowState(item({ match: 'none', choices: [] }), SKIP, {}).message).toMatch(
      /Not found in the catalog/
    )
    expect(importRowState(item({ choices: [choice('a', { installed: true })] }), 'a', {})).toEqual({
      ok: false,
      message: 'A is already installed in PlayOut.'
    })
    // The same recompilation chosen for another folder too.
    expect(importRowState(item(), 'a', { 'C:\\L\\a': 'a', 'C:\\L\\b': 'a' }).ok).toBe(false)
    // A recompilation picked from the whole catalog.
    expect(importRowState(item({ match: 'none', choices: [] }), 'z', {}).ok).toBe(true)
  })
})

describe('a recompilation picked from the whole catalog', () => {
  const cat = [
    {
      id: 'x',
      name: 'Xerenge',
      game: 'Burnout Revenge',
      console: 'Xbox 360',
      installed: true,
      target: 'C:/R/x',
      targetTaken: false
    },
    {
      id: 'y',
      name: 'Prime 2',
      game: 'Metroid Prime 2: Echoes',
      console: 'GameCube',
      installed: false,
      target: 'C:/R/y',
      targetTaken: true
    },
    {
      id: 'z',
      name: 'Pokémon Red',
      game: 'Pokémon Red',
      console: 'Game Boy',
      installed: false,
      target: 'C:/R/z',
      targetTaken: false
    }
  ]
  const none = item({ match: 'none', recompId: null, choices: [] })
  it('gets the same checks as a matched choice', () => {
    expect(importRowState(none, 'x', { [none.folder]: 'x' }, cat)).toMatchObject({ ok: false })
    expect(importRowState(none, 'x', { [none.folder]: 'x' }, cat).message).toMatch(
      /already installed/
    )
    expect(importRowState(none, 'y', { [none.folder]: 'y' }, cat).message).toMatch(/already in/)
    expect(importRowState(none, 'z', { [none.folder]: 'z' }, cat)).toMatchObject({ ok: true })
    expect(importRowState(none, CHOOSE_OTHER, {}, cat)).toEqual({ ok: false, message: null })
  })
  it('is found by search: every word, any case or accent, a limited list', () => {
    expect(searchImportCatalog(cat, 'pokemon red').results.map((c) => c.id)).toEqual(['z'])
    expect(searchImportCatalog(cat, 'ECHOES').results.map((c) => c.id)).toEqual(['y'])
    expect(searchImportCatalog(cat, 'prime', ['y']).results).toEqual([])
    expect(searchImportCatalog(cat, '  ').results).toEqual([])
    const many = Array.from({ length: SEARCH_LIMIT + 5 }, (_, i) => ({ ...cat[2]!, id: `p${i}` }))
    expect(searchImportCatalog(many, 'red')).toMatchObject({ more: true })
    expect(searchImportCatalog(many, 'red').results).toHaveLength(SEARCH_LIMIT)
  })
})
