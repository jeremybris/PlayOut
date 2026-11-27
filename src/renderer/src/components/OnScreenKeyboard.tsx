import { ArrowBigUp, Check, Delete, Space } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import {
  LayerContext,
  useActionHandlers,
  useActionHandlersOnLayer
} from '../hooks/useActionHandlers'
import { useFocusLayer } from '../hooks/useFocusLayer'
import { useFocusableControl } from '../hooks/useFocusableControl'
import { useT } from '../i18n'
import { FocusContext, setFocus, useFocusable } from '../input/focus'
import { cx } from '../lib/cx'

export interface OnScreenKeyboardProps {
  value: string
  /** Every keystroke. */
  onChange: (value: string) => void
  /** Done key / Start / Enter on the preview. */
  onDone: (value: string) => void
  /** B / Escape (floating keyboard only; inline keyboards leave B to their modal). */
  onCancel?: () => void
  /** Label shown in the preview strip ('Search', 'Title'). */
  title?: string
  placeholder?: string
  /**
   * inline = rendered where it is placed, as a plain focus container on the current layer (search overlay);
   * default = floating bottom sheet portaled to <body> with its own focus/action layer (text fields).
   */
  inline?: boolean
  /** Container focus key (default 'osk'); keys are '<focusKey>:<key>'. */
  focusKey?: string
  /** Move focus onto the keyboard on mount (default: true when floating, false when inline). */
  autoFocus?: boolean
  className?: string
  /** Shown between the preview strip and the keys, inside the keyboard's focus layer (e.g. live suggestions). */
  extra?: ReactNode
}

type KeyDef =
  | { kind: 'char'; char: string }
  | { kind: 'shift' }
  | { kind: 'symbols' }
  | { kind: 'space' }
  | { kind: 'backspace' }
  | { kind: 'done' }

const LETTER_ROWS: string[][] = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', "'"],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '-']
]

const SYMBOL_ROWS: string[][] = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['!', '@', '#', '$', '%', '^', '&', '*', '(', ')'],
  ['_', '+', '=', '/', '\\', ':', ';', '"', '[', ']'],
  ['{', '}', '<', '>', '?', '|', '~', '`', ',', '.']
]

function keyId(key: KeyDef): string {
  switch (key.kind) {
    case 'char':
      return `c${key.char.charCodeAt(0)}`
    default:
      return key.kind
  }
}

/** QWERTY grid (digits, three letter rows, shift/symbols/space/backspace/done); every key is focusable. */
export function OnScreenKeyboard(props: OnScreenKeyboardProps): ReactElement {
  if (props.inline) return <InlineKeyboard {...props} />
  return createPortal(<FloatingKeyboard {...props} />, document.body)
}

function FloatingKeyboard(props: OnScreenKeyboardProps): ReactElement {
  const t = useT()
  const focusKey = props.focusKey ?? 'osk'
  const { ref, layerId } = useFocusLayer<HTMLDivElement>({
    focusKey,
    preferredChildFocusKey: `${focusKey}:c${'q'.charCodeAt(0)}`,
    focusOnMount: props.autoFocus !== false
  })
  const board = useKeyboardState(props)
  useActionHandlersOnLayer(layerId, {
    back: () => {
      props.onCancel?.()
    },
    x: board.backspace,
    y: board.space,
    start: board.done
  })
  return (
    <LayerContext.Provider value={layerId}>
      <FocusContext.Provider value={focusKey}>
        <div
          ref={ref}
          className={cx('osk', props.className)}
          role="group"
          aria-label={props.title ?? t('components.keyboard.label')}
        >
          <KeyboardBody
            focusKey={focusKey}
            board={board}
            title={props.title}
            placeholder={props.placeholder}
            value={props.value}
            extra={props.extra}
          />
        </div>
      </FocusContext.Provider>
    </LayerContext.Provider>
  )
}

function InlineKeyboard(props: OnScreenKeyboardProps): ReactElement {
  const t = useT()
  const focusKey = props.focusKey ?? 'osk'
  const { ref } = useFocusable<object, HTMLDivElement>({
    focusKey,
    trackChildren: true,
    saveLastFocusedChild: true,
    // Entering the keyboard from its modal lands on 'q' instead of whichever key measures nearest.
    preferredChildFocusKey: `${focusKey}:c${'q'.charCodeAt(0)}`
  })
  const board = useKeyboardState(props)
  useActionHandlers({ x: board.backspace, y: board.space })
  const autoFocus = props.autoFocus === true
  useEffect(() => {
    if (autoFocus) void setFocus(`${focusKey}:c${'q'.charCodeAt(0)}`)
    // on mount only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <FocusContext.Provider value={focusKey}>
      <div
        ref={ref}
        className={cx('osk', 'osk--inline', props.className)}
        role="group"
        aria-label={props.title ?? t('components.keyboard.label')}
      >
        <KeyboardBody
          focusKey={focusKey}
          board={board}
          title={props.title}
          placeholder={props.placeholder}
          value={props.value}
          extra={props.extra}
        />
      </div>
    </FocusContext.Provider>
  )
}

interface KeyboardState {
  shift: boolean
  symbols: boolean
  rows: KeyDef[][]
  press: (key: KeyDef) => void
  backspace: () => void
  space: () => void
  done: () => void
}

function useKeyboardState({ value, onChange, onDone }: OnScreenKeyboardProps): KeyboardState {
  const [shift, setShift] = useState(false)
  const [symbols, setSymbols] = useState(false)
  const latest = useRef({ value, onChange, onDone })
  useEffect(() => {
    latest.current = { value, onChange, onDone }
  })

  const rows = useMemo<KeyDef[][]>(() => {
    const source = symbols ? SYMBOL_ROWS : LETTER_ROWS
    const [digits, r1, r2, r3] = source as [string[], string[], string[], string[]]
    const chars = (list: string[]): KeyDef[] => list.map((char) => ({ kind: 'char', char }))
    return [
      chars(digits),
      chars(r1),
      chars(r2),
      [{ kind: 'shift' }, ...chars(r3), { kind: 'backspace' }],
      [{ kind: 'symbols' }, { kind: 'space' }, { kind: 'done' }]
    ]
  }, [symbols])

  const backspace = useCallback(() => {
    const current = latest.current.value
    if (current.length > 0) latest.current.onChange(current.slice(0, -1))
  }, [])
  const space = useCallback(() => latest.current.onChange(`${latest.current.value} `), [])
  const done = useCallback(() => latest.current.onDone(latest.current.value), [])

  const press = useCallback(
    (key: KeyDef) => {
      switch (key.kind) {
        case 'char': {
          const char = shift ? key.char.toUpperCase() : key.char
          latest.current.onChange(latest.current.value + char)
          if (shift) setShift(false)
          return
        }
        case 'shift':
          setShift((s) => !s)
          return
        case 'symbols':
          setSymbols((s) => !s)
          return
        case 'space':
          space()
          return
        case 'backspace':
          backspace()
          return
        case 'done':
          done()
      }
    },
    [shift, space, backspace, done]
  )

  return { shift, symbols, rows, press, backspace, space, done }
}

interface KeyboardBodyProps {
  focusKey: string
  board: KeyboardState
  title?: string
  placeholder?: string
  value: string
  extra?: ReactNode
}

function KeyboardBody({
  focusKey,
  board,
  title,
  placeholder,
  value,
  extra
}: KeyboardBodyProps): ReactElement {
  return (
    <>
      <div className="osk__preview" aria-live="polite">
        {title ? <span className="osk__preview-label">{title}</span> : null}
        <span className="osk__preview-text" data-placeholder={placeholder ?? ''}>
          {value}
        </span>
        <span className="osk__caret" aria-hidden="true" />
      </div>
      {extra}
      <div className="osk__rows">
        {board.rows.map((row, index) => (
          <div key={index} className="osk__row">
            {row.map((key) => (
              <Key
                key={keyId(key)}
                focusKey={`${focusKey}:${keyId(key)}`}
                def={key}
                board={board}
              />
            ))}
          </div>
        ))}
      </div>
    </>
  )
}

interface KeyProps {
  focusKey: string
  def: KeyDef
  board: KeyboardState
}

function Key({ focusKey, def, board }: KeyProps): ReactElement {
  const t = useT()
  const { ref, props: controlProps } = useFocusableControl<HTMLButtonElement>({
    focusKey,
    onPress: () => board.press(def)
  })
  let content: ReactNode
  let label: string
  let modifier = ''
  switch (def.kind) {
    case 'char':
      label = board.shift ? def.char.toUpperCase() : def.char
      content = label
      break
    case 'shift':
      label = t('components.keyboard.shift')
      content = <ArrowBigUp fill={board.shift ? 'currentColor' : 'none'} />
      modifier = cx('osk__key--wide', board.shift && 'osk__key--active')
      break
    case 'symbols':
      label = board.symbols ? t('components.keyboard.letters') : t('components.keyboard.symbols')
      content = board.symbols ? 'abc' : '&123'
      modifier = cx('osk__key--wide', board.symbols && 'osk__key--active')
      break
    case 'space':
      label = t('components.keyboard.space')
      content = <Space />
      modifier = 'osk__key--space'
      break
    case 'backspace':
      label = t('components.keyboard.backspace')
      content = <Delete />
      modifier = 'osk__key--wide'
      break
    case 'done':
      label = t('components.keyboard.done')
      content = (
        <>
          <Check />
          <span>{label}</span>
        </>
      )
      modifier = 'osk__key--wide osk__key--accent'
      break
  }
  return (
    <button
      ref={ref}
      type="button"
      className={cx('osk__key', modifier)}
      aria-label={label}
      {...controlProps}
    >
      {content}
    </button>
  )
}
