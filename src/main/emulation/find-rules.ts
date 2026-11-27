import { readFileSync } from 'fs'
import { basename, dirname, extname, isAbsolute, join, normalize } from 'path'
import { z } from 'zod'
import type { EmulatorStatus, Settings } from '../../shared/types'
import type { Logger } from '../logger'
import { registryValue } from '../system/registry'
import { isDirectory, isFile, listDir } from '../util/fs'
import { knownFolders } from '../util/paths'

export const EMULATOR_RULE_TYPES = [
  'winregistrypath',
  'winregistryvalue',
  'systempath',
  'staticpath'
] as const
export type EmulatorRuleType = (typeof EMULATOR_RULE_TYPES)[number]

/**
 * Order in which rule types are tried. ES-DE tries registry rules, then PATH, then static paths; PlayOut puts the
 * PATH search last so that an explicit install location wins over whatever happens to be on PATH.
 */
const RULE_ORDER: readonly EmulatorRuleType[] = [
  'winregistrypath',
  'winregistryvalue',
  'staticpath',
  'systempath'
]

const APP_PATHS_KEY = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths'

const findRuleSchema = z.object({
  type: z.enum(EMULATOR_RULE_TYPES),
  entries: z.array(z.string().min(1))
})
const emulatorRuleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  rules: z.array(findRuleSchema),
  downloadUrl: z.string().optional()
})
const coreRuleSchema = z.object({
  id: z.string().min(1),
  rules: z.array(z.object({ type: z.literal('corepath'), entries: z.array(z.string().min(1)) }))
})
const findRulesFileSchema = z.object({
  _license: z.string().optional(),
  variables: z.record(z.string(), z.string()).optional(),
  emulators: z.array(emulatorRuleSchema),
  cores: z.array(coreRuleSchema)
})

export type FindRule = z.infer<typeof findRuleSchema>
export type EmulatorRule = z.infer<typeof emulatorRuleSchema>
export type CoreRule = z.infer<typeof coreRuleSchema>

export interface FindRulesData {
  emulators: EmulatorRule[]
  cores: CoreRule[]
}

export interface FindRulesPaths {
  /** Directory of the PlayOut executable (portable layout: next to PlayOut.exe). */
  exeDir: string
  /** Electron userData directory; emulators dropped into <userData>\Emulators are found through %ESPATH%. */
  userDataDir: string
}

export type RegistryHiveName = 'HKCU' | 'HKLM'
export type RegistryReader = (
  hive: RegistryHiveName,
  key: string,
  valueName: string
) => Promise<string | null>

export interface EmulatorResolverDeps {
  rules: FindRulesData
  paths: FindRulesPaths
  getSettings: () => Settings
  log: Logger
  /** Environment used for %VAR% expansion and the PATH search (defaults to process.env). */
  env?: NodeJS.ProcessEnv
  /** Registry reader, injectable for tests (defaults to reg.exe/PowerShell through system/registry.ts). */
  readRegistry?: RegistryReader
  /**
   * The executable PlayOut installed for this id (emulator setup manifest), tried after a user override and before
   * the find rules; used only when the file exists.
   */
  managed?: (id: string) => string | null
  /** How long a resolution stays cached (default 60 s). */
  cacheMs?: number
  now?: () => number
}

export interface CoreResolution {
  path: string | null
  coreFile: string
  searchedPaths: string[]
}

export interface EmulatorResolver {
  /** Resolve one emulator by its %EMULATOR_X% name (cached). Unknown ids resolve through overrides only. */
  resolveEmulator(id: string): Promise<EmulatorStatus>
  /** Every emulator in the rules file plus override-only ids, in file order. */
  resolveAll(): Promise<EmulatorStatus[]>
  /** Locate `%CORE_X%\file`: settings.emulators.coresDir first, then the core rules (%EMUPATH%\cores). */
  resolveCore(coreId: string, file: string): Promise<CoreResolution>
  /** Ids that have find rules. */
  knownIds(): string[]
  /** Drop every cached result (called when settings change). */
  invalidate(): void
}

/** Parse and validate the JSON text of find-rules.json. Throws an Error that names the problem. */
export function parseFindRules(text: string, source = 'find-rules.json'): FindRulesData {
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (err) {
    throw new Error(`${source} is not valid JSON: ${(err as Error).message}`, { cause: err })
  }
  const parsed = findRulesFileSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ')
    throw new Error(`${source} is malformed: ${issues}`)
  }
  const ids = new Set<string>()
  for (const e of parsed.data.emulators) {
    if (ids.has(e.id)) throw new Error(`${source} is malformed: duplicate emulator '${e.id}'`)
    ids.add(e.id)
  }
  return { emulators: parsed.data.emulators, cores: parsed.data.cores }
}

export function loadFindRules(file: string): FindRulesData {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    throw new Error(`Cannot read the emulator find rules at ${file}: ${(err as Error).message}`, {
      cause: err
    })
  }
  return parseFindRules(text, file)
}

// ---------------------------------------------------------------------------
// Variable expansion and path helpers
// ---------------------------------------------------------------------------

export interface ExpansionContext {
  exeDir: string
  userDataDir: string
  romsRoot: string | null
  /** Directory of the resolved emulator, for %EMUPATH% in core paths. */
  emuPath?: string | null
  env: NodeJS.ProcessEnv
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Expand the variables of a find-rule entry. %ESPATH% yields two candidates (exe dir and userData), so the result
 * is a list; an entry whose variables cannot be resolved (unset %ROMPATH%, unknown name) expands to nothing.
 */
export function expandRuleEntry(entry: string, ctx: ExpansionContext): string[] {
  const folders = knownFolders()
  const multi: Record<string, (string | null | undefined)[]> = {
    ESPATH: [ctx.exeDir, ctx.userDataDir],
    EMUPATH: [ctx.emuPath],
    ROMPATH: [ctx.romsRoot],
    USERPROFILE: [folders.userProfile],
    APPDATA: [folders.appData],
    LOCALAPPDATA: [folders.localAppData],
    PROGRAMFILES: [folders.programFiles],
    'PROGRAMFILES(X86)': [folders.programFilesX86],
    PROGRAMDATA: [folders.programData]
  }
  let variants = [entry.startsWith('~') ? folders.userProfile + entry.slice(1) : entry]
  for (let guard = 0; guard < 16; guard++) {
    const match = variants[0].match(/%([^%]+)%/)
    if (!match) break
    const name = match[1]
    const key = name.toUpperCase()
    const values = (multi[key] ?? [ctx.env[name] ?? ctx.env[key]]).filter(
      (v): v is string => typeof v === 'string' && v.length > 0
    )
    if (!values.length) return []
    const pattern = new RegExp(escapeRegExp(match[0]), 'gi')
    variants = variants.flatMap((v) =>
      values.map((value) => v.replace(pattern, () => value.replace(/[\\/]+$/, '')))
    )
  }
  return [...new Set(variants.map((v) => normalize(v)))]
}

/** Directories listed in PATH (quotes stripped, empty entries dropped). */
export function pathDirs(env: NodeJS.ProcessEnv): string[] {
  const value = env.PATH ?? env.Path ?? env.path ?? ''
  return [
    ...new Set(
      value
        .split(';')
        .map((s) => s.trim().replace(/^"|"$/g, ''))
        .filter(Boolean)
    )
  ]
}

/**
 * Find an executable on PATH the way SearchPathW does (".exe" appended when the name has no extension). Every
 * candidate checked is appended to `searched`.
 */
export async function searchPath(
  name: string,
  env: NodeJS.ProcessEnv,
  extraDirs: string[] = [],
  searched: string[] = []
): Promise<string | null> {
  const file = extname(name) ? name : `${name}.exe`
  for (const dir of [...new Set([...extraDirs, ...pathDirs(env)])]) {
    const candidate = join(dir, file)
    searched.push(candidate)
    if (await isFile(candidate)) return candidate
  }
  return null
}

/** Check a static path; the file name may contain * and ? wildcards (first match in name order wins). */
export async function matchStaticPath(
  candidate: string,
  searched: string[]
): Promise<string | null> {
  const name = basename(candidate)
  searched.push(candidate)
  if (!/[*?]/.test(name)) return (await isFile(candidate)) ? candidate : null
  const pattern = new RegExp(
    `^${escapeRegExp(name).replace(/\\\*/g, '.*').replace(/\\\?/g, '.')}$`,
    'i'
  )
  const dir = dirname(candidate)
  const names = (await listDir(dir))
    .filter((e) => e.isFile() && pattern.test(e.name))
    .map((e) => e.name)
    .sort()
  return names.length ? join(dir, names[0]) : null
}

/** Join a registry value with the `|suffix` part of a winregistryvalue entry (Steam's SteamExe uses forward slashes). */
function joinRegistrySuffix(value: string, suffix: string): string {
  if (!suffix) return normalize(value)
  if (/[\\/]$/.test(value) || /^[\\/]/.test(suffix)) return normalize(value + suffix)
  return normalize(`${value}\\${suffix}`)
}

/** Split `KEY\PATH\ValueName|suffix` into its parts (forward slashes are accepted). */
export function parseRegistryValueEntry(
  entry: string
): { key: string; valueName: string; suffix: string } | null {
  const pipe = entry.indexOf('|')
  const spec = (pipe >= 0 ? entry.slice(0, pipe) : entry).replace(/\//g, '\\').replace(/^\\+/, '')
  const suffix = pipe >= 0 ? entry.slice(pipe + 1) : ''
  const sep = spec.lastIndexOf('\\')
  if (sep <= 0) return null
  return { key: spec.slice(0, sep), valueName: spec.slice(sep + 1), suffix }
}

const defaultRegistryReader: RegistryReader = (hive, key, valueName) =>
  registryValue(hive, key, valueName)

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export function createEmulatorResolver(deps: EmulatorResolverDeps): EmulatorResolver {
  const env = deps.env ?? process.env
  const readRegistry = deps.readRegistry ?? defaultRegistryReader
  const cacheMs = deps.cacheMs ?? 60_000
  const now = deps.now ?? Date.now
  const log = deps.log

  const rulesById = new Map(deps.rules.emulators.map((e) => [e.id, e]))
  const coresById = new Map(deps.rules.cores.map((c) => [c.id, c]))

  const cache = new Map<string, { status: EmulatorStatus; at: number }>()
  const inflight = new Map<string, Promise<EmulatorStatus>>()
  const registryCache = new Map<string, { value: Promise<string | null>; at: number }>()

  function context(emuPath?: string | null): ExpansionContext {
    return {
      exeDir: deps.paths.exeDir,
      userDataDir: deps.paths.userDataDir,
      romsRoot: deps.getSettings().library.romsRoot,
      emuPath,
      env
    }
  }

  function readRegistryCached(
    hive: RegistryHiveName,
    key: string,
    valueName: string
  ): Promise<string | null> {
    const id = `${hive}\\${key}\\${valueName}`.toLowerCase()
    const cached = registryCache.get(id)
    if (cached && now() - cached.at < cacheMs) return cached.value
    const value = readRegistry(hive, key, valueName).catch((err) => {
      log.warn(`registry read failed for ${hive}\\${key}: ${(err as Error).message}`)
      return null
    })
    registryCache.set(id, { value, at: now() })
    return value
  }

  async function checkRegistryPath(entry: string, searched: string[]): Promise<string | null> {
    for (const hive of ['HKCU', 'HKLM'] as const) {
      const key = `${APP_PATHS_KEY}\\${entry}`
      searched.push(`${hive}\\${key}`)
      const value = await readRegistryCached(hive, key, '')
      if (!value) continue
      const file = normalize(value.trim().replace(/^"|"$/g, ''))
      searched.push(file)
      if (await isFile(file)) return file
    }
    return null
  }

  async function checkRegistryValue(entry: string, searched: string[]): Promise<string | null> {
    const parsed = parseRegistryValueEntry(entry)
    if (!parsed) {
      log.warn(`invalid winregistryvalue entry ignored: ${entry}`)
      return null
    }
    for (const hive of ['HKCU', 'HKLM'] as const) {
      searched.push(`${hive}\\${parsed.key}\\${parsed.valueName}`)
      const value = await readRegistryCached(hive, parsed.key, parsed.valueName)
      if (!value) continue
      const file = joinRegistrySuffix(value.trim().replace(/^"|"$/g, ''), parsed.suffix)
      searched.push(file)
      if (await isFile(file)) return file
    }
    return null
  }

  async function checkStaticPath(entry: string, searched: string[]): Promise<string | null> {
    // "path|command" entries (unused on Windows) would substitute a command once the file exists; PlayOut only
    // supports the path part, because launch commands are built as argv arrays.
    const pipe = entry.indexOf('|')
    const pathPart = pipe >= 0 ? entry.slice(0, pipe) : entry
    if (pipe >= 0)
      log.warn(
        `staticpath entry with a command suffix is not supported, using the path only: ${entry}`
      )
    for (const candidate of expandRuleEntry(pathPart, context())) {
      const found = await matchStaticPath(candidate, searched)
      if (found) return found
    }
    return null
  }

  async function checkRule(rule: FindRule, searched: string[]): Promise<string | null> {
    for (const entry of rule.entries) {
      let found: string | null = null
      switch (rule.type) {
        case 'winregistrypath':
          found = await checkRegistryPath(entry, searched)
          break
        case 'winregistryvalue':
          found = await checkRegistryValue(entry, searched)
          break
        case 'staticpath':
          found = await checkStaticPath(entry, searched)
          break
        case 'systempath':
          found = await searchPath(entry, env, [deps.paths.exeDir], searched)
          break
      }
      if (found) return found
    }
    return null
  }

  async function coresDirCandidates(
    coreId: string,
    emulatorPath: string | null
  ): Promise<string[]> {
    const dirs: string[] = []
    const override = deps.getSettings().emulators.coresDir
    if (override) dirs.push(normalize(override))
    const core = coresById.get(coreId)
    for (const rule of core?.rules ?? []) {
      for (const entry of rule.entries) {
        for (const dir of expandRuleEntry(
          entry,
          context(emulatorPath ? dirname(emulatorPath) : null)
        ))
          if (!dirs.includes(dir)) dirs.push(dir)
      }
    }
    return dirs
  }

  async function resolveUncached(id: string): Promise<EmulatorStatus> {
    const rule = rulesById.get(id)
    const settings = deps.getSettings()
    const status: EmulatorStatus = {
      id,
      name: rule?.name ?? id,
      path: null,
      foundBy: null,
      searchedPaths: []
    }
    if (rule?.downloadUrl) status.downloadUrl = rule.downloadUrl

    const override = settings.emulators.overrides[id]
    if (override) {
      const candidate = normalize(override)
      status.searchedPaths.push(candidate)
      if (await isFile(candidate)) {
        status.path = candidate
        status.foundBy = 'override'
      } else {
        log.warn(
          `emulator override for ${id} does not exist, falling back to the find rules: ${candidate}`
        )
      }
    }

    if (!status.path && deps.managed) {
      let managed: string | null = null
      try {
        managed = deps.managed(id)
      } catch (err) {
        log.warn(`managed emulator lookup failed for ${id}: ${(err as Error).message}`)
      }
      if (managed) {
        const candidate = normalize(managed)
        status.searchedPaths.push(candidate)
        if (await isFile(candidate)) {
          status.path = candidate
          status.foundBy = 'playout'
        }
      }
    }

    if (!status.path && rule) {
      outer: for (const type of RULE_ORDER) {
        for (const r of rule.rules) {
          if (r.type !== type) continue
          const found = await checkRule(r, status.searchedPaths)
          if (found) {
            status.path = found
            status.foundBy = 'rule'
            break outer
          }
        }
      }
    }

    if (coresById.has(id)) {
      status.coresDir = null
      for (const dir of await coresDirCandidates(id, status.path)) {
        if (await isDirectory(dir)) {
          status.coresDir = dir
          break
        }
      }
    }
    if (status.path) log.debug(`emulator ${id} -> ${status.path} (${status.foundBy})`)
    return status
  }

  function cloneStatus(status: EmulatorStatus): EmulatorStatus {
    return { ...status, searchedPaths: [...status.searchedPaths] }
  }

  function resolveEmulator(id: string): Promise<EmulatorStatus> {
    const cached = cache.get(id)
    if (cached && now() - cached.at < cacheMs) return Promise.resolve(cloneStatus(cached.status))
    const pending = inflight.get(id)
    if (pending) return pending.then(cloneStatus)
    const task = resolveUncached(id)
      .then((status) => {
        cache.set(id, { status, at: now() })
        return cloneStatus(status)
      })
      .finally(() => inflight.delete(id))
    inflight.set(id, task)
    return task
  }

  async function resolveAll(): Promise<EmulatorStatus[]> {
    const ids = deps.rules.emulators.map((e) => e.id)
    for (const id of Object.keys(deps.getSettings().emulators.overrides))
      if (!rulesById.has(id)) ids.push(id)
    const results: EmulatorStatus[] = new Array(ids.length)
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < ids.length) {
        const index = next++
        results[index] = await resolveEmulator(ids[index])
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, ids.length) }, worker))
    return results
  }

  async function resolveCore(coreId: string, file: string): Promise<CoreResolution> {
    const coreFile = file.replace(/^[\\/]+/, '')
    const searchedPaths: string[] = []
    const emulator = await resolveEmulator(coreId)
    for (const dir of await coresDirCandidates(coreId, emulator.path)) {
      const candidate = join(dir, coreFile)
      searchedPaths.push(candidate)
      if (await isFile(candidate)) return { path: candidate, coreFile, searchedPaths }
    }
    if (!coresById.has(coreId))
      log.warn(`no core rule for ${coreId}; only settings.emulators.coresDir was searched`)
    return { path: null, coreFile, searchedPaths }
  }

  return {
    resolveEmulator,
    resolveAll,
    resolveCore,
    knownIds: () => deps.rules.emulators.map((e) => e.id),
    invalidate() {
      cache.clear()
      registryCache.clear()
    }
  }
}

/** True for a Windows-absolute path (drive letter or UNC). */
export function isAbsoluteWindowsPath(p: string): boolean {
  return isAbsolute(p) && (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\'))
}
