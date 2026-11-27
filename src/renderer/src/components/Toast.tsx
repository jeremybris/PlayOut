import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react'
import { useEffect, type ReactElement } from 'react'
import { cx } from '../lib/cx'
import { useUiStore, type Toast as ToastData } from '../state/ui'

export interface ToastProps {
  toast: ToastData
  /** Remove the toast with the given id (ToastHost passes the store action, which is referentially stable). */
  onDismiss: (id: number) => void
}

/**
 * One toast pill; dismisses itself at toast.createdAt + toast.durationMs or on click. The deadline is
 * computed from the toast's own timestamp, so a re-run of the effect (another toast arriving or leaving,
 * StrictMode's double mount) never extends its time on screen.
 */
export function Toast({ toast, onDismiss }: ToastProps): ReactElement {
  useEffect(() => {
    const remaining = Math.max(0, toast.createdAt + toast.durationMs - Date.now())
    const timer = setTimeout(() => onDismiss(toast.id), remaining)
    return () => clearTimeout(timer)
  }, [toast.id, toast.createdAt, toast.durationMs, onDismiss])
  const Icon =
    toast.kind === 'success'
      ? CircleCheck
      : toast.kind === 'error'
        ? CircleAlert
        : toast.kind === 'warning'
          ? TriangleAlert
          : Info
  return (
    <div
      className={cx('toast', `toast--${toast.kind}`)}
      role="status"
      onClick={() => onDismiss(toast.id)}
    >
      <span className="toast__icon">
        <Icon />
      </span>
      <span>{toast.text}</span>
    </div>
  )
}

/** Renders the ui store's toasts bottom-centre. Mount once in App. */
export function ToastHost(): ReactElement | null {
  const toasts = useUiStore((s) => s.toasts)
  const dismissToast = useUiStore((s) => s.dismissToast)
  if (toasts.length === 0) return null
  return (
    <div className="toast-host" aria-live="polite">
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onDismiss={dismissToast} />
      ))}
    </div>
  )
}
