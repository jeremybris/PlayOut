// The programs of a recompilation's folder as rows (the Recompilation page's Program list and the UP button's
// "Which program starts …?" chooser share them).
import type { RecompExecutable } from '@shared/recomp'
import { AppWindow } from 'lucide-react'
import type { ReactElement } from 'react'
import { Chip } from '../../components/Chip'
import { useFocusableControl } from '../../hooks/useFocusableControl'
import { cx } from '../../lib/cx'
import { exeBadges, exeFileName, type ExeBadge } from './recompView'

/**
 * One program of the folder: A makes it the one Play starts. Programs that are probably not the game are dimmed
 * (still pickable). `badges` replaces the usual labels (In use / PlayOut's pick / why it is not the game).
 */
export function ExeRow({
  exe,
  focusKey,
  onChoose,
  badges
}: {
  exe: RecompExecutable
  focusKey: string
  onChoose: () => void
  badges?: ExeBadge[]
}): ReactElement {
  const { ref, props } = useFocusableControl<HTMLDivElement>({ focusKey, onPress: onChoose })
  return (
    <div
      ref={ref}
      className={cx(
        'recomp-version',
        'recomp-exe',
        exe.current && 'recomp-version--selected',
        exe.note && 'recomp-exe--helper'
      )}
      role="option"
      aria-selected={exe.current}
      title={exe.full}
      {...props}
    >
      <AppWindow className="recomp-exe__icon" aria-hidden="true" />
      <div className="recomp-version__text">
        <span className="recomp-version__name">{exeFileName(exe.path)}</span>
        <span className="recomp-exe__path">{exe.path}</span>
      </div>
      <span className="recomp-version__badges">
        {(badges ?? exeBadges(exe)).map((b) => (
          <Chip
            key={b.label}
            accent={b.kind === 'accent'}
            className={cx(b.kind === 'warn' && 'recomp-chip--warn')}
          >
            {b.label}
          </Chip>
        ))}
      </span>
    </div>
  )
}
