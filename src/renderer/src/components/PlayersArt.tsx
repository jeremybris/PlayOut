import { Gamepad2 } from 'lucide-react'
import type { ReactElement } from 'react'

/** A controller with a player count above it ("4", "3-4", "5+"), as the game page's players badge draws it. */
export function PlayersArt({ count }: { count: string }): ReactElement {
  return (
    <span className="players-art" aria-hidden="true">
      <span className="players-art__count">{count}</span>
      <Gamepad2 className="players-art__icon" />
    </span>
  )
}
