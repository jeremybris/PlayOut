import { useId, type ReactElement } from 'react'
import { reviewGold, STAR, starClipTop, starFill } from '../lib/bandIcon'

/**
 * A Filters > Reviews band's star before its name: band `step` of `steps` (1 = lowest). The outline is always drawn,
 * faint like SizePie's ring so the fill stands apart from it; the inside fills from the bottom up, one equal share per
 * band of the inside the outline leaves showing, so 95-100 is full and 0-40 keeps a visible sliver at its feet
 * (bandIcon.ts starFill, starClipTop). Every star is the same size, drawn in the text colour like Size's pies and
 * H.L.T.B.'s stopwatches, in the box Platform's console pictures use so the rows line up. The fill's clip has an id
 * of its own (useId), so the stars of one menu never share one.
 */
export function ReviewStarIcon({
  step,
  steps,
  gold = false
}: {
  step: number
  steps: number
  /** In gold, brighter for better bands (Filters > Reviews); else the text colour (the Sort menu's icon). */
  gold?: boolean
}): ReactElement {
  const fill = starFill(step, steps)
  const top = starClipTop(step, steps)
  const clipId = `review-star-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  return (
    <span className="console-icon" aria-hidden="true">
      <svg
        className="review-star"
        viewBox="0 0 24 24"
        data-fill={fill.toFixed(3)}
        style={gold ? { color: reviewGold(step, steps) } : undefined}
      >
        <defs>
          <clipPath id={clipId}>
            <rect x="0" y={top.toFixed(2)} width="24" height={(24 - top).toFixed(2)} />
          </clipPath>
        </defs>
        <path d={STAR} fill="currentColor" clipPath={`url(#${clipId})`} />
        <path
          d={STAR}
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.45"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  )
}
