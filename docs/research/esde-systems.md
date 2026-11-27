# ES-DE systems, find rules, launch semantics, gamelists, media and scrapers (Windows)

Research task `esde-systems` for GameDash. Everything below was read from the ES-DE source tree and documentation
unless marked **UNVERIFIED**. Line numbers refer to the files in the extracted tree described in section 0.

## 0. Provenance and deliverables

* Upstream: https://gitlab.com/es-de/emulationstation-de (MIT). `git clone` could not create files under the
  scratchpad because the path exceeds Win32 `MAX_PATH` (git resolves the `P:` subst drive back to the long real
  path), so the GitLab master archive was downloaded instead:
  `https://gitlab.com/es-de/emulationstation-de/-/archive/master/emulationstation-de-master.tar.gz` (77,539,486
  bytes, downloaded 2026-10-29) and extracted with MSYS tar.
* At download time the GitLab API (`/api/v4/projects/es-de%2Femulationstation-de/repository/commits/master`)
  reported master = `ef267ae693caeee89ca8ca888a38e9eab9bce90a` ("Documentation update", 2026-10-29T16:09:21+01:00,
  Leon Styhre). The tarball is the master snapshot served at the same moment; exact equality with that commit is
  **UNVERIFIED** (a GitLab archive carries no commit id).
* Version in tree: `CMakeLists.txt` line 25 `set(ES_VERSION 4.0.0-alpha)`; `es-core/src/ApplicationVersion.h`
  `PROGRAM_VERSION_STRING "4.0.0-alpha"`. `CHANGELOG.md`: 4.0.0 "in development"; last release 3.5.0 (2026-09-30).
* Extracted tree (repo root): `C:\Users\<user>\AppData\Local\Temp\<scratch>`
  (the downloaded `.tar.gz` is kept inside it). Also downloaded: TheGamesDB OpenAPI spec into
  `...\scratchpad\repos\tgdb-docs\spec.yaml` (plus `index.html`).
* Extraction scripts (PowerShell 5.1, XML/regex based, no hand editing) in
  `...\scratchpad\scripts\`: `extract-systems.ps1`, `extract-find-rules.ps1`, `extract-scraper-platforms.ps1`,
  `extract-systems-table.ps1`.
* Deliverables, all in
  `C:\Users\<user>\AppData\Local\Temp\<scratch>`:
  * `esde-systems.md` (this report)
  * `esde-systems.json` — all 195 `<system>` entries of `resources/systems/windows/es_systems.xml`, array of
    `{name, fullname, sortName, path, extensions[], commands[{label, command}], platform, theme}`.
    `sortName` is `null` for every system (the Windows file contains no `<systemsortname>` tags).
  * `esde-find-rules.json` — every `<emulator>`/`<core>` entry of `es_find_rules.xml` (key `findRules`) and of
    `es_find_rules_portable.xml` (key `findRulesPortable`), each as `{kind, name, notes[], rules[{type, entries[]}]}`
    (`notes` = the XML comments inside the entry, e.g. "Commodore Amiga emulator Amiberry"), plus
    `retroarchCoresReferencedBySystems` (core DLL -> system names), `emulatorsReferencedBySystems`
    (`%EMULATOR_X%` name -> system names), `emulatorsReferencedButWithoutFindRule` (empty) and
    `findRulesNotReferencedByAnySystem` (`PLAY!`, `STEAM`).
  * `esde-scraper-platforms.json` — `{esdePlatform: {screenscraperId, thegamesdbId, enumName, description, systems[]}}`
    for all 147 scrapeable platforms (ids are integers or `null`).
  * Bonus: `esde-systems-table.json` (the USERGUIDE "Supported game systems" table: system_name, full_name,
    default_emulator, alternative_emulators, needs_bios, recommended_game_setup; 195 rows, Markdown kept verbatim in
    cells) and `esde-systems-sorting.json` (the four bundled `resources/sorting/*/es_systems_sorting.xml` files:
    `{system: {year, manufacturer_year, hwtype_year, manufacturer_hwtype_year}}`, 196 systems).

Counts verified by script: 195 systems; 989 `<command>` elements (985 with `label`, 4 without: the single
`PLACEHOLDER %ROM%` commands of `androidapps`, `androidgames`, `lutris`, `xboxone`); 127 `<emulator>` + 1 `<core>`
(`RETROARCH`) entries in both find-rules files; 173 distinct RetroArch core DLLs referenced; 125 distinct
`%EMULATOR_…%` names referenced, all of which have a find rule.

## 1. es_systems.xml (Windows) — data model and loading rules

File: `resources/systems/windows/es_systems.xml` (installed at `C:\Program Files\ES-DE\resources\systems\windows\es_systems.xml`
or next to the portable exe). Root `<systemList>`, one `<system>` per entry; order in the file is irrelevant.

Per system (all tags except `systemsortname`, `platform`, `theme` are mandatory; a missing mandatory tag skips the entry):

| tag | meaning (SystemData::loadConfig, `es-app/src/SystemData.cpp` 812-1217) |
|---|---|
| `<name>` | short name = ROM subfolder name, gamelist folder name, media folder name. Newlines stripped. Duplicate names: first loaded wins, later ones skipped. |
| `<fullname>` | display name; default sort key (case-insensitive, lexicographic; secondary key fullname). |
| `<systemsortname>` | optional sort override (lexicographic string). Absent in all bundled Windows entries; overridable per system by `~/ES-DE/custom_systems/es_systems_sorting.xml` or the bundled sorting files when setting `SystemsSorting` = `year`, `manufacturer_year`, `hwtype_year`, `manufacturer_hwtype_year` (default `default` = fullname). |
| `<path>` | ROM directory. Always `%ROMPATH%\<name>` in the bundled file. `%ROMPATH%` -> `FileData::getROMDirectory()`; then `\`->`/`, `//`->`/`, `~` expanded. System is skipped (silently, debug log) if the directory does not exist, is not a directory, is a recursive symlink, or (Windows) has the Hidden attribute while `ShowHiddenFiles` is false. |
| `<extension>` | whitespace/comma separated (`readList` delims `" \t\r\n,"`), **case-sensitive**, each must start with a dot; the bundled file always lists both cases (`.zip .ZIP`). A bare `.` entry means "extensionless files" (used by `xbox360`: `. .iso .ISO .lnk .LNK .xex .XEX .zar .ZAR`). |
| `<command label="…">` | one or more launch commands. With >1 commands every command needs a `label`; the first command is the default emulator, the others are the "alternative emulators" selectable per system/per game by label. Duplicate labels are ignored; a missing label on a later tag stops processing of further tags. `PLACEHOLDER` (case-insensitive) anywhere in a single command marks a system whose directory is not created by "Create/update system directories" unless `CreatePlaceholderSystemDirectories=true`. |
| `<platform>` | scraper platform name(s), lower-cased, whitespace/comma separated, must match `es-app/src/PlatformId.cpp` names; unknown names log a warning; `ignore` disables scraping (not used in the Windows file). Multi-platform examples: `daphne` -> `daphne, arcade`; `lcdgames` -> `lcdgames, gameandwatch`; `doom` and others -> `pc, pcwindows`. |
| `<theme>` | theme folder name; defaults to `<name>` when missing. |

Custom overrides: `~/ES-DE/custom_systems/es_systems.xml` is parsed **before** the bundled file (`getConfigPath()`,
line 1324); because duplicate `<name>`s are skipped, a custom entry replaces the bundled one entirely (no merging).
A top-level `<loadExclusive/>` element in the custom file stops the bundled file from being loaded. Same mechanism for
`custom_systems/es_find_rules.xml` and `custom_systems/es_import_rules.xml` (per `name` attribute). Placing files under
`ES-DE/resources/...` in the app data dir overrides bundled resources file-by-file (documented but discouraged for
these three XML files).

A system only appears if, after scanning, at least one game file matched (or, with `ShowHiddenGames=false`, at least
one non-hidden game). The scan is done with `ParseGamelistOnly=false` (default); with `ParseGamelistOnly=true`
(`--gamelist-only`) nothing is scanned and only gamelist.xml entries are shown.

`--create-system-dirs` / "Create/update system directories" creates `<ROMDirectory>\<name>` for every non-placeholder
system whose `<path>` starts with `%ROMPATH%`, writes `<system dir>\systeminfo.txt` (System name / Full system name /
Supported file extensions / Launch command / Alternative launch command(s) / Platform(s) (for scraping) / Theme folder)
and `<ROMDirectory>\systems.txt` (`<dir>: <fullname>` per line, sorted).

Store/shortcut systems in the Windows file (relevant to GameDash's store integration): `steam` (`.bat .lnk .url`,
command `%HIDEWINDOW% %ESCAPESPECIALS% %RUNINBACKGROUND% %EMULATOR_OS-SHELL% /C %ROM%`, platform `steam`), `epic`
(same command, platform `pcwindows`), `desktop`, `windows`, `emulators` (`.bat .lnk`; two commands "Suspend ES-DE" and
"Keep ES-DE running" differing only by `%RUNINBACKGROUND%`), `xbox` (xemu/Cxbx-Reloaded plus "Shortcut or script"),
`xboxone` (PLACEHOLDER), `pcarcade`, `ags`, `android` (BlueStacks via `.lnk`). 13 systems carry a
`label="Shortcut or script"` alternative that runs `cmd.exe /C <file>`. Systems that keep ES-DE running in the
background via `%RUNINBACKGROUND%`: desktop, emulators, epic, fpinball, j2me, kodi, model2, steam, windows, windows3x,
windows9x. `OS-SHELL` find rule = `cmd.exe` on PATH.

## 2. es_find_rules.xml (Windows) — emulator and core discovery

Files: `resources/systems/windows/es_find_rules.xml` (installer release) and `es_find_rules_portable.xml` (portable
release; identical emulator list but only `staticpath` rules pointing at `%ESPATH%\Emulators\…` and
`%ESPATH%\..\Emulators\…`). Loader: `FindRules::loadFindRules()` (`SystemData.cpp` 43-224).

Structure: `<ruleList>` -> `<emulator name="NAME">` and `<core name="NAME">` -> `<rule type="…">` -> `<entry>` text.
`NAME` is case-sensitive and is what `%EMULATOR_NAME%`, `%PRECOMMAND_NAME%` and `%CORE_NAME%` refer to. Entries are tried
in file order within a rule; rule *types* are always processed in this fixed order regardless of file order:
`winregistrypath` -> `winregistryvalue` -> `systempath` -> `staticpath` (`FileData::findEmulator`, `FileData.cpp`
2398-2763). Counts in the Windows file: 127 `systempath`, 126 `staticpath`, 8 `winregistryvalue`, 2 `winregistrypath`,
1 `corepath`.

| rule type | semantics (Windows build) |
|---|---|
| `winregistrypath` | entry = exe file name, e.g. `retroarch.exe`. Opens `SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\<entry>` in `HKEY_CURRENT_USER`, then `HKEY_LOCAL_MACHINE` (`RegOpenKeyExW`, `KEY_QUERY_VALUE`), reads the **default value** with `RegGetValue(..., RRF_RT_REG_SZ, ...)` (1024-wchar buffer), and accepts it only if that file exists (regular file or symlink). Used by RETROARCH and one more emulator. |
| `winregistryvalue` | entry = `KEY\PATH\ValueName` optionally followed by `\|<suffix>`; the part after the pipe is appended to the value read. Key = everything before the last `\` (the code uses `getParent`, so forward slashes are normalised to backslashes), value name = last component. HKCU first, then HKLM, `RegGetValueW(..., RRF_RT_REG_SZ, ...)`; result accepted only if the resulting file exists. Example in file: `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\amiberry_is1\InstallLocation\|Amiberry.exe`. Whether `REG_EXPAND_SZ` values are expanded by `RRF_RT_REG_SZ` is **UNVERIFIED** (Win32 behaviour, not ES-DE code). |
| `systempath` | entry = exe name; resolved with `SearchPathW(NULL, name, L".exe", ...)` (so the application directory, current directory, system directories and `PATH` are searched, in Win32 order). The result used is `<found directory>\<entry>`. Docs note most zip-distributed emulators need the user to add their folder to `Path`. |
| `staticpath` | entry = absolute path to the binary (directories cannot contain wildcards, the file name can: `pcsx2-qt*.exe`; first match returned by `getMatchingFiles` wins). Expansions: `~` -> home (`%HOMEDRIVE%%HOMEPATH%`, or `--home`/portable override), `%ESPATH%` -> directory of `ES-DE.exe`, `%ROMPATH%` -> ROM directory. `entry\|command` substitutes an explicit command for the binary once the file is found to exist. |
| `corepath` (on `<core>`) | directory list to look for `%CORE_NAME%\<file>` in; may use `%EMUPATH%` (directory of the resolved emulator binary) and `%ESPATH%`; `~` allowed. Windows file has exactly one: `<core name="RETROARCH">` -> `%EMUPATH%\cores`. |

Variables that occur in the Windows find-rules files: `%ESPATH%` (289 times), `%EMUPATH%` (1), `~` (e.g.
`~\AppData\Roaming\RetroArch\retroarch.exe`). `%ROMPATH%` is allowed in `staticpath` but unused in the bundled file.
RETROARCH search order in the installer file: App Paths registry key -> `retroarch.exe` on PATH ->
`C:\RetroArch-Win64\retroarch.exe`, `C:\RetroArch\retroarch.exe`, `~\AppData\Roaming\RetroArch\retroarch.exe`,
`C:\Program Files\RetroArch-Win64\…`, `C:\Program Files\RetroArch\…`, `C:\Program Files (x86)\RetroArch-Win64\…`,
`C:\Program Files (x86)\RetroArch\…`, Steam copies (`C:\Program Files (x86)\Steam\steamapps\common\RetroArch\retroarch.exe`,
same under `D:` and `C:\Program Files\Steam`, `D:\Program Files\Steam`), then `%ESPATH%\Emulators\RetroArch-Win64\…`,
`%ESPATH%\Emulators\RetroArch\…`, `%ESPATH%\..\Emulators\RetroArch-Win64\…`, `%ESPATH%\..\Emulators\RetroArch\…`.
Core DLLs are therefore always `<dir of retroarch.exe>\cores\<core>_libretro.dll` on Windows.

Reference table of core DLLs and which systems use them: `esde-find-rules.json` -> `retroarchCoresReferencedBySystems`
(173 cores, e.g. `snes9x_libretro.dll`, `mesen_libretro.dll`, `mame_libretro.dll`, `fbneo_libretro.dll`,
`genesis_plus_gx_libretro.dll`, `pcsx2_libretro.dll`, `dolphin_libretro.dll`, `flycast_libretro.dll`,
`mupen64plus_next_libretro.dll`, `ppsspp_libretro.dll`, `scummvm_libretro.dll`, `dosbox_pure_libretro.dll`...).

## 3. ROM directory layout and scanning

* ROM root: setting `ROMDirectory` in `~/ES-DE/settings/es_settings.xml`; empty (default) means `<home>/ROMs/`
  (`C:\Users\<user>\ROMs` for the installer release, `<exe dir>\ROMs` for the portable release because the home is
  redirected). `~` and `%ESPATH%` (exe directory) are expanded; a trailing `\` is appended (`FileData::getROMDirectory`,
  `FileData.cpp` 273-307). `<home>` on Windows = `%HOMEDRIVE%` + `%HOMEPATH%` (not `USERPROFILE`), overridden by
  `--home <path>` or by `portable.txt` next to the exe (file content may be a relative path such as `..`; default = exe
  directory). The app-data directory is then `<home>\ES-DE\` (`getAppDataDirectory`; `ESDE_APPDATA_DIR` env var is
  **not** honoured on Windows).
* Layout: `<ROMDirectory>\<system name>\...` with arbitrary nesting. Symlinked system folders are supported
  (`mklink /D`). Renaming a folder to a non-system name (or moving it under e.g. `ROMs\DISABLED\`) disables the system.
* Scanning algorithm (`SystemData::populateFolder`, `SystemData.cpp` 613-775), per directory, entries sorted by
  `std::list::sort` on generic paths (`getDirContent`, forward slashes, lexicographic):
  1. Empty directory -> system not created.
  2. `<system dir>\noload.txt` present -> system not populated at all (log "Not populating system"). Bypassed when
     `ParseGamelistOnly` is true.
  3. `<system dir>\flatten.txt` present -> folder flattening: all nested games are added to the root; name collisions
     keep only the first; documented as experimental/discouraged; Orphaned-data cleanup skips such systems.
  4. Recursive symlinks skipped. Hidden entries skipped when `ShowHiddenFiles=false` (default **true**): Windows
     `FILE_ATTRIBUTE_HIDDEN` or a name starting with `.` (`isHidden`).
  5. Extension = substring from the **last** dot of the file/directory name (`getExtension`; no dot -> `.`), compared
     with exact string equality against the system's extension list. Matching entries become `GAME` items — including
     **directories** whose name ends with a listed extension ("directories interpreted as files"), except when the
     matching extension is the bare `.`. For such directories the display name is the directory name minus the
     extension.
  6. A matching file whose stem is a MAME BIOS or device name (`resources/MAME/mamebioses.xml`, `mamedevices.xml`) is
     dropped for systems whose platform is `arcade` or `neogeo` ("arcade assets").
  7. Non-matching directories: if they contain `noload.txt` they are kept as a `FOLDER` flagged no-load (not scanned,
     invisible); otherwise recursed; folders that end up with no games are discarded.
* Default item name: file stem (`getStem`: file name without the part after the last dot; for a **directory** the whole
  name, i.e. `dig.scummvm` keeps its "extension"; hence media file names like `dig.scummvm.png`). For arcade/neogeo
  platforms the stem is expanded through `resources/MAME/mamenames.xml` (42,777 `<game><mamename>/<realname>` pairs,
  generated from `mame0289.xml`), then text in `()`/`[]` is stripped when `MAMENameStripExtraInfo` is true (default).
* `.m3u`: no special parsing. `.m3u`/`.M3U` is simply a listed extension for multi-disc systems (amiga*, amstradcpc,
  c64, psx, pcengine, ... see JSON); the emulator receives the `.m3u` path. The recommended layout is a directory named
  `<Game>.m3u` containing the discs and `<Game>.m3u`; at launch the file inside the directory with the same name as the
  directory is passed (section 4). Users typically hide the individual disc files via `hidden=true`.
* Directories-as-files are also how PS3 (`.ps3` directories), ScummVM (`.scummvm`), ROM-hack folders (`Game.zip/` with
  `.ips` + `.zip`), etc. are modelled.
* Game importer (`es_import_rules.xml`, Windows): copies matching files into `ROMs\<system>` for `desktop`, `emulators`,
  `windows`, `xbox` (`.lnk` from `C:\ProgramData\Microsoft\Windows\Start Menu\Programs`, `~\AppData\Roaming\Microsoft\Windows\Start Menu\Programs`,
  `~\Desktop`, plus `%ESPATH%\Emulators` for `emulators`), `steam` (`.url` from
  `~\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Steam` and `~\Desktop`), `epic` (`.url` from `~\Desktop`).
  Extension matching for `file` rules is case-insensitive on Windows. Only `.url`/`.lnk` shortcuts, i.e. ES-DE never
  reads store databases.

## 4. Launch command processing (`FileData::launchGame`, `FileData.cpp` 955-2396; Windows paths)

### 4.1 Command selection (alternative emulators)
1. If `AlternativeEmulatorPerGame` (default true) and the game's `altemulator` metadata is non-empty -> the system's
   command whose `label` equals it (`getLaunchCommandFromLabel`); invalid label -> warning and fall through.
2. Else if the system has a system-wide alternative emulator (stored in the system's gamelist.xml as
   `<alternativeEmulator><label>…</label></alternativeEmulator>`, see section 6) -> that command.
3. Else the first `<command>`.
Alternative emulator = a different `<command>` entry; nothing else changes. Invalid system-wide labels are stored as
`<INVALID>label` and the default is used.

### 4.2 Placeholder reference (every variable the Windows code path knows)

| placeholder | expansion (Windows) |
|---|---|
| `%ROM%` | `getEscapedPath(game path)`: backslash path, wrapped in `"…"` **only if it contains a space**; no other escaping unless `%ESCAPESPECIALS%` is present. For a directory-as-file, if a file with exactly the directory's name exists inside, that inner file is used instead. |
| `%ROMRAW%` | unescaped backslash path (`getPreferredPath`), never quoted. |
| `%ROMRAWWIN%` | not available on Windows (Unix/macOS only: `%ROMRAW%` with `/`->`\`). |
| `%BASENAME%` | file stem. Quirk: for a directory-as-file with a matching inner file, `baseName = baseName.substr(0, baseName.find("."))`, i.e. cut at the **first** dot (`Dr. Mario.m3u` -> `Dr`). |
| `%FILENAME%` | `%BASENAME%` + extension of the (possibly inner) ROM path, e.g. `bar.rom`. |
| `%ROMPATH%` | `getEscapedPath(ROM directory)`: `getGenericPath` first strips the trailing separator, then backslashes are applied and the whole value is quoted if it contains a space. So `%ROMPATH%\adam` -> `C:\Users\x\ROMs\adam`, or `"C:\Users\John Doe\ROMs"\adam` when the path has spaces (Win32 argv parsing still yields one argument). For custom entries with spaces the doc recommends writing `%ROMPATH%"\Arcade Games"`. |
| `%GAMEDIR%` | escaped (quoted if spaces) parent directory of the ROM. |
| `%GAMEDIRRAW%` | unescaped parent directory, backslashes. |
| `%GAMEENTRYDIR%` | only valid inside `%STARTDIR%=`: the game entry path itself (for directories-as-files = the directory). Used by `arcade`, `mame`, `pcarcade`. |
| `%STARTDIR%=<dir>` | working directory for `CreateProcessW`; value is `"quoted"` or up to the next space; `~`, `%EMUDIR%`, `%GAMEDIR%`, `%GAMEENTRYDIR%` expanded; created if missing (error popup if creation fails); `/`->`\`. Removed from the command. |
| `%EMUDIR%` | escaped directory of the resolved emulator binary (general purpose). |
| `%EMUPATH%` | legacy: directory of the resolved emulator binary, used as `%EMUPATH%\cores\x.dll`; ES-DE checks that file exists and errors otherwise. Replaced by `%CORE_` rules. |
| `%EMULATOR_NAME%` | resolved via find rules (section 2) to the binary path, quoted if it contains spaces; errors: no rules for NAME ("MISSING EMULATOR FIND RULES CONFIGURATION"), not found ("COULDN'T FIND EMULATOR 'NAME'"). If no `%EMULATOR_` variable is present, the first token (or quoted token) of the command is treated as the executable, `%ESPATH%` expanded, `*` wildcard allowed, located with `SearchPathW(..., L".exe")`. |
| `%PRECOMMAND_NAME%` | same find-rule lookup, for a wrapper placed before `%EMULATOR_…%` (Wine/Proton on Linux); supported on Windows too. |
| `%CORE_NAME%\<file>` | for each `corepath` of core NAME (in order): `<corepath>\<file>` with `%EMUPATH%` -> emulator dir, `%ESPATH%` -> exe dir, `~` -> home; first existing file (regular or symlink) wins; quoted if it contains spaces. `<file>` ends at the next space, or at the closing quote when the variable was written as `"%CORE_…%\x.dll"`. Errors: "MISSING CORE CONFIGURATION FOR 'NAME'" / "COULDN'T FIND EMULATOR CORE FILE 'X'". On Windows: `<retroarch dir>\cores\<core>_libretro.dll`. |
| `%ESPATH%` | directory containing `ES-DE.exe`, backslashes. |
| `%INJECT%=<file>` | repeatable. `<file>`: `"quoted"` or up to next space; `%BASENAME%` substituted; the literal value `%ROM%` means the ROM file itself; otherwise relative paths (anything not `X:/…`) are relative to the ROM's directory; `~` expanded earlier. If the file exists and is 1..4096 bytes, its lines (CR stripped, **concatenated without separators**) are inserted at that position followed by a space; missing/empty/oversize files are skipped (warning when > 4096). Bundled usage: `%INJECT%=%BASENAME%.commands` (52 commands) and `%INJECT%=%BASENAME%\%BASENAME%.commands`. |
| `%RUNINBACKGROUND%` | flag: do not block/suspend ES-DE while the game runs (also forced by global `RunInBackground`). Removed from the command. |
| `%HIDEWINDOW%` | flag (Windows only): launch with `STARTF_USESHOWWINDOW`/`SW_HIDE` (hides console windows of `cmd.exe /C`). Removed. |
| `%ESCAPESPECIALS%` | flag (Windows only): in `%ROM%` prefix each of `^ & ( ) = ; ,` (processed in that order) with `^`, and if any was found also replace every space with `^ `. Removed. |
| `%ENABLESHORTCUTS%` | Unix/macOS only (.desktop/.app handling). The Windows build does not strip it — a custom Windows command containing it would pass the literal text to the process. |
| `%FILEINJECT%` | Android only (value of `%ANDROIDAPP%=`). |
| `%ROMPATHRAW%`, `%QUOTATION%`, `%ANDROIDAPP%=`, `%ANDROIDPACKAGE%`, `%INTERNALDATA%`, `%EXTERNALDATA%`, `%ACTION%=`, `%CATEGORY%=`, `%MIMETYPE%=`, `%DATA%=`, `%EXTRA_*`, `%EXTRAARRAY_*`, `%EXTRAINTEGER_*`, `%EXTRABOOL_*`, `%ACTIVITY_CLEAR_TASK%`, `%ACTIVITY_CLEAR_TOP%`, `%ACTIVITY_NO_HISTORY%` | Android Intent variables, not on Windows. |
| `%POSTCOMMAND%` | **does not exist** anywhere in ES-DE (no match in `es-app/src`, `es-core/src`, docs). |

Placeholders actually used by the Windows `es_systems.xml` (occurrence counts): `%ROM%` 890, `%EMULATOR_RETROARCH%` and
`%CORE_RETROARCH%` 470 each, `%ROMPATH%` 307, `%STARTDIR%` 184, `%EMUDIR%` 163, `%GAMEDIR%` 124, `%BASENAME%` 120,
`%HIDEWINDOW%` 118, `%INJECT%` 52, `%ESCAPESPECIALS%` 35, `%GAMEDIRRAW%` 25, `%ROMRAW%` 18, `%RUNINBACKGROUND%` 13,
`%FILENAME%` 3, `%GAMEENTRYDIR%` 3, plus 81 other `%EMULATOR_<NAME>%` names.

### 4.3 Order of operations
1. Pick command (4.1). Compute `romPath` (escaped), `baseName`, `romRaw`; apply the directory-as-file inner-file rule.
2. Extract and remove flags `%RUNINBACKGROUND%`, `%HIDEWINDOW%`, `%ESCAPESPECIALS%` (leading whitespace trimmed).
3. If `"%CORE_` is present remove that opening quote; read the core NAME between `%CORE_` and `%`; load its corepaths.
4. Expand `~` in the whole command (home = HOMEDRIVE+HOMEPATH / `--home` / portable).
5. Resolve `%PRECOMMAND_…%` (find rules), then `%EMULATOR_…%` (find rules) or the explicit executable.
6. Legacy `%EMUPATH%` core existence check and substitution.
7. Resolve `%CORE_…%\file` through corepaths.
8. Parse/remove `%STARTDIR%=…` (create dir).
9. Process every `%INJECT%=…`.
10. Apply `%ESCAPESPECIALS%` to `romPath`.
11. Replace `%ROM%`, `%BASENAME%`, `%FILENAME%`, `%ROMRAW%`, `%ROMPATH%`.
12. Windows: if the command has an odd number of `"`, collapse `""` -> `"`; replace `%ESPATH%`, `%EMUDIR%`,
    `%GAMEDIR%`, `%GAMEDIRRAW%`.
13. Trim; log "Expanded emulator launch command"; store `GameLaunchTime` (epoch seconds) in settings; fire
    `game-start` custom-event script.
14. `Utils::Platform::launchGameWindows(cmdUtf16, startDir, runInBackground, hideWindow)`
    (`es-core/src/utils/PlatformUtil.cpp` 332-451): `CreateProcessW(NULL, <command line>, NULL, NULL, FALSE, 0, NULL,
    startDir or NULL, &si, &pi)` — the whole expanded string is the command line (standard Win32 argv quoting rules
    apply, no shell unless the command itself is `cmd.exe /C …`). Unless running in background it then polls
    `WaitForSingleObject(pi.hProcess, 10)` while discarding SDL events (controller add/remove still handled), after
    resizing its window by one pixel as a workaround. The return value is **only** `GetLastError()` when
    `CreateProcessW` fails; the emulator's exit code is never read on Windows ("ERROR LAUNCHING GAME 'X' (ERROR CODE n)"
    popup only on CreateProcess failure).
15. Afterwards: `playcount` += 1; if not in background, `lastplayed` = now and `playtime` += (now - GameLaunchTime)
    seconds unless `MaxPlayTimeTracking` (hours, default 8, 0 = off, 24 = unlimited) is exceeded (then not added);
    parent folder's `lastplayed` updated; gamelist saved (`SaveGamelistsMode` `always` default / `on exit` / `never`);
    `game-end` event.

## 5. Application data directory and settings (Windows)

`<home>\ES-DE\` (installer: `C:\Users\<user>\ES-DE\`; portable: `<exe dir>\ES-DE\`), created on first start, with
`collections\` (`custom-<Name>.cfg`), `custom_systems\`, `downloaded_media\`, `gamelists\`, `logs\es_log.txt`,
`scrapers\` (TheGamesDB json caches), `screensavers\custom_slideshow\`, `scripts\` (custom event scripts),
`settings\es_settings.xml` + `es_input.xml`, `themes\`, `controllers\es_controller_mappings.cfg`.

`es_settings.xml` format (`Settings::saveFile`): flat XML, one element per setting:
`<string name="ROMDirectory" value="D:\Games\ROMs" />`, `<bool name="ShowHiddenGames" value="true" />`,
`<int name="MaxPlayTimeTracking" value="8" />`. Only non-default values may be present. Keys relevant to importing
an ES-DE library (defaults from `es-core/src/Settings.cpp`): `ROMDirectory` (""), `MediaDirectory` (""),
`ShowHiddenFiles` (true), `ShowHiddenGames` (true), `ParseGamelistOnly` (false), `LegacyGamelistFileLocation` (false:
gamelist.xml inside `ROMs\<system>` is ignored with a warning; set true to load it), `AlternativeEmulatorPerGame`
(true), `RunInBackground` (false), `MaxPlayTimeTracking` (8), `SaveGamelistsMode` ("always"), `SystemsSorting`
("default"), `Scraper` ("screenscraper"), `ScraperUsernameScreenScraper`/`ScraperPasswordScreenScraper` ("", password
stored in clear text), `ScraperUseAccountScreenScraper` (true), `ScraperRegion` ("eu"), `ScraperLanguage` ("en"),
`ScraperSearchFileHash` (true), `ScraperSearchFileHashMaxSize` (384 MiB; GUI range 32-800), `ScraperSearchMetadataName`
(true), `ScraperOverwriteData` (true), `ScraperConvertUnderscores` (true), `ScraperAutomaticRemoveDots` (true),
`ScraperRegionFallback` (true), `ScraperRetryOnErrorCount` (3), `ScraperRetryOnErrorTimer` (3 s),
`ScraperIgnoreHTTP404Errors` (true), `ScraperConnectionTimeout` (30 s), `ScraperTransferTimeout` (120 s),
`Scrape{GameNames,Ratings,Metadata,Videos,Screenshots,TitleScreens,Covers,BackCovers,Marquees,3DBoxes,PhysicalMedia,FanArt,Manuals}`
(all true), `MiximageGenerate` (true), `MiximageResolution` ("1280x960"), `MiximageFileFormat` ("png"),
`MAMENameStripExtraInfo` (true), `CreatePlaceholderSystemDirectories` (false).

## 6. gamelist.xml (import reference)

Location: `<app data>\gamelists\<system name>\gamelist.xml` (`SystemData::getGamelistPath`). Parser
`es-app/src/GamelistFileParser.cpp`; field declarations `es-app/src/MetaData.cpp` 22-71.

Document shape: `<?xml version="1.0"?>` then `<gameList>` with `<game>` and `<folder>` children, each containing
`<path>` plus any metadata elements. Two optional extras written by ES-DE: `<alternativeEmulator><label>Snes9x 2010</label></alternativeEmulator>`
(system-wide alternative emulator; ES-DE currently writes it as a **second root-level element before `<gameList>`**
— non-standard XML; it is read either there or as a child of `<gameList>`, and the project plans to move it inside)
and `<launchOnOtherScreen>false</launchOnOtherScreen>` (Android, child of `<gameList>`). An importer must use a
lenient parser or pre-split the file.

`<path>` rules: `./relative/to/system/dir.ext` (generic forward slashes) or an absolute path; `~/` is **not**
expanded when reading game paths (`resolveRelativePath(..., allowHome=false)`). On write, paths inside the system
directory become `./…`, others are written absolute with forward slashes. Entries whose file does not exist are
skipped at load (unless `ParseGamelistOnly`) but **never removed** from the file; a `<game>` whose extension is not in
the system's extension list is also skipped. Hidden entries (`hidden=true`) are not loaded at all when
`ShowHiddenGames=false`. Entries for MAME BIOS/device names are dropped. Only non-default values are written; an
entry consisting solely of a `<name>` equal to the default display name is not written at all.

Types: `string`; `float` (rating 0..1, rounded to 0.1 = half stars; ScreenScraper `note/20` rounded **up**);
`integer`; `datetime` = `%Y%m%dT%H%M%S` (e.g. `19950311T000000`); `bool` = `true`/`false`.

`<game>` fields (key — type — default — notes):
`name` — string — "" (display name; default = stem / MAME real name); `sortname` — string — ""; `collectionsortname`
— string — ""; `desc` — multiline string — ""; `rating` — float — "0"; `releasedate` — datetime — "19700101T000000";
`developer` — string — "unknown"; `publisher` — string — "unknown"; `genre` — string — "unknown"; `players` —
string — "unknown" (e.g. `1`, `2-4`); `favorite` — bool — false; `completed` — bool — false; `kidgame` — bool —
false; `hidden` — bool — false; `broken` — bool — false; `nogamecount` — bool — false; `nomultiscrape` — bool —
false; `hidemetadata` — bool — false; `playcount` — int — "0"; `playtime` — int seconds — "0"; `screen` — string —
"" (Android: `other`/`primary`); `controller` — string — "" (badge id); `altemulator` — string — "" (a `<command
label>` of the system); `lastplayed` — datetime statistic — "0" (written as `%Y%m%dT%H%M%S`).

`<folder>` fields: `name`, `desc`, `rating`, `releasedate`, `developer`, `publisher`, `genre`, `players`,
`favorite`, `completed`, `kidgame`, `hidden`, `broken`, `nomultiscrape`, `hidemetadata`, `controller`, `folderlink`
(string: path of a child entry **relative to the folder**, backslashes accepted; resolved as `<folder path>/<folderlink>`
and launched instead of entering the folder), `lastplayed`. Folder entries are only used if the folder exists and
contains at least one game.

Custom collections: `<app data>\collections\custom-<Name>.cfg`, plain text, one game path per line, normally written
as `%ROMPATH%/<system>/<file>` (forward slashes; legacy absolute paths are rewritten on first change). Collections
must be enabled in the UI (setting `CollectionSystemsCustom`). Automatic collections (`All games`, `Favorites`,
`Last played` = 50 most recent) are derived, not stored.

## 7. downloaded_media layout

Root = setting `MediaDirectory`, default `<app data>\downloaded_media\` (`FileData::getMediaDirectory`; `~` and
`%ESPATH%` expanded, trailing `/` added). Lookup (`FileData::getMediafilePath`, `getVideoPath`, `getManualPath`) and
save path (`getSaveAsPath`, `Scraper.cpp` 770-809) are:

`<MediaDirectory>/<system name>/<media type>/<sub folders relative to the system ROM dir>/<game stem>.<ext>`

where `<game stem>` = `getStem(ROM path)` (for a directory-as-file this is the **full directory name including its
pseudo-extension**, e.g. `ROMs\scummvm\dig.scummvm\` -> `downloaded_media\scummvm\screenshots\dig.scummvm.png`) and
`<sub folders>` mirrors the ROM's directory below the system root (`ROMs\c64\Multidisk\Last Ninja 2.m3u` ->
`downloaded_media\c64\videos\Multidisk\Last Ninja 2.mp4`). Folders use the same scheme (folder name as stem).

Media type directories (exactly these names): `3dboxes`, `backcovers`, `covers`, `custom` (user-provided extra
image, never created automatically), `fanart`, `manuals` (`.pdf` only), `marquees`, `miximages` (generated composite;
`MiximageResolution` 1280x960 default, png or webp), `physicalmedia`, `screenshots`, `titlescreens`, `videos`.
Image extensions searched in order `.png`, `.jpg`, `.webp` (lower case only); videos `.mp4`, `.mkv`, `.avi`, `.wmv`,
`.mov`, `.webm`, `.m4v`. The gamelist "image" is the first existing of miximages -> screenshots -> titlescreens ->
covers. Downloaded images are resized to fit 2560x1440 (marquees 1000x600) by `resizeImage`; videos and PDFs are
stored as received. The Orphaned-data cleanup utility moves removed files to
`<downloaded_media>\CLEANUP\<yyyy-mm-dd_hhmmss>\<system>\<type>\…` (and `gamelists\CLEANUP\…`, `collections\CLEANUP\…`).

## 8. Scrapers (`es-app/src/scrapers/`)

### 8.1 Common behaviour
* Selection via setting `Scraper` = `screenscraper` | `thegamesdb` (anything else resets to screenscraper).
  Dispatch `startScraperSearch` (`Scraper.cpp` 36-70). `MAX_SCRAPER_RESULTS` = 7.
* HTTP (`es-core/src/HttpReq.cpp`): libcurl, `User-Agent: ES-DE Frontend/4.0.0-alpha (Windows; W)` (platform letter
  W=Windows, L=Linux, M=macOS, G=Android, S=Steam Deck, A=AppImage, R=RetroDECK, B=FreeBSD, H=Haiku, I=iOS, O=other),
  forced HTTP/1.1, follows at most 2 redirects (http/https only), `CURLOPT_FAILONERROR`, connect timeout
  `ScraperConnectionTimeout` (30 s), transfer timeout `ScraperTransferTimeout` (120 s). HTTP 404 on a media download
  is skipped silently (`ScraperIgnoreHTTP404Errors`); other >= 400 errors abort/retry (`ScraperRetryOnErrorCount`).
* Search name: if `ScraperSearchMetadataName` (default true) the metadata `name` with `()`/`[]` groups removed
  (`removeParenthesis`), else the file stem cleaned the same way (for directories-as-files the pseudo-extension is
  stripped). `_` -> space when `ScraperConvertUnderscores`. Interactive "refine" searches use `nameOverride`.
* Arcade (`platform` arcade or neogeo): ScreenScraper is sent the MAME short name directly (single-game lookup);
  TheGamesDB gets the expanded name from `mamenames.xml`.
* Media download policy (`MDResolveHandle`, `Scraper.cpp` 188-414): per enabled `Scrape*` setting; extension = the
  format reported by the service, else the URL's extension; unsupported extensions are not saved; existing media is
  not re-downloaded unless `ScraperOverwriteData`; a ScreenScraper image served from the thumbnail cache is rejected
  when < 80 bytes; ScreenScraper back covers that are a single flat colour (or < 50 px wide/high) are rejected.

### 8.2 ScreenScraper (`ScreenScraper.cpp`, `ScreenScraper.h`)
* Base URL `https://api.screenscraper.fr/api2`. Two endpoints are used:
  * `jeuInfos.php?devid=<D>&devpassword=<P>&softname=<S>&output=xml&romnom=<name>[&md5=<hex>&romtaille=<bytes>][&ssid=<user>&sspassword=<pw>][&systemeid=<id>]`
    — used in automatic (non-interactive) mode and whenever a "single search" is forced: arcade system with
    `ScraperSearchMetadataName=false`, or search string shorter than 4 characters (after ScreenScraper's own removal of
    trailing `+` and of the word "the"; empty string -> `zzzzzz`). In automatic mode dots are removed from the name when
    `ScraperAutomaticRemoveDots`.
  * `jeuRecherche.php?devid=…&devpassword=…&softname=…&output=xml&recherche=<name>[&ssid…][&systemeid=<id>]`
    — interactive/wide search (server caps results at 30, ranked by probability per the API doc).
  * One request per distinct ScreenScraper platform id of the system (`&systemeid=`), sorted and de-duplicated; a
    system platform without a mapping (or no platform) produces an additional request without `systemeid`.
  * `softname` = `ES-DE <PROGRAM_VERSION_STRING> <platform letter>` (e.g. `ES-DE 4.0.0-alpha W`), URL-encoded; all
    names/hashes URL-encoded with `HttpReq::urlEncode`.
* ROM identification: only **MD5** is used (never crc/sha1, no `romtype`, no `serialnum`). Conditions
  (`GuiScraperSearch.cpp` 378-398): automatic mode only, scraper = screenscraper, `ScraperSearchFileHash` true, the
  entry is a regular file (directories never hashed), size != 0 and <= `ScraperSearchFileHashMaxSize` MiB (default
  384). The hash is computed over the whole file in a worker thread (`Utils::Math::md5Hash(path, true)`, lower-case
  hex) and sent as `md5=<hex>&romtaille=<file size in bytes>`. A result is a "perfect match" when the response's
  `jeu/rom/rommd5` equals the computed hash; otherwise the name search fallback applies (the same request carries
  `romnom`). The hash is identical for all systems; there is no per-system hash choice.
* Response parsing (`processGame`, XML): `Data/ssuser/niveau` (`0` = wrong username/password -> error),
  `Data/ssuser/requeststoday` and `maxrequestsperday` (daily allowance, logged); games in `Data/jeux/jeu` (or
  `Data/jeu`), attribute `id` -> gameID. Name: `noms/nom[@region]` first of `[<ScraperRegion>, wor, us, ss, eu, jp]`;
  rating: `note` / 20 rounded up to 0.1; description: `synopsis/synopsis[@langue]` in `[<ScraperLanguage>, en, wor]`;
  release date: `dates/date[@region]` same region order, `YYYY-MM-DD` or `YYYY`; `developpeur`, `editeur`;
  genre: `genres/genre[@langue]` in `[<language>, en]`; `joueurs` -> players; `systeme@id`/`@parentid` reverse-mapped to
  ES-DE platforms; `rom/rommd5`. Results named `ZZZ(notgame)…` are discarded; duplicate gameIDs removed; a plain-text
  body starting with `Erreur : Rom` means no result. HTML entities `&nbsp; &#x26; &#39; &quot; &copy; &#039;` are
  translated.
* Media (`medias/media[@type][@region][@format]`): `box-3D` -> 3dboxes, `box-2D-back` -> backcovers, `box-2D` ->
  covers, `fanart` -> fanart (no region), `wheel` and `wheel-hd` -> marquees (the best region across both; HD preferred
  on ties), `support-2D` -> physicalmedia, `ss` -> screenshots, `sstitle` -> titlescreens, `video` (fallback
  `video-normalized`) -> videos (no region), `manuel` -> manuals. Region fallback for regional media:
  `[<ScraperRegion>, wor, us, eu, jp, cus]` and, when `ScraperRegionFallback` (default true), finally the first region
  present in the response (this is what exposes the `ss` region and country-specific releases). Spaces in media URLs
  are replaced by `%20`; the `format` attribute gives the file extension.
* Regions offered (`ScraperRegion` values): `eu` (default), `jp`, `us`, `ame` (North America), `asi`, `wor`, `au`,
  `br`, `ca`, `cn`, `de`, `fr`, `it`, `kr`, `nl`, `ru`, `se`, `sp` (Spain), `tw`, `uk`. Languages (`ScraperLanguage`):
  `en` (default), `cz`, `da`, `de`, `es`, `fr`, `it`, `hu`, `nl`, `no`, `pl`, `pt`, `ru`, `sk`, `fi`, `sv`, `tr`, `ja`,
  `ko`, `zh`.
* Credentials: ES-DE ships obfuscated developer credentials (`API_DEV_U`, `API_DEV_P`, `API_DEV_KEY` byte arrays in
  `ScreenScraper.h`, de-scrambled with `Utils::String::scramble`) — **do not reuse**. User account: `ssid`/`sspassword`
  from settings, sent when `ScraperUseAccountScreenScraper`. Per the official API page
  (https://www.screenscraper.fr/webapi2.php, French): a developer id/password is obtained by contacting the
  ScreenScraper team on their forum and presenting the software; the API may only be integrated into software that is
  entirely free and distributed, otherwise prior authorisation/conditions are required; `softname` must identify the
  software/version (error 426 = blacklisted/obsolete softname); quotas (requests/day, requests/min, threads, KB/day)
  depend on the user's level and contributions and are returned in `ssuser` (`maxthreads`, `maxdownloadspeed`,
  `maxrequestsperday`, `maxrequestskoperday`, `maxrequestspermin`); errors 429 (threads), 430 (daily quota), 431
  (too many unknown ROMs), 401 (API closed to non-members under load). The doc states that unless exempted a request
  should carry at least one of `crc`, `md5`, `sha1` plus `romtaille`; ES-DE sends only md5 (and often none) — this
  works with its exemption-level dev account; whether a new dev account gets the same leniency is **UNVERIFIED**.
  Other documented endpoints (not used by ES-DE): `systemesListe.php` (platform ids), `mediasJeuListe.php`,
  `regionsListe.php`, `languesListe.php`, `genresListe.php`, `romTypesListe.php`, `ssuserInfos.php`, `mediaJeu.php`,
  `mediaVideoJeu.php`, `mediaManuelJeu.php`, `mediaSysteme.php`, `botNote.php`, `botProposition.php`.
* Platform table: `screenscraper_platformid_map` (`ScreenScraper.cpp` 29-171), 141 entries; see
  `esde-scraper-platforms.json`. No ScreenScraper id for `flash`, `love`, `mess`, `mugen`, `residualvm`, `zxnext`.
  Several ES-DE platforms share one id (e.g. `nes`/`famicom` = 3, `megadrive`/`genesis` = 1, `dos`/`pc` = 135,
  `pcwindows`/`steam` = 138, `arcade`/`lcdgames` = 75, `atari800`/`atarixe` = 43, `trs-80`/`coco` = 144).

### 8.3 TheGamesDB (`GamesDBJSONScraper.cpp`, `GamesDBJSONScraperResources.cpp`)
* Base `https://api.thegamesdb.net/v1`. Requests:
  * `GET /Games/ByGameName?apikey=<KEY>&fields=players,publishers,genres,overview,last_updated,rating,platform,coop,youtube,os,processor,ram,hdd,video,sound,alternates&name=<name>&filter%5Bplatform%5D=<id>[,<id>…]`
    (platform ids of the system joined with `,`; omitted if none map).
  * `GET /Games/ByGameID?apikey=…&fields=<same>&id=<id>` when the refine string is `id:<n>`.
  * `GET /Games/Images?apikey=…&games_id=<ids>` and, only if `ScrapeVideos`, `GET /Games/Videos?apikey=…&games_id=<ids>`
    (second phase, `startMediaURLsFetch`).
  * `GET /Developers?apikey=…`, `/Publishers?apikey=…`, `/Genres?apikey=…` once, cached as
    `<app data>\scrapers\thegamesdb_developers.json`, `thegamesdb_publishers.json`, `thegamesdb_genres.json`
    (`data.<developers|publishers|genres>` id -> name maps; 90 s wait limit).
* Response fields used: `data.games[]`: `id`, `game_title`, `release_date` (`%Y-%m-%d`), `platform` (int, reverse
  mapped), `overview`, `developers[]`/`publishers[]`/`genres[]` (int ids -> names joined with `, `), `players` (int).
  Images: `data.base_url.large` + `data.images[<gameId>][].filename` with `type`/`side`: `boxart`+`front` -> covers,
  `boxart`+`back` -> backcovers, first `fanart` -> fanart, `clearlogo` -> marquees, `screenshot` -> screenshots,
  `titlescreen` -> titlescreens. Videos: `data.base_url` + first `data.videos[<gameId>][].filename`. Allowance:
  `remaining_monthly_allowance` + `extra_allowance` (and `allowance_refresh_timer` seconds) are read from the Images
  response. No ratings, 3D boxes, physical media, manuals, regions or languages.
* Platform table: `gamesdb_new_platformid_map` (`GamesDBJSONScraper.cpp` 39-156), 114 entries, string ids in source
  (integers in the JSON). Shared ids: `arcade`/`atomiswave`/`naomi`/`daphne` = 23, `dos`/`pc`/`pcwindows`/`windows3x`/
  `steam`/`scummvm` = 1, `msx`/`msx2`/`msxturbor` = 4929, `snes`/`satellaview`/`sufami` = 6, `gb`/`sgb` = 4,
  `pcengine`/`supergrafx` = 34, `coco`/`trs-80` = 4941. 33 platforms have no TheGamesDB id (see JSON, e.g. `adam`,
  `apple2gs`, `arduboy`, `cdtv`, `channelf`, `openbor`, `pico8`, `vpinball`, `xboxone`, `zmachine`).
* API key: ES-DE embeds `GamesDBAPIKey` (`GamesDBJSONScraperResources.cpp` line 36) — **do not reuse**. The official
  OpenAPI 2.0 spec (`https://api.thegamesdb.net/spec.yaml`, downloaded) marks `apikey` as required on every endpoint,
  returns 403 for "bad API key or hit rate-limit cap", and provides `GET /v1/API/Limit?apikey=…` (allowance check that
  does not count). The spec also documents `/v1/Games/ByGameHash?apikey&hash=<hex>&filter[type]=md5|crc&filter[platform]=…`
  (hash lookup, unused by ES-DE), `/v1.1/Games/ByGameName` (`mode=natural`), `/v1/Games/ByPlatformID`,
  `/v1/Games/ByGameUniqueID`, `/v1/Games/Updates`, `/v1/Platforms`, `/v1/Platforms/ByPlatformID`,
  `/v1/Platforms/ByPlatformName`, `/v1/Platforms/Images`, `/v1/Genres`, `/v1/Developers`, `/v1/Publishers`,
  `/v1/Regions`, `/v1/Countries`. Image CDN base URLs: `https://cdn.thegamesdb.net/images/{original,small,thumb,cropped_center_thumb,medium,large}/`;
  videos `https://cdn.thegamesdb.net/` + `videos/<id>/<id>-1.mp4`. Images filter types: `fanart`, `banner`, `boxart`,
  `screenshot`, `clearlogo`, `titlescreen`. How a key is issued (public vs private key request on the TheGamesDB
  forum) is not in the spec — **UNVERIFIED**.

## 9. License and attribution

* `LICENSE` (repository root) is the MIT license with the notices
  `Copyright (c) 2024-2026 Northwestern Software AB`, `Copyright (c) 2020-2024 Leon Styhre`,
  `Copyright (c) 2014 Alec Lofquist`. Every source file carries `SPDX-License-Identifier: MIT`. The systems/find-rules
  XML data has no separate license, so it is covered by that MIT license: when GameDash ships data derived from
  `es_systems.xml`, `es_find_rules.xml`, `es_import_rules.xml`, the sorting files or the platform tables, include the
  full MIT text with those three copyright lines (e.g. in the about dialog / third-party notices) and state that the
  system definitions are derived from ES-DE (https://gitlab.com/es-de/emulationstation-de).
* `resources/MAME/mamenames.xml`, `mamebioses.xml`, `mamedevices.xml` are CC0 1.0 (`licenses/MAME`), generated from
  MAME 0.289's driver list. Verbatim copies of `mamebioses.xml` and `mamedevices.xml` live in
  `resources/systems/esde-mame/` (not under `docs/research/`) because they are the inputs `scripts/build-systems.mjs`
  turns into `resources/systems/mame-assets.json`; `mamenames.xml` is not used.
* Theme assets (`licenses/linear-es-de`, `modern-es-de`, `slate-es-de`, fonts, icons) have their own licenses and are
  not part of what was extracted; do not reuse them under the MIT assumption.
* `CREDITS.md` lists ES-DE (Leon Styhre), RetroPie EmulationStation and original EmulationStation (Alec Lofquist).

## 10. Practical notes for GameDash and open questions

* Extension matching is case-sensitive in ES-DE; a GameDash implementation on NTFS can match case-insensitively and
  de-duplicate the `.ext/.EXT` pairs from the JSON.
* To import an ES-DE library: read `es_settings.xml` for `ROMDirectory`/`MediaDirectory`; for each
  `gamelists\<system>\gamelist.xml` resolve `./` paths against `<ROMDirectory>\<system>`; map media by the stem rule
  in section 7; copy `playcount`, `playtime` (seconds), `lastplayed` (`%Y%m%dT%H%M%S`), `favorite`, `hidden`,
  `altemulator`; read `collections\custom-*.cfg` for playlists.
* Alternative-emulator labels are the only stable identifier of a command (there is no id attribute).
* `%INJECT%` files (`<game>.commands`) are a convention worth supporting for MAME/Amiberry/etc. launch arguments.
* UNVERIFIED: tarball == commit `ef267ae6`; Win32 `RRF_RT_REG_SZ` expansion of `REG_EXPAND_SZ`; ScreenScraper
  leniency for hash-less requests on a new developer account; TheGamesDB key issuing process. Not covered (out of
  scope): Android/Linux/macOS variants of the XML files, theme system, the es_systems.xml files of other platforms.
