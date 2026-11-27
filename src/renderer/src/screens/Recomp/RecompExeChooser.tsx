import type { RecompExecutables } from '@shared/recomp'
import { FolderOpen } from 'lucide-react'
import { useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../../api/client'
import { Button } from '../../components/Button'
import { Modal } from '../../components/Modal'
import { useT } from '../../i18n'
import { createLog } from '../../lib/log'
import { useUiStore } from '../../state/ui'
import { ExeRow } from './ExeList'
import { exeChoiceBadges, exeChoiceList } from './recompView'

const log = createLog('recomp-exe-chooser')
const KEY = 'recompexe'
const optionKey = (path: string): string => `${KEY}:option:${path}`

export interface RecompExeChooserProps {
  /** The game's title ("Which program starts <title>?"). */
  title: string
  /** The recompilation and its programs, as main's launch returned them ('choose-exe'). */
  executables: RecompExecutables
  /** The program was chosen (saved as the player's choice): start the game. */
  onChosen: () => void
  onClose: () => void
}

/**
 * Asked when UP starts a recompilation whose program is unclear (main: exeUnclear): the programs that could be the
 * game first (PlayOut's best guess first and focused), the others dimmed below (still pickable), Browse… for one
 * elsewhere and Cancel. A pick is saved (setRecompExecutable) and the game starts; later starts do not ask (the
 * Recompilation page's Program section changes it).
 */
export function RecompExeChooser({
  title,
  executables,
  onChosen,
  onClose
}: RecompExeChooserProps): ReactElement {
  const t = useT()
  const toast = useUiStore((s) => s.toast)
  const [busy, setBusy] = useState(false)
  const { best, list } = exeChoiceList(executables)
  const id = executables.id

  const fail =
    (what: string) =>
    (err: unknown): void => {
      log.error(`${what} failed`, err)
      setBusy(false)
      toast(
        t('recomp.exeChooser.useFailed', {
          error: err instanceof Error ? err.message : String(err)
        }),
        'error'
      )
    }
  const choose = (path: string): void => {
    if (busy) return
    setBusy(true)
    api
      .setRecompExecutable(id, path)
      .then(() => onChosen())
      .catch(fail('setRecompExecutable'))
  }
  const browse = (): void => {
    if (busy) return
    setBusy(true)
    api
      .pickRecompExecutable(id)
      .then((next) => {
        setBusy(false)
        // Cancelled in the file picker: nothing was chosen, the chooser stays.
        if (next.source === 'user') onChosen()
      })
      .catch(fail('pickRecompExecutable'))
  }

  return createPortal(
    <Modal
      size="dialog"
      focusKey={KEY}
      preferredChildFocusKey={best ? optionKey(best.path) : `${KEY}:browse`}
      title={t('recomp.exeChooser.title', { title })}
      subtitle={t('recomp.exeChooser.subtitle')}
      onClose={onClose}
      hideClose
      aria-label={t('recomp.exeChooser.title', { title })}
      footer={
        <>
          <Button focusKey={`${KEY}:browse`} icon={<FolderOpen />} onPress={browse}>
            {t('recomp.exeChooser.browse')}
          </Button>
          <Button focusKey={`${KEY}:cancel`} variant="ghost" onPress={onClose}>
            {t('recomp.exeChooser.cancel')}
          </Button>
        </>
      }
    >
      <div
        className="recomp-exes"
        role="listbox"
        aria-label={t('recomp.exeChooser.listLabel', { title })}
      >
        {list.map((c) => (
          <ExeRow
            key={c.path}
            exe={c}
            focusKey={optionKey(c.path)}
            badges={exeChoiceBadges(c, c === best)}
            onChoose={() => choose(c.path)}
          />
        ))}
      </div>
    </Modal>,
    document.body
  )
}
