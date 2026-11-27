/**
 * PlayOut's language in the renderer (src/shared/i18n/EXTRACTION.md): useT() in components, t() in stores and lib
 * code. Both follow Settings > System > Language at once (followSettings.ts feeds setLanguage), no restart needed.
 */
import { createTranslator, resolveLanguage, type Translate, type TranslateVars } from '@shared/i18n'
import { create } from 'zustand'

export {
  languageInfo,
  languages,
  type LanguageInfo,
  type Translate,
  type TranslateVars
} from '@shared/i18n'

interface LanguageState {
  /** The language shown (a code PlayOut has). */
  language: string
  /** A new function on every language change, so components that select it re-render. */
  t: Translate
}

export const useLanguageStore = create<LanguageState>()(() => ({
  language: resolveLanguage(''),
  t: createTranslator(resolveLanguage(''))
}))

/** Show `code` (resolved to a language PlayOut has; '' = English until main has picked one). */
export function setLanguage(code: string): void {
  const language = resolveLanguage(code)
  if (language === useLanguageStore.getState().language) return
  useLanguageStore.setState({ language, t: createTranslator(language) })
  // Screen readers and the browser's own text (spell check, hyphenation) follow the page's language.
  if (typeof document !== 'undefined') document.documentElement.lang = language
}

/** The language shown now, for non-React code. */
export function currentLanguage(): string {
  return useLanguageStore.getState().language
}

/** The language shown, for components (re-renders when it changes). */
export function useLanguage(): string {
  return useLanguageStore((s) => s.language)
}

/**
 * The translator for components: `const t = useT()` then `t('namespace.key', { name })`. The component re-renders
 * when the language changes.
 */
export function useT(): Translate {
  return useLanguageStore((s) => s.t)
}

/**
 * Translate outside React (stores, toasts from lib code, text built in event handlers). It reads the language at the
 * moment it is called, so never keep its result in a module-level constant: build such text in a function.
 */
export function t(key: string, vars?: TranslateVars): string {
  return useLanguageStore.getState().t(key, vars)
}
