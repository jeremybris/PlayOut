# Store accounts: sign-in, owned-library import, install URIs and install progress

Consolidated research, 2026-11-01, for the Library "Settings" tab (store accounts), greyed owned-but-not-installed
cards and the background install tracker (`docs/ARCHITECTURE.md` §4.8, §6.1). One section per store. Everything
marked VERIFIED was read from current source or observed on this PC / over the network (anonymously, no form
submitted, no sign-in, no install started); UNVERIFIED items are collected per store and must be confirmed during the
first real run under `--user-data-dir=%TEMP%\playout-accounts-check`.

Sources: Playnite extensions (Codeberg `CrowIsTaken/PlayniteExtensions@main10`, byte-identical to the archived GitHub
copy except where noted), Jeshibu `EaLibrary`, legendary, lutris, Heroic + heroic-gogdl, minigalaxy, the
FriendsOfGalaxy GOG plugins (battlenet, uplay, origin, epic), xbox-webapi-python, xodus, gogapidocs, Valve partner docs,
Microsoft Learn, plus `docs/research/playnite-stores.md` and `docs/research/metadata-apis.md`. Raw copies of the files
read live in the research scratchpad (`...\scratchpad\dl\`, `...\scratchpad\epic\`, `...\scratchpad\gog-src\`,
`...\scratchpad\xbox-src\`); the quotes below are what the implementation relies on.

## 0. Feasibility table

Rule applied: a store is **supported** (account sign-in + owned import in this release) only when its login URL, the
redirect/token capture and the owned-games endpoint are HIGH confidence from source evidence; MEDIUM is supported
only when the endpoints are quoted from current source below; LOW means **installed games only**, with the
user-facing reason the Settings tab shows.

| Store | Import supported in this release | Confidence | Reason |
|---|---|---|---|
| Steam | yes: web sign-in (store cookie session + `webapi_token`) **and** API key + SteamID64 from `settings.scrapers.steam` | high | login page, `application_config` scrape, `GetOwnedGames` request/response and 401 shape all verified; Playnite source for the logged-in fields |
| Epic Games | yes | medium | authorization-code flow, token exchange, `/library/api/public/items` and catalog bulk lookup quoted from Playnite + legendary; redirect JSON shape and 401s verified live; token POST not exercised; login page sits behind a Cloudflare JS challenge (fine in a BrowserWindow, UNVERIFIED) |
| GOG | yes | medium | OAuth code flow (`46899977096215655` client pair), `getFilteredProducts` paging and `users.gog.com` quoted from minigalaxy/lutris/Heroic/gogapidocs; login redirect chain and anonymous 302/401 answers verified; authenticated bodies from source only |
| Xbox / Microsoft Store | yes, with a documented limit: the account import lists titles **played at least once** (titlehub title history), never-played purchases stay invisible until the Collections API is added | medium | Playnite code flow (login page, token endpoint error shape, XBL/XSTS) verified live/negative; titlehub/userstats bodies from source only |
| Battle.net | yes | medium | cookie-session scrape of `account.battle.net/api/*` (Playnite + GOG plugin): login redirect chain, 401 JSON and endpoint shapes verified; undocumented internal API, so stability is medium |
| EA app | yes (experimental) | medium | Jeshibu addon flow: ea.com web session + sniffed `Authorization: Bearer` for the Juno GraphQL API; `getPreloadedOwnedGames` 401 shape verified, `legacyOffers` verified 200 anonymously; the persisted-query hashes and `www.ea.com/login` (bot-protected for curl) are website internals that may rotate |
| Ubisoft Connect | **no: installed games only** | low | Playnite has no account import; the only known owned-games endpoint (`clubgraphql`) answers 403 for the public app id. Reason shown: "Ubisoft does not offer a sign-in that PlayOut can use; your owned games come from the Ubisoft Connect client." A later release may read the client's own `cache\ownership\<userId>` file (§7.4), which needs no PlayOut sign-in |

Install progress grades (what the tracker can show): Steam **measured** (ACF bytes), Epic **state-only + measured
fallback** (install-dir growth vs `InstallSize`), GOG **measured** (file count from `GalaxyClient.log`), Xbox
**measured (approximate)** (folder growth vs catalog `MaxDownloadSizeInBytes`), Battle.net **measured** (`product.db`
`update_progress`), EA **measured** (bytes + rate + ETA from `EADesktopVerbose.log`), Ubisoft **state-only**.

Common facts: no store starts a download silently from a URI; every install URI opens the store client's own install
dialog (location / shortcuts / EULA) and the download starts after the user confirms there. PlayOut therefore says
"Confirm the install in <Store>" while the tracker is in `starting`, and treats "no manifest/log line yet" as that
state, not as a failure.

## 1. Steam

### 1.1 Web sign-in (cookie session + webapi_token)

Steam has no OAuth client for third parties. Playnite (`SteamLibrary/Services/SteamStoreService.cs:110-163`) drives
a browser view and reads the token the store page embeds for its own JS:

1. Window 600x720, cookies cleared for `.steamcommunity.com`, `steamcommunity.com`, `steampowered.com`,
   `store.steampowered.com`, `help.steampowered.com`, `login.steampowered.com`.
2. Navigate `https://store.steampowered.com/explore/`. VERIFIED anonymous: `302` ->
   `https://store.steampowered.com/login/?redir=explore%2F&redir_ssl=1` (`200`, `<title>Sign In</title>`, login
   app from `login.steampowered.com`).
3. On every page load whose URL does not contain `/login`, read `<div id="application_config">`:
   `data-userinfo` -> `{ "logged_in": bool, "steamid": "7656119...", "account_name": "..." }`;
   `data-store_user_config` -> `{ "webapi_token": "<JWT>" }`. Done when `webapi_token` is non-empty.
   VERIFIED anonymous on `/`, `/app/620/` and the login page: the element exists with
   `data-userinfo="{"logged_in":false,"country_code":"US",...}"` and `data-store_user_config="{"webapi_token":"",...}"`.
   The logged-in field names (`steamid`, `account_name`) come from Playnite's models (UNVERIFIED here).
4. Refresh: load `/explore/` again in a hidden window on the same partition and re-read `webapi_token`; a `/login`
   URL means the cookie session is gone -> "not signed in". The durable credential is the **cookie jar** of the
   partition (`steamLoginSecure` = `<steamid64>%7C%7C<JWT>`, `sessionid`, long-lived `steamRefresh_steam` on
   `login.steampowered.com`: names from public documentation, UNVERIFIED); the `webapi_token` is a short-lived JWT
   (community: about 24 h) re-minted from the page whenever a Web API call answers 401.

Electron mapping: child `BrowserWindow` on `persist:account-steam`, `loadURL('https://store.steampowered.com/explore/')`,
on `did-navigate` / `did-finish-load` skip `/login` URLs, then
`webContents.executeJavaScript('(()=>{const e=document.getElementById("application_config");return e&&{u:e.dataset.userinfo,c:e.dataset.store_user_config}})()')`.
Persist `{ steamId64, accountName, webapiToken, capturedAt }` through the token store (§8); the Settings row shows
`accountName`. Sign-out = delete the tokens + `session.fromPartition('persist:account-steam').clearStorageData()`.

Steam ID without any sign-in (already in `providers/steam.ts`): `config\loginusers.vdf` (`AccountName`,
`PersonaName`, `MostRecent`) or `HKCU\Software\Valve\Steam\ActiveProcess\ActiveUser` + `76561197960265728`.

### 1.2 API-key path

Key page `https://steamcommunity.com/dev/apikey` (100 000 calls/day). `settings.scrapers.steam.apiKey` +
`steamId64` already exist; the importer is the same code with `key=` instead of `access_token=`. Playnite's
equivalent is the `IsPrivateAccount` setting (`GetOwnedGamesApiKey`). Status for this path: "signed in" when a
`GetOwnedGames` call with the key succeeds; the row shows the persona name from `loginusers.vdf` when the id matches,
else the SteamID64.

### 1.3 Owned-games endpoints

Playnite `SteamApiServiceBase.Get` (`baseUrl?` + query; retries 5x5 s on HTTP 429 only: "Steam Web API likes to
return 429 even if you don't make a request in several hours"); every response is wrapped in `{ "response": ... }`.

- `GET https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/` with `format=json`,
  `access_token=<webapi_token>` **or** `key=<apikey>`, `steamid=<steamid64>`, `include_appinfo=true`,
  `include_played_free_games=true`, `include_free_sub=false`, `language=english` (`PlayerService.cs:41-50`; the
  partner doc documents `key`, `steamid`, `include_appinfo`, `include_played_free_games`, `appids_filter`).
  Response: `{"response":{"game_count":N,"games":[{"appid":620,"name":"Portal 2","playtime_forever":1108,
  "img_icon_url":"<hash>","rtime_last_played":1777548408,"playtime_2weeks":..,"playtime_disconnected":..}]}}`.
  No paging. `playtime_forever` is minutes; `rtime_last_played` unix seconds (drop 0 and anything before 2004).
  Anonymous / bad token: `HTTP 401 Access is denied. Retrying will not help. Please verify your key= parameter.`
  (VERIFIED). The list excludes demos/refunded titles and DLC; non-game apps can appear: filter with the existing
  `NON_GAME_APP_IDS` rules in `providers/steam.ts`. Icon:
  `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/<appid>/<img_icon_url>.jpg`.
- `GET .../IPlayerService/ClientGetLastPlayedTimes/v1/?access_token=|key=&min_last_played=0` -> `games[]` of the
  token owner with `appid, last_playtime, playtime_forever, playtime_disconnected, first_playtime, ...`.
  Playnite credits `(playtime_forever + playtime_disconnected) * 60` and only ever raises values. Anonymous:
  `200 {"response":{}}` + `X-eresult: 1` (VERIFIED).
- `GET .../IClientCommService/GetClientAppList/v1/?fields=games&access_token=&language=` (needs the running Steam
  client, same account): `apps[{appid, app, app_type, installed, running, bytes_required}]` -> install size for the
  progress label before an ACF exists, `app_type` for filtering. 401 on a bad token (VERIFIED).
- Cookie-only fallback `GET https://store.steampowered.com/dynamicstore/userdata/` -> `rgOwnedApps:[appid,...]`
  (includes DLC and every app type; needs per-app `appdetails` to type them: last resort only).
- Family sharing (`IFamilyGroupsService/GetFamilyGroupForUser`, `GetSharedLibraryApps`) and parental controls
  (`IParentalService/GetParentalSettings`) exist (token only, 401 anonymous VERIFIED); optional later.
- Public profile XML (`/profiles/<id64>/games/?xml=1`) now redirects to login even for public profiles: dead.

Merge rules copied from Playnite's `SteamServiceAggregator`: installed ACF games first; account games overwrite the
name, fill play time when 0, fill install size / last activity; final filter non-blank name.

### 1.4 Art for owned app ids

CDN, no auth, `Cache-Control: public, max-age=604800` (VERIFIED for 620): cover
`https://cdn.cloudflare.steamstatic.com/steam/apps/<appid>/library_600x900_2x.jpg` (600x900), hero
`.../library_hero.jpg` (1920x620), logo `.../logo.png`; also `header.jpg`, `capsule_616x353.jpg`. 404 when missing
-> SteamGridDB `/grids/steam/<appid>`. Local shortcut: `<SteamPath>\appcache\librarycache\` holds art for
owned-but-uninstalled games too (9 789 folders vs 40 installed games here): `findLibraryCacheArt` in
`providers/steam.ts` first, CDN second.

### 1.5 Install URI

`HKCR\steam\Shell\Open\Command` = `"C:\Program Files (x86)\Steam\Steam.exe" -- "%1"` (VERIFIED). Playnite
(`SteamGameController.cs:29-46`) opens `steam://install/<appid>` (refuses mods); lutris does the same. Also
`steam://uninstall/<appid>`, `steam://rungameid/<appid>` (opens the install dialog for an uninstalled app),
`steam://open/downloads`, `steam://validate/<appid>`. The URI brings the Steam client forward with its "Install -
<game>" dialog; the download starts after the user confirms (no silent install for a user library; UNVERIFIED here).
If Steam is not running the URI starts it (login prompt possible).

### 1.6 Install progress (grade: measured)

1. `<library>\steamapps\appmanifest_<appid>.acf` (VERIFIED on 40 ACFs): `"AppState" { appid, name, StateFlags,
   installdir, lastupdated, SizeOnDisk, StagingSize, buildid, LastOwner, BytesToDownload, BytesDownloaded,
   BytesToStage, BytesStaged, TargetBuildID, InstalledDepots {...} }`. Download % = `BytesDownloaded /
   BytesToDownload`; `BytesToStage` is the eventual install size. Done = `(StateFlags & 4) != 0` **and**
   `<library>\steamapps\common\<installdir>` exists (Playnite `SteamLocalService.cs:80-116`, lutris `is_installed`).
   Caveats: Steam writes `appmanifest_<id>.acf.tmp` then renames (tolerate read failures); the Bytes* keys are left
   over from the last update, so only treat them as progress while bit 4 is clear or `TargetBuildID != buildid`;
   never use bit 64 (AppRunning) for state (stale `StateFlags 68` seen here). Playnite's enum: Uninstalled 1,
   UpdateRequired 2, FullyInstalled 4, Encrypted 8, Locked 16, FilesMissing 32, AppRunning 64, FilesCorrupt 128,
   UpdateRunning 256, UpdatePaused 512, UpdateStarted 1024, Uninstalling 2048, ... In-flight values 1026 / 1030 /
   1542 (paused) are community knowledge (UNVERIFIED). The ACF appears in the chosen library only after the user
   confirms Steam's dialog; cancelling deletes it and `steamapps\downloading\<appid>`. Poll every 2 s across every
   library folder (`libraryfolders.vdf`); `fs.watch` on each `steamapps` dir is a bonus, not a requirement.
2. `<SteamPath>\logs\content_log.txt` (+ `content_log.previous.txt` on rotation), lines
   `[YYYY-MM-DD HH:MM:SS] AppID <id> <event>` (VERIFIED full lifecycle of a fresh install, appid 35140):
   `state changed : Update Required,` -> `...,Update Queued,` -> `...,Update Running,` ->
   `update started : download 0/7789490880, store 0/0, reuse 0/0, delta 0/0, stage 0/8471095333` ->
   `App update changed : Running Update,Downloading,Staging,` -> `...,Verifying Staged,` -> `...,Committing,` ->
   `starting commit from "...\steamapps\downloading\35140" to "...\steamapps\common\<dir>"` ->
   `state changed : Fully Installed,Update Queued,Update Running,` -> `finished update, N mounted depots` ->
   `state changed : Fully Installed,` -> `scheduler finished : removed from schedule (result No Error, state 0xc)`.
   Pause: `update canceled : Priority (Suspended)` / `... (Suspended)` suffixes; resume repeats `update started :
   download <done>/<total>, ..., stage <done>/<total>` with running totals; uninstall `state changed : Uninstalled,`.
   `Current download rate: N Mbps` every ~61 s. Tail by byte offset, re-open when the size shrinks. Gives queued /
   downloading / paused / committing / installed within a second plus the totals for the first label; the scheduler's
   hex `state 0x..` has its own layout and is not the ACF StateFlags.
3. `HKCU\Software\Valve\Steam\Apps\<appid>` `Installed`, `Updating`, `Running`, `Name` (VERIFIED; stale entries exist
   for uninstalled apps, so `Installed` only counts together with the ACF).
4. `<library>\steamapps\downloading\<appid>\` size growth vs `BytesToStage` / `bytes_required`: fallback when the ACF
   cannot be read; the folder disappears on commit or cancel.

State mapping: `starting` = URI sent, no ACF and no log line yet ("Confirm the install in Steam"); `queued` = log
`Update Queued` or ACF with bit 4 clear and `BytesDownloaded == 0`; `downloading` = Bytes* changing or log
`Downloading,Staging`; `installing` = log `Committing` / `Verifying Staged`; `done` = ACF bit 4 + install dir exists
(the normal scan's rule); failed/cancelled = ACF deleted and `downloading\<appid>` gone, or log `state changed :
Uninstalled,` before any `Fully Installed`; 30-minute no-change timeout per the shared tracker rule.

### 1.7 Not verified

Logged-in `data-userinfo` shape and `webapi_token` lifetime; cookie names; `GetOwnedGames` params `include_free_sub`,
`language` and response fields beyond `appid, name, playtime_forever, rtime_last_played, img_icon_url`; real bodies of
`GetClientAppList`, `ClientGetLastPlayedTimes`; `steam://install` dialog behaviour; ACF appearance timing and rewrite
cadence; in-flight StateFlags values; cancel wording in the log.

## 2. Epic Games Store

### 2.1 Sign-in (authorization code)

Constants (Playnite `EpicLibrary/Services/EpicAccountClient.cs`, legendary `api/egs.py`):

- Login URL for the BrowserWindow (legendary `get_auth_url()`):
  `https://www.epicgames.com/id/login?redirectUrl=` + urlencoded
  `https://www.epicgames.com/id/api/redirect?clientId=34a02cf8f4414e29b15921876da36f9a&responseType=code`.
  Playnite uses the plain `https://www.epicgames.com/id/login?responseType=code` with
  `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) EpicGamesLauncher` ("needed otherwise captcha won't pass")
  after `DeleteDomainCookies(".epicgames.com")`.
- Capture: after sign-in the page lands on `/id/api/redirect?...`, a JSON document
  `{"redirectUrl":"https://localhost/launcher/authorized?code=<code>","authorizationCode":"<code>","exchangeCode":null,"sid":"..."}`.
  Playnite regex-matches `localhost\/launcher\/authorized\?code=([a-zA-Z0-9]+)` over the page source; PlayOut reads
  `document.body.innerText`, `JSON.parse(...).authorizationCode`, regex fallback. VERIFIED anonymous:
  `GET https://www.epicgames.com/id/api/redirect?clientId=34a02cf8f4414e29b15921876da36f9a&responseType=code` ->
  `200 {"warning":"Do not share this code ...","redirectUrl":"https://localhost/launcher/authorized","authorizationCode":null,"exchangeCode":null,"sid":null}`.
  `GET https://www.epicgames.com/id/login` -> 200 SPA shell; the full URL with `redirectUrl=` -> `403 Cf-Mitigated:
  challenge` for curl (Cloudflare JS challenge; a real BrowserWindow runs JS: UNVERIFIED in Electron).
- Token exchange: `POST https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/token`, header
  `Authorization: basic MzRhMDJjZjhmNDQxNGUyOWIxNTkyMTg3NmRhMzZmOWE6ZGFhZmJjY2M3Mzc3NDUwMzlkZmZlNTNkOTRmYzc2Y2Y=`
  (= base64 of `34a02cf8f4414e29b15921876da36f9a:daafbccc737745039dffe53d94fc76cf`, the public Epic Games Launcher
  client), `Content-Type: application/x-www-form-urlencoded`, body
  `grant_type=authorization_code&code=<code>&token_type=eg1`; refresh body
  `grant_type=refresh_token&refresh_token=<rt>&token_type=eg1`. Response: `access_token, expires_in, expires_at,
  token_type ("bearer"), refresh_token, refresh_expires, refresh_expires_at, account_id, client_id, ...`.
  Error shape `{ errorCode, errorMessage, numericErrorCode, originatingService, intent }`; legendary special-cases
  `errors.com.epicgames.oauth.corrective_action_required` (`continuationUrl` the user must open). Token POST not
  exercised from this sandbox. Lifetimes (legendary behaviour, UNVERIFIED): access ~8 h, refresh ~30 d; refresh
  proactively before an import and once more on any `errorCode` answer.
- Authenticated calls: `Authorization: bearer <access_token>`. Session / display name:
  `GET .../account/api/public/account/<account_id>` -> `{ id, displayName }` (signed in iff `id == account_id`).
- Hosts VERIFIED in `C:\Program Files\Epic Games\Launcher\Portal\Config\DefaultPortalRegions.ini`:
  account `account-public-service-prod03.ol.epicgames.com`, catalog `catalog-public-service-prod06.ol.epicgames.com`,
  library `library-service.live.use1a.on.epicgames.com`. Hard-coding is fine.

### 2.2 Owned games

- `GET https://library-service.live.use1a.on.epicgames.com/library/api/public/items?includeMetadata=true&platform=Windows`
  -> `{ "responseMetadata": { "nextCursor": string|null, "stateToken" }, "records": [ { appName, labelName,
  buildVersion, catalogItemId, namespace, assetId, sandboxType } ] }`; page with `&cursor=<nextCursor>` until null.
  VERIFIED anonymous: `401 {"errorCode":"errors.com.epicgames.common.authentication.authentication_failed",...,
  "numericErrorCode":1032,"originatingService":"library-service"}`.
  Pre-filter (Playnite `GetLibraryGames`): keep `namespace != "ue"`, `sandboxType != "PRIVATE"`, non-empty `appName`.
- Catalog: `GET https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/namespace/<namespace>/bulk/items?id=<catalogItemId>&country=US&locale=en-US&includeMainGameDetails=true`
  (`id` repeatable per namespace; legendary adds `includeDLCDetails=true`). Response: dictionary item id ->
  `{ id, title, description, keyImages:[{type,url}], categories:[{path}], namespace, customAttributes:{k:{type,value}},
  entitlementType, itemType, releaseInfo:[{appId, platform[], dateAdded}], developer, mainGameItem:{id} }`.
  VERIFIED anonymous: 401 (same error shape). Cache each item on disk as `<ns>_<catalogItemId>_<buildVersion>.json`
  and re-fetch only when `buildVersion` changes (Playnite).
  Filters: keep items with a category `path == "applications"`; skip `mainGameItem != null` unless categories contain
  `addons/launchable`; skip `digitalextras`, `plugins`, `plugins/engine`, `mods`; `customAttributes.ThirdPartyManagedApp
  == "the ea app"` -> EA-managed and `customAttributes.partnerLinkType == "ubisoft"` -> Ubisoft-managed: **skip by
  default** (they duplicate the EA/Ubisoft providers and cannot be installed through the Epic client alone; the
  keyless map `%ProgramData%\Epic\EpicGamesLauncher\Data\ThirPartyManagedApps\*.json` (sic, VERIFIED 22 files) links
  them to the other client's ids); lutris's Fab/UE-asset rules (`entitlementType == "AUDIENCE"`, `type/format-item`,
  `asset-format*`, `ListingIdentifier`, `releaseInfo[].compatibleApps`) also skip.
  Mapping: `externalId = asset.appName` (equals `.item` `AppName` and `releaseInfo[].appId`, the provider's
  externalId), `title = catalogItem.title` (trademarks removed), `extra = { epicAppName, epicNamespace,
  epicCatalogItemId }`, `developer`. Art: `keyImages` types `DieselGameBoxTall` (portrait cover),
  `DieselGameBox` (wide), `DieselGameBoxLogo` (logo); append `?w=600&h=900&resize=1` for server-side resizing.
  Which types a given item carries is UNVERIFIED: fall back to the keyless chain (gamesdb.gog.com
  `platforms/epic/external_releases/<namespace>`, SGDB `egs/<catalogItemId>`).
- Play time: `GET https://library-service.live.use1a.on.epicgames.com/library/api/public/playtime/account/<account_id>/all`
  -> `[{ accountId, artifactId, totalTime }]` (`totalTime` seconds, `artifactId == appName`); VERIFIED anonymous 401.
  No last-played field.
- No published limits; one request per owned item on the first import (cached), one per page later. Treat
  `errors.com.epicgames.common.throttled` / 429 generically.

### 2.3 Install URI

Playnite `EpicLauncher.cs`: install `com.epicgames.launcher://apps/<AppName>?action=install`, uninstall
`...?action=uninstall`, launch `com.epicgames.launcher://apps/<ns>%3A<catalogItemId>%3A<AppName>?action=launch&silent=true`,
library `com.epicgames.launcher://store/library`. Handler VERIFIED:
`HKCR\com.epicgames.launcher\shell\open\command = "C:\Program Files\Epic Games\Launcher\Portal\Binaries\Win64\EpicGamesLauncher.exe" %1`.
With the legacy launcher Playnite opens the library page instead because the install URL "shows the old installation
dialog ... doesn't show install progress correctly"; PlayOut sends `?action=install` for both generations (it opens the
client's install dialog; never silent) and tells the user "Confirm the install in the Epic Games Launcher".

### 2.4 Install progress (grade: state-only with measured fallback)

Nothing is installed on this PC, so the per-game files are from code/forum evidence:

1. `%ProgramData%\Epic\EpicGamesLauncher\Data\Manifests\<InstallationGuid>.item` (JSON; key set from legendary
   `models/egl.py`: `AppName, CatalogItemId, CatalogNamespace, DisplayName, InstallLocation, InstallSize,
   LaunchExecutable, ManifestLocation (<InstallLocation>\.egstore), StagingLocation (...\.egstore\bps),
   bIsIncompleteInstall, bNeedsValidation, ...`). Appears when the install starts (timing UNVERIFIED);
   `bIsIncompleteInstall: true` while in progress. Percent = bytes under `InstallLocation` (excluding `.egstore`) /
   `InstallSize`, clamp 0-99. `Manifests\Pending\` holds the copy during updates.
2. `<InstallLocation>\.egstore\`: `<guid>.manifest` (binary), `<guid>.mancpn` (JSON `{ FormatVersion, AppName,
   CatalogItemId, CatalogNamespace }`), `bps\` only while installing/patching, `Pending\` non-empty while chunks are
   pending (legendary: no in-progress install <=> no `bps` and empty `Pending`).
3. `%ProgramData%\Epic\UnrealEngineLauncher\LauncherInstalled.dat` `InstallationList[{ InstallLocation, AppName,
   AppID, AppVersion }]` gains the entry at completion (VERIFIED present, empty); the Galaxy plugin polls its mtime.
4. `%ProgramData%\Epic\EpicGamesLauncher\Data\DownloadManager\DownloadState_<32hex>.json` (VERIFIED exists, `[]`):
   the 2025 download-queue state, per profile; schema unknown. Read opportunistically with a tolerant parser and log
   the first non-empty content once so the schema can be learned.
5. `%LOCALAPPDATA%\EpicGamesLauncher\Saved\Logs\EpicGamesLauncher.log` (rotated to
   `EpicGamesLauncher-backup-YYYY.MM.DD-HH.MM.SS.log`; format `[2026.10.29-23.46.53:112][ 26]LogBuildPatchServices: ...`):
   VERIFIED for the launcher self-update: `Starting Installation`, `Requiring N files`, `Constructing file <path>`,
   `Staged install complete`, `Verifying install`, `Build Stat: FinalProgressValue: 1.000000`. No periodic percent
   lines; games use the same module (UNVERIFIED) plus `IncompleteInstall=1 AutoResume=1`.
6. V2 launcher (`%LOCALAPPDATA%\com.epicgames.eglv2\installations.jsonl`, `complete: false` while installing): state-only.

State mapping: `starting` = URI sent, no `.item` with that `AppName`; `downloading` = `.item` with
`bIsIncompleteInstall: true` or `.egstore\bps` exists (percent from dir growth / `InstallSize`); `done` =
`bIsIncompleteInstall: false` and `InstallLocation` + `LaunchExecutable` exist, or `LauncherInstalled.dat` lists the
AppName (then the normal scan confirms); failed/cancelled = `.item` disappears before done or the install dir is
removed. Poll every 10 s (state-only store; dir size every 10 s as well).

### 2.5 Not verified

Login page in a real Electron window and the post-login JSON; token exchange / refresh and every authenticated body;
`keyImages` types per item; `action=install` behaviour on the legacy client; `.item` timing and
`bIsIncompleteInstall` transitions; `DownloadState_*.json` schema; per-game log lines; V2 files.

## 3. GOG / GOG Galaxy

### 3.1 Sign-in (OAuth code)

Authorization URL (minigalaxy, lutris, heroic-gogdl, gogapidocs; Playnite uses a cookie web view instead):
`https://auth.gog.com/auth?client_id=46899977096215655&redirect_uri=https%3A%2F%2Fembed.gog.com%2Fon_login_success%3Forigin%3Dclient&response_type=code&layout=client2`.
VERIFIED: `302` -> `https://login.gog.com/auth?client_id=46899977096215655&layout=client2&redirect_uri=...&response_type=code`
-> `200` (63 KB, `Set-Cookie: galaxy-login-s=...`), a `<form name="login" method="post" action="/login_check">` with
`login[username]`, `login[password]`, `login[_token]`, `login[login_flow]` and **Cloudflare Turnstile** -> the login
must run in a real BrowserWindow. Possible two-step email page UNVERIFIED.

Client pair as it appears in gogdl `auth.py:43-45`, minigalaxy `api.py:29-30`, lutris `gog.py:93-95`:
`CLIENT_ID = "46899977096215655"`, `CLIENT_SECRET = "9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9"`,
redirect `https://embed.gog.com/on_login_success?origin=client`. (The id `46755278331571209` seen elsewhere loads
the login page but answers `400 invalid_client` with this secret: do not use.)

Capture (Heroic `WebView/index.tsx:86,206`, lutris `gog.py:166-183`): watch `will-redirect` / `did-navigate` /
`did-redirect-navigation` for a URL starting `https://embed.gog.com/on_login_success` (normalise host/port: GOG
sometimes redirects to `https://gog.com:80`-style URLs), read `code` from the query, close the window without
waiting for that page to render (anonymously it answered 500 here).

Token exchange (GET): `https://auth.gog.com/token?client_id=46899977096215655&client_secret=<secret>&grant_type=authorization_code&code=<code>&redirect_uri=https%3A%2F%2Fembed.gog.com%2Fon_login_success%3Forigin%3Dclient`
-> `{ access_token, expires_in (3600), token_type ("bearer"), scope, session_id, refresh_token, user_id }`; store
`loginTime` and refresh when `now >= loginTime + expires_in` with
`https://auth.gog.com/token?client_id=...&client_secret=...&grant_type=refresh_token&refresh_token=<rt>`.
Calls: `Authorization: Bearer <access_token>`, UA `PlayOut/<version>`. Account:
`GET https://users.gog.com/users/{user_id}` -> `{ id, username, avatar{...}, ... }` (anonymous `/users/1` -> 404
VERIFIED); `GET https://embed.gog.com/userData.json` -> `{ isLoggedIn, username, ... }`.

### 3.2 Owned games

A. Account listing (minigalaxy / lutris; Bearer works):
`GET https://embed.gog.com/account/getFilteredProducts?mediaType=1&page=<n>` ->
`{ page, totalProducts, totalPages, productsPerPage, products:[{ id (int), title, image ("//images-N.gog-statics.com/<hash>", no extension), url, slug, category, worksOn{Windows,Mac,Linux}, isGame, isMovie, isGalaxyCompatible, dlcCount, isHidden, isNew, rating, releaseDate{date,...}, availability{...}, updates, tags }], ... }`.
Loop `page = 1..totalPages`, ~1 req/s. Anonymous -> `302` to `/en##openlogin` (VERIFIED) = token invalid.
Keep `isGame && !isMovie`; the listing holds base products only (DLC is `dlcCount`). `isHidden` rows (hidden in
the gog.com library) are imported with `extra.gogHidden` for the hidden sync (ARCHITECTURE.md §3, `hiddenByStore`).
`externalId = String(id)` (= the provider's `gogProductId`), `extra = { gogProductId }`.
B. Owned ids only: `GET https://embed.gog.com/user/data/games` -> `{"owned":[ids incl. DLC]}` (302 anonymous).
C. Galaxy library: `GET https://galaxy-library.gog.com/users/{user_id}/releases[?page_token=]` ->
`{ total_count, items:[{ platform_id, external_id, owned, certificate, ... }] }` (anonymous 401 `access_denied`
VERIFIED); keep `platform_id === 'gog'`, details via `gamesdb.gog.com/platforms/gog/external_releases/{id}` with
`X-GOG-Library-Cert`. Shapes beyond Heroic's types UNVERIFIED.
D. Offline, no login: `%ProgramData%\GOG.com\Galaxy\storage\galaxy-2.0.db` (SQLite, WAL). VERIFIED tables:
`LibraryReleases(releaseKey 'gog_<id>')` x `LicensedReleases(isOwned)`, `ReleaseProperties(isDlc, isVisibleInLibrary,
gameId)`, `UserReleaseProperties(isHidden)`, `GamePieces(releaseKey, gamePieceTypeId, value JSON)` with types
`title`, `originalImages {background, squareIcon, verticalCover}`, `meta {developers, publishers, releaseDate, ...}`,
`GameTimes(minutesInGame)`, `LastPlayedDates(lastPlayedDate)`, `InstalledBaseProducts`, `ProductStates(productId,
installation, operation)`. **Rule check**: `better-sqlite3` is forbidden (no native modules); Node's built-in
`node:sqlite` (Node 24 in Electron 44, unflagged) is a core module and may be used **read-only, optional, behind a
runtime guard** (`process.versions.node`, `try { await import('node:sqlite') }`), opening a copy of the three files
(`.db`, `-wal`, `-shm`) and casting INT64 columns with `CAST(x AS TEXT)`. Never copy `ProductAuthorizations` /
`Manifests` (they hold per-game client secrets). This is the zero-login fallback when Galaxy is signed in; the
remote path A is the primary importer.

Per-game detail (keyless, VERIFIED 200): `GET https://api.gog.com/products?ids=<up to 50>` -> `[{ id, title, slug,
game_type ("game"|"dlc"|"pack"), is_installable, release_date, images, dlcs, ... }]`; `GET
https://content-system.gog.com/products/{id}/os/windows/builds?generation=2` for build ids. Art through the existing
`scrapers/gog-api.ts` (`gamesDbImageUrl(vertical_cover, '_glx_vertical_cover', 'jpg')`, background `_1600`, logo
`_glx_logo_2x`), fallback `products[].image` + `_glx_vertical_cover.jpg` (formatter UNVERIFIED).

Play time: locally `GameTimes` / `LastPlayedDates` (D); remotely Playnite's
`https://www.gog.com/u/{username}/games/stats?sort=recent_playtime&order=desc&page=<n>` (cookie session, public
profile; `stats` is an empty array when none) or gameplay.gog.com sessions (shape UNVERIFIED): optional.

Rate limits: none published; `products?ids=` max 50; `api.gog.com` `max-age=86400`, gamesdb 540 s + ETag. Reuse
`RateLimiter(2,2)`, cache the owned list to disk, fail soft on 401 (re-login) / 302 (session gone).

### 3.3 Install URI

`HKCR\goggalaxy\shell\open\command = "C:\Program Files (x86)\GOG Galaxy\GalaxyClient.exe" /urlProtocol="%1"`
(VERIFIED); routes in the exe: `openGameView`, `showGameView`, `installGame`. Playnite: `goggalaxy://openGameView/<productId>`
(Galaxy opens the game page; the user presses Install and confirms the dialog). With the client core running
(`GOG Galaxy Notifications Renderer` process, or `%ProgramData%\GOG.com\Galaxy\lock-files\GOG Galaxy Notifications
Renderer.exe.lock`) Playnite's `UseAutomaticGameInstalls` runs `GalaxyClient.exe /gameId=<id> /command=installGame`,
waits 2500 ms, then opens `goggalaxy://openGameView/<id>` ("client can't handle two instructions in quick
succession"). PlayOut: `installGame` command when running, else the URI; message "Confirm the install in GOG Galaxy".
Galaxy missing -> open `https://www.gog.com/account` (offline installer). Behaviour UNVERIFIED (not launched).

### 3.4 Install progress (grade: measured, file count)

Verified against a real reinstall of 1454587428 on this PC (07:58 -> 08:03):

1. `%ProgramData%\GOG.com\Galaxy\logs\GalaxyClient.log` (UTF-8, `YYYY-MM-DD HH:MM:SS.mmm [Level][thread] [TID n][galaxy_client]: msg`,
   rotates at ~5 MB to `.0`...`.9`). Templates in order:
   `Adding job ProductInstall (<id>) id: <n> state: Scheduled` (queued) ->
   `Storing new ProductState for product <id> => operation state: installing, installation state: none.` ->
   `Job 'ProductInstall (<id>) id: <n> state: Running' state changed` (downloading) ->
   `Initializing download for product <id> (buildId <b>, language <l>, <k> DLCs), files to download <F> (uncompressed size <B>); target file count <T> ...` (totals) ->
   `Allocating disk space for product <id> complete; proceeding with downloads` ->
   per file `Marking file '<rel>' as complete.` / `Moving '<abs>.download' to '<abs>'.` (percent = marked / F, clamp 99) ->
   `Writing <dir>\goggame-galaxyFileList.ini for gameId <id>` ->
   `Changing installation state of product <id> from none to installed` + `Changing operation state of product <id> from installing to nothing` (done) ->
   `Job 'ProductInstall (<id>) id: <n> state: Completed' state changed`.
   No percent/bytes/speed lines. Uninstall: `Scheduling game <id> (<id>) uninstallation`, `... from nothing to
   uninstalling`. Pause/cancel templates not observed (treat a job that vanishes without the installed line as
   cancelled).
2. `%ProgramData%\GOG.com\Galaxy\storage\jobs.db` (SQLite, not WAL): `Jobs(jobId, jobType, operationPhase)`,
   `InstallProductJobs(jobId, gameName, productId, installationPrefix, downloadSize, downloadProgress,
   overallDownloadProgress)`; rows exist for the job's lifetime. Whether `downloadProgress` updates live is
   UNVERIFIED; same `node:sqlite` rule as 3.2 D, optional.
3. `galaxy-2.0.db` `ProductStates` (installed = `installation 3, operation 0`; other values UNVERIFIED) and
   `InstalledBaseProducts` (row appears at done): state-only, poll every 10 s.
4. Install folder: files download as `<name>.download` and are renamed; `goggame-<id>.info`, `.hashdb`, `.script`,
   `goggame-galaxyFileList.ini` are written last -> `goggame-galaxyFileList.ini` present and no `*.download` left =
   done; dir growth vs the log's `uncompressed size` as the percent estimate.
5. Registry `HKLM\SOFTWARE\WOW6432Node\GOG.com\Games\<id>` and `...\Uninstall\<id>_is1` appear at completion (the
   provider already reads them). Playnite polls `GetInstalledGames()` every 10 s.

State mapping: `starting` = URI/command sent, no `Adding job ProductInstall (<id>)` yet; `queued` = job Scheduled;
`downloading` = job Running / files being marked (percent from counts); `installing` = `Writing ...galaxyFileList.ini`
until the installed line; `done` = `Changing installation state ... to installed` or the registry key + `.info`
(confirmed by the normal scan); failed/cancelled = job gone without done. Tail the log every 2 s (measured store),
cross-check the registry every 10 s.

### 3.5 Not verified

`goggalaxy://openGameView` / `installGame` behaviour and extra parameters; `jobs.db` live cadence and enums;
`ProductStates` values other than installed; pause/cancel templates; every authenticated response body; two-step
login page; `products[].image` formatter.

## 4. Xbox / Microsoft Store (PC)

### 4.1 Sign-in (authorization code, Playnite's Azure app)

`XboxLibrary/Services/XboxAccountClient.cs:24-26`: `client_id = 38cd2fa8-66fd-4760-afb2-405eb65d5b0c`,
`redirect_uri = https://login.live.com/oauth20_desktop.srf`, `scope = Xboxlive.signin Xboxlive.offline_access`, no
secret. Login URL:
`https://login.live.com/oauth20_authorize.srf?client_id=38cd2fa8-66fd-4760-afb2-405eb65d5b0c&response_type=code&approval_prompt=auto&scope=Xboxlive.signin+Xboxlive.offline_access&redirect_uri=https%3A%2F%2Flogin.live.com%2Foauth20_desktop.srf`
(VERIFIED 200, `<title>Sign in to your Microsoft account</title>`, no error). Playnite: 490x560 view, cookies
cleared for `.live.com`, `.xboxlive.com`, `.xbox.com`, `.microsoft.com`; close when the URL contains `code=`; the
code is the `code` query parameter of `https://login.live.com/oauth20_desktop.srf?code=M.C...&lc=...` (watch
`will-redirect` / `did-navigate`). The legacy implicit flow (`client_id=0000000048093EE3&response_type=token`,
`scope=service::user.auth.xboxlive.com::MBI_SSL`) also loads but is not used (no refresh token; UNVERIFIED validity).

Token: `POST https://login.live.com/oauth20_token.srf` (`application/x-www-form-urlencoded`) with
`grant_type=authorization_code&code=<code>&scope=Xboxlive.signin Xboxlive.offline_access&client_id=...&redirect_uri=...`;
refresh `grant_type=refresh_token&refresh_token=<rt>&scope=...&client_id=...&redirect_uri=...`. Response
`{ token_type, expires_in, scope, access_token, refresh_token, user_id }`. VERIFIED negative: bogus code -> `400
{"error":"invalid_grant","error_description":"The provided value for the 'code' parameter is not valid.",...}`.

XBL + XSTS (headers `x-xbl-contract-version: 1`, JSON):
`POST https://user.auth.xboxlive.com/user/authenticate`
`{"RelyingParty":"http://auth.xboxlive.com","TokenType":"JWT","Properties":{"AuthMethod":"RPS","SiteName":"user.auth.xboxlive.com","RpsTicket":"d=<access_token>"}}`
(401 on a bogus ticket VERIFIED), then `POST https://xsts.auth.xboxlive.com/xsts/authorize`
`{"RelyingParty":"http://xboxlive.com","TokenType":"JWT","Properties":{"SandboxId":"RETAIL","UserTokens":["<user token>"]}}`.
Both return `{ Token, IssueInstant, NotAfter, DisplayClaims: { xui: [{ uhs, xid, gtg, ... }] } }` (`xid` = XUID,
`gtg` = gamertag for the Settings row). Every service call: `x-xbl-contract-version: 2`,
`Authorization: XBL3.0 x=<uhs>;<xsts Token>`, `Accept-Language: en-US`. Validity check: `POST
https://profile.xboxlive.com/users/batch/profile/settings` `{"settings":["GameDisplayName"],"userIds":[<xid>]}` ->
200. Honour `NotAfter` and refresh proactively (Playnite only refreshes on failure).

### 4.2 Owned games

- `GET https://titlehub.xboxlive.com/users/xuid(<xid>)/titles/titlehistory/decoration/detail,image,gamepass,productId&maxItems=10000`
  (Playnite passes no query; xbox-webapi documents `maxItems` and the decoration names `achievement, image, scid,
  detail, gamepass, stats, friendswhoplayed, alternateTitleId, productId, contentBoard`; default page size and
  continuation UNVERIFIED). Anonymous `401 WWW-Authenticate: Token realm='xboxlive.com', error='token_required'`
  (VERIFIED). Response `{ xuid, titles:[{ titleId (decimal string; hex = MicrosoftGame.config TitleId), pfn,
  type ("Game"|"App"), name, devices:["PC","XboxOne",...], displayImage, images:[{url,type}], detail:{ description,
  publisherName, developerName, releaseDate, genres[] }, titleHistory:{ lastTimePlayed }, gamePass:{ isGamePass } }] }`.
  **Limit** (Playnite's own comment, `XboxLibrary.cs:239`): title history holds titles the account has played at
  least once. Filter: `pfn` non-empty and `type == "Game"` and `devices` contains `"PC"`. Title cleanup strips
  `(PC)`, `(Windows)`, `for Windows 10`, `- Windows 10`, trademarks. `externalId = pfn` (= the provider's
  PackageFamilyName externalId), `extra = { storeId (productId), titleId }`.
- Play time: `POST https://userstats.xboxlive.com/batch`
  `{"arrangebyfield":"xuid","stats":[{"name":"MinutesPlayed","titleid":"<titleId>"},...],"xuids":["<xid>"]}` ->
  `{"statlistscollection":[{"stats":[{"titleid","value":"<minutes>"}]}]}` (401 anonymous VERIFIED; sometimes empty).
- Title info by PFN (for installed packages missing from history): `POST
  https://titlehub.xboxlive.com/titles/batch/decoration/detail` `{"pfns":["<pfn>"],"windowsPhoneProductIds":[]}`
  (404 = unknown); cache forever per PFN.
- Owned-but-never-played: `POST https://collections.mp.microsoft.com/v7.0/collections/query` (xodus) needs the Xbox
  app's MSA device/user tickets and returns empty `items` for PC accounts with XBL3.0 tokens: **phase 2**, not in
  this release.
- Product ids and art without auth (VERIFIED live):
  `GET https://displaycatalog.mp.microsoft.com/v7.0/products/lookup?market=US&languages=en-US&fieldsTemplate=Details&alternateId=PackageFamilyName&value=<pfn>`
  (also `alternateId=XboxTitleId&value=<titleId>`), batch `GET .../v7.0/products?bigIds=<id1>,<id2>&market=US&languages=en-US&fieldsTemplate=Details`
  (keep <= 20 ids). Pick `ProductType == "Game"` with `Properties.PackageFamilyName == pfn`; PC availability = a
  `DisplaySkuAvailabilities[].Sku.Properties.Packages[]` with `PlatformDependencies[].PlatformName == "Windows.Desktop"`
  (`MaxDownloadSizeInBytes` there is the tracker's total). Art `LocalizedProperties[0].Images[] { ImagePurpose, Uri
  (protocol-relative), Width, Height }` with `Poster` 720x1080 (cover), `BoxArt`, `SuperHeroArt` / `TitledHeroArt`
  1920x1080 (hero), `Logo`, `Screenshot`. Cache 24 h (the Xbox app does).

### 4.3 Install URI

Xbox app present (`Microsoft.GamingApp_8wekyb3d8bbwe`, VERIFIED): `msxbox://game/?productId=<productId>` (declared
in the app manifest; what xbox.com's own client opens for PC titles). Else `ms-windows-store://pdp/?ProductId=<productId>`
(Microsoft Learn; the `PFN=` form Playnite uses is deprecated). Both open the game page with its Install button; no
parameter starts the download (UNVERIFIED but nothing suggests one). Message "Press Install in the Xbox app".
`Windows.ApplicationModel.Store.Preview.InstallControl.AppInstallManager.StartProductInstallAsync` is instantiable
from PowerShell but documented as restricted to Microsoft apps (expect access denied; UNVERIFIED).

### 4.4 Installed detection and install progress (grade: measured, approximate)

Installed: `Get-AppxPackage` (Store-signed, non-framework, non-resource) matched on `PackageFamilyName`; for
Xbox-app games `InstallLocation` (`C:\Program Files\WindowsApps\<full>`) is a reparse point to
`C:\XboxGames\<Title>\Content\` (VERIFIED; use `fs.realpathSync.native`). `<install dir>\MicrosoftGame.config` holds
`<TitleId>` (hex), `<StoreId>` (= productId), `<ShellVisuals DefaultDisplayName>`;
`HKLM\SOFTWARE\Microsoft\GamingServices\{GameConfig,PackageRepository,Store\ContentId}` mirrors PFN -> ContentId ->
ProductId offline (VERIFIED). `<drive>:\.GamingRoot` (`RGBX` + count + UTF-16LE folder names) lists the Xbox library
roots per drive.

| Source | Gives | Grade |
|---|---|---|
| `C:\XboxGames\<Title>\Content\` recursive size vs catalog `MaxDownloadSizeInBytes` | percent (finished Conker: 5 174 395 821 / 5 209 505 792 = 99.3 %) | measured (approximate); progressive writes UNVERIFIED; folder name = display name with `:` -> `-` (observed, rule UNVERIFIED) |
| `GamingServices\Store\ContentId\<PFN>` | appears at licence registration (probably queue time) | state-only |
| `GamingServices\PackageRepository\Package` value `<PackageFullName>` + `Metadata\...\InitialInstallTime` | installed | state-only, VERIFIED |
| `Get-AppxPackage -Name <identity>` (Playnite polls 10 s) | installed | state-only |
| `AppInstallManager.AppInstallItems[].GetCurrentStatus()` (`InstallState`, `PercentComplete`, `BytesDownloaded`, `DownloadSizeInBytes`) via PowerShell | exact numbers **if** Xbox-app installs are enqueued through the Store install service | measured, UNVERIFIED for Xbox-app installs (readable here, 0 items) |
| `Get-DeliveryOptimizationStatus` | per-job byte counters if Gaming Services uses DoSvc | measured, UNVERIFIED |

Lifecycle: `starting` = URI sent, no folder ("Installing through Xbox..." indeterminate until the user presses
Install); `downloading` = `C:\XboxGames\<Title>\Content` exists and grows (percent clamp 99); `done` = PFN appears in
`Get-AppxPackage` or `PackageRepository\Package`; cancelled = folder removed. Poll every 10 s; prefer
`AppInstallManager` numbers when an item with the game's ProductId/PFN exists.

### 4.5 Not verified

Every authenticated body (titlehistory, `maxItems`/paging, `images[].type`, userstats, XSTS lifetime); the legacy
implicit flow; Collections for PC accounts; `msxbox://` auto-queue behaviour; `AppInstallManager` from an unpackaged
process and visibility of Xbox-app installs; progressive folder growth and the folder-name rule; displaycatalog batch
limits.

## 5. Battle.net

### 5.1 Sign-in (cookie session of account.battle.net)

Playnite `BattleNetAccountClient.cs`: navigate the logout URI `https://account.battle.net:443/api/logout`, let the
user sign in, close when the URL is `https://account.battle.net/overview` or `https://account.battle.net/`. Status:
load `https://account.battle.net:443/oauth2/authorization/account-settings` ("refreshes authentication cookie"),
then `https://account.battle.net/api/` and parse the page text:
`{ "authenticated": bool, "accountId", "loginUri", "logoutUri", "accountCompletion": {...} }`.

VERIFIED anonymous: `GET https://account.battle.net/api/` -> `401 application/json`
`{"loginUri":"https://account.battle.net:443/oauth2/authorization/account-settings","accountId":null,"authenticated":false,...,"logoutUri":"https://account.battle.net:443/api/logout",...}`;
`HEAD .../oauth2/authorization/account-settings` -> `302 Location: https://oauth.battle.net/authorize?response_type=code&client_id=057adb2af62a4d59904f74754838c4c8&scope=account.full ...&redirect_uri=https://account.battle.net/callback/oauth2/code/account-settings`
(Blizzard's own first-party client id, embedded in the redirect; PlayOut never sends it itself). After sign-in the
callback lands on `/overview`. Cookies: `SESSIONID` (30 min, HttpOnly), `XSRF-TOKEN`, `deviceTrackingId`,
`sessionTrackingId`; the `oauth.battle.net` SSO cookies let the 302 re-mint `SESSIONID` without a password.

Electron: open `https://account.battle.net/oauth2/authorization/account-settings` on `persist:account-battlenet`;
close on `did-navigate` to `https://account.battle.net/overview` or `/`. Import = hidden window on the same partition:
load the refresh URL, then `GET /api/` (expect `authenticated: true`), then the two endpoints below, each read as
`document.body.innerText` -> `JSON.parse` (or `net.request` with the partition's session). If the final URL of the
refresh is `oauth.battle.net/authorize`, the session is dead -> "Signed out of Battle.net: sign in again to refresh
your library." Nothing to store in the token store except `{ signedInAt, displayName? }`; the partition is the
credential. (The GOG plugin's real OAuth pair `6cb41a854631426c8a74d4084c4d61f2` / `FFwxmMBGtEqPydyi9FMhj1zIvlJrBTE1`
belongs to another app: do not reuse.)

### 5.2 Owned games

`GET https://account.battle.net/api/games-and-subs` (cookies) ->
`{"gameAccounts":[{"titleId":5730135,"localizedGameName":"World of Warcraft","gameAccountName":"...","gameAccountRegion":"US","regionalGameFranchiseIconFilename":"...","titleHasSubscriptions":true,...}]}`;
`GET https://account.battle.net/api/classic-games` -> `{"classicGames":[{"localizedGameName":"...","regionalGameFranchiseIconFilename":"...warcraft-iii...","cdKeys":[...]}]}`.
Anonymous 401 (HTML shell) VERIFIED. No paging; one entry per game account (dedupe by product: multiple WoW
accounts); no play time, no art. `titleId` -> product through `resources/systems/battlenet-products.json`
(`ApiId` -> `ProductId` launch code = the provider's `externalId`, `InternalId` = Agent uid; note `AUKS`/`PNTA`
share ApiId 1096108883 upstream, first match wins); unknown ids are skipped with a log line. Classic: icon name
containing `diablo-ii` -> D2 (two entries => D2X), `warcraft-iii` -> W3C (two => W3CX). Art from the table's URLs or
SteamGridDB `bnet`. Last played only locally (`%APPDATA%\Battle.net\Battle.net.config` `Games.<uid>.LastPlayed`,
UNVERIFIED here).

### 5.3 Install URI / command

Playnite `BnetInstallController`: `"<client>\Battle.net.exe" --game=<InternalId>` (opens the client on that game;
the user clicks Install); GOG plugin: `Battle.net.exe --install --game=<uid>` (install dialog pre-selected). Client
exe = `InstallLocation` of the Uninstall entry whose `UninstallString` contains `-uid=battle.net` (the provider
already resolves it); `HKCR\battlenet` protocol (`battlenet://<ProductCode>`) is for launching, no install form is
known. PlayOut: `--install --game=<uid>`, fallback `--game=<uid>`; classic D2/W3 titles open the support articles
(`https://battle.net/support/article/13867`, `.../256212`) instead. Message "Confirm the install in Battle.net".
Agent REST `POST /install` exists (silent) but is undocumented: not in v1. Client not installed (no `-uid=battle.net`
entry): "Battle.net is not installed: install it from blizzard.com to install and play these games."

### 5.4 Install progress (grade: measured, UNVERIFIED live: client not installed here)

`C:\ProgramData\Battle.net\Agent\product.db` (protobuf; schema in `docs/research/battlenet-products.json` from the GOG
plugin's `product_db.proto`): `ProductDb { product_installs[1] { uid[1], product_code[2], settings[3]{install_path[1]},
cached_product_state[4] { base_product_state[1]{installed[1], playable[2], update_complete[3], ...},
update_progress[4]{progress[2] (double), total_to_download[4], download_remaining[5]} }, product_operations[5]{
active_operation[1] UPDATE=0|BACKFILL=1|REPAIR=2|NONE=-1 } }, active_installs[2] { product, uid, settings } }`.
`queued` = entry/handshake for the uid with `installed == false` and `progress == 0`; `downloading` =
`active_operation == UPDATE` with bytes `total_to_download - download_remaining` / `total_to_download`; `done` =
`playable == true` (GOG) or the Uninstall entry matching `Battle\.net.*--uid=<InternalId>.*\s` (Playnite, 10 s poll);
cancelled = entry disappears without an Uninstall entry. Poll the file every 2 s (protobufjs is already a
dependency). Secondary: Agent API `http://127.0.0.1:1120` (`GET /agent` -> `authorization` token, then
`GET /game/<uid>` -> `installed`, `download_complete`; headers `Authorization`, `User-Agent: phoenix-agent/1.0`),
only while Battle.net/Agent runs; use as a done signal only.

### 5.5 Not verified

`product.db` `UpdateProgress` semantics live; `Battle.net.config` layout; Agent fields beyond `installed` /
`download_complete`; `battlenet://` handler presence; `--install --game=<uid>` behaviour.

## 6. EA app

### 6.1 Sign-in (ea.com web session + sniffed bearer)

Jeshibu `EaLibrary/Services/EaWebsite.cs`: `LoginUrl = https://www.ea.com/login`, close when the URL is exactly
`https://www.ea.com/` (`HomeUrl`); `GetAuthToken()` loads `https://www.ea.com/sales/deals` offscreen and copies the
`authorization` request header of the first request to `https://service-aggregation-layer.juno.ea.com/graphql*`
(`Bearer <jwt>`), giving up after 5000 ms (= not signed in). The token is **not** a cookie; the SPA attaches it.
`https://www.ea.com/login` redirects to EA Nucleus (`https://accounts.ea.com/connect/auth?...`); curl timed out twice
(bot protection), `https://www.ea.com/` answered 200. VERIFIED anonymous:
`GET https://accounts.ea.com/connect/auth?client_id=ORIGIN_JS_SDK&response_type=token&redirect_uri=nucleus:rest&prompt=none`
-> `200 {"error_code":"login_required","error":"login_required","error_number":"102100"}` (the legacy Origin token
path; UNVERIFIED in 2026, not used).

Electron: `persist:account-ea`, login window on `https://www.ea.com/login`, close on `did-navigate` to
`https://www.ea.com/`; token mint = hidden window on the same partition loading `https://www.ea.com/sales/deals` with
`session.webRequest.onBeforeSendHeaders({ urls: ['https://service-aggregation-layer.juno.ea.com/graphql*'] })`
copying `requestHeaders.authorization` (5 s timeout -> "Signed out of EA: sign in again to refresh your library.").
Re-mint before every import (short-lived JWT, TTL UNVERIFIED); store only `{ token, capturedAt, displayName? }`
encrypted.

### 6.2 Owned games (Juno GraphQL, persisted queries)

`GET https://service-aggregation-layer.juno.ea.com/graphql?operationName=getPreloadedOwnedGames&variables=<urlencoded JSON>&extensions={"persistedQuery":{"version":1,"sha256Hash":"779f1cd1355699752e20c0b3877847f4e3010ef5de131c248e98f8eff84f0718"}}`
with `Authorization: Bearer <token>`. Variables:
`{"isMac":false,"addFieldsToPreloadGames":true,"locale":"en","limit":500,"next":"0","type":["DIGITAL_FULL_GAME","PACKAGED_FULL_GAME"],"entitlementEnabled":true,"storefronts":["EA","STEAM","EPIC"],"ownershipMethods":["UNKNOWN","ASSOCIATION","PURCHASE","REDEMPTION","GIFT_RECEIPT","ENTITLEMENT_GRANT","DIRECT_ENTITLEMENT","PRE_ORDER_PURCHASE","VAULT","XGP_VAULT","STEAM","STEAM_VAULT","STEAM_SUBSCRIPTION","EPIC","EPIC_VAULT","EPIC_SUBSCRIPTION"],"platforms":["PC"]}`.
Response `data.me.ownedGameProducts.{ next, totalCount, items[] }`; loop `next` until null. Anonymous / expired:
`401 {"errors":[{"message":"Not authenticated.","path":["me"],"extensions":{"code":"UNAUTHENTICATED"}}],"data":null}`
(VERIFIED, identical to the addon's fixture). Item: `{ id, originOfferId ("Origin.OFR.50.0002487"), status,
product { id, name, gameSlug, downloadable, baseItem { gameType ("BASE_GAME"), title, isLauncher },
gamePlatformDetails { gamePlatform }, gameProductUser { ownershipMethods[], initialEntitlementDate }, ... } }`.
Filters: the `type` variable already excludes DLC; skip `baseItem.gameType != "BASE_GAME"` and `isLauncher`.
Source class from `ownershipMethods`: owned (purchase-like), `XGP_VAULT` = Game Pass, `*VAULT*`/`*SUBSCRIPTION*` = EA
Play; keep all three, store the class in `extra.eaOwnership`. Title `product.name` (trademarks removed).

Install metadata (VERIFIED **anonymous 200**): `POST https://service-aggregation-layer.juno.ea.com/graphql` body
`{"query":"query getLegacyCatalogDefs($offerIds: [String!]!, $locale: Locale) { legacyOffers(offerIds: $offerIds, locale: $locale) { offerId: id contentId basePlatform installCheckOverride executePathOverride installationDirectory softwareId downloadPackageType dipManifestRelativePath displayName } }","operationName":"getLegacyCatalogDefs","variables":{"locale":"DEFAULT","offerIds":["Origin.OFR.50.0002487"]}}`
-> `{"data":{"legacyOffers":[{"offerId":"Origin.OFR.50.0002487","contentId":"1028663","installCheckOverride":"[HKEY_LOCAL_MACHINE\\SOFTWARE\\Hazelight\\AWayOut\\Install Dir]\\Haze1\\Binaries\\Win64\\AWayOut.exe","displayName":"A Way Out","softwareId":"Origin.SFT.50.0000658","downloadPackageType":"DownloadInPlace"}]}}`.
Cache forever per offerId. `externalId = contentId` (= the provider's externalId), `extra = { contentId, eaOfferId,
eaSoftwareId, eaSlug }`. Installed check = `^\[(?<reg>.+?)\](?<exe>.*)$` on `installCheckOverride`, read the registry
value (64-bit then 32-bit view), installed iff the exe exists (keys go stale: a Sims 3 key survived the uninstall
here). Empty `installCheckOverride` (Steam/Epic storefront entitlements): "This game is managed by another store;
install it there."

Play time: `operationName=GetGamePlayTimes&variables={"gameSlugs":["<slug>"]}&extensions={"persistedQuery":{"version":1,"sha256Hash":"3f09b35e06b75c74d8ec3e520a598ebb5e2992b1e1268b6dd3b8ed99b9fafb29"}}`
-> `data.me.recentGames.items[{ gameSlug, lastSessionEndDate, totalPlayTimeSeconds }]` (one call per slug; cache 1 h).
Art: not in these queries; gamesdb.gog.com `platforms/origin/external_releases/<offerId>` (verified for `origin/1`),
SteamGridDB `origin`.

### 6.3 Install URI

Jeshibu (`EaControllerHelper.cs`, "opens install dialog for uninstalled games"): `origin2://game/launch/?offerIds=<contentId>`;
GOG legacy: `origin2://game/download?offerId=<offerId>`; library `origin2://library/open`. VERIFIED handlers:
`HKCR\origin2`, `HKCR\origin` -> `C:\Program Files\Electronic Arts\EA Desktop\EA Desktop\EALauncher.exe "%1"`;
client via `HKLM\SOFTWARE\WOW6432Node\Origin\ClientPath`. Both URIs open the EA app's install dialog
(location/language/EULA); the user confirms there. Message "Confirm the install in the EA app". Client missing:
"The EA app is not installed: install it from ea.com/ea-app to install and play these games."

### 6.4 Install progress (grade: measured; VERIFIED from this PC's logs of a real Sims 3 install, 2026-10-24)

The EA app always writes verbose logs. Tab-separated `<n>\t[ISO time]\tPID\tTID\tLEVEL\t(function)\tmessage`; the
`.log` rotates to `.bak` at ~12 MB (reopen on truncation, read both).

1. `%LOCALAPPDATA%\Electronic Arts\EA Desktop\Logs\EADesktopVerbose.log`: about 1/s while downloading
   `(eax::ui::GamesManagerProxy::getDownloadProgress)	received download progress downloaded = [6702985622], Kb/s = [33629.2], timeRemaining = [2.7375042], offer = [Origin.OFR.50.0001139]`
   -> bytes, rate, ETA (total = `downloaded + Kb/s*1000*timeRemaining` as an estimate, or show "x GB downloaded, y
   left"). State JSON `(eax::ui::GamesManagerProxy::sendInstallStatus)	We will emit onGameStatusUpdated signal to SPA: [{... "gameStatus":{"installed":false,"installing":true,...},"installInfo":{"installStatusString":"ACTIVE","installPhaseString":"INVALID",...},"installPath":"C:\\Program Files\\EA Games\\The Sims 3","masterTitleId":"55906","offerId":"Origin.OFR.50.0001139"}]`
   with `installStatusString` `QUEUED` (1) / `ACTIVE` (2) / `INSTALLED` (5), `installPhaseString` `INVALID` /
   `PREPARE` / `FINALIZE`. Completion: `(eax::domain::model::content::InstallStore::updateInfos)	IS update: set installInfo for softwareId=[...] baseSlug=[the-sims-3] installedStatus=[Installed]`
   (values `NotInstalled`, `Queued`, `Active`, `Installed`). The UI uses the storefront offer (`OFB-EAST:55107`)
   while the service renames the job to the legacy offer: match on `baseSlug`/`slug` (= `product.gameSlug`) or
   `softwareId`. Cancel vocabulary UNVERIFIED.
2. `C:\ProgramData\EA Desktop\Logs\EABackgroundServiceVerbose.log` (readable without admin): `[IQ] Adding install job
   [<guid>] for offerId=[...]`, `Set status=[Started] of the job`, `Install state updated for software[...] from
   previous[NotInstalled] to current[Active]`, `Downloader Phase Update: Phase=[14:Downloading] ... processed=[N]
   bytes/items` (phases 7 ScanningFiles, 8 CalculatingBase, 10 PreallocatingFiles, 12 CalculatingPatch, 14
   Downloading, 16 Verifying, 17 Destaging, 18 Cleanup), `Install progress: [20.0] [Installing DirectX]` (finalize
   5..100), `Completed install flow: slug=[...]`, `Install flow finished: slug=[...], version=[...]`, `Removed job`.
3. Fallback: install-dir growth under `installPath`; done = exe exists (`installCheckOverride`) polled every 10 s.
   `C:\ProgramData\Origin\LocalContent\<Game>\*.mfst` is no longer written by the EA app (folder empty here);
   `InstallData\<Game>\base-<softwareId>\map.eacrc` is a binary record list, not progress.

### 6.5 Not verified

`www.ea.com/login` content and redirect in the Electron window; bearer TTL; hash rotation of `779f1cd1...` /
`3f09b35e...`; `origin2://game/launch/?offerIds=` vs `download?offerId=` in the current client; cancel/pause log
vocabulary.

## 7. Ubisoft Connect (installed games only in this release)

### 7.1 Why no sign-in

Playnite has no account import (`UplayLibrary.GetLibraryGames()` reads only the client's protobuf cache). The GOG
plugin's web login (`https://connect.ubisoft.com/login?appId=b8fde481-327d-4031-85ce-7c10a202a700&genomeId=fbd6791c-a6c6-4206-a75e-77234080b87b&lang=en-US&nextUrl=https:%2F%2Fconnect.ubisoft.com%2Fready`,
end regex `.*rememberMeTicket.*`, localStorage `PRODloginData` / `PRODrememberMe` / `PRODlastProfile`) still loads
(200 SPA shell), and `POST https://public-ubiservices.ubi.com/v3/profiles/sessions` is alive (401 "Authorization
header is missing"), but the owned-games endpoint `POST https://public-ubiservices.ubi.com/v1/profiles/me/uplay/graphql`
(`operationName: AllGames`) answers **403** `{"errorCode":1002,"message":"The Service: clubgraphql, is not currently
available for Application b8fde481-... on the Gateway public entrypoint."}`: the gateway rejects the app id itself.
Settings-row reason: "Ubisoft does not offer a sign-in that PlayOut can use; your owned games come from the Ubisoft
Connect client."

### 7.2 Install URI

Playnite `UplayInstallController`: `uplay://install/<launch_id>`; launch `uplay://launch/<id>/0`, uninstall
`uplay://uninstall/<id>`, game page `uplay://open/game/<id>`. Opens the Ubisoft Connect install dialog. Handler
`HKCR\uplay\shell\open\command` -> `UbisoftConnect.exe` (UNVERIFIED, client absent here). Message "Confirm the install
in Ubisoft Connect". Client missing: "Ubisoft Connect is not installed: install it from ubisoft.com/ubisoft-connect to
install and play these games."

### 7.3 Install progress (grade: state-only)

Done = `HKLM\SOFTWARE\Ubisoft\Launcher\Installs\<id>\InstallDir` exists and the directory exists (Playnite, 10 s) and
`<InstallDir>\uplay_install.state` exists with first byte `0x0A` (GOG `_read_status_from_state_file`; the registry
key can exist while downloading). During download: `uplay_install.manifest` + `uplay_install.state` (protobuf, not
public); `<client>\logs\launcher_log.txt` has no percent lines. Indeterminate bar on install-dir growth; cancelled
= key removed / folder deleted. All UNVERIFIED on this PC.

### 7.4 Later: owned list from the client cache (no PlayOut sign-in)

`cache\configuration\configurations` (protobuf `{1: repeated {1: uplay_id, 2: install_id, 3: yaml}}`; YAML
`root.{name, space_id, thumb_image, background_image, logo_image, third_party_platform, is_ulc, addons[], start_game}`;
images `https://ubistatic3-a.akamaihd.net/orbit/uplay_launcher_3_0/assets/<thumb_image>`; skip `third_party_platform`,
`is_ulc`, addon ids, `start_game == null`) is the catalogue; `cache\ownership\<userId>` (records from offset `0x108`:
`0x0a <size> 0x08 <varint launch_id> 0x10 <varint launch_id2> 0x22 ...`) is the owned list; both under the client
InstallDir (`HKLM\SOFTWARE\Ubisoft\Launcher`) or `%LOCALAPPDATA%\Ubisoft Game Launcher\`. Owned-not-installed =
ownership ∩ configurations minus `Installs\<id>`. Row text when the client exists but has never signed in: "Open
Ubisoft Connect and sign in once: PlayOut reads your owned games from the client's cache."

## 8. Shared decisions for the implementation

- **Auth window**: one `BrowserWindow` per sign-in, modal child of the main window, `alwaysOnTop` while the main window
  is fullscreen, `webPreferences: { partition: 'persist:account-<source>', sandbox: true, contextIsolation: true,
  nodeIntegration: false }`, **no preload**, its own `setWindowOpenHandler` that allows same-site popups (2FA) and
  denies the rest, never `window.ts`'s `guardNavigation`. Capture through `will-redirect` / `did-navigate` /
  `did-redirect-navigation` and `session.webRequest` on the exact redirect URI or host; `executeJavaScript` only
  reads documents the store itself rendered (`application_config`, the redirect JSON, `document.body.innerText`).
  Closing the window without a capture resolves the call with `signedIn` unchanged. Tokens, codes and cookie values
  are never logged (`redactUrl` / `redactSecrets` patterns from `scrapers/http.ts` and `steam-store.ts`).
- **Token store**: `userData/accounts.json` `{ version: 1, accounts: { [source]: { encrypted: <base64 of
  safeStorage.encryptString(JSON tokens)>, displayName?, lastImportAt?, lastImportCount? } } }`; plain JSON with a
  logged warning when `safeStorage.isEncryptionAvailable()` is false (only usable after `app.whenReady()`, so decrypt
  lazily; a DPAPI blob from another Windows user decrypts to nothing -> treat as signed out, never crash the load).
  Sign-out deletes the entry and clears the partition's storage.
- **Refresh**: Steam re-mints `webapi_token` from a hidden `/explore/` load on 401; Epic/GOG/Xbox use refresh tokens
  (proactively before an import, once more on an auth error); Battle.net and EA re-mint from the partition's cookie
  session in a hidden window (dead session -> status "not signed in" with the reason above).
- **Importer output**: one `OwnedGame[]` per source with the provider's externalId and `extra` keys (Steam
  `steamAppId`, Epic `epicAppName/epicNamespace/epicCatalogItemId`, GOG `gogProductId`, Xbox `storeId`/`titleId`
  with PFN externalId, Battle.net product code with `uid`, EA `contentId`/`eaOfferId`/`eaSoftwareId`), art URLs when
  the store gave them, store play time when available; `LibraryService.mergeOwned` turns them into greyed `Game`s
  (`docs/ARCHITECTURE.md` §4.8).
- **Install URIs** (allow-listed schemes `steam:`, `com.epicgames.launcher:`, `goggalaxy:`, `origin2:`, `battlenet:`,
  `uplay:`, `msxbox:`, `ms-windows-store:`, plus the client exe commands for GOG and Battle.net): Steam
  `steam://install/<appid>`; Epic `com.epicgames.launcher://apps/<AppName>?action=install`; GOG
  `GalaxyClient.exe /gameId=<id> /command=installGame` + 2.5 s + `goggalaxy://openGameView/<id>` (URI only when
  Galaxy is not running); Xbox `msxbox://game/?productId=<storeId>` else `ms-windows-store://pdp/?ProductId=<storeId>`;
  Battle.net `Battle.net.exe --install --game=<uid>`; EA `origin2://game/launch/?offerIds=<contentId>`; Ubisoft
  `uplay://install/<id>`.
- **Tracker cadence**: measured stores (Steam, GOG, Battle.net, EA) poll their progress source every 2 s; state-only
  stores (Epic, Xbox, Ubisoft) check the install dir and run a bounded installed-scan of that single source every
  10 s; every tracked install also runs that 10 s scan so `done` always comes from the normal scan's `installed:
  true`; 30 minutes without any change -> `failed` with "Could not confirm the installation — check the <Store>
  client". The scan's `library:changed { reason: 'scan' }` is what flips the detail panel's Install button to Play.
