import { describe, expect, it } from 'vitest'
import {
  describeMetadataValue,
  diffMetadataFields,
  mergeMetadataFields,
  normalizeRelayUrl,
  sameMetadataValue,
  unsafeMetadataFields
} from './metadata-cloud'
import { createTranslator } from './i18n'
import { controlsFromPicks, type ControlsEdit } from './metadata-edit'

// The words around the values in English, as the tests read them.
const t = createTranslator('en')

describe('unsafeMetadataFields', () => {
  it('names the fields with HTML, script URLs or control characters', () => {
    expect(
      unsafeMetadataFields({
        title: 'Fine <3',
        description: 'Line one\nline two\ttab',
        genres: ['Action', '<b>RPG</b>'],
        developers: ['javascript:alert(1)'],
        shortDescription: 'bell\u0007',
        localPlayers: 2
      })
    ).toEqual(['shortDescription', 'developers', 'genres'])
    expect(unsafeMetadataFields({ title: 'Portal 2', tags: [] })).toEqual([])
  })
})

describe('normalizeRelayUrl', () => {
  it('keeps the base of an https URL and drops /suggest, /health and trailing slashes', () => {
    expect(normalizeRelayUrl(' https://relay.example.workers.dev/ ')).toBe(
      'https://relay.example.workers.dev'
    )
    expect(normalizeRelayUrl('https://relay.test/suggest')).toBe('https://relay.test')
    expect(normalizeRelayUrl('https://relay.test/api/health/')).toBe('https://relay.test/api')
    expect(normalizeRelayUrl('http://localhost:8787')).toBe('http://localhost:8787')
    expect(normalizeRelayUrl('')).toBe('')
  })

  it('refuses http, credentials, queries and non-URLs', () => {
    expect(normalizeRelayUrl('http://relay.test')).toBeNull()
    expect(normalizeRelayUrl('https://user:pw@relay.test')).toBeNull()
    expect(normalizeRelayUrl('https://relay.test/?token=1')).toBeNull()
    expect(normalizeRelayUrl('relay')).toBeNull()
    expect(normalizeRelayUrl('javascript:alert(1)')).toBeNull()
  })
})

describe('describeMetadataValue', () => {
  it('writes each kind of field as one line', () => {
    expect(describeMetadataValue({ genres: ['A', 'B'] }, 'genres', t)).toBe('A, B')
    expect(describeMetadataValue({ genres: [] }, 'genres', t)).toBe('(none)')
    expect(describeMetadataValue({}, 'genres', t)).toBe('(not set)')
    expect(describeMetadataValue({ localPlayers: 0 }, 'localPlayers', t)).toBe('(none)')
    expect(
      describeMetadataValue({ controls: { controller: 'full', vr: 'none' } }, 'controls', t)
    ).toBe('Full Controller Support')
    expect(describeMetadataValue({ hltb: { main: 8.25, completionist: 20 } }, 'hltb', t)).toBe(
      'Main 8.3 h, Completionist 20 h'
    )
    expect(
      describeMetadataValue({ reviewScore: { score: 91, source: 'steam' } }, 'reviewScore', t)
    ).toBe('91 (Steam)')
    expect(describeMetadataValue({ description: 'x'.repeat(200) }, 'description', t)).toHaveLength(
      160
    )
  })
})

describe('describeMetadataValue: controls', () => {
  it('names the picks the Edit sheet rows show, in their order', () => {
    const d = (controls: ControlsEdit, tr = t): string =>
      describeMetadataValue({ controls }, 'controls', tr)
    expect(
      (['full', 'partial', 'keyboard', 'vr', 'touch', 'lightgun'] as const).map((p) =>
        d(controlsFromPicks([p]))
      )
    ).toEqual([
      'Full Controller Support',
      'Partial Controller Support',
      'Mouse & Keyboard',
      'VR only',
      'Touch',
      'Lightgun'
    ])
    expect(d(controlsFromPicks(['vr', 'keyboard', 'full']))).toBe(
      'Full Controller Support, Mouse & Keyboard, VR'
    )
    expect(d({ controller: 'full', vr: 'supported' })).toBe('Full Controller Support, VR')
    expect(d(controlsFromPicks(['lightgun', 'keyboard']))).toBe('Mouse & Keyboard, Lightgun')
    const es = createTranslator('es')
    expect(d(controlsFromPicks(['full', 'keyboard']), es)).toBe(
      'Compatibilidad total con mando, Ratón y teclado'
    )
    expect(d(controlsFromPicks(['lightgun']), es)).toBe('Pistola de luz')
  })

  it('reads a hand-written VR-only entry with a keyboard or controller as plain VR, not "VR only"', () => {
    const d = (controls: ControlsEdit): string => describeMetadataValue({ controls }, 'controls', t)
    expect(d({ controller: 'none', vr: 'only', keyboard: true })).toBe('Mouse & Keyboard, VR')
    expect(d({ controller: 'full', vr: 'only' })).toBe('Full Controller Support, VR')
    // VR only with nothing else that plays it, or beside Touch / Lightgun only, stays "VR only".
    expect(d({ controller: 'none', vr: 'only' })).toBe('VR only')
    expect(d({ controller: 'none', vr: 'only', touch: true })).toBe('VR only, Touch')
  })

  it('takes a false touch or keyboard as the same as none', () => {
    expect(
      sameMetadataValue(
        { controller: 'full', vr: 'none', touch: false, keyboard: false },
        { controller: 'full', vr: 'none' }
      )
    ).toBe(true)
    expect(
      sameMetadataValue(
        { controller: 'full', vr: 'none', keyboard: true },
        { controller: 'full', vr: 'none' }
      )
    ).toBe(false)
    expect(
      diffMetadataFields(
        { controls: { controller: 'full', vr: 'none' } },
        { controls: { controller: 'full', vr: 'none', keyboard: true } },
        t
      )
    ).toEqual([
      {
        field: 'controls',
        label: 'Controls',
        before: 'Full Controller Support',
        after: 'Full Controller Support, Mouse & Keyboard'
      }
    ])
  })
})

describe('diffMetadataFields / mergeMetadataFields', () => {
  it('lists only the fields that differ, in the sheet order', () => {
    const changes = diffMetadataFields(
      { genres: ['A'], hltb: { main: 1 } },
      { hltb: { main: 1 }, genres: ['B'], title: 'T' },
      t
    )
    expect(changes.map((c) => c.field)).toEqual(['title', 'genres'])
    expect(changes[1]).toEqual({ field: 'genres', label: 'Genres', before: 'A', after: 'B' })
  })

  it('compares objects regardless of key order', () => {
    expect(sameMetadataValue({ main: 1, extra: 2 }, { extra: 2, main: 1 })).toBe(true)
    expect(sameMetadataValue(['a', 'b'], ['b', 'a'])).toBe(false)
  })

  it('replaces whole fields', () => {
    expect(
      mergeMetadataFields({ hltb: { main: 1, extra: 2 }, genres: ['A'] }, { hltb: { main: 3 } })
    ).toEqual({
      hltb: { main: 3 },
      genres: ['A']
    })
  })
})
