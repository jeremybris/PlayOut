PLAYOUT SPECS: DLSS-AiO-Swapper launch + CompactGUI-style folder compression
(I read source over gh api and tested compact.exe live on a scratch folder on this Win11 machine (en-US, codepage 437). I did not run any downloaded binary. The scratch test folder has been deleted.)

================================================================
A) DLSS-AiO-Swapper (machiavelli31/DLSS-AiO-Swapper)
================================================================
Repo facts
- Default branch: main. The LICENSE file is MIT, "Copyright (c) 2026 Machiavelli (machiavelli31)" plus "Copyright (c) 2026 Rakan Alkhaldi". GitHub's API reports spdx NOASSERTION because of the two copyright lines.
- Electron 33.4.11, electron-builder ^25.1.8. Targets are "nsis" and "portable". The app code lives in ./app (main = app/main.js). appId: com.machiavelli31.dlssaio.
- Releases come often: v3.0.9 (2026-10-22), 3.0.12 (10-25), 3.0.13 (10-28), 3.0.14 (11-01), v3.0.15 (2026-11-17). None are prereleases.

Latest release assets, v3.0.15 (from `gh release view`):
- DLSS-AiO-Swapper-3.0.15-portable.exe, 82,053,080 bytes
  URL: https://github.com/machiavelli31/DLSS-AiO-Swapper/releases/download/v3.0.15/DLSS-AiO-Swapper-3.0.15-portable.exe
- DLSS-AiO-Swapper-Setup-3.0.15.exe, 82,325,724 bytes (NSIS, oneClick:false, perMachine:true, so the installer needs UAC; it lets the user change the folder and makes a desktop shortcut "DLSS AiO Swapper")
- DLSS-AiO-Swapper-Setup-3.0.15.exe.blockmap (85,944), latest.yml (363), SHA256SUMS.txt (203)
- SHA256SUMS.txt content:
  1093f885d7dc8c1ad0ae4683748cdd4d4fb1c50044c7807b836023c3f08692c4  DLSS-AiO-Swapper-Setup-3.0.15.exe
  732a6a3d29579cefc20956f9c967f69971282af8748820b326c8c0a561ca0703  DLSS-AiO-Swapper-3.0.15-portable.exe
- latest.yml describes only the Setup exe (sha512 base64 + size, releaseDate '2026-11-17T20:19:12.131Z'). The portable exe is not in latest.yml.
- Asset name patterns from package.json: portable.artifactName "DLSS-AiO-Swapper-${version}-portable.${ext}", nsis "DLSS-AiO-Swapper-Setup-${version}.${ext}".

Command-line arguments, deep links, opening one game: NOT SUPPORTED
- app/main.js (2062 lines) contains no "argv". It has no setAsDefaultProtocolClient, no open-url and no --game handling. I found no argv use in library.js, nv-drs.js, backend-manager.js or preload.js either.
- It takes a single-instance lock (main.js ~l.477): `app.requestSingleInstanceLock()`. A second launch quits, and the first instance only runs `app.on('second-instance', showWindow)`, which raises the window and ignores the second launch's argv.
- The only start-up switch is an environment variable: DLSS_AIO_FORCE_GPU=amd|intel|nvidia (install-guards.js gpuMode; also in the README).
- So PlayOut cannot open the app on a given game. The closest thing is to seed its library before starting it (next section).

Where it stores the game list
- main.js l.11 forces `app.setPath('userData', path.join(app.getPath('appData'), 'dlss5-swapper'))`, so the folder is %APPDATA%\dlss5-swapper for both the portable and the installed build. It is not stored next to the exe.
- Files in that folder: library.json (state), history.jsonl, posters\, art\, payload\ (downloaded components), crash.log, overlay-library\, renodx-hdr\.
- Default shape of library.json (readState l.~329):
  {"folders":[], "excludedRoots":[], "manual":[], "posters":{}, "hidden":[], "scans":{}}
  Settings also live here: autoScanDrives, groupGamesByStore, closeToTray, safeGraphics, legacyNrActive.
- "manual" is a list of absolute game folder paths. The IPC 'add-game-path' pushes a dir when it exists and is not already listed. The 'library' handler shows each one as {launcher:'Added by hand', name: basename(dir)}.
- Auto discovery (src/library.js) finds Steam (libraryfolders.vdf), Epic (C:\ProgramData\Epic\EpicGamesLauncher\Data\Manifests), GOG (HKLM\SOFTWARE\WOW6432Node\GOG.com\Games), Xbox (XboxGames) and the extra "folders".
- The per-game key is sha1(path.resolve(dir).toLowerCase()) as hex, first 16 characters, used for scans and posters.
- Steam games already appear with their appid, so a Steam game installed through PlayOut normally shows up without seeding.
- Seeding recipe for PlayOut (my inference): when the app is NOT running (check the process list), read library.json, append the game dir to "manual" if it is missing (case-insensitive), write it back, then launch. Do not write while the app runs: it holds one in-memory state object and saves the whole object back, so an outside edit would be overwritten.

GPU requirements and how it checks them (src/core/install-guards.js)
- gpuInfo() runs `nvidia-smi.exe --query-gpu=name,driver_version --format=csv,noheader` (20 s timeout) and splits each line into {name, driver}.
- displayAdapters() runs `%SystemRoot%\System32\reg.exe query HKLM\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318} /s /v MatchingDeviceId`, then the same with /v DriverDesc. It maps the ven_ id: 10de=nvidia, 1002=amd, 8086=intel.
- gpuMode(): the env override comes first. NVIDIA wins if nvidia-smi answers or any adapter is 10de; otherwise AMD, then Intel, then unknown. vendorNeutral = amd or intel.
- The DLSS 5 neural model needs Blackwell: regex /\bRTX\s*50\d{2}\b/i, or "RTX PRO" together with "Blackwell".
- Driver threshold OPTI_DRIVER = 61656, i.e. driver 616.56, computed as major*100+minor. It is advisory only.
- Older RTX cards (20/30/40) can use an optional, community-modified 310.8 model; the app shows a warning first.
- AMD and Intel get an experimental vendor-neutral port (OptiScaler F5 + DirectML) and need the MSVC x64 runtime.
- README requirements: "Windows 10/11 64-bit, NVIDIA RTX graphics card, current driver (616.64 or newer recommended)".
- Suggested gate for PlayOut: show the button on any GPU, label it "NVIDIA RTX recommended", and say "experimental" on AMD/Intel.

What it needs to run
- It is a plain Electron app with no .NET requirement. The helper resources\nv-drs.exe is compiled with the built-in .NET Framework 4 csc (Framework64\v4.0.30319), which ships with Windows. Other helpers: aio-sf-toggle.addon64, LICENSE.txt, THIRD_PARTY_NOTICES.md.
- No admin to start. The app runs asInvoker (electron-builder default).
- Elevation happens per action:
  - nv-drs.js: on NVAPI_INVALID_USER_PRIVILEGE (-137) it reruns nv-drs.exe through `powershell Start-Process -Verb RunAs -WindowStyle Hidden -Wait`, which shows a UAC prompt.
  - Game folders under Program Files fail with errNoWriteAccess. The message tells the user to "run DLSS AiO Swapper as administrator, or move the game to another folder".
- Components (DLSS DLLs, ReShade, etc.) download into %APPDATA%\dlss5-swapper\payload on first use (Components > Download all), so it needs internet.
- Portable behaviour (standard electron-builder portable): the stub unpacks to %TEMP% on every start and runs from there. PORTABLE_EXECUTABLE_DIR / PORTABLE_EXECUTABLE_FILE env vars are set for the child. It is about 82 MB, so the first start takes a few seconds.

How PlayOut should download and launch it
1. Resolve the latest release: GET https://api.github.com/repos/machiavelli31/DLSS-AiO-Swapper/releases/latest. Pick the asset whose name matches /^DLSS-AiO-Swapper-[\d.]+-portable\.exe$/, and also fetch SHA256SUMS.txt.
2. Download it to <PlayOut dir>\Tools\DLSS-AiO-Swapper\DLSS-AiO-Swapper-portable.exe. Check SHA-256 against the line in SHA256SUMS.txt with the same file name (format "<hex>  <name>", two spaces). Store the tag so updates are only fetched when the tag changes.
3. Optional focus: if the process is not running, add the game dir to %APPDATA%\dlss5-swapper\library.json "manual" (create the file with the default shape when it is missing).
4. spawn(exe, [], { detached:true, stdio:'ignore', cwd: toolDir }).unref(). Do not pass arguments (they are ignored). If it is already running, launching again just brings its window forward.
5. Do not require admin. Explain that games under Program Files need "Run as administrator", or start it with `powershell Start-Process -Verb RunAs` at the user's request.

================================================================
B) Folder compression like CompactGUI (IridiumIO/CompactGUI, GPL-3.0)
================================================================
How CompactGUI does it (current master, v4.0.0-beta.12)
- It does NOT call compact.exe. CompactGUI.Core uses the Win32 WOF API directly:
  - compress: WofSetFileDataLocation(handle, WOF_PROVIDER_FILE=2, WOF_FILE_COMPRESSION_INFO_V1{Algorithm, Flags=0})
  - decompress: DeviceIoControl FSCTL_DELETE_EXTERNAL_BACKING 0x90314
  - detect: WofIsExternalFile, plus the FileAttributes.Compressed flag for LZNT1
  - size: GetCompressedFileSize
- PlayOut can get the same result in Node with compact.exe /EXE (it calls the same API).
- WOF algorithm numbers (Core/SharedObjects.cs): XPRESS4K=0, LZX=1, XPRESS8K=2, XPRESS16K=3 (NO_COMPRESSION=-2, LZNT1=-1).
- UI/database CompType enum (CompressionMode): 0=XPRESS4K, 1=XPRESS8K, 2=XPRESS16K, 3=LZX, 4=None. This order differs from the WOF numbers.
- Which files it compresses (Compactor.BuildWorkingFilesList): mode differs from the target, AND size > cluster size, AND not sparse, AND not in the skip list. Analyser enumeration is recursive, skips reparse points, and includes hidden files. A file is "compressed" when GetCompressedFileSize != Length.
- Threads: Environment.ProcessorCount by default, one thread on HDDs (LockHDDsToOneThread=true). It drops to sequential when free space is low.
- Free-space guard: for compress, free space must be at least 2 × the largest candidate file; for decompress, the sum of (uncompressed − compressed) plus the largest file.
- Folder checks (SharedMethods.VerifyFolder), in order; it refuses when:
  - the folder does not exist
  - it is inside %WINDIR%
  - it is a drive root ("X:\")
  - it is empty or unreadable
  - it is a OneDrive folder
  - it is not on a local NTFS drive (DriveFormat=="NTFS" and DriveType!=Network)
  - the user has no write ACL
  - the folder is LZNT1-compressed

Algorithm recommendation
- README: "By default, the program runs Compact with the `XPRESS8K` algorithm". The code disagrees: Settings.cs `selectedCompressionMode = 0` and CompressionOptions.vb `SelectedCompressionMode = XPRESS4K`, so the current code defaults to XPRESS4K.
- README table: XPRESS4K fastest/weakest, XPRESS8K "balance", XPRESS16K stronger/slower, LZX strongest/slowest (for cold data).
- Recommendation for PlayOut: XPRESS8K default, LZX as a "max savings" option, XPRESS4K for games sensitive to load times.
- README warning: do not use on DirectStorage games (Windows 11).

Skip list ("non-compressible" extensions, Settings.cs nonCompressableList):
.dl_ .gif .jpg .jpeg .png .wmf .mkv .mp4 .wmv .avi .bik .bk2 .flv .ogg .mpg .m2v .m4v .vob .mp3 .aac .wma .flac .zip .xap .rar .7z .cab .lzx .docx .xlsx .pptx .vssx .vstx .onepkg .tar .gz .dmg .bz2 .tgz .lz .xz .txz
- The skip list is NOT applied by default. The global skipNonCompressable=false and the per-folder SkipPoorlyCompressedFileTypes defaults to false; the user ticks it. SkipListEnabled (master toggle) = true.
- Per-game list from the database: extensions in PoorlyCompressedExtensions with count > 100 and a non-empty key (SteamFolder.vb GetWikiResults). Used when SkipUserSubmittedFiletypes is on.
- Matching (SkipListMatcher): ".ext" or "*.ext" becomes "**/*.ext" at any depth, case-insensitive. A bare name becomes "**/name". Patterns with a separator are globs relative to the folder.

Community database
- URL: https://raw.githubusercontent.com/IridiumIO/CompactGUI/database/database.json (branch "database"; about 9.47 MB). CompactGUI caches it as databasev2.json in its data folder.
- The same branch also has version.json, CompactGUI's app version feed: {"Latest":{Major:4,Minor:0,Patch:0,PreRelease:"beta",PreReleaseMinor:12,...},"LatestNonPreRelease":{3,8,0,"r",0}}.
- Shape: a top-level JSON ARRAY (15,656 entries), NOT an object keyed by appid. Look up by entry.SteamID. Sample:
  {"SteamID":10,"GameName":"Counter-Strike","FolderName":"Half-Life","Confidence":2,
   "CompressionResults":[{"CompType":0,"BeforeBytes":2148577514,"AfterBytes":1396972944,"TotalResults":12},
                         {"CompType":1,...},{"CompType":2,...},{"CompType":3,"BeforeBytes":1796593866,"AfterBytes":967103793,"TotalResults":30}],
   "PoorlyCompressedExtensions":{".dt":94,".sc":5513,".mp3":4739,...},"TotalFiles":63}
  - Confidence: 0=Low, 1=Medium, 2=High.
  - CompType uses the 0..3 order XPRESS4K, XPRESS8K, XPRESS16K, LZX. Entries may be missing some CompTypes.
- Formulas (WikiService.ParseData, CompressionResult.vb):
  - per-algorithm saving% = (Before−After)/Before×100
  - estimated size for this install = localUncompressedBytes × After/Before
  - overall estimatedRatio = Σ(After/Before × TotalResults) / ΣTotalResults
  - Skip a result when Before or After is 0.

compact.exe usage (tested live, Win11 26300, en-US)
- Compress a whole folder:
  `compact.exe /C /S:"D:\Games\X" /A /I /EXE:XPRESS8K`   (add /F to force recompression)
  - /S:"dir" recurses. /I continues after errors. /EXE:<XPRESS4K|XPRESS8K|XPRESS16K|LZX> uses WOF.
  - /A only changes what is LISTED. Hidden and system files were compressed even without /A, and the count included them. Pass /A anyway so every file shows up in per-file progress.
  - Without /F, files already compressed are skipped and not listed, even when the algorithm differs. When I re-ran with /EXE:LZX over XPRESS8K files without /F, they were NOT changed. Use /F to switch algorithm.
  - Without /EXE, /C uses NTFS LZNT1 and marks the directory "New files added to this directory will be compressed". With /EXE the directory is not marked.
- Uncompress: `compact.exe /U /S:"dir" /A /I /EXE`
  - /EXE is REQUIRED for WOF files. Plain /U uncompressed only LZNT1 files; the WOF ones stayed compressed (verified).
- Query: `compact.exe /S:"dir" /A` lists every file. `compact.exe /Q /S:"dir" /A` prints only the per-directory headers and the summary.
- Paths: pass "/S:" + dir as ONE argv element in Node spawn (no shell). Leave out the trailing backslash, or Windows quoting breaks.

Compress output (each line ends in CRLF):
```

 Compressing files in C:\...\ctest\

a1.txt                 300000 :     12288 = 24.4 to 1 [OK]
a2.txt                 300000 :     12288 = 24.4 to 1 [OK]

 Compressing files in C:\...\ctest\sub\

rand.bin               200000 :    200000 = 1.0 to 1 [OK]
tiny.txt                    5 :         5 = 1.0 to 1 [OK]

4 files within 2 directories were compressed.
800,005 total bytes of data are stored in 224,581 bytes.
The compression ratio is 3.6 to 1.
```
- Incompressible or tiny files still print [OK] but stay at full size; WOF discards the result when there is no gain.
- Uncompress per-file lines are "a1.txt [OK]". Summary: "2 files within 2 directories were uncompressed."
- Query lines: `   300000 :     12288 = 24.4 to 1 X a1.txt`. The flag column showed: x = XPRESS4K, X = XPRESS8K and also XPRESS16K, l = LZX, C = NTFS LZNT1, blank = not compressed. The query summary is "Of 5 files within 2 directories / 2 are compressed and 3 are not compressed. / 800,005 total bytes of data are stored in 224,581 bytes. / The compression ratio is 3.6 to 1."
- Errors:
  - bad algorithm: prints the usage text, exit 1
  - missing path: "Z:\: The system cannot find the path specified." then a 0 summary, exit 1
  - success: exit 0
- Localization: the messages come from compact.exe.mui and follow the Windows UI language. The thousands separator also follows the locale (800,005 here). I could only test en-US. Do not match English words. Robust per-file regex: /^(.+?)\s+([\d.,\u00a0\u202f]+)\s+:\s+([\d.,\u00a0\u202f]+)\s+=\s+[\d.,]+\s+\S+\s+\d+\s+\[(.+)\]\s*$/ (or simply count non-blank lines that end with "]"). Headers start with a space. Decode stdout with the OEM codepage (437 here, from GetOEMCP or `chcp`), not UTF-8, or non-ASCII names break.
- Progress: stdout streams live, not block-buffered. In a Node spawn on 300 files × 400 KB I got 3,966 data chunks, the first at 21 ms and the last at 1,191 ms. Count the files first (fs walk, include hidden, skip reparse points), then progress = per-file lines seen / total. Files already compressed and skipped produce no line, so the bar should count the eligible files only, or use /F.
- Skip list with compact.exe: it cannot exclude extensions with /S. To skip extensions like CompactGUI, list the files in Node and pass explicit paths in batches (e.g. `compact /C /EXE:XPRESS8K /I /A "f1" "f2" ...`, keeping the command line under 32K characters). Another route is a PowerShell helper that calls WofSetFileDataLocation per file.

Measuring compressed size afterwards in Node
- Option 1: parse the last two lines of `compact /Q /S:"dir" /A`: "N total bytes of data are stored in M bytes." Strip the separators, take the 2 numbers (locale-sensitive).
- Option 2, recommended: GetCompressedFileSizeW per file through PowerShell. Verified; it matched compact's total (1,400,005 logical / 216,389 on disk):
```
param([string]$Dir)
Add-Type -Namespace W -Name K -MemberDefinition '[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetCompressedFileSizeW(string lpFileName, out uint lpFileSizeHigh);'
$logical=[uint64]0; $disk=[uint64]0
Get-ChildItem -LiteralPath $Dir -Recurse -File -Force -Attributes !ReparsePoint | ForEach-Object {
  $hi=[uint32]0; $lo=[W.K]::GetCompressedFileSizeW($_.FullName,[ref]$hi)
  $logical += [uint64]$_.Length; $disk += ([uint64]$hi -shl 32) + $lo }
[pscustomobject]@{ logical=$logical; onDisk=$disk } | ConvertTo-Json -Compress
```
  Output: {"logical":1400005,"onDisk":216389}. Run it with powershell -NoProfile -ExecutionPolicy Bypass -File. For a per-file "is compressed" flag, follow CompactGUI: onDisk != Length.

Admin, NTFS and Steam updates
- Admin: not needed. CompactGUI's app.manifest is requestedExecutionLevel asInvoker; it only checks the write ACL and refuses with InsufficientPermission. My compact.exe tests ran unelevated.
  - Steam's default library under C:\Program Files (x86)\Steam is normally user-writable, because Steam's installer grants Users write rights so it can patch without UAC (my knowledge, not verified here). Other libraries on other drives are user-writable.
  - Folders under Program Files from other installers need elevation. PlayOut should check write access first and offer a UAC rerun.
  - The game must be closed; files in use fail, and /I keeps going.
  - WindowsApps / Xbox folders cannot be done.
- NTFS only: CompactGUI requires DriveFormat "NTFS", local, not network. Block exFAT, FAT32, ReFS and network drives. compact.exe describes itself as working on "NTFS partitions".
- Steam updates: WOF-compressed files that are rewritten or added by an update come back uncompressed. The README's Background Watcher "monitors them for changes (e.g. Steam game updates) and automatically keeps them compressed".
  - Contents are unchanged, so Steam's verify does not flag compressed files (my knowledge, not tested).
  - PlayOut should offer re-compress (or auto re-compress when idle) after a Steam update. It can detect one through the appmanifest_<appid>.acf buildid/LastUpdated or the folder's mtime. Without /F, the rerun only touches the new uncompressed files, so it is cheap.
- Also block: OneDrive folders, drive roots, %WINDIR%, LZNT1-compressed folders. Warn on DirectStorage games.
- Free space: before compressing, require free space ≥ 2 × the largest file. Before decompressing, require (uncompressed − compressed) + the largest file.

Files kept in the scratchpad (sources fetched for evidence):
C:\Users\<user>\AppData\Local\Temp\<scratch> (app_main.js, guards.js, app_src_library.js, app_src_core_nv-drs.js, package.json)
C:\Users\<user>\AppData\Local\Temp\<scratch> (Settings.cs, WOFHelper.cs, Compactor.cs, Analyser.cs, SharedMethods.cs, WikiService.vb, dbnew.json = current database.json)
C:\Users\<user>\AppData\Local\Temp\<scratch> (the verified size script)