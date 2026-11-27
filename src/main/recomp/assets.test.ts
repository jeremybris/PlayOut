import { describe, expect, it } from 'vitest'
import {
  followAsset,
  isInstallerName,
  isSidePiece,
  notForWindows,
  pickWindowsAsset,
  scoreWindowsAsset,
  wildcardMatch,
  type ReleaseAsset
} from './assets'

const files = (...names: string[]): ReleaseAsset[] =>
  names.map((name) => ({
    name,
    size: 1000,
    browser_download_url: `https://github.com/o/r/releases/download/t/${name}`
  }))

const pick = (
  assets: ReleaseAsset[],
  hint: Parameters<typeof pickWindowsAsset>[1] = { pattern: null }
): string | null => pickWindowsAsset(assets, hint)?.asset.name ?? null

// Real release file lists of Zelda64Recomp (from its GitHub releases).
const ZELDA_122 = files(
  'Zelda64Recompiled-v1.2.2-Linux-ARM64.zip',
  'Zelda64Recompiled-v1.2.2-Linux-Flatpak-X64.zip',
  'Zelda64Recompiled-v1.2.2-Linux-X64.zip',
  'Zelda64Recompiled-v1.2.2-macOS.zip',
  'Zelda64Recompiled-v1.2.2-Windows.zip'
)
const ZELDA_111 = files(
  'Zelda64Recompiled-v1.1.1-Linux-ARM64-AppImage.zip',
  'Zelda64Recompiled-v1.1.1-Linux-ARM64.zip',
  'Zelda64Recompiled-v1.1.1-Linux-x64-AppImage.zip',
  'Zelda64Recompiled-v1.1.1-Linux-x64.tar.gz',
  'Zelda64Recompiled-v1.1.1-Windows-x64.zip'
)
const ZELDA_110 = files(
  'Zelda64Recompiled-v1.1.0-Linux.AppImage',
  'Zelda64Recompiled-v1.1.0-Linux.tar.gz',
  'Zelda64Recompiled-v1.1.0_Windows.zip'
)

describe('pickWindowsAsset', () => {
  it('picks the Windows zip of a real Zelda64Recomp release without a pattern', () => {
    expect(pick(ZELDA_122)).toBe('Zelda64Recompiled-v1.2.2-Windows.zip')
    expect(pick(ZELDA_111)).toBe('Zelda64Recompiled-v1.1.1-Windows-x64.zip')
    expect(pick(ZELDA_110)).toBe('Zelda64Recompiled-v1.1.0_Windows.zip')
  })

  it('follows a catalog wildcard pattern, with separators made one', () => {
    const hint = { pattern: 'Zelda64Recompiled-*-Windows.zip' }
    expect(pick(ZELDA_122, hint)).toBe('Zelda64Recompiled-v1.2.2-Windows.zip')
    // "v1.1.0_Windows.zip": the underscore counts as the pattern's dash.
    expect(pick(ZELDA_110, hint)).toBe('Zelda64Recompiled-v1.1.0_Windows.zip')
    // "-Windows-x64.zip" does not fit the pattern: the scorer still finds it.
    expect(pick(ZELDA_111, hint)).toBe('Zelda64Recompiled-v1.1.1-Windows-x64.zip')
  })

  it('reads an exact name written for another release as the same name with other numbers', () => {
    expect(pick(ZELDA_122, { pattern: 'Zelda64Recompiled-v1.2.0-Windows.zip' })).toBe(
      'Zelda64Recompiled-v1.2.2-Windows.zip'
    )
  })

  it('follows the file installed before into a newer release', () => {
    expect(
      pick(ZELDA_122, {
        pattern: null,
        previousName: 'Zelda64Recompiled-v1.2.1-Windows.zip',
        previousTag: 'v1.2.1'
      })
    ).toBe('Zelda64Recompiled-v1.2.2-Windows.zip')
  })

  it('picks UnleashedRecomp and spaghetti builds by their OS word', () => {
    expect(
      pick(
        files(
          'UnleashedRecomp-Flatpak.zip',
          'UnleashedRecomp-Linux.zip',
          'UnleashedRecomp-Windows.zip',
          'UnleashedRecomp-Windows.pdb'
        )
      )
    ).toBe('UnleashedRecomp-Windows.zip')
    expect(
      pick(
        files(
          'spaghetti-linux-x64.zip',
          'spaghetti-macos.zip',
          'spaghetti-windows.zip',
          'Spaghettify-x86_64.AppImage'
        )
      )
    ).toBe('spaghetti-windows.zip')
  })

  it('never picks Linux, macOS, ARM, debug, source, checksum or console files', () => {
    expect(
      pick(
        files(
          'Game-1.0-Linux-X64.zip',
          'Game-1.0-x86_64.AppImage',
          'Game-1.0-macOS.zip',
          'Game-1.0-Windows.pdb',
          'Game-1.0-Windows-debug.zip',
          'Game-1.0-src.zip',
          'Game-1.0-Windows.zip.sha256',
          'Game-1.0-switch.zip',
          'Game-1.0-android-arm64.apk',
          'Game-1.0-windows-arm64.zip',
          'llvm-mingw-20261006-ucrt-x86_64.zip'
        )
      )
    ).toBeNull()
  })

  it('prefers a portable archive over a setup program, and marks installers', () => {
    expect(pick(files('Game-1.0-win64-Setup.exe', 'Game-1.0-win64.zip'))).toBe('Game-1.0-win64.zip')
    const setupOnly = pickWindowsAsset(files('Game-1.0-Setup.exe', 'Game-1.0-Linux.AppImage'), {
      pattern: null
    })
    expect(setupOnly).toMatchObject({ asset: { name: 'Game-1.0-Setup.exe' }, installer: true })
    expect(pickWindowsAsset(files('Game.msi'), { pattern: null })?.installer).toBe(true)
    expect(pickWindowsAsset(files('Game-windows.7z'), { pattern: null })?.installer).toBe(false)
  })

  it('prefers x64 over 32-bit and the game over its server or tools', () => {
    expect(pick(files('Game-win32.zip', 'Game-win64.zip'))).toBe('Game-win64.zip')
    expect(pick(files('Game-server-windows.zip', 'Game-windows.zip'))).toBe('Game-windows.zip')
    expect(pick(files('Game-windows-tools.zip'))).toBe('Game-windows-tools.zip')
  })

  // Project Avalanche v0.4.2's real files and sizes; RecompLauncher's catalog names the server as its Windows file.
  const AVALANCHE: ReleaseAsset[] = [
    ['ProjectAvalanche-linux-x64.tar.gz', 118718066],
    ['ProjectAvalanche-server-linux-x64.tar.gz', 18795657],
    ['ProjectAvalanche-server-windows-x64.zip', 15896991],
    ['ProjectAvalanche-windows-x64.tar.gz', 96056948],
    ['ProjectAvalanche-windows-x64.zip', 96050034]
  ].map(([name, size]) => ({
    name: name as string,
    size: size as number,
    browser_download_url: `https://github.com/MnkyArts/ProjectAvalanche/releases/download/v0.4.2/${name}`
  }))

  it("takes the game over a catalog pattern naming the game's server, editor, tools or SDK", () => {
    const game = 'ProjectAvalanche-windows-x64.zip'
    expect(pick(AVALANCHE)).toBe(game)
    expect(pick(AVALANCHE, { pattern: 'ProjectAvalanche-server-windows-x64.zip' })).toBe(game)
    // An install of the server (from that catalog) is not followed into the next release.
    expect(
      pick(AVALANCHE, {
        pattern: null,
        previousName: 'ProjectAvalanche-server-windows-x64.zip',
        previousTag: 'v0.4.1'
      })
    ).toBe(game)
    expect(
      pick(
        files('KarMapEditor-1.3-windows-x64.zip', 'KirbyAirRideRecompiled-1.3.1-windows-x64.zip'),
        {
          pattern: 'KarMapEditor-*-windows-x64.zip'
        }
      )
    ).toBe('KirbyAirRideRecompiled-1.3.1-windows-x64.zip')
    expect(
      pick(files('Aerofoil-1.1.7-win64-tools.zip', 'Aerofoil-1.1.7-win64.zip'), {
        pattern: 'Aerofoil-*-win64-tools.zip'
      })
    ).toBe('Aerofoil-1.1.7-win64.zip')
    // No pattern: the games before an SDK whose name scores higher (ReXGlue-EXIT's real files).
    expect(
      pick(files('EXIT1-Recomp.zip', 'EXIT2-Recomp.zip', 'rexglue-sdk-0.9.1-win-amd64.zip'))
    ).toBe('EXIT1-Recomp.zip')
    // A release with only the side piece: the pattern's file still.
    expect(
      pick(files('Game-1.0-server-windows.zip'), { pattern: 'Game-*-server-windows.zip' })
    ).toBe('Game-1.0-server-windows.zip')
  })

  it('of equally good files, takes the largest', () => {
    const sized = (name: string, size: number): ReleaseAsset => ({
      name,
      size,
      browser_download_url: `https://example.com/${name}`
    })
    expect(pick([sized('Game-a-windows.zip', 10), sized('Game-b-windows.zip', 900)])).toBe(
      'Game-b-windows.zip'
    )
  })

  it('keeps a game whose own name has a console word in it', () => {
    expect(pick(files('XboxRecomp-v1.0-windows.zip', 'XboxRecomp-v1.0-linux.zip'))).toBe(
      'XboxRecomp-v1.0-windows.zip'
    )
  })

  it('returns null for an empty release or one with only sources', () => {
    expect(pickWindowsAsset([], { pattern: null })).toBeNull()
    expect(pick(files('source.tar.gz', 'Game.rar'))).toBeNull()
  })

  it('with ties, picks the one most like the previous file', () => {
    expect(
      pick(files('Game-1.1-windows-us.zip', 'Game-1.1-windows-jp.zip'), {
        pattern: null,
        previousName: 'Game-1.0-windows-jp-old.zip'
      })
    ).toBe('Game-1.1-windows-jp.zip')
  })
})

describe('followAsset', () => {
  it('swaps the version of the old tag', () => {
    expect(
      followAsset(
        'Game-v0.3.0-win64.zip',
        'v0.3.0',
        files('Game-v0.6.2-win64.zip', 'Game-v0.6.2-linux.zip')
      )?.name
    ).toBe('Game-v0.6.2-win64.zip')
  })

  it('treats commit ids as version numbers', () => {
    expect(
      followAsset(
        'Game_0.8.7-50-09b5b644_windows.zip',
        'nightly',
        files('Game_0.8.9-12-a1b2c3d4e_windows.zip', 'Game_0.8.9-12-a1b2c3d4e_linux.zip')
      )?.name
    ).toBe('Game_0.8.9-12-a1b2c3d4e_windows.zip')
  })

  it('follows codename releases by their first and last parts', () => {
    expect(
      followAsset(
        'SoH-Ackbar-Delta-Win64.zip',
        '9.0.0',
        files('SoH-Blair-Alfa-Win64.zip', 'SoH-Blair-Alfa-Linux.zip')
      )?.name
    ).toBe('SoH-Blair-Alfa-Win64.zip')
  })

  it('gives up when several files fit', () => {
    expect(followAsset('Game-1.0.zip', '1.0', files('Game-2.0.zip', 'Game-3.0.zip'))).toBeNull()
  })
})

describe('helpers', () => {
  it('matches wildcards case-insensitively', () => {
    expect(
      wildcardMatch('zelda64recompiled-*-windows.zip', 'Zelda64Recompiled-v1.2.2-Windows.zip')
    ).toBe(true)
    expect(wildcardMatch('Game-?.zip', 'Game-1.zip')).toBe(true)
    expect(wildcardMatch('Game-?.zip', 'Game-12.zip')).toBe(false)
    expect(wildcardMatch('Game(1).zip', 'Game(1).zip')).toBe(true)
  })

  it('tells side pieces of a game (server, editors, tools, SDK) from the game', () => {
    for (const n of [
      'ProjectAvalanche-server-windows-x64.zip',
      'BF1943-Reborn-Server-0.4.7.4-windows.zip',
      'fm-editor-1.0-windows.zip',
      'KarMapEditor-1.3-windows-x64.zip',
      'openrac-mod-sdk-1.1.zip',
      'rexglue-sdk-1.0-win-amd64.zip',
      'Aerofoil-1.1.7-win64-tools.zip',
      'Game-save-editor-win64.zip'
    ])
      expect(isSidePiece(n), n).toBe(true)
    for (const n of [
      'ProjectAvalanche-windows-x64.zip',
      'Observer-Recomp-windows.zip',
      'KirbyAirRideRecompiled-1.3.1-windows-x64.zip',
      'Zelda64Recompiled-v1.2.2-Windows.zip'
    ])
      expect(isSidePiece(n), n).toBe(false)
  })

  it('recognises installers', () => {
    expect(isInstallerName('Game-Setup-1.0.exe')).toBe(true)
    expect(isInstallerName('GameInstaller.exe')).toBe(true)
    expect(isInstallerName('Game.msi')).toBe(true)
    expect(isInstallerName('Game.exe')).toBe(false)
    expect(isInstallerName('Game-windows.zip')).toBe(false)
  })

  it('scores only usable Windows files', () => {
    expect(scoreWindowsAsset('Game.exe')).toBeGreaterThan(0)
    expect(scoreWindowsAsset('Game-macOS.zip')).toBeNull()
    expect(scoreWindowsAsset('Game.tar.gz')).toBeNull()
  })
})

describe('notForWindows', () => {
  it('rules out phone, Linux, macOS and ARM builds, names and patterns alike', () => {
    expect(notForWindows('DriftDroid-v1.4.0.apk')).toBe(true)
    expect(notForWindows('WolfensteinRPG-x86_64.AppImage')).toBe(true)
    expect(notForWindows('Game-1.0.dmg')).toBe(true)
    expect(notForWindows('infamous2-recomp_*_aarch64.app.zip')).toBe(true)
    expect(notForWindows('Game-v1.0-Windows.zip')).toBe(false)
    expect(notForWindows('Game-v1.0-universal.zip')).toBe(false)
    expect(notForWindows('Game-*-win64.zip')).toBe(false)
    expect(notForWindows('Game.rar')).toBe(false)
  })
})
