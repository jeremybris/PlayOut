import type { RecompDeleteChoice, RecompOriginalImage } from '@shared/recomp'
import { Trash2 } from 'lucide-react'
import { useState, type ReactElement } from 'react'
import { api } from '../../api/client'
import { Button } from '../../components/Button'
import { SelectField } from '../../components/SelectField'
import { useT } from '../../i18n'
import { cx } from '../../lib/cx'
import { createLog } from '../../lib/log'
import { ipcErrorMessage } from '../../state/coop'
import {
  initialDeleteChoice,
  recompDeleteOptions,
  setRecompImageAsking,
  undismissRecompImageOffer
} from '../../state/recompImage'
import type { UiState } from '../../state/ui'
import './recomp.css'

const log = createLog('recomp-image-delete')

export interface OriginalImageDeleteProps {
  /** The game whose disc image / unpacked folder may go (main re-checks everything when the question is answered). */
  gameId: string
  /** The installed recompilation that no longer needs them. */
  recompId: string
  image: RecompOriginalImage
  /** Focus keys of the What to delete dropdown and the Delete… button. */
  focusKeys: { what: string; delete: string }
  toast: UiState['toast']
  className?: string
}

/**
 * The "Delete…" control of the Recompilation page and of Settings › Recompilations (main/recomp/image-offer.ts): the
 * What to delete dropdown (shown when both the disc image and the unpacked game folder may go: the image, the folder or
 * both; A / click opens it) and the button that asks through the same question PlayOut asks on its own
 * (RecompImageDialog), opened with that choice. Offered again after Keep it.
 */
export function OriginalImageDelete({
  gameId,
  recompId,
  image,
  focusKeys,
  toast,
  className
}: OriginalImageDeleteProps): ReactElement {
  const t = useT()
  const options = recompDeleteOptions(image)
  const [picked, setPicked] = useState<RecompDeleteChoice>(options[0]?.value ?? 'delete')
  const choice = initialDeleteChoice(options, picked)
  const ask = (): void => {
    // Before the ask: main sends the question (App may open it) before the reply names its key.
    setRecompImageAsking(recompId, choice)
    api
      .askRecompImageDelete(gameId, recompId)
      .then((offer) => undismissRecompImageOffer(offer.key, choice))
      .finally(() => setRecompImageAsking(recompId, null))
      .catch((err) => {
        log.error('askRecompImageDelete failed', err)
        const what = image.fileName ?? image.folder?.path
        const error = ipcErrorMessage(err)
        toast(
          what
            ? t('recomp.image.offerFailed', { what, error })
            : t('recomp.image.offerFailedIt', { error }),
          'error'
        )
      })
  }
  return (
    <div className={cx('recomp-file__actions', className)}>
      {options.length > 1 ? (
        <SelectField
          variant="pill"
          label={t('recomp.image.whatToDelete')}
          focusKey={focusKeys.what}
          value={choice}
          options={options}
          onChange={setPicked}
        />
      ) : null}
      <Button focusKey={focusKeys.delete} icon={<Trash2 />} onPress={ask}>
        {options.length > 1
          ? t('recomp.image.deleteMenu')
          : image.fileName
            ? t('recomp.image.deleteImage')
            : t('recomp.image.deleteFolder')}
      </Button>
    </div>
  )
}
