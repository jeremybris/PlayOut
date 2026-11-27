import { Eye, EyeOff } from 'lucide-react'
import { useState, type ReactElement } from 'react'
import { IconButton } from '../../components/IconButton'
import { TextField } from '../../components/TextField'
import { useT } from '../../i18n'
import type { Direction } from '../../input/focus'

export interface SecretFieldProps {
  label: string
  /** Persisted value; the field keeps a draft so typing stays responsive while saves are debounced. */
  value: string
  onChange: (value: string) => void
  placeholder?: string
  /** Prefix of the focus keys: '<focusKey>' (field) and '<focusKey>:reveal'. */
  focusKey: string
  /** Plain text (user names, ids) instead of a masked value. */
  plain?: boolean
  /** Arrow press on the field (not the show/hide button); return false to keep focus from moving. */
  onArrowPress?: (direction: Direction) => boolean
}

/** Masked settings text field with a show/hide button. */
export function SecretField({
  label,
  value,
  onChange,
  placeholder,
  focusKey,
  plain,
  onArrowPress
}: SecretFieldProps): ReactElement {
  const t = useT()
  const [draft, setDraft] = useState(value)
  const [adopted, setAdopted] = useState(value)
  const [revealed, setRevealed] = useState(plain === true)
  // Adopt the stored value when it changes underneath us (a failed save rolling back, another screen).
  if (adopted !== value) {
    setAdopted(value)
    setDraft(value)
  }

  return (
    <div className="secret">
      <TextField
        className="secret__field"
        focusKey={focusKey}
        onArrowPress={onArrowPress}
        label={label}
        value={draft}
        placeholder={placeholder ?? t('settings.secret.notSet')}
        type={revealed ? 'text' : 'password'}
        clearable
        oskTitle={label}
        onChange={(next) => {
          setDraft(next)
          onChange(next)
        }}
      />
      {plain ? null : (
        <IconButton
          className="secret__reveal"
          focusKey={`${focusKey}:reveal`}
          icon={revealed ? <EyeOff /> : <Eye />}
          aria-label={
            revealed ? t('settings.secret.hide', { label }) : t('settings.secret.show', { label })
          }
          active={revealed}
          onPress={() => setRevealed((r) => !r)}
        />
      )}
    </div>
  )
}
