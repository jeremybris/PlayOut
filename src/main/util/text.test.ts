import { describe, expect, it } from 'vitest'
import { cleanRomTitle, formatHours, sortTitle } from './text'

describe('sortTitle', () => {
  it('drops a leading article and punctuation', () => {
    expect(sortTitle('The Legend of Zelda: A Link to the Past')).toBe(
      'legend of zelda a link to the past'
    )
    expect(sortTitle('A Hat in Time')).toBe('hat in time')
    expect(sortTitle('Half-Life 2')).toBe('half life 2')
  })
})

describe('cleanRomTitle', () => {
  it('removes the extension and moves tags out of the title', () => {
    expect(cleanRomTitle('Super Mario World (USA) [!].sfc')).toEqual({
      title: 'Super Mario World',
      tags: ['USA', '!']
    })
  })
  it('fixes trailing articles and underscores', () => {
    expect(cleanRomTitle('Legend_of_Zelda,_The_(Europe).zip').title).toBe('The Legend of Zelda')
  })
  it('keeps directory names when told not to strip extensions', () => {
    expect(cleanRomTitle('Shadow of the Colossus.ps3', false).title).toBe(
      'Shadow of the Colossus.ps3'
    )
  })
  it('drops the dash left in front of removed tags', () => {
    expect(cleanRomTitle('DRIVECLUB - [EU] [EN] [1.28]', false)).toEqual({
      title: 'DRIVECLUB',
      tags: ['EU', 'EN', '1.28']
    })
    expect(cleanRomTitle('Game - (USA).sfc').title).toBe('Game')
    expect(cleanRomTitle('Spider-Man.sfc').title).toBe('Spider-Man')
  })

  it("leaves a trimmed Xbox image's .xiso out of the title", () => {
    expect(cleanRomTitle('007 - From Russia with Love (USA).xiso.iso')).toEqual({
      title: '007 - From Russia with Love',
      tags: ['USA']
    })
    expect(cleanRomTitle('Halo (USA) (trimmed).xiso.iso')).toEqual({
      title: 'Halo',
      tags: ['USA', 'trimmed']
    })
    expect(cleanRomTitle('Halo.XISO.ISO').title).toBe('Halo')
    expect(cleanRomTitle('Halo (USA).iso').title).toBe('Halo')
    expect(cleanRomTitle('Halo.xiso').title).toBe('Halo')
    // Only a trailing .xiso part, and never the whole name.
    expect(cleanRomTitle('Xiso Racer.iso').title).toBe('Xiso Racer')
    expect(cleanRomTitle('.xiso.iso').title).toBe('.xiso')
  })
})

describe('formatHours', () => {
  it('formats minutes', () => {
    expect(formatHours(0)).toBe('0 hours')
    expect(formatHours(30)).toBe('30 min')
    expect(formatHours(1176)).toBe('19.6 hours')
    expect(formatHours(120)).toBe('2 hours')
  })
})
