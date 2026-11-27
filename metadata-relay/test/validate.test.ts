import { describe, expect, it } from 'vitest'
import { isValidKey, mergeFields, validateFields, validateSuggestion } from '../src/validate'

const base = {
  key: 'steam-620',
  title: 'Portal 2',
  appVersion: '0.1.138',
  clientId: 'abcdef12-3456'
}

function suggest(extra: Record<string, unknown>): ReturnType<typeof validateSuggestion> {
  return validateSuggestion(JSON.stringify({ ...base, ...extra }))
}

describe('isValidKey', () => {
  it('accepts the gameMetadataKey forms', () => {
    for (const k of [
      'steam-620',
      'gog-1207658924',
      'epic-fn',
      'ubisoft-a_b.c',
      'ps2-slus20312',
      'gc-gale01',
      'snes-super-metroid',
      'half-life'
    ]) {
      expect(isValidKey(k)).toBe(true)
    }
  })
  it('rejects paths, uppercase, empty and odd Steam keys', () => {
    for (const k of [
      '',
      '../x',
      'a..b',
      'a/b',
      'Steam-620',
      'steam-abc',
      'steam-0',
      '-a',
      'a.',
      'a b',
      'x'.repeat(251),
      5
    ]) {
      expect(isValidKey(k)).toBe(false)
    }
  })
})

describe('validateSuggestion', () => {
  it('accepts every editable field', () => {
    const r = suggest({
      fields: {
        title: ' Portal 2 ',
        description: 'Line one.\nLine two with a < b.',
        shortDescription: 'Puzzles.',
        releaseDate: '2011-04-19',
        developers: ['Valve', 'valve'],
        publishers: ['Valve'],
        genres: ['Puzzle'],
        tags: ['Co-op'],
        localPlayers: 2,
        controls: { controller: 'full', vr: 'none' },
        hltb: { main: 8.5, extra: 13, completionist: 21.333, solo: 8 },
        reviewScore: { score: 98, source: 'steam' },
        difficulty: 'hard'
      }
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.fields.difficulty).toBe('hard')
    expect(r.value.fields.title).toBe('Portal 2')
    expect(r.value.fields.developers).toEqual(['Valve'])
    expect(r.value.fields.hltb?.completionist).toBe(21.33)
  })

  it('accepts empty values ("the game has none") and null (remove the field)', () => {
    const r = suggest({
      fields: {
        description: '',
        releaseDate: '',
        genres: [],
        localPlayers: 0,
        hltb: {},
        reviewScore: {},
        difficulty: '',
        tags: null
      }
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.fields.tags).toBe(null)
  })

  it.each([
    [{ fields: { cover: 'x' } }, 'cover is not an editable field'],
    [{ fields: { rating: 50 } }, 'rating is not an editable field'],
    [{ fields: {} }, 'fields must not be empty'],
    [{ fields: { title: 5 } }, 'title must be a string'],
    [{ fields: { title: '' } }, 'title must not be empty'],
    [{ fields: { title: 'a\nb' } }, 'single line'],
    [{ fields: { description: '<script>alert(1)</script>' } }, 'HTML'],
    [{ fields: { description: 'see javascript:alert(1)' } }, 'HTML'],
    [{ fields: { description: 'x'.repeat(20_001) } }, 'longer than'],
    [{ fields: { releaseDate: 'April 2011' } }, 'releaseDate'],
    [{ fields: { genres: Array(21).fill('a') } }, 'more than 20'],
    [{ fields: { genres: [''] } }, 'must not be empty'],
    [{ fields: { localPlayers: 65 } }, 'between 0 and 64'],
    [{ fields: { localPlayers: 2.5 } }, 'whole number'],
    [{ fields: { localPlayers: { max: 2 } } }, 'must be a number'],
    [{ fields: { localPlayers: '5' } }, 'must be a number'],
    [{ fields: { controls: { controller: 'yes', vr: 'none' } } }, 'one of'],
    [{ fields: { controls: { controller: 'full' } } }, 'controls.vr'],
    [{ fields: { controls: { controller: 'full', vr: 'none', touch: 'yes' } } }, 'controls.touch'],
    [
      { fields: { controls: { controller: 'full', vr: 'none', keyboard: 1 } } },
      'controls.keyboard'
    ],
    [
      { fields: { controls: { controller: 'none', vr: 'none', lightgun: 'yes' } } },
      'controls.lightgun'
    ],
    [
      { fields: { controls: { controller: 'none', vr: 'none', lightGun: true } } },
      'not an editable field'
    ],
    [
      { fields: { controls: { controller: 'full', vr: 'none', mouse: true } } },
      'not an editable field'
    ],
    [{ fields: { hltb: { main: -1 } } }, 'between'],
    [{ fields: { hltb: { story: 1 } } }, 'not an editable field'],
    [{ fields: { reviewScore: { score: 90, source: 'metacritic' } } }, 'one of'],
    [{ fields: { difficulty: 'nightmare' } }, 'difficulty must be one of'],
    [{ fields: { difficulty: 3 } }, 'difficulty must be one of'],
    [{ key: '../etc', fields: { localPlayers: 1 } }, 'key'],
    [{ clientId: 'x', fields: { localPlayers: 1 } }, 'clientId'],
    [{ appVersion: 'latest', fields: { localPlayers: 1 } }, 'appVersion'],
    [{ title: '<b>x</b>', fields: { localPlayers: 1 } }, 'HTML'],
    [{ extra: 1, fields: { localPlayers: 1 } }, 'unknown property extra']
  ])('rejects %j', (extra, error) => {
    const r = suggest(extra)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain(error)
  })

  it('rejects a body over 64 KB and broken JSON', () => {
    expect(validateSuggestion('x'.repeat(64 * 1024 + 1))).toEqual({
      ok: false,
      error: 'request is larger than 64 KB'
    })
    expect(validateSuggestion('{').ok).toBe(false)
    expect(validateSuggestion('[]').ok).toBe(false)
  })

  it('does not accept prototype names as fields', () => {
    expect(validateFields(JSON.parse('{"__proto__": {"x": 1}}')).ok).toBe(false)
    expect(validateFields({ toString: 'x' }).ok).toBe(false)
  })
})

describe('controls: touch, keyboard and lightgun', () => {
  it('accepts touch and keyboard, keeping them only when true', () => {
    const all = suggest({
      fields: { controls: { controller: 'full', vr: 'supported', keyboard: true } }
    })
    expect(all.ok && all.value.fields.controls).toEqual({
      controller: 'full',
      vr: 'supported',
      keyboard: true
    })
    const touch = suggest({ fields: { controls: { controller: 'none', vr: 'none', touch: true } } })
    expect(touch.ok && touch.value.fields.controls).toEqual({
      controller: 'none',
      vr: 'none',
      touch: true
    })
    const off = suggest({
      fields: { controls: { controller: 'full', vr: 'none', touch: false, keyboard: false } }
    })
    expect(off.ok && off.value.fields.controls).toEqual({ controller: 'full', vr: 'none' })
  })

  it('accepts lightgun, keeping it only when true', () => {
    const gun = suggest({
      fields: { controls: { controller: 'none', vr: 'none', lightgun: true, keyboard: true } }
    })
    expect(gun.ok && gun.value.fields.controls).toEqual({
      controller: 'none',
      vr: 'none',
      lightgun: true,
      keyboard: true
    })
    const off = suggest({
      fields: { controls: { controller: 'full', vr: 'none', lightgun: false } }
    })
    expect(off.ok && off.value.fields.controls).toEqual({ controller: 'full', vr: 'none' })
  })
})

describe('mergeFields', () => {
  it('replaces whole fields and removes nulls', () => {
    const merged = mergeFields(
      { genres: ['Action'], hltb: { main: 5, extra: 9 }, title: 'Old' },
      { genres: ['Puzzle'], hltb: { main: 8 }, title: null }
    )
    expect(merged).toEqual({ genres: ['Puzzle'], hltb: { main: 8 } })
  })
})
