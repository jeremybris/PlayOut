import { describe, expect, it } from 'vitest'
import { buildPeerPartyCommand, peerPartyFailure } from './launch'

const base = {
  peerPartyExe: 'C:\\Data\\PeerParty\\peerparty.exe',
  logsDir: 'C:\\Data\\PeerParty\\logs',
  handoffDir: (d: string | undefined) => d
}

describe('buildPeerPartyCommand', () => {
  it('starts the game exe with the log folder, in the exe folder, with the Steam app id', () => {
    const cmd = buildPeerPartyCommand({
      ...base,
      gameExe: 'D:\\Games\\Portal 2\\portal2.exe',
      game: {
        source: 'steam',
        externalId: '620',
        installDir: 'D:\\Games\\Portal 2',
        launch: { kind: 'uri', uri: 'steam://rungameid/620' }
      },
      env: { PATH: 'x', PEERPARTY_GAME_ROOT: 'stale' }
    })
    expect(cmd.file).toBe(base.peerPartyExe)
    expect(cmd.args).toEqual(['--log-dir', base.logsDir, 'D:\\Games\\Portal 2\\portal2.exe'])
    expect(cmd.cwd).toBe('D:\\Games\\Portal 2')
    expect(cmd.env).toMatchObject({
      PATH: 'x',
      PEERPARTY_GAME_ROOT: 'D:\\Games\\Portal 2',
      SteamAppId: '620',
      SteamGameId: '620'
    })
  })

  it('passes the launch arguments only for the same program, and leaves out an unsafe game root', () => {
    const game = {
      source: 'manual' as const,
      externalId: 'x',
      installDir: 'D:\\',
      launch: { kind: 'exec' as const, file: 'D:\\Game\\Game.exe', args: ['-windowed'] }
    }
    const same = buildPeerPartyCommand({
      ...base,
      handoffDir: () => undefined,
      gameExe: 'd:\\game\\game.exe',
      game,
      env: { PEERPARTY_GAME_ROOT: 'stale' }
    })
    expect(same.args.slice(-1)).toEqual(['-windowed'])
    expect(same.env['PEERPARTY_GAME_ROOT']).toBeUndefined()
    expect(same.env['SteamAppId']).toBeUndefined()
    const other = buildPeerPartyCommand({ ...base, gameExe: 'D:\\Game\\Other.exe', game, env: {} })
    expect(other.args).toEqual(['--log-dir', base.logsDir, 'D:\\Game\\Other.exe'])
  })
})

describe('peerPartyFailure', () => {
  it("reads PeerParty's last error line", () => {
    expect(peerPartyFailure('noise\r\npeerparty: Steam is not running\r\n')).toBe(
      'Steam is not running'
    )
    expect(peerPartyFailure('nothing here')).toBeNull()
  })
})
