# Builder and fixer reports for the upgrade modules (read the "service must know" parts)

gpu + anticheat modules are done. Prettier and eslint are clean on all 4 files, vitest passes 57/57 across both test files, and `tsc --noEmit -p tsconfig.node.json` reports no errors in my files (it exits 2 because of errors in other files).

Files (new, nothing else touched):
- C:\Users\<user>\Downloads\PlayOut\src\main\upgrades\gpu.ts
- C:\Users\<user>\Downloads\PlayOut\src\main\upgrades\gpu.test.ts
- C:\Users\<user>\Downloads\PlayOut\src\main\upgrades\anticheat.ts
- C:\Users\<user>\Downloads\PlayOut\src\main\upgrades\anticheat.test.ts

## gpu.ts exports
- `export const VIDEO_CONTROLLER_SCRIPT: string`
  - A read-only PowerShell script. It prints `ConvertTo-Json -InputObject @(...) -Compress`, so the output is always an array, even with one adapter.
  - Each row has: Name, PNPDeviceID, DriverVersion, AdapterCompatibility, CurrentHorizontalResolution and ConfigManagerErrorCode from Win32_VideoController.
  - It also adds DedicatedVideoMemory as a string, taken from `HKLM:\SOFTWARE\Microsoft\DirectX\*` and matched by PCI VEN/DEV, which ignores stale cache keys.
  - LocationInfo comes from `Get-PnpDeviceProperty DEVPKEY_Device_LocationInfo`, inside try/catch.
- `export function parseVideoControllers(json: string): GpuInfo[]`
  - Accepts one object or an array. It also accepts a JSON string that holds the JSON, because the ps-worker `PsRunner.run` converts output to JSON again.
  - Skips: PNPDeviceID not starting with `PCI\`, vendor 1414 (Microsoft basic and virtual display adapters), and ConfigManagerErrorCode other than 0.
  - Vendor comes from VEN_ (10DE nvidia; 1002/1022 amd; 8086 intel), with a name or AdapterCompatibility fallback, otherwise 'other'.
  - NVIDIA only: `driver` is converted to 561.56 style and `rtxSeries` is filled in. Other vendors keep the raw DriverVersion.
  - Bad or empty input gives `[]`.
- `export function primaryGpu(gpus: GpuInfo[]): GpuInfo | null`
  - Ranking order:
    1. Dedicated first. NVIDIA always counts as dedicated. Otherwise DirectX DedicatedVideoMemory of 1 GiB or more counts; when that is unknown, name rules decide (AMD iGPU names such as "Radeon(TM) Graphics" or 780M; AMD RX or Radeon Pro W are dGPUs; Intel Arc A-series and B5x0 are dGPUs; B370/B390, Arc Graphics, UHD and Iris are iGPUs). An Intel adapter at "PCI bus 0, device 2" is treated as integrated.
    2. More dedicated memory.
    3. Vendor priority NVIDIA > AMD > Intel > other.
    4. The adapter driving a display, as the last tiebreak.
  - Returns null for an empty list.
- `export function nvidiaDriverVersion(windowsVersion: string): string | null`
  - "31.0.15.6156" gives "561.56". The 4th part is padded, so 31.0.15.560 gives 505.60.
  - Returns null for anything that is not 4 numeric parts.
- Extra export: `export function rtxSeriesOf(name: string): number | null`. It returns 20, 30, 40 or 50, else null. Handled cases: TITAN RTX and Quadro RTX give 20; RTX A#### gives 30; "Ada Generation" gives 40; "Blackwell" gives 50; GTX, MX and an unknown series such as 6090 give null.

## anticheat.ts exports
- `export interface FsIo { readdir(dir): Promise<Array<{ name: string; isDirectory: boolean; isLink: boolean }>> }`, plus `export const nodeFsIo: FsIo`, which uses `fs.readdir` withFileTypes and sets `isLink = isSymbolicLink()`.
  - A test with a real `'junction'` symlink confirms Node reports junctions as links, so they are not followed.
- `export function gameRiskTags(game: Pick<Game,'metadata'>): string[]`
  - Calls `riskTagsOf([...steamTags.tags, ...genres, ...tags])`. Missing fields are safe.
- `export async function findAntiCheat(installDir: string, io: FsIo = nodeFsIo): Promise<string[]>`
  - Walks breadth first, so the nearest entries come first. Paths are lowercased, use "/" and folders end in "/".
  - Never follows links. Does not descend into `WindowsApps`. Unreadable folders are skipped. A missing folder gives `[]`.
  - Returns each name once, in a fixed order.
- Extra exports:
  - `antiCheatOfPaths(paths: readonly string[]): string[]`, the pure matcher.
  - `ANTICHEAT_SCAN_DEPTH = 4`: folders are opened 4 levels below the game folder, so names up to 5 deep are listed.
  - `ANTICHEAT_SCAN_LIMIT = 20000`: the maximum number of entries looked at.

Names returned, with their signatures:
- **Easy Anti-Cheat**: an `easyanticheat/` folder, `EasyAntiCheat_(EOS_)Setup.exe`, `EasyAntiCheat(_x64).dll`, `eac_server64.dll`, or `start_protected_game.exe` in the game root only.
- **BattlEye**: a `battleye/` folder, `BEService(_x64).exe`, or `BEClient(_x64).dll`.
- **EA Javelin Anticheat**: `EAAntiCheat.Installer.exe`, or `EAAntiCheat.GameServiceLauncher.exe` / `.dll`.
- **Riot Vanguard**: `VALORANT.exe`, `VALORANT-Win64-Shipping.exe`, or `League of Legends.exe`. Vanguard itself is system-wide, so the game's files are the hint.
- **nProtect GameGuard**: `gameguard.des`, or `gameguard/gamemon(64).des`.
- **XIGNCODE3**: `*.xem` or `xhunter1.sys`.
- **PunkBuster**: `PnkBstrA.exe`, `pbsvc.exe`, `pbsv.dll`, a `punkbuster/` folder, or `pb/pbcl.dll` / `pb/pbag.dll`. A bare `pb/` folder is not flagged.
- **ACE**: an `anticheatexpert/` or `aceantibotclient/` folder.
- Also: Ricochet (`Randgrid.sys`), HoYoKProtect (`mhyprot*.sys`, `HoYoKProtect.sys`, `mhypbase.dll`), TenProtect, NetEase Anti-Cheat, EQU8, HackShield, BlackCipher, AnyBrain and Fredaikis Anti-Cheat.
- Tests cover near misses that must not match, for example `pb/readme.txt`, `sub/start_protected_game.exe`, `gameguard.desc` and `beservice.exe.bak`.

## Contract deviations and assumptions
- **Scan depth:** DESIGN.md says depth 8, the spec says about 6, and the task said 3–4. I used 4 levels opened (names up to 5 deep), because Delta Force's ACE folder sits at `Game/DeltaForce/Binaries/Win64/AntiCheatExpert` (5 deep). Adjust `ANTICHEAT_SCAN_DEPTH` if needed.
- **Denuvo Anti-Cheat** is never returned. It is built into the game's exe and leaves no file marker (SteamDB KNOWN_UNDETECTIONS), and its system-wide install can't be tied to one game. VAC and FACEIT are not detectable from the game folder either.
- **WindowsApps:** findAntiCheat only skips WindowsApps folders. Reporting "protected folder" is left to the service.
- **Memory hints:** primaryGpu reads dedicated memory, display state and PCI location from a module-level WeakMap filled by parseVideoControllers, so `GpuInfo` stays unchanged with no extra serialized fields. Pass the same objects from parseVideoControllers into primaryGpu (copies or IPC round-trips lose the hints and fall back to vendor and name rules).
- **Running the script:** VIDEO_CONTROLLER_SCRIPT can go through the ps-worker or `powershell.exe -NoProfile -Command`. Through the worker, `JSON.stringify` the result before passing it to parseVideoControllers; the double-encoded string is handled.
- **Speed:** `Get-PnpDeviceProperty` loads the PnpDevice module and can take about a second, so give the script a timeout above the 10 s default if the machine is slow.
- No change to src/shared/upgrades.ts was needed.

---

I implemented compress.ts and its test. Prettier, eslint and all 26 vitest tests pass, and `tsc --noEmit -p tsconfig.node.json` shows no errors in my files. I edited no other file and need no change to src/shared/upgrades.ts. compact.exe was never actually run: every test uses a fake spawn.

Files:
- C:\Users\<user>\Downloads\PlayOut\src\main\upgrades\compress.ts
- C:\Users\<user>\Downloads\PlayOut\src\main\upgrades\compress.test.ts

## The five contract functions
These keep their DESIGN.md signatures. Three have an extra optional parameter on the end, so the contract calls still work.

- `compactArgs(action: 'compress'|'uncompress'|'query', dir: string, algorithm?: CompressAlgorithm, force = false): string[]`
  - compress: `/C /S:dir /A /I /EXE:<ALG>`, plus `/F` when `force` is true. The default algorithm is XPRESS8K.
  - uncompress: `/U /S:dir /A /I /EXE`
  - query: `/Q /S:dir /A`
  - The trailing backslash is taken off the folder, except for a drive root.
- `compressFolder(dir, algorithm, onProgress, signal, deps: CompactDeps, options: { force?: boolean } = {}): Promise<{ ok: boolean; message: string }>` (`options` is the extra parameter)
- `uncompressFolder(dir, onProgress, signal, deps: CompactDeps): Promise<{ ok; message }>`
- `measureFolder(dir, deps: MeasureDeps): Promise<{ size; onDisk; state }>`
  - `MeasureDeps` is `{ compressedSize(file): Promise<number>; compressedAt?: number | null; io?: CompressIo }`.
- `parseCompactDatabase(json: string, algorithm?: CompressAlgorithm): Map<string, number>` (`algorithm` is the extra parameter)
- `compressUnavailable(dir, deps: UnavailableDeps): Promise<string | null>`
  - `UnavailableDeps` is `{ volumeInfo(dir): Promise<VolumeInfo | null>; windowsDir?: string; io?: CompressIo }`.

## Extra exports
- **Constants:** `COMPACT_EXE` (`C:\Windows\System32\compact.exe`), `DEFAULT_COMPRESS_ALGORITHM = 'xpress8k'`, `SKIPPED_EXTENSIONS` (the CompactGUI skip list), `MIN_COMPRESSIBLE_SIZE = 4096`.
- **Progress type:** `CompressProgress = (p: { progress: number | null; message: string }) => void`
- **Spawn dep:** `CompactSpawn = (file, args, { cwd, signal, onStdout(text: string) }) => Promise<{ code: number | null }>`
- **`CompactDeps`:** `{ spawn: CompactSpawn; compactExe?: string; io?: CompressIo; freeSpace?(dir): Promise<number | null> }`
- **File system:** `CompressIo { readdir(dir): Promise<Dirent[]>; stat(path) }` and `nodeCompressIo`.
- **Helpers:**
  - `compactFileBatches(action, files, algorithm?, force?, exe?): string[][]`
  - `listFolderFiles(dir, io?): Promise<FolderFile[]>`
  - `isCompressibleFile(relPath, size)`
  - `class CompactLineCounter { push(text): number; end(): number; count }`
  - `compressStateOf(counts: CompressCounts)`
- **PowerShell measuring, for big games:**
  - `measureFolderScript(dir, compressedAt?): string` measures the whole folder in one call with GetCompressedFileSizeW.
  - `parseFolderMeasure(value: unknown)` takes the parsed object or its JSON text and returns `{ size, onDisk, state } | null`.
- **PowerShell drive check:** `volumeInfoScript(dir): string` returns `{ fileSystem, network }` from `System.IO.DriveInfo`, and `parseVolumeInfo(value): VolumeInfo | null` reads it.

## How it behaves
- **No /S for compress or uncompress.** compressFolder and uncompressFolder first walk the folder in Node, then pass the files to compact.exe as paths relative to the game folder (the spawn `cwd`).
  - The walk never follows links or junctions (Dirent `isSymbolicLink`), includes hidden files, and skips unreadable folders.
  - The files are split into several compact.exe runs so each command line stays under 30,000 characters.
  - This is how the skip list works, and it also makes the progress total exact.
- **Compress skips** files of 4096 bytes or less, plus CompactGUI's non-compressible extensions (case-insensitive).
  - CompactGUI itself has the skip list off by default; I apply it always because the task asked for it.
  - Uncompress takes every file, including skipped types and tiny files.
- **Progress:**
  - First a "Counting the game's files…" message with null progress.
  - Then it counts per-file output lines: a non-blank line that does not start with a space and ends with `]`. No English words are matched, so it works in any Windows language.
  - Lines split across chunks are handled.
  - When a run ends, all its files count as done, so files compact.exe skipped without printing a line (already compressed) still bring the bar to 1.
- **Stopping:** the signal goes to the spawn dep, and no new run starts once it is aborted. The result is `{ ok: false, message: 'Compression was stopped.' }` (or 'Uncompressing was stopped.').
- **Failures:** a run that exits non-zero, or a spawn that throws, gives ok false with "Make sure the game is closed…". The other runs still go ahead, like /I does.
- **Free space:** when `deps.freeSpace` is given, compression refuses to start with less than twice the largest eligible file free.
- **When nothing qualifies:** no eligible files gives ok true and compact.exe is not run.
- **State (`compressStateOf`):**
  - 'none' when no file is smaller on disk than its size.
  - With `compressedAt`: 'partial' only when eligible, uncompressed files changed after that time (a game update). Files compact.exe tried but could not shrink then do not count.
  - Without it: 'partial' when some eligible files are not compressed, as the task literally says.
  - In measureFolder, a `compressedSize` call that fails or gives a bad number counts the file at its full size.
- **`parseCompactDatabase`:**
  - Reads the top-level array and maps `SteamID` to 1 − Σ(After/Before × TotalResults) / ΣTotalResults, clamped to 0..1.
  - Results with a zero Before, After or TotalResults are skipped; games with no valid results are left out.
  - Invalid JSON or any shape other than an array gives an empty map.
  - With `algorithm`, it uses only that CompType (0 XPRESS4K, 1 XPRESS8K, 2 XPRESS16K, 3 LZX).
- **`compressUnavailable` checks, in this order:**
  1. A WindowsApps path segment: protected folder.
  2. The folder is missing.
  3. A drive root.
  4. Inside `windowsDir` (default C:\Windows).
  5. A OneDrive segment ("OneDrive" or "OneDrive - …").
  6. A UNC path or `volume.network`.
  7. A file system other than NTFS.
  - If the drive cannot be read (null), compression is allowed.

## Where I did not follow DESIGN.md or the spec exactly
- **Walk limits:** the walk is capped at depth 32 and 1,000,000 files, not DESIGN.md's depth 8. Compression must reach every file, and games nest deeper than 8.
- **Checks left out of `compressUnavailable`:** the LZNT1-compressed folder check and the write-permission check. Neither can be done cleanly through the current deps; compact.exe failing gives the "not compressed" result.
- **Uncompress free-space check left out:** it needs the on-disk sizes first.
- **No live compact.exe test:** batching with explicit relative paths and `cwd` comes from compact's documented usage (`compact /C … "f1" "f2"`). I did not check it against the real compact.exe.

## What the service must do
1. Wire `spawn` with `runProcess`-style kill-on-abort that also streams stdout. The current `runProcess` only captures output at the end, so streaming must be added.
   - Decode stdout with the OEM code page (437 on en-US). Progress only counts lines, so a wrongly decoded name does no harm.
   - Spawn with no shell, `cwd` = the game folder, and kill compact.exe when the signal aborts.
2. Store `compressedAt` (ms since 1970) after each successful compressFolder and pass it to measureFolder / measureFolderScript. Without it, games with already-compressed .pak files will often show 'partial' after a full compression.
3. Run measureFolderScript and volumeInfoScript through ps-worker `run()`. Both scripts output a PSCustomObject (no ConvertTo-Json), and the Add-Type is guarded so the worker can run the script again.
   - Give the measuring script a long `timeoutMs`: big games take far longer than the 10 s default.
4. Switching algorithm on an already compressed game needs `options.force` (`/F`, which redoes every file). Re-compressing after a game update should be run without `force`, which is cheap.
5. A compressFolder message is "Compressed N files." The service should build the "41.2 GB → 30.8 GB" line from measureFolder.

---

I've implemented src/main/upgrades/dlls.ts and src/main/upgrades/dlls.test.ts. The test file has 23 tests and they pass. Prettier has been run, eslint is clean, and `tsc -p tsconfig.node.json` shows no errors in these two files. I made no network calls, ran no binaries and changed no other files. src/shared/upgrades.ts did not need changing.

**Exports** (all in C:\Users\<user>\Downloads\PlayOut\src\main\upgrades\dlls.ts)
- `DLL_FILE_NAMES: Record<UpscalerDllKind, string>`
- `BACKUP_SUFFIX = '.playout-original'` (extra)
- `interface DllIo { readdir(dir): Promise<Dirent[]>; readFile; exists; copyFile(from, to, exclusive?); rename; rm; mkdir }` and `nodeDllIo` (the real file system). This is the `io?` from the contract; I defined it here rather than importing anticheat's `FsIo`, because that file is being written at the same time.
- `scanUpscalerDlls(installDir, io = nodeDllIo): Promise<Array<FoundUpscalerDll & { path: string }>>`
- `readPeFileVersion(buf: Buffer): string | null`
- `compareVersions(a: string, b: string): number` (returns -1, 0 or 1; a leading `v` is ignored and missing parts count as 0)
- `fsrDisplayVersion(fileVersion): string | null` and `isNewerDll(kind, current, candidate): boolean` (both extra)
- `interface VendorDll` (exactly as in the contract)
- `latestVendorDlls(deps: { fetchJson: <T>(url: string) => Promise<T> }): Promise<Partial<Record<UpscalerDllKind, VendorDll>>>`
- `gitBlobSha1(bytes: Buffer): string` (extra)
- `ensureVendorDll(file, cacheDir, deps: { download(d: ResolvedDownload, dir: string): Promise<string>; verifySigner(path, expectedSigner, companyName?): Promise<boolean> }, io?): Promise<string>`
- `swapDlls(installDir, found: ReadonlyArray<FoundUpscalerDll>, files: Partial<Record<UpscalerDllKind, { path: string; version: string }>>, io?): Promise<{ replaced: string[]; skipped: { relPath; reason }[] }>`
- `restoreDlls(installDir, found, io?): Promise<{ restored: string[]; failed: { relPath; reason }[] }>`

**Behaviour and edge cases covered by the tests**
- **Scan:**
  - File names match in any letter case.
  - Junctions and symbolic links are never followed (tested with a real junction).
  - Folders named WindowsApps inside the game are skipped.
  - The scan stops 8 folders deep and after 200,000 folder entries.
  - A missing folder gives an empty list.
  - A file whose version can't be read gets `version: null`.
  - `swapped` is true when `<file>.playout-original` exists.
  - `relPath` comes from `path.relative`, and results are sorted by `relPath`.
- **Reading the file version:** it needs the MZ header. It looks for the fixed version block right after the UTF-16 "VS_VERSION_INFO" key, and falls back to a bare search for the signature BD 04 EF FE with the structure version set to 0x00010000. It returns major.minor.build.revision.
- **latestVendorDlls:**
  - NVIDIA: the latest release tag plus the folder listing for that tag; the version is the tag padded to four parts ("310.9.16.0").
  - Intel: the latest release tag plus the `bin` listing.
  - AMD: the `PrebuiltSignedDLL` listing at the fixed tag v1.1.4.
  - Each vendor fails on its own, so the others still come back.
  - A tag that isn't plain is rejected; NVIDIA tags must also look like a version.
  - A `download_url` outside `raw.githubusercontent.com/<that repo>/` is replaced with the URL built from the known pattern.
  - Blob SHAs are lower-cased, `sha256` is always null, and the signer is pinned per kind. XeLL's signer is "Microsoft Windows Hardware Compatibility Publisher".
- **ensureVendorDll:**
  - Only accepts `https://raw.githubusercontent.com/` URLs.
  - Downloads into `<cacheDir>/<kind>/<version>/download/`, then checks size, git blob SHA-1, SHA-256 if given, the MZ header and that the file version exactly matches `file.version`.
  - Then calls `verifySigner(path, file.signer, 'Intel Corporation' for XeLL only, otherwise undefined)`.
  - On success it moves the file to `<cacheDir>/<kind>/<version>/<fileName>`. A file that fails any check leaves nothing behind.
  - A file already in the cache is re-hashed and reused without a new download or signer check. If it fails the hash, it is deleted and downloaded again.
- **swapDlls:**
  - Only files of the same kind are touched.
  - Skipped, each with its reason:
    - a path containing `..` or outside the game folder
    - a path through WindowsApps ("the folder is protected")
    - a file whose version can't be read
    - an nvngx_dlss file older than 2.0 ("DLSS 1 games cannot use newer DLSS files")
    - a file that is not older ("it is already the newest version")
  - The backup is made with an exclusive copy only when none exists, so an existing backup is never overwritten. Then the new file is copied over the old one.
  - If the copy fails, a backup made in that same call is removed, so the file doesn't show as swapped.
  - EPERM/EACCES gives "the folder is protected", EBUSY gives "the file is in use (is the game running?)", and any other error gives its message. The remaining files still go ahead.
- **restoreDlls:** moves each existing backup back over its file. Failures are listed in `failed` with the same reasons.

**Where I went beyond the contract**
1. `restoreDlls` also returns `failed`. It is a superset of the contract's return type, so a caller expecting only `restored` still works.
2. `ensureVendorDll` takes an optional 4th `io` argument.
3. `swapDlls` compares versions with `isNewerDll`, not plain `compareVersions`. This was needed to never downgrade FSR: FSR 3.1 file versions don't increase in order (1.0.2.38022 is FSR 3.1.2, which is older than 1.0.1.41314, FSR 3.1.4). Known builds go through the table from the spec; unknown FSR builds compare by build number.

**What the service must know**
- **Use `isNewerDll` for `updatable`.** Compute it with `isNewerDll(kind, found.version, latest[kind].version)`, not `compareVersions`, or FSR will be wrong.
- **Intel and AMD versions come from a size table.** Their release tags are SDK versions and the API gives no file versions, so the version comes from a table keyed by file name and size, taken from the spec: libxess 2.0.2.68, libxess_dx11 2.0.2.68, libxess_fg 1.3.1.78, libxell 1.3.2.10, amd_fidelityfx_dx12 and _vk 1.0.1.41314.
  - A file whose size isn't in the table is left out of the result. So when Intel ships new files, they won't be offered until the table is updated.
  - In the current state of the repo, libxess_fg is listed for the test only; with real data all four Intel files match the table.
- **Wiring:**
  - `fetchJson` is a single-argument function; wrap the emulator setup's `fetchJson(url, httpDeps)`.
  - `download` matches `(d, dir) => downloadFile(d, dir, httpDeps)`.
  - `verifySigner` must check that Authenticode is valid and that the subject O=/CN= matches the signer. When a company name is given, it must also check the file's CompanyName.
- **Values to pass in:**
  - `swapDlls` takes the `found` list from `scanUpscalerDlls`, and `files[kind]` should be `{ path: <ensureVendorDll result>, version: vendor.version }`.
  - `found` items without `path` are fine; the path is rebuilt from `installDir` and `relPath`.
- **No AMD 2.x files.** The split DLLs (loader, upscaler, frame generation) aren't covered, because they aren't kinds in the shared type.
- **Cost:** a full check is 5 GitHub API calls (2 NVIDIA, 2 Intel, 1 AMD). The service should cache the result, at most one check a day.
- **Stale backups:** if a game update rewrites a swapped file, the old `.playout-original` stays, and Restore will put that older original back.

---

OptiScaler module is done: `src/main/upgrades/optiscaler.ts` and its test. All 22 tests pass, Prettier was run, eslint is clean, and `npx tsc --noEmit -p tsconfig.node.json` reports no errors in either file. No other files were edited, and `src/shared/upgrades.ts` needed no change.

Files:
- C:\Users\<user>\Downloads\PlayOut\src\main\upgrades\optiscaler.ts
- C:\Users\<user>\Downloads\PlayOut\src\main\upgrades\optiscaler.test.ts

## Contract exports (signatures)
- `latestOptiScaler(deps: { fetchJson: (url: string) => Promise<unknown> }): Promise<OptiScalerRelease | null>`
- `ensureOptiScaler(release: OptiScalerRelease, cacheDir: string, deps: { download(file: { url; fileName; size; sha256 }, dir: string): Promise<string>; extract7z(archive: string, destDir: string): Promise<void> }): Promise<string>` — returns the extracted folder.
- `pickExeDir(installDir: string, exePath?: string, io?: OptiScalerIo): Promise<string | null>`
- `installOptiScaler(exeDir: string, packageDir: string, options: { gpuVendor: GpuInfo['vendor']; version: string; installDir?: string }, io?: OptiScalerIo): Promise<{ relDir: string; asName: string; version: string }>`
- `findOptiScalerInstall(installDir: string, io?: OptiScalerIo): Promise<OptiScalerState['installed']>`
- `removeOptiScaler(installDir: string, io?: OptiScalerIo): Promise<void>`

## Extra exports
- **Types:** `OptiScalerRelease` (`{ version, url, size, sha256: string | null, fileName }`), `OptiScalerManifest`, and `OptiScalerIo` (readdir with an `isLink` flag, stat, readFile, writeFile, copyFile with no overwrite, rename, unlink, removeTree, mkdir, rmdirIfEmpty).
- **Real file operations:** `nodeOptiScalerIo`.
- **Constants:** `OPTISCALER_RELEASE_API`, `OPTISCALER_MANIFEST` (`.playout-optiscaler.json`), `BACKUP_SUFFIX` (`.playout-original`), `PROXY_NAMES`.
- **Helpers:**
  - `readOriginalFilename(buf)` reads the OriginalFilename from a dll's version information.
  - `setIniValue(text, section, key, value)` edits an ini value in place, keeping comments and line endings.
  - `iniEditsFor(vendor)` lists the ini settings for a graphics card maker.
  - `isProtectedPath(path)` detects WindowsApps folders.

## Behaviour and edge cases (tested)
- **`latestOptiScaler`**
  - Reads GitHub's latest-release answer and takes the first asset matching `/^Optiscaler_.*\.7z$/i`.
  - The download address must start with `https://github.com/optiscaler/OptiScaler/releases/download/`.
  - The sha256 comes from the asset's `digest` (`sha256:...`), otherwise null.
  - Returns null for nightly, draft or prerelease releases, a missing archive, a foreign host or a malformed answer. Network errors are thrown, not turned into null.
- **`ensureOptiScaler`**
  - Refuses any address outside OptiScaler's own GitHub releases.
  - Downloads into `cacheDir`, extracts into `<cacheDir>/OptiScaler-<version>.part`, and unwraps a single wrapping folder if there is one.
  - Refuses a source-code download (`OptiScaler.sln`) and a release without `OptiScaler.dll` or `OptiScaler.ini`.
  - Writes a `.playout-complete` marker, moves the folder to `<cacheDir>/OptiScaler-<version>`, and reuses it next time with no new download.
  - Always deletes the archive and the staging folder, and deletes older `OptiScaler-*` cache folders.
  - It uses the real file system directly for the cache (not the `io` object).
- **`pickExeDir`**
  - Scans breadth first, never follows links or junctions, caps depth at 8 and the number of entries, and skips WindowsApps.
  - It skips installer and redistributable folders (the list from coop/exe.ts) and every `Engine` folder.
  - First choice is an Unreal `-(Win64|WinGDK)-Shipping.exe`, ranked Win64 before WinGDK, then under `Binaries`, then the shallowest.
  - Next is the folder of `exePath`, if it exists and is not a launcher, crash reporter, installer or similar.
  - Last is the largest such exe within depth 3.
  - Returns null when nothing is found or the install folder is under WindowsApps.
- **`installOptiScaler`**
  - **Refusals:**
    - The folder is under WindowsApps ("protected folder").
    - The folder does not exist.
    - The package has `OptiScaler.sln` or lacks `OptiScaler.dll`.
    - OptiScaler was installed by hand: `OptiScaler.ini`, `OptiScaler.asi`, either Remove bat, or any proxy-name dll whose OriginalFilename is `OptiScaler.dll`.
    - Every proxy name is taken.
  - **Earlier PlayOut install:** if PlayOut's manifest is already in the folder, that install is undone first, so installing again works as an update.
  - **Proxy name:** `dxgi.dll` by default. If it exists (another mod's file, never overwritten), the next free name in the order `winmm.dll, version.dll, dbghelp.dll, d3d12.dll, wininet.dll, winhttp.dll`. `OptiScaler.asi` is never used.
  - **Files copied:** every release file except `setup_windows.bat`, `setup_linux.sh` and the README txt. `OptiScaler.dll` is copied under the proxy name; the ini keeps its name.
  - **Game files the release would replace** (for example the game's own `libxess.dll` or `amd_fidelityfx_*.dll`) are renamed to `<file>.playout-original` and then overwritten.
    - If that backup name is already used (for example by the DLL-update upgrade), the game's file is left alone and listed under `kept`.
  - **GPU handling:**
    - NVIDIA: `fakenvapi.dll`, `fakenvapi.ini` and `dlssg_to_fsr3_amd_is_better.dll` are not copied, and the ini is untouched.
    - AMD: `[Upscalers] Dx12Upscaler=fsr31`, `Dx11Upscaler=fsr31_12`, `VulkanUpscaler=fsr31_12`.
    - Intel: `Dx12Upscaler=xess`.
    - AMD, Intel and `other` get those three extra files.
  - **Manifest:** written before any change and lists `added`, `replaced`, `kept`, `dirs` and `runtime`. `runtime` holds `OptiScaler.log`, `fakenvapi.log`, `dlssg_to_fsr3.log` and `DlssOverrides`, but only when absent before install.
  - **Failure part way:** the folder is put back exactly and the error is rethrown.
- **`findOptiScalerInstall`** finds the shallowest valid manifest under the install folder (same bounded scan) and returns `{ relDir, asName, version }`, with `relDir` `''` for the install folder itself.
- **`removeOptiScaler`**
  - **Steps for every manifest found:**
    - Deletes the files PlayOut added.
    - Puts back each replaced file from its backup, only when the backup exists, so a half-done install never deletes a game original.
    - Deletes the runtime logs and `DlssOverrides`.
    - Deletes created folders when they are empty, then the manifest.
  - Manifest paths are checked first: no `..` and no absolute paths.
  - Does nothing when PlayOut did not install OptiScaler.
  - Tests confirm the folder comes back byte for byte after install then remove, after an update, with a taken `dxgi.dll`, with a taken backup name, and after a failed install.

## Differences from the contract and spec
1. **Optional `installDir` option.** `installOptiScaler` accepts an optional `options.installDir` (a superset of the contract's options) so it can return `relDir` relative to the game's install folder. Without it, `relDir` is `''`. The service should pass `installDir`, or call `findOptiScalerInstall` afterwards.
2. **No explicit spoofing edit.** The spec says to leave `[Spoofing] Dxgi=auto`, which already turns spoofing on for AMD and Intel and off for NVIDIA. So the AMD/Intel ini changes are the upscaler keys plus the extra files, not a written `Dxgi=true`.
3. **Optional extras not done.**
   - **OptiPatcher download** (`plugins/OptiPatcher.asi` plus `LoadAsiPlugins=true`) needs network access, and the install signature has no download dependency.
   - **Windows 10 `FsrAgilitySDKUpgrade`.**
   - **Moving another mod's dll into `plugins/`.** Not done, to honour "never touch another mod's file".

## What the service needs to know
- **Wiring:**
  - `deps.download` should be `downloadFile({ url, fileName, size, sha256 }, dir, httpDeps)`, which checks the size and sha256.
  - `deps.extract7z` should be `extractArchive(file, dest, { sevenZip: ensureSevenZip, run, log })`, because the release is a solid 7z.
  - `fetchJson` should send the User-Agent header.
- **Error handling:** `latestOptiScaler` throws on network errors, so the service must catch them.
- **Cache location:** `cacheDir` should be a folder under `Upgrades/`. `ensureOptiScaler` deletes any other `OptiScaler-*` folders inside it.
- **Hand installs:** `installOptiScaler` throws a user-readable message for an OptiScaler installed by hand ("…installed in this game by hand (dxgi.dll). Remove it first."). `removeOptiScaler` never touches such an install.
- **Shared backup name with dlls.ts:** both use `<file>.playout-original`. If DLL update runs before OptiScaler on the same file, OptiScaler keeps the swapped file and records it under `kept`. If OptiScaler runs first, dlls.ts will see an existing backup. Its "never overwrite an existing backup" rule should then skip that file.
- **Unreal check:** `pickExeDir` does not run the bat's "Engine folder" warning, because the `Engine` folder is excluded from the search.


---

## Report: scskiller + aio upgrade modules

Both modules are done, each with a test file. Prettier and eslint are clean. vitest passes 36 of 36. `tsc --noEmit -p tsconfig.node.json` reports nothing for these files. No other file was edited.

Files:
- C:\Users\<user>\Downloads\PlayOut\src\main\upgrades\scskiller.ts
- C:\Users\<user>\Downloads\PlayOut\src\main\upgrades\scskiller.test.ts
- C:\Users\<user>\Downloads\PlayOut\src\main\upgrades\aio.ts
- C:\Users\<user>\Downloads\PlayOut\src\main\upgrades\aio.test.ts

### scskiller.ts exports

```ts
interface ScsKillerRelease { version: string; zipUrl: string; sumsUrl: string | null; fileName: string; size: number | null; sha256: string | null }
latestScsKiller(deps: { fetchJson(url): Promise<unknown> }): Promise<ScsKillerRelease | null>
ensureScsKiller(release, toolsDir, deps: { download(d: ResolvedDownload, dir): Promise<string>; fetchText(url): Promise<string>; extractZip(zip, destDir): Promise<void>; sha256(file): Promise<string> }): Promise<string>   // cli exe path
disableRecorder(stateDir = %LOCALAPPDATA%\SCSKiller, io?: RecorderSettingsIo): Promise<void>
compileShaders(exe, target: ShaderTarget, onProgress, signal, deps: { spawn: SpawnTool }): Promise<ShaderResult>   // never rejects
type SpawnTool = (file, args, { cwd, onLine(line, stream: 'stdout'|'stderr') }) => ToolProcess
interface ToolProcess { exited: Promise<number | null>; killTree(): void }
spawnTool: SpawnTool   // real one: no shell, hidden window, taskkill /T /F
```

Helpers, also exported:
- `checksumFor`, `scsKillerExe(root)`, `scsKillerDataDir(exe)`
- `lineSplitter`
- `parseCompileLine`, `compileProgress`, `compileMessage`
- `parseGpuProfile`, `parseGameStatus`, `parseGameRows`
- the constant `SCSKILLER_FOLDER = 'SCSKiller'`

**Release lookup and download:**
- `latestScsKiller` reads `BlueHeisenberg/SCSKiller` releases/latest and picks `^SCSKiller-[\d.]+-Portable\.zip$`. Its SHA-256 comes from the asset digest, or failing that from the checksum list at the end of the release notes.
- It returns null when there is no portable zip or the URL is outside `github.com/BlueHeisenberg/SCSKiller/releases/download/`.
- **Checksum source:** the spec says SHA256SUMS-unsigned.txt does not list the Portable zip. It only lists SCSKiller.zip, which must not be used: that build refuses to run.
  - `ensureScsKiller` still fetches the sums file and uses its line when the file lists the zip; otherwise it uses the GitHub checksum.
  - If both exist and differ, it throws. If neither exists, nothing is downloaded.
  - The hash goes to `download` (so `downloadFile` checks it) and is checked again with `deps.sha256`.
- **Unpacking:** it unzips to `<toolsDir>\SCSKiller.new` and keeps the released layout (`.portable`, `current\cli`, `current\native`). It refuses a zip without `current\cli\scskiller.exe` and `current\native`.
  - The old `data\` folder (settings, scan caches, per-game records) moves into the new copy.
  - Then it swaps the folder in and writes a `.playout-version` marker.
  - The same version already in place means no download. Staging folders are always cleaned up.

**Recorder switch:**
- `disableRecorder` edits `settings.json` in place: `RecordAllGames=false`, `WelcomeSeen=true`. All other fields are kept, a BOM is tolerated, and an already-correct file is not rewritten.
- A missing or malformed file is left alone. The command line never installs recorders by itself, and per the spec a whole settings file must not be written with guessed fields.

**compileShaders flow:**
1. `scan`. If the GPU profile is `unsupported`, it returns `unsupported: true`.
2. `disableRecorder(scsKillerDataDir(exe))` (`<root>\data`). This runs after the scan because the scan creates `settings.json` on a first run.
3. Pick the game's id:
   - Steam: `steam:<appid>`.
   - Other games: `add <exePath> <installDir>`, reading "added:/already listed: <id>". This uses an optional `target.exePath`, which I added.
   - Otherwise: scanned rows with the same name (punctuation and ™/® removed), confirmed by `status <id>`'s `install` line matching `installDir`.
   - No id: `{ ok: false, unsupported: true, message: "SCSKiller doesn't list this game" }`.
4. `status <id>`:
   - `Warmed`: ok, "already precompiled".
   - `Unsupported` or `NeedsRecording`: `unsupported: true` with SCSKiller's reason.
   - `NeedsSteamStart` or `NeedsOfflineSession`: `ok: false` with the reason, not marked unsupported.
   - `Ready`, `Stale` or unknown: compile.
5. `compile <id>` streamed:
   - Progress lines are parsed into plain-English messages.
   - The overall bar is weighted by stage and never goes backwards: Indexing 0–5%, Planning 5–15%, Materializing 15–25%, Warming 25–95%, then Merging, Saving, Finishing, Done = 1.
   - Lines that are not progress lines are ignored; "nothing to compile" gives ok.
   - Exit 0 gives ok with "Precompiled N shaders (F failed)".
   - A non-zero exit gives the last `error:` line or the Failed note. Texts like not supported, 32-bit, can't reach, no game matches or encrypted are mapped to `unsupported: true`.
   - Stopped with no error gives "was the game started?".
6. **Cancelling:** aborting `signal` calls `killTree()` on whichever command is running and returns `{ ok: false, message: 'Cancelled' }`. Nothing is started if the signal is already aborted.

### aio.ts exports

```ts
interface AioRelease { version: string; url: string; size: number | null; sha256: string | null; fileName: string }
latestAioSwapper(deps: { fetchJson }): Promise<AioRelease | null>
ensureAioSwapper(release, toolsDir, deps: { download(d: ResolvedDownload, dir): Promise<string> }): Promise<string>
openAioSwapper(exe, installDir: string | null, deps: { spawnDetached: SpawnDetached; isAppRunning?(): Promise<boolean>; libraryFile?: string }): Promise<void>
type SpawnDetached = (file, args, { cwd }) => void
spawnDetached   // real one: detached, stdio ignore, unref
```

Helpers, also exported: `addToAioLibrary(libraryFile, gameDir): Promise<boolean>`, `aioLibraryFile(appData?)`, `AIO_FOLDER`.

**Release lookup and download:**
- `latestAioSwapper` picks `^DLSS-AiO-Swapper-[\d.]+-portable\.exe$` with `sha256` taken from the asset digest. It returns null for URLs outside the project.
- `ensureAioSwapper` saves the versioned file under `<toolsDir>\DLSS-AiO-Swapper\` and reuses it when it already exists.
- It refuses when there is no digest (no sums-file fallback), when the URL is outside the project, or when the file name is unexpected. The hash is passed to `download`.
- Afterwards it removes older `*-portable.exe` copies as best it can; a running copy is locked and stays.

**Opening the app:**
- The spec says the app ignores every command-line argument; it holds a single-instance lock, and a second start just raises its window. So `openAioSwapper` always starts it with no arguments, with cwd set to the exe's folder.
- To focus a game, it does what the spec suggests: it adds `installDir` to `%APPDATA%\dlss5-swapper\library.json` under "manual".
  - The file is created with the app's default shape if missing. Duplicates (case-insensitive) are skipped, and Steam `steamapps\common` folders are skipped because the app finds those itself. A malformed file is left alone.
  - This only happens when `deps.isAppRunning` is given and returns false. The app overwrites outside edits while it runs.
- It throws "DLSS AiO Swapper is not downloaded" when the exe is missing.

### Where the contract was extended (all additions are optional)
- `ScsKillerRelease` has extra `size` and `sha256` fields, and `sumsUrl` can be null.
- `compileShaders` targets accept an optional `exePath`.
- `openAioSwapper` deps accept optional `isAppRunning` and `libraryFile`.
- `src/shared/upgrades.ts` is unchanged.

### Things the service must know
- **SCSKiller layout:** the exe is `<toolsDir>\SCSKiller\current\cli\scskiller.exe`, and its data lives in `<toolsDir>\SCSKiller\data`. The spec suggests `Tools\`, but `toolsDir` should be under `Upgrades\` beside PlayOut.exe so the installer keep list protects it.
- **Wiring the deps:**
  - `download = (d, dir) => downloadFile(d, dir, httpDeps)`
  - `extractZip` = `extractArchive` into `destDir`
  - `sha256` = a file hash
  - `spawn = spawnTool`; `spawnDetached` = the exported one
  - `isAppRunning` = a process-list check for the AiO exe
- **Cancelling kills the compile outright** (taskkill /T /F). The compile already in progress is lost; SCSKiller has no other way to stop from Node apart from its `queue` stdin mode.
- **Game must not run during a compile:** SCSKiller stops the compile when the game's exe starts. The service already refuses actions while the game runs.
- **Long jobs:** a compile can take from minutes to over an hour. Nothing in `compileShaders` times out.
- **ShaderState.unavailable:** set it from `unsupported: true` results. The GPU check is only known after a `scan`; Intel shows as profile `unsupported` unless ExperimentalIntel is on.
- **Steam games and AiO:** for Steam games the service can pass `installDir = null` to `openAioSwapper`, though Steam paths are skipped anyway.

---

I fixed all four findings in gpu.ts and anticheat.ts and rejected none. Each one was real when I checked the code. Prettier and eslint are clean on my four files, vitest passes 64/64 for gpu.test.ts and anticheat.test.ts, and tsc shows no errors in my files. I edited only my own four files.

## gpu.ts (C:\Users\<user>\Downloads\PlayOut\src\main\upgrades\gpu.ts)
Exports are unchanged: `parseVideoControllers(json: string): GpuInfo[]`, `primaryGpu(gpus: GpuInfo[]): GpuInfo | null`, `VIDEO_CONTROLLER_SCRIPT`, `nvidiaDriverVersion(windowsVersion: string): string | null`, `rtxSeriesOf(name: string): number | null`.

- **Finding 1 (APU with a large UMA beat the real dGPU, medium): fixed.** `isDedicated` is replaced by an internal `dedicatedTier` that returns 2, 1 or 0. The ranking key is now [tier, memory, vendor rank, display].
  - **Tier 2:** NVIDIA, and AMD or Intel cards known by name: Radeon RX <digits>, RX Vega, Radeon VII, Radeon Pro W, Arc A-series, B5x0.
  - **Tier 1:** an AMD or Intel name the rules do not know, with 1 GB or more of dedicated memory.
  - **Tier 0:** built-in graphics. The name rules for built-in graphics now run before memory: "AMD Radeon(TM) Graphics", Radeon \d{3}M, \d{4}S and Vega N, Intel UHD, Iris, HD Graphics, Arc Graphics, \d{3}V and B3x0, plus the Intel built-in slot. These veto dedicated status whatever memory the BIOS reports.
  - **Tests added:** a 780M at 8 GB with an RTX 4050 at 6 GB, and with the NVIDIA's DirectX row missing (both pick NVIDIA). Also an 8060S, a UHD 770 at 16 GB, and an unknown AMD name that wins over Intel by memory but loses to a GTX 1650.
- **Finding 4 (WeakMap hints are lost on copies, low): fixed by documenting, not by changing the API.** The `primaryGpu` doc comment now says it must receive the exact array `parseVideoControllers` returned. A copy made by JSON, structuredClone, IPC or `{...gpu}` keeps vendor and name but loses memory, display and slot.
  - I also made copies degrade less badly: Radeon VII and RX Vega are now recognised by name.
  - **Tests added:** copied lists still rank Vega 64 and Radeon VII as dedicated, and a further test shows what a copy loses (the memory tie-break).
  - Returning the ranking data instead would mean extra fields on `GpuInfo` or a contract change, so I did not.

## anticheat.ts (C:\Users\<user>\Downloads\PlayOut\src\main\upgrades\anticheat.ts)
The contract signature is kept: `findAntiCheat(installDir: string, io?: FsIo): Promise<string[]>`. New exports:
- `type AntiCheatScanFailure = 'protected' | 'unreadable' | 'incomplete'`
- `class AntiCheatScanError extends Error { readonly reason: AntiCheatScanFailure }` (its `name` is 'AntiCheatScanError')
- `interface AntiCheatScan { names: string[]; complete: boolean }`
- `scanAntiCheat(installDir: string, io?: FsIo): Promise<AntiCheatScan>`

`ANTICHEAT_SCAN_LIMIT` (20000) now counts folders opened, not entries.

- **Finding 2 (WindowsApps or unreadable folder reported as no anti-cheat, medium): fixed.**
  - An installDir with a `\WindowsApps\` or `/windowsapps/` path segment (any case) throws `AntiCheatScanError('protected')` before anything is read.
  - If the game folder itself cannot be listed, it throws 'unreadable'. A missing folder (ENOENT or ENOTDIR) still returns [], as the comment says.
  - An unreadable subfolder or a child folder named WindowsApps is still skipped, but the scan is then marked `complete: false`.
  - **Tests added** for both cases. A folder name that merely contains "WindowsApps", such as `MyWindowsAppsGame`, is still scanned normally.
- **Finding 3 (shared budget used up silently, low): fixed.**
  - Each file name is tested against the rules as it is read and is not stored. Files no longer count toward the budget; only folders opened do.
  - The scan stops early once every rule has matched.
  - If the folder limit is reached or a subfolder is passed over, `complete` is false.
  - `findAntiCheat` throws `AntiCheatScanError('incomplete')` when the scan was incomplete and found nothing. If something was found, it returns the names.
  - **Tests added:** a 20001-file Content folder sitting before DeltaForce/Binaries/Win64/AntiCheatExpert (ACE is found and the scan is complete), and a folder-limit test (exactly 20000 folders opened, then 'incomplete' is thrown).
  - The old "stops at the entry limit" test was rewritten to match the new behaviour.

## What the service must know
- `findAntiCheat` can now throw `AntiCheatScanError`. Catch it and treat it as "anti-cheat unknown": show a 'protected folder' risk note or block, and show the danger ConfirmDialog.
  - `reason === 'protected'`: a WindowsApps folder.
  - `'unreadable'`: the game folder could not be listed.
  - `'incomplete'`: the scan was cut short and found nothing.
- An empty list now always means the folder was checked and nothing was found, or the folder is missing.
- Use `scanAntiCheat` if the service wants found names together with the completeness flag.
- Call `primaryGpu` with the exact array `parseVideoControllers` returned. Do not cache it through JSON or send it over IPC before ranking.
- I did not change shared/upgrades.ts and did not need to.

---

All 6 review findings for compress were real and are fixed. Only my own files changed: C:\Users\<user>\Downloads\PlayOut\src\main\upgrades\compress.ts and C:\Users\<user>\Downloads\PlayOut\src\main\upgrades\compress.test.ts. Prettier and eslint are clean on both. vitest passes all 34 tests (it was 26, so 8 are new). `tsc -p tsconfig.node.json` shows no errors in these files. I also ran measureFolderScript and volumeInfoScript once each through the system powershell.exe on a temp folder. Both ran, and the measure script found 1 file, not 2: a file 32 folder levels down was counted and one 33 levels down was not. That check file was deleted afterwards.

## Fixes

1. **Uncompress free-space guard (medium).**
   - `CompactDeps` has a new optional `compressedSize?: (file) => Promise<number>`.
   - New signature: `uncompressFolder(dir, onProgress, signal, deps, options: { onDisk?: number | null } = {})`.
   - When `deps.freeSpace` is given, it refuses if free space < (total size − bytes on disk) + the largest file. The message is: "There is not enough free space on the drive to uncompress this game. Free up some space, then try again."
   - Bytes on disk come from `deps.compressedSize` (16 files measured at a time; a file it fails on counts at its full size). Without it they come from `options.onDisk`, the last measured total. With neither, only the largest file is required.
   - Tests cover all three paths and both sides of the limit.

2. **Algorithm switch did nothing but reported success (medium).**
   - New signature: `compressFolder(dir, algorithm, onProgress, signal, deps, options: { force?: boolean; previousAlgorithm?: CompressAlgorithm | null } = {})`.
   - `/F` is added automatically when `previousAlgorithm` is given and differs from `algorithm`, or when `force` is set.
   - The result message now counts the files compact.exe actually printed a line for:
     - "Compressed N files."
     - "Compressed N files; the others were already compressed."
     - "The game's files were already compressed, so nothing changed."
   - Tests cover /F on and off, and the wording for none and some skipped.

3. **The walk ignored Stop (low).**
   - New signature: `listFolderFiles(dir, io?, signal?)`.
   - A shared stop check runs before every directory read and every entry. Both an abort and the MAX_FILES cap now end the whole walk, not just one directory level.
   - compressFolder and uncompressFolder pass their signal in. A test aborts during listing and checks that no further directories are read and compact.exe never runs.

4. **Depth limits differed between the two walks (low).** measureFolderScript now walks (folder, depth) pairs and skips folders deeper than MAX_DEPTH (32). This matches the Node walk, which reads folders up to 32 levels deep. When the MAX_FILES cap is reached it now ends the walk; before, it kept reading folders. Tests check the Node walk takes the 32-level file and leaves the 33-level one, and check the script text. The real PowerShell run confirmed the same.

5. **NTFS (LZNT1) folders were not refused (low).**
   - `VolumeInfo` has a new optional `folderCompressed?: boolean`.
   - volumeInfoScript now reads the folder's Compressed attribute in the same PowerShell call and returns `{ fileSystem, network, folderCompressed }`. parseVolumeInfo reads it, defaulting to false.
   - compressUnavailable refuses with a message that the folder is already compressed by NTFS and the setting must be turned off in its properties.
   - measureFolderScript no longer counts LZNT1 files as compressed; their bytes still count in onDisk.
   - The Node `measureFolder` cannot see file attributes, so it still counts LZNT1 files as compressed. It is only accurate for folders compressUnavailable allowed.

6. **Long-path prefix reported as a network drive (low).**
   - compressUnavailable now removes the prefix first: `\\?\D:\…` and `\\.\D:\…` become `D:\…`, and `\\?\UNC\srv\share` becomes `\\srv\share`. Only a real UNC path is treated as a network drive.
   - Fixing this exposed an older bug: `isInside` reported any UNC path as "inside Windows". It now uses `path.isAbsolute`, so UNC paths correctly get the network message.
   - Tests cover the local long path, a long-path drive root, and both UNC forms.

## What the service must know
- Pass `previousAlgorithm` (the last algorithm PlayOut compressed the game with) to compressFolder, so a change of algorithm is applied.
- Pass `freeSpace` plus either `compressedSize` or `options.onDisk` to uncompressFolder.
- Feed volumeInfoScript's output, unchanged, to compressUnavailable's `volumeInfo` dep. Because it starts with a `try` statement, it cannot be piped to ConvertTo-Json directly; wrap it as `& { … }` first if the PowerShell worker pipes scripts.
- The two new trailing options parameters only extend the DESIGN.md signatures; calls written to the contract still work. src/shared/upgrades.ts is unchanged.

---

I fixed all six OptiScaler review findings. All of them were real when I checked the code, so I rejected none. I changed only src/main/upgrades/optiscaler.ts and src/main/upgrades/optiscaler.test.ts. Prettier is applied, eslint is clean, `npx vitest run src/main/upgrades/optiscaler.test.ts` passes 34 of 34, and `tsc -p tsconfig.node.json` shows no errors in these files. Nothing else in src calls these functions yet, so the signature changes break nothing.

**Exports changed or added** (everything else is as before):
- `ensureOptiScaler(release, cacheDir, deps: EnsureOptiScalerDeps, options: { allowUnverified?: boolean } = {}): Promise<string>`. It no longer uses `async` but still returns a Promise.
- `interface EnsureOptiScalerDeps { download; extract7z; verifySigner?: (path, expectedSigner, companyName?) => Promise<boolean> }`. `verifySigner` has the same shape as `verifySigner` in dlls.ts.
- `releaseDllSigner(name): { signer; companyName? } | null`
- `isInsideDir(parent, child): boolean`
- `carryIniValues(newText, oldText, except?: { section; key }[]): string`
- `removeOptiScaler(installDir, io?): Promise<string[]>`. It used to return `Promise<void>`. It now returns the files it left in place because they changed since PlayOut wrote them, relative to installDir with forward slashes. Code that ignores the result still works.
- `OptiScalerIo` has a new required method `sha256(path): Promise<string>`. The real `nodeOptiScalerIo` streams the file to hash it.
- `OptiScalerManifest` has a new field `files: Record<rel, { size; sha256 }>`. Manifests written before this change read back with `{}`.

**Fixes, one per finding:**
1. **Folder outside the game.** `pickExeDir` now uses `exePath` only when it is inside `installDir`. The check uses `path.relative`, ignores letter case on Windows, and also catches a sibling folder like `Game2`. `installOptiScaler` throws "OptiScaler can only be installed inside the game's folder" when `options.installDir` is given and `exeDir` is outside it.
2. **Archive with no hash; vendor DLLs not checked.**
   - `ensureOptiScaler` refuses a release with `sha256: null` ("GitHub gives no checksum…") unless `options.allowUnverified` is set. It refuses before downloading.
   - When `deps.verifySigner` is given, every `amd_fidelityfx_*.dll`, `libxess*.dll` and `libxell.dll` at the top of the extracted folder is checked before the release is marked complete.
   - The pinned signers are the same strings dlls.ts uses: 'Advanced Micro Devices, Inc.', 'Intel Corporation', and for libxell 'Microsoft Windows Hardware Compatibility Publisher' with company name 'Intel Corporation'.
   - A failed check throws and leaves nothing in the cache.
3. **Update removed the old install first and reset the ini.**
   - An update now moves the old install's files into `<exeDir>/.playout-optiscaler-previous` and puts back the game files it had replaced. It keeps the user's OptiScaler.ini text and the old manifest bytes in memory.
   - It then runs the checks and copies. If anything fails, the new partial install is undone, the old files are moved back, and the old manifest is rewritten.
   - On success, the user's values are carried into the new release's ini by `carryIniValues`, only for keys the new ini still has. The AMD / Intel ini edits are applied again only when there was no old ini or the graphics card maker changed. When the maker changed, the old maker's edit keys are not carried over.
   - The old install's folders and log files stay listed in the new manifest. The holding folder is listed under `runtime`, so if the app crashes mid-update, a later Remove deletes it.
4. **Remove restored stale backups.**
   - The manifest records the size and sha256 of every file PlayOut wrote. When removing, a file that no longer matches is left in place and returned.
   - For a replaced file, the out-of-date `.playout-original` backup is then deleted.
   - OptiScaler.ini and fakenvapi.ini are always treated as PlayOut's files, because OptiScaler rewrites them itself.
   - An update treats a file the game changed since as the game's file, so it gets backed up again.
5. **Old nvngx.dll / nvapi64.dll install not detected.** The install also checks nvngx.dll and nvapi64.dll and refuses with the "installed by hand" message when either has OriginalFilename OptiScaler.dll.
6. **Cache cleanup during another install.**
   - `ensureOptiScaler` calls run one at a time through a module-level promise chain, across all games.
   - `installOptiScaler` marks its package folder as in use while it runs (a module-level count), and cleanup skips folders in use.
   - Leftover `.part` folders are still deleted, which is safe now that only one cache job runs at a time.

**Tests added:** exePath outside the game (including a sibling folder and different letter case), install refused outside installDir, nvngx.dll / nvapi64.dll by hand, `carryIniValues`, ini settings kept across an update, previous version kept when an update fails at a copy and when it fails at a check, files a game patch changed left alone on removal, an update backing up a game-patched file, no-checksum refusal and allowUnverified, signer pinning and a signer failure, two concurrent ensures downloading once, and a package folder in use surviving cleanup.

**What the service must do:**
- Pass a real `verifySigner` to `ensureOptiScaler`, the same one dlls.ts uses. It is optional, so leaving it out silently skips the AMD / Intel signer check.
- Pass `{ allowUnverified: true }` only after the user agrees to a warning. Otherwise a release with no digest is refused.
- Pass `options.installDir` to `installOptiScaler`. The outside-folder refusal only works when it is given.
- Show the list `removeOptiScaler` returns (files the game replaced since, kept as they are).
- If a later ensure needs a version the cache already has without a complete marker, it re-extracts it. A cached release whose marker is already there is not checked again.
- D3D12_Optiscaler\D3D12Core.dll (Microsoft) and the community DLLs are not signer-checked. The spec names no pinned signer for them.

I made no change to src/shared/upgrades.ts and none is needed.

---

All 7 findings were real, and all 7 are fixed in src/main/upgrades/scskiller.ts and src/main/upgrades/aio.ts, with new tests in scskiller.test.ts and aio.test.ts. Prettier and eslint are clean on all 4 files, `npx vitest run` passes 48/48 for the two test files (ran it 3 times, same result), and `tsc --noEmit -p tsconfig.node.json` shows no errors in these files. No file outside these four was edited, and src/shared/upgrades.ts is unchanged.

**Fixes (one per finding)**
1. **High: a failed SCSKiller update could delete its data folder.** Fixed.
   - The update now swaps folders in this order: `SCSKiller` → `SCSKiller.old`, then `SCSKiller.new` → `SCSKiller`, then `SCSKiller.old\data` → `SCSKiller\data`, then `SCSKiller.old` is deleted.
   - If any step fails, the old install is renamed back. The data folder is only ever renamed, never deleted, and the `finally` cleanup only removes folders that never hold user data.
   - The error says the folder is in use and to close SCSKiller and try again. If even the rollback fails, it says the data is kept in `SCSKiller.old` and will be restored next time.
   - At the start of `ensureScsKiller`, a new private `recoverSwap` finishes or undoes a swap that an earlier run left half done.
   - A new private `renameRetry` retries a folder rename up to 5 times, 100 ms apart, on EPERM, EBUSY or EACCES. I added it because Windows threw a transient EPERM when renaming a just-moved folder back, even in tests. A lock that lasts still fails after about 0.5 s.
   - Tests: the first, second and third rename each made to fail, with the old install, version marker and data checked afterwards; a half-done swap recovered with no download; data left in `.old` moved into the install.
2. **Medium: store games added a second time by hand.** Fixed. `compileShaders` now tries the Steam appid first, then the scanned row matching on name plus install folder (confirmed with `status`). It calls `add <exe> <folder>` only when no scanned row matches. Test: the scan lists `epic:X` in the same folder and an exe path is given; no `add` call is made.
3. **Low: `openAioSwapper` reported success when the app failed to start.** Fixed. `SpawnDetached` now returns `Promise<void> | void`. The real `spawnDetached` resolves on the child's 'spawn' event and rejects on 'error'. `openAioSwapper` awaits it and rethrows "DLSS AiO Swapper could not start (was it blocked by antivirus or SmartScreen?): …" with the original error as its cause. Tests: a fake that rejects, and the real `spawnDetached` with node (resolves) and a missing exe (rejects).
4. **Low: an unreachable SHA256SUMS file blocked the install.** Fixed. A failed fetch of the sums file is ignored when the GitHub checksum exists, and still throws when it does not. Test covers both cases.
5. **Low: cancelling could hang.** Fixed.
   - In `spawnTool`, if taskkill exits non-zero, `child.kill('SIGKILL')` is now called as well.
   - In `compileShaders`, after an abort, the wait races the process exit against a timeout (`deps.killWaitMs`, default 5000 ms) and returns Cancelled either way.
   - Test: a fake process that never exits after `killTree`.
6. **Low: a plain stderr log line could mark a game unsupported.** Fixed. `errorText` now reports whether its text came from an `error:` line. Only that text, a Failed note or a status can set `unsupported: true`. Test: stderr ending in '  skipping unsupported pipeline 12' with exit code 1 gives a normal, retryable failure.
7. **Low: settings.json written outside deps.** Fixed. `compileShaders` deps now take `settingsIo?: RecorderSettingsIo`, which defaults to the real file system. A failed write returns ok: false with "SCSKiller's settings could not be saved to keep its recorder off (close SCSKiller and try again) (…)", and nothing is compiled. Tests: the switch is written through the fake io with nothing on disk, and a locked write gives that message.

**Signatures that changed**
- `export type SpawnDetached = (file: string, args: string[], options: { cwd: string }) => Promise<void> | void`
- `export const spawnDetached: SpawnDetached` now returns a Promise.
- `compileShaders(exe, target, onProgress, signal, deps: { spawn: SpawnTool; settingsIo?: RecorderSettingsIo; killWaitMs?: number }): Promise<ShaderResult>`, still never rejects.
- `ensureScsKiller` and `openAioSwapper` keep their signatures.

**What the service must know**
- Await `openAioSwapper` and show its error. A start failure now rejects instead of looking like success.
- A failed SCSKiller update can leave a `SCSKiller.old` folder next to `SCSKiller` in the tools folder. The next `ensureScsKiller` call recovers it, so the service should not delete it.
- A swap can only fail during an update, and the error says to close SCSKiller. The service can show that message as it is.
- Pass `settingsIo` only for tests or fakes. Without it the real file system is used.

**Contract deviations:** none. The only change is the optional fields added to `compileShaders`' deps, and DESIGN.md's `ensureScsKiller` and `openAioSwapper` entries still hold.

---

I fixed all 5 dlls findings. Each one was real when I checked the code. I only changed C:\Users\<user>\Downloads\PlayOut\src\main\upgrades\dlls.ts and C:\Users\<user>\Downloads\PlayOut\src\main\upgrades\dlls.test.ts. Checks: prettier is clean, eslint is clean on both files, vitest passes 37/37 in dlls.test.ts, and `tsc --noEmit -p tsconfig.node.json` shows no errors in my files.

**Warning about the scratchpad:** the scratchpad folder is shared with sibling agents, and one of them overwrote my `scratchpad/head.ts` while I was working. That briefly put optiscaler code into dlls.ts. I rebuilt dlls.ts from my own backup and re-checked everything above. I also wrote `scratchpad/tail.ts`, which may have overwritten a sibling's file of the same name. Agents should use a private subfolder of the scratchpad.

**New ownership rule (it shapes several fixes).** optiscaler.ts uses the same `.playout-original` suffix, and the OptiScaler package can replace files like `libxess.dll` and `amd_fidelityfx_*.dll`. So "a backup exists" no longer means "the DLL update made it."
- A new manifest, `<installDir>/.playout-dlls.json`, lists what this upgrade swapped. It is exported as `DLL_MANIFEST`.
- Each entry holds `relPath`, `version`, and `sha256`, which is the hash of the file PlayOut put in. `null` means "trust the backup" (used after a failed swap).
- Entries are keyed by relPath in lower case with `/` separators. The manifest is written to a temp file and renamed over, and deleted when empty.
- A backup the manifest does not list is never touched. swapDlls skips that file with the reason "another upgrade (such as OptiScaler) replaced it and keeps its original".

**Contract changes (nothing in src/shared/upgrades.ts changed):**
- `DllIo` gains `writeFile(path, data: string): Promise<void>`, and `nodeDllIo` implements it.
- New export: `DLL_MANIFEST = '.playout-dlls.json'`.
- `restoreDlls(installDir, _found, io?)` returns `{ restored: string[]; failed: { relPath; reason }[] }`. DESIGN.md lists only `{ restored }`; this return type was already a superset before this round. `found` is not used any more, because the manifest is the source of truth, but the parameter is kept.
- All other signatures are the same. `ensureVendorDll`'s deps type is now a named internal interface `VendorDllDeps` with the same shape.

**What each finding now does:**
1. **(high) A failed copy no longer deletes the only original.**
   - The new DLL is copied to `<file>.playout-new`, the manifest entry is saved, then the copy is renamed over the game's file.
   - On any failure, the game file's hash is compared with its hash from before the swap:
     - **Untouched:** the backup made in this run is deleted. If that delete fails, the backup is listed with the original's hash, which is harmless because it is an exact copy.
     - **Changed or missing:** the backup is kept and listed (sha256 = the current hash, or null if the file is missing). The skip reason ends with "(Restore puts the game's own file back)", and scan reports `swapped: true`.
   - Tests: the temp copy writes partway and then throws ENOSPC (game file intact, no leftovers); the rename truncates the target and then throws ENOSPC (backup kept, Restore works); the rename deletes the target (backup kept, Restore works).
2. **(medium) An outdated backup is dropped after a game update.**
   - scan reports `swapped` only when the file is listed, its backup exists, and the current file still matches the recorded hash (or the hash is null).
   - swapDlls deletes an outdated backup and its entry first. The updated game file then becomes the new original if a swap goes ahead, and the cleanup still happens when the updated file is already the newest.
   - restoreDlls never puts an outdated backup back. It deletes it and does not list the file in `restored` or `failed`.
   - The version checks now use the version read from the file at swap time, not `found.version`.
   - Tests cover all three cases.
3. **(medium) Concurrent `ensureVendorDll` calls no longer delete each other's download.**
   - Calls for the same cache path at the same time share one promise, held in a module-level map keyed by the lower-cased target path.
   - Each download goes into its own `download-<12 hex>` folder, and the fixed `download` folder is no longer deleted.
   - Before the final rename, if a target that passes both checks is already there, it is used.
   - Tests cover one shared download, the unique folder, and a file that appears in the cache during the download.
4. **(low) Cached files and missing checksums.**
   - A cached file must now pass both checkBytes and `verifySigner` before it is reused; otherwise it is deleted and downloaded again.
   - `vendorFile` returns null when the API gives no valid 40-hex `sha`, so latestVendorDlls leaves that file out.
   - `ensureVendorDll` throws "no checksum is known for it" when both `gitBlobSha` and `sha256` are null.
   - All three have tests.
5. **(low) Restore now works from the manifest, not the `found` list.**
   - It restores every listed backup, including when the DLL itself is missing (the backup is renamed to the plain name).
   - It drops entries whose backup is gone, and lists a damaged manifest in `failed`.
   - scan also adds listed files the walk missed (cut short at the limit, or the file deleted while its backup is there), so `restorable` is still offered. A missing file shows with version null and `swapped: true`.
   - Tests: restoring with an empty `found` list and one DLL deleted; a damaged manifest (swap refuses, restore reports it); a refused restore keeps the entry so Restore can be tried again.

**Things the service needs to know:**
- Pass the same `installDir` to scan, swap and restore, because the manifest lives in that folder.
- Compute `restorable` from `found.some(f => f.swapped)`. A file whose only backup belongs to OptiScaler now shows `swapped: false`.
- A file whose `.playout-original` belongs to another upgrade is skipped by DLL updates.
- If the manifest is damaged, swap skips every file with "the list of files PlayOut replaced cannot be read" and restore reports `{ relPath: '.playout-dlls.json', reason }` in `failed`.
- `ensureVendorDll` now calls `verifySigner` on every cache hit (one Authenticode check, done through PowerShell per the design).
- A download that crashes partway can leave a `download-<hex>` folder behind in the cache; nothing cleans these up yet.

**Not done:** I did not edit DESIGN.md. It should mention `DLL_MANIFEST`, `DllIo.writeFile` and the `failed` field of restoreDlls.