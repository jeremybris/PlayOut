# PlayOut in-game overlay (native side)

PlayOut's overlay is a topmost window. Over a game in **true exclusive full screen** any window makes the game
minimize, so for those games PlayOut draws its overlay **inside** the game instead: `PlayOutOverlay64.dll` hooks the
game's DXGI `Present` and draws the frames PlayOut renders offscreen and sends over a named pipe. Every other game keeps
the window overlay. Phase 1: x64 Direct3D 11 / DXGI games only.

`PROTOCOL.md` is the contract between this folder and PlayOut (`src/main/overlay/ingame/`); read it first.

## What is here

| path                          | what                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `helper/main.cpp`             | `PlayOutIngame64.exe`: `probe`, `inject`, `watch` (one JSON line each). Runs beside PlayOut, never inside a game.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `hook/`                       | `PlayOutOverlay64.dll`: `dllmain.cpp` (starts the worker), `pipe.cpp` (config mapping, pipe sessions, watchdog, reconnect), `present.cpp` (Present / Present1 / ResizeBuffers hooks, target swap chain, hold loop), `renderer.cpp` (Direct3D 11 drawing), `input.cpp` (XInput import and DirectInput8 vtable hooks), `vtable.cpp` (pointer patching, dummy swap chain), `state.cpp` (shared state, FRAME, message queue), `overlay.hlsl` (compiled by fxc at build time), `protocol.h` (constants shared with `protocol.ts`). |
| `common/anticheat_names.json` | The anti-cheat drivers, modules and programs that block injection. **Edit this**, not the header: `anticheat_names.h` is generated from it by the build script. PlayOut's TypeScript side can read the JSON to test parity with its own lists.                                                                                                                                                                                                                                                                                |
| `common/names.h`              | Case-insensitive base-name matching (a trailing `*` matches a prefix).                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `testapp/main.cpp`            | `PlayOutIngameTest.exe`, a tiny D3D11 "game" for the harness. Never shipped.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## Build

```
node scripts/build-ingame-helper.mjs
```

Needs Visual Studio 2022 (the Build Tools are enough: MSVC v143 and a Windows 10/11 SDK), CMake and Ninja. The script
regenerates `common/anticheat_names.h`, configures and builds x64 Release in `ingame-helper/build` (static CRT, `/W4
/WX`, C++20) and copies `PlayOutIngame64.exe`, `PlayOutOverlay64.dll`, `LICENSES.txt` and
`playout-ingame-version.txt` to `resources/ingame`, which is kept in the repository and ships unpacked. The version is
`project(PlayOutIngame VERSION ...)` in `CMakeLists.txt` (also the DLL's `HELLO` `dll` field and both version
resources). The files are not signed.

## Test

```
node scripts/ingame-harness.mjs              # windowed: the full protocol walk
node scripts/ingame-harness.mjs --exclusive  # a short run in exclusive full screen (the screen changes mode)
```

The harness plays PlayOut's part: it serves the pipe, starts the test game, probes and injects it, and checks HELLO,
SHOW / FRAME / PRESENTING (and the drawn centre pixel), HIDE / HIDDEN, the hold loop (the game's own loop stops while
Present goes on), the pipe being dropped (the game survives, dormant), a second inject (reconnect, `step: "already"`),
DETACH and `watch`. `--verbose` prints the test game's stat lines.

## Design notes

- **No third-party code.** Hooks are vtable patches (`VirtualProtect` + interlocked pointer write) and import address
  table patches. The swap chain vtable comes from a dummy device and swap chain on a message-only window of the DLL's
  own; all DXGI swap chains of a process share it.
- **No back buffer reference is kept between frames**: the render target view on back buffer 0 is made and released
  per draw (cheap), so the game's `ResizeBuffers` always succeeds, even after a fault or while dormant.
- **Pipeline state**: `ID3D11DeviceContext1::SwapDeviceContextState` with a state object of the overlay's own;
  without it (Windows 7) exactly the bindings the draw changes are saved and restored. The overlay unbinds its render
  target and texture before swapping back, so its state object never keeps a back buffer alive.
- **sRGB back buffers**: the overlay texture is `B8G8R8A8_TYPELESS`, viewed as `_UNORM_SRGB` on an sRGB back buffer.
- **Faults**: every hook body runs under `__try/__except` in a small function with no C++ objects; the DLL builds with
  `/EHa`, so destructors (locks, the saved pipeline state, the hold flag) still run when a structured exception unwinds.
  The first fault disables the DLL for good and sends `FAULT`.
- **Input**: XInput is covered through the game modules' import tables (plain and delay-load). Games that call
  `GetProcAddress` for XInput themselves are not covered in phase 1. DirectInput8 devices are blocked only when their
  type is a game controller; sticks keep the position they last reported unblocked, buttons are up, hats centred.
- **Anti-cheat**: the helper refuses when any listed driver, program or module is present, or when the target's
  modules cannot be listed (`"unknown"`). PlayOut's own gate (game metadata, Steam VAC) runs before the helper.
