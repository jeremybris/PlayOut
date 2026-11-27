import type { SteamScreenshot } from '@shared/types'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useCallback, useState, type ReactElement } from 'react'
import { IconButton } from '../../components/IconButton'
import { Modal } from '../../components/Modal'
import { useActionHandlers } from '../../hooks/useActionHandlers'
import { useFocusableControl } from '../../hooks/useFocusableControl'
import { useT } from '../../i18n'
import { cx } from '../../lib/cx'
import { stepScreenshot } from '../../lib/screenshots'

const VIEWER_FOCUS = 'detail:shots-viewer'
const IMAGE_FOCUS = `${VIEWER_FOCUS}:image`

export interface ScreenshotViewerProps {
  shots: readonly SteamScreenshot[]
  /** The screenshot shown first. */
  start: number
  onClose: () => void
}

/**
 * A Steam game's store screenshots full size, one at a time, over the game page. Left / right (D-pad, arrow keys,
 * the on-screen arrows) and LB / RB step through them, wrapping round; A on the picture shows the next one; B,
 * Escape, the X or a click beside the picture closes it and focus goes back to the thumbnail it opened from.
 */
export function ScreenshotViewer({ shots, start, onClose }: ScreenshotViewerProps): ReactElement {
  const t = useT()
  const [index, setIndex] = useState(() => stepScreenshot(start, 0, shots.length))
  const step = useCallback(
    (delta: number) => setIndex((i) => stepScreenshot(i, delta, shots.length)),
    [shots.length]
  )
  const shot = shots[index]
  const many = shots.length > 1

  return (
    <Modal
      size="dialog"
      bare
      scrim
      focusKey={VIEWER_FOCUS}
      preferredChildFocusKey={IMAGE_FOCUS}
      onClose={onClose}
      aria-label={t('gameDetail.screenshots.viewer', { number: index + 1, total: shots.length })}
      className="shot-viewer"
    >
      <ViewerActions onStep={step} />
      <div className="shot-viewer__stage">
        {many ? (
          <IconButton
            icon={<ChevronLeft />}
            aria-label={t('gameDetail.screenshots.previous')}
            variant="glass"
            focusKey={`${VIEWER_FOCUS}:prev`}
            className="shot-viewer__arrow"
            onPress={() => step(-1)}
          />
        ) : null}
        {shot ? <ViewerImage shot={shot} many={many} onStep={step} /> : null}
        {many ? (
          <IconButton
            icon={<ChevronRight />}
            aria-label={t('gameDetail.screenshots.next')}
            variant="glass"
            focusKey={`${VIEWER_FOCUS}:next`}
            className="shot-viewer__arrow"
            onPress={() => step(1)}
          />
        ) : null}
      </div>
      <div className="shot-viewer__footer">
        <span className="shot-viewer__count" aria-live="polite">
          {index + 1} / {shots.length}
        </span>
        <IconButton
          icon={<X />}
          aria-label={t('gameDetail.screenshots.close')}
          variant="glass"
          focusKey={`${VIEWER_FOCUS}:close`}
          onPress={onClose}
        />
      </div>
    </Modal>
  )
}

/** LB / RB step from anywhere in the viewer (registered inside the Modal, so on its action layer). */
function ViewerActions({ onStep }: { onStep: (delta: number) => void }): null {
  useActionHandlers({
    lb: () => {
      onStep(-1)
      return true
    },
    rb: () => {
      onStep(1)
      return true
    }
  })
  return null
}

/** The picture: focused first; left / right step instead of moving focus, A shows the next one. */
function ViewerImage({
  shot,
  many,
  onStep
}: {
  shot: SteamScreenshot
  many: boolean
  onStep: (delta: number) => void
}): ReactElement {
  const t = useT()
  const { ref, props, focused } = useFocusableControl<HTMLDivElement>({
    focusKey: IMAGE_FOCUS,
    onPress: () => onStep(1),
    onArrowPress: (direction) => {
      if (!many || (direction !== 'left' && direction !== 'right')) return true
      onStep(direction === 'left' ? -1 : 1)
      return false
    },
    scroll: false
  })
  return (
    <div
      ref={ref}
      {...props}
      className={cx('shot-viewer__frame', focused && 'shot-viewer__frame--focused')}
      role="img"
      aria-label={t('gameDetail.screenshots.image')}
    >
      {/* The thumbnail shows at once (it is already loaded); the full size draws over it when it arrives. */}
      <img
        className="shot-viewer__thumb"
        src={shot.local ?? shot.thumbnail}
        alt=""
        draggable={false}
      />
      <img
        key={shot.full}
        className="shot-viewer__image"
        src={shot.full}
        alt=""
        draggable={false}
      />
    </div>
  )
}
