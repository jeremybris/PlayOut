import { X } from 'lucide-react'
import {
  useCallback,
  useEffect,
  type AnimationEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode
} from 'react'
import { useModalClosing } from '../hooks/modalClosing'
import { LayerContext, useActionHandlersOnLayer } from '../hooks/useActionHandlers'
import { useFocusLayer } from '../hooks/useFocusLayer'
import { useT } from '../i18n'
import { FocusContext } from '../input/focus'
import { cx } from '../lib/cx'
import { IconButton } from './IconButton'

export type ModalSize = 'panel' | 'sheet' | 'dialog'

export interface ModalProps {
  /**
   * panel = the big detail panel (1680x960u, 24u corners, no scrim);
   * dialog = centred popup (880x640u max; `narrow` = 640u wide) over a scrim;
   * sheet = right-side glass sheet (560u wide, full height).
   */
  size?: ModalSize
  /** Dialog only: 640u wide instead of 880u (confirmations, launch errors). */
  narrow?: boolean
  /** Focus key of the modal container; focus keys of children are conventionally prefixed with it ('settings:...'). */
  focusKey: string
  /** Child to focus first instead of the top-left one. */
  preferredChildFocusKey?: string
  /** Called on B / Escape / backdrop click / the close button. */
  onClose: () => void
  /** Header title (omitted = no header; the body then fills the modal). */
  title?: string
  subtitle?: string
  /** Extra header content right of the title (e.g. a store pill), before the close button. */
  headerActions?: ReactNode
  /** Hide the X button (dialogs with explicit buttons). */
  hideClose?: boolean
  /** Footer content (usually buttons, right-aligned). */
  footer?: ReactNode
  /**
   * Render children directly inside the modal frame without header/body/footer wrappers: the detail panel
   * draws its own art, gradients and action bar. `title`, `footer` and `hideClose` are ignored when bare.
   */
  bare?: boolean
  /** Dim the page behind the modal (default: true for dialog and sheet, false for panel). */
  scrim?: boolean
  /** Close when the backdrop is clicked/tapped (default true). */
  closeOnBackdrop?: boolean
  'aria-label'?: string
  className?: string
  bodyClassName?: string
  children?: ReactNode
}

/**
 * Backdrop + panel. Isolates focus to its children (Norigin focus boundary through useFocusLayer), pushes
 * an action layer so only this modal receives back/x/y/... while it is on top, focuses its first (or
 * preferred) focusable on mount and restores the previous focus on unmount. B / Escape call onClose.
 *
 * Inside, register per-modal buttons with useActionHandlers(); they land on this modal's layer.
 * Focus keys for children: `${focusKey}:...` (not enforced, just the convention screens follow).
 *
 * Closing: App's ModalHost keeps a closed modal mounted and marks it closing (ModalClosingContext); the
 * modal releases its focus/action layer at once (focus returns to the opener, the layer below gets the
 * buttons again; directions and A are frozen by the host until the exit ends), plays its exit animation
 * (backdrop fade, panel scale-down) with pointer events off and reports animationend, after which the
 * host unmounts it.
 */
export function Modal({
  size = 'dialog',
  narrow,
  focusKey,
  preferredChildFocusKey,
  onClose,
  title,
  subtitle,
  headerActions,
  hideClose,
  footer,
  bare,
  scrim,
  closeOnBackdrop = true,
  'aria-label': ariaLabel,
  className,
  bodyClassName,
  children
}: ModalProps): ReactElement {
  const t = useT()
  const { closing, onClosed } = useModalClosing()
  // Closing releases the focus/action layer at once (the layer below is interactive and focus returns to
  // the opener while the exit animation plays); ModalHost unmounts the DOM when the animation ends.
  const { ref, layerId } = useFocusLayer<HTMLDivElement>({
    focusKey,
    preferredChildFocusKey,
    closing
  })
  useActionHandlersOnLayer(layerId, { back: () => onClose() }, !closing)

  const onBackdropClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (closeOnBackdrop && event.target === event.currentTarget) onClose()
    },
    [closeOnBackdrop, onClose]
  )

  // The exit animation ended (or never ran: animations off, reduced motion): let the host unmount us.
  const onAnimationEnd = useCallback(
    (event: AnimationEvent<HTMLDivElement>) => {
      if (closing && event.target === event.currentTarget) onClosed()
    },
    [closing, onClosed]
  )
  useEffect(() => {
    if (!closing) return
    const el = ref.current
    const duration = el ? parseFloat(getComputedStyle(el).animationDuration) : 0
    if (!(duration > 0)) onClosed()
  }, [closing, onClosed, ref])

  const dim = scrim ?? size !== 'panel'
  const showHeader = !bare && (title !== undefined || headerActions !== undefined || !hideClose)

  return (
    <div
      className={cx(
        'modal-backdrop',
        dim && 'modal-backdrop--scrim',
        size === 'sheet' && 'modal-backdrop--sheet',
        closing && 'modal-backdrop--closing'
      )}
      onClick={closing ? undefined : onBackdropClick}
    >
      <LayerContext.Provider value={layerId}>
        <FocusContext.Provider value={focusKey}>
          <div
            ref={ref}
            className={cx(
              'modal',
              `modal--${size}`,
              narrow && 'modal--narrow',
              closing && 'modal--closing',
              className
            )}
            role="dialog"
            aria-modal="true"
            aria-label={ariaLabel ?? title}
            data-focus-key={focusKey}
            onAnimationEnd={onAnimationEnd}
          >
            {bare ? (
              children
            ) : (
              <>
                {showHeader ? (
                  <div className="modal__header">
                    <div className="u-grow">
                      {title !== undefined ? <div className="modal__title">{title}</div> : null}
                      {subtitle ? <div className="modal__subtitle">{subtitle}</div> : null}
                    </div>
                    {headerActions}
                    {!hideClose ? (
                      <IconButton
                        icon={<X />}
                        aria-label={t('components.modal.close')}
                        variant="glass"
                        focusKey={`${focusKey}:close`}
                        onPress={onClose}
                      />
                    ) : null}
                  </div>
                ) : null}
                <div className={cx('modal__body', bodyClassName)}>{children}</div>
                {footer ? <div className="modal__footer">{footer}</div> : null}
              </>
            )}
          </div>
        </FocusContext.Provider>
      </LayerContext.Provider>
    </div>
  )
}
