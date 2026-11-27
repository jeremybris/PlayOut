VENDOR UPSCALER DLL SOURCES: SPECS FOR PLAYOUT (checked 2026-11-19)

How I checked: I used gh api, HEAD and range requests, and read zip central directories with a Node range-reader at C:\Users\<user>\AppData\Local\Temp\<scratch> I downloaded the DLLs only to read their version resources and Authenticode signatures, using .NET FileVersionInfo and Get-AuthenticodeSignature. No binary was run. The DLLs are in scratchpad\dl_dlss, dl_xess and dl_fsr.

======================================================================
1. NVIDIA DLSS (github.com/NVIDIA/DLSS)
======================================================================
Newest version: tag v310.9.16 ("DLSS 310.9.16 SDK", published 2026-10-16). Earlier tags: v310.9.1, v310.7.0, v310.6.0, v310.5.3.
- Release assets are only ngx_dlss_demo_windows.zip and ngx_dlss_demo_linux.zip (demo apps). Do not use them for the DLLs.
- The DLLs are committed in the repo at lib/Windows_x86_64/rel/:
  nvngx_dlss.dll   58956912 bytes  git blob sha 23c4672e4a31ef303e8f98ff4f0d146bd1718ccf  FileVersion 310.9.16.0  "NVIDIA DLSS - DVS PRODUCTION"
  nvngx_dlssd.dll  48343664 bytes  sha 36efb7890a7f5754935647c6b3510e21a096512f  310.9.16.0  "NVIDIA DLSS - DVS PRODUCTION"
  nvngx_dlssg.dll   7506544 bytes  sha 71b8070cdced79e8df3414060337c84d91e38422  310.9.16.0  "NVIDIA DLSS-G MFGLW - DVS PRODUCTION"
  - MD5 of the downloaded copies: dlss dc1a83569dcbe51823c1b108a9ede468, dlssd e544765751623b6d250b1e8d9c16c1c3, dlssg 88f3ee2c44f0f8d67e0220020990cef5.
  - lib/Windows_x86_64/dev/ holds development builds (watermark/debug; dlss 59383920, dlssd 93504624, dlssg 8044656). Never use those.
- Not Git LFS. There is no .gitattributes; the raw URL returns 200, Content-Length 58956912, and the body starts with "MZ". media.githubusercontent.com/media/... returns 404.
- Download pattern: https://raw.githubusercontent.com/NVIDIA/DLSS/<tag>/lib/Windows_x86_64/rel/<file>
  Example: https://raw.githubusercontent.com/NVIDIA/DLSS/v310.9.16/lib/Windows_x86_64/rel/nvngx_dlss.dll
- Discovery:
  1. GET https://api.github.com/repos/NVIDIA/DLSS/releases/latest returns tag_name "v310.9.16".
  2. GET https://api.github.com/repos/NVIDIA/DLSS/contents/lib/Windows_x86_64/rel?ref=v310.9.16 returns [{name, size, sha, download_url}].
  3. The `sha` is the git blob SHA-1: sha1("blob " + size + "\0" + bytes). Recompute it after download as an integrity check. I confirmed `git hash-object` matches the API sha.
- Signer, verified Valid on all three: CN=NVIDIA Corporation, OU=1005bk6, O=NVIDIA Corporation, L=Santa Clara, S=California, C=US. Issuer: CN=DigiCert Trusted G4 Code Signing RSA4096 SHA384 2021 CA1. Thumbprint seen: 7B7B0B6697AFB438CF6F65A155F00E86676FB186. Pin on the subject O=, not the thumbprint, because certificates rotate.
- NVIDIA's FileVersion string uses commas ("310,9,16,0"). Read the numeric VS_FIXEDFILEINFO parts instead: scan the PE for signature BD 04 EF FE, then dwFileVersionMS = +8 and LS = +12, which gives major=MS>>16, minor=MS&0xFFFF, build=LS>>16, rev=LS&0xFFFF.
- The SDK builds are not byte-identical to builds shipped with games for the same version. The DLSS Swapper manifest has 310.9.16.0 nvngx_dlss at 74187376 bytes (MD5 C77DDAE7...), and the same-size dlssg has a different MD5 (F80D3622...). So identify a DLL by version plus signature, not by hash.
- Streamline (NVIDIA-RTX/Streamline): latest v2.14.16 (2026-10-16, same day as DLSS). Assets: streamline-sdk-v2.14.16.zip (276016170 bytes), -aarch64.zip, -arm64ec.zip. Inside the zip, bin/x64/nvngx_dlss.dll 58956912, nvngx_dlssd.dll 48343664, nvngx_dlssg.dll 7506544 (plus bin/x64/development/...). These are the same sizes as the DLSS repo, so Streamline is not newer. Use the DLSS repo raw files and skip the 276 MB zip.

======================================================================
2. INTEL XeSS / XeSS-FG / XeLL (github.com/intel/xess)
======================================================================
Newest version: tag v3.0.2 (2026-07-24). The single asset is XeSS_SDK_3.0.2.zip (76839749 bytes, zip/deflate), at https://github.com/intel/xess/releases/download/v3.0.2/XeSS_SDK_3.0.2.zip. Earlier tags: v3.0.1, v3.0.0, v2.1.1, v2.1.0, v2.0.1.
- Paths inside the zip, which match the repo paths:
  bin/libxess.dll       77795704  FileVersion 2.0.2.68  "XeSS SDK"  (XeSS-SR. Still 2.0.2.68 in SDK 3.x; unchanged since SDK 2.1.1.)
  bin/libxess_dx11.dll    156016  2.0.2.68  "XeSS SDK"
  bin/libxess_fg.dll    22957432  1.3.1.78  "XeSS Frame Generation SDK"
  bin/libxell.dll         415368  1.3.2.10  "XeLL SDK"
- The DLLs are also committed in the repo at bin/ (not LFS). Easiest download, no unzip needed: https://raw.githubusercontent.com/intel/xess/<tag>/bin/<file>. Verified 200 with the correct length at v3.0.2.
- MD5s match the DLSS Swapper manifest exactly: libxess D9E2ACA10667501DCED0E5B69B7D3EA5, libxess_dx11 E04C7F44BC073D164CBF603215E96EAA, libxess_fg E5DA7E91E3AF8A8340B3FEF922912E6E, libxell 831A165EB6832A5C1EC46EEE2A33DE30.
- Signers:
  - libxess, libxess_dx11, libxess_fg: CN=Intel Corporation, O=Intel Corporation, S=California, C=US (issuer Sectigo Public Code Signing CA R36).
  - libxell.dll is the exception. It is signed by CN=Microsoft Windows Hardware Compatibility Publisher, O=Microsoft Corporation. The CompanyName in its version info is still "Intel Corporation". Pin per file type: for XeLL, accept the Microsoft WHCP subject and require CompanyName "Intel Corporation".
- Discovery: GET /repos/intel/xess/releases/latest, then GET /repos/intel/xess/contents/bin?ref=<tag>, which gives size, sha and download_url. Verify with the blob sha.
- Compatibility, from Intel's release notes:
  - v2.0.1 notes: "DirectX 12: Backwards compatible API with XeSS 1.0 & 1.1 & 1.2 & 1.3". So libxess 2.x is a drop-in replacement for 1.x on DX12.
  - Vulkan and DX11 support first arrived in 2.0. DX11 uses the separate libxess_dx11.dll, which only works on Intel Arc.
  - v3.0.0 notes, quoted: "Replace libxess.dll, libxell.dll, and libxess_fg.dll". The multi-frame-generation UI needs game support, but older FG games still work with an FG DLL swap.
  - Swapper's XeSS history: 1.0.0.59, 1.0.1.12, 1.1.0.x, 1.2.0.x, 1.3.0.28, 1.3.1.32, then 2.0.0.18 through 2.0.2.68. XeSS-FG: 0.9.11.9 up to 1.3.1.78. XeLL: 1.0.0.139 up to 1.3.2.10.
  - Caveat: 2.x does not add DX11 or Vulkan support to a game that only shipped the 1.x DX12 path. Swap only the same file name that is present.

======================================================================
3. AMD FSR (github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK)
======================================================================
Releases:
  v2.4.0 (2026-10-28): no assets (latest)
  v2.3.0: FidelityFX-Samples-v2.3.0-prebuilt.zip
  v2.2.0: -source.zip and -prebuilt.zip
  v2.1.1 and v2.1.0: no assets
  v2.0.0: FidelityFX-SDK-v2.0.0.zip
  v1.1.4 (2025-05-08): FidelityFX-SDK-v1.1.4.zip
  v1.1.3, v1.1.2, v1.1.1, v1.1.0 (FidelityFX-SDK-1.1.zip), fsr3-v3.0.4, fsr3-v3.0.3, v1.0.0
The v2.4.0 notes say the download is the tag archive (../archive/refs/tags/v2.4.0.zip, about 200 MiB). Better: take the committed signed DLLs directly with raw URLs (not LFS; downloads start with "MZ").

a) SDK 2.x split DLLs (newest)
   Path: Kits/FidelityFX/signedbin/. URL: https://raw.githubusercontent.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK/v2.4.0/Kits/FidelityFX/signedbin/<file>
   amd_fidelityfx_loader_dx12.dll             39184     FileVersion 2.3.0.4555  "AMD FidelityFX (DirectX) Loader Library"
   amd_fidelityfx_loader_vk.dll               39184     1.0.2.4555
   amd_fidelityfx_upscaler_dx12.dll        57664272     4.1.2.4555  (FSR Upscaling 4.1.2 + FSR3 3.1.6 + FSR2 providers)
   amd_fidelityfx_upscaler_vk.dll          36135696     4.1.2.4555
   amd_fidelityfx_framegeneration_dx12.dll 29679376     4.0.2.4555
   amd_fidelityfx_framegeneration_vk.dll   36806928     4.0.2.4555
   amd_fidelityfx_denoiser_dx12.dll         8993552     1.2.1.4555
   amd_fidelityfx_radiancecache_dx12.dll     800528
   (.lib files sit next to these; ignore them.)
   For the split DLLs, the file version equals the effect version.

b) Legacy monolithic FSR 3.1 DLLs (what FSR 3.1 games ship)
   The newest official one is SDK v1.1.4, at PrebuiltSignedDLL/amd_fidelityfx_dx12.dll and PrebuiltSignedDLL/amd_fidelityfx_vk.dll.
   URL: https://raw.githubusercontent.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK/v1.1.4/PrebuiltSignedDLL/<file>
   - The same files are in the zip at PrebuiltSignedDLL/ and bin/.
   - Do not use ffx-api/bin/ in that zip. Those copies are unsigned rebuilds with different sizes: 6664192 and 9320960.
   - dx12: 6675664 bytes, FileVersion 1.0.1.41314, "DX12 AMD FidelityFX Library", MD5 49230ad94ed6169933cd0457501d9cb4.
   - vk: 9332432 bytes, 1.0.1.41314, "VK AMD FidelityFX Library", MD5 9718fd774c61be1af6af411cf65394cd.
   - The file version is the ffx-api version, not the FSR version. Mapping from the DLSS Swapper manifest (file version = FSR display version):
     1.0.0.36208 / 36604 / 36752 = 3.1.0
     1.0.1.37507 = 3.1.1
     1.0.1.38338 and 1.0.2.38022 = 3.1.2
     1.0.1.39157 / 40157 / 39321 (vk) = 3.1.3
     1.0.1.41314 and 1.0.1.42386 (vk, game-sourced) = 3.1.4
   - Swapper's DLLRecord gets the FSR number from the manifest "internal_name". Its FSR31Helper finds it by LoadLibrary + ffxQuery(FFX_API_QUERY_DESC_TYPE_GET_VERSIONS with FFX_API_CREATE_CONTEXT_DESC_TYPE_UPSCALE), decoding versionId as major=(id>>22)&0x3FF, minor=(id>>12)&0x3FF, patch=id&0xFFF. Electron cannot easily load the DLL, so PlayOut should ship the mapping table, and otherwise compare raw file versions within the same family.
   - The "newest" check for the FSR 3.1 types must compare the display/FSR version. Swapper's GetLatestRecord special-cases FSR_31_* to compare DisplayVersionVersion; everything else uses VersionNumber.

c) Which names are drop-in compatible (ffx-api.md "DLLs structure", tag v2.4.0)
   - The loader is "interface- and behavior-compatible with amd_fidelityfx_dx12(vk).dll".
   - The loader looks for each effect DLL in this order: a module of that name already loaded in the process, then the exe folder, then the loader's own folder.
   - Rules for PlayOut:
     - Replace amd_fidelityfx_dx12.dll and amd_fidelityfx_vk.dll only with the same-named monolithic DLL (newest: 1.1.4 / FSR 3.1.4).
     - For SDK 2.x games, which ship amd_fidelityfx_loader_*.dll plus amd_fidelityfx_upscaler_* / _framegeneration_* / _denoiser_dx12 / _radiancecache_dx12, replace each file only with the same name.
     - Renaming the loader to amd_fidelityfx_dx12.dll and adding the split DLLs is technically possible but not an official swap. Don't do it automatically.
     - FSR 1, FSR 2 and pre-3.1 FSR3 are compiled into the game and cannot be swapped.
   - Driver note (v2.4.0): AMD's driver can auto-override Frame Generation (Swapchain) for SDK 2.1+ / FSR-FG 3.1.6+ games.
- Signer, Valid on all nine DLLs checked: CN=Advanced Micro Devices, O=Advanced Micro Devices, S=California, C=US. CompanyName "Advanced Micro Devices, Inc.".
- Discovery: releases/latest gives "v2.4.0" with no assets. Then use GET /repos/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK/git/trees/<tag>?recursive=1 and filter paths matching Kits/FidelityFX/signedbin/*.dll (truncated=false; gives size and blob sha). The legacy line is fixed at v1.1.4 PrebuiltSignedDLL/; hardcode it, since there will be no newer monolithic release.

======================================================================
4. COMMON: API, RATE LIMITS, FORMATS, VERIFICATION
======================================================================
- Endpoints, no auth:
  - api.github.com/repos/{o}/{r}/releases/latest
  - /tags?per_page=5
  - /contents/{path}?ref={tag}
  - /git/trees/{tag}?recursive=1
- Unauthenticated core API limit is 60 requests per hour per IP (headers X-RateLimit-Limit 60 / Remaining / Reset). Cache the result and check at most once a day; one check costs about 2 calls per vendor. raw.githubusercontent.com and release-asset downloads do not count against the API limit.
- Archive formats are zip only (method 8 deflate). No 7z anywhere. With raw URLs, no archive handling is needed at all.
- Verification pipeline:
  1. Check the size equals the API size.
  2. Check the git-blob SHA-1 equals the API sha.
  3. Check the PE "MZ" header and that VS_FIXEDFILEINFO is the expected version.
  4. Check Authenticode is Valid with the pinned signer subject: NVIDIA Corporation; Intel Corporation (XeLL: Microsoft Windows Hardware Compatibility Publisher); Advanced Micro Devices. Do this with PowerShell Get-AuthenticodeSignature or WinVerifyTrust.
  Swapper refuses unsigned files unless "Allow Untrusted" is on (WinTrust.VerifyEmbeddedSignature) and also checks the MD5 against its manifest.
- Optional cross-check: DLSS Swapper's own manifest at https://beeradmoore.github.io/dlss-swapper/manifest.json (542 KB).
  - Top-level keys: dlss, dlss_d, dlss_g, fsr_31_dx12, fsr_31_vk, xess, xell, xess_fg, xess_dx11, directstorage, directstorage_core, known_dlls.
  - Sample record: {"version":"310.9.16.0","version_number":87257281436057600,"internal_name":"CL 38955375","md5_hash":"C77DDAE7...","download_url":"https://dlss-swapper-downloads.beeradmoore.com/dlss/dlss_v310.9.16.0_<MD5>.zip","file_description":"NVIDIA DLSS - DVS PRODUCTION","is_signature_valid":true,"is_dev_file":false,"file_size":74187376,"dll_source":""}
  - version_number = (major<<48)+(minor<<32)+(build<<16)+rev.
  - This is a third-party mirror, not vendor-official, so it should only be a cross-check.

======================================================================
5. HOW DLSS SWAPPER BEHAVES (beeradmoore/dlss-swapper, main, release v1.2.7.0)
======================================================================
Files read: src/Data/Game.cs, GameAssetType.cs, DLLManager.cs, DLLRecord.cs, Pages/LibraryPageModel.cs, Extensions/*, Xbox/*, Helpers/FSR31/FSR31Helper.cs.

- Scanning: Directory.GetFiles(InstallPath, "*.dll") recursively, skipping reparse points. Matches exact, case-sensitive names: nvngx_dlss.dll, nvngx_dlssg.dll, nvngx_dlssd.dll, amd_fidelityfx_dx12.dll, amd_fidelityfx_vk.dll, libxess.dll, libxess_dx11.dll, libxell.dll, libxess_fg.dll. For each it reads the version from FileVersionInfo numeric parts and the MD5.
  - The enum already defines FidelityFX SDK2 split types, Streamline sl.* and DirectStorage, but the main branch does not scan those names. The feature/fsr4 and feature/streamline branches exist.
- Type isolation: a swap only overwrites files whose type equals the record's type. A dlssg record never touches nvngx_dlss.dll, and likewise for dlssd, XeSS-FG and so on.
- Multiple copies: every copy of that type in the game folder is backed up and overwritten with the same DLL. The UI raises a MultipleXxxFound flag when more than one is found (MultipleDLLsFoundControl warns about it).
- Backups: "<path>.dlsss" sits next to each DLL and is created with File.Copy only if no backup of that type exists yet, so the original is never overwritten. Reset moves .dlsss back over the DLL (File.Move with overwrite). On rescan, if a DLL's version changed outside Swapper (a game update), it deletes the stale .dlsss and logs DLLChangedExternally / DLLBackupRemoved.
- Downgrades: Swapper does not block them; the README says you can "upgrade or downgrade". Its "Download latest" picks the highest VersionNumber, the highest DisplayVersion for FSR, and prefers non-dev files. PlayOut's own "never downgrade" rule should be: only swap when the vendor version is greater than the game's version (FSR via the mapping table), and keep .dlsss for revert.
- Compatibility conventions (Swapper offers no cross-family guard; these are the known rules):
  - DLSS-SR 2.x and later accepts any newer nvngx_dlss.dll (2.x → 3.x → 310.x). DLSS 1.x (versions 1.x) is incompatible; skip games whose nvngx_dlss is below 2.0.
  - dlssg and dlssd only replace the same file name.
  - XeSS 1.x → 2.x works on DX12 per Intel.
  - FSR is the 3.1 monolithic DLL only, or same-name SDK2 split DLLs.
- WindowsApps / Xbox: Swapper uses PackageManager package.InstalledPath and writes directly. On failure it returns UnauthorizedAccessException with the message "Running DLSS Swapper as administrator may fix this", or IOException HResult 0x80070020 ("Is your game currently running?").
  - Recommendation for PlayOut: skip any path containing \WindowsApps\ because it is ACL-protected and integrity-checked. Allow XboxGames\<Game>\Content installs, which are writable.
- Errors to mirror: file locked (game running) → 0x80070020; access denied → offer elevation; verify the hash before copy and the signature before swap.
- The user can ignore paths (Settings.IgnoredPaths).