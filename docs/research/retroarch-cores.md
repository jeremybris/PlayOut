# RetroArch core mapping (from Playnite Emulation/Emulators/RetroArch/emulator.yaml, commit 3e8abb2)

Every profile launches `retroarch.exe` (StartupExecutable regex `^retroarch\.exe$`) with `-L ".\cores\<core>_libretro.dll" "{ImagePath}"`; `ProfileFiles` is the core DLL that must exist under the RetroArch install dir for the profile to be offered.

| Profile name | Core DLL | Platforms | ImageExtensions |
|---|---|---|---|
| 4DO | 4do_libretro.dll | 3do | 7z, bin, chd, cue, iso, zip |
| a5200 | a5200_libretro.dll | atari_5200 | 7z, a52, bin, zip |
| Ardens | ardens_libretro.dll | arduboy | hex, arduboy |
| Arduous | arduous_libretro.dll | arduboy | hex |
| Atari800 | atari800_libretro.dll | atari_5200, atari_8bit | 7z, a52, atr, atx, bin, car, cas, com, dcm, m3u, rom, xex, xfd, zip |
| Beetle bsnes | mednafen_snes_libretro.dll | nintendo_super_nes | 7z, bs, fig, sfc, smc, st, zip |
| Beetle GBA | mednafen_gba_libretro.dll | nintendo_gameboyadvance | 7z, agb, bin, gba, zip |
| Beetle Lynx | mednafen_lynx_libretro.dll | atari_lynx | 7z, lnx, lyx, o, zip |
| Beetle NeoPop | mednafen_ngp_libretro.dll | snk_neogeopocket, snk_neogeopocket_color | 7z, ngc, ngp, ngpc, npc, zip |
| Beetle PC-FX | mednafen_pcfx_libretro.dll | nec_pcfx | 7z, ccd, chd, cue, toc, zip |
| Beetle PCE | mednafen_pce_libretro.dll | nec_supergrafx, nec_turbografx_16, nec_turbografx_cd | 7z, ccd, chd, cue, m3u, pce, sgx, toc, zip |
| Beetle PCE Fast | mednafen_pce_fast_libretro.dll | nec_turbografx_16, nec_turbografx_cd | 7z, ccd, chd, cue, m3u, pce, toc, zip |
| Beetle PSX | mednafen_psx_libretro.dll | sony_playstation | 7z, ccd, chd, cue, exe, m3u, pbp, toc, zip |
| Beetle PSX HW | mednafen_psx_hw_libretro.dll | sony_playstation | 7z, ccd, chd, cue, exe, m3u, pbp, toc, zip |
| Beetle Saturn | mednafen_saturn_libretro.dll | sega_saturn | 7z, ccd, chd, cue, m3u, toc, zip |
| Beetle Supafaust | mednafen_supafaust_libretro.dll | nintendo_super_nes | 7z, bsx, dx2, fig, gd3, gd7, sfc, smc, swc, zip |
| Beetle SuperGrafx | mednafen_supergrafx_libretro.dll | nec_supergrafx, nec_turbografx_16, nec_turbografx_cd | 7z, ccd, chd, cue, pce, sgx, zip |
| Beetle VB | mednafen_vb_libretro.dll | nintendo_virtualboy | 7z, bin, vb, vboy, zip |
| Beetle WonderSwan | mednafen_wswan_libretro.dll | bandai_wonderswan, bandai_wonderswan_color | 7z, pc2, pcv2, ws, wsc, zip |
| BlastEm | blastem_libretro.dll | sega_genesis | 68k, 7z, bin, gen, md, sgd, smd, zip |
| blueMSX | bluemsx_libretro.dll | microsoft_msx, microsoft_msx2 | 7z, cas, col, dsk, m3u, mx1, mx2, ri, rom, sc, sf, sg, zip |
| bnes/higan | bnes_libretro.dll | nintendo_nes | 7z, nes, zip |
| Boytacean | boytacean_libretro.dll | nintendo_gameboy, nintendo_gameboycolor | 7z, gb, gbc, zip |
| bsnes | bsnes_libretro.dll | nintendo_super_nes | 7z, bs, fig, gb, gbc, sfc, smc, swc, zip |
| bsnes 2014 Accuracy | bsnes2014_accuracy_libretro.dll | nintendo_super_nes | 7z, bml, bs, gb, gbc, sfc, smc, st, zip |
| bsnes 2014 Balanced | bsnes2014_balanced_libretro.dll | nintendo_super_nes | 7z, bml, bs, gb, gbc, sfc, smc, st, zip |
| bsnes 2014 Performance | bsnes2014_performance_libretro.dll | nintendo_super_nes | 7z, bml, bs, gb, gbc, sfc, smc, st, zip |
| bsnes C++98 (v085) | bsnes_cplusplus98_libretro.dll | nintendo_super_nes | 7z, bs, gb, gbc, sfc, smc, st, zip |
| bsnes-hd beta | bsnes_hd_beta_libretro.dll | nintendo_super_nes | 7z, bs, fig, gb, gbc, sfc, smc, swc, zip |
| bsnes-jg | bsnes-jg_libretro.dll | nintendo_super_nes | 7z, bs, gb, gbc, sfc, smc, st, zip |
| bsnes-mercury Accuracy | bsnes_mercury_accuracy_libretro.dll | nintendo_super_nes | 7z, bml, bs, gb, gbc, sfc, smc, st, zip |
| bsnes-mercury Balanced | bsnes_mercury_balanced_libretro.dll | nintendo_super_nes | 7z, bml, bs, gb, gbc, sfc, smc, st, zip |
| bsnes-mercury Performance | bsnes_mercury_performance_libretro.dll | nintendo_super_nes | 7z, bml, bs, gb, gbc, sfc, smc, st, zip |
| Caprice32 | cap32_libretro.dll | amstrad_cpc | 7z, cdt, cpr, dsk, m3u, sna, tap, voc, zip |
| ChimeraSNES | chimerasnes_libretro.dll | nintendo_super_nes | 7z, bs, bsx, dx2, fig, gd3, gd7, sfc, smc, st, swc, zip |
| Citra | citra_libretro.dll | nintendo_3ds | 3ds, 3dsx, 7z, app, axf, cci, cxi, elf, zip |
| Citra 2018 | citra2018_libretro.dll | nintendo_3ds | 3ds, 3dsx, 7z, app, axf, cci, cxi, elf, zip |
| Citra Canary/Experimental | citra_canary_libretro.dll | nintendo_3ds | 3ds, 3dsx, 7z, app, axf, cci, cxi, elf, zip |
| CrocoDS | crocods_libretro.dll | amstrad_cpc | 7z, dsk, kcr, sna, zip |
| DeSmuME | desmume_libretro.dll | nintendo_ds | 7z, bin, ids, nds, zip |
| DeSmuME 2015 | desmume2015_libretro.dll | nintendo_ds | 7z, bin, ids, nds, zip |
| DirectXBox | directxbox_libretro.dll | xbox | 7z, iso, zip |
| Dolphin | dolphin_libretro.dll | nintendo_gamecube, nintendo_wii | 7z, ciso, dff, dol, elf, gcm, gcz, iso, m3u, rvz, tgc, wad, wbfs, wia, zip |
| Dolphin Launcher | dolphin_launcher_libretro.dll | nintendo_gamecube, nintendo_wii | 7z, ciso, dol, elf, gcm, gcz, iso, wad, wbfs, zip |
| DOSBox | dosbox_libretro.dll | pc_dos | 7z, bat, com, conf, exe, zip |
| DOSBox-core | dosbox_core_libretro.dll | pc_dos | /, 7z, bat, com, conf, cue, exe, img, iso, zip |
| DOSBox-Pure | dosbox_pure_libretro.dll | pc_dos | /, 7z, bat, chd, com, conf, cue, dosz, exe, ima, img, ins, iso, jrc, m3u, m3u8, tc, vhd, zip |
| DOSBox-SVN | dosbox_svn_libretro.dll | pc_dos | /, 7z, bat, com, conf, cue, exe, img, iso, zip |
| DOSBox-SVN CE | dosbox_svn_ce_libretro.dll | pc_dos | 7z, bat, com, conf, cue, exe, iso, zip |
| DoubleCherryGB | DoubleCherryGB_libretro.dll | nintendo_gameboy, nintendo_gameboycolor | 7z, cgb, dmg, gb, gbc, sgb, zip |
| DuckStation | duckstation_libretro.dll | sony_playstation | 7z, bin, chd, cue, ecm, exe, img, iso, m3u, mds, pbp, psexe, psf, zip |
| Emux GB | emux_gb_libretro.dll | nintendo_gameboy, nintendo_gameboycolor | 7z, bin, gb, gbc, rom, zip |
| Emux NES | emux_nes_libretro.dll | nintendo_nes | 7z, bin, nes, rom, zip |
| Emux SMS | emux_sms_libretro.dll | sega_mastersystem | 7z, bin, bms, rom, sms, zip |
| FCEUmm | fceumm_libretro.dll | nintendo_famicom_disk, nintendo_nes | 7z, fds, nes, unf, unif, zip |
| FinalBurn Neo | fbneo_libretro.dll | arcade | zip,7z |
| fixGB | fixgb_libretro.dll | nintendo_gameboy, nintendo_gameboycolor | 7z, gb, gbc, gbs, zip |
| fixNES | fixnes_libretro.dll | nintendo_famicom_disk, nintendo_nes | 7z, fds, nes, nsf, qd, zip |
| Flycast | flycast_libretro.dll | sega_dreamcast, arcade | 7z, bin, cdi, chd, cue, dat, elf, gdi, lst, m3u, zip |
| Flycast GLES2 | flycast_gles2_libretro.dll | sega_dreamcast, arcade | 7z, bin, cdi, chd, cue, dat, elf, gdi, iso, lst, m3u, zip |
| fMSX | fmsx_libretro.dll | microsoft_msx, microsoft_msx2 | 7z, cas, dsk, fdi, m3u, mx1, mx2, rom, zip |
| FreeIntv | freeintv_libretro.dll | mattel_intellivision | 7z, bin, int, rom, zip |
| Frodo | frodo_libretro.dll | commodore_64 | 7z, d64, lnx, lyx, p00, t64, x64, zip |
| FS-UAE | fsuae_libretro.dll | commodore_amiga | 7z, adf, fs-uae, ipf, zip |
| Fuse | fuse_libretro.dll | sinclair_zxspectrum, sinclair_zxspectrum3 | 7z, dck, dsk, rzx, scl, sna, szx, tap, trd, tzx, z80, zip |
| Gambatte | gambatte_libretro.dll | nintendo_gameboy, nintendo_gameboycolor | 7z, dmg, gb, gbc, zip |
| Gearboy | gearboy_libretro.dll | nintendo_gameboy, nintendo_gameboycolor | 7z, cgb, dmg, gb, gbc, sgb, zip |
| Gearcoleco | gearcoleco_libretro.dll | coleco_vision | 7z, bin, col, cv, rom, zip |
| Gearsystem | gearsystem_libretro.dll | coleco_vision, sega_gamegear, sega_mastersystem, sega_sg1000 | 7z, bin, gg, rom, sg, sms, zip |
| Genesis Plus GX | genesis_plus_gx_libretro.dll | sega_cd, sega_gamegear, sega_genesis, sega_mastersystem | 68k, 7z, bin, bms, chd, cue, gen, gg, iso, m3u, md, mdx, sg, sgd, smd, sms, zip |
| Genesis Plus GX Wide | genesis_plus_gx_wide_libretro.dll | sega_cd, sega_gamegear, sega_genesis, sega_mastersystem | 68k, 7z, bin, bms, chd, cue, gen, gg, iso, m3u, md, mdx, sg, sgd, smd, sms, zip |
| Geolith | geolith_libretro.dll | snk_neogeo_aes, arcade | neo |
| gpSP | gpsp_libretro.dll | nintendo_gameboyadvance | 7z, bin, gba, zip |
| Handy | handy_libretro.dll | atari_lynx | 7z, lnx, lyx, o, zip |
| Hatari | hatari_libretro.dll | atari_falcon030, atari_st | 7z, dim, gem, ide, ipf, m3u, msa, st, stx, vhd, zip |
| higan (Super Famicom Accuracy) | higan_sfc_libretro.dll | nintendo_gameboy, nintendo_gameboycolor, nintendo_super_nes | 7z, bml, gb, gbc, rom, sfc, smc, zip |
| Holani | holani_libretro.dll | atari_lynx | 7z, lnx, o, zip |
| Ishiiruka | ishiiruka_libretro.dll | nintendo_gamecube, nintendo_wii | 7z, ciso, dff, dol, elf, gcm, gcz, iso, tgc, wad, wbfs, zip |
| Kronos | kronos_libretro.dll | sega_saturn | 7z, ccd, chd, cue, iso, m3u, mds, zip |
| Mame | mame_libretro.dll | arcade | zip |
| Mame 2003 Plus | mame2003_plus_libretro.dll | arcade | zip, cdh |
| melonDS | melonds_libretro.dll | nintendo_ds | 7z, dsi, ids, nds, zip |
| melonDS DS | melondsds_libretro.dll | nintendo_ds | 7z, dsi, ids, nds, zip |
| Mesen | mesen_libretro.dll | nintendo_famicom_disk, nintendo_nes | 7z, fds, nes, unf, unif, zip |
| Mesen-S | mesen-s_libretro.dll | nintendo_gameboy, nintendo_gameboycolor, nintendo_super_nes | 7z, bs, fig, gb, gbc, sfc, smc, swc, zip |
| Meteor | meteor_libretro.dll | nintendo_gameboyadvance | 7z, gba, zip |
| mGBA | mgba_libretro.dll | nintendo_gameboy, nintendo_gameboyadvance, nintendo_gameboycolor | 7z, gb, gba, gbc, zip |
| Mupen64Plus-Next | mupen64plus_next_libretro.dll | nintendo_64 | 7z, bin, n64, ndd, u1, v64, z64, zip |
| Mupen64Plus-Next - Nintendo - Nintendo 64 (Mupen64Plus-Next GLES2) | mupen64plus_next_gles2_libretro.dll | nintendo_64 | 7z, bin, n64, ndd, u1, v64, z64, zip |
| Mupen64Plus-Next (Develop) | mupen64plus_next_develop_libretro.dll | nintendo_64 | 7z, bin, n64, ndd, u1, v64, z64, zip |
| Mupen64Plus-Next GLES3 | mupen64plus_next_gles3_libretro.dll | nintendo_64 | 7z, bin, n64, ndd, u1, v64, z64, zip |
| Neko Project II | nekop2_libretro.dll | nec_pc98 | 2hd, 7z, 88d, 98d, cmd, d88, d98, dup, fdd, fdi, hdd, hdi, hdm, nhd, tfd, thd, xdf, zip |
| Neko Project II Kai | np2kai_libretro.dll | nec_pc98 | 2hd, 7z, 88d, 98d, cmd, d88, d98, dup, fdd, fdi, hdd, hdi, hdm, hdn, nhd, tfd, thd, xdf, zip |
| NeoCD | neocd_libretro.dll | snk_neogeo_cd | 7z, chd, cue, zip |
| nes | nes_libretro.dll | nintendo_nes | 7z, nes, zip |
| Nestopia | nestopia_libretro.dll | nintendo_famicom_disk, nintendo_nes | 7z, fds, nes, unf, unif, zip |
| NooDS | noods_libretro.dll | nintendo_ds | 7z, nds, zip |
| nSide (Super Famicom Balanced) | higan_sfc_balanced_libretro.dll | nintendo_gameboy, nintendo_gameboycolor, nintendo_super_nes | 7z, bml, gb, gbc, rom, sfc, smc, zip |
| Numero | numero_libretro.dll | ti_83 | 8xp, 8xk, 8xg |
| Opera | opera_libretro.dll | 3do | 7z, bin, chd, cue, iso, zip |
| Panda3DS | panda3ds_libretro.dll | nintendo_3ds | 3ds, 3dsx, 7z, app, axf, cci, cxi, elf, zip |
| ParaLLEl (Debug) | parallel_n64_debug_libretro.dll | nintendo_64 | 7z, bin, n64, ndd, u1, v64, z64, zip |
| ParaLLEl N64 | parallel_n64_libretro.dll | nintendo_64 | 7z, bin, n64, ndd, u1, v64, z64, zip |
| PCem | pcem_libretro.dll | pc_dos | 7z, bat, com, conf, exe, zip |
| PCSX ReARMed [Interpreter] | pcsx_rearmed_interpreter_libretro.dll | sony_playstation | 7z, bin, cbn, chd, cue, img, mdf, pbp, toc, zip |
| PCSX ReARMed [NEON] | pcsx_rearmed_libretro_neon.dll | sony_playstation | 7z, bin, cbn, chd, cue, img, m3u, mdf, pbp, toc, zip |
| PCSX ReARMed [NEON] - Sony - PlayStation (PCSX ReARMed) [NEON] | pcsx_rearmed_neon_libretro.dll | sony_playstation | 7z, bin, cbn, chd, cue, img, m3u, mdf, pbp, toc, zip |
| PCSX-ReARMed | pcsx_rearmed_libretro.dll | sony_playstation | 7z, bin, cbn, ccd, chd, cue, exe, img, iso, m3u, mdf, pbp, toc, zip |
| PCSX1 | pcsx1_libretro.dll | sony_playstation | 7z, bin, cbn, cue, img, m3u, mdf, pbp, toc, zip |
| PCSX2 | pcsx2_libretro.dll | sony_playstation2 | 7z, bin, chd, ciso, cso, cue, dump, elf, gz, img, iso, m3u, mdf, nrg, zip |
| PicoDrive | picodrive_libretro.dll | sega_32x, sega_cd, sega_genesis, sega_mastersystem | 32x, 68k, 7z, bin, chd, cue, gen, gg, iso, m3u, md, pco, sc, sg, sgd, smd, sms, zip |
| Play! | play_libretro.dll | sony_playstation2 | 7z, chd, cso, cue, elf, iso, isz, zip |
| Potator | potator_libretro.dll | watara_supervision | 7z, bin, sv, zip |
| PPSSPP | ppsspp_libretro.dll | sony_psp | 7z, chd, cso, elf, iso, pbp, prx, zip |
| ProSystem | prosystem_libretro.dll | atari_7800 | 7z, a78, bin, cdf, zip |
| PUAE | puae_libretro.dll | commodore_amiga | 7z, adf, adz, ccd, chd, cue, dms, fdi, hdf, hdz, info, ipf, iso, lha, m3u, mds, nrg, rp9, slave, uae, zip |
| PUAE 2021 | puae2021_libretro.dll | commodore_amiga | 7z, adf, adz, ccd, chd, cue, dms, fdi, hdf, hdz, info, ipf, iso, lha, m3u, mds, nrg, rp9, slave, uae, zip |
| PX68k | px68k_libretro.dll | sharp_x68000 | 2hd, 7z, 88d, cmd, d88, dim, dup, hdf, hdm, img, m3u, xdf, zip |
| QuickNES | quicknes_libretro.dll | nintendo_nes | 7z, nes, zip |
| RACE | race_libretro.dll | snk_neogeopocket, snk_neogeopocket_color | 7z, ngc, ngp, ngpc, npc, zip |
| Redream | redream_libretro.dll | sega_dreamcast | 7z, cdi, chd, gdi, zip |
| RetroDream | retrodream_libretro.dll | sega_dreamcast | 7z, cdi, chd, gdi, zip |
| Rustation | rustation_libretro.dll | sony_playstation | 7z, ccd, cue, exe, m3u, toc, zip |
| SameBoy | sameboy_libretro.dll | nintendo_gameboy, nintendo_gameboycolor | 7z, gb, gbc, zip |
| ScummVM | scummvm_libretro.dll | pc_dos, pc_windows | scummvm |
| Sinclair ZX 81 | 81_libretro.dll | sinclair_zx81 | 7z, p, t81, tzx, zip |
| SMS Plus GX | smsplus_libretro.dll | coleco_vision, sega_gamegear, sega_mastersystem, sega_sg1000 | 7z, bin, col, gg, rom, sg, sms, zip |
| Snes9x | snes9x_libretro.dll | nintendo_super_nes | 7z, bs, fig, sfc, smc, st, swc, zip |
| Snes9x 2002 | snes9x2002_libretro.dll | nintendo_super_nes | 7z, bsx, dx2, fig, gd3, gd7, sfc, smc, swc, zip |
| Snes9x 2005 | snes9x2005_libretro.dll | nintendo_super_nes | 7z, bsx, dx2, fig, gd3, gd7, sfc, smc, swc, zip |
| Snes9x 2005 Plus | snes9x2005_plus_libretro.dll | nintendo_super_nes | 7z, bsx, dx2, fig, gd3, gd7, sfc, smc, swc, zip |
| Snes9x 2010 | snes9x2010_libretro.dll | nintendo_super_nes | 7z, bsx, dx2, fig, gd3, gd7, sfc, smc, swc, zip |
| Stella | stella_libretro.dll | atari_2600 | 7z, a26, bin, zip |
| Stella 2014 | stella2014_libretro.dll | atari_2600 | 7z, a26, bin, zip |
| Stella 2023 | stella2023_libretro.dll | atari_2600 | 7z, a26, bin, zip |
| SwanStation | swanstation_libretro.dll | sony_playstation | 7z, bin, chd, cue, ecm, exe, img, iso, m3u, mds, pbp, psexe, psf, zip |
| TempGBA | tempgba_libretro.dll | nintendo_gameboyadvance | 7z, agb, bin, gba, gbz, zip |
| TGB Dual | tgbdual_libretro.dll | nintendo_gameboy, nintendo_gameboycolor | 7z, cgb, dmg, gb, gbc, sgb, zip |
| theodore | theodore_libretro.dll | thomson_mo5, thomson_to7 | 7z, fd, k7, m5, m7, rom, sap, zip |
| UAE4ARM | uae4arm_libretro.dll | commodore_amiga | 7z, adf, adz, ccd, cue, dms, hdf, ipf, iso, lha, uae, wrp, zip |
| VBA Next | vba_next_libretro.dll | nintendo_gameboyadvance | 7z, gba, zip |
| VBA-M | vbam_libretro.dll | nintendo_gameboy, nintendo_gameboyadvance, nintendo_gameboycolor | 7z, cgb, dmg, gb, gba, gbc, sgb, zip |
| vecx | vecx_libretro.dll | vectrex | 7z, bin, vec, zip |
| VICE SDL | x64sdl_libretro.dll | commodore_64 | 7z, bin, crt, d64, d6z, d71, d7z, d80, d81, d82, d8z, g41, g4z, g64, g6z, gz, p00, prg, t64, tap, x64, x6z, zip |
| VICE x128 | vice_x128_libretro.dll | commodore_64 | 7z, bin, cmd, crt, d2m, d4m, d64, d6z, d71, d7z, d80, d81, d82, d8z, g41, g4z, g64, g6z, gz, m3u, nbz, nib, p00, prg, t64, tap, vfl, vsf, x64, x6z, zip |
| VICE x64 | vice_x64_libretro.dll | commodore_64 | 7z, bin, cmd, crt, d2m, d4m, d64, d6z, d71, d7z, d80, d81, d82, d8z, g41, g4z, g64, g6z, gz, m3u, nbz, nib, p00, prg, t64, tap, vfl, vsf, x64, x6z, zip |
| VICE x64sc | vice_x64sc_libretro.dll | commodore_64 | 7z, bin, cmd, crt, d2m, d4m, d64, d6z, d71, d7z, d80, d81, d82, d8z, g41, g4z, g64, g6z, gz, m3u, nbz, nib, p00, prg, t64, tap, vfl, vsf, x64, x6z, zip |
| VICE xcbm2 | vice_xcbm2_libretro.dll | commodore_cbm2 | 7z, bin, cmd, crt, d2m, d4m, d64, d6z, d71, d7z, d80, d81, d82, d8z, g41, g4z, g64, g6z, gz, m3u, nbz, nib, p00, prg, t64, tap, vfl, vsf, x64, x6z, zip |
| VICE xcbm5x0 | vice_xcbm5x0_libretro.dll | commodore_cbm5x0 | 7z, bin, cmd, crt, d2m, d4m, d64, d6z, d71, d7z, d80, d81, d82, d8z, g41, g4z, g64, g6z, gz, m3u, nbz, nib, p00, prg, t64, tap, vfl, vsf, x64, x6z, zip |
| VICE xpet | vice_xpet_libretro.dll | commodore_pet | 7z, bin, cmd, crt, d2m, d4m, d64, d6z, d71, d7z, d80, d81, d82, d8z, g41, g4z, g64, g6z, gz, m3u, nbz, nib, p00, prg, t64, tap, vfl, vsf, x64, x6z, zip |
| VICE xscpu64 | vice_xscpu64_libretro.dll | commodore_64 | 7z, bin, cmd, crt, d2m, d4m, d64, d6z, d71, d7z, d80, d81, d82, d8z, g41, g4z, g64, g6z, gz, m3u, nbz, nib, p00, prg, t64, tap, vfl, vsf, x64, x6z, zip |
| VICE xvic | vice_xvic_libretro.dll | commodore_vci20 | 20, 40, 60, 7z, a0, b0, bin, cmd, crt, d2m, d4m, d64, d6z, d71, d7z, d80, d81, d82, d8z, g41, g4z, g64, g6z, gz, m3u, nbz, nib, p00, prg, rom, t64, tap, vfl, vsf, x64, x6z, zip |
| Virtual Jaguar | virtualjaguar_libretro.dll | atari_jaguar | 7z, abs, bin, cof, j64, jag, prg, rom, zip |
| virtualxt | virtualxt_libretro.dll | pc_dos | 7z, img, zip |
| YabaSanshiro | yabasanshiro_libretro.dll | sega_saturn | 7z, bin, ccd, chd, cue, iso, mds, zip |
| Yabause | yabause_libretro.dll | sega_saturn | 7z, bin, ccd, chd, cue, iso, m3u, mds, zip |
