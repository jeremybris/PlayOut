import type { ReactElement } from 'react'
import { useFocusableControl } from '../../hooks/useFocusableControl'
import { useT } from '../../i18n'
import { cx } from '../../lib/cx'
import { useTabChoiceActive } from './useTabChoiceActive'
import { libraryShowsGame } from '../../state/libraryShown'
import { toggleTabChoice } from '../../state/libraryTabs'

/**
 * The developer or publisher on a game page (the line under the description): pressed, it is added to the filters of
 * the Library's current tab (with the tab's other filters kept: games by any of its developers, and matching the rest)
 * and the Library opens on that tab; pressed again while the tab has it, only that name goes. Filters > Clear filters
 * lists it too.
 */
export function CreatorButton({
  kind,
  name,
  gameId,
  focusKey
}: {
  kind: 'developer' | 'publisher'
  name: string
  gameId: string
  focusKey: string
}): ReactElement {
  const t = useT()
  const active = useTabChoiceActive({ kind, name })
  const { ref, props } = useFocusableControl<HTMLButtonElement>({
    focusKey,
    onPress: () =>
      toggleTabChoice({ kind, name }, gameId, (view) => libraryShowsGame(gameId, view)),
    scroll: false
  })
  return (
    <button
      ref={ref}
      type="button"
      className={cx('gdetail__creator', active && 'gdetail__creator--on')}
      aria-pressed={active}
      title={
        active
          ? t('gameDetail.chips.removeFilter', { name })
          : kind === 'developer'
            ? t('gameDetail.chips.addDeveloper', { name })
            : t('gameDetail.chips.addPublisher', { name })
      }
      {...props}
    >
      {name}
    </button>
  )
}
