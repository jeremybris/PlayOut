import { Send } from 'lucide-react'
import { useEffect, type ReactElement } from 'react'
import { Button } from '../components/Button'
import { useT } from '../i18n'
import { cx } from '../lib/cx'
import { inviteText, lanWord, peerPartyLimitsNote, playersText } from './peerparty'
import { usePeerPartyOverlayStore } from './peerPartyStore'

/**
 * PeerParty tab (docs/home-overlay.md, "PeerParty"), in Friends' place while the game under the overlay runs through
 * PeerParty: whether LAN play is on, how many players of the game PeerParty sees on the network, and one invite to all
 * of them. PeerParty shares no list of players, so there are no names and no invite to one player. Read when the tab
 * opens and every 5 s while it stays open, never otherwise.
 */
export function PeerPartyTab(): ReactElement {
  const status = usePeerPartyOverlayStore((s) => s.status)
  const inviting = usePeerPartyOverlayStore((s) => s.inviting)
  const invite = usePeerPartyOverlayStore((s) => s.invite)
  const watch = usePeerPartyOverlayStore((s) => s.watch)
  const sendInvite = usePeerPartyOverlayStore((s) => s.sendInvite)
  const t = useT()
  useEffect(() => watch(), [watch])

  if (!status) return <p className="ov-hint">{t('overlay.peerParty.checking')}</p>
  if (!status.active) return <p className="ov-hint">{t('overlay.peerParty.noGame')}</p>

  const players = playersText(status)
  return (
    <div className="ov-peerparty">
      {/* No heading of its own: the panel header above already says PeerParty and the game. */}
      <p className={cx('ov-peerparty__status', `ov-peerparty__status--${status.lan}`)}>
        <span className="ov-peerparty__dot" aria-hidden="true" />
        {lanWord(status.lan)}
      </p>
      {players ? <p className="ov-peerparty__players">{players}</p> : null}
      <div className="ov-peerparty__actions">
        <Button
          focusKey="overlay:peerparty:invite"
          variant="primary"
          icon={<Send />}
          aria-disabled={inviting || undefined}
          onPress={() => {
            if (!inviting) void sendInvite()
          }}
        >
          {inviting ? t('overlay.peerParty.inviting') : t('overlay.peerParty.invite')}
        </Button>
        <p
          className={cx('ov-peerparty__result', invite && `ov-peerparty__result--${invite.result}`)}
          role="status"
          aria-live="polite"
        >
          {invite ? inviteText(invite) : null}
        </p>
      </div>
      <p className="ov-hint">{peerPartyLimitsNote()}</p>
    </div>
  )
}
