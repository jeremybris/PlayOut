// Which PlayOut system a recompilation's original game came from. decomp-buddy's plans spell consoles in free text
// written by an AI ("Sony PlayStation", "PlayStation 1", "PC (MS-DOS)", "Capcom CP System II (arcade)", over 200
// spellings), RecompLauncher uses short origin codes (n64, x360, ps1, ...). Both map onto PlayOut's ES-DE system ids
// (resources/systems/systems.json) so a ROM game's platformId can be compared with a recompilation's systemId.

/** RecompLauncher `origin` codes. 'other' (and anything unknown) has no system. */
const ORIGIN_CODES: Record<string, string> = {
  n64: 'n64',
  x360: 'xbox360',
  xbox: 'xbox',
  xone: 'xboxone',
  ps1: 'psx',
  psx: 'psx',
  ps2: 'ps2',
  ps3: 'ps3',
  ps4: 'ps4',
  ps5: 'ps5',
  psp: 'psp',
  vita: 'psvita',
  gc: 'gc',
  ngc: 'gc',
  wii: 'wii',
  wiiu: 'wiiu',
  snes: 'snes',
  sfc: 'snes',
  nes: 'nes',
  fds: 'fds',
  gba: 'gba',
  gb: 'gb',
  gbc: 'gbc',
  ds: 'nds',
  nds: 'nds',
  '3ds': 'n3ds',
  n3ds: 'n3ds',
  vb: 'virtualboy',
  dc: 'dreamcast',
  saturn: 'saturn',
  genesis: 'genesis',
  megadrive: 'genesis',
  md: 'genesis',
  s32x: 'sega32x',
  segacd: 'segacd',
  sms: 'mastersystem',
  gg: 'gamegear',
  switch: 'switch',
  switch2: 'switch2',
  arcade: 'arcade',
  cdi: 'cdimono1',
  amiga: 'amiga',
  c64: 'c64',
  dos: 'dos',
  pc: 'pc',
  windows: 'pc',
  mac: 'macintosh',
  '3do': '3do'
}

/** Display names of the systems recompilations come from (short, the way players say them). */
const DISPLAY_NAMES: Record<string, string> = {
  n64: 'Nintendo 64',
  xbox360: 'Xbox 360',
  xbox: 'Xbox',
  xboxone: 'Xbox One',
  psx: 'PlayStation',
  ps2: 'PlayStation 2',
  ps3: 'PlayStation 3',
  ps4: 'PlayStation 4',
  ps5: 'PlayStation 5',
  psp: 'PSP',
  psvita: 'PlayStation Vita',
  gc: 'GameCube',
  wii: 'Wii',
  wiiu: 'Wii U',
  snes: 'Super Nintendo',
  nes: 'NES',
  fds: 'Famicom Disk System',
  gba: 'Game Boy Advance',
  gb: 'Game Boy',
  gbc: 'Game Boy Color',
  nds: 'Nintendo DS',
  n3ds: 'Nintendo 3DS',
  virtualboy: 'Virtual Boy',
  dreamcast: 'Dreamcast',
  saturn: 'Saturn',
  genesis: 'Genesis / Mega Drive',
  sega32x: '32X',
  segacd: 'Sega CD',
  mastersystem: 'Master System',
  gamegear: 'Game Gear',
  switch: 'Nintendo Switch',
  switch2: 'Nintendo Switch 2',
  arcade: 'Arcade',
  cps1: 'Capcom CPS-1 (arcade)',
  cps2: 'Capcom CPS-2 (arcade)',
  cps3: 'Capcom CPS-3 (arcade)',
  neogeo: 'Neo Geo',
  model2: 'Sega Model 2 (arcade)',
  model3: 'Sega Model 3 (arcade)',
  naomi: 'Sega NAOMI (arcade)',
  naomi2: 'Sega NAOMI 2 (arcade)',
  stv: 'Sega ST-V (arcade)',
  triforce: 'Triforce (arcade)',
  cdimono1: 'CD-i',
  amiga: 'Amiga',
  amigacd32: 'Amiga CD32',
  c64: 'Commodore 64',
  apple2: 'Apple II',
  macintosh: 'Macintosh',
  atari2600: 'Atari 2600',
  atari800: 'Atari 8-bit',
  atarist: 'Atari ST',
  atarilynx: 'Atari Lynx',
  zxspectrum: 'ZX Spectrum',
  bbcmicro: 'BBC Micro',
  msx: 'MSX',
  pc98: 'PC-98',
  x68000: 'X68000',
  fmtowns: 'FM Towns',
  ngage: 'N-Gage',
  j2me: 'Java phone',
  flash: 'Adobe Flash',
  pico8: 'PICO-8',
  '3do': '3DO',
  dos: 'MS-DOS',
  pc: 'PC',
  other: 'Other'
}

/**
 * Free-text rules: [pattern, system id (null = a platform PlayOut has no system for, e.g. phones)]. The rule matching
 * EARLIEST in the text wins ("Commodore Amiga / PC (MS-DOS)" is an Amiga game, "PC (Windows) / Sony PlayStation" a PC
 * one); on a tie the rule listed first wins, so the specific spellings come before the general ones.
 */
const RULES: [RegExp, string | null][] = [
  // Phones and other platforms without a system: before "windows" / "pc" so "Windows Mobile" is not a PC game.
  [/\bwindows (?:mobile|phone|ce)\b|\bpocket pc\b/, null],
  [
    /\b(?:android|ios|iphone|ipad|ipod|j2me|java me|java mobile|brew|i-mode|mobile phone|mobile)\b/,
    null
  ],
  [/\braspberry pi\b|\bplaystation vita\b|\bps ?vita\b/, null],
  // Microsoft
  [/\bxbox ?360\b|\bx360\b|\bxbla\b/, 'xbox360'],
  [/\bxbox one\b/, 'xboxone'],
  [/\bxbox\b/, 'xbox'],
  // Sony
  [/\bplaystation ?portable\b|\bpsp\b/, 'psp'],
  [/\bplaystation ?5\b|\bps5\b/, 'ps5'],
  [/\bplaystation ?4\b|\bps4\b/, 'ps4'],
  [/\bplaystation ?3\b|\bps3\b/, 'ps3'],
  [/\bplaystation ?2\b|\bps2\b/, 'ps2'],
  [/\bplaystation(?: ?1)?\b|\bps1\b|\bpsx\b|\bpsone\b/, 'psx'],
  // Nintendo
  [/\bnintendo 64\b|\bn64\b/, 'n64'],
  [/\bgame ?boy advance\b|\bgba\b/, 'gba'],
  [/\bgame ?boy colou?r\b|\bgbc\b/, 'gbc'],
  [/\bgame ?boy\b/, 'gb'],
  [/\bvirtual ?boy\b/, 'virtualboy'],
  [/\b(?:nintendo )?3ds\b/, 'n3ds'],
  [/\bnintendo ds\b|\bnds\b/, 'nds'],
  [/\bswitch ?2\b/, 'switch2'],
  [/\bnintendo switch\b(?! ?2)/, 'switch'],
  [/\bwii ?u\b/, 'wiiu'],
  [/\bwii\b/, 'wii'],
  [/\bgame ?cube\b|\bngc\b/, 'gc'],
  [/\bfamicom disk system\b/, 'fds'],
  [/\bsuper nintendo\b|\bsnes\b|\bsuper famicom\b|\bsfc\b/, 'snes'],
  [/\bnintendo entertainment system\b|\bfamicom\b|\bnes\b/, 'nes'],
  // Arcade boards with their own ES-DE system, then arcade in general (before Sega/Atari/PC: "Sega OutRun arcade").
  [/\bcp ?system ?iii\b|\bcps-?3\b/, 'cps3'],
  [/\bcp ?system ?ii\b|\bcps-?2\b/, 'cps2'],
  [/\bcp ?system(?: ?i)?\b|\bcps-?1\b/, 'cps1'],
  [/\bneo ?geo\b/, 'neogeo'],
  [/\bmodel ?3\b/, 'model3'],
  [/\bmodel ?2[abc]?\b/, 'model2'],
  [/\bnaomi ?2\b/, 'naomi2'],
  [/\bnaomi\b/, 'naomi'],
  [/\bst-v\b|\btitan\b/, 'stv'],
  [/\btriforce\b/, 'triforce'],
  [/\barcade\b/, 'arcade'],
  // Sega
  [/\bdreamcast\b/, 'dreamcast'],
  [/\bsaturn\b/, 'saturn'],
  [/\b32x\b/, 'sega32x'],
  [/\bsega cd\b|\bmega-?cd\b/, 'segacd'],
  [/\bmega ?drive\b|\bgenesis\b/, 'genesis'],
  [/\bmaster system\b/, 'mastersystem'],
  [/\bgame ?gear\b/, 'gamegear'],
  // Others
  [/\bcd-?i\b/, 'cdimono1'],
  [/\b3do\b/, '3do'],
  [/\bamiga cd32\b|\bcd32\b/, 'amigacd32'],
  [/\bamiga\b/, 'amiga'],
  [/\bcommodore 64\b|\bc64\b/, 'c64'],
  [/\bapple ii\b|\bapple 2\b/, 'apple2'],
  [/\bmacintosh\b|\bmac ?os\b|^mac\b|\bmac \(/, 'macintosh'],
  [/\batari 2600\b/, 'atari2600'],
  [/\batari 8-bit\b|\batari 800\b/, 'atari800'],
  [/\batari st\b/, 'atarist'],
  [/\batari lynx\b|\blynx\b/, 'atarilynx'],
  [/\bzx spectrum\b/, 'zxspectrum'],
  [/\bbbc micro\b/, 'bbcmicro'],
  [/\bmsx\b/, 'msx'],
  [/\bpc-98\d*\b|\bpc-9801\b/, 'pc98'],
  [/\bx68000\b/, 'x68000'],
  [/\bfm towns\b/, 'fmtowns'],
  [/\bn-gage\b/, 'ngage'],
  [/\bpico-8\b/, 'pico8'],
  [/\badobe flash\b|^flash\b/, 'flash'],
  // PCs: DOS before Windows ("PC (MS-DOS / Windows)" and "IBM PC (CGA)" are DOS games).
  [/\b(?:ibm )?pc \((?:ms-)?dos\b|\bibm pc\b|\bpc dos\b|\bms-?dos\b|\bdos\b/, 'dos'],
  [/\bwindows\b|\bpc\b|\bpersonal computer\b|\bsteam\b/, 'pc']
]

function earliestRule(text: string): string | null | undefined {
  let best: { index: number; systemId: string | null } | null = null
  for (const [re, systemId] of RULES) {
    const m = re.exec(text)
    if (m && (best === null || m.index < best.index)) best = { index: m.index, systemId }
  }
  return best ? best.systemId : undefined
}

/**
 * The PlayOut system id of a recompilation's original console: decomp-buddy's free text ("Sony PlayStation",
 * "IBM PC (MS-DOS)", "Microsoft Xbox 360") or a RecompLauncher origin code ("x360"). Null when the console is unknown
 * ("Others", "Unknown", RecompLauncher's "other") or a platform PlayOut has no system for (phones).
 */
export function systemIdForConsole(text: string): { systemId: string; console: string } | null {
  const t = String(text ?? '')
    .trim()
    .toLowerCase()
  if (!t) return null
  const code = Object.prototype.hasOwnProperty.call(ORIGIN_CODES, t) ? ORIGIN_CODES[t] : undefined
  const systemId = code ?? earliestRule(t)
  if (!systemId) return null
  return { systemId, console: originDisplayName(systemId) }
}

/** A system id as text for the Recompilation page ("xbox360" → "Xbox 360"). */
export function originDisplayName(systemId: string): string {
  const name = DISPLAY_NAMES[systemId]
  if (name) return name
  if (!systemId) return DISPLAY_NAMES.other
  return systemId.length <= 4
    ? systemId.toUpperCase()
    : systemId[0].toUpperCase() + systemId.slice(1)
}

/**
 * The consoles a recompilation added in the browser may name (RecompBrowser's Add, and PlayOut's list in the
 * metadata cloud): the systems this file has a name for, 'other' last. Each is a system of resources/systems or
 * 'other', so the relay (metadata-relay/src/platforms.ts) takes them all (consoles.test.ts checks it).
 */
export const RECOMP_CONSOLE_IDS: readonly string[] = [
  ...Object.keys(DISPLAY_NAMES).filter((id) => id !== 'other'),
  'other'
]

/** Whether `systemId` is one of RECOMP_CONSOLE_IDS. */
export function isRecompConsole(systemId: unknown): systemId is string {
  return typeof systemId === 'string' && RECOMP_CONSOLE_IDS.includes(systemId)
}
