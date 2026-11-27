import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../../shared/defaults'
import type { EmulatorSetupProgress, Settings, SettingsPatch } from '../../shared/types'
import { deepMerge } from '../util/object'
import { flattenSingleRoot } from './archive'
import {
  createEmulatorSetupService,
  DISPOSE_WAIT_MS,
  isUnder,
  migrateLegacyRoot,
  rebasePath,
  type EmulatorSetupDeps,
  type EmulatorSetupService,
  type EmulatorSetupModules
} from './service'
import { PresetDeferredError, type PresetContext } from './presets/types'
import type { EmulatorSpec, ResolvedDownload, SetupManifest } from './types'

// The real presets (and Ryujinx's controller refresh) are tested in presets/*.test.ts; here they are injected.
vi.mock('./presets', () => ({ PRESETS: {}, PRESETS_VERSION: 1 }))
vi.mock('./presets/ryujinx', () => ({ refreshRyujinxControllers: vi.fn(async () => undefined) }))

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

const CATALOG: EmulatorSpec[] = [
  {
    id: 'ALPHA',
    name: 'Alpha',
    folder: 'Alpha',
    exe: 'alpha.exe',
    source: {
      kind: 'fixed',
      url: 'https://example.test/alpha.zip',
      version: '1.0',
      sha256: 'x',
      fileName: 'alpha.zip'
    },
    runtimes: ['vcredist']
  },
  {
    id: 'BETA',
    name: 'Beta',
    folder: 'Beta',
    exe: 'beta.exe',
    source: {
      kind: 'fixed',
      url: 'https://example.test/beta.7z',
      version: '2.0',
      sha256: 'y',
      fileName: 'beta.7z'
    }
  }
]

interface FakeSettings {
  get(): Settings
  update(patch: SettingsPatch): Settings
  onChange(listener: (s: Settings) => void): () => void
}

interface Calls {
  resolve: string[]
  configure: { id: string; emuDir: string; dataDir: string }[]
  bios: number
  runtimes: string[][]
  sevenZip: number
  /** Drive folder ids downloaded. */
  drive: string[]
}

function fakeSettings(
  initial?: Partial<Settings['emulators']>,
  emulationDir: string | null = null
): FakeSettings {
  let current: Settings = defaultSettings()
  current.emulators = { ...current.emulators, ...initial }
  current.library.emulationDir = emulationDir
  const listeners: ((s: Settings) => void)[] = []
  return {
    get: () => current,
    update(patch: SettingsPatch) {
      current = deepMerge(structuredClone(current), patch) as Settings
      for (const l of listeners) l(current)
      return current
    },
    onChange(listener: (s: Settings) => void) {
      listeners.push(listener)
      return () => listeners.splice(listeners.indexOf(listener), 1)
    }
  }
}

/** Fake modules: the "archive" holds the exe name, the extractor writes it into the destination. */
function fakeModules(options: { failId?: string } = {}): {
  modules: EmulatorSetupModules
  calls: Calls
} {
  const calls: Calls = {
    resolve: [] as string[],
    configure: [] as { id: string; emuDir: string; dataDir: string }[],
    bios: 0,
    runtimes: [] as string[][],
    sevenZip: 0,
    drive: [] as string[]
  }
  const modules: EmulatorSetupModules = {
    async resolveSource(spec) {
      if (spec.kind !== 'fixed') throw new Error('unexpected source')
      calls.resolve.push(spec.url)
      if (options.failId && spec.url.includes(options.failId.toLowerCase()))
        throw new Error('HTTP 404')
      return [{ version: spec.version, url: spec.url, fileName: spec.fileName, size: 10 }]
    },
    async downloadFile(d: ResolvedDownload, dir, _deps, onBytes) {
      const file = join(dir, d.fileName)
      await fs.writeFile(file, basename(d.url).replace(/\.\w+$/, '.exe'))
      onBytes?.(5, 10)
      onBytes?.(10, 10)
      return file
    },
    // A Drive folder: '<exe>' plus a settings file; folder id 'no-exe' has no exe.
    async downloadDriveFolder(source, dest, _deps, onProgress) {
      calls.drive.push(source.folderId)
      await fs.mkdir(join(dest, 'config'), { recursive: true })
      await fs.writeFile(join(dest, 'config', 'mine.yml'), 'preconfigured')
      onProgress?.({ filesDone: 1, filesTotal: 2, bytesDone: 13 })
      if (source.folderId !== 'no-exe') await fs.writeFile(join(dest, 'drive.exe'), 'exe')
      onProgress?.({ filesDone: 2, filesTotal: 2, bytesDone: 16 })
      return { files: 2, downloaded: 2 }
    },
    async ensureSevenZip(workDir) {
      calls.sevenZip++
      return join(workDir, '7zr.exe')
    },
    async extractArchive(file, destDir, deps) {
      if (file.endsWith('.7z')) await deps.sevenZip()
      const exe = await fs.readFile(file, 'utf8')
      await fs.mkdir(destDir, { recursive: true })
      await fs.writeFile(join(destDir, exe), 'exe')
      await fs.writeFile(join(destDir, 'readme.txt'), 'new')
    },
    async configureEmulator(id, ctx) {
      calls.configure.push({ id, emuDir: ctx.emuDir, dataDir: ctx.dataDir })
    },
    async syncBios() {
      calls.bios++
      return []
    },
    async runtimesMissing(needs) {
      calls.runtimes.push(needs)
      return needs
    },
    async ensureRuntimes() {
      return ['runtime notice']
    }
  }
  return { modules, calls }
}

describe('emulator setup service', () => {
  let dir: string
  let exeDir: string
  let userData: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'playout-emu-setup-'))
    exeDir = join(dir, 'app')
    userData = join(dir, 'userData')
    await fs.mkdir(exeDir, { recursive: true })
    await fs.mkdir(userData, { recursive: true })
    vi.clearAllMocks()
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  function make(
    modules: EmulatorSetupModules,
    settings = fakeSettings(),
    extra: Partial<EmulatorSetupDeps> = {}
  ): {
    service: EmulatorSetupService
    emitted: EmulatorSetupProgress[]
    onInstalled: ReturnType<typeof vi.fn>
    settings: FakeSettings
  } {
    const emitted: EmulatorSetupProgress[] = []
    const onInstalled = vi.fn()
    const service = createEmulatorSetupService({
      settings,
      userData,
      exeDir,
      emit: (p) => emitted.push(p),
      log,
      onInstalled,
      catalog: CATALOG,
      modules,
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
      runElevated: async () => 0,
      readRegistry: async () => null,
      debounceMs: 10,
      progressIntervalMs: 0,
      ...extra
    })
    return { service, emitted, onInstalled, settings }
  }

  const root = (): string => join(exeDir, 'Emulators')
  const readManifest = async (r = root()): Promise<SetupManifest> =>
    JSON.parse(await fs.readFile(join(r, '.playout', 'emulators.json'), 'utf8'))
  const writeManifest = async (patch: Partial<SetupManifest>, r = root()): Promise<void> => {
    const manifest: SetupManifest = {
      version: 1,
      installed: {},
      configuredFor: null,
      configured: {},
      completed: false,
      presets: {},
      ...patch
    }
    await fs.mkdir(join(r, '.playout'), { recursive: true })
    await fs.writeFile(join(r, '.playout', 'emulators.json'), JSON.stringify(manifest))
  }
  const putExe = async (r: string, folder: string, exe: string): Promise<string> => {
    await fs.mkdir(join(r, folder), { recursive: true })
    await fs.writeFile(join(r, folder, exe), 'exe')
    return join(r, folder, exe)
  }

  it('installs every missing emulator, writes the manifest and cleans up', async () => {
    const { modules, calls } = fakeModules()
    const { service, emitted, onInstalled } = make(modules)
    const status = await service.setup()

    expect(status.root).toBe(root())
    expect(status.items.map((i) => [i.id, i.state, i.version])).toEqual([
      ['ALPHA', 'installed', '1.0'],
      ['BETA', 'installed', '2.0']
    ])
    expect(status.notices).toEqual(['runtime notice'])
    expect(calls.runtimes).toEqual([['vcredist']])
    expect(calls.sevenZip).toBe(1)
    expect(calls.configure.map((c) => c.id).sort()).toEqual(['ALPHA', 'BETA'])
    expect(calls.bios).toBe(1)
    expect(onInstalled).toHaveBeenCalledTimes(1)

    const manifest = await readManifest()
    expect(manifest.installed.ALPHA.exe).toBe(join(root(), 'Alpha', 'alpha.exe'))
    expect(manifest.configuredFor).toBe(join(userData, 'Emulation'))
    expect(service.managedExe('BETA')).toBe(join(root(), 'Beta', 'beta.exe'))
    expect(service.managedExe('GAMMA')).toBeNull()

    // Archives and staging folders are gone.
    expect(await fs.readdir(join(root(), '.playout', 'downloads'))).toEqual([])
    expect((await fs.readdir(root())).sort()).toEqual(['.playout', 'Alpha', 'Beta'])

    expect(emitted.at(-1)).toEqual({ done: 0, total: 0 })
    expect(emitted.some((p) => p.stage === 'emulators' && p.total === 2)).toBe(true)
    expect(emitted.some((p) => (p.bytesDone ?? 0) > 0)).toBe(true)
    expect(manifest.completed).toBe(true)
  })

  it('records a failure and continues with the others', async () => {
    const { modules } = fakeModules({ failId: 'ALPHA' })
    const { service } = make(modules)
    const status = await service.setup()
    expect(status.items.find((i) => i.id === 'ALPHA')).toMatchObject({
      state: 'failed',
      error: 'HTTP 404'
    })
    expect(status.items.find((i) => i.id === 'BETA')?.state).toBe('installed')
    expect(Object.keys((await readManifest()).installed)).toEqual(['BETA'])
    expect((await readManifest()).completed).toBe(false)
  })

  it('startup marks the manifest completed only when every emulator is installed, then resumes the missing ones', async () => {
    const first = fakeModules({ failId: 'BETA' })
    const settings = fakeSettings()
    const a = make(first.modules, settings)
    await a.service.startup()
    a.service.dispose()
    expect((await readManifest()).completed).toBe(false)

    // Next launch: Alpha is kept, Beta is retried.
    const second = fakeModules()
    const b = make(second.modules, settings)
    expect(b.service.managedExe('ALPHA')).toBe(join(root(), 'Alpha', 'alpha.exe'))
    await b.service.startup()
    b.service.dispose()
    expect(second.calls.resolve).toEqual(['https://example.test/beta.7z'])
    expect(second.calls.runtimes).toEqual([])
    expect((await readManifest()).completed).toBe(true)
    expect(Object.keys((await readManifest()).installed).sort()).toEqual(['ALPHA', 'BETA'])
    // The BIOS files are synced once per startup.
    expect(second.calls.bios).toBe(1)
  })

  it('resumes into a folder left by an interrupted run, keeping its other files', async () => {
    await fs.mkdir(join(root(), 'Alpha'), { recursive: true })
    await fs.writeFile(join(root(), 'Alpha', 'user.ini'), 'mine')
    await fs.mkdir(join(root(), '.Alpha.extracting'), { recursive: true })
    await fs.writeFile(join(root(), '.Alpha.extracting', 'stale.bin'), 'x')
    const { modules } = fakeModules()
    const { service } = make(modules)
    await service.setup(['ALPHA'])
    expect(await fs.readFile(join(root(), 'Alpha', 'user.ini'), 'utf8')).toBe('mine')
    expect(await fs.readFile(join(root(), 'Alpha', 'alpha.exe'), 'utf8')).toBe('exe')
    await expect(fs.stat(join(root(), 'Alpha', 'stale.bin'))).rejects.toThrow()
  })

  it('does nothing when the manifest is completed', async () => {
    const { modules, calls } = fakeModules()
    const settings = fakeSettings()
    await writeManifest({ completed: true })
    const { service } = make(modules, settings)
    await service.startup()
    service.dispose()
    expect(calls.resolve).toEqual([])
    expect(calls.configure).toEqual([])
    expect(calls.bios).toBe(1)
  })

  it('reconfigures the installed emulators when the data folder changes', async () => {
    const { modules, calls } = fakeModules()
    const settings = fakeSettings()
    const { service } = make(modules, settings)
    await service.startup()
    calls.configure.length = 0
    const biosBefore = calls.bios

    const newDir = join(dir, 'MyEmulation')
    settings.update({ library: { emulationDir: newDir } })
    await vi.waitFor(async () => expect((await readManifest()).configuredFor).toBe(newDir))
    expect(calls.configure.map((c) => [c.id, c.dataDir]).sort()).toEqual([
      ['ALPHA', newDir],
      ['BETA', newDir]
    ])
    expect(calls.bios).toBe(biosBefore + 1)
    const status = await service.status()
    expect(status.emulationDir).toBe(newDir)
    expect(status.biosDir).toBe(join(newDir, 'bios'))
    service.dispose()
  })

  it('reconfigures at startup when the manifest points at another data folder', async () => {
    const { modules, calls } = fakeModules()
    const settings = fakeSettings()
    const a = make(modules, settings)
    await a.service.setup()
    a.service.dispose()
    // Changed while PlayOut was closed.
    const newDir = join(dir, 'Elsewhere')
    settings.get().library.emulationDir = newDir
    calls.configure.length = 0
    const b = make(modules, settings)
    await b.service.startup()
    b.service.dispose()
    expect(calls.configure.map((c) => c.dataDir)).toEqual([newDir, newDir])
    expect((await readManifest()).configuredFor).toBe(newDir)
  })

  it('falls back to <userData>\\Emulators when the exe folder cannot be written', async () => {
    // A file where the Emulators folder would be: it can be neither made nor written.
    await fs.writeFile(join(exeDir, 'Emulators'), 'not a folder')
    const { modules } = fakeModules()
    const { service } = make(modules)
    const status = await service.setup(['BETA'])
    expect(status.root).toBe(join(userData, 'Emulators'))
    expect(status.items.find((i) => i.id === 'BETA')?.state).toBe('installed')
    expect((await readManifest(join(userData, 'Emulators'))).installed.BETA).toBeDefined()
  })

  it('points emulators recorded in a folder that is gone at the moved Emulators folder (PlayOut moved)', async () => {
    const alpha = await putExe(root(), 'Alpha', 'alpha.exe')
    const gone = join(tmpdir(), 'gone-playout', 'Emulators', 'Alpha', 'alpha.exe')
    await writeManifest({
      completed: true,
      installed: { ALPHA: { version: '1.0', exe: gone, installedAt: 'x' } }
    })
    const { modules } = fakeModules()
    const { service } = make(modules)
    expect(service.managedExe('ALPHA')).toBe(alpha)
    await service.status()
    await vi.waitFor(async () => expect((await readManifest()).installed.ALPHA?.exe).toBe(alpha))
    service.dispose()
  })

  it('treats a corrupt manifest as empty', async () => {
    await fs.mkdir(join(root(), '.playout'), { recursive: true })
    await fs.writeFile(join(root(), '.playout', 'emulators.json'), '{"version":7')
    const { modules } = fakeModules()
    const { service } = make(modules)
    expect(service.managedExe('ALPHA')).toBeNull()
    const status = await service.status()
    expect(status.items.every((i) => i.state === 'missing')).toBe(true)
    expect(status.progress).toEqual({ done: 0, total: 0 })
  })

  it('merges a second request into the running setup', async () => {
    const { modules, calls } = fakeModules()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const resolveSource = modules.resolveSource
    modules.resolveSource = async (spec, deps) => {
      await gate
      return resolveSource(spec, deps)
    }
    const { service } = make(modules)
    const first = service.setup(['ALPHA'])
    const second = service.setup(['ALPHA', 'BETA'])
    expect((await service.status()).items.map((i) => i.state)).toEqual(['installing', 'installing'])
    release()
    const [s1, s2] = await Promise.all([first, second])
    expect(s2.items.map((i) => i.state)).toEqual(['installed', 'installed'])
    expect(s1.items[0].state).toBe('installed')
    expect(calls.resolve.filter((u) => u.includes('alpha'))).toHaveLength(1)
  })

  it('never lets startup throw', async () => {
    const { modules } = fakeModules()
    modules.syncBios = async () => {
      throw new Error('boom')
    }
    const settings = fakeSettings()
    await writeManifest({ completed: true })
    const { service } = make(modules, settings)
    await expect(service.startup()).resolves.toBeUndefined()
    service.dispose()
    expect(log.error).toHaveBeenCalled()
  })

  describe('RetroArch (frontend + cores archives)', () => {
    const RETROARCH: EmulatorSpec = {
      id: 'RETROARCH',
      name: 'RetroArch',
      folder: 'RetroArch',
      exe: 'retroarch.exe',
      source: { kind: 'retroarch' }
    }

    /** The buildbot's layout: RetroArch-Win64\retroarch.exe and RetroArch-Win64\cores\*.dll. */
    function retroArchModules(withCores: boolean): EmulatorSetupModules {
      const { modules } = fakeModules()
      modules.resolveSource = async () => [
        { version: '1.19.1', url: 'https://example.test/RetroArch.7z', fileName: 'RetroArch.7z' },
        {
          version: '1.19.1',
          url: 'https://example.test/RetroArch_cores.7z',
          fileName: 'RetroArch_cores.7z'
        }
      ]
      modules.extractArchive = async (file, dest, _deps, options) => {
        const top = join(dest, 'RetroArch-Win64')
        if (basename(file).startsWith('RetroArch_cores')) {
          await fs.mkdir(join(top, 'cores'), { recursive: true })
          if (withCores) await fs.writeFile(join(top, 'cores', 'snes9x_libretro.dll'), 'dll')
          else await fs.writeFile(join(top, 'cores', 'readme.txt'), 'none')
        } else {
          await fs.mkdir(top, { recursive: true })
          await fs.writeFile(join(top, 'retroarch.exe'), 'exe')
        }
        await flattenSingleRoot(dest, options?.flattenLevels ?? 2)
      }
      return modules
    }

    it('keeps the cores in <RetroArch>\\cores', async () => {
      const { service } = make(retroArchModules(true), fakeSettings(), { catalog: [RETROARCH] })
      const status = await service.setup()
      expect(status.items[0]).toMatchObject({ id: 'RETROARCH', state: 'installed' })
      const emuDir = join(root(), 'RetroArch')
      expect((await fs.readdir(emuDir)).sort()).toEqual(['cores', 'retroarch.exe'])
      expect(await fs.readdir(join(emuDir, 'cores'))).toEqual(['snes9x_libretro.dll'])
    })

    it('records a failure when the cores are missing after unpacking', async () => {
      const { service } = make(retroArchModules(false), fakeSettings(), { catalog: [RETROARCH] })
      const status = await service.setup()
      expect(status.items[0]).toMatchObject({
        state: 'failed',
        error: 'RetroArch cores were not found after unpacking'
      })
      await expect(fs.stat(join(root(), 'RetroArch'))).rejects.toThrow()
    })
  })

  describe('an exe the manifest does not know', () => {
    it('is found by managedExe and adopted by a setup run', async () => {
      const alpha = await putExe(root(), 'Alpha', 'alpha.exe')
      const { modules, calls } = fakeModules()
      const { service } = make(modules)
      expect(service.managedExe('ALPHA')).toBe(alpha)
      await service.setup(['BETA'])
      expect(calls.resolve).toEqual(['https://example.test/beta.7z'])
      const dataDir = join(userData, 'Emulation')
      expect(calls.configure.map((c) => [c.id, c.dataDir]).sort()).toEqual([
        ['ALPHA', dataDir],
        ['BETA', dataDir]
      ])
      const manifest = await readManifest()
      expect(manifest.installed.ALPHA).toMatchObject({ version: 'unknown', exe: alpha })
      expect(manifest.configuredFor).toBe(dataDir)
      expect(manifest.completed).toBe(true)
    })

    it('is adopted at startup when setup is already completed', async () => {
      const dataDir = join(userData, 'Emulation')
      const beta = await putExe(root(), 'Beta', 'beta.exe')
      const alpha = await putExe(root(), 'Alpha', 'alpha.exe')
      await writeManifest({
        completed: true,
        configuredFor: dataDir,
        installed: { BETA: { version: '2.0', exe: beta, installedAt: 'x' } }
      })
      const { modules, calls } = fakeModules()
      const { service } = make(modules)
      await service.startup()
      service.dispose()
      expect(calls.resolve).toEqual([])
      expect(calls.configure.map((c) => [c.id, c.dataDir])).toEqual([['ALPHA', dataDir]])
      const manifest = await readManifest()
      expect(manifest.installed.ALPHA).toMatchObject({ version: 'unknown', exe: alpha })
      expect(manifest.configuredFor).toBe(dataDir)
    })

    it('holds a running outdated emulator on a data folder change too, and a launch waits for its run', async () => {
      const alpha = await putExe(root(), 'Alpha', 'alpha.exe')
      const beta = await putExe(root(), 'Beta', 'beta.exe')
      await writeManifest({
        completed: true,
        // Pointed at another folder: this start takes the data folder change path.
        configuredFor: join(userData, 'Elsewhere'),
        installed: {
          ALPHA: { version: '1.0', exe: alpha, installedAt: 'x' },
          BETA: { version: '1.0', exe: beta, installedAt: 'x' }
        }
      })
      const configureVersionOf = (id: string): number => (id === 'ALPHA' ? 2 : 1)
      let running = '"alpha.exe","1"\r\n'
      const run: EmulatorSetupDeps['run'] = async (file) => ({
        code: 0,
        stdout: file === 'tasklist' ? running : '',
        stderr: ''
      })
      const first = fakeModules()
      const one = make(first.modules, fakeSettings(), { configureVersionOf, run })
      await one.service.startup()
      one.service.dispose()
      // BETA is pointed at the folder; ALPHA waits, so the folder is not recorded as done.
      expect(first.calls.configure.map((c) => c.id)).toEqual(['BETA'])
      expect((await readManifest()).configuredFor).toBeNull()

      // Next start, ALPHA closed: its run is slow, and a launch of ALPHA meanwhile waits for it.
      running = ''
      const second = fakeModules()
      let finish: () => void = () => {}
      const order: string[] = []
      second.modules.configureEmulator = async (id) => {
        order.push(`configure ${id}`)
        if (id === 'ALPHA') await new Promise<void>((r) => (finish = r))
        order.push(`configured ${id}`)
      }
      const two = make(second.modules, fakeSettings(), { configureVersionOf, run })
      const started = two.service.startup()
      await vi.waitFor(() => expect(order).toContain('configure ALPHA'))
      const launch = two.service
        .beforeLaunch('ALPHA', alpha, undefined)
        .then(() => order.push('launch'))
      await new Promise((r) => setTimeout(r, 20))
      expect(order).not.toContain('launch')
      finish()
      await launch
      await started
      two.service.dispose()
      expect(order.indexOf('configured ALPHA')).toBeLessThan(order.indexOf('launch'))
      expect((await readManifest()).configured).toMatchObject({ ALPHA: 2 })
    })

    it('configures again only the emulators whose configurator changed, not while they run', async () => {
      const dataDir = join(userData, 'Emulation')
      const alpha = await putExe(root(), 'Alpha', 'alpha.exe')
      const beta = await putExe(root(), 'Beta', 'beta.exe')
      // Written by 0.1.108 or older: no configure versions, already pointed at this data folder.
      await writeManifest({
        completed: true,
        configuredFor: dataDir,
        configured: undefined as unknown as Record<string, number>,
        installed: {
          ALPHA: { version: '1.0', exe: alpha, installedAt: 'x' },
          BETA: { version: '1.0', exe: beta, installedAt: 'x' }
        }
      })
      // This PlayOut changed ALPHA's configurator only.
      const configureVersionOf = (id: string): number => (id === 'ALPHA' ? 2 : 1)
      let running = '"alpha.exe","1"\r\n'
      const run: EmulatorSetupDeps['run'] = async (file) => ({
        code: 0,
        stdout: file === 'tasklist' ? running : '',
        stderr: ''
      })
      // ALPHA is running: left for the next start, its version not recorded.
      const first = fakeModules()
      const one = make(first.modules, fakeSettings(), { configureVersionOf, run })
      await one.service.startup()
      one.service.dispose()
      expect(first.calls.configure).toEqual([])
      expect((await readManifest()).configured?.ALPHA).toBeUndefined()
      // Closed: ALPHA alone is configured again (BETA keeps the folder settings its user may have changed).
      running = ''
      const second = fakeModules()
      const two = make(second.modules, fakeSettings(), { configureVersionOf, run })
      await two.service.startup()
      two.service.dispose()
      expect(second.calls.configure.map((c) => [c.id, c.dataDir])).toEqual([['ALPHA', dataDir]])
      expect((await readManifest()).configured).toEqual({ ALPHA: 2 })
      // Once done, the next start leaves them alone.
      const third = fakeModules()
      const three = make(third.modules, fakeSettings(), { configureVersionOf, run })
      await three.service.startup()
      three.service.dispose()
      expect(third.calls.configure).toEqual([])
    })

    it('updates an outdated emulator when the process list cannot be read, instead of holding it forever', async () => {
      const dataDir = join(userData, 'Emulation')
      const alpha = await putExe(root(), 'Alpha', 'alpha.exe')
      await writeManifest({
        completed: true,
        configuredFor: dataDir,
        installed: { ALPHA: { version: '1.0', exe: alpha, installedAt: 'x' } }
      })
      const { modules, calls } = fakeModules()
      const { service } = make(modules, fakeSettings(), {
        configureVersionOf: (id) => (id === 'ALPHA' ? 2 : 1),
        run: async () => ({ code: 1, stdout: '', stderr: 'tasklist failed' })
      })
      await service.startup()
      service.dispose()
      expect(calls.configure.map((c) => c.id)).toEqual(['ALPHA'])
      expect((await readManifest()).configured).toMatchObject({ ALPHA: 2 })
    })
  })

  it('uses one data folder for a whole run, then reconfigures for one changed meanwhile', async () => {
    const { modules, calls } = fakeModules()
    const settings = fakeSettings()
    const biosDirs: string[] = []
    modules.syncBios = async (ctx) => {
      biosDirs.push(ctx.dataDir)
      return []
    }
    const configure = modules.configureEmulator
    const newDir = join(dir, 'Moved')
    modules.configureEmulator = async (id, ctx) => {
      if (!settings.get().library.emulationDir)
        settings.update({ library: { emulationDir: newDir } })
      await configure(id, ctx)
    }
    const { service } = make(modules, settings)
    await service.setup()
    const oldDir = join(userData, 'Emulation')
    expect(calls.configure.slice(0, 2).map((c) => c.dataDir)).toEqual([oldDir, oldDir])
    expect(biosDirs[0]).toBe(oldDir)
    await vi.waitFor(async () => expect((await readManifest()).configuredFor).toBe(newDir))
    expect(
      calls.configure
        .filter((c) => c.dataDir === newDir)
        .map((c) => c.id)
        .sort()
    ).toEqual(['ALPHA', 'BETA'])
    expect(biosDirs).toContain(newDir)
    service.dispose()
  })

  describe('root choice', () => {
    it('never uses a folder under Program Files', async () => {
      const { modules } = fakeModules()
      const { service } = make(modules, fakeSettings(), {
        programFilesDirs: [`${exeDir.toUpperCase()}\\`]
      })
      const status = await service.setup(['BETA'])
      expect(status.root).toBe(join(userData, 'Emulators'))
      await expect(fs.stat(root())).rejects.toThrow()
    })

    it('prefers a root that already holds an install', async () => {
      const fallback = join(userData, 'Emulators')
      const alpha = await putExe(fallback, 'Alpha', 'alpha.exe')
      await writeManifest(
        { installed: { ALPHA: { version: '1.0', exe: alpha, installedAt: 'x' } } },
        fallback
      )
      const { modules, calls } = fakeModules()
      const { service } = make(modules)
      const status = await service.setup()
      expect(status.root).toBe(fallback)
      expect(calls.resolve).toEqual(['https://example.test/beta.7z'])
      expect((await readManifest(fallback)).installed.BETA).toBeDefined()
    })

    it('keeps the manifest found at creation when the chosen root has none', async () => {
      const fallback = join(userData, 'Emulators')
      const elsewhere = await putExe(join(dir, 'elsewhere'), 'Alpha', 'alpha.exe')
      // Its exe is not under the fallback root, so the preferred root is chosen.
      await writeManifest(
        {
          completed: true,
          installed: { ALPHA: { version: '1.0', exe: elsewhere, installedAt: 'x' } }
        },
        fallback
      )
      const { modules, calls } = fakeModules()
      const { service } = make(modules)
      expect((await service.status()).root).toBe(root())
      expect(service.managedExe('ALPHA')).toBe(elsewhere)
      // This root's setup is not done: startup installs here.
      await service.startup()
      service.dispose()
      expect(calls.resolve.sort()).toEqual([
        'https://example.test/alpha.zip',
        'https://example.test/beta.7z'
      ])
      expect((await readManifest()).completed).toBe(true)
    })
  })
})

describe('fullscreen and controller presets', () => {
  let dir: string
  let exeDir: string
  let userData: string
  const root = (): string => join(exeDir, 'Emulators')

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'playout-emu-presets-'))
    exeDir = join(dir, 'app')
    userData = join(dir, 'userData')
    await fs.mkdir(exeDir, { recursive: true })
    await fs.mkdir(userData, { recursive: true })
    vi.clearAllMocks()
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  const readManifest = async (): Promise<SetupManifest> =>
    JSON.parse(await fs.readFile(join(root(), '.playout', 'emulators.json'), 'utf8'))

  /** A manifest as PlayOut 0.1.82 wrote it (no presets field), with both emulators installed. */
  async function existingInstall(extra: Record<string, unknown> = {}): Promise<void> {
    const installed: SetupManifest['installed'] = {}
    for (const spec of CATALOG) {
      await fs.mkdir(join(root(), spec.folder), { recursive: true })
      await fs.writeFile(join(root(), spec.folder, spec.exe), 'exe')
      installed[spec.id] = {
        version: '1',
        exe: join(root(), spec.folder, spec.exe),
        installedAt: 'then'
      }
    }
    await fs.mkdir(join(root(), '.playout'), { recursive: true })
    await fs.writeFile(
      join(root(), '.playout', 'emulators.json'),
      JSON.stringify({
        version: 1,
        installed,
        configuredFor: join(userData, 'Emulation'),
        completed: true,
        ...extra
      })
    )
  }

  type Preset = (ctx: PresetContext) => Promise<void>
  interface Applied {
    id: string
    ctx: PresetContext
  }
  function presetsRecorder(fail: string[] = []): {
    presets: Record<string, Preset>
    applied: Applied[]
  } {
    const applied: Applied[] = []
    const one =
      (id: string): Preset =>
      async (ctx) => {
        applied.push({ id, ctx })
        if (fail.includes(id)) throw new Error('locked file')
      }
    return { presets: { ALPHA: one('ALPHA'), BETA: one('BETA') }, applied }
  }

  function make(
    presets: Record<string, Preset>,
    extra: Partial<EmulatorSetupDeps> = {}
  ): { service: EmulatorSetupService; runCalls: string[][] } {
    const runCalls: string[][] = []
    const service = createEmulatorSetupService({
      settings: fakeSettings(),
      userData,
      exeDir,
      emit: () => undefined,
      log,
      catalog: CATALOG,
      modules: fakeModules().modules,
      run: async (file, args) => {
        runCalls.push([file, ...args])
        return { code: 0, stdout: '', stderr: '' }
      },
      runElevated: async () => 0,
      readRegistry: async () => null,
      debounceMs: 10,
      progressIntervalMs: 0,
      presets,
      presetsVersion: 1,
      ...extra
    })
    return { service, runCalls }
  }

  it('applies the presets right after installing, with firstTime, and records the version', async () => {
    const { presets, applied } = presetsRecorder()
    const startHidden = vi.fn()
    const { service } = make(presets, { startHidden })
    await service.setup()
    service.dispose()
    expect(applied.map((a) => a.id).sort()).toEqual(['ALPHA', 'BETA'])
    const alpha = applied.find((a) => a.id === 'ALPHA')!.ctx
    expect(alpha.firstTime).toBe(true)
    expect(alpha.emuDir).toBe(join(root(), 'Alpha'))
    expect(alpha.dataDir).toBe(join(userData, 'Emulation'))
    expect(alpha.startHidden).toBe(startHidden)
    expect((await readManifest()).presets).toEqual({ ALPHA: 1, BETA: 1 })
  })

  it('applies them once at startup to emulators installed before the presets existed', async () => {
    await existingInstall()
    const { presets, applied } = presetsRecorder()
    const first = make(presets)
    await first.service.startup()
    first.service.dispose()
    expect(applied.map((a) => [a.id, a.ctx.firstTime])).toEqual([
      ['ALPHA', true],
      ['BETA', true]
    ])
    expect((await readManifest()).presets).toEqual({ ALPHA: 1, BETA: 1 })

    // Idempotent across launches: nothing to do the second time.
    applied.length = 0
    const second = make(presets)
    await second.service.startup()
    second.service.dispose()
    expect(applied).toEqual([])
  })

  it('runs again with firstTime false when the presets version is newer than the recorded one', async () => {
    await existingInstall({ presets: { ALPHA: 1, BETA: 2 } })
    const { presets, applied } = presetsRecorder()
    const { service } = make(presets, { presetsVersion: 2 })
    await service.startup()
    service.dispose()
    expect(applied.map((a) => [a.id, a.ctx.firstTime])).toEqual([['ALPHA', false]])
    expect((await readManifest()).presets).toEqual({ ALPHA: 2, BETA: 2 })
  })

  it('turns a preset failure into a notice, keeps the install and retries at the next launch', async () => {
    const { presets, applied } = presetsRecorder(['ALPHA'])
    const { service } = make(presets)
    const status = await service.setup()
    expect(status.items.map((i) => i.state)).toEqual(['installed', 'installed'])
    expect(status.notices).toContain(
      'Alpha was set up, but its fullscreen and controller settings could not be applied: locked file'
    )
    expect((await readManifest()).presets).toEqual({ BETA: 1 })
    applied.length = 0
    await service.startup()
    service.dispose()
    expect(applied.map((a) => [a.id, a.ctx.firstTime])).toEqual([['ALPHA', true]])
  })

  it('skips an emulator whose exe name is running and applies it at the next launch', async () => {
    await existingInstall()
    const { presets, applied } = presetsRecorder()
    let running =
      '"ALPHA.EXE","1234","Console","1","10,000 K"\r\n"other.exe","5","Console","1","1 K"\r\n'
    const { service, runCalls } = make(presets, {
      run: async (file, args) => {
        runCalls.push([file, ...args])
        return { code: 0, stdout: file === 'tasklist' ? running : '', stderr: '' }
      }
    })
    await service.startup()
    expect(applied.map((a) => a.id)).toEqual(['BETA'])
    // Read per emulator: before ALPHA, before BETA and after BETA.
    expect(runCalls.filter((c) => c[0] === 'tasklist')).toHaveLength(3)
    expect((await readManifest()).presets).toEqual({ BETA: 1 })

    running = ''
    await service.startup()
    service.dispose()
    expect(applied.map((a) => a.id)).toEqual(['BETA', 'ALPHA'])
  })

  it('does not record an emulator started while its presets ran, nor a deferred one (no notice)', async () => {
    await existingInstall()
    let running = ''
    let alphaStarted = false
    const applied: string[] = []
    const presets: Record<string, Preset> = {
      ALPHA: async () => {
        // The user starts Alpha while its presets run (first pass only).
        if (!alphaStarted) running = '"alpha.exe","1","Console","1","1 K"\r\n'
        alphaStarted = true
        applied.push('ALPHA')
      },
      BETA: async () => {
        applied.push('BETA')
        throw new PresetDeferredError('Beta is running')
      }
    }
    const { service } = make(presets, {
      run: async (file) => ({ code: 0, stdout: file === 'tasklist' ? running : '', stderr: '' })
    })
    await service.startup()
    const status = await service.status()
    expect(applied).toEqual(['ALPHA', 'BETA'])
    // Beta's deferred run is remembered (0): retried, but no longer as the first time.
    expect((await readManifest()).presets ?? {}).toEqual({ BETA: 0 })
    expect(status.notices.some((n) => n.includes('could not be applied'))).toBe(false)

    running = ''
    applied.length = 0
    const firstTimes: boolean[] = []
    presets.BETA = async (ctx) => {
      firstTimes.push(ctx.firstTime)
      applied.push('BETA')
    }
    await service.startup()
    expect(firstTimes).toEqual([false])
    service.dispose()
    expect(applied).toEqual(['ALPHA', 'BETA'])
    expect((await readManifest()).presets).toEqual({ ALPHA: 1, BETA: 1 })
  })

  it('gives a reinstalled (deleted) emulator folder the presets again with firstTime', async () => {
    await existingInstall({ presets: { ALPHA: 1, BETA: 1 } })
    await fs.rm(join(root(), 'Alpha'), { recursive: true })
    const { presets, applied } = presetsRecorder()
    const { service } = make(presets)
    await service.setup(['ALPHA'])
    service.dispose()
    expect(applied.map((a) => [a.id, a.ctx.firstTime])).toEqual([['ALPHA', true]])
  })

  describe('a preconfigured Drive folder source', () => {
    const DRIVE: EmulatorSpec = {
      id: 'GAMMA',
      name: 'Gamma',
      folder: 'Gamma',
      exe: 'drive.exe',
      source: { kind: 'drive-folder', folderId: 'f1', skip: ['log'] },
      runtimes: ['vcredist']
    }
    const catalog = (spec: EmulatorSpec = DRIVE): EmulatorSpec[] => [CATALOG[1]!, spec]
    const recorder = (): { presets: Record<string, Preset>; applied: string[] } => {
      const applied: string[] = []
      const one =
        (id: string): Preset =>
        async () => {
          applied.push(id)
        }
      return { presets: { BETA: one('BETA'), GAMMA: one('GAMMA') }, applied }
    }

    it('downloads the folder into place, configures it, records the source and applies no presets', async () => {
      const fake = fakeModules()
      const { presets, applied } = recorder()
      const emitted: EmulatorSetupProgress[] = []
      const { service } = make(presets, {
        catalog: catalog(),
        modules: fake.modules,
        emit: (p) => emitted.push(p),
        now: () => Date.parse('2026-11-14T10:00:00Z')
      })
      const status = await service.setup()
      service.dispose()
      expect(status.items.map((i) => [i.id, i.state, i.version])).toEqual([
        ['BETA', 'installed', '2.0'],
        ['GAMMA', 'installed', 'drive-2026-11-14']
      ])
      expect(fake.calls.drive).toEqual(['f1'])
      // Only BETA went through the archive route.
      expect(fake.calls.resolve).toEqual(['https://example.test/beta.7z'])
      // The runtimes the Drive emulator needs are still ensured.
      expect(fake.calls.runtimes).toEqual([['vcredist']])
      const gamma = join(root(), 'Gamma')
      expect(await fs.readFile(join(gamma, 'drive.exe'), 'utf8')).toBe('exe')
      expect(await fs.readFile(join(gamma, 'config', 'mine.yml'), 'utf8')).toBe('preconfigured')
      expect(JSON.parse(await fs.readFile(join(gamma, '.playout-drive.json'), 'utf8'))).toEqual({
        folderId: 'f1',
        version: 'drive-2026-11-14'
      })
      expect(fake.calls.configure.map((c) => [c.id, c.emuDir])).toContainEqual(['GAMMA', gamma])
      expect((await fs.readdir(root())).sort()).toEqual(['.playout', 'Beta', 'Gamma'])
      const manifest = await readManifest()
      expect(manifest.installed.GAMMA).toMatchObject({
        source: 'drive-folder',
        exe: join(gamma, 'drive.exe')
      })
      expect(applied).toEqual(['BETA'])
      expect(manifest.presets).toEqual({ BETA: 1 })
      expect(emitted.some((p) => p.filesTotal === 2 && p.filesDone === 1)).toBe(true)
      expect(emitted.at(-1)).toEqual({ done: 0, total: 0 })

      // A newer presets version still leaves the Drive install alone (and gives BETA its update).
      applied.length = 0
      const later = make(presets, { catalog: catalog(), modules: fake.modules, presetsVersion: 2 })
      await later.service.startup()
      later.service.dispose()
      expect(applied).toEqual(['BETA'])
      expect(fake.calls.drive).toEqual(['f1'])
    })

    it('fails clearly when the folder has no exe, keeping the download for the next attempt', async () => {
      const fake = fakeModules()
      const { presets } = recorder()
      const spec = { ...DRIVE, source: { kind: 'drive-folder' as const, folderId: 'no-exe' } }
      const { service } = make(presets, { catalog: catalog(spec), modules: fake.modules })
      const status = await service.setup(['GAMMA'])
      service.dispose()
      expect(status.items.find((i) => i.id === 'GAMMA')).toMatchObject({
        state: 'failed',
        error: 'drive.exe is not in the Drive folder'
      })
      expect(await fs.readdir(root())).not.toContain('Gamma')
      expect(await fs.readFile(join(root(), '.Gamma.drive', 'config', 'mine.yml'), 'utf8')).toBe(
        'preconfigured'
      )
      expect((await readManifest().catch(() => null))?.installed.GAMMA).toBeUndefined()
    })

    it('never replaces an existing install, which keeps getting the presets', async () => {
      // GAMMA installed earlier from another source (a GitHub build): its exe is there, no Drive marker.
      await fs.mkdir(join(root(), 'Gamma'), { recursive: true })
      await fs.writeFile(join(root(), 'Gamma', 'drive.exe'), 'github build')
      const fake = fakeModules()
      const { presets, applied } = recorder()
      const { service } = make(presets, { catalog: catalog(), modules: fake.modules })
      await service.startup()
      service.dispose()
      expect(fake.calls.drive).toEqual([])
      expect(await fs.readFile(join(root(), 'Gamma', 'drive.exe'), 'utf8')).toBe('github build')
      const manifest = await readManifest()
      expect(manifest.installed.GAMMA.source).toBeUndefined()
      expect(applied.sort()).toEqual(['BETA', 'GAMMA'])
    })

    it("keeps a folder of the user's own install that lost its exe aside, whole, before the Drive copy goes in", async () => {
      // The user's GitHub build with its own settings; antivirus took its exe. No Drive marker.
      await fs.mkdir(join(root(), 'Gamma', 'config'), { recursive: true })
      await fs.writeFile(join(root(), 'Gamma', 'config', 'mine.yml'), 'my own settings')
      const fake = fakeModules()
      const { service } = make(recorder().presets, {
        catalog: catalog(),
        modules: fake.modules,
        now: () => Date.parse('2026-11-14T10:00:00Z')
      })
      await service.setup()
      service.dispose()
      expect(fake.calls.drive).toEqual(['f1'])
      expect(await fs.readFile(join(root(), 'Gamma', 'config', 'mine.yml'), 'utf8')).toBe(
        'preconfigured'
      )
      expect(
        await fs.readFile(
          join(root(), 'Gamma.playout-old-2026-11-14', 'config', 'mine.yml'),
          'utf8'
        )
      ).toBe('my own settings')
    })

    it('puts the Drive copy over an earlier Drive install that lost its exe, without keeping it aside', async () => {
      await fs.mkdir(join(root(), 'Gamma', 'config'), { recursive: true })
      await fs.writeFile(join(root(), 'Gamma', '.playout-drive.json'), '{"folderId":"f1"}')
      await fs.writeFile(join(root(), 'Gamma', 'extra.txt'), 'kept')
      const fake = fakeModules()
      const { service } = make(recorder().presets, {
        catalog: catalog(),
        modules: fake.modules,
        now: () => Date.parse('2026-11-14T10:00:00Z')
      })
      await service.setup()
      service.dispose()
      expect(await fs.readFile(join(root(), 'Gamma', 'drive.exe'), 'utf8')).toBe('exe')
      expect(await fs.readFile(join(root(), 'Gamma', 'extra.txt'), 'utf8')).toBe('kept')
      expect((await fs.readdir(root())).some((n) => n.includes('playout-old'))).toBe(false)
    })

    it('recognises a Drive install the manifest lost by its marker', async () => {
      await fs.mkdir(join(root(), 'Gamma'), { recursive: true })
      await fs.writeFile(join(root(), 'Gamma', 'drive.exe'), 'exe')
      await fs.writeFile(
        join(root(), 'Gamma', '.playout-drive.json'),
        JSON.stringify({ folderId: 'f1', version: 'drive-2026-11-01' })
      )
      const fake = fakeModules()
      const { presets, applied } = recorder()
      const { service } = make(presets, { catalog: catalog(), modules: fake.modules })
      await service.startup()
      service.dispose()
      expect(fake.calls.drive).toEqual([])
      expect((await readManifest()).installed.GAMMA).toMatchObject({
        source: 'drive-folder',
        version: 'drive-2026-11-01'
      })
      expect(applied).toEqual(['BETA'])
    })
  })

  describe('beforeLaunch', () => {
    const RYUJINX: EmulatorSpec = {
      id: 'RYUJINX',
      name: 'Ryujinx',
      folder: 'Ryujinx',
      exe: 'Ryujinx.exe',
      source: {
        kind: 'fixed',
        url: 'https://example.test/r.zip',
        version: '1',
        sha256: 'z',
        fileName: 'r.zip'
      }
    }
    const ryujinxExe = (): string => join(root(), 'Ryujinx', 'Ryujinx.exe')

    async function ryujinxInstall(): Promise<void> {
      await fs.mkdir(join(root(), 'Ryujinx'), { recursive: true })
      await fs.writeFile(ryujinxExe(), 'exe')
      await fs.mkdir(join(root(), '.playout'), { recursive: true })
      await fs.writeFile(
        join(root(), '.playout', 'emulators.json'),
        JSON.stringify({
          version: 1,
          installed: { RYUJINX: { version: '1', exe: ryujinxExe(), installedAt: 'then' } },
          configuredFor: null,
          completed: true
        })
      )
    }

    it('waits for a PCSX2 that is still closing before a PCSX2 game starts (its memory cards)', async () => {
      let closingChecks = 2
      const sleep = vi.fn(async () => undefined)
      const tasklist = vi.fn(async () => {
        const stillThere = closingChecks-- > 0
        return {
          code: 0,
          stdout: stillThere ? '"pcsx2-qt.exe","4242","Console","1","90,000 K"\r\n' : '',
          stderr: ''
        }
      })
      const { service } = make(
        {},
        {
          catalog: [],
          sleep,
          run: async (file: string) =>
            file === 'tasklist' ? tasklist() : { code: 0, stdout: '', stderr: '' }
        }
      )
      const exe = join(dir, 'PCSX2', 'pcsx2-qt.exe')
      const rom = join(dir, 'Game.chd')
      // A PCSX2 game ended a moment ago: its PCSX2 is still saving to the memory cards.
      await service.beforeLaunch('PCSX2', exe, rom, { endedMsAgo: 0 })
      expect(tasklist).toHaveBeenCalledTimes(3)
      expect(sleep).toHaveBeenCalledTimes(2)
      expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining('still running'))

      // One that never closes: launched anyway after what is left of the 15 s.
      closingChecks = Number.POSITIVE_INFINITY
      sleep.mockClear()
      await service.beforeLaunch('PCSX2', exe, rom, { endedMsAgo: 5000 })
      expect(sleep).toHaveBeenCalledTimes(20)
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining('still running 10000 ms after its game ended')
      )

      // No PCSX2 game ended lately (a PCSX2 the user opened, or one still playing): no wait at all.
      sleep.mockClear()
      tasklist.mockClear()
      await service.beforeLaunch('PCSX2', exe, rom)
      await service.beforeLaunch('PCSX2', exe, rom, { endedMsAgo: 60_000 })
      expect(sleep).not.toHaveBeenCalled()
      service.dispose()
    })

    it('probes the ended game own process instead of reading the process list', async () => {
      const tasklist = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }))
      let alive = 2
      const isPidAlive = vi.fn((pid: number) => pid === 4242 && alive-- > 0)
      const sleep = vi.fn(async () => undefined)
      const { service } = make(
        {},
        {
          catalog: [],
          sleep,
          isPidAlive,
          run: async (file: string) =>
            file === 'tasklist' ? tasklist() : { code: 0, stdout: '', stderr: '' }
        }
      )
      const exe = join(dir, 'PCSX2', 'pcsx2-qt.exe')
      await service.beforeLaunch('PCSX2', exe, join(dir, 'Game.chd'), { endedMsAgo: 0, pid: 4242 })
      expect(isPidAlive).toHaveBeenCalledTimes(3)
      expect(sleep).toHaveBeenCalledTimes(2)
      expect(tasklist).not.toHaveBeenCalled()
      service.dispose()
    })

    describe('PCSX2 game list', () => {
      const PCSX2: EmulatorSpec = {
        id: 'PCSX2',
        name: 'PCSX2',
        folder: 'PCSX2',
        exe: 'pcsx2-qt.exe',
        source: {
          kind: 'fixed',
          url: 'https://example.test/p.7z',
          version: '1',
          sha256: 'p',
          fileName: 'p.7z'
        }
      }
      const emuDir = (): string => join(root(), 'PCSX2')
      const pcsx2Exe = (): string => join(emuDir(), 'pcsx2-qt.exe')
      const iniFile = (): string => join(emuDir(), 'inis', 'PCSX2.ini')
      const cacheFile = (): string => join(emuDir(), 'cache', 'gamelist.cache')
      let rom: string

      const lenStr = (s: string): Buffer => {
        const b = Buffer.from(s, 'utf8')
        const n = Buffer.alloc(4)
        n.writeUInt32LE(b.length)
        return Buffer.concat([n, b])
      }
      /** A gamelist.cache with one record of `path` (GameList.cpp WriteEntryToCache). */
      async function cacheOf(path: string): Promise<Buffer> {
        const tail = Buffer.alloc(23)
        const modified = Math.floor((await fs.stat(path)).mtimeMs / 1000)
        tail.writeBigUInt64LE(BigInt(modified), 10)
        tail.writeUInt32LE(0x1234, 18)
        const head = Buffer.alloc(8)
        head.writeUInt32LE(0x45434c47, 0)
        head.writeUInt32LE(34, 4)
        return Buffer.concat([
          head,
          lenStr(path),
          lenStr('SLUS-00001'),
          lenStr('Game'),
          lenStr(''),
          lenStr(''),
          tail
        ])
      }

      beforeEach(async () => {
        await fs.mkdir(join(emuDir(), 'inis'), { recursive: true })
        await fs.mkdir(join(emuDir(), 'cache'), { recursive: true })
        await fs.writeFile(pcsx2Exe(), 'exe')
        await fs.writeFile(
          iniFile(),
          '[UI]\nStartBigPictureMode = true\n\n[Folders]\nCache = cache\n'
        )
        await fs.mkdir(join(root(), '.playout'), { recursive: true })
        await fs.writeFile(
          join(root(), '.playout', 'emulators.json'),
          JSON.stringify({
            version: 1,
            installed: { PCSX2: { version: '1', exe: pcsx2Exe(), installedAt: 'then' } },
            configuredFor: null,
            completed: true,
            presets: { PCSX2: 1 }
          })
        )
        await fs.mkdir(join(dir, 'roms', 'ps2'), { recursive: true })
        rom = join(dir, 'roms', 'ps2', 'Game.chd')
        await fs.writeFile(rom, 'disc')
      })

      /** A hidden PCSX2 that lists the game after 10 ms (when `scans`) and exits when asked to close. */
      function fakeStart(scans: boolean): {
        startHidden: NonNullable<EmulatorSetupDeps['startHidden']>
        started: number
        closed: number
        iniAtClose: string[]
      } {
        const fake = {
          started: 0,
          closed: 0,
          iniAtClose: [] as string[],
          startHidden: (() => {
            fake.started++
            let exit!: (c: number | null) => void
            const exited = new Promise<number | null>((r) => (exit = r))
            const timer = scans
              ? setTimeout(async () => fs.writeFile(cacheFile(), await cacheOf(rom)), 10)
              : null
            return {
              exited,
              stop: async () => exit(null),
              close: async () => {
                if (timer) clearTimeout(timer)
                fake.closed++
                exit(0)
              }
            }
          }) as NonNullable<EmulatorSetupDeps['startHidden']>
        }
        return fake
      }

      it('starts a game PCSX2 does not list at once and scans it in the background once nothing runs', async () => {
        let t = 0
        let gameRunning = false
        const fake = fakeStart(true)
        const tasklist = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }))
        const { service } = make(
          {},
          {
            catalog: [PCSX2],
            startHidden: fake.startHidden,
            now: () => t,
            prewarmDelayMs: 5,
            isGameRunning: () => gameRunning,
            run: async (file: string) =>
              file === 'tasklist' ? tasklist() : { code: 0, stdout: '', stderr: '' }
          }
        )
        await service.beforeLaunch('PCSX2', pcsx2Exe(), rom)
        // The launch only added the folder (one process list before that write); no hidden PCSX2.
        expect(fake.started).toBe(0)
        expect(tasklist).toHaveBeenCalledTimes(1)
        expect(await fs.readFile(iniFile(), 'utf8')).toContain(`Paths = ${dirname(rom)}`)

        // Right after a launch, or while the game runs: no scan.
        gameRunning = true
        service.prewarmPcsx2()
        await new Promise((r) => setTimeout(r, 50))
        expect(fake.started).toBe(0)
        gameRunning = false
        t = 10_000
        service.prewarmPcsx2()
        await new Promise((r) => setTimeout(r, 50))
        expect(fake.started).toBe(0)

        // The session ended and the launch is long past: the background scan lists the game.
        t = 60_000
        service.prewarmPcsx2()
        await vi.waitFor(() => expect(fake.closed).toBe(1), { timeout: 5000 })
        await vi.waitFor(
          async () =>
            expect(await fs.readFile(iniFile(), 'utf8')).toContain('StartBigPictureMode = true'),
          { timeout: 5000 }
        )
        // Listed now: the next launch takes no process list at all.
        tasklist.mockClear()
        await service.beforeLaunch('PCSX2', pcsx2Exe(), rom)
        expect(tasklist).not.toHaveBeenCalled()
        expect(fake.started).toBe(1)
        service.dispose()
      })

      it('a launch stops a background scan and its settings are back before the launch step ends', async () => {
        let t = 60_000
        const fake = fakeStart(false)
        const { service } = make(
          {},
          {
            catalog: [PCSX2],
            startHidden: fake.startHidden,
            now: () => t,
            prewarmDelayMs: 5,
            pcsx2Roms: () => [rom]
          }
        )
        service.prewarmPcsx2()
        await vi.waitFor(() => expect(fake.started).toBe(1), { timeout: 5000 })
        expect(await fs.readFile(iniFile(), 'utf8')).toContain('StartBigPictureMode = false')
        t += 1
        await service.beforeLaunch('PCSX2', pcsx2Exe(), rom)
        expect(fake.closed).toBe(1)
        expect(await fs.readFile(iniFile(), 'utf8')).toContain('StartBigPictureMode = true')
        await expect(fs.stat(join(emuDir(), '.playout-scan-restore.json'))).rejects.toThrow()
        expect(log.info).toHaveBeenCalledWith(expect.stringContaining('pre-warm stopped'))
        service.dispose()
      })

      const markerFile = (): string => join(emuDir(), '.playout-scan-restore.json')

      it('runs another pass when one is asked for while a pass runs', async () => {
        const fake = fakeStart(false)
        const { service } = make(
          {},
          {
            catalog: [PCSX2],
            startHidden: fake.startHidden,
            now: () => 60_000,
            prewarmDelayMs: 5,
            // The hidden scan gives up after its minimum (2 s).
            prewarmScanTimeoutMs: 100,
            pcsx2Roms: () => [rom]
          }
        )
        service.prewarmPcsx2()
        await vi.waitFor(() => expect(fake.started).toBe(1), { timeout: 5000 })
        // Asked again (a library scan) while the first pass scans: not dropped.
        service.prewarmPcsx2()
        await vi.waitFor(() => expect(fake.started).toBe(2), { timeout: 10_000 })
        await service.dispose()
      }, 20_000)

      it('setup stops a background scan before it runs, and the pass comes back once setup is done', async () => {
        const fake = fakeStart(false)
        const { service } = make(
          {},
          {
            catalog: [PCSX2],
            startHidden: fake.startHidden,
            now: () => 60_000,
            prewarmDelayMs: 5,
            pcsx2Roms: () => [rom]
          }
        )
        service.prewarmPcsx2()
        await vi.waitFor(() => expect(fake.started).toBe(1), { timeout: 5000 })
        await service.setup(['PCSX2'])
        expect(fake.closed).toBe(1)
        expect(log.info).toHaveBeenCalledWith(expect.stringContaining('pre-warm stopped (setup)'))
        await vi.waitFor(() => expect(fake.started).toBe(2), { timeout: 5000 })
        await service.dispose()
        expect(fake.closed).toBe(2)
      }, 20_000)

      it('quitting closes a background scan and puts its settings back before dispose resolves', async () => {
        const fake = fakeStart(false)
        const { service } = make(
          {},
          {
            catalog: [PCSX2],
            startHidden: fake.startHidden,
            now: () => 60_000,
            prewarmDelayMs: 5,
            pcsx2Roms: () => [rom]
          }
        )
        service.prewarmPcsx2()
        await vi.waitFor(() => expect(fake.started).toBe(1), { timeout: 5000 })
        expect(await fs.readFile(iniFile(), 'utf8')).toContain('StartBigPictureMode = false')
        const began = Date.now()
        await service.dispose()
        expect(Date.now() - began).toBeLessThan(DISPOSE_WAIT_MS)
        expect(fake.closed).toBe(1)
        expect(await fs.readFile(iniFile(), 'utf8')).toContain('StartBigPictureMode = true')
        await expect(fs.stat(markerFile())).rejects.toThrow()
      })

      it('a PCSX2 the user starts stops the background scan; its settings go back at the next pass once it is closed', async () => {
        const fake = fakeStart(false)
        let userPcsx2 = false
        let roms = [rom]
        const tasklistArgs: string[][] = []
        const { service } = make(
          {},
          {
            catalog: [PCSX2],
            startHidden: fake.startHidden,
            now: () => 60_000,
            prewarmDelayMs: 5,
            pcsx2Roms: () => roms,
            run: async (file: string, args: string[]) => {
              if (file === 'tasklist') tasklistArgs.push(args)
              return {
                code: 0,
                stdout:
                  file === 'tasklist' && userPcsx2
                    ? '"pcsx2-qt.exe","999","Console","1","100,000 K"\r\n'
                    : '',
                stderr: ''
              }
            }
          }
        )
        service.prewarmPcsx2()
        await vi.waitFor(() => expect(fake.started).toBe(1), { timeout: 5000 })
        userPcsx2 = true
        await vi.waitFor(() => expect(fake.closed).toBe(1), { timeout: 6000 })
        await vi.waitFor(
          () =>
            expect(log.info).toHaveBeenCalledWith(expect.stringContaining('another PCSX2 runs')),
          { timeout: 5000 }
        )
        // The scan's check names the image only.
        expect(tasklistArgs).toContainEqual([
          '/FO',
          'CSV',
          '/NH',
          '/FI',
          'IMAGENAME eq pcsx2-qt.exe'
        ])
        expect(await fs.readFile(iniFile(), 'utf8')).toContain('StartBigPictureMode = false')
        expect(await fs.stat(markerFile())).toBeTruthy()
        // The user closed it; the next pass (a session's end, a library scan) puts the settings back first.
        userPcsx2 = false
        roms = []
        service.prewarmPcsx2()
        await vi.waitFor(async () => expect(fs.stat(markerFile())).rejects.toThrow(), {
          timeout: 5000
        })
        expect(await fs.readFile(iniFile(), 'utf8')).toContain('StartBigPictureMode = true')
        await service.dispose()
      }, 20_000)

      /** A service whose background scan the user's PCSX2 stops (the marker stays); the restore check runs every 50 ms. */
      async function stoppedByUserPcsx2(): Promise<{
        service: ReturnType<typeof make>['service']
        user: { running: boolean }
        checks: () => number
      }> {
        const fake = fakeStart(false)
        const user = { running: false }
        let checks = 0
        const { service } = make(
          {},
          {
            catalog: [PCSX2],
            startHidden: fake.startHidden,
            now: () => 60_000,
            prewarmDelayMs: 5,
            restoreCheckMs: 50,
            pcsx2Roms: () => [rom],
            run: async (file: string, args: string[]) => {
              // The follow-up's check: the plain image filter, without a PID filter.
              if (file === 'tasklist' && !args.some((a) => a.startsWith('PID'))) checks++
              return {
                code: 0,
                stdout:
                  file === 'tasklist' && user.running
                    ? '"pcsx2-qt.exe","999","Console","1","100,000 K"\r\n'
                    : '',
                stderr: ''
              }
            }
          }
        )
        service.prewarmPcsx2()
        await vi.waitFor(() => expect(fake.started).toBe(1), { timeout: 5000 })
        user.running = true
        await vi.waitFor(
          () => expect(log.info).toHaveBeenCalledWith(expect.stringContaining('pre-warm stopped')),
          { timeout: 6000 }
        )
        expect(await fs.stat(markerFile())).toBeTruthy()
        return { service, user, checks: () => checks }
      }

      it('puts a stopped scan settings back by itself once the user closes PCSX2, then stops checking', async () => {
        const { service, user, checks } = await stoppedByUserPcsx2()
        // Checked again while the user's PCSX2 runs: nothing written.
        const at = checks()
        await vi.waitFor(() => expect(checks()).toBeGreaterThan(at + 1), { timeout: 5000 })
        expect(await fs.readFile(iniFile(), 'utf8')).toContain('StartBigPictureMode = false')
        // Closed: put back at the next check, without another pass being asked for.
        user.running = false
        await vi.waitFor(async () => expect(fs.stat(markerFile())).rejects.toThrow(), {
          timeout: 5000
        })
        expect(await fs.readFile(iniFile(), 'utf8')).toContain('StartBigPictureMode = true')
        const done = checks()
        await new Promise((r) => setTimeout(r, 300))
        expect(checks()).toBe(done)
        await service.dispose()
      }, 20_000)

      it('stops the restore check on dispose', async () => {
        const { service, checks } = await stoppedByUserPcsx2()
        await service.dispose()
        const at = checks()
        await new Promise((r) => setTimeout(r, 300))
        expect(checks()).toBe(at)
        expect(await fs.stat(markerFile())).toBeTruthy()
      }, 20_000)
    })

    it('refreshes the controllers of the Ryujinx PlayOut installed only', async () => {
      await ryujinxInstall()
      const refresh = vi.fn(async () => undefined)
      const { service } = make({}, { catalog: [RYUJINX], refreshRyujinxControllers: refresh })
      await service.beforeLaunch('RYUJINX', ryujinxExe().toUpperCase())
      expect(refresh).toHaveBeenCalledTimes(1)
      expect(refresh.mock.calls[0]).toMatchObject([{ emuDir: join(root(), 'Ryujinx') }])
      await service.beforeLaunch('DOLPHIN', join(dir, 'Dolphin.exe'))
      await service.beforeLaunch('RYUJINX', join(dir, 'elsewhere', 'Ryujinx.exe'))
      expect(refresh).toHaveBeenCalledTimes(1)
      service.dispose()
    })

    it('never blocks the launch: errors are logged and a slow refresh is cut off', async () => {
      await ryujinxInstall()
      const failing = make(
        {},
        {
          catalog: [RYUJINX],
          refreshRyujinxControllers: async () => {
            throw new Error('SDL2.dll missing')
          }
        }
      )
      await expect(failing.service.beforeLaunch('RYUJINX')).resolves.toBeUndefined()
      expect(log.warn).toHaveBeenCalledWith(
        'Ryujinx controllers could not be refreshed: SDL2.dll missing'
      )
      failing.service.dispose()

      const slow = make(
        {},
        {
          catalog: [RYUJINX],
          beforeLaunchTimeoutMs: 20,
          refreshRyujinxControllers: () => new Promise<void>(() => undefined)
        }
      )
      const started = Date.now()
      await slow.service.beforeLaunch('RYUJINX')
      expect(Date.now() - started).toBeLessThan(2000)
      slow.service.dispose()
    })

    it('aborts the refresh when the timeout wins, and on dispose', async () => {
      await ryujinxInstall()
      const signals: AbortSignal[] = []
      const { service } = make(
        {},
        {
          catalog: [RYUJINX],
          beforeLaunchTimeoutMs: 20,
          refreshRyujinxControllers: (ctx) => {
            signals.push(ctx.signal!)
            return new Promise<void>(() => undefined)
          }
        }
      )
      await service.beforeLaunch('RYUJINX')
      expect(signals[0].aborted).toBe(true)

      const pending = make(
        {},
        {
          catalog: [RYUJINX],
          beforeLaunchTimeoutMs: 60_000,
          refreshRyujinxControllers: (ctx) => {
            signals.push(ctx.signal!)
            return new Promise<void>((resolve) =>
              ctx.signal!.addEventListener('abort', () => resolve())
            )
          }
        }
      )
      const launch = pending.service.beforeLaunch('RYUJINX')
      await vi.waitFor(() => expect(signals).toHaveLength(2))
      expect(signals[1].aborted).toBe(false)
      pending.service.dispose()
      await launch
      expect(signals[1].aborted).toBe(true)
      service.dispose()
    })

    it('does nothing when PlayOut did not install Ryujinx', async () => {
      const refresh = vi.fn(async () => undefined)
      const { service } = make({}, { catalog: [RYUJINX], refreshRyujinxControllers: refresh })
      await service.beforeLaunch('RYUJINX')
      expect(refresh).not.toHaveBeenCalled()
      service.dispose()
    })
  })
})

describe('moving the 0.1.81 Emulation folder next to PlayOut.exe to Emulators', () => {
  let dir: string
  const quiet = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  }
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'playout-migrate-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  async function legacyInstall(): Promise<string> {
    const legacy = join(dir, 'app', 'Emulation')
    await fs.mkdir(join(legacy, 'RetroArch'), { recursive: true })
    await fs.mkdir(join(legacy, '.playout'), { recursive: true })
    await fs.writeFile(join(legacy, 'RetroArch', 'retroarch.exe'), 'x')
    const manifest: SetupManifest = {
      version: 1,
      installed: {
        RETROARCH: {
          version: '1',
          exe: join(legacy, 'RetroArch', 'retroarch.exe'),
          installedAt: 'now'
        }
      },
      configuredFor: join(dir, 'userData', 'Emulation'),
      configured: {},
      completed: true,
      presets: {}
    }
    await fs.writeFile(join(legacy, '.playout', 'emulators.json'), JSON.stringify(manifest))
    return legacy
  }

  it('renames the folder and rewrites the manifest and settings paths', async () => {
    const legacy = await legacyInstall()
    let settings = defaultSettings()
    settings = deepMerge(settings, {
      emulators: { overrides: { RETROARCH: join(legacy, 'RetroArch', 'retroarch.exe') } }
    }) as Settings
    const service = createEmulatorSetupService({
      settings: {
        get: () => settings,
        update: (patch: SettingsPatch) => {
          settings = deepMerge(settings, patch) as Settings
        }
      },
      userData: join(dir, 'userData'),
      exeDir: join(dir, 'app'),
      emit: () => undefined,
      log: quiet
    })
    const moved = join(dir, 'app', 'Emulators', 'RetroArch', 'retroarch.exe')
    await expect(fs.stat(legacy)).rejects.toThrow()
    expect(service.managedExe('RETROARCH')).toBe(moved)
    expect(settings.emulators.overrides.RETROARCH).toBe(moved)
    const manifest = JSON.parse(
      await fs.readFile(join(dir, 'app', 'Emulators', '.playout', 'emulators.json'), 'utf8')
    ) as SetupManifest
    expect(manifest.installed.RETROARCH!.exe).toBe(moved)
    // The data Emulation folder in the settings folder keeps its name.
    expect(manifest.configuredFor).toBe(join(dir, 'userData', 'Emulation'))
    expect((await service.status()).root).toBe(join(dir, 'app', 'Emulators'))
    service.dispose()
  })

  it('merges into an Emulators folder that already holds something', async () => {
    const legacy = await legacyInstall()
    await fs.mkdir(join(dir, 'app', 'Emulators', 'Mine'), { recursive: true })
    expect(migrateLegacyRoot(join(dir, 'app'), quiet)).toBe(true)
    await expect(fs.stat(legacy)).rejects.toThrow()
    await fs.stat(join(dir, 'app', 'Emulators', 'Mine'))
    await fs.stat(join(dir, 'app', 'Emulators', 'RetroArch', 'retroarch.exe'))
  })

  it('leaves an Emulation folder that PlayOut did not make alone', async () => {
    await fs.mkdir(join(dir, 'app', 'Emulation', 'stuff'), { recursive: true })
    expect(migrateLegacyRoot(join(dir, 'app'), quiet)).toBe(false)
    await fs.stat(join(dir, 'app', 'Emulation', 'stuff'))
  })

  it('rebases paths only under the old folder', () => {
    expect(rebasePath('C:\\A\\Emulation\\X\\x.exe', 'c:\\a\\emulation', 'C:\\A\\Emulators')).toBe(
      'C:\\A\\Emulators\\X\\x.exe'
    )
    expect(rebasePath('C:\\A\\EmulationOther\\x.exe', 'C:\\A\\Emulation', 'C:\\A\\Emulators')).toBe(
      null
    )
  })
})

describe('isUnder', () => {
  it('compares resolved paths case-insensitively', () => {
    expect(isUnder('C:\\Program Files\\PlayOut\\Emulation', ['c:\\program files'])).toBe(true)
    expect(isUnder('C:\\Program Files', ['C:\\Program Files\\'])).toBe(true)
    expect(isUnder('C:\\Program Files (x86)\\x', ['C:\\Program Files'])).toBe(false)
    expect(isUnder('D:\\Games\\PlayOut', ['C:\\Program Files', 'C:\\Program Files (x86)'])).toBe(
      false
    )
  })
})
