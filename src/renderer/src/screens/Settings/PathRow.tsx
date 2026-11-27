import { FolderOpen, FolderPlus, X } from 'lucide-react'
import type { ReactElement, ReactNode } from 'react'
import { Button } from '../../components/Button'
import { Spinner } from '../../components/Spinner'
import { useT } from '../../i18n'
import { cx } from '../../lib/cx'
import { shortPath } from './common'

export interface PathRowProps {
  label: string
  description?: string
  /** 24u glyph left of the label. */
  icon?: ReactNode
  /** Current path; null/empty shows `placeholder`. */
  value: string | null | undefined
  /** Text shown when no path is set ('Not set', 'Auto-detect'). */
  placeholder: string
  chooseLabel?: string
  clearLabel?: string
  onChoose: () => void
  /** Shows a Generate button left of Choose (creates the folder instead of picking an existing one). */
  onGenerate?: () => void
  /** Generate is running: its button shows a spinner and is disabled. */
  generating?: boolean
  /** Omit to hide the Clear button. */
  onClear?: () => void
  /** Whether Clear can be pressed; default: while a path is set. */
  clearEnabled?: boolean
  /** Prefix of the two buttons' focus keys: '<base>:choose' / '<base>:clear'. */
  focusKey: string
  disabled?: boolean
  /** Extra actions right of Clear (e.g. a Download link). */
  extra?: ReactNode
  className?: string
}

/** Settings row showing a folder/file path with Choose and Clear buttons. */
export function PathRow({
  label,
  description,
  icon,
  value,
  placeholder,
  chooseLabel,
  clearLabel,
  onChoose,
  onGenerate,
  generating,
  onClear,
  clearEnabled,
  focusKey,
  disabled,
  extra,
  className
}: PathRowProps): ReactElement {
  const t = useT()
  const hasValue = typeof value === 'string' && value.length > 0
  return (
    <div className={cx('settings-row', className)}>
      {icon ? <span className="control__icon">{icon}</span> : null}
      <div className="settings-row__text">
        <span className="settings-row__label">{label}</span>
        <span
          className={cx('settings-row__value', !hasValue && 'settings-row__value--empty')}
          title={hasValue ? value : undefined}
        >
          {hasValue ? shortPath(value) : placeholder}
        </span>
        {description ? <span className="settings-row__desc">{description}</span> : null}
      </div>
      <div className="settings-row__actions">
        {onGenerate ? (
          <Button
            focusKey={`${focusKey}:generate`}
            icon={generating ? <Spinner size="sm" /> : <FolderPlus />}
            onPress={onGenerate}
            disabled={disabled || generating}
          >
            {t('settings.path.generate')}
          </Button>
        ) : null}
        <Button
          focusKey={`${focusKey}:choose`}
          icon={<FolderOpen />}
          onPress={onChoose}
          disabled={disabled}
        >
          {chooseLabel ?? t('settings.path.choose')}
        </Button>
        {onClear ? (
          <Button
            focusKey={`${focusKey}:clear`}
            variant="ghost"
            icon={<X />}
            onPress={onClear}
            disabled={disabled || !(clearEnabled ?? hasValue)}
          >
            {clearLabel ?? t('settings.path.clear')}
          </Button>
        ) : null}
        {extra}
      </div>
    </div>
  )
}
