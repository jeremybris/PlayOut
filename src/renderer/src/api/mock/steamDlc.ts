// Steam DLC in the mock (main steam-dlc/): a few Steam games have made-up DLC lists so the install-time picker and
// Manage DLC can be tried. Cyberpunk 2077 (installed) shows every kind of row: installed, turned off, no download,
// Steam-only, plus two DLC the account does not own; Helldivers 2 (installed) has a long list of DLC without a
// download (scrolling, All on / All off); Red Dead Redemption 2 (not installed) has DLC with ownership unknown (the
// install-time picker); Resident Evil 4 cannot read its list (the error state, Install anyway). Other Steam games have
// no DLC, so their install starts straight away. Steam counts as running; a running game blocks applying.
import type { PlayOutApi } from '@shared/api'
import type { Game, SteamDlcInfo, SteamDlcItem } from '@shared/types'
import type { MockEmitter } from './emitter'

export type SteamDlcApi = Pick<PlayOutApi, 'steamDlc' | 'setSteamDlc' | 'openSteamDlcPage'>

export interface SteamDlcMockDeps {
  emitter: MockEmitter
  games: Map<string, Game>
  /** The title of the game running now, or null (applying a change closes Steam: never during a game). */
  runningTitle: () => string | null
  openExternal: (url: string) => Promise<void>
  log?: (...args: unknown[]) => void
}

export interface SteamDlcMock {
  api: SteamDlcApi
  /** A Steam game's install finished: apply the DLC turned off at install time ('steam-dlc:applied'). */
  installed(game: Game): void
}

const GB = 1024 ** 3
const MB = 1024 ** 2

interface DlcSeed {
  appId: number
  name: string
  sizeBytes: number | null
  owned?: boolean | null
  /** Turned off in Steam (installed games only). */
  off?: boolean
  installed?: boolean
  steamOnly?: boolean
}

/** Steam app id -> its DLC (owned and not), or 'error' for a list that cannot be read. */
const DLC: Record<number, DlcSeed[] | 'error'> = {
  // Cyberpunk 2077
  1091500: [
    {
      appId: 2138330,
      name: 'Cyberpunk 2077: Phantom Liberty',
      sizeBytes: 31 * GB,
      installed: true
    },
    {
      appId: 2060310,
      name: 'REDmod',
      sizeBytes: Math.round(6.3 * GB),
      steamOnly: true,
      off: true
    },
    {
      appId: 1477390,
      name: 'Cyberpunk 2077: Bonus Content',
      sizeBytes: Math.round(1.4 * GB),
      off: true
    },
    { appId: 1477391, name: 'Cyberpunk 2077: Digital Goodies', sizeBytes: null },
    { appId: 1477392, name: 'Cyberpunk 2077: Original Score', sizeBytes: 820 * MB, owned: false },
    { appId: 1477393, name: 'Cyberpunk 2077: Art Book', sizeBytes: 210 * MB, owned: false }
  ],
  // Helldivers 2: many warbonds, none with a download of its own
  553850: [
    'Polar Patriots',
    'Viper Commandos',
    'Freedom’s Flame',
    'Chemical Agents',
    'Truth Enforcers',
    'Urban Legends',
    'Servants of Freedom',
    'Borderline Justice',
    'Masters of Ceremony',
    'Force of Law',
    'Control Group',
    'Dust Devils'
  ].map((name, i) => ({
    appId: 2817200 + i,
    name: `HELLDIVERS 2 - ${name}`,
    sizeBytes: null,
    off: i === 3
  })),
  // Red Dead Redemption 2 (owned, not installed): ownership of its DLC is unknown here
  1174180: [
    {
      appId: 1404210,
      name: 'Red Dead Redemption 2: Story Mode Bonus Pack',
      sizeBytes: null,
      owned: null
    },
    {
      appId: 1404211,
      name: 'Red Dead Redemption 2: Ultimate Edition Content',
      sizeBytes: Math.round(2.4 * GB),
      owned: null
    },
    {
      appId: 1404212,
      name: 'Red Dead Redemption 2: Pre-Order Bonus',
      sizeBytes: Math.round(1.2 * GB),
      owned: null
    },
    {
      appId: 1404213,
      name: 'Red Dead Online: Workshop Tools',
      sizeBytes: 900 * MB,
      owned: null,
      steamOnly: true
    }
  ],
  // Resident Evil 4 (2023)
  2050650: 'error'
}

interface DlcState {
  /** UserConfig.DisabledDLC of an installed game. */
  disabled: Set<number>
  installed: Set<number>
  /** Turned off at install time, applied when the install finishes. */
  planned: number[] | null
}

export function createSteamDlcMock(deps: SteamDlcMockDeps): SteamDlcMock {
  const log = deps.log ?? (() => undefined)
  const state = new Map<string, DlcState>()

  const steamGame = (gameId: string): Game => {
    const game = deps.games.get(gameId)
    if (!game) throw new Error(`Unknown game ${gameId}`)
    if (game.source !== 'steam') throw new Error(`${game.title} is not a Steam game`)
    return game
  }
  const appIdOf = (game: Game): number => Number(game.externalId)
  const seedsOf = (game: Game): DlcSeed[] | 'error' => DLC[appIdOf(game)] ?? []
  const stateOf = (game: Game): DlcState => {
    let s = state.get(game.id)
    if (!s) {
      const seeds = seedsOf(game)
      const list = seeds === 'error' ? [] : seeds.filter((d) => d.owned !== false)
      s = {
        disabled: new Set(game.installed ? list.filter((d) => d.off).map((d) => d.appId) : []),
        installed: new Set(
          game.installed ? list.filter((d) => d.installed).map((d) => d.appId) : []
        ),
        planned: null
      }
      state.set(game.id, s)
    }
    return s
  }
  const blocked = (): string | null => {
    const title = deps.runningTitle()
    return title ? `${title} is running. Quit it first: PlayOut closes Steam to apply this.` : null
  }

  const info = (game: Game): SteamDlcInfo => {
    const seeds = seedsOf(game)
    const base = {
      gameId: game.id,
      appId: appIdOf(game),
      installed: game.installed,
      steamRunning: true,
      blocked: game.installed ? blocked() : null
    }
    if (seeds === 'error')
      return {
        ...base,
        dlc: [],
        notOwnedCount: 0,
        plannedDisabled: null,
        error: 'Could not read the DLC list from Steam’s info service. (mock)'
      }
    const s = stateOf(game)
    const owned = seeds.filter((d) => d.owned !== false)
    const dlc: SteamDlcItem[] = owned
      .map((d) => ({
        appId: d.appId,
        name: d.name,
        sizeBytes: d.sizeBytes,
        owned: d.owned === null ? null : true,
        enabled: !s.disabled.has(d.appId),
        installed: s.installed.has(d.appId),
        pending: false,
        steamOnly: !!d.steamOnly
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
    return {
      ...base,
      dlc,
      notOwnedCount: seeds.length - owned.length,
      plannedDisabled: s.planned ? [...s.planned] : null
    }
  }

  /** Steam applies the choice: content of DLC turned on is downloaded, of DLC turned off removed. */
  const apply = (game: Game, disabled: number[]): void => {
    const s = stateOf(game)
    const seeds = seedsOf(game)
    s.disabled = new Set(disabled)
    if (seeds === 'error') return
    for (const d of seeds) {
      if (d.owned === false || d.sizeBytes === null || d.steamOnly) continue
      if (s.disabled.has(d.appId)) s.installed.delete(d.appId)
      else s.installed.add(d.appId)
    }
  }

  return {
    api: {
      async steamDlc(gameId) {
        return info(steamGame(gameId))
      },
      async setSteamDlc(gameId, disabled) {
        const game = steamGame(gameId)
        if (seedsOf(game) === 'error')
          return {
            ok: false,
            error: 'Could not read the DLC list from Steam’s info service. (mock)'
          }
        const steamOnly = new Set(
          (seedsOf(game) as DlcSeed[]).filter((d) => d.steamOnly).map((d) => d.appId)
        )
        // Steam-only DLC keep their state: only Steam's own page changes them.
        const keep = [...stateOf(game).disabled].filter((id) => steamOnly.has(id))
        const wanted = [...new Set([...disabled.filter((id) => !steamOnly.has(id)), ...keep])]
        if (!game.installed) {
          stateOf(game).planned = wanted.length ? wanted : null
          log(`steam dlc ${game.title}: ${wanted.length} turned off at install`)
          return { ok: true, planned: true }
        }
        const why = blocked()
        if (why) return { ok: false, error: why }
        apply(game, wanted)
        log(`steam dlc ${game.title}: closed and reopened Steam, ${wanted.length} turned off`)
        return { ok: true, restartedSteam: true }
      },
      async openSteamDlcPage(gameId) {
        await deps.openExternal(`steam://nav/games/details/${appIdOf(steamGame(gameId))}`)
      }
    },
    installed(game) {
      if (game.source !== 'steam') return
      const s = state.get(game.id)
      const seeds = seedsOf(game)
      // Steam installs every owned DLC with the game; the picks made at install time are applied after it.
      if (seeds !== 'error') {
        const fresh = stateOf(game)
        for (const d of seeds)
          if (d.owned !== false && d.sizeBytes !== null && !d.steamOnly)
            fresh.installed.add(d.appId)
      }
      if (!s?.planned) return
      apply(game, s.planned)
      s.planned = null
      deps.emitter.emit('steam-dlc:applied', {
        gameId: game.id,
        title: game.user.titleOverride || game.title,
        ok: true
      })
    }
  }
}
