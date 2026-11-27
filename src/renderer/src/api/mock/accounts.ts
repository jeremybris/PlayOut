// Store accounts for the mock (docs/ARCHITECTURE.md §4.8 / §6.4): the account status per store and the owned,
// not installed games each signed-in account "imports". Steam and GOG start signed in, so their owned games are in
// the library from the first getLibrary(); Epic's arrive when the user signs in from the Library's Library Import (Add Games).
import { STORE_PLATFORMS } from '@shared/platforms'
import {
  STORE_SOURCES,
  type AccountStatus,
  type Game,
  type GameMetadata,
  type StoreSourceId
} from '@shared/types'
import { steamArt, steamStoreUrl } from './art'
import { buildGame, daysAgo } from './data'

/** The reason shown on the Ubisoft row (the same text the main process uses). */
export const UBISOFT_REASON =
  'Ubisoft does not offer a sign-in that PlayOut can use; your owned games come from the Ubisoft Connect client.'

/** Persona names the fake sign-in reports per store. */
export const MOCK_DISPLAY_NAMES: Record<StoreSourceId, string> = {
  steam: 'example_user',
  epic: 'JeremyB',
  gog: 'jeremy.bristol',
  ea: 'JeremyB_EA',
  battlenet: 'Jeremy#1138',
  ubisoft: 'JeremyB',
  xbox: 'Jeremy B'
}

/** Fresh account statuses in STORE_SOURCES order: Steam and GOG signed in with a past import, the rest signed out. */
export function mockAccounts(): AccountStatus[] {
  return STORE_SOURCES.map((source): AccountStatus => {
    const id = source as StoreSourceId
    switch (id) {
      case 'steam':
        return {
          source: id,
          supported: true,
          signedIn: true,
          displayName: MOCK_DISPLAY_NAMES.steam,
          lastImportAt: daysAgo(0.6),
          lastImportCount: 15,
          importing: false
        }
      case 'gog':
        return {
          source: id,
          supported: true,
          signedIn: true,
          displayName: MOCK_DISPLAY_NAMES.gog,
          lastImportAt: daysAgo(2.1),
          lastImportCount: 5,
          importing: false
        }
      case 'ubisoft':
        return {
          source: id,
          supported: false,
          reason: UBISOFT_REASON,
          signedIn: false,
          importing: false
        }
      default:
        return { source: id, supported: true, signedIn: false, importing: false }
    }
  })
}

/** Accounts for the empty screen: nobody signed in. */
export function signedOutAccounts(): AccountStatus[] {
  return mockAccounts().map((a) => ({
    ...a,
    signedIn: false,
    displayName: undefined,
    lastImportAt: undefined,
    lastImportCount: undefined
  }))
}

// ---------------------------------------------------------------------------
// Owned, not installed games
// ---------------------------------------------------------------------------

interface OwnedSeed {
  source: StoreSourceId
  externalId: string
  title: string
  /** Steam app id whose CDN art stands in for the store's own art. */
  art: number
  /** Download size in bytes the fake install reports (Steam / Epic / GOG show bytes, Xbox does not). */
  bytes: number
  storePlaytime?: number
  lastPlayed?: number
  added: number
  metadata: GameMetadata
  extra: Game['extra']
}

const GB = 1024 ** 3

/** The store's install URI form for an owned game (docs/research/store-accounts.md §8). */
export function installUri(source: StoreSourceId, externalId: string): string {
  switch (source) {
    case 'steam':
      return `steam://install/${externalId}`
    case 'epic':
      return `com.epicgames.launcher://apps/${externalId}?action=install`
    case 'gog':
      return `goggalaxy://openGameView/${externalId}`
    case 'ea':
      return `origin2://game/launch/?offerIds=${externalId}`
    case 'battlenet':
      return `battlenet://${externalId}`
    case 'ubisoft':
      return `uplay://install/${externalId}`
    case 'xbox':
      return `msxbox://game/?productId=${externalId}`
  }
}

/** The launch form the game gets once the fake install completes. */
export function launchUri(source: StoreSourceId, externalId: string): string {
  switch (source) {
    case 'steam':
      return `steam://rungameid/${externalId}`
    case 'epic':
      return `com.epicgames.launcher://apps/${externalId}?action=launch&silent=true`
    case 'gog':
      return `goggalaxy://runGameId/${externalId}`
    case 'ea':
      return `origin2://game/launch/?offerIds=${externalId}`
    case 'battlenet':
      return `battlenet://${externalId}`
    case 'ubisoft':
      return `uplay://launch/${externalId}/0`
    case 'xbox':
      return `msxbox://game/?productId=${externalId}`
  }
}

const OWNED: OwnedSeed[] = [
  {
    source: 'steam',
    externalId: '1174180',
    title: 'Red Dead Redemption 2',
    art: 1174180,
    bytes: 116 * GB,
    storePlaytime: 95,
    lastPlayed: 410,
    added: 400,
    metadata: {
      shortDescription:
        'Arthur Morgan and the Van der Linde gang on the run across a dying American frontier.',
      releaseDate: '2019-12-05',
      developers: ['Rockstar Games'],
      publishers: ['Rockstar Games'],
      genres: ['Action', 'Adventure', 'Open World'],
      links: { store: steamStoreUrl(1174180) }
    },
    extra: { steamAppId: 1174180 }
  },
  {
    source: 'steam',
    externalId: '1817070',
    title: "Marvel's Spider-Man Remastered",
    art: 1817070,
    bytes: 75 * GB,
    added: 120,
    metadata: {
      shortDescription:
        'Swing through Marvel\u2019s New York as an experienced Peter Parker in the PC remaster.',
      releaseDate: '2022-08-12',
      developers: ['Insomniac Games', 'Nixxes Software'],
      publishers: ['PlayStation Publishing LLC'],
      genres: ['Action', 'Adventure'],
      links: { store: steamStoreUrl(1817070) }
    },
    extra: { steamAppId: 1817070 }
  },
  {
    source: 'steam',
    externalId: '2050650',
    title: 'Resident Evil 4',
    art: 2050650,
    bytes: 67 * GB,
    added: 45,
    metadata: {
      shortDescription:
        'The 2023 remake: Leon Kennedy in a Spanish village six years after Raccoon City.',
      releaseDate: '2023-03-23',
      developers: ['CAPCOM Co., Ltd.'],
      publishers: ['CAPCOM Co., Ltd.'],
      genres: ['Action', 'Horror', 'Survival'],
      links: { store: steamStoreUrl(2050650) }
    },
    extra: { steamAppId: 2050650 }
  },
  {
    source: 'epic',
    externalId: 'Snapdragon',
    title: "Death Stranding Director's Cut",
    art: 1850570,
    bytes: 70 * GB,
    added: 300,
    metadata: {
      shortDescription: 'Sam Porter Bridges reconnects a fractured America one delivery at a time.',
      releaseDate: '2022-03-30',
      developers: ['Kojima Productions'],
      publishers: ['505 Games'],
      genres: ['Action', 'Adventure', 'Open World'],
      links: { store: 'https://store.epicgames.com/en-US/p/death-stranding-directors-cut' }
    },
    extra: { epicAppName: 'Snapdragon', epicNamespace: 'snapdragon' }
  },
  {
    source: 'epic',
    externalId: 'Kena',
    title: 'Kena: Bridge of Spirits',
    art: 1954200,
    bytes: 25 * GB,
    added: 260,
    metadata: {
      shortDescription: 'A young spirit guide and her Rot companions restore a forgotten village.',
      releaseDate: '2021-09-21',
      developers: ['Ember Lab'],
      publishers: ['Ember Lab'],
      genres: ['Action', 'Adventure'],
      links: { store: 'https://store.epicgames.com/en-US/p/kena-bridge-of-spirits' }
    },
    extra: { epicAppName: 'Kena', epicNamespace: 'kena' }
  },
  {
    source: 'epic',
    externalId: 'Phoenix',
    title: 'Hogwarts Legacy',
    art: 990080,
    bytes: 85 * GB,
    added: 200,
    metadata: {
      shortDescription: 'An open-world RPG set in the 1800s wizarding world.',
      releaseDate: '2023-02-10',
      developers: ['Avalanche Software'],
      publishers: ['Warner Bros. Games'],
      genres: ['RPG', 'Adventure', 'Open World'],
      links: { store: 'https://store.epicgames.com/en-US/p/hogwarts-legacy' }
    },
    extra: { epicAppName: 'Phoenix', epicNamespace: 'phoenix' }
  },
  {
    source: 'gog',
    externalId: '1207665503',
    title: 'Terraria',
    art: 105600,
    bytes: 0.7 * GB,
    storePlaytime: 1260,
    lastPlayed: 600,
    added: 900,
    metadata: {
      shortDescription: 'Dig, fight, explore and build in a procedurally generated 2D world.',
      releaseDate: '2011-05-16',
      developers: ['Re-Logic'],
      publishers: ['Re-Logic'],
      genres: ['Sandbox', 'Adventure', 'Survival'],
      links: { store: 'https://www.gog.com/game/terraria' }
    },
    extra: { gogProductId: 1207665503 }
  },
  {
    source: 'gog',
    externalId: '1506604264',
    title: 'Horizon Zero Dawn Complete Edition',
    art: 1151640,
    bytes: 68 * GB,
    added: 150,
    metadata: {
      shortDescription:
        'Aloy hunts machine beasts across a lush post-apocalyptic Earth; includes The Frozen Wilds.',
      releaseDate: '2020-08-07',
      developers: ['Guerrilla'],
      publishers: ['PlayStation Publishing LLC'],
      genres: ['Action', 'RPG', 'Open World'],
      links: { store: 'https://www.gog.com/game/horizon_zero_dawn_complete_edition' }
    },
    extra: { gogProductId: 1506604264 }
  }
]

/** Download size in bytes the fake install of an owned game reports, by game id (undefined = indeterminate). */
export function ownedGameBytes(gameId: string): number | undefined {
  const seed = OWNED.find((o) => `${o.source}:${o.externalId}` === gameId)
  return seed && seed.source !== 'xbox' ? seed.bytes : undefined
}

/**
 * Fresh Game records of the games `source`'s account owns but has not installed: `installed: false, owned: true`,
 * no install dir, `launch` set to the store's install URI form and `tracking: { mode: 'none' }` (the shape
 * `LibraryService.mergeOwned` creates), with the store's art already imported.
 */
export function ownedGames(source: StoreSourceId): Game[] {
  return OWNED.filter((o) => o.source === source).map((o) => {
    const game = buildGame({
      source: o.source,
      externalId: o.externalId,
      platformId: STORE_PLATFORMS[o.source].id,
      title: o.title,
      installed: false,
      launch: { kind: 'uri', uri: installUri(o.source, o.externalId) },
      tracking: { mode: 'none' },
      playtime: 0,
      storePlaytime: o.storePlaytime,
      lastPlayed: o.lastPlayed,
      playCount: 0,
      added: o.added,
      metadata: { ...o.metadata, updatedAt: daysAgo(3) },
      media: steamArt(o.art),
      metadataStatus: 'done',
      extra: o.extra
    })
    game.owned = true
    return game
  })
}

/** Install folder the fake install "creates" for an owned game. */
export function installDirFor(source: StoreSourceId, title: string): string {
  const folder = title.replace(/[:'"?*<>|]/g, '').trim()
  switch (source) {
    case 'steam':
      return `C:\\Program Files (x86)\\Steam\\steamapps\\common\\${folder}`
    case 'epic':
      return `C:\\Program Files\\Epic Games\\${folder}`
    case 'gog':
      return `C:\\Program Files (x86)\\GOG Galaxy\\Games\\${folder}`
    case 'ea':
      return `C:\\Program Files\\EA Games\\${folder}`
    case 'battlenet':
      return `C:\\Program Files (x86)\\${folder}`
    case 'ubisoft':
      return `C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\games\\${folder}`
    case 'xbox':
      return `C:\\XboxGames\\${folder}\\Content`
  }
}
