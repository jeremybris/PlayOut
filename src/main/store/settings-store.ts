import { promises as fs } from 'fs'
import { defaultSettings, SETTINGS_VERSION } from '../../shared/defaults'
import type { Settings, SettingsPatch } from '../../shared/types'
import { clone, deepMerge } from '../util/object'
import { JsonStore } from './json-store'
import { normalizeSettings } from './settings-schema'

export class SettingsStore {
  private readonly store: JsonStore<Settings>

  constructor(private readonly file: string) {
    this.store = new JsonStore<Settings>({
      file,
      defaults: defaultSettings,
      // Every field is validated on load and repaired from defaults when malformed (settings-schema.ts).
      normalize: normalizeSettings
    })
  }

  async load(): Promise<Settings> {
    const settings = await this.store.load()
    // Loading drops fields the app no longer has (the MobyGames API key) but does not write the file: write it once
    // now, so a removed service's key does not stay on disk.
    const text = await fs.readFile(this.file, 'utf8').catch(() => '')
    if (/"mobygames"\s*:/.test(text)) this.store.replace(clone(settings))
    return settings
  }

  get(): Settings {
    return this.store.get()
  }

  /** Deep-merge a patch. Callers validate the patch first (handlers.ts: parseSettingsPatch). */
  update(patch: SettingsPatch): Settings {
    const next = deepMerge(clone(this.store.get()), patch)
    next.version = SETTINGS_VERSION
    next.input.deadzone = Math.min(0.9, Math.max(0, next.input.deadzone))
    next.ui.recentCount = Math.min(40, Math.max(4, Math.round(next.ui.recentCount)))
    return this.store.replace(next)
  }

  /** Direct mutation for replace semantics (deleting keys from records). */
  mutate(mutator: (settings: Settings) => void): Settings {
    return this.store.set((d) => {
      mutator(d)
    })
  }

  onChange(listener: (settings: Settings) => void): () => void {
    return this.store.onChange(listener)
  }

  /** `flush()` that tells whether the write reached the disk (false = it failed); never rejects. */
  tryFlush(): Promise<boolean> {
    return this.store.tryFlush()
  }

  flush(): Promise<void> {
    return this.store.flush()
  }
}
