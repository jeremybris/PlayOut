// Upgrades (the game page's sparkles button, PC games only): five ways to improve an installed PC game, each built on
// an open-source project (docs/research/upgrades). Shared between main (src/main/upgrades/) and the renderer
// (screens/GameDetail/UpgradeMenu.tsx).
// - DLL update: the game's DLSS / FSR / XeSS files replaced by the newest official ones (idea: DLSS Swapper; files
//   from NVIDIA, AMD and Intel's own GitHub releases only), originals kept to put back.
// - DLSS 5: NVIDIA's DLSS 5 Neural Rendering through the DLSS AiO Swapper app (downloaded, then opened).
// - Shaders: the game's shaders precompiled into the graphics driver's cache by SCSKiller's command line.
// - OptiScaler: installed into the game so AMD / Intel graphics can use its DLSS options (FSR / XeSS behind them).
// - Compression: the game folder compressed by Windows (compact.exe, as CompactGUI does), or uncompressed.

import type { Translate } from './i18n'

/** The five upgrades. */
export type UpgradeId = 'dlls' | 'dlss5' | 'shaders' | 'optiscaler' | 'compress'

/** The graphics card games run on (the dedicated one when there are several). */
export interface GpuInfo {
  vendor: 'nvidia' | 'amd' | 'intel' | 'other'
  /** As Windows names it ("NVIDIA GeForce RTX 4070"). */
  name: string
  /** NVIDIA GeForce RTX series (20, 30, 40, 50), else null. */
  rtxSeries: number | null
  /** The vendor's driver version ("561.56" for NVIDIA), if known. */
  driver: string | null
}

/** A swappable upscaler / frame generation file, by the file name games ship it under. */
export type UpscalerDllKind =
  | 'dlss' // nvngx_dlss.dll
  | 'dlssg' // nvngx_dlssg.dll (DLSS Frame Generation)
  | 'dlssd' // nvngx_dlssd.dll (DLSS Ray Reconstruction)
  | 'fsr-dx12' // amd_fidelityfx_dx12.dll (FSR 3.1 loader)
  | 'fsr-vk' // amd_fidelityfx_vk.dll
  | 'xess' // libxess.dll
  | 'xess-dx11' // libxess_dx11.dll
  | 'xess-fg' // libxess_fg.dll
  | 'xell' // libxell.dll

/** One upscaler file found in a game's folder. */
export interface FoundUpscalerDll {
  kind: UpscalerDllKind
  /** Path inside the game's folder ("Engine\\Binaries\\ThirdParty\\nvngx_dlss.dll"). */
  relPath: string
  /** Its file version ("3.5.10.0"); null when unreadable. */
  version: string | null
  /** PlayOut replaced it and keeps the original to put back. */
  swapped: boolean
}

/** One kind of upscaler file in a game, as the menu's DLL row sums it up (versions as the player knows them). */
export interface DllKindSummary {
  kind: UpscalerDllKind
  /** The game's version ("3.5.10", FSR's own "3.1.1"); the oldest one when it has several files; null: unreadable. */
  version: string | null
  /** The newest official version ("310.9.16"); null when not known yet or unreachable. */
  latest: string | null
  /** A file of this kind can take the newest one. */
  updatable: boolean
}

/** What can be done with a game's upscaler files. */
export interface DllUpgradeState {
  found: FoundUpscalerDll[]
  /** Per kind found (in the order found): the game's and the newest version, for the menu's hint. */
  kinds: DllKindSummary[]
  /** The newest official version per kind found in the game (null: not known yet / unreachable). */
  latest: Partial<Record<UpscalerDllKind, string | null>>
  /** Some found file is older than the newest. */
  updatable: boolean
  /** Some file was replaced by PlayOut (Restore puts the originals back). */
  restorable: boolean
}

export interface OptiScalerState {
  /** Installed by PlayOut: into which folder (inside the game), under which file name, which version. */
  installed: { relDir: string; asName: string; version: string } | null
  /** The newest OptiScaler release ("0.9.5"), null when not known yet. */
  latest: string | null
  /** The game ships DLSS, FSR or XeSS files OptiScaler can take over (it needs one of them). */
  hasInputs: boolean
}

export interface ShaderState {
  /** Why precompiling is not offered (Intel graphics, the game cannot be upgraded), else null. */
  unavailable: string | null
  /**
   * Why the last precompile could not be done (SCSKiller does not list the game yet, the graphics driver cannot do it,
   * the game needs a recording), else null. Shown as a hint only: the row stays enabled, since a later SCSKiller scan
   * or a driver update can change the answer.
   */
  note: string | null
  /** When PlayOut last precompiled this game's shaders (ISO date), if ever. */
  compiledAt: string | null
}

export interface CompressState {
  /** 'none': not compressed; 'partial': some files are (a game update rewrote others); 'compressed'. */
  state: 'none' | 'partial' | 'compressed'
  /** Size of the game's files / what they take on disk now (bytes), when measured. */
  size: number | null
  onDisk: number | null
  /** CompactGUI's community estimate of the saving for this Steam game (0..1 of the size), if it has one. */
  estimatedSaving: number | null
  /** Why it cannot be compressed here (not NTFS, a protected folder), else null. */
  unavailable: string | null
}

export interface Dlss5State {
  /** Why DLSS 5 is not offered (not an NVIDIA RTX card), else null. */
  unavailable: string | null
  /** The DLSS AiO Swapper app is downloaded (Open starts it at once). */
  appReady: boolean
}

/** The ban-risk signals of a game (shown before an upgrade is turned on). */
export interface UpgradeRisk {
  /** The game's multiplayer Steam tags among RISK_TAGS. */
  tags: string[]
  /** Anti-cheat found in its folder ("Easy Anti-Cheat", "BattlEye", …). */
  antiCheat: string[]
}

/** Everything the Upgrade menu shows for one game. */
export interface UpgradeStatus {
  gameId: string
  gpu: GpuInfo | null
  risk: UpgradeRisk
  /** Why upgrades cannot be used for this game at all (no install folder, the game is running), else null. */
  blocked: string | null
  dlls: DllUpgradeState
  dlss5: Dlss5State
  shaders: ShaderState
  optiscaler: OptiScalerState
  compress: CompressState
  /** An upgrade is running for this game. */
  busy: UpgradeId | null
  /**
   * The game's folder is still being read (a big game's first look): its DLSS / FSR / XeSS files and OptiScaler are
   * not known yet, so those rows wait; the menu asks again shortly.
   */
  scanning: boolean
}

export type CompressAlgorithm = 'xpress4k' | 'xpress8k' | 'xpress16k' | 'lzx'

/** What the menu asks main to do. */
export type UpgradeAction =
  | { kind: 'dlls-update' }
  | { kind: 'dlls-restore' }
  | { kind: 'dlss5-open' }
  | { kind: 'shaders-compile' }
  | { kind: 'optiscaler-install' }
  | { kind: 'optiscaler-remove' }
  | { kind: 'compress'; algorithm: CompressAlgorithm }
  | { kind: 'uncompress' }

/** Actions that turn an upgrade on (the ban-risk warning comes first on a risky game); the rest undo one. */
export const ENABLING_ACTIONS: ReadonlySet<UpgradeAction['kind']> = new Set([
  'dlls-update',
  'dlss5-open',
  'shaders-compile',
  'optiscaler-install',
  'compress'
])

/** Progress of a running upgrade ('upgrades:progress'). */
export interface UpgradeProgress {
  gameId: string
  upgrade: UpgradeId
  state: 'running' | 'done' | 'failed'
  /** 0..1 when known. */
  progress: number | null
  /** One line for the player ("Downloading DLSS 310.9.16…", "Compressed: 41.2 GB → 30.8 GB"). */
  message: string
}

/**
 * Steam tags of games whose anti-cheat may ban modified clients (the user's list): any of them on a game brings the
 * warning before an upgrade is turned on.
 */
export const RISK_TAGS: readonly string[] = [
  'Free to Play',
  'PvP',
  'eSports',
  'Competitive',
  'Team-Based',
  'Massively Multiplayer',
  'Online Co-Op',
  'Multiplayer'
]

/** The upgrade an action belongs to. */
export function upgradeOf(action: UpgradeAction): UpgradeId {
  switch (action.kind) {
    case 'dlls-update':
    case 'dlls-restore':
      return 'dlls'
    case 'dlss5-open':
      return 'dlss5'
    case 'shaders-compile':
      return 'shaders'
    case 'optiscaler-install':
    case 'optiscaler-remove':
      return 'optiscaler'
    case 'compress':
    case 'uncompress':
      return 'compress'
  }
}

/** The risk-tag matches among a game's tags (case-insensitive, in RISK_TAGS order). */
export function riskTagsOf(tags: readonly string[]): string[] {
  const have = new Set(tags.map((t) => t.trim().toLowerCase()))
  return RISK_TAGS.filter((t) => have.has(t.toLowerCase()))
}

/** Name of the folder beside PlayOut.exe holding the downloaded tools and files (kept by updates). */
export const UPGRADES_FOLDER = 'Upgrades'

/**
 * Why Play, Co-Op or deleting a game is refused while an upgrade runs for it (it may be rewriting the game's files).
 * Both processes show it, so the caller passes its translator: tMain in main, t in the renderer.
 */
export function upgradeRunningMessage(t: Translate): string {
  return t('upgrades.running')
}
