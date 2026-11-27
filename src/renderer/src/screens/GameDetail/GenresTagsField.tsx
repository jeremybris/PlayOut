import { Check, ChevronDown, Search } from 'lucide-react'
import {
  useEffect,
  useLayoutEffect,
  useState,
  type MouseEvent,
  type ReactElement,
  type RefObject
} from 'react'
import { createPortal } from 'react-dom'
import { Menu, MenuItem } from '../../components/MenuItem'
import { TextField } from '../../components/TextField'
import { placeSelectMenu } from '../../components/selectMenuPlacement'
import {
  LayerContext,
  useActionHandlers,
  useActionHandlersOnLayer
} from '../../hooks/useActionHandlers'
import { useFocusLayer } from '../../hooks/useFocusLayer'
import { useFocusableControl } from '../../hooks/useFocusableControl'
import { useT } from '../../i18n'
import { FocusContext, setFocus, useFocusable, type Direction } from '../../input/focus'
import { cx } from '../../lib/cx'
import {
  genreTagRows,
  genreTagSuggestions,
  genreTagSummary,
  type GenreTagRow
} from '../../lib/genreTagPicker'
import type { MetadataForm } from '../../lib/metadataForm'

type GenresTags = Pick<MetadataForm, 'genres' | 'tags'>

export interface GenresTagsFieldProps {
  focusKey: string
  /** The form's genres and tags as they stand (unsaved changes included). */
  form: GenresTags
  /** The values the sheet opened with and Reset goes back to (lib/genreTagPicker.ts genreTagRows). */
  bases: readonly GenresTags[]
  /** A row was pressed: the caller toggles it in its form (toggleGenreTag), so quick presses each see the last. */
  onToggle: (row: GenreTagRow) => void
}

/** Gap kept between the dropdown and the window's right edge, in px at 1080p. */
const EDGE_GAP_U = 8

/**
 * The Edit sheet's Genres & Tags field: a row showing what is ticked ("Action, RPG +3") that opens a checklist of the
 * Filters › Genre choices, then the game's genres and tags that are none ("Indie"), after a separator. The list is
 * Filters › Genre's sub-menu again: MenuItem rows with a tick, its own focus and action layer (portaled to <body>, as
 * SelectField's popup, and placed the same way), A / Enter / a click toggles a row and leaves it open, B / Escape / a
 * click outside closes it and focus goes back to the field. Toggles change the form only; Save sends them as the
 * 'genres' / 'tags' edits.
 */
export function GenresTagsField({
  focusKey,
  form,
  bases,
  onToggle
}: GenresTagsFieldProps): ReactElement {
  const t = useT()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const { ref, props: controlProps } = useFocusableControl<HTMLDivElement>({
    focusKey,
    onPress: () => setAnchor(ref.current)
  })
  const summary = genreTagSummary(form)
  return (
    <>
      <div
        ref={ref}
        className="control select gedit__tags"
        role="button"
        aria-haspopup="listbox"
        aria-expanded={anchor !== null}
        aria-label={t('gameDetail.edit.fields.genresTags.summary', { summary })}
        {...controlProps}
      >
        <div className="control__text">
          <span className="control__label">{summary}</span>
        </div>
        <span className="select__chevron" aria-hidden="true">
          <ChevronDown />
        </span>
      </div>
      {anchor ? (
        <GenresTagsMenu
          anchor={anchor}
          focusKey={`${focusKey}:menu`}
          form={form}
          bases={bases}
          onToggle={onToggle}
          onClose={() => setAnchor(null)}
        />
      ) : null}
    </>
  )
}

interface GenresTagsMenuProps extends Omit<GenresTagsFieldProps, 'focusKey'> {
  anchor: HTMLElement
  focusKey: string
  onClose: () => void
}

function GenresTagsMenu({
  anchor,
  focusKey,
  form,
  bases,
  onToggle,
  onClose
}: GenresTagsMenuProps): ReactElement {
  const t = useT()
  const { choices, others } = genreTagRows(form, bases)
  const itemKey = (id: string): string => `${focusKey}:${id}`
  // Opens on the first ticked row (the list is long), else the first.
  const first = [...choices, ...others].find((r) => r.checked) ?? choices[0]
  const { ref, layerId } = useFocusLayer<HTMLDivElement>({
    focusKey,
    preferredChildFocusKey: first ? itemKey(first.id) : undefined
  })
  useActionHandlersOnLayer(layerId, {
    back: () => {
      onClose()
      return true
    }
  })
  // The separator counts as a row for the placement estimate.
  const count = choices.length + others.length + (others.length ? 1 : 0)
  const [position, setPosition] = useState(() => place(anchor, count))
  useEffect(() => {
    const update = (): void => setPosition(place(anchor, count))
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [anchor, count])

  // A click on the backdrop closes; nothing reaches the sheet's own backdrop (React events bubble through portals).
  const onBackdropClick = (event: MouseEvent<HTMLDivElement>): void => {
    event.stopPropagation()
    if (event.target === event.currentTarget) onClose()
  }

  const row = (r: GenreTagRow): ReactElement => (
    <MenuItem
      key={r.id}
      focusKey={itemKey(r.id)}
      label={r.label}
      selected={r.checked}
      trailing={r.checked ? <Check className="select-menu__check" /> : undefined}
      onPress={() => onToggle(r)}
    />
  )

  return createPortal(
    <div className="select-menu-backdrop" onClick={onBackdropClick}>
      <LayerContext.Provider value={layerId}>
        <FocusContext.Provider value={focusKey}>
          <div
            ref={ref}
            className={cx('select-menu', 'gedit-tags-menu', position.above && 'select-menu--above')}
            style={position.style}
            role="listbox"
            aria-label={t('gameDetail.edit.fields.genresTags.label')}
            aria-multiselectable="true"
            data-focus-key={focusKey}
          >
            <Menu>
              {choices.map(row)}
              {others.length ? (
                <>
                  <div className="gedit-tags-menu__sep" role="separator">
                    {t('gameDetail.edit.fields.genresTags.alsoOnGame')}
                  </div>
                  {others.map(row)}
                </>
              ) : null}
            </Menu>
          </div>
        </FocusContext.Provider>
      </LayerContext.Provider>
    </div>,
    document.body
  )
}

/** SelectField's placement, kept inside the window on the right too (the sheet sits at the window's right edge). */
function place(anchor: HTMLElement, count: number): ReturnType<typeof placeSelectMenu> {
  const placed = placeSelectMenu(anchor, count)
  const left = Number(placed.style.left ?? 0)
  const gap = EDGE_GAP_U * (window.innerHeight / 1080)
  return {
    ...placed,
    style: { ...placed.style, maxWidth: Math.max(0, Math.round(window.innerWidth - left - gap)) }
  }
}

export interface GenresTagsSearchProps {
  /** The search's focus container; the box is `${focusKey}:box`, a suggestion `${focusKey}:item:<row id>`. */
  focusKey: string
  form: GenresTags
  bases: readonly GenresTags[]
  /** A suggestion was picked: the very toggle the dropdown's rows call (it is not ticked, so it is added). */
  onAdd: (row: GenreTagRow) => void
}

/**
 * The search box under the Genres & Tags dropdown: typing lists up to 8 of the dropdown's names that hold the text and
 * the game does not have yet (lib/genreTagPicker.ts genreTagSuggestions), in a SelectField-style list anchored to the
 * box (portaled to <body> above the sheet, placed like the dropdown). One pick per search: a click / tap, A on a
 * suggestion, or Enter in the box (the first one) adds it as ticking it in the dropdown would, then the box clears
 * and the list closes. Down from the box goes into the list, up from its first row back to the box, B / Escape
 * closes it (Escape typed in the box too), and Enter with the list closed opens it again instead of picking.
 * With the controller the box opens the on-screen keyboard, which shows the matches above its keys as one types
 * (OskSuggestions; A on one adds it and closes the keyboard); its Done shows the list under the box.
 * The list is no focus layer of its own: its rows sit in this container, so the sheet's other controls stay reachable
 * and the list closes once the focus leaves box and list.
 */
export function GenresTagsSearch({
  focusKey,
  form,
  bases,
  onAdd
}: GenresTagsSearchProps): ReactElement {
  const t = useT()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const boxKey = `${focusKey}:box`
  const itemKey = (id: string): string => `${focusKey}:item:${id}`
  const { ref, hasFocusedChild } = useFocusable<object, HTMLDivElement>({
    focusKey,
    trackChildren: true,
    preferredChildFocusKey: boxKey
  })
  const suggestions = genreTagSuggestions(query, form, bases)
  // Shown while the focus is on the box or a suggestion: it goes away when the focus moves to another control.
  const shown = open && query.trim() !== '' && hasFocusedChild
  const input = (): HTMLInputElement | null => ref.current?.querySelector('input') ?? null

  useActionHandlers(
    {
      back: () => {
        setOpen(false)
        setFocus(boxKey)
        return true
      }
    },
    shown
  )

  const pick = (row: GenreTagRow): void => {
    onAdd(row)
    setQuery('')
    setOpen(false)
    setFocus(boxKey)
  }
  const change = (text: string): void => {
    setQuery(text)
    setOpen(true)
    // Typing in the box while the pointer's hover moved the focus elsewhere: the focus comes back to the box.
    if (!hasFocusedChild) setFocus(boxKey)
  }
  // Enter typed in the box picks the first suggestion. The on-screen keyboard's Done (the box's DOM input is not
  // focused then) only shows the list, so the controller user sees what matched.
  const submit = (text: string): void => {
    const box = input()
    if (!box || document.activeElement !== box) return
    // The list was closed (B / Escape): Enter shows it again rather than adding a match the user cannot see.
    if (!open) {
      setOpen(true)
      return
    }
    const first = genreTagSuggestions(text, form, bases)[0]
    if (first) pick(first)
  }
  const onBoxArrow = (direction: Direction): boolean => {
    const first = suggestions[0]
    if (direction !== 'down' || !shown || !first) return true
    setFocus(itemKey(first.id))
    return false
  }
  const onItemArrow = (index: number, direction: Direction): boolean => {
    if (direction === 'up' && index === 0) {
      setFocus(boxKey)
      return false
    }
    // Sideways and past the last row stay in the list.
    if (direction === 'left' || direction === 'right') return false
    return !(direction === 'down' && index === suggestions.length - 1)
  }

  return (
    <div ref={ref} className="gedit-tags-search">
      <FocusContext.Provider value={focusKey}>
        <TextField
          focusKey={boxKey}
          icon={<Search />}
          aria-label={t('gameDetail.edit.fields.genresTags.search')}
          oskTitle={t('gameDetail.edit.fields.genresTags.search')}
          placeholder={t('gameDetail.edit.fields.genresTags.searchPlaceholder')}
          value={query}
          onChange={change}
          onSubmit={submit}
          onArrowPress={onBoxArrow}
          onEscape={() => setOpen(false)}
          oskExtra={(draft, close) => (
            <OskSuggestions
              focusKey={`${focusKey}:osk`}
              suggestions={genreTagSuggestions(draft, form, bases)}
              hidden={draft.trim() === ''}
              onPick={(row) => {
                onAdd(row)
                setQuery('')
                setOpen(false)
                close()
              }}
            />
          )}
          clearable
        />
        {shown ? (
          <SuggestionList
            anchorRef={ref}
            count={suggestions.length}
            label={t('gameDetail.edit.fields.genresTags.suggestions')}
          >
            {suggestions.length ? (
              <Menu>
                {suggestions.map((row, index) => (
                  <MenuItem
                    key={row.id}
                    focusKey={itemKey(row.id)}
                    label={row.label}
                    onPress={() => pick(row)}
                    onArrowPress={(direction) => onItemArrow(index, direction)}
                  />
                ))}
              </Menu>
            ) : (
              <div className="gedit-tags-search__empty" role="status">
                {t('gameDetail.edit.fields.genresTags.noMatch')}
              </div>
            )}
          </SuggestionList>
        ) : null}
      </FocusContext.Provider>
    </div>
  )
}

/**
 * The matches on the on-screen keyboard, between its preview strip and its keys, updated with every key: a row of
 * key-styled buttons (Up from the digits reaches them). The row keeps its height while empty so the keys stay put.
 */
function OskSuggestions({
  focusKey,
  suggestions,
  hidden,
  onPick
}: {
  focusKey: string
  suggestions: readonly GenreTagRow[]
  hidden: boolean
  onPick: (row: GenreTagRow) => void
}): ReactElement {
  const t = useT()
  return (
    <div
      className="gedit-tags-osk"
      role="listbox"
      aria-label={t('gameDetail.edit.fields.genresTags.suggestions')}
    >
      {hidden ? null : suggestions.length ? (
        suggestions.map((row) => (
          <OskSuggestion
            key={row.id}
            focusKey={`${focusKey}:${row.id}`}
            label={row.label}
            onPress={() => onPick(row)}
          />
        ))
      ) : (
        <div className="gedit-tags-search__empty" role="status">
          {t('gameDetail.edit.fields.genresTags.noMatch')}
        </div>
      )}
    </div>
  )
}

function OskSuggestion({
  focusKey,
  label,
  onPress
}: {
  focusKey: string
  label: string
  onPress: () => void
}): ReactElement {
  const { ref, props } = useFocusableControl<HTMLButtonElement>({ focusKey, onPress })
  return (
    <button
      ref={ref}
      type="button"
      role="option"
      aria-selected="false"
      className="osk__key gedit-tags-osk__item"
      {...props}
    >
      {label}
    </button>
  )
}

/** The suggestions' popup: the dropdown's look and placement, kept in place while the sheet scrolls. */
function SuggestionList({
  anchorRef,
  count,
  label,
  children
}: {
  anchorRef: RefObject<HTMLElement | null>
  count: number
  label: string
  children: ReactElement
}): ReactElement | null {
  // Placed before the first paint (a layout effect), and again as the window resizes or the sheet scrolls.
  const [position, setPosition] = useState<ReturnType<typeof place> | null>(null)
  useLayoutEffect(() => {
    const update = (): void => {
      const anchor = anchorRef.current
      if (anchor) setPosition(place(anchor, Math.max(1, count)))
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [anchorRef, count])
  if (!position) return null
  return createPortal(
    <div className="gedit-tags-search__layer">
      <div
        className={cx(
          'select-menu',
          'gedit-tags-search__list',
          position.above && 'select-menu--above'
        )}
        style={position.style}
        role="listbox"
        aria-label={label}
      >
        {children}
      </div>
    </div>,
    document.body
  )
}
