import { readFileSync } from 'fs'
import { systemIconSlug } from '../../shared/platform-icons'
import { z } from 'zod'
import { SYSTEM_SORT_BASE } from '../../shared/platforms'
import type { Platform, SystemDefinition } from '../../shared/types'

const emulatorCommandSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  command: z.string().min(1),
  aliases: z.array(z.string().min(1)).optional(),
  noArchives: z.literal(true).optional()
})

const systemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  aliases: z.array(z.string().min(1)).optional(),
  extensions: z.array(z.string().min(1)).min(1),
  platformKey: z.string().min(1),
  manufacturer: z.string().min(1).optional(),
  releaseYear: z.number().int().min(1950).max(2100).optional(),
  emulators: z.array(emulatorCommandSchema).min(1),
  dirExtensions: z.array(z.string().min(1)).optional()
})

/** systems.json is either a bare SystemDefinition[] or { _license, systems: SystemDefinition[] }. */
const systemsFileSchema = z.union([
  z.array(systemSchema),
  z.object({ _license: z.string().optional(), systems: z.array(systemSchema) })
])

export { FALLBACK_ICON, MANUFACTURER_ICONS, SYSTEM_ICONS } from '../../shared/platform-icons'

/** Short display names for the row headers / badges of well-known systems. */
const SHORT_NAMES: Record<string, string> = {
  '3do': '3DO',
  amiga: 'Amiga',
  amstradcpc: 'CPC',
  apple2: 'Apple II',
  arcade: 'Arcade',
  atari2600: 'Atari 2600',
  atari5200: 'Atari 5200',
  atari7800: 'Atari 7800',
  atarijaguar: 'Jaguar',
  atarilynx: 'Lynx',
  atarist: 'Atari ST',
  c64: 'C64',
  colecovision: 'ColecoVision',
  dos: 'DOS',
  dreamcast: 'Dreamcast',
  famicom: 'Famicom',
  fbneo: 'FinalBurn Neo',
  fds: 'Famicom Disk',
  gamegear: 'Game Gear',
  gb: 'Game Boy',
  gba: 'GBA',
  gbc: 'GBC',
  gc: 'GameCube',
  genesis: 'Genesis',
  intellivision: 'Intellivision',
  mame: 'MAME',
  mastersystem: 'Master System',
  megacd: 'Mega-CD',
  megadrive: 'Mega Drive',
  msx: 'MSX',
  n3ds: '3DS',
  n64: 'N64',
  nds: 'DS',
  neogeo: 'Neo Geo',
  neogeocd: 'Neo Geo CD',
  nes: 'NES',
  ngp: 'Neo Geo Pocket',
  ngpc: 'NGP Color',
  pc: 'PC',
  pcengine: 'PC Engine',
  pcenginecd: 'PC Engine CD',
  pcfx: 'PC-FX',
  ps2: 'PS2',
  ps3: 'PS3',
  ps4: 'PS4',
  ps5: 'PS5',
  psp: 'PSP',
  psvita: 'PS Vita',
  psx: 'PS1',
  saturn: 'Saturn',
  scummvm: 'ScummVM',
  sega32x: '32X',
  segacd: 'Sega CD',
  sfc: 'Super Famicom',
  snes: 'SNES',
  switch: 'Switch',
  switch2: 'Switch 2',
  tg16: 'TurboGrafx-16',
  'tg-cd': 'TurboGrafx-CD',
  vectrex: 'Vectrex',
  virtualboy: 'Virtual Boy',
  wii: 'Wii',
  wiiu: 'Wii U',
  wonderswan: 'WonderSwan',
  wonderswancolor: 'WonderSwan Color',
  x68000: 'X68000',
  xbox: 'Xbox',
  xbox360: 'Xbox 360',
  zxspectrum: 'ZX Spectrum'
}

export interface SystemCatalog {
  readonly systems: SystemDefinition[]
  /** Exact id, then case-insensitive id. */
  findSystem(id: string): SystemDefinition | undefined
  /** Match a ROM-root subfolder name to a system by id or alias, case-insensitively. */
  findSystemForFolder(folderName: string): SystemDefinition | undefined
  /** Platform rows (kind 'system') for the given system ids, in catalog order; unknown ids are ignored. */
  platformsForSystems(systemIds: string[]): Platform[]
  /** %EMULATOR_X% names referenced by the system's commands, in order of first use. */
  emulatorIdsFor(system: SystemDefinition): string[]
}

const EMULATOR_PLACEHOLDER = /%EMULATOR_([^%]+)%/g

/** Distinct %EMULATOR_X% names used by a command template. */
export function emulatorIdsInCommand(command: string): string[] {
  const ids: string[] = []
  for (const match of command.matchAll(EMULATOR_PLACEHOLDER))
    if (!ids.includes(match[1])) ids.push(match[1])
  return ids
}

export function platformIconFor(system: SystemDefinition): string {
  return systemIconSlug(system.id, system.manufacturer)
}

export function platformForSystem(system: SystemDefinition, index: number): Platform {
  const platform: Platform = {
    id: system.id,
    name: system.name,
    kind: 'system',
    icon: platformIconFor(system),
    sortOrder: SYSTEM_SORT_BASE + index
  }
  const shortName = SHORT_NAMES[system.id]
  if (shortName) platform.shortName = shortName
  if (system.manufacturer) platform.manufacturer = system.manufacturer
  if (system.releaseYear) platform.releaseYear = system.releaseYear
  return platform
}

export function createSystemCatalog(systems: SystemDefinition[]): SystemCatalog {
  const byId = new Map<string, SystemDefinition>()
  const byFolder = new Map<string, SystemDefinition>()
  const indexOf = new Map<string, number>()
  systems.forEach((system, index) => {
    byId.set(system.id, system)
    indexOf.set(system.id, index)
    byFolder.set(system.id.toLowerCase(), system)
  })
  // Aliases never shadow a real system id.
  for (const system of systems) {
    for (const alias of system.aliases ?? []) {
      const key = alias.toLowerCase()
      if (!byFolder.has(key)) byFolder.set(key, system)
    }
  }
  const byLowerId = new Map([...byId].map(([id, system]) => [id.toLowerCase(), system]))

  return {
    systems,
    findSystem: (id) => byId.get(id) ?? byLowerId.get(id.toLowerCase()),
    findSystemForFolder: (folderName) => byFolder.get(folderName.trim().toLowerCase()),
    platformsForSystems(systemIds) {
      const wanted = new Set(systemIds)
      return systems
        .filter((s) => wanted.has(s.id))
        .map((s) => platformForSystem(s, indexOf.get(s.id) ?? 0))
    },
    emulatorIdsFor(system) {
      const ids: string[] = []
      for (const e of system.emulators)
        for (const id of emulatorIdsInCommand(e.command)) if (!ids.includes(id)) ids.push(id)
      return ids
    }
  }
}

/** Validate the JSON text of systems.json and build the catalog. Throws an Error that names the problem. */
export function parseSystemCatalog(text: string, source = 'systems.json'): SystemCatalog {
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (err) {
    throw new Error(`${source} is not valid JSON: ${(err as Error).message}`, { cause: err })
  }
  const parsed = systemsFileSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ')
    throw new Error(`${source} is malformed: ${issues}`)
  }
  const systems: SystemDefinition[] = Array.isArray(parsed.data) ? parsed.data : parsed.data.systems
  if (!systems.length) throw new Error(`${source} contains no systems`)

  const seen = new Map<string, string>()
  const claim = (name: string, owner: string, kind: string): void => {
    const key = name.toLowerCase()
    const existing = seen.get(key)
    if (existing)
      throw new Error(
        `${source} is malformed: ${kind} '${name}' of system ${owner} collides with ${existing}`
      )
    seen.set(key, `${kind} of ${owner}`)
  }
  for (const s of systems) claim(s.id, s.id, 'id')
  for (const s of systems) for (const alias of s.aliases ?? []) claim(alias, s.id, 'alias')
  for (const s of systems) {
    const ids = new Set<string>()
    for (const e of s.emulators) {
      if (ids.has(e.id))
        throw new Error(`${source} is malformed: duplicate command id '${e.id}' in system ${s.id}`)
      ids.add(e.id)
    }
  }
  return createSystemCatalog(systems)
}

/** Read and validate resources/systems/systems.json once (synchronously, at service creation). */
export function loadSystemCatalog(file: string): SystemCatalog {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    throw new Error(`Cannot read the system definitions at ${file}: ${(err as Error).message}`, {
      cause: err
    })
  }
  return parseSystemCatalog(text, file)
}
