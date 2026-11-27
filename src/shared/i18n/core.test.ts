import { describe, expect, it, vi } from 'vitest'
import {
  buildCatalogs,
  createTranslatorFrom,
  interpolate,
  listLanguages,
  matchLanguage,
  parseLocalePath,
  pickLanguage,
  placeholders,
  steamLanguageCode
} from './core'

const files = {
  './locales/en/_language.json': { name: 'English', nativeName: 'English' },
  './locales/en/demo.json': {
    hello: 'Hello {name}',
    nested: { deep: 'Deep' },
    games_one: '{count} game',
    games_other: '{count} games',
    onlyEnglish: 'Only English',
    ignored: 7
  },
  './locales/es/_language.json': {
    code: 'wrong',
    name: 'Spanish',
    nativeName: 'Español',
    machineTranslated: true
  },
  './locales/es/demo.json': {
    hello: 'Hola {name}',
    games_one: '{count} juego',
    games_other: '{count} juegos'
  },
  './locales/de/_language.json': { name: 'German', nativeName: 'Deutsch' },
  // A folder without _language.json is not offered.
  './locales/fr/demo.json': { hello: 'Bonjour {name}' }
}

describe('i18n core', () => {
  const catalogs = buildCatalogs(files)

  it('reads languages from folders that have _language.json, English first', () => {
    expect(listLanguages(catalogs).map((l) => l.code)).toEqual(['en', 'de', 'es'])
    const es = catalogs.get('es')!.info
    // The folder name wins over a copied code.
    expect(es).toMatchObject({ code: 'es', nativeName: 'Español', machineTranslated: true })
    expect(catalogs.get('de')!.info.machineTranslated).toBe(false)
  })

  it('flattens namespaces and nested objects to dotted keys, ignoring non-strings', () => {
    const en = catalogs.get('en')!.messages
    expect(en.get('demo.nested.deep')).toBe('Deep')
    expect(en.has('demo.ignored')).toBe(false)
  })

  it('translates, falls back to English, then to the key (reported)', () => {
    const missing = vi.fn()
    const t = createTranslatorFrom(catalogs, 'es', missing)
    expect(t('demo.hello', { name: 'Ana' })).toBe('Hola Ana')
    expect(t('demo.onlyEnglish')).toBe('Only English')
    expect(missing).not.toHaveBeenCalled()
    expect(t('demo.nope')).toBe('demo.nope')
    expect(missing).toHaveBeenCalledWith('demo.nope')
  })

  it('picks plural forms with Intl.PluralRules', () => {
    const en = createTranslatorFrom(catalogs, 'en')
    expect(en('demo.games', { count: 1 })).toBe('1 game')
    expect(en('demo.games', { count: 3 })).toBe('3 games')
    const es = createTranslatorFrom(catalogs, 'es')
    expect(es('demo.games', { count: 1 })).toBe('1 juego')
    expect(es('demo.games', { count: 0 })).toBe('0 juegos')
    // German has no strings: English plural forms.
    expect(createTranslatorFrom(catalogs, 'de')('demo.games', { count: 2 })).toBe('2 games')
  })

  it('fills placeholders and leaves unknown ones visible', () => {
    expect(interpolate('{a} and {b}', { a: 1 })).toBe('1 and {b}')
    expect(placeholders('{a} and {b}')).toEqual(['a', 'b'])
  })

  it('parses locale paths', () => {
    expect(parseLocalePath('./locales/pt-BR/library.json')).toEqual({
      lang: 'pt-BR',
      namespace: 'library'
    })
    expect(parseLocalePath('C:\\x\\locales\\es\\a.json')).toEqual({ lang: 'es', namespace: 'a' })
    expect(parseLocalePath('./other/en/a.json')).toBeNull()
  })

  it('matches a wanted language to the closest available one', () => {
    const available = ['en', 'es', 'pt-BR']
    expect(matchLanguage('es-MX', available)).toBe('es')
    expect(matchLanguage('es_419', available)).toBe('es')
    expect(matchLanguage('PT-br', available)).toBe('pt-BR')
    expect(matchLanguage('pt', available)).toBe('pt-BR')
    expect(matchLanguage('fr-FR', available)).toBeNull()
    expect(matchLanguage('', available)).toBeNull()
  })

  it("maps Steam's language names", () => {
    expect(steamLanguageCode('spanish')).toBe('es')
    expect(steamLanguageCode('latam')).toBe('es-419')
    expect(steamLanguageCode(' SChinese ')).toBe('zh-CN')
    expect(steamLanguageCode('koreana')).toBe('ko')
    expect(steamLanguageCode('klingon')).toBeNull()
    expect(steamLanguageCode(null)).toBeNull()
  })

  it('picks the first candidate PlayOut has, else English', () => {
    const available = ['en', 'es']
    expect(
      pickLanguage(
        [
          { source: 'steam', codes: ['fr'] },
          { source: 'windows', codes: ['de-DE', 'es-MX'] }
        ],
        available
      )
    ).toEqual({ code: 'es', source: 'windows' })
    expect(
      pickLanguage(
        [
          { source: 'steam', codes: ['es-419'] },
          { source: 'windows', codes: ['en-US'] }
        ],
        available
      )
    ).toEqual({ code: 'es', source: 'steam' })
    expect(pickLanguage([{ source: 'windows', codes: ['ja'] }], available)).toEqual({
      code: 'en',
      source: 'default'
    })
  })
})
