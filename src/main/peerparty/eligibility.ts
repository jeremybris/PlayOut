import {
  isXbox360BackwardCompatible,
  peerPartyBlockTags,
  peerPartyHasMultiplayer,
  peerPartyKernelAntiCheat,
  type PeerPartyBlock,
  type PeerPartyService
} from '../../shared/peerparty'
import { recompOnlyKey } from '../../shared/recomp-play'
import type { Game } from '../../shared/types'
import { tMain } from '../i18n'

/**
 * Whether PeerParty may be offered for a game. Only an installed PC game qualifies, and only one that has
 * multiplayer, carries no competitive or free-to-play tag, has no anti-cheat in its folder (an unknown answer counts
 * as anti-cheat, so no one is banned for a modified game), has a program PeerParty can start, and uses one of the
 * multiplayer services PeerParty stands in for. The cheap checks come first; the folder is scanned only when the
 * game's metadata passes.
 */

export type EligibilityGame = Pick<
  Game,
  | 'remote'
  | 'source'
  | 'launch'
  | 'extra'
  | 'installed'
  | 'installDir'
  | 'metadata'
  | 'externalId'
  | 'title'
>

/** What the scan of a game's folder found. */
export interface PeerPartyProbe {
  /** Anti-cheat names found in its folder. */
  antiCheat: string[]
  /** False when the anti-cheat scan did not read every folder in reach, or could not read the folder at all. */
  antiCheatComplete: boolean
  /** The folder could not be checked for anti-cheat (a protected WindowsApps folder, or an unreadable one). */
  antiCheatError?: boolean
  exe: string | null
  services: PeerPartyService[]
  /** False when the multiplayer-service scan stopped at its folder limit or passed over an unreadable folder. */
  sdkComplete?: boolean
}

export interface PeerPartyVerdict {
  blocked: PeerPartyBlock | null
  reason: string | null
  services: PeerPartyService[]
  antiCheat: string[]
  exe: string | null
  /** The metadata checks passed and the folder has not been scanned yet (no probe given). */
  needsScan: boolean
}

// Getters: each reason is read in PlayOut's language when a game is checked, not when this module loads.
const REASONS: Record<PeerPartyBlock, string> = {
  get remote() {
    return tMain('mainPeerParty.blocked.remote')
  },
  get rom() {
    return tMain('mainPeerParty.blocked.rom')
  },
  get recomp() {
    return tMain('mainPeerParty.blocked.recomp')
  },
  get 'not-installed'() {
    return tMain('mainPeerParty.blocked.notInstalled')
  },
  get 'no-folder'() {
    return tMain('mainPeerParty.blocked.noFolder')
  },
  get competitive() {
    return tMain('mainPeerParty.blocked.competitive')
  },
  get 'no-multiplayer'() {
    return tMain('mainPeerParty.blocked.noMultiplayer')
  },
  get 'anti-cheat'() {
    return tMain('mainPeerParty.blocked.antiCheat')
  },
  get 'anti-cheat-unknown'() {
    return tMain('mainPeerParty.blocked.antiCheatUnknown')
  },
  get 'no-exe'() {
    return tMain('mainPeerParty.blocked.noExe')
  },
  get 'no-service'() {
    return tMain('mainPeerParty.blocked.noService')
  }
}

/** The block the game's own record shows (steps 1 to 7), else null. */
export function metadataBlock(
  game: EligibilityGame
): { block: PeerPartyBlock; reason: string } | null {
  const at = (
    block: PeerPartyBlock,
    reason = REASONS[block]
  ): { block: PeerPartyBlock; reason: string } => ({
    block,
    reason
  })
  if (game.remote) return at('remote')
  if (game.source === 'rom' || game.launch.kind === 'emulator') return at('rom')
  if (recompOnlyKey(game)) return at('recomp')
  if (!game.installed) return at('not-installed')
  if (!game.installDir) return at('no-folder')
  // An Xbox 360 game in Windows' backward-compatibility emulator is not a PC game PeerParty can carry.
  if (isXbox360BackwardCompatible(game))
    return at('no-service', tMain('mainPeerParty.blocked.xbox360'))
  // Kernel anti-cheat that leaves no file in the folder (Call of Duty's Ricochet): known by the game's title.
  const kernel = peerPartyKernelAntiCheat(game.title)
  if (kernel) return at('anti-cheat', tMain('mainPeerParty.blocked.kernelAntiCheat', { kernel }))
  const tags = peerPartyBlockTags(game)
  if (tags.length)
    return at(
      'competitive',
      tMain('mainPeerParty.blocked.competitiveTags', { tags: tags.join(', ') })
    )
  if (!peerPartyHasMultiplayer(game)) return at('no-multiplayer')
  // Valve Anti-Cheat leaves no files in the folder: Steam's store listing is the only sign of it.
  const steam = game.metadata.steamTags
  if (steam?.vac) return at('anti-cheat', tMain('mainPeerParty.blocked.vac'))
  if (game.source === 'steam' && steam?.vac === undefined)
    return at('anti-cheat-unknown', tMain('mainPeerParty.blocked.vacUnknown'))
  return null
}

/** The verdict for a game, from its record and (once scanned) its folder. */
export function peerPartyEligibility(
  game: EligibilityGame,
  probe?: PeerPartyProbe
): PeerPartyVerdict {
  const blocked = (block: PeerPartyBlock, reason = REASONS[block]): PeerPartyVerdict => ({
    blocked: block,
    reason,
    services: probe?.services ?? [],
    antiCheat: probe?.antiCheat ?? [],
    exe: probe?.exe ?? null,
    needsScan: false
  })
  const fromRecord = metadataBlock(game)
  if (fromRecord) return blocked(fromRecord.block, fromRecord.reason)
  if (!probe)
    return { blocked: null, reason: null, services: [], antiCheat: [], exe: null, needsScan: true }
  if (probe.antiCheat.length)
    return blocked(
      'anti-cheat',
      tMain('mainPeerParty.blocked.antiCheatNamed', { names: probe.antiCheat.join(', ') })
    )
  if (probe.antiCheatError || !probe.antiCheatComplete) return blocked('anti-cheat-unknown')
  if (!probe.exe) return blocked('no-exe')
  if (isXbox360BackwardCompatible(game, probe.exe))
    return blocked('no-service', tMain('mainPeerParty.blocked.xbox360'))
  if (!probe.services.length) return blocked('no-service')
  return {
    blocked: null,
    reason: null,
    services: probe.services,
    antiCheat: [],
    exe: probe.exe,
    needsScan: false
  }
}
