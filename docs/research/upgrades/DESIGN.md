# Upgrades: design contract

The user's request (2026-11-19): a sparkles **Upgrade** button right of Play and its dropdown, PC games only, opening
a menu with five upgrades. Decisions: see memory `upgrade-menu-decisions` and `src/shared/upgrades.ts`.

Specs gathered from upstream sources (read them before implementing):
- `vendor-dlls.md`: newest NVIDIA DLSS / Intel XeSS / AMD FSR files, URLs, signers, compatibility rules.
- `optiscaler.md`: OptiScaler release layout and install/uninstall steps.
- `scskiller.md`: SCSKiller portable release and CLI.
- `aio-compact.md`: DLSS AiO Swapper launch; compact.exe / WOF compression, CompactGUI database.
- `gpu-anticheat.md`: GPU detection, anti-cheat folder signatures.

## Rules for every module
- New files only, under `src/main/upgrades/`, each with a `*.test.ts` beside it (vitest, temp dirs, fakes; no network,
  never run a real downloaded binary in tests or while developing).
- Every outside effect (HTTP, spawning a process, PowerShell, Authenticode check, archive extraction, clock) goes through
  an injected `deps` object, so the service can wire real ones and tests fake ones. Reuse the repo's helpers in the
  real wiring (the service does it): `downloadFile` / `fetchJson` (src/main/emulator-setup/download.ts),
  `extractArchive` + `ensureSevenZip` (emulator-setup/archive.ts, sevenzip.ts), `runProcess` (emulator-setup/run.ts),
  the PowerShell worker (src/main/system/ps-worker.ts).
- Downloads come only from the projects' / vendors' own GitHub (api.github.com, github.com release assets,
  raw.githubusercontent.com). Verify what the source offers (git blob SHA-1 for raw files, GitHub asset `digest`
  sha256, SHA256SUMS). Vendor DLLs must also pass an Authenticode check pinned to their signer.
- Game folders are changed reversibly: every replaced file kept as `<file>.playout-original` (never overwriting an
  existing backup), every added file listed in a manifest, so Restore / Remove puts the folder back exactly.
- Never follow junctions / symlinks while scanning; cap depth (8) and file count; skip `WindowsApps` folders (report
  "protected folder").
- Use the house style: plain-English doc comments on exports, no abbreviations in user-facing text, Prettier (2 spaces,
  no semicolons, single quotes, 100 cols).

## Module APIs (exports the service calls)

### gpu.ts
```ts
export function parseVideoControllers(json: string): GpuInfo[]   // output of the CIM query (see gpu-anticheat.md)
export function primaryGpu(gpus: GpuInfo[]): GpuInfo | null      // dedicated NVIDIA/AMD over Intel iGPU, etc.
export const VIDEO_CONTROLLER_SCRIPT: string                    // PowerShell printing the JSON parseVideoControllers reads
export function nvidiaDriverVersion(windowsVersion: string): string | null // 31.0.15.6156 -> 561.56
```

### anticheat.ts
```ts
export function gameRiskTags(game: Pick<Game,'metadata'>): string[] // riskTagsOf(steamTags.tags + genres + tags)
export async function findAntiCheat(installDir: string, io?: FsIo): Promise<string[]> // names found (bounded scan)
```

### dlls.ts
```ts
export const DLL_FILE_NAMES: Record<UpscalerDllKind, string>
export async function scanUpscalerDlls(installDir: string, io?): Promise<Array<FoundUpscalerDll & { path: string }>>
export function readPeFileVersion(buf: Buffer): string | null      // VS_FIXEDFILEINFO numeric parts
export interface VendorDll { kind: UpscalerDllKind; version: string; fileName: string; url: string; size: number;
  gitBlobSha: string | null; sha256: string | null; signer: 'NVIDIA Corporation' | 'Intel Corporation' |
  'Advanced Micro Devices, Inc.' | 'Microsoft Windows Hardware Compatibility Publisher' }
export async function latestVendorDlls(deps: { fetchJson }): Promise<Partial<Record<UpscalerDllKind, VendorDll>>>
export async function ensureVendorDll(file: VendorDll, cacheDir: string,
  deps: { download; verifySigner(path, expectedSigner, companyName?): Promise<boolean> }): Promise<string>
export function compareVersions(a: string, b: string): number
export async function swapDlls(installDir: string, found, files: Partial<Record<UpscalerDllKind, {path; version}>>, io?)
  : Promise<{ replaced: string[]; skipped: { relPath: string; reason: string }[] }>   // never downgrades
export async function restoreDlls(installDir: string, found, io?): Promise<{ restored: string[] }>
```

### optiscaler.ts
```ts
export async function latestOptiScaler(deps: { fetchJson }): Promise<{ version: string; url: string; size: number;
  sha256: string | null; fileName: string } | null>
export async function ensureOptiScaler(release, cacheDir, deps: { download; extract7z }): Promise<string> // extracted dir
export async function pickExeDir(installDir: string, exePath?: string, io?): Promise<string | null>
export async function installOptiScaler(exeDir: string, packageDir: string, options: { gpuVendor: GpuInfo['vendor'];
  version: string }, io?): Promise<{ relDir; asName; version }>   // writes <exeDir>/.playout-optiscaler.json manifest
export async function findOptiScalerInstall(installDir: string, io?): Promise<OptiScalerState['installed']>
export async function removeOptiScaler(installDir: string, io?): Promise<void>
```

### scskiller.ts
```ts
export async function latestScsKiller(deps: { fetchJson }): Promise<{ version; zipUrl; sumsUrl; fileName } | null>
export async function ensureScsKiller(release, toolsDir, deps: { download; fetchText; extractZip; sha256 }): Promise<string> // cli exe path
export async function disableRecorder(stateDir?: string, io?): Promise<void>
export async function compileShaders(exe: string, target: { steamAppId?: string; installDir: string; title: string },
  onProgress: (p: { progress: number | null; message: string }) => void, signal: AbortSignal,
  deps: { spawn }): Promise<{ ok: boolean; message: string; unsupported?: boolean }>
```

### aio.ts
```ts
export async function latestAioSwapper(deps: { fetchJson }): Promise<{ version; url; size; sha256; fileName } | null>
export async function ensureAioSwapper(release, toolsDir, deps: { download }): Promise<string> // portable exe path
export async function openAioSwapper(exe: string, installDir: string | null, deps: { spawnDetached }): Promise<void>
```

### compress.ts
```ts
export function compactArgs(action: 'compress' | 'uncompress' | 'query', dir: string, algorithm?): string[]
export async function compressFolder(dir: string, algorithm: CompressAlgorithm, onProgress, signal, deps: { spawn })
  : Promise<{ ok: boolean; message: string }>
export async function uncompressFolder(dir: string, onProgress, signal, deps: { spawn }): Promise<{ ok; message }>
export async function measureFolder(dir: string, deps: { compressedSize(file): Promise<number>; ... })
  : Promise<{ size: number; onDisk: number; state: CompressState['state'] }>
export function parseCompactDatabase(json: string): Map<string, number>  // Steam appid -> estimated saving 0..1
export async function compressUnavailable(dir: string, deps): Promise<string | null> // not NTFS, protected
```

## Service (written last, by the main session): `src/main/upgrades/service.ts`
Per-game status (`UpgradeStatus`), one action at a time per game, refuses while the game runs, emits
`'upgrades:progress'`, keeps `Upgrades/` beside PlayOut.exe (installer keep list), stores per-game facts
(`compiledAt`, last DLL check) in `userData/upgrades.json`.

## Renderer (main session)
`ActionBar` sparkles button after the Play chain (PC game, installed, not remote) → `UpgradeMenu` popover (PlayMenu
style). Enabling actions on a game with `risk.tags` or `risk.antiCheat` first open a danger ConfirmDialog; compress
always confirms with the load-time warning.
