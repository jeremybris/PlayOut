# Home button and in-game overlay

The home button opens PlayOut's overlay over any game, at any time. The default is the controller's Guide button
(Xbox / PS / the handheld "home" button, the one Steam uses). The user can remap it to any button or to several
buttons held together, in Settings › **Controls**.

The overlay is modelled on Winhanced's HUD, in PlayOut's own look. It has these sections:

- **Power:** profiles, with real watts where the power helper is installed.
- **Per game:** profiles saved for the game.
- **Display:** brightness, refresh rate and resolution.
- **Sound:** volume.
- **Music:** what Windows is playing, plus a local-folder player with per-game playlists.
- **Game:** back to game, PlayOut, quit.
- **Friends:** the user's Steam friends and what they are playing; Message opens Steam's own chat (see "Friends").
  While the game under the overlay runs through PeerParty, a **PeerParty** tab takes its place (see "PeerParty").

Decisions: the user's answers of 2026-11-12, kept in memory.

- **TDP:** profiles that need no driver, plus real watts through an elevated helper where it works.
- **Steam:** Steam's Guide setting is turned off automatically, restarting Steam if needed, and restored when the
  override is turned off.
- **Music:** both sources.
- **Winhanced:** a warning appears when its shortcut clashes with ours.

## Pieces

| Piece          | Where                                                  | Role                                                                                                                                                                                                                                         |
| -------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native host    | `src/main/native-host/`                                | One long-lived `powershell.exe` that compiles a small C# class with `Add-Type`. A background thread polls controllers and writes one JSON line per change. Commands come in on stdin as JSON lines and are answered with one JSON line each. |
| Home button    | `src/main/home-button/`                                | Matches pad state against the combo (pure, `combo.ts`). Runs Settings' capture of a new combo. Applies and restores the Steam and Game Bar overrides. Checks for a clash with Winhanced.                                                     |
| Overlay window | `src/main/overlay/`                                    | A second, transparent, always-on-top BrowserWindow that loads the same `index.html?overlay=1`. It is shown on the game's monitor and given focus. When it closes, focus goes back to the game window.                                        |
| Performance    | `src/main/performance/`                                | Power profiles. The no-driver backend uses Windows power mode, the CPU maximum state and CPU boost. The watts backend uses the elevated power helper. Per-game profiles are applied at session start and undone at session end.              |
| Display        | `src/main/display/`                                    | Lists display modes and sets refresh rate and resolution on the game's monitor.                                                                                                                                                              |
| Media          | `src/main/media/`                                      | Reads and controls the Windows media session (what is playing) through SMTC. Lists the local music folder and serves it to the overlay through `playout-music://`.                                                                           |
| Overlay UI     | `src/renderer/src/overlay/`                            | The overlay app, mounted instead of `App` when `?overlay=1`.                                                                                                                                                                                 |
| Controls UI    | `src/renderer/src/screens/Settings/sections/Input.tsx` | The home button section: on/off, the combo with "Press new buttons" capture, hold time, the Steam and Game Bar overrides and their state, and the Winhanced warning.                                                                         |

## Controller buttons

`PadButton` = `a b x y lb rb lt rt view menu ls rs up down left right guide`, in that bit order:
`a` = bit 0 … `guide` = bit 16. The native host reports a 17-bit mask per pad, plus the sticks (`axes`: left X / Y, right X / Y in -1..1, up negative, zero
inside a 0.12 deadzone, in 1/64 steps) and triggers (`triggers`: 0..1 in 1/32 steps) for the in-game overlay's
navigation; the rounding keeps stick noise from writing a line every poll. Two sources:

- **XInput pads** through `XInputGetStateEx` (`xinput1_4.dll` ordinal 100). Its Guide bit is 0x0400. Triggers
  count as pressed above 30/255.
- **Other pads** (DualShock 4, DualSense, Switch Pro) through SDL2 when `SDL2.dll` is available, with SDL's XInput,
  RawInput, WGI and HIDAPI-Xbox drivers turned off so XInput pads are never counted twice.

A combo fires on the press that completes it: every button of the combo is held and at least one of them was just
pressed. When `homeHoldMs` > 0, the buttons must stay held that long. A combo that has fired cannot fire again until
one of its buttons is released.

## Touch swipe

A swipe from the left edge of a touchscreen opens the overlay while a game runs (`input.touchSwipeOverlay`, default
on). `src/main/touch-swipe`:

- **script.ts:** a powershell.exe running C# with a low-level mouse hook (`WH_MOUSE_LL`). Windows turns a touch over a
  game into mouse input marked as touch (`dwExtraInfo & 0xFFFFFF80 == 0xFF515780`), so the hook sees touches in
  screen pixels on any monitor, whatever program has the focus. The hook only looks; nothing is swallowed. It writes
  lines only for touches that start within the left fifth of their monitor.
- **gesture.ts:** a swipe goes down within the left 8% of the monitor's width and moves right at least 10% of it
  within 900 ms, with vertical drift at most 0.7 times the distance. It fires once per touch, before the finger lifts.
- **watcher.ts:** runs the script only while a game runs (the session events) and the setting is on; it is restarted
  up to three times, then given up on until the next game. With no touchscreen (`SM_DIGITIZER`), the hook is never
  installed.

Windows keeps the outermost strip of the screen for its own edge swipe (Widgets): a touch that starts there never
reaches the hook. On a 1920 px wide screen that strip is roughly the first 20–45 px, so the swipe starts a little way
in. Touches over PlayOut's own windows are handled by Chromium and do not reach the hook either.

## Overlay window behaviour

- It is created hidden at startup when the home button is on, so it opens without delay.
- **Open:**
  1. The native host is asked for the foreground window (handle, rectangle, process id, exe).
  2. That handle is kept, and the overlay takes that window's monitor.
  3. The overlay is shown, always on top at the 'screen-saver' level.
  4. Over an exclusive full-screen game it is shown without taking the foreground (`showInactive`, not focusable, kept
     off the taskbar): the game keeps it, so it does not minimize (Windows composes the overlay over it). The
     controller drives the overlay without focus (main reads the Home button, the overlay's renderer polls the pad
     without needing focus). A game that is not paused (pausing off, anti-cheat, competitive) still reads the pad then.
  5. Over anything else (windowed and borderless games, the desktop, Steam, PlayOut), the host's focus helper brings it
     to the foreground: an Alt tap, then `SetForegroundWindow`, so the program under it stops reading the pad and the
     keyboard works too.
- **Close** (home button again, B at the top level, or "Back to game"): the overlay hides. The saved window gets the
  foreground back only when the overlay took it.
- **Pause** (`input.homePauseGame`, on by default): once the overlay has the foreground, the saved window's process is
  suspended (`NtSuspendProcess`, native host `Pause`), so the game takes no input while the overlay is open. The shell, Steam, Game Bar, Winhanced and PlayOut itself are never
  paused (`NEVER_PAUSE` in `overlay-logic.ts`). Nothing is paused while an anti-cheat service runs (`ANTI_CHEAT`, the
  list Enhanced Sleep/Wake uses), or when the running programs cannot be read, or are not read within 2 s (`PAUSE_CHECK_MS`; the list is read while the
  overlay takes the foreground, and a slow one never keeps the overlay from closing): the overlay opens without pausing. A
  game Enhanced Sleep/Wake froze as well is suspended once for both (`pause-owners.ts`) and runs again when
  both have resumed it. The process id and start time go in `userData\overlay\paused.json`; the
  process is resumed on close, on quit, and at the next start after a crash, and only while its start time still
  matches, so a reused process id is never touched.
- **Exclusive full-screen games** keep the foreground and stay on screen under the overlay. A game in true exclusive
  mode (Spelunky 2 set to Fullscreen: any window over it, active or not, makes it drop out) loses it anyway and
  minimizes: 500 ms after opening the overlay looks, and if
  the game no longer has the foreground the overlay takes it (and only then pauses the game). The game is restored on
  close, also when it lost the foreground later. Borderless and windowed games stay as they are. A game the in-game
  overlay can be drawn inside gets that instead (see "In-game overlay").
- **Events** reach both windows: the event bus broadcasts to the main window and to the overlay.

## In-game overlay

A game in true exclusive full screen minimizes as soon as any window is over it, the overlay window too. For those
games PlayOut draws the overlay **inside the game** instead: a small DLL loaded into the game hooks its Direct3D 11 /
DXGI Present and draws frames that PlayOut renders offscreen. Every other game keeps the overlay window as above.
The wire contract is `ingame-helper/PROTOCOL.md` (authoritative); this is the overview.

- **When:** the home button opens the overlay over a game in exclusive full screen, `input.ingameOverlay` is on (the
  default) and the game is not in `input.ingameNever`. Phase 1 covers 64-bit Direct3D 11 / DXGI games only.
- **The gate** (`src/main/overlay/ingame/gate.ts`): never a game with anti-cheat, and anything not known counts as
  anti-cheat (the PeerParty rule). The game must be an installed PC game of the library with no anti-cheat known by
  its title, tags, folder or Steam's listing; a Steam game needs Steam's answer that it has no Valve Anti-Cheat
  (`steamTags.vac === false`). At the moment of the press no anti-cheat service may run, and the helper's `probe` of
  the process must find an x64, ordinary (not elevated, protected or AppContainer) Direct3D 11 / DXGI process with no
  anti-cheat driver loaded on the PC and no anti-cheat module in the game (the probe must have read the drivers, the
  processes and the game's modules: a source it could not read counts as anti-cheat). Tags that block are Free to
  Play, Competitive, eSports and MMO; a plain PvP tag (Filters > All Competitive) does not, as for PeerParty. The
  first press for a game waits up to 2 s (`SCAN_WAIT_MS`) for its folder scan, usually a few milliseconds.
- **Injection:** `PlayOutIngame64.exe inject` loads `PlayOutOverlay64.dll` into the game (`LoadLibraryW` on a remote
  thread). The DLL patches the swap chain's Present / ResizeBuffers / Present1 vtable entries and the game's XInput
  and DirectInput 8 reads, then connects to a named pipe PlayOut opened for that injection: it checks the pipe's
  server is PlayOut's main process and sends a one-time token first. PlayOut never unloads it; it goes dormant
  (hooks only call the originals) when the pipe goes away.
- **Frames:** a hidden offscreen BrowserWindow loads `index.html?overlay=1&ingame=1` at the game's back-buffer size
  (`frame-pump.ts`) and each paint goes down the pipe as the changed rectangle (BGRA, premultiplied alpha). The DLL
  alpha-blends the image over every frame of the game.
- **The page** (`src/renderer/src/overlay/ingame.ts`): the same overlay app, with these differences. It is never
  focused, so Chromium gives it no pads: main sends the controller reader's pads (buttons, sticks and triggers) as
  `overlay:pad` while it is open, and `input/gamepad.ts` reads them on a 16 ms timer instead of
  `navigator.getGamepads()`; the focus and visibility gates do not apply, and each open or close of the overlay
  forgets the pads, so the buttons still held then are not presses. The page background stays fully transparent and
  there is no backdrop blur (the panels are near-opaque instead). There is no local music player (the window
  overlay's page stays the one player; Windows' media controls still work). Anything that needs the desktop closes
  the overlay first: PlayOut, Quit game, the power helper's install or removal.
- **Pause the game** (`input.homePauseGame`): on, the DLL **holds** the game inside its Present (a frozen copy of its
  last frame with the overlay over it, window messages still handled so Windows never sees it as hung) until the
  overlay closes. Off, the game runs on under the overlay and only its controller input is blocked (XInput and
  DirectInput 8 read "nothing pressed") until every button is released after closing. The process is never
  suspended in this mode.
- **Fallback:** on any doubt (the gate says no, the helper is missing, the injection fails, the DLL does not answer
  or cannot draw on that swap chain) the overlay window opens as before, and the game may minimize.
- **Crash to Never:** a game that crashes (an NTSTATUS exit code) within 10 minutes of the injection, or whose hook
  faults, is added to `input.ingameNever` and the user is told. Settings › Controls › In-game overlay lists those
  games, each with **Remove** to allow it again.
- **Files:** `ingame-helper/` (the C++ helper exe, the DLL and `PROTOCOL.md`), `src/main/overlay/ingame/` (gate,
  helper runner, pipe server, frame pump, session), `src/main/native-host/pad-script.ts` (sticks and triggers in
  the pad lines), `src/renderer/src/overlay/ingame.ts` and `src/renderer/src/input/gamepad.ts` (the page side).
  The DLL and helper ship unsigned.

## Steam and Game Bar overrides

- **Steam:**
  1. Steam's "Guide button focuses Steam" is `Controller_CheckGuideButton` in the signed-in account's Steam config.
     "Enable the Steam Overlay while in-game" is `EnableGameOverlay` in that account's `localconfig.vdf`,
     `UserLocalConfigStore > system` (absent means on).
  2. When the home combo uses `guide` and `homeOverrideSteam` is on, PlayOut sets both to `"0"`, so a Guide press
     never brings up Steam's overlay over a game. Installs that changed only the Guide key (before 0.9.49) get the
     overlay key on the next pass.
  3. If Steam is running, PlayOut closes it first (`steam.exe -shutdown`, up to 30 s), writes the file (temp file,
     then rename, keeping its BOM), then starts it again with `steam.exe -silent`.
  4. The original values (per key) and the file's path are kept in `userData\home-button\overrides.json`, and are
     put back when the override (or the home button) is turned off; a key changed since in Steam is left alone.
- **Game Bar** (`homeOverrideGameBar`, whenever the home button is on, whatever the combo), all in HKCU:
  1. `HKCU\Software\Microsoft\GameBar` `UseNexusForGameBarEnabled` and `GamepadNexusChordEnabled` are set to 0.
  2. Game Bar's links `ms-gamebar` and `ms-gamingoverlay` (`HKCU\Software\Classes`) are pointed at `systray.exe`,
     which does nothing, so a program opening Game Bar itself (another launcher reading the Guide button, Win+G) gets
     nothing (`game-bar-links.ts`).
  3. The controller reader closes `GameBar.exe` whenever it still starts (`pad-script.ts`).

  The originals (values, and each link's key, command and `NoOpenWith`) are kept in `overrides.json` and put back
  exactly; a link someone changed since is left alone.

## Power profiles

- **Profiles:** Silent, Balanced, Performance and Custom.
- **What each profile sets:**
  - the Windows power mode (efficiency / balanced / performance);
  - the CPU maximum state, 5-100 % (`PROCTHROTTLEMAX`, on AC and on battery);
  - CPU boost on or off (`PERFBOOSTMODE`);
  - with the power helper, sustained and boost watts.
- **Per game:** `game.user.performance.profile`, applied at `session:started` while
  `settings.performance.perGame` is on (the default). With it off, or for a game without a profile of its own, the
  default profile is applied. At `session:ended`, a profile that was picked by hand before the game is put back;
  otherwise the default profile (as it is set then) is applied.
- **Defaults:** `settings.performance.defaultProfile` is used outside games. `'none'` leaves Windows as it is.
  `'auto'` (the factory default, and what an older saved `'none'` is migrated to by settings version 3) is Dynamic TDP
  when the power helper is ready and `'none'` otherwise, so PCs without the helper behave as before.
- **With the helper ready** (`service.ts` `resolve()`): `'auto'`, `'dynamic'` and the fallback profiles Silent, Balanced
  and Performance all apply as Dynamic TDP (each fallback logged once); `'custom'` and `'none'` as they are. This
  covers every path: the default outside games, a game's own profile, an overlay pick (`apply`), and what is put back
  at game end. A fallback picked for a game is saved as `'dynamic'`, and `PerformanceStatus.gameProfile` shows a saved
  fallback as `'dynamic'`. The saved choice stays as it was saved (`chosen`, with its source); only its effect follows the
  helper. Whenever the helper's readiness changes, either way, `reEffect` puts it in effect again as it applies now
  (`'auto'` as `'none'`, a fallback as itself, `'dynamic'` as Balanced without the helper; Dynamic TDP with it):
  `refresh`, the start follow-up, `installHelper`, `removeHelper`, "Set watts" on/off in Settings (the helper is read
  again first), `rtssHelper`'s re-check, and Dynamic TDP that finds no helper when a game starts.

### Dynamic TDP

- **When:** the power helper is "installed correctly": its files match this PlayOut version
  (`helperInstallState` 'installed'), it answers `info` with a watts method (`intel-msr` or `ryzen-smu`; not the
  ASUS firmware path, which has no helper to measure frames), its protocol is 2 or later, and "Set watts" is on.
  `PerformanceStatus.helper` is then `'ready'` ('outdated' / 'missing' / 'none' otherwise). A protocol-1 install
  (no `PresentMon.exe` in the helper folder, older `helper.ps1`) is 'outdated' (Update), not 'missing'.
- **UI with the helper ready:** the overlay, the overlay's Settings tab and Settings › System offer Dynamic TDP
  (first, the default), Custom watts (the Custom profile and its editor) and Off; the fallback profiles Silent,
  Balanced and Performance are never shown. A fallback profile saved before the helper (the default, or a game's own)
  or in effect shows, and runs, as Dynamic TDP (`shownChoice`, `effectiveDefaultProfile` in `overlay/text.ts`). "Use
  for <game>" with Off in effect saves Dynamic TDP with the helper (Balanced without). Without the helper
  the UI is unchanged, with the install note (or "Update power helper" for an outdated helper: one administrator
  prompt). Turning "Set watts" off and on re-applies the default (when it is in effect) or the active choice, never
  over Off picked by hand.
- **Frame rate:** the helper (SYSTEM, so ETW is allowed) runs its own copy of Intel's PresentMon console build
  (`main/performance/presentmon.ts`: v2.6.0, `PresentMon-2.6.0-x64.exe`, SHA-256 pinned). The install downloads it
  into the cache next to `helper.ps1`, the elevated install copies it into the admin-only helper folder as
  `PresentMon.exe`, and the helper checks the pinned hash with the file open deny-write before every start. Command
  line: `--output_stdout --no_console_stats --session_name PlayOutFps --stop_existing_session --no_track_gpu
--no_track_input --no_track_display` (every process is captured; the helper keeps the rows of the pids it was
  given). Pipe ops (protocol 2): `fpsStart {pids}`, `fps` -> `{fps, frameTimeMs, pid, frames, running}` over the last
  1.5 s (the pid with the most presents, ties by rate, with at least 5 of them: a launcher's or overlay's short
  burst never stands in for the game), `fpsStop`. The pipe never carries a path or arguments. PresentMon is
  stopped on `fpsStop`, when every watched pid exited, after 15 s without an `fps` request, at the idle restore and
  when the helper exits (a kill-on-close job object covers a crash; `logman stop PlayOutFps -ets` ends the ETW
  session a kill leaves behind). A PresentMon that keeps stopping (or failing to start) for the same pids is restarted
  after 5 s, then 15 s, then every 60 s, logged once; frames arriving or other pids start over.
- **Which process:** the launcher's tracked processes (`gameProcesses()`: the spawned tree, or the processes matched
  by image name / install folder for store launches), plus the spawned pid. They are looked up again every 5 s while
  no frames come and every 15 s while they do; without any, Dynamic TDP holds.
- **Controller** (`main/performance/dynamic.ts`, a pure step function; the loop is in `service.ts`, inside
  `serial()`): a tick every second during a game; the frame rate is smoothed (EMA, ~3 s). Below the target by more
  than the deadband (max(2 fps, 5 %)) it raises the sustained limit by up to 5 W in proportion to the shortfall; above
  it lowers 1 W. After a change it waits ~3 s. Plateau (a frame cap, v-sync or the GPU): climbing 6 W without
  max(1 fps, 2 % of the target) more frames goes back to where the climb started and remembers the plateau's frame
  rate; while it holds, the watts go down 1 W at a time as long as the frames stay at the plateau (a step that loses
  frames is undone and becomes the floor), so a 30 fps-capped game settles near the least watts that hold 30 fps. A
  retry climbs from there after a minute; each retry that gains nothing doubles the wait (at most 10 minutes). A new
  target, a climb that gains frames or the no-frames timeout forget the plateau. No frames: hold, then after 10 s the
  middle of the range. A failed write is retried on the next tick; a Dynamic TDP start that fails drops any earlier
  profile's watts from the 30 s re-apply. Always inside the PC's range and the optional floor and ceiling
  (`settings.performance.dynamic.minWatts / maxWatts`); boost = min(PC maximum, sustained + 5 W). Writes only on a
  change (ASUS firmware at most every 5 s); the 30 s re-apply writes the current value. At the session's end (and on
  dispose) it stops measuring and the helper puts the firmware's limits back. Outside games Dynamic TDP leaves the
  watts to Windows. The no-driver part stays neutral while it runs: balanced power mode, CPU maximum 100 %, boost on.
- **Target:** `settings.performance.dynamic.targetFps` (20-240, default 60); per game
  `game.user.performance = { profile: 'dynamic', targetFps }` ("Use for <game>"); an overlay pick without "Use for"
  changes the Settings target. `applyPowerProfile('dynamic', forGame, { targetFps })`.
- **Readout:** `PerformanceStatus.dynamic` (`targetFps`, `state`, smoothed `fps`, `frameTimeMs`, `watts`), sent with
  `performance:status` at most once a second and only when it changed; the overlay shows "58 fps · 14 W" and the
  header chip "Dynamic · 60 fps".

## Overlay extras

The Game group of quick tiles and the header's live chips (`src/main/overlay/extras.ts`,
`src/shared/overlay-extras.ts`). Status: `getOverlayExtras()` and the `overlay:extras` event (sent only when it
changed).

- **Live chips:** `getLiveStats()`, polled about once a second while the overlay is open.
  - FPS: the game's entry in RivaTuner Statistics Server's shared memory (`RTSSSharedMemoryV2`, matched to the game's
    pids, else RTSS's foreground app), else Dynamic TDP's PresentMon reading, else hidden. An entry whose frame window
    ended more than 2.5 s before the read (the snapshot carries GetTickCount, the clock of `dwTime1`) counts as not
    measured: a hung, paused or minimized game shows "—", not its last rate.
  - Watts: Dynamic TDP's set watts, else the power helper's reading, rounded. The helper is asked again at most every
    5 s, never on every poll. Hidden when the watts backend is not ready.
- **In-game check:**
  - **Performance overlay: passed** (2026-11-14, Spelunky 2, RTSS 7.3.7): PlayOut's text appeared in the game's
    top-left corner, updated each second, and the slot was released afterwards. Offered (`osdTile`,
    `RTSS_OSD_VERIFIED` in `src/shared/overlay-extras.ts`).
  - **Frame limit and Sync FPS + refresh: passed** (2026-11-15, TowerFall Ascension, RTSS 7.3.7): about 138 FPS
    uncapped, 30 with Limit=30, 43-45 with 45, about 135 again after ∞ removed the profile PlayOut had created. Each
    change took effect within about 2 s of PlayOut's profile reload (`native.rtssRequestProfileUpdate`). Offered
    (`rtssTiles`, `RTSS_TILES_VERIFIED`). Spelunky 2 could not be used for this: it stops drawing when it is not in
    front, and RTSS does not hook Chromium/Electron windows.
- **Frame rate limit** (∞, 30, 40, 45, 60, 72, 90, 120 and the display's rate):
  - Written by the power helper (SYSTEM, protocol 3, op `rtssLimit`) into RTSS's own profile of the game's exe,
    `Profiles\<exe>.cfg` `[Framerate] Limit=N` and `LimitDenominator=1` (RTSS reads the cap as Limit /
    LimitDenominator, inherited from Global: a fractional 59.94 = 5994/100 would otherwise turn 60 into 0.6 FPS). The
    Global profile is never written (Winhanced owns it). PlayOut then asks RTSS to reload its profiles from the user
    process (the flag `UpdateProfiles` sets in the shared memory).
  - ∞ puts back what the file held before PlayOut (or deletes a file PlayOut created), Limit and LimitDenominator both.
  - The helper writes only when RTSS's install folder and its Profiles folder are real folders (not junctions) owned
    by Administrators, SYSTEM or TrustedInstaller; RTSS installed into a folder users can change is refused. A profile
    that is a link (junction, symlink or hard link) is never written through.
  - The target is the exe RTSS hooked for the game's processes (the entry drawing frames first, so a hooked launcher
    does not win), else the exe the game's limit was written to before, else the game's spawned process. Programs
    PlayOut did not start: the program the overlay opened over, never Windows' shell, Steam, PlayOut, Winhanced or
    another program that is never paused (`isShellProgram`).
  - Remembered per game in `userData\overlay\game-extras.json` (`{ frameLimit, exe }`; other programs under
    `exe:<name>`). Limits stay in the game's profile after it exits, by design, and are put on again when it starts
    (repairing drift). When the game's exe turns out to be another one, the limit moves to it.
  - The helper also writes `PlayOut.exe.cfg` with `[Hooking] EnableHooking=0` once, so RTSS never hooks the overlay.
  - Every change is recorded in the helper's `rtss-limits.json` (the original text, Limit and LimitDenominator, and
    for the hooking exclusion its old value). **Removing the power helper** first asks it to put every recorded profile
    back (op `rtssRestore`), then forgets the frame limits and sync records. If that could not be done, the removal
    keeps `rtss-limits.json` in the admin-only `ProgramData\PlayOut` folder and a helper installed later takes it
    back when it starts, so a re-applied limit is never recorded as the "original".
- **Sync FPS + refresh** (`settings.performance.syncFpsToRefresh`, global): while on, the limit of a running PlayOut
  game is the display's current rate (never a program PlayOut did not start). It is applied when it is turned on,
  after a refresh-rate change from the overlay, and when a game starts. It never overwrites a game's own choice. Every
  exe a sync limit was written to is kept in `game-extras.json` (`$synced`); turning sync off (with or without a
  game running, and at the next start or once the helper answers when it could not then) puts each one back to its
  game's own choice or to what was there. Picking a limit by hand turns it off. It can be turned on before a game runs.
- **At game start** (limit and sync): RTSS hooks a game about 15 s after it starts. The hooked exe is looked for every
  5 s for up to 60 s, then the process name is used; after that the session is still watched every 10 s, so a game
  RTSS hooks after its launcher (or after a long login or shader compile) gets the limit, which moves off the earlier
  exe.
- **Performance overlay** (`settings.performance.perfOverlay`, global): Off, Level 1 (FPS), Level 2 (FPS, frame
  time, CPU %, GPU %, watts), Level 3 (Level 2 plus RAM, battery and time). No temperatures. Drawn by RTSS from an OSD
  slot owned by "PlayOut", written once a second from the main process while a PlayOut game runs (also with the
  overlay closed). Over a game PlayOut did not start the tile says "Only for games started from PlayOut". The slot is
  released at Off, when the game ends, when PlayOut quits and when it starts (a slot a crashed PlayOut left keeps its
  last text drawn in every hooked app). Freeing the slot does not wait for RTSS's busy lock (the SDK's ReleaseOSD
  does the same: the whole entry is zeroed); a release that still did not go through is tried again (3 tries 50 ms
  apart, then every 5 s, up to 12 times). A write that found the lock busy may already hold a slot, so it is
  released too.
- **Auto HDR:** the `AutoHDREnable` token of `HKCU\Software\Microsoft\DirectX\UserGpuPreferences`
  `DirectXUserGlobalSettings` (1/0); the other tokens and every per-program value stay as they are. The value counts
  as absent only on reg.exe's "unable to find" answer, or when a listing of the key works and lacks it (another
  language); a timeout, a failed start or any other error writes nothing. Applies to games
  started next. Unavailable while Windows HDR is off for the overlay's display (DisplayConfig advanced colour info).
- **CPU boost:** the profile in effect. Custom: its own `cpuBoost`. A built-in preset:
  `settings.performance.boostOverrides[preset]`, which the performance service applies on top of the preset
  (powercfg PERFBOOSTMODE 2/0, restored through `before.json` like every profile setting); choosing the preset's own
  value again removes the override. Unavailable while Dynamic TDP is in effect ("Managed by Dynamic TDP") or no
  profile is ("Choose a power profile first").
- **Endurance Gaming** (Intel graphics only; `src/main/intel/`): the driver's global setting through the Intel
  Graphics Control Library (`ControlLib.dll`, P/Invoke in its own lazily started PowerShell worker, never the native
  host). Options are the driver's own (on the probed Arc B390: Off, or Auto with better performance / balanced /
  maximum battery; On is not listed). A write is read back. `getIntelGraphics()` / `setEnduranceGaming(key)`; the
  tile hides on PCs without the Intel driver or adapter (`absent`). The XeSS frame generation override is not
  offered: the probed driver lists it with no values. Only global values are read or written, never per-program ones.
- **Winhanced:** while it runs, the tiles say that it also controls RivaTuner (PlayOut changes only each game's own
  profile).
- **Needs:** the frame limit and sync need RTSS installed and running and the power helper at protocol 3 (it exists
  only on PCs with an Intel MSR or Ryzen SMU watts method; elsewhere the tile says "Not available on this PC"). The
  performance overlay and the FPS chip need RTSS running. Live fps reads "—" until RTSS hooks the game, and for titles
  it cannot hook.
- **Overlay side:** a Game group whose status could not be read says "Could not read the game settings" and asks
  again every 3 s while it shows. A live reading that answers after the overlay closed is dropped, and a poll is
  skipped while the previous one is in flight. A drawer closes when its tile becomes unavailable.

## Friends

The Friends tab (`src/renderer/src/overlay/FriendsTab.tsx`, `src/main/friends/steam-friends.ts`,
`src/shared/friends.ts`). Decisions (the user's answers of 2026-11-25): the friends come from the user's **Steam**
friends list; messaging opens **Steam's own chat**; no Discord, no chat inside the overlay, no Steam sign-in.

- **Rail:** a Users icon, last of the top group (after Downloads), so the tabs above keep their places and LB / RB
  steps; Settings and Power stay at the bottom.
- **Data:** the Steam Web API key and SteamID64 of Settings › Metadata (`settings.scrapers.steam`, the ones
  achievements use). `ISteamUser/GetFriendList/v1` (`relationship=friend`) lists the friends, then
  `ISteamUser/GetPlayerSummaries/v2` describes them, 100 ids per call (`SUMMARY_BATCH`), through the Steam Web API rate
  limiter. Per friend: name, `avatarmedium` (kept only when https on Steam's CDN: `steamstatic.com`,
  `steamcommunity.com`, `steampowered.com`, `akamaihd.net`), `personastate` (0 Offline, 1 Online, 2 Busy, 3 Away,
  4 Snooze, 5 Looking to trade, 6 Looking to play; anything else counts as Offline), `gameextrainfo` / `gameid` (only
  while online; "In a game" when Steam gives an id without a name) and `lastlogoff`.
- **When:** only while the Friends tab is shown in an open overlay: on open, then every 60 s (`FRIENDS_POLL_MS`,
  `overlay/friendsStore.ts` `watch()`, stopped when the tab unmounts, which closing the overlay does). Main keeps the
  last answer 30 s (`FRIENDS_CACHE_MS`), so switching tabs is instant; **Refresh** asks past it. Calls made while one
  runs share it. Nothing polls in the background. The renderer keeps its last answer while the tab is closed and shows
  it at once on the next open, then the fresh one.
- **Errors** (`getSteamFriends` never rejects; `error.code` / `error.message`): no key or SteamID64
  (`no-credentials`, "Add your Steam Web API key and SteamID64 in Settings › Metadata"; Steam is not asked), 401
  (`private`: the friends list is not public), 403 (`key-refused`), anything else (`network`, "Could not reach
  Steam"). On a network error the friends read before stay, under the message. Errors are logged by HTTP status only;
  the key and the URLs that carry it are never logged.
- **Tab:** "Updated n s ago" and Refresh; then one list with three headed sections and their counts: **Playing**
  (picture, name, game; by name), **Online** (picture, name, status word; by name) and **Offline** (picture, name,
  "Last online 3 h ago"; most recent first). Offline is folded behind "Show offline friends (n)" unless nobody is
  online, and drawn 50 rows at a time ("Show 50 more"), so a list of 200+ friends stays light; pictures load lazily.
  The sections share one parent, so a friend starting a game keeps their row (and the focus). Loading, empty ("No
  Steam friends") and error states.
- **Message:** each friend is one focusable row; A (or a click) messages them, and a "Message" hint shows on the
  focused row. `messageSteamFriend(steamId)` accepts a SteamID64 only (17 digits, checked in the handler and the
  service); main builds `steam://friends/message/<id>` itself and nothing else is ever opened. The overlay closes first
  (`OverlaySuite.closeForOutsideWindow`: the game is resumed and the foreground is not handed back to it, so Steam's
  window can come to the front), in both the window overlay and the in-game overlay. **Steam's chat opens in Steam's
  own window**: over a game in exclusive full screen it may make the game minimize.
- **Mock:** `src/renderer/src/api/mock/friends.ts` (friends in a game, online, busy, away, snooze, looking to play
  and offline); `friends=empty|private|nokey` in the query shows the other states.

## PeerParty

The PeerParty tab (`src/renderer/src/overlay/PeerPartyTab.tsx`, `peerPartyStore.ts`, `peerparty.ts`;
`src/main/peerparty/overlay.ts`; the helper's `peerparty-invite`, `ingame-helper/PROTOCOL.md`). The user's request of
2026-11-25: while PeerParty's connection is active in a game, the overlay shows a PeerParty version of Friends
(seeing and inviting the other players on the LAN) instead of the Steam Friends tab.

- **When it shows:** while a game PlayOut started through PeerParty runs (`PeerPartyService.session()`, followed in
  the overlay through 'peerparty:session' and asked again at each open) and the overlay is over that game: the same
  game id, or the same program when the overlay knows only the program, or any PeerParty game when the overlay is
  over nothing in particular (`peerPartyForOverlay`, `src/shared/peerparty.ts`, used by main and the renderer alike).
  The rail entry (lucide Network icon) then stands in Friends' place (`railTabs`), LB / RB step through it instead,
  and neither the Steam Friends tab nor its Steam polling runs. When the session starts or ends with the overlay open,
  a user on one of the two tabs is moved to the other (`tabForRail`), with the focus on its rail entry. PeerParty is
  never used for games with anti-cheat (section 4.2 of USER-GUIDE.md, `peerparty/eligibility.ts`); nothing here
  changes that.
- **What PeerParty lets another program see:** it has **no public list of players**. Its own overlay talks to the
  game over a private pipe, so player names, and invites to one player, are out of reach: PlayOut does not read that
  pipe, inject anything, read the game's environment or join PeerParty's LAN mesh or beacons. What can be read,
  read-only, is its **peer board** (PeerParty `core/src/mesh.rs`, `Board`), in PlayOut's portable PeerParty folder
  (`%APPDATA%\PlayOut\PeerParty\peerparty-data\peers`): each copy of PeerParty's LAN engine keeps
  `<peer id>.<game tag>.peer` (three lines: the game key, the discovery port, the TCP port; the tag is the first 6
  bytes of the key's SHA-256, as hex) open while it runs, sharing it for reading only, and `<id>.<tag>.heard` lists
  the players that copy heard from other PCs ("id ip port", kept 5 s).
- **Status:** "LAN play is on" while a `.peer` file is held (an open for writing fails with a sharing violation; the
  handle is closed at once and nothing is written), "Starting…" for 90 s after the start (`LAN_STARTING_MS`) while
  none is, else "LAN play is off" (LAN discovery turned off in PeerParty, or the game never started its network).
  "Players of this game on your network: N": the distinct ids of the live copies of the game with the most copies on
  this PC and of the players they heard, so N includes this PC's player. The addresses are never read out or shown.
  The format is PeerParty's own, not a promise: a held file that does not read as expected (a tag that is not its
  game's, an odd `.heard` line) shows no count rather than an error.
- **Invite everyone on the LAN:** `peerPartyInvite()` runs `PlayOutIngame64.exe peerparty-invite`, which does exactly
  what PeerParty's own Invite button does: clear `Local\peerparty.invite.ack`, set `Local\peerparty.invite.last`, wait
  up to 1.5 s for the ack, clear both. The hooked game that was last in front (recorded in PeerParty's shared mapping
  `Local\peerparty.front`) answers even while PlayOut's overlay has the focus. The native helper is used because Node
  cannot set a Win32 event; it was rebuilt with `node scripts/build-ingame-helper.mjs`. With **Pause the game** on,
  the game is suspended under the overlay and could not answer: the invite lets it run for that moment
  (`OverlaySuite.whileGameRuns` / `OverlayWindow.whileRunning`) and pauses it again while the overlay stays open.
  The tab says "Invite sent" (a game answered), "No PeerParty game took the invite" or the error. One invite at a
  time; a second press shares the first.
- **When it reads:** `peerPartyOverlay()` only while the tab is open: on open, then every 5 s (`PEERPARTY_POLL_MS`).
- **Not possible yet:** player names and invites to one player need a newer PeerParty that shares its list of players;
  the tab says so.
- **Mock:** `src/renderer/src/api/mock/peerparty.ts`; `?mock=1&overlay=1&peerparty=1` runs the overlay's game through
  PeerParty with LAN play on and 2 players; without it the Friends tab shows.

## Media

- **What is playing:** the SMTC session manager in the native host. Commands are play/pause, next and previous. The
  overlay reads it when it opens, and every 2 s while open.
- **Local music:**
  - The folder is `settings.music.folder`; the formats are mp3, m4a, aac, flac, ogg, opus and wav.
  - Files are served through `playout-music://track/<relative path>`, only from inside that folder, with byte ranges.
  - The player runs in the overlay's renderer, which stays alive while hidden, so music keeps playing.
  - Per-game playlist: `game.user.playlist` (paths relative to the music folder).
  - `settings.music.gameStart`: `keep` (default), `play` (play the game's playlist) or `load` (load it paused).
