import type { ReactElement } from 'react'
import { bandFill, bandIconSize, sizeColor, slicePath } from '../lib/bandIcon'

/**
 * A Filters > Size band's pie before its name: band `step` of `steps` (1 = smallest). The slice starts at the top and
 * fills clockwise one eighth per band, so the largest band is almost full (7/8), and the whole pie grows with the band.
 * Drawn in the box Platform's console pictures use so the rows line up.
 */
export function SizePie({
  step,
  steps,
  colored = false
}: {
  step: number
  steps: number
  /** Blue (smallest) to yellow to red (largest), for Filters > Size; else the text colour (the Sort menu's icon). */
  colored?: boolean
}): ReactElement {
  const fill = bandFill(step, steps)
  const size = bandIconSize(step, steps)
  return (
    <span className="console-icon" aria-hidden="true">
      <svg
        className="size-pie"
        viewBox="0 0 24 24"
        style={{ width: size, height: size, ...(colored ? { color: sizeColor(step, steps) } : {}) }}
        data-fill={fill.toFixed(3)}
      >
        <circle
          cx="12"
          cy="12"
          r="10.5"
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.45"
          strokeWidth="1.5"
        />
        <path d={slicePath(12, 12, 10, fill)} fill="currentColor" />
      </svg>
    </span>
  )
}
