# Completeness review of the GameDash research package

Reviewer: completeness critic (task `completeness-critic`), 2026-10-29. Scope: every `.md` report in the research
directory read in full (`esde-systems.md`, `playnite-stores.md`, `winhanced-design.md`, `metadata-apis.md`,
`electron-stack.md`, `retroarch-cores.md`), every `.json`/`.yaml` data file parsed and sampled, and the evidence
directories (`repos\`, `live\`, `images\`, `crops\`, `scripts\`) checked for existence. Several claims were re-verified
read-only on this PC (commands and outputs below). Nothing was launched, installed or changed.

Path abbreviation used below: `<SP>` =
`C:\Users\<user>\AppData\Local\Temp\<scratch>`
(research files are in `<SP>\research\`, cloned sources in `<SP>\repos\`, live HTTP evidence in `<SP>\live\`).

## 1. Data-file validation (all parse; counts match the reports)

| File | Result |
|---|---|
| `esde-systems.json` | array of 195 systems, 989 commands, no entry missing `name/path/extensions/commands`; `platform` set on all 195; 142 distinct platform tokens. ES-DE names include `n3ds` (not `3ds`), `gc`, `genesis` and `megadrive`, `pcengine` and `tg16`, `mame`, `pc`, `dos`. |
| `esde-find-rules.json` | keys `source, ruleTypes, variables, findRules (128), findRulesPortable (128), retroarchCoresReferencedBySystems (173), emulatorsReferencedBySystems (125), emulatorsReferencedButWithoutFindRule ([]), findRulesNotReferencedByAnySystem (["PLAY!","STEAM"])`; every entry has rules; RETROARCH entry carries the documented winregistrypath/systempath/staticpath chain. |
| `esde-scraper-platforms.json` | 147 platforms `{screenscraperId, thegamesdbId, enumName, description, systems[]}`; 6 without ScreenScraper id (`flash, love, mess, mugen, residualvm, zxnext`), 33 without TheGamesDB id, **0 entries carry an IGDB id** (field absent). |
| `platform-ids.json` | 42 keys `{igdb, screenscraper, thegamesdb}`; 41 keys are ES-DE system names, **`3ds` is not** (ES-DE folder is `n3ds`); **154 of the 195 ES-DE systems have no row**. |
| `esde-systems-table.json` / `esde-systems-sorting.json` | 195 rows / 196 systems, well-formed. |
| `battlenet-products.json` | keys `_source, client, product_db, registry_detection, actions, products (35), field_semantics`; well-formed. |
| `Emulators.yaml`, `Platforms.yaml`, `Regions.yaml`, `Emulation\` | 95 `- Id:` emulator documents (95 `emulator.yaml` dirs), 95 `- Name:` platforms (report says 96; one-off, harmless), 79 platforms carry `IgdbId`, 23 regions. |
| `images\1.webp`, `2.webp`, `crops\` (28 PNG), `live\` (Steam/GOG/Epic/HLTB/IGDB/SGDB/TGDB/ScreenScraper evidence), `scripts\` (extract-*.ps1, img.js, pstest.js, regtest*.js) | all present as the reports claim. |

## 2. Cross-report checks done on this PC (read-only)

* **EA app** (contradicts `playnite-stores.md` §4.4 "EA app installed, no game installed" and `electron-stack.md` §8.3):
  `HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\{C05D8CDB-417D-4335-A38C-A0659EDFD6B8}`
  ("The Sims™ 3", Publisher "Electronic Arts Inc.", `InstallLocation = C:\Program Files\EA Games\The Sims 3\`) plus 20
  `..._The Sims 3 <pack>` DLC entries, `HKLM\SOFTWARE\WOW6432Node\Sims\The Sims 3` (`Install Dir`, `ProductID 1001`,
  `SKU 7`, `Product GUID`), `C:\ProgramData\EA Desktop\InstallData\The Sims 3\base-422ce467-cb9c-46bc-a32d-25ac0129ace5\map.eacrc`
  (36,296 bytes) and 20 `dlc-<guid|Origin.SFT.50.00000xx>\map.eacrc` files, and `C:\ProgramData\Origin\LocalContent\Madden NFL 26\`
  (empty directory) all exist — **but `C:\Program Files\EA Games\The Sims 3` does not exist** (`C:\Program Files\EA Games`
  is empty). So the registry/InstallData footprint of an *uninstalled* EA game survives: any EA heuristic without a file
  existence check produces false positives. `map.eacrc` records start with the ASCII magic `E4X$01`, then 4 bytes,
  then a big-endian `u16` length and a relative path (`__Installer/installerdata.xml`, `__Installer/directx/eula/en_US.txt`, ...)
  — a per-file checksum map, not an install-root pointer.
* **Xbox / Game Pass**: `Get-AppxPackage | ? { $_.SignatureKind -eq 'Store' -and -not $_.IsFramework -and -not $_.IsResourcePackage -and $_.InstallLocation -and (Test-Path (Join-Path $_.InstallLocation 'MicrosoftGame.config')) }`
  returns exactly the two Xbox games on this PC (`Xbox360BackwardCompatibil.PrimaryConkerLiveReloade_ksqcvrsvwz2jp`,
  `Xbox360BackwardCompatibil.PrimaryFuzionFrenzyFuzio_ksqcvrsvwz2jp`, both under `C:\Program Files\WindowsApps\...`) out of
  57 Store packages. `C:\XboxGames\Conker- Live and Reloaded\Content\MicrosoftGame.config` carries
  `Identity@Name/@Publisher/@Version`, `ShellVisuals@DefaultDisplayName="Conker: Live and Reloaded"`, `@Square150x150Logo`,
  `ExecutableList/Executable@Name="EmuMenu\EmuMenu.exe" @Id="App" @TargetDeviceFamily="PC"`, `MSAAppId`, `TitleId 27028FBB`,
  `StoreId BVFB8CBS75R6`. `HKLM\SOFTWARE\Microsoft\GamingServices\PackageRepository\Root\<guid>#<guid>` subkeys exist but their
  `Package`/`Root` values read empty from PowerShell (electron-stack §8.3 reports values; the data may sit on a sub-key).
  WMI `Win32_Process.ExecutablePath` IS populated for processes under `C:\Program Files\WindowsApps\...` for a standard
  user (observed `Claude.exe`, `CrossDeviceService.exe`); 202 of the running processes have a null path (system/protected).
* **Store launch URIs in the Playnite sources** (`<SP>\repos\playnite-extensions-codeberg\source\Libraries\...`):
  Epic `EpicLauncher.cs:18` = `com.epicgames.launcher://apps/{0}%3A{1}%3A{2}?action=launch&silent=true`;
  Ubisoft `UplayLibrary\Uplay.cs:90` = `uplay://launch/{gameId}` (no `/0`); Battle.net `BattleNetGameController.cs:216` =
  `Battle.net.exe --exec="launch <GameId>"`; EA (Jeshibu) `<SP>\repos\dl\jeshibu\EaControllerHelper.cs:23` =
  `origin2://game/launch/?offerIds=<contentId>`. `electron-stack.md` §7.1 lists different forms for Epic
  (`apps/<AppName>?action=launch`), Ubisoft (`launch/<gameId>/0`), EA (`origin2://game/launch?offerIds=`, `link2ea://launchgame/...`),
  Battle.net (`battlenet://<productCode>`) and presents `goggalaxy://openGameView/<productId>` as the GOG launch.
* **System-bar actions**: `netsh wlan show networks mode=bssid` works as a standard user (4 networks; per-BSSID
  `Authentication`, `Encryption`, `Signal`, `Radio type`, `Band`, `Channel`); `netsh wlan show profiles` lists 14 saved
  profiles; `Get-PnpDevice -Class Bluetooth` mixes enumerators/services with real devices (e.g. "MX Anywhere 3S").
* **Epic V2**: `%LOCALAPPDATA%\Epic Games\Launcher\EpicGamesLauncher.exe` and `%LOCALAPPDATA%\com.epicgames.eglv2` are
  absent on this PC (legacy launcher only), as the reports say.
* **IGDB sources available offline**: `<SP>\repos\romm\igdb.py` `IGDB_PLATFORM_LIST` (460 slug entries with `id`, e.g.
  `UPS.N3DS -> id 37, slug "3ds"`), `<SP>\research\Platforms.yaml` (`nintendo_3ds: IgdbId 37`). A draft full table already
  exists outside the research package in `<SP>\gen-platform-ids.mjs` (written by another agent from memory, unverified).

## 3. Contradictions between reports (an implementer following only one of them gets incompatible code)

| Topic | winhanced-design.md | electron-stack.md |
|---|---|---|
| Scaling | §4: every length `N * var(--u)`, `--u: clamp(0.62px, calc(100vh / 1080), 2.5px)` | §9.3: `html { font-size: calc(100vh / 45) }`, rem/vh layout, `--tile-w: 14rem` |
| Font | §4/§5: `"Segoe UI Variable Display"` / `"Segoe UI Variable Text"` -> `Segoe UI` -> `Selawik` -> `system-ui` | §9.3: `font: 1rem/1.3 "Inter Variable", system-ui` |
| Background | §2.1/§4: `#1f1f1f` | §9.1: `backgroundColor: '#0b0f14'` |
| Focus engine | §6.2: custom `{rowId, index}` rows, remembered column per row, no wrap + bump, XY geometry only inside popups | §4.2/§4.3/§11.6: Norigin spatial navigation (`init({ shouldFocusDOMNode: true, distanceCalculationMethod: 'center' })`, `useFocusable`) |
| Row scrolling / touch | §6.6/§6.7: `transform: translateX(-offset)`, hand-rolled momentum (0.0025 u/ms²) and snapping | §5.2: native `overflow-x: auto; scroll-snap-type: x proximity`, "Keep kinetic scrolling native; do not re-implement momentum" |
| Stick thresholds | §6.4: press at ±0.5, release at ±0.35 (hysteresis), dead zone 0.25 | §4.2: `DIGITAL_THRESHOLD = 0.6`, no hysteresis, dead zone 0.25 |
| Key map | §6.5: `F1`/`Ctrl+Space` = View (system bar), `ContextMenu`/`Shift+F10` = Menu, `Tab` = DOM fallback | §4.2: `BUTTON_KEY 9 (Menu) -> 'F1' /* menu */`, `8 (View) -> 'Tab'` |
| Launch URIs | — | §7.1 vs `playnite-stores.md` §4.2/4.3/4.5/4.6 and the sources quoted in section 2 above |
| Session tracking | `playnite-stores.md`: EA waits 40 s with EAC/`Activation.*`; Ubisoft waits for a `UbisoftGameLauncher` process, then 2 s (10 s for id 635); Playnite stops on the first empty poll, no startup timeout | §7.4: generic 2-miss grace, 120 s startup timeout, no per-store rules |

## 4. Gaps, most important first (also returned as the structured result)

1. **ea-app-local-enumeration** — no verified login-free way to list installed EA app games or to launch them; this PC's
   stale Sims 3 footprint shows that registry/InstallData-only heuristics are wrong; `map.eacrc` is only partially decoded;
   `C:\ProgramData\Origin\LocalContent\<Game>\*.mfst` was never examined; launch URI unpinned.
2. **ui-contract-contradictions** — see section 3; decide that `winhanced-design.md` §4–§6 is the UI/input contract and
   that `electron-stack.md` §4.2 key map, §5.2 row CSS, §9.1 background and §9.3 CSS are superseded (or the reverse).
3. **store-launch-uris-and-tracking-quirks** — pin Epic/Ubisoft/GOG/Battle.net/EA launch commands to the Playnite sources
   and carry the per-store tracking delays into the generic tracker.
4. **xbox-game-classification** — adopt the `MicrosoftGame.config` rule (verified here: 2 of 57 packages), confirm it for
   Game Pass titles installed under `C:\XboxGames\<Title>\Content`, and confirm their processes expose `ExecutablePath`.
5. **rom-platform-id-mapping** — one table for all 195 ES-DE systems with IGDB ids (the package has 42 keys, one misnamed).
6. **scraper-credential-strategy** — ScreenScraper needs software-level dev credentials (users cannot supply them); IGDB
   needs a Twitch client id + secret; decide what ships vs. what the user enters; request the ScreenScraper dev id early.
7. **guide-button-overlay-feasibility** — the design's Guide-button overlay cannot receive XInput while a game has focus
   with the chosen no-native-module stack; `buttons[16]` delivery is unverified even when focused.
8. **system-bar-actions** — Wi-Fi network list/connect, Bluetooth device list/connect, volume SET and radio toggles have no
   verified commands (only GET paths were verified).
9. **hltb-search-flow-unexecuted** — `/api/search/site/init` + `x-auth-token` POST never executed; path rotates.
10. **epic-eglv2-and-item-manifests-unverified-locally** — both Epic launcher generations documented from code only.
11. **battlenet-ubisoft-local-formats-unverified** — `product.db` protobuf and Ubisoft `configurations` cache from code /
    third-party `.proto` only; no client on this PC.
12. **installer-build-unverified** — `electron-builder --win` never run; `asarUnpack` of `ps-list`'s `fastlist` exe and the
    portable `PORTABLE_EXECUTABLE_*` variables untested.

Each gap's precise question, why it matters and where to look are in the structured result.

## 5. Resolved across reports (do not re-research)

* TheGamesDB key issuing: `https://api.thegamesdb.net/key.php` after forum login (metadata-apis §4.1) answers the
  esde-systems open question; 418 without a key, 403 on bad key/rate cap.
* Steam play time without sign-in: `userdata\<accountid>\config\localconfig.vdf` -> `UserLocalConfigStore/Software/Valve/Steam/apps/<appid>/Playtime` (minutes) and `LastPlayed` (unix seconds) (metadata-apis §5.4) resolves playnite-stores' open question; `HKCU\Software\Valve\Steam\ActiveProcess\ActiveUser` gives the account id.
* Steam local icon: `appcache\librarycache\<appid>\<sha1>.jpg` (metadata-apis §5.2/5.4) supersedes playnite-stores' UNVERIFIED `steam\games\<clienticon>.ico`.
* Directory matcher: electron-stack §7.4 adopts Playnite core's `StartsWith(realPath + '\')` rule (WQL `LIKE '<dir>\\%'`), closing playnite-stores' decision item.
* Registry reads: PowerShell `Get-Item`/`GetValue(..., 'DoNotExpandEnvironmentNames')` through the worker (electron-stack §8.2) makes the ES-DE `RRF_RT_REG_SZ`/`REG_EXPAND_SZ` question moot for GameDash (expand `ExpandString` values with `process.env`).

## 6. Minor issues noted but not listed as gaps

* `esde-systems.md` §0: tarball == commit `ef267ae6` unproven; irrelevant to implementation (version string is in-tree).
* `winhanced-design.md` §1.1/§8.1: `2.webp` is a 1920x1200 capture; the 1080p modal margins (60 px) are a design choice.
* `playnite-stores.md` §2 says 96 platforms; `Platforms.yaml` has 95 `- Name:` entries.
* `electron-stack.md` §1.4: `app.getPath('cache')` reported as `%APPDATA%` — not re-verified; keep caches under `userData` as the report recommends anyway.
* `electron-stack.md` §8.3 and `playnite-stores.md` §4.4 describe this PC as "EA app installed, no game installed": true for files, false for registry/InstallData (section 2).
* Steam `GameID` 64-bit bit layout (mods) remains UNVERIFIED; v1 can ignore GoldSrc/Source mods.
* SteamGridDB rate limits / attribution, IGDB enum tails (game_type 11–14, regions 3–10), GOG/Epic endpoint terms remain UNVERIFIED as the reports state; none blocks implementation (handle 429 generically, expand enums by name).
