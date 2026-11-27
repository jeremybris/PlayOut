# PlayOut in-game overlay: protocol

PlayOut's in-game overlay draws PlayOut's overlay **inside** a game that runs in true exclusive full screen (a window
over such a game makes it minimize). Three parts:

- **PlayOut main** (TypeScript, `src/main/overlay/ingame/`): decides when (the gate: never a game with anti-cheat),
  renders the overlay offscreen, owns the named-pipe server.
- **`PlayOutIngame64.exe`** (C++, this folder): `probe`, `inject`, `watch` a game process. Never runs inside the game.
- **`PlayOutOverlay64.dll`** (C++, this folder): loaded into the game by `inject`; hooks the swap chain's Present and
  the game's controller input, draws the frames PlayOut sends, holds the game while paused.

Phase 1 covers **x64 Direct3D 11 / DXGI** games only. Anything else is refused and PlayOut uses its window overlay.

`src/main/overlay/ingame/protocol.ts` and `hook/protocol.h` hold the same constants; a test keeps them in sync.

## 1. Helper exe (`PlayOutIngame64.exe`)

Every command prints exactly **one JSON line** on stdout and exits 0 when it did its job (even when the answer is
"no"), non-zero only on a usage error or a crash.

### `probe --pid <pid>`

```json
{
  "ok": true,
  "pid": 1234,
  "arch": "x64",
  "elevated": false,
  "protected": false,
  "appContainer": false,
  "antiCheat": [],
  "graphics": ["d3d11", "dxgi"],
  "injected": false,
  "exe": "C:\\...\\Spel2.exe"
}
```

- `arch`: `"x64"`, `"x86"` or `"arm64"` (IsWow64Process2).
- `elevated`: the target runs at a higher integrity level than the helper (it then cannot be opened).
- `protected`: protected process (PPL) or the helper could not open it with the rights `inject` needs.
- `appContainer`: AppContainer / UWP (also true for an exe under `WindowsApps`).
- `antiCheat`: names of anti-cheat **kernel drivers loaded on the system** (EnumDeviceDrivers, and the running
  kernel-driver services with their image files, since Windows 11 24H2 hides driver addresses from non-admin
  processes), anti-cheat **programs running on the system** (the `processes` list) and anti-cheat **modules loaded in
  the target** (EnumProcessModulesEx), from `common/anticheat_names.json` (`anticheat_names.h` is generated from it).
  `"unknown"` when the target's modules could not be listed. Any entry = never inject.
- `checked` (extension): `{"drivers":245,"processes":140,"modules":68}`, how many names each anti-cheat source gave
  (0 drivers: that source was unreadable). `helper` (extension): the helper's version.
- `graphics`: which of `d3d9`, `d3d10`, `d3d11`, `d3d12`, `dxgi`, `vulkan`, `opengl` are loaded in the target
  (`d3d9.dll`, `d3d10*.dll`, `d3d11.dll`, `d3d12.dll`, `dxgi.dll`, `vulkan-1.dll`, `opengl32.dll`).
- `injected`: `PlayOutOverlay64.dll` is already loaded in the target.
- On failure: `{"ok":false,"pid":1234,"error":"<one sentence>","step":"open"}`.

### `inject --pid <pid> --dll <absolute path> --pipe <pipe name> --token <64 hex> --playout-pid <pid>`

1. Runs every `probe` check again and refuses (`ok:false`, `step:"check"`) unless: `arch` is `x64`, not elevated,
   not protected, not AppContainer, `antiCheat` is empty, `d3d11` or `dxgi` is loaded.
2. Creates the **config mapping** (section 3) named `Local\PlayOutIngame-<pid>`, then
   `VirtualAllocEx` + `WriteProcessMemory` + `CreateRemoteThread(LoadLibraryW)`, waits up to 5 s for the thread.
   The helper keeps the mapping open until the DLL has read it: it waits (up to 10 s) for the DLL to set
   `ConfigMapping.consumed` to 1, then exits.
3. Prints `{"ok":true,"pid":1234,"step":"done"}` or `{"ok":false,"pid":1234,"error":"...","step":"..."}`
   (`step`: `check`, `mapping`, `alloc`, `thread`, `load`, `consume`).
   An already-injected target answers `{"ok":true,"pid":1234,"step":"already"}` (the DLL picks up the new mapping:
   section 4, "Reconnect").

### `watch --pid <pid>`

Waits for the process to end, prints `{"pid":1234,"exitCode":3221225477}` and exits 0. PlayOut uses the exit code to
spot a crash after an injection (an NTSTATUS exception code such as `0xC0000005`).

### `peerparty-invite`

Not part of the in-game overlay: the overlay's PeerParty tab (docs/home-overlay.md, "PeerParty") uses it, because
Node cannot set a Win32 named event. It takes no arguments and touches no process. It does what PeerParty's own
Invite button does (PeerParty `launcher/src/backend/windows/invite.rs`, `signal_named`): opens (or creates) the
manual-reset events `Local\peerparty.invite.last` and `Local\peerparty.invite.ack`, clears the ack, sets the invite
event, waits up to 1.5 s for the ack, then clears both. The PeerParty-hooked game that was last in front (its process id
is in the shared mapping `Local\peerparty.front`) answers it and invites every player of the game on the LAN.

Prints `{"ok":true,"taken":true}` (a game took it), `{"ok":true,"taken":false}` (none answered) or
`{"ok":false,"error":"...","step":"event"}` (the events could not be opened), and exits 0. Any argument is a usage
error.

## 2. Named pipe

- PlayOut main creates the server, named `\\.\pipe\PlayOut-ingame-<32 random hex>`, one per injection, accepting one
  client. It is a Node `net` server, so the server process is PlayOut's main process (`process.pid`).
- The DLL connects as a client and **must** check `GetNamedPipeServerProcessId(pipe) == playoutPid` (from the config
  mapping) before sending anything; otherwise it disconnects and stays dormant.
- The first message from the DLL is `HELLO`, carrying the token from the config mapping. PlayOut drops a connection
  whose first message is not a `HELLO` with the right token, protocol version and game pid.

### Framing

Every message: an **8-byte header**, little-endian, then the payload.

| offset | type  | field                      |
| ------ | ----- | -------------------------- |
| 0      | `u32` | message type (table below) |
| 4      | `u32` | payload length in bytes    |

Control payloads are **UTF-8 JSON objects** (an empty payload means `{}`). `FRAME` is binary. Payload length is at most
`64 MiB`; a larger length is a protocol error (the reader disconnects).

### DLL → PlayOut

| type | name          | payload                                                                                                                                                                                                                                                                                                                                                                                               |
| ---- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `HELLO`       | `{"proto":1,"dll":"0.1.0","pid":1234,"token":"<64 hex>","api":"d3d11","width":1920,"height":1080,"format":87,"exclusive":true,"hwnd":"5243086"}` — sent once connected. `width`/`height`/`format` (DXGI_FORMAT) are the back buffer of the swap chain last presented; 0 when none presented yet. `exclusive` = `GetFullscreenState` of that swap chain. `hwnd` = its `OutputWindow` (decimal string). |
| 2    | `RESIZE`      | `{"width":..,"height":..,"format":..,"exclusive":true}` — after ResizeBuffers, or when the presented swap chain changes.                                                                                                                                                                                                                                                                              |
| 3    | `PRESENTING`  | `{"held":false}` — the first Present that drew the overlay after `SHOW` (`held` true when it is the hold loop).                                                                                                                                                                                                                                                                                       |
| 4    | `FAULT`       | `{"where":"present","code":3221225477}` — a hook faulted; the DLL has disabled itself (hooks only call the originals from now on).                                                                                                                                                                                                                                                                    |
| 5    | `LOG`         | `{"level":"info","message":"..."}` — for PlayOut's log.                                                                                                                                                                                                                                                                                                                                               |
| 6    | `PONG`        | `{}` — answer to `PING`.                                                                                                                                                                                                                                                                                                                                                                              |
| 7    | `UNSUPPORTED` | `{"reason":"format"}` — cannot draw on this swap chain (`format`: not 8-bit RGBA/BGRA; `not-exclusive`; `no-swapchain`: nothing presented within 1 s of `SHOW`; `device`: the device could not create its resources).                                                                                                                                                                                 |
| 8    | `HIDDEN`      | `{}` — after `HIDE`: the overlay is no longer drawn and any hold has ended.                                                                                                                                                                                                                                                                                                                           |

### PlayOut → DLL

| type | name            | payload                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 101  | `SHOW`          | `{"hold":true}` — start drawing the overlay on every Present of the target swap chain. `hold:true` (Pause the game on): at the next Present, snapshot the back buffer and stay inside Present (the **hold loop**, section 5) until `HIDE`. `hold:false`: the game runs on under the overlay. Both block the game's controller input (section 6). Optional, **test only**: `"anyMode":true` also draws on a swap chain that is not in exclusive full screen (instead of `UNSUPPORTED not-exclusive`); `scripts/ingame-harness.mjs` uses it for its windowed run. PlayOut never sends it. |
| 102  | `HIDE`          | `{}` — stop drawing; end the hold. Input stays blocked until `INPUT_RELEASE`. Answered with `HIDDEN`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 103  | `FRAME`         | binary, below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 104  | `PING`          | `{}` — every 500 ms while connected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 105  | `INPUT_RELEASE` | `{}` — every button is up: the game reads the controller again.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 106  | `DETACH`        | `{}` — go dormant (hooks only call the originals) and close the pipe.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

`FRAME` payload (little-endian):

| offset | type  | field                                                                                |
| ------ | ----- | ------------------------------------------------------------------------------------ |
| 0      | `u32` | `x` of the changed rectangle                                                         |
| 4      | `u32` | `y`                                                                                  |
| 8      | `u32` | `w`                                                                                  |
| 12     | `u32` | `h`                                                                                  |
| 16     | `u32` | `fullWidth` — size of the whole overlay image                                        |
| 20     | `u32` | `fullHeight`                                                                         |
| 24     | bytes | `w * h * 4` bytes, BGRA, rows top to bottom, tightly packed, **premultiplied alpha** |

The DLL keeps a CPU copy of the whole overlay image (`fullWidth` x `fullHeight`, transparent at first); a frame whose
full size differs from the copy's resets it to transparent at the new size first. The image is drawn stretched over
the whole back buffer (PlayOut renders it at the back buffer's size, so normally 1:1).

## 3. Config mapping

Named `Local\PlayOutIngame-<game pid>`, created by `inject`, `sizeof(ConfigMapping)` bytes, little-endian:

```c
struct ConfigMapping {          // pack(4)
  uint32_t magic;              // 0x43494F50 'POIC'
  uint32_t version;            // 1
  uint32_t playoutPid;         // PlayOut main's pid: the only allowed pipe server
  uint32_t consumed;           // 0; the DLL sets 1 (InterlockedExchange) once it has copied the mapping
  wchar_t  pipe[256];          // "\\.\pipe\PlayOut-ingame-<hex>", NUL-terminated
  char     token[68];          // 64 hex characters, NUL-terminated
};
```

## 4. DLL lifetime

- `DllMain(PROCESS_ATTACH)` only starts a worker thread (and `DisableThreadLibraryCalls`). `PROCESS_DETACH` does
  nothing when the process is ending. PlayOut never calls `FreeLibrary`; the DLL stays until the game exits.
- The worker reads the config mapping (and sets `consumed`), finds the vtables with a dummy device and swap chain on a
  **message-only** window it creates (never the game's window), patches the vtable entries (section 7), then connects.
- **Dormant**: on pipe loss, a `DETACH`, a missed heartbeat (no `PING` for 2 s) or a fault, the DLL stops drawing,
  ends any hold, unblocks input and its hooks only call the originals.
- **Reconnect**: when dormant (not faulted) the worker checks the config mapping again every 500 ms; a mapping with a
  different token (a later `inject` for the same game) makes it connect to the new pipe and send `HELLO` again.
  Every session starts with a transparent overlay image (nothing from an earlier session is drawn before its first
  `FRAME`).

## 5. Hold loop (Pause the game)

On `SHOW {"hold":true}`, at the next Present of the target swap chain the DLL copies back buffer 0 to a snapshot
texture, then loops on the game's render thread, inside the Present hook:

1. copy the snapshot to the back buffer, apply pending `FRAME` updates, draw the overlay;
2. call the original Present with SyncInterval 1;
3. drop the keyboard, mouse and `WM_INPUT` messages of the thread's windows, and let other messages be handled
   (`PeekMessage(PM_REMOVE)` + `DispatchMessage` for everything else), so Windows never sees the game as hung.

It leaves the loop (and returns the last Present result to the game) on `HIDE`, pipe loss, a missed heartbeat
(2 s), a fault, or an original Present that returns anything but `S_OK` / `DXGI_STATUS_OCCLUDED`.

## 6. Input blocking

From `SHOW` until `INPUT_RELEASE` (and while held) the game's controller reads return "connected, nothing pressed":
`XInputGetState`, `XInputGetStateEx` (ordinal 100) of `xinput1_3.dll`, `xinput1_4.dll`, `xinput9_1_0.dll` (the
game's imports), and `IDirectInputDevice8W/A::GetDeviceState` / `GetDeviceData` (zeroed state, no buffered data).
Keyboard and mouse are blocked only inside the hold loop (section 5).

## 7. Hooks without a detour library

- Present (vtable index 8), ResizeBuffers (13) of `IDXGISwapChain`, Present1 (22) of `IDXGISwapChain1`: the vtable of
  the dummy swap chain is the one every swap chain of that DXGI implementation uses; its entries are patched
  (`VirtualProtect` + interlocked write) to the DLL's functions, which call the saved originals.
- XInput: the game module's **import address table** entries for the functions above (every loaded module whose IAT
  imports them, except system DLLs).
- DirectInput8: the vtable entries of `IDirectInputDevice8W` and `...8A` (GetDeviceState 9, GetDeviceData 10) from a
  dummy device created with `DirectInput8Create`.
- Every hook body runs inside `__try/__except`; the first exception disables the DLL (originals only) and sends
  `FAULT`.
