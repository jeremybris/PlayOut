import { promises as fs } from 'fs'
import { join } from 'path'
import type { PeerPartyService } from '../../shared/peerparty'
import type { SourceId } from '../../shared/types'
import { nodeFsIo, type FsIo } from '../upgrades/anticheat'

/**
 * Which multiplayer services a game uses, from the files in its folder (the SDK libraries each service ships), the
 * text "demonware.net" in its program (Activision's Demonware has no library of its own) and its store (an Xbox app
 * game). PeerParty stands in for these services on a local network; a game with none of them is not offered.
 */

/**
 * How many folder levels below the game's folder are opened: Unreal keeps EOSSDK at
 * Engine\Binaries\ThirdParty\EOSSDK\Win64 (5) and steam_api at Engine\Binaries\ThirdParty\Steamworks\SteamvNNN\Win64 (6).
 */
export const SDK_SCAN_DEPTH = 6
/** How many folders are opened at most (nearest the top first). */
export const SDK_SCAN_LIMIT = 20000
/** Programs larger than this are not searched for "demonware.net". */
export const DEMONWARE_MAX_BYTES = 768 * 1024 * 1024

/** The file-name rules (lowercased names) of the services found from files. */
const FILE_RULES: ReadonlyArray<{ service: PeerPartyService; pattern: RegExp }> = [
  { service: 'steamworks', pattern: /^steam_api(64)?\.dll$/ },
  { service: 'eos', pattern: /^eossdk-win(64|32)-shipping\.dll$/ },
  {
    service: 'playfab',
    pattern: /^(playfabparty.*\.dll|playfabmultiplayerwin\.dll|playfabcore.*\.dll|playfab.*\.dll)$/
  },
  { service: 'galaxy', pattern: /^galaxy(64)?\.dll$/ },
  {
    service: 'photon',
    pattern:
      /^(photon3unity3d\.dll|photonrealtime\.dll|photonunitynetworking.*\.dll|fusion.*\.dll)$/
  },
  { service: 'ugs', pattern: /^unity\.services\..*\.dll$/ }
]

/** The services a file name shows (lowercased before testing). */
export function servicesOfFile(name: string): PeerPartyService[] {
  const n = name.toLowerCase()
  return FILE_RULES.filter((r) => r.pattern.test(n)).map((r) => r.service)
}

const ORDER: readonly PeerPartyService[] = [
  'steamworks',
  'eos',
  'playfab',
  'galaxy',
  'photon',
  'ugs',
  'demonware',
  'xbox'
]

export interface NetworkScan {
  /** The services found, in a fixed order, each once. */
  services: PeerPartyService[]
  /** False when the folder limit was reached or a subfolder could not be read. */
  complete: boolean
}

/**
 * Lowercases ASCII letters in place. UTF-16LE text of ASCII characters is the same bytes with a zero after each, so
 * one pass serves both encodings.
 */
function lowerAscii(buf: Buffer): Buffer {
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!
    if (b >= 0x41 && b <= 0x5a) buf[i] = b + 0x20
  }
  return buf
}

/**
 * Whether a file holds `needle` (ASCII, any case) as ASCII or UTF-16LE text. Reads it in 1 MiB pieces that overlap by
 * 32 bytes, so a match across two pieces is found. Files above `maxBytes` are not read (false).
 */
export async function fileContains(
  path: string,
  needle: string,
  maxBytes = DEMONWARE_MAX_BYTES
): Promise<boolean> {
  const ascii = Buffer.from(needle.toLowerCase(), 'latin1')
  const wide = Buffer.from(needle.toLowerCase(), 'utf16le')
  const overlap = 32
  if (wide.length > overlap + 1) throw new Error('needle too long')
  const handle = await fs.open(path, 'r')
  try {
    const { size } = await handle.stat()
    if (size > maxBytes) return false
    const piece = 1024 * 1024
    const buf = Buffer.alloc(piece + overlap)
    let carried = 0
    let position = 0
    for (;;) {
      const { bytesRead } = await handle.read(buf, carried, piece, position)
      if (bytesRead === 0) return false
      position += bytesRead
      const view = lowerAscii(buf.subarray(0, carried + bytesRead))
      if (view.includes(ascii) || view.includes(wide)) return true
      carried = Math.min(overlap, view.length)
      view.copy(buf, 0, view.length - carried, view.length)
    }
  } finally {
    await handle.close()
  }
}

/**
 * The multiplayer services of a game: its folder walked breadth first (SDK_SCAN_DEPTH levels, at most SDK_SCAN_LIMIT
 * folders, never through links or junctions, never into WindowsApps folders, stopping once every file-found service
 * is found), its program searched for "demonware.net", and 'xbox' for an Xbox app game.
 */
export async function scanNetworkServices(
  target: { installDir: string; exe: string | null; source: SourceId | string },
  io: FsIo = nodeFsIo,
  log?: { info(...args: unknown[]): void },
  contains: (path: string, needle: string) => Promise<boolean> = fileContains
): Promise<NetworkScan> {
  const found = new Set<PeerPartyService>()
  let complete = true
  let opened = 0
  let queue = [target.installDir]
  walk: for (let depth = 0; depth <= SDK_SCAN_DEPTH && queue.length > 0; depth++) {
    const next: string[] = []
    for (const dir of queue) {
      if (found.size === FILE_RULES.length) break walk
      if (opened >= SDK_SCAN_LIMIT) {
        complete = false
        break walk
      }
      opened++
      let entries: Awaited<ReturnType<FsIo['readdir']>>
      try {
        entries = await io.readdir(dir)
      } catch {
        complete = false
        continue
      }
      for (const e of entries) {
        if (e.isLink) continue
        if (e.isDirectory) {
          if (depth < SDK_SCAN_DEPTH && e.name.toLowerCase() !== 'windowsapps')
            next.push(join(dir, e.name))
        } else for (const s of servicesOfFile(e.name)) found.add(s)
      }
    }
    queue = next
  }
  if (target.exe) {
    try {
      if (await contains(target.exe, 'demonware.net')) found.add('demonware')
    } catch (err) {
      log?.info(`PeerParty: ${target.exe} could not be searched: ${(err as Error).message}`)
    }
  }
  if (target.source === 'xbox') found.add('xbox')
  return { services: ORDER.filter((s) => found.has(s)), complete }
}
