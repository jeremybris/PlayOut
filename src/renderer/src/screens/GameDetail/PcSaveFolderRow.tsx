// The Edit sheet's "Save folder" row for a PC game the user added (PC Saves, main/pc-saves): the folder (or Not set),
// Choose… / Clear / Copy now, the last copy and any problem, and the two answers when a question is open (keep which
// saves, or use another PC's copy). Changes apply at once through IPC, like the artwork pickers.
import type { PcSaveView } from '@shared/pc-saves'
import type { Game } from '@shared/types'
import { Copy, FolderOpen, X } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { api } from '../../api/client'
import { Button } from '../../components/Button'
import { Spinner } from '../../components/Spinner'
import { useT } from '../../i18n'
import { cx } from '../../lib/cx'
import { formatBytes } from '../../lib/format'
import { displayTitle } from '../../lib/library'
import { createLog } from '../../lib/log'
import { pcSaveConflictText, pcSaveStatus } from '../../lib/pcSaves'
import { useUiStore } from '../../state/ui'

const log = createLog('pc-saves')

const errorText = (err: unknown, fallback: string): string => {
  const raw = err instanceof Error ? err.message : ''
  // IPC rejections arrive as "Error invoking remote method 'playout:…': Error: <message>".
  const message = raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '').trim()
  return message || fallback
}

export function PcSaveFolderRow({
  game,
  focusKey
}: {
  game: Game
  focusKey: (name: string) => string
}): ReactElement | null {
  const t = useT()
  const toast = useUiStore((s) => s.toast)
  const openModal = useUiStore((s) => s.openModal)
  const [view, setView] = useState<PcSaveView | null>(null)
  const [busy, setBusy] = useState(false)
  const title = displayTitle(game)

  const reload = useCallback(() => {
    api
      .getPcSaves(game.id)
      .then(setView)
      .catch((err) => {
        log.error('getPcSaves failed', err)
        toast(t('pcSaves.toasts.readFailed'), 'error')
      })
  }, [game.id, toast, t])

  useEffect(() => {
    reload()
    return api.on('pc-saves:changed', ({ gameId }) => {
      if (gameId === game.id) reload()
    })
  }, [game.id, reload])

  if (!view) return null

  const run = (work: () => Promise<PcSaveView>, done?: string): void => {
    setBusy(true)
    work()
      .then((next) => {
        setView(next)
        if (done && !next.error && !next.conflict && !next.confirm) toast(done, 'success')
      })
      .catch((err) => {
        log.error('pc saves action failed', err)
        toast(errorText(err, t('pcSaves.toasts.failed')), 'error')
      })
      .finally(() => setBusy(false))
  }

  const choose = (): void => {
    setBusy(true)
    api
      .chooseFolder(t('pcSaves.row.chooseTitle', { title }))
      .then(async (path) => {
        if (!path) return
        const check = await api.inspectPcSaveFolder(game.id, path)
        const size = formatBytes(check.bytes)
        const apply = (): void =>
          run(
            () => api.setPcSaveFolder(game.id, check.path),
            t('pcSaves.toasts.chosen', { size, files: check.files })
          )
        if (!check.large) return apply()
        openModal({
          type: 'confirm',
          title: t('pcSaves.large.title', { size }),
          message: t('pcSaves.large.message', { path: check.path, files: check.files, size }),
          confirmLabel: t('pcSaves.large.confirm'),
          onConfirm: apply
        })
      })
      .catch((err) => {
        log.error('choosing the save folder failed', err)
        toast(errorText(err, t('pcSaves.toasts.failed')), 'error')
      })
      .finally(() => setBusy(false))
  }

  const status = pcSaveStatus(view, t, title)
  const set = !!view.folder
  return (
    <div className="gsheet__media gsheet__media--saves">
      <span className="gsheet__media-thumb" aria-hidden="true">
        <FolderOpen />
      </span>
      <div className="gsheet__media-text">
        <span className="gsheet__media-label">{t('pcSaves.row.label')}</span>
        <span className="gsheet__media-desc gsheet__media-desc--path">
          {view.folder ?? t('pcSaves.row.notSet')}
        </span>
        <span className="gsheet__media-desc">{t('pcSaves.row.description')}</span>
        {status ? (
          <span
            className={cx(
              'gsheet__media-desc',
              status.tone === 'warn' && 'gsheet__media-desc--warn'
            )}
          >
            {status.text}
            {view.conflict ? ` ${pcSaveConflictText(view.conflict, t)}` : ''}
          </span>
        ) : null}
        {view.conflict?.gone ? (
          <div className="gsheet__media-actions">
            <Button
              focusKey={focusKey('saves:restore')}
              disabled={busy || view.running}
              onPress={() => run(() => api.resolvePcSaveConflict(game.id, 'cloud'))}
            >
              {t('pcSaves.conflict.restore')}
            </Button>
            <Button
              focusKey={focusKey('saves:startFresh')}
              disabled={busy || view.running}
              onPress={() => run(() => api.resolvePcSaveConflict(game.id, 'fresh'))}
            >
              {t('pcSaves.conflict.startFresh')}
            </Button>
          </div>
        ) : view.conflict ? (
          <div className="gsheet__media-actions">
            <Button
              focusKey={focusKey('saves:keepLocal')}
              disabled={busy || view.running}
              onPress={() => run(() => api.resolvePcSaveConflict(game.id, 'local'))}
            >
              {t('pcSaves.conflict.keepLocal')}
            </Button>
            <Button
              focusKey={focusKey('saves:keepCloud')}
              disabled={busy || view.running}
              onPress={() => run(() => api.resolvePcSaveConflict(game.id, 'cloud'))}
            >
              {t('pcSaves.conflict.keepCloud')}
            </Button>
          </div>
        ) : null}
        {view.confirm ? (
          <div className="gsheet__media-actions">
            <Button
              focusKey={focusKey('saves:useCopy')}
              disabled={busy}
              onPress={() => run(() => api.answerPcSaveCopy(game.id, true))}
            >
              {t('pcSaves.confirm.use')}
            </Button>
            <Button
              focusKey={focusKey('saves:ignoreCopy')}
              variant="ghost"
              disabled={busy}
              onPress={() => run(() => api.answerPcSaveCopy(game.id, false))}
            >
              {t('pcSaves.confirm.ignore')}
            </Button>
          </div>
        ) : null}
      </div>
      <div className="gsheet__media-actions">
        <Button
          focusKey={focusKey('saves:choose')}
          icon={busy ? <Spinner size="sm" /> : <FolderOpen />}
          disabled={busy}
          onPress={choose}
          aria-label={t('pcSaves.row.chooseAria')}
        >
          {t('pcSaves.row.choose')}
        </Button>
        <Button
          focusKey={focusKey('saves:copy')}
          variant="ghost"
          icon={<Copy />}
          disabled={!set || busy || view.running || !view.featureOn}
          onPress={() => run(() => api.syncPcSaves(game.id), t('pcSaves.toasts.copied'))}
          aria-label={t('pcSaves.row.copyNowAria')}
        >
          {t('pcSaves.row.copyNow')}
        </Button>
        <Button
          focusKey={focusKey('saves:clear')}
          variant="ghost"
          icon={<X />}
          disabled={!set || busy}
          onPress={() => run(() => api.setPcSaveFolder(game.id, null), t('pcSaves.toasts.cleared'))}
          aria-label={t('pcSaves.row.clearAria')}
        >
          {t('pcSaves.row.clear')}
        </Button>
      </div>
    </div>
  )
}
