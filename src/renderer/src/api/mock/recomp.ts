// Recompilations in the mock (src/main/recomp/): a small catalog matched to two sample ROM games. Doom 64 (N64) has
// two source ports, Doom64EX+ (recommended, installed, one release behind) and Doom64EX; Sonic the Hedgehog 2
// (Genesis) has the RSDKv4 decompilation, a game inside a multi-game repo that needs the player's Data.rsdk before it
// starts. Installs walk through the real phases with 'recomp:progress'; every change emits 'recomp:changed' and
// rewrites the games' metadata.recomp (so the UP button follows), like the real service.
// Saves are copied to <Emulation folder>/Recompilations Saves/<name>; Doom64EX+ also has a suggested save folder (as
// "Find automatically" leaves one) so the Add button shows.
// `recomp=pinned` starts Doom64EX+ pinned to its older release (Pinned to v4.0.0.3, Back to latest) on both screens.
// `recomp=conflict` starts Doom64EX+'s save copy in a conflict, so the banner and its two buttons can be checked.
// Doom64EX+'s releases (Change version in Settings › Recompilations and on its Recompilation page) include a
// pre-release and a hotfix published without a Windows build; picking an older one pins it there (no update offered) until Back to latest.
// Doom64EX+'s folder holds several programs (two builds that could be the game, a tool, an uninstaller, a crash
// reporter) so UP asks which one starts it and the Program picker has something to choose from; Browse… "picks" a
// program outside the folder.
// "Delete the original disc image?" (main/recomp/image-offer.ts) follows main's rules: asked when the player picks or
// confirms a program, or after PlayOut's own pick started the game twice; never while a game file the recompilation
// is started with is the ROM. The sample library has no disc image with a recompilation, so here any ROM card is
// asked about (Sonic 2's decompilation reads Data.rsdk, not the ROM, so picking its program asks); Delete keeps the
// card (romRemoved) and Play then starts the recompilation.
// Delete moves it aside first and starts the recompilation to check it runs without it (main's test run,
// services/held-files.ts): Sonic 2's decompilation "crashes" 2 s after it starts (the Restore question shows), any
// other recompilation passes once it ran MOCK_IMAGE_TEST_MS and its session ended (the file goes to the Recycle Bin, a
// toast says so).
// The browser's Add (main: add-validate.ts, metadata cloud) checks a made-up GitHub: any github.com/<owner>/<repo>
// passes (a 'gitlab' link is not GitHub, a repo named 'missing' is not found, one named 'nowin' has no Windows
// download, 'archived' / 'fork' in the name show those warnings, a catalog repository is listed already); Paste reads
// https://github.com/Zelda64Recomp/Zelda64Recomp. An added one shows as "Added by you · awaiting approval" and is
// "suggested" 2 s later (still awaiting approval); Remove asks whether to uninstall it too when it is installed.
import type { PlayOutApi } from '@shared/api'
import {
  AUTO_STARTS_BEFORE_ASK,
  RECOMP_SAVES_FOLDER,
  type AddedRecompState,
  type GameFileNeed,
  type GameFileState,
  type GameRecomps,
  type InstalledRecomp,
  type RecompBrowseEntry,
  type RecompBrowseTitle,
  type RecompCatalogStatus,
  type RecompCloudState,
  type RecompEntry,
  type RecompExecutable,
  type RecompExecutables,
  type RecompHeldImage,
  type RecompImageOffer,
  type RecompOriginalImage,
  type RecompProgress,
  type RecompRelease,
  type RecompRow,
  type RecompSaves,
  type RecompSettingsView,
  type RecompTitle
} from '@shared/recomp'
import type { Game, GameRecompInfo } from '@shared/types'
import { recompAddedId, recompOnlyKey } from '@shared/recomp-play'
import { steamArt } from './art'
import { ROMS_ROOT, daysAgo } from './data'
import type { MockEmitter } from './emitter'

export type RecompApi = Pick<
  PlayOutApi,
  | 'getGameRecomps'
  | 'setPreferredRecomp'
  | 'installRecomp'
  | 'updateRecomp'
  | 'setRecompVersion'
  | 'updateAllRecomps'
  | 'checkRecompUpdates'
  | 'uninstallRecomp'
  | 'launchRecomp'
  | 'getRecompReleases'
  | 'getRecompReadme'
  | 'pickRecompGameFile'
  | 'setRecompGameFile'
  | 'listRecompExecutables'
  | 'setRecompExecutable'
  | 'pickRecompExecutable'
  | 'getRecompSettings'
  | 'browseRecomps'
  | 'setRecompFavorite'
  | 'addRecompToLibrary'
  | 'refreshRecompCatalog'
  | 'setRecompAutoUpdate'
  | 'setRecompSavePaths'
  | 'addRecompSaveFolder'
  | 'getRecompSaves'
  | 'findRecompSaveFolders'
  | 'setRecompCloud'
  | 'syncRecompSaves'
  | 'resolveRecompConflict'
  | 'openRecompFolder'
  | 'getRecompImageOffers'
  | 'answerRecompImageOffer'
  | 'askRecompImageDelete'
  | 'getRecompHeldImages'
  | 'answerRecompHeldImage'
  | 'checkRecompRepo'
  | 'addRecomp'
  | 'removeAddedRecomp'
  | 'readRecompClipboard'
>

/** The consoles the mock's Add offers (main: consoles.ts RECOMP_CONSOLE_IDS). */
const MOCK_ADD_CONSOLES = [
  { id: 'n64', name: 'Nintendo 64' },
  { id: 'psx', name: 'PlayStation' },
  { id: 'ps2', name: 'PlayStation 2' },
  { id: 'gc', name: 'GameCube' },
  { id: 'xbox360', name: 'Xbox 360' },
  { id: 'genesis', name: 'Genesis / Mega Drive' },
  { id: 'pc', name: 'PC' },
  { id: 'other', name: 'Other' }
]

export interface RecompMockDeps {
  emitter: MockEmitter
  /** The library (the matched games get metadata.recomp). */
  games: Map<string, Game>
  /** Start a play session for the game (the mock's launch); returns an error message when it cannot. */
  startSession: (gameId: string) => string | null
  /** End the play session now (a recompilation that "crashes" in the test run after Delete). */
  endSession?: () => void
  /** The game whose play session runs now (the test run waits for it to close before its verdict). */
  runningGameId?: () => string | null
  /** `recomp=conflict`: Doom64EX+'s saves start in a conflict with their copy. */
  conflict?: boolean
  /** `recomp=pinned`: Doom64EX+ starts pinned to v4.0.0.3 (kept by Change version: no update, Back to latest). */
  pinned?: boolean
  /** The Emulation folder in use (save copies go to its Recompilations Saves folder). */
  emulationDir?: () => string
  log?: (...args: unknown[]) => void
}

export interface RecompMock {
  api: RecompApi
  /** A game outside this library (a host's) matched with the catalog: its metadata.recomp, or null. */
  recompForGame(game: Game): GameRecompInfo | null
}

export const MOCK_RECOMP_ROOT = 'C:\\Games\\PlayOut\\Recompilations'
const APPDATA = 'C:\\Users\\Player\\AppData\\Roaming'
const LOCALAPPDATA = 'C:\\Users\\Player\\AppData\\Local'
const DOCUMENTS = 'C:\\Users\\Player\\Documents'

export const DOOM64EX_PLUS = 'github:atsb/doom64ex-plus'
export const DOOM64EX = 'github:svkaiser/doom64ex'
export const SONIC2_DECOMP = 'github:rubberduckycooly/sonic-1-2-2013-decompilation#sonic-2'
const SONIC1_DECOMP = 'github:rubberduckycooly/sonic-1-2-2013-decompilation#sonic-1'
/** A setup-program recompilation (Burnout Revenge): installed, its game put elsewhere, its unpacked folder unused. */
export const XERENGE = 'github:shipa-2/xerenge'
/** The game folder PlayOut unpacked from the Burnout Revenge image for Xerenge's setup (main/recomp/game-folder.ts). */
export const XERENGE_UNPACKED = 'C:\\Users\\Player\\Games\\Burnout Revenge\\game'
const GB = 1024 * 1024 * 1024

/** A fake install: phase steps, with the download ticking DOWNLOAD_TICKS times. */
const STEP_MS = 300
const DOWNLOAD_TICKS = 10
/** How long one mock install takes from 'checking' to 'done'. */
export const RECOMP_INSTALL_MS = STEP_MS * (4 + DOWNLOAD_TICKS)
const DIALOG_MS = 300
const MB = 1024 * 1024
/** The mock's test run after Delete: a recompilation still running this long after it started passes. */
export const MOCK_IMAGE_TEST_MS = 3000
/** How long after it starts a recompilation that "crashes" in the mock's test run closes. */
export const MOCK_CRASH_AFTER_MS = 1500
/** Recompilations that close right after they start without their disc image in the mock. */
const CRASHING_RECOMPS: ReadonlySet<string> = new Set([SONIC2_DECOMP])
const UNVERIFIED_WARNING =
  'This download has no published checksum, so PlayOut could not verify it.'

const doom64Rom: GameFileNeed = {
  id: 'game',
  label: 'Doom 64 ROM',
  description:
    'Your Doom 64 cartridge dump (the North American release). The first start builds DOOM64.WAD from it.',
  kind: 'game',
  how: 'flag',
  accepts: 'file',
  formats: ['.z64', '.n64', '.v64'],
  flag: '-rom',
  optional: false,
  hashes: [{ algo: 'sha1', value: 'c4a8f7a4d3c0b6e1f5e33a0b0b0c4f6f2a1d9e83' }],
  region: 'USA'
}

const sonic2Data: GameFileNeed = {
  id: 'game',
  label: 'Data.rsdk',
  description:
    'The Data.rsdk file from your copy of Sonic the Hedgehog 2 (2013 mobile remaster). The Genesis ROM will not work.',
  kind: 'game',
  how: 'folder',
  accepts: 'file',
  formats: ['.rsdk'],
  folder: '.',
  fileName: 'Data.rsdk',
  optional: false,
  hashes: [{ algo: 'md5', value: '8e3c2b0d8a2f7c95a6a2f9d1b4e0c7a1' }]
}

function entry(
  partial: Partial<RecompEntry> & Pick<RecompEntry, 'id' | 'name' | 'game'>
): RecompEntry {
  const repo = partial.id.replace(/^[a-z]+:/, '').replace(/#.*$/, '')
  return {
    systemId: 'n64',
    console: 'Nintendo 64',
    host: 'github',
    repo,
    repoUrl: `https://github.com/${repo}`,
    author: repo.split('/')[0] ?? '',
    blurb: '',
    description: '',
    features: [],
    tags: [],
    latestTag: null,
    released: null,
    downloadBytes: null,
    stars: null,
    downloads: null,
    license: null,
    completeness: 'playable',
    recommended: false,
    assetPattern: null,
    exe: null,
    installer: false,
    scannedSha256: null,
    needs: [],
    setupNotes: [],
    savePaths: [],
    iconUrl: null,
    coverUrl: null,
    heroUrl: null,
    archived: false,
    sources: ['decomp-buddy'],
    ...partial
  }
}

function catalogEntries(): RecompEntry[] {
  const doomArt = steamArt(1148590)
  const sonicArt = steamArt(1794960)
  return [
    entry({
      id: XERENGE,
      name: 'Xerenge',
      game: 'Burnout Revenge',
      systemId: 'xbox360',
      console: 'Xbox 360',
      author: 'shipa-2',
      blurb: 'Burnout Revenge recompiled for PC from your own disc.',
      description:
        'A static recompilation of the Xbox 360 release. Its installer builds the game from your own retail disc ' +
        'image and installs it where you choose.',
      tags: [
        { label: 'Playable', kind: 'status' },
        { label: 'Needs your game files', kind: 'setup' }
      ],
      latestTag: 'v0.9.0',
      released: daysAgo(20),
      downloadBytes: 84 * MB,
      stars: 960,
      license: 'MIT',
      installer: true,
      assetPattern: 'xerenge-*-windows-setup.exe',
      setupNotes: ['Run the setup: it installs the game from your Burnout Revenge disc image.']
    }),
    entry({
      id: DOOM64EX_PLUS,
      name: 'Doom64EX+',
      game: 'Doom 64',
      author: 'atsb',
      blurb:
        'Doom 64 as a native PC game: widescreen, high frame rates, mouse look and modern controllers.',
      description:
        'An enhanced continuation of **Doom64EX** that keeps the N64 look (the colored lighting and the 3-point ' +
        'texture filtering) while adding uncapped frame rates, widescreen, mod support and the Lost Levels.',
      features: ['Widescreen', 'High frame rate', 'Mods', 'Controller support', 'Lost Levels'],
      tags: [
        { label: 'Playable', kind: 'status' },
        { label: 'Needs your game files', kind: 'setup' },
        { label: 'Easy setup', kind: 'setup' },
        { label: 'Widescreen', kind: 'feature' },
        { label: 'Mods', kind: 'feature' }
      ],
      latestTag: 'v4.0.0.4',
      released: daysAgo(12),
      downloadBytes: 28 * MB,
      stars: 412,
      downloads: 58_300,
      license: 'GPL-2.0',
      recommended: true,
      assetPattern: 'DOOM64EX-Plus-*-win64.zip',
      exe: 'DOOM64EX-Plus.exe',
      scannedSha256: '5f0a3c9e1b7d4a2c8e6f0b1d3a5c7e9f1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a',
      needs: [doom64Rom],
      setupNotes: [
        'Pick your Doom 64 ROM once: the first start builds DOOM64.WAD from it next to the game.',
        'The Lost Levels are included in the WAD the game builds.'
      ],
      savePaths: ['%APPDATA%\\doom64ex-plus'],
      iconUrl: doomArt.logo ?? null,
      coverUrl: doomArt.cover ?? null,
      heroUrl: doomArt.hero ?? null,
      sources: ['decomp-buddy', 'recomplauncher']
    }),
    entry({
      id: DOOM64EX,
      name: 'Doom64EX',
      game: 'Doom 64',
      author: 'svkaiser',
      blurb: 'The original Doom 64 source port, faithful to the N64 release.',
      description:
        'A reverse-engineered recreation of Doom 64 for modern systems. Development has slowed; Doom64EX+ ' +
        'carries it on.',
      features: ['Widescreen', 'Mouse look'],
      tags: [
        { label: 'Playable', kind: 'status' },
        { label: 'Needs your game files', kind: 'setup' },
        { label: 'Easy setup', kind: 'setup' },
        { label: 'Archived', kind: 'warning' }
      ],
      latestTag: '2.5.1',
      released: daysAgo(1900),
      downloadBytes: 6 * MB,
      stars: 280,
      downloads: 41_000,
      license: 'GPL-2.0',
      assetPattern: 'doom64ex-*-win32.zip',
      exe: 'doom64ex.exe',
      needs: [
        { ...doom64Rom, how: 'folder', folder: '.', fileName: 'doom64.rom', flag: undefined }
      ],
      setupNotes: [
        'PlayOut copies your ROM next to the game as doom64.rom; it builds its WAD from it.'
      ],
      savePaths: ['{install}\\saves'],
      archived: true,
      iconUrl: doomArt.logo ?? null,
      coverUrl: doomArt.cover ?? null,
      heroUrl: doomArt.hero ?? null
    }),
    entry({
      id: SONIC2_DECOMP,
      name: 'Sonic 2 (RSDKv4 Decompilation)',
      game: 'Sonic the Hedgehog 2',
      systemId: 'genesis',
      console: 'Sega Genesis',
      repo: 'Rubberduckycooly/Sonic-1-2-2013-Decompilation',
      repoUrl: 'https://github.com/Rubberduckycooly/Sonic-1-2-2013-Decompilation',
      author: 'Rubberduckycooly',
      blurb: 'The 2013 remaster of Sonic 2 decompiled: widescreen, 60 fps and mod loader.',
      description:
        "A full decompilation of the Retro Engine v4 that runs Christian Whitehead's 2013 remasters of Sonic 1 " +
        'and Sonic 2. Needs the data file from your own copy of the mobile release.',
      features: ['Widescreen', 'Mod loader', 'Controller support'],
      tags: [
        { label: 'Playable', kind: 'status' },
        { label: 'Needs your game files', kind: 'setup' },
        { label: 'Easy setup', kind: 'setup' },
        { label: 'Widescreen', kind: 'feature' }
      ],
      latestTag: 'v1.3.2',
      released: daysAgo(240),
      downloadBytes: 9 * MB,
      stars: 1450,
      downloads: 212_000,
      license: 'Custom',
      recommended: true,
      assetPattern: 'Sonic1-2-Windows-x64.zip',
      exe: 'RSDKv4.exe',
      scannedSha256: '0b8e5c3a1f9d7b5e3c1a9f7d5b3e1c9a7f5d3b1e9c7a5f3d1b9e7c5a3f1d9b7e',
      needs: [sonic2Data],
      setupNotes: [
        'Copy Data.rsdk out of your Sonic 2 (2013) app and pick it here; PlayOut puts it next to the game.'
      ],
      savePaths: ['{install}\\SData.bin'],
      iconUrl: sonicArt.logo ?? null,
      coverUrl: sonicArt.cover ?? null,
      heroUrl: sonicArt.hero ?? null,
      sources: ['decomp-buddy', 'recomplauncher']
    }),
    entry({
      id: SONIC1_DECOMP,
      name: 'Sonic 1 (RSDKv4 Decompilation)',
      game: 'Sonic the Hedgehog',
      systemId: 'genesis',
      console: 'Sega Genesis',
      repo: 'Rubberduckycooly/Sonic-1-2-2013-Decompilation',
      repoUrl: 'https://github.com/Rubberduckycooly/Sonic-1-2-2013-Decompilation',
      author: 'Rubberduckycooly',
      blurb: 'The 2013 remaster of Sonic 1 decompiled.',
      latestTag: 'v1.3.2',
      released: daysAgo(240),
      downloadBytes: 9 * MB,
      stars: 1450,
      downloads: 212_000,
      recommended: true,
      exe: 'RSDKv4.exe',
      needs: [
        { ...sonic2Data, description: 'The Data.rsdk file from your copy of Sonic 1 (2013).' }
      ]
    })
  ]
}

function catalogTitles(): RecompTitle[] {
  return [
    {
      key: 'xbox360:burnout revenge',
      game: 'Burnout Revenge',
      systemId: 'xbox360',
      console: 'Xbox 360',
      entries: [XERENGE]
    },
    {
      key: 'n64:doom 64',
      game: 'Doom 64',
      systemId: 'n64',
      console: 'Nintendo 64',
      entries: [DOOM64EX_PLUS, DOOM64EX]
    },
    {
      key: 'genesis:sonic the hedgehog 2',
      game: 'Sonic the Hedgehog 2',
      systemId: 'genesis',
      console: 'Sega Genesis',
      entries: [SONIC2_DECOMP]
    },
    {
      key: 'genesis:sonic the hedgehog',
      game: 'Sonic the Hedgehog',
      systemId: 'genesis',
      console: 'Sega Genesis',
      entries: [SONIC1_DECOMP]
    }
  ]
}

function releasesFor(e: RecompEntry): RecompRelease[] {
  const make = (
    tag: string,
    days: number,
    notes: string,
    size: number,
    sha256: string | null,
    prerelease = false
  ): RecompRelease => ({
    tag,
    name: `${e.name} ${tag}`,
    publishedAt: daysAgo(days),
    prerelease,
    notes,
    url: `${e.repoUrl}/releases/tag/${tag}`,
    asset: {
      name: (e.assetPattern ?? `${e.name}-*-win64.zip`).replace('*', tag.replace(/^v/, '')),
      size,
      sha256
    }
  })
  switch (e.id) {
    case DOOM64EX_PLUS:
      return [
        make(
          'v4.0.0.5-beta',
          3,
          '## Beta\n- Vulkan renderer (experimental)\n- Do not use for long runs yet.',
          29 * MB,
          null,
          true
        ),
        make(
          'v4.0.0.4',
          12,
          '## Fixes\n- Fixed the sky on MAP28 at ultrawide resolutions.\n- Controller rumble on Xbox pads.\n\n## New\n- Optional N64-style dithering.',
          28 * MB,
          'a3c9e1b7d4a2c8e6f0b1d3a5c7e9f1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a5f0'
        ),
        {
          ...make(
            'v4.0.0.3a',
            40,
            '## Hotfix\n- Linux and macOS builds only: fixes a crash on Wayland.',
            0,
            null
          ),
          asset: null
        },
        make(
          'v4.0.0.3',
          64,
          '- Faster WAD building on first start.\n- Lost Levels selectable from the main menu.',
          27 * MB,
          '5f0a3c9e1b7d4a2c8e6f0b1d3a5c7e9f1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a'
        ),
        make('v4.0.0.2', 130, '- First release with mod folders.', 27 * MB, null),
        make('v4.0.0.1', 220, '- Initial 4.x release.', 26 * MB, null)
      ]
    case XERENGE:
      return [make('v0.9.0', 20, '- First Windows setup.', 84 * MB, null)]
    case DOOM64EX:
      return [
        make('2.5.1', 1900, '- Last release: crash fixes on Windows 10.', 6 * MB, null),
        make('2.5', 2100, '- SDL2 port.', 6 * MB, null)
      ]
    default:
      return [
        make(
          'v1.3.2',
          240,
          '## Fixes\n- Controller hot-plugging.\n- Save slots on Windows.',
          9 * MB,
          '0b8e5c3a1f9d7b5e3c1a9f7d5b3e1c9a7f5d3b1e9c7a5f3d1b9e7c5a3f1d9b7e'
        ),
        make('v1.3.1', 400, '- Mod loader fixes.', 9 * MB, null)
      ]
  }
}

function readmeFor(e: RecompEntry): string {
  return [
    `# ${e.name}`,
    '',
    e.blurb,
    '',
    '## Features',
    ...e.features.map((f) => `- ${f}`),
    '',
    '## Setup',
    ...e.setupNotes.map((n) => `1. ${n}`),
    '',
    '## Building',
    '',
    '```',
    'cmake -B build',
    'cmake --build build --config Release',
    '```',
    '',
    `Licensed under ${e.license ?? 'its own terms'}. See [the project page](${e.repoUrl}).`
  ].join('\n')
}

/** A new install's save-copy state: on, as in main. */
const emptyCloud = (): RecompCloudState => ({
  enabled: true,
  syncedHash: null,
  localHash: null,
  syncedAt: null,
  pending: false,
  error: null,
  conflict: null
})

function safeFolder(e: RecompEntry): string {
  return `${e.name.replace(/[<>:"/\\|?*]+/g, ' ').trim()} (${e.id.replace(/^[a-z]+:/, '').replace(/[/#]/g, '-')})`
}

/** Expands the mock's save templates to this pretend PC's folders. */
function expandTemplate(template: string, install: string): string {
  return template
    .replace(/%APPDATA%/gi, APPDATA)
    .replace(/%LOCALAPPDATA%/gi, LOCALAPPDATA)
    .replace(/%DOCUMENTS%|\{documents\}/gi, DOCUMENTS)
    .replace(/\{install\}/gi, install)
}

export function createRecompMock(deps: RecompMockDeps): RecompMock {
  const { emitter, games } = deps
  const log = deps.log ?? (() => undefined)
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  const clone = <T>(value: T): T => structuredClone(value)
  const now = (): string => new Date().toISOString()

  const entries = new Map(catalogEntries().map((e) => [e.id, e]))
  const titles = new Map(catalogTitles().map((t) => [t.key, t]))
  const releases = new Map([...entries.values()].map((e) => [e.id, releasesFor(e)]))
  const installed = new Map<string, InstalledRecomp>()
  /** Recompilations added in the browser: how far each got. */
  const addedState = new Map<string, AddedRecompState>()
  const preferred = new Map<string, string>()
  const progress = new Map<string, RecompProgress>()
  const emulationDir = (): string =>
    deps.emulationDir?.() ?? 'C:\\Users\\Player\\AppData\\Roaming\\PlayOut\\Emulation'
  const savesRoot = (): string => `${emulationDir()}\\${RECOMP_SAVES_FOLDER}`
  const copiesOf = (id: string): string => `${savesRoot()}\\${safeFolder(entries.get(id)!)}`
  const catalogStatus: RecompCatalogStatus = {
    fetchedAt: { 'decomp-buddy': daysAgo(0.2), recomplauncher: daysAgo(0.2) },
    entries: 187,
    titles: 164,
    matchedGames: 0,
    offline: [],
    refreshing: false
  }

  // Doom64EX+ is installed one release behind (an update shows), with its saves copied to the Emulation folder.
  {
    const e = entries.get(DOOM64EX_PLUS)!
    const dir = `${MOCK_RECOMP_ROOT}\\${safeFolder(e)}`
    installed.set(e.id, {
      id: e.id,
      dir,
      tag: 'v4.0.0.3',
      publishedAt: daysAgo(64),
      asset: 'DOOM64EX-Plus-4.0.0.3-win64.zip',
      downloadBytes: 27 * MB,
      diskBytes: 96 * MB,
      sha256: '5f0a3c9e1b7d4a2c8e6f0b1d3a5c7e9f1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a',
      verified: 'scanned',
      exe: 'DOOM64EX-Plus.exe',
      installedAt: daysAgo(64),
      updatedAt: daysAgo(64),
      releaseFiles: ['doom64ex-plus.exe', 'doom64ex-plus.wad', 'sdl2.dll'],
      autoUpdate: false,
      gameFiles: { game: { path: `${ROMS_ROOT}\\n64\\Doom 64 (USA).z64`, source: 'library' } },
      savePaths: ['%APPDATA%\\doom64ex-plus'],
      saveSource: 'catalog',
      saveSuggestions: ['{documents}\\My Games\\DOOM 64'],
      cloud: {
        enabled: true,
        syncedHash: 'h1',
        localHash: 'h1',
        syncedAt: daysAgo(3),
        pending: false,
        error: null,
        conflict: deps.conflict
          ? { localAt: daysAgo(1), cloudAt: daysAgo(0.5), cloudDevice: 'LIVING-ROOM-PC' }
          : null
      },
      prevTag: 'v4.0.0.2',
      pinnedTag: deps.pinned ? 'v4.0.0.3' : null
    })
  }

  // Xerenge's setup ran (PlayOut unpacked the disc for it first) and installed the game in C:\Games, away from the
  // unpacked folder; the player chose that program, so the disc image and the unpacked folder may both go.
  {
    const e = entries.get(XERENGE)!
    installed.set(e.id, {
      id: e.id,
      dir: `${MOCK_RECOMP_ROOT}\\${safeFolder(e)}`,
      tag: 'v0.9.0',
      publishedAt: daysAgo(20),
      asset: 'xerenge-0.9.0-windows-setup.exe',
      downloadBytes: 84 * MB,
      diskBytes: 84 * MB,
      sha256: '7c1e'.padEnd(64, '0'),
      verified: 'github',
      exe: 'C:\\Games\\Burnout Revenge\\bin\\burnout.exe',
      exeChosen: 'user',
      autoExe: 'xerenge-0.9.0-windows-setup.exe',
      exeIdentified: {
        exe: 'c:\\games\\burnout revenge\\bin\\burnout.exe',
        by: 'player',
        starts: 1
      },
      installedAt: daysAgo(20),
      updatedAt: daysAgo(20),
      releaseFiles: ['xerenge-0.9.0-windows-setup.exe'],
      autoUpdate: false,
      gameFiles: {},
      savePaths: [],
      saveSource: null,
      cloud: {
        enabled: true,
        syncedHash: null,
        localHash: null,
        syncedAt: null,
        pending: false,
        error: null,
        conflict: null
      },
      prevTag: null,
      pinnedTag: null
    })
  }

  // --- matching -----------------------------------------------------------------

  const titleKeyFor = (game: Game): string | null => {
    // A recompilation's own card is its title's (kept by syncOwnCards, as main/recomp/service.ts does).
    const own = recompOnlyKey(game)
    if (own) return titles.has(own) ? own : null
    if (game.source !== 'rom') return null
    const name = (game.user.titleOverride || game.title).toLowerCase()
    const key = `${game.platformId}:${name}`
    return titles.has(key) ? key : null
  }

  const preferredOf = (title: RecompTitle): string => {
    const chosen = preferred.get(title.key)
    if (chosen && title.entries.includes(chosen)) return chosen
    return title.entries.find((id) => installed.has(id)) ?? title.entries[0]!
  }

  const gamesForTitle = (key: string): Game[] =>
    [...games.values()].filter((g) => titleKeyFor(g) === key)
  /** The title's games other than a recompilation's own card. */
  const originalsOf = (key: string): Game[] => gamesForTitle(key).filter((g) => !recompOnlyKey(g))

  /** Rewrites metadata.recomp on every matched game; returns the ids that changed. */
  const syncMetadata = (): string[] => {
    const changed: string[] = []
    let matched = 0
    for (const game of games.values()) {
      const key = titleKeyFor(game)
      if (!key || recompOnlyKey(game)) continue
      matched++
      const title = titles.get(key)!
      const info: GameRecompInfo = {
        titleKey: key,
        count: title.entries.length,
        installed: title.entries.filter((id) => installed.has(id)),
        preferred: preferredOf(title),
        updatedAt: now()
      }
      const before = game.metadata.recomp
      if (
        !before ||
        before.count !== info.count ||
        before.preferred !== info.preferred ||
        before.installed.join() !== info.installed.join()
      ) {
        game.metadata = { ...game.metadata, recomp: info }
        changed.push(game.id)
      }
    }
    catalogStatus.matchedGames = matched
    return changed
  }

  /**
   * The recompilations' own library cards, as main does: one for each game with a recompilation installed and no card
   * in the library; it goes once none of its recompilations is installed, or when the game itself is in the library.
   */
  const syncOwnCards = (): {
    added: string[]
    removed: string[]
    updated: string[]
    movedTo: Record<string, string>
  } => {
    const added: string[] = []
    const removed: string[] = []
    const movedTo: Record<string, string> = {}
    const updated: string[] = []
    const covered = new Set<string>()
    for (const game of [...games.values()]) {
      const key = recompOnlyKey(game)
      if (!key) continue
      const title = titles.get(key)
      const made = game.metadata.recomp?.installed ?? []
      const here = [...installed.keys()].filter(
        (id) => title?.entries.includes(id) || made.includes(id)
      )
      // The original game is in the library: the card's play history moves to it (LibraryService.absorbGame).
      const original = originalsOf(key)[0]
      if (original) {
        original.playtimeMinutes += game.playtimeMinutes
        original.playCount += game.playCount
        if (game.lastPlayed && (!original.lastPlayed || game.lastPlayed > original.lastPlayed))
          original.lastPlayed = game.lastPlayed
        if (game.favorite) original.favorite = true
        games.delete(game.id)
        removed.push(game.id)
        movedTo[game.id] = original.id
        updated.push(original.id)
        continue
      }
      if (!title || !here.length || covered.has(key)) {
        games.delete(game.id)
        removed.push(game.id)
        continue
      }
      covered.add(key)
      const info: GameRecompInfo = {
        titleKey: key,
        count: title.entries.length,
        installed: here,
        preferred: preferredOf(title),
        updatedAt: now()
      }
      if (
        game.metadata.recomp?.installed.join() !== info.installed.join() ||
        game.metadata.recomp?.preferred !== info.preferred
      ) {
        game.metadata = { ...game.metadata, recomp: info }
        updated.push(game.id)
      }
    }
    for (const id of installed.keys()) {
      const title = [...titles.values()].find((t) => t.entries.includes(id))
      if (!title || covered.has(title.key) || originalsOf(title.key).length) continue
      covered.add(title.key)
      const gameId = `rom:${title.systemId}:recomp-${title.key.replace(/[^a-z0-9]+/g, '-')}`
      const cover = title.entries.map((e) => entries.get(e)?.coverUrl).find((u) => !!u) ?? undefined
      const hero = title.entries.map((e) => entries.get(e)?.heroUrl).find((u) => !!u) ?? undefined
      games.set(gameId, {
        id: gameId,
        source: 'rom',
        externalId: `Recompilations/${title.key}`,
        platformId: title.systemId,
        title: title.game,
        sortTitle: title.game.toLowerCase(),
        installed: false,
        launch: { kind: 'emulator', systemId: title.systemId, romPath: '' },
        tracking: { mode: 'spawned' },
        hidden: false,
        favorite: false,
        playtimeMinutes: 0,
        playCount: 0,
        addedAt: now(),
        metadata: {
          recomp: {
            titleKey: title.key,
            count: title.entries.length,
            installed: title.entries.filter((e) => installed.has(e)),
            preferred: preferredOf(title),
            updatedAt: now()
          }
        },
        media: { ...(cover ? { cover } : {}), ...(hero ? { hero } : {}) },
        metadataStatus: 'done',
        user: {},
        extra: { recompOnly: title.key }
      })
      added.push(gameId)
    }
    return { added, removed, updated, movedTo }
  }

  /** Recompilations favourited in the browser (main's RecompManifest.favorites). */
  const favorites = new Set<string>()
  const addedCardOf = (id: string): Game | undefined =>
    [...games.values()].find((g) => recompAddedId(g) === id)
  /** Added cards keep their one recompilation's installed state (main's syncAddedCards). */
  const syncAddedCards = (): string[] => {
    const changedIds: string[] = []
    for (const game of games.values()) {
      const id = recompAddedId(game)
      const info = game.metadata.recomp
      if (!id || !info) continue
      const now = installed.has(id) ? [id] : []
      if (info.installed.join() === now.join()) continue
      game.metadata = { ...game.metadata, recomp: { ...info, installed: now } }
      changedIds.push(game.id)
    }
    return changedIds
  }

  const changed = (ids: string[]): void => {
    const added = syncAddedCards()
    if (added.length) emitter.emit('library:changed', { reason: 'metadata', gameIds: added })
    const gameIds = syncMetadata()
    if (gameIds.length) emitter.emit('library:changed', { reason: 'metadata', gameIds })
    const own = syncOwnCards()
    if (own.removed.length)
      emitter.emit('library:changed', {
        reason: 'remove',
        gameIds: own.removed,
        ...(Object.keys(own.movedTo).length ? { movedTo: own.movedTo } : {})
      })
    if (own.added.length) emitter.emit('library:changed', { reason: 'scan', gameIds: own.added })
    if (own.updated.length)
      emitter.emit('library:changed', { reason: 'metadata', gameIds: own.updated })
    emitter.emit('recomp:changed', { ids })
  }

  syncMetadata()

  // --- helpers ------------------------------------------------------------------

  const requireEntry = (id: string): RecompEntry => {
    const e = entries.get(id)
    if (!e) throw new Error(`Unknown recompilation ${id}`)
    return e
  }
  const requireInstalled = (id: string): InstalledRecomp => {
    const record = installed.get(id)
    if (!record) throw new Error(`${entries.get(id)?.name ?? id} is not installed`)
    return record
  }
  const titleOfEntry = (id: string): RecompTitle | undefined =>
    [...titles.values()].find((t) => t.entries.includes(id))

  // --- the program it starts (main/recomp/executables.ts) -----------------------------

  /** Programs in an install folder (relative), beyond the one PlayOut picked. */
  const exeFiles = new Map<string, string[]>([
    [
      DOOM64EX_PLUS,
      [
        'DOOM64EX-Plus.exe',
        'DOOM64EX-Plus-Vulkan.exe',
        'tools\\wadgen.exe',
        'unins000.exe',
        'crashpad_handler.exe'
      ]
    ]
  ])
  const isFullPath = (p: string): boolean => /^[a-z]:[\\/]/i.test(p) || p.startsWith('\\\\')
  // (A short version of main's notGameReason.)
  const exeNote = (p: string): string | null => {
    const parts = p.toLowerCase().split(/[\\/]/)
    const name = parts.pop() ?? ''
    if (/^unins/.test(name)) return 'Uninstaller'
    if (name.includes('crash')) return 'Crash reporter'
    if (/redist|runtime/.test(name)) return 'Runtime installer'
    if (/setup|installer/.test(name)) return 'Setup program'
    if (/^(zapd|wadgen)\.exe$|extract|tool/.test(name) || parts.includes('tools'))
      return 'Helper program'
    return null
  }
  const executablesView = (id: string): RecompExecutables => {
    const record = requireInstalled(id)
    const user = record.exeChosen === 'user' && !!record.exe
    const auto = user ? (record.autoExe ?? null) : record.exe
    const full = (p: string): string => (isFullPath(p) ? p : `${record.dir}\\${p}`)
    const files = exeFiles.get(id) ?? (auto && !isFullPath(auto) ? [auto] : [])
    const same = (a: string | null, b: string | null): boolean =>
      !!a && !!b && full(a).toLowerCase() === full(b).toLowerCase()
    const candidates: RecompExecutable[] = [
      ...files.filter((f) => !exeNote(f)),
      ...files.filter((f) => exeNote(f))
    ].map((path) => ({
      path,
      full: full(path),
      note: exeNote(path),
      current: same(path, record.exe),
      auto: same(path, auto)
    }))
    return {
      id,
      dir: record.dir,
      current: record.exe,
      currentFull: record.exe ? full(record.exe) : null,
      source: user ? 'user' : 'auto',
      auto,
      outside: !!record.exe && isFullPath(record.exe),
      missing: false,
      candidates,
      truncated: false
    }
  }
  const setExecutable = (id: string, path: string | null): RecompExecutables => {
    const record = requireInstalled(id)
    if (busy(id)) throw new Error('It is installing; wait until it finishes.')
    if (path === null) {
      // Automatic: the player accepted PlayOut's pick, so UP no longer asks (main's automaticExe).
      if (record.exeChosen === 'user') record.exe = record.autoExe ?? null
      record.exeChosen = 'confirmed'
      delete record.autoExe
    } else {
      if (!/\.exe$/i.test(path)) throw new Error(`${path} is not a program (.exe file).`)
      const known = exeFiles.get(id) ?? []
      if (!isFullPath(path) && !known.includes(path) && path !== record.exe)
        throw new Error(`${record.dir}\\${path} was not found.`)
      if (record.exeChosen !== 'user') record.autoExe = record.exe
      record.exe = path
      record.exeChosen = 'user'
    }
    // The player identified the program: the disc image question is asked at once.
    if (record.exe)
      record.exeIdentified = { exe: record.exe.toLowerCase(), by: 'player', starts: 0 }
    log(`recomp ${id} starts ${record.exe ?? 'nothing'}${path === null ? ' (automatic)' : ''}`)
    changed([id])
    offerImages(id)
    return executablesView(id)
  }

  // --- "Delete the original disc image?" ----------------------------------------------------------------------------

  const imageOffers = new Map<
    string,
    {
      state: 'pending' | 'kept' | 'deleted'
      recompId: string
      gameId: string
      /** null: a question about the unpacked game folder only. */
      image: string | null
      folder?: string | null
      at: string
    }
  >()
  const imageKey = (recompId: string, image: string): string => `${recompId}|${image.toLowerCase()}`
  const folderKey = (recompId: string, folder: string): string =>
    `${recompId}|folder|${folder.toLowerCase()}`
  const fileNameOf = (path: string): string => path.split(/[\\/]/).pop() ?? path
  /**
   * Why the recompilation still needs the game's ROM (main's imageNeeded): a game file it is started with (the ROM,
   * or a folder holding it), or a game file it needs is not chosen yet; else null.
   */
  const imageNeeded = (e: RecompEntry, game: Game): string | null => {
    const rom = game.romPath?.toLowerCase()
    const states = gameFileStates(e, game.id)
    const reads = states.some((st) => {
      if (!st.path || !rom || !(st.how === 'flag' || st.how === 'env' || st.how === 'folder'))
        return false
      const path = st.path.toLowerCase().replace(/[\\/]+$/, '')
      return rom === path || rom.startsWith(`${path}\\`) || rom.startsWith(`${path}/`)
    })
    if (reads) return `${e.name} reads it at every start`
    if (states.some((st) => !st.ready))
      return `${e.name} still needs its game files (pick them on the Recompilation page first)`
    return null
  }
  /** The setup program is still what starts it (main's isInstallerRecord): nothing it installs from may go. */
  const stillSetup = (id: string): boolean => {
    const record = installed.get(id)
    const e = entries.get(id)
    if (!record || !e?.installer) return false
    return !(record.exeChosen === 'user' && !!record.exe && record.exe !== record.autoExe)
  }
  const imageCandidates = (id: string): Game[] =>
    [...games.values()].filter((g) => {
      const key = titleKeyFor(g)
      return (
        g.source === 'rom' &&
        g.installed &&
        !g.remote &&
        !g.romRemoved &&
        !!g.romPath &&
        !!key &&
        titles.get(key)!.entries.includes(id)
      )
    })
  /** The game folder PlayOut "unpacked" for a setup program (main's unpackedFolders), by recompilation. */
  const unpacked = new Map<
    string,
    { folder: string; totalBytes: number; state: 'unpacked' | 'kept' | 'deleted' }
  >()
  if (installed.has(XERENGE))
    unpacked.set(XERENGE, {
      folder: XERENGE_UNPACKED,
      totalBytes: Math.round(6.8 * GB),
      state: 'unpacked'
    })
  /** Main's unpackedFolderUse in short: the folder may go once the game is installed away from it. */
  const folderOf = (id: string): { folder: string; totalBytes: number; kept: boolean } | null => {
    const u = unpacked.get(id)
    const record = installed.get(id)
    if (!u || u.state === 'deleted' || !record || stillSetup(id) || !record.exeIdentified)
      return null
    const program = (record.exe ?? '').toLowerCase()
    const around = `${u.folder.toLowerCase().replace(/\\[^\\]+$/, '')}\\`
    if (!isFullPath(program) || program.startsWith(around)) return null
    return { folder: u.folder, totalBytes: u.totalBytes, kept: u.state === 'kept' }
  }
  const folderAsked = (folder: string): boolean =>
    [...imageOffers.values()].some(
      (o) => o.state === 'pending' && o.folder?.toLowerCase() === folder.toLowerCase()
    )
  const offerView = (key: string): RecompImageOffer | null => {
    const o = imageOffers.get(key)
    const game = o ? games.get(o.gameId) : undefined
    if (!o || !game) return null
    const f = o.folder ? folderOf(o.recompId) : null
    const folder =
      f && f.folder.toLowerCase() === o.folder!.toLowerCase()
        ? { path: f.folder, totalBytes: f.totalBytes, kept: f.kept }
        : null
    const image = o.image && game.romPath === o.image && !game.romRemoved ? o.image : null
    if (!image && !folder) return null
    const fileName = image ? fileNameOf(image) : null
    return {
      key,
      recompId: o.recompId,
      recompName: entries.get(o.recompId)?.name ?? o.recompId,
      gameId: game.id,
      gameTitle: game.user.titleOverride || game.title,
      fileName,
      files: fileName ? [fileName] : [],
      totalBytes: fileName ? 512 * MB : null,
      folder,
      at: o.at
    }
  }
  const pendingOffers = (): RecompImageOffer[] =>
    [...imageOffers.entries()]
      .filter(([, o]) => o.state === 'pending')
      .map(([key]) => offerView(key))
      .filter((o): o is RecompImageOffer => !!o)
  const emitOffers = (): void => {
    emitter.emit('recomp:image-offers', { offers: pendingOffers() })
  }
  function offerImages(id: string): void {
    const e = entries.get(id)
    if (!e || !installed.has(id) || stillSetup(id)) return
    const added: string[] = []
    for (const game of imageCandidates(id)) {
      const key = imageKey(id, game.romPath!)
      if (imageOffers.has(key) || imageNeeded(e, game)) continue
      imageOffers.set(key, {
        state: 'pending',
        recompId: id,
        gameId: game.id,
        image: game.romPath!,
        at: now()
      })
      added.push(key)
    }
    const u = unpacked.get(id)
    const f = folderOf(id)
    if (u && f && u.state === 'unpacked' && !folderAsked(f.folder)) {
      if (added.length) imageOffers.get(added[0]!)!.folder = f.folder
      else {
        const game = [...games.values()].find((g) => {
          const key = titleKeyFor(g)
          return !!key && titles.get(key)!.entries.includes(id)
        })
        if (game) {
          const key = folderKey(id, f.folder)
          imageOffers.set(key, {
            state: 'pending',
            recompId: id,
            gameId: game.id,
            image: null,
            folder: f.folder,
            at: now()
          })
          added.push(key)
        }
      }
    }
    if (added.length) emitOffers()
  }
  // --- The test run after Delete (main's held-files.ts) --------------------------------------------------------------

  interface MockHeld {
    holdId: string
    recompId: string
    gameId: string
    offerKey: string
    image: string | null
    folder: string | null
    at: string
    state: Exclude<RecompHeldImage['state'], 'interrupted'>
    reason: string | null
    decidedAt: string | null
    /** The card as it was, for Restore. */
    before?: { romPath: string; launchRomPath?: string; installSize?: Game['installSize'] }
  }
  const held = new Map<string, MockHeld>()
  let heldSeq = 1
  const heldWhat = (h: MockHeld): string =>
    [h.image ? fileNameOf(h.image) : null, h.folder].filter(Boolean).join(' and ') || 'the files'
  const heldView = (h: MockHeld): RecompHeldImage => {
    const game = games.get(h.gameId)
    return {
      holdId: h.holdId,
      recompId: h.recompId,
      recompName: entries.get(h.recompId)?.name ?? h.recompId,
      gameId: h.gameId,
      gameTitle: game ? game.user.titleOverride || game.title : h.gameId,
      fileName: h.image ? fileNameOf(h.image) : null,
      files: [h.image ? fileNameOf(h.image) : null, h.folder].filter((x): x is string => !!x),
      folder: h.folder,
      state: h.state,
      reason: h.reason,
      at: h.at,
      decidedAt: h.decidedAt
    }
  }
  const heldList = (): RecompHeldImage[] =>
    [...held.values()].sort((a, b) => a.at.localeCompare(b.at)).map(heldView)
  const emitHeld = (note?: { ok: boolean; message: string }): void => {
    emitter.emit('recomp:held-images', { items: heldList(), ...(note ? { note } : {}) })
  }
  /** Start the recompilation and judge it (main's testStart), then release the files or ask. */
  async function runHeldTest(holdId: string): Promise<void> {
    const h = held.get(holdId)
    if (!h) return
    h.state = 'testing'
    h.reason = null
    h.decidedAt = null
    emitHeld()
    const name = entries.get(h.recompId)?.name ?? 'The recompilation'
    await sleep(DIALOG_MS)
    const started = await api.launchRecomp(h.gameId, h.recompId)
    const decide = (state: MockHeld['state'], reason: string | null): void => {
      h.state = state
      h.reason = reason
      h.decidedAt = now()
      log(
        `recomp ${h.recompId}: test without ${heldWhat(h)}: ${state}${reason ? ` (${reason})` : ''}`
      )
      emitHeld()
    }
    if (!started.ok) {
      if (started.reason === 'failed')
        return decide('crashed', `${name} did not start: ${started.message}`)
      if (started.reason === 'needs-files')
        return decide('crashed', `${name} asks for its game files without it`)
      return decide(
        'not-tested',
        'message' in started ? started.message : 'it was not started for another reason'
      )
    }
    if (CRASHING_RECOMPS.has(h.recompId)) {
      await sleep(MOCK_CRASH_AFTER_MS)
      deps.endSession?.()
      return decide(
        'crashed',
        `${name} closed ${Math.round(MOCK_CRASH_AFTER_MS / 1000)} s after it started (exit code 3221225477)`
      )
    }
    await sleep(MOCK_IMAGE_TEST_MS)
    // As main: still running proves nothing; the verdict waits for the game to close (the mock's session ends on its
    // own after a few seconds, a normal exit).
    while (deps.runningGameId?.() === h.gameId) await sleep(250)
    held.delete(holdId)
    log(`recomp ${h.recompId}: runs without ${heldWhat(h)}; moved it to the Recycle Bin`)
    emitHeld({
      ok: true,
      message: `${name} started without ${heldWhat(h)}; it is now in the Recycle Bin.`
    })
    changed([h.recompId])
  }
  async function answerHeld(
    holdId: string,
    answer: 'restore' | 'delete' | 'retry'
  ): Promise<{ ok: boolean; message: string }> {
    const h = held.get(holdId)
    if (!h) return { ok: false, message: 'That question was already answered.' }
    if (h.state === 'testing')
      return { ok: false, message: 'PlayOut is still checking it; wait for the result.' }
    const what = heldWhat(h)
    if (answer === 'retry') {
      void runHeldTest(holdId)
      return {
        ok: true,
        message: `Starting ${entries.get(h.recompId)?.name ?? 'the recompilation'} again to check it runs without ${what}`
      }
    }
    await sleep(DIALOG_MS)
    held.delete(holdId)
    if (answer === 'delete') {
      log(`recomp ${h.recompId}: ${what} moved to the Recycle Bin (Delete anyway)`)
      emitHeld()
      return { ok: true, message: `Moved ${what} to the Recycle Bin` }
    }
    // Restore: back where it was, an ordinary ROM card again, and kept for this recompilation.
    const game = games.get(h.gameId)
    if (h.image && game?.romRemoved && h.before) {
      game.romPath = h.before.romPath
      if (h.before.installSize !== undefined) game.installSize = h.before.installSize
      if (game.launch.kind === 'emulator')
        game.launch = { ...game.launch, romPath: h.before.launchRomPath ?? h.before.romPath }
      delete game.romRemoved
      emitter.emit('library:changed', { reason: 'update', gameIds: [game.id] })
    }
    if (h.image) {
      const o = imageOffers.get(h.offerKey)
      if (o) o.state = 'kept'
      else
        imageOffers.set(imageKey(h.recompId, h.image), {
          state: 'kept',
          recompId: h.recompId,
          gameId: h.gameId,
          image: h.image,
          at: h.at
        })
    }
    const u = h.folder ? unpacked.get(h.recompId) : undefined
    if (u) u.state = 'kept'
    log(`recomp ${h.recompId}: restored ${what}`)
    emitHeld()
    emitOffers()
    changed([h.recompId])
    return { ok: true, message: `Restored ${what}` }
  }

  /** A start succeeded (main's countStart): whether to ask now. */
  const countStart = (record: InstalledRecomp): boolean => {
    const exe = (record.exe ?? '').toLowerCase()
    const cur = record.exeIdentified
    if (record.exeChosen === 'user' || (cur?.by === 'player' && cur.exe === exe)) {
      record.exeIdentified = { exe, by: 'player', starts: (cur?.exe === exe ? cur.starts : 0) + 1 }
      return true
    }
    const starts = cur?.by === 'auto' && cur.exe === exe ? cur.starts + 1 : 1
    record.exeIdentified = { exe, by: 'auto', starts }
    return starts >= AUTO_STARTS_BEFORE_ASK
  }

  const latestStable = (id: string, installedTag: string | null): RecompRelease | null => {
    const list = releases.get(id) ?? []
    const prereleaseOk = !!list.find((r) => r.tag === installedTag)?.prerelease
    return list.find((r) => r.asset && (prereleaseOk || !r.prerelease)) ?? null
  }

  /** The project's newest release with a Windows download (a full release, else a pre-release), as main's. */
  const newestOf = (id: string): RecompRelease | null => {
    const list = releases.get(id) ?? []
    return list.find((r) => r.asset && !r.prerelease) ?? list.find((r) => r.asset) ?? null
  }

  /** The pin a chosen release leaves: its tag when a newer release has a Windows download (main's pinFor). */
  const pinOf = (id: string, tag: string): string | null => {
    const list = releases.get(id) ?? []
    const newest = newestOf(id)
    if (!newest) return null
    const at = list.findIndex((r) => r.tag === tag)
    return at > list.indexOf(newest) ? tag : null
  }

  const updateOf = (id: string): string | null => {
    const record = installed.get(id)
    // Pinned to an older release: no update is offered until Back to latest.
    if (!record || record.pinnedTag) return null
    const latest = latestStable(id, record.tag)
    if (!latest || latest.tag === record.tag) return null
    // Never offer an older release than the installed one.
    const list = releases.get(id) ?? []
    const at = (tag: string): number => {
      const i = list.findIndex((r) => r.tag === tag)
      return i < 0 ? Number.MAX_SAFE_INTEGER : i
    }
    return at(latest.tag) < at(record.tag) ? latest.tag : null
  }

  const allUpdates = (): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const id of installed.keys()) {
      const tag = updateOf(id)
      if (tag) out[id] = tag
    }
    return out
  }

  const gameFileStates = (e: RecompEntry, gameId: string | null): GameFileState[] => {
    const record = installed.get(e.id)
    const library = gameId ? libraryFilesFor(gameId) : []
    return e.needs.map((need) => {
      let choice = record?.gameFiles[need.id] ?? picks.get(`${e.id}|${need.id}`) ?? null
      if (!choice && need.kind === 'game') {
        const found = library.find((p) =>
          need.formats.length ? need.formats.some((f) => p.toLowerCase().endsWith(f)) : true
        )
        if (found) choice = { path: found, source: 'library' }
      }
      const path = choice?.path ?? null
      const verified: GameFileState['verified'] = !path
        ? null
        : !need.hashes.length
          ? 'unverified'
          : need.formats.some((f) => path.toLowerCase().endsWith(f))
            ? 'match'
            : 'mismatch'
      return {
        ...clone(need),
        path,
        source: choice?.source ?? null,
        verified,
        ready: need.optional || need.how === 'self' || need.how === 'none' || !!path
      }
    })
  }
  /** Game-file choices made before the recomp is installed (kept here, moved into the record on install). */
  const picks = new Map<string, { path: string; source: 'picked' | 'library' }>()

  const libraryFilesFor = (gameId: string): string[] => {
    const game = games.get(gameId)
    if (game?.romRemoved) return []
    const rom =
      game?.romPath ?? (game?.launch.kind === 'emulator' ? game.launch.romPath : undefined)
    return rom ? [rom] : []
  }

  const setChoice = (
    gameId: string,
    recompId: string,
    needId: string,
    path: string | null,
    source: 'picked' | 'library'
  ): GameFileState[] => {
    const e = requireEntry(recompId)
    if (!e.needs.some((n) => n.id === needId)) throw new Error(`Unknown game file ${needId}`)
    const record = installed.get(recompId)
    const key = `${recompId}|${needId}`
    if (path) {
      picks.set(key, { path, source })
      if (record) record.gameFiles[needId] = { path, source }
    } else {
      picks.delete(key)
      if (record) delete record.gameFiles[needId]
    }
    emitter.emit('recomp:changed', { ids: [recompId] })
    return gameFileStates(e, gameId)
  }

  // --- installs -----------------------------------------------------------------

  let queueTail: Promise<void> = Promise.resolve()
  const report = (p: RecompProgress): void => {
    progress.set(p.id, p)
    emitter.emit('recomp:progress', clone(p))
  }
  const busy = (id: string): boolean => {
    const p = progress.get(id)
    return !!p && p.phase !== 'done' && p.phase !== 'failed'
  }
  const base = (id: string): RecompProgress => ({
    id,
    phase: 'queued',
    progress: null,
    bytes: null,
    total: null,
    message: null,
    warning: null
  })

  async function runInstall(id: string, tag: string | undefined): Promise<void> {
    const e = requireEntry(id)
    report({ ...base(id), phase: 'checking', message: 'Looking for the newest release…' })
    await sleep(STEP_MS)
    const list = releases.get(id) ?? []
    const previous = installed.get(id) ?? null
    const release = tag
      ? list.find((r) => r.tag === tag)
      : previous?.pinnedTag
        ? newestOf(id)
        : latestStable(id, previous?.tag ?? null)
    if (!release?.asset) {
      report({
        ...base(id),
        phase: 'failed',
        message: tag
          ? `Release ${tag} has no Windows download.`
          : `${e.name} has no Windows download yet.`
      })
      return
    }
    const total = release.asset.size
    const warning = release.asset.sha256 ? null : UNVERIFIED_WARNING
    for (let i = 1; i <= DOWNLOAD_TICKS; i++) {
      await sleep(STEP_MS)
      report({
        ...base(id),
        phase: 'downloading',
        progress: i / DOWNLOAD_TICKS,
        bytes: Math.round((total * i) / DOWNLOAD_TICKS),
        total,
        message: `Downloading ${release.asset.name}`,
        warning
      })
    }
    report({ ...base(id), phase: 'verifying', total, warning })
    await sleep(STEP_MS)
    report({ ...base(id), phase: 'extracting', total, warning })
    await sleep(STEP_MS)
    report({ ...base(id), phase: 'installing', total, warning })
    await sleep(STEP_MS)
    const at = now()
    const gameFiles: InstalledRecomp['gameFiles'] = { ...(previous?.gameFiles ?? {}) }
    for (const need of e.needs) {
      const pick = picks.get(`${id}|${need.id}`)
      if (pick && !gameFiles[need.id]) gameFiles[need.id] = pick
    }
    const autoExe = e.installer ? release.asset.name : e.exe
    // The program the user chose carries over (the mock's files never go away).
    const chosen = previous?.exeChosen === 'user' && previous.exe ? previous.exe : null
    installed.set(id, {
      id,
      dir: previous?.dir ?? `${MOCK_RECOMP_ROOT}\\${safeFolder(e)}`,
      tag: release.tag,
      publishedAt: release.publishedAt,
      asset: release.asset.name,
      downloadBytes: total,
      diskBytes: Math.round(total * 3.4),
      sha256: release.asset.sha256 ?? 'c0ffee'.padEnd(64, '0'),
      verified: release.asset.sha256
        ? release.asset.sha256 === e.scannedSha256
          ? 'scanned'
          : 'github'
        : 'unverified',
      exe: chosen ?? autoExe,
      // (PlayOut's confirmed pick stays confirmed while the update keeps it, as main's carryExeChoice.)
      ...(chosen
        ? { exeChosen: 'user' as const, autoExe }
        : previous?.exeChosen === 'confirmed' && previous.exe === autoExe
          ? { exeChosen: 'confirmed' as const }
          : {}),
      installedAt: previous?.installedAt ?? at,
      updatedAt: at,
      releaseFiles: [(e.exe ?? 'game.exe').toLowerCase()],
      autoUpdate: previous?.autoUpdate ?? false,
      gameFiles,
      savePaths: previous?.savePaths ?? [...e.savePaths],
      saveSource: previous?.saveSource ?? (e.savePaths.length ? 'catalog' : null),
      cloud: previous?.cloud ?? emptyCloud(),
      ...(previous?.saveSuggestions ? { saveSuggestions: previous.saveSuggestions } : {}),
      prevTag:
        previous && previous.tag !== release.tag ? previous.tag : (previous?.prevTag ?? null),
      // An older release chosen for an installed recompilation (either screen) is pinned, as main's runInstall.
      pinnedTag: tag && previous ? pinOf(id, release.tag) : null
    })
    report({
      ...base(id),
      phase: 'done',
      progress: 1,
      bytes: total,
      total,
      message: previous ? `Updated to ${release.tag}` : `Installed ${release.tag}`,
      warning
    })
    log(`recomp ${id} ${previous ? 'updated' : 'installed'} at ${release.tag}`)
    changed([id])
  }

  const enqueue = (id: string, tag?: string): void => {
    requireEntry(id)
    if (busy(id)) throw new Error(`${entries.get(id)!.name} is already installing`)
    report(base(id))
    queueTail = queueTail
      .then(() => runInstall(id, tag))
      .catch((err) => {
        report({ ...base(id), phase: 'failed', message: String(err) })
      })
  }

  // --- settings rows ------------------------------------------------------------

  const resolvedSaves = (record: InstalledRecomp): string[] =>
    record.savePaths.map((t) => expandTemplate(t, record.dir))

  const suggestionsOf = (record: InstalledRecomp): string[] => {
    const inUse = resolvedSaves(record).map((p) => p.toLowerCase())
    return (record.saveSuggestions ?? [])
      .map((t) => expandTemplate(t, record.dir))
      .filter((p) => !inUse.includes(p.toLowerCase()))
  }

  const savesOf = (record: InstalledRecomp): RecompSaves => ({
    templates: [...record.savePaths],
    resolved: resolvedSaves(record),
    source: record.saveSource,
    suggestions: suggestionsOf(record),
    savesDir: copiesOf(record.id),
    cloud: clone(record.cloud)
  })

  const row = (record: InstalledRecomp): RecompRow => {
    const e = entries.get(record.id)!
    const title = titleOfEntry(record.id)
    return {
      entry: clone(e),
      installed: clone(record),
      gameIds: title ? gamesForTitle(title.key).map((g) => g.id) : [],
      update: updateOf(record.id),
      release: {
        prerelease: !!releases.get(record.id)?.find((r) => r.tag === record.tag)?.prerelease,
        latest: newestOf(record.id)?.tag ?? null
      },
      alternatives: (title?.entries ?? [])
        .filter((id) => id !== record.id)
        .map((id) => ({ id, name: entries.get(id)!.name, installed: installed.has(id) })),
      resolvedSavePaths: resolvedSaves(record),
      savesDir: copiesOf(record.id),
      saveSuggestions: suggestionsOf(record),
      originalImage: originalImageOfRow(record.id, title)
    }
  }

  /** Settings › Recompilations' "Delete…" (main's originalImageOfRow): the first matched game with something to go. */
  const originalImageOfRow = (
    id: string,
    title: RecompTitle | undefined
  ): RecompRow['originalImage'] => {
    for (const game of title ? gamesForTitle(title.key) : []) {
      const found = originalImageFor(game, id)
      if (found) return { ...found, gameId: game.id }
    }
    return null
  }

  const settingsView = (): RecompSettingsView => ({
    catalog: clone(catalogStatus),
    root: MOCK_RECOMP_ROOT,
    savesDir: savesRoot(),
    rows: [...installed.values()].map(row),
    busy: [...progress.values()].filter((p) => busy(p.id)).map((p) => clone(p))
  })

  const saveFolderPick = (record: InstalledRecomp): string =>
    `${DOCUMENTS}\\My Games\\${entries.get(record.id)!.name.replace(/[^\w ]+/g, '')}`

  // --- the API ------------------------------------------------------------------

  /** The Recompilation page's "Delete…" section (main's originalImageOf): the image and/or the unpacked folder. */
  const originalImageOf = (game: Game, title: RecompTitle): GameRecomps['originalImage'] => {
    for (const id of [preferredOf(title), ...title.entries]) {
      const found = originalImageFor(game, id)
      if (found) return found
    }
    return null
  }

  /** What of `game` installed recompilation `id` lets go: its disc image and/or the folder unpacked for it. */
  function originalImageFor(game: Game, id: string): RecompOriginalImage | null {
    if (!installed.has(id)) return null
    const rom = game.romRemoved ? null : (game.romPath ?? null)
    const imageOk = !!rom && !stillSetup(id) && !imageNeeded(entries.get(id)!, game)
    const f = folderOf(id)
    if (!imageOk && !f) return null
    return {
      recompId: id,
      fileName: imageOk ? fileNameOf(rom!) : null,
      kept: imageOk && imageOffers.get(imageKey(id, rom!))?.state === 'kept',
      folder: f ? { path: f.folder, totalBytes: f.totalBytes, kept: f.kept } : null
    }
  }

  const api: RecompApi = {
    async getGameRecomps(gameId) {
      const game = games.get(gameId)
      const key = game ? titleKeyFor(game) : null
      if (!key) return null
      const title = titles.get(key)!
      const members = title.entries.map((id) => entries.get(id)!)
      const view: GameRecomps = {
        gameId,
        title: clone(title),
        entries: clone(members),
        installed: Object.fromEntries(
          title.entries
            .filter((id) => installed.has(id))
            .map((id) => [id, clone(installed.get(id)!)])
        ),
        preferred: preferredOf(title),
        updates: Object.fromEntries(
          title.entries.flatMap((id) => {
            const tag = updateOf(id)
            return tag ? [[id, tag]] : []
          })
        ),
        gameFiles: Object.fromEntries(members.map((e) => [e.id, gameFileStates(e, gameId)])),
        libraryFiles: libraryFilesFor(gameId),
        originalImage: originalImageOf(game!, title)
      }
      return view
    },
    async setPreferredRecomp(gameId, recompId) {
      const game = games.get(gameId)
      const key = game ? titleKeyFor(game) : null
      const title = key ? titles.get(key) : undefined
      if (!title || !title.entries.includes(recompId))
        throw new Error(`${recompId} is not a recompilation of this game`)
      preferred.set(title.key, recompId)
      changed([recompId])
    },
    async installRecomp(recompId, tag) {
      enqueue(recompId, tag)
    },
    async updateRecomp(recompId) {
      requireInstalled(recompId)
      enqueue(recompId)
    },
    async setRecompVersion(recompId, tag) {
      const record = requireInstalled(recompId)
      if (busy(recompId)) throw new Error('It is installing; wait until it finishes.')
      if (tag === null) return enqueue(recompId)
      const e = requireEntry(recompId)
      const release = (releases.get(recompId) ?? []).find((r) => r.tag === tag)
      if (!release) throw new Error(`${tag} is not a release of ${e.name}.`)
      if (!release.asset) throw new Error(`${tag} of ${e.name} has no Windows download.`)
      if (release.tag === record.tag) {
        record.pinnedTag = pinOf(recompId, tag)
        changed([recompId])
        return
      }
      enqueue(recompId, tag)
    },
    async updateAllRecomps() {
      for (const id of Object.keys(allUpdates())) if (!busy(id)) enqueue(id)
    },
    async checkRecompUpdates() {
      await sleep(STEP_MS)
      return allUpdates()
    },
    async uninstallRecomp(recompId) {
      requireInstalled(recompId)
      if (busy(recompId)) throw new Error('It is installing; wait until it finishes.')
      installed.delete(recompId)
      progress.delete(recompId)
      log(`recomp ${recompId} uninstalled`)
      changed([recompId])
    },
    async launchRecomp(gameId, recompId) {
      const game = games.get(gameId)
      const key = game ? titleKeyFor(game) : null
      if (!key)
        return { ok: false, reason: 'not-installed', message: 'This game has no recompilation.' }
      const id = recompId ?? preferredOf(titles.get(key)!)
      const e = requireEntry(id)
      const record = installed.get(id)
      if (!record)
        return { ok: false, reason: 'not-installed', message: `${e.name} is not installed.` }
      if (busy(id)) return { ok: false, reason: 'running', message: `${e.name} is updating.` }
      // Which program starts the game is unclear (main's exeUnclear): nobody chose or confirmed it and several could
      // be the game (Doom64EX+ ships two builds), so UP asks first.
      const exes = executablesView(id)
      if (
        !e.installer &&
        !record.exeChosen &&
        exes.source === 'auto' &&
        exes.candidates.filter((c) => c.note === null).length > 1
      )
        return { ok: false, reason: 'choose-exe', recompId: id, executables: exes }
      const states = gameFileStates(e, gameId)
      const missing = states.filter((s) => !s.ready)
      if (missing.length) {
        // Library files found for a need are remembered, as main does when it auto-picks them.
        return { ok: false, reason: 'needs-files', needs: missing }
      }
      for (const s of states)
        if (s.path && s.source === 'library' && !record.gameFiles[s.id])
          record.gameFiles[s.id] = { path: s.path, source: 'library' }
      if (record.cloud.enabled && record.cloud.conflict)
        return { ok: false, reason: 'save-conflict', conflict: clone(record.cloud.conflict) }
      const error = deps.startSession(gameId)
      if (error) return { ok: false, reason: 'running', message: error }
      log(`launch recomp ${e.name}: ${record.dir}\\${record.exe ?? '?'}`)
      // PlayOut's pick started the game: confirmed, so UP never asks later (main's confirmExe).
      if (!record.exeChosen) record.exeChosen = 'confirmed'
      if (countStart(record)) offerImages(id)
      if (record.cloud.enabled) {
        record.cloud = { ...record.cloud, syncedAt: now(), pending: false, error: null }
        emitter.emit('recomp:changed', { ids: [id] })
      }
      return { ok: true }
    },
    async getRecompReleases(recompId) {
      requireEntry(recompId)
      await sleep(STEP_MS)
      const newest = newestOf(recompId)
      return clone(releases.get(recompId) ?? []).map((r) => ({
        ...r,
        newest: !!newest && r.tag === newest.tag,
        pins: !!r.asset && pinOf(recompId, r.tag) !== null
      }))
    },
    async getRecompReadme(recompId) {
      const e = requireEntry(recompId)
      await sleep(STEP_MS)
      return readmeFor(e)
    },
    async pickRecompGameFile(gameId, recompId, needId) {
      const e = requireEntry(recompId)
      const need = e.needs.find((n) => n.id === needId)
      if (!need) throw new Error(`Unknown game file ${needId}`)
      await sleep(DIALOG_MS)
      const path =
        need.accepts === 'folder'
          ? `${DOCUMENTS}\\Games\\${e.game}`
          : need.fileName && need.formats.includes('.rsdk')
            ? `${DOCUMENTS}\\Games\\${e.game}\\${need.fileName}`
            : (libraryFilesFor(gameId)[0] ??
              `${DOCUMENTS}\\Games\\${e.game}${need.formats[0] ?? ''}`)
      return setChoice(gameId, recompId, needId, path, 'picked')
    },
    async setRecompGameFile(gameId, recompId, needId, path) {
      return setChoice(gameId, recompId, needId, path, 'picked')
    },
    async listRecompExecutables(recompId) {
      return executablesView(recompId)
    },
    async setRecompExecutable(recompId, path) {
      return setExecutable(recompId, path)
    },
    async pickRecompExecutable(recompId) {
      const e = requireEntry(recompId)
      requireInstalled(recompId)
      await sleep(DIALOG_MS)
      const name = (e.exe ?? 'Game.exe').split(/[\\/]/).pop()!
      return setExecutable(recompId, `C:\\Users\\Player\\Games\\${e.game}\\${name}`)
    },
    async getRecompSettings() {
      return settingsView()
    },
    async browseRecomps() {
      const day = 24 * 60 * 60 * 1000
      const base = Date.parse('2026-11-14T12:00:00Z')
      const out: RecompBrowseTitle[] = []
      let i = 0
      let newCount = 0
      for (const t of titles.values()) {
        const list: RecompBrowseEntry[] = []
        for (const id of t.entries) {
          const e = entries.get(id)
          if (!e) continue
          const n = i++
          // Made-up dates and stars (the mock catalog has none), so every sort order shows a difference.
          const isNew = n === 0
          if (isNew) newCount++
          list.push({
            id,
            name: e.name,
            repo: e.repo,
            game: e.game,
            author: e.author,
            blurb: e.blurb,
            tags: e.tags,
            stars: e.stars ?? [420, 96, 1310, 870][n % 4]!,
            addedAt: e.addedAt ?? new Date(base - n * 9 * day).toISOString(),
            updatedAt: e.updatedAt ?? new Date(base - ((n * 5) % 17) * day).toISOString(),
            latestTag: e.latestTag,
            downloadBytes: e.downloadBytes,
            recommended: e.recommended,
            archived: e.archived,
            repoUrl: e.repoUrl,
            installed: installed.has(id),
            isNew: isNew && !addedState.has(id),
            favorite: favorites.has(id),
            libraryGameId: addedCardOf(id)?.id ?? null,
            ...(addedState.has(id)
              ? {
                  added: addedState.get(id)!,
                  awaiting: addedState.get(id) === 'queued' || addedState.get(id) === 'suggested',
                  // As main: never scanned by a catalog (Install asks first); 'local' = not sent.
                  unscanned: true,
                  ...(addedState.get(id) === 'local' ? { notSent: 'off' as const } : {})
                }
              : {})
          })
        }
        if (!list.length) continue
        out.push({
          key: t.key,
          game: t.game,
          systemId: t.systemId,
          console: t.console,
          coverUrl: list.map((x) => entries.get(x.id)?.coverUrl).find(Boolean) ?? null,
          entries: list,
          gameIds: [...games.values()].filter((g) => titleKeyFor(g) === t.key).map((g) => g.id)
        })
      }
      return clone({ catalog: catalogStatus, titles: out, newCount })
    },
    async readRecompClipboard() {
      return 'https://github.com/Zelda64Recomp/Zelda64Recomp'
    },
    async checkRecompRepo(url) {
      await sleep(700)
      const text = url.trim()
      if (/gitlab|codeberg/i.test(text))
        return {
          ok: false,
          reason: 'notGithub',
          message: 'That is not a GitHub link. Only GitHub repositories can be added.'
        }
      const m =
        /^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)/.exec(text)
      if (!m)
        return {
          ok: false,
          reason: 'badUrl',
          message:
            'That could not be read as a repository. Paste its address, such as github.com/owner/repo.'
        }
      const repo = `${m[1]}/${m[2]!.replace(/\.git$/i, '')}`
      const id = `github:${repo.toLowerCase()}`
      const listed = [...entries.values()].find((e) => e.repo.toLowerCase() === repo.toLowerCase())
      if (listed)
        return {
          ok: false,
          reason: 'alreadyListed',
          message: `${repo} is in the browser already.`,
          existingId: listed.id
        }
      if (/missing/i.test(repo))
        return {
          ok: false,
          reason: 'notFound',
          message: 'No public repository was found there. It may be private, renamed or removed.'
        }
      if (/nowin/i.test(repo))
        return {
          ok: false,
          reason: 'noWindows',
          message: 'None of that repository’s releases has a Windows download.'
        }
      const name = m[2]!
      return {
        ok: true,
        id,
        repo,
        repoUrl: `https://github.com/${repo}`,
        description: `A native PC port of ${name.replace(/[-_.]+/g, ' ')}.`,
        stars: 1234,
        license: 'MIT',
        archived: /archived/i.test(repo),
        fork: /fork/i.test(repo),
        tag: 'v1.2.0',
        asset: { name: `${name}-v1.2.0-windows-x64.zip`, size: 42 * MB },
        game:
          name
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/[-_.]+/g, ' ')
            .replace(/\b(?:recomp(?:iled)?|decomp|port|pc)\b/gi, '')
            .replace(/\s+/g, ' ')
            .trim() || name,
        consoles: MOCK_ADD_CONSOLES
      }
    },
    async addRecomp(input) {
      await sleep(300)
      const repo = input.id.replace(/^github:/, '')
      if (entries.has(input.id)) throw new Error(`${repo} is in the browser already.`)
      const consoleName = MOCK_ADD_CONSOLES.find((c) => c.id === input.systemId)?.name ?? 'Other'
      const name = repo.split('/')[1] ?? repo
      const e = entry({
        id: input.id,
        name,
        game: input.game,
        systemId: input.systemId,
        console: consoleName,
        blurb: `A native PC port of ${input.game}.`,
        stars: 1234,
        completeness: null,
        addedAt: now(),
        sources: ['user']
      })
      entries.set(e.id, e)
      releases.set(e.id, releasesFor(e))
      const key = `${input.systemId}:${input.game.toLowerCase().replace(/[^a-z0-9]+/g, '')}`
      const title = [...titles.values()].find(
        (t) => t.systemId === input.systemId && t.game.toLowerCase() === input.game.toLowerCase()
      )
      if (title) title.entries.push(e.id)
      else
        titles.set(key, {
          key,
          game: input.game,
          systemId: input.systemId,
          console: consoleName,
          entries: [e.id]
        })
      addedState.set(e.id, 'queued')
      log(`recomp ${e.id} added`)
      changed([e.id])
      // Sent for approval a moment later (main's metadata cloud).
      setTimeout(() => {
        if (!addedState.has(e.id)) return
        addedState.set(e.id, 'suggested')
        changed([e.id])
      }, 2000)
      return { id: e.id, titleKey: titleOfEntry(e.id)?.key ?? key }
    },
    async removeAddedRecomp(recompId, uninstall) {
      if (!addedState.has(recompId)) throw new Error('That recompilation was not added on this PC.')
      await sleep(200)
      if (uninstall && installed.has(recompId)) {
        if (busy(recompId)) throw new Error('It is installing; wait until it finishes.')
        installed.delete(recompId)
        progress.delete(recompId)
      }
      addedState.delete(recompId)
      for (const [key, t] of titles) {
        if (!t.entries.includes(recompId)) continue
        t.entries = t.entries.filter((id) => id !== recompId)
        if (!t.entries.length) titles.delete(key)
      }
      if (!installed.has(recompId)) {
        entries.delete(recompId)
        releases.delete(recompId)
      }
      log(`recomp ${recompId} removed from the browser`)
      changed([recompId])
    },
    async setRecompFavorite(recompId, favorite) {
      if (favorite) favorites.add(recompId)
      else favorites.delete(recompId)
      const card = addedCardOf(recompId)
      if (card && card.favorite !== favorite) {
        card.favorite = favorite
        emitter.emit('library:changed', { reason: 'update', gameIds: [card.id] })
      }
      changed([recompId])
    },

    async addRecompToLibrary(recompId) {
      const existing = addedCardOf(recompId)
      if (existing) return existing.id
      const e = requireEntry(recompId)
      const title = titleOfEntry(recompId)
      const id = `rom:${e.systemId}:added-${recompId.replace(/[^a-z0-9]+/gi, '-')}`
      games.set(id, {
        id,
        source: 'rom',
        externalId: `Recompilations/added/${recompId}`,
        platformId: e.systemId,
        title: e.name,
        sortTitle: e.name.toLowerCase(),
        installed: false,
        launch: { kind: 'emulator', systemId: e.systemId, romPath: '' },
        tracking: { mode: 'spawned' },
        hidden: false,
        favorite: favorites.has(recompId),
        playtimeMinutes: 0,
        playCount: 0,
        addedAt: now(),
        metadata: {
          description: e.description || e.blurb,
          developers: [e.author],
          recomp: {
            titleKey: title?.key ?? `${e.systemId}:${e.game.toLowerCase()}`,
            count: 1,
            installed: installed.has(recompId) ? [recompId] : [],
            preferred: recompId,
            updatedAt: now()
          }
        },
        media: e.coverUrl ? { cover: e.coverUrl, ...(e.heroUrl ? { hero: e.heroUrl } : {}) } : {},
        metadataStatus: 'done',
        user: {},
        extra: { recompAdded: recompId }
      })
      emitter.emit('library:changed', { reason: 'scan', gameIds: [id] })
      changed([recompId])
      return id
    },

    async refreshRecompCatalog() {
      catalogStatus.refreshing = true
      await sleep(800)
      const at = now()
      catalogStatus.fetchedAt = { 'decomp-buddy': at, recomplauncher: at }
      catalogStatus.offline = []
      catalogStatus.refreshing = false
      changed([])
      return clone(catalogStatus)
    },
    async setRecompAutoUpdate(recompId, on) {
      requireInstalled(recompId).autoUpdate = on
      emitter.emit('recomp:changed', { ids: [recompId] })
    },
    async setRecompSavePaths(recompId, paths) {
      const record = requireInstalled(recompId)
      if (paths === null) {
        const e = requireEntry(recompId)
        record.savePaths = [...e.savePaths]
        record.saveSource = e.savePaths.length ? 'catalog' : null
      } else {
        record.savePaths = [...new Set(paths)]
        record.saveSource = 'user'
      }
      record.saveSuggestions = (record.saveSuggestions ?? []).filter(
        (t) =>
          !record.savePaths.some(
            (p) => expandTemplate(p, record.dir) === expandTemplate(t, record.dir)
          )
      )
      emitter.emit('recomp:changed', { ids: [recompId] })
      return [...record.savePaths]
    },
    async addRecompSaveFolder(recompId, path) {
      const record = requireInstalled(recompId)
      if (!path) await sleep(DIALOG_MS)
      const folder = path ?? saveFolderPick(record)
      if (/^[a-z]:\\(users\\[^\\]+(\\(appdata(\\(roaming|local))?|documents))?)?$/i.test(folder))
        throw new Error('That folder is too broad to copy (pick the game’s own save folder).')
      const resolved = resolvedSaves(record)
      if (!resolved.includes(folder)) record.savePaths = [...resolved, folder]
      record.saveSource = 'user'
      record.saveSuggestions = (record.saveSuggestions ?? []).filter(
        (t) => expandTemplate(t, record.dir) !== folder
      )
      emitter.emit('recomp:changed', { ids: [recompId] })
      return [...record.savePaths]
    },
    async getRecompSaves(recompId) {
      return savesOf(requireInstalled(recompId))
    },
    async findRecompSaveFolders(recompId) {
      const record = requireInstalled(recompId)
      await sleep(STEP_MS * 2)
      const name = entries.get(recompId)!.name.replace(/[^\w ]+/g, '')
      if (!record.savePaths.length) {
        // One folder found while none was known: it is used.
        record.savePaths = [`%LOCALAPPDATA%\\${name}`]
        record.saveSource = 'detected'
        record.saveSuggestions = []
      } else {
        record.saveSuggestions = [`{documents}\\My Games\\${name}`]
      }
      emitter.emit('recomp:changed', { ids: [recompId] })
      return savesOf(record)
    },
    async setRecompCloud(recompId, enabled) {
      const record = requireInstalled(recompId)
      record.cloud = { ...record.cloud, enabled, error: null, pending: false }
      if (enabled && !record.cloud.conflict) record.cloud.syncedAt = now()
      emitter.emit('recomp:changed', { ids: [recompId] })
    },
    async syncRecompSaves(recompId) {
      const record = requireInstalled(recompId)
      await sleep(STEP_MS * 2)
      if (record.cloud.conflict) return clone(record.cloud)
      record.cloud = {
        ...record.cloud,
        syncedAt: now(),
        syncedHash: 'h2',
        localHash: 'h2',
        pending: false,
        error: null
      }
      emitter.emit('recomp:changed', { ids: [recompId] })
      return clone(record.cloud)
    },
    async resolveRecompConflict(recompId, keep) {
      const record = requireInstalled(recompId)
      // As main: Start fresh only answers "the saves are gone".
      if (keep === 'fresh' && !record.cloud.conflict?.gone)
        throw new Error('The saves came back meanwhile. Choose again.')
      record.cloud = {
        ...record.cloud,
        conflict: null,
        syncedAt: now(),
        syncedHash: `h-${keep}`,
        localHash: `h-${keep}`,
        pending: false,
        error: null
      }
      log(`recomp ${recompId}: kept the ${keep} saves`)
      emitter.emit('recomp:changed', { ids: [recompId] })
      return clone(record.cloud)
    },
    async getRecompImageOffers() {
      return pendingOffers()
    },
    async answerRecompImageOffer(key, answer) {
      const o = imageOffers.get(key)
      if (!o || o.state !== 'pending')
        return { ok: false, message: 'That question was already answered.' }
      const name = o.image ? fileNameOf(o.image) : 'the unpacked game folder'
      const u = o.folder ? unpacked.get(o.recompId) : undefined
      // An item is remembered as kept only when the question showed it (as main does): a question showing the folder
      // alone gives its image part back (asked again later).
      const sawImage = !!o.image && !!offerView(key)?.fileName
      if (answer === 'keep') {
        if (o.image && !sawImage && offerView(key)?.folder) imageOffers.delete(key)
        else o.state = 'kept'
        if (u && u.state === 'unpacked') u.state = 'kept'
        emitOffers()
        return { ok: true, message: `Kept ${o.image ? name : o.folder}` }
      }
      const wantImage = answer === 'delete' || answer === 'delete-both'
      const wantFolder = answer === 'delete-folder' || answer === 'delete-both'
      if (wantFolder && !o.folder)
        return { ok: false, message: 'Nothing was deleted: this question offers no game folder.' }
      if (wantImage && !o.image)
        return { ok: false, message: 'Nothing was deleted: this question offers no disc image.' }
      const game = games.get(o.gameId)
      if (wantImage && (!game || game.romRemoved || game.romPath !== o.image)) {
        if (!o.folder) imageOffers.delete(key)
        emitOffers()
        return { ok: false, message: `${name} is no longer in your library.` }
      }
      // Asked a while ago: what holds now decides (main's offerStale and folderOf).
      const e = entries.get(o.recompId)
      if (wantImage) {
        const why =
          !installed.has(o.recompId) || !e
            ? 'the recompilation is no longer installed'
            : stillSetup(o.recompId)
              ? `${e.name} still installs from it`
              : imageNeeded(e, game!)
        if (why) {
          if (!o.folder) imageOffers.delete(key)
          emitOffers()
          return { ok: false, message: `Nothing was deleted: ${name} must stay (${why}).` }
        }
      }
      const f = wantFolder ? folderOf(o.recompId) : null
      if (wantFolder && (!f || f.folder.toLowerCase() !== o.folder!.toLowerCase())) {
        emitOffers()
        return {
          ok: false,
          message: `Nothing was deleted: ${o.folder} must stay (the game is installed around it and reads its game data from it).`
        }
      }
      await sleep(DIALOG_MS)
      // Moved aside (main's holdForTest), not to the Recycle Bin: the recompilation is started to check it first.
      const moved: string[] = []
      const holdId = `${Date.now().toString(36)}-${(heldSeq++).toString(16).padStart(6, '0')}`
      const record: MockHeld = {
        holdId,
        recompId: o.recompId,
        gameId: o.gameId,
        offerKey: key,
        image: null,
        folder: null,
        at: now(),
        state: 'testing',
        reason: null,
        decidedAt: null
      }
      if (wantFolder && u) {
        u.state = 'deleted'
        record.folder = o.folder!
        moved.push(o.folder!)
        log(`recomp ${o.recompId}: ${o.folder} moved aside`)
      }
      if (wantImage && game) {
        record.image = o.image!
        record.before = {
          romPath: o.image!,
          ...(game.launch.kind === 'emulator' ? { launchRomPath: game.launch.romPath } : {}),
          ...(game.installSize !== undefined ? { installSize: game.installSize } : {})
        }
        game.romRemoved = { at: now(), recompId: o.recompId, romPath: o.image! }
        delete game.romPath
        delete game.installSize
        if (game.launch.kind === 'emulator') game.launch = { ...game.launch, romPath: '' }
        moved.unshift(name)
        log(`recomp ${o.recompId}: ${o.image} moved aside`)
        emitter.emit('library:changed', { reason: 'update', gameIds: [game.id] })
      }
      held.set(holdId, record)
      // The item a delete left out is remembered as kept (as main does).
      if (answer === 'delete-folder' && o.image && !sawImage) imageOffers.delete(key)
      else o.state = answer === 'delete-folder' && o.image ? 'kept' : 'deleted'
      if (answer === 'delete' && u && u.state === 'unpacked') u.state = 'kept'
      emitOffers()
      changed([o.recompId])
      void runHeldTest(holdId)
      return {
        ok: true,
        message: `Moved ${moved.join(' and ')} aside. Starting ${e?.name ?? 'the recompilation'} to check it runs without it; it goes to the Recycle Bin once you close the game and it ran fine.`
      }
    },
    async getRecompHeldImages() {
      return heldList()
    },
    async answerRecompHeldImage(holdId, answer) {
      return answerHeld(holdId, answer)
    },
    async askRecompImageDelete(gameId, recompId) {
      const game = games.get(gameId)
      if (!game) throw new Error('Unknown game')
      const e = requireEntry(recompId)
      requireInstalled(recompId)
      const f = folderOf(recompId)
      let image: string | null = null
      let imageWhy = 'This game has no disc image on this PC.'
      if (game.romPath && !game.romRemoved) {
        const why = stillSetup(recompId) ? `${e.name} still installs from it` : imageNeeded(e, game)
        if (why) imageWhy = `${fileNameOf(game.romPath)} must stay: ${why}.`
        else image = game.romPath
      }
      if (!image && !f) throw new Error(imageWhy)
      const key = image ? imageKey(recompId, image) : folderKey(recompId, f!.folder)
      imageOffers.set(key, {
        state: 'pending',
        recompId,
        gameId,
        image,
        ...(f ? { folder: f.folder } : {}),
        at: now()
      })
      emitOffers()
      return offerView(key)!
    },
    async openRecompFolder(recompId, which) {
      const record = requireInstalled(recompId)
      const path =
        which === 'install'
          ? record.dir
          : which === 'copies'
            ? copiesOf(recompId)
            : (resolvedSaves(record)[0] ?? record.dir)
      log(`openRecompFolder(${which}): ${path}`)
    }
  }

  return {
    api,
    recompForGame(game) {
      const key = titleKeyFor(game)
      const title = key ? titles.get(key) : undefined
      return title && key
        ? {
            titleKey: key,
            count: title.entries.length,
            installed: title.entries.filter((id) => installed.has(id)),
            preferred: preferredOf(title),
            updatedAt: now()
          }
        : null
    }
  }
}
