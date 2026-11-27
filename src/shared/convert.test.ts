import { describe, expect, it } from 'vitest'
import { CONVERT_PLATFORMS, convertNoteText } from './convert'
import { createTranslator } from './i18n'
import { systemIconSlug } from './platform-icons'

describe('Convert platforms', () => {
  it('are listed in alphabetical order', () => {
    const labels = CONVERT_PLATFORMS.map((p) => p.label)
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })))
    expect(labels[0]).toBe('3DO')
  })

  it("give each platform its cards' badge icon", () => {
    expect(systemIconSlug('ps2', 'Sony')).toBe('playstation2')
    expect(systemIconSlug('saturn', 'Sega')).toBe('sega')
    expect(systemIconSlug('switch2', 'Nintendo')).toBe('gamepad-2')
  })
})

describe('Convert notes', () => {
  // convertNoteText builds its key from the note id, which the i18n key scan cannot see: every id used is checked here.
  it('have a text in English and Spanish for every note a direction names', () => {
    const notes = CONVERT_PLATFORMS.flatMap((p) =>
      p.pairs.flatMap((pair) => [pair.forward.note, pair.backward?.note])
    ).filter((n): n is NonNullable<typeof n> => !!n)
    expect(notes.length).toBeGreaterThan(30)
    for (const lang of ['en', 'es']) {
      const t = createTranslator(lang)
      for (const note of notes)
        expect(convertNoteText(note, t)).not.toBe(`settingsConvert.notes.${note}`)
    }
    expect(convertNoteText('singleTrack', createTranslator('en'))).toBe('Single-track games only.')
  })
})
