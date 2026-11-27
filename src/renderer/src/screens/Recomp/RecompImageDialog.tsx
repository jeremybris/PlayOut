import type { RecompDeleteChoice, RecompImageOffer } from '@shared/recomp'
import { useState, type ReactElement } from 'react'
import { api } from '../../api/client'
import { Button } from '../../components/Button'
import { Modal } from '../../components/Modal'
import { SelectField } from '../../components/SelectField'
import { useT } from '../../i18n'
import { formatBytes } from '../../lib/format'
import { createLog } from '../../lib/log'
import { ipcErrorMessage } from '../../state/coop'
import {
  deleteToSend,
  dismissRecompImageOffer,
  initialDeleteChoice,
  recompDeleteOptions,
  recompImageMessage,
  useRecompImageStore,
  wantedDeleteChoice
} from '../../state/recompImage'
import { useUiStore } from '../../state/ui'

const log = createLog('recomp-image-dialog')
const KEY = 'recompimage'

export interface RecompImageDialogProps {
  offer: RecompImageOffer
  onClose: () => void
}

/**
 * "Delete the original disc image?" (main/recomp/image-offer.ts), asked by App one question at a time: Delete moves
 * what the Delete dropdown picks to the Recycle Bin: the image (its whole file set; the card stays and starts the
 * recompilation), the game folder PlayOut unpacked for the setup program, or both. The dropdown shows only when the
 * question offers more than one of them (it opens a list: A / click picks, B closes it). Keep it is remembered by main
 * for everything asked about. B / Escape is "Not now": asked again at PlayOut's next start. Keep it is focused first.
 */
export function RecompImageDialog({ offer, onClose }: RecompImageDialogProps): ReactElement {
  const t = useT()
  const toast = useUiStore((s) => s.toast)
  const wanted = useRecompImageStore((s) => wantedDeleteChoice(s, offer))
  const [busy, setBusy] = useState(false)
  const options = recompDeleteOptions(offer)
  const [choice, setChoice] = useState<RecompDeleteChoice>(() =>
    initialDeleteChoice(options, wanted)
  )
  // The Recompilation page's choice arriving after the question opened is taken over.
  const [seenWanted, setSeenWanted] = useState(wanted)
  if (wanted !== seenWanted) {
    setSeenWanted(wanted)
    if (wanted && options.some((o) => o.value === wanted)) setChoice(wanted)
  }
  const size = offer.totalBytes !== null ? formatBytes(offer.totalBytes) : null
  const folderSize =
    offer.folder && offer.folder.totalBytes !== null ? formatBytes(offer.folder.totalBytes) : null

  const answer = (picked: RecompDeleteChoice | 'keep'): void => {
    if (busy) return
    setBusy(true)
    dismissRecompImageOffer(offer.key)
    api
      .answerRecompImageOffer(offer.key, picked)
      .then((result) => {
        if (picked !== 'keep') toast(result.message, result.ok ? 'success' : 'error')
        else if (!result.ok) toast(result.message, 'error')
      })
      .catch((err) => {
        log.error('answerRecompImageOffer failed', err)
        toast(
          ipcErrorMessage(err) ||
            (offer.fileName
              ? t('recomp.image.deleteFailed', { what: offer.fileName })
              : t('recomp.image.deleteFolderFailed')),
          'error'
        )
      })
      .finally(onClose)
  }
  const later = (): void => {
    dismissRecompImageOffer(offer.key)
    onClose()
  }

  const title = offer.fileName ? t('recomp.image.titleImage') : t('recomp.image.titleFolder')
  return (
    <Modal
      size="dialog"
      narrow
      hideClose
      className="confirm-dialog"
      focusKey={KEY}
      preferredChildFocusKey={`${KEY}:keep`}
      title={title}
      onClose={later}
      aria-label={
        offer.fileName
          ? t('recomp.image.ariaImage', { game: offer.gameTitle })
          : t('recomp.image.ariaFolder', { game: offer.gameTitle })
      }
      footer={
        <>
          <Button focusKey={`${KEY}:keep`} onPress={() => answer('keep')}>
            {t('recomp.image.keep')}
          </Button>
          {options.length > 1 ? (
            <SelectField
              variant="pill"
              label={t('recomp.image.whatToDelete')}
              focusKey={`${KEY}:what`}
              value={choice}
              options={options}
              onChange={setChoice}
            />
          ) : null}
          <Button
            focusKey={`${KEY}:delete`}
            variant="danger"
            onPress={() => {
              // What the question offers changed while it was open: never send something else than was picked.
              const send = deleteToSend(options, choice)
              if (send) answer(send)
              else {
                setChoice(initialDeleteChoice(options))
                toast(t('recomp.image.changed'), 'info')
              }
            }}
          >
            {t('recomp.image.delete')}
          </Button>
        </>
      }
    >
      <p className="dialog__message">{recompImageMessage(offer, size, folderSize)}</p>
      {offer.files.length > 1 ? <p className="dialog__message">{offer.files.join(', ')}</p> : null}
    </Modal>
  )
}
