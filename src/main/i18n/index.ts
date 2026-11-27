/**
 * PlayOut's language on the main side (src/shared/i18n, docs/TRANSLATING.md): tMain() translates the text main shows
 * or sends (notices, toasts, dialogs, tray menu) into the saved language (settings.system.language), and the first
 * start picks that language from Steam's or Windows' own.
 */
import type { Settings, SettingsPatch } from '@shared/types'
import {
  createTranslator,
  languageCodes,
  pickLanguage,
  resolveLanguage,
  steamLanguageCode,
  type LanguageSource,
  type Translate,
  type TranslateVars
} from '@shared/i18n'
import { createRealIo, regQuery, type RunCommand } from '../home-button/io'
import { createLogger, type Logger } from '../logger'

let language = resolveLanguage('')
let translate: Translate = createTranslator(language)
const listeners = new Set<(language: string) => void>()

/** Translate into the saved language (English until setupLanguage runs). Keys and {vars} as in the renderer's t(). */
export function tMain(key: string, vars?: TranslateVars): string {
  return translate(key, vars)
}

/** The language tMain() uses now (a code PlayOut has). */
export function mainLanguage(): string {
  return language
}

/**
 * Call `listener` with the new language whenever it changes, for text main built once and keeps (the tray menu,
 * a window title): rebuild it there. Returns the unsubscribe.
 */
export function onMainLanguageChange(listener: (language: string) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Switch tMain() to `code` (resolved to a language PlayOut has). Exported for tests. */
export function setMainLanguage(code: string): void {
  const next = resolveLanguage(code)
  if (next === language) return
  language = next
  translate = createTranslator(next)
  for (const listener of listeners) listener(next)
}

const STEAM_KEY = 'HKCU\\Software\\Valve\\Steam'

/** Steam's interface language (Steam > Settings > Interface), as Steam names it ("spanish"); null without Steam. */
export async function readSteamLanguage(
  run: RunCommand = createRealIo().run
): Promise<string | null> {
  // reg.exe answers in a few milliseconds; the short timeout keeps a stuck one from holding up PlayOut's start.
  const value = await regQuery(
    (file, args) => run(file, args, { timeoutMs: 3000 }),
    STEAM_KEY,
    'Language'
  )
  return typeof value?.data === 'string' && value.data ? value.data : null
}

/** Windows' display languages in the user's order, then Chromium's UI locale (from the same Windows setting). */
async function windowsLanguages(): Promise<string[]> {
  const { app } = await import('electron')
  return [...app.getPreferredSystemLanguages(), app.getLocale()]
}

export interface DetectLanguageDeps {
  steamLanguage(): Promise<string | null>
  systemLanguages(): Promise<string[]> | string[]
  /** The languages PlayOut has; default: every locales folder. */
  available?: readonly string[]
}

/**
 * The language a new install starts in: Steam's interface language when PlayOut has it, else the first of Windows'
 * languages it has (a region falls back to the bare language: es-MX -> es), else English.
 */
export async function detectLanguage(
  deps: DetectLanguageDeps,
  log?: Logger
): Promise<{ code: string; source: LanguageSource }> {
  const steamName = await deps.steamLanguage().catch((err: unknown) => {
    log?.warn(`Steam language not read: ${(err as Error).message}`)
    return null
  })
  const steam = steamLanguageCode(steamName)
  let system: string[] = []
  try {
    system = await deps.systemLanguages()
  } catch (err) {
    log?.warn(`Windows languages not read: ${(err as Error).message}`)
  }
  return pickLanguage(
    [
      { source: 'steam', codes: steam ? [steam] : [] },
      { source: 'windows', codes: system }
    ],
    deps.available ?? languageCodes()
  )
}

/** The parts of SettingsStore this module uses. */
export interface LanguageSettings {
  get(): Settings
  update(patch: SettingsPatch): Settings
  onChange(listener: (settings: Settings) => void): () => void
}

/**
 * At start, before any window opens: on the first start (no language saved yet) detect one and save it, so it never
 * changes on its own afterwards; then keep tMain() on the saved language, which Settings > System > Language changes.
 */
export async function setupLanguage(
  settings: LanguageSettings,
  deps: DetectLanguageDeps = {
    steamLanguage: () => readSteamLanguage(),
    systemLanguages: windowsLanguages
  },
  log: Logger = createLogger('i18n')
): Promise<void> {
  if (!settings.get().system.language) {
    const { code, source } = await detectLanguage(deps, log)
    settings.update({ system: { language: code } })
    log.info(`language set to ${code} (from ${source})`)
  }
  setMainLanguage(settings.get().system.language)
  settings.onChange((next) => setMainLanguage(next.system.language))
}
