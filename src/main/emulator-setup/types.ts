import type { Logger } from '../logger'

/**
 * Shared contract of the emulator setup (first-time download, unpack and set-up of the standalone emulators into the
 * "Emulators" folder next to PlayOut.exe). The design is in docs/emulator-setup.md.
 */

/** Where an emulator's Windows x64 build is found. */
export type SourceSpec =
  /** A GitHub repo's /releases/latest (stable), the first asset whose name matches. */
  | { kind: 'github'; repo: string; asset: RegExp }
  /** A Forgejo/Gitea API releases/latest URL (Ryujinx's git.ryujinx.app), the first asset whose name matches. */
  | { kind: 'forgejo'; api: string; asset: RegExp }
  /** dolphin-emu.org's update JSON (the beta track is Dolphin's release track). */
  | { kind: 'dolphin' }
  /** The libretro buildbot's newest stable folder: RetroArch.7z plus RetroArch_cores.7z (version-matched cores). */
  | { kind: 'retroarch' }
  /** ScummVM's newest GitHub release tag, downloaded from downloads.scummvm.org (with its .sha256). */
  | { kind: 'scummvm' }
  /** A fixed URL with a pinned SHA-256 (Model 2: frozen at 1.1a since 2014, no versioned host). */
  | { kind: 'fixed'; url: string; version: string; sha256: string; fileName: string }
  /**
   * A public Google Drive folder holding the unpacked, ready-to-run emulator folder (RPCS3: the user's preconfigured
   * copy), downloaded file by file (drive-folder.ts). `skip` names top-level entries left out (e.g. 'log'). An install
   * from it keeps its own settings: PlayOut's presets are never applied to it, and no other build replaces it.
   */
  | { kind: 'drive-folder'; folderId: string; skip?: string[] }
  // The update channels of Update all emulators (update-sources.ts): the newest nightly / dev builds, from the feed the
  // emulator's own updater reads where it has one.
  /** A GitHub release under a fixed, moving tag (DuckStation's "preview"); the version is its date and digest. */
  | { kind: 'github-tag'; repo: string; tag: string; asset: RegExp }
  /** A GitHub repo's newest release, pre-releases included (PCSX2 nightlies, Azahar release candidates). */
  | { kind: 'github-newest'; repo: string; asset: RegExp[] }
  /** RPCS3's update server (update.rpcs3.net, api v3): the newest master build. */
  | { kind: 'rpcs3' }
  /** dolphin-emu.org's update JSON on the dev track (development builds). */
  | { kind: 'dolphin-dev' }
  /** PPSSPP's buildbot (builds.ppsspp.org/meta/status.json): the newest dev build. */
  | { kind: 'ppsspp-dev' }
  /** Flycast's CI bucket (flycast-builds S3 listing): the newest build of master. */
  | { kind: 'flycast-dev' }
  /** melonDS's nightlies page (melonds.kuribo64.net/nightlies.php). */
  | { kind: 'melonds-nightly' }
  /** mGBA's update manifest (mgba.io/latest.ini, [platform.win64] dev.*), the one its own updater reads. */
  | { kind: 'mgba-dev' }
  /** Ryujinx's update server (update.ryujinx.app, rc=canary), the one its own updater reads. */
  | { kind: 'ryujinx-canary' }
  /** ScummVM's daily builds (buildbot.scummvm.org/dailybuilds/master, the -latest zip). */
  | { kind: 'scummvm-daily' }
  /** The libretro buildbot's nightly: RetroArch_update.7z (frontend) plus RetroArch_cores.7z. */
  | { kind: 'retroarch-nightly' }

/** One file to download for an emulator (RetroArch has two: the frontend and its cores). */
export interface ResolvedDownload {
  /** The version installed (a tag, build number or date), recorded in the manifest. */
  version: string
  url: string
  /** The file name to save it as (its extension is informational: archives are recognised by content). */
  fileName: string
  /** Lower-case hex SHA-256 when the source publishes one (GitHub digest, .sha256 file, pin). */
  sha256?: string
  /** Size in bytes when known (progress before the response's content-length arrives). */
  size?: number
}

/** Visual C++ 2015-2022 x64 runtime, or the DirectX 9 June 2010 runtime (d3dx9_42 / xinput1_3). */
export type RuntimeId = 'vcredist' | 'directx9'

export interface EmulatorSpec {
  /** The find-rules id (%EMULATOR_X%), e.g. 'RPCS3', 'DOLPHIN'. */
  id: string
  /** Display name. */
  name: string
  /** The folder under the emulators root: <root>\<folder>. */
  folder: string
  /** The main executable, relative to <root>\<folder>. */
  exe: string
  source: SourceSpec
  /** Runtimes the emulator needs that a clean Windows lacks. */
  runtimes?: RuntimeId[]
  /**
   * Update all emulators: where the newest build comes from (the feed the emulator's own updater reads, on its
   * nightly / dev channel) and what that channel is called. Absent: the emulator publishes no newer builds (Model 2).
   */
  update?: {
    source: SourceSpec
    channel: string
    /** Runtimes the update channel's build needs beyond `runtimes` (Azahar's MSVC build: Visual C++). */
    runtimes?: RuntimeId[]
  }
  /**
   * Files (or folders, ending in '/') of a new build that are user settings: not replaced when already installed
   * (overlay.ts keepRule). Folders under a junction are never written anyway.
   */
  keep?: string[]
}

/** Runs a program and waits (injectable for tests). Never uses a shell. */
export type Runner = (
  file: string,
  args: string[],
  options?: { cwd?: string; timeoutMs?: number }
) => Promise<{ code: number | null; stdout: string; stderr: string }>

/** What every configurator gets. */
export interface ConfigureContext {
  /** The emulator's folder: <root>\<folder>. */
  emuDir: string
  /** The data Emulation folder in use (Settings › Library › Emulation Folder; default <userData>\Emulation). */
  dataDir: string
  run: Runner
  log: Logger
}

/** The manifest at <root>\.playout\emulators.json. */
export interface SetupManifest {
  version: 1
  /** id -> what is installed. */
  installed: Record<string, InstalledEmulator>
  /** The data Emulation folder the emulators were last pointed at (reconfigure when it changes). */
  configuredFor: string | null
  /**
   * id -> the configure version (configure.ts CONFIGURE_VERSIONS) the emulator was last configured with. Below the
   * current one, startup configures that emulator again (e.g. RPCS3's dev_hdd0 moving to roms\PS3 HDD in 0.1.109).
   * Missing: 1 (older manifests read as {}).
   */
  configured: Record<string, number>
  /**
   * Every catalog emulator was installed here once: automatic setup at launch stops (Settings > Emulators can still
   * install). Kept per root, so a dev run into another folder does not mark the packaged app's root done.
   */
  completed: boolean
  /**
   * id -> the PRESETS_VERSION (presets/index.ts) of the fullscreen and controller presets applied to that emulator.
   * Missing: never applied (the next startup applies them with firstTime true). Older manifests read as {}.
   */
  presets: Record<string, number>
}

export interface InstalledEmulator {
  version: string
  /** Absolute path of the main executable. */
  exe: string
  installedAt: string
  /**
   * 'drive-folder': installed from a preconfigured Drive folder, whose settings win (PlayOut's presets are never
   * applied to it). Missing for every other source.
   */
  source?: 'drive-folder'
  /** The channel of `version` when Update all emulators put it in (nightly, dev, ...); absent for the setup's build. */
  channel?: string
  /** When Update all emulators last put a build in (ISO). */
  updatedAt?: string
}

export type { Logger }
