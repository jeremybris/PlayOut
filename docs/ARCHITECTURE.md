# PlayOut — Architecture

PlayOut is a Windows game launcher with a console-style ("Winhanced" / Xbox dashboard) UI. It combines ES-DE's
ROM-folder model (one subfolder per system, emulators located by find-rules) with Playnite-style store integrations
(Steam, Epic, GOG, EA App, Battle.net, Ubisoft Connect, Xbox/Microsoft Store, plus user-added executables).
It is driven by mouse/keyboard, gamepad and touch.

Version 1 scope: installed games plus, per store account the user signs in to, the owned-but-not-installed games
shown greyed out with an Install action (§4.8), artwork and metadata from SteamGridDB, IGDB, ScreenScraper,
TheGamesDB, Steam and HowLongToBeat, play-session tracking, and a system bar (battery, network, Bluetooth, volume,
power, clock) with a quick "performance" panel (power mode, brightness, volume, CPU/RAM).

The research that backs the exact integration details lives in `docs/research/` (SUMMARY.md first).

## 1. Stack

| Concern                    | Choice                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell                      | Electron (electron-vite project: `src/main`, `src/preload`, `src/renderer`)                                                                                         |
| UI                         | React 19 + TypeScript, plain CSS with custom-property tokens (no CSS framework)                                                                                     |
| State                      | zustand stores in the renderer                                                                                                                                      |
| Focus / spatial navigation | `@noriginmedia/norigin-spatial-navigation` (or the custom engine in `src/renderer/src/input/` if it proves unfit; the decision is recorded in that folder's README) |
| Icons                      | `lucide-react` for UI icons, `simple-icons` SVG paths for platform badges                                                                                           |
| Persistence                | JSON files in `app.getPath('userData')` written atomically (`library.json`, `settings.json`, `sessions.json`); no native modules anywhere                           |
| Validation                 | `zod` on every IPC boundary                                                                                                                                         |
| Packaging                  | electron-builder: NSIS installer + portable exe (`npm run build:win`); app.asar carries `out/`, `resources/` and only `dependencies` (§7)                           |

Rules:

- No native Node modules (no better-sqlite3, no sharp, no node-gyp). Everything Windows-specific goes through
  `reg.exe`, PowerShell, `tasklist`, WMI/CIM and URIs via `src/main/system/powershell.ts` and `registry.ts`.
- `contextIsolation: true`, `sandbox: true` in the renderer; the renderer only talks to `window.playout` (typed `PlayOutApi`).
- Every IPC handler validates its arguments with zod and never throws raw errors across the bridge: it returns
  typed results or rejects with an `Error` whose message is user-presentable.
- The renderer must run in a plain browser with the mock API (`npm run dev:web`) so the UI can be developed and
  screenshot-tested without Electron.
- All sizes in the renderer are in `rem` with `html { font-size: calc(100vh / 108) }` (1rem = 10px at 1080p), so the UI
  scales like a console UI on 1280x800 handhelds and 4K TVs.

## 2. Directory layout and ownership

```
src/shared/            types.ts (domain model), api.ts (PlayOutApi + IPC channel names)     [core]
src/main/
  index.ts             app bootstrap: single instance, protocol, window, services, IPC       [core]
  window.ts            main window (frameless fullscreen), focus/restore, --screenshot flag  [core]
  media-protocol.ts    media:// scheme serving the image cache                                [core]
  logger.ts            electron-log setup                                                    [core]
  ipc/register.ts      registers every PlayOutApi method from the handler modules            [core]
  ipc/*.ts             handlers per domain: library, sources, emulation, launch, metadata, settings, system, app [integration]
  store/json-store.ts  atomic JSON file store with debounce                                   [core]
  store/library-store.ts, settings-store.ts, sessions-store.ts                               [core]
  services/library-service.ts   merges ScannedGame[] into the library, exposes queries       [core]
  providers/types.ts   GameProvider interface                                                [core]
  providers/index.ts   provider registry (order = STORE_SOURCES + manual + rom)              [core]
  providers/steam.ts                                                                         [steam]
  providers/epic.ts, gog.ts                                                                  [epic-gog]
  providers/ea.ts, battlenet.ts, ubisoft.ts, xbox.ts                                         [ea-bnet-ubi-xbox]
  providers/manual.ts  user-added exes + "scan folder for games" heuristics                  [manual]
  providers/rom.ts     thin provider delegating to emulation/rom-scanner                     [emulation]
  accounts/            store accounts (§4.8): index.ts (AccountsService), auth-window.ts (sign-in BrowserWindow),
                       token-store.ts (accounts.json, safeStorage), types.ts (StoreAccount importer contract),
                       api.ts (fetch helpers, SessionExpiredError), steam.ts, epic.ts, gog.ts, xbox.ts, battlenet.ts,
                       ea.ts, ubisoft.ts (+ <store>.test.ts; test-helpers.ts holds the test fakes and is never bundled)  [accounts]
  achievements/        §4.10: achievements-service.ts (library passes, one game's list), steam.ts (IPlayerService,
                       works with the sign-in token), retroachievements.ts (Web API client), ra-hash.ts (rcheevos hashes)
  installs/            background install tracker (§4.8): index.ts (InstallService), tracker.ts (watch loop),
                       install-uri.ts (per-store install URIs + the scheme allow-list), log-tail.ts, probe-fs.ts,
                       steam-progress.ts, epic-progress.ts, gog-progress.ts, xbox-progress.ts, battlenet-progress.ts,
                       ea-progress.ts, ubisoft-progress.ts (+ *.test.ts)                     [installs]
  emulation/           systems.ts, find-rules.ts, rom-scanner.ts, launch-command.ts, esde-import.ts [emulation]
  launcher/            launcher.ts (executes LaunchSpec), process-monitor.ts, session-tracker.ts [launcher]
  overlay/             §4.15 home overlay: suite.ts (wires everything below), overlay-window.ts, extras.ts (Game
                       tiles + live chips), auto-hdr.ts, game-extras-store.ts                [overlay]
  performance/         power profiles, Dynamic TDP, service.ts; helper/ (SYSTEM power helper: protocol.ts,
                       csharp.ts, script.ts), helper-client.ts, install.ts; memory/ ("Free up memory":
                       planner.ts, exclusions.ts, names.ts, trim-cs.ts, service.ts)          [overlay]
  native-host/         the overlay's PowerShell native host (native-cs.ts C#, native-ops.ts)  [overlay]
  rtss/                RivaTuner Statistics Server: shared memory, OSD text, ini edits, service.ts [overlay]
  intel/               Intel Graphics Control Library: Endurance Gaming (intel-graphics.ts)   [overlay]
  friends/             the overlay's Friends tab: steam-friends.ts (Steam Web API friends + summaries, 30 s cache,
                       steam://friends/message/<id>)                                         [overlay]
  recomp/              §4.14 recompilations: service.ts (API, queue, launch), catalog.ts, consoles.ts, titles.ts,
                       match.ts, releases.ts, assets.ts, install.ts, state.ts, gamefiles.ts, saves.ts, cloud.ts,
                       http-cache.ts                                                         [recomp]
  scrapers/            types.ts, steamgriddb.ts, igdb.ts, screenscraper.ts, thegamesdb.ts, steam-store.ts, hltb.ts, gog-api.ts,
                       review-scores.ts (Steam / IGDB review scores), steam-tags.ts (Steam user tags),
                       metadata-service.ts (the two lanes + merge), image-cache.ts            [scrapers]
  scrapers/art-ids.ts  ArtIds of a Game (source/externalId, extra, metadata.sources); image-sniff.ts (JPEG/PNG/WebP/ICO
                       header reader + the per-kind quality rules); media-batch.ts (setMediaBatch coalescer);
                       cover-lane.ts (the cover lane, §4.6 "Art pipeline"); art-bench.ts (--art-bench probe)  [art]
  scrapers/local-art/  index.ts (LocalArtSource registry), steam-cache.ts (librarycache + assetcache.vdf),
                       galaxy-cache.ts (GOG Galaxy webcache: six stores), esde-media.ts, playnite-files.ts   [art]
  scrapers/direct-art/ index.ts (DirectArtSource list), steam-cdn.ts, gog-images.ts, epic-catalog.ts (catcache.bin +
                       stored keyImages), xbox-catalog.ts, steamgriddb-platform.ts, igdb-external.ts        [art]
  system/              powershell.ts, registry.ts, uninstall.ts (Add/Remove Programs entries, cached), ps-worker.ts (core);
                       status.ts, volume.ts, brightness.ts, power.ts, network.ts, bluetooth.ts, perf.ts, windows-settings.ts [system]
  util/                vdf.ts (guards @node-steam/vdf against unterminated strings), hash.ts (crc32/md5/sha1), fs.ts, paths.ts,
                       text.ts (sortTitle, cleanRomTitle, removeTrademarks, displayIconPath)   [core]
src/preload/index.ts   window.playout bridge generated from API_METHODS                      [core]
src/renderer/src/
  main.tsx, App.tsx    root, router-less screen state                                        [ui-shell]
  api/client.ts        window.playout or mock                                                [core]
  api/mock/            mock implementation + sample library + sample art                     [ui-mock]
  state/               zustand stores: library, ui, settings, system                         [ui-shell]
  input/               gamepad.ts, keyboard.ts, focus.ts (spatial nav init), touch.ts        [ui-shell]
  styles/              tokens.css, base.css                                                  [ui-shell]
  components/          SystemBar, HeroBackdrop, GameCard, GameRow, Pill, Chip, Button, IconButton, StatBlock,
                       PlatformBadge, Modal, Toast, OnScreenKeyboard                         [ui-shell]
  screens/Home/        Home, RecentRow, EmptyState (hero + Recent row; the Library view sits below)  [ui-shell]
  screens/Library/     full-screen library grid: tab band, header filters, windowed grid,
                       SettingsTab.tsx (the 'Settings' tab: the Settings menu, §6.1)          [ui-shell]
  state/installs.ts    zustand map gameId -> InstallProgress fed by 'install:progress'        [ui-shell]
  screens/GameDetail/  detail modal                                                          [ui-detail]
  screens/AddGames/    add-games modal (stores, ROM folder, exe)                             [ui-detail]
  screens/Settings/    settings modal with sections                                          [ui-settings]
  screens/Search/      search overlay                                                        [ui-settings]
  screens/QuickPanel/  power menu + performance panel                                        [ui-settings]
resources/
  systems/systems.json        ES-DE derived system definitions (SystemDefinition[])           [emulation]
  systems/find-rules.json     ES-DE derived Windows emulator find rules                       [emulation]
  systems/platform-ids.json   platformKey -> scraper platform ids                             [scrapers]
  systems/battlenet-products.json                                                             [ea-bnet-ubi-xbox]
  icon.png / build/icon.ico (generated by scripts/make-icon.mjs)
docs/ARCHITECTURE.md (this file), docs/USER-GUIDE.md, docs/research/* (store-accounts.md: sign-in, owned-library
                        and install-progress recipes per store, with the feasibility table), docs/LICENSES.md, LICENSE (PlayOut License)
scripts/screenshot.mjs  launches the built app with --mock --screenshot and saves PNGs        [ui-mock]
scripts/build-systems.mjs  regenerates resources/systems/{systems,find-rules,mame-assets}.json from docs/research
                        and resources/systems/esde-mame/{mamebioses,mamedevices}.xml                   [emulation]
scripts/make-icon.mjs   renders the logo offscreen into build/icon.png, build/icon.ico, resources/icon.png [docs-assets]
```

Ownership tags are the parallel build agents. Agents only create or edit files they own; cross-module needs are
expressed through the interfaces in this document and in `src/shared`.

## 3. Domain model

See `src/shared/types.ts`. Key points:

- `Game.id` = `${source}:${externalId}`; ROM ids are `rom:${systemId}:${hash}` where hash = first 16 chars of the
  base64url SHA-1 of the ROM path relative to the ROM root (forward slashes). Ids never change for the same file.
- `Game.platformId`: store id for store games, `'pc'` for manual games, the system id for ROMs.
- `Game.launch` (`LaunchSpec`) and `Game.tracking` (`TrackingSpec`) are produced by the provider at scan time.
  Emulator launches are resolved at launch time (`emulation/launch-command.ts`).
- `Game.user` holds user edits and is never overwritten by scans or scrapers. A `GameUserPatch` clears a user field
  with `null` (structured clone drops `undefined` over IPC); `library-service.updateGame` deletes the key.
  `favorite`, `hidden` (`hiddenByStore` marks what a store hides: `LibraryService.syncStoreHidden`, fed by
  `readSteamHiddenApps` and, for GOG, `readGalaxyHiddenGogIds` (Galaxy's SQLite database, read from a temp copy via
  `node:sqlite`) joined with `extra.gogHidden` from the gog.com listing, at startup and after the store's scans and
  owned imports, moves `hidden` only when the store's answer changes), play time,
  sessions and metadata are preserved across rescans; a game not found by a rescan is marked `installed: false`
  (shown greyed out while `settings.library.showUninstalled`, default true), never deleted automatically. The one
  exception is a ROM whose file is gone (nothing to reinstall): `mergeScan('rom', …)` deletes the record when it was
  never played, has no sessions and no user state (`hasUserState`: favourite, completed, hidden, renamed, custom
  art, preferred copy), and greys out the others. Manual games are only removed by the user.
- `Game.owned` is true while a signed-in store account lists the game (`LibraryService.mergeOwned`, §4.8). Installed
  scans never set or clear it. A game that is `owned` and not `installed` exists only because of the account: it has
  no `installDir`, `tracking: { mode: 'none' }` and `launch` set to the store's install URI form (`steam://install/<appid>`,
  `com.epicgames.launcher://apps/<AppName>?action=install`, ...; the install tracker, not `launchGame`, consumes it).
  Visibility rule (`lib/library.ts` `visibleGames`): `installed || (showUninstalled && (owned || previously installed))`;
  because `mergeOwned` deletes a game that lost `owned`, was never installed and has no sessions, "previously
  installed" is every remaining uninstalled record, so the renderer test stays `(installed || showUninstalled) && (!hidden || showHidden)`.
  Home's Recent row is its own list over the visible games (`lib/recent.ts` `recentlyPlayed`): every game playable
  here (never a stale recompilation stand-in, `staleStandIns`), plus, only on a PC paired with at least one host
  (`isStreamingClient`: `StreamingStatus.client.hosts`; a PC with no host keeps its installed games only), the games
  not installed here that were played (`lastPlayed` set: on this PC, or on a paired PC through
  the play time sync, the host's offer and the last played relay) and pass `obtainableHere` (a host's game that streams or downloads, a
  game a store account `owned`, a record a host also has); never-played games that are not installed never pad it,
  and a played record that is neither installed, owned nor on a host is left out. One game is one card (the
  Library's groups), dated by the latest play of those copies, shown as a copy installed here when there is one.
- `AccountStatus`, `OwnedGame`, `ImportOwnedResult`, `InstallResult`, `InstallState` and `InstallProgress` (all in
  `types.ts`, "Store accounts and installs") are the account/install contract described in §4.8 and §5.
  `StoreSourceId` (`Exclude<SourceId, 'manual' | 'rom'>`) now lives in `types.ts` and is re-exported by `platforms.ts`.
- `Game.media` holds `media://` URLs produced by `image-cache.ts`; the renderer treats them as opaque image URLs.

## 4. Main process

### 4.1 Bootstrap (`index.ts`, `window.ts`)

- `parseCli()` runs first and, for `--mock`, moves `userData` to `%TEMP%\playout-mock` **before**
  `app.requestSingleInstanceLock()`: Electron keys the lock on the userData path, so a mock run (screenshots, UI work)
  is a separate instance that never fights a running dev or installed PlayOut. Then the lock is requested; a second
  launch of the same instance focuses the existing window.
- `protocol.registerSchemesAsPrivileged([{ scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])` before `app.whenReady()`;
  `protocol.handle('media', ...)` serves files from the cache directory only (path traversal rejected).
- Main window: frameless, `fullscreen: settings.ui.startFullscreen`, `backgroundColor: '#0b0b0f'`, `show: false`
  until `ready-to-show`, `autoHideMenuBar: true`, `webPreferences: { preload, sandbox: true, contextIsolation: true }`.
  F11 toggles fullscreen; Alt+F4 / `powerAction('exit')` quits.
- `--screenshot=<path>` (dev): the window is created at 1920x1080 content size with `--force-device-scale-factor=1`
  (so the capture is 1920x1080 px on any DPI); after the renderer reports ready, wait 2500 ms, `capturePage()`,
  crop if the display could not fit the window, write the PNG, quit.
  `--mock` makes the renderer use the mock API inside Electron (for screenshots with deterministic data) and moves
  `userData` to `%TEMP%\playout-mock`, so the harness never touches the real library, settings or logs.
  `--scan=<report.json>` (diagnostic) scans every enabled source at startup, waits (at most 10 min) for the cover lane
  the scan queued to drain, and writes the per-source counts, client info, errors, unknown ROM folders, `scanMs`,
  `coverLaneMs` and the covers per source (`covers.bySource`: `steam-cache`, `steam-cdn`, ...) as JSON, then quits
  (or captures first when combined with `--screenshot`). It never waits for the full lane.
  `--windowed` skips fullscreen; Electron's own `--user-data-dir=<dir>` points stores, media cache and logs at another
  folder (used by the smoke tests so the real library is never touched).
- `powerMonitor` suspend/resume stops and restarts the system status polling so no PowerShell probe runs during sleep.
- Services are created once in `index.ts` and passed to the IPC handlers:
  `libraryService`, `settingsStore`, `sessionsStore`, `providers`, `emulation`, `launcher`, `metadataService`, `systemStatus`,
  `accounts` and `installs` (§4.8; created after `scan` and the main window, disposed in `before-quit` next to the
  launcher, their store flushed with the others).

### 4.2 Stores (`store/*`)

- `JsonStore<T>`: `load()`, `get()`, `set(mutator)`, debounced (250 ms) atomic write (`write tmp -> rename`) with a
  maximum wait (`maxWaitMs`, default 8 x the debounce; `library.json` 400 ms / 3 s) so a stream of sets closer
  together than the debounce still lands on disk, schema version + migration hook, zod-validated on load with
  fallback to defaults and a `.bak` of a corrupt file.
- `library.json`: `{ version: 1, games: Record<string, Game>, platforms: Platform[] }`.
- `settings.json`: `Settings` (defaults in `settings-store.ts`, `DEFAULT_SETTINGS` exported for the mock too via `src/shared/defaults.ts`).
  `library.showUninstalled` defaults to **true** (Settings > Library label "Show games that are not installed").
  `version` is `SETTINGS_VERSION` (2, `shared/defaults.ts`); `normalizeSettings` migrates a version-1 file whose
  `showUninstalled` is `false` to `true` (that value was the old default written by every build, not a choice), a
  version-2 `false` is kept.
- `sessions.json`: `PlaySession[]` (append-only, capped at 10,000).
- `accounts.json`: store account tokens, see §4.8 (`accounts/token-store.ts`); never exported to the renderer.

### 4.3 Providers (`providers/*`)

```ts
export interface GameProvider {
  id: SourceId
  name: string
  platforms(): Platform[] // the platform rows this provider populates (stores: one; rom: the systems seen in the last scan)
  detectClient(): Promise<ClientInfo>
  scansWithoutClient?: boolean // GOG: offline installers register games without Galaxy, so the scan runs anyway
  scanInstalled(ctx: ScanContext): Promise<ScannedGame[]> // ctx: { settings, log, resourcesDir, progress(found, message?) }
}
```

- `scan-service.ts` skips a provider whose client is not installed unless it sets `scansWithoutClient`; client
  detection is cached 60 s; Add/Remove Programs entries come from `system/uninstall.ts` (one cached read per scan).
  It exposes `client(id)` (the cached detection, used by the install service) and `onSourceScanned(listener)`,
  fired after each successful installed scan of a source; `index.ts` wires that listener to
  `accounts.importOwned([source])`. The 4 s startup rescan (deferred until the window has loaded, in the background
  with the usual `scan:progress` bar) covers `startupScanSources`: every source that already has games plus `rom`
  (`settings.library.romsRoot`, always the Emulation folder's roms folder: `romsRootOf`, kept in step by `keepRomsRootInSync` at startup and on every settings change), so ROMs copied in or deleted while PlayOut was closed are found even
  when the library has no ROM yet; unchanged games are not queued for metadata again (`mergeScan` reports only new
  games and art a game lacks). Once at startup, after that rescan, `index.ts` calls `importOwned` for the
  signed-in supported sources the rescan did not cover (§4.8), so the greyed cards follow the account and no store
  is imported twice. `run(ids, { reason: 'confirm' })` is the install tracker's periodic check of one source: it
  reuses the cached client detection (no PowerShell for Xbox / Ubisoft), emits no `scan:progress` and does not fire
  the scanned listeners (no owned import every 10 s); `mergeScan` counts `updated` only for records a field of which
  moved and emits `library:changed` only when `added + updated + removed > 0`.
- Providers never touch the library; `library-service.ts` merges their `ScannedGame[]` (`mergeScan`) and the account
  importers' `OwnedGame[]` (`mergeOwned`, §4.8). `mergeScan` never sets or clears `owned`.
- Art hand-over: a provider's `ScannedGame.localMedia` (Steam's `findLibraryCacheArt` for installed games, Xbox
  AppxManifest logos, ES-DE gamelist images) comes back from `mergeScan` as `localMedia` and goes to the metadata
  service as seeds, in the same call that queues the new games:
  `metadata.enqueue([...merge.newGameIds, ...seedIds], { seeds: merge.localMedia, coverOnly: !autoScrape })`.
  `mergeScan` reports `localMedia` only for kinds the game still lacks (no `media[kind]`, no custom art), and a
  `confirm` scan (the install tracker's 10 s check) calls `enqueue` only when it found a new game, so the
  confirming scans never re-queue every installed game of the source and never reset the metadata progress.
  `scan-service` no longer copies art itself (`importLocalMedia` is gone): the cover lane copies the seeds, batches
  the library writes and, with `scrapers.localArt`, also asks the local caches for the games the provider found no
  art for (§4.6 "Art pipeline"). With `autoScrape` off only the seeds and the local caches are used, nothing is downloaded.
- Store recipes (registry keys, manifest paths, URIs, play time sources, local art) are in `docs/research/SUMMARY.md` §1.
- `providers/rom.ts` returns one ScannedGame per ROM with `platformId = systemId` and registers one `Platform` per
  system that has games (`kind: 'system'`). A set ROM folder that is not a directory (a drive not connected yet)
  fails the scan with "ROM folder not found" instead of returning no games, so the library keeps its ROMs.

### 4.4 Emulation (`emulation/*`)

- `systems.ts`: loads `resources/systems/systems.json`; `findSystemForFolder(name)` matches id or alias, case-insensitive.
- `find-rules.ts`: resolves `%EMULATOR_X%` / `%CORE_X%` from `find-rules.json` + `settings.emulators.overrides` +
  `settings.emulators.coresDir`; rule types: static paths with `%ESPATH%`-style variables (mapped to PlayOut's own
  `Emulators/` folder next to the exe and in userData), `%USERPROFILE%`, Program Files, registry lookups; results cached per scan.
- `rom-scanner.ts`: walks `romsRoot/<systemFolder>/**`, keeps files with the system's extensions (case-insensitive),
  treats any directory whose name ends in one of the system's extensions (other than the extensionless `.` marker)
  or a `dirExtensions` entry as a game, as ES-DE's `populateFolder`; handles `.m3u` (the m3u is the game; the
  discs it references are hidden), skips hidden/system files and `noload.txt` folders; in arcade / mame / neogeo
  folders the MAME BIOS and device sets from `resources/systems/mame-assets.json` are not games (ES-DE's
  `isArcadeAsset`); `_`-prefixed names (`_Unsorted\`) are ordinary entries and are scanned. Title = file name without
  extension with ES-DE/No-Intro tags `(USA)`, `[!]` moved out of the display title into `extra.tags`.
- `launch-command.ts`: expands the ES-DE placeholders documented in `docs/research/esde-systems.md` into
  `{ file, args[], cwd }` (argv array, never a shell string); `%ROM%` quoted paths; `%RUNINBACKGROUND%`,
  `%HIDEWINDOW%` honoured; returns `LaunchError` `emulator-missing` / `core-missing` with the searched paths.
- `esde-import.ts`: reads `~/ES-DE/gamelists/<system>/gamelist.xml` (fast-xml-parser) and `downloaded_media` to seed
  metadata and media for ROMs that match by path. Play state is imported too (`favorite`, `hidden`, `playcount`,
  `playtime` seconds -> minutes, `lastplayed`, `altemulator` label -> `user.emulatorId`) through
  `library-service.applyImportedState`, which only turns flags on, only grows counters and never overrides a
  user-chosen emulator. A gamelist's system-wide `<alternativeEmulator>` label maps to
  `settings.emulators.preferred[systemId]` (`ipc/handlers.ts` `importEsde`), only when the user has not chosen one.
- `SystemInfo.availableEmulators` lists the ids of the system's `EmulatorCommand`s whose `%EMULATOR_X%` references
  all resolved (the mock returns the same shape); a missing RetroArch core is reported at launch time.

### 4.5 Launcher and sessions (`launcher/*`)

- `launcher.launch(game, options)`: resolves the LaunchSpec (`uri` -> `shell.openExternal`; `exec`/`emulator` ->
  `spawn(file, args, { cwd, detached: true, windowsHide: false, stdio: 'ignore' })` + `unref()`; `uwp` ->
  `explorer.exe shell:AppsFolder\<aumid>`), then starts a session via `session-tracker`. `.lnk` targets are
  resolved with `shell.readShortcutLink`; `.bat`/`.cmd` run through `cmd.exe /d /s /V:OFF /c "<line>"` with every
  argument cmd-quoted and arguments containing `%`, `"` or line breaks refused. An `exec`/`emulator` spawn that fails
  with `EACCES` (`ERROR_ELEVATION_REQUIRED`: the exe demands administrator rights) is retried once through
  `Start-Process -Verb RunAs -PassThru` (UAC prompt) and tracked by the returned pid. Battle.net games
  (`extra.launchesViaClient`) first make sure the client is running: when no `Battle.net` process exists the client
  exe is started, the launcher waits until at least 5 Battle.net processes exist (up to 90 s) plus 5 s, then sends
  `--exec="launch <code>"` (Playnite's BattleNetGameController). EA and Ubisoft launches rely on the 120 s grace
  period below rather than on client-specific waits.
- `session-tracker`: a session begins at launch; running state comes from `process-monitor` according to
  `game.tracking`: `spawned` watches the child exit; `installDir`/`process` poll the process list every 3 s
  (grace period 120 s for the launcher to start the game, session ends 8 s after the last matching process
  disappears); `uwp` polls by package family name; `none` records a 0-minute launch. The process list comes from
  one persistent PowerShell worker (`system/ps-worker.ts`) shared by every poller and closed after 60 s idle. Emits `session:started` / `session:ended`,
  updates `playtimeMinutes`, `lastPlayed`, `playCount`, appends to `sessions.json`. Session minutes are the sum of
  the poll gaps while the game was seen running; a gap longer than `pollMs + 30 s` is discarded (sleep/hibernate),
  per Playnite's rule in `docs/research/electron-stack.md` 7.4 step 3, and passed to `library.endSession(active, minutes)`.
- While a session runs and `settings.ui.minimizeWhilePlaying` is on, the main window minimizes; on session end it is
  restored and focused (`win.restore(); win.show(); win.focus(); win.setAlwaysOnTop(true)` briefly).

### 4.6 Scrapers (`scrapers/*`)

```ts
export interface Scraper {
  id: ScraperId
  isConfigured(settings: Settings): boolean
  /** Find candidates for a game (by hash for ScreenScraper, by name+platform otherwise). */
  search(game: Game, settings: Settings): Promise<MetadataCandidate[]>
  /** Fetch full metadata + media URLs for a chosen candidate. */
  fetch(game: Game, candidate: MetadataCandidate, settings: Settings): Promise<ScrapedResult>
}
export interface ScrapedResult {
  metadata: Partial<GameMetadata>
  media: Partial<Record<MediaKind, string | string[]>> /* remote URLs */
}
```

- `metadata-service.ts`: two lanes over one `enqueue` (the "Art pipeline" below), per-scraper rate limits, auto-runs
  after scans and owned imports when `settings.scrapers.autoScrape`, emits `metadata:progress`. Merge policy of the
  full lane: text fields from the first scraper in `[steam (store games), gog (gog games), screenscraper, igdb,
thegamesdb]` that returns them; art per kind from `settings.scrapers.artPriority` (default `['steamgriddb',
'steam', 'screenscraper', 'thegamesdb', 'igdb', 'gog']`) after the local caches and direct sources; HLTB always
  fills `hltb` (`comp_main` / `comp_plus` / `comp_100`, and `solo` = `comp_all` when HLTB combines the play
  styles, `comp_lvl_combine` = 1, or when there is no `comp_main`; `combined` records which). Search words drop
  dashes that wrap a word and split on "+" (HLTB matches each word: "KINGDOM HEARTS -HD 1.5+2.5 ReMIX-" found
  nothing as sent). A store's "Game + Add-on" title (`bundleBase`: " + " before a word, not a number) never
  takes a DLC entry (the Re:Mind expansion for "KINGDOM HEARTS III + Re Mind") and falls back to searching the
  game's own name; a bundle HLTB lists as one entry (Super Mario 3D World + Bowser's Fury) still matches in full. Matching: a title within a year of the store's release scores +0.1, a store
  copy released years after HLTB's entry (a port, such as Phoenix Wright: Ace Attorney Trilogy, 2014 on HLTB and 2019
  on Steam) -0.05, an HLTB entry years after the store's (a remake) -0.15. A year HLTB puts in an entry's name
  ("SSX (2012)") is not part of the name: the entry matches at -0.01 and that year is its year when HLTB gives no
  other. For a ROM, an entry HLTB lists (`profile_platform`) on the console the ROM was found on (`hltbConsolesFor`)
  scores +0.05; never a requirement. `backfillHltb` runs after the startup
  rescan, one game at a time in a random order: times without `combined` (found before Solo times were read) and
  scraped games with no times are looked up again; an HLTB answer of "no match" (`hltbLookupOutcome`, unlike a
  failure) is recorded as `hltb.missedAt` with `rules` (`HLTB_MATCH_RULES`; a miss from rules older than 4 is asked again at once, and so are the times
  of a "Game + Add-on" game found by them; rules 5, the year in a name and the console, redo only what rules 4 could
  get wrong, `yearTagHidden`: a short title with a year (most titles of up to three or four words), a miss for any
  game, and the times only of a ROM that is known to share its name with another game: its IGDB address is numbered
  ("/games/ssx--1") or the library has a game of that title from other years)
  and asked again after a month; five failures in a row stop it for the run. The Library's
  Filters → H.L.T.B. and the game page go by `lib/hltb.ts` `hltbHours`: Main Story, else Solo (HLTB's pages lead
  with Main Story for compilations too); Steam `currentPlayers` refreshes when the detail panel opens (cached 10 min). Achievements live in
  `achievements/` (§4.10).
- `steam-tags.ts`: Steam's user tags in `metadata.steamTags` (`tags` strongest first, up to 20; `appId`; `title` when
  found by a title search; `updatedAt` / `missedAt`). A field of its own because `metadata.tags` belongs to the text
  scrapers (Steam categories, IGDB themes, age ratings) and a forced refresh replaces it. `createSteamTags` (wired in
  main/index.ts like the review scores: after the startup rescan, on `library:changed` except sessions and removals,
  and when switched on; `settings.scrapers.steamTags.enabled`) reads every due game (`steamTagsDue`: never read,
  older than 90 days, a miss older than 30 days, matched to another app, or retitled; never ROMs or manual games).
  App ids: `knownSteamAppId` = `steamAppIdOf`, else `metadata.sources.steam`, else `metadata.storage.steamAppId`
  (the install-size title match); otherwise, as the install sizes do, a single Steam copy of the same title in the library (two: none), else `steamAppIdByTitle` (store search, exact unique title; 0.2 searches/s of its own on top of the shared storesearch limiter; a refresh reuses the app found by the same title). A title match is kept only when its year is within one of the game's release (`sameRelease`: Steam's `original_release_date` for a re-release, else its release date, from the same GetItems call with `include_release`), so Prey 2006 does not take Prey 2017's tags. A record read through an app the game no longer has, or a miss for a game that has since been matched, is due at once. Keyless
  `IStoreBrowseService/GetItems` with `include_tag_count: 20`, 100 app ids per request (`id` echoes the id asked;
  `success` other than 1 = not on the store), tag ids named by `IStoreService/GetTagList` (cached a day). One
  limiter at 0.5 request/s; three failures pause the pass 15 minutes, two pauses end it until the next kick. The
  renderer shows `lib/steamTags.ts` `detailTags` (four, minus the genre shown) as chips (`gdetail__tag--3/4` drop on
  narrow canvases) and matches them in `filterLibrary` and the search overlay.
- `review-scores.ts`: a game's review score in `metadata.reviewScore` (`source` 'steam' | 'igdb', `score` 0-100,
  `count`, Steam's `label`, `steamAppId` / `igdbId`, `via` = `ratingLookupKey`: the Steam app and IGDB match (else
  the title) it was looked up by, plus `|no-igdb` on an IGDB score or a miss made while IGDB was not set up (never on a Steam score), so a
  changed match, title or newly set up IGDB reads it again; `updatedAt` / `missedAt`). `createReviewScores` (main/index.ts: after the startup rescan,
  on `library:changed` except sessions and removals, and when the IGDB credentials change) reads every due game
  (`ratingDue`: never read, read a month ago, or `via` no longer the game's key; `pending` games too), installed
  games first. 1. Steam: `IStoreBrowseService/GetItems` (api.steampowered.com, no key; the old
  store.steampowered.com/appreviews JSON redirects to the store's home page since late 2026) with
  `include_reviews`, 100 apps a request (`steamReviewsLimiter` 2/s), `summary_language_specific` (English: what the store page shows an English reader first; Monster Hunter Wilds
  is 71% there against 53% in all languages), else `summary_filtered` (all languages); a score is taken when Steam shows one (`review_score` > 0, about ten reviews). `steamAppFor`: the game's
  own app (`artIdsOf`), else `steamTags.appId` or a 'steam-match' `storage.steamAppId`. 2. IGDB for the rest (its
  credentials set and not refused; otherwise a miss keyed `|no-igdb`), through the scraper's own
  `igdbScraper.query` (Twitch token, 401 retry, the shared 4 req/s `igdbLimiter`): the IGDB id read before under
  the same key; the Steam app through `external_games` (`uid` and `external_game_source = 1` on one row; 400 apps
  per query, a full answer split and asked again; `bestOfLinked`: a main game, then one with a rating, then the most
  ratings); `metadata.sources.igdb`, 400 per query; else a title search on the game's IGDB platform through
  `pickIgdbMatch` (HLTB's title similarity, alternative names, the year rule; main game types first); IGDB's
  `rating` rounded. An answer whose game changed key mid-pass is dropped (read by its new key next pass). Refused
  credentials stop IGDB until they change; another HTTP 400 marks that title as not found; three other failures in a row (Steam or IGDB) pause 15 minutes, two pauses end the pass, except that
  Steam giving up (or refusing with a 4xx other than 429) only ends the Steam part: the games it was not asked about
  stay due and IGDB carries on with the rest. Progress: 'ratings:progress' (stage 'steam' |
  'igdb', throttled to two a second, total 0 at the end) for `components/ScanBars.tsx`; info log lines for the Steam
  summary, the IGDB lookups, every 100 title searches, a stop and the end. The game page shows it
  (`formatReviewScore`: '93%' for Steam, '84' for IGDB; `reviewScoreLabel`: 'Steam' / 'IGDB', kept short so the score fits beside Main story on 16:10 with an install size) after Main story. MobyGames scores,
  IGDB's own rating field and Backloggd ratings were replaced: `LibraryStore` drops `metadata.moby`,
  `metadata.igdbRating` and `metadata.backloggdRating` on load, and `SettingsStore.load` rewrites a settings.json
  that still holds a `mobygames` key.
- `launchbox-players.ts`: how many players a game takes, in `metadata.localPlayers` (`max` = LaunchBox's MaxPlayers,
  `coop`, `launchboxId`). `createLocalPlayers` (main/index.ts: after the startup rescan and on `library:changed`
  except sessions and removals) keeps `userData/launchbox-players.json`: built from LaunchBox's public
  `Metadata.zip` (gamesdb.launchbox-app.com, ~110 MB, refreshed daily upstream), downloaded at most once a month
  (`LAUNCHBOX_INDEX_TTL_MS`; a failure waits 6 h), its `Metadata.xml` (~520 MB) streamed out of the zip
  (`findZipEntry`, raw inflate; no zip64) through `createMetadataXmlReader` (complete `<Game>` /
  `<GameAlternateName>` blocks per chunk; games without MaxPlayers dropped): ~140k games, ~15 MB; the zip is
  deleted. The lookup (`createLookup`) indexes Steam apps (the Windows entry first) and names only for the LaunchBox
  platforms the library uses (`launchBoxPlatforms`: platform-ids.json names, which mostly are LaunchBox's, plus a
  table for the others; PC = Windows, MS-DOS, Windows 3.X), so the whole database's ~60 MB of names is not held.
  `matchLaunchBox`: the Steam app (`steamAppFor`), else the title, its edition-less form and the game of a "Game +
  Add-on" title on any of the game's platforms, the release year closest among several. Only changes are written.
  Progress: 'players:progress' (download bytes, then bytes of the XML read). The game page shows the count at the
  top left (`GameDetail.tsx` `PlayersBadge`) only from 1 to 8 (`lib/localPlayers.ts`: LaunchBox's count includes
  online players for some games).
- `image-cache.ts`: downloads to `userData/media/<gameId>/<kind>.<ext>` (screenshots `screenshot-N.ext`), returns
  `media://<gameId>/<file>?v=<mtime>` URLs, copies local files for `localMedia` / `customMedia`, dedupes concurrent downloads.
  Downloads of API-hosted media (ScreenScraper `mediaJeu.php`) go through the scraper's `MediaPolicy` (gate + rate
  limiter), so image fetches count against the same quota as the scraper's own requests. `importLocal` keeps the
  source file's extension (`.webp` from GOG Galaxy, `.png` under a `.jpg` name is re-labelled from the sniffed
  format), and `importRemote` treats a 404 as a plain `null` without retries so a direct-URL miss costs one request.
  The retry count and timeout come from the `MediaPolicy` (default 3 retries / 45 s for API-hosted media; the cover
  lane passes `retries: 0`, 10 s, and an `onNetworkError` hook for its host budget). A file is written as tmp +
  rename first and the other extensions of the kind are removed only afterwards, so a failed write leaves the file
  `media[kind]` points at in place. `importCustom` copies the user's own art as `custom-<kind>.<ext>`, which the
  scraped writes and `remove(gameId, kind)` never touch (`remove(..., { custom: true })` deletes it).

#### Art pipeline (cover lane, local art caches, direct URLs)

Why it exists: an owned-library import of 3,000 games used to show its last cover after 34 min (store CDN art, 4
workers, covers interleaved with heroes and logos) or after 2.9 h when the queue had to find them (every game paid
the text chain first: Steam appdetails at 1 req / 2 s, IGDB, TheGamesDB, then 5 SteamGridDB requests, two games at a
time), while this PC's Steam `librarycache` already held a portrait cover for 44-53 % of those games and GOG Galaxy's
webcache one for every game of its six connected stores (`docs/research/metadata-apis.md` §13). Covers are what the
grid needs first; everything else can follow. The numbers come from
`src/main/scrapers/metadata-service.bench.test.ts` (`npm run bench:art`, §7).

**One entry point.** Installed scans (§4.3) and owned imports (§4.8) both call
`metadata.enqueue(gameIds, options)` and nothing else; `accounts/index.ts` `importArt` and `scan-service`
`importLocalMedia` are removed, so there is one scheduler for every art download in the app.

```ts
export interface EnqueueOptions {
  force?: boolean // re-run both lanes for games already 'done' (Refresh, custom art cleared)
  /** Art the caller already knows (provider localMedia paths, store coverUrl/heroUrl/...): consumed first, no lookup. */
  seeds?: ArtSeed[]
  /** Run the cover lane only (autoScrape off): seeds + local caches, no direct URLs, no SteamGridDB, no full lane. */
  coverOnly?: boolean
  /** Touch no network at all (the --art-bench probe): seeds with a path and local caches only. */
  offline?: boolean
}
export interface ArtSeed {
  gameId: string
  kind: ArtKind
  path?: string // absolute file (ScannedGame.localMedia)
  url?: string // remote (MergeOwnedResult.remoteMedia); Steam seeds get the CDN fallback chain below
}
```

`enqueue` accepts a game when it is not already queued and (`force` or `metadataStatus !== 'done'` or a seed names
it; a `done` game named by a seed runs only the seed step). Accepted games get `metadataStatus: 'pending'` in one
`library.setMetadataStatusBatch(ids, 'pending')` (one `library:changed`, not one per game) and enter **both** lanes:

| lane                      | what it does per game                                                                                                                                                                      | concurrency                                                                                                                                                                                                                                                                                                                  | runs                                                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cover` (`cover-lane.ts`) | lands **one cover** from, in order: seeds -> local caches -> direct URLs -> SteamGridDB (search only when no platform id)                                                                  | cover-lane games 16 in flight (`COVER_CONCURRENCY`), downloads 8 (`COVER_DOWNLOADS`, through the image cache with no retries and a 10 s timeout for direct / seed URLs, plus a per-host failure budget; API-hosted URLs keep their `MediaPolicy`), SteamGridDB / IGDB / Xbox batched calls within the scrapers' own limiters | always first; drains before the full lane starts                                                                                                                                                |
| `full` (`processGame`)    | text chain -> remaining art kinds (deferred seeds, local caches, direct sources, then `artPriority` scrapers) -> HLTB -> status `done` / `failed`, written in **one** transaction per game | `FULL_CONCURRENCY = 3`                                                                                                                                                                                                                                                                                                       | only while `coverLane === 0`, or once the cover lane's network stage has run for `FULL_LANE_WAIT_MAX_MS` (10 min); a new `enqueue` pauses it again (in-flight games finish, no new game starts) |

The cover lane runs in two stages (`CoverLaneStage`): every queued game goes through the **local** stage first
(path seeds and local caches, zero network) and only a game the local stage could not cover is pushed to the
**network** stage (URL seeds, direct URLs, SteamGridDB), which fills the slots the local stage leaves free. That is
why every locally available cover lands in the first second of a 3,000-game run instead of waiting behind downloads.

Cover lane, step by step (`cover-lane.ts` `runCoverLane(game, ids, options)`), stopping at the first landed cover:

1. **Seeds** for the game: a `path` seed is copied with `imageCache.importLocal` after `image-sniff.ts` accepted it
   for its kind (a `librarycache` path from `providers/steam.ts` is store-client art and is skipped when
   `scrapers.localArt` is off); a `url` seed is downloaded with `importRemote`. Path seeds of every kind land here
   (cover first, then hero, logo, icon: zero network); of the URL seeds only the **cover** lands in the cover lane
   when the full lane follows (`deferExtras`), the hero / logo / icon URLs are landed by the full lane's
   `fillKinds` with the same seeds, so the 8 download slots of a 3,000-game import serve covers first. A
   `coverOnly` / seed-only job (no full lane) lands all its seeds here. A Steam cover seed that 404s falls through
   `library_600x900_2x.jpg` -> `library_600x900.jpg` (300x450, accepted) before giving up; a GOG
   `_glx_vertical_cover` 404 falls through to `boxArtImage`; Epic `DieselGameBoxTall` to `OfferImageTall`. A seed
   or direct URL that answered 404 is remembered in `metadata.sources['art:<kind>:missing']` (up to 8 URLs per
   kind, written through the media batcher): `mergeOwned.collectMedia`, `enqueue` and the lane skip it on every
   later import and start (the Steam owned list is re-imported at each launch), a landed file of the kind clears
   it, and `force` (Refresh) retries it.
2. **Local caches** (`settings.scrapers.localArt`, default true): `localArt.lookup(game, ids, ['cover'])` over the
   registry below; the first accepted candidate is copied. Zero network. The registry's per-source index is built
   on the first lookup of a run (one `readdir` / one index-file parse per source, never a `stat` per game) and
   dropped when both lanes drain **and** at every `enqueue` that starts a new batch while the cover lane is idle
   (`resetLocal`), so a scan or import during the hour-long full lane sees the files Steam has written since.
3. **Direct URLs** (skipped with `coverOnly` / `offline`): `directArt.candidates(batch, ['cover'], settings)` over
   the list below; URLs are tried best first with optimistic GETs (no HEAD), a 404 is one cheap request and means
   "next candidate", at most 4 URLs per game. Downloads of direct and seed URLs use `retries: 0` and a 10 s
   timeout (`DIRECT_DOWNLOAD_POLICY`; a miss is a miss, the full lane's `artPriority` chain is the retry), and a
   host whose downloads failed at the network level (DNS, reset, timeout: no HTTP status) `HOST_FAILURE_BUDGET`
   (8) times in a row is skipped for the rest of the run, so a dead CDN costs seconds, not hours of held slots.
   A source is only asked when `hasIdFor(ids)` holds (a Steam game never waits in the Xbox collector). Template
   sources (`batchSize: 1`) answer at once; batch sources (SteamGridDB 50, IGDB 500, Xbox 20) collect the games
   that reach them within 100 ms and fill the rest of the batch from the queue behind the game in hand
   (`Lookahead`: the service hands over the next queued games the source has an id for), memoising every answer
   (hits and misses) so the looked-ahead games skip the collector when their turn comes: a 3,000-game run makes
   ~60 SteamGridDB platform requests per kind, not one per game.
4. **SteamGridDB search** (`steamgriddb.search` + one `grids` request, only with a key and only for games no
   platform id reached): the single searching source in the lane. The memoised result records that it was fetched
   for `['cover']`; the full lane completes it with one more `fetch` for the kinds still missing, from the same
   candidate (no second search).

A landed cover is written through the media batcher (below) with `metadata.sources['art:cover'] = <ArtSourceId>` so
the detail panel's gear menu can attribute it; a cover that landed as 300x450 (Steam's local / fallback size) is
recorded in `metadata.sources['art:cover:quality'] = 'small'` and the full lane's art pass replaces it with a
`_2x` / SteamGridDB 600x900 one when one exists. Games the lane could not cover are left to the full lane's
`artPriority` chain (name search), which runs only after every cover candidate in the library was tried.

Full lane rules that keep the two from fighting: before every download `fillArt` re-reads
`library.getGame(id).media[kind]` and asks `mediaBatcher.has(id, kind)` (pending but not yet flushed), so a kind the
cover lane landed is never downloaded twice; for the other kinds (hero, logo, icon, screenshots) it lands the job's
deferred seeds, then asks the local registry (`lookup(game, ids, kinds)`) and the direct sources before the
`artPriority` scrapers, and a SteamGridDB `fetch` requests only the kinds still missing. The text chain's results,
the art sources, HLTB and the final status are written in **one** `applyMetadata` per game (`quiet`, announced
through the coalesced `library:changed` below) instead of one write per scraper. A name search's result is chosen by
`candidate-match.ts` `pickCandidate`: of the results about as close to the title as the closest, those that are the
title word for word, of them the game's own record before an edition's ("X" before "X - Limited Edition", which IGDB
lists as a game of its own with `version_parent`; `igdb.ts` also sorts those behind; an edition is still taken when
the game's year or console speaks for it and against the own record: "Metro 2033" of 2014 is "Metro 2033 Redux"), of them the ones the source
lists on the ROM's console (`MetadataCandidate.platformIds` against the source's id of the folder's system), and of
them the one released closest to the game's year; while no year is known, the first one from the console's years
(`platform-ids.json` `years`, `platformYearsFor`: "SSX" in a ps3 folder is the 2012 game; two same-titled games
that both fall in a console's years, "SSX" of 2000 and 2012 for the ps2, are left to the source's order until a text
source gives the year and `rematchByYear` matches again). Among results of the game's very title, one dated years
from the game's year, or outside the console's years, loses to one without a date when no dated one fits (SteamGridDB
has no date for many newer games). The console only chooses
among same-titled results and only for ROMs. After an update to `NAME_MATCH_RULES` 5, `recheckConsoleMatches` (once,
after the startup rescan, auto-scrape on) scrapes again, forced, only the ROM games whose recorded IGDB record is
the game's title plus edition words the ROM does not have (`Scraper.recordsOf`: one IGDB request per 500 games) or
whose SteamGridDB art is from a same-titled game of another year while SteamGridDB has one of the game's own year
(`yearOf`: one request for each ROM game with SteamGridDB art and a year, a search only on a mismatch); every other
game is marked as checked as it is answered, a game the user identified is skipped; the SteamGridDB pass stops after
three requests it did not answer (the rest is asked next start). A flagged game carries
`metadata.rematch` (the source) in the library file until a forced run is through in which IGDB and SteamGridDB both
answered and SteamGridDB's art landed, and `enqueue` forces any run of a game that carries it, so a quit or a failing
source cannot leave half of the wrong match in place; a forced run that did not get through is recorded
(`metadata.rematchTried`) and repeated only after `failedRetryDelayMs` of its count (`rematchHeld`), not on every
start. That run asks SteamGridDB before its art step and drops the recorded game's art and id when SteamGridDB's game
is another one (`replaceSteamGridDbMatch`), so a kind the right game lacks is not left on the other game's picture.
`apply` takes a queued or running job of the game out of force and lets it write nothing (`userPicked`). A forced run's text is merged so that every field a source of that run has replaces the stored one. User-chosen custom art is never
overwritten by a download that was in flight when the user chose it: `setMediaBatch` and the lane's `land` skip a
kind named in `user.customMedia`, and the custom copy lives under `custom-<kind>.<ext>` in the cache, a name the
scraped `<kind>.<ext>` writes and removals never touch. `apply(gameId, candidate)` (the user picked a search result)
keeps the full-lane path unchanged and writes at once; `search` is unchanged.

**Ids** (`art-ids.ts` `artIdsOf(game): ArtIds`): collected once per game from `source` + `externalId`
(`steam` -> `steamAppId`, `gog` -> `gogProductId`, `epic` -> `epicAppName`, `ea` -> `eaOfferId`, `xbox` ->
`storeId`, `battlenet` -> product code, `ubisoft` -> `ubisoftId`), `Game.extra` (the keys the providers and
importers already write: `steamAppId`, `gogProductId`, `epicNamespace`, `epicCatalogItemId`, `epicAppName`,
`eaOfferId`, `storeId`, `titleId`, `uid`, `ubisoftId`) and `metadata.sources` (`steam`, `gog`, `igdb`,
`steamgriddb`), so a GOG or Epic game that a scraper matched to a Steam appid is looked up in the Steam caches too.
ROMs carry `romSystemId` + `romName` for ES-DE / Playnite folders.

**Local sources** (`scrapers/local-art/`, contract `LocalArtSource` in `scrapers/types.ts`, registry
`createLocalArtRegistry({ settings, log }): { lookup(game, ids, kinds), reset(), sources }` in `index.ts`; the
exact on-disk layouts, the index files and the dimension rules are in `docs/research/metadata-apis.md` §13):

| id               | file                | reads                                                                                                                                                                                                                                                                                                                                                                                                                        | keyed by                                                                                                   | kinds                         |
| ---------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `steam-cache`    | `steam-cache.ts`    | `<Steam>\appcache\librarycache\assetcache.vdf` (binary KeyValues: section `"0"` -> `<appid>` -> `0f` cover, `1f` hero, `2f` logo, `3f` header, `4f` icon; paths relative to `librarycache\<appid>\`, hashed sub-folders included) and, when the file is absent or lists a missing file, the folder walk `providers/steam.ts` `findLibraryCacheArt` already does (extended to `library_capsule.jpg` and `library_header.jpg`) | `steamAppId` (installed, owned or matched)                                                                 | cover, hero, logo, icon       |
| `galaxy-cache`   | `galaxy-cache.ts`   | `%ProgramData%\GOG.com\Galaxy\webcache\<userId>\{steam,epic,gog,origin,xboxone,battlenet}\<externalId>\<sha256>_glx_{vertical_cover,bg_top_padding_7,square_icon_v2}.webp` (one `readdir` per platform folder; `galaxy-2.0.db` is not opened)                                                                                                                                                                                | `steamAppId`, `epicAppName`, `gogProductId`, `eaOfferId`, `xboxStoreId` / numeric Xbox id, `battlenetCode` | cover, hero, icon             |
| `esde-media`     | `esde-media.ts`     | `<ES-DE home>\downloaded_media\<system>\{covers,marquees,screenshots,fanart}\<romname>.{png,jpg}` and gamelist `<image>` / `<thumbnail>` (`settings.library.esdeHome`)                                                                                                                                                                                                                                                       | `romSystemId` + `romName`                                                                                  | cover, logo, screenshot, hero |
| `playnite-files` | `playnite-files.ts` | `%APPDATA%\Playnite\library\files\<gameId>\*` with `library\games\*.json` for the store-id -> gameId map (only when Playnite is installed)                                                                                                                                                                                                                                                                                   | store ids                                                                                                  | cover, hero, icon             |

Every source implements `isAvailable` (the client / folder exists on this PC; false removes the source for the run),
`index` (memoised), `reset` and `lookup`, returns only files that exist and passed `image-sniff.ts`
(`sniffImage(path)` reads the first 64 KiB: JPEG SOF, PNG IHDR + colour type, WebP VP8/VP8L/VP8X, ICO; no native
module), and never trusts a file name's stated size (`library_600x900.jpg` is 300x450 on disk). Quality rules
(`acceptsKind(kind, info)`): cover = portrait, `w/h` in 0.60-0.75, `h >= 400` (300x450 accepted as `small`, 460x215
headers rejected); hero = `w >= 1200` and `w/h >= 2.4` (16:9 screenshots accepted only as a fallback hero);
logo = PNG / WebP with alpha at `w >= 128`, `h >= 32` in any shape (Steam's `2f` slot holds 360x360, 354x140 and
167x360 logos next to the 640x360 norm: 76 of the 4,687 on this PC are narrower than 400), an opaque `logo.png`
only at `w >= 400`, `h <= w`; icon = square `<= 256`. Steam's `library_hero_blur.jpg`, `markers.svg` and the square
`7f` art are never candidates. `esde-media` keys by `ArtIds.romName`, which `art-ids.ts` already stripped of its
extension ("Super Mario Bros. (World)"), so names with a dot in them match; `playnite-files` keys records by
(`PluginId`, `GameId`) with Playnite's library plugin GUIDs, because `GameId` is only unique per plugin (an itch.io
game with id 2823 must never supply Steam appid 2823's cover).

**Direct sources** (`scrapers/direct-art/`, contract `DirectArtSource`; URL facts and measured sizes in
`docs/research/metadata-apis.md` §5.2, §7, §8 and the direct-sources notes of §13):

| id                     | file                      | needs              | candidates (cover first)                                                                                                                                                                                                                                                                                   | batch                                 |
| ---------------------- | ------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `steam-cdn`            | `steam-cdn.ts`            | nothing            | `https://cdn.cloudflare.steamstatic.com/steam/apps/<appid>/library_600x900_2x.jpg` -> `library_600x900.jpg`; hero `library_hero.jpg`; logo `logo.png`                                                                                                                                                      | 1                                     |
| `gog-images`           | `gog-images.ts`           | nothing            | the stored `row.image` hash or `gamesdb.gog.com/platforms/{gog,steam,origin,uplay}/external_releases/<id>` `vertical_cover.url_format` with `_glx_vertical_cover` + `jpg` (342x482); hero `_1600`; `api.gog.com/v2/games/<id>` `boxArtImage` last                                                          | 1 (gamesdb: 1 JSON per game)          |
| `epic-catalog`         | `epic-catalog.ts`         | nothing            | `keyImages` from the owned import (`DieselGameBoxTall` -> `OfferImageTall`, `?w=600&h=900&resize=1`) and, offline, the same from `%ProgramData%\Epic\EpicGamesLauncher\Data\Catalog\catcache.bin` (base64 JSON, indexed by `id` and `releaseInfo[].appId`); hero `DieselGameBox`, logo `DieselGameBoxLogo` | 1                                     |
| `xbox-catalog`         | `xbox-catalog.ts`         | nothing            | `displaycatalog.mp.microsoft.com/v7.0/products?bigIds=<storeId,...>&market=US&languages=en-US` -> `Images[ImagePurpose == 'Poster']` + `?w=600&h=900&mode=scale&q=90`; hero `SuperHeroArt`, logo `Logo`                                                                                                    | 20                                    |
| `steamgriddb-platform` | `steamgriddb-platform.ts` | SteamGridDB key    | `GET /grids/{steam,egs,origin,bnet,uplay}/<id,id,...>?dimensions=600x900&types=static&nsfw=false&humor=false&epilepsy=false` (top voted grid per game, 207 on partial errors); `/heroes`, `/logos`, `/icons` likewise for the full lane                                                                    | 50, within `steamgriddb.ts`'s limiter |
| `igdb-external`        | `igdb-external.ts`        | Twitch credentials | `fields cover.image_id,external_games.uid; where external_games.uid = (...) & external_games.external_game_source = 1; limit 500;` or `where id = (...)` for stored `metadata.sources.igdb` -> `images.igdb.com/.../t_cover_big_2x/<image_id>.jpg`                                                         | 500, within `igdb.ts`'s limiter       |

Order in the cover lane: `steam-cdn`, `gog-images`, `epic-catalog`, `xbox-catalog`, `steamgriddb-platform`,
`igdb-external`; the full lane uses the same list for the other kinds. Every request goes through `http.ts`
(`redactUrl` in logs); CDN hosts have no limiter, API hosts keep the scraper's.

**Library writes** (`media-batch.ts` `createMediaBatcher(sink, { intervalMs: 250 })` ->
`{ add({ gameId, kind, url, source } | { gameId, kind, missing }), has(gameId, kind), flush(), dispose() }`): landed
art is flushed through `library.setMediaBatch` at most once per 250 ms, the first item of a quiet period at once
(the first cover of a run is visible without waiting for the window to close); there is no item cap, because the
local stage lands ~1,000 covers a second and a cap flushed every ~25 ms, which the renderer's trailing debounce
never got to act on. `setMediaBatch` also records the `metadata.sources['art:<kind>']` attribution and the
`art:<kind>:missing` memo in the same transaction and skips kinds with custom art. Status changes use
`setMetadataStatusBatch`; the full lane writes each game once. Every write of the metadata service (batcher flushes
and full-lane games alike) is announced through one coalesced `library:changed { reason: 'metadata', gameIds }`
per 250 ms window (the first after a quiet period goes out at once), carrying the union of the games that changed,
so the renderer sees at most ~4 small events a second instead of 4-6 per game for an hour. The renderer
(`state/library.ts`, `lib/changeCoalescer.ts`) debounces those events with a maximum wait (fire 150 ms after the
last event, no later than 500 ms after the first) and, when an event names at most 50 games, fetches only those
(`getGame`) and patches them in (`applyGames`) instead of refetching the 3,000-game snapshot; an event without ids
or a larger one still refreshes everything. `library.json` is written by `JsonStore` with a 400 ms debounce
**and** a 3 s maximum wait (§4.2), so a run that sets media every 250 ms for minutes still persists every few
seconds.

**Progress** (`'metadata:progress'`, `MetadataProgress` in `shared/types.ts`): `{ gameId, status, remaining,
message?, lane, queued, coverLane, fullLane, done }` where `queued` = games accepted and not finished by both lanes,
`coverLane` / `fullLane` = games each lane still has to look at (waiting + in flight; the full lane's count includes
the games paused behind the cover lane), `done` = games finished by both lanes since the queues were last empty, and
`remaining` = `queued` (kept for the mock and older listeners). Emitted once per `enqueue`, then coalesced with the
batcher's flush (at most every 250 ms) and once more when both lanes drain (`queued: 0`). The renderer
(`state/library.ts`) keeps the latest payload; the Library header's count line appends "· fetching covers
1,234 left" while `coverLane > 0` and "· fetching details N left" while only `fullLane > 0`; no toast, no new component.

**Art progress** (`'art:progress'`, `ArtProgress { stage: 'cover' | 'art', done, total }` in `shared/types.ts`,
`scrapers/art-progress.ts`): the bottom bar of the art downloads. `'metadata:progress'` is not reused for it: it
fires per full-lane game, and its `done` counts games through both lanes, so a cover count derived from it would
sit near zero for the hour the full lane takes. The tracker reads each stage's remaining games when it reports
(stage 'cover' = `coverLaneSize()`; stage 'art' = the full lane's waiting games plus those in flight whose
`fillArt` has not returned) and counts the games through each stage (`finished`: a cover-lane game covered or
given up on, not one moved to the network stage; a full-lane game past `fillArt`, or removed / failed before it);
`total` = done + remaining, so games queued mid-run grow it, and a stage's count restarts when it drains. The cover
stage is shown while it has games, then the art stage; total 0 = idle. Reports go out at most every 250 ms, except
that a run starting (the `enqueue`) or ending is reported at once. The renderer keeps the payload as
`state/library.ts` `artScan`; `lib/scanBars.ts` `artScanBar` labels it "Downloading cover art · n of m" /
"Downloading game art · n of m" at the top of `components/ScanBars.tsx`'s stack. The browser mock reports its
one-queue scrape as the cover stage, and `?mock=1&bars=1` runs a cover pass then an art pass beside the other bars.

**Settings**: `scrapers.localArt: boolean` (default true, `settings-schema.ts`, Settings > Metadata toggle "Use art
from installed store clients": "Reuse covers that Steam, GOG Galaxy and Epic already downloaded to this PC before
fetching anything."); `scrapers.artPriority` is unchanged and orders the full lane's scrapers only. `autoScrape`
off still lands seeds and local art (`coverOnly`).

**Acceptance** (checked by `npm run bench:art`, simulated clock, stub scrapers with the real limiter costs, 60 %
Steam / 20 % Epic / 20 % GOG, 44 % of the Steam games with a local cover, 92 % of the rest on the CDN):

| library                    | first cover (cold index) | every locally available cover | downloaded covers                                 | every cover                                                                    | all done                                                    |
| -------------------------- | ------------------------ | ----------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| 3,000 games (owned import) | < 2 s                    | < 10 s                        | >= 6 covers / s (8 downloads in flight at 150 ms) | < 10 min, before the first text scrape of the full lane finishes for the batch | may take an hour or more (text, HLTB); unchanged acceptance |
| 300 games                  | < 2 s                    | < 2 s                         | >= 6 / s                                          | < 1 min                                                                        | -                                                           |

Both rows are asserted for the scan **and** the owned-import scenario (the owned import is the primary case). The
simulated local index costs its measured cold 1,060 ms, so "first cover" is a bound the model can miss. Measured
(2026-11-02, final build, `npm run bench:art`): owned import of 3,000 games: first cover 1.1 s, every local cover
2.3 s, 90 % of covers 42.8 s, every cover 48.3 s (48.5 downloaded covers / s), first game fully done 55 s, all done
94.5 min, SteamGridDB 2,497 requests for the whole run (was ~15,000 with the grid-only fetch, the kind-aware memo
and the screenshot skip missing), one `library:changed` per 250 ms window at most (peak 5 / s); 300 games: first
cover 1.1 s, every cover 5.8 s, all done 9.5 min. The "before" column of the bench's tables (34 min / 2.9 h /
3.4 h) is the recorded profile the contract was written against, not a re-run.

Real probe on this PC (`npm run scan-art-bench`, no network, no sign-in): the 9,750 Steam appids present in
`librarycache` that are **not** installed must yield >= 5,100 covers (the survey counted 5,190 portrait files) in
<= 15 s cold, first cover <= 2 s cold, plus 39 of the 40 installed appids; the GOG Galaxy webcache must add its
covers for every Steam appid the Steam cache lacks (10 here). Measured (2026-11-02), **cold** (first run after boot,
16:05): 5,200 covers for the 9,750 owned-not-installed appids (steam-cache 5,190 + galaxy-cache 10) in 10.8 s, first
cover 1,113 ms, registry index 1,060 ms; **warm** (file cache holding the ~10,000 headers, final build, 17:24): 5,203
covers for 9,753 appids in 5.4 s, first cover 65 ms, index 47 ms (assetcache.vdf + 9,790 folders in ~28 ms, Galaxy
4,395 entries in 12 ms), merge of the 9,790 owned records 12 ms; installed 40 appids, 39 covers in both. The
report's `warm` flag says which kind a run was. Real-mode end-to-end (`--scan`, fresh profile, every source enabled, no sign-in): the
scan of all sources took 8.4 s, the cover lane drained 851 ms after the scan ended, and all 43 installed games had a
cover (steam-cache 36, galaxy-cache 3, steam-cdn 2, xbox-catalog 2; SteamGridDB skipped without a key).

### 4.7 System (`system/*`)

- `powershell.ts`: `runPowerShell(script, { timeoutMs, json: true })` (`-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command`),
  serialized through a small queue; `registry.ts`: `readKey(hive, path, { view: 'x64' | 'x86' })` via `reg.exe query`,
  `listSubkeys`, parsed into `{ values: Record<string, string | number>, subkeys: string[] }`.
- `status.ts` polls every 15 s (battery, network, Bluetooth, volume, brightness, power mode) and pushes `system:status`;
  the renderer also reads `navigator.getBattery()` for instant battery updates.
- Controls: `volume.ts` (CoreAudio via PowerShell Add-Type), `brightness.ts` (WMI), `power.ts` (powercfg overlay
  schemes, shutdown/restart/sleep), `windows-settings.ts` (`ms-settings:` URIs), `perf.ts` (CPU/RAM via Get-Counter/CIM).
  Exact commands: `docs/research/electron-stack.md`.
- Launch at login (`ipc/handlers.ts` `updateSettings`, `system.launchAtLogin`):
  `app.setLoginItemSettings({ openAtLogin, path: process.env.PORTABLE_EXECUTABLE_FILE ?? process.execPath, args: ['--autostart'] })`.
  The `path` is mandatory: the portable target's stub extracts PlayOut to `%TEMP%\nsXXXX.tmp\app\PlayOut.exe` and deletes that folder on exit, so
  registering `process.execPath` (Electron's default) leaves a dead `HKCU\...\Run` entry; electron-builder sets
  `PORTABLE_EXECUTABLE_FILE` to the real stub exe (same mechanism as `PORTABLE_EXECUTABLE_DIR` in §4.4). `getSettings`
  reports reality, not the stored flag: on a packaged win32 build it reads `app.getLoginItemSettings({ path, args })` with
  the same path/args (Electron requires identical arguments) and, if `openAtLogin` differs from the stored
  `system.launchAtLogin`, persists the real value before returning, so Settings > System shows the toggle off when the
  Run entry is missing or stale.

### 4.8 Accounts (`accounts/*`) and installs (`installs/*`)

Store-by-store facts (login URLs, redirect capture, endpoints, install URIs, progress sources, what is unverified)
are in `docs/research/store-accounts.md`; its feasibility table decides `AccountStatus.supported` per store:
Steam, Epic, GOG, Xbox, Battle.net and EA import owned libraries; Ubisoft Connect is `supported: false` with the reason
"Ubisoft does not offer a sign-in that PlayOut can use; your owned games come from the Ubisoft Connect client."

**Module layout** — `src/main/accounts/{index.ts, auth-window.ts, token-store.ts, types.ts, steam.ts, epic.ts, gog.ts,
xbox.ts, battlenet.ts, ea.ts, ubisoft.ts, <store>.test.ts}` and `src/main/installs/{index.ts, tracker.ts, queue.ts,
<store>-progress.ts, *.test.ts}`. `accounts/types.ts`:

```ts
export interface StoreAccount {
  source: StoreSourceId
  supported: boolean
  reason?: string // user-facing, when !supported
  /** Open the store's sign-in page in the auth window and capture the credential; null when the user closed it. */
  signIn(win: AuthWindow): Promise<AccountTokens | null>
  /**
   * Refresh or re-mint the credential; null only when the store said the session is dead (status becomes "not signed
   * in"). A timeout, network failure or 5xx throws (StoreUnavailableError / HttpError): the credential is kept.
   */
  refresh(tokens: AccountTokens): Promise<AccountTokens | null>
  displayName(tokens: AccountTokens): Promise<string | undefined>
  fetchOwned(tokens: AccountTokens, ctx: { settings: Settings; log: Logger }): Promise<OwnedGame[]>
  /** The install form of the game's launch: a protocol URI or a client command line; null when the game cannot be installed through the client. */
  installSpec(game: Game, client: ClientInfo): InstallSpec | null
}
export type InstallSpec =
  | { kind: 'uri'; uri: string }
  | { kind: 'exec'; file: string; args: string[]; followUpUri?: string; followUpDelayMs?: number }
```

Steam's `StoreAccount` supports two credentials: the web sign-in (cookie session of the auth window's partition +
the `webapi_token` scraped from `store.steampowered.com`'s `application_config`) and the API key + SteamID64 already in
`settings.scrapers.steam`; when both exist the web token is used and the key is the fallback, when only the key exists
`displayName` is `<persona> (API key)`, so the status row reads "Signed in as <persona> (API key)" and
`AccountStatus.viaSettings` is true (the row has no Sign out). Display names come from the store where the research has an endpoint
(Steam, Epic, GOG, Xbox); Battle.net shows `Account <accountId>` from its `/api/` answer and EA has none (the row
reads "Signed in as you").

**AccountsService** (`accounts/index.ts`), constructed in `index.ts` after `scan` and after the main window exists:

- `getAccounts(): AccountStatus[]` in `STORE_SOURCES` order; `AccountStatus { source, supported, reason?, signedIn,
displayName?, lastImportAt?, lastImportCount?, importing, viaSettings?, error? }`. `viaSettings` marks Steam's
  API-key credential from Settings > Metadata: the row shows "Key set in Settings › Metadata" instead of Sign out,
  and `signOut` of that credential alone rejects with a message pointing there (the key is not the service's to
  delete; removing the owned games would only last until the next import).
- `signIn(source): Promise<AccountStatus>` opens the auth window and resolves when it closes: a captured credential
  is stored, `accounts:changed` is emitted and `importOwned([source])` is started (not awaited); a closed window
  without a capture resolves with `signedIn` unchanged. One auth window at a time (a second `signIn` rejects with
  "A sign-in window is already open").
- `signOut(source): Promise<AccountStatus>` bumps the source's generation counter (an import that started earlier
  writes nothing back when its `refresh` / `fetchOwned` returns: no `tokenStore.set`, no `mergeOwned`, no meta),
  closes the hidden loaders of that partition (`authWindows.closeHidden`), deletes the tokens, awaits the in-flight
  import, calls `session.fromPartition('persist:account-<source>').clearStorageData()` and, when no credential is
  left (`tokensFor` null), runs `library.mergeOwned(source, [])` so owned-only games are dropped and installed ones
  lose `owned`; with the API key still in Settings the games stay and the row stays signed in. A new `signIn` starts
  a new generation.
- `importOwned(sources?): Promise<ImportOwnedResult>` for the given signed-in supported sources (all of them when
  omitted); concurrent calls for the same source coalesce. Per source: `refresh` -> `fetchOwned` -> `library.mergeOwned`
  (with `keepIds` = the install service's tracked games) -> `registerPlatforms` of that store (the tab must exist
  even when nothing is installed) -> one `metadata.enqueue([...merge.newGameIds, ...seedIds], { seeds:
merge.remoteMedia, coverOnly: !settings.scrapers.autoScrape })` (§4.6 "Art pipeline"): the store's
  `coverUrl`/`heroUrl`/`logoUrl`/`iconUrl` for games without that media kind are the cover lane's seeds (covers
  first, 8 downloads in flight, Steam / GOG / Epic 404 fallbacks, library writes batched every 250 ms), the local
  caches and direct URLs cover the games whose seed failed, and the full lane fills text, HLTB and the other art
  afterwards. The service no longer downloads art itself (`importArt` and `ART_CONCURRENCY` are gone); the import is
  "done" once `enqueue` returned and the greyed cards exist, the art keeps landing in the background.
  `importing` is true for the duration and `accounts:changed` is emitted at
  start and end; `lastImportAt`/`lastImportCount` are persisted next to the tokens. Result:
  `{ sources: [{ id, imported, added, removed, error? }] }`. Only a `refresh` that returns null (the store said the
  session is dead) or a `SessionExpiredError` from `fetchOwned` after one more refresh drops the credential ("Session
  expired, sign in again"); a thrown `refresh` (offline, timeout, 5xx: `StoreUnavailableError` or the HttpError)
  keeps the tokens and the previous owned list and sets the row's error to "Could not reach <Store>", cleared by the
  next successful import. A `fetchOwned` that throws for any other reason (Steam's `{"response":{}}`, a failed Epic
  catalog batch) fails the import without touching the library: a partial or empty answer is never "owns nothing".
- Events: `'accounts:changed': AccountStatus[]` (sign-in, sign-out, import start/end, refresh failure);
  `'library:changed' { reason: 'import' }` once per `mergeOwned` that changed anything.
- `dispose()` closes an open auth window and flushes the token store.

**Auth window** (`accounts/auth-window.ts`): a modal child `BrowserWindow` of the main window (`parent`, `modal: true`,
`alwaysOnTop` while the main window is fullscreen, 600x760, focused on open; the main window re-takes focus when it
closes), `webPreferences: { partition: 'persist:account-<source>', sandbox: true, contextIsolation: true,
nodeIntegration: false }`, **no preload** (so `window.playout` does not exist there and `register.ts`'s sender check
would reject it anyway). It does not reuse `window.ts`'s `guardNavigation` or window-open handler: each store's
`AuthPage.allowedSites` (Steam `steampowered.com`/`steamcommunity.com`, Epic `epicgames.com`, GOG `gog.com`, Xbox
`live.com`/`microsoft.com`/`microsoftonline.com`/`msauth.net`/`xbox.com`, Battle.net `battle.net`/`blizzard.com`, EA
`ea.com`/`origin.com`) is enforced by `will-navigate`/`will-redirect` handlers that `preventDefault()` any other
https main-frame navigation (`isAllowedNavigation`), by the `setWindowOpenHandler` that allows popups on those sites
only (2FA), and again inside every allowed popup (`did-create-window`); popups are destroyed with the window. The
capture readers check the origin too: Steam reads `application_config` only on `store.steampowered.com`, Epic parses
the redirect JSON only on `www.epicgames.com/id/api/redirect`, and `loadJsonViaWindow` reads only a document on the
requested URL's origin (anything else counts as a login redirect), so a page the store did not render can never sign
PlayOut in to someone else's account. Capture happens through
`webContents` `will-redirect` / `did-navigate` / `did-redirect-navigation` and `session.webRequest.onBeforeRequest`
(and `onBeforeSendHeaders` for EA's bearer) filtered on the store's redirect URI, plus `executeJavaScript` reads of
documents the store rendered (Steam's `application_config`, Epic's redirect JSON, Battle.net's `/api/` JSON). The
capture code never logs URLs with codes/tokens (`redactUrl` from `scrapers/http.ts`). Gamepad input does not reach
the page: the store's card in Library Import says "Finish signing in in the window that opened".

**Token store** (`accounts/token-store.ts`): `userData/accounts.json` =
`{ version: 1, accounts: { [source]: { encrypted: string /* base64 of safeStorage.encryptString(JSON.stringify(tokens)) */, displayName?, lastImportAt?, lastImportCount? } } }`.
When `safeStorage.isEncryptionAvailable()` is false the tokens are stored as plain JSON under `plain` with one logged
warning. `safeStorage` is only usable after `app.whenReady()`, so the store decrypts lazily on first use; a blob that
fails to decrypt (DPAPI of another Windows user) is treated as signed out, never thrown. Token values are never
logged. Refresh tokens are handled per store (Epic/GOG/Xbox refresh tokens; Steam re-mints `webapi_token`; Battle.net
and EA re-mint from the partition's cookie session), always proactively before an import and once more on an
authentication error.

**LibraryService.mergeOwned(source, owned: OwnedGame[]): MergeOwnedResult** (one transaction, next to `mergeScan`):

- id = `makeGameId(source, externalId, STORE_PLATFORMS[source].id)`; duplicates within one import are skipped.
- Existing game: `owned = true`; `storePlaytimeMinutes` filled when missing or lower; `lastPlayed` only moves forward
  (`lastPlayedAt`); `extra` shallow-merged; `metadata.releaseDate/developers/publishers` seeded only while
  `metadataStatus === 'none'`. `installed`, `installDir`, `launch`, `tracking`, `title` of an installed game are not
  touched (the manifest wins); the title of an owned-only record may be refreshed.
- New game: `Game { installed: false, owned: true, launch: { kind: 'uri', uri: <the store's install URI form> }
(or the exec form for GOG/Battle.net), tracking: { mode: 'none' }, platformId: the store platform, media: {},
metadataStatus: 'none', user: {}, addedAt: now, extra }`.
- A game of this source with `owned === true` that the import no longer lists: `owned = false`; when it is also
  `!installed`, has no `installDir`, `playCount === 0`, no sessions, no user state (`favorite`, `hidden`,
  `user.titleOverride`, `user.customMedia`) and is not in `options.keepIds` (the tracked installs) it is **removed**
  (it existed only because of the account); everything else keeps its record with `owned` cleared and gets `owned`
  back on the next listing. Installed scans (`mergeScan`, `markMissing`) never clear `owned`.
- EA aliases: an owned game whose id is not in the library but matches an **installed** EA record through
  `extra.contentIds` (the provider's `;`-joined list of every content id in installerdata.xml) or the same
  `extra.eaOfferId` lands on that record instead of creating a second, greyed card.
- Returns `{ added, updated, removed, newGameIds, remoteMedia: { gameId, kind, url }[] }` (remote art for games whose
  `media[kind]` is empty); `updated` counts only records a field of which moved; emits
  `library:changed { reason: 'import' }` when anything changed.
- `setMediaBatch(items, { quiet? })` sets several media URLs in one transaction and one `library:changed { reason:
'metadata', gameIds }` (or none with `quiet`; it returns the changed ids), skips kinds with custom art and records
  negative items (`missing`) as `art:<kind>:missing`; `mergeOwned.collectMedia` leaves out URLs recorded there.

**InstallService** (`installs/index.ts`) and the tracker (`installs/tracker.ts`):

- `installGame(id): Promise<InstallResult>`: `library.requireGame(id)`; refuses an installed game ("already
  installed") and a game without an `installSpec` (`{ ok: false, error }`, e.g. games whose client is missing: every
  store's `installSpec`, Steam included, returns null when `client.installed` is false, so a protocol URI never lands
  in Windows' "pick an app" prompt). The spec is executed through the launcher's protocol path: URIs are checked
  against the allow-list of schemes (`steam:`, `com.epicgames.launcher:`, `goggalaxy:`, `origin2:`, `battlenet:`,
  `uplay:`, `msxbox:`, `ms-windows-store:`) before `shell.openExternal`, never on an unchecked string (EA uses the
  non-launching `origin2://game/download?offerId=<offerId>` whenever `extra.eaOfferId` is known, i.e. for every
  account-imported record, and `game/launch/?offerIds=<contentId>` only without it); exec specs spawn the detected
  client exe with an argv array (GOG `GalaxyClient.exe /gameId=<id> /command=installGame` +
  `goggalaxy://openGameView/<id>` 2.5 s later; Battle.net `Battle.net.exe --install --game=<uid>`). Then the tracker
  starts for that game. `trackedGameIds()` lists the watched games for the accounts service's `mergeOwned` guard.
- `cancelInstallTracking(id)`: ends the watch without a final `install:progress` event; the entry disappears from
  `getInstalls()`, the client keeps downloading and the next scan still picks the game up.
- `getInstalls(): InstallProgress[]`: every active watch, so a reloaded renderer restores its bars.
- `InstallProgress { gameId, source, state: 'starting' | 'queued' | 'downloading' | 'installing' | 'done' | 'failed' | 'unknown',
percent? (0-100 when measurable), bytesDone?, bytesTotal?, message? (user-facing: 'Installing through Steam…',
'Confirm the install in Steam'), startedAt, updatedAt }`; emitted as `'install:progress'` on every change, at most
  once per second per game.
- One watch per game (a second `installGame` for a tracked game re-sends the URI and keeps the watch). The probe is
  built **before** the hand-off (`probeFor` runs, then `execute`), so the GOG / EA log tails are anchored at the
  client log's current end (`createLogTail(file, { lookbackBytes: 0 })` + one read): lines the client wrote earlier
  about the same product (a previous install, an uninstall) never reach the new watch. The watch is the
  `session-tracker` skeleton (`setTimeout` re-arm, never `setInterval`): the store's `<store>-progress.ts` probe
  runs every 2 s for measured stores (Steam ACF in every library folder with the `steamapps\downloading\<appid>`
  folder as the pre-manifest fallback — `content_log.txt` is not tailed; GOG `GalaxyClient.log` job lifecycle with
  file counts — the `galaxy-2.0.db` / `jobs.db` fallback is not implemented; Battle.net `product.db`; EA
  `EADesktopVerbose.log`) and every 10 s for state-only stores (Epic `.item` + install-dir growth against
  `InstallSize`, Xbox `<drive>:\XboxGames\<Title>\Content` growth only — bytes written, no percent, no catalog size
  lookup and no `Get-AppxPackage` / AppInstallManager call, the confirming scan reports done; Ubisoft
  `Installs\<id>` + `uplay_install.state`, the InstallDir cached after its first registry hit); every 10 s (45 s
  for Xbox and Ubisoft, whose scans are PowerShell runs: `POWERSHELL_SCAN_MS`, `WatchOptions.scanMs`) the tracker
  also runs `scan.run([source], { reason: 'confirm' })` (coalesced per source, cached client detection, no
  `scan:progress`, no owned import) and the watch ends with `done` when `library.getGame(id)?.installed` is true
  **and** the last probe did not report `inFlight` (Steam sets FullyInstalled on a manifest mid-download —
  StateFlags 1030 / 1542, `buildid 0` — so `progressFromAcf` marks every result in flight while an update bit is
  set, the build id is 0 or the target build differs, and `providers/steam.ts` `isFullyInstalled` skips a manifest
  with an installing bit and `buildid 0`), which arrives in the renderer as `library:changed { reason: 'scan' }`
  (that is what turns the detail panel's Install button into Play without closing it). `fs.watch` is optional.
- Timeout: 30 minutes without any change (no bytes, no state line, no dir growth) -> `failed` with the message
  "Could not confirm the installation — check the <Store> client"; the renderer shows it as a toast. That plain rule
  is kept only for a watch the queue does not hold. Every InstallService watch is held by the install queue
  (`WatchOptions.holdWhenStalled`), and **once the store hand-off succeeded no timer ends a held watch**: the store
  may be downloading where PlayOut cannot see it, and moving on would start a second download next to it. A held
  watch ends only when the confirming scan says installed, when the store's own data says cancelled, or when the user
  removes the game from the queue. The one exception is `WatchOptions.expectStoreStart`, set only for a fresh (not
  resumed) watch with a probe of a store in `STORE_START_VISIBLE_SOURCES` (`installs/index.ts`: Steam — the
  appmanifest appears, queued or downloading; GOG — the `ProductInstall (<id>)` job in a log tail anchored at the
  hand-off; Battle.net — the uid's product.db entry or `active_installs` handshake; Epic — the AppName's `.item`
  manifest). Such a watch whose probe never showed the install (state still `starting`: the user did not confirm it
  in the store) ends `failed` after `TrackerTiming.unconfirmedMs` (10 min) with "<Store> did not start the install.
  Press Install to try again." (the queue moves on; the renderer's failed toast and Install/Retry apply as before).
  EA (log lines matched on loosely related offer ids and slugs), Xbox (an XboxGames folder matched on the title) and
  Ubisoft (the Installs registry key, whose id may differ from the library's) are not on the list, nor is any resumed
  watch or one without a probe: they start held. The last resort for every held watch is `TrackerTiming.heldTimeoutMs`
  (24 h): no observable change at all for that long (suspend time not counted; any change the probe sees starts it
  again, so a slow download that still moves is never ended) ends the watch `failed` with "No progress from <Store> for
  24 hours, so PlayOut stopped waiting for it. Press Install to try again." and the queue moves on, so an install the
  store cancelled where PlayOut cannot see it does not block the queue for ever (the store's own download, if any, is
  not touched). 30 minutes without a change never end a held watch: the state is kept
  and the message becomes "No progress from <Store> for 30 minutes; it may be paused there" when the store showed the
  install, else "PlayOut cannot see <Store>'s progress. Remove it from the queue once <Store> finished or cancelled it."
  (`blindMessage`; emitted once, unthrottled; a probe's own message such as "Paused in Steam" wins; the usual line
  returns with the next change), and the confirming scan keeps running. A second Install of the game installing now
  re-sends the hand-off but never makes a watch: when, after its awaits, the game is no longer the queue's active,
  watched entry (its watch ended or it was removed meanwhile), it goes through `queue.add` like any other Install.
  Waiting store entries whose game shows up installed (installed straight in the store) leave the queue at once: the
  InstallService listens to `library:changed` and removes them (the active entry is left to its watch). A Steam manifest
  absent on three consecutive probes (with no `steamapps\downloading\<appid>` folder) before `done` means cancelled
  in the client and ends as `failed` ("The install was cancelled in <Store>"); a manifest that exists but cannot be
  read or parsed (Steam's `.acf.tmp` rename, a locked commit) repeats the previous result and is retried.
- `powerMonitor` suspend pauses the watches (no probe during sleep), resume re-arms them without crediting the gap
  towards the timeout; `dispose()` on quit ends every watch silently.

**Install queue** (`installs/queue.ts`, created first in `index.ts` and passed to the streaming service and the
InstallService): one game downloads at a time, whatever the store, and ROM downloads from another PC
(`streaming-service.ts`) take their turn in the same line. Entries (`InstallQueueEntry`: `kind` `store` | `host-rom`,
`state` `active` | `waiting`, the active one first) are saved to `userData/installs/queue.json` (`JsonStore`, atomic
writes) on every change and emitted whole as `installs:queue`. Each kind registers a runner:
`start(entry, { resumed, handedOff, markHandedOff, signal })` hands the game over and returns `{ error?, done?, stop? }`
(store: the hand-off above plus a watch whose `WatchOptions.onEnd` settles `done`; host-rom: the download job,
`done` = `runDownload`), `reportError` (a start that failed in its turn: `install:progress` / `streaming:download`
`failed`, so the renderer toasts it), `skip` (store: the game was installed meanwhile or is gone) and `ready`
(host-rom: false while the entry's host is unreachable) and `waitingFor` (host-rom: "Waiting for <host> to come back
online" while the host is unreachable; read on every `list()`, so a waiting entry carries the optional
`InstallQueueEntry.waitingFor` for the renderer, and `poke()` emits `installs:queue` again when it may have changed). The file is read entry by entry: an invalid entry is dropped,
never the whole line; `add` cuts `title` to 500 and `from` to 200 characters and refuses a 1001st entry
(`MAX_QUEUE_ENTRIES`, "The download queue is full …"). A main-only `handedOff` flag is saved with an entry (never in
`list()` or `installs:queue`): the store runner calls `markHandedOff` right after `execute()` succeeded. A resumed
entry without it (PlayOut quit between saving the entry `active` and asking the store, or a file from before the flag)
gets the full hand-off again, since re-sending a store's install request for a game it already has is harmless; a fresh
start clears a stale flag. **Unreachable host**: a host-rom download whose host does not answer (`reach()` threw
`HostUnreachableError`: no address of the host answered) settles `done` with `'retry'`: the entry stays in line as `waiting` at its place, the host goes into
`unreachableHosts` and `streaming:download` says once `failed` "Waiting for <host> to come back online". `ready` then
holds back every entry of that host while the next ready entry (another store or host) starts and moves to the front;
with nothing ready the queue stays idle. The queue also keeps a retried entry `held` until `poke()`, so a runner can
never make it loop. Any successful `reach()` of that host (refresh, discovery, media, pairing) removes it from
`unreachableHosts` and calls `installQueue.poke()`; a held entry can be removed at any time. A network error after
the host answered (`isHostUnreachable`: socket/DNS codes such as ECONNRESET / ETIMEDOUT, "did not answer in time" —
the connection broke off mid-transfer) does not hold the host: that one download is tried again, at most
`HOST_TRANSFER_ATTEMPTS` (3) times in all, each attempt reaching the host again (a host that is now gone is held as
above), then ends as an ordinary failure ("Download failed: …"); any other error (a host's HTTP error, "not offered",
a full disk, a missing ROM folder) fails at once. Stopping is per run, never per game id:
each start gets its own `AbortSignal`, and its `stop` closes over exactly what that start created (store: the watch
handle `tracker.start` returned, `created: true` only, so a start that joined an existing watch never ends it, and
the store may keep downloading; host-rom: that job's `AbortController`). Runners check the signal after every await
and return `{}` without creating a watch or job or emitting once it aborted; removing the active entry aborts the
signal and calls the run's `stop` (at once, or when a still-running start returns). A new run of a game waits for the
previous run of the same game (its start and `done`) to settle, bounded at 30 s (`SETTLE_WAIT_MS`), so a game removed
and added again during its hand-off never runs twice and never has its new watch or job stopped by the old run. On the
streaming side a new job of a game also waits (15 s) for an older job still in `downloads`; a job only emits or
deletes `downloads[gameId]` while it is still that game's current job, and `dispose` aborts every live job (`jobs`),
current or stopped. `add` validates nothing itself: the callers refuse at once (installed, not from a store, no install
form, no ROM folder, host gone) and the runner checks again in the game's turn. Idle queue: the game starts within
`add` and a start error is returned to the caller (not reported too); busy: it waits and `installGame` answers
`{ ok: true, queued: n }` (1 = next), `downloadRemoteRom` emits nothing until its turn. Queue titles are the display
title (`util/game-title.ts`: the user's `titleOverride` first). A host-rom start always waits (bounded at 30 s) for
the hosts' saved game lists to be read at `streaming.start()` (or a first refresh), so an entry whose turn comes at
start-up is not dropped as "not offered". `begin()` runs after the start-up rescan: the entry that was active when
PlayOut closed resumes with `resumed: true` (store: the watch only when `handedOff` was saved, else the full hand-off; host-rom: after the hosts'
first refresh, bounded at 60 s, the download starts again and `downloadRomSet` continues the partial files), then the
line moves on. On quit `dispose()` runs before the services', so the watch and download ending on the way out do not
move the line on and the file keeps them for the next run. `cancelInstallTracking` and `cancelRemoteRomDownload` are
`remove`; removing a host removes its queued downloads (a waiting one whose start began sees the aborted signal and
never emits `downloading`); `move(id, ±1)` reorders waiting entries only. `trackedGameIds` includes the waiting
store games, so the owned import keeps their records.

**Pause / resume** (`pauseInstall(gameId | null)` / `resumeInstall(gameId | null)`, IPC ids validated like
`removeFromInstallQueue`, null = every entry; `InstallService` → `queue.pause` / `queue.resume`). `InstallQueueEntry.paused`
is saved in `queue.json` (an old file without it loads unpaused) and sent in `list()` / `installs:queue`. A paused
waiting entry keeps its place and is skipped like a not-ready one (`isReady` is false) until resumed. The active entry
goes as its runner's `pauseActive(entry, { resumed })` says: **'stop'** (the default; host-rom) aborts the run's signal
and calls its `stop('pause')`, the entry goes back to `waiting` + `paused` at the front and the next ready, not paused
entry starts; the host-rom job then ends with `streaming:download` state **`paused`** (not `cancelled`, no toast),
carrying the bytes it had (`job.lastStep`, kept exact between the spaced-out progress events by counting the fetched
bytes) — its `.part` files stay, as on every stop, so a resumed start continues from them. **'hold'** (store: PlayOut
cannot pause a store's download): the entry stays `active` and marked paused, the queue keeps waiting for it (one
download at a time), and the runner opens the store's downloads page (`storeDownloadsPage`: `steam://open/downloads`,
otherwise the client's `LIBRARY_PAGE`, all allow-listed by `isAllowedInstallUri`) so the user pauses it there; the
Steam probe then reports "Paused in Steam". Pause all marks the waiting entries first, then the active one, so stopping
it never starts one of them. Resume clears the flag (opens nothing); with nothing active the first ready entry starts.
At `begin()` a saved active entry that is paused is asked `pauseActive(…, { resumed: true })` (no side effects): 'hold'
resumes its watch as before, still paused; otherwise it becomes `waiting` + `paused` and the line moves on. Removing or
moving a paused entry works as for any other; `add` of an already queued paused game only answers its place.

**Handlers** (`ipc/handlers.ts`, section `// --- store accounts / installs`): zod schemas `z.enum(STORE_SOURCE_IDS)`
(`store/settings-schema.ts`) for `signIn`/`signOut`, `z.array(z.enum(STORE_SOURCE_IDS)).max(7).optional()` for
`importOwned`, `idSchema` for `installGame`/`cancelInstallTracking`, `streamIdSchema` (queue ids include `remote:` ids)
for `removeFromInstallQueue`/`moveInInstallQueue` and `-1 | 1` for the move. `launchGame` on an `installed: false`
game returns `LaunchError { kind: 'file-missing', message: 'This game is not installed' }` so the renderer's Install
path is the only one that reaches the store client. `EventBus.emit` sends only to the main window's `webContents` (the
auth window has no preload and must not receive app events).

**Mock** (`api/mock/`): `MOCK_ACCOUNTS` fixture (Steam signed in as "example_user" with a last import, Epic not signed in,
GOG signed in, Xbox not signed in, EA and Battle.net supported and not signed in, Ubisoft `supported: false` with the
reason above), six to eight owned-not-installed games across Steam/Epic/GOG (`installed: false, owned: true`, no
`installDir`, Steam CDN art), `signIn` = `sleep(DIALOG_MS)` then signed in + `accounts:changed` + an import that adds
the fixture games; `installGame` = a `setTimeout` chain (500 ms ticks, `INSTALL_MS` = 6 s) emitting `install:progress`
0 -> 100 % (bytes for Steam/Epic/GOG, indeterminate for Xbox), then `installed = true`, `library:changed { reason: 'scan' }`
and the final `done`; `getInstalls` for re-open; `?screen=detail-install` opens the detail panel of an owned game with
the Install button and `?screen=detail-installing` the same with a tracked install held at 42 % (`readMockFlags`
`installing`, `INSTALL_HOLD_MS`).

**Delete from this PC** (`services/local-delete.ts`, IPC `getLocalDeletePlan` / `deleteGameLocally`, renderer
`state/localDelete.ts` used by PlayMenu and the cover menu): only a game id crosses IPC; main derives every path from
the record and plans again on run. Refused for host-only (`remote:`) and uninstalled games, the running game, queued
or tracked ids (including `remote:<host>:<id>` ROM downloads) and while a conversion runs. ROMs: the union of
`romFileSet` and `convert/sources.ts` `sourceFiles` (or `extra.gameFolder` / a folder ROM whole), every path inside
`romsRoot` and never the root, a system folder or the Emulation saves/states/storage/bios; files another ROM of the
same platform also uses are kept; each path goes through `shell.trashItem` (a failure stops with the record kept),
then `imageCache.remove` + `removeGame` (the hosting side's cached ROM set is harmless: `offeredGame` no longer finds
the id). Store games: `uninstallUriFor` (`install-uri.ts`, own allow-list incl. `ms-settings:appsfeatures`), GOG
`GalaxyClient.exe /command=uninstall /gameId=<id>` (detected client only, argv array), EA / Battle.net the matching
Add/Remove Programs `UninstallString` (`parseUninstallCommand`: exe + args, no shell, shells and script hosts
refused, MSI as `/X{GUID}`; EACCES retried through UAC) else the store's library page; the record stays and the source
is rescanned after 1, 3 and 10 minutes (Xbox: `plan.opens = 'settings'`, only Settings › Apps opens). Manual games: the
matching uninstaller (the record stays; at 1, 3 and 10 minutes it is removed once the exe / install folder is gone on a
present drive, or the Add/Remove Programs entry is gone from a readable list), else the folder to the Recycle Bin behind
`folderDeleteRefusal` (drive root and its direct folders, known / app folders, store library names, games inside
steamapps / XboxGames), `collectionRefusal` (another library game inside, a store folder or launcher exe in the top two
levels, programs of different products by `sameProduct`) and a 200 GB cap, else `remove-only` (the existing Remove
from library, with the reason).

### 4.9 App updates (`updates/index.ts`)

`createUpdateService` wraps electron-updater's `autoUpdater` behind the injected `UpdaterLike`. The feed is the public
GitHub repository `UPDATE_REPO`, which must match `publish:` in electron-builder.yml (a test compares them). The user
drives every step from Settings → About: `checkForUpdates`, `downloadUpdate`, `installUpdate` (`autoDownload` and
`autoInstallOnAppQuit` are off). Each step and each download tick emits `update:status`; `getUpdateStatus` restores the
row when the tab reopens. The installer is verified against the sha512 in the release's `latest.yml`; the builds are
not code-signed, so there is no publisher check.

- A failure is a status (`error`), never a rejection. A repository with no release answers `up-to-date` with a message.
- Development runs report `unsupported` and never create the updater.
- The portable exe (`PORTABLE_EXECUTABLE_FILE` set) has no install to replace: `manual: true`, the row opens
  `releaseUrl`, and `download` does nothing.
- `installUpdate` rejects while a game is tracked as running. It then runs the installer silently and reopens PlayOut;
  `before-quit` still flushes the stores.

### 4.10 Achievements (`achievements/*`)

`createAchievementsService` writes `metadata.achievements { unlocked, total, updatedAt }` for the whole library and
serves one game's list (`getAchievements`, cached 10 min, errors not cached).

- **Steam.** The credential is the Settings › Metadata Web API key when one is set, else the signed-in account's web
  access token (`accounts.steamCredential(refresh)`, handed over with `useSteamAccount` because accounts is created
  later). `ISteamUserStats` refuses access tokens ("Required parameter 'key' is missing"), so the library pass uses
  `IPlayerService/GetAchievementsProgress` (POST only, 100 apps per call, key or token). A game's list with the key is
  GetSchemaForGame + GetPlayerAchievements; with the token it is GetGameAchievements (keyless definitions) +
  GetTopAchievementsForGames, falling back to the public profile's stats XML when that list is shorter than the
  progress count. A refused token is minted again once (`refresh: true`); a refused key falls back to the account.
  The pass runs after every Steam owned import (`onOwnedImported`, which also follows sign-in and each startup
  import) and when the Settings key changes. A sign-out, a new sign-in (`onSignedOut`) or a key change clears the
  Steam counts, fences work still running for the old credential (`steamGeneration`) and syncs again with what is left.
  A key for another SteamID64 than the signed-in account is not used.
- **RetroAchievements** (ROM games). Username + Web API key in `settings.scrapers.retroachievements` (set in
  Settings › Emulators). `syncRetro` checks the account (`API_GetUserProfile`), matches each ROM to a game of its
  console (`raConsoleFor` maps system ids to RetroAchievements console ids) by rcheevos hash (`ra-hash.ts`:
  whole file, NES/FDS/Lynx/7800/SNES/PC Engine header rules, N64 byte order, Nintendo DS layout, arcade set name,
  the first ROM of a zip) or, for disc systems and unknown hashes, by a title only one game of the console has. The
  console lists (`API_GetGameList` with hashes) are cached a week and the ROM hashes by path/size/mtime, both in
  `userData/retroachievements/`. Counts come from `API_GetUserCompletionProgress` (played games) or the game's
  achievement count (0 unlocked); the RetroAchievements game id goes to `metadata.sources.retroachievements`. The
  sync runs at startup, after a ROM scan and once a credential edit settles, and reports through
  `retroachievements:status` (`getRetroAchievementsStatus`, `syncRetroAchievements`). Clearing the credentials
  clears the ROMs' counts. Unlocking happens in the emulator; PlayOut only reads progress.

### 4.11 Install sizes (`services/install-size.ts`, `scrapers/store-sizes.ts`)

`Game.installSize` is what an installed game takes on disk; `metadata.storage` is the size of one that is not;
`user.installSize` (entered in the game's settings) wins over both. The renderer shows it right of Play / Install
(`lib/installSize.ts`).

- **Installed** (`measure` after every scan of a source, `refresh` when the panel opens): the client's own record
  first (Steam `SizeOnDisk`, Epic `InstallSize`; providers always write them, 0 = unknown, because scans merge
  `extra`), then a ROM's file (an .m3u / .cue adds up the files it names) or folder, then a walk of the install
  folder (links and junctions skipped, 400,000 entries and 3 minutes at most, 8 stats in flight). Shared folders (a
  drive root, the user's folders, Program Files, Windows, app data) are never walked. A folder that cannot be added
  up is stored as `unmeasurable`; folder results are reused for a week by path. Records are batched, walks are
  written one by one, and `setInstallSizes` writes nothing when nothing changed.
- **Not installed** (`refresh` on panel open, re-checked monthly, not recorded when every source failed): what
  Steam would install for the game's own app (api.steamcmd.net depots: Windows, English, no DLC / optional /
  shared / Steam Deck depots, 64-bit over 32-bit; when one depot is marked Windows and two or more unmarked depots
  are each half to double its size, those are other copies of the game, Black Desert's regional clients, and only
  the Windows depot counts; exact. A size carries `steamRules`: one worked out by older rules than
  `STEAM_SIZE_RULES` is looked up once more, past the size cache, whose key carries the version), else for an Epic game while Epic is signed in its current build
  manifest (`scrapers/epic-sizes.ts`: the Launcher assets API
  `launcher-public-service-prod06…/assets/v2/platform/Windows/namespace/<ns>/catalogItem/<id>/app/<appName>/label/Live`
  with the account's bearer token names the manifest on Epic's CDN; the chunk-part sizes of every file add up to the
  install; binary and JSON manifests, SHA-1 checked, the file list checked to end where its size says; `how: 'epic'`,
  exact unless files with install tags (optional language / high-res content) are counted in, then `approximate`;
  cached as `epic:<appName>` and `epic-optional:<appName>`; only a 404 means "no Windows build", recorded as
  `epicChecked` and asked again after a month; a failed lookup is not repeated for an hour, five in a row leave Epic
  alone for 15 minutes, a 401 forces one token refresh; the Steam match fills in meanwhile; these games run in the
  fast lane; token refreshes are serialized per store with the owned-games import), else the GOG installer (`api.gog.com/products/<id>?expand=downloads`),
  else the same game on Steam (a Steam copy in the library, else the Steam app with exactly the same title from the
  store search; `how: 'steam-match'`), else Steam's "Storage:" requirement. A title that two Steam games share (a remake and its original), in the library or in the search, is
  not matched; manual games are never matched by title; a depot borrowed from another app makes the Steam sum
  unknown rather than too small. A result found while another source failed is `partial` and asked again the next
  day; `matchKey` asks again when the title (override) changes. A manual game whose folder holds several games is
  not walked. Only `how: 'steam'` and `'epic'` are shown as exact;
  the rest read "About …". EA, Ubisoft, Battle.net and Xbox publish no sizes (nor does Epic while signed out), so
  those come from Steam or from the user.

- **Start-up scan.** `scanAll` runs once per session after the startup rescan, with the normal rules: a found size
  is kept for good (a folder measurement while its path matches, a client record while its bytes match, a store size
  while the title it was matched by stands); only games without one are measured or looked up (unmeasurable
  folders weekly, store checks that found none after 30 days, partial ones after a day). Games with no size go first;
  api.steamcmd.net / GOG lookups run 4 at a time while title matches use one lane behind the Steam store pacing
  (0.4/s); unchanged answers are written quietly. Later scans, imports and panel opens size only what is new. `install-size:progress` ({ done, total, remaining, paused, current }, both passes summed; `current` names the game
  being measured) drives the
  header's "sizes N left" and `components/ScanBars.tsx`, a bar along the bottom edge (stacked with the review scores bar) that sets `--scan-bar-h` on
  <html> while it shows, so the Library band, the button hints and Home's chevron move up by its height.
- **Cache and background fill.** Every store answer (`steam:<appId>`, `gog:<id>`, `search:<title key>`, `req:<appId>`)
  goes through `size-cache.ts` (`userData/install-sizes.json`, 30 days, "none" kept, failures not), so a re-import or
  a second copy asks no store. `fillStoreSizes` walks every not-installed (or unmeasurable) game without a fresh
  `metadata.storage` after the startup rescan and every owned import, one at a time behind the stores' rate limits.
  The Library sorts and filters by `installSizeBytes` (renderer `lib/installSize.ts`: the user's size, the measured
  size, else the store size); every sort can be reversed (`LibraryFilters.sortReversed`), unknown sizes stay last.

### 4.12 Co-Op: Nucleus Co-op split-screen (`coop/*`)

Several instances of a PC game on one PC, each in its own window with its own controller, through Nucleus Co-op's
community handlers. Nucleus Co-op is GPL-3; PlayOut stays closed and MIT, so **no Nucleus code is in this
repository's PlayOut code**: the engine runs in a separate GPL-3 program, **PlayOut Co-Op** (`PlayOutCoop.exe`),
built from Nucleus's engine (Nucleus.Gaming, the injectors, StartGame) with a headless command line. Its source is
kept in `coop-helper/` (its own licence and solution; nothing in `src/` uses it) and published on its own as the
public repository https://github.com/jeremybris/PlayOut-CoOp (`git subtree push --prefix=coop-helper`), which must
match what PlayOut ships. Build it with `coop-helperuild.ps1` (.NET 8 SDK) into `coop-helperdist`. PlayOut talks to it only through its `CONTRACT.md`: `devices`, `play --job` with JSON
lines on stdout and `stop` on stdin (`coop/helper.ts`). `scripts/sync-coop-helper.mjs` (part of `npm run build`)
copies the helper's `dist` into `resources/coop` (unpacked from the asar) with a `playout-coop-version.txt` stamp.

- **Engine root** `%APPDATA%\PlayOut\coop\engine`: the helper (copied from `resources\coop` when its stamp changes,
  `tools.ts syncHelper`), Nucleus's tools, `handlers\` (extracted handlers), `content\` (instance folders),
  Settings.ini and logs. **Tools** (`tools.ts`): Nucleus's hook DLLs, ProtoInput, EasyHook, Goldberg, XInputPlus,
  x360ce and the other `utils` are not shipped (several may not be redistributed); the first Co-Op start downloads the
  official `NucleusApp.zip` of the release the helper is built for (`PINNED_RELEASE_TAG`, the latest release only when
  GitHub does not have that one) from GitHub (password-protected: ZipCrypto, `util/zip.ts`) and extracts everything
  but the Nucleus app itself (`isToolEntry`: no NucleusCoop.exe, launcher, updater, gui, webview, and none of the
  managed engine files the helper ships), then copies the helper over again. The Nucleus app is never run.
- **Handler pack** (`handler-pack.ts`): Settings → Library → Download all handlers lists the user's Google Drive folder
  (`embeddedfolderview` page, no key), downloads every `handler-<hubId>-v<version>.nc` not already in
  `coop\archive\` (8 at a time, checked to be zips) plus `handlers.json` (the hub's records), and the handlers the
  folder lacks from the Nucleus hub's CDN; older versions are deleted. Nothing is extracted then: `handlers-index.json`
  holds what each package's handler.js says (`handler-script.ts` reads top-level `Game.X = literal` lines, comments
  stripped, never running the script): name, exe names, ExecutableContext, Steam id, GUID, BinariesFolder, players,
  keyboard support, hub id and version, and the DRM / anti-cheat tools it uses (`UseSteamless` / `SteamlessPatch`,
  `NeedsSteamEmulation`, `UseSteamStubDRMPatcher`, `UseEACBypass`). `extract` installs one handler Nucleus's way
  (`handlers\<GameName>.js`, each top-level folder's contents merged into `handlers\<GameName>\`, a
  `.playout.json` stamp naming the package) the first time the game is played; Co-Op setup removes it.
- **Matching** (`match.ts`, run on every library change): exe file name (with ExecutableContext; a generic exe name
  needs the Steam id or the name to agree), else Steam app id, else the normalised name (never a handler made for
  another Steam app). The result is `Game.metadata.coop` (`CoopGameInfo`), cleared when nothing fits any more.
- **Automatic setup** (`plan.ts`, pure): devices from the helper (XInput slots first, then DirectInput, the keyboard and
  mouse only with `library.coopKeyboardMouse` and a handler that supports them), one player each up to MaxPlayers;
  two players `DualVertical` with `library.coopTwoPlayerLayout` 'sideBySide', else `DualHorizontal` (stacked) while each window keeps ≥ 540 px height, else `DualVertical`; 3-4 `FourPlayers`,
  then 2×3, 2×4, 4×4. With 2+ monitors and no layout picked in Co-Op setup, players are spread evenly over all
  monitors, the primary first (`ceil(left / monitorsLeft)` each), each monitor laid out by `autoLayout` for its
  share (1 = FullScreen); a picked layout (kept only while capacity × monitors holds every player) fills the primary first and overflows;
  a lone player on a monitor is always FullScreen. `CoopPlan.monitors`
  lists each monitor's layout and player count for the setup sheet. The exe (`exe.ts`): the game's
  `exePath` when its name is the handler's, else a bounded breadth-first search of the install folder for the
  handler's exe names (redistributable folders skipped), ranked by BinariesFolder then depth. `GameUserData.coop`
  (Co-Op setup) overrides any part.
- **Session** (`coop-service.ts play`): one at a time. A handler with risk tools needs `user.coop.risksAccepted`
  (the renderer asks first). Prepare helper and tools ('coop:progress' stage `tools`), extract, plan, write the job
  (`contentRoot` on the game's drive when it is not the engine root's, so hard links work), spawn `play` with
  `--prompts native --parent <pid>`, and hand the helper process to the launcher's session tracker (`launcher.track`:
  tracked as 'spawned', so play time, Running and minimise-while-playing work as for any game). Helper events become
  'coop:session' (`preparing`, `starting`, `running`, `ended`, `error`).
- **Renderer**: `state/coop.ts` (progress, status, sessions, `startCoop` with the one-time risk dialog), the detail
  page's Co-Op badge (right of the players badge) and Play | Co-Op split button (`ActionBar` `coop`), Co-Op setup
  (`CoopSetupSheet.tsx`, from the play menu), Settings → Library → Co-Op (`CoopSection.tsx`), the bottom bar
  (`lib/coop.ts coopScanBar`). The mock fakes all of it (`?screen=detail-coop`).

### 4.13 Streaming between two PlayOut PCs (`streaming/*`)

Two PlayOut PCs pair once with a PIN; the client then shows the host's games and streams them (PC and ROM games, the
host runs them) or copies the host's ROMs. The picture and input travel through two separate GPL-3 programs PlayOut
downloads on first use and drives from outside (no GPL code in this repository, `docs/LICENSES.md`): **Sunshine** on
the host (`sunshine.ts`, the portable "lite" build as a hidden child process with PlayOut's own config folder, no
service, no tray, no admin) and **Moonlight** on the client (`moonlight.ts`, its portable build's command line:
`pair`, `list`, `stream --quit-after`). `tools.ts` downloads both from pinned GitHub releases, checked against a
pinned SHA-256, into `%APPDATA%\PlayOut\streaming\{sunshine,moonlight}\app\<tag>\`.

- **Service** (`streaming-service.ts`): created in `index.ts` after the launcher, library, scan and Co-Op services,
  started with the deferred start-up work (never under `--mock`), paused on suspend (hosting stops, the refresh
  pauses) and disposed in `before-quit` (port forwarding deleted, 5 s cap). Status, the remote library, stream
  sessions and ROM downloads reach the renderer as `streaming:status`, `streaming:library`, `streaming:session` and
  `streaming:download`; the 13 IPC methods are thin zod-checked delegations (`ipc/handlers.ts`).
- **Identity and secrets**: one random UUID per PC (`streaming/identity.json`), used as host id and client id; the
  computer name is the display name. `secrets.ts` keeps one safeStorage (DPAPI) blob in `streaming/secrets.json`
  like `accounts/token-store.ts`: the host's paired clients (`sha256(token)` only), the client's paired hosts (token,
  pinned certificate fingerprint, LAN and internet addresses, port), the Sunshine password and router mappings that
  could only be made permanent (deleted on the next start).
- **Host service** (`host-server.ts`, HTTPS on `0.0.0.0:<streaming.hostPort>`, default 47900; `tls.ts` makes a
  self-signed RSA-2048 certificate once in `streaming/host/`): `GET /v1/info` and `POST /v1/pair` without a token,
  everything else with `Authorization: Bearer <token>`: `/v1/library` (`remote-library.ts hostOffer`: installed,
  non-hidden store games and ROM games, stripped of paths and launch specs; each game's `lastPlayed` while
  `streaming.syncPlaytime` is on, and the host's clock `now`, so a client dates its host-only cards on its own clock
  and never ahead of it: `lastPlayedHere`; an offer without `now` is an older host's, whose dates are not shown, and
  the clock difference is saved with the offer in `offers/<hostId>.json`). `POST /v1/playtime` also carries `recent`
  both ways (`recency-relay.ts`, `userData/recency-relay.json` on the host): the last played, by library id, of the
  store games the host does not offer, which the host passes from one client to its others and each client writes to
  its own records with `LibraryService.setSyncedLastPlayed` (date only, never a new record). A client is told only
  about the games it names (`want`, and those it sent a date of); a date counts as a later play only when it is more
  than a minute later (`RECENCY_TOLERANCE_MS`: a date relayed back through two clock corrections must not ratchet); a
  client's list replaces what the host kept from it, and unpairing a client drops its dates. The other routes: `/v1/media/:id/:kind` (the image-cache
  file behind the game's `media://cache/...` URL), `/v1/rom/:id/files` and `/v1/rom/:id/file?path=` (ranged; only
  files of that game's set, `rom-transfer.ts romFileSet`: the file, cue tracks, m3u discs, gdi/ccd companions or a
  game folder), `/v1/stream/prepare`, `/v1/stream/stop`, `/v1/stream/status` (GET: the caller's launch failure from
  the last 2 minutes, `{ lastError?: { gameId, message } }`, cleared once read), `/v1/moonlight/pair`, `/v1/unpair`. Body 64 KB, received
  within 15 s, 64 connections (16 per address), 4 file streams per client. `/v1/info` does not say whether a PIN is
  showing. Removing a client (Settings or its `/v1/unpair`) also makes Sunshine forget every Moonlight pairing
  (`unpairAll`; saved as pending until Sunshine next runs); the clients still paired pair Moonlight again at their
  next stream. Discovery (`discovery.ts`): UDP port + 1 answers the
  datagram `PLAYOUT-DISCOVER 1` with id, name, port and fingerprint (rate-limited, LAN only).
- **Pairing security model**: the host shows a crypto-random 4-digit PIN for 5 minutes (`pairing.ts`); the client
  sends `HMAC-SHA256(pin, fingerprint|clientId)` over the certificate it saw, inside TLS, so a passive listener learns
  nothing and the PIN itself is never sent. Five wrong proofs lock out that address for 10 minutes;
  twenty in all lock pairing for everyone for 10 minutes and drop the PIN. The host
  answers with a 32-byte random token and stores only its SHA-256. From then on every connection **pins the
  certificate** (`host-client.ts`: the fingerprint is checked after the handshake, before a byte of the request, token
  included, is written). The limit is the one Moonlight's own PIN pairing has: against an _active_ attacker in the
  middle during the pairing minutes it is trust-on-first-use (the attacker can test all 10 000 PINs offline against a
  proof made for its own certificate); closing that would take a PAKE. Moonlight pairing never reuses the user's PIN:
  after PlayOut pairing (and whenever a stream finds Moonlight unpaired) the client makes a fresh PIN, opens
  `moonlight pair` with it and sends it in the authenticated `/v1/moonlight/pair`, whose handler approves exactly that
  PIN on Sunshine for the caller's address (`sunshine.approvePairing`). A failed Moonlight pairing keeps the PlayOut
  pairing and is retried at the next stream.
- **Hosting** (`settings.streaming.hostEnabled`, applied on every settings change, one change at a time): certificate
  → host service → discovery responder → stream-launch pipe → UPnP (`upnp.ts`: SSDP, the WAN service's SOAP;
  `AddPortMapping` of the TCP port, then Sunshine's stream ports (`sunshinePorts`: TCP 47984/47989/48010, UDP
  47998-48000), external = internal, lease 3600 s renewed every 30 minutes, the internal client the local address on
  the router's subnet; a mapping that arrives after hosting went off is deleted at once) → Sunshine (`ensureInstalled`,
  `configure` with Sunshine's own UPnP off, because Sunshine is ended with `taskkill /F` and would never delete its
  mappings, `ensureCredentials`, `start`). Turning hosting off (or sleep) closes the listeners and the mappings at
  once, even while a start is still in progress. Windows tools (taskkill, sc, PowerShell, Explorer) are spawned by full
  path from System32. A failing step makes the state `error`
  with a readable message but keeps what works (ROM downloads need no Sunshine). Without a UPnP router the status says
  "same network only". When the router's `GetExternalIPAddress` is itself private or shared (`isLanAddress`: 10/8,
  172.16/12, 192.168/16, CGNAT 100.64/10: double NAT or carrier-grade NAT), every mapping is deleted again and the
  state is `unavailable` with that reason; `/v1/info` and `/v1/pair` then send no `externalIp`. When the host port
  is mapped but one of Sunshine's stream ports is not, the state stays `mapped` with an `error` ("Streaming ports
  could not be forwarded…", shown after the address in Settings), and `/v1/stream/prepare` from a caller outside the
  LAN answers ok with a `warning` (not refused: the ports may be forwarded by hand) that the client adds to its error
  when Moonlight closes before the stream starts.
- **Starting the game on the host** (`stream-launch.ts`): Sunshine has one app, `PlayOut`, whose command is
  `"<PlayOut exe>" --stream-launch` (the running exe, for the portable build its unpacked copy: Sunshine only runs
  while PlayOut does, and the stub would unpack the app again per stream; development: electron.exe plus the app
  folder). Only the client that started the stream (or armed it) can stop it, and `/v1/stream/prepare` answers
  `busy` while another client's stream runs. `index.ts` handles that flag before `requestSingleInstanceLock()` and opens no window: the process connects
  to the per-user named pipe `\\.\pipe\playout-stream-<hash>`, proves the token in `streaming/stream-launch.token`, and
  blocks until the game ends. The running PlayOut starts the game armed by `/v1/stream/prepare` (valid 2 minutes;
  409 `busy` while another game runs) through the launcher, and answers `ended` when the session ends; when the armed
  game cannot start (e.g. its emulator is missing) the launcher's message is kept for that client for
  `/v1/stream/status` (a new `/v1/stream/prepare` from it clears it); when the viewer
  quits, Sunshine kills the client, the pipe closes and `LauncherService.stop` closes the game.
- **Client** (`remote-library.ts buildRemoteLibrary`, pure): every paired host's offer is fetched at start, every 5
  minutes, after pairing or removing and on demand, trying the LAN address, then the internet one. Every pinned
  `/v1/info` answer that carries a public `externalIp` different from the stored internet address replaces it (dynamic
  home IPs; a host paired on the LAN before its UPnP worked), unless the stored one is a typed name rather than an IP.
  Connection errors reach the UI through `friendlyNetError` (ECONNREFUSED, ETIMEDOUT / EHOSTUNREACH, ENOTFOUND in
  words; the raw text goes to the log). A host that does
  not answer is looked for once by discovery (a new DHCP address is learnt only after a TLS connection to it, pinned to the stored
  certificate, answers with the host's id: discovery answers are unauthenticated). A host game this
  PC also has (same id; PC: same title key and release year within 1, never two products of one store; ROM: same
  system and path or title) only adds the host to `alsoOnHost[localId]`; the rest become
  `remote:<hostId>:<hostGameId>` games (`installed` false, `remote` set) that the renderer adds to its pools. Offline
  hosts contribute nothing. `library:changed` rebuilds from the offers in hand. Art:
  `media://remote/<hostId>/<hostGameId>/<kind>` is answered by `media-protocol.ts` through the service and cached in
  `streaming/media-cache/<hostId>/<sha1(id)>-<kind>[.v<rev>].<ext>` (image types only). `rev` is the host's
  revision of the image (the offer's `mediaRevs`: the `?v=` write time of the host's media URL), carried in the
  remote URL's `?v=`: an image the host replaced (a game matched again) has another URL and is fetched again, and the
  files of earlier revisions go; while the host cannot be reached the last file is still served, with
  `Cache-Control: no-store` (`isMediaRevision`: it is not the revision its URL names), and the background copy counts
  the image as not fetched (asked again after an hour, not on every pass). An older host sends
  no revisions: its images are kept as first fetched.
- **Streams** (`streamGame`): one at a time; `preparing` (reach the host, Moonlight installed) → `pairing` (only when
  `moonlight list` says unpaired) → `/v1/stream/prepare` → `connecting` (`moonlight stream <address> PlayOut` with the
  quality settings; 'auto' resolution = the primary screen in physical pixels) → `streaming` once Moonlight has run for
  4 s → `ended`, or `error` with the end of Moonlight's log when it closed earlier. When Moonlight closes (not by
  Stop) the client first asks `/v1/stream/status` (3 s, failures ignored): a launch failure for this game makes the
  session `error` with "The host could not start the game: <message>" instead. PlayOut minimises itself meanwhile
  when `ui.minimizeWhilePlaying` is on.
- **ROM downloads** (`downloadRemoteRom`): need `library.romsRoot`; the file set goes to the same relative paths
  (`downloadRomSet`: `.part` files, resume with `Range`, a free-space check, every byte checked against the listed
  size, a whole-file answer to a resumed request refused), two at a time, then a ROM rescan; the local game whose
  `externalId` is the game's path becomes `installedGameId`.
- **Renderer**: `state/streaming.ts` (loaded at start-up by `App.tsx`), Settings → Streaming
  (`sections/Streaming.tsx`), `lib/streaming.ts` (pools, Play-slot choices), the game page's Stream / Download buttons
  and "Stream from <host>" menu items, and the cover menu's Stream / Download / Details for host-only games (Cancel /
  Stop Stream in place of Stream while that game's stream starts or runs). The pools add, besides the host-only games,
  this PC's uninstalled, non-hidden games that a host can stream (`localOnHost`), so they stay visible with
  showUninstalled off. While a stream starts the Play slot shows its step (`streamBusyLabel`, "Downloading Moonlight…
  n%" during the first one) and cancels on press; the Play menu has "Cancel stream". A stream `error` stays under the
  slot like a failed download. `downloadRom` toasts the start and, with no `library.romsRoot`, opens Settings → Library
  instead of calling main; cards draw a host ROM's download progress. The host side toasts "<name> is now paired" for
  each client id new in `streaming:status`. In Settings, Show PIN / Cancel share one focus key, the pair form takes
  the on-screen keyboard's value directly (`pair(pin, address)`), returns focus to the PIN after a failure (kept
  inline) and to "Enter address" when it closes, and B closes it before Settings. The mock
  fakes a paired "Living Room PC" (`?screen=settings-streaming`, PIN 1234).

### 4.14 Recompilations (`recomp/*`)

Native PC ports of console and old PC games (static recompilations, decompilations, source ports), listed by
decomp-buddy (`tanookistudios.com/decomp-buddy/finds.json` + `plans.json`) and RecompLauncher
(`recomplauncher.com/pc-catalog.json`), downloaded from the project's GitHub / GitLab / Codeberg releases. Neither
project's code is in PlayOut (both are GPL-3): their JSON is read, their behaviour reimplemented. Shared types are in
`shared/recomp.ts`; `GameMetadata.recomp` (`GameRecompInfo`) marks a matched game; events `'recomp:progress'` and
`'recomp:changed'`.

- **Catalog** (`catalog.ts`, `consoles.ts`, `titles.ts`, `http-cache.ts`): the three files go through a conditional-GET
  cache in `%APPDATA%\PlayOut\cache\recomp` (24 h; a source that cannot be reached falls back to its cached copy and
  is listed in `offline`). Windows-only entries with a prebuilt download; decomp-buddy is the base, RecompLauncher
  enriches (tags, features, art, sizes, `boot.files` → game-file needs, `recommended`) and adds its own. Entries are
  grouped into titles (`titleKeyOf(systemId, game)`, plus RecompLauncher's `titles[]`).
- **Matching** (`match.ts`): ROM games by system group + normalized title, store / manual games against 'pc' and
  'dos' titles (store-edition words and possessives stripped); streamed games are skipped. Run on every catalog load
  and (debounced 1.5 s) on library changes; writes or clears `metadata.recomp` quietly, then one `library:changed`.
- **Install** (`releases.ts`, `assets.ts`, `install.ts`, `state.ts`): the root is `<exeDir>\Recompilations` when
  writable and not under Program Files, else `%APPDATA%\PlayOut\Recompilations` (a root that already holds installs
  wins). The manifest `<root>\.playout\recomps.json` holds the installed records, the preferred entry per title,
  the cloud folder older versions used (`cloudDir`, read only, for adoption), `savesMigrated` and `savesRoot`. One install at a time (the service's queue); the asset is picked from the release (catalog
  pattern, then the previous file's name, then scoring), checked against decomp-buddy's scanned SHA-256 or GitHub's
  digest (a mismatch fails; neither = installed with a warning), extracted through `<dir>.staging`. Updates back up
  the player's files and overlay the new release. Installers (setup .exe / .msi) are saved, never run silently.
- **Service** (`service.ts`, `createRecompService`): every recompilation API method. Start-up: the catalog loads
  20 s after start and then daily, followed by the update check of installed recompilations and the automatic
  updates of those with `autoUpdate`. Releases and READMEs come through the same cache (6 h / 24 h).
- **Launch** (`launchRecomp`): the game files (`gamefiles.ts`: the entry's needs, replaced by the release's own
  `recomplauncher.json` when it has one; picks stored on the record, else the library's ROM / install folder;
  hashes checked for files up to 1 GB) must be ready, else `needs-files`. With the save copy on: a pending conflict
  returns `save-conflict`, else a before-play sync. Folder needs are hard-linked / copied into the install, the
  program (profile `start.program`, else the record's `exe`) is spawned detached with cwd = the install,
  `[...profile args, ...game-file flags]` and the profile's / needs' environment variables, and handed to
  `launcher.track(game, child)` so play time counts on the library game. When nobody knows the save folders, the
  likely places (`saves.ts snapshotSaveCandidates`) are snapshotted before and compared after the session
  (`detectSaveFolders`, stored as templates with source 'detected'). After the session (the child's exit, then the
  launcher's session end) comes the after-play sync. Installer-type entries run their setup program (msiexec for
  .msi) instead, untracked.
- **Saves and their copies** (`saves.ts`, `cloud.ts`): save folders are templates (`{install}`, `%APPDATA%`, ...)
  resolved in order user → developer `recomplauncher.json` → catalog → detected. With none known, `findSaveFolders`
  runs after a first install and on `findRecompSaveFolders` (Find automatically): folders named like the game /
  project / repo / program (`recompNameTokens`) under Documents, My Games, Saved Games, Roaming, Local, LocalLow (and
  LocalLow\<company>), plus save-named top folders of the install without release files, that hold save-like files
  and no programs (≤ 2000 files), plausible save folders only; PlayOut's own folders and other recompilations' save
  folders excluded. One found while none is known is used (source 'detected'); the rest are `saveSuggestions` on
  the record (`addRecompSaveFolder(id, path)` adds one; without `path` it opens a folder picker). The snapshot diff
  around the first play stays the last resort. The copy (`syncSaves`, `resolveConflict`; per-record
  `cloud.enabled`, on by default) lives in `<Emulation folder>\Recompilations Saves\<project name> (<safe id>)\`
  (`current\<root>\...` + `meta.json`: hash, time, PC, roots; an existing folder for the id is reused) — the
  Emulation folder follows Settings → Library (`emulationDirOf`) and is made with it (`generatedFolderPlan`, and
  `ensureDefaultEmulationDir` for a chosen one). Three-way: newer side wins with the other backed up on this PC
  (`<root>\.playout\save-backups\<key>\` and `...\replaced copies\`, never in the Emulation folder), both changed =
  conflict for the user. Work in progress in the copy folder is named `*.playout-new` / `*.playout-old`, which the
  Emulation folder sync leaves out; the copy itself is synced to other PCs (`emulation-sync/rules.ts`). Syncs are
  serialized per recompilation. `savesRoot` names the Emulation folder the last-synced hashes refer to: when it
  changes, every hash is forgotten (a differing copy there is a conflict, never copied back silently). Migration from
  the cloud-folder version: once (`savesMigrated`), every record is switched on with its hash and conflict cleared;
  per recompilation, when its Emulation copy does not exist yet, a whole old copy in
  `<cloudDir>\PlayOut Recomp Saves\<key>\` is copied in (`adoptOldCopy`, the old one untouched) and its first sync
  runs with no last-synced hash.
- **Renderer**: the game page's UP button left of Play (`ActionBar` `recomp`; launches the preferred version when
  installed, else opens the page) and the play menu's **Recompilation…**; the Recompilation page
  (`screens/Recomp/`); Settings → Recompilations (`sections/Recompilations.tsx`); `state/recomp.ts` (progress,
  change counter). The mock fakes it (`api/mock/recomp.ts`, `?recomp=conflict`).

### 4.15 Home overlay, power helper and overlay extras (`overlay/*`, `performance/*`, `rtss/*`, `intel/*`)

Full description: `docs/home-overlay.md`. `overlay/suite.ts` creates the overlay window, the home button, the
performance service, the media service, the native host (`native-host/`, one long-lived PowerShell worker with C#
classes for windows, displays, RTSS shared memory and HDR state), the RTSS service, the overlay extras and the Intel
graphics module, and disposes them in order on quit (the RTSS OSD slot is released before the native host stops).

- **Power helper** (`performance/helper/`): a SYSTEM service installed with one UAC prompt, spoken to over a named
  pipe (`helper-client.ts`). Protocol 3 adds `rtssLimit` (RTSS `Profiles\<exe>.cfg`
  `[Framerate] Limit`, with a restore record `rtss-limits.json` in the helper folder; the RTSS folder comes only from
  HKLM, never from the request, and Global is never written) and `rtssSelf` (`PlayOut.exe.cfg`
  `[Hooking] EnableHooking=0`). Protocol 4 (`HELPER_PROTOCOL_VERSION`, gate `HELPER_MEMORY_VERSION`) adds `memTrim`
  and `memResult` (class `Mem`, below). A protocol bump changes helper.ps1, so an installed helper reads as
  'outdated' and Settings › System offers the update.
- **Memory cleanup** (`performance/memory/`, Settings › System "Free up memory while PlayOut is running", off by
  default): temporary techniques only; it never stops a service, ends or suspends a process or changes a Windows
  setting.
  - `planner.ts` (pure, injected clock) decides when: one pass 20 s after `session:started`, otherwise only when
    available memory (`system/perf.ts` `sampleMemory`, read every 30 s) is under max(15 % of total, 2 GB) capped at
    30 % of total and at 4 GB, and the last pass ended more than a cooldown ago: 3 min, 10 min when it freed under
    150 MB, and 3 → 10 → 30 min for the successive pressure passes of one low-memory episode (an episode ends
    when memory has not been low for 10 min), so sustained pressure never becomes a 3-minute timer. Never on a
    timer alone. `freeMemoryNow` runs one at once. Passes are serialized, time out after 60 s and do not run while
    the PC sleeps or PlayOut quits; nothing runs before `suite.start()` (so not in `--mock`). A pass that timed
    out starts no further trim, and no other pass starts until its cleanup has really ended.
  - Fail safe (`service.ts`): without the process list, the running game's processes or a foreground pid above 4
    (`native.foreground()` answers null when its worker failed) nothing is trimmed. An automatic pass is then
    skipped without a result, a status event or a cooldown; a session pass is retried twice, a pressure pass is
    not asked for again for 2 min (`passSkipped`). The button reports why.
  - `exclusions.ts` `trimExclusion` is the one function that decides what may be trimmed, from the launcher's process
    list, `launcher.gameProcesses()`, the game's install folder and `native.foreground()`: never pids ≤ 4, PlayOut
    (its tree, its parent, its image names), the game's tree and folder, store clients and overlay tools while a
    game runs, emulators, the foreground program (its tree and image name; every program under a `WindowsApps`
    folder while the foreground window is ApplicationFrameHost's, i.e. a Store app's), Windows' critical processes
    and everything under the Windows
    folder (explorer.exe only while the game is in front), security software, `ANTI_CHEAT` (overlay-logic.ts),
    Sunshine and Moonlight. A process whose image path could not be read is left alone while the game has an
    install folder (it cannot be told from the game's) and while a Store app is in front. A running game whose
    processes are not known yet, or a foreground pid that is not in the process list, means nothing is trimmed.
    The service asks for the helper first and reads all of this (and the setting, for an automatic pass) right
    before the trim; a press of the button that never got to a trim, and an automatic pass stopped before one, is
    not booked with the planner.
  - `trim-cs.ts` is the C# that trims (`K32EmptyWorkingSet` on a handle opened with
    `PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION`), compiled into both tiers. It takes only the pids it is
    given (at most 1024) and checks each opened process again: by creation time (`GetProcessTimes`: a process
    created at or after `createdBefore`, the moment the process list was read minus the list's 2 s reuse window,
    is skipped, so a pid reused since then by PlayOut, the game or the new foreground program is never trimmed)
    and by image path (Windows folder, security, anti-cheat, streaming; unknown time or path: skipped).
  - Tier 'user' (every PC, no administrator): `PlayOutMemory` in the native host (`native-cs.ts` `MEMORY_INIT`,
    `native-ops.ts` `trimWorkingSets`); what this account may not open is counted as denied.
  - Tier 'system' (`performance.memoryHelper()`: the helper ready at protocol 4): `memTrim` validates its arguments
    (a pid list of whole numbers above 4, at most 1024, else the whole request is refused; a flag; `purgeBelowMb`;
    `createdBefore` in Unix ms, required) and
    starts the cleanup on a below-normal thread, so the pipe keeps answering Dynamic TDP; `memResult` is asked until
    it has ended. Steps in order, each reporting on its own: working sets, `MemoryFlushModifiedList`,
    `MemoryPurgeLowPriorityStandbyList`, `MemoryPurgeStandbyList` only when less than `purgeBelowMb` is free
    (zeroed + free pages) by then and the standby list holds at least that much, both read with
    `NtQuerySystemInformation(SystemMemoryListInformation)`; unreadable = skipped (`purgeBelowMb`: half the
    low-memory line; 0 = never, which is what a game-start pass sends and an automatic pass once one of the same
    episode has purged). Standby pages already count as available memory, so neither purge can raise the
    available figure a pass is measured by: only the trim, the flush and the combining can,
    `SystemCombinePhysicalMemoryInformation`. `SeProfileSingleProcessPrivilege` is switched on for the
    call only (class `Privilege`: `ERROR_NOT_ALL_ASSIGNED` checked, the previous state put back in `Dispose`).
    A helper that refuses at once or is not reachable falls back to tier 'user'. One that is, or may still be,
    cleaning up (busy, a lost or unfinished cleanup: `HelperMemoryBusyError`) or that fails after more than 5 s
    does not: the pass fails instead of trimming a second time from stale data. The helper's install conditions
    are unchanged. `performance.memoryTier()` tells Settings why the tier is not there: 'missing', 'outdated',
    'not-answering' (installed, no answer), 'unavailable', or 'unknown' before the PC has been read (no hint).
  - Each pass is one info log line and a `MemoryPassResult` (shared/memory.ts) in `memory:status`.
  - Timings: every step that ran reports `ms` (whole milliseconds, a `Stopwatch` where the step runs: `Mem` in the
    helper, `PlayOutMemory.Trim` for tier 'user'); a skipped step has none. The helper adds `totalMs` beside the
    steps of `memResult`; the pass carries it as `durationMs` (the cleanup itself, not the 1 s settle wait before
    memory is read again). Both logs show them. helper.log:
    `workingSets=done (131 trimmed, 412 ms) modifiedList=done (1830 ms) ... total=4547 ms`; main.log:
    `...; workingSets done (412 ms), ..., combine done (2210 ms); took 4547 ms`. The fields are optional and
    additive, so the protocol stays at 4: `parseElapsedMs` (trim-cs.ts) drops a missing or invalid time, cuts one
    above ten minutes, and never rejects the result around it.
- **RTSS** (`rtss/`): the frame rate from `RTSSSharedMemoryV2` app entries, the profile reload (the `UpdateProfiles`
  flag set from the user process, since a session-0 helper cannot see the mapping) and the performance overlay's OSD
  slot (owner "PlayOut").
- **Overlay extras** (`overlay/extras.ts`): frame limit per game, sync with the refresh rate, performance overlay,
  Auto HDR (HKCU `DirectXUserGlobalSettings` token), CPU boost (`settings.performance.boostOverrides`, applied by the
  performance service) and the live chips. Event `overlay:extras`.
- **Intel** (`intel/`): Endurance Gaming through IGCL (`ControlLib.dll`) in its own PowerShell worker;
  `getIntelGraphics`, `setEnduranceGaming`.

## 5. Preload and IPC

- `src/preload/index.ts` builds `window.playout` from `API_METHODS`: each method is
  `(...args) => ipcRenderer.invoke(ipcChannel(method), ...args)`; `on(event, listener)` subscribes to
  `IPC_EVENT_CHANNEL` messages `{ event, payload }` and returns an unsubscribe function.
- `src/main/ipc/register.ts` takes a `Record<ApiMethod, (...args) => Promise<unknown>>` (assembled from the handler
  modules) and calls `ipcMain.handle(ipcChannel(method), (_e, ...args) => handler(...args))`; handler modules validate
  args with zod schemas defined next to them. `emit(event, payload)` sends to the main window (not to the account
  sign-in window, §4.8).
- Account and install methods (`PlayOutApi`, section `store accounts / installs`): `getAccounts(): AccountStatus[]`,
  `signIn(source: StoreSourceId): AccountStatus` (opens the auth window, resolves when it closes), `signOut(source):
AccountStatus`, `importOwned(sources?: StoreSourceId[]): ImportOwnedResult`, `installGame(id): InstallResult`,
  `cancelInstallTracking(id): void`, `getInstalls(): InstallProgress[]`. Events: `'install:progress': InstallProgress`
  (every change, at most once per second per game), `'accounts:changed': AccountStatus[]`, and `'library:changed'`
  with reason `'import'` (owned import) or `'scan'` (the tracker's confirming scan). The preload maps every name in
  `API_METHODS` automatically, so no preload change is needed for new methods.

## 6. Renderer

### 6.1 Screens and flows

- **Home**: hero backdrop (focused game's hero, blurred cover as fallback) with left/bottom gradients; top-left the
  focused game's logo (or title text) and meta line `Played 19.6 hours · RPG · 2026 · Steam`; top-right the system bar
  pill: search | volume, Bluetooth, Wi-Fi | battery %, power, clock (as in the reference screenshot). Directly above
  the Recent row sit two glass quick-action pills, **Settings** and **Exit** (the exit pill opens the power menu), per
  `docs/research/winhanced-design.md` §2.7. Below: the **Recent Games** row (last played on this PC or a paired one, installed here or not when this PC can
  get the game: `lib/recent.ts`; `settings.ui.recentCount`).
  A down chevron hints at the Library view below. The hero/meta update to the focused card.
- **Library** view (`screens/Library`, `docs/screenshots/library.png`): down from the Recent row, RB, a vertical
  wheel or an upward swipe replaces Home with the full-screen library (Home's content slides up and fades, the hero
  backdrop stays and tints the view's translucent bands; `--dur-screen`). A top band holds LB · tabs · RB: **Settings**
  (tab id `settings`, always first), then the user's tabs (`settings.ui.libraryTabs`, `LibraryTabDef`: an id, the
  Filters choices, a sort and its direction, and the search), each named by its filters (`lib/libraryTabs.ts`
  `tabName`: the choices of a filter joined by " + ", the filters by " · ", "All Games" for none), then a **+** that
  adds a tab (All Games on Playable First); the strip scrolls horizontally when they do not fit. LB/RB (Q/E) switch
  tabs (the fallback when the shown tab was removed is the first of the user's tabs); the accent underline slides and
  the grid slides in from the side of travel (`--dur-tab`). An **X** right of the Filters pill deletes the tab shown
  (never the last one; its right, else left, neighbour is shown).
  Saved tabs (`state/libraryTabs.ts`): `activateTab` copies a tab's filters, sort and search into the view
  (`ui.library`) and saves `ui.libraryTab`; every change in the header goes through `updateActiveTab`, which
  updates the view at once and saves the tab as the view stands after a 400 ms pause (one settings write per burst of
  picks; until then the tabs are in the settings store only, and a store subscriber puts them back over any other
  write's answer that predates them; `flushLibraryTabs` writes them at once on beforeunload / pagehide and before a
  power action). The Library selects only the settings its game lists read, so these saves do not recompute it.
  Nothing changes the tabs before `restoreLibraryTabs` ran. When the settings failed to load (`loadFailed`: the store
  holds the defaults) the tabs are made in memory and never written, so the saved ones are not replaced; a first run
  whose library failed to load waits for a refresh that works. The focused card of each tab (`ui.libraryFocus`) is saved to
  `ui.libraryPositions` 1.5 s after the focus rests. `restoreLibraryTabs` (App, once settings and the library are
  loaded) makes the tabs on the first run from the platform tabs earlier versions showed (`libraryView.libraryTabs`:
  All Games, a store's tab → Filters > Platform (stores, below the line), a system's → Filters > Platform, Other → its stores and its systems, as two
  tabs when it held both; all Playable First), then seeds the positions and shows the saved tab. Settings → Tabs
  (`sections/Tabs.tsx`) moves, edits (the header's Sort pill and a `FiltersPill` per tab, under its own focus key, so
  the RT opener stays the header's) and deletes tabs through `setTabs`, which reloads the view when the shown tab
  changed, and adds the recommended tabs (`RECOMMENDED_TABS`). The settings schema repairs the tabs one by one
  (duplicate ids dropped, at most `MAX_LIBRARY_TABS` 40).
  Filters > Platform's systems and stores narrow the games before copies collapse (`collapseCopies`), so a store's tab shows that
  store's copy; two ROMs of one title share a card unless IGDB matched them to two records and their years are more
  than two apart or unknown (SSX of 2000 on the PlayStation 2 and SSX of 2012 on the PlayStation 3 and Xbox 360 are two
  cards; years alone never split, the sources date a game per console); the other filters keep a card when any copy
  matches. Focus follows a tab
  switch into the grid or the Settings menu unless it was on the tab strip or a header control; the header unmounts
  with the Settings tab, so a switch to it from the search field or a sort pill (an empty All Games grid parks focus
  on the search field) still lands on the menu's section list.
  The **Settings** tab body (`SettingsTab.tsx`, a Norigin container under `library:settings` with
  `saveLastFocusedChild`, the boundary's preferred child while that tab is active) is the Settings menu: the same
  `SettingsPanel` (section list + section pane) as the Settings modal, on a translucent panel over the hero art.
  LB/RB stay the Library's tab keys there (the modal's own LB/RB section stepping is not mounted). The modal and the
  tab share every control's focus key, so they are never mounted together (`ui.settingsModalsMounted` counts a
  Settings modal until its exit animation ends): `ui.openModal({ type: 'settings' })`
  while the Library shows its Settings tab opens no modal but posts `settingsTabRequest` (section), which the tab
  applies (section, then focus on its entry) once nothing is over the view; Library.tsx also unmounts the tab should
  a Settings modal be open anyway. The header, search and sort pills are not shown on this tab; the bottom bar keeps
  Library Import, where store accounts are signed in and out.
  Greyed cards: an uninstalled game renders `.card--uninstalled` (cover and placeholder dimmed) with a
  small "Not installed" download-glyph marker in the card corner, and, while an install is tracked, a thin progress
  bar along the card's bottom edge (`.card__progress`, `--p` percent, indeterminate stripe when no percent) driven by
  a per-card `useInstallProgress(game.id)` subscription so only that card re-renders. The header count stays
  "My Games (N games)" whether or not greyed games are shown: the title block has ~340u next to the fixed-width
  search field, which a "N installed · M not installed" form does not fit, and the greyed cards with their "Not
  installed" markers already carry that information.
  The header has "My Games (N games)", a pill search field (live filter on title, genre, developer; the on-screen
  keyboard for gamepad users), a sort pill (Playable First, Recently played, Title A–Z, Most played, Recently
  added, Install size) and a Filters pill. The picked sort carries a down arrow (on the pill and on its option, the
  `direction` prop); picking it again reverses it (`sortReversed`, arrow up): Z–A ending with '#', oldest first,
  smallest first, with unknown sizes always last. The sort pill opens an anchored popup list of its options (`SelectField` variant pill: its
  own focus layer, B / click outside closes, focus returns to the pill) and both pills leave left/right to spatial
  navigation. The Filters menu (`FiltersPill.tsx`) has Genre, Release, Tags, Platform, PC, Size, H.L.T.B. and Difficulty rows, whose left arrows
  open a multi-select sub-menu (All Genres + every genre; All Dates + the `lib/releaseEras.ts` `RELEASE_ERAS` some
  game in the list was released in (`libraryReleaseEras` over the year of `metadata.releaseDate`; the row is left out
  when none; a card is kept when any copy's year is in a range picked, like Genre and PC); All Tags + the `lib/steamTags.ts` `TAG_FILTERS` some game in the
  list has (`libraryTagFilters`: a fixed list the user chose, each a label and the Steam tags that count as it, matched
  against `metadata.steamTags` by `hasTagFilter` in `filterLibrary`); All Stores + the `lib/storeFilters.ts`
  `STORE_FILTERS` with games in the list (`libraryStoreFilters` over every copy; the PC row is left out when none),
  matched on `game.source`, a card kept when any copy matches; All Sizes + the seven size bands of `lib/installSize.ts`; All Times +
  the six HLTB bands of `lib/hltb.ts`; All Difficulties + the five levels of `shared/difficulty.ts`, Story to
  Impossible, each with its picture from `lib/difficultyIcons.ts`) to its left on a focus layer of its own, a Favorites row, a Nucleus Co-Op row (`coop`: a card any copy of which has `metadata.coop`; saved with the tab, tabs saved before it read as off), and a Hidden row
  that swaps the list the other filters apply to for the hidden games. Difficulty is never scraped: every game is
  Medium until it is set in the game's Edit sheet (`pickedDifficulty`: the user's or the cloud's
  `MetadataEdit.difficulty`, laid over `metadata.difficulty` by `effectiveGame`; a card goes by its own copy's pick,
  else another copy's, else `DEFAULT_DIFFICULTY`, Medium). `LibraryFilters.genres` / `eras` / `tags` / `stores` / `sizes` / `hltb`
  are lists (a game matching any entry; different filters AND together); a choice pressed again is removed
  (`toggleChoice`), the "All …" entry clears its list. `filterChoiceCount` counts every entry plus Hidden and
  Favorites (Platform's systems and its stores one each when any is picked, so a tab about several systems or stores keeps the other filters); at `MAX_FILTER_CHOICES` (3) the choices that would add one are disabled and a note says so. The menus
  stay open while choices are picked; B steps back one level, RT (the opener) or a backdrop click closes the menu.
  While `filterChoiceCount` is above 0 the menu starts with an X _Clear filters_ row (`onClearFilters`: every list
  emptied, Hidden and Favorites off; query, sort and tab kept); the menu opens on Genre (its preferred child), so A
  right after opening never clears, and after a clear focus moves to Genre as the X goes.
  The game page's genre, Steam tag (those with a `tagFilterFor` entry) and _Owned on <Store>_ chips are focusable
  `FilterChip` buttons (GameDetail.tsx; narrow canvases render fewer tags through `useMediaQuery` rather than hide
  them, so no hidden chip takes focus). Pressing one calls `showChoiceInLibrary` (state/libraryTabs.ts): the tab with exactly
  that one choice (plus Hidden for a hidden game while hidden games are not shown) is shown, its sort kept and its search
  cleared, or a new tab with it is added at the end (no tab of the user's is overwritten); then `ui.showInLibrary`
  loads it into the view, every modal closes,
  the screen switches to the Library and `libraryFocusRequest` makes Library.tsx focus the game's card once
  interactive (after its own focus recovery, which would take the first card). `useFocusLayer` does not restore
  focus when the screen changed while the layer was open, so the closing game page does not pull focus back to a
  hidden Home card. Filters, the active tab and the per-tab focused card live in the ui store for the
  session (`lib/libraryView.ts` holds the pure selectors; tab labels prefer `Platform.shortName`). The grid is a
  6-column (5 at 1280x800) CSS grid of GameCards inside a vertical scroll viewport, windowed by rows
  (`LibraryGrid.tsx` reuses `lib/windowing.ts`; spacers span the omitted rows as grid tracks and the pinned row
  follows the focused game's id): A opens the detail panel, X favourites, Y focuses and activates the search field.
  The band tints follow the settled hero (`useHeroGame`) through a blurred `HeroBackdrop`. The bottom band holds
  **Library Import** (opens Add Games) and the button hints. B / Escape, up from the tabs, a deliberate wheel up at
  an already resting top of the active tab's scroller (the grid viewport, or the Settings menu's section pane on
  the Settings tab; `lib/wheelExit.ts`: never the momentum that scrolled it there or opened the view, never under a modal
  or the on-screen keyboard) or a downward swipe there return Home with the previously focused card restored
  (`ui.homeFocusKey`). The Settings tab remembers its section the way the grid tabs remember their card: the
  section entry's key in `ui.libraryFocus[settings]`, the panel's preferred child when it mounts again. Home and the Library are Norigin focus boundaries, so directional moves
  never cross between them while both are mounted; the Library re-takes focus whenever it becomes interactive with
  focus outside it (a card hidden from the detail panel, a re-open during the exit animation).
- **Empty state**: when the library is empty the Recent row holds a single dashed **Add Games** tile (focused by default)
  which opens the Add Games modal. The tile also appears at the end of the Recent row when the library is not empty.
- **Add Games** modal: cards for each store (detected / not installed, "Scan" button, result count), the ROM folder (the Emulation folder's roms folder; "Change Emulation folder"
  -> folder picker -> `emulationDir` -> scan -> summary of systems found and unknown folders), "Add a game (.exe)" and
  "Scan a folder for games". Each store card ends with the store account (`SourceCard`'s account line, stores with a
  sign-in only): the status from `lib/accountStatus.ts` ("Signed in as … · N games · imported today", "Not signed
  in", the sign-in window being open) and **Sign in** (`accounts.signIn`, a spinner while the window is open) or
  **Sign out**; a "Key in Settings › Metadata" hint replaces Sign out when `viaSettings`. Focus follows to the button
  that replaces the pressed one (`addgames:signin|signout:<source>`). There is no import button: signing in imports
  the owned list, and every scan of the store and every start-up re-import it (no scan reaches a store whose client is
  not installed: Scan all imports those signed-in accounts itself). A card's game count, last scan and
  client path share one line (the path's tooltip has it whole) so the account line fits and the modal does not
  scroll. The client-download button is labelled "Get <Store>" so it never reads as the game-level Install.
- **Game detail** modal (opened by A/Enter/tap on a card): hero art with left gradient, logo, platform pill, close
  button, chips (genre, `N playing now` for Steam), description, `Released <date>  <developer>  <publisher>`, action
  bar: Play split-button (menu: alternative emulators, open install folder, open store page, refresh metadata, hide),
  TOTAL PLAY TIME, ACHIEVEMENTS x/y (expands to a list when available), MAIN STORY / MAIN + EXTRAS / COMPLETIONIST,
  then gear (per-game settings: emulator, custom art, title), gauge (quick panel) and star (favorite) icon buttons.
  B/Esc/close returns to the card that opened it. While any modal is open the Home hero art is dimmed
  (`HeroBackdrop dimmed`, design 3.1 "page behind"); the rows stay bright.
  **Uninstalled games** open the same panel (same layout, stats, menu). The Play split button becomes an **Install**
  button of the same size (download icon, same `PLAY_FOCUS_KEY` so focus never jumps) when the game is not installed
  and its source has an install URI (`installGame`); otherwise a "Not installed" chip replaces it. Pressing Install
  shows the toast "Installing <title> through <Store>…", calls `api.installGame(id)` and, while the install is tracked
  (`state/installs.ts`, fed by `install:progress` and `getInstalls()` on load), the button area becomes a progress
  block: a bar with the percent and "<done> / <total>" when measurable, an indeterminate bar with the `message`
  ("Installing through Steam…", "Confirm the install in Steam") otherwise; the menu gains **Cancel tracking** and
  **Open <Store>**, and Play-menu entries that need an install (open install folder, alternative emulators) are hidden.
  When the confirming scan flips `installed` to true the block turns into the Play button in place (the popup stays
  open; `useGame` re-renders from `library:changed`, which for a few named games patches just those games in,
  §4.6 "Library writes"). The `done` event arrives before the debounced library refresh:
  the installs store keeps the `done` entry until the snapshot shows the game installed (`pruneDone` from the library
  store's refresh) and `ActionBar` renders a disabled Play for it, so the Install button never flashes back under a
  held A press. `done` and `failed` installs raise a toast ("<title> is installed" / the tracker's failure message)
  from `App.tsx` next to the session toasts. The main-process `launchGame` refuses uninstalled games, so Play on a
  stale panel can never open a store URI.
- **Settings** modal: Library (sources with status, Emulation folder (its roms folder is the ROM folder; no separate ROM folder setting), ES-DE import, show hidden, "Show games that are not
  installed" = `library.showUninstalled`, default on), Emulators
  (each emulator: detected path or "not found", Browse, cores dir), Metadata (API keys per scraper, art priority,
  auto-scrape, "Use art from installed store clients" = `scrapers.localArt`, "Refresh all"), Appearance (fullscreen,
  clock, recent count, animations, minimize while playing),
  Input (deadzone, vibration, swap A/B), System (launch at login, confirm power actions), About (version, licences).
- **Search** overlay (search icon / Y): text input + on-screen keyboard for gamepad use, live-filtered card grid.
- **Modal transitions**: the backdrop fades and the panel scales from 0.97 (`--dur-modal`); closing reverses it.
  App's ModalHost keeps a closed modal mounted and marks it closing (`hooks/modalClosing.ts`) until its exit
  animation ends. A closing modal releases its focus/action layer at once (`useFocusLayer` `closing`: the layer
  below gets the buttons and focus returns to the opener) while the host freezes directions and A
  (`input/actions.ts` `setInputFrozen`) so the fading controls cannot be activated. `settings.ui.animations` and
  `prefers-reduced-motion` zero every motion token.
- **Quick panel** (gauge icon / power icon): power actions (Exit PlayOut, Minimize, Sleep, Restart, Shut down, with
  confirmation when `confirmPowerActions`), power mode segmented control, brightness and volume sliders, CPU/RAM readout,
  shortcuts to Windows Bluetooth/Wi-Fi/Sound settings.
- **Launching**: a toast `Launching <title>…`; on `launch:error` a dialog with the message and, for missing emulators,
  a button to Settings → Emulators and the emulator's download link.

### 6.2 Input model

- One focus engine for all input methods; mouse hover focuses, click activates; touch tap focuses and activates;
  rows are native horizontal scroll containers (swipe works) and focus changes call `scrollIntoView({ inline: 'center', behavior: 'smooth' })`.
  Long rows can be windowed (`components/WindowedCards.tsx` + `lib/windowing.ts`; the Library grid reuses the same maths per row): only the cards around the
  visible range render, spacers keep the track width so `scrollIntoView` and wheel panning stay correct; `Row`
  publishes its track through `RowTrackContext`), per `docs/research/winhanced-design.md` "Rows are virtualised".
- Keyboard: arrows move, Enter activates, Escape/Backspace back, F = favorite, Tab cycles sections, `/` search, F11 fullscreen.
- Gamepad (standard mapping, polled each animation frame): D-pad / left stick move (repeat after `repeatDelayMs`, then
  every `repeatRateMs`), A activate, B back, X per-screen secondary (detail: play menu), Y search, LB/RB previous/next
  row (home) or section (settings), Start/Menu settings, Back/View quick panel, right stick scrolls descriptions/lists.
  Rumble (vibrationActuator) on activate when enabled. Button glyph hints at the bottom of each screen.
- The last focused card of each row is remembered when moving vertically.

### 6.3 Visual tokens

`src/renderer/src/styles/tokens.css` holds the design tokens from `docs/research/winhanced-design.md` (colors, radii,
blur, shadows, type scale, spacing, motion). Typeface: `"Segoe UI Variable Display", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif`.

### 6.4 Mock API

`src/renderer/src/api/mock/` implements `PlayOutApi` in memory: ~24 games across Steam, Epic, GOG, SNES, PS2 and
Switch with real Steam CDN art URLs, simulated scans (adds games after a delay), launches (fake 5-second sessions),
settings persistence in localStorage, and system status that changes over time. Selected with `?mock=1`, with
`--mock`, or automatically when `window.playout` is undefined. `?screen=library-large` swaps the samples for a
generated library of 600 games (`largeLibrary`), and App opens the Library on a card half-way down, so the grid's
windowing is exercised (`docs/screenshots/library-large.png`).
Store accounts (§4.8): the mock holds a `MOCK_ACCOUNTS` fixture (Steam signed in with a last import, Epic not signed
in, GOG signed in, Xbox not signed in, EA and Battle.net not signed in, Ubisoft unsupported with its reason) and six
to eight owned-not-installed Steam/Epic/GOG games (`installed: false, owned: true`, Steam CDN art) that make the
greyed cards and the Install flow visible; `signIn`, `signOut`, `importOwned`, `installGame` (a ~6 s simulated
download emitting `install:progress`, then `installed: true`), `cancelInstallTracking` and `getInstalls` are
simulated. Screens: `library` (the grid with the greyed cards, `docs/screenshots/library.png`), `library-settings`
(the Settings tab, `docs/screenshots/library-settings.png`), `detail-install` (the detail panel of an owned game with
the Install button, `docs/screenshots/detail-install.png`) and `detail-installing` (the same with a tracked install
at 42 %, mock flag `installing`, `docs/screenshots/detail-installing.png`); `scripts/screenshot.mjs` `SCREENS` and
`App.tsx` `startScreen()` list them.

## 7. Commands

- `npm run dev` — Electron + Vite with HMR. `npm run dev:web` — renderer only in the browser with the mock API.
- `npm run typecheck`, `npm run lint`, `npm run test` (vitest: unit tests for parsers, scanners, launch-command, stores;
  then `node --test "scripts/*.test.mjs"`: packaging invariants in `scripts/packaging.test.mjs`).
- `npm run build:win` — NSIS installer + portable exe in `dist/`.
  app.asar holds `out/{main,preload,renderer}`, `resources/` and the production `node_modules` of package.json
  `dependencies` only (the packages the main/preload bundles externalise: zod, protobufjs, fast-xml-parser, @node-steam/vdf,
  electron-log, @electron-toolkit/*). Renderer-only packages (react, zustand, lucide-react, simple-icons, norigin) are
  bundled by Vite and stay in `devDependencies`; `out/web` and every config file are excluded in `electron-builder.yml`.
- `npm run screenshot [-- home detail ...] [--no-build]` — builds, launches with `--mock --screen=<name> --screenshot=docs/screenshots/<screen>.png` for each screen
  and fails unless every PNG was (re)written during the run (a capture that cannot get the single-instance lock exits 0 without output).
  The screen names are listed in `scripts/screenshot.mjs`; `settings-metadata` opens Settings on the Metadata section
  (the "Use art from installed store clients" toggle).
- `npm run make-icon` — regenerates the application icons; `node scripts/build-systems.mjs [--check]` the system data
  (`systems.json`, `find-rules.json`, `mame-assets.json`).
- `npm run bench:art [-- 300|3000]` — `PLAYOUT_BENCH=1 vitest run src/main/scrapers/metadata-service.bench.test.ts`
  for the 300-game library and then the 3,000-game one (both rows of the acceptance table; a size argument or
  `PLAYOUT_BENCH_GAMES` runs one): the simulated-clock benchmark of §4.6 "Art pipeline" with stub scrapers and local
  caches at the real limiter costs (the local index at its measured **cold** cost); prints time to first cover, to
  90 % of covers, to every cover and to all done, "before" (the single FIFO queue: a recorded profile, not re-run,
  since that code path is gone) against "after" (cover lane + full lane, measured), and asserts the acceptance table
  for both the scan and the owned-import scenario. No network, no user data.
- `npm run scan-art-bench` — `electron . --user-data-dir=%TEMP%\playout-art-bench --art-bench`
  (`src/main/scrapers/art-bench.ts`): the real local-only probe. In that throw-away user-data folder it reads the
  Steam client's `librarycache` on this PC, builds owned-not-installed records for every appid there that no
  `appmanifest_*.acf` lists (plus the installed ones, reported separately), runs `enqueue(ids, { coverOnly: true,
offline: true })` and logs `art-bench: not-installed <n> appids, covers <hits> (<%>) in <ms> ms (first <ms> ms),
index <ms> ms; installed <n>, covers <hits>` per local source, writes the same as
  `%TEMP%\playout-art-bench\art-bench.json` and exits. No window, no network, no sign-in; the real `library.json` and
  `settings.json` are never opened. A re-run first drops the records and media the previous probe left in that
  folder (otherwise nothing would be new and nothing queued) and hands the Steam root it detected to the Steam
  source, so the first lookup measures the index build alone. The report says whether the run was **cold** or
  **warm** (`warm`, `previousRunAt`: a probe within an hour of the previous one reads the ~10,000 image headers from
  the OS file cache and is about twice as fast), and a cited number must say which it is. This is the one probe:
  it is end-to-end (registry lookups + image copies + batched library writes, what the user waits for), not a
  lookups-only timing.
- Smoke test without touching the real library: `npx electron . --windowed --user-data-dir=%TEMP%\playout-check --scan=%TEMP%\scan.json --screenshot=%TEMP%\home.png`.
  The store-accounts smoke (sign-in windows, `accounts.json`) runs under `--user-data-dir=%TEMP%\playout-accounts-check`;
  adding `--remote-debugging-port=<port>` lets a CDP script drive the window and capture the auth window.

## 8. Licensing and attribution

- ES-DE (MIT) — systems and find-rules data derived from `es_systems.xml` / `es_find_rules.xml`; Playnite (MIT) —
  store detection logic and Battle.net product table. Both notices are reproduced in `docs/LICENSES.md` and in About.
- SteamGridDB, IGDB, ScreenScraper, TheGamesDB and HowLongToBeat data are fetched with the user's own credentials
  where required; attribution lines are shown in About and next to scraped art in the detail panel's gear menu.
