// PeerParty in the mock (main/peerparty): an installed PC game with a multiplayer tag and no competitive tags is offered
// LAN play when its store's multiplayer service is one PeerParty covers (Steam games use Steamworks and Epic Online
// Services, Epic and EA games EOS, GOG games GOG Galaxy, Xbox app games the Xbox app). Helldivers 2 and Elden Ring have
// anti-cheat in their folders, so they are not. A game's first status answers `checking` and the scan's result follows
// as 'peerparty:status'. The first start downloads PeerParty (progress events), later ones start at once; the game then
// runs as a normal session with a 'peerparty:session' beside it. The overlay's PeerParty tab: a session started with
// `peerparty=1` has LAN play on with 2 players; one started from the game page is "Starting…" for a few seconds, then
// on with 1 player. The LAN invite is "sent" while a session runs.
import type { PlayOutApi } from '@shared/api'
import {
  peerPartyBlockTags,
  peerPartyHasMultiplayer,
  type PeerPartyBlock,
  type PeerPartyProgress,
  type PeerPartyService,
  type PeerPartySession,
  type PeerPartyStatus
} from '@shared/peerparty'
import type { Game } from '@shared/types'
import type { MockEmitter } from './emitter'

export type PeerPartyApi = Pick<
  PlayOutApi,
  | 'peerPartyStatus'
  | 'playWithPeerParty'
  | 'peerPartyCompatible'
  | 'peerPartySession'
  | 'peerPartyOverlay'
  | 'peerPartyInvite'
>

export interface PeerPartyMockDeps {
  emitter: MockEmitter
  games: Map<string, Game>
  /** Start a play session of the game; returns why it could not (another game runs), else null. */
  startSession: (gameId: string) => string | null
  /** `peerparty=1` with `overlay=1`: the game already running under the overlay preview runs through PeerParty. */
  runningGameId?: () => string | null
  startWithSession?: boolean
  log?: (...args: unknown[]) => void
}

/** The release tag the mock "downloads". */
export const MOCK_PEERPARTY_VERSION = 'v0.5.1'

/** How long a session started in the mock shows "Starting…" in the overlay's PeerParty tab. */
const MOCK_LAN_STARTING_MS = 4000

/** Anti-cheat the mock finds in these games' folders. */
const ANTI_CHEAT: Record<string, string[]> = {
  'Helldivers 2': ['GameGuard'],
  'Elden Ring': ['Easy Anti-Cheat']
}

const REASONS: Record<PeerPartyBlock, string> = {
  remote: 'It is a game of another PC.',
  rom: 'It is played in an emulator.',
  recomp: 'It is a recompilation.',
  'not-installed': 'It is not installed.',
  'no-folder': 'Its folder is not known.',
  competitive: 'It is a competitive online game.',
  'no-multiplayer': 'It has no multiplayer.',
  'anti-cheat': 'It uses anti-cheat.',
  'anti-cheat-unknown': 'Its folder could not be checked for anti-cheat.',
  'no-exe': 'Its program was not found.',
  'no-service': 'It uses no multiplayer service PeerParty covers.'
}

/** The multiplayer services the mock "finds" in a game's folder, by its store. */
function servicesOf(game: Game): PeerPartyService[] {
  switch (game.source) {
    case 'steam':
      return ['steamworks', 'eos']
    case 'epic':
    case 'ea':
      return ['eos']
    case 'gog':
      return ['galaxy']
    case 'xbox':
      return ['xbox']
    default:
      return []
  }
}

/** Why the game is not offered PeerParty (the same order of checks as main's eligibility.ts), else null. */
export function mockPeerPartyBlock(game: Game): PeerPartyBlock | null {
  if (game.remote) return 'remote'
  if (game.source === 'rom' || game.launch.kind === 'emulator') return 'rom'
  if (!game.installed) return 'not-installed'
  if (!game.installDir) return 'no-folder'
  if (peerPartyBlockTags(game).length) return 'competitive'
  if (!peerPartyHasMultiplayer(game)) return 'no-multiplayer'
  if (game.metadata.steamTags?.vac) return 'anti-cheat'
  if (ANTI_CHEAT[game.title]) return 'anti-cheat'
  if (servicesOf(game).length === 0) return 'no-service'
  return null
}

export function createPeerPartyMock(deps: PeerPartyMockDeps): { api: PeerPartyApi } {
  const { emitter, games } = deps
  const log = deps.log ?? (() => undefined)
  const scanned = new Set<string>()
  let installedVersion: string | null = null
  let busy: PeerPartyProgress | null = null
  let session: PeerPartySession | null = null
  /** Players the overlay's PeerParty tab counts for the session (`peerparty=1`: 2). */
  let players = 1

  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  function statusOf(game: Game): PeerPartyStatus {
    const blocked = mockPeerPartyBlock(game)
    return {
      gameId: game.id,
      supported: blocked === null,
      checking: false,
      services: blocked === null || blocked === 'anti-cheat' ? servicesOf(game) : [],
      blocked,
      reason: blocked ? REASONS[blocked] : null,
      antiCheat: ANTI_CHEAT[game.title] ?? [],
      exe: game.installDir ? `${game.installDir}\\${game.title.replace(/[^\w]+/g, '')}.exe` : null,
      installedVersion,
      busy: busy && busy.gameId === game.id ? busy : null,
      running: session?.gameId === game.id
    }
  }

  function progress(p: PeerPartyProgress): void {
    busy = p.phase === 'done' || p.phase === 'failed' ? null : p
    emitter.emit('peerparty:progress', p)
  }

  function setSession(next: PeerPartySession | null): void {
    session = next
    emitter.emit('peerparty:session', { session })
  }

  // The game's session ended (the mock's sessions end on their own): PeerParty ends with it.
  emitter.on('session:ended', ({ gameId }) => {
    if (session?.gameId === gameId) setSession(null)
  })

  if (deps.startWithSession) {
    const gameId = deps.runningGameId?.()
    const game = gameId ? games.get(gameId) : undefined
    if (game) {
      installedVersion = MOCK_PEERPARTY_VERSION
      session = {
        gameId: game.id,
        title: game.user.titleOverride || game.title,
        // Started a minute ago: LAN play is on already.
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        exe: statusOf(game).exe ?? 'Game.exe'
      }
      players = 2
    }
  }

  const api: PeerPartyApi = {
    async peerPartyStatus(gameId) {
      const game = games.get(gameId)
      if (!game) throw new Error(`Unknown game: ${gameId}`)
      const status = statusOf(game)
      // The first look at an eligible-looking game scans its folder: `checking` now, the result shortly.
      if (!scanned.has(gameId) && !game.remote && game.installed) {
        scanned.add(gameId)
        setTimeout(() => emitter.emit('peerparty:status', statusOf(game)), 600)
        return { ...status, supported: false, checking: true, blocked: null, reason: null }
      }
      return status
    },

    async playWithPeerParty(gameId) {
      const game = games.get(gameId)
      if (!game) throw new Error(`Unknown game: ${gameId}`)
      const title = game.user.titleOverride || game.title
      const blocked = mockPeerPartyBlock(game)
      if (blocked)
        return {
          ok: false,
          error: { kind: 'failed', message: `${title} cannot use PeerParty. ${REASONS[blocked]}` }
        }
      if (!installedVersion) {
        progress({ gameId, phase: 'checking' })
        await delay(300)
        const total = 33_460_224
        for (let percent = 0; percent <= 100; percent += 10) {
          progress({
            gameId,
            phase: 'downloading',
            percent,
            bytesDone: Math.round((total * percent) / 100),
            bytesTotal: total
          })
          await delay(150)
        }
        progress({ gameId, phase: 'verifying' })
        await delay(300)
        progress({ gameId, phase: 'installing' })
        await delay(200)
        installedVersion = MOCK_PEERPARTY_VERSION
      }
      progress({ gameId, phase: 'starting' })
      await delay(400)
      const problem = deps.startSession(gameId)
      if (problem) {
        progress({ gameId, phase: 'failed', message: problem })
        return { ok: false, error: { kind: 'failed', message: problem } }
      }
      const startedAt = new Date().toISOString()
      progress({ gameId, phase: 'done' })
      setSession({ gameId, title, startedAt, exe: statusOf(game).exe ?? 'Game.exe' })
      emitter.emit('peerparty:status', statusOf(game))
      log(`peerparty: started ${title}`)
      return { ok: true, startedAt }
    },

    async peerPartyCompatible() {
      // The mock "scans" every folder at once.
      const ids = [...games.values()].filter((g) => mockPeerPartyBlock(g) === null).map((g) => g.id)
      return { ids, scanning: false }
    },

    async peerPartySession() {
      return session
    },

    async peerPartyOverlay() {
      if (!session) return { active: false, lan: 'off' }
      const age = Date.now() - Date.parse(session.startedAt)
      return age < MOCK_LAN_STARTING_MS
        ? { active: true, gameTitle: session.title, lan: 'starting' }
        : { active: true, gameTitle: session.title, lan: 'on', players }
    },

    async peerPartyInvite() {
      await delay(500)
      log(`peerparty: invite ${session ? 'sent' : 'not taken'}`)
      return session ? { result: 'sent' } : { result: 'none' }
    }
  }
  return { api }
}
