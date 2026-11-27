import { dirname, resolve } from 'path'
import type { Game } from '../../shared/types'

/**
 * The command that starts a game through PeerParty: `peerparty.exe --log-dir <logs> <game.exe> [game args]`. PeerParty
 * stays running until the last of the game's programs ends and then returns the game's exit code, so PlayOut tracks it
 * as the spawned process (its children are the game) and also watches the game's folder (an Xbox app game is started
 * by Windows, not by PeerParty).
 */

export interface PeerPartyCommand {
  file: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

const samePath = (a: string, b: string): boolean =>
  resolve(a).toLowerCase() === resolve(b).toLowerCase()

/**
 * `peerPartyExe` is PlayOut's copy, `gameExe` the program resolvePeerPartyExe chose. The game's own launch arguments
 * go along only when PlayOut starts that same program itself (an exec launch). A Steam game gets SteamAppId and
 * SteamGameId (PeerParty finds the app id from them when the game is not started by Steam). PEERPARTY_GAME_ROOT names
 * the game's folder when it is a safe one (`handoffDir` gives undefined for a drive root or a system folder).
 */
export function buildPeerPartyCommand(input: {
  peerPartyExe: string
  logsDir: string
  gameExe: string
  game: Pick<Game, 'source' | 'externalId' | 'installDir' | 'launch'>
  env: NodeJS.ProcessEnv
  handoffDir: (dir: string | undefined) => string | undefined
}): PeerPartyCommand {
  const { game } = input
  const gameArgs =
    game.launch.kind === 'exec' && samePath(game.launch.file, input.gameExe) ? game.launch.args : []
  const env: NodeJS.ProcessEnv = { ...input.env }
  const root = input.handoffDir(game.installDir)
  if (root) env['PEERPARTY_GAME_ROOT'] = root
  else delete env['PEERPARTY_GAME_ROOT']
  if (game.source === 'steam' && /^\d+$/.test(game.externalId)) {
    env['SteamAppId'] = game.externalId
    env['SteamGameId'] = game.externalId
  }
  return {
    file: input.peerPartyExe,
    args: ['--log-dir', input.logsDir, input.gameExe, ...gameArgs],
    cwd: dirname(input.gameExe),
    env
  }
}

/** PeerParty's own failure line (`peerparty: <error>`) in what it wrote to stderr, else null. */
export function peerPartyFailure(stderr: string): string | null {
  const lines = stderr.split(/\r?\n/).reverse()
  for (const line of lines) {
    const m = /^\s*peerparty:\s*(.+?)\s*$/i.exec(line)
    if (m) return m[1]!
  }
  return null
}
