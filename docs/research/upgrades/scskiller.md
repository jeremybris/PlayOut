SCSKILLER CLI SPEC FOR PLAYOUT (from source at tag v1.4.8, the latest release, 2026-11-15)
Repo: github.com/BlueHeisenberg/SCSKiller. Licence GPL-3.0-or-later plus LICENSE-EXCEPTION.txt. PlayOut should only drive the exe, never copy its code.
Evidence files: src/SCSKiller.Cli/Program.cs (1016 lines, the whole CLI), Cli.csproj, build/publish.ps1, src/SCSKiller.Core/App/AppStore.cs, Contracts.cs, App/ScsKiller.cs, App/QueueRun.cs, App/Elevated.cs, Vendors/GpuBackends*.cs, Vendors/IntelBackend.cs, Games/ManualSource.cs, Planning/Planner.cs, ARCHITECTURE.md, README.md. I listed the real Portable.zip's contents without extracting or running anything. Scratch copies are in C:\Users\<user>\AppData\Local\Temp\<scratch> and ...\scratchpad\scsk-dl (the downloaded Portable.zip, 117 MB, is there too).

== 1. RELEASE ASSETS, LAYOUT, RUNTIME ==
Latest release tag: v1.4.8. API: gh api repos/BlueHeisenberg/SCSKiller/releases/latest. Base URL: https://github.com/BlueHeisenberg/SCSKiller/releases/download/v1.4.8/<name>

Assets (name, size in bytes, GitHub digest):
- SCSKiller-1.4.8-Portable.zip, 117544651, sha256 f6cf52b87d5967dbdbb15d90299a9abee70953ce74a04442d107f36d33bca9de
  - The name pattern is SCSKiller-<ver>-Portable.zip, so match it with the regex ^SCSKiller-[\d.]+-Portable\.zip$.
- SCSKiller-Setup.exe, 125073632 (Velopack installer, installs per user)
- SCSKiller.zip, 111666892, sha256 9eb45c6a... (the raw publish output, see the warning below)
- SHA256SUMS-unsigned.txt, 54972
- SCSKiller.App-1.4.8-stable-full.nupkg, releases.stable.json (+ .sig): the Velopack update feed
- Linux files: SCSKiller-x86_64.AppImage, *-linux-full.nupkg, releases.stable-linux.json (+ .sig), SHA256SUMS-linux.txt

SHA256SUMS-unsigned.txt format (sha256sum style, 526 lines):
  "<64 hex>  <path>"
- The first line is "9eb45c6a...  SCSKiller.zip".
- Every other line is one file inside SCSKiller.zip, for example "18fcc99aaff6dc2f9778a405380783044df95b308e4f53c40606697eddd17cc3  SCSKiller/cli/scskiller.exe".
- It does NOT list the Portable zip.
- The Portable zip's SHA-256 is in two places only:
  - the asset's "digest" field in the GitHub API ("sha256:f6cf...");
  - the release body, at its end:
    SHA-256:
    ```
    f6cf52b8...bca9de  SCSKiller-1.4.8-Portable.zip
    336a729a...  SCSKiller-Setup.exe
    8f857847...  SCSKiller-x86_64.AppImage
    ```
- Recommended check: use the API digest, falling back to the release-body line. The builds are not code-signed.

Portable.zip layout (Velopack portable, 527 entries, 277.6 MB unpacked, timestamps 1980):
  .portable                      (empty marker: makes the data folder <root>\data)
  SCSKiller.exe                  (Velopack stub, 499712 bytes)
  Update.exe
  current\SCSKiller.exe          (the GUI app, Avalonia) + its self-contained .NET DLLs, vcruntime140.dll, vcruntime140_1.dll, zlib-ng2.dll, Oodle.NET.dll, OodleSharp.dll, sq.version (nuspec: version 1.4.8, channel stable)
  current\cli\scskiller.exe      (162304 bytes, console CLI) + scskiller.deps.json, scskiller.runtimeconfig.json, the full .NET runtime (hostfxr, coreclr, ...), vcruntime140*.dll, zlib-ng2.dll  (229 files under cli\)
  current\cli\scskillerw.exe     (the same CLI flagged GUI subsystem, no console window; the scheduled task runs it)
  current\native\scskiller_warm.exe, d3d12.dll (recorder/proxy), d3d9.dll, x86\d3d9.dll, amd_ags_x64.dll, scskiller_ags.dll, fossilize-replay.exe, VkLayer_scskiller.dll, segheap\scskiller_warm.exe, preload\{winmm,version,dinput8}.dll
- The CLI finds its native tools at ..\native\ relative to cli\ (publish.ps1: "the app looks in native\, the CLI in ..\native\").
- The Oodle DLL (oodle-data-shared.dll) is not in the Portable zip. Codecs are fetched into the data folder's codecs\ at run time (Codecs.Ensure).

.NET: self-contained (Cli.csproj: net10.0-windows, RuntimeIdentifier win-x64, SelfContained true, "end users must never get the 'install .NET' prompt"). No .NET install and no VC++ redist are needed: both are app-local.
Requirements: Windows 10 2004+ or 11 x64; NVIDIA or AMD GPU; DirectX 12 games, and DirectX 11 games on NVIDIA.

!! Do not use SCSKiller.zip for PlayOut.
- Its layout is SCSKiller\cli\scskiller.exe with no Update.exe and no .portable marker.
- AppStore.RefusesLiveData() then makes every command except fetch-codecs exit 1, printing to stderr: "This is a development build: set SCSKILLER_DATA_DIR to a test folder, or SCSKILLER_ALLOW_LIVE_DATA=1 to use your real data."
- The check looks for Update.exe or .portable in .. or ..\.. of the exe folder.
- So: unpack Portable.zip into one folder, for example <PlayOut>\Tools\SCSKiller\, keeping .portable and Update.exe, and run <root>\current\cli\scskiller.exe.

== 2. FULL CLI (Program.cs Usage, verbatim command set) ==
Usage: scskiller <command>
- scan [--rescan]: discover games and print every game's status. --rescan redoes engine detection.
- add <exe> [<install folder>]: add a game no store lists, by its exe. Give the folder too: only a confirmed folder lets the recorder go in.
- exe <game> <exe>|auto: set a store game's exe.
- status [game]: all games, or one game in detail.
- compile <game|--all-ready> [--threads N] [--idle | --when-idle] [--careful | --fast] [--rt-only]
  - --idle: idle process priority. On Windows 11 it also sets power throttling so the work runs on E-cores. It pauses while another discovered game runs, if PauseWhileGaming is on.
  - --when-idle: queues the games as "when idle" items. They wait until the user has been idle 2 min (IdleAfter) and pause on input. This line prints first: "waiting until the PC has been idle for 2 min (pauses on input)".
  - --careful (AMD only): compiles the recorded pipelines in passes on few threads, persisted per game. --fast turns that back off.
  - --rt-only: only the ray tracing pipelines.
  - Unknown --options are refused: "error: unknown option '--x'", exit 1.
  - --all-ready = games with Status Ready or Stale, no "no stutter" note, and not CompileUnreached.
- queue [command]: a debug shell that reads stdin lines: list | add <game> | move <game> <index> | remove <game> | start | stop | wait | quit
- before-after <game> [--minutes N] [--no-overlay] [--max]: debug only.
- rewarm-stale [--if-driver-changed]: what the scheduled task runs.
- cache get | cache set <GB|unlimited|default>: the driver cache limit. set needs admin; on NVIDIA only (CacheSizeConfigurable).
- cache page [--files] [delete <item>|everything [--others]]
- cache clear <game> [--game-precache]: deletes the game's driver caches and D3DSCache, and asks y/N first. --game-precache also deletes *.ushaderprecache, etc.
- nvidia-snapshot (read-only) | nvidia-auto-shader off|low|medium|high (admin)
- Options for the admin commands: --yes skips the prompt, --result <file> writes a JSON line, --for-user <SID>.
- record install|uninstall <game> | record remove-all | record clear <game> | record alongside <game> on|off | record grant <game> (Linux)
- shared <game> on|off|follow: community shared hashes for the game.
- key <game> <hex>: an AES or game key.
- index <game> --out <dir>, rehydrate ..., reference export ...: debug.
- task register|unregister: the logon/idle "re-warm after driver update" scheduled task. Refused when the data folder is moved.
- shader-cleanup keep|allow (admin): stops Windows disk cleanup from clearing D3DSCache.
- steam-place, proton-env: Linux only.
- fetch-codecs <dir>: packaging only.
- --version / -v: prints AppVersion.Current, for example 1.4.8.
- -h / --help / no args: prints the usage, exit 0.

Game identification ("<game> is an id (steam:2909400) or a case-insensitive part of the name"):
- Match order:
  1. exact id (case-insensitive), also the id with ':' replaced by '_';
  2. exact name;
  3. unique substring of the name.
- 0 hits: "error: no game matches '<q>'".
- Several hits: "error: '<q>' matches several games: A (id), B (id)".
- Always pass the id.

Id formats (from the Games/*Source.cs files):
- steam:<appid>
- epic:<AppName> (the Epic manifest's AppName)
- gog:<productId>
- ea:<id>
- ubisoft:<id>
- xbox:<PackageFamilyName> (or its name)
- also Battle.net, Riot, HoYoPlay, Gaijin, PURPLE, WeGame, Gryphline and Steam shortcuts
- manual:<16 hex>, for games added by exe. Computed as:
  "manual:" + lowercase hex( SHA256( UTF8( Path.GetFullPath(exe).ToUpperInvariant() ) ) )[0..16]
  PlayOut can compute this id itself, which makes it deterministic: the same exe always gives the same id.
- Non-store game: run `scskiller add "<full exe path>" "<install folder>"`.
  - stdout: "added: <id>  <name>  <exePath>" or "already listed: <id>  <name>  <exePath>".
  - Error when the folder doesn't hold the exe: "error: <dir> doesn't hold <exe>."
  - Stored in <data>\manual-games.json as entries {Exe, InstallDir, Name, Confirmed}.

There is NO --json or machine output mode. Everything is plain text in English.
- stdout is UTF-8 (Console.OutputEncoding set).
- Log and diagnostic lines go to stderr, each prefixed by two spaces (StderrLog).
- Errors go to stderr as "error: <message>".
- The only structured output is --result <file> (admin commands), one JSON line: {"Ok":true,"Message":"..."}.

Exit codes:
- 0: success. For compile, every queued game reached Done (QueueRun.Done). Also "nothing to compile".
- 1: any error (Fail). A compile that was stopped, failed, or did not finish for every game. A y/N prompt answered with anything but y. The dev-build refusal. "an update is being installed, try again in a minute" (when Velopack is applying an update; rewarm-stale returns 0 in that case).
- 2: stray positional argument ("error: unexpected argument 'x'\nusage: scskiller ..."); rehydrate incomplete; before-after aborted.
- 3 / 130: before-after only.
- Beta and alpha builds need an AlphaGate token, otherwise exit 1. The stable channel is not affected.

Confirmations (cache clear, record clear, cache page delete) write "<question> [y/N] " to stdout and read stdin.
- When stdin is piped, the CLI reads one answer and echoes it.
- Pipe "y\n" to confirm.
- No answer gives: "error: cancelled: no answer on stdin (pipe y to confirm)".

STDOUT FORMATS
scan:
  GPU: <adapter name>, driver <driverVersion> (<profile>)
  - profile is the VendorCaps.Profile string. "unsupported" means no backend for this GPU (Intel without the opt-in, unknown vendor, or NVIDIA with a broken nvapi). "intel-1" is the Intel backend.
  - Then one Row per game.
status (no game): the same Rows. A game with middleware also gets: 15 spaces + "middleware: <tags joined by ' · '>".
Row format (C# interpolation):
  {StatusName,-19} {Id,-24} {Name}[tags]  - {reason}
- StatusName is one of: Unsupported, NeedsRecording, Ready, Warmed, Stale, NeedsOfflineSession, NeedsSteamStart.
- Optional tags, in this order:
  - "  [couldn't check for anti-cheat]" | "  [checking for anti-cheat]" | "  [<anti-cheat name>]"
  - "  [known stutter: low|medium|high...]"
  - "  [no shader stutter]"
  - "  [recorder]"
  - "  [cache 1.2 GB]"
- Then "  - " and the StatusReason. For a game played with nothing recorded, the reason is "Played, nothing recorded. <why>" instead.
- Parse with a regex:
  ^(\S+)\s+(\S+)\s+(.*?)((?:  \[[^\]]*\])*)  - (.*)$
  The id never has spaces, so cols 1 and 2 split on whitespace. The name runs up to the first "  [" or "  - ".
- Example:
  Ready               steam:2909400            FINAL FANTASY VII REBIRTH  [known stutter: high]  - <reason text>
- Format.Bytes: "<n.#> GB" for 1 GiB or more; smaller units below that.

status <game> prints a block of "  <label padded to 10> <value>" lines.
- First line: "<Name> (<id>, <store>)".
- Labels in order: install, exe, runs as, engine, status, anti-cheat, shaders, plan, stutter, middleware, estimate, careful, shared, warmed, failed, covered, other APIs, cache, keys, recorder, recording, last play, 1st launch. Optional extra lines: mod, warning, prefix.
- Useful lines:
  - "  status     <StatusName>: <reason>"
  - "  estimate   <bytes> of cache, h:mm:ss" (the estimated warm time; "-" if unknown)
  - "  warmed     yyyy-MM-dd HH:mm for driver <v> in h:mm:ss[, counts]" or "never"
  - "  covered    NN% for <api>"
  - "  recorder   installed | not installed (why)"
  - "  engine     <Family Version [fork] [api]> [encrypted] · note"

compile progress (stdout, one line on every stage change or at most every 2 s):
  HH:mm:ss <gameId> <QueueStage><ProgressText>[ - <error>]
- QueueStage values: Waiting, Indexing, Planning, Materializing, Warming, Merging, Paused, Done, Failed, Stopped, Saving, Finishing.
- ProgressText (ScsKiller.ProgressText):
  - Waiting with a note: " - <why>"
  - Indexing: " <done>/<total> packages"
  - Planning or Materializing: " <pct:0.0>% <done>/<total> <step>" or " <done> <step>"
  - Merging: ": Handing the compile to the game's cache, NN%, X/Y MB, <time> left"
  - Saving: ": Saving the driver's cache[, elapsed]"
  - Finishing: ": Finishing up[, elapsed]"
  - Warming, Done or Stopped: " <done>/<total> (<failed> failed[, <skipped> skipped: not in this install]) <rate:0>/s[, memory limit: W of T threads][ - <note>]"
  - Paused: " - paused while <game> is running" | " - paused until the PC is idle" | "paused". A stall note reads "no progress for N min".
- Example lines:
  21:04:11 steam:2909400 Planning 42.0% 420/1000 <step>
  21:05:30 steam:2909400 Warming 15234/80211 (3 failed) 812/s
  21:12:02 steam:2909400 Done 80211/80211 (3 failed) 0/s - <counts note>
- Regex for warming lines:
  ^\d\d:\d\d:\d\d (\S+) Warming (\d+)/(\d+) \((\d+) failed
- Ctrl+C (CancelKeyPress) prints "stopping (in-flight compiles finish so the driver writes its cache)..." and stops gracefully, then exits 1.
  - From Node there is no Ctrl+C to send. Options: GenerateConsoleCtrlEvent in a shared console, or simply kill the process tree. Killing loses the in-flight driver cache write.
  - Alternative: run "queue" and write "stop"/"quit" to stdin. "quit" means StopQueue, then wait, then exit 0.
- "nothing to compile" means an empty target list (exit 0).
- A refused single target returns "error: <Name>: <reason>". This happens for CantReachReason and ThirtyTwoBitReason ("32-bit games aren't supported yet").
- The compile keeps the PC awake (SetThreadExecutionState).
- The warm stops by itself (graceful, Yielded) when a process with the game's exe name starts. With --idle it also pauses while another discovered game runs.

cache clear output: lists parts ("<Name>  <bytes>", then "  <file>" lines), then any "note:" and "kept:" lines, then the y/N prompt, then "cleared <Name>'s shader caches" or "forgot <Name>'s compile".
record install output: "recorder installed: <exe dir>". record uninstall output: "recorder uninstalled: <dir>". Failure: "error: <Name>: recorder not installed: <why>".
record remove-all output: "removed  <id>  <folder>" | "left     <id>  <folder>: <why>" | "Vulkan recorder unregistered: <layer>". Exit 1 if anything is left.

== 3. STATE, RECORDER DEFAULT, REQUIREMENTS ==
Data folder (AppStore.DefaultDir):
- Installed build: %LOCALAPPDATA%\SCSKiller.
- Portable build: <portable root>\data. The root is the folder with .portable, found at .. or ..\.. of the exe.
  - The first portable start copies an existing %LOCALAPPDATA%\SCSKiller into data\. It writes a migrated marker, using data.partial then a rename.
  - Mutex: Global\SCSKiller-portable-copy-<16 hex>.
- SCSKILLER_DATA_DIR=<dir> overrides either one. With it:
  - a recorder goes in only with SCSKILLER_TEST_RECORDER=1;
  - task register is refused ("Not available while the data folder is moved.").
  - This is a strong option for PlayOut: give SCSKiller a private data dir, for example %APPDATA%\PlayOut\scskiller-data, and it can never place recorders.
  - Its downside: SCSKiller's own uninstall cleanup only knows the default folder.
- Files in the data folder:
  - settings.json; scan caches: discovered.json, scan.json, games.json, middleware.json, reshade.json, ags.json, manual-games.json; added-library.json
  - app.log, recorders.log, auth.dat, codecs\
  - games\<id with ':'→'_'>\, for example games\steam_2909400\. Ids with unsafe characters become "%"+URI-escaped. It holds state.json (GameRecord), plan.bin, warm-*.keys, recording.db, work\ (deleted after the warm), warm-last.log, compile-error.log, scskiller.warmed, compiled.keys.
- Compiled output goes into the driver caches, not into SCSKiller's folder:
  - NVIDIA: the DXCache, plus the D3DSCache under %LOCALAPPDATA%.
  - AMD: %LOCALAPPDATA%\AMD\DxcCache (D3D12) and %LOCALAPPDATA%\AMD\DxCache (D3D11).
  - Intel: %LOCALAPPDATA%Low\Intel\ShaderCache.

settings.json is System.Text.Json with PascalCase property names, enums as strings, indented. Relevant fields (Contracts.cs record Settings, with defaults):
  "RecordAllGames": true       <- the "Record in all compatible games" switch. A game's RecorderOverride (Default/On/Off, in games\<id>\state.json) wins over it.
  "WelcomeSeen": false
  "RecordAntiCheatGames": false
  "ExperimentalIntel": false   <- must be true for Intel to compile at all
  "PauseWhileGaming", "Threads", "BackgroundThreads", "Priority", "OnDriverUpdate": "Ask"|"WhenIdle"|"Off", "DriverRightAway"
  "StartWithWindows": true (app only), "ShareRecordings": false, "ShareDiagnostics": false, "ActiveCheck": false, "UseCommunityDb": true (needs a Patreon sign-in anyway), "RecordingLimitMB": 1024, "ScanAtStart": true, "HddMode": false
Settings has more required positional members (Threads, Priority, OnDriverUpdate, BackgroundThreads, PauseWhileGaming). So patch an existing settings.json as a JsonObject (only set "RecordAllGames": false and "WelcomeSeen": true); don't write a whole new one with guessed fields. If none exists, run "scskiller scan" once to create it, then patch.

How the recorder gets placed (important):
- ScsKiller.ManageRecorders: "Only the app sets it: the CLI and the scheduled task never install recorders."
- So when PlayOut only drives the CLI, no recorder goes in automatically. The only CLI path is an explicit "record install <game>", which sets the override On.
- "record uninstall <game>" sets the override Off and removes the files. "record remove-all" removes the recorder from every game.
- On a new install the app also holds recorders until the Welcome is closed (AwaitWelcome).
- To be safe if the GUI app is ever opened: set RecordAllGames=false. The CLI has no command to change it. Or use SCSKILLER_DATA_DIR, which blocks recorders entirely.
- What the recorder places beside the game's exe: d3d12.dll (or d3d11.dll), scskiller.cfg, scskiller.keys, scskiller.db, scskiller.log, scskiller_creates.csv, scskiller_frames.bin. It may also place a preload winmm.dll, version.dll or dinput8.dll, or amd_ags_x64.dll on AMD AGS games.

What compile needs:
- No admin: compile, scan, status, add and record don't check admin. Only these need an elevated prompt: cache set, nvidia-auto-shader, shader-cleanup.
- GPU:
  - NVIDIA: NvidiaBackend, needs a working nvapi64.dll.
  - AMD: AmdBackend.
  - Intel: only with ExperimentalIntel=true (IntelBackend, profile "intel-1"; the README says "Intel GPUs aren't supported yet").
  - Any other GPU: UnsupportedVendor, profile "unsupported".
  - Planner gives Unsupported "not supported on this GPU yet" when the caps aren't exe-keyed.
  - DirectX 11 is NVIDIA-first; on AMD it often needs a recording.
- The game should be closed. The warm runs scskiller_warm.exe staged under the game's exe name and stops gracefully as soon as that exe starts. PlayOut should not launch the game during a compile, or should expect a Paused/Stopped item.
- Duration depends on the game: tens of thousands of pipelines at hundreds per second, so minutes to over an hour. Read it per game from "status <game>": the "estimate" line gives h:mm:ss and cache size. "warmed" shows the last warm time.
- It uses a lot of CPU: threads come from Settings.Threads, or --threads N. The memory budget comes from MaxCompileMemoryGB, 0 = auto.
- Disk: it pauses when disk space is low (LowDisk note).
- A driver update makes games Stale. Re-run "compile <id>" or "compile --all-ready".
- Steam/launcher prerequisites show up as statuses: NeedsSteamStart ("start it once from Steam, then compile..."), NeedsOfflineSession (ELDEN RING / AC6).

== 4. SUPPORT DETECTION AND STATUS ==
Pipeline: Scan → Read (engine reader builds a ShaderIndex) → Check (Planner.Check gives Unsupported, NeedsRecording or Ready) → Plan → Materialize → Warm.

Engine readers, tried in order (ScsKiller.DefaultReaders):
- Unreal: cooked UE4.2x/5.x. Reads ShaderArchive-*.ushaderbytecode code libraries from .pak/.utoc/.ucas via CUE4Parse. Reads the user's <Saved>\<Project>_<Platform>.upipelinecache. Picks the -Shipping.exe. AES keys come from the exe or the user.
- FromSoft, Unity, RE Engine, REDengine, Dagor, Northlight, Source2, Rage, NaughtyDog, SantaMonica, Nixxes, Tank, Decima, Luminous, ForzaTech, BlackSpace, Swarm, Snowdrop, Frostbite, CryEngine.
- Carved (any game): carves and validates raw DXBC/DXIL containers in the game files. Shader- and PSO-named files are read whole, others sampled. Pipeline-record files like *.psocache, *.ushaderprecache and *.upsoprecache count. RTS0 parts mean "plans without a recording" (Version "DXIL"/"DXBC"/"+RTS0").
- Vulkan: Fossilize .foz archives. Sources, best first:
  1. SCSKiller's recording;
  2. Steam's local shadercache recording;
  3. Valve's download;
  4. the community DB.
  Replayed with native\fossilize-replay.exe. On Windows a Vulkan game needs a Steam layer key, otherwise "Steam only".
- Middleware DLLs (FidelityFX, XeSS) are covered as extra items.

Status values (enum GameStatus { Unsupported, NeedsRecording, Ready, Warmed, Stale }). The CLI also prints two derived names: NeedsSteamStart and NeedsOfflineSession.

Unsupported reasons (the reason text is human-readable; show it as-is):
- "not supported on this GPU yet"; "runs on <API>..." (a Vulkan or other API not usable on this GPU)
- "encrypted game files"; "32-bit games aren't supported yet"
- "SCSKiller found no shaders it can compile for this game yet"
- game-verdicts.json entries; games that precompile at boot (BootPrecompiles.Reason); a blocking ReShade/shader mod
- "couldn't read its files: ..." / codec errors
- CantReachReason: "the compile can't reach this game: it reads its shaders from a different driver cache..."
- No engine detected at all (reader.Detect returns null). The index command reports this as "engine not supported".
- Anti-cheat doesn't make a game Unsupported by itself. It keeps the recorder out, so a game that needs a recording and has anti-cheat stays Unsupported/NeedsRecording.

NeedsRecording: "needs a recording ...", "the recording has no draws: play into the game world", Vulkan start-once, ray tracing needing a recording.
Ready: the planner can compile from the files: an NVIDIA state-independent cache plus a root-signature rule for the engine version, or RTS0 embedded, or Dawn stores, or an existing recording.
Warmed: compiled for the current driver and build. Stale: the driver, game build, planner or rules changed since the warm.

Practical mapping for PlayOut:
- Ready or Stale: offer "Compile shaders".
- Warmed: done.
- NeedsRecording, NeedsSteamStart, NeedsOfflineSession: show the reason. The game needs play with the recorder, or a Steam start first.
- Unsupported, or the game is not listed by scan: not supported.
- The GPU line's profile "unsupported": SCSKiller can't compile on this PC at all.
- Call order:
  1. "scskiller scan" once; the scan is cached in scan.json.
  2. "scskiller status <id>" per game, parsing the "status" line.
  3. "scskiller compile <id> [--idle]" while streaming stdout lines.
  4. "scskiller cache clear <id>" with "y" piped to stdin.