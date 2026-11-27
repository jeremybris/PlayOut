// The sample library behind the mock API: 33 games across every source PlayOut supports, with real Steam CDN art and
// realistic metadata. Everything is relative to MOCK_BASE_DATE so screenshots are reproducible.
import { withMetadataEdit } from '@shared/metadata-edit'
import { PC_PLATFORM, STORE_PLATFORMS } from '@shared/platforms'
import type {
  ClientInfo,
  DifficultyLevel,
  Game,
  GameMedia,
  GameMetadata,
  GameUserData,
  LaunchSpec,
  Platform,
  SourceId,
  TrackingSpec
} from '@shared/types'
import { steamArt, steamStoreUrl } from './art'
import { systemPlatforms } from './systems'

/** Fixed "now" for the sample data (play dates, metadata timestamps); the live clock is only used for new events. */
export const MOCK_BASE_DATE = '2026-10-28T19:30:00.000Z'
const BASE_MS = Date.parse(MOCK_BASE_DATE)

/** ISO timestamp `days` days (fractions allowed) before the base date. */
export function daysAgo(days: number): string {
  return new Date(BASE_MS - Math.round(days * 86_400_000)).toISOString()
}

/** Mirror of src/main/util/text.ts sortTitle (the renderer cannot import main-process code). */
export function sortTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/^(the|a|an)\s+/i, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The mock's own Emulation folder (Settings › Library › Emulation Folder on Default), in its settings folder as main's is. */
export const MOCK_EMULATION_DIR = 'C:\\Users\\Player\\AppData\\Roaming\\PlayOut\\Emulation'
/** The ROM folder: as in main, the Emulation folder's roms folder, so the seeded ROM games are in it. */
export const ROMS_ROOT = `${MOCK_EMULATION_DIR}\\roms`
export const ESDE_HOME = 'C:\\Users\\Player\\ES-DE'

/** Metroid Dread needs Ryujinx, which the mock machine does not have: launching it yields the emulator-missing error. */
export const EMULATOR_MISSING_GAME_ID = 'rom:switch:J0ObT-tclQ1dxnSu'

export const SOURCE_NAMES: Record<SourceId, string> = {
  steam: 'Steam',
  epic: 'Epic Games',
  gog: 'GOG',
  ea: 'EA App',
  battlenet: 'Battle.net',
  ubisoft: 'Ubisoft Connect',
  xbox: 'Xbox',
  manual: 'PC games',
  rom: 'ROMs'
}

/** Store clients found on the mock machine. Ubisoft Connect was uninstalled, which is why its game is marked not installed. */
export const DETECTED_CLIENTS: Record<SourceId, ClientInfo> = {
  steam: { installed: true, path: 'C:\\Program Files (x86)\\Steam\\steam.exe' },
  epic: {
    installed: true,
    path: 'C:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe',
    version: '18.6.0'
  },
  gog: {
    installed: true,
    path: 'C:\\Program Files (x86)\\GOG Galaxy\\GalaxyClient.exe',
    version: '2.0.80'
  },
  ea: {
    installed: true,
    path: 'C:\\Program Files\\Electronic Arts\\EA Desktop\\EA Desktop\\EADesktop.exe',
    version: '13.428.0.5'
  },
  battlenet: {
    installed: true,
    path: 'C:\\Program Files (x86)\\Battle.net\\Battle.net.exe',
    version: '2.42.0'
  },
  ubisoft: { installed: false },
  xbox: {
    installed: true,
    path: 'C:\\Program Files\\WindowsApps\\Microsoft.GamingApp_2510.1001.6.0_x64__8wekyb3d8bbwe',
    version: '2510.1001.6.0'
  },
  manual: { installed: true },
  rom: { installed: true }
}

/** No store client at all: the `screen=empty` state. */
export const NO_CLIENTS: Record<SourceId, ClientInfo> = {
  steam: { installed: false },
  epic: { installed: false },
  gog: { installed: false },
  ea: { installed: false },
  battlenet: { installed: false },
  ubisoft: { installed: false },
  xbox: { installed: false },
  manual: { installed: true },
  rom: { installed: true }
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

interface MetaInput {
  desc: string
  short: string
  released: string
  dev: string[]
  pub: string[]
  genres: string[]
  /** LaunchBox genres (shown instead of `genres` for a ROM game). */
  lb?: string[]
  tags?: string[]
  rating?: number
  players?: string
  /** HowLongToBeat hours: main, main + extras, completionist. */
  hltb?: [number, number, number]
  /** unlocked, total */
  ach?: [number, number]
  currentPlayers?: number
  /** All-time peak (SteamCharts); 0 = not tracked there. */
  peakPlayers?: number
  store?: string
  website?: string
  sources?: Record<string, string>
}

function meta(m: MetaInput): GameMetadata {
  const result: GameMetadata = {
    description: m.desc,
    shortDescription: m.short,
    releaseDate: m.released,
    developers: m.dev,
    publishers: m.pub,
    genres: m.genres,
    updatedAt: daysAgo(3)
  }
  if (m.lb) result.launchboxGenres = { genres: m.lb, launchboxId: 2, updatedAt: daysAgo(3) }
  if (m.tags) {
    result.tags = m.tags
    // Steam's player tags: the mock's tags after the genres (Steam lists genres among its tags too).
    result.steamTags = {
      tags: [...m.genres, ...m.tags],
      updatedAt: daysAgo(3),
      // Steam's controller support (the game page's controls badge): the action games play with a pad, the action
      // shooters fully with mouse and keyboard too (Full Controller Support + Mouse & Keyboard), the card games by touch.
      controls: {
        controller: m.genres.includes('Action') ? 'full' : null,
        vr: null,
        ...(m.genres.includes('Action') && m.genres.includes('Shooter')
          ? { keyboard: 'full' as const }
          : {}),
        ...(m.genres.includes('Card Game') ? { touch: 'supported' as const } : {})
      },
      // Steam Workshop (the game page's Workshop link): the card games have none, so their square is empty. The
      // metroidvanias were read before the Workshop flag (not known): their page asks the mock, and the square appears.
      ...(m.genres.includes('Metroidvania') ? {} : { workshop: !m.genres.includes('Card Game') })
    }
  }
  if (m.rating !== undefined) {
    result.rating = m.rating
    // An IGDB user rating near the rating.
    result.reviewScore = {
      source: 'steam',
      score: Math.round(m.rating),
      count: 2400,
      label: 'Very Positive',
      steamAppId: 1,
      updatedAt: daysAgo(3)
    }
  }
  if (m.players) {
    result.players = m.players
    // LaunchBox's MaxPlayers: the top of the mock's range ("1-4" -> 4).
    const max = Number.parseInt(m.players.split('-').pop() ?? '', 10)
    if (max > 0) result.localPlayers = { max, launchboxId: 1, updatedAt: daysAgo(3) }
    // A Nucleus Co-op handler for every multiplayer game of the mock (the Co-Op badge and button).
    if (max >= 2)
      result.coop = {
        archive: 'handler-mock-v1.nc',
        gameName: m.dev[0] ?? 'Mock game',
        maxPlayers: max,
        keyboard: true,
        matchedBy: 'exe',
        updatedAt: daysAgo(3)
      }
  }
  if (m.hltb)
    result.hltb = {
      main: m.hltb[0],
      extra: m.hltb[1],
      completionist: m.hltb[2],
      updatedAt: daysAgo(3)
    }
  if (m.ach) result.achievements = { unlocked: m.ach[0], total: m.ach[1], updatedAt: daysAgo(0.1) }
  if (m.currentPlayers !== undefined)
    result.currentPlayers = { count: m.currentPlayers, updatedAt: MOCK_BASE_DATE }
  if (m.peakPlayers !== undefined)
    result.peakPlayers = { count: m.peakPlayers, updatedAt: MOCK_BASE_DATE }
  if (m.store || m.website) result.links = { store: m.store, website: m.website }
  if (m.sources) result.sources = m.sources
  return result
}

interface Seed {
  /** Explicit id for ROM games (`rom:${systemId}:${hash}`); store games derive `${source}:${externalId}`. */
  id?: string
  source: SourceId
  externalId: string
  platformId: string
  title: string
  launch: LaunchSpec
  tracking: TrackingSpec
  installDir?: string
  exePath?: string
  romPath?: string
  installed?: boolean
  hidden?: boolean
  favorite?: boolean
  /** Minutes tracked by PlayOut. */
  playtime: number
  storePlaytime?: number
  /** Days before the base date; omitted = never played. */
  lastPlayed?: number
  playCount: number
  /** Days before the base date. */
  added: number
  metadata: GameMetadata
  media: GameMedia
  metadataStatus?: Game['metadataStatus']
  user?: GameUserData
  extra?: Game['extra']
}

/**
 * The user's Difficulty picks (the Edit sheet's, saved as `user.metadataEdits.difficulty` like any edit) for some
 * sample games, so Filters > Difficulty has every level. The rest have no pick, so they are Medium (no Medium picks:
 * the default covers it, and a game without a local edit is what the edit tests start from).
 */
// Hollow Knight has no pick: its Souls-like tag makes it Hard. Elden Ring's pick beats its Souls-like tag.
const MOCK_DIFFICULTY: Record<string, DifficultyLevel> = {
  'Stardew Valley': 'story',
  'Disco Elysium: The Final Cut': 'story',
  'It Takes Two': 'easy',
  'Portal 2': 'easy',
  'Forza Horizon 5': 'easy',
  'Slay the Spire': 'hard',
  'Dead Cells': 'hard',
  Celeste: 'impossible',
  'Elden Ring': 'impossible',
  'Metal Slug': 'impossible'
}

/**
 * Review scores for some sample games below the 80s and 90s most have, so every band of Filters > Reviews has a game (the
 * mock's scores otherwise follow its ratings).
 */
const MOCK_REVIEW_SCORES: Record<string, number> = {
  'Destroy All Humans!': 64,
  'Diablo IV': 52,
  'Helldivers 2': 72,
  'Overwatch 2': 24
}

export function buildGame(seed: Seed): Game {
  const game: Game = {
    id: seed.id ?? `${seed.source}:${seed.externalId}`,
    source: seed.source,
    externalId: seed.externalId,
    platformId: seed.platformId,
    title: seed.title,
    sortTitle: sortTitle(seed.title),
    installed: seed.installed ?? true,
    launch: seed.launch,
    tracking: seed.tracking,
    hidden: seed.hidden ?? false,
    favorite: seed.favorite ?? false,
    playtimeMinutes: seed.playtime,
    playCount: seed.playCount,
    addedAt: daysAgo(seed.added),
    metadata: seed.metadata,
    media: seed.media,
    metadataStatus: seed.metadataStatus ?? 'done',
    user: seed.user ?? {}
  }
  if (seed.installDir) game.installDir = seed.installDir
  if (seed.exePath) game.exePath = seed.exePath
  if (seed.romPath) game.romPath = seed.romPath
  if (seed.storePlaytime !== undefined) game.storePlaytimeMinutes = seed.storePlaytime
  if (seed.lastPlayed !== undefined) game.lastPlayed = daysAgo(seed.lastPlayed)
  if (seed.extra) game.extra = seed.extra
  const review = MOCK_REVIEW_SCORES[seed.title]
  if (review !== undefined && game.metadata.reviewScore)
    game.metadata = {
      ...game.metadata,
      reviewScore: { ...game.metadata.reviewScore, score: review }
    }
  const level = MOCK_DIFFICULTY[seed.title]
  if (level && game.user.metadataEdits?.difficulty === undefined)
    game.user = withMetadataEdit(game.user, { difficulty: level })
  return game
}

const STEAM_COMMON = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\'

interface SteamSeed {
  appId: number
  title: string
  folder: string
  playtime: number
  storePlaytime: number
  lastPlayed?: number
  playCount: number
  added: number
  favorite?: boolean
  hidden?: boolean
  installed?: boolean
  meta: Omit<MetaInput, 'store' | 'sources'> & { sgdb: string; hltbId: string }
  screenshots: string[]
}

function steam(s: SteamSeed): Seed {
  const installDir = STEAM_COMMON + s.folder
  const { sgdb, hltbId, ...m } = s.meta
  return {
    source: 'steam',
    externalId: String(s.appId),
    platformId: 'steam',
    title: s.title,
    installDir,
    launch: { kind: 'uri', uri: `steam://rungameid/${s.appId}` },
    tracking: { mode: 'installDir', installDir },
    playtime: s.playtime,
    storePlaytime: s.storePlaytime,
    lastPlayed: s.lastPlayed,
    playCount: s.playCount,
    added: s.added,
    favorite: s.favorite,
    hidden: s.hidden,
    installed: s.installed,
    metadata: meta({
      ...m,
      store: steamStoreUrl(s.appId),
      sources: { steam: String(s.appId), steamgriddb: sgdb, hltb: hltbId }
    }),
    media: steamArt(s.appId, s.screenshots),
    extra: { appid: s.appId }
  }
}

interface RomSeed {
  hash: string
  systemId: string
  /** Path relative to the ROM root, forward slashes (this is `externalId`). */
  relativePath: string
  title: string
  tags: string[]
  playtime: number
  lastPlayed?: number
  playCount: number
  favorite?: boolean
  meta: MetaInput
  media: GameMedia
}

function rom(r: RomSeed): Seed {
  const romPath = `${ROMS_ROOT}\\${r.relativePath.replace(/\//g, '\\')}`
  return {
    // Same scheme as src/main/util/ids.ts makeGameId: first 16 chars of the base64url SHA-1 of the relative path.
    id: `rom:${r.systemId}:${r.hash}`,
    source: 'rom',
    externalId: r.relativePath,
    platformId: r.systemId,
    title: r.title,
    romPath,
    launch: { kind: 'emulator', systemId: r.systemId, romPath },
    tracking: { mode: 'spawned' },
    playtime: r.playtime,
    lastPlayed: r.lastPlayed,
    playCount: r.playCount,
    added: 90,
    favorite: r.favorite,
    metadata: meta(r.meta),
    media: r.media,
    extra: r.tags.length ? { tags: r.tags.join(', ') } : undefined
  }
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

const STEAM_GAMES: Seed[] = [
  steam({
    appId: 1145360,
    title: 'Hades',
    folder: 'Hades',
    playtime: 1240,
    storePlaytime: 3180,
    lastPlayed: 0.4,
    playCount: 38,
    added: 180,
    favorite: true,
    meta: {
      desc: 'Defy the god of the dead as Zagreus, the immortal prince of the Underworld, and fight your way out of a realm that rearranges itself every time you die. Each escape attempt weaves Olympian boons into a new build, and every death sends you home to a cast that remembers what you did.',
      short: 'Rogue-like dungeon crawler where every failed escape tells more of the story.',
      released: '2020-09-17',
      dev: ['Supergiant Games'],
      pub: ['Supergiant Games'],
      genres: ['Action', 'Roguelike', 'RPG'],
      tags: ['Indie', 'Hack and Slash', 'Mythology'],
      rating: 93,
      players: '1',
      hltb: [22.5, 47.5, 96],
      ach: [31, 49],
      currentPlayers: 2957,
      peakPlayers: 37209,
      website: 'https://www.supergiantgames.com/games/hades/',
      sgdb: '5248',
      hltbId: '72276'
    },
    screenshots: [
      'c0fed447426b69981cf1721756acf75369801b31',
      '8a9f0953e8a014bd3df2789c2835cb787cd3764d'
    ]
  }),
  steam({
    appId: 620,
    title: 'Portal 2',
    folder: 'Portal 2',
    playtime: 310,
    storePlaytime: 1108,
    lastPlayed: 15,
    playCount: 9,
    added: 400,
    meta: {
      desc: 'Return to Aperture Science long after the first game, with a portal gun, a sardonic AI and a crumbling facility to think your way through. The co-op campaign puts two players, and two sets of portals, into test chambers built for teamwork.',
      short: 'Puzzle-platformer sequel with a full story campaign and two-player co-op.',
      released: '2011-04-18',
      dev: ['Valve'],
      pub: ['Valve'],
      genres: ['Puzzle', 'Adventure', 'Action'],
      tags: ['First-Person', 'Co-op', 'Comedy'],
      rating: 95,
      players: '1-2',
      hltb: [8.5, 12.5, 20.5],
      ach: [44, 51],
      currentPlayers: 1755,
      peakPlayers: 587150,
      website: 'http://www.thinkwithportals.com/',
      sgdb: '5240',
      hltbId: '7231'
    },
    screenshots: [
      'f3f6787d74739d3b2ec8a484b5c994b3d31ef325',
      '6a4f5afdaa98402de9cf0b59fed27bab3256a6f4'
    ]
  }),
  steam({
    appId: 367520,
    title: 'Hollow Knight',
    folder: 'Hollow Knight',
    playtime: 2050,
    storePlaytime: 2740,
    lastPlayed: 11,
    playCount: 27,
    added: 520,
    meta: {
      desc: 'Descend into Hallownest, a vast hand-drawn kingdom of insects and ruins, as a silent knight armed with a nail. Explore interlocking caverns, collect charms that reshape your abilities and uncover the sealed history of the kingdom at your own pace.',
      short: 'Hand-drawn Metroidvania set in a fallen kingdom of insects.',
      released: '2017-02-24',
      dev: ['Team Cherry'],
      pub: ['Team Cherry'],
      genres: ['Metroidvania', 'Action', 'Adventure'],
      tags: ['Indie', 'Souls-like', 'Atmospheric'],
      rating: 87,
      players: '1',
      hltb: [27, 41, 63],
      ach: [29, 63],
      currentPlayers: 6204,
      peakPlayers: 458709,
      website: 'http://hollowknight.com',
      sgdb: '5237',
      hltbId: '26286'
    },
    screenshots: [
      '5384f9f8b96a0b9934b2bc35a4058376211636d2',
      'd5b6edd94e77ba6db31c44d8a3c09d807ab27751'
    ]
  }),
  steam({
    appId: 504230,
    title: 'Celeste',
    folder: 'Celeste',
    playtime: 640,
    storePlaytime: 910,
    lastPlayed: 7,
    playCount: 21,
    added: 600,
    meta: {
      desc: 'Help Madeline climb Celeste Mountain in a precise but forgiving platformer where every screen is a self-contained puzzle of dashes and wall-jumps. Assist mode lets you tune the challenge, and the B-sides are waiting when you want more.',
      short: 'Tight pixel-art platformer about climbing a mountain and facing yourself.',
      released: '2018-01-25',
      dev: ['Maddy Makes Games', 'Extremely OK Games'],
      pub: ['Maddy Makes Games'],
      genres: ['Platformer', 'Action', 'Adventure'],
      tags: ['Indie', 'Pixel Graphics', 'Difficult'],
      rating: 88,
      players: '1',
      hltb: [8, 12.5, 39],
      ach: [18, 32],
      currentPlayers: 1874,
      peakPlayers: 31470,
      website: 'http://www.celestegame.com',
      sgdb: '5233',
      hltbId: '42826'
    },
    screenshots: [
      '1ad297c2044cdcf450ee83e56350cafb590da755',
      '03bfe6bd5ddac7f747c8d2aa1a4f82cfd53c6dcb'
    ]
  }),
  steam({
    appId: 413150,
    title: 'Stardew Valley',
    folder: 'Stardew Valley',
    playtime: 4820,
    storePlaytime: 9620,
    lastPlayed: 3,
    playCount: 94,
    added: 900,
    favorite: true,
    meta: {
      desc: "Inherit your grandfather's run-down farm and build a new life in Pelican Town: grow crops, raise animals, fish, mine, befriend the villagers and maybe start a family. The seasons turn, the valley grows with you, and up to eight players can farm together.",
      short: 'Open-ended farming and life sim in a small town with a lot of heart.',
      released: '2016-02-26',
      dev: ['ConcernedApe'],
      pub: ['ConcernedApe'],
      genres: ['Simulation', 'RPG', 'Farming'],
      tags: ['Indie', 'Relaxing', 'Co-op'],
      rating: 89,
      players: '1-8',
      hltb: [53, 97, 159],
      ach: [22, 49],
      currentPlayers: 37901,
      peakPlayers: 875343,
      website: 'http://www.stardewvalley.net',
      sgdb: '5218',
      hltbId: '22615'
    },
    screenshots: [
      'b887651a93b0525739049eb4194f633de2df75be',
      '9ac899fe2cda15d48b0549bba77ef8c4a090a71c'
    ]
  }),
  steam({
    appId: 1245620,
    title: 'Elden Ring',
    folder: 'ELDEN RING',
    playtime: 3900,
    storePlaytime: 6150,
    lastPlayed: 2,
    playCount: 41,
    added: 300,
    favorite: true,
    meta: {
      desc: "Rise, Tarnished, and travel the Lands Between in FromSoftware's open-world take on its demanding action RPG formula. Ride between ruined castles and golden fields, pick your battles, and claim the shattered Elden Ring from demigods who will not hand it over.",
      short: 'Open-world action RPG with punishing bosses and the freedom to go anywhere.',
      released: '2022-02-25',
      dev: ['FromSoftware'],
      pub: ['FromSoftware', 'Bandai Namco Entertainment'],
      genres: ['Action', 'RPG', 'Open World'],
      tags: ['Souls-like', 'Dark Fantasy', 'Co-op'],
      rating: 94,
      players: '1-4',
      hltb: [60, 104, 135],
      ach: [17, 42],
      currentPlayers: 20841,
      peakPlayers: 953426,
      website: 'https://en.bandainamcoent.eu/elden-ring/elden-ring',
      sgdb: '5247094',
      hltbId: '68151'
    },
    screenshots: [
      '943bf6fe62352757d9070c1d33e50b92fe8539f1',
      'dcdac9e4b26ac0ee5248bfd2967d764fd00cdb42'
    ]
  }),
  steam({
    appId: 1091500,
    title: 'Cyberpunk 2077',
    folder: 'Cyberpunk 2077',
    playtime: 2610,
    storePlaytime: 4330,
    lastPlayed: 6,
    playCount: 33,
    added: 450,
    meta: {
      desc: 'Become V, a mercenary in Night City, a megalopolis obsessed with power, glamour and body modification. Build your character around netrunning, blades or guns, and shape the story of a city that chews people up through the choices you make.',
      short: 'First-person open-world RPG set in the neon sprawl of Night City.',
      released: '2020-12-10',
      dev: ['CD PROJEKT RED'],
      pub: ['CD PROJEKT RED'],
      genres: ['RPG', 'Open World', 'Sci-fi'],
      tags: ['Cyberpunk', 'First-Person', 'Story Rich'],
      rating: 86,
      players: '1',
      hltb: [26, 62, 104],
      ach: [25, 57],
      currentPlayers: 136228,
      peakPlayers: 472962,
      website: 'https://www.cyberpunk.net',
      sgdb: '5236',
      hltbId: '2127'
    },
    screenshots: [
      '2f649b68d579bf87011487d29bc4ccbfdd97d34f',
      '+900f9bda156599fcd235f08ffb64667f9baa1afe'
    ]
  }),
  steam({
    appId: 1030300,
    title: 'Hollow Knight: Silksong',
    folder: 'Hollow Knight Silksong',
    playtime: 870,
    storePlaytime: 1030,
    lastPlayed: 1,
    playCount: 12,
    added: 54,
    meta: {
      desc: 'Play as Hornet, princess-protector of Hallownest, captured and carried to the kingdom of Pharloom. Climb from its silk-choked depths toward the shining citadel, using needle, thread and acrobatics against more than a hundred and fifty new foes.',
      short: "Hornet's own adventure: faster, higher and crueller than Hallownest.",
      released: '2025-09-04',
      dev: ['Team Cherry'],
      pub: ['Team Cherry'],
      genres: ['Metroidvania', 'Action', 'Adventure'],
      tags: ['Indie', 'Difficult', 'Atmospheric'],
      rating: 90,
      players: '1',
      hltb: [35, 55, 80],
      ach: [9, 52],
      currentPlayers: 5797,
      peakPlayers: 58642,
      website: 'http://hollowknightsilksong.com/',
      sgdb: '5255226',
      hltbId: '70119'
    },
    screenshots: [
      '+26950369fe4b03c2268620eb9815c8a246aa0b06',
      '+09ccaa6c16f158f9df8298feb5d196098506a028'
    ]
  }),
  steam({
    appId: 588650,
    title: 'Dead Cells',
    folder: 'Dead Cells',
    playtime: 1510,
    storePlaytime: 2290,
    lastPlayed: 8,
    playCount: 46,
    added: 700,
    meta: {
      desc: 'A roguelite action-platformer in which a blob of cells pilots a headless body through an island prison that reshuffles with every run. Permanent unlocks, dozens of weapons and no checkpoints: die, learn, and come back faster.',
      short: 'Roguelite action-platformer with fluid combat and no second chances.',
      released: '2018-08-07',
      dev: ['Motion Twin', 'Evil Empire'],
      pub: ['Motion Twin'],
      genres: ['Roguelike', 'Action', 'Metroidvania'],
      tags: ['Indie', 'Pixel Graphics', 'Difficult'],
      rating: 89,
      players: '1',
      hltb: [17, 42, 146],
      ach: [40, 121],
      currentPlayers: 1784,
      peakPlayers: 19821,
      website: 'https://dead-cells.com/',
      sgdb: '5234',
      hltbId: '44262'
    },
    screenshots: [
      'ac28000ade40cc2fe5c128f32ac98ba33c008a7a',
      '7bde51ea6c8f6289e85ea1d8c1c941e1f8bfee91'
    ]
  }),
  steam({
    appId: 646570,
    title: 'Slay the Spire',
    folder: 'SlayTheSpire',
    playtime: 2280,
    storePlaytime: 3875,
    lastPlayed: 16,
    playCount: 71,
    added: 800,
    meta: {
      desc: 'Card games meet roguelikes: pick a character, build a deck from the cards you find, and climb a spire that changes with every attempt. Relics bend the rules, and the best runs come from combinations nobody planned.',
      short: 'The deck-building roguelike that defined the genre.',
      released: '2019-01-23',
      dev: ['Mega Crit'],
      pub: ['Mega Crit'],
      genres: ['Strategy', 'Card Game', 'Roguelike'],
      tags: ['Indie', 'Turn-Based', 'Replay Value'],
      rating: 89,
      players: '1',
      hltb: [25, 70, 244],
      ach: [23, 46],
      currentPlayers: 4694,
      peakPlayers: 247837,
      website: 'https://www.megacrit.com/',
      sgdb: '5231',
      hltbId: '51072'
    },
    screenshots: [
      'c171816f7ecd35b5b46d2fa27532f4c5b8ca3cc5',
      '01aa3e7759e457bfbf2422f31c325d7b3ba8a6eb'
    ]
  }),
  steam({
    appId: 803330,
    title: 'Destroy All Humans!',
    folder: 'Destroy All Humans',
    playtime: 95,
    storePlaytime: 410,
    lastPlayed: 28,
    playCount: 3,
    added: 365,
    meta: {
      desc: "Crypto-137 returns in a faithful remake of the 2005 cult classic: terrorise 1950s America with a flying saucer, a death ray and the infamous anal probe, harvest human brains and keep the Furon empire's DNA supply flowing.",
      short: 'Remake of the 2005 alien-invasion sandbox, now with much nicer explosions.',
      released: '2020-07-28',
      dev: ['Black Forest Games', 'Pandemic Studios'],
      pub: ['THQ Nordic'],
      genres: ['Action', 'Adventure', 'Comedy'],
      tags: ['Third-Person', 'Aliens', 'Remake'],
      rating: 68,
      players: '1',
      hltb: [9, 13, 20],
      ach: [6, 40],
      currentPlayers: 40,
      peakPlayers: 0,
      website: 'https://destroyallhumans.thqnordic.com/',
      sgdb: '5253270',
      hltbId: '73214'
    },
    screenshots: [
      '7da9673923fbe10147ab48c9e2d39e4ce2868c7d',
      '394f931e0d2487158840e77b6093c2510b30453d'
    ]
  }),
  steam({
    appId: 553850,
    title: 'Helldivers 2',
    folder: 'Helldivers 2',
    playtime: 1980,
    storePlaytime: 2560,
    lastPlayed: 1.3,
    playCount: 35,
    added: 240,
    meta: {
      desc: 'Spread Managed Democracy across the galaxy in a four-player co-op shooter where friendly fire is always on and the stratagems you call down are as dangerous to you as to the bugs. A live galactic war decides which planets need you next.',
      short: 'Chaotic four-player co-op shooter in service of Super Earth.',
      released: '2024-02-08',
      dev: ['Arrowhead Game Studios'],
      pub: ['PlayStation Publishing'],
      genres: ['Shooter', 'Co-op', 'Action'],
      tags: ['Third-Person', 'Online Co-op', 'Sci-fi'],
      rating: 82,
      players: '1-4 online',
      hltb: [26, 68, 150],
      ach: [21, 38],
      currentPlayers: 36685,
      peakPlayers: 1063450,
      website: 'https://www.playstation.com/games/helldivers-2/pc/',
      sgdb: '5261398',
      hltbId: '123457'
    },
    screenshots: [
      '+aed08979e15f54798f287dd8820fb5838476b5fa',
      '+71ef7c65fcf63ff974ce42150190c0420c66c72b'
    ]
  }),
  // A tool, not a game: Steam tags it Utilities, so its difficulty is the N/A (Tools) label (shared/difficulty.ts).
  steam({
    appId: 431960,
    title: 'Wallpaper Engine',
    folder: 'wallpaper_engine',
    playtime: 95,
    storePlaytime: 4200,
    lastPlayed: 6,
    playCount: 12,
    added: 320,
    meta: {
      desc: 'Use animated wallpapers on your desktop: pick from the Workshop or make your own scenes, videos and web wallpapers in the built-in editor.',
      short: 'Animated desktop wallpapers with a Workshop and an editor.',
      released: '2018-11-16',
      dev: ['Wallpaper Engine Team'],
      pub: ['Wallpaper Engine Team'],
      genres: ['Casual', 'Indie'],
      tags: ['Utilities', 'Design & Illustration', 'Software'],
      rating: 97,
      players: '1',
      hltb: [10, 20, 40],
      currentPlayers: 71500,
      peakPlayers: 119800,
      sgdb: '',
      hltbId: ''
    },
    screenshots: [
      '5aec3335b1ae2300aa91da990d7e24541ddcf68d',
      '39ed0a9730b67a930acb8ceed221cc968bee7731'
    ]
  })
]

const EPIC_DIR = 'C:\\Program Files\\Epic Games\\'
const GOG_DIR = 'C:\\Program Files (x86)\\GOG Galaxy\\Games\\'
const EA_DIR = 'C:\\Program Files\\EA Games\\'
const BATTLENET_EXE = 'C:\\Program Files (x86)\\Battle.net\\Battle.net.exe'

const STORE_GAMES: Seed[] = [
  {
    source: 'epic',
    externalId: 'Calluna',
    platformId: 'epic',
    title: 'Control',
    installDir: `${EPIC_DIR}Control`,
    launch: { kind: 'uri', uri: 'com.epicgames.launcher://apps/Calluna?action=launch&silent=true' },
    tracking: { mode: 'installDir', installDir: `${EPIC_DIR}Control` },
    playtime: 720,
    lastPlayed: 17,
    playCount: 11,
    added: 340,
    metadata: meta({
      desc: 'Jesse Faden walks into the Federal Bureau of Control looking for her brother and leaves as its Director, armed with a shape-shifting Service Weapon and powers borrowed from the Oldest House itself. The Ultimate Edition includes both expansions.',
      short:
        'Supernatural third-person shooter inside a brutalist building that will not sit still.',
      released: '2019-08-27',
      dev: ['Remedy Entertainment'],
      pub: ['Remedy Entertainment'],
      genres: ['Action', 'Adventure', 'Supernatural'],
      tags: ['Third-Person', 'Story Rich', 'Physics'],
      rating: 85,
      players: '1',
      hltb: [11.5, 18.5, 27],
      ach: [12, 67],
      store: 'https://store.epicgames.com/en-US/p/control',
      website: 'https://controlgame.com',
      sources: { steamgriddb: '5261', igdb: '26192', hltb: '57432' }
    }),
    media: steamArt(870780, [
      '8376498631b089e52fb5c75ffe119e0de5e6aed1',
      '5a16ce565951479e142c56a23f19d88333d84945'
    ]),
    extra: { appName: 'Calluna', namespace: 'calluna', epicNamespace: 'calluna' }
  },
  {
    source: 'epic',
    externalId: 'Sugar',
    platformId: 'epic',
    title: 'Rocket League',
    installDir: `${EPIC_DIR}rocketleague`,
    launch: { kind: 'uri', uri: 'com.epicgames.launcher://apps/Sugar?action=launch&silent=true' },
    tracking: { mode: 'installDir', installDir: `${EPIC_DIR}rocketleague` },
    hidden: true,
    playtime: 2400,
    lastPlayed: 26,
    playCount: 120,
    added: 1200,
    metadata: meta({
      desc: 'Soccer, but the players are rocket-powered cars that can fly. Five-minute matches, ranked ladders and a skill ceiling that keeps climbing a decade on.',
      short: 'Car soccer with boost, aerials and very short matches.',
      released: '2015-07-07',
      dev: ['Psyonix'],
      pub: ['Psyonix'],
      genres: ['Sports', 'Racing', 'Multiplayer'],
      tags: ['Competitive', 'Free to Play', 'Physics'],
      rating: 86,
      players: '1-8 online',
      ach: [40, 88],
      store: 'https://store.epicgames.com/en-US/p/rocket-league',
      website: 'http://www.rocketleague.com/',
      sources: { steamgriddb: '5223', igdb: '11198' }
    }),
    media: steamArt(252950, [
      '+4fa01c320d22f31d78fd9fcb27dbd3bd8871b903',
      '+23e7d4fcf10475923be9078e55b449b7fc9792d9'
    ]),
    extra: { appName: 'Sugar', namespace: 'sugar', epicNamespace: 'sugar' }
  },
  {
    source: 'epic',
    externalId: 'AlanWake2',
    platformId: 'epic',
    title: 'Alan Wake 2',
    installDir: `${EPIC_DIR}Alan Wake 2`,
    launch: {
      kind: 'uri',
      uri: 'com.epicgames.launcher://apps/AlanWake2?action=launch&silent=true'
    },
    tracking: { mode: 'installDir', installDir: `${EPIC_DIR}Alan Wake 2` },
    playtime: 0,
    playCount: 0,
    added: 20,
    // Installed last week; the scrape found nothing, so the UI shows the placeholder cover and no description.
    metadata: {},
    media: {},
    metadataStatus: 'failed',
    extra: { appName: 'AlanWake2', namespace: 'alanwake2', epicNamespace: 'alanwake2' }
  },
  {
    source: 'gog',
    externalId: '1495134320',
    platformId: 'gog',
    title: 'The Witcher 3: Wild Hunt',
    installDir: `${GOG_DIR}The Witcher 3 Wild Hunt GOTY`,
    exePath: `${GOG_DIR}The Witcher 3 Wild Hunt GOTY\\bin\\x64\\witcher3.exe`,
    launch: {
      kind: 'exec',
      file: `${GOG_DIR}The Witcher 3 Wild Hunt GOTY\\bin\\x64\\witcher3.exe`,
      args: [],
      cwd: `${GOG_DIR}The Witcher 3 Wild Hunt GOTY\\bin\\x64`
    },
    tracking: { mode: 'installDir', installDir: `${GOG_DIR}The Witcher 3 Wild Hunt GOTY` },
    playtime: 5400,
    lastPlayed: 20,
    playCount: 48,
    added: 1100,
    metadata: meta({
      desc: 'Geralt of Rivia hunts for Ciri across a war-torn continent in a story-driven open world where every contract has a twist. The Game of the Year edition includes Hearts of Stone and Blood and Wine, which many consider the best part.',
      short: 'Story-heavy open-world RPG about a monster hunter and the people who hire him.',
      released: '2015-05-19',
      dev: ['CD PROJEKT RED'],
      pub: ['CD PROJEKT RED'],
      genres: ['RPG', 'Open World', 'Adventure'],
      tags: ['Story Rich', 'Dark Fantasy', 'Mature'],
      rating: 93,
      players: '1',
      hltb: [51.5, 104, 174],
      ach: [51, 78],
      store: 'https://www.gog.com/game/the_witcher_3_wild_hunt_game_of_the_year_edition',
      website: 'https://www.thewitcher.com/witcher3',
      sources: { gog: '1495134320', steamgriddb: '5239', hltb: '10270' }
    }),
    media: steamArt(292030, [
      '+f7f564ecedd09b3e503b071a637aeefdedbeedd8',
      '+0a38e4d0d57f15934772dbe09b322d08132d5518'
    ]),
    extra: { productId: 1495134320 }
  },
  {
    source: 'gog',
    externalId: '1419400137',
    platformId: 'gog',
    title: 'Disco Elysium: The Final Cut',
    installDir: `${GOG_DIR}Disco Elysium`,
    exePath: `${GOG_DIR}Disco Elysium\\disco.exe`,
    launch: {
      kind: 'exec',
      file: `${GOG_DIR}Disco Elysium\\disco.exe`,
      args: [],
      cwd: `${GOG_DIR}Disco Elysium`
    },
    tracking: { mode: 'installDir', installDir: `${GOG_DIR}Disco Elysium` },
    playtime: 1380,
    lastPlayed: 23,
    playCount: 19,
    added: 640,
    metadata: meta({
      desc: 'Wake up hungover in Revachol with no memory, a murder to solve and a skill system that argues with you inside your own head. There is no combat to speak of; dice rolls, dialogue and the ideologies you adopt decide what kind of detective you become.',
      short: 'Detective RPG where your own skills are the loudest characters.',
      released: '2019-10-15',
      dev: ['ZA/UM'],
      pub: ['ZA/UM'],
      genres: ['RPG', 'Detective', 'Narrative'],
      tags: ['Story Rich', 'Isometric', 'Choices Matter'],
      rating: 97,
      players: '1',
      hltb: [21.5, 31, 45],
      ach: [14, 45],
      store: 'https://www.gog.com/game/disco_elysium',
      website: 'http://www.zaumstudio.com',
      sources: { gog: '1419400137', steamgriddb: '5230', hltb: '41796' }
    }),
    media: steamArt(632470, [
      'b3694e99ffdb686d1bbbbe16a540d3d2ccd509c4',
      '9125a718ee9ba85386ae5d4eb820f3266073fc97'
    ]),
    extra: { productId: 1419400137 }
  },
  {
    source: 'gog',
    externalId: '1456460669',
    platformId: 'gog',
    title: "Baldur's Gate 3",
    installDir: `${GOG_DIR}Baldurs Gate 3`,
    exePath: `${GOG_DIR}Baldurs Gate 3\\bin\\bg3_dx11.exe`,
    launch: {
      kind: 'exec',
      file: `${GOG_DIR}Baldurs Gate 3\\bin\\bg3_dx11.exe`,
      args: [],
      cwd: `${GOG_DIR}Baldurs Gate 3\\bin`
    },
    tracking: { mode: 'installDir', installDir: `${GOG_DIR}Baldurs Gate 3` },
    playtime: 6100,
    lastPlayed: 5,
    playCount: 52,
    added: 420,
    metadata: meta({
      desc: "Gather a party of misfits, each with a tadpole in their skull, and make your way to Baldur's Gate in a turn-based adaptation of Dungeons & Dragons 5th edition. Nearly everything reacts to what you do, including the people you decide to romance.",
      short: 'Enormous turn-based D&D RPG with real consequences for your choices.',
      released: '2023-08-03',
      dev: ['Larian Studios'],
      pub: ['Larian Studios'],
      genres: ['RPG', 'Strategy', 'Adventure'],
      tags: ['Turn-Based', 'Party-Based', 'Co-op'],
      rating: 96,
      players: '1-4',
      hltb: [69, 120, 165],
      ach: [20, 54],
      store: 'https://www.gog.com/game/baldurs_gate_iii',
      website: 'https://baldursgate3.game',
      sources: { gog: '1456460669', steamgriddb: '5259463', hltb: '68033' }
    }),
    media: steamArt(1086940, [
      'c73bc54415178c07fef85f54ee26621728c77504',
      '73d93bea842b93914d966622104dcb8c0f42972b'
    ]),
    extra: { productId: 1456460669 }
  },
  {
    source: 'ea',
    externalId: 'Origin.OFR.50.0003727',
    platformId: 'ea',
    title: 'It Takes Two',
    installDir: `${EA_DIR}It Takes Two`,
    launch: {
      kind: 'uri',
      uri: 'origin2://game/launch?offerIds=Origin.OFR.50.0003727&autoDownload=1'
    },
    tracking: { mode: 'installDir', installDir: `${EA_DIR}It Takes Two` },
    playtime: 760,
    lastPlayed: 12,
    playCount: 9,
    added: 250,
    metadata: meta({
      desc: "Cody and May have been turned into dolls by their daughter's tears, and the only way back is to cooperate. Every chapter hands the two players a different pair of abilities, and the game never repeats itself.",
      short: 'Two-player-only co-op platformer about a couple that has stopped listening.',
      released: '2021-03-26',
      dev: ['Hazelight Studios'],
      pub: ['Electronic Arts'],
      genres: ['Adventure', 'Platformer', 'Co-op'],
      tags: ['Split Screen', 'Story Rich', 'Puzzle'],
      rating: 89,
      players: '2',
      hltb: [12.5, 15, 20],
      ach: [20, 20],
      store: 'https://www.ea.com/games/it-takes-two',
      sources: { steamgriddb: '5253851', igdb: '136276', hltb: '79536' }
    }),
    media: steamArt(1426210, [
      '3e59753eefaba9a7704a18e902b48e8d38e95e0b',
      '6e987a0678b013bfd0073a9ac4703e1f04ca4dea'
    ]),
    extra: { offerId: 'Origin.OFR.50.0003727', contentId: '1008730' }
  },
  {
    source: 'ea',
    externalId: 'Origin.OFR.50.0004195',
    platformId: 'ea',
    title: 'Mass Effect Legendary Edition',
    installDir: `${EA_DIR}Mass Effect Legendary Edition`,
    launch: {
      kind: 'uri',
      uri: 'origin2://game/launch?offerIds=Origin.OFR.50.0004195&autoDownload=1'
    },
    tracking: { mode: 'installDir', installDir: `${EA_DIR}Mass Effect Legendary Edition` },
    playtime: 2900,
    lastPlayed: 25,
    playCount: 31,
    added: 620,
    metadata: meta({
      desc: "Commander Shepard's whole trilogy, remastered: the Reapers, the Normandy and a crew whose fates carry across three games. The first game's combat has been reworked so it no longer feels like a different series.",
      short: 'The complete Mass Effect trilogy with every DLC, remastered.',
      released: '2021-05-14',
      dev: ['BioWare'],
      pub: ['Electronic Arts'],
      genres: ['RPG', 'Shooter', 'Sci-fi'],
      tags: ['Third-Person', 'Story Rich', 'Space'],
      rating: 86,
      players: '1',
      hltb: [78, 118, 170],
      ach: [60, 127],
      store: 'https://www.ea.com/games/mass-effect/mass-effect-legendary-edition',
      sources: { steamgriddb: '5254018', igdb: '144019', hltb: '86130' }
    }),
    media: steamArt(1328670, [
      '3cfdbd8a5d94f9005d33ba17bb6b163dc458ddf7',
      '4e226eb092381ba6c4ea9c164a1d18574c993a8a'
    ]),
    extra: { offerId: 'Origin.OFR.50.0004195', contentId: '1012330' }
  },
  {
    source: 'battlenet',
    externalId: 'Fen',
    platformId: 'battlenet',
    title: 'Diablo IV',
    installDir: 'C:\\Program Files (x86)\\Diablo IV',
    exePath: 'C:\\Program Files (x86)\\Diablo IV\\Diablo IV.exe',
    launch: { kind: 'exec', file: BATTLENET_EXE, args: ['--exec=launch Fen'] },
    tracking: { mode: 'process', processNames: ['Diablo IV'] },
    playtime: 1650,
    lastPlayed: 10,
    playCount: 24,
    added: 330,
    metadata: meta({
      desc: 'Lilith has returned to Sanctuary and the world is darker for it. Five classes, a shared open world, seasonal ladders and a loot grind that only really starts once the campaign ends.',
      short: 'Gothic online action RPG with a shared open world and seasons.',
      released: '2023-06-06',
      dev: ['Blizzard Entertainment'],
      pub: ['Blizzard Entertainment'],
      genres: ['Action RPG', 'Hack and Slash', 'Online'],
      tags: ['Loot', 'Dark Fantasy', 'Co-op'],
      rating: 86,
      players: '1-4 online',
      hltb: [26, 73, 190],
      ach: [11, 45],
      store: 'https://diablo4.blizzard.com/',
      sources: { steamgriddb: '5259291', igdb: '120', hltb: '101421' }
    }),
    media: steamArt(2344520, [
      '+8512b560be0ddef49cb0da366b7d2ddf5df18cab',
      '+24952fc1c8779c9a7a555c01489c76f9814f70a7'
    ]),
    extra: { productCode: 'Fen' }
  },
  {
    source: 'battlenet',
    externalId: 'Pro',
    platformId: 'battlenet',
    title: 'Overwatch 2',
    installDir: 'C:\\Program Files (x86)\\Overwatch',
    exePath: 'C:\\Program Files (x86)\\Overwatch\\_retail_\\Overwatch.exe',
    launch: { kind: 'exec', file: BATTLENET_EXE, args: ['--exec=launch Pro'] },
    tracking: { mode: 'process', processNames: ['Overwatch'] },
    playtime: 3300,
    lastPlayed: 19,
    playCount: 140,
    added: 1000,
    metadata: meta({
      desc: "Blizzard's team shooter in its free-to-play 5v5 form: a roster of heroes with wildly different kits, objective modes built around pushing and holding, and a competitive scene that still argues about every balance patch.",
      short: 'Free-to-play 5v5 hero shooter.',
      released: '2022-10-04',
      dev: ['Blizzard Entertainment'],
      pub: ['Blizzard Entertainment'],
      genres: ['Shooter', 'Hero Shooter', 'Multiplayer'],
      tags: ['Competitive', 'Free to Play', 'Team-Based'],
      rating: 79,
      players: '5v5 online',
      ach: [33, 164],
      store: 'https://overwatch.blizzard.com/',
      sources: { steamgriddb: '5259319', igdb: '160062' }
    }),
    media: steamArt(2357570, [
      '+c48aa3d3379473f92df5f2665e1a28144900b1f8',
      '+6cea8a8817ae0a8dd5198052ffeba742b1a90b8e'
    ]),
    extra: { productCode: 'Pro' }
  },
  {
    source: 'ubisoft',
    externalId: '5541',
    platformId: 'ubisoft',
    title: "Assassin's Creed Valhalla",
    installDir:
      "C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\games\\Assassin's Creed Valhalla",
    launch: { kind: 'uri', uri: 'uplay://launch/5541/0' },
    tracking: {
      mode: 'installDir',
      installDir:
        "C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\games\\Assassin's Creed Valhalla"
    },
    installed: false,
    playtime: 1420,
    lastPlayed: 29,
    playCount: 18,
    added: 700,
    metadata: meta({
      desc: "Lead Eivor's clan from Norway to the kingdoms of ninth-century England, raiding monasteries, building a settlement and getting tangled in the Hidden Ones' long war with the Order of the Ancients.",
      short: "Viking-era open-world Assassin's Creed with raids and settlement building.",
      released: '2020-11-10',
      dev: ['Ubisoft Montreal'],
      pub: ['Ubisoft'],
      genres: ['Action', 'RPG', 'Open World'],
      tags: ['Vikings', 'Stealth', 'Historical'],
      rating: 80,
      players: '1',
      hltb: [61, 100, 150],
      ach: [40, 92],
      store: 'https://store.ubisoft.com/us/assassins-creed-valhalla/5e8e8fb15cdf9a12c8a4e7d6.html',
      website: 'http://www.assassinscreed.com',
      sources: { steamgriddb: '5251819', igdb: '115653', hltb: '78548' }
    }),
    media: steamArt(2208920, [
      '103481084a59b34837113daf27c04679caf743f3',
      'e7310b36689ec722d2ea4643efc15bd8fa720c67'
    ]),
    extra: { ubisoftId: 5541 }
  },
  {
    source: 'xbox',
    externalId: 'Microsoft.624F8B84B80_8wekyb3d8bbwe',
    platformId: STORE_PLATFORMS.xbox.id,
    title: 'Forza Horizon 5',
    installDir: 'C:\\XboxGames\\Forza Horizon 5\\Content',
    launch: { kind: 'uwp', aumid: 'Microsoft.624F8B84B80_8wekyb3d8bbwe!App' },
    tracking: { mode: 'uwp', packageFamilyName: 'Microsoft.624F8B84B80_8wekyb3d8bbwe' },
    playtime: 1210,
    lastPlayed: 9,
    playCount: 26,
    added: 500,
    metadata: meta({
      desc: 'An open-world festival of driving set in a condensed Mexico: jungles, deserts, a live volcano and hundreds of cars to collect. Seasons change the roads weekly and almost every event can be played with friends.',
      short: 'Open-world arcade racer across a compact, gorgeous Mexico.',
      released: '2021-11-09',
      dev: ['Playground Games'],
      pub: ['Xbox Game Studios'],
      genres: ['Racing', 'Open World', 'Simulation'],
      tags: ['Driving', 'Multiplayer', 'Photo Mode'],
      rating: 92,
      players: '1-12 online',
      hltb: [19.5, 70, 290],
      ach: [72, 164],
      store: 'https://www.xbox.com/en-US/games/store/forza-horizon-5/9NKX70BBCDRN',
      website: 'https://forza.net/horizon',
      sources: { steamgriddb: '5253964', igdb: '136879', hltb: '93839' }
    }),
    media: steamArt(1551360, [
      'cf56e25a0290556ba83229eb0ab370d10be0407c',
      '00f0090174380eeaf8753bd3d1028b6772c3aebf'
    ]),
    extra: {
      packageFullName: 'Microsoft.624F8B84B80_3.1.0.0_x64__8wekyb3d8bbwe',
      storeId: '9NKX70BBCDRN'
    }
  },
  {
    source: 'manual',
    externalId: 'c:/games/balatro/balatro.exe',
    platformId: PC_PLATFORM.id,
    title: 'Balatro',
    installDir: 'C:\\Games\\Balatro',
    exePath: 'C:\\Games\\Balatro\\Balatro.exe',
    launch: {
      kind: 'exec',
      file: 'C:\\Games\\Balatro\\Balatro.exe',
      args: [],
      cwd: 'C:\\Games\\Balatro'
    },
    tracking: { mode: 'spawned' },
    playtime: 1890,
    lastPlayed: 2.5,
    playCount: 66,
    added: 150,
    metadata: meta({
      desc: 'Poker hands are your attack, Jokers are your build, and the score requirements grow exponentially. A roguelike deck-builder that looks like a casino machine and plays like a maths problem you cannot put down.',
      short: 'Poker-themed roguelike deck-builder with 150 Jokers.',
      released: '2024-02-20',
      dev: ['LocalThunk'],
      pub: ['Playstack'],
      genres: ['Card Game', 'Roguelike', 'Strategy'],
      tags: ['Indie', 'Poker', 'Replay Value'],
      rating: 90,
      players: '1',
      hltb: [31, 77, 200],
      website: 'https://www.playbalatro.com/',
      sources: { steamgriddb: '5323434', igdb: '257045', hltb: '125573' }
    }),
    media: steamArt(2379780, [
      '+96208723dbedef49d71bf1b0a74aee1689018c50',
      '4862112e5030f74a5818cd4c31347d699ac5adf3'
    ])
  }
]

const ROM_GAMES: Seed[] = [
  // Matched to Xerenge (mock/recomp.ts), a setup-program recompilation: its Recompilation page offers to delete the
  // disc image and the game folder PlayOut unpacked for the setup (the Delete dropdown).
  rom({
    hash: 'wYBD0iYdiT6xnKRH',
    systemId: 'xbox360',
    relativePath: 'xbox360/Burnout Revenge (USA).iso',
    title: 'Burnout Revenge',
    tags: ['USA'],
    playtime: 95,
    lastPlayed: 4,
    playCount: 3,
    meta: {
      desc: 'Takedown-focused racing: shunt rivals and traffic into the scenery across rush-hour city circuits.',
      short: 'Arcade racing built around takedowns.',
      released: '2005-09-13',
      dev: ['Criterion Games'],
      pub: ['Electronic Arts'],
      genres: ['Racing'],
      players: '1-6',
      sources: { esde: 'Burnout Revenge (USA)' }
    },
    media: {}
  }),
  // One game on two systems (lib/copies.ts): the Library shows the PS2 copy, both while searching or filtering.
  rom({
    hash: 'aupJdZD7FnsqvCvi',
    systemId: 'ps2',
    relativePath: 'ps2/Spider-Man 2 (USA).iso',
    title: 'Spider-Man 2',
    tags: ['USA'],
    playtime: 0,
    playCount: 0,
    meta: {
      desc: 'Swing through an open Manhattan as Peter Parker, juggling pizza deliveries, petty crime and Doctor Octopus.',
      short: 'The web-swinging open-world movie tie-in.',
      released: '2004-06-28',
      dev: ['Treyarch'],
      pub: ['Activision'],
      genres: ['Action'],
      players: '1',
      sources: { esde: 'Spider-Man 2 (USA)' }
    },
    media: {}
  }),
  rom({
    hash: 'UujqHpHDzNric7EG',
    systemId: 'xbox',
    relativePath: 'xbox/Spider-Man 2 (USA).iso',
    title: 'Spider-Man 2',
    tags: ['USA'],
    playtime: 0,
    playCount: 0,
    meta: {
      desc: 'Swing through an open Manhattan as Peter Parker, juggling pizza deliveries, petty crime and Doctor Octopus.',
      short: 'The web-swinging open-world movie tie-in.',
      released: '2004-06-28',
      dev: ['Treyarch'],
      pub: ['Activision'],
      genres: ['Action'],
      players: '1',
      sources: { esde: 'Spider-Man 2 (USA)' }
    },
    media: {}
  }),
  rom({
    hash: 'teYOOmTQ_LAme9X6',
    systemId: 'snes',
    relativePath: 'snes/Chrono Trigger (USA).sfc',
    title: 'Chrono Trigger',
    tags: ['USA'],
    playtime: 980,
    lastPlayed: 4,
    playCount: 17,
    favorite: true,
    meta: {
      desc: 'Crono, Marle and Lucca fall through time at the Millennial Fair and end up with the fate of 1999 AD in their hands. Multiple endings, no random battles and a soundtrack people still hum thirty years later.',
      short: "Square's time-travelling 16-bit RPG, as good as its reputation.",
      released: '1995-03-11',
      dev: ['Square'],
      pub: ['Square'],
      genres: ['RPG', 'JRPG'],
      lb: ['Role-Playing'],
      rating: 92,
      players: '1',
      hltb: [23, 29.5, 41],
      sources: { screenscraper: '3062', esde: 'Chrono Trigger (USA)' }
    },
    // A ROM's screenshots, as its metadata brings them (shown in the game page's screenshot row).
    media: steamArt(613830, [
      'b92c46019720da5518bf69492c1f646f9c67dc29',
      'fe62096054041c5faf8f8d28b685bcc9bc5cdd77',
      '0e2d9f93550aa58ec19e3163d120fa6fa4b88189',
      '9f190f88109757e3212aa39ad6df16b57d6deb81'
    ])
  }),
  rom({
    hash: '-VT7WTLGXhCK33D6',
    systemId: 'psx',
    relativePath: 'psx/Crash Bandicoot (USA).chd',
    title: 'Crash Bandicoot',
    tags: ['USA'],
    playtime: 210,
    lastPlayed: 13,
    playCount: 6,
    meta: {
      desc: "Spin through Cortex's island levels into the screen, across the screen and occasionally away from a boulder. The original 1996 run-and-jump that gave the PlayStation a mascot.",
      short: 'The first Crash: 32 levels, one boulder, zero mercy.',
      released: '1996-09-09',
      dev: ['Naughty Dog'],
      pub: ['Sony Computer Entertainment'],
      genres: ['Platformer'],
      rating: 80,
      players: '1',
      hltb: [6.5, 9.5, 14],
      sources: { screenscraper: '9594', esde: 'Crash Bandicoot (USA)' }
    },
    media: steamArt(731490)
  }),
  rom({
    hash: '9VDyYAK7IZj7rckk',
    systemId: 'n64',
    relativePath: 'n64/Doom 64 (USA).z64',
    title: 'Doom 64',
    tags: ['USA'],
    playtime: 180,
    lastPlayed: 18,
    playCount: 5,
    meta: {
      desc: "Midway's moodier, darker Doom built for the Nintendo 64: new sprites, new levels, the Unmaker and a soundtrack of ambient dread instead of guitars.",
      short: 'The N64-exclusive Doom, darker and slower than its PC cousins.',
      released: '1997-03-31',
      dev: ['Midway Games'],
      pub: ['Midway Games'],
      genres: ['Shooter', 'FPS'],
      rating: 76,
      players: '1',
      hltb: [6, 8, 10],
      sources: { screenscraper: '1569', esde: 'Doom 64 (USA)' }
    },
    media: steamArt(1148590)
  }),
  rom({
    hash: 'Em4t6XfIRabeWLds',
    systemId: 'gba',
    relativePath: 'gba/Castlevania - Aria of Sorrow (USA).gba',
    title: 'Castlevania: Aria of Sorrow',
    tags: ['USA'],
    playtime: 420,
    lastPlayed: 21,
    playCount: 8,
    meta: {
      desc: "In 2035, Soma Cruz is pulled into Dracula's castle during an eclipse and discovers he can absorb the souls of the monsters he kills. The soul system makes this the GBA Castlevania people keep replaying.",
      short: 'The best of the GBA Castlevanias, with the soul-collecting system.',
      released: '2003-05-06',
      dev: ['Konami'],
      pub: ['Konami'],
      genres: ['Action', 'Metroidvania'],
      rating: 91,
      players: '1',
      hltb: [8.5, 11.5, 21.5],
      sources: { screenscraper: '3107', esde: 'Castlevania - Aria of Sorrow (USA)' }
    },
    media: steamArt(1552550)
  }),
  rom({
    hash: 'J0ObT-tclQ1dxnSu',
    systemId: 'switch',
    relativePath: 'switch/Metroid Dread [0100A96014FD0000][v0].nsp',
    title: 'Metroid Dread',
    tags: ['0100A96014FD0000', 'v0'],
    playtime: 0,
    playCount: 0,
    meta: {
      desc: 'Samus lands on ZDR hunting the X parasite and is hunted in turn by the E.M.M.I. robots that stalk sealed sections of the planet. The fastest, most fluid 2D Metroid, and the end of the story that began in 1986.',
      short: '2D Metroid finale with relentless E.M.M.I. stalkers.',
      released: '2021-10-08',
      dev: ['MercurySteam', 'Nintendo EPD'],
      pub: ['Nintendo'],
      genres: ['Action', 'Metroidvania'],
      rating: 88,
      players: '1',
      hltb: [8.5, 11.5, 15.5],
      sources: { esde: 'Metroid Dread' }
    },
    // ES-DE had the gamelist entry but no downloaded media: the placeholder cover shows.
    media: {}
  }),
  rom({
    hash: '1yemoaI1IAJ2LKGE',
    systemId: 'dreamcast',
    relativePath: 'dreamcast/Jet Set Radio (USA).gdi',
    title: 'Jet Set Radio',
    tags: ['USA'],
    playtime: 260,
    lastPlayed: 24,
    playCount: 7,
    meta: {
      desc: 'Inline-skating graffiti crews tag Tokyo-to while the police escalate from tear gas to helicopters. Cel-shaded before anyone had a name for it, with a Hideki Naganuma soundtrack that is still the point.',
      short: "Sega's cel-shaded skating-and-graffiti classic.",
      released: '2000-06-29',
      dev: ['Smilebit'],
      pub: ['Sega'],
      genres: ['Action', 'Platformer'],
      rating: 94,
      players: '1',
      hltb: [7, 9, 15],
      sources: { screenscraper: '1200', esde: 'Jet Set Radio (USA)' }
    },
    media: steamArt(205950)
  }),
  rom({
    hash: 'KG6gxPiKNa1qCqIz',
    systemId: 'genesis',
    relativePath: 'genesis/Sonic the Hedgehog 2 (World).md',
    title: 'Sonic the Hedgehog 2',
    tags: ['World'],
    playtime: 150,
    lastPlayed: 22,
    playCount: 9,
    meta: {
      desc: 'Tails joins Sonic for a faster, bigger sequel: the spin dash, Chemical Plant, Casino Night and the Death Egg. Still the Genesis game most people picture when they hear the name of the console.',
      short: 'The Genesis sequel that introduced Tails and the spin dash.',
      released: '1992-11-24',
      dev: ['Sonic Team', 'Sega Technical Institute'],
      pub: ['Sega'],
      genres: ['Platformer'],
      rating: 87,
      players: '1-2',
      hltb: [3, 4, 7],
      sources: { screenscraper: '1240', esde: 'Sonic the Hedgehog 2 (World)' }
    },
    media: steamArt(1794960)
  }),
  rom({
    hash: '1VlZVcvIOO_VB5eP',
    systemId: 'arcade',
    relativePath: 'arcade/mslug.zip',
    title: 'Metal Slug',
    tags: [],
    playtime: 95,
    lastPlayed: 14,
    playCount: 12,
    meta: {
      desc: "Nazca's run-and-gun that turned hand-drawn sprite animation into a genre benchmark: six missions, one tank, and an endless supply of POWs to rescue.",
      short: 'The arcade run-and-gun with the best-animated explosions of 1996.',
      released: '1996-04-19',
      dev: ['Nazca Corporation'],
      pub: ['SNK'],
      genres: ['Run and Gun', 'Shooter'],
      rating: 85,
      players: '1-2',
      hltb: [1, 1.5, 2.5],
      sources: { screenscraper: '7120', esde: 'mslug' }
    },
    media: steamArt(366250)
  })
]

/** Fresh copies of the 33 sample games (callers mutate their copy freely). */
export function sampleGames(): Game[] {
  return [...STEAM_GAMES, ...STORE_GAMES, ...ROM_GAMES].map(buildGame)
}

/**
 * A generated library of `count` games (the `screen=library-large` capture, which exercises the Library
 * grid's windowing): the visible sample games repeated with distinct ids and numbered titles, the same art
 * (so the browser caches ~30 images, not hundreds), and varied install state, play time and dates so every
 * sort order shuffles them.
 */
export function largeLibrary(count: number): Game[] {
  const samples = sampleGames().filter((g) => !g.hidden)
  const out: Game[] = []
  for (let i = 0; i < count; i++) {
    const base = samples[i % samples.length]!
    const copy = Math.floor(i / samples.length) + 1
    const game = structuredClone(base)
    game.id = `${base.id}:gen${i}`
    game.externalId = `${base.externalId}-${i}`
    if (copy > 1) {
      game.title = `${base.title} ${copy}`
      game.sortTitle = sortTitle(game.title)
    }
    game.favorite = false
    game.installed = i % 5 !== 4
    game.addedAt = daysAgo(i % 400)
    game.playtimeMinutes = (i * 37) % 3000
    game.playCount = game.playtimeMinutes === 0 ? 0 : 1 + (i % 7)
    if (i % 3 === 0) game.lastPlayed = daysAgo(i % 90)
    else delete game.lastPlayed
    out.push(game)
  }
  return out
}

/** Platform rows for the sources and systems present in `games`, as the providers would have registered them. */
export function platformsFor(games: Game[]): Platform[] {
  const platforms = new Map<string, Platform>()
  const systems: string[] = []
  for (const g of games) {
    if (g.source === 'manual') platforms.set(PC_PLATFORM.id, PC_PLATFORM)
    else if (g.source === 'rom') systems.push(g.platformId)
    else platforms.set(STORE_PLATFORMS[g.source].id, STORE_PLATFORMS[g.source])
  }
  for (const p of systemPlatforms(systems)) platforms.set(p.id, p)
  return [...platforms.values()].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)
  )
}
