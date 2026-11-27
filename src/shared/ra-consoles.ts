// The consoles RetroAchievements has achievements for (rcheevos rc_consoles.h), by PlayOut system id: shared, so a
// game page knows a system RetroAchievements does not cover (PlayStation 3, Xbox 360) without asking it.

/** RetroAchievements console ids (rcheevos rc_consoles.h). */
export const RA_CONSOLE = {
  megadrive: 1,
  n64: 2,
  snes: 3,
  gb: 4,
  gba: 5,
  gbc: 6,
  nes: 7,
  pcengine: 8,
  segacd: 9,
  sega32x: 10,
  mastersystem: 11,
  psx: 12,
  lynx: 13,
  ngp: 14,
  gamegear: 15,
  gamecube: 16,
  jaguar: 17,
  nds: 18,
  wii: 19,
  ps2: 21,
  odyssey2: 23,
  pokemini: 24,
  atari2600: 25,
  arcade: 27,
  virtualboy: 28,
  msx: 29,
  amstradcpc: 37,
  apple2: 38,
  pc88: 47,
  arcadia: 73,
  uzebox: 80,
  sg1000: 33,
  saturn: 39,
  dreamcast: 40,
  psp: 41,
  threedo: 43,
  colecovision: 44,
  intellivision: 45,
  vectrex: 46,
  pcfx: 49,
  atari7800: 51,
  wonderswan: 53,
  neogeocd: 56,
  channelf: 57,
  zxspectrum: 59,
  supervision: 63,
  tic80: 65,
  megaduck: 69,
  arduboy: 71,
  wasm4: 72,
  pcenginecd: 76,
  jaguarcd: 77,
  fds: 81
} as const

/** PlayOut system id (resources/systems/systems.json) -> RetroAchievements console id. */
const SYSTEM_CONSOLES: Record<string, number> = {
  nes: RA_CONSOLE.nes,
  famicom: RA_CONSOLE.nes,
  fds: RA_CONSOLE.fds,
  snes: RA_CONSOLE.snes,
  sfc: RA_CONSOLE.snes,
  snesna: RA_CONSOLE.snes,
  n64: RA_CONSOLE.n64,
  gb: RA_CONSOLE.gb,
  gbc: RA_CONSOLE.gbc,
  gba: RA_CONSOLE.gba,
  nds: RA_CONSOLE.nds,
  genesis: RA_CONSOLE.megadrive,
  megadrive: RA_CONSOLE.megadrive,
  megadrivejp: RA_CONSOLE.megadrive,
  segacd: RA_CONSOLE.segacd,
  megacd: RA_CONSOLE.segacd,
  megacdjp: RA_CONSOLE.segacd,
  sega32x: RA_CONSOLE.sega32x,
  sega32xjp: RA_CONSOLE.sega32x,
  sega32xna: RA_CONSOLE.sega32x,
  mastersystem: RA_CONSOLE.mastersystem,
  mark3: RA_CONSOLE.mastersystem,
  gamegear: RA_CONSOLE.gamegear,
  'sg-1000': RA_CONSOLE.sg1000,
  psx: RA_CONSOLE.psx,
  ps2: RA_CONSOLE.ps2,
  psp: RA_CONSOLE.psp,
  saturn: RA_CONSOLE.saturn,
  saturnjp: RA_CONSOLE.saturn,
  dreamcast: RA_CONSOLE.dreamcast,
  gc: RA_CONSOLE.gamecube,
  wii: RA_CONSOLE.wii,
  atari2600: RA_CONSOLE.atari2600,
  atari7800: RA_CONSOLE.atari7800,
  atarilynx: RA_CONSOLE.lynx,
  atarijaguar: RA_CONSOLE.jaguar,
  atarijaguarcd: RA_CONSOLE.jaguarcd,
  pcengine: RA_CONSOLE.pcengine,
  tg16: RA_CONSOLE.pcengine,
  supergrafx: RA_CONSOLE.pcengine,
  pcenginecd: RA_CONSOLE.pcenginecd,
  'tg-cd': RA_CONSOLE.pcenginecd,
  pcfx: RA_CONSOLE.pcfx,
  ngp: RA_CONSOLE.ngp,
  ngpc: RA_CONSOLE.ngp,
  virtualboy: RA_CONSOLE.virtualboy,
  wonderswan: RA_CONSOLE.wonderswan,
  wonderswancolor: RA_CONSOLE.wonderswan,
  colecovision: RA_CONSOLE.colecovision,
  intellivision: RA_CONSOLE.intellivision,
  vectrex: RA_CONSOLE.vectrex,
  odyssey2: RA_CONSOLE.odyssey2,
  videopac: RA_CONSOLE.odyssey2,
  pokemini: RA_CONSOLE.pokemini,
  msx: RA_CONSOLE.msx,
  msx1: RA_CONSOLE.msx,
  msx2: RA_CONSOLE.msx,
  '3do': RA_CONSOLE.threedo,
  neogeocd: RA_CONSOLE.neogeocd,
  neogeocdjp: RA_CONSOLE.neogeocd,
  channelf: RA_CONSOLE.channelf,
  zxspectrum: RA_CONSOLE.zxspectrum,
  supervision: RA_CONSOLE.supervision,
  tic80: RA_CONSOLE.tic80,
  megaduck: RA_CONSOLE.megaduck,
  arduboy: RA_CONSOLE.arduboy,
  wasm4: RA_CONSOLE.wasm4,
  arcade: RA_CONSOLE.arcade,
  'mame-advmame': RA_CONSOLE.arcade,
  sgb: RA_CONSOLE.gb,
  sufami: RA_CONSOLE.snes,
  satellaview: RA_CONSOLE.snes,
  n64dd: RA_CONSOLE.n64,
  msxturbor: RA_CONSOLE.msx,
  amstradcpc: RA_CONSOLE.amstradcpc,
  apple2: RA_CONSOLE.apple2,
  pc88: RA_CONSOLE.pc88,
  arcadia: RA_CONSOLE.arcadia,
  uzebox: RA_CONSOLE.uzebox,
  mame: RA_CONSOLE.arcade,
  fba: RA_CONSOLE.arcade,
  fbneo: RA_CONSOLE.arcade,
  neogeo: RA_CONSOLE.arcade,
  cps1: RA_CONSOLE.arcade,
  cps2: RA_CONSOLE.arcade,
  cps3: RA_CONSOLE.arcade,
  cps: RA_CONSOLE.arcade
}

/** The RetroAchievements console of a PlayOut system id; null when RetroAchievements has none. */
export function raConsoleFor(systemId: string): number | null {
  return SYSTEM_CONSOLES[systemId.toLowerCase()] ?? null
}

/**
 * `metadata.sources.retroachievements` of a ROM the RetroAchievements sync found has no achievements: its ROM's hash is
 * in none of its console's games with achievements (RetroAchievements' list, loaded whole), or the game it matched has
 * none. Otherwise that source holds the RetroAchievements game id.
 */
export const RA_NONE = 'none'

/**
 * Systems whose ROM hash this PlayOut computes as RetroAchievements does (ra-hash.ts): a hash found in no game of the
 * console means the ROM has no achievements. Not for systems added without their own hashing rules (Amstrad CPC,
 * Apple II, PC-88, Arcadia, Uzebox, 64DD disks) or hashed another way (Arduboy): a miss there may be PlayOut's hash.
 */
export function raHashTrusted(systemId: string): boolean {
  return !UNTRUSTED_HASH_SYSTEMS.has(systemId.toLowerCase()) && raConsoleFor(systemId) !== null
}
const UNTRUSTED_HASH_SYSTEMS = new Set([
  'amstradcpc',
  'apple2',
  'pc88',
  'arcadia',
  'uzebox',
  'n64dd',
  // rcheevos hashes an Arduboy .hex as text lines; PlayOut hashes its bytes.
  'arduboy'
])

/**
 * A ROM game PlayOut knows has no RetroAchievements, so its page leaves the RetroAchievements section out: its system
 * has none (PlayStation 3, Xbox 360, Switch: also a recompilation's game), its recompilation stands in for it (its
 * disc image deleted: the port is played, never the ROM), or the RetroAchievements sync found none for it (RA_NONE). Not known (signed out, a game the sync has not checked, a title-only miss): false, and the section
 * stays to say how to sign in.
 */
export function knownWithoutRetroAchievements(game: {
  platformId: string
  metadata: { achievements?: unknown; sources?: Record<string, unknown> }
  romRemoved?: unknown
}): boolean {
  if (game.metadata.achievements) return false
  if (raConsoleFor(game.platformId) === null) return true
  // Its disc image went for its recompilation: Play starts the PC port, which RetroAchievements does not track.
  if (game.romRemoved) return true
  return game.metadata.sources?.['retroachievements'] === RA_NONE
}
