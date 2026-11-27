/**
 * PlayOut's translations, bound to the language files in ./locales (see EXTRACTION.md for how code uses them and
 * docs/TRANSLATING.md for how to add a language). Every locales/<code>/*.json is bundled at build time through
 * import.meta.glob, in main and in the renderer alike, so a new language folder or a new namespace file needs no code
 * change: a folder with a _language.json is a language the Language setting offers.
 *
 * Code outside this folder normally uses the bound helpers instead: useT() / t() from src/renderer/src/i18n in the
 * renderer, tMain() from src/main/i18n in main.
 */
import {
  buildCatalogs,
  createTranslatorFrom,
  listLanguages,
  matchLanguage,
  SOURCE_LANGUAGE,
  type LanguageInfo,
  type Translate
} from './core'

export {
  interpolate,
  matchLanguage,
  pickLanguage,
  placeholders,
  SOURCE_LANGUAGE,
  STEAM_LANGUAGES,
  steamLanguageCode,
  type LanguageInfo,
  type LanguageSource,
  type Translate,
  type TranslateVars
} from './core'

const files = import.meta.glob<unknown>('./locales/*/*.json', { eager: true, import: 'default' })

const catalogs = buildCatalogs(files)

/** Every language PlayOut has, English first: what Settings > System > Language lists. */
export function languages(): LanguageInfo[] {
  return listLanguages(catalogs)
}

/** The codes of every language PlayOut has. */
export function languageCodes(): string[] {
  return languages().map((l) => l.code)
}

/** One language's description, or undefined when PlayOut does not have it. */
export function languageInfo(code: string): LanguageInfo | undefined {
  return catalogs.get(code)?.info
}

/**
 * The language to show for a saved setting: the code itself when PlayOut has it, else its closest match ("es-MX"
 * -> "es"), else English. '' (not chosen yet) is English too.
 */
export function resolveLanguage(code: string | null | undefined): string {
  return (code && matchLanguage(code, languageCodes())) || SOURCE_LANGUAGE
}

const warned = new Set<string>()

/** A key English does not have is a bug in the code: said once per key, in development only. */
function reportMissing(key: string): void {
  if (!import.meta.env?.DEV || warned.has(key)) return
  warned.add(key)
  console.warn(`[i18n] missing key "${key}": add it to src/shared/i18n/locales/en`)
}

/** A translator for `lang` (resolved like resolveLanguage), falling back to English, then to the key. */
export function createTranslator(lang: string): Translate {
  return createTranslatorFrom(catalogs, resolveLanguage(lang), reportMissing)
}
