import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import type { PeerPartySession } from '../../shared/peerparty'
import type { PeerPartyInviteAnswer } from '../overlay/ingame/helper'
import {
  INVITE_MESSAGES,
  LAN_STARTING_MS,
  createPeerPartyOverlay,
  gameTag,
  inviteResult,
  nodeBoardIo,
  overlayStatus,
  parseBoardFile,
  parseBoardName,
  parseHeardFile,
  readBoard,
  type BoardIo
} from './overlay'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

const GAME = 'steam:1145360'
const OTHER_GAME = 'steam:892970'
const ME = '0123456789abcdef0123456789abcdef'
const TWIN = 'fedcba9876543210fedcba9876543210'
const FAR = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const FAR2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const DIR = 'C:\\PlayOut\\PeerParty\\peerparty-data\\peers'

/** A `.peer` file as PeerParty writes it (core/src/mesh.rs `Board::open`). */
const peerFile = (game: string): string => `${game}\n47590\n51234\n`
const peerName = (id: string, game: string): string => `${id}.${gameTag(game)}.peer`
const heardName = (id: string, game: string): string => `${id}.${gameTag(game)}.heard`

/** A board folder in memory: files by name, and the ones a running copy holds. */
function fakeIo(files: Record<string, string>, held: string[]): BoardIo {
  return {
    readdir: async (dir) => {
      if (dir !== DIR) throw Object.assign(new Error('no folder'), { code: 'ENOENT' })
      return Object.keys(files)
    },
    readFile: async (path) => {
      const name = path.slice(DIR.length + 1)
      const text = files[name]
      if (text === undefined) throw Object.assign(new Error('gone'), { code: 'ENOENT' })
      return text
    },
    held: async (path) => held.includes(path.slice(DIR.length + 1))
  }
}

describe('PeerParty board files', () => {
  it('reads board file names and game tags as PeerParty makes them', () => {
    // core/src/id.rs game_tag: the first 6 bytes of the key's SHA-256.
    expect(gameTag('steam:1145360')).toMatch(/^[0-9a-f]{12}$/)
    expect(gameTag('a')).toBe('ca978112ca1b')
    expect(parseBoardName(`${ME}.ca978112ca1b.peer`)).toEqual({
      id: ME,
      tag: 'ca978112ca1b',
      kind: 'peer'
    })
    expect(parseBoardName(`${ME.toUpperCase()}.CA978112CA1B.heard`)).toEqual({
      id: ME,
      tag: 'ca978112ca1b',
      kind: 'heard'
    })
    for (const name of [
      'readme.txt',
      `${ME}.peer`,
      `${ME}.ca97.peer`,
      `${ME}.ca978112ca1b.peer.tmp`
    ])
      expect(parseBoardName(name)).toBeNull()
  })

  it('reads a .peer file and refuses anything else', () => {
    expect(parseBoardFile(peerFile(GAME))).toEqual({
      game: GAME,
      discoveryPort: 47590,
      tcpPort: 51234
    })
    expect(parseBoardFile(`${GAME}\r\n47590\r\n51234`)).toEqual({
      game: GAME,
      discoveryPort: 47590,
      tcpPort: 51234
    })
    expect(parseBoardFile('')).toBeNull()
    expect(parseBoardFile(`${GAME}\n47590\n`)).toBeNull()
    expect(parseBoardFile(`${GAME}\n47590\n99999\n`)).toBeNull()
    expect(parseBoardFile(`${GAME}\nport\n51234\n`)).toBeNull()
    expect(parseBoardFile(`${GAME}\n47590\n51234\nmore\n`)).toBeNull()
  })

  it('takes only the ids of a .heard file, never the addresses', () => {
    const text = `${FAR} 192.168.1.20 50001\n${FAR2} 192.168.1.21 50002\n${FAR} 192.168.1.20 50001\n`
    expect(parseHeardFile(text)).toEqual([FAR, FAR2])
    expect(parseHeardFile('')).toEqual([])
    expect(parseHeardFile(`${FAR} 192.168.1.20\n`)).toBeNull()
    expect(parseHeardFile(`not-an-id 192.168.1.20 50001\n`)).toBeNull()
    expect(parseHeardFile(`${FAR} 192.168.1.20 50001 extra\n`)).toBeNull()
  })
})

describe('readBoard', () => {
  it('counts this PC and the players heard from other PCs, for live copies only', async () => {
    const io = fakeIo(
      {
        [peerName(ME, GAME)]: peerFile(GAME),
        [heardName(ME, GAME)]: `${FAR} 192.168.1.20 50001\n${FAR2} 192.168.1.21 50002\n`,
        // A second copy of the game on this PC (another player), which heard one of the same.
        [peerName(TWIN, GAME)]: peerFile(GAME),
        [heardName(TWIN, GAME)]: `${FAR} 192.168.1.20 50001\n`,
        // A copy that is gone: its file is no longer held, and its list is not read.
        [peerName(FAR2.replace(/b/g, 'c'), GAME)]: peerFile(GAME),
        'notes.txt': 'not a board file'
      },
      [peerName(ME, GAME), peerName(TWIN, GAME)]
    )
    expect(await readBoard(DIR, io)).toEqual({ live: true, players: 4 })
  })

  it('is not live when no board file is held, or the folder is missing', async () => {
    const io = fakeIo({ [peerName(ME, GAME)]: peerFile(GAME) }, [])
    expect(await readBoard(DIR, io)).toEqual({ live: false, players: null })
    expect(await readBoard('C:\\elsewhere', io)).toEqual({ live: false, players: null })
  })

  it('counts the game with the most copies when two games are on the board', async () => {
    const io = fakeIo(
      {
        [peerName(ME, OTHER_GAME)]: peerFile(OTHER_GAME),
        [peerName(ME, GAME)]: peerFile(GAME),
        [peerName(TWIN, GAME)]: peerFile(GAME)
      },
      [peerName(ME, OTHER_GAME), peerName(ME, GAME), peerName(TWIN, GAME)]
    )
    expect(await readBoard(DIR, io)).toEqual({ live: true, players: 2 })
  })

  it('gives no count when the files do not read as expected', async () => {
    // A held file whose tag is not its game's (a new format): no count, but LAN play still shows from the rest.
    const wrongTag = fakeIo(
      {
        [peerName(ME, GAME)]: peerFile(GAME),
        [peerName(TWIN, GAME)]: peerFile(OTHER_GAME)
      },
      [peerName(ME, GAME), peerName(TWIN, GAME)]
    )
    expect(await readBoard(DIR, wrongTag)).toEqual({ live: true, players: null })
    const badHeard = fakeIo(
      { [peerName(ME, GAME)]: peerFile(GAME), [heardName(ME, GAME)]: 'something else\n' },
      [peerName(ME, GAME)]
    )
    expect(await readBoard(DIR, badHeard)).toEqual({ live: true, players: null })
    const onlyBad = fakeIo({ [peerName(ME, GAME)]: 'garbage' }, [peerName(ME, GAME)])
    expect(await readBoard(DIR, onlyBad)).toEqual({ live: false, players: null })
  })

  it('reads a free file as not held, without changing it (node io)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'playout-pp-board-'))
    try {
      const file = join(dir, peerName(ME, GAME))
      writeFileSync(file, peerFile(GAME))
      expect(await nodeBoardIo.held(file)).toBe(false)
      expect(await nodeBoardIo.readFile(file)).toBe(peerFile(GAME))
      expect(await nodeBoardIo.held(join(dir, 'missing.peer'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

const session = (over: Partial<PeerPartySession> = {}): PeerPartySession => ({
  gameId: 'g1',
  title: 'Spelunky 2',
  startedAt: new Date(1_000_000).toISOString(),
  exe: 'D:\\Games\\Spelunky 2\\Spel2.exe',
  ...over
})

describe('overlayStatus', () => {
  const at = 1_000_000

  it('is inactive without a session, or over another game', () => {
    expect(overlayStatus({ session: null, target: {}, board: null, now: at })).toEqual({
      active: false,
      lan: 'off'
    })
    expect(
      overlayStatus({ session: session(), target: { gameId: 'g2' }, board: null, now: at })
    ).toEqual({ active: false, lan: 'off' })
    expect(
      overlayStatus({
        session: session(),
        target: { program: 'Other.exe' },
        board: null,
        now: at
      }).active
    ).toBe(false)
  })

  it('follows the game the overlay is over, its program, or any game when it is over none', () => {
    for (const target of [{ gameId: 'g1' }, { program: 'spel2.EXE' }, {}]) {
      expect(overlayStatus({ session: session(), target, board: null, now: at }).active).toBe(true)
    }
  })

  it('says on with the count, starting, then off', () => {
    const live = { live: true, players: 3 }
    expect(overlayStatus({ session: session(), target: {}, board: live, now: at })).toEqual({
      active: true,
      gameTitle: 'Spelunky 2',
      lan: 'on',
      players: 3
    })
    expect(
      overlayStatus({
        session: session(),
        target: {},
        board: { live: true, players: null },
        now: at
      })
    ).toEqual({ active: true, gameTitle: 'Spelunky 2', lan: 'on' })
    const off = { live: false, players: null }
    expect(overlayStatus({ session: session(), target: {}, board: off, now: at + 1000 }).lan).toBe(
      'starting'
    )
    expect(
      overlayStatus({ session: session(), target: {}, board: off, now: at + LAN_STARTING_MS }).lan
    ).toBe('off')
  })
})

describe('the LAN invite', () => {
  it('maps the helper answer to what the tab says', () => {
    expect(inviteResult({ ok: true, taken: true }, true)).toEqual({ result: 'sent' })
    expect(inviteResult({ ok: true, taken: false }, true)).toEqual({ result: 'none' })
    expect(inviteResult({ ok: false, error: 'Access is denied' }, true)).toEqual({
      result: 'error',
      message: 'Access is denied'
    })
    expect(inviteResult(null, true)).toEqual({ result: 'error', message: INVITE_MESSAGES.noAnswer })
    expect(inviteResult(null, false)).toEqual({ result: 'error', message: INVITE_MESSAGES.missing })
  })

  function overlay(
    answer: PeerPartyInviteAnswer | null,
    options: { present?: boolean; current?: PeerPartySession | null } = {}
  ): {
    o: ReturnType<typeof createPeerPartyOverlay>
    helper: { available: ReturnType<typeof vi.fn>; peerPartyInvite: ReturnType<typeof vi.fn> }
    whileGameRuns: ReturnType<typeof vi.fn>
  } {
    const helper = {
      available: vi.fn(async () => options.present ?? true),
      peerPartyInvite: vi.fn(async () => answer)
    }
    const whileGameRuns = vi.fn((work: () => Promise<unknown>) => work())
    const o = createPeerPartyOverlay({
      log,
      session: () => ('current' in options ? (options.current ?? null) : session()),
      overlayState: () => ({ gameId: 'g1' }),
      dataDir: 'C:\\PlayOut\\PeerParty\\peerparty-data',
      helper,
      whileGameRuns: <T>(work: () => Promise<T>) => whileGameRuns(work) as Promise<T>,
      io: fakeIo({}, []),
      now: () => 1_000_000
    })
    return { o, helper, whileGameRuns }
  }

  it('asks through the helper with the paused game running, and says whether a game took it', async () => {
    const sent = overlay({ ok: true, taken: true })
    expect(await sent.o.invite()).toEqual({ result: 'sent' })
    expect(sent.whileGameRuns).toHaveBeenCalledTimes(1)
    expect(sent.helper.peerPartyInvite).toHaveBeenCalledTimes(1)
    expect(await overlay({ ok: true, taken: false }).o.invite()).toEqual({ result: 'none' })
    expect(await overlay({ ok: false, error: 'boom' }).o.invite()).toEqual({
      result: 'error',
      message: 'boom'
    })
  })

  it('says the helper is missing without asking it', async () => {
    const missing = overlay(null, { present: false })
    expect(await missing.o.invite()).toEqual({ result: 'error', message: INVITE_MESSAGES.missing })
    expect(missing.helper.peerPartyInvite).not.toHaveBeenCalled()
  })

  it('sends nothing without a PeerParty session under the overlay', async () => {
    const none = overlay({ ok: true, taken: true }, { current: null })
    expect(await none.o.invite()).toEqual({ result: 'none', message: INVITE_MESSAGES.noSession })
    expect(none.helper.peerPartyInvite).not.toHaveBeenCalled()
  })

  it('shares one invite between two presses', async () => {
    const both = overlay({ ok: true, taken: true })
    const [a, b] = await Promise.all([both.o.invite(), both.o.invite()])
    expect(a).toEqual({ result: 'sent' })
    expect(b).toBe(a)
    expect(both.helper.peerPartyInvite).toHaveBeenCalledTimes(1)
  })

  it('reads the board only for an active session', async () => {
    const { o } = overlay(null)
    expect(await o.status()).toEqual({ active: true, gameTitle: 'Spelunky 2', lan: 'starting' })
    const idle = overlay(null, { current: null })
    expect(await idle.o.status()).toEqual({ active: false, lan: 'off' })
  })
})
