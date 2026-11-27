import type { EmulatorSpec } from './types'

/**
 * The emulators PlayOut downloads, unpacks and sets up on first-time setup, in the order they are set up (small and
 * popular first, the large RetroArch last). Ids are the find-rules ids, so the launcher finds them.
 *
 * Sources were checked on 2026-11-11 (see docs/emulator-setup.md): stable releases, official hosts.
 */
export const EMULATOR_CATALOG: readonly EmulatorSpec[] = [
  {
    id: 'DUCKSTATION',
    name: 'DuckStation',
    folder: 'DuckStation',
    exe: 'duckstation-qt-x64-ReleaseLTCG.exe',
    // A rolling release under the fixed tag "latest" (the project's official channel).
    source: {
      kind: 'github',
      repo: 'stenzek/duckstation',
      asset: /^duckstation-windows-x64-release\.zip$/i
    },
    runtimes: ['vcredist'],
    // Its updater's "Preview Releases" channel: a rolling pre-release under the fixed tag "preview".
    update: {
      channel: 'preview',
      source: {
        kind: 'github-tag',
        repo: 'stenzek/duckstation',
        tag: 'preview',
        asset: /^duckstation-windows-x64-release\.zip$/i
      }
    }
  },
  {
    id: 'PCSX2',
    name: 'PCSX2',
    folder: 'PCSX2',
    exe: 'pcsx2-qt.exe',
    source: { kind: 'github', repo: 'PCSX2/pcsx2', asset: /^pcsx2-v[\d.]+-windows-x64-Qt\.7z$/i },
    runtimes: ['vcredist'],
    // The nightlies (a GitHub pre-release per commit), the builds its own updater offers on the nightly channel.
    update: {
      channel: 'nightly',
      source: {
        kind: 'github-newest',
        repo: 'PCSX2/pcsx2',
        asset: [/^pcsx2-v[\d.]+-windows-x64-Qt\.7z$/i]
      }
    }
  },
  {
    id: 'RPCS3',
    name: 'RPCS3',
    folder: 'RPCS3',
    exe: 'rpcs3.exe',
    // The user's own preconfigured RPCS3 (settings, firmware, patches), an unpacked folder in their public Google
    // Drive, instead of the official GitHub build (docs/emulator-setup.md, "RPCS3 from Google Drive"). Its log folder
    // (the other PC's logs) is left out.
    source: { kind: 'drive-folder', folderId: '1rabB9ZidwwYTCTwYqNyJ1aMEhumTAUyG', skip: ['log'] },
    runtimes: ['vcredist'],
    // RPCS3's update server (what Help > Check for updates reads): only the program files. The Drive copy's settings,
    // firmware and patches are not in the build, so they stay.
    update: { channel: 'nightly', source: { kind: 'rpcs3' } }
  },
  {
    id: 'DOLPHIN',
    name: 'Dolphin',
    folder: 'Dolphin',
    exe: 'Dolphin.exe',
    source: { kind: 'dolphin' },
    runtimes: ['vcredist'],
    update: { channel: 'dev', source: { kind: 'dolphin-dev' } }
  },
  {
    id: 'PPSSPP',
    name: 'PPSSPP',
    folder: 'PPSSPP',
    exe: 'PPSSPPWindows64.exe',
    source: {
      kind: 'github',
      repo: 'hrydgard/ppsspp',
      asset: /^PPSSPP-v[\d.]+-Windows-x64\.zip$/i
    },
    update: { channel: 'dev', source: { kind: 'ppsspp-dev' } }
  },
  {
    id: 'FLYCAST',
    name: 'Flycast',
    folder: 'Flycast',
    exe: 'flycast.exe',
    source: { kind: 'github', repo: 'flyinghead/flycast', asset: /^flycast-win64-[\w.-]+\.zip$/i },
    update: { channel: 'dev', source: { kind: 'flycast-dev' } }
  },
  {
    id: 'AZAHAR',
    name: 'Azahar',
    folder: 'Azahar',
    exe: 'azahar.exe',
    // The MSYS2 build carries its own runtime DLLs (Azahar's README recommends it).
    source: {
      kind: 'github',
      repo: 'azahar-emu/azahar',
      asset: /^azahar-windows-msys2-[^-]+\.zip$/i
    },
    // Its newest pre-release (release candidates; it publishes no nightlies). From 2127 the Windows zip is the MSVC
    // build only (no MSYS2 one), which needs the Visual C++ runtime.
    update: {
      channel: 'pre-release',
      source: {
        kind: 'github-newest',
        repo: 'azahar-emu/azahar',
        asset: [/^azahar-windows-msvc-[\w.-]+\.zip$/i, /^azahar-windows-msys2-[\w.-]+\.zip$/i]
      },
      runtimes: ['vcredist']
    }
  },
  {
    id: 'MELONDS',
    name: 'melonDS',
    folder: 'melonDS',
    exe: 'melonDS.exe',
    source: {
      kind: 'github',
      repo: 'melonDS-emu/melonDS',
      asset: /^melonDS-[\w.]+-windows-x86_64\.zip$/i
    },
    update: { channel: 'nightly', source: { kind: 'melonds-nightly' } }
  },
  {
    id: 'MGBA',
    name: 'mGBA',
    folder: 'mGBA',
    exe: 'mGBA.exe',
    source: { kind: 'github', repo: 'mgba-emu/mgba', asset: /^mGBA-[\d.]+-win64\.7z$/i },
    // Its own updater's manifest, dev channel.
    update: { channel: 'dev', source: { kind: 'mgba-dev' } }
  },
  {
    id: 'RYUJINX',
    name: 'Ryujinx',
    folder: 'Ryujinx',
    exe: 'Ryujinx.exe',
    source: {
      kind: 'forgejo',
      api: 'https://git.ryujinx.app/api/v1/repos/projects/Ryubing/releases/latest',
      asset: /^ryujinx-[\d.]+-win_x64\.zip$/i
    },
    // Its own updater's server, canary channel.
    update: { channel: 'canary', source: { kind: 'ryujinx-canary' } }
  },
  {
    id: 'M2EMULATOR',
    name: 'Model 2 Emulator',
    folder: 'Model2',
    exe: 'EMULATOR.EXE',
    source: {
      kind: 'fixed',
      url: 'https://raw.githubusercontent.com/PhoenixInteractiveNL/edc-repo0004/master/m2emulator/1.1a.7z',
      version: '1.1a',
      // 529,235 bytes, fetched 2026-11-11.
      sha256: '338c579a2ce9a9661cc6036999a76b19241140dadce42599a8c9e5fbe990fac3',
      fileName: 'm2emulator-1.1a.7z'
    },
    // No update channel (Update all emulators skips it): frozen at 1.1a since 2014.
    runtimes: ['directx9']
  },
  {
    id: 'SCUMMVM',
    name: 'ScummVM',
    folder: 'ScummVM',
    exe: 'scummvm.exe',
    source: { kind: 'scummvm' },
    update: { channel: 'daily', source: { kind: 'scummvm-daily' } }
  },
  {
    id: 'MAME',
    name: 'MAME',
    folder: 'MAME',
    exe: 'mame.exe',
    source: { kind: 'github', repo: 'mamedev/mame', asset: /^mame\d+b_(?:x64|64bit)\.exe$/i },
    // MAME publishes no nightlies: its newest release.
    update: {
      channel: 'stable',
      source: { kind: 'github', repo: 'mamedev/mame', asset: /^mame\d+b_(?:x64|64bit)\.exe$/i }
    }
  },
  {
    id: 'RETROARCH',
    name: 'RetroArch',
    folder: 'RetroArch',
    exe: 'retroarch.exe',
    source: { kind: 'retroarch' },
    update: { channel: 'nightly', source: { kind: 'retroarch-nightly' } },
    keep: ['retroarch.cfg']
  }
]

export function specOf(id: string): EmulatorSpec | undefined {
  return EMULATOR_CATALOG.find((s) => s.id === id)
}
