PLAYOUT SPEC: GPU DETECTION + ANTI-CHEAT FOLDER DETECTION (gathered 2026-11-19)

Evidence base: live read-only queries on this Windows 11 machine (Intel Arc B390 iGPU only); the SteamDB FileDetectionRuleSets repo (MIT, rules.ini at commit 243cf741921d2c8fd6b844f83831edf4692cf788, 2026-04-01) and its tests/types/AntiCheat.*.txt; a read-only scan of the local Steam library; and vendor and community pages (listed under Sources). No binaries were run.

======================================================================
PART A: GPU DETECTION (Windows, from Node via powershell.exe -NoProfile -Command)
======================================================================

A1. Primary query (Win32_VideoController)
Get-CimInstance Win32_VideoController | Select-Object Name,PNPDeviceID,DriverVersion,AdapterRAM,AdapterCompatibility,VideoProcessor,CurrentHorizontalResolution,Status,ConfigManagerErrorCode | ConvertTo-Json -Compress

Real output on this machine:
  Name: Intel(R) Arc(TM) B390 GPU
  PNPDeviceID: PCI\VEN_8086&DEV_B080&SUBSYS_14B41043&REV_04\3&11583659&0&10
  DriverVersion: 32.0.101.9150
  AdapterRAM: 4293918720 (WRONG: the field is uint32 and caps near 4 GB, so never use it for VRAM)
  AdapterCompatibility: Intel Corporation
  CurrentHorizontalResolution: 1920 (null or 0 when the adapter drives no display)

Notes:
- ConvertTo-Json returns a single object, not an array, when there is one GPU. Wrap the result: @(...) | ConvertTo-Json, or normalize in JS with Array.isArray.
- Vendor comes from PNPDeviceID, using /VEN_([0-9A-F]{4})/i and /DEV_([0-9A-F]{4})/i:
  10DE = NVIDIA, 1002 (also 1022) = AMD, 8086 = Intel, 1414 = Microsoft Basic Render/Display (skip it), 5143 = Qualcomm.
- Skip these: PNPDeviceID not starting with "PCI\"; vendor 1414 (Microsoft Basic Display Adapter, Remote Display / Parsec / virtual display drivers such as "Virtual Display Driver" or "Meta Virtual Monitor"); ConfigManagerErrorCode != 0 (disabled or failed device).

A2. True VRAM and driver key per adapter (verified working here)
Map each PNPDeviceID to its driver class key, then read 64-bit memory:
$g = Get-CimInstance Win32_VideoController
foreach ($x in $g) {
  $drv = (Get-PnpDeviceProperty -InstanceId $x.PNPDeviceID -KeyName DEVPKEY_Device_Driver).Data   # e.g. {4d36e968-e325-11ce-bfc1-08002be10318}\0000
  $loc = (Get-PnpDeviceProperty -InstanceId $x.PNPDeviceID -KeyName DEVPKEY_Device_LocationInfo).Data  # e.g. "PCI bus 0, device 2, function 0"
  $k = Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Control\Class\$drv"
  [pscustomobject]@{ Name=$x.Name; Pnp=$x.PNPDeviceID; Driver=$x.DriverVersion; Mem=$k.'HardwareInformation.qwMemorySize'; Loc=$loc }
} | ConvertTo-Json -Compress

Seen here: HardwareInformation.qwMemorySize = 19327352832 for the Intel iGPU. That is the iGPU's shared-memory budget, not dedicated VRAM. On NVIDIA and AMD dGPUs this value is the dedicated VRAM. qwMemorySize is REG_QWORD and can be missing on older drivers. HardwareInformation.MemorySize (REG_BINARY or DWORD) is the legacy fallback.

A3. Best source for dedicated vs shared memory: the DirectX adapter cache (verified here)
HKLM:\SOFTWARE\Microsoft\DirectX\{GUID} subkeys, one per adapter the DXGI stack has seen. Values:
  Description, VendorId (DWORD, decimal), DeviceId, DedicatedVideoMemory, DedicatedSystemMemory, SharedSystemMemory, DriverVersion (QWORD), AdapterLuid, MaxD3D12FeatureLevel.

Real rows from this machine:
  {96657C75-...}  Description "Intel(R) Arc(TM) B390 GPU"; VendorId 32902 (0x8086); DeviceId 45184 (0xB080); DedicatedVideoMemory 134217728 (128 MB, the iGPU stolen memory); SharedSystemMemory 19207603691; DriverVersion 9007199261369278
  {76C18EA8-...}  Description "Microsoft Basic Render Driver"; VendorId 5140 (0x1414)  -> skip
  ShaderCache subkey has no values -> skip

The DriverVersion QWORD packs four 16-bit fields: a.b.c.d = (a<<48)|(b<<32)|(c<<16)|d.
Check: 32<<48 + 0 + 101<<16 + 9150 = 9007199261369278, which is 32.0.101.9150.
Decode it with BigInt. Values with a >= 32 exceed 2^53, so a JS Number loses precision. In PowerShell, emit it as a string, e.g. ([uint64]$p.DriverVersion).ToString(), or decode in PowerShell before JSON.

Caveat: stale keys for removed adapters can persist. Only trust rows whose VendorId/DeviceId match a present Win32_VideoController.

Dedicated rule: DedicatedVideoMemory >= 1 GiB means discrete. iGPUs report about 128-512 MB here.

A4. Picking the primary or dedicated GPU (iGPU + dGPU laptops and desktops)
Score the candidates left after filtering:
 1. Vendor 10DE: always discrete (NVIDIA has no x86 iGPUs).
 2. DirectX-cache DedicatedVideoMemory >= 1 GiB (or Class-key qwMemorySize >= 2 GiB with vendor 10DE/1002): discrete.
 3. Name heuristics for AMD and Intel:
    - AMD iGPU: /^AMD Radeon\(TM\) Graphics$/i, /Radeon(\(TM\))? (6\d0M|7\d0M|8\d0M|8\d{2}0S|Vega \d+)/i (680M, 760M, 780M, 880M, 890M, 8060S), "Radeon Vega".
    - AMD dGPU: /Radeon.*\bRX\s?\d{3,4}/i or "Radeon Pro W". Caveat: some handheld APUs are named RX? No. The Z1/Z2 report "AMD Radeon(TM) Graphics", which is iGPU.
    - Intel dGPU: /Arc\(TM\) [AB]\d{3}\b/ with A380/A580/A750/A770/B570/B580. "Arc(TM) Pro A".
    - Intel iGPU: "Arc(TM) Graphics", "Arc(TM) 130V/140V", "Arc(TM) B390/B370" (Panther Lake iGPU, confirmed here at 128 MB dedicated), "Iris", "UHD", "HD Graphics".
      Do not mark every Arc B-series as discrete. Use DedicatedVideoMemory instead.
 4. LocationInfo tie-breaker: "PCI bus 0, device 2" is the classic Intel iGPU slot (seen here). Discrete cards sit on bus >= 1.
 5. Final order: discrete first, then larger dedicated VRAM, then vendor priority NVIDIA > AMD > Intel. The adapter driving the display (CurrentHorizontalResolution > 0) only breaks ties among equals. On hybrid laptops the iGPU drives the panel even when a dGPU exists.
 Optional for NVIDIA: C:\Windows\System32\nvidia-smi.exe --query-gpu=name,driver_version,memory.total --format=csv,noheader prints e.g. "NVIDIA GeForce RTX 4070, 561.56, 12282 MiB". This is a system-installed binary, so presence is not guaranteed; treat it as a fallback only.

A5. RTX generation from the name
const m = /\bRTX\s*(?:PRO\s*)?(\d{2})(\d{2})\b/i.exec(name)  // "NVIDIA GeForce RTX 4070 Laptop GPU" -> 40
Mapping: 20 = Turing, 30 = Ampere, 40 = Ada, 50 = Blackwell (5050/5060/5070/5080/5090).

Edge cases:
 - "NVIDIA TITAN RTX" -> 20 (Turing).
 - "Quadro RTX 4000/5000/6000/8000" -> Turing (20). These match \d{4}, so special-case /Quadro RTX/ -> 20.
 - "RTX A2000/A4000/A6000" -> Ampere (30). The regex fails on the "A", so add /RTX A\d{4}/ -> 30.
 - "RTX 2000/4000/6000 Ada Generation" -> 40. Add /Ada Generation/ -> 40, checked BEFORE the generic regex.
 - "RTX PRO 6000 Blackwell" -> 50. Add /Blackwell/ -> 50, also checked first.
 - "GeForce GTX 16xx/10xx" -> not RTX (no DLSS/RT).
 - "MX" -> not RTX.
 Generic "Laptop GPU" suffix: same generation.
 Sanity check: accept the series only if it is in {20,30,40,50}; anything else (e.g. 60 later) is "unknown-newer".

A6. NVIDIA driver version conversion (Windows file version -> NVIDIA marketing version)
Algorithm: split "31.0.15.6156" on "."; take the last 5 digits of parts[2]+parts[3]; insert a dot after the first 3 digits.
 "31.0.15.6156" -> "15"+"6156" = "156156" -> last5 "56156" -> 561.56
 "32.0.15.7680" -> "157680" -> "57680" -> 576.80
 "30.0.14.7212" -> "147212" -> "47212" -> 472.12
Code:
 const p = v.split('.'); const s = (p[2] + p[3].padStart(4,'0')).slice(-5); return `${s.slice(0,3)}.${s.slice(3)}`
Pad parts[3] to 4 digits, e.g. 31.0.15.0560 -> "15"+"0560" -> 505.60. Windows strips leading zeros in some displays, so pad defensively.
Apply only for vendor 10DE.
AMD and Intel: show DriverVersion raw (Intel uses e.g. 32.0.101.9150, where "101.9150" is the Intel marketing build). AMD's marketing Adrenalin version (e.g. 24.x.y) is in the Class key value "RadeonSoftwareVersion" (fallback "DriverVersion").

======================================================================
PART B: ANTI-CHEAT DETECTION IN A GAME INSTALL FOLDER
======================================================================

B0. Method (mirror SteamDB's detector logic; reimplement, don't copy)
SteamDB's FileDetectionRuleSets (MIT) works like this (tests/FileDetector.php):
 - Every relative path (to the install root) is lowercased, with "/" separators. Folders also appear as paths ending in "/".
 - Each rule regex is lowercased and applied with preg_match.
 - Anchors (?:^|/) mean the name can sit at any depth.

For PlayOut: walk the install dir to depth about 6 (skip huge pak dirs if needed), build lowercased forward-slash relative paths with folders suffixed "/", and test them against the rule list below.
Return: { id, name, kernel: bool, evidence: [relativePath] }.

B1. SteamDB rules.ini [AntiCheat] section, verbatim regexes (MIT data, rules.ini lines 241-263):
 AntiCheatExpert[] = (?:^|/)AntiCheatExpert/
 AntiCheatExpert[] = (?:^|/)AceAntibotClient/
 AnyBrain[]        = (?:^|/)anybrainSDK\.dll$     |  (?:^|/)Cerebro\.dll$
 BattlEye          = (?:^|/)BEService(?:_x64)?\.exe$
 BlackCipher[]     = (?:^|/)BlackCall(?:64)?\.aes$  |  (?:^|/)BlackCat64\.sys$
 EasyAntiCheat[]   = (?:^|/)EasyAntiCheat_(?:EOS_)?Setup\.exe$
 EasyAntiCheat[]   = (?:^|/)(?:EasyAntiCheat(?:_x64)?|eac_server64)\.dll$
 EA_AntiCheat      = (?:^|/)EAAntiCheat\.Installer\.exe$
 EQU8              = (?:^|/)equ8_conf\.json$
 FredaikisAntiCheat= (?:^|/)FredaikisAntiCheat/
 HackShield        = (?:^|/)HShield/HSInst\.dll$
 NetEase_AntiCheatExperts = (?:^|/)NeacSafe64(?:_ex)?\.sys$
 NetEase_Yidun     = (?:^|/)NEP2\.dll$
 nProtect_GameGuard= (?:^|/)gameguard\.des$
 PunkBuster[]      = (?:^|/)(?:PnkBstrA|pbsvc)\.exe$  |  (?:^|/)pbsv\.dll$  |  (?:^|/)Punkbuster(?:$|/)
 Ricochet          = (?:^|/)Randgrid\.sys$
 TenProtect        = (?:^|/)TP3Helper\.exe$
 XIGNCODE3         = \.xem$

Sample test paths from tests/types (these are what match):
 BattlEye: BattlEye/BEService.exe, BattlEye/BEService_x64.exe, Sub/BattlEye/BEService_x64.exe
 EAC: EasyAntiCheat/EasyAntiCheat_EOS_Setup.exe, EasyAntiCheat/cuisine_royale/EasyAntiCheat_Setup.exe, EasyAntiCheat/eac_server64.dll, EasyAntiCheat_x64.dll
 EA_AntiCheat: __Installer/EAAntiCheat/EAAntiCheat.Installer.exe
 Ricochet: Randgrid.sys
 GameGuard: pso2_bin/GameGuard.des
 PunkBuster: pb/pbsv.dll, pb/PnkBstrA.exe, Binaries/pbsvc.exe, install/PunkBuster
 ACE: AceAntibotClient/InGame/x64/ACE-ATS64.dll, anticheatexpert/ingame/x64/ace-drv64.dll

SteamDB KNOWN_UNDETECTIONS.md explicitly says:
 - VAC: built into Steam and the game exe, so it can't be detected.
 - Denuvo Anti-Cheat: built into the exe, so it can't be detected.

B2. Extended signature table for PlayOut (SteamDB rules + additions; additions marked [add])

1. Easy Anti-Cheat (Epic; EOS or legacy). Kernel driver: yes (EasyAntiCheat_EOS.sys / EasyAntiCheat.sys installed under Program Files (x86)\EasyAntiCheat_EOS).
   Strong signals:
   - folder "EasyAntiCheat/"
   - EasyAntiCheat_EOS_Setup.exe (EOS) or EasyAntiCheat_Setup.exe (legacy)
   - EasyAntiCheat_x64.dll, EasyAntiCheat.dll, eac_server64.dll
   [add] Also:
   - start_protected_game.exe in the game root (the EOS bootstrapper; the game exe launched directly is unprotected)
   - EasyAntiCheat/Settings.json
   - EasyAntiCheat/Certificates/ (base.cer, base.bin, runtime.conf)
   - EasyAntiCheat/Localization/
   - EasyAntiCheat/SplashScreen.png
   EOS Settings.json shape (keys used by the bootstrapper; values hex ids):
     {"productid":"<32hex>","sandboxid":"<32hex>","deploymentid":"<32hex>","title":"Game Name","executable":"Binaries\\Win64\\Game.exe","requested_splash":"EasyAntiCheat/SplashScreen.png","wait_for_game_process_exit":"false","hide_bootstrapper":"false","hide_gui":"false"}
   Legacy (pre-EOS) Settings.json carries "title","executable","gameid" (no productid). Parse "productid" to tell EOS from legacy; "executable" gives the real game exe.
   Source for productid/sandboxid/deploymentid in EasyAntiCheat/Settings.json and "EasyAntiCheat_EOS_Setup.exe install <productid>": community guides (see Sources). Key names beyond those three are from recollection and should be checked against a real install before relying on them.
   Note: EAC presence does not mean Proton/co-op is blocked. Many EAC games run fine offline. Treat it as a warning, not a block.

2. BattlEye. Kernel: yes (BEDaisy.sys, installed to Program Files (x86)\Common Files\BattlEye).
   SteamDB rule: BEService.exe / BEService_x64.exe anywhere (usually under BattlEye/).
   [add] folder "BattlEye/" with BEClient_x64.dll / BEClient.dll, Install_BattlEye.bat, Uninstall_BattlEye.bat; root launcher matching /_BE\.exe$/i (e.g. DayZ_BE.exe; Arma 3 uses arma3battleye.exe, so also /battleye\.exe$/i); BELauncher.exe + BELauncher.ini in root on newer titles.
   The _BE/BELauncher names are from recollection; SteamDB only commits to BEService.
   Use BEClient*.dll or BEService* as the strong signal; _BE.exe alone is medium.

3. Riot Vanguard. Kernel: yes, boot-start.
   NOT in the game folder. Detect system-wide:
   - C:\Program Files\Riot Vanguard\vgc.exe and vgk.sys (Riot support's allow-list paths)
   - services "vgc" (user mode) and "vgk" (driver): sc query vgk
   Game-side hint: the install is a Riot Client game ("Riot Games\VALORANT\live", or "League of Legends" under the Riot Games folder).
   Report it as "requires Vanguard" by title or launcher, not by files in the game dir.

4. EA Javelin (EA AntiCheat). Kernel: yes.
   SteamDB rule: EAAntiCheat.Installer.exe (seen at __Installer/EAAntiCheat/EAAntiCheat.Installer.exe).
   [add] EAAntiCheat.GameServiceLauncher.exe (+ EAAntiCheat.GameServiceLauncher.dll) in the game root. It is the protected launcher; EA forum threads report Steam verify flagging these two files in FC 26, and BF6 guides list it.
   System side: C:\Program Files\EA\AC\EAAntiCheat.Installer.exe (EA Help) and the service "EAAntiCheatService".

5. nProtect GameGuard (INCA). Kernel: yes.
   SteamDB: gameguard.des anywhere (e.g. pso2_bin/GameGuard.des).
   [add] folder "GameGuard/" containing GameMon.des / GameMon64.des, npgg*.erl logs, GameGuard.ver. The extra names are from recollection; .des is the reliable marker.

6. XIGNCODE3 (Wellbia). Kernel: yes (xhunter1.sys).
   SteamDB: any *.xem file (x3.xem, xm.xem etc.).
   [add] folder "XIGNCODE/" (often containing x3.xem and xxd-0.xem), x3.xem in a Binaries folder, xhunter1.sys.

7. PunkBuster (Even Balance; legacy, mostly dead).
   SteamDB: PnkBstrA.exe, pbsvc.exe, pbsv.dll, folder Punkbuster/.
   VERIFIED locally: C:\...\steamapps\common\Call of Duty\pb\ contains pbag.dll, pbags.dll, pbcl.dll, pbcls.dll, pbsv.dll and htm/.
   [add] folder "pb/" counts only when it contains pbcl.dll / pbsv.dll / pbag.dll. Don't flag a bare "pb" folder, which is ambiguous.
   Usually inactive today (old CoD, BF). Report it as legacy / likely harmless.

8. Denuvo Anti-Cheat (Irdeto; NOT Denuvo Anti-Tamper DRM). Kernel: yes (optional per mode).
   Cannot be detected from game files (SteamDB KNOWN_UNDETECTIONS: built into the exe).
   System-side signals only:
   - C:\Program Files\Denuvo Anti-Cheat\ containing denuvo-anti-cheat-update-service.exe and <GUID>\denuvo-anti-cheat.sys
   - services "Denuvo Anti-Cheat" / "Denuvo Anti-Cheat Update Service" (third-party uninstaller listings)
   These are machine-wide, so they can't be attributed to one game. Use a per-title manual list or areweanticheatyet data instead.
   Don't confuse it with Denuvo DRM (no reliable file marker either; the exe is protected).

9. Ricochet (Activision, Call of Duty). Kernel: yes.
   SteamDB: Randgrid.sys anywhere.
   VERIFIED locally: C:\...\steamapps\common\Call of Duty Modern Warfare III\Randgrid.sys (root, next to bootstrapper.exe and cod23-cod.exe).
   The unified "Call of Duty" (HQ) folder here had no Randgrid.sys at depth <= 1. Scan deeper (and treat Activision CoD titles as Ricochet by app id as a fallback).

10. mhyprot / HoYoKProtect (miHoYo / HoYoverse). Kernel: yes.
    Driver files are dropped and loaded at runtime, not reliably shipped as loose files: mhyprot2.sys (Genshin, older), mhyprot3.sys, HoYoKProtect.sys (newer).
    [add] Check the game dir for (?:^|/)(mhyprot\d?\.sys|HoYoKProtect\.sys|mhypbase\.dll)$ (mhypbase.dll is the in-game protection loader in Genshin/HSR/ZZZ). Also check the service "HoYoKProtect" / "mhyprot2" system-wide.
    Evidence: Trend Micro covered mhyprot2.sys as the Genshin anti-cheat driver (it persists after uninstall); Reddit covers HoYoKProtect.sys as Genshin-related. Neither gives the install path, so file names in the game dir are best-effort.

11. ACE (Anti-Cheat Expert, Tencent). Kernel: yes (ACE-BASE.sys, ACE-GAME.sys in System32\drivers).
    SteamDB: folders AntiCheatExpert/ or AceAntibotClient/ anywhere (e.g. Delta Force: Game\DeltaForce\Binaries\Win64\AntiCheatExpert\; inner InGame\x64\ACE-ATS64.dll / ace-drv64.dll).
    System: C:\Program Files\AntiCheatExpert\, hidden C:\ProgramData\AntiCheatExpert, SGuard64.exe / SGuardSvc64.exe processes (SteamDB patch note).
    Related Tencent: TenProtect -> TP3Helper.exe (SteamDB).

12. FACEIT AC. Kernel: yes (faceit.sys).
    Not in game folders. It is a separate client (C:\Program Files\FACEIT AC\faceitclient.exe; services "FACEIT" / "FACEITService"; these paths are from recollection).
    Used for third-party matchmaking on CS2 etc., not by the game itself. Never flag it from game files; at most show "FACEIT installed" system-wide.

13. VAC (Valve Anti-Cheat). Not detectable from files (SteamDB KNOWN_UNDETECTIONS).
    Use Steam store/appinfo categories (category id 8 "Valve Anti-Cheat enabled") if needed. Otherwise report "none detectable".

Also worth including (SteamDB): EQU8 (equ8_conf.json), AnyBrain, BlackCipher (Nexon), HackShield (HShield/HSInst.dll), NetEase NeacSafe64.sys / NEP2.dll, Fredaikis.

B3. Suggested output record and combining signals
type AntiCheatHit = { id: 'eac'|'battleye'|'javelin'|'gameguard'|'xigncode'|'punkbuster'|'ricochet'|'mhyprot'|'ace'|'tenprotect'|'equ8'|..., kernel: boolean, confidence: 'strong'|'medium', evidence: string[] }
Example:
 [{"id":"eac","kernel":true,"confidence":"strong","evidence":["easyanticheat/easyanticheat_eos_setup.exe","start_protected_game.exe"],"eos":{"productid":"…","executable":"Binaries\\Win64\\Game.exe"}}]

Matching:
- strong = SteamDB rule hit
- medium = [add] heuristic only (e.g. *_be.exe alone, "pb/" without pb dlls)

System-wide checks (Vanguard, Denuvo AC, FACEIT, ACE services) go in a separate "installedAntiCheat" list, not attributed to a game.

Cross-reference per-title Linux/Proton status: AreWeAntiCheatYet publishes games.json in the GitHub repo AreWeAntiCheatYet/AreWeAntiCheatYet (fields include name, anticheats[], status, storeIds).
 That would be a live-fetched source. Its exact field names were NOT verified this session; fetch it before coding against it.

Sources:
- https://github.com/SteamDatabase/FileDetectionRuleSets (rules.ini [AntiCheat], tests/types/AntiCheat.*.txt, tests/FileDetector.php, KNOWN_UNDETECTIONS.md; MIT)
- https://help.ea.com/en-us/help/pc/ea-anticheat/ (C:\Program Files\EA\AC\EAAntiCheat.Installer.exe)
- https://forums.ea.com/discussions/fc-26-technical-issues-en/fc-26-wont-launch-due-to-corrupted-javelin-anti-cheat-files/12978205 (EAAntiCheat.GameServiceLauncher.exe and its dll in the game folder)
- https://www.keengamer.com/articles/features/troubleshooting/5-ways-to-fix-the-ea-javelin-anticheat-encountered-an-error-battlefield-6-gaming-issue
- https://support.riotgames.com/riot/security/security-software-and-malware-scan (vgc.exe, vgk.sys paths)
- https://steamdb.info/patchnotes/7902953 (C:\Program Files\AntiCheatExpert, SGuard64)
- https://steamcommunity.com/app/2507950/discussions/0/4638240954399169480 (Delta Force AntiCheatExpert folder path)
- https://nvd.nist.gov/vuln/detail/CVE-2024-22830 (ACE-BASE.sys)
- https://www.trendmicro.com/en_us/research/22/h/ransomware-actor-abuses-genshin-impact-anti-cheat-driver-to-kill-antivirus.html (mhyprot2.sys)
- https://irdeto.com/denuvo/qa-about-denuvo-anti-cheat-and-windows-kernel-mode-drivers
- https://www.advanceduninstaller.com/Denuvo-Anti-Cheat-ebc9055ea2fd6b9fcc66f20fc03a2a59-application.htm (Denuvo AC folder / service names)
- https://easy.ac/support/articles/error-eac-is-not-installed
- https://qiita.com/mizuameisgod/items/7741708a76a249534166 (EAC Settings.json fields)
- https://helldivers.wiki.gg/wiki/Easy_Anticheat_Troubleshooting

Scratch copy of rules.ini: C:\Users\<user>\AppData\Local\Temp\<scratch>