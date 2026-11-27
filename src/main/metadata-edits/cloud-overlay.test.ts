import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { MetadataCloudOverlay } from './cloud-overlay'
import { parseMetadataEdit, safeParseMetadataEdit } from './schema'

describe('MetadataCloudOverlay', () => {
  it('replaces every entry, drops malformed ones and reports the keys that changed', () => {
    const overlay = new MetadataCloudOverlay()
    const heard = vi.fn()
    overlay.onChange(heard)
    const changed = overlay.replaceAll({
      'steam-620': { description: 'Fixed', genres: ['Puzzle'] },
      'gog-1': { releaseDate: 'not a date' },
      'gog-2': { unknownField: 1 },
      'ps2-slus21115': { localPlayers: 2 }
    })
    expect(changed.sort()).toEqual(['ps2-slus21115', 'steam-620'])
    expect(overlay.get('steam-620')).toEqual({ description: 'Fixed', genres: ['Puzzle'] })
    expect(overlay.get('gog-1')).toBeUndefined()
    expect(overlay.get('gog-2')).toBeUndefined()
    expect(overlay.size).toBe(2)
    expect(heard).toHaveBeenCalledTimes(1)

    // The same file again: nothing changed, nobody told.
    expect(
      overlay.replaceAll({
        'steam-620': { description: 'Fixed', genres: ['Puzzle'] },
        'ps2-slus21115': { localPlayers: 2 }
      })
    ).toEqual([])
    expect(heard).toHaveBeenCalledTimes(1)

    // A removed entry and a changed one are both reported.
    expect(overlay.replaceAll({ 'steam-620': { description: 'Fixed again' } }).sort()).toEqual([
      'ps2-slus21115',
      'steam-620'
    ])
    expect(heard).toHaveBeenLastCalledWith(expect.arrayContaining(['steam-620', 'ps2-slus21115']))
  })

  it('sets and removes one entry', () => {
    const overlay = new MetadataCloudOverlay()
    const heard = vi.fn()
    const off = overlay.onChange(heard)
    expect(overlay.set('steam-1', { tags: ['A'] })).toBe(true)
    expect(overlay.set('steam-1', { tags: ['A'] })).toBe(false)
    expect(overlay.get('steam-1')).toEqual({ tags: ['A'] })
    expect(overlay.set('steam-1', null)).toBe(true)
    expect(overlay.has('steam-1')).toBe(false)
    expect(overlay.get(null)).toBeUndefined()
    off()
    overlay.set('steam-2', { tags: ['B'] })
    expect(heard).toHaveBeenCalledTimes(2)
    expect(overlay.all()).toEqual({ 'steam-2': { tags: ['B'] } })
  })
})

describe('metadata edit schema', () => {
  it('keeps the known fields and drops undefined ones', () => {
    expect(
      parseMetadataEdit({
        title: ' Portal ',
        hltb: { main: 8 },
        reviewScore: { score: 90 },
        extra: 'x'
      })
    ).toEqual({ title: 'Portal', hltb: { main: 8 }, reviewScore: { score: 90 } })
  })

  it('accepts the controls touch and keyboard flags, keeps them only when true and drops other keys', () => {
    expect(
      parseMetadataEdit({ controls: { controller: 'full', vr: 'supported', keyboard: true } })
    ).toEqual({ controls: { controller: 'full', vr: 'supported', keyboard: true } })
    expect(
      parseMetadataEdit({
        controls: { controller: 'none', vr: 'none', touch: true, keyboard: false }
      })
    ).toEqual({ controls: { controller: 'none', vr: 'none', touch: true } })
    expect(
      safeParseMetadataEdit({ controls: { controller: 'full', vr: 'none', mouse: true } })
    ).toEqual({ controls: { controller: 'full', vr: 'none' } })
    expect(() =>
      parseMetadataEdit({ controls: { controller: 'full', vr: 'none', touch: 'yes' } })
    ).toThrow()
  })

  it("an older PlayOut's controls schema drops touch and keyboard instead of refusing the entry", () => {
    // The controls object of PlayOut 0.9.90 and before (src/main/metadata-edits/schema.ts): zod strips unknown keys.
    const old = z.object({
      controls: z
        .object({
          controller: z.enum(['full', 'partial', 'none']),
          vr: z.enum(['only', 'supported', 'none'])
        })
        .optional()
    })
    const parsed = old.safeParse({
      controls: { controller: 'full', vr: 'supported', keyboard: true, touch: true }
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data).toEqual({ controls: { controller: 'full', vr: 'supported' } })
  })

  it('refuses bad values', () => {
    expect(() => parseMetadataEdit({ localPlayers: 1.5 })).toThrow()
    expect(() => parseMetadataEdit({ reviewScore: { score: 101 } })).toThrow()
    expect(() => parseMetadataEdit({ controls: { controller: 'yes', vr: 'none' } })).toThrow()
    // A month 13 or a day 32 is no date: the relay and the repository's schema refuse them too.
    expect(safeParseMetadataEdit({ releaseDate: '2026-13' })).toBeNull()
    expect(safeParseMetadataEdit({ releaseDate: '2026-01-32' })).toBeNull()
    expect(() => parseMetadataEdit({ releaseDate: '2026-00-10' })).toThrow()
    // The Edit sheet's own check lets '2011-13' through: the refusal is a sentence for the user, not zod's JSON.
    expect(() => parseMetadataEdit({ releaseDate: '2011-13' })).toThrow(
      /^Enter the release date as YYYY-MM-DD, YYYY-MM or YYYY \(month 01-12, day 01-31\)$/
    )
    expect(() => parseMetadataEdit({ localPlayers: 1.5 })).toThrow(
      /^This edit cannot be saved: localPlayers: /
    )
    for (const bad of [{ releaseDate: '2011-13' }, { localPlayers: 1.5 }, 'nothing', null]) {
      let message = ''
      try {
        parseMetadataEdit(bad)
      } catch (err) {
        message = (err as Error).message
      }
      expect(message).toMatch(/^(Enter the release date|This edit cannot be saved)/)
      expect(message).not.toContain('{')
    }
    expect(safeParseMetadataEdit({ releaseDate: '2026-12-31' })).toEqual({
      releaseDate: '2026-12-31'
    })
    expect(safeParseMetadataEdit({ releaseDate: '' })).toEqual({ releaseDate: '' })
    expect(safeParseMetadataEdit({ releaseDate: '26/01/2026' })).toBeNull()
    expect(safeParseMetadataEdit('nope')).toBeNull()
  })
})

describe('metadata edit schema: difficulty', () => {
  it('takes a level, or "" for Default (Medium)', () => {
    for (const level of ['story', 'easy', 'medium', 'hard', 'impossible', ''])
      expect(parseMetadataEdit({ difficulty: level })).toEqual({ difficulty: level })
    expect(safeParseMetadataEdit({ difficulty: 'hard', genres: ['Action'] })).toEqual({
      difficulty: 'hard',
      genres: ['Action']
    })
  })

  it('refuses anything else, with a sentence', () => {
    // 'tools' too: N/A (Tools) is a label from Steam's Utilities tag, never a pick, so it is never saved or sent to the cloud.
    for (const bad of ['Hard', 'nightmare', 'tools', 3, null, ['hard']]) {
      expect(safeParseMetadataEdit({ difficulty: bad })).toBeNull()
      expect(() => parseMetadataEdit({ difficulty: bad })).toThrow(
        /^This edit cannot be saved: difficulty: /
      )
    }
  })
})
