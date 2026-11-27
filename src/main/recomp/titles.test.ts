import { describe, expect, it } from 'vitest'
import { normalizeGameTitle, titleKeyOf, withoutBrackets, withoutVersionWord } from './titles'

describe('normalizeGameTitle', () => {
  it('gives No-Intro and catalog spellings of one game the same form', () => {
    const want = 'legendofzeldamajorasmask'
    expect(normalizeGameTitle("Legend of Zelda, The - Majora's Mask (USA)")).toBe(want)
    expect(normalizeGameTitle("The Legend of Zelda: Majora's Mask")).toBe(want)
    expect(normalizeGameTitle('The Legend of Zelda: Majora’s Mask')).toBe(want)
    expect(normalizeGameTitle("Legend of Zelda, The: Majora's Mask [!]")).toBe(want)
  })

  it('drops region, revision and dump tags', () => {
    expect(normalizeGameTitle('Super Mario 64 (USA)')).toBe('supermario64')
    expect(normalizeGameTitle('Star Fox 64 (USA) (Rev 1)')).toBe('starfox64')
    expect(normalizeGameTitle('Banjo-Kazooie (Europe) (En,Fr,De) [b]')).toBe('banjokazooie')
    expect(normalizeGameTitle('Final Fantasy VII (Disc 1) {SCUS-94163}')).toBe('finalfantasyvii')
  })

  it('folds accents, trademark signs and "&"', () => {
    expect(normalizeGameTitle('Pokémon Snap')).toBe('pokemonsnap')
    expect(normalizeGameTitle('Viva Piñata: Trouble in Paradise')).toBe(
      'vivapinatatroubleinparadise'
    )
    expect(normalizeGameTitle('DOOM™')).toBe('doom')
    expect(normalizeGameTitle('Halo®: Combat Evolved')).toBe('halocombatevolved')
    expect(normalizeGameTitle('Banjo-Kazooie: Nuts & Bolts')).toBe('banjokazooienutsandbolts')
    expect(normalizeGameTitle('Naruto Shippūden')).toBe('narutoshippuden')
  })

  it('keeps every word, so different games stay different', () => {
    expect(normalizeGameTitle('Sonic Unleashed')).toBe('sonicunleashed')
    expect(normalizeGameTitle('007 - Agent Under Fire')).toBe('007agentunderfire')
    expect(normalizeGameTitle('007: Agent Under Fire')).toBe('007agentunderfire')
    expect(normalizeGameTitle('Mega Man X4')).not.toBe(normalizeGameTitle('Mega Man X'))
    expect(normalizeGameTitle('Theme Park')).toBe('themepark')
    expect(normalizeGameTitle('Breath of the Wild')).toBe('breathofthewild')
    expect(normalizeGameTitle('Diablo')).toBe('diablo')
  })

  it('handles empty and symbol-only names', () => {
    expect(normalizeGameTitle('')).toBe('')
    expect(normalizeGameTitle('(USA)')).toBe('')
  })
})

describe('titleKeyOf', () => {
  it('prefixes the system id', () => {
    expect(titleKeyOf('n64', 'Super Mario 64')).toBe('n64:supermario64')
    expect(titleKeyOf('n64', "The Legend of Zelda: Majora's Mask")).toBe(
      titleKeyOf('n64', "Legend of Zelda, The - Majora's Mask (USA)")
    )
    expect(titleKeyOf('pc', 'Diablo')).not.toBe(titleKeyOf('dos', 'Diablo'))
  })
})

describe('years, demos and "Version"', () => {
  it('keeps a bracketed year or demo note, so different games stay different', () => {
    expect(normalizeGameTitle('Prey (2006)')).toBe('prey2006')
    expect(normalizeGameTitle('Prey (openPREY)')).toBe('prey')
    expect(normalizeGameTitle('Sonic the Hedgehog (2013)')).not.toBe(
      normalizeGameTitle('Sonic the Hedgehog (USA, Europe)')
    )
    expect(normalizeGameTitle('Prince of Persia: The Sands of Time (E3 2003 Xbox demo)')).toBe(
      'princeofpersiathesandsoftimee32003xboxdemo'
    )
    expect(normalizeGameTitle('Game (1999-10-12) (Proto)')).toBe('game')
  })

  it('withoutBrackets / withoutVersionWord', () => {
    expect(withoutBrackets('Doom (1993)(id Software)')).toBe('Doom')
    expect(withoutBrackets('Doom')).toBeNull()
    expect(withoutVersionWord('Pokemon - Emerald Version (USA, Europe)')).toBe('Pokemon - Emerald')
    expect(withoutVersionWord('Pokémon Platinum Version')).toBe('Pokémon Platinum')
    expect(withoutVersionWord('Version')).toBeNull()
    expect(withoutVersionWord('Conversion')).toBeNull()
  })
})
