import type { EmulatorStatus, LaunchError } from '@shared/types'
import { Download, RefreshCw, Settings as SettingsIcon } from 'lucide-react'
import { useEffect, useState, type ReactElement } from 'react'
import { api } from '../api/client'
import { useT, type Translate } from '../i18n'
import { displayTitle } from '../lib/library'
import { createLog } from '../lib/log'
import { useGame } from '../state/library'
import { useUiStore } from '../state/ui'
import { Button } from './Button'
import { Modal } from './Modal'

const log = createLog('launch-error')

export interface LaunchErrorDialogProps {
  gameId: string
  error: LaunchError
  onClose: () => void
}

/** The dialog's title for each kind of launch error (a function of t, so it follows the language). */
function kindTitle(kind: LaunchError['kind'], t: Translate): string {
  switch (kind) {
    case 'emulator-missing':
      return t('components.launchError.title.emulatorMissing')
    case 'core-missing':
      return t('components.launchError.title.coreMissing')
    case 'client-missing':
      return t('components.launchError.title.clientMissing')
    case 'file-missing':
      return t('components.launchError.title.fileMissing')
    case 'failed':
      return t('components.launchError.title.failed')
    case 'save-conflict':
      return t('components.launchError.title.saveConflict')
  }
}

/**
 * Shown on 'launch:error'. Besides Close it offers the fix that matches the error: Settings → Emulators
 * (plus the emulator's download link when the main process knows one), Settings → Library for a missing
 * store client, or a rescan of the game's source for missing files.
 */
export function LaunchErrorDialog({
  gameId,
  error,
  onClose
}: LaunchErrorDialogProps): ReactElement {
  const t = useT()
  const game = useGame(gameId)
  const openModal = useUiStore((s) => s.openModal)
  const toast = useUiStore((s) => s.toast)
  const [emulator, setEmulator] = useState<EmulatorStatus | null>(null)

  const wantsEmulator = error.kind === 'emulator-missing' || error.kind === 'core-missing'
  useEffect(() => {
    if (!wantsEmulator || !error.emulatorId) return undefined
    let cancelled = false
    api
      .getEmulators()
      .then((list) => {
        if (cancelled) return
        const match =
          list.find((e) => e.id.toLowerCase() === error.emulatorId!.toLowerCase()) ?? null
        setEmulator(match)
      })
      .catch((err) => log.warn('getEmulators failed', err))
    return () => {
      cancelled = true
    }
  }, [wantsEmulator, error.emulatorId])

  const openSettings = (section: string): void => {
    onClose()
    openModal({ type: 'settings', section })
  }
  const download = (): void => {
    if (!emulator?.downloadUrl) return
    api.openExternal(emulator.downloadUrl).catch((err) => {
      log.error('openExternal failed', err)
      toast(t('components.launchError.downloadPageFailed'), 'error')
    })
  }
  const rescan = (): void => {
    if (!game) return
    onClose()
    toast(t('components.launchError.rescanning', { source: game.source }))
    api.scanSources([game.source]).catch((err) => {
      log.error('scanSources failed', err)
      toast(t('components.launchError.rescanFailed'), 'error')
    })
  }

  const details: string[] = []
  if (error.emulatorId)
    details.push(t('components.launchError.emulator', { name: emulator?.name ?? error.emulatorId }))
  if (error.coreFile) details.push(t('components.launchError.core', { file: error.coreFile }))
  if (emulator && emulator.searchedPaths.length > 0)
    details.push(t('components.launchError.searched', { paths: emulator.searchedPaths.join(', ') }))

  return (
    <Modal
      size="dialog"
      narrow
      hideClose
      focusKey="launch-error"
      preferredChildFocusKey="launch-error:close"
      title={kindTitle(error.kind, t)}
      subtitle={
        game
          ? t('components.launchError.subtitle', { title: displayTitle(game) })
          : t('components.launchError.subtitleUnknown')
      }
      onClose={onClose}
      footer={
        <>
          <Button focusKey="launch-error:close" onPress={onClose}>
            {t('components.launchError.close')}
          </Button>
          {wantsEmulator && emulator?.downloadUrl ? (
            <Button focusKey="launch-error:download" icon={<Download />} onPress={download}>
              {t('components.launchError.download', { name: emulator.name })}
            </Button>
          ) : null}
          {wantsEmulator ? (
            <Button
              focusKey="launch-error:settings"
              variant="primary"
              icon={<SettingsIcon />}
              onPress={() => openSettings('emulators')}
            >
              {t('components.launchError.emulatorSettings')}
            </Button>
          ) : null}
          {error.kind === 'client-missing' ? (
            <Button
              focusKey="launch-error:settings"
              variant="primary"
              icon={<SettingsIcon />}
              onPress={() => openSettings('library')}
            >
              {t('components.launchError.librarySettings')}
            </Button>
          ) : null}
          {error.kind === 'file-missing' && game ? (
            <Button
              focusKey="launch-error:rescan"
              variant="primary"
              icon={<RefreshCw />}
              onPress={rescan}
            >
              {t('components.launchError.rescan')}
            </Button>
          ) : null}
        </>
      }
    >
      <p className="dialog__message">{error.message}</p>
      {details.length > 0 ? <div className="dialog__detail">{details.join('\n')}</div> : null}
    </Modal>
  )
}
