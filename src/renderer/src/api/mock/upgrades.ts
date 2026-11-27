// Upgrades in the mock (main upgrades/): an NVIDIA GeForce RTX 4070 runs the games. Cyberpunk 2077 ships DLSS, DLSS
// Frame Generation, FSR 3.1 and XeSS files older than the newest, so Update / Restore can be tried; Helldivers 2 has
// multiplayer Steam tags and GameGuard in its folder (the ban-risk warning); every other installed PC game has no
// upscaler files. Actions run on timers and emit 'upgrades:progress' like main does.
import type { PlayOutApi } from '@shared/api'
import type { Game } from '@shared/types'
import {
  riskTagsOf,
  upgradeOf,
  type DllKindSummary,
  type FoundUpscalerDll,
  type UpgradeAction,
  type UpgradeId,
  type UpgradeStatus
} from '@shared/upgrades'
import type { MockEmitter } from './emitter'

export type UpgradesApi = Pick<PlayOutApi, 'upgradeStatus' | 'runUpgrade' | 'cancelUpgrade'>

export interface UpgradesMockDeps {
  emitter: MockEmitter
  games: Map<string, Game>
  log?: (...args: unknown[]) => void
}

const GB = 1024 ** 3

const LATEST = {
  dlss: '310.9.16.0',
  dlssg: '310.9.16.0',
  'fsr-dx12': '1.0.1.41314',
  xess: '2.0.2.68'
} as const

/** FSR 3.1 files by their FSR version (main's dlls.ts knows the whole list); others without a trailing ".0". */
const FSR_VERSIONS: Record<string, string> = { '1.0.0.33896': '3.1.0', '1.0.1.41314': '3.1.4' }

/** A file version as the menu shows it (main's service displayVersion, for the mock's files). */
function displayOf(kind: string, version: string): string {
  if (kind.startsWith('fsr') && FSR_VERSIONS[version]) return FSR_VERSIONS[version]!
  return version.replace(/\.0$/, '')
}

/** Per game: what the mock remembers between calls. */
interface MockGameState {
  found: FoundUpscalerDll[]
  optiscaler: UpgradeStatus['optiscaler']['installed']
  compiledAt: string | null
  compressed: 'none' | 'partial' | 'compressed'
  antiCheat: string[]
}

function seed(game: Game): MockGameState {
  const cyberpunk = game.title === 'Cyberpunk 2077'
  return {
    found: cyberpunk
      ? [
          {
            kind: 'dlss',
            relPath: 'bin\\x64\\nvngx_dlss.dll',
            version: '3.5.10.0',
            swapped: false
          },
          {
            kind: 'dlssg',
            relPath: 'bin\\x64\\nvngx_dlssg.dll',
            version: '3.5.10.0',
            swapped: false
          },
          {
            kind: 'fsr-dx12',
            relPath: 'bin\\x64\\amd_fidelityfx_dx12.dll',
            version: '1.0.0.33896',
            swapped: false
          },
          { kind: 'xess', relPath: 'bin\\x64\\libxess.dll', version: '1.3.0.28', swapped: false }
        ]
      : [],
    optiscaler: null,
    compiledAt: null,
    compressed: 'none',
    antiCheat: game.title === 'Helldivers 2' ? ['nProtect GameGuard'] : []
  }
}

export function createUpgradesMock({ emitter, games, log }: UpgradesMockDeps): {
  api: UpgradesApi
} {
  const states = new Map<string, MockGameState>()
  const busy = new Map<string, { upgrade: UpgradeId; timer: ReturnType<typeof setInterval> }>()

  const stateOf = (game: Game): MockGameState => {
    let s = states.get(game.id)
    if (!s) {
      s = seed(game)
      states.set(game.id, s)
    }
    return s
  }

  const statusOf = (game: Game): UpgradeStatus => {
    const s = stateOf(game)
    const meta = game.metadata
    const tags = riskTagsOf([
      ...(meta.steamTags?.tags ?? []),
      ...(meta.genres ?? []),
      ...(meta.tags ?? [])
    ])
    const latest: UpgradeStatus['dlls']['latest'] = {}
    for (const f of s.found) latest[f.kind] = LATEST[f.kind as keyof typeof LATEST] ?? null
    const updatable = s.found.some(
      (f) => !f.swapped && latest[f.kind] && f.version !== latest[f.kind]
    )
    const kinds: DllKindSummary[] = [...new Set(s.found.map((f) => f.kind))].map((kind) => {
      const file = s.found.find((f) => f.kind === kind)!
      const newest = latest[kind] ?? null
      return {
        kind,
        version: file.version ? displayOf(kind, file.version) : null,
        latest: newest ? displayOf(kind, newest) : null,
        updatable: !file.swapped && !!newest && file.version !== newest
      }
    })
    const size = (game.installSize?.bytes ?? 64 * GB) || 64 * GB
    return {
      gameId: game.id,
      gpu: { vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4070', rtxSeries: 40, driver: '581.57' },
      risk: { tags, antiCheat: s.antiCheat },
      blocked: null,
      dlls: {
        found: s.found,
        kinds,
        latest,
        updatable,
        restorable: s.found.some((f) => f.swapped)
      },
      dlss5: { unavailable: null, appReady: false },
      shaders: { unavailable: null, compiledAt: s.compiledAt, note: null },
      optiscaler: {
        installed: s.optiscaler,
        latest: '0.9.5',
        hasInputs: s.found.length > 0
      },
      compress: {
        state: s.compressed,
        size,
        onDisk: s.compressed === 'none' ? size : Math.round(size * 0.74),
        estimatedSaving: 0.26,
        unavailable: null
      },
      busy: busy.get(game.id)?.upgrade ?? null,
      scanning: false
    }
  }

  const gameOf = (gameId: string): Game => {
    const game = games.get(gameId)
    if (!game) throw new Error('Unknown game')
    return game
  }

  /** Runs `finish` after a few progress ticks, like a real upgrade. */
  const simulate = (
    game: Game,
    upgrade: UpgradeId,
    steps: string[],
    finish: () => string
  ): void => {
    let i = 0
    const emit = (
      state: 'running' | 'done' | 'failed',
      progress: number | null,
      message: string
    ): void =>
      emitter.emit('upgrades:progress', { gameId: game.id, upgrade, state, progress, message })
    emit('running', 0, steps[0] ?? 'Working…')
    const timer = setInterval(() => {
      i++
      if (i < steps.length) {
        emit('running', i / steps.length, steps[i]!)
        return
      }
      clearInterval(timer)
      busy.delete(game.id)
      emit('done', 1, finish())
    }, 700)
    busy.set(game.id, { upgrade, timer })
  }

  const api: UpgradesApi = {
    async upgradeStatus(gameId) {
      return statusOf(gameOf(gameId))
    },
    async runUpgrade(gameId, action: UpgradeAction) {
      const game = gameOf(gameId)
      const s = stateOf(game)
      if (busy.has(gameId)) throw new Error('An upgrade is already running for this game.')
      log?.('mock runUpgrade', gameId, action)
      const upgrade = upgradeOf(action)
      switch (action.kind) {
        case 'dlls-update':
          simulate(
            game,
            upgrade,
            ['Downloading DLSS 310.9.16…', 'Checking signatures…', 'Replacing files…'],
            () => {
              s.found = s.found.map((f) => ({
                ...f,
                swapped: true,
                version: LATEST[f.kind as keyof typeof LATEST] ?? f.version
              }))
              return `${game.title}: DLSS, FSR and XeSS updated`
            }
          )
          break
        case 'dlls-restore':
          s.found = seed(game).found
          emitter.emit('upgrades:progress', {
            gameId,
            upgrade,
            state: 'done',
            progress: 1,
            message: `${game.title}: original files restored`
          })
          break
        case 'dlss5-open':
          simulate(
            game,
            upgrade,
            ['Downloading DLSS AiO Swapper…'],
            () => 'DLSS AiO Swapper opened'
          )
          break
        case 'shaders-compile':
          simulate(
            game,
            upgrade,
            [
              'Downloading SCSKiller…',
              'Reading shaders…',
              'Compiling 1,204 of 4,816…',
              'Compiling 3,611 of 4,816…'
            ],
            () => {
              s.compiledAt = new Date().toISOString()
              return `${game.title}: 4,816 shaders precompiled`
            }
          )
          break
        case 'optiscaler-install':
          simulate(game, upgrade, ['Downloading OptiScaler 0.9.5…', 'Installing…'], () => {
            s.optiscaler = { relDir: 'bin\\x64', asName: 'dxgi.dll', version: '0.9.5' }
            return `${game.title}: OptiScaler installed (press Insert in the game for its menu)`
          })
          break
        case 'optiscaler-remove':
          s.optiscaler = null
          emitter.emit('upgrades:progress', {
            gameId,
            upgrade,
            state: 'done',
            progress: 1,
            message: `${game.title}: OptiScaler removed`
          })
          break
        case 'compress':
          simulate(
            game,
            upgrade,
            ['Compressing 12%…', 'Compressing 48%…', 'Compressing 87%…'],
            () => {
              s.compressed = 'compressed'
              return `${game.title} compressed`
            }
          )
          break
        case 'uncompress':
          simulate(game, upgrade, ['Uncompressing…'], () => {
            s.compressed = 'none'
            return `${game.title} uncompressed`
          })
          break
      }
      return statusOf(game)
    },
    async cancelUpgrade(gameId) {
      const running = busy.get(gameId)
      if (!running) return
      clearInterval(running.timer)
      busy.delete(gameId)
      emitter.emit('upgrades:progress', {
        gameId,
        upgrade: running.upgrade,
        state: 'failed',
        progress: null,
        message: 'Stopped'
      })
    }
  }
  return { api }
}
