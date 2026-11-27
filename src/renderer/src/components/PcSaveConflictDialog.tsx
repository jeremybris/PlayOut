// A game the user added could not start because a PC Saves question is open (main/pc-saves): both sides' saves
// changed since the last copy (Keep this PC's saves / Keep the Emulation folder's copy), the saves are gone from this
// PC, which copied them before (Restore from the Emulation folder / Start fresh), or another PC's copy looks like this
// game's ("Use the copy from <PC>?"). Answered, the game starts.
import type { LaunchError } from '@shared/types'
import type { PcSaveView } from '@shared/pc-saves'
import { useEffect, useState, type ReactElement } from 'react'
import { api } from '../api/client'
import { useT } from '../i18n'
import { displayTitle } from '../lib/library'
import { createLog } from '../lib/log'
import { pcSaveConflictText } from '../lib/pcSaves'
import { useGame } from '../state/library'
import { useUiStore } from '../state/ui'
import { Button } from './Button'
import { Modal } from './Modal'
import { Spinner } from './Spinner'

const log = createLog('pc-saves')

export function PcSaveConflictDialog({
  gameId,
  error,
  onClose
}: {
  gameId: string
  error: LaunchError
  onClose: () => void
}): ReactElement {
  const t = useT()
  const game = useGame(gameId)
  const toast = useUiStore((s) => s.toast)
  const [view, setView] = useState<PcSaveView | null>(null)
  const [busy, setBusy] = useState(false)
  const title = game ? displayTitle(game) : ''

  useEffect(() => {
    let cancelled = false
    api
      .getPcSaves(gameId)
      .then((v) => {
        if (!cancelled) setView(v)
      })
      .catch((err) => log.warn('getPcSaves failed', err))
    return () => {
      cancelled = true
    }
  }, [gameId])

  const answer = (work: () => Promise<PcSaveView>): void => {
    setBusy(true)
    work()
      .then((next) => {
        setView(next)
        if (next.conflict || next.confirm) return
        if (next.error) {
          toast(t('pcSaves.status.error', { error: next.error }), 'error')
          return
        }
        onClose()
        toast(t('pcSaves.toasts.resolvedStarting', { title }))
        // A failure arrives as 'launch:error' again (App shows it).
        void api.launchGame(gameId).catch((err) => log.error('launchGame failed', err))
      })
      .catch((err) => {
        log.error('answering the saves question failed', err)
        toast(t('pcSaves.toasts.failed'), 'error')
      })
      .finally(() => setBusy(false))
  }

  const confirm = view?.confirm ?? null
  const conflict = view?.conflict ?? null
  const heading = confirm
    ? t('pcSaves.confirm.title', { machine: confirm.machine })
    : conflict?.gone
      ? t('pcSaves.conflict.goneTitle', { title })
      : t('pcSaves.conflict.title', { title })
  const message = confirm
    ? t('pcSaves.confirm.text', { machine: confirm.machine, title: confirm.title || title })
    : conflict
      ? pcSaveConflictText(conflict, t)
      : error.message

  return (
    <Modal
      size="dialog"
      narrow
      hideClose
      focusKey="pc-save-conflict"
      preferredChildFocusKey={
        !confirm && conflict?.gone ? 'pc-save-conflict:restore' : 'pc-save-conflict:close'
      }
      title={heading}
      subtitle={title || undefined}
      onClose={onClose}
      footer={
        <>
          <Button focusKey="pc-save-conflict:close" onPress={onClose}>
            {t('components.launchError.close')}
          </Button>
          {busy ? <Spinner size="sm" /> : null}
          {confirm ? (
            <>
              <Button
                focusKey="pc-save-conflict:ignore"
                disabled={busy}
                onPress={() => answer(() => api.answerPcSaveCopy(gameId, false))}
              >
                {t('pcSaves.confirm.ignore')}
              </Button>
              <Button
                focusKey="pc-save-conflict:use"
                variant="primary"
                disabled={busy}
                onPress={() => answer(() => api.answerPcSaveCopy(gameId, true))}
              >
                {t('pcSaves.confirm.use')}
              </Button>
            </>
          ) : conflict?.gone ? (
            // Restore first, as on the game's page and the recompilation's page; 'fresh' is refused by main once the
            // saves came back (the two-sided question shows then).
            <>
              <Button
                focusKey="pc-save-conflict:restore"
                variant="primary"
                disabled={busy}
                onPress={() => answer(() => api.resolvePcSaveConflict(gameId, 'cloud'))}
              >
                {t('pcSaves.conflict.restore')}
              </Button>
              <Button
                focusKey="pc-save-conflict:fresh"
                disabled={busy}
                onPress={() => answer(() => api.resolvePcSaveConflict(gameId, 'fresh'))}
              >
                {t('pcSaves.conflict.startFresh')}
              </Button>
            </>
          ) : conflict ? (
            <>
              <Button
                focusKey="pc-save-conflict:cloud"
                disabled={busy}
                onPress={() => answer(() => api.resolvePcSaveConflict(gameId, 'cloud'))}
              >
                {t('pcSaves.conflict.keepCloud')}
              </Button>
              <Button
                focusKey="pc-save-conflict:local"
                variant="primary"
                disabled={busy}
                onPress={() => answer(() => api.resolvePcSaveConflict(gameId, 'local'))}
              >
                {t('pcSaves.conflict.keepLocal')}
              </Button>
            </>
          ) : null}
        </>
      }
    >
      <p className="dialog__message">{message}</p>
    </Modal>
  )
}
