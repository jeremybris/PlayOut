import { mkdtemp, readdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Logger } from '../logger'
import {
  FINDS_URL,
  PLANS_URL,
  RL_CATALOG_URL,
  buildCatalog,
  listDate,
  loadCatalog,
  parseSize,
  slugOf,
  type RecompCatalog
} from './catalog'

// Fixtures: small excerpts of the real catalogs (decomp-buddy finds.json / plans.json and RecompLauncher's
// pc-catalog.json, November 2026), trimmed to the fields the catalog reads. A few entries are adjusted to reach a
// branch (noted where so).

const ZELDA_SHA = 'd02b95f1cf5e4d44d6587fa6136c6db521f61aa41ba8700c05f91bea8b0a26d0'
const SPAGHETTI_SHA = 'bf7bd7cdb5f412c7b370af92949b9431ce7503968631f8cacd607933fb32aff3'

const FINDS = {
  updatedAt: '2026-11-06T00:00:00Z',
  games: [
    {
      repo: 'TwilitRealm/dusklight',
      title: 'The Legend of Zelda: Twilight Princess',
      console: 'GameCube',
      notes: 'Twilight Princess decompilation, natively on PC',
      boxartUrl: 'https://raw.githubusercontent.com/libretro-thumbnails/tp.png'
    }
  ]
}

function plan(game: Record<string, unknown>, extra: Record<string, unknown> = {}): unknown {
  return {
    tag: (game.build as { release_tag?: string } | undefined)?.release_tag ?? null,
    targets: { windows: { redirect_repo: null, games: [game] } },
    facts: { completeness: 'unknown', save_paths: [], health: { archived: false, dmca: false } },
    trust: {},
    ...extra
  }
}

const PLANS = {
  updatedAt: '2026-11-06T00:00:00Z',
  plans: {
    'github:zelda64recomp/zelda64recomp': plan(
      {
        game_title: "The Legend of Zelda: Majora's Mask",
        console: 'Nintendo 64',
        build: {
          method: 'release',
          release_asset: 'Zelda64Recompiled-v1.2.2-Windows.zip',
          release_tag: 'v1.2.2',
          executable: 'Zelda64Recompiled.exe',
          scanned: { sha256: ZELDA_SHA, size: 28940501 }
        },
        game_files: [
          {
            label: "Majora's Mask US ROM",
            description: "Your own legal copy of the US version of Majora's Mask for Nintendo 64.",
            accepted_formats: ['.z64', '.n64', '.rom'],
            expected_filename: null,
            how_provided: 'in_app_picker',
            drop_into: 'Game Files',
            kind: 'game',
            expected_region: 'USA',
            expected_hashes: [{ algo: 'sha1', value: 'd6133ace5afaa0882cf214cf88daba39e266c078' }],
            expected_serial: null
          }
        ],
        first_run: [
          'Extract the release asset to a folder',
          'Run Zelda64Recompiled.exe',
          "When prompted by the launcher, provide your US Majora's Mask ROM file"
        ],
        notes: ["Only the US NTSC-U version of Majora's Mask is supported"]
      },
      {
        facts: {
          completeness: 'unknown',
          save_paths: [
            { platform: 'windows', path: '%LOCALAPPDATA%\\Zelda64Recompiled\\saves' },
            { platform: 'linux', path: '~/.config/Zelda64Recompiled/saves' }
          ],
          health: { archived: false, dmca: false },
          features: { fps60: '…', widescreen: '…', mods: '…' }
        },
        trust: { license: 'GNU General Public License v3.0' }
      }
    ),
    'github:harbourmasters/2ship2harkinian': plan({
      game_title: "The Legend of Zelda: Majora's Mask",
      console: 'Nintendo 64',
      build: {
        method: 'release',
        release_asset: '2Ship-Battler-Bravo-Win64.zip',
        release_tag: '5.0.1',
        executable: '2ship.exe',
        scanned: {
          sha256: 'a46664a01623ad5d7cc82d29a9889699f6a98c9501c7a959a089f34380c1f078',
          size: 44976935
        }
      },
      game_files: [],
      first_run: [],
      notes: []
    }),
    'github:harbourmasters/spaghettikart': plan({
      game_title: 'Mario Kart 64',
      console: 'Nintendo 64',
      build: {
        method: 'release',
        release_asset: 'spaghetti-windows.zip',
        release_tag: '1.0.0',
        executable: 'Spaghettify.exe',
        scanned: { sha256: SPAGHETTI_SHA, size: 7806456 }
      },
      game_files: [
        {
          label: 'Mario Kart 64 US ROM',
          description:
            'Your own legally obtained dump of the US version of Mario Kart 64 in .z64 format',
          accepted_formats: ['.z64'],
          how_provided: 'in_app_picker',
          drop_into: 'Game Files',
          kind: 'game',
          expected_region: 'USA',
          expected_hashes: [{ algo: 'sha1', value: '579c48e211ae952530ffc8738709f078d5dd215e' }]
        }
      ],
      first_run: [
        'Extract spaghetti-windows.zip to a folder',
        'Select your US Mario Kart 64 ROM when prompted'
      ],
      notes: ['Only the US version of the ROM is supported']
    }),
    'gitlab:sonicdcer/mariokart64recomp': plan(
      {
        game_title: 'Mario Kart 64',
        console: 'Nintendo 64',
        build: {
          method: 'release',
          release_asset: 'MarioKart64Recompiled-v0.9.2-Windows-RelWithDebInfo.zip',
          release_tag: 'v0.9.2',
          executable: 'MarioKart64Recompiled.exe',
          scanned: {
            sha256: '4b41226ad7d4c6012878194fa88fe1a83c1fa8f425dfbaa2a7ea87eb01c1c2b4',
            size: 23847630
          }
        },
        game_files: [
          {
            label: 'Mario Kart 64 US ROM',
            accepted_formats: ['.z64', '.n64', '.rom'],
            how_provided: 'in_app_picker',
            drop_into: 'Game Files',
            kind: 'game',
            expected_region: 'USA',
            expected_hashes: []
          }
        ],
        first_run: [],
        notes: []
      },
      {
        facts: {
          completeness: 'playable', // adjusted (real: unknown) to reach the status tag
          save_paths: [
            { platform: 'windows', path: '%LOCALAPPDATA%\\MarioKart64Recompiled\\saves' }
          ],
          health: { archived: false, dmca: false }
        }
      }
    ),
    'github:hedge-dev/unleashedrecomp': plan({
      game_title: 'Sonic Unleashed',
      console: 'Xbox 360',
      build: {
        method: 'release',
        release_asset: 'UnleashedRecomp-Windows.zip',
        release_tag: 'v1.0.3',
        executable: 'UnleashedRecomp.exe',
        scanned: {
          sha256: '65793fbf3bfa392703275d3a1759bea20bc3d62f3bb39b066b85e5e7fb2d5d32',
          size: 53386467
        }
      },
      game_files: [
        {
          label: 'Sonic Unleashed game disc/files',
          description:
            'Files from your own legally owned copy of Sonic Unleashed for Xbox 360 (US or EU version).',
          accepted_formats: ['.iso', '.gcm', 'folder'],
          how_provided: 'in_app_picker',
          drop_into: 'Game Files',
          kind: 'game',
          expected_region: 'USA',
          expected_hashes: []
        },
        {
          label: 'Title Update',
          description:
            'The Title Update for Sonic Unleashed (Xbox 360), required for the game to function.',
          accepted_formats: [],
          how_provided: 'in_app_picker',
          drop_into: 'Game Files',
          kind: 'update',
          expected_region: 'any',
          expected_hashes: []
        },
        {
          label: 'DLC (Adventure Packs)',
          description:
            'Optional but highly recommended DLC Adventure Packs for Sonic Unleashed (Xbox 360).',
          accepted_formats: [],
          how_provided: 'in_app_picker',
          drop_into: 'Game Files',
          kind: 'dlc',
          expected_region: 'any',
          expected_hashes: []
        }
      ],
      first_run: [],
      notes: []
    }),
    'github:twilitrealm/dusklight': plan(
      {
        game_title: 'The Legend of Zelda: Twilight Princess',
        console: 'Nintendo GameCube',
        build: {
          method: 'release',
          release_asset: 'Dusklight-v2.0.3-win32-x86_64.zip',
          release_tag: 'v2.0.3',
          executable: 'dusklight.exe',
          scanned: {
            sha256: 'ac63514eeb13cd4e9bd22be02dabee4952d1331a78f0496326bba2b577b12caf',
            size: 56037777
          }
        },
        game_files: [
          {
            label: 'GameCube disc image',
            description: 'A disc image from your legally owned GameCube copy of Twilight Princess',
            accepted_formats: ['.iso', '.gcm', '.rvz', '.wia', '.wbfs', '.ciso', '.gcz'],
            how_provided: 'command_line',
            drop_into: 'Game Files',
            notes: 'Pass via --dvd flag when running the executable',
            kind: 'game',
            expected_region: 'any',
            expected_hashes: []
          }
        ],
        first_run: [],
        notes: []
      },
      { trust: { license: 'Creative Commons Zero v1.0 Universal' } }
    ),
    // Two of the six games of a real multi-game repo.
    'github:dogparty/ipodclickwheelrecomps': {
      tag: 'v1.0.1',
      targets: {
        windows: {
          redirect_repo: null,
          games: [
            {
              game_title: 'The Sims Bowling',
              console: 'Apple iPod Classic',
              build: {
                method: 'release',
                release_asset: 'bowling-1.0.1-windows-x64.zip',
                release_tag: 'v1.0.1',
                executable: null,
                scanned: {
                  sha256: 'e42032432b9be38375fcddfa6c091ec5d7baf4ba4b118ba8c3c6df891ad77c47',
                  size: 12364630
                }
              },
              game_files: [
                {
                  label: 'The Sims Bowling decrypted game folder (1500C)',
                  how_provided: 'in_app_picker',
                  drop_into: 'Game Files',
                  kind: 'game',
                  accepted_formats: ['folder']
                }
              ]
            },
            {
              game_title: 'Mini Golf',
              console: 'Apple iPod Classic',
              build: {
                method: 'release',
                release_asset: 'minigolf-1.0.1-windows-x64.zip',
                release_tag: 'v1.0.1',
                executable: null,
                scanned: {
                  sha256: 'e52d24f09ef6fa6dc22e82b0d3b426484c40afeeccb47d3f20d9c61a3af0baa3',
                  size: 6457432
                }
              },
              game_files: []
            }
          ]
        }
      },
      facts: { completeness: 'unknown', save_paths: [], health: { archived: true, dmca: false } }
    },
    // Installer download (real asset name; the game's plan trimmed).
    'github:open-goal/launcher': plan({
      game_title: 'Jak and Daxter: The Precursor Legacy',
      console: 'Sony PlayStation 2',
      build: {
        method: 'release',
        release_asset: 'OpenGOAL-Launcher_2.11.2_x64_en-US.msi',
        release_tag: 'v2.11.2',
        executable: 'OpenGOAL Launcher.exe'
      },
      game_files: []
    }),
    // The scanned download was taken down and nothing newer was seen: no entry.
    'github:gtteancum/opengtps1': plan({
      game_title: 'Gran Turismo 2',
      console: 'PlayStation',
      build: {
        method: 'release',
        release_asset: 'OpenGTPS1-0.9b-win-x64.zip',
        release_tag: 'v0.9b',
        executable: 'GranTurismo2PC.exe',
        gone: '2026-10-27'
      },
      game_files: []
    }),
    // Taken down (DMCA): no entry.
    'github:hezkore/hez-gta-re3': plan(
      {
        game_title: 'Grand Theft Auto III',
        console: 'PC (Windows)',
        build: {
          method: 'release',
          release_asset: 'gta3.zip',
          release_tag: 'v1',
          executable: 'gta3.exe'
        },
        game_files: []
      },
      {
        facts: { completeness: 'unknown', save_paths: [], health: { archived: false, dmca: true } }
      }
    ),
    // Build from source only: no entry.
    'github:pret/pokeheartgold': plan({
      game_title: 'Pokémon HeartGold',
      console: 'Nintendo DS',
      build: { method: 'source', release_asset: null, release_tag: null, executable: null },
      game_files: []
    })
  }
}

function rlApp(app: Record<string, unknown>): Record<string, unknown> {
  return {
    systems: ['windows', 'linux'],
    tags: [],
    features: [],
    license: '',
    description: '',
    ...app
  }
}

const RL = {
  catalogVersion: 1,
  platform: 'pc',
  origins: [{ id: 'n64', name: 'Nintendo 64' }],
  titles: [
    {
      id: 'mario-kart-64',
      name: 'Mario Kart 64',
      origin: 'n64',
      pick: 'pc:mariokart64recomp',
      pc: ['spaghettikart', 'mariokart64recomp', 'mariokart64recomp-2'],
      ps5: []
    },
    {
      id: 'the-legend-of-zelda-majora-s-mask',
      name: "The Legend of Zelda: Majora's Mask",
      origin: 'n64',
      pick: 'pc:zelda64recomp',
      pc: ['zelda64recomp', '2ship2harkinian'],
      ps5: []
    },
    // Adjusted: real title with a made-up second member whose game name differs, and one from another console.
    {
      id: 'sonic-unleashed',
      name: 'Sonic Unleashed',
      origin: 'x360',
      pick: 'pc:unleashedrecomp',
      pc: ['unleashedrecomp', 'unleashed-hd-port', 'unleashed-ps3-port'],
      ps5: []
    }
  ],
  apps: [
    rlApp({
      id: 'zelda64recomp',
      name: 'Zelda 64: Recompiled',
      game: "The Legend of Zelda: Majora's Mask",
      origin: 'n64',
      repo: 'Zelda64Recomp/Zelda64Recomp',
      version: '1.2.2',
      released: '2025-08-27',
      size: '28 MB',
      downloads: 396694,
      stars: 7692,
      blurb:
        "Majora's Mask as a native PC game: widescreen, high frame rates, mods and modern controls.",
      author: 'Zelda64Recomp',
      icon: 'https://recompstore.com/media/pc-zelda64recomp-icon-8be094b6.png',
      cover: 'https://recompstore.com/media/pc-zelda64recomp-cover-3c1c37be.jpg',
      hero: 'https://recompstore.com/media/pc-zelda64recomp-hero_web-3ffc0b23.jpg',
      systems: ['windows', 'linux', 'macos'],
      assets: {
        windows: 'Zelda64Recompiled-*-Windows.zip',
        linux: 'Zelda64Recompiled-*-Linux-X64.zip'
      },
      tags: ['High FPS', 'Widescreen', 'Gyro', 'Mods', 'HD Textures'],
      features: ['High frame rate support', 'Widescreen and ultrawide'],
      license: 'GPL-3.0',
      tag: 'v1.2.2',
      files: {
        macos: {
          name: 'Zelda64Recompiled-v1.2.2-macOS.zip',
          sha256: 'f369815d7ba2a1139a6fab8a0aa51c52e5f064dcfcce649eb888fdef9f648689',
          scan: 'green'
        }
      },
      boot: {
        kind: 'portable',
        start: 'Zelda64Recompiled.exe',
        files: {
          how: 'self',
          accepts: 'file',
          what: "Your Majora's Mask ROM: the North American N64 version. Pick it in the game's main menu the first time."
        }
      },
      title: 'the-legend-of-zelda-majora-s-mask'
    }),
    // RecompLauncher still lists the project under its old owner.
    rlApp({
      id: '2ship2harkinian',
      name: '2 Ship 2 Harkinian',
      game: "The Legend of Zelda: Majora's Mask",
      origin: 'n64',
      repo: '2ship2harkinian/2ship2harkinian',
      size: '43 MB',
      stars: 2465,
      downloads: 747269,
      assets: { windows: '2Ship-Battler-Bravo-Win64.zip' },
      tag: '5.0.1',
      released: '2026-08-25',
      boot: {
        start: '2ship.exe',
        files: {
          how: 'folder',
          folder: '.',
          accepts: 'file',
          what: "Your Majora's Mask ROM (.z64, .n64 or .v64): the US N64 version (1.0) or the US GameCube version"
        }
      }
    }),
    rlApp({
      id: 'spaghettikart',
      name: 'SpaghettiKart',
      game: 'Mario Kart 64',
      origin: 'n64',
      repo: 'HarbourMasters/SpaghettiKart',
      released: '2026-02-25',
      size: '7 MB',
      downloads: 251048,
      stars: 2494,
      blurb: 'Mario Kart 64 as a native PC game, with widescreen, high frame rates and mods.',
      author: 'HarbourMasters',
      assets: { windows: 'spaghetti-windows.zip' },
      tags: ['Mods'],
      features: ['Custom asset mods', 'Alternate assets toggle', 'Keyboard and controller'],
      tag: '1.0.0',
      boot: {
        kind: 'portable',
        start: 'Spaghettify.exe',
        files: {
          how: 'folder',
          folder: '.',
          accepts: 'file',
          contains: ['mk64.us.z64'],
          region: 'E',
          n64_id: 'KT',
          what: 'Your Mario Kart 64 N64 ROM, USA'
        },
        player_note: "Pick your USA ROM once; the first start turns it into the game's files."
      },
      title: 'mario-kart-64'
    }),
    // RecompLauncher lists it on GitHub; decomp-buddy found it moved to GitLab.
    rlApp({
      id: 'mariokart64recomp',
      name: 'Mario Kart 64: Recompiled',
      game: 'Mario Kart 64',
      origin: 'n64',
      repo: 'sonicdcer/MarioKart64Recomp',
      released: '2026-02-13',
      size: '23 MB',
      downloads: 30884,
      stars: 633,
      blurb: 'Mario Kart 64 for PC (Windows/Linux/MacOS)',
      author: 'sonicdcer',
      assets: { windows: 'MarioKart64Recompiled-*-Windows-RelWithDebInfo.zip' },
      license: 'GPL-3.0',
      tag: 'v0.9.2',
      title: 'mario-kart-64'
    }),
    // RecompLauncher's duplicate of the same project.
    rlApp({
      id: 'mariokart64recomp-2',
      name: 'Mario Kart 64: Recompiled (copy)',
      game: 'Mario Kart 64',
      origin: 'n64',
      repo: 'sonicdcer/MarioKart64Recomp',
      assets: { windows: 'MarioKart64Recompiled-*-Windows-RelWithDebInfo.zip' },
      tag: 'v0.9.2'
    }),
    rlApp({
      id: 'unleashedrecomp',
      name: 'Unleashed Recompiled',
      game: 'Sonic Unleashed',
      origin: 'x360',
      repo: 'hedge-dev/UnleashedRecomp',
      size: '51 MB',
      stars: 5375,
      downloads: 750824,
      assets: { windows: 'UnleashedRecomp-Windows.zip' },
      tags: ['High FPS', '60 FPS', 'Widescreen', 'Achievements', 'Mods'],
      tag: 'v1.0.3',
      released: '2025-04-03',
      boot: {
        kind: 'portable',
        start: 'UnleashedRecomp.exe',
        files: {
          how: 'self',
          accepts: 'folder or file',
          what: 'Your Sonic Unleashed Xbox 360 game and title update (DLC optional), as files or a folder'
        }
      }
    }),
    rlApp({
      id: 'unleashed-hd-port',
      name: 'Unleashed HD Port',
      game: 'Sonic Unleashed HD',
      origin: 'x360',
      repo: 'example-dev/unleashed-hd-port',
      size: '60 MB',
      stars: 12,
      downloads: 100,
      assets: { windows: 'unleashed-hd-*-win64.zip' },
      tag: 'v0.1.0'
    }),
    rlApp({
      id: 'unleashed-ps3-port',
      name: 'Unleashed PS3 Port',
      game: 'Sonic Unleashed',
      origin: 'ps3',
      repo: 'example-dev/unleashed-ps3-port',
      assets: { windows: 'unleashed-ps3-*-win64.zip' },
      tag: 'v0.2.0'
    }),
    // RecompLauncher only, on GitLab, with an empty size.
    rlApp({
      id: 'engage-pc-recomp',
      name: 'Fire Emblem Engage Recomp',
      game: 'Fire Emblem Engage',
      origin: 'switch',
      repo: 'engage-pc-recomp/engage-pc-recomp',
      host: 'gitlab',
      size: '',
      stars: 24,
      downloads: 0,
      systems: ['windows'],
      assets: { windows: 'Engage-Setup-*-windows.zip' },
      tag: 'engage-v0.1.0-alpha.6',
      released: '2026-11-04'
    }),
    // RecompLauncher only, one download with three games.
    rlApp({
      id: 'athelas',
      name: 'Athelas',
      game: 'The Lord of the Rings: The Fellowship of the Ring / The Two Towers / The Return of the King',
      origin: 'xbox',
      repo: 'Shagg88/Athelas',
      size: '119 MB',
      stars: 204,
      downloads: 13930,
      systems: ['windows'],
      assets: { windows: 'Athelas-*.7z' },
      tag: '1.8.4',
      released: '2026-11-13',
      boot: {
        start: 'Athelas.exe',
        files: {
          how: 'self',
          accepts: 'folder or iso',
          what: 'Xbox LOTR games, US disc ISO or extracted'
        }
      },
      games: [
        {
          id: 'fotr',
          name: 'The Lord of the Rings: The Fellowship of the Ring',
          cover: 'https://recompstore.com/media/pc-athelas-fotr-cover-5f2f91e3.jpg'
        },
        {
          id: 'ttt',
          name: 'The Lord of the Rings: The Two Towers',
          cover: 'https://recompstore.com/media/pc-athelas-ttt-cover-2e1c3e28.jpg'
        },
        {
          id: 'rotk',
          name: 'The Lord of the Rings: The Return of the King',
          cover: 'https://recompstore.com/media/pc-athelas-rotk-cover-d57ab88b.jpg'
        }
      ]
    }),
    // Coming soon / no Windows build: not listed.
    rlApp({
      id: 'gow2-recomp',
      name: 'God of War II Recomp',
      game: 'God of War II',
      origin: 'ps3',
      repo: 'andrebrumdev/gow2-recomp',
      systems: ['macos'],
      assets: { macos: 'gow2-recomp-*-b323750.zip' },
      tag: 'kit-macos-20260930',
      soon: true
    }),
    rlApp({
      id: 'sourceforge-thing',
      name: 'SourceForge project',
      game: 'Something',
      origin: 'pc',
      repo: 'sourceforge:something',
      assets: { windows: 'x.zip' }
    })
  ]
}

const FETCHED = {
  'decomp-buddy': '2026-11-14T10:00:00.000Z',
  recomplauncher: '2026-11-14T10:00:01.000Z'
}

function build(over: { finds?: unknown; plans?: unknown; rl?: unknown } = {}): RecompCatalog {
  return buildCatalog({
    finds: 'finds' in over ? over.finds : FINDS,
    plans: 'plans' in over ? over.plans : PLANS,
    rl: 'rl' in over ? over.rl : RL,
    fetchedAt: FETCHED,
    offline: []
  })
}

function entry(
  c: RecompCatalog,
  id: string
): NonNullable<ReturnType<RecompCatalog['entries']['get']>> {
  const e = c.entries.get(id)
  if (!e) throw new Error(`no entry ${id}; have ${[...c.entries.keys()].join(', ')}`)
  return e
}

describe('buildCatalog: which entries', () => {
  const c = build()

  it('keeps Windows releases from both catalogs and nothing else', () => {
    expect([...c.entries.keys()].sort()).toEqual(
      [
        'github:zelda64recomp/zelda64recomp',
        'github:harbourmasters/2ship2harkinian',
        'github:harbourmasters/spaghettikart',
        'gitlab:sonicdcer/mariokart64recomp',
        'github:hedge-dev/unleashedrecomp',
        'github:twilitrealm/dusklight',
        'github:dogparty/ipodclickwheelrecomps#the-sims-bowling',
        'github:dogparty/ipodclickwheelrecomps#mini-golf',
        'github:open-goal/launcher',
        'github:example-dev/unleashed-hd-port',
        'github:example-dev/unleashed-ps3-port',
        'gitlab:engage-pc-recomp/engage-pc-recomp',
        'github:shagg88/athelas#the-lord-of-the-rings-the-fellowship-of-the-ring',
        'github:shagg88/athelas#the-lord-of-the-rings-the-two-towers',
        'github:shagg88/athelas#the-lord-of-the-rings-the-return-of-the-king'
      ].sort()
    )
  })

  it('skips taken-down, source-only, vanished, coming-soon and unsupported-host projects', () => {
    const ids = [...c.entries.keys()].join(' ')
    expect(ids).not.toContain('hez-gta-re3')
    expect(ids).not.toContain('pokeheartgold')
    expect(ids).not.toContain('opengtps1')
    expect(ids).not.toContain('gow2-recomp')
    expect(ids).not.toContain('something')
  })

  it('indexes entries by repo', () => {
    expect(c.byRepo.get('github:dogparty/ipodclickwheelrecomps')?.sort()).toEqual([
      'github:dogparty/ipodclickwheelrecomps#mini-golf',
      'github:dogparty/ipodclickwheelrecomps#the-sims-bowling'
    ])
    expect(c.byRepo.get('gitlab:sonicdcer/mariokart64recomp')).toEqual([
      'gitlab:sonicdcer/mariokart64recomp'
    ])
  })

  it('passes fetch times and offline sources through', () => {
    const offline = buildCatalog({
      fetchedAt: FETCHED,
      offline: ['recomplauncher', 'recomplauncher']
    })
    expect(offline.fetchedAt).toEqual(FETCHED)
    expect(offline.offline).toEqual(['recomplauncher'])
    expect(offline.entries.size).toBe(0)
  })
})

describe('buildCatalog: merging the two catalogs', () => {
  const c = build()

  it('fills a decomp-buddy entry with RecompLauncher details', () => {
    const z = entry(c, 'github:zelda64recomp/zelda64recomp')
    expect(z).toMatchObject({
      name: 'Zelda 64: Recompiled',
      game: "The Legend of Zelda: Majora's Mask",
      systemId: 'n64',
      console: 'Nintendo 64',
      host: 'github',
      repo: 'Zelda64Recomp/Zelda64Recomp',
      repoUrl: 'https://github.com/Zelda64Recomp/Zelda64Recomp',
      author: 'Zelda64Recomp',
      blurb:
        "Majora's Mask as a native PC game: widescreen, high frame rates, mods and modern controls.",
      features: ['High frame rate support', 'Widescreen and ultrawide'],
      latestTag: 'v1.2.2',
      released: '2025-08-27',
      // exact bytes from the scan beat RecompLauncher's rounded "28 MB"
      downloadBytes: 28940501,
      stars: 7692,
      downloads: 396694,
      license: 'GPL-3.0',
      completeness: null,
      recommended: true,
      assetPattern: 'Zelda64Recompiled-*-Windows.zip',
      exe: 'Zelda64Recompiled.exe',
      installer: false,
      scannedSha256: ZELDA_SHA,
      savePaths: ['%LOCALAPPDATA%\\Zelda64Recompiled\\saves'],
      iconUrl: 'https://recompstore.com/media/pc-zelda64recomp-icon-8be094b6.png',
      archived: false,
      sources: ['decomp-buddy', 'recomplauncher']
    })
    // The checksum names its exact file (the pattern is a wildcard), so installs can apply it.
    expect(z.scannedAsset).toMatch(/^Zelda64Recompiled-.+-Windows\.zip$/)
    // RecompLauncher's own sha256 is for the macOS file: never used for Windows.
    expect(z.scannedSha256).not.toBe(
      'f369815d7ba2a1139a6fab8a0aa51c52e5f064dcfcce649eb888fdef9f648689'
    )
    expect(z.tags.map((t) => t.label)).toEqual([
      'High FPS',
      'Widescreen',
      'Gyro',
      'Mods',
      'HD Textures',
      'Needs your game files'
    ])
    expect(z.tags.find((t) => t.label === 'Gyro')?.kind).toBe('feature')
    expect(z.tags.find((t) => t.label === 'Needs your game files')?.kind).toBe('setup')
  })

  it('takes how a game file is provided from RecompLauncher and the hashes from decomp-buddy', () => {
    const z = entry(c, 'github:zelda64recomp/zelda64recomp')
    expect(z.needs).toEqual([
      {
        id: 'game',
        label: "Majora's Mask US ROM",
        description:
          "Your Majora's Mask ROM: the North American N64 version. Pick it in the game's main menu the first time.",
        kind: 'game',
        how: 'self',
        accepts: 'file',
        formats: ['.z64', '.n64', '.rom'],
        optional: false,
        hashes: [{ algo: 'sha1', value: 'd6133ace5afaa0882cf214cf88daba39e266c078' }],
        region: 'USA'
      }
    ])
  })

  it('places a ROM into the install folder with the name RecompLauncher gives (Easy setup)', () => {
    const s = entry(c, 'github:harbourmasters/spaghettikart')
    expect(s.needs).toHaveLength(1)
    expect(s.needs[0]).toMatchObject({
      id: 'game',
      how: 'folder',
      folder: '.',
      fileName: 'mk64.us.z64',
      region: 'USA',
      formats: ['.z64'],
      hashes: [{ algo: 'sha1', value: '579c48e211ae952530ffc8738709f078d5dd215e' }]
    })
    expect(s.tags.map((t) => t.label)).toEqual(['Mods', 'Needs your game files', 'Easy setup'])
    expect(s.setupNotes[0]).toBe(
      "Pick your USA ROM once; the first start turns it into the game's files."
    )
    // Download / extract steps are PlayOut's job, not the player's.
    expect(s.setupNotes.join(' ')).not.toMatch(/Extract/)
    expect(s.setupNotes).toContain('Only the US version of the ROM is supported')
    expect(s.features).toEqual([
      'Custom asset mods',
      'Alternate assets toggle',
      'Keyboard and controller'
    ])
  })

  it('finds a project RecompLauncher lists under its old owner or host', () => {
    const ship = entry(c, 'github:harbourmasters/2ship2harkinian')
    expect(ship.name).toBe('2 Ship 2 Harkinian')
    expect(ship.stars).toBe(2465)
    expect(ship.repo).toBe('harbourmasters/2ship2harkinian') // decomp-buddy's (current) repo stays
    expect(ship.needs[0]).toMatchObject({ how: 'folder', folder: '.' })

    const mk = entry(c, 'gitlab:sonicdcer/mariokart64recomp')
    expect(mk.host).toBe('gitlab')
    expect(mk.repoUrl).toBe('https://gitlab.com/sonicdcer/mariokart64recomp')
    expect(mk.name).toBe('Mario Kart 64: Recompiled') // not the "-2" duplicate's name
    expect(mk.recommended).toBe(true)
    expect(c.entries.has('github:sonicdcer/mariokart64recomp')).toBe(false)
  })

  it('keeps the update and DLC needs only decomp-buddy describes', () => {
    const u = entry(c, 'github:hedge-dev/unleashedrecomp')
    expect(u.needs.map((n) => [n.id, n.kind, n.how, n.accepts, n.optional])).toEqual([
      ['game', 'game', 'self', 'either', false],
      ['update', 'update', 'self', 'file', false],
      ['dlc', 'dlc', 'self', 'file', true]
    ])
    expect(u.needs[0].formats).toEqual(['.iso', '.gcm'])
    expect(u.needs[1].region).toBeUndefined() // "any"
    expect(u.tags.some((t) => t.label === 'Easy setup')).toBe(false)
  })

  it('reads a decomp-buddy-only entry', () => {
    const d = entry(c, 'github:twilitrealm/dusklight')
    expect(d).toMatchObject({
      name: 'dusklight',
      repo: 'TwilitRealm/dusklight', // the spelling from finds.json
      author: 'TwilitRealm',
      game: 'The Legend of Zelda: Twilight Princess',
      systemId: 'gc',
      console: 'GameCube',
      blurb: 'Twilight Princess decompilation, natively on PC',
      coverUrl: 'https://raw.githubusercontent.com/libretro-thumbnails/tp.png',
      iconUrl: null,
      license: 'Creative Commons Zero v1.0 Universal',
      stars: null,
      released: null,
      downloadBytes: 56037777,
      assetPattern: 'Dusklight-v2.0.3-win32-x86_64.zip',
      sources: ['decomp-buddy']
    })
    expect(d.needs).toEqual([
      expect.objectContaining({
        id: 'game',
        how: 'flag',
        flag: '--dvd',
        accepts: 'file',
        optional: false
      })
    ])
    expect(d.tags.map((t) => t.label)).toEqual(['Needs your game files', 'Easy setup'])
  })

  it('splits a multi-game repo into one entry per game', () => {
    const bowling = entry(c, 'github:dogparty/ipodclickwheelrecomps#the-sims-bowling')
    expect(bowling).toMatchObject({
      game: 'The Sims Bowling',
      systemId: 'other',
      console: 'Apple iPod Classic',
      assetPattern: 'bowling-1.0.1-windows-x64.zip',
      exe: null,
      archived: true
    })
    expect(bowling.needs[0]).toMatchObject({ accepts: 'folder', formats: [], how: 'self' })
    expect(bowling.tags.map((t) => t.label)).toContain('Archived')
    expect(bowling.tags.find((t) => t.label === 'Archived')?.kind).toBe('warning')
    const golf = entry(c, 'github:dogparty/ipodclickwheelrecomps#mini-golf')
    expect(golf.needs).toEqual([])
    expect(golf.tags.map((t) => t.label)).toEqual(['Archived'])
  })

  it('marks installers', () => {
    const jak = entry(c, 'github:open-goal/launcher')
    expect(jak.installer).toBe(true)
    expect(jak.exe).toBe('OpenGOAL Launcher.exe')
    expect(jak.tags).toContainEqual({ label: 'Installer', kind: 'setup' })
    expect(jak.scannedSha256).toBeNull()
  })

  it('adds the completeness as a status tag', () => {
    const mk = entry(c, 'gitlab:sonicdcer/mariokart64recomp')
    expect(mk.completeness).toBe('playable')
    expect(mk.tags[0]).toEqual({ label: 'Playable', kind: 'status' })
  })

  it('adds projects only RecompLauncher lists', () => {
    const fe = entry(c, 'gitlab:engage-pc-recomp/engage-pc-recomp')
    expect(fe).toMatchObject({
      name: 'Fire Emblem Engage Recomp',
      game: 'Fire Emblem Engage',
      systemId: 'switch',
      host: 'gitlab',
      repoUrl: 'https://gitlab.com/engage-pc-recomp/engage-pc-recomp',
      latestTag: 'engage-v0.1.0-alpha.6',
      released: '2026-11-04',
      downloadBytes: null,
      scannedSha256: null,
      needs: [],
      sources: ['recomplauncher']
    })
  })

  it('splits a RecompLauncher collection into its games, sharing the one download', () => {
    const ids = [...c.entries.keys()].filter((id) => id.startsWith('github:shagg88/athelas#'))
    expect(ids).toHaveLength(3)
    const ttt = entry(c, 'github:shagg88/athelas#the-lord-of-the-rings-the-two-towers')
    expect(ttt).toMatchObject({
      name: 'Athelas',
      game: 'The Lord of the Rings: The Two Towers',
      systemId: 'xbox',
      assetPattern: 'Athelas-*.7z',
      exe: 'Athelas.exe',
      coverUrl: 'https://recompstore.com/media/pc-athelas-ttt-cover-2e1c3e28.jpg',
      downloadBytes: 119 * 1024 * 1024
    })
    expect(ttt.needs[0]).toMatchObject({ how: 'self', accepts: 'either', formats: ['.iso'] })
  })
})

describe('buildCatalog: releases and checksums', () => {
  function withSpaghetti(patch: Record<string, unknown>): RecompCatalog {
    const rl = structuredClone(RL)
    const app = rl.apps.find((a) => a.id === 'spaghettikart') as Record<string, unknown>
    Object.assign(app, patch)
    return build({ rl })
  }

  it('offers the newer of the two catalogs’ releases, without the older scan', () => {
    const c = withSpaghetti({ tag: '1.1.0', released: '2026-10-01', size: '8 MB' })
    const s = entry(c, 'github:harbourmasters/spaghettikart')
    expect(s.latestTag).toBe('1.1.0')
    expect(s.released).toBe('2026-10-01')
    expect(s.scannedSha256).toBeNull()
    expect(s.downloadBytes).toBe(8 * 1024 * 1024)
  })

  it("uses RecompLauncher's Windows scan for its newer release when the file fits the pattern", () => {
    const sha = 'aa'.repeat(32)
    const fits = withSpaghetti({
      tag: '1.1.0',
      files: { windows: { name: 'spaghetti-windows.zip', sha256: sha, scan: 'green' } }
    })
    expect(entry(fits, 'github:harbourmasters/spaghettikart').scannedSha256).toBe(sha)
    expect(entry(fits, 'github:harbourmasters/spaghettikart').scannedAsset).toBe(
      'spaghetti-windows.zip'
    )
    const other = withSpaghetti({
      tag: '1.1.0',
      files: { windows: { name: 'spaghetti-linux.zip', sha256: sha, scan: 'green' } }
    })
    expect(entry(other, 'github:harbourmasters/spaghettikart').scannedSha256).toBeNull()
  })

  it("passes over RecompLauncher's Windows file when it is the game's server, with its scan and size", () => {
    const plain = entry(withSpaghetti({}), 'github:harbourmasters/spaghettikart')
    const s = entry(
      withSpaghetti({
        size: '15 MB',
        assets: { windows: 'Spaghetti-server-windows-x64.zip' },
        files: {
          windows: {
            name: 'Spaghetti-server-windows-x64.zip',
            sha256: 'bb'.repeat(32),
            scan: 'green'
          }
        }
      }),
      'github:harbourmasters/spaghettikart'
    )
    expect(plain.assetPattern).toBeTruthy()
    expect(s.assetPattern).toBe(plain.assetPattern)
    expect(s.scannedSha256).toBe(plain.scannedSha256)
    expect(s.scannedAsset).toBe(plain.scannedAsset)
    expect(s.downloadBytes).toBe(plain.downloadBytes)
    expect(s.downloadBytes).not.toBe(15 * 1024 * 1024)
    // Nor its newer release (of the side piece) or the program it starts.
    const tagged = entry(
      withSpaghetti({
        tag: 'sdk-v9.0.0',
        assets: { windows: 'spaghetti-mod-sdk-*.zip' },
        boot: { start: 'sdk-tool.exe' }
      }),
      'github:harbourmasters/spaghettikart'
    )
    expect(tagged.latestTag).toBe(plain.latestTag)
    expect(tagged.exe).not.toBe('sdk-tool.exe')
  })

  it("keeps decomp-buddy's release when RecompLauncher's is older", () => {
    const s = entry(withSpaghetti({ tag: '0.9.0' }), 'github:harbourmasters/spaghettikart')
    expect(s.latestTag).toBe('1.0.0')
    expect(s.scannedSha256).toBe(SPAGHETTI_SHA)
    expect(s.released).toBeNull()
  })

  it("drops the scan when the catalog's asset pattern no longer fits the scanned file", () => {
    const s = entry(
      withSpaghetti({ assets: { windows: 'SpaghettiKart-*-win64.zip' } }),
      'github:harbourmasters/spaghettikart'
    )
    expect(s.latestTag).toBe('1.0.0')
    expect(s.assetPattern).toBe('SpaghettiKart-*-win64.zip')
    expect(s.scannedSha256).toBeNull()
  })

  it('uses a newer release decomp-buddy saw when the scanned file is gone', () => {
    type GamePlan = { build: Record<string, unknown> }
    type Plan = { targets: { windows: { games: GamePlan[] } } }
    const plans = structuredClone(PLANS) as unknown as { plans: Record<string, Plan> }
    const build0 = plans.plans['github:gtteancum/opengtps1'].targets.windows.games[0].build
    build0.next = { release_tag: 'v0.9c', release_asset: 'OpenGTPS1-0.9c-win-x64.zip' }
    const gt = entry(build({ plans }), 'github:gtteancum/opengtps1')
    expect(gt).toMatchObject({
      latestTag: 'v0.9c',
      assetPattern: 'OpenGTPS1-0.9c-win-x64.zip',
      scannedSha256: null,
      systemId: 'psx'
    })
  })
})

describe('buildCatalog: titles', () => {
  const c = build()

  it('groups the versions of one game, recommended first, then by stars', () => {
    expect(c.titles.get('n64:mariokart64')).toEqual({
      key: 'n64:mariokart64',
      game: 'Mario Kart 64',
      systemId: 'n64',
      console: 'Nintendo 64',
      entries: ['gitlab:sonicdcer/mariokart64recomp', 'github:harbourmasters/spaghettikart']
    })
    expect(c.titles.get('n64:legendofzeldamajorasmask')?.entries).toEqual([
      'github:zelda64recomp/zelda64recomp',
      'github:harbourmasters/2ship2harkinian'
    ])
    expect(entry(c, 'github:harbourmasters/spaghettikart').recommended).toBe(false)
  })

  it("joins RecompLauncher's groupings across differing names, but not across consoles", () => {
    const t = c.titles.get('xbox360:sonicunleashed')
    expect(t?.game).toBe('Sonic Unleashed')
    expect(t?.entries).toEqual([
      'github:hedge-dev/unleashedrecomp',
      'github:example-dev/unleashed-hd-port'
    ])
    expect(c.titles.has('xbox360:sonicunleashedhd')).toBe(false)
    expect(c.titles.get('ps3:sonicunleashed')?.entries).toEqual([
      'github:example-dev/unleashed-ps3-port'
    ])
  })

  it('gives every entry exactly one title', () => {
    const seen = [...c.titles.values()].flatMap((t) => t.entries)
    expect(seen.sort()).toEqual([...c.entries.keys()].sort())
  })

  it('keeps at most one recommended version per title', () => {
    for (const t of c.titles.values()) {
      expect(t.entries.filter((id) => entry(c, id).recommended).length).toBeLessThanOrEqual(1)
    }
  })

  it('orders by downloads, then name, when stars tie', () => {
    const plans = {
      plans: {
        'github:a/zeta': plan({
          game_title: 'Doom',
          console: 'PC (MS-DOS)',
          build: { method: 'release', release_asset: 'z.zip', release_tag: 'v1' }
        }),
        'github:b/alpha': plan({
          game_title: 'DOOM',
          console: 'MS-DOS',
          build: { method: 'release', release_asset: 'a.zip', release_tag: 'v1' }
        })
      }
    }
    const t = build({ plans, rl: null, finds: null }).titles.get('pc:doom')
    expect(t?.entries).toEqual(['github:b/alpha', 'github:a/zeta'])
  })
})

describe('buildCatalog: bad input', () => {
  it('survives missing, malformed and hostile documents', () => {
    expect(() => build({ finds: 'x', plans: 42, rl: [] })).not.toThrow()
    expect(build({ finds: null, plans: null, rl: null }).entries.size).toBe(0)
    const c = build({
      finds: { games: [null, 5, { repo: '../../x' }] },
      plans: {
        plans: {
          'github:ok/repo': plan({
            game_title: 'Okay Game',
            console: 'Nintendo 64',
            build: {
              method: 'release',
              release_asset: 'ok.zip',
              release_tag: 'v1',
              executable: '../../Windows/System32/cmd.exe',
              scanned: { sha256: 'not-a-hash', size: -5 }
            },
            game_files: [
              null,
              {
                label: 'ROM',
                how_provided: 'folder',
                drop_into: '../../outside',
                kind: 'weird',
                accepted_formats: ['z64', '.N64', 'this is prose'],
                expected_hashes: [
                  { algo: 'sha1', value: 'nothex' },
                  { algo: 'md5', value: 'D41D8CD98F00B204E9800998ECF8427E' },
                  { algo: 'md4', value: 'abcd' }
                ]
              }
            ]
          }),
          'github:bad': plan({
            game_title: 'x',
            build: { method: 'release', release_asset: 'a', release_tag: 'b' }
          }),
          'ftp:host/x': plan({
            game_title: 'x',
            build: { method: 'release', release_asset: 'a', release_tag: 'b' }
          }),
          'github:no/plan': null,
          'github:no/targets': { targets: 5 }
        }
      },
      rl: {
        apps: [null, 5, {}, { id: 'x' }, { id: 'y', repo: 42 }, { id: 'z', repo: 'a/b/c/d' }],
        titles: [null, { pick: 7, pc: 'x' }, { pick: 'pc:nope', pc: ['nope'] }]
      }
    })
    expect([...c.entries.keys()]).toEqual(['github:ok/repo'])
    const e = entry(c, 'github:ok/repo')
    expect(e.exe).toBeNull()
    expect(e.scannedSha256).toBeNull()
    expect(e.downloadBytes).toBeNull()
    expect(e.needs).toEqual([
      {
        id: 'other',
        label: 'ROM',
        description: 'ROM',
        kind: 'other',
        how: 'self',
        accepts: 'file',
        formats: ['.z64', '.n64'],
        optional: false,
        hashes: [{ algo: 'md5', value: 'd41d8cd98f00b204e9800998ecf8427e' }]
      }
    ])
  })
})

describe('helpers', () => {
  it('parses RecompLauncher sizes', () => {
    expect(parseSize('28 MB')).toBe(28 * 1024 * 1024)
    expect(parseSize('1.5 GB')).toBe(Math.round(1.5 * 1024 ** 3))
    expect(parseSize('900 KB')).toBe(900 * 1024)
    expect(parseSize('12 bytes')).toBe(12)
    expect(parseSize(1234)).toBe(1234)
    expect(parseSize('')).toBeNull()
    expect(parseSize('big')).toBeNull()
    expect(parseSize(undefined)).toBeNull()
  })

  it('slugs game titles', () => {
    expect(slugOf('Pokémon SoulSilver')).toBe('pokemon-soulsilver')
    expect(slugOf("Texas Hold'em")).toBe('texas-hold-em')
    expect(slugOf('Split/Second')).toBe('split-second')
    expect(slugOf('!!!')).toBe('')
  })
})

describe('loadCatalog', () => {
  const log: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  let dir: string | null = null
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = null
  })

  type Route = { status: number; body: string } | Error
  function fakeFetch(routes: Record<string, Route>, calls: string[] = []): typeof fetch {
    return (async (input: string | URL | Request) => {
      const url = String(input)
      calls.push(url)
      const r = routes[url]
      if (!r) throw new Error(`unexpected ${url}`)
      if (r instanceof Error) throw r
      return new Response(r.status === 304 ? null : r.body, { status: r.status })
    }) as typeof fetch
  }

  const OK: Record<string, Route> = {
    [FINDS_URL]: { status: 200, body: JSON.stringify(FINDS) },
    [PLANS_URL]: { status: 200, body: JSON.stringify(PLANS) },
    [RL_CATALOG_URL]: { status: 200, body: JSON.stringify(RL) }
  }

  it('fetches the three documents and builds the catalog', async () => {
    dir = await mkdtemp(join(tmpdir(), 'recomp-catalog-'))
    const now = Date.parse('2026-11-14T10:00:00Z')
    const c = await loadCatalog({ dir, log, fetch: fakeFetch(OK), now: () => now })
    expect(c.entries.size).toBe(build().entries.size)
    expect(c.offline).toEqual([])
    expect(c.fetchedAt).toEqual({
      'decomp-buddy': '2026-11-14T10:00:00.000Z',
      recomplauncher: '2026-11-14T10:00:00.000Z'
    })
  })

  it('uses the day-old cache without asking, and revalidates when forced', async () => {
    dir = await mkdtemp(join(tmpdir(), 'recomp-catalog-'))
    await loadCatalog({ dir, log, fetch: fakeFetch(OK) })
    const calls: string[] = []
    const cached = await loadCatalog({ dir, log, fetch: fakeFetch(OK, calls) })
    expect(calls).toEqual([])
    expect(cached.entries.size).toBeGreaterThan(0)
    const forced = await loadCatalog({ dir, log, fetch: fakeFetch(OK, calls), force: true })
    expect(calls.sort()).toEqual([FINDS_URL, PLANS_URL, RL_CATALOG_URL].sort())
    expect(forced.entries.size).toBe(cached.entries.size)
  })

  it('leaves out a source that cannot be reached and names it', async () => {
    dir = await mkdtemp(join(tmpdir(), 'recomp-catalog-'))
    const c = await loadCatalog({
      dir,
      log,
      fetch: fakeFetch({ ...OK, [RL_CATALOG_URL]: new Error('getaddrinfo ENOTFOUND') })
    })
    expect(c.offline).toEqual(['recomplauncher'])
    expect(c.fetchedAt.recomplauncher).toBeNull()
    expect(entry(c, 'github:zelda64recomp/zelda64recomp').sources).toEqual(['decomp-buddy'])
    expect(c.entries.has('gitlab:engage-pc-recomp/engage-pc-recomp')).toBe(false)
  })

  it('uses a stale cached copy when the host is down, and says so', async () => {
    dir = await mkdtemp(join(tmpdir(), 'recomp-catalog-'))
    const t0 = Date.parse('2026-11-10T00:00:00Z')
    await loadCatalog({ dir, log, fetch: fakeFetch(OK), now: () => t0 })
    const later = t0 + 3 * 24 * 60 * 60 * 1000
    const down = { status: 503, body: 'down' }
    const c = await loadCatalog({
      dir,
      log,
      now: () => later,
      fetch: fakeFetch({ [FINDS_URL]: down, [PLANS_URL]: down, [RL_CATALOG_URL]: down })
    })
    expect(c.offline.sort()).toEqual(['decomp-buddy', 'recomplauncher'])
    expect(c.entries.size).toBe(build().entries.size)
    expect(c.fetchedAt['decomp-buddy']).toBe(new Date(t0).toISOString())
  })

  it('never lets a 404 or a non-JSON answer replace the catalog for a day', async () => {
    dir = await mkdtemp(join(tmpdir(), 'recomp-catalog-'))
    const t0 = Date.parse('2026-11-10T00:00:00Z')
    await loadCatalog({ dir, log, fetch: fakeFetch(OK), now: () => t0 })
    const later = t0 + 2 * 24 * 60 * 60 * 1000
    const c = await loadCatalog({
      dir,
      log,
      now: () => later,
      fetch: fakeFetch({
        [FINDS_URL]: { status: 404, body: 'not found' },
        [PLANS_URL]: { status: 200, body: '<html>Sign in to the Wi-Fi</html>' },
        [RL_CATALOG_URL]: { status: 200, body: JSON.stringify(RL) }
      })
    })
    // finds.json: the 404 fell back to the cached copy; plans.json: the portal page is rejected.
    expect(c.offline).toEqual(['decomp-buddy'])
    expect(c.entries.has('github:twilitrealm/dusklight')).toBe(false)
    expect(entry(c, 'github:shagg88/athelas#the-lord-of-the-rings-the-two-towers')).toBeTruthy()
    // The rejected copy's metadata is gone, so the next load asks again (rather than trusting it for a day).
    const calls: string[] = []
    await loadCatalog({ dir, log, now: () => later + 1000, fetch: fakeFetch(OK, calls) })
    expect(calls.sort()).toEqual([FINDS_URL, PLANS_URL].sort()) // finds.json's copy is stale too
    const files = await readdir(dir)
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false)
  })

  it('reports everything offline (and builds nothing) with no network and no cache', async () => {
    dir = await mkdtemp(join(tmpdir(), 'recomp-catalog-'))
    const err = new Error('offline')
    const c = await loadCatalog({
      dir,
      log,
      fetch: fakeFetch({ [FINDS_URL]: err, [PLANS_URL]: err, [RL_CATALOG_URL]: err })
    })
    expect(c.entries.size).toBe(0)
    expect(c.offline.sort()).toEqual(['decomp-buddy', 'recomplauncher'])
    expect(c.fetchedAt).toEqual({ 'decomp-buddy': null, recomplauncher: null })
  })
})

describe('buildCatalog: systems, tags and files across the two catalogs', () => {
  const winPlan = (
    game: string,
    console: string,
    asset = 'game-win64.zip',
    tag = 'v1.0',
    extra: Record<string, unknown> = {}
  ): unknown =>
    plan({
      game_title: game,
      console,
      build: { method: 'release', release_asset: asset, release_tag: tag, ...extra },
      game_files: [],
      first_run: [],
      notes: []
    })
  const rlOnly = (app: Record<string, unknown>): unknown =>
    rlApp({ assets: { windows: '*-win64.zip' }, tag: 'v1.0', ...app })

  it('makes one PC title of the DOS and Windows ports of a game', () => {
    const c = build({
      finds: null,
      plans: { plans: { 'github:a/chocolate-doom': winPlan('Doom', 'IBM PC (MS-DOS)') } },
      rl: {
        apps: [
          rlOnly({ id: 'gzdoom', name: 'GZDoom', game: 'DOOM', origin: 'pc', repo: 'b/gzdoom' }),
          // RecompLauncher says 'pc' where decomp-buddy says MS-DOS: decomp-buddy's exact system is kept.
          rlOnly({
            id: 'choc',
            name: 'Chocolate',
            game: 'Doom',
            origin: 'pc',
            repo: 'a/chocolate-doom'
          })
        ]
      }
    })
    expect(entry(c, 'github:a/chocolate-doom').systemId).toBe('dos')
    expect(entry(c, 'github:b/gzdoom').systemId).toBe('pc')
    const t = c.titles.get('pc:doom')
    expect(t?.entries.slice().sort()).toEqual(['github:a/chocolate-doom', 'github:b/gzdoom'])
    expect(t).toMatchObject({ systemId: 'pc', console: 'PC' })
    expect(c.titles.has('dos:doom')).toBe(false)
  })

  it("keeps decomp-buddy's arcade board over RecompLauncher's plain 'arcade'", () => {
    const c = build({
      finds: null,
      plans: {
        plans: {
          'github:a/spikeout-recomp': winPlan('SpikeOut: Final Edition', 'Sega Model 3 (arcade)'),
          'github:a/kof98recomp': winPlan("The King of Fighters '98", 'Neo Geo AES/MVS')
        }
      },
      rl: {
        apps: [
          rlOnly({
            id: 'spikeout',
            game: 'SpikeOut: Final Edition',
            origin: 'arcade',
            repo: 'a/spikeout-recomp'
          }),
          rlOnly({
            id: 'kof98',
            game: "The King of Fighters '98",
            origin: 'arcade',
            repo: 'a/kof98recomp'
          }),
          rlOnly({
            id: 'kof98-mame',
            game: "The King of Fighters '98",
            origin: 'arcade',
            repo: 'b/kof98'
          })
        ]
      }
    })
    expect(entry(c, 'github:a/spikeout-recomp').systemId).toBe('model3')
    expect(entry(c, 'github:a/kof98recomp').systemId).toBe('neogeo')
    // Every board is one arcade title, as a library game in any arcade folder sees it.
    expect(c.titles.get('arcade:kingoffighters98')?.entries.slice().sort()).toEqual([
      'github:a/kof98recomp',
      'github:b/kof98'
    ])
    expect(c.titles.get('arcade:spikeoutfinaledition')?.systemId).toBe('model3')
  })

  it("offers only RecompLauncher tags with a Windows build, never a collection's for one game", () => {
    const sha = 'cd'.repeat(32)
    const game = (title: string, asset: string): Record<string, unknown> => ({
      game_title: title,
      console: 'Xbox 360',
      build: {
        method: 'release',
        release_asset: asset,
        release_tag: 'v1.0',
        scanned: { sha256: sha, size: 10 }
      }
    })
    const c = build({
      finds: null,
      plans: {
        plans: {
          'github:a/alttp-recomp': winPlan(
            'A Link to the Past',
            'SNES',
            'alttp-0.1-win64.zip',
            'v0.1',
            {
              scanned: { sha256: sha, size: 10 }
            }
          ),
          'github:a/coll': {
            tag: 'v1.0',
            targets: {
              windows: {
                games: [game('Game One', 'one-win64.zip'), game('Game Two', 'two-win64.zip')]
              }
            },
            facts: { health: {} },
            trust: {}
          }
        }
      },
      rl: {
        apps: [
          rlApp({
            id: 'alttp',
            game: 'A Link to the Past',
            origin: 'snes',
            repo: 'a/alttp-recomp',
            systems: ['linux'],
            assets: { linux: 'alttp-*-linux.zip' },
            tag: 'v0.12',
            released: '2026-10-01'
          }),
          rlOnly({
            id: 'coll',
            game: 'Game One',
            origin: 'x360',
            repo: 'a/coll',
            tag: 'two-v3',
            released: '2026-10-01',
            games: [{ name: 'Game One' }, { name: 'Game Two' }]
          })
        ]
      }
    })
    expect(entry(c, 'github:a/alttp-recomp')).toMatchObject({
      latestTag: 'v0.1',
      scannedSha256: sha,
      released: null
    })
    expect(entry(c, 'github:a/coll#game-one')).toMatchObject({
      latestTag: 'v1.0',
      scannedSha256: sha,
      released: null
    })
  })

  it('leaves out Android, Linux and ARM builds filed as Windows ones', () => {
    const c = build({
      finds: null,
      plans: {
        plans: {
          'github:a/driftdroid': winPlan('Mario Kart Wii', 'Nintendo Wii', 'DriftDroid-v1.4.0.apk'),
          'github:a/wolfrpg': winPlan('Wolfenstein RPG', 'PC', 'WolfensteinRPG-x86_64.AppImage'),
          'github:a/fine': winPlan('Fine Game', 'Nintendo Wii', 'Fine-v1.0-universal.zip')
        }
      },
      rl: {
        apps: [
          rlOnly({
            id: 'infamous2',
            game: 'inFAMOUS 2',
            origin: 'ps3',
            repo: 'a/infamous2-recomp',
            assets: { windows: 'infamous2-recomp_*_aarch64.app.zip' }
          })
        ]
      }
    })
    expect([...c.entries.keys()]).toEqual(['github:a/fine'])
  })

  it('takes an extracted disc folder, its files placed straight into the folder named', () => {
    const c = build({
      finds: null,
      plans: null,
      rl: {
        apps: [
          rlOnly({
            id: 'skate3',
            game: 'Skate 3',
            origin: 'x360',
            repo: 'a/skate3recomp',
            boot: {
              files: {
                how: 'folder',
                folder: 'game',
                accepts: 'folder or iso',
                extract: 'xdvdfs',
                contains: ['default.xex']
              }
            }
          }),
          rlOnly({
            id: 'sotn',
            game: 'Castlevania: Symphony of the Night',
            origin: 'ps1',
            repo: 'a/symphonyrecomp',
            boot: {
              files: {
                how: 'folder',
                folder: 'disc',
                accepts: 'folder',
                contains: ['SOTN (USA).cue']
              }
            }
          }),
          rlOnly({
            id: 'plain',
            game: 'Plain',
            origin: 'n64',
            repo: 'a/plain',
            boot: { files: { how: 'folder', folder: 'roms', accepts: 'folder' } }
          })
        ]
      }
    })
    const skate = entry(c, 'github:a/skate3recomp').needs[0]!
    expect(skate).toMatchObject({
      how: 'folder',
      folder: 'game',
      accepts: 'folder',
      formats: [],
      intoFolder: true
    })
    expect(skate.description).toMatch(/extract a disc image first \(with xdvdfs\)/)
    expect(entry(c, 'github:a/symphonyrecomp').needs[0]).toMatchObject({
      accepts: 'folder',
      folder: 'disc',
      intoFolder: true
    })
    expect(entry(c, 'github:a/plain').needs[0]!.intoFolder).toBeUndefined()
  })

  it('names titles without console notes, keeps years and demos apart, joins "Version" spellings', () => {
    const c = build({
      finds: null,
      plans: {
        plans: {
          'github:a/goemon': winPlan('Castlevania (Nintendo 64)', 'Nintendo 64'),
          'github:a/plat1': winPlan('Pokemon Platinum', 'Nintendo DS'),
          'github:a/plat2': winPlan('Pokémon Platinum Version', 'Nintendo DS'),
          'github:a/prey2006': winPlan('Prey (2006)', 'PC (Windows)'),
          'github:a/prey': winPlan('Prey', 'PC (Windows)'),
          'github:a/popdemo': winPlan(
            'Prince of Persia: The Sands of Time (E3 2003 Xbox demo)',
            'Xbox'
          ),
          'github:a/pop': winPlan('Prince of Persia: The Sands of Time', 'Xbox'),
          'github:a/goldeneye': winPlan('GoldenEye 007', 'Xbox 360')
        }
      },
      rl: {
        titles: [{ id: 'ge', name: 'GoldenEye 007 (XBLA)', pick: 'pc:ge', pc: ['ge'] }],
        apps: [rlOnly({ id: 'ge', game: 'GoldenEye 007', origin: 'x360', repo: 'a/goldeneye' })]
      }
    })
    expect(c.titles.get('n64:castlevania')?.game).toBe('Castlevania')
    expect(c.titles.get('xbox360:goldeneye007')?.game).toBe('GoldenEye 007')
    expect(c.titles.get('nds:pokemonplatinum')?.entries.slice().sort()).toEqual([
      'github:a/plat1',
      'github:a/plat2'
    ])
    expect(c.titles.get('pc:prey2006')?.entries).toEqual(['github:a/prey2006'])
    expect(c.titles.get('pc:prey')?.entries).toEqual(['github:a/prey'])
    expect(c.titles.get('xbox:princeofpersiathesandsoftime')?.entries).toEqual(['github:a/pop'])
  })
})

describe('catalog dates (the browser sorts)', () => {
  it('reads list dates, dropping placeholders and junk', () => {
    expect(listDate('2026-10-26')).toBe('2026-10-26T00:00:00.000Z')
    expect(listDate('2026-11-13T09:05:51Z')).toBe('2026-11-13T09:05:51.000Z')
    expect(listDate('2020-01-01T00:00:00Z')).toBeNull()
    expect(listDate('soon')).toBeNull()
    expect(listDate(null)).toBeNull()
  })

  it('takes the earliest "added" and the latest "updated" of the two catalogs', () => {
    const finds = {
      ...FINDS,
      games: FINDS.games.map((g) => ({
        ...g,
        addedAt: '2026-10-29T22:10:09.499Z',
        updatedAt: '2026-10-29T20:11:10Z'
      }))
    }
    const d = entry(build({ finds }), 'github:twilitrealm/dusklight')
    expect(d.addedAt).toBe('2026-10-29T22:10:09.499Z')
    expect(d.updatedAt).toBe('2026-10-29T20:11:10.000Z')
    const rl = {
      ...RL,
      apps: RL.apps.map((a) =>
        a.id === 'zelda64recomp' ? { ...a, added: '2020-01-01T00:00:00Z' } : a
      )
    }
    const z = entry(build({ rl }), 'github:zelda64recomp/zelda64recomp')
    expect(z.addedAt).toBeNull()
    expect(z.updatedAt).toBe('2025-08-27T00:00:00.000Z')
  })
})

describe("another region's name for the game (RecompLauncher's game record)", () => {
  // Excerpt of the real pc-catalog.json (November 2026): the Xbox recompilation is listed under the European name,
  // its game record (`about`, from IGDB) under the American one.
  const hpApp = (over: Record<string, unknown> = {}): Record<string, unknown> =>
    rlApp({
      id: 'hp-ps-xbox-recomp',
      name: "Harry Potter and the Philosopher's Stone (Xbox Recomp)",
      game: "Harry Potter and the Philosopher's Stone",
      origin: 'xbox',
      repo: 'MiddleDucky/HP-PS-Xbox-Recomp',
      version: '0.5.2',
      assets: { windows: 'hp-ps-*-windows.zip' },
      about: {
        igdb: 117003,
        name: "Harry Potter and the Sorcerer's Stone",
        platforms: ['Xbox', 'Nintendo GameCube', 'PlayStation 2']
      },
      ...over
    })
  const only = (app: Record<string, unknown>): RecompCatalog =>
    build({ finds: undefined, plans: undefined, rl: { apps: [app], titles: [] } })
  const hpId = 'github:middleducky/hp-ps-xbox-recomp'
  const hpKey = 'xbox:harrypotterandthephilosophersstone'

  it('keeps the other name on the entry and its title', () => {
    const c = only(hpApp())
    expect(entry(c, hpId).game).toBe("Harry Potter and the Philosopher's Stone")
    expect(entry(c, hpId).otherNames).toEqual(["Harry Potter and the Sorcerer's Stone"])
    expect(c.titles.get(hpKey)?.aliases).toEqual(["Harry Potter and the Sorcerer's Stone"])
  })

  it('has none when the record names the game the same way, or names no game', () => {
    const same = only(
      hpApp({ about: { name: "Harry Potter and the Philosopher's Stone", platforms: ['Xbox'] } })
    )
    expect(entry(same, hpId).otherNames).toBeUndefined()
    expect(same.titles.get(hpKey)?.aliases).toBeUndefined()
    expect(entry(only(hpApp({ about: undefined })), hpId).otherNames).toBeUndefined()
  })

  it("ignores a record that is not of a game on the entry's console", () => {
    // Real: "Pokemon Scarlet and Violet" (Switch) carries the record of "Tera" (PlayStation 4, PC, Xbox One).
    const c = only(hpApp({ about: { name: 'Tera', platforms: ['PlayStation 4', 'Xbox One'] } }))
    expect(entry(c, hpId).otherNames).toBeUndefined()
    expect(entry(only(hpApp({ about: { name: 'Tera' } })), hpId).otherNames).toBeUndefined()
  })

  it('ignores the record of an app RecompLauncher does not place on that console, and of a multi-game app', () => {
    // Real: "Sonic 1 Forever" (origin 'other', a mod of the 2013 port) carries the record of the Genesis game.
    expect(entry(only(hpApp({ origin: 'other' })), hpId).otherNames).toBeUndefined()
    // Real shape: one app of several games (its record is of only one of them).
    const multi = only(
      hpApp({
        games: [
          { name: "Harry Potter and the Philosopher's Stone" },
          { name: 'Harry Potter and the Chamber of Secrets' }
        ]
      })
    )
    for (const e of multi.entries.values()) expect(e.otherNames).toBeUndefined()
    for (const title of multi.titles.values()) expect(title.aliases).toBeUndefined()
  })

  it('never takes one for a PC original', () => {
    // Real: "Prey (2006)" carries the record "Prey", which on PC is another game.
    const c = only(
      rlApp({
        id: 'prey-2006',
        name: 'Prey 2006 port',
        game: 'Prey (2006)',
        origin: 'pc',
        repo: 'someone/prey2006',
        assets: { windows: 'prey-*.zip' },
        about: { name: 'Prey', platforms: ['PC (Microsoft Windows)'] }
      })
    )
    expect(entry(c, 'github:someone/prey2006').otherNames).toBeUndefined()
  })
})

describe('buildCatalog: Xbox 360 user data (achievements)', () => {
  const x360 = (app: Record<string, unknown>): Record<string, unknown> =>
    rlApp({
      origin: 'x360',
      size: '50 MB',
      assets: { windows: 'game-*-windows.zip' },
      tag: 'v1.0.0',
      released: '2026-10-01',
      ...app
    })
  const c = build({
    finds: { games: [] },
    plans: {},
    rl: {
      catalogVersion: 1,
      platform: 'pc',
      apps: [
        x360({
          id: 'both-recomp',
          name: 'Both Recomp',
          game: 'Game One',
          repo: 'dev/both-recomp',
          title_id: '4d5307e6',
          achievements_folder: '{game}\\userdata'
        }),
        x360({
          id: 'older-recomp',
          name: 'Older Recomp',
          game: 'Game Two',
          repo: 'dev/older-recomp',
          achievements: { title_id: '0x545107E0', folder: '%LOCALAPPDATA%\\GameTwo\\user' }
        }),
        x360({ id: 'plain-recomp', name: 'Plain', game: 'Game Three', repo: 'dev/plain-recomp' }),
        x360({
          id: 'bad-recomp',
          name: 'Bad',
          game: 'Game Four',
          repo: 'dev/bad-recomp',
          title_id: 'not-hex!',
          achievements_folder: 'line one\nline two'
        }),
        x360({
          id: 'collection',
          name: 'Collection',
          repo: 'dev/collection',
          title_id: '11112222',
          games: [{ name: 'Part One' }, { name: 'Part Two' }]
        })
      ]
    }
  })

  it("carries the catalog's title id and user data folder onto the entry", () => {
    expect(entry(c, 'github:dev/both-recomp').rl).toEqual({
      id: 'both-recomp',
      titleId: '4D5307E6',
      achievementsFolder: '{game}\\userdata'
    })
    expect(entry(c, 'github:dev/older-recomp').rl).toEqual({
      id: 'older-recomp',
      titleId: '545107E0',
      achievementsFolder: '%LOCALAPPDATA%\\GameTwo\\user'
    })
  })

  it('leaves them out when the catalog has none, or none that is usable, and for a game of a collection', () => {
    expect(entry(c, 'github:dev/plain-recomp').rl).toBeUndefined()
    expect(entry(c, 'github:dev/bad-recomp').rl).toBeUndefined()
    const parts = [...c.entries.values()].filter((e) => e.repo === 'dev/collection')
    expect(parts).toHaveLength(2)
    expect(parts.every((e) => e.rl === undefined)).toBe(true)
  })
})
