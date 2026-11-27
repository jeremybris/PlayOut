import { isToolsDifficulty } from '@shared/difficulty'
import type { ReactElement } from 'react'
import { difficultyIcon } from '../lib/difficultyIcons'

/**
 * A Filters > Difficulty level's picture before its name (lib/difficultyIcons.ts), in the box Platform's console
 * pictures use so the rows line up; nothing for a level without one, nor for the N/A (Tools) label (no level).
 */
export function DifficultyIcon({ difficultyId }: { difficultyId: string }): ReactElement | null {
  const url = isToolsDifficulty(difficultyId) ? undefined : difficultyIcon(difficultyId)
  if (!url) return null
  return (
    <span className="console-icon" aria-hidden="true">
      <img className="console-icon__img" src={url} alt="" draggable={false} />
    </span>
  )
}
