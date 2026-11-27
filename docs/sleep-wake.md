# Enhanced Sleep/Wake

Settings › System › Startup and power › **Enhanced Sleep/Wake** (`settings.system.enhancedSleepWake`, on by default).
Ported from Winhanced's "Enhanced sleep/wake" (Winhanced-Decompiled-20261112: `MA/Services/SleepCoordinator.cs`,
`MA/Util/Power/*`), conservatively: Winhanced's method bodies are stripped and its strings encrypted, so only what
could be read, and is safe, was ported. Code: `src/main/sleep/`.

## The game (`service.ts`)

- While a game PlayOut started runs, the program in front is noted every 4 s when it is **full screen** (borderless or
  exclusive: `fullscreen` or `exclusive` from `native.foreground`), so a chat or browser window is never taken for the
  game; the overlay's `overlayTarget` and `pausable` also rule out the shell, Steam, Game Bar, Winhanced and PlayOut.
  A game played in a window is not frozen.
- **Sleep** (`powerMonitor` 'suspend') and **lock** ('lock-screen') freeze it with `NtSuspendProcess` (the native
  host's `pauseProcess`). On Modern Standby PCs the power button locks the screen and turns the display off before
  Windows reports sleep, and the lock screen is then in front: the game last noted is frozen.
- Never frozen while an anti-cheat service runs (`ANTI_CHEAT`: EasyAntiCheat, BattlEye, Vanguard, FACEIT, EA
  AntiCheat, PunkBuster, XIGNCODE, GameGuard, Ricochet), nor when the process list cannot be read (fail closed):
  suspending a protected game can get it flagged.
- A freeze the native host did not answer (it may have happened all the same) is kept with start time 0, so the wake
  resumes it; only a refusal ('access', 'gone') drops it.
- **Wake** ('resume') or **unlock** ('unlock-screen'): once `powerMonitor.getSystemIdleState` is no longer 'locked',
  the game runs again after 2 s (drivers, audio and the desktop settle). The thaw is scheduled even when no freeze
  has finished yet: one still running when the PC woke is queued before it. A freeze that has not reached the suspend
  when the PC is awake and unlocked again (its checks outlasted the sleep) is dropped. A resume the native host does
  not answer is retried 10 times 2 s apart, then every 30 s (`THAW_SLOW_MS`) until it settles or PlayOut quits; the
  record and `frozen.json` are kept meanwhile, so the next start can still repair it.
- A game the home overlay paused as well is suspended once for both (`src/main/overlay/pause-owners.ts`): it runs
  again when both the overlay and Enhanced Sleep/Wake have resumed it, in either order.
- Freeze and thaw have their own queue, separate from the Windows changes (whose elevation prompt can wait a long
  time).
- The frozen process (pid and start time) is kept in `userData\sleep\frozen.json`: a crash or forced quit is
  repaired at the next start, and only that very process is resumed. Quitting PlayOut resumes it first, waiting at
  most 5 s.
- PlayOut's own wake recovery already runs on every wake (index.ts): the controller reader restarts, the power limits
  are written again, polling and streaming resume.

## Windows changes (`wake-sources.ts`)

One elevated PowerShell step (`run.ts` `runElevated`, hidden), 20 s after start-up while the setting is on (or right
when it is turned on), records in `userData\sleep\wake-sources.json` only what it changed:

- **Wake sources**: `powercfg -devicequery wake_armed`, then `powercfg -devicedisablewake` only for devices whose
  Plug and Play class is `Net` or `Biometric` (network adapters, fingerprint readers), looked up with
  `Get-PnpDevice -FriendlyName` (powercfg's " (001)" suffix for same-named devices removed) and only when every device
  of that name is of that class. Keyboards, mice, controllers, USB hubs, the power button and the lid keep waking the
  PC.
- **Sleep pauses everything** (active plan, AC and DC, `powercfg /qh` reads hidden settings too; each set only where
  it differs, see `POWER_RULES`):
  - Networking connectivity in Standby (SUB_NONE `fea3413e-…` / `f15576e8-…`) → 0 Disable: Modern Standby becomes
    "disconnected standby", so mail, sync, updates, notifications and apps stop working in the background, and the
    network cannot wake the PC. Absent on S3 PCs (nothing changed there).
  - Allow wake timers (SUB_SLEEP / `bd3b718a-…`) → 0 Disable: scheduled tasks and updates cannot wake the PC.
  - Allow Away Mode Policy (SUB_SLEEP / `25dfa149-…`) → 0 No: an app cannot keep the PC running behind a dark screen.
  - Automatic maintenance `WakeUp` (`HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Schedule\Maintenance`) → 0,
    where it is set to anything else.
- **Hibernate after 48 hours of sleep**: hibernation is switched on (`powercfg /hibernate on`) when it is off and the
  system drive has room for the hibernation file (40 % of the memory, plus 10 GB free). Then HIBERNATEIDLE (SUB_SLEEP
  `238c9fa8-…` / `9d7815a6-…`) on the active plan, AC and DC, is set to 172800 s only where it is 0 (never) or later.

The ledger (`WakeSourceLedger`): `devices`, `power` (each setting with the values found and PlayOut's value),
`hibernation` (PlayOut switched it on), `maintenanceWake` (the value found). 0.1.98's `hibernate` entry is read as a
`power` entry.

State (`userData\sleep\state.json`): `version` (`APPLY_VERSION`; a PC where an older step ran is asked once more, for
what it lacked, and the earlier ledger is merged in), `applied` (not asked again at the next start), `declined` (the UAC prompt was
declined: not asked again until the setting is turned on again). A run that finds an earlier ledger (a run cut short,
or its state lost) merges it back in afterwards: the new run no longer sees those devices as armed, and the earlier
hibernate record holds the original values.

Turning the setting off runs the elevated revert, built from the ledger PlayOut read (the elevated script never reads
a file a user process could change): `powercfg -deviceenablewake` for each recorded device, each recorded setting put
back only while it is still PlayOut's value, maintenance wake put back while it is still 0, and hibernation switched
off when PlayOut switched it on. The ledger is then removed.

## Not ported (and why)

Winhanced's custom power plan (its settings are encrypted), disabling network adapters during sleep (needs a recovery
watchdog; disconnected standby turns the network off in sleep the way Windows intends), suspending every background
program (Windows' Desktop Activity Moderator already suspends desktop apps in Modern Standby; freezing system
processes can hang the PC), killing Gaming Services (breaks Xbox games), the sleep-learning
engine and its registry remediations (thresholds and targets unknowable), automatic re-sleep after an accidental wake
(a wrong guess sleeps the PC in use), and forced S3.
