import { mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join, sep } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Game } from '../../shared/types'
import {
  ANTICHEAT_SCAN_LIMIT,
  AntiCheatScanError,
  antiCheatOfPaths,
  findAntiCheat,
  gameRiskTags,
  scanAntiCheat,
  type FsIo
} from './anticheat'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'playout-anticheat-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function touch(rel: string): Promise<void> {
  const path = join(root, rel)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, '')
}

describe('gameRiskTags', () => {
  it('gathers risk tags from Steam tags, genres and tags, each once in RISK_TAGS order', () => {
    const game = {
      metadata: {
        steamTags: { tags: ['Shooter', 'pvp', 'Multiplayer'] },
        genres: ['Massively Multiplayer', 'Action'],
        tags: ['multiplayer', 'Free to Play']
      }
    } as Pick<Game, 'metadata'>
    expect(gameRiskTags(game)).toEqual([
      'Free to Play',
      'PvP',
      'Massively Multiplayer',
      'Multiplayer'
    ])
  })

  it('gives none for a game without tags', () => {
    expect(gameRiskTags({ metadata: {} } as Pick<Game, 'metadata'>)).toEqual([])
  })
})

describe('antiCheatOfPaths', () => {
  it.each([
    ['easyanticheat/easyanticheat_eos_setup.exe', 'Easy Anti-Cheat'],
    ['EasyAntiCheat/cuisine_royale/EasyAntiCheat_Setup.exe', 'Easy Anti-Cheat'],
    ['easyanticheat_x64.dll', 'Easy Anti-Cheat'],
    ['start_protected_game.exe', 'Easy Anti-Cheat'],
    ['Sub/BattlEye/BEService_x64.exe', 'BattlEye'],
    ['beclient_x64.dll', 'BattlEye'],
    ['__Installer/EAAntiCheat/EAAntiCheat.Installer.exe', 'EA Javelin Anticheat'],
    ['EAAntiCheat.GameServiceLauncher.exe', 'EA Javelin Anticheat'],
    ['live/ShooterGame/Binaries/Win64/VALORANT-Win64-Shipping.exe', 'Riot Vanguard'],
    ['Game/League of Legends.exe', 'Riot Vanguard'],
    ['pso2_bin/GameGuard.des', 'nProtect GameGuard'],
    ['XIGNCODE/x3.xem', 'XIGNCODE3'],
    ['pb/pbsv.dll', 'PunkBuster'],
    ['pb/pbcl.dll', 'PunkBuster'],
    ['install/punkbuster/', 'PunkBuster'],
    ['Binaries/pbsvc.exe', 'PunkBuster'],
    ['AceAntibotClient/InGame/x64/ACE-ATS64.dll', 'ACE'],
    ['game/deltaforce/binaries/win64/anticheatexpert/', 'ACE'],
    ['Randgrid.sys', 'Ricochet'],
    ['mhypbase.dll', 'HoYoKProtect'],
    ['equ8_conf.json', 'EQU8']
  ])('%s -> %s', (path, name) => {
    expect(antiCheatOfPaths([path])).toEqual([name])
  })

  it('ignores near misses', () => {
    expect(
      antiCheatOfPaths([
        'pb/',
        'pb/readme.txt',
        'my_easyanticheat_notes.txt',
        'battleyeless.exe',
        'notstart_protected_game.exe',
        'sub/start_protected_game.exe',
        'game.exe',
        'xem/',
        'gameguard.desc',
        'beservice.exe.bak'
      ])
    ).toEqual([])
  })

  it('lists each anti-cheat once in a fixed order', () => {
    expect(
      antiCheatOfPaths(['battleye/beservice.exe', 'easyanticheat/', 'easyanticheat_x64.dll'])
    ).toEqual(['Easy Anti-Cheat', 'BattlEye'])
  })
})

describe('findAntiCheat', () => {
  it('finds anti-cheat files and folders in the game folder', async () => {
    await touch('EasyAntiCheat/EasyAntiCheat_EOS_Setup.exe')
    await touch('BattlEye/BEService_x64.exe')
    await touch('Game.exe')
    expect(await findAntiCheat(root)).toEqual(['Easy Anti-Cheat', 'BattlEye'])
  })

  it('finds a folder five names deep but not deeper', async () => {
    await touch('Game/DeltaForce/Binaries/Win64/AntiCheatExpert/InGame/x64/ACE-ATS64.dll')
    expect(await findAntiCheat(root)).toEqual(['ACE'])
    await rm(join(root, 'Game'), { recursive: true })
    await touch('a/b/c/d/e/Randgrid.sys')
    expect(await findAntiCheat(root)).toEqual([])
  })

  it('gives nothing for a clean or missing folder', async () => {
    await touch('bin/game.exe')
    expect(await findAntiCheat(root)).toEqual([])
    expect(await findAntiCheat(join(root, 'missing'))).toEqual([])
  })

  it('does not follow junctions', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'playout-anticheat-out-'))
    try {
      await mkdir(join(outside, 'BattlEye'))
      await writeFile(join(outside, 'BattlEye', 'BEService.exe'), '')
      await symlink(outside, join(root, 'linked'), 'junction')
      expect(await findAntiCheat(root)).toEqual([])
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('skips links, WindowsApps and unreadable subfolders, and says the scan was incomplete', async () => {
    const opened: string[] = []
    const io: FsIo = {
      async readdir(dir) {
        opened.push(dir)
        if (dir === 'G') {
          return [
            { name: 'Link', isDirectory: true, isLink: true },
            { name: 'WindowsApps', isDirectory: true, isLink: false },
            { name: 'Broken', isDirectory: true, isLink: false },
            { name: 'Randgrid.sys', isDirectory: false, isLink: true },
            ...Array.from({ length: 30000 }, (_, i) => ({
              name: `f${i}.pak`,
              isDirectory: false,
              isLink: false
            })),
            { name: 'BEService.exe', isDirectory: false, isLink: false }
          ]
        }
        if (dir === join('G', 'Broken')) throw new Error('EPERM')
        return [{ name: 'Randgrid.sys', isDirectory: false, isLink: false }]
      }
    }
    expect(await scanAntiCheat('G', io)).toEqual({ names: ['BattlEye'], complete: false })
    expect(opened).toEqual(['G', join('G', 'Broken')])
    expect(await findAntiCheat('G', io)).toEqual(['BattlEye'])
  })

  it('throws for a protected (WindowsApps) or unreadable game folder instead of giving none', async () => {
    const io: FsIo = {
      async readdir() {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      }
    }
    for (const dir of [
      'C:\\Program Files\\WindowsApps\\Game_1.0_x64__abc',
      'D:/XboxGames/windowsapps/Game'
    ]) {
      await expect(findAntiCheat(dir, { readdir: async () => [] })).rejects.toMatchObject({
        name: 'AntiCheatScanError',
        reason: 'protected'
      })
    }
    await expect(findAntiCheat('G', io)).rejects.toBeInstanceOf(AntiCheatScanError)
    await expect(findAntiCheat('G', io)).rejects.toMatchObject({ reason: 'unreadable' })
    // Not a WindowsApps segment: scanned as usual.
    expect(
      await findAntiCheat('C:\\Games\\MyWindowsAppsGame', { readdir: async () => [] })
    ).toEqual([])
  })

  it('reaches deep anti-cheat folders past a folder of many loose files', async () => {
    const tree: Record<string, Array<{ name: string; isDirectory: boolean; isLink: boolean }>> = {
      G: [{ name: 'Game', isDirectory: true, isLink: false }],
      [join('G', 'Game')]: [
        { name: 'Content', isDirectory: true, isLink: false },
        { name: 'DeltaForce', isDirectory: true, isLink: false }
      ],
      [join('G', 'Game', 'Content')]: Array.from({ length: 20001 }, (_, i) => ({
        name: `asset${i}.uasset`,
        isDirectory: false,
        isLink: false
      })),
      [join('G', 'Game', 'DeltaForce')]: [{ name: 'Binaries', isDirectory: true, isLink: false }],
      [join('G', 'Game', 'DeltaForce', 'Binaries')]: [
        { name: 'Win64', isDirectory: true, isLink: false }
      ],
      [join('G', 'Game', 'DeltaForce', 'Binaries', 'Win64')]: [
        { name: 'AntiCheatExpert', isDirectory: true, isLink: false }
      ]
    }
    const io: FsIo = { readdir: async (dir) => tree[dir] ?? [] }
    expect(await scanAntiCheat('G', io)).toEqual({ names: ['ACE'], complete: true })
  })

  it('stops at the folder limit and treats a cut-short scan that found nothing as unknown', async () => {
    // 30 subfolders in every folder down to the third level, which is empty: 1 + 30 + 900 + 27000 folders within
    // reach, so the limit is met on the third level. Every name read is tested against every rule, so the tree is
    // kept to about 28,000 names: with 200 subfolders in every folder (4 million names a scan) this test took
    // 6-12 s alone and passed its 20 s timeout when the whole suite ran in parallel.
    const subfolders = Array.from({ length: 30 }, (_, i) => ({
      name: `d${i}`,
      isDirectory: true,
      isLink: false
    }))
    const opened: string[] = []
    const io: FsIo = {
      async readdir(dir) {
        opened.push(dir)
        return dir.split(sep).length < 4 ? subfolders : []
      }
    }
    expect(await scanAntiCheat('G', io)).toEqual({ names: [], complete: false })
    expect(opened).toHaveLength(ANTICHEAT_SCAN_LIMIT)
    // Nearest the top first, each folder once: the last one opened is on the third level down.
    expect(new Set(opened).size).toBe(ANTICHEAT_SCAN_LIMIT)
    expect(opened[1 + 30 + 900]).toBe(join('G', 'd0', 'd0', 'd0'))
    expect(opened.at(-1)?.split(sep)).toHaveLength(4)
    opened.length = 0
    await expect(findAntiCheat('G', io)).rejects.toMatchObject({ reason: 'incomplete' })
    expect(opened).toHaveLength(ANTICHEAT_SCAN_LIMIT)
  })

  it('opens subfolders breadth first and passes over unreadable ones', async () => {
    const io: FsIo = {
      async readdir(dir) {
        if (dir === 'G') {
          return [
            { name: 'Broken', isDirectory: true, isLink: false },
            { name: 'BattlEye', isDirectory: true, isLink: false }
          ]
        }
        if (dir === join('G', 'Broken')) throw new Error('EPERM')
        return [{ name: 'BEClient_x64.dll', isDirectory: false, isLink: false }]
      }
    }
    expect(await findAntiCheat('G', io)).toEqual(['BattlEye'])
  })
})
