import { promises as fs, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { defaultSettings } from '../../shared/defaults'
import type { Settings } from '../../shared/types'
import { EMULATOR_CATALOG } from './catalog'
import { runProcess } from './run'
import { createEmulatorSetupService } from './service'
import type { Runner } from './types'

/**
 * The real thing for Update all emulators: installs melonDS and Flycast (zips: no 7-Zip, nothing run) from their
 * stable releases into PLAYOUT_E2E_DIR, then updates them to their nightly / dev builds from the live feeds, and
 * checks the user's settings stayed. Skipped unless PLAYOUT_E2E_DIR is set. No downloaded program is ever started
 * (only tasklist runs).
 */
const ROOT = process.env.PLAYOUT_E2E_DIR

const log = {
  debug: () => undefined,
  info: (...a: unknown[]) => console.log('[info]', ...a),
  warn: (...a: unknown[]) => console.log('[warn]', ...a),
  error: (...a: unknown[]) => console.log('[error]', ...a)
}

const onlyTasklist: Runner = (file, args, options) => {
  if (file !== 'tasklist') throw new Error(`refusing to run ${file} in this test`)
  return runProcess(file, args, options)
}

describe.skipIf(!ROOT)('Update all emulators against the real feeds', () => {
  it(
    'updates melonDS and Flycast, keeping their settings',
    { timeout: 20 * 60 * 1000 },
    async () => {
      const exeDir = join(ROOT!, 'app')
      const userData = join(ROOT!, 'userData')
      await fs.mkdir(exeDir, { recursive: true })
      await fs.mkdir(join(userData, 'Emulation', 'bios'), { recursive: true })
      let settings: Settings = defaultSettings()
      const service = createEmulatorSetupService({
        settings: {
          get: () => settings,
          update: (patch) => {
            settings = { ...settings, ...(patch as Partial<Settings>) } as Settings
          }
        },
        userData,
        exeDir,
        emit: (p) => {
          if (p.total)
            console.log(`progress ${p.stage} ${p.done}/${p.total} ${p.current?.join(', ') ?? ''}`)
        },
        log,
        run: onlyTasklist,
        presets: {},
        catalog: EMULATOR_CATALOG.filter((s) => s.id === 'MELONDS' || s.id === 'FLYCAST'),
        modules: { runtimesMissing: async () => [], ensureRuntimes: async () => [] }
      })
      const installed = await service.setup()
      const E = (folder: string): string => join(exeDir, 'Emulators', folder)
      expect(installed.items.every((i) => i.state === 'installed')).toBe(true)
      const stable = Object.fromEntries(installed.items.map((i) => [i.id, i.version]))
      const toml = join(E('melonDS'), 'melonDS.toml')
      await fs.appendFile(toml, '\n# my own setting\n')
      const tomlBefore = readFileSync(toml, 'utf8')
      const cfgBefore = readFileSync(join(E('Flycast'), 'emu.cfg'), 'utf8')
      const exeBefore = statSync(join(E('melonDS'), 'melonDS.exe')).size

      const after = await service.update()
      console.log(JSON.stringify(after.lastUpdate, null, 1))
      for (const item of after.lastUpdate!.items) {
        expect(item.result, `${item.name}: ${item.error ?? ''}`).toBe('updated')
        expect(item.to).not.toBe(stable[item.id])
      }
      expect(after.items.find((i) => i.id === 'MELONDS')?.channel).toBe('nightly')
      expect(readFileSync(toml, 'utf8')).toContain('# my own setting')
      expect(readFileSync(toml, 'utf8').length).toBeGreaterThanOrEqual(tomlBefore.length - 1)
      expect(readFileSync(join(E('Flycast'), 'emu.cfg'), 'utf8')).toContain('Dreamcast.BiosPath')
      expect(cfgBefore).toContain('Dreamcast.BiosPath')
      console.log(
        `melonDS.exe ${exeBefore} -> ${statSync(join(E('melonDS'), 'melonDS.exe')).size} bytes`
      )
      await expect(fs.access(join(E('.playout'), 'update-backup', 'melonDS'))).rejects.toThrow()

      // A second press finds nothing newer.
      const again = await service.update()
      expect(again.lastUpdate!.items.map((i) => i.result)).toEqual(['current', 'current'])
      await service.dispose()
    }
  )
})
