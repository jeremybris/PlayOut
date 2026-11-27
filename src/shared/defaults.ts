import type { Settings, SourceId } from './types'

function sourceDefaults(): Record<SourceId, { enabled: boolean }> {
  return {
    steam: { enabled: true },
    epic: { enabled: true },
    gog: { enabled: true },
    ea: { enabled: true },
    battlenet: { enabled: true },
    ubisoft: { enabled: true },
    xbox: { enabled: true },
    manual: { enabled: true },
    rom: { enabled: true }
  }
}

/**
 * settings.json schema version. 1: the original file; 2: store accounts (`library.showUninstalled` defaults to true
 * and a version-1 `false` is migrated, `store/settings-schema.ts`); 3: Dynamic TDP (`performance.defaultProfile`
 * defaults to 'auto' and an older 'none', written by every build without the user choosing it, is migrated).
 */
export const SETTINGS_VERSION = 4

/**
 * Streaming: PlayOut's host service listens on this TCP port (pairing, library, art, ROM downloads) and answers LAN
 * discovery on UDP port + 1. Sunshine keeps its own ports (47984-48010).
 */
export const STREAMING_HOST_PORT = 47900

/** Fresh default settings. Both the main process and the browser mock start from this. */
export function defaultSettings(): Settings {
  return {
    version: SETTINGS_VERSION,
    library: {
      romsRoot: null,
      // Owned store games that are not installed show greyed out (Settings > Library "Show games that are not installed").
      showUninstalled: true,
      showHidden: false,
      // One card per game (Settings > Library "Show duplicates" off).
      showDuplicates: false,
      sources: sourceDefaults(),
      esdeHome: null,
      // null: PlayOut's own Emulation folder in its settings folder (made at launch).
      emulationDir: null,
      coopKeyboardMouse: false,
      coopTwoPlayerLayout: 'stacked',
      // New ROM games keep their format (Settings > Library "Trim Games" off).
      trimGames: false,
      copyPcSaves: true,
      // No filters of the user's own yet (a game's options menu > Create a filter).
      customFilters: []
    },
    emulators: {
      overrides: {},
      coresDir: null,
      preferred: {},
      ps3AutoUpdate: true
    },
    scrapers: {
      steamgriddb: { apiKey: '' },
      igdb: { clientId: '', clientSecret: '' },
      screenscraper: { devId: '', devPassword: '', user: '', password: '' },
      thegamesdb: { apiKey: '' },
      steam: { apiKey: '', steamId64: '' },
      retroachievements: { username: '', apiKey: '' },
      hltb: { enabled: true },
      steamTags: { enabled: true },
      gameDatabase: { enabled: true, contribute: true },
      autoScrape: true,
      region: 'us',
      language: 'en',
      artPriority: ['steamgriddb', 'steam', 'screenscraper', 'thegamesdb', 'igdb', 'gog'],
      localArt: true
    },
    ui: {
      startFullscreen: true,
      clock24h: false,
      recentCount: 12,
      homeRow: 'recent',
      animations: true,
      minimizeWhilePlaying: true,
      libraryTabs: null,
      libraryTab: '',
      libraryPositions: {},
      libraryScroll: {},
      libraryCoverScale: 1
    },
    input: {
      deadzone: 0.25,
      vibration: true,
      swapAB: false,
      repeatDelayMs: 400,
      repeatRateMs: 120,
      homeButtonEnabled: true,
      homeCombo: ['guide'],
      homeHoldMs: 0,
      keyboardCombo: [],
      homeOverrideSteam: true,
      homeOverrideGameBar: true,
      homePauseGame: true,
      touchSwipeOverlay: true,
      ingameOverlay: true,
      ingameNever: []
    },
    performance: {
      defaultProfile: 'auto',
      profiles: {
        silent: {
          powerMode: 'efficiency',
          cpuMaxPercent: 60,
          cpuBoost: false,
          watts: null,
          boostWatts: null
        },
        balanced: {
          powerMode: 'balanced',
          cpuMaxPercent: 100,
          cpuBoost: true,
          watts: null,
          boostWatts: null
        },
        performance: {
          powerMode: 'performance',
          cpuMaxPercent: 100,
          cpuBoost: true,
          watts: null,
          boostWatts: null
        },
        custom: {
          powerMode: 'balanced',
          cpuMaxPercent: 85,
          cpuBoost: true,
          watts: null,
          boostWatts: null
        }
      },
      perGame: true,
      useWatts: true,
      dynamic: { targetFps: 60, minWatts: null, maxWatts: null },
      perfOverlay: 0,
      syncFpsToRefresh: false,
      boostOverrides: {},
      memory: { enabled: false }
    },
    music: {
      folder: null,
      gameStart: 'keep',
      volume: 0.6,
      muted: false
    },
    system: {
      // Not chosen yet: the first start picks Steam's or Windows' language (main/i18n).
      language: '',
      launchAtLogin: false,
      confirmPowerActions: true,
      minimizeToTray: false,
      enhancedSleepWake: true,
      controllerWake: false
    },
    streaming: {
      // On for a new install: other PlayOut computers on the network can find and pair with this one (a PIN shown
      // here is still needed). Existing settings keep their own value.
      hostEnabled: true,
      hostPort: STREAMING_HOST_PORT,
      showHostGames: true,
      resolution: 'auto',
      fps: 60,
      bitrateKbps: 0,
      syncEmulation: true,
      shareLogins: true,
      syncLibraryTabs: true,
      syncFavorites: true,
      syncPlaytime: true
    }
  }
}
