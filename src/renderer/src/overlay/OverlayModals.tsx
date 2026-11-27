import type { ReactElement } from 'react'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { useUiStore } from '../state/ui'

/**
 * The overlay's modal host: only confirmations open here (Quit game, the power menu). App's ModalHost is not used:
 * it brings every screen of the main window with it.
 */
export function OverlayModals(): ReactElement | null {
  const modals = useUiStore((s) => s.modals)
  const closeModal = useUiStore((s) => s.closeModal)
  const top = modals[modals.length - 1]
  if (!top || top.type !== 'confirm') return null
  return (
    <ConfirmDialog
      key={top.id}
      title={top.title}
      message={top.message}
      confirmLabel={top.confirmLabel}
      danger={top.danger}
      onConfirm={top.onConfirm}
      onClose={() => closeModal(top.id)}
    />
  )
}
