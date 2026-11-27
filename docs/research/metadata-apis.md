# GameDash metadata / artwork source reference

Verified 2026-10-29 from this Windows 11 machine with `curl.exe` (Git Bash, run from `/c/` because the scratchpad path is too long for native Win32 processes), the official docs/specs, and upstream source code (ES-DE, RomM, Playnite, Skyscraper, node-steamgriddb). Every raw response, header dump and downloaded source quoted below is kept under:

- `C:\Users\<user>\AppData\Local\Temp\<scratch>` (live HTTP evidence: `steam_appdetails_620.json`, `steam_cdn_head.txt`, `gog_products_1207658924.json`, `gamesdb_steam_620.json`, `epic_storecontent_hades.json`, `epic_graphql_namespace_min.json`, `hltb_game_7231.html`, `hltb_chunks\*.js`, `sgdb_openapi.yml`, `tgdb_spec.yaml`, `igdb_docs.txt`, `ss_webapi2.txt`, ...)
- `...\scratchpad\repos\` (`esde\ScreenScraper.cpp`, `esde\GamesDBJSONScraper.cpp`, `romm\igdb.py`, `romm\ss_handler.py`, `romm\tgdb_handler.py`, `romm\hltb_handler.py`, `romm\hltb_search.py`, `playnite\*.cs`, `skyscraper\platforms_idmap.csv`, `sgdb\index.ts`)

Legend: **VERIFIED** = observed live today or read from the primary source named. **UNVERIFIED** = from memory or a secondary source; implementers must test before relying on it.

Companion file: `platform-ids.json` next to this report, `{ourKey: {igdb, screenscraper, thegamesdb}}` (see section 9 for provenance and alternates).

---

## 0. Executive summary (what works today, keyless or keyed)

| Source                                | Needs                                                          | Status 2026-10-29                                                                                                        | Use it for                                                                                                                               |
| ------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| SteamGridDB v2                        | user API key (`Authorization: Bearer`)                         | VERIFIED: 401 without key; OpenAPI 2.10.0 spec downloaded                                                                | grids (covers), heroes, logos, icons; search by name; lookup by Steam/EGS/GOG-less (origin, egs, bnet, uplay, flashpoint, eshop) ids     |
| IGDB v4                               | Twitch Client-ID + client-credentials bearer token             | VERIFIED docs (4 req/s, 8 concurrent, limit 500)                                                                         | canonical game record, genres, companies, release dates, covers/artworks/screenshots, age ratings, store id cross-refs, time-to-beat     |
| ScreenScraper v2                      | devid/devpassword (+ user ssid/sspassword)                     | VERIFIED: 403 "Erreur de login" without dev creds; docs page parsed                                                      | ROM hash identification, per-region names, synopsis per language, box art/wheels/mix images/videos for emulated systems                  |
| TheGamesDB v1                         | apikey (monthly allowance)                                     | VERIFIED: 418 without key; `spec.yaml` downloaded                                                                        | box art front/back, fanart, banner, clearlogo, screenshot, titlescreen                                                                   |
| Steam store `appdetails`              | none                                                           | VERIFIED live                                                                                                            | description, release date, devs/pubs, genres, categories, screenshots, movies, metacritic, achievements.total, header/capsule/background |
| Steam CDN art                         | none                                                           | VERIFIED live (HEAD for app ids 620 and 1091500)                                                                         | library_600x900(_2x), library_hero, logo.png, header, capsules, page_bg, icon                                                            |
| Steam Web API                         | key only for schema/achievements/owned games                   | VERIFIED: `GetNumberOfCurrentPlayers` keyless; others 400/401 without key                                                | current players, achievements schema+progress, owned games/playtime                                                                      |
| HowLongToBeat                         | none, but a session token minted by the site + browser headers | PARTIAL: mechanism extracted from the live site JS + RomM; game page JSON VERIFIED; token flow NOT executed here (see 6) | Main / Main+Extra / Completionist seconds                                                                                                |
| GOG `api.gog.com` + `gamesdb.gog.com` | none                                                           | VERIFIED live                                                                                                            | GOG product data; cross-store lookup by steam/gog/epic/origin/uplay ids with covers, logos, backgrounds                                  |
| Epic store GraphQL + store-content    | none (browser-like User-Agent needed for GraphQL)              | VERIFIED live                                                                                                            | title, descriptions, devs/pubs, release date, key images, gallery                                                                        |

---

## 1. SteamGridDB API v2

- Docs page: `https://www.steamgriddb.com/api/v2` (a Redoc shell; the machine-readable spec is `https://www.steamgriddb.com/static/openapi.yml`, OpenAPI 3.1.0, `version: 2.10.0`, VERIFIED 2026-10-29). Base URL: `https://www.steamgriddb.com/api/v2`.
- Official client libraries listed in the spec: `steamgriddb` (npm, TypeScript, `https://github.com/SteamGridDB/node-steamgriddb`), `python-steamgriddb`, `craftersmine.SteamGridDB.Net`, `steamgriddb_api` (Rust).

### 1.1 Authentication and getting a key

- Header: `Authorization: Bearer <api key>` (spec security scheme `API Key`).
- Without a key or with a wrong key the API answers `HTTP 401` with header `www-authenticate: Bearer` and a JSON body (VERIFIED live; body shape per spec `StandardSuccessFalse`: `{"success": false, "errors": ["..."]}`).
- A user gets a key by logging in (Steam OpenID sign-in) and generating it on the preferences page: `https://www.steamgriddb.com/profile/preferences/api` (the node-steamgriddb README says "You can generate an API key on the preferences page" `https://www.steamgriddb.com/profile/preferences`; the `/api` sub-page returned HTTP 200 for us). GameDash should ask the user to paste their own key.

### 1.2 Endpoints (from `openapi.yml`)

| Method/path                                                | Purpose                                                                                                                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /games/id/{gameId}`                                   | game record by SGDB game id                                                                                                                                                                      |
| `GET /games/{platform}/{platformId}?platformdata=steam`    | game record via external id; `platform` enum: `steam`, `origin`, `egs`, `bnet`, `uplay`, `flashpoint`, `eshop`; `platformdata` (optional, "use sparingly") returns platform data such as Steam's |
| `GET /grids/game/{gameId}`                                 | grids (covers / capsules) by SGDB game id                                                                                                                                                        |
| `GET /grids/{platform}/{id,id,...}`                        | grids by platform id(s). Comma-delimited ids return HTTP 207 with one `{success,status,data}` object per game and only the top-voted grid per game                                               |
| `GET /heroes/game/{gameId}`, `GET /heroes/{platform}/{id}` | hero (wide background) images                                                                                                                                                                    |
| `GET /logos/game/{gameId}`, `GET /logos/{platform}/{id}`   | transparent logos                                                                                                                                                                                |
| `GET /icons/game/{gameId}`, `GET /icons/{platform}/{id}`   | icons                                                                                                                                                                                            |
| `GET /search/autocomplete/{term}`                          | name search, returns game objects                                                                                                                                                                |
| `POST /grids                                               | /heroes                                                                                                                                                                                          | /logos | /icons`, `DELETE /{type}/{ids}` | upload/delete (not needed) |

Query parameters (all optional, comma-delimited lists, `explode: false`):

| Param                         | Grids                                                                                        | Heroes                          | Logos                            | Icons                                                                                                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `styles`                      | `alternate, blurred, white_logo, material, no_logo`                                          | `alternate, blurred, material`  | `official, white, black, custom` | `official, custom`                                                                                                                                                      |
| `dimensions`                  | `460x215, 920x430, 600x900, 342x482, 660x930, 512x512, 1024x1024`                            | `1920x620, 3840x1240, 1600x650` | (none)                           | `8,10,14,16,20,24,28,32,35,40,48,54,56,57,60,64,72,76,80,90,96,100,114,120,128,144,150,152,160,180,192,194,256,310,512,768,1024` (an .ico containing that size matches) |
| `mimes`                       | `image/png, image/jpeg, image/webp`                                                          | same                            | `image/png, image/webp`          | `image/png, image/vnd.microsoft.icon`                                                                                                                                   |
| `types`                       | `static, animated` (default `static`)                                                        | same                            | same                             | same                                                                                                                                                                    |
| `nsfw` / `humor` / `epilepsy` | `false` (default, filter out), `true` (only), `any`                                          | same                            | same                             | same                                                                                                                                                                    |
| `oneoftag`                    | any of `humor, nsfw, epilepsy`; combine with the tag params set to `any` to mimic "untagged" | same                            | same                             | same                                                                                                                                                                    |
| `limit`                       | default 50, values > 50 ignored                                                              |                                 |                                  |                                                                                                                                                                         |
| `page`                        | default 0                                                                                    |                                 |                                  |                                                                                                                                                                         |

Portrait covers for the Winhanced tiles: `dimensions=600x900` (or `342x482` / `660x930`); Steam-style horizontal capsules: `460x215`/`920x430`; square: `512x512`/`1024x1024`.

### 1.3 Responses

Image list (`Grids` schema, same for heroes/logos/icons):

```json
{
  "success": true,
  "page": 0,
  "total": 123,
  "limit": 50,
  "data": [
    {
      "id": 12345,
      "score": 1,
      "style": "alternate",
      "url": "https://cdn2.steamgriddb.com/grid/<hash>.png",
      "thumb": "https://cdn2.steamgriddb.com/thumb/<hash>.jpg",
      "tags": [],
      "author": { "name": "...", "steam64": "7656119...", "avatar": "https://..." },
      "language": "en",
      "notes": null,
      "width": 600,
      "height": 900,
      "upvotes": 3,
      "downvotes": 0
    }
  ]
}
```

Spec `Grid` schema guarantees `id, score, style, url, thumb` ("Path to 380x178 thumbnail image"), `tags`, `author{name, steam64, avatar}`; the official TypeScript client (`node-steamgriddb/src/index.ts`, `SGDBImage`) additionally types `language, notes, width, height, upvotes, downvotes` (VERIFIED from source). Real responses also carry `nsfw, humor, epilepsy, lock, mime` (UNVERIFIED, no key available here).

Game object (`Game` schema + `SGDBGame` typing): `{"success": true, "data": {"id": 2254, "name": "Half-Life 2", "types": ["steam"], "verified": true, "release_date": 1101772800}}`. Search returns `{"success": true, "data": [<game>, ...]}`.

Errors: `400` bad request, `401` unauthorized, `404` `{"success": false, "errors": ["Game not found"]}` style.

### 1.4 Working request examples

```
curl -H "Authorization: Bearer $SGDB_KEY" "https://www.steamgriddb.com/api/v2/search/autocomplete/portal%202"
curl -H "Authorization: Bearer $SGDB_KEY" "https://www.steamgriddb.com/api/v2/games/steam/620"
curl -H "Authorization: Bearer $SGDB_KEY" "https://www.steamgriddb.com/api/v2/grids/steam/620?dimensions=600x900&mimes=image/png,image/jpeg&types=static&nsfw=false&humor=false&epilepsy=false&limit=10"
curl -H "Authorization: Bearer $SGDB_KEY" "https://www.steamgriddb.com/api/v2/heroes/game/2254?dimensions=1920x620,3840x1240"
curl -H "Authorization: Bearer $SGDB_KEY" "https://www.steamgriddb.com/api/v2/logos/game/2254?styles=official,white&mimes=image/png"
curl -H "Authorization: Bearer $SGDB_KEY" "https://www.steamgriddb.com/api/v2/icons/game/2254?dimensions=256,512&mimes=image/png"
curl -H "Authorization: Bearer $SGDB_KEY" "https://www.steamgriddb.com/api/v2/grids/egs/<catalogItemId>"   # platform ids: steam, origin, egs, bnet, uplay, flashpoint, eshop
```

(Unauthenticated requests to the first and third URLs returned HTTP 401 today, VERIFIED.)

### 1.5 Fields we need

title -> `games.*.name`; cover -> grids 600x900 `url`; hero/background -> heroes `url`; logo -> logos `url`; icon -> icons `url`; no description/release/genres beyond `release_date` (unix) on the game object.

### 1.6 Limits, caching, licensing

- Rate limits: not stated in the OpenAPI spec or the client README (UNVERIFIED; treat 429 generically and back off).
- Cache the image lists per (type, gameId, filters) for ~24 h; the image files themselves are immutable per image `id`/`url` hash, cache on disk forever.
- Attribution: nothing in the spec. The site terms (`https://www.steamgriddb.com/terms`) are JS-rendered and were not readable with curl (UNVERIFIED). Artwork is user-uploaded; show the `author.name` in an "art credits" tooltip to be safe, and never hot-link thumbnails at scale.

---

## 2. IGDB API v4

Docs: `https://api-docs.igdb.com/` (single page; returns 403 to non-browser user agents, fetched with a Chrome UA; text dump in `live\igdb_docs.txt`). Base URL: `https://api.igdb.com/v4/`. All reads are `POST` with an Apicalypse body.

### 2.1 Account + Twitch client-credentials flow (VERIFIED from docs)

1. Twitch account with Two Factor Authentication enabled; register an application at `https://dev.twitch.tv/console/apps/create` (console: `https://dev.twitch.tv/console/apps`) to get a **Client ID** and **Client Secret**.
2. Token: `POST https://id.twitch.tv/oauth2/token?client_id=<id>&client_secret=<secret>&grant_type=client_credentials` (no body).
   Response: `{"access_token": "...", "expires_in": 5587808, "token_type": "bearer"}` (docs example; `expires_in` is seconds, about 64 days). Refresh before expiry.
3. Every API call needs headers `Client-ID: <client id>` and `Authorization: Bearer <access_token>` (`Accept: application/json` optional).

The IGDB API "is free for non-commercial usage under the terms of the Twitch Developer Service Agreement"; commercial use requires a partnership (`partner@igdb.com`) (docs text, VERIFIED).

### 2.2 Rate limits (VERIFIED from docs)

"There is a rate limit of 4 requests per second. If you go over this limit you will receive a response with status code 429 Too Many Requests." and "You are able to have up to 8 open requests at any moment in time." Default `limit` 10, maximum 500 per request.

### 2.3 Apicalypse syntax (VERIFIED from docs)

```
fields name,summary,genres.name,cover.image_id;   # or f ...; "*" for all; dotted expansion of references
exclude storyline;
where platforms = (18) & first_release_date > 1538129354;   # & | ; = != > >= < <=; ~ for case-insensitive; "in" style: id = (8,9,11)
search "portal 2";          # cannot be combined with sort
limit 50; offset 50;        # limit max 500
sort first_release_date desc;
```

Multiple queries per request via `POST /v4/multiquery` with `query games "name" { fields ...; };` blocks (docs "Multi-Query" section; UNVERIFIED details).

### 2.4 Endpoints and field lists (from the docs' own example bodies, VERIFIED)

| Endpoint                                                     | Fields (docs example)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/v4/games`                                                  | `age_ratings,aggregated_rating,aggregated_rating_count,alternative_names,artworks,bundles,category,checksum,collection,collections,cover,created_at,dlcs,executables,expanded_games,expansions,external_games,first_release_date,follows,forks,franchise,franchises,game_engines,game_localizations,game_modes,game_status,game_type,genres,hypes,involved_companies,keywords,language_supports,multiplayer_modes,name,parent_game,platforms,player_perspectives,ports,rating,rating_count,release_dates,remakes,remasters,screenshots,similar_games,slug,standalone_expansions,status,storyline,summary,tags,themes,total_rating,total_rating_count,updated_at,url,version_parent,version_title,videos,websites` |
| `/v4/covers`                                                 | `alpha_channel,animated,checksum,game,game_localization,height,image_id,image_type,url,width`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `/v4/artworks`                                               | `alpha_channel,animated,artwork_type,checksum,game,height,image_id,image_type,url,width`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `/v4/screenshots`                                            | `alpha_channel,animated,checksum,game,height,image_id,image_type,url,width`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `/v4/logos`                                                  | `alpha_channel,animated,checksum,game,height,image_id,image_type,url,width` (game logos, new endpoint)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `/v4/platforms`                                              | `abbreviation,alternative_name,category,checksum,created_at,generation,name,platform_family,platform_logo,platform_type,slug,summary,updated_at,url,versions,websites`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `/v4/genres`, `/v4/game_modes`, `/v4/themes`, `/v4/keywords` | `checksum,created_at,name,slug,updated_at,url`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `/v4/involved_companies`                                     | `checksum,company,created_at,developer,game,porting,publisher,supporting,updated_at`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `/v4/companies`                                              | `change_date,change_date_category,change_date_format,changed_company_id,checksum,company_size,company_type_histories,country,created_at,description,developed,logo,name,parent,published,slug,start_date,start_date_category,start_date_format,status,updated_at,url,websites`                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `/v4/release_dates`                                          | `category,checksum,created_at,d,date,date_format,game,human,m,platform,region,release_region,status,updated_at,y`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `/v4/external_games`                                         | `category,checksum,countries,created_at,external_game_source,game,game_release_format,media,name,platform,uid,updated_at,url,year`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `/v4/age_ratings`                                            | `category,checksum,content_descriptions,organization,rating,rating_category,rating_content_descriptions,rating_cover_url,synopsis` (docs: `category` DEPRECATED -> use `organization`; `rating` DEPRECATED -> use `rating_category`; `content_descriptions` DEPRECATED -> `rating_content_descriptions`)                                                                                                                                                                                                                                                                                                                                                                                                          |
| `/v4/game_time_to_beats`                                     | `checksum,completely,count,created_at,game_id,hastily,normally,updated_at` (seconds; official alternative to HowLongToBeat)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `/v4/game_videos`                                            | `checksum,game,name,video_id` (YouTube id)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `/v4/search`                                                 | `fields *; search "term";` returns `{id, name, game, platform, company, ...}` hits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

Enum values still printed in the docs (VERIFIED):

- Game `category`/`game_type`: `main_game 0, dlc_addon 1, expansion 2, bundle 3, standalone_expansion 4, mod 5, episode 6, season 7, remake 8, remaster 9, expanded_game 10` (docs table truncated in our dump after 10; `port 11, fork 12, pack 13, update 14` UNVERIFIED). New installs should request `game_type` (reference to `/v4/game_types`) instead of the deprecated `category`.
- External game source (`category`, legacy enum; new field `external_game_source` references `/v4/external_game_sources` with the same numbering): `steam 1, gog 5, youtube 10, microsoft 11, apple 13, twitch 14, android 15, amazon_asin 20, amazon_luna 22, amazon_adg 23, epic_game_store 26, oculus 28, utomik 29, itch_io 30, xbox_marketplace 31, kartridge 32, playstation_store_us 36, focus_entertainment 37, xbox_game_pass_ultimate_cloud 54, gamejolt 55`.
- Age rating organizations (`category`/`organization`): `ESRB 1, PEGI 2, CERO 3, USK 4, GRAC 5, CLASS_IND 6, ACB 7`. Legacy `rating` enum: `Three 1, Seven 2, Twelve 3, Sixteen 4, Eighteen 5, RP 6, EC 7, E 8, E10 9, T 10, M 11, AO 12, CERO_A 13, CERO_B 14, CERO_C 15, CERO_D 16, CERO_Z 17, USK_0 18, ...` (continues; RomM's `igdb_handler.py` keys its own table by the new `rating_category` ids where `1=RP ... 7=AO, 8=PEGI 3 ...` - the two numberings differ, so always expand `rating_category.rating` by name rather than hard-coding numbers).
- Release date `date_format` (`category`): `YYYYMMMMDD 0, YYYYMMMM 1, YYYY 2, YYYYQ1 3, YYYYQ2 4, YYYYQ3 5, YYYYQ4 6, TBD 7`; `region`: `europe 1, north_america 2` (docs dump truncated; `australia 3, new_zealand 4, japan 5, china 6, asia 7, worldwide 8, korea 9, brazil 10` UNVERIFIED).
- Platform `category`: `console 1, arcade 2, platform 3, operating_system 4, portable_console 5` (`computer 6` UNVERIFIED).

### 2.5 Images (VERIFIED from docs "Images" section)

URL template: `https://images.igdb.com/igdb/image/upload/t_{size}/{image_id}.jpg` (the API's `url` field comes back protocol-relative with `t_thumb`; replace the size token). Append `_2x` to any size for retina (e.g. `t_cover_big_2x`).

| Size token          | Pixels      | Fit                   |
| ------------------- | ----------- | --------------------- |
| `t_cover_small`     | 90 x 128    | Fit                   |
| `t_cover_big`       | 264 x 374   | Fit                   |
| `t_screenshot_med`  | 569 x 320   | Lfill, center gravity |
| `t_screenshot_big`  | 889 x 500   | Lfill, center gravity |
| `t_screenshot_huge` | 1280 x 720  | Lfill, center gravity |
| `t_logo_med`        | 284 x 160   | Fit                   |
| `t_thumb`           | 90 x 90     | Thumb, center gravity |
| `t_micro`           | 35 x 35     | Thumb, center gravity |
| `t_720p`            | 1280 x 720  | Fit, center gravity   |
| `t_1080p`           | 1920 x 1080 | Fit, center gravity   |

Recommended: cover `t_cover_big_2x` (528x748) or `t_1080p` for full-size covers (RomM uses `t_1080p` for covers and `t_720p` for screenshots); hero/background: artworks or screenshots at `t_1080p`.

### 2.6 Working examples

```
# token
curl -X POST "https://id.twitch.tv/oauth2/token?client_id=$IGDB_ID&client_secret=$IGDB_SECRET&grant_type=client_credentials"

# search a ROM name on a platform (NES = 18); game_type 0 = main game
curl -X POST https://api.igdb.com/v4/games -H "Client-ID: $IGDB_ID" -H "Authorization: Bearer $TOKEN" \
  -d 'fields name,slug,summary,storyline,first_release_date,total_rating,aggregated_rating,rating,genres.name,themes.name,game_modes.name,player_perspectives.name,cover.image_id,cover.width,cover.height,artworks.image_id,screenshots.image_id,involved_companies.company.name,involved_companies.developer,involved_companies.publisher,release_dates.date,release_dates.human,release_dates.platform,release_dates.release_region,age_ratings.organization,age_ratings.rating_category,platforms.name,game_type,external_games.external_game_source,external_games.uid,videos.video_id; search "Super Mario Bros. 3"; where platforms = (18) & game_type = (0,8,9); limit 10;'

# Steam app id -> IGDB game (source 1 = steam; 5 = gog; 26 = epic)
curl -X POST https://api.igdb.com/v4/external_games -H "Client-ID: $IGDB_ID" -H "Authorization: Bearer $TOKEN" \
  -d 'fields game.name,game.cover.image_id,uid,external_game_source,url; where external_game_source = 1 & uid = "620";'

# platforms list (to refresh platform-ids.json)
curl -X POST https://api.igdb.com/v4/platforms -H "Client-ID: $IGDB_ID" -H "Authorization: Bearer $TOKEN" \
  -d 'fields id,name,slug,abbreviation,category,platform_family; limit 500; sort id asc;'

# time to beat
curl -X POST https://api.igdb.com/v4/game_time_to_beats -H "Client-ID: $IGDB_ID" -H "Authorization: Bearer $TOKEN" \
  -d 'fields game_id,hastily,normally,completely,count; where game_id = 1942;'
```

### 2.7 Field mapping

title `name`; description `summary` (+`storyline`); release `first_release_date` (unix) or `release_dates`; developers/publishers `involved_companies` with `developer`/`publisher` booleans -> `company.name`; genres `genres.name`, `themes.name`, `game_modes.name`; rating `total_rating` / `aggregated_rating` (0-100), `age_ratings`; cover `cover.image_id`; hero/background `artworks[].image_id` (fallback `screenshots`); logo: none (use SGDB); screenshots `screenshots[].image_id`; playtime stats `game_time_to_beats`.

### 2.8 Caching

IGDB records change rarely: cache game JSON >= 7 days (ES-DE/RomM cache indefinitely with manual refresh); cache the token until `expires_in - 1 day`; images are immutable per `image_id` -> disk cache forever. Keep a client-side token bucket at 4 req/s and <= 8 in flight.

---

## 3. ScreenScraper API v2

Docs (French): `https://www.screenscraper.fr/webapi2.php` (HTML downloaded; text in `live\ss_webapi2.txt`). API host used by all examples and by ES-DE: `https://api.screenscraper.fr/api2/<endpoint>.php` (ES-DE `ScreenScraper.cpp` builds `API_URL_BASE + "/jeuInfos.php?devid=..."`).

### 3.1 Credentials

- `devid` / `devpassword` / `softname`: developer credentials. Docs: "Si vous etes developpeur et voulez integrer notre API, contactez-nous via le forum pour presenter votre logiciel et obtenir vos identifiants" and "L'API ScreenScraper ne peut etre integre que dans les applications entierement gratuites et distribuees, ou ... avec l'autorisation prealable" (forum: `https://www.screenscraper.fr/forum.php`, members register at `https://www.screenscraper.fr/membreinscription.php`). GameDash v1 must let the user enter their own `devid`/`devpassword` (and we may later apply for a project id). ES-DE ships obfuscated credentials in the binary (`Utils::String::scramble(API_DEV_U, API_DEV_KEY)`).
- `ssid` / `sspassword`: the end user's ScreenScraper account (optional but strongly recommended: thread count and daily quota depend on it).
- Without valid dev credentials every endpoint answers `Erreur de login : Verifier vos identifiants developpeur !` - `jeuInfos.php` and `ssinfraInfos.php` with HTTP 403, `systemesListe.php` with HTTP **200** and the same text body (VERIFIED live today; note the inconsistent status).

### 3.2 Common parameters

`devid`, `devpassword`, `softname` (URL-encoded app name; ES-DE notes a space in softname breaks returned media URLs), `output=json` (default `xml`; `ini` also exists), `ssid`, `sspassword`.

### 3.3 Endpoints

**`jeuInfos.php`** - game info + media by ROM identification. Params: `crc`, `md5`, `sha1` (hex of the ROM file; "unless you have an exemption you must send at least one of crc/md5/sha1 AND `romtaille`"), `systemeid`, `romtype` (`rom` | `iso` | `dossier`), `romnom` (file name with extension or folder name; must not contain a path), `romtaille` (bytes), `serialnum` (force serial match), `gameid` (force by game id, no ROM info returned).
ES-DE's actual URL: `jeuInfos.php?devid=..&devpassword=..&softname=..&output=xml&romnom=<urlencoded name>&md5=<md5>&romtaille=<size>[&ssid=..&sspassword=..]` (it omits `systemeid` for name-only automatic mode; add `systemeid` for precision).

**`jeuRecherche.php`** - name search. Params: `recherche` (name), `systemeid` (optional). Returns up to 30 games ordered by probability; items identical to `jeuInfos` minus ROM data. JSON: `response.jeux[]` (with no match it returns a list holding one empty object - RomM `_drop_no_match_placeholder`).

**`systemesListe.php`** - all systems: `response.systemes[]` with `id`, `parentid`, `noms{nom_eu, nom_us, nom_jp, ..., nom_recalbox, nom_retropie, nom_launchbox, nom_hyperspin, noms_commun}`, `extensions`, `compagnie`, `type` (Arcade, Console, Console Portable, Emulation Arcade, Flipper, Online, Ordinateur, Smartphone), `datedebut`, `datefin`, `romtype`, `supporttype`, `medias{ media_logosmonochrome{media_logomonochrome_xx, _crc, _md5, _sha1}, media_wheels{media_wheel_xx...}, media_wheelscarbon, media_wheelscarbonvierge, media_wheelssteel, media_wheelssteelvierge, media_photos{media_photo_xx}, media_video, media_fanart, media_bezels{media_bezels4-3/16-9/16-10} ...}`.

**`mediaJeu.php`** - download one game image. Params: `systemeid`, `jeuid`, `media` (text id such as `box-2D(us)`, `wheel-hd(wor)`, `ss(wor)`, `mixrbv2(wor)`), optional `crc`/`md5`/`sha1` of a local copy (server answers text `CRCOK`/`MD5OK`/`SHA1OK` instead of bytes when identical), `mediaformat`, output options `maxwidth`, `maxheight`, `outputformat=png|jpg`. Returns the image (PNG by default), or text `NOMEDIA`. Example from docs: `https://api.screenscraper.fr/api2/mediaJeu.php?devid=xxx&devpassword=yyy&softname=zzz&ssid=test&sspassword=test&crc=&md5=&sha1=&systemeid=1&jeuid=3&media=wheel-hd(wor)`. Videos: `mediaVideoJeu.php` (same params, returns MP4, `media=video` or `video-normalized`). Manuals: `mediaManuelJeu.php`.

**`mediaSysteme.php`** - system image: `systemeid`, `media` (e.g. `wheel(wor)`, `logo-monochrome(wor)`, `photo(wor)`), same output options. `mediaVideoSysteme.php` for the system video.

**`ssuserInfos.php`** - account + quota: `response.ssuser{ id, numid, niveau, contribution (2 = +1 thread, 3+ = +5 threads), uploadsysteme, uploadinfos, romasso, uploadmedia, propositionok, propositionko, quotarefu, maxthreads, maxdownloadspeed (KB/s), requeststoday, requestskotoday, maxrequestspermin, maxrequestsperday, maxrequestskoperday, visites, datedernierevisite, favregion }`. The same `ssuser` block is included in every `jeuInfos`/`jeuRecherche`/`systemesListe` response ("Cette gestion de Quota par logiciel est desormais obligatoire"), so read it from each reply and throttle.

Also useful: `regionsListe.php` (`id, nomcourt, nom_en, ...`), `languesListe.php`, `genresListe.php`, `classificationsListe.php`, `mediasJeuListe.php` (every media type id with `nomcourt`, `categorie`, `fileformat`, `multiregions`...), `ssinfraInfos.php` (server load: `maxthreadfornonmember`, `threadfornonmember`, `maxthreadformember`, `threadformember`).

### 3.4 JSON response structure of `jeuInfos.php` (ES-DE XML parser + RomM TypedDicts agree)

```json
{"header": {"APIversion": "2", ...},
 "response": {
   "serveurs": {"serveurcpu1": ..., "threadsmin": ..., "nbscrapeurs": ..., "apiacces": ...},
   "ssuser": {"id": "...", "niveau": "...", "maxthreads": "1", "maxrequestspermin": "...", "maxrequestsperday": "...", "requeststoday": "...", ...},
   "jeu": {
     "id": "3", "romid": "...", "notgame": "false",
     "noms": [{"region": "ss", "text": "Sonic The Hedgehog 2"}, {"region": "us", "text": "..."}, {"region": "eu", "text": "..."}, {"region": "jp", "text": "..."}, {"region": "wor", "text": "..."}],
     "cloneof": "0",
     "systeme": {"id": "1", "text": "Megadrive"},
     "editeur": {"id": "...", "text": "SEGA"}, "developpeur": {"id": "...", "text": "Sonic Team"},
     "joueurs": {"text": "1-2"}, "note": {"text": "17"},          // note is out of 20
     "topstaff": "1", "rotation": "0",
     "synopsis": [{"langue": "en", "text": "..."}, {"langue": "fr", "text": "..."}, ...],
     "classifications": [{"type": "ESRB", "text": "E"}, {"type": "PEGI", "text": "3"}, ...],
     "dates": [{"region": "wor", "text": "1992-11-24"}, {"region": "us", "text": "1992-11-24"}, ...],
     "genres": [{"id": "...", "nomcourt": "...", "principale": "1", "parentid": "0", "noms": [{"langue": "en", "text": "Platform"}, ...]}],
     "modes": [...], "familles": [...],
     "medias": [{"type": "box-2D", "parent": "jeu", "url": "https://.../mediaJeu.php?...", "region": "us", "crc": "...", "md5": "...", "sha1": "...", "size": "...", "format": "png"},
                {"type": "ss", ...}, {"type": "sstitle", ...}, {"type": "wheel", "region": "wor", ...}, {"type": "mixrbv2", ...}, {"type": "video", "format": "mp4", ...}, {"type": "fanart", ...}],
     "roms": [{"id": "...", "romfilename": "...", "romsize": "...", "romcrc": "...", "rommd5": "...", "romsha1": "...", "regions": {"regions_shortname": ["us"], "regions_en": ["USA"]}, "langues": {...}, "beta": "0", "demo": "0", "trad": "0", "hack": "0", "unl": "0", "alt": "0", "best": "1", "retroachievement": "1"}],
     "rom": { ...same keys for the matched ROM, plus "romserial", "romregions", "romlangues", "romtype", "romsupporttype"... }
   }}}
```

The docs' element list (`media_boitier_2d_xx` etc.) describes the old XML naming; the v2 JSON `medias` array is flat with `type`/`region`/`format` (ES-DE parses `<media type="..." region="..." format="...">`; RomM `SSGameMedia` = `type, parent, url, region?, support?, crc, md5, sha1, size?, format`). Treat the `url` values as secrets: they are `mediaJeu.php` links that embed the caller's `devid`/`devpassword`/`softname` (ES-DE comment at `ScreenScraper.cpp:759`).

Media `type` ids used by ES-DE/RomM: `box-2D` (front cover), `box-2D-back`, `box-3D`, `box-texture` (full flat box), `support-2D` (cartridge/disc), `support-texture`, `wheel` and `wheel-hd` (logo/marquee; treat as equivalent, prefer hd), `wheel-carbon`, `wheel-steel`, `ss` (screenshot), `sstitle` (title screen), `mixrbv1`, `mixrbv2` (mix images), `fanart`, `marquee`, `screenmarquee`, `video`, `video-normalized`, `manuel` (PDF), `steamgrid` (600x900 grid), `bezel-4-3`, `bezel-16-9`, `bezel-16-10`, `flyer`. Media types are multi-region except `video*` and `fanart` (ES-DE takes the first entry for those).

### 3.5 Region / language preference

- Names (`noms[].region`) fallback order used by ES-DE: user region, `wor`, `us`, `ss`, `eu`, `jp`. RomM: `us, wor, ss, eu, jp, cus` (+ regions parsed from the file name). `ss` = ScreenScraper's own name, `cus` = custom, `wor` = world.
- Media region fallback (ES-DE): user region, `wor`, `us`, `eu`, `jp`, `cus`, then whatever region appears first.
- Synopsis/genre language (`langue`): user language, then `en`, then `wor` (ES-DE). Date: same region chain as names.

### 3.6 Quotas, threads, HTTP errors (VERIFIED from docs)

Thread count (`maxthreads`) depends on contribution level (base 1 thread; `contribution` 2 = +1, 3+ = +5 threads; `maxthreadfornonmember` applies to anonymous calls). Per-minute (`maxrequestspermin`) and per-day (`maxrequestsperday`, `maxrequestskoperday` = failed lookups) quotas exist since mid-2019; the exact numbers per level are only in the site F.A.Q. (not captured, UNVERIFIED). HTTP codes: `400` url/parameter problems (missing mandatory field, rom name containing a path, malformed crc/md5/sha1); `401` API closed for non-members or inactive members (server CPU > 60 %); `403` bad developer credentials; `404` game or rom not found; `423` API fully closed; `426` software blacklisted (obsolete version - send a real `softname`/version); `429` thread limits reached (four variants: member threads, member threads per minute, "maximum threads allowed to leecher users", "maximum threads is already used"); `430` daily scrape quota exceeded; `431` too many unrecognised ROMs today.

### 3.7 Working example

```
curl "https://api.screenscraper.fr/api2/jeuInfos.php?devid=$SS_DEVID&devpassword=$SS_DEVPW&softname=GameDash&output=json&ssid=$SS_USER&sspassword=$SS_PASS&systemeid=3&romtype=rom&romnom=Super%20Mario%20Bros.%20(World).nes&romtaille=40976&md5=811b027eaf99c2def7b933c5208636de&crc=3337ec46&sha1=ea343f4e445a9050d4b4fbac2c77d0693b1d0922"
curl "https://api.screenscraper.fr/api2/jeuRecherche.php?devid=$SS_DEVID&devpassword=$SS_DEVPW&softname=GameDash&output=json&ssid=$SS_USER&sspassword=$SS_PASS&systemeid=3&recherche=Super%20Mario%20Bros"
curl "https://api.screenscraper.fr/api2/ssuserInfos.php?devid=$SS_DEVID&devpassword=$SS_DEVPW&softname=GameDash&output=json&ssid=$SS_USER&sspassword=$SS_PASS"
curl "https://api.screenscraper.fr/api2/mediaJeu.php?devid=$SS_DEVID&devpassword=$SS_DEVPW&softname=GameDash&ssid=$SS_USER&sspassword=$SS_PASS&systemeid=3&jeuid=4&media=box-2D(us)&maxwidth=600&outputformat=png" -o cover.png
```

(Hash values above are illustrative; the live test without credentials returned 403 as recorded.) Compute CRC32/MD5/SHA1 of the ROM (for zips ScreenScraper hashes the largest file inside the archive: `romcrc` is "du fichier rom ou du fichier le plus gros du dossier"); ES-DE hashes the file as-is and ScreenScraper matches zips by content hash as well (UNVERIFIED for every container type).

### 3.8 Field mapping and caching

title `noms` (region chain); description `synopsis` (language chain); release `dates`; developer `developpeur.text`; publisher `editeur.text`; genres `genres[].noms` (en); rating `note.text` (/20) and `classifications`; cover `medias[type=box-2D]`; hero/background `fanart` or `mixrbv2`; logo `wheel-hd`/`wheel`; screenshots `ss`, `sstitle`; video `video-normalized`; players `joueurs.text`.
Cache: store the per-ROM JSON keyed by hash forever (refresh on demand); store `crc/md5/sha1` of downloaded media and re-send them in `mediaJeu.php` so the server returns `MD5OK` instead of bytes. Respect `maxthreads` and keep a daily counter from `requeststoday`/`maxrequestsperday`. Licensing: free software only (or written permission); no explicit attribution rule found in the docs (UNVERIFIED) - show "Data by ScreenScraper.fr" to be safe and never redistribute downloaded media.

---

## 4. TheGamesDB API v1

Docs: Swagger UI at `https://api.thegamesdb.net/` loading `https://api.thegamesdb.net/spec.yaml` (`swagger: '2.0'`, "TheGamesDB API" `version: 2.0.0`, license GPLv3 for the API code, downloaded to `live\tgdb_spec.yaml`). Base URL: `https://api.thegamesdb.net/v1` (and `/v1.1` for the newer name search).

### 4.1 Key

Query parameter `apikey=<key>` on every call. Obtain: log in at `https://thegamesdb.net/login.php` (forum account), then `https://api.thegamesdb.net/key.php` ("API Keys - You must be logged in to the site to view your api key.", VERIFIED). Public keys have a monthly allowance; every response reports `remaining_monthly_allowance`, `extra_allowance`, `allowance_refresh_timer` (seconds until reset; spec example `2592000` = 30 days). Spec example shows `remaining_monthly_allowance: 249`; the default allowance size is not stated (UNVERIFIED). Private/"extra allowance" keys are granted by the TGDB staff on request.
Without a key the API answers `HTTP 418 I'm a teapot` with `{"code":418,"status":"Unknown Error Code"}` (VERIFIED live for `/v1/Games/ByGameName?name=portal` and `/v1/Platforms`); the spec documents `403` for "bad API key or hit rate-limit cap" and `406` for missing/invalid ids.

### 4.2 Endpoints (spec)

| Path                                                                 | Required                          | Optional                                                                                                                                                              |
| -------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/Games/ByGameID`                                             | `apikey`, `id` (comma list)       | `fields`, `include`, `page`                                                                                                                                           |
| `GET /v1/Games/ByGameName`                                           | `apikey`, `name`                  | `fields`, `filter[platform]` (platform id list), `filter[region_id]`, `filter[country_id]`, `include`, `page` (v1: any `mode` value triggers natural-language search) |
| `GET /v1.1/Games/ByGameName`                                         | same                              | adds proper `mode=natural`; `include.platform` is wrapped in a `data` key unlike v1                                                                                   |
| `GET /v1/Games/ByPlatformID`                                         | `apikey`, `id` (platform id list) | `fields`, `include`, `page`                                                                                                                                           |
| `GET /v1/Games/ByGameUniqueID`, `GET /v1/Games/ByGameHash`           | uid / ROM hash lookups            |                                                                                                                                                                       |
| `GET /v1/Games/Images`                                               | `apikey`, `games_id` (comma list) | `filter[type]` = `fanart, banner, boxart, screenshot, clearlogo, titlescreen`; `page`                                                                                 |
| `GET /v1/Games/Videos`                                               | `apikey`, `games_id`              | `page`                                                                                                                                                                |
| `GET /v1/Games/Updates`                                              | `apikey`                          | `last_edit_id`, `time`, `page`                                                                                                                                        |
| `GET /v1/Platforms`                                                  | `apikey`                          | `fields` = `icon, console, controller, developer, manufacturer, media, cpu, memory, graphics, sound, maxcontrollers, display, overview, youtube`; `include=boxart`    |
| `GET /v1/Platforms/ByPlatformID`, `GET /v1/Platforms/ByPlatformName` | `id` / `name`                     | `fields`, `include`                                                                                                                                                   |
| `GET /v1/Platforms/Images`                                           | `apikey`, `platforms_id`          | `filter[type]` = `fanart, banner, boxart`; `page`                                                                                                                     |
| `GET /v1/Genres`, `GET /v1/Genres/ByGenreID`                         | `apikey` (+`id`)                  |                                                                                                                                                                       |
| `GET /v1/Developers`, `GET /v1/Developers/ByDeveloperID`             | `apikey` (+`id`)                  |                                                                                                                                                                       |
| `GET /v1/Publishers`, `GET /v1/Publishers/ByPublisherID`             | `apikey` (+`id`)                  |                                                                                                                                                                       |
| `GET /v1/Regions`, `GET /v1/Countries`                               | `apikey`                          |                                                                                                                                                                       |

`fields` for games: `players, publishers, genres, overview, last_updated, rating, platform, coop, youtube, os, processor, ram, hdd, video, sound, alternates`. `include`: `boxart, platform`.

### 4.3 Response shape (spec example, VERIFIED from spec)

```json
{
  "code": 200,
  "status": "Success",
  "remaining_monthly_allowance": 249,
  "extra_allowance": 0,
  "allowance_refresh_timer": 2592000,
  "data": {
    "count": 1,
    "games": [
      {
        "id": 53,
        "game_title": "Sonic the Hedgehog",
        "release_date": "1991-06-23",
        "platform": 18,
        "players": 1,
        "overview": "Join Sonic ...",
        "last_updated": "2022-03-15 10:22:45",
        "rating": "E - Everyone",
        "coop": "No",
        "youtube": "E8VPmADC4aA",
        "developers": [1296],
        "genres": [1],
        "publishers": [1]
      }
    ]
  },
  "include": {
    "boxart": {
      "base_url": {
        "original": "https://cdn.thegamesdb.net/images/original/",
        "small": "https://cdn.thegamesdb.net/images/small/",
        "thumb": "https://cdn.thegamesdb.net/images/thumb/",
        "cropped_center_thumb": "https://cdn.thegamesdb.net/images/cropped_center_thumb/",
        "medium": "https://cdn.thegamesdb.net/images/medium/",
        "large": "https://cdn.thegamesdb.net/images/large/"
      },
      "data": {
        "53": [
          {
            "id": 17438,
            "type": "boxart",
            "side": "front",
            "filename": "boxart/front/53-1.jpg",
            "resolution": "1521x2156"
          }
        ]
      }
    },
    "platform": { "data": { "18": { "id": 18, "name": "Sega Genesis", "alias": "sega-genesis" } } }
  },
  "pages": {
    "previous": null,
    "current": "https://api.thegamesdb.net/v1/Games/ByGameID?apikey=APIKEY&id=53&fields=...&include=boxart%2Cplatform&page=1",
    "next": null
  }
}
```

`Games/Images` returns `data.base_url{original,small,thumb,cropped_center_thumb,medium,large}` and `data.images{"<gameid>": [{id, type, side, filename, resolution}]}` where `type` is `boxart` (`side` = `front`|`back`), `fanart`, `banner`, `screenshot`, `clearlogo`, `titlescreen`; full URL = `base_url.<size> + filename` (e.g. `https://cdn.thegamesdb.net/images/original/boxart/front/53-1.jpg`). `Games/Videos` returns `data.base_url: "https://cdn.thegamesdb.net/"` and `data.videos{"<id>": [{id, filename: "videos/53/53-1.mp4", dateadded}]}`. `Platforms` returns `data.platforms{"<id>": {id, name, alias, developer, ...}}`; `Platforms/Images` filenames look like `platform/fanart/18-1.jpg`, `platform/consoleart/18-1.png` (boxart) and `platform/banners/...`. `Genres`/`Developers`/`Publishers` return `data.genres|developers|publishers{"<id>": {id, name}}` (ids referenced from games).

ES-DE's actual query (`GamesDBJSONScraper.cpp`): `https://api.thegamesdb.net/v1/Games/ByGameName?apikey=...&name=<name>&fields=players,publishers,genres,overview,last_updated,rating,platform,coop,youtube,os,processor,ram,hdd,video,sound,alternates&include=boxart,platform&filter[platform]=<id>`; then `/v1/Games/Images?apikey=...&games_id=<id>` and uses `base_url.large`.

### 4.4 Working examples

```
curl "https://api.thegamesdb.net/v1.1/Games/ByGameName?apikey=$TGDB_KEY&name=Super%20Mario%20Bros.%203&filter%5Bplatform%5D=7&fields=players,publishers,genres,overview,rating,coop,youtube&include=boxart,platform"
curl "https://api.thegamesdb.net/v1/Games/ByGameID?apikey=$TGDB_KEY&id=53&fields=overview,publishers,genres,rating,players&include=boxart,platform"
curl "https://api.thegamesdb.net/v1/Games/Images?apikey=$TGDB_KEY&games_id=53&filter%5Btype%5D=boxart,fanart,clearlogo,screenshot,titlescreen,banner"
curl "https://api.thegamesdb.net/v1/Platforms?apikey=$TGDB_KEY&fields=overview,manufacturer"
curl "https://api.thegamesdb.net/v1/Platforms/Images?apikey=$TGDB_KEY&platforms_id=7&filter%5Btype%5D=fanart,banner,boxart"
```

### 4.5 Field mapping, caching, licensing

title `game_title`; description `overview`; release `release_date` (YYYY-MM-DD); developers `developers[]` ids -> `/v1/Developers`; publishers `publishers[]` -> `/v1/Publishers`; genres `genres[]` -> `/v1/Genres`; rating `rating` (strings like `E - Everyone`, `T - Teen`, `M - Mature 17+`); cover `boxart/front`; back `boxart/back`; hero/background `fanart`; logo `clearlogo`; screenshots `screenshot`, `titlescreen`; banner `banner`; video `Games/Videos`.
Cache aggressively: the monthly allowance is the binding limit - cache the genre/developer/publisher tables (one call each) and game records for 30+ days, use `Games/Updates` with `last_edit_id` to refresh, and show `remaining_monthly_allowance` in settings. Licensing: the API code is GPLv3; data/image terms are not in the spec (UNVERIFIED) - credit "TheGamesDB.net" in the About screen.

---

## 5. Steam

### 5.1 Store `appdetails` (no key) - VERIFIED live

`GET https://store.steampowered.com/api/appdetails?appids=620&cc=us&l=english` -> `200`, `Content-Type: application/json; charset=utf-8`, `Cache-Control: public,max-age=3600`, 28 432 bytes. Shape: `{"620": {"success": true, "data": {...}}}`; unknown id -> `{"999999999": {"success": false}}` (200). Multiple ids without `filters` -> `HTTP 400`, gzip body `null` (VERIFIED); `filters=price_overview` works and returns only that block (`{"620":{"success":true,"data":{"price_overview":{"currency":"USD","initial":999,"final":999,"discount_percent":0,"initial_formatted":"","final_formatted":"$9.99"}}}}`). Rate limit is unofficial (community reports about 200 calls per 5 minutes per IP, UNVERIFIED); cache results >= 24 h.

`data` keys in order (Portal 2): `type` ("game"), `name`, `steam_appid`, `required_age`, `is_free`, `controller_support` ("full"), `dlc[]`, `detailed_description` (HTML), `about_the_game` (HTML), `short_description` (text, HTML-escaped), `supported_languages` (HTML string), `header_image`, `capsule_image`, `capsule_imagev5`, `website`, `pc_requirements{minimum,recommended}`, `mac_requirements`, `linux_requirements`, `developers[]`, `publishers[]`, `price_overview{currency,initial,final,discount_percent,initial_formatted,final_formatted}`, `packages[]`, `package_groups[]`, `platforms{windows,mac,linux}`, `metacritic{score,url}`, `categories[{id,description}]`, `genres[{id,description}]`, `screenshots[{id,path_thumbnail,path_full}]`, `movies[{id,name,thumbnail,dash_av1,dash_h264,webm{480,max},mp4{480,max},highlight}]`, `recommendations{total}`, `achievements{total,highlighted[{name,path}]}`, `release_date{coming_soon,date}`, `support_info{url,email}`, `background`, `background_raw`, `content_descriptors{ids[],notes}`, `ratings{...}`.

Samples: `"release_date":{"coming_soon":false,"date":"Apr 18, 2011"}` (locale-formatted string; Cyberpunk: `"Dec 9, 2020"`), `"developers":["Valve"]`, `"publishers":["Valve"]`, `"genres":[{"id":"1","description":"Action"},{"id":"25","description":"Adventure"}]`, `"categories":[{"id":2,"description":"Single-player"},{"id":1,"description":"Multi-player"},{"id":9,"description":"Co-op"},{"id":38,"description":"Online Co-op"},{"id":39,"description":"Shared/Split Screen Co-op"},...,{"id":22,"description":"Steam Achievements"}]`, `"metacritic":{"score":95,"url":"https://www.metacritic.com/game/pc/portal-2?ftag=MCD-06-10aaa1f"}`, `"achievements":{"total":51,...}`, `"recommendations":{"total":392514}`, `"platforms":{"windows":true,"mac":false,"linux":true}`, `"header_image":"https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/620/faffc0f560786e2f05104a8d2fac837c6969bf13/header.jpg?t=1790187113"`, `"capsule_image":".../store_item_assets/steam/apps/620/bd23943dcd0280aa2cdc066e2f86d2185cfd4cce/capsule_231x87.jpg?t=..."`, `"capsule_imagev5":".../capsule_184x69.jpg?t=..."`, `"background":"https://store.akamai.steamstatic.com/images/storepagebackground/app/620?t=1790187113"` (serves image/webp, VERIFIED), `"screenshots":[{"id":0,"path_thumbnail":".../ss_f3f6...600x338.jpg?t=...","path_full":".../ss_f3f6...1920x1080.jpg?t=..."}]` (12 entries), `ratings` keys seen: `esrb{rating,descriptors,required_age,use_age_gate}`, `pegi`, `usk`, `dejus`, `oflc`, `nzoflc`, `kgrb`, `cero`, `csrr`, `crl`, `steam_germany`, `igrs`, `mda`, `fpb` (Cyberpunk: `"esrb":{"rating":"m","descriptors":"Blood and Gore\r\nIntense Violence...","required_age":"17","use_age_gate":"true"}`, `"pegi":{"rating":"18",...}`); `content_descriptors` (Cyberpunk): `{"ids":[1,2,5],"notes":"..."}`.

Field mapping: title `name`; description `short_description` + `about_the_game`; release `release_date.date` (parse locale string; prefer IGDB/GOG for ISO dates); developers/publishers arrays; genres `genres[].description`; categories (features) `categories[].description`; rating `metacritic.score`, `ratings.esrb/pegi`, `required_age`; cover -> CDN `library_600x900_2x.jpg`; hero -> `library_hero.jpg`; logo -> `logo.png`; header `header_image`; screenshots `screenshots[].path_full`; trailers `movies[].mp4.max`/`webm.max`.

### 5.2 CDN art URL patterns - VERIFIED with `curl -I` for app ids 620 and 1091500 (`live\steam_cdn_head.txt`)

| File                        | Pixels (620)       | `cdn.cloudflare.steamstatic.com/steam/apps/{appid}/` | `cdn.akamai.steamstatic.com/steam/apps/{appid}/` | `steamcdn-a.akamaihd.net/steam/apps/{appid}/` | `shared.akamai.steamstatic.com/store_item_assets/steam/apps/{appid}/` |
| --------------------------- | ------------------ | ---------------------------------------------------- | ------------------------------------------------ | --------------------------------------------- | --------------------------------------------------------------------- |
| `library_600x900.jpg`       | 300 x 450 (!)      | 200                                                  | 200                                              | 200                                           | 200                                                                   |
| `library_600x900_2x.jpg`    | 600 x 900          | 200                                                  | 200                                              | 200                                           | 200                                                                   |
| `library_hero.jpg`          | 1920 x 620         | 200                                                  | 200                                              | 200                                           | 200                                                                   |
| `logo.png`                  | 640 x 191 (varies) | 200                                                  | 200                                              | 200                                           | 200                                                                   |
| `header.jpg`                | 460 x 215          | 200                                                  | 200                                              | 200                                           | 200                                                                   |
| `capsule_616x353.jpg`       | 616 x 353          | 200                                                  | 200                                              | 200                                           | 200                                                                   |
| `capsule_231x87.jpg`        | 231 x 87           | 200                                                  | 200                                              | 200                                           | -                                                                     |
| `page_bg_generated_v6b.jpg` | 1438 x 809         | 200                                                  | 200                                              | 200                                           | 200                                                                   |
| `hero_capsule.jpg`          | 374 x 448          | 200                                                  | 200                                              | 200                                           | 200                                                                   |
| `library_header.jpg`        | -                  | 404 for 620, 200 for 1091500                         | same                                             | same                                          | -                                                                     |

- `shared.cloudflare.steamstatic.com/steam/apps/...` and `.../store_item_assets/...` answer `301` to `https://shared.steamstatic.com/...` which then serves `200 image/jpeg` (follow redirects). `shared.akamai.steamstatic.com/steam/apps/...` (without `store_item_assets`) is `404`. The hashed form from `appdetails` (`.../store_item_assets/steam/apps/620/faffc0f5.../header.jpg`) also serves 200.
- Game icon: `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/{appid}/{icon_hash}.jpg` (also `cdn.akamai.steamstatic.com` and `media.steampowered.com`; `shared.akamai...` 404). `icon_hash` = `clienticon` from `appinfo.vdf` = `img_icon_url` from `GetOwnedGames` = the `{sha1}.jpg` file name in `appcache/librarycache/{appid}/` (VERIFIED with 620's local `25a5a16b2423bf7487ac5340b5b0948cef48c5f8.jpg`).
- All CDN files are plain GET, no key, cacheable forever; re-check with `If-Modified-Since` monthly. `library_600x900.jpg` is only 300x450 - always fetch `_2x` for the dashboard.

### 5.3 Steam Web API (`https://api.steampowered.com`)

- `GET /ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=620` (no key) -> `{"response":{"player_count":1796,"result":1}}`, `Cache-Control: public, max-age=134` (VERIFIED). Unknown app -> `HTTP 404` `{"response":{"result":42}}`.
- `GET /ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=620` (no key) -> `{"achievementpercentages":{"achievements":[{"name":"ACH.SURVIVE_CONTAINER_RIDE","percent":"74.0"},...]}}` (VERIFIED).
- `GET /ISteamUserStats/GetSchemaForGame/v2/?key=KEY&appid=620&l=english` -> `{"game":{"gameName","gameVersion","availableGameStats":{"achievements":[{name,defaultvalue,displayName,hidden,description,icon,icongray}],"stats":[...]}}}`. Without key: `HTTP 400 Required parameter 'key' is missing` (VERIFIED). Partner doc: `https://partner.steamgames.com/doc/webapi/ISteamUserStats` (params `key`, `appid`, `l`).
- `GET /ISteamUserStats/GetPlayerAchievements/v1/?key=KEY&steamid=7656119...&appid=620&l=english` -> `{"playerstats":{"steamID","gameName","achievements":[{apiname,achieved,unlocktime,name,description}],"success":true}}`; needs the profile's game details public, else `{"playerstats":{"error":"Profile is not public","success":false}}` (UNVERIFIED wording). Without key: 400 (VERIFIED).
- `GET /IPlayerService/GetOwnedGames/v1/?key=KEY&steamid=7656119...&include_appinfo=1&include_played_free_games=1&format=json` (optional `appids_filter[0]=620`, `include_free_sub`, `skip_unvetted_apps`, `language`, `include_extended_appinfo` - the last four are UNVERIFIED) -> `{"response":{"game_count":N,"games":[{"appid":620,"name":"Portal 2","playtime_forever":1108,"img_icon_url":"25a5a16b...","has_community_visible_stats":true,"playtime_windows_forever":...,"playtime_mac_forever":...,"playtime_linux_forever":...,"playtime_deck_forever":...,"rtime_last_played":1777548408,"playtime_disconnected":0,"playtime_2weeks":...}]}}` (minutes; Playnite's model confirms `appid,name,playtime_forever,rtime_last_played`; the other names come from Playnite's `ClientPlaytime` model/`IPlayerService/ClientGetLastPlayedTimes`, UNVERIFIED on this exact endpoint). Without key: `HTTP 401 ... Please verify your key= parameter` (VERIFIED). Partner doc: `https://partner.steamgames.com/doc/webapi/IPlayerService`.
- `ISteamApps/GetAppList/v2` is gone: `HTTP 404 Method 'GetAppList' not found in interface 'ISteamApps'` (VERIFIED today). Use `IStoreService/GetAppList/v1` (key required, paginated `last_appid`/`max_results`) if a full list is ever needed; GameDash does not need it.
- Key: `https://steamcommunity.com/dev/apikey` (redirects to login when logged out - VERIFIED; requires a non-limited Steam account, you enter a "domain name" label and accept the terms - UNVERIFIED details). Terms (`https://steamcommunity.com/dev/apiterms`, VERIFIED): "You are limited to one hundred thousand (100,000) calls to the Steam Web API per day"; section 3 grants/obliges use of the "Valve Brand & Links" per the "Steam Web API Network Branding Requirements" on pages using Steam Data; no unsolicited marketing.
- steamid64: read `C:\Program Files (x86)\Steam\config\loginusers.vdf` (`"users" { "76561198000000101" { "AccountName" "...", "PersonaName" "...", "RememberPassword" "1", "WantsOfflineMode" "0", "SkipOfflineModeWarning" "0", "AutoLogin" "1", "timestamp" "1793300699" } ... }`, VERIFIED - the most recent `timestamp`/`AutoLogin "1"` is the active user), or compute `steamid64 = 76561197960265728 + accountid` where `accountid` = `HKCU\Software\Valve\Steam\ActiveProcess\ActiveUser` (REG_DWORD, `0x16da3b3` = 39734373 today) = the `userdata\<accountid>` folder name (VERIFIED: 76561198000000101 - 76561197960265728 = 39734373).

### 5.4 Local Steam files (VERIFIED on this machine, Steam client build `Version` 0x6ad92f2d)

- Install path: `HKCU\Software\Valve\Steam\SteamPath` = `c:/program files (x86)/steam` (also `SteamExe`, `Language`, `AutoLoginUser`), `HKLM\SOFTWARE\WOW6432Node\Valve\Steam\InstallPath` = `C:\Program Files (x86)\Steam`. Per-app flags: `HKCU\Software\Valve\Steam\Apps\{appid}` -> `Installed`, `Updating`, `Running` (DWORD), `Name`. Protocol handler `HKCR\steam\Shell\Open\Command` = `"C:\Program Files (x86)\Steam\steam.exe" -- "%1"`.
- Libraries: `steamapps\libraryfolders.vdf` (`"libraryfolders" { "0" { "path" "C:\\Program Files (x86)\\Steam", "label", "contentid", "totalsize", "apps" { "2620" "954204780", ... } } }`), per-library `steamapps\appmanifest_{appid}.acf` keys: `appid, Universe, LauncherPath, name, StateFlags (4 = fully installed), installdir, lastupdated, LastPlayed, SizeOnDisk, StagingSize, buildid, LastOwner, DownloadType, AutoUpdateBehavior, AllowOtherDownloadsWhileRunning, ScheduledAutoUpdate, InstalledDepots{...}, UserConfig{}, MountedConfig{}`.
- `appcache\appinfo.vdf` (binary VDF, magic `29 44 56 07 01 00 00 00` = version 0x07564429 "29DV" v1 today, 29 MB) holds `common.clienticon`, `common.name`, `common.type`.
- `appcache\librarycache\` **new layout (current client)**: one sub-folder per app id (`9789` folders here) containing `header.jpg`, `library_600x900.jpg`, `library_hero.jpg`, `library_hero_blur.jpg`, `logo.png`, sometimes `library_header.jpg`, the icon as `{sha1}.jpg` (e.g. `620\25a5a16b2423bf7487ac5340b5b0948cef48c5f8.jpg`), and newer per-asset-hash sub-folders `{appid}\{sha1}\library_hero.jpg|library_hero_blur.jpg|library_header.jpg` (e.g. `620\a58588d857b8683f8065e55f97ab82ad8a945c51\library_hero.jpg`) when an asset was updated; `librarycache\assetcache.vdf` (binary) indexes `library_600x900.jpg, library_hero.jpg, logo.png, header.jpg, {icon}.jpg, library_hero_blur.jpg` per app. **Old flat layout** (Steam clients before ~mid-2024): `librarycache\{appid}_library_600x900.jpg`, `{appid}_header.jpg`, `{appid}_library_hero.jpg`, `{appid}_logo.png`, `{appid}_icon.jpg` (not present on this machine, UNVERIFIED here - support both: check `{appid}\` folder first, then `{appid}_*` files).
- Play time: `userdata\{accountid}\config\localconfig.vdf` -> `"UserLocalConfigStore" > "Software" > "Valve" > "Steam" > "apps" > "{appid}"` with `"LastPlayed" "1777548408"` (unix seconds), `"Playtime" "1108"` (minutes, total), optional `"Playtime2wks"` (minutes), `"PlaytimeDisconnected"`, `"LaunchOptions"`, `"cloud" { "last_sync_state" ... }`, `"autocloud"`, `"BadgeData"` (VERIFIED: 1369 app entries here; key counts LastPlayed 1369, Playtime 1361, PlaytimeDisconnected 44, Playtime2wks 12). A second top-level `"apps"` block (controller config: `UseSteamControllerConfig`, `SteamControllerRumble`) exists at the root - only read the nested one. `userdata\{accountid}\config\librarycache\{appid}.json` = `[["achievements",{"version":2,"data":{"vecHighlight":[],"vecUnachieved":[],"vecAchievedHidden":[],"nTotal":0,"nAchieved":0}}]]` (per-user achievement cache, VERIFIED). `userdata\{accountid}\config\grid\` holds user-set custom art (`{appid}p.jpg` portrait, `{appid}_hero.jpg`, `{appid}_logo.png`, `{appid}.jpg` wide, `{appid}_icon.jpg`) - folder absent here, naming UNVERIFIED (from SteamGridDB conventions).

### 5.5 `steam://` URIs

Handler VERIFIED (registry above). Commands used by Playnite's Steam plugin (`SteamGameController.cs`/`SteamLibrary.cs`, VERIFIED from source): `steam://rungameid/{appid}`, `steam://install/{appid}`, `steam://uninstall/{appid}`, `steam://launch/{appid}/{dialog}`, `steam://open/friends`. Valve's reference page `https://developer.valvesoftware.com/wiki/Steam_browser_protocol` is behind an Anubis proof-of-work bot check today (HTML "Making sure you're not a bot!"), and archive.org answered 429, so the rest of the list is from that page as remembered (UNVERIFIED): `steam://run/{appid}` (same as rungameid for non-mod apps), `steam://open/{games|library|downloads|settings|friends|bigpicture|screenshots|console|activateproduct|news|minigameslist|largegameslist|mygames|main|servers|store|tools}`, `steam://nav/games/details/{appid}`, `steam://store/{appid}`, `steam://validate/{appid}`, `steam://url/StoreAppPage/{appid}`, `steam://url/CommunityFilePage/{id}`, `steam://ExitSteam`, `steam://preload/{appid}`, `steam://updatenews/{appid}`, `steam://advertise/{appid}`. From Electron use `shell.openExternal('steam://rungameid/620')`.

---

## 6. HowLongToBeat (late 2026)

### 6.1 Library status

- npm `howlongtobeat` - latest `1.8.0` published 2023-07-09 (registry `time` VERIFIED); repo `ckatzorke/howlongtobeat` last push 2024-06-11, 15 open issues/PRs including "Fix broken search API, detail parser, and SSRF vulnerability" (updated 2026-04-10), "scrape search key for every request" (2025-06), "[Python API Update] The search url changed" (2024-08) (GitHub API, VERIFIED). **Do not use it**: it predates the token requirement and the endpoint renames. PyPI `howlongtobeatpy` is at 1.0.24 (status untested).
- The most current open-source implementation is RomM's (`backend/handler/metadata/hltb_handler.py`, `backend/utils/hltb_search.py`, `backend/utils/update_hltb_api_url.py`, fetched 2026-10-29). Their bundled fixture `fixtures/hltb_api_url` = `https://howlongtobeat.com/api/search/site` and they re-discover the route at startup from the Next.js `_buildManifest.js` because "HLTB rotates their search endpoint regularly".

### 6.2 Current mechanism (extracted from `howlongtobeat.com`'s own JS chunk `1ip4u_c7v73bt.js`, downloaded 2026-10-29, build id `liixr6QPisxghANfwUuFH`, VERIFIED)

```js
// 1) mint a search session
fetch(`/api/search/site/init?t=${Date.now()}`) // -> {"token": "..."}  (RomM also reads optional "hpKey"/"hpVal")
// 2) search
fetch('/api/search/site', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
  body: JSON.stringify({
    searchType: 'games',
    searchTerms: ['portal', '2'],
    searchPage: 1,
    size: 20,
    searchOptions: {
      games: {
        userId: 0,
        platform: '',
        sortCategory: 'popular',
        rangeCategory: 'main',
        rangeTime: { min: null, max: null },
        gameplay: { perspective: '', flow: '', genre: '' },
        year: '',
        modifier: ''
      },
      users: { sortCategory: 'postcount' },
      lists: { sortCategory: 'follows' },
      filter: '',
      sort: 0,
      randomizer: 0
    },
    useCache: true
  })
})
// 403 => "Search token expired, refreshing and retrying..." (re-run step 1); 429 => "Too many searches, please wait a minute and try again."
```

RomM's `hltb_search.py` adds: a real browser `User-Agent` (their constant: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36` - "HLTB's firewall rejects tool-style Name/version agents with a 403"), `Referer: https://howlongtobeat.com`, `Origin: https://howlongtobeat.com`, and, when `/init` returned `hpKey`/`hpVal`, headers `x-hp-key`/`x-hp-val` plus the same key/value echoed into the JSON body. The token "decodes to `<issued-at>::<public IP>|<user agent>.<hmac>`", i.e. it is bound to the client IP and UA - mint it from the same process that searches, never share it. RomM paces at 3 requests/s, renews on 403, backs off 2 s on 429.

Search response (`data[]` item fields; TypedDict `HLTBGame` in RomM, and the identical keys appear in the live game page JSON below): `game_id, game_name, game_name_date, game_alias, game_type ("game"|"dlc"), game_image, comp_lvl_combine, comp_lvl_sp, comp_lvl_co, comp_lvl_mp, comp_main, comp_plus, comp_100, comp_all, comp_main_count, comp_plus_count, comp_100_count, comp_all_count, invested_co, invested_mp, invested_co_count, invested_mp_count, count_comp, count_speedrun, count_backlog, count_review, review_score, count_playing, count_retired, profile_dev, profile_popular, profile_steam, profile_platform, release_world`. Envelope: `{"color", "title", "category": "games", "count", "pageCurrent", "pageTotal", "pageSize", "data": [...]}` (envelope keys UNVERIFIED). `comp_*` are **seconds** (Portal 2 `comp_main` 30885 s = 8 h 35 m, matching the site's "8.5 Hours"); `comp_main` = Main Story, `comp_plus` = Main + Extra, `comp_100` = Completionist, `comp_all` = All Styles. Cover: `https://howlongtobeat.com/games/{game_image}` (e.g. `https://howlongtobeat.com/games/Portal2cover.jpg` -> 200 image/jpeg, VERIFIED).

### 6.3 What I actually ran

- `POST https://howlongtobeat.com/api/search` (old payload, no token) -> `HTTP 403 Unavailable (IFW-E01)`, Varnish error page (`live\hltb_search_response` not produced; headers recorded in the session log). This is the exact failure mode of the npm package.
- `GET https://howlongtobeat.com/game/7231` with a browser UA -> `200`, 32 342 bytes, contains `<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"game":{"count":2,"data":{"game":[{"count_discussion":3,"game_id":7231,"game_name":"Portal 2",...,"review_score":90,"game_image":"Portal2cover.jpg","game_type":"game","profile_summary":"...","profile_dev":"Valve Corporation","profile_pub":"Valve Corporation","profile_platform":"Linux, Mac, Nintendo Switch, PC, PlayStation 3, Xbox 360","profile_genre":"First-Person, Real-Time, Platform, Puzzle","profile_steam":620,...,"release_world":"2011-04-18","release_na":"2011-04-18","release_eu":"2011-04-21","release_jp":"2011-04-22","comp_all_count":8775,"comp_all":38322,"comp_main_count":5567,"comp_main":30885,"comp_plus_count":2467,"comp_plus":49570,"comp_100_count":741,"comp_100":82821,"invested_co":34521,"invested_mp":24321,...}` (file `live\hltb_game_7231.html`, VERIFIED). So, given an HLTB `game_id`, the public game page is a token-free way to read all four times plus `profile_steam` (Steam app id!) - useful for mapping Steam games to HLTB without search.
- The `/init` + `x-auth-token` POST pair was **not executed from this session**: the harness's permission classifier refused the command as bot-check circumvention. Implementers must run it themselves (it is exactly what the site's own front end does; RomM's CI exercises it).

### 6.4 Recommendations

- Treat HLTB as best-effort and optional (user toggle). Cache per game for 30 days; cache the session token in memory only; one search per second at most; stop for the day on repeated 403/429.
- Prefer IGDB `game_time_to_beats` (official, keyed) when the game has an IGDB id; fall back to HLTB search, then to the game page by `game_id` for refreshes. Match by `profile_steam` when available, else fuzzy on `game_name` + `release_world` year.
- Licensing: HLTB has no public API or terms permitting scraping (UNVERIFIED); show "Times from HowLongToBeat.com" with a link, do not mirror their covers.

---

## 7. GOG (keyless)

### 7.1 `api.gog.com/products/{id}` - VERIFIED live

`GET https://api.gog.com/products/1207658924?expand=description,screenshots,videos,related_products,downloads,expanded_dlcs,changelog` -> `200 application/json`, `cache-control: max-age=86400`, `access-control-allow-origin: https://www.gog.com`. Unknown id -> `404 {"error":"Product not found"}` (`/products/1` is a real product, "Fallout Classic"). Also works for installed ids from the registry: `1454587428` -> "Fallout: New Vegas Ultimate Edition" (`release_date` can be `null`).

Keys: `id, title, purchase_link, slug, content_system_compatibility{windows,osx,linux}, languages{en:"English",...}, links{purchase_link,product_card,support,forum}, in_development{active,until}, is_secret, is_installable, game_type ("game"|"dlc"|"pack"), is_pre_order, release_date ("2011-05-09T23:00:00+0200"), images{background, logo, logo2x, sidebarIcon, sidebarIcon2x, menuNotificationAv, menuNotificationAv2, icon}, dlcs[], description{lead, full, whats_cool_about_it} (HTML), screenshots[{image_id, formatter_template_url, formatted_images[{formatter_name, image_url}]}], videos[{video_url, thumbnail_url, provider}], related_products[], downloads{installers,patches,language_packs,bonus_content}, expanded_dlcs[], changelog`.
Image URLs are protocol-relative: `"background":"//images-2.gog-statics.com/c73009d1...8a3a.jpg"`, `"logo":"//images-1.gog-statics.com/37d4a208..._glx_logo.jpg"`, `"logo2x":"..._glx_logo_2x.jpg"`, `"sidebarIcon":"..._sbicon.png"`, `"icon":"//images-4.gog-statics.com/82ecfe17...7898.png"` (prefix `https:`; all three 200 today). Screenshot formatters: `ggvgt`, `ggvgt_2x` (thumb), `ggvgm`, `ggvgm_2x` (medium), `ggvgl`, `ggvgl_2x` (large); template `https://images-2.gog-statics.com/{image_id}_{formatter}.png` (`formatted_images[].image_url` end in `.jpg`).

### 7.2 `api.gog.com/v2/games/{id}?locale=en-US` - VERIFIED live (26 KB)

Keys: `inDevelopment, copyrights, isUsingDosBox, technologies, releaseStatus, description (HTML), size, overview, featuresDescription, _links{self, store, support, forum, icon, logo, boxArtImage, backgroundImage, galaxyBackgroundImage, isIncludedInGames[]}, _embedded{product{id, title, isAvailableForSale, isVisibleInCatalog, isPreorder, globalReleaseDate ("2007-10-26T00:00:00+02:00"), gogReleaseDate, category "GAME", hasHowLongToBeatInformation, hasOpenCriticInformation, _links{image{href "https://images.gog-statics.com/<hash>_{formatter}.png", templated, formatters ["800","1600","glx_logo","glx_logo_2x","product_630","product_630_2x"]}, checkout, prices}}, productType, localizations[{language{code,name}, localizationScope{type audio|text}}], videos[{provider "youtube", videoId, thumbnailId, _links{self, thumbnail}}], bonuses, screenshots[{_links{self{href "https://images.gog-statics.com/<hash>_{formatter}.jpg", formatters ["product_card_screenshot_112","product_card_screenshot_748","product_card_screenshot_748_2x","1600"]}}}], publisher{name}, developers[{name}], supportedOperatingSystems[{operatingSystem{name,versions}, systemRequirements}], tags[{name,level,slug}], properties, esrbRating{ageRating, contentDescriptors}, pegiRating, uskRating, gogRating, features[{name,slug}], editions, series}`. Direct links: `_links.boxArtImage.href` (portrait box art), `_links.backgroundImage.href`, `_links.galaxyBackgroundImage.href`, `_links.logo.href` (PNG), `_links.icon.href` - all plain `https://images.gog-statics.com/<hash>.jpg|png` (200 today).

### 7.3 `gamesdb.gog.com` (GOG Galaxy's cross-store game database) - VERIFIED live, no auth

- `GET https://gamesdb.gog.com/platforms/{platform}/external_releases/{external_id}` -> `200` for `gog/1207658924`, `steam/620`, `epic/fn` (Fortnite's catalog namespace), `origin/...`, `uplay/...` (`uplay/1` and `origin/1` returned 200); `xbox` and `egs` -> `400` (unknown platform); `battlenet`, `amazon`, `humble` -> `404`; unknown id -> `404 {"error":"not_found"}`. Headers: `Cache-Control: public, max-age=540, must-revalidate, stale-while-revalidate=550`, `ETag`.
- `GET https://gamesdb.gog.com/games/{game_id}` -> the inner game object (`51295405645397160` -> 200). `/platforms` listing -> 404.
- Response (release object): `id, game_id, platform_id, external_id, dlcs_ids[], dlcs[{id, platform_id, external_id, release_per_platform_id, availability}], parent_id, supported_operating_systems[{slug,name}], available_languages[{code}], first_release_date ("2011-04-18T00:00:00+0000"), game{...}, title{"*","en-US"}, sorting_title, type, summary{"*","en-US"}, videos, game_modes, icon, logo, series`.
  `game`: `id, parent_id, dlcs_ids, mods_ids, first_release_date, releases[{id, platform_id ("steam"|"gog"|"origin"|"epic"|"uplay"|"test"|"playfire"...), external_id, release_per_platform_id, availability}], title{"*","en-US"}, sorting_title, type ("game"), developers_ids, developers[{id,name,slug}], publishers_ids, publishers[{id,name,slug}], genres_ids, genres[{id, name{"*","en-US"}, slug}], themes_ids, themes[{id,name,slug}], screenshots[{url_format}], videos[{provider "youtube", video_id, thumbnail_id, name}], artworks[], summary{"*","en-US"}, visible_in_library, aggregated_rating (e.g. 85.5 or null), game_modes[{id,name,slug}], horizontal_artwork{url_format}, background{url_format}, vertical_cover{url_format}, cover{url_format}, logo{url_format}, icon{url_format}, square_icon{url_format}, global_popularity_all_time, global_popularity_current, series{id,name,slug}, slug`.
- Image templates: `"url_format": "https://images.gog.com/<64-hex>{formatter}.{ext}?namespace=gamesdb"`. VERIFIED 200 (webp/jpg/png all served) with formatter `""` (original), `_glx_vertical_cover` (Galaxy portrait tile), `_glx_logo`, `_glx_logo_2x`, `_glx_square_icon_v2`, `_glx_bg_top_padding_7` (Galaxy background), `_product_tile_256`, `_800`, `_1600` for `vertical_cover`, `cover`, `background`, `horizontal_artwork`, `logo`, `square_icon`; screenshots accept `""`, `_1600`, `_product_card_screenshot_748`, `_ggvgm`, `_ggvgl`. Sizes observed: vertical cover original webp 64 KB / png 222 KB; background png 2.2 MB (use `_1600` or `webp`). `_glx_vertical_cover_2x` is not served.
- This endpoint is the easiest keyless way to get **portrait covers, logos and backgrounds for Steam, Epic, Origin/EA and Ubisoft ids** (it is what GOG Galaxy uses for imported games). Epic lookups use the catalog namespace as `external_id` (verified for `fn`; other namespaces UNVERIFIED).

### 7.4 Other GOG endpoints

- `https://catalog.gog.com/v1/catalog?limit=5&query=like:witcher&order=desc:score&productType=in:game` -> 200, `products[{id, slug, title, developers, publishers, genres, screenshots[" https://images.gog-statics.com/<hash>_{formatter}.jpg"], coverHorizontal, coverVertical, releaseDate, ...}]` (store search, VERIFIED reachable).
- `https://embed.gog.com/games/ajax/filtered?mediaType=game&search=witcher` -> 200 but `products: []` today (search index apparently gone; Playnite still references `www.gog.com/games/ajax/filtered`). `https://api.gog.com/products/{id}/prices?countryCode=US` for prices (templated in `_links`).
- Local: `HKLM\SOFTWARE\WOW6432Node\GOG.com\Games\{productID}` values `gameID`, `gameName`, `productID`, `path`, `exe`, `launchCommand`, `buildId`, `dependsOn` (VERIFIED, e.g. `1454587428` "Fallout: New Vegas" at `C:\Program Files (x86)\GOG Galaxy\Games\Fallout New Vegas`); handler `goggalaxy://` = `"C:\Program Files (x86)\GOG Galaxy\GalaxyClient.exe" /urlProtocol="%1"` (launch via `goggalaxy://openGameView/{productID}` or run `GalaxyClient.exe /command=runGame /gameId={productID} /path="{path}"` - UNVERIFIED).

### 7.5 Field mapping, caching, licensing

title `title` (products) / `title["*"]` (gamesdb); description `description.lead`+`full` (products) / `summary["*"]` (gamesdb); release `release_date` / `_embedded.product.globalReleaseDate` / `first_release_date`; developers/publishers `developers[].name`, `publisher.name` (v2) or gamesdb arrays; genres gamesdb `genres[].name["*"]` or v2 `tags`; rating gamesdb `aggregated_rating`, v2 `esrbRating`/`pegiRating`; cover gamesdb `vertical_cover` (`_glx_vertical_cover`) or v2 `boxArtImage`; hero/background gamesdb `background` / products `images.background`; logo gamesdb `logo` or products `images.logo2x`; icon `square_icon` / `images.icon`; screenshots gamesdb `screenshots[].url_format` or products `screenshots`.
Caching: honour `max-age=86400` (products) and `max-age=540` (gamesdb); cache images forever by hash. Licensing: undocumented internal endpoints used by GOG Galaxy/Playnite/Heroic (UNVERIFIED terms); keep request volume low (one call per game per day at most) and identify with a UA like `GameDash/1.0`.

---

## 8. Epic Games Store (keyless)

### 8.1 Local identity of an installed game

`C:\ProgramData\Epic\EpicGamesLauncher\Data\Manifests\*.item` (JSON; Playnite `InstalledManifiest` model: `LaunchCommand, LaunchExecutable, ManifestLocation, bIsApplication, bIsExecutable, bRequiresAuth, bCanRunOffline, AppName, CatalogNamespace, CatalogItemId, AppCategories[], CompatibleApps[], DisplayName, FullAppName, InstallationGuid, InstallLocation, InstallSessionId, StagingLocation, TechnicalType, VaultThumbnailUrl, VaultTitleText, InstallSize, MainWindowProcessName, ProcessNames[], MainGameAppName, MandatoryAppFolderName`; skip `AppCategories` containing `addons` without `addons/launchable`, and `plugins`/`plugins/engine`). `C:\ProgramData\Epic\UnrealEngineLauncher\LauncherInstalled.dat` = `{"InstallationList":[{"InstallLocation","AppName","AppID","AppVersion"}]}` (file present here, empty list; `Data\Manifests` absent because nothing is installed - layout from Playnite's `EpicLauncher.cs`). Launch: `com.epicgames.launcher://apps/{CatalogNamespace}%3A{CatalogItemId}%3A{AppName}?action=launch&silent=true`; install: `com.epicgames.launcher://apps/{AppName}?action=install` (Playnite). Handler VERIFIED: `HKCR\com.epicgames.launcher\shell\open\command` = `"C:\Program Files\Epic Games\Launcher\Portal\Binaries\Win64\EpicGamesLauncher.exe" %1`.

### 8.2 Store GraphQL `https://store.epicgames.com/graphql` - VERIFIED live, no login

- Requires a browser-like `User-Agent` (default curl UA -> `403`; with a Chrome UA -> `200`; Cloudflare sets `__cf_bm`). `Content-Type: application/json`, `Cache-Control: max-age=120, public`. `https://graphql.epicgames.com/graphql` is dead (`404 Gone`).
- Namespace -> offers (resolves `CatalogItemId`):

```
POST https://store.epicgames.com/graphql
{"query":"query { Catalog { searchStore(namespace: \"min\", category: \"games/edition/base\", country: \"US\", locale: \"en-US\", count: 5) { elements { title id namespace offerType productSlug urlSlug effectiveDate releaseDate developerDisplayName publisherDisplayName seller { name } items { id namespace } keyImages { type url } categories { path } tags { id name groupName } customAttributes { key value } catalogNs { mappings(pageType: \"productHome\") { pageSlug } } } } } }"}
```

-> `{"data":{"Catalog":{"searchStore":{"elements":[{"title":"Hades","id":"2ae6edb2223c4f8c97e9839b5b6497bb","namespace":"min","offerType":"BASE_GAME","productSlug":"hades","urlSlug":"hades","effectiveDate":"2019-12-09T09:00:00.000Z","releaseDate":"2019-12-10T11:00:00.000Z","developerDisplayName":"Supergiant Games","publisherDisplayName":"Supergiant Games","seller":{"name":"Supergiant Games LLC"},"items":[{"id":"d6c3519c087c4a5e92e7ab3fee2dd4f5","namespace":"min"}],"keyImages":[{"type":"OfferImageTall","url":"https://cdn1.epicgames.com/min/offer/1200x1600-1200x1600-e92fa6b99bb20c9edee19c361b8853b9.jpg"},{"type":"OfferImageWide","url":"https://cdn1.epicgames.com/min/offer/2560x1440-2560x1440-5e710b93049cbd2125cf0261dcfbf943.jpg"},{"type":"Thumbnail",...},{"type":"CodeRedemption_340x440",...},{"type":"DieselStoreFrontTall",...},{"type":"DieselStoreFrontWide",...},{"type":"heroCarouselVideo","url":"com.epicgames.video://..."},{"type":"featuredMedia",...},{"type":"GalleryImage","url":"https://cdn2.unrealengine.com/egs-hades-supergiantgames-g2-00-1920x1080-027048640.jpg"},...],"categories":[{"path":"games"},{"path":"games/edition"},{"path":"games/edition/base"}],"tags":[{"id":"1216","name":"Action","groupName":"genre"},{"id":"1258","name":"Rogue-Like","groupName":null},{"id":"9547","name":"Windows","groupName":"platform"},{"id":"9549","name":"Controller Support","groupName":"feature"},{"id":"19847","name":"Achievements","groupName":"epicfeature"},...],"catalogNs":{"mappings":[{"pageSlug":"hades"}]}}]}}}}` (file `live\epic_graphql_namespace_min.json`). Match `items[].id` against the manifest's `CatalogItemId`.

- Namespace -> page slug only: `{"query":"query { Catalog { catalogNs(namespace: \"min\") { mappings(pageType: \"productHome\") { pageSlug pageType } } } }"}` -> `{"data":{"Catalog":{"catalogNs":{"mappings":[{"pageSlug":"hades","pageType":"productHome"}]}}}}` (VERIFIED).
- Offer by id: `{"query":"query { Catalog { catalogOffer(namespace: \"min\", id: \"2ae6edb2223c4f8c97e9839b5b6497bb\", locale: \"en-US\") { title description longDescription developerDisplayName publisherDisplayName releaseDate keyImages { type url } items { id namespace } } } }"}` -> `longDescription` is markdown with `<!--textBlock-->` comments (VERIFIED).
- Name search: `searchStore(keywords: "hades", country: "US", locale: "en-US", count: 3)` (VERIFIED; same element shape). The free-games endpoint `https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=US&allowCountries=US` (200, no UA requirement) shows the complete element schema incl. `price`, `promotions`, `offerMappings`, `viewableDate`, `expiryDate`, `isCodeRedemptionOnly`.
- keyImage types: `OfferImageTall` (1200x1600 portrait - cover), `OfferImageWide` (2560x1440 - hero), `DieselStoreFrontTall/Wide`, `Thumbnail`, `CodeRedemption_340x440`, `GalleryImage` (1920x1080 screenshots), `featuredMedia`, `heroCarouselVideo` (`com.epicgames.video://` ids, not fetchable). Hosts: `cdn1.epicgames.com`, `cdn2.unrealengine.com` (plain GET).

### 8.3 Store content pages `https://store-content.ak.epicgames.com/api/{locale}/content/products/{pageSlug}` - VERIFIED live, no auth, default UA accepted

(`store-content-ipv4.ak.epicgames.com` identical.) `GET .../api/en-US/content/products/hades` -> 15 KB JSON: `productName, namespace ("min"), _slug, _urlPattern ("/productv2/hades"), _title, regionBlock, pageTheme{...accent}, lastModified, _locale, _id, _templateName ("productNamespace"), pages[{ _slug ("hades" / "home"), _urlPattern, item{catalogId, appName, namespace, hasItem}, offer{id, namespace, ...}, data{ about{title, description (markdown), shortDescription, developerAttribution, publisherAttribution, image{src}, developerLogo}, hero{logoImage{src}, portraitBackgroundImageUrl, backgroundImageUrl, video{...}}, carousel{items[{image{src}, video{...}}]}, gallery{galleryImages[{src,row}]}, meta{releaseDate ("2018-12-06T13:00:00.000Z"), customReleaseDate, publisher[], developer[], platform[], tags[], logo}, requirements{languages[], systems[{systemType, details[{title, minimum, recommended}]}], legalTags, accountRequirements, rating}, productSections, seo{twitter, og}, markdown, dlc{dlc[...]}, editions, productLinks, socialLinks, footer{copy, privacyPolicyLink}, ageGate }}]`. Hades sample: `"about":{"image":{"src":"https://cdn2.unrealengine.com/hades-portrait-promo-01-1280x1420-983740828.png"},"developerAttribution":"Supergiant Games","publisherAttribution":"Supergiant Games","shortDescription":"Defy the god of the dead...","description":"Supergiant's critically acclaimed titles ... **Bastion** ..."}`, `"hero":{"logoImage":{"src":"https://cdn2.unrealengine.com/hades-logo-launch-messaging-2000x647-983740753.png"},"portraitBackgroundImageUrl":"...hades-portrait-promo-01-1280x1420-983740828.png","backgroundImageUrl":"https://cdn2.unrealengine.com/hades-eventcover-01-800x450-983740629.png"}`, `"meta":{"releaseDate":"2018-12-06T13:00:00.000Z","publisher":["Supergiant Games"],"developer":["Supergiant Games"],"platform":["Windows","Mac"],"tags":["ACTION","RPG","ROGUE_LITE"]}`. The `pages[].item.catalogId` is often empty (`""` for Hades) - do not rely on it for reverse mapping; use GraphQL `items[].id`. Unknown slug -> 404 (UNVERIFIED).

### 8.4 Endpoints that need an Epic OAuth token (not usable in v1) - VERIFIED 401 today

`https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/namespace/{ns}/bulk/items?id={itemId}&includeDLCDetails=true&includeMainGameDetails=true&country=US&locale=en` (legendary/Playnite) -> `401 {"errorCode":"errors.com.epicgames.common.authentication.authentication_failed",...,"numericErrorCode":1032}`; `https://launcher-public-service-prod06.ol.epicgames.com/launcher/api/public/assets/Windows?label=Live` -> 401; `https://library-service.live.use1a.on.epicgames.com/library/api/public/items` and `.../playtime/account/{id}/all` (Playnite, auth) - these give official play time but require the store sign-in that v1 excludes. `https://egs-platform-service.store.epicgames.com/api/v1/egs/products/{slug}?country=US&locale=en-US&store=EGS` -> `403` Cloudflare JS challenge (not usable from a plain HTTP client).

### 8.5 Resolution flow, field mapping, caching, licensing

1. Read `.item` -> `CatalogNamespace`, `CatalogItemId`, `DisplayName`.
2. GraphQL `searchStore(namespace, category:"games/edition/base")` -> pick the element whose `items[].id == CatalogItemId` (fallback: title match) -> `title`, `releaseDate`, `developerDisplayName`, `publisherDisplayName`, `description` (short), `tags[groupName=genre]`, `keyImages` (`OfferImageTall` cover, `OfferImageWide` hero, `GalleryImage` screenshots), `catalogNs.mappings[0].pageSlug`.
3. `store-content .../products/{pageSlug}` -> `about.description` (long, markdown), `hero.logoImage.src` (logo), `hero.backgroundImageUrl`, `gallery.galleryImages`, `meta.releaseDate`, `requirements`.
4. Optional cross-ref: `gamesdb.gog.com/platforms/epic/external_releases/{CatalogNamespace}` (works for `fn`; others UNVERIFIED) and SteamGridDB `/grids/egs/{CatalogItemId}`.
   Cache GraphQL/store-content results 7 days (they are static marketing pages); images forever. Licensing: undocumented web endpoints (no API terms published; UNVERIFIED) - rate-limit to a few requests per minute, send a stable UA, degrade gracefully on 403.

---

## 9. Platform ids (companion `platform-ids.json`)

Sources: **IGDB** ids from RomM `backend/adapters/services/igdb.py` (`IGDB_PLATFORM_LIST`, generated from the IGDB `/v4/platforms` endpoint; every entry carries the IGDB `slug` and `url`), cross-checked against the author's knowledge of the IGDB numbering (all 42 match). **ScreenScraper** ids from three independent sources that agree on every row: ES-DE `ScreenScraper.cpp` (`screenscraper_platformid_map`), RomM `ss_handler.py` (`SS_PLATFORM_LIST` + `PS1_SS_ID=57, PS2_SS_ID=58, PSP_SS_ID=61, SWITCH_SS_ID=225, ARCADE_SS_ID=75`), Skyscraper `platforms_idmap.csv`. **TheGamesDB** ids from ES-DE `GamesDBJSONScraper.cpp` (`gamesdb_new_platformid_map`), RomM `tgdb_handler.py` (`TGDB_PLATFORM_LIST`, built from `/v1/Platforms`), Skyscraper csv - all agree. Refresh with the live calls in sections 2.6 / 3.3 / 4.4 when credentials are available.

| key          | IGDB (name/slug)                 | ScreenScraper (name)                                     | TheGamesDB (name)                      |
| ------------ | -------------------------------- | -------------------------------------------------------- | -------------------------------------- |
| nes          | 18 nes                           | 3 NES                                                    | 7 Nintendo Entertainment System (NES)  |
| snes         | 19 snes                          | 4 Super Nintendo                                         | 6 Super Nintendo (SNES)                |
| n64          | 4 n64                            | 14 Nintendo 64                                           | 3 Nintendo 64                          |
| gc           | 21 ngc                           | 13 GameCube                                              | 2 Nintendo GameCube                    |
| wii          | 5 wii                            | 16 Wii                                                   | 9 Nintendo Wii                         |
| wiiu         | 41 wiiu                          | 18 Wii U                                                 | 38 Nintendo Wii U                      |
| switch       | 130 switch                       | 225 Switch                                               | 4971 Nintendo Switch                   |
| gb           | 33 gb                            | 9 Game Boy                                               | 4 Nintendo Game Boy                    |
| gbc          | 22 gbc                           | 10 Game Boy Color                                        | 41 Nintendo Game Boy Color             |
| gba          | 24 gba                           | 12 Game Boy Advance                                      | 5 Nintendo Game Boy Advance            |
| nds          | 20 nds                           | 15 Nintendo DS                                           | 8 Nintendo DS                          |
| 3ds          | 37 3ds                           | 17 Nintendo 3DS                                          | 4912 Nintendo 3DS                      |
| mastersystem | 64 sms                           | 2 Master System                                          | 35 Sega Master System                  |
| genesis      | 29 genesis-slash-megadrive       | 1 Megadrive                                              | 18 Sega Genesis (36 = Sega Mega Drive) |
| segacd       | 78 sega-cd                       | 20 Mega-CD                                               | 21 Sega CD                             |
| sega32x      | 30 sega32                        | 19 Megadrive 32X                                         | 33 Sega 32X                            |
| saturn       | 32 saturn                        | 22 Saturn                                                | 17 Sega Saturn                         |
| dreamcast    | 23 dc                            | 23 Dreamcast                                             | 16 Sega Dreamcast                      |
| gamegear     | 35 gamegear                      | 21 Game Gear                                             | 20 Sega Game Gear                      |
| psx          | 7 ps                             | 57 Playstation                                           | 10 Sony Playstation                    |
| ps2          | 8 ps2                            | 58 Playstation 2                                         | 11 Sony Playstation 2                  |
| ps3          | 9 ps3                            | 59 Playstation 3                                         | 12 Sony Playstation 3                  |
| psp          | 38 psp                           | 61 PSP                                                   | 13 Sony Playstation Portable           |
| psvita       | 46 psvita                        | 62 PS Vita                                               | 39 Sony Playstation Vita               |
| xbox         | 11 xbox                          | 32 Xbox                                                  | 14 Microsoft Xbox                      |
| xbox360      | 12 xbox360                       | 33 Xbox 360                                              | 15 Microsoft Xbox 360                  |
| atari2600    | 59 atari2600                     | 26 Atari 2600                                            | 22 Atari 2600                          |
| atari5200    | 66 atari5200                     | 40 Atari 5200                                            | 26 Atari 5200                          |
| atari7800    | 60 atari7800                     | 41 Atari 7800                                            | 27 Atari 7800                          |
| atarilynx    | 61 lynx                          | 28 Lynx                                                  | 4924 Atari Lynx                        |
| atarijaguar  | 62 jaguar                        | 27 Jaguar                                                | 28 Atari Jaguar                        |
| neogeo       | 80 neogeoaes (79 = neogeomvs)    | 142 Neo-Geo (68 = Neo-Geo MVS, 70 = Neo-Geo CD)          | 24 Neo Geo (AES and MVS)               |
| ngp          | 119 neo-geo-pocket               | 25 Neo-Geo Pocket                                        | 4922 Neo Geo Pocket                    |
| ngpc         | 120 neo-geo-pocket-color         | 82 Neo-Geo Pocket Color                                  | 4923 Neo Geo Pocket Color              |
| pcengine     | 86 turbografx16--1 (150 = TG-CD) | 31 PC Engine (114 = PC Engine CD)                        | 34 TurboGrafx 16 (4955 = TG-CD)        |
| arcade       | 52 arcade                        | 75 Arcade                                                | 23 Arcade                              |
| mame         | 52 arcade                        | 75 Arcade (MAME)                                         | 23 Arcade                              |
| dos          | 13 dos                           | 135 PC Dos                                               | 1 PC (no DOS entry)                    |
| amiga        | 16 amiga                         | 64 Amiga                                                 | 4911 Amiga                             |
| c64          | 15 c64                           | 66 Commodore 64                                          | 40 Commodore 64                        |
| zxspectrum   | 26 zxs                           | 76 ZX Spectrum                                           | 4913 Sinclair ZX Spectrum              |
| pc           | 6 win                            | 138 PC Windows (ES-DE/Skyscraper map "pc" to 135 PC Dos) | 1 PC                                   |

---

## 10. Cross-source field matrix

| Need                    | Steam                                                         | IGDB                                               | SGDB                  | ScreenScraper                        | TGDB                               | GOG (gamesdb/products)                                   | Epic                                           | HLTB                                             |
| ----------------------- | ------------------------------------------------------------- | -------------------------------------------------- | --------------------- | ------------------------------------ | ---------------------------------- | -------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------ |
| title                   | `name`                                                        | `name`                                             | `name`                | `noms[region]`                       | `game_title`                       | `title["*"]` / `title`                                   | `title` / `productName`                        | `game_name`                                      |
| description             | `short_description`, `about_the_game` (HTML)                  | `summary`, `storyline`                             | -                     | `synopsis[langue]`                   | `overview`                         | `summary["*"]` / `description.full` (HTML)               | `description`, `about.description` (markdown)  | `profile_summary` (page)                         |
| release date            | `release_date.date` (string)                                  | `first_release_date` (unix), `release_dates`       | `release_date` (unix) | `dates[region]` (YYYY-MM-DD)         | `release_date`                     | `first_release_date` / `release_date` (ISO)              | `releaseDate` / `meta.releaseDate` (ISO)       | `release_world`                                  |
| developers / publishers | `developers[]`, `publishers[]`                                | `involved_companies`                               | -                     | `developpeur.text`, `editeur.text`   | `developers[]`, `publishers[]` ids | `developers[].name`, `publishers[].name`                 | `developerDisplayName`, `publisherDisplayName` | `profile_dev`, `profile_pub`                     |
| genres                  | `genres[].description`, `categories[]`                        | `genres.name`, `themes.name`, `game_modes.name`    | -                     | `genres[].noms[en]`, `modes`         | `genres[]` ids                     | `genres[].name["*"]`, `themes` / `tags`                  | `tags[groupName=genre]`, `meta.tags`           | `profile_genre`                                  |
| rating                  | `metacritic.score`, `ratings.*`, `required_age`               | `total_rating`, `aggregated_rating`, `age_ratings` | -                     | `note.text` (/20), `classifications` | `rating` (ESRB string)             | `aggregated_rating`, `esrbRating`/`pegiRating`           | `requirements.rating`                          | `review_score`                                   |
| cover (portrait)        | CDN `library_600x900_2x.jpg`                                  | `cover.image_id` @ `t_cover_big_2x`/`t_1080p`      | grids 600x900         | `box-2D`                             | `boxart front`                     | `vertical_cover` `_glx_vertical_cover` / `boxArtImage`   | `OfferImageTall`                               | `game_image`                                     |
| hero / background       | `library_hero.jpg`, `page_bg_generated_v6b.jpg`, `background` | `artworks`/`screenshots` @ `t_1080p`               | heroes 1920x620       | `fanart`, `mixrbv2`                  | `fanart`                           | `background` `_glx_bg_top_padding_7` / `backgroundImage` | `OfferImageWide`, `hero.backgroundImageUrl`    | -                                                |
| logo                    | `logo.png`                                                    | -                                                  | logos                 | `wheel-hd`                           | `clearlogo`                        | `logo` `_glx_logo_2x` / `_links.logo`                    | `hero.logoImage.src`                           | -                                                |
| icon                    | `steamcommunity/public/images/apps/{id}/{hash}.jpg`           | -                                                  | icons                 | -                                    | -                                  | `square_icon` `_glx_square_icon_v2` / `images.icon`      | -                                              | -                                                |
| screenshots             | `screenshots[].path_full`                                     | `screenshots` @ `t_screenshot_huge`/`t_1080p`      | -                     | `ss`, `sstitle`                      | `screenshot`, `titlescreen`        | `screenshots[].url_format` `_1600`                       | `GalleryImage`, `gallery.galleryImages`        | -                                                |
| playtime / completion   | `localconfig.vdf Playtime`, `GetOwnedGames playtime_forever`  | `game_time_to_beats`                               | -                     | -                                    | -                                  | -                                                        | - (library-service needs auth)                 | `comp_main`, `comp_plus`, `comp_100`, `comp_all` |
| players online          | `GetNumberOfCurrentPlayers`                                   | -                                                  | -                     | -                                    | -                                  | -                                                        | -                                              | `count_playing`                                  |

## 11. Caching and politeness summary

| Source             | Server cache hint       | Suggested client TTL                            | Concurrency / rate                                                   |
| ------------------ | ----------------------- | ----------------------------------------------- | -------------------------------------------------------------------- |
| Steam appdetails   | `max-age=3600`          | 24 h (metadata), re-fetch on user refresh       | <= 1 req/s, ~200 per 5 min (unofficial)                              |
| Steam CDN / icons  | long-lived              | forever on disk; revalidate monthly             | unlimited practically                                                |
| Steam Web API      | `max-age=134` (players) | players 2-5 min; schema 7 d; owned games 10 min | 100 000 calls/day per key                                            |
| IGDB               | none                    | 7-30 d; images forever                          | 4 req/s, 8 in flight                                                 |
| SteamGridDB        | none                    | 24 h lists; images forever                      | unknown; back off on 429                                             |
| ScreenScraper      | none                    | forever per ROM hash; media by crc/md5          | `maxthreads`, `maxrequestspermin`, `maxrequestsperday` from `ssuser` |
| TheGamesDB         | none                    | 30 d; tables (genres/devs/pubs) 30 d            | monthly allowance (`remaining_monthly_allowance`)                    |
| GOG products / v2  | `max-age=86400`         | 7 d                                             | low                                                                  |
| gamesdb.gog.com    | `max-age=540`           | 7 d                                             | low                                                                  |
| Epic GraphQL       | `max-age=120`           | 7 d                                             | low; needs browser UA                                                |
| Epic store-content | none                    | 7 d                                             | low                                                                  |
| HowLongToBeat      | none                    | 30 d                                            | <= 1 req/s, session-bound token                                      |

## 12. Licensing / attribution summary

- Steam: Web API Terms of Use (100 000 calls/day; display "Powered by Steam"-style Valve Brand & Links per the branding requirements; no marketing use). Store `appdetails` and CDN art are undocumented but universally used; artwork is publisher-owned.
- IGDB: free for non-commercial use under the Twitch Developer Service Agreement; commercial use needs a partnership; show "Data from IGDB.com".
- SteamGridDB: user-contributed art, author names available in responses; no attribution rule found (UNVERIFIED) - credit authors in the art picker.
- ScreenScraper: only free, distributed software may integrate without prior permission; credentials are per developer and per user; quotas are enforced via HTTP 429/430/431.
- TheGamesDB: API code GPLv3; monthly allowance; credit "TheGamesDB.net".
- GOG / Epic: internal store endpoints without published terms; use sparingly, cache, and fail soft.
- HowLongToBeat: no API, no terms; optional feature with link-back.

## 13. Local art caches (owned-but-not-installed games) - VERIFIED on this PC 2026-11-02, read-only

Measured without signing in anywhere, running the app or editing project files; the `LocalArtSource` registry of
`docs/ARCHITECTURE.md` §4.6 "Art pipeline" is built from these rules. Survey scripts (image sniffer, binary-VDF
parser, per-app census, Galaxy webcache and `galaxy-2.0.db` readers) are in the session scratchpad
`C:\Users\<user>\AppData\Local\Temp\<scratch>`
(`survey.js`, `census2.js`, `gog.js`, `gogdb.js`, `more.js`; `steam-not-installed-with-portrait.json` = the 5,190
not-installed Steam appids with a portrait cover, the reference input of the `--art-bench` probe).

### 13.1 What exists on this PC

| Cache                                                   | Present                              | Entries                                                              | Covers for NOT-installed games                    | Use                                                                                               |
| ------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Steam `appcache\librarycache`                           | yes                                  | 9,790 app folders, 35,028 files, 3.1 GB                              | 5,190 portrait (+4,313 header-only)               | primary local source; `assetcache.vdf` is the index                                               |
| GOG Galaxy `%ProgramData%\GOG.com\Galaxy\webcache`      | yes                                  | 4,395 entries over steam / epic / gog / origin / xboxone / battlenet | 4,385 vertical covers (webp 342x482)              | second local source: covers six stores, keyed by each store's own id                              |
| GOG Galaxy `storage\galaxy-2.0.db`                      | yes (SQLite + WAL, 214 MB)           | 4,616 `originalImages` rows                                          | 4,385 `images.gog.com` URLs                       | optional; the webcache folder is self-describing, so PlayOut does not open it (no native modules) |
| Epic `Data\Catalog\catcache.bin`                        | yes                                  | 2,159 catalog items, 939 base games                                  | 934 `cdn1.epicgames.com` `DieselGameBoxTall` URLs | direct-URL source with zero requests, keyed by catalogItemId / appName                            |
| Epic `Saved\webcache_4430`                              | yes                                  | Chromium blockfile cache                                             | none by id                                        | skip                                                                                              |
| Epic `.item` manifests                                  | missing (nothing installed)          | 0                                                                    | -                                                 | installed-only; not a source for owned games                                                      |
| EA app                                                  | partial (`SplashArtwork`, CEF cache) | 2 sha256-keyed hero + logo pairs                                     | none                                              | skip; Galaxy's `origin\<offerId>` is the only local EA cover source                               |
| Ubisoft Connect, Battle.net, ES-DE, Playnite, RetroArch | not installed                        | -                                                                    | -                                                 | sources designed, untestable here                                                                 |
| Xbox app `LocalCache\ImageCache`                        | yes                                  | 89 opaque-named 329x329 tiles                                        | none by id                                        | skip; keep the AppxManifest path for installed packages; Galaxy `xboxone\<id>` has 101 covers     |

Only drive C: exists. No `library_600x900_2x.jpg` exists anywhere in the Steam cache on this PC. PlayOut's own
`%APPDATA%\playout\media\` already holds 808 game folders.

### 13.2 Steam `librarycache`

Path: `<SteamPath>\appcache\librarycache\<appid>\...` (`HKCU\Software\Valve\Steam\SteamPath`). One flat file next
to the folders, `assetcache.vdf` (1.54 MB, binary KeyValues, mtime = the last time Steam ran), is the mapping file:

```
"" {                                  // root, empty key
  "cache_version" 2
  "last_cleanup_time" 1785353897
  "0" {                               // the only section seen
    "<appid>" {
      "0f" "library_600x900.jpg"                 // cover: also "library_capsule.jpg" or "<40hex>/library_600x900.jpg"
      "1f" "library_hero.jpg"                    // hero 1920x620
      "2f" "logo.png"                            // logo
      "3f" "header.jpg" | "library_header.jpg"   // header 460x215
      "4f" "<40hex>.jpg"                         // 32x32 icon
      "5f" "library_hero_blur.jpg"               // 192x62, skip
      "6f" "<40hex>/markers.svg"                 // rare (14), skip
      "7f" "<40hex>.jpg"                         // rare (139): square 600-2400 px art, skip
      "ma" 8  "v" 3  "change" <store changenumber>  "ct" <unix time cached>
    }
  }
}
```

Type bytes: `0x00` object, `0x01` string, `0x02` int32, `0x08` end. Values are paths relative to
`librarycache\<appid>\`; in the new layout they include the 40-hex sub-folder. Parsing takes 28 ms (10,856 appids;
9,790 list at least one file; 0 listed files were missing on disk). `existsSync` of every listed cover takes ~1.05 s
for 9,790 apps; a blind `readdir` walk of all folders ~1.7 s; header-sniffing every file would take ~60 s, so sniff
only the one file about to be copied.

Layouts found (3,833 folders flat-only, 1,287 hashed-sub-folder-only, 4,670 mixed):

- **Flat**: `<appid>\library_600x900.jpg`, `library_hero.jpg`, `library_hero_blur.jpg`, `logo.png`, `header.jpg` or
  `library_header.jpg`, `<40hex>.jpg` (the icon).
- **Hashed (2024/2025 clients)**: the 40-hex SHA-1 is a **sub-directory per asset version** and the file inside keeps
  its meaningful name: `<appid>\<40hex>\library_600x900.jpg` or `library_capsule.jpg`, `<40hex>\library_hero.jpg` +
  `library_hero_blur.jpg`, `<40hex>\logo.png`, `<40hex>\library_header.jpg` or `header.jpg`. The only hash-NAMED
  files are the top-level 32x32 icon (`4f`) and the rare `7f` square. No `common` sub-folder exists here. Several
  hash folders can coexist for one app; `assetcache.vdf` says which is current and "newest mtime sub-folder first"
  is the fallback.
- The pre-2024 flat `<appid>_library_600x900.jpg` naming (§5.4) is still supported as the last fallback; not present here.

Real dimensions (sniffed, all 35,028 files) - never trust the name:

| File                                | Format / size                                                            | Count | Kind                  |
| ----------------------------------- | ------------------------------------------------------------------------ | ----- | --------------------- |
| `library_600x900.jpg`               | jpg **300x450**                                                          | 4,202 | cover (small)         |
| `library_600x900.jpg`               | png 600x900 (a PNG stored under a `.jpg` name)                           | 444   | cover                 |
| `library_capsule.jpg`               | jpg 300x450                                                              | 582   | cover (small)         |
| `library_hero.jpg`                  | jpg 1920x620                                                             | 4,683 | hero                  |
| `library_hero.jpg`                  | jpg 1920x1080 / 1280x720 / 1024x768 / 640x480 (screenshot fallbacks)     | ~330  | hero only as fallback |
| `library_hero_blur.jpg`             | jpg 192x62                                                               | 4,688 | skip                  |
| `header.jpg` / `library_header.jpg` | jpg 460x215 (a few 460x210, 460x181, 920x430)                            | 9,511 | header, not a cover   |
| `logo.png`                          | png 640x360 with alpha (3,696), other 640xN with alpha, 94 without alpha | 4,502 | logo                  |
| `<40hex>.jpg` top level             | jpg 32x32                                                                | 5,548 | icon                  |
| `<40hex>.jpg` (`7f`)                | jpg 1000x1000 / 2400x2400 / 600x600                                      | 139   | skip                  |
| `markers.svg`                       | SVG                                                                      | 14    | skip                  |

Coverage: 5,229 apps have a portrait cover (5,190 not installed, 39 of the 40 installed), 4,314 header-only, 247
icon-only. Of the ~1,578 appids with local state in `userdata\<id>\config\localconfig.vdf`, 1,540 are not installed
and 1,221 (79 %) have a portrait cover, 1,253 a header, 1,069 a hero, 1,027 a logo. Covers are 45-90 KB, heroes
150-400 KB, headers 28-75 KB, logos 10-240 KB, icons 1-2 KB. `userdata\<id>\config\grid\` (custom art) is empty here;
`appcache\httpcache` and `steam\cached` hold nothing keyed by appid.

**Fast path** (`scrapers/local-art/steam-cache.ts`): parse `assetcache.vdf` once per run -> for each appid take
`0f` (cover), `1f` (hero), `2f` (logo), `4f` (icon); `existsSync` + sniff the chosen file; when the vdf is absent or
the listed file is missing, walk `<appid>\` and every `<appid>\<40hex>\` (newest mtime first) for
`library_600x900_2x.jpg`, `library_600x900.jpg`, `library_capsule.jpg` (cover), `library_hero.jpg` (hero),
`logo.png` (logo), top-level `<40hex>.jpg` 32x32 (icon). Header-only and absent apps go straight to the CDN
(`library_600x900_2x.jpg` -> `library_600x900.jpg`); the CDN `_2x` is also the later quality upgrade for the
300x450 local covers.

### 13.3 GOG Galaxy webcache (covers for six stores)

Path: `%ProgramData%\GOG.com\Galaxy\webcache\<galaxyUserId>\<platform>\<externalId>\<sha256>_glx_<kind>.webp`
(`galaxyUserId` = the one numeric folder; sibling `common\` and `<n>-overlay\` are Chromium profiles, skip).
`%LOCALAPPDATA%\GOG.com\Galaxy\webcache` does not exist here. Galaxy caches the games of the user's connected
libraries (owned, not installed), which is exactly the primary case, and keeps it current (mtimes up to the day of
the survey).

| platform dir | entries | with `vertical_cover` | key                                                   | examples                                                     |
| ------------ | ------- | --------------------- | ----------------------------------------------------- | ------------------------------------------------------------ |
| `steam`      | 2,823   | 2,816                 | Steam appid                                           | `440`, `1000030`                                             |
| `epic`       | 884     | 883                   | Epic appName (32-hex or codename)                     | `0006475a83f1...`, `Jasper` (Watch Dogs), `Albacore`         |
| `gog`        | 428     | 427                   | GOG productId                                         | `1207659039`                                                 |
| `origin`     | 150     | 150                   | EA / Origin offer id                                  | `OFB-EAST1000011`, `DR104624900`                             |
| `xboxone`    | 102     | 101                   | numeric Xbox id (Galaxy's `xboxone_<id>` release key) | `1015340672`                                                 |
| `battlenet`  | 8       | 8                     | Battle.net product code                               | `diablo3`, `heroes`, `odin`, `prometheus`, `s1`, `s2`, `wow` |

Three files per entry: `_glx_vertical_cover.webp` = webp 342x482 (ratio 0.71; ~30 with alpha) -> cover;
`_glx_bg_top_padding_7.webp` = webp 1600x650 (also 1600x620, 1280/1440/1528x650) -> hero;
`_glx_square_icon_v2.webp` = webp 112x112 -> icon. 4,395 entries, ~632 MB. For Steam it holds 14 covers that
Steam's own librarycache lacks; for Epic, EA, Xbox and Battle.net it is the only local cover source on this PC.

**Fast path** (`galaxy-cache.ts`): one `readdir` per platform folder gives `externalId -> folder`; kind by suffix,
confirmed by sniff. Id mapping: `steamAppId` -> `steam`, `gogProductId` -> `gog`, `epicAppName` -> `epic`,
`eaOfferId` -> `origin`, the numeric Xbox id -> `xboxone` (Galaxy's id, not the PFN; match through `extra.titleId`
/ `storeId` only when they are numeric and present as a folder), `battlenetCode` -> `battlenet`. Files are `.webp`:
`image-cache.ts` keeps the extension and the renderer shows them natively.

`galaxy-2.0.db` (`LibraryReleases.releaseKey` = `<platform>_<externalId>` owned lists: steam 2,864, epic 911, gog
467, origin 154, xboxone 132, battlenet 8; `GamePieces` with `GamePieceTypes.type = 'originalImages'` ->
`{"background","squareIcon","verticalCover"}` `images.gog.com/<sha256>_glx_<kind>.webp?namespace=gamesdb` URLs;
`WebCacheResources` maps them to the file names above) is documented for completeness only: reading it needs
SQLite, which PlayOut does not bundle, and the folder already carries everything the art pipeline needs.

### 13.4 Epic `catcache.bin` (direct URLs, no network)

`%ProgramData%\Epic\EpicGamesLauncher\Data\Catalog\catcache.bin` (3.3 MB) = base64 of a JSON array of catalog items
`{ id (catalogItemId), namespace, title, keyImages: [{ type, url, width, height, md5 }], categories: [{ path }],
releaseInfo: [{ appId (= appName), platform }], customAttributes }`. 2,159 items, 853 namespaces, 939 base games
(`categories[].path == 'games'` and not `addons`), **934 with `DieselGameBoxTall`** (portrait, e.g. 1200x1600 on
`cdn1.epicgames.com`), 1,053 `DieselGameBox` (1920x1080), 47 `DieselGameBoxLogo`, 7 `OfferImageTall` / `OfferImageWide`.
Index by `id` and `releaseInfo[].appId`; cover = `DieselGameBoxTall` (fallback `OfferImageTall`) + `?w=600&h=900&resize=1`
(675x900, 130 KB), hero = `DieselGameBox`, logo = `DieselGameBoxLogo`. The owned import receives the same `keyImages`
live; the file is the offline copy for games imported earlier. Epic's `webcache_4430` is a Chromium blockfile cache
(URL-keyed) and is not read.

### 13.5 EA, Ubisoft, Battle.net, Xbox, ES-DE, Playnite

- EA app: `%LOCALAPPDATA%\Electronic Arts\EA Desktop\SplashArtwork\<sha256>-hero.jpg` (1536x864) + `<sha256>-logo.png`
  (800x888, no alpha) for launched games only, keyed by opaque hashes with `<sha256>.alias` files; `IGOCache`,
  `CEF\...\Cache_Data` (URL-keyed) and `%ProgramData%\EA Desktop\<hash>\{CATS2,IS,NS}` are opaque. No cover source.
- Ubisoft Connect, Battle.net, ES-DE, Playnite, RetroArch: not installed on this PC (no registry keys, no folders).
  `esde-media.ts` reads `<ES-DE home>\downloaded_media\<system>\{covers,marquees,screenshots,fanart}\<romname>.{png,jpg}`
  and the gamelist's `<image>` / `<thumbnail>`; `playnite-files.ts` reads `%APPDATA%\Playnite\library\files\<gameId>\`
  with `library\games\*.json` for the store id; both stay untested here.
- Xbox: the two installed packages (Xbox 360 back-compat wrappers) carry `Logo.png`, `SmallLogo.png`, `StoreLogo.png`,
  `background_launcher.png` through the existing AppxManifest path; the Xbox app's `LocalCache\ImageCache` (89 files,
  opaque 64-bit names, 329x329 tiles) is not keyed by id and is skipped.

### 13.6 Recognition rules (`scrapers/image-sniff.ts`)

Read the first 64 KiB and sniff: JPEG (SOF0/SOF2 for dimensions), PNG (IHDR; colour type 4 / 6 = alpha), WebP
(VP8 / VP8L / VP8X; VP8X flag bit 0x10 = alpha), ICO, GIF. Classify by ratio, never by exact pixels or file name:

| Kind   | Accept                                                                                                                                                                      | Reject / demote                                                                                                                |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| cover  | `w/h` in 0.60-0.75 and `h >= 400` (Steam 300x450 / 600x900 = 0.667, Galaxy 342x482 = 0.71, Epic Tall 1200x1600 = 0.75); `h < 600` is recorded as `small` and upgraded later | anything landscape; a 460x215 header is never a cover                                                                          |
| hero   | `w >= 1200` and `w/h >= 2.4` (1920x620 = 3.1, 1600x650 = 2.46, 1600x620 = 2.58)                                                                                             | 16:9 screenshots (1920x1080, 1280x720) only as fallback hero; 192x62 blur skipped                                              |
| header | `w/h` ~ 2.14 (460x215, 920x430, 460x210)                                                                                                                                    | not stored as any `MediaKind`                                                                                                  |
| logo   | PNG / WebP with alpha at `w >= 128`, `h >= 32`, any shape (640x360 typical; 360x360, 354x140, 167x360 occur); opaque `logo.png` at `w >= 400`, `h <= w`                     | 76 of the 4,687 indexed Steam logos are narrower than 400 and are genuine logos; the square 1000x1000 jpg (`7f`) is not a logo |
| icon   | `w == h <= 256` (Steam 32x32 jpg, Galaxy 112x112 webp)                                                                                                                      | 329x329 Xbox tiles                                                                                                             |

### 13.7 Direct sources verified alongside (no search, no key unless stated)

- Steam CDN `https://cdn.cloudflare.steamstatic.com/steam/apps/<appid>/library_600x900_2x.jpg` (600x900) exists for
  37 of 40 mixed appids (92.5 %); unreleased / delisted apps keep only `header.jpg`. No rate limit observed (40 parallel
  GETs in 637 ms; ~145 ms per sequential GET). Same bytes on `cdn.akamai.steamstatic.com` and
  `steamcdn-a.akamaihd.net`; `shared.cloudflare.steamstatic.com/store_item_assets/...` 301s to `shared.steamstatic.com`.
- GOG: `api.gog.com/products/<id>?expand=images` has **no** vertical cover (only wide `logo`/`logo2x` tiles); the
  id-derived cover is `images.gog-statics.com/<hash>_glx_vertical_cover.{jpg,png,webp}` (342x482; no `_2x`
  formatter exists, `_glx_vertical_cover_2x` and friends answer 400), `_1600` for the hero, `_glx_square_icon_v2` for
  the icon; `api.gog.com/v2/games/<id>` `boxArtImage` is 171x241 (last resort). `gamesdb.gog.com/platforms/<p>/external_releases/<id>`
  resolves `gog`, `steam`, `origin` and `uplay` ids (200 with a `vertical_cover.url_format`); `epic`, `xboxone`,
  `battlenet` -> 404.
- SteamGridDB (OpenAPI, no calls made): `GET /grids/{steam,egs,origin,bnet,uplay}/<id,id,...>?dimensions=600x900&types=static`
  returns the top voted grid per game in one request (207 on partial errors; batch size unstated, start with 50);
  `/heroes`, `/logos`, `/icons` likewise. Rate limit not stated anywhere; keep the self-imposed 3 req/s.
- IGDB: `images.igdb.com/igdb/image/upload/t_cover_big_2x/<image_id>.jpg` (528x704) needs no auth; the `image_id`
  comes from `fields cover.image_id; where external_games.uid = (...) & external_games.external_game_source = 1; limit 500;`.
- Xbox: `displaycatalog.mp.microsoft.com/v7.0/products?bigIds=<id,...>&market=US&languages=en-US` (anonymous) lists
  `Images[ImagePurpose = Poster | BoxArt | BrandedKeyArt | SuperHeroArt | Logo]` on `store-images.s-microsoft.com`,
  which resizes server-side (`?w=600&h=900&mode=scale&q=90` -> 600x900 jpg, 140 KB instead of a 617 KB poster).
- EA: the owned import carries no image fields and the Origin supercat endpoints are gone; SteamGridDB `origin` and
  `gamesdb.gog.com/platforms/origin` by `eaOfferId` are the search-free routes. Battle.net: 4 of the 14 cover URLs in
  `resources/systems/battlenet-products.json` still answer (the `Product_Vert-700x850.jpg` form), 10 are 503 - refresh
  the table rather than build a source.
