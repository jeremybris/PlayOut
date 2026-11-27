/**
 * PlayOut's translation core (docs/TRANSLATING.md, src/shared/i18n/EXTRACTION.md). Pure functions over catalogs, so
 * main, the renderer and the tests share one implementation; index.ts binds them to the language files in locales/.
 *
 * A catalog is every string of one language, flattened to "<namespace>.<path>" keys: locales/es/settingsSystem.json's
 * { "language": { "label": "Idioma" } } is the key "settingsSystem.language.label". English is the source language
 * and the fallback for anything a translation leaves out.
 */

/** English: the source of every string, and the fallback for a key a language does not have. */
export const SOURCE_LANGUAGE = 'en'

/** locales/<code>/_language.json: what the Language setting shows for a language. */
export interface LanguageInfo {
  /** The folder name: a BCP 47 code such as "es" or "pt-BR". */
  code: string
  /** The language's name in English ("Spanish"). */
  name: string
  /** The language's name in itself ("Español"): what the Language setting lists. */
  nativeName: string
  /** Made by a translation tool, not checked by a speaker yet: the Language setting says so. */
  machineTranslated: boolean
  /** Free text for translators (who made it, what is left). */
  notes?: string
}

/** One language: its description and its strings by full key. */
export interface Catalog {
  info: LanguageInfo
  messages: Map<string, string>
}

export type TranslateVars = Record<string, string | number>

/**
 * Look a key up in the current language. `vars` fills {name} placeholders; a numeric `count` also picks the plural
 * form (key_one, key_other, ...: see pluralKey).
 */
export type Translate = (key: string, vars?: TranslateVars) => string

/** The language metadata file in every language folder: not a namespace. */
export const LANGUAGE_FILE = '_language'

/** A namespace (file) name: letters, digits, '-' and '_', starting with a letter. */
const NAMESPACE = /^[A-Za-z][\w-]*$/

/** Nested JSON objects of strings flattened to dotted paths ({ a: { b: 'x' } } -> 'a.b' = 'x'). */
export function flattenMessages(
  value: unknown,
  prefix: string,
  out: Map<string, string> = new Map()
): Map<string, string> {
  if (typeof value === 'string') {
    if (prefix) out.set(prefix, value)
    return out
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>))
      flattenMessages(child, prefix ? `${prefix}.${key}` : key, out)
  }
  // Anything else (numbers, arrays, null) is not a string a translator wrote: ignored.
  return out
}

/** "./locales/es/settingsSystem.json" (any prefix) -> { lang: 'es', namespace: 'settingsSystem' }. */
export function parseLocalePath(path: string): { lang: string; namespace: string } | null {
  const m = /(?:^|[\\/])locales[\\/]([^\\/]+)[\\/]([^\\/]+)\.json$/.exec(path)
  if (!m) return null
  return { lang: m[1]!, namespace: m[2]! }
}

function languageInfo(code: string, raw: unknown): LanguageInfo {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const text = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined
  const name = text(obj.name) ?? code
  return {
    // The folder decides the code, so a copied _language.json with the old code cannot hide a language.
    code,
    name,
    nativeName: text(obj.nativeName) ?? name,
    machineTranslated: obj.machineTranslated === true,
    notes: text(obj.notes)
  }
}

/**
 * Catalogs from the language files, as import.meta.glob hands them over (path -> parsed JSON). A folder counts as a
 * language once it has _language.json; namespace files without it are ignored.
 */
export function buildCatalogs(files: Record<string, unknown>): Map<string, Catalog> {
  const infos = new Map<string, unknown>()
  const namespaces = new Map<string, { namespace: string; data: unknown }[]>()
  for (const [path, data] of Object.entries(files)) {
    const parsed = parseLocalePath(path)
    if (!parsed) continue
    if (parsed.namespace === LANGUAGE_FILE) {
      infos.set(parsed.lang, data)
      continue
    }
    if (!NAMESPACE.test(parsed.namespace)) continue
    const list = namespaces.get(parsed.lang) ?? []
    list.push({ namespace: parsed.namespace, data })
    namespaces.set(parsed.lang, list)
  }
  const catalogs = new Map<string, Catalog>()
  for (const [code, raw] of infos) {
    const messages = new Map<string, string>()
    for (const { namespace, data } of namespaces.get(code) ?? [])
      flattenMessages(data, namespace, messages)
    catalogs.set(code, { info: languageInfo(code, raw), messages })
  }
  return catalogs
}

/** Every language, English first, then by English name. */
export function listLanguages(catalogs: Map<string, Catalog>): LanguageInfo[] {
  return [...catalogs.values()]
    .map((c) => c.info)
    .sort((a, b) =>
      a.code === SOURCE_LANGUAGE
        ? -1
        : b.code === SOURCE_LANGUAGE
          ? 1
          : a.name.localeCompare(b.name, 'en')
    )
}

const baseOf = (code: string): string => code.toLowerCase().split(/[-_]/)[0]!

/**
 * The available language that best serves `wanted` (a BCP 47 code, any case, '_' or '-'), or null:
 * the same code ("pt-BR" -> "pt-BR"), then the bare language ("es-MX" -> "es"), then another region of it
 * ("pt" -> "pt-BR").
 */
export function matchLanguage(wanted: string, available: readonly string[]): string | null {
  const norm = wanted.trim().replace(/_/g, '-').toLowerCase()
  if (!norm) return null
  const exact = available.find((code) => code.toLowerCase() === norm)
  if (exact) return exact
  const base = baseOf(norm)
  return (
    available.find((code) => code.toLowerCase() === base) ??
    available.find((code) => baseOf(code) === base) ??
    null
  )
}

/**
 * Steam's language names (HKCU\Software\Valve\Steam\Language, Steam > Settings > Interface) as BCP 47 codes. Steam
 * names a few by region ("latam" is Latin American Spanish, "brazilian" Brazilian Portuguese, "koreana" Korean).
 */
export const STEAM_LANGUAGES: Readonly<Record<string, string>> = {
  arabic: 'ar',
  brazilian: 'pt-BR',
  bulgarian: 'bg',
  czech: 'cs',
  danish: 'da',
  dutch: 'nl',
  english: 'en',
  finnish: 'fi',
  french: 'fr',
  german: 'de',
  greek: 'el',
  hungarian: 'hu',
  indonesian: 'id',
  italian: 'it',
  japanese: 'ja',
  korean: 'ko',
  koreana: 'ko',
  latam: 'es-419',
  norwegian: 'nb',
  polish: 'pl',
  portuguese: 'pt',
  romanian: 'ro',
  russian: 'ru',
  schinese: 'zh-CN',
  spanish: 'es',
  swedish: 'sv',
  tchinese: 'zh-TW',
  thai: 'th',
  turkish: 'tr',
  ukrainian: 'uk',
  vietnamese: 'vi'
}

/** Steam's language name as a code, or null when it is empty or unknown. */
export function steamLanguageCode(steamName: string | null | undefined): string | null {
  if (!steamName) return null
  return STEAM_LANGUAGES[steamName.trim().toLowerCase()] ?? null
}

export type LanguageSource = 'steam' | 'windows' | 'default'

/**
 * The first-start language: the first candidate PlayOut has a translation for, in the order given (Steam's, then
 * Windows' preferred languages), else English. `source` says which one won, for the log.
 */
export function pickLanguage(
  candidates: readonly { source: Exclude<LanguageSource, 'default'>; codes: readonly string[] }[],
  available: readonly string[]
): { code: string; source: LanguageSource } {
  for (const { source, codes } of candidates) {
    for (const wanted of codes) {
      const code = matchLanguage(wanted, available)
      if (code) return { code, source }
    }
  }
  return { code: SOURCE_LANGUAGE, source: 'default' }
}

const pluralRules = new Map<string, Intl.PluralRules>()

function pluralCategory(lang: string, count: number): Intl.LDMLPluralRule {
  let rules = pluralRules.get(lang)
  if (!rules) {
    try {
      rules = new Intl.PluralRules(lang)
    } catch {
      // An unusual folder name Intl does not know: English rules are better than none.
      rules = new Intl.PluralRules(SOURCE_LANGUAGE)
    }
    pluralRules.set(lang, rules)
  }
  return rules.select(count)
}

/**
 * The plural forms to try for `key` with `count`, most specific first: key_<category> (Intl.PluralRules: zero, one,
 * two, few, many, other), then key_other, then the bare key.
 */
export function pluralKeys(lang: string, key: string, count: number): string[] {
  const category = pluralCategory(lang, count)
  const keys = [`${key}_${category}`]
  if (category !== 'other') keys.push(`${key}_other`)
  keys.push(key)
  return keys
}

/** Fill {name} placeholders; a placeholder without a value stays as written, so the gap is visible. */
export function interpolate(text: string, vars?: TranslateVars): string {
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole
  )
}

/** The {name} placeholders a string uses. */
export function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!)
}

export type MissingKeyReporter = (key: string) => void

/**
 * A translator for `lang` over `catalogs`: the language's string, else English's, else the key itself (and
 * `onMissing`, for a key English does not have either).
 */
export function createTranslatorFrom(
  catalogs: Map<string, Catalog>,
  lang: string,
  onMissing?: MissingKeyReporter
): Translate {
  const own = catalogs.get(lang)?.messages
  const source = catalogs.get(SOURCE_LANGUAGE)?.messages
  const lookup = (
    messages: Map<string, string> | undefined,
    msgLang: string,
    key: string,
    vars?: TranslateVars
  ): string | undefined => {
    if (!messages) return undefined
    const count = vars?.count
    if (typeof count === 'number') {
      for (const candidate of pluralKeys(msgLang, key, count)) {
        const text = messages.get(candidate)
        if (text !== undefined) return text
      }
      return undefined
    }
    return messages.get(key)
  }
  return (key, vars) => {
    const text =
      (lang !== SOURCE_LANGUAGE ? lookup(own, lang, key, vars) : undefined) ??
      lookup(source, SOURCE_LANGUAGE, key, vars)
    if (text === undefined) {
      onMissing?.(key)
      return key
    }
    return interpolate(text, vars)
  }
}
