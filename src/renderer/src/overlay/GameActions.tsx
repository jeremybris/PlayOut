import { ArrowLeft, Home, Square } from 'lucide-react'
import { useCallback, type ReactElement } from 'react'
import { api } from '../api/client'
import { Button } from '../components/Button'
import { useT } from '../i18n'
import { createLog } from '../lib/log'
import { displayTitle } from '../lib/library'
import { useLibraryStore } from '../state/library'
import { useSystemStore } from '../state/system'
import { useUiStore } from '../state/ui'
import { useOverlayStore } from './overlayStore'
import { closeOverlay } from './shared'

const log = createLog('overlay-actions')

/** "Back to game", "PlayOut" and, while a PlayOut game runs, "Quit game" (asks first). */
export function GameActions({ focusKey }: { focusKey: string }): ReactElement {
  const running = useSystemStore((s) => s.running)
  const overGame = useOverlayStore((s) => !!s.gameId || !!s.program)
  const game = useLibraryStore((s) => (running ? s.byId.get(running.gameId) : undefined))
  const openModal = useUiStore((s) => s.openModal)
  const toast = useUiStore((s) => s.toast)
  const t = useT()

  const showPlayOut = useCallback(() => {
    api.showPlayOut().catch((err) => {
      log.error('showPlayOut failed', err)
      toast(t('overlay.game.openPlayOutFailed'), 'error')
    })
  }, [t, toast])

  const quit = useCallback(() => {
    // The game's own title when PlayOut knows it, else "the game" (whole sentences either way).
    const title = game ? displayTitle(game) : null
    const failed = (): void => {
      toast(
        title ? t('overlay.game.closeFailed', { title }) : t('overlay.game.closeFailedUnknown'),
        'error'
      )
    }
    openModal({
      type: 'confirm',
      title: t('overlay.game.quitTitle'),
      message: title
        ? t('overlay.game.quitMessage', { title })
        : t('overlay.game.quitMessageUnknown'),
      confirmLabel: t('overlay.game.quitConfirm'),
      danger: true,
      onConfirm: () => {
        api
          .quitRunningGame()
          .then((ok) => {
            if (!ok) failed()
          })
          .catch((err) => {
            log.error('quitRunningGame failed', err)
            failed()
          })
      }
    })
  }, [game, openModal, t, toast])

  return (
    <div className="ov-actions">
      <Button
        focusKey={`${focusKey}:back`}
        variant="primary"
        icon={<ArrowLeft />}
        onPress={closeOverlay}
      >
        {running || overGame ? t('overlay.game.back') : t('overlay.game.close')}
      </Button>
      <Button focusKey={`${focusKey}:playout`} icon={<Home />} onPress={showPlayOut}>
        PlayOut
      </Button>
      {running ? (
        <Button focusKey={`${focusKey}:quit`} variant="danger" icon={<Square />} onPress={quit}>
          {t('overlay.game.quit')}
        </Button>
      ) : null}
    </div>
  )
}
