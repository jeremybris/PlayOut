import { useState, type ReactElement } from 'react'
import { useT } from '../i18n'
import { Button } from './Button'
import { Modal } from './Modal'
import { Toggle } from './Toggle'

export interface ConfirmDialogProps {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  /** Red confirm button and Cancel focused first. */
  danger?: boolean
  /** A switch under the message (e.g. "Also delete its updates and DLC"); its state is passed to onConfirm. */
  option?: { label: string; description?: string; checked: boolean }
  onConfirm: (optionChecked: boolean) => void
  /** Cancel / B / Escape, and after confirming. */
  onClose: () => void
}

/** Narrow yes/no dialog. Focus starts on Confirm, or on Cancel for dangerous actions. */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger,
  option,
  onConfirm,
  onClose
}: ConfirmDialogProps): ReactElement {
  const t = useT()
  const [checked, setChecked] = useState(option?.checked ?? false)
  const confirm = (): void => {
    onConfirm(checked)
    onClose()
  }
  return (
    <Modal
      size="dialog"
      narrow
      hideClose
      className="confirm-dialog"
      focusKey="confirm"
      preferredChildFocusKey={danger ? 'confirm:cancel' : 'confirm:ok'}
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button focusKey="confirm:cancel" onPress={onClose}>
            {cancelLabel ?? t('components.confirmDialog.cancel')}
          </Button>
          <Button focusKey="confirm:ok" variant={danger ? 'danger' : 'primary'} onPress={confirm}>
            {confirmLabel ?? t('components.confirmDialog.confirm')}
          </Button>
        </>
      }
    >
      <p className="dialog__message">{message}</p>
      {option ? (
        <Toggle
          focusKey="confirm:option"
          label={option.label}
          description={option.description}
          checked={checked}
          onChange={setChecked}
        />
      ) : null}
    </Modal>
  )
}
