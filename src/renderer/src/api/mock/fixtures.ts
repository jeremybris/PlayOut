// Derived, deterministic sample data: play sessions, achievement lists, metadata search candidates and the games a
// scan can "discover". Randomness comes from a seeded generator keyed by game id so screenshots never change.
import { PC_PLATFORM, STORE_PLATFORMS } from '@shared/platforms'
import type {
  AchievementsInfo,
  Game,
  GameMedia,
  GameMetadata,
  MetadataCandidate,
  PlaySession,
  SourceId
} from '@shared/types'
import { steamArt, steamStoreUrl } from './art'
import { ROMS_ROOT, buildGame, daysAgo } from './data'
import { MOCK_SYSTEMS } from './systems'

// ---------------------------------------------------------------------------
// Seeded randomness
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit hash of a string. */
export function hash32(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** mulberry32: a tiny seeded PRNG returning floats in [0, 1). */
export function seededRandom(seed: string): () => number {
  let a = hash32(seed)
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Short id in the style of src/main/util/ids.ts newId(): `${prefix}_` + 10 base64url characters. */
export function shortId(prefix: string, seed: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const rnd = seededRandom(seed)
  let out = ''
  for (let i = 0; i < 10; i++) out += alphabet[Math.floor(rnd() * alphabet.length)]
  return `${prefix}_${out}`
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** Up to five past sessions per played game, the most recent one starting at `lastPlayed`, oldest first. */
export function sampleSessions(games: Game[]): PlaySession[] {
  const sessions: PlaySession[] = []
  for (const g of games) {
    if (!g.lastPlayed || g.playCount === 0 || g.playtimeMinutes === 0) continue
    const rnd = seededRandom(g.id)
    const count = Math.min(g.playCount, 5)
    const average = g.playtimeMinutes / g.playCount
    let start = Date.parse(g.lastPlayed)
    for (let i = 0; i < count; i++) {
      const minutes = Math.max(1, Math.round(average * (0.5 + rnd())))
      sessions.push({
        id: shortId('s', `${g.id}:${i}`),
        gameId: g.id,
        startedAt: new Date(start).toISOString(),
        endedAt: new Date(start + minutes * 60_000).toISOString(),
        minutes
      })
      // Earlier sessions are one to five days apart.
      start -= Math.round((1 + rnd() * 4) * 86_400_000)
    }
  }
  return sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
}

// ---------------------------------------------------------------------------
// Achievements
// ---------------------------------------------------------------------------

const ACHIEVEMENT_TEMPLATES: { name: string; description: string; hidden?: boolean }[] = [
  { name: 'First Steps', description: 'Finish the opening chapter.' },
  { name: 'Getting Serious', description: 'Reach the second area.' },
  { name: 'Collector', description: 'Find 25 collectibles.' },
  { name: 'Untouchable', description: 'Clear a stage without taking damage.' },
  { name: 'Speedrunner', description: 'Finish a stage in under five minutes.' },
  { name: 'Boss Rush', description: 'Defeat three bosses in one session.' },
  { name: 'Treasure Hunter', description: 'Open every chest in a region.' },
  { name: 'Night Owl', description: 'Play between midnight and 4 AM.' },
  { name: 'Marathon', description: 'Play for ten hours in total.' },
  { name: 'Secret Ending', description: 'Discover the hidden ending.', hidden: true },
  { name: 'Perfectionist', description: 'Earn an S rank on any stage.' },
  { name: 'Legend', description: 'Finish the game on the hardest difficulty.' }
]

/** A 12-entry achievement list consistent with the game's unlocked/total counts, or null when it has none. */
export function sampleAchievements(game: Game, sessions: PlaySession[]): AchievementsInfo | null {
  const counts = game.metadata.achievements
  if (!counts) return null
  const unlockedInList = Math.min(
    ACHIEVEMENT_TEMPLATES.length,
    Math.round((counts.unlocked / Math.max(1, counts.total)) * ACHIEVEMENT_TEMPLATES.length)
  )
  const played = sessions.filter((s) => s.gameId === game.id).map((s) => s.startedAt)
  const fallback = game.lastPlayed ?? game.addedAt
  return {
    total: counts.total,
    unlocked: counts.unlocked,
    list: ACHIEVEMENT_TEMPLATES.map((t, i) => {
      const unlocked = i < unlockedInList
      return {
        id: `ACH_${String(i + 1).padStart(2, '0')}_${t.name.toUpperCase().replace(/\s+/g, '_')}`,
        name: t.name,
        description: t.hidden && !unlocked ? undefined : t.description,
        unlocked,
        unlockedAt: unlocked ? (played[i % Math.max(1, played.length)] ?? fallback) : undefined,
        hidden: t.hidden
      }
    })
  }
}

const RECOMP_ACHIEVEMENTS: {
  name: string
  description: string
  gamerscore: number
  secret?: boolean
}[] = [
  { name: 'Revenge Rookie', description: 'Win your first race.', gamerscore: 10 },
  { name: 'Traffic Checker', description: 'Check 50 cars into the traffic.', gamerscore: 15 },
  { name: 'Takedown Artist', description: 'Earn 100 takedowns.', gamerscore: 25 },
  { name: 'Crash Course', description: 'Score 1,000,000 in Crash mode.', gamerscore: 20 },
  { name: 'Burnout Chain', description: 'Chain four burnouts in one race.', gamerscore: 30 },
  { name: 'Road Rage', description: 'Finish a Road Rage event with 20 takedowns.', gamerscore: 25 },
  { name: 'Elite License', description: 'Reach the Elite rank.', gamerscore: 50, secret: true },
  { name: 'Perfect Run', description: 'Earn a gold medal on every event.', gamerscore: 75 }
]

/**
 * An Xbox 360 recompilation's achievements as main reads them (recomp/achievements): the game's own list with
 * gamerscore, three unlocked with the dates the unlock file gives, a secret one still locked.
 */
export function sampleRecompAchievements(game: Game): AchievementsInfo {
  const fallback = game.lastPlayed ?? game.addedAt
  const unlockedCount = 3
  let earned = 0
  let total = 0
  const list = RECOMP_ACHIEVEMENTS.map((a, i) => {
    const unlocked = i < unlockedCount
    total += a.gamerscore
    if (unlocked) earned += a.gamerscore
    return {
      id: String(i + 1),
      name: a.name,
      description: a.description,
      unlocked,
      ...(unlocked
        ? {
            unlockedAt: new Date(
              Date.parse(fallback) - (unlockedCount - i) * 86_400_000
            ).toISOString()
          }
        : {}),
      ...(a.secret ? { hidden: true } : {}),
      points: a.gamerscore
    }
  })
  return {
    provider: 'recomp',
    total: list.length,
    unlocked: unlockedCount,
    points: { earned, total },
    list
  }
}

// ---------------------------------------------------------------------------
// Metadata search
// ---------------------------------------------------------------------------

function titleCase(text: string): string {
  return text.replace(/\b\p{L}/gu, (c) => c.toUpperCase())
}

/** Four plausible candidates for a search query, one per text scraper. */
export function sampleCandidates(game: Game, query: string): MetadataCandidate[] {
  const base = titleCase(query.trim() || game.title)
  const year = Number((game.metadata.releaseDate ?? '2015').slice(0, 4)) || 2015
  const seed = hash32(`${game.id}:${base}`)
  const system = MOCK_SYSTEMS.find((s) => s.id === game.platformId)
  const platform = system ? system.name : 'PC'
  return [
    {
      scraper: 'steamgriddb',
      externalId: String(5000 + (seed % 90_000)),
      title: base,
      releaseDate: String(year),
      platform,
      cover: game.media.cover
    },
    {
      scraper: 'igdb',
      externalId: String(1000 + ((seed >>> 8) % 250_000)),
      title: base,
      releaseDate: `${year}-01-01`,
      platform: system ? platform : 'PC (Microsoft Windows)'
    },
    {
      scraper: 'screenscraper',
      externalId: String(100 + ((seed >>> 16) % 90_000)),
      title: `${base} (USA)`,
      releaseDate: String(year),
      platform
    },
    {
      scraper: 'thegamesdb',
      externalId: String(10 + ((seed >>> 20) % 9_000)),
      title: `${base}: Definitive Edition`,
      releaseDate: String(year + 2),
      platform
    }
  ]
}

// ---------------------------------------------------------------------------
// Games a scan can discover
// ---------------------------------------------------------------------------

export interface Discoverable {
  game: Game
  /** What the metadata scrape later fills in (the game is inserted bare, like a real first scan). */
  scrape: { metadata: GameMetadata; media: GameMedia } | null
}

const scrapedMeta = (m: GameMetadata): GameMetadata => ({ ...m, updatedAt: daysAgo(0) })

/** One not-yet-scanned game per source; a scan adds it to the first source it covers. */
export function discoverableGames(): Record<SourceId, Discoverable> {
  const steamDir = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Vampire Survivors'
  const epicDir = 'C:\\Program Files\\Epic Games\\FallGuys'
  const gogDir = 'C:\\Program Files (x86)\\GOG Galaxy\\Games\\Cuphead'
  const eaDir = 'C:\\Program Files\\EA Games\\Apex'
  const ubiDir = 'C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\games\\Far Cry 6'
  const romPath = `${ROMS_ROOT}\\snes\\Super Metroid (Japan, USA) (En,Ja).sfc`
  return {
    steam: {
      game: buildGame({
        source: 'steam',
        externalId: '1794680',
        platformId: 'steam',
        title: 'Vampire Survivors',
        installDir: steamDir,
        launch: { kind: 'uri', uri: 'steam://rungameid/1794680' },
        tracking: { mode: 'installDir', installDir: steamDir },
        playtime: 0,
        storePlaytime: 1460,
        lastPlayed: 32,
        playCount: 0,
        added: 0,
        metadata: {},
        // Steam's library cache already holds the art, so the scan delivers it immediately.
        media: steamArt(1794680),
        metadataStatus: 'none',
        extra: { appid: 1794680 }
      }),
      scrape: {
        metadata: scrapedMeta({
          description:
            'Survive waves of monsters in a gothic field while your weapons fire by themselves and your only job is to walk. Thirty minutes per run, hundreds of unlocks, and the start of a whole genre.',
          shortDescription: 'The auto-shooter that started the survivors-like genre.',
          releaseDate: '2022-10-20',
          developers: ['poncle'],
          publishers: ['poncle'],
          genres: ['Action', 'Roguelike', 'Casual'],
          rating: 86,
          players: '1-4',
          hltb: { main: 14.5, extra: 52, completionist: 93 },
          achievements: { unlocked: 0, total: 243, updatedAt: daysAgo(0) },
          links: { store: steamStoreUrl(1794680), website: 'https://poncle.games/' },
          sources: { steam: '1794680', steamgriddb: '5258160' }
        }),
        media: steamArt(1794680)
      }
    },
    epic: {
      game: buildGame({
        source: 'epic',
        externalId: '0a2d9f6403244d12969e11da6713137b',
        platformId: 'epic',
        title: 'Fall Guys',
        installDir: epicDir,
        launch: {
          kind: 'uri',
          uri: 'com.epicgames.launcher://apps/0a2d9f6403244d12969e11da6713137b?action=launch&silent=true'
        },
        tracking: { mode: 'installDir', installDir: epicDir },
        playtime: 0,
        playCount: 0,
        added: 0,
        metadata: {},
        media: {},
        metadataStatus: 'none',
        extra: {
          appName: '0a2d9f6403244d12969e11da6713137b',
          namespace: '50118b7f954e450f8823df1614b24e80'
        }
      }),
      scrape: {
        metadata: scrapedMeta({
          description:
            'Sixty jellybeans enter an obstacle-course game show and one leaves with the crown. Rounds are short, physics are silly, and the queue to play again is instant.',
          shortDescription: 'Free-to-play battle-royale game show for clumsy beans.',
          releaseDate: '2020-08-04',
          developers: ['Mediatonic'],
          publishers: ['Epic Games'],
          genres: ['Party', 'Platformer', 'Multiplayer'],
          rating: 80,
          players: '1-60 online',
          links: { store: 'https://store.epicgames.com/en-US/p/fall-guys' },
          sources: { steamgriddb: '5250622', igdb: '125174' }
        }),
        media: steamArt(1097150)
      }
    },
    gog: {
      game: buildGame({
        source: 'gog',
        externalId: '1660502169',
        platformId: 'gog',
        title: 'Cuphead',
        installDir: gogDir,
        exePath: `${gogDir}\\Cuphead.exe`,
        launch: { kind: 'exec', file: `${gogDir}\\Cuphead.exe`, args: [], cwd: gogDir },
        tracking: { mode: 'installDir', installDir: gogDir },
        playtime: 0,
        playCount: 0,
        added: 0,
        metadata: {},
        media: {},
        metadataStatus: 'none',
        extra: { productId: 1660502169 }
      }),
      scrape: {
        metadata: scrapedMeta({
          description:
            'A run-and-gun built almost entirely from boss fights, hand-animated in the style of 1930s cartoons. Cuphead and Mugman owe the devil their souls and collect debts to pay him back.',
          shortDescription: 'Boss-rush run-and-gun drawn like a 1930s cartoon.',
          releaseDate: '2017-09-29',
          developers: ['Studio MDHR'],
          publishers: ['Studio MDHR'],
          genres: ['Run and Gun', 'Platformer', 'Action'],
          rating: 88,
          players: '1-2',
          hltb: { main: 11, extra: 15, completionist: 25.5 },
          achievements: { unlocked: 0, total: 42, updatedAt: daysAgo(0) },
          links: { store: 'https://www.gog.com/game/cuphead' },
          sources: { gog: '1660502169', steamgriddb: '5235' }
        }),
        media: steamArt(268910)
      }
    },
    ea: {
      game: buildGame({
        source: 'ea',
        externalId: 'Origin.OFR.50.0002694',
        platformId: 'ea',
        title: 'Apex Legends',
        installDir: eaDir,
        launch: {
          kind: 'uri',
          uri: 'origin2://game/launch?offerIds=Origin.OFR.50.0002694&autoDownload=1'
        },
        tracking: { mode: 'installDir', installDir: eaDir },
        playtime: 0,
        playCount: 0,
        added: 0,
        metadata: {},
        media: {},
        metadataStatus: 'none',
        extra: { offerId: 'Origin.OFR.50.0002694' }
      }),
      scrape: {
        metadata: scrapedMeta({
          description:
            "Respawn's squad-based battle royale with the Titanfall movement and a roster of Legends whose abilities decide how a fight goes. Free to play, cross-platform, and still fast.",
          shortDescription: 'Free-to-play hero battle royale with Titanfall movement.',
          releaseDate: '2019-02-04',
          developers: ['Respawn Entertainment'],
          publishers: ['Electronic Arts'],
          genres: ['Battle Royale', 'Shooter', 'Multiplayer'],
          rating: 88,
          players: '1-3 online',
          links: { store: 'https://www.ea.com/games/apex-legends' },
          sources: { steamgriddb: '5250', igdb: '114795' }
        }),
        media: steamArt(1172470)
      }
    },
    battlenet: {
      game: buildGame({
        source: 'battlenet',
        externalId: 'WTCG',
        platformId: 'battlenet',
        title: 'Hearthstone',
        installDir: 'C:\\Program Files (x86)\\Hearthstone',
        exePath: 'C:\\Program Files (x86)\\Hearthstone\\Hearthstone.exe',
        launch: {
          kind: 'exec',
          file: 'C:\\Program Files (x86)\\Battle.net\\Battle.net.exe',
          args: ['--exec=launch WTCG']
        },
        tracking: { mode: 'process', processNames: ['Hearthstone'] },
        playtime: 0,
        playCount: 0,
        added: 0,
        metadata: {},
        media: {},
        metadataStatus: 'none',
        extra: { productCode: 'WTCG' }
      }),
      // Not on Steam and no SteamGridDB key configured on the mock machine: the scrape finds nothing.
      scrape: null
    },
    ubisoft: {
      game: buildGame({
        source: 'ubisoft',
        externalId: '5266',
        platformId: 'ubisoft',
        title: 'Far Cry 6',
        installDir: ubiDir,
        launch: { kind: 'uri', uri: 'uplay://launch/5266/0' },
        tracking: { mode: 'installDir', installDir: ubiDir },
        playtime: 0,
        playCount: 0,
        added: 0,
        metadata: {},
        media: {},
        metadataStatus: 'none',
        extra: { ubisoftId: 5266 }
      }),
      scrape: {
        metadata: scrapedMeta({
          description:
            'Fight a guerrilla war against Antón Castillo across the island nation of Yara, with improvised weapons, a wheelchair-bound dachshund as a companion and a backpack that fires rockets.',
          shortDescription: 'Open-world guerrilla shooter on a Caribbean island under a dictator.',
          releaseDate: '2021-10-07',
          developers: ['Ubisoft Toronto'],
          publishers: ['Ubisoft'],
          genres: ['Shooter', 'Open World', 'Action'],
          rating: 73,
          players: '1-2',
          hltb: { main: 23, extra: 44, completionist: 65 },
          links: { store: 'https://store.ubisoft.com/us/far-cry-6/5f3e3f6a5cdf9a1d7c0a8b20.html' },
          sources: { steamgriddb: '5253287', igdb: '135400' }
        }),
        media: steamArt(2369390)
      }
    },
    xbox: {
      game: buildGame({
        source: 'xbox',
        externalId: 'Microsoft.SeaofThieves_8wekyb3d8bbwe',
        platformId: STORE_PLATFORMS.xbox.id,
        title: 'Sea of Thieves',
        installDir: 'C:\\XboxGames\\Sea of Thieves\\Content',
        launch: { kind: 'uwp', aumid: 'Microsoft.SeaofThieves_8wekyb3d8bbwe!App' },
        tracking: { mode: 'uwp', packageFamilyName: 'Microsoft.SeaofThieves_8wekyb3d8bbwe' },
        playtime: 0,
        playCount: 0,
        added: 0,
        metadata: {},
        media: {},
        metadataStatus: 'none',
        extra: { storeId: '9P2N57MC619K' }
      }),
      scrape: {
        metadata: scrapedMeta({
          description:
            'Crew a galleon with friends, chase treasure maps, fight skeletons and other players, and try to get the loot back to an outpost before someone sinks you. The ship only sails if everyone pulls together.',
          shortDescription: 'Shared-world pirate adventure built for crews of friends.',
          releaseDate: '2018-03-20',
          developers: ['Rare'],
          publishers: ['Xbox Game Studios'],
          genres: ['Adventure', 'Multiplayer', 'Open World'],
          rating: 69,
          players: '1-4 online',
          links: { store: 'https://www.xbox.com/en-US/games/store/sea-of-thieves/9P2N57MC619K' },
          sources: { steamgriddb: '5241', igdb: '26758' }
        }),
        media: steamArt(1172620)
      }
    },
    manual: {
      game: buildGame({
        source: 'manual',
        externalId: 'c:/games/noita/noita.exe',
        platformId: PC_PLATFORM.id,
        title: 'Noita',
        installDir: 'C:\\Games\\Noita',
        exePath: 'C:\\Games\\Noita\\noita.exe',
        launch: {
          kind: 'exec',
          file: 'C:\\Games\\Noita\\noita.exe',
          args: [],
          cwd: 'C:\\Games\\Noita'
        },
        tracking: { mode: 'spawned' },
        playtime: 0,
        playCount: 0,
        added: 0,
        metadata: {},
        media: {},
        metadataStatus: 'none'
      }),
      scrape: {
        metadata: scrapedMeta({
          description:
            'A roguelite where every pixel is physically simulated: fire spreads, acid eats through rock, and the wands you build from spell parts are just as likely to kill you as the enemies.',
          shortDescription: 'Falling-sand roguelite with fully simulated pixels and custom wands.',
          releaseDate: '2020-10-15',
          developers: ['Nolla Games'],
          publishers: ['Nolla Games'],
          genres: ['Roguelike', 'Action', 'Simulation'],
          rating: 84,
          players: '1',
          hltb: { main: 12, extra: 50, completionist: 140 },
          links: { store: steamStoreUrl(881100), website: 'https://noitagame.com/' },
          sources: { steamgriddb: '5249', igdb: '113114' }
        }),
        media: steamArt(881100)
      }
    },
    rom: {
      game: buildGame({
        // rom:snes:<16-char base64url sha1 of "snes/Super Metroid (Japan, USA) (En,Ja).sfc">
        id: 'rom:snes:duL23Zg-wXKHHxmW',
        source: 'rom',
        externalId: 'snes/Super Metroid (Japan, USA) (En,Ja).sfc',
        platformId: 'snes',
        title: 'Super Metroid',
        romPath,
        launch: { kind: 'emulator', systemId: 'snes', romPath },
        tracking: { mode: 'spawned' },
        playtime: 0,
        playCount: 0,
        added: 0,
        metadata: {},
        media: {},
        metadataStatus: 'none',
        extra: { tags: 'Japan, USA, En,Ja' }
      }),
      // ScreenScraper credentials are not configured on the mock machine.
      scrape: null
    }
  }
}

/** Executables that "Scan a folder for games" finds under any folder. */
export function folderGames(folder: string): Game[] {
  const root = folder.replace(/[\\/]+$/, '')
  const entries: { dir: string; exe: string; title: string }[] = [
    { dir: 'Noita', exe: 'noita.exe', title: 'Noita' },
    { dir: 'Dwarf Fortress', exe: 'Dwarf Fortress.exe', title: 'Dwarf Fortress' }
  ]
  return entries.map((e) => {
    const dir = `${root}\\${e.dir}`
    const exePath = `${dir}\\${e.exe}`
    return buildGame({
      source: 'manual',
      externalId: exePath.toLowerCase().replace(/\\/g, '/'),
      platformId: PC_PLATFORM.id,
      title: e.title,
      installDir: dir,
      exePath,
      launch: { kind: 'exec', file: exePath, args: [], cwd: dir },
      tracking: { mode: 'spawned' },
      playtime: 0,
      playCount: 0,
      added: 0,
      metadata: {},
      media: {},
      metadataStatus: 'none'
    })
  })
}

/** What a later scrape fills in for games added through addGamesFromFolder / addManualGame, keyed by title. */
export function scrapeForTitle(title: string): Discoverable['scrape'] {
  const known: Record<string, Discoverable['scrape']> = {
    Noita: discoverableGames().manual.scrape,
    'Dwarf Fortress': {
      metadata: scrapedMeta({
        description:
          'Carve a fortress into a procedurally generated world with a history, then watch your dwarves build, brew, fight and lose their minds. The Steam edition finally has graphics and a mouse.',
        shortDescription: 'The deepest colony simulation ever made, now with tilesets.',
        releaseDate: '2022-12-06',
        developers: ['Bay 12 Games'],
        publishers: ['Kitfox Games'],
        genres: ['Simulation', 'Strategy', 'Colony Sim'],
        rating: 93,
        players: '1',
        links: { store: steamStoreUrl(975370), website: 'http://www.bay12games.com/dwarves/' },
        sources: { steamgriddb: '5218', igdb: '2000' }
      }),
      media: steamArt(975370)
    }
  }
  return known[title] ?? null
}
