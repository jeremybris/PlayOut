OPTISCALER INSTALL SPEC (checked 2026-11-19 against release v0.9.5, setup_windows.bat v2.8 from inside the archive, and the wiki clone at its 2026-11-18 commit)

Local evidence (scratchpad, all from the real release):
- Archive: C:\Users\<user>\AppData\Local\Temp\<scratch>
- Extracted text files only (setup_windows.bat, OptiScaler.ini, fakenvapi.ini, README txt, setup_linux.sh, README.md): C:\Users\<user>\AppData\Local\Temp\<scratch>
- Wiki clone: C:\Users\<user>\AppData\Local\Temp\<scratch>
No binaries were run.

== 1. RELEASE DISCOVERY ==
API: GET https://api.github.com/repos/optiscaler/OptiScaler/releases/latest (send a User-Agent header; repo default branch is "master").
Latest: tag v0.9.5, name "v0.9.5", published 2026-11-16T19:17:35Z, prerelease=false, one asset:
  Optiscaler_0.9.5-final.20261116.7z, 70,418,897 bytes
  https://github.com/optiscaler/OptiScaler/releases/download/v0.9.5/Optiscaler_0.9.5-final.20261116.7z
Past asset names (the suffix is not stable, so match a pattern):
  v0.9.4 Optiscaler_0.9.4-final.20260718._MM.7z
  v0.9.3 Optiscaler_0.9.3-final.20260618.7z
  v0.9.2 Optiscaler_0.9.2a-final.20260517._Reup.7z
  v0.9.1 Optiscaler_0.9.1-final.20260427._DSB.7z
Suggested asset regex: /^Optiscaler_.*\.7z$/i, taking the first match. There is also a "nightly" tag (releases/tag/nightly); skip it for stable installs.
Archive format: 7z, LZMA2:26 LZMA:20 BCJ2, solid, 2 blocks. You need a 7z extractor, for example 7z.exe/7za.exe or a node 7z library. ZIP code will not read it.

Full archive listing. Everything sits at the archive root: there is no wrapping folder, 23 files and 2 folders, 294,704,697 bytes unpacked.
  !! README_EXTRACT ALL FILES TO GAME FOLDER !!.txt   400
  fakenvapi.ini                                       466
  OptiScaler.ini                                      47713
  setup_linux.sh                                      12328
  setup_windows.bat                                   16947
  amd_fidelityfx_dx12.dll                             39184
  amd_fidelityfx_framegeneration_dx12.dll             29679376
  amd_fidelityfx_framegeneration_vk.dll               36806928
  amd_fidelityfx_upscaler_dx12.dll                    57664272
  amd_fidelityfx_upscaler_vk.dll                      36135696
  amd_fidelityfx_vk.dll                               39184
  dlssg_to_fsr3_amd_is_better.dll                     3038208   (Nukem's DLSSG->FSR3 FG mod)
  fakenvapi.dll                                       415232
  libxell.dll                                         415368
  libxess.dll                                         77795704
  libxess_dx11.dll                                    156016
  libxess_fg.dll                                      22957432
  OptiScaler.dll                                      26052912
  D3D12_Optiscaler\D3D12Core.dll                      3351064  (Agility SDK, used only for FSR4 on Windows 10)
  Licenses\DirectX_LICENSE.txt, Licenses\FidelityFX_v1_LICENSE.md, Licenses\FidelityFX_v2_LICENSE.md, Licenses\XeSS_LICENSE.txt
Files that are NOT in the archive: remove_optiscaler.bat (setup_windows.bat writes "Remove_OptiScaler.bat" after a successful setup), nvngx.dll, nvngx_dlss.dll, nvapi64.dll, plugins\.
The README txt only points to the GitHub page and wiki. It also says: "FSR4 on Win 10 - if crashing, requires the D3D12_Optiscaler folder and FsrAgilitySDKUpgrade=true".
fakenvapi.ini defaults are enable_logs=1, enable_trace_logs=0, force_latencyflex=0, latencyflex_mode=0, force_reflex=0 (0 = follow game, 1 = force off, 2 = force on).
fakenvapi.dll is NOT renamed to nvapi64.dll. OptiScaler loads it itself:
- [NvApi] OverrideNvapiDll=auto means "false for Nvidia, true for others".
- [Libraries] NvapiPath=auto looks for "nvapi64.dll or fakenvapi.dll".
So copying it next to OptiScaler is harmless on Nvidia.

== 2. setup_windows.bat (v2.8) STEP BY STEP ==
The script runs in its own folder, which must be the folder the archive was extracted into, next to the game exe.
a) Deletes "!! README_EXTRACT ALL FILES TO GAME FOLDER !!.txt".
b) Wrong download: if OptiScaler.sln exists it aborts ("you have the source code").
c) If OptiScaler.dll is missing it aborts. The message blames folder permissions or says to rename the dll manually.
d) Leftover-install check. It sets OLD_FILES_FOUND when any of these exist:
   - nvapi64.dll, nvngx.dll, OptiScaler.asi, "Remove OptiScaler.bat", "Remove_OptiScaler.bat"
   - any of dxgi.dll, winmm.dll, d3d12.dll, dbghelp.dll, version.dll, wininet.dll, winhttp.dll whose PE VersionInfo OriginalFilename equals "OptiScaler.dll" (case-insensitive). It reads this with PowerShell (Get-Item f).VersionInfo.OriginalFilename. These names go into OPTI_DLL_LIST.
   It then asks "[1] Yes [2] No" to delete them. On Yes it deletes the files listed above plus OPTI_DLL_LIST.
   TS port: read the VS_VERSION_INFO OriginalFilename string from the PE resource. This is how you tell OptiScaler's own proxy dll from someone else's dxgi.dll.
e) Unreal check: if a subfolder ".\Engine" exists in the current folder, it warns "extract Optiscaler to #CODENAME#\Binaries\Win64, Do not extract to the Engine folder". Examples given: \Jedi Survivor\SwGame\Binaries\Win64, \Witchfire\Witchfire\Binaries\Win64. It asks to continue (1) or quit.
f) Filename choice. Hints: "default is dxgi.dll, most compatible"; "For Vulkan, use winmm.dll. For XGP/MS Store, winmm/version.dll may be better". Options:
   [1] dxgi.dll (also chosen on Enter), [2] winmm.dll, [3] version.dll, [4] dbghelp.dll, [5] d3d12.dll, [6] wininet.dll, [7] winhttp.dll, [8] OptiScaler.asi
g) Conflict check: if the chosen name already exists it shows "WARNING: <name> already exists" and asks to overwrite. Yes sets overwriteChoice=1, which deletes the existing file before renaming. No goes back to filename selection.
   - There is no specific detection of ReShade or Special K. It is only an "exists" check. Step (d) only catches old OptiScaler dlls.
   - The wiki's sideloading advice (Compatibility-with-other-mods page):
     * Use a different proxy name (for example winmm.dll).
     * Or move the other mod's dll into a "plugins" subfolder under the same name (e.g. plugins\dxgi.dll). OptiScaler chain-loads it. [Plugins] Path default is plugins under OptiDllPath.
     * ReShade: rename it to ReShade64.dll next to OptiScaler and set LoadReshade=true.
     * Special K: SpecialK64.dll plus an empty SpecialK.dxgi file, and LoadSpecialK=true. This does not work with OptiFG, DLSSG via SL or FSR-FG inputs.
h) Wine check: reg query HKCU\Software\Wine\DllOverrides. If present it skips the GPU questions and goes to completeSetup.
i) GPU detection: if %windir%\system32\nvapi64.dll exists, Nvidia is the default guess. It always asks "[1] AMD/Intel [2] Nvidia" and loops until it gets 1 or 2.
   - Nvidia (2): no ini edits and no OptiPatcher. Goes straight to completeSetup.
j) AMD/Intel (1): asks "Will you try to use DLSS inputs to replace with FSR/XeSS? (enables Nvidia spoofing, required for DLSS-FG, Reflex->AL2)". [1] Yes, also chosen on Enter; [2] No.
   - No: this is the ONLY spoofing ini edit. It does a literal text replace in OptiScaler.ini: "Dxgi=auto" -> "Dxgi=false" (key under [Spoofing]).
   - Yes: no edit. Dxgi=auto already means "true for AMD/Intel, false for Nvidia".
k) OptiPatcher, AMD/Intel only:
   - If plugins\*OptiPatcher*.asi already exists, it asks whether to re-download. Yes deletes it; No skips to completeSetup.
   - It pings github.com and skips this step if offline.
   - It fetches https://raw.githubusercontent.com/optiscaler/OptiPatcher/main/OptiPatcher/dllmain.cpp and builds a supported-exe list:
     * every regex match CHECK_UE\s*\(\s*([a-zA-Z0-9_]+)\s*\) adds "<name>-win64-shipping.exe" and "<name>-wingdk-shipping.exe", lowercased
     * every match exeName\s*==\s*["']([^"']+)["'] adds that name, lowercased
     * Today this finds 192 matching lines. Example: CHECK_UE(oblivionremastered).
   - If any *.exe in the current folder matches (case-insensitive), it asks "Download OptiPatcher.asi?". Yes:
     * mkdir plugins
     * download https://github.com/optiscaler/OptiPatcher/releases/download/rolling/OptiPatcher.asi to plugins\OptiPatcher.asi (current asset 120,320 bytes, published 2026-05-14)
     * replace "LoadAsiPlugins=auto" with "LoadAsiPlugins=true" in OptiScaler.ini (key under [Plugins])
l) completeSetup:
   - if overwrite was chosen, del /F <chosenName>
   - rename OptiScaler.dll -> <chosenName>; on failure it aborts with a permissions message
   - write Remove_OptiScaler.bat
   - after the final pause, delete setup_linux.sh and the setup bat itself
   The script copies nothing else. All other files stay where they were extracted, next to the exe. It never handles nvngx_dlss.dll. fakenvapi.dll is already in the archive for every GPU type, and the script never copies it per vendor or renames it to nvapi64.dll.

What Remove_OptiScaler.bat (generated) deletes:
- It rebuilds OPTI_DLL_LIST with the same OriginalFilename=="OptiScaler.dll" scan over dxgi/winmm/d3d12/dbghelp/version/wininet/winhttp.dll, and also checks OptiScaler.asi.
- It asks "[1] Yes [2] No". On Yes it deletes:
  OptiScaler.log, OptiScaler.ini, OptiScaler.asi, fakenvapi.dll, fakenvapi.ini, fakenvapi.log, dlssg_to_fsr3_amd_is_better.dll, dlssg_to_fsr3.log
  D3D12_Optiscaler\* + rd D3D12_Optiscaler
  DlssOverrides\* + rd DlssOverrides
  Licenses\* + rd Licenses
  every OPTI_DLL_LIST entry (the renamed proxy dll)
  plugins\OptiPatcher.asi + rd plugins (the rd only succeeds if plugins is empty)
  and finally the bat itself.
- It does NOT delete amd_fidelityfx_*.dll, libxess*.dll or libxell.dll. This is deliberate: the Updating wiki page says it removes everything "excluding the upscaler/FG binaries", because the game may ship its own copies.
- Wiki Uninstallation.md (manual) adds: also delete nvapi64.dll and the dlssg_to_fsr3 files. Restore any libxess.dll / amd_fidelityfx files you backed up. Delete them only if the game did not have them before.

== 3. RECOMMENDED DEFAULTS / INI KEYS ==
All keys ship as "auto". The ini is about 1,360 lines in [Section] / key=value format, and each key has ";" comment lines above it. Edit values in place.
Relevant keys and their auto meanings:
  [Upscalers]
    Dx11Upscaler: auto = fsr22. Options: fsr22, fsr31, xess (Arc only), xess_12, fsr21_12, fsr22_12, fsr31_12 (FSR4), dlss.
    Dx12Upscaler: auto = xess. Options: xess, fsr21, fsr22, fsr31 (also FSR4), dlss.
    VulkanUpscaler: auto = fsr22. Options: fsr21, fsr22, fsr31, xess, fsr21_12, fsr31_12 (FSR4), dlss.
  [FrameGen]
    Enabled: auto = false.
    FGInput: auto = nofg. Options: nofg, dlssg, nukems, fsrfg, upscaler, fsrfg30.
    FGOutput: auto = nofg. Options: nofg, fsrfg, xefg, nukems.
  [FSR]
    Fsr4Update: auto = true on RDNA2/3/4.
    FsrAgilitySDKUpgrade: auto = false. Set it to true for FSR4 on Windows 10, and only together with the D3D12_Optiscaler folder.
  [Spoofing]
    Dxgi: auto = true for AMD/Intel, false for Nvidia.
    SpoofedVendorId=0x10de, SpoofedDeviceId=0x2684, SpoofedGPUName "NVIDIA GeForce RTX 4090".
    StreamlineSpoofing: auto = true.
    Vulkan: auto = false; set Vulkan=true for Vulkan DLSS spoofing.
  [Plugins] LoadAsiPlugins (auto = false), LoadReshade, LoadSpecialK, Path.
  [NvApi] OverrideNvapiDll: auto = false for Nvidia, true for others.
  [Menu]
    OverlayMenu: auto = true unless running as nvngx.dll.
    ShortcutKey: auto = 0x2D (Insert). The FG toggle key is End (FGShortcutKey).
  [Libraries] OptiDllPath and per-dll paths: NvngxDlssPath, XeSSPath, FfxDx12Path, etc.
Wiki guidance for AMD/Intel:
- Spoofing stays on (Dxgi=auto). Answer Yes to DLSS inputs, especially if the game only has DLSS or you need Nukem FG or Reflex->AL2.
- Answer No (Dxgi=false) only if spoofing causes problems.
- The upscaler output is picked in the in-game overlay (Insert). The DX12 default output is XeSS. On AMD RDNA2+ choose FSR 3.X/4 (fsr31), which gives FSR4.
- If DLSS inputs still do not show, fakenvapi is needed. It is already bundled since 0.9.
Suggested PlayOut ini writes, all optional:
- AMD RDNA2+: [Upscalers] Dx12Upscaler=fsr31, Dx11Upscaler=fsr31_12, VulkanUpscaler=fsr31_12.
- Intel: Dx12Upscaler=xess.
- Leave Dxgi=auto.
- Win10 + FSR4: FsrAgilitySDKUpgrade=true.
Nvidia users generally need none of this.
Uninstall list for PlayOut. Record in a manifest exactly which files were written and which pre-existing files were overwritten (back those up first), then remove only what you wrote and restore the backups:
- the renamed proxy dll
- OptiScaler.ini / .log
- fakenvapi.dll / .ini / .log
- dlssg_to_fsr3_amd_is_better.dll, dlssg_to_fsr3.log
- D3D12_Optiscaler\, Licenses\, DlssOverrides\
- plugins\OptiPatcher.asi (and plugins\ if empty)
- Remove_OptiScaler.bat, setup_windows.bat, setup_linux.sh, the README txt
- amd_fidelityfx_*.dll, libxess*.dll, libxell.dll, but only if they did not exist before install

== 4. PICKING THE EXE FOLDER / DETECTION ==
Wiki rule (Manual-Installation.md and Automated-Installation.md): extract all files next to the main game exe.
- Unreal: look for the *-Win64-Shipping.exe in <Game>\<ProjectName>\Binaries\Win64 or ...\Binaries\WinGDK\ (WinGDK is the Xbox/MS Store build). Ignore the Engine folder; the bat warns when .\Engine sits in the chosen folder.
- Example paths from the wiki: Expedition 33\Sandfall\Binaries\Win64, Jedi Survivor\SwGame\Binaries\Win64, Cyberpunk 2077\bin\x64, HITMAN 3\Retail, Warhammer 40,000 DARKTIDE\binaries, The Witcher 3\bin\x64_dx12.
- TS heuristic:
  1. Recursively search for /-(Win64|WinGDK)-Shipping\.exe$/i, excluding paths under \Engine\.
  2. If found, use its folder.
  3. Otherwise use the folder of the launch exe, and skip launchers and crash reporters.
  4. Wiki naming hints: "For Vulkan, use winmm.dll. For XGP/MS Store, winmm/version.dll may be better." If DLSS crashes, try d3d12.dll. OptiScaler.asi needs Ultimate ASI Loader.
- Never use it with online or anti-cheat games; the wiki gives a ban warning.
Compatibility list:
- Page: https://github.com/optiscaler/OptiScaler/wiki/Compatibility-List
- Raw markdown: https://raw.githubusercontent.com/wiki/optiscaler/OptiScaler/Compatibility-List.md (HTTP 200, about 176 KB). The FSR4 list has been merged into it.
- Table header: | Game | Compatibility | Upscaler <br>Inputs | OptiPatcher <br>Support | Notes | Images |
- Sample row: | [007 First Light](007-First-Light) | ✅ | DLSS, FSR3.1/4 |  | notes | [1](url) |
  * The game cell is either plain text or [Name](Wiki-Page-Slug). Per-game pages are at https://github.com/optiscaler/OptiScaler/wiki/<Slug> (raw: .../wiki/optiscaler/OptiScaler/<Slug>.md or .asciidoc).
  * Status column values counted: ✅ 713, ❌ 3, ➖ 2, ✔️/❌ 2. ✨ in column 4 means OptiPatcher support.
  * Later "## Upscaler mods support" and "## Luma Unreal Engine" sections reuse the table format.
  * Header counts: 719 working, 215 OptiPatcher, 3 not working; last updated 12 November 2026.
DLSS / input detection. OptiScaler only works in games that already have DLSS2+, FSR2+ or XeSS inputs. In OptiScaler/DllNames.h at v0.9.5, OptiScaler watches for these modules (file presence in the game tree is a good static hint):
- DLSS: nvngx_dlss.dll. It is often under Engine\Plugins\... in UE games, so search the whole game tree. DLSS-FG: nvngx_dlssg.dll.
- Streamline: sl.interposer.dll, sl.dlss.dll, sl.dlss_g.dll (DLSSG input, so the FGInput=dlssg/nukems options apply), sl.reflex.dll, sl.pcl.dll, sl.common.dll.
- XeSS: libxess.dll, libxess_dx11.dll, libxess_fg.dll.
- FSR2/3: ffx_fsr2_api_x64.dll, ffx_fsr2_api_dx12_x64.dll, ffx_fsr3upscaler_x64.dll, ffx_backend_dx12_x64.dll, amd_fidelityfx_dx12.dll / amd_fidelityfx_loader_dx12.dll, amd_fidelityfx_upscaler_dx12.dll, amd_fidelityfx_framegeneration_dx12.dll.
- Many FSR2/UE games link FSR statically, so a missing dll does not prove the input is absent. Use the compat list as a second signal.
nvngx_dlss.dll present => DLSS inputs are available. With spoofing (AMD/Intel), OptiScaler locates nvngx_dlss.dll automatically since 0.7.7 or 0.7.8; the old nvngx.dll copy step is obsolete. Override with [Libraries] NvngxDlssPath.
FSR2/3-only games without DLSS (e.g. The Callisto Protocol, The Outer Worlds Spacer's Choice): the user must supply nvngx_dlss.dll to get DLSS inputs (wiki links TechPowerUp). PlayOut should not bundle NVIDIA files; FSR/XeSS inputs still work without it.
Existing libxess.dll or amd_fidelityfx_*.dll in the exe folder means the game ships those upscalers. Extracting all files overwrites them, so back them up (wiki Uninstallation.md).

== TS INSTALL ALGORITHM (equivalent to the bat) ==
1. GET releases/latest and pick the .7z asset. Download it to cache, then extract to a temp folder.
2. Resolve targetDir (rules in section 4).
3. Detect a previous install: proxy-name dlls whose PE OriginalFilename is "OptiScaler.dll", plus nvngx.dll, nvapi64.dll, OptiScaler.asi, and either Remove bat name. Offer to remove them.
4. Choose a proxy name: default dxgi.dll, winmm.dll for Vulkan. If that name exists and is not OptiScaler (ReShade, Special K, etc.), either choose the next free name from [winmm, version, dbghelp, d3d12, wininet, winhttp] or move the existing file to plugins\<sameName>.
5. Back up any game files that would be overwritten, then copy every archive file except the setup scripts and the README txt. Copy OptiScaler.dll as <proxyName>. Keep the ini named OptiScaler.ini; the wiki says not to rename it.
6. GPU vendor:
   - Nvidia: no edits. Optionally skip fakenvapi and dlssg_to_fsr3.
   - AMD/Intel: keep Dxgi=auto. Optionally run the OptiPatcher check from step k and write LoadAsiPlugins=true. Optionally set the upscaler keys from section 3. On Win10, enable FsrAgilitySDKUpgrade only if FSR4 is wanted.
7. Write the manifest used for uninstall.