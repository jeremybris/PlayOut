/**
 * Settings › Convert: the conversions PlayOut offers, per platform. Each pair is two formats with a direction; the
 * arrow flips it. The work is done by Game Format Converter (a separate GPL program PlayOut downloads on first use,
 * main/convert): a direction is the converter's `--to` targets run in order (two for a conversion it has no direct
 * route for, through a temporary file). Whether one file can take a direction is decided by the converter itself
 * (it reads the file), so a pair here only says what the platform's files usually allow. Some directions PlayOut runs
 * itself instead (`builtIn`): PS4 packages, and every Xbox / Xbox 360 direction (its Xbox image helper).
 */
import type { Translate } from './i18n'

/**
 * The notes a direction can show under its pair. The text is in the language files (settingsConvert.notes.<id>), so
 * a direction names a note by id; convert.test.ts checks that every id used here has an English text.
 */
export type ConvertNoteId =
  | 'singleTrack'
  | 'isoUnchecked'
  | 'popstarter'
  | 'playlistPbp'
  | 'cdOnlyBin'
  | 'cso2RealPsp'
  | 'encryptedDiscs'
  | 'ps3PackageWithUpdates'
  | 'psnFolderToPackage'
  | 'splitImage'
  | 'ps4Package'
  | 'ps5Package'
  | 'gdromChd'
  | 'wudUnchecked'
  | 'xboxTrim'
  | 'windowsNames'
  | 'xboxChd'
  | 'x360Xiso'
  | 'zarXenia'
  | 'zarToIso'
  | 'godPackage'
  | 'n64ByteOrder'
  | 'snesHeaderOffSfc'
  | 'snesHeaderOnFlash'
  | 'interleavedToPlain'
  | 'plainToInterleaved'
  | 'headerOff'
  | 'headerOn'
  | 'trimPadding'
  | 'padToFull'
  | 'switchMerge'
  | 'switchSplit'
  | 'experimental'
  | 'decryptedForEmulators'
  | 'decryptedOnly'

/**
 * A direction's note in the caller's language. The key is built from the id (a typed union, so no other value
 * reaches it); convert.test.ts checks every id has its text in English.
 */
export function convertNoteText(note: ConvertNoteId, t: Translate): string {
  return t(`settingsConvert.notes.${note}`)
}

/**
 * A file name without its extension, less the ".xiso" a trimmed Xbox image keeps in front of it: "Halo (USA).xiso"
 * (of "Halo (USA).xiso.iso", what Trim Games and Convert make of "Halo (USA).iso") -> "Halo (USA)". Titles, matching
 * and metadata keys go by the game's name, never by the format its file is in.
 */
export function withoutXisoSuffix(stem: string): string {
  return stem.replace(/\.xiso$/i, '') || stem
}

/** A format a pair converts from or to. */
export interface ConvertFormat {
  label: string
  /** File extensions picked for it (lowercase, with the dot); empty for a folder format. */
  exts: string[]
  /** The format is a folder (a game folder, an unpacked package): folders are picked instead of files. */
  folder?: boolean
}

/** What a direction needs that is not part of PlayOut or the converter (the user's own keys, their emulator). */
export type ConvertNeed =
  /** Switch: prod.keys, for packages that carry a ticket (packages without one convert without it). */
  | 'switchKeys'
  /** Wii: the Wii common key, or Dolphin (its DolphinTool). */
  | 'wiiKey'
  /** PS3 packages unpacked: RPCS3, or the user's package key. */
  | 'ps3Unpack'
  /** PS3 packages made: the user's package key. */
  | 'ps3PackKey'

export interface ConvertDirection {
  /**
   * Game Format Converter `--to` targets, run in order (each takes the previous one's result). A step may name
   * alternatives, `a|b`: the next is tried when the converter says the file cannot become the one before (a CD with
   * several tracks becomes `cue_single` where a one-track CD becomes `cue`).
   */
  steps: string[]
  /** The converter does not check this result: the original is kept (not sent to the Recycle Bin). */
  unverified?: boolean
  /**
   * The picked files go to the converter together, so it combines a game with its updates and extra content (PS3
   * packages, Switch packages) instead of converting each alone.
   */
  together?: boolean
  needs?: ConvertNeed[]
  /**
   * PlayOut does this conversion itself, without Game Format Converter (nothing is downloaded): `ps4pkg` unpacks a
   * fake PS4 package into a game folder (main/convert/ps4-pkg), `steps` then unused; `ps5pkg` unpacks a fake PS5
   * package into a game folder with PlayOut's PS5 package helper (resources\ps5pkg, on PS5PKGTool's extraction;
   * ps5pkg-helper/), `steps` unused; `xbox` runs PlayOut's Xbox
   * image helper (resources\xbox, on the XISOSharp and CHDSharp libraries; main/convert/xbox-helper), `steps[0]`
   * naming its command (an XboxCommand).
   */
  builtIn?: 'ps4pkg' | 'ps5pkg' | 'xbox'
  /**
   * The result has the original's extension (a DS ROM trimmed, a PC Engine ROM without its header): the converter
   * names it "Game (trimmed).nds" beside the original, and once the original is in the Recycle Bin it takes the
   * original's name.
   */
  keepName?: boolean
  /**
   * The picked folder holds an Xbox 360 Games on Demand package (an extension-less file with its .data folder beside
   * it): each such package in it is converted (convert-service godPackagesIn).
   */
  godPackage?: boolean
  /** Shown under the pair while this direction is chosen (its text: convertNoteText). */
  note?: ConvertNoteId
}

export interface ConvertPair {
  id: string
  left: ConvertFormat
  right: ConvertFormat
  /** Left to right. */
  forward: ConvertDirection
  /** Right to left; absent: the conversion only goes one way (the arrow does not flip). */
  backward?: ConvertDirection
}

export interface ConvertPlatform {
  /** ES-DE system id (the ROM folder's name), or an id of its own for a platform PlayOut does not emulate. */
  id: string
  label: string
  /** Its maker, for its badge while the system list is not at hand (its system's own manufacturer comes first). */
  manufacturer?: string
  pairs: ConvertPair[]
}

/** The Xbox image helper's conversion commands (xbox-helper/README.md). */
export type XboxCommand = 'trim' | 'extract' | 'pack' | 'zar' | 'chd' | 'toiso'

const f = (label: string, ...exts: string[]): ConvertFormat => ({ label, exts })
const folder = (label: string): ConvertFormat => ({ label, exts: [], folder: true })
const to = (
  steps: string | string[],
  extra: Omit<ConvertDirection, 'steps'> = {}
): ConvertDirection => ({
  steps: Array.isArray(steps) ? steps : [steps],
  ...extra
})

/** A direction run by PlayOut's Xbox image helper: every result is checked file by file before the original goes. */
const xbox = (command: XboxCommand, note?: ConvertNoteId): ConvertDirection => ({
  steps: [command],
  builtIn: 'xbox',
  ...(note ? { note } : {})
})

const CUE = f('CUE/BIN', '.cue')
const CHD = f('CHD', '.chd')
const ISO = f('ISO', '.iso')
const PBP = f('PBP', '.pbp')
const ECM = f('ECM', '.ecm')
const CSO = f('CSO', '.cso')
const ZSO = f('ZSO', '.zso')
/** Other CD images the converter reads (Alcohol 120%, Nero, CloneCD, cdrdao). */
const CD_IMAGES = f('MDS/NRG/CCD/TOC', '.mds', '.nrg', '.ccd', '.toc')
/** Nintendo 64's usual byte order (big-endian). */
const Z64 = f('Z64 (big-endian)', '.z64')
const N64_NOTE = 'n64ByteOrder'
/** CHD to CUE/BIN: `cue` for a one-track CD, `cue_single` (one BIN) for a CD with audio tracks. */
const TO_CUE = 'cue|cue_single'

/** CUE/BIN ↔ CHD and CUE/BIN ↔ ECM: what every CD system shares. */
function cdPairs(prefix: string): ConvertPair[] {
  return [
    { id: `${prefix}-cue-chd`, left: CUE, right: CHD, forward: to('chd'), backward: to(TO_CUE) },
    {
      id: `${prefix}-cue-ecm`,
      left: CUE,
      right: ECM,
      forward: to('ecm', { note: 'singleTrack' }),
      backward: to('cue')
    },
    { id: `${prefix}-img-chd`, left: CD_IMAGES, right: CHD, forward: to('chd') },
    { id: `${prefix}-img-cue`, left: CD_IMAGES, right: CUE, forward: to('cue') }
  ]
}

/** ISO ↔ the GameCube and Wii formats. */
function dolphinPairs(prefix: string, wii: boolean): ConvertPair[] {
  const needs: ConvertNeed[] | undefined = wii ? ['wiiKey'] : undefined
  const pair = (id: string, right: ConvertFormat, target: string, keyed: boolean): ConvertPair => ({
    id: `${prefix}-iso-${id}`,
    left: f('ISO', '.iso', '.gcm'),
    right,
    forward: to(target, keyed && needs ? { needs } : {}),
    backward: to('iso', {
      unverified: true,
      note: 'isoUnchecked'
    })
  })
  return [
    pair('rvz', f('RVZ', '.rvz'), 'rvz', true),
    pair('wia', f('WIA', '.wia'), 'wia', true),
    ...(wii ? [pair('wbfs', f('WBFS', '.wbfs'), 'wbfs', true)] : []),
    pair('gcz', f('GCZ', '.gcz'), 'gcz', false),
    pair('ciso', f('CISO', '.ciso'), 'ciso', false)
  ]
}

/** The platforms, in alphabetical order (as Settings › Convert lists them). */
export const CONVERT_PLATFORMS: ConvertPlatform[] = (
  [
    {
      id: 'psx',
      label: 'PlayStation',
      pairs: [
        ...cdPairs('psx'),
        { id: 'psx-cue-pbp', left: CUE, right: PBP, forward: to('pbp'), backward: to('cue') },
        { id: 'psx-chd-pbp', left: CHD, right: PBP, forward: to('pbp'), backward: to('chd') },
        { id: 'psx-iso-pbp', left: ISO, right: PBP, forward: to('pbp') },
        {
          id: 'psx-cue-vcd',
          left: CUE,
          right: f('VCD (POPStarter)', '.vcd'),
          forward: to('vcd', { note: 'popstarter' }),
          backward: to('cue')
        },
        {
          id: 'psx-m3u-pbp',
          left: f('M3U (multi-disc CHD)', '.m3u'),
          right: PBP,
          forward: to('pbp', { note: 'playlistPbp' })
        }
      ]
    },
    {
      id: 'ps2',
      label: 'PlayStation 2',
      pairs: [
        { id: 'ps2-iso-chd', left: ISO, right: CHD, forward: to('chd'), backward: to('iso') },
        {
          id: 'ps2-iso-bin',
          left: ISO,
          right: CUE,
          forward: to(['chd', TO_CUE], { note: 'cdOnlyBin' }),
          backward: to('iso')
        },
        { id: 'ps2-cue-chd', left: CUE, right: CHD, forward: to('chd'), backward: to(TO_CUE) },
        { id: 'ps2-iso-cso', left: ISO, right: CSO, forward: to('cso'), backward: to('iso') },
        { id: 'ps2-iso-zso', left: ISO, right: ZSO, forward: to('zso'), backward: to('iso') },
        { id: 'ps2-cso-chd', left: CSO, right: CHD, forward: to('chd'), backward: to('cso') },
        { id: 'ps2-zso-chd', left: ZSO, right: CHD, forward: to('chd'), backward: to('zso') }
      ]
    },
    {
      id: 'psp',
      label: 'PlayStation Portable',
      pairs: [
        { id: 'psp-iso-cso', left: ISO, right: CSO, forward: to('cso'), backward: to('iso') },
        { id: 'psp-iso-zso', left: ISO, right: ZSO, forward: to('zso'), backward: to('iso') },
        {
          id: 'psp-iso-cso2',
          left: ISO,
          right: f('CSO v2', '.cso'),
          forward: to('cso2', { note: 'cso2RealPsp' }),
          backward: to('iso')
        },
        { id: 'psp-iso-chd', left: ISO, right: CHD, forward: to('chd'), backward: to('iso') },
        { id: 'psp-cso-chd', left: CSO, right: CHD, forward: to('chd'), backward: to('cso') },
        { id: 'psp-zso-chd', left: ZSO, right: CHD, forward: to('chd'), backward: to('zso') }
      ]
    },
    {
      id: 'ps3',
      label: 'PlayStation 3',
      pairs: [
        {
          id: 'ps3-folder-iso',
          left: folder('JB Folder'),
          right: ISO,
          forward: to('iso'),
          backward: to('folder', {
            note: 'encryptedDiscs'
          })
        },
        {
          id: 'ps3-pkg-folder',
          left: f('PKG', '.pkg'),
          right: folder('Unpacked'),
          forward: to('folder', {
            needs: ['ps3Unpack'],
            together: true,
            note: 'ps3PackageWithUpdates'
          }),
          backward: to('pkg', {
            needs: ['ps3PackKey'],
            note: 'psnFolderToPackage'
          })
        },
        { id: 'ps3-iso-chd', left: ISO, right: CHD, forward: to('chd'), backward: to('iso') },
        {
          id: 'ps3-split-iso',
          left: f('Split ISO (.iso.0)', '.0', '.66600'),
          right: ISO,
          forward: to('iso', {
            note: 'splitImage'
          })
        },
        {
          id: 'ps3-split-chd',
          left: f('Split ISO (.iso.0)', '.0', '.66600'),
          right: CHD,
          forward: to('chd')
        }
      ]
    },
    {
      id: 'ps4',
      label: 'PlayStation 4',
      pairs: [
        {
          id: 'ps4-pkg-folder',
          left: f('PKG', '.pkg'),
          right: folder('Game Folder'),
          forward: to('folder', {
            builtIn: 'ps4pkg',
            unverified: true,
            note: 'ps4Package'
          })
        }
      ]
    },
    {
      id: 'ps5',
      label: 'PlayStation 5',
      pairs: [
        {
          id: 'ps5-pkg-folder',
          left: f('PKG', '.pkg'),
          right: folder('Game Folder'),
          forward: to('folder', {
            builtIn: 'ps5pkg',
            unverified: true,
            note: 'ps5Package'
          })
        }
      ]
    },
    {
      id: 'dreamcast',
      label: 'Dreamcast',
      pairs: [
        {
          id: 'dc-gdi-chd',
          left: f('GDI', '.gdi'),
          right: CHD,
          forward: to('chd'),
          backward: to('gdi')
        },
        {
          id: 'dc-cdi-chd',
          left: f('CDI', '.cdi'),
          right: CHD,
          forward: to('chd'),
          backward: to('cdi')
        },
        {
          id: 'dc-cdi-cue',
          left: f('CDI', '.cdi'),
          right: CUE,
          forward: to('cue'),
          backward: to('cdi')
        },
        {
          id: 'dc-cue-chd',
          left: CUE,
          right: CHD,
          forward: to('chd'),
          backward: to(TO_CUE, { note: 'gdromChd' })
        }
      ]
    },
    { id: 'saturn', label: 'Saturn', pairs: cdPairs('saturn') },
    { id: 'segacd', label: 'Sega CD / Mega-CD', pairs: cdPairs('segacd') },
    { id: 'pcenginecd', label: 'PC Engine CD', pairs: cdPairs('pcenginecd') },
    { id: 'neogeocd', label: 'Neo Geo CD', pairs: cdPairs('neogeocd') },
    { id: '3do', label: '3DO', pairs: cdPairs('3do') },
    { id: 'cdimono1', label: 'Philips CD-i', pairs: cdPairs('cdimono1') },
    { id: 'pcfx', label: 'PC-FX', pairs: cdPairs('pcfx') },
    { id: 'amigacd32', label: 'Amiga CD32', pairs: cdPairs('amigacd32') },
    { id: 'gc', label: 'GameCube', pairs: dolphinPairs('gc', false) },
    { id: 'wii', label: 'Wii', pairs: dolphinPairs('wii', true) },
    {
      id: 'wiiu',
      label: 'Wii U',
      pairs: [
        {
          id: 'wiiu-wud-wux',
          left: f('WUD', '.wud'),
          right: f('WUX', '.wux'),
          forward: to('wux'),
          backward: to('wud', {
            unverified: true,
            note: 'wudUnchecked'
          })
        }
      ]
    },
    {
      id: 'xbox',
      label: 'Xbox',
      pairs: [
        {
          id: 'xbox-iso-xiso',
          left: f('ISO (full dump)', '.iso'),
          right: f('XISO (trimmed)', '.iso'),
          forward: xbox('trim', 'xboxTrim')
        },
        {
          id: 'xbox-iso-folder',
          left: ISO,
          right: folder('Game Folder'),
          forward: xbox('extract', 'windowsNames'),
          backward: xbox('pack')
        },
        {
          id: 'xbox-iso-chd',
          left: ISO,
          right: CHD,
          forward: xbox('chd', 'xboxChd'),
          backward: xbox('toiso')
        }
      ]
    },
    {
      id: 'xbox360',
      label: 'Xbox 360',
      pairs: [
        {
          id: 'x360-iso-xiso',
          left: f('ISO (full dump)', '.iso'),
          right: f('XISO (trimmed)', '.iso'),
          forward: xbox('trim', 'x360Xiso')
        },
        {
          id: 'x360-iso-zar',
          left: ISO,
          right: f('ZAR', '.zar'),
          forward: xbox('zar', 'zarXenia'),
          backward: xbox('toiso', 'zarToIso')
        },
        {
          id: 'x360-iso-folder',
          left: ISO,
          right: folder('Game Folder'),
          forward: xbox('extract', 'windowsNames'),
          backward: xbox('pack')
        },
        {
          id: 'x360-folder-zar',
          left: folder('Game Folder'),
          right: f('ZAR', '.zar'),
          forward: xbox('zar'),
          backward: xbox('extract')
        },
        {
          id: 'x360-god-iso',
          left: folder('Games on Demand'),
          right: ISO,
          forward: to('god_iso', {
            godPackage: true,
            unverified: true,
            note: 'godPackage'
          })
        },
        {
          id: 'x360-iso-chd',
          left: ISO,
          right: CHD,
          forward: xbox('chd', 'xboxChd'),
          backward: xbox('toiso')
        }
      ]
    },
    {
      id: 'n64',
      label: 'Nintendo 64',
      pairs: [
        {
          id: 'n64-z64-v64',
          left: Z64,
          right: f('V64 (byte-swapped)', '.v64'),
          forward: to('n64_v64', { note: N64_NOTE }),
          backward: to('n64_z64', { note: N64_NOTE })
        },
        {
          id: 'n64-z64-n64',
          left: Z64,
          right: f('N64 (little-endian)', '.n64'),
          forward: to('n64_n64', { note: N64_NOTE }),
          backward: to('n64_z64', { note: N64_NOTE })
        }
      ]
    },
    {
      id: 'snes',
      label: 'Super Nintendo',
      pairs: [
        {
          id: 'snes-smc-sfc',
          left: f('SMC (copier header)', '.smc', '.swc', '.fig'),
          right: f('SFC', '.sfc'),
          forward: to('snes_strip', {
            note: 'snesHeaderOffSfc'
          }),
          backward: to('snes_add', {
            note: 'snesHeaderOnFlash'
          })
        }
      ]
    },
    {
      id: 'megadrive',
      label: 'Mega Drive / Genesis',
      manufacturer: 'Sega',
      pairs: [
        {
          id: 'md-smd-md',
          left: f('SMD (interleaved)', '.smd'),
          right: f('MD', '.md', '.gen', '.bin'),
          forward: to('md_normal', {
            note: 'interleavedToPlain'
          }),
          backward: to('md_smd', {
            note: 'plainToInterleaved'
          })
        }
      ]
    },
    {
      id: 'pcengine',
      label: 'PC Engine / TurboGrafx-16',
      manufacturer: 'NEC',
      pairs: [
        {
          id: 'pce-header',
          left: f('PCE (copier header)', '.pce', '.sgx'),
          right: f('PCE', '.pce', '.sgx'),
          forward: to('pce_strip', {
            keepName: true,
            note: 'headerOff'
          }),
          backward: to('pce_add', {
            keepName: true,
            note: 'headerOn'
          })
        }
      ]
    },
    {
      id: 'nds',
      label: 'Nintendo DS',
      pairs: [
        {
          id: 'nds-full-trimmed',
          left: f('NDS (full size)', '.nds', '.dsi'),
          right: f('NDS (trimmed)', '.nds', '.dsi'),
          forward: to('nds_trim', {
            keepName: true,
            note: 'trimPadding'
          }),
          backward: to('nds_untrim', {
            keepName: true,
            note: 'padToFull'
          })
        }
      ]
    },
    {
      id: 'switch',
      label: 'Nintendo Switch',
      pairs: [
        {
          id: 'switch-nsp-xci',
          left: f('NSP', '.nsp'),
          right: f('XCI', '.xci'),
          forward: to('xci', {
            needs: ['switchKeys'],
            together: true,
            note: 'switchMerge'
          }),
          backward: to('nsp')
        },
        {
          id: 'switch-nsp-split',
          left: f('NSP (bundle)', '.nsp', '.xci'),
          right: f('Separate NSPs', '.nsp'),
          forward: to('split', {
            together: true,
            note: 'switchSplit'
          })
        }
      ]
    },
    {
      id: 'switch2',
      label: 'Nintendo Switch 2',
      manufacturer: 'Nintendo',
      pairs: [
        {
          id: 'switch2-folder-nup',
          left: folder('Game Folder'),
          right: f('NUP', '.nup'),
          forward: to('nup', { note: 'experimental' }),
          backward: to('folder')
        }
      ]
    },
    {
      id: 'n3ds',
      label: 'Nintendo 3DS',
      pairs: [
        {
          id: '3ds-cci-zcci',
          left: f('3DS', '.3ds', '.cci'),
          right: f('ZCCI', '.zcci'),
          forward: to('z3ds'),
          backward: to('unz3ds')
        },
        {
          id: '3ds-cxi-zcxi',
          left: f('CXI', '.cxi'),
          right: f('ZCXI', '.zcxi'),
          forward: to('z3ds'),
          backward: to('unz3ds')
        },
        {
          id: '3ds-3dsx-z3dsx',
          left: f('3DSX', '.3dsx'),
          right: f('Z3DSX', '.z3dsx'),
          forward: to('z3ds'),
          backward: to('unz3ds')
        },
        {
          id: '3ds-cci-cia',
          left: f('3DS', '.3ds', '.cci'),
          right: f('CIA', '.cia'),
          forward: to('cia', { note: 'decryptedForEmulators' }),
          backward: to('cci', { note: 'decryptedOnly' })
        }
      ]
    }
  ] satisfies ConvertPlatform[]
).sort((a, b) => a.label.localeCompare(b.label, 'en', { numeric: true }))

export function convertPlatform(id: string): ConvertPlatform | undefined {
  return CONVERT_PLATFORMS.find((p) => p.id === id)
}

export function convertPair(platformId: string, pairId: string): ConvertPair | undefined {
  return convertPlatform(platformId)?.pairs.find((p) => p.id === pairId)
}

/** The formats a direction goes from and to. */
export function directionFormats(
  pair: ConvertPair,
  reversed: boolean
): { from: ConvertFormat; to: ConvertFormat; direction: ConvertDirection } | null {
  if (!reversed) return { from: pair.left, to: pair.right, direction: pair.forward }
  return pair.backward ? { from: pair.right, to: pair.left, direction: pair.backward } : null
}

/** A request to convert: the files (or folders) of one format, the platform's pair and its direction. */
export interface ConvertRequest {
  platformId: string
  pairId: string
  /** Right to left. */
  reversed: boolean
  paths: string[]
}

/** Something a direction needs that this PC lacks, and where it goes. */
export interface ConvertMissing {
  need: ConvertNeed
  /** One sentence naming what is missing and why. */
  message: string
  /** Where to put it so it is found (an absolute path in the Emulation folder). */
  place: string
  /** Without it the conversion cannot run (false: only some files need it). */
  blocking: boolean
}

export type ConvertItemState = 'queued' | 'running' | 'done' | 'failed' | 'skipped' | 'stopped'

export interface ConvertItem {
  path: string
  state: ConvertItemState
  /** The converter's own words: the result ("→ Game.chd") or why it failed. */
  detail?: string
  /** What was made. */
  output?: string
  /** How far along the running item is, 0-1, when the work reports it (a PS4 package being unpacked). */
  progress?: number
}

export interface ConvertStatus {
  /** The converter (Game Format Converter) is downloaded: its version, else null. */
  tool: { version: string } | null
  /** Downloading the converter (first use), 0-1 when the size is known. */
  downloading: { fraction: number | null } | null
  running: boolean
  items: ConvertItem[]
  /** The run's own failure (the converter could not be downloaded or started). */
  error?: string
}

/** One conversion a ROM game's own file can take (the game page's Play menu › Convert). */
export interface GameConversion {
  platformId: string
  pairId: string
  /** Right to left. */
  reversed: boolean
  from: ConvertFormat
  to: ConvertFormat
  /** The file or folder that is converted: the ROM, or the game's folder (a PS4 dump, an unpacked game). */
  path: string
  /**
   * The game's system plays the result (it lists the result's format; a folder result counts, the game file in it is
   * found), so the game stays playable in the library afterwards. False for a result it does not play (an Xbox 360
   * ISO to CHD): the game then has no playable file, and the original is in the Recycle Bin.
   */
  playable: boolean
}

/** What conversionsForGame needs to know of the game's system (a SystemDefinition). */
export interface GameConversionSystem {
  id: string
  platformKey?: string
  extensions: string[]
  dirExtensions?: string[]
}

/**
 * Platforms whose ROM scan lists an unpacked game folder as one game (rom-scanner: a PS3 JB / PSN folder; an Xbox,
 * Xbox 360, PS4 or PS5 folder through its default.xbe, default.xex or eboot.bin). A folder made for any other system
 * is not a game there.
 */
const FOLDER_GAME_PLATFORMS: ReadonlySet<string> = new Set(['ps3', 'ps4', 'ps5', 'xbox', 'xbox360'])

/** System ids of ES-DE's regional / alternative folders whose games convert as another platform's. */
const CONVERT_ALIASES: Readonly<Record<string, string>> = {
  megacd: 'segacd',
  megacdjp: 'segacd',
  saturnjp: 'saturn',
  'tg-cd': 'pcenginecd',
  neogeocdjp: 'neogeocd',
  genesis: 'megadrive',
  megadrivejp: 'megadrive'
}

/** A file name's last extension, lower case, with its dot ('' when it has none). */
function lastExtension(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

/**
 * The conversions a ROM game's own file can take, for its page's Play menu:
 * - its platform's pairs only (an Xbox 360 game gets Xbox 360 conversions; Mega-CD, Japanese Saturn, TurboGrafx-CD and
 *   Neo Geo CD JP games convert as Sega CD, Saturn, PC Engine CD and Neo Geo CD);
 * - in each direction whose "from" format is the game's (its file's extension; a folder format for a game that is a
 *   folder: a PS4 dump, an unpacked game; a PS3 disc folder (PS3_GAME) and a PSN folder each only their own);
 * - every such direction, each saying whether the game's system plays its result (`playable`: convert-service moves
 *   the game's record onto it, or onto the game file in an extracted folder);
 * - one entry per result format (PSP CSO and CSO v2 both read back to ISO: the first), and no trim for an image already
 *   trimmed (`.xiso.iso`).
 * None without the system (not known yet), and for a game that is not a ROM on this PC (a host's game, one not
 * installed, one whose disc image went to the Recycle Bin for its recompilation).
 */
export function conversionsForGame(
  game: {
    source: string
    platformId: string
    installed: boolean
    romPath?: string
    romRemoved?: unknown
    remote?: unknown
    launch?: { kind: string; systemId?: string }
    extra?: Record<string, unknown>
  },
  system: GameConversionSystem | null | undefined
): GameConversion[] {
  if (!system) return []
  if (game.source !== 'rom' || !game.installed || game.romRemoved || game.remote || !game.romPath)
    return []
  const platform =
    convertPlatform(system.id) ??
    convertPlatform(CONVERT_ALIASES[system.id] ?? '') ??
    (system.platformKey ? convertPlatform(system.platformKey) : undefined)
  if (!platform) return []
  const listed = new Set(
    [...system.extensions, ...(system.dirExtensions ?? [])].map((e) => e.toLowerCase())
  )
  const gameFolder =
    typeof game.extra?.['gameFolder'] === 'string' ? game.extra['gameFolder'] : null
  const isFolder = !!gameFolder || game.extra?.['directory'] === true
  const ps3Kind = game.extra?.['ps3Kind']
  const folderGames = [system.id, system.platformKey].some(
    (key) => !!key && FOLDER_GAME_PLATFORMS.has(key)
  )
  const path = gameFolder ?? game.romPath
  const ext = isFolder ? '' : lastExtension(game.romPath)
  const trimmed = /\.xiso\.iso$/i.test(game.romPath)
  const out: GameConversion[] = []
  for (const pair of platform.pairs) {
    for (const reversed of [false, true]) {
      const formats = directionFormats(pair, reversed)
      if (!formats) continue
      const { from, to, direction } = formats
      if (isFolder ? !from.folder : from.folder || !from.exts.includes(ext)) continue
      // A PS3 folder is a disc (PS3_GAME: it becomes an ISO) or a PSN game (it becomes a package), never both.
      if (pair.id === 'ps3-folder-iso' && !reversed && ps3Kind !== 'disc') continue
      if (pair.id === 'ps3-pkg-folder' && reversed && ps3Kind !== 'psn') continue
      if (trimmed && direction.builtIn === 'xbox' && direction.steps[0] === 'trim') continue
      // A Games on Demand package is not a library game (an Xbox 360 game folder is an extracted disc).
      if (direction.godPackage) continue
      const keepsOriginal =
        !!direction.unverified || direction.builtIn === 'ps4pkg' || direction.builtIn === 'ps5pkg'
      const playable =
        keepsOriginal || (to.folder ? folderGames : to.exts.some((e) => listed.has(e)))
      if (out.some((c) => c.to.label === to.label)) continue
      out.push({ platformId: platform.id, pairId: pair.id, reversed, from, to, path, playable })
    }
  }
  return out
}
