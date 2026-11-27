import { ChevronDown } from 'lucide-react'
import type { ReactElement } from 'react'

export interface ScrollHintProps {
  visible: boolean
}

/** Centred bobbing chevron at the bottom edge: more rows exist below the focused one (design 2.6). */
export function ScrollHint({ visible }: ScrollHintProps): ReactElement | null {
  if (!visible) return null
  return (
    <div className="scroll-chevron" aria-hidden="true">
      <ChevronDown strokeWidth={2} />
    </div>
  )
}
