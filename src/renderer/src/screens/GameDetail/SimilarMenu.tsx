// The Similar menu (the button left of the platform pill, top right of a game's page): the ten games of the library
// most like this one (lib/similarGames.ts), most similar first, each with how similar it is. Worked out once, when
// the button is pressed (the menu mounts then); pressing a game opens its page over this one (Back returns here).
import type { Game } from '@shared/types'
import { useEffect, useState, type MouseEvent, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { Menu, MenuItem } from '../../components/MenuItem'
import { LayerContext, useActionHandlersOnLayer } from '../../hooks/useActionHandlers'
import { useFocusLayer } from '../../hooks/useFocusLayer'
import { useT } from '../../i18n'
import { FocusContext } from '../../input/focus'
import { displayTitle } from '../../lib/library'
import { coverUrl } from '../../lib/media'
import { similarGames, similarPool, type SimilarGame } from '../../lib/similarGames'
import { useLibraryStore } from '../../state/library'
import { useSettingsStore } from '../../state/settings'
import { useStreamingStore } from '../../state/streaming'
import { useUiStore } from '../../state/ui'

const MENU_FOCUS_KEY = 'similarmenu'
/** Gap between the button and the menu below it (design units). */
const MENU_GAP_U = 12

export interface SimilarMenuProps {
  game: Game
  anchor: HTMLElement
  onClose: () => void
}

/** The Similar menu, anchored under the button and right-aligned with it. */
export function SimilarMenu({ game, anchor, onClose }: SimilarMenuProps): ReactElement {
  const t = useT()
  const openModal = useUiStore((s) => s.openModal)
  // Once, when the menu opens: every game of the library is compared with this one.
  const [similar] = useState<SimilarGame[]>(() =>
    similarGames(
      game,
      similarPool(
        useLibraryStore.getState().games,
        useSettingsStore.getState().settings,
        useStreamingStore.getState().remote
      )
    )
  )
  const [position, setPosition] = useState(() => place(anchor))

  const first = similar[0]
  const { ref, layerId } = useFocusLayer<HTMLDivElement>({
    focusKey: MENU_FOCUS_KEY,
    preferredChildFocusKey: first ? `${MENU_FOCUS_KEY}:${first.game.id}` : undefined
  })
  useActionHandlersOnLayer(layerId, {
    back: () => {
      onClose()
      return true
    }
  })

  useEffect(() => {
    const update = (): void => setPosition(place(anchor))
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [anchor])

  const onBackdropClick = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) onClose()
  }

  const open = (other: Game): void => {
    onClose()
    openModal({ type: 'detail', gameId: other.id })
  }

  return createPortal(
    <div className="playmenu-backdrop" onClick={onBackdropClick}>
      <LayerContext.Provider value={layerId}>
        <FocusContext.Provider value={MENU_FOCUS_KEY}>
          <div
            ref={ref}
            className="playmenu similarmenu"
            style={{ right: position.right, top: position.top }}
            role="menu"
            aria-label={t('gameDetail.similar.title')}
            data-focus-key={MENU_FOCUS_KEY}
          >
            <p className="similarmenu__title">{t('gameDetail.similar.title')}</p>
            {similar.length === 0 ? (
              <p className="playmenu__status">{t('gameDetail.similar.none')}</p>
            ) : (
              <Menu aria-label={t('gameDetail.similar.title')} className="similarmenu__list">
                {similar.map(({ game: other, percent }) => {
                  const cover = coverUrl(other)
                  return (
                    <MenuItem
                      key={other.id}
                      focusKey={`${MENU_FOCUS_KEY}:${other.id}`}
                      icon={
                        cover ? (
                          <img
                            className="similarmenu__cover"
                            src={cover}
                            alt=""
                            draggable={false}
                          />
                        ) : (
                          <span className="similarmenu__cover" />
                        )
                      }
                      label={displayTitle(other)}
                      trailing={
                        <span
                          className="similarmenu__percent"
                          aria-label={t('gameDetail.similar.percent', { percent })}
                        >
                          {percent}%
                        </span>
                      }
                      onPress={() => open(other)}
                    />
                  )
                })}
              </Menu>
            )}
          </div>
        </FocusContext.Provider>
      </LayerContext.Provider>
    </div>,
    document.body
  )
}

/** Menu position: right-aligned with the anchor, its top MENU_GAP_U below it. */
function place(anchor: HTMLElement): { right: number; top: number } {
  const rect = anchor.getBoundingClientRect()
  const unit = window.innerHeight / 1080
  return {
    right: Math.round(window.innerWidth - rect.right),
    top: Math.round(rect.bottom + MENU_GAP_U * unit)
  }
}
