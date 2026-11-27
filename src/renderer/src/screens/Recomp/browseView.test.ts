import type { RecompBrowseEntry, RecompBrowseTitle } from '@shared/recomp'
import { describe, expect, it } from 'vitest'
import {
  addedMark,
  addedMarkText,
  browseFilters,
  canAddChecked,
  createCheckGate,
  favoriteTitles,
  foldText,
  searchTitles,
  sortTitles,
  removeAddedMessage,
  titleIndexOf
} from './browseView'

const e = (id: string, over: Partial<RecompBrowseEntry> = {}): RecompBrowseEntry => ({
  id,
  name: id,
  repo: `someone/${id}`,
  game: 'Some game',
  author: 'someone',
  blurb: '',
  tags: [],
  stars: null,
  addedAt: null,
  updatedAt: null,
  latestTag: null,
  downloadBytes: null,
  recommended: false,
  archived: false,
  repoUrl: `https://github.com/x/${id}`,
  installed: false,
  isNew: false,
  favorite: false,
  libraryGameId: null,
  ...over
})
const t = (
  game: string,
  entries: RecompBrowseEntry[],
  console = 'Nintendo 64'
): RecompBrowseTitle => ({
  key: `n64:${game.toLowerCase()}`,
  game,
  systemId: 'n64',
  console,
  coverUrl: null,
  entries,
  gameIds: []
})

describe('searchTitles', () => {
  const titles = [
    t('Pokémon Red', [e('pokered', { author: 'pret' })], 'Game Boy'),
    t('Super Mario 64', [e('sm64ex', { tags: [{ label: 'Widescreen', kind: 'feature' }] })])
  ]
  it('matches every word across game, console, name, author and tags, ignoring accents', () => {
    expect(searchTitles(titles, 'pokemon').map((x) => x.game)).toEqual(['Pokémon Red'])
    expect(searchTitles(titles, 'game boy pret').map((x) => x.game)).toEqual(['Pokémon Red'])
    expect(searchTitles(titles, 'widescreen').map((x) => x.game)).toEqual(['Super Mario 64'])
    expect(searchTitles(titles, 'mario pret')).toEqual([])
    expect(searchTitles(titles, '  ')).toBe(titles)
  })
  it('finds a game by its recompilation project and GitHub repository names', () => {
    const shipwright = [
      t('The Legend of Zelda: Ocarina of Time', [
        e('soh', {
          name: 'Ship of Harkinian',
          repo: 'HarbourMasters/Shipwright',
          author: 'HarbourMasters'
        })
      ]),
      t('WWF No Mercy', [
        e('nomercy', { name: 'No Mercy Recomp', repo: 'jessetbh/WWFNoMercyRecomp' })
      ]),
      t("Majora's Mask", [
        e('z64', {
          name: 'Zelda 64: Recompiled',
          repo: 'Zelda64Recomp/Zelda64Recomp',
          game: "Zelda: Majora's Mask"
        })
      ])
    ]
    const games = (q: string): string[] => searchTitles(shipwright, q).map((x) => x.game)
    // The game's title, and the title a project's own entry gives it.
    expect(games('ocarina of time')).toEqual(['The Legend of Zelda: Ocarina of Time'])
    expect(games('zelda majora')).toEqual(["Majora's Mask"])
    // The project's display name and its GitHub repository name.
    expect(games('ship of harkinian')).toEqual(['The Legend of Zelda: Ocarina of Time'])
    expect(games('shipwright')).toEqual(['The Legend of Zelda: Ocarina of Time'])
    expect(games('harbourmasters/shipwright')).toEqual(['The Legend of Zelda: Ocarina of Time'])
    expect(games('WWFNoMercyRecomp')).toEqual(['WWF No Mercy'])
    expect(games('zelda64recomp')).toEqual(["Majora's Mask"])
    expect(games('zelda 64 recompiled')).toEqual(["Majora's Mask"])
  })

  it('folds text', () => {
    expect(foldText('Zelda 64: Recompiled!')).toBe('zelda 64 recompiled')
  })
})

describe('sortTitles', () => {
  const titles = [
    t('A', [
      e('a1', { stars: 5, addedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' })
    ]),
    t('B', [
      e('b1', { stars: 900, addedAt: '2026-10-01T00:00:00Z' }),
      e('b2', { stars: 10, addedAt: '2026-11-10T00:00:00Z', recommended: true })
    ]),
    t('C', [e('c1')])
  ]
  it('orders games by their best recompilation, unknown last', () => {
    expect(sortTitles(titles, 'stars').map((x) => x.game)).toEqual(['B', 'A', 'C'])
    expect(sortTitles(titles, 'added').map((x) => x.game)).toEqual(['B', 'A', 'C'])
    expect(sortTitles(titles, 'updated').map((x) => x.game)).toEqual(['A', 'B', 'C'])
  })
  it('keeps the recommended version first, then the same order', () => {
    const b = sortTitles(titles, 'stars').find((x) => x.game === 'B')!
    expect(b.entries.map((x) => x.id)).toEqual(['b2', 'b1'])
  })
})

describe('favoriteTitles (the Favorites filter)', () => {
  it('offers All Recompilations and Favorites only', () => {
    expect(browseFilters().map((f) => f.label)).toEqual(['All Recompilations', 'Favorites'])
  })

  it('keeps only the games with a favourite, each with only its favourites', () => {
    const zelda = t('Zelda', [e('z1'), e('z2')])
    const mario = t('Mario', [e('m1')])
    const kart = t('Kart', [e('k1'), e('k2')])
    const out = favoriteTitles([zelda, mario, kart], new Set(['z2', 'k1', 'k2']))
    expect(out.map((x) => [x.game, x.entries.map((y) => y.id)])).toEqual([
      ['Zelda', ['z2']],
      ['Kart', ['k1', 'k2']]
    ])
    expect(out[1]).toBe(kart)
    expect(favoriteTitles([zelda], new Set())).toEqual([])
  })
})

describe('added recompilations', () => {
  it('marks only the ones added on this PC, with awaiting approval while they wait', () => {
    expect(addedMark(e('a'))).toBeNull()
    expect(addedMark(e('a', { added: 'local', awaiting: false }))).toEqual({
      label: 'Added by you',
      awaiting: null,
      notSent: null,
      title: null
    })
    expect(addedMark(e('a', { added: 'suggested', awaiting: true }))).toEqual({
      label: 'Added by you',
      awaiting: 'awaiting approval',
      notSent: null,
      title: null
    })
  })

  it('says when an add was not sent, and why', () => {
    const off = addedMark(e('a', { added: 'local', awaiting: false, notSent: 'off' }))!
    expect(addedMarkText(off)).toBe('Added by you · not sent')
    expect(off.title).toMatch(/Suggest my edits is off/)
    const refused = addedMark(
      e('a', { added: 'local', notSent: 'refused', refusedReason: 'no release with a download' })
    )!
    expect(addedMarkText(refused)).toBe('Added by you · not sent')
    expect(refused.title).toMatch(/refused \(no release with a download\)/)
    expect(addedMarkText(addedMark(e('a', { added: 'queued', awaiting: true }))!)).toBe(
      'Added by you · awaiting approval'
    )
  })

  it('warns that removing an add already sent does not withdraw it', () => {
    expect(removeAddedMessage(e('a', { name: 'MM', added: 'queued' }))).toMatch(/is not sent/)
    for (const added of ['suggested', 'published'] as const)
      expect(removeAddedMessage(e('a', { name: 'MM', added }))).toMatch(/does not withdraw/)
  })

  it("drops a Check's answer once the link changed (or Paste replaced it) while it ran", () => {
    const gate = createCheckGate()
    const first = gate.begin()
    expect(gate.pending()).toBe(true)
    // The user types another link: the running Check is cancelled, and a new one can start at once.
    gate.cancel()
    expect(gate.pending()).toBe(false)
    const second = gate.begin()
    expect(gate.isCurrent(first)).toBe(false)
    expect(gate.finish(first)).toBe(false)
    expect(gate.pending()).toBe(true)
    expect(gate.isCurrent(second)).toBe(true)
    expect(gate.finish(second)).toBe(true)
    expect(gate.pending()).toBe(false)
    // A finished Check's answer arriving late is not current either.
    expect(gate.isCurrent(second)).toBe(false)
  })

  it('needs a game name to add a checked repository', () => {
    expect(canAddChecked({ ok: true }, 'Doom 64')).toBe(true)
    expect(canAddChecked({ ok: true }, '   ')).toBe(false)
    expect(canAddChecked({ ok: true }, 'x'.repeat(201))).toBe(false)
  })

  it('finds the title holding a recompilation, by its id or the title key', () => {
    const titles = [t('Doom 64', [e('a')]), t('Sonic', [e('b'), e('c')])]
    expect(titleIndexOf(titles, 'c')).toEqual({ key: 'n64:sonic', index: 1 })
    expect(titleIndexOf(titles, 'n64:doom 64')).toEqual({ key: 'n64:doom 64', index: 0 })
    expect(titleIndexOf(titles, 'zzz')).toBeNull()
  })
})
