import type { ReactElement } from 'react'
import { eraIcon } from '../lib/eraIcons'

/**
 * A Filters > Release era's picture before its name (lib/eraIcons.ts), in the box Platform's console pictures use so
 * the rows line up; nothing for an era without one.
 */
export function EraIcon({ eraId }: { eraId: string }): ReactElement | null {
  const url = eraIcon(eraId)
  if (!url) return null
  return (
    <span className="console-icon" aria-hidden="true">
      <img className="console-icon__img" src={url} alt="" draggable={false} />
    </span>
  )
}
