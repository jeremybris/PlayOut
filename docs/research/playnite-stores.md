# Playnite: installed-game detection, launching and play-time tracking (for GameDash)

Research report, 2026-10-29. Everything below was read from the sources listed in section 0 or verified read-only on this Windows 11 PC. Items that could not be verified are marked **UNVERIFIED**. Store sign-in flows are out of scope and only get one line each.

## 0. Sources, versions, local copies

| Repo | What was used | Commit / date |
|---|---|---|
| Playnite core, https://github.com/JosefNemec/Playnite, branch `master` | `source/Playnite`, `source/PlayniteSDK`, `source/Playnite.FullscreenApp`, `source/Playnite.DesktopApp` | `3e8abb241873e326e27c75b59dd0d2ea367698e3` (2026-10-19). Product version `10.63` (`source/Playnite/Playnite.csproj:4`), `net462`, C# 12. |
| PlayniteExtensions on GitHub, https://github.com/JosefNemec/PlayniteExtensions | **Archived** (GitHub API: `archived=true`, last push 2026-09-21, commit `886468f65724e6fd104f3a09847a17ba57cfb430`). Its README now only says "Repository was moved to Codeberg". | |
| PlayniteExtensions on Codeberg, https://codeberg.org/CrowIsTaken/PlayniteExtensions, branch `main10` | **Primary source for all library extensions in this report.** `source/Libraries/*` | `f008798eb06c6eb1e9cc48711a5a56d470c2cf2d` (2026-10-18, "Epic 2.34 release") |
| PlayniteExtensions pre-removal snapshot | `source/Libraries/OriginLibrary` (EA app / Origin plugin). The plugin was deleted from the repo in commit `f61dfdc` "Removed Origin plugin" (2025-10-15). | parent commit `091083c5e07d425c60c9918f4aa796a9bc8ec63b` |
| `PlayniteRepo` submodule of the extensions repo | The extensions compile **linked copies** of older core files (`PlayniteRepo/source/Playnite/Common/ProcessMonitor.cs`, `ProcessStarter.cs`, `Paths.cs`, `Programs*.cs` are NOT linked - see csproj lines 48-85 of `SteamLibrary.csproj`). The submodule is pinned to Playnite commit `39e7ff05696d9f3f5561e4e62f4aa21cbb4cc2df` (2023-05-03) on both GitHub and Codeberg, so the `ProcessMonitor` class used by the plugins is the OLD one (section 1.6), not the `Monitor*` classes in today's core. | |
| Second source for Battle.net `product.db` schema | `src/product_db.proto` in https://github.com/FriendsOfGalaxy/galaxy-integration-battlenet | consistent with Playnite's field numbers |
| Community EA app addon (not bundled) | `Jeshibu_EaLibrary` in the official addon DB (https://github.com/JosefNemec/PlayniteAddonDatabase `addons/library/Jeshibu_EaLibrary.yaml`, AddonId `OriginLibrary_Builtin`), source https://github.com/Jeshibu/PlayniteExtensions `source/EaLibrary` | branch `main`, read 2026-10-29 |

Difference between the archived GitHub copy and Codeberg `main10` (hash-compared, non-Localization files): GitHub lacks `EpicLibrary/EpicLauncherV2.cs`, `EpicLibrary/Models/EpicLauncherV2.cs` and `SteamLibrary/Models/Steam.cs`; `EpicLibrary.cs`, `EpicGameController.cs`, `EpicClient.cs`, `EpicLauncher.cs`, `GogLibrary.cs`, `GogAccountClient.cs`, `ItchioLibrary.cs`, `Itch.cs`, `SteamShared/*`, `PlayerService.cs` differ. All other library `.cs` files (Battle.net, Uplay, Xbox, Amazon, Humble, Rockstar, Steam core files) are byte-identical, so line numbers apply to both.

Local copies (scratchpad; `P:` and `Q:` were `subst` drive aliases used during research because git cannot handle the path length):

- `C:\Users\<user>\AppData\Local\Temp\<scratch>` (GitHub zipball of master @ 3e8abb2)
- `...\scratchpad\repos\playnite-extensions` (GitHub master @ 886468f, archived)
- `...\scratchpad\repos\playnite-extensions-codeberg` (Codeberg main10 @ f008798)
- `...\scratchpad\repos\playnite-extensions-preorigin` (GitHub @ 091083c, contains `OriginLibrary`)

Deliverables written to `...\scratchpad\research\`:

- `playnite-stores.md` (this file)
- `battlenet-products.json` (product table, product.db protobuf schema, launch/install/uninstall rules)
- `Emulation\` (verbatim copy of `source/Playnite/Emulation`: `Platforms.yaml`, `Regions.yaml`, `Emulators\<Name>\emulator.yaml` x95, 6 `importGames.ps1` scripts)
- `Platforms.yaml`, `Regions.yaml` (verbatim copies)
- `Emulators.yaml` (generated: all 95 `emulator.yaml` documents concatenated into one YAML list; Playnite itself has no single Emulators.yaml anymore - it loads one `emulator.yaml` per directory)
- `retroarch-cores.md` (generated table: 156 RetroArch profiles -> core DLL, platforms, extensions)

Verification environment: this PC has Steam, GOG Galaxy, Epic Games Launcher (legacy Win64 build) and the EA app installed; Battle.net, Ubisoft Connect, Amazon Games, itch and Humble App are not installed, so their on-disk files were not verified live (their formats come from code only).

Citation format: `File.cs:NN-MM` = line numbers in the snapshot named in the section header.

---

## 1. Core: launch pipeline, process monitoring, play time (Playnite master @ 3e8abb2)

### 1.1 Data model

`source/PlayniteSDK/Models/GameAction.cs:15-42`:

```csharp
public enum TrackingMode : int
{
    Default = 0,          // "Playnite will try to use the best one automatically."
    Process = 1,          // "Origin process and all started child processes are tracked."
    Directory = 2,        // "Any process from specified directory is tracked."
    OriginalProcess = 3,  // "Only originally started process is being tracked."
    ProcessName = 4       // "Any process by given process name is being tracked."
}
public enum GameActionType : int { File = 0, URL = 1, Emulator = 2, Script = 3 }
```

Plugins describe a launch with `AutomaticPlayController` (`source/PlayniteSDK/Plugins/Actions.cs:29-86`): `Type` (`AutomaticPlayActionType.File=0 | Url=1`), `TrackingMode`, `TrackingPath`, `Arguments`, `Path` (exe or URL), `WorkingDir`, `InitialTrackingDelay = 0` ms, `TrackingFrequency = 2000` ms. Or they implement their own `PlayController` and raise `InvokeOnStarted(GameStartedEventArgs{StartedProcessId})` / `InvokeOnStopped(GameStoppedEventArgs{SessionLength /*seconds, ulong*/})` (`Actions.cs:204-248`).

Expandable variables (`source/PlayniteSDK/ExpandableVariables.cs`): `{InstallDir}`, `{InstallDirName}`, `{ImagePath}`, `{ImageNameNoExt}`, `{ImageName}`, `{ImageDir}`, `{PlayniteDir}`, `{Name}`, `{Platform}`, `{GameId}`, `{DatabaseId}`, `{PluginId}`, `{Version}`, `{EmulatorDir}`. Expansion happens in `source/Playnite/Extensions/GameExtensions.cs:189-243` (`Game.ExpandVariables(input, fixSeparators, emulatorDir, romPath)`), applied to `Arguments`, `AdditionalArguments`, `WorkingDir`, `TrackingPath`, `Path` of a `GameAction` (`GameExtensions.cs:38-47`).

### 1.2 `GamesEditor.PlayGame` (`source/Playnite/GamesEditor.cs:189-358`)

1. Not installed -> `InstallGame`. Already `IsRunning || IsLaunching` -> refuse (line 213).
2. Collect play actions: plugin `PlayController`s from `GetPlayActions` plus the game's own `GameActions` with `IsPlayAction`; if more than one and no index given, show the action selector (lines 219-241).
3. Controller choice (lines 266-285): `AutomaticPlayController` -> `GenericPlayController` (core drives it); a plugin `PlayController` is used as-is; `EmulationPlayAction`/`GameAction` -> `GenericPlayController`.
4. `RunningGames.Add(game.Id)`, `IsLaunching = true` (lines 314-317), `OnGameStarting` to extensions (cancelable), pre-scripts, then `controller.Play(...)` / `Start(...)`.

### 1.3 `GenericPlayController.Start(GameAction …)` (`source/Playnite/Controllers/GenericGameController.cs:479-667`)

Process start: `File` -> `ProcessStarter.StartProcess(path, args, workDir)` = `Process.Start(ProcessStartInfo)` with working dir defaulting to the exe's folder (`source/Playnite/Common/ProcessStarter.cs:95-121`); `URL` -> `ProcessStarter.StartUrl(url)` = `Process.Start(url)` with fallback `cmd /C start <url>` (`ProcessStarter.cs:70-83`). `StartUrl` returns a `Process` that is NOT the game (it is the protocol handler), so URL launches never use process-tree tracking.

Tracking per mode (quoted from lines 529-666):

```csharp
if (action.TrackingMode == TrackingMode.Default)
{
    if (action.Type != GameActionType.URL)
    {
        // Handle Windows store apps
        var uwpMatch = Regex.Match(action.Arguments ?? string.Empty, @"shell:AppsFolder\\(.+)!.+");
        if (action.Path == "explorer.exe" && uwpMatch.Success)
        {   // scan dir = InstallDirectory, or the UWP package dir found via Programs.GetUWPApps() by AppId == GameId
            var monitor = new MonitorDirectory(scanDirectory);  ... StartTracking(() => monitor.IsProcessRunning() > 0, startupCheck: () => monitor.IsProcessRunning(), ...)
        }
        else if (proc != null)
        {   InvokeOnStarted(new GameStartedEventArgs() { StartedProcessId = proc.Id });
            var monitor = new MonitorProcessTree(proc.Id);
            StartTracking(() => monitor.IsProcessTreeRunning(), trackingFrequency: action.TrackingFrequency, trackingStartDelay: action.InitialTrackingDelay);
        }
    }
    else
    {   // URL launch: watch the game's InstallDirectory
        var monitor = new MonitorDirectory(gameClone.InstallDirectory); ... startupCheck ...
    }
}
else if (action.TrackingMode == TrackingMode.Process)        -> MonitorProcessTree(proc.Id)
else if (action.TrackingMode == TrackingMode.OriginalProcess)-> MonitorProcess(proc)
else if (action.TrackingMode == TrackingMode.Directory)      -> MonitorDirectory(TrackingPath ?? InstallDirectory)   (with startupCheck)
else if (action.TrackingMode == TrackingMode.ProcessName)    -> MonitorProcessName(TrackingPath)                    (with startupCheck; TrackingPath = process name without .exe)
```

If a directory is not trackable (does not exist) or `proc == null`, `InvokeOnStopped(new GameStoppedEventArgs())` is raised immediately (session length 0).

### 1.4 The polling loop `StartTracking` (`GenericGameController.cs:668-775`)

```csharp
public void StartTracking(Func<bool> trackingAction, Func<int> startupCheck = null, Action<int> gameStartedAction = null,
                          Action gameStoppedAction = null, int trackingFrequency = 2000, int trackingStartDelay = 0)
{
    ...
    Task.Run(async () =>
    {
        ulong playTimeMs = 0; var trackingWatch = new Stopwatch(); var maxFailCount = 5; var failCount = 0;
        if (trackingStartDelay > 0) await Task.Delay(trackingStartDelay, ...);
        if (startupCheck != null)
        {
            while (true)   // phase 1: wait until the game process appears (no timeout; only 5 consecutive exceptions abort with SessionLength 0)
            {
                ... var id = startupCheck(); if (id > 0) { gameStartedAction?.Invoke(id); InvokeOnStarted(new GameStartedEventArgs { StartedProcessId = id }); break; }
                await Task.Delay(trackingFrequency, ...);
            }
        }
        while (true)       // phase 2: poll until the tracked thing disappears
        {
            failCount = 0;  // (note: reset every iteration, so the maxFailCount guard in this loop never triggers)
            try { trackingWatch.Restart(); if (!trackingAction()) { gameStoppedAction?.Invoke(); InvokeOnStopped(new GameStoppedEventArgs(playTimeMs / 1000)); return; } }
            catch (Exception e) { failCount++; ... }
            await Task.Delay(trackingFrequency, ...);
            trackingWatch.Stop();
            if (trackingWatch.ElapsedMilliseconds > (trackingFrequency + 30_000))
            {   // This is for cases where system is put into sleep or hibernation.
                continue;
            }
            playTimeMs += (ulong)trackingWatch.ElapsedMilliseconds;
        }
    });
}
```

Key numbers: poll interval 2000 ms (overridable per action), startup delay 0, no startup timeout, session length = sum of poll-iteration wall times (seconds, truncated), iterations longer than `frequency + 30 s` are discarded (sleep/hibernate guard).

### 1.5 Monitor primitives (`source/Playnite/Common/ProcessMonitor.cs`)

| Class | Lines | How it decides "running" |
|---|---|---|
| `MonitorProcess` | 14-27 | `!process.HasExited` of the started process only |
| `MonitorProcessTree` | 29-65 | Keeps a list of related PIDs seeded with the started PID; every poll enumerates `Process.GetProcesses().Where(a => a.SessionId != 0)`, adds any process whose parent PID (`TryGetParentId`) is in the list, then replaces the list with the subset still alive; running while list non-empty. Handles launchers that spawn the real game and exit. Parent PIDs can be recycled - Playnite accepts that. |
| `MonitorProcessNames` | 67-117 | Collects `*.exe` names (recursively) under the directory at construction; running if any session!=0 process has that main-module file name (or, if the path cannot be read, that `ProcessName`). Returns the PID. |
| `MonitorDirectory` | 119-165 | Resolves the directory with `Paths.GetFinalPathName` (junction/symlink target), appends a trailing separator ("so we wrongly don't match similar paths, like tracking c:\Fallout would match c:\Fallout 2\ as well otherwise"), running if any session!=0 process main-module path `StartsWith(dir, OrdinalIgnoreCase)`. `IsTrackable()` = directory exists. |
| `MonitorProcessName` | 168-197 | running if any session!=0 process has `ProcessName == name` (name without extension). |

Helpers: `TryGetMainModuleFileName` = `OpenProcess(QueryLimitedInformation)` + `QueryFullProcessImageName` (works for 64-bit targets from a 32-bit app, elevated processes return false) (`source/Playnite/Common/Extensions/ProcessExtensions.cs:16-37`); `TryGetParentId` = `NtQueryInformationProcess(ProcessBasicInformation).InheritedFromUniqueProcessId` (39-64); `Paths.GetFinalPathName` = `CreateFile(…, FILE_FLAG_BACKUP_SEMANTICS)` + `GetFinalPathNameByHandle`, stripping `\\?\` / `\\?\UNC\` (`source/Playnite/Common/Paths.cs:19-62`).

### 1.6 The legacy `ProcessMonitor` class used by the store plugins (Playnite @ 39e7ff0 `source/Playnite/Common/ProcessMonitor.cs`)

Steam, Xbox, Battle.net, Ubisoft, Rockstar and the removed Origin plugin own their `PlayController` and call this class:

- `WatchDirectoryProcesses(string directory, bool alreadyRunning, bool byProcessNames = false, int trackingDelay = 2000)` (61-83): resolves the real path (`Paths.GetFinalPathName`), then `WatchDirectory` (255-320) or `WatchDirectoryByProcessNames` (172-253).
- `WatchDirectory`: every `trackingDelay` ms, enumerate session!=0 processes; a process matches if `procPath.IndexOf(directory, OrdinalIgnoreCase) >= 0` (substring, NO trailing separator - so `C:\Games\Fallout` also matches `C:\Games\Fallout 2\…`). On first match (unless `alreadyRunning`) raises `TreeStarted{StartedId}`; once a match was seen and then no process matches -> `TreeDestroyed`. 5 consecutive enumeration exceptions -> `TreeDestroyed`. No startup timeout.
- `WatchDirectoryByProcessNames`: same loop but matches by exe file names found under the directory (`*.exe`, recursive); throws if no exe found. `IsWatchableByProcessNames(dir)` (156-170) = at least one exe under dir.
- `WatchProcess(Process)` (322-372): process-tree walk like `MonitorProcessTree`, polling every 500 ms. `WatchUwpApp(familyName, alreadyRunning)` (91-154): regex `familyName.Replace("_", "_.+__")` against process paths, 2000 ms poll (currently unused: "TODO switch to WatchUwpApp once we are building as 64bit app", `XboxGameController.cs:157`).
- Plugins compute `SessionLength` themselves as a `Stopwatch` started in `TreeStarted` and stopped in `TreeDestroyed` (e.g. `SteamGameController.cs:206-216`).

### 1.7 Play-time and state bookkeeping (`source/Playnite/GamesEditor.cs`)

- `Controllers_Started` (1370-1419): `UpdateGameState(running:true, launching:false)` which sets `IsRunning`, `LastActivity = DateTime.Now`, `PlayCount += 1`, and moves `CompletionStatus` from default/empty to the configured "Played" status (1352-1365); records `gameStartups[game.Id] = DateTime.Now`; runs game-started scripts; in fullscreen mutes music and optionally minimizes.
- `Controllers_Stopped` (1421-1566): `dbGame.Playtime += args.SessionLength` (seconds, `ulong`), `IsRunning = IsLaunching = false`, restores the window after `Thread.Sleep(1000)` (1459-1463), restores HDR, runs post-scripts, and schedules **client auto-shutdown**: skipped if `SessionLength <= ClientAutoShutdown.MinimalSessionTime` or another game of the same plugin is running/installing; otherwise after `GraceTimeout` seconds calls `plugin.Client.Shutdown()` (1498-1564; the job is cancelled if a game of that plugin starts again, 333-338).
- `CancelGameMonitoring` (1275-1313): when the user cancels tracking, `Playtime += (Now - startupTime)` wall-clock seconds.
- Plugins' own `Playtime` (seconds) from account APIs are only written on import (`GameMetadata.Playtime`) - the core never mixes them with tracked sessions except through the import merge rules of each plugin.

### 1.8 Fullscreen-mode controller mapping (SDL2 game controller API, not raw XInput)

Playnite initializes SDL2 (`source/Playnite.FullscreenApp/FullscreenApplication.cs:282-304`): `SDL_Init(SDL_INIT_GAMECONTROLLER | SDL_INIT_AUDIO)`, loads `gamecontrollerdb.txt` (shipped from `source/Playnite/gamecontrollerdb.txt`, csproj line 36), sets `SDL_SetHint(SDL_HINT_JOYSTICK_RAWINPUT, "0")` ("should fix some random XInput controller issues", SDL issue 13047 / Playnite issue 3794), `SDL_GameControllerEventState(SDL_IGNORE)`, and runs its own thread that calls `SDL_PollEvent` for `SDL_CONTROLLERDEVICEADDED/REMOVED`, then `GameController.ProcessInputs()` and `Thread.Sleep(16)` (~60 Hz) (307-347). Desktop mode does the same when `EnableGameControllerSupport` is on (`DesktopApplication.cs:387-424`).

`source/Playnite/Input/GameController.cs`:

- Buttons polled with `SDL_GameControllerGetButton` (A, B, Back, Guide, LeftShoulder, LeftStick, RightShoulder, RightStick, Start, X, Y, DPad*) and axes with `SDL_GameControllerGetAxis` (320-365). Axis -> digital: triggers pressed when `> 16383`; sticks pressed when `> 16383` (positive direction) / `< -16383` (negative) (478-498).
- Key repeat only for navigation inputs (D-pad, sticks, triggers): first repeat after `resendDelay = 700` ms, then every `resendRate = 80` ms (92-93, 383-423). Non-navigation buttons fire once per press.
- Every input is injected as a WPF `GameControllerInputEventArgs` (KeyDown/KeyUp routed events) and, for navigation keys, additionally as a real `WM_KEYDOWN/WM_KEYUP` to the active window (536-589). Keyboard map (95-122): A -> `VK_RETURN`; D-pad and left stick -> `VK_UP/DOWN/LEFT/RIGHT`; TriggerLeft -> `VK_PRIOR` (Page Up); TriggerRight -> `VK_NEXT` (Page Down); B, X, Y, Start, Back, Guide, shoulders, stick clicks, right stick -> none (0).
- Confirm/Cancel are `A`/`B` by default and swapped by `Fullscreen.SwapConfirmCancelButtons` (`FullscreenApplication.cs:376-380`).

Fullscreen bindings (what each button does):

| Context | Button | Action | Source |
|---|---|---|---|
| Game list | Start | Open game menu | `Controls/Views/Main.cs:165` |
| Game list | Confirm (A) | Toggle game details; if `SwapStartDetailsAction` then Play/Install | `Main.cs:166-167` |
| Game list | X | Play/Install ("ActivateSelected"); if swapped then details | `Main.cs:166-167` |
| Main view | LB / RB | Previous / next filter view | `Main.cs:248-249` |
| Main view | Y | Open search | `Main.cs:250` |
| Main view | Right stick click | Toggle filters panel | `Main.cs:251` |
| Main view | Back (View) | Open main menu | `Main.cs:252` |
| Main view | Left stick click | Select filter preset | `Main.cs:253` |
| Game details | LB / RB | Previous / next game; Cancel (B) closes details | `Controls/Views/GameDetails.cs:112-117` |
| Any dialog window | Cancel (B) | Close/decline | `Windows/*.xaml` line ~21-22 |
| Multi-select dialog | Y toggle item, Start confirm | | `Windows/MultiItemSelectionWindow.xaml:20-22` |
| On-screen keyboard | Y space, X backspace, Start confirm, LB clear text, Right stick click toggle caps | | `Windows/TextInputWindow.xaml:20-25` |
| Global | Guide (released) | Restore/focus Playnite window when `GuideButtonFocus` is on (optionally only when no game is running) | `ViewModels/FullscreenAppViewModel.cs:431-441` |
| Keyboard | F1 main menu, F2/F3 filter views, F6 random game, Y search, F filters, F11 switch to desktop, R filter preset, Ctrl+Shift+P PowerShell console; list: Enter = activate, A/X = details/menu (swap-aware) | | `Main.cs:162-164, 238-246` |

Navigation (D-pad/stick/triggers) itself is handled by WPF keyboard navigation through the simulated arrow/page keys.

---

## 2. Built-in emulator database (`source/Playnite/Emulation`, loader `source/Playnite/Emulators`)

Files: `Emulation/Platforms.yaml` (96 platforms), `Emulation/Regions.yaml` (23 regions), `Emulation/Emulators/<DirName>/emulator.yaml` (95 definitions, 567 profiles in total; RetroArch alone has 156, BizHawk, ares, Mednafen, higan, jgenesis, Mesen, PCSX2 are the other multi-profile ones). `startGame.ps1`/`importGames.ps1` may sit next to an `emulator.yaml` (`Emulation.cs:21-22, 240-247`); currently only `importGames.ps1` exists for Azahar, KytyPS5, RPCS3, ScummVM, Vita3K and shadPS4 (profiles with `ScriptGameImport: true`). No definition currently uses `ScriptStartup`.

Loading (`source/Playnite/Emulators/Emulation.cs`): `Platforms` = `Serialization.FromYamlFile<List<EmulatedPlatform>>(<ProgramPath>\Emulation\Platforms.yaml)` (47-77); `Definitions` = for each directory under `Emulation\Emulators`, `FromYamlFile<EmulatorDefinition>(dir\emulator.yaml)` with `DirectoryName = dir name` (131-172). Lookup by `Id` (`GetDefition`), profile by `Name` (`GetProfile`).

Schema (`source/PlayniteSDK/Models/Emulator.cs`):

```yaml
# emulator.yaml  (EmulatorDefinition, lines 72-101)
Id: dolphin            # stable id referenced by Platforms.yaml Emulators[] and by Emulator.BuiltInConfigId in the user DB
Name: Dolphin
Website: 'https://dolphin-emu.org/'
Profiles:              # EmulatorDefinitionProfile, lines 15-67
  - Name: Nintendo GameCube            # unique within the emulator; stored in BuiltInEmulatorProfile.BuiltInProfileName
    StartupArguments: '--exec="{ImagePath}" --batch'   # expanded with Game.ExpandVariables (ImagePath/ImageName/ImageNameNoExt/ImageDir/EmulatorDir/InstallDir...)
    Platforms: [nintendo_gamecube]     # Platforms.yaml Ids this profile can run
    ImageExtensions: [elf, dol, gcm, tgc, ciso, gcz, iso, wad, dff, rvz, m3u]   # ROM extensions (no dot, lower-case); used by the ROM scanner and the emulator wizard
    StartupExecutable: ^Dolphin\.exe$  # .NET regex (IgnoreCase) matched against the FILE NAME, used both for auto-detect and to find the exe at launch
    # optional:
    InstallationFile: <regex>          # alternative detection regex (defaults to StartupExecutable) - Scanner.cs:81-85
    ProfileFiles: ['cores\\dolphin_libretro.dll']  # files that must exist relative to the detected exe's directory for the profile to be offered (RetroArch cores) - Scanner.cs:96-106
    ScriptStartup: true                # launch via startGame.ps1 instead of exe+args
    ScriptGameImport: true             # ROM import via importGames.ps1 instead of extension scan
```

```yaml
# Platforms.yaml entry (EmulatedPlatform, lines 164-217)
- Name: Nintendo GameCube
  Id: nintendo_gamecube        # Playnite "specification id"; also used by store plugins as MetadataSpecProperty("pc_windows")
  IgdbId: 21                   # IGDB platform id (optional)
  Databases: [Nintendo - GameCube]   # libretro-database DAT names used for ROM identification (CRC/serial/name lookups via EmulationDatabase.cs, SQLite files <name>.db)
  Emulators: [dolphin, retroarch]    # emulator Ids that support it
# Regions.yaml entry (EmulatedRegion, lines 106-159)
- Id: usa
  Name: USA
  Codes: [U, NA, USA, US]      # region codes parsed from ROM names like "(USA)"
  DefaultImport: true          # import by default in the ROM scanner
  IgdbId: 2
```

Detection by executable:

- Auto-detect ("scan folder for emulators", `source/Playnite/Emulators/Scanner.cs:60-140`): walk every file under the chosen folder; for each definition/profile take `InstallationFile` (else `StartupExecutable`) as regex, match against `file.Name` (IgnoreCase); if `ProfileFiles` is set, every listed file must exist relative to the file's directory; an emulator entry is created per `definition.Id + directory`, `InstallDir = that directory` (or `{PlayniteDir}`-relative when inside Playnite), one profile per matching definition profile.
- At launch (`Emulation.GetExecutable`, `Emulation.cs:206-237`): enumerate all files under `Emulator.InstallDir` recursively, return the first whose file name matches the profile's `StartupExecutable` regex. Built-in profiles are then started with `TrackingMode.Process` (process tree), custom profiles with their own `TrackingMode`/`TrackingPath` (`GenericGameController.cs:149, 212, 265-319`).

RetroArch core mapping: every RetroArch profile has `StartupArguments: '-L ".\cores\<core>_libretro.dll" "{ImagePath}"'`, `ProfileFiles: ['cores\<core>_libretro.dll']`, `StartupExecutable: ^retroarch\.exe$`; see `retroarch-cores.md` for the full 156-row table (profile name -> core DLL -> platforms -> extensions). Other examples (verbatim from the yaml): PCSX2 `'-fullscreen -slowboot -- {ImagePath}'` with `^pcsx2-qt\.exe$`; DuckStation `'-batch -fullscreen "{ImagePath}"'` with `^duckstation-qt-x64-ReleaseLTCG\.exe$`; Cemu `'-g "{ImagePath}" -f'` with `^cemu.*\.exe$`; MAME `'{ImageNameNoExt}'` with `ImageExtensions: [zip]`; Ryujinx `'--fullscreen "{ImagePath}"'`; ScummVM `'-f {ImageName}'` + `ScriptGameImport: true`; Mesen `'/fullscreen "{ImagePath}"'`; ares `'--system "Nintendo 64" "{ImagePath}" --fullscreen'`; BizHawk `'"{ImagePath}" --fullscreen'` with `^EmuHawk\.exe$`.

User-side model (same file): `Emulator { Id, Name, InstallDir, BuiltInConfigId, BuiltinProfiles[BuiltInEmulatorProfile{BuiltInProfileName, OverrideDefaultArgs, CustomArguments, Pre/Post/ExitScript}], CustomProfiles[CustomEmulatorProfile{Executable, Arguments, WorkingDirectory, Platforms(Guid), ImageExtensions, TrackingMode, TrackingPath, StartupScript, Pre/Post/ExitScript}] }`.

---

## 3. Manual/.exe import ("Add game > Scan folder / Installed / Windows Store")

`source/Playnite/Common/Programs.cs:52-78`:

```csharp
private static readonly string[] scanFileExclusionMasks = new string[]
{
    "uninst", "setup", @"unins\d+", "Config", "DXSETUP", @"vc_redist\.x64", @"vc_redist\.x86",
    @"^notification_helper\.exe$", @"^python\.exe$", @"^pythonw\.exe$", @"^zsync\.exe$", @"^zsyncmake\.exe$",
    "update", "vcredist", "crashhandler", "crashreport", "helper",
};
public static bool IsFileScanExcluded(string path) => scanFileExclusionMasks.Any(a => Regex.IsMatch(path, a, RegexOptions.IgnoreCase));
```

(The regexes are unanchored substring matches on the FILE NAME, case-insensitive; e.g. `Config` also drops `GameConfigurator.exe`, `update` drops `Updater.exe`, `helper` drops `CrashHelper.exe`.)

- Scan folder (`Programs2.cs:20-59`, called from `InstalledGamesViewModel.ScanFolder` with `SearchOption.AllDirectories`): every non-directory file whose name is not excluded and whose extension is `.exe`, `.lnk` or `.bat` becomes a candidate. **There is no "main executable" ranking** - all candidates are listed, pre-selected = none, user ticks the ones to import.
- Candidate data (`Programs2.cs:61-130`): `.exe` -> `Name = FileVersionInfo.ProductName` (trimmed) else the parent folder name; `Path = exe`, `WorkDir = exe dir`, `Icon = exe` (icon extracted later with `IconExtractor.ExtractMainIconFromFile`), `AppId = MD5(path)`. `.lnk` -> read with WScript `IWshShortcut`; `LnkImportMode.Direct` keeps the .lnk as `Path`, `Target` uses `TargetPath`/`Arguments`/`WorkingDirectory`; icon `"<path>,<index>"` parsed; `Name = shortcut file name`. `.bat` -> `Name = file name`.
- "Installed programs" (`Programs2.cs:157-270`): enumerates `*.lnk` under `%ProgramData%\Microsoft\Windows\Start Menu\Programs` and `%AppData%\Microsoft\Windows\Start Menu\Programs`; skips shortcuts whose path contains `\Accessibility\`, `\Accessories\`, `\Administrative Tools\`, `\Maintenance\`, `\StartUp\`, `\Windows ` or `\Microsoft ` (folder exceptions), targets containing `\system32\` or `\windows\`, excluded names, duplicate targets and non-`.exe` targets.
- UWP (`Programs2.cs:299-409`): `PackageManager.FindPackagesForUser(currentUserSid)`; skip `IsFramework`, `IsResourcePackage`, `SignatureKind != Store`, no `InstalledLocation`; parse `AppxManifest.xml` (or `AppxMetadata\AppxBundleManifest.xml` for bundles): first `Applications/Application[@Id]`, `VisualElements` logo attribute in order `Square150x150Logo`, `Square70x70Logo`, `Square44x44Logo`, `Logo`; the logo path is resolved to an existing file or the highest `<name>.scale-<n>.png` (272-297); `DisplayName` (`ms-resource:` resolved via `SHLoadIndirectString`, else `Identity@Name`); result `Program { Name = NormalizeGameName(name), WorkDir = package.InstalledLocation.Path, Path = "explorer.exe", Arguments = $"shell:AppsFolder\\{FamilyName}!{appId}", Icon = iconPath, AppId = FamilyName }`.
- Import (`source/Playnite.DesktopApp/ViewModels/InstalledGamesViewModel.cs:301-359`): `GameMetadata { Name = RemoveTrademarks(name), GameId = AppId, InstallDirectory = WorkDir, IsInstalled = true, Platforms = [pc_windows], Source = "Microsoft Store" for UWP }`, play action `GameAction { Type = File, Path = exe path with WorkDir replaced by {InstallDir}, Arguments, WorkingDir = {InstallDir} (null for .lnk, empty for UWP) }`, icon converted to PNG. Already-imported candidates are hidden by comparing `Path + Arguments` against `database.GetImportedExeFiles()` (497-506).

---

## 4. Store libraries (PlayniteExtensions Codeberg main10 @ f008798 unless noted)

All plugins share these conventions: `Programs.GetUnistallProgramsList()` = all subkeys of `HKLM` and `HKCU` `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall` read through BOTH `RegistryView.Registry64` and `Registry32` on 64-bit Windows (so `WOW6432Node` is covered) with values `DisplayIcon, DisplayName, DisplayVersion, InstallLocation, Publisher, UninstallString, URLInfoAbout, Path` and the key name as `RegistryKeyName` (`Programs.cs:94-159`). Import merge rule (identical in every plugin's `GetGames`): installed games first; account games (if connected) only add `Playtime`/`LastActivity` (and sometimes `Name`) to installed entries and append uninstalled ones when `ImportUninstalledGames`. Game names are passed through `RemoveTrademarks()`; `Platforms = [MetadataSpecProperty("pc_windows")]`.

### 4.1 Steam (`SteamLibrary`, plugin id `CB91DFC9-B977-43BF-8E70-55F46E410FAB`, version 2.44)

(a) Client path (`Steam.cs:30-44`): `HKCU\Software\Valve\Steam` value `SteamPath` (forward slashes replaced by `\`); `steam.exe` = `<SteamPath>\steam.exe`; installed = directory exists. Also `ModInstallPath` and `SourceModInstallPath` values of the same key (46-76). Verified here: `SteamPath = c:/program files (x86)/steam`, `SourceModInstallPath = C:\Program Files (x86)\Steam\steamapps\sourcemods` (`HKLM\SOFTWARE\WOW6432Node\Valve\Steam\InstallPath` also exists but Playnite does not read it).

(b) Enumeration (`Services/SteamLocalService.cs`):

- Library folders (316-375): set = `{SteamPath}` ∪ entries of `<SteamPath>\steamapps\libraryfolders.vdf` (Valve text KeyValue/VDF, parsed with SteamKit2 `KeyValue.ReadAsText`): for each child whose name parses as an int, use its string value (old format) or its child `path` (new format); keep only existing directories. Verified sample on this PC: `"libraryfolders" { "0" { "path" "C:\\Program Files (x86)\\Steam" "label" "" "contentid" … "apps" { "2620" "954204780" … } } }`.
- Per library: `Directory.GetFiles(<lib>\steamapps, "appmanifest*")`, skipping names ending in `tmp` (129-164). Each ACF is VDF text with root `AppState`; fields read (72-127): `StateFlags` (must parse as the flags enum and contain `FullyInstalled = 4`, else skipped), `name` (fallback `UserConfig/name`; `NormalizeGameName`), `appID` (-> SteamKit `GameID`), `installDir` -> `<lib>\steamapps\common\<installDir>`, fallback `<lib>\steamapps\music\<installDir>`, else empty. Entries with empty install dir or containing `steamapps\music` are skipped ("not properly installed or it's a soundtrack"). App id `228980` (Steamworks Common Redistributables) is skipped (259-263). Duplicates across libraries: first wins. `AppStateFlags` (378-402): Invalid=0, Uninstalled=1, UpdateRequired=2, FullyInstalled=4, Encrypted=8, Locked=16, FilesMissing=32, AppRunning=64, FilesCorrupt=128, UpdateRunning=256, UpdatePaused=512, UpdateStarted=1024, Uninstalling=2048, BackupRunning=4096, Reconfiguring=65536, Validating=131072, AddingFiles=262144, Preallocating=524288, Downloading=1048576, Staging=2097152, Committing=4194304, UpdateStopping=8388608. Verified ACF sample: `"AppState" { "appid" "1030840" "name" "Mafia: Definitive Edition" "StateFlags" "4" "installdir" "Mafia Definitive Edition" "lastupdated" … "LastPlayed" "1785354716" "SizeOnDisk" … "InstalledDepots" {…} }` (ACF also carries `LastPlayed`/`SizeOnDisk`, which Playnite ignores).
- Mods (166-243, `ModInfo.cs`): GoldSrc mods = subfolders of `ModInstallPath` not starting with `bshift, cstrike, czero, dmc, dod, gearbox, ricochet, tfc, valve` containing `liblist.gam` (key/value lines `game "…"`, `developer`, `manual`, `type`, `icon`, `url_info`, `url_dl`); Source mods = subfolders of `SourceModInstallPath` containing `gameinfo.txt` (VDF; `FileSystem/SteamAppId`, `game`, `developer`, `manual`, `developer_url`, `type`, `icon`). `GameID = {AppID = 70 (HL) or SteamAppId, AppType = GameMod, ModID = CRC32(folderName without extension) | 0x80000000}`; icon = `<icon>_big.tga`, `<icon>.tga`, `game.tga`, `game.ico` (`ModInfo.cs:245-281`).
- `GameId` stored by Playnite = decimal 64-bit SteamKit `GameID` (plain app id for normal apps; for mods/shortcuts the packed value with the type/mod bits - SteamKit layout AppID bits 0-23, type bits 24-31, mod id bits 32-63, **UNVERIFIED here**, taken from SteamKit2).

(c) Actions (`SteamGameController.cs`): play = `steam.exe -silent "steam://rungameid/{GameId}"`, or `steam.exe -silent "steam://launch/{GameId}/Dialog"` when the "show Steam launch menu" setting is on (default: on in desktop mode, off in fullscreen; `SteamLibrarySettingsViewModel.cs:49-50`) (180-191); install `steam://install/{AppID}`, uninstall `steam://uninstall/{AppID}` (not for mods), both polled by re-reading the ACFs every 10 s / 5 s (29-136). Client: open `steam.exe`, shutdown `steam.exe -shutdown` (`SteamClient.cs:20-35`), friends `steam://open/friends`.

(d) Play time: ONLY from the account services (`SteamServiceAggregator.cs:97-142`): `playtime_forever + playtime_disconnected` minutes × 60 and `last_playtime` from `GetClientLastPlayedTimes` (web token or API key). Local last-played reader `GetGamesLastActivity` (`SteamLocalService.cs:18-70`: `<SteamPath>\userdata\<AccountID>\config\localconfig.vdf` -> `Software/Valve/Steam/apps/<appid>/LastPlayed` unix seconds, mods keyed `<appId>_<modId>`) exists but is **not referenced anywhere** in this snapshot. Verified on this PC: `localconfig.vdf` contains both `"LastPlayed"` and `"Playtime"` keys under `apps` (semantics of `Playtime` UNVERIFIED - not used by Playnite).

(e) Artwork: the plugin only uses remote URLs (`SteamShared/MetadataProvider.cs:40-41, 172-239`: `https://steamcdn-a.akamaihd.net/steam/apps/{appid}/library_600x900_2x.jpg`, `header.jpg`, `library_hero.jpg`, `page_bg_generated_v6b.jpg`, `clienticon` from `https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/{appid}/{hash}.ico`, store capsule `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/{appid}/{image}`). Beyond Playnite (verified present here, not used by Playnite): Steam's own cache `<SteamPath>\appcache\librarycache\<appid>\{header.jpg, library_600x900.jpg, library_hero.jpg, library_hero_blur.jpg, logo.png, <hash>.jpg}`.

(f) Running state (`SteamGameController.cs:193-216`): legacy `ProcessMonitor.WatchDirectoryProcesses(installDirectory, false)` (2 s poll, path-substring match); for mods the base game's install dir is watched. Session = stopwatch TreeStarted -> TreeDestroyed.

Login: web view cookie/token or API key + SteamID (out of scope).

### 4.2 Epic Games Store (`EpicLibrary`, id `00000002-DBD1-46C6-B5D0-B1BA559D10E4`, version 2.34)

Two launcher generations are supported since Codeberg main10:

(a) Client:
- **V2** (`EpicLauncherV2.cs:16-31`): installed iff `%LOCALAPPDATA%\Epic Games\Launcher\EpicGamesLauncher.exe` exists; started directly.
- **Legacy** (`EpicLauncher.cs:43-71, 89-103`): Uninstall entry with `DisplayName == "Epic Games Launcher"` whose `InstallLocation` contains `Launcher\Portal\Binaries\Win32\EpicGamesLauncher.exe` (preferred, issue #1552) or `…\Win64\EpicGamesLauncher.exe`; fallbacks `C:\Program Files (x86)\Epic Games\` then `C:\Program Files\Epic Games\`. Verified here: DisplayName "Epic Games Launcher", `InstallLocation = C:\Program Files\Epic Games\`, Win64 exe present; protocol `com.epicgames.launcher` -> `"…\Win64\EpicGamesLauncher.exe" %1`. `IsInstalled = V2 || legacy` (`EpicClient.cs:18`); shutdown = `taskkill /f /pid <EpicGamesLauncher pid>`.

(b) Enumeration (`EpicLibrary.cs:38-161`):
- V2 (used whenever the V2 exe exists): `%LOCALAPPDATA%\com.epicgames.eglv2\installations.jsonl` - JSON Lines, **first line is version info and is skipped**, each other line `{ "installationId", "complete": bool, "dir", "itemId", "artifactId" }` (`Models/EpicLauncherV2.cs:8-15`). "This is actually a list of all installations, present and the past", so: group by `artifactId` (skip empty), pick the first entry with `complete == true && Directory.Exists(dir) && File.Exists(dir\.egstore\<installationId>.manifest)`. Name from `%LOCALAPPDATA%\com.epicgames.eglv2\cache\prod\catalog-cache.json` = `{ "items": { "<key>": { "item": { "id", "title", "namespace", "releaseInfo": [ { "appId" } ] } } } }` matched by `item.id == itemId`, else the install folder name. `GameId = artifactId`, `InstallDirectory = dir`.
- Legacy: `%PROGRAMDATA%\Epic\EpicGamesLauncher\Data\Manifests\*.item` (JSON, one per install; empty/invalid files are skipped) with fields `LaunchCommand, LaunchExecutable, ManifestLocation, bIsApplication, bIsExecutable, bRequiresAuth, bCanRunOffline, AppName, CatalogNamespace, CatalogItemId, AppCategories[], CompatibleApps[], DisplayName, FullAppName, InstallationGuid, InstallLocation, InstallSessionId, StagingLocation, TechnicalType, VaultThumbnailUrl, VaultTitleText, InstallSize, MainWindowProcessName, ProcessNames[], MainGameAppName, MandatoryAppFolderName` (`Models/LauncherInstalled.cs:22-50`), plus `%PROGRAMDATA%\Epic\UnrealEngineLauncher\LauncherInstalled.dat` = `{ "InstallationList": [ { "InstallLocation", "AppName", "AppID", "AppVersion" } ] }` (verified present here, empty list). Filters: skip DLC = `AppCategories` contains `addons` but not `addons/launchable`; skip UE plugins = `AppCategories` contains `plugins` or `plugins/engine`, or any `CompatibleApps` starts with `UE_`, or `TechnicalType` contains `plugins/engine`. `InstallLocation` from the .item, else from `LauncherInstalled.dat` (same `AppName`, case-insensitive); must exist. `GameId = AppName`, `Name = DisplayName` (else folder name). Duplicate manifests for one AppName: the one whose location equals the applist entry wins.

(c) Actions (`EpicLibrary.cs:332-372`, `EpicLauncher.cs:18-21`): play URL `com.epicgames.launcher://apps/{namespace}%3A{catalogItemId}%3A{appName}?action=launch&silent=true` (V2: namespace/itemId from the catalog-cache item whose `releaseInfo[].appId == GameId`; legacy: `.item` `CatalogNamespace`/`CatalogItemId`), `AutomaticPlayController { Type = Url, TrackingMode = Directory, TrackingPath = InstallDirectory }`. Install: V2 `com.epicgames.launcher://apps/{appName}?action=install`; legacy opens `com.epicgames.launcher://store/library` (the old install URL "shows the old installation dialog"). Uninstall: V2 `…?action=uninstall`, legacy library page. Watchers re-scan every 10 s / 2 s.

(d) Play time: account only (`GetPlaytimeItems` -> `totalTime` seconds, `EpicLibrary.cs:174, 224-228`); no local source.

(e) Artwork: none local; `keyImages` from the online catalog (EpicMetadataProvider). (`.item` has `VaultThumbnailUrl`, remote.)

(f) Running: core `MonitorDirectory(InstallDirectory)` via the automatic controller (2 s poll, startup wait until a process under the dir appears).

Login: OAuth through a web view, tokens in `tokens.json` (out of scope). Catalog items with `customAttributes.ThirdPartyManagedApp == "the ea app"` or `partnerLinkType == "ubisoft"` are EA/Ubisoft-managed titles (settings `ImportEAGames`/`ImportUbisoftGames`).

### 4.3 GOG / GOG Galaxy (`GogLibrary`, id `AEBE8B7C-6DC3-4A66-AF31-E7375C6B5E9E`)

(a) Client (`Gog.cs:39-64`): `HKLM\SOFTWARE\WOW6432Node\GOG.com\GalaxyClient\paths` value `client` (fallback `HKLM\SOFTWARE\GOG.com\GalaxyClient\paths`), exe `<client>\GalaxyClient.exe`; verified here `C:\Program Files (x86)\GOG Galaxy`. Running = a `GOG Galaxy Notifications Renderer` process exists (66-74). Shutdown `GalaxyClient.exe /command=shutdown` (`GogClient.cs:36`).

(b) Enumeration (`GogLibrary.cs:222-309`):
1. Uninstall entries with `RegistryKeyName` matching `^(\d+)_is1`, `Publisher == "GOG.com"`, key not starting with `GOGPACK`, `InstallLocation` exists -> `GameId = <digits>`, `Name = DisplayName`.
2. Keep only entries whose `<InstallLocation>\goggame-<gameId>.info` has at least one `playTasks[].isPrimary == true` ("Empty play task = DLC") and whose `rootGameId` is empty or equals `gameId` ("That's DLC" otherwise). Non-primary `playTasks` + `supportTasks` become extra `GameActions`.
3. Fallback from Galaxy's DB (311-352): `c:\ProgramData\GOG.com\Galaxy\storage\galaxy-2.0.db` (SQLite, opened read-only): `SELECT * FROM InstalledBaseProducts` -> `productId` (int), `installationPath`; title from `SELECT title FROM LimitedDetails WHERE productId = <id>`; same DLC filtering through `goggame-<id>.info`. Verified schema here: `InstalledBaseProducts(productId INTEGER, generation INTEGER, languageId INTEGER, installationPath TEXT, installationId INT64, buildId INT64, branch TEXT, installationDate TEXT)`, `LimitedDetails(id, productId, languageId, is_production, stored_at, title TEXT, links TEXT, images TEXT)`. Edge case seen here: Galaxy-installed modpacks (`C:\Program Files (x86)\GOG Galaxy\Games\…`) have no `goggame-*.info`, so Playnite skips them.

`goggame-<id>.info` (JSON, `Models/GogGameTaskInfo.cs:13-73`): `{ "gameId", "rootGameId", "standalone", "dependencyGameId", "language", "name", "playTasks": [ { "isPrimary", "type": "FileTask"|"URLTask", "path", "workingDir", "arguments", "link", "name" } ], "supportTasks": [ … ] }`. Conversion: `Path = Combine(installDir, FixSeparators(path))` (FileTask) or `link` (URLTask); if `workingDir` set, `WorkingDir = Combine(installDir, workingDir)` and a path that starts with it is made relative ("Fixes wrong task configuration generated by some games like Witcher 3"); `Name` defaults to "Play".

(c) Actions (`GogLibrary.cs:72-113`): default (`StartGamesUsingGalaxy = false`) = one `AutomaticPlayController { Type = File|Url, TrackingMode = Process, Path/Arguments/WorkingDir from each primary play task }`; with Galaxy: `GalaxyClient.exe /launchViaAutostart /gameId={id} /command=runGame /path="{installDir}"`, `TrackingMode = Directory, TrackingPath = installDir`. Install (`GogGameController.cs:89-167`): no Galaxy -> `https://www.gog.com/account`; `UseAutomaticGameInstalls` off (default) -> `goggalaxy://openGameView/{id}`; on -> if Galaxy running `GalaxyClient.exe /gameId={id} /command=installGame` then after 2500 ms `goggalaxy://openGameView/{id}`; if not running but `%PROGRAMDATA%\GOG.com\Galaxy\lock-files` exists, start the client and wait (FileSystemWatcher) for `GOG Galaxy Notifications Renderer.exe.lock` before sending the command. Uninstall: run `<InstallDirectory>\unins000.exe` (Inno Setup), poll 5 s.

(d) Play time: account (`stats.playtime` minutes × 60, `lastSession`, 444-473). Beyond Playnite (verified locally): `galaxy-2.0.db` table `GameTimes(userId INT64, releaseKey TEXT, minutesInGame INTEGER)` with keys like `gog_1595922314`, `epic_<id>`, `battlenet_hs_beta`, and `PlayTasks(id, gameReleaseKey, userId, order, typeId, isPrimary)` + `PlayTaskLaunchParameters(playTaskId, executablePath, commandLineArgs, label)`.

(e) Artwork: none local (`LimitedDetails.images` is a JSON column of remote URLs - content UNVERIFIED).

(f) Running: process tree (direct exe) or directory watch (Galaxy launch).

Login: web view cookies (out of scope).

### 4.4 EA app / Origin (`OriginLibrary` at 091083c - removed 2025-10-15; display name "EA app", id `85DD7072-2F20-4E76-A007-41035E390724`)

Status: Playnite's README still advertises EA app support, but the bundled plugin is gone. The official addon database now carries the community addon `Jeshibu_EaLibrary` (reusing AddonId `OriginLibrary_Builtin`), which keeps the same registry-driven install check and **also requires login** for enumeration (GraphQL `getPreloadedOwnedGames`). There is **no login-free EA enumeration anywhere in the Playnite ecosystem**; what is local is listed below.

(a) Client (`Origin.cs:29-78`, identical in Jeshibu `EaApp.cs:18-54`): `HKLM` (Registry32 view) `SOFTWARE\Origin` value `OriginPath`, else `ClientPath`. Verified here: `OriginPath` absent, `ClientPath = C:\Program Files\Electronic Arts\EA Desktop\EA Desktop\EADesktop.exe`. Additional EA keys verified: `HKLM\SOFTWARE\WOW6432Node\Electronic Arts\EA Desktop` values `InstallLocation`, `DesktopAppPath`, `LauncherAppPath (EALauncher.exe)`, `ClientPath`, `InstallSuccessful`; `HKLM\SOFTWARE\Electronic Arts\EA Desktop\InstallLocation`. Running = `EADesktop` process; shutdown `taskkill /pid <EADesktop>` (`OriginClient.cs:27-41`).

(b) Enumeration (`OriginLibrary.cs:368-420`, needs the account's offer list): for every owned `offerId` get the "local installer manifest" from `https://api1.origin.com/ecommerce2/public/{offerId}/en_US` (`Services/OriginApiClient.cs:44`; cached as `installmanifests\<offerId>.json`; 404 -> fake manifest with `offerType = "none"`), accept `offerType` `"Base Game"` or `"DEMO"` only, take `publishing.softwareList.software[softwarePlatform == "PCWIN"].fulfillmentAttributes` (`installCheckOverride`, `executePathOverride`, `installationDirectory`): `installCheckOverride` is a string like `[HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\EA Games\The Sims 4\Install Dir]Game\Bin\TS4_x64.exe` parsed with `\[(.*?)\\(.*)\\(.*)\](.*)` (74-132: hive, subkey path, value name, relative file; tried in Registry64 then Registry32) -> installed iff that file exists; install dir = play action working dir, else the file's directory (341-366). Name = `localizableAttributes.displayName ?? i18n.displayName ?? itemName`.
Local-only pieces (no login): `__Installer\installerdata.xml` next to the game files (found by walking up to 4 parent levels from `executePathOverride`, 141-181): XML root `DiPManifest`, `runtime/launcher[]` with `filePath` (same `[HKEY…]relative` syntax or a URL), `parameters`, `executeElevated`, `requires64BitOS`, `trial` (`Models/GameInstallerData.cs`); launcher choice = first non-trial, preferring `requires64BitOS` on 64-bit OS (223-282). EasyAntiCheat: `<dir>\EasyAntiCheat\Launcher\Settings.json` `{ title, executable, parameters, use_cmdline_parameters ("1"), working_directory }` (`EAC.cs:12-33`). "Requires Origin" heuristic = any `Activation.*` file under the install dir (`Origin.cs:87-96`). Observed on this PC (EA app installed, no game installed): `C:\ProgramData\EA Desktop\InstallData\<Game Name>\base-<guid>\map.eacrc` and `dlc-<guid>\map.eacrc` (binary file lists, format UNVERIFIED), encrypted stores `C:\ProgramData\EA Desktop\530c1147…\IS` and `…\CATS2` (UNVERIFIED), `C:\Program Files\EA Games\` as the default game root.

(c) Actions (`OriginGameController.cs:165-237`): exe from the manifest/installerdata (or `origin2://library/open` when the manifest is fake); with EAC, start `eac.executable eac.parameters` in `eac.working_directory`; then **wait 40 s** before watching the directory if the game requires Origin or uses EAC ("game process being started/shutdown multiple times during startup via Origin"). Install/uninstall: `origin2://library/open` then poll the install-check file every 10 s / 2 s. Jeshibu addon (`EaControllerHelper.cs:23`): `origin2://game/launch/?offerIds=<contentId>` (contentId from the legacy offer), directory tracking with 2 s delay (40 s with EAC). Verified here: `origin2://` and `origin://` are handled by `EALauncher.exe "%1"`, `link2ea://` by `Link2EA.exe` (community-reported `link2ea://launchgame/<id>?platform=steam` variants: UNVERIFIED).

(d) Play time: account usage API (`total` seconds, `lastSessionEndTimeStamp`, 459-492); none local.

(e) Artwork: online only.

(f) Running: legacy `WatchDirectoryProcesses(InstallDirectory, false)` after the optional 40 s delay.

### 4.5 Battle.net (`BattleNetLibrary`, id `E3C26A3D-D695-4CB7-A769-5FF7612C7EDD`)

Full detail (client path rule, registry regexes, product.db protobuf, launch/install/uninstall commands, 35 products) is in `battlenet-products.json`. Summary:

(a) Client: Uninstall entry whose `UninstallString` contains `-uid=battle.net` -> `InstallLocation\Battle.net.exe` (`BattleNet.cs:33-56`); shutdown `Battle.net.exe --exec=shutdown`.
(b) Installed games: Uninstall entries matching `Battle\.net.*--uid=(.*?)\s` (skip `DisplayName` ending `Test`/`Beta`; uid prefix-matched to the table's `InternalId`, e.g. `wow_enus` -> `wow`; `InstallLocation` must exist), classic games by `Publisher == "Blizzard Entertainment"` + `DisplayName == "Diablo II" | "Warcraft III"` + `ClassicExecutable` present; then `C:\ProgramData\Battle.net\Agent\product.db` (protobuf: root field 1 repeated `{1: uid, 2: product_code, 3: {1: install_path}}`) as fallback, exact uid match (`BattleNetLibrary.cs:63-182`).
(c) Play `Battle.net.exe --exec="launch <ProductId>"` (after making sure the client runs: start it, wait for >= 5 `Battle.net` processes + 5 s); classic: run `<InstallDirectory>\<ClassicExecutable>`. Install `Battle.net.exe --game=<InternalId>`; uninstall via the entry's `UninstallString`.
(d) Play time: none local (account import gives ownership only).
(e) Artwork: remote URLs in the static table.
(f) Running: `WatchDirectoryProcesses(InstallDirectory, false)` (classic: `alreadyRunning: true, byProcessNames: true`).

### 4.6 Ubisoft Connect / Uplay (`UplayLibrary`, id `C2F038E5-8B92-4877-91F1-DA9094155FC5`)

(a) Client (`Uplay.cs:21-73`): Uninstall entry `DisplayName == "Ubisoft Connect"` -> `InstallLocation\UbisoftConnect.exe`. Shutdown (`UplayClient.cs:26-55`): main process `upc`; if more than one `UplayWebCore` process exists `taskkill /pid <upc>` (graceful), wait 3 s, then `taskkill /f /pid <upc>`.

(b) Installed games (`UplayLibrary.cs:83-119`): `HKLM\SOFTWARE\ubisoft\Launcher\Installs\<id>` (Registry32 view first, then Registry64) value `InstallDir` (`/` -> `\`), directory must exist; `GameId = <id>` (subkey name = Uplay product id), `Name = last path segment of InstallDir`. Names/art come from the local product cache (no login needed, but the client must have run once): `%LOCALAPPDATA%\Ubisoft Game Launcher\cache\configuration\configurations` = protobuf `UplayCacheGameCollection { repeated UplayCacheGame Games = 1 }`, `UplayCacheGame { uint32 UplayId = 1; uint32 InstallId = 2; string GameInfo = 3 /* YAML */ }` (`Models/LocalCache.cs`). `GameInfo` YAML (`Models/ProductSchema.cs`): `version`, `root: { name, background_image, thumb_image, logo_image, dialog_image, icon_image, third_party_platform{name}, sort_string, uplay{game_code,…}, addons[{id, is_visible, name, description, thumb_image}], is_ulc, is_visible, start_game: { online: { executables: [ { path: { relative }, working_directory: { register, append }, internal_name, description, shortcut_name } ], … }, offline: {…} } }`, `localizations: { default: { <key>: <text> } }` - `root.name` and image keys are localization keys resolved through `localizations.default`; images are prefixed with `https://ubistatic3-a.akamaihd.net/orbit/uplay_launcher_3_0/assets/` (`Uplay.cs:93-185`). Filters for library entries (`UplayLibrary.cs:31-81`): skip `third_party_platform != null`, skip `is_ulc` (DLC) and any id listed in another product's `addons`, skip `start_game == null`. Requires-client heuristic: files `uplay_*_loader*` or `upc_*_loader*` anywhere under the install dir (`Uplay.cs:78-86`).

(c) Actions (`UplayGameController.cs`): play `uplay://launch/{id}` (URL); if the game requires the client, poll every 5 s until a process matching `UbisoftGameLauncher` runs, then `WatchDirectoryProcesses(dir, false, false, trackingDelay = 10000 if GameId == "635" /* Rainbow Six Siege */ else 2000)`; otherwise `WatchDirectoryProcesses(dir, false)`. Install `uplay://install/{id}`, uninstall `uplay://uninstall/{id}` (poll registry every 10 s / 2 s).

(d) Play time: none (this plugin has no account play-time import at all).
(e) Artwork: cache URLs (remote); fallback icon = Uninstall entry `RegistryKeyName == "Uplay Install <id>"` `DisplayIcon` if the file exists (`UplayMetadataProvider.cs:54-61`).
(f) Running: legacy directory watch.

### 4.7 Xbox / Microsoft Store / Game Pass (`XboxLibrary`, id `7e4fbb5e-2ae3-48d4-8ba0-6b30e7a4e287`)

(a) Client: none to locate; Xbox app presence = UWP package family `Microsoft.GamingApp_8wekyb3d8bbwe` found via `Programs.GetUWPApps()` (`Xbox.cs:14-38`); "open client" = Xbox app (if `XboxAppClientPriorityLaunch`, default false) else `ms-windows-store://`.

(b) Enumeration (`XboxLibrary.cs:173-342`): `ConnectAccount` must be on, otherwise the plugin returns nothing. Installed = `Programs.GetUWPApps()` (section 3) matched by `PackageFamilyName` (`Program.AppId`) against account titles (`pfn`, `type == "Game"`, `devices` contains `"PC"`); unknown PFNs are looked up online (`GetTitleInfo(pfn)`) and cached in `<plugin data>\PfnInfoCache\<pfn>.json`; `InstallDirectory = Paths.GetFinalPathName(package.InstalledLocation.Path)`, `Icon = MetadataFile(local logo png)`, `GameId = pfn`, console-only titles get `GameId = CONSOLE_<titleId>_<mediaItemType>` and no actions. Name clean-up removes `(PC)`, `(Windows)`, `for Windows 10`, `- Windows 10`.

(c) Actions (`XboxGameController.cs`): play = `explorer.exe shell:AppsFolder\<PFN>!<AppId>` (from `GetUWPApps`); install `ms-windows-store://pdp/?PFN={pfn}` (or open the Xbox app); uninstall opens `ms-settings:appsfeatures`; watchers poll `GetUWPApps()` every 10 s.

(d) Play time: account only (`minutesPlayed × 60`, `titleHistory.lastTimePlayed`).
(e) Artwork: local package logo from `AppxManifest.xml` (see section 3); `GetUWPGameIcon` picks `<logo>.scale-<n>.png` with the highest scale.
(f) Running: `WatchDirectoryProcesses(package dir, false, false)` only if `IsWatchableByProcessNames(dir)` (an exe exists under the package dir), else stopped immediately; core generic path uses `MonitorDirectory(package dir)` for `explorer.exe shell:AppsFolder\…` actions (`GenericGameController.cs:533-563`).

Login: Xbox Live OAuth (out of scope).

### 4.8 Amazon Games (`AmazonGamesLibrary`, id `402674cd-4af6-4886-b6ec-0e695bfa0688`)

(a) Client (`AmazonGames.cs:43-56`): Uninstall entry `DisplayName == "Amazon Games"` and `UninstallString` containing `Uninstall Amazon Games.exe` -> `InstallLocation\Amazon Games.exe`; running = `Amazon Games` process; shutdown = `taskkill /pid <"Amazon Games UI" child of the main process>` (main process ignores termination), fallback `taskkill /f /pid <main>` (`AmazonGamesLibraryClient.cs:30-62`).

(b) Installed games (`AmazonGamesLibrary.cs:113-149`): SQLite `%LOCALAPPDATA%\Amazon Games\Data\Games\Sql\GameInstallInfo.sqlite`, `SELECT * FROM DbSet WHERE Installed = 1;` -> columns `Id` (string product id), `InstallDirectory`, `Installed` (int), `ProductTitle` (`Models/GameConfiguration.cs:26-32`); directory must exist; `GameId = Id`, `Name = ProductTitle`. Per game `<InstallDirectory>\fuel.json` = `{ "SchemaVersion", "Main": { "Command", "WorkingSubdirOverride", "Args": [], "AuthScopes": [], "ClientId" } }`; "requires client" = `ClientId` non-empty AND `AuthScopes` non-empty (`AmazonGames.cs:64-79`).

(c) Actions (`AmazonGamesLibrary.cs:64-111`): if the game requires the client or `StartGamesWithoutLauncher` is off (default off) -> `amazon-games://play/{Id}` (Url, `TrackingMode = Directory`, `TrackingPath = InstallDirectory`); else File = `InstallDirectory\Main.Command`, `Arguments = string.Join(" ", Args)`, `WorkingDir = InstallDirectory\WorkingSubdirOverride` (or the install dir when `Command` contains `scummvm.exe`), `TrackingMode = Directory`. Install (`AmazonGameController.cs:35-109`): start the client, wait until an `Amazon Games Services` process exists and exactly 4 `Amazon Games UI` processes exist, then `amazon-games://install/{Id}`; poll the SQLite every 10 s. Uninstall: just opens the client, polls every 2 s.

(d) Play time: none (entitlements API has no play time).
(e) Artwork: none (metadata provider only adds a PCGamingWiki link).
(f) Running: core directory watch.

### 4.9 itch.io (`ItchioLibrary`, id `00000001-EBB2-4EEC-ABCB-7C89937A42BB`)

(a) Client (`Itch.cs:16-116`): Uninstall entry `DisplayName == "itch"` -> `InstallLocation`; fallback `%LOCALAPPDATA%\itch` if it contains `state.json`; `state.json` = `{ "current": "<version>" }` -> exe `<install>\app-<current>\itch.exe`; `itch-setup.exe` in the install dir; `IsInstalled` = version major >= 25. butlerd: `%APPDATA%\itch\broth\butler\.chosen-version` (text) -> `%APPDATA%\itch\broth\butler\versions\<version>\butler.exe`; db `%APPDATA%\itch\db\butler.db` (`Butler.cs:110-149`).

(b) Installed games (`ItchioLibrary.cs:81-136`): start `butler.exe daemon --json --dbpath "<db>" --transport tcp --keep-alive`, read the `listen` notification (`tcp.address`, `secret`), JSON-RPC `Meta.Authenticate {secret}`, then `Fetch.Caves` -> `caves[]` `{ id, game: { id, title, coverUrl, classification, publishedAt, type, minPrice, platforms, … }, installInfo: { installFolder, installLocation, installedSize, pinned }, stats: { installedAt, lastTouchedAt, secondsRun }, upload: { id, displayName, buildId, type } }` (`Models/Cave.cs`). Filter by `game.classification` against the settings map (default imports `game` and `tool` only - `ItchioLibrarySettingsViewModel.cs:20`), one entry per game id, `installInfo.installFolder` must exist; `GameId = game.id`, `CoverImage = coverUrl` (remote), `ReleaseDate = publishedAt`. Optional `.itch.toml` manifest (`actions[] {name, path, platform, args[]}`, `prereqs[]`) parser exists (`TryGetGameActions`, 35-79) but is unused.

(c) Actions: itch >= 26.20.0 -> `AutomaticPlayController { Type = File, Path = itch-setup.exe, Arguments = "--run-game {gameId}", TrackingMode = Process }` (`ItchioLibrary.cs:360-367`); older -> butlerd `Launch {caveId}` with notifications `LaunchRunning` (started) / `LaunchExited` (stopped) and client requests `PickManifestAction` (index of chosen action, -1 cancels), `HTMLLaunch` (open `rootFolder\indexPath`), `URLLaunch`, `ShellLaunch` (`itemPath`), `PrereqsFailed` (`continue: true`) (`ItchioGameController.cs:160-272`). Install `itch://install?game_id={id}`; uninstall opens `itch://library/installed`; watchers poll `Fetch.Caves` every 10 s / 2 s.

(d) Play time: Playnite does not import any; `cave.stats.secondsRun`/`lastTouchedAt` are available locally from butlerd (semantics per butlerd docs, https://docs.itch.ovh/butlerd/master/).
(e) Artwork: `coverUrl` (remote).
(f) Running: process tree (new path) or butlerd notifications (old path).

### 4.10 Humble App / Humble Bundle (`HumbleLibrary`, id `96e8c4bc-ec5c-4c8b-87e7-18ee5a690626`)

(a) Client (`HumbleClient.cs:18-106`): registry `SOFTWARE\2f793df2-2969-529d-b0c0-7960ed40d70e` value `InstallLocation` under `HKCU` then `HKLM`, Registry32 view then Registry64 -> `<InstallLocation>\Humble App.exe`; config `%APPDATA%\Humble App\config.json`; no graceful shutdown ("Humble doesn't react properly to termination signal").

(b) Installed games (`HumbleLibrary.cs:66-121`): `config.json` -> `"game-collection-4": [ { machineName, gameName, imagePath, status, downloadedVersion, latestBuildVersion, isAvailable, lastPlayed, downloadMachineName, descriptionText, publishers[], developers[], troveCategory, downloadFilePath, filePath, executablePath, … } ]` (`Models/HumbleApp.cs:55-88, 109-119`); entries with `status == "downloaded" | "installed"`; exe = `filePath\executablePath` (older versions: `downloadFilePath\machineName\executablePath`); `InstallDirectory = dir(exe)` must exist; `GameId = machineName` (Humble App-capable ids end with `_trove` or `_collection`), `Name = gameName`. The "general library" (orders/keys) and the Trove catalog need the account (out of scope).

(c) Actions (`HumbleLibrary.cs:483-520`): `LaunchViaHumbleApp` (default true) -> `humble://launch/{machineName}` (Url, `TrackingMode = Directory`, `TrackingPath = InstallDirectory`); else File = the exe with `WorkingDir = InstallDirectory`, `TrackingMode = Directory`. Install: Humble App < 0.4.8 `humble://game/{id}`, else `humble://download/{id}`; uninstall `humble://uninstall/{id}`; watchers re-read config.json every 10 s / 2 s.

(d) Play time: none (`lastPlayed` string exists in config - semantics UNVERIFIED).
(e) Artwork: `imagePath` in config (likely remote - UNVERIFIED).
(f) Running: core directory watch.

### 4.11 Rockstar Games Launcher (`RockstarLibrary`, bonus, id `88409022-088a-4de8-805a-fdbac291f00a`)

Client: Uninstall entry `DisplayName == "Rockstar Games Launcher"` -> `InstallLocation\Launcher.exe` (`RockstarGames.cs:130-153`). Installed games (`RockstarGamesLibrary.cs:32-86`): any Uninstall entry whose `UninstallString` matches `(?:Launcher|uninstall)\.exe.+uninstall=(.+)$` -> `titleId` looked up in the static table (`gta5`->`PlayGTAV.exe`, `gta5_gen9`->`GTA5_Enhanced_BE.exe`, `rdr`->`RDR.exe`, `rdr2`->`RDR2.exe`, `lanoire`->`LANoire.exe`, `mp3`->`MaxPayne3.exe`, `lanoirevr`->`LANoireVR.exe`, `gtasa`->`gta_sa.exe`, `gta3`->`gta3.exe`, `gtavc`->`gta-vc.exe`, `bully`->`Bully.exe`, `gta4`->`GTAIV.exe`, `gta3unreal`->`Gameface/Binaries/Win64/LibertyCity.exe`, `gtavcunreal`->`…/ViceCity.exe`, `gtasaunreal`->`…/SanAndreas.exe`), `InstallDirectory = InstallLocation`, local icon = `DisplayIcon` file. Play: `Launcher.exe -launchTitleInFolder "<InstallDirectory>"` + `WatchDirectoryProcesses`; uninstall `Launcher.exe -enableFullMode -uninstall=<titleId>`.

---

## 5. License and attribution

Both repositories are MIT licensed: `LICENSE.md` = "MIT License, Copyright (c) 2020 Josef Nemec" (identical text in Playnite and PlayniteExtensions; the Codeberg fork carries the same file). Requirements: keep the copyright notice and the permission notice "in all copies or substantial portions of the Software". For GameDash: include the MIT text with "Copyright (c) 2020 Josef Nemec" in the third-party notices for any code, the emulator/platform YAML database, the Battle.net/Rockstar product tables and the exclusion lists copied from these repos. The Jeshibu addon is also MIT (its repo LICENSE - UNVERIFIED, not fetched). `gamecontrollerdb.txt` is the SDL community DB (zlib license - UNVERIFIED, not fetched). The emulator database content (names, arguments, extensions) is factual data but was copied verbatim, so attribute it too.

---

## 6. Implementation recipes for GameDash (Node.js, installed games only, no sign-in)

Common building blocks:

- `uninstallEntries()`: read `HKLM` + `HKCU` `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*` in both the 64-bit and 32-bit (`WOW6432Node`) views; capture `DisplayName, DisplayIcon, InstallLocation, Publisher, UninstallString, DisplayVersion` and the subkey name.
- `realPath(dir)`: resolve junctions/symlinks (`fs.realpathSync.native`), append a trailing `\`, compare `startsWith` case-insensitively (section 1.5).
- `processList()`: enumerate processes with full image path (e.g. `wmic`/PowerShell `Get-Process | Select Id,Path,ParentProcessId` or a native module); ignore session-0 processes.
- Session tracking (mirror `StartTracking`): poll every 2000 ms; phase 1 wait (no timeout) until the matcher finds a PID; phase 2 accumulate elapsed ms per iteration, discard iterations longer than `interval + 30 s` (sleep), stop when the matcher finds nothing; `playtime += floor(ms/1000)`; `playCount++` and `lastActivity = now` at start.
- Matchers: `tree(pid)` (parent-walk over the live process table), `dir(path)` (image path starts with real path + `\`), `names(path)` (image file name in the set of `*.exe` under path), `name(exeNameWithoutExt)`.
- Name normalization: strip ™/®/© (`RemoveTrademarks`).

### Steam
1. `root = HKCU\Software\Valve\Steam\SteamPath` (replace `/` with `\`). Not found or dir missing -> Steam absent.
2. `libs = {root} ∪ paths from root\steamapps\libraryfolders.vdf` (VDF: numeric keys -> `path` child or string value); keep existing dirs.
3. For each `lib\steamapps\appmanifest_*.acf` (skip `*.tmp`): parse VDF root `AppState`; require `(StateFlags & 4) != 0`; `name` (fallback `UserConfig.name`), `appid`, `installdir` -> `lib\steamapps\common\<installdir>` (fallback `…\music\…`, then skip); skip install dirs under `steamapps\music`; skip appid `228980`; dedupe by appid (first library wins). Optional: `LastPlayed`, `SizeOnDisk` from the ACF.
4. Mods (optional): `ModInstallPath` subfolders with `liblist.gam` (skip `bshift,cstrike,czero,dmc,dod,gearbox,ricochet,tfc,valve` prefixes) and `SourceModInstallPath` subfolders with `gameinfo.txt`.
5. Launch: `"<root>\steam.exe" -silent "steam://rungameid/<appid>"` (or `steam://launch/<appid>/Dialog` to show Steam's launch-option menu). Install/uninstall: `steam://install/<appid>` / `steam://uninstall/<appid>`. Client shutdown: `steam.exe -shutdown`.
6. Track: `dir(installDir)` matcher (phase-1 wait), not the launched process.
7. Art (optional, local): `<root>\appcache\librarycache\<appid>\{library_600x900.jpg, header.jpg, library_hero.jpg, logo.png}`; icon: `<root>\steam\games\<clienticon>.ico` (UNVERIFIED) or the game exe.

### Epic
1. If `%LOCALAPPDATA%\Epic Games\Launcher\EpicGamesLauncher.exe` exists -> **V2**: read `%LOCALAPPDATA%\com.epicgames.eglv2\installations.jsonl` (skip line 1), group by `artifactId`, keep the first `{complete:true, dir exists, dir\.egstore\<installationId>.manifest exists}`; title from `%LOCALAPPDATA%\com.epicgames.eglv2\cache\prod\catalog-cache.json` (`items[*].item.id == itemId` -> `item.title`, `item.namespace`, `item.releaseInfo[].appId`).
2. Else legacy: client via Uninstall `DisplayName == "Epic Games Launcher"` (`InstallLocation\Launcher\Portal\Binaries\{Win32|Win64}\EpicGamesLauncher.exe`, fallback `C:\Program Files (x86)\Epic Games\`, `C:\Program Files\Epic Games\`); manifests `%PROGRAMDATA%\Epic\EpicGamesLauncher\Data\Manifests\*.item` (JSON) + `%PROGRAMDATA%\Epic\UnrealEngineLauncher\LauncherInstalled.dat`; drop DLC (`AppCategories` has `addons` without `addons/launchable`) and UE plugins (`plugins`, `plugins/engine`, `CompatibleApps` `UE_*`, `TechnicalType` `plugins/engine`); `InstallLocation` must exist (fallback to applist); id = `AppName`, name = `DisplayName`, namespace/item = `CatalogNamespace`/`CatalogItemId`.
3. Launch URL: `com.epicgames.launcher://apps/<namespace>%3A<catalogItemId>%3A<appName>?action=launch&silent=true`; install `…://apps/<appName>?action=install` (V2 only; legacy: open `com.epicgames.launcher://store/library`); uninstall `…?action=uninstall`.
4. Track: `dir(installDir)`.
5. Play time/art: none local (`.item` `VaultThumbnailUrl` is remote).

### GOG
1. Client: `HKLM\SOFTWARE\WOW6432Node\GOG.com\GalaxyClient\paths\client` (fallback without `WOW6432Node`) -> `GalaxyClient.exe`.
2. Games: Uninstall entries with key `^(\d+)_is1`, `Publisher == "GOG.com"`, key not `GOGPACK*`, existing `InstallLocation`; then `C:\ProgramData\GOG.com\Galaxy\storage\galaxy-2.0.db` (open read-only!) `SELECT productId, installationPath FROM InstalledBaseProducts` + `SELECT title FROM LimitedDetails WHERE productId=?` for ids not yet found.
3. For each: parse `<installDir>\goggame-<id>.info`; require a `playTasks[].isPrimary == true` and (`rootGameId` empty or == id); primary task -> File (`installDir\path`, `arguments`, `workingDir`) or URL (`link`); other play/support tasks -> secondary actions.
4. Launch: run the primary task exe directly (track `tree(pid)`), or via Galaxy: `"<client>\GalaxyClient.exe" /launchViaAutostart /gameId=<id> /command=runGame /path="<installDir>"` (track `dir(installDir)`). Install: `goggalaxy://openGameView/<id>`; uninstall `<installDir>\unins000.exe`.
5. Optional local play time: `galaxy-2.0.db` `GameTimes` (`releaseKey = 'gog_<id>'`, `minutesInGame`).

### EA app
1. Client: `HKLM\SOFTWARE\WOW6432Node\Origin\ClientPath` (or `OriginPath`), else `HKLM\SOFTWARE\WOW6432Node\Electronic Arts\EA Desktop\DesktopAppPath`. Installed iff the exe exists.
2. Playnite offers no login-free enumeration. Practical local approach (mix of verified pieces + UNVERIFIED heuristics): scan candidate game roots (`C:\Program Files\EA Games\*`, `C:\Program Files (x86)\Origin Games\*`, plus any `InstallLocation` of Uninstall entries whose `Publisher` is `Electronic Arts` - all UNVERIFIED as a complete rule) for `__Installer\installerdata.xml`; parse `DiPManifest/runtime/launcher[]` (`filePath` with `[HKEY_LOCAL_MACHINE\...\<ValueName>]relative\exe.exe` syntax resolved through the registry, 64-bit then 32-bit view, else literal path or URL; pick first non-`trial`, prefer `requires64BitOS`), `parameters`; the `contentID` element (community-reported) gives the offer/content id. Installed iff the resolved exe exists; name from the folder/manifest (UNVERIFIED which element carries the title). Also detect `EasyAntiCheat\Launcher\Settings.json` and `Activation.*` to decide to wait ~40 s before tracking.
3. Launch: `origin2://game/launch/?offerIds=<contentId>` (used by the Jeshibu addon; `origin2://` is registered to `EALauncher.exe`), or the resolved exe directly (EAC games: run `EasyAntiCheat\Launcher\Settings.json` `executable` with `parameters` when `use_cmdline_parameters == "1"`). Library/install/uninstall: `origin2://library/open`.
4. Track: `dir(installDir)` with a 2 s delay (40 s when EAC/`Activation.*`).
5. Play time/art: none local.

### Battle.net
See `battlenet-products.json`: client from the Uninstall entry containing `-uid=battle.net`; games from Uninstall `UninstallString` regex `Battle\.net.*--uid=(.*?)\s` (prefix-match uid to `InternalId`, skip `*Test`/`*Beta`) plus the protobuf `C:\ProgramData\Battle.net\Agent\product.db` (`product_installs[]{uid, product_code, settings.install_path}`); launch `"<client>\Battle.net.exe" --exec="launch <ProductId>"` after ensuring the client runs; classic Diablo II / Warcraft III by exe; track `dir(installDir)`.

### Ubisoft Connect
1. Client: Uninstall `DisplayName == "Ubisoft Connect"` -> `InstallLocation\UbisoftConnect.exe`.
2. Games: `HKLM\SOFTWARE\ubisoft\Launcher\Installs\<id>\InstallDir` (32-bit view first); dir must exist; id = subkey name.
3. Names/art: decode `%LOCALAPPDATA%\Ubisoft Game Launcher\cache\configuration\configurations` (protobuf `{1: repeated {1: uint32 uplayId, 2: uint32 installId, 3: string yaml}}`), parse the YAML, resolve `root.name`/image keys through `localizations.default`, prefix images with `https://ubistatic3-a.akamaihd.net/orbit/uplay_launcher_3_0/assets/`; skip `is_ulc`, `third_party_platform`, ids in `addons`, `start_game == null`. Fallback icon: Uninstall key `Uplay Install <id>` `DisplayIcon`.
4. Launch `uplay://launch/<id>`; install `uplay://install/<id>`; uninstall `uplay://uninstall/<id>`.
5. Track: if `uplay_*_loader*`/`upc_*_loader*` exists under the dir, wait until a `UbisoftGameLauncher` process exists (poll 5 s), then `dir(installDir)` with 2 s delay (10 s for id 635); else `dir(installDir)` immediately.
6. Play time: none local.

### Xbox / Microsoft Store
1. Enumerate Store-signed, non-framework, non-resource packages for the current user (PowerShell `Get-AppxPackage` or the WinRT `PackageManager`); parse `AppxManifest.xml` (first `Application@Id`, `VisualElements` logo `Square150x150Logo > Square70x70Logo > Square44x44Logo > Logo`, resolve `.scale-<n>.png`), `DisplayName` (`ms-resource:` via `SHLoadIndirectString`).
2. Game-vs-app classification without the Xbox API is not solved by Playnite; heuristics (UNVERIFIED): presence of `MicrosoftGame.config` in the package folder, publisher `Xbox Game Studios`, or a curated PFN allow/deny list.
3. Launch: `explorer.exe shell:AppsFolder\<PackageFamilyName>!<AppId>`; install `ms-windows-store://pdp/?PFN=<pfn>`; uninstall `ms-settings:appsfeatures`.
4. Track: `dir(realPath(packageInstalledLocation))`; if no `*.exe` exists under it, fall back to a regex on process image paths `<family>_.+__<publisherid>` (Playnite's `WatchUwpApp` idea) - needs a 64-bit host to see 64-bit UWP processes.
5. Art: the local logo PNG; play time: none local.

### Amazon Games
1. Client: Uninstall `DisplayName == "Amazon Games"` with `UninstallString` containing `Uninstall Amazon Games.exe` -> `InstallLocation\Amazon Games.exe`.
2. Games: SQLite `%LOCALAPPDATA%\Amazon Games\Data\Games\Sql\GameInstallInfo.sqlite` `SELECT Id, InstallDirectory, ProductTitle FROM DbSet WHERE Installed = 1`; dir must exist; read `<InstallDirectory>\fuel.json` (`Main.Command`, `Main.Args[]`, `Main.WorkingSubdirOverride`, `Main.ClientId`, `Main.AuthScopes[]`).
3. Launch: if `ClientId && AuthScopes.length` -> `amazon-games://play/<Id>`; else run `<InstallDirectory>\<Command>` with `Args.join(" ")`, cwd `<InstallDirectory>\<WorkingSubdirOverride>` (cwd = install dir for `scummvm.exe`). Install: start the client, wait for `Amazon Games Services` + 4x `Amazon Games UI` processes, then `amazon-games://install/<Id>`.
4. Track: `dir(installDir)`. Play time/art: none local.

### itch.io
1. Client: Uninstall `DisplayName == "itch"` -> `InstallLocation`, else `%LOCALAPPDATA%\itch` if `state.json` exists; `state.json.current` -> `app-<current>\itch.exe`; require major >= 25.
2. Games: run `%APPDATA%\itch\broth\butler\versions\<.chosen-version>\butler.exe daemon --json --dbpath "%APPDATA%\itch\db\butler.db" --transport tcp --keep-alive`, parse the `listen` line (`tcp.address`, `secret`), JSON-RPC `Meta.Authenticate {secret}`, `Fetch.Caves` (page through `cursor`); keep `game.classification in {game, tool}`, `installInfo.installFolder` exists; id = `game.id`, name = `game.title`, cover = `game.coverUrl`, seconds played = `stats.secondsRun`, last played = `stats.lastTouchedAt`. (Alternative: read `butler.db` SQLite directly - UNVERIFIED schema.) Send `Meta.Shutdown` when done.
3. Launch: itch >= 26.20 -> `"<install>\itch-setup.exe" --run-game <gameId>` (track `tree(pid)`); else butlerd `Launch {caveId}` handling `PickManifestAction`/`HTMLLaunch`/`URLLaunch`/`ShellLaunch`/`PrereqsFailed`, with `LaunchRunning`/`LaunchExited` as start/stop. Install `itch://install?game_id=<id>`; uninstall `itch://library/installed`.

### Humble App
1. Client: `HKCU|HKLM\SOFTWARE\2f793df2-2969-529d-b0c0-7960ed40d70e\InstallLocation` (32-bit view first) -> `Humble App.exe`.
2. Games: `%APPDATA%\Humble App\config.json` -> `game-collection-4[]` with `status in {downloaded, installed}`; exe = `filePath\executablePath` (or `downloadFilePath\machineName\executablePath`); dir must exist; id = `machineName`, name = `gameName`, image = `imagePath`, last played = `lastPlayed` (semantics UNVERIFIED).
3. Launch: `humble://launch/<machineName>` or the exe with cwd = install dir; install `humble://download/<id>` (`humble://game/<id>` for app < 0.4.8); uninstall `humble://uninstall/<id>`.
4. Track: `dir(installDir)`.

### Manual .exe scan (from section 3)
Recursive scan for `.exe/.lnk/.bat`; drop names matching (case-insensitive, unanchored) `uninst, setup, unins\d+, Config, DXSETUP, vc_redist\.x64, vc_redist\.x86, ^notification_helper\.exe$, ^python\.exe$, ^pythonw\.exe$, ^zsync\.exe$, ^zsyncmake\.exe$, update, vcredist, crashhandler, crashreport, helper`; name = PE `ProductName` else folder name; id = MD5(path); icon = exe; cwd = exe folder; let the user pick (no automatic "main exe" choice in Playnite).

### Emulators (from section 2)
Ship `Emulators.yaml`/`Platforms.yaml`/`Regions.yaml`; auto-detect by walking a folder and matching each file name against every profile's `InstallationFile ?? StartupExecutable` regex (IgnoreCase) with `ProfileFiles` existence checks; launch = first file under the emulator dir matching `StartupExecutable`, args = profile `StartupArguments` with `{ImagePath}` etc. expanded, cwd = exe dir, track `tree(pid)`; ROM extension lists per profile are `ImageExtensions`.

---

## 7. Open questions / unverified items

- Battle.net `product.db` fields beyond `uid/product_code/settings.install_path` come from a third-party `.proto`; Playnite only reads those three.
- Steam `localconfig.vdf` `Playtime` key semantics (minutes?) and the `GameID` 64-bit bit layout (from SteamKit2) were not verified by experiment.
- Steam `appcache\librarycache` layout was verified on one PC only (one app dir).
- EA app: `map.eacrc`, the encrypted `IS`/`CATS2` stores, `installerdata.xml` `contentID`, default game roots and `link2ea://` launch URIs are unverified; no login-free enumeration exists in Playnite or the Jeshibu addon.
- Xbox game/app classification without the Xbox API is unsolved in Playnite.
- itch `butler.db` direct SQLite schema, Humble `lastPlayed`/`imagePath` semantics, GOG `LimitedDetails.images` content: not inspected (no such clients installed here).
- Licenses of `gamecontrollerdb.txt` (SDL community DB) and the Jeshibu addon were not fetched.
