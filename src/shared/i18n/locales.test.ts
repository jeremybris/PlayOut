/**
 * The language files themselves (docs/TRANSLATING.md): every translation stays in step with English, and every key
 * the code asks for exists in English. `npm run i18n:check` prints the same comparison as a coverage report.
 */
import { readdirSync, readFileSync } from 'fs'
import { join, relative, resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { buildCatalogs, LANGUAGE_FILE, placeholders, SOURCE_LANGUAGE } from './core'
import { languages, resolveLanguage } from '.'

const files = import.meta.glob<unknown>('./locales/*/*.json', { eager: true, import: 'default' })
const catalogs = buildCatalogs(files)
const english = catalogs.get(SOURCE_LANGUAGE)!.messages

/** "x_one" / "x_other" are the plural forms of "x". */
const PLURAL = /_(zero|one|two|few|many|other)$/
const baseKey = (key: string): string => key.replace(PLURAL, '')

/** Every English string for a key, its plural forms included. */
function englishForms(key: string): string[] {
  const base = baseKey(key)
  return [...english.entries()].filter(([k]) => k === base || baseKey(k) === base).map(([, v]) => v)
}

describe('language files', () => {
  it('have English, and English is not machine translated', () => {
    expect(catalogs.get(SOURCE_LANGUAGE)?.info.machineTranslated).toBe(false)
    expect(languages()[0]!.code).toBe(SOURCE_LANGUAGE)
    expect(english.size).toBeGreaterThan(0)
  })

  it('give every language a name in itself', () => {
    for (const lang of languages()) {
      expect(lang.nativeName, lang.code).toBeTruthy()
      expect(resolveLanguage(lang.code)).toBe(lang.code)
    }
  })

  it('hold only strings (objects for grouping)', () => {
    const bad: string[] = []
    const walk = (value: unknown, path: string): void => {
      if (typeof value === 'string') return
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`)
        return
      }
      bad.push(path)
    }
    for (const [path, data] of Object.entries(files))
      if (!path.endsWith(`/${LANGUAGE_FILE}.json`)) walk(data, path)
    expect(bad).toEqual([])
  })

  for (const [code, catalog] of catalogs) {
    if (code === SOURCE_LANGUAGE) continue

    it(`${code}: has no key English lacks`, () => {
      const extra = [...catalog.messages.keys()].filter(
        (key) => !english.has(key) && englishForms(key).length === 0
      )
      expect(extra).toEqual([])
    })

    it(`${code}: uses only the {variables} English uses`, () => {
      const wrong: string[] = []
      for (const [key, text] of catalog.messages) {
        const allowed = new Set(englishForms(key).flatMap(placeholders))
        // A plural's count is always passed, even when the English form spells it out ("One game").
        if (PLURAL.test(key)) allowed.add('count')
        for (const name of placeholders(text))
          if (!allowed.has(name)) wrong.push(`${key}: {${name}}`)
      }
      expect(wrong).toEqual([])
    })
  }
})

const SRC = resolve(__dirname, '../..')

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'locales') sourceFiles(full, out)
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

/** t('key') / tMain('key') with a literal key (not obj.t(...), not a template with ${...}). */
const CALL = /(?<![\w$.])(?:t|tMain)\(\s*(['"`])([^'"`$\\]+?)\1/g
/** Files that use the translations import one of the i18n modules. */
const USES_I18N = /from\s+['"][^'"]*\bi18n(?:\/[^'"]*)?['"]/

describe('keys used in the code', () => {
  it('exist in English', () => {
    const missing: string[] = []
    let checked = 0
    for (const file of sourceFiles(SRC)) {
      // Comments may show example keys: only code counts.
      const text = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      if (!USES_I18N.test(text)) continue
      for (const m of text.matchAll(CALL)) {
        const key = m[2]!
        checked++
        if (english.has(key) || englishForms(key).length > 0) continue
        missing.push(`${relative(SRC, file)}: ${key}`)
      }
    }
    expect(missing).toEqual([])
    // Settings > System alone asks for dozens: a scan that finds none is broken.
    expect(checked).toBeGreaterThan(20)
  })
})
