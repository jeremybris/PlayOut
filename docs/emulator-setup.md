# Emulator setup

On first-time setup PlayOut downloads, unpacks and sets up 14 standalone emulators. It works the way EmuDeck-WE does,
with these differences: only the folder settings are pointed at the Emulation folder, games start fullscreen with an
XInput/SDL game controller set up (see "Fullscreen and controllers"), and every other setting stays at the
emulator's default.

Research notes (sources, archive layouts, config keys) were checked on 2026-11-11.

**RPCS3 is the exception**: it is not the official build but the user's own preconfigured copy, downloaded from their
public Google Drive folder (see "RPCS3 from Google Drive"). Its settings are kept as they are: only its folder wiring
is changed.

## Folders

- **Emulators root**: `<folder of PlayOut.exe>\Emulators`.
  - The folder of PlayOut.exe is `PORTABLE_EXECUTABLE_DIR || dirname(process.execPath)`.
  - PlayOut 0.1.81 used `<folder of PlayOut.exe>\Emulation`. At launch that folder is moved to `Emulators`:
    - it is recognised by its `.playout\emulators.json`;
    - it is renamed, or merged entry by entry when `Emulators` already holds something;
    - the manifest's exe paths, and any emulator paths in Settings that pointed inside it, are rewritten. The
      junctions inside the emulator folders point into the data Emulation folder, so they move unchanged.
    - A move blocked by a running emulator is retried at the next launch, and that launch keeps using the old folder.
  - The root is chosen once per run of PlayOut, in this order:
    1. A folder under Program Files (`%ProgramFiles%`, `%ProgramW6432%`, `%ProgramFiles(x86)%`, compared
       case-insensitively on resolved paths) is never used: ScummVM turns portable mode off there, and PlayOut without
       elevation cannot write it.
    2. A candidate whose manifest records an emulator whose exe is still at `<candidate>\<folder>\<exe>` is used, even
       if it can no longer be written (the notices report what then fails).
    3. Else `<folder of PlayOut.exe>\Emulators` when it can be written, else `<userData>\Emulators`. The existing
       `%ESPATH%\Emulators` find rules also look there.
  - Each emulator goes in `<root>\<spec.folder>` (see `catalog.ts`).
  - PlayOut's own files go in `<root>\.playout\`:
    - `7zr.exe`, the pinned 7-Zip console build (7z archives only);
    - `downloads\` (temporary);
    - `emulators.json`, the `SetupManifest`: the installed emulators, `configuredFor` and `completed` (every catalog
      emulator was installed in this root once). An older manifest without `completed` reads as not completed. When
      the chosen root has no manifest but another candidate's non-empty one was read at launch, its entries are kept
      (their exes still work) and `completed` is reset for this root.
  - An exe found at `<root>\<folder>\<exe>` without a manifest entry (PlayOut quit between moving the folder into place
    and saving the manifest, or the manifest was lost) is adopted by every setup run, startup and reconfigure: it is
    recorded as version `unknown`, configured and saved.
  - The NSIS uninstaller keeps `<install dir>\Emulators` (and 0.1.81's `Emulation`) on update and on uninstall (`build/installer.nsh`,
    `customRemoveFiles`).
- **Data Emulation folder `D`**: `emulationDirOf(settings, userData)`. A new install sets it to `Documents\Emulation`;
  a settings file that names none (an install from before that default) keeps `<userData>\Emulation`. It is never
  inside the install or data folder (`src/main/emulation/emulation-location.ts`), and changing it moves the folder
  (`emulation-move.ts`), after which the settings watcher below points the emulators at the new place.
  - It holds the user's files in EmuDeck's layout: `bios\` (the only files the user provides), `saves\<emu>\...`,
    `storage\<emu>\...` and `texturepacks\<emu>`.
  - When it changes, every installed emulator is configured again and the BIOS links are synced again. The manifest's
    `configuredFor` records which folder the emulators were last pointed at.

## Pipeline per emulator

The service runs at most 3 emulators at a time. Each one goes through these steps:

1. **Resolve** (`sources.ts`).
2. **Download** (`download.ts`):
   - HTTPS only, following redirects;
   - a User-Agent of `PlayOut-Setup` (git.ryujinx.app's anti-bot wall challenges browser-like agents);
   - 3 tries;
   - the SHA-256 is checked when known;
   - the file is written to `<name>.part` and renamed when complete.
3. **Extract** (`archive.ts`) into `<root>\.<folder>.extracting`. The format is detected from the content:
   - `PK` is a zip, handled by `util/zip.ts`. Its `safeEntryPath` already treats `\` as a separator, which Azahar's
     zips need.
   - `7z\xBC\xAF\x27\x1C` is a 7z archive, extracted with `7zr x -y -o<dir> <file>`.
   - `MZ` is MAME's 7z self-extracting exe. Try `7zr` first; if that fails, run the SFX itself with `-o<dir> -y`.
   - If the result is a single top folder (Dolphin-x64\, mGBA-x.y-win64\, publish\, RetroArch-Win64\,
     scummvm-...\, azahar-windows-...\), it is flattened: at most two levels (`flattenLevels`, default 2).
   - An emulator with several downloads (RetroArch: `RetroArch.7z` and `RetroArch_cores.7z`) unpacks each part apart
     with `flattenLevels: 1`, so `RetroArch-Win64\cores\*.dll` lands in `cores\`, then merges the parts. A RetroArch
     whose `cores\` holds no `*_libretro.dll` fails with "RetroArch cores were not found after unpacking" before it is
     moved into place.
4. **Move** the result into `<root>\<folder>`.
   - If `<root>\<folder>` is missing, rename the staging folder into place.
   - If it exists without the exe (an interrupted run), copy over it, keeping any other files.
5. **Configure** (`configure.ts`). See below.
   - A `drive-folder` source (RPCS3) skips steps 1 to 4: see "RPCS3 from Google Drive".
6. **Record** the emulator in the manifest. The manifest is written after every emulator, so an interrupted setup
   resumes with the missing ones.

The order of a run:

1. Runtimes the missing emulators need, before any emulator (`runtimes.ts`).
2. `7zr.exe`.
3. The emulators.
4. BIOS sync (`bios.ts`).

The data Emulation folder is read once at the start of a run: every emulator of the run, `configuredFor` and the BIOS
sync use that folder. If it changed during the run, a reconfigure follows.

A failure (network, a declined UAC prompt) is recorded on that item and the run continues. A run that ends with every
catalog emulator installed sets the root manifest's `completed`. Until then startup retries the missing ones at each
launch. The flag lives in the manifest, not in the settings, so it belongs to one root.

Automatic setup at launch runs only in the packaged app: a dev run (whose root would be
`node_modules\electron\dist\Emulators`) skips it unless `PLAYOUT_EMULATOR_SETUP=1` is set. Settings › Emulators can
still install by hand in a dev run.

## RPCS3 from Google Drive (`drive-folder.ts`)

RPCS3's catalog source is `{ kind: 'drive-folder', folderId: '1rabB9ZidwwYTCTwYqNyJ1aMEhumTAUyG', skip: ['log'] }`:
the user's public Google Drive folder holding an unpacked, ready-to-run RPCS3 (`rpcs3.exe`, its DLLs, `config`,
`GuiConfigs`, `dev_flash` with the PS3 firmware, `patches`, caches; about 1,600 files in 300 folders).

- **Only a fresh install** downloads it: RPCS3 missing from `<root>\RPCS3` (the same "exe missing" rule as every
  emulator). An RPCS3 already installed, from GitHub by an earlier PlayOut or by hand, is never replaced.
- **Listing**: Drive's embedded folder view (`util/google-drive.ts`, no key, no sign-in). A subfolder's link is a
  `/drive/folders/` link, a file's a `/file/d/` link (`parseDriveListing` sets `folder`). Folders are listed level
  by level, 6 requests at a time. Top-level entries named in `skip` are left out (`log`: the other PC's logs).
- **Safety caps**: at most 5,000 files, 2,000 folders and 16 levels; a page that is not a folder listing (a folder no
  longer shared publicly) is an error.
- **Names**: each segment is made safe for Windows (`safeSegment`): `<>:"/\|?*` and control characters become `_`,
  trailing dots and spaces are dropped, device names (CON, NUL, COM1, ...) get a leading `_`, and `.`, `..` and empty
  names are skipped. A second entry with the same name (Drive allows it) is skipped. Every path is checked to stay
  inside the target folder.
- **Download**: each file from `drive.usercontent.google.com` (`confirm=t`), 6 at a time, to `<name>.playout-part`
  then renamed. 429, 5xx, network errors, a short file (fewer bytes than its `content-length`; not checked for a compressed answer, whose `content-length` is
  the size on the wire), a stalled download
  (60 s) and a web page instead of a file (Drive's download limit) are retried, 5 attempts, waiting 1, 2, 4, 8 s (or
  the server's `Retry-After`, at most 60 s). A 404 fails at once.
- **Resume**: the files go into `<root>\.RPCS3.drive`, which is kept when the download fails. A file present there
  under its own name is complete (only complete files are renamed), so the next run downloads only the missing ones.
- **Progress**: the setup bar shows "x of y files" (`EmulatorSetupProgress.filesDone` / `filesTotal`; the sizes are not
  known up front).
- **Checks and move**: no `rpcs3.exe` in the downloaded folder fails with "rpcs3.exe is not in the Drive folder"
  (the download is kept). Then `.playout-drive.json` (folder id and version) is written into it and it is moved into
  place like an unpacked archive. An `RPCS3` folder that is already there without its exe is handled by its marker:
  an earlier Drive install (interrupted) gets the Drive copy over it; a folder of the user's own RPCS3 (antivirus took
  its exe, a broken update) is kept aside whole as `RPCS3.playout-old-<date>` and the Drive copy takes its place, so
  its settings are never overwritten.
- **Configure**: first `localizeRpcs3Vfs` sets `/dev_flash/`, `/dev_flash2/`, `/dev_flash3/`, `/dev_bdvd/` and
  `/dev_hdd1/` back to `$(EmulatorDir)<name>/` when `config\vfs.yml` gives an absolute path that does not exist on
  this PC (the other PC's). Then the usual RPCS3 configure: `/dev_hdd0/` and `/games/` are replaced by the data
  folder's (other keys and lines kept), and the save, trophy and save-state links are made, so the library and the
  Emulation folder sync work as for any RPCS3.
- **Manifest**: version `drive-<YYYY-MM-DD>` (the download date) and `source: 'drive-folder'`. An install the manifest
  lost is recognised by `.playout-drive.json` when it is adopted.
- **Presets**: none. Fullscreen, pads, the Welcome box, Big Picture and the PS button stay as the preconfigured copy
  has them, at install and for every later `PRESETS_VERSION` (the service skips any emulator whose manifest entry has
  `source: 'drive-folder'`).
- **Updates**: the setup never replaces a Drive-sourced RPCS3 (it only installs missing emulators). Update all
  emulators (see "Updates") puts RPCS3's newest official build over it, the way RPCS3's own updater does: only the
  program files, so the copy's settings, firmware and patches stay, and its manifest entry keeps
  `source: 'drive-folder'` (no presets). To take a newer copy from the Drive folder instead, delete `<root>\RPCS3` and
  run the setup again (Settings › Emulators); the PS3 games and saves live in the data folder and are not affected.
- **Firmware**: the folder brings `dev_flash`, so the BIOS sync finds `dev_flash\vsh\module\vsh.self` and never runs
  `--installfw`.
- **Runtimes**: the Visual C++ runtime is still ensured (RPCS3's `runtimes: ['vcredist']`).

## Updates (Update all emulators)

Settings › Emulators › PlayOut emulators › **Update all** puts the newest build of each installed emulator's update
channel (`EmulatorSpec.update`, `update-sources.ts`) over it. The channel is the nightly / dev one where the project
publishes one, read from the same feed the emulator's own updater uses where it has one. None of the built-in updaters
can be run without its window (checked 2026-11-18: DuckStation's and PCSX2's `updater.exe` show a window and restart
the emulator; RPCS3's `--updating` is internal; Dolphin's `Updater.exe` needs the installed build's manifest; mGBA,
Ryujinx and ScummVM's WinSparkle are GUI-only), so PlayOut reads the feed and applies the build itself, as those
updaters do.

| Emulator    | Channel     | Feed                                                                                                            |
| ----------- | ----------- | --------------------------------------------------------------------------------------------------------------- |
| DuckStation | preview     | GitHub release under the moving tag `preview` (its updater's "Preview Releases"); version = tag + date + digest |
| PCSX2       | nightly     | newest GitHub release, pre-releases included (the nightlies its updater offers)                                 |
| RPCS3       | nightly     | `update.rpcs3.net` api v3 (its updater's), SHA-256 and size checked                                             |
| Dolphin     | dev         | `dolphin-emu.org/update/latest/dev/` (its updater's service, dev track)                                         |
| PPSSPP      | dev         | `builds.ppsspp.org/meta/status.json` `latest` (never `building`)                                                |
| Flycast     | dev         | the `flycast-builds` S3 listing, newest `win/heads/master-<sha>/flycast.zip` by date                            |
| Azahar      | pre-release | newest GitHub release (release candidates; no nightlies); MSVC zip first (needs Visual C++), MSYS2 second       |
| melonDS     | nightly     | `melonds.kuribo64.net/nightlies.php`, first Windows x86_64 row, its SHA-256                                     |
| mGBA        | dev         | `mgba.io/latest.ini` `[platform.win64] dev.*` (its updater's), SHA-256 and size                                 |
| Ryujinx     | canary      | `update.ryujinx.app/latest/query?rc=canary` (its updater's)                                                     |
| ScummVM     | daily       | `buildbot.scummvm.org/dailybuilds/master/windows-x86-64-master-latest.zip`; version = date + ETag (HEAD)        |
| MAME        | stable      | no nightlies are published: its newest GitHub release                                                           |
| RetroArch   | nightly     | libretro buildbot `nightly/windows/x86_64/`: `RetroArch_update.7z` (program only) + `RetroArch_cores.7z`        |
| Model 2     | none        | frozen at 1.1a: reported as "no newer builds"                                                                   |

A run (one at a time, after any setup run; a second press joins it):

1. Every catalog emulator whose exe is in the root is a candidate (orphans are adopted first). One without a channel
   is reported `unavailable`.
2. The Visual C++ / DirectX runtimes the candidates need (`runtimes` and `update.runtimes`) are ensured.
3. Per emulator, 3 at a time:
   - one whose exe name is running (tasklist), or that PlayOut began launching less than `LAUNCH_QUIET_MS` (15 s)
     ago, is left alone: `running`. An unreadable process list fails it (`failed`, nothing touched);
   - the feed is read; the same version as the manifest's: `current`, nothing downloaded;
   - the build is downloaded (checksum and size when published) and unpacked into `<root>\.<folder>.updating` (the
     setup's extraction: one top folder flattened; RetroArch's two parts merged); no exe there fails it;
   - from here a launch of that emulator waits (`beforeLaunch` gate) until its files are swapped and its folders are
     set. With the gate up it is checked again for running, then **overlaid** (`overlay.ts`): each file of the build
     replaces the installed one, and every other file stays (settings, saves, `portable.txt`). Nothing is deleted. A
     path that is a junction or link in the installed folder (the links into the data Emulation folder) is never
     written through. Files in the spec's `keep` list (RetroArch's `retroarch.cfg`) are not replaced when present;
   - each replaced file is first moved to `<root>\.playout\update-backup\<folder>` (renames retried through
     antivirus locks), and every step is first written to `<folder>.journal` next to it. Any error puts the folder
     back exactly; a backup is deleted only when every file went back. When the new exe is there, the overlay is
     committed (the journal deleted first, then the backup);
   - PlayOut closing waits for a swap in progress (`dispose`, bounded). A swap cut short anyway (or an undo that could
     not put every file back) is undone at the next start from its journal (`recoverInterruptedUpdates`, before
     anything reads the folders), and before the next update of that folder; one that still cannot be undone keeps
     its backup, shows a notice and blocks updates of that emulator. A backup without a journal belongs to a
     committed overlay and is deleted;
   - its folders are pointed at the data folder again (configure). The presets are not applied again, so the user's
     settings stay;
   - the manifest records the new `version`, `channel` and `updatedAt` (a stop before this only means the next
     update puts the same build in again).
4. The report (`EmulatorSetupStatus.lastUpdate`, in catalog order) lists each emulator: updated (from → to), current,
   running, failed (the installed build kept) or unavailable. Settings shows it under the button, and a toast sums it
   up when the run ends.

The progress is the setup's (`stage: 'updates'`): the bottom bar reads "Updating emulators · names · x of y · MB".

## Configure (D is the data Emulation folder, E the emulator folder)

### General rules

- Write only folder keys, into files the emulator completes with defaults.
- Where a partial config would lose defaults, use NTFS directory junctions instead:
  - DuckStation and PCSX2 write default controller bindings only when their ini is missing;
  - Ryujinx loads zeros for any key a partial Config.json leaves out.
- Every target folder is created first.
- `link(linkPath, target)` (`junction.ts`) works like this:
  - It makes `target`.
  - If `linkPath` is already a junction, it is re-pointed if needed. Only the link is removed, never through it.
  - If `linkPath` is a real folder, its contents are moved into `target` first, without overwriting anything there.
    Leftovers are kept in `linkPath.playout-old` and logged.
  - It then creates the junction.

### Per emulator

| Emulator    | Portable trigger                                                 | Config written (only these keys)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Junctions                                                                                                                                                                                                                                                                                        |
| ----------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| DuckStation | `E\portable.txt`                                                 | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `E\bios`→`D\bios`, `E\memcards`→`D\saves\duckstation\saves`, `E\savestates`→`D\saves\duckstation\states`, `E\textures`→`D\texturepacks\duckstation`                                                                                                                                              |
| PCSX2       | `E\portable.txt`                                                 | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `E\bios`→`D\bios`, `E\memcards`→`D\saves\pcsx2\saves`, `E\sstates`→`D\saves\pcsx2\states`, `E\textures`→`D\texturepacks\pcsx2`                                                                                                                                                                   |
| RPCS3       | none needed (never create `E\portable`)                          | `E\config\vfs.yml`: `/dev_hdd0/: <D>/Updates and DLC/PS3/dev_hdd0/`, `/games/: <D>/roms/ps3/`. Forward slashes, trailing `/`, top-level YAML keys, others kept. A real `D\storage\rpcs3\dev_hdd0` (PlayOut's place before 0.1.109), a real `D\roms\PS3 HDD` (before 0.1.120; renamed whole when the new place is missing, else merged; its savedata/trophy junctions are made again, not copied) and a real `E\dev_hdd0` (RPCS3's default place) are first moved into `D\Updates and DLC\PS3\dev_hdd0` entry by entry (the files already there win; what was not moved stays in `<folder>.playout-old`). | `D\Updates and DLC\PS3\dev_hdd0\home\00000001\savedata`→`D\saves\rpcs3\saves`, `…\00000001\trophy`→`D\saves\rpcs3\trophy`, `E\savestates`→`D\saves\rpcs3\states`                                                                                                                                 |
| Dolphin     | `E\portable.txt`                                                 | `E\User\Config\Dolphin.ini` `[General]`: `ISOPaths = 2`, `ISOPath0 = D\roms\gc`, `ISOPath1 = D\roms\wii`, `RecursiveISOPaths = True`                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `E\User\GC`→`D\saves\dolphin\GC`, `E\User\Wii`→`D\saves\dolphin\Wii`, `E\User\StateSaves`→`D\saves\dolphin\states`, `E\User\Load\Textures`→`D\texturepacks\dolphin`                                                                                                                              |
| PPSSPP      | none (never create `installed.txt`)                              | `E\memstick\PSP\SYSTEM\ppsspp.ini` `[General]` `CurrentDirectory = <D>/roms/psp`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `E\memstick\PSP\SAVEDATA`→`D\saves\ppsspp\saves`, `…\PPSSPP_STATE`→`D\saves\ppsspp\states`, `…\TEXTURES`→`D\texturepacks\ppsspp`                                                                                                                                                                 |
| Flycast     | always portable                                                  | `E\emu.cfg` `[config]`: `Dreamcast.BiosPath = D\bios;D\bios\dc`, `Dreamcast.VMUPath = D\saves\flycast\saves`, `Dreamcast.SavePath = D\saves\flycast\saves`, `Dreamcast.SavestatePath = D\saves\flycast\states`, `Dreamcast.TexturePath = D\texturepacks\flycast`                                                                                                                                                                                                                                                                                                                                         | none                                                                                                                                                                                                                                                                                             |
| Azahar      | the `E\user\` folder                                             | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `E\user\sysdata`→`D\bios\azahar\keys`, `E\user\sdmc`→`D\saves\azahar\saves`, `E\user\states`→`D\saves\azahar\states`, `E\user\load`→`D\texturepacks\azahar`                                                                                                                                      |
| melonDS     | always portable (never create `E\portable`)                      | `E\melonDS.toml`: `[Instance0]` `SaveFilePath`, `SavestatePath` (`D/saves/melonds/saves`, `…/states`), `CheatFilePath` (`D/storage/melonDS/cheats`); `[DS]` `BIOS9Path`, `BIOS7Path`, `FirmwarePath` (`D/bios/bios9.bin`, `bios7.bin`, `firmware.bin`); `[DSi]` `BIOS9Path`, `BIOS7Path`, `FirmwarePath`, `NANDPath` (`D/bios/dsi_bios9.bin`, `dsi_bios7.bin`, `dsi_firmware.bin`, `dsi_nand.bin`). Double-quoted, forward slashes. `ExternalBIOSEnable` stays default.                                                                                                                                  | none                                                                                                                                                                                                                                                                                             |
| mGBA        | `E\portable.ini` (shipped; create if missing)                    | `E\config.ini` `[ports.qt]`: `savegamePath = D\saves\mgba\saves`, `savestatePath = D\saves\mgba\states`, `cheatsPath = D\storage\mgba\cheats`, `patchPath = D\storage\mgba\patches` (written as `key=value`). BIOS keys come from the BIOS sync.                                                                                                                                                                                                                                                                                                                                                         | none                                                                                                                                                                                                                                                                                             |
| Model 2     | always portable (runs from its folder)                           | `E\EMULATOR.INI` `[RomDirs]` `Dir1=D\roms\model2`. Every other line of the shipped file is kept.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `E\NVDATA`→`D\saves\model2\saves`, `E\STATES`→`D\saves\model2\states`                                                                                                                                                                                                                            |
| Ryujinx     | the `E\portable\` folder                                         | none (never write Config.json)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `E\portable\bis\user\save`→`D\saves\ryujinx\saves`, `E\portable\bis\system\save`→`D\saves\ryujinx\system_saves`, `E\portable\bis\user\saveMeta`→`D\saves\ryujinx\saveMeta`, `E\portable\mods`→`D\texturepacks\ryujinx`. `E\portable\system` is a real folder; the BIOS sync copies keys into it. |
| ScummVM     | `E\scummvm.ini` exists                                           | `[scummvm]` `savepath=D\saves\scummvm\saves`, `extrapath=D\bios` (MT-32 ROMs). `key=value` with no spaces.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | none                                                                                                                                                                                                                                                                                             |
| MAME        | runs with cwd = E                                                | If `mame.ini` is missing, run `mame.exe -createconfig` (cwd E, 60 s). If that fails, start a new file. Then set: `rompath D\roms\arcade;D\roms\mame;D\bios;D\bios\mame;roms`, `samplepath D\storage\mame\samples;samples`, `artpath D\storage\mame\artwork;artwork`, `ctrlrpath D\storage\mame\ctrlr;ctrlr`, `cheatpath D\storage\mame\cheat;cheat`, `inipath .;D\storage\mame\ini;ini;ini\presets`, `nvram_directory D\saves\mame\saves`, `state_directory D\saves\mame\states`. Format is `name<spaces>value`; quote the value if it contains `#`. Delete `mame.sym` (125 MB of debug symbols).        | none                                                                                                                                                                                                                                                                                             |
| RetroArch   | `E\retroarch.cfg` exists, so `%APPDATA%\RetroArch` is never used | `system_directory = "D\bios"`, `savefile_directory = "D\saves\retroarch\saves"`, `savestate_directory = "D\saves\retroarch\states"`, `rgui_browser_directory = "D\roms"`. Values always double-quoted. Cores come from `RetroArch_cores.7z` into `E\cores`.                                                                                                                                                                                                                                                                                                                                              | none                                                                                                                                                                                                                                                                                             |

### Config helpers (`ini.ts`)

These keep every line they do not touch, preserve CRLF/LF, and write UTF-8 without a BOM.

- `setIniValues(file, section, values, {style})`:
  - `style` is `'spaced'` (`key = value`) or `'tight'` (`key=value`).
  - It creates the file and the section when missing.
  - It replaces the first uncommented line of a key inside its section. A commented `;key=` line is left alone and a
    new line is added under the section header.
  - Section names compare case-insensitively.
- `setTomlValues(file, table, values)`: strings only.
- `setYamlTopLevel(file, values)`.
- `setMameIni(file, values)`.
- `setRetroArchCfg(file, values)`.
- `readIniSection(file, section)`: the raw body lines of the first matching section (case-insensitive), without the
  header and the blank lines after it; `null` when the file or the section is missing.
- `replaceIniSection(file, section, lines, {eol})`: replaces the whole body of the first matching section, or
  appends the section. Other sections and the blank separators stay. New files use CRLF unless `eol` is `'lf'`.

## Fullscreen and controllers (`presets/`)

At initial setup every emulator is set to start games in **fullscreen** and to drive an **XInput or SDL game
controller** (an Xbox pad). EmuDeck-WE is the reference for how, but EmuDeck's templates are never copied: only the
keys below are written and every other setting stays at the emulator's default. The source-level research behind
each choice was checked on 2026-11-11 against the installed versions.

### When the presets run

- `presets/index.ts` maps each find-rules id to its module (`presets/<name>.ts`, `applyPresets(ctx)`) and exports
  `PRESETS_VERSION` (1).
- The manifest's `presets` records the version applied per emulator id (missing in manifests before 0.1.84, read as
  `{}`).
- **After an install**: right after `configureEmulator`. A brand-new emulator folder drops the recorded version first
  (a folder the user deleted has none of its settings left).
- **At startup** (the reconfigure step, adopted emulators included): every installed emulator whose recorded version
  is missing or older. This covers installs made by 0.1.81 to 0.1.83.
- **Never** for an emulator installed from a Google Drive folder (`source: 'drive-folder'` in the manifest: RPCS3),
  whose own settings win.
- `ctx.firstTime` is true when no version was recorded. **Fullscreen is only switched on when `firstTime` is true**,
  so a user who later turns it off is not overridden. A newer `PRESETS_VERSION` runs the presets again with
  `firstTime` false.
- **Controllers** are written only when the emulator's controller config is missing or still the emulator's own
  untouched default; a mapping the user changed is never replaced. Where an emulator keeps several bindings per input
  (DuckStation, PCSX2: repeated keys) the keyboard defaults stay next to the pad.
- **First-run dialogs** are suppressed only where they would open over the fullscreen game (DuckStation's and PCSX2's
  setup wizard, Dolphin's analytics prompt, RPCS3's Welcome box, ScummVM's update question).
- Every write merges into the existing file (the emulator may have run already). Where a partial file loses defaults,
  the emulator's own complete file is used: DuckStation gets a full seed `settings.ini`, PCSX2 generates `PCSX2.ini`
  with `pcsx2-qt -testconfig`, and Ryujinx is started hidden (`ctx.startHidden`, `run.ts` `startHidden`) to save its
  default `Config.json`, then stopped (`taskkill /T /F`).
- The presets are skipped while a process with the emulator's exe name runs (one `tasklist /FO CSV /NH` per pass): the
  emulator would overwrite the files when it exits. They are retried at PlayOut's next start (a game launch never
  applies presets).
- A failure becomes a notice ("... was set up, but its fullscreen and controller settings could not be applied") and
  never fails the install. The version is then not recorded, so PlayOut's next start retries. Every preset is
  idempotent.

### Per emulator

| Emulator    | Fullscreen (first time only)                                                                                     | Controller                                                                                                                                                                                                                                                                                                                   | Also                                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| DuckStation | `settings.ini [Main] StartFullscreen = true`                                                                     | SDL: `[Pad1]` keyboard defaults plus `SDL-0/...` (DuckStation's own Automatic Mapping: A/B/X/Y names, `Analog = SDL-0/Guide`, motors); `[Pad2]` AnalogController on `SDL-1`. Multitap stays off.                                                                                                                             | Seed `settings.ini` when missing (controller, hotkey and input-source defaults); `SetupWizardIncomplete = false` |
| PCSX2       | `inis\PCSX2.ini [UI] StartFullscreen = true`                                                                     | SDL: `[Pad1]` keyboard defaults plus `SDL-0/...` (2.8 names FaceSouth/East/West/North, `Analog = SDL-0/Guide`, motors); `[Pad2]` DualShock2 on `SDL-1`. Multitap stays off.                                                                                                                                                  | Missing `PCSX2.ini` generated by `-testconfig`; `SetupWizardIncomplete = false`                                  |
| RPCS3       | Already the default (`Start games in fullscreen mode: true`); an existing `config.yml` with false is switched on | XInput: `config\input_configs\global\Default.yml`, players 1-4 = `"XInput Pad #1"`..`#4` (Handler and Device only; RPCS3 fills the native XInput mapping). Only when the file is missing (RPCS3 never writes it itself).                                                                                                     | `GuiConfigs\CurrentSettings.ini [main_window] infoBoxEnabledWelcome=false`                                       |
| Ryujinx     | `portable\Config.json` `start_fullscreen: true`                                                                  | SDL2: one `GamepadSDL2` ProController entry per detected pad (players 1-4; Xbox layout A=B/B=A unless the name says Nintendo), ids computed from the SDL GUID with Ryujinx's own `SDL2.dll`. Only while `input_config` is still the default keyboard. The ids PlayOut wrote are kept in `portable\playout-controllers.json`. | Before each launch see below                                                                                     |
| Dolphin     | `Dolphin.ini [Display] Fullscreen = True`                                                                        | XInput: `GCPadNew.ini` `[GCPad1-4]` on `XInput/0-3/Gamepad` (positional layout, `Motor L \| Motor R`); `WiimoteNew.ini` `[Wiimote1-4]` with Nunchuk and Classic mappings. A section is replaced only when missing or Dolphin's keyboard default. GC ports 2-4 get `SIDevice1-3 = 6` when absent; Wiimote sources stay.       | `[Analytics] PermissionAsked = True` (Enabled stays False: nothing is sent)                                      |
| Azahar      | `qt-config.ini [UI] fullscreen\default=false`, `fullscreen=true`                                                 | SDL GameController: profile 1 of `[Controls]` gets Azahar's own Auto-Map bindings (`api:controller`, `maptype:all`: any pad, no GUID), only when no profile-1 button is bound to anything but the keyboard.                                                                                                                  |                                                                                                                  |
| melonDS     | No setting exists: PlayOut's command already passes `-f`                                                         | SDL joystick 0: `[Instance0.Joystick]` integer bindings (positional Nintendo layout, D-pad on hat 0 combined with the left stick), only when every button key is absent or -1.                                                                                                                                               |                                                                                                                  |
| mGBA        | `config.ini [ports.qt] fullscreen=1` (the command also passes `-f`)                                              | SDL: `[gba.input.SDLB]` (A, B, LB=L, RB=R, Back=Select, Start, hat 0, left stick) plus the same keys in `[gba.input-profile.XInput Controller #1-4]` to override mGBA's stale built-in profile. Each section only when absent; one map serves players 1-4 (multiplayer windows).                                             |                                                                                                                  |
| Flycast     | `emu.cfg [window] fullscreen = yes`                                                                              | Native: Flycast maps any SDL GameController itself (pads 0-3 on ports A-D). For players 2-4 `[input] device2-4 = 0` (Sega Controller) when absent; VMU slots stay None.                                                                                                                                                      |                                                                                                                  |
| PPSSPP      | `ppsspp.ini [Graphics] FullScreen = True`                                                                        | Native: the Windows defaults map the XInput pad in slot 1. Nothing is written (a partial `controls.ini` would unmap everything else).                                                                                                                                                                                        |                                                                                                                  |
| RetroArch   | `retroarch.cfg video_fullscreen = "true"` (borderless, `video_windowed_fullscreen` stays default)                | Native: the `xinput` joypad driver and autoconfig map pads on ports 1-4. `input_joypad_driver = "xinput"` and `input_autodetect_enable = "true"` are written only when absent; no `input_playerN_*` binds.                                                                                                                   |                                                                                                                  |
| MAME        | Already the default (`window 0`), written out the first time                                                     | Native: `joystick 1` and `joystickprovider auto` (winhybrid: XInput pads via XInput, players 1-4), written only when absent. No `cfg\default.cfg`.                                                                                                                                                                           |                                                                                                                  |
| Model 2     | `EMULATOR.INI [Renderer] AutoFull=1` (640x480 stays)                                                             | `[Input] XInput=1` while still the shipped 0, and only when `xinput1_3.dll` (DirectX 9 runtime) is present: without it the emulator crashes. Button maps stay per game (`CFG\<romset>.input`).                                                                                                                               |                                                                                                                  |
| ScummVM     | `scummvm.ini [scummvm] fullscreen=true`                                                                          | Native: SDL joystick 0 as a GameController (`joystick_num=0` written only when absent); one controller only.                                                                                                                                                                                                                 | `updates_check=0` while absent (the update question is modal)                                                    |

### PCSX2 settings (presets version 3, `pcsx2.ts` `PCSX2_SETTINGS`)

The user's choices for PCSX2 (2026-11-13), written to `inis\PCSX2.ini` once (`newSince(ctx, 3)`: new installs and,
once, existing ones), each only while absent or still PCSX2's default (a number compares as a number, so
`1.000000` is the default `1`). Keys and defaults checked against PCSX2 2.8.2 (`Pcsx2Config.cpp`,
`FullscreenUI_Settings.cpp`):

| Setting                                  | Key                                                | Default        |
| ---------------------------------------- | -------------------------------------------------- | -------------- |
| Confirm Shutdown off                     | `[UI] ConfirmShutdown = false`                     | true           |
| EE Cycle Rate 180% (Overclock)           | `[EmuCore/Speedhacks] EECycleRate = 2` (-3..3)     | 0              |
| Enable Cheats                            | `[EmuCore] EnableCheats = true`                    | false          |
| Apply Widescreen Patches                 | `[EmuCore] EnableWideScreenPatches = true`         | false          |
| Apply No-Interlacing Patches             | `[EmuCore] EnableNoInterlacingPatches = true`      | false          |
| Vertical Sync                            | `[EmuCore/GS] VsyncEnable = true`                  | false          |
| Aspect Ratio 16:9                        | `[EmuCore/GS] AspectRatio = 16:9`                  | Auto 4:3/3:2   |
| FMV Aspect Ratio Override, Auto Standard | `[EmuCore/GS] FMVAspectRatioSwitch = Auto 4:3/3:2` | Off            |
| Internal Resolution 3x Native            | `[EmuCore/GS] upscale_multiplier = 3`              | 1              |
| Load Textures                            | `[EmuCore/GS] LoadTextureReplacements = true`      | false          |
| FXAA                                     | `[EmuCore/GS] fxaa = true`                         | false          |
| Shade Boost                              | `[EmuCore/GS] ShadeBoost = true`                   | false          |
| Anti-Blur                                | `[EmuCore/GS] pcrtc_antiblur = true`               | true (already) |
| Audio Buffer Size 30 ms                  | `[SPU2/Output] BufferMS = 30`                      | 50             |
| Enable Achievements                      | `[Achievements] Enabled = true`                    | false          |

Achievements still need the user's RetroAchievements sign-in inside PCSX2; PlayOut passes no credentials to it.

### Ryujinx before each launch

Ryujinx binds each `input_config` entry to one concrete pad id, so a pad plugged into another port or swapped would be
ignored. The launcher calls an optional `beforeLaunch(emulatorId, exe)` hook just before it spawns an emulator game
(`ResolvedLaunch.emulatorId` is the `%EMULATOR_X%` id of the command). `index.ts` wires it to the emulator setup's
`beforeLaunch`, which, for the Ryujinx PlayOut installed (the exe matches the manifest's), runs
`refreshRyujinxControllers`: it detects the connected pads again and updates only the entries PlayOut wrote. It is
cut off after 5 s and its errors are only logged: it never blocks or fails the launch.

## Big Picture and the controller menu (`presets/big-picture.ts`)

Presets version 2 (0.1.93). Emulators with a controller-driven fullscreen interface start in it when opened by
themselves, and **Start + Select** on the first pad (the user's choice) opens their in-game menu. Guide stays
PlayOut's home button, so the defaults that put an emulator menu on Guide are moved off it. EmuDeck-WE (c4350af6)
was the reference: it never turns Big Picture on itself, it starts games fullscreen and binds the pause-menu
hotkeys (its own chords: Start + L3, Back + Start to quit), which are not copied.

### When it runs

- `ctx.previousVersion` is the version the presets last ran at (`undefined`: never; `0`: a deferred first run).
  `newSince(ctx, 2)` is true until version 2 was recorded, so each setting below is applied **once**, to new and
  existing installs alike; a user who turns it off later is never overridden.
- Each setting is also only written while it is absent or still the emulator's default, and a pad binding is only
  added to a hotkey that has none: a binding the user chose stays.

### Per emulator

| Emulator    | Big Picture on start                                                                                                                                         | Start + Select                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Launch command                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| PCSX2       | `[UI] StartBigPictureMode = true` (a ROM launch boots over it)                                                                                               | `[Hotkeys] OpenPauseMenu = SDL-0/Back & SDL-0/Start`, after the keyboard line (repeated keys are a binding list)                                                                                                                                                                                                                                                                                                                                                                                                                                        | unchanged (`-batch`)                                                                    |
| DuckStation | `[Main] StartFullscreenUI = true` (also in the seed)                                                                                                         | `[Hotkeys] OpenPauseMenu = SDL-0/Back & SDL-0/Start` (also in the seed)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | unchanged (`-batch`)                                                                    |
| RPCS3       | `config.yml Miscellaneous: Start Big Picture Mode on boot: true` (only used without a boot target; a missing file gets this key alone, RPCS3 fills the rest) | `Default.yml` players 1-4 `Config: PS Button: Start&Back`, replacing RPCS3's XInput default `Guide,Start&Back` (RPCS3 restores handler defaults before loading, so the other buttons keep theirs). Version 1's file is upgraded as a whole; a dialog-written file only where the PS button is still the default.                                                                                                                                                                                                                                        | unchanged (`--no-gui`)                                                                  |
| PPSSPP      | n/a (the whole UI is pad-driven)                                                                                                                             | `controls.ini [ControlMapping] Pause`: Guide `20-3` out, chord `20-108:20-109` in, only while the line is PPSSPP's default. Waits (`PresetDeferredError`) until PPSSPP wrote controls.ini: a partial one unmaps everything.                                                                                                                                                                                                                                                                                                                             | `--pause-menu-exit` (`build-systems.mjs` `COMMAND_CHANGES`): the pause screen gets Exit |
| RetroArch   | n/a                                                                                                                                                          | `input_menu_toggle_gamepad_combo = "4"`; `input_menu_toggle_btn = "99"` (frees Guide: `"nul"` falls back to the autoconfig's Guide); `quit_on_close_content = "2"` (Close Content quits a command-line launch). Each only while at the default. Pads 2-8 take the menu button from their autoconfig profile only, so the `autoconfig\xinput\*.cfg` lines `input_menu_toggle_btn = "10"` become `"nul"` (once; RetroArch's Update Controller Profiles brings them back). A pad that matches no file uses the built-in XInput profile, which keeps Guide. | unchanged                                                                               |
| Flycast     | n/a                                                                                                                                                          | Nothing written: Back already opens its menu (`sdl_gamepad.cpp`), and Exit quits after a command-line start.                                                                                                                                                                                                                                                                                                                                                                                                                                            | unchanged                                                                               |
| ScummVM     | n/a                                                                                                                                                          | Nothing written: Start is the Global Main Menu's default.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | unchanged                                                                               |
| Others      | Dolphin, Azahar, melonDS, mGBA, Ryujinx, Model 2 and MAME have no controller menu: PlayOut's home overlay quits them.                                        | –                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | –                                                                                       |

Start + Select is also Winhanced's Game Bar combo (View + Menu); the home button's "Turn off Xbox Game Bar"
(docs/home-overlay.md) keeps Game Bar from opening over the menu. The Guide bindings PlayOut's version 1 gave
in-game buttons (PCSX2 / DuckStation `Analog`, Dolphin and Azahar `Home`) are unchanged.

### PCSX2's game list (`pcsx2-game-list.ts`)

Big Picture's **Game Properties** (in the pause menu) opens only for a game in PCSX2's game list:
`FullscreenUI::SwitchToGameSettings` looks the running disc up by path, then by serial and CRC, and does nothing
without an entry. PlayOut starts PCSX2 with `-batch` (PCSX2 then exits when the game shuts down, which ends PlayOut's
session; no setting replaces it), and in batch mode PCSX2 only loads `cache\gamelist.cache`
(`GameList::Refresh(false, true)`), never scanning: a game it never scanned has no entry, and neither has one whose
file changed since (`AddFileFromCache` requires the cached modification time). PlayOut gets the games listed in the
background, so a launch never waits for a scan.

The checks, for the PCSX2 PlayOut installed (`listPcsx2Games`; `ensurePcsx2GameListed` for one game):

1. Skips a file PCSX2's game list never holds (`IsScannableFilename`: .iso .bin .img .mdf .gz .cso .zso .chd .elf)
   and one under an `ExcludedPaths` entry (a case-sensitive prefix, as PCSX2 checks it).
2. Reads `PCSX2.ini` once (`ini.ts` `iniSectionOf` for `[GameList]` and `[Folders]`) and parses `gamelist.cache` once.
   The cache is read as PCSX2 writes it (`WriteEntryToCache`: u32 signature and version, then per record five
   u32-length strings, u8 type, u8 region, u64 size, u64 modification time, u32 CRC, u8 compatibility; a later record
   of a path wins). Its path is compared with separators collapsed and case ignored (PCSX2 builds it from the folder
   string as written), and its modification time with the file's, in whole seconds.
3. **Read-only while nothing must change**: with the game's folder covered by a `Paths` or `RecursivePaths` entry and a
   current record (or an image given up on, below), it returns without a process list. Whether PCSX2 runs
   (`tasklist`) is asked only before a write, and nothing is written while it does (a running PCSX2 writes its
   settings files when it exits): adding the folder, starting a scan, or putting back a cut-short scan's settings.
4. Adds the game's folder as `[GameList] Paths` (repeated key) when no entry covers it. This also happens right before
   a launch: it is cheap.
5. The hidden scan (never at a launch: `scan: false` there returns `pending`): starts `pcsx2-qt.exe` without
   arguments through `startHidden` (Windows applies the hidden start to its main window, so nothing shows; checked on
   2.8.2: every window stayed hidden). Without `-batch` it scans its folders. For that run `[UI]
StartBigPictureMode` (Big Picture opens a window of its own) and `[AutoUpdater] CheckAtStartup` (its dialog would
   show) are off; both are put back only after PCSX2 exited, because PCSX2 writes the whole PCSX2.ini when it exits.
   `.playout-scan-restore.json` next to PCSX2 keeps the values to put back, so a cut-short run is repaired before the
   next PCSX2 step and at PlayOut's start (only while no PCSX2 runs). It runs until every game of the batch has its record
   (then at once) or to its time limit, then asks PCSX2 to close (`run.ts` `close()`: `taskkill` without `/F`, so it saves
   and exits), killing it after 10 s. A `shouldStop` answer of true ends it the same way (`aborted`).
6. **Images PCSX2 does not list** (it cannot read them, or PCSX2 stalled: from outside the two look the same): a
   per-image attempt counter. After a scan that ran to its time limit (or PCSX2 exited by itself), each game of the
   batch without a record gets one more attempt in `.playout-unlisted.json` next to PCSX2 (keyed by path, size and
   modification time, with the time of its last attempt, and the PCSX2 executable's size and modification time; at
   most 500, the oldest dropped). An image with 2 attempts is not scanned again (`unlisted`) until its file changes
   (it starts again at one), the PCSX2 executable changes (a PCSX2 update may read it: the whole file is dropped) or
   14 days after its last attempt. A game listed later is removed from the file. A run that was stopped counts nothing:
   a launch, setup or quitting (`shouldStop`), another PCSX2, a game session, or a poll that slept far longer than
   asked (> 5 s on a monotonic clock: the PC was suspended). Nor does a run that listed some games of its batch
   before its time ran out or PCSX2 quit (the rest may only not be reached yet, in a large or slow library: they are
   counted only by a run that lists none of the batch). A PCSX2 that quit by itself and listed nothing (it crashed on
   an image, or could not run: blocked by Windows security, a missing runtime) does count, so it is not started again
   after every session, but those entries last one day (`UNLISTED_EXIT_TTL_MS`), not 14: the cause may be fixed
   without PCSX2 changing. So a game PCSX2 merely did not reach in one run is never
   given up on, and a batch of only unreadable images costs two background runs, not one after every session. (No
   extra backoff for a pass whose set is unchanged: the counter already bounds it to two runs per image.) While it
   scans it checks every 2 s (`tasklist` filtered by image and without the hidden PCSX2's pid) whether another PCSX2
   runs (one the user started, PlayOut's setup or update); if so it closes the hidden one and, while the other still
   runs, leaves the settings and the marker as they are (that PCSX2 writes PCSX2.ini when it exits). The service then
   checks every 60 s (an unref'd timer, cleared on `dispose()`) and puts them back as soon as no PCSX2 runs, then
   stops checking; the next pre-warm pass (a session's end, a library scan), the next PCSX2 launch's step and
   PlayOut's start also put them back, whichever first finds no PCSX2 running.
7. **The read-only phase** stops between two games when asked, and a game file whose stat takes more than 2 s is
   skipped for that pass. The pre-warm runs it outside the PCSX2 step queue (`pcsx2GamesNeedingWork`), so a launch
   only waits for the scan part, and passes only the games that need a folder or a scan to the queued step.

**At a launch** (`beforeLaunch`, with the game's file, `LaunchPlan.rom`): steps 1-4 only. A game PCSX2 does not list
yet starts at once (without Game Properties that first time) and is queued for the pre-warm.

**The pre-warm** (`prewarmPcsx2()`, debounced 5 s): the library's PS2 games that a launch starts in PCSX2 standalone (`pcsx2Roms`: `launch.systemId` `ps2`
and `launchesWith(system, game, settings, 'PCSX2')`, the command `selectCommand` picks)
plus the ones queued at a launch, at most 300 per hidden scan (a scan lists every folder at once), with a 60 s limit.
It is asked for:

- after every session ends (`index.ts` `session:ended`: catch-up of what was queued);
- when the library changed through a scan (`library:changed` `scan`: new PS2 ROMs);
- after PlayOut's start (`startup`, when PCSX2 is installed) and after PCSX2's presets were applied (install).

It runs only while no game session runs (`isGameRunning`: the launcher's `running()`), not within 30 s of an emulator
launch (its emulator may not show as a session yet; tried again once that time is over), and only while no PCSX2
runs. Every launch (`beforeLaunch`, any emulator) stops a running pre-warm scan; a PCSX2 launch's own step is chained
after it on the same queue (`pcsx2Step`, one PCSX2 step at a time), so the hidden PCSX2 has exited and its settings
are back before the game's PCSX2 starts. A game session that starts while it scans (a store game) stops it within
250 ms. Setup runs and reconfigures (`exclusive()`) stop a pre-warm scan and wait for its step first; no pass runs
while one is queued, and the pass comes back once they are done. A pre-warm asked for while a pass runs runs again
after it. Quitting (`dispose()`, awaited by `index.ts`'s before-quit, at most 5 s) stops a scan the same way: PCSX2
is asked to close and the settings go back.

Measured on this PC before the pre-warm existed: about 2.4 s the first time a game was played (a hidden scan before
the launch), up to 20 s for an image PCSX2 never lists (on every launch), plus a process list (~0.36 s) on every
launch. Now a launch of a listed game reads two files and stats one.

### PCSX2 still closing

Right after a PCSX2 game PlayOut started has ended (`context.endedMsAgo` under 15 s), a PCSX2 launch waits for that
PCSX2 to be gone, at most what is left of the 15 s: it still saves to the memory cards, and a second one started now
reports "Memory Card Read Failed". The launcher passes the ended game's process (`context.pid`, the spawned child), so
the wait probes it (`process.kill(pid, 0)`, EPERM counting as alive) every 500 ms without a process list; without a
pid it reads `tasklist` for the exe name as before.

### Focus at an emulator launch

The session tracker minimizes PlayOut (Minimize while playing) for an emulator game only once the emulator's window
took the foreground, which shows as PlayOut's window losing the focus (`WindowController.isFocused`, polled every
100 ms), or after 3 s at most (`SessionTiming.windowWaitMs`). Minimizing earlier handed the foreground to another
program while the emulator had no window yet, and Windows then kept the emulator's window behind it; now the emulator
comes up in front as when a game is dropped on it in Explorer. Store, Steam and other launches minimize as soon as the
game runs, as before.

### PCSX2's memory cards before each launch (`pcsx2-memory-cards.ts`)

PCSX2 locks a memory card file while it uses it, so its two slots can never use the same card: the second one fails
with "Memory Card Read Failed ... Another instance of PCSX2 may be using this memory card" (a misleading message: one
PCSX2 opened the file twice). It happens when a game's own settings (`gamesettings\SERIAL_CRC.ini`, written by Big
Picture's Game Properties) give one slot the card the other slot already uses. Seen on this PC: 007 - From Russia
with Love (`SLUS-21282_22DC8EAC.ini`) had `Slot1_Filename = Mcd002.ps2`, the global slot 2 card.

Right after the game list step (it needs the cache record for the serial and CRC: a game PCSX2 has not scanned yet
is left alone at that first launch, which is logged), the game's file gets the change below. The check is read-only;
whether PCSX2 runs is asked only when there is something to write, and nothing is written while it does:

- the other slot on the card the chosen slot would otherwise use (the two cards trade places for that game), when the
  game chose a card for one slot only;
- `Slot2_Enable = false` when there is no other card (both slots chosen, or PCSX2.ini itself names one card twice).

The chosen card, and the saves on it, stay where the user put them; nothing else in the file changes.

## BIOS sync (`bios.ts`)

The BIOS sync is idempotent. It runs after a setup, at every launch (in the background), and when D changes.

- **RPCS3** (the Google Drive copy brings its firmware, so this finds `vsh.self` and does nothing):
  - Looks for `D\bios\PS3UPDAT.PUP` or `D\bios\ps3\PS3UPDAT.PUP`.
  - If `E\dev_flash\vsh\module\vsh.self` is missing, it runs `rpcs3.exe --headless --installfw <pup>` (cwd E,
    10 min).
- **Ryujinx keys**: takes the first folder that has `prod.keys`, from `D\bios\ryujinx\keys`, `D\bios\switch`,
  `D\bios\yuzu\keys`, `D\bios\eden\keys`, `D\bios\citron\keys` and `D\bios`. It copies `prod.keys` and `title.keys`
  into `E\portable\system` when they are missing there or different.
- **Ryujinx firmware**:
  - Runs only when `E\portable\bis\system\Contents\registered` is missing or empty.
  - Takes the first folder that has `*.nca` files (or a `.zip` of them), from `D\bios\ryujinx\firmware`,
    `D\bios\switch\firmware`, `D\bios\yuzu\firmware`, `D\bios\eden\firmware` and `D\bios\citron\firmware`.
  - Each `<name>.nca` is copied to `registered\<id>.nca\00`, where `id` is the name up to its first `.`.
  - The files are written to a temp folder that is renamed into place.
- **Dolphin IPL**: copies `D\bios\GC\{USA,EUR,JAP}\IPL.bin` (also lower-case `gc`) to `E\User\GC\<region>\IPL.bin`
  when missing there.
- **mGBA**: sets `[ports.qt]` `gba.bios`, `gb.bios`, `gbc.bios` and `sgb.bios` to `D\bios\gba_bios.bin`,
  `gb_bios.bin`, `gbc_bios.bin` and `sgb_bios.bin`, each only when that file exists.
- **Folder-pointed emulators** need nothing more: PCSX2, DuckStation, RetroArch, Flycast, MAME, melonDS and ScummVM
  read D's bios folder through their config or junction, and Azahar reads it through its sysdata junction.

## Runtimes (`runtimes.ts`)

- **vcredist**:
  - Installed when `HKLM\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64` (or its WOW6432Node twin) has
    `Installed` = 1 and `Major` >= 14 and `Minor` >= 40.
  - Otherwise it downloads `https://aka.ms/vs/17/release/vc_redist.x64.exe` and runs it elevated with
    `/install /passive /norestart`.
  - Exit codes 0, 1638 and 3010 count as success. 1223 means the user declined the UAC prompt: that is a notice, not
    an error.
- **directx9**:
  - Installed when `%WINDIR%\SysWOW64\d3dx9_42.dll` and `xinput1_3.dll` exist.
  - Otherwise it downloads Microsoft's `directx_Jun2010_redist.exe` (100,275,120 bytes; the size is checked).
  - One elevated PowerShell script then extracts it with `/Q /T:<dir>` and runs `DXSETUP.exe /silent`.
- **Elevation**: `powershell -NoProfile -NonInteractive -EncodedCommand` runs
  `Start-Process -Verb RunAs -Wait -PassThru` and exits with the child's exit code.

## Emulator lookup

`createEmulatorResolver` takes `managed(id)`, which returns the installed exe from the manifest, else
`<root>\<folder>\<exe>` when that file exists (an install the manifest lost). It is tried after a
user override and before the find rules. The result is `foundBy: 'playout'`, shown in Settings as "Installed by
PlayOut".

## Launch commands left out or merged (`build-systems.mjs`)

`COMMAND_REMOVALS` drops ES-DE launch commands by system and label: **RPCS3 Shortcut (Standalone)** (ps3,
consolearcade) runs a Windows shortcut RPCS3 made through `cmd /C` and did not start games from PlayOut; such `.lnk` ROMs run through **RPCS3 (Standalone)** instead, which reads the shortcut (`%RPCS3_AUTO%` below).

`COMMAND_MERGES` folds several ES-DE commands into one, placed where the first of them was. ES-DE's RPCS3 Directory,
RPCS3 ISO and RPCS3 Game Serial are one command, **RPCS3 (Standalone)** (id `rpcs3-standalone`,
`%EMULATOR_RPCS3% --no-gui %RPCS3_AUTO%`): the only PS3 command, and one of consolearcade's (that system has no
Directory command). The merged command lists the ids and labels it replaced as `aliases` (`EmulatorCommand.aliases`),
so an ES-DE alternative emulator, a saved preferred emulator, a game's own choice or a scan's choice that names
`rpcs3-directory-standalone`, `rpcs3-iso-standalone`, `rpcs3-game-serial-standalone` or their labels runs it with no
warning (`findEmulatorCommand` in `src/shared/emulators.ts`, used by `selectCommand`, `emulatorIdForLabel` and the
Settings and game menus). Nothing is migrated in settings.

`COMMAND_DEFAULTS` moves PlayOut's default command, by id, to the top of a system's commands (the first command is
the default): ps3 `rpcs3-standalone`, ps2 `pcsx2-standalone`, psx `duckstation-standalone`, gba `mgba-standalone`,
switch `ryujinx-standalone`, gc and wii `dolphin-standalone`, n3ds `azahar-standalone`, psp `ppsspp-standalone`, and
the RetroArch cores gbc `gambatte`, nds `melonds-ds`, snes `snes9x-current`. The generator stops when an id is missing.
Ids are made before the move, so they stay as ES-DE's labels give them.

`NO_ARCHIVES` lists the standalone defaults that cannot open `.zip` / `.7z` ROMs. Where such a default's system accepts
archives (psx, gc, wii, n3ds, psp) the command gets `noArchives: true` (`EmulatorCommand.noArchives`), and
`effectiveEmulatorCommand` runs an archived ROM whose command is system-wide (the default, or the system's preferred
emulator in Settings) through the system's first RetroArch command instead (Beetle PSX, Dolphin, Azahar, PPSSPP cores),
which unpacks it. A requested emulator, the game's own choice and the scan's choice are used as they are, archive or
not. mGBA reads zip and 7z itself, so gba
has no mark. The generator stops when a marked system has no RetroArch command.

Which command runs is `effectiveEmulatorCommand` (`src/shared/emulators.ts`): the requested emulator, then the game's
own choice (`game.user.emulatorId`), then the scan's choice (`launch.emulatorId`), then
`settings.emulators.preferred[system]`, then the system's first command; a name that matches no command is skipped.
`selectCommand` (launch, with a warning per skipped name), the Play menu's current emulator and the game settings'
"Default (…)" (the same order without the game's own choice) all use it, so the menus show what a launch runs.

`%RPCS3_AUTO%` (`launch-command.ts` `rpcs3Target`) decides per game, and the log names the case:

| ROM                                                                                                                                                                                        | Passed to RPCS3                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| A folder (`Game.ps3\PS3_GAME\USRDIR\EBOOT.BIN` disc game, `USRDIR\EBOOT.BIN` PSN game, any other folder)                                                                                   | the folder                                                                     |
| A `.ps3` file of at most 4 KB, also `Game.ps3\Game.ps3`, holding a serial (four letters and five digits, `NPUB30024`)                                                                      | `%RPCS3_GAMEID%:NPUB30024` (literal; RPCS3 boots the game installed inside it) |
| A `.ps3` file of at most 4 KB holding anything else (empty too)                                                                                                                            | launch error "`<file>` does not hold a PS3 serial"                             |
| A `.lnk` (ES-DE's old Shortcut layout, made by RPCS3's "Create Shortcut") whose arguments hold `%RPCS3_GAMEID%:<serial>` (any case)                                                        | `%RPCS3_GAMEID%:<SERIAL>` (serial uppercased)                                  |
| A `.lnk` whose target is a game folder, `EBOOT.BIN`, `.iso`, `.self` or `.elf`, or whose target is `rpcs3.exe` with such a path in its arguments (relative to the shortcut's start folder) | that folder or file, decided as in the rows above and below                    |
| Any other `.lnk`, or one that cannot be read (Electron `shell.readShortcutLink`, Windows only)                                                                                             | launch error "`<file>` is not an RPCS3 game shortcut"                          |
| Any other file (`.iso`, `EBOOT.BIN`, `.self`, `.elf`, a larger `.ps3`)                                                                                                                     | the file                                                                       |
