# GameDash — Electron + React + TypeScript stack playbook (Windows 11)

Verified 2026-10-29. Everything marked **VERIFIED** was executed or read from primary sources today; everything marked **UNVERIFIED** is a recommendation that was not executed on this machine. Implementation agents can copy paths, keys, commands and code from this file verbatim.

## 0. Verification environment (this machine)

| Item | Observed value |
|---|---|
| OS | Microsoft Windows 11 Home, build `10.0.26300` (`[Environment]::OSVersion` = `Microsoft Windows NT 10.0.26300.0`) |
| Hardware | ASUS Zenbook Duo `UX8407AA`, Intel Core Ultra X9 388H (16 logical CPUs), Intel Arc B390 GPU, 32 GB RAM, internal panel `1920x1200` at **175 %** (`HKCU:\Control Panel\Desktop\WindowMetrics\AppliedDPI = 168`), touch (10 points) + pen digitizer, Bluetooth, Wi‑Fi 7 |
| Shells | Windows PowerShell `5.1.26100.9818` (64-bit); `pwsh` (PowerShell 7) **not installed**; `wmic.exe` **not present** (removed in this Windows build) |
| Tooling | Node `v24.22.1`, npm `11.19.1`, git `2.55.0.windows.5`, curl `8.22.0` |
| Controller present | "GuliKit Controller XW" over Bluetooth, enumerated as `Bluetooth XINPUT compatible input device` (VID 045E PID 02FD, i.e. Xbox-One-S-compatible), plus "XBOX Synthetic Gamepad Bus" and "Nefarius Virtual Gamepad Emulation Bus" (ViGEm) drivers |
| Non-admin | `IsInRole(Administrator)` = `False` for the account used; all tests below ran **as a standard user** |

Two path-length facts discovered while verifying (both matter for the installer design, see §1.7):

* `cmd.exe` (and therefore `npm.cmd`, lifecycle scripts) refuses a working directory longer than ~248 chars: `Program 'npm.cmd' failed to run: The directory name is invalid`. The scratchpad path is 278 chars.
* Chromium's `file://` loader fails on a 291-char path: `did-fail-load -6 ERR_FILE_NOT_FOUND`, and Chromium could not create its cache dirs there either. The same page loaded fine from a 51-char path. **Keep the install dir, `userData` and the image cache short** (never under long temp/profile trees).

---

## 1. Project scaffold

### 1.1 Version pins (all read with `npm view <pkg> version` / `dist-tags` on 2026-10-29)

```json
{
  "electron": "45.1.0",
  "electron-vite": "6.0.0",
  "vite": "8.3.5",
  "react": "19.3.1",
  "react-dom": "19.3.1",
  "typescript": "5.9.3",
  "electron-builder": "26.18.0",
  "@vitejs/plugin-react": "6.1.2",
  "@electron-toolkit/preload": "3.0.2",
  "@electron-toolkit/utils": "4.0.0",
  "@electron-toolkit/tsconfig": "2.0.0",
  "@types/node": "24.19.2",
  "@types/react": "19.3.0",
  "@types/react-dom": "19.3.0",
  "@noriginmedia/norigin-spatial-navigation-react": "3.3.0",
  "@noriginmedia/norigin-spatial-navigation-core": "4.2.0",
  "zustand": "5.0.16",
  "lucide-react": "1.64.0",
  "simple-icons": "16.36.0",
  "@node-steam/vdf": "2.2.0",
  "protobufjs": "8.8.1",
  "fast-xml-parser": "5.11.2",
  "electron-log": "5.4.4",
  "ps-list": "9.0.0",
  "electron-store": "12.0.0",
  "lowdb": "7.0.1",
  "zod": "4.6.7",
  "p-limit": "7.3.3",
  "p-retry": "8.0.1"
}
```

Registry "latest" values that are **deliberately not** pinned above:

| Package | npm latest today | Why not |
|---|---|---|
| `typescript` | `7.0.2` (`latest` tag; `6.0.3` also exists) | TS 7 is the Go-native compiler line. The verified build used `5.9.3` (template range `^5.9.3`); `tsc --noEmit` type-check + electron-vite build passed with it. Re-evaluate TS 6/7 later. |
| `@types/node` | `26.6.6` | Electron 45.1.0 bundles **Node 24.22.1** (verified: `process.versions.node`), so use the `24.x` line (`24.19.2`, dist-tag `old-version`). |
| `@noriginmedia/norigin-spatial-navigation` | `3.4.0` | Now the "legacy combined package" that just depends on `-core ^4.2.0` and `-react ^3.3.0`. Use the two real packages. |
| `vdf-parser` | `1.2.1` | Alternative to `@node-steam/vdf` (both CJS, pure JS); pick one — `@node-steam/vdf` verified parsing `libraryfolders.vdf`-style text. |
| `systeminformation` | `5.33.18` | Pure JS (no `dependencies`, no `gypfile`), but every call spawns PowerShell; our own persistent worker (§6.9) is faster. Optional. |
| `electron-updater` | `6.8.11` | Not needed for v1. |
| `undici` | `8.12.3` | Not needed; Node 24's global `fetch` is undici already. |
| `@quick-start/create-electron` | `1.0.31` | Only used via `npm create`. |

Toolchain facts verified by installing and running: Electron `45.1.0` = Chromium `156.0.8078.49`, Node `24.22.1`, V8 `15.6.75.19-electron.0` (release date 2026-10-27, no listed breaking changes). `electron-vite 6.0.0` peer-depends on `vite ^6.0.0 || ^7.0.0 || ^8.0.0` and `node ^20.19.0 || >=22.12.0`; Vite `8.3.5` is Rolldown-based (`rolldown 1.2.16` installed) and the build log reads `vite v8.3.5 building ssr environment for production...` for main/preload.

### 1.2 Scaffold command and resulting tree (VERIFIED)

```powershell
npm create @quick-start/electron@latest gamedash -- --template react-ts --skip
cd gamedash
npm install
npm run dev
```

(`--skip` skips the interactive prompts; it printed `Scaffolding project in ...\gamedash... Done.` in 1.8 s.) Generated tree (create-electron 1.0.31):

```
gamedash/
  .editorconfig  .gitignore  .prettierignore  .prettierrc.yaml  README.md
  .vscode/{extensions.json,launch.json,settings.json}
  build/{entitlements.mac.plist,icon.icns,icon.ico,icon.png}      <- electron-builder buildResources
  resources/icon.png                                                <- imported in main via '?asset'
  electron-builder.yml
  electron.vite.config.ts
  eslint.config.mjs
  package.json
  tsconfig.json  tsconfig.node.json  tsconfig.web.json
  src/main/index.ts
  src/preload/index.ts  src/preload/index.d.ts
  src/renderer/index.html
  src/renderer/src/{App.tsx,main.tsx,env.d.ts}
  src/renderer/src/assets/{base.css,main.css,electron.svg,wavy-lines.svg}
  src/renderer/src/components/Versions.tsx
```

Generated `package.json` (template ranges, before pinning): `"main": "./out/main/index.js"`, scripts `dev: electron-vite dev`, `build: npm run typecheck && electron-vite build`, `start: electron-vite preview`, `build:win: npm run build && electron-builder --win`, `build:unpack: npm run build && electron-builder --dir`, `postinstall: install-electron && electron-builder install-app-deps`, `typecheck:node: tsc --noEmit -p tsconfig.node.json --composite false`, `typecheck:web: tsc --noEmit -p tsconfig.web.json --composite false`. Template devDependencies: `electron ^44.7.2`, `electron-vite ^6.0.0`, `vite ^8.3.4`, `typescript ^5.9.3`, `electron-builder ^26.15.3`, `@types/node ^24.19.2`, eslint 9 stack (`@electron-toolkit/eslint-config-ts ^4.0.0`, `@electron-toolkit/eslint-config-prettier ^3.0.1`, `eslint-plugin-react ^7.37.5`, `eslint-plugin-react-hooks ^7.1.1`, `eslint-plugin-react-refresh ^0.5.7`, `prettier ^3.9.10`).

Generated `electron.vite.config.ts`:

```ts
import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: { alias: { '@renderer': resolve('src/renderer/src') } },
    plugins: [react()]
  }
})
```

Generated `tsconfig.node.json` extends `@electron-toolkit/tsconfig/tsconfig.node.json` with `"types": ["electron-vite/node"]`, `include: ["electron.vite.config.*", "src/main/**/*", "src/preload/**/*"]`; `tsconfig.web.json` extends `@electron-toolkit/tsconfig/tsconfig.web.json` with `jsx: react-jsx`, `paths: {"@renderer/*": ["src/renderer/src/*"]}` and includes `src/preload/*.d.ts`. Both are `composite: true`; `tsconfig.json` only has `references`. The toolkit tsconfigs are strict.

Generated `src/renderer/index.html` ships this CSP meta tag: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:` (extend it for `media:`; see §3).

Generated `src/main/index.ts` (key lines): `import icon from '../../resources/icon.png?asset'`, `new BrowserWindow({ width: 900, height: 670, show: false, autoHideMenuBar: true, webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false } })`, `if (is.dev && process.env['ELECTRON_RENDERER_URL']) mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']) else mainWindow.loadFile(join(__dirname, '../renderer/index.html'))`, `electronApp.setAppUserModelId('com.electron')`, `app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))`. Note the template uses `sandbox: false` because its preload imports `@electron-toolkit/preload`; we change that (§1.4).

### 1.3 Dev-mode facts (from electron-vite 6.0.0 dist, VERIFIED by grep)

* `electron-vite dev` starts the renderer dev server and sets `process.env.ELECTRON_RENDERER_URL = \`${protocol}//${host}:${port}\`` (Vite default `http://localhost:5173`) before launching Electron.
* CLI flags: `--rendererOnly` (`only dev server for the renderer` — use it to develop the UI in a normal browser against the mock API, §2.5), `-w, --watch` (rebuild main/preload), `--inspect [port]`, `--remoteDebuggingPort <port>`, `--noSandbox`, `--entry <file>`, `--outDir <dir>` (default `out`), `--sourcemap`, `-m, --mode`.
* Env prefixes: `MAIN_VITE_`, `PRELOAD_VITE_`, `RENDERER_VITE_` (+ `VITE_`).

### 1.4 Module format decision: ESM main, CJS sandboxed preload (VERIFIED end-to-end)

Several required main-process libraries are **ESM-only** (`"type": "module"`, no `require` export): `electron-store 12.0.0` (engines `node >=22`, README: "Requires Electron 35 or later", "native ESM"), `lowdb 7.0.1`, `ps-list 9.0.0`, `p-limit 7.3.3`, `p-retry 8.0.1`. Dual packages: `zod 4.6.7` (`exports.require = ./index.cjs`), `fast-xml-parser 5.11.2` (`exports["."].require = ./lib/fxp.cjs`). CJS: `protobufjs 8.8.1`, `@node-steam/vdf 2.2.0` (`lib/index.js`), `electron-log 5.4.4` (`src/index.js`, import `electron-log/main`), `zustand 5.0.16` (CJS + ESM), `lucide-react 1.64.0` (CJS + ESM), `simple-icons 16.36.0` (ESM entry with `exports`), Norigin `-react`/`-core` (`dist/index.cjs` + `dist/index.mjs`). Node 24 can `require()` all of them (verified: `require('electron-store')` returns a namespace with `__esModule: true` and `.default`), but the clean solution is an ESM main process:

* `package.json` gets `"type": "module"`. electron-vite docs: with `"type": "module"` the main process and preload are bundled as ES modules ("Electron supports ES modules beginning in Electron 28"; preload files end in `.mjs`; "preload scripts must be unsandboxed, and their files must end in .mjs"). Electron's own ESM doc adds: sandboxed preloads "run as plain JavaScript with no ESM context" and ESM loads asynchronously (await dynamic `import()` before relying on `ready`).
* We want `sandbox: true`, so force the preload to CommonJS. Verified config:

```ts
// electron.vite.config.ts
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // main -> out/main/index.js (ESM because package.json "type": "module"); node_modules stay external
  main: {},
  // preload -> out/preload/index.cjs ; sandboxed preloads may only require 'electron' + events/timers/url,
  // so the preload must not import any npm package (or set build.externalizeDeps: false to bundle them)
  preload: { build: { rollupOptions: { output: { format: 'cjs' } } } },
  renderer: {
    resolve: { alias: { '@renderer': resolve('src/renderer/src') } },
    plugins: [react()]
  }
})
```

* electron-vite 6 externalizes `dependencies` automatically: `index.d.ts` documents `build.externalizeDeps?: boolean | ExternalOptions` (`@default true`, `ExternalOptions { exclude?: string[]; include?: string[] }`), and the exported `externalizeDepsPlugin()` is marked `@deprecated use build.externalizeDeps config option instead`. The dist code: `const externalOptions = config.build?.externalizeDeps ?? true`.
* Verified build output: `out/main/index.js` (ESM; electron-vite injects `const __dirname = import.meta.dirname;` and a `createRequire(import.meta.url)` shim, so `__dirname`/`require` keep working), `out/preload/index.cjs` (CJS). Verified at runtime from the built app (Electron 45.1.0, `sandbox: true, contextIsolation: true`):

```
VERIFY {"store":{"path":"C:\\Users\\<user>\\AppData\\Roaming\\gamedash\\gamedash-verify.json","theme":"light"},
 "psList":{"count":350,"ms":32,"fields":["pid","ppid","name"]},"zod":{"theme":"dark"},
 "logFile":"C:\\Users\\<user>\\AppData\\Roaming\\gamedash\\logs\\verify.log",
 "vdf":{"libraryfolders":{"0":{"path":"C:\\\\Steam","apps":{"2620":1}}}},"xml":{"a":{"b":1}},
 "plimit":[2,4,6],"pretry":"ok","protobuf":"function","lowdb":{"games":["x","x","x"]},   (three runs appended to the same db.json)
 "esm":{"dirname":"C:\\Users\\<user>\\AppData\\Local\\Temp\\gd-verify\\out\\main","typeofRequire":"function","typeofDirname":"string",
         "mainFile":"C:\\Users\\<user>\\AppData\\Local\\Temp\\gd-verify\\out\\main\\index.js"},
 "preloadApi":["ping","platform","win32"],"ipc":"pong","sandboxed":true}
```

(`import.meta.dirname`/`import.meta.filename` work; `ipcMain.handle('ping')` round-trips through `contextBridge`; the renderer has neither `process` nor `require`.)

* Gotcha verified: when the preload imported `@electron-toolkit/preload`, electron-vite left `require("@electron-toolkit/preload")` in `out/preload/index.cjs`; under `sandbox: true` the preload then failed silently and `window.api` was undefined. Keep the preload dependency-free (it only needs `electron`), or set `preload: { build: { externalizeDeps: false } }` to bundle.
* `app.getPath('logs')` throws `Failed to get 'logs' path` until `app.setAppLogsPath()` is called (d.ts: without a path it is created "inside the userData directory on Linux and Windows"). `app.getPath('cache')` on Windows returns `C:\Users\<user>\AppData\Roaming` (useless); keep caches under `userData`/`sessionData`.

### 1.5 Native Node modules — do not add these (npm metadata VERIFIED)

Native (need node-gyp/prebuilt `.node` binaries, break `electron-builder install-app-deps` / ABI pinning): `registry-js 1.16.1` (`binary.napi_versions`, `prebuild-install`), `native-reg 1.1.1` (`node-gyp-build`), `win-audio 3.0.5` (`gypfile: true`), `node-hid 3.4.0` (`gypfile: true`), `koffi 3.3.5` (ships its own native `.node` loader) and therefore `xinput-ffi 4.0.2`, `ffi-napi 4.0.3` (`node-gyp-build`, `ref-napi`), `sharp 0.35.5` (native `@img/*` binaries), `@vscode/windows-process-tree 0.8.0` (`gypfile: true`), `node-window-manager 2.2.4` (`node-gyp-build` + `extract-file-icon`), `active-win 9.0.0` / `get-windows 9.3.0` (prebuilt N-API `binary`), `extract-file-icon 0.3.2`, `@bitdisaster/exe-icon-extractor 1.0.10` (`gypfile: true`), `electron-edge-js 45.0.0` (`nan`), `gamepad 1.6.0` (`nan` + `prebuild-install`), `node-gamepad 0.1.15` (`node-hid`), `better-sqlite3 13.0.3` (prebuilt native addon). Pure-JS but spawning helpers: `winreg 1.2.5` (reg.exe), `node-powershell 5.0.1`, `loudness 0.4.2` (`execa`), `windows-shortcuts 0.1.6`, `systeminformation 5.33.18`. `ps-list 9.0.0` is pure JS but bundles `vendor/fastlist-0.3.0-x64.exe` (271,872 bytes) and `fastlist-0.3.0-x86.exe`; it resolves them with `path.dirname(fileURLToPath(import.meta.url))`, so the exe must live outside the asar (electron-builder `asar.smartUnpack` — "Whether to automatically unpack executables files", default `true` — handles `.exe`; add `asarUnpack: ["node_modules/ps-list/vendor/**"]` explicitly anyway). Windows registry, audio, brightness, radios, power and process queries are all done with PowerShell/WinRT/COM via a long-lived `powershell.exe` (§6.9) — zero native modules.

### 1.6 electron-builder (26.18.0) configuration (option names/defaults VERIFIED from `app-builder-lib/src/targets/win/nsis/nsisOptions.ts`, `options/CommonWindowsInstallerConfiguration.ts`, `options/PlatformSpecificBuildOptions.ts`, `options/winOptions.ts`, `configuration.ts`)

```yaml
# electron-builder.yml
appId: com.gamedash.app            # default would be com.electron.${name}; "strongly recommended that an explicit ID is set"
productName: GameDash
directories:
  buildResources: build            # build/icon.ico (256x256 multi-size ICO), build/installer.nsh (optional NSIS include)
  output: dist
files:
  - '!**/.vscode/*'
  - '!src/*'
  - '!electron.vite.config.{js,ts,mjs,cjs}'
  - '!{.eslintcache,eslint.config.mjs,.prettierignore,.prettierrc.yaml,dev-app-update.yml,CHANGELOG.md,README.md}'
  - '!{.env,.env.*,.npmrc,pnpm-lock.yaml}'
  - '!{tsconfig.json,tsconfig.node.json,tsconfig.web.json}'
asar: true                         # default true
asarUnpack:
  - resources/**
  - node_modules/ps-list/vendor/** # fastlist exe must be a real file (smartUnpack also unpacks *.exe)
extraResources:                    # copied to <install>/resources/<to>; read via path.join(process.resourcesPath, 'bin')
  - from: resources/bin
    to: bin
    filter: ['**/*']
win:
  target:
    - target: nsis
      arch: [x64]
    - target: portable
      arch: [x64]
  icon: build/icon.ico             # default build/icon.ico
  executableName: GameDash
  requestedExecutionLevel: asInvoker   # default; never requireAdministrator for a launcher
nsis:
  oneClick: false                  # default true; false = assisted installer (needed for the next three options)
  perMachine: false                # default false (per-user install, no UAC)
  allowToChangeInstallationDirectory: true   # default false
  allowElevation: true             # default true
  createDesktopShortcut: always    # default true; 'always' recreates on reinstall
  createStartMenuShortcut: true    # default true
  shortcutName: GameDash
  uninstallDisplayName: GameDash   # default "${productName} ${version}"
  artifactName: ${name}-${version}-setup.${ext}   # default "${productName} Setup ${version}.${ext}"
  deleteAppDataOnUninstall: false  # default false (one-click only)
  runAfterFinish: true             # default true
  differentialPackage: false       # default true; off because v1 has no updater
  include: build/installer.nsh     # optional custom NSIS macros (default location if present)
portable:
  artifactName: ${name}-${version}-portable.${ext}
  requestExecutionLevel: user      # default user
  unpackDirName: gamedash          # default = ksuid of build; fixed short name => stable, short %TEMP%\gamedash extraction path
npmRebuild: false                  # no native modules
```

Facts behind the config: `files` custom patterns are *added* to the defaults, `!` excludes, "Development dependencies are never copied in any case"; `extraResources` → "copy the file or directory with matching names directly into the app's resources directory" (`resources` on Windows), `extraFiles` → app root; `compression` default `normal`; `artifactName` default `${productName}-${version}.${ext}` (the template uses `${name}` as well); `win.target` default `nsis`; portable `unpackDirName` "Defaults to uuid (ksuid) of build"; NSIS `installerIcon`/`uninstallerIcon`/`installerHeaderIcon` default to `build/installerIcon.ico`/`build/uninstallerIcon.ico`/`build/installerHeaderIcon.ico` or the app icon; `license` defaults to `license.txt`/`eula.txt`; `guid` "a deterministic GUID is generated from the app ID"; `unicode` default `true`; `warningsAsErrors` default `true`; `packElevateHelper` default `true`; `selectPerMachineByDefault` default `false`; `displayLanguageSelector` default `false`; `language` defaults to `1033`. `electron-builder install-app-deps` ran `@electron/rebuild electronVersion=45.1.0 arch=x64` during `npm install` (harmless with no native deps). Icon rule (electron-builder docs page could not be fetched today — UNVERIFIED wording, standard practice): ship `build/icon.ico` containing 16/32/48/64/128/256 px images; `build/icon.png` 512x512 as fallback source.

### 1.7 Path-length rule for the launcher itself

Because Chromium's file/cache code and `cmd.exe` are not long-path aware (§0), the app must: install under `%LOCALAPPDATA%\Programs\GameDash` (NSIS per-user default) or the portable exe's directory; call `app.setPath('userData', path.join(process.env.LOCALAPPDATA!, 'GameDash'))` before `ready` (keeps config, Chromium `sessionData` and the artwork cache out of the roaming profile and short); keep cache file names short (hashes, §10.3); for the portable build `unpackDirName: gamedash` keeps the extraction path `%TEMP%\gamedash`.

---

## 2. Typed IPC

### 2.1 Settings (Electron docs VERIFIED)

`BrowserWindowConstructorOptions.webPreferences`: `sandbox` "Default is `true` since Electron 20" (disabled automatically when `nodeIntegration: true`), `contextIsolation` default `true`, `nodeIntegration` default `false`, `preload` "must be the absolute file path to the script", `webSecurity` default `true` (setting it `false` also enables `allowRunningInsecureContent`), `backgroundThrottling` default `true` (throttles timers/animations when the page is hidden; also affects the Page Visibility API), `devTools` default `true`, `spellcheck` default `true` (disable it for a launcher UI), `v8CacheOptions` default `code`. electron-vite: "electron-vite does not support `nodeIntegration`". Electron's IPC tutorial: do not expose `ipcRenderer` wholesale ("We don't directly expose the whole `ipcRenderer.invoke` API"), and for main→renderer events "don't just pass the callback to `ipcRenderer.on` as this will leak `ipcRenderer` via `event.sender`" — wrap as `(_event, value) => callback(value)`.

### 2.2 Shared API type file — `src/shared/api.ts` (imported by main, preload and renderer; type-only)

```ts
export type GameSource = 'steam' | 'epic' | 'gog' | 'ea' | 'battlenet' | 'ubisoft' | 'xbox' | 'manual' | 'rom'

export interface GameSummary {
  id: string            // stable internal id, e.g. 'steam:2620', 'rom:snes/Chrono Trigger.sfc'
  title: string
  source: GameSource
  systemId?: string     // ES-DE style system folder name for ROMs ('snes', 'psx', ...)
  installDir?: string
  playtimeMs: number
  lastPlayedAt?: number
  artwork: { cover?: string; hero?: string; logo?: string; icon?: string } // media:// URLs (see section 3)
}

export interface SystemStatus {
  battery: { present: boolean; percent: number; charging: boolean; onAc: boolean }
  wifi: { connected: boolean; ssid?: string; signalPercent?: number; radioOn: boolean }
  bluetooth: { radioOn: boolean }
  volume: { percent: number; muted: boolean }
  brightness: { percent: number | null }   // null when no WMI-controllable internal panel
  powerMode: 'efficiency' | 'balanced' | 'performance' | 'unknown'
  perf: { cpuPercent: number; ramUsedPercent: number; gpuPercent: number | null }
}

export type PowerAction = 'shutdown' | 'restart' | 'sleep' | 'hibernate' | 'lock' | 'signout'
export type PowerMode = Exclude<SystemStatus['powerMode'], 'unknown'>

export interface GameDashEvents {
  'session:started': { gameId: string; startedAt: number }
  'session:ended': { gameId: string; durationMs: number }
  'system:status': SystemStatus
  'scan:progress': { done: number; total: number; current?: string }
}

export interface GameDashApi {
  games: {
    list(): Promise<GameSummary[]>
    launch(id: string): Promise<void>
    rescan(): Promise<void>
  }
  system: {
    getStatus(): Promise<SystemStatus>
    setVolume(percent: number): Promise<void>
    setMute(muted: boolean): Promise<void>
    setBrightness(percent: number): Promise<void>
    setPowerMode(mode: PowerMode): Promise<void>
    power(action: PowerAction): Promise<void>
  }
  window: {
    minimize(): Promise<void>
    setFullscreen(on: boolean): Promise<void>
    quit(): Promise<void>
  }
  on<E extends keyof GameDashEvents>(event: E, cb: (payload: GameDashEvents[E]) => void): () => void
}

declare global {
  interface Window { gamedash?: GameDashApi }   // optional: absent when running in a plain browser
}
```

### 2.3 Preload — `src/preload/index.ts` (no npm imports; CJS output; VERIFIED pattern)

```ts
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { GameDashApi, GameDashEvents } from '../shared/api'

const invoke = <T>(channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args) as Promise<T>
const EVENTS: ReadonlySet<keyof GameDashEvents> = new Set(['session:started', 'session:ended', 'system:status', 'scan:progress'])

const api: GameDashApi = {
  games: {
    list: () => invoke('games:list'),
    launch: (id) => invoke('games:launch', { id }),
    rescan: () => invoke('games:rescan')
  },
  system: {
    getStatus: () => invoke('system:getStatus'),
    setVolume: (percent) => invoke('system:setVolume', { percent }),
    setMute: (muted) => invoke('system:setMute', { muted }),
    setBrightness: (percent) => invoke('system:setBrightness', { percent }),
    setPowerMode: (mode) => invoke('system:setPowerMode', { mode }),
    power: (action) => invoke('system:power', { action })
  },
  window: {
    minimize: () => invoke('window:minimize'),
    setFullscreen: (on) => invoke('window:setFullscreen', { on }),
    quit: () => invoke('window:quit')
  },
  on: (event, cb) => {
    if (!EVENTS.has(event)) throw new Error(`unknown event ${String(event)}`)
    const listener = (_e: IpcRendererEvent, payload: unknown) => cb(payload as never) // never hand the event (and its sender) to the page
    ipcRenderer.on(event, listener)
    return () => ipcRenderer.removeListener(event, listener)
  }
}

contextBridge.exposeInMainWorld('gamedash', api)
```

### 2.4 Main — `src/main/ipc.ts` with zod validation and sender check

```ts
import { ipcMain, BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type { GameDashEvents } from '../shared/api'

const ALLOWED_ORIGINS = new Set(['app://bundle', process.env['ELECTRON_RENDERER_URL']?.replace(/\/$/, '')].filter(Boolean) as string[])

function assertTrustedSender(e: IpcMainInvokeEvent): void {
  const url = e.senderFrame?.url ?? ''
  if (![...ALLOWED_ORIGINS].some((o) => url.startsWith(o))) throw new Error(`untrusted IPC sender: ${url}`)
}

// typed handler registration: schema validates the (single) argument object
export function handle<S extends z.ZodTypeAny, R>(channel: string, schema: S, fn: (arg: z.infer<S>, e: IpcMainInvokeEvent) => Promise<R> | R): void {
  ipcMain.handle(channel, async (e, raw) => {
    assertTrustedSender(e)
    const parsed = schema.safeParse(raw ?? {})
    if (!parsed.success) throw new Error(`invalid args for ${channel}: ${parsed.error.message}`) // thrown errors are serialized to the renderer as Error
    return fn(parsed.data, e)
  })
}

export function emit<E extends keyof GameDashEvents>(event: E, payload: GameDashEvents[E]): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(event, payload) // structured clone; no functions/DOM objects
}

// usage
const Percent = z.object({ percent: z.number().min(0).max(100) })
handle('games:list', z.object({}), () => library.list())
handle('games:launch', z.object({ id: z.string().min(1) }), ({ id }) => launcher.launch(id))
handle('system:setVolume', Percent, ({ percent }) => sysWorker.setVolume(percent))
handle('system:setPowerMode', z.object({ mode: z.enum(['efficiency', 'balanced', 'performance']) }), ({ mode }) => power.setMode(mode))
handle('system:power', z.object({ action: z.enum(['shutdown', 'restart', 'sleep', 'hibernate', 'lock', 'signout']) }), ({ action }) => power.run(action))
```

Notes: Electron docs — "Errors thrown through `handle` in the main process are not transparent as they are serialized" (only `message` survives; use error codes in the message). Zod 4's `safeParse` is synchronous; keep schemas in `src/shared/schemas.ts` if the renderer also validates.

### 2.5 Renderer API resolver + mock for plain-browser development — `src/renderer/src/api/index.ts`

```ts
import type { GameDashApi, GameDashEvents, GameSummary, SystemStatus } from '../../../shared/api'

function createMockApi(): GameDashApi {
  const listeners = new Map<keyof GameDashEvents, Set<(p: never) => void>>()
  const emit = <E extends keyof GameDashEvents>(e: E, p: GameDashEvents[E]) => listeners.get(e)?.forEach((cb) => (cb as (x: GameDashEvents[E]) => void)(p))
  const games: GameSummary[] = [
    { id: 'steam:2620', title: 'Call of Duty', source: 'steam', installDir: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Call of Duty', playtimeMs: 7_380_000, artwork: { cover: '/mock/cod-cover.jpg', hero: '/mock/cod-hero.jpg' } },
    { id: 'gog:1454587428', title: 'Fallout: New Vegas', source: 'gog', installDir: 'C:\\Program Files (x86)\\GOG Galaxy\\Games\\Fallout New Vegas', playtimeMs: 0, artwork: { cover: '/mock/fnv-cover.jpg' } },
    { id: 'rom:snes/Chrono Trigger', title: 'Chrono Trigger', source: 'rom', systemId: 'snes', playtimeMs: 123_000, artwork: { cover: '/mock/ct-cover.png' } }
  ]
  let status: SystemStatus = {
    battery: { present: true, percent: 78, charging: true, onAc: true },
    wifi: { connected: true, ssid: 'MockNet', signalPercent: 86, radioOn: true },
    bluetooth: { radioOn: true }, volume: { percent: 36, muted: false }, brightness: { percent: 56 },
    powerMode: 'balanced', perf: { cpuPercent: 12, ramUsedPercent: 52, gpuPercent: 3 }
  }
  setInterval(() => { status = { ...status, perf: { ...status.perf, cpuPercent: 5 + Math.round(Math.random() * 30) } }; emit('system:status', status) }, 2000)
  return {
    games: { list: async () => games, launch: async (id) => { emit('session:started', { gameId: id, startedAt: Date.now() }); setTimeout(() => emit('session:ended', { gameId: id, durationMs: 5000 }), 5000) }, rescan: async () => emit('scan:progress', { done: 3, total: 3 }) },
    system: { getStatus: async () => status, setVolume: async (percent) => { status = { ...status, volume: { ...status.volume, percent } } }, setMute: async (muted) => { status = { ...status, volume: { ...status.volume, muted } } }, setBrightness: async (percent) => { status = { ...status, brightness: { percent } } }, setPowerMode: async (mode) => { status = { ...status, powerMode: mode } }, power: async () => {} },
    window: { minimize: async () => {}, setFullscreen: async () => {}, quit: async () => {} },
    on: (event, cb) => { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(cb as never); return () => listeners.get(event)!.delete(cb as never) }
  }
}

export const api: GameDashApi = window.gamedash ?? createMockApi()
export const isMock = !window.gamedash
```

Workflow: `electron-vite dev --rendererOnly` then open `http://localhost:5173` in Chrome/Edge: `window.gamedash` is undefined → mock data, same React tree, useful for screenshots and DevTools device emulation (set 1280x800 / 1920x1080 with DPR). Put mock artwork under `src/renderer/public/mock/` (served at `/mock/...`). The `media://` URLs produced by the real main process are never used by the mock.

---

## 3. Serving artwork to the renderer: `media://` via `protocol.handle` (VERIFIED on Electron 45.1.0)

Electron docs: `protocol.registerSchemesAsPrivileged(customSchemes)` "can only be used before the `ready` event of the `app` module gets emitted and can be called only once"; `Privileges` fields (all default `false`, from `electron.d.ts`): `standard`, `secure`, `bypassCSP`, `allowServiceWorkers`, `supportFetchAPI`, `corsEnabled`, `stream`, `codeCache` ("only works when `standard` is also set to true"), `allowExtensions`. `protocol.handle(scheme, handler)` receives a `GlobalRequest` and returns `Response | Promise<Response>`; `request.initiatorOrigin` is "the origin that issued the request ... not controlled by the requesting page, so prefer it" over `referrer`. The docs' own path-traversal check: `const relativePath = path.relative(__dirname, pathToServe); const isSafe = relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)`. The `register*Protocol`/`intercept*Protocol` APIs are deprecated since 25.0.0. A protocol is per-session (register on `ses.protocol` for custom partitions). `net.fetch` "does not support the `data:` or `blob:` schemes" and by default can reach custom protocols and `file:`.

Measured behaviour (harness `C:\Users\<user>\AppData\Local\Temp\gd-verify\harness\main.cjs`):

| Page origin | `<img src="media://art/icon.png">` | `fetch('media://art/icon.png')` | `fetch('file:///C:/Windows/win.ini')` |
|---|---|---|---|
| `file://` (loadFile) | loads (512x512) | **Failed to fetch** (scheme not CORS-enabled) | **200** — the page can read any local file |
| `app://bundle/index.html` (custom scheme), `media` registered with `corsEnabled: true` + `Access-Control-Allow-Origin: *` | loads | **200**, `image/png`, 35949 bytes | **Failed to fetch** (blocked) |

Also verified: `media://art/../package.json` and `media://art/%2e%2e/package.json` arrive at the handler already normalized to `media://art/package.json` (URL parser), so the `path.relative` check is the real guard; missing file → `404`; `net.fetch('media://art/icon.png')` from the main process also works (200). Conclusion: **serve the renderer from `app://` in production (not `file://`) and register both schemes before `ready`.**

```ts
// src/main/protocols.ts
import { app, net, protocol } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

export const ART_ROOT = path.join(app.getPath('userData'), 'cache', 'images')   // see section 10.3
const RENDERER_ROOT = path.join(import.meta.dirname, '../renderer')               // out/renderer (inside asar is fine for net.fetch)
const CORS = { 'Access-Control-Allow-Origin': '*' }

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, codeCache: true } },
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
])

function safeJoin(root: string, urlPathname: string): string | null {
  const target = path.resolve(root, '.' + decodeURIComponent(urlPathname))
  const rel = path.relative(root, target)
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? target : null
}
async function fileResponse(target: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  const res = await net.fetch(pathToFileURL(target).toString())   // Chromium sets Content-Type from the extension
  const headers = new Headers(res.headers)
  for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v)
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

export function installProtocols(): void {          // call inside app.whenReady()
  protocol.handle('app', (req) => {
    const u = new URL(req.url)                      // app://bundle/<file>
    const target = safeJoin(RENDERER_ROOT, u.pathname === '/' ? '/index.html' : u.pathname)
    if (!target || !fs.existsSync(target)) return new Response('not found', { status: 404 })
    return fileResponse(target)
  })
  protocol.handle('media', (req) => {
    const u = new URL(req.url)                      // media://art/<gameId>/<file>  (host selects the root)
    if (u.host !== 'art') return new Response('bad host', { status: 404, headers: CORS })
    const target = safeJoin(ART_ROOT, u.pathname)
    if (!target) return new Response('bad', { status: 400, headers: CORS })
    if (!fs.existsSync(target)) return new Response('not found', { status: 404, headers: CORS })
    return fileResponse(target, { ...CORS, 'Cache-Control': 'max-age=31536000, immutable' })
  })
}
// main window: in dev loadURL(process.env.ELECTRON_RENDERER_URL), in prod loadURL('app://bundle/index.html')
```

CSP for `src/renderer/index.html` (meta tag; the Electron security list item 7 says "Define a Content-Security-Policy" and prefers restrictive rules): `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' media: data: blob:; media-src 'self' media:; connect-src 'self' media:; font-src 'self'`. In dev the Vite server needs `script-src 'self' 'unsafe-inline'`/HMR `ws:` — keep a dev-only CSP via `session.defaultSession.webRequest.onHeadersReceived` (Electron docs example) rather than loosening the production meta. Security settings kept at defaults: `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true` (never `false`), `allowRunningInsecureContent: false`, no `enableBlinkFeatures`/`experimentalFeatures`; `contents.setWindowOpenHandler(() => ({ action: 'deny' }))` and `will-navigate` → `preventDefault()` for any URL not starting with `app://bundle` or the dev URL (both patterns are quoted in Electron's security tutorial). Disable Chromium's cache for `media://` responses only if the cache dir grows too much; by default responses from custom protocols are cacheable with the headers above.

---

## 4. Gamepad input

### 4.1 Facts (W3C spec, Chromium source, Microsoft docs — VERIFIED by reading)

* **User-gesture gating**: `navigator.getGamepads()` returns an empty list until a "gamepad user gesture" has been seen (a button with a neutral default pressed after reporting unpressed, or a self-centering axis moved past a threshold) — W3C: done "to mitigate fingerprinting". Chromium `gamepad_provider.cc`: `CheckForUserGesture()` sets `ever_had_user_gesture_`, and connection events are only dispatched when `ever_had_user_gesture_` is true. Observed in the harness: 8 slots, all `null`, with the Bluetooth GuliKit pad enumerated but untouched (`rafFramesIn2s: 248-255`, i.e. the pad was not polled because no button had ever been pressed). UI consequence: show a "press any button" hint; `gamepadconnected` fires only after that first press.
* **Visibility, not focus, gates sampling in Blink** (`navigator_gamepad.cc`): `SampleAndCompareGamepadState()` samples only `if (GetPage()->IsPageVisible())`; `PageVisibilityChanged()` calls `StopUpdating()` when hidden; `Gamepads()` still returns the last snapshot. There is no `HasFocus` check (focus only matters for user-activation when `GamepadUserActivationFocusEnabled`). Harness: `document.visibilityState` is `"hidden"` when the window is hidden **and when minimized** → polling stops in both cases; `backgroundThrottling` also slows timers.
* **Windows focus gating happens below Chromium** for XInput/Xbox pads: Chromium on Windows registers `GameInputDataFetcher` only on Windows 11 with `features::kEnableWindowsGameInputDataFetcher`, otherwise `WgiDataFetcherWin` (Windows.Gaming.Input), plus `NintendoDataFetcher` and `RawInputDataFetcher` unconditionally (`gamepad_platform_data_fetcher.h`). Microsoft's `Windows.Gaming.Input` namespace remark: **"A Windows application must have focus to receive input from a controller."** `XInputEnable` doc: "Windows 10 or later: Deprecated, as game controller input is automatically enabled/disabled by the system based on the application window focus." So an Xbox/XInput pad reports **nothing** to an unfocused Electron window. RawInput devices (DualShock/DualSense/generic HID) are registered with `RIDEV_INPUTSINK` (`raw_input_data_fetcher_win.cc`: `GetRawInputDevices(RIDEV_INPUTSINK)` for usages joystick/gamepad/multi-axis controller, XInput devices with `IG_` in the name filtered out), so those **do** keep reporting in the background. Design consequence: do not rely on the Guide/any button to bring the launcher back while a game has focus; the launcher reacts to the game process ending (§7).
* Polling rate: Chromium's provider polls at `kPollingIntervalMilliseconds = 4` (~250 Hz); the page reads snapshots in `requestAnimationFrame` (120 frames/s on this 120 Hz panel).
* Standard mapping indices (W3C "standard" layout; `gamepad.mapping === 'standard'` for Xbox/PlayStation/Switch Pro pads in Chromium): buttons `0` bottom-right-cluster (A / Cross / B on Switch), `1` right (B / Circle / A), `2` left (X / Square / Y), `3` top (Y / Triangle / X), `4` L1/LB, `5` R1/RB, `6` L2/LT (analog `value`), `7` R2/RT, `8` Back/View/Share/Minus, `9` Start/Menu/Options/Plus, `10` L3, `11` R3, `12` D-up, `13` D-down, `14` D-left, `15` D-right, `16` Guide/PS/Home; axes `0` LX, `1` LY (negative = up), `2` RX, `3` RY. Chromium ids: WGI Xbox pads report `"Xbox 360 Controller (XInput STANDARD GAMEPAD)"` for XInput-known devices.
* Haptics: `gamepad.vibrationActuator.playEffect(type, params)` with `type` `"dual-rumble"` or `"trigger-rumble"`, params `duration`, `startDelay`, `strongMagnitude`, `weakMagnitude` (0–1), plus `leftTrigger`/`rightTrigger` for trigger-rumble; resolves `"complete"` or `"preempted"`; `reset()` stops. The spec recommends a 5 s maximum and **rejects with `InvalidStateError` when the document is hidden**. Chromium selects `kTriggerRumble` for pads in `GamepadIdList::HasTriggerRumbleSupport` (Xbox One/Series), else `kDualRumble`; `GamepadHapticActuator` exists in Electron 45 (harness `hapticApi: true`).

### 4.2 Renderer hook (`src/renderer/src/input/useGamepad.ts`) — design (UNVERIFIED in a running UI; APIs verified)

```ts
import { navigateByDirection } from '@noriginmedia/norigin-spatial-navigation-core'

type Dir = 'up' | 'down' | 'left' | 'right'
const DEADZONE = 0.25            // radial, for navigation; use 0.1 for analog scrolling
const DIGITAL_THRESHOLD = 0.6    // stick counts as a d-pad press beyond this
const REPEAT_INITIAL_MS = 400, REPEAT_MS = 120, REPEAT_FAST_MS = 60, REPEAT_FAST_AFTER = 6

function dispatchKey(key: string, keyCode: number, type: 'keydown' | 'keyup' = 'keydown'): void {
  // Norigin listens for window keydown/keyup; default key map = left [37,'ArrowLeft'], right [39,'ArrowRight'],
  // up [38,'ArrowUp'], down [40,'ArrowDown'], enter [13,'Enter']. Extend it with setKeyMap for Back/Escape.
  window.dispatchEvent(new KeyboardEvent(type, { key, keyCode, bubbles: true, cancelable: true } as KeyboardEventInit))
}
const DIR_KEY: Record<Dir, [string, number]> = { up: ['ArrowUp', 38], down: ['ArrowDown', 40], left: ['ArrowLeft', 37], right: ['ArrowRight', 39] }
const BUTTON_KEY: Record<number, [string, number]> = { 0: ['Enter', 13], 1: ['Escape', 27], 9: ['F1', 112] /* menu */, 8: ['Tab', 9] }

export function startGamepadLoop(): () => void {
  let raf = 0
  const held = new Map<string, { since: number; repeats: number; nextAt: number }>()
  const prevButtons: boolean[][] = []
  const pressed = (id: string, now: number, fire: () => void) => {
    const h = held.get(id)
    if (!h) { held.set(id, { since: now, repeats: 0, nextAt: now + REPEAT_INITIAL_MS }); fire(); return }
    if (now >= h.nextAt) { h.repeats++; h.nextAt = now + (h.repeats >= REPEAT_FAST_AFTER ? REPEAT_FAST_MS : REPEAT_MS); fire() }
  }
  const tick = (now: number) => {
    const pads = navigator.getGamepads()
    for (let p = 0; p < pads.length; p++) {
      const gp = pads[p]; if (!gp) continue
      const prev = (prevButtons[p] ??= [])
      // d-pad + left stick -> direction with repeat
      const [lx, ly] = [gp.axes[0] ?? 0, gp.axes[1] ?? 0]
      const mag = Math.hypot(lx, ly)
      const dirs: Dir[] = []
      if (gp.buttons[12]?.pressed || (mag > DEADZONE && ly < -DIGITAL_THRESHOLD)) dirs.push('up')
      if (gp.buttons[13]?.pressed || (mag > DEADZONE && ly > DIGITAL_THRESHOLD)) dirs.push('down')
      if (gp.buttons[14]?.pressed || (mag > DEADZONE && lx < -DIGITAL_THRESHOLD)) dirs.push('left')
      if (gp.buttons[15]?.pressed || (mag > DEADZONE && lx > DIGITAL_THRESHOLD)) dirs.push('right')
      for (const d of ['up', 'down', 'left', 'right'] as Dir[]) {
        if (dirs.includes(d)) pressed(`${p}:${d}`, now, () => { const [k, c] = DIR_KEY[d]; dispatchKey(k, c); navigateByDirection(d) /* either the key or the direct call; not both */ })
        else held.delete(`${p}:${d}`)
      }
      // face buttons: edge-triggered (no repeat)
      for (const [idx, [key, code]] of Object.entries(BUTTON_KEY)) {
        const i = Number(idx); const down = !!gp.buttons[i]?.pressed
        if (down && !prev[i]) dispatchKey(key, code, 'keydown')
        if (!down && prev[i]) dispatchKey(key, code, 'keyup')
        prev[i] = down
      }
      // subtle focus tick when visible: gp.vibrationActuator?.playEffect('dual-rumble', { duration: 40, weakMagnitude: 0.25, strongMagnitude: 0 })
    }
    raf = requestAnimationFrame(tick)
  }
  const onVis = () => { if (document.visibilityState === 'visible') { cancelAnimationFrame(raf); raf = requestAnimationFrame(tick) } }
  document.addEventListener('visibilitychange', onVis)
  raf = requestAnimationFrame(tick)
  return () => { cancelAnimationFrame(raf); document.removeEventListener('visibilitychange', onVis) }
}
```

Pick one of the two delivery paths (synthetic `KeyboardEvent` into Norigin's window listener, or calling `navigateByDirection` directly); do not do both. Norigin `init({ throttle: 0 })` since the loop already rate-limits. Right stick → scroll long panels (`element.scrollBy`) with the 0.1 deadzone and value-proportional speed.

### 4.3 Norigin Spatial Navigation API (docs VERIFIED from devportal.noriginmedia.com, exports VERIFIED by `require`)

* Packages: `@noriginmedia/norigin-spatial-navigation-core@4.2.0` exports `init, setKeyMap, setFocus, getCurrentFocusKey, navigateByDirection, pause, resume, updateAllLayouts, setThrottle, destroy, doesFocusableExist, clearLastFocusedChild, updateRtl, ROOT_FOCUS_KEY ('SN:ROOT'), SpatialNavigation, SpatialNavigationService, BaseWebAdapter, GetBoundingClientRectAdapter`; `@noriginmedia/norigin-spatial-navigation-react@3.3.0` (peer `react >=16.8.0`, deps `lodash-es`, `-core ^4.1.0`) exports `FocusContext, useFocusContext, useFocusable`. The old `useGetBoundingClientRect` is deprecated in favour of `layoutAdapter: GetBoundingClientRectAdapter`.
* `init(config)` options/defaults: `debug false`, `visualDebug false`, `throttle 0`, `throttleKeypresses false`, `layoutAdapter defaultLayoutAdapter`, `shouldFocusDOMNode false` (calls `HTMLElement.focus()` on the focused node — set `true` so screen readers/inputs follow), `domNodeFocusOptions`, `shouldUseNativeEvents false` (library calls `preventDefault()` on matched keys), `rtl false`, `distanceCalculationMethod 'corners'` (`'center' | 'edges' | 'corners'`), `customDistanceCalculationFunction`, `onUtterText`, `focusOnPresetKey true`. Call once before mounting.
* `setKeyMap({ left, right, up, down, enter })` accepts key codes, key names or arrays (e.g. `left: [37, 'ArrowLeft', 65, 'KeyA']`). No default `back` key — handle Escape/B yourself.
* `useFocusable(config)` options: `focusable true`, `saveLastFocusedChild true`, `trackChildren false`, `autoRestoreFocus true`, `forceFocus false`, `isFocusBoundary false`, `focusBoundaryDirections`, `focusKey` (auto `sn:focusable-item-N`), `preferredChildFocusKey`, `nextFocusResolver`, `measureChildrenLayout true`, `onEnterPress(props, details)`, `onEnterRelease(props)`, `onArrowPress(direction, props, details) => boolean` (return `false` to block default navigation), `onArrowRelease`, `onFocus(layout, props, details)`, `onBlur`, `extraProps`, `accessibilityLabel`. Returns `{ ref, focused, hasFocusedChild, focusKey, focusSelf }`. Containers wrap children in `<FocusContext.Provider value={focusKey}>`; the `ref` element must have non-zero size on mount; only `focusKey, focusable, isFocusBoundary, focusBoundaryDirections, preferredChildFocusKey, nextFocusResolver, measureChildrenLayout, accessibilityLabel` are reactive after mount.
* Mouse/touch: the docs do not describe pointer support; wire `onPointerEnter={() => focusSelf()}` and `onClick` → the same handler as `onEnterPress` on each focusable tile so mouse and touch share the focus model.

---

## 5. Touch, pen and the on-screen keyboard

### 5.1 Pointer facts (harness VERIFIED on the touch laptop)

`navigator.maxTouchPoints = 10`, `'onpointerdown' in window = true`, `'ontouchstart' in window = false` (Chromium desktop does not expose Touch Events unless started with `--touch-events=enabled`; use **Pointer Events**, they carry `pointerType: 'mouse' | 'touch' | 'pen'`), `matchMedia('(pointer: coarse)') = false` on this laptop (primary pointer is the touchpad) but `(any-pointer: coarse) = true` and `(hover: hover) = true`; on a handheld with no mouse, `(pointer: coarse)` becomes true — use it to enlarge hit targets, never to disable mouse support. Electron: "Visual zoom is disabled by default" (`setVisualZoomLevelLimits`), so pinch does nothing unless enabled.

### 5.2 CSS/JS rules for swipe-to-scroll rows (standard Chromium behaviour; UNVERIFIED in the final UI)

* Horizontal game rows: `overflow-x: auto; overscroll-behavior-x: contain; touch-action: pan-x; scroll-snap-type: x proximity; scrollbar-width: none;` children `scroll-snap-align: start`. Vertical pages: `touch-action: pan-y`. Buttons/tiles: `touch-action: manipulation; user-select: none; -webkit-tap-highlight-color: transparent`.
* Distinguish tap from swipe with pointer events: on `pointerdown` record position/time, `setPointerCapture`; on `pointerup` treat as a tap only if movement < 10 CSS px and duration < 300 ms; otherwise let the browser scroll (do not call `preventDefault` on `pointerdown`, or native pan is lost). Focus follows the tapped tile (`focusSelf()`), then "Enter". Pen (`pointerType === 'pen'`) behaves like mouse hover + click.
* Keep kinetic scrolling native; do not re-implement momentum.

### 5.3 Windows touch keyboard (OSK) — mechanism (Chromium source VERIFIED) and tests on this machine (VERIFIED)

How Chromium shows it: `content/browser/renderer_host/virtual_keyboard_controller_win.cc` — `UpdateTextInputState()` returns early unless `IsPointerTypeValidForVirtualKeyboard()` (last pointer type **touch or pen**) `|| is_manual_policy_`; with the default `virtualkeyboardpolicy` AUTO it calls `ShowVirtualKeyboard()` when `state->show_ime_if_needed` is set; with `virtualkeyboardpolicy="manual"` a page-requested SHOW (`navigator.virtualKeyboard.show()`) is honoured only if `host_view_->FocusedFrameHasStickyActivation()`; `FocusedNodeChanged` never shows it (only hides when the node is not editable). The actual display goes through `ui/base/ime/win/on_screen_keyboard_display_manager_input_pane.cc`: WinRT `InputPane` via `IInputPaneInterop::GetForWindow(hwnd)` → `IInputPane2::TryShow()/TryHide()`, debounced 300 ms, and "The `res` output is never checked" — whether the keyboard actually appears is **Windows' decision** (touch-keyboard policy: Settings > Time & language > Typing > Touch keyboard > "Show the touch keyboard": Never / When no keyboard attached / Always; registry `HKCU\Software\Microsoft\TabletTip\1.7\EnableDesktopModeAutoInvoke` = 1 for "Always"; on this machine the value is unset = default). Electron carries no extra OSK patches except `fix_on-screen-keyboard_hides_on_input_blur_in_webview.patch` (webview hide fix).

Consequences: **programmatic focus (gamepad navigation into a text field) never shows the keyboard**; a finger/pen tap on an `<input>` does, if Windows allows it. Tests on this laptop (Bluetooth keyboard attached, policy default): `Start-Process "C:\Program Files\Common Files\microsoft shared\ink\TabTip.exe"` (10.0.26100.8117, process already running as PID 11184) → no keyboard window; COM `ITipInvocation.Toggle` (CLSID `4ce576fa-83dc-4F88-951c-9d0782b4e376`, IID `37c994e7-432b-4834-a2f7-dce1f13b834b`) → no keyboard; WinRT `InputPane.TryShow()` from a focused WinForms window → returned `True` but no keyboard window appeared (`Windows.UI.Core.CoreWindow` "Microsoft Text Input Application" not found). This matches the "when no keyboard attached" policy; on a handheld without a keyboard it should appear automatically (UNVERIFIED here — no such device). `C:\Windows\System32\osk.exe` (classic accessibility keyboard) exists and always shows when launched, but never auto-hides.

Recommendation: implement an **in-app on-screen keyboard** component (gamepad/touch navigable, like a console), open it whenever a text field gets focus from gamepad/keyboard navigation; add `virtualkeyboardpolicy="manual"` to inputs and call `navigator.virtualKeyboard.show()` on touch/pen taps (`'virtualKeyboard' in navigator = true` in Electron 45) so Windows' keyboard is used where the OS permits; offer "Use Windows keyboard (osk.exe)" as a setting (`spawn('C:\\Windows\\System32\\osk.exe', [], { detached: true, stdio: 'ignore' })`, close via `taskkill /IM osk.exe` — UNVERIFIED). Do not ship TabTip/ITipInvocation hacks.

---

## 6. System bar data (every command below was run as a standard user on this machine; outputs are verbatim)

### 6.1 Battery

* Renderer, no IPC (VERIFIED in Electron 45): `await navigator.getBattery()` → `{"level":0.8,"charging":true,"chargingTime":null,"dischargingTime":null}` (on AC: `chargingTime` null here, `dischargingTime` null). Fire `levelchange`/`chargingchange` events; poll not needed. Main-process complement: `powerMonitor` events `on-ac`, `on-battery` (macOS/Windows), `lock-screen`/`unlock-screen`, `suspend`/`resume`, `powerMonitor.isOnBatteryPower()`.
* PowerShell (29 ms cold, 9–11 ms in the warm worker):

```powershell
Get-CimInstance Win32_Battery | Select-Object BatteryStatus,EstimatedChargeRemaining,EstimatedRunTime | ConvertTo-Json -Compress
# {"BatteryStatus":2,"EstimatedChargeRemaining":79,"EstimatedRunTime":71582788}
#  BatteryStatus: 1 discharging, 2 on AC, 3 fully charged, 4 low, 5 critical, 6 charging, 7-9 charging+high/low/critical, 11 partially charged
#  EstimatedRunTime 71582788 = "unknown" sentinel while on AC
Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus | Select-Object Charging,Discharging,PowerOnline,RemainingCapacity,ChargeRate,DischargeRate | ConvertTo-Json -Compress
# {"Charging":false,"Discharging":false,"PowerOnline":true,"RemainingCapacity":77405,"ChargeRate":0,"DischargeRate":0}   (mWh / mW)
Get-CimInstance -Namespace root/wmi -ClassName BatteryFullChargedCapacity | Select-Object FullChargedCapacity   # 97363  -> 77405/97363 = 79.5 %
Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SystemInformation]::PowerStatus   # PowerLineStatus=Online BatteryChargeStatus=High BatteryLifePercent=0.8 BatteryLifeRemaining=-1
```

WinRT (also usable from the worker): `[Windows.System.Power.PowerManager,Windows.System.Power.PowerManagerContract,ContentType=WindowsRuntime]` → `EnergySaverStatus=Disabled BatteryStatus=Idle PowerSupplyStatus=Adequate RemainingChargePercent=80 RemainingDischargeTime=10675199.02:48:05` (max TimeSpan = unknown).

### 6.2 Wi‑Fi (VERIFIED)

```text
netsh wlan show interfaces          (130 ms cold / ~80 ms warm; parse "Name : Wi-Fi", "State : connected", "SSID : HomeNetwork5",
                                     "Band : 5 GHz", "Radio type : 802.11ax", "Signal : 86%", "Receive rate (Mbps) : 721")
Get-NetConnectionProfile | Select-Object Name,InterfaceAlias,IPv4Connectivity | ConvertTo-Json -Compress
   -> {"Name":"HomeNetwork5 4","InterfaceAlias":"Wi-Fi","IPv4Connectivity":4}   (4 = Internet, 3 LocalNetwork, 2 Subnet, 1 NoTraffic, 0 Disconnected; 738 ms cold, 13 ms warm)
Get-NetAdapter | Select-Object Name,Status,LinkSpeed,PhysicalMediaType   -> Wi-Fi Up 865 Mbps "Native 802.11"
```

Electron side: `net.isOnline()` (`true` here; docs: `false` is reliable, `true` is not conclusive) and the renderer's `navigator.onLine`.

**Decision (2026-11-01, `src/main/system/network.ts`; timings measured on this machine through the worker):** the
primary source is WinRT, not `netsh`, because `netsh` output is localized and cannot be parsed reliably:

```text
Get-NetAdapter -Physical | Select Name,InterfaceIndex,Status,PhysicalMediaType     2235 ms cold / 20 ms warm; PhysicalMediaType "Native 802.11" = Wi-Fi (untranslated NDIS medium)
[Windows.Networking.Connectivity.NetworkInformation]::GetConnectionProfiles()       147 ms cold / 35 ms warm
   filter: $cp.GetNetworkConnectivityLevel() -ge 1   (1 = LocalAccess, 2 ConstrainedInternetAccess, 3 InternetAccess)
   Wi-Fi:  $cp.IsWlanConnectionProfile; SSID = $cp.WlanConnectionProfileDetails.GetConnectedSsid(); bars = $cp.GetSignalBars() (0-5; 4 here)
netsh wlan show interfaces                                                          English-locale enrichment only (band, radio type, receive rate); never required
```

The first network poll in a fresh worker costs ~2 s (the `Get-NetAdapter` cold cost), within the 8 s probe timeout;
every later poll is ~60 ms.

### 6.3 Bluetooth radio state (VERIFIED; 40 ms cold, **4 ms warm**)

```powershell
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Devices.Radios.Radio,Windows.System.Devices,ContentType=WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0].MakeGenericMethod([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])
$t = $asTask.Invoke($null, @([Windows.Devices.Radios.Radio]::GetRadiosAsync())); $t.Wait(5000) | Out-Null
$t.Result | Select-Object Name,Kind,State | ConvertTo-Json -Compress
# [{"Name":"Wi-Fi","Kind":1,"State":1},{"Name":"Bluetooth","Kind":3,"State":1}]
# Kind: 0 Other, 1 WiFi, 2 MobileBroadband, 3 Bluetooth, 4 FM ; State: 0 Unknown, 1 On, 2 Off, 3 Disabled
```

Without `Add-Type -AssemblyName System.Runtime.WindowsRuntime` the `AsTask` lookup fails (`Unable to find type [System.WindowsRuntimeSystemExtensions]`). Fallback: `Get-PnpDevice -Class Bluetooth` (slower; `Intel(R) Bluetooth(R) PCI Enumerator` Status `OK`). Toggling a radio (`$radio.SetStateAsync([Windows.Devices.Radios.RadioState]::Off)` after `Radio.RequestAccessAsync()`) is UNVERIFIED.

### 6.4 Volume get/set/mute — CoreAudio via `Add-Type`, no third-party binary (GET VERIFIED: `volume=36 mute=False`, compile 245 ms once, GET 30 ms)

```powershell
# volume.ps1 — dot-source once in the worker; then [GD.Audio]::GetVolume() / SetVolume(0.5) / GetMute() / SetMute($true)
$code = @'
using System; using System.Runtime.InteropServices;
namespace GD {
  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr pNotify); int UnregisterControlChangeNotify(IntPtr pNotify);
    int GetChannelCount(out uint pnChannelCount);
    int SetMasterVolumeLevel(float fLevelDB, ref Guid pguidEventContext);
    int SetMasterVolumeLevelScalar(float fLevel, ref Guid pguidEventContext);
    int GetMasterVolumeLevel(out float pfLevelDB);
    int GetMasterVolumeLevelScalar(out float pfLevel);
    int SetChannelVolumeLevel(uint nChannel, float fLevelDB, ref Guid pguidEventContext);
    int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, ref Guid pguidEventContext);
    int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
    int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, ref Guid pguidEventContext);
    int GetMute([MarshalAs(UnmanagedType.Bool)] out bool pbMute);
    int GetVolumeStepInfo(out uint pnStep, out uint pnStepCount);
    int VolumeStepUp(ref Guid pguidEventContext); int VolumeStepDown(ref Guid pguidEventContext);
    int QueryHardwareSupport(out uint pdwHardwareSupportMask);
    int GetVolumeRange(out float pflVolumeMindB, out float pflVolumeMaxdB, out float pflVolumeIncrementdB);
  }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDevice {
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
    int OpenPropertyStore(int stgmAccess, out IntPtr ppProperties);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId); int GetState(out int pdwState);
  }
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int dwStateMask, out IntPtr ppDevices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppEndpoint);
    int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string pwstrId, out IMMDevice ppDevice);
    int RegisterEndpointNotificationCallback(IntPtr pClient); int UnregisterEndpointNotificationCallback(IntPtr pClient);
  }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] public class MMDeviceEnumerator { }
  public static class Audio {
    static IAudioEndpointVolume Vol() {
      var en = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
      IMMDevice dev; en.GetDefaultAudioEndpoint(0 /*eRender*/, 1 /*eMultimedia*/, out dev);
      var iid = typeof(IAudioEndpointVolume).GUID; object o; dev.Activate(ref iid, 23 /*CLSCTX_ALL*/, IntPtr.Zero, out o);
      return (IAudioEndpointVolume)o;
    }
    public static float GetVolume() { float v; Vol().GetMasterVolumeLevelScalar(out v); return v; }
    public static bool GetMute() { bool m; Vol().GetMute(out m); return m; }
    public static void SetVolume(float v) { var g = Guid.Empty; Vol().SetMasterVolumeLevelScalar(v, ref g); }   // 0.0 - 1.0
    public static void SetMute(bool m) { var g = Guid.Empty; Vol().SetMute(m, ref g); }
  }
}
'@
Add-Type -TypeDefinition $code
"volume=$([math]::Round([GD.Audio]::GetVolume()*100)) mute=$([GD.Audio]::GetMute())"      # observed: volume=36 mute=False
```

`SetVolume`/`SetMute` use the same `IAudioEndpointVolume` interface (`SetMasterVolumeLevelScalar`, `SetMute`) and were **not executed** (UNVERIFIED but standard). The default endpoint is re-queried on every call so device switches are handled. Alternative: **NirCmd v2.87** (`nircmd.zip` / `nircmd-x64.zip`, nirsoft.net): "This utility is released as freeware. You are allowed to freely distribute this utility via floppy disk, CD-ROM, Internet, or in any other way, as long as you don't charge anything for this. If you distribute this utility, you must include all files in the distribution package, without any modification !" Commands: `nircmd.exe setsysvolume 65535` (0–65535), `changesysvolume 2000`, `mutesysvolume 1|0|2` (mute/unmute/toggle), also `monitor off`, `standby`, `exitwin poweroff|reboot|logoff`, `setbrightness`. NirCmd has **no get** command → not needed; `nircmd` is not installed here.

### 6.5 Screen brightness — WMI, internal panel only (GET VERIFIED 8 ms warm; non-admin SET VERIFIED as a no-op)

```powershell
(Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightness).CurrentBrightness     # 56 (later 80); .Level = 0..100 list; .Active = True
$m = Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightnessMethods           # InstanceName DISPLAY\BOE0D7B\4&162da92a&1&UID8388688_0
Invoke-CimMethod -InputObject $m -MethodName WmiSetBrightness -Arguments @{ Timeout = [uint32]0; Brightness = [byte]80 }
# ran as a standard user with the current value (80): no error, value unchanged -> no admin needed
```

Only displays with a WMI brightness driver (laptop/handheld internal panels) expose these classes; external monitors need DDC/CI (native) — hide the slider when `WmiMonitorBrightness` is absent/inactive.

### 6.6 Power actions (commands standard; **not executed**; privilege VERIFIED)

`whoami /priv` lists `SeShutdownPrivilege  Shut down the system  Disabled` for this standard user ("Disabled" = not yet enabled in the token; `shutdown.exe` enables it) → no admin required for shutdown/restart/sleep/lock. `powercfg /a` on this machine: only `Standby (S0 Low Power Idle) Network Connected` is available; `Hibernate: Hibernation has not been enabled` (enabling needs admin `powercfg /hibernate on`), so hide "Hibernate" unless `powercfg /a` lists it.

```text
shutdown.exe /s /t 0           # power off (add /f to force-close apps)
shutdown.exe /r /t 0           # restart
shutdown.exe /h                # hibernate (only if enabled)
shutdown.exe /l                # sign out
rundll32.exe user32.dll,LockWorkStation
powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState([System.Windows.Forms.PowerState]::Suspend, $false, $false)"   # sleep
# avoid: rundll32 powrprof.dll,SetSuspendState 0,1,0 -> hibernates when hibernation is enabled
```

### 6.7 Windows 11 power modes (overlays) — GUIDs VERIFIED in the registry; standard-user `powercfg /overlaysetactive` VERIFIED (no-op)

`powercfg /list` → `381b4222-f694-41f0-9685-ff5bb260df2e (Balanced) *` (+ a custom `099601ff-... (Winhanced)` on this PC). `powercfg /?` does **not** document overlays; `powercfg /getactiveoverlayscheme`, `/overlaygetactive`, `/overlayquery`, `/overlaylist`, `/overlayschemes` all return `Invalid Parameters`. Strings inside `C:\Windows\System32\powercfg.exe` (10.0.26100.8328): `OVERLAY_SCHEME_CURRENT`, `OVERLAY_SCHEME_HIGH`, `OVERLAY_SCHEME_MAX`, `OVERLAY_SCHEME_MIN`, `OVERLAY_SCHEME_NONE`, `OverlaySetActive`. Registry `HKLM\SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes` subkeys and `FriendlyName`s:

| GUID | FriendlyName | Meaning / alias |
|---|---|---|
| `961cc777-2547-4f9d-8174-7d86181b8a7a` | `Better Battery-life Overlay` | Best power efficiency — `OVERLAY_SCHEME_MIN` |
| `00000000-0000-0000-0000-000000000000` | (no key) | Balanced / no overlay — `OVERLAY_SCHEME_NONE` |
| `3af9b8d9-7c97-431d-ad78-34a8bfea439f` | `High Performance Overlay` | "Better performance" — `OVERLAY_SCHEME_HIGH` (hidden in Win11 UI) |
| `ded574b5-45a0-4f42-8737-46345c09c238` | `Max Performance Overlay` | Best performance — `OVERLAY_SCHEME_MAX` |
| `381b4222-f694-41f0-9685-ff5bb260df2e` / `8c5e7fda-...` / `a1841308-...` / `e9a42b02-...` | Balanced / High performance / Power saver / Ultimate Performance | classic plans (`powercfg /setactive <guid>`) |

Read the current mode without admin: `(Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes').ActiveOverlayAcPowerScheme` (and `ActiveOverlayDcPowerScheme`, `ActivePowerScheme`) → `00000000-...` here = Balanced. Set: `powercfg /overlaysetactive OVERLAY_SCHEME_MIN|OVERLAY_SCHEME_NONE|OVERLAY_SCHEME_MAX` (or the GUID). As a standard user, `powercfg /setactive 381b4222-f694-41f0-9685-ff5bb260df2e` (already active) and `powercfg /overlaysetactive OVERLAY_SCHEME_NONE` (already none) both returned exit code 0 with no "Access is denied", so no elevation is needed (an actual mode change was not performed: UNVERIFIED that Windows applies it for a standard user, but the call is accepted). Overlays apply on top of the Balanced plan (Windows greys the mode selector out on other plans — UNVERIFIED).

### 6.8 CPU / GPU / RAM for the performance panel (timings VERIFIED)

| Source | Command | Cost | Verdict |
|---|---|---|---|
| Node, no spawn | `os.cpus()` idle/total delta over 1 s; `os.totalmem()`/`os.freemem()` | 0 | **CPU % and RAM** (`cpu% = 11.5`, `31.4 GiB total / 6.6 GiB free` observed) |
| WMI (worker) | `Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'" \| Select PercentProcessorTime,PercentIdleTime` | 2468 ms first call, then **274 ms** | fallback only |
| WMI (worker) | `Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory \| Select AvailableMBytes,CommittedBytes,PercentCommittedBytesInUse` | 270 ms | fallback |
| WMI (worker) | `(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine \| ? Name -like '*engtype_3D' \| Measure-Object UtilizationPercentage -Sum).Sum` | **330 ms** | **GPU %** (observed 5) |
| WMI (worker) | `Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory \| Select Name,DedicatedUsage,SharedUsage` | **12 ms** | GPU memory (`luid_0x00000000_0x00010C06_phys_0 SharedUsage 5436133376`) |
| `Get-Counter '\Processor(_Total)\% Processor Time','\Memory\Available MBytes'` | 1–2 s (needs a 1 s sample) | avoid |
| `Get-Counter '\GPU Engine(*)\Utilization Percentage'` | 1.3 s, 465 samples | avoid |
| `typeperf ... -sc 1` | 1.47 s | avoid |
| `Win32_Processor.LoadPercentage` | 1.2 s | avoid |
| `systeminformation` npm | spawns PowerShell per call | unnecessary |

### 6.9 The persistent PowerShell worker (VERIFIED; `scratchpad\scripts\pstest.js`)

Cold `powershell.exe -NoProfile -NonInteractive -Command "1"` costs **0.9–1.1 s per spawn** (3 runs: 1076/913/985 ms); `Get-ItemProperty ... | ConvertTo-Json` via a fresh process = 1312 ms; `Win32_Process` JSON via a fresh process = 1406 ms. One long-lived process answers in: process list JSON 100 ms, WQL "processes under dir" 90 ms, battery 10 ms, wifi (netsh) 80 ms, net profile 13 ms, memory 95 ms, brightness 8 ms, radios 4 ms. Implementation (Node/TypeScript, main process):

```ts
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export class PsWorker {
  private proc: ChildProcessWithoutNullStreams
  private buf = ''
  private queue: Array<{ resolve: (s: string) => void; reject: (e: Error) => void }> = []
  private static readonly END = '\u0000__END__\u0000'
  constructor() {
    this.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-Command', '-'], { windowsHide: true, stdio: 'pipe' })
    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (d: string) => {
      this.buf += d
      let i: number
      while ((i = this.buf.indexOf(PsWorker.END)) !== -1) {
        const chunk = this.buf.slice(0, i); this.buf = this.buf.slice(i + PsWorker.END.length)
        this.queue.shift()?.resolve(chunk.replace(/^\r?\n/, ''))
      }
    })
    this.proc.on('exit', () => { for (const j of this.queue.splice(0)) j.reject(new Error('powershell exited')) })
    void this.run("[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; 'ready'")   // UTF-8 out: "Command & Conquer™" survives
  }
  run(script: string): Promise<string> {                      // scripts are our own constants + validated numbers only; never interpolate user strings
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject })
      this.proc.stdin.write(`& { ${script} } | Out-String -Width 4096; [Console]::Out.Write("${PsWorker.END}"); [Console]::Out.Flush()\n`)
    })
  }
  json<T>(script: string): Promise<T> { return this.run(script).then((s) => JSON.parse(s) as T) }
  dispose(): void { this.proc.stdin.end('exit\n') }
}
```

Serialize calls (one in flight), add a 10 s per-call timeout and auto-respawn on exit. For values coming from the renderer (volume %, brightness %, mode) validate with zod and pass numbers only; for paths use `-EncodedCommand` style quoting or `[string]` literals with `'` doubled.

**Recommended cadence** (all through the single worker, staggered): battery + radios + brightness every 5 s (≈25 ms total), volume every 2 s (30 ms) and immediately after our own set, Wi‑Fi `netsh` every 10 s (80 ms) + `net.isOnline()` on demand, CPU/RAM every 1 s from Node (free), GPU every 2 s (330 ms) only while the performance panel is visible, game-process watch every 2 s (90 ms, §7.4). Pause everything but the process watch while a game is running and the window is hidden; stop polling on `powerMonitor` `suspend`, restart on `resume`.

---

## 7. Launching games and tracking sessions

### 7.1 Store URIs via `shell.openExternal(url)` (docs VERIFIED; handler registration VERIFIED on this machine)

`shell.openExternal(url[, options])` → `Promise<void>`, "Open the given external protocol URL in the desktop's default manner", Windows: `url` max 2081 chars, options `workingDirectory` (string, Windows) and `logUsage` (boolean, Windows, default `false`); `shell` works in the main process (not in sandboxed renderers). Registered handlers here (`HKEY_CLASSES_ROOT\<scheme>\shell\open\command`):

| Scheme | Registered on this PC | Command |
|---|---|---|
| `steam` | yes | `"C:\Program Files (x86)\Steam\steam.exe" -- "%1"` → `steam://rungameid/<appid>` |
| `com.epicgames.launcher` | yes | `"C:\Program Files\Epic Games\Launcher\Portal\Binaries\Win64\EpicGamesLauncher.exe" %1` → `com.epicgames.launcher://apps/<AppName>?action=launch&silent=true` |
| `goggalaxy` | yes | `"C:\Program Files (x86)\GOG Galaxy\GalaxyClient.exe" /urlProtocol="%1"` → `goggalaxy://openGameView/<productId>` (direct launch alternative: `GalaxyClient.exe /command=runGame /gameId=<id> /path="<installDir>"`) |
| `origin2` | yes | `C:\Program Files\Electronic Arts\EA Desktop\EA Desktop\EALauncher.exe "%1"` → `origin2://game/launch?offerIds=<offerId>` |
| `link2ea` | yes | `"C:\Program Files\Electronic Arts\EA Desktop\EA Desktop\Link2EA.exe" "%1" ...` → `link2ea://launchgame/<offerId>?platform=origin&theme=dark` |
| `battlenet` | **no** (client not installed) | `battlenet://<productCode>` |
| `uplay` | **no** (client not installed) | `uplay://launch/<gameId>/0` |
| `xbox`, `ms-windows-store` | yes (URL handlers, no command) | not used for launching games |

The URI payload formats (`rungameid`, `apps/...?action=launch`, `offerIds`, `launchgame`, `launch/<id>/0`) are the ones Playnite-style launchers use; their exact shapes are the store-integration task's responsibility (UNVERIFIED here beyond handler registration). UWP/Xbox games: AUMIDs from `Get-StartApps` (1194 ms, 186 entries), e.g. `Xbox360BackwardCompatibil.PrimaryConkerLiveReloade_ksqcvrsvwz2jp!App` ("Conker: Live and Reloaded") and `Xbox360BackwardCompatibil.PrimaryFuzionFrenzyFuzio_ksqcvrsvwz2jp!App`; package data from `Get-AppxPackage` (`PackageFamilyName`, `InstallLocation = C:\Program Files\WindowsApps\<pkg>`; the game's own tree is also under `C:\XboxGames\<Title>\Content` with `MicrosoftGame.config` listing `<Executable Name="EmuMenu\EmuMenu.exe" Id="App">`). Launch with `spawn('explorer.exe', ['shell:AppsFolder\\' + aumid], { detached: true, stdio: 'ignore' })` — the exact mechanism Playnite uses (its `GenericPlayController` detects `action.Path == "explorer.exe"` + regex `shell:AppsFolder\\(.+)!.+`). The launch itself was **not executed** here (blocked by the sandbox policy of this session): UNVERIFIED on this machine, VERIFIED as Playnite's method.

### 7.2 Emulators and .exe games with `child_process.spawn` (Node 24.22.1 behaviour VERIFIED)

```ts
import { spawn } from 'node:child_process'
export function launchExecutable(exe: string, args: string[], cwd = path.dirname(exe)) {
  const child = spawn(exe, args, {
    cwd,                 // emulators resolve cores/BIOS relative to cwd
    detached: true,      // own process group; survives launcher exit
    stdio: 'ignore',     // never pipe: a full pipe buffer would block the game
    windowsHide: false   // games need their window; use true only for console helpers (reg.exe, powershell.exe)
  })
  child.unref()
  return child.pid     // may be a launcher/stub that exits immediately -> tracking must not rely on this pid alone (section 7.4)
}
```

Rules: pass an **argv array** (Node quotes each argument with the `CommandLineToArgvW` convention; `"a b.exe"`-style paths are safe); never build a shell string from user data — with `shell: true` Node 24 prints `[DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated` (observed). `.bat`/`.cmd` launchers **must** use `shell: true` (plain spawn fails with `EINVAL`, observed: `spawnSync('C:\Program Files\nodejs\npm.cmd',['--version'])` → `error: EINVAL`; this is Node's CVE-2024-27980 hardening). `windowsVerbatimArguments: true` only for programs with non-standard parsers (rare; e.g. some `rundll32` calls). For ES-DE style find-rules, resolve the emulator path first (PATH lookup, Steam/Store install dirs, portable folder) and spawn the absolute path. For elevation, `shell.openPath` will not elevate; use the worker: `Start-Process -FilePath '<exe>' -Verb RunAs`.

### 7.3 Process enumeration options (timings VERIFIED, warm numbers from a long-lived PowerShell unless noted)

| Method | Time | Fields | Notes |
|---|---|---|---|
| `Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,ExecutablePath` | 236 ms first call, **83–101 ms** after | pid, ppid, name, **full path** (null for protected/elevated processes) | 319–357 processes |
| `Get-CimInstance -Query "SELECT ProcessId,Name,ExecutablePath FROM Win32_Process WHERE ExecutablePath LIKE 'C:\\Program Files (x86)\\Steam%'"` | **88–109 ms** | only matches | WQL `LIKE` needs `\\` escaping; returned steam.exe + steamwebhelper.exe paths |
| `Get-Process \| Select Id,ProcessName,Path` | 588 ms | path for only 125 of 323 processes (access denied for the rest) | worse than CIM |
| `tasklist /FO CSV /NH` | 444 ms | name, pid, session, memory — **no path** | spawn per call |
| `ps-list` 9.0.0 (`fastlist-0.3.0-x64.exe`) | **28–32 ms** | `pid, ppid, name` only on Windows (README: `cmd, cpu, memory, uid, path, startTime` "are not available on Windows") | cheapest tree/ppid walk |
| `wmic process get ...` | n/a | — | `wmic` is **not present** on this Windows build |
| fresh `powershell.exe` per call | +0.9–1.4 s | — | never |

### 7.4 Session tracking design (Playnite's, verified from `source/Playnite/Controllers/GenericGameController.cs` and `source/Playnite/Common/ProcessMonitor.cs`)

Playnite facts: `StartTracking(trackingAction, startupCheck, ..., trackingFrequency = 2000, trackingStartDelay = 0)`; optional initial `Task.Delay(trackingStartDelay)`; a startup loop runs `startupCheck()` every `trackingFrequency` until a pid is found (up to `maxFailCount = 5` consecutive exceptions); the main loop calls `trackingAction()` every 2000 ms and reports stopped on the **first** `false`; play time accumulates per iteration but an iteration whose stopwatch exceeds `trackingFrequency + 30_000` ms is skipped ("accounts for sleep or hibernation"); result `InvokeOnStopped(new GameStoppedEventArgs(playTimeMs / 1000))`. Monitors: `MonitorDirectory(dir)` appends a trailing separator ("prevents `c:\Fallout` from matching `c:\Fallout 2\`") and matches `procPath.StartsWith(dir, OrdinalIgnoreCase)`; `MonitorProcessTree(originalId)` adds any process whose parent is in the tracked set and keeps the set alive while any remain; `MonitorProcessNames(dir)` matches exe names collected with `Directory.GetFiles(dir, "*.exe", AllDirectories)`; `MonitorProcessName(name)` exact process name; all enumerate `Process.GetProcesses()` with `SessionId != 0`. Tracking modes: Default = process tree for File actions, directory watch for URL actions (install dir) and for `explorer.exe shell:AppsFolder` launches (UWP `WorkDir`); `Directory`, `Process`, `OriginalProcess`, `ProcessName` are the explicit modes.

GameDash design (main process, one `PsWorker`):

1. On launch record `startedAt`, the launch kind (`uri` / `exe` / `uwp`) and the **watch directory** (store install dir, emulator ROM? no — for emulators watch the emulator process tree; for store games watch the install dir; for UWP watch the package `InstallLocation` and `C:\XboxGames\<Title>`).
2. **Startup phase**: every 2000 ms run the WQL directory query (or `ps-list` tree walk from the spawned pid); the game is "running" the first time ≥1 process matches; give up after 120 s (URI launches may need the store client to start first; Playnite has no timeout — add one) and report "could not detect game".
3. **Running phase**: poll every 2000 ms; declare "ended" after **2 consecutive empty polls** (≈4 s grace; Playnite stops after 1 — the grace absorbs launcher→game hand-offs such as EA/Ubisoft stubs re-launching the real exe). Skip adding elapsed time for a poll gap > 32 s (sleep/hibernate). Persist `playtimeMs` += elapsed every poll so a crash never loses a session.
4. Tree mode for spawned emulators/exes: `ps-list` (30 ms) walking `ppid` from the spawned pid, plus the directory query as a fallback when the spawned process exits immediately (stubs).
5. Emit `session:started` / `session:ended` (§2.2) and write `lastPlayedAt`/`playtimeMs` to the library DB.

WQL helper used by the worker (escape backslashes twice: once for PowerShell's string, once for WQL):

```powershell
Get-CimInstance -Query "SELECT ProcessId,ParentProcessId,Name,ExecutablePath FROM Win32_Process WHERE ExecutablePath LIKE 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Game\\%'" | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath | ConvertTo-Json -Compress
```

### 7.5 Restoring and focusing the launcher after the game exits (docs VERIFIED; foreground behaviour UNVERIFIED)

When a session starts: `win.minimize()` (lets the game take the foreground; the launcher page becomes `hidden` → gamepad polling and animations stop by themselves). When it ends: `win.restore(); win.show(); win.focus(); win.moveTop()`; `app.focus()` on Windows "focuses on the application's first window" (`FocusOptions.steal` is `@platform darwin` only). Windows' foreground-lock rules can still refuse to bring us forward; fallback used by many launchers: `win.setAlwaysOnTop(true); win.focus(); win.setAlwaysOnTop(false)` and, if still not foreground, `win.flashFrame(true)`. If the launcher was fullscreen before the game: call `win.setFullScreen(true)` again after `restore()`; optionally resume the system-bar polling.

---

## 8. Windows registry reads without native modules

### 8.1 `reg.exe` findings (VERIFIED with `scratchpad\scripts\regtest.js` and `regtest2.js`)

* Views: `reg query HKLM\SOFTWARE\Valve\Steam /reg:32` returns the WOW6432Node data (`Language`, `InstallPath`, `SteamPID`, `ClientLauncherType`, `Universe`, `BetaName`, `Version REG_QWORD 0x6ad92f2d`, subkeys `Apps`, `NSIS`); `/reg:64` returns the native 64-bit key (same values here except no `Language`/`NSIS`). Without `/reg:*` a 64-bit caller gets the 64-bit view, so read `HKLM\SOFTWARE\WOW6432Node\...` explicitly or pass `/reg:32`.
* Output format: `    <name>    <REG_TYPE>    <data>` separated by 4 spaces; `REG_DWORD`/`REG_QWORD` as `0x...` hex; `REG_EXPAND_SZ` unexpanded (`%SystemRoot%\system32;...`); `REG_MULTI_SZ` joined with the literal `\0`; `REG_BINARY` as a hex string; missing key → exit code 1, stderr `ERROR: The system was unable to find the specified registry key or value.`, empty stdout. `reg query <key> /s` of the whole Uninstall key took 50 ms (PowerShell) / 396 ms (Node, 134 KB).
* **Encoding is lossy and depends on how the child is spawned** (observed on `DisplayName` values containing `™`/`®`): spawned from Node inheriting a console whose code page is 65001 → UTF-8 bytes (`e2 84 a2` = ™); spawned `detached: true` (no console) → **ANSI code page 1252** (`0x99` = ™, `0xae` = ®); spawned with `windowsHide: true` (hidden console, OEM code page 437) → **best-fit ASCII**: `Command & ConquerT Remastered Collection`, `Call of DutyR...`. A packaged GUI app has no console, so reg.exe output is either ANSI (non-Latin titles become `?`) or best-fit. **Do not use `reg.exe` for text that may be non-ASCII.**
* Lossless alternative: `reg export "<key>" <file> /y` writes **UTF-16LE with BOM** (`ff fe` observed): `"DisplayName"="7-Zip 26.01 (x64)"`, `"NoModify"=dword:00000001`, `REG_EXPAND_SZ` as `hex(2):25,00,55,00,...` (UTF-16LE bytes), `REG_MULTI_SZ` as `hex(7):`, binary as `hex:`; strings escape `\\` and `\"`. Parse with `Buffer.toString('utf16le')` and the line continuation `\` + newline for hex data.

Parser for `reg query` output (ASCII-safe keys only), from `regtest.js` (produced the JSON below):

```js
function parseRegOutput(text) {
  const result = {}; let current = null
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    if (/^HKEY_/.test(line)) { current = line.trim(); result[current] ??= { values: {}, subkeys: [] }; continue }
    const m = /^\s{4}(.*?)\s{4}(REG_[A-Z_]+)\s{4}(.*)$/.exec(line)
    if (m && current) {
      const [, name, type, data] = m; let value = data
      if (type === 'REG_DWORD' || type === 'REG_QWORD') value = Number.parseInt(data, 16)
      else if (type === 'REG_MULTI_SZ') value = data.split('\\0')
      else if (type === 'REG_BINARY') value = Buffer.from(data, 'hex')
      result[current].values[name === '(Default)' ? '' : name] = { type, value }
    }
  }
  for (const k of Object.keys(result)) { const parent = k.slice(0, k.lastIndexOf('\\')); if (result[parent]) result[parent].subkeys.push(k.slice(k.lastIndexOf('\\') + 1)) }
  return result
}
// HKCU\Software\Valve\Steam -> values Language REG_SZ "english", SteamExe "c:/program files (x86)/steam/steam.exe",
// SteamPath "c:/program files (x86)/steam", AutoLoginUser "player_one", RunningAppID REG_DWORD 0, StartupModeTmp 7 ... ; subkeys ActiveProcess, Apps
```

### 8.2 Recommended helper: PowerShell `Get-ItemProperty` → JSON through the worker (VERIFIED, correct Unicode: `"Command \u0026 Conquer™ Remastered Collection"`, `"Call of Duty®: Modern Warfare® III"`, `"Intel® Graphics Software"`)

```ts
// registry.ts (main) — keys are constants from our code; names are validated with /^[\w\\ .()-]+$/ before interpolation
export async function readKey(ps: PsWorker, key: string) {
  // key like 'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam' (PowerShell drive syntax). 64-bit PowerShell: WOW6432Node = 32-bit view.
  return ps.json<{ values: Record<string, unknown>; kinds: Record<string, string>; subkeys: string[] } | null>(`
    $k = '${key.replace(/'/g, "''")}'
    if (-not (Test-Path -LiteralPath $k)) { 'null'; return }
    $item = Get-Item -LiteralPath $k
    $values = @{}; $kinds = @{}
    foreach ($n in $item.GetValueNames()) { $values[$n] = $item.GetValue($n, $null, 'DoNotExpandEnvironmentNames'); $kinds[$n] = [string]$item.GetValueKind($n) }
    @{ values = $values; kinds = $kinds; subkeys = @($item.GetSubKeyNames()) } | ConvertTo-Json -Compress -Depth 4`)
}
```

`GetValueKind` returns `String`, `ExpandString`, `DWord`, `QWord`, `MultiString`, `Binary` (verified: Steam HKCU values are `String`/`DWord`). Binary values serialize as byte arrays; expand `ExpandString` yourself with `process.env`. For a 32-bit view from 64-bit PowerShell without WOW6432Node paths: `[Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', [Microsoft.Win32.RegistryView]::Registry32).OpenSubKey('SOFTWARE\Valve\Steam')`.

### 8.3 Store clients on this machine (test data, VERIFIED)

| Client | Registry evidence | Files |
|---|---|---|
| **Steam** (installed, running, PID 25280) | `HKLM\SOFTWARE\WOW6432Node\Valve\Steam`: `InstallPath = C:\Program Files (x86)\Steam`, `Language = english`, `Version = 1792618285`, subkeys `Apps`, `NSIS`; `HKLM\SOFTWARE\Valve\Steam` (64-bit mirror); `HKCU\Software\Valve\Steam`: `SteamPath = c:/program files (x86)/steam`, `SteamExe`, `AutoLoginUser = player_one`, `RunningAppID = 0`, subkeys `ActiveProcess`, `Apps`; Run key `Steam = "C:\Program Files (x86)\Steam\steam.exe" -silent` | `C:\Program Files (x86)\Steam\steamapps\libraryfolders.vdf` and `config\libraryfolders.vdf` (1347 bytes; `"0" { "path" "C:\\Program Files (x86)\\Steam" ... "apps" { "2620" "954204780", "2640" ..., "403640" ... } }` — 30+ app ids) |
| **Epic Games Launcher** (installed, no games) | `HKLM\SOFTWARE\Epic Games\EpicGamesLauncher`: `AppDataPath = C:\ProgramData\Epic\EpicGamesLauncher\Data\`; `HKCU\Software\Epic Games\EOS`: `ModSdkCommand = C:/Program Files/Epic Games/Launcher/Portal/Binaries/Win64/EpicGamesLauncher.exe`, `ModSdkMetadataDir = C:/ProgramData/Epic/EpicGamesLauncher/Data/Manifests`; Uninstall entry `{FF454A0E-...} Epic Games Launcher`, `InstallLocation = C:\Program Files\Epic Games\`; no WOW6432Node key | `C:\ProgramData\Epic\EpicGamesLauncher\Data\Manifests` **does not exist** (nothing installed) |
| **GOG Galaxy 2.1.10.56** | `HKLM\SOFTWARE\WOW6432Node\GOG.com\GalaxyClient`: `clientExecutable = GalaxyClient.exe`, `version`; `...\GalaxyClient\paths`: `client = C:\Program Files (x86)\GOG Galaxy`; `HKLM\SOFTWARE\WOW6432Node\GOG.com\Games\<id>` for 3 games (`1454587428`, `1595922314`, `1897848199`) with `gameID`, `gameName = Fallout: New Vegas`, `path = C:\Program Files (x86)\GOG Galaxy\Games\Fallout New Vegas`, `exe`, `launchCommand`, `workingDir`; Run key `GogGalaxy = C:\Program Files (x86)\GOG Galaxy\GalaxyClient.exe /launchViaAutoStart` | |
| **EA app** | `HKLM\SOFTWARE\Electronic Arts\EA Desktop` (and WOW6432Node copy): `DesktopAppPath = C:\Program Files\Electronic Arts\EA Desktop\EA Desktop\EADesktop.exe`, `LauncherAppPath = ...\EALauncher.exe`, `EaConnectLink2EAAppPath = ...\Link2EA.exe`, `InstallLocation`, `InstallSuccessful = true`; `HKLM\SOFTWARE\WOW6432Node\Origin`: `ClientPath = ...\EADesktop.exe` | `C:\ProgramData\EA Desktop\{InstallData, Logs, PLR, machine.ini, <sha256 dirs>}` |
| **Battle.net** | all keys missing (`HKLM\SOFTWARE\WOW6432Node\Blizzard Entertainment\Battle.net`, HKCU, `battlenet` scheme) | not installed |
| **Ubisoft Connect** | all keys missing (`HKLM\SOFTWARE\WOW6432Node\Ubisoft\Launcher`, `\Installs`, HKCU, `uplay` scheme) | not installed |
| **Xbox app / Store** | `Microsoft.GamingApp 2611.1001.8.0` (PFN `Microsoft.GamingApp_8wekyb3d8bbwe`, AUMID `Microsoft.GamingApp_8wekyb3d8bbwe!Microsoft.Xbox.App`), `Microsoft.GamingServices 39.118.27001.0`; `HKLM\SOFTWARE\Microsoft\GamingServices\PackageRepository\Root\<guid>#<guid>` → `Package = Xbox360BackwardCompatibil.PrimaryConkerLiveReloade_2608.3123.1.0_x64__ksqcvrsvwz2jp`, `Root = \\?\C:\Program Files\WindowsApps\<pkg>\` | `C:\XboxGames\{Conker- Live and Reloaded, Fuzion Frenzy, GameSave}`; `...\Content\MicrosoftGame.config`, `appxmanifest.xml` |

Uninstall-key scan (`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall` + WOW6432Node + HKCU) also lists `GOG GALAXY`, `EA app`, `Epic Games Launcher`, `Epic Online Services`, `Steam`, `Xbox Service` — useful as a second presence signal.

---

## 9. Window, kiosk and desktop integration

### 9.1 Window options (docs VERIFIED; kiosk VERIFIED at runtime)

```ts
const win = new BrowserWindow({
  width: 1280, height: 800, minWidth: 960, minHeight: 540,
  show: false,                 // show on 'ready-to-show' to avoid a white flash
  backgroundColor: '#0b0f14',  // docs recommend setting it even with ready-to-show
  frame: false,                // frameless; Windows keeps WS_THICKFRAME (thickFrame default true) so edge resize still works
  autoHideMenuBar: true,       // Windows/Linux; Alt shows the menu — also call Menu.setApplicationMenu(null)
  fullscreen: settings.fullscreen,
  kiosk: false,                // kiosk = fullscreen + hides taskbar; verified: setKiosk(true) -> isKiosk true, isFullScreen true, bounds = whole display (0,0,1098,686 at 175 %; 1280x800 at forced 1.5)
  roundedCorners: false,       // Win11 draws rounded corners on frameless windows by default
  icon: path.join(process.resourcesPath, 'bin', 'app.ico'),   // ICO recommended on Windows; packaged exe icon is used when undefined
  webPreferences: { preload: path.join(import.meta.dirname, '../preload/index.cjs'), sandbox: true, contextIsolation: true, spellcheck: false, backgroundThrottling: true }
})
```

Other verified option defaults: `resizable true`, `movable true`, `minimizable true`, `skipTaskbar false` (macOS/Windows), `focusable true` ("On Windows, `focusable: false` also implies `skipTaskbar: true`"), `alwaysOnTop false`, `fullscreenable true`, `transparent false` ("On Windows, does not work unless the window is frameless"), `titleBarStyle 'default'` (`hidden` + `titleBarOverlay: true` gives the Windows Controls Overlay — not needed for a console UI), `backgroundMaterial` `auto|none|mica|acrylic|tabbed` (Windows 11). Kiosk vs fullscreen: use `fullscreen` (toggle with F11 / gamepad menu) for normal use and `kiosk` only for a "locked" mode; both cover the taskbar, neither blocks Alt+Tab/Win key.

### 9.2 Single instance, start with Windows, tray (docs VERIFIED)

```ts
if (!app.requestSingleInstanceLock({ argv: process.argv })) { app.quit() } else {
  app.on('second-instance', (_e, argv, _cwd, _additionalData) => { // argv of the 2nd instance (e.g. ['--launch=steam:2620'])
    const w = BrowserWindow.getAllWindows()[0]; if (w) { if (w.isMinimized()) w.restore(); w.show(); w.focus() }
    const launch = argv.find((a) => a.startsWith('--launch='))?.slice(9); if (launch) void launcher.launch(launch)
  })
}
app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args: ['--minimized'], name: 'GameDash' })
// Windows: writes HKCU\Software\Microsoft\Windows\CurrentVersion\Run (observed format for other apps: "C:\...\steam.exe" -silent);
// 'enabled' toggles the StartupApproved key; 'openAsHidden' was removed in Electron 45 -> use our own --minimized flag.
// getLoginItemSettings({ path, args }) must receive the same path/args ("you need to pass the same arguments here").
// Portable target: electron-builder's stub extracts the app to %TEMP%\nsXXXX.tmp\app and RMDir /r-deletes it on exit
// (dist/builder-debug.yml, portable NSIS script), so process.execPath is a temporary path there. The stub exports
// PORTABLE_EXECUTABLE_FILE (full path of the real exe) and PORTABLE_EXECUTABLE_DIR to the app; always pass
// path: process.env.PORTABLE_EXECUTABLE_FILE ?? process.execPath to set/getLoginItemSettings.
// Observed default: {"launchItems":[],"executableWillLaunchAtLogin":false,"openAtLogin":false,"wasOpenedAtLogin":false}
const tray = new Tray(path.join(process.resourcesPath, 'bin', 'tray.ico'))   // keep the reference alive; ICO "to get best visual effects"
tray.setToolTip('GameDash'); tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Open', click: showMain }, { label: 'Quit', click: () => app.quit() }]))
tray.on('click', showMain)
win.on('close', (e) => { if (settings.minimizeToTray && !quitting) { e.preventDefault(); win.hide() } })
```

Also: `electronApp.setAppUserModelId('com.gamedash.app')` from `@electron-toolkit/utils` (`setAppUserModelId(id)` — Windows; the id "is used only when the app is packaged"), `optimizer.watchWindowShortcuts(window)` (F12 DevTools in dev, ignores Ctrl+R in production), `is.dev` = `!app.isPackaged`. A `Tray.guid` is only needed if the exe is unsigned and the path may change.

### 9.3 DPI scaling and console-style CSS (numbers VERIFIED)

Chromium handles Windows per-monitor DPI; CSS px = physical px ÷ scale factor (`screen.getPrimaryDisplay().scaleFactor`; `Display` also exposes `size`, `workArea`, `bounds` in DIP, `internal`, `touchSupport`, `displayFrequency`, `rotation`; `screen.on('display-metrics-changed', (e, display, changedMetrics)` for `scaleFactor` changes). This panel: 1920x1200 at 175 % → `window.screen` 1098x686, `devicePixelRatio 1.75`. Viewport table:

| Panel | 100 % | 125 % | 150 % | 175 % | 200 % |
|---|---|---|---|---|---|
| 1280x800 (Steam Deck/ROG Ally class) | 1280x800 | 1024x640 | 853x533 | 731x457 | 640x400 |
| 1920x1080 | 1920x1080 | 1536x864 | 1280x720 | 1097x617 | 960x540 |
| 1920x1200 (this laptop) | 1920x1200 | 1536x960 | 1280x800 | **1098x686** | 960x600 |

Make the UI scale like a console UI regardless of the OS scale: derive the root font size from the viewport height and lay everything out in `rem`/`vh`/`vw`:

```css
html { font-size: calc(100vh / 45); }     /* verified: 367 px tall viewport -> 8.165 px; 1280x800 at 100 % -> 17.8 px */
:root { --gutter: 2rem; --tile-w: 14rem; --tile-h: 21rem; --bar-h: 3rem; }
body { margin: 0; overflow: hidden; font: 1rem/1.3 "Inter Variable", system-ui; }
@media (max-aspect-ratio: 4/3) { html { font-size: calc(100vw / 60); } }   /* portrait/odd panels: fall back to width */
```

Optionally clamp: `font-size: clamp(10px, calc(100vh / 45), 28px)`. Do not use `webContents.setZoomFactor` for this (OS/user zoom would compound). To emulate a handheld on the dev PC, start Electron with `--force-device-scale-factor=1.5` (verified: `devicePixelRatio 1.5`, window bounds/kiosk 1280x800 from the 1920x1200 panel; caveat: `window.screen.width/height` then reports the double-scaled 853x533 while `availWidth/availHeight` are 1280x800 — use `innerWidth/innerHeight`). Electron's command-line page does not list this switch; it is a Chromium switch passed through `app.commandLine.appendSwitch('force-device-scale-factor', '1.5')` before `ready` (verified working).

### 9.4 `--gd-screenshot=<path>` dev flag (capturePage VERIFIED)

`contents.capturePage([rect, opts])` → `Promise<NativeImage>` with `stayHidden`/`stayAwake` options; `nativeImage.toPNG()`; the image is in **physical pixels**: a 630x367 CSS content area produced 1103x643 at scale 1.75 and 936x537 at 1.5 (`capture.png` 24,460 bytes). Do not reuse Chromium's headless `--screenshot` switch name; use a namespaced flag:

```ts
// main: const shot = process.argv.find((a) => a.startsWith('--gd-screenshot='))?.split('=')[1]
// combine with --gd-size=1280x800 and app.commandLine.appendSwitch('force-device-scale-factor', '1') for deterministic pixels
ipcMain.once('ui:ready', async () => {              // renderer sends this after fonts/artwork settled (document.fonts.ready + first paint)
  if (!shot) return
  const img = await win.webContents.capturePage()
  await fs.promises.mkdir(path.dirname(shot), { recursive: true })
  await fs.promises.writeFile(shot, img.toPNG())
  app.exit(0)
})
```

Run: `.\out\...` is not needed — `npx electron . --gd-screenshot=C:\tmp\home.png --gd-size=1280x800` after `electron-vite build`, or `electron-vite preview -- --gd-screenshot=...` (UNVERIFIED that `preview` forwards args; the direct `electron .` form is what the harness used). Alternative for pixel-exact UI checks without Electron: `electron-vite dev --rendererOnly` + Playwright against `http://localhost:5173` with the mock API (Playwright `1.64.1` on npm; UNVERIFIED).

---

## 10. Fetching, downloads and the image cache

### 10.1 `net.fetch` vs Node `fetch` (docs + harness VERIFIED)

`net.fetch(input[, init])` uses "Chromium's network stack" (system proxy, Windows certificate store, `webRequest` handlers), supports `file:` and custom schemes (`bypassCustomProtocolHandlers: true` to skip them), not `data:`/`blob:`; `integrity` ignored; `Response.type/url` incorrect; only after `ready`; not in utility processes. Node's global `fetch` (undici) ignores the system proxy. Measured HEAD `https://www.electronjs.org/`: `net.fetch` 144–228 ms, Node `fetch` 138–251 ms — equivalent speed. **Decision: `net.fetch` for all scraper/CDN traffic** (proxy-aware, uses the OS trust store), with `AbortSignal.timeout(ms)`.

### 10.2 Download-to-disk with streaming, atomic rename (standard Node APIs; UNVERIFIED as a unit but each API is stable)

```ts
import { net } from 'electron'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import path from 'node:path'

export async function downloadTo(url: string, dest: string, opts: { timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<{ bytes: number; contentType: string | null }> {
  const res = await net.fetch(url, { headers: { 'User-Agent': 'GameDash/0.1 (+https://github.com/...)', ...opts.headers }, signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) })
  if (!res.ok || !res.body) throw Object.assign(new Error(`HTTP ${res.status} for ${url}`), { status: res.status, retryAfter: res.headers.get('retry-after') })
  await mkdir(path.dirname(dest), { recursive: true })
  const tmp = `${dest}.part`
  let bytes = 0
  try {
    await pipeline(Readable.fromWeb(res.body as never).on('data', (c: Buffer) => { bytes += c.length }), createWriteStream(tmp))
    await rename(tmp, dest)            // atomic within the volume; readers never see partial files
  } catch (e) { await rm(tmp, { force: true }); throw e }
  return { bytes, contentType: res.headers.get('content-type') }
}
```

### 10.3 Cache layout (under the short `userData`, §1.7)

```
%LOCALAPPDATA%\GameDash\                     <- app.setPath('userData', ...)
  config.json                                <- electron-store (name 'config'); schema-validated; migrations optional
  library\db.json                            <- lowdb JSONFilePreset (games, sessions) or our own zod-validated JSON store
  logs\main.log                              <- electron-log 5 (set log.transports.file.resolvePathFn)
  cache\images\<gameId>\cover-<sha1-12>.jpg  <- served as media://art/<gameId>/cover-<sha1-12>.jpg
  cache\images\<gameId>\hero-<sha1-12>.jpg, logo-<sha1-12>.png, icon-<sha1-12>.png
  cache\meta\<provider>\<id>.json            <- raw API responses with fetchedAt + etag for revalidation
  session\                                   <- app.setPath('sessionData', ...) : Chromium caches/localStorage (optional split)
```

`<sha1-12>` = first 12 hex chars of SHA-1 of the source URL (short names, no illegal characters, deterministic re-fetch detection). Store the relative cache path in the library DB, never absolute paths. `gameId` must be file-system safe (`steam-2620`, `rom-snes-<hash>`).

### 10.4 Concurrency and retry for scrapers

* Per-host limiter with `p-limit` (7.3.3): SteamGridDB 4, IGDB 2 (its documented limit is 4 req/s — UNVERIFIED here, see the metadata research), ScreenScraper 1 (user-tier thread limits), TheGamesDB 2, Steam store/CDN 4, HowLongToBeat 1; a global cap of 8 in-flight downloads.
* `p-retry` (8.0.1): `retries: 3, factor: 2, minTimeout: 500, maxTimeout: 8000, randomize: true`; abort (no retry) on 400/401/403/404; on 429/503 honour `Retry-After` (seconds or HTTP date) before the next attempt; retry on network errors (`p-retry` treats `is-network-error` failures as retryable).
* Revalidate with `If-None-Match`/`ETag` from `cache\meta`; treat 304 as a hit. Persist a per-provider "backoff until" timestamp so a 429 storm does not repeat on restart.

---

## 11. Decisions

1. **Scaffold**: `npm create @quick-start/electron@latest gamedash -- --template react-ts --skip`; pin the versions in §1.1 exactly (`electron 45.1.0`, `electron-vite 6.0.0`, `vite 8.3.5`, `react 19.3.1`, `typescript 5.9.3`, `electron-builder 26.18.0`, `@types/node 24.19.2`).
2. **Module formats**: `"type": "module"`; ESM main process; preload forced to CJS (`format: 'cjs'` → `out/preload/index.cjs`), dependency-free, `sandbox: true` + `contextIsolation: true` everywhere. Use `import.meta.dirname`.
3. **No native modules**; all OS access via one persistent `powershell.exe` worker (CIM/WMI, WinRT, CoreAudio COM via `Add-Type`), `ps-list` for cheap pid/ppid walks, Node `os` for CPU/RAM.
4. **Renderer served from `app://bundle/`** in production (never `file://` — a `file://` page can `fetch()` any local file), artwork from `media://art/...` with `corsEnabled: true` + `Access-Control-Allow-Origin: *`, path-traversal guard via `path.relative`.
5. **Typed IPC**: single `GameDashApi` type shared by main/preload/renderer; `ipcMain.handle` + zod schemas + sender-origin check; events via an allow-listed `on()`; mock implementation selected automatically when `window.gamedash` is absent (`electron-vite dev --rendererOnly`).
6. **Gamepad**: rAF polling in the renderer, standard-mapping indices, radial deadzone 0.25, repeat 400/120/60 ms, Norigin for spatial focus (`-core 4.2.0` + `-react 3.3.0`, `init({ shouldFocusDOMNode: true, distanceCalculationMethod: 'center' })`), haptics via `playEffect('dual-rumble', …)` only while visible. Accept that Xbox/XInput pads are silent while the launcher is unfocused (Windows rule) — session end is detected by process polling, not by a button.
7. **Touch**: Pointer Events only, native pan via `touch-action`, tap-vs-swipe threshold 10 px/300 ms; **in-app on-screen keyboard** as the primary text input for gamepad users, Windows' touch keyboard via `virtualkeyboardpolicy="manual"` + `navigator.virtualKeyboard.show()` for touch, `osk.exe` as an opt-in fallback. No TabTip/ITipInvocation hacks (verified ineffective on 26300).
8. **System bar**: `navigator.getBattery()` + `powerMonitor` for power; WinRT `Radio.GetRadiosAsync()` (4 ms) for Wi‑Fi/Bluetooth radio state; `netsh wlan show interfaces` for SSID/signal; CoreAudio COM for volume; `WmiMonitorBrightness(Methods)` for brightness (works as a standard user; internal panels only); `powercfg /overlaysetactive` + registry `ActiveOverlayAcPowerScheme` for the Windows 11 power mode; `shutdown.exe`/`LockWorkStation`/`SetSuspendState` for power actions; cadence in §6.9.
9. **Launch/track**: `shell.openExternal` for store URIs, `spawn` (argv array, `detached`, `stdio: 'ignore'`, `cwd`) for exes/emulators, `explorer.exe shell:AppsFolder\<AUMID>` for UWP; Playnite-style 2 s polling with WQL `ExecutablePath LIKE '<installDir>\\%'`, 2-miss grace, 32 s sleep skip, 120 s startup timeout; minimize on start, restore/focus/moveTop on end.
10. **Registry**: PowerShell `Get-ItemProperty`/`Get-Item` → JSON (Unicode-correct), explicit `WOW6432Node` paths; `reg.exe` only for ASCII keys; `reg export` (UTF‑16) if a shell-free lossless path is ever needed.
11. **Packaging**: electron-builder NSIS assisted per-user installer (`oneClick: false`, `perMachine: false`, `allowToChangeInstallationDirectory: true`) + portable exe (`unpackDirName: gamedash`), `asar: true` with `asarUnpack` for `resources/**` and `node_modules/ps-list/vendor/**`, `extraResources` for helper binaries, `requestedExecutionLevel: asInvoker`, `userData` = `%LOCALAPPDATA%\GameDash` (short path; Chromium fails on >260-char paths).
12. **Fetching**: `net.fetch` + streaming to `.part` + rename; per-host `p-limit`, `p-retry` with `Retry-After`; cache keyed by game id + hashed URL.

## 12. Artifacts produced during verification

* This report: `C:\Users\<user>\AppData\Local\Temp\<scratch>`
* Scaffold (template output + pinned `package.json`, `node_modules` installed): `...\scratchpad\scaffold\gamedash` (8.3 alias `C:\Users\<user>\AppData\Local\Temp\<scratch>`).
* Working copy used for the build/run tests (short path, because cmd.exe and Chromium cannot use the scratchpad path): `C:\Users\<user>\AppData\Local\Temp\gd-verify\` — modified `electron.vite.config.ts`, `src/main/index.ts`, `src/preload/index.ts`, `src/preload/index.d.ts`, `src/renderer/src/App.tsx`, built `out\`, run logs `run-output.txt`; harness copy and results in `harness\` (`main.cjs`, `index.html`, `out\results.json`, `out\results-1.5.json`, `out\capture.png`, `out\capture-1.5.png`).
* Test scripts: `...\scratchpad\scripts\regtest.js`, `regtest2.js`, `pstest.js`, `electron-test\main.cjs`, `electron-test\index.html`.
* Side effects to clean up if desired: the verification app wrote `C:\Users\<user>\AppData\Roaming\gamedash\` (`gamedash-verify.json` cleared, `logs\verify.log`, `gamedash-verify-db.json`); an earlier harness run may have created `C:\Users\<user>\AppData\Roaming\Electron\`; nothing was installed globally and no system setting was changed (brightness/power-plan/overlay calls were no-op sets to the current values).
