# GameDash "Winhanced" look — visual + interaction specification (UI contract)

Date: 2026-10-29. Author: research agent (task `winhanced-design`). All pixel values are for a 1920x1080 reference canvas unless stated. "Measured" = sampled from the two reference screenshots with a pixel script (`scratchpad/scripts/img.js`, sharp 0.35.5); "design choice" = not visible in the screenshots, chosen to match the Xbox Series dashboard conventions; "UNVERIFIED" = could not be checked against a primary source.

## 0. Summary of what matters

- Winhanced is a closed-source, free, Patreon-funded Windows 11 launcher ("Living Glass" UI). We **imitate the look only**; we reuse none of its assets, styles or code (section 1).
- The look = full-bleed hero art + dark left/bottom gradients, a translucent "glass" system pill top-right, a bold 32px row heading, 2:3 cover cards (240x360) with 16px corners and a 36px round store badge, focused card scaled 1.10 about its bottom-centre, 4px accent ring for gamepad/keyboard focus, and a dark `#1f1f1f` / `#2d2d2d` surface system identical to WinUI 3 dark theme (sections 2–3).
- Tokens scale with viewport height via `--u: calc(100vh / 1080)` (section 4). Typeface: Segoe UI Variable (Display/Text optical sizes), weights 400/600/700, fallbacks Segoe UI → Selawik → system-ui (section 5).
- Interaction model follows Microsoft's Xbox/TV guidance and the W3C Gamepad "standard" mapping (section 6). Icons: lucide-react 1.64.0 names + simple-icons 16.36.0 slugs, every name verified against the installed packages (section 7).

## 1. What Winhanced is (verified 2026-10-29)

| Fact | Value | Source |
| --- | --- | --- |
| Product | "Winhanced" — "Everything you need to discover, manage, install, and play." Controller-first home/launcher for Windows 11 handhelds, desktops and TV PCs; can register as the Windows "Full Screen Experience"/Xbox-mode home app. | https://www.winhanced.com/ , https://www.winhanced.com/faq/ |
| Maker | "built by a small team … **Floop** (design and product) and the community"; FAQ: "a two-person team funded through Patreon". Footer "© 2026 Winhanced™". No legal entity named. | https://www.winhanced.com/about/ , /faq/ , /terms/ |
| Distribution | Official site https://www.winhanced.com (download page https://www.winhanced.com/support/ → installer `https://ota.winhanced.com/lg/Winhanced-Installer-0.9.9.96.exe`, "Build 0.9.9.96, Released October 18, 2026"). Patreon https://patreon.com/Winhanced (Early Access switch inside the app, features ~30 days early). Discord https://discord.gg/6qYQmDyU7N. 1.0 Beta announced for 2026-10-31 ("free download for Windows 11"). | /support/ , /news/winhanced-1-0-beta/ |
| Price | "Winhanced is free. One installer, no trial, and no account needed to use it." | /faq/ |
| Open source? | **No.** FAQ: "Not yet. It's a two-person team funded through Patreon." Not on GitHub (the GitHub project "Winhance" by memstechtips is an unrelated debloater). | /faq/ ; WebSearch |
| Licence/terms | Terms (last updated 2026-08-28): "We grant you a personal, non exclusive, revocable licence to install and use it on devices you own or control." / "You may not resell Winhanced, redistribute modified builds, or remove or bypass licensing and entitlement checks." Third-party marks "belong to them". No clause grants any right to copy UI, artwork or styles. | https://www.winhanced.com/terms/ |
| Tech stack | FAQ: ".NET 8 and the Windows App SDK are bundled with the installer" → WinUI 3 app (explains the WinUI dark-theme colours measured below). Requires Windows 11 build 22000+, x64 only; Xbox mode needs 24H2+. | /faq/ |
| Stores | FAQ: "Storefronts: Steam, Xbox and Game Pass, Epic Games, GOG, PlayStation, EA, Ubisoft, Battle.net, and Amazon Games." EA/Ubisoft/Battle.net/Amazon = installed-on-disk detection only (same as GameDash v1). Cloud: Xbox Cloud Gaming, GeForce NOW, PS Remote Play, Moonlight. | /faq/ |
| Home / library | Site: "Three controller-friendly layouts", "recent games always within easy reach", sections "Your home" / "Your library"; library merges all stores with sorting/filtering; game page "Game Options" lets you change box art, hero art, or logo. Living Glass (2025-05-24): "designed to scale beautifully across different screen sizes and devices", "built controller-first while remaining fully accessible via touchscreen and keyboard", HowLongToBeat playtime estimates on each game. | / , /faq/ , /news/living-glass-public-launch/ |
| Game detail | Press (Windows Central via Yahoo): library page shows "game details, total playtime, achievement progress, completion estimates, and unified launcher controls"; achievements for Steam/Xbox/PlayStation/GOG. | https://tech.yahoo.com/gaming/articles/winhanced-keeps-proving-proper-pc-103513786.html |
| System bar | Not documented anywhere; only visible in the screenshots (search, volume, Bluetooth, Wi-Fi, battery %, power, clock). | screenshots |
| Settings | FAQ names sections Integrations, Libraries (Hidden Games, ROM Libraries), Performance (Enhanced sleep/wake, "Remap hardware key to Gamebar/HUD"), Controllers, Updates & Support ("Report an issue"). v0.9 "Redesigned the settings pages within the app to better work with controllers, and provide information about what each setting does." | /faq/ ; Patreon v0.9 post (via WebSearch) |
| HUD/overlay | Xbox Game Bar widget (TDP, power profiles, fan, display, performance overlay, Lossless Scaling). 1.0: own overlay opened with the Guide button; "B returns the player to the game"; "Guide and Start + Select work on any Windows PC with an Xbox controller". | /faq/ , /news/winhanced-1-0-beta/ |
| Controller navigation (documented) | FAQ: "A always selects." "B always goes back to wherever you just were." The stick and d-pad move focus through the current layer. Keyboard and mouse work throughout. Xbox, DualSense and most third-party pads supported. Mouse mode: "activate it by double pressing the right thumbstick", "RB acts as your left click", "RT acts as your Right Click", double-press again to exit (PC Guide quoting the dev's Discord). Guide/Xbox button opens Game Bar on handhelds (Win+G on keyboard). | /faq/ ; https://www.pcguide.com/news/alternative-to-xbox-fullscreen-experience-for-handhelds-gets-three-updates-in-three-days-adds-new-mouse-mode/ |
| Touch | Only the Living Glass post's "fully accessible via touchscreen and keyboard"; no gesture documentation exists. Touch behaviour in section 6 is therefore our design. | /news/living-glass-public-launch/ |
| Version in screenshots | Home: "v0.9.9.9_experimental_v3"; detail: "…9.96" (= 0.9.9.96). | screenshots |

**Decision:** nothing from Winhanced may be reused (closed source, restrictive terms, trademark "Winhanced™"). GameDash imitates the layout, proportions and interaction feel described here with its own code, lucide/simple-icons glyphs, and the Windows system fonts. Do not use the name "Winhanced" or "Living Glass" in the product; "Winhanced" is only the internal theme name in this document.

## 1.1 Reference screenshots and calibration

- `images/1.webp` = home screen, 1917x1078 px. Treated as a 1:1 capture of a 1920x1080 screen (bottom/right 2–3 px cropped). Coordinates below are raw image coordinates = canvas coordinates (±3 px).
- `images/2.webp` = game detail panel, 1771x1102 px. It is NOT a crop of a 1080-tall screen: the system pill and its icons sit at the same scale and the same y as in 1.webp (search glyph 25x26 px in both; pill 74 px tall in both), the crop starts at canvas x = +58, y = +3, and the modal's top margin (121 px) only matches its bottom margin if the screen is 1920x1200 (16:10 handheld scaling). So: `canvas = (x + 58, y + 3)` on a 1920x1200 canvas. The task text's "1920x1080" description is therefore wrong for this image; measurements are converted to our 1080 canvas by keeping component sizes and anchoring the modal with equal margins (section 3).
- Both captures are 1:1 (no DPI scaling artefacts): 1 px glyph strokes are crisp.
- Method: `node scratchpad/scripts/img.js <cmd> <image> …` with commands `bbox`, `rows`, `cols`, `vedges`, `hedges`, `scan`, `sample`, `colorof`, `crop` (gridded zoom PNGs in `scratchpad/research/crops/`). Note for anyone re-running it: libvips cannot open >260-char Windows paths; the script reads via Node `fs`, or pass `cygpath -d` short paths.

## 2. Home screen — component inventory (1920x1080 canvas, measured from 1.webp)

Layer order, back to front: hero art → gradients → page content (version label, logo, meta, quick actions, row headers, card rows, chevron) → system pill (fixed) → detail modal (section 3).

### 2.1 Background and hero

| Item | Spec | Evidence |
| --- | --- | --- |
| App background | `#1f1f1f` opaque. Shown wherever no hero art is drawn (visible in 2.webp around the modal: samples `#1f1f1f` at (20,700), (900,60), (600,20)). | measured |
| Hero art | Full-bleed `<img>` 1920x1080, `object-fit: cover; object-position: 100% 50%` (subject on the right). Source = featured game's hero (SteamGridDB *hero* 1920x620/3840x1240 letterboxed with blur-up, or a 16:9 screenshot). Featured game = the focused card's game (1.webp: card 1 = Dawnwalker = hero). Crossfade 400 ms when focus changes, debounced 150 ms (design). | measured + design |
| Left gradient | `linear-gradient(90deg, rgba(0,0,0,.80) 0%, rgba(0,0,0,.62) 22%, rgba(0,0,0,.35) 45%, rgba(0,0,0,.08) 65%, rgba(0,0,0,0) 80%)`. Column x=30 is uniformly `#3b0308` (lum 15) for y=0..850 while the art's own red at x=700 is lum 40–47 and the sun at x=1300 is lum 138. | measured row y=250/450 scans |
| Bottom gradient | `linear-gradient(0deg, rgba(0,0,0,.85) 0%, rgba(0,0,0,.55) 12%, rgba(0,0,0,.15) 30%, rgba(0,0,0,0) 45%)`. Bottom row y=1072 samples: `#21050c` (x=0), `#4b100f` (x=600), `#0d050a` (x=1800). | measured |
| Scrolled state | When the page scrolls, the hero layer stays fixed and fades: `opacity = 1 − clamp(scrollTop / 400, 0, 1)` into `#1f1f1f`; the logo/meta block scrolls with content; the pill stays fixed. (2.webp, scrolled: background flat `#1f1f1f`, "Recent Games" header cap-top at canvas y=154.) | measured + design |

### 2.2 Text block (top left)

| Item | Box (canvas px) | Type | Colour | Evidence |
| --- | --- | --- | --- | --- |
| Version label `v0.9.9.9_experimental_v3` | ink x=18..223, y=24..40; text box left 18, top 22 | 18 px / 600, letter-spacing 0 | `rgba(255,255,255,.45)` (ink mode `#996667` over `#3b0308`) | measured |
| Game logo (SteamGridDB *logo* PNG) | ink x≈74..366, y≈70..262 (bbox lum>70: 79..356 × 79..226); box: left 74, top 66, max 420x200, `object-fit: contain; object-position: left top` | — | — | measured |
| Meta line `Played 19.6 hours · RPG · 2026 · Steam` | cap-top y=307, x-height 312..323, baseline 323, descender 328; ink x=74..481 (408 px); line box top 300, height 32 | 24 px / 400 (x-height 12 px = 0.5 em ⇒ 24 px) | `rgba(255,255,255,.90)` | measured |
| Separator | ` · ` U+00B7, 2 px dot, 14 px space either side (gaps 16–18 px measured) | 24 px / 400 | `rgba(255,255,255,.55)` | measured |
| Logo fallback | title text 48 px / 700 white, max 2 lines | — | — | design |

### 2.3 System pill (fixed, top right)

| Item | Spec | Evidence |
| --- | --- | --- |
| Box | x=1319..1881, y=42..115 ⇒ **562 x 74**, `border-radius: 37px` (full pill). Margins: top 42, right 38. | measured (edge detection: top line y=42, bottom y=115, ends x=1319/1881) |
| Material | `backdrop-filter: blur(40px) saturate(1.2)` + `background: rgba(0,0,0,.22)` + `border: 1px solid rgba(255,255,255,.28)`. Interior luminance is 0.77–0.80 × the surrounding art where the backdrop is uniform (x=1340: 95 vs 122/126), and the interior varies only 61–95 while the backdrop varies 16–126 ⇒ heavy blur + ~22 % black tint. Border pixel `#cfa16a` between exterior `#bb7f34` and interior `#6b3b12`. In 2.webp (over flat `#1f1f1f`) the interior reads `#665b48` because the blur pulls in the modal art below. | measured |
| Layout (left→right, all vertically centred at y≈79) | padding-left 24 · **Search** 28 px icon (ink 25x26 at 1344..1368 × 67..92) · 28 · divider · 28 · **Volume** 24 px (ink ≈24x16, centre x≈1439) · 36 · **Bluetooth** 24 px (ink 9x17, centre 1499) · 34 · **Wi-Fi** 24 px (ink 15x18, 1550..1564 × 74..91) · 28 · divider · 40 · **Battery** 32 px icon (ink 31x14 at 1641..1671 × 73..86) · 16 · `85%` 20 px/400 (ink 1687..1722, cap 14) · 20 · **Power** 24 px (ink ≈20x20, centre 1752) · 36 · `7:31 AM` 20 px/400 (ink 1798..1864, cap 14) · padding-right 18 | measured |
| Dividers | 1 px wide, 36 px tall (y=61..97), `rgba(255,255,255,.30)`, at x=1398 and x=1597 | measured |
| Foreground | icons and text `rgba(255,255,255,.92)` (ink brightest `#e5d0a5`/`#ded0c3` over orange; battery fill `#fdf3e6`); stroke width 1.75–2 px | measured |
| Hit targets | each item is a 44x44 focusable control; focused/hovered item gets a 44 px round highlight `rgba(255,255,255,.14)` behind the glyph (design) | design |
| Clock | `Intl.DateTimeFormat(undefined, {hour:'numeric', minute:'2-digit'})` → "7:31 AM" / "07:31" per locale; updates every 10 s | design |

### 2.4 Row header

| Item | Spec | Evidence |
| --- | --- | --- |
| `Recent Games` | cap-top y=504, baseline y=525 (cap height 22 ⇒ **32 px**), weight **700** (R stem 5 px = 0.156 em; bold in zoom), colour `#ffffff`; text origin x=88 (R ink at 90). Line box top 496, line-height 44. Header → card top = 74 px (504→578). | measured |
| Library row header (design) | same type; left: 24 px platform glyph (section 7) + 12 px gap + platform name; right of name: count `12 games` 20 px/400 `rgba(255,255,255,.6)` with 16 px gap, baseline-aligned | design |

### 2.5 Card row (Recent Games and every library row)

| Item | Spec | Evidence |
| --- | --- | --- |
| Card (natural) | **240 x 360** (2:3), `border-radius: 16px`, `overflow: hidden`, image `object-fit: cover`, placeholder fill `#2d2d2d`. Unfocused cards measured: tops 579–581, bottoms 937–939, lefts 358/629/900/1170/1441/1711 ⇒ width 240, pitch 270.6. | measured |
| Gap / inset | gap **30 px**; row left inset **88 px** (= header x); the row bleeds under the right screen edge (7th card starts at 1711 and is clipped) — no right inset. | measured |
| Row geometry | row content box: x=88→∞, y=578..938. Cards are bottom-aligned in a 396 px tall track (578−36=542..938) so the scaled card never clips. | measured + design |
| Focused card | 264 x 396 at x=76..339, y=544..940 = **scale 1.10**, bottom edge and horizontal centre unchanged ⇒ `transform: scale(1.10); transform-origin: 50% 100%`. Neighbours do not move. | measured |
| Focus ring | **4 px** solid accent, outside the scaled box, 0 offset, radius follows (outer 20 px). Colour measured `#0373c4` (mode `#176eb1` is anti-aliased edge) ⇒ use `var(--accent)` = `#0078d4`. Present in 2.webp (gamepad/keyboard focus), absent in 1.webp (hover) ⇒ render only in `:focus-visible` / input-mode ≠ mouse. | measured |
| Shadow | faint dark band under the focused card (y=937..939 lum 17–30 vs 15) ⇒ `box-shadow: 0 16px 40px rgba(0,0,0,.45)` on focus | measured (weak) + design |
| Store badge | **36 px** circle, centre = (card.right − 30, card.bottom − 30) ⇒ 12 px inset; fill `#1b4e7a` (Steam; measured `#1a4e7a`–`#1d4f79`), glyph white 22 px centred; scales with the card (39–40 px on the focused one). Non-Steam: store colour + simple-icons glyph (section 7). | measured |
| No caption | cards carry no title text (Xbox style); the hero/meta identifies the focused game. Library rows may use the same card; store/discover-style rows in Winhanced use landscape cards with 2 caption lines (2.webp bottom-left: white card top y≈781, captions at ≈935/965) — out of scope for GameDash v1. | measured |
| Row scroll anchor | when a row receives focus the page scrolls so the row header line box top = **150 px** (2.webp: header cap-top 154 under the fixed pill); the Recent row on the un-scrolled home stays at 496. | measured + design |
| Vertical rhythm (design) | row block = header line box 44 + 38 gap + card track 396 = 478 px; inter-row gap 48 px ⇒ row pitch 526 px. | design |

### 2.6 Scroll hint

| Item | Spec | Evidence |
| --- | --- | --- |
| Chevron | lucide `ChevronDown`, **36 px**, stroke 2, centred at (960, 1055) (ink 18x10 at x=951..968, y=1050..1059), colour `rgba(255,255,255,.60)` (ink `#d4a9aa` over `#3b0308`). Visible only while `scrollTop < 40`; optional 1.6 s ease-in-out bob of 6 px. | measured + design |

### 2.7 Quick actions above the Recent row (GameDash addition — design)

Two glass pills at x=88, y=424 (bottom at 480, 16 px above the header line box), height 56, radius 28, same material as the system pill, padding 0 24 px, 24 px icon + 12 px gap + label 22 px/600 white: **[Settings]** (`Settings` icon) and **[Exit]** (`Power` icon; opens the power menu: Sleep · Restart · Shut down · Exit to desktop). Gap between pills 16 px. They form focus row 1 (section 6.2). They do not exist in Winhanced's screenshot; the empty band y=340..490 there is where they sit.

## 3. Game detail panel — component inventory (measured from 2.webp; canvas = image + (58, 3) on 1920x1200)

Modal-relative coordinates below use the modal's own top-left as origin (image (59,118)). Because 2.webp is a 16:10 capture, vertical placement is specified from the modal's top edge for the header items and from the modal's bottom edge for everything else, so it reproduces identically on 1080p.

### 3.1 Container

| Item | Spec | Evidence |
| --- | --- | --- |
| Modal box | image x=59..1738, y=118..1079 ⇒ **1680 x 962** at canvas (117..1797, 121..1083): side margins 120, top/bottom margins 120 on the 1200-tall canvas. Spec: `width: min(1680u, 100vw − 240u)`, `height: min(960u, 100vh − 120u)`, centred (⇒ 1680x960 with 60 px top/bottom at 1080p). | measured |
| Corners | `border-radius: 24px` (45° boundary at 5.5–7 px from the corner ⇒ r ≈ 20–24; zoom shows ≈22). No border; edges are crisp 1 px transitions. | measured |
| Background | hero art `object-fit: cover; object-position: 100% 50%` + left gradient `linear-gradient(90deg, rgba(31,31,31,.94) 0%, rgba(31,31,31,.88) 32%, rgba(31,31,31,.45) 55%, rgba(31,31,31,.08) 72%, rgba(31,31,31,0) 85%)` + bottom gradient `linear-gradient(0deg, rgba(31,31,31,.90) 0%, rgba(31,31,31,.60) 18%, rgba(31,31,31,0) 40%)`. Row y=500 (image): lum 30–38 for x=70..670, 77 at 870, 98 at 1070, 185 at 1270, 229 at 1370; strip under the action bar reads `#2d1c14` (lum 31). | measured |
| Shadow | `0 24px 80px rgba(0,0,0,.6)` (design; not measurable against the flat `#1f1f1f`). | design |
| Page behind | hero layer fades to `#1f1f1f` (250 ms); rows, headers and the focused card's ring stay at full brightness (measured: header `#ffffff`, card art unchanged, ring `#0373c4`). No scrim. | measured |
| Open/close motion | open: opacity 0→1 + scale .96→1, 250 ms `cubic-bezier(0,0,0,1)`; close: opacity 1→0 + scale 1→.98, 167 ms `cubic-bezier(1,0,1,1)` (Fluent "Direct Entrance"/"Gentle Exit"). | design (Fluent values) |

### 3.2 Header (anchored to the modal top)

| Item | Modal-relative box | Type / material | Evidence |
| --- | --- | --- | --- |
| Logo | ink x=61..228, y=51..139 (168x89); box: left **60**, top **48**, max **360x120**, `object-fit: contain; object-position: left top` | SteamGridDB *logo* PNG; fallback title 40 px/700 | measured |
| Store pill `Steam` | x=1402..1548 (147 x 50), y=53..103 ⇒ top **52**, height **50**, radius 25; padding 0 **28** left / 26 right; 24 px store glyph (coloured Steam disc 24 px) + **12** gap + text | text 18 px/400 (cap 13) `rgba(255,255,255,.80)`; background `rgba(31,31,31,.92)` (reads `#1e2020` over bright cyan art) + border 1 px `rgba(255,255,255,.08)` | measured |
| Close button | circle **50**, x=1567..1618, top 52 ⇒ right inset **62** (spec 60); gap to pill **20** | lucide `X` 20 px (ink 12x12), stroke 2, `rgba(255,255,255,.80)`; background `rgba(31,31,31,.92)`, border 1 px `rgba(255,255,255,.08)` | measured |

### 3.3 Lower text block (anchored to the action bar; left inset **72**)

Stack from the bottom up: action bar → **18** → meta line (line box 33) → **10** → description (5 × 33 = 165) → **24** → chips (44). Measured image rows: chips 612..656, description glyph rows 685..705 / 718..738 / 751..771 / 784..804 / 817..832 (pitch 33), meta 860..876, bar top 906.

| Item | Spec | Evidence |
| --- | --- | --- |
| Chip `Action` | height **44**, radius 22, padding 0 **24**, background `rgba(31,31,31,.90)`, border 1 px `rgba(255,255,255,.08)`; text 18 px/400 (cap 13) `rgba(255,255,255,.80)`; box x=73..170 (98 wide) | measured |
| Chip `37 playing now` | same; 20 px Steam glyph (ink 17x14) + **20** gap + text; width 204; chip gap **16** (18 measured). Value = Steam `ISteamUserStats/GetNumberOfCurrentPlayers`; hide the chip when unknown. | measured |
| Description | 22 px/400, line-height **33** (1.5), `rgba(255,255,255,.80)`, max-width **720** (ink 706), `-webkit-line-clamp: 5` with ellipsis; first line glyph-top = chips bottom + 29 | measured |
| Meta line | `Released ` 22 px/400 `rgba(255,255,255,.55)` + date 22 px/**600** `rgba(255,255,255,.80)` · developer · publisher (22 px/400 `.55`); gaps **40** (44 measured). Date via `Intl.DateTimeFormat(locale,{dateStyle:'short'})` ⇒ `7/28/2020` in en-US. | measured |

### 3.4 Action bar (anchored to the modal bottom)

| Item | Spec | Evidence |
| --- | --- | --- |
| Bar | inset **38** from the modal's left, right and bottom ⇒ 1604 x **134** (measured x=96..1702, y=906..1040 ⇒ 1606x134); radius **20**; background `#1f1f1f` opaque; border 1 px `rgba(255,255,255,.06)` (top edge pixel `#50524a` lighter than the fill); padding 0 **34**; children vertically centred. | measured |
| Play split button | **225 x 76** (x=130..354, y=936..1012 image) at bar-left + 34; radius **10**; background `#2d2d2d`; border 1 px `rgba(255,255,255,.07)` (edge pixels `#3a3a3a`/`#343434`); main part 170 wide with `Play` 26 px/**600** `#ffffff` centred (ink 45 wide, 25 tall); 1 px divider `#3d3d3d` at +171; chevron part **52** wide with lucide `ChevronDown` 20 px (ink 11x7) `rgba(255,255,255,.70)`. Chevron part opens the launch menu (Play · Play with… (launcher/emulator choice) · Open install folder · Uninstall/Hide). | measured + design |
| Stat group | label 18 px/400 **uppercase**, `letter-spacing: .08em` (≈1.5 px), colour `#7e7e7e` = `rgba(255,255,255,.42)`, cap-top at bar-top + **39**; value **32 px/600** (cap 22) `rgba(255,255,255,.85)` (mode `#cbcecd`), cap-top at bar-top + **73**; label baseline → value cap-top gap 20. Groups: `TOTAL PLAY TIME / 9.4 Hours`, `ACHIEVEMENTS / 25/40`, divider, `MAIN STORY / 7.6 hrs`, `MAIN + EXTRAS / 10.4 hrs`, `COMPLETIONIST / 14.6 hrs` (HowLongToBeat "Main Story", "Main + Extra", "Completionist"). Group gap **40** (Play button → first label 41; label ends → next label 40). | measured |
| Achievements chevron | lucide `ChevronDown` **28 px** (ink 14x7), `rgba(255,255,255,.35)` (`#707070`), 18 px after the label's right edge, vertically centred in the bar; the whole group is one focusable control that opens the achievements list (section 6.8). | measured |
| Divider | 1 px x **52** (y=947..998), `rgba(255,255,255,.20)` (`#535353`), 40 px after the chevron and 40 px before `MAIN STORY`. | measured |
| Icon buttons | three **52 x 52**, radius **12**, background `#2d2d2d`, border 1 px `rgba(255,255,255,.07)`, gap **24**, right inset 37 (bar padding 34 + 3); icons 24 px white: `Settings` (game options: artwork, launch args, emulator), `Gauge` (performance profile), `Star` (favourite; filled `fill="currentColor"` when on). Measured x=1461..1513, 1537..1589, 1611..1665; y=947..1000. | measured |
| Responsive rule | stats area is `flex:1; min-width:0; gap:40u`; when the bar is narrower than 1500u hide `COMPLETIONIST`, below 1300u also hide `MAIN + EXTRAS`, below 1100u hide the divider and all HLTB groups (handheld 1280x800 ⇒ canvas width 1728u ⇒ modal 1488u ⇒ bar 1412u). | design |

### 3.5 Hover/press/focus states for modal controls (design)

- Hover: `background` `#2d2d2d`→`#333333` (play/icon buttons), pills `rgba(31,31,31,.92)`→`rgba(45,45,45,.92)`.
- Pressed: `#272727`, scale .98, 83 ms.
- Gamepad/keyboard focus: 4u accent ring (`outline`) + 2u offset for controls ≤ 76u tall, same ring 0 offset on the card; ring colour `var(--accent)`; plus scale 1.04 for buttons (not for the card, which uses 1.10).
- Disabled: text `rgba(255,255,255,.36)`, background `#262626`.

## 4. Design tokens (CSS custom properties — paste verbatim into `src/renderer/styles/tokens.css`)

Scaling rule: every length is `N * var(--u)` where `--u` is one 1080p canvas pixel derived from the viewport **height**, so 1280x800 handhelds (u = 0.74 px), 1920x1080 (u = 1 px) and 4K TVs (u = 2 px) keep identical proportions; wider aspect ratios simply show more cards per row. `--u` is clamped so text never drops below the Windows legibility floor (12 px regular / 14 px semibold; `--fs-caption` 18u ⇒ 13.3 px at 800p).

```css
:root {
  /* ---- scale ---------------------------------------------------------- */
  --u: clamp(0.62px, calc(100vh / 1080), 2.5px);   /* 1 canvas px */
  --safe-x: 0px;                                     /* TV-safe insets; TV mode sets 96u / 54u */
  --safe-y: 0px;

  /* ---- colour: surfaces (WinUI 3 dark values measured in the screenshots) */
  --color-bg: #1f1f1f;
  --color-surface: #1f1f1f;                 /* action bar, opaque panels */
  --color-surface-translucent: rgba(31, 31, 31, 0.92);  /* store pill, close button, chips */
  --color-control: #2d2d2d;                 /* buttons, placeholders */
  --color-control-hover: #333333;
  --color-control-pressed: #272727;
  --color-control-disabled: #262626;
  --color-control-stroke: rgba(255, 255, 255, 0.07);
  --color-divider: rgba(255, 255, 255, 0.20);
  --color-divider-strong: rgba(255, 255, 255, 0.30);
  --color-split-divider: #3d3d3d;
  --color-glass-tint: rgba(0, 0, 0, 0.22);
  --color-glass-stroke: rgba(255, 255, 255, 0.28);
  --color-glass-hover: rgba(255, 255, 255, 0.14);
  --color-scrim: rgba(0, 0, 0, 0.60);       /* popups other than the detail modal */

  /* ---- colour: text & icons ------------------------------------------- */
  --color-text: #ffffff;
  --color-text-strong: rgba(255, 255, 255, 0.90);     /* meta line, system pill */
  --color-text-secondary: rgba(255, 255, 255, 0.80);  /* description, chips, stat values use .85 */
  --color-text-stat: rgba(255, 255, 255, 0.85);
  --color-text-tertiary: rgba(255, 255, 255, 0.55);   /* "Released", developer, publisher */
  --color-text-label: rgba(255, 255, 255, 0.42);      /* uppercase stat labels (#7e7e7e) */
  --color-text-disabled: rgba(255, 255, 255, 0.36);
  --color-icon: rgba(255, 255, 255, 0.92);
  --color-icon-muted: rgba(255, 255, 255, 0.60);      /* scroll chevron */
  --color-icon-faint: rgba(255, 255, 255, 0.35);      /* achievements chevron */

  /* ---- colour: accent & focus ----------------------------------------- */
  --color-accent: #0078d4;                  /* Windows accent; measured ring #0373c4 */
  --color-accent-hover: #1a86d9;
  --color-focus-ring: var(--color-accent);
  --color-danger: #e81123;
  --color-success: #6ccb5f;

  /* ---- colour: store badges (simple-icons hex unless noted) ----------- */
  --badge-steam: #1b4e7a;                   /* measured; simple-icons steam is #000000 */
  --badge-epicgames: #313131;
  --badge-gogdotcom: #86328a;
  --badge-ea: #000000;
  --badge-battledotnet: #4381c3;
  --badge-ubisoft: #000000;
  --badge-xbox: #107c10;                    /* Xbox green, UNVERIFIED brand value; glyph from Segoe Fluent Icons */
  --badge-playstation: #0070d1;
  --badge-nintendo: #e60012;                /* UNVERIFIED brand value; text badge, no simple-icons glyph */
  --badge-sega: #0089cf;
  --badge-atari: #e4202e;
  --badge-commodore: #1e2a4e;
  --badge-retroarch: #000000;
  --badge-manual: #2d2d2d;                  /* manual .exe games: lucide Gamepad2 on control colour */

  /* ---- gradients ------------------------------------------------------- */
  --gradient-hero-left: linear-gradient(90deg, rgba(0,0,0,.80) 0%, rgba(0,0,0,.62) 22%, rgba(0,0,0,.35) 45%, rgba(0,0,0,.08) 65%, rgba(0,0,0,0) 80%);
  --gradient-hero-bottom: linear-gradient(0deg, rgba(0,0,0,.85) 0%, rgba(0,0,0,.55) 12%, rgba(0,0,0,.15) 30%, rgba(0,0,0,0) 45%);
  --gradient-modal-left: linear-gradient(90deg, rgba(31,31,31,.94) 0%, rgba(31,31,31,.88) 32%, rgba(31,31,31,.45) 55%, rgba(31,31,31,.08) 72%, rgba(31,31,31,0) 85%);
  --gradient-modal-bottom: linear-gradient(0deg, rgba(31,31,31,.90) 0%, rgba(31,31,31,.60) 18%, rgba(31,31,31,0) 40%);

  /* ---- radii ----------------------------------------------------------- */
  --radius-card: calc(16 * var(--u));
  --radius-card-ring: calc(20 * var(--u));  /* card radius + ring width */
  --radius-modal: calc(24 * var(--u));
  --radius-bar: calc(20 * var(--u));
  --radius-button: calc(10 * var(--u));
  --radius-icon-button: calc(12 * var(--u));
  --radius-popup: calc(24 * var(--u));
  --radius-pill: 9999px;

  /* ---- blur / shadow ---------------------------------------------------- */
  --blur-glass: 40px;                       /* not scaled: blur radius is in device px */
  --shadow-card-focus: 0 calc(16 * var(--u)) calc(40 * var(--u)) rgba(0, 0, 0, 0.45);
  --shadow-modal: 0 calc(24 * var(--u)) calc(80 * var(--u)) rgba(0, 0, 0, 0.60);
  --shadow-popup: 0 calc(16 * var(--u)) calc(48 * var(--u)) rgba(0, 0, 0, 0.55);

  /* ---- typography -------------------------------------------------------- */
  --font-ui: "Segoe UI Variable Text", "Segoe UI", "Selawik", system-ui, -apple-system, sans-serif;
  --font-display: "Segoe UI Variable Display", "Segoe UI", "Selawik", system-ui, -apple-system, sans-serif;
  --font-icons: "Segoe Fluent Icons", "Segoe MDL2 Assets";   /* only for the Xbox glyph fallback */
  --fs-caption: max(calc(18 * var(--u)), 12px);   /* version label, chips, stat labels, store pill */
  --fs-body: max(calc(20 * var(--u)), 12px);      /* system pill text, counts */
  --fs-body-lg: max(calc(22 * var(--u)), 13px);   /* description, meta line, quick-action labels */
  --fs-meta: max(calc(24 * var(--u)), 14px);      /* hero meta line */
  --fs-button: max(calc(26 * var(--u)), 14px);    /* Play */
  --fs-row-title: max(calc(32 * var(--u)), 16px); /* row headers, popup titles */
  --fs-stat: max(calc(32 * var(--u)), 16px);      /* stat values */
  --fs-title: max(calc(48 * var(--u)), 20px);     /* logo fallback */
  --fw-regular: 400;
  --fw-semibold: 600;
  --fw-bold: 700;
  --lh-tight: 1.25;
  --lh-body: 1.5;
  --ls-label: 0.08em;

  /* ---- layout: home --------------------------------------------------------- */
  --page-inset-x: calc(88 * var(--u) + var(--safe-x));
  --hero-logo-left: calc(74 * var(--u) + var(--safe-x));
  --hero-logo-top: calc(66 * var(--u) + var(--safe-y));
  --hero-logo-max-w: calc(420 * var(--u));
  --hero-logo-max-h: calc(200 * var(--u));
  --hero-meta-top: calc(300 * var(--u) + var(--safe-y));
  --version-left: calc(18 * var(--u) + var(--safe-x));
  --version-top: calc(22 * var(--u) + var(--safe-y));
  --quick-actions-top: calc(424 * var(--u) + var(--safe-y));
  --quick-action-h: calc(56 * var(--u));
  --quick-action-pad-x: calc(24 * var(--u));
  --quick-action-gap: calc(16 * var(--u));
  --row-header-h: calc(44 * var(--u));
  --row-header-gap: calc(38 * var(--u));      /* header line box → card track */
  --row-gap: calc(48 * var(--u));             /* between row blocks */
  --row-scroll-anchor: calc(150 * var(--u));  /* header top when a row is focused */
  --home-first-row-top: calc(496 * var(--u)); /* Recent Games header line box on the un-scrolled home */
  --card-w: calc(240 * var(--u));
  --card-h: calc(360 * var(--u));
  --card-gap: calc(30 * var(--u));
  --card-track-h: calc(396 * var(--u));       /* room for the 1.10 scale */
  --card-focus-scale: 1.10;
  --card-ring-w: calc(4 * var(--u));
  --badge-size: calc(36 * var(--u));
  --badge-inset: calc(12 * var(--u));
  --badge-glyph: calc(22 * var(--u));
  --chevron-hint-size: calc(36 * var(--u));
  --chevron-hint-bottom: calc(7 * var(--u));

  /* ---- layout: system pill ------------------------------------------------- */
  --pill-h: calc(74 * var(--u));
  --pill-top: calc(42 * var(--u) + var(--safe-y));
  --pill-right: calc(38 * var(--u) + var(--safe-x));
  --pill-pad-left: calc(24 * var(--u));
  --pill-pad-right: calc(18 * var(--u));
  --pill-item-gap: calc(36 * var(--u));
  --pill-divider-gap: calc(28 * var(--u));
  --pill-divider-h: calc(36 * var(--u));
  --pill-hit: calc(44 * var(--u));
  --icon-sm: calc(20 * var(--u));
  --icon-md: calc(24 * var(--u));
  --icon-lg: calc(28 * var(--u));
  --icon-battery: calc(32 * var(--u));
  --icon-stroke: 2;                            /* lucide strokeWidth */

  /* ---- layout: detail modal ------------------------------------------------- */
  --modal-w: min(calc(1680 * var(--u)), calc(100vw - 240 * var(--u)));
  --modal-h: min(calc(960 * var(--u)), calc(100vh - 120 * var(--u)));
  --modal-logo-left: calc(60 * var(--u));
  --modal-logo-top: calc(48 * var(--u));
  --modal-logo-max-w: calc(360 * var(--u));
  --modal-logo-max-h: calc(120 * var(--u));
  --modal-header-top: calc(52 * var(--u));
  --modal-header-right: calc(60 * var(--u));
  --modal-header-gap: calc(20 * var(--u));
  --modal-inset-x: calc(72 * var(--u));
  --modal-pill-h: calc(50 * var(--u));
  --modal-pill-pad-x: calc(28 * var(--u));
  --modal-desc-max-w: calc(720 * var(--u));
  --modal-desc-lines: 5;
  --modal-desc-lh: calc(33 * var(--u));
  --modal-meta-gap: calc(40 * var(--u));
  --modal-stack-gap-chips: calc(24 * var(--u));
  --modal-stack-gap-meta: calc(10 * var(--u));
  --modal-stack-gap-bar: calc(18 * var(--u));
  --chip-h: calc(44 * var(--u));
  --chip-pad-x: calc(24 * var(--u));
  --chip-gap: calc(16 * var(--u));
  --chip-icon-gap: calc(20 * var(--u));
  --bar-inset: calc(38 * var(--u));
  --bar-h: calc(134 * var(--u));
  --bar-pad-x: calc(34 * var(--u));
  --bar-group-gap: calc(40 * var(--u));
  --bar-divider-h: calc(52 * var(--u));
  --bar-label-top: calc(39 * var(--u));
  --bar-value-top: calc(73 * var(--u));
  --btn-play-w: calc(225 * var(--u));
  --btn-play-h: calc(76 * var(--u));
  --btn-play-split-w: calc(52 * var(--u));
  --btn-icon-size: calc(52 * var(--u));
  --btn-icon-gap: calc(24 * var(--u));

  /* ---- layout: popups (Add Games, power menu, context menu) ------------- */
  --popup-w: calc(880 * var(--u));
  --popup-h: calc(640 * var(--u));
  --popup-pad: calc(40 * var(--u));
  --menu-item-h: calc(56 * var(--u));
  --menu-w: calc(420 * var(--u));

  /* ---- motion (Fluent "Motion in Windows" values) ----------------------- */
  --dur-instant: 83ms;      /* fade in/out, pressed state */
  --dur-focus: 150ms;       /* card scale / ring */
  --dur-fast: 167ms;        /* exits */
  --dur-normal: 250ms;      /* entrances, modal open */
  --dur-slow: 333ms;        /* row/page scroll */
  --dur-hero: 400ms;        /* hero crossfade */
  --ease-enter: cubic-bezier(0, 0, 0, 1);         /* Direct Entrance / Fast-In */
  --ease-p2p: cubic-bezier(0.55, 0.55, 0, 1);     /* Point-to-point: focus scale, scroll */
  --ease-exit-soft: cubic-bezier(1, 0, 1, 1);     /* Gentle Exit */
  --ease-linear: linear;
  --focus-bump: calc(8 * var(--u));               /* end-of-row bump distance */
}

@media (prefers-reduced-motion: reduce) {
  :root {
    --dur-focus: 0ms; --dur-fast: 0ms; --dur-normal: 0ms; --dur-slow: 0ms; --dur-hero: 0ms;
    --card-focus-scale: 1.0;
  }
}

/* Glass material used by the system pill and quick actions */
.glass {
  background: var(--color-glass-tint);
  -webkit-backdrop-filter: blur(var(--blur-glass)) saturate(1.2);
  backdrop-filter: blur(var(--blur-glass)) saturate(1.2);
  border: 1px solid var(--color-glass-stroke);
  border-radius: var(--radius-pill);
}
```

Worked example at three viewports (u = canvas-px factor): 1280x800 ⇒ u = 0.741 px ⇒ card 178x267, pill 416x55, row title 23.7 px, modal 1244x711 (clamped by `100vw − 240u` = 1102 ⇒ modal 1102x711); 1920x1080 ⇒ u = 1; 3840x2160 ⇒ u = 2 ⇒ card 480x720, pill 1124x148, row title 64 px.

Implementation notes: keep `--blur-glass` in device pixels (blur is perceptual, not a layout length). Use `transform: scale()` for focus, never width/height, so layout is static. Set `html { background: var(--color-bg); color: var(--color-text); font-family: var(--font-ui); -webkit-font-smoothing: antialiased; overflow: hidden; }` and `body { user-select: none; }`. Hide scrollbars (`scrollbar-width: none; ::-webkit-scrollbar { display: none }`) — the dashboard scrolls by focus, wheel, swipe only.

## 5. Typography

### 5.1 Identification

- Measured glyph proportions in both screenshots match Segoe metrics exactly: x-height = 0.50 em (12 px at 24 px), cap height = 0.70 em (22 px at 32 px), descender ≈ 0.21 em; letterforms (straight-leg `R`, double-storey `a`, straight-tailed `y`, open `9`) match Segoe UI. Winhanced is a WinUI 3 app (FAQ: bundles ".NET 8 and the Windows App SDK"); WinUI 3 uses **Segoe UI Variable** by default, so the screenshots are Segoe UI Variable (Display optical size for the large text, Text for ≤18 px). Static Segoe UI is visually near-identical and is the fallback.
- Weights used in the screenshots: 400 (meta line, description, chips, labels, clock, `85%`), 600 (`Play`, stat values, release date, version label), **700** (row headers `Recent Games` — stem 5 px = 0.156 em, i.e. Bold, not Semibold; Microsoft's own guidance prefers Semibold for titles, but the reference look is Bold and we keep it).

### 5.2 Font facts verified on this Windows 11 machine (build 26300, 26H2)

| Fact | Value | Source |
| --- | --- | --- |
| File | `C:\Windows\Fonts\SegUIVar.ttf`, name table family `Segoe UI Variable`, version 2.03 | opentype.js 2.0.0 parse |
| Axes | `wght` 300–700 (default 400); `opsz` 5–36 (default 10.5) | fvar |
| Named instances | Light 300 / Semilight 350 / Regular 400 / Semibold 600 / Bold 700, each at Small (opsz 8), Text (opsz 10.5) and Display (opsz 36) | fvar |
| Metrics | unitsPerEm 2048; capHeight 1434 (0.700 em); xHeight 1024 (0.500 em); hhea ascender 2210 / descender −514 / lineGap 0 (⇒ default line box 1.33 em); typo 1491 / −431 / gap 269 | OS/2, hhea |
| Static Segoe UI | `segoeui.ttf` v5.72, identical metrics (cap 1434, x 1024, 2210/−514); GDI families `Segoe UI`, `Segoe UI Semibold`, `Segoe UI Light`, `Segoe UI Semilight`, `Segoe UI Black` | font files + GDI enumeration |
| **Family names exposed by DirectWrite** (what Chromium/Electron on Windows matches in CSS) | `Segoe UI Variable Display`, `Segoe UI Variable Text`, `Segoe UI Variable Small` — each with faces Light, Semilight, Regular, Semibold, Bold (+ synthetic obliques). A plain family `Segoe UI Variable` is **not** enumerated by DirectWrite (WPF `Fonts.SystemFontFamilies`), so do not rely on it in CSS. | PowerShell `System.Windows.Media.Fonts` enumeration |
| Icon font | `Segoe Fluent Icons` v1.56 (`SegoeIcons.ttf`), glyphs present: U+E990 XboxOneConsole, U+E7FC Game, U+E721 Search, U+E767 Volume, U+E702 Bluetooth, U+E701 Wifi, U+E83F Battery10, U+E7E8 Power, U+E713 Settings, U+E7A1 Speedometer, U+E734 FavoriteStar, U+E70D ChevronDown, U+E711 Cancel, U+E768 Play (U+E9F1 and U+EB24 absent) | cmap lookup |
| Microsoft type ramp (reference) | Caption 12/16 Small; Body 14/20 Text; Body Strong 14/20 Text semibold; Body Large 18/24 Text; Subtitle 20/28 Display semibold; Title 28/36 Display semibold; Title Large 40/52 Display semibold; Display 68/92 Display semibold. "Use regular weight for most text, use Semibold for titles". Minimum 14 px Semibold / 12 px Regular. | https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/typography |

### 5.3 Rules for GameDash

- `--font-display` (`"Segoe UI Variable Display"`) for every size ≥ 20u (row headers, stat values, Play, meta line, description, pill text); `--font-ui` (`"Segoe UI Variable Text"`) for 18u text (chips, labels, version, store pill). Optical size is fixed per DirectWrite family, so `font-optical-sizing` has no effect here — pick the family by size.
- Weights: 400 body, 600 emphasis/values/buttons, 700 row and popup titles only. Never italic (not in the Windows ramp; obliques are synthetic).
- Fallback chain (tokens above): Segoe UI Variable → `Segoe UI` (Windows 10 / older) → `Selawik` (bundle `Selawik`, OFL-1.1 per https://github.com/microsoft/Selawik, "metrically compatible with Segoe UI" per Microsoft's typography page) → `system-ui`. Do **not** bundle any Segoe font (Microsoft system fonts are not redistributable).
- `font-variant-numeric: tabular-nums` on the clock, battery %, play time and HLTB values so digits don't jitter; `letter-spacing: .08em` + `text-transform: uppercase` only on stat labels; `text-rendering: optimizeLegibility`; `-webkit-font-smoothing: antialiased`.
- Line heights: 1.25 for titles/values, 1.5 (33u at 22u) for the description, 32u line box for the 24u meta line, 44u for the 32u row header.

## 6. Interaction specification (Xbox Series dashboard model)

Primary sources: Microsoft "Gamepad and remote control interactions" (hardware buttons, built-in mappings, accelerator table, XY focus, focus visual, focus engagement, mouse mode) — https://learn.microsoft.com/en-us/windows/apps/design/input/gamepad-and-remote-interactions ; "Designing for Xbox and TV" (TV-safe area, sizes, 6-click rule, Y = search) — https://learn.microsoft.com/en-us/windows/apps/design/devices/designing-for-tv ; W3C Gamepad API "standard" mapping — https://w3c.github.io/gamepad/#remapping ; Winhanced FAQ rules ("A always selects", "B always goes back", stick/d-pad move focus through the current layer). Values marked *design* are ours.

### 6.1 Input sources and mode

- Inputs: gamepad (Gamepad API, polled with `requestAnimationFrame`, max 4 pads, the most recently active pad is "primary"), keyboard, mouse, touch (Pointer Events with `pointerType`). Every input drives the **same focus state**; the last-used source sets `document.documentElement.dataset.inputMode = "gamepad" | "keyboard" | "mouse" | "touch"`.
- Focus ring (4u accent) renders only when `inputMode` is `gamepad` or `keyboard` (this is what 2.webp vs 1.webp shows). The 1.10 scale renders for every mode. Mouse cursor is hidden 2 s after the last pointer move while `inputMode` is `gamepad` (CSS `cursor: none` on `html`), shown again on the first mouse move.
- Microsoft: "the focus visual is displayed by default when using a gamepad or remote control, but not a keyboard" — we deliberately show it for keyboard too (desktop use).

### 6.2 Focus model

- The screen is a vertical list of **focus rows**; each row is a horizontal list of focusables. Rows on the home screen, top to bottom: `systembar` (search, volume, bluetooth, wifi, battery, power, clock), `quick` (Settings, Exit), `recent` (cards), then one `platform:<id>` row per platform in the library, in the fixed order Steam, Epic, GOG, EA, Battle.net, Ubisoft, Xbox, Manual, then ROM systems alphabetically; an empty library shows the `addgames` row (6.10). Rows with zero items are skipped by vertical navigation (but platform rows with 0 games are hidden entirely unless "show empty platforms" is on).
- State: `focus = { rowId, index }` plus `lastIndexByRow: Map<rowId, number>` (remembered column per row, persisted for the session) and a `focusHistory` stack for Back.
- Horizontal (`left`/`right`): `index ± 1`, clamped; at the ends do not wrap — play the **bump** animation (translateX ±8u, 120 ms, `--ease-p2p`) on the row. Home/End (keyboard) or holding LB/RB jump to first/last.
- Vertical (`up`/`down`): move to the adjacent non-empty row and restore `lastIndexByRow[row]` (default 0), clamped to the row length. Entering a row from another row never changes the destination row's scroll position except to bring the restored item into view. `up` from `recent` goes to `quick`, then `systembar`; `down` from the last row bumps. From `systembar`, `down` returns to the row that was focused before (history), not necessarily `quick`.
- Initial focus on launch: `recent[0]` (Microsoft: "place the focus on a UI element that makes sense as the first element on which the user would take action … top left region"). If the Recent row is empty, focus the first platform row's first card, else the `addgames` tile.
- Focus memory across screens: opening the detail panel pushes `{rowId,index}`; B/close restores exactly that card (Winhanced v0.9.x changelog: returning from a side panel lands on the row you left). Returning from Settings restores the previous focus too.
- Spatial fallback for non-grid surfaces (popups, settings pages): use geometric XY navigation — candidate = focusable whose centre lies in the 90° cone of the direction with the smallest weighted distance `d = Δprimary + 2·Δorthogonal`; this mirrors XAML XY focus. Each popup is a focus trap (focus never leaves it until closed), with `tabindex` order as the fallback for Tab.

### 6.3 Focus visuals and timing

- Card focus: `transform: scale(1.10)` about `50% 100%`, `--dur-focus` 150 ms `--ease-p2p`; ring `outline: var(--card-ring-w) solid var(--color-focus-ring); outline-offset: 0` with `border-radius` 16u (outer 20u), fading in over 83 ms; shadow `--shadow-card-focus`. Unfocus reverses in 150 ms. Only one card is scaled at a time.
- Controls (pill items, buttons, chips, menu rows): background `--color-glass-hover` / `--color-control-hover`, scale 1.04 (buttons only), ring 4u with 2u offset.
- Hero follow: when `focus.rowId` is any card row, after 150 ms without further movement the hero art, logo and meta line crossfade (400 ms) to the focused game. During fast repeats the hero does not update until movement stops.
- Sounds (design, default **off**; Settings › Sounds): focus tick, select, back, error; Microsoft notes UWP enables control sounds on Xbox. Haptics (design, default off): `gamepad.vibrationActuator?.playEffect('dual-rumble', {duration: 24, weakMagnitude: 0.25, strongMagnitude: 0})` on select only.

### 6.4 Gamepad mapping (W3C "standard" layout; verified)

| Index | Standard location | Xbox name | GameDash action |
| --- | --- | --- | --- |
| `buttons[0]` | bottom button, right cluster | **A** | Select / activate focused item (open detail panel from a card; Play from the Play button). Winhanced FAQ: "A always selects." |
| `buttons[1]` | right button, right cluster | **B** | Back: close popup/menu → close detail panel → (on home with nothing open) no-op. Never exits the app. Winhanced FAQ: "B always goes back to wherever you just were." In mouse mode: exit mouse mode. |
| `buttons[2]` | left button, right cluster | **X** | Secondary action on the focused card: toggle favourite (same as the Star button in the panel). In the detail panel: open "Game options". |
| `buttons[3]` | top button, right cluster | **Y** | Search (Microsoft accelerator table: "Search — Y button"). Opens the search overlay with the on-screen keyboard. |
| `buttons[4]` / `[5]` | top-left / top-right front buttons | **LB / RB** | Jump to previous / next **section** (row): from any card row, LB = previous platform row, RB = next; inside the detail panel LB/RB = previous/next game of the row the panel was opened from (panel content swaps, 250 ms crossfade). Microsoft: bumpers = "Page left/right" accelerators; Xbox guide uses LB/RB to switch tabs. |
| `buttons[6]` / `[7]` | bottom-left / bottom-right front buttons (triggers, analog 0–1, press when > 0.5) | **LT / RT** | Page within the current row: move focus by **5** cards left/right (clamped). In vertical lists (settings, achievements) = Page Up/Down. Microsoft: triggers = "Page up/down". |
| `buttons[8]` | left button, centre cluster | **View** | Toggle focus between the current row and the system bar (nav-pane accelerator per Microsoft: "Open/close nav pane — View"). Press again or B returns. |
| `buttons[9]` | right button, centre cluster | **Menu** | Context menu for the focused item (Microsoft: "Open context menu — Menu button"): Play · Favourite · Hide game · Change artwork · Properties · Open install folder. |
| `buttons[10]` / `[11]` | stick presses | **LS / RS** | LS: no action. RS double-press within 400 ms: toggle **mouse mode** (cursor driven by the right stick at 1200 u/s at full deflection, RB = left click, RT = right click, B or RS double-press = exit; LB = middle? no). Winhanced: "activate it by double pressing the right thumbstick", "RB acts as your left click", "RT acts as your Right Click". |
| `buttons[12..15]` | left cluster up/down/left/right | **D-pad** | Move focus (6.2). Repeat: first repeat after **400 ms**, then every **120 ms**, accelerating to **60 ms** after 6 consecutive repeats (design; Windows keyboard defaults are ~500 ms / 30 Hz). |
| `buttons[16]` | centre button, centre cluster | **Xbox/Guide** | Open the GameDash **Guide overlay** (power, volume, settings, now-playing). On Windows this button is normally captured by Xbox Game Bar (Win+G) and may never reach the page — UNVERIFIED for Electron; provide **View + Menu held together (300 ms)** as the equivalent ("Start + Select" is what Winhanced 1.0 uses on any PC). |
| `axes[0]`,`[1]` | left stick x (−1 left … +1 right), y (−1 up … +1 down) | **Left stick** | Same as D-pad: radial dead zone **0.25**; a direction fires when the dominant axis crosses **±0.5** and releases below **±0.35** (hysteresis); repeat timing as D-pad, and while held beyond ±0.9 the interval is halved again (60 → 40 ms cap). Diagonals pick the dominant axis only. |
| `axes[2]`,`[3]` | right stick | **Right stick** | Scroll the description/achievements list (vertical), 900 u/s at full deflection; in mouse mode moves the cursor. |

Gamepads with `mapping !== "standard"` (some third-party pads) use the same indices after a one-time calibration prompt (design). Poll at display rate; treat a button as pressed when `pressed || value > 0.5`; de-bounce by edge detection per index.

### 6.5 Keyboard mapping (same semantics as the gamepad; Microsoft built-in mapping: arrows = D-pad/left stick, Enter/Space = A, Escape = B)

| Key | Action |
| --- | --- |
| `ArrowLeft/Right/Up/Down` | move focus (6.2); OS key-repeat drives repeats |
| `Enter`, `Space` | A |
| `Escape`, `Backspace` (outside text fields), `BrowserBack` | B |
| `F` | X (favourite) |
| `/`, `Ctrl+F`, `F3` | Y (search) |
| `PageUp` / `PageDown` | LT / RT (5 cards; page in lists) |
| `Home` / `End` | first / last item in the row |
| `Ctrl+ArrowLeft` / `Ctrl+ArrowRight`, `[` / `]` | LB / RB (previous / next section) |
| `Tab` / `Shift+Tab` | next / previous focusable in DOM order (accessibility fallback only; rows are `role="list"` with `aria-activedescendant`) |
| `ContextMenu`, `Shift+F10` | Menu (context menu) |
| `F1`, `Ctrl+Space` | View (jump to system bar) |
| `Alt+Home` | Guide overlay |
| `Alt+Enter`, `F11` | toggle fullscreen window (Electron `setFullScreen`) |
| `Ctrl+,` | Settings |
| `Alt+F4` | OS close (allowed; the app asks "Exit GameDash?" only if a game session is running) |

### 6.6 Scroll-into-view

- Horizontal (within a row): the row is `overflow-x: hidden` and translated with `transform: translateX(−offset)` (not native scroll, so the position is deterministic). Target: keep the focused card's **natural** box inside `[page-inset-x, viewportWidth − page-inset-x − card-w]`; when the focused card would cross the right boundary, scroll so that it lands at `viewportWidth − page-inset-x − card-w` (one card moves in from the right); when it would cross the left boundary, scroll so it lands at `page-inset-x`. Jumps of several cards (LT/RT, Home/End, restored focus) centre the card instead. Animate 300 ms `--ease-p2p`; the scaled card and ring are never clipped because the track is 396u tall and the row has 12u horizontal overflow slack on the left (`margin-left: −12u; padding-left: 12u`).
- Vertical (page): the page is a `transform: translateY` container as well. When focus moves to a row, scroll so the row header's line-box top = `--row-scroll-anchor` (150u), except that the home's first row stays at 496u while `scrollTop === 0` and focus is in `recent`, `quick` or `systembar` (the hero remains visible). Moving down from `recent` to the first platform row scrolls the page so that platform header sits at 150u (hero fades out per 2.1). Moving back up to `recent` scrolls to 0. Animate 333 ms `--ease-p2p`.
- Lists inside popups (settings, achievements, context menu): `scrollIntoView({block: "nearest"})` with 16u scroll margin.
- Chevron hint (2.6) is visible only at scrollTop 0 and hides while any popup is open.

### 6.7 Touch (Pointer Events, `pointerType === "touch"`; all targets ≥ 44u)

- **Tap** on a card: if it is not the focused card, focus it (scale + hero follow) **and** activate it (open the detail panel) in one tap — Xbox-style single tap; no "first tap focuses, second activates" for cards. Tap on a focused card: activate. Tap on buttons/pill items: activate. Tap outside the detail modal (on the dimmed home) closes it (= B).
- **Horizontal swipe / drag** on a row (dx > 12u and |dx| > |dy|): pan the row 1:1 with the finger, then momentum (deceleration 0.0025 u/ms²), final position snapped so a card's left edge aligns with `page-inset-x` (`scroll-snap-type: x proximity` equivalent). Focus does not change during a pan; a tap after the pan focuses+activates. Vertical swipe anywhere pans the page (same momentum, snap to row anchors at 150u, hero at 0).
- **Long-press** 500 ms (no movement > 8u): context menu (= Menu button) on cards; on the system bar it opens the item's popover.
- **Pinch**: ignored. **Edge swipes**: none. The system pill items are tap targets 44u wide; the detail panel's description scrolls by drag when clamped (opens the full text in a scrollable sheet on tap).
- Touch sets `inputMode = "touch"`: no ring, no hover states, scale still applies to the focused card.

### 6.8 Mouse

- **Hover** focuses after a 60 ms dwell (prevents focus skipping while crossing cards) — scale, hero follow, no ring (1.webp). Leaving a card does not unfocus it; focus stays on the last hovered/focused item.
- **Click** = A on the hovered item. **Right-click** = Menu. **Middle-click**: nothing. **Back/forward mouse buttons** (`button === 3`) = B.
- **Wheel** over a row: vertical wheel scrolls the page (rows), horizontal wheel/trackpad (`deltaX`) pans the row by `deltaX × 1.5` with snapping; `Shift+wheel` pans the row. Over the detail modal the wheel scrolls the description/achievements list.
- **Edge paddles** (mouse only, design): while `inputMode === "mouse"` and the row overflows, 48u round glass buttons with `ChevronLeft`/`ChevronRight` appear at the row's left/right edges (vertically centred on the cards) on row hover; click pages by one viewport width.
- Drag on cards does nothing (no drag-and-drop in v1). Double-click = Play (launch) from a card.

### 6.9 Screens and their focusables

**Home**: rows per 6.2. `quick` row: **Settings** opens the Settings screen (a full page with a left nav list: General, Library & Folders, Emulators, Artwork & Metadata, Controls, Display & TV mode, Sounds, About; B returns). **Exit** opens the **power menu**: a 420u-wide popup anchored under the pill (top-right) with rows `Sleep` (`Moon`), `Restart` (`RotateCcw`), `Shut down` (`Power`), `Exit to desktop` (`LogOut`), `Cancel`; rows 56u tall, icon 24u + 16u gap + label 22u/400; the destructive rows need a second A press on an inline "Confirm" state (design).

**System bar** (row `systembar`): each item is focusable; A opens its popover below the pill (right-aligned, glass material, 320u wide): Search → full-screen search overlay with the on-screen keyboard (Y accelerator; Microsoft recommends the OSK "already opened"); Volume → slider 0–100 (left/right ±5, LT/RT ±20, A toggles mute, shows `VolumeX` when muted); Bluetooth → paired devices list with connect/disconnect, `BluetoothOff` state; Wi-Fi → network list + strength (`WifiZero/Low/High`, `WifiOff`); Battery → read-only popover with % and time remaining (`BatteryCharging` while charging, `BatteryWarning` ≤ 10 %); Power → same power menu as Exit; Clock → non-focusable text. The pill's items are skipped by Tab when a popover is open.

**Detail panel** (opened by A/tap/click on a card): focus goes to **Play**. Focus rows inside the panel: `header` (store pill — opens the store page/launcher; close X), `chips` (non-focusable), `bar` = [Play, Play-chevron, Total play time (non-focusable), Achievements group, Main story, Main+Extras, Completionist (non-focusable), Settings, Gauge, Star]. Left/right walk the bar skipping non-focusables; up goes to the header row (store pill, close), down returns to Play. LB/RB swap to the previous/next game in the originating row (header, art, text and bar crossfade 250 ms; the card focus behind the panel moves too). B closes and restores card focus. Achievements group A → slides in a right-side sheet (560u wide, full height, glass+`#1f1f1f`) listing achievements (icon 64u, name 22u/600, description 18u/400, unlocked date 18u tertiary); B closes the sheet. Play-chevron A → launch menu popup. Star A → toggles favourite with a 150 ms fill animation. Settings A → Game options page (artwork pickers, launch parameters, emulator/core, hide). Gauge A → performance profile picker (v1: placeholder listing Windows power plans).

**Library rows**: one row per platform below `recent`: header = platform glyph 24u (section 7) + name + count; cards identical to Recent (2.5) with the platform badge; sort = last played desc (default), title asc, or play time (Settings › Library). A platform row's count badge reads `12 games`. Rows are virtualised: render ±6 cards beyond the viewport.

### 6.10 Add Games empty state and popup (design)

- Where: when the whole library is empty the home shows, instead of card rows, the header `Your library is empty` (32u/700) and one **Add games** tile at the Recent position; when only a platform row is empty but enabled, that row shows the tile as its single card. The tile: 240x360u, `border: 2u dashed rgba(255,255,255,.35)`, `border-radius: 16u`, `background: rgba(255,255,255,.06)`, centred `Plus` icon 48u (`rgba(255,255,255,.8)`) above the label `Add games` 22u/600; hover/focus: border `rgba(255,255,255,.7)`, background `.10`, scale 1.10 like a card.
- Popup (A/tap on the tile, also reachable from Settings › Library & Folders and from the context menu): centred 880x640u, radius 24u, `#1f1f1f`, shadow `--shadow-popup`, scrim `--color-scrim` over the home, open/close motion as the modal. Title `Add games` 32u/700 at padding 40u; subtitle 20u/400 tertiary "Pick where GameDash should look for installed games." Body = a vertical list (focus trap) of rows 56u: **Scan stores** group with one toggle row per store (Steam, Epic Games, GOG, EA app, Battle.net, Ubisoft Connect, Xbox / Microsoft Store) showing the store glyph 24u, name 22u/400, status text 18u tertiary (`Detected — 42 games` / `Not installed`) and a switch (52x28u pill, accent when on); **ROM folders** row (`FolderPlus` 24u, `Add ROM folder…`, opens the OS folder picker; sub-rows list added folders with a `Trash2` remove button); **Manual games** row (`Plus`, `Add .exe…`, OS file picker). Footer: primary button `Scan now` (accent fill `#0078d4`, 52u tall, radius 10u, 26u/600) right-aligned and `Cancel` (control fill) to its left, 16u gap. B/Escape/X-button = close. While scanning, the primary button shows a `LoaderCircle` spinner (rotating 1 s linear) and the store rows update their counts live; on completion the popup closes and focus lands on the first new card.

### 6.11 TV mode and safe area

Settings › Display › **TV mode** (auto-on when the primary display is ≥ 40 in or the user chooses it) sets `--safe-x: 96u` and `--safe-y: 54u` (Microsoft TV-safe guidance: 48 epx / 27 epx at 960x540 epx ⇒ 96 / 54 px at 1080p, i.e. 5 %) so every interactive element and text stays inside the safe area while hero art and rows still bleed to the edges (Microsoft: "draw only non-essential visuals within 5% of the screen edges"; "Horizontally scrolling lists and grids should extend to the right edge"). Keep the Microsoft "six clicks" rule: no more than six moves edge to edge — 6.4 cards fit at 1080p, and LT/RT page by 5.

### 6.12 Interaction timings summary (design unless stated)

| Event | Duration / easing |
| --- | --- |
| Focus scale/ring | 150 ms `--ease-p2p` |
| Row pan (one card) | 300 ms `--ease-p2p`; multi-card jump 333 ms |
| Page scroll to row | 333 ms `--ease-p2p` |
| Hero crossfade | 400 ms linear opacity, 150 ms debounce |
| Modal/popup open | 250 ms `--ease-enter`, scale .96→1 + fade |
| Modal/popup close | 167 ms `--ease-exit-soft`, fade + scale →.98 |
| Pressed state | 83 ms |
| End-of-row bump | 120 ms out, 120 ms back |
| D-pad/stick repeat | 400 ms initial, 120 ms, 60 ms after 6 repeats (40 ms at ≥ 0.9 deflection) |
| Hover dwell before focus | 60 ms |
| Long-press | 500 ms |
| Double-press RS (mouse mode) | ≤ 400 ms |
| Cursor auto-hide (gamepad mode) | 2 s |

## 7. Icons

Packages verified by installing them (npm registry, 2026-10-29): **lucide-react 1.64.0** (ISC licence; 6 818 exports incl. `*Icon`/`Lucide*` aliases) and **simple-icons 16.36.0** (CC0-1.0; 3 467 icons; each export has `title, slug, svg, path, source, hex, guidelines`). Every lucide name below was checked with `typeof lucide[name] === "object"`; every simple-icons slug below was checked against the package's slug set. `@icons-pack/react-simple-icons` is at 13.15.1 and lags simple-icons 16, so render simple-icons directly: `import { siSteam } from "simple-icons"; <svg viewBox="0 0 24 24" fill="currentColor"><path d={siSteam.path} /></svg>`.

### 7.1 lucide-react names for the glyphs in the screenshots

| Screenshot glyph | lucide-react export | Size in canvas px | Notes |
| --- | --- | --- | --- |
| Magnifier (pill) | `Search` | 28 | `strokeWidth={2}` everywhere unless noted |
| Speaker with waves | `Volume2` (muted `VolumeX`, low `Volume1`, off `VolumeOff`) | 24 | |
| Bluetooth | `Bluetooth` (`BluetoothOff`, `BluetoothConnected`) | 24 | |
| Wi-Fi arcs + dot | `Wifi` (`WifiHigh`, `WifiLow`, `WifiZero`, `WifiOff`) | 24 | |
| Battery (horizontal, nub right) | `BatteryFull` ≥ 80 %, `BatteryMedium` 40–79, `BatteryLow` 11–39, `BatteryWarning` ≤ 10, `BatteryCharging` while charging, `Battery` unknown | 32 | lucide batteries are 24-unit art with a 20x12 body — set `size={32}` to get the 31x14 ink measured |
| Power (open circle + line) | `Power` | 24 | |
| Down chevron (scroll hint) | `ChevronDown` | 36 | `strokeWidth={2}` ⇒ 18x10 ink as measured |
| Close X | `X` | 20 | in a 50 px circle |
| Split-button chevron | `ChevronDown` | 20 | |
| Achievements chevron | `ChevronDown` | 28 | `--color-icon-faint` |
| Gear | `Settings` | 24 | |
| Half-gauge with needle | `Gauge` | 24 | lucide `Gauge` is an arc + needle, matching the screenshot (not `CircleGauge`) |
| Star | `Star` | 24 | favourite on: `fill="currentColor"` |

### 7.2 lucide-react names for GameDash-added UI

`Play`, `Pause`, `Trophy` (achievements sheet title), `Timer`/`Hourglass` (HLTB), `Clock` (play time), `Plus`, `FolderPlus`, `Folder`, `FolderOpen`, `Trash2`, `Pencil`, `Image`, `ImagePlus`, `LogOut`, `Moon`, `RotateCcw`, `Gamepad2` (manual games / controller settings), `Keyboard`, `Mouse`, `Hand` (touch), `Library`, `LayoutGrid`, `List`, `Filter`, `SlidersHorizontal`, `ArrowUpDown`, `History`, `Ellipsis` (alias of `MoreHorizontal`), `EllipsisVertical`, `Check`, `CircleCheck` (alias `CheckCircle`), `CircleX`, `CircleHelp` (alias `HelpCircle`), `Info`, `TriangleAlert`, `LoaderCircle` (alias `Loader2`), `ChevronLeft`, `ChevronRight`, `ChevronUp`, `ArrowLeft`, `RefreshCw`, `Download`, `Monitor`, `MonitorCog`, `Tv`, `HardDrive`, `Cpu`, `Users`, `CircleUser`, `Heart`, `EyeOff`, `Eye`, `Lock`, `Globe`, `ExternalLink`, `Bell`, `Sun`, `Palette`, `Languages`, `Maximize2`, `Minimize2`, `Fullscreen`, `Cog`, `Wrench`, `Zap`, `Flame`, `Thermometer`, `Signal`, `Usb`, `Cast`, `Volume`, `Speaker`, `Headphones`. All verified present in 1.64.0.

### 7.3 simple-icons slugs for platform / store badges (verified in 16.36.0)

| Platform | slug (export) | brand hex | Badge fill in GameDash |
| --- | --- | --- | --- |
| Steam | `steam` (`siSteam`) | `000000` | `#1b4e7a` (measured Winhanced badge), white glyph |
| Epic Games | `epicgames` (`siEpicgames`) | `313131` | `#313131` |
| GOG | `gogdotcom` (`siGogdotcom`) | `86328A` | `#86328a` |
| EA app | `ea` (`siEa`) | `000000` | `#000000` |
| Battle.net | `battledotnet` (`siBattledotnet`) | `4381C3` | `#4381c3` |
| Ubisoft Connect | `ubisoft` (`siUbisoft`) | `000000` | `#000000` |
| PlayStation (ROM systems PS1/PSP/Vita) | `playstation`, `playstation2`, `playstation3`, `playstation4`, `playstation5`, `playstationportable`, `playstationvita` | `0070D1` / `003791` | `#0070d1` |
| Sega (Genesis/Saturn/Dreamcast rows) | `sega` | `0089CF` | `#0089cf` |
| Atari | `atari` | `E4202E` | `#e4202e` |
| Commodore (C64/Amiga) | `commodore` | `1E2A4E` | `#1e2a4e` |
| RetroArch (generic libretro cores) | `retroarch` | `000000` | `#000000` |
| Dolphin (GameCube/Wii emulator) | `dolphin` | `00AAFF` | use only as emulator icon, not as a Nintendo badge |
| RetroAchievements | `retroachievements` | `1065DF` | achievements sheet for ROMs |
| itch.io / Humble / Rockstar / Origin (legacy) / Legacy Games / Game Jolt | `itchdotio`, `humblebundle`, `rockstargames`, `origin`, `legacygames`, `gamejolt` | `FA5C5C` / `CC2929` / `FCAF17` / `F56C2D` / `144B9E` / `CCFF00` | optional sources |
| NVIDIA (GeForce NOW) | `nvidia` | `76B900` | future |

**Not in simple-icons 16.36.0** (verified absent): `xbox`, `microsoft`, `windows`, `windows11`, `microsoftstore`, `nintendo`, `nintendoswitch`, `nintendo3ds`, `nintendogamecube`, `wii`, `wiiu`, `nintendods`, `gameboy`, `gameboyadvance`, `snes`, `neogeo`, `amazongames`, `amazonluna`, `geforcenow`, `mame`, `ppsspp`, `dosbox`, `scummvm`, `playnite`, `launchbox`, `emulationstation`, `esde`, `batocera`, `blizzard`, `electronicarts`, `minecraft`. Nintendo, Nintendo 3DS/DS/GameCube/Switch, Wii, Wii U and Game & Watch were removed in Simple Icons 14 (Shields.io's upgrade post lists them; no reason stated: "Decisions about changes and removals are made by the SimpleIcons project"). The Microsoft/Xbox removal is UNVERIFIED as to version/reason (only their absence is verified).

Fallbacks for the missing badges (design): **Xbox / Microsoft Store** → Segoe Fluent Icons glyph U+E990 (`XboxOneConsole`) or U+E7FC (`Game`) rendered with `font-family: "Segoe Fluent Icons"` on `#107c10` (present on Windows 11, verified in `SegoeIcons.ttf`; not redistributable, so on non-Windows dev machines fall back to lucide `Gamepad2`); **Nintendo systems** (NES, SNES, N64, GameCube, Wii, Wii U, Switch, GB/GBC/GBA, DS/3DS) → neutral text badges: a 36 px circle `#e60012` with the system abbreviation in 12 px/700 white (`NES`, `SNES`, `N64`, `GC`, `Wii`, `WiiU`, `NSW`, `GB`, `GBA`, `DS`, `3DS`) — avoids using Nintendo's logo; **arcade/MAME, DOS, ScummVM, others** → lucide `Gamepad2` / `Monitor` on `#2d2d2d`; **manual .exe games** → lucide `Gamepad2` on `#2d2d2d`. Brand glyphs remain subject to each brand's guidelines (`siSteam.guidelines` → https://partner.steamgames.com/doc/marketing/branding); CC0 covers the SVG data only, not the trademarks.

## 8. Open questions / unverified items

1. 2.webp is a 1920x**1200** capture (evidence in 1.1), not 1080 as the task text says; the modal is specified with equal 120 px margins at 1200 and 60 px top/bottom at 1080. If the team prefers Winhanced's exact 1080p behaviour, capture it on a 16:9 device.
2. Whether Winhanced's focus ring appears for keyboard focus (we show it for gamepad **and** keyboard) and whether its mouse hover scales cards (1.webp shows the scale with no ring, consistent with hover, but the input device at capture time is unknown).
3. Row-to-row vertical spacing (48u) and the library row header layout are design choices; 2.webp's second row is a landscape "store" row of a different type.
4. Exact pill blur radius (≥ 40 px inferred) and tint (≈ 22 % black) are inferred from luminance ratios on a non-uniform backdrop.
5. Chromium's CSS matching of `"Segoe UI Variable Display"` is inferred from DirectWrite's enumeration (Chromium uses DirectWrite on Windows) — confirm once with a one-line `document.fonts` / canvas measurement in the Electron renderer.
6. Gamepad `buttons[16]` (Xbox/Guide) delivery to an Electron renderer on Windows while Xbox Game Bar is installed is UNVERIFIED; the View+Menu chord fallback is mandatory.
7. Repeat/acceleration timings (400/120/60 ms), dead zones (0.25/0.5/0.35), hover dwell (60 ms) and all popup dimensions are design values, not measured from Xbox or Winhanced.
8. Xbox brand green `#107c10` and Nintendo red `#e60012` are from memory (UNVERIFIED); neither brand's glyph is shipped.
9. The Winhanced Patreon posts, TechSpot and Windows Central pages returned HTTP 403; their content was taken from syndicated copies (Yahoo) and search snippets.
10. Battery/Wi-Fi/Bluetooth/volume data sources are out of scope here (UI only); `navigator.getBattery()` in Electron on Windows should be verified by the system-bar implementer.

## 9. Files produced

- Report: `scratchpad/research/winhanced-design.md` (this file).
- Zoomed, gridded crops used for the measurements: `scratchpad/research/crops/*.png` (h-* = home, d-* = detail; magenta/cyan grid every 5 or 10 canvas px, labels every 25/50 px).
- Measurement tool: `scratchpad/scripts/img.js` (requires the sharp install in `scratchpad/repos/npm-tools/node_modules`).
- Local copies of the screenshots: `scratchpad/images/1.webp`, `scratchpad/images/2.webp`.
