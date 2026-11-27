import { defaultSettings } from '@shared/defaults'
import type { Settings, SettingsPatch } from '@shared/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  detectLanguage,
  mainLanguage,
  onMainLanguageChange,
  readSteamLanguage,
  setMainLanguage,
  setupLanguage,
  tMain
} from '.'

const quiet = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

function fakeSettings(language: string): {
  store: Parameters<typeof setupLanguage>[0]
  emit: (s: Settings) => void
  current: () => Settings
} {
  let settings = defaultSettings()
  settings.system.language = language
  const listeners: ((s: Settings) => void)[] = []
  return {
    store: {
      get: () => settings,
      update: (patch: SettingsPatch) => {
        settings = { ...settings, system: { ...settings.system, ...patch.system } }
        return settings
      },
      onChange: (l) => {
        listeners.push(l)
        return () => undefined
      }
    },
    emit: (s) => {
      settings = s
      for (const l of listeners) l(s)
    },
    current: () => settings
  }
}

afterEach(() => setMainLanguage('en'))

describe('main language', () => {
  it("prefers Steam's language, then Windows', then English", async () => {
    const available = ['en', 'es']
    expect(
      await detectLanguage({
        steamLanguage: async () => 'latam',
        systemLanguages: () => ['en-US'],
        available
      })
    ).toEqual({ code: 'es', source: 'steam' })
    expect(
      await detectLanguage({
        steamLanguage: async () => 'french',
        systemLanguages: () => ['de-DE', 'es-MX'],
        available
      })
    ).toEqual({ code: 'es', source: 'windows' })
    expect(
      await detectLanguage(
        {
          steamLanguage: async () => {
            throw new Error('no reg.exe')
          },
          systemLanguages: () => {
            throw new Error('no app')
          },
          available
        },
        quiet
      )
    ).toEqual({ code: 'en', source: 'default' })
  })

  it('detects and saves a language on the first start only, then follows the setting', async () => {
    const steamLanguage = vi.fn(async () => 'spanish')
    const fresh = fakeSettings('')
    await setupLanguage(fresh.store, { steamLanguage, systemLanguages: () => [] }, quiet)
    expect(fresh.current().system.language).toBe('es')
    expect(mainLanguage()).toBe('es')
    expect(tMain('settingsSystem.language.label')).toBe('Idioma')

    const changed = vi.fn()
    const off = onMainLanguageChange(changed)
    fresh.emit({ ...fresh.current(), system: { ...fresh.current().system, language: 'en' } })
    expect(tMain('settingsSystem.language.label')).toBe('Language')
    expect(changed).toHaveBeenCalledWith('en')
    off()

    // A language already chosen is never detected again.
    const chosen = fakeSettings('en')
    steamLanguage.mockClear()
    await setupLanguage(chosen.store, { steamLanguage, systemLanguages: () => ['es'] }, quiet)
    expect(steamLanguage).not.toHaveBeenCalled()
    expect(chosen.current().system.language).toBe('en')
  })

  it("reads Steam's language with reg.exe", async () => {
    const run = vi.fn(async () => ({
      code: 0,
      stdout:
        '\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    Language    REG_SZ    spanish\r\n',
      stderr: ''
    }))
    expect(await readSteamLanguage(run)).toBe('spanish')
    expect(run).toHaveBeenCalledWith(
      'reg.exe',
      ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'Language'],
      { timeoutMs: 3000 }
    )
    expect(await readSteamLanguage(async () => ({ code: 1, stdout: '', stderr: '' }))).toBeNull()
  })
})
