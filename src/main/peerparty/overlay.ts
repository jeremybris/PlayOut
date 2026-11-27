import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import {
  peerPartyForOverlay,
  type PeerPartyInviteResult,
  type PeerPartyOverlayStatus,
  type PeerPartySession
} from '../../shared/peerparty'
import type { OverlayState } from '../../shared/overlay'
import type { Logger } from '../logger'
import type { PeerPartyInviteAnswer } from '../overlay/ingame/helper'
import { tMain } from '../i18n'

/**
 * The overlay's PeerParty tab (docs/home-overlay.md, "PeerParty"), shown in place of Friends while a game runs
 * through PeerParty. PeerParty has no public list of players: its overlay pipe is private, so names and invites to one
 * player are out of reach. What another program can see, read-only:
 *
 * - The peer board (PeerParty's core/src/mesh.rs, `Board`): each running copy of PeerParty's LAN engine keeps
 *   `<data>\peers\<peer id>.<game tag>.peer` (three lines: the game key, the discovery port, the TCP port), open
 *   without write or delete sharing for as long as it runs. `<id>.<tag>.heard` lists the peers that copy heard from
 *   other PCs ("id ip port" lines, kept 5 s). The ids count the players; the addresses are never read out or shown.
 * - The invite: the named events `Local\peerparty.invite.last` / `.ack`, set by PlayOutIngame64.exe
 *   (`peerparty-invite`), as PeerParty's own Invite button does (launcher/src/backend/windows/invite.rs).
 *
 * The board's format is PeerParty's own, not a promise: whatever does not read as expected shows no count.
 */

/** PeerParty's board folder inside its data folder. */
export const PEERS_DIR = 'peers'
/** How long after the start "Starting…" shows before a missing board reads as LAN play being off. */
export const LAN_STARTING_MS = 90_000
/** Board files read at most (PeerParty keeps 256 heard peers per copy; a folder this full is not its own). */
const MAX_ENTRIES = 512
/** Board files are a few lines long; more than this is not one. */
const MAX_FILE_BYTES = 16 * 1024

/** A PeerParty id: 16 bytes as hex (core/src/id.rs `PeerId::hex`). */
const ID = /^[0-9a-f]{32}$/
/** `<id>.<game tag>.peer` / `.heard`; the tag is the first 6 bytes of the game key's SHA-256, as hex. */
const BOARD_NAME = /^([0-9a-fA-F]{32})\.([0-9a-fA-F]{12})\.(peer|heard)$/

export interface BoardName {
  id: string
  tag: string
  kind: 'peer' | 'heard'
}

/** A board file's name, or null for anything else in the folder. */
export function parseBoardName(name: string): BoardName | null {
  const m = BOARD_NAME.exec(name)
  if (!m) return null
  return { id: m[1]!.toLowerCase(), tag: m[2]!.toLowerCase(), kind: m[3] as 'peer' | 'heard' }
}

/** PeerParty's game tag of a game key (core/src/id.rs `game_tag`). */
export function gameTag(gameKey: string): string {
  return createHash('sha256').update(gameKey, 'utf8').digest('hex').slice(0, 12)
}

export interface BoardEntry {
  game: string
  discoveryPort: number
  tcpPort: number
}

const port = (text: string | undefined): number | null => {
  if (!text || !/^\d{1,5}$/.test(text.trim())) return null
  const n = Number(text.trim())
  return n >= 1 && n <= 65535 ? n : null
}

/** A `.peer` file: the game key, the discovery port and the TCP port, one per line; null when it is not that. */
export function parseBoardFile(text: string): BoardEntry | null {
  const lines = text.split(/\r?\n/)
  const game = lines[0]
  const discoveryPort = port(lines[1])
  const tcpPort = port(lines[2])
  if (!game || discoveryPort === null || tcpPort === null) return null
  if (lines.slice(3).some((l) => l.trim() !== '')) return null
  return { game, discoveryPort, tcpPort }
}

/**
 * The peer ids of a `.heard` file ("id ip port" per line), or null when its lines do not read that way. Only the ids
 * are kept: the addresses are not PlayOut's to show.
 */
export function parseHeardFile(text: string): string[] | null {
  const ids = new Set<string>()
  for (const line of text.split(/\r?\n/).slice(0, 256)) {
    if (!line.trim()) continue
    const [id, ip, p, ...rest] = line.trim().split(' ')
    if (!id || !ip || rest.length || port(p) === null || !ID.test(id.toLowerCase())) return null
    ids.add(id.toLowerCase())
  }
  return [...ids]
}

/** The file access the board reading needs (a fake in tests). */
export interface BoardIo {
  readdir(dir: string): Promise<string[]>
  /** The file's text; rejects with code ENOENT when it is gone. */
  readFile(path: string): Promise<string>
  /** Whether a running PeerParty still holds the file (it is open without write sharing). */
  held(path: string): Promise<boolean>
}

const errorCode = (err: unknown): string | undefined => (err as NodeJS.ErrnoException)?.code

export const nodeBoardIo: BoardIo = {
  readdir: (dir) => fs.readdir(dir),
  async readFile(path) {
    const handle = await fs.open(path, 'r')
    try {
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      if (bytesRead > MAX_FILE_BYTES) throw new Error('not a board file')
      return buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }
  },
  /**
   * PeerParty opens its board file sharing reading only (core/src/sys/windows.rs `open_board`, share mode 1), so an
   * open for writing fails with a sharing violation (EBUSY) while that copy runs. Nothing is written, truncated or
   * deleted: the handle is closed at once.
   */
  async held(path) {
    try {
      const handle = await fs.open(path, 'r+')
      await handle.close()
      return false
    } catch (err) {
      return errorCode(err) === 'EBUSY'
    }
  }
}

export interface BoardReading {
  /** A running copy of PeerParty's LAN engine is on the board (one game: the one with the most copies). */
  live: boolean
  /** Players of that game on the network, this PC's included; null when the files did not read as expected. */
  players: number | null
}

/**
 * Read PeerParty's board folder: the live copies (a `.peer` file still held, naming a game key whose tag is the one
 * in its name) grouped by game, the game with the most copies here, and its players: the distinct ids of its copies on
 * this PC and of the peers they heard from other PCs.
 */
export async function readBoard(peersDir: string, io: BoardIo): Promise<BoardReading> {
  let names: string[]
  try {
    names = await io.readdir(peersDir)
  } catch {
    return { live: false, players: null }
  }
  const byGame = new Map<string, { id: string; tag: string }[]>()
  /** A held `.peer` file that did not read as one: its game may be this one, so no count is given. */
  let unreadable = false
  for (const name of names.slice(0, MAX_ENTRIES)) {
    const parsed = parseBoardName(name)
    if (!parsed || parsed.kind !== 'peer') continue
    const path = join(peersDir, name)
    if (!(await io.held(path))) continue
    let text: string
    try {
      text = await io.readFile(path)
    } catch (err) {
      if (errorCode(err) !== 'ENOENT') unreadable = true
      continue
    }
    const entry = parseBoardFile(text)
    if (!entry || gameTag(entry.game) !== parsed.tag) {
      unreadable = true
      continue
    }
    const copies = byGame.get(entry.game) ?? []
    copies.push({ id: parsed.id, tag: parsed.tag })
    byGame.set(entry.game, copies)
  }
  // The game with the most copies here; the first one listed on a tie.
  let copies: { id: string; tag: string }[] | null = null
  for (const list of byGame.values()) if (!copies || list.length > copies.length) copies = list
  if (!copies) return { live: false, players: null }

  const ids = new Set(copies.map((c) => c.id))
  for (const copy of copies) {
    let text: string
    try {
      text = await io.readFile(join(peersDir, `${copy.id}.${copy.tag}.heard`))
    } catch (err) {
      // No file: that copy heard nobody from another PC (PeerParty deletes it when the list empties).
      if (errorCode(err) === 'ENOENT') continue
      return { live: true, players: null }
    }
    const heard = parseHeardFile(text)
    if (!heard) return { live: true, players: null }
    for (const id of heard) ids.add(id)
  }
  return { live: true, players: unreadable ? null : ids.size }
}

/** The status the tab shows, from the session, the overlay's target and the board. */
export function overlayStatus(input: {
  session: PeerPartySession | null
  target: Pick<OverlayState, 'gameId' | 'program'>
  board: BoardReading | null
  now: number
}): PeerPartyOverlayStatus {
  const { session } = input
  if (!session || !peerPartyForOverlay(session, input.target)) return { active: false, lan: 'off' }
  const startedAt = Date.parse(session.startedAt)
  const young = Number.isFinite(startedAt) && input.now - startedAt < LAN_STARTING_MS
  const live = input.board?.live === true
  const players = input.board?.players
  return {
    active: true,
    gameTitle: session.title,
    lan: live ? 'on' : young ? 'starting' : 'off',
    ...(live && typeof players === 'number' && players > 0 ? { players } : {})
  }
}

export const INVITE_MESSAGES = {
  get missing() {
    return tMain('mainPeerParty.invite.missing')
  },
  get noAnswer() {
    return tMain('mainPeerParty.invite.noAnswer')
  },
  get noSession() {
    return tMain('mainPeerParty.invite.noSession')
  }
} as const

/** What the tab says for the helper's answer. */
export function inviteResult(
  answer: PeerPartyInviteAnswer | null,
  helperPresent: boolean
): PeerPartyInviteResult {
  if (!answer)
    return {
      result: 'error',
      message: helperPresent ? INVITE_MESSAGES.noAnswer : INVITE_MESSAGES.missing
    }
  if (!answer.ok) return { result: 'error', message: answer.error }
  return { result: answer.taken ? 'sent' : 'none' }
}

export interface PeerPartyOverlayDeps {
  log: Logger
  session(): PeerPartySession | null
  overlayState(): Pick<OverlayState, 'gameId' | 'program'>
  /** PlayOut's PeerParty data folder (peerparty-data, portable mode). */
  dataDir: string
  /** PlayOutIngame64.exe: is it there, and its `peerparty-invite`. */
  helper: {
    available(): Promise<boolean>
    peerPartyInvite(): Promise<PeerPartyInviteAnswer | null>
  }
  /** Run the invite with the game the overlay paused running for that moment (its thread answers the invite). */
  whileGameRuns<T>(work: () => Promise<T>): Promise<T>
  io?: BoardIo
  now?: () => number
}

export interface PeerPartyOverlay {
  status(): Promise<PeerPartyOverlayStatus>
  invite(): Promise<PeerPartyInviteResult>
}

export function createPeerPartyOverlay(deps: PeerPartyOverlayDeps): PeerPartyOverlay {
  const io = deps.io ?? nodeBoardIo
  const now = deps.now ?? Date.now
  const peersDir = join(deps.dataDir, PEERS_DIR)
  /** One invite at a time: a second press while one waits for its answer shares it. */
  let inviting: Promise<PeerPartyInviteResult> | null = null

  const active = (): PeerPartySession | null => {
    const session = deps.session()
    return session && peerPartyForOverlay(session, deps.overlayState()) ? session : null
  }

  async function sendInvite(): Promise<PeerPartyInviteResult> {
    if (!active()) return { result: 'none', message: INVITE_MESSAGES.noSession }
    try {
      const present = await deps.helper.available()
      if (!present) return inviteResult(null, false)
      const answer = await deps.whileGameRuns(() =>
        deps.helper.peerPartyInvite().catch((err: unknown) => {
          deps.log.warn(`PeerParty invite: ${err instanceof Error ? err.message : String(err)}`)
          return null
        })
      )
      const result = inviteResult(answer, true)
      deps.log.info(
        `PeerParty invite: ${result.result}${result.message ? ` (${result.message})` : ''}`
      )
      return result
    } catch (err) {
      deps.log.warn(`PeerParty invite failed: ${err instanceof Error ? err.message : String(err)}`)
      return { result: 'error', message: tMain('mainPeerParty.invite.failed') }
    }
  }

  return {
    async status() {
      const session = active()
      const board = session ? await readBoard(peersDir, io).catch(() => null) : null
      return overlayStatus({
        session: deps.session(),
        target: deps.overlayState(),
        board,
        now: now()
      })
    },
    invite() {
      inviting ??= sendInvite().finally(() => {
        inviting = null
      })
      return inviting
    }
  }
}
