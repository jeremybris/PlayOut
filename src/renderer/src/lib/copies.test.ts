import type { Game, SourceId } from '@shared/types'
import { describe, expect, it } from 'vitest'
import { STORE_PREFERENCE, collapseCopies, copiesOf, copyKey } from './copies'

function game(id: string, patch: Partial<Game> = {}): Game {
  const title = patch.title ?? id
  return {
    id,
    source: 'steam',
    externalId: id,
    platformId: 'steam',
    title,
    sortTitle: title.toLowerCase().replace(/^the /, ''),
    installed: true,
    launch: { kind: 'uri', uri: `steam://rungameid/${id}` },
    tracking: { mode: 'none' },
    hidden: false,
    favorite: false,
    playtimeMinutes: 0,
    playCount: 0,
    addedAt: '2026-01-01T00:00:00.000Z',
    metadata: {},
    media: {},
    metadataStatus: 'none',
    user: {},
    ...patch
  }
}

/** A copy of `title` in `source`, id `${source}:${title}` unless given. */
function copy(source: SourceId, title: string, patch: Partial<Game> = {}): Game {
  return game(`${source}:${title}`, { source, platformId: source, title, ...patch })
}

/** A game with the parallel change's fields, which shared/types.ts may not declare yet. */
function withFacts(g: Game, extra: { completed?: boolean; preferredCopy?: boolean }): Game {
  const out = { ...g, user: { ...g.user } } as Game & {
    completed?: boolean
    user: { preferredCopy?: boolean }
  }
  if (extra.completed !== undefined) out.completed = extra.completed
  if (extra.preferredCopy !== undefined) out.user.preferredCopy = extra.preferredCopy
  return out
}

function ids(games: readonly Game[]): string[] {
  return games.map((g) => g.id)
}

describe('STORE_PREFERENCE', () => {
  it('ranks steam, gog, epic, xbox', () => {
    expect(STORE_PREFERENCE).toEqual(['steam', 'gog', 'epic', 'xbox'])
  })
})

describe('copyKey', () => {
  it('normalizes trademarks, accents, articles and punctuation', () => {
    expect(copyKey(game('a', { title: 'The Witcher® 3: Wild Hunt' }))).toBe('witcher 3 wild hunt')
    expect(copyKey(game('b', { title: 'Witcher 3 - Wild Hunt' }))).toBe('witcher 3 wild hunt')
    expect(copyKey(game('c', { title: 'Pokémon™ Snap' }))).toBe('pokemon snap')
    expect(copyKey(game('d', { title: 'A Plague Tale: Innocence' }))).toBe('plague tale innocence')
    expect(copyKey(game('e', { title: 'An Untitled Story' }))).toBe('untitled story')
    expect(copyKey(game('f', { title: '  ©Anthem  ' }))).toBe('anthem')
    expect(copyKey(game('g', { title: 'Theme Hospital' }))).toBe('theme hospital')
  })

  it('uses the display title', () => {
    expect(copyKey(game('a', { title: 'x', user: { titleOverride: 'Hades II' } }))).toBe('hades ii')
  })

  it('is the title for roms of the grouped systems, and null for empty titles and the other systems', () => {
    expect(copyKey(copy('rom', 'Super Metroid', { platformId: 'ps2' }))).toBe('super metroid')
    // A system that never groups (always its own card).
    expect(copyKey(copy('rom', 'Super Metroid', { platformId: 'snes' }))).toBeNull()
    expect(copyKey(game('a', { title: '' }))).toBeNull()
    expect(copyKey(game('b', { title: '™ ®' }))).toBeNull()
  })
})

describe('collapseCopies', () => {
  it('groups one title across stores, preferred store shown first', () => {
    const epic = copy('epic', 'Hades')
    const gog = copy('gog', 'HADES™')
    const steam = copy('steam', 'Hades')
    const groups = collapseCopies([epic, gog, steam])
    expect(groups).toHaveLength(1)
    expect(ids(groups[0]!.copies)).toEqual([steam.id, gog.id, epic.id])
    expect(groups[0]!.game.id).toBe(steam.id)
  })

  it('ranks other sources after the preferred stores, by id', () => {
    const groups = collapseCopies([
      copy('ubisoft', 'Anno'),
      copy('ea', 'Anno'),
      copy('xbox', 'Anno')
    ])
    expect(ids(groups[0]!.copies)).toEqual(['xbox:Anno', 'ea:Anno', 'ubisoft:Anno'])
  })

  it('never groups two copies from one source', () => {
    const a = copy('steam', 'Doom', { id: 'steam:1' })
    const b = copy('steam', 'Doom', { id: 'steam:2' })
    const c = copy('gog', 'Doom')
    const groups = collapseCopies([a, b, c])
    expect(groups.map((g) => ids(g.copies))).toEqual([[a.id, c.id], [b.id]])
  })

  it('groups PS3, PS2, GameCube, Xbox 360 and Xbox ROMs with the PC copies, never two dumps of one system', () => {
    const rom = (system: string, id: string): Game =>
      copy('rom', 'Tetris', { id: `rom:${system}:${id}`, platformId: system })
    const ps2 = rom('ps2', '1')
    const xbox = rom('xbox', '2')
    const ps2b = rom('ps2', '3')
    const steam = copy('steam', 'Tetris')
    const groups = collapseCopies([ps2, xbox, ps2b, steam])
    // Steam ranks first; the second PS2 dump is a card of its own.
    expect(groups.map((g) => ids(g.copies))).toEqual([[steam.id, ps2.id, xbox.id], [ps2b.id]])
  })

  it('always shows ROMs of the other systems (GBA, GBC, Wii, ...) on their own', () => {
    const rom = (system: string): Game =>
      copy('rom', 'Tetris', { id: `rom:${system}:t`, platformId: system })
    const gba = rom('gba')
    const gbc = rom('gbc')
    const wii = rom('wii')
    const steam = copy('steam', 'Tetris')
    const groups = collapseCopies([gba, gbc, wii, steam])
    expect(groups.map((g) => ids(g.copies))).toEqual([[gba.id], [gbc.id], [wii.id], [steam.id]])
    expect(copyKey(gba)).toBeNull()
  })

  it('shows a copy with a recompilation first, then Steam > GOG > Epic > PS3 > PS2 > GameCube > Xbox 360 > Xbox > other stores', () => {
    const rom = (system: string, patch: Partial<Game> = {}): Game =>
      copy('rom', 'Spider-Man 2', { id: `rom:${system}:sm2`, platformId: system, ...patch })
    const recomp = {
      titleKey: 'ps2:spider man 2',
      count: 1,
      installed: [],
      preferred: 'x',
      updatedAt: ''
    }
    const xbox = rom('xbox')
    const x360 = rom('xbox360')
    const ps2 = rom('ps2')
    const gc = rom('gc')
    const ps3 = rom('ps3')
    const steam = copy('steam', 'Spider-Man 2')
    const gog = copy('gog', 'Spider-Man 2')
    const epic = copy('epic', 'Spider-Man 2')
    const xboxApp = copy('xbox', 'Spider-Man 2')
    const ea = copy('ea', 'Spider-Man 2')
    const order = (games: Game[]): string[] => ids(collapseCopies(games)[0]!.copies)
    expect(order([ea, xbox, x360, gc, ps2, ps3, xboxApp, epic, gog, steam])).toEqual([
      steam.id,
      gog.id,
      epic.id,
      ps3.id,
      ps2.id,
      gc.id,
      x360.id,
      xbox.id,
      xboxApp.id,
      ea.id
    ])
    // The user's example: Xbox, PS2, Steam and a recompilation (of the PS2 game): the recompilation's copy is shown.
    const ps2Recomp = rom('ps2', { metadata: { recomp } })
    const groups = collapseCopies([xbox, ps2Recomp, steam])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.game.id).toBe(ps2Recomp.id)
    // An installed recompilation beats one only available.
    const ps3Installed = rom('ps3', { metadata: { recomp: { ...recomp, installed: ['x'] } } })
    expect(order([ps2Recomp, ps3Installed, steam])[0]).toBe(ps3Installed.id)
    // The user's own choice of copy still wins.
    expect(order([ps2Recomp, withFacts(xbox, { preferredCopy: true })])[0]).toBe(xbox.id)
  })

  it('always shows a favourite on its own: it never hides behind another copy, nor another behind it', () => {
    const steam = copy('steam', 'Portal')
    const gog = copy('gog', 'Portal', { favorite: true })
    const epic = copy('epic', 'Portal')
    const groups = collapseCopies([epic, gog, steam])
    expect(groups.map((g) => ids(g.copies))).toEqual([[steam.id, epic.id], [gog.id]])
    expect(copyKey(gog)).toBeNull()
  })

  it('groups a console original with a much later PC port (the year check is between PC copies)', () => {
    const x360 = copy('rom', 'Bayonetta', {
      id: 'rom:xbox360:b',
      platformId: 'xbox360',
      metadata: { releaseDate: '2009-10-29' }
    })
    const steam = copy('steam', 'Bayonetta', { metadata: { releaseDate: '2017-04-11' } })
    const groups = collapseCopies([x360, steam])
    expect(groups.map((g) => ids(g.copies))).toEqual([[steam.id, x360.id]])
  })

  it('with Show duplicates on, groups only PC store copies (Steam > GOG > Epic > Xbox), every ROM on its own', () => {
    const recomp = { titleKey: 'k', count: 1, installed: ['x'], preferred: 'x', updatedAt: '' }
    const ps2 = copy('rom', 'Spider-Man 2', {
      id: 'rom:ps2:sm2',
      platformId: 'ps2',
      metadata: { recomp }
    })
    const xbox = copy('rom', 'Spider-Man 2', { id: 'rom:xbox:sm2', platformId: 'xbox' })
    const xboxApp = copy('xbox', 'Spider-Man 2')
    const epic = copy('epic', 'Spider-Man 2')
    const groups = collapseCopies([ps2, xbox, xboxApp, epic], { showDuplicates: true })
    expect(groups.map((g) => ids(g.copies))).toEqual([[ps2.id], [xbox.id], [epic.id, xboxApp.id]])
    // Off (default): one card, the recompilation's copy shown.
    expect(collapseCopies([ps2, xbox, xboxApp, epic]).map((g) => g.game.id)).toEqual([ps2.id])
  })

  it('keeps releases more than a year apart separate', () => {
    const doom93 = copy('gog', 'DOOM', { metadata: { releaseDate: '1993-12-10' } })
    const doom16 = copy('steam', 'Doom', { metadata: { releaseDate: '2016-05-13' } })
    const epic16 = copy('epic', 'DOOM', { metadata: { releaseDate: '2017' } })
    const xbox = copy('xbox', 'Doom')
    const groups = collapseCopies([doom93, doom16, epic16, xbox])
    expect(groups.map((g) => ids(g.copies))).toEqual([
      [doom93.id, xbox.id],
      [doom16.id, epic16.id]
    ])
  })

  it('shows the user-preferred copy, the first one when several', () => {
    const steam = copy('steam', 'Celeste')
    const epic = withFacts(copy('epic', 'Celeste'), { preferredCopy: true })
    const xbox = withFacts(copy('xbox', 'Celeste'), { preferredCopy: true })
    const gog = copy('gog', 'Celeste')
    const groups = collapseCopies([steam, xbox, epic, gog])
    expect(ids(groups[0]!.copies)).toEqual([xbox.id, steam.id, gog.id, epic.id])
    expect(groups[0]!.game.id).toBe(xbox.id)
  })

  it('breaks preference ties by installed, then id', () => {
    const a = copy('ea', 'Inside', { installed: false })
    const b = copy('ubisoft', 'Inside', { installed: true })
    const c = copy('battlenet', 'Inside', { installed: false })
    const groups = collapseCopies([a, b, c])
    expect(ids(groups[0]!.copies)).toEqual([b.id, c.id, a.id])
  })

  it('merges the group facts into the shown copy', () => {
    const steam = copy('steam', 'Portal', {
      lastPlayed: '2026-03-01T00:00:00.000Z',
      addedAt: '2025-06-01T00:00:00.000Z',
      playtimeMinutes: 30,
      storePlaytimeMinutes: 100
    })
    const gog = withFacts(
      copy('gog', 'Portal', {
        lastPlayed: '2026-10-01T00:00:00.000Z',
        addedAt: '2024-01-01T00:00:00.000Z',
        playtimeMinutes: 15
      }),
      { completed: true }
    )
    const epic = copy('epic', 'Portal', {
      addedAt: '',
      playtimeMinutes: 5,
      storePlaytimeMinutes: 20
    })
    const [group] = collapseCopies([epic, gog, steam])
    const merged = group!.game as Game & { completed?: boolean }
    expect(merged.id).toBe(steam.id)
    expect(merged.lastPlayed).toBe('2026-10-01T00:00:00.000Z')
    expect(merged.addedAt).toBe('2024-01-01T00:00:00.000Z')
    expect(merged.playtimeMinutes).toBe(50)
    expect(merged.storePlaytimeMinutes).toBe(120)
    expect(merged.favorite).toBe(false)
    expect(merged.completed).toBe(true)
    expect(steam.favorite).toBe(false)
    expect(steam.playtimeMinutes).toBe(30)
  })

  it('leaves merged facts empty when no copy has them', () => {
    const [group] = collapseCopies([copy('steam', 'Limbo'), copy('gog', 'Limbo')])
    const merged = group!.game as Game & { completed?: boolean }
    expect(merged.lastPlayed).toBeUndefined()
    expect(merged.storePlaytimeMinutes).toBeUndefined()
    expect(merged.favorite).toBe(false)
    expect('completed' in merged).toBe(false)
  })

  it('returns the same object for a single copy', () => {
    const solo = copy('gog', 'Outer Wilds', { favorite: true })
    const [group] = collapseCopies([solo])
    expect(group!.game).toBe(solo)
    expect(group!.copies).toEqual([solo])
  })

  it('keeps the order of each group’s first member', () => {
    const groups = collapseCopies([
      copy('epic', 'Zeta'),
      copy('steam', 'Alpha'),
      copy('rom', 'Mario'),
      copy('gog', 'Zeta'),
      copy('gog', 'Beta'),
      copy('xbox', 'Alpha')
    ])
    expect(groups.map((g) => g.copies.length)).toEqual([2, 2, 1, 1])
    expect(groups.map((g) => g.game.title)).toEqual(['Zeta', 'Alpha', 'Mario', 'Beta'])
  })

  it('returns nothing for an empty library', () => {
    expect(collapseCopies([])).toEqual([])
  })
})

describe('copiesOf', () => {
  const steam = copy('steam', 'Hollow Knight')
  const gog = copy('gog', 'Hollow Knight')
  const solo = copy('epic', 'Control')
  const games = [gog, solo, steam]

  it('returns every copy of the group holding the game', () => {
    expect(ids(copiesOf(games, gog.id))).toEqual([steam.id, gog.id])
    expect(ids(copiesOf(games, steam.id))).toEqual([steam.id, gog.id])
  })

  it('returns the game alone when ungrouped, nothing when unknown', () => {
    expect(copiesOf(games, solo.id)).toEqual([solo])
    expect(copiesOf(games, 'nope')).toEqual([])
  })
})

describe('copyKey keeps marks that are part of a script', () => {
  it('does not merge different Devanagari or kana titles', () => {
    const g = (title: string): Game =>
      ({ id: `steam:${title}`, source: 'steam', title, user: {} }) as unknown as Game
    expect(copyKey(g('हिंदी'))).not.toBe(copyKey(g('हैदा')))
    expect(copyKey(g('ガンダム'))).not.toContain(' ')
  })
})

describe('collapseCopies: ROMs of one title on several consoles', () => {
  const rom = (system: string, year: string | undefined, igdb?: string, title = 'SSX'): Game =>
    game(`rom:${system}:${title}`, {
      source: 'rom',
      platformId: system,
      title,
      metadata: {
        ...(year ? { releaseDate: `${year}-02-28` } : {}),
        ...(igdb ? { sources: { igdb } } : {})
      }
    })
  // The library's own three records: the 2012 game on two consoles, the game of 2000 on the PlayStation 2.
  const PS3 = rom('ps3', '2012', '4179')
  const X360 = rom('xbox360', '2012', '4179')
  const PS2 = rom('ps2', '2000', '4175')

  it('keeps the 2000 game on a card of its own, whatever the order', () => {
    for (const order of [
      [PS3, PS2, X360],
      [PS2, PS3, X360],
      [X360, PS2, PS3]
    ]) {
      const groups = collapseCopies(order)
      expect(groups.map((g) => ids(g.copies).sort())).toEqual(
        expect.arrayContaining([['rom:ps2:SSX'], ['rom:ps3:SSX', 'rom:xbox360:SSX']])
      )
      expect(groups).toHaveLength(2)
      const reboot = groups.find((g) => g.copies.length === 2)!
      expect(reboot.game.id).toBe('rom:ps3:SSX')
      expect(reboot.game.metadata.releaseDate).toBe('2012-02-28')
    }
  })

  it('still groups the same game across consoles: one IGDB game, or years close, or a year unknown', () => {
    // Dated per console by the source, but one IGDB game.
    expect(collapseCopies([rom('ps2', '2006', '55'), rom('xbox360', '2010', '55')])).toHaveLength(1)
    // A port a year or two later, matched by different sources.
    expect(collapseCopies([rom('ps2', '2005'), rom('ps3', '2007', '9')])).toHaveLength(1)
    // Two IGDB records (one an edition's, say) of the same years: still one game.
    expect(collapseCopies([rom('ps3', '2012', '1'), rom('xbox360', '2013', '2')])).toHaveLength(1)
    // Not scraped yet: by title, as before.
    expect(collapseCopies([rom('ps2', undefined), rom('ps3', '2012', '4179')])).toHaveLength(1)
    expect(collapseCopies([rom('gc', undefined), rom('xbox', undefined)])).toHaveLength(1)
  })

  it('does not split ports by their years alone: without two IGDB games they are one card', () => {
    // ScreenScraper and TheGamesDB date a game per console; IGDB is optional. (Only these systems group at all.)
    const re4 = (system: string, year: string, igdb?: string): Game =>
      rom(system, year, igdb, 'Resident Evil 4')
    expect(
      collapseCopies([
        re4('gc', '2005'),
        re4('ps2', '2005'),
        re4('ps3', '2011'),
        re4('xbox360', '2016')
      ])
    ).toHaveLength(1)
    expect(
      collapseCopies([
        rom('ps2', '2006', undefined, 'Okami'),
        rom('ps3', '2012', undefined, 'Okami')
      ])
    ).toHaveLength(1)
    // One of them matched by IGDB, the other not: nothing says they are two games.
    for (const order of [
      [re4('gc', '2005', '1'), re4('ps3', '2011')],
      [re4('ps3', '2011'), re4('gc', '2005', '1')]
    ])
      expect(collapseCopies(order)).toHaveLength(1)
    // Two IGDB games years apart are two cards; the unmatched copy joins the first of them.
    const groups = collapseCopies([PS2, rom('gc', '2001'), PS3])
    expect(groups.map((g) => ids(g.copies).sort())).toEqual([
      ['rom:gc:SSX', 'rom:ps2:SSX'],
      ['rom:ps3:SSX']
    ])
  })

  it('leaves a console game and its PC port of years later on one card', () => {
    const steam = copy('steam', 'Bayonetta', { metadata: { releaseDate: '2017-04-11' } })
    const groups = collapseCopies([rom('xbox360', '2009', '1', 'Bayonetta'), steam])
    expect(groups).toHaveLength(1)
    expect(ids(groups[0].copies)).toEqual(['steam:Bayonetta', 'rom:xbox360:Bayonetta'])
  })
})
