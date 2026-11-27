import {
  CUSTOM_FILTER_ICONS,
  filterNameProblem,
  MAX_CUSTOM_FILTER_NAME,
  type CustomFilterIcon
} from '@shared/custom-filters'
import { Check, Plus } from 'lucide-react'
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Button } from '../../components/Button'
import { Modal } from '../../components/Modal'
import { TextField } from '../../components/TextField'
import { useFocusableControl } from '../../hooks/useFocusableControl'
import { useT } from '../../i18n'
import { cx } from '../../lib/cx'
import { CUSTOM_FILTER_ICON_COMPONENTS } from '../../lib/customFilterIcons'
import { CUSTOM_FILTER_COLORS } from '../../lib/filterColors'
import { displayTitle } from '../../lib/library'
import {
  createCustomFilter,
  editCustomFilter,
  nameProblemText,
  useCustomFilters
} from '../../state/customFilters'
import { useLibraryStore } from '../../state/library'
import { useStreamingStore } from '../../state/streaming'
import { findGame } from '../../lib/streaming'
import './customFilter.css'

const KEY = 'custom-filter'
const key = (part: string): string => `${KEY}:${part}`
/** An icon's tile in the picker. */
const iconKey = (icon: string): string => key(`icon:${icon}`)

export interface CustomFilterDialogProps {
  /** Create a filter with this game in it (its options menu). */
  gameId?: string
  /** Rename this filter / change its icon (Filters > Custom). */
  filterId?: string
  /** Where focus starts: the name (default) or the icon picker. */
  focus?: 'name' | 'icon'
  onClose: () => void
}

/**
 * Create a filter (a game's options menu) or edit one (Filters > Custom's Rename / Change icon): a name (the on-screen
 * keyboard with a controller; trimmed, at most MAX_CUSTOM_FILTER_NAME characters, not another filter's) and an icon
 * from the curated grid, each in its colour. Create stays off until both are chosen; the filter is saved with the game
 * in it and a toast confirms.
 */
export function CustomFilterDialog({
  gameId,
  filterId,
  focus = 'name',
  onClose
}: CustomFilterDialogProps): ReactElement {
  const t = useT()
  const filters = useCustomFilters()
  const editing = filterId ? filters.find((f) => f.id === filterId) : undefined
  const byId = useLibraryStore((s) => s.byId)
  // A paired host's game (Streaming) is not in the library store.
  const remote = useStreamingStore((s) => s.remote)
  const game = gameId ? findGame(gameId, byId, remote) : undefined
  const [name, setName] = useState(editing?.name ?? '')
  const [icon, setIcon] = useState<string | null>(editing?.icon ?? null)
  const [busy, setBusy] = useState(false)
  // The filter went away while its dialog was open (deleted elsewhere): nothing left to edit.
  const gone = !!filterId && !editing
  useEffect(() => {
    if (gone) onClose()
  }, [gone, onClose])
  // While it is being saved the name is not checked again: the settings store holds the new filter before the save
  // resolves, and its own name would read as taken.
  const problem = busy ? null : filterNameProblem(name, filters, filterId)
  const ready = !problem && icon !== null && !busy
  // Set at once (state is not): a double click, or Enter and a click together, saves once.
  const submitting = useRef(false)
  // The name's problem is said once something was typed (an empty name only keeps Create off).
  const shownProblem = problem && problem !== 'empty' ? nameProblemText(problem) : null
  const mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
    },
    []
  )

  const submit = (): void => {
    if (!ready || icon === null || submitting.current) return
    submitting.current = true
    setBusy(true)
    const done = editing
      ? editCustomFilter(editing.id, { name, icon })
      : createCustomFilter(name, icon, gameId).then((made) => made !== null)
    void done.then((ok) => {
      if (ok) onClose()
      else {
        submitting.current = false
        if (mounted.current) setBusy(false)
      }
    })
  }

  const title = editing ? t('customFilter.editTitle') : t('customFilter.createTitle')
  const subtitle = editing
    ? editing.name
    : game
      ? t('customFilter.createSubtitle', { title: displayTitle(game) })
      : undefined
  const preferred = focus === 'icon' && icon ? iconKey(icon) : key('name')

  return (
    <Modal
      size="dialog"
      focusKey={KEY}
      preferredChildFocusKey={preferred}
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      aria-label={title}
      className="custom-filter-dialog"
      footer={
        <>
          <Button focusKey={key('cancel')} variant="ghost" onPress={onClose}>
            {t('customFilter.cancel')}
          </Button>
          <Button
            focusKey={key('ok')}
            variant="primary"
            icon={editing ? <Check /> : <Plus />}
            disabled={!ready}
            onPress={submit}
          >
            {editing ? t('customFilter.save') : t('customFilter.create')}
          </Button>
        </>
      }
    >
      <div className="custom-filter">
        <TextField
          focusKey={key('name')}
          label={t('customFilter.name')}
          placeholder={t('customFilter.namePlaceholder')}
          oskTitle={t('customFilter.nameOsk')}
          value={name}
          onChange={(value) => setName(limitName(value))}
          onSubmit={(value) => setName(limitName(value))}
        />
        <p
          className={cx('custom-filter__note', shownProblem && 'custom-filter__note--problem')}
          role={shownProblem ? 'alert' : undefined}
        >
          {shownProblem ??
            t('customFilter.nameHint', { count: name.length, max: MAX_CUSTOM_FILTER_NAME })}
        </p>
        <div className="custom-filter__label" id={key('icons-label')}>
          {t('customFilter.icon')}
        </div>
        <div
          className="custom-filter__icons"
          role="radiogroup"
          aria-labelledby={key('icons-label')}
        >
          {CUSTOM_FILTER_ICONS.map((id) => (
            <IconTile key={id} icon={id} selected={icon === id} onPick={() => setIcon(id)} />
          ))}
        </div>
      </div>
    </Modal>
  )
}

/**
 * A name as typed, within the limit: leading spaces dropped first (they would use up characters the name never keeps),
 * so the counter, which shows this length, and the limit agree.
 */
function limitName(value: string): string {
  return value.trimStart().slice(0, MAX_CUSTOM_FILTER_NAME)
}

/** One icon of the picker, in its colour; picked: a ring and a tick. */
function IconTile({
  icon,
  selected,
  onPick
}: {
  icon: CustomFilterIcon
  selected: boolean
  onPick: () => void
}): ReactElement {
  const t = useT()
  const Icon = CUSTOM_FILTER_ICON_COMPONENTS[icon]
  const { ref, props } = useFocusableControl<HTMLButtonElement>({
    focusKey: iconKey(icon),
    onPress: onPick
  })
  const label = t(`customFilter.icons.${icon}`)
  return (
    <button
      ref={ref}
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      title={label}
      className={cx('custom-filter__icon', selected && 'custom-filter__icon--selected')}
      data-icon={icon}
      {...props}
    >
      <Icon style={{ color: CUSTOM_FILTER_COLORS[icon] }} aria-hidden="true" />
      {selected ? <Check className="custom-filter__tick" aria-hidden="true" /> : null}
    </button>
  )
}
