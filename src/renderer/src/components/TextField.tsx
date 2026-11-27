import { X } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode
} from 'react'
import { api } from '../api/client'
import { useFocusableControl } from '../hooks/useFocusableControl'
import { useT } from '../i18n'
import type { Direction } from '../input/focus'
import { leaveEditable } from '../input/keyboard'
import { cx } from '../lib/cx'
import { createLog } from '../lib/log'
import { useUiStore } from '../state/ui'
import { OnScreenKeyboard } from './OnScreenKeyboard'

const log = createLog('textfield')

export interface TextFieldProps {
  label?: string
  value: string
  onChange: (value: string) => void
  /** Enter in the input, or Done on the on-screen keyboard. */
  onSubmit?: (value: string) => void
  placeholder?: string
  /** 24u glyph left of the input (e.g. <Search />). */
  icon?: ReactNode
  /** lg = 76u tall with row-title text (search overlay). */
  size?: 'md' | 'lg'
  type?: 'text' | 'password' | 'url' | 'search'
  /** Show an X button that clears the value. */
  clearable?: boolean
  /** Title shown on the on-screen keyboard's preview strip (defaults to label). */
  oskTitle?: string
  focusKey?: string
  /** Arrow press while the field has focus; return false to keep the focus engine from moving. */
  onArrowPress?: (direction: Direction) => boolean
  disabled?: boolean
  /**
   * Several lines (a <textarea> of `rows` lines): Enter starts a new line and Ctrl+Enter submits; Up/Down move
   * between its lines (Escape leaves it).
   */
  multiline?: boolean
  rows?: number
  /** Give the DOM input focus on mount (mouse/keyboard users can type straight away). */
  autoFocus?: boolean
  className?: string
  'aria-label'?: string
  /** Escape typed in the DOM input (input/keyboard.ts then leaves the field as usual). */
  onEscape?: () => void
  /**
   * Extra content on the on-screen keyboard, between its preview and its keys, given the text typed so far (every
   * keystroke) and a close() that shuts the keyboard without Done (the focus goes back to the field).
   */
  oskExtra?: (draft: string, close: () => void) => ReactNode
}

/**
 * Focusable text input. Activating it (A / Enter / click / tap) opens the on-screen keyboard when the
 * gamepad is the input method, shows the Windows touch keyboard on touch (api.showTouchKeyboard) and
 * otherwise focuses the DOM input. While the DOM input has focus, keys belong to it; Escape returns to
 * the focus engine and ArrowUp/ArrowDown leave the field in that direction (input/keyboard.ts). Enter
 * calls onSubmit, or, without one (Search), leaves the field downwards towards the content below.
 */
export function TextField({
  label,
  value,
  onChange,
  onSubmit,
  placeholder,
  icon,
  size = 'md',
  type = 'text',
  clearable,
  oskTitle,
  focusKey,
  onArrowPress,
  disabled,
  multiline,
  rows = 4,
  autoFocus,
  className,
  'aria-label': ariaLabel,
  onEscape,
  oskExtra
}: TextFieldProps): ReactElement {
  const t = useT()
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const [oskOpen, setOskOpen] = useState(false)
  const [draft, setDraft] = useState(value)
  const latest = useRef({ value, onChange, onSubmit, onEscape })
  useEffect(() => {
    latest.current = { value, onChange, onSubmit, onEscape }
  })

  const activate = useCallback(() => {
    if (disabled) return
    const method = useUiStore.getState().inputMethod
    if (method === 'gamepad') {
      setDraft(latest.current.value)
      setOskOpen(true)
      return
    }
    inputRef.current?.focus()
    if (method === 'touch')
      api.showTouchKeyboard().catch((err) => log.warn('showTouchKeyboard failed', err))
  }, [disabled])

  const {
    ref,
    props: controlProps,
    focusSelf,
    focusKey: ownFocusKey
  } = useFocusableControl<HTMLDivElement>({ focusKey, disabled, onPress: activate, onArrowPress })

  useEffect(() => {
    if (autoFocus && !disabled) {
      focusSelf()
      inputRef.current?.focus()
    }
    // on mount only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      latest.current.onChange(event.target.value),
    []
  )
  const onInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.key === 'Escape') {
        latest.current.onEscape?.()
        return
      }
      if (event.key !== 'Enter') return
      // A textarea keeps Enter for its new lines; Ctrl+Enter submits it.
      if (event.currentTarget instanceof HTMLTextAreaElement && !event.ctrlKey) return
      event.preventDefault()
      if (latest.current.onSubmit) {
        latest.current.onSubmit(event.currentTarget.value)
        return
      }
      // No submit handler (Search): Enter behaves like ArrowDown and hands focus to the first result.
      leaveEditable(event.currentTarget, 'down')
    },
    []
  )
  // A click inside the input must not re-run activate() through the wrapper (it would steal nothing, but
  // the touch keyboard call is only wanted once); focusing the engine's node keeps both in sync.
  const onInputClick = useCallback(
    (event: MouseEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      event.stopPropagation()
      focusSelf({ source: useUiStore.getState().inputMethod })
      if (useUiStore.getState().inputMethod === 'touch') {
        api.showTouchKeyboard().catch((err) => log.warn('showTouchKeyboard failed', err))
      }
    },
    [focusSelf]
  )

  const onClear = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    latest.current.onChange('')
    inputRef.current?.focus()
  }, [])

  const closeOsk = useCallback(() => {
    setOskOpen(false)
    focusSelf()
  }, [focusSelf])
  const onOskDone = useCallback(
    (text: string) => {
      latest.current.onChange(text)
      latest.current.onSubmit?.(text)
      closeOsk()
    },
    [closeOsk]
  )

  return (
    <div
      ref={ref}
      className={cx(
        'textfield',
        size === 'lg' && 'textfield--lg',
        multiline && 'textfield--multiline',
        className
      )}
      {...controlProps}
    >
      {label ? <span className="textfield__label">{label}</span> : null}
      <div className="textfield__box">
        {icon ? <span className="textfield__icon">{icon}</span> : null}
        {multiline ? (
          <textarea
            ref={(node) => {
              inputRef.current = node
            }}
            className="textfield__input"
            rows={rows}
            value={value}
            placeholder={placeholder}
            disabled={disabled}
            aria-label={ariaLabel ?? label ?? placeholder}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={onInputChange}
            onKeyDown={onInputKeyDown}
            onClick={onInputClick}
          />
        ) : (
          <input
            ref={(node) => {
              inputRef.current = node
            }}
            className="textfield__input"
            type={type}
            value={value}
            placeholder={placeholder}
            disabled={disabled}
            aria-label={ariaLabel ?? label ?? placeholder}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={onInputChange}
            onKeyDown={onInputKeyDown}
            onClick={onInputClick}
          />
        )}
        {clearable && value.length > 0 ? (
          <button
            type="button"
            className="textfield__clear select__arrow"
            aria-label={t('components.textField.clear')}
            tabIndex={-1}
            onClick={onClear}
          >
            <X />
          </button>
        ) : null}
      </div>
      {oskOpen ? (
        <OnScreenKeyboard
          value={draft}
          onChange={setDraft}
          onDone={onOskDone}
          onCancel={closeOsk}
          title={oskTitle ?? label}
          placeholder={placeholder}
          focusKey={`${ownFocusKey}:osk`}
          extra={oskExtra?.(draft, closeOsk)}
        />
      ) : null}
    </div>
  )
}
