/**
 * The PeerParty tab's words (docs/home-overlay.md, "PeerParty"): pure, so they are tested without React. Each is
 * read in the current language at the call.
 */
import type { PeerPartyInviteResult, PeerPartyOverlayStatus } from '@shared/peerparty'
import { t } from '../i18n'

/** Whether LAN play is on, in a few words. */
export function lanWord(lan: PeerPartyOverlayStatus['lan']): string {
  const words: Record<PeerPartyOverlayStatus['lan'], string> = {
    on: t('overlay.peerParty.lan.on'),
    starting: t('overlay.peerParty.lan.starting'),
    off: t('overlay.peerParty.lan.off')
  }
  return words[lan]
}

/** "Players of this game on your network: 2", or null when PeerParty's files gave no count (or LAN play is not on). */
export function playersText(status: PeerPartyOverlayStatus): string | null {
  if (status.lan !== 'on' || typeof status.players !== 'number' || status.players < 1) return null
  return t('overlay.peerParty.players', { count: status.players })
}

/** What the tab says after "Invite everyone on the LAN". */
export function inviteText(result: PeerPartyInviteResult): string {
  switch (result.result) {
    case 'sent':
      return t('overlay.peerParty.inviteSent')
    case 'none':
      return t('overlay.peerParty.inviteNone')
    default:
      return result.message || t('overlay.peerParty.inviteFailed')
  }
}

/** What PeerParty cannot do yet (it shares no list of players). */
export function peerPartyLimitsNote(): string {
  return t('overlay.peerParty.limitsNote')
}
