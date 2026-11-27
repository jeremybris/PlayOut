import { describe, expect, it } from 'vitest'
import type { MetadataCandidate } from '../../shared/types'
import {
  candidateScore,
  MIN_CANDIDATE_SIMILARITY,
  pickCandidate,
  searchVariantsFor,
  titleMatch,
  withoutBrand
} from './candidate-match'

const c = (title: string, extra: Partial<MetadataCandidate> = {}): MetadataCandidate => ({
  scraper: 'steamgriddb',
  externalId: title,
  title,
  ...extra
})

// SteamGridDB's real answers (autocomplete) for ROM names of the user's library.
const NICKELODEON = [
  'Nickelodeon GUTS',
  'Nickelodeon Kart Racers 2: Grand Prix',
  'Nickelodeon All-Star Brawl',
  'Nickelodeon Party Blast'
].map((t) => c(t))
const RUGRATS = [
  'Rugrats: Search for Reptar',
  'Rugrats: Scavenger Hunt',
  'Rugrats: Totally Angelica',
  'Rugrats Go Wild'
].map((t) => c(t))

describe('pickCandidate', () => {
  it('never takes a first hit that is another game', () => {
    expect(pickCandidate(NICKELODEON, 'Nickelodeon Rugrats - Search for Reptar')).toBeUndefined()
  })

  it('takes the result that is the game, wherever it is in the list', () => {
    expect(pickCandidate(RUGRATS, 'Nickelodeon Rugrats - Search for Reptar')?.title).toBe(
      'Rugrats: Search for Reptar'
    )
    expect(
      pickCandidate([...RUGRATS].reverse(), 'Nickelodeon Rugrats - Totally Angelica')?.title
    ).toBe('Rugrats: Totally Angelica')
  })

  it('keeps sequels apart', () => {
    expect(
      pickCandidate(
        [c("Donkey Kong Country 3: Dixie Kong's Double Trouble!"), c('Donkey Kong Country')],
        'Donkey Kong Country 3'
      )?.title
    ).toBe("Donkey Kong Country 3: Dixie Kong's Double Trouble!")
    expect(pickCandidate([c('BRAINDEAD'), c('Brain Dead 13')], 'BrainDead 13')?.title).toBe(
      'Brain Dead 13'
    )
    expect(pickCandidate([c('Final Fantasy VIII')], 'Final Fantasy VII')).toBeUndefined()
    // A source may leave the number out when the whole subtitle names the game.
    expect(
      pickCandidate(
        [c("Disney's The Lion King"), c("Disney's The Lion King: Simba's Mighty Adventure")],
        "Disney's The Lion King II - Simba's Mighty Adventure"
      )?.title
    ).toBe("Disney's The Lion King: Simba's Mighty Adventure")
    // A source may leave the number out when the subtitle names the game.
    expect(
      pickCandidate(
        [c("Disney's The Lion King"), c("Disney's The Lion King: Simba's Mighty Adventure")],
        "Disney's The Lion King II - Simba's Mighty Adventure"
      )?.title
    ).toBe("Disney's The Lion King: Simba's Mighty Adventure")
    expect(pickCandidate([c('Final Fantasy VII')], 'Final Fantasy 7')?.title).toBe(
      'Final Fantasy VII'
    )
  })

  it("follows the source's order between results about as close", () => {
    expect(
      pickCandidate(
        [c('Pokémon Emerald Version'), c('Pokémon Emerald Enhanced')],
        'Pokemon Emerald'
      )?.title
    ).toBe('Pokémon Emerald Version')
  })

  it('uses a result found by the game’s own id as it is', () => {
    expect(pickCandidate([c('Something Else', { byId: true })], 'Portal 2')?.title).toBe(
      'Something Else'
    )
  })

  it('matches a result with a licensor the game title leaves out', () => {
    expect(pickCandidate([c("Disney's Aladdin")], 'Aladdin')?.title).toBe("Disney's Aladdin")
    expect(pickCandidate([c("Sid Meier's Pirates!")], 'Pirates!')?.title).toBe(
      "Sid Meier's Pirates!"
    )
  })

  it('matches a result whose franchise in front carries the number', () => {
    expect(pickCandidate([c('The Elder Scrolls V: Skyrim')], 'Skyrim')?.title).toBe(
      'The Elder Scrolls V: Skyrim'
    )
    expect(pickCandidate([c('The Elder Scrolls III: Morrowind')], 'Morrowind')?.title).toBe(
      'The Elder Scrolls III: Morrowind'
    )
  })

  it('prefers the result that is the title word for word in a near tie', () => {
    expect(pickCandidate([c('Rayman: Raving Rabbids'), c('Rayman')], 'Rayman')?.title).toBe(
      'Rayman'
    )
  })

  it("counts a match on one of the source's other names", () => {
    expect(
      pickCandidate([c('Biohazard', { altTitles: ['Resident Evil'] })], 'Resident Evil')?.title
    ).toBe('Biohazard')
  })

  it('keeps the source’s first result for a title with nothing to compare (non-Latin)', () => {
    expect(
      pickCandidate([c('ファイナルファンタジー'), c('Other')], 'ファイナルファンタジー')?.title
    ).toBe('ファイナルファンタジー')
    expect(pickCandidate([c('Ведьмак')], 'Ведьмак')?.title).toBe('Ведьмак')
  })

  it('finds nothing in an empty answer', () => {
    expect(pickCandidate([], 'Portal 2')).toBeUndefined()
  })
})

describe('candidateScore', () => {
  it('scores the game well above the threshold and other games well below', () => {
    const wanted = 'Disney-Pixar Toy Story 2 - Buzz Lightyear to the Rescue!'
    expect(candidateScore(wanted, 'Toy Story 2: Buzz Lightyear to the Rescue!')).toBeGreaterThan(
      0.9
    )
    expect(candidateScore(wanted, 'Disney•Pixar Brave: The Video Game')).toBeLessThan(
      MIN_CANDIDATE_SIMILARITY
    )
    expect(
      candidateScore('Nickelodeon Rugrats - Search for Reptar', 'Nickelodeon GUTS')
    ).toBeLessThan(MIN_CANDIDATE_SIMILARITY)
  })
})

describe('searchVariantsFor', () => {
  it('tries the ROM-set name, then without its brand, then the part before the subtitle', () => {
    expect(searchVariantsFor('Nickelodeon Rugrats - Search for Reptar')).toEqual([
      'Nickelodeon Rugrats - Search for Reptar',
      'Rugrats: Search for Reptar',
      'Rugrats'
    ])
    expect(searchVariantsFor('Portal 2')).toEqual(['Portal 2'])
  })

  it('knows the licensors ROM sets put in front', () => {
    expect(withoutBrand("Disney-Pixar A Bug's Life")).toBe("A Bug's Life")
    expect(withoutBrand("Tom Clancy's Splinter Cell")).toBe('Splinter Cell')
    expect(withoutBrand('Portal 2')).toBeUndefined()
  })

  it('never takes a remaster or remake for its original, nor the other way round', () => {
    const c = (title: string, i = 0): MetadataCandidate => ({
      scraper: 'steamgriddb',
      externalId: String(i),
      title
    })
    expect(
      pickCandidate(
        [c('Shrek 2'), c('Shrek 2: Beg for Mercy!', 1)],
        'DreamWorks Shrek 2 Remastered'
      )
    ).toBeUndefined()
    expect(pickCandidate([c('Dark Souls')], 'Dark Souls: Remastered')).toBeUndefined()
    expect(pickCandidate([c('Resident Evil 2 Remake')], 'Resident Evil 2')).toBeUndefined()
    expect(pickCandidate([c('Dark Souls: Remastered')], 'DARK SOULS™: REMASTERED')?.title).toBe(
      'Dark Souls: Remastered'
    )
    // An edition is still the same game.
    expect(
      pickCandidate(
        [c('The Elder Scrolls V: Skyrim')],
        'The Elder Scrolls V: Skyrim Special Edition'
      )?.externalId
    ).toBe('0')
  })
})

describe('pickCandidate: same title, another year', () => {
  const c = (externalId: string, releaseDate?: string): MetadataCandidate => ({
    scraper: 'steamgriddb',
    externalId,
    title: 'SSX',
    ...(releaseDate ? { releaseDate } : {})
  })
  it('takes the one released closest to the game’s year', () => {
    const list = [c('2000', '2000-10-26'), c('2012', '2012-02-28')]
    expect(pickCandidate(list, 'SSX', 2012)?.externalId).toBe('2012')
    expect(pickCandidate(list, 'SSX', 2001)?.externalId).toBe('2000')
  })
  it('keeps the first without a year, and never prefers a worse title for its year', () => {
    const list = [c('2000', '2000-10-26'), c('2012', '2012-02-28')]
    expect(pickCandidate(list, 'SSX')?.externalId).toBe('2000')
    const tricky: MetadataCandidate = {
      scraper: 'steamgriddb',
      externalId: 't',
      title: 'SSX Tricky',
      releaseDate: '2012-01-01'
    }
    expect(pickCandidate([c('2000', '2000-10-26'), tricky], 'SSX', 2012)?.externalId).toBe('2000')
  })
  it('leaves the source’s first unless another is within two years and it is not', () => {
    expect(pickCandidate([c('none'), c('2012', '2012-02-28')], 'SSX', 2012)?.externalId).toBe(
      '2012'
    )
    // A date known to be years off loses to an unknown one of the same title (SteamGridDB dates only some games).
    expect(pickCandidate([c('2000', '2000-10-26'), c('none')], 'SSX', 2012)?.externalId).toBe(
      'none'
    )
    expect(pickCandidate([c('none'), c('2000', '2000-10-26')], 'SSX', 2012)?.externalId).toBe(
      'none'
    )
    // Not to a result that is only close to the title, and not when a dated one fits.
    const tricky: MetadataCandidate = { scraper: 'steamgriddb', externalId: 't', title: 'SSX 3' }
    expect(pickCandidate([c('2000', '2000-10-26'), tricky], 'SSX', 2012)?.externalId).toBe('2000')
    expect(
      pickCandidate([c('2000', '2000-10-26'), c('none'), c('2012', '2012-02-28')], 'SSX', 2012)
        ?.externalId
    ).toBe('2012')
    // A 1999 port of a 1989 game with a 2008 reboot of the same name: neither is near, the source's first stays.
    expect(
      pickCandidate([c('1989', '1989-10-03'), c('2008', '2008-12-02')], 'SSX', 1999)?.externalId
    ).toBe('1989')
    // The first is near enough: it stays, even with an exact-year one further down.
    expect(
      pickCandidate([c('2011', '2011-11-01'), c('2012', '2012-02-28')], 'SSX', 2012)?.externalId
    ).toBe('2011')
  })
})

describe("pickCandidate: a game's own record before an edition of it", () => {
  // IGDB's records for the Switch game (search filtered to the Switch), the edition first as IGDB listed it.
  const LIMITED: MetadataCandidate = {
    scraper: 'igdb',
    externalId: '134231',
    title: "The Legend of Zelda: Link's Awakening - Limited Edition",
    releaseDate: '2019-09-20',
    platformIds: [130]
  }
  const OWN: MetadataCandidate = {
    scraper: 'igdb',
    externalId: '113113',
    title: "The Legend of Zelda: Link's Awakening",
    releaseDate: '2019-09-20',
    platformIds: [130]
  }
  const DREAMER: MetadataCandidate = {
    scraper: 'igdb',
    externalId: '134232',
    title: "The Legend of Zelda: Link's Awakening - Dreamer Edition",
    releaseDate: '2019-09-20',
    platformIds: [130]
  }
  const ROM = "The Legend of Zelda Link's Awakening"

  it('takes the game itself whatever the order, with and without the year', () => {
    for (const list of [
      [LIMITED, OWN, DREAMER],
      [OWN, LIMITED, DREAMER],
      [DREAMER, LIMITED, OWN]
    ])
      for (const year of [undefined, 2019])
        expect(pickCandidate(list, ROM, year)?.externalId).toBe('113113')
  })
  it('still takes the edition when the source has no record of the game itself', () => {
    expect(pickCandidate([LIMITED, DREAMER], ROM, 2019)?.externalId).toBe('134231')
  })
  it('takes the edition for a game that names it', () => {
    expect(pickCandidate([OWN, LIMITED], `${ROM} Limited Edition`, 2019)?.externalId).toBe('134231')
    expect(titleMatch(ROM, LIMITED.title)).toEqual({ exact: true, own: false })
    expect(titleMatch(ROM, OWN.title)).toEqual({ exact: true, own: true })
    expect(titleMatch(`${ROM} Limited Edition`, LIMITED.title)).toEqual({ exact: true, own: true })
  })
  it('takes the edition when the game’s year speaks for it and against the game’s own record', () => {
    const game = (title: string, date: string, platformIds?: number[]): MetadataCandidate => ({
      scraper: 'steamgriddb',
      externalId: title,
      title,
      releaseDate: date,
      ...(platformIds ? { platformIds } : {})
    })
    // A ROM or store name without the edition words, whose text year is the edition's.
    const metro = [game('Metro 2033', '2010-03-16'), game('Metro 2033 Redux', '2014-08-26')]
    expect(pickCandidate(metro, 'Metro 2033', 2014)?.title).toBe('Metro 2033 Redux')
    expect(pickCandidate(metro, 'Metro 2033', 2010)?.title).toBe('Metro 2033')
    expect(pickCandidate(metro, 'Metro 2033')?.title).toBe('Metro 2033')
    const vesperia = [
      game('Tales of Vesperia', '2008-08-07'),
      game('Tales of Vesperia: Definitive Edition', '2019-01-11')
    ]
    for (const list of [vesperia, [...vesperia].reverse()]) {
      expect(pickCandidate(list, 'Tales of Vesperia', 2019, { era: { from: 2017 } })?.title).toBe(
        'Tales of Vesperia: Definitive Edition'
      )
      expect(pickCandidate(list, 'Tales of Vesperia', 2008)?.title).toBe('Tales of Vesperia')
    }
    const okami = [game('Okami', '2006-04-20'), game('Okami HD', '2017-12-12')]
    expect(pickCandidate(okami, 'Okami', 2018)?.title).toBe('Okami HD')
    // No year yet: the console's years speak (a Switch folder), and a PlayStation 2 folder's for the game of 2006.
    expect(pickCandidate(okami, 'Okami', undefined, { era: { from: 2017 } })?.title).toBe(
      'Okami HD'
    )
    expect(pickCandidate(okami, 'Okami', undefined, { era: { from: 2000, to: 2013 } })?.title).toBe(
      'Okami'
    )
    // A year near neither keeps the game's own record, as does an own record without a date.
    expect(pickCandidate(okami, 'Okami', 1999)?.title).toBe('Okami')
    const undated = [{ ...okami[0]!, releaseDate: undefined }, okami[1]!]
    expect(pickCandidate(undated, 'Okami', undefined, { era: { from: 2017 } })?.title).toBe('Okami')
    // The source lists only the edition on the game's console.
    const listed = [game('Okami', '2006-04-20', [8]), game('Okami HD', '2006-04-20', [130])]
    expect(pickCandidate(listed, 'Okami', undefined, { platformId: 130 })?.title).toBe('Okami HD')
    expect(pickCandidate(listed, 'Okami', undefined, { platformId: 8 })?.title).toBe('Okami')
    // The reported game: same date, same console, so the game's own record.
    expect(
      pickCandidate([LIMITED, OWN], ROM, 2019, { platformId: 130, era: { from: 2017 } })?.externalId
    ).toBe('113113')
  })
  it('does not take two titles with nothing to compare for the same title', () => {
    expect(titleMatch('ポケットモンスター 赤', 'ゼルダの伝説')).toEqual({
      exact: false,
      own: false
    })
    expect(titleMatch('ポケットモンスター 赤', 'ポケットモンスター 赤')).toEqual({
      exact: false,
      own: false
    })
    expect(titleMatch('Okami', '大神')).toEqual({ exact: false, own: false })
  })
  it('counts an other name of the record as its own title', () => {
    const regional: MetadataCandidate = {
      ...OWN,
      title: 'Zelda no Densetsu: Yume o Miru Shima',
      altTitles: ["The Legend of Zelda: Link's Awakening"]
    }
    expect(pickCandidate([LIMITED, regional], ROM)?.externalId).toBe('113113')
  })
})

describe('pickCandidate: the console the game was found on', () => {
  const ssx = (
    externalId: string,
    releaseDate: string | undefined,
    platformIds?: number[]
  ): MetadataCandidate => ({
    scraper: 'steamgriddb',
    externalId,
    title: 'SSX',
    ...(releaseDate ? { releaseDate } : {}),
    ...(platformIds ? { platformIds } : {})
  })
  // SteamGridDB's order: the older game first.
  const SGDB = [ssx('38268', '2000-10-26'), ssx('5404410', '2012-02-28')]
  const PS2 = { from: 2000, to: 2013 }
  const PS3 = { from: 2006, to: 2017 }
  const SWITCH = { from: 2017 }
  const GB = { from: 1989, to: 2001 }

  it('takes the game from the console’s years while the game’s year is not known', () => {
    expect(pickCandidate(SGDB, 'SSX', undefined, { era: PS3 })?.externalId).toBe('5404410')
    expect(pickCandidate(SGDB, 'SSX', undefined, { era: PS2 })?.externalId).toBe('38268')
    expect(pickCandidate(SGDB, 'SSX')?.externalId).toBe('38268')
    const zelda = (id: string, title: string, date: string): MetadataCandidate => ({
      scraper: 'steamgriddb',
      externalId: id,
      title,
      releaseDate: date
    })
    const list = [
      zelda('1993', "The Legend of Zelda: Link's Awakening", '1993-06-06'),
      zelda('dx', "The Legend of Zelda: Link's Awakening DX", '1998-12-12'),
      zelda('2019', "The Legend of Zelda: Link's Awakening", '2019-09-20')
    ]
    const rom = "The Legend of Zelda Link's Awakening"
    expect(pickCandidate(list, rom, undefined, { era: SWITCH })?.externalId).toBe('2019')
    expect(pickCandidate(list, rom, undefined, { era: GB })?.externalId).toBe('1993')
    expect(pickCandidate([...list].reverse(), rom, undefined, { era: GB })?.externalId).toBe('1993')
  })
  it('goes by the game’s own year when it is known, not by the console’s', () => {
    // A PlayStation 2 classic re-released on the PlayStation 3: the text source said 2000.
    expect(pickCandidate(SGDB, 'SSX', 2000, { era: PS3 })?.externalId).toBe('38268')
  })
  it('cannot tell two same-titled games that both fall in the console’s years apart: the source’s first, until the year is known', () => {
    // The PlayStation 2 had new games until 2013, so the 2012 "SSX" counts as one of its; the newer game first.
    const newerFirst = [...SGDB].reverse()
    expect(pickCandidate(newerFirst, 'SSX', undefined, { era: PS2 })?.externalId).toBe('5404410')
    expect(pickCandidate(newerFirst, 'SSX', 2000, { era: PS2 })?.externalId).toBe('38268')
    expect(pickCandidate(newerFirst, 'SSX', undefined, { era: PS3 })?.externalId).toBe('5404410')
  })
  it('keeps the source’s first when none is from the console’s years; a first with no date gives way to one that is', () => {
    // A late port: the only same-titled games are older than the console.
    const old = [ssx('a', '1991-01-01'), ssx('b', '1995-01-01')]
    expect(pickCandidate(old, 'SSX', undefined, { era: SWITCH })?.externalId).toBe('a')
    expect(
      pickCandidate([ssx('none', undefined), SGDB[1]!], 'SSX', undefined, { era: PS3 })?.externalId
    ).toBe('5404410')
    expect(
      pickCandidate([ssx('none', undefined), SGDB[0]!], 'SSX', undefined, { era: PS3 })?.externalId
    ).toBe('none')
    expect(pickCandidate([ssx('none', undefined), SGDB[1]!], 'SSX')?.externalId).toBe('none')
    // A first result dated outside the console's years loses to a same-titled one without a date, in either order;
    // within the console's years it stays.
    expect(
      pickCandidate([SGDB[0]!, ssx('none', undefined)], 'SSX', undefined, { era: PS3 })?.externalId
    ).toBe('none')
    expect(
      pickCandidate([SGDB[1]!, ssx('none', undefined)], 'SSX', undefined, { era: PS2 })?.externalId
    ).toBe('5404410')
    expect(
      pickCandidate([SGDB[0]!, ssx('none', undefined)], 'SSX', undefined, { era: PS2 })?.externalId
    ).toBe('38268')
    // One result only is never rejected for its year.
    expect(pickCandidate([SGDB[0]!], 'SSX', undefined, { era: PS3 })?.externalId).toBe('38268')
  })
  it('takes a result the source lists on the console before one it does not', () => {
    // An unfiltered search (a source whose console filter did not hold): the PlayStation 2 game first.
    const list = [ssx('4175', '2000-10-26', [8]), ssx('4179', '2012-02-28', [9, 12])]
    expect(pickCandidate(list, 'SSX', undefined, { platformId: 9 })?.externalId).toBe('4179')
    expect(pickCandidate(list, 'SSX', undefined, { platformId: 8 })?.externalId).toBe('4175')
    // No result on the console (the source's lists have gaps): as without it.
    expect(pickCandidate(list, 'SSX', undefined, { platformId: 130 })?.externalId).toBe('4175')
    // Never a worse title for its console.
    const tricky = { ...ssx('t', '2001-11-05', [9]), title: 'SSX Tricky' }
    expect(pickCandidate([list[0]!, tricky], 'SSX', undefined, { platformId: 9 })?.externalId).toBe(
      '4175'
    )
  })
})
