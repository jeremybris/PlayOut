# PlayOut user guide

PlayOut is a full-screen, console-style launcher for the games on your Windows 11 PC: the ones installed
through Steam, Epic Games, GOG, EA App, Battle.net, Ubisoft Connect and the Xbox / Microsoft Store, the ROMs
you keep in an ES-DE-style folder tree, and any executable you add by hand. This guide walks through
installing it, filling the library, playing, the settings, the controls and what to do when something does
not work.

Contents

1. [Installing and first start](#1-installing-and-first-start)
2. [A tour of the home screen](#2-a-tour-of-the-home-screen)
3. [Adding games](#3-adding-games)
4. [Playing](#4-playing)
5. [Emulators](#5-emulators)
6. [Artwork and metadata](#6-artwork-and-metadata)
7. [Settings reference](#7-settings-reference)
8. [Controls](#8-controls)
9. [System bar and quick panel](#9-system-bar-and-quick-panel)
10. [Troubleshooting](#10-troubleshooting)
11. [Files and folders](#11-files-and-folders)

---

## 1. Installing and first start

**Requirements.** Windows 11 64-bit. Store games need their store client installed; emulated games need the
emulators (and their BIOS files) installed separately; a gamepad and an internet connection are optional.

**Installer or portable.** Both come from the `dist/` folder of a build (or from a release):

- `PlayOut-<version>-setup.exe` installs per user (no administrator prompt), creates Start-menu and desktop
  shortcuts and lets you pick the folder.
- `PlayOut-<version>-portable.exe` is one file: put it in a folder of its own and run it. A portable
  installation is a good place for an `Emulators\` folder next to the exe (section 5).

Both keep their data in `%APPDATA%\PlayOut` (section 11), so switching between them, reinstalling or
updating keeps your library, play times and settings.

**The Emulation folder.** Your saves, BIOS files, ROMs and favourites list live in the Emulation folder. A new
install makes it at `Documents\Emulation` on its first start (one already there, from an earlier install, is used as
it is). It is never inside PlayOut's own folders, so uninstalling or updating PlayOut never deletes it: Settings →
Library → **Emulation Folder** refuses a place inside PlayOut's install folder or its data folder (`%APPDATA%\PlayOut`).
An install from before this rule keeps the folder it had; if that folder is inside PlayOut's install folder, PlayOut
offers at start-up to move it to `Documents\Emulation` until you move it or answer **Not now** (until then the uninstaller leaves an `Emulation` folder
beside PlayOut.exe alone).

**Moving the Emulation folder.** Choosing another place in Settings → Library → **Emulation Folder** (**Choose**,
**Generate**, or **Default** for `Documents\Emulation`), or in Add games → ROM folder, moves the folder there. A sheet
first shows where from and where to, how much it holds (size and number of files) and, for another drive, the free
space there. On the same drive the folder is renamed, which is instant. On another drive everything is copied with a
progress bar (**Cancel** stops it: nothing is moved), the copy is checked, files written meanwhile are copied again,
PlayOut switches to it, and only then is the old folder deleted (a file that changed after its copy is never deleted:
it stays in the old folder, and PlayOut says how many stayed); file dates are kept, so the Emulation folder sync with your other PCs sees no change. Junctions
inside it (RPCS3's save links) are made again at the new place, never followed. If the new place already holds files,
you pick **Move into it** (files missing there are added; where both have a file, the newer one is kept, and an older
one it replaces is kept beside it as `.playout-old`; an older copy of yours stays in the old folder) or **Use as it
is** (nothing is moved). Nothing moves while a game, one of PlayOut's emulators, an emulator setup or update, a
conversion, or a paired PC's download from the folder is running, and while it moves PlayOut does not start games,
emulator setups or updates, conversions, recompilation installs or save syncs, or ROM downloads. If anything fails, the old folder and the setting
stay as they were. Afterwards the emulators are pointed at the new folder, the ROM folder (its `roms` folder)
follows, and the ROMs are scanned again.

**Favourites survive a reinstall.** PlayOut keeps a list of your favourites in the Emulation folder
(`PlayOut\Favorites\<PC name>.json`, written whenever a favourite changes). Uninstalling PlayOut leaves it there, and
so does deleting `%APPDATA%\PlayOut`: after a reinstall, each game's favourite comes back as the game comes back (the
first scans and store imports). A favourite you remove is kept in the list as removed for a year, so another PC's older
copy of the list does not bring it back. The list travels with the Emulation folder sync (section 4.3) and is read
again as soon as a sync brings another PC's list; another PC's list is read only while **Sync favourites with the host
/ clients** is on, and a change dated more than a day ahead of this PC's clock is ignored. A store game (Steam, Epic,
GOG...) gets its favourite back only by its own id; only a manual game (its exe moved) or a ROM (its file moved to
another folder) is also matched by its title or file name.

**First start.** PlayOut opens full screen. Press `F11` to switch to a window at any time, or start it with
`--windowed`. The library is empty, so the Recent row shows one dashed **Add Games** tile, already focused.
Press `Enter` (keyboard), **A** (gamepad) or tap it and continue with section 3.

**Language.** The first start picks PlayOut's language from Steam's (Steam › Settings › Interface), else from
Windows', when PlayOut has it, else English; after that it only changes in Settings → System → _Language_. Spanish
is a machine translation for now and marked so; most screens are still being moved into the language files, so some
text stays English. To add or correct a language, see [TRANSLATING.md](TRANSLATING.md).

**Starting with Windows.** Settings → System → _Launch at login_ registers PlayOut to start with your
Windows session. With the portable exe the entry points at the exe itself, so keep it in a fixed folder: if you
move or delete it, the toggle shows as off the next time you open Settings.

## 2. A tour of the home screen

- **Hero backdrop.** The focused game's hero art fills the screen (a blurred cover when the game has no hero
  art) with dark gradients on the left and at the bottom. Top-left: the game's logo (or its title) and a meta
  line such as `Played 19.6 hours · RPG · 2026 · Steam`.
- **System pill** (top right): search, volume, Bluetooth, Wi-Fi, battery, power and the clock. Section 9.
- **Settings** and **Exit** pills sit above the first row. _Exit_ opens the power menu (Exit PlayOut,
  Minimise, Sleep, Restart, Shut down).
- **Recent Games** row: the games you played last (how many is set in Settings → Appearance), followed by
  the **Add Games** tile. On a PC that is not paired with a host, these are the games installed on it. On a PC
  paired with a host (see Streaming), a game counts when it was played on this PC or on a PC it is paired with,
  installed here or not: a game you own but have not installed and a paired host's game appear
  greyed, as in the Library, and **A** opens their page (Install, Stream or Download). A game this PC can
  neither install nor stream is left out (one only another paired PC has, or one you uninstalled and no
  longer own), and so is a game that is not installed here and was never played. Hidden games, Settings →
  Library → _Show games that are not installed_ and Settings → Streaming → _Show games from paired computers_ apply to
  the row as they do to the Library.
- **One row per platform**: Steam, Epic Games, GOG, EA App, Battle.net, Ubisoft Connect, Xbox, PC (your
  manual games) and one row per emulated system that has games, each with a badge, the name and the count.
  Rows scroll vertically with the focused row kept at the same height; a chevron at the bottom hints that
  more rows follow. The last focused card of every row is remembered.
- **Cards** show the cover, the store badge and a focus ring when you navigate with a gamepad or keyboard.

## 3. Adding games

Open **Add Games** from the tile in the Recent row or from Settings → Library.

### 3.1 Store games

Each store has a card: _detected_ with a **Scan** button and the number of games found, or _not installed_.
PlayOut reads each client's local install records and never asks for your store password:

| Store                  | What PlayOut reads                                                                                                                                                                                                                         | How games launch                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Steam                  | `steamapps\appmanifest_*.acf` in every Steam library (`libraryfolders.vdf`); play time and last played from `userdata\<account>\config\localconfig.vdf`; art from Steam's `librarycache`                                                   | `steam://rungameid/<appid>`                                            |
| Epic Games             | The launcher's installation records (`%LOCALAPPDATA%\com.epicgames.eglv2\installations.jsonl` on current launchers, `%PROGRAMDATA%\Epic\EpicGamesLauncher\Data\Manifests\*.item` on older ones); DLC and Unreal Engine entries are skipped | `com.epicgames.launcher://apps/...?action=launch&silent=true`          |
| GOG                    | The `<id>_is1` uninstall entries created by GOG Galaxy and by GOG's offline installers, Galaxy's own database for anything else, and `goggame-<id>.info` in the game folder                                                                | Directly or through GOG Galaxy                                         |
| EA App                 | `__Installer\installerdata.xml` in the EA Games / Origin Games folders and in the install locations EA registered; the launcher exe must exist                                                                                             | Through the EA App (`origin2://` launch URI; the app starts if needed) |
| Battle.net             | `C:\ProgramData\Battle.net\Agent\product.db` plus the Battle.net uninstall entries (PTR / beta installs are skipped)                                                                                                                       | `Battle.net.exe --exec="launch <code>"`                                |
| Ubisoft Connect        | `HKLM\SOFTWARE\ubisoft\Launcher\Installs\<id>\InstallDir` and the launcher's configuration cache for names and art                                                                                                                         | `uplay://launch/<id>`                                                  |
| Xbox / Microsoft Store | The Store packages installed for your user (Xbox app and Game Pass games included)                                                                                                                                                         | `explorer.exe shell:AppsFolder\<package>!<app>`                        |

Rescans happen automatically: every start refreshes the sources that already have games and the ROM folder
(a few seconds after the window opens), and any scan can be repeated from Add Games or Settings → Library. A game that disappears
from the store's records is marked _not installed_ and stays in the Library greyed out (Settings → Library →
_Show games that are not installed_ hides it); it is never deleted, so play time and favourites survive a
reinstall. The games you own on a store but have not installed can be shown the same way once you sign in to
the store (section 3.4).

### 3.2 ROM folder

1. Press **Choose ROM folder** and pick the root folder.
2. PlayOut scans it immediately and shows which systems it found, how many games, and which subfolders it
   did not recognise.
3. After that the folder is scanned again on every start (in the background, a few seconds after the window
   opens, with the scan progress bar): ROMs you copied in while PlayOut was closed appear, and ROMs you deleted
   leave the Library. A deleted ROM you played, favourited, hid, renamed or gave custom art stays as a greyed
   card so its play time and choices are kept. Games already in the Library keep their artwork and details; only
   new ones are looked up. If the ROM folder cannot be found (for example a USB drive that is not plugged in), the
   scan stops with "ROM folder not found" and the Library keeps its ROMs.

**Layout.** One subfolder per system, named like ES-DE names it (`nes`, `snes`, `psx`, `ps2`, `n64`, `gc`,
`dreamcast`, `arcade`, ...; the README has a table of the 30 most common ones with their extensions, and
`resources/systems/systems.json` lists all 190+ with aliases such as `megadrive` for `genesis` or `tg16` for
`pcengine`). Below the system folder you may nest folders freely:

```
D:\ROMs\
  nes\Super Mario Bros. 3 (USA).zip
  snes\RPG\Chrono Trigger (USA).sfc
  psx\Final Fantasy VII (USA)\Final Fantasy VII (USA).m3u
  psx\Final Fantasy VII (USA)\Final Fantasy VII (USA) (Disc 1).chd
  psx\Final Fantasy VII (USA)\Final Fantasy VII (USA) (Disc 2).chd
  ps3\Demon's Souls.ps3\PS3_GAME\...
  scummvm\Day of the Tentacle.scummvm
  ps2\Favorites 1\Okami (USA).iso
  ps2\Favorites 2\God of War (USA).chd
```

- **Sub-folders** (up to 8 levels deep): every game in them appears on its own and counts as the system of the
  folder at the top (`ps2\Favorites 1\...` is PS2). Media that ES-DE scraped into the matching sub-folder is used,
  streaming lists each game separately, and Model 2 arcade games launch from a sub-folder too (only when its path is
  plain ASCII).

- Extensions are matched against the system's list, case-insensitively. Archives (`.zip`, `.7z`) only count
  where the system lists them (most cartridge systems do; disc systems generally do not).
- **Multi-disc games**: put the discs and a `.m3u` playlist that lists them in one folder. The `.m3u` is the
  game and the discs it names are hidden.
- **Folders as games**: a folder whose name ends in a listed extension (`Game.ps3`, `Game.scummvm`,
  `Game.m3u`, `Game.wiiu`) is one game.
- **PS3**: one emulator choice, RPCS3, that picks what to start for each game: a game folder (`Game.ps3` with
  `PS3_GAME` inside, or a PSN game's `USRDIR`), an `.iso`, or a small `Game.ps3` text file holding the serial of a
  game installed inside RPCS3 (such as `NPUB30024`). A `Game.ps3` text file that holds no serial fails with a
  message saying so.
- **PS3 shortcuts**: a `.lnk` made by RPCS3's "Create Shortcut" (ES-DE's older layout) also works: PlayOut reads the
  shortcut and starts the game it names, by its serial or by the game folder or file it points at. A shortcut to
  anything else fails with "is not an RPCS3 game shortcut".
- **Nintendo Switch 2**: put Switch 2 games in `roms\switch2` (folders named `Switch 2`, `switch-2` or
  `nintendoswitch2` work too). It takes `.nup`, `.nx`, `.nsp` and `.xci` dumps and `.lnk` shortcuts. PlayOut makes
  the folder with the Emulation folder, and at the next start in an Emulation folder you chose that has a `roms`
  folder. Metadata comes from IGDB, ScreenScraper and TheGamesDB's Switch 2 platforms. No emulator is included yet
  (Switch emulators do not run Switch 2 games), so a game file shows "PlayOut has no Nintendo Switch 2 emulator
  yet" when played; a Windows shortcut (`.lnk`) to an emulator that runs the game starts like any other game.
- **PlayStation 5**: put PS5 games in `roms\ps5` (folders named `PS5`, `playstation5` or `PlayStation 5` work too).
  A dumped game folder (one holding `eboot.bin`, with `sce_sys` and the rest of the dump) is one game named after
  the folder, as for the PS4; nothing inside it is listed separately. Single-file images (`.ffpkg`, `.ffpfs`,
  `.ffpfsc`, `.exfat`), `.pkg` files and `.lnk` shortcuts are games too. PlayOut makes the folder as for the Switch 2.
  Metadata comes from IGDB, ScreenScraper and TheGamesDB's PS5 platforms. No PS5 emulator is included yet, so a game
  shows "PlayOut has no Sony PlayStation 5 emulator yet" when played; a Windows shortcut (`.lnk`) to an emulator
  that runs the game, put in `roms\ps5` beside the game, starts like any other game.
- **Updates and DLC**: `Emulation\Updates and DLC` holds games' updates and DLC, one folder per console: `Switch`,
  `PS3` and `Xbox360`. PlayOut makes it with the Emulation folder (also in an Emulation folder you chose, at the next
  start). The Emulation folder sync never copies it between PCs; a PS3, Switch or Xbox 360 game downloaded from a
  host brings its own part (section 4.3).
- **PS3 HDD**: RPCS3's hard drive is `Emulation\Updates and DLC\PS3\dev_hdd0`. PlayOut makes it with the Emulation folder
  (also in an Emulation folder you chose, at the next start) and points RPCS3 at it; game updates, DLC and games
  installed inside RPCS3 go there (`dev_hdd0\game\<serial>`). The PS3 HDD that earlier versions kept in
  `Emulation\roms\PS3 HDD` is moved there with everything in it when PlayOut next sets up RPCS3's folders (the first
  start after the update, or the next start if RPCS3 was open), in the same step that points RPCS3 at the new place.
  Until then PlayOut keeps using the old folder, so downloads from a host and games sent to a client still find their
  updates and DLC. A file already in the new place wins (the old copy is kept in `roms\PS3 HDD.playout-old`); a file
  that could not be moved (held open by another program) stays in the old folder and moves at the next start. When
  `roms` is on another drive without room for the PS3 HDD on the Emulation folder's drive, nothing moves and RPCS3
  keeps using the old folder; PlayOut tries again at each start. A `dev_hdd0` from before (in `storage\rpcs3`, or next
  to rpcs3.exe) is moved in, also on a PC where RPCS3 was set up by an earlier PlayOut (at the first start after the
  update; only RPCS3's settings are touched, and not while RPCS3 is open: then at the next start). The Emulation folder sync leaves it out with the rest of Updates and DLC: a PS3 game
  downloaded from a host brings its own part (section 4.3). Saves
  are not in it; they stay in `saves\rpcs3`, which the sync covers.
- **PS3 game updates**: PlayOut keeps PS3 games up to date the way a PS3 does. It asks Sony's update server which
  updates a game has (by its serial), compares them with the version installed in `dev_hdd0\game\<serial>`, downloads
  the missing update packages (PKG), checks each against the checksum Sony lists, and installs them in order with
  RPCS3 (`rpcs3.exe --headless --installpkg`, no window), which unpacks them into `Updates and DLC\PS3\dev_hdd0`.
  The downloaded package is deleted once installed. This runs by itself about a minute and a half after PlayOut
  starts (when online), every 12 hours, and soon after a PS3 game is added; each game is asked about at most once a
  day. Nothing is installed while RPCS3 is open: it waits for the next pass. **Update PS3 game** in a game's ▾ menu
  checks and installs right away and says whether the game is up to date; a bar along the bottom shows the download
  and the install. Settings → Emulators → **Update PS3 games automatically** turns the automatic part off.
- Hidden files, Windows system files and folders that contain a `noload.txt` are skipped.
- Titles are the file name without extension; tags such as `(USA)`, `(Rev 1)` and `[!]` are moved out of the
  display title (they stay available for the scrapers).
- Game ids are derived from the path relative to the ROM root, so moving the whole ROM folder elsewhere and
  choosing it again keeps play times, favourites and artwork.
- **BIOS files** go where the emulator expects them (RetroArch: `<RetroArch>\system\`). PlayOut does not
  check them; a game that needs a BIOS and does not find one fails inside the emulator.

**ES-DE import.** If you already use ES-DE, Settings → Library → **Import from ES-DE** reads
`%HOMEDRIVE%%HOMEPATH%\ES-DE\gamelists\<system>\gamelist.xml` and `downloaded_media` and copies the names,
descriptions, ratings and the covers / marquees / screenshots / fan art for the ROMs that match by path. Set
_ES-DE home_ when ES-DE's data lives elsewhere (portable installations).

### 3.3 Manual games

- **Add a game (.exe)** opens a file picker; the game lands in the **PC** row with the executable's name.
  Open its **Edit** sheet (the pen on the game page) to rename it, set launch arguments or pick artwork.
- **Scan a folder for games** walks a folder (for example `D:\Games`) and adds the executables that look like
  games, skipping installers, uninstallers, redistributables, crash handlers and helper tools.

Manual games are never removed by a scan; remove them yourself from the Play ▾ menu → **Remove from library**.

### 3.4 Store accounts: games you own but have not installed

Open the Library (press down from the Recent row, **RB**, or scroll down) and press **Library Import** at the
bottom left. Each store's card ends with its account: _Not signed in_ and a **Sign in** button, or _Signed in as
<name>_ and a **Sign out** button.

- **Signing in** opens the store's own sign-in page in a separate window. Type your details there: PlayOut
  never sees your password, only the session the store hands back. Gamepad input does not reach that window;
  use the keyboard, mouse or touch, and close the window to cancel. As soon as the store reports you signed
  in, the window closes by itself and PlayOut imports the games you own in the background; the card then reads
  _Signed in as <name> · N games · imported today_.
- **What is imported** depends on the store:

  | Store                  | Imported after signing in                                                                                                                                                           |
  | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Steam                  | The games you own, with play time and store art. Works with the web sign-in or, without it, with the API key and SteamID64 from Settings → Metadata (the row then says _(API key)_) |
  | Epic Games             | Your library items, with play time (games EA or Ubisoft manage are left to those clients)                                                                                           |
  | GOG                    | The products you own                                                                                                                                                                |
  | Xbox / Microsoft Store | The PC games you have played at least once; a purchase you never started is not listed                                                                                              |
  | Battle.net             | The games and subscriptions of the account (classic titles are listed but must be installed from the Battle.net client)                                                             |
  | EA App                 | Your owned games (experimental: EA's site may change)                                                                                                                               |
  | Ubisoft Connect        | No sign-in: Ubisoft offers none PlayOut can use, so only the games the Ubisoft Connect client has installed are listed                                                              |

- **Greyed-out cards.** Imported games you have not installed appear greyed out, with a small download marker,
  in _All_ and in a tab filtered by their store (and, on a PC paired with a host, in the Recent row once played on any of your PCs). The header counts them: _31 installed · 6
  not installed_. Settings → Library → _Show games that are not installed_ hides them.
- **Install.** Open a greyed card: the detail panel is the usual one, with an **Install** button where Play
  normally sits. It hands the game to the store client (Steam, Epic Games, GOG Galaxy, EA app, Battle.net,
  Ubisoft Connect or the Microsoft Store), which opens its own install dialog: confirm the location there; the
  download runs inside that client. PlayOut follows it: the button becomes a progress bar (percent and GB when
  the client exposes them, otherwise _Installing through <Store>…_), the card shows a thin bar, and a toast says
  _<title> is installed_ when the game is ready; the button turns into **Play** by itself, even while the panel
  is open. The ▾ menu (or **X**) offers _Cancel tracking_ (PlayOut stops watching; the client keeps downloading
  and the next scan still finds the game) and _Open <Store>_. If nothing changes for 30 minutes PlayOut gives up
  and says _Could not confirm the installation — check the <Store> client_.
- **Choosing a Steam game's DLC.** **Install** on a Steam game first opens _Choose DLC for <game>_: a switch for each
  DLC with its download size (_No download (turns its content on or off)_ for DLC that only unlocks content the game
  already has). Leave on what you want and press **Install**; **All on** / **All off** appear when there are many.
  Steam's own install dialog offers no DLC choice, so Steam installs the game with every DLC you own; when the install
  finishes PlayOut closes Steam cleanly, turns off the DLC you unticked in the game's
  `steamapps\appmanifest_<appid>.acf` (only its _DisabledDLC_ line; a copy is kept next to it as
  `appmanifest_<appid>.acf.playout-bak`) and opens Steam again in the background, which then removes their content. A
  toast says _<game>: DLC choices applied_. Unticked DLC with a download are therefore downloaded once with the game
  before they are removed. A game without DLC installs straight away (the dialog shows only a brief _Reading the DLC
  list…_).
  - Only DLC your Steam account owns are listed (_N DLC you don't own aren't shown_); that needs the Steam sign-in
    above. Without it PlayOut cannot tell, says so, and lists every DLC of the game.
  - DLC marked _Change it in Steam_ (opt-in content such as tools, or DLC the game manages itself) can only be
    changed on the game's page in Steam. **Open in Steam** is always there and opens that page (its _DLC_ section has
    Steam's own switches).
  - If the DLC list cannot be read (offline, Steam's info service down) the dialog says so and offers **Install
    anyway** (the game with all its DLC) and **Open in Steam**.
  - To change your mind later, use **Manage DLC** on the installed game (section 4).
  - The choice belongs to that install: if you stop it (remove the game from the queue, cancel it), the choice is
    dropped, so a later install of the game from Steam itself is left as Steam does it. If Steam does not close in
    time twice in a row, PlayOut stops trying and says so (_<game>: …_); use Manage DLC then.
- **Keeping the owned list current** needs no button: PlayOut re-reads it after every scan of that store and at
  start-up; for a store whose client is not installed, **Scan all** in Library Import re-reads it. A game you no longer own loses its greyed card unless you played it from PlayOut.
- **Sign out** forgets the account: the stored session is deleted, the sign-in window's cookies are cleared and
  the store's greyed cards disappear (installed games stay, they just stop counting as owned).
- **Where the sessions live.** `%APPDATA%\PlayOut\accounts.json`, encrypted for your Windows user with the
  Windows Data Protection API (Electron's `safeStorage`); each session is sent only to the store it came from.
  Deleting the file while PlayOut is closed signs you out of every store. The Steam API key is a setting, not a
  session: it stays in `settings.json` (Settings → Metadata).

### 3.5 The install queue: one download at a time

PlayOut downloads one game at a time, whatever the store: while a Steam game installs, a GOG game you ask for waits,
and so does a ROM downloaded from another PC (section 4.3). Each game is handed to its store only when its turn
comes, so the downloads never compete for your connection or disk.

- **Queuing.** Press **Install** (or **Download** on another PC's ROM) while another game downloads: a toast says
  _<title> is queued; it starts after <game downloading now>_. The detail panel then shows **Remove from queue** where
  Install was, with the game's place beside it (_Queued · Next in line_, _Queued · 2nd in line_…), and its cover
  carries a small hourglass with the number. When the game in front finishes (or fails, or you stop it) the next one
  starts by itself.
- **Starting.** A game whose turn has come shows _Starting…_ with a moving bar (on its cover and in the detail panel)
  until its store or the other PC reports progress, which can take up to a minute for a ROM download that resumes
  after a restart. Its Play menu (and cover menu) offers **Cancel tracking** / **Cancel download** meanwhile, never a
  second Install or Download.
- **Seeing the queue.** While anything downloads or waits, the system pill on Home shows a download icon with the
  percent of the game downloading now; select it to open the quick panel with the focus on its **Downloads** list
  (on the first game's name, so a press right away stops nothing; the power button opens the panel on its tiles). The
  list shows the game downloading now with its progress bar, then the waiting games in order. During a game, the
  home button's overlay has the same list on its **Downloads** tab.
- **Changing the order.** In the list, the arrows move a waiting game up or down and **✕** takes it out of the
  queue. On the game downloading now the button stops it, after a confirmation: a store install stops being followed
  (the store may keep downloading it, and the next scan still finds it), a ROM download from another PC is
  cancelled. Both start the next game. A waiting game also leaves the queue from its cover's menu (**Y**, _Remove
  from Queue_) or its Play menu. A store install still on _Starting…_ offers **Cancel install** instead: nothing was
  seen downloading yet, so PlayOut simply stops waiting for it (_Cancelled the install of <title>_).
- **Pausing.** Every row of the list has a pause button (**⏸**, then **▶** to resume), and **Pause all** above the
  list pauses every game at once (it reads **Resume all** once they all are). The game's Play menu and cover menu
  (**Y**) offer **Pause download** / **Resume download** too, and a paused game's detail panel shows **Resume** where
  Install was, with _Paused_ beside it.
  - A **waiting** game that is paused keeps its place (you can still move or remove it) but is skipped: the next game
    not paused downloads first. Its cover's hourglass turns into a pause sign.
  - A **ROM download from another PC** stops at once and keeps what it has: its row says _Paused at 42%_ and the next
    game starts. **Resume** continues it from where it stopped, in its turn (right away when nothing else
    downloads).
  - A **store install** cannot be paused by PlayOut, only by the store: PlayOut marks it _Paused_, opens the store's
    downloads page (Steam's _Downloads_, the other stores' library) so you can pause it there too, and keeps it as the
    game downloading now, so nothing else starts behind it meanwhile. Its row says _Paused · Pause it in <Store>
    too_. Resume only takes the mark away; resume the download in the store as well if you paused it there.
  - While the game downloading now is paused (or every game is), the system pill shows a pause sign instead of the
    percent.
- **An install keeps its turn until it is done.** Once a store has started an install, that game stays the one
  downloading now until the next scan finds it installed, you cancel it in the store, or you take it out of the queue
  (the list's button). The games behind it keep waiting meanwhile, so the downloads never overlap. If the store stops
  reporting progress (or PlayOut cannot read it), the row says so (_PlayOut cannot see <Store>'s progress. Remove it
  from the queue once <Store> finished or cancelled it._): PlayOut never gives up on it by itself, since the store
  may still be downloading.
- **A store that never starts.** If the store has still not shown the install 10 minutes after its turn came (Steam's
  install window was closed, or the install was declined), PlayOut gives up on it: it ends as failed with a message
  saying so, and the next game starts. Install tries it again.
- **Another PC that goes offline.** A ROM download whose PC is switched off or unreachable keeps its place in the
  queue: its row in the Downloads list and its detail panel say _Waiting for <PC> to come back online_ (so does the
  toast when you press Download while that PC is off), the games behind it are not held up, and it resumes by itself
  when that PC is back. Unpairing that PC (section 4.3) takes its ROM downloads out of the queue.
- **An installed game keeps Play.** A game that turns out to be installed (the store finished, or you installed it
  another way) always shows Play, even in the moment before it leaves the queue.
- **Restarts.** The queue is kept when PlayOut closes: at the next start the game that was downloading is followed
  again and the waiting games keep their places. A game that got installed meanwhile is skipped. Paused games stay
  paused: a paused ROM download waits until you resume it, a paused store install is followed as before.

### 3.6 Deleting a game from this PC

**Delete from this PC** is the last entry of the menu next to Play and of the cover menu (Y or a right click on a
cover). It is offered for installed games of this PC only, never while the game runs or sits in the download queue, and
it never touches other PCs, the host's copy or your store account. A confirm dialog says exactly what will happen
first:

- **ROMs:** every file of the game (a .cue and its tracks, an .m3u and its discs, a dumped game folder) goes to the
  Recycle Bin, with the total size shown, and the game leaves the library. Your saves, states and memory cards (in the
  Emulation folder) are not touched. Files another game also uses (a disc a playlist lists) are kept. Nothing is ever
  deleted for good: on a drive without a Recycle Bin (a network drive) the delete fails and the game stays. On a PC
  that streams from a host, the host keeps its copy and the game shows as Download again.
- **Updates and DLC (PS3, Switch, Xbox 360):** the dialog also lists the game's updates and DLC in
  `Emulation\Updates and DLC` and has **Also delete its updates and DLC**, on by default. For a PS3 game these are its
  folders in `PS3\dev_hdd0\game` named after its serial (its updates, DLC, data folders); its DLC licenses in
  `exdata` are kept. For Switch and Xbox 360 games they are the files and folders in `Switch` / `Xbox360` that carry
  the game's title id (a Switch update `[0100…800]` or DLC belongs to the game `[0100…000]`) or, without one, a
  similar name to its ROM file or its title ("Metroid Dread [Update v2.1.0].nsp" for "Metroid Dread.nsp"; the rules
  are those of a host download, section 4.3, but only the same id or the same name: a subtitle or a DLC with its own
  name after the game's goes with a download, never with a delete). An item two library games could claim goes to
  the closer name only, and one they match equally (two copies of a game with the same title id) goes to neither.
  They go to the Recycle Bin too.
- **Store games:** the store's own uninstall starts (Steam, Epic, Ubisoft, GOG Galaxy; EA and Battle.net through the
  game's uninstaller, or the store's library when none is found) and the store asks you itself. Xbox games have no
  uninstall link: **Open Windows Settings** opens Settings › Apps, and you uninstall the game there. The game stays in
  your library and shows as not installed once it is uninstalled.
- **Manual games:** the game's own uninstaller opens when Windows lists one. The game stays in your library while it
  runs (you can still cancel it) and leaves it once its program or its Add/Remove Programs entry is gone (checked after
  1, 3 and 10 minutes). Otherwise its folder (the exact path is shown) goes to the Recycle Bin, with everything inside
  it, saves included, but only when that is safe: never a drive root or a folder right below it (D:\Games), a user or
  Windows folder, a folder that holds PlayOut or your ROM / Emulation folder, a store's library (steamapps, XboxGames,
  a store's own program) or a game inside one, a folder that also holds another game of your library or programs of
  different games, or one larger than 200 GB. When it is not safe, only **Remove from library** is offered, with the
  reason, and the files stay.

When a host also has the game, the dialog says what stays there: a ROM the host can send shows as Download here; any
other game can still be streamed from the host.

## 4. Playing

Focus a card and press **A** / `Enter` / tap to open the **detail panel**: hero art, logo, the platform pill
(opens the store page or launcher), chips (genre, the game's strongest **Steam tags** such as _Roguelike_ or
_Souls-like_, _N playing now_ for Steam games), the description,
_Released <date> · developer · publisher_ and the action bar:

- **Similar games.** The button left of the platform pill (two overlapping circles) lists the ten games of your
  library most like this one, most similar first, each with how similar it is (100%: alike in everything compared).
  It compares the title (25%), the Genres & Tags (25%), the developer (20%), the platform (10%), the How Long To Beat
  time (10%), the review score (5%) and the publisher (5%), each only when both games have it. Platforms match within
  these groups: GameCube, Xbox, Wii, PSP and PS2; Game Boy, Game Boy Color, Game Boy Advance, DS and 3DS; PS3, Xbox
  360 and Switch; Switch 2, PS4 and PS5; PlayStation, Saturn, Nintendo 64 and Dreamcast; SNES, NES and Genesis; Neo Geo
  CD, 3DO and Amiga CD32; PC Engine and DOS; and PC (every store and added program). Other systems are left out of the
  platform comparison, and the same platform alone does not make a game similar. Genres & Tags compares each genre and tag: the ones in common out of all the two games have between them give that share of its 25% (_RTS_, _Base Building_ and _Strategy_ in common, _3D_ and _Shooter_ not: 3 of 5, so 15 of 25). The title matches a series and its
  sequels: numbers, years and words like "Edition" are left out, so _SSX (2012)_ and _SSX 3_ match fully. Titles that
  start with the same name count as one series, more so for a name of two words or more (_Dark Souls II: …_ and _Dark
  Souls III: …_) than for one first word (_SSX Tricky_ and _SSX On Tour_), since a single everyday word can start
  unrelated titles (_Dead Space_ and _Dead Cells_). A game must share a
  genre or tag, the developer or the publisher, or be of the same series, to count. 100% needs the two games alike in
  everything compared, and compared on at least half of it. The list takes your paired host's games too (when Settings › Streaming shows them), and each title is one row (copies in several stores or on several systems), and the game itself is
  left out. With no such game the list says you have 0 similar games. Press a game to open its page (**B** / Back
  returns here). The list is worked out when you press the button.
- **Developer, publisher, genre and tag chips add to the tab you are on.** Press (click, tap or **A**) the developer
  or the publisher in the _Released …_ line, the genre or a Steam tag: it is added to the filters of the Library's
  current tab (the first tab when you were on Settings), with every filter the tab already has kept, and the Library
  opens on that tab on this game's card. Filters combine: a genre joins the tab's other genres (a game with any of
  them shows), a developer joins its other developers (a game by any of them shows), and different kinds narrow
  together (_RPG · FromSoftware_ shows FromSoftware's RPGs). The tab takes the names, keeps them across restarts, and
  a developer, publisher or genre that is on is drawn pressed (the name underlined, the chip highlighted) on every
  game page. Press it again to take only that one off the tab. All of them are listed under **Filters → Clear
  filters** too. A tab of an earlier version filtered by one developer (_EA Redwood Shores_) keeps it.
- **Owned on <Store>** opens the Library on a tab with just that store (Filters → Platform, above the line), on this game's card. A tab
  with exactly that filter is reused (its sort stays, its search is cleared); otherwise a new tab is added at the
  end, so none of your tabs is changed. Tags that Filters → Genre does not list (and _N playing now_, _Not
  installed_) are plain labels.

- **Play** launches the game. The **▾** part of the button (or **X** on a gamepad) opens the launch menu:
  play with an alternative emulator, open the install folder, open the store page, refresh metadata, hide
  the game.
- **Install** takes Play's place for a game you own but have not installed (section 3.4); the menu then
  offers _Cancel tracking_ and _Open <Store>_ instead of the entries that need an installed game.
- **Manage DLC** (Play ▾ menu, and the cover's **Y** menu, of an installed Steam game) turns the game's DLC on or
  off. Each DLC shows its size and _Installed_ when its content is on this PC, or _Change waiting for Steam_ while
  Steam has not applied the last change. Press **Apply** (**Apply and restart Steam** while Steam runs): PlayOut
  closes Steam cleanly (it never force-closes it), changes only the game's _DisabledDLC_ line in
  `steamapps\appmanifest_<appid>.acf` (a backup is kept as `appmanifest_<appid>.acf.playout-bak`) and opens Steam
  again in the background; Steam then downloads what you turned on and removes what you turned off, and a toast says
  _Steam is applying your DLC changes_. Apply is refused, with the reason shown, while a game is running (Steam is
  never closed under a game) or while Steam is downloading or updating something. DLC without a download only turn
  their content on or off. **Open in Steam** opens the game's page in Steam, where its DLC can always be changed by
  hand. DLC the list does not show (not owned, or _Change it in Steam_) always keep the state Steam has for them, and
  nothing is changed while Steam's DLC list cannot be read. If PlayOut is closed in the middle of a change, it starts
  Steam again first. Note: a save made with a DLC's content may not load, or may lose that content, once the DLC is
  turned off; turn it back on to get it back.
- **Install size**, only for a game that is not installed: on the **Install** (or **Download**) button itself, in
  smaller text under the word (_Install_ over _45 GB_). It is what Steam would install, what the Epic Games Launcher
  would install (while you are signed in to Epic in Settings → Accounts), the GOG installer's size, or the size of
  the same game on Steam (the other stores publish none); figures that are not exact read _~45 GB_. A download from
  a paired PC shows the download's size. Enter your own in the game's **Edit** sheet (pen) → **Install size** ("45
  GB", "800 MB"); it is used instead.
- **Controls**: at the top left of the page, left of the players badge, how the game is played: **Pad** (full
  controller support), **Partial** (partial controller support), **VR** (a VR game, or VR supported), **KB+M**
  (keyboard and mouse), **Touch** (a touch screen only), **Gun** (a light gun only), **Pad+KB+M** (full controller
  and full mouse and keyboard support) or **All** (VR, full controller and mouse and keyboard). PC games take this from Steam's store (its controller and VR support), read with the Steam
  tags, also for copies from other stores that PlayOut matches to a Steam app; a game Steam says nothing about, or
  that PlayOut cannot match, shows keyboard and mouse. Console games (ROMs) always show a controller. A PlayOut from
  before the three Controls rows (0.9.97 and earlier) shows a game picked as Mouse & Keyboard + Touch as Touch only,
  and a Lightgun-only game as keyboard and mouse.
- **Players**: at the top left of the page, a controller with a number above it shows how many people can play
  the game together, from the LaunchBox Games Database (gamesdb.launchbox-app.com). PlayOut downloads LaunchBox's
  public database (about 110 MB) in the background once a month and keeps only the player counts and genres;
  a bar at the bottom of the screen shows the download. Steam games are matched by their Steam app, others by
  name on their own platform. LaunchBox's count includes online players for some games, so counts above 8 are
  not shown.
- **Genre** (ROM games): the genre chip, the Library's genre filter, search and the Home line use LaunchBox's
  genres for ROM games ("Role-Playing", "Platform"), from the same monthly download. A ROM game LaunchBox has no
  genres for keeps the genres from the metadata sources as before, and so does every ROM game until LaunchBox could
  be reached once (a failed download is tried again six hours later). Steam, GOG, Epic and the other stores always use those.
- **Achievements x/y** (press it to expand the list; ROM games show **RetroAchievements x/y** instead, section 5.4,
  except a game whose Xbox 360 recompilation Play starts, which shows its own achievements, section 4.5),
  then **Play time / Main story**: your play time over HowLongToBeat's main story time in the same unit
  (_12.5 / 59 Hrs_, _45 Min / 26 Hrs_), so you see how close you are to beating the game (_Play time / Solo_ for a
  game HowLongToBeat times as Solo; just _Play time_ when it has no time).
- The review score comes next: **Steam** (the share of positive Steam user reviews, "93%") for games on Steam, else
  **IGDB** (IGDB's user rating out of 100, "84"; needs the IGDB credentials of Settings → Metadata, section 6.1). It
  reads _—_ until the score has arrived, or when neither has one.
- **Players** (Steam games): a green bar for the most players the game ever had online at once, with an orange bar
  over it for the players online now, and right of the bars the two numbers shortened (_952.5K_ over a line,
  _20.8K_ under it). The number online now is Steam's Web API count (read again after ten minutes when you open
  the game), or SteamCharts' latest hourly count (read while the Library's **Popularity** sort is shown)
  when that is newer. Steam's API has no all-time peak, so the peak comes from
  [SteamCharts](https://steamcharts.com), which has recorded Steam's numbers since 2012 (read at most once a day when
  you open the game, and again with the Popularity counts); a game SteamCharts does not track shows the number
  online now alone.
- **Main + extras** and **Completionist** hours from HowLongToBeat follow. When the bar is too narrow, Completionist
  goes first, then Main + extras, then Players, then the review score.
- The **pen** opens the game's **Edit** sheet ("Editing a game" below), the **gauge** the quick panel, the **star**
  toggles favourite. **B** / `Esc` returns to the card you came from;
  LB / RB move to the previous / next game of the row without leaving the panel.

#### Editing a game: the pen

Some metadata is wrong or missing (a wrong developer, a made-up release date, odd genres). The **pen** button
(right of the stats, where the gear used to be) opens the **Edit** sheet, which holds everything you can change
about the game:

- **Game information**: title, description, short description, release date (`YYYY-MM-DD`, `YYYY-MM` or `YYYY`),
  developers and publishers (comma-separated), and **Genres & Tags**.
- **Genres & Tags** is one dropdown for the game's genres and its tags. The field shows what is ticked (for example
  _Action, RPG +3_); **A** (or a click) opens the list: every choice of Filters › Genre (Action, Adventure, RPG,
  Science Fiction, ...), alphabetical, then, under _Also on this game_, the game's genres and tags that are not a
  Filters › Genre choice (_Indie_, _Atmospheric_). A choice is ticked when the game has it as a genre or as a tag,
  under any of its spellings (_Role-playing (RPG)_ and the Steam tag _RPG_ both tick RPG; Steam's _Sci-fi_ ticks
  Science Fiction). **A** (or a click) on a row ticks or unticks it and the list stays open; **B** / `Esc` (or a
  click outside) closes it. Ticking a choice adds it to the game's genres; unticking one takes it out of both the
  genres and the tags, every spelling of it (the tags keep Steam's strongest-first order). Untick and tick a row again
  and the game keeps exactly what it had. The game's first genre is still the chip on the game page and the tags the
  chips after it. Opening the list and changing nothing saves nothing.
- **Search genres & tags**, the box right under the dropdown, finds one to add without scrolling the list. Type a few
  letters (with a controller, **A** on the box opens the on-screen keyboard, which shows the matches above its keys as
  you type: **Up** to one and **A** adds it; **Done** shows them under the box instead) and up to 8
  of the dropdown's genres and tags that contain them show under the box, ignoring capitals and accents: names that
  start with the letters first, then names with a word that starts with them (_cl_ finds _Classic_, then _Point &
  Click_), then the rest. The ones the game already has are left out; _No matching genre or tag_ when nothing fits.
  Pick one with a click or tap, **Down** then **A** with a controller, or `Enter` (the first one): it is added
  exactly as ticking it in the dropdown would, and the box clears for the next search, one pick at a time. **Up** from
  the first match goes back to the box; **B** / `Esc` closes the matches (`Enter` then shows them again rather than
  adding one you cannot see).
- **Players and controls**: how many players on one PC (the players badge), and three identical
  **Controls** rows (the controls badge and Filters › Controls). Each row is one of **None**, **Full Controller
  Support**, **Partial Controller Support** (a controller for some of it, mouse and keyboard for the rest), **Mouse &
  Keyboard**, **VR**, **Touch** or **Lightgun**; together the rows say every way the game is played (Full Controller
  Support + Mouse & Keyboard = plays fully with either; Full Controller Support + Mouse & Keyboard + VR = all three).
  The order of the rows does not matter and picking the same thing twice counts once; Full and Partial together count
  as Full. **VR** with no controller and no Mouse & Keyboard means a headset is needed (VR only); next to either, VR
  is an option. **Touch** or **Lightgun** without Mouse & Keyboard means the game plays only that way. The rows show
  what the game has now (scraped full controller with VR as an option shows Full Controller Support and VR), and the
  controls are only saved when the set of picks changes. All three rows on **None** is the same as **Reset**: Save
  removes your own controls edit and the game shows the cloud's or scraped controls again; with no controls edit of
  your own there is nothing to remove, so the note under the rows says nothing is saved and the field is not marked
  changed. A long choice wraps onto a second line, so each row keeps its name (Controls 1, 2, 3). Console games
  (ROMs) have the rows too, starting on Full Controller Support: their badge always shows Pad, and their picks put
  them under Filters › Controls (Lightgun for a light-gun game such as Duck Hunt or Time Crisis, Touch, VR). When the
  only picks are Touch and Lightgun the badge shows Touch; the game is under both filters.
- **Time to beat, review score and difficulty**: the How Long to Beat hours (main story, main + extras, completionist,
  solo), the review score (0-100), shown as Steam's percent positive or IGDB's rating, and the difficulty for Filters ›
  Difficulty: **Default** or Story, Easy, Medium, Hard or Impossible. Default is the level the game's Steam tags give
  (Visual Novel = Story, Casual, Free to Play and Relaxing = Easy, Souls-like and
  Difficult = Hard; it says which, e.g. "Default (Story,
  from the Visual Novel tag)"), else Medium; it also puts that back over a PlayOut cloud correction. A game Steam
  tags **Utilities** (a tool, not a game) has no level by default: it says "Default (N/A (Tools), from the Utilities
  tag)". N/A (Tools) is a label, not a choice; pick a level to put the game on one.
- **Settings**: emulator (ROM games), extra launch arguments, install size, hide from library.
- **Artwork**: your own cover, hero and logo (section 6.3). Artwork stays on this PC and changes at once; it is not
  part of an edit.

Each field says where its value comes from: **Scraped** (the metadata sources), **PlayOut cloud** (a correction
everyone gets), **Your edit**, or **Changed** while you have not saved yet. **Reset** on a field goes back to the
cloud's value, else the scraped one (on Genres & Tags it puts back both the genres and the tags). **Save** keeps the
changes; **Cancel** (or **B**) drops them. Everything works with a controller: Up / Down move between the fields,
**A** opens the on-screen keyboard, flips a choice or opens the Genres & Tags list, Left / Right change a choice.

A saved change goes to the PlayOut metadata cloud like every edit (below): ticking a genre the game did not have and
saving sends it to the maintainer as a suggestion to approve (on the maintainer's own PC it is published at once).

The value PlayOut shows is, per field, your edit, else the PlayOut cloud's, else the scraped one. A field you or
the cloud set is locked: refreshing metadata, Steam tags, LaunchBox player counts, How Long to Beat, review scores
and a streaming host's metadata keep updating the scraped value underneath but never replace what you see. The
game page, the Library filters and the search all use the shown value. Edits are kept per game in `library.json`.

**A game on another PC (Streaming).** A paired host's game that this PC does not have shows the pen too. Its Edit
sheet has the game information, players and controls, and time to beat and review score fields; their values come from
the host, so a field you have not edited says **From the host** (instead of _Scraped_), and **Reset** goes back to
the PlayOut cloud's value, else the host's. The emulator, launch arguments, install size, hiding and custom artwork
belong to this PC's own copy of a game, so they are not in the sheet: set them once the game is on this PC. Your edit
stays on this PC (the host keeps its own metadata and never sees it) in `remote-metadata-edits.json` in PlayOut's
data folder, and it is kept by the game's cloud key, so it follows the game when another paired host offers it or a
host is paired again. When you download the game (a ROM), your edit goes with it: every field the downloaded copy
has no edit of takes yours. Saving it is shared with the PlayOut metadata cloud like any other edit (below).

**Sharing a correction: the PlayOut metadata cloud.** Corrections are shared through a public GitHub repository,
[jeremybris/PlayOut-metadata](https://github.com/jeremybris/PlayOut-metadata). Every PlayOut downloads its
corrections (`all.json`) at start and every 6 hours, with no account, and keeps a copy so they also show offline.
A game is matched by its key: its Steam app id, its store id (GOG, Epic, EA, Ubisoft, Battle.net, Xbox), a ROM's
disc serial or system and title, or a hand-added game's title, so the same correction reaches the same game on
every PC.

What happens when you **Save** an edit:

- **On the maintainer's PC** (a GitHub token is set in Settings → Metadata → _Cloud metadata_), the saved fields are
  published at once: a toast says _published to the PlayOut metadata cloud_, and every PlayOut gets the change with
  its next check.
- **On every other PC**, the edit applies here at once and is sent as a **suggestion** to the maintainer. A toast
  says _suggested to the PlayOut metadata maintainer_. When the suggestion service cannot be reached (or is not set
  up yet), the toast says _saved here; will be suggested when the suggestion service is available_: PlayOut keeps it
  and tries again every hour and at start. A suggestion only reaches everyone once the maintainer approves it.
- **Suggestions are limited to 30 per hour from one PC** (and 120 an hour from everyone together: the suggestion service's guard against spam). Edit more
  games than that and the rest wait on this PC: the toast and Settings → Metadata say how many wait and when the next
  ones go (for example _19 edits waiting to be suggested. The suggestion service accepts 30 per hour from one PC;
  PlayOut sends the rest automatically (next at 1:12 AM)._). Nothing is lost and you need not do anything: PlayOut
  sends the next ones as soon as the hour is over, until none wait (the newest value of each game wins). Every PC,
  the maintainer's too, suggests its edits; the maintainer approves or rejects them as pull requests on GitHub. The
  service has a few other limits that
  work the same way and are named in the same line: many suggestions from your internet connection in one hour,
  the service busy for everyone, or so many suggestions waiting for the maintainer's review that new ones are held
  until some are reviewed (PlayOut tries again every hour).
- Removing your edit of a field (**Reset**, then **Save**) only changes this PC; it is not sent anywhere.
- Text with HTML tags or control characters is kept on this PC only (the cloud refuses it; a toast says so).
- Artwork (cover, hero, logo) is never shared: it stays on this PC.

**Steam links (Steam games).** A Steam game's page has a second grid of four squares right of the feature squares
(right of **Play** when the game has none of those): top left the game's **Steam store page** (the Steam logo), top
right its **Steam Workshop** (a wrench), bottom left its **PCGamingWiki** page (an open book: fixes, settings, save
locations) and bottom right its **Steam Guides** (a scroll). Other games have no such grid. The Workshop square stays
empty when Steam says the game has no Workshop; a game PlayOut has not asked Steam about yet keeps the square until
you press **Refresh metadata** on its page (nothing is looked up in the background for this). A square opens the
page **inside PlayOut**, in a large panel over the game page:

- The bar on top shows the page's title and site, with **Back**, **Forward**, **Reload**, **Open in browser** and
  **Close**. Mouse, touch and keyboard work in the page as in a browser (Escape in the page goes back, or closes
  on the first page; Alt + Left / Right go back / forward).
- With a controller: **B** goes back (closes on the first page), **LB / RB** back / forward, **D-pad up / down** and
  the **right stick** scroll the page, **X** reloads, **Y** opens the page in your default browser, and **A** presses
  the bar's selected button. The controller cannot click links inside the page; use the mouse or touch, or **Y**.
- The panel only shows Steam's store, the Steam community and PCGamingWiki. A link to any other site (YouTube,
  a developer's site, Steam's sign-in or help pages) that you click opens in your default browser instead, and so
  does a download you start. The page itself cannot open your browser: a pop-up, redirect or download it tries
  without your click shows a line under the bar (**Open in browser** or **Dismiss**) and nothing opens until you
  choose. The panel asks for no permissions or devices (camera, notifications, USB, Bluetooth, screen capture) and has
  its own cookies, apart from PlayOut's and from the store sign-in windows, forgotten when PlayOut closes; signing in
  to Steam there is not possible, so Workshop subscriptions and ratings need **Open in browser** or Steam itself.
- It closes with the game page and when a game starts. While something of PlayOut's opens over it (the Quick panel,
  a dialog), the page is hidden and comes back when that closes. PlayOut's toasts and on-screen keyboard cannot show
  over the page.

**What happens on Play.** A toast says _Launching <title>…_. Store games start through their client (the
client itself starts first when it is not running; PlayOut waits up to 90 seconds for the game to appear).
ROMs start their emulator with the ROM path; manual games start their executable. While the game runs
PlayOut minimises itself (Settings → Appearance → _Minimise while playing_), tracks the session, and when the
game exits it restores and focuses its own window and adds the session to the game's play time, last played
and play count. A game that cannot be launched shows a dialog with the reason; for a missing emulator or
core it names the files searched, links to the emulator's download page and offers a shortcut to Settings →
Emulators (section 10.1).

### 4.1 Co-Op: split-screen on one PC (Nucleus Co-op)

Many PC games that only support online or LAN multiplayer can be played split-screen on one PC with
[Nucleus Co-op](https://github.com/SplitScreen-Me/splitscreenme-nucleus)'s community **handlers**: Co-Op starts one
copy of the game per player, gives each its own window on the screen and its own controller, and connects them to
each other. PlayOut has Nucleus Co-op's engine built in (through its own helper program, _PlayOut Co-Op_); the
Nucleus Co-op app itself is never needed or run.

- **The handlers come by themselves.** When this PC has none yet, PlayOut downloads every handler in the background
  about half a minute after it starts (about 900 games, about 1.1 GB, a few minutes; kept zipped), and looks for new
  or newer ones about once a week. Until that first download has finished, the Nucleus Co-Op filter and badges have
  nothing to show; offline, it is tried again a few hours later. The bar along the bottom of the Library shows the
  download's progress. Settings → Library → **Co-Op** → **Download all handlers** (later **Update all handlers**)
  does the same at once. A handler is extracted only for the game you play in Co-Op, the first time, and stays
  extracted until you remove it (Co-Op setup → **Remove Co-Op handler**).
- **Which games.** **Filters → Local Multiplayer → Nucleus Co-Op** in the Library lists them all. A game with a handler shows a **Co-Op** badge at the top left of its page, right of the players
  badge. Handlers are matched by the game's exe, its Steam app, or its name.
- **The Co-Op square.** Right of **Play** on a game's page sits a grid of four squares: top left
  **Recompilation** (section 4.5), top right **Upgrade**, bottom left **Co-Op** (two people), bottom right
  **PeerParty** (section 4.2). A square a game does not support stays empty; a game that supports none of them shows
  no grid. For these games **Co-Op** starts the game split-screen, while **Play** starts it as usual. The first
  Co-Op start also downloads Nucleus Co-op's tools once (about 100 MB: its hook DLLs, the Goldberg Steam emulator,
  XInputPlus and the other utilities handlers use).
- **Automatic setup.** Co-Op chooses everything:
  - **Players:** one per connected controller, up to the handler's maximum. The keyboard and mouse are not counted
    unless you turn on Settings → Library → **Count the keyboard and mouse as a player** (and the handler supports
    them).
  - **Controllers:** in Windows' controller order, one per player.
  - **Screen layout:** two players as set in Settings → Library → **Two-player split-screen**: **Top and bottom**
    (the default; side by side instead when each window would be under 540 pixels tall) or **Left and right**.
    Three or four players in a 2 × 2 grid, more in larger grids.
  - **Two or more monitors:** every monitor is used. The players are shared out evenly, the main monitor first, and
    each monitor is split the same way one monitor would be: two players on two monitors get a full monitor each;
    three get two on the main monitor (top and bottom, or as set) and one on the other; five get a 2 × 2 grid and two.
    A layout picked in **Co-Op setup** is used on each monitor, filling the main monitor first; a player alone on a
    monitor always gets all of it. If more players connect than the picked layout can hold, Co-Op goes back to
    automatic for that session.
  - **Exe:** the game's exe PlayOut already knows, or the one the handler names, found in the install folder.
- **Co-Op setup** (the ▾ menu → **Co-Op setup…**) changes any of it for that game: the exe (or **Choose exe…**),
  the number of players, the layout and each player's controller. **Check controllers** reads them again after you
  connect one; **All automatic** goes back to the automatic choices. Choices are kept per game.
- **Handlers that remove DRM or bypass anti-cheat.** A few handlers use Steamless, SmartSteamEmu, the SteamStub DRM
  Patcher or an Easy Anti-Cheat bypass. The first Co-Op start of such a game asks first: these tools may break the
  game's terms of service and, for online games, can get an account banned.
- **While playing**, PlayOut minimises itself and tracks the session like any game (play time, last played). The
  session ends when every instance has closed; Nucleus Co-op's changes (instance folders, edited settings files) are
  undone then.
- Co-Op needs at least two players: with one controller and the keyboard and mouse not counted, the Co-Op button
  says what is missing.

### 4.2 PeerParty: LAN play

[PeerParty](https://github.com/MaximumFreak/PeerParty) lets games that only play online (through a store's or a
publisher's multiplayer service) play with other PCs on your own network instead. PlayOut starts a game through it
from the **PeerParty** square (a network icon), at the bottom right of the four squares right of **Play**.

- **Which games.** Only installed PC games that PeerParty can work with, and only when it is safe:
  - The game has multiplayer: it is under **Filters → Online Multiplayer** or **Local Multiplayer**, or has a LAN,
    multiplayer or co-op tag.
  - The game's folder uses one of the services PeerParty stands in for: **Steamworks**, **Epic Online Services**,
    **PlayFab**, **GOG Galaxy**, **Photon**, **Unity Gaming Services**, **Demonware**, or it is an **Xbox app** PC
    game (not an Xbox 360 game that Windows runs in its emulator). PlayOut finds them from the game's own files the
    first time its page opens (the square stays empty while it looks), and looks again when the game's folder
    changes.
  - **Never for a game with anti-cheat.** No PeerParty square, so you are not banned for playing a modified game, for
    a game whose folder has an anti-cheat (Easy Anti-Cheat, BattlEye, EA Javelin, PunkBuster, Ricochet and the
    others the Upgrade menu checks for) or could not be fully checked; one Steam lists with Valve Anti-Cheat (a
    Steam game waits until Steam has said); one whose kernel anti-cheat leaves no files (Call of Duty since 2019);
    and one tagged Free to Play, Competitive, eSports or Massively Multiplayer. A plain PvP tag does not block a game:
    many LAN games without anti-cheat have it.
  - ROMs, recompilations, games that are not installed and a paired PC's games are never offered.
- **The first press** downloads PeerParty from the latest release on its GitHub page and checks it against the
  checksum published with the release (and GitHub's own) before it is used; a download that does not match is thrown
  away. A newer release is taken the same way, at most once a day, and never while a game runs through PeerParty.
  The square pulses while it downloads, checks and starts the game.
- **Steam games:** Steam must be running. PlayOut starts it first when it is not.
- **While playing**, PlayOut tracks the session like any game (play time, last played) and the in-game overlay
  (section 4.4) works as usual. PeerParty's own overlay opens with Shift+Tab over the game.
- **The Home button stays PlayOut's.** PlayOut runs its own copy of PeerParty, with its settings kept in PlayOut's
  data folder (section 11), and turns PeerParty's Home button shortcut off there, so the controller's Home button
  keeps opening PlayOut's overlay. PeerParty's keyboard shortcuts (Shift+Tab, Shift+F3) still open its overlay.
- PeerParty is MIT-licensed and made by its own contributors; it is not part of PlayOut (see LICENSES.md).

### 4.3 Streaming: play another PC's games on this one

Two PCs with PlayOut can share their games. The **host** (say, the gaming PC in the living room) lets other PlayOut
computers see its installed store games and its ROMs; a **client** (a laptop, a TV PC) shows them in its own library
and plays them by **streaming** (the game runs on the host, the picture comes over the network) or, for ROMs, by
**downloading** them. Streaming uses two free programs PlayOut downloads by itself the first time: **Sunshine** on the
host and **Moonlight** on the client (both open source, GPL-3, separate from PlayOut).

**On the host**

1. Settings → **Streaming** → **Let other PlayOut computers connect** (on by default when PlayOut is newly installed;
   a PC that already had PlayOut keeps its own choice). PlayOut starts its host service, downloads Sunshine once
   (about 30 MB) and runs it in the background, without a window or a tray icon.
   - **Share my logins with paired computers** (on by default): a paired computer gets this PC's metadata logins
     (SteamGridDB, IGDB, ScreenScraper, TheGamesDB, Steam Web API key and SteamID) and RetroAchievements login. They
     only fill services that computer has no login for: a login typed there is never replaced. They travel only over
     the paired, encrypted connection. Turn it off to keep them on this PC; logins already copied stay on the other
     computer until removed there.
2. **Windows Firewall**: the first time hosting starts, PlayOut asks once for administrator rights to open its own
   ports (TCP 47900 and UDP 47901) on every kind of network. This includes a home network that Windows calls
   _Public_, and it switches off any rule from an earlier "Block" answer for PlayOut. Without this, the other PC
   cannot find or reach this one. It shows the host offline and keeps the game list from the last time it connected,
   so games added since never appear. If you decline the prompt, Settings shows why; switch hosting off and on to be
   asked again. Sunshine opens its own ports when it installs.
3. **Port forwarding** says how far the host can be reached:
   - **Reachable over the internet at …**: the router allows automatic port forwarding (UPnP), so a paired PC can
     also stream from outside your home. A paired PC learns the host's new internet address by itself whenever it
     reaches the host (for example at home), so a changing home IP needs no new pairing.
   - **… Streaming ports could not be forwarded**: the router forwarded PlayOut's port but not all of Sunshine's.
     From outside, games can be listed and ROMs downloaded, but streaming may fail (the client's error then says so).
   - **Not available on this network**: only computers on the same network can connect. To use it from outside,
     forward TCP port 47900 (and Sunshine's ports 47984-48010) to this PC in the router yourself, or turn on UPnP.
   - **This network is behind another router or your provider's shared address (CGNAT)**: the router forwarded the
     ports, but its own internet address is private (a second router in front of it, or a provider that shares one
     address between customers), so nothing from the internet gets in. Only computers on the same network can
     connect.
4. **Controllers**: a controller on the client reaches the host's game only when the **ViGEmBus** driver is installed
   on the host (Settings shows a notice and a link while it is missing). Keyboard and mouse always work.

**Pairing (once per client)**

1. On the host: Settings → Streaming → **Pair a computer** → **Show PIN** (available once the host has started). A
   4-digit PIN appears for 5 minutes; **Cancel** hides it. When the other PC pairs, the host says "<name> is now
   paired".
2. On the client: Settings → Streaming → **Find computers on this network** and pick the host, or **Enter address**
   (the host's address, shown under its own Streaming settings; add `:port` if it was changed). Type the PIN and
   choose **Pair** (with a controller, **Done** on the on-screen keyboard pairs at once). A wrong or expired PIN
   empties the field, puts the focus back on it and keeps the reason under it. **B** closes the address form.
3. The client is paired until you remove it on either PC. Five wrong PINs from one computer lock that computer out
   for 10 minutes; twenty wrong PINs in all lock pairing on the host for everyone for 10 minutes.
   Right after pairing, the client also pairs Moonlight with the host in the background (a Moonlight window may flash
   briefly); if that fails, the host's row in this PC's Settings → Streaming says "Streaming not paired yet", and it
   is tried again when you stream.
   Right after pairing, the client also takes the host's logins (when the host shares them; a toast says
   "Using <host>'s logins for …") and starts downloading the host's **Emulation** folder (BIOS, saves, emulator
   settings and the rest), without `roms`, `Updates and DLC` and `texturepacks`. After that the two folders stay in
   sync both ways while **Sync the Emulation folder** is on.
   The **Library tabs** stay the same on the paired PCs too, both ways, while **Sync Library tabs with the host /
   clients** (Settings → Streaming, on by default) is on: adding, deleting or moving a tab and changing its filters,
   sort or Playable first on one PC reaches the others (a client sends its change about 2 seconds later; the host
   passes it on to its other clients when they next check in, every few minutes). The newest change wins. On the
   first contact the client takes the host's tabs. Each tab's search text stays on its own PC, and a filter on a
   system or store only one PC has is kept (that PC's tab name shows it as it is). Turn the switch off on a PC to
   keep its tabs to itself: it then neither sends its tabs nor takes another's.
   The **favourites** stay the same as well, game by game, while **Sync favourites with the host / clients**
   (Settings → Streaming, on by default) is on: for a game both PCs have (one the client's Library shows as its own
   card with the host listed under it: the same store game, the same ROM file, or the same title from another store
   with release years that agree or are not known yet), making it a favourite or not on one PC reaches the other (a
   client sends its change about 2 seconds later and picks up the host's on its next check, every few minutes; the
   host passes a client's change on to its other clients). The newest change wins; favourites you had before on
   either PC are kept on both. A host's game shown on the client (one the client does not have) shows the host's
   favourite, and **X** or the star on its page makes it a favourite or not on the host (the host must be reachable).
   Turn the switch off on a PC to keep its favourites to itself. A client's favourite on a game the host does not
   offer (one the host does not have, or has hidden) is not sent this way; it still reaches the host through the
   favourites list in the Emulation folder (section 1) while **Sync the Emulation folder** is on: it takes effect on
   the other PC right after the Emulation folder sync brings the list over.
   The **play time** adds up too, while **Sync play time with the host / clients** (Settings → Streaming, on by
   default) is on: for a game both PCs have (matched the same way as the favourites), each PC's play sessions are
   copied to the other, so its play time, play count, last played, **Played - Most** and **Played - Recently** count
   the play on both. A client sends a session about 10 seconds after the game closes and picks up the host's on its
   next check (every few minutes); the host passes a client's sessions on to its other clients. Each session counts
   once, however often the PCs exchange. The first exchange (and a game the two PCs only share from now on) brings
   all the sessions played before. A game you stream from the host is timed on the host only, and its sessions then
   reach the client. For a Steam, Epic or Xbox game played on the other PC with the same store, only the play count
   and last played change: the store's own play time for your account already counts it. A host's game the client
   does not have keeps its play time on the host, but the client shows when it was last played (by the host, by a
   stream, or by another client that has the game): it is then in the client's **Recent Games** row and sorted by
   **Played - Recently** like the rest. The client learns it on its checks (every few minutes) and about 10 seconds
   after a stream closes. A store game the host has not installed still tells the other PCs when it was last played: play it on one
   client, and another client that owns it (installed or not) lists it in **Recent Games** after their next checks;
   only the date crosses, by the store's own id, so the same game from a different store is not dated. A game only
   another client has (not the host, and not in this PC's own library) is never shown. A host running an older
   PlayOut shows no last played on its games until it is updated. Turn the switch off on
   a PC to keep its sessions to itself: it then neither sends its sessions nor takes another's, and neither tells
   nor shows when games were last played on the other PCs.
   **Achievements** need no switch. A game both PCs have shows its achievements from each PC's own Steam and
   RetroAchievements accounts, which are the same ones when the client took the host's logins (see above). A host's game the
   client does not have shows the host's **Achievements x/y** on its page, and expanding it loads the full list from
   the host (the host must be reachable; an older PlayOut on the host shows none).
4. **First start:** the first time PlayOut opens on a PC, it looks for PlayOut hosts on the network. When it finds
   any, it asks **Connect to a PlayOut host?** with a **Connect to <name>** button for each one. Connect opens
   Settings → Streaming with that host's address filled in and the cursor in the PIN field: show the PIN on the
   host and type it. **Not now** skips it; you can pair later the usual way.
5. Addresses are IPv4 (for example 192.168.1.20) or computer names; IPv6 addresses are not supported.
6. Removing a paired computer on the host also makes Sunshine forget every Moonlight pairing: the computers that stay
   paired pair Moonlight again by themselves the next time they stream.

**Playing**

- The host's games appear in the client's Library, Home and search with a small cast icon, unless Settings →
  Streaming → **Show games from paired computers** is off. A game both PCs have shows only once (this PC's copy), with
  **Stream from <host>** in its Play menu (the ▾ next to Play).
- A host-only PC game has **Stream** where Install would be. A host-only ROM has **Download**: the ROM (with its
  .cue/.bin tracks, .m3u discs or game folder) is copied into this PC's ROM folder at the same place and added to the
  library; **Stream** is in its menu. Downloads need a ROM folder (Settings → Library) and an emulator for the system:
  without a ROM folder the Download slot says so, and pressing it opens Settings → Library. A download started from a
  cover's menu shows a toast and a progress bar along the bottom of the card.
- A **PS4 or PS5 game** (a dumped folder launched through its `eboot.bin`) is its whole folder: its size is the folder's,
  and Download copies everything in it, `eboot.bin` last. A PS4 folder holding nothing but its `eboot.bin` (what
  earlier versions downloaded) is not listed as a game, so the host's copy shows Download again and that download
  fetches the rest of the folder.
- A **PS3 game** brings what RPCS3 installed for it on the host along: its updates and DLC (the host's
  `Emulation\Updates and DLC\PS3\dev_hdd0\game\<serial>` folder, also a PSN game installed there, and its data folders named after the serial such as
  `BLUS30443DATA`) and their licenses
  (`.rap` / `.edat` files in `dev_hdd0\home\00000001\exdata` and `dev_hdd0\exdata`: those named after the serial, and
  those of its DLC filed under another serial, found by the content id each of the game's `.edat` files names). They
  go to this PC's `Emulation\Updates and DLC\PS3\dev_hdd0`,
  wherever its ROM folder is, and count in the download's size (checked against the free space of that drive). A
  file this PC already has is downloaded again when the host's copy is newer, so a newer update replaces an older
  one even when the files are the same size; a newer copy this PC has (an update installed here) is kept. The updates
  are copied before the game itself, so a download stopped half-way never leaves the game without them. PlayOut finds the serial in the game's `PARAM.SFO`
  (game folder or `.iso`), in a `.ps3` serial file or RPCS3 shortcut, or in the name (`Game [BLUS30443]`); a game
  without one is downloaded without its updates and DLC. DLC RPCS3 installed under another serial is not included. Both PCs need PlayOut 0.1.109 or later: a host
  does not send these files to an older PlayOut.
- A **Switch or Xbox 360 game** brings its updates and DLC along the same way: the files and folders in the host's
  `Emulation\Updates and DLC\Switch` / `Xbox360` that belong to it, also inside plain sorting folders there
  (`Switch\Updates`, `Switch\DLC\Part 1`, up to three levels; a folder named after a game or carrying a title id is
  an item itself): by title id when both carry one (a Switch update `[0100F2C0115B6800]` or DLC belongs to the game
  `[0100F2C0115B6000]`; a different id is never the game's, even with the same name). The game's id is read from its
  ROM file name, its folder's name (`TotK [0100F2C0115B6000]\game.xci`) or, for Xbox 360, a folder named after the
  id. An Xbox 360 ROM's 8-digit tag may be a collection's checksum: then an item with another id still matches by the
  very same name. Without ids, by a similar name: the name is compared with the game's ROM file name and its title in
  the library, without tags in brackets, versions, numbered updates (TU2, TU 2, Title Update 2, Update 3), the words
  Update / DLC / Patch, and region, language and format words (US, EU, NSP, XCI...): "The Legend of Zelda Tears of
  the Kingdom [Update] v1.2.1.nsp" goes with "The Legend of Zelda Tears of the Kingdom.xci". Two looser matches only
  ever come with a download: the subtitle of a title with a colon or a dash ("Tears of the Kingdom Update v1.2.1.nsp"
  and "Zelda - Tears of the Kingdom (US) DLC.nsp" for "The Legend of Zelda: Tears of the Kingdom", when that is the
  game's title in the library), and a DLC whose own name follows the game's, when it says DLC ("Xenoblade Chronicles
  3 Future Redeemed DLC.nsp" for "Xenoblade Chronicles 3"; without the word DLC it would be another game, as "Mario
  Kart 8 Deluxe" is not "Mario Kart 8"). Words in front are always another game ("Super Street Fighter IV" is not
  "Street Fighter IV"), and abbreviations ("TotK") do not match: name such files with the title id or the game's
  name. An item two games of the host's library could claim goes to the closer name only, and one they match
  equally to neither, except copies of one game with the same title id, which each get it. They land in this PC's
  `Emulation\Updates and DLC\Switch` / `Xbox360` under the same name and path, after the game, and count in the
  download's size and progress; one that cannot come (no room left for it, the host still writing it) is skipped,
  never the game, and the catch-up below brings it later. A file this PC already has at the same size, or newer, is
  kept; an older one of another size is replaced. Ryujinx loads the Switch ones: PlayOut adds
  `Emulation\Updates and DLC\Switch` to its autoload folders (when it sets Ryujinx up, and before a launch of a
  Ryujinx it set up earlier). Other Switch emulators and Xenia do not read that folder: install the update there
  yourself (Xenia wants a TU in its own `content\<title id>` layout). Both PCs need PlayOut 0.9.98 or later: a host
  does not send them to an older PlayOut, and an older host sends none.
- **A game downloaded before** (or one you already had that the host also has) gets the updates and DLC it lacks on its
  own: after a refresh that reaches the host, PlayOut compares each PS3, Switch and Xbox 360 ROM game with the host's
  copy (at most every 6 hours per game, 20 games per refresh; again after 10 minutes when the host could not be
  reached) and downloads, in the background, only the update and DLC files missing here, never the game again; a
  notice says what came (or why it could not). A file already here is never replaced, and one this PC had once and
  you deleted is not brought back. Nothing is deleted. It stops when a download starts (and goes on at a later
  refresh), and when you delete the game from this PC.
- A game's **texture packs** come along too: the folders in the host's `Emulation\texturepacks` named after the game's
  serial or id, in the folder of the emulator that plays it: `pcsx2` (PS2, e.g. `SLUS-20777`), `duckstation`
  (PlayStation, `SLUS-00594`), `ppsspp` (PSP, `ULUS10336`), `dolphin` (GameCube / Wii, the GameID `GALE01` or the
  three-letter `GAL` all regions share), `flycast` (Dreamcast, the product number such as `MK-51058`),
  `azahar\textures` (3DS, the 16-digit title id) and `ryujinx\contents` (Switch, the title id). A folder matches when
  its name is the id or starts with it, written with or without `-`, `_` or `.` (`SLUS-20777`, `SLUS_207.77`,
  `SLUS-20777 HD`, `SLUS-20777 - God of War`); never by title, and never a longer id (`SLUS-207771`). PlayOut reads
  the id from the game itself where it can (a PS2 / PlayStation disc's `SYSTEM.CNF`, also inside a `.bin`, `.cue`,
  `.cso` or `.chd`; a PSP disc's `UMD_DATA.BIN` or `PARAM.SFO`, an `EBOOT.PBP`; a GameCube / Wii disc header, also
  in `.rvz`, `.wia`, `.wbfs` and `.ciso`; a 3DS cartridge header; a Dreamcast `.gdi`'s boot file), and also takes an
  id in the file or folder name (`God of War [SLUS-20777].iso`, `Zelda [GALE01].rvz`, `Game [0100000000010000].nsp`).
  A multi-disc game (an `.m3u`) matches the serials of all its discs. The emulator's own texture dumps in a game's
  folder (`dumps` for PCSX2 and DuckStation, PPSSPP's `new`) stay on the host. The packs land in this PC's
  `Emulation\texturepacks` at the same place and count in the download's size and progress; a texture file this PC
  already has is kept as it is, whatever its size, and never replaced. A game whose id is not found, or that has
  no matching folder, is downloaded without texture packs. Both PCs need PlayOut 0.1.134 or later: a host does not
  send texture packs to an older PlayOut (it would put them in its ROM folder), and an older host sends none.
- A game this PC owns but has not installed, which a paired host can stream, stays in the library with **Stream from
  <host>** even when Settings → Library hides games that are not installed.
- While a stream starts, the button says what is happening (downloading Moonlight the first time, starting on the
  host, pairing, connecting); pressing it, or **Cancel stream** in its menu or the cover's menu, stops the start. Then
  Moonlight shows the game full screen and PlayOut steps aside. **Stop streaming** (on the game page or the cover's
  menu, or quitting Moonlight with Ctrl+Alt+Shift+Q) closes the game on the host.
- A stream that fails keeps its reason under the button (as a failed download does); on a host's game the button
  becomes **Retry**.
- **Quality** (Settings → Streaming): resolution (**Auto** = this screen), frame rate and bitrate (**Auto** lets
  Moonlight choose).

**Limits**

- One stream at a time per host, and not while someone plays another game on the host.
- The host PC must be on, signed in and awake, with PlayOut running there (Sunshine runs only while PlayOut does).
- A host streams to one paired computer at a time: another one gets "streaming to another computer", and its Stop
  never ends someone else's stream.
- Games that ask for administrator rights show the Windows prompt on the host, where the streamed user can answer it
  only with a mouse.
- Over the internet the quality depends on both connections' upload and download speed; lower the bitrate if the
  picture stutters.

### 4.4 The home button and the in-game overlay

Press your controller's **Home** button (Xbox / PS / the handheld's home button) during any game to open PlayOut's
overlay over it. Press it again, or B, to go back to the game.

- **Changing the button:** in Settings › Controls › Home button, choose **Change** and hold the new buttons together.
  You can use up to four buttons. A single button other than Home is refused, because games use those all the time.
  You can also set how long the buttons must be held.
- **Steam:** PlayOut turns off Steam's "Guide button focuses Steam" and "Enable the Steam Overlay while in-game", so
  the Home button opens only PlayOut and Steam's overlay never shows over your game. Steam restarts quietly to change
  its settings, never while a game is running. Turning the option off puts both back.
- **Xbox Game Bar:** **Turn off Xbox Game Bar** stops it opening over the overlay. Its controller shortcuts and links
  are turned off, and Game Bar is closed if something still starts it.
- Turning these options (or the home button) off puts everything back as it was.
- **Pause:** while the overlay is open the game is frozen, so it takes none of your buttons. It runs on when the
  overlay closes. Turn off **Pause the game while the overlay is open** for online games that would disconnect.
- **Touch:** on a touchscreen, swipe right from the left side of the screen during a game to open the overlay. Start a
  finger's width in from the edge, because Windows keeps the very edge for its own swipe. Turn it off with **Swipe from
  the left to open the overlay**.
- **Power:** pick a profile: Silent, Balanced, Performance, Custom, or Off, which leaves Windows as it is.
  - Each profile sets the Windows power mode, the CPU's maximum speed and boost, and on ASUS laptops the firmware's
    Whisper / Standard / Performance mode.
  - **Use for &lt;game&gt;** keeps the profile for that game. It is applied every time the game starts, and put back
    afterwards.
  - **Exact watts:** install the power helper in Settings › System. It needs one administrator prompt, and it uses the
    PawnIO driver.
  - **With the power helper:** once the power helper is installed (Intel, or a supported AMD Ryzen), the choices
    become **Dynamic**, **Custom watts** and **Off**, and Dynamic is the default. Silent, Balanced and Performance are
    no longer shown; one you chose before installing the helper (for outside games, or as a game's own) now runs as
    Dynamic. Custom watts uses your Custom profile: set its watts in the overlay with **Edit Custom watts**.
  - **Dynamic TDP:** with the power helper, **Dynamic** is the default. During a game it raises or lowers the watts by itself to
    hold your target frame rate (30, 40, 45, 60, 90 or 120 fps, or any value from 20 to 240 with the slider), and
    shows what it measures, for example "58 fps · 14 W". With **Use for &lt;game&gt;** the game keeps its own target.
    When more watts would not give more frames (the graphics card or a frame cap is the limit), it stops climbing.
    Settings › System sets the default target and an optional lowest and highest watts. The frame rate is measured
    with Intel's PresentMon, which the power helper downloads; an older helper asks for one update (one administrator
    prompt).
- **Display and sound:** brightness, volume, refresh rate and resolution of the game's screen.
- **Header chips:** the game's live frame rate ("120 FPS") and the CPU's power ("15 W"), updated about once a second
  while the overlay is open. A chip hides while its value is unknown. The frame rate comes from RivaTuner Statistics
  Server, or from Dynamic TDP's measurement when RivaTuner is not drawing the game.
- **Game tiles** (the **Game** filter on the Performance tab, also under **All**). A tile that cannot act now is
  dimmed and says why.
  - **Performance overlay** (needs RivaTuner Statistics Server running): Off, or level 1 (FPS), 2 (FPS, frame time,
    CPU %, GPU %, watts) or 3 (adds RAM, battery and the time), drawn by RivaTuner in the game's top-left corner and
    updated each second. It shows in games started from PlayOut.
  - **Frame rate limit** (needs RivaTuner Statistics Server running and the power helper): ∞ (no limit), 30, 40, 45,
    60, 72, 90, 120 or the screen's refresh rate. RivaTuner caps the game at it within a couple of seconds. The choice
    is kept for that game and applied again each time it starts; ∞ puts RivaTuner's profile for the game back as it
    was. PlayOut never changes RivaTuner's global profile.
  - **Sync FPS + refresh:** while on, the limit follows the screen's refresh rate (also after you change the refresh
    rate in the overlay, and when a game starts). Picking a limit yourself turns it off.
  - **Auto HDR:** Windows' Auto HDR for DirectX 11 and 12 games. It applies to games started next. It is dimmed while
    HDR is off for the screen (Windows Settings › Display).
  - **CPU boost:** turns the CPU's boost on or off for the power profile in use. For Silent, Balanced and Performance
    the change is kept as that profile's override (the tile says "(changed)"); for Custom it changes Custom itself.
    It is dimmed while Dynamic TDP is in charge, which sets the boost itself.
  - **Endurance Gaming** (PCs with Intel graphics only): Intel's battery saver for games. **Auto** with better
    performance, balanced or maximum battery paces the frame rate while the PC runs on battery; it applies to all
    games. The choices are the ones your Intel driver offers.
  - If Winhanced is running, a line under the tiles reminds you that it also drives RivaTuner. PlayOut only changes
    each game's own profile.
  - RivaTuner starts measuring a game about 15 seconds after it starts, so the frame rate shows "—" until then, and
    for games with anti-cheat that RivaTuner does not hook.
- **Music:**
  - What Windows is playing (Spotify, a browser, Plex…) with play, pause, next and previous.
  - Your own music folder, with a playlist per game. Settings › System › Music sets what happens when a game starts.
- **Game:** back to the game, back to PlayOut, or quit the game.
- **Downloads:** the install queue (section 3.5), with the progress of the game downloading now.
- **Friends:** your Steam friends, in three groups with their counts: **Playing** (the game each one is in),
  **Online** (Online, Busy, Away, Snooze, Looking to trade or to play) and **Offline** ("Last online 3 h ago"; folded
  away until you choose **Show offline friends**, then 50 at a time). The list is read when you open the tab and
  every minute while it stays open; **Refresh** reads it now, and the top line says when it was last read.
  - **Needs:** your Steam Web API key and SteamID64 in Settings › Metadata (the same ones that bring achievements and
    play time), and a friends list Steam shares: in Steam, Profile › Edit Profile › Privacy Settings, set **Friends
    List** to **Public**. Otherwise the tab says what is missing. PlayOut never signs in to Steam for this.
  - **Message:** press A on a friend. The overlay closes and **Steam's own chat** opens with that friend, in Steam's
    window (Steam must be installed). Over a game in exclusive full screen, Steam's window may make the game minimize
    while you chat; it comes back when you switch to it.
- **PeerParty:** while the game you are in runs through PeerParty (LAN play, section 4.2), this tab takes the place of
  Friends (a network icon). It shows the game, whether LAN play is on ("Starting…" just after the game starts), and
  how many players of the game PeerParty sees on your network, you included. **Invite everyone on the LAN** asks the
  game to invite them all; the tab says "Invite sent", or "No PeerParty game took the invite" when the game did not
  answer. PeerParty does not share its players' names, so the tab cannot list them or invite just one player: use
  PeerParty's own overlay (Shift+Tab) for that. When the game ends, Friends comes back.

The overlay draws over borderless, windowed and most full-screen games, which stay on screen under it (the overlay
leaves them in front). If such a game is not paused (because of anti-cheat or a competitive online game), it also sees
the buttons you press in the overlay. Some games run in true exclusive full screen (Spelunky 2 set to Fullscreen, for
example), where any window over them makes them minimize. For those, PlayOut draws the overlay **inside the game**
instead, so it stays on screen: this works with 64-bit Direct3D 11 games, and never with a game that has anti-cheat
(or that PlayOut cannot be sure has none). With **Pause the game** on, the game's picture is frozen under the
overlay until you close it; with it off, the game runs on but does not see your controller. Other exclusive
full-screen games still minimize while the overlay is open and come back when it closes: set such a game to
Borderless (or windowed full screen) in its video options to keep it on screen. Settings › Controls › **In-game
overlay** turns this off; if a game ever crashes with the overlay inside it, PlayOut stops using it for that game and
lists it there, with **Remove** to try again.

### 4.5 Recompilations: native PC versions of your games

Some console and older PC games have been rebuilt as native Windows programs by fan projects (static
recompilations, decompilations and source ports such as _Zelda 64: Recompiled_ or _Ship of Harkinian_). They run
without an emulator, often with widescreen, high frame rates and mods. PlayOut lists them from two catalogs,
[decomp-buddy](https://tanookistudios.com/decomp-buddy/) and [RecompLauncher](https://recomplauncher.com/), and
downloads them from the projects' own GitHub (or GitLab / Codeberg) releases. Nothing is bundled with PlayOut: about
10 seconds after PlayOut starts, when the PC is online, it checks both catalogs for new recompilations (and again
once a day). Started offline, it uses the copy from last time and checks as soon as the PC is back online.

- **Which games.** **Filters → Recompilations** in the Library lists every game with a recompilation available,
  installed or not, including a host's games ready to download.
- **The UP button.** A game with at least one recompilation shows an **UP arrow** square at the top left of the four
  squares right of **Play** on its page (the bottom-left and right squares are Co-Op and PeerParty, the top right
  one Upgrade; an unsupported one stays empty). ROM games are matched by their system and name; store and manual PC games by name (so a source port of a PC
  original shows up too).
  - None installed yet: UP opens the **Recompilation page**.
  - Installed: **Play** starts the recompilation you chose. When the one you chose is not installed but another
    recompilation of the game is, Play starts that one instead (the first installed one, recommended first). It
    counts as playing that game (play time, last played). The UP square, filled in the accent colour, then opens the
    Recompilation page.
  - When it is not clear which program starts the game (the recompilation shipped several that could be the game, and
    neither you nor the developer named one), the first UP asks _Which program starts …?_: PlayOut's best guess first, then
    the others (uninstallers, crash reporters and the like dimmed below), plus **Browse…** and **Cancel**. Pick one and
    the game starts; every later UP starts that program without asking (change it under **Program** on the page).
    Tools, extractors and runtime installers do not count, nor do files copied into its folder later; once PlayOut's
    pick has started the game, or you pressed **Automatic**, UP never asks.
  - While it downloads or updates, the button pulses.
  - The ▾ menu's **Recompilation…** opens the page at any time.
  - With a recompilation installed, the ▾ menu also has **Delete recompilation**. It asks _Are you sure you want to
    delete this Recompilation?_ with **Yes** and **No**; Yes deletes the one UP starts and every file it built (its
    folder, the game files PlayOut copied into it, leftover downloads). Saves it keeps outside its folder stay, and the
    saves and settings in its own folder are zipped to the backups first.
- **The Recompilation page** shows everything about the game's recompilations:
  - **Versions:** when several projects port the same game, each is listed (recommended, installed, your choice,
    update available). Pick one and press **Use this one**; UP starts that one from then on.
  - **Install · size** downloads and installs it with a progress bar. Downloads are checked against a published
    checksum when there is one; one without a checksum is installed with a visible warning. A project that ships a
    setup program (installer) is saved, not run: UP then runs its setup (until you choose the game's program under
    **Program**).
  - **Setups that need the retail disc:** some setup programs only accept the exact retail disc image and refuse a
    trimmed one (as **Trim Games** or Convert make), but skip the image when the game is already unpacked where they
    install. For those (today _Xerenge_, Burnout Revenge: `%USERPROFILE%\Games\Burnout Revenge\game`), UP first
    unpacks your Xbox 360 image of the game from your library into that folder, checked file by file, and then runs
    the setup; the page shows **Unpacking… %** meanwhile (a few minutes). Already unpacked there: nothing is redone.
    If it cannot be unpacked (for example that folder already holds other files), the setup still starts and PlayOut
    tells you why.
  - **Update to vX**, **Uninstall** (your own files are backed up first), **Open folder** and **View on GitHub**.
    Pinned to an older release, the page shows _Pinned to <tag>_ and **Back to latest** in place of **Update to vX**.
  - Tags, features, the project's description and **How to set up**, the facts (latest version, release date,
    download size, size on disk, stars, licence, completeness) and the project's **README**.
  - **Version** (installed): the release in use with its date and _Latest_, _Older version_ or _Pre-release_, the
    same as in Settings › Recompilations. **Change version** lists every release of that project, newest first (date,
    size, _Pre-release_, **Notes**, _In use_; releases without a Windows download dimmed with the reason); **Use this
    version** asks first, then installs that release in place, keeping your saves, settings, game files and program,
    with the progress (or an error) at the top of the page. A release older than the newest **pins** it there
    (_Pinned to <tag>_: automatic updates and **Update all** skip it) until **Back to latest**. Not installed yet, the
    section is **Releases**, with **Install this one** on each.
  - **Game files:** many recompilations need your own copy of the game (a ROM, a disc image or a game folder). PlayOut
    uses the game's ROM (or install folder) from your library when it fits, checks it against the known good dumps
    when the catalog lists them, and passes it the way the project expects (on the command line, in an environment
    variable, or copied into the right folder). **Pick…** chooses another file and **Clear** forgets it. Pressing UP
    with a file missing opens the page on its game files.
  - **Program:** the program Play and UP start, and who chose it (_PlayOut's pick_, _Named by the developer_ or
    _Chosen by you_). A recompilation often comes with several programs, and PlayOut's guess is not always right:
    **Change** lists the programs in its folder, the likely game first; uninstallers, crash reporters, setup programs
    runtime installers and tools (such as asset extractors) are marked and listed last. Pick one to start it from then on. **Browse…** chooses any
    `.exe`, also outside the recompilation's folder: for a port that installs with its own setup program (such as
    _Xerenge_, which puts Burnout Revenge in `%USERPROFILE%\Games\Burnout Revenge`), choose the game's program there
    once the setup has run, and UP starts the game (counted as play) instead of the setup. A program you choose runs
    in its own folder. **Automatic** goes back to PlayOut's pick (and UP then starts it without asking). Your choice stays over updates while the program is
    still there (otherwise PlayOut picks again), and is forgotten when you uninstall.
  - **Saves:** the folders where the recompilation keeps its saves (**Open save folder**), where their copy in the
    Emulation folder is (**Open the copies**), and a link to Settings → Recompilations, where save folders are chosen.
  - **Original disc image:** shown while an installed recompilation no longer needs the game's disc image, or no
    longer uses the game folder PlayOut unpacked for its setup program (see below), with **Delete the original disc
    image…** / **Delete the unpacked game folder…** (it asks the question below, also after you chose to keep it). When
    both may go, a **What to delete** dropdown beside **Delete…** picks _Delete the disc image_, _Delete the unpacked
    game folder_ or _Delete both_, and the question opens with that choice. Settings → Recompilations shows the same
    on the recompilation's card.
- **Delete the original disc image?** Once a recompilation of a disc game (ISO, CHD, CSO, RVZ, a .cue with its tracks,
  …) is ready, PlayOut asks _<Recompilation> is ready. Delete the original <file> (<size>)? It goes to the Recycle Bin;
  the game stays in your library and starts the recompilation._ with **Delete** and **Keep it**:
  - When: as soon as you pick the program that starts the game (under **Program**, in UP's _Which program starts …?_)
    or confirm PlayOut's pick with **Automatic**. When PlayOut found the program on its own, it waits until that same
    program has started the game twice (a start that fails does not count, and the count starts over if the program
    changes).
  - Never for a recompilation that still reads the disc image at every start (one PlayOut starts with the image, or a
    folder holding it, on the command line, in an environment variable, or copied into its folder), nor while a game
    file it needs is not picked yet (it asks once the game is ready, at its next start), nor for cartridge ROMs. Each
    recompilation asks about an image once: **Keep it** is remembered. **B** / **Esc** means _not now_: it asks again
    the next time PlayOut starts, unless the recompilation needs the image by then (its game files or program
    changed), and **Delete** always checks that again first.
  - **Delete** moves the image and every file of it (a .cue's tracks, an .m3u's discs; not files another game uses) to
    the Recycle Bin, never deletes it for good. The game's card stays with its art, play time and favourite; Play and
    UP start the recompilation. ROM-only features (Convert, Trim Games, emulators, texture packs, downloads by paired
    PCs, **Delete from this PC** of the ROM files) leave it alone. Paired PCs still see the game (favourite and play
    time keep syncing), and streaming it starts the recompilation; there is just nothing to download. Restore the
    image from the Recycle Bin and rescan, and the card is an ordinary ROM game again. If only some of an image's files
    could be moved (one was in use), the card stays an ordinary ROM game and PlayOut says which files to restore.
  - **The check after Delete:** some recompilations still need the disc image to run. So **Delete** does not send it
    to the Recycle Bin at once: it moves the files aside into a hidden `.playout-held` folder right beside them (an
    instant rename on the same drive; no extra space), says _Moved <file> aside. Starting <Recompilation> to check it
    runs without it…_, and starts the recompilation straight away (as UP does: its game files, saves and program
    apply).
    - Play as usual; the files wait aside until you close the game (a recompilation that cannot find its image may
      just sit on an error box, so still running proves nothing). Ran at least 20 seconds and closed normally: the
      files go to the Recycle Bin and PlayOut says _<Recompilation> started without <file>; it is now in the Recycle
      Bin._
    - It did not start, closed before that, or closed with an error code (a crash, or it refused to run without the
      image): PlayOut asks
      _Restore the disc image?_ — _<Recompilation> closed 3 s after it started (exit code …). A crash was detected:
      <Recompilation> may need the original <file>. Restore it?_ **Restore** (focused first) puts every file back at
      its exact place, and the card is an ordinary ROM game again; PlayOut remembers that recompilation keeps the image
      and does not ask again. **Delete anyway** moves the files to the Recycle Bin.
    - Not started for a reason that says nothing about the image (it was already running, its saves need you to pick a
      side, which program starts it is not chosen…): nothing is judged and nothing is deleted. PlayOut asks
      _Could not check the disc image_ with **Restore**, **Test again** and **Delete anyway**.
    - **B** / **Esc** is _not now_: the files stay aside (not deleted) and the question comes back the next time
      PlayOut starts. If PlayOut closes (or the PC turns off) during the check, it asks _Finish checking the disc
      image?_ at its next start, with the same three choices. Held files are never deleted without a passed check or
      **Delete anyway**, and never left aside without asking.
    - **Restore** never overwrites anything: if a file is back at that place already (you copied the image again),
      it says so and moves nothing; move that file away and press **Restore** again.
    - While files wait aside, nothing else touches them: library scans, Convert, Trim Games, the Emulation folder
      sync, downloads by paired PCs and texture packs all skip `.playout-held` folders, and **Delete from this PC**
      refuses a game folder that holds one until you answer. A file moved to the Recycle Bin from there is listed with
      its `.playout-held` location; to get it back later, restore it from the Recycle Bin, move it out of the
      `.playout-held` folder into its old place, and rescan.
    - The unpacked game folder (below) is checked the same way when **Delete** includes it.
  - It is not deleted while a conversion runs, the game is in the download queue, an emulator runs it, or a paired PC
    is downloading it (or fetched one of its files in the last 15 minutes): pressing **Delete** then says so and
    nothing is deleted. If the image is in use when the question would come, PlayOut does not ask yet; it asks at the
    recompilation's next start (or use **Delete the original disc image…** on its Recompilation page).
  - **The unpacked game folder:** for a setup program that takes the game unpacked (_Xerenge_; see _Setups that need
    the retail disc_), the question also offers the folder PlayOut unpacked your disc into
    (`%USERPROFILE%\Games\Burnout Revenge\game`), with its path and size: the **Delete** button then has a
    dropdown beside it (**A** / click opens it) with _Delete the disc image_ (the default), _Delete the unpacked game
    folder_ and _Delete both_. When the disc image is already gone (or you kept it), the folder is asked about on its
    own (_Delete the unpacked game folder?_). **Keep it** is remembered for each of them, and so is the one a delete left
    out; the Recompilation page can still offer it.
  - Only a folder PlayOut unpacked itself is ever offered (one you unpacked, or one that was already there, never),
    and only while the recompilation no longer uses it: never while the setup program is still what UP starts, while
    the program that starts the game is not identified, while the setup or the game runs, during an unpack, install or
    update, or when the game was installed around it. Xerenge's setup installs the game _around_ that folder by
    default (its program in `Burnout Revenge\bin` reads the game from `Burnout Revenge\game`, with its title
    updates and mods), so the folder is offered only when you installed the game somewhere else and PlayOut's unpacked
    copy is left over. PlayOut also never offers a folder that holds or is inside a recompilation's install folder, a
    game file it uses, PlayOut's own folders, a drive's top or a known folder such as `%USERPROFILE%\Games`, and
    checks all of this again when you press **Delete**. The folder goes to the Recycle Bin, never deleted for good; it
    is moved before the image with _Delete both_, so nothing is lost if the folder cannot go. While it is being moved,
    starting that recompilation is refused with _PlayOut is moving <folder> to the Recycle Bin;
    start <name> again when that is done._
  - Running the setup again later unpacks the folder again from the disc image while you still have it; after
    _Delete both_, a reinstall with the setup needs the disc image again (restore it from the Recycle Bin, or add it to
    your library again).
- **Settings → Recompilations** (between Emulators and VR):
  - The catalogs: how many recompilations they list and how many of your games have one, when they were last fetched,
    any that could not be reached, and **Refresh**.
  - **Browse** opens the **recompilation browser**: every recompilation in the catalogs, by game, whether the game
    is in your library or not. Search by the game's title, the recompilation project's name or its GitHub repository
    name ("Shipwright", "Zelda64Recomp"), author, console or tag, and sort by **Recently added**
    (to the catalogs), **Recently updated** (newest release) or **Most GitHub stars** (RecompLauncher's counts;
    projects only decomp-buddy lists have none and come last). Pick a game to see all of its recompilations side by
    side, with **Install**, **Project page** and, for a game in your library, **Open game page**. Recompilations a
    catalog check turned up in the last two weeks are marked **New**, and the Browse button shows how many.
  - **Add** (next to the search) puts a recompilation the catalogs do not list in the browser: paste or type its
    GitHub repository (`github.com/owner/repo`, any page of it, or `owner/repo`; **Paste** reads the clipboard) and
    press **Check**. PlayOut asks GitHub once per press: the repository must be public and have a release with a
    Windows download (it shows the stars, the description, the newest release and the file an install would take,
    and warns when the repository is **Archived** or a **Fork**, which can still be added). Only GitHub is supported.
    Then name the **Game** (guessed from the repository's name) and pick its **Console** (so it matches the game in
    your library; _Other_ works too) and press **Add**. The game's name must be plain text (no HTML or script links).
    Nothing is downloaded until you press **Install**. No catalog virus-scanned an added recompilation (yours, or one
    in PlayOut's list), so its first **Install** asks first, and the install report says so: PlayOut only checks that
    the download is the file GitHub published (GitHub's checksum, else it installs with the _unverified_ warning).
    A repository the browser lists already says so, with **Show it**.
  - An added recompilation shows at once, in its game's list, marked **Added by you** (and **awaiting approval**
    while it waits), and can be installed and played like any other. It is then sent to the maintainer as a
    suggestion (with your game and console, which the maintainer may correct) when **Suggest my edits** is on
    (Settings → Metadata → _Cloud metadata_), or published straight away on the maintainer's PC. While Suggest my
    edits is off the mark says **not sent**, and the add is sent once you switch it on; one the suggestion service
    refused says **not sent** too (point at the mark to see why) and stays on this PC. Once approved, every PlayOut
    lists it (with its next metadata check) and the _Added by you_ mark goes (it is never marked **New** on the PC that
    added it). **Remove** takes one you added out of the browser (a suggestion still waiting is not sent; one already
    sent is not withdrawn, and comes back with PlayOut's list if it is approved); when it is installed you choose
    whether to **also uninstall it** (its folder goes to the Recycle Bin) or keep it installed (it then leaves the
    browser but stays under Settings › Recompilations, where you can uninstall it later). If decomp-buddy or
    RecompLauncher lists the repository later, their entry takes its place (an install moves to it).
  - **Check for updates** and **Update all**. Installed recompilations are also checked when PlayOut starts; the
    ones with **Update automatically** on are then updated by themselves.
  - One card per installed recompilation: version, size on disk, **Update to vX**, **Update automatically**, the
    version the game uses (choosing one that is not installed installs it), **Open folder**, **GitHub** (its project
    page; GitLab or Codeberg for projects hosted there), **Uninstall**.
  - **Version** per recompilation: the release in use (its tag and date, marked _Latest_, _Older version_ or
    _Pre-release_) and **Change version**, which lists every release of that same project, newest first: tag, name,
    date, size, _Pre-release_, **Notes**, and _In use_ on the one you have. Releases without a Windows download are
    dimmed with the reason. **Use this version** asks first (_Switch <name> to <tag>? Your saves and settings are
    kept._), then installs that release into the same folder like an update: your saves, settings, game files and
    chosen program are kept, and the progress (or an error) shows on the card. Choosing a release older than the
    newest **pins** the recompilation to it: the card shows _Pinned to <tag>_, and the startup update check, **Update
    automatically** and **Update all** leave it alone. **Back to latest** (in place of **Update**) installs the newest
    release and removes the pin; choosing the newest release in the list, or uninstalling, removes it too. The
    Recompilation page has the same **Version** row and **Change version** list.
  - **Saves** per recompilation: the save folders in use, where they came from (the developer, the catalog, found by
    PlayOut, or yours), **Remove**, folders found but not used yet with **Add**, **Add save folder…**, **Find
    automatically**, **Open**, the **Copy saves to the Emulation folder** switch, where the copies are (**Open**) and
    **Copy now**.
  - **Delete…** per recompilation, the same as the Recompilation page's _Original disc image_ section: shown only
    while the recompilation no longer needs its game's disc image and/or no longer uses the game folder PlayOut
    unpacked for its setup program, with what may go (path and size of the folder, and _You chose to keep it before._
    after **Keep it**). **Delete the original disc image…** / **Delete the unpacked game folder…**, or, when both may
    go, a **What to delete** dropdown (_Delete the disc image_, _Delete the unpacked game folder_, _Delete both_)
    beside **Delete…**; it opens the same _Delete the original disc image?_ question with that choice picked, and
    everything is checked again when you press **Delete** there.
- **Finding the save folders.** PlayOut uses the folders the recompilation's developer or the catalog names. When
  nobody names them, PlayOut looks right after the install (and when you press **Find automatically**) in the usual
  places — Documents, Documents\My Games, Saved Games, AppData\Roaming, AppData\Local, AppData\LocalLow and the
  recompilation's own folder — for folders named like the game, the project or its program that hold save files. One
  found is used; when there are several, they are listed for you to **Add**. If nothing is found, PlayOut watches
  which files change the first time you play and keeps the folders where saves appeared. For the rare game it still
  cannot find, **Add save folder…** in Settings → Recompilations picks the folder yourself (folders too broad to copy, like AppData or Documents
  themselves, are refused).
- **Save copies in the Emulation folder.** Before and after you play, PlayOut copies each recompilation's saves to
  `Recompilations Saves\<recompilation>\` in your Emulation folder (Settings → Library; by default
  `Documents\Emulation`), and copies them back to where the recompilation keeps them when the copy there is
  newer. The Emulation folder is what PlayOut's streaming shares between your PCs (section 4.3), and it can sit in a
  folder your cloud app syncs, so your saves follow you. It is on for every recompilation; its switch turns it off
  for one. The newer side wins; what it replaces is kept as a backup on this PC
  (`<Recompilations folder>\.playout\save-backups\`). When the saves changed on both sides since the last copy,
  PlayOut asks which to keep (**Keep this PC's saves** / **Keep the Emulation folder's copy**) before the game starts.
  When the saves are gone from a PC that copied them before (you deleted them, or the game reset them), PlayOut asks
  too instead of copying them back: **Restore from the Emulation folder** puts them back; **Start fresh** starts the
  game with no saves. Nothing is deleted then: the copy stays in the Emulation folder until the copy after you next
  play replaces it with this PC's new saves (the old copy is backed up on this PC first, with the other replaced
  copies). Those new saves then become the copy every PC gets: another PC that copied the old saves backs its own
  saves up and takes the new copy the next time it plays. A PC that never copied the recompilation's saves takes the copy without asking (setting up a new PC).
  Saves an older PlayOut copied into a cloud folder you chose are taken over once, the first time each recompilation
  is copied (the old copy is left where it was); if they differ from this PC's saves, PlayOut asks which to keep.
- **Saves of PC games you added.** The same copying works for PC games you added yourself (Add game). Open the
  game's page, **Edit**, and under the game's settings press **Choose…** next to **Save folder** to pick the folder the
  game keeps its saves in (PlayOut shows its size first and asks before using a folder over 100 MB). From then on
  PlayOut copies that folder to `PC Saves\<game> (<code>)\` in your Emulation folder after you play, and copies a newer
  copy back before you play — so a PC that shares the Emulation folder (streaming's Emulation folder sync, or a cloud
  app) gets your saves when you pick the same game's save folder there. It also copies when the Emulation folder sync
  is off. What a copy replaces is backed up on this PC first (`pc-save-backups` in PlayOut's settings folder, never in
  the Emulation folder); when the saves changed on both sides, Play asks which to keep (**Keep this PC's saves** /
  **Keep the Emulation folder's copy**), as it does the first time both PCs already had saves. When the saves are gone
  from a PC that copied them before, Play asks too (**Restore from the Emulation folder** / **Start fresh**): Start
  fresh starts the game with no saves and deletes nothing, and the copy after you next play replaces the old copy with
  the new saves (backing the old copy up on this PC first); every other PC then takes the new saves, backing its own
  up first. If saves came back meanwhile, Start fresh changes nothing and the question is asked again. A game started by a paired PC's stream starts anyway, with
  the question waiting here. A copy another PC made
  for a game with the same title but a different program asks **Use the copy from <PC>?** before it is used. **Copy
  now** copies straight away; **Clear** stops copying that game and leaves its saves and their copy as they are.
  Folders that are too broad or not just saves are refused: a drive or a folder right below one, your user folder
  (and other users'), AppData, Local, Roaming, LocalLow, Documents, Saved Games, My Games, Desktop, Downloads,
  Pictures, Videos, Music or OneDrive themselves, network and device paths, a folder holding the game's program or
  other .exe / .dll files, a link or junction (or a folder holding one), PlayOut's own folders (the Emulation folder,
  its settings folder, Recompilations, Emulators), another game's save folder, a second entry of a game that already
  copies its saves, and anything over 512 MB or 20,000 files. All of this is checked again before every copy: a
  folder that no longer passes is skipped with a message, never copied in part. A save folder that is gone together
  with the folder around it (the game was moved) shows **Save folder not found**: choose it again. Games started
  with Co-Op or PeerParty, or outside PlayOut, are copied at their next start with Play; a game started again while
  it still runs copies nothing back; a game a paired PC streams starts even with the question open, which then waits
  for you here. **Settings → Library → Copy saves of games you added** turns it off for every game.
- **Achievements (Xbox 360 recompilations):** an Xbox 360 recompilation built on ReXGlue keeps its own record of the
  achievements you unlock in it, and PlayOut reads that record. When Play starts such a recompilation, the game page
  shows an **Achievements x/y** stat in place of RetroAchievements. Expand it to see each achievement with its name,
  description and gamerscore (**25 G**), when you unlocked it, and the ones still locked. Secret ones stay hidden
  until you unlock them. The header shows your gamerscore out of the game's total.
  - The names and gamerscore are the game's own Xbox 360 achievements, in PlayOut's language when the game has it.
    PlayOut reads them from your copy of the game: the `default.xex` in the recompilation's folder, the game files you
    chose for it, or your Xbox 360 disc image (.iso). When the recompilation ships its own achievement list, its
    entries replace or add to the game's, as they do in the game. They are kept in
    `%APPDATA%\PlayOut\recomp-achievements\` after the first read.
  - A Steam (or other store) game keeps its store's achievements, even with a recompilation of it installed.
  - Once the recompilation is uninstalled, its counts leave the game's card.
  - If your copy cannot be read, the list shows only how many achievements you have unlocked.
  - Until you unlock the first one, the list says to play the game once. Achievements appear after an unlock.
  - The counts are read when you open the game's page and when you stop playing. PlayOut never checks them in the
    background, and it does not show unlocks while you play.
  - Only Xbox 360 recompilations for which the recompilation catalog gives the game's title id or user data folder
    have this. A game whose recompilation does not have it shows what it showed before (RetroAchievements, where the
    console has them).
- **Where they go:** `<PlayOut folder>\Recompilations\<name>\` (next to PlayOut.exe), or
  `%APPDATA%\PlayOut\Recompilations\` when PlayOut is in Program Files or its folder cannot be written. Settings →
  Recompilations shows the folder.

### 4.6 VR mods: play flat PC games in VR

**Settings → VR** (directly beneath Recompilations) lists the VR mods for PC games that the Flat2VR community's
release list tracks: new mods, updates and alpha builds, tools (such as UEVR) and game profiles. PlayOut only
downloads and keeps them; it never runs a mod, an installer or a setup program, and it does not link mods to the
games in your library yet. Follow each mod's own instructions to use it.

- **Browse** opens the **VR mod browser**: search by game, mod, author or tag; the filters **All**, **New mods**,
  **Updates & alphas**, **Tools**, **Profiles**, **Quest standalone** and **Downloaded** (each with its count); and
  **Sort by** newest, oldest or name. Pick a mod to see its summary, highlights, tags, author, date and status, and its
  links: **Project page** (the list's "Project / download" link), **Video**, **Reddit** and the **Source thread**
  where the list found it. The right stick scrolls the mod's details.
- **GitHub mods** have **Download** (the newest release with a file PlayOut can keep; a mod with only pre-releases
  gets its newest pre-release), **Show releases** (each release with its notes and a button to download that one)
  and **Show README**. Releases and READMEs are only asked of GitHub when you open them. A downloaded mod shows
  **Open folder**, **Remove** and, once **Check for updates** found a newer release, **Update to vX**.
- **Mods elsewhere** (Nexus Mods, itch.io, Discord, ModDB, …) have **Open page** only. A Quest standalone build
  (.apk) is installed on the headset, not on this PC, so it has no download here either.
- **What is downloaded:** a .zip or .7z is unpacked into the mod's folder; any other file (a program, a .dll, a .pak,
  a .uevrz UEVR profile) is saved as it is. Downloads are checked against GitHub's published checksum when there is
  one; without one, the mod is marked as not verified. RAR and tar archives cannot be unpacked: open the mod's page.
- **Updates and removal:** **Check for updates** (Settings → VR) asks GitHub for each downloaded mod's newest release.
  Before an update or a removal, the files you added or changed in a mod's folder are zipped into
  `<VR Mods folder>\.playout\backups\`.
- **Where they go:** `VR Mods\<mod (id)>\` next to the Recompilations folder (section 4.5), so
  `<PlayOut folder>\VR Mods\` or `%APPDATA%\PlayOut\VR Mods\`. Settings → VR shows the folder (**Open**).

## 5. Emulators

### 5.1 How PlayOut finds them

For every system the launch command names an emulator (`RETROARCH`, `DOLPHIN`, `PCSX2`, ...) and, for
RetroArch, a core. The executable is resolved at launch time, in this order:

1. **Your override** from Settings → Emulators (Browse to the exe).
2. The executable's **App Paths** registry entry (installers such as RetroArch's register it).
3. The executable on the **`PATH`**.
4. **Well-known locations.** RetroArch is looked for in `C:\RetroArch-Win64\`, `C:\RetroArch\`,
   `%APPDATA%\RetroArch\`, `C:\Program Files\RetroArch-Win64\`, `C:\Program Files\RetroArch\`, their
   `Program Files (x86)` variants and Steam's `steamapps\common\RetroArch\`; mGBA, PPSSPP and ScummVM through
   their installers' uninstall entries and `Program Files` folders.
5. **PlayOut's emulator folders**: `Emulators\<name>\` next to `PlayOut.exe` and `%APPDATA%\PlayOut\Emulators\<name>\`.
   The subfolder and executable names follow ES-DE, e.g. `Emulators\RetroArch-Win64\retroarch.exe`,
   `Emulators\Dolphin-x64\Dolphin.exe`, `Emulators\PCSX2-Qt\pcsx2-qt.exe`,
   `Emulators\duckstation\duckstation-qt-x64-ReleaseLTCG.exe`, `Emulators\PPSSPP\PPSSPPWindows64.exe`,
   `Emulators\cemu\Cemu.exe`, `Emulators\ryujinx\Ryujinx.exe`, `Emulators\RPCS3\rpcs3.exe`,
   `Emulators\xemu\xemu.exe`, `Emulators\xenia\xenia.exe`, `Emulators\mame\mame.exe`,
   `Emulators\flycast\flycast.exe`, `Emulators\mGBA\mGBA.exe`, `Emulators\melonDS\melonDS.exe`,
   `Emulators\azahar\azahar.exe`, `Emulators\snes9x\snes9x-x64.exe`, `Emulators\Mesen\Mesen.exe`,
   `Emulators\dosbox-staging\dosbox.exe`, `Emulators\scummvm\scummvm.exe` (the complete list is in
   `resources/systems/find-rules.json`).

Settings → Emulators lists every emulator the systems refer to with the path that was resolved (and whether
it came from a rule or your override) or _not found_ together with the folders that were searched.

**Update all emulators.** Settings → Emulators → PlayOut emulators → **Update all** brings every emulator PlayOut
installed to its newest nightly build: DuckStation (preview), PCSX2 (nightly), RPCS3 (newest build), Dolphin (dev),
PPSSPP (dev), Flycast (dev), Azahar (newest pre-release), melonDS (nightly), mGBA (dev), Ryujinx (canary), ScummVM
(daily) and RetroArch (nightly, with its cores). MAME publishes no nightlies, so it gets its newest release; Model 2
has no newer builds. Each build comes from the same server the emulator's own updater uses, where it has one.

- Only the program files are replaced: settings, saves, memory cards and the links into your Emulation folder stay,
  and so do the settings PlayOut set up. Your preconfigured RPCS3 keeps its settings, firmware and patches.
- An emulator that is open is left alone; close it and press Update all again.
- An emulator already on the newest build downloads nothing. If a download or an update fails, the installed build
  stays exactly as it was.
- Under the button, each emulator shows what happened (for example "Updated from 2609b to 2609-289 (dev)"). Nightly
  builds are less tested than releases.

### 5.2 RetroArch cores

Most systems default to a RetroArch core. Cores are DLLs in `<RetroArch>\cores\`, for example:

| System                          | Default core        | File                            |
| ------------------------------- | ------------------- | ------------------------------- |
| nes                             | Mesen               | `mesen_libretro.dll`            |
| snes                            | Snes9x - Current    | `snes9x_libretro.dll`           |
| gb / gbc                        | Gambatte            | `gambatte_libretro.dll`         |
| nds                             | melonDS DS          | `melondsds_libretro.dll`        |
| n64                             | Mupen64Plus-Next    | `mupen64plus_next_libretro.dll` |
| mastersystem / genesis / segacd | Genesis Plus GX     | `genesis_plus_gx_libretro.dll`  |
| saturn                          | Beetle Saturn       | `mednafen_saturn_libretro.dll`  |
| dreamcast                       | Flycast             | `flycast_libretro.dll`          |
| pcengine                        | Beetle PCE          | `mednafen_pce_libretro.dll`     |
| neogeo                          | FinalBurn Neo       | `fbneo_libretro.dll`            |
| arcade                          | MAME - Current      | `mame_libretro.dll`             |
| atari2600                       | Stella              | `stella_libretro.dll`           |
| c64                             | VICE x64sc Accurate | `vice_x64sc_libretro.dll`       |
| amiga                           | PUAE                | `puae_libretro.dll`             |
| dos                             | DOSBox-Pure         | `dosbox_pure_libretro.dll`      |
| scummvm                         | ScummVM             | `scummvm_libretro.dll`          |

Install them in RetroArch: **Main Menu → Online Updater → Core Downloader**. PlayOut looks for cores in the
`cores` folder next to the resolved `retroarch.exe`; if yours are elsewhere set Settings → Emulators →
**Cores directory**.

These systems default to a standalone emulator instead, the ones PlayOut installs and sets up:

| System   | Default emulator         |
| -------- | ------------------------ |
| psx      | DuckStation (Standalone) |
| ps2      | PCSX2 (Standalone)       |
| ps3      | RPCS3 (Standalone)       |
| psp      | PPSSPP (Standalone)      |
| gba      | mGBA (Standalone)        |
| gc / wii | Dolphin (Standalone)     |
| n3ds     | Azahar (Standalone)      |
| switch   | Ryujinx (Standalone)     |

Wii U (Cemu) and Vita (Vita3K) have no RetroArch default either and use their standalone emulator. A choice you
made in Settings → Emulators, for one game, or in ES-DE still wins over these defaults. DuckStation, Dolphin,
Azahar and PPSSPP cannot open `.zip` or `.7z` files, so a zipped PS1, GameCube, Wii, 3DS or PSP game starts with
the system's RetroArch core instead (Beetle PSX, Dolphin, Azahar, PPSSPP), which unpacks it; also when you chose
the standalone emulator for the whole system in Settings → Emulators. Choose it for one game to force it.

### 5.3 Choosing another emulator

Each system lists alternatives (other cores, standalone emulators such as DuckStation, PCSX2, Dolphin,
PPSSPP, Snes9x, Mesen, mGBA, melonDS, Flycast, MAME, FinalBurn Neo). Set the preferred one per system in
Settings → Emulators, or per game in the game's Edit sheet (pen) / Play ▾ menu. Alternatives whose emulator was not
found are marked as such.

#### The emulator's own menu: Start + Select

In a game, press **Start + Select** (Menu + View on an Xbox controller) to open the emulator's own controller
menu: pause, save states, settings, and quitting back to PlayOut. PlayOut sets this up by itself:

- **PCSX2, DuckStation:** the Big Picture pause menu. Opened by themselves, both also start in Big Picture.
- **RPCS3:** PlayOut installs your own preconfigured RPCS3 (from its Google Drive folder) and keeps its settings
  as they are, so the buttons and Big Picture are whatever that copy has.
- **PPSSPP:** the pause screen; its last button is **Exit**.
- **RetroArch:** the Quick Menu; _Close Content_ quits back to PlayOut.
- **Flycast** (Select) and **ScummVM** (Start) open their menus already.
- Dolphin, Azahar, melonDS, mGBA, Ryujinx and Model 2 have no such menu: use the home button's overlay
  (section 4.4) to quit.

The Guide (home) button is left to PlayOut's overlay. A button or setting you changed yourself in an emulator
is kept. Winhanced also uses View + Menu, to open Xbox Game Bar; with PlayOut's _Turn off Xbox Game Bar_ on
(section 4.4) nothing else opens.

### 5.4 RetroAchievements

PlayOut shows your [RetroAchievements](https://retroachievements.org) progress for ROM games: the
**RetroAchievements x/y** stat in the game panel, and the full list (with points and hardcore unlocks) when you
press it.

1. Sign in at https://retroachievements.org, open your account **Settings** page (the **Get Web API key** button
   in PlayOut opens it) and copy your **Web API key**.
2. In Settings → Emulators → **RetroAchievements**, enter your username and the key. PlayOut checks them as soon
   as you stop typing and shows a notification; the account row then says _Signed in as …_ with your points and
   how many ROMs it recognised.
3. Achievements are earned by the emulator, not by PlayOut: sign in to RetroAchievements in RetroArch too
   (**Settings → Achievements**), or in the standalone emulator you use.

PlayOut recognises a ROM by the same fingerprint RetroArch uses (cartridge systems, zip files included). Disc
images (PlayStation, Saturn, Sega CD, Dreamcast …) are matched by their title, so keep their file names close to
the game's name. **Sync now** refreshes the counts (they also refresh at every start and after a ROM scan);
**Sign out** clears the key and the counts.

## 6. Artwork and metadata

PlayOut fetches art and metadata in the background after every scan (Settings → Metadata → _Auto-scrape_)
and shows progress in the system pill. Each game gets: cover (2:3), hero (wide background), logo, icon,
screenshots, description, release date, developers, publishers, genres, rating, players, and - where
available - HowLongToBeat times, achievements and the live player count.

### 6.1 Sources and credentials

Everything works without credentials, with less art: Steam art comes from Steam's own cache and store
(keyless), GOG data from GOG, HowLongToBeat needs nothing, ES-DE import brings whatever you already scraped.
**Cover art.** Covers come first, and most of them never leave this PC: right after a scan or a store import
PlayOut reuses the covers the store clients already downloaded - Steam's library cache (which holds art for the
games you own or have looked at, not only the installed ones), GOG Galaxy's web cache for every store connected
to it, Epic's catalogue cache, and ES-DE or Playnite media when those are installed. The switch is
Settings → Metadata → _Use art from installed store clients_ (on by default). What is not on this PC is fetched
by its store id straight from the stores' image servers (Steam, GOG, Epic, Xbox), with no search involved, and
only then from SteamGridDB (needs a key). Expect the locally cached covers of thousands of owned games within a
few seconds of the import (on a PC with a 9,800-game Steam cache: 5,200 covers in about 5 s), the store-server
ones over the next minutes, while descriptions, heroes, logos and the other details keep arriving in the
background (the "fetching covers … left" / "fetching details … left" note next to the game count in My Games).
A bar along the bottom of the screen follows the art: "Downloading cover art · 1,200 of 3,104" while the covers
come in, then "Downloading game art · 12 of 3,104" while each game's hero, logo, icon and screenshots are fetched;
it goes away when every game has been looked at.

**Covers without a key.** For a game that neither a store client nor a store server has art for (most ROMs, games
added by their .exe), only the services that search by name or file need a sign-in: **SteamGridDB** (API key),
**ScreenScraper** (developer ID and password), **IGDB** (client ID and secret) or **TheGamesDB** (API key). With none
of them set up, such a game keeps its placeholder, and the placeholder says so: _Sign in for covers · Settings ›
Metadata_ in its top corner (the game's title stays readable below it). The note is not shown once any of those
services is set up (a cover that is still missing then just shows the placeholder), nor on games from another PC.
As soon as you save a key or login for one of those services that was not set up before (also when another one
already is), PlayOut looks for the missing art of your library on its own, a few seconds after you stop typing,
exactly as _Refresh missing_ does (below).

Keys unlock the rest. Enter them in **Settings → Metadata**; they are stored in `settings.json` and sent
only to the service they belong to. Each service there has a link beside its name (_Get API key_, _Get client ID_,
_Create account_, _Get Web API key_) that opens the page issuing its key in your browser.

A key is checked with its service as soon as you type or paste it (once the fields that belong together, such as
IGDB's client ID and secret, are all filled in), and a notification says whether it works. "Couldn't check right
now" means the service did not answer (offline, busy, rate limited); the key was not judged. Checking a TheGamesDB
key uses one request of its monthly allowance. ScreenScraper needs the developer ID and password; your user name
and password are checked together with them.

**SteamGridDB** (covers, heroes, logos, icons for all platforms)

1. Go to https://www.steamgriddb.com/ and sign in with your Steam account.
2. Open your profile → **Preferences** → **API** and generate an API key.
3. Paste it into Settings → Metadata → SteamGridDB → API key.

**IGDB** (descriptions, dates, companies, genres, ratings, covers, screenshots, time to beat; via Twitch)

1. You need a Twitch account with two-factor authentication enabled.
2. Open https://dev.twitch.tv/console/apps and choose **Register Your Application**: any name, OAuth
   redirect URL `http://localhost`, category _Application Integration_.
3. Copy the **Client ID**, then **New Secret** to create the **Client Secret**.
4. Paste both into Settings → Metadata → IGDB. PlayOut obtains and renews the access token by itself.
   IGDB is free for non-commercial use.

**ScreenScraper** (ROM metadata and art matched by file hash: boxes, wheels / logos, screenshots, fan art)

1. Create a user account at https://www.screenscraper.fr/ (registration page: _membreinscription.php_).
   The account sets your daily quota and thread count; paste the user name and password into Settings →
   Metadata → ScreenScraper.
2. ScreenScraper also requires _developer_ credentials that it issues per application through its forum.
   PlayOut does not ship its own yet: request a developer id and password for your installation on the
   forum and enter them in the _Developer id_ / _Developer password_ fields. With the developer fields empty
   PlayOut skips ScreenScraper.
3. Settings → Metadata → _Region_ (`us`, `eu`, `jp`, `wor`) chooses which regional box art is preferred.

**TheGamesDB** (box art, fan art, clear logos, screenshots, overviews)

1. Register / log in at https://thegamesdb.net/.
2. Open https://api.thegamesdb.net/key.php and copy your API key (public keys have a monthly allowance;
   PlayOut caches aggressively to stay inside it).
3. Paste it into Settings → Metadata → TheGamesDB.

**Steam achievements** (your unlocked achievements for Steam games)

Signing in to Steam in the Library's **Settings** tab (section 3.4) is enough: PlayOut fills the achievement
counts of your Steam games in the background, a few requests a second, starting a minute after PlayOut opens. A Web
API key is optional; it adds unlock dates to every list. Either way, Steam only shares achievements when your
profile's **Game details** are public (step 3).

- Each Steam game is read once when it joins your library (the first import of a whole Steam library included),
  then again only after you play it: a play session started from PlayOut, a session played on a paired PC reaching
  this one, or Steam's last played time or play time moving on. Games you do not play are not asked about again.
  Play through Steam itself, outside PlayOut, is noticed the next time PlayOut imports your Steam library (when it
  scans Steam, or when you sign in).
- Nothing is read while a game is running; the scan goes on when it ends.
- Games waiting while you are signed out are read once you sign in (or add a key). If Steam refuses your sign-in or
  key, the scan stops until you sign in again or change the key. A failed read waits a few minutes, longer after
  each failure in a row (or as long as Steam asks); after five failures in a row a game waits until you play it,
  sign in again or restart PlayOut.
- A game Steam lists no achievements for (Call of Duty: United Offensive, for one) has no **Achievements** stat on
  its page at all. PlayOut takes that only when both Steam's achievement list and the game's Steam store page list
  none. Being signed out, or Steam not answering, is not taken as "no achievements": the stat stays and its list
  says how to sign in. A game Steam later adds achievements to gets them back the next time you play it.
- The record of when each game was read is `%APPDATA%\PlayOut\retroachievements\steam-scans.json`.

1. Key: https://steamcommunity.com/dev/apikey (the account must not be limited; enter any domain name as the
   label).
2. SteamID64: the 17-digit number starting with `7656119` in your profile URL
   (`https://steamcommunity.com/profiles/<SteamID64>`) or shown under **Steam → Settings → Account**. If
   your profile uses a custom URL, open it and use _Edit profile_ → the Steam ID is listed there, or use any
   SteamID lookup site.
3. In Steam → Settings → Privacy, set **Game details** to _Public_ (achievements are not readable otherwise).
4. Paste both into Settings → Metadata → Steam. Play time and the "N playing now" counter need no key. A
   key set here is used before the signed-in account.

**HowLongToBeat**: a toggle in Settings → Metadata; times are shown with a link to the game's page.

**Steam tags** (Settings → Metadata → **Steam tags**, on by default, no account needed): the tags Steam players
give games (_Roguelike_, _Souls-like_, _Great Soundtrack_ ...). They are read in the background for every game:
Steam games by their own store page, games from GOG, Epic and the other stores by the Steam game with exactly the
same title (a game Steam does not sell gets none). A game's page shows its strongest four after the genre (fewer
on narrow screens), and the Library and search overlay find games by them: searching _souls_ lists the
Souls-likes. Tags are read again every three months; a game with none is asked again after a month.

**Review scores** ("Steam 93%" or "IGDB 84" on a game's page): read in the background. Steam's review
summary comes first: a hundred games per request, so a whole library takes seconds. It covers Steam games and the
other stores' games whose Steam version the Steam tags found. A game Steam shows no score for (no Steam version,
or fewer than about ten reviews) gets IGDB's user rating instead, with the IGDB client ID and secret set in
Settings → Metadata → IGDB: found by its Steam app, its IGDB match, or a title search that only accepts the same
name and release year, a few a second. Scores are read again every month; a game with none is asked again after
a month. The bar at the bottom of the screen shows the progress.

### 6.2 Fixing a wrong match

Open the game's Play ▾ menu → **Refresh metadata** or **Search metadata…**: type a title (an
on-screen keyboard appears for gamepad users), pick the right candidate and PlayOut applies it. Clean file
names help the name-based sources (`Chrono Trigger (USA).sfc` is ideal; dumps renamed to `ct.sfc` are not);
ScreenScraper matches ROMs by hash so file names do not matter there.

### 6.2a The PlayOut database

The PlayOut database is a shared, public list of each game's stable facts: its title, platform, release date,
genres, Steam tags, developers, publishers and number of local players (not HowLongToBeat times, install sizes or
review scores, which change over time). It is plain CSV on the `database` branch of the public GitHub repository
`jeremybris/PlayOut-metadata` (<https://github.com/jeremybris/PlayOut-metadata/tree/database>; PlayOut reads the files
from `https://raw.githubusercontent.com/jeremybris/PlayOut-metadata/database/data/...`), so anyone can open it in a
spreadsheet. Rows there are added automatically, while corrections to the repository's `main` branch (the metadata
cloud, see _Editing a game: the pen_) stay approved by the maintainer.

- **Reading.** Before the scrapers run, PlayOut looks each new game up in the database and takes its facts from
  there; the scrapers still bring the description, the art and the links, and fill in the games the database does
  not have yet. A new library gets its facts straight away. A game that is already matched only takes the
  database's facts when you press **Refresh metadata** (then they replace the scraped ones). The parts of the
  database your games need are kept on this PC and checked again every six hours.
- **Contributing.** When a game the database lacks has been matched, PlayOut adds it a few minutes later: its title
  and the facts the scrapers found, sent with an anonymous install id. Nothing personal is sent, and **your own
  edits are never sent** (they still go to the maintainer as suggestions, see _Editing a game: the pen_). Games are
  only ever added: a game the database has is never changed this way, so corrections still go through the Edit
  sheet's suggestions. Games from a paired host, recompilation cards and programs you added yourself are not sent.
- **Settings → Metadata → PlayOut database**: **Use the PlayOut database** (on by default) and **Add missing games to
  the database** (on by default). Turning the first off also stops contributing.

### 6.3 Custom art

The game's Edit sheet (the pen on the game page) offers pickers for the cover, hero and logo. A chosen file is copied into the media cache
(as `custom-<kind>.<ext>`, so an import or refresh that is still downloading art for that game cannot replace or
delete it) and takes precedence over anything scraped; clearing the choice returns to the scraped image.

### 6.4 Art priority and refresh

Settings → Metadata → **Art priority** orders the sources tried for each kind of art (default: SteamGridDB,
Steam, ScreenScraper, TheGamesDB, IGDB, GOG). **Refresh all** re-queues every game; the per-game refresh
accepts _force_ to discard cached results. **Refresh missing** fetches the metadata of every game whose metadata
never finished (none yet, failed, or cut off by closing PlayOut) and fills **all missing art** of the others - cover,
background (hero), logo and icon - without touching what a game has: its text, its HowLongToBeat times, your edits
and the art it already has stay as they are. A notification says how many games it is looking at (_Looking for
missing art for 12 games…_) or _Nothing is missing_; when games were queued but no SteamGridDB / ScreenScraper /
IGDB / TheGamesDB sign-in is set up, a second one says that covers need one. With **Auto-scrape after scans** on, a
game a run left without a cover is looked at again on later starts too, art only, waiting an hour after the first
try and twice as long after each further one (up to a week), and an import cut off by closing PlayOut finishes on
the next start (with it off, such games wait for _Refresh missing_). Games imported before 0.9.82 that have no
cover are looked at on the next start the same way. Signing in to one of these art sources runs _Refresh missing_ by
itself a few seconds after the key is saved; it also does so on the next start when the key was saved before an
update or while PlayOut was closed (PlayOut remembers which sources were set up, never the keys, in
`%APPDATA%\PlayOut\missing-art.json`). Settings → Metadata says at the top when no art source is set up, and under
ScreenScraper when only the user name and password are filled in: covers from ScreenScraper need the developer ID
and password too. When TheGamesDB says its monthly allowance is used up (HTTP 429),
PlayOut stops asking it for an hour. Images are cached in `%APPDATA%\PlayOut\media\<game id>\`.

## 7. Settings reference

Open Settings from the pill above the rows, the Menu (Start) button or `Tab`, or switch to the **Settings** tab of
the Library (the gear and wrench left of _All_), which shows the same menu in place of the games.

- **Tabs**: **Icons for tabs** (on by default; this PC only) makes the tabs at the top of the Library show the
  icons of their filters instead of their names (see _In the library_ below). Then the Library's tabs, left to right
  (named in words here). Each row shows the tab's name and sort, with **‹ ›** to move it
  left or right, its **Sort** and **Filters** pills (the same menus as the Library header) and a bin to delete it
  (the last tab cannot be deleted). **Add tab** adds All on A-Z with playable games first at the end and moves to its Filters pill. **Recommended tabs**
  adds ready-made tabs with one press: _All_ (every store, A-Z, playable games first; it counts as added when a tab with no filters
  exists, whatever its sort); more will follow. With **Sync Library tabs with the host / clients** on (Settings →
  Streaming), the tabs are kept the same on the PCs paired with this one, the newest change winning.
- **Library → Co-Op** (section 4.1): **Download all handlers**, **Two-player split-screen** (top and bottom, or left
  and right) and **Count the keyboard and mouse as a player**.
- **Library**: sources with their status (client found, last scan, count, errors) and an on/off switch
  each; the ROM folder; _Import from ES-DE_ and the ES-DE home folder; _Show hidden_ and _Show games that are
  not installed_ (on by default: owned and previously installed games stay visible, greyed out). Store accounts
  are signed in and out in the Library's **Library Import** (section 3.4).
- **Convert**: changes a game's file format (CHD, CSO, RVZ, XISO, PS3 ISO and more) one platform and direction at a
  time, with each file's progress. At the top, under **New games**, two switches for games new to this PC:
  - **Trim Games** (off by default): ROM games are converted to their smaller format by themselves. When you turn it
    on, the ROM games already in your library are checked once (only at that switch, not at every start; turning it
    off and on again checks them again); after that, each ROM game added to the library is trimmed: PS2 ISO to CHD, Xbox and Xbox 360 ISO to XISO (trimmed: the video partition and padding are removed;
    images that are already trimmed XISOs are left alone),
    PlayStation BIN/CUE to CHD (each disc of a multi-disc .m3u; a .bin without its .cue is skipped), PSP ISO to CSO,
    PS3 disc games (a folder holding PS3_GAME) to ISO (HDD and PSN games, and anything in Updates and DLC, stay as
    they are), Wii and GameCube ISO to RVZ. The result of any Convert run (yours too, such as an RVZ turned back into an ISO) is
    never trimmed back. It uses the same runs as
    **Convert**: one at a time (it waits for a Convert run you started, a running game and a ROM download from another
    PC), each original goes to the Recycle Bin only once its result is verified, and the game keeps its play time
    and art. A toast says when it starts; **Convert** shows the progress. Files are converted once they have stopped
    changing for two minutes and no other program has one open (a game still being copied in waits). Wii games need your Wii common key (in the
    Emulation folder's bios\wii) or Dolphin installed, as Convert does; without either they are skipped with a
    toast. Games downloaded from another PC keep their format, so both PCs still see one game.
  - **Compress games automatically** (off by default; right under Trim Games): each PC game (a store game or one you
    added) is compressed a few minutes after it has finished installing, with the game page's **Upgrade → Compress
    game** (Windows' own compression, XPRESS8K): the game takes less space on the drive and can take a little longer
    to load. Only games installed from then on, while PlayOut is open: the games already installed when you turn it on,
    and games installed while PlayOut was closed, are left as they are (compress them from their Upgrade menu). An
    install counts when PlayOut's install tracking ends, when a game goes from not installed to installed in a store
    PlayOut has already scanned since it started (installed straight in its store, with a new install folder), or when
    a later scan finds a new installed game whose folder was made since (old games on a drive you plug in later do not
    count). One game at a time; it waits (up to a day, looking again every minute) while a game is running, while the
    store is still downloading or updating it, until the game's files have stopped changing for a few minutes, while
    the Emulation folder moves, and while a Convert run or another upgrade runs. Starting a game from PlayOut, or Steam
    starting to update the game, stops a running automatic compress; it goes on later. Games started outside PlayOut
    are not noticed. Pressing Play on the game while it is compressed says so; stop it with **Stop** in its Upgrade
    menu. It skips what Compress game would refuse (a game of another PC, a drive that cannot compress), games already
    compressed or partly so, and games with anti-cheat (online or competitive games: the Upgrade menu warns of a ban
    risk first, so compress those yourself). ROM games are never compressed: Trim Games is theirs, and Trim Games
    waits while a compress runs. The progress shows in the game's Upgrade menu and a toast says when it is done or
    failed. After a game update, **Compress again** in its Upgrade menu compresses the new files as before (not done
    automatically).
  - **Xbox and Xbox 360** conversions are done by PlayOut itself (its Xbox helper, built on XISOSharp and CHDSharp,
    the engine of XISO Studio), with nothing to download: full dump (ISO) to trimmed XISO, for Xbox and for Xbox 360
    (for Xenia and modded consoles; the video partition and padding are removed), ISO ↔ game folder, ISO ↔ CHD, and
    for Xbox 360 ISO ↔ ZAR and game folder ↔ ZAR. Every result is checked file by file (size and SHA-256) against the
    original before the original goes to the Recycle Bin; a stopped or failed conversion leaves nothing behind. A CHD
    holds the trimmed game, as XISO Studio makes it, so a full dump comes back from it as an XISO. File names Windows
    cannot hold (such as `aux` or `con`) are renamed with an underscore when a game is extracted to a folder; the
    image is then kept (the folder is not an exact copy of it). Game files are copied as they are (`.xbe` files are
    not patched). Closing PlayOut stops a conversion and removes what it had written; anything left by a crash is
    removed the next time PlayOut starts.
  - **PlayStation 5 → PKG → Game Folder** unpacks a PS5 package into a decrypted game folder next to it (named after
    the package; the package is kept), with PlayOut's PS5 package helper, built on PS5PKGTool's own extraction: the
    folder holds the game's files and its `sce_sys` (`param.json`, artwork, trophies), as PS5PKGTool's Extract writes
    it. Only **fake packages (FPKG)** can be unpacked: retail packages are locked with Sony's keys and are refused,
    and update (patch) packages are refused too (they need their game). Reading a large package takes a while before
    the progress moves, and uses memory about the size of the package plus the unpacked game. **Stop** ends it and
    removes what was written.
  - **Cartridge ROMs** (Game Format Converter 2.1.1 or newer; an older converter PlayOut downloaded is updated at the
    next conversion): Nintendo 64 Z64 ↔ V64 and Z64 ↔ N64 (byte order), Super Nintendo SMC ↔ SFC and PC Engine
    with or without the 512-byte copier header, Mega Drive / Genesis SMD ↔ MD, and Nintendo DS full size ↔ trimmed.
    Only the byte order, the header, the layout or the padding changes; the game itself is unchanged, and the result
    is read back against the original before the original goes to the Recycle Bin. A ROM already in the chosen form
    is refused with the converter's reason. Where the result keeps the extension (DS, PC Engine), it takes the
    original's name once the original is in the Recycle Bin.
  - **Xbox 360 → Games on Demand → ISO**: pick the folder of a Games on Demand package (its title-id folder or the
    folder holding the package and its `.data` folder); each package in it (one per disc) becomes a disc image for
    Xenia, named after the game, next to that folder. Nothing is decrypted, and the package is kept.
- **Emulators**: every emulator with its resolved path or _not found_ and a Browse button; the RetroArch
  cores directory; **Update PS3 games automatically** (section 3.2, PS3 game updates); the preferred emulator per system.
- **Recompilations** (section 4.5): the catalogs (**Refresh**), the recompilation browser (**Browse**), **Check for
  updates** and **Update all**, each
  installed recompilation (update, **Change version** / **Back to latest**, **Update automatically**, the version a game uses, save folders, the save copy in
  the Emulation folder, uninstall) and where the save copies live.
- **VR** (section 4.6): the VR mod browser (**Browse**), where VR mods are downloaded (**Open**), **Check for updates**
  and each downloaded mod (**Update to vX**, **Open folder**, **Remove**).
- **Streaming** (section 4.3): this PC as host (**Let other PlayOut computers connect**, Sunshine, port forwarding,
  **Pair a computer**, paired computers); connecting to a host (**Find computers on this network**, **Enter address**,
  paired hosts, Moonlight); stream quality (resolution, frame rate, bitrate); **Show games from paired computers**.
- **Metadata**: credentials for SteamGridDB, IGDB, ScreenScraper, TheGamesDB and Steam; HowLongToBeat
  and Steam tags on/off; auto-scrape after scans; region; **PlayOut database** (use it; add missing games to it:
  section 6.2a); art priority; _Refresh missing_ (unfinished metadata and all missing art, section 6.4); _Refresh
  all_; **Cloud metadata** (below).
- **Metadata → Cloud metadata** (the PlayOut metadata cloud, section 4):
  - **PlayOut cloud**: when corrections were last checked, how many games the cloud corrects and how many of them
    are in your library; **Check now** downloads them at once. A failed check is shown and retried (sooner at
    first, then every 6 hours); the last copy keeps showing meanwhile.
  - **Suggest my edits** (on by default; not shown to the maintainer): send your saved edits to the maintainer as
    suggestions. Off keeps every edit on this PC. The line under it says what happens to your edits, how many
    are waiting and, while one of the suggestion service's limits (such as 30 per hour from one PC) holds them,
    which limit and when the next ones go. Recompilations you add in the recompilation browser (section 4.5) are
    suggested the same way (at most 5 an hour from one PC).
  - **Suggestion relay URL**: the suggestion service (a small Cloudflare Worker the maintainer runs). Leave it empty
    to use the one the repository announces; type one (`https://…`) and **Save** to use your own. The maintainer
    also gets **Share with every PlayOut**, which writes the URL into the repository so every PlayOut picks it up.
  - There is no token field: every PC suggests its edits, and the maintainer reviews them as pull requests on GitHub.
    A PC that saved an owner token in an earlier PlayOut keeps using it (it publishes, and lists the suggestions
    below).
  - **Suggestions (N)** (only on a PC with an owner token saved earlier): the open suggestions, each with its game and every field's cloud
    value → suggested value. **Approve** merges it (every PlayOut gets it with its next check; it shows here at
    once), **Reject** closes it, **GitHub** opens it in your browser. **Refresh** reloads the list. A suggestion
    that conflicts with a newer change, or touches other files, must be handled on GitHub.
- **Appearance**: start in full screen; 24-hour clock; number of games in the Recent row (4-40); animations;
  minimise while playing.
- **Controls**: stick deadzone (0-0.9); vibration; swap A/B; repeat delay and repeat rate when holding a
  direction; **In-game overlay** (on by default: the overlay is drawn inside exclusive full-screen games so they do
  not minimize, never for games with anti-cheat), with the games it is not used for.
- **System**: _Language_ (PlayOut's menus and messages, applied at once; game names and details are not
  translated; section 1); launch at login; confirm power actions (sleep, restart, shut down); _Enhanced
  Sleep/Wake_ (on by default):
  - The game you're playing is frozen while the PC sleeps or the screen is locked, and carries on when you're back
    and unlocked. Games protected by anti-cheat are left alone.
  - Sleep pauses everything: the PC goes offline while asleep, so apps, mail, sync and updates stop running in the
    background. Wake timers, scheduled maintenance, network adapters and fingerprint readers no longer wake it.
    Keyboards, mice, controllers, the power button and the lid still do.
  - A sleeping PC hibernates after 48 hours, so the battery isn't drained. Hibernation is switched on for this if it
    is off and the disk has room.
  - These Windows changes need administrator rights once (a Windows prompt on PCs that ask). Turning the option off
    undoes exactly what PlayOut changed.
- **System**: _Wake with the Xbox button_ (off by default; from SoCal IT's Windows11-Xbox-Controller-Wake, MIT):
  - Pressing the Xbox button on an Xbox controller wakes the sleeping PC. The controller needs the Xbox Wireless
    Adapter or a USB cable (Bluetooth usually cannot wake a PC), and the PC's sleep must let USB devices wake it
    (classic S3 sleep, set in the BIOS on many desktops).
  - Turning it on lets every Xbox device Windows can wake the PC with do so (one administrator prompt). A device
    plugged in later, or one a driver update reset, is set up at the next start. Turning it off undoes only what
    PlayOut changed; a device you allowed yourself in Device Manager stays allowed. The line under the switch says
    which devices wake the PC, or why none can.
- **System › Memory**: _Free up memory while PlayOut is running_ (off by default) and the **Free memory now** button.
  - **What it does:** it asks Windows to take back memory that background apps hold but are not using right now, so
    there is more for your game. It runs once shortly after a game starts, and again only when available memory gets
    low (under about 15 % of the PC's memory, at least 2 GB and at most 4 GB). It never runs on a timer, and it
    waits at least 3 minutes between two runs (10 minutes when the last one freed almost nothing). When memory stays
    low all the same, your game simply needs it: the runs then get rarer (10, then 30 minutes apart) until memory
    has recovered for a while. **Free memory now** runs it once at your request, also with the switch off, and
    shows the result ("Freed 1.8 GB in 5 s · 2 minutes ago"; the time is left out when the cleanup took under a
    second). How long each step took is in `logs\main.log`.
  - **When in doubt it does nothing.** If PlayOut cannot tell which window is in front (also when that program was
    started only a moment ago), or which programs belong to the running game, nothing is trimmed; the button then
    says so. A press that could do nothing does not count as a run.
  - **It is temporary.** Nothing is closed, stopped or switched off. An app you go back to loads its memory again,
    so it can be slow for a moment, and Windows fills its cache again by itself. A bigger "available" number does
    not make a game faster on its own; it helps when memory was actually running short.
  - **What it never touches:** PlayOut itself; the game you are playing, everything in its folder, and Steam or the
    other store apps while a game runs; emulators; the app in front of you (and, while a Microsoft Store app is in
    front, every Store app); anything started in the last moments; Windows' own programs (File Explorer
    only while your game is in front); Microsoft Defender and other security software; anti-cheat services; Sunshine
    and Moonlight.
  - **What it never does:** it does not stop or disable Windows services, remove apps, end or freeze programs, or
    change Windows Update, Defender, the firewall, the pagefile, memory compression, startup apps or the registry.
  - **Two levels.** On every PC, without administrator rights, PlayOut trims your own apps. With the **power helper**
    installed (the Power helper row above; PCs it is offered on), the cleanup is system-wide: it also covers apps
    of other accounts and third-party background services, writes out memory waiting to be saved, drops the
    low-priority part of Windows' cache and merges identical memory pages. Windows already counts its cache as
    available memory, so dropping it does not make the "available" number bigger; the whole cache is therefore
    dropped only when very little memory is completely free although the cache is large, never right after a game
    starts, and at most once while memory stays low. A helper installed by an older PlayOut needs
    the newer one first (**Update**, or **Install** when _Set watts_ is off, in the Power helper row); a helper
    that does not answer needs **Remove** and **Install**. Until then the first level runs alone and Settings says
    so.
- Games hidden in the Steam client are hidden here too. PlayOut reads Steam's list when it opens and after each
  Steam scan. If you show one of those games again in PlayOut, it stays shown unless Steam hides it afresh.
- GOG games hidden in GOG Galaxy, or in your library on gog.com, are hidden here too, the same way. Galaxy's list is
  read when PlayOut opens and after each GOG scan or import; the gog.com flag arrives with the owned-games import
  when you are signed in to GOG in PlayOut (games hidden on gog.com are imported, hidden, instead of left out).
  **Filters → Hidden** in the Library lists every hidden game; **Filters → Genre** picks genres.
- **About**: **Donate** (Ko-fi) and **Join** (the PlayOut Discord server), version, updates, data folder, licences and attributions. **Check for Updates** looks for a new
  release; if there is one the button becomes **Download update**, a bar shows the download, and **Restart to
  install** closes PlayOut, installs the update and reopens. Close a running game first. The portable build
  opens the release page instead, where you download the new exe yourself.

## 8. Controls

One focus engine serves every input method. Hovering with the mouse focuses, clicking activates; touch taps
focus and activate; rows are real scroll containers, so dragging, swiping and the mouse wheel all scroll
them and the focused card is always scrolled into view. Button hints at the bottom of every screen show what
the main buttons do there.

**Keyboard**

| Key                 | Action                          |
| ------------------- | ------------------------------- |
| Arrow keys          | Move focus                      |
| Enter               | Activate                        |
| Esc / Backspace     | Back / close                    |
| F                   | Favourite the focused game      |
| Menu key            | Options of the focused game     |
| Tab                 | Cycle sections                  |
| / or F1 or Ctrl+F   | Search                          |
| Ctrl+Up / Ctrl+Down | Previous / next library section |
| PageUp / PageDown   | Library sort / filters menu     |
| F11                 | Toggle full screen              |
| Alt+F4              | Quit PlayOut                    |

**Gamepad** (standard mapping; Xbox names, swap A/B in Settings → Controls for Nintendo layouts)

| Control               | Action                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-pad / left stick    | Move focus; hold to repeat (timing in Settings → Controls)                                                                                              |
| D-pad up / down       | In the library grid: jump to the previous / next section of the sort (letter, day, playtime band); on the first or last section it moves focus as usual |
| A                     | Activate                                                                                                                                                |
| B                     | Back                                                                                                                                                    |
| X                     | Favourite the focused game                                                                                                                              |
| Y                     | Options of the focused cover (Show in Folder, Mark as Completed, Preferred Copy); detail panel: Play menu                                               |
| LB / RB               | Previous / next row on Home, previous / next section in Settings, previous / next game in the detail panel                                              |
| LT / RT               | Library: open the Sort / Filters menu                                                                                                                   |
| Menu (Start)          | Settings                                                                                                                                                |
| View (Back)           | Search                                                                                                                                                  |
| Right stick up / down | Home / Library                                                                                                                                          |
| Right stick L / R     | Library: scroll the tabs when they do not all fit                                                                                                       |

The controller rumbles briefly on activation when _Vibration_ is on and the controller supports it.

**In the library**

- **Tabs.** Each tab is a set of filters and a sort, and is named by its filters: every choice, the choices of one
  filter joined by "+" and the filters by "·" (_Epic · RPG · 2020-2025_, _Epic + G.O.G_); a tab with no filter is
  _All_. Change a tab's filters or sort and its name follows. With Settings → Library → **Icons for tabs** on (the
  default), a tab shows its choices as the icons the Filters menu draws for them (a store's badge, a console's
  picture, a genre's icon, a size pie, a stopwatch, a star, a custom filter's icon, the heart of Favorites...) instead
  of its name: the choices of one filter close together, the filters a little further apart, at most five icons,
  then "+N". A choice without an icon (a developer, a publisher, _All Stores_, a system or genre without a picture)
  keeps its words, with a "+" or "·" beside it as in the name. _All_, and a tab none of whose choices has an icon,
  keep their names, and pointing at a tab shows its full name. Turn it off for names everywhere. Every tab keeps its own filters, sort, search
  and the card you were on, and PlayOut reopens on the tab you used last, all between sessions. The **+** after the
  last tab adds a tab (All on A-Z, playable games first); the **X** right of the Filters pill deletes the tab shown, after a
  _Delete Tab_ prompt (**Yes** / **No**; not the last tab). When the tabs do not all fit across the top, a scroll bar
  shows under them (its pill, in PlayOut's accent colour, is shorter the more tabs are out of sight): drag the tabs
  with the mouse or a finger, drag the pill, press the bar beside it, use the mouse wheel over the tabs or push the
  right stick left / right; LB / RB bring the new tab into view. When they all fit, there is no bar. Settings → Tabs reorders, edits, deletes and adds tabs. On the first start of this version your
  old tabs become filter tabs: _All_ with no filter, each store's tab with that store picked under Filters → Platform (above the line), each
  system's with Filters → Platform on it, and _Other_ with the stores and systems it held (as two tabs when it held
  both); all on A-Z with playable games first. On paired PCs the tabs stay the same on each (Settings →
  Streaming → **Sync Library tabs with the host / clients**); each tab's search stays per PC.

- A game you have more than once (in several PC stores, and as a PS3, PS2, GameCube, Xbox 360 or Xbox ROM) is one
  cover. The badge at the bottom right shows which copy it is, with the number of copies above it. PlayOut shows,
  in this order: a copy with a recompilation (an installed one first), then Steam, GOG, Epic, PS3, PS2, GameCube,
  Xbox 360, Xbox, then the other PC stores (the Xbox app, EA, Ubisoft, Battle.net, manual games); **Y → Preferred
  Copy** picks another. ROMs of every other system (GBA, GBC, Wii, ...) always have a cover of their own, and so
  does a copy you made a favourite: **X** marks only the copy the cover shows, which then leaves the group (marking it
  again puts it back). Copies are
  matched by title, never two from the same store or system, and two PC store copies not when their release years are
  known and more than a year apart (a console original and a later PC port still match). While you search, or with **Filters → Platform** on, every copy shows as its own cover.
  Settings → Library → **Show duplicates** (off by default) shows every console copy as its own cover again: then only
  copies from PC stores share one (Steam, then GOG, Epic, Xbox, then the other stores), as before 0.1.125.
- A glow around the cover marks a favourite (**X**); **Filters → Favorites** lists only those. On paired PCs the
  favourites stay the same on each (Settings → Streaming → **Sync favourites with the host / clients**), and a
  host's game shown here can be a favourite too (it is one on the host).
- **Filters → Local Multiplayer** (its left arrow opens the list) keeps games played together on one PC. A game
  matching any of the choices picked shows:
  - **All Local Multiplayer**: every game Steam tags _4 Player Local_, _Co-op Campaign_, _Local Co-Op_, _Local
    Multiplayer_ or _Split Screen_, and every Nucleus Co-Op game.
  - **Party Games**: All Local Multiplayer games that take 0-3 or 3-10 hours to beat (How Long To Beat).
  - **S.O. Games** (significant other games): All Local Multiplayer games that take 10 hours or more to beat (10-20,
    20-50, 50-100 and 100+ hours). A game without a How Long To Beat time is in neither.
  - **L.A.N. Party**: every game the game page offers the **PeerParty** square for (LAN play, section 4.2). The
    first time it is picked, PlayOut checks the folders of the installed games it has not checked before, one at a
    time in the background ("Checking your games for PeerParty…"), and the games appear as they are found.
  - The player counts, drawn as a controller with the number above it: **2**, **3-4** and **5+** players (each
    game is under exactly one; tabs saved with the old 2-4 and 4+ choices now use 3-4 and 5+). The count is the one the game page's players badge shows (LaunchBox's), or
    the Nucleus Co-Op handler's players when it has more or LaunchBox has none.
  - **Nucleus Co-Op** (at the bottom; it used to be its own row): only the games you can play split-screen in Co-Op
    (section 4.1). A tab with it on is named _Co-Op_.
- **Filters → Online Multiplayer** (its left arrow opens the list) keeps games played online, by their Steam tags (a
  game matching any of the choices picked shows; games without Steam tags, none read yet or no Steam version found,
  are left out while a choice is picked):
  - **All Online Multiplayer**: everything below, plus games tagged _Team-Based_ or _MMO_.
  - **Cooperative**: games tagged _Online Co-Op_.
  - **Competitive**: games tagged _Competitive_, _eSports_ or _PvP_.
- **Filters → Recompilations** lists only the games that have a recompilation available (the UP arrow beside Play,
  section 4.5), whether the game is installed or not: also owned games not installed yet, and a paired host's games
  shown for **Download** (this PC matches those with its own recompilation catalogs). The number next to it is how many
  there are on the tab. A tab with it on is named _Recompilations_.
- **Your own filters.** **Y** on a cover (or a right click) → **Create a filter…** asks for a name (up to 40
  characters, not one another of your filters has; the on-screen keyboard opens with a controller) and an icon from
  40, each in its own colour; **Create** (on once both are chosen) saves the filter with that game in it. Once you have
  a filter, the same menu has **Custom filters**: one row per filter, **Add to _name_** or **Remove from _name_** for
  this game (the list stays open, so a game can go in several). **Filters → Custom** (shown once you have a filter)
  lists **All Custom**, then each filter with its icon and how many of the tab's games are in it; it works like the
  other lists: a game in any filter picked shows, it counts toward the 3 filters at once, **Clear filters** turns it
  off, and the tab keeps it and is named after the filters. **Y** or a right click on a filter there gives
  **Rename**, **Change icon** and **Delete** (asked first; the games stay in your library, and the tabs that used it
  lose it). A paired host's games (Streaming) can go in a filter too. Filters are kept in Settings on this PC (up to
  100, of up to 10,000 games each) and are not shared with paired PCs: a synced Library tab keeps its **Custom** picks
  on each PC. A game stays in its filters when it moves: a recompilation's card joining the original game's, a manual
  game whose program moved or a ROM moved to another folder (found again by name, as favourites are); a game removed
  from the library simply no longer shows in them.
- A check in the middle of the cover marks a game you completed (**Y → Mark as Completed**).
- The rail at the right edge jumps to a letter (title sorts) or to a section of the current sort; the D-pad
  jumps the same way.
- The slider at the left edge sets the size of the covers, the same in every tab: **−** at the top makes them
  smaller, **+** at the bottom bigger (from 60% to 160% of the original size; the longer tick in the middle is the
  original size, the default). Drag the diamond or tap the track (it snaps to the sizes), turn the mouse wheel over it,
  or press − / +. With a controller press left from the first column to reach it, then up / down change the size and
  right goes back to the games. Smaller covers fit more per row, bigger ones fewer.
- **Playable first** (the round button with the download arrow, between the search field and the Sort pill): while it
  glows, the games installed on this PC come first and the games you would still have to install (or download from a
  paired host) after them. Each part keeps the tab's sort and its direction, and the filters and search decide which
  games show as usual: the button only moves games, it never hides one. The rail and the D-pad jump through the
  installed games' sections first, then the others'; the rail's **Not inst** entry jumps to the first game that is not
  installed (and **Play** back). It is on for every new tab and is kept with each tab; press it to turn it off.
- **Sort** (listed alphabetically, in Spanish too): **A-Z** (the default for a new tab), **Difficulty**, **H.L.T.B.**, **Played - Most**,
  **Played - Recently**, **Popularity**, **Recently Added**, **Release**, **Reviews** and **Size**. Tabs that used the old _Playable First_ order now use **Played - Recently**
  with **Playable first** on, which is the same order (a tab that had it reversed loses the reverse, as
  **Playable first** always puts the installed games first). The picked order shows a down arrow. Pick it again to reverse it (the arrow points up): **A-Z**
  twice runs from Z to A and ends with titles starting with a number or a sign; **Size** twice runs from the
  smallest game to the largest. Games whose size is unknown always come last. **Release** sorts by when a game
  came out, newest first (the rail jumps by year); twice, oldest first. Games without a release date always come
  last. **Popularity** sorts Steam games by how many people are playing them now, most first (the rail jumps
  between 100K+, 10K, 1K, 100, under 100 and no one playing); twice, fewest first. The counts come from
  [SteamCharts](https://steamcharts.com) (its latest hourly count, or Steam's own count from the game's page when
  that is newer). They are read only while a tab shows this sort: when you pick it or open the Library with it, then
  every hour while it stays, one game at a time, so a large library fills in over a few minutes and the cards move as
  counts arrive. A game is read again after six hours (a day when SteamCharts does not track it or has had no count
  for it for two days). A card with several copies (other stores or systems) uses its Steam copy's count when the copy
  shown has none. Games without a count (not on Steam, emulated, not read yet, or not tracked by SteamCharts) always
  come last. **Reviews** sorts by the review score the game page shows (Steam's percent positive, else IGDB's user
  rating out of 100), highest first; games with the same score go by how many reviews they have, most first, then by
  title. Twice, lowest score first. The rail jumps between the bands of **Filters > Reviews** (95, 90, 85 ... 0). A
  card with several copies uses another copy's score when the copy shown has none. Games without a score always come
  last. **Difficulty** sorts by the level **Filters > Difficulty** gives each game (your pick in the game's **Edit**
  sheet, else PlayOut's cloud pick, else the level a Steam tag gives it, else Medium; a card with several copies uses
  another copy's level the same way), hardest first: Impossible, Hard, Medium, Easy, Story, each level A to Z. Twice,
  Story first. The rail jumps between the levels (I, H, M, E, S). Games labelled **N/A (Tools)** (Steam's
  **Utilities** tag) come last either way, A to Z, in their own section (**N/A** on the rail). **H.L.T.B.** sorts by the HowLongToBeat time
  **Filters > H.L.T.B.** uses (Main Story, else Solo; a card with several copies uses another copy's time when the
  copy shown has none), shortest first, games with the same time A to Z; twice, longest first. The rail jumps between
  the filter's bands (0-3h, 3-10h, 10-20h, 20-50h, 50-100h, 100h+). Games without a time (**No time yet**) always
  come last. Times are looked up as games are imported, so some may be missing: while a tab shows this sort (when you
  pick it or open the Library with it, then every 30 minutes while it stays), PlayOut looks up the games that have no
  time yet, one at a time at HowLongToBeat's pace, and the header shows **Looking up H.L.T.B. times… N games left**;
  the cards move as times arrive. Only times are looked up (nothing else about the game changes); a game
  HowLongToBeat has no entry for (or has only Extra or Completionist times for) is asked about again after a month,
  lookups stop as soon as you pick another sort or leave the Library, and nothing is looked up while HowLongToBeat
  is turned off in Settings > Metadata or is not answering (PlayOut then waits half an hour, the line goes away, and
  the sort tries again on its next round).
- **Picking filters.** The Filters menu stays open while you pick: press a choice to turn it on, press it again to
  turn it off. Genre, Release, Tags, Platform, Size, H.L.T.B., Difficulty, Reviews, Controls, Local Multiplayer and Online Multiplayer take several choices each (a game matching any of them shows; different
  filters narrow together), up to **3 choices at once** across the whole menu, Hidden and Favorites included (Platform's
  systems and its stores count as one choice each, however many are picked); with
  three picked, the others are greyed out until you turn one off. Close the menu with **B** / Escape, **RT** again,
  or a click outside it. The pill shows how many choices are on: _Filters (2)_ (a developer or publisher added from a
  game page counts as one each). While any is on, the menu starts with **X Clear filters**, which turns them all off
  for this tab only (the search and sort stay). While the tab has a developer, publisher or genre on, **Clear
  filters** opens a sub-menu instead (its left arrow, or **A**): **All** at the top turns every filter of this tab off,
  and below it each developer, publisher and genre on the tab is listed (with _Developer_, _Publisher_ or _Genre_ on
  the right); press one to take just that one off. The sub-menu stays open on the next row, and closes when none is
  left. **B** / right steps back to the Filters menu.
- **Filters → Platform** (its left arrow opens the list) starts with the stores (formerly the PC filter, first because
  there are fewer of them): **All Stores**, then each store you have games from (see the stores below). Below a line
  are the systems: **All Platforms**, PC (your manual games) and each emulated system with games (SNES, PS1, ...). The
  stores and the systems each work as before; **All Stores** and **All Platforms** change only their own part. The row
  shows what is picked from both parts ("Steam, PS2").
- **Filters → Release** (its left arrow opens the list) keeps games released in the year ranges picked:
  listed under **All Dates** newest first: 2025-Present, 2020-2025, 2015-2020, 2010-2015, 2005-2010, 2000-2005,
  1990-2000, then **Before 1990** at the bottom. A range covers its first year up to the year before its last
  ("1990-2000" is 1990 to 1999). The other ranges are listed only when you have games from them; Before 1990 always
  is. The row disappears when no game has a release date. Games without a release date are left
  out while a range is picked.
- **Filters → Tags** (its left arrow opens the list) keeps games by their Steam tags (section 6.1): 2D, Action,
  Action RPG, Adventure, Anime, Board Game, Building, Casual, Choices Matter, Choose Your Own Adventure, City
  Builder, Classic, Destruction, Detective, Difficult, Driving, Exploration, Family Friendly, Fantasy, Fast-Paced,
  Flight, FPS, Free to Play, Funny, Futuristic, Hidden Object, Historical, Horror, Immersive Sim, JRPG, Logic,
  Management, Metroidvania, Minimalist, Mystery, Open World, Parkour, Physics, Pixel Graphics, Platformer, Point &
  Click, Procedural Generation, Psychological Horror, Puzzle, Puzzle Platformer, Racing, Realistic, Relaxing,
  Remake, Replay Value, Resource Management, Retro, Roguelike, RPG, RTS, Sandbox, Science Fiction (Steam's
  _Sci-fi_), Shooter, Simulation, Space, Sports, Stealth, Story Rich, Strategy, Survival, Tactical, Tower Defense,
  Turn-Based, Utilities and Visual Novel. Only the tags some game in the list has are offered. Games without Steam
  tags (ROMs, games added by hand, games Steam does not sell) never match.
- **Filters → Platform, above the line** keeps games from the stores picked: Steam, Epic, G.O.G, Xbox,
  Ubisoft Connect, EA App, Battle.Net. Only stores you have games from are listed (a store you have not connected,
  or that has no games, is left out), and the line and the stores are left out when there are none. A game owned in two stores shows
  under both.
- **Filters → Size** (its left arrow opens the list) keeps games of the sizes picked: 0-1 GB, 1-5 GB, 5-15 GB,
  15-30 GB, 30-60 GB, 60-99 GB or 100+ GB. The size is the one shown beside Play / Install (section 4). A size, once found, is
  kept: when PlayOut starts it only sizes games that have none yet (newly added or installed games, a moved
  install, games no store had a size for). Steam and Epic keep their own install records up to date, so those
  follow updates by themselves. A bar along the bottom of the screen shows the progress ("Checking install sizes ·
  3 of 12 · measuring <game>") and the Library header "sizes N left". Store answers are kept in
  `install-sizes.json` in the data folder.
- **Filters → H.L.T.B.** (How Long to Beat; its left arrow opens the list) keeps games by the time HowLongToBeat
  gives for beating them (the bands picked): 0-3, 3-10, 10-20, 20-50, 50-100 or 100+ hours. The time is HLTB's **Main Story**, as its
  pages show it first, compilations included (_Kingdom Hearts HD 1.5 + 2.5 ReMIX_: 113 hours); for a game with no
  Main Story time it is HLTB's **Solo** time, which the game page then shows as **Solo**. Games without HLTB times
  are left out while a band is picked. A store title that names a game with its add-on, such as _KINGDOM HEARTS III + Re Mind_, gets
  the game's times, not the add-on's. After PlayOut starts, games without times are looked up again in the
  background, one a second; a bar at the bottom of the screen shows the progress ("Matching HowLongToBeat times ·
  41 of 141 · <game>").
- **Filters → Difficulty** (its left arrow opens the list, just below H.L.T.B.) keeps games by how hard they are:
  **Story**, **Easy**, **Medium**, **Hard** or **Impossible** (under **All Difficulties**, each with its picture).
  A game you have not set takes its level from its Steam tags: **Visual Novel** is **Story**, **Casual**, **Free
  to Play** and **Relaxing** are **Easy**, and **Souls-like** and **Difficult** are **Hard** (with several, Hard
  wins, then Visual Novel); every other game is **Medium**. A game Steam tags **Utilities** (a tool, not a game,
  whatever else it is tagged) is labelled **N/A (Tools)** instead: it is under no level, so it only shows with **All
  Difficulties**, and the list has no N/A (Tools) choice.
  Your pick in the game's Edit sheet (the pen **Edit** sheet's **Difficulty**, section 4) or a PlayOut cloud correction
  always wins. PlayOut does not look difficulty up anywhere.
- **Filters → Reviews** (its left arrow opens the list, just below Difficulty) keeps games by their review score: **95-100**,
  **90-95**, **85-90**, **80-85**, **75-80**, **70-75**, **60-70**, **40-60** or **0-40** (under **All Reviews**, best
  first). Each band has a star before it, full for 95-100 and filled a little less from the bottom up for each band
  below, down to a sliver for 0-40. The score is the one the game's page shows under **Reviews**: Steam's percent of
  positive reviews, else IGDB's user rating out of 100 (not the 0-100 rating from the other metadata sites). A band
  holds its lower number and not its upper one (a 90 is in 90-95, a 94.9 too; 100 is in 95-100). A card with several
  copies uses the score of the copy shown, else another copy's. Games without a review score are left out while a band
  is picked.
- **Filters → Controls** (its left arrow opens the list): **VR**, **Controller**, **Mouse and Keyboard**, **Touch**
  and **Lightgun**, from the same facts as the controls badge on a game's page (Steam's controller and VR support, or
  the game's **Controls** rows in its Edit sheet; console games play with a controller). A game can be under more
  than one: partial controller support counts as Controller and as Mouse and Keyboard, Full Controller Support + Mouse
  & Keyboard too, Full Controller Support + Mouse & Keyboard + VR as VR, Controller and Mouse and Keyboard, and a game
  where VR is an option (not required) as VR and as Mouse and Keyboard; VR as an option next to a controller (Full or
  Partial Controller Support + VR) puts the game under VR too. VR-only games are only under VR; **Touch** and
  **Lightgun** games (the Edit sheet's Touch and Lightgun picks) are under Touch / Lightgun as well as anything else
  picked beside them, and only there when nothing else is. A PC game Steam says nothing about counts as Mouse and
  Keyboard. A console game is under Controller, plus the Lightgun, Touch or VR its Controls rows pick. No metadata
  source says which games support touch or a light gun yet, so a game is under Touch or
  Lightgun once you or the PlayOut cloud pick it in its Controls rows. The list offers only the choices at least one
  game in the list falls under (plus any you have picked, so it can be turned off); **All Controls** is always there.
  With no games under any choice, only All Controls shows, and Touch and Lightgun stay hidden until a game has them.

**Touch and mouse**

| Gesture             | Action                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Tap / click         | Focus and activate                                                                                               |
| Swipe or drag a row | Scroll it                                                                                                        |
| Mouse wheel         | Scroll rows and lists                                                                                            |
| Hover               | Focus only                                                                                                       |
| Right-click a cover | Its options menu (as Y)                                                                                          |
| Text fields         | The search overlay has an on-screen keyboard; other text fields open the Windows touch keyboard on touch devices |

## 9. System bar and quick panel

The pill in the top-right corner shows (left to right) the search button, the downloads button (only while a game
downloads or waits in the install queue, with the percent of the one downloading now), volume, Bluetooth, Wi-Fi, the
battery percentage and charging state, the power button and the clock. Status refreshes every 15 seconds
(battery changes show immediately).

The **quick panel** opens from the power button, the downloads button or the gauge button in a game's detail panel:

- **Downloads** (while the install queue is not empty, section 3.5): the game downloading now and the ones waiting.
- **Power**: Exit PlayOut, Minimise, Sleep, Restart, Shut down (with a confirmation when Settings → System →
  _Confirm power actions_ is on).
- **Performance**: power mode (Efficiency / Balanced / Performance, the Windows power modes), brightness and
  volume sliders, CPU and memory use.
- Shortcuts to the Windows Bluetooth, Wi-Fi and Sound settings pages.

## 10. Troubleshooting

### 10.1 "Emulator not found" / "core missing"

1. Open **Settings → Emulators**. The emulator named in the error shows _not found_ and the folders PlayOut
   searched (section 5.1).
2. Press **Browse** and select the executable. The override is used from now on for every system that uses
   that emulator.
3. Alternatively put the emulator where PlayOut looks: in `Emulators\<name>\` next to `PlayOut.exe` (or in
   `%APPDATA%\PlayOut\Emulators\`) with the folder and file names from section 5.1, or add the emulator's
   folder to your `PATH`.
4. _Core missing_ means RetroArch was found but `<cores dir>\<core>_libretro.dll` was not. Install the core
   with RetroArch's Online Updater → Core Downloader, or set the **Cores directory** if your cores are not
   in `cores\` next to `retroarch.exe`.
5. The emulator starts but the game does not: that is usually a BIOS or a settings problem inside the
   emulator. Launch the same ROM directly in the emulator to see its own message; PlayOut passes the ROM path
   exactly as the emulator's command line expects it.
6. Prefer a different emulator for the system (for example Beetle PSX instead of DuckStation) in Settings →
   Emulators, or for one game from its Play ▾ menu.

### 10.2 A game is not detected

First: the source must be enabled in Settings → Library, the client must be detected, and you must have
scanned after installing the game. _Show games that are not installed_ and _Show hidden_ reveal games PlayOut
knows but is not showing. Then per store:

- **Steam**: the game must be fully installed in a Steam library that is currently reachable (libraries on a
  disconnected drive are skipped). Non-Steam shortcuts added to Steam are not games Steam installed; add them
  as manual games instead. Steam's location comes from the registry (`HKCU\Software\Valve\Steam`); if Steam
  moved, start it once so it updates the key.
- **Epic Games**: only games the Epic Games Launcher installed (or imported with _Locate_) are listed; a
  folder copied from another PC is unknown to the launcher until you locate it there. DLC, Unreal Engine
  plugins and uninstalled entries are skipped.
- **GOG**: PlayOut uses the `<id>_is1` uninstall entry (written by GOG Galaxy _and_ by GOG's offline
  installers) and the `goggame-<id>.info` file in the game folder. Games installed by hand without an
  installer, or whose folder moved, are missed: add them as manual games.
- **EA App**: detection looks for `__Installer\installerdata.xml` in the EA Games / Origin Games folders and
  the install locations EA registered, and the game's launcher executable must exist (an entry whose exe is
  gone is treated as not installed). Games installed to an unusual folder may be missed; add the
  executable manually (it still launches through the EA App when the game needs it).
- **Battle.net**: the game must appear in Battle.net's own `product.db`; PTR and beta installs are skipped
  on purpose.
- **Ubisoft Connect**: the install must be registered under `HKLM\SOFTWARE\ubisoft\Launcher\Installs` and
  its folder must exist; games moved by hand are not.
- **Xbox / Microsoft Store**: PlayOut lists the Store packages installed for your Windows user. The Store
  cannot tell games from apps with certainty, so some apps may appear (hide them from the Play ▾ menu) and a
  game installed for another Windows user is not visible. Make sure the Xbox app finished installing the game.
- **ROMs**: the subfolder name must be a system id or alias (check the _unrecognised folders_ list after the
  scan); the file extension must be in the system's list; `.zip`/`.7z` only where the system allows archives;
  hidden files and `noload.txt` folders are skipped; discs listed in an `.m3u` are hidden on purpose.
- **Manual folder scan**: executables named like installers, uninstallers, redistributables, updaters or
  crash handlers are filtered out; add such a game with _Add a game (.exe)_ directly.

### 10.3 No artwork or metadata

- Check Settings → Metadata: is _Auto-scrape_ on, are the keys entered? A rejected key is reported in the
  log (section 10.6) with the service's own error message.
- Quotas: TheGamesDB keys have a monthly allowance, ScreenScraper accounts a daily one, IGDB allows four
  requests per second. PlayOut respects the limits and continues later; _Refresh all_ re-queues everything.
- The game is matched to the wrong title or nothing at all: use **Search metadata** (section 6.2) and pick
  the right candidate; give ROMs clean names.
- Steam and GOG Galaxy games show covers even without keys (from the clients' own caches, then the stores'
  image servers); a brand-new Steam install may not have cached art yet - open the game once in Steam's
  library, or leave _Use art from installed store clients_ on and let the store servers fill the gap.
- Art looks stale after you replaced it on a service: refresh the game with _force_ from the Play ▾ menu, or
  delete `%APPDATA%\PlayOut\media\<game id>\` while PlayOut is closed.
- Offline? Nothing is downloaded, but existing cached art keeps working.

### 10.4 Controller not working

- Windows must see the controller: it should show up in Windows Settings → Bluetooth & devices → Devices,
  and `joy.cpl` (press Win+R and type it) lets you test the buttons. Xbox controllers over USB or Bluetooth
  are the reference; other pads must present a _standard_ mapping (XInput). Many third-party pads have an
  XInput switch; DualShock / DualSense controllers work over USB and Bluetooth on Windows 11, Switch Pro
  controllers usually need a mapper that exposes them as XInput.
- Press a button once: a controller is only exposed to PlayOut after its first input.
- PlayOut's window must have the focus. Click into it or Alt+Tab to it.
- Steam Input can take over the controller when Steam is running with _desktop configuration_ enabled, or
  when you launched PlayOut as a non-Steam game: disable the desktop configuration in Steam → Settings →
  Controller, or close Steam while testing.
- A and B are swapped on Nintendo-layout controllers: Settings → Controls → _Swap A/B_.
- The focus drifts by itself: raise the stick **deadzone** in Settings → Controls.
- No rumble: vibration must be on in Settings → Controls and the controller must support it (Xbox controllers
  do; many Bluetooth pads do not expose rumble).

### 10.5 Full screen and exiting

- `F11` toggles full screen at any time; Settings → Appearance → _Start in full screen_ controls the start
  state; the `--windowed` command-line switch ignores it once.
- To quit: the **Exit** pill → _Exit PlayOut_, the power button in the system pill, or `Alt+F4`. _Minimise_
  in the same menu drops to the desktop without quitting.
- PlayOut minimises when a game starts and comes back when the game ends. If it does not come back, the game
  (or a launcher helper inside the game's folder) is probably still running: check the taskbar or Task
  Manager. Sessions end 10 seconds after the last matching process exits; a game launched through a store
  client is given 90 seconds to appear.
- PlayOut is behind the game and the game is still running: press the Windows key or Alt+Tab; PlayOut keeps
  the session going in the background.
- The window appears on the wrong monitor or at the wrong size: leave full screen with `F11`, move or resize
  the window, and re-enter full screen.

### 10.6 Where are the logs?

`%APPDATA%\PlayOut\logs\main.log` (rotated at 5 MB). It records scans, launches (with the exact command
line), the emulator search and every error. Settings → About shows the data folder.

`%APPDATA%\PlayOut\logs\install-size.log` follows the install-size scan: every game it looks at and what it found,
a status line every 10 seconds naming any step that is taking long, a game it gave up on after a minute, a library
file that could not be saved, and any time PlayOut froze. Each line is written to disk at once, so the log is complete
even when PlayOut has to be closed by force.

`%APPDATA%\PlayOut\logs\store-import.log` follows the owned-library imports of your store accounts (Steam, Epic
Games, GOG, EA, Battle.net, Xbox): one line per request PlayOut sent to the store (endpoint, attempt, HTTP status,
time taken, size, the store's Retry-After and the start of an error answer) and one line with the outcome of each
import. API keys and tokens are never written: the address is logged without its query string and key or token
values in an error answer are replaced by `***`. Like `install-size.log`, it is rotated at 5 MB.

### 10.7 Starting over

Close PlayOut and delete `%APPDATA%\PlayOut` (or only `library.json` to keep your settings and keys, only
`accounts.json` to sign out of every store, or only `media\` to drop the cached images). A corrupt file is moved aside as `.bak` automatically and PlayOut starts
with defaults.

### 10.8 "Steam's servers are not responding right now"

When a store's own servers fail while PlayOut imports your owned games (HTTP 5xx such as _502 Bad Gateway_, or
_429_ when the store is limiting requests), PlayOut shows a yellow notice that names the store, for example:
_Steam's servers are not responding right now (HTTP 502 Bad Gateway). This is a problem on Steam's side, not in
PlayOut. Your Steam games are unchanged; PlayOut will try again in 10 minutes._ There is nothing to fix in PlayOut:

- Your library is not touched by a failed import; the games from the last good import stay.
- Each request is first retried three times (after 2, 6 and 15 seconds, longer when the store asks for it).
- If the import still fails, PlayOut imports that store again by itself after 10 minutes and, if that fails too,
  after 30 minutes. Then it waits for the next normal import (start, library scan or the store's Import button).
  Signing out of the store, quitting PlayOut or a successful import cancels the pending retry and clears the notice.
- When the store could not be reached at all or did not answer in time, the notice says so and mentions that
  your internet connection may be the cause; check it if other sites do not load either.

A red _import failed_ message, on the other hand, is a problem PlayOut ran into (for example an answer it could
not read) and is worth reporting with `logs\main.log` and `logs\store-import.log` (section 10.6).

## 11. Files and folders

| Path                                     | Contents                                                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `%APPDATA%\PlayOut\library.json`         | Every game PlayOut knows, with your edits, play times and media links                                                                                  |
| `%APPDATA%\PlayOut\settings.json`        | All settings, including API keys and emulator overrides                                                                                                |
| `%APPDATA%\PlayOut\sessions.json`        | Play sessions (newest 10,000)                                                                                                                          |
| `%APPDATA%\PlayOut\accounts.json`        | Store account sessions, encrypted for your Windows user (section 3.4); delete it to sign out                                                           |
| `%APPDATA%\PlayOut\metadata-cloud\`      | The metadata cloud: last `all.json` (`cache.json`), relay and encrypted maintainer token (`config.json`), edits waiting to be suggested (`queue.json`) |
| `%APPDATA%\PlayOut\media\<game id>\`     | Cached artwork (`cover.<ext>`, `hero.<ext>`, `logo.<ext>`, `icon.<ext>`, `screenshot-<n>.<ext>`)                                                       |
| `%APPDATA%\PlayOut\streaming\`           | Streaming (section 4.3): pairings (encrypted), the host certificate, Sunshine, Moonlight, host art                                                     |
| `%APPDATA%\PlayOut\PeerParty\`           | PeerParty (section 4.2): `peerparty.exe`, its settings and player data (`peerparty-data\`), its logs (`logs\`)                                         |
| `%APPDATA%\PlayOut\logs\main.log`        | Log file                                                                                                                                               |
| `<Emulation folder>\PlayOut\Favorites\`  | Your favourites, one list per PC (section 1); kept when PlayOut is uninstalled, read back after a reinstall                                            |
| `%APPDATA%\PlayOut\Emulators\<name>\`    | Optional: emulators PlayOut should find without configuration                                                                                          |
| `<PlayOut folder>\Emulators\<name>\`     | Same, next to the executable (portable builds)                                                                                                         |
| `<PlayOut folder>\Recompilations\`       | Recompilations (section 4.5), one folder each; `.playout\recomps.json` lists them                                                                      |
| `%APPDATA%\PlayOut\cache\recomp\`        | The recompilation catalogs, release lists and READMEs (fetched again daily)                                                                            |
| `%APPDATA%\PlayOut\recomp-achievements\` | Xbox 360 recompilations' achievement lists, one per game, read once from your copy (section 4.5)                                                       |
| `<PlayOut folder>\VR Mods\`              | VR mods (section 4.6), one folder each, beside the Recompilations folder; `%APPDATA%\PlayOut\vr-mods.json` lists them                                  |
| `%APPDATA%\PlayOut\cache\vr-mods\`       | VR mods' GitHub release lists and READMEs                                                                                                              |
| `<PlayOut folder>\resources\systems\`    | System definitions, emulator find rules, scraper platform ids, Battle.net product table                                                                |

Files are written atomically (temporary file, then rename) and a few hundred milliseconds after a change, so
closing PlayOut right after an edit is safe.
