import type { RecompHeldAnswer, RecompHeldImage } from '@shared/recomp'
import { useState, type ReactElement } from 'react'
import { api } from '../../api/client'
import { Button } from '../../components/Button'
import { Modal } from '../../components/Modal'
import { useT } from '../../i18n'
import { createLog } from '../../lib/log'
import { ipcErrorMessage } from '../../state/coop'
import { dismissRecompHeld, heldWhat, recompHeldMessage } from '../../state/recompImage'
import { useUiStore } from '../../state/ui'

const log = createLog('recomp-held-dialog')
const KEY = 'recompheld'

export interface RecompHeldDialogProps {
  item: RecompHeldImage
  onClose: () => void
}

/**
 * After "Delete the original disc image?" PlayOut moved the image aside and started the recompilation to check it runs
 * without it (main/recomp/service.ts). Asked by App, one at a time, when that check has a verdict:
 * - it did not start or closed right after it started ('crashed'): Restore (focused first) puts the files back where
 *   they were and the card is an ordinary game again; Delete anyway moves them to the Recycle Bin;
 * - it was not started for another reason, or the check did not finish: Restore, Test again or Delete anyway;
 * - it ran but the Recycle Bin refused the files: Restore or Delete anyway (tries again).
 * B / Escape is "Not now": the files stay aside and the question comes back at PlayOut's next start.
 */
export function RecompHeldDialog({ item, onClose }: RecompHeldDialogProps): ReactElement {
  const t = useT()
  const toast = useUiStore((s) => s.toast)
  const [busy, setBusy] = useState(false)
  const { title, message } = recompHeldMessage(item)
  const canRetry = item.state === 'not-tested' || item.state === 'interrupted'

  const answer = (picked: RecompHeldAnswer): void => {
    if (busy) return
    setBusy(true)
    dismissRecompHeld(item)
    api
      .answerRecompHeldImage(item.holdId, picked)
      .then((result) => toast(result.message, result.ok ? 'success' : 'error'))
      .catch((err) => {
        log.error('answerRecompHeldImage failed', err)
        toast(
          ipcErrorMessage(err) || t('recomp.held.answerFailed', { what: heldWhat(item) }),
          'error'
        )
      })
      .finally(onClose)
  }
  const later = (): void => {
    dismissRecompHeld(item)
    onClose()
  }

  return (
    <Modal
      size="dialog"
      narrow
      hideClose
      className="confirm-dialog"
      focusKey={KEY}
      preferredChildFocusKey={`${KEY}:restore`}
      title={title}
      onClose={later}
      aria-label={`${title.slice(0, -1)} (${item.gameTitle})?`}
      footer={
        <>
          <Button focusKey={`${KEY}:delete`} variant="danger" onPress={() => answer('delete')}>
            {t('recomp.held.deleteAnyway')}
          </Button>
          {canRetry ? (
            <Button focusKey={`${KEY}:retry`} onPress={() => answer('retry')}>
              {t('recomp.held.testAgain')}
            </Button>
          ) : null}
          <Button focusKey={`${KEY}:restore`} variant="primary" onPress={() => answer('restore')}>
            {t('recomp.held.restore')}
          </Button>
        </>
      }
    >
      <p className="dialog__message">{message}</p>
      {item.files.length > 1 ? <p className="dialog__message">{item.files.join(', ')}</p> : null}
    </Modal>
  )
}
